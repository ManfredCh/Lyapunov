---
name: mujoco-audit
description: "运行 MJCF 静态检查和十个动力学场景，检查碰撞覆盖、空腔、铰链、摩擦与抗穿透。"
---

# MuJoCo 资产物理审计

将独立道具 MJCF 与全部网格、纹理和 include 放在同一个工作区子树。用 `robotics_lab` 的 `mjcf-audit` 传已存在的 `sourcePath`。默认同时运行静态与十个动力学场景，`requestPath` 中 `{"dynamic":false}` 可只选静态。

从 `job_output` 打开 `audit.json`、`asset_scenarios.json`、`asset_scenarios.png`，检查每项状态。形状相关的 CHECK 需要结合说明，比如球形道具本来就不应堆叠。有修改时用 `mujoco-showcase-shot` 保留改前和改后的多视角图，再通过 `scene_import`／`asset_verify` 复验产品引擎内的可用性。

[上游参考](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/mujoco-audit)
