import type { Frame } from '../../lyapunov-contracts/src/types.ts'

export type BenchmarkObservationModality = 'rgb' | 'depth' | 'proprioception' | 'contacts'
export type BenchmarkActionKind = 'controller' | 'joint' | 'cartesian_delta' | 'gripper'

/** Provider 提供的区域几何；描述 site，不替代任务成功判定或物体完整容纳检查。 */
export interface BenchmarkPlacementRegion {
  regionId: string
  parentEntityId: string
  kind: 'placement' | 'containment'
  source: { provider: string; reference: string }
  geometry: {
    shape: 'box'
    coordinateFrame: 'parent-local'
    centerM: [number, number, number]
    halfExtentsM: [number, number, number]
    quaternionXyzw: [number, number, number, number]
  }
  /** 同一观测步派生的世界位姿；父物体移动后必须重新观测。 */
  worldPose?: {
    positionM: [number, number, number]
    quaternionXyzw: [number, number, number, number]
    worldId: string
    generation: number
    stepIndex: number
  }
}

/**
 * Benchmark 所属机器人的能力描述。套件可以是 Panda、轮式底盘、四足或
 * 其他形态；适配器只能消费这里声明的语义，不能把一种形态改名伪装成另一种。
 */
export interface BenchmarkRobotSpec {
  entityId: string
  modelVersion: string
  morphology: 'arm' | 'vehicle' | 'quadruped' | 'humanoid' | 'custom'
  joints?: string[]
  controlledJointNames?: string[]
  endEffector?: string
}

/**
 * 可选 benchmark 扩展使用的通用 episode 合同。
 * 具体套件、任务、初态、资产、动作语义和评测代码必须来自扩展自己的
 * 外部文件或 Provider；核心 sim-contract 不包含任何 benchmark 名称。
 */
export interface BenchmarkTaskSpec {
  benchId: string
  benchRevision: string
  taskId: string
  languageInstruction: string
  sceneId: string
  source: { repository: string; revision: string; taskRef: string }
  episode: { seed: number; initialStateRef: string; horizonSteps: number; controlFrequencyHz: number }
  observation: { modalities: BenchmarkObservationModality[]; fields: string[]; coordinateSystem: string }
  action: { kind: BenchmarkActionKind; dimensions: number; units: string[]; lower: number[]; upper: number[]; controlFrequencyHz: number; coordinateFrame?: string; axisNames?: string[] }
  robot?: BenchmarkRobotSpec
  /** 未提供时表示 Provider 暂无区域几何，消费者不得推断为零尺寸。 */
  placementRegions?: BenchmarkPlacementRegion[]
  evaluator: { source: string; successRule: string; failureRule?: string; timeoutRule: string }
}

export interface BenchmarkEpisodeHandle {
  episodeId: string; benchId: string; benchRevision: string; taskId: string; sceneId: string; sceneRevision: number
  worldId: string; generation: number; seed: number; horizonSteps: number; stepIndex: number
  status: 'ready' | 'running' | 'success' | 'failure' | 'timeout' | 'cancelled'
  /**
   * 这次 episode **因为什么**结束（终态才有）：官方成功判定 `check_success`、官方 horizon `horizon`、
   * 产品侧 agent 步数预算 `agent-budget`、取消 `cancelled`。
   *
   * 为什么必须有这一项：`status` 只有 timeout 一档，"官方 horizon 走完"与"产品预算耗尽"都会写成 timeout
   * （后者见 `BenchmarkStepReceipt.effect.budget`）；只报 status 时调用方分不出这两件事，也就无法按
   * DEV-023 的要求逐 episode 保留**终止原因**。运行中/未结束时不出现该字段。
   */
  terminationReason?: 'check_success' | 'horizon' | 'agent-budget' | 'cancelled'
}

export interface BenchmarkStepReceipt {
  episodeId: string; taskId: string; worldId: string; generation: number; actionId: string; startStep: number; endStep: number
  observation: Frame; status: 'running' | 'success' | 'failure' | 'timeout' | 'cancelled'; success: boolean
  evaluator: { source: string; reason?: string }
  /**
   * 官方控制器对本次动作的真实效果：reward/done 直接来自官方 `env.step`，`benchmarkStatus` 是这次动作之后的
   * 官方状态，`evaluator` 说明判定来源（如 `official-env.check_success`）；预算耗尽时还带
   * `budget: {kind:'agentStepBudget', limit}`。适配器一直返回它，合同此前没有声明。
   */
  effect?: { controlMode?: string; reward: number; done: boolean; benchmarkStatus: 'running' | 'success' | 'failure' | 'timeout' | 'cancelled'; evaluator?: string; requestedStepCount?: number; stepsExecuted?: number; budget?: { kind: string; limit: number }; continuedInteraction?: boolean }
  /** 本次动作生效后的终止原因：官方成功 `check_success`、官方 horizon `horizon`、产品预算 `agent-budget`；运行中不出现。 */
  reason?: 'check_success' | 'horizon' | 'agent-budget'
}

/** `result()` 在 episode 尚未跑完时也会返回：此时 status 是 `running`（此前类型漏了这一档）。 */
export interface BenchmarkEpisodeResult {
  episode: BenchmarkEpisodeHandle; task: BenchmarkTaskSpec; initialObservation: Frame; finalObservation: Frame
  receipts: BenchmarkStepReceipt[]; status: 'running' | 'success' | 'failure' | 'timeout' | 'cancelled'; success: boolean
  source: { repository: string; revision: string; taskRef: string }
}

/** 官方 SDK 未就绪时的失败关闭结果；不是成功 episode。 */
export interface BenchmarkUnavailable {
  status: 'BLOCKED'
  code: string
  message: string
  details?: Record<string, unknown>
}

export function isBenchmarkUnavailable(value: unknown): value is BenchmarkUnavailable {
  return !!value && typeof value === 'object' && (value as BenchmarkUnavailable).status === 'BLOCKED' && typeof (value as BenchmarkUnavailable).code === 'string' && typeof (value as BenchmarkUnavailable).message === 'string'
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function assertBenchmarkPlacementRegion(region: BenchmarkPlacementRegion): BenchmarkPlacementRegion {
  const vector = (value: unknown, size: number): value is number[] => Array.isArray(value) && value.length === size && value.every(finite)
  const quaternion = (value: unknown) => vector(value, 4) && Math.abs(Math.hypot(...value) - 1) < 1e-4
  const geometry = region?.geometry
  if (!region?.regionId || !region.parentEntityId || !['placement', 'containment'].includes(region.kind) || !region.source?.provider || !region.source.reference) throw new Error('BENCHMARK_PLACEMENT_REGION_IDENTITY_INVALID')
  if (!geometry || geometry.shape !== 'box' || geometry.coordinateFrame !== 'parent-local' || !vector(geometry.centerM, 3) || !vector(geometry.halfExtentsM, 3) || geometry.halfExtentsM.some(value => value <= 0) || !quaternion(geometry.quaternionXyzw)) throw new Error('BENCHMARK_PLACEMENT_REGION_GEOMETRY_INVALID')
  const pose = region.worldPose
  if (pose && (!pose.worldId || !Number.isInteger(pose.generation) || pose.generation < 0 || !Number.isInteger(pose.stepIndex) || pose.stepIndex < 0 || !vector(pose.positionM, 3) || !quaternion(pose.quaternionXyzw))) throw new Error('BENCHMARK_PLACEMENT_REGION_POSE_INVALID')
  return region
}

export function assertBenchmarkTaskSpec(task: BenchmarkTaskSpec): BenchmarkTaskSpec {
  if (!task.benchId || !task.benchRevision || !task.taskId || !task.languageInstruction) throw new Error('BENCHMARK_TASK_IDENTITY_REQUIRED')
  if (!task.source.repository || !task.source.revision || !task.source.taskRef) throw new Error('BENCHMARK_SOURCE_REVISION_REQUIRED')
  if (!Number.isInteger(task.episode.seed) || !Number.isInteger(task.episode.horizonSteps) || task.episode.horizonSteps <= 0) throw new Error('BENCHMARK_EPISODE_INVALID')
  if (!finite(task.episode.controlFrequencyHz) || task.episode.controlFrequencyHz <= 0) throw new Error('BENCHMARK_FREQUENCY_INVALID')
  if (!task.observation.modalities.length || !task.observation.fields.length || !task.observation.coordinateSystem) throw new Error('BENCHMARK_OBSERVATION_SCHEMA_REQUIRED')
  if (task.placementRegions) {
    if (!Array.isArray(task.placementRegions)) throw new Error('BENCHMARK_PLACEMENT_REGIONS_INVALID')
    task.placementRegions.forEach(assertBenchmarkPlacementRegion)
  }
  if (task.robot) {
    const robot = task.robot
    if (!robot.entityId || !robot.modelVersion || !robot.morphology) throw new Error('BENCHMARK_ROBOT_SCHEMA_INVALID')
    if (robot.joints && robot.controlledJointNames && !robot.controlledJointNames.every(name => robot.joints!.includes(name))) throw new Error('BENCHMARK_ROBOT_JOINT_SCHEMA_INVALID')
  }
  const { action } = task
  if (!Number.isInteger(action.dimensions) || action.dimensions <= 0 || action.units.length !== action.dimensions || action.lower.length !== action.dimensions || action.upper.length !== action.dimensions) throw new Error('BENCHMARK_ACTION_SCHEMA_INVALID')
  if (!action.lower.every(finite) || !action.upper.every(finite) || action.lower.some((value, index) => value > action.upper[index]!)) throw new Error('BENCHMARK_ACTION_BOUNDS_INVALID')
  if (action.axisNames && (action.axisNames.length !== action.dimensions || action.axisNames.some(name => !name))) throw new Error('BENCHMARK_ACTION_AXIS_SCHEMA_INVALID')
  if (!finite(action.controlFrequencyHz) || action.controlFrequencyHz <= 0) throw new Error('BENCHMARK_ACTION_FREQUENCY_INVALID')
  if (!task.evaluator.source || !task.evaluator.successRule || !task.evaluator.timeoutRule) throw new Error('BENCHMARK_EVALUATOR_REQUIRED')
  return task
}
