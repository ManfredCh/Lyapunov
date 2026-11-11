import type { Quaternion, Vec3 } from './types.ts'
/** 人体定义属于Scene/Resource；单位米、右手Z-up。原始骨名由映射显式绑定，不按显示名称猜测。 */
export interface HumanRigJoint { name: string; parent?: string; offsetM: Vec3; quaternionXyzw: Quaternion }
export interface HumanRotationTrack { joint: string; timesS: number[]; rotationsXyzw: Quaternion[]; interpolation: 'LINEAR' | 'STEP' }
export interface HumanTranslationTrack { joint: string; timesS: number[]; positionsM: Vec3[]; interpolation: 'LINEAR' | 'STEP' }
export interface HumanClip { name: string; durationS: number; tracks: HumanRotationTrack[]; translations?: HumanTranslationTrack[]; rootMotion?: { joint: string; horizontal: 'remove' | 'remove-drift'; baselineM: Vec3; driftM?: Vec3 }; channelReport?: { total: number; rotations: number; translations: number; normalizedUnitScales: number; maxUnitScaleDeviation: number } }
/** Isaac IRA 官方行为的最小显式配置；route 仍由既有米制 points/speed 提供，不另建规划。 */
export interface HumanIraConfig {
  /** 官方角色 seed；整数。场景持久化后重开按同值复现。 */
  seed: number
  /** 区域停留边界，米、世界坐标（Z-up）；进入检查使用上一原生状态到本帧。 */
  region: { min: Vec3; max: Vec3 }
  /** 官方 CharacterStopBehavior 的停留时长，秒；正有限数。 */
  dwellS: number
}
export interface HumanComponent {
  schema: 1
  mode: 'kinematic' | 'ragdoll'
  collision: 'detailed' | 'coarse'
  /** 可选：仅在已加载 IRA SDK/资产的 Isaac world 中走官方行为；普通 GLB 路线不变。 */
  ira?: HumanIraConfig
  /** 共享定义在同Scene的资源投影实体；实例省略rig/clip。 */
  definition?: { entityId: string; resourceId: string; version: number }
  rig?: HumanRigJoint[]
  /** 语义→原件骨名。分段碰撞端点只引用这些已存在的骨。 */
  boneMapping?: Record<string, string>
  clips?: HumanClip[]
  source: { kind: 'procedural' | 'rigged-glb'; license: string; attribution?: string; sha256?: string; sourceUpAxis: 'Y' | 'Z'; metersPerUnit?: number; headingOffsetRad?: number }
  /** 外部角色显式鞋部校准；端点以frameJoint的规范骨局部米制表示，不抬实体根或改其余分段。 */
  footCollision?: { schema: 1; sourceSha256: string; method: string; segments: Partial<Record<'leftAnkle-leftToe'|'rightAnkle-rightToe', { frameJoint: string; endpointsM: [Vec3,Vec3]; radiusM: number }>> }
  heightM: number
  phase: number
  route?: HumanRoute
}
export interface HumanPlanarNavigation { bounds: { min: [number,number]; max: [number,number] }; cellSizeM?: number; clearanceM?: number }
export interface HumanRoute { navigation?: HumanPlanarNavigation; pointsM: Vec3[]; speedMps: number; behavior: 'walk' | 'run' | 'stand'; loop?: boolean; dwellS?: number; yieldToHumans?: boolean; avoidanceRadiusM?: number; avoidObstacles?: boolean; turnRateRadps?: number; clip?: string }
/** 有界动作由Sim物理tick消费；没有第二套墙钟。ragdoll只受力/自由运动，不冒充稳定控制器。 */
export interface HumanMotion { kind: 'human'; entityId: string; durationS: number; route?: HumanRoute; forceN?: Vec3 }
export interface HumanPose {
  source: 'mujoco-body' | 'mujoco-site' | 'isaac-body'
  mode: HumanComponent['mode']
  /** 与外层Frame同一物理步。目标与原生读数分开，Viewer只使用原生读数。 */
  simTime: number; stepIndex: number
  joints: Array<{ name: string; positionM: Vec3; quaternionXyzw: Quaternion }>
  segments: Array<{ name: string; positionM: Vec3; quaternionXyzw: Quaternion; radiusM: number; halfLengthM: number }>
  motion?: { behavior: string; clip?: string; distanceM: number; yielded: boolean; blockedByGeom?: string | null; blockedS?: number; navigation?: { status: 'planned' | 'blocked'; source: 'mujoco-compiled-aabb'; reason?: string; expandedNodes?: number; segments?: number; planeZ?: number; clearanceM?: number; replans?: number }; ira?: { enabled: boolean; task?: string; speedMps?: number; regionEntered: boolean; event: string; eventCount: number } }
  target?: { rootPositionM: Vec3; rootYawRad: number }
}

export type HumanDefinition = HumanComponent & { rig: HumanRigJoint[]; boneMapping: Record<string,string>; clips: HumanClip[] }
