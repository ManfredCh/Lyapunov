import type { Quaternion, Vec3 } from './types.ts'
/** 人体定义属于Scene/Resource；单位米、右手Z-up。原始骨名由映射显式绑定，不按显示名称猜测。 */
export interface HumanRigJoint { name: string; parent?: string; offsetM: Vec3; quaternionXyzw: Quaternion }
export interface HumanRotationTrack { joint: string; timesS: number[]; rotationsXyzw: Quaternion[]; interpolation: 'LINEAR' | 'STEP' }
export interface HumanTranslationTrack { joint: string; timesS: number[]; positionsM: Vec3[]; interpolation: 'LINEAR' | 'STEP' }
export interface HumanClip { name: string; durationS: number; tracks: HumanRotationTrack[]; translations?: HumanTranslationTrack[]; rootMotion?: { joint: string; horizontal: 'remove' | 'remove-drift'; baselineM: Vec3; driftM?: Vec3 }; channelReport?: { total: number; rotations: number; translations: number; normalizedUnitScales: number; maxUnitScaleDeviation: number } }
export interface HumanComponent {
  schema: 1
  mode: 'kinematic' | 'ragdoll'
  collision: 'detailed' | 'coarse'
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
  motion?: { behavior: string; clip?: string; distanceM: number; yielded: boolean; blockedByGeom?: string | null; blockedS?: number; navigation?: { status: 'planned' | 'blocked'; source: 'mujoco-compiled-aabb'; reason?: string; expandedNodes?: number; segments?: number; planeZ?: number; clearanceM?: number; replans?: number } }
  target?: { rootPositionM: Vec3; rootYawRad: number }
}

export type HumanDefinition = HumanComponent & { rig: HumanRigJoint[]; boneMapping: Record<string,string>; clips: HumanClip[] }
