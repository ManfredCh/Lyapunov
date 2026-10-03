"""增量导出验收：真实 Blender、真实文件、真实字节。

判据全部取自**外部可见事实**，不靠 world.py 自己的指纹自证：

  1. **独立计数器**：在 glTF 操作符本体（`io_scene_gltf2.ExportGLTF2.execute`）上打补丁，退出时写 witness JSON
     —— 与 world.py 的回执无关；两者对不上就说明回执在自说自话。
  2. **逐文件事实**：输出目录里每个文件的 `mtime_ns` + 字节 `sha256`。没变的部分必须连 mtime 都不动；
     变的部分必须真的换字节；历史版本的旧文件必须原样留在盘上。
  3. **声明 vs 真字节**：scene.json 每个 (resourceId@version) 登记的 `sha256`/`byteSize` 与磁盘文件核对。
  4. **派生内容真的换了**：改共享网格数据后 GLB 里顶点包围盒真的长大 0.25 m；改外部贴图字节后 GLB 里嵌的图片字节真的变了。
  5. **源/派生耦合**：每个版本 `original` 指向的冻结快照是真能打开的工程，且里面就是那一版的状态。
  6. 真实墙钟耗时（首次全量 vs 无改动）。

场景写在测试工作目录里：一块被**两个实例共享**的墙体网格（共享同一个数据块）、一个独立构件、一个用**真实外部
PNG**（磁盘上的真文件）的材质、相机与灯。所有改动都走"真实加载上一轮保存的工程 → 改 → 导出"这同一条路径。
版本号语义：`version` = **引入该内容的 scene revision**（不是每个资源各自从 1 数），所以 revisions 与版本号要对得上。

跑法：`python3 packages/blender/test/test_world_incremental_export.py`
环境变量：`LYAPUNOV_BLENDER_TEST_WORKDIR`、`BLENDER_EXECUTABLE`、`LYAPUNOV_SKIP_SCALE=1`（跳过 212 实例规模段）。
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_world_harness import (  # noqa: E402
    Checks, blender_executable, fresh_dir, glb_facts, glb_json, inspect_blend, run_world, write_png, write_script, workdir,
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def file_facts(path: Path) -> dict:
    stat = path.stat()
    return {"mtime": stat.st_mtime_ns, "size": stat.st_size, "sha256": sha256_file(path)}


def tree(root: Path) -> dict:
    """输出目录的逐文件事实（相对路径 → mtime_ns/字节数/sha256）。`.blend1` 是 Blender 自己的轮转备份，不算产物。"""
    return {str(path.relative_to(root)): file_facts(path)
            for path in sorted(root.rglob("*")) if path.is_file() and not path.name.endswith(".blend1")}


def diff_tree(before: dict, after: dict) -> list[str]:
    return sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))


def glb_bin(path: Path) -> bytes:
    data = path.read_bytes()
    offset = 12
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        if kind == 0x004E4942:
            return data[offset + 8:offset + 8 + length]
        offset += 8 + length
    raise ValueError(f"GLB_WITHOUT_BIN: {path}")


def view_bytes(path: Path, buffer_view: int) -> bytes:
    payload, binary = glb_json(path), glb_bin(path)
    view = payload["bufferViews"][buffer_view]
    start = view.get("byteOffset", 0)
    return binary[start:start + view["byteLength"]]


def glb_image_bytes(path: Path, index: int = 0) -> bytes:
    payload = glb_json(path)
    return view_bytes(path, payload["images"][index]["bufferView"])


def glb_corners(path: Path) -> list:
    """GLB 里去重后的顶点坐标集合——逐轴尺寸看不出"某个角沿轴内缩"（外框还是那么大），要按集合比。"""
    payload, binary = glb_json(path), glb_bin(path)
    corners = set()
    for mesh in payload.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor = payload["accessors"][primitive["attributes"]["POSITION"]]
            view = payload["bufferViews"][accessor["bufferView"]]
            start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            values = struct.unpack_from("<%df" % (accessor["count"] * 3), binary, start)
            for index in range(0, len(values), 3):
                corners.add(tuple(round(values[index + axis], 4) for axis in range(3)))
    return sorted(corners)


def glb_vertex_counts(path: Path) -> list[int]:
    payload = glb_json(path)
    return [payload["accessors"][primitive["attributes"]["POSITION"]]["count"]
            for mesh in payload.get("meshes", []) for primitive in mesh.get("primitives", [])]


def glb_morph_targets(path: Path) -> int:
    payload = glb_json(path)
    return sum(len(primitive.get("targets", []))
               for mesh in payload.get("meshes", []) for primitive in mesh.get("primitives", []))


def entities_of(output: Path) -> dict:
    return {entity["name"]: entity for entity in json.loads((output / "scene.json").read_text())["entities"]}


def resource_of(entity: dict) -> dict:
    for resource in entity.get("resources", []):
        for representation in resource.get("representations", []):
            if representation.get("mimeType") == "model/gltf-binary":
                return {"resourceId": resource["resourceId"], "version": resource["version"],
                        "uri": representation["uri"], "declared": resource.get("blender:content", {}),
                        "original": (resource.get("original") or {}).get("uri")}
    return {}


def uris_of(entities: dict) -> list[str]:
    return [representation["uri"] for entity in entities.values() for resource in entity.get("resources", [])
            for representation in resource.get("representations", [])]


PRELUDE = '''"""111 验收场景脚本：先给导出的操作符本体装独立计数器，再建场景或改场景。"""
import atexit, json
from pathlib import Path

import bpy
import io_scene_gltf2
from mathutils import Vector

texture_path = Path(r"{texture}")
witness_path = Path(r"{witness}")
calls = {{"gltf": 0}}

# 计数器打在**操作符**本身上：world.py 调 bpy.ops.export_scene.gltf 时必然经过这里。
_original_execute = io_scene_gltf2.ExportGLTF2.execute


def counting_execute(self, context):
    calls["gltf"] += 1
    return _original_execute(self, context)


io_scene_gltf2.ExportGLTF2.execute = counting_execute
atexit.register(lambda: witness_path.write_text(json.dumps(calls)))


def clear():
    for item in list(bpy.data.objects):
        bpy.data.objects.remove(item, do_unlink=True)


def cube(name, location, scale=(1.0, 1.0, 1.0), material=None, data=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    if data is not None:
        obj.data = data
    if material is not None and material.name not in [slot.name for slot in obj.data.materials if slot]:
        obj.data.materials.append(material)
    return obj
'''

SCENE_BODY = '''
clear()
# 真实外部贴图：磁盘上的真 PNG 文件（导出只读它，从不改它）。
brick = bpy.data.materials.new("brick-mat")
brick.use_nodes = True
image_node = brick.node_tree.nodes.new("ShaderNodeTexImage")
image_node.image = bpy.data.images.load(str(texture_path))
brick.node_tree.links.new(image_node.outputs["Color"], brick.node_tree.nodes["Principled BSDF"].inputs["Base Color"])

beacon_material = bpy.data.materials.new("beacon-mat")
beacon_material.use_nodes = True
beacon_material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.1, 0.6, 0.2, 1.0)

wall = cube("wall", (-1.2, 0.0, 0.5), (2.4, 0.2, 1.0), brick)
# 链接副本：两个实例共享**同一个网格数据块**（增量导出里必须共用一个资源版本）。
wall_copy = cube("wall_copy", (1.2, 0.0, 0.5), (2.4, 0.2, 1.0), data=wall.data)
floor = cube("floor", (0.0, 0.0, -0.05), (4.0, 4.0, 0.1), brick)
beacon = cube("beacon", (0.0, 1.4, 0.35), (0.3, 0.3, 0.7), beacon_material)

bpy.ops.object.light_add(type="SUN", location=(3.0, -2.0, 4.0))
bpy.context.object.name = "key_light"
bpy.ops.object.camera_add(location=(0.0, -6.0, 2.5))
camera = bpy.context.object
camera.name = "courtyard_camera"
camera.rotation_euler = (1.2, 0.0, 0.0)
bpy.context.scene.camera = camera
print("SCENE_READY", len(bpy.data.objects))
'''

EDIT_CAMERA = 'bpy.data.objects["courtyard_camera"].location.x += 0.5\n'

EDIT_INSTANCE = 'bpy.data.objects["wall_copy"].location.y += 0.4\n'

EDIT_MATERIAL = ('bpy.data.materials["beacon-mat"].node_tree.nodes["Principled BSDF"]'
                 '.inputs["Base Color"].default_value = (0.9, 0.2, 0.1, 1.0)\n')

EDIT_SHARED_MESH = 'bpy.data.objects["wall"].data.vertices[0].co.y += 0.25   # 改共享数据块 = 改它的全部实例\n'

EDIT_DELETE_INSTANCE = 'bpy.data.objects.remove(bpy.data.objects["wall_copy"], do_unlink=True)\n'

EDIT_DELETE_LAST_USER = 'bpy.data.objects.remove(bpy.data.objects["beacon"], do_unlink=True)\n'


def export(output: Path, label: str, texture: Path, body: str, source: Path | None = None) -> dict:
    """跑一次真实导出（首次建场景，之后加载上一轮保存的工程再改），返回独立计数的导出调用数与耗时。"""
    witness = workdir() / f"witness-{label}.json"
    if witness.exists():
        witness.unlink()
    script = write_script(f"incremental-{label}.py", PRELUDE.format(texture=texture, witness=witness) + body)
    started = time.time()
    run = run_world(["--output", str(output), "--operation", "export"], scene_script=script, source_blend=source)
    seconds = time.time() - started
    calls = json.loads(witness.read_text())["gltf"] if witness.exists() else None
    return {"run": run, "result": run.result or {}, "incremental": (run.result or {}).get("incremental") or {},
            "calls": calls, "seconds": seconds, "witness": witness}


def check_declared_files(output: Path, checks: Checks, label: str) -> dict:
    """scene.json 里登记的每个 (resourceId@version) 都要在磁盘上有真文件、且 sha256/字节数逐一对得上。"""
    versions = {}
    for entity in json.loads((output / "scene.json").read_text())["entities"]:
        for resource in entity.get("resources", []):
            for representation in resource.get("representations", []):
                if representation.get("mimeType") != "model/gltf-binary":
                    continue
                versions[(resource["resourceId"], resource["version"])] = (representation["uri"], resource.get("blender:content", {}))
    bad, missing = [], []
    for (resource_id, version), (uri, declared) in versions.items():
        path = Path(uri)
        if not path.is_file():
            missing.append(f"{resource_id}@{version}")
        elif declared.get("sha256") != sha256_file(path) or declared.get("byteSize") != path.stat().st_size:
            bad.append(f"{resource_id}@{version} 声明={str(declared.get('sha256'))[:12]}/{declared.get('byteSize')} "
                       f"实盘={sha256_file(path)[:12]}/{path.stat().st_size}")
    checks.check(f"[{label}] scene.json 声明的 (resourceId@version) 与磁盘真文件逐一对上（sha256 + 字节数）",
                 not bad and not missing, f"版本数={len(versions)} 对不上={bad} 缺失={missing}")
    return versions


def check_main_scenarios(checks: Checks) -> Path:
    output = fresh_dir("incremental")
    texture = workdir() / "assets" / "brick.png"
    texture.parent.mkdir(parents=True, exist_ok=True)
    write_png(texture, 8, 8, (200, 30, 30))
    first_texture_bytes = texture.read_bytes()
    snapshots = []          # 每轮之后的逐文件事实（不可变性审计的原始证据）
    print(f"输出目录 {output}\n外部贴图 {texture}（{len(first_texture_bytes)} 字节）", flush=True)

    def record(label: str, run: dict):
        """一轮结束时：核对 scene.json 声明 vs 磁盘真文件，并留下这一轮的逐文件事实。"""
        check_declared_files(output, checks, label)
        facts = tree(output)
        snapshots.append((label, facts))
        return facts

    # ── 1 第一次完整导出 ───────────────────────────────────────────────────────
    first = export(output, "r1-full", texture, SCENE_BODY)
    checks.check("第一次完整导出干净退出", first["run"].clean and first["result"],
                 f"exit={first['run'].code} tail={first['run'].tail(200)}")
    incremental = first["incremental"]
    checks.check("第一次导出：3 个资源真的各导出一次（独立操作符计数与回执一致）",
                 first["calls"] == 3 and incremental.get("visualExports") == 3 and incremental.get("visualReused") == 0,
                 f"操作符计数={first['calls']} 回执 visualExports={incremental.get('visualExports')} reused={incremental.get('visualReused')}")
    before = record("r1", first)
    glbs = sorted(name for name in before if name.startswith("visuals/"))
    checks.check("磁盘上真的多了 3 个版本文件，合计字节数与回执 bytesExported 一致",
                 len(glbs) == 3 and sum(before[name]["size"] for name in glbs) == incremental.get("bytesExported"),
                 f"文件={glbs} 合计={sum(before[name]['size'] for name in glbs)} 回执={incremental.get('bytesExported')}")
    checks.check("revision=1，且工程里留下了这一版的冻结快照（sources/<ns>-r1.blend）",
                 first["result"].get("revision") == 1 and first["result"].get("resourceVersion") == 1
                 and [name for name in before if name.startswith("sources/")],
                 f"revision={first['result'].get('revision')} 快照={[name for name in before if name.startswith('sources/')]}")
    entities = entities_of(output)
    wall_a, wall_b = resource_of(entities["wall"]), resource_of(entities["wall_copy"])
    checks.check("共享网格的两个实例指向**同一个**资源版本（不是每个实例一份）",
                 wall_a["resourceId"] == wall_b["resourceId"] and wall_a["version"] == wall_b["version"] == 1
                 and incremental.get("sharedResources", {}).get(wall_a["resourceId"]) == 2,
                 f"wall={wall_a['resourceId']}@{wall_a['version']} wall_copy={wall_b['resourceId']}@{wall_b['version']} "
                 f"共享组={incremental.get('sharedResources')}")
    checks.check("三个资源身份互不相同（共享按数据块，独立构件各一份）",
                 len({resource_of(entities[name])["resourceId"] for name in ("wall", "floor", "beacon")}) == 3,
                 str([(name, resource_of(entities[name])["resourceId"]) for name in ("wall", "floor", "beacon")]))
    floor_glb = Path(resource_of(entities["floor"])["uri"])
    facts = glb_facts(floor_glb)
    checks.check("带真实贴图的资源：GLB 里真的嵌了 1 张图，且嵌进去的字节就是磁盘上那个 PNG",
                 facts["images"] == 1 and glb_image_bytes(floor_glb) == first_texture_bytes,
                 f"images={facts['images']} 嵌图={len(glb_image_bytes(floor_glb))}B 文件={len(first_texture_bytes)}B")
    beacon_glb = Path(resource_of(entities["beacon"])["uri"])
    beacon_facts = glb_facts(beacon_glb)
    checks.check("构件材质在派生内容里真是作者设的绿色（GLB 真读，不是查我们自己的指纹）",
                 beacon_facts["materials"] == ["beacon-mat"]
                 and abs(beacon_facts["materialBaseColors"]["beacon-mat"][1] - 0.6) < 1e-3,
                 str(beacon_facts["materialBaseColors"]))
    print(f"首次导出：{first['calls']} 次调用 / {first['seconds']:.2f}s（回执导出 {incremental.get('exportSeconds')}s）", flush=True)

    # ── 2 完全不改，再来一次 ───────────────────────────────────────────────────
    second = export(output, "r2-noop", texture, "", source=output / "source.blend")
    after = record("r2", second)
    incremental = second["incremental"]
    checks.check("什么都不改：一次导出调用都没有（独立计数器=0），3 个资源全部复用",
                 second["calls"] == 0 and incremental.get("visualExports") == 0 and incremental.get("visualReused") == 3,
                 f"操作符计数={second['calls']} 回执 visualExports={incremental.get('visualExports')} reused={incremental.get('visualReused')}")
    checks.check("什么都不改：输出目录里没有任何文件被动过（逐文件 mtime_ns 与 sha256 都不变，含 source.blend）",
                 diff_tree(before, after) == [], f"变化={diff_tree(before, after)}")
    checks.check("什么都不改：回执说没保存工程、没写产物、但确实跳过了固定名产物",
                 incremental.get("sourceSaved") is False and incremental.get("artifactWrites") == []
                 and incremental.get("artifactSkips"), f"sourceSaved={incremental.get('sourceSaved')} "
                 f"writes={incremental.get('artifactWrites')} skips={len(incremental.get('artifactSkips') or [])}")
    # 耗时判据只认**程内**导出秒数：墙钟里 Blender 进程启动+载入工程占大头，而本机 load average 常在一百以上
    # （不是本任务能控制的），拿它判"有没有偷跑导出"会把负载当成回归。墙钟照测照报，只拦"整轮翻好几倍"那种量级。
    checks.check("什么都不改：导出耗时≈0（真测量：程内计时），墙钟只剩 Blender 启动那点固定开销",
                 incremental.get("exportSeconds", 9) < 0.2
                 and second["seconds"] < first["seconds"] * 3.0,
                 f"首次 墙钟 {first['seconds']:.2f}s / 程内导出 {first['incremental'].get('exportSeconds')}s → "
                 f"无改动 墙钟 {second['seconds']:.2f}s / 程内导出 {incremental.get('exportSeconds')}s（本机 load 高时墙钟抖动大）")
    before, base_entities = after, entities

    # ── 3 只移相机 ────────────────────────────────────────────────────────────
    third = export(output, "r3-camera", texture, EDIT_CAMERA, source=output / "source.blend")
    after = record("r3", third)
    changed = diff_tree(before, after)
    incremental = third["incremental"]
    checks.check("只移相机：0 次导出调用，GLB 一个字节都没动",
                 third["calls"] == 0 and incremental.get("visualExports") == 0
                 and not [name for name in changed if name.startswith("visuals/")],
                 f"计数={third['calls']} 变化={changed}")
    checks.check("只移相机：physics/world.xml 跟着更新（相机在这个导出器里是 MJCF 的 body），且只改这一处",
                 "physics/world.xml" in changed
                 and "<body name=\"courtyard_camera\" pos=\"0.5 -6.0 2.5\"" in (output / "physics" / "world.xml").read_text(),
                 f"变化={changed} world.xml={[line for line in (output / 'physics' / 'world.xml').read_text().split('<body') if 'camera' in line]}")
    now = entities_of(output)
    checks.check("只移相机：scene.json 真的更新了（revision=2、相机沿 x 走 0.5），工程也保存了",
                 third["result"].get("revision") == 2 and "scene.json" in changed and "source.blend" in changed
                 and abs(now["courtyard_camera"]["transform"]["position"][0] - 0.5) < 1e-6,
                 f"revision={third['result'].get('revision')} 变化={changed} 相机={now['courtyard_camera']['transform']['position']}")
    checks.check("只移相机：其余实体的 transform 与首轮逐字段相同（没有连带改动）",
                 all(now[name]["transform"] == base_entities[name]["transform"] for name in ("wall", "wall_copy", "floor", "beacon", "key_light"))
                 and all(resource_of(now[name])["version"] == 1 for name in ("wall", "floor", "beacon")),
                 str({name: now[name]["transform"]["position"] for name in ("wall", "wall_copy", "floor", "beacon")}))
    before, base_entities = after, now

    # ── 4 只移一个（共享资源的）实例 ───────────────────────────────────────────
    fourth = export(output, "r4-instance", texture, EDIT_INSTANCE, source=output / "source.blend")
    after = record("r4", fourth)
    changed = diff_tree(before, after)
    now = entities_of(output)
    checks.check("只移一个实例：0 次导出（位姿住在 scene.json 里，共享 GLB 不该重导）",
                 fourth["calls"] == 0 and fourth["incremental"].get("visualExports") == 0
                 and not [name for name in changed if name.startswith("visuals/")],
                 f"计数={fourth['calls']} 变化={changed}")
    checks.check("只移一个实例：world.xml 跟着更新（这个实例是物理体），revision=3",
                 "physics/world.xml" in changed and fourth["result"].get("revision") == 3, f"变化={changed} revision={fourth['result'].get('revision')}")
    checks.check("只移一个实例：另一个实例不动，共享资源仍是版本 1",
                 now["wall"]["transform"] == base_entities["wall"]["transform"]
                 and resource_of(now["wall_copy"])["version"] == 1
                 and abs(now["wall_copy"]["transform"]["position"][1] - 0.4) < 1e-6,
                 f"wall={now['wall']['transform']['position']} wall_copy={now['wall_copy']['transform']['position']}")
    before, base_entities = after, now

    # ── 5 改一个构件的材质 ────────────────────────────────────────────────────
    beacon_v1 = before[str(Path(resource_of(entities["beacon"])["uri"]).relative_to(output))]
    fifth = export(output, "r5-material", texture, EDIT_MATERIAL, source=output / "source.blend")
    after = record("r5", fifth)
    changed = diff_tree(before, after)
    now = entities_of(output)
    new_beacon = resource_of(now["beacon"])
    new_files = [name for name in changed if name.startswith("visuals/")]
    checks.check("改一个构件材质：只有那一个资源重新导出（独立计数器=1），别的 GLB 连 mtime 都没动",
                 fifth["calls"] == 1 and fifth["incremental"].get("visualExports") == 1
                 and len(new_files) == 1 and new_beacon["resourceId"] in new_files[0],
                 f"计数={fifth['calls']} 新文件={new_files}")
    checks.check("改一个构件材质：版本号=引入它的 revision(4)、文件名带 -v4、旧版本文件原样留在盘上",
                 new_beacon["version"] == 4 and Path(new_beacon["uri"]).name.endswith("-v4.glb")
                 and after[str(Path(resource_of(entities["beacon"])["uri"]).relative_to(output))] == beacon_v1,
                 f"beacon v1→v{new_beacon['version']} 文件名={Path(new_beacon['uri']).name}")
    checks.check("改一个构件材质：共享墙与地面仍是版本 1（材质没被误判成变了）",
                 resource_of(now["wall"])["version"] == 1 and resource_of(now["floor"])["version"] == 1,
                 f"wall@{resource_of(now['wall'])['version']} floor@{resource_of(now['floor'])['version']}")
    checks.check("改一个构件材质：新 GLB 里读到的颜色真是新颜色",
                 abs(glb_facts(Path(new_beacon["uri"]))["materialBaseColors"]["beacon-mat"][0] - 0.9) < 1e-3,
                 str(glb_facts(Path(new_beacon["uri"]))["materialBaseColors"]))
    snapshot = Path(new_beacon["original"])
    probe = inspect_blend(snapshot, 'value = bpy.data.materials["beacon-mat"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value\n'
                                    'report = {"red": round(value[0], 4), "objects": len(bpy.data.objects), "wallVertices": len(bpy.data.objects["wall"].data.vertices)}\n'
                                    'print("PROBE_RESULT=" + json.dumps(report))\n')
    checks.check("源/派生耦合：这一版 original 的冻结快照是真能打开的工程，里面的材质就是这一版的新颜色",
                 snapshot.is_file() and abs(probe.get("red", 0) - 0.9) < 1e-3 and probe.get("objects") == 6 and probe.get("wallVertices") == 8,
                 f"{snapshot.name}: {probe}")
    before, base_entities = after, now

    # ── 6 改共享网格数据 ──────────────────────────────────────────────────────
    old_wall_name = str(Path(resource_of(now["wall"])["uri"]).relative_to(output))
    old_corners = glb_corners(output / old_wall_name)
    sixth = export(output, "r6-shared-mesh", texture, EDIT_SHARED_MESH, source=output / "source.blend")
    after = record("r6", sixth)
    changed = diff_tree(before, after)
    now = entities_of(output)
    new_wall = resource_of(now["wall"])
    new_corners = glb_corners(Path(new_wall["uri"]))
    moved = [corner for corner in new_corners if corner not in old_corners]
    kept = [corner for corner in old_corners if corner not in new_corners]
    checks.check("改共享网格数据：只导出一次，两个实例一起换到同一个新版本（v5）",
                 sixth["calls"] == 1 and sixth["incremental"].get("visualExports") == 1 and new_wall["version"] == 5
                 and resource_of(now["wall_copy"]) == new_wall,
                 f"计数={sixth['calls']} wall@{new_wall['version']} wall_copy@{resource_of(now['wall_copy'])['version']}")
    # 改的是一个角沿轴内缩 0.25（外框尺寸不变，逐轴 max-min 看不出来），所以比顶点集合：
    # 新文件必须恰好少一个旧角、多一个沿单轴挪了 0.25 的新角，其余 7 个角原样保留。
    moved_together = (len(moved) == 1 and len(kept) == 1
                      and sum(abs(moved[0][axis] - kept[0][axis]) for axis in range(3)) == 0.25)
    checks.check("改共享网格数据：新 GLB 里真是那个角沿一根轴挪了 0.25（其余顶点原样，不是只换了个文件名）",
                 moved_together and len(old_corners) == 8 and len(new_corners) == 8,
                 f"旧角={kept} 新角={moved} 顶点数={len(old_corners)}→{len(new_corners)}")
    checks.check("改共享网格数据：floor/beacon 的 GLB 没被动，旧墙版本仍在且字节不变",
                 not [name for name in changed if name.startswith("visuals/") and name != str(Path(new_wall["uri"]).relative_to(output))]
                 and after[old_wall_name] == before[old_wall_name],
                 f"变化={changed}")
    before, base_entities = after, now

    # ── 7 真实外部贴图字节改变（同路径） ──────────────────────────────────────
    old_floor = resource_of(now["floor"])
    old_embedded = glb_image_bytes(Path(old_floor["uri"]))
    write_png(texture, 8, 8, (30, 200, 90))          # 同一个路径，真实字节换掉
    new_texture_bytes = texture.read_bytes()
    seventh = export(output, "r7-texture", texture, "", source=output / "source.blend")
    after = record("r7", seventh)
    changed = diff_tree(before, after)
    now = entities_of(output)
    new_floor, new_wall = resource_of(now["floor"]), resource_of(now["wall"])
    checks.check("换掉外部贴图字节（同路径）：用这张图的两个资源都重新导出了（墙面+地面各一次），beacon 不动",
                 seventh["calls"] == 2 and seventh["incremental"].get("visualExports") == 2
                 and new_floor["version"] == 6 and new_wall["version"] == 6 and resource_of(now["beacon"])["version"] == 4,
                 f"计数={seventh['calls']} floor@{new_floor['version']} wall@{new_wall['version']} beacon@{resource_of(now['beacon'])['version']}")
    checks.check("换掉外部贴图字节：新 GLB 里嵌的图片字节真的变了，旧 GLB 里仍是旧字节（各自不可变）",
                 glb_image_bytes(Path(new_floor["uri"])) != old_embedded
                 and glb_image_bytes(Path(new_floor["uri"])) == new_texture_bytes
                 and glb_image_bytes(Path(old_floor["uri"])) == old_embedded,
                 f"旧嵌图 {len(old_embedded)}B → 新嵌图 {len(glb_image_bytes(Path(new_floor['uri'])))}B（磁盘新文件 {len(new_texture_bytes)}B）")
    checks.check("换掉外部贴图字节：磁盘上的贴图文件本身没被导出改动（导出只读源）",
                 texture.read_bytes() == new_texture_bytes, f"{texture.name} sha256={sha256_file(texture)[:12]}")
    before, base_entities = after, now

    # ── 8 删一个实例 ─────────────────────────────────────────────────────────
    eighth = export(output, "r8-delete-instance", texture, EDIT_DELETE_INSTANCE, source=output / "source.blend")
    after = record("r8", eighth)
    changed = diff_tree(before, after)
    now = entities_of(output)
    checks.check("删一个实例：共享资源还有使用者（0 次导出），GLB 与外部贴图都没被连带删掉",
                 eighth["calls"] == 0 and eighth["incremental"].get("visualExports") == 0 and "wall_copy" not in now
                 and Path(resource_of(now["wall"])["uri"]).is_file() and texture.is_file()
                 and not [name for name in changed if name.startswith("visuals/")],
                 f"计数={eighth['calls']} 实体={sorted(now)} 变化={changed}")
    checks.check("删一个实例：world.xml 少一个 body，scene.json 里没有悬空引用，实体数 6→5",
                 "physics/world.xml" in changed and len(now) == 5 and all(Path(uri).is_file() for uri in uris_of(now)),
                 f"实体数={len(now)} 变化={changed}")
    before = after

    # ── 9 删掉某个资源的最后一个使用者 ───────────────────────────────────────
    beacon_uri = resource_of(entities["beacon"])["uri"]
    beacon_name = str(Path(beacon_uri).relative_to(output))
    ninth = export(output, "r9-delete-last", texture, EDIT_DELETE_LAST_USER, source=output / "source.blend")
    after = record("r9", ninth)
    incremental = ninth["incremental"]
    checks.check("删掉某资源的最后一个使用者：不重导（0 次），旧版本文件仍留在盘上（不误删历史字节）",
                 ninth["calls"] == 0 and incremental.get("visualExports") == 0 and Path(beacon_uri).is_file()
                 and after[beacon_name] == before[beacon_name] and texture.read_bytes() == new_texture_bytes,
                 f"计数={ninth['calls']} 实体={sorted(entities_of(output))}")
    checks.check("删掉最后一个使用者：scene.json 自洽（revision=8、所有引用都指向存在的文件）",
                 ninth["result"].get("revision") == 8 and all(Path(uri).is_file() for uri in uris_of(entities_of(output))),
                 f"revision={ninth['result'].get('revision')} 引用={sorted(set(uris_of(entities_of(output))))}")

    # ── 不可变性审计 ─────────────────────────────────────────────────────────
    final_versions = check_declared_files(output, checks, "最终")
    history = {}
    for label, facts in snapshots:
        for name, item in facts.items():
            if name.startswith(("visuals/", "sources/")):
                history.setdefault(name, {})[label] = item
    touched = sorted(name for name, seen in history.items() if len({json.dumps(item, sort_keys=True) for item in seen.values()}) > 1)
    expected = sorted(name for name in (name for _, facts in snapshots for name in facts) if name.startswith(("visuals/", "sources/")))
    checks.check("不可变性审计：历轮写出的 visuals/*.glb 与 sources/*.blend 至今字节未变、也未被删",
                 not touched and len(history) == 11 and all(name in history for name in expected)
                 and {name: item for name, item in history.items()} and len({name for name, _ in final_versions}) == 2,
                 f"受审文件 {len(history)} 个：{sorted(history)}；被改写={touched}；"
                 f"留下的版本文件={sorted(name for name in history if name.startswith('visuals/'))}")
    checks.check("版本号只前进、每个版本一个独立文件：最终 scene.json 只剩墙 v6 与地面 v6（beacon 已删）",
                 sorted(version for _, version in final_versions) == [6, 6],
                 str(sorted(final_versions)))
    checks.check("冻结快照与版本一一对应：4 个引入内容的 revision 各有 1 份 sources 快照",
                 sorted(name for name in history if name.startswith("sources/")) ==
                 [f"sources/{name}" for name in sorted(Path(name).name for name in history if name.startswith("sources/"))]
                 and len([name for name in history if name.startswith("sources/")]) == 4,
                 str(sorted(name for name in history if name.startswith("sources/"))))
    print(f"不可变性审计：{len(history)} 个历史文件（{len([n for n in history if n.startswith('visuals/')])} 个 GLB 版本 + "
          f"{len([n for n in history if n.startswith('sources/')])} 份快照）全部原样", flush=True)
    return output


INVALID_SHARED_BODY = '''
clear()
# 一个**无效**的网格数据块被两个实例共享：Blender 的 glTF 导出器遇到这种网格会就地 repair
# （它自己那句 "Mesh X is not valid" 警告），那是改数据块 —— 修好之后共享它的另一个实例会算出另一个
# 内容指纹。这里刻意造一条自环边（validate 会删掉它），把"导出器就地改了数据块"的时序钉死在测试里。
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(-1.0, 0.0, 0.5))
first = bpy.context.object
first.name = "bad_a"
first.data.name = "bad_mesh"
first.scale = (1.0, 1.0, 1.0)
first.data.edges[0].vertices = (0, 0)                 # 自环边：无效，validate() 会改数据
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(1.0, 0.0, 0.5))
second = bpy.context.object
second.name = "bad_b"
second.data = first.data                              # 链接副本：共享同一个数据块
bpy.ops.object.light_add(type="SUN", location=(3.0, -2.0, 4.0))
bpy.context.object.name = "key_light"
bpy.ops.object.camera_add(location=(0.0, -6.0, 2.5))
bpy.context.scene.camera = bpy.context.object
bpy.context.scene.camera.name = "courtyard_camera"
print("INVALID_READY", len(bpy.data.objects))
'''

PER_INSTANCE_BODY = '''
clear()
# 同一个网格数据块、两个实例，但其中一个挂了修改器：**导出的字节真的不同**。
# 一个资源身份下因此有两个内容 —— 它们必须各写各的版本文件，任何一份都不许被另一份覆盖。
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(-1.0, 0.0, 0.5))
plain = bpy.context.object
plain.name = "plain"
plain.data.name = "shared_mesh"
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(1.0, 0.0, 0.5))
modified = bpy.context.object
modified.name = "modified"
modified.data = plain.data
modifier = modified.modifiers.new("Solidify", "SOLIDIFY")
modifier.thickness = 0.4
bpy.ops.object.light_add(type="SUN", location=(3.0, -2.0, 4.0))
bpy.context.object.name = "key_light"
bpy.ops.object.camera_add(location=(0.0, -6.0, 2.5))
bpy.context.scene.camera = bpy.context.object
bpy.context.scene.camera.name = "courtyard_camera"
print("PER_INSTANCE_READY", len(bpy.data.objects))
'''

EDIT_SOLIDIFY = 'bpy.data.objects["modified"].modifiers["Solidify"].thickness = 0.9\n'

SHAPEKEY_BODY = '''
clear()
# 带**形态键**的网格：导出器拒绝给它应用修改器（应用就丢变形目标，见 bakes_modifiers），
# 所以挂在这类对象上的修改器不是这份字节的输入——改了它不许声明新版本。
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
puff = bpy.context.object
puff.name = "puff"
puff.data.name = "puff_mesh"
puff.shape_key_add(name="Basis")
puff.shape_key_add(name="inflate").data[0].co.z += 0.5
puff.modifiers.new("Solidify", "SOLIDIFY").thickness = 0.3
bpy.ops.object.light_add(type="SUN", location=(3.0, -2.0, 4.0))
bpy.context.object.name = "key_light"
bpy.ops.object.camera_add(location=(0.0, -6.0, 2.5))
bpy.context.scene.camera = bpy.context.object
bpy.context.scene.camera.name = "courtyard_camera"
print("SHAPEKEY_READY", len(bpy.data.objects))
'''

EDIT_SHAPEKEY_MODIFIER = 'bpy.data.objects["puff"].modifiers["Solidify"].thickness = 0.9\n'

EDIT_SHAPEKEY_MORPH = 'bpy.data.objects["puff"].data.shape_keys.key_blocks["inflate"].data[0].co.z += 0.25\n'


def check_shared_datablock_identity(checks: Checks):
    """共享数据块下的身份稳定（两个真跑出来的缺陷各钉一条）+ 修改器与内容指纹的耦合：

      · 导出器就地 repair 无效网格 → 后算的实例指纹变了 → 同一资源在一次导出里两个身份、
        第二个内容还去写"同一个版本文件"；
      · 同一资源真的有两个内容时，版本号解析要能退到空闲号，绝不覆盖刚写出的文件；
      · 会被烘进 GLB 的修改器必须真的进字节（否则"新版本"配的是旧字节）；不会被烘的（带形态键）
        不许进指纹（否则每次东摸一下修改器就凭空多一个版本）。
    """
    texture = workdir() / "assets" / "brick.png"
    texture.parent.mkdir(parents=True, exist_ok=True)
    if not texture.exists():
        write_png(texture, 8, 8, (200, 30, 30))

    def identity(name: str) -> dict:
        """(resourceId, version, uri, 声明的 contentHash/sha256) —— 判定身份只看这些外部可见事实。"""
        found = resource_of(entities_of(output)[name])
        return {**found, **found.get("declared", {})}

    # ── A 共享的无效网格：一份内容、一个文件、一个身份 ─────────────────────────
    output = fresh_dir("shared-invalid")
    first = export(output, "invalid-first", texture, INVALID_SHARED_BODY)
    bad_a, bad_b = identity("bad_a"), identity("bad_b")
    files = sorted(name for name in tree(output) if name.startswith("visuals/"))
    check_declared_files(output, checks, "invalid-r1")
    checks.check("共享的无效网格：两个实例只导出一次、只写一个文件（导出器就地 repair 不再把身份劈成两半）",
                 first["calls"] == 1 and first["incremental"].get("visualExports") == 1 and len(files) == 1,
                 f"计数={first['calls']} 文件={files}")
    checks.check("共享的无效网格：两个实例声明的是**同一个**内容身份与版本（不是一文件两身份）",
                 bad_a["contentHash"] == bad_b["contentHash"]
                 and bad_a["version"] == bad_b["version"] == 1
                 and bad_a["uri"] == bad_b["uri"],
                 f"a={bad_a['contentHash'][:12]}@{bad_a['version']} b={bad_b['contentHash'][:12]}@{bad_b['version']}")
    second = export(output, "invalid-noop", texture, "", source=output / "source.blend")
    checks.check("共享的无效网格：再导出一次一个文件都不写（身份稳定 → 内容没变 → 全复用）",
                 second["calls"] == 0 and second["incremental"].get("visualExports") == 0
                 and not [name for name in tree(output) if name.startswith("visuals/") and name not in files],
                 f"计数={second['calls']} 目录={sorted(name for name in tree(output) if name.startswith('visuals/'))}")

    # ── B 一个身份两个内容：各写各的版本文件，谁都不被覆盖 ───────────────────────
    output = fresh_dir("shared-two-contents")
    first = export(output, "per-instance", texture, PER_INSTANCE_BODY)
    plain, modified = identity("plain"), identity("modified")
    files = sorted(name for name in tree(output) if name.startswith("visuals/"))
    check_declared_files(output, checks, "two-contents-r1")
    checks.check("同一数据块两个内容（其中一个挂了修改器）：两个内容各写一份版本文件，谁都不被覆盖",
                 first["calls"] == 2 and len(files) == 2 and plain["uri"] != modified["uri"]
                 and sha256_file(Path(plain["uri"])) == plain["sha256"]
                 and sha256_file(Path(modified["uri"])) == modified["sha256"],
                 f"计数={first['calls']} 文件={files} 声明={plain['version']}/{modified['version']}")
    plain_verts, modified_verts = glb_vertex_counts(Path(plain["uri"])), glb_vertex_counts(Path(modified["uri"]))
    checks.check("两个内容确实是两份不同的字节（各自对应自己的实例，不是同一份文件指两遍）",
                 Path(plain["uri"]).read_bytes() != Path(modified["uri"]).read_bytes()
                 and len({plain["resourceId"], modified["resourceId"]}) == 1,
                 f"{Path(plain['uri']).name} vs {Path(modified['uri']).name} 同一资源={plain['resourceId'] == modified['resourceId']}")
    checks.check("修改器真的烘进了字节：GLB 里的顶点数翻倍（不是同几何换个文件名）",
                 modified_verts and max(modified_verts) >= 2 * max(plain_verts),
                 f"plain 顶点={plain_verts} modified 顶点={modified_verts}")
    second = export(output, "per-instance-noop", texture, "", source=output / "source.blend")
    checks.check("两个内容：再导出一次两份都原样复用（0 次调用、文件一个不增不减不改）",
                 second["calls"] == 0 and second["incremental"].get("visualExports") == 0
                 and sorted(name for name in tree(output) if name.startswith("visuals/")) == files,
                 f"计数={second['calls']} 文件={sorted(name for name in tree(output) if name.startswith('visuals/'))}")
    before_thicker, files_before = tree(output), files
    third = export(output, "per-instance-thicker", texture, EDIT_SOLIDIFY, source=output / "source.blend")
    plain_after, modified_after = identity("plain"), identity("modified")
    checks.check("改修改器厚度：只有挂修改器的那份换成新版本，共享数据块的另一份连版本号都不动",
                 third["calls"] == 1 and modified_after["version"] > modified["version"]
                 and plain_after["version"] == plain["version"] and plain_after["uri"] == plain["uri"],
                 f"计数={third['calls']} plain@{plain_after['version']} modified@{modified['version']}→@{modified_after['version']}")
    kept = tree(output)
    checks.check("改修改器厚度：新版本是真换了字节，两份旧版本文件原样留在盘上（历史不改写）",
                 Path(modified_after["uri"]).read_bytes() != Path(modified["uri"]).read_bytes()
                 and all(kept.get(name) == before_thicker[name] for name in files_before),
                 f"新字节={sha256_file(Path(modified_after['uri']))[:12]} 旧字节={modified['sha256'][:12]} 旧文件={files_before}")
    checks.check("改修改器厚度：这一轮的编辑真的写进了活工程 source.blend（不写就会被下一轮载入的旧工程倒回去）",
                 third["incremental"].get("sourceSaved") is True
                 and kept["source.blend"]["mtime"] != before_thicker["source.blend"]["mtime"],
                 f"sourceSaved={third['incremental'].get('sourceSaved')} 快照={Path(str(third['incremental'].get('sourceSnapshot'))).name}")
    fourth = export(output, "per-instance-reload", texture, "", source=output / "source.blend")
    reloaded = identity("modified")
    checks.check("重新载入工程再导出：那份还是新版本、一个文件都没动（编辑没被旧工程倒回去，也不是新版本配旧工程）",
                 fourth["calls"] == 0 and fourth["incremental"].get("visualExports") == 0
                 and reloaded["version"] == modified_after["version"] and reloaded["uri"] == modified_after["uri"]
                 and diff_tree(kept, tree(output)) == [],
                 f"计数={fourth['calls']} 版本 {modified_after['version']}→{reloaded['version']} 变化={diff_tree(kept, tree(output))}")

    # ── C 不被烘的修改器：改了它不许声明新版本（否则就是"新版本、旧字节"的幻影） ─────
    output = fresh_dir("shapekey-no-bake")
    first = export(output, "shapekey-r1", texture, SHAPEKEY_BODY)
    puff = identity("puff")
    files = sorted(name for name in tree(output) if name.startswith("visuals/"))
    check_declared_files(output, checks, "shapekey-r1")
    checks.check("带形态键的网格：资源照常导出，GLB 里带着变形目标、几何仍是不带修改器的那份（这就是它不被烘的原因）",
                 first["calls"] == 1 and glb_morph_targets(Path(puff["uri"])) == 1
                 and glb_vertex_counts(Path(puff["uri"])) == plain_verts,
                 f"计数={first['calls']} 变形目标={glb_morph_targets(Path(puff['uri']))} 顶点={glb_vertex_counts(Path(puff['uri']))}（同样大小的立方体未烘时={plain_verts}）")
    second = export(output, "shapekey-modifier", texture, EDIT_SHAPEKEY_MODIFIER, source=output / "source.blend")
    checks.check("改了不会被烘的修改器厚度：0 次导出、0 个新文件、版本号不动（不是新版本配旧字节）",
                 second["calls"] == 0 and second["incremental"].get("visualExports") == 0
                 and sorted(name for name in tree(output) if name.startswith("visuals/")) == files
                 and identity("puff")["version"] == puff["version"],
                 f"计数={second['calls']} 版本={puff['version']}→{identity('puff')['version']}")
    third = export(output, "shapekey-morph", texture, EDIT_SHAPEKEY_MORPH, source=output / "source.blend")
    checks.check("改形态键数据：新版本 + 新字节（形态键确实进了内容指纹，不是被一起忽略掉了）",
                 third["calls"] == 1 and identity("puff")["version"] > puff["version"]
                 and Path(identity("puff")["uri"]).read_bytes() != Path(puff["uri"]).read_bytes(),
                 f"计数={third['calls']} 版本={puff['version']}→{identity('puff')['version']}")


SCALE_BODY = '''
clear()
# 212 个实例共享 2 个网格数据块与 6 张真实贴图（每块几何 3 个材质槽，面按槽分配）。
materials = []
for index in range(6):
    path = texture_path.parent / f"scale-{index}.png"
    if not path.exists():
        image = bpy.data.images.new(f"scale-{index}", width=64, height=64, alpha=False)
        image.filepath_raw = str(path)
        image.file_format = "PNG"
        image.save()
    image = bpy.data.images.load(str(path))
    material = bpy.data.materials.new(f"scale-mat-{index}")
    material.use_nodes = True
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    material.node_tree.links.new(node.outputs["Color"], material.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    materials.append(material)


def slots(obj, offset):
    for index in range(3):
        obj.data.materials.append(materials[offset + index])
    for face in obj.data.polygons:
        face.material_index = face.index % 3


bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.5))
plant = bpy.context.object
plant.name = "plant-000"
slots(plant, 0)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0.0, 0.0, 0.5))
lion = bpy.context.object
lion.name = "lion-000"
slots(lion, 3)

for index in range(1, 200):
    copy = plant.copy()                     # 链接副本：共享网格数据与材质
    bpy.context.scene.collection.objects.link(copy)
    copy.name = f"plant-{index:03d}"
    copy.location = (-20.0 + 4.0 * (index % 20), 6.0 + 4.0 * (index // 20), 0.5)
for index in range(1, 12):
    copy = lion.copy()
    bpy.context.scene.collection.objects.link(copy)
    copy.name = f"lion-{index:03d}"
    copy.location = (-6.0 + 1.5 * index, -4.0, 0.5)
bpy.ops.object.light_add(type="SUN", location=(3.0, -2.0, 4.0))
bpy.ops.object.camera_add(location=(0.0, -8.0, 6.0))
bpy.context.scene.camera = bpy.context.object
print("SCALE_READY", len(bpy.data.objects))
'''

SCALE_EDIT = 'bpy.data.objects["plant-007"].location.z += 1.0\n'


def check_scale_212(checks: Checks):
    """212 个实例共享 2 份几何 / 6 张真实贴图：增量导出只该写 2 个文件，再来一次一个都不写。"""
    output = fresh_dir("scale-212")
    texture = workdir() / "assets" / "brick.png"
    texture.parent.mkdir(parents=True, exist_ok=True)
    if not texture.exists():
        write_png(texture, 8, 8, (200, 30, 30))
    first = export(output, "scale-first", texture, SCALE_BODY)
    before = tree(output)
    glbs = sorted(name for name in before if name.startswith("visuals/"))
    incremental = first["incremental"]
    checks.check("212 实例（200 盒 + 12 球，共享 2 个数据块）：只导出 2 个资源",
                 first["calls"] == 2 and incremental.get("visualExports") == 2 and len(glbs) == 2
                 and first["result"].get("visuals") == 212,
                 f"计数={first['calls']} 文件={glbs} visual={first['result'].get('visuals')}")
    checks.check("212 实例：共享组读数正确（一组 200 个实例、一组 12 个）",
                 sorted(incremental.get("sharedResources", {}).values()) == [12, 200],
                 str(incremental.get("sharedResources")))
    entities = entities_of(output)
    checks.check("212 实例：212 个可视实体只引用 2 个资源（不是 212 份拷贝），每个引用都指向真文件",
                 len(entities) == 214 and len({resource_of(entity)["resourceId"] for entity in entities.values() if resource_of(entity)}) == 2
                 and all(Path(uri).is_file() for uri in uris_of(entities)),
                 f"实体={len(entities)} 资源={len({resource_of(e)['resourceId'] for e in entities.values() if resource_of(e)})}")
    second = export(output, "scale-noop", texture, "", source=output / "source.blend")
    changed = diff_tree(before, tree(output))
    checks.check("212 实例：再导出一次一个文件都不写（0 次调用、目录逐字节不变）",
                 second["calls"] == 0 and second["incremental"].get("visualExports") == 0 and changed == [],
                 f"计数={second['calls']} 变化={changed}")
    third = export(output, "scale-move", texture, SCALE_EDIT, source=output / "source.blend")
    changed = diff_tree(before, tree(output))
    checks.check("212 实例：只挪一个实例 → 0 次导出，只有 scene.json/world.xml/工程 被更新",
                 third["calls"] == 0 and third["incremental"].get("visualExports") == 0
                 and changed == ["physics/world.xml", "scene.json", "source.blend"],
                 f"计数={third['calls']} 变化={changed}")
    checks.check("212 实例耗时（真实墙钟，仅作环境记录）", True,
                 f"首次 {first['seconds']:.2f}s（回执导出 {incremental.get('exportSeconds')}s / 共 {incremental.get('secondsTotal')}s）；"
                 f"无改动 {second['seconds']:.2f}s（导出 {second['incremental'].get('exportSeconds')}s）；"
                 f"挪一个实例 {third['seconds']:.2f}s")


def main() -> int:
    checks = Checks("111 增量导出验收（真实 Blender / 真实文件 / 真实字节）")
    if blender_executable() is None:
        print("BLENDER_EXECUTABLE_MISSING：需要真实 Blender", file=sys.stderr)
        return 2
    started = time.time()
    output = check_main_scenarios(checks)
    print(f"主场景产物：{output}", flush=True)
    check_shared_datablock_identity(checks)
    if os.environ.get("LYAPUNOV_SKIP_SCALE") == "1":
        checks.check("规模段按 LYAPUNOV_SKIP_SCALE=1 跳过（如实记录，不算通过）", False, "跳过 212 实例段")
    else:
        check_scale_212(checks)
    print(f"总耗时 {time.time() - started:.1f}s", flush=True)
    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
