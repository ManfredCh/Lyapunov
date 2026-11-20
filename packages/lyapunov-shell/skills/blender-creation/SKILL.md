---
name: blender-creation
description: "从参考图、照片或尺寸构建三维道具，生成独立可编辑源文件、视觉网格和有物理语义的碰撞体。"
---

# Blender 制作 SimReady 资产

1. 记录来源、真实尺寸与原点。将颜色和纹理绑定实际材质，使用 `blender_run` 保留 `source.blend` 和独立资产导出。
2. 从视觉网格中拆出接触表面、空腔、把手和铰链；碰撞体与视觉网格分组。统一米、Z 向上、局部坐标、质量和惯性。用 `asset_verify` 检查资源身份和各引擎支持。
3. MuJoCo 道具接 `mujoco-audit` 和 `mujoco-showcase-shot`。需要修复时保留两次报告、同机位图和几何版本。复用产品 Blender Job 的取消、进度和产物入口。

随包提供 Apache-2.0 的 `robot-workflows/python/agy/blender_mesh_utils.py`。Blender 脚本可复用 `swept_tube`、`assign_pbr_material` 及该模块的 UV、碰撞凸包和贴图工具，工作区脚本交给 `blender_run` 执行。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/blender-creation)
