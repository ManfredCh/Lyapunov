# AGY Robotics 与 Lyapunov 组合技能

集成目标是让 Agent 在同一会话组合资产、定位、运动规划、抓放、安全评测和录制，并沿用 DSH Jobs、Scene、Sim 与 Agent Graph 的状态和调用协议。范围以 Google DeepMind Robotics 0.1.11 的固定提交 `9cb7f624c4d7c50859a39f1d49d088990429a83d` 为准。18 项技能均已加入产品技能目录，另有七项 MuJoCo API 指南及组合入口 `robotics-composition`。上游实现的归属、许可、原件与随包字节哈希可核对。 [上游固定版本](https://github.com/google-deepmind/robotics-antigravity-plugin/tree/9cb7f624c4d7c50859a39f1d49d088990429a83d) · [源文件清单](../../packages/robot-workflows/python/agy/source.json)

## 18 项处理结果

| AGY 技能 | Lyapunov 入口与运行边界 |
| --- | --- |
| `blender-creation` | 上游网格和材质工具由原生 `blender_run` 调用，实际生成可重开的 Blender 工程及 GLB。 |
| `fr3-duo-control` | `fr3-duo-check` 在 Menagerie FR3 双臂模型上检查同时采样的两臂几何。真机双臂通信、Robotiq 和相机仍依赖工位。 |
| `i2rt-yam-bringup` | CAN、相机、SDK 的本机只读盘点与启动流程。当前无 CAN 设备和 I2RT 驱动。 |
| `i2rt-yam-ik` | 同版本 Menagerie YAM 加 Linear 4310 上跑通上游 IK 和独立 FK 误差。 |
| `iteration` | 由原生 `skill-debug` 跟踪失败、修复和同条件复查。 |
| `motion-planning` | 原样接入上游 Bi-RRT、携物球模型和直线采样诊断。执行仍由当前 Provider 的世界身份和实测状态约束。 |
| `mujoco-audit` | 软件保留原静态审计及十动力学工况。真实编译、执行和生成帧。 |
| `mujoco-playground` | 复用 MuJoCo 光学模型与相机坐标转换。原生支持示范录制和导出。Playground DeviceLayer 真机／仿真桥需 REAF、Torch 等依赖。 |
| `mujoco-playground-rl` | 复用上游 RL 源码静态检查。独立 Playground CPU 运行时通过原生 `playground_train_so101` 实际更新 PPO，保留 checkpoint。策略成功率、回放和迁移另验。 |
| `mujoco-showcase-shot` | 原上游多视角渲染可从 Job 取出 28 格视效和碰撞检查图。 |
| `mujoco-studio-sidecar` | 产品工作台 Viewer、场景树、相机和录制承接在线查看与回放。AGY Studio sidecar 桥保留为上游参考。 |
| `rgb-object-localization` | 双视角匹配、平面掩膜反投影和单应矩阵。实测捕捉 MuJoCo RGB，并将定位结果直接交给避障。 |
| `share-example` | 实验报告、可复跑配置、许可与录制交给工作台现有导出和分享路径，外发由用户授权。 |
| `sim2real-gauntlet` | 上游五档采样器、现有严格配对及安全评分，增加 Graph 调用 MCAP 导出。T0–T4 的参数表和当前实装的 SO-101 扰动分别有证据。 |
| `sim2real-iteration` | 复用 Worker 分叉及 Verifier 的独立证据准入。在线快照有当前 Worker 生命周期限制。 |
| `so101-bringup` | 已有 SO-101 物理仿真，新增设备盘点与型号准备流程。当前无对应串口和 LeRobot。 |
| `so101-calibration` | 接入上游投影标定拟合及逐点误差。当前用可控投影数据验证，现场采样与末端手眼标定仍需设备。 |
| `visual-servoing` | 上游 IBVS 阻尼求解器、速度限幅和末端旋量计算。原 SO-101 RGB-D 纠偏继续可用，整臂 6-DoF 闭环尚未接入。 |

七项 MuJoCo API 指南按产品接口编写，范围是 Python、MjSpec、渲染、加速、后端一致性、Studio、GUI。原包的完整代码、硬件操作、平台进程和部署脚本按上表的实际接入边界判断。 [MuJoCo API 技能上游](https://github.com/google-deepmind/mujoco/tree/main/doc/skills)

## 组合调用

用原生 `skill` 加载 `robotics-composition`。先调用 `scene_workflow_capabilities` 确认解释器，再用 `robotics_lab` 的 `probe` 读取各操作的缺失包。该工具使用现有的原生 Job，模型和工作台通过同一个 `job_output` 读取结果及产物。MJCF、掩膜与任务 JSON 取自当前工作区。MJCF 的依赖放在模型目录树内。MCAP 使用已授权导出的 `calls.jsonl` 副本。

产品沿用当前 MuJoCo Python。还可用 `LYAPUNOV_ROBOTICS_LAB_PYTHON` 配置独立的兼容 Python，额外媒体和 MCAP 依赖为 [依赖表](../../packages/robot-workflows/python/requirements-robotics-lab.txt)。MuJoCo 记录、账号隔离、技能晋升和 Agent Graph 配对的责任仍由原 owner 承担。

Playground 独立解释器由 `LYAPUNOV_PLAYGROUND_PYTHON` 指定，训练使用用户提供的工作区 SO-101 模型和固定 `SO101PickCube` 环境。验收用 Playground 1.0.1、MuJoCo 4.0.1.dev1016247317、Torch 2.11.0+cpu 与 RSL-RL 5.4.2，保留 `training.log` 和真实 checkpoint。Dev 的原生仿真继续使用 MuJoCo 3.13.0。

## 运行证据

独立工作区用产品原生加载路径找到 26 个新技能入口。最终实跑 17 个 `robotics_lab` Job、1 个 Playground PPO Job 和 1 次 Blender 建模。显式建模台面和隔板后，RGB 加 Bi-RRT 的起点误差为 1.79 mm，最小采样净空 10.34 mm。直线路径首次侵入障碍 4 mm。精确起点 Bi-RRT 和 RGB 起点 Bi-RRT 都从隔板上方通过。SO-101 的既有抓放与安全候选回归 12 对，参考 7/12，候选 6/12，保留 27 个录像文件。Playground 使用另一 Python 前缀完成 1 次 PPO 更新。真实硬件未连接或未提供工位端点。

原件在 Dev 的 `.runtime/so101-paired-evaluation/robotics-lab/acceptance/`，入口为 `index.html`，包括 3 种路径、两个真实渲染 RGB 帧、资产审计与多视角图、原始抓放视频、MCAP 与 SHA-256 清单。第一批与恢复后的报告均保留。提交的 [摘要](summary.json) 可用于后续对照。

## 复跑

固定 Menagerie 提交 `370c43965323c0944b433b202aac5058b5f907a9`，准备 `i2rt_yam`、`franka_fr3_duo` 子树和校验清单 `supply.json`。以下命令从 Dev 隔离工作树执行。SO-101 回归按 [现有配对驱动](../so101-native-evaluation/README.md) 输出至同一报告根的 `so101` 子目录。

```bash
MUJOCO_GL=egl /path/to/python research/agy-robotics/prepare.py /path/to/evidence/final-v4 \
  --so101 /path/to/robotstudio_so101/asset/so101.xml --menagerie /path/to/menagerie \
  --playground-so101 /path/to/menagerie/robotstudio_so101/so101.xml
node --experimental-transform-types research/agy-robotics/run-native.ts \
  /path/to/evidence/final-v4 /path/to/python /path/to/blender /path/to/playground/bin/python
/path/to/python research/agy-robotics/report.py /path/to/evidence
```
