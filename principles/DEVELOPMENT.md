# Lyapunov 开发原则

本文是现行开发原则，整理并替代旧 `docs/DEVELOPMENT_PRINCIPLES.md` 中的稳定约束。旧原文逐字保存在 [历史归档](../docs/DEVELOPMENT_PRINCIPLES_2026-10-25_ARCHIVE.md)，只用于追溯，不作为现行依据。现行正文已按 Lyapunov 0.2.1 发行源码（`release/0.2.1`，提交 `00d3bc60d9fb5df7b4d45abc63f025f3d4ed1584`）核对；具体步骤、接口速查、CI 命令和已知差异见 [开发标准与流程](../docs/DEVELOPMENT_STANDARDS.md)。0.2.1 的发布日期、范围和验证状态以 [0.2.1 发布说明](../docs/releases/0.2.1.md) 与 [发布说明目录](../docs/releases) 为准，不以本机旧 `main` 的 HEAD 或旧账本代替。

## 1. 最薄：复用原生执行体系

Lyapunov 是建立在固定版本 DSH 原生运行时上的三维与物理能力扩展。产品层只实现 DSH 没有的领域数据、真实算法、引擎适配和必要界面，直接复用 DSH 已有的 Agent、Session、Tools、Commands、Jobs、权限、文件、子进程和插件生命周期。

“最薄”约束的是重复责任、重复状态和重复执行通路，不是文件长度、服务数量或插件数量。一个操作可以包含真实的几何处理、规划、碰撞和物理控制；不能因此另造第二套会话、Agent Loop、Jobs、权限或事件总线。

新增一层之前先回答：

1. 上游是否已经有这项能力？
2. 能否扩展现有的 operation、Provider 或界面投影？
3. 新层拥有什么独立状态、依赖或生命周期？
4. 没有这层，当前功能是否确实无法完成？
5. 移除后由谁承担同一责任？

如果唯一理由是“以后可能复用”或“文件更整齐”，先不增加。重复的适配与状态应收敛；真实算法复杂度不能为了短文件而被删除。

## 2. 核心稳定，能力优先插件化，界面保持统一

插件化的目标是让能力独立演进，而不是把界面拆成互不相干的系统。

- 核心保持稳定：会话、Agent、工具协议、权限、Scene／Sim 共享合同、权威状态和统一工作台骨架不复制。
- 可选能力优先沿已有插件机制接入：当能力有独立依赖、独立生命周期或可替换实现时，放入对应插件；当前已有的 `plugin.ts`、Tool、Command、Job、Provider 注册就是首选路径。
- 一个按钮、一个 helper、一段界面文案或一次下载，本身不足以成为新插件的理由。
- 可选插件失效只影响该能力，不拖垮无关场景、机器人、采集或界面。
- 启用、释放和能力缺失都要明确：插件卸载返回真实的清理 Promise，释放自己创建的订阅、进程、世界和临时运行资源；缓存和产物按所属生命周期与数据合同管理，不借插件卸载删除用户产物或共享持久缓存。能力缺失时在调用处给出具体原因。
- 共享合同和权威状态不复制到插件私有副本；插件不得另建同义资源账本、世界服务、历史库或任务调度器。
- 不默认新增热插拔机制、插件市场、插件框架或独立进程。只有出现明确的独立依赖、生命周期或替换需求时，才在现有机制上扩展。
- 保留必要的真实性、权限、数据完整性、兼容和可达性责任。“最薄”不等于删掉必要校验，也不等于只看行数。

Agent Graph、policy／技能库、Scene、Sim、Viewer 和设置都是既有领域插件与原生扩展，不是为本原则新增的框架。新增领域能力时优先接入这些现有 owner，而不是再建一套编排或状态层。

## 3. 状态唯一权威

每种状态只有一个权威维护方。展示、缓存和投影可以有多个，但必须带来源，且不能反写权威状态。

| 状态或能力 | 权威维护方 | 消费方职责 |
| --- | --- | --- |
| Agent 执行、会话事件、工具调用、任务与取消 | 固定版本的 DSH 上游 | 通过插件和公开接口扩展，不另建内核 |
| 场景结构、实体、层级、资源引用、文档版本 | `scene-kit` 的 `SceneStore`／`SceneOperations` | 通过 `ctx.scene` 或领域操作读取、提交 |
| 资源来源、版本、默认组件、依赖与目录索引 | `scene-kit` 的 `ResourceLibrary` | 引用资源身份，不另建同义账本 |
| 运行世界、物理时钟、执行器、动作与实测帧 | 当前 `ctx.sim` Provider | 通过 `SimService` 操作和订阅 |
| 可视化、选中项、相机视角、显示开关 | Viewer 与工作台界面 | 显示文档和实测帧，发出显式编辑请求 |
| Campaign／task／run 状态、预算与 run artifacts | `packages/agent-graph` 的 `campaign-store.ts`、`state-machine.ts`、`artifacts.ts` | 工具和 coordinator 读写既有 campaign 目录；界面只读 session projection |
| 任务谓词判定 | `packages/sim-task-check` 的 `sim_task_check` | 基于真实 `sim.observe`／inspect 读数和谓词求值，不用模型自报 |
| 技能提案、验证记录、准入与晋升账本 | `packages/policy-registry` 的 `skill-library.ts`／`skill-tools.ts` | 读写 `packs/<packId>/proposals|skills`；晋升只认 verify 记录 |
| 工作台 campaign 卡片 | `lyapunov-shell` 的 `campaign-projection.ts`（`sessionProjection 'campaigns'`） | 只消费会话投影，不私建第二份权威 campaign 状态 |
| 模型供应商凭据和生成任务远端状态 | 对应 Provider／账户 API | 展示任务状态与产物，不伪造结果 |
| 正式账户身份与消费者余额 | 官网身份服务、中央 BillingService | API 验证、转换协议并调用账单服务 |
| 运行目录与账户隔离 | 共享运行路径函数、Profile 和 Host 入口 | 复用解析结果，不在组件中猜绝对路径 |
| 引擎偏好 | `engine-preference.ts` 的 `resolveEngine()`／`defaultEngine()` | 设置界面读写下次启动偏好，不热切换当前世界 |

“唯一权威”不等于只允许一份展示数据。客户端缓存、会话投影、录制快照都可以存在，但必须保留来源身份，不能覆盖权威状态。campaign 的工作台面板是 projection，不是第二份 campaign.json；技能提案的展示也不能替代 `packs/` 中的提案、验证记录和晋升账本。

## 4. 分层与依赖方向

依赖由入口向下装配，由消费者面向共享合同调用：

- 入口与装配：解析配置、验证账户、创建 Host、选择插件、拥有并释放进程。
- DSH 原生底座：Agent、会话、模型、工具、Commands、Jobs、权限、文件和插件生命周期。
- 产品适配层：参数转换、注册、原生信号连接、结果呈现和会话身份传递。
- 领域与组合层：场景、资源、机器人动作、有限步骤工作流、campaign 编排、来源与结果事实。
- Provider 与外部执行层：真正调用 SDK、算法、供应商请求，返回能力和结果。
- 显示与工作区层：图形、文件、面板、选择和人工操作，消费来源明确的投影。

Provider 可以依赖共享合同及其专属 SDK，不能反向依赖 Shell／Viewer。界面通过原生 Tool／Command 或现有 HTTP 投影操作领域，不能直接操纵引擎内存。

同一个行为不能在 Tool、Command 和 HTTP 三处分别实现。`plugin.ts` 负责服务注入、参数定义、注册和生命周期连接；operation／adapter 负责领域行为；长任务使用 `ctx.jobs` 并向下传递取消信号；组合工作流复用已有工具和 `ctx.sim`，不创建新的 Agent Loop 或会话存储。

Agent Graph 的 Coordinator／Worker／Verifier 使用 DSH 原生 tools、subagents 和 hooks 组织角色与派发；底层 AgentLoop、Session 和 Jobs 仍归 DSH。campaign 状态机是既有领域状态，不是新的通用调度器。

## 5. 会话、资源与并发归属

一个产品实例包含一个 DSH Host／Profile，装配一种 Sim Provider 类型。会话是运行态归属键，不只是消息容器：

```text
一个产品实例
  └─ 一个 DSH Host / Profile（装配一个 Sim Provider 类型）
       ├─ 会话 A、会话 B……：各自拥有消息与工具调用来源
       ├─ Scene / 资源命名空间：<域根>/sessions/<会话键>
       └─ Sim 命名空间：每会话一套世界服务实例
```

- Scene、资源、机器人和世界服务按会话建立命名空间；取不到会话时明确失败，跨会话的非法目标操作返回结构化错误，不能落回全局共享状态。
- 同一 Cordis realm 只装配一个 Sim Provider，但这个 Provider 可以管理多个 world。需要不同引擎、不同运行数据或进程故障隔离时，另起 Host。
- 不得从“每个实体有 ID”或“已有按会话命名空间”推导出“所有会话已在任意组合下互不干扰”。并发隔离、多窗口显示控制权和图形复验分别取证。
- 独立实验可以使用不同 `sceneId`／`worldId`。若未来显式引入跨会话共享世界，必须说明谁控制、谁观察，并复用原生会话身份与现有 Sim 边界处理控制权。
- 完成、取消、停止和释放是不同事件：取消请求、控制撤销、停止回执和世界关闭分别报告；插件卸载、进程退出和账户切换要释放自己创建的订阅、进程和世界。
- 退出或切换账户时等待旧 Host 释放，不自动重发未完成机器人动作。
- campaign 的会话工作目录来自原生 `session.header.cwd`；取不到会话时明确失败，不落到宿主进程 cwd。

## 6. Scene、World、Frame 分离与引擎选择

`SceneSnapshot` 是持久场景文档，`WorldHandle` 是运行世界，`Frame` 是某个物理时刻的观测。三者不是同一个对象的三种名字。

- `scene_edit` 提交文档；`sim_sync` 把当前文档显式交给指定世界。提交成功而同步失败时，保留文档并报告同步错误，不能声称已经回滚。
- 文档版本、模型代次和物理步分别管理；不逐帧回写 Scene，不把 Viewer 的刷新或插值当成物理推进。
- 同一 Provider 可以管理多个 `worldId`。动作携带明确的 `worldId` 和 `expectedGeneration`；不能把“一个 realm 一个 Provider”误写成“整个产品只能有一个世界”。
- 查看旧录制不会重新执行机器人动作，也不会把历史帧变成当前物理状态。
- `sim_close` 释放运行世界，不删除场景文档或用户资产；停止录制不停止机器人，也不关闭世界。
- 引擎在 Host 启动时装配。修改偏好只影响下次启动；需要使用读取该偏好的入口重启。显式 `--engine` 或开发 YAML 中的引擎覆盖仍可压过偏好。
- 引擎选择只有一个实现：`resolveEngine()`。优先级为显式 `--engine` ＞ `LYAPUNOV_SIM_ENGINE` ＞ 用户偏好 ＞ 代码默认。非法引擎名报错，不静默回退。
- 代码默认由 `defaultEngine()` 给出：只有 Isaac 的 SDK 运行时、已接受许可、已确认加速器三项同时具备时才优先 `isaac`；缺任一项则明确理由并选择 `mujoco`。MuJoCo 未就绪也如实选择它，界面仍可启动，打开世界时按真实依赖报错。
- GPU 检测只覆盖设备／驱动／CUDA 加速器可用，不证明 Isaac RTX 兼容、RTX 成像或完整 world 验收；真实能否出图以当前 world 回执为准。
- 显式／环境／用户偏好一旦命中就原样采用，即使自动判定会得到另一个引擎也不替换；真实显式启动失败不能被当成“普通缺 GPU”而静默换引擎。已有手动偏好不被自动逻辑暗改。
- 标准安装准备 MuJoCo 与 Python；Isaac／Newton 按需安装。自动偏好、SDK 已发现、运行时已安装、世界已打开和任务成功分别是不同事实。

## 7. 身份、版本、坐标与单位

跨模块数据使用可序列化合同，不传递 MuJoCo、Isaac、Three.js 等引擎对象。

| 字段 | 语义 | 使用要求 |
| --- | --- | --- |
| `sceneId`、`revision` | 场景身份与文档版本 | 文档写入携带 `expectedRevision` |
| `resourceId`、`version` | 资源身份与来源版本 | 实例引用明确版本，派生表示保留来源 |
| `worldId`、`worldGeneration` | 运行世界与模型代次 | 动作携带 `expectedGeneration` |
| `entityId` | 场景／世界内实体 | 不用显示名称或当前选中项替代 |
| `actionId` | 一次动作的身份 | 查询、停止、重试沿用同一语义身份 |
| `stepIndex`、`simTime` | 物理步与模拟时间 | 不与文档版本、墙钟时间混用 |
| `frameId`、`sceneRevision` | 观测及其文档来源 | 相机、标注、工作流和录制保留来源 |
| `campaignId`、`taskId`、`runId` | campaign、任务与一次执行 | 工具、run artifacts 和投影沿用同一身份 |

共享空间采用米、弧度、秒、右手 Z-up，四元数顺序为 `xyzw`。来源资产的单位、坐标轴和手性由导入层显式记录、转换。肌腱坐标、关节位置、像素、深度和世界坐标分别命名，不能因为都是数值数组就互相替代。

## 8. 机器人由资产能力驱动

正常路径为：选择或导入资源 → 挂载实体 → 创建／同步世界 → 描述能力 → 执行动作 → 读取观测与回执。

- 同型号多机器人共享工具定义，以 `(worldId, entityId)` 区分实例。
- 控制器、关节、执行器、单位、限位和可用动作来自模型及组件声明；`robot_describe` 提供实际能力，不能假设所有模型都能行走、抓取、转向或飞行。
- 普通机器人加载不以生成专属工具、注册许可、中文记忆或额外 LLM 授权为前置条件。
- `motion_plan`／`motion_path` 产生计划，执行与任务结果由运行世界及工作流判定。
- `grasp_propose` 产生候选；候选分数不等于接触抓取成功；`sim_assist` 的附着辅助与真实接触抓取分别报告。
- 轨迹默认必须覆盖该机器人的全部受控关节。确需只驱动一部分关节时必须显式 opt-in；未列入的关节保持上一次写入的 ctrl，不得解释为“不动”或“归零”。支持范围按 Provider 声明，不由通用接口推断。
- 对声明了 PredicateExpr 目标的 campaign／仿真任务，任务级成功由真实观测和 `sim_task_check` 的谓词求值判定；官方 benchmark 遵循各自的官方 success 判据；其他工作流按其领域目标、终态／产物与真实来源验收。动作回执、策略执行返回、模型自报和 Agent 自述都不能替代上述验收。

产品支持机械臂、人形、机器狗、AGV／叉车、灵巧手和无人机。型号按实际语义独立登记：Go1／Go2 是机器狗，G1 是人形；LEAP、Allegro、Shadow 不共享任务成功结论。

大模型直接工具控制、预训练 policy、VLA 是三种控制来源。它们复用原生 Agent／Tools／Jobs 和 `ctx.sim`；机器人型号知识与网络前后处理放在资产／控制适配，不向 sim core 堆专属分支。优先复用公开策略和现有控制通道，避免每个 Demo 新建执行框架。

引擎轴为 MuJoCo、Isaac、Newton；LIBERO／Gymnasium 是可选任务负载。声明支持时区分四层：模型导入、动作执行、物理任务成功、真机。一个 Provider 实现不能推导其他 Provider 自动支持。

3DGS 视觉与碰撞几何同属场景组合，但用途、来源、坐标配准和消费引擎必须明确。已有 MuJoCo 碰撞链路应复用；引擎不支持组合盒、mesh／binding 时明确拒绝，不能静默变成默认小盒。房间壳和可拿取的杯子是不同实体，不能仅从背景渲染推出可交互任务。

## 9. 资产、数据、账户与凭据

### 9.1 原件、产物与缓存分离

运行目录按 `worlds`、`assets`、`robots`、`cache`、`catalog` 等域维护，由共享路径函数和资源库统一管理。

- 世界／背景、可调用物体和机器人落到对应域；资源目录索引归 `catalog`；派生、下载中间件和缓存归 `cache`。
- 录制、采集、会话、工作文件不是可随意删除的临时文件。
- 移动、软删除、解除关联、恢复各有明确操作；解除引用不等于删除原件。
- 外部下载保留来源、版本、许可和必要的文件身份；导入后的资源要能检查依赖缺失与变化。
- 迁移保留冲突与缺失信息，不能用占位文件替代用户原件。
- `workspace` 中的目录映射由共享函数维护，不能把同名用户真实目录当成待修复软链。

### 9.2 Guest、正式账户与开发凭据

- **Guest** 使用独立的本地工作区、设置和凭据文件；不连接产品账户、计费服务或中央 Credits，没有默认模型。用户可以显式配置自己的 provider 来使用 Agent；Guest 可以访问自己配置的 provider 网络，不是“禁止联网”，也不是“不能使用模型”。
- Guest 的产品服务边界拒绝访问 Lyapunov 产品服务器和已声明的产品 URL，但不禁止用户自己的 provider、普通本地网络能力或本地工具。
- **正式登录** 先验证账户，再创建对应的私有 Host；模型调用走账户 API 和中央 Credits，不能继承开发者的上游 Key。
- **开发模式** 使用独立的本机开发凭据和运行目录。开发凭据不得泄漏到 Guest 或正式账户；Guest 与正式账户也不得读取开发凭据或共享账户状态。
- 官网身份接入与中央 BillingService 共同构成正式账户路径；本地邮箱、钱包实现是开发路径。余额、订单和结算不能以客户端缓存为真值。
- 收费生成复用报价、用户授权、请求身份和恢复查询；不能因为超时就重复提交新收费请求。
- 发布分享以具体预览为对象，沿产品现有的用户确认流程执行。
- 不把运行环境、模型权重、密钥、账户数据或私有回执复制进源码发布包。

## 10. Agent Graph 状态、预算与技能库

### 10.1 Campaign 与 run artifacts

- campaign 持久化在**会话工作目录**下的 `.lyapunov/campaigns/<campaignId>/`：`campaign.json` 保存 Campaign 全量，`runs/<runId>/calls.jsonl` 追加每次工具调用，`runs/<runId>/run.json` 在关闭时嵌入完整 calls。
- `campaign-store.ts` 统一从 `session.header.cwd` 推出路径；取不到会话时明确失败，不落宿主 cwd。
- 任务状态机由 `state-machine.ts` 校验；非法迁移返回 `CAMPAIGN_ILLEGAL_TRANSITION`。dev 与 heldout 分区使用各自合法边，不能从历史设计文档照抄已经过时的迁移表。
- 角色流程要求调试与准入验证阶段保持 heldout 隔离：Worker 只在 dev 分区工作，Verifier 的准入复现也按协议在 dev 场景进行。当前 0.2.1 代码的边界是具体的：`state-machine.ts` 的 `assertRunPartition` 只拒绝 worker 触碰 heldout run，verifier／coordinator run 被允许，`defaultRoleFor('heldout-eval')` 返回 verifier；`artifacts.ts` 的 worker 场景守卫覆盖当前工具参数中指向 heldout 的场景。不能把角色协议要求写成所有 verifier 一律无权访问 heldout。
- Verifier 与 proposer 的执行上下文和原始运行证据仍需隔离；当前 `CAMPAIGN_VERIFIER_ISOLATION` 是路径级工具参数守卫，在活动 run 的工具参数包含 `.lyapunov/campaigns` 时拒绝，不冒充 OS 级完整沙箱。verifier 通过经投影的技能提案和独立验证输入工作。
- 工作台 campaign 面板消费 `sessionProjection 'campaigns'`，只展示 task 状态矩阵、预算用量和 `lastError`；不能私建第二份权威 campaign 状态，也不能用面板读数替代 `campaign.json`。

### 10.2 预算

- 预算由 `campaign_init` 设置 `maxToolCalls`、`maxSimSteps`、`maxWallSeconds`，沿 `tools/execute` waterfall 按 run 计量：工具调用计数、回执 `stepIndex`／`startStep`→`endStep` 增量、campaign 起始时间。
- 超限后该 campaign 名下后续调用被 `CAMPAIGN_BUDGET_EXCEEDED` 拦截；造成超限的当次调用允许完成，避免半写状态。
- 预算是现有执行通路的计量，不新造收费、计费账户或物理状态；也不把预算读数写成模型能力或任务成功。

### 10.3 技能提案、验证与晋升

- `skill_propose` 只写 `packs/<packId>/proposals/<skillId>.json`，不直接进 `skills/`；`skill_verify_record` 覆盖写 `proposals/<skillId>.verify.json`；`skill_promote` 才把提案转正到 `packs/<packId>/skills/<skillId>.json` 并向 `promotions.jsonl` 追加一行。
- 准入必须具备验证记录、`passed === true`、独立验证身份，并通过现有完整校验：缺少记录或未通过返回 `SKILL_NOT_VERIFIED`；`verifierRunId` 与 proposer 的 `devEvidence.runIds` 重合时拒绝自审准入；输入、提案 JSON 与文件校验失败同样拒绝。不能把单个 `passed` 布尔值当作充分条件。
- `pack_skill_list` 只列已准入技能；`pack_skill_get` 明确返回 `admitted` 标志。提案、验证记录和晋升账本由 policy-registry 的现有实现维护，不能另建同义技能账本或复制一套晋升状态。
- 技能只有验证证据满足实际门槛才由现有角色协议中的授权角色晋升；晋升是准入事实，不等于所有模型、引擎或机器人任务都已运行通过。
- Verifier 的 `CAMPAIGN_VERIFIER_ISOLATION` 守卫拒绝读取 `.lyapunov/campaigns` 下的 proposer 原始运行产物；它拿到的是经投影的提案和独立验证输入，不是 proposer 的会话或原始执行证据。

## 11. 接口、错误与真实能力

一个接口至少核对注册名、入参、返回值、错误、取消行为和启用条件。接口名相似不能视为可互换。

- DSH 模型 Tool、斜杠 Command、工作台 HTTP 入口、账户 REST API 是不同调用面，参数包装和认证方式不同。
- 调用示例按真实 schema 编写。常用 `{ "input": ... }` 包装的工具，不要套用 `request_json`；使用 `request_json` 或结构化 `plan` 的工具，按各自合同选择，不能同时提交。
- 能力可选时在调用处读取服务并给出明确不可用原因；只有必需服务进入 `inject`。
- Provider 未实现的能力返回结构化错误，不能以空结果、估算数据或渲染动画代替真实完成。
- “存在包”“已注册工具”“解释器目录存在”“类型检查通过”分别是不同事实，不能互相替代。
- 新增功能按具体 Provider、具体型号和具体能力声明支持范围；共享接口存在不等于每个引擎都已实现。

## 12. 依赖隔离与外部运行时

只安装、启动当前功能需要的运行时。MuJoCo、Isaac、Newton、LIBERO、Gymnasium 的版本约束和解释器环境不能随意混用。

- DSH 版本由 `UPSTREAM_LOCK.json` 的提交及产品补丁确定；产品 Bun 与上游 pnpm 分别使用自己的锁文件。
- 上游变更通过固定提交与登记补丁管理。不直接编辑 `.upstream/**/lib`、`packages/*/dist` 或生成的桌面文件；修复进入源码或补丁。
- 新 Provider 必须同时接通合同、运行装配、选择入口、解释器解析、安装路径和验收。
- 可选 SDK、GPU、模型或许可证缺失只影响对应能力，不应拖垮无关功能。
- 标准安装准备 MuJoCo 与 Python；Isaac／Newton 按需安装，不把自动偏好写成随包或默认安装。
- Hugging Face Hub 的查询、下载与校验统一使用 `HF_ENDPOINT=https://hf-mirror.com`。镜像缺对象、revision、访问权限或校验失败时报告具体阻断，不静默回退官方端点。
- 走镜像的进程若继承本机 HTTP 代理，可能被代理重定向到官方站点；客户端应在发请求前按现有包端点跳转纪律拒绝违规跳转（原包端点合同文档若不随本源码分发，以实际客户端守卫为准）。给走镜像的进程设置 `NO_PROXY=hf-mirror.com,.cdn.hf.co`（连同 `no_proxy`）是运行环境建议，不由产品代码代改用户的全局代理。
- 不将本机运行环境、模型权重、密钥和账户数据复制进源码发布包。

## 13. 以行为判断冗余

相同函数体是可合并候选；相似文件名、包数量或重复工具前缀不是删除依据。

- Tool 与 Command 复用同一 operation 是合理的多入口，不是重复业务。
- 多个引擎共用 `SimService` 合同，各自的引擎适配代码仍有存在理由。
- `robot_stop` 与 `sim_stop` 委托同一停止实现，是语义入口重叠，不能直接判为重复物理逻辑。
- `.upstream`、`node_modules`、`dist`、解码器和生成的桌面 JS 不与手写产品源码一起计算维护性冗余。
- 提取公共代码前，确认输入、错误、取消、持久化与生命周期语义相同；保留真实依赖差异。
- 删除入口前必须查调用、装配、构建与发行引用，并说明旧用户路径如何承接。

## 14. 证据分层与完成定义

| 结果层次 | 能说明什么 | 仍需对应证据的事情 |
| --- | --- | --- |
| 语法与类型检查 | 检查范围内的源码可解析、类型满足约束 | 运行装配、外部依赖和物理结果 |
| 构建成功 | 产物生成 | 发行包启动、升级和卸载 |
| 工具／Command 调用成功 | 该次操作返回 | 任务是否达到目标 |
| 物理动作回执 | 控制窗口及观测结果 | 抓取、搬运等任务成功条件 |
| `sim_task_check` 谓词结果 | 某个真实世界／代次下的任务判定 | 其他场景、引擎或配置同样成立 |
| Campaign 状态与技能晋升 | 既有 campaign／技能库的状态和准入事实 | 真实模型、GPU、机器人任务已运行通过 |
| Provider 实测 | 被测环境和被测能力可用 | 其他引擎、机器、模型或配置 |

- 构建器明确输出 `BUILT_NOT_RUNTIME_VERIFIED`。
- 交付时记录实际命令、结果与范围；缺必需依赖报告 `BLOCKED`，部分通路完成报告 `PARTIAL`，没有运行证据的能力保持未验证。
- 文档、界面和最终结论采用相同口径。旧截图、旧回执和旧通过数字不能作为新一轮验收。
- 人工视觉审阅不能由代码 CI、类型检查或按钮可点击代替；交互任务验收不能只数按钮。
- 文档迁入、campaign 投影存在、技能晋升成功或设置页显示状态，都不等于产品已满足全部运行验收。

## 15. 演示、文档与真实性

用户明确要求的固定拍摄动作可以作为场景本地预置，通过独立 Profile 装配，复用 `ctx.scene`、`ctx.sim`、原生 Jobs 和已有 Tool／Command。动作表属于 Demo 数据，不进入默认产品路由，不添加另一套物理循环或 Agent。

机器人、器具视觉、碰撞来源和执行模式必须分别核对：

- 关节到位不能替代无可见穿模、真实抓握或任务终态验证。
- 辅助持物、固定基座、预置动作和液体示意必须在使用说明中标注。
- 来源资产的许可、单位、坐标和依赖保留；不把生成或下载的模型直接当成已验证可执行资产。
- 文档可以解释约束，但不能用“文档已写”推导实现已满足；文档、界面和回执都服从同一证据标准。
