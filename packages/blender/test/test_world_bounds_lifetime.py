"""评估网格的有效期测试：`evaluated_local_bounds` 必须在临时网格**有效期内**读完极值。

背景（本体审出的缺陷）：旧写法把 `points=[vertex.co for vertex in mesh.vertices]` 存下来，`finally`
里 `to_mesh_clear()` 释放临时网格，**之后**才 min/max——这是在释放后读 RNA 包装引用，读数是否有效
只取决于那块内存有没有被复用。本测试用真实 Blender 做两件事：

  1. **实现验收**：在真实修改器评估（Solidify/Subsurf/Array/Bevel）下，反复"评估→释放→另外分配"
     搅动网格内存，每一轮都把受测实现的读数与**施工现场在有效期内量出来的真值**对比；
  2. **对照与复现**：同一轮里跑一遍旧写法的形状，并把"释放后仍持有的包装引用"在 ①刚释放 ②同规模
     网格重新分配之后 分别读一次，如实记录本机到底发生什么（报错/读到别人的数据/侥幸没变），
     不据此伪造结论——旧写法即便这次侥幸读对，也只是内存没被立刻复用。

跑法：`python3 packages/blender/test/test_world_bounds_lifetime.py`（环境变量见 test_world_harness.py）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_world_harness import Checks, blender_executable, fresh_dir, run_world, write_script  # noqa: E402

WORLD_SCRIPT = str(Path(__file__).resolve().parent.parent / "src" / "world.py")

SCENE_TEMPLATE = '''"""测试场景：真实修改器 + 真实内存搅动，量受测实现与旧写法在"释放临时网格"前后的读数。"""
import bpy, json, random, runpy
from mathutils import Vector
from pathlib import Path

world = runpy.run_path(r"{world_path}")
evaluated_local_bounds = world["evaluated_local_bounds"]

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def cube(name, size, offset=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    for vertex in obj.data.vertices:
        vertex.co = Vector((vertex.co.x * size[0] + offset[0], vertex.co.y * size[1] + offset[1], vertex.co.z * size[2] + offset[2]))
    return obj


def bounds_of(points):
    low = [min(point[axis] for point in points) for axis in range(3)]
    high = [max(point[axis] for point in points) for axis in range(3)]
    return {"center": [(low[axis] + high[axis]) / 2.0 for axis in range(3)], "size": [high[axis] - low[axis] for axis in range(3)]}


def live_bounds(obj):
    """真值：在临时网格**有效期内**用普通 float 量出来（测试自己的实现，不调受测函数）。"""
    dependency = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(dependency)
    mesh = evaluated.to_mesh()
    try:
        low = [float("inf")] * 3
        high = [float("-inf")] * 3
        for vertex in mesh.vertices:
            for axis in range(3):
                value = float(vertex.co[axis])
                low[axis] = min(low[axis], value)
                high[axis] = max(high[axis], value)
        count = len(mesh.vertices)
    finally:
        evaluated.to_mesh_clear()
    return {"center": [(low[axis] + high[axis]) / 2.0 for axis in range(3)], "size": [high[axis] - low[axis] for axis in range(3)], "vertices": count}


def legacy_bounds(obj):
    """修前形状（逐字保留）：points 是 RNA 包装引用，释放临时网格之后才 min/max。"""
    dependency = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(dependency)
    mesh = evaluated.to_mesh()
    try:
        points = [vertex.co for vertex in mesh.vertices]
    finally:
        evaluated.to_mesh_clear()
    if not points:
        return None
    low = [min(point[axis] for point in points) for axis in range(3)]
    high = [max(point[axis] for point in points) for axis in range(3)]
    return {"center": [(low[axis] + high[axis]) / 2.0 for axis in range(3)], "size": [high[axis] - low[axis] for axis in range(3)]}


def raw_size(obj):
    coords = [vertex.co for vertex in obj.data.vertices]
    return [round(max(point[axis] for point in coords) - min(point[axis] for point in coords), 6) for axis in range(3)]


def deviation(first, second):
    return max(abs(first[key][axis] - second[key][axis]) for key in ("center", "size") for axis in range(3))


def read_wrapper(value):
    try:
        return {"value": [float(value[axis]) for axis in range(3)]}
    except Exception as error:
        return {"error": type(error).__name__ + ": " + str(error)}


# ── 真实修改器：四个对象的评估后几何都不同于原始 data ────────────────────────────
slab = cube("thick_slab", (0.5, 0.5, 0.5))
solidify = slab.modifiers.new(name="thicken", type="SOLIDIFY")
solidify.thickness = 0.2
solidify.offset = 0.0
smooth = cube("subdivided_offset", (0.4, 0.6, 0.8), offset=(3.0, 1.0, -2.0))
subsurf = smooth.modifiers.new(name="smooth", type="SUBSURF")
subsurf.levels = 2
subsurf.render_levels = 2
arrayed = cube("arrayed_steps", (0.2, 0.2, 0.2))
array = arrayed.modifiers.new(name="repeat", type="ARRAY")
array.count = 5
array.relative_offset_displace = (1.0, 0.0, 0.0)
beveled = cube("beveled_wall", (0.3, 0.7, 0.5), offset=(-1.0, 2.0, 0.25))
bevel = beveled.modifiers.new(name="round", type="BEVEL")
bevel.width = 0.05
bevel.segments = 2
cases = [("thick_slab", slab), ("subdivided_offset", smooth), ("arrayed_steps", arrayed), ("beveled_wall", beveled)]
for name, obj in cases:
    obj["lyapunov_shape"] = "box"
    obj["lyapunov_size"] = list(raw_size(obj))
bpy.context.view_layer.update()

report = {"cases": {}, "churn": {"iterations": 0, "calls": 0, "implementationFailures": [], "legacyDeviations": [], "legacyErrors": [],
                                 "implementationMaxDeviation": 0.0, "legacyMaxDeviation": 0.0, "junkMeshes": 0},
          "retained": {}, "export": {}}
for name, obj in cases:
    reference = live_bounds(obj)
    report["cases"][name] = {"reference": reference, "rawSize": raw_size(obj), "modifiers": [modifier.name for modifier in obj.modifiers],
                             "evaluatedDiffersFromRaw": any(abs(reference["size"][axis] - raw_size(obj)[axis]) > 1e-6 for axis in range(3))}

# ── 搅动：评估→释放→另外分配，每轮都用施工现场真值核对受测实现 ────────────────────
random.seed(20260920)
ITERATIONS = 40
for index in range(ITERATIONS):
    junk = []
    for step in range(6):
        junk.append(cube("junk_%d_%d" % (index, step), (0.1 + 0.07 * index % 1.3, 0.2 + 0.05 * step, 0.3 + 0.03 * index % 1.1), offset=(index * 0.11, step * 0.07, -index * 0.05)))
    for item in junk:  # 评估并释放一批别的临时网格：新分配有大概率落在刚释放的块上
        live_bounds(item)
    for name, obj in cases:
        reference = report["cases"][name]["reference"]
        try:
            measured = evaluated_local_bounds(obj)
        except Exception as error:
            report["churn"]["implementationFailures"].append({"case": name, "iteration": index, "error": type(error).__name__ + ": " + str(error)})
            measured = None
        if measured is not None:
            deviation_value = deviation(measured, reference)
            report["churn"]["implementationMaxDeviation"] = max(report["churn"]["implementationMaxDeviation"], deviation_value)
            if deviation_value > 1e-9:
                report["churn"]["implementationFailures"].append({"case": name, "iteration": index, "deviation": deviation_value, "measured": measured, "reference": reference})
        try:
            legacy = legacy_bounds(obj)
            legacy_value = deviation(legacy, reference) if legacy else 0.0
            report["churn"]["legacyMaxDeviation"] = max(report["churn"]["legacyMaxDeviation"], legacy_value)
            if legacy_value > 1e-9:
                report["churn"]["legacyDeviations"].append({"case": name, "iteration": index, "deviation": legacy_value, "legacy": legacy, "reference": reference})
        except Exception as error:
            report["churn"]["legacyErrors"].append({"case": name, "iteration": index, "error": type(error).__name__ + ": " + str(error)})
    report["churn"]["iterations"] = index + 1
    report["churn"]["calls"] += len(cases)
    report["churn"]["junkMeshes"] += len(junk)
    for item in junk:
        data = item.data
        bpy.data.objects.remove(item, do_unlink=True)
        if data.users == 0:
            bpy.data.meshes.remove(data)

# ── 释放后仍持有的包装引用：①刚释放 ②同规模网格重新分配之后（连续三次），各读一次 ──────
first = cube("retained_source", (1.0, 1.0, 1.0))
bpy.context.view_layer.update()
dependency = bpy.context.evaluated_depsgraph_get()
mesh = first.evaluated_get(dependency).to_mesh()
held = [vertex.co for vertex in mesh.vertices]
report["retained"]["vertices"] = len(held)
report["retained"]["beforeClear"] = read_wrapper(held[0])
first.evaluated_get(dependency).to_mesh_clear()
report["retained"]["afterClear"] = read_wrapper(held[0])
report["retained"]["reads"] = []
for step in (1, 2, 3):
    probe = cube("retained_reuse_%d" % step, (1.0, 1.0, 1.0), offset=(100.0 * step, 200.0 * step, 300.0 * step))
    bpy.context.view_layer.update()
    evaluation = bpy.context.evaluated_depsgraph_get()
    probe_mesh = probe.evaluated_get(evaluation).to_mesh()  # 同顶点数：最可能复用刚释放的那块
    report["retained"]["reads"].append({"step": step, "expected": [round(float(probe_mesh.vertices[0].co[axis]), 6) for axis in range(3)],
                                        "read": read_wrapper(held[0])})
    probe.evaluated_get(evaluation).to_mesh_clear()
report["retained"]["afterAll"] = read_wrapper(held[-1])

# ── 产品路径：同一批对象在**这轮搅动之后**由 world.py 自己真实导出（--operation export），
# 导出的 collision 必须等于现场真值。这里只落盘现场读数，导出产物由测试在外面核对。 ──
Path(r"{report_path}").write_text(json.dumps(report, ensure_ascii=False, indent=1))
'''


def main() -> int:
    checks = Checks("ENV-36 评估网格有效期（真实 Blender）")
    executable = blender_executable()
    if executable is None:
        return checks.blocked_on("找不到真实 Blender 可执行文件（BLENDER_EXECUTABLE）")
    output = fresh_dir("bounds-lifetime")
    script = write_script(f"bounds-lifetime-{output.name}.py", SCENE_TEMPLATE.replace("{world_path}", WORLD_SCRIPT)
                          .replace("{report_path}", str(output / "lifetime.json")))
    run = run_world(["--operation", "export", "--output", str(output)], scene_script=script)
    checks.check("真实 Blender 干净退出（exit 0 且无异常堆栈）", run.clean, f"exit={run.code} tail={run.tail()}")
    if not run.clean:
        checks.check("拿到搅动/导出读数", False, "Blender 未干净结束")
        return checks.finish()

    report = json.loads((output / "lifetime.json").read_text())
    churn, cases = report["churn"], report["cases"]

    differs = {name: item["evaluatedDiffersFromRaw"] for name, item in cases.items()}
    checks.check("真实修改器确实在改几何：四个对象的评估后包围盒至少 3 个不同于原始 data（否则搅动没意义）",
                 sum(differs.values()) >= 3,
                 "; ".join(f"{name} 评估={[round(v, 6) for v in item['reference']['size']]} 原始={item['rawSize']} 顶数={item['reference']['vertices']}"
                           for name, item in cases.items()))

    checks.check("受测实现：每轮搅动后的读数都与施工现场在有效期内量出的真值一致（无异常、无偏差）",
                 not churn["implementationFailures"] and churn["implementationMaxDeviation"] < 1e-9 and churn["calls"] >= 160,
                 f"轮数={churn['iterations']} 调用={churn['calls']} 另外分配/释放网格={churn['junkMeshes']} 个 "
                 f"最大偏差={churn['implementationMaxDeviation']:.3e} m 失败={churn['implementationFailures'][:2]}")

    def describe(item):
        return "报错 " + item["error"] if "error" in item else [round(value, 3) for value in item["value"]]

    retained = report["retained"]
    inside = retained["beforeClear"]
    checks.check("旧写法读到的包装引用：有效期内的读数是真值（源立方体顶点 ±0.5）；释放后的读数序列见 detail",
                 "value" in inside and max(abs(value) for value in inside["value"]) == 0.5,
                 f"beforeClear={describe(inside)} sourceVertices={retained['vertices']}；afterClear={describe(retained['afterClear'])}；"
                 + "; ".join(f"另分配第 {item['step']} 个同规模网格（其首顶点={item['expected']}）后 held[0]={describe(item['read'])}"
                             for item in retained["reads"])
                 + f"；最后 afterAll={describe(retained['afterAll'])}")
    checks.check(f"旧写法对照：同一批搅动 {churn['calls']} 次调用的实测读数已记录（不做通过判定——释放后读属于未定义行为，读对也不能依赖）",
                 True,
                 f"偏差>1e-9 的次数={len(churn['legacyDeviations'])} 报错={len(churn['legacyErrors'])} 最大偏差={churn['legacyMaxDeviation']:.3e} m")

    # ── 产品路径：报告里的现场真值 vs world.py 自己导出的 scene.json ─────────────
    snapshot = json.loads((output / "scene.json").read_text())
    collision = {entity["name"]: entity["components"]["collision"] for entity in snapshot["entities"] if "collision" in entity["components"]}
    compared, worst, missing = 0, 0.0, []
    for name in cases:
        exported = collision.get(name)
        if exported is None:
            missing.append(name)
            continue
        reference = cases[name]["reference"]
        worst = max(worst, max(abs(exported["center"][axis] - reference["center"][axis]) for axis in range(3)),
                    max(abs(exported["sizeM"][axis] - reference["size"][axis]) for axis in range(3)))
        compared += 1
    checks.check("产品路径：同一批带修改器的对象真实导出，scene.json 的 center/sizeM 与现场真值一致（6 位小数内）",
                 not missing and compared == len(cases) and worst < 1e-5,
                 f"对比 {compared} 个，缺失={missing}，最大偏差={worst:.3e} m，"
                 + "; ".join(f"{name} modifiers={collision[name].get('evaluatedModifiers')}" for name in cases if name in collision))
    stale = [name for name in cases if cases[name]["evaluatedDiffersFromRaw"]]
    checks.check("修改器改了形状的实体：导出以评估后几何为准，并把对不上的 lyapunov_size 记进 declaredSizeM（不改工程）",
                 all(collision.get(name, {}).get("boxSource") == "geometry-local-bounds"
                     and "declaredSizeM" in collision.get(name, {}) for name in stale),
                 "; ".join(f"{name} 声明={collision[name].get('declaredSizeM')} 实测={collision[name].get('sizeM')} 原始={cases[name]['rawSize']}"
                           for name in stale))
    result = run.result or {}
    checks.check("导出回执：这批可精确表示的位形没有任何 loss（表示不了的位形才允许有）",
                 result.get("collisionApproximations") == [] and not any(collision[name].get("losses") for name in collision),
                 f"collisionApproximations={result.get('collisionApproximations')}")
    print(f"产物：{output}", flush=True)
    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
