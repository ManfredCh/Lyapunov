"""ENV-22 的 Python 合同在真实 Blender 上的行为测试：build / preview / export 可分开。

验收点与对应检查：
  · CLI 默认 operation=build，且原有构造/材质/导出/可选 render 与既有产物形状不变；
  · preview **不调用 export_world**：不写 scene.json/GLB/source.blend，也不递增资源版本；
  · export 只导出，不隐式渲染；
  · 机位名/分辨率/采样三个参数真实生效（PNG 头里的像素尺寸是硬读数）；
  · 缺图（渲染没产出/是空文件/不是 PNG）**不能**算成功；
  · 写错的参数在动场景之前就失败。

每条都由独立 `blender --background` 进程跑真实 `packages/blender/src/world.py`，读数来自结果行与磁盘产物。
跑法：`python3 packages/blender/test/test_world_operations.py`（详见 test_world_harness.py 的环境变量说明）。
"""
from __future__ import annotations

import hashlib
import json
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_world_harness import (  # noqa: E402
    Checks, all_pngs, blender_executable, entity_map, fresh_dir, glb_paths, file_bytes,
    png_facts, result_prefix, run_world, scene_facts, write_png, write_script,
)

# `--fixture` 的当前形状（本仓库实测读数，用作回归钉子：无意改变实体/可视数量会在这里暴露）。
FIXTURE_ENTITIES = 19
FIXTURE_VISUALS = 14
FIXTURE_GLBS = 14


def command(run) -> str:
    return " ".join(shlex.quote(item) for item in run.argv)


def snapshot(output) -> dict:
    """一个输出目录的可核对状态：导出产物字节 + 可视 GLB 清单 + 全部 PNG。"""
    return {
        "scene": file_bytes(output / "scene.json"),
        "blend": file_bytes(output / "source.blend"),
        "physics": file_bytes(output / "physics" / "world.xml"),
        "glbs": glb_paths(output),
        "pngs": all_pngs(output),
    }


def check_default_operation_is_build(checks: Checks):
    """不带 --operation 时就是 build：构造 + 导出 + 可选渲染，结果键与既有消费方一致。"""
    output = fresh_dir("op-build")
    run = run_world(["--fixture", "--output", output])
    checks.check("build 默认 operation 干净退出（exit 0 且无异常堆栈）", run.clean, f"cmd={command(run)} exit={run.code} tail={run.tail()}")
    result = run.result or {}
    checks.check("结果行来自 plugin.ts 定义的前缀", run.result is not None and f"{result_prefix()}{{" in run.stdout, f"prefix={result_prefix()}")
    checks.check("默认 operation=build", result.get("operation") == "build", str(result.get("operation")))
    legacy_keys = {"source", "scene", "entities", "visuals", "physics", "resourceNamespace", "resourceVersion"}
    checks.check("既有结果键仍在（plugin.ts 不传新参数也照旧工作）", legacy_keys <= set(result), str(sorted(set(result))))
    checks.check("导出产物齐备", (output / "source.blend").is_file() and (output / "scene.json").is_file()
                  and (output / "physics" / "world.xml").is_file(), f"visuals 目录 {len(glb_paths(output))} 个 GLB")
    checks.check("实体/可视数量与该夹具既有形状一致",
                 result.get("entities") == FIXTURE_ENTITIES and result.get("visuals") == FIXTURE_VISUALS
                 and len(glb_paths(output)) == FIXTURE_GLBS,
                 f"entities={result.get('entities')} visuals={result.get('visuals')} glb={len(glb_paths(output))}")
    checks.check("build 未请求渲染时不留图", result.get("preview") is None and result.get("render") is None
                 and all_pngs(output) == [], f"png={all_pngs(output)}")
    entities = json.loads((output / "scene.json").read_text())["entities"]
    checks.check("scene.json 实体数与结果行一致、且父子引用都能解析",
                 len(entities) == result.get("entities") and all(name in entity_map({"entities": entities}) for name in
                 [item["parentId"] for item in entities if item.get("parentId")]),
                 f"scene.json={len(entities)} 结果行={result.get('entities')} 悬空 parentId="
                 f"{[item['parentId'] for item in entities if item.get('parentId') and item['parentId'] not in entity_map({'entities': entities})]}")
    return output, result


def check_export_does_not_render(checks: Checks):
    """export 只导出：没有任何 PNG、结果里没有渲染字段，但导出产物与 build 一样。"""
    output = fresh_dir("op-export")
    run = run_world(["--fixture", "--operation", "export", "--output", output])
    checks.check("export 干净退出（exit 0 且无异常堆栈）", run.clean, f"cmd={command(run)} exit={run.code} tail={run.tail()}")
    result = run.result or {}
    checks.check("operation=export 且 exported=true", result.get("operation") == "export" and result.get("exported") is True,
                 f"operation={result.get('operation')} exported={result.get('exported')}")
    checks.check("export 不隐式渲染：输出目录里没有任何 PNG", all_pngs(output) == [], f"png={all_pngs(output)}")
    checks.check("export 结果里没有渲染字段", "preview" not in result and "render" not in result and "cameras" not in result,
                 str(sorted(result)))
    checks.check("export 的导出产物与 build 相同口径",
                 (output / "source.blend").is_file() and len(glb_paths(output)) == result.get("visuals"),
                 f"visuals={result.get('visuals')} glb={len(glb_paths(output))}")


def check_preview_does_not_export_or_bump_version(checks: Checks):
    """preview 只渲染：工程与导出产物一个字节都不动，资源版本不涨；随后没改的 export 也不涨、不重导出。"""
    output = fresh_dir("op-preview")
    build = run_world(["--fixture", "--output", output])
    before = snapshot(output)
    checks.check("前置 build 成功（供预览的真实工程）", build.clean and bool(before["scene"] and before["blend"]),
                 f"exit={build.code} glb={len(before['glbs'])}")

    # 预览的是**已保存的工程**：这条路径正是"局部预览不全量导出"要证明的东西。
    preview = run_world(["--operation", "preview", "--cameras", '["preview_camera"]',
                         "--resolution", "[160,120]", "--samples", "2", "--output", output],
                        source_blend=output / "source.blend")
    checks.check("preview 干净退出（exit 0 且无异常堆栈）", preview.clean, f"cmd={command(preview)} exit={preview.code} tail={preview.tail()}")
    result = preview.result or {}
    checks.check("preview 结果自述未导出", result.get("operation") == "preview" and result.get("exported") is False
                 and "scene" not in result and "source" not in result, str(sorted(result)))
    after = snapshot(output)
    checks.check("preview 不调用 export_world：scene.json/source.blend/world.xml 字节不变",
                 after["scene"] == before["scene"] and after["blend"] == before["blend"] and after["physics"] == before["physics"],
                 f"scene={len(after['scene'])}B blend={len(after['blend'])}B physics={len(after['physics'])}B")
    checks.check("preview 不写新 GLB", after["glbs"] == before["glbs"], f"glb={len(before['glbs'])}→{len(after['glbs'])}")
    added = sorted(set(after["pngs"]) - set(before["pngs"]))
    checks.check("preview 只新增渲染图", added == ["renders/preview_camera.png"], f"新增={added}")
    preview_path = output / "renders" / "preview_camera.png"
    facts = png_facts(preview_path) if preview_path.is_file() else {}
    checks.check("预览图是真实 PNG 且分辨率按 --resolution 生效",
                 bool(facts) and facts.get("width") == 160 and facts.get("height") == 120 and facts.get("bytes", 0) > 1000,
                 f"{facts} 结果行 preview={result.get('preview')}")
    checks.check("结果行给的 preview 路径就是这张图", str(preview_path) == result.get("preview"), str(result.get("preview")))
    props = scene_facts(output / "source.blend")
    checks.check("重开工程：资源版本仍是 1（preview 没有递增）",
                 props.get("_sceneProps", {}).get("lyapunov_export_version") == 1,
                 f"lyapunov_export_version={props.get('_sceneProps', {}).get('lyapunov_export_version')}")

    export_again = run_world(["--operation", "export", "--output", output], source_blend=output / "source.blend")
    again = export_again.result or {}
    again_incremental = again.get("incremental") or {}
    after_export = snapshot(output)
    checks.check("随后 export 干干净净退出且 namespace 与 build 相同",
                 export_again.clean and again.get("resourceNamespace") == build.result.get("resourceNamespace"),
                 f"exit={export_again.code} namespace 相同={again.get('resourceNamespace') == build.result.get('resourceNamespace')}")
    checks.check("什么都没改的 export 不占新版本号（revision 仍是 1，与 scene.json 一致）",
                 again.get("resourceVersion") == 1 and again.get("revision") == 1,
                 f"resourceVersion={again.get('resourceVersion')} revision={again.get('revision')}")
    checks.check("这次 export 一次导出调用都没有（全部复用既有 GLB）",
                 again_incremental.get("visualExports") == 0 and again_incremental.get("visualReused") == FIXTURE_GLBS
                 and again_incremental.get("bytesExported") == 0,
                 f"visualExports={again_incremental.get('visualExports')} visualReused={again_incremental.get('visualReused')}")
    checks.check("未改的产物字节不变：scene.json/source.blend/world.xml 与预览前逐字节相同",
                 after_export["scene"] == after["scene"] and after_export["blend"] == after["blend"]
                 and after_export["physics"] == after["physics"] and after_export["glbs"] == after["glbs"],
                 f"scene 变化={after_export['scene'] != after['scene']} blend 变化={after_export['blend'] != after['blend']} "
                 f"glb={len(after['glbs'])}→{len(after_export['glbs'])}")


def check_preview_requires_real_camera(checks: Checks):
    """没有相机就不能成功：preview 不允许用"没图"冒充完成。"""
    output = fresh_dir("op-nocamera")
    scene_script = write_script("empty-scene.py", "import bpy\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\n")
    run = run_world(["--operation", "preview", "--output", output], scene_script=scene_script)
    message = run.stdout + run.stderr
    checks.check("无相机时 preview 非零退出", run.code != 0, f"exit={run.code} tail={run.tail()}")
    checks.check("失败原因明确（BLENDER_CAMERA_MISSING）", "BLENDER_CAMERA_MISSING" in message, message.strip().splitlines()[-1][:200] if message.strip() else "无输出")
    checks.check("无相机时不写任何图、也不打印成功结果行", all_pngs(output) == [] and run.result is None,
                 f"png={all_pngs(output)} result={run.result}")


def check_named_cameras_must_exist(checks: Checks):
    """--cameras 点名不存在的对象、或点到非相机对象，都要当场失败而不是换机位。"""
    output_missing = fresh_dir("op-cam-missing")
    run_missing = run_world(["--fixture", "--operation", "preview", "--cameras", '["does_not_exist"]', "--output", output_missing])
    checks.check("机位名不存在 → 非零退出 + BLENDER_CAMERA_MISSING",
                 run_missing.code != 0 and "BLENDER_CAMERA_MISSING" in (run_missing.stdout + run_missing.stderr),
                 f"exit={run_missing.code} tail={run_missing.tail()}")
    output_not_camera = fresh_dir("op-cam-not-camera")
    run_not_camera = run_world(["--fixture", "--operation", "preview", "--cameras", '["cube"]', "--output", output_not_camera])
    checks.check("点到非相机对象 → 非零退出 + BLENDER_CAMERA_NOT_CAMERA",
                 run_not_camera.code != 0 and "BLENDER_CAMERA_NOT_CAMERA" in (run_not_camera.stdout + run_not_camera.stderr),
                 f"exit={run_not_camera.code} tail={run_not_camera.tail()}")
    checks.check("点名失败时不产出任何图", all_pngs(output_missing) == [] and all_pngs(output_not_camera) == [],
                 f"{all_pngs(output_missing)} / {all_pngs(output_not_camera)}")


def check_multi_camera_report(checks: Checks):
    """多机位：真实路径 + 机位元数据（世界位姿/光学参数），并核对确实是两个不同视角。"""
    output = fresh_dir("op-multicam")
    run = run_world(["--architecture", "--operation", "preview",
                     "--cameras", '["exterior_camera","courtyard_camera"]',
                     "--resolution", "[160,120]", "--samples", "1", "--output", output])
    checks.check("多机位 preview 干净退出（exit 0 且无异常堆栈）", run.clean, f"cmd={command(run)} exit={run.code} tail={run.tail()}")
    result = run.result or {}
    cameras = result.get("cameras") or []
    exterior, courtyard = output / "renders" / "exterior_camera.png", output / "renders" / "courtyard_camera.png"
    checks.check("两个机位各写一张真实 PNG", exterior.is_file() and courtyard.is_file()
                 and png_facts(exterior)["width"] == 160 and png_facts(courtyard)["width"] == 160,
                 f"{png_facts(exterior) if exterior.is_file() else '缺 exterior'} / {png_facts(courtyard) if courtyard.is_file() else '缺 courtyard'}")
    checks.check("preview 取第一张、extraRenders 列其余",
                 result.get("preview") == str(exterior) and result.get("extraRenders") == [str(courtyard)],
                 f"preview={result.get('preview')} extraRenders={result.get('extraRenders')}")
    checks.check("机位元数据条数与机位一致", len(cameras) == 2 and [item.get("name") for item in cameras] == ["exterior_camera", "courtyard_camera"],
                 str([item.get("name") for item in cameras]))
    checks.check("机位位姿与源工程一致（位置/镜头/视场）",
                 cameras and cameras[0].get("position") == [11.0, -13.0, 9.0] and cameras[0].get("lensMm") == 28.0
                 and cameras[1].get("position") == [0.0, -7.0, 3.0] and cameras[1].get("lensMm") == 24.0
                 and cameras[1].get("fovYDeg", 0) > 0,
                 f"{cameras[0].get('position') if cameras else None} lens={cameras[0].get('lensMm') if cameras else None} / "
                 f"{cameras[1].get('position') if len(cameras) > 1 else None} lens={cameras[1].get('lensMm') if len(cameras) > 1 else None}")
    checks.check("机位朝向是单位向量（可用来复现视角）",
                 all(abs(sum(value * value for value in item.get("direction", [])) ** 0.5 - 1.0) < 1e-3 for item in cameras),
                 str([item.get("direction") for item in cameras]))
    checks.check("激活机位按渲染前的场景状态标注",
                 cameras and cameras[0].get("isActive") is True and cameras[1].get("isActive") is False,
                 f"{[item.get('isActive') for item in cameras]}")
    checks.check("结果行如实回报实际生效的渲染设置",
                 (result.get("render") or {}).get("resolution") == [160, 120] and (result.get("render") or {}).get("samples") == 1
                 and (result.get("render") or {}).get("mode") == "multi-camera" and result.get("renderMode") == "multi-camera",
                 str(result.get("render")))
    digests = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (exterior, courtyard)]
    checks.check("两个机位不是同一张图（确实是两个视角）", len(set(digests)) == 2, f"sha256={[value[:12] for value in digests]}")


def check_single_camera_keeps_legacy_preview_path(checks: Checks):
    """不给 --cameras 时沿用既有 <output>/preview.png 约定（既有日志与消费方按这个路径找图）。"""
    output = fresh_dir("op-legacy-render")
    run = run_world(["--fixture", "--render", "--resolution", "[128,96]", "--samples", "2", "--output", output])
    result = run.result or {}
    legacy = output / "preview.png"
    checks.check("build --render 干净退出且仍写 <output>/preview.png",
                 run.clean and legacy.is_file() and result.get("preview") == str(legacy),
                 f"exit={run.code} preview={result.get('preview')} tail={run.tail()}")
    checks.check("结果行保留 renderMode 字段", result.get("renderMode") == "single-frame" and result.get("extraRenders") == [],
                 f"renderMode={result.get('renderMode')} extraRenders={result.get('extraRenders')}")
    facts = png_facts(legacy) if legacy.is_file() else {}
    render = result.get("render") or {}
    checks.check("--resolution/--samples 在既有渲染路径上同样生效",
                 facts.get("width") == 128 and facts.get("height") == 96 and render.get("samples") == 2
                 and render.get("engine") == "CYCLES" and render.get("samplesTarget") == "cycles.samples",
                 f"{facts} render={render}")


def check_invalid_arguments_are_rejected(checks: Checks):
    """写错的参数在动场景之前失败：非零退出、不留导出产物。"""
    cases = [
        ("--cameras", "not json"),
        ("--cameras", '{"exterior_camera": 1}'),
        ("--cameras", "[]"),
        ("--cameras", '["preview_camera","preview_camera"]'),
        ("--cameras", "[1,2]"),
        ("--resolution", "[100]"),
        ("--resolution", "[100,0]"),
        ("--resolution", '["100","200"]'),
        ("--samples", "0"),
        ("--samples", "-5"),
        ("--samples", "abc"),
    ]
    failures = []
    for flag, value in cases:
        output = fresh_dir("op-bad-args")
        run = run_world(["--fixture", "--operation", "build", flag, value, "--output", output])
        rejected = run.code != 0 and not (output / "scene.json").exists() and run.result is None
        if not rejected:
            failures.append(f"{flag} {value} → exit={run.code} scene.json={(output / 'scene.json').exists()}")
    checks.check("11 组非法参数全部被拒（含空数组/重复名/零分辨率/非正采样）", not failures, "; ".join(failures) or f"{len(cases)}/{len(cases)} 拒绝且未写产物")


def check_missing_image_cannot_succeed(checks: Checks):
    """正式路径上放不下本轮图时整个操作必须失败：不许用 null/空路径冒充"看过图"。

    本轮图先写暂存、校验通过才顶替正式路径，所以这条现在压在**顶替**这一步上：
    正式路径被占成目录 → 顶替失败 → 非零退出、不打印结果行（也不会把暂存里的图悄悄留在别处）。
    """
    output = fresh_dir("op-render-blocked")
    (output / "preview.png").mkdir(parents=True)  # 占位成目录，本轮图顶替不进去
    run = run_world(["--fixture", "--render", "--resolution", "[96,64]", "--output", output])
    message = run.stdout + run.stderr
    checks.check("正式路径不可用时非零退出", run.code != 0, f"exit={run.code} tail={run.tail()}")
    checks.check("失败可见（BLENDER_RENDER_* 或错误提到该路径）",
                 "BLENDER_RENDER" in message or "preview.png" in message, run.tail(300))
    checks.check("失败时不打印成功结果行（调用方不会把没图当成功）", run.result is None, str(run.result))
    checks.check("失败后不留暂存目录（顶替没成也不丢临时产物在输出目录里）",
                 staging_leftovers(output) == [], str(staging_leftovers(output)))


def staging_leftovers(output: Path) -> list:
    return sorted(item.name for item in output.iterdir() if item.name.startswith(".render-staging-"))


def check_reused_output_directory_never_reports_stale_image(checks: Checks):
    """输出目录复用 + 已有旧 PNG：本轮没成图不许报成功，成了图必须是**本轮**的图。

    复审指出的风险：只查正式路径的文件头，看不出图是新的还是上一轮留下的。
    这里两半都真跑：失败那半让渲染真的失败（分辨率 64x48 且百分比 0 → 不足 1 像素，
    Blender 抛 "Image too small" 且不写盘），成功那半在同一个正式路径上放一张 1x1 的旧图。
    """
    failing_scene = write_script("stale-scene.py", '''
import bpy
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.object.camera_add(location=(4, -4, 3))
bpy.context.scene.camera = bpy.context.object
bpy.ops.object.light_add(type="SUN")
bpy.context.scene.render.engine = "BLENDER_EEVEE"
# 百分比 0 会被 Blender 夹到 1%；基准分辨率必须也小，图才会小到渲染不出来（够不着 1 像素）。
bpy.context.scene.render.resolution_x = 64
bpy.context.scene.render.resolution_y = 48
bpy.context.scene.render.resolution_percentage = 0
''')
    failed_output = fresh_dir("op-stale-render-failed")
    stale = write_png(failed_output / "preview.png", 1, 1, (255, 0, 0))
    stale_bytes = stale.read_bytes()
    failed = run_world(["--operation", "preview", "--output", failed_output], scene_script=failing_scene)
    checks.check("旧图在场 + 本轮渲染失败 → 非零退出且不报成功（旧图不会当成本轮结果）",
                 failed.code != 0 and failed.result is None, f"exit={failed.code} result={failed.result} tail={failed.tail()}")
    checks.check("失败时旧图原样保留（不删用户既有产物）",
                 stale.read_bytes() == stale_bytes and png_facts(stale) == {"bytes": len(stale_bytes), "width": 1, "height": 1},
                 f"{png_facts(stale)}")
    checks.check("失败后不留暂存目录", staging_leftovers(failed_output) == [], str(staging_leftovers(failed_output)))

    fresh_output = fresh_dir("op-stale-render-succeeded")
    stale_small = write_png(fresh_output / "preview.png", 1, 1, (255, 0, 0))
    small_bytes = stale_small.read_bytes()
    fresh = run_world(["--fixture", "--operation", "preview", "--resolution", "[96,72]", "--samples", "1", "--output", fresh_output])
    facts = png_facts(stale_small) if stale_small.is_file() else {}
    checks.check("同一路径上本轮预览成功 → 正式路径是本轮图（不是那张 1x1 旧图）",
                 fresh.clean and facts.get("width") == 96 and facts.get("height") == 72 and stale_small.read_bytes() != small_bytes,
                 f"exit={fresh.code} {facts} 旧图 {len(small_bytes)}B → 新图 {len(stale_small.read_bytes())}B")
    checks.check("成功路径上结果行给的仍是正式路径，且不留暂存目录",
                 (fresh.result or {}).get("preview") == str(stale_small) and staging_leftovers(fresh_output) == [],
                 f"preview={(fresh.result or {}).get('preview')} 暂存残留={staging_leftovers(fresh_output)}")


def check_failures_exit_nonzero_in_both_invocations(checks: Checks):
    """失败在两种调用形状下都要非零退出：plugin.ts 不带 --python-exit-code，审阅命令带。

    Blender 默认把 `--python` 脚本的异常吞成 exit 0；world.py 自己 `sys.exit(1)`，
    所以带不带那个开关，调用方都能从退出码判失败（结果行也不会被打印）。
    """
    output_plain = fresh_dir("op-exitcode-plain")
    plain = run_world(["--fixture", "--operation", "preview", "--cameras", '["missing_camera"]', "--output", output_plain])
    output_flagged = fresh_dir("op-exitcode-flagged")
    flagged = run_world(["--fixture", "--operation", "preview", "--cameras", '["missing_camera"]', "--output", output_flagged],
                        python_exit_code=True)
    checks.check("plugin.ts 形状（无 --python-exit-code）失败非零退出",
                 plain.code != 0 and plain.result is None, f"exit={plain.code} result={plain.result}")
    checks.check("审阅命令形状（--python-exit-code 1）失败非零退出",
                 flagged.code != 0 and flagged.result is None, f"exit={flagged.code} result={flagged.result}")
    checks.check("两种形状的 stderr 都给出稳定错误码",
                 "BLENDER_CAMERA_MISSING" in plain.stderr and "BLENDER_CAMERA_MISSING" in flagged.stderr,
                 f"plain={plain.tail(160)} | flagged={flagged.tail(160)}")


def main() -> int:
    checks = Checks("ENV-22 world.py operation 合同（真实 Blender）")
    if blender_executable() is None:
        return checks.blocked_on("找不到真实 Blender 可执行文件：设置 BLENDER_EXECUTABLE 或把 blender 放进 PATH")
    check_default_operation_is_build(checks)
    check_export_does_not_render(checks)
    check_preview_does_not_export_or_bump_version(checks)
    check_preview_requires_real_camera(checks)
    check_named_cameras_must_exist(checks)
    check_multi_camera_report(checks)
    check_single_camera_keeps_legacy_preview_path(checks)
    check_invalid_arguments_are_rejected(checks)
    check_missing_image_cannot_succeed(checks)
    check_reused_output_directory_never_reports_stale_image(checks)
    check_failures_exit_nonzero_in_both_invocations(checks)
    return checks.finish()


if __name__ == "__main__":
    sys.exit(main())
