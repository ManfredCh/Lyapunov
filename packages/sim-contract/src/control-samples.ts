import type { Frame } from '../../lyapunov-contracts/src/types.ts'

/** 真实控制窗口；采样频率由整数物理步给出，非 Viewer 帧率。 */
export interface ControlSamplingOptions {
 enabled: boolean
 expectedGeneration: number
 episodeId: string
 entityId: string
}
export interface ControlSamplingState extends ControlSamplingOptions { sampleCount: number; profile: 'joint-position-reference-v1' }
export interface ControlSample {
 schemaVersion: 1
 profile: 'joint-position-reference-v1'
 episodeId: string
 controlCycleIndex: number
 worldId: string
 generation: number
 sceneRevision: number
 entityId: string
 actionId: string
 jointNames: string[]
 jointUnits: ('rad' | 'm')[]
 positions: number[]
 physicsStepStart: number
 physicsStepEnd: number
 simTimeStart: number
 simTimeEnd: number
 physicsTimestepS: number
 requestedSteps: number
 appliedSteps: number
 complete: boolean
 status: string
 reason?: string
 before: Frame
 after: Frame | null
}

export function validControlSample(value: unknown): value is ControlSample {
 if (!value || typeof value !== 'object') return false
 const s = value as ControlSample
 return s.schemaVersion === 1 && s.profile === 'joint-position-reference-v1'
  && ['episodeId', 'worldId', 'entityId', 'actionId'].every(k => typeof (s as unknown as Record<string, unknown>)[k] === 'string')
  && Number.isInteger(s.generation) && Number.isInteger(s.sceneRevision) && Number.isInteger(s.controlCycleIndex)
  && Number.isInteger(s.physicsStepStart) && Number.isInteger(s.physicsStepEnd) && s.physicsStepEnd >= s.physicsStepStart
  && Number.isFinite(s.simTimeStart) && Number.isFinite(s.simTimeEnd) && s.simTimeEnd >= s.simTimeStart
  && Number.isFinite(s.physicsTimestepS) && s.physicsTimestepS > 0
  && Number.isInteger(s.requestedSteps) && s.requestedSteps > 0 && s.appliedSteps === s.physicsStepEnd - s.physicsStepStart
  && Array.isArray(s.jointNames) && s.jointNames.length > 0 && new Set(s.jointNames).size === s.jointNames.length
  && s.jointNames.every(x => typeof x === 'string' && x.length > 0)
  && Array.isArray(s.jointUnits) && s.jointUnits.length === s.jointNames.length && s.jointUnits.every(x => x === 'rad' || x === 'm')
  && Array.isArray(s.positions) && s.positions.length === s.jointNames.length && s.positions.every(Number.isFinite)
  && typeof s.complete === 'boolean' && typeof s.status === 'string'
  && !!s.before && s.before.worldId === s.worldId && s.before.generation === s.generation && s.before.stepIndex === s.physicsStepStart
  && (s.after === null || s.after.worldId === s.worldId && s.after.generation === s.generation && s.after.stepIndex === s.physicsStepEnd)
  && (!s.complete || s.status === 'completed' && s.after !== null && s.appliedSteps === s.requestedSteps)
}
