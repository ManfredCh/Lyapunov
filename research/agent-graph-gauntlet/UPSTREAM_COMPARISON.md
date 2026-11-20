# Gauntlet 与 Lyapunov Agent Graph 的代码对比

上游为 Google DeepMind `robotics-antigravity-plugin` `0.1.11` 的固定提交 `9cb7f624c4d7c50859a39f1d49d088990429a83d`。对照的是 Lyapunov Dev 从 `0373d9a3` 继续开发的实现。上游采用 Apache-2.0。这里使用现有 Agent Graph 与 MuJoCo Worker 的接口实现相同评测思想。 [固定源码](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics)

## Gauntlet 模块与接入位置

| 上游入口 | 上游具体机制 | Lyapunov 对应实现与验证边界 |
| --- | --- | --- |
| `task.py` `Task`、`SafetyLimits` | 按试验创建可复位的仿真或真机设备层，独立声明任务终态、设备键和力限。 | `CampaignTask` 保留任务、Scene 和谓词。`worldId`、代次与 Scene revision 共同约束录制和判定。本轮 `requirePreflight` 增加同起点、原生物理证据的资格。设备白名单和逐步力限仍待接口及设备实测。 |
| `perturb.py` `streams`、`sample`、`apply_static`、`DisturbanceDevice` | 从键派生随机流。仿真端应用质量、位置、摩擦等静态变化及运行时滑动、撞击和通信故障。 | `run-so101-paired.ts` 已用种子和扰动档计算可审计的目标位置、质量与摩擦。原生第 0 步快照指纹和声明的条件摘要共同约束两组。运行时故障和 HMAC 隐藏种子尚无接入证据。 |
| `preflight.py` `_audit`、`run` | 审核编译模型的对象约束和驱动，再用正确入盒及悬停、在外、错误物体等状态验证成功判据。 | SO-101 驱动先真实运行四个正反例，逐对还要求原生第 0 步实际判为未达成。编译资产的焊接与碰撞全量审计可由资产导入验证承担，当前还未纳入每次 campaign。 |
| `episode.py` `run_episode`、`run_suite`、`fork`、`settle` | 可取消执行、记录控制动作、结束后的稳定窗口、从指定步重放并分叉。 | Agent Graph 已有 run 生命周期与 DSH Jobs。完整抓放由原工具分阶段执行，录制索引和实际回执绑定到 pair。上一轮 [抓取失败分叉](../so101-grasp-fork/README.md) 已验证离线同状态恢复。在线 Provider 的跨引擎分叉接口目前未实现。 |
| `wrappers.py` `Recorder`、`McapWrapper` | 帧和控制原件记录，通用 MCAP 输出。 | 已有 `recording_*` 原生录制、`calls.jsonl` 与回执一并保留。现在新增结构化抓放动作索引、终点步号及请求目标的接触步数和位移。需要跨工具链传输时可在录制导出层实现 MCAP 适配。 |
| `wrappers.py` `CommandLimitWrapper`、`CameraTimestampWrapper`、`SensorWrapper`、`FaultWrapper`、`LatencyWrapper` | 以设备范围对命令限幅，按同一时钟标记相机帧，对控制器注入指定传感器故障与延迟。 | 原生 Worker 执行已有的关节和执行器边界，腕相机采集具有世界身份与真实帧戳。完整故障注入链还需明确帧源、触发 tick 与可观察的停机回执。 |
| `proxy.py` `AllowlistLayer`、`RemoteDeviceLayer`、`serve` | 控制器看到设备白名单。评测器另外持有带接触和完整位姿的读数。 | 现有 Agent 运行在 DSH 会话，评测层从原生 `sim_task_check` 独立取值。腕相机纠偏用颜色与 RGB-D，完整场景裁切到真机可观测设备的隔离层仍待验证。保持 DSH 会话与现有端点归属。 |
| `grade.py` `grade`、`poses_at` | 将完成、正常停止、故障中止、碰撞／夹持力和旁观物体状态分别判定。 | 本轮保留终态任务谓词、抓放动作的 `targetReached` 和失败原因，严格配对要求物理执行且全程原生辅助推进计数为零。旁物和释放仍由任务谓词给出。未集成动态碰撞和力限安全评分，不能由终态成功推出全程安全。 |
| `scorecard.py` `compare`、`summary` | 先对齐任务、扰动档、序号、种子与场景摘要，再对分歧对做精确检验。新严重违规可否决晋升。 | `campaign_status.comparison` 按档与全局返回完整对、无效原因、单边通过数、成功率及双侧精确 McNemar 值。当前评分针对任务完成。力限和故障验收进入证据前，自动晋升继续依赖既有 Verifier 合同。 |
| `cli.py`、`__init__.py`、`pyproject.toml` | 解析任务驱动、运行套件、选择渲染后端并管理 demo 包依赖。 | 沿用 `campaign_*` 原生工具、现有 Bun 构建与 MuJoCo 验收驱动。`--comparison descent` 对照完整入盒，显式选择同一 MuJoCo 模型和 EGL。 |
| `examples/playground_tasks.py` | 碗中方块、插孔、叠放及设备初始化。 | 以已有 SO-101 分拣与四个目标控制场景作为最小落地。插孔与堆叠可以新增独立谓词实验。 |
| `examples/color_blob_ik_controller.py` | 用可观测的 RGB-D 和关节信息驱动接近、抓取、撤离与故障停止。 | 本轮两组共用实测腕相机 RGB-D、Mink、夹爪宽度校准与转运路径，只改变下降路径。 |
| `examples/rgbd_ik_perception.py` | 深度反投影、桌面拟合、带高度的点簇、末端对位和名义模型防撞区域。 | 现有腕相机模块已实现标定平面下的颜色和高度筛选。桌面在线拟合、未见物体的泛化定位和机身自遮挡鲁棒性需要新的样本。 |

上游 README 提到 `tests/gauntlet_test.py` 与 `tests/solvability_test.py`，固定提交的归档未包含这两个文件。Lyapunov 以自身原生工具、回归测试和真实 MuJoCo 实验验收。 [Gauntlet 代码目录](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-gauntlet)

## 同仓其余能力与 Agent Graph 的关系

| 上游能力 | 结论 |
| --- | --- |
| `motion-planning/scripts/motion_planner.py` | 自由空间和末端临近接触分成不同路径。经分叉对照，本轮把临近阶段的多点逆解接入现有 Mink。携物连续净空需要把物体和空间障碍纳入规划的碰撞模型。 |
| `rgb-object-localization`、`visual-servoing` | 原帧、深度和外参回执已用在 SO-101 腕相机流程。本轮实现目标缺失或触边后的单次有界退远复拍。完整闭环六自由度调整需单独验证相机失帧和不可达姿态。 |
| `iteration`、`sim2real-iteration` | 借鉴迭代时分开冻结条件、记录动作阶段、从失败步复测。Dev 已有研究时间线和分叉录像。 |
| `mujoco-audit`、`blender-creation`、`mujoco-showcase-shot` | 分别覆盖编译资产测试、生成形体和渲染。可作为 `asset_verify` 的前置及实验证据导出，适用箱、杯和夹具。 |
| `mujoco-studio-sidecar` | 侧边栏由 MuJoCo Studio 和本机辅助进程承载；Lyapunov 的观测路径为 Viewer 与会话录制。借鉴面板状态更新及历史帧定位即可复用。 |
| `mujoco-playground`、`mujoco-playground-rl` | 用于复用 SO-101／YAM 示范、训练及设备部署。对目前的 Agent Graph 改动，原生 `robot_pick` 和 `sim_task_check` 已提供控制与终态判定入口。 |
| `so101-bringup`、`so101-calibration` | 可用于下一轮串口、电机和手眼标定，真实设备参数、优先序和停机条件需实测。 |
| `i2rt-yam-bringup`、`i2rt-yam-ik`、`fr3-duo-control` | 属于机型适配。以后接入相应硬件时，再通过同一个评测证据接口挂接。 |
| `share-example` | 上游仓库的示例分享流程。Lyapunov 继续用自身实验目录和录制导出。 |

## 这轮接入保留的边界

分段下降通过多点逆解约束 TCP 路点。其间仍由原生执行器做关节插值，碰撞检查状态保持 `false`。`robot_pick` 仅在显式请求 `descentSegments` 时走这条路径，规划器忽略请求或中间路点不可达会给出具名失败。参考组和候选组都使用同一个终态 `sim_task_check` 和实体初态核对。腕相机与分段试验只在 Dev 内验证，统计字段支持分析，技能源晋升仍由 Verifier 负责。
