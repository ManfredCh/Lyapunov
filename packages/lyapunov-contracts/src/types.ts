/** 共享值以米、弧度、秒及右手 Z-up 表达；引擎对象不得进入这些类型。 */
export type Vec3 = [number, number, number]
export type Quaternion = [number, number, number, number]
export interface Transform { position: Vec3; quaternion: Quaternion; scale: Vec3 }
/** Scene 相机的安装声明；bodyName 是 entityId 内精确的原生 body/link 名，位姿为 body 局部米及 xyzw。 */
export interface SceneCameraMount { entityId: string; bodyName: string; positionM: Vec3; quaternionXyzw: Quaternion }
/** 安装基线随Scene保存；来源说明不替代引擎实际读回。 */
export interface SceneCameraInstallation {
  source: 'current-view' | 'manual' | 'mjcf' | 'urdf' | 'usd' | 'scene-baseline'
  sourceCameraName?: string
  baseline: { positionM: Vec3; quaternionXyzw: Quaternion; mount?: SceneCameraMount; fovYDeg: number; width: number; height: number; near: number; far: number; intrinsics: NonNullable<SceneCameraComponent['intrinsics']> }
}
/** 相机声明属于 Scene；无 mount 使用实体世界 TRS，有 mount 只使用明确的 body 局部安装位姿。 */
export interface SceneCameraComponent {
  name?: string; fovYDeg: number; width?: number; height?: number; near?: number; far?: number; isActive?: boolean
  intrinsics?: { fx: number; fy: number; cx: number; cy: number; width: number; height: number }
  mount?: SceneCameraMount
  installation?: SceneCameraInstallation
}
export interface Representation { uri: string; mimeType: string; role?: string; losses?: string[] }
export interface ResourceRef {
  resourceId: string
  version: number
  original: Representation
  representations: Representation[]
  source: { units: string; upAxis: "X" | "Y" | "Z"; handedness: "right" | "left"; metersPerUnit?: number }
}
export interface Entity {
  entityId: string
  parentId?: string
  name: string
  /** 锁定只阻止变换和重挂父节点；显隐、解锁与明确删除仍可提交。 */
  locked?: boolean
  transform: Transform
  resources: ResourceRef[]
  components: {
    visual?: Record<string, unknown>
    collision?: Record<string, unknown>
    rigidBody?: Record<string, unknown>
    articulation?: Record<string, unknown>
    controller?: Record<string, unknown>
    sensor?: Record<string, unknown>
    [namespace: string]: unknown
  }
}
/** 世界物理配置属于Scene版本；参数以世界米/秒表达，不属于Viewer本地设置。 */
export interface ScenePhysicsSettings {
  gravityWorldMps2: Vec3
  template?: 'blank' | 'physics-workspace-v1' | 'physics-workspace-v2'
  groundEntityId?: string
  /** 删除/禁用是持久选择，首次建世界及重开不得暗中恢复地面。 */
  groundState?: 'present' | 'removed' | 'disabled'
}
export interface WorldPhysicsSnapshot {
  gravityWorldMps2: Vec3
  gravityEnabled: boolean
  units: 'm/s^2'
  source: 'mujoco-model' | 'isaac-physics-scene' | 'newton-model'
  groundSources: Array<{ source: 'scene' | 'native-plane' | 'explicit-legacy'; entityId?: string; geomNames: string[] }>
  collisionCoverage: { status: 'NONE' | 'PARTIAL' | 'COMPLETE'; physicalEntityIds: string[]; visualOnlyEntityIds: string[] }
}
export interface SceneSnapshot {
  sceneId: string
  revision: number
  coordinates: { units: "m"; upAxis: "Z"; handedness: "right"; quaternion: "xyzw" }
  entities: Entity[]
  physics?: ScenePhysicsSettings
}
export type ScenePatch = Array<
  | { op: "add"; entity: Entity }
  | { op: "remove"; entityId: string; cascade?: boolean }
  | { op: "update"; entityId: string; changes: Partial<Omit<Entity, "entityId" | "parentId">> }
  | { op: "reparent"; entityId: string; parentId?: string }
>
export interface SceneCommit { sceneId: string; expectedRevision: number; patch: ScenePatch; physics?: ScenePhysicsSettings }
/** Provider 编译告警（只做加法，旧 Provider 可省略）。典型 code：ENTITY_SKIPPED_NO_COLLISION。 */
export interface WorldWarning {
  code: string
  /** 与告警相关的实体；非实体级告警可省略。 */
  entityId?: string
  message: string
}
export * from './context-envelope.ts'
export * from './session-world-projection.ts'

export interface WorldHandle {
  worldId: string; sceneId: string; engineId: string; engineVersion: string
  worldGeneration: number; appliedSceneRevision: number
  /** 旧持久句柄可省略；当前 Provider 应报告实际时钟及物理步长。 */
  clock?: 'realtime' | 'manual'; timestepS?: number
  status: "ready" | "running" | "paused" | "unsynced" | "unavailable" | "closed"
  /** 最近一次成功编译的告警（无告警为空数组）：如纯视觉实体没有碰撞体被物理装配跳过。 */
  warnings?: WorldWarning[]
  /** 实际模型/PhysicsScene读回；安装候选或Scene声明本身不能填充此字段。 */
  worldPhysics?: WorldPhysicsSnapshot
  supportsPause?: boolean
  /**
   * 该世界用于接触标签的地面几何名（MuJoCo／Isaac／Newton 三个 Provider 都产出，名字空间与各自 contacts 标签一致）：
   * MuJoCo 是自带平面 `__ground` + 源声明地面 geom 的 `<实体前缀><geom名>`，Isaac／Newton 是各自解析出的地面名。
   * `ground:false` 且源模型没有地面 geom 时为空数组（如实为空，不塞默认值）。
   */
  groundGeomNames?: string[]
  /**
   * Provider 在 worker `ready` 事件里自报的能力表（**原样**保留，未做任何转换或裁剪）：provider 级的能力与
   * 不支持项表，结构由各 Provider 自己定义（Newton 第一切片见 `sim-newton/python/worker.py` 的 `CAPABILITIES`：
   * engine/slice/supported/unsupported/notes）。与 `RobotDescription.capabilities`（逐实体 `RobotCapability[]`）
   * 不是一回事；当前只有 Newton 的 ready 会自报，MuJoCo／Isaac 不出现该键。
   */
  capabilities?: Record<string, unknown>
  /** 仅 Newton：解析出的真实设备标识（`cpu` 或 `cuda:N`）。 */
  device?: string
  /** 仅 Newton：设备类别（`resolve_device` 的封闭取值）。 */
  deviceKind?: 'cpu' | 'cuda'
  /** 仅 Newton：是否发生了设备降级（如 `auto` 下没有可用 CUDA 而降级到 cpu）。 */
  deviceDegraded?: boolean
  /** 仅 Newton：设备选择／降级的说明文本。 */
  deviceNote?: string
  /** 仅 Newton：本次世界实际使用的求解器（`LYAPUNOV_NEWTON_SOLVER` 只接受这两个值）。 */
  solver?: 'semi' | 'xpbd'
  /** 仅 Newton：Warp 运行时版本。 */
  warpVersion?: string
}
/** 该实体的实测肌腱坐标（引擎自身缓存 ten_length/ten_velocity，不用关节角重算代替）。 */
export interface TendonObservation { names: string[]; lengths: number[]; velocities: number[] }
export interface EntityObservation {
  entityId: string; transform: Transform
  /** 当前原生编译产物的刚体事实；缺此字段不推断物理已就绪。 */
  physics?: { source: 'mujoco-compiled' | 'isaac-compiled'; dynamic: boolean; massKg: number | null; gravityEnabled: boolean; collisionEnabled: boolean; colliderCount: number; bodyName?: string }
  joints?: { names: string[]; positions: number[]; velocities: number[] }
  /**
   * 被肌腱驱动的实体额外给出的实测肌腱坐标（fixed tendon 为 Σ coef·q，spatial tendon 为引擎几何长度；
   * 逐条关节/系数/单位见 robot_describe 的 tendonActuators）。没有 tendon 的实体不出现该字段。
   * 肌腱不是关节：它们只出现在这个顶层字段里，不混入 joints。
   */
  tendons?: TendonObservation
  sensors?: Record<string, unknown>
}
export interface ContactObservation {
  geom1: string; geom2: string; distanceM?: number; forceN?: number[]
  positionM?: Vec3; normal?: Vec3; sourceStep?: number; persistent?: boolean
}
/** 穿透 geom 对聚合（distanceM < 0），按该对的实测最小 dist 记录。 */
export interface PenetrationPair {
  geom1: string; geom2: string; geom1Id: number; geom2Id: number; minDistanceM: number
}
/**
 * contacts 观测的穿透聚合：count 是本帧发生穿透（负 dist）的 geom 对数量，
 * worst 按 minDistanceM 升序给出最严重的若干对，供调用方纠正初始穿模；无穿透时 count=0、worst=[]。
 */
export interface PenetrationSummary { count: number; worst: PenetrationPair[] }
export interface Frame {
  worldId: string; generation: number; stepIndex: number; simTime: number
  /** 原生时钟的实际状态，不从旧step数或按钮可用性推断运行中。 */
  worldStatus?: WorldHandle['status']
  worldPhysics?: WorldPhysicsSnapshot
  /** 同一原生观察步的相机快照；字段沿 camera_list，每行携带本帧身份，Viewer 只投影此事实。 */
  cameras?: Array<Record<string, unknown>>
  /** 初始接触读回；UNVERIFIED 保留未进行原生检查的事实，不能由视觉包围盒替代。 */
  initialOverlap?: { source: 'mujoco-compiled' | 'isaac-contact-report' | 'isaac-scene-query'; checkedAtStep: number; sceneRevision: number; status: 'CLEAR' | 'OVERLAP' | 'UNVERIFIED'; pairs: Array<{ geom1: string; geom2: string; entity1?: string; entity2?: string; depthM: number | null; depthStatus?: 'UNKNOWN' }>; reason?: string }
  /** Provider revision that produced this frame. Older persisted frames may omit it. */
  sceneRevision?: number
  /**
   * 本 world 生命周期内真实辅助写回的累计次数：每个模拟 tick 对每个附着对象实际写回一次 qpos/qvel 才 +1。
   * 只反映真实推进——attach/release 调用本身、以及两次调用之间没有发生模拟 tick 的情形都不递增。
   * 消费方只能比较同一 world/generation 两帧的差值；旧持久化帧或旧 Provider 可省略（缺失时不作推断）。
   */
  assistAdvanceCount?: number
  frameId: string; entities: EntityObservation[]
  contacts?: ContactObservation[]
  /** 请求 contacts 时随帧给出的穿透聚合；旧 Provider 可省略。 */
  penetrations?: PenetrationSummary
  /**
   * 本帧状态是怎么产生的（封闭两值）：`physical-contact` = 真实物理推进；`assisted-teleport` = 本帧仍有辅助
   * 附着写回（`sim_assist` attach 生效期间）。三个 Provider 的 `observe()` **每帧都写**
   * （`sim-isaac/python/worker.py:461`、`sim-mujoco/python/worker.py:1696`、`sim-newton/python/worker.py:600`；
   * Newton 本切片没有辅助通道，恒为 `physical-contact`）。旧持久化帧或旧 Provider 可省略，缺失时下游按
   * `unknown` 处理（`robot-workflows` 的 `executionModeOf` 正是这个口径），不得当成 `physical-contact`。
   */
  executionMode?: 'assisted-teleport' | 'physical-contact'
  /**
   * 仅 Newton：产生本帧的真实设备标识（`cpu` 或 `cuda:N`，与 `WorldHandle.device` 同源）。
   * Newton 的 `observe()` 每帧都写（`sim-newton/python/worker.py:602`）；MuJoCo／Isaac 的帧不出现该键。
   */
  device?: string
  /** 用户主动查看时提供的实际引擎碰撞数据；没有此项不以视觉包围盒代替。 */
  collisionTopology?: CollisionTopology
}
export interface ColliderGeometry {
  kind:"box"|"sphere"|"capsule"|"cylinder"|"ellipsoid"|"plane"|"convex-hull"|"triangle-mesh"|"unsupported"
  sizeM:Vec3
  vertices?:number[]
  indices?:number[]
  infinite?:boolean
  reason?:string
}
export interface CollisionTopology {
  source:"mujoco-compiled"|"isaac-compiled"
  worldId:string
  generation:number
  sceneRevision:number
  stepIndex:number
  geoms:Array<{geomId:number;name:string;entityId?:string;ground:boolean;positionM:Vec3;quaternionXyzw:Quaternion;geometry?:ColliderGeometry;collisionEnabled?:boolean;collisionMask?:{contype:number;conaffinity:number;explicitPair:boolean};filteredPairs?:string[];contactOffsetM?:number;restOffsetM?:number;dynamic?:boolean}>
  omitted:number
  geometryIncluded:boolean
}
export type Observation = Frame
export interface MotionPlan {
  planId: string; entityId: string; modelVersion: string; jointNames: string[]
  points: Array<{ timeS: number; positions: number[] }>
  collisionContextVersion: string; expectedGeneration: number
}
export interface GraspCandidate {
  candidateId: string; provider: string; entityId: string; frameId: string
  tcpPose: { position: Vec3; quaternion: Quaternion }
  widthM: number; approach: Vec3; score: number; scoreKind: string
}
export interface ActionReceipt {
  actionId: string; worldId: string; generation: number
  status: "accepted" | "running" | "completed" | "failed" | "cancelled"
  startStep?: number; endStep?: number; finalState?: Observation
  effect?: Record<string, unknown>; taskAchieved?: boolean; reason?: string
}
export const SCENE_COORDINATES = { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" } as const
export function identityTransform(): Transform {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }
}

// ---- scene-geometry：视觉 splat 与其同步生成的碰撞网格的绑定合同（移植自 History scene-collision/contracts.ts） ----

/** 列主序 4x4 矩阵，只表达 mesh→splat 配准，不含场景摆放变换。 */
export type Matrix4Elements = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

export type SceneMeshAlignmentStatus = "candidate" | "user-confirmed" | "machine-verified" | "stale"

export interface SceneGeometryAssetRef {
  path: string
  sha256: string
}

/** 资源库持久合同：一个视觉 splat 与它的几何/碰撞来源网格的配对记录。 */
export interface SceneGeometryBinding {
  splat: SceneGeometryAssetRef
  mesh: SceneGeometryAssetRef
  meshToSplat: Matrix4Elements
  alignmentStatus: SceneMeshAlignmentStatus
  method: string
  revision: string
  verifiedAt?: number
  residualMeters?: number
}

/** splat 实体 components.collision 的网格碰撞声明；字节由同实体 ResourceRef 上 role:"collision" 的派生表示提供。 */
export interface SceneMeshCollisionComponent {
  shape: "mesh"
  frame: "mujoco-z-up-meters"
  binding: SceneGeometryBinding
}

export type SceneCollisionAlignmentBlockReason =
  | "binding_missing"
  | "binding_invalid"
  | "splat_path_mismatch"
  | "mesh_path_mismatch"
  | "alignment_candidate"
  | "alignment_stale"

export type SceneCollisionAlignmentGate =
  | { ok: true; binding: SceneGeometryBinding }
  | { ok: false; reason: SceneCollisionAlignmentBlockReason; message: string }

const SCENE_GEOMETRY_SHA256 = /^[0-9a-f]{64}$/

function isSceneGeometryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sceneGeometryWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const path = value.trim()
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) return
  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return
  return path
}

function sceneGeometrySha256(value: unknown): string | undefined {
  if (typeof value !== "string" || !SCENE_GEOMETRY_SHA256.test(value)) return
  return value
}

function sceneGeometryMatrix4(value: unknown): Matrix4Elements | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 16 ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    return
  }
  return [...value] as unknown as Matrix4Elements
}

function sceneGeometryAssetRef(value: unknown): SceneGeometryAssetRef | undefined {
  if (!isSceneGeometryRecord(value)) return
  const path = sceneGeometryWorkspacePath(value.path)
  const hash = sceneGeometrySha256(value.sha256)
  if (!path || !hash) return
  return { path, sha256: hash }
}

/** 严格解码不可信的资源库 JSON，不保留引用别名。 */
export function parseSceneGeometryBinding(value: unknown): SceneGeometryBinding | undefined {
  if (!isSceneGeometryRecord(value)) return
  const splat = sceneGeometryAssetRef(value.splat)
  const mesh = sceneGeometryAssetRef(value.mesh)
  const meshToSplat = sceneGeometryMatrix4(value.meshToSplat)
  const status = value.alignmentStatus
  const method = typeof value.method === "string" ? value.method.trim() : ""
  const revision = sceneGeometrySha256(value.revision)
  if (
    !splat ||
    !mesh ||
    !meshToSplat ||
    (status !== "candidate" && status !== "user-confirmed" && status !== "machine-verified" && status !== "stale") ||
    !method ||
    !revision
  ) {
    return
  }
  const verifiedAt = value.verifiedAt
  if (verifiedAt !== undefined && (typeof verifiedAt !== "number" || !Number.isInteger(verifiedAt) || verifiedAt < 0)) {
    return
  }
  const residualMeters = value.residualMeters
  if (
    residualMeters !== undefined &&
    (typeof residualMeters !== "number" || !Number.isFinite(residualMeters) || residualMeters < 0)
  ) {
    return
  }
  return {
    splat,
    mesh,
    meshToSplat,
    alignmentStatus: status,
    method,
    revision,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(residualMeters === undefined ? {} : { residualMeters }),
  }
}

/** 只有可信绑定（machine-verified / user-confirmed）才允许进入物理；候选与过期一律拒绝。 */
export function sceneCollisionAlignmentGate(input: {
  binding: SceneGeometryBinding | undefined
  splatPath?: string
  meshPath?: string
}): SceneCollisionAlignmentGate {
  const binding = input.binding
  if (!binding) {
    return { ok: false, reason: "binding_missing", message: "当前背景没有可验证的 splat/mesh 几何绑定" }
  }
  if (input.splatPath && binding.splat.path !== input.splatPath) {
    return { ok: false, reason: "splat_path_mismatch", message: "对齐记录不属于当前 3DGS 资产" }
  }
  if (input.meshPath && binding.mesh.path !== input.meshPath) {
    return { ok: false, reason: "mesh_path_mismatch", message: "对齐记录不属于当前 mesh 资产" }
  }
  if (binding.alignmentStatus === "candidate") {
    return { ok: false, reason: "alignment_candidate", message: "mesh 仍是待确认候选，尚不能用于物理放置" }
  }
  if (binding.alignmentStatus === "stale") {
    return { ok: false, reason: "alignment_stale", message: "mesh 对齐已失效，需要重新检查并确认" }
  }
  return { ok: true, binding }
}

export function userConfirmedSceneGeometryBinding(
  binding: SceneGeometryBinding,
  verifiedAt: number,
): SceneGeometryBinding {
  if (!Number.isFinite(verifiedAt) || verifiedAt < 0)
    throw new Error("verifiedAt must be a non-negative finite timestamp")
  return {
    ...binding,
    splat: { ...binding.splat },
    mesh: { ...binding.mesh },
    meshToSplat: [...binding.meshToSplat] as unknown as Matrix4Elements,
    alignmentStatus: "user-confirmed",
    method: "manual-three-point-overlay",
    verifiedAt,
    residualMeters: undefined,
  }
}

export function sceneGeometrySourceKey(
  binding: SceneGeometryBinding,
  sceneTransform?: {
    position: readonly [number, number, number]
    rotation: readonly [number, number, number]
    scale: number
  },
): string {
  const finite = (value: number) => {
    if (!Number.isFinite(value)) throw new Error("scene transform must contain finite values")
    return Object.is(value, -0) ? "0" : value.toPrecision(15)
  }
  const transform = sceneTransform
    ? [...sceneTransform.position, ...sceneTransform.rotation, sceneTransform.scale].map(finite).join(",")
    : "identity"
  return `${binding.mesh.sha256}:${binding.revision}:${transform}`
}
