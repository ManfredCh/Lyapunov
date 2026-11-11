# 场景与 Isaac 工作流

Linux 0.2.4 已提供控制步录制、Isaac Lab 导出、USD 检查、Capture 键盘和 IRA 人群。本文后半部分的 `asset_prepare_usd`、`nurec_evaluate`、`lab_mimic_run` 与 `simfoundry_match_poses` 需要包含本页对应提交的源码构建。安装版以当前会话可发现的工具和运行时状态为准。

## 0.2.4 的使用方法

| 功能 | 工作台与 Agent 用法 | 验收读数 |
| --- | --- | --- |
| 控制步录制和 Lab 导出 | 在录制面板选机器人和机位，开始录制并执行操作，停止后选「导出 Isaac Lab」。Agent 调用 `recording_start` 时给 `controlSamples.entityId`，之后用 `recording_stop` 和 `recording_export`，导出参数 `format: "isaac-lab"`。独立导出解释器由 `LYAPUNOV_LAB_EXPORT_PYTHON` 配置。 | `job_output` 返回导出目录。检查 HDF5、样本数和 manifest 中的录制身份。导出文件是 Mimic 准备的前置输入。 |
| USD 物理检查 | 在 USD 资源详情点物理检查，或让 Agent 对选定资源运行 `asset_verify`，带 `resourceId`、`version` 和 `isaacProfile: "physics"`。需要显式质量时选择 `explicit-mass`。 | 核对资源版本、SHA-256 和 Isaac 报告的实际状态。 |
| Capture 键盘 | 在 manual world 的录制面板选中具备映射的实体，启动并绑定键盘。键盘事件由输入区直接送入控制。同一套操作也提供 `robot_teleop_start/key/inspect/stop` 工具。 | 查看当前 world、实体和控制回执。停止遥操作与停止录制是两个操作。运行时由 `LYAPUNOV_CAPTURE_PYTHON` 配置。 |
| IRA 巡逻 | 在 Isaac 场景的人体属性填循环 walk 路线和区域，或让 Agent 对明确单人或组调用 `crowd_configure`，设置 `route` 与 `ira.seed/region/dwellS`。首次开启后重开 World，再用 `crowd_start`、`crowd_inspect` 和 `crowd_stop`。 | 查同一世界帧的巡逻状态和区域事件。角色、动作库和支持 IRA 的 Isaac SDK 需要预先配置。 |

工具参数、真实回执和配套依赖见 [0.2.4 接入记录](ISAAC_ECOSYSTEM_IMPLEMENTATION_20261110.zh-CN.md) 与 [人群工作流](HUMAN_CROWD.md)。

## 通过 Agent Graph 执行

打开工作台资源库的「这台工作台能做什么？」。展开后读取本机解释器和上游源码配置，并显示可复制的 Agent 指令。也可以问 Agent「这台工作台能做哪些场景和 Isaac 工作流？」让它调用 `scene_workflow_capabilities`。运行时已配置表示本地解释器可执行，GPU 和输入条件以实际作业为准。

在当前会话的工作区里准备输入文件，或者把资产交接到这个工作区。工具与同名 DSH 命令走同一实现。输入只能来自当前任务工作区。每次调用返回 `jobId`，用 `job_output`（参数 `job_id`）读取最终状态、摘要和报告路径，用 `job_kill` 取消作业。产物在当前会话的 `.lyapunov/sessions/…/offline-scene/` 目录，每次调用都有独立输出目录。

有活动 campaign 时，把资产准备和评分放进 dev 任务。Worker 通过原生工具发起作业，再用 `job_output` 读回结果。两次工具调用由现有 Agent Graph 留痕。Verifier 可从自己的会话重新运行。涉及场景接触或停稳的任务，用 `sim_task_check` 对实际 World 判定。

### 将本地 GLB 转成原生 USD

为 `LYAPUNOV_OFFLINE_USD_PYTHON` 指定具备 NumPy、trimesh、Pillow 和 OpenUSD 的独立 Python。无需模型或在线服务。给 Agent 一条具备实际尺寸的指令，例如「把工作区的 `box.glb` 按 Y-up、单位缩放 0.1、质量 0.25 kg 转成凸包 USD，导入当前场景并检查物理属性」。

```text
/asset_prepare_usd {"sourcePath":"box.glb","upAxis":"y","scale":0.1,"massKg":0.25,"collision":"convexHull"}
```

`job_output` 返回 `usdPath`。用 `scene_import` 导入该路径，设 `category: "object"`、`physicalize: false` 并指定当前 `sceneId`。随产物保留 `usd/`、`material/` 和 `result.json`。在场景中确认接触与停稳。首轮针对自包含 GLB 的基础色贴图。源网格仍由现有资源库管理。

[上游转换器](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/interactive/light_editor/asset_import.py#L459) · [本项目来源清单](../packages/robot-workflows/python/vendor/simfoundry/SOURCE.md)

### 对 NuRec 场景进行同机位评分

准备可运行 RTX 的 Isaac Sim 6.0.1 解释器和本地 NuRec USD。参考目录按 `机位名/纳秒时间戳.png`、`.jpg` 或 `.jpeg` 排列，机位名及时间戳与场景内相机对应。已有产品 Isaac SDK 配置会传给后台作业。

```text
/nurec_evaluate {"stagePath":"scene.usdz","referenceDir":"refs","camera":"front_stereo_camera_left","samples":10}
```

Job 摘要报告配对数、PSNR、SSIM，目录中有原生渲染、评分和报告。评分进程拥有自己的 Kit 与物理时钟。 [固定评估源码与来源](../packages/robot-workflows/python/vendor/nurec_utils/SOURCE.md)

### 运行固定笛卡尔夹具的 Lab Mimic

以 `LYAPUNOV_LAB_MIMIC_PYTHON` 指向已准备的 Isaac Lab v3.0.0 CPU 环境。扩增另外配置 `LYAPUNOV_LAB_SOURCE_ROOT` 为固定提交 `e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4` 的本地源码根。源数据必须是固定任务的带初态和分段标注的 HDF5。已有普通录制时，按 S7 回执先用 `prepare_cart_lab_asset.py` 准备夹具 USD，用 `prepare_cart_mimic_demo.py` 标注真实抓放录制，再用 `assemble_cart_lab_demos.py` 组装源示教。三个脚本的 `--help` 提供完整文件参数。

```text
/lab_mimic_run {"mode":"replay","datasetPath":"cart-demos.hdf5","assetUsd":"cart/cart.usda"}
/lab_mimic_run {"mode":"augment","datasetPath":"cart-demos.hdf5","assetUsd":"cart/cart.usda","trials":10}
```

读取回放的逐条成功条件、物体峰值高度和最终位置，或扩增的实际成功及失败数量。Job 完成只表示步骤执行完毕。训练样本选用通过任务判定的 HDF5。 [S7 准备与实测](ISAAC_ECOSYSTEM_IMPLEMENTATION_20261110.zh-CN.md#s7-任务注册原生回放与官方扩增) · [上游扩增代码](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/scripts/imitation_learning/isaaclab_mimic/generate_dataset.py)

### 用自摄桌面评估 SimFoundry 位姿配准

先用固定上游提交的重建流程准备 `s2_da`、`s3_ground`、`s4_frame`、`s5_scene` 和 `s7_mesh`。配置 `LYAPUNOV_SIMFOUNDRY_ROOT` 为 `9e34ebefcd020583fbb755a8b57268dce78eca26` 的本地源码根，并设置 `LYAPUNOV_SIMFOUNDRY_PYTHON` 为能运行该 Stage 8 的解释器。模型和 SDK 取件沿用项目镜像规则。本工具消费已准备的数据，仅运行指定物体的 CPD 配准，关闭 FoundationPose 和 VLM 正面选择。

```text
/simfoundry_match_poses {"preparedSceneDir":"Data/my-table","objectIndex":0,"meshBackend":"hunyuan"}
```

用 Job 报告中的 Z-up 位姿、`pre_scale_factor` 和配准尺度，与自摄素材的已知尺寸、人工标注落点和方向做对照。保留失败和跳过的候选。确认后用现有场景编辑工具应用选定结果。 [上游输入与阶段](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/pipeline/README.md#stages) · [上游 Stage 8](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/pipeline/A_reconstruction/stages/8_match_object_poses.py#L296)

用于试走输入流程的公开视频可选 [NVIDIA PutMarkerInCup.mp4](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/docs/assets/example_videos/PutMarkerInCup.mp4)。这段视频未提供可用于计算尺度误差的实测尺寸。
