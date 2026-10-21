import type { Frame, WorldHandle, SceneSnapshot, Vec3, Quaternion } from './types.ts'

/** 位姿均为米、右手 Z-up、四元数 xyzw。声明保存在 Scene，实际状态由当前原生 Frame 回读。 */
export interface RobotAnchorPose { positionM: Vec3; quaternionXyzw: Quaternion }
export interface RobotBaseBinding {
  mode: 'source' | 'free' | 'fixed'
  bodyName: string
  /** 省略 entityId 是世界锚点；给出时位姿在指定真实 body 的局部坐标系。 */
  target?: RobotAnchorPose & { entityId?: string; bodyName?: string }
  /** 解除固定时由当前真实 Frame 采样的初始姿态，避免重建后瞬移回源安装点。 */
  initialWorldPose?: RobotAnchorPose
}
export interface RobotTcpDefinition {
  body: string
  /** 真实源 site 与自定义 body 局部偏移二选一；源 site 的完整局部姿态由编译器读回。 */
  site?: string
  offsetM?: Vec3
  quaternionXyzw?: Quaternion
}
export interface NativeRobotBody {
  name: string; parentName?: string; root: boolean; massKg?: number; jointTypes: string[]
  worldFromBody?: RobotAnchorPose
}
export interface NativeRobotSite extends RobotAnchorPose { name: string; bodyName: string }
/**
 * 只读安装资格：源模型是否含「一旦被 moving 父树带动即非法」的静态度量（MuJoCo/PhysX 的 plane）。
 *
 * 判据只来自源/实际原生元数据：本字段只描述事实，不删除几何、不按文件名猜、不改写源模型或引擎规律。
 * `attachable=false` 时预览必须在提交前拒绝 moving 挂接；独立根/世界固定子 body 的正常安装不受影响。
 */
export interface RobotInstallEligibility {
  /** 能否把该实体根固定到另一个实体的 body（moving 挂接）。 */
  attachable: boolean
  /** 会被 moving 父树带动的不合法静态 plane 所在 body（真实原生局部名；空数组表示无此约束）。 */
  staticPlaneBodies: string[]
  /** 只读原因码；`attachable=true` 时省略。 */
  reason?: string
}
export interface NativeRobotConstraint {
  name: string; kind: string; active: boolean; bodyName?: string; targetEntityId?: string; targetBodyName?: string
}
/**
 * 当前 world/generation 的运行控制状态：实体是否被原生约束保持（不是假 baseBinding、不是 Scene checkpoint）。
 * `scope` 是真实受影响实例/部件范围；`holdPose` 是解除可恢复、但不会自动继续旧动作的保持位姿。
 */
export interface RobotFreezeState {
  frozen: boolean
  freezeId?: string
  scope?: string[]
  rootHeld?: boolean
  jointLocks?: string[]
  holdPose?: RobotAnchorPose
  restoreAvailable?: boolean
}
export interface RobotBaseState {
  bodyName: string
  mode: 'fixed' | 'free' | 'articulated' | 'unknown'
  source: 'native-model' | 'scene-base-binding' | 'importer-fixed-base' | 'native-constraint'
  reason: string
  sourceMode?: 'fixed' | 'free' | 'articulated' | 'unknown'
  target?: RobotBaseBinding['target']
  worldFromBody?: RobotAnchorPose
  constraints: NativeRobotConstraint[]
  /** 源模型坐标→根基座的安装位姿；独立 IK 的模型帧换算只消费源元数据。 */
  modelFromBase?: RobotAnchorPose
  editable: { fixed: boolean; free: boolean; entity: boolean; reason?: string }
  /** 当前原生 Freeze 事实；未冻结时为 frozen:false（读回可确认范围/保持位姿/是否可恢复）。 */
  freeze?: RobotFreezeState
}
export interface RobotConfigurationIdentity {
  worldId: string; sceneId: string; entityId: string; expectedRevision: number; expectedGeneration: number
}
export interface RobotSetTcpInput extends RobotConfigurationIdentity { tcp?: RobotTcpDefinition; clear?: boolean }
export interface RobotSetBaseInput extends RobotConfigurationIdentity { base: RobotBaseBinding }
/**
 * R-012／§2.9：只读装配预览的四项身份输入。
 *
 * `sourceMount` 是源安装面在**源真实根 body**局部系中的变换：
 *  · `site`：源模型该 body 上的真实原生 site；
 *  · `body-origin`：该 body 原点（该 body 必须等于根，或已证实相对根只经固定关节相连）；
 *  · `pose`：用户显式保存/输入并在源根帧中表达的位姿。
 * `targetMount` 是目标安装位在**目标 body**局部系中的变换（真实 site / body 原点 / 显式局部 pose）。
 * 两者任一不明确就必须询问；不得默认 mesh 原点、质心或"手根"就是正确安装面。
 */
export type RobotSourceMount =
  | { kind: 'site'; bodyName: string; site: string }
  | { kind: 'body-origin'; bodyName: string }
  | { kind: 'pose'; pose: RobotAnchorPose }
export type RobotTargetMount =
  | { kind: 'site'; site: string }
  | { kind: 'body-origin' }
  | { kind: 'pose'; pose: RobotAnchorPose }
export interface RobotAssemblyPreviewInput {
  worldId: string
  sceneId: string
  expectedRevision: number
  expectedGeneration: number
  /** 源部件/实例（独立手或末端工具）实体。 */
  sourceEntityId: string
  sourceMount: RobotSourceMount
  /** 目标机器人实例。 */
  targetEntityId: string
  targetBodyName: string
  targetMount: RobotTargetMount
  /** T_pair：双方安装轴向的对接变换；省略时为单位阵。 */
  pair?: RobotAnchorPose
}
/** 已解析的安装面事实：显示名 + 真实 body + 该 body 局部系中的位姿。 */
export interface RobotMountFact {
  kind: 'site' | 'body-origin' | 'pose'
  label: string
  bodyName: string
  positionM: Vec3
  quaternionXyzw: Quaternion
}
/**
 * 只读预览结果：`applied:false` 明确表示未提交；`applyInput` 与手动 Apply 使用同一份
 * `robot_set_base` 入参，LLM 与手动因此共用一条提交路径。
 */
export interface RobotAssemblyPreviewResult {
  status: 'PREVIEW'
  applied: false
  sceneId: string
  worldId: string
  revision: number
  generation: number
  source: { entityId: string; name: string; rootBodyName: string }
  target: { entityId: string; name: string; bodyName: string }
  sourceMount: RobotMountFact
  /** 同一原生帧换算出的源安装面在**源根帧**中的位姿（公式里的 `T_sourceRoot_sourceMount`）。 */
  sourceMountInSourceRoot?: RobotAnchorPose
  targetMount: RobotMountFact
  pair: RobotAnchorPose
  /** `T_targetBody_sourceRoot`：源真实根在目标 body 局部系中的安装变换。 */
  targetBodyFromSourceRoot: RobotAnchorPose
  /** 预览所依据的真实原生帧身份（同 scene/revision/world/generation）。 */
  frame: { worldId: string; generation: number; sceneRevision: number; frameId?: string; stepIndex?: number }
  applyInput: RobotSetBaseInput
  notes: string[]
}
/**
 * 本批（R-014）把"Scene 已保存"与"原生已同步"分成两个独立事实：
 * 保存成功但 sync/对应 Frame 回读失败时，回执仍然成功（不是异常），并如实带出 saved/sync/revision/reason。
 * 调用方（UI 与 LLM）据此显示 "Assembly saved · Physics sync required"，而不是把已保存的版本丢掉。
 */
export type RobotBindingField = 'baseBinding' | 'controller.tcp'
export interface RobotAssemblyChange {
  sceneId: string
  entityId: string
  field: RobotBindingField
  /** 既有 SceneStore 历史中的完整快照版本号：before 是这次绑定变化前的那一版。 */
  beforeRevision: number
  /** 既有 SceneStore 历史中的完整快照版本号：after 是这次绑定变化落盘后的那一版。 */
  afterRevision: number
  /**
   * 该字段在这次变化前后的真实值。**该侧声明本来不存在时整个键省略**：既不写 `undefined`
   * （会让整份工具结果不是无损 JSON，被 SDK 判成 INVALID_TOOL_OUTPUT），也不写 `null`
   * （用户数据里的 `null` 是另一个真实值，两者不能混为一谈）。消费侧读缺键得到 `undefined`，
   * 与原来的语义相同；内部 Undo 不读这里，而是从历史快照用 `readBindingField` 读缺省并删除该字段。
   */
  before?: unknown
  after?: unknown
  /** 读取时当前版本是否仍等于 after 且实体/资源身份未变；否则本地 Undo 明确不可用。 */
  undoable: boolean
  reason?: string
  /** 该次过渡属于一次 Replace 时，给出同一 operationId 的窄装配成员标记（新旧双方同 operationId）。 */
  replace?: RobotAssemblyReplaceMembership
}
/** 一次 Replace 在实体 `components.assemblyReplace` 上留下的窄成员标记（同一 operationId 即同一次 CAS）。 */
export interface RobotAssemblyReplaceMembership {
  operationId: string
  role: 'new' | 'old'
  peerEntityId: string
  targetEntityId: string
  targetBodyName: string
}
/**
 * 一次 Replace（新旧双方同一 operationId）的成组 Undo 事实：由既有 Scene 版本历史发现，不新历史库。
 * `members` 列出的实体/字段都由同一次连续历史过渡的 before/after 受保护恢复。
 */
export interface RobotAssemblyReplacementGroup {
  operationId: string
  targetEntityId: string
  targetBodyName: string
  beforeRevision: number
  afterRevision: number
  members: Array<{ entityId: string; field: RobotBindingField; role: 'new' | 'old'; peerEntityId: string }>
  /** 每一方当前值仍等于该次 after 且资源身份未变才为 true；否则整组拒绝或明确冲突。 */
  undoable: boolean
  reason?: string
}
/**
 * 保存/sync/Frame 之后的机器人详情读回事实。CAS 已经落盘时 describe 失败**不会**回滚或抹掉
 * 保存回执：这里只如实报告详情不可用及原因，绝不伪造 robot 详情。
 */
export interface RobotDetailReadback {
  status: 'AVAILABLE' | 'UNAVAILABLE'
  reason?: string
}
export interface RobotConfigurationReceipt {
  status: 'UPDATED' | 'UNCHANGED'
  /** 恒为 true：Scene CAS 已成功落盘（提交前失败/过期 CAS 直接抛错，不产生本回执）。 */
  saved: true
  sync: 'SYNCED' | 'REQUIRED'
  syncRequired: boolean
  sceneId: string
  /** 已保存的 Scene 版本号；syncRequired 时这是"已保存但物理待同步"的那个版本。 */
  revision: number
  worldId?: string
  worldGeneration?: number
  appliedSceneRevision?: number
  entityId: string
  snapshot: SceneSnapshot
  world?: WorldHandle
  frame?: Frame
  /** describe 详情读回状态；`UNAVAILABLE` 只影响 robot 字段，不改变已保存/已同步事实。 */
  robotDetail?: RobotDetailReadback
  /** 命中绑定变化时给出既有历史中的 before/after 定位；仅真正写入且字段可定位时出现。 */
  assembly?: RobotAssemblyChange
  /** syncRequired/frame 过期时的准确原因（含错误码前缀）。 */
  reason?: string
}
export interface RobotAssemblyHistoryInput { sceneId: string; entityId: string; limit?: number }
export interface RobotAssemblyHistoryResult {
  sceneId: string
  entityId: string
  revision: number
  entries: RobotAssemblyChange[]
  /** 本次实际比对的既有历史版本数（0 且带 reason 表示历史不可用）。 */
  inspected: number
  /**
   * 被比对的相邻版本是否逐版连续。Scene 正常提交每次 +1；缺页时为 false，
   * 跨缺页的相邻版本不拼成一次变化，也不用于推断 before。
   */
  historyComplete: boolean
  reason?: string
  /** 本次窗口内发现的 Replace 成组（同一 operationId 的新旧双方），供重开后仍能整组 Undo。 */
  replacements?: RobotAssemblyReplacementGroup[]
  /** 本次窗口内发现的内部拆分/重组成对（同一 operationId 的 remaining/part），供重开后整组 Undo。 */
  subtreePartitions?: RobotSubtreePartitionGroup[]
}
export interface RobotAssemblyUndoInput {
  sceneId: string
  entityId: string
  expectedRevision: number
  /** 单字段形态必填；给 `changes` 时忽略这三项。 */
  field?: RobotBindingField
  beforeRevision?: number
  afterRevision?: number
  /** 可选：该 Scene 已打开的真实世界；不可用/未给出时只恢复声明并如实报待同步。 */
  worldId?: string
  /**
   * 可选：`worldId` 对应的期望世界代次。世界实际存在且代次不符时在 CAS 前拒绝（与其它 authoring 入口同一
   * `STALE_GENERATION` 语义），绝不把"显式过期的 world"当成"world 不可用"的离线恢复放行。
   */
  expectedGeneration?: number
  /** Replace 的一次 CAS 同时改了多个实体/字段：给出这一组条目时按各自 before 受保护恢复双方。 */
  changes?: RobotAssemblyUndoEntry[]
  /**
   * R-013：内部拆分/重组的成对局部 Undo。给出这次被撤销过渡的 before/after 版本号后，按既有
   * Scene 版本历史同时核对 remaining 与 part 的当前资源/绑定/标记，只在**成对受保护**时恢复
   * 本次拆分/重组涉及的字段与实体，保留后来无关编辑。
   */
  subtree?: { operationId?: string; beforeRevision: number; afterRevision: number }
}
export interface RobotAssemblyUndoEntry {
  entityId: string
  field: RobotBindingField
  beforeRevision: number
  afterRevision: number
}
/**
 * 源安装点的保存/复用（窄元数据，绑定 resourceId/version 与源根 body）。
 * 不建独立点数据库、不写 localStorage：只存在实体 `components.assemblyMount` 这一个窄面。
 */
export interface RobotSavedMount {
  resourceId: string
  resourceVersion: number
  rootBodyName: string
  mount: RobotSourceMount
}
export interface RobotAssemblyMountInput {
  sceneId: string
  entityId: string
  expectedRevision: number
  /** 保存/替换：给出要保存的源安装面。 */
  save?: RobotSourceMount
  /** 清除已保存点。与 save 互斥。 */
  clear?: boolean
  /** 源真实根 body 名；site/body-origin 可由 bodyName 推出，pose 必须显式给出。 */
  rootBodyName?: string
  /** 可选：给出真实世界时按 `robot_describe` 校验 site/body 确实存在；只读查询不需要。 */
  worldId?: string
  expectedGeneration?: number
}
export interface RobotAssemblyMountResult {
  sceneId: string
  entityId: string
  revision: number
  saved: boolean
  changed: boolean
  resourceId?: string
  resourceVersion?: number
  /** 变更落盘后的场景快照（只读查询时也给出当前快照），供调用方收口 revision。 */
  snapshot?: SceneSnapshot
  /** 当前资源的有效保存点；资源身份对不上时给出 stale:true 并说明。 */
  mount?: RobotSavedMount
  stale?: boolean
  reason?: string
}
/** 从 baseBinding 派生的挂接清单条目：saved 声明与当前 native 读回分开报告。 */
export interface RobotAttachmentEntry {
  entityId: string
  name: string
  saved: RobotBaseBinding
  native?: { bodyName?: string; worldFromBody?: RobotAnchorPose; targetWorldFromTargetBody?: RobotAnchorPose; generation: number; sceneRevision: number; frameId?: string }
  reason?: string
}
export interface RobotAssemblyCheckInput {
  sceneId: string
  entityId: string
  worldId?: string
  expectedGeneration?: number
  contacts?: boolean
  actionId?: string
}
/** 真实检查/读回：只有读到真实依据才把对应 `checked.*` 置 true，缺运动证据显示未检查。 */
export interface RobotAssemblyCheckResult {
  sceneId: string
  entityId: string
  revision: number
  savedBinding?: RobotBaseBinding
  frame?: { worldId: string; generation: number; sceneRevision: number; frameId?: string; stepIndex?: number }
  nativeBase?: { bodyName?: string; worldFromBody?: RobotAnchorPose }
  relativePose?: RobotAnchorPose
  joints?: { count: number; names: string[]; positions: number[] }
  contacts?: unknown
  actionReceipt?: unknown
  attachments: RobotAttachmentEntry[]
  checked: { binding: boolean; relativePose: boolean; joints: boolean; contacts: boolean; actionReceipt: boolean; attachments: boolean }
  notes: string[]
  reason?: string
}
/**
 * Replace：对**已是独立外部实体**的旧末端做一次窄多实体 CAS——新末端固定到目标 body，
 * 旧末端按当前 native world pose 固定留置（或明确 free），一次 commit、一次 sync。
 */
export interface RobotAssemblyReplaceInput {
  sceneId: string
  worldId: string
  expectedRevision: number
  expectedGeneration: number
  newEntityId: string
  newBase: RobotBaseBinding
  oldEntityId: string
  /**
   * 旧末端的**明确停放去向**（世界系、米/归一化 xyzw）：本批采用"离开挂载位的固定停放 pose"，
   * 不能默认停在旧件当前所在（= 新件要占用）的安装位。`oldFree:true` 时该 pose 作为解除固定后的
   * 初始世界位姿，同样必须明确给出。缺省即拒绝写入，不猜一个会让新旧叠件的默认值。
   */
  oldParkingPose?: RobotAnchorPose
  oldFree?: boolean
  oldBodyName?: string
}
export interface RobotAssemblyReplaceResult {
  status: 'UPDATED' | 'UNCHANGED'
  saved: true
  sync: 'SYNCED' | 'REQUIRED'
  syncRequired: boolean
  sceneId: string
  revision: number
  worldId?: string
  worldGeneration?: number
  appliedSceneRevision?: number
  snapshot: SceneSnapshot
  /** 同一次 CAS 前后受保护恢复的双方字段。 */
  changes: RobotAssemblyChange[]
  world?: WorldHandle
  frame?: Frame
  reason?: string
}
/**
 * R-013／§2.10 具名几何拆分派生：一个内部 body 子树被真实移除/提取后两侧的来源身份。
 * `remaining` 是源资源 id 的新版本（切掉子树），`part` 是可独立加载的新资源。同一 `operationId` 成对。
 * 记录切口身份（body/父/切口关节）、源入口 SHA、两侧资源版本与真实 DOF/驱动数、切口位姿与关节映射，
 * 供重组与受保护局部 Undo 在重开后核对来源；它不是路径重写，也不覆盖任何旧版本。
 */
export interface RobotSubtreeDerivationRecord {
  kind: 'subtree-extract'
  operationId: string
  format: 'mjcf' | 'urdf'
  sourceResourceId: string
  sourceVersion: number
  sourceSha256: string
  cutBody: string
  cutBodyParent: string
  cutJoint?: { name: string; parent: string; type: string }
  remaining: { resourceId: string; version: number; nq: number; nu: number; ntendon: number; neq: number }
  part: { resourceId: string; version: number; entityId: string; nq: number; nu: number; ntendon: number; neq: number }
  /** 切口在源真实根帧中的安装位姿（拆分时取自同一 native frame）；重组恢复用。 */
  cutPoseInSourceRoot?: RobotAnchorPose
  jointMap: { partJoints: string[]; remainingJoints: string[]; cutJoints: string[] }
  /**
   * 真实派生名映射（来自原生 helper 对**重载后**两侧模型的枚举，不按前缀猜）：
   * source→derived 的 body/joint/actuator/site。切口关节被移除时不写该条（消费侧按未映射处理）。
   * 控制器迁移、TCP/挂接引用与运行事实都以它为准，映射缺失即具名拒绝或失效。
   */
  nameMap?: { part: RobotSubtreeNameMap; remaining: RobotSubtreeNameMap }
  at: string
}
/** 真实派生名映射：全部是原生重载核对过的 source→derived 名，只收两侧都存在的条目。 */
export interface RobotSubtreeNameMap {
  bodies: Record<string, string>
  joints: Record<string, string>
  actuators: Record<string, string>
  sites: Record<string, string>
}
/** 实体 `components.subtreeExtract` 上的窄成对标记（remaining/part 同 operationId）。 */
export interface RobotSubtreeMarker {
  operationId: string
  role: 'remaining' | 'part'
  peerEntityId: string
  derivation: RobotSubtreeDerivationRecord
  /**
   * 拆分时被迁移/失效、重组需要恢复的字段原值（只记 remaining 侧）：`originalController` 是拆分前
   * 的 controller，`remainingController` 是拆分后的 controller；重组时只在当前 controller 仍等于
   * 拆后值（用户没改过）时恢复原值，否则保留用户改动并给冲突说明。
   * `invalidated` 列出因切口关节被移除而具名清理掉的控制器条目（如 `jointKp.j2`），不留不可驱动残项。
   */
  migrated?: { originalController?: Record<string, unknown>; remainingController?: Record<string, unknown>; originalAssemblyMount?: Record<string, unknown>; invalidated?: string[] }
}
export interface RobotSubtreePrecheckInput { sceneId: string; entityId: string; bodyName: string }
/** 只读预检结果：两侧清单 + 闭包 + 跨切口引用；`supported=false` 时零 Scene/资源写入。 */
export interface RobotSubtreePrecheckResult {
  sceneId: string
  entityId: string
  revision: number
  source: { resourceId: string; version: number; sha256: string; format: string; path: string }
  selectedBody: string
  selectedBodyParent: string
  supported: boolean
  subtree: { bodies: string[]; joints: string[]; cutJoints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[]; meshes: number; textures: number }
  remaining: { bodies: string[]; joints: string[]; actuators: string[]; tendons: string[]; equalities: string[]; sensors: string[] }
  closure: { meshFiles: string[]; textureFiles: string[]; copiedBytes: number }
  crossEdges: Array<{ kind: string; name: string; reason: string; references?: Array<{ kind: string; name: string }> }>
  warnings: Array<Record<string, unknown>>
  reason?: string
}
export interface RobotSubtreeExtractInput {
  sceneId: string
  entityId: string
  /** 选中的**内部真实 body**（来自 robot_describe.nativeBodies）；不是 mesh 名或概念图 link。 */
  bodyName: string
  /** 可选身份：给出时在拆分前核对当前场景/原生代次与资源身份。 */
  expectedRevision?: number
  expectedGeneration?: number
  worldId?: string
  /** 可选：独立件实体 id/名称；省略时由实现分配。 */
  partEntityId?: string
  partName?: string
}
export interface RobotSubtreeExtractResult {
  status: 'UPDATED'
  saved: true
  sync: 'SYNCED' | 'REQUIRED'
  syncRequired: boolean
  sceneId: string
  revision: number
  worldId?: string
  remainingEntityId: string
  partEntityId: string
  derivation: RobotSubtreeDerivationRecord
  precheck: RobotSubtreePrecheckResult
  snapshot: SceneSnapshot
  world?: WorldHandle
  frame?: Frame
  reason?: string
}
export interface RobotSubtreeReassembleInput {
  sceneId: string
  entityId: string
  /** 可选：指定成对 operationId；省略时按实体上的成对标记读取。 */
  operationId?: string
  expectedRevision?: number
  expectedGeneration?: number
  worldId?: string
}
export interface RobotSubtreeReassembleResult {
  status: 'UPDATED'
  saved: true
  sync: 'SYNCED' | 'REQUIRED'
  syncRequired: boolean
  sceneId: string
  revision: number
  worldId?: string
  remainingEntityId: string
  partEntityId: string
  /** 重组后 remaining 实体恢复到的原始资源引用。 */
  restoredResource: { resourceId: string; version: number }
  snapshot: SceneSnapshot
  world?: WorldHandle
  frame?: Frame
  reason?: string
}
/**
 * 一次内部拆分的成对历史事实（同 operationId 的 remaining/part 双方），由既有 Scene 版本历史发现。
 * `role` 区分这次过渡是"拆分"还是"重组"；`undoable` 要求双方当前仍等于该次 after 且未被实质改动。
 */
export interface RobotSubtreePartitionGroup {
  operationId: string
  role: 'extract' | 'reassemble'
  remainingEntityId: string
  partEntityId: string
  beforeRevision: number
  afterRevision: number
  derivation?: RobotSubtreeDerivationRecord
  undoable: boolean
  reason?: string
}
/** TCP body 偏移只是对同帧 body 的刚体坐标换算，不重算机器人 FK。 */
export function nativePoseInFrame(frame: Frame | undefined, entityId: string, bodyName: string): RobotAnchorPose | undefined {
  const bodies = frame?.entities.find(entity => entity.entityId === entityId)?.sensors?.bodyWorldPoses as Record<string, RobotAnchorPose> | undefined
  const pose = bodies?.[bodyName] ?? bodies?.[`${entityId}/${bodyName}`]
  return validRobotPose(pose) ? pose : undefined
}
export function validRobotPose(value: unknown): value is RobotAnchorPose {
  const pose = value as RobotAnchorPose | undefined
  return Boolean(pose && Array.isArray(pose.positionM) && pose.positionM.length === 3 && Array.isArray(pose.quaternionXyzw) && pose.quaternionXyzw.length === 4 && [...pose.positionM, ...pose.quaternionXyzw].every(Number.isFinite) && Math.abs(Math.hypot(...pose.quaternionXyzw) - 1) < 1e-4)
}
