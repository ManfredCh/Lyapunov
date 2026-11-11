# Isaac 生态接入实施记录

按 [接入方案](ISAAC_ECOSYSTEM_ADOPTION_PLAN_20261110.zh-CN.md) 逐阶段实施和验收。S0–S4 已完成当前批次的验收，S5–S9 的进展见后续记录。

分支：`codex/isaac-s0-s4-20261110`。起始提交：`683b34256bd30283b5d3af40c9622876a3fd5c69`。已有 `design/`、`lefthook.yml` 与人体资产目录保持原状，不进入本任务提交。

## S0 固定来源与运行依赖

状态：完成本批所需组件的依赖与导入验收；Kit、物理、图形和设备验收在后续阶段分别执行。

复用来源：

- Isaac Lab `e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4` 的 EpisodeData、HDF5DatasetFileHandler、数据基类及其 math 依赖，四份文件保持上游字节，BSD-3-Clause 许可随代码交付。
- 四份模块放在独立 `vendor.isaaclab_data` 命名空间，初始化文件只建立命名空间。这样导出器可直接调用上游算法，并避免导入 Lab 根包时更改物理 SDK 的搜索路径；未重写 HDF5 读写或数学函数。
- Capture `2b72b3aac75f87e5043bcb3411f9a75c294f7ba7` 对应安装版 `isaaccapture==1.8.29a1`。SE3、TensorReorderer、GripperRetargeter 的安装源码 SHA-256 与参考提交一致；原生算法通过 SDK 调用。
- 产品 Isaac SDK 6.0.1.0、Python 3.12.14 及既有 EULA 标记检查通过；asset validation 扩展存在。本次没有写入许可接受标记。

实际依赖：独立导出环境 Torch 2.11.0+cpu、NumPy 2.2.6、h5py 3.15.1；独立 Capture 环境 NumPy 2.2.6、SciPy 1.17.0、PyYAML 6.0.3。产品物理环境没有被安装器修改。

版本核对发现：Lab 固定提交的 pyproject 声明旧包名 `isaacteleop~=1.4.145`，而当前 Capture 源码已更名。本批分别固定数据模块与 Capture 运行包，并逐文件比较使用的重定向实现；完整 Lab 与 Capture 组合在 S7 再验收。

主控检查：

- `bun run test:ci --filter isaac-upstream --json .runtime/isaac-adoption-20261110/receipts/s0-ci.json`：退出码 0，实际运行 1 个测试文件，通过 1、失败 0、清单缺件 0。
- `python3 script/isaac-adoption-preflight.py --export-python .runtime/isaac-adoption-20261110/export-env/bin/python --capture-python .runtime/isaac-adoption-20261110/capture-env/bin/python --isaac-python .runtime/conda/envs/isaac/bin/python --json-out .runtime/isaac-adoption-20261110/receipts/s0-preflight.json`：退出码 0，固定源码 hash、官方 HDF5 写入／回读、Capture 导入／源码一致、SDK 元数据检查均通过。

日志：`.runtime/isaac-adoption-20261110/receipts/s0-*`。运行目录、源码检出和环境均不提交。

未运行：完整 Lab／Mimic、训练、Kit world、RTX、设备输入与 CloudXR；这些不属于 S0 模块导入通过的含义。

## S1 控制步采样

2026-11-10 新加坡时间，MuJoCo 3.13.0 和 Isaac Sim 6.0.1 CPU 路径均通过控制步录制验收。

- 复用现有 `ProcessSimProvider`、Provider tick、`SimulationRecording`。采样沿 Lab `record_pre_step`／`record_post_step` 的边界约定，新增 `ControlSample` 值合同和既有录制作业中的独立 JSONL 通道。
- `node --experimental-strip-types --test packages/sim-contract/test/control-sampling-native.test.ts` 在两个后端各运行 1 个用例并通过。Isaac 通过 `LYAPUNOV_TEST_ENGINE=isaac` 选择，使用现有许可和 CPU 经验文件。
- 每个后端记录 3 个完整控制窗口。每窗 10 个 2 ms 步，前后关节状态连续，重复动作 ID 不重复采样，观察不推进。另实测动作中断产生带已执行步数的部分样本，并核对错误作业身份与旧世界代次被拒绝。
- 回执位于 `.runtime/isaac-adoption-20261110/receipts/s1-native.stdout.log`、`s1-isaac.stdout.log`。录制、会话归属和样本序列校验通过现有路径，未执行人为磁盘故障或 worker 崩溃注入。

## S2 Lab 示教数据导出

2026-11-10 新加坡时间，原生录制到 HDF5 以及固定 Lab 读回验收通过。

- 在既有 `recording_export` 中选择 `format: "isaac-lab"`。导出 Jobs 在独立解释器调用固定版 `EpisodeData` 和 `HDF5DatasetFileHandler`，以官方读取器逐字段比较后发布产物。工作台录制面板显示完整样本数和 HDF5 入口。运行时通过 `LYAPUNOV_LAB_EXPORT_PYTHON` 指定，依赖见 [导出环境清单](../packages/robot-workflows/requirements-lab-export.txt)。
- 独立映射检查用 S1 的 3 条原生样本写出并回读 1 个 episode。缺动作、非有限动作、来源变更、旧 schema 和缺初始状态的 5 组样本均被拒绝，未生成 HDF5。回执为 `.runtime/isaac-adoption-20261110/receipts/s2-export.stdout.log` 和 `s2-negative.stdout.log`。
- S4 原生验收通过 DSH 命令和工具入口各执行一次 `recording_export`。两个导出 Jobs 均为 `completed`，各发布 1 个 episode 和 13 条样本。产物保存录制、场景与实体标识、关节次序和单位、0.3 s 控制周期、xyzw 位姿及源 JSONL SHA-256。
- `bun run test:ci --filter recording --json .runtime/isaac-adoption-20261110/receipts/ci-recording.json` 退出码 0，5 个测试文件通过。任务映射继续标记 `unverified`，HDF5 的回读结果与 S4 真实抓放判定分别保存。

## S3 Isaac 资产验证

2026-11-10 新加坡时间，官方静态与可选仿真规则的独立 Kit 验收通过。

- `asset_verify` 保留资源文件完整性结果，可附 `isaacProfile` 和 `simulate`。SDK 调用与活动世界分进程，验证结果绑定资源版本及源文件 SHA-256。工作台的 USD 资源详情有独立的物理检查入口。
- `node --experimental-strip-types --test packages/sim-isaac/test/asset-validation-native.test.ts` 退出码 0，1 个用例覆盖 3 次原生检查。正常样例通过质量与碰撞规则，另运行 `NonAdjacentCollisionMeshesDoNotClash`。缺声明样例定位 `/Root` 的碰撞和质量问题。机器人规则样例执行了 `RobotSchema` 与 `CheckRobotRelationships` 并报出结构问题。两份原件的字节在检查前后一致。
- `bun run test:ci --filter simready --json .runtime/isaac-adoption-20261110/receipts/ci-simready.json` 退出码 0，1 个测试文件通过。原生报告为 `.runtime/isaac-adoption-20261110/receipts/s3-validation/reports.json`。

## S4 Capture 键盘与示教闭环

2026-11-10 新加坡时间，普通键盘路径的抓放、录制、导出、历史回放和原生重执行通过。Pico 4 Ultra 与 CloudXR 的设备验收尚未进行。

- 插件从现有 Profile 以 `LYAPUNOV_CAPTURE_PYTHON` 配置独立解释器，复用 Capture 的 `KeyboardSource`、`KeyboardToSe3RelRetargeter`、`KeyboardGripperRetargeter`，已安装文件与固定上游提交字节一致。产品侧复用现有 Mink 规划、`ctx.sim` 的位置参考控制、Jobs 与录制。夹爪需要模型提供 `controller.teleopGripper.open`／`closed`，按已核验的关节名指定位置目标。
- 工作台在 manual world 的录制面板选择实体并启动 Capture 键盘。绑定输入区后可平移、旋转或切换有映射的夹爪。遥操作和录制各自有停止入口。
- `node --experimental-strip-types --test packages/teleop-capture/test/keyboard-native.test.ts` 退出码 0。真实 Capture 和 Mink 处理预设按键，命令与 Agent 工具走同一 DSH 实现。过期事件和同世界重复占用被拒绝。实际 MuJoCo 抬升时观测到目标接触，目标中心抬至约 44.3 mm，最终位置约为 `[29.97, 0, 15.49]` mm。13 个控制窗口成功记录并导出，历史回放保持活动物理步不变，新世界重执行得到相同终态。
- 本次原生证据为 `.runtime/isaac-adoption-20261110/receipts/s4-native/capture-test-c4D4gR/evidence.json`，两个 HDF5 位于该目录的 `sessions/capture-native-test/datasets/`。测试日志为 `s4-native.stdout.log`，Capture 源码对照为 `s4-capture-source.json`。
- Chromium 520 px 窄视口加载真实 React 面板和现有样式，以固定接口夹具检查遥操作启动、键盘输入、Lab 导出和 USD 检查按钮的调用。DOM 回执为 `ui-dom.html`，截图为 `ui-panel.png`。真实物理与作业证据来自原生测试，浏览器夹具单独记录界面层。

## S0–S4 交付检查

- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` 退出码 0。
- `bun run script/build-plugins.ts robot-workflows teleop-capture scene-kit lyapunov-shell` 退出码 0。Mink 构建产物也由同一入口生成并用于原生闭环。
- `git diff --check` 退出码 0。提交钩子提示本机 PATH 未找到 Lefthook，以上主控检查独立执行并保留日志。
- 解释器、录制与验证产物位于私有 `.runtime/isaac-adoption-20261110/`。需要启用功能时，把 `LYAPUNOV_CAPTURE_PYTHON` 和 `LYAPUNOV_LAB_EXPORT_PYTHON` 指向各自独立环境的绝对解释器路径后启动工作台。

## S5 IRA 人群事件

2026-11-10 22:40（新加坡时间），官方角色加载已通过现有 stage 探针，行为运行阶段仍阻塞。

- 核对本机 Isaac Sim 6.0.1.0 的 `isaacsim.replicator.agent.core` 1.6.8 与 `omni.metropolis.pipeline` 0.0.9。安装版 core 的许可证限制再分发，探针直接导入。完整 `SimulationManager.setup_simulation` 会设置时间线帧率和时长，`AgentsManager` 根据 Kit 时间线事件更新角色。产品 worker 仍由现有唯一 `SimulationManager.step` 推进物理。[官方配置与行为约定](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_configuration.html) · [本地 worker](../packages/sim-isaac/python/worker.py)
- 通过 DSH headless 按阶段计划执行，派发达到 540 秒上限，留有实际 Kit 回执。运行时启用扩展遇到 USD 导航 schema 注册错误。主控随后在独立的 CPU Kit 探针中前置 schema 依赖，真实 `NavMeshAreaAPI.Apply` 成功。官方测试使用的同步烘焙随后生成 NavMesh。
- 主控将 IRA core 和 Metropolis schema 加到启动依赖后，固定 seed 7 的 `CharacterLoader.load` 成功加载两名官方角色。角色和两个 wander routine 均进入同一 stage，前后的 stage cache ID 为 9223001，root layer 相同，时间线均为 60 FPS、0 秒、未播放。进入运行阶段后进程收到 SIGSEGV，退出码 139。巡逻／触发／停留、单人停止、三次复现、保存重开及同世界相机与接触均等待运行阶段通过。
- `node --experimental-strip-types --test packages/human-crowd/test/isaac-native.test.ts` 退出码 0，2 项现有原生基线通过，覆盖 CPU 同世界人体与 USD 接触及既有动作生命周期。IRA 探针回执位于 `.runtime/isaac-adoption-20261110/receipts/s5-ira-core-start/`，同目录保存启动配置、命令对应的脚本、日志和退出码。下一步从 `CharacterLoader.load` 成功后的启动崩溃定位，再验证单一时钟和每人生命周期。

## S6 NuRec 渲染与质量评估

2026-11-10 22:31（新加坡时间），评分模块可复用，真实场景评估等待源资产与参考帧。

- 本机 Isaac Sim 6.0.1.0 安装目录未提供 `isaacsim.replicator.nurec_utils`。将方案所列固定源码保存至本地回执目录，保留逐文件 SHA-256。上游 `render_and_score` 接收调用者创建的 `SimulationApp`，在指定相机与参考时间戳上渲染，按相机名与时间戳配对评分。[官方 render.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/render.py) · [官方 eval.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/eval.py)
- 用现有 Isaac 解释器直接执行上游 `score` 和 `image_diff` 的 CPU 合成检查，退出码 0。相同图像为 100 dB／SSIM 1.0，像素恒差 17 的样本为 23.5218 dB／SSIM 0.98352，绝对差回读为 17。结果仅覆盖指标和差异图函数。[官方 psnr_ssim.py](https://github.com/isaac-sim/IsaacSim/blob/045ca8b59622b99a408092124377c66346e8d9c2/source/extensions/isaacsim.replicator.nurec_utils/isaacsim/replicator/nurec_utils/metrics/psnr_ssim.py)
- 通过 `HF_ENDPOINT=https://hf-mirror.com` 查询 `nvidia/PhysicalAI-Robotics-NuRec` 与 `nvidia/PhysicalAI-Autonomous-Vehicles-NuRec` 元数据，均收到指向官方域名的 HTTP 308。对机器人集的 README 和文档示例 `hand_hold-endeavor-andoria/stage_particle.usdz` 发出的 HEAD 请求得到相同结果，未跟随跳转。真实 USDZ、配对参考帧、组合场景与图像评估仍待验证。[NVIDIA 神经体渲染文档](https://docs.isaacsim.omniverse.nvidia.com/6.0.0/assets/usd_assets_nurec.html)
- 回执位于 `.runtime/isaac-adoption-20261110/receipts/s6-nurec/` 的 `mirror-resolved.json`、`mirror-asset-head.json`、`upstream.sha256` 与 `metrics.json`。取得带来源和配对机位的本地 NuRec 样本后，在专用评估世界继续。

## S7 Mimic 示教准备

2026-11-10 22:45（新加坡时间），首条笛卡尔夹具示教已生成可复用的预标注 HDF5。实际 Lab 任务注册和扩增继续待验收。

- DSH headless 使用真实录制生成预标注原型，派发在 480 秒到时退出 124。主控补齐可复跑的离线脚本，直接使用已固定的 `HDF5DatasetFileHandler`、`EpisodeData`、`make_pose` 与 `matrix_from_quat`。脚本以对应导出清单的 SHA-256、原始动作与原生接触确认来源，新增 TCP、目标 TCP、箱体位姿和双指抬升信号。笛卡尔夹具的固定 TCP 偏移来自 S4 模型，按逐帧原生回读核验。其他机器人需各自的任务适配。[离线脚本](../packages/robot-workflows/python/prepare_cart_mimic_demo.py) · [官方 annotate_demos.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/scripts/imitation_learning/isaaclab_mimic/annotate_demos.py)
- 用 S4 原始 HDF5、`control-samples.jsonl` 与 `evidence.json` 执行脚本，退出码 0，生成 `cart-demo.hdf5`。第二个控制窗末端首次同时满足双指接触与 5 mm 抬升，放置终态经箱体与地面接触及原验收范围核对。混用另一份控制样本时退出码 1，未写出候选文件。
- 主控用固定 HDF5 读取器逐字段核对原有动作、初态、机器人状态，以及与 DSH 原型相同的新标注。以仅提供夹爪切片与任务配置的测试对象调用固定上游 `DataGenInfoPool`，实际读回 13 帧，得到半开区间 `[0,3)`、`[3,13)`，退出码 0。[官方 datagen_info_pool.py](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/source/isaaclab_mimic/isaaclab_mimic/datagen/datagen_info_pool.py)
- S4 的六份导出对应三次重复运行，均为同一动作序列及布局。候选文件继续标记 `taskValidation: unverified`，Lab 任务 ID 为空，原始重置状态只包含机器人。固定 Lab v3.0.0 的 `uv sync --locked --dry-run --offline --extra mimic` 退出码 0，需安装 215 个包。使用现有 CPU 导出环境直接启动官方标注 CLI 时缺 `lazy_loader`。独立完整环境、任务 reset／成功判据、真实 Lab 回放及候选布局尚未验收，训练未启动。
- 回执位于 `.runtime/isaac-adoption-20261110/receipts/s7-mimic/`，包括 `cart-demo.hdf5`、`main-prepare.stdout.log`、`main-verify-pool.json` 与 `s4-input-audit.json`。复跑时使用 S2 的独立导出解释器，并指定同次录制的四个路径。

```bash
"$LYAPUNOV_LAB_EXPORT_PYTHON" packages/robot-workflows/python/prepare_cart_mimic_demo.py \
  --source "$S4_HDF5" --samples "$S4_CONTROL_SAMPLES" \
  --evidence "$S4_EVIDENCE" --output "$MIMIC_PREPARED_HDF5"
```

## S8 既有 Mink 路径核验

2026-11-10 22:30（新加坡时间），当前笛卡尔夹具路径继续使用 Mink。

- 使用固定 Capture 解释器、现有 Mink 与 MuJoCo 跑 `node --experimental-strip-types --test packages/teleop-capture/test/keyboard-native.test.ts`，退出码 0，1 个真实用例通过。夹具保持接触并将目标抬升至 44.35 mm，最终落点为 `[29.97, 0, 15.49]` mm。在新世界重执行所得位置逐值相同。实测范围为该夹具、固定初态和固定按键序列。
- `bun run test:ci --filter motion-mink` 退出码 0，1 个测试文件通过。当前路径尚未出现需要差分 IK 的在线伺服误差或限位问题，物理随机化的需求由后续 S7 实际候选运行确定。[现有 Mink 求解器](../packages/motion-mink/src/solve.py)
- 回执位于 `.runtime/isaac-adoption-20261110/receipts/s8-mink-native/` 与 `s8-mink-ci.json`。

## S9 集成回归

2026-11-10 22:34（新加坡时间），本地自动化与构建通过，状态按各能力的实测设备记录。

| 运行范围 | 已核验 | 待验收 |
| --- | --- | --- |
| Linux／Isaac Sim 6.0.1.0 | CPU 控制步采样、官方资产验证、现有人群和原生 USD 接触及启停 | IRA 人群事件、NuRec RTX 场景与成像质量 |
| Linux／MuJoCo 3.13.0 | Capture 1.8.29a1 键盘、Mink 抓放、控制录制、历史回放与新世界重执行 | Pico 4 Ultra 和 CloudXR |
| Linux／Isaac Lab v3.0.0 | 固定版数据 API 的 HDF5 读写 | Lab 任务回放、Mimic 扩增、策略执行 |
| macOS／Windows | 本批尚无实机结果 | 分平台工作台、缺依赖行为和适用运行路径 |

- 对 `human-crowd`、`sim-isaac`、`scene-kit`、`robot-workflows`、`motion-mink` 分别运行 `bun run test:ci --filter <包名> --json <报告路径>`。按仓库工作流使用 Python 3.12.14、NumPy、Pillow、MuJoCo 3.13.0 和 OpenUSD 26.5，实际通过 88 个测试文件，退出码均为 0。首次 `sim-isaac` 运行因默认 Python 缺 NumPy 有 2 个文件失败，按工作流配置解释器后 18 个文件通过。
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` 与 `bun run script/build-plugins.ts human-crowd sim-isaac scene-kit robot-workflows teleop-capture motion-mink lyapunov-shell` 均退出 0。构建、类型与 CI 回执位于 `.runtime/isaac-adoption-20261110/receipts/s9-ci/`。
- 本轮是开发分支验收。发行候选所需的 release gate、打包解包和公开发布尚未执行。

## 续跑记录 2026-11-10 新加坡时间

### S5 补齐动作库并核验单一物理时钟

- 23:34 的 GDB 回执将崩溃定位在 `libomni.anim.asset.plugin.so`，调用栈经过 `omni.anim.behavior.core` 和 Kit 时间线。USD 依赖扫描发现原探针只复制了 `HumanMotionLibrary.usd` 索引，未解析 193 个相对引用。按官方索引取回 193 个原件，共 444,176,799 字节，再扫未解析引用为 0。补齐后同一个加载／启动探针正常完成，两名角色运行。[官方 IRA 行为配置](https://docs.isaacsim.omniverse.nvidia.com/6.0.1/action_and_event_data_generation/ext_replicator-agent/ext_isaacsim_replicator_agent_configuration.html)
- 参考场景的原生回调把两个推进来源分开。直接 `SimulationManager.step` 触发 1 次 PhysX 回调，设置并提交时间线又触发 1 次，单独 `Kit.update` 触发 0 次。联合调用 450 次得到 900 个物理回调。
- 23:56 的米制、Z 向上场景使用显式 XY 地面与官方 NavMesh。以主控提交时间线为唯一推进入口，`450` 个逻辑步得到 `450` 次 PhysX 回调。固定 seed 7，目标角色在第 229 步越过区域边界，官方事件将任务从 `MoveTo` 切为 `Idle`，随后恢复 `MoveTo`。单人 `set_enabled(false)` 后目标角色位置不变，另一个角色继续移动。
- 回执为 `.runtime/isaac-adoption-20261110/receipts/` 下的 `s5-gdb/gdb.log`、`s5-ira-motion/motion-assets.json`、`s5-ira-clock/result.json` 与 `s5-ira-meters-owner/result.json`。这些结果覆盖同 stage 原生角色、触发和时钟。产品 `human-crowd` 的角色映射、保存重开、机器人与相机同场仍待验收。
- 2026-11-11 00:05（新加坡时间），补跑两次独立 Kit。三次均于第 229 步触发区域事件，均为 450 个逻辑步与 450 次原生物理回调。三次均有单人停止后目标不动且另一人移动的回执。复跑位于 `s5-ira-repeat-fixed/{2,3}/result.json`。

### S6 官方取样权限

- 用户授权从 NVIDIA 官方数据集取样。仅对 `nvidia/PhysicalAI-Robotics-NuRec` 使用该来源。确认 `v0.1` 对应提交 `58a4b600ca90c763f1e0dd59caadf18335386cac`，目标 `hand_hold-endeavor-andoria/stage_particle.usdz` 为 605,463,822 字节，配套 `raw_images.zip` 为 2,318,560,126 字节。官方元数据可读，当前凭据对 USDZ 返回 `403 GatedRepo`。未取得资产字节，真实成像验收等待访问许可或本地样本。[官方数据集](https://huggingface.co/datasets/nvidia/PhysicalAI-Robotics-NuRec)
- 回执为 `.runtime/isaac-adoption-20261110/receipts/s6-nurec/official-access.json`。官方访问授权仅覆盖该数据集，本次其余 Hugging Face 查询沿镜像规则。

### S7 任务注册、原生回放与官方扩增

- 以固定 Lab v3.0.0 注册 `Lyapunov-Cart-GraspPlace-Mimic-v0`，用 2 ms 的物理步和 150 步的控制周期。模型来源为 S4 MJCF，官方导入器会合并同一刚体上的三个滑轨，准备脚本为 x 和 y 增加独立连接，再用官方 SDK 转换，USD 回读五个标量关节。两条连接各用 0.1 g 惯性质量。任务通过 Lab 的五关节位置动作、Mimic 位姿接口、原生刚体重置和官方随机化事件运行。[任务代码](../packages/robot-workflows/python/isaac_lab_cart_task.py) · [模型准备代码](../packages/robot-workflows/python/prepare_cart_lab_asset.py)
- DSH 派发按锁安装，首轮沙箱的全局 uv 缓存为只读，改用工作区缓存后仅 CUDA Torch 大包迟迟未完成，主控停止该下载。使用独立环境按原锁安装其余依赖，复用 S2 的 Torch 2.11.0 CPU，未装 CUDA 版 Torch 和 TorchVision；这次环境差异明确限定在 CPU 无渲染任务。官方 `annotate_demos.py --help` 和 `generate_dataset.py --help` 都退出 0。
- 五种源初态的箱体 x 为 `-6、-3、0、3、6` mm，均由真实 Capture 与 MuJoCo 录制并在新世界重执行。合并文件有 5 个示教、65 个控制窗。使用官方 HDF5 读取器从补齐的原生初态启动 Lab Newton/MJWarp 物理回放，五条全部通过。每条峰值高度约 44.19 mm。初版夹爪关节阈值将已经打开的两指判为未释放，修订后用实时指垫与按实际朝向投影的箱体边界留 1 mm 间隙来核验释放。
- 用 `generate_dataset.py --external_callback isaac_lab_cart_task.register --task Lyapunov-Cart-GraspPlace-Mimic-v0 --visualizer none --device cpu --num_envs 2 --generation_num_trials 10` 运行固定源算法。首轮发现 MJWarp 约束缓冲溢出后停止，调整约束容量到 128 并在新目录完成一轮。固定 seed 7，实际产生 10 个不同初态，成功 3 条、失败 7 条，每条 14 个控制窗。主控用上游读取器核验任务 ID、状态、动作、不同初态与两份 HDF5 的 SHA-256。训练属于方案中的独立资源任务，本轮未启动。[官方生成入口](https://github.com/isaac-sim/IsaacLab/blob/e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4/scripts/imitation_learning/isaaclab_mimic/generate_dataset.py)
- 回执为 `.runtime/isaac-adoption-20261110/receipts/s7-cont/` 下的 `lab-replay-final.json`、`augmentation-verified.json`、`cart-lab-source-fp32.hdf5`、`cart-augmented-final.hdf5` 和 `cart-augmented-final_failed.hdf5`。数据与生成的模型资产保存在本机回执目录。
- 2026-11-11 00:04（新加坡时间），用提交候选的模型准备脚本重新导入，确认五个关节齐全，再用该 USD 重跑一个 Lab 示教并通过。用提交候选的组装脚本从五条预标注和原始 JSONL 生成 `cart-lab-source-final.hdf5`，和已经用于官方扩增的五条数据逐字段一致。错配原件时退出码 1，未写出文件。[组装脚本](../packages/robot-workflows/python/assemble_cart_lab_demos.py)

### S8 以实测约束限定算法范围

- 五种偏移布局在三次横移输入下均通过。额外增加到四或五次横移的三个尝试，在后续降低 TCP 的步骤收到 `MOTION_NO_SOLUTION`。该证据目前支持保留已有目标限制与错误语义。扩增所需的初态变化已由 Lab 的 `reset_root_state_uniform` 实际执行并逐条回读。尚无引入另一套在线 IK 的必要证据。

### S9 全量 CI 与发行状态

- 2026-11-11 00:02（新加坡时间），以 CI 的 Python 3.12 环境执行 `bun run test:ci --json <报告>`，退出码 1，实际执行 427 个文件，426 通过，1 个 Viewer 并发场景切换用例失败。用相同依赖在基线 `683b3425` 与当前分支单项复跑均通过。工具目标匹配会受测试中其它活动窗口影响，修订该用例使切换与观察都显式指定同一个窗口。通过 `bun run test:ci --filter viewer-observe --json <报告>` 复验，退出码 0。完整 CI 的历史失败按原样保存。
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` 与 `bun run script/build-plugins.ts human-crowd sim-isaac scene-kit robot-workflows teleop-capture motion-mink lyapunov-shell` 退出码均为 0。回执位于 `.runtime/isaac-adoption-20261110/receipts/s9-cont/`。该目录同时保存全量、基线和修订后定向测试。
- 最终全量发行门禁、打包解包与 macOS／Windows 实机验收尚未完成。当前机器为 Linux，`win11-pro` 测试虚拟机处于关闭状态，macOS 目录仅能确认源码状态。发布状态保持本地开发分支。
- 2026-11-11 00:05（新加坡时间），用隔离检出的 `b275cd23` 运行 `bun run script/package-linux.ts --check-source --root <隔离检出>`，退出码 0，载荷源码洁净。上次发布脚本所指的 `LYAPUNOV_HUMAN_AVATAR_STAGING_ROOT` 与 `LYAPUNOV_ROBOT_STAGING_ROOT` 冻结输入目录均缺失，策略资源目录存在。源检出检查与冻结输入回执位于 `s9-cont/candidate-source.stdout.log` 和 `candidate-release-inputs.json`。

## S5 产品接入验收 2026-11-11 新加坡时间

- 在 Scene 人体组件保存可选 IRA 配置，复用 `crowd_configure/start/stop/inspect` 与 Workbench 人体属性。当前支持官方循环巡逻、XYZ 区域触发与停留，按单人或群组操作。首次启用需要重新打开 Isaac 世界。官方角色与完整动作库由本地 Profile 环境提供。[配置说明](HUMAN_CROWD.md) · [人群操作](../packages/human-crowd/src/operations.ts)
- IRA opt-in world 复用官方 NavMesh、角色 schema、`CharacterPatrolBehavior` 与事件触发后的官方 Stop 行为。现有 worker 提交 Timeline，逐步核对 PhysX 实际步数。官方角色根驱动现有 PhysX 碰撞代理，机器人仍通过既有 World 路径运行。普通人体保留原时钟与控制方式。[官方 SDK 适配](../packages/sim-isaac/python/ira_adapter.py) · [World worker](../packages/sim-isaac/python/worker.py)
- 主控通过 Node 原生 Provider 复跑 CPU 和 RTX 场景。CPU 用例中，15 步自由落体实测 1.307999 m，预期 1.308 m。物理代理推动动态试件，接触力约 1.77 N。区域停留后继续巡逻，单人停止时另一人继续运动。用保存后重开的 Scene 真实起世界复验，通过 1 个原生用例，该次读回 137 次逻辑提交和 137 次原生物理步。命令为 `node --experimental-strip-types --test packages/sim-isaac/test/ira-native.test.ts`，退出码 0。
- RTX 同场测试于第 144 步输出 320×240 的原生 RGB 和米制深度。采集前后及标定身份均为同一步。主控独立读回图像与数组，取得 50,261 个有效深度像素，并查看画面确认两名官方角色可见。该帧的 World 观测同时记录真实机器人五个关节。
- DSH 派发到时限退出 124，主控接手修复并验收。真实失败及修复包括 Kit 文件名解析、导航地面引用根遮蔽 Mesh、冷着色器编译、工具参数 schema，以及 RTX 刚体视图要求 Warp 张量。窄窗 Edge 验证使用真实面板和固定命令夹具，实体运行由独立产品 Provider 测试取证。
- `bun run test:ci --filter human-crowd` 与 `--filter sim-isaac` 分别通过 3 和 19 个文件，`tsc --noEmit -p tsconfig.json` 与受影响插件构建均退出 0。原有人体 Isaac 原生回归也通过 2 个用例。回执位于 `.runtime/isaac-adoption-20261110/receipts/s5-product/`，主要文件为 `native-reopened/ira-native-result.json`、`native-cpu-contact/receipt.json`、`native-rtx-c-verified.json` 和 `ui/dom.html`。
- 原有 Isaac 人体回归在最终改动后复跑，2 个用例通过。主控从 MuJoCo 原生通用动作入口提交同一 IRA 声明，收到 `HUMAN_IRA_PROVIDER_UNSUPPORTED`，观察步保持 0。退出码与日志分别为 `final-baseline.exit`、`final-baseline.stdout.log`、`mujoco-guard-final.exit`、`mujoco-guard-final.stdout.log`。

## S6 官方样本取件与单帧验证 2026-11-11 新加坡时间

- 01:35，用户已接受 NVIDIA 数据集条件。指定镜像对固定 revision 的元数据和目标文件仍返回 308 到官方域名，按用户此前明确授权使用官方来源。当前账户的官方文件预检返回 302，随后 DSH 派发仅下载 `hand_hold-endeavor-andoria/stage_particle.usdz`。下载退出 0，字节数 605,463,822，SHA-256 与官方固定 revision 一致。固定提交为 `58a4b600ca90c763f1e0dd59caadf18335386cac`。
- 01:38，主控独立验证包内 CRC 和 SHA-256，OpenUSD 可读到米制、Z 向上的粒子场、碰撞网格文件及一台带轨迹相机。普通 OpenUSD 解析报告一条外部 PPISP 着色器引用未解析，原始 USDZ 保持原字节。
- 01:40，复用固定 IsaacSim 上游 `render_keyframes`，用本机 Isaac 6.0.1 RTX 在 1,296 个原有相机关键帧中选取一帧，产出 480×270 RGB、时间戳与相机位置。图像回读与人工查看通过。该次为普通粒子场的单帧渲染验证，PPISP 光度校色、真实参考帧质量比较和机器人组合场景待验收。
- 回执与产物位于 `.runtime/isaac-adoption-20261110/receipts/s6-nurec/sample/`，包括 `mirror-recheck.json`、`official-recheck.json`、`download.json`、`verified.json`、`rtx-smoke-verified.json` 和 `rtx-smoke/manifest.json`。

## S6 离线评估与组合场景验收 2026-11-11 新加坡时间

- 冻结 NVIDIA Andoria 同一 revision 的 10 个相机机位。从官方参考 ZIP 按范围读取 5,078,691 字节，逐帧匹配原始相机时间戳并保留原件 SHA-256。10 个选中帧与全部 1,296 个可匹配帧的取样关系见 `reference-selection.json`。
- 使用固定上游 NuRec 渲染器、同相机内参与 1920×1200 分辨率，逐帧输出原图、RTX RGB、差异面板和统计。10 张全部配对。首次实测平均 PSNR 为 16.52 dB，平均 SSIM 为 0.835。PSNR 最低 11.74 dB，最高 21.53 dB。人工查看了差异最显著和分数较高的对照帧，观察到亮带、曝光差异与局部重影。冻结这组图和逐帧结果作为当前普通粒子场基线。该样本的 PPISP 外部着色器引用在本机仍未解析。
- 在独立 Kit 中用外层 USDA 引用原始 USDZ 的 `/World`，加入真实五滑轨机器人和 S3 验证过的动态刚体。90 个 PhysX 物理步内机器人 x 关节移动约 0.08 m。刚体质心由 0.6471 m 落到 0.0824 m，检测到 1,122 条与重建网格 `/World/mesh` 的接触数据。使用同一世界的官方相机渲染入口采集俯拍组合图。采集前后原生物理步均为 92。图中能辨认橙色刚体和机器人局部，场景重影仍影响可见边缘。
- 仓库交付独立评估命令，直接使用固定 NVIDIA 上游工具。Kit 和输出目录归本次评估，活动仿真世界维持原时钟。显式的版本、相机、场景坐标、来源 SHA-256、纳秒时间戳、渲染清单和统计由 `result.json` 关联。[评估入口](../packages/robot-workflows/python/evaluate_nurec_scene.py) · [上游来源](../packages/robot-workflows/python/vendor/nurec_utils/SOURCE.md)
- 本轮证据位于 `.runtime/isaac-adoption-20261110/receipts/s6-nurec/sample/s6-final/`。原始取样回执为 `reference-selection.json`，固定机位评分为 `paired-rtx/eval/`，组合图和原生物理回执为 `composite-v3/composite.png` 与 `composite-v3/result.json`。样本、参考图和渲染产物保存在本机运行目录。

从 Dev 根目录用已安装的 Isaac Python 运行。参考图按相机名目录与纳秒时间戳文件名组织，输出目录用于一次独立验收。

```bash
"$LYAPUNOV_ISAAC_PYTHON" packages/robot-workflows/python/evaluate_nurec_scene.py \
  --stage "$NUREC_USDZ" --references "$NUREC_REFERENCE_ROOT" \
  --output "$NUREC_RUN_OUTPUT" --camera front_stereo_camera_left \
  --samples 10 --resolution 1920 1200 --warmup-steps 48
```

正式评估入口使用随代码保留的 9 份原样上游文件。2026-11-11 02:12（新加坡时间），以相同十帧从仓库入口重跑，逐帧 PSNR、SSIM 与绝对差和第一次完全一致。Kit 启动 7.70 秒，渲染 14.50 秒，评分与面板生成 8.60 秒。错误相机参数退出码 1。Robot Workflows 离线 CI、发布工具离线测试和 TypeScript 类型检查均退出 0。最终回执为 `s6-final-acceptance.json`，最终可复跑入口产物位于 `final-paired-rtx/`。
