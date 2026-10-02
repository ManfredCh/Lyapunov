import type { BenchmarkPlacementRegion } from '../../benchmark-contract/src/index.ts'

/** 官方环境协议。具体套件 SDK 只在可选 worker / 注入的 double 中出现。 */
export interface OfficialStepResult {
  observation: Record<string, unknown>
  reward: number
  done: boolean
}

export interface OfficialEnv {
  readonly horizon: number
  readonly actionDim: number
  readonly controlFrequencyHz: number
  reset(): Record<string, unknown>
  setInitState(state: unknown): Record<string, unknown>
  step(action: number[]): OfficialStepResult
  checkSuccess(): boolean
  placementRegions?(): BenchmarkPlacementRegion[]
  close(): void
}

export interface OfficialProtocol {
  createEnv(input: { taskId: string; suite: string; seed: number; initialStateRef: string; horizonSteps: number; controlFrequencyHz: number; actionDim: number }): OfficialEnv
}

export function createProtocolDouble(options: { horizon?: number; succeedWhen?: (stepIndex: number, action: number[]) => boolean } = {}): OfficialProtocol {
  return {
    createEnv(input) {
      let stepIndex = 0
      let success = false
      const horizon = options.horizon ?? input.horizonSteps
      const succeedWhen = options.succeedWhen ?? (() => false)
      const observation = () => ({ stepIndex, success })
      return {
        horizon,
        actionDim: input.actionDim,
        controlFrequencyHz: input.controlFrequencyHz,
        reset() {
          stepIndex = 0
          success = false
          return observation()
        },
        setInitState() {
          return observation()
        },
        step(action) {
          if (action.length !== input.actionDim) throw new Error('BENCHMARK_ACTION_DIMENSION_MISMATCH')
          if (!action.every(Number.isFinite)) throw new Error('BENCHMARK_ACTION_NOT_FINITE')
          stepIndex += 1
          success = succeedWhen(stepIndex, action)
          const done = stepIndex >= horizon
          return { observation: observation(), reward: success ? 1 : 0, done }
        },
        checkSuccess() {
          return success
        },
        close() {},
      }
    },
  }
}
