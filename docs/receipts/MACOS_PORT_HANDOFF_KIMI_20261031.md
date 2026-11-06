# Kimi Code 接手说明（历史归档，2026-10-31）

> **历史身份**：本文件是 LyapunovMac（macOS 移植，基于 Lyapunov 0.2.1）开发过程的交接日志原文归档，不是现行状态，也不是任何发布版本（含 0.2.3）的验收证据。
>
> **原文时间范围**：正文写于 2026-10-28。
>
> **归档日期**：2026-10-31。
>
> **现行入口**：[核心原则总入口](../../principles/README.md) · [发布说明目录](../releases) · [macOS 运行与便携候选说明](../../distribution/macos/README.md)
>
> **保留方式**：以下分界标记之后为原文，逐字保留；文中 `work/`、`outputs/`、`/Users/...` 路径、会话 ID、进程号与端口均指原 Mac 开发机当时的现场，不作为当前导航或可复现路径；旧相对链接按原样保留。

<!-- ===== 原文开始 ===== -->

# Kimi Code 接手说明

更新日期：2026-10-28。产品任务状态：**部分完成**。

用户要求把当前工作交给 Kimi Code。本文是本次本机任务的交接快照，现行规则以根 `AGENTS.md` 和 `principles/` 为准；后续先核对当前工作树，不把本文或旧回执当成新的运行证明。

## 1. 用户目标与约束

- 持续目标：**修复到和 Linux 0.2.1 功能一致，排除 Isaac 和 CUDA 相关**；还要确认实际功能流程和点击入口可用。
- 尽量复用 0.2.1 的原插件、operation、状态所有者和运行机制。只对必要的系统兼容点适配；若修复原版通用缺陷，说明具体原因和范围，不另写替代业务系统。
- 用户已明确要求避免钻牛角尖、无目的反复探针和循环打包。发现具体问题后做有界验证；不要仅为一处局部修改不断生成完整发行包。
- 缺模型、许可、硬件或外部条件时，用户允许跳过并说明；不能把程序故障伪装成缺许可，也不能将跳过计为通过。
- 所有 Markdown 回复和交付说明使用中文。
- Hugging Face Hub 所有查询、下载、校验与 CLI／Python 调用必须使用 `HF_ENDPOINT=https://hf-mirror.com`，禁止直连官方 Hub 或镜像失败后静默回退。**用户已明确授权使用 ModelScope**；该授权不取消其它 HF 请求的镜像纪律。
- 未获授权不新增代理或递归派发。开发代理和产品内部 Agent Graph 角色是两件事。
- 测试保持账户与模式隔离，不输出凭据，不改用户全局代理／引擎偏好，不把 `.runtime`、权重、账户数据或测试场景带入源码和发行。

## 2. 接手先读及关键条款

按顺序完整阅读：

1. `AGENTS.md`
2. `principles/README.md`
3. `principles/PRODUCT.md`
4. `principles/DEVELOPMENT.md`
5. `principles/AESTHETICS.md`
6. `principles/INTERACTION.md`
7. `docs/DEVELOPMENT_STANDARDS.md`、`INDEX.md`、`docs/releases/0.2.1.md`

与当前修改直接相关的条款：开发原则 §1–3（复用、插件与唯一状态）、§5–8（归属、世界／帧、身份与能力）、§12（依赖与镜像）、§14（证据分层）；交互原则 §2、§4、§7、§11–12（同路、停止与任务、采集录制及完整流程）；美学原则 §3、§6（界面状态与真实视觉验收）。开发标准 §3.3 明确复用 `ProcessSimProvider` 原 NDJSON 和 `receipt` 事件；§5.3–5.5 规定按影响范围检查和提交。

部分标准文档保留发行源码或历史快照，例如“没有 Mac 包”“Newton 相机未实现”等，已经与本地后续改动不同。对长期规则照办，对当前实现与运行事实以代码、发行清单和真实结果核对。

## 3. 位置与版本：不要混用三种对象

| 对象 | 当前核对结果 |
| --- | --- |
| 源码仓库 | `/Users/apple/WS/LyapunovMac` |
| 当前分支和 HEAD | `main`，`a98b7642672a2e14568e24048c73dcfda4b8bd13` |
| Linux 0.2.1 对齐基线 | `00d3bc60d9fb5df7b4d45abc63f025f3d4ed1584`；已核为当前 HEAD 的祖先 |
| 固定 DSH | `UPSTREAM_LOCK.json`：`54312dc5a8c4a63b60b3b92f51109f7bd1c1e852`，目录 `.upstream/deepseek-harness-20260911-candidate` |
| 上一次完整打包候选 | R31，`0.2.1-macos-local-20261028-r31`，payload 源码 `a837dea2d61a73ff998fe721fedaa4136d592f07` |
| 隔离安装入口 | `/Users/apple/Documents/Codex/2026-10-25/c-la/work/parity-real-install/product/current`，当前解析到 R31 |
| 相机测试副本 | `/Users/apple/Documents/Codex/2026-10-25/c-la/work/r31-newton-camera-candidate`；替换过原构建器产出的 shell 客户端和 Newton Python 文件，**不是正式 R31 归档** |
| 相机测试数据 | `/Users/apple/Documents/Codex/2026-10-25/c-la/work/guest-data-newton-camera` |
| 本次工作材料根 | `/Users/apple/Documents/Codex/2026-10-25/c-la/work` |
| 用户交付／证据根 | `/Users/apple/Documents/Codex/2026-10-25/c-la/outputs/本轮复用验收-0.2.1` |

R31 归档位于证据根的 `发行R31/lyapunov-darwin-arm64-0.2.1-macos-local-20261028-r31.tar.gz`，711943382 字节，SHA-256 `5e014d9cdb50605dfa422a53e81e0bca556c809d2c48d8d7912e30b3c5c410ea`。此前原安装器、doctor 和真实 MuJoCo 检查通过；仅本机 ad-hoc 签名，未公证、未发布。**R31 不包含下文 a837dea2 之后的源码修复。**测试副本也没有包含刚写入的共享传输层补丁；接手不能拿它代表当前源码。

## 4. 最重要：当前未提交的中断现场

本次交接前已重新执行 `git status --short`，有以下已有修改，必须保护：

```text
 M HANDOFF.md
 M packages/sim-contract/src/python-transport.ts
 M packages/sim-contract/test/fixtures/fake-worker.py
 M packages/sim-contract/test/startup-lifecycle.test.ts
```

`HANDOFF.md` 是累积交接，当前比 HEAD 追加约 344 行。不要 reset、checkout、stash 或覆盖。其余三个文件是**刚被用户中断、尚未完成验证的候选修改**，尚未提交、尚未构建、尚未实测飞控：

- 原 `ProcessSimProvider.execute()` 即使已收到物理 worker 的终态 `receipt` 事件，仍固定等待 20ms 才继续；当前候选增加 `terminalWaiters` 和 `waitForTerminalReceipt()`，由已有终态缓存／事件唤醒，保留 20ms 无事件轮询回退。
- 原 fake worker 增加 `executeMode`：事件在回复前、事件在回复后、只有轮询三种受控情形。
- 原生命周期测试增加“终态事件唤醒原动作等待”三个用例，通过故意把 20ms 计时拉到 1000ms，验证结果来自事件而非碰巧等到轮询。
- **测试先写、产品补丁后写。**补丁前实际执行下方命令，结果为 1 通过、2 失败、28 被筛选；两个事件用例报“事件未及时唤醒动作”。随后产品补丁写入即被打断，**补丁后没有运行任何测试或类型检查**。

```bash
cd /Users/apple/WS/LyapunovMac
bun test packages/sim-contract/test/startup-lifecycle.test.ts -t '终态事件唤醒原动作等待'
```

接手优先复核：事件先于 accepted 回复的竞态、不同 generation／action／world 的隔离、旧 worker 迟到事件、取消／stop／close／dispose、多个等待者和订阅释放、无事件回退。继续沿现有 Provider 和缓存，不新增事件总线、动作调度器或物理时钟。不要把这处候选写成“飞控稳定性已修复”。

本次交接只检查了进程命令行：未见上述 CI、生命周期测试、飞控夹具或该相机候选 Electron 仍在运行；它们没有可等待的活跃句柄。不要据此终止其它 Lyapunov 或用户进程。

## 5. 最近已提交修复及其边界

| 提交 | 内容 | 已有验收边界 |
| --- | --- | --- |
| `a837dea2` | Newton 从源 MuJoCo keyframe／显式关节值初始化，并用 Newton FK 同步状态；固定 Pillow 依赖及 doctor | 已纳入 R31；初值和装配通过不等于动态稳定 |
| `d831db17` | 自由根之后，初始控制目标按 Newton coordinate／DOF 布局正确索引 | 真实 CPU 夹具验证目标跟随；未纳入 R31 |
| `dcd3993a` | Newton 相机按 Scene mount 绑定真实 body，提供清单与同帧连杆姿态，工作台允许 Newton 准备相机 | 隔离 GUI 实测 Go2 小腿挂载和真实预览；后续 Go2 物理仍发散 |
| `211a7536` | 补采集实体／连杆来源；拍摄面板启用原生相机清单；补 CI 漏登测试 | 对应该提交的一次完整 CI 415 文件通过；固定根夹具录制通过，详见下一节 |
| `a98b7642` | 有限力限位置 PD 的源初始 ctrl 不再丢失；动作守卫保留，新增未执行力限的告警 | 三文件 20 项定向测试通过，A1 初始尖峰消失但第167步仍发散；未重跑完整 CI、未打包 |

更早修复涉及：Mac 发行／安装兼容、HMR 仅 ctime 变化导致黑屏、机器人库和放置、MuJoCo 无增益力矩电机初始化、真实故障原因投影、纯视觉动画资源导入／归属、策略选择器取消及迟到结果、飞控实测执行器力投影、文件／终端等。详细历史见 `HANDOFF.md`。不要反复重做已覆盖项，也不要拿某次历史通过推断当前所有功能通过。

## 6. 已有证据，按对应版本使用

### 最近完整 CI：只对应 211a7536

- 文件：证据根下 `相机修复后完整回归.json` 和 `.log`。
- 本次交接重新读取 JSON：生成时间 `2026-10-28T03:47:34.146Z`，`filter=null`，481 个清单文件，415 个纳入且全部实际运行通过，0 失败、0 缺件，66 个按清单未运行，执行器 exit 0。
- 纳入文件内汇总 4530 项通过、48 项条件跳过；跳过不计能力通过。
- 至少 97 个文件的输出尾部有 Bun 1.4.2 `Internal error: directory mismatch` 提示，相关文件 exit 0；工具提示根因**未验证**，不要称已经解决。
- `a98b7642` 及当前未提交 transport 修改发生在这次完整 CI 之后，不能沿用其全量通过结论。

### Newton 相机、录制

证据目录：`Newton挂载相机/`。

- 隔离 GUI 实测 Go2 非根小腿连杆挂载、保存、同步和真实 RGB 预览。
- 暂停世界的一次录制只有 1 帧，因墙钟安全时限提前结束；保留该失败范围。
- 后续用自制固定根 MJCF 验证相机入口从关闭状态重新准备 Newton，再实际录制 1 秒模拟时间：RGB／深度各 66 帧，132 个文件和66份回执均存在、实体／连杆来源一致，终止原因为 `duration-limit`。
- 66 次采集相对订阅录制帧都有步差，最大27步；**未证明逐帧严格同步**。
- 固定根测试成功不能替代 Go2、A1 等动力学稳定性，也不代表全部相机功能验收。

### Newton 初始执行器目标

证据目录：`Newton初始力限诊断/`。

- 同一 A1 GUI 场景、CPU／XPBD、dt0.002、原重力和地面：R31 初始目标未读取受力限执行器的源 ctrl，第一步最大六分量速度绝对值约101.47，第32步报非有限。
- `a98b7642` 使用源 ctrl 后第一步约0.01962，第167步仍报非有限。
- 另一次禁用相应增益的**隔离反事实**在第147步仍非有限；没有纳入产品，不是合法稳定性修复。
- 真实初值 fixture 内8个 Python 用例；最后执行初值／能力／纹理三个 Bun 文件，20项通过、0跳过、exit0。无本提交完整 CI 或安装版 GUI 验收。

### Crazyflie 控制间隙

证据目录：`飞控间隙对照/`，包括 `未注入.json`、`注入80毫秒.json`、`实验说明.md`。

- 原15秒实时悬停，两次各150个动作；原推力动作窗50个dt0.002步，结束即 neutralize，不自动保持推力。
- 在一次动作完成回执后额外等待约80ms，使该处采样间隔53→91步，之后约30次采样高度范围0.319–0.371→0.165–0.430米；两次原终态均 completed。一次受控对照不是自然失败的唯一根因证明。
- 已有 GUI 悬停曾返回 `FLIGHT_TARGET_NOT_REACHED`；其它实时／手动夹具也曾通过，不能宣称稳定性已修。
- 当前待验 transport 补丁只想消除可避免的20ms终态等待，不改变推力窗、neutralize、PID或成功阈值。能否改善真实飞控尚**未运行**。

## 7. 仍需完成的工作

1. 审查并验证当前未提交的 transport 事件唤醒补丁；优先处理与旧代次、取消及关闭有关的回归，再做一次限定的真实飞控对照。
2. Newton：A1、Panda、Go2、generic_quadrotor 在不同场景出现过非有限状态。Panda 曾在 Linux 和 Mac 同源 CPU 场景均复现，不能简单归为 Mac 专属；但用户要求修复，当前尚未完成。
3. XPBD 原 pin 不支持部分源 armature、摩擦、effort／forcerange、等式／mimic 约束。不能关闭重力／碰撞、改原资产、放宽阈值或换引擎后把任务记为修复。若必须做兼容适配，先证明与原合同一致。
4. “所有功能点击可用”仍未完整签收。已有很多界面实测，下一步按实际能力／任务清单补缺，不以包名或按钮数量判定完整对齐；换手、人工／Agent同路、停止恢复等按原则取证。
5. 收敛修复后再考虑一次正式打包及安装验收。尚未公证／发布／推送，不能把隔离测试副本当成发行包。

用户要求缺条件可跳过的项目：Unity Editor 未安装；Go2 默认策略有 `DEFAULT_POLICY_LICENSE_MISSING`，不绕过；真实硬件、部分外部云服务／收费生成与发布缺相应条件。原 Go2 物理故障与策略许可是不同问题。

ModelScope 两个目标实际都存在且此前已下载校验：Depth Anything 原CPU插件有真实通过证据；SAM3 权重已取得，原固定 SDK CPU入口因无条件 Triton 依赖报错，按 CUDA 排除范围记录。不要再写成“两模型缺失所以跳过”。来源／权重文件只在 `.runtime`／工作材料中，不能打入源码。

原先用户还提过开启 Clash 系统代理后 Kimi Code 无法连接；该现象未在本轮项目工作中诊断或修复，不能把本交接解释为代理问题已经解决。

## 8. 接手命令与环境

先读上述规则，再执行：

```bash
cd /Users/apple/WS/LyapunovMac
git status --short
git diff -- packages/sim-contract/src/python-transport.ts packages/sim-contract/test/startup-lifecycle.test.ts packages/sim-contract/test/fixtures/fake-worker.py
export HF_ENDPOINT=https://hf-mirror.com

# 当前未提交补丁的第一项待验；修改后尚未执行
bun test packages/sim-contract/test/startup-lifecycle.test.ts -t '终态事件唤醒原动作等待'

# 上项通过后，按影响范围检查整份生命周期与类型
bun test packages/sim-contract/test/startup-lifecycle.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

这是明确列出的定向测试，不是把裸 `bun test` 当标准全仓验收。当前标准清单入口是 `bun --no-env-file script/test-ci.ts --list`，完整运行用 `--json <报告绝对路径>`；不要对忽略未知参数的旧脚本猜测 `--help` 或让 `head` 提前切断输出。

已核存在的运行前提：

```text
MuJoCo Python:
/Users/apple/Documents/Codex/2026-10-25/c-la/work/parity-real-install/product/current/.runtime/sim-python/bin/python

Newton Python:
/Users/apple/Documents/Codex/2026-10-25/c-la/work/parity-real-install/product/current/.runtime/newton-env/bin/python

原CI Python:
/Users/apple/WS/LyapunovMac/.runtime/bench/gymnasium-env/bin/python

本地 Linux 0.2.1 模型供给:
/Users/apple/WS/LyapunovMac/.runtime/linux-0.2.1-supply
```

先核对实际版本再使用：此前隔离环境 MuJoCo3.13.0；Newton1.6.0／Warp1.17.0／MuJoCo3.12.0／Pillow11.3.0。两个 Python 环境不能混装。测试引擎偏好通过 `LYAPUNOV_ENGINE_PREFERENCE_FILE` 指向自己的工作材料文件；不要写用户默认偏好。

真实飞控已有入口：`packages/robot-workflows/test/flight-native.fixture.ts`，参数顺序为输出目录、完整原 Crazyflie MJCF、MuJoCo Python；运行前完整阅读，源码会检查模型SHA并运行手动／实时悬停、航点、落地、停止和重置。该 fixture 用真实引擎，但不是 GUI 或真实硬件证据。Node调用可沿仓库已有 tsx loader；Node26不再支持旧 `--experimental-transform-types`，不要原样复制旧命令。

需要 GUI 时使用隔离 Guest 数据根及已有候选，正常关闭测试世界和应用；不要操作其它用户 Lyapunov 实例。macOS系统文件选择器已有可用路线：打开 → Cmd+Shift+G → 设置完整路径 → Return → 打开；逐字输入丢失下划线等自动化问题不能直接归为产品导入故障。

## 9. 接手时避免重复与误判

- `HANDOFF.md` 是追加历史，旧段“进行中／未完成”可能被后文更新；按最近段与真实状态核对。
- 不把完整CI绿、短时步进、模型能导入、一次任务completed、图片存在、按钮能点互相替代。
- 不为文档交接重新运行完整CI；产品补丁验证是接手后的工作。先解决具体待验补丁，再按风险决定是否扩大检查。
- 不重做反复移除地面／关闭自碰撞／零重力／换求解器等已做过的Newton探针来制造新的通过；已有原件在证据目录。
- 无进展时说明当前证据和明确阻断，不连续重复“仍在排查”，不把所有版本的通过数字拼成一个“全部通过”。
- 本次交接没有提交或丢弃上述未提交修改，也没有新增产品测试结果；原始失败／未验范围均保留。

## 10. 可直接交给 Kimi Code 的起始指令

> 请在 `/Users/apple/WS/LyapunovMac` 接手。先阅读根 `AGENTS.md`，再按其顺序完整阅读 `principles/` 四份原则及开发标准，然后阅读 `HANDOFF_KIMI_CODE.md`。目标仍是与 Linux0.2.1 功能一致，排除Isaac／CUDA；复用原插件、operation及状态所有者。先保护 `git status --short` 中已有改动，优先审查并验证刚中断的共享传输层终态事件补丁，注意该补丁后还未测试，不能当作已完成。不要反复打包或扩大物理探针；按本文提供的环境与实际证据继续。中文汇报，HF请求只能走hf-mirror，ModelScope已获用户授权；缺条件按对象说明跳过，未验证不计完成。
