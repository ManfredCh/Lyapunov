import { assertBenchmarkTaskSpec, type BenchmarkTaskSpec } from '../../benchmark-contract/src/index.ts'

/** Gymnasium 官方仓库与版本。只在显式 Provider 中使用，不进入默认 Profile。 */
export const OFFICIAL_SOURCE = {
  repository: 'https://github.com/Farama-Foundation/Gymnasium',
  revision: 'v1.2.0',
} as const

export const DEFAULT_TASK = 'Ant-v5' as const

/**
 * Gymnasium MuJoCo Ant-v5 的官方默认构造。控制周期和动作边界在
 * prepare 阶段从官方环境运行时核验；observation 字段按 Ant-v5 的
 * qpos/qvel/cfrc_ext 组成声明，避免把自定义 XML 的维度误写成通用常量。
 */
export function officialTaskSpec(taskId: string = DEFAULT_TASK): BenchmarkTaskSpec {
  if (taskId !== DEFAULT_TASK) throw new Error(`GYMNASIUM_TASK_NOT_FOUND: ${taskId}`)
  return assertBenchmarkTaskSpec({
    benchId: 'gymnasium-mujoco',
    benchRevision: OFFICIAL_SOURCE.revision,
    taskId,
    languageInstruction: 'move the ant forward while keeping it healthy',
    sceneId: `gymnasium/${taskId}`,
    source: {
      repository: OFFICIAL_SOURCE.repository,
      revision: OFFICIAL_SOURCE.revision,
      taskRef: 'gymnasium.make("Ant-v5")',
    },
    episode: {
      seed: 0,
      initialStateRef: 'reset(seed=0)',
      horizonSteps: 1000,
      controlFrequencyHz: 20,
    },
    observation: {
      modalities: ['proprioception', 'contacts'],
      fields: [
        'qpos excluding current x/y',
        'qvel',
        'cfrc_ext excluding world body',
        'info.x_position',
        'info.y_position',
        'info.x_velocity',
        'info.y_velocity',
        'info.reward_forward',
        'info.reward_ctrl',
        'info.reward_contact',
        'info.reward_survive',
      ],
      coordinateSystem: 'Gymnasium/MuJoCo right-handed world; qpos quaternion is wxyz in raw XML state',
    },
    action: {
      kind: 'controller',
      dimensions: 8,
      units: Array.from({ length: 8 }, () => 'N*m normalized torque [-1,1]'),
      lower: Array.from({ length: 8 }, () => -1),
      upper: Array.from({ length: 8 }, () => 1),
      controlFrequencyHz: 20,
      coordinateFrame: 'Ant body-local actuator torque',
      axisNames: ['hip_4', 'angle_4', 'hip_1', 'angle_1', 'hip_2', 'angle_2', 'hip_3', 'angle_3'],
    },
    robot: {
      entityId: 'ant',
      modelVersion: 'Gymnasium Ant-v5 default ant.xml',
      morphology: 'quadruped',
      joints: ['hip_4', 'angle_4', 'hip_1', 'angle_1', 'hip_2', 'angle_2', 'hip_3', 'angle_3'],
      controlledJointNames: ['hip_4', 'angle_4', 'hip_1', 'angle_1', 'hip_2', 'angle_2', 'hip_3', 'angle_3'],
    },
    evaluator: {
      source: 'Gymnasium Ant-v5 env.step + TimeLimit',
      successRule: 'score-only: report official reward and info; Ant-v5 has no binary check_success predicate',
      failureRule: 'terminated=true when the official healthy predicate is false',
      timeoutRule: 'truncated=true at the Gymnasium TimeLimit horizon (1000 steps)',
    },
  })
}

export function catalogTasks(): BenchmarkTaskSpec[] {
  return [officialTaskSpec()]
}
