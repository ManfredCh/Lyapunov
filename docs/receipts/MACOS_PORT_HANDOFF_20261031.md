# LyapunovMac 0.2.1 交接记录（历史归档，2026-10-31）

> **历史身份**：本文件是 LyapunovMac（macOS 移植，基于 Lyapunov 0.2.1）开发过程的交接日志原文归档，不是现行状态，也不是任何发布版本（含 0.2.3）的验收证据。
>
> **原文时间范围**：最早内容随 `75d6af7a` 于 2026-10-26 提交，后续段落标注至 2026-10-28。
>
> **归档日期**：2026-10-31。
>
> **现行入口**：[核心原则总入口](../../principles/README.md) · [发布说明目录](../releases) · [macOS 运行与便携候选说明](../../distribution/macos/README.md)
>
> **保留方式**：以下分界标记之后为原文，逐字保留；文中 `work/`、`outputs/`、`/Users/...` 路径、会话 ID、进程号与端口均指原 Mac 开发机当时的现场，不作为当前导航或可复现路径；旧相对链接按原样保留。

<!-- ===== 原文开始 ===== -->

# LyapunovMac 0.2.1 交接记录

## 当前持续目标：Linux 功能对齐

用户目标：**修复到和 Linux 功能一致，除了 Isaac 和 CUDA 相关**。状态：**部分完成，目标保持进行**。下文原 0.2.1 核心验收保留其历史范围，不代替当前完整目标。

新增约束：复用 0.2.1 的插件、领域 operation、状态 owner 与依赖；只允许必要系统兼容叶发生变化，逐项说明。不得通过改写业务执行器、另建状态／调度层、隐藏入口或跳过 macOS 功能来宣称对齐。

| 功能域 | 当前工作与尚需证据 |
| --- | --- |
| Scene／Resource／Viewer、MuJoCo／Newton CPU、机器人动作与装配、相机／采集／录制／导出 | 复用现有插件；此前核心流程有实测。仍按 Linux 0.2.1 实际功能逐项核对，不把单台 Franka 代替全部声明范围 |
| 会话、模型、Guest／正式账户／开发模式、文件／Git／PTY／剪贴板、退出／恢复 | 复用 DSH owner；按同一操作和隔离／生命周期合同做当前态验收 |
| 浏览器自动化 | 移除错误的 Linux-only 装配条件，macOS 复用原 browser-use + chrome-devtools-mcp 插件；Edge 隔离浏览器 launch／attach 的上游真实 loopback 验收 2/2 已通过 |
| 原生桌面自动化 | 复用原 computer-use + cua-driver-native 与显式开关。55 个原生工具、权限检查已实测；修复 MCP 结构化窗口 ID／element_token 未进入模型文本的投影问题，并只投影目标窗口后代、不附带全局菜单。专项 2 文件 81/81。真实模型已取得目标窗口及截图；Electron 后台 AX 回显与画面不一致、前台投递被原规则拒绝，不能记输入成功。原生 Cocoa 控件已由正式模型真实后台输入／点击，独立截图、AX 树和应用动作记录均确认文本 LYAPUNOV_NATIVE_OK／计数1；会话 turn/end completed |
| Unity／Blender | Unity 继续使用同一 10.2.0 固定通用 wheel、MCP 与配置 owner；macOS bridge／47 个工具目录已通过；修复全新便携根误用旧 Python，保留失败前缀后复用原 venv；Blender 原真实门禁 6/6 通过。Unity Editor 本机未安装，Editor 任务未运行 |
| CPU policy／默认机器人与策略 | 同版 macOS Torch 2.11.0 固定轮子已通过原安装器／managed doctor；CPU 张量真实执行。11 种原模型与两套可分发策略按 Linux 正式清单复核；Go1、G1 已原 prepare／match／execute 实跑，每项 25 次 CPU 推理／控制、0.5 秒模拟。长时步态未验证 |
| 规划、抓取、物理化、3DGS 与碰撞 | 核对 CPU 路径及真实几何／动作回执，只有明确硬依赖 CUDA 的分支才计入排除 |
| Gymnasium／LIBERO 的非 CUDA 能力 | Gymnasium Ant-v5 真实载入、推进、去重／冲突、释放及 3 帧通过。LIBERO 官方固定源码 1086 文件／435774694 B 已核；Python 3.8.13、原 requirements 与同版 CPU wheels 安装完成。原 check=READY、真实 boundary smoke exit=0：任务载入／动作／去重／冲突／取消及停止后拒绝都通过；taskAchieved=false，不声明解题成功 |
| 云生成／图像、本地可用 ML、资源获取／搜索／依赖修复 | 原 Depth 插件真实 CPU／ModelScope 权重 23/23；SAM3 权重存在且校验完成，但固定原 SDK 无条件依赖 Triton，CPU worker 明确阻断（CUDA 排除范围），未写替代核。其余服务继续复用原插件／授权／Jobs 逐项核对 |
| Agent Graph／技能库／任务判定 | 复用原 campaign、policy-registry、sim_task_check 及原生角色／会话；按 Linux 合同验证完整流程 |
| 本机安装／启动／分发／升级／恢复 | R6／R7 已从清洁源码构建完整 arm64 包；真实安装、升级、同版本重装、回滚、恢复均 exit=0，原 SDK／doctor／物理检查通过后才切换 current。R7 源码 4cd99b6e，来源匹配 true。安装后 Guest 已创建物理工作区、登记11模型、原路径放置 Panda，rev1／2实体并关节实测0.1000；随后曾出现一次工作台黑屏，正常退出后同会话和 Scene 恢复，重放0→0.1→0、全屏及最小化恢复均通过，黑屏根因仍未确认，全面界面验收保持部分完成 |

当前必要兼容改动说明：

- `runtime-patch.ts`：macOS WindowServer 不使用 DISPLAY；仅调整平台可用性判定及已安装 Chromium 的应用路径，复用原插件路径和 launch／attach 协议。
- `unity-mcp-supply.ts`／`known-mcp.ts`：固定 wheel 为 py3-none-any，原 server 可在本机执行；只开放 macOS 准备与发现。`integration-discovery.ts` 增加 Unity.app 的系统／用户 Hub 安装布局，不读取私有 EditorPrefs。
- `policy-runtime.mjs`／requirements：同一 Torch 2.11.0 在 macOS 无 +cpu 后缀且 wheel／ABI 不同；只增加官方固定 pin 和平台版本核验。policy_prepare／match／execute 没有另写。
- 安装器下载子进程显式读取用户已有 HTTP(S)_PROXY，并保留 NODE_USE_ENV_PROXY=0；不改系统代理、Host dispatcher 或用户全局配置。原下载失败日志保留。下载复用既有 fetch-extscache-kit 固定 pin／Range／SHA／原子发布工具。此次显式用清华 PyPI 镜像加速同一 wheel 及依赖，官方大小／SHA 不变，不涉及 HF Hub；之后原 install-provider 与 managed doctor 已通过。

本轮新增必要兼容叶（业务 owner 不变）：

- `native-system.ts`／`payload-contract.ts`：调用同一个固定 SDK `host-addon-only` 构建 Mac 文件锁；Mach-O／arm64 与 Node-API 检查替换 Linux ELF／glibc 检查，锁业务没有改写。
- `package-linux.ts`：同一依赖收闭、模型／策略 stager、插件构建、许可／出处检查和归档新增 Darwin arm64 分支；Electron.app 的 Framework 相对链接必须用 `verbatimSymlinks:true` 原样复制，防止指回构建机。原生应用仅本机 ad-hoc 签名，未公证、未发布。
- `doctor.mjs`／共用 launcher／桌面启动：macOS 用同包 Electron 的实际 Node 模式验证 dyld 与 Framework；Finder 打开应用时补同包 Node PATH，不用 Linux ldd／setuid 沙箱。Host、账户、Guest 和插件入口复用。
- `unity-mcp-supply.ts`：macOS/Xcode Python 3.9 不满足同版 bridge 依赖。选择现有兼容 Python（优先 3.12），不兼容的产品未就绪 venv 完整迁出保留，再用原 venv／pip 重建；不降级 bridge，不改系统 Python。
- `mujoco-gl.ts` 与两套 benchmark 调用方：仅套件包装器在 Mac 缺省用其支持的 GLFW；直接 MuJoCo 仍用 CGL，显式用户选择仍优先。没有改写渲染器、物理或套件成功判定。
- `install-provider`：LIBERO 在 Mac 使用与 Linux 相同的 1.11.0／0.12.0／0.11.0 版本组的官方 CPU wheels；官方套件源码／worker／任务不变，Linux CUDA 分支保留。
- `runtime-patch.ts`：Finder 的 PATH 不含 Blender.app 内部可执行文件，补标准系统／公开 HOME 的应用布局发现；显式配置／已有 PATH 仍优先，继续使用原 Blender 插件。
- `main.ts`：补 macOS 菜单的 Command+Q 加速键，仍调用原 ExitCoordinator；R4 已实际按 Command+Q 打开原确认框、确认后进程 exit=0。R2 的窗口关闭→原生确认→退出已实际 exit=0。
- 测试只修环境／发行供给形状：明确 Linux／Mac launcher fixture；原 T0 roster 检查排除原 stager 的 `default-policies` 缓存目录，其余未知 pack 目录仍会失败。没有更改产品 readiness、Task 成功判定或扩大 skip 来过关。

本轮关键证据：

| 项 | 当前事实 |
| --- | --- |
| 官方 Linux 对照 | release_id `0.2.1-20261024`，源码 `00d3bc60`，归档 745242565 B，SHA `f554b3e9e275ec9cf15955ce92070e04865f07a054df37a98007d1104b511247` 已核；未执行 Linux 二进制 |
| 默认供给 | 329 个模型文件、11 种模型、199420853 B；两套策略原件逐件 bytes／SHA／Git blob 核验。Go2 保留 Linux 原 `DEFAULT_POLICY_LICENSE_MISSING`，没有补造许可 |
| CPU doctor | torch 2.11.0、MuJoCo 3.13.0、numpy 2.4.6、yaml 6.0.3，device=cpu、cudaBuild=null；原安装器最终 AVAILABLE。此前冷探测超时保留，不据此增加全局预算 |
| 真实策略 | Go1／G1 原链路均 COMPLETED，25 controls／25 inferences，分别 100／250 physicsSteps，均 0.5 s；不将短窗执行改写为长时步态或任务成功 |
| 原生外部插件 | Edge launch／attach 2/2；原 CUA 权限／目录 1/1；Blender 真 GUI 创建并读回 6/6；Unity stdio 47 tools。CUA 目标输入／截图、Unity Editor 真实任务仍待覆盖 |
| 便携候选 | R2 搬移后的同包 Node／Electron、Guest 工作台／11 个模型详情已实测；R3 归档 `711515296 B`、SHA `c3daafbf1974cb13d4abba5ab5bb85ad38bee5275ee1e687a49fab08ab84043a`；最新 R4 `711509169 B`、SHA `ddf34bda5f207423193edf0a33b3d18c2925c1854560aab29c186e3ad4913311`，desktop doctor AVAILABLE。R3 已实际重新打开同一游客历史会话及原 Scene 01；从原机器人面板选择内置 Panda、画布取点后预览就绪、提交放置并原路径创建地面／启动 MuJoCo，实际 rev2／2 个实体／mujoco ready；经原窗口确认退出 exit=0，物理／策略 SDK 是本轮明确指定的已有产品独立前缀，不冒充候选包自带 SDK。Guest 的 defaultPolicies 仍按 Linux 原 config.guest 分支返回空列表，故 Go1／G1 的默认准备状态不在 Guest 宣称；独立原执行链的真实 CPU 证据单列 |
| 复用专项 | 8 个文件 113 pass／1 skip／0 fail；新版完整 CI 首轮 406/408，缓存目录误判已修、负载超时隔离通过；第二轮实际 408/408、0 fail、62 文件按清单未运行，内部 4480 pass／48 skip。macOS 退出菜单加速键为其后的局部修复；R4 实际 Command+Q→原确认框→退出 exit=0，退出与恢复专项 2 文件 43/43 |
| 模型 Agent | 正式 Peiri 会话真实 read(marker.txt)→Tool 结果→最终回复→turn/end completed 已通过；标记未出现在提示中，最终回复与真实文件读数一致。先前本地 Qwen 4K 无工具／32K 超时记录仍保留，测试别名已清理，原模型标签及 digest 保留。完整 Agent Graph 真模型 campaign 尚未运行 |

最新日志均在聊天目录 `work/parity-*`；当前执行句柄／下载与待办应继续从实时进程、终态日志核对，不能因旧日志没变化重启或假定成功。

当前证据日志位于本聊天 work/ 的 parity-* 文件。只把实际通过项移入完成证据；原始失败与未运行原因保留。

更新日期：2026-10-27。任务开始源码基线为 `main@75d6af7a`；当前本地源码身份以 Git HEAD 和后续构建清单为准，未推送。

## 2026-10-27 新增真实验收与兼容叶

- **ModelScope 已获得本次用户明确授权**；两个对象都存在，不能写作“镜像缺失故跳过”。`depth-anything/Depth-Anything-V2-Small-hf` 四文件逐件校验，权重 99173660 B／SHA `3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70`，ModelScope revision `a8db4bb32be6d332824b70406a49cb67021892df`。它不是此前 HF revision，不改写来源身份。
- **单目相对深度原插件真实 23/23，exit=0**：用官方示例照片 2048×1362 和实际 CPU 权重，完整原 Tools／Commands／subprocess／Jobs／attachments 装配；同步图像、后台通知、相对路径、取消及失败分类通过。只改测试中旧 Linux 绝对路径／固定照片尺寸，预期 revision 可显式指定；worker、operation、模型及数值门槛未改。日志 `work/parity-depth-real-modelscope-r2.log`。
- **SAM3 保持阻断**：ModelScope `facebook/sam3` checkpoint 3450062241 B／SHA `9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e` 已核，固定官方源码 `660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7` 的原依赖与 Torch 2.10.0／torchvision 0.25.0 已装。原 CPU worker 实际 exit=2、`PROVIDER_UNAVAILABLE: No module named triton`；官方 `sam3_tracker_utils → edt.py` 无条件导入 Triton。按用户排除 CUDA 范围记录；没有写 CPU 替代核或假 mask。日志 `work/parity-sam3-cpu-worker.log`。
- **LIBERO 原依赖保持固定**：Mac 的必要构建叶位于 `packages/benchmark-libero/compat/tokenizers/`，原安装器只在 Darwin 调用；pip 下载同版 0.12.1 sdist、补同版官方 Cargo.lock、原 Rust 源编译，附原许可证及来源。`egl_probe` 同样由原源码实际编译成功。原安装器 exit=0，但开发检出无发行 `benchmark.js`，其自身明确报 `PROVIDER_CHECK_SKIPPED`；独立原 `script/benchmark.ts --check` 已 READY／exit=0、原 `real-sdk-boundaries.smoke.ts` 已 exit=0。
- **G10 房间与物理门禁 19/19、exit=0**：只修 Mac 临时根 canonical 路径验收，原建模／碰撞／保存重开不改。日志 `work/parity-g10-room-physics-r2.log`。
- **G19 实测项 10/10，整体仍 BLOCKED／exit=2**：0.2.1 原 SceneOperations 导入 animatedAssembly，原 browser-use + chrome-devtools-mcp 在真实 Edge／Metal 渲染；动画实际摆动约 64.7°、101 帧、5 种画布读数，暂停负对照通过。旧 gate 要求拆 glTF 节点的断言与原 0.2.1 不符，改为原动画装配合同；只改验收，不改 Viewer／Scene。原 gate 对照片真值精度、其他材质源和动画物理的未覆盖原因保留。日志 `work/parity-g19-final-original-browser.log`。
- **Mac 安装升级继续复用原状态机**：扩展原 release manifest／TSV、install.sh 与 install-entry.mjs 的 Darwin 叶，保持 versions／current／previous、锁、SHA、源码身份及 SDK 失败保留旧版本；macOS Applications 链接和 BSD 原子 rename 仅属系统差异。真实 shell／HTTP／归档／Node fixture 专项 54 pass／38 Linux skip；不是正式发行包安装验收。R4 源码出处仍为 dirty 候选，不能绕过 `sourceCommitMatchesPayload` 守卫激活；清洁源码候选的完整安装／升级仍待完成。
- **最新构建／类型检查**：原插件构建和 root／gates TypeScript 均 exit=0。新完整 CI 第三轮 408/408 文件、4488 pass／48 skip、0 fail／0 missing、exit=0；62 文件仅指该次 CI 未纳入，额外手动专项另列。前两轮406/408、407/408的真实失败及修复日志保留；没有降低门槛。

上述 ModelScope 权重仅留在 `.runtime`；Hugging Face Hub 的其他查询与下载仍限定 `https://hf-mirror.com`，没有访问官方 Hub 或静默换源。

## 版本与工作区

- 根项目、桌面应用清单及 bun.lock 中的桌面版本已统一为 **0.2.1**，账户页实际显示 `Lyapunov 0.2.1`。
- `v0.2.1`（`00d3bc60`）已经是当前 HEAD 的祖先。上游随后增加的 `8f619677` 原则与导航文档已应用到源码；由于本机 Git 未配置提交身份，没有创建合并提交。不要把已应用的文件误写成已经推进了 Git 合并历史。
- 固定 DSH 仍为 `54312dc5a8c4a63b60b3b92f51109f7bd1c1e852`，没有替换其会话、Agent、Jobs 或插件内核。原生通用设置中的 `0.2.0-rc.2` 是 DSH 底座版本，和 Lyapunov 的产品版本分别记录。
- Bun 已统一为 **1.4.2**：packageManager、CI 和当前开发说明一致。本机对照发现 1.3.13 在断流 HTTP、长 data URL 导入及 PROJ 子进程用例上存在兼容差异；当前完整验收采用 1.4.2。
- 本机：macOS 26.5.1 / arm64，Node 26.3.1，pnpm 11.7.0，Electron 43.5.1。pnpm 在固定 DSH 子目录使用；根项目使用 Bun。
- MuJoCo 3.13.0 位于 `.runtime/sim-python`；Newton 1.6.0 + Warp 1.17.0 位于 `.runtime/newton-env`。已把此前的 Warp 1.18.0 对齐到项目 requirements 的 1.17.0。

## 本轮修复

1. 桌面清单停留在 0.1.0-rc：更新为 0.2.1，并同步锁文件。
2. 源码树没有发行供给清单时，`robot-library` POST 返回 SKIPPED，把整个机器人目录显示为空：现在继续读取现有 pack 目录，展示真实型号和缺项，不伪造已安装模型。
3. Python 会把 macOS `/var` 解析为 `/private/var`，媒体发布后的回执可能仍指向已删除暂存目录：媒体暂存与发布采用现有 canonicalTargetPath，Newton 的实际采集文件与回执一致。
4. 人工录制／导出完成后误唤醒模型，并出现 Job 工具身份不匹配：人工 Command 使用原生 Jobs 等待者收取完成通知，保留原有会话归属与 UI 读取。模型 Tool 的原完成通知语义保留。真实界面与原生 Jobs 回归均已验证。
5. 异步加载关节目标 0 时，空字符串被 Number('') 视为 0，输入框保持空白并报假错误：现在填入真实零值。DOM 回归验证未读值为空、读回 0 显示 0、外部数值更新不会代发动作。
6. 修复安装器在 macOS 的物理路径判断、中文标点旁未加花括号的 Shell 变量，以及链接脚本对 canonical 路径的归属判定；保留拒绝接管外部自定义链接的行为。
7. 测试替身补齐真实 root 服务面；临时路径规范化；解释器、Node 路径和 MuJoCo GL 后端适配本机。Linux 专用安装／默认供给用例在 macOS 明确跳过，另验证 macOS 会在联网和激活前拒绝 Linux 发行安装器。
8. 补齐 Newton Go1 URDF 测试依赖，固定 Unitree 官方提交，逐件校验；不把这些测试依赖登记成随发行包提供的机器人或策略。
9. 相机页“录制该机位”的说明补齐中文。

## 构建与检查

在项目根执行：

```sh
export HF_ENDPOINT=https://hf-mirror.com
bun run build:plugins
bun run build:desktop
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p script/tsconfig.gates.json
TESTCI_BUN="$(command -v bun)" \
TESTCI_PYTHON="$PWD/.runtime/bench/gymnasium-env/bin/python" \
LYAPUNOV_MUJOCO_PYTHON="$PWD/.runtime/sim-python/bin/python" \
bun --no-env-file script/test-ci.ts --json /tmp/lyapunov-test-ci.json
sh distribution/macos/lyapunov doctor
```

本轮结果：

- 插件构建、桌面构建、两套 TypeScript 检查、doctor 和 `git diff --check` 通过。
- 完整清单：**408 个纳入文件实际运行，408 通过，0 失败，0 缺件**；62 个文件按清单排除未运行。
- 纳入文件内部的原始用例读数为 4,464 通过、0 失败、52 按平台或依赖条件跳过。这些跳过不视为对应能力已运行。
- 完整回归后发现并修复的零关节目标问题，另跑 `manual-events` 专项：1 个文件、9 个用例通过；实际界面重新加载后验证，且两套类型检查保持通过。该专项覆盖完整回归后新增的局部修复。
- 验收材料在本次聊天 `outputs/`：完整回归 JSON、零目标专项 JSON、录制导出核验 JSON、截图和自由视角视频。历史 253/253 与 45 项排除记录只属于旧清单。

## 实际点击与产物

| 路径 | 本轮事实 |
| --- | --- |
| 账户与重启 | 保留原 OAuth 会话；重启后版本为 0.2.1，历史与当前场景可重新加载 |
| 原生设置 | 通用、模型、内置插件、集成、Agent 预设、物理引擎、机器人库、下载均实际进入；从设置“打开场景”会关闭设置并返回原生工作区 |
| 新建与导入 | 新会话创建物理工作区，MuJoCo ready；系统 NSOpenPanel 选择 Franka 原始 panda.xml，导入素材库成功 |
| 放置与模拟 | 真实放置预览就绪，点击“放置物体”后场景 rev1、2 个实体，MuJoCo 同步 ready；不再需要此前未经当前验证的“所有 MJCF 无 bounds”判断 |
| 关节控制 | 0 目标正常显示；joint1 从 0 到 0.1 rad，实测 0.1000，回执 completed、targetReached=true、tolerance=0.03；已发回零目标的恢复动作 |
| 挂载相机 | 保存到真实 hand body，场景 rev2；同步后引擎读回，RGB、相机深度与 LiDAR 预览实际生成 |
| 固定传感器录制 | 640×480、RGB + camera-depth，1 秒模拟时长，18 帧；回放播放后时间线实际推进 |
| 人工通知修复 | 新的录制与导出完成后，原生任务面板显示已完成，没有新增模型回合；此前历史误唤醒记录保留 |
| 导出 | dataset.json 为 completed，18 帧、18 次采集、18 份标定；核对 125 个相对产物引用实际存在，missing=[]；taskAchieved 保持 null |
| 自由视角拍摄 | 实际拍照生成；连续视频保存为 webm/vp9、1612×886、20.68 秒、334,129 字节 |
| 表面批注 | 在 panda 表面点击后形成 1 条批注，显示实体身份、世界点约 [-0.97,1.16,0.62] m 及局部坐标语义，填写说明并保留；没有发送给模型 |
| 工作区 | 文件树与终端打开；真实 zsh 执行 printf，输出 LYAPUNOV_UI_TERMINAL_OK |
| 其它面板 | 物件、环境、物理、巡检面板可打开；巡检没有 campaign 时显示真实空态；产物抽屉可读回图像、录制与连续视频，视频播放入口可用 |

## 运行与依赖准备

```sh
bun script/desktop.ts --mode formal
# 需要调试端口时：
bun script/desktop.ts --mode formal -- --remote-debugging-port=9333
# 默认 Go1 Viewer 测试依赖：
bun --no-env-file script/prepare-viewer-test-assets.ts
# Newton 的独立 Go1 URDF 测试依赖：
bun --no-env-file script/prepare-viewer-test-assets.ts --urdf
```

URDF 来源为 Unitree 官方 `unitreerobotics/unitree_ros@15ebe53f4cd77e7d745ae83b9d7ff90e685e8998`。`script/prepare-go1-urdf-test-assets.manifest.json` 固定 URDF、7 个 DAE、package.xml 与 BSD-3-Clause LICENSE 的大小／SHA-256。默认 Viewer 清单保持独立；所有下载只准备测试依赖。

原生文件选择框的有效 CUA 路线：打开对话框 → Cmd+Shift+G → 设置路径文本框的完整值 → Return → 点击“打开”。不要用会丢失下划线的逐字符输入结果当作应用导入失败。

## 尚未运行或不适用

- Isaac 没有本机 macOS 发行路径，界面已移除；本轮不声明 Isaac、CUDA／RTX 或真机器人验收。
- 62 个清单排除项保留各自原因；全机型策略／VLA、真实模型 Agent Graph campaign、云分享发布与真实付款未运行。深度真实推理已通过；SAM3 原 SDK CPU 导入被 Triton 阻断，见上方当前记录。
- 此前核心验收时 11 个默认条目未供给；后续本轮已按 Linux 正式包补齐，最新资源与策略结果以上方持续目标表为准。测试资产本身仍不冒充发行供给。
- 此前核心验收仅到 Blender MCP 31 tools；后续本轮原真实建模门禁 6/6 通过，以上方新增证据为准。
- 自由视角照片／视频与引擎 RGB-D 来源分别记录。传感器采集保留真实 frameId／stepDrift；不把订阅帧和较晚采集的帧冒充完全同步。
- Bun 在 `--tsconfig-override` 下仍可能打印 directory mismatch 内部诊断；原生运行实例身份检查、408 个文件的退出码与完整回归终态均通过。该第三方诊断保留在原日志中。
- 当前 Franka 初始地面接触有约 0.0000325 m 的 INITIAL_OVERLAP 告警；引擎 ready、实际关节运动和录制均通过，该告警仍可在物理详情读取。
- 此前核心验收尚无 macOS 分发；本轮已有 arm64 便携候选及内置应用，仅 ad-hoc 本机签名，仍无 Developer ID／公证／DMG／发布／推送。已有账户、凭据及历史用户工程未用测试替身覆盖。

## 约束位置

遵循 `principles/DEVELOPMENT.md` 第 3／9／12／14 节的唯一状态 owner、账户边界、HF 镜像和证据规则；`principles/INTERACTION.md` 第 2／8／11／12 节的人机同路、可达性及 Camera／Capture／Recording 语义；`principles/AESTHETICS.md` 第 6 节的真实界面验收。所有 HF Hub 查询／下载／校验仍限定 `https://hf-mirror.com`，不自动回退。

## 本地提交及随后验收（2026-10-27）

本轮主要源码已用自动化身份 Codex 本地提交 `1743f15e86d63649c42ea855becf0271fe1932cc`，未推送。R6 清洁候选已构建：711535831 B，SHA `8f602d96191775f1c81d5eacba723fa4bfab28f5388416a09e5baf707006a2b7`，`sourceCommitMatchesPayload=true`，仍为 ad-hoc 本机签名。R5 首次因错误选择只含可分发两套策略的发行缓存、缺原 Go2 源清单而被原 stager 拒绝；已改回完整原策略源缓存，保留 Go2 无许可证的原阻断。R5 的空发布目录与失败日志保留，未覆写未知产物。

R6 由原 install.sh 对完整真实归档执行安装，隔离根为本聊天 `work/parity-real-install/`，应用链接只写其 Applications，未激活前不改变 current；随后已由原流程完成，R6首次安装、R6→R7升级及重复／回滚／恢复均已真实 exit=0；详细终态见下方当前追加记录。

新完整 CI 第二轮 407/408：提交干净后，空的 `bugfixHistory` 目录使原发布门禁遗漏已跟踪测试候选；已修正为“没有本轮回执时”沿用原 tracked-tests 回退，并覆盖空目录／旧轮次回执两种边界。不放宽通过门槛。该补修已本地提交为 `4cd99b6ede805536ec159f8aa64cc3caa92e5054`，R7使用该源码身份，未推送。

正式 Peiri 原生后台控件会话 `session-37674b18-cd17-4f12-b6b1-e447fe2fcc6a` 已 completed，7 次原工具调用、2 次图片；独立截图、AX 和测试应用 handler 均确认输入 LYAPUNOV_NATIVE_OK／计数1。两个测试窗口已正常关闭；Electron 后台 AX 只回显的限制与原前台拒绝仍保留。

深度人工指令会话 `session-325faa89-5b76-459a-85a4-51ac60454eeb` 实际执行 depth_status／depth_estimate，两次 command/done；界面读回 missing=0 与 artifacts=5，模型 request/header 为0，原人工入口未唤醒模型。

## 当前交接点（2026-10-27 02:40 左右）

状态仍为**部分完成**，持续目标保持 active。

- **完整回归已通过**：`work/parity-current-full-ci-r3.json`，408个纳入文件全部实际执行；4488 pass／48 skip，0 fail／0 missing，exit=0。62文件是该次 CI 未纳入，不能把本次手动跑过的 Depth／Geometry 等仍说成全程未运行。
- **深度几何原链路 51/51，exit=0**：使用本次真实 Depth NPY、metadata及原照片，原 Tools／Commands／Python worker／SceneOperations；真实相对预览7523顶点、19498三角面，近远顺序颠倒0处。假定锚点仍 unverified／accepted=false，不冒充实测米制标定。只修测试的旧照片分辨率与相应采样密度；生产几何代码不改。实际以原本支持的 Bun 1.4.2运行；原 Node 测试驱动在 Node26 的旧 experimental-transform-types 标记不再可用，失败日志保留。
- **R7完整包**：release `0.2.1-macos-local-20261027-r7`；711542398 B，SHA `7cd4f1d8706b640c629ce7273bb515fc311d6020e85ff4c8fcf260c6d622c185`；source `4cd99b6e`、sourceCommitMatchesPayload=true；仅 ad-hoc本机签名。
- **真实安装及升级状态机**：`work/parity-real-install-r6-result.json`、`parity-real-install-r7-result.json`与`parity-real-upgrade-roundtrip.json`。R6/R7均实际安装自己的MuJoCo及CPU policy环境，未注入SDK替身或手写.install状态。R7同版本重装→回R6→恢复R7，全部exit=0；最终current=R7、previous=R6，Apps链接保持原managed入口。原PyPI下载曾SSL断流；仅该安装子进程NO_PROXY及NODE_USE_ENV_PROXY=0后复用原partial流程完成，不改系统代理。
- **安装后界面当前事实**：独立Guest根 `work/parity-real-install/guest-data`，会话 `session-c7251296-07a3-4f11-934a-54a53286b3de`，Scene `scene_20c9b868-1c0a-467b-8c6b-db9c9e405613`。实际11模型登记、Panda原放置、rev1／2实体／mujoco ready；完整关节控制实测joint1=0.1000，零目标输入显示0。
- **未解决的界面现场**：首次实例在回零提交前出现全黑工作台、AX只剩工作台HTML根；renderer进程当时仍活着，没有desktop-incidents记录。经原Command+Q确认正常exit=0，未强杀。重启同一Guest根后原历史、Scene、Panda恢复；启用Electron原日志开关后重放0→0.1→0已完成且实测0.0000，全屏往返与最小化／Raise均保持界面。暂未稳定复现，不能宣称修复，更不能直接改关节／renderer业务来猜修。
- **当前活实例**：R7日志调试实例 exec session `58205`，主进程PID13113，工作台origin `http://127.0.0.1:56373`；日志 `work/parity-installed-r7-renderer-debug.log`（过滤token查询），没有新增远程调试端口。源码正式实例 exec `52931` 保留原账户／Peiri，显式启用原CUA与Depth；localhost发行HTTP服务 exec `60841`、端口65182。继续操作前应实时核对，不盲重启活进程。
- **下一步**：优先区分黑屏的实际渲染/视图生命周期原因，保留现有现场与原owner；随后继续完整真实模型Agent Graph campaign/技能链、其余非CUDA能力和外部Editor/云服务条件。Unity Editor仍未安装，SAM3仍是原Triton依赖阻断；未完成项不计通过。


## 最新真实验收与必要补修（2026-10-27 05:31）

目标保持 active，仍为部分完成。下列结果追加于 R7 安装候选之后；R7 不含本段新生产修复，不得倒写其版本或出处。

- CAD 原 worker 27/27：定位 macOS 缺省 TXT 字体回退与 Linux 验收基线不同，仅在 Darwin 缺少实际 TXT/SHX 字体时沿 ezdxf 公共 font manager 使用随包 DejaVu Sans；显式 `CAD_FONT_SUBSTITUTED` 警告，不代表原 AutoCAD 字体精度。字体从原 LIBERO 同版 matplotlib 3.5.3 官方 wheel 复用，逐项核 RECORD，附许可证和 SOURCE.json；不改 DXF 解析、bbox 算法或 golden 容差。原 CAD/图纸插件 48/48，独立 `.runtime/cad-python` 无 system-site-packages。
- 相机配准原求解器与真实 Blender 闭环 36/36，使用独立 `.runtime/camera-fit-python`（numpy 1.26.4 / OpenCV 4.6.0.66），无 system-site-packages。正式桌面现有进程尚未配置这两个新解释器；完成当前 campaign 后才正常重启并沿原 runtime-patch 注入。
- Blender 原运行专项 66/66；材质真实回读 1/1；UV/PBR 真导出及独立解码 4/4。只改测试的 macOS canonical 临时路径，及在原超时界内等待真实 stdout/stderr/子进程后验证运行中 pause/resume；不修改 Jobs 控制业务或成功门槛。
- 点云真实物理化 18/18：原 Trimesh/CoACD、资源队列、MuJoCo 接触和空隙落球，合法小型 XYZ 夹具，不代表用户约2GB原件已通过。测试根沿真实路径；CoACD 复用已由原 R7 安装器安装的同版原生依赖，不改运行中的源码 SDK。
- 原相机内参逐像素及 LiDAR 8/8：Darwin 原 CGL；最大多分辨率对应偏差 0.253 px、射线/深度/过期代次均按原判据。CPU 无限地面 MuJoCo/Newton 2/2，真远域落球、隐藏接触、删除重开自由落体与无重复 plane。
- 真实 Peiri Worker 的 `robot_move_tcp` 动作后已由原 `sim_task_check` 判真，但工具输出被原框架拒绝 `value is not lossless JSON`。定位为 body TCP 可选 `site` 及可选步号显式 undefined；仅在原 operation 按存在性输出可选字段，复用原 IK/执行/读回/判据，不写执行器。既有测试加入原 ToolRegistry 输出边界，修前8pass/2fail，修后10/10；这是接口夹具，不能代替修后真实模型动作验收。root tsc 已 exit=0。
- Agent Graph：原项目 skill-campaign / skill-debug / skill-verify，原 fresh subagent，保持 Peiri。旧 campaign `qa-macos-campaign-20261027` 因 TCP_MAPPING_REQUIRED blocked，原8calls/6160steps保留；heldout未评测，0calls/0steps不能算实测失败。Coordinator 仅通过原 robot_set_tcp 为两版输入配置 hand 原点测试 TCP，再经原 scene_save 导出。
- 新 campaign `qa-macos-campaign-tcp-ready-20261027`：parent `session-73e92f20-0bcd-4833-82ba-8e4ddc961725`；fresh Worker `763feebe-338f-48dd-8fe9-ed7fa7cc3564`，run `run-7926bc38-90c2-4e26-8fe6-0516118e1cdd` 已 success关闭；真实 joint1=0.0191916061 rad，固定[0.01,0.4]谓词 taskAchieved=true，原 proposal 已写、未准入。Verifier 刚由原 fresh subagent 派发；尚不能签整条链通过。保留原120calls/600000steps/1800秒预算，不重置。
- 专用测试 pack `packs/qa-macos-campaign-20261027` 尚在使用；完成后必须将产物移入本聊天 outputs 后再移出源码 packs，不能提交或混入发行。正式 Source exec52931保持运行，勿在 Graph 进行中重启。R7 exec58205仍显示同一真实Scene和joint1=0.0000；黑屏根因仍未确定。

原日志已同步到本聊天 `outputs/本轮复用验收-0.2.1/`，含失败复现与修后结果；完整 CI 第三轮4488pass/48skip是本段新生产修复之前的结果，不能代替最终新一轮检查。


## Agent Graph 终态与当前检查（2026-10-27 05:48）

新 v2 campaign 已由原 owner 收尾为 blocked。Worker 真实 taskAchieved=true，但 fresh Verifier 在 sim_open 前被原 wall 预算拦截（1856/1800秒），真实复现0次；其 verify record 也被预算拒绝，随后错传 outcome=blocked 被原 schema 拒绝，run 未关闭事实保留。没有准入技能，heldout未评测；Coordinator 本会话 run 由同名原生命令 budget-exceeded 关闭，0calls/0steps，随后heldout转blocked。原 taskAchieved=false 仅未评测阻断记录，不作为实测目标失败。完整原件已保存在本聊天 outputs 的 AgentGraph真实记录；本次专用测试pack已移到该处，没有提交或混入发行。

修后原TCP真实MuJoCo/Mink再跑：20mm请求，Y实测0.019990737423689186m，总目标误差0.000014982516818791503m，completed/taskAchieved=true、JSON无损往返，site正确缺省；collisionChecked=false保留，不签碰撞安全。此为非模型的真实物理验收。

R7调试实例再次出现空工作台：发生在CUA快捷键尝试后，主进程和Host仍在。原生菜单与关闭按钮均能弹出原统一确认框，确认后正常exit0；不能仅凭相关性就把退出业务定为根因。日志中另见早先04:05左右的scope session-maybe无adapter和sessions service unavailable，须继续按实际生命周期排查，未猜改SDK。Source正式实例也经原关闭按钮/确认正常exit0。

新增修复本地提交4ae5b07f3fa267b777a7226347389acbf7efc300，未推送。第四轮完整CI exec38895、新清洁候选R8 exec94060正在运行；第三轮CI仍只是其对应版本的通过结果。R8尚未完毕或安装签收。

## 黑屏受控复现及必要 Darwin 兼容补丁（2026-10-27 06:37）

R9 已出包并真实升级：711918029 字节，SHA256 为 `7918c69cd07701d34ad241c493ee26d836f801aed38c0bb99a92cdc42ca04e04`，源码为4ae5b07f，sourceCommitMatchesPayload=true，仍仅ad-hoc签名。原安装器完成自己的MuJoCo／CPU策略环境、doctor及真实物理检查；current=R9、previous=R7。R8首次漏传已有Linux资源供给根而被拒，之后同ID被EEXIST拒；目录和失败记录保留。正确供给根为 `.runtime/linux-0.2.1-supply`，策略源为 `.runtime/default-policy-sources`。

R9 的旧会话和Panda场景恢复，真实界面0→0.05→0、冻结／解除冻结、11部件树、展开／恢复视图通过。之后没有退出操作也再次空工作台，原日志同样报告session-maybe缺adapter及sessions service unavailable。

**已受控复现触发链**：原SDK按mtime／ctime／大小识别客户端构建。对本任务R9副本的ui-session/lib/client.js执行同权限chmod，仅ctime改变；inode、权限、mtime、大小和SHA均不变。原 `/plugins/events` 立即发布该包rebuilt（新rev=f6df1f05b8cd），真实界面再次变空。具体系统元数据写入者未确定，但ctime-only误触发已证实，不能再归因退出快捷键。试验未编辑SDK实现或移除系统安全属性。证据为 `work/parity-r9-metadata-hmr-repro.json` 及对应黑屏截图。

必要兼容仅改原SDK版本标识叶：Darwin在metadata变化时，用既有构建mtime与已读bundle字节识别版本，忽略纯ctime维护；Linux／Windows继续原metadata路径。保留原Watcher、SSE、Loader、插件图和状态owner；同大小实际改写仍可检测，entry构建时间仍能发布分块和source map新版本。没有另写管理器，也没有禁用热更新。

SDK两个源码文件已沿原 `generate-rc2-sdk-patch.mjs` 隔离重放、完整source签名与幂等检查登记。固定fork54312dc保持；原sdkProductPatch、sdk-source-integrity-rc2.json及UPSTREAM_LOCK更新，76 affectedFiles，patch SHA为 `faf8f58f117c55d66606de091c7fb12ae69200e9a50d872ba41e2a5f92b6f8bc`。原modules／hmr六文件159/159、原package类型检查、原补丁完整性15/15通过；已用原tsdown从源码构建宿主和客户端，未手改lib。尚待提交及新候选实际元数据／界面试验。

当前完整CI第五轮406/408：显式sim-python虽有tomllib，但缺图像记录依赖，导致Gym记录协议与离线Isaac采集夹具失败。改回第三轮实际通过的原 `.runtime/bench/gymnasium-env/bin/python`（3.12.15、NumPy2.5.4、Gym1.2.0、Pillow13），原harness复跑18个离线适配文件和1个Gym协议文件全部通过。保留两份完整失败报告，不拼成单次全绿；后续CI显式设置 `TESTCI_PYTHON` 为原基准解释器。没有为此改算法。

正式Peiri会话 `session-a5db6ba9-6adb-41ab-8da3-f59a3d58d250` 已completed：真实DXF单位／边界／字体警告、修后原TCP动作JSON与独立joint目标均通过，末尾sim_stop为step750。初始CAD／scene_open两次空参schema拒绝保留，之后正确调用才成功；未声明模型全程遵守单次指令。Source正式exec26911及R9 exec26259均已正常exit0；发行HTTP exec60841保留。

下一步：提交这组必要兼容补丁，用原packager和已有供给根出新候选，再走原installer升级；在新候选重做同权限chmod，确认无rebuilt且界面保留。Agent Graph v2仍blocked：Verifier预算拦截、未准入、heldout未评测；不改旧状态或重置预算。目标仍active。

## R10实际验收及流程收尾误判补修（2026-10-27 07:15）

Darwin补丁已本地提交df30af9a816e905e5e3b18988e103b9a5f2472c3，未推送。R10为711917601字节，SHA256=`6a895b1a156c9ff7dd8a0b117d3878fd7e6d40c4d0b4429c7ae4d7e2e9275b24`，sourceCommitMatchesPayload=true，原完整安装器真实升级成功，current=R10／previous=R9，doctor及真实物理检查通过。

**新候选实际元数据试验已通过**：原Registry确实报告本次安装字节与mtime对应的版本d9c8fbb44515。对相同ui-session客户端文件执行同权限chmod，仅ctime变动，inode／权限／mtime／大小／SHA不变；5秒原SSE观察没有重建事件，前后版本相同。独立CUA确认11模型、活动MuJoCo和完整界面保留；随后原界面实际执行0→0.02→0，稳定读数0.0200／0.0000，原命令回执均completed。R9同样试验会发出rebuilt并黑屏，形成实际负对照。原件为outputs的R10黑屏根因修复受控实测.json及截图。R10调试实例exec96042、origin56294保留运行。

继续Agent Graph时发现另一真实问题：新的Coordinator会话session-8ec30273-db59-45c8-9603-f423981c5eac收到原路由注入的“Stop（matched停止）”，把任务程序“求值并停止本次动作”的流程收尾当作立即取消。它只读输入／协议就结束，未创建campaign、子角色、run或提案。原指令还包含合法outcome枚举aborted；原英文stop/cancel/abort/halt子串匹配也会误判状态和标识符。

补修仅在原environment-routing.ts：区分同一次执行的收尾顺序与当前停止，保留立即停止、先停再做、已完成后停及停止另一场景；英文停止词增加词边界。仍调用原路由、原Stop工具和权限，不增加执行器。相关三文件134/134、root类型检查通过；用原样完整指令直接调用原路由，结果stage=none、无Stop提示。尚未加载此补修做新的实际Coordinator验收，也尚未出含此补修的发行候选。

该未启动验收的原件和空Pack已移至outputs/流程收尾误判原件，源码packs已恢复；没有重置任何已创建campaign预算。Source正式exec45404已正常exit0，以便重建补修。后续新验收应绑定包含路由补修的源码身份，并在原7200秒有界预算下使用独立Worker／Verifier；旧v2 blocked继续保留。

## R11及托管Peiri请求兼容验证（2026-10-27）

路由补修已本地提交3aba60d9667688e74021e095e8b63afbde9fefac。R11原包711918769字节、SHA256=`4a914dcd5808ef9838780396cb58a9c72edd97a7586a2467a442aa694392dc4f`，sourceCommitMatchesPayload=true；原完整安装器升级READY，current=R11／previous=R10，doctor及真实物理通过。本轮只把R10已校验的官方Torch wheel复制到R11原缓存目录，原ensurePolicyCpuWheel仍重新校验长度与SHA，不写安装状态。R11 Guest调试exec92470已启动，尚待读取恢复后的界面。R10长时保留仍有完整界面和真实0终值，之后正常exit0。

路由补修后的原样请求已实际不再收到Stop注入。但Peiri随后在一次响应中给出4个read，参数全部空，原校验／恢复护栏中止，campaign仍未创建。会话session-2cd35252-4268-4e8d-a08c-4ffc4c891e46的read schema确有file_path必填；不能通过放宽校验或恢复阈值修复。

为定位使用了本任务work里的临时Node --import观察器：仍启动同一个原Node及DSH CLI、同一正式账户／端点，不修改请求或响应字节；仅记录工具字段名与参数字节数，不记录参数值、提示词或认证。此观察器不进源码、补丁或发行。Source观察实例exec79592之后已正常exit0。原只读小请求的两个单调用参数分别134与92字节，原SDK正常转换；原完整流程的服务原始SSE则给出campaign_init、两次pack_skill_list、两次read，五者arguments均为0字节。缺参已在服务响应中，不是本地转换丢失。原件为outputs/Peiri并行参数缺失原始统计.json。

当前新增一个有界请求兼容：仅product composition托管端点且model.id=peiri时，经原pi-ai onPayload设置标准parallel_tool_calls=false；其他模型及自配同名模型原样。没有重建API客户端、修改认证／计费／续接绑定或补造工具参数，原工具校验和执行链保持。原adapter／SDK options／argument streaming三文件62/62、包类型检查通过，已由原tsdown --filter构建。已通过原生成器重放、幂等及签名登记，SDK product patch SHA更新为 `6c473887f2dd7e9d95ee72f538d19777c93a09465b897641a3c840c17ee5afb8`，76 affectedFiles；此兼容仍待真实服务请求验证，不宣称已经解决全部Peiri调用。

当前源码packs/qa-macos-campaign-routing-fixed-20261027仍是本次专用空验收Pack，只有.qa-owner.json；未创建同名campaign。不能提交该Pack或带入后续发行，结束后须将原件移入outputs。输入为work/parity-campaign-live/fixtures/scenarios-routing-fixed.json，原场景与固定goal保持，预算120工具／600000步／7200秒；不要重置旧v2。下一步先用原正式链路核实parallel_tool_calls=false真正发出且服务返回完整参数，再继续独立Worker／Verifier、真实dev／heldout；若服务仍不支持则保留具体阻断，不填造参数。

## 当前真实角色验收已推进（2026-10-27）

托管请求兼容已本地提交52787d46c57b18066b31fa54d90c92fb43a90b84，未推送，尚未出含此补修的新发行。真实正式实例已确认请求体发送parallel_tool_calls=false且HTTP200，read、pack_skill_list、campaign_init、subagent及Worker工具的参数完整。原完整流程已创建campaign，不能再把本轮描述为“未创建”。

- campaign：qa-macos-campaign-routing-fixed-20261027；原Owner文件在本聊天work/parity-campaign-live/.lyapunov/campaigns下。
- Coordinator主会话：session-8878245b-df13-4ccb-adf1-4db2f7b18f65；唯一实际创建的fresh Worker：9536d1a9-6683-46b0-8c70-5cc3c9417e1e，原one-shot subagent，保持Peiri。不要把未完成的服务流尝试当成新Actor。
- Worker run：run-fd5bfa57-cbba-4503-85f4-b768f33075d2，已由Worker自己进入exploring；独立导入TCP-ready dev并打开manual clock世界，初始固定joint目标判假。两次不合法TCP输入被原参数／delta守卫拒绝，随后读原状态继续。尚未据此宣称达到目标或技能准入；Verifier与heldout仍需原独立流程。
- 当前Source正式进程exec11415、origin54338、原Node观察PID22615；运行参数包含原Depth/CAD/Camera-fit显式隔离解释器。Source正在真实执行，**不要重启、重建SDK或覆盖运行状态**。被动观察器只在本聊天work，记录字段与字节数，不进发行。
- R11 Guest exec92470、origin58959：原Scene 01／Panda与mujoco已通过原界面恢复；R10已正常退出。R11含Darwin HMR与路由补修，仍不含新Peiri请求兼容。
- 当前源码临时Pack仍在packs/qa-macos-campaign-routing-fixed-20261027。它会产生真实proposal／verify／promotion原件；**不提交，不带入后续候选**，结束后先完整备份到outputs，再移出源码。现在不要再跑整轮CI或打包。

继续时优先读取当前campaign／run及fresh角色实际回执，关注sim_task_check真值、Worker自己的run关闭、Verifier≤2次独立复现及原verify record，passed=true才由Coordinator promote。Coordinator随后需在独立dev与heldout初始副本真实执行准入程序并求值；不以0调用状态迁移记成功。保留原预算和旧v2 blocked，不手写权威状态，不放宽恢复阈值。最新机器状态另见work/parity-running-status.json及outputs/当前运行状态.json。持续目标保持active。

## 一次性子会话漏关run补修与真实验收终态（2026-10-27）

上段的运行中状态已结束。唯一fresh Worker因无效TCP旧字段及零delta被原守卫拒绝，随后RECOVERY_NO_PROGRESS中止；没有成功动作、提案、Verifier或准入，heldout未评测。当前campaign经Parent原命令将dev置blocked，再沿heldout合法入口开Coordinator收尾run，原record_run记aborted、0工具／0步并注明未评测，最后blocked。campaign总计仍10工具／0步。旧Worker run仍无summary，作为旧版生命周期漏记账事实完整保留，不冒充其Actor或回写历史。

本次暴露的是一次性子会话已不可继续而run未关闭。补修仍在原agent-graph插件：监听原subagent/end，仅本地且持有open run时通过原SessionQuery读取原descriptor；只对one-shot，复用CampaignRuntime.closeRun，以原内存executedCalls／simSteps记aborted，不推断任务成功／准入、不迁移任务；continuable的epoch结束、父会话及已显式关闭的run不改。没有第二调度器、状态owner或恢复阈值变更。两项原SDK optional peer仅补依赖声明，原Bun离线lockfile-only同步，没有新增第三方包。

真实SDK AgentLoop／Subagent／SessionQuery／落盘回归31/31、root类型检查通过；模型响应与e2e_probe是明确接口夹具，不签真实机器人目标。新增正常结束漏记账、真实取消、显式结果保留、continuable原epoch反例。原件及专用Pack已完整归档到outputs/本轮复用验收-0.2.1/AgentGraph请求修复后阻断原件，Pack已移出源码，不提交或带入发行。Source exec11415及R11 Guest exec92470均经原关闭确认正常exit0；下一步可原流程构建包含52787d46请求兼容及此生命周期补修的R12。仍未把真实模型整条链路宣布通过。

## R13原安装与当前源码完整检查（2026-10-27）

生命周期补修已本地提交5d814ec1dab7fa90a7ced6f1400bbf806119b78d，未推送。当前源码完整CI第六轮408/408纳入文件通过、0失败／0缺件；用例4504pass／48skip，另62文件按原清单排除。明确使用原基准gymnasium-env Python，harness exit0。机器原件为本聊天work/parity-current-full-ci-r6.json，已复制outputs/本轮复用验收-0.2.1/当前源码最终完整回归.json；不与旧失败轮次拼接。

R12因本轮漏传官方便携Node路径，误用Homebrew动态链接Node，被原加载器守卫拒绝；失败目录与日志保留。R13按原distribution/macos说明改用已准备的官方Node26.3.1及原Linux模型供给根，未改打包器或绕过守卫。完整归档711927700字节，SHA256=`05a8dddf17b27fbd634d9e81c742e3a587d18f5d55e5aaa876159b73b0898f5e`，source=5d814ec1、sourceCommitMatchesPayload=true、943依赖／174原optional缺项；11默认模型及两套可分发策略沿原stager，Go2缺许可阻断保持。仍仅ad-hoc、本机arm64实测，未公证／发布。

R13首次原安装因pip未取得trimesh5.1.0失败，current R11及用户数据保留；官方PyPI确认版本存在。沿原installer续装同一归档成功，MuJoCo／CPU策略各自前缀、doctor AVAILABLE、真实物理PASS，current=R13／previous=R11。只将R11官方Torch wheel复用到原R13下载缓存，原长度及SHA校验保留，没有写安装状态。安装日志首次失败及续装成功均保留。

R13 Guest exec23991、PID40783、origin61738，隔离数据根仍为work/parity-real-install/guest-data。通过原侧边栏选择旧会话session-c7251296-07a3-4f11-934a-54a53286b3de并激活原Scene面板，Scene01／scene_20c9b868-1c0a-467b-8c6b-db9c9e405613、Panda、MuJoCo恢复，默认库11模型及部件11实读。人工输入核对后robot_move目标0.02与0原命令均completed，完成回执分别0.021803926777943357／0.00008535262594837819rad，随后AX稳定0.0200／0.0000，截图一致；模型请求0。

CUA控制途中曾提示应用身份变化，并出现一组原joint_move手调非预期目标、末值0.4427；输入来源未定位，不归因产品或算期望验收。重新用键盘输入并核对目标后才执行以上两次验收，原命令记录全部保留。一次停止入口操作又因在full AX后使用旧ID被CUA拒绝，随后按新AX现取控件身份成功；是自动化操作失败，不改产品。最后原停止入口确认动作已停、step333338；世界仍按原服务状态读回，未声称closeWorld。原旧场景仍有INITIAL_OVERLAP：Panda与地面初始深度0.000032494546179970274m，告警保持，不签碰撞安全或改几何／阈值。

本聊天outputs/本轮复用验收-0.2.1/发行R13保存原完整包及清单；交付说明与验收边界.md、R13真实安装与界面回执.json、R13原生命令控制原件.json、截图和当前源码CI原件已同步。完整真实模型Agent Graph成功链仍未签收，旧campaign均保留，临时Pack不在源码。持续目标仍active，不以本次CI或人工关节成功冒充全功能／全任务准入。

## 角色协议与原工具契约漂移补正（2026-10-27续作）

继续真实Graph前发现随带协议存在具体错误：skill-debug将robot_move_tcp的robotId写成entityId；pick/place示例缺原schema必填字段且使用旧位姿键；声称缺TCP可自动选手腕，实际原operation明确TCP_MAPPING_REQUIRED。skill-campaign让Coordinator代开／代关Worker run，summary示例手填工具数和步数；skill-verify允许取派发者runId。以上均与当前原schema／真实session owner冲突。

仅校正原三份SKILL.md及两份AgentGraph文档，不改operation、状态机、预算或目标。角色自行开关自己的run，summary只传outcome／notes；Verifier从自己的transition取runId，继续隔离Worker原件。原状态机终态无出边，复扫无合法入口时报告未运行，不能换壳重置预算。新技能仍须独立passed:true才promote；无新提案任务仍按原任务复核边执行，不新增准入要求。

本聊天work/check-agent-protocol-examples.ts装原Cordis Tools／Commands／Jobs及原workflows／agent-graph／task-check，读真实注册schema与原谓词校验，只校验JSON示例、不执行任何模型或物理。当前16例全部通过；HEAD旧Worker三例全被原schema拒绝，包含缺robotId、pick/place缺必填和旧位姿键负对照，exit0。纯文档改动未重跑全量产品CI或打新包；R13归档不包含根.agents目录，当前源码协议补正在Source正式实例中验证。旧所有campaign和预算保持。

协议补正已本地提交73084a0fa3d4e9815f7e1e61c00e971ab42da504。检查脚本的负对照现固定为补正前557abd74，不随HEAD移动；原16例／旧3拒绝已再次核对exit0，原件在outputs/本轮复用验收-0.2.1/协议补正与原schema核对。

Source正式exec50832、origin56036已恢复原Peiri账户。Parent=session-4651bf8e-55c3-4e56-9c6b-c16e367a0f77；已读取完整原则与三份原协议，期间一次误读产品根下fixture路径及两次glob未命中，随后自行找到正确路径，原错误保留。原campaign_init已创建qa-macos-campaign-protocol-20261027，startedAt=2026-10-27T02:55:19.979Z，预算仍120工具／600000步／7200秒，旧case不改。

本轮唯一fresh Worker=0e762095-4f63-4036-a5cb-3c13c5b98202，原descriptor version3／mode one-shot／provider spawn，label Run dev task worker；真实新read及request事件在推进，尚未据此宣称目标通过或准入。Parent原subagent阻塞等待，不能重派、恢复one-shot或猜Actor。当前pack为packs/qa-macos-campaign-protocol-20261027，只是专用验收原目录；不提交、不带入发行，结束后完整归档再移出源码。当前运行中不重启Source、重建SDK或覆盖权威state；候选R13与源码协议身份分别说明，不把源码协议补正算入旧归档。

## 真实Graph终态与隔离补修（2026-10-27续作）

上段角色均已结束：Worker在独立dev真世界初检false、TCP后goal=true，run success；唯一fresh Verifier在独立世界一次复现true、原skill_verify_record passed=true，Parent据此promote。Parent本人在不同dev及heldout初始副本均真实执行并判true。四个独立manual世界的原TCP回执各0→750步，collisionChecked=false，不签碰撞安全。

Parent首轮在heldout真值通过后被RECOVERY_NO_PROGRESS误停。一次人工补充后，仍由同一Parent会话调用原sim_stop和campaign_record_run完成收尾，无新角色、重置预算或重跑动作；第二turn completed，campaign原状态completed，两个任务done。原Owner显示累计1500步，两个Coordinator run各记0步；四个动作原回执的实际步区间合计3000。历史状态没有回写，完整原始case及专用技能包已移入outputs/本轮复用验收-0.2.1/AgentGraph协议补正后真实记录，不留在源码发行目录。提案由模型填写的checkedAt为00:00早于实际campaign创建，保留原值但不作为实际证据时间；原事件与promotion时间为准。Verifier曾被原skill工具提示skill-verify未发现，且首次debugging→debugging被原状态机拒绝，随后读取协议并自行进入verifying；这些真实错误保留。

另在R13 Guest真实下载页复现人工安装作业完成唤醒模型：Blender已有软件检查实际completed，却写入tool-jobs通知并触发Guest turn/start→blocked。下载页首次请求一直busy，重新进入后能看到原Job，但标题误显示Job Registry UUID；全局Jobs面板可读该Job真实输出。原场景、用户配置和R13安装状态保留。

为不干扰已完成的原会话，在本聊天work/parity-live-fixes Git worktree（基于73084a0f）准备原实现上的有界补修：人工供给入口同步注册原Jobs等待者，模型入口保留原通知；安装活动标题显示原job.label而非把registryId当软件ID；原TCP回执传出真实帧世界身份与标准起止步号，sim_task_check正常评估附真实帧身份。没有第二owner或执行器，也没有降低恢复预算。原事件362条离线重放：旧事实handoff、补真实owner元数据后continue、重复同帧3次仍handoff；只做投影因果验证，历史原件不改。独立工作区原技能Provider及skill工具在补入原三个角色后均可加载，源码 .agents 入口链接同一份插件文件，不复制第二套协议。

上述补修经隔离副本定向163项与类型检查通过，已本地并回源码提交db288981974bd9375169afdb576e8e02fef6deca，未推送。原Source exec50832及旧R13 Guest exec23991均经原退出流程exit0；专用QA技能包已归档并移出源码，历史promotion只属于测试时的该包，不声称仍在当前产品库。当前源码完整CI第七轮exec52278运行中，显式使用原基准Python，尚待结果；随后需要原packager、installer及实际界面复测，不能把隔离夹具或R13结果冒充新候选。

## R14 实际回归与 R15 发行边界（2026-10-27）

补修后原完整 CI 第七轮完成：410/410 纳入文件、4509 pass／48 skip、0失败／0缺件，另62文件按原清单排除；原基准 gymnasium-env Python，harness exit 0。原件在本聊天 outputs/本轮复用验收-0.2.1/当前源码最终完整回归.json。R14 以 db288 构建且 sourceCommitMatchesPayload=true，711942733 字节、SHA256=300882332a3fc8f7a3daff3dae1653803f059df53ceca3ed88b5e89ec3389bd7；原 installer 实际升级，doctor AVAILABLE、真实物理 PASS。R14 Guest 原生设置可搜索三份角色，正式 Peiri 在无角色文件独立工作区一次原 skill-verify 调用完成；实际下载页 Blender 已安装检查完成、显示所属 Job 输出，不再新增 turn/start。原 SDK、Jobs 和 DOM 补修测试分别覆盖模型通知保留和不同任务输出隔离。

真实物理预算专项使用原 MuJoCo／Mink／ToolRegistry／Campaign owner：动作 0→750 步，500步预算在下一操作被原守卫拦截；该专项不修改旧 campaign。正式模型受控两世界回归 session-999703d9-dbcc-49e4-b36c-228cbac7d9e9 已正常 completed，按 scene_open、sim_open、sim_task_check(false)、robot_move_tcp、sim_task_check(true)、sim_stop 对两个独立 manual 世界各执行一次；动作均 0→750 步，未发生误恢复中止。collisionChecked=false；两个 sim_stop 只说明动作已停止，不声称世界已关闭。原工具事件在 outputs/本轮复用验收-0.2.1/R14补修核验/双世界真实工具与回执.json。旧 Graph 实际四次动作3000步但历史 owner记1500的事实不回写。源码 Source exec15638 仍打开但这次模型回合已结束；R14 Guest exec84966 仍打开。

发现 R14 清单 minimumMacOS=14 与原 pinned ompl==2.0.1 官方 arm64 wheel 的 macosx_15_0 下限不一致，PyPI无该版本 sdist；本机仅 macOS26.5.1 实测。为避免默认完整安装产生错误承诺，独立副本改原 packager 清单为15，原 operation、SDK pin、算法和安装器不改；本地提交并回 ce1249b58a4929ab933569512fb38da0b94f79c0，未推送。源上安装／打包专项29通过、38跳过、0失败。R15 原 packager sourceCommitMatchesPayload=true，711945785字节、SHA256=9f01a2f3414f94cd8eaf3c2d31b89166ba09db403b2b4adde71762260e8914b6；完整归档与清单在 outputs/本轮复用验收-0.2.1/发行R15。macOS14及15均未实机验证，不把声明修正当成14已兼容。

当前 R15 原安装器升级 exec24950 正在隔离 product 前缀运行，使用原缓存和固定 wheel，保留原 SHA／长度守卫；不要并行启动相同升级。current仍R14、previous仍R13，成功与否需核验 exec24950 日志、原 doctor／physics 和实际 current。R15只是清单兼容边界变化，R14安装界面行为不能冒充R15已实测。持续目标仍active；Unity Editor、Go2许可、SAM3原Triton／CUDA、G19等具体限制按交付说明记录。

R15 首次原安装器在 Conda Python 3.12.16 下载两次 TLS unexpected EOF 后第三次长时间无进展；本次主动终止 micromamba（exit143），原安装器报告失败并保留 current R14／partial／日志。其失败原件在 outputs/本轮复用验收-0.2.1/R14补修核验/R15首次依赖中断日志.log。已有 R14 原缓存相同文件 SHA256=23d06f02f64e6c768fce624cf369a92544a49e9cee29d3ee6762058474c912c2，与 R14 Conda metadata 一致；将 R15 未完成下载和空壳前缀各自改名保留，复制同文件到原缓存，沿原 installer 重试 exec44132，不绕过原解析校验。仍需等新安装器终态确认。

R15 同一原安装器续装已成功：doctor AVAILABLE、MuJoCo 真实物理 PASS、current R15／previous R14；首次中断及续装两份日志保留。原测试账户 R14 已通过界面正常退出；R15 新 Guest 独立数据根 exec50110、origin56228 已实际启动。欢迎页为 0.2.1，但真实通用设置页显示“当前版本：0.2.0-rc.2”；前者来自产品 app 版本，后者从原 SDK 插件构建时注入的 DSH_CLIENT_VERSION 获取。实际界面原件在 outputs/本轮复用验收-0.2.1/R15实际界面。

为修正版本来源，不改 SDK 插件代码或状态：新增 script/client-release-version.ts，原 packager 在复制 staging 后，对三个真正读取 DSH_CLIENT_VERSION 的原 SDK 客户端（ui-settings-general、ui-settings-account、ui-sidebar）调用其原 tsdown 构建器，以根产品版本为构建参数，将生成的 client.js 只写入发行 staging；不覆盖源 SDK 的 lib，不改其余依赖或逻辑。定向 test 调用真实 SDK 构建器，检查三个输出使用0.2.1且源 SDK 输出逐字不变；script/package-linux.test.ts 21通过0失败。本地并回 9a554f734ab8ebb7685552168a52e0ccd5429633，未推送。原 packager R16 sourceCommitMatchesPayload=true，711941038字节、SHA256=00bdb8d77f6bedae3bd12d721c70da45e5ad13ccec16d4aaba885dc0a6d4d120，minmacOS15。

当前 exec98306 正沿原 installer 在隔离 product 前缀升级 R16；只在独立 cache 副本复用 R15 原 Conda／pip与Torch轮子，原校验未改，尚需核验成功、current、doctor、物理和新界面版本。R15 Guest仍打开且不能当作R16的界面。目标继续active。

R16 首次安装因本次复制 Conda cache 时跟随符号链接，ncurses 原符号链接被变成普通文件，原 Conda 回滚并保留 current R15。失败日志、半成品和缓存副本均保留；重新按 symlink 原样复制后原 installer 续装成功：current R16／previous R15、doctor AVAILABLE、真实物理 PASS。R16 独立 Guest exec42534、origin57104，欢迎页和通用设置均实际显示0.2.1，截图与原生AX在 outputs/本轮复用验收-0.2.1/R16实际界面。选择隔离 ui-workspace 后原界面创建物理工作区、MuJoCo ready；三份角色技能在原集成页均显示当前作用域可用，Verifier显示模型加载／用户调用允许、工具可见；游客无模型，未在 R16 伪称真实模型调用。原停止入口回执动作已停step98111，世界状态仍显示运行中，不能声称 closeWorld。R16与R14原任务／TCP／目标检查及三份角色文件逐字节一致。历史CI为db288的410文件／4509项；R16之后仅发布元数据及原SDK客户端构建变更，有相应定向测试，不能冒充最新完整CI。

## 真实引擎扩展验收与测试夹具修正（2026-10-27续）

本轮基于已安装 R16 的独立 MuJoCo 3.13 Python 与本机 Blender 5.2.3，执行原完整CI因环境标记排除的能力测试。未动产品引擎或原插件执行路径：

- 首次 MuJoCo 扩展 53 项中50通过、3失败：仿射夹具中探针需要地面，但旧测试假设隐式默认地面；现有 world_physics 合同明确只有显式 ground 或场景支持面才有地面。失败原读数和日志保留。只在两个落体夹具的原 open options 及同一Python检查器中显式 ground=true，不改 worker、不放宽位置／碰撞判据；随后原 Node + tsx + R16 Python 整轮七文件53/53通过、0跳过，涵盖动作终态、仿射／镜像碰撞、原生静态三角、弹性体与缆线、相机及 worldbody-only。独立 Bun 相机挂载／URDF原引擎5/5通过。Node 26不再接受旧 --experimental-transform-types，第一次命令因此退出9；改用仓内固定SDK现有 tsx loader 后执行，没有改产品。
- Blender真实操作合同首次53/57，四处期望 `/var/...` 与Blender回执 `/private/var/...` 指向同一个目录；增量测试也因此在 relative_to 抛错。只在原 test_world_harness.py 的临时工作根调用 Path.resolve，未改 world.py、产物或断言；随后原测试在隔离 worktree 真实 Blender 重跑，操作57/57、增量70/70，包含212实例。首次失败日志与修后日志都保留。额外网格有效期8/8、文字曲线派生21/21、本地化材质20/20、真实Blender5.2动画曲线3个实测正反例加1个明确替身旧分支通过；两个便携场景文件28/28。
- 真实 MuJoCo camera_capture 输出路径测试先因相同 /var 别名在字符串前缀断言失败；仅将测试临时根 realpath，原相对路径、宿主诱饵、PNG/深度实际解码及世界坐标断言不变；重跑真实引擎1/1通过。其余同时运行的测试11通过、7跳过，其中7项因 Blender实际与factory都是英文且缺旧版对照文件。只在聊天 work 的独立 BLENDER_USER_CONFIG 中准备 zh_HANS，不动用户配置，原中英文哈希／resourceId对照7通过、1跳过（需要未找到的改前 world_incremental.py，不能伪造）。
- 源码本地测试夹具提交1a7217f2、f9975924、a6565250，当前HEAD a65652502cc4df6a713c58d0520207df28239f09；R16 发行源码仍9a554f73，此后差异仅四个 test 目录文件，原 packager 排除 test 目录，未更改运行载荷或重打包。不是新一轮完整CI。全部原始失败与成功日志在 outputs/本轮复用验收-0.2.1/真实引擎补充验收。原有效未验证／跳过事项依旧，持续目标保持active。

## Newton 安装版本漂移补修（当前进行中）

在R16真实安装版直接运行原 `lyapunov install-provider newton`（独立newton-env，CPU，exec61885）；实际pip解析显示 newton==1.6.0却选 warp-lang==1.18.0，而原 `packages/sim-newton/requirements.txt`、源码已验证CPU环境和原 camera.test 均要求1.17.0。该进程仍在下载依赖，不因轮询超时重启或覆盖其前缀；截至本次记录尚无终态。日志 work/r16-Newton原安装器.log。此差异不仅是UI显示，固定依赖应沿原清单消费。

原 distribution/linux/install-provider 的 newton 分支补入 `-r packages/sim-newton/requirements.txt`，保留原 newton[sim,importers]==1.6.0 和原pip／doctor／owner，缺文件在安装前报 RELEASE_PAYLOAD_MISSING；不改版本清单或算法。原安装shell离线接线、缺件反例和既有安装专项22/22通过（夹具pip明确为替身）。本地源码提交54c8851b7950275c9400c108ab4ebcb767ad2949，原 packager 已构建R17，sourceCommitMatchesPayload=true，711940814字节，SHA256=d856fdc3d078c322390e2744888cc2590d71d9ba709fe35cbf4921c656ceb272；仅本地、未公证发布。R17原installer exec76394正将其安装到隔离product前缀，当前不得并行重复同一安装。R16与R17安装是不同前缀，可分别观察终态；R17需在成功激活后经其原install-provider newton验证1.17.0和真实CPU结果，不能以离线夹具或源码旧环境冒充安装版已通过。缓存复用仍由原Conda/pip校验，HF只允许镜像。

R16 Newton 原入口 exec61885 已终态exit0：原 doctor 检出 newton1.6.0／warp1.18.0、CPU可用，明确physicalExecution=false；这是旧入口安装依赖漂移的真实证据，不算真实动作通过。R17 原安装器 exec76394 exit0，current=R17、previous=R16，原doctor AVAILABLE／真实MuJoCo physics PASS。R17安装归档完整校验SHA256=d856fdc3d078c322390e2744888cc2590d71d9ba709fe35cbf4921c656ceb272；本聊天 outputs/发行R17 已保存。R17 专用 `lyapunov install-provider newton` exec55681 正运行，使用各自独立前缀和公开包缓存；待原doctor与真实CPU核对1.17.0，切勿把其正在运行的状态当作成功或并行重启。R16/R17全部安装均仅隔离测试目录，不修改系统或用户默认代理。

R17 Newton 原安装 exec55681 已完成exit0，原doctor AVAILABLE、newton1.6.0／warp1.17.0、GPU false、device CPU；独立包内 Python 实读 mujoco3.12.0／mujoco-warp3.12.0／numpy2.5.4（满足原>=1.25,<3）。R17安装版 Newton 的3个Python worker文件与当前源码逐字节一致；以R17的Newton及MuJoCo解释器执行原相机与无限地面真实CPU回归9/9、0跳过，测试使用源码worker（逐字节等同发行版），未冒称替身。日志在 outputs/本轮复用验收-0.2.1/R17核验。

R16 Guest exec42534经原退出确认正常exit0。R17 Guest隔离数据根首次exec95186、origin59604，设置页发现Newton1.6；点选Newton后显示“已保存，重启后生效”。原退出并重启exec50867、origin64158，设置页显示当前和下次Newton；选独立 r17-newton-ui-workspace，经原UI创建物理场景，newton ready、物理帧递增（例如34664→47606），CPU设备降级告警明确。通过原面板依次实际暂停、继续、关闭：UI分别显示已暂停、已继续、物理世界已关闭；不是仅停止动作。原生AX与截图在 outputs/本轮复用验收-0.2.1/R17实际界面。当前R17测试GUI仍打开，但世界已关；未把一次地面场景外推为所有Newton模型／任务成功。HF仍只用镜像；Newton包及其依赖从原PyPI入口按固定插件清单安装。

## R17 OMPL 原工具真实规划补充（2026-10-27续）

原 `motion-ompl/test/export.test.ts` 只测缺解释器拒绝，不能证明规划真的可用。本轮对R17安装版 `packages/motion-ompl/dist/plugin.js`（不是仅源码）使用原SDK Context／ToolRegistry／Subprocess／Jobs与 tool-jobs，算法解释器为R17原MuJoCo 3.13／OMPL 2.0.1。测试为人工简单关节模型，不启动真实模型、GUI或硬件：一维无障碍得到30点；一维障碍切断通道返回noSolution并有大量碰撞拒绝；二维有障碍成功绕行，原前台结果100点和原后台Job经job_output读取的100点各由另起真MuJoCo对每段十等分独立核对1089采样点，穿透均0（原容差0.0001m）。这是离散采样，不声称连续碰撞安全、复杂机器人避障或真实任务成功。完整原结果、3份MJCF与复现实验在 outputs/本轮复用验收-0.2.1/R17-OMPL验收。

新增可复跑 `packages/motion-ompl/test/real-provider.test.ts`，原清单标记 envgate/exclude 以避免缺SDK伪通过；显式R17 Python及原Node/tsx在源码HEAD运行1/1通过0跳过，实际含前台通路、阻断、绕行、后台job_output及各自独立采样。`test-ci.ts --list` 410纳入／63排除／0缺件，根tsc源码最终exit0。最初临时Node探针误用 `.ts` 被tsx当CommonJS拒绝顶层await，改用 `.mts` 后实际执行；首次后台测试因测试装配漏装原 tool-jobs 而拒绝，补齐原组件后通过；没有修改产品Jobs。一次误把 `test-ci.ts --help` 当帮助命令（该入口忽略此参数），被 `head` 提前断管导致EPIPE，不能算完整CI；已有完整CI仍为db288的历史记录。本地源码提交0f09fe51、cb026693、9869b4e6，当前HEAD=9869b4e61af8594102043716f6044ae0714c39aa；与R17发行提交54c8851b相差仅一份测试及其清单登记，不宣称R17的sourceCommit已改变。目标仍active，需继续查未覆盖的Linux能力。

## R17 随包 CPU 策略、停止与重启（2026-10-27续）

在独立 work 目录调用R17随包默认策略 `prepareDefaultRobotPolicies`，按原供应清单逐件校验、由原适配器准备；Go1与G1 PREPARED，Go2维持 DEFAULT_POLICY_LICENSE_MISSING。实际复用R17打包的 `policy-registry/dist/plugin.js`、原 `policy_execute`、Jobs／`job_output`、SceneOperations与包内MuJoCo/CPU Torch；测试Agent与场景在隔离工作目录，无正式模型/GUI调用。Go1与G1分别指令 [0.1,0,0]、4秒、各200控制/200推理，返回COMPLETED，实际物理步分别800/2000，原stop回执stopped=true，world各自关闭；Go1起始z0.34、4秒末0.2427、控制帧最小0.1927、x末0.1657；G1起始z0.793、末0.7780、最小0.7721、x末0.4061。逐帧四元数最小本体z轴与世界z点积分别约0.9908/0.9971；这些只是4秒样本，COMPLETED不等同自主任务成功、长时步态或硬件安全。

轨迹中的地面接触须按距离与geom归属分开：Go1的 `__geom_18`/`__geom_29` 是小腿邻近候选、距离为正，不应称为真实触地；负距离样本归属四个原命名足端。geom→body映射经R17真MuJoCo重装配读取，没有按名称猜几何。后续单独G1测试实际运行推进30步后经原 policy_stop 返回CANCELLED、Job killed、stop确认，随后同一世界原policy_execute 0.2秒完成10次控制/推理，再次stop返回NOT_RUNNING。完整逐周期帧、原回执、验证代码和首个测试装配调用错误记录在 outputs/本轮复用验收-0.2.1/R17-策略CPU验收。

新增真实依赖门 `packages/policy-registry/test/native-cpu-execution.test.ts`，仅当显式发行供给及两个隔离Python存在才运行，原清单按 envgate/realmodel 排除；R17依赖在源码HEAD实际1/1通过0跳过，原清单410纳入/64排除/0缺件，根tsc exit0。本地提交9f714e5208f3172d1a7a77f51e1e6fed4ea69184，相对R17运行载荷仅测试与清单，不改变 R17 sourceCommit。因为Newton安装入口在上一轮完整CI后有变更，当前源码原完整CI exec19960正运行，HF镜像、原gymnasium-env Python，绝不能在其结束前写全绿；原报告在 work/r17-当前源码完整回归.json，日志 work/r17-当前源码完整回归.log。

当前源码 `9f714e5208f3172d1a7a77f51e1e6fed4ea69184` 的原完整CI exec19960已终态exit0：清单474文件，410纳入且全部运行通过，0失败/0缺件；用例4511通过、48跳过；另64文件按原清单排除未运行。原基准gymnasium-env Python，HF_ENDPOINT=hf-mirror.com。原件已保存 outputs/本轮复用验收-0.2.1/当前源码最终完整回归.json及.log；先前db288的第七轮另存R14源码完整回归历史-r7，未混算实引擎额外专项。R17归档sourceCommit仍是54c8851b，源码此后差异仅两个实引擎测试和测试清单，未重新构建或改写发行包。当前目标仍active，缺失Unity Editor、Go2许可证等按用户要求跳过并说明；真实硬件、外部云功能及全部按钮仍未完全签收。

## R17 Newton Panda 实际故障与 R18 状态投影（2026-10-27续）

R17隔离Guest session-9c021200-41a3-4906-b277-85d8682553a7，在已关闭世界的Scene通过原机器人库选择franka_panda、加载真实放置预览、放置后得到scene_92b08019-d067-4641-8297-45eb1445d604 rev1与实体entity_7ef1e1b1-32be-4919-b2dd-4126312cb2e0；原 sim_open newton1.6/warp1.17/CPU/X PBD报告ready，但第216步约0.432s出现 ENGINE_INSTABILITY/非有限刚体状态，世界实际不可用，原UI底栏却仍称“物理世界运行中”，旁边显示错误。当前R17实际世界故障未修复，截图、AX、原scene和隔离复现实验均在 outputs/本轮复用验收-0.2.1/R17-Newton机器人问题；不要声称Newton Panda可用或关闭该故障历史。

同一原R17 worker/相同Scene在隔离进程复现216步发散。MuJoCo原装配使用源MJCF home（joint4=-1.57079、joint6=1.57079等），Newton实际初始化全零；测试中以原MuJoCo读home、赋值Newton并eval_fk后仍在242步发散。home+dt0.0002在1742步（0.3484s）发散；home+禁自碰撞204步、home+移除地面343步、home+Featherstone181步仍发散，home+零重力1000步有限。后四种是隔离反事实，不是产品修复；不得改用户重力、禁碰撞或换求解器假报成功。Newton XPBD明确不支持原执行器力限、等式/模仿约束；Panda原MJCF含力限general与手指等式，源驱动被Newton归类为torque且不可用，可能涉及受重力的无驱动/约束动力学，因果尚未完全证明。保持原插件、原源模型与求解器；物理问题继续调查。

已只修状态投影：原 workbench 在state轮询实际读取当前同Scene的status=unavailable后，清旧Frame并将原statusReason投到原SceneWorldLifecycle的failed，不覆盖正在初始化/同步；WorldHandle只增加实际statusReason可选字段。无第二状态owner、不改worker或物理。真实Workbench React DOM受控后端负对照：旧源码收到unavailable仍running，补修后failed并显示原原因；跨Scene与在途重试反例通过；4文件54/54、root类型检查通过。新增DOM门归原完整CI清单，当前411纳入/64排除/0缺件。本地源码提交24c303237a802be0e4b9449bfa8cc26498942775。R18原packager sourceCommitMatchesPayload=true，711943201字节、SHA256=f6bd1da6508108b78c8f97bcfcf6b06868b22898cef5b5257380614fe8789b87，归档已保存在outputs/发行R18；原installer exec39913 exit0，current=R18/previous=R17、doctor AVAILABLE、真实MuJoCo物理PASS。R18原install-provider newton exec20611正运行，需等待其终态并在R18实际UI复现同一已知物理失败、核对状态显示，而不能把状态修复说成机器人修复；不要重置用户场景或改动已有R17实例。

## R19 故障清理与真实界面验收

隔离安装当前为 R19，源码提交 `338828767478ee25ced7c654c912cc4b69cb4d1f`，由原打包器及安装器构建和安装，源码与载荷匹配，doctor AVAILABLE，MuJoCo 真实物理 PASS；Newton 原安装器完成，Newton 1.6.0／Warp 1.17.0。归档仅本地 ad-hoc 签名，未公证或发布。

实际安装版 UI 中，Panda 仍触发 Newton 非有限状态，物理问题未解决。R19 现在在故障时显示真实失败而非持续显示运行中；故障后通过原界面关闭物理世界，关闭操作返回成功，随后工作台正常退出（进程 exit 0）。但关闭成功后界面仍保留上一条故障状态，尽管引擎已显示未启动：这是仍待修复的状态展示缺陷，不能称为完整验收通过。

故障清理复用原 Newton worker、world owner 及 `sim_close` 调用链；仅当模型已因故障释放、活动和待执行动作均为空时允许停止成功，并保留真实错误原因。错误代次及其他失败仍拒绝。针对性测试 82 项通过、类型检查通过；另有真实 Newton 故障清理验证和旧版负对照。上次完整 CI 对应较早源码 `9f714e52`，不能称为 R19 完整 CI。

本次测试曾因漏设隔离偏好路径而创建用户级 `~/.config/lyapunov/engine.json` 并选择 Newton；文件创建时间与写入时间相同，且仅含此次测试的 engine 和 updatedAt。测试前为自动选择，现已移除测试新建文件，恢复自动选择；R19 实际界面后续验证明确使用工作目录中的独立偏好。Unity Editor、Go2 许可、G19 所需照片真值与外部云／真实硬件按缺条件跳过；Isaac 和 CUDA 不在目标内。仍不能断言所有功能逐项点击可用。原始界面记录、安装及测试日志见 R19核验。


## R20a 关闭回执竞态修复

源码提交 `408535ed7a104faf542bf30e84165dfc13377151` 修复关闭回执迟于世界列表轮询造成的状态残留。沿用原工作台与生命周期 owner：关闭成功后只更新同一场景、世界和代次的原状态；新初始化和其他世界不被旧回执覆盖，关闭失败不报成功。真实 Workbench DOM 复现旧版竞态失败，修后两文件 37 项通过、根类型检查通过。

R20a 已由原打包器和安装器在隔离前缀构建、安装，current=R20a、previous=R19，源码与载荷匹配，doctor AVAILABLE、MuJoCo真实物理 PASS，原 Newton 安装器完成。原包 711954666 字节，SHA-256 `f7a2fa7d9c59cc6aa1371f112aa808b4a79395c54c4d04a22ba8726ca18a02d1`；本地 ad-hoc 签名，未公证或发布。第一次打包因未指定既有机器人供给路径而中止，保留失败日志；指定原 Linux 0.2.1 资源供给重试成功。

在安装版真实 Guest 界面复用隔离 Panda 场景：Newton 仍出现非有限刚体状态；点击原“关闭物理世界”成功后，界面显示“物理世界已关闭”、引擎未启动，工作台正常退出 exit 0。测试引擎偏好在工作目录隔离，用户级偏好文件仍不存在。Newton Panda 数值发散仍未修复；其原 MJCF 含限力 position servo 和手指等式，而现有 Newton XPBD 路径未完整支持它们，不能通过改重力、删碰撞或伪造驱动冒充可用。不要将关闭状态修复称为 Panda 仿真修复。

R20a 刚完成安装时尚未重跑完整 CI；当时最近完整 CI 是源码 `9f714e52` 的 410 纳入文件、4511 项通过与 48 项跳过，另 64 文件排除。Unity Editor、Go2 许可、G19 照片真值、外部云及真实硬件按缺条件跳过，Isaac／CUDA 不在目标范围；尚未完成全功能逐项点击验收。证据见 R20核验。

## Linux 0.2.1 Newton 对照与当前完整回归

重新核验官方 Linux 0.2.1 归档：745242565 字节，SHA-256 `f554b3e9e275ec9cf15955ce92070e04865f07a054df37a98007d1104b511247`。从归档直接提取 `packages/sim-newton/python/worker.py`，SHA-256 `efe18b013dcc09491f49d9c3ca09f41974adb6391e6e795e1b1623cdcb92e0f4`，与 Git tag v0.2.1 的 worker 完全一致；requirements.txt 也相同。当前 HEAD 相对该 worker 仅增加 8 行故障 stop 收尾，Newton 编译、求解与控制路径未重写。

实际安装的 Newton 1.6 XPBD 文档明确不支持 joint armature、joint effort limit、equality／mimic；Panda 源包含这些特性。它们是需要核对的兼容差异，不能证明是发散的唯一原因，也不能推断 Linux 运行必然发散。当时本机 Docker 守护进程不可连接、没有发现本地 Linux VM；大写连接名 H800 不能被 SSH 解析。后续已通过小写别名完成 Linux CPU 对照，见下述新记录。保留原模型、物理插件与求解器，未改重力或约束。历史 MuJoCo Panda 界面及关节控制实测可作为临时使用路径，不替代 Newton 修复。对照记录见 R20核验/Linux原版Newton对照.json。

当前源码 `408535ed7a104faf542bf30e84165dfc13377151` 的完整 CI 已终态 exit 0：清单 476 文件，411 纳入并全部通过、0 失败／0 缺件；用例 4516 通过、48 跳过，另 65 文件按原清单排除未运行。使用隔离引擎偏好、HF 镜像和原 gymnasium Python；此回归不替代 Panda 真实物理及所有功能点击验收。原件见 R20核验/r20-完整回归.json 和 .log。

## R20a 机器人库真实点击与 UR10e（2026-10-28）

在 R20a 隔离 Guest、隔离工作区和独立 MuJoCo 偏好中，逐个点击原机器人库 11 个内置条目，每项真实界面均显示选中、对应名称及可用的“加入场景”按钮。这只覆盖列表及入口，不代表已逐个实际放置或执行动作；11 份界面记录在 `R20机器人点击`。

实际通过原界面放置 UR10e：Scene rev1／2 实体，MuJoCo 同步 ready。六关节动作的 shoulder_pan 目标为 -1.47 rad；原 `robot_move` 回执 completed、targetReached true、tolerance 0.03，回执实测 -1.4704278618716506 rad，界面稳定读回 -1.4700。原 `robot_freeze` 返回 frozen 且列出 6 个关节锁，`robot_restore` 返回 restored；部件树列 7 项，选中 shoulder_link、展开视图到 100% 后恢复 0%。原关闭世界和退出完成，进程 exit 0。原命令及界面记录在 `R20机器人点击`；不代表长期稳定或全部机器人动作通过。

实际场景初始化报告地面与 UR10e shoulder 碰撞体重叠 0.027 m。使用原随包 UR10e `scene.xml`、home keyframe 和原 MuJoCo 直接编译，得到相同 floor／shoulder_link 胶囊体 -0.027 m 接触距离。保留原模型和告警，不改碰撞或阈值；不将动作完成当作无碰撞证明。Newton Panda 已在 Linux 与 macOS 均复现发散，根因和修复仍未完成；尚未完成所有功能点击验收。

## Electron 后台输入的原驱动路径（2026-10-28）

项目使用的原 `@trycua/cua-driver` 0.28.0 工具目录明确指出 Electron/Web 内容可能出现 AX 值回显而页面未实际接收输入，并提供 `type_text` 的窗口截图像素坐标形式。仅补充项目原 `desktop-automation/SKILL.md`：先确认目标窗口和有效截图，用原驱动坐标输入后以新截图和页面实际结果核对；保留已有后台优先、拒绝不擅自切前台的规则。未替换驱动、未改权限或输入策略。源码提交 `8b534402`；隔离 R20a 安装包仍为前一源码，不含此说明。

原窗口作用域守卫的受控参数检查显示背景坐标输入放行、前台输入仍按 `CUA_FOREGROUND_DELIVERY_REFUSED` 拒绝；既有 computer-use 两文件 80 项通过。该检查与工具目录只能证明可用路径和守卫行为，**不能证明 Electron 真实窗口后台坐标输入已经成功**；原限制继续保留。最近完整 CI 仍针对 `408535ed`，新提交仅技能说明，未重跑完整 CI。

## R20a 机器人实际放置（2026-10-28）

R20a 原隔离 Guest 恢复前述 UR10e 场景，先通过原物理面板关闭 MuJoCo 世界，再逐项从原机器人库选择、打开真实预览、选择画布位置并确认放置 Go1、Allegro Hand、Crazyflie、通用四旋翼、LEAP Hand、Shadow Hand、A1、G1、Go2 和 Panda。每次真实界面均显示对应名称已加入，Scene 从 rev1 递增到 rev11。与此前 UR10e 一起，11 种随包型号均已真实放置；独立读取持久场景为 12 实体（11 机器人加地面），每种恰有一个，11 个原模型文件均存在。Go2 仅模型放置，不代表缺许可证的 Go2 策略可用。

这十次放置时物理世界保持关闭，多个模型可能重叠；不能把本场景拿来启动多机器人仿真，也不能据此声称这十个模型的物理、动作或策略已逐一通过。测试工作台已正常退出 exit 0。分型号界面记录、结果及持久场景核对在 `R20机器人放置`。初次 Allegro 预览尚在加载时的短等待被记录，后续实际就绪并放置成功，不属于模型故障。

## Crazyflie 原生飞行与界面状态（2026-10-28）

使用 Linux 0.2.1 原供给 Crazyflie `cf2.xml`（SHA-256 `c1260dd47cded49edd5c1c02226529a5452a73f70000515f83bf223814037933`）、R20a 安装版 MuJoCo Python、原 `flight-native.fixture.ts` 和现有 `runFlight`／Provider 执行真实模拟，进程 exit 0。源码 MuJoCo worker 与 R20a 安装版字节 SHA 一致。原测试的手动／实时两种时钟均通过悬停、航点、降落及停止；手动悬停最终高度约 0.35072 m，航点 x≈0.19571 m（目标 0.25 m，原误差判据通过），降落有 24 个接触；原停止状态 cancelled 并确认停止，重置到 generation 2。结果和逐阶段原回执在 `R20飞行验收/原生控制实测`，不代表 GUI 或真实无人机已验收。

为补界面验收，隔离 Guest `work/parity-real-install/guest-data-r20-flight`、工作区 `work/r20-flight-ui-workspace` 已创建独立物理场景，MuJoCo ready。当前应用 exec session 93700／Electron PID 93180／Host PID 93202／origin 127.0.0.1:60939 仍活；机器人面板在用户选择后长期显示 0 项、刷新禁用，随包 11 个资源目录已产生但界面尚未读回。尚不能确定是登记任务、服务或客户端投影的问题，原界面记录 `R20飞行验收/机器人库持续登记中.txt`。没有重启、重复启动登记或把它算作模型缺失；下一步先核对这同一个活实例是否已完成及服务状态。用户级引擎偏好未变。

## R24 Crazyflie 入口、状态和手工作业（2026-10-28）

上述 R20 活实例后经关闭／重新打开机器人面板显示 11 个模型，原因未确认，不称已修复；该实例已经正常退出。独立测试同发行供给及 materialized 布局的初始化约 7 秒返回 11 项；对原会话既有索引的只读投影约 2 秒返回 11 项。真实 GUI 继续发现随包 Crazyflie 放置后只有 0 关节的普通面板：资源登记丢失了原飞控所需 controller 映射。

源码 `9bd85ca9` 在原 pack 声明已有飞控的推力／力矩映射与固定源 SHA；原 ResourceLibrary 登记时仅对精确模型附加，旧资源只补缺失 controller，不覆盖用户已有映射或改变现有场景。新登记、旧资源补齐、错误 SHA 与自定义控制器负对照通过。R21 实际安装版验证旧资源补齐，重新放入新场景后出现原飞行面板；另通过 R21 包内资源、原 MuJoCo 和原飞控完成 500 次控制的真实悬停。旧场景中已经放入且无 controller 的实例没有被静默改写，需重新放置或显式配置。

R21 实际面板暴露第二个问题：每 0.5 秒状态查询作为用户命令写入会话，隔离测试中累计 1543 条。R22 将读取改为原工具，但实测又触发 558 条内部工具观察事件；这些历史均保留。R23 将读取改为原飞控插件在同一 owner 上提供的只读状态接口，继续验证会话、世界、代次及场景版本；真实 R23 面板轮询期间两类事件计数均未增加。实际 hover/goto/land/stop/reset 仍复用原命令和 Jobs。对应 UI DOM 与 registered HTTP 定向测试覆盖不写事件、跨会话／旧代次／旧场景版本拒绝及状态端点不执行 hover，最新四文件 12 项通过，类型检查通过。

R23 真实界面 8 秒 hover 返回 `FLIGHT_TARGET_NOT_REACHED`，任务失败通知导致游客会话新增一次 blocked 模型回合。对同一 Scene 的独立实时原引擎重放则完成、80 次控制、最终高度约 0.35118 m；暂无法解释差异，不能抹掉失败。源码 `b010e960` 让手工 `robot_flight` 命令复用现有录制功能的 Jobs 等待者接收完成通知；模型工具调用仍保留原通知。R24 实际 GUI 15 秒 hover 也返回 `FLIGHT_TARGET_NOT_REACHED`（150 次控制），保留为真实未解决问题；该任务完成后会话事件从 seq3755 到3768 中，新增状态命令 0、状态工具观察 0、飞控通知 0、模型 turn/start 0，说明本次状态和人工通知修复在安装版真实通过，但不代表 hover 成功。

R24 由原 packager／installer 在隔离前缀完成，current=R24、previous=R23，sourceCommit=`b010e960a5861f8f533597563927f2ffb385d7e9`、sourceCommitMatchesPayload=true，711944381 字节、SHA-256 `75854fc50c46171538f969407c3e815a11c86b41efa45d39e08de26ec01f5f04`，doctor AVAILABLE／MuJoCo 真实物理 PASS，ad-hoc 本机签名、未公证发布。R24 测试窗口正常退出 exit 0；日志及原结果在 `R24飞控`，发行包在 `发行R24`。最近完整 CI 仍是 `408535ed` 的 411 文件通过；后续变更仅做相应定向测试，未冒称 R24 完整 CI。Newton Panda 发散、Electron 原生后台输入和其他尚未覆盖项目继续保留。

## Crazyflie 悬停波动的有界对照（2026-10-28）

同一 R24 场景、0.35 m 目标和 15 秒界面悬停再次实际执行，状态 completed；前一次相同设置为 failed。界面每约 0.5 秒读回高度：后半段出现约 0.28–0.40 m 的变化，动作结束撤推力后落至地面；原始 32 个读数在 `R24飞控/r24-hover-ui-samples.json`。本次成功和前次失败均保留，不把一次成功作为稳定保证。成功的人工任务结束后，同一会话未新增模型回合或飞控完成通知；窗口已正常退出。

独立原实时 MuJoCo／原飞控、相同 Scene／目标／15 秒各跑一次：无额外读取为 completed；每 120 ms 额外读取真实帧的对照有 129 次读取、0 错误，结果 failed，末次控制高度约 0.2868 m。两组控制周期中位数均 52 物理步、均值约 51.85 步，后半高度均有波动。仅一次配对不能证明读取导致失败，也不能确定平台原因；未修改 PID、频率、模型、重力或成功阈值。原样本与统计在 `R24飞控/悬停受控对照.json` 及相邻原结果中，悬停稳定性仍未解决。

## R24 当前源码完整回归与 Newton 安装（2026-10-28）

当前源码 `b010e960a5861f8f533597563927f2ffb385d7e9` 原完整 CI 已终态 exit 0：477 文件清单中 412 个纳入且全部通过，0 失败、0 缺件；用例 4518 通过、48 条件跳过，另 65 文件按原清单排除未运行。使用原 gymnasium Python、隔离引擎偏好和 HF 镜像。之前 R24 段落中的“未重跑完整 CI”是当时状态，以本段为准；完整 CI 不代替真实设备、所有 UI 以及下述具体故障验收。原件在 `R24飞控/r24-完整回归.json` 和 `.log`。

R24 隔离安装此前没有 Newton 环境，本轮运行其原 `install-provider newton` 完成，Newton 1.6.0、Warp 1.17.0、MuJoCo 3.12.0。使用 R24 包内 Newton／MuJoCo Python，原 CPU 相机及无限地面专项 9 项通过、0 失败；测试所用 Newton worker 和两份 world_physics 文件与安装版逐字节一致。用户级偏好仍未修改。该结果不覆盖 Panda 发散；发行归档本身仍按原流程在目标端准备 Newton，而非已预装此隔离运行环境。

读取原 Linux 0.2.1 与 R24 的发行元数据：两者均列出 38 个 `@lyapunov` 包、319 个 DSH 包，名称集合一致，DSH 版本一致；唯一相应包版本差异是 `@lyapunov/desktop` 从 Linux 元数据的 `0.1.0-rc` 更新为 Mac 产品版本 `0.2.1`。两者固定上游提交相同。仅证明发行清单包名与版本，不证明运行时全部插件已启用或可用；原对照在 `R24飞控/Linux与Mac包清单对照.json`。

## R25 无增益力矩电机与 Go2 被动物理（2026-10-28）

使用 11 个真实 UI 放置资源各自建立独立 MuJoCo 实时世界，R24 有 10 项完成装配和步进，Go2 返回 unavailable。直接读取同一原 worker 的 `world-error` 得到具体原因：纯力矩电机未声明位置 PD 增益，但初始化无条件创建保持目标，第一步即调用 `set_joint` 并拒绝。此问题与 Go2 策略许可证缺失不同，不能把模型不可用归为许可证跳过。原 matrix、原 worker 错误和 R24 真实负对照在 `R25机器人物理`。

源码 `2eeb2efa56a4a23ba973dec56c3a90b29509d453` 只调整原 MuJoCo worker 的保持目标初始化和停止清理：关节有明确 kp 与 kd 才建立位置保持；缺失时不创建／清除保持目标，保留源电机的被动物理，不填入推测增益。位置动作仍按原 `TORQUE_ACTUATOR_POSITION_GAINS_REQUIRED` 拒绝，显式增益时原有控制保持不变。新增真实实时无增益／拒绝位置命令／停止后继续推进的负对照在 R24 失败，在修复源码上通过；原 MuJoCo action-window 全套 16 项通过、0 跳过，根类型检查通过。

候选 worker 重新核对上述 11 型号，均能装配、读取实体且世界步进；Go2 单独运行约 3 秒从第 1 步到第 1504 步，状态有限。通用四旋翼为原固定根、0 关节且需外部飞控；Go2 未安装缺许可策略，不将被动物理当作行走验证。UR10e、Allegro 和 Panda 有原初始碰撞告警，保持原告警，不称无碰撞。

R25 原 packager／installer 在隔离前缀完成，current=R25、previous=R24，sourceCommitMatchesPayload=true，711940446 字节，SHA-256 `c053d81795b90458cd4afadb836d86f94afd93d8fe020f91ad11fdb3ed4b26f1`；doctor AVAILABLE／MuJoCo 真实物理 PASS，本机 ad-hoc 签名，未公证发布。R25 实际 Guest 界面新建单 Go2 场景，原安全逻辑先暂停；点击继续后界面显示物理运行中，步数由 18447 增至 28439，再通过原操作关闭世界并正常退出 exit 0。原 Newton 安装器也在 R25 独立前缀完成，import 自报 Newton 1.6.0／Warp 1.17.0；R25 Newton 物理专项未重新跑，最近 R24 相机／无限地面为 9 项通过。证据在 `R25机器人物理`，归档在 `发行R25`。最近完整 CI 是 R24 的 412 文件通过；R25 只做对应真实 worker 专项和类型检查。

另一个实际诊断缺口：MuJoCo `world-error` 的原 worker 事件带具体异常，当前 Provider／界面只显示 WORLD_UNAVAILABLE，未携带原因；Go2 修复不代表该诊断缺口已修。Crazyflie 悬停波动、Newton Panda、Electron 后台输入以及尚未覆盖功能仍按各自证据保留。

## R26 MuJoCo 故障原因传递（2026-10-28）

源码 `7ac85d38` 复用 MuJoCo 原 World 状态保存 tick 异常，`handle.statusReason` 与 `WORLD_UNAVAILABLE` 带出原原因；成功重建才清除，失败重建保留原故障。沿用既有工作台生命周期状态投影，没有新增状态 owner、改求解器或伪造物理结果。R25 原 worker 的受控异常负对照未携带原因；R26 真实 MuJoCo worker／Provider 受控 tick 故障、失败重建、成功恢复及旧原因清除测试通过。R26 安装版 worker 同测试 1 项通过、0 跳过；原 MuJoCo 动作窗口与故障测试 17 项通过、0 跳过；工作台现有故障 DOM／生命周期测试 37 项通过，根类型检查通过。这些分别证明 Provider 和界面投影，**没有在安装版 GUI 中注入 MuJoCo 故障**，不能称 GUI 端到端故障已实测。日志在 `R26故障诊断`。

R26 原 packager／installer 在隔离前缀完成，current=R26、previous=R25，sourceCommitMatchesPayload=true，711938583 字节、SHA-256 `15126d5ebffb890d160c5db6820d3c2979a3437bd258d649bd733e26191e2a80`，doctor AVAILABLE／MuJoCo 真实物理 PASS；本机 ad-hoc 签名、未公证发布。原 Newton 安装器在 R26 独立前缀完成，import 读数 Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0；R26 Newton 物理专项未重跑。最近完整 CI 仍是 R24；R25/R26 为上述定向测试。Newton Panda 发散、Crazyflie 悬停波动、Electron 后台输入与其余未覆盖功能仍未完成。

## R26 安装版受控故障界面验证（2026-10-28）

使用独立 Guest、独立偏好和工作区，以测试专用 Python 启动包装器调用 R26 安装版原 MuJoCo worker，并只对首次 tick 注入一次明确的测试异常。真实界面创建物理场景后显示 `WORLD_INITIALIZATION_FAILED`，具体原因包含 `RuntimeError: 故障夹具：原生步进失败`；点击原“重新启动物理世界”后显示 MuJoCo 运行中，实际步数从 13317 增至 20216。随后通过原物理面板关闭世界并正常退出，进程 exit 0；用户级引擎偏好未变。界面原件为 `R26故障诊断/安装版界面受控故障.txt` 和 `安装版界面恢复运行.txt`。

这是明确标注的受控异常注入，用于验证安装版界面与真实 worker 的状态和恢复接线，不是自然发生故障的复现，也不证明所有故障都能恢复。上节“没有在安装版 GUI 中注入”的表述是当时状态，以本节为准；Newton Panda 发散、Crazyflie 悬停波动及其他未覆盖项不受此验证影响。

## Linux／macOS 同源 Newton CPU 实测（2026-10-27）

经小写 SSH 别名 `h800` 连接 Linux x86_64，在隔离内存临时目录安装固定 Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0／mujoco-warp 3.12.0；未使用 CUDA 或修改 Linux 既有环境。Mac 使用 R20a 包内相同四个引擎版本。对照采用 Linux 0.2.1 发行原 worker、原共享物理合同、相同场景及 68 个原 Panda 文件；两端文件内容摘要一致，测试脚本和场景模板哈希也一致，仅运行时把测试临时源路径前缀替换为各自主机路径。重力 -9.81、dt 0.002、XPBD、CPU 均一致。

Linux 在第 204 步、macOS 在第 216 步均出现 Newton 非有限刚体状态。两端前 150 步的采样最大位置和速度非常接近，后续数值发散步数不同。Linux 使用 Python 3.10.12／NumPy 2.2.6／SciPy 1.15.3；Mac 使用 Python 3.12.16／NumPy 2.5.4／SciPy 1.18.1，因此不是完全相同软件环境，也不能将细小数值差异归因于操作系统。Linux 系统盘已满；在隔离内存目录准备 Python 3.12 进展缓慢，主动终止且日志保留，未称同 Python 验证通过。实际对照说明该已知故障不只出现在 macOS；仍不能证明支持缺口是唯一根因，也没有修复 Panda。原用户约束不允许仅为消除差异而改写业务物理算法。证据见 R20核验/linux-newton-parity-linux310.json、linux-newton-parity-mac312.json 及相应日志。

## R26 隔离 Electron 后台输入与点击（2026-10-28）

使用 R26 安装版随包 `@trycua/cua-driver` 0.28.0，由已有授权的 Node 宿主直接调用其原 SDK，在单独的 Electron 测试窗口验证截图像素坐标路径；并非通过 Lyapunov 模型或工具注册链调用。第一次 `open -g` 启动未产生窗口，终止本次测试进程后直接启动夹具，窗口启动时曾短暂成为前台；随后恢复 ChatGPT 前台，在确认前台 PID 后进行后台操作，结束后前台仍为 ChatGPT。辅助功能和屏幕录制权限均已存在，未申请或修改权限。

原驱动 `type_text` 后台坐标输入 `PX_BG_OK` 返回 `effect=unverifiable`；随后截图及页面原 `oninput` 回显均显示 `PX_BG_OK`。接着原驱动后台坐标点击按钮，同样返回 `effect=unverifiable`；页面点击处理器将计数从 0 改为 1，截图及 AX 均显示 1。两项是在独立夹具内通过实际页面状态核验，不能概括为任意 Electron 应用均可靠，也不能算安装版 Lyapunov 插件／模型端到端验证。截图和说明在 `outputs/本轮复用验收-0.2.1/R26后台输入`。因此此前“尚未验证 Electron 后台坐标路径”已有本次有限范围的正面证据；原 Electron AX 写入可能只回显的限制及禁止前台重试的原规则仍保留。

后续在隔离宿主装配 R26 安装版原 shell 构建产物、原 CUA native 插件及原 Cordis／Tools 调度器，使用会话、场景和桌面设置快照替身，通过工具注册与现有作用域守卫执行后台输入 `PLUGIN_BG_OK` 及点击；独立 Electron 页面事件回显该文本、计数从 0 到 1，原始截图也核实。驱动操作回执均为 `effect=unverifiable`；操作前后前台均为 ChatGPT，测试夹具启动时曾短暂成为前台。替身会话缺 `requestHeader`，截图投影给替身明确不可用，底层截图有原始数据；未使用真实模型，因此不能宣称真实模型端到端通过。原工具回执 `插件调用-1.json` 至 `插件调用-6.json` 与截图在 `R26后台输入`；宿主原 dispose 正常返回并退出，夹具已关闭。没有修改产品代码、用户桌面设置或申请权限。

当前源码 `7ac85d38cb0addf3f139f93527a2f57a48ed6cf7` 的原完整 CI 已结束，使用原 gymnasium Python、隔离引擎偏好和 HF 镜像；运行句柄 92207 终态 exit 0。478 个清单文件中 412 个纳入并全部通过，0 失败、0 缺件；纳入文件中 4518 个用例通过、48 个跳过，另 66 个文件按原清单排除未运行。报告与日志在 `outputs/本轮复用验收-0.2.1/R26完整回归.json` 和 `.log`。这是当前源码的自动回归，不替代所有功能点击、外部条件或真实设备的核验。

## R26 机器人库界面复核（2026-10-28）

对 R20 曾一次长时间显示空库的现场复核：原 Scene 初始化器按会话复用在途登记任务，工作台通过原 `robot-library` POST 等待结果；旧现场缺该次请求终态，不能判断根因。新建隔离 R26 游客数据与工作区，实际打开机器人库，显示 11 个随包模型均已登记；点击刷新后按钮短暂禁用，约 10.4 秒后的观察显示恢复可用且仍有 11 项，该时间只是观察上界，不是准确请求时长。实际点击 Unitree G1 和详情，显示 MJCF／35 DOF／已登记；未创建场景时“加入场景”按原规则禁用。用户工作台未修改，测试实例经原确认退出，进程 exit 0。截图、无障碍树及说明见 `outputs/本轮复用验收-0.2.1/R26机器人库`。本次未复现旧故障，不能宣称根因已明或问题已修复；没有据此猜测性改写。

## R26 Crazyflie 飞控工具链夹具修复（2026-10-28）

原 `flight-tools.fixture.ts` 引用不存在的 `materials/library.json`，实际运行失败 ENOENT。源码提交 `d0b38a0c` 仅更新该已有测试夹具：通过原 Scene `initializeDefaults` 与 ResourceLibrary 使用 R26 随包模型及原控制器映射，核对 Crazyflie 模型 SHA，显式使用 blank 场景；没有改写产品飞控、资源注册或行为。使用 R26 已构建 robot-workflows 插件、R26 MuJoCo Python、当前源码 Provider／worker 执行，worker 与 R26 包内 SHA 相同（`2091332b5087ae8fd46123dffb0619cdf3d180755ab120a3c51e40dfdd76772b`）。真实同会话工具和人工命令／Jobs 各悬停 50 次控制并返回完成；状态读取成功、跨会话请求和重置后旧代次拒绝，根 tsc exit 0。原始失败、结果和限制在 `R26飞控工具链`。

此验证为手动时钟和当前位置目标，不是 GUI、真实无人机、真实模型自主调用或实时悬停稳定性的证明。最近完整 CI 是 `7ac85d38`，当前 HEAD 相差此一个原清单排除且需独立依赖的夹具；该夹具已单独运行，不能称 d0b38 的完整 CI 已重跑，亦不因测试变更重复构建 R26。

## OBJ／FBX 几何转换与工作区闭环（2026-10-28）

本机 Blender 5.2.3、R26 MuJoCo 3.13 Python 和当前源码原 Scene／Workspace 插件，独立运行原完整 CI 排除的 `geometry-import.fixture.ts` 与 `geometry-workspace.fixture.ts`，两者终态 exit 0。隔离自制 OBJ／纹理、FBX／纹理／骨骼／动画；移动夹具原目录后复用已登记副本，OBJ 与 FBX 输出 GLB 均保留纹理及 UV，FBX 保留 1 skin／1 animation，热缓存命中。OBJ 静态物理化成功、真实 MuJoCo 世界 ready 且读到 1 个碰撞几何体。原 Tool／Command、Workspace HTTP 另验证资源原件不变、纹理变化后版本递增及旧副本不变、物理化 false 与 environment 意图保留、会话隔离／只读拒绝和保存重开。

首版自制 FBX 因生成参数未导出动画而令原夹具失败；独立 Blender 重读确认源无 action，修正素材生成参数后重读有 action 且第 1／10 帧骨骼姿态不同，原夹具通过。失败及修正素材证据均保留，不能误称首版是产品故障。测试是源码插件＋真实依赖，非 R26 GUI／任意用户模型的覆盖；未改产品代码。输出在 `R26几何转换`。

## OBJ／FBX 查看器实际渲染（2026-10-28）

Edge 真实 WebGL 和源码原 `createViewer` 读取上述自制 OBJ／FBX 转换 GLB。复制原 `material-render.fixture.ts` 到工作区，限定两份已有样本并增加同一状态下关闭贴图的像素对照；未改产品查看器。两者均有可见几何、贴图、24 UV 顶点、2×2 图像，glError 0 且无查看器错误；FBX 识别 1 skin／1 animation，骨骼无脱离。关闭贴图后按 RGB 总差 >12 统计，OBJ 86986 像素、FBX 77606 像素变化；两份 GLB 的嵌入 PNG 与源图片字节 SHA 同为 `f260a4290f22c16da525b8e37352fd228e0340fa639fb629446fd3b8b5ec96a3`。FBX 红绿黄阈值计数均为 0，截图观感偏淡；只能证明贴图影响渲染，不能断言色彩精确或动画实际播放。浏览器标签和临时回环服务已关闭；结果、画布截图与夹具见 `R26查看器渲染`。不冒称安装版 GUI 或全部模型通过。

后续在同一隔离浏览器夹具增加原查看器播放／暂停接口验证：播放期间两次骨骼四元数最大分量变化约 0.07555，暂停后的读数与暂停前一致；这证明该样本的原接口生效，不代表物理同步或安装版界面按钮。重跑的同状态贴图对照 OBJ 86986／FBX 72720 像素变化，已覆盖同目录旧结果，以最新 JSON 为准；两次结果差异可能受动画时刻影响。浏览器标签及本次服务已关闭。

## 动画网格纯视觉导入候选（2026-10-28）

R26 隔离安装版实际通过文件选择器导入自制带动画 FBX、选择转换后的 GLB、框选预览并放置，Scene rev 1 后自动对账至 rev 2；原物理后台对默认动态碰撞报 `UNSUPPORTED_ANIMATED_COLLISION`，界面如实显示 `SCENE_PHYSICS_NOT_READY`。实际展开导入设置，只有 environment／static／dynamic，没有纯视觉选项。该限制与 Linux 0.2.1 同源，不是已证明的 macOS 特有问题；作为用户要求修复所有问题的一项，源码提交 `513931db` 只在原用途选择器加入显式“仅视觉：不生成碰撞”，复用现有 `physicalize:false` 资源/转换契约；不改变默认用途、物理算法或旧实例。两文件 31 项通过、根类型检查通过；真实旧版阻断截图和无障碍状态在 `R26动画导入`。

R27 原打包器进程 37998 exit 0，归档 711941356 字节、SHA-256 `9a6926981de1d3b7a48380aa2b213828cd47de16e2d3dcc23dc3f16448c0aab6`、sourceCommitMatchesPayload=true；原安装器 exit 0，current=R27／previous=R26，doctor 与真实 MuJoCo physics PASS。仅本机 ad-hoc 签名，未公证或发布；归档见 `outputs/本轮复用验收-0.2.1/发行R27`。

R27 独立 Guest 实际选择新选项，通过文件选择器导入同一 FBX、选择派生 GLB 并放置；资源账本中源与派生资源 `physicalizationRequest:false`，GLB physicalization 为 skipped，场景实例仅 visual 组件。点击原“启动物理”后 MuJoCo 运行，界面读取 6842→13262→40920 步，明确提示“纯视觉实体不参与碰撞”；再通过原面板关闭世界并正常退出，进程 exit 0。旧版阻断、新版世界截图和资源只读核对在 `R26动画导入`。此项不提供蒙皮碰撞，也不影响默认动态碰撞的原拒绝。R27 原 Newton 安装器进程 41246 已 exit 0，独立环境实测 import Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0；R27 的 Newton 实际物理专项尚未重跑，已知 Panda 发散仍保留。最近完整 CI 仍是 R26；R27 已执行该变更的 31 项和类型检查。

## 纯视觉资源在环境库的关联修复（2026-10-28）

R27 新增纯视觉用途后，实际打开同一隔离会话的环境库，仅有 FBX 源文件、没有已转换的 GLB；点击源文件放置，预览不可用，确认得到 `PROTOTYPE_BOUNDS_UNAVAILABLE`／P422。已有回执 `R28视觉资源归属/R27源文件放置失败.txt`、`.png`。原测试增加可视网格归属断言先失败，修后只让 `physicalizationRequest:false` 的 mesh 在环境／场景及物件域共享展示同一资源；对 OBJ／FBX／Blend 源文件禁用直接放置并提示选择派生 GLB，保留原生 USD 路径，不复制资源、不新建 owner。源码提交 `3cc28842`，33 项导入／列表测试及根类型检查通过。

R28 原打包器进程 19732 exit 0，归档 711949187 字节、SHA-256 `98261ab062d3c2b1a672c1aed17dca8eacc913348ba7f9783a450c23d37844f0`、sourceCommitMatchesPayload=true；本机 ad-hoc 签名，未公证发布。原安装器进程 80321 exit 0，current=R28／previous=R27，doctor 和原 MuJoCo 物理检查通过。原 Newton 安装器 49445 exit 0，独立环境导入 Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0，R28 Newton 物理专项未重跑。

R28 实际恢复同一隔离 Guest 测试会话，环境列表显示 FBX 和 GLB 两行，FBX 加入按钮禁用并提示原因，GLB 可选并通过真实预览和原放置按钮加入场景，场景 rev 2→3，MuJoCo 原同步回执 ready。资源账本仍仅一个 FBX、一个 GLB，两个场景实例均引用同一 GLB 且只有 visual 组件；测试世界正常关闭，进程 exit 0。原生 USD 非禁用路径由组件测试覆盖，未在 GUI 实测。详见 `R28视觉资源归属`。

当前源码 R28 完整 CI 进程 86723 已结束 exit 1：478 文件清单，412 纳入并运行，411 通过、1 失败、0 缺件，66 排除；4520 用例通过、1 失败、48 跳过。失败文件是 Isaac 本地发现测试，报告仅保留输出末尾，具体失败断言被截断，原因未知；随后使用同一 Python／隔离偏好单独复核 9 项通过，但不能将两次拼为完整 CI 全通过。Isaac 属任务排除范围，原失败保留。完整 JSON／日志及单项日志在 outputs，当前目标仍 active。

## R28 Newton 相机与无限地面实测（2026-10-28）

R28 已安装 Newton 1.6.0／Warp 1.17.0 和 MuJoCo 3.13.0，明确 CPU、独立偏好与 HF 镜像，使用现有 `camera.test.ts` 和 `infinite-ground-runtime.test.ts` 完成真实运行：2 文件 9 通过、0 失败／0 跳过。Newton 与 MuJoCo 在远域落球 1000 步分别读到 658／591 个地面接触采样；隐藏地面仍碰撞、删除及重开不碰撞、原生地面无重复。Newton 真实相机 RGB／深度、绑定、内参、粒子及 Provider/RPC 测试通过。测试涉及的 Newton worker、camera、world_physics、sim-contract world_physics 和 MuJoCo worker 均与 R28 安装载荷逐字节 SHA 一致。证据在 `R28-Newton验收`。不覆盖 Panda 发散或所有 GUI，R28 完整 CI 的 Isaac 失败仍保留，不能被本专项覆盖。

## R28 动画界面开关核验（2026-10-28）

隔离 R28 Guest 重新打开既有自制动画 GLB 场景，在原相机／视图设置中实际点击“烘焙动画”复选框，状态由 1→0→1；暂停和恢复时的界面原始截图、无障碍树在 `R28动画界面`。此前 `R26查看器渲染` 单独验证相同素材的原 Viewer 接口播放／暂停时骨骼姿态变化／保持。本次界面测试只证明控件入口与状态切换，未在安装版 GUI 逐帧测量骨骼，也不证明物理同步。原面板关闭测试世界，实例 exit 0；未修改产品代码。

重读 Linux 0.2.1 原发行和 R28 安装版 `RELEASE.json`：两者上游提交一致，`@lyapunov` 均 38 个包名、DSH 均 319 个包名，集合均相同；版本唯一差异为 desktop 元数据由 Linux `0.1.0-rc` 到 Mac `0.2.1`。结果 `R28动画界面/R28与Linux发行包名版本对照.json` 仅证明元数据，不代表全部插件启用或功能通过。

## R28 随包策略 CPU 实测（2026-10-28）

在独立测试会话使用 R28 安装版原构建 `policy-registry` 插件、原 Tools／Jobs、R28 策略 Python 和 MuJoCo Python；Go1／G1 分别完成 4 秒模拟时长，各执行 200 次控制及推理、分别推进 800／2000 物理步，原 Jobs 为 completed。Go2 原供给明确 `DEFAULT_POLICY_LICENSE_MISSING`，未绕过。另运行已有源码 `native-cpu-execution.test.ts`，使用同一 R28 供给及解释器，验证 G1 运行中停止、取消及同世界重启，1 通过、0 跳过；该专项为源码插件，不应与前述 R28 已构建插件混称。原始日志及执行回执见 `R28策略CPU`；不证明 GUI、长期步态、任务成功或真实硬件。未修改产品代码。

## 策略文件缺失时的界面恢复入口（进行中）

R28 隔离 Guest 的 Go1 策略实际检查列出 `POLICY_ADAPTER_SOURCE_MISMATCH`、文件缺失与未验证，首屏主按钮却误报“当前实例不兼容”并禁用；原 GUI 截图和无障碍树在 `R28策略界面`。源码提交 `a8e63b6b` 只修正原面板对该错误码的投影并引导到原选择／登记命令，真正模型不兼容、来源身份不匹配和原应用守卫仍保留。负对照在 R28 失败，修改后相关 32 项定向测试通过（包括 DOM 点击及命令夹具），根类型检查通过。实际安装版点击尚待核验，不声称策略文件已登记或执行。R29 原打包器正在运行，日志 `work/r29-原流程构建.log`，进程会话 43131；本次仅准备一次必要的最终安装验证，不循环打包。R28 的 Isaac 失败和 Panda、Crazyflie 限制不因本修改消失。

R29 原打包和隔离安装均 exit 0；归档 711944906 字节，SHA-256 `7cdbecfd84b3a6baf2045c75ec4a32d6eedd7f5d3abd1ff302c367f19ff02d78`，sourceCommitMatchesPayload=true，安装器 doctor 与真实 MuJoCo 物理 PASS，current=R29、previous=R28，本机 ad-hoc 签名、未公证。隔离 Guest 恢复同一 Go1 实例，选择原 Go1 来源并执行兼容检查，8 项缺失时首屏显示可点击“导入策略文件”，点击确实打开 macOS 原文件选择器；没有选择或登记文件，不算策略可执行。取消选择后，界面详情错误显示“系统文件选择器没有响应”，首屏显示操作未确认成功；这是额外已知提示缺陷，尚未修复。原界面截图与无障碍树保存在 `R28策略界面`，测试世界由原操作关闭，Guest 进程 exit 0，回环服务已退出。当前仍不宣称所有功能点击通过或问题全部修复。

## 策略选择器取消及迟到结果修复（2026-10-28）

源码提交 `2e85bf7edf698600c9102ddaf29f7b5c02fab0b9` 复用现有选择器与本地登记流程：主动取消不误报无响应且保留兼容状态；12 秒尚未返回时提供路径入口，但选择器之后返回仍可登记，切实例或其他请求使旧结果作废。保留实际文件和来源预检，不因选到权重就标记可执行。取消负对照在 R29 失败；策略面板／本地导入 35 项通过、根类型检查通过。

为避免重复完整打包，使用 R29 的隔离克隆，仅把原 `script/build-plugins.ts lyapunov-shell` 从当前源码构建的客户端替换到副本；副本客户端与源码构建 SHA-256 均为 `88668caaf8ed4b5d067f47b9a92b6fd388d38807853b4d281a5b03c8aac97696`，这是测试候选，不是 R29 发行归档。该候选恢复同一隔离 Go1 场景，实际检查后点导入／取消，原检查保留且无误报；第二次打开系统选择器，计时等待 13020 ms 后选择随包 `adaptation_module_latest.jit`，原“加载本地策略”命令执行，界面显示该文件及尚缺适配器／实例准备。单文件不代表完整依赖或可执行；另在 DOM 夹具验证切实例后迟到结果不可登记。测试世界按原面板关闭，隔离应用 exit 0。截图和无障碍树为 `outputs/本轮复用验收-0.2.1/策略选择器修复`。R29 安装版与归档仍不包含 `2e85bf7e`，后续一次正式打包时再纳入；R28 完整 CI 的失败与 Panda、Crazyflie 两项未解问题不变。

## Crazyflie 控制间隙对照与实测力投影（2026-10-28）

已有 R24 成功／失败记录中，异常下跌前采样间隔从常见 51–52 步变为 65／69 步，原推力窗 50 步。当前源码原 runFlight 与 R29 的源码 SHA 相同，MuJoCo worker 也相同。隔离真实实时世界做一组原控制器对照：相同持久场景各运行 15 秒，第二组只在第 100 个 thrust 完成回执后人为等 80.13 ms。两组都 completed；该处采样间隔分别 53／91 步，其后约 30 次采样高度范围分别 0.319–0.371／0.165–0.430 m。原 worker 完成推力窗口时 neutralize，与该受控现象一致；一次配对不证明自然失败的唯一原因，不称悬停稳定已修复。完整结果见 `飞控间隙对照`。

核原动作回执发现测得的执行器力位于 `effect.motions` 对应实体成员，而原 runFlight 误取顶层导致样本缺值。源码提交 `72816e3b6a0574dbaf6e40eec126f605ca17c383` 只投影该实体 thrust 的原测量力与同源 measuredAtStep，不变控制器和守卫。原回执首窗 `body_thrust=0.26487`、步 10：修复前样本为空，修复后与回执一致；真实 MuJoCo 50 控制通过。原生飞控完整专项（手动＋实时悬停、航点、落地、停止、重置）exit 0，4 项单测和根类型检查通过。专项只证明这次运行，先前 GUI 悬停失败、Newton Panda 发散不因此消失。R29 包尚不含此提交，也尚不含 `2e85bf7e`；未重复打包。

## R30 合并已验证源码修复（进行中，2026-10-28）

为将选择器及飞控实测力两项源码修复纳入同一个候选，R30 原打包器已 exit 0：源码 `72816e3b6a0574dbaf6e40eec126f605ca17c383`，归档 711945748 字节，SHA-256 `6e710ad9b6eb3d2c810a1e33b08dd36193357d69ecae39dfe87cf99d41dafa62`，sourceCommitMatchesPayload=true，本机 ad-hoc 签名、未公证。隔离原安装器会话 77262 正在运行，日志为 `work/r30-原流程安装.log`，当前不得预先称安装通过。回环服务会话 33703；候选归档与清单已复制到 `outputs/本轮复用验收-0.2.1/发行R30`。Panda 发散和 Crazyflie 悬停稳定性仍未解决，最近完整 CI 仍是 R28 的 Isaac 文件失败。

R30 原安装器会话 77262 已 exit 0：current=R30、previous=R29，doctor 与真实 MuJoCo 物理 PASS。R30 隔离 Guest 实际进入 Go1 的策略面板，打开文件选择器后取消，主入口可用且未显示无响应；原世界关闭、应用会话 27619 exit 0。R30 安装客户端 SHA `88668caaf8ed4b5d067f47b9a92b6fd388d38807853b4d281a5b03c8aac97696` 与前一轮超过 12 秒实际选择成功的隔离源码构建一致；当前 R30 未重复长等待选择。使用 R30 构建 robot-workflows 插件与 R30 MuJoCo Python，经原工具／命令／Jobs 在手动世界各执行 50 次控制，跨会话与旧代次拒绝，夹具会话 75508 exit 0；不代表实时悬停稳定。原 Newton 安装器会话 39328 exit 0，独立导入 Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0；使用 R30 Newton 与 MuJoCo Python 跑原相机／无限地面专项 9 通过、0 跳过，会话 78870 exit 0，相关源码与 R30 载荷哈希一致。R30 为本机未公证候选，目标仍 active；Panda 发散、Crazyflie 悬停波动及 R28 完整 CI 的 Isaac 失败均保留。证据与归档在 `发行R30`。

## R30 文件／终端／Git 隔离界面核验（2026-10-28）

新增独立 Guest 与测试 Git 仓库，R30 原文件界面打开中文文件、编辑、点击保存；独立磁盘读回内容一致。原终端显示 Git 修改与差异，粘贴包含中文文件名的暂存命令，并在测试仓库提交 `691c6ac`；独立 Git 确认提交。界面留未保存草稿后外部追加，原保存拒绝 file changed since it was read，草稿仍在界面、磁盘仍为外部内容；通过原确认框重新读取后显示外部版本，中文查找／下一处实际选中目标文本。首次 CUA typeText 输入中文命令参数时中文字符未进入终端，随后 CUA paste 中文路径成功；未验证人工输入法，不猜产品或自动化根因。测试应用会话 25760 exit 0；未测试远端 Git、合并冲突或所有终端能力。截图与说明在 `outputs/本轮复用验收-0.2.1/R30文件终端`。未改产品代码，R30 和未解物理问题状态不变。

## Newton Panda 质量／惯性与逐步状态（2026-10-28）

沿用 Linux 0.2.1 原 Panda 与既有同源场景、当前原 Newton worker 与 R30 Newton 1.6.0／Warp 1.17.0／MuJoCo 3.12.0，CPU／XPBD／原重力／dt 0.002，分别读取 Newton 和 MuJoCo 编译模型。11 个同名刚体最大质量绝对差 8.35e-8 kg，惯性特征值最大绝对差 3.38e-8 kg·m²；此对照不覆盖惯性坐标方向或其他动力学字段。Newton 原六分量 body_qd 第1步最大分量为 link3 约23.97，第200步为 link6 约410.07，第216步仍报非有限状态；这是逐帧事实，不将六分量统一视为线速度，也不证明根因。已有 home 反事实仍发散，因此未为掩盖失败改变初始值、重力、求解器或模型。脚本、日志和结果在 `outputs/本轮复用验收-0.2.1/NewtonPanda诊断`。本次未改产品代码，Panda 仍未修复，任务 active。

## Newton 原版初始关节状态对照（2026-10-28）

独立单 hinge MJCF 含 home=0.4、second=-0.3、显式 initialJointPositions=0.6。在同一 Mac 实机使用 R30 对应源码原 MuJoCo／Newton worker：MuJoCo 初始、关键帧同步、显式值同步与强制重建依次读回 0.4／-0.3／0.6／0.6，代次1／2／3／4；Newton 均为0，普通同步代次仍1、强制重建代次2。Newton physics_signature 只包含 sourcePath/xml，未消费 keyframe/initialJointPositions；强制重建亦不处理初值。再用 Linux 0.2.1 发行包原 Newton worker（SHA `efe18b013dcc09491f49d9c3ca09f41974adb6391e6e795e1b1623cdcb92e0f4`）在同一 Mac 环境实跑，结果与当前 Newton 相同；这是原版源码在 Mac 的运行，不称 Linux 主机已重跑本专项。证据在 `outputs/本轮复用验收-0.2.1/Newton初始状态`。此为确认的原版 Newton 初始状态缺口，不是已证明 macOS 回归；Panda 设置 home 后仍发散，不能归为唯一根因。按用户复用约束本轮未另写初始化器或改生产代码；仍待在原插件链中确定可复用的正确支持方案，目标 active。

## Newton 初始状态及纹理依赖源码修复（2026-10-28）

源码提交 `a837dea2d61a73ff998fe721fedaa4136d592f07`：在原 Newton worker 复用固定 MuJoCo MjSpec／源 home、指定 keyframe 和 initialJointPositions，再使用 Newton 原 eval_fk 同步两份状态；keyframe、initialJointPositions、initialActuatorControls 纳入原 physics_signature。源关键帧 ctrl／显式控制值仅映射到原 source_drives 已确认的单位 gear 位置执行器，避免关节初值修正后被零目标拉回；不更换物理算法、状态 owner 或放宽守卫。解析显式初值失败阻断，默认路径失败保留 Newton 原值并带 INITIAL_STATE_UNAVAILABLE 警告。Panda 仍第242步非有限，不能称物理稳定已修复。

真实 R30 Newton 环境初始缺 PIL，A1／Go2 导入均 ModuleNotFoundError，trimesh 异常使 `.name=None`，旧 doctor 却 AVAILABLE；原始异常及前后对照在 `Newton初始状态`。仅向隔离 R30 Newton Python 使用官方 PyPI 加装 Pillow 11.3.0 后，原 worker／候选各11模型均能装配，候选 A1／Go2 各真实推进10步。源码 requirements 加固定 Pillow 11.3.0，原 installer 仍消费该清单；错误消息回传实际异常，源码 doctor 核 Pillow：未补依赖的 R28 环境从原 AVAILABLE 改为 BLOCKED，隔离补齐后的 R30 环境 AVAILABLE 并显示版本。已修改的是隔离 R30 环境，原 R30 归档并无修复，不能冒称默认安装已通过。

最终源码原 Newton能力／接触28项、相机／地面9项、初始状态与纹理模型两个真实测试文件、生命周期和真实故障各1项、原安装器依赖接线1项以及根类型检查通过；初值夹具中 5 个 unittest 覆盖关键帧、同步、显式控制、多实体／自由根、非法值和缺依赖消息。先前新夹具第一次使用 manual world 直接 tick 导致0步断言失败，已按原时钟语义改成 realtime 后通过，失败日志保留。11 模型只签装配，除 A1／Go2 十步外不签动态；未做本源码完整 CI 或新包。证据 `outputs/本轮复用验收-0.2.1/Newton初始状态`。持续目标 active，Crazyflie 波动和 Panda 发散未解决。

## R31 Newton 初值与依赖合并候选（进行中）

R31 原打包器 exit 0，源码 `a837dea2d61a73ff998fe721fedaa4136d592f07` 与载荷一致，归档 711943382 字节／SHA-256 `5e014d9cdb50605dfa422a53e81e0bca556c809d2c48d8d7912e30b3c5c410ea`，本机 ad-hoc、未公证。原安装器会话 86746 当前运行、日志 `work/r31-原流程安装.log`；回环服务会话13928。归档及清单已复制到 `outputs/本轮复用验收-0.2.1/发行R31`，此刻不得先行称安装或 Newton 自带依赖通过。目标仍 active，Panda 与 Crazyflie 限制不因打包改变。

R31 初次安装遇 Conda Python TLS 两次断流，终止该下载后原安装器 exit2，current 保持 R30；保留 partial 和日志。R30 同 Conda 包哈希 `23d06f02f64e6c768fce624cf369a92544a49e9cee29d3ee6762058474c912c2` 与已有 Conda 元数据匹配，复制到 R31 原缓存后续装；PyPI MuJoCo wheel 又三次断流，终止并保留日志，复制 R30 原 pip 缓存且该 wheel 哈希 `521329d8fc0d7f3d40cdafeb738b95ffeddec00f280e5482a68c284257be942f` 与 PyPI 索引匹配后再沿原安装器续装，最终会话26602 exit0，current=R31、previous=R30，doctor 与 MuJoCo 真实物理 PASS。原 Newton 安装器会话49099 exit0，自动装 Pillow11.3.0，doctor 报版本；R31 Python＋与安装 worker 同哈希的源码执行初值／纹理模型专项2文件通过，A1／Go2各10步。全部日志在 `发行R31`。

R31 独立 Guest 两个场景中实际通过原库预览、放置并同步 Go2／A1；Go2 由原安全逻辑暂停，点击继续后界面读到 Newton step17979→36955，被动物理而非行走。A1 同样暂停并同步，点击继续后 GUI 显示非有限刚体状态，保留截图和 AX。随后同一 GUI 场景、相同 R31 Newton Python 与依赖，R30 安装 worker 在第10步非有限、R31 安装 worker 第32步非有限；R30关节全0，R31按源 home，单次对照不证明全部根因。初次对照脚本错误取地面实体而关节列表为空，修正选择有真实关节的机器人后重跑，当前 JSON 为修正结果；失败步数同前，避免误称初次脚本完整正确。Go2及A1测试世界均经原面板关闭，应用17363 exit0，服务13928退出。A1持续稳定、Panda发散和Crazyflie悬停仍未解决；任务 active。

## Newton 固定版 MuJoCo CPU 求解路径的有界对照（2026-10-28）

R31 Newton 1.6.0 的 `SolverMuJoCo(use_mujoco_cpu=True)` 是固定 SDK 原有能力，隔离探针在同一个原 World 临时替换求解器；产品代码及默认 XPBD 未改变，未用 CUDA。A1 与 Panda 的原 GUI／同源场景保留默认地面时，转换均在初始化报 `Planes can only be attached to static bodies`：原场景 plane 属于 Newton 已装配的 body，而该求解器转换器要求 plane 的 body=-1；不能静默切换它。

作为明确反事实移除场景地面、不改源模型、初值、重力或 dt，再分别对照：A1 XPBD 第32步非有限／MuJoCo CPU 1000步有限；Panda XPBD 第343步非有限／MuJoCo CPU 1000步有限。补充真实基座读数 A1 z≈0.43→-19.21m 且关节改变，故无地面数值有限不代表站立或正常功能；未测接触、控制、语义一致性。一次对照支持求解路径差异，不能确定唯一根因，更不能把无地面称修复。相关原日志、JSON、脚本和说明在 `outputs/本轮复用验收-0.2.1/Newton原生CPU求解器对照`；未改代码或包，A1／Panda 和 Crazyflie 问题均保持，目标 active。

## Newton 自由根后位置目标索引（2026-10-28）

R31 固定 Newton 1.6.0 CPU 真实夹具新增自由根实体在位置驱动实体之前的场景；修复前源关键帧目标应为 0.4，正确控制数组位置实际为 0.0，夹具失败。源码初始控制映射现在复用原 `write_targets` 的 `newton.use_coord_layout_targets` 坐标／自由度索引规则，不更换引擎或状态所有者；原初始状态专项通过，底层 6 个真实 Python 夹具通过。该变更尚未打包或在安装版 GUI 验证。A1 受力限制的执行器仍由原守卫标记不可用，不能将此索引修复称为 A1／Panda 发散已修复；Crazyflie 悬停问题仍未解决。

进一步在相同真实 CPU 夹具中将关节初值设为 0.6，推进 500 步后验证跟随关键帧目标 0.4；同步显式目标 0.2 后再推进 500 步验证跟随 0.2，整文件通过。首次仅推进 250 步时 0.401186 未满足原 0.001 精度断言，保留为测试时间不足的实测，不改精度或求解器。

## Newton 机器人挂载相机原链路（2026-10-28）

界面检查发现原工作台准备相机只允许 MuJoCo／Isaac；Newton 原相机清单也缺 body 读回、物理帧缺 bodyWorldPoses、忽略 Scene 的显式 mount 与相机声明名称。沿原 Newton worker／相机插件和 Scene mount 合同补充：同一 Newton state 的真实 body 列表与同帧姿态；显式按实体范围唯一匹配目标 body、复用引擎位姿绑定相机并拒绝非法目标；工作台原准备路径允许 Newton，保留 SDK、世界身份与同帧守卫。没有新增调度器、状态所有者或相机渲染器。真实 Newton CPU 相机／初始状态／能力 27 项通过；相机相关 UI 回归 62 项通过、根类型检查通过。原相机夹具新增同一自由体的 source camera 与显式 mount 在运动前后实际像素和位姿对照、错误 body 拒绝与同帧观测一致；首次负对照因缺 bodies 失败。

基于 R31 隔离克隆，仅替换现有构建器产出的 shell 客户端及两份 Newton 源文件做候选测试；三个文件与当前源码／构建 SHA 相同，此候选不是 R31 归档或正式发行。首次界面已列出 13 个 Go2 真实连杆，但选连杆报 CAMERA_AUTHORING_BODY_REQUIRED，补充同帧 bodyWorldPoses 后正常重启该隔离候选并恢复同一测试场景，实际选择 FL_calf、保存，Newton 同步后显示真实相机图像，录制入口可点击。1 秒录制在世界暂停时实际只有 RGB／深度各 1 帧，提前达到墙钟上限；不算完整 1 秒录制。随后点击继续物理，当前 Go2 场景出现非有限状态，与前一场景长时被动运行成功不一致，故 Go2 稳定性仍未通过。世界经原界面关闭、应用正常 exit 0；原 R31 安装未被修改。单帧 PNG、录制状态和真实采集回执在 `outputs/本轮复用验收-0.2.1/Newton挂载相机`。此次未验证冷启动准备相机分支、持续录制、完整 CI 或全部相机功能。

## Newton 相机来源与固定机位录制（2026-10-28）

真实相机采集回执此前未给原录制归属守卫提供 parentEntityId／parentBodyName／mount；现直接由原 Newton 相机记录投影这些真实字段，native 和隐式附体也回传所属实体。新断言修前缺 parentEntityId 失败，修后真实 Newton CPU 相机 8 项通过。固定机位实际界面发现拍摄面板没有启用原相机清单轮询、保存后持续显示正在读取；仅在原 `useNativeCameraList` 启用条件加入 capture，真实 Workbench／工具栏 DOM 负对照 0 次读取、修后通过，并登记原 CI 清单。原相机界面／录制归属 DOM 等专项 12 项及根类型检查通过。

在同一 R31 隔离克隆上通过原界面导入自制固定根 MJCF（仅作测试，不带入发行），关闭物理世界后点“给这个机器人添加相机”，原准备路径重新启动 Newton，读到真实 body 并保存。画面预览就绪，用户动作开启 1 秒 RGB／深度录制，原记录显示 completed、duration-limit、elapsedS=1、66 帧；RGB／深度各 66 文件与 66 回执均存在，所有回执实体和 body 一致。该次相机采样与订阅录制帧 66 项均有步差、最大 27 步，不声称逐帧严格同步。此前真实 Go2 暂停录制 1 帧及发散事实保留；另一个 GUI 场景中原 generic_quadrotor 刚加入后也出现 Newton 非有限状态，故不能拿固定根夹具替代任何机器人动力学稳定性。修复前／后固定世界机位预览分别卡读取／出现原生真实图像，场景复用同一 clone；应用与物理世界已正常关闭。候选未重新打包，不等同最终安装版。完整记录 `outputs/本轮复用验收-0.2.1/Newton挂载相机`。

源码提交 `211a7536` 包含来源回执、拍摄面板清单启用与三项测试清单登记；其中原新增 `initial-state.test.ts`、`textured-model.test.ts` 之前漏登令 CI 预检 UNCLASSIFIED，已按缺依赖明确跳过的实际行为登记。CI 预检 415 纳入／66 排除／0 缺件，发布门及定向 DOM／录制回归 147 项通过、根类型检查通过。当前源码完整 CI 已启动会话 60851，JSON／日志在 outputs `相机修复后完整回归`；此时仍在运行，不能预称结果。用户工作树原有 HANDOFF.md 修改继续保留，目标 active。

会话 60851 已终态 exit 0；同一次完整回归清单 481 文件，415 纳入并全部运行通过、0 失败／0 缺件、66 按清单不运行；纳入文件内汇总 4530 通过、48 条件跳过。两份补登的 Newton 真实夹具分别无跳过通过，Newton 相机 8 项无跳过通过。至少 97 个纳入文件的 logTail 含 Bun 1.4.2 `Internal error: directory mismatch` 提示，相关文件仍返回 exit 0；确切根因未核明，按工具诊断保留，不能把这条提示说成已解决或当作产品功能失败。报告和完整摘要日志在 outputs `相机修复后完整回归.json`／`.log`；完整 CI 不替代未验收功能或真实物理稳定性。

## Newton 有力限执行器初始目标（2026-10-28）

对原 A1 GUI 场景做有界 CPU 同源对照：R31 导入原 `home` 关节位置，但对带源 forcerange 的位置 PD 禁用动作后，Newton 模型仍有 100 的位置增益而未读取源 keyframe ctrl，第一步最大六分量速度分量约 101.47，第 32 步非有限。只在隔离探针中将这些关节目标设为当前值或将相应增益设零，第一步均约 0.01962，分别仍在第 167／147 步非有限；后者为诊断反事实，没有纳入产品。原源 ctrl 与 home 目标一致的本例下，源 ctrl 接入消除了最初尖峰，不证明后续发散根因。

本地源码提交 `a98b7642` 沿既有 Newton 元数据匹配、control 与源 MuJoCo keyframe：唯一可识别的直接位置 PD 即使因有限力限不可执行动作，也保留其源初始 ctrl／显式初始控制；不同语义或同关节多执行器不猜测。仍拒绝受力限位置动作，不改力限、solver、重力或模型；世界新增 `SOURCE_ACTUATOR_FORCE_LIMIT_UNSUPPORTED` 告警，明确 XPBD 不执行源 forcerange，README 同步说明。真实有限力限＋自由根夹具在旧源码目标 0 失败、修后读取 0.4；显式值、动作拒绝、告警和多执行器歧义均通过。原始 A1 场景当前源码第 1 步 0.01962、第 167 步仍非有限；原能力／初值／纹理三个文件共 20 项通过、无跳过。本源码尚未重跑完整 CI 或打包；415 文件完整回归只对应上一个提交 `211a7536`。诊断脚本与记录见 outputs `Newton初始力限诊断`；Panda、A1、Go2、generic_quadrotor、Crazyflie 原问题仍未解决，目标 active。
