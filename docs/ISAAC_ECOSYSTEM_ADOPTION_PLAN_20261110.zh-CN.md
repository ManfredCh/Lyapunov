# Isaac 生态代码接入与分阶段实施方案

日期：2026-11-10（新加坡时间）。状态：方案完成，实施未开始。

目标：让 Lyapunov 现有工作台获得可用于学习的示教数据、可选遥操作、人群事件、资产验证和重建场景成像能力，并把成果交给 Isaac Lab 的扩增、训练与策略导出流程。

主线为：场景与资产 → 资产验证 → 真实控制与同步采样 → 示教导出 → Lab 扩增与策略导出 → 回到 Lyapunov 验证。人群事件和 NuRec 分别扩展场景动态与成像来源，接入同一身份和产物合同。

本次交付是一份实施方案。后续执行按各阶段的写域、依赖和验收推进；本文件没有启动安装、GPU、训练、派发或发布操作。

## 1. 当前代码基线与已确认事实

本次本地核对对象：分支 `main`，提交 `683b34256bd30283b5d3af40c9622876a3fd5c69` 加当前工作区。开始时已有未跟踪内容 `design/`、`lefthook.yml`、`packages/human-crowd/assets/`；它们保持原状，后续提交不夹带这些内容。

| 当前事实 | 实际依据 | 对方案的影响 |
| --- | --- | --- |
| 产品固定适配 Isaac Sim 6.0.1／6.0.1.0，Python 3.12 | [安装说明](isaac-setup.md)、[SDK 检查](../packages/sim-isaac/python/check.py) | Lab 3.0 的完整 Sim 6.2 环境单独准备，产品默认 SDK 固定值继续由现有安装 owner 管理 |
| Isaac worker 明确使用 PhysX，已有唯一物理推进点 | [worker.py](../packages/sim-isaac/python/worker.py) 的 `execute`、`apply_motion`、`tick` | 外部输入和采集代码接到这些边界；物理推进继续归 Provider |
| `control` 已有整数 `stepCount`，Isaac 要求 manual 世界 | [Sim 合同](../packages/sim-contract/src/index.ts)、Isaac worker 的 `prepare`／`execute` | 首个示教闭环使用显式 manual 世界和位置参考控制；realtime 是后续独立验收项 |
| 现有录制保存 Frame、会话事件和动作回执 | [recording.ts](../packages/robot-workflows/src/recording.ts)、[recording-events.ts](../packages/robot-workflows/src/recording-events.ts) | 在现有录制中增加控制样本及导出；动作回执与逐控制步动作分别保存 |
| 已有 SimReady 搜索、详情与导入，固定 revision 和镜像校验 | [simready-assets.ts](../packages/scene-kit/src/simready-assets.ts)、[Scene 插件](../packages/scene-kit/src/plugin.ts) | 新工作聚焦验证与适用性元数据，资源身份继续由 ResourceLibrary 维护 |
| 已有人群生成、导入、路线配置、启动与停止 | [human-crowd 插件](../packages/human-crowd/src/plugin.ts)、[Isaac 人体适配](../packages/sim-isaac/python/human_adapter.py) | 优先验证 IRA 行为层与现有资产、时钟、启停合同的连接 |
| 已有策略适配和执行、Mink 规划、任务谓词 | [策略适配](../packages/policy-registry/src/adapter.ts)、[执行](../packages/policy-registry/src/execution.ts)、[Mink](../packages/motion-mink/src/solve.py)、[谓词](../packages/sim-task-check/src/predicates.ts) | 策略与控制算法沿已有路径扩展；任务成功由真实观测或官方任务判据给出 |

上表确认源码结构与接口，尚未给这些组合增加运行通过证据。

## 2. 设计规范核对与落实方式

已按产品、开发、美学、交互的顺序核对现行原则，并核对开发标准、根 `package.json`、CI 工作流和测试清单执行器。

| 规范 | 本方案中的具体落实 |
| --- | --- |
| [产品原则 §1–5](../principles/PRODUCT.md)：连续工作台、来源一致、真实任务结果 | 新能力进入现有对象操作和产物路径；示教、回放、重新执行、任务成功分别标注 |
| [开发原则 §1–4](../principles/DEVELOPMENT.md)：最薄、可选插件、唯一权威、依赖方向 | Scene／资源归 scene-kit，物理归 ctx.sim，录制归 robot-workflows，策略归 policy-registry；Capture 作为有独立 SDK 与设备生命周期的可选领域插件 |
| 开发原则 §5–7：会话归属、代次与坐标 | 操作绑定会话、worldId、generation、entityId；统一米、弧度、秒、右手 Z-up、xyzw，外部格式在边界显式转换 |
| 开发原则 §8、§11：资产能力与具名错误 | 控制关节、模式、限位、频率和可用传感器从真实模型读取；缺读数返回具体不可用原因 |
| 开发原则 §9、§12：数据与依赖隔离 | 原件、派生和运行环境分域；Lab、Capture 与 Sim 的环境各自锁版本；Hub 查询、下载、校验使用 hf-mirror.com 并拒绝官方回退 |
| [开发标准 §3.1–3.3、§5.2](DEVELOPMENT_STANDARDS.md)：合同到 UI 的实现顺序 | 先 DTO／schema，再 operation／Provider，再 Tool／Command，再 UI 与帮助；耗时行为用原生 Jobs，stdout 保持协议、stderr 保存诊断 |
| [美学原则 §3–6](../principles/AESTHETICS.md)：真实状态、原生设置、人工视觉验收 | 设置沿已有 slot；对象详情展示来源、进度、缺依赖和产物；对触达界面检查常规、空、加载、错误、长名称和窄窗 |
| [交互原则 §2、§4、§7、§11](../principles/INTERACTION.md)：人机同路、停止语义、采集语义 | 人工和 Agent 使用同一 operation；停止遥操作、停止录制、暂停物理、关闭世界保持独立；NVIDIA Isaac Capture 的名称在界面中与现有 Capture 拍摄入口区分 |
| 开发原则 §14、开发标准 §5.3–6：证据分层 | 离线检查、SDK 运行、物理终态、图形、交互、设备、打包分别记录；每阶段主控独立验收实际交付版本 |

核对后的三个设计决定：

1. 在 Provider 内采集控制样本，在现有录制 owner 中持久化，在外部导出适配中转换为 Lab 数据。
2. Capture 插件拥有设备输入与 SDK 生命周期，调用现有 ctx.sim 动作；Mimic／Lab 作为离线任务依赖接入。
3. IRA、NuRec 和资产验证通过 Isaac 适配进入既有世界或专用验证世界。凡官方例程会切换 stage、推进时间或另建应用，先拆出与现有生命周期兼容的调用点。

## 3. 代码采用清单与版本策略

| 能力 | 上游代码与固定参考 | 采用方式 | 本地 owner |
| --- | --- | --- | --- |
| 示教格式与采集时序 | Lab v3.0.0 的 [EpisodeData](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/utils/datasets/episode_data.py)、[HDF5DatasetFileHandler](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/utils/datasets/hdf5_dataset_file_handler.py)、[采集 terms](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/envs/mdp/recorders/recorders.py) | 直接调用官方 EpisodeData 和 HDF5 读写 API；新增本地样本映射，并用官方 reader 回读 | robot-workflows 与已有 Sim 合同、Provider |
| 遥操作重定向 | Capture 源码参考提交 `2b72b3aac75f87e5043bcb3411f9a75c294f7ba7` 的 [SE3](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/se3_retargeter.py)、[TensorReorderer 动作拼接](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/tensor_reorderer.py) | 可选 SDK 与设备适配；S0 冻结与源码对应、实际可安装的运行版本 | 拟新增 teleop-capture 领域插件 |
| 演示扩增 | Lab v3.0.0 的 [DataGenerator](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/data_generator.py)、[waypoint](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/waypoint.py) | 首先以完整 Lab 依赖运行；局部移植限于确认独立的数学与轨迹算法 | robot-workflows 的离线任务与可选 Lab 任务包 |
| 策略导出 | Lab v3.0.0 的 [RSL-RL exporter](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_rl/isaaclab_rl/rsl_rl/exporter.py) | 在训练／准备环境调用；交付模型与动作观测合同 | policy-registry |
| 人群事件 | IRA 1.x 的 [6.0.1 配置合同](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_configuration.html) | 使用安装版 SDK 和配置。已审公开扩展目录中未定位到完整 agent.core 源码，实施前核对安装版 API 与许可 | human-crowd、sim-isaac |
| 资产验证 | Sim v6.0.1 的 [physics_rules](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/physics_rules.py)、[robot_rules](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/robot_rules.py) | 在隔离的验证 stage／世界调用官方规则 | scene-kit 与 sim-isaac 验证适配 |
| NuRec 成像与评估 | Sim v6.0.1 的 [render](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/render.py)、[eval](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/eval.py) | 在已启动 Kit 的 Isaac worker 中调用；离线评估使用专用世界 | sim-isaac、robot-workflows |
| 实时 IK 与随机化 | Lab v3.0.0 的 [differential_ik](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/controllers/differential_ik.py)、[MDP events](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/envs/mdp/events.py) | IK 先与已有 Mink 路径比对；随机化按具体任务需要接入 | motion-mink／现有控制适配、robot-workflows |

Lab 3.0 完整 Isaac Sim 路径面向 Sim 6.2，见[官方发布说明](https://github.com/isaac-sim/IsaacLab/releases/tag/v3.0.0)。本方案采用产品 Sim 6.0.1 与 Lab 环境隔离的策略；数据和导出产物通过文件合同互通，产品引擎枚举仍为既有引擎。

Lab 数据、控制和导出文件头标注 BSD-3-Clause；已审 Mimic、Capture 与上述 Sim 文件标注 Apache-2.0。采用代码时保留文件许可与版权，核对 NOTICE 和依赖。源码参考提交与待安装二进制版本分开登记；SDK、模型和资产许可按具体对象核对。

### 3.1 已解析的源码版本

2026-11-10 已通过 GitHub tag 引用核对以下提交。本文 GitHub 文件链接固定到完整 SHA；阶段 S0 仍需核对运行包、二进制、扩展版本与源码的对应关系。

| 仓库 | 参考版本 | 已核对提交 |
| --- | --- | --- |
| [Isaac Lab](https://github.com/isaac-sim/IsaacLab) | v3.0.0 | `e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4` |
| [Isaac Sim](https://github.com/isaac-sim/IsaacSim) | v6.0.1 | `045ca8b59622b99a408092124377c66346e8d9c2` |
| [Isaac Capture](https://github.com/NVIDIA/IsaacCapture) | 本次参考源码提交 | `2b72b3aac75f87e5043bcb3411f9a75c294f7ba7` |

### 3.2 实施时先复用已有实现

各阶段下面的“对应源码与复用范围”是实施入口。每项交付说明写清实际调用的上游模块／函数、本地适配位置和新增代码的职责。

1. 优先采用已固定版本的上游包 API 或官方 CLI。HDF5 读写、SE3 重定向、夹爪重定向、Mimic 片段选择与轨迹拼接、资产规则、NuRec 渲染和 PSNR／SSIM 沿下列实现复用。
2. 本地新增代码聚焦会话／对象身份、字段与单位、关节次序、模型特定控制映射、Jobs／取消、产物和界面连接。
3. 独立算法确实无法通过原包调用时，可在许可允许下移植所列模块；同时保留来源提交、原路径、许可、必要依赖和相对上游的差异。以原实现和其测试为对照说明数值与行为差异。
4. 现有 Lyapunov 模块继续复用。原生 Agent、Jobs、世界时钟、资源库、录制和策略执行的生命周期由已有 owner 管理。
5. 公开源码、已读关键实现、已定位的上游测试、安装版 SDK 的可调用接口分别标识。上游测试链接表示回归参考；是否可在本项目环境执行，在 S0 和对应阶段核对并记录。
6. 缺少源码或 SDK 时记录具体对象；不以从零实现一套同名模块代替该依赖。IRA 的当前边界见 S5。

## 4. 状态、接口与数据设计

### 4.1 责任分配

| 数据或操作 | 唯一维护方 | 新能力的接入方式 |
| --- | --- | --- |
| 场景文档、实体与资源版本 | SceneStore／ResourceLibrary | 通过已有 SceneOperations、CAS 与资源 API |
| 物理状态、时钟、执行器和控制权 | ctx.sim 的 Provider | 样本产生在真实动作与步进边界；沿已有动作控制权检查 |
| 设备输入与重定向 | 可选 teleop-capture 插件 | 只提供输入与目标，复用既有动作接口；每个设备作业绑定一个会话与机器人 |
| 录制文件、片段与导出 | robot-workflows | 现有录制增加可选控制样本流与数据集导出格式 |
| 学习任务与扩增产物 | 离线 Lab 任务，由原生 Jobs 管理 | 消费冻结的输入清单，输出数据和报告，不回写活动世界 |
| 策略来源、适配、准备与运行 | policy-registry | 导入模型及动作／观测描述；复用 policy_match、execute、stop |
| 任务成功 | sim-task-check 或官方任务判据 | 与 episode 标签关联，保留判据版本及证据 |
| 验证报告与界面 | 对应 operation 产物与既有 UI 投影 | 报告引用资源／世界版本；UI 消费报告，不成为第二份资产状态 |

### 4.2 拟新增的控制样本合同

`ControlSample` 为拟新增值合同，最小字段如下。最终类型进入现有合同包，Python／TS 两侧同步校验。

- 来源：会话引用、sceneId、sceneRevision、worldId、generation、entityId、actionId、控制来源与调用关联 ID。
- 顺序：episodeId、controlCycleIndex、physicsStepStart、physicsStepEnd、simTimeStart、simTimeEnd。
- 时间配置：physicsTimestepS、整数 physicsStepsPerControl、实际 controlPeriodS；设备源时间、接收墙钟时间另列。
- 控制前数据：实际 observation／state，带观测键、形状、单位与坐标约定。
- 控制数据：输入命令、重定向后的目标、交给 Provider 的控制量及关节顺序；无对应层时注明来源层级。
- 控制后数据：真实 nextState、动作实际应用步数、控制与世界错误。
- 任务数据：任务／判据版本、success 的 true／false／unknown、停止或截断原因；reward 只在任务实际定义时输出。
- 传感器引用：实际采样的相机／通道、标定、文件身份与采样物理步。图像低频采集保留真实采样步，不复制旧图冒充当前图。

首版只支持已经核验的 manual 位置参考控制。采样在控制生效前和最后一个实际物理步后读取。控制周期是整数物理步；无法精确表达时显式拒绝配置。异步 Frame 订阅用于观察和 UI，不能用于猜测训练样本的动作边界。

示教结束、动作停止、世界代次变化、原生故障和数据写入失败分别封口。未完成样本保留为部分记录；完整训练导出需明确选择可用片段。既有历史录制保留原格式，缺少控制样本时如实显示可导出范围。

### 4.3 兼容边界

1. Lab HDF5 与 Sim episode recorder HDF5 使用不同 schema，导出器明确目标格式和版本。
2. Lab 3.0 使用 xyzw，旧数据和部分 USD／Sim 接口使用 wxyz；按字段定义转换，读取后做已知旋转验证。
3. 可被官方 HDF5 读写器读取，只证明格式可读。任务环境能够 reset、动作能够重新执行、任务达到终态各自验收。
4. 世界快照回放消费历史状态；动作重新执行使用 Provider 的真实控制路径，两者在工具与产物中独立命名。
5. Lab 任务 ID 必须对应实际注册环境及确定配置；不能把自定义记录标成未经匹配的官方任务。

## 5. 完整实施顺序

依赖顺序：S0 → S1 → S2 → S4 → S7。S3 在 S0 后具备独立实施条件，建议作为首批第三个交付；S5 与 S6 在数据和版本合同冻结后推进。S8 按真实缺口实施，S9 汇总已经完成的能力。

建议首批交付边界为 S0–S4；第二批交付 S5–S7；S8 属按需扩展。编号表示依赖与范围，不是运行通过状态。

### S0 固定版本、来源和最小运行条件

**对应源码与复用范围：**

- 上游依赖声明：[Lab pyproject.toml](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/pyproject.toml)、[Capture pyproject.toml](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/pyproject.toml)。从这里取得依赖与 extras，按固定源码准备运行环境。
- 产品现有入口：[check.py](../packages/sim-isaac/python/check.py) 的 `sdk_facts`／`check`、[environment-readiness.ts](../packages/lyapunov-shell/src/environment-readiness.ts)、[install-provider](../distribution/linux/install-provider)。沿这些入口增加所需可选组件检查。
- 本地新增范围：版本对应与导入探针、来源和许可记录；继续使用现有安装／发现路径。

输入：当前代码、已审上游源文件、现有安装与解释器解析规则。

步骤：

1. 重新核对 Git 状态、相关接口和已有测试；记录实际提交与工作区差异。
2. 复核 §3.1 已解析的源码提交，补充拟采用文件、文件 hash、许可、运行包版本、依赖及采用方式。已有 provider 安装与许可记录沿原 owner 扩展。
3. 为 Lab 固定 Python、Lab、Torch、物理后端与导出库；为 Capture 固定与所采用 API 对应的版本和二进制。导出环境与物理环境分别准备。
4. 先检查 SDK 模块导入、官方 HDF5 reader 和重定向最小输入输出；这些检查不启动训练。
5. 检查 IRA、NuRec、asset validator 的安装版扩展和 API；核对其 stage、时间线、线程和卸载要求。
6. 首个机器人与物体优先复用已存在且来源可核对的资产。需要 Hub 对象时先经镜像检查指定 revision 与完整依赖，缺失则记录具体阻断。

写域：相关组件的依赖描述、现有安装适配、来源与许可文档；保持产品 Isaac 固定值。

验收：每个候选都有准确版本、采用方式、可重复的导入／接口探针及依赖清单。未能匹配运行包的 Capture 源码候选停在该项，其余独立任务可继续。

交付：版本与来源清单、模块探针日志、首个任务资产清单及明确阻断项。

### S1 在既有 Provider 中增加控制步采样

**对应源码与复用范围：**

- 采样时序直接对照 Lab [recorders.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/envs/mdp/recorders/recorders.py)：`InitialStateRecorder.record_post_reset`、`PreStepActionsRecorder.record_pre_step`、`PreStepFlatPolicyObservationsRecorder.record_pre_step`、`PostStepStatesRecorder.record_post_step`。
- 生命周期参考 [recorder_manager.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/managers/recorder_manager.py) 的 `RecorderTerm`、`RecorderManager`。在 Lab 环境直接使用；产品世界只接对应采样时机，保持现有 Provider owner。
- 复用本地 [python-transport.ts](../packages/sim-contract/src/python-transport.ts) 的 `decodePythonMessage`／`ProcessSimProvider`，以及 [MuJoCo worker](../packages/sim-mujoco/python/worker.py) 和 [Isaac worker](../packages/sim-isaac/python/worker.py) 的 `execute`／`apply_motion`／`tick`；持久化沿 [SimulationRecording](../packages/robot-workflows/src/recording.ts)。
- 上游回归参考：[test_action_state_recorder_term.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/envs/test_action_state_recorder_term.py)、[test_recorder_manager.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/managers/test_recorder_manager.py)。
- 本地新增范围：ControlSample DTO、采样 hook、事件分派和录制适配。物理推进与录制生命周期沿已有实现。

输入：S0 版本与接口结论、4.2 的值合同。

步骤：

1. 在已有合同包定义可选控制样本能力、启停／订阅参数和 schema；已有 Provider 与测试替身通过能力声明保持兼容，缺实现时明确返回不支持。
2. 在现有 ProcessSimProvider 的 NDJSON 分派增加样本事件与能力协商；按会话、world 和 generation 校验归属。
3. 在 MuJoCo 与 Isaac worker 的原生动作／tick 路径各加采样点。使用同一原生控制量和状态，不新增物理循环。
4. 首先覆盖明确的 manual control；控制前观察、实际动作应用、控制后观察构成一个样本。采样启停和控制请求按 Provider 队列串行处理。
5. robot-workflows 在现有录制中流式保存样本；只有显式启用时产生该数据。写入积压、缺样本或中断以具体结果封口，保留现有录制产物。
6. 保持已有动作幂等、ENTITY_BUSY、代次检查、停止和会话退出清理行为。

主要文件：[Sim 合同](../packages/sim-contract/src/index.ts)、[进程传输](../packages/sim-contract/src/python-transport.ts)、两个 Provider 的 worker、[录制插件](../packages/robot-workflows/src/recording-plugin.ts)与录制文件模块。新 helper 放入所属包，按相邻风格命名。

自动验收：验证边界顺序、整数 decimation、丢帧、重复 actionId、代次切换、停止中断、故障和跨会话拒绝；不开启采样时既有行为保持。使用可区分的已知动作序列发现一周期错位。

真实验收：每个被声明支持的 Provider 各运行一个限定位置参考序列，核对样本索引、实际步数和读数；连续 observe、采集和导出不额外推进物理。

通过条件：数据可以从原生命令追溯到实际应用窗口，两个 Provider 分别给出结果；尚未实测的组合继续标未验证。

### S2 导出并回读 Lab 示教数据

**对应源码与复用范围：**

- 直接调用 [episode_data.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/utils/datasets/episode_data.py) 的 `EpisodeData.add`／`pre_export` 和 [hdf5_dataset_file_handler.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/utils/datasets/hdf5_dataset_file_handler.py) 的 `HDF5DatasetFileHandler.create`／`write_episode`／`load_episode`／`close`。
- 复用本地 [recording-plugin.ts](../packages/robot-workflows/src/recording-plugin.ts) 的 `recording_export`、[recording-files.ts](../packages/robot-workflows/src/recording-files.ts) 与 [recording-events.ts](../packages/robot-workflows/src/recording-events.ts)。新增转换器负责将本地样本映射为 EpisodeData，并保存产品来源信息。
- 上游回归参考：[test_hdf5_dataset_file_handler.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/utils/test_hdf5_dataset_file_handler.py)、[test_episode_data.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/utils/test_episode_data.py)。优先采用其读写和格式转换行为作为对照。
- 如后续需要独立的 Sim 状态回放格式，可复用 [storage.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.episode_recorder/isaacsim/replicator/episode_recorder/storage.py) 的 `SessionStorage`／`SessionReader` 和 [replayer.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.episode_recorder/isaacsim/replicator/episode_recorder/replayer.py) 的 `EpisodeReplayer`；该 schema 与 Lab 数据导出分别选择，不能混写。

输入：S1 控制样本和冻结的数据 profile。

步骤：

1. 扩展已有 recording_export operation 的输出格式选项，保留现有导出路径和默认语义。
2. 在 robot-workflows 中加入样本到 EpisodeData 的转换适配，在独立导出环境调用官方 HDF5DatasetFileHandler 写入 initial_state、actions、states、obs、seed、env 配置和可用的成功标签；附来源、映射和完整性清单。HDF5 结构、压缩、格式版本和读写逻辑优先由该官方实现承担。
3. 以 position reference 为首个明确 profile，记录 joint names、单位、动作周期及相应 Lab 自定义任务。EEF 类 profile 在 S4／S7 按实际控制合同新增。
4. 通过临时输出、flush／close 和完整性检查后完成产物；失败保留原因和已生成范围。
5. 在独立 Lab 环境用官方 reader 回读，逐字段比较数量、形状、数值、四元数和元数据。对旧 wxyz、缺字段、非有限值与错序输入进行负例验证。
6. 在已有录制／导出界面展示格式、样本数、任务、来源和不完整原因；人工与 Agent 调用同一 operation。

写域：robot-workflows、必要的值合同、录制界面和已有文档；HDF5 依赖留在导出环境。

验收：官方 reader 可回读且数值吻合；历史录制可继续打开；缺少 actions 或 initial_state 时不能被标成完整示教；取消、磁盘错误和来源切换有真实回执。

交付：一个小型有效数据集、反例样本、回读报告，以及人工／Agent 各一次导出记录。任务重新执行放在 S4／S7 验收。

### S3 接入资产验证并显示适用范围

**对应源码与复用范围：**

- 直接使用 [physics_rules.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/physics_rules.py) 的 `RigidBodyHasMassAPI`、`RigidBodyHasCollider`、`NonAdjacentCollisionMeshesDoNotClash`、`HasArticulationRoot`，按规则是否需要仿真分类执行。
- 机器人规则使用 [robot_rules.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/robot_rules.py) 的 `RobotSchema`、`JointsExist`、`LinksExist`、`CheckRobotRelationships`，并复用同目录 [util.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/util.py) 的规则辅助逻辑。
- 本地入口沿 [simready-assets.ts](../packages/scene-kit/src/simready-assets.ts) 的 `simreadySearch`／`simreadyDetail`／`simreadyImport`、[usd-assets.ts](../packages/scene-kit/src/usd-assets.ts) 的 `inspectUsd` 和现有资源验证 operation。
- 上游回归参考：[test_physics_rules.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/tests/test_physics_rules.py)、[test_robot_rules.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.asset.validation/isaacsim/asset/validation/tests/test_robot_rules.py)。
- 本地新增范围：规则选择、隔离 stage／世界调用、结果到资源版本的映射和 UI；判定逻辑优先使用上述规则类。

输入：S0 的 validator 与资源依赖清单；现有 asset_verify／SimReady 导入路径。

步骤：

1. 在 scene-kit 的现有验证 operation 中添加可选 Isaac 验证模式，报告绑定 resourceId、version、源文件 hash、profile、规则版本和验证配置。
2. 元数据、BOM／hash、USD 静态规则与需要仿真的规则分开运行和报告。
3. 在临时 stage 或专用验证世界调用官方 asset validator。运行规则时复用 Isaac 生命周期；对原件保持只读，显式修复另走派生版本和现有 CAS。
4. 先接质量／惯性声明、碰撞体、关节／链接关系与 articulation 规则；机器人目录和命名规则仅在对应 profile 适用时执行。
5. 对合法使用默认密度或自动惯性等资产按 profile 和引擎语义报告，避免把某个发布规范套到所有 USD。
6. 在既有资源详情与 SimReady 候选中显示规则适用性、发现与验证版本；SDK 缺失时返回未运行的精确原因。

写域：scene-kit 验证与资源详情、sim-isaac 验证适配、对应测试。继续使用现有 ResourceLibrary。

验收：合法与缺质量／缺 collider／错误关系等夹具给出可定位结果；验证前后源文件 hash 相同；原活动世界不被换 stage、步进或改变控制；规则通过与机器人任务成功独立记录。

交付：资产验证报告、一个正常资产和多个错误夹具、资源详情的实际界面证据。

### S4 Capture 遥操作接入并完成示教闭环

**对应源码与复用范围：**

- 位姿重定向直接使用 Capture [se3_retargeter.py](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/se3_retargeter.py) 的 `Se3AbsRetargeter`／`Se3RelRetargeter`；夹爪使用 [gripper_retargeter.py](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/gripper_retargeter.py) 的 `GripperRetargeter` 及匹配输入设备的实现；动作拼接使用 [TensorReorderer](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/tensor_reorderer.py)。
- Lab 与 Capture 的现成连接参考 [isaac_teleop_device.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_teleop/isaaclab_teleop/isaac_teleop_device.py) 的 `create_isaac_teleop_device`、`IsaacTeleopDevice.advance`／`request_start`／`request_stop`，以及 [session_lifecycle.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_teleop/isaaclab_teleop/session_lifecycle.py) 的 `TeleopSessionLifecycle.start`／`stop`。在 Lab 任务中直接调用；产品桥复用 SDK、目标坐标转换和释放约定，沿 DSH 与 Provider 管理作业和世界。
- 按实际输入问题采用现有 [EePoseJumpGuard](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/ee_pose_jump_guard.py) 或 [EePoseRateLimiter／JointRateLimiter](https://github.com/NVIDIA/IsaacCapture/blob/2b72b3aac75f87e5043bcb3411f9a75c294f7ba7/src/python/isaaccapture/retargeters/rate_limiter.py)，配置与实际修改后的目标一起记录。
- 上游回归参考：[test_retargeters.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_teleop/test/test_retargeters.py)、[test_cloudxr_lifecycle.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_teleop/test/test_cloudxr_lifecycle.py)、[test_target_frame_rebase.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_teleop/test/test_target_frame_rebase.py)。
- 本地新增范围：设备桥、模型特定控制映射、ctx.sim／Jobs／取消连接和产品 UI。SE3、夹爪、动作拼接与现成处理节点直接复用。

输入：S0 Capture 运行版本，S1 样本，S2 导出，已有模型与控制能力。

步骤：

1. 按既有插件模板新增可选 `teleop-capture` 领域插件。该新增包是规划项；插件负责设备、重定向、配置与释放，物理执行消费已有 ctx.sim。
2. 以键盘／普通控制器和一个机械臂开始，明确 world、generation、entity、TCP、完整受控关节和位置参考模式。
3. 复用 Capture SE3 重定向和动作拼接。末端目标先接已有控制／IK；若需要模型原生 Jacobian 的连续伺服，在 S8 的算法门后采用 Lab 差分 IK。
4. 设备桥仅采集输入。控制作业复用原生 Jobs 和现有 manual control 通道，保持单个在途控制请求，按实际物理时间标记样本；设备时间与物理时间分别记录。
5. 启动时检查现有动作控制权。设备断开、作业取消、world 关闭、代次变化和 Host 卸载均释放设备与订阅，调用 Provider 的既有停止语义。
6. 增加人工与 Agent 共用的启动、检查、停止 operation；工具名和 schema 实施时按现有前缀白名单登记。遥操作停止与录制停止分别提供。
7. 接通“操作 → 采样 → 导出 → 历史回放 → 动作重新执行 → 任务判定”。记录输入目标、实际控制与实际终态。
8. 基础链路通过后验证 XR。Pico 4 Ultra 按实际型号、系统版本、HTTPS 和官方 Capture／CloudXR 要求检查；许可由实际使用者按现有流程接受。

写域：规划中的 teleop-capture、现有运行装配与按需集成设置、robot-workflows、必要的共享合同与机器人控制适配。当前兄弟仓库 LyapunovAR 源码不在本方案实施写域。

自动验收：已知姿态变换、xyzw、关节重排、单位与尺度、输入过期／断连、占用冲突、停止与退出清理。对实际采用的跳变处理或限速模块验证其明确合同。

真实验收：用同一机器人分别执行人工遥操作与 Agent 工具链；完成一次限定抓放，物体真实接触与保持由观测确认；停止后保留原生动力学语义。Pico 的连接、输入、画面、动作延迟和完整交互各自记录。

通过条件：普通输入闭环先通过；XR 按设备证据单独准入。缺少对应运行时只阻断该设备能力。

### S5 将 IRA 人群事件接到已有场景

**对应 SDK、配置与本地源码：**

- SDK 模块为 `isaacsim.replicator.agent.core`，已核对的官方入口包括 [配置合同](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_configuration.html)、[内置示例配置目录](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_sample_configs.html) 和 [Configuration Editor API](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_configuration_editor.html)。
- 安装版原件位于 `[ext-path]/data/sample_configs/`：`minimal.yaml`、`full_pipeline.yaml`、`behavior_tree/wander.yaml`、`behavior_tree/patrol_and_wander.yaml`、`behavior_tree/instance_overrides.yaml`；行为树原件位于同扩展的 `data/sample_behavior_tree/`。优先从这些原件生成有明确差异的任务配置。
- 已公开的调用合同包括 `isaacsim.replicator.agent.ui.load_config_file`／`update_config`／`setup_simulation`／`start_data_generation` 与 `isaacsim.replicator.agent.core.events.IRAEvents`。这些 UI API 用于核对官方端到端调用与事件；产品嵌入路径在 S0 定位安装版 core 的最小调用，避免默认给无界面 worker 引入 UI 生命周期。
- 本地复用 [human-crowd/plugin.ts](../packages/human-crowd/src/plugin.ts)、[operations.ts](../packages/human-crowd/src/operations.ts)、[human_adapter.py](../packages/sim-isaac/python/human_adapter.py)。
- 本阶段尚无可交付的完整公开 core 源码链接；必须在安装版核对模块来源、API 和许可。新增范围限于配置、实体映射与生命周期适配，人物导航、行为树执行和 writer 使用 SDK。

输入：S0 安装版 IRA API，现有 human-crowd 资产与启停合同，S1／S2 的来源和采样约定。

步骤：

1. 在一个小型场景里核对官方角色 schema、骨架／motion library、NavMesh、渲染和写回方式与现有人体资产的差异。
2. 先验证官方 runtime 能否在已有 stage 与唯一物理时钟下执行行为；将其样例中的自建 SimulationApp／时间线推进从集成路径剥离。
3. 在 human-crowd 扩展明确的行为配置；常规路径与 IRA 路径按配置选择，单个人物由一个执行方控制。
4. 第一场景采用“巡逻 → 区域／碰撞事件 → 停留 → 继续”，先用 routines／triggers；行为树为后续同一配置的另一种行为模式。
5. 同一群组在 routines／triggers 与 behavior_tree 之间二选一；官方动画机器人节点只用于明确的动画角色，真实机器人继续走已有动作执行与任务判定。
6. 配置保留组／角色 seed、参数、事件顺序与版本。crowd_start／stop、暂停、保存重开沿现有 operation 和世界生命周期处理。
7. 记录人物状态、机器人观测、事件和真实采集的关系；图像与物理接触分别验证。

写域：human-crowd、sim-isaac 的人体／行为适配和必要 UI。官方样例或 SDK 接口按其许可使用。

验收：固定 seed 与配置可复现生成条件；三次短运行分别记录行为和事件差异，确定实际可复现范围；停止只影响所选人物；保存重开恢复声明；在目标 Isaac 模式下验证同世界机器人、人群、碰撞和相机。

停止条件：若 SDK 只能独占应用或自带物理时钟，当前同世界接入标阻断，给出具体 API 证据；独立 SDG 只能作为另一个明确交付，不代替本阶段完成。

### S6 NuRec 渲染、重建质量与场景组合

**对应源码与复用范围：**

- 渲染直接调用 [render.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/render.py) 的 `RenderTargetFactory`、`CameraRenderer`／`render_at_keyframe` 和适用的 `render_keyframes`。
- 设置与输出复用 [rendering_setup.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/rendering_setup.py) 的 `setup_for_rendering`、[manifest.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/manifest.py)，在产品侧补资源与世界来源映射。
- 评估直接调用 [eval.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/eval.py) 的 `evaluate`／`render_and_score`；图像指标使用 [metrics/psnr_ssim.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/metrics/psnr_ssim.py) 的 `score`／`psnr`／`ssim`／`image_diff`。
- 上游回归参考：[test_render.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/tests/test_render.py)、[test_metrics.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/tests/test_metrics.py)。
- 本地新增范围：NuRec 资源事实、现有 Kit 中的调用适配、相机／时间／产物身份、任务入口与 UI。渲染器、指标和对照图优先使用上游实现。

输入：一个来源、格式和坐标可核对的 NuRec USD／USDZ，参考机位与参考图；S0 的扩展及设备条件。

步骤：

1. 先检查 NuRec particle／volume／SPG 路径、相机和依赖；普通 PLY／SPZ 不直接按 NuRec USD 处理。
2. 在现有资源导入中保存 NuRec 来源类型、单位、坐标与依赖。需要组合场景时以外层 USD 引用 USDZ，遵循 6.0.1 已知组合限制。
3. 在专用评估世界里复用 RenderTargetFactory／CameraRenderer，按已知机位或冻结轨迹渲染，记录 stage、相机、姿态、时间和图像文件。
4. 离线评估的轨迹时间与活动物理世界时间分别命名。只有与真实物理状态绑定的采集才附对应 world／step；采集前后核对步数。
5. 通过官方 evaluate 输出参考图、渲染图、差异图和 PSNR／SSIM。质量阈值在固定样本上审阅后冻结，再用于后续回归。
6. 在单场景中加入一个 SimReady 物体和机器人，检查遮挡、尺度、相机投影及动态物体成像；地面／障碍碰撞由明确几何提供并单独验证。
7. 复用既有原件／派生／产物路径和 Viewer 来源标签；图形能力保持按设备、格式与具体场景声明。

写域：scene-kit NuRec 资源事实、sim-isaac 渲染适配、robot-workflows 的离线评估 operation 与结果展示。

验收：同机位坐标一致；参考帧和渲染帧可逐张定位；不会切换其他活动世界的 stage 或推进其时间；真实图形审阅与指标报告分别完成。首个验证集冻结约 10 个机位，用于发现重影、漂浮物、遮挡和曝光问题。

交付：单场景兼容性结论、成像与性能分阶段报告、实际视觉证据和明确的碰撞来源。

### S7 Mimic 扩增与 Lab 策略交付

**对应源码与复用范围：**

- 扩增直接调用 [data_generator.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/data_generator.py) 的 `DataGenerator.generate`。物体相对轨迹变换已有 `transform_source_data_segment_using_object_pose`，片段选择已有 [selection_strategy.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/selection_strategy.py) 的 `make_selection_strategy` 和 nearest-neighbor 策略，拼接已有 [waypoint.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/waypoint.py) 的 `WaypointSequence`／`WaypointTrajectory.merge`。
- 任务适配遵循 [ManagerBasedRLMimicEnv](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/envs/manager_based_rl_mimic_env.py) 的 `get_robot_eef_pose`、`target_eef_pose_to_action`、`action_to_target_eef_pose`、`get_object_poses` 与子任务信号接口；具体例子为 [franka_stack_ik_rel_mimic_env.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/envs/franka_stack_ik_rel_mimic_env.py)。
- 离线入口直接采用官方 [annotate_demos.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/scripts/imitation_learning/isaaclab_mimic/annotate_demos.py) 的标注流程和 [generate_dataset.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/scripts/imitation_learning/isaaclab_mimic/generate_dataset.py) 的生成入口，按 S0 的实际 CLI／脚本参数调用。
- RSL-RL 模型导出直接调用 [exporter.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_rl/isaaclab_rl/rsl_rl/exporter.py) 的 `export_policy_as_jit`／`export_policy_as_onnx`；其他训练库使用 [entrypoints/backends](https://github.com/isaac-sim/IsaacLab/tree/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_rl/isaaclab_rl/entrypoints/backends) 中对应的导出入口。
- 上游回归参考：[test_generate_dataset_franka_state.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/test/test_generate_dataset_franka_state.py)、[test_leapp_recurrent_state.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_rl/test/export/test_leapp_recurrent_state.py)。后者只用于对应 LEAPP 路径的循环状态对照，TorchScript／ONNX 仍核对其实际导出器。
- 本地复用 [adapter.ts](../packages/policy-registry/src/adapter.ts)、[execution.ts](../packages/policy-registry/src/execution.ts)、[predicates.ts](../packages/sim-task-check/src/predicates.ts)。新增范围为自定义任务、机器人／物体映射、原生 Job 包装、模型输入输出合同与证据关联；扩增和模型导出算法沿上述实现。

输入：S2／S4 的有效示教，以及独立的固定 Lab 运行环境。

步骤：

1. 在独立 Lab 项目中注册与真实数据匹配的任务，明确 reset、初态、观测、EEF／夹爪动作空间、控制频率及 success 判据。
2. 映射机器人、参考物体和坐标；按 Mimic 合同提供 EEF 位姿、目标到动作转换、物体位姿与子任务结束信号。
3. 首先回放一个示教，再重新执行动作；以实际物理终态检查映射。初始数据不能被官方 reader 正确解释时停在数据修复。
4. 首轮选约 5 条真实成功示教、生成约 10 个候选布局。按对象相对位姿变换、片段选择、waypoint 拼接调用官方实现，保存每个尝试及筛选结果。
5. 成功数据进入扩增集，失败尝试及原因进入报告。候选数量、有效数量、碰撞／IK 失败和预算分别记录。
6. 如后续明确执行训练，先冻结算法、数据分区、随机种子、GPU／时间预算与成功标准，再跑一个限定 BC／RL 试验。训练阶段是独立资源任务，扩增完成不会自动启动训练。
7. 对实际训练库调用对应导出器。RSL-RL 导出同时验证 normalizer、LSTM／GRU 状态与 reset；其他算法使用其真实支持的导出路径。
8. 在现有 policy-registry 记录模型、hash、动作／观测合同、关节映射、控制周期和 reset 语义，走 policy_match／execute／stop。
9. 导出前后以固定输入比较网络输出；返回 Lyapunov 后使用真实世界验证，分别记录源引擎与目标引擎的结果。

写域：robot-workflows 的离线任务、规划中的可选 Lab 任务包、policy-registry 的具体适配与运行准备。Lab 环境保持独立，不替代产品 Host 或 Agent Graph。

验收：示教可执行、扩增候选可追溯、任务判据一致；模型数值误差容差在选定导出 dtype／后端时冻结；网络输出一致与物理成功分别通过。换引擎的策略重新验收。

交付：小型扩增集、生成报告；执行了训练时另交模型、导出数值对照、运行和停止证据。

### S8 按真实缺口引入差分 IK 与随机化

**对应源码与复用范围：**

- IK 直接采用 [differential_ik.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/controllers/differential_ik.py) 的 `DifferentialIKController.set_command`／`compute`，其 `dls`／`adaptive_dls` 求解和关节限位偏置已有实现；配置沿同目录 [differential_ik_cfg.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/controllers/differential_ik_cfg.py)。
- 随机化直接使用 [envs/mdp/events.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/envs/mdp/events.py) 的 `randomize_rigid_body_material`／`randomize_rigid_body_mass`／`reset_root_state_uniform` 等任务所需项；在 Lab 环境使用其 [EventManager](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/isaaclab/managers/event_manager.py)。
- 上游回归参考：[test_differential_ik.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/controllers/test_differential_ik.py)、[test_event_manager.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab/test/managers/test_event_manager.py)。
- 本地已有 [motion-mink/plugin.ts](../packages/motion-mink/src/plugin.ts) 与 [solve.py](../packages/motion-mink/src/solve.py)；优先复用已有规划。新增范围限于实际需要的 Jacobian／坐标／关节输入适配，以及产品任务参数到既有 Scene／sync 的映射。

输入：S4／S7 暴露的具体算法或任务需求。

步骤：

1. 用固定 TCP、关节顺序与目标对照现有 Mink 路径，区分离线规划与在线连续伺服的需要。
2. 需要在线伺服时，在已有控制适配中采用 Lab 的 damped／adaptive damped IK 算法，Jacobian 和关节状态从真实 Provider 取得；该算法不自行 step。
3. 检查奇异位形、关节限位和全受控关节输出；坐标与 quaternion 按统一合同转换。算法依赖留在可选运行环境。
4. 需要扩增条件变化时，逐项接入质量、摩擦、初始位姿等随机化，保存 seed、采样值和原生回读。改变物理配置使用现有 Scene／sync 或任务 reset 入口。
5. Lab MDP events 的物理随机化与 IRA 的人物行为事件保持各自领域职责。

验收：既有规划回归通过；新增算法在冻结目标集上记录位置／姿态误差与耗时；随机值真实生效，固定 seed 可复现采样配置。不因上游已有模块而强制安装全部算法。

### S9 集成交付、文档与发行候选

**对应本地源码与复用范围：**

- 自动化直接使用 [test-ci.ts](../script/test-ci.ts)、[测试清单](../script/test-ci.manifest.json)、[build-plugins.ts](../script/build-plugins.ts)、[release-gate.ts](../script/release-gate.ts)、[CI 工作流](../.github/workflows/ci.yml)；各阶段的上游测试作为相应行为的对照。
- 界面装配与交互沿 [lyapunov-shell/plugin.ts](../packages/lyapunov-shell/src/plugin.ts)、[runtime-patch.ts](../script/runtime-patch.ts)，录制和资源结果继续由各自 operation 提供。发行使用现有 [package-linux.ts](../script/package-linux.ts)。
- 本地新增范围：功能专属测试与清单登记、既有界面的能力投影、使用文档和真实验收记录；保持现有构建、CI 与发布入口。

输入：已完成阶段的实际提交、测试回执、运行报告与产物。

步骤：

1. 汇总实际可用的版本／机器人／引擎／设备矩阵，未完成的能力保留原状态。
2. 在相关用户路径完成“清单 → 选择 → 属性／操作 → 停止／失败处理 → 产物 → 保存重开”；人工和 Agent 各走同类任务。
3. 对触达界面完成键盘、焦点、空态、加载、错误、长名称、窄窗和真实视觉审阅。未触达换手等功能不扩大走查。
4. 更新能力总表、操作手册、相关安装说明与发布说明。产品名称、账户和引擎选择语义沿现有 owner。
5. 主控在最终交付版本执行既有 CI 入口和需要的构建；准备发行候选时再执行 release-gate、打包与解包运行检查。
6. Linux 的 SDK／GPU 实测、macOS 的工作台／缺依赖行为、Windows 的适用运行分别取证；不把 Linux 结果推广为其他平台验收。
7. 打包排除运行环境、权重、私有录制与凭据。保留真实许可与源码来源。

交付：实际变更清单、自动化结果、物理／成像／交互／设备报告、用户可复核产物、已知问题。公开发布另按用户的实际发布授权执行。

## 6. 自动化验收与实际入口

所有命令从 Dev 根目录执行。以下为实施阶段已确认存在的入口；本次方案编写未运行产品测试。

```bash
# 核对离线测试分类、执行器及清单完整性，不运行测试
bun run test:ci:list

# 产品类型；改动 gate 驱动时再跑第二条
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json

# 按阶段选择对应包，示例采用现有包名
bun run script/build-plugins.ts robot-workflows sim-isaac scene-kit

# 使用正式测试清单的路径筛选，报告写入本次任务产物目录
bun run test:ci --filter robot-workflows --json "$LYAPUNOV_TASK_ARTIFACTS/robot-workflows.json"
bun run test:ci --filter sim-isaac --json "$LYAPUNOV_TASK_ARTIFACTS/sim-isaac.json"
bun run test:ci --filter scene-kit --json "$LYAPUNOV_TASK_ARTIFACTS/scene-kit.json"

# 集成后的同一候选跑一次完整离线集；准备发行时才跑发行门
bun run test:ci --json "$LYAPUNOV_TASK_ARTIFACTS/ci.json"
bun run release-gate
```

`LYAPUNOV_TASK_ARTIFACTS` 为执行前显式设置并创建的本次产物目录，例如忽略的 `.runtime/isaac-adoption/<run>/`。命令要分别保存 stdout、stderr 和退出码；它不是产品运行根的替代。

新测试按真实副作用登记到现有 [test-ci.manifest.json](../script/test-ci.manifest.json)，不整份重生成清单。Capture、human-crowd、policy-registry 等阶段使用相同 `--filter` 机制选择其路径；新插件构建传入其实际包名。

SDK／GPU／XR／网络和官方回读测试使用实现后真实存在、纳入相应分类的入口；S0–S2 确定准确命令，不能把尚未创建的脚本写成已存在入口。真实物理驱动须核对实际实例化的 Provider；现有 G02–G07 的 MuJoCo harness 不可通过参数文字变成 Isaac 验收。

| 层次 | 主要判定 | 记录内容 |
| --- | --- | --- |
| 静态与离线 | 类型、schema、映射、错误、生命周期与数据负例 | 被测提交／工作区、准确命令、退出码、实际执行集合 |
| 上游互通 | 官方 reader 回读、已选 SDK API、导出前后数值 | SDK 版本、配置、样本数、差异与错误对象 |
| 真实物理 | 实际步数、控制应用、接触与任务终态 | world／generation、模型／资产版本、任务判据和读数 |
| 图形与数据质量 | 真实相机、标定、帧对应、NuRec 对照 | 相机与姿态、数据文件、指标、人工视觉结论 |
| 交互与设备 | 人工／Agent 流程、停止、Pico 输入与延迟 | 设备与系统版本、操作范围、实际截图／录制和缺项 |
| 发行 | 构建、依赖闭包、解包启动、退出与持久化 | 候选 hash、平台、运行命令和实际结果 |

主控先审实际 diff，再独立运行相关自动化；执行方自报不能替代该步骤。无新改动或失败时不重复扩大测试。准备发行候选时，注意 release-gate 自身会按选中判据运行其所需完整 CI，避免把重复执行误当新增证据。

## 7. 任务拆分、回执与停止条件

每个阶段作为一个可独立审查的功能交付；S1 可按合同、MuJoCo、Isaac、录制四个顺序提交，S4 可按普通输入与 XR 两个顺序提交。每次提交只包含本阶段实际修改，来源说明和许可随引入代码一起提交。

后续如果用户要求派发执行，采用其已经规定的执行器与合同：主控先检查阶段目标目录与实际测试入口，传入完整目标、上下文、写域、步骤、验收、回执和停止条件；执行方返回必要 diff、关键代码、真实命令与日志，主控再独立验收。当前方案没有派发任务，也不以此授权新增代理。

每份阶段回执至少包括：完成／部分完成／阻断、修改文件与接口、复用来源及实际调用点、相对上游的补丁差异、新增代码职责、被测版本、命令／退出码／结果／日志、真实运行范围、未完成项与下一步。

共同停止条件：

- 版本／API／许可或指定 Hub 镜像对象不满足时，点名对象和缺失条件，停止该依赖链。
- 身份、代次、控制权或数据时序不一致时，结束当前样本／作业并保留证据，修复后重验相关项。
- 官方模块要求独占 stage／时间线，且无法接到既有生命周期时，先给出技术阻断与可验证改法。
- 进入额外训练预算、全局环境改动、兄弟仓库写入或公开发布前，以后续实际任务范围和授权为准。

## 8. 分批完成条件

第一批（S0–S4）：一个确定机器人通过资产验证，普通设备可控制；真实控制样本可导出并由官方 reader 回读，动作重新执行有物理终态证据。XR 按实际设备独立记录。

第二批（S5–S7）：一个可重复配置的人群事件场景，一个 NuRec 成像对照场景，一个可追溯的 Mimic 扩增任务。训练与策略运行只在实际执行过的任务上给出结果。

按需扩展（S8）：已有方案暴露了明确算法／随机化需求，新增实现解决该需求并通过限定对照。

集成交付（S9）：所有声明能力有对应版本、接口、自动化与真实任务证据；文档、界面、产物与回执口径一致。

## 9. 本次方案校验记录

本次文件为方案文档，追加了逐阶段源码／函数／上游测试入口和复用边界，并将 GitHub 文件链接固定到已核对提交。未修改产品代码、依赖、配置、CI 或原则正文。校验包括阶段与候选覆盖、仓库相对链接、GitHub 固定提交下的源码路径、关键函数、示例命令与实际入口、Git 写域及 whitespace。产品 CI、上游测试、SDK、GPU、图形、设备与训练属于后续阶段验收，本次未运行。

本次源码定位核对了 51 个固定提交下的源码／测试入口（包含一个导出器目录），以及 20 份关键源码中的指定类／函数。路径存在性对照相应版本的 Git tree，函数名对照已读取源码。IRA 另列安装版 SDK 模块、官方 API 与原件配置路径；其完整 core 源码位置和安装版运行兼容性仍在 S0 核对。
