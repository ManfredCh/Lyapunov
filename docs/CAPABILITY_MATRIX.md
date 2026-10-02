# Lyapunov 能力总表

更新：2026-09-27（按当前 Dev 源码更正明显过期项；逐项证据与剩余动作见 [开发状态](../development/STATUS.md)）。历史读数保留日期与限定任务，不代表每个组合都在今天重跑过。本表是产品能力、机器人和引擎支持的统一入口；[TODO](DEVELOPMENT_TODO.md) 记录卡点，[已解决账本](RESOLVED_ISSUES.md) 记录有界完成。（**09-27 更正范围**：§1 VLA／Go1、§2 Go1、§3 Isaac 相机与碰撞、§4 生成与多会话、§5 G1 Demo 当前状态；其余行未重跑。）

状态分为：**本轮复跑实测**、**历史实测／报告**、**代码已实现**、**部分完成**、**阻断**。历史结果保留日期与任务范围，不代表当前每个组合都重跑过；引用 09-19 等旧结果的行都标明为历史实例。

## 1. 三条机器人控制路径

| 路径 | 实际工作方式 | 当前事实 | 尚缺什么 |
| --- | --- | --- | --- |
| **大模型直接控制机器人** | 产品原生 Agent 读取图像／结构化状态，调用 `robot_*`、`sim_*` 或官方 `bench_*`，观察结果后继续动作 | **09-19 历史实测**（保留原数字）：LIBERO 抓起 alphabet soup 并送入篮内，17 次 `bench_step`、123 步，官方 `check_success=true`（[回执](../bugfixHistory/DEMO-CAPABILITIES-20260919.md)） | 每种机器人仍需可执行控制通道；此次为状态辅助单任务实例，不是全套成功率，也不是 09-27 重跑结果 |
| **预训练 policy** | 检索 → 固定来源下载 → 校验 → `policy_prepare` → `policy_match` → `policy_execute/stop` | G1 TorchScript、Go2 ONNX、Go1 Walk These Ways `wtw-go1-torchscript-v1` 均有专门适配分支（`adapter.ts:311/321/349/363`）；Go1 限定任务历史真实产品路径成功见台账 R440 | 各机型全任务与多引擎复验仍按 DEV-024；Go1 不能用 Go2 适配器替代 |
| **VLA** | 图像＋语言＋状态输入模型，输出动作块，再由现有执行层消费 | **SmolVLA×LIBERO 已有专门适配与并列 VLA 执行分支**（`adapter.ts:349`、`execution.ts:234`、`match.ts:95`），产品通路 `policy_execute` 曾在限定 seed／任务跑出官方终态（台账 R463–R469；不等于全任务成功率）。策略来源现为 **modelscope / github / huggingface / packs** 四档（`policySource()` 对四个值均返回而不抛，`FETCHABLE_PROVIDERS` 同四值，`policy-registry/src/plugin.ts` 有 HF 检索分支） | 选定路线（SmolVLA×LIBERO）已有专用适配和 09-23 限定任务证据（台账 R463）；其他 VLA 模型／任务须逐项做图像预处理、动作归一化、末端／关节语义与步频适配并各自验收。**2026-09-27 更正**：本行原写"策略来源目前只接受 GitHub、ModelScope""本轮 `provider:huggingface` 返回 `POLICY_SOURCE_UNSUPPORTED`"，**两句都已过期**——`POLICY_SOURCE_UNSUPPORTED` 现在只在**未知来源值**上抛（`packages/policy-registry/src/source.ts:49`）。HF 策略的端到端执行本次未重跑（HF 只走镜像） |

大模型调用工具控制，不要求先下载机器人专属 policy。它也不等于让语言模型取代引擎的高频控制、动力学或稳定控制器。policy 与 VLA 属于可组合的控制来源，复用现有 `ctx.sim` 与原生 Jobs，不新增 Agent loop。

**完整演示主线**：自然语言任务 → 产品 Agent 观察 → 抓取 → 搬运 → 官方终态 → 原生视频与结果导出。证据见 [09-19 演示与卡点回执](../bugfixHistory/DEMO-CAPABILITIES-20260919.md)（历史实例，保留原数字）。

## 2. 机器人支持矩阵

| 机器人族／型号 | 可复用控制 | 已有证据与范围 | 当前任务卡点 |
| --- | --- | --- | --- |
| 机械臂／Panda 等 | joint、trajectory、gripper、control、IK、规划和抓放组合 | MuJoCo 关节与真实接触抓放；09-17 Isaac 抓放组合；09-19 Panda 官方 LIBERO 单任务成功（历史实例，非 09-27 重跑） | 型号、负载、夹具与引擎分别验收；成功进入篮内不额外证明松夹后长期放稳 |
| 人形／**G1** | 关节通道；官方 12DOF TorchScript 适配 | 47 维观测、12 维输出、50 Hz；09-13 历史报告含 Isaac T4 原地转向成功 | 指定路线稳定行走、停止及当前版本复验；不能泛化到 Figure 或其他人形 |
| 机器狗／**Go2** | 关节通道；INRIA ONNX 适配 | 98 维两帧观测、12 维输出、50 Hz；有原生策略测试脚本 | 各引擎行为验收与场景任务覆盖 |
| 机器狗／**Go1** | 模型可走通用导入与关节合同；Walk These Ways 有 `wtw-go1-torchscript-v1` TorchScript 适配 | 权重经产品下载校验；台账 R440 记录限定任务 8／16 s 稳定行走、自动停、行走中取消停（真实产品路径成功；边界：速度跟踪约 41%、低姿） | 全任务、速度跟踪与多引擎复验；不借用 Go2 或 G1 结果 |
| AGV／叉车 | vehicle、lift、批量动作 | 历史 G05 车辆／升降切片与 F12 双车组合 | 具体底盘、轮径、载荷、路线、引擎及停止行为分别覆盖 |
| 灵巧手／**LEAP** | joint、gripper；按模型使用 tendon | 历史 MuJoCo 任务报告通过；Isaac 完整接触判据仍 PARTIAL | 当前模型的抓取、抬升、保持和释放回执需要单列；本轮未重跑 |
| 灵巧手／**Allegro** | 按模型执行器映射控制 | 历史曾有外部适配器与判定窗口修复，产品保持漂移失败记录；Isaac PARTIAL | 核对最新原始结果，不能由手指运动升级为抓取通过 |
| 灵巧手／**Shadow** | fixed tendon／关节联动；停止保持 | 历史真实产品开合及停止通过；抓取→抬升→保持仍 FAIL | 对向接触、物体滑脱和保持目标；低层 tendon 已有，不重写为“完全不支持” |
| 无人机／四旋翼 | thrust、BodyWrench；外部控制器闭环 | 推力通道与历史任务切片已有；Isaac 有后续推力实现记录 | 当前机型起飞、悬停、航点、停止与跨引擎复验；不能将推力输入称为通用飞控 |

真机是另一列能力：上述仿真结果不代替厂商通信、设备状态、限幅与急停验收；本轮未连接任何真实机器人。

源码：[通用动作合同](../packages/sim-contract/src/index.ts)、[机器人操作](../packages/robot-tools/src/operations.ts)、[policy 适配](../packages/policy-registry/src/adapter.ts)、[策略说明](../packages/policy-registry/README.md)。历史细分结果见 [09-12/13 追踪账本](../bugfixHistory/refactor-execution/CURRENT_TODOLIST_20260912.md)，其旧 LIBERO 失败结论由 09-19 单任务成功补充，其他历史失败保留。

## 3. 引擎与物理能力

| 引擎／负载 | 当前实现 | 验证范围与缺口 |
| --- | --- | --- |
| **MuJoCo** | 机器人动作、刚体／多体、重力、接触／摩擦、关节／执行器；命名相机、RGB-D、标定、批注和数据导出；3DGS 配准碰撞环境 | 多项真实物理切片已通过；每个模型与碰撞资产仍需核对 |
| **Isaac Sim** | 原生模型导入、关节与动作、部分传感／RTX 路径、刚体物理；五个相机接口（列表／调整／多相机采集／像素标注／数据集导出）已实现；引擎选择经 `resolveEngine` 统一（Isaac 优先、未就绪回退 MuJoCo） | 09-17 G08/G09 有实际运行与抓放；DEV-009 回执给出相机接口的算术／引用／数据集与转发层真读数，**真实 RTX 成像待设备可见会话复验**；Scene 复杂碰撞与 MuJoCo 存在能力差异 |
| **Newton** | 独立可选 Provider，世界建立、同步、观测及实时基础切片 | 当前动作、接触、相机、碰撞补丁等接口不完整，不能当成与前两者等价 |
| **LIBERO／Gymnasium** | 官方任务／评测负载，通过可选适配包调用官方环境 | 不属于第四种物理引擎；LIBERO 09-19 官方单任务成功（历史读数），Gymnasium 当前聚焦 Ant-v5 |

已实现力学主要是刚体、多体、关节、执行器和接触动力学；本表不宣称已提供通用有限元、流体或软体求解工作流。物理反馈来自实际引擎，动画和附着辅助单独标记。

Isaac 优先／MuJoCo 回退的默认与各入口已由 `resolveEngine()` 统一（DEV-001／002 台账 verified）。跨引擎并行已有历史限定实验，但多 session 控制权隔离仍是 DEV-003，二者不能互相替代。

## 4. 场景、下载、生成、指令与数据

| 能力 | 已有功能 | 当前边界 |
| --- | --- | --- |
| 下载与导入 | 公开环境检索／详情／导入、URL 下载、本地 GLB／3DGS／MJCF／URDF、策略固定版本下载与校验；新 SSOG 代码候选支持已适配分享页选定公开 LOD 的全 chunk 压缩 SOG 收件及单文件 `.sog` 直链 | 新 SSOG 目前为源码／本地 CI／构建与真实单块 Viewer 局部画面证据；只有 URL 的完整 LOD0、18 块组合与资源占用待验。公开层是派生件，不等于需登录取得的原件；下载到文件也不代表碰撞／控制适配 |
| 生成与建模 | Blender 脚本／MCP，Marble、混元、Tripo 插件，分割与派生资产 | 三家共用同一套正式生成入口，产物已做**共享转存**（台账 R475 有过真实产品通路生成成功）；账户 API／正式网关已移出本仓，正式商业链路以独立运维仓库的部署与授权为准；具体模型标识与凭据由运维给出，未配置时明确拒绝 |
| 指令与交互 | 自然语言工具调用、斜杠 Command、工作台面板、文件／终端、三维批注与就地编辑 | 多入口复用同一 operation；真实桌面焦点与共享世界并发仍有待办 |
| 3DGS＋碰撞体 | 已有 Scene collision 声明、配准绑定、MuJoCo 分层碰撞补丁；外部 collider-forge 与 asset-bake 可串联 | 不把一个房间的整体包围盒当成室内可通行几何；本轮套房只取得 SPZ，配套 GLB 尚未找到 |
| 记录与导出 | 场景版本、资源来源、动作事件、引擎相机和录制／数据集导出 | Viewer 截图与引擎标定图像分别标注 |

### 3DGS 碰撞已经做过，本轮补的是哪里

09-17 真实 3DGS 实体的盒代理在 MuJoCo 中承接自由落体物体，接触合力约 **9.81 N**，不是落在隐藏地面。该历史样例的代理尺寸来自产品外测量；随后 `splat-bounds.ts` 已补位置范围读取。另一条已配准 splat↔GLB 链路由 `scene-collision` 编译高度场与墙体盒，不能把两条证据混称为完整同源精细网格成功。

本轮 **Luxury Suite**：已下载 37,278,944 字节 SPZ，并在产品 Viewer 显示内部空间；按原网站 Viewer 的轴约定对该实体增加 X 轴 180°旋转。公开 manifest 仅列 SPZ，检查的同名 GLB 候选返回 404；这只说明公开入口未找到，不能断言 OSS 中不存在其他文件。

当前 Isaac 的 Scene 碰撞分支已处理组合 `shapes[]`、`center` 与基础材质／摩擦／质量（DEV-029 切片，见 [ISAAC07-10 回执](../bugfixHistory/ISAAC07-10-COLLISION-MATERIAL-20260921.md)），但仍未接入 MuJoCo 的 `collisionPatches`，3DGS 等精细房间几何的消费差异仍按 DEV-029。要做套房内操作，还需配准的局部碰撞几何和独立可操作的杯子／机器等实体。**套房内广义咖啡流程（真实抓取／流体等）尚未演示**；09-20 固定基座倒水 Demo 见 §5，已有完整演示为单独的 09-19 官方 LIBERO 桌面任务。

## 5. G1 咖啡／倒水 Demo 当前状态

**当前状态在 2026-09-20 更新**：固定基座、脚本预置、辅助持壶、液体示意 Demo 已完成——imagegen 设计 → 四件百炼 Tripo GLB → 同源 USD 碰撞 → Isaac G1 动作 → 原生 Agent 一句话触发与反馈 → 完整界面录像；21/21 动作到位，两次完整执行通过（详见本文末「2026-09-20 增补」与 [G1 回执](../bugfixHistory/G1-ISAAC-POUR-20260920.md)）。范围仅限固定基座、脚本预置、辅助持壶与液体示意；真实抓取／流体／全身平衡／VLA 不随此项标记完成。

**历史（2026-09-19 及更早，保留原说明与链接）**：旧版执行 9 段预设动作，存在手壶穿模和造型问题，用户已否决；随后按新要求生成透视图、经 Tripo 分别生成桌／杯／壶／咖啡机并用 Isaac 重做，原生 Isaac MJCF 路径先建立世界并运行前 6 段探针动作后因本地 150 秒总上限停止。这些是当时“新资产与新版本运行尚未完成”的阶段记录，已被 09-20 的完成态取代，不代表当前仍未完成；也不表示 PhysX 缺少基本碰撞能力。设计文件 `output/lyapunov-coffee-assets-v4/`、重复 MJCF 显示问题、portable 依赖映射和旧姿态穿模分别记录在 [G1 咖啡回执](../bugfixHistory/G1-COFFEE-DEMO-20260919.md)。

## 6. 卡点与下一步

- [DEV-023](DEVELOPMENT_TODO.md#dev-023)：更多官方任务、种子与自主控制覆盖。
- [DEV-024](DEVELOPMENT_TODO.md#dev-024)：Go1／Go2／G1、LEAP／Allegro／Shadow 逐型号任务验收。
- [DEV-025](DEVELOPMENT_TODO.md#dev-025)：3DGS 来源轴、配套几何与可通行碰撞环境。
- [DEV-028](DEVELOPMENT_TODO.md#dev-028)：Go1 policy 与 VLA 来源／推理／动作适配。
- [DEV-029](DEVELOPMENT_TODO.md#dev-029)：Isaac 消费 Scene 复杂碰撞并拒绝静默退化。

Demo 可用已实现工具、确定机位和限定任务绕开非必要接入问题；必须说明实际路径。没有调用 VLA 就不标 VLA，没有真机就不标真机，没有精细房间碰撞就不标套房物理完成。

## 2026-09-20 增补：G1 一句话倒水

**已完成固定Demo**：imagegen设计→四件百炼Tripo GLB→同源USD碰撞→Isaac G1动作→原生Agent一句话触发与反馈→完整界面录像。21/21动作到位，壶嘴水平偏差2.604 mm；两次完整执行通过。辅助持物已修复相对姿态跟随并分别实测Isaac与MuJoCo。以上更新取代前文“Tripo装配／G1新版本尚未运行”的阶段状态；旧简模仍是被否决版本。

**范围**：固定基座、脚本预置、辅助持壶、液体示意；真实抓取／流体／全身平衡／VLA不随此项标记完成。套房本身尚无可信配套碰撞资产，器具碰撞成功不等于整间套房物理化。[使用说明](G1_POUR_DEMO.md) · [回执](../bugfixHistory/G1-ISAAC-POUR-20260920.md)。

## 2026-09-20 原生桌面最终范围

原版LyapunovDev已收敛为单一“倒水工作”会话，显示G1套房与两个普通HTML标签；携带版为另存的产品介绍／天安门图集单文件。多会话归属已有修复，并有四会话＋Host 重启读数（[DEV003-198 回执](../bugfixHistory/DEV003-198-FOUR-SESSIONS-20260926.md)）；该回执**当时**登记了四项局限（B=LIBERO 真世界需另起 benchmark Host、C 天安门画面缺 DRACOLoader、切换非侧栏点行、C 迟到回执打错 sceneId）。其中 C 的 DRACO 故障属于**当时**的 Viewer 缺解码器，此后已补 `draco-decoder.ts`／`gltf-draco-decoder.ts` 源码与 `gltf-draco-decoder.test.ts`／`robot-glb-ktx2-texture.test.ts`（主控新跑 13 pass）；单 Host 只装配一个 Provider（B 需另起 benchmark Host）是**现有约束**。包含该修复的**完整四会话在最新包上的图形复验仍待**——不能把“仍缺复验”写成“仍无修复”，也不能标为已支持任意并行 session。

09-19 LIBERO 官方单任务的 123 步成功仍有效（历史读数，保留原数字），但不证明松手放稳或取回；显式续接与纹理读取只有候选实现／夹具验证。历史记录已定位并保全112份关键日志，尚未全部重导入UI。见[本轮卡点与处理](DEMO_BLOCKERS_AND_HISTORY_20260920.md)、[历史核查](HISTORY_RECOVERY_20260920.md)。
