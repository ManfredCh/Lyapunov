"""层级 TRS 到碰撞几何的**完整仿射消费**：真 MuJoCo 下的角点/世界位置/落体/通道核对。

受测对象：`packages/sim-mujoco/python/worker.py` 的原生编译路径（`World(scene, options)`，与产品
worker 进程同一段代码）。解释器用带真 mujoco 的（`LYAPUNOV_MUJOCO_PYTHON`，缺省仓内
`.runtime/sim-python/bin/python`）；`LYAPUNOV_MUJOCO_TEST_WORKER` 可指向另一份 worker.py，
`LYAPUNOV_MUJOCO_COMPARISON_WORKER` 可再指一份做旧口径对照。

背景（93 实测，原文见 93 REPORT §3）：父层非均匀缩放 × 子层 90° 换轴时 Scene→MuJoCo 尺寸差
0.223607 m、任意角度剪切差 0.25 m。层级 TRS 完全能表达这两个位形——丢信息的是消费方把父子 scale
逐轴相乘（那只是 `A = A_parent·R(q)·diag(s)` 的对角特例）而不是组合完整线性映射。本文件按

    M = M_parent·T(t)·R(q)·S(s)，  A = A_parent·R(q)·S(s)，  D = R(q_world)ᵀ·A

独立算出声明几何（center/halfExtents/parts）在世界里的像，再与真 MuJoCo 编译产物的世界读数比对。
真值不调用 worker 的任何层级数学：这里的四元数矩阵与位姿组合是**另写一份**（与 85 的
`mirrored-collision.test.ts` 同一口径），两个来源对不上就说明有一侧错了。

夹具：
  · 93 的真实层级夹具（identity / 非均匀父 + 90° 子 / 非均匀父 + 35° 子 / 动态子 / 镜像偏心），
    数值逐字取自 93 的 `test_world_collision_frame.py`；
  · 本任务新增的受控位形（通道落体、球/柱/胶囊与 sdf 的覆盖边界、mesh 部件烘顶点）；
  · 85 的镜像正例（偏心盒、带符号 mesh.scale），确认 85 的行为逐位保留。
"""
from __future__ import annotations

import copy
import importlib.util
import json
import math
import os
import sys
import tempfile
from pathlib import Path

import mujoco
import numpy as np

HERE = Path(__file__).resolve().parent
WORKER = Path(os.environ.get("LYAPUNOV_MUJOCO_TEST_WORKER") or (HERE.parent / "python" / "worker.py"))
# 判定容差：导出侧单精度四元数（90° 的 qz=0.7071067690849304）带来的相对非对角项 ~3.4e-08，
# 真剪切在 2× 各向异性下 ≥1e-01，两者差 6 个数量级，1e-6 分得开。
TOLERANCE = 1e-6


def load_worker(path: Path):
    """按文件路径导入 worker（生产里它被当脚本从自己目录起，这里补上同目录兄弟模块的路径）。"""
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("lyapunov_sim_worker_" + path.parent.parent.name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── 断言收集：每条都打印真实读数，退出码只在失败时为非零 ─────────────────────────
class Checks:
    def __init__(self, title: str):
        self.title = title
        self.rows: list[tuple[str, bool, str]] = []
        self.readings: dict[str, object] = {}

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append((name, bool(ok), detail))
        print(f'[{"PASS" if ok else "FAIL"}] {name}' + (f" — {detail}" if detail else ""), flush=True)
        return bool(ok)

    def finish(self) -> int:
        failed = [row for row in self.rows if not row[1]]
        payload = {"total": len(self.rows), "failed": len(failed),
                   "rows": [{"name": n, "ok": o, "detail": d} for n, o, d in self.rows], "readings": self.readings}
        print("\n" + self.title + f": {len(self.rows) - len(failed)}/{len(self.rows)} 通过", flush=True)
        print("CHECK_RESULT=" + json.dumps(payload, ensure_ascii=False), flush=True)
        return 1 if failed else 0


# ── 独立真值：TRS 链（xyzw 四元数）→ 世界线性映射 A、世界位置 p、世界朝向 q ──────────
def quaternion_matrix(quaternion) -> np.ndarray:
    x, y, z, w = np.asarray(quaternion, dtype=float) / np.linalg.norm(quaternion)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def world_frame(entities, eid):
    """实体数据帧 → 世界的 (A, p)：A = A_parent·R(q)·diag(s)，p = p_parent + A_parent·t。"""
    entity = next(item for item in entities if item["entityId"] == eid)
    transform = entity["transform"]
    linear = quaternion_matrix(transform["quaternion"]) @ np.diag(np.asarray(transform.get("scale", [1, 1, 1]), dtype=float))
    position = np.asarray(transform["position"], dtype=float)
    if not entity.get("parentId"):
        return linear, position
    parent_linear, parent_position = world_frame(entities, entity["parentId"])
    return parent_linear @ linear, parent_position + parent_linear @ position


def world_quaternion(entities, eid):
    """世界朝向的 xyzw 四元数（父链四元数之积），与 worker 的 world_poses 同口径但另写一份。"""
    entity = next(item for item in entities if item["entityId"] == eid)
    x, y, z, w = np.asarray(entity["transform"]["quaternion"], dtype=float) / np.linalg.norm(entity["transform"]["quaternion"])
    if not entity.get("parentId"):
        return np.array([x, y, z, w])
    px, py, pz, pw = world_quaternion(entities, entity["parentId"])
    return np.array([pw * x + px * w + py * z - pz * y,
                     pw * y - px * z + py * w + pz * x,
                     pw * z + px * y - py * x + pz * w,
                     pw * w - px * x - py * y - pz * z])


def data_to_body(entities, eid):
    """D = R(q_world)ᵀ·A：数据帧 → 本实体 body 帧（声明几何落进 geom 帧要经的线性映射）。"""
    linear, _ = world_frame(entities, eid)
    return quaternion_matrix(world_quaternion(entities, eid)).T @ linear


def box_corners(center, half) -> np.ndarray:
    center = np.asarray(center, dtype=float)
    half = np.asarray(half, dtype=float)
    return np.asarray([center + half * np.array([sx, sy, sz]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])


def truth_points(entities, eid, points) -> np.ndarray:
    """数据帧点集在世界里的像（独立真值）。"""
    linear, position = world_frame(entities, eid)
    return (linear @ np.asarray(points, dtype=float).T).T + position


def truth_corners(entities, eid, center, half) -> np.ndarray:
    return truth_points(entities, eid, box_corners(center, half))


# ── 场景构造 ──────────────────────────────────────────────────────────────────
def scene(scene_id: str, entities: list) -> dict:
    return {"sceneId": scene_id, "revision": 1,
            "coordinates": {"units": "m", "upAxis": "Z", "handedness": "right", "quaternion": "xyzw"},
            "entities": entities}


def entity(eid, *, position=(0, 0, 0), quaternion=(0, 0, 0, 1), scale=(1, 1, 1), parent=None, collision=None, dynamic=False, name=None):
    value = {"entityId": eid, "name": name or eid,
             "transform": {"position": list(position), "quaternion": list(quaternion), "scale": list(scale)}}
    components = {}
    if collision is not None:
        components["collision"] = collision
    if dynamic:
        components["rigidBody"] = {"type": "dynamic", "massKg": 1}
    if components:
        value["components"] = components
    if parent:
        value["parentId"] = parent
    return value


def box(half, center=(0, 0, 0)) -> dict:
    return {"shape": "box", "halfExtents": list(half), "center": list(center)}


def rot_z(degrees: float):
    """绕 Z 的 xyzw 四元数（与 Blender/Scene 出口同口径）。"""
    return [0.0, 0.0, math.sin(math.radians(degrees) / 2), math.cos(math.radians(degrees) / 2)]


def compile_scene(worker, snapshot):
    world = worker.World(snapshot, {"worldId": "collision-affine-frames", "clock": "manual"})
    mujoco.mj_forward(world.model, world.data)
    return world


def geoms_of(world, eid):
    """本实体的 geom（按实体前缀归属，不猜名字）。"""
    prefix = world.entities[eid]["prefix"]
    rows = []
    for geom_id in range(world.model.ngeom):
        geom = world.model.geom(geom_id)
        if not (geom.name or "").startswith(prefix):
            continue
        rows.append({"geomId": geom_id, "name": geom.name,
                     "type": int(np.asarray(geom.type).ravel()[0]),
                     "center": np.asarray(world.data.geom_xpos[geom_id], dtype=float),
                     "rotation": np.asarray(world.data.geom_xmat[geom_id], dtype=float).reshape(3, 3),
                     "size": np.asarray(geom.size, dtype=float)})
    return rows


def geom_points(world, row) -> np.ndarray:
    """geom 在世界里的点集：box 取 8 角点，mesh 取编译后的（凸包）顶点。"""
    position, rotation = row["center"], row["rotation"]
    if row["type"] == int(mujoco.mjtGeom.mjGEOM_BOX):
        return (rotation @ box_corners([0, 0, 0], row["size"]).T).T + position
    if row["type"] == int(mujoco.mjtGeom.mjGEOM_MESH):
        mesh_id = int(np.asarray(world.model.geom_dataid[row["geomId"]]).ravel()[0])
        start, count = int(world.model.mesh_vertadr[mesh_id]), int(world.model.mesh_vertnum[mesh_id])
        vertices = np.asarray(world.model.mesh_vert, dtype=float).reshape(-1, 3)[start:start + count]
        scale = np.asarray(world.model.mesh_scale[mesh_id], dtype=float)
        return (rotation @ (vertices * scale).T).T + position
    return position.reshape(1, 3)


def hausdorff(one, two) -> float:
    one, two = np.asarray(one, dtype=float), np.asarray(two, dtype=float)
    if len(one) == 0 or len(two) == 0:
        return float("inf")
    forward = np.linalg.norm(one[:, None, :] - two[None, :, :], axis=2).min(axis=1).max()
    backward = np.linalg.norm(two[:, None, :] - one[None, :, :], axis=2).min(axis=1).max()
    return float(max(forward, backward))


def box_deviation(world, entities, eid, center, half) -> tuple[float, list]:
    """本实体全部 geom 的世界点集 与 声明盒真值角点 的最大偏差（Hausdorff，双向）。"""
    truth = truth_corners(entities, eid, center, half)
    rows = geoms_of(world, eid)
    return max((hausdorff(truth, geom_points(world, row)) for row in rows), default=float("inf")), rows


def body_position(world, eid) -> np.ndarray:
    body_id = mujoco.mj_name2id(world.model, mujoco.mjtObj.mjOBJ_BODY, world.entities[eid]["prefix"] + "body")
    return np.asarray(world.data.xpos[body_id], dtype=float)


def simulate(world, steps=1500):
    for _ in range(steps):
        mujoco.mj_step(world.model, world.data)
    return world


def geom_type_name(value: int) -> str:
    return {int(mujoco.mjtGeom.mjGEOM_BOX): "box", int(mujoco.mjtGeom.mjGEOM_MESH): "mesh",
            int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere", int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
            int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule", int(mujoco.mjtGeom.mjGEOM_ELLIPSOID): "ellipsoid"}.get(value, str(value))


# ── 夹具 ──────────────────────────────────────────────────────────────────────
def fixture_93() -> dict:
    """93 的真实层级夹具（数值逐字照搬 test_world_collision_frame.py）。"""
    scaled = entity("scaled_parent", position=(0, 3, 0), scale=(2, 1, 0.5))
    # 镜像父级：Blender decompose 给出 180°(X) 与全负缩放，两者的乘积是 x 轴镜像。
    mirror = entity("mirror_parent", position=(3, 3, 0), quaternion=(1, 0, 0, 0), scale=(-1, -1, -1))
    centered = entity("centered_box", position=(1.5, 0.5, 0.3), collision=box((0.3, 0.2, 0.1)))
    child_scaled = entity("child_in_scaled_parent", position=(0.5, 0, 0.2), parent="scaled_parent",
                          collision=box((0.25, 0.2, 0.25), (0.25, 0, 0.25)))
    child_mirror = entity("child_in_mirror_parent", position=(1.0, 0, 0), parent="mirror_parent",
                          collision=box((0.2, 0.3, 0.1), (0.1, 0.2, 0.1)))
    sheared = entity("child_rotated_in_scaled_parent", position=(-0.6, 0, 0.1), quaternion=rot_z(35), parent="scaled_parent",
                     collision=box((0.2, 0.2, 0.4), (0.2, 0, 0.4)))
    turned = entity("child_turned_90_in_scaled_parent", position=(-0.5, 0.7, 2.4), quaternion=rot_z(90), parent="scaled_parent",
                    collision=box((0.2, 0.1, 0.05)))
    # 动态子体：93 的导出把它的世界位姿提升到 worldbody（含父链缩放），这里保持同形。
    dynamic = entity("dynamic_in_scaled_parent", position=(1.4, 2.7, 0.8), scale=(2, 1, 0.5), dynamic=True,
                     collision=box((0.1, 0.1, 0.1)))
    pad = entity("dynamic_pad", position=(1.4, 2.7, 0), collision=box((0.5, 0.5, 0.05), (0, 0, 0.05)))
    return scene("collision-affine-93", [scaled, mirror, centered, child_scaled, child_mirror, sheared, turned, dynamic, pad])


FIXTURE_93_BOXES = {
    "centered_box": ((0, 0, 0), "box"),
    "child_in_scaled_parent": ((0.25, 0, 0.25), "box"),
    "child_in_mirror_parent": ((0.1, 0.2, 0.1), "box"),
    "child_rotated_in_scaled_parent": ((0.2, 0, 0.4), "mesh"),
    "child_turned_90_in_scaled_parent": ((0, 0, 0), "box"),
}


def fixture_passage() -> dict:
    """通道语义：非均匀父级 (2,1,0.5) 下的 35° 斜板（局部薄轴 = Z，半厚 0.01）。

    精确像是一块斜的平行四边形板；把父子 scale 逐轴相乘的旧口径给的是**轴对齐** 0.8×0.4 的板。
    球从精确板面之外的开口落下时，旧口径会把那里封死。
    """
    parent = entity("scaled_parent", scale=(2, 1, 0.5))
    plate = entity("plate", position=(0, 0, 0.3), quaternion=rot_z(35), parent="scaled_parent",
                   collision=box((0.2, 0.2, 0.01)))
    return scene("collision-affine-passage", [parent, plate])


PASSAGE_BALL = (0.35, 0.1)     # 落在旧口径轴对齐板内（|x|<0.4、|y|<0.2）、精确斜板之外
PASSAGE_RADIUS = 0.03


L_SHAPE_VERTICES = [(0, 0, 0), (0.4, 0, 0), (0.4, 0.2, 0), (0.2, 0.2, 0), (0.2, 0.6, 0), (0, 0.6, 0),
                    (0, 0, 0.3), (0.4, 0, 0.3), (0.4, 0.2, 0.3), (0.2, 0.2, 0.3), (0.2, 0.6, 0.3), (0, 0.6, 0.3)]
ASYMMETRIC_VERTICES = [(0, -0.2, 0), (0.4, -0.2, 0), (0.4, 0.2, 0), (0, 0.2, 0),
                       (0, -0.2, 0.4), (0.4, -0.2, 0.4), (0.4, 0.2, 0.4), (0, 0.2, 0.4)]


def write_obj(path: Path, vertices) -> Path:
    """只写 `v` 行（MuJoCo 对 mesh geom 按顶点凸包碰撞，面不参与）。"""
    path.write_text("\n".join("v %r %r %r" % tuple(vertex) for vertex in vertices) + "\n")
    return path


def main() -> int:
    checks = Checks("层级仿射变换的碰撞消费（真实 MuJoCo）")
    worker = load_worker(WORKER)
    print(f"worker={WORKER} mujoco={mujoco.__version__} numpy={np.__version__}", flush=True)

    # ── 1. 93 夹具：世界角点逐个落在真值上 ────────────────────────────────────
    snapshot = fixture_93()
    entities = snapshot["entities"]
    world = compile_scene(worker, snapshot)
    worst = 0.0
    for eid, (center, expected) in FIXTURE_93_BOXES.items():
        half = next(item for item in entities if item["entityId"] == eid)["components"]["collision"]["halfExtents"]
        deviation, rows = box_deviation(world, entities, eid, center, half)
        worst = max(worst, deviation)
        kinds = "/".join(geom_type_name(row["type"]) for row in rows)
        checks.check(f"93 夹具 {eid}：世界角点与真值一致（geom {kinds}）",
                     deviation < TOLERANCE and rows and geom_type_name(rows[0]["type"]) == expected,
                     f"最大偏差={deviation:.3e} m，geom 类型={kinds}（期望 {expected}）")
    checks.readings["fixture93WorstDeviationM"] = worst
    checks.check("93 夹具整体：世界角点最大偏差在 1e-6 m 内（90° 换轴与 35° 剪切都在内）",
                 worst < TOLERANCE, "最大偏差=%.3e m" % worst)

    turned = geoms_of(world, "child_turned_90_in_scaled_parent")
    turned_size = (turned[0]["size"] * 2.0).tolist() if turned else []
    checks.check("90° 换轴保持原生 box：世界尺寸 [0.4, 0.4, 0.05]（旧口径给 [0.2, 0.8, 0.05]，角点差 0.223607 m）",
                 len(turned) == 1 and turned[0]["type"] == int(mujoco.mjtGeom.mjGEOM_BOX)
                 and np.allclose(turned_size, [0.4, 0.4, 0.05], atol=1e-6),
                 f"类型={geom_type_name(turned[0]['type']) if turned else None} 世界尺寸={[round(v, 6) for v in turned_size]}")

    sheared = geoms_of(world, "child_rotated_in_scaled_parent")
    sheared_points = geom_points(world, sheared[0]) if sheared else np.zeros((0, 3))
    checks.check("35° 剪切用 8 角点凸网格（最小精确表达，不是放大的轴对齐盒）",
                 len(sheared) == 1 and sheared[0]["type"] == int(mujoco.mjtGeom.mjGEOM_MESH) and len(sheared_points) == 8,
                 f"类型={geom_type_name(sheared[0]['type']) if sheared else None} 顶点数={len(sheared_points)} "
                 f"世界尺寸={[round(v, 6) for v in (sheared_points.max(axis=0) - sheared_points.min(axis=0)).tolist()] if len(sheared_points) else []}")

    # ── 2. 旧口径对照（可选，经 LYAPUNOV_MUJOCO_COMPARISON_WORKER 指定另一份 worker）────
    comparison = os.environ.get("LYAPUNOV_MUJOCO_COMPARISON_WORKER")
    if comparison and Path(comparison).is_file():
        legacy_worker = load_worker(Path(comparison))
        try:
            legacy_world = compile_scene(legacy_worker, snapshot)
            legacy_turned = geoms_of(legacy_world, "child_turned_90_in_scaled_parent")
            legacy_deviation, _ = box_deviation(legacy_world, entities, "child_turned_90_in_scaled_parent", (0, 0, 0), (0.2, 0.1, 0.05))
            legacy_sheared, _ = box_deviation(legacy_world, entities, "child_rotated_in_scaled_parent", (0.2, 0, 0.4), (0.2, 0.2, 0.4))
            checks.readings["comparisonWorker"] = {"turned90DeviationM": legacy_deviation, "sheared35DeviationM": legacy_sheared}
            checks.check("对照（旧口径 worker）：同一 Scene 下 90° 换轴的角点确实偏离真值 0.223607 m",
                         abs(legacy_deviation - 0.22360679774997896) < 1e-5,
                         f"旧口径世界尺寸={[round(v, 6) for v in (legacy_turned[0]['size'] * 2).tolist()] if legacy_turned else []}，角点偏差={legacy_deviation:.6f} m")
            checks.check("对照（旧口径 worker）：同一 Scene 下 35° 剪切的角点确实偏离真值 0.25 m 量级",
                         legacy_sheared > 0.2,
                         f"角点偏差={legacy_sheared:.6f} m（修后=0）")
        except Exception as exc:
            checks.check("对照（旧口径 worker）：同一 Scene 编译", False, f"{type(exc).__name__}: {exc}")

    # ── 3. 落体：动态子体 + 90° 换轴的板 ──────────────────────────────────────
    dropped = compile_scene(worker, snapshot)
    pad = geoms_of(dropped, "dynamic_pad")[0]
    pad_top = float(pad["center"][2] + pad["size"][2])
    dynamic_half = float(geoms_of(dropped, "dynamic_in_scaled_parent")[0]["size"][2])
    simulate(dropped)
    rest_z = float(body_position(dropped, "dynamic_in_scaled_parent")[2])
    checks.check("动态子体落体：静止中心 z = 台面顶 + 盒半高（父链缩放只算一次）",
                 abs(rest_z - (pad_top + dynamic_half)) < 5e-3,
                 f"台面顶={pad_top:.6f} 盒半高={dynamic_half:.6f} 静止 z={rest_z:.6f} 期望={pad_top + dynamic_half:.6f}")

    probes = [entity("probe_on", position=(-0.9, 3.7, 2.0), collision=box((0.05, 0.05, 0.05)), dynamic=True),
              entity("probe_off", position=(-1.35, 3.7, 2.0), collision=box((0.05, 0.05, 0.05)), dynamic=True)]
    probe_world = simulate(compile_scene(worker, scene("collision-affine-turned", [*snapshot["entities"], *probes])))
    plate_top = float(turned[0]["center"][2] + turned[0]["size"][2])
    on_z = float(body_position(probe_world, "probe_on")[2])
    off_z = float(body_position(probe_world, "probe_off")[2])
    checks.check("90° 换轴的板：真值范围内（x=-0.9）的探针停在板顶",
                 abs(on_z - (plate_top + 0.05)) < 5e-3,
                 f"板顶={plate_top:.6f} 探针静止 z={on_z:.6f} 期望={plate_top + 0.05:.6f}")
    checks.check("90° 换轴的板：真值范围外、旧口径仍然覆盖的 x=-1.35 处探针落到地面（板不再虚胖到 x=-1.4）",
                 off_z < 0.2,
                 f"探针静止 z={off_z:.6f}（旧口径会停在 {plate_top + 0.05:.6f} 的板上）")

    # ── 4. 通道语义：球从斜板之外的开口落下 ───────────────────────────────────
    ball = entity("ball", position=[PASSAGE_BALL[0], PASSAGE_BALL[1], 1.2], dynamic=True,
                  collision={"shape": "sphere", "halfExtents": [PASSAGE_RADIUS] * 3})
    exact_scene = scene("collision-affine-passage-exact", [*fixture_passage()["entities"], ball])
    exact_world = simulate(compile_scene(worker, exact_scene))
    plate_z = float(geoms_of(exact_world, "plate")[0]["center"][2])
    exact_rest = float(body_position(exact_world, "ball")[2])
    checks.check("通道语义（精确表达）：球在斜板之外的开口落下，穿过板落到地面",
                 exact_rest < plate_z - 0.1,
                 f"板心 z={plate_z:.6f} 球静止 z={exact_rest:.6f}（穿过板应≈球半径 {PASSAGE_RADIUS}）")

    legacy_scene = copy.deepcopy(exact_scene)
    legacy_scene["sceneId"] = "collision-affine-passage-legacy"
    # 旧口径（逐轴乘父子 scale）对盒忽略子层旋转：同一 Scene 去掉 plate 的四元数就是它的产物。
    for item in legacy_scene["entities"]:
        if item["entityId"] == "plate":
            item["transform"]["quaternion"] = [0, 0, 0, 1]
    legacy_rest = float(body_position(simulate(compile_scene(worker, legacy_scene)), "ball")[2])
    checks.check("通道语义（旧口径对照）：同一开口在轴对齐厚板下被封死，球停在板上",
                 legacy_rest > plate_z,
                 f"旧口径球静止 z={legacy_rest:.6f} > 板心 z={plate_z:.6f}；修后同位置={exact_rest:.6f}")

    # ── 5. 镜像正例（85）─────────────────────────────────────────────────────
    directory = Path(tempfile.mkdtemp(prefix="collision-affine-"))
    mirror_scene = scene("collision-affine-mirror", [
        entity("mirrored", scale=(-1, 1, 1), collision=box((0.5, 0.3, 0.2), (0.9, 0, 0.25))),
        entity("mirrored_hull", scale=(-1, 1, 1), collision={"shape": "mesh", "parts": [write_obj(directory / "asym.obj", ASYMMETRIC_VERTICES).as_uri()]}),
    ])
    mirror_world = compile_scene(worker, mirror_scene)
    deviation, rows = box_deviation(mirror_world, mirror_scene["entities"], "mirrored", (0.9, 0, 0.25), (0.5, 0.3, 0.2))
    checks.check("镜像正例（85）：偏心盒的中心落在镜像一侧、尺寸仍为正量",
                 deviation < TOLERANCE and np.all(rows[0]["size"] > 0),
                 f"角点偏差={deviation:.3e} m 世界尺寸={[round(v, 6) for v in (rows[0]['size'] * 2).tolist()]}"
                 f"（世界位置 x={rows[0]['center'][0]:.6f}）")
    mesh_rows = geoms_of(mirror_world, "mirrored_hull")
    mesh_id = int(np.asarray(mirror_world.model.geom_dataid[mesh_rows[0]["geomId"]]).ravel()[0])
    mesh_scale = np.asarray(mirror_world.model.mesh_scale[mesh_id], dtype=float)
    mirrored = geom_points(mirror_world, mesh_rows[0])
    checks.check("镜像正例（85）：mesh 碰撞件的 scale 保留负号（顶点真的被反射到 x≤0 一侧）",
                 (mesh_scale < 0).any() and mirrored[:, 0].max() < 1e-6,
                 f"mesh.scale={[round(v, 6) for v in mesh_scale.tolist()]} 世界 x 范围=[{mirrored[:, 0].min():.6f}, {mirrored[:, 0].max():.6f}]")

    # ── 6. mesh 部件 + 剪切：把 D 烘进顶点，凸包与独立预烘的网格一致 ─────────────
    source = write_obj(directory / "L.obj", L_SHAPE_VERTICES)
    mesh_scene = scene("collision-affine-mesh", [
        entity("scaled_parent", scale=(2, 1, 0.5)),
        entity("hull", position=(0, 0, 0.5), quaternion=rot_z(35), parent="scaled_parent",
               collision={"shape": "mesh", "parts": [source.as_uri()]}),
    ])
    baked_world = compile_scene(worker, mesh_scene)
    linear, position = world_frame(mesh_scene["entities"], "hull")
    prebaked = write_obj(directory / "L-prebaked.obj", ((linear @ np.asarray(L_SHAPE_VERTICES, dtype=float).T).T + position).tolist())
    reference_world = compile_scene(worker, scene("collision-affine-mesh-prebaked", [
        entity("hull", collision={"shape": "mesh", "parts": [prebaked.as_uri()]})]))
    baked_points = geom_points(baked_world, geoms_of(baked_world, "hull")[0])
    reference_points = geom_points(reference_world, geoms_of(reference_world, "hull")[0])
    deviation = hausdorff(baked_points, reference_points)
    checks.check("mesh 部件 + 剪切：把 D 烘进顶点后的网格 = 同一映射独立预烘的网格（凹 L 形，凸包语义未换）",
                 deviation < 1e-5 and len(baked_points) == len(reference_points),
                 f"两侧世界顶点集偏差={deviation:.3e} m，顶点数 {len(baked_points)} vs {len(reference_points)}")

    # ── 7. 形状消费：球/柱/胶囊按完整线性映射 D 找最小正确表达 ────────────────────
    # 声明三元组是 [半径, 半长, 0]，**几何轴是数据帧 z**（asset-bake fit-primitive 声明）。旧口径把
    # 尺寸逐分量乘 |D 的列范数|：球在非均匀帧下取 |v_x| 当半径（真值是椭球，实测差 0.3 m）、
    # 圆柱/胶囊把半长乘到 |v_y| 上。新口径按 D 选表达：各向同性 → 原生球；圆截面未被拉成椭圆且
    # 轴向仍正交 → 原生柱/胶囊；球的像椭球、柱/胶囊圆截面变椭圆或真剪切 → 规范凸网格（顶点是
    # D·解析采样，最大表面偏差随 warnings 明示）。
    STEPS, BANDS = 64, 16     # 与产品同值的规范采样密度（本文件的采样/公式都独立重写）

    def unit_directions(count=4096):
        """斐波那契球面方向集。凸体的 Hausdorff = 支撑函数差在方向上的最大值，所以采样值是下界。"""
        golden = math.pi * (3 - math.sqrt(5))
        rows = []
        for index in range(count):
            z = 1 - 2 * (index + 0.5) / count
            ring = math.sqrt(max(0.0, 1 - z * z))
            rows.append([ring * math.cos(golden * index), ring * math.sin(golden * index), z])
        return np.asarray(rows)

    def support(shape, radius, half, linear, directions):
        """数据帧形状（中心在原点）经 D 作用后的像的支撑函数 h_{D·K}(u) = h_K(Dᵀu)（解析真值）。"""
        w = np.asarray(directions, dtype=float) @ np.asarray(linear, dtype=float)
        if shape == "sphere":
            return radius * np.linalg.norm(w, axis=1)
        radial = radius * (np.hypot(w[:, 0], w[:, 1]) if shape == "cylinder" else np.linalg.norm(w, axis=1))
        return half * np.abs(w[:, 2]) + radial

    def deviation_bound(shape, radius, linear):
        """内接采样的最大矢高 × σ_max(D)：柱/端盖取 r(1−cos(π/N))，球面/胶囊取单元半对角。"""
        circle = 1 - math.cos(math.pi / STEPS)
        if shape == "cylinder":
            factor = circle
        else:
            latitude = math.pi / BANDS if shape == "sphere" else math.pi / (2 * BANDS)
            factor = max(circle, 1 - math.cos(0.5 * math.hypot(latitude, 2 * math.pi / STEPS)))
        return float(np.linalg.svd(np.asarray(linear, dtype=float), compute_uv=False).max() * radius * factor)

    def surface_deviation(world, entities, eid, shape, radius, half):
        """本实体的 geom 与真值像（D·形状）之间的表面偏差：支撑函数在方向集上的最大差（采样下界）。"""
        directions = unit_directions()
        rows = geoms_of(world, eid)
        linear, center = world_frame(entities, eid)
        truth = directions @ center + support(shape, radius, half, linear, directions)
        worst = 0.0
        for row in rows:
            if row["type"] == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):
                rotation = row["rotation"]
                axes = np.asarray(row["size"], dtype=float)
                local = directions @ rotation
                measured = directions @ row["center"] + np.sqrt(((local * axes) ** 2).sum(axis=1))
            else:
                measured = geom_points(world, row) @ directions.T
                measured = measured.max(axis=0)
            worst = max(worst, float(np.abs(truth - measured).max()))
        return worst

    ellipse_scene = scene("collision-affine-ellipse", [
        entity("parent", scale=(2, 1, 0.5)),
        entity("child", quaternion=rot_z(90), position=(0, 0, 0.6), parent="parent", collision={"shape": "sphere", "halfExtents": [0.2] * 3})])
    ellipse_world = compile_scene(worker, ellipse_scene)
    ellipse = geoms_of(ellipse_world, "child")[0]
    semiaxes = np.linalg.svd(data_to_body(ellipse_scene["entities"], "child"), compute_uv=False) * 0.2
    warnings = ellipse_world.handle()["warnings"]
    declared = [row for row in warnings if row["code"] == "COLLISION_SHAPE_ELLIPSOID"]
    checks.check("球 + 非均匀父级（D=diag(1,2,0.5)）：走原生 mjGEOM_ELLIPSOID，半轴 = σ·r（精确像，不是把 |v_x| 当半径）",
                 ellipse["type"] == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID)
                 and float(np.abs(np.sort(ellipse["size"]) - np.sort(semiaxes)).max()) < 1e-9
                 and bool(declared) and declared[0]["maxSurfaceDeviationM"] == 0.0,
                 f"类型={geom_type_name(ellipse['type'])} size={np.round(ellipse['size'], 6).tolist()} 真值半轴={np.round(semiaxes, 6).tolist()} warning={declared[:1]}")

    # 真实落体：半轴 (0.2, 0.4, 0.1) 的轴对齐椭球停在 z = 0.1（旧口径半径 0.2 会停在 0.2）。
    drop = compile_scene(worker, scene("collision-affine-ellipsoid-drop", [
        entity("parent", position=(0, 0, 0.5), scale=(2, 1, 0.5)),
        entity("child", quaternion=rot_z(90), position=(0, 0, 0.6), parent="parent", dynamic=True,
               collision={"shape": "sphere", "halfExtents": [0.2] * 3})]))
    simulate(drop)
    rest_z = float(body_position(drop, "child")[2])
    checks.check("球 + 非均匀父级的真实落体：静止高度 = 真值椭球沿 z 的半轴 0.1（旧口径的球半径 0.2 会停在 0.2）",
                 abs(rest_z - 0.1) < 2e-3, f"静止 z={rest_z:.6f}（真值 0.1；旧口径 0.2）")
    checks.readings["sphereEllipsoid"] = {"semiAxes": semiaxes.tolist(), "restZ": rest_z,
                                          "oldRuleRadius": 0.2, "maxSurfaceDeviationM": 0.0}

    for label, shape, radius, half in [("圆柱", "cylinder", 0.2, 0.3), ("胶囊", "capsule", 0.2, 0.3)]:
        for tag, degrees in [("非均匀父×子90°", 90), ("非均匀父×子35°剪切", 35)]:
            snapshot_ = scene("collision-affine-" + shape, [
                entity("parent", scale=(2, 1, 0.5)),
                entity("child", quaternion=rot_z(degrees), position=(0, 0, 0.6), parent="parent",
                       collision={"shape": shape, "halfExtents": [radius, half, radius]})])
            world = compile_scene(worker, snapshot_)
            row = geoms_of(world, "child")[0]
            shape_warnings = [item for item in world.handle()["warnings"] if item["code"] == "COLLISION_SHAPE_DERIVED_MESH"]
            bound = deviation_bound(shape, radius, data_to_body(snapshot_["entities"], "child"))
            measured = surface_deviation(world, snapshot_["entities"], "child", shape, radius, half)
            mesh_id = int(np.asarray(world.model.geom_dataid[row["geomId"]]).ravel()[0]) if row["type"] == int(mujoco.mjtGeom.mjGEOM_MESH) else -1
            # 顶点数才是我们烘进去的那一份；面数由 MuJoCo 编译时的凸包重划分决定（≠ 原三角化面数）。
            vertices = int(world.model.mesh_vertnum[mesh_id]) if mesh_id >= 0 else 0
            faces = int(world.model.mesh_facenum[mesh_id]) if mesh_id >= 0 else 0
            expected = 2 + (4 - 2) * STEPS if shape == "cylinder" else 2 + (2 * BANDS) * STEPS
            checks.check(f"{label} + {tag}：原生形状装不下 → 规范凸网格（{expected} 顶点 = 产品采样），表面偏差 ≤ 声明上界",
                         row["type"] == int(mujoco.mjtGeom.mjGEOM_MESH) and vertices == expected
                         and bool(shape_warnings) and abs(shape_warnings[0]["maxSurfaceDeviationM"] - bound) < 1e-12
                         and measured <= bound + 1e-9,
                         f"类型={geom_type_name(row['type'])} 顶点数={vertices}（期望 {expected}）表面偏差={measured:.3e} ≤ 上界={bound:.3e}")
            checks.readings.setdefault("shapes", {})[label + tag] = {
                "vertices": vertices, "hullFaces": faces, "surfaceDeviationM": measured,
                "declaredBoundM": bound, "oldRuleRadius": radius * float(np.linalg.norm(data_to_body(snapshot_["entities"], "child")[:, 0]))}

    # 圆截面没被拉成椭圆（父层 s_x=s_y、轴向正交）时仍是原生形状：半径 ← |D e_x|、半长 ← |D e_z|。
    native = compile_scene(worker, scene("collision-affine-native", [
        entity("parent", scale=(2, 2, 1)),
        entity("child", position=(0, 0, 0.6), parent="parent", collision={"shape": "cylinder", "halfExtents": [0.2, 0.3, 0.2]})]))
    cylinder = geoms_of(native, "child")[0]
    # 轴向**单独**缩放（父层 s_x=s_y=1、s_z=2，D=diag(1,1,2)）：圆柱与胶囊在这里分道——
    # 圆柱没有端部曲面，size[1]=half·|D e_z| 仍然精确，必须保持原生；胶囊的两端是**球**（端部半球半径
    # 恒等于截面半径），轴向单独放大把球拉成椭球，原生 capsule（半长只到柱段、端部恒按半径生成）
    # 的顶端只到 |D e_z|·half + r = 0.8，而真值是 |D e_z|·(half+r) = 1.0（差 0.2 m）。这里读**真编译**
    # 的 geom 类型/size/编译网格顶点，不靠公式自证（顶点读数与 root-113-capsule-compiled-bounds-probe.py
    # 对同一 D 量到的顶端 halfZ=1.0 一致）。
    axial_scene = scene("collision-affine-axial-scale", [entity("parent", scale=(1, 1, 2)),
                                                         entity("child", position=(0, 0, 0.5), parent="parent",
                                                                collision={"shape": "capsule", "halfExtents": [0.2, 0.3, 0]})])
    axial_world = compile_scene(worker, axial_scene)
    capsule_row = geoms_of(axial_world, "child")[0]
    capsule_mesh_id = int(np.asarray(axial_world.model.geom_dataid[capsule_row["geomId"]]).ravel()[0])
    capsule_vertices = int(axial_world.model.mesh_vertnum[capsule_mesh_id])
    capsule_points = geom_points(axial_world, capsule_row)
    apex = float(capsule_points[:, 2].max()) - float(body_position(axial_world, "child")[2])
    axial_warning = [row for row in axial_world.handle()["warnings"] if row["code"] == "COLLISION_SHAPE_DERIVED_MESH"]
    checks.check("胶囊 + 轴向单独放大（D=diag(1,1,2)，圆截面/正交都在）：必须改派生凸网格——端部半球被拉成椭球，"
                 "真编译网格在 body 帧的顶端 = |D e_z|·(half+r) = 1.0（原生 capsule 只能到 0.8）",
                 capsule_row["type"] == int(mujoco.mjtGeom.mjGEOM_MESH) and capsule_vertices == 2 + 2 * BANDS * STEPS
                 and abs(apex - 1.0) < 1e-9 and bool(axial_warning) and "椭球" in axial_warning[0]["message"]
                 and abs(axial_warning[0]["maxSurfaceDeviationM"] - deviation_bound("capsule", 0.2, np.diag([1.0, 1.0, 2.0]))) < 1e-15,
                 f"类型={geom_type_name(capsule_row['type'])} 编译顶点数={capsule_vertices} body 帧顶端={apex:.9f}（原生 capsule 顶=0.8）"
                 f" 偏差界={axial_warning[0]['maxSurfaceDeviationM'] if axial_warning else 'n/a':.3e} 说明={(axial_warning[0]['message'][:90] if axial_warning else 'n/a')}")
    checks.readings["capsuleAxialScale"] = {"geomType": geom_type_name(capsule_row["type"]), "compiledVertices": capsule_vertices,
                                            "bodyFrameApexZ": apex, "nativeCapsuleApexZ": 0.8, "boundM": axial_warning[0]["maxSurfaceDeviationM"] if axial_warning else None}
    # 同一 D 下的圆柱：仍走原生路径（轴可独立缩放），且**尺寸本身**按 |D e_z| 缩放（不是把轴向缩放丢掉）。
    axial_cylinder = compile_scene(worker, scene("collision-affine-axial-cylinder", [entity("parent", scale=(1, 1, 2)),
        entity("child", position=(0, 0, 0.5), parent="parent", collision={"shape": "cylinder", "halfExtents": [0.2, 0.3, 0]})]))
    cylinder_row = geoms_of(axial_cylinder, "child")[0]
    checks.check("圆柱 + 同一轴向单独放大（D=diag(1,1,2)）：仍走原生 mjGEOM_CYLINDER，半径 ← |D e_x| = 0.2、半长 ← |D e_z| = 0.6（轴可独立缩放）",
                 cylinder_row["type"] == int(mujoco.mjtGeom.mjGEOM_CYLINDER)
                 and abs(float(cylinder_row["size"][0]) - 0.2) < 1e-9 and abs(float(cylinder_row["size"][1]) - 0.6) < 1e-9
                 and not [row for row in axial_cylinder.handle()["warnings"] if row["entityId"] == "child"],
                 f"类型={geom_type_name(cylinder_row['type'])} 半径={float(cylinder_row['size'][0]):.6f} 半长={float(cylinder_row['size'][1]):.6f} "
                 f"warnings={[row['code'] for row in axial_cylinder.handle()['warnings'] if row['entityId'] == 'child']}")

    checks.check("圆柱：圆截面未变形（父层 s_x=s_y=2、轴向 s_z=1）→ 仍是原生 mjGEOM_CYLINDER，半径 ← |D e_x| = 0.4、半长 ← |D e_z| = 0.3",
                 cylinder["type"] == int(mujoco.mjtGeom.mjGEOM_CYLINDER)
                 and abs(float(cylinder["size"][0]) - 0.4) < 1e-9 and abs(float(cylinder["size"][1]) - 0.3) < 1e-9,
                 f"类型={geom_type_name(cylinder['type'])} 半径={float(cylinder['size'][0]):.6f} 半长={float(cylinder['size'][1]):.6f}")

    # 表述不了的位形仍按实体归因拒绝。
    def sheared_scene(collision, parent_scale=(2, 1, 0.5)):
        return scene("collision-affine-refuse", [entity("parent", scale=parent_scale),
                                                 entity("child", quaternion=rot_z(35), parent="parent", collision=collision)])

    try:
        compile_scene(worker, sheared_scene({"shape": "sdf", "parts": [source.as_uri()]}))
        checks.check("剪切位形下的 sdf：按实体归因拒绝（不放大的包围盒、不静默近似）", False, "编译居然成功了")
    except Exception as exc:
        checks.check("剪切位形下的 sdf：按实体归因拒绝（不放大的包围盒、不静默近似）",
                     getattr(exc, "code", None) == "UNSUPPORTED_CAPABILITY" and "child" in str(exc),
                     f"{getattr(exc, 'code', None)}: {exc}")

    # ── 8. 0 分量：归因到实体，而不是引擎的无归因失败 ─────────────────────────
    try:
        compile_scene(worker, scene("zero", [entity("zeroed", scale=(0, 1, 1), collision=box((0.2, 0.2, 0.2)))]))
        checks.check("累计缩放含 0 分量：按实体归因拒绝", False, "编译居然成功了")
    except Exception as exc:
        checks.check("累计缩放含 0 分量：按实体归因拒绝",
                     getattr(exc, "code", None) == "INVALID_ARGUMENT" and "zeroed" in str(exc),
                     f"{getattr(exc, 'code', None)}: {exc}")

    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
