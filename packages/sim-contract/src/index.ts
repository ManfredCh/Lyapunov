import type { SceneSnapshot, WorldHandle, Frame, ActionReceipt, MotionPlan, WorldWarning, PenetrationSummary, PenetrationPair } from '../../lyapunov-contracts/src/types.ts'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import type {} from '@deepseek-ai/cordis'
export type { WorldHandle, Frame, ActionReceipt, MotionPlan, WorldWarning, PenetrationSummary, PenetrationPair }

/** 消费者只依赖公共契约；具体 Provider 不拥有 Context 类型。 */
declare module '@deepseek-ai/cordis' { interface Context { sim: SimService } }

/**
 * 显式 opt-in：允许这条轨迹只覆盖**受控关节的子集**（`robot_describe.controlledJointNames` 的真子集）。
 * 语义：未列出的关节**保持上一次写入的 ctrl**——既不是"不动"，也不是"归零"（provider 不写它们的 ctrl）。
 * 因此"手臂轨迹 + 保持夹爪动作建立的夹持力"必须走这个字段：把夹爪关节塞进轨迹会让 provider 每个 tick
 * 用位置目标覆盖夹爪 ctrl，夹持力被清零（真机实测：close 后两指 0.0278 → 被 lift 轨迹改写成实测值 ⇒ 物体滑脱）。
 * 不传时契约逐字不变：轨迹必须精确覆盖全部受控关节，否则 provider 报 `INCOMPLETE_JOINT_VECTOR`。
 * 当前只有 MuJoCo provider 实现（`packages/sim-mujoco/python/worker.py` 的 trajectory 校验）；
 * Isaac/Newton 仍按默认路径拒绝子集（`packages/sim-isaac/test/worker-robot-metadata.test.ts` 的 `INCOMPLETE_JOINT_VECTOR` 断言不带该字段）。
 */
export interface JointTrajectory { kind: 'trajectory'; entityId: string; jointNames: string[]; points: Array<{ timeS: number; positions: number[] }>; tolerance?: number; settleTimeS?: number; plan?: MotionPlan; partialJointVector?: boolean }
export interface JointTarget { kind: 'joint'; entityId: string; jointNames: string[]; positions: number[]; durationS: number; tolerance?: number; settleTimeS?: number }
export interface VehicleDrive { kind: 'vehicle'; entityId: string; speedMps: number; steeringAngleRad?: number; yawRateRadps?: number; durationS: number }
export interface LiftTarget { kind: 'lift'; entityId: string; positionM?: number; velocityMps?: number; durationS: number; tolerance?: number }
export interface GripperTarget { kind: 'gripper'; entityId: string; widthM: number; durationS: number; settleTimeS?: number; tolerance?: number }
/**
 * 四足步态动作：**几何开环的关节位置参考**，不是策略推理。
 * 参考由 `packages/sim-mujoco/python/gait.py` 的 `targets()` 按相位算出（`calibrate()` 先从源 MJCF 经
 * `mj_forward` 标定平面二连杆几何：l1/l2/home/b0/td/bs/ss/ks/phase）；MuJoCo 与 Isaac 两个 worker 都
 * **直接 import 这一份实现**，不各写一套。`forward`/`turn` 是 [-1,1] 的显式意图：`forward` 只缩放摆动
 * 幅度与相位次序（**不是速度目标，也不携带位移方向**——turn=0 时 ±forward 在一个周期内给出的目标集合
 * 逐值相同，只是相位次序不同），`turn` 逐腿差速。
 * **本动作不保证稳定行走、也不保证净位移方向**：目标里没有任何方向量，"会不会走/朝哪走"只能由位移读数
 * 回答（真机实测 forward=+0.6 ⇒ 净位移 x=−0.0868 m，向后；判定见
 * `bugfixHistory/VERIFY-ISAAC-GAIT-DRONE-20260926.md` §2.2-A18）。回执的 `targetReached` 恒为 null：
 * 连续相位轨迹没有"到位"语义，该字段不得被读成通过。
 * **策略路线不占用本动作**：调用方给出 `policy`/`packId` 时由策略插件走
 * `executePolicy → sim.execute(kind:'control')`；两者都不给时本动作原样透传到 Provider 的几何开环通道。
 * 能力面的语义见 `RobotCapability` 的 gait 一段（`available:true` = 这条通道能下发，不是"会走"）。
 */
export interface GaitMotion { kind: 'gait'; entityId: string; forward: number; turn?: number; durationS: number }
/** 手动时钟下的有界控制采样：保持执行器参考目标，不做位置插值或额外收敛步。 */
export interface ControlStep { kind: 'control'; entityId: string; jointNames: string[]; positions: number[]; stepCount: number }
/**
 * 资产声明的体坐标 wrench：thrustN 沿机体 +z（N），torqueNm 绕机体 x/y/z（N·m，参考点=该实体根刚体坐标系原点）。
 * 支持范围按源执行器力律逐条核对，不是“所有 source actuator 都支持”：只有 controller 映射指向的
 * site 执行器为「固定增益（gaintype=fixed）、无状态（dyntype=none）、无偏置（biastype=none）、无 plugin、
 * 无 refsite」时才支持；此时标量执行器力 = gain×ctrl（gear 表达在 site 局部系，映射列向量并入 gain 与力臂），
 * ctrlrange/forcerange 是源权限边界，真正超权限明确 OUT_OF_RANGE 拒绝、不静默夹取，映射无法精确表达
 * 请求 wrench 时明确拒绝。带 activation dynamics/bias/affine 增益/plugin/refsite 的执行器明确 UNSUPPORTED，
 * 不会静默按直接力采用，也不自动改源物理；同时要求 0∈ctrlrange/forcerange，保证停止/完成后的零力。
 * 命令是请求；回执分开报告 ctrlPlanned（计划控制值）、ctrlApplied（窗口内真实写入过的控制原值，从未驱动时为 null）、
 * mappedActuatorForce 与 wrenchPerDrivenStep（模型映射估算）、measuredActuatorForce 与 measuredAtStep
 * （真实测得：同一物理步积分完成时成对记录，绝不把窗口结束后的力冒称最后驱动步），不把估算标成实测、不把未执行写进已施加。
 * 引擎是否具备“已施加外力”回读取决于引擎能力：Isaac 6.0.1 的刚体外力通道没有回读接口
 * （omni.physics.tensors 只有 apply_forces 系列、clear_forces、get_net_contact_forces），此时 measuredActuatorForce/
 * measuredAtStep 必须为 null 并附 measuredActuatorForceNote 说明，绝不用 wrenchPerDrivenStep 顶替实测。
 * 引擎对不同 batch 成员采用同一整数步窗口语义：窗口外与完成/停止/关闭后写零撤销，短动作不被同批长动作拖长。
 * 窗口内每个物理步驱动：
 * durationS 按物理步长量化（实际时长=量化步数×dt），stepCount 为显式整数步且需要 manual 时钟，两者二选一。
 * 完成/停止/关闭即撤销该推力（支持范围内 ctrl=0 ⇒ 力严格为 0）；保持悬停由外部飞行控制器继续输出，本动作不承诺任务成功。
 */
export type BodyWrench = { kind: 'thrust'; entityId: string; thrustN: number; torqueNm?: [number, number, number] }
  & ({ durationS: number; stepCount?: never } | { stepCount: number; durationS?: never })
/**
 * 源模型 tendon 执行器的肌腱坐标位置参考；肌腱不是关节，与 joint 动作分开寻址。
 * 命令坐标 = 源 tendon 自身坐标（fixed tendon 为 Σ coef·q，逐条关节/系数/单位见 robot_describe
 * 的 tendonActuators；例如 Shadow 四指 rh_FFJ0 = 1·rh_FFJ2 + 1·rh_FFJ1，单位 rad）。
 * 写入前按源执行器换算 ctrl = gear×目标，超出源 actuator ctrlrange 明确拒绝；该换算只在源执行器
 * 通过固定位置力律核对时成立（dyntype=none、gaintype=fixed、biastype=affine、gainprm[0]==-biasprm[1]、
 * biasprm[0]==0，此时平衡坐标=ctrl/gear），否则动作以 UNSUPPORTED_CAPABILITY 拒绝，不假称位置参考。
 * 源的 gain/bias/forcerange 原样保留，本动作不替换任何控制器。durationS 内参考从当前实测坐标线性
 * 插值到目标，之后保持目标并等待 settleTimeS；完成时参考留在目标上，stop/close 时参考改写到当时的
 * 实测坐标（不会把肌腱写 0 或反向张开）。
 * 回执区分三类值：targetLengths 是请求目标；ctrlApplied/lastAppliedLengths 是本动作最后实际写入的
 * 源 ctrl 与换算坐标（取消时是插值中途的真实值，从未开始的取消为 null，started/appliedSteps 标明
 * 本动作是否真实写过控制）；holdReference 是停止后 neutralize 写回并读回的保持参考。targetReached
 * 只表示【已真实写入控制且】坐标落在容差内，不代表抓取或任何任务成功。
 */
export interface TendonTarget { kind: 'tendon'; entityId: string; tendonNames: string[]; lengths: number[]; durationS: number; tolerance?: number; settleTimeS?: number }
export type EntityMotion = GaitMotion | JointTrajectory | JointTarget | VehicleDrive | LiftTarget | GripperTarget | ControlStep | BodyWrench | TendonTarget
export type SimAction = { actionId: string; expectedGeneration: number; startStep?: number } & (EntityMotion | { kind: 'batch'; motions: EntityMotion[] })
/** 当前 realm 的模拟 Provider 由 Profile/DSH 插件选择，open 不切换引擎。 */
export interface WorldOptions { worldId?: string; timestepS?: number; realtimeFactor?: number; frameRateHz?: number; ground?: boolean; clock?: 'realtime' | 'manual'; /** 在首个对外物理步之前原子暂停；不改变时钟、重力或模型。省略保持原默认行为。 */ startPaused?: boolean }
export interface ObservationSelection { entityIds?: string[]; contacts?: boolean; sensors?: boolean;collisionTopology?:{entityIds?:string[];includeGeometry?:boolean} }
export interface StopSelection { entityIds?: string[]; actionId?: string; expectedGeneration?: number }
export interface JointDescription { name: string; type: 'hinge' | 'slide'; unit: 'rad' | 'm'; range?: [number, number]; actuator?: string; /** 只报源元数据声明的执行器模式；源未声明时该字段不出现（不默认 position），此时 prepare(kind:'control') 对该关节明确拒绝。 */ controlMode?: 'position' | 'velocity' | 'torque'; /** 引擎侧该关节 drive 的力限回读（N·m / N，视关节类型）；无有限限值的关节不出现该字段。 */ driveMaxEffort?: number; /** 引擎侧该关节 drive 的刚度回读（位置 drive 的 kp，力矩执行器=controller.jointKp/kp）；无有限值时不出现。 */ driveStiffness?: number; /** 引擎侧该关节 drive 的阻尼回读（位置 drive 的 kd，力矩执行器=controller.jointKd/kd）；无有限值时不出现。 */ driveDamping?: number; /** 驱动该关节的源 tendon 执行器名；该关节没有关节级执行器，只是被肌腱带动。 */ tendonActuators?: string[] }
/**
 * 源模型 tendon 执行器通道。名字是源码里的 tendon 名（tendon 动作按它寻址），actuator 是源执行器名，
 * 两者都可能不同。受肌腱驱动的关节不进 controlledJointNames（controlledJointNames 只表示关节级执行器）。
 */
export interface TendonActuatorDescription {
  name: string
  actuator: string
  /**
   * 只有核对过固定位置力律的源执行器才是 'position'（此时 ctrl=gear×坐标，平衡坐标=ctrl/gear）；
   * 其余自定义力律标 'custom'，tendon 动作会拒绝它们，不冒充 position/velocity/torque。
   */
  controlMode: 'position' | 'custom'
  tendonType: 'fixed' | 'spatial'
  /** fixed tendon 按源顺序缠绕的关节（spatial tendon 为空数组）。 */
  joints: string[]
  /** 与 joints 同序的源缠绕系数（Σ coef·q；spatial tendon 为空数组）。 */
  coefficients: number[]
  /** 坐标单位：全部 hinge→'rad'，全部 slide→'m'，混合→'mixed'；spatial tendon 用源几何长度，单位 m。 */
  unit: string
  /** 源执行器 gear[0]：ctrl = gear×肌腱坐标。 */
  gear: number
  /** 允许命令的肌腱坐标区间（源 ctrlrange 按 gear 换算）；源未限制或 gear 为 0 时 null。 */
  controlRange: [number, number] | null
  /** 源执行器 ctrlrange 原样；未限制时 null。 */
  ctrlRange: [number, number] | null
  /** 源执行器 forcerange 原样；未限制时 null。 */
  forceRange: [number, number] | null
  /** 源 gainprm/biasprm 前三项；position 执行器 kp=gainprm[0]=-biasprm[1]，kv=-biasprm[2]。 */
  gainprm: number[]
  biasprm: number[]
  /**
   * 仅 MuJoCo：该执行器属于本实体，但肌腱定义在本实体前缀之外——本实体的 tendon 动作不能寻址它。
   * worker 只在为真时写 `True`（`sim-mujoco/python/worker.py` 的 `if t['external']`），
   * 因此**该键出现即代表越界**；不越界时键不出现。
   */
  externalTendon?: true
}
/**
 * 只读发现元数据：该实体在 Frame.sensors.freeBases 中会出现的自由根（动态body），不是受控关节。
 * massKg 是源模型声明的自由根质量（可能缺省）；它只用于回执里的 SI 核对与显示，
 * 不是推力映射的一部分（推力方向/比例全部来自源执行器 gear/gain/site）。
 */
export interface FreeBaseDescription { jointName: string; bodyName: string; massKg?: number }
/**
 * 合同承认的 `RobotCapability.kind` 全集（**唯一来源**，`RobotCapability['kind']` 由它派生；导出运行时常量
 * 是为了让“合同是否等于 provider 实际投递集合”能被测试直接核对，而不是靠人读类型）。
 * 判据不是“引擎型号有什么”，而是 **provider 实际投递哪些 kind**：
 *  · Isaac worker 的 `capabilities()` 逐实体投 **8** 条（thrust/vehicle/joint/gripper/lift/control/gait/tendon）；
 *  · Newton 只投其中的 6 条（它既没有腿结构也没有肌腱通道，缺的两条不等于本元组漏项）；
 *  · MuJoCo 不产出逐实体 capabilities（但它的 gait 动作通道与 Isaac 同一份实现，见 `GaitMotion`）。
 * 元组曾经只写 `thrust|vehicle|joint|gripper|lift|control`，于是 `gait.available`／`tendon` 的语义**没有任何
 * 合同承载**（跨语言边界无运行时校验，越界 kind 静默流过；`sim-newton/test/capability-truth.test.ts` 还把
 * “封闭 6 元组”当成判据）。增删本表必须同时给出 provider 侧投递证据。
 */
export const ROBOT_CAPABILITY_KINDS = ['thrust', 'vehicle', 'joint', 'gripper', 'lift', 'control', 'gait', 'tendon'] as const
export type RobotCapabilityKind = (typeof ROBOT_CAPABILITY_KINDS)[number]
/**
 * 只读能力面：该实体对某类动作的可用性与**明确原因**，不按“成功默认”假定。
 * 消费者（工具面/规划器）先读 available 再发动作；available=false 必须带 reason（错误码前缀+可读说明），
 * 不允许空值或“等调用时再说”。能力来自源模型/资产配置的核对结果，不是引擎型号的能力声明。
 *
 * thrust：只有“自由根刚体 + controller 映射指向的 site 执行器满足固定增益/无状态/无偏置/无plugin/无refsite”
 * 才 available；没有真实 rotor/site 执行器元数据（或该实体是 articulation）时就是 false，
 * 不用固定常数冒充、也不退化成按关节施力。available=true 时必须给出映射事实：
 * actuators（4 个源执行器名，顺序 thrust,x,y,z）、siteBody（源自由根刚体名）、massKg（源质量）、
 * controlRanges/forceRanges（逐执行器源权限，未限制为 null）、frame（体坐标约定文本）。
 * vehicle：需要 controller 里的 wheel/steering 配置且实体有 articulation（无关节实体没有可寻址轮执行器）。
 * joint：需要 articulation；无关节刚体没有关节通道。
 * gripper/lift：需要 articulation、对应的 controller.gripper／controller.lift 映射，且关节名可解析、不是源声明的被动关节。
 * control：需要 articulation、manual 时钟，以及至少一个 mode 非 velocity 的关节级执行器（位置参考通道）。
 * gait：需要该实体自身的腿结构通过**几何标定**（`sim-mujoco/python/gait.py` 的 `calibrate()`：四组三关节、
 * 平面二连杆、几何取自源 MJCF 经 `mj_forward` 的 xpos/xmat/geom_xpos）。**available=true 的含义是
 * “几何开环的相位目标可下发”，不是“会走”**：这条通道没有策略权重、没有状态估计、没有稳定器、没有反馈，
 * 参考是 `targets()` 按相位算出的关节位置目标，而该目标**不携带位移方向**（turn=0 时 ±forward 在一个周期内
 * 给出的目标集合逐值相同，只有相位次序不同）——机器人是否前进、朝哪边、会不会摔倒由物理与外部条件决定。
 * available=true 时必须给出产生参考的控制器与几何来源（controller／geometrySource）与相位参数
 * （frequencyHz／strideM／liftM），并**必须**带 stableWalkingNotGuaranteed（见该字段）。策略路线不占用这条
 * 能力：给了 policy／packId 时走 `executePolicy → sim.execute(kind:'control')`（见 `GaitMotion` 的说明）。
 * Provider 私有的标定 dump（Isaac 的 `legs`：腿序与 home/l1/l2/b0/td/… 逐值）**不进合同**——消费者要读的
 * 是 jointNames 与 controller／geometrySource／相位参数，腿几何是各 Provider 自己的中间量。
 * tendon：按源 tendon 执行器**逐条**回答（见 `TendonActuatorDescription`）；没有长度／速度回读面时恒为
 * false（没有到位判据就不接通道），available=true 只表示“源 tendon 坐标有可寻址的驱动通道”。
 * 各条判定与执行侧 prepare(kind:…) 的拒绝同源：available=true 时该动作不会因缺源声明／配置／时钟被拒。
 */
export interface RobotCapability {
  kind: RobotCapabilityKind
  available: boolean
  /** available=false 时必填：错误码前缀（如 MISSING_CONTROL_CONFIG/UNSUPPORTED_CAPABILITY/ENTITY_NOT_ARTICULATED）+ 说明。 */
  reason?: string
  /** 仅 thrust 且 available：源映射的 4 个执行器名，顺序固定 thrust,x,y,z。 */
  actuators?: string[]
  /** 仅 thrust 且 available：4 个执行器 site 所在的源自由根刚体名。 */
  siteBody?: string
  /** 仅 thrust 且 available：源声明的自由根质量 kg（SI 核对用，不参与映射）。 */
  massKg?: number
  /** 仅 thrust 且 available：键与 actuators 同集的源 ctrlrange；源未限制为 null。 */
  controlRanges?: Record<string, [number, number] | null>
  /** 仅 thrust 且 available：键与 actuators 同集的源 forcerange；源未限制为 null。 */
  forceRanges?: Record<string, [number, number] | null>
  /** 仅 thrust 且 available：体坐标约定文本（原点/轴向/单位）。 */
  frame?: string
  /** 仅 vehicle 且 available：已配置的车轮数。 */
  wheels?: number
  /** 仅 vehicle 且 available：是否配置了 steering 执行器。 */
  steering?: boolean
  /** 仅 joint 且 available：关节总数。 */
  joints?: number
  /** 仅 joint 且 available：受关节级执行器驱动的关节名。 */
  controlledJointNames?: string[]
  /**
   * 仅 joint 且 available：controlledJointNames 的来源。'unavailable' 表示源资产没有可核验的关节／执行器元数据
   * （URDF 与原生 USD 分支的 convert() 返回 metadata={}），该列表保守为空——含义是“无从核验”，不是“没有受控关节”。
   */
  controlledSource?: 'source-metadata' | 'unavailable'
  /**
   * 仅 gripper／control／gait 且 available：gripper 是 controller.gripper.jointNames；control 是 mode 非 velocity 的
   * 关节级执行器所驱动的关节名（两者都是 prepare 会写入位置目标的关节）；gait 是全部腿关节名（几何标定
   * 通过的那四组三关节，按腿序展开）——三者都是 prepare 会写位置目标的关节。
   */
  jointNames?: string[]
  /** 仅 gripper 且 available：controller.gripper.maxWidthM（米），夹爪宽度目标的闭区间上界。 */
  maxWidthM?: number
  /** 仅 lift 且 available：controller.lift.joint 声明的升降关节名。 */
  joint?: string
  /**
   * 仅 gait 且 available：**产生关节参考的控制器标识**。实测值指向 `sim-mujoco/python/gait.py`
   * （同一份实现被 MuJoCo 与 Isaac 两个 worker 直接 import，不是各写一套）。该键出现即代表这条通道
   * **不是策略链路**：参考由几何相位算出，没有权重、没有状态估计、没有稳定器、没有反馈。
   */
  controller?: string
  /** 仅 gait 且 available：标定几何的来源（实测：`gait.calibrate()` 取自源 MJCF 经 `mj_forward` 的 xpos/xmat/geom_xpos）。 */
  geometrySource?: string
  /** 仅 gait 且 available：相位频率 Hz（`gait.targets()` 的 frequency；Isaac 实测 1.8）。 */
  frequencyHz?: number
  /** 仅 gait 且 available：摆动幅度参数 m（`gait.targets()` 的 stride；Isaac 实测 0.12）。 */
  strideM?: number
  /** 仅 gait 且 available：抬腿高度参数 m（`gait.targets()` 的 lift；Isaac 实测 0.05）。 */
  liftM?: number
  /**
   * 仅 gait：**该键出现即代表“本通道不保证稳定行走，也不保证净位移方向”**——与 MuJoCo worker 回执 effect 的
   * 同名字段同一口径（`packages/sim-mujoco/python/worker.py` 的 gait 分支：
   * `{'controller':'planar-diagonal-trot','stableWalkingNotGuaranteed':True}`）。
   * 合同没有“保证行走”的取值，所以这不是模式开关而是**事实声明**：gait 通道是几何开环相位目标，
   * 目标本身不携带位移方向（turn=0 时 ±forward 一个周期内的目标集合逐值相同）。
   * **缺键不等于保证**：调用方不得把“没有这个键”读成“有稳定器”——它与 `externalTendon` 一样是
   * “出现即断言”的键，不是默认值。
   */
  stableWalkingNotGuaranteed?: true
}
/**
 * describe 结果的来源口径：controlledJointNames 只表示关节级执行器驱动的关节；源资产没有可核验的关节／执行器元数据时
 * （URDF 与原生 USD 分支的 convert() 返回 metadata={}）该列表保守为空，并由 controlMetadata 说明原因，
 * 绝不按“有 DOF”推断全部 DOF 受控。
 *
 * 另含 Provider 的加法字段（原样透传，未产出的 Provider 不出现该键）：Newton 的 `nativeJointLabels`
 * （joints + freeJoints 的源 label，按源顺序）、`nativeShapeLabels`（源 shapeLabels）、`device`
 * （该 Provider 解析出的真实设备标识）。
 */
/** 只读原生 site 执行器映射；与 prepare(thrust) 的同一 compiled 模型核对，不把声明当已施力。 */
export type NativeBodyWrenchDescription = { available:false;reason:string } | {
  available:true;frame:'body-root';units:{force:'N';torque:'Nm'};massKg:number;bodyName:string;sourceSha256?:string;gravityWorldMps2:[number,number,number]
  actuators:string[];matrix:number[][];limits:Array<{name:string;gain:number;ctrlrange:[number,number]|null;forcerange:[number,number]|null}>
}
export interface RobotDescription { entityId: string; modelVersion: string; expectedGeneration: number; collisionContextVersion: string; joints: JointDescription[]; controlledJointNames: string[]; tendonActuators?: TendonActuatorDescription[]; freeBases?: FreeBaseDescription[]; bodyWrench?:NativeBodyWrenchDescription; capabilities?: RobotCapability[]; controller?: Record<string, unknown>; controlMetadata?: { status: 'UNAVAILABLE'; reason: string }; nativeJointLabels?: string[]; nativeShapeLabels?: string[]; device?: string;
  /** 来自实际编译模型/装配 USD；未提供时不猜 body、site 或基座能力。 */
  nativeBodies?: import('../../lyapunov-contracts/src/robot-authoring.ts').NativeRobotBody[];
  nativeSites?: import('../../lyapunov-contracts/src/robot-authoring.ts').NativeRobotSite[];
  base?: import('../../lyapunov-contracts/src/robot-authoring.ts').RobotBaseState;
}
/**
 * capture 的显式可选渲染配置。geomGroups 列出 MuJoCo 显示组 0..5 中要渲染的组：
 * 给出时只渲染列出的组（RGB 与深度共用同一设置），未给出时沿用引擎默认可见组；
 * 该配置只影响渲染，不改变碰撞、质量或任何物理结果。
 * width/height 改的是输出分辨率：pinhole 焦距按视口等比缩放、主点按 ((W−1)/2,(H−1)/2) 跟随，
 * 回执里的 calibration 报的是**该分辨率下实际参与渲染的 K**（不是源声明值的原样回显）。
 */
export interface CaptureOptions { outputDir: string; cameraName?: string; width?: number; height?: number; geomGroups?: number[] }
/**
 * 同一 stepIndex/simTime 一次采集全部已命名相机。cameraNames 非空、不重复，任一名字不存在即整体拒绝；
 * 所有相机共享同一 frameId/sceneRevision/captureId，逐相机返回真实 RGB/米制深度与完整 pinhole 标定。
 * 每台相机的 calibration.intrinsicsSource 说明 K 的来源（engine-intrinsics=源声明的 fx/fy/cx/cy 真进了渲染；
 * mjcf=原生 MJCF focalpixel/principalpixel；fovy=只声明视场、由引擎公式推得），
 * engine-intrinsics 时以 appliedIntrinsicsPx 回显实际应用的声明值；引擎无镜头畸变模型时声明值如实回显并标
 * distortionModeled=false，不用 SQUARE_PIXEL_APPROX 之类近似把已知 K 折成各向同性。
 */
export interface MultiCaptureOptions { outputDir: string; cameraNames: string[]; width?: number; height?: number; geomGroups?: number[] }
/**
 * 对当前 world 的已命名相机建立/局部更新临时 override（positionM/quaternionXyzw/fovyDeg），只影响后续渲染与标定回执，
 * 不改源 MJCF/Scene 文档；三个字段都可单独或组合给出，未给出的位姿字段只继承同一 referenceFrame 下已有的显式字段，
 * 否则取该 frame 下的当前源值；clear=true 与字段互斥且清除；非 clear 时至少给出一个字段。
 * referenceFrame 省略时默认 'world'（positionM/quaternionXyzw 是世界位姿，明确固定的世界位姿不随关节运动改变）；
 * 'parent' 表示相对相机所属 body 的局部位姿，每帧用该 body 当前 FK 转成 world，用于腕部/头部挂载相机的安装偏移微调，
 * FOV-only 且没有显式位姿字段时不冻结姿态（每次渲染/标定都用当前源相机 FK）。frame 切换会在当前 FK 上做显式安全换算
 * （回执标注 frameConverted/convertedFromFrame），不静默混用坐标。
 * 回执给出合成后的完整 position/quaternion/fovy/intrinsics、最终真实 worldFromCamera、parentBodyName/referenceFrame
 * 与 override/worldGeneration，sim_close/sim_sync 或 clear 时清除。
 *
 * K 语义：仅移位（或只改 width/height）时相机的源 K 不变，回执用 intrinsicsAtReferenceResolution 报出该相机在
 * **本次调用的参考分辨率**（调用给出的 width/height，未给则 640×480，与 capture 默认一致）下实际生效的 K，
 * 供调用方按自己关心的分辨率核对同一台相机；
 * 对已有 K 的相机给 fovyDeg 时按 fovyApplied='intrinsic-focal-rescale' 只重标定焦距
 * （fy' = H_c/(2·tan(fovy/2))、fx' = fx·(fy'/fy)），主点不动、不把 K 折成 fx=fy；纯 fovy 相机仍是整幅视场。
 * 只有 clear 路径带 calibration（清除后的校准）+ cleared/override=false；override 路径报 override=true、
 * fovyApplied、intrinsicsAtReferenceResolution、worldFromCamera 与各 positionOverridden/... 标志，不带 calibration。
 */
export interface CameraAdjustOptions { cameraName: string; expectedGeneration: number; referenceFrame?: 'world' | 'parent'; positionM?: [number, number, number]; quaternionXyzw?: [number, number, number, number]; fovyDeg?: number; width?: number; height?: number; clear?: boolean }
/**
 * 像素 (u,v) + 该 capture 的真实米制深度 → camera/world 坐标。depthM 若给出必须与真实渲染一致（否则拒绝）；
 * 省略时用被引用 capture（或本步真实渲染）的实测深度；边界像素、背景/无效深度明确拒绝。
 */
export interface CameraAnnotationOptions { cameraName: string; pixel: [number, number]; depthM?: number; captureId?: string; width?: number; height?: number; geomGroups?: number[] }
/** 把真实 capture 记录导出为自包含数据集（samples.jsonl + 逐相机标定 + 标注引用 + 真实 PNG/NPY 副本）。 */
export interface CameraDatasetExportOptions { outputDir: string; captureIds: string[] }
/**
 * 一套世界服务（一个会话的 Provider 实例拥有的全部世界）。方法语义与修前逐条一致；
 * 区别只在**归属**：这些世界属于取到它的那个会话，别的会话寻址不到（见 `SimService`）。
 */
export interface SimWorlds {
  /** 只读发现当前Provider世界；供Viewer刷新/重连，不启动未使用的SDK。 */
  listWorlds(): Promise<WorldHandle[]>
  /**
   * 可选只读投影：Provider 若拥有该世界的原生 Scene 文档（例如官方编译模型），按 worldId 返回快照。
   * 只有该活动世界自己拥有这份文档；消费者不得据此写入任何持久 Scene owner，也不得编辑它。
   */
  scene?(worldId: string): SceneSnapshot | Promise<SceneSnapshot>
  /**
   * 显式建立世界。`signal` 是调用方的取消：只结束**本次尚未交付的 open**（没起 worker 就拒绝、
   * 起了就按归属终止本次自己的 worker，绝不重试、也不碰其它已交付的世界）；已交付世界的结束仍只走 close。
   */
  open(snapshot: SceneSnapshot, options?: WorldOptions, signal?: AbortSignal): Promise<WorldHandle>
  sync(worldId: string, snapshot: SceneSnapshot, options?: { forceRebuild?: boolean }): Promise<WorldHandle>
  /** 同一原生物理钟暂停/继续，不关闭世界、不重建代次；其它Provider可明确不支持。 */
  setPaused?(worldId:string,paused:boolean,expectedGeneration:number):Promise<WorldHandle>
  describe(worldId: string, entityId: string): Promise<RobotDescription>
  observe(worldId: string, selection?: ObservationSelection): Promise<Frame>
  execute(worldId: string, action: SimAction, signal?: AbortSignal): Promise<ActionReceipt>
  receipt(worldId: string, actionId: string): Promise<ActionReceipt>
  /** 立即撤销选中动作的控制目标；affectedEntityIds 是本次停止真实撤销过的实体（MuJoCo/Isaac worker 都按 entityIds 过滤后返回该字段）。 */
  stop(worldId: string, selection?: StopSelection): Promise<{ stopped: true; stepIndex: number; receipts: ActionReceipt[]; affectedEntityIds?: string[] }>
  /** 可选停止事件：仅在当前会话的真实 stop 确认后通知上层控制器，防止短窗口间继续提交。 */
  subscribeStops?(worldId:string,listener:(selection:StopSelection)=>void):()=>void
  subscribeFrames(worldId: string, listener: (frame: Frame) => void): () => void
  close(worldId: string): Promise<void>
  /** 辅助附着保持初始相对位置与姿态；仍标记 assisted-teleport，不计作真实接触抓取。 */
  assist(worldId: string, options: { mode: 'attach' | 'release'; expectedGeneration: number; objectId: string; robotId?: string; anchorBody?: string }): Promise<Record<string, unknown>>
  capture(worldId: string, options: CaptureOptions): Promise<Record<string, unknown>>
  /** 同一物理步一次采集多个已命名相机（多视角同步）；兼容旧 capture，物理钟不额外推进。 */
  captureMulti(worldId: string, options: MultiCaptureOptions): Promise<Record<string, unknown>>
  /** 只读列出全部命名相机的真实（或临时 override 后的）位姿、视场与**实际生效 K**（含 intrinsicsSource/appliedIntrinsicsPx 与未建模畸变声明）。 */
  listCameras(worldId: string): Promise<Record<string, unknown>>
  /** 已命名相机的临时 override 建立/清除；不写源 Scene/MJCF，close/sync 清除。 */
  adjustCamera(worldId: string, options: CameraAdjustOptions): Promise<Record<string, unknown>>
  /** 像素+真实深度 → world 坐标标注（深度必须来自真实渲染，可溯源）。 */
  projectAnnotation(worldId: string, options: CameraAnnotationOptions): Promise<Record<string, unknown>>
  /** 真实多视角采集 → 自包含训练数据集（JSONL/PNG/NPY/标定/标注）。 */
  exportCameraDataset(worldId: string, options: CameraDatasetExportOptions): Promise<Record<string, unknown>>
  /** 释放这一套世界服务（含其 worker）。Host 级释放走 `SimService.dispose()`。 */
  dispose(): Promise<void>
}
/**
 * 宿主级仿真门面：世界服务**按会话**取用，一个会话一个 Provider 实例/worker 进程
 * （`SessionSimFactory` 实现这条映射；官方套件适配器是单活动世界的评估器，见其 `forSession`）。
 *
 * 没有会话就没有世界服务：`forSession` 拒绝空键，调用方必须先把会话核实清楚
 * （工具/命令用 exec/invocation 的 agent，HTTP 用 `bindSessionId`），绝不落回某个共享实例。
 */
export interface SimService {
  forSession(sessionKey: string): SimWorlds
  /**
   * 只读事实：该会话是否已经起了实例（**不隐式创建**）。只读路由（state/frame/robot-description…）
   * 据此避免「读一次状态就替一个会话起一套 Provider 实例」；调用方依赖它时先判 undefined。
   */
  has?(sessionKey: string): boolean
  /** 当前已有实例的会话键（诊断/管理读，不产生副作用）。 */
  sessions?(): string[]
  /** 只释放一个会话的实例与 worker；其它会话一步不动。 */
  release?(sessionKey: string): Promise<void>
  /** Host 级释放：释放全部会话实例。 */
  dispose(): Promise<void>
}
/**
 * 工具/命令侧取世界服务的唯一入口：会话身份只来自执行上下文里的原生 agent
 * （`exec.agent` / `invocation.agent`），与 scene 侧走同一份 `requireSessionId` 规则；
 * 没有 agent、或宿主没装配 Provider 时都明确失败，不落回任何共享实例。
 */
export function simWorldsFor(ctx: { get(name: string): unknown }, owner: unknown): SimWorlds {
  const sim = ctx.get('sim') as SimService | undefined
  if (!sim) throw new Error('PROVIDER_UNAVAILABLE: 当前Profile未启用模拟Provider')
  return sim.forSession(requireSessionId(owner, '模拟世界服务'))
}
export class SimError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); this.name = 'SimError' }
}
