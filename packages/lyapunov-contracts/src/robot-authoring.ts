import type { Frame, Vec3, Quaternion } from './types.ts'

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
export interface NativeRobotConstraint {
  name: string; kind: string; active: boolean; bodyName?: string; targetEntityId?: string; targetBodyName?: string
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
}
export interface RobotConfigurationIdentity {
  worldId: string; sceneId: string; entityId: string; expectedRevision: number; expectedGeneration: number
}
export interface RobotSetTcpInput extends RobotConfigurationIdentity { tcp?: RobotTcpDefinition; clear?: boolean }
export interface RobotSetBaseInput extends RobotConfigurationIdentity { base: RobotBaseBinding }
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
