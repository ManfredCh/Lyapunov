"""Blender 5.x 兼容回归：`Action.fcurves` 已移除，动画指纹必须仍读到同一批关键帧通道。

为什么单独成测试：这条兼容性在 5.2.2 上真的崩过（`AttributeError: 'Action' object has no attribute 'fcurves'`，
增量导出整条链路退出 1），而相邻的 `test_world_incremental_export.py` 只覆盖网格/修改器/贴图/形态键，
**没有**任何带关键帧的动作 ⇒ 旧属性被移除时无人报警。这里补最小回归：

  1. 真 Blender：给对象打关键帧 → `iter_action_fcurves(action)` 必须给到**全部**通道（本例 rotation_euler 三条）；
  2. 真 Blender：`animation_hash(带关键帧对象)` 必须是可用的 16 进制摘要，且**同一状态两次调用同值**；
  3. **负对照**：无关键帧的静止对象 `animation_hash` 必须返回 `None`（兼容读取不得造出假动画指纹）；
  4. 老分支：用一个带 `fcurves` 属性的替身验证"有旧属性就走旧属性"（不依赖本机装 4.x）。

跑法（两种都支持）：
  `blender --background --factory-startup --python packages/blender/test/test_action_fcurves_compat.py`
  `python3 packages/blender/test/test_action_fcurves_compat.py`   # 无 bpy 时真 Blender 段报 SKIP，老分支段照跑
退出码：0 = 已执行的检查全过；1 = 有失败。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import world_incremental as wi  # noqa: E402

FAILED: list[str] = []
SKIPPED: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} — {detail}")
    if not ok:
        FAILED.append(name)


def skip(name: str, detail: str) -> None:
    print(f"[SKIP] {name} — {detail}")
    SKIPPED.append(name)


def real_blender_checks() -> None:
    import bpy  # type: ignore[import-not-found]
    import math

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.45, 0, 1.0))
    panel = bpy.context.object
    panel.name = "compat_panel"
    for frame, angle in ((1, 0.0), (40, math.radians(75)), (80, 0.0)):
        panel.rotation_euler = (0, 0, angle)
        panel.keyframe_insert("rotation_euler", frame=frame)
    action = panel.animation_data.action

    curves = wi.iter_action_fcurves(action)
    paths = sorted({curve.data_path for curve in curves})
    check("关键帧动作读到的通道集合", len(curves) == 3 and paths == ["rotation_euler"],
          f"通道数={len(curves)} data_path={paths}（Blender {bpy.app.version_string}，"
          f"hasattr(action,'fcurves')={hasattr(action, 'fcurves')}）")

    cache_one: dict = {}
    digest_one = wi.animation_hash(panel, cache_one)
    digest_two = wi.animation_hash(panel, {})
    check("动画指纹是可用的稳定摘要", isinstance(digest_one, str) and len(digest_one) == 64
          and digest_one == digest_two, f"digest={str(digest_one)[:16]}… 两次一致={digest_one == digest_two}")

    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.1))
    frame = bpy.context.object
    frame.name = "compat_frame"
    frame.scale = (1.0, 0.12, 2.2)
    check("负对照：静止对象没有动画指纹", wi.animation_hash(frame, {}) is None,
          f"animation_data={frame.animation_data} animation_hash={wi.animation_hash(frame, {})}")


def legacy_branch_check() -> None:
    class FakeCurve:
        data_path, array_index = "location", 0

    class FakeAction:
        name = "fake"
        frame_range = (1.0, 2.0)
        fcurves = [FakeCurve(), FakeCurve()]

    curves = wi.iter_action_fcurves(FakeAction())
    check("老分支：有 fcurves 属性时原样使用", len(curves) == 2 and curves[0].data_path == "location",
          f"取到 {len(curves)} 条（替身对象，不依赖本机装 4.x）")


if __name__ == "__main__":
    try:
        import bpy  # noqa: F401
    except Exception as error:  # 无 bpy：真 Blender 段跳过（不静默当通过）
        skip("真 Blender 段", f"当前解释器没有 bpy（{type(error).__name__}: {error}）；请用 blender --background --python 跑")
    else:
        real_blender_checks()
    legacy_branch_check()
    print(f"总结：失败={len(FAILED)} 跳过={len(SKIPPED)}")
    sys.exit(1 if FAILED else 0)
