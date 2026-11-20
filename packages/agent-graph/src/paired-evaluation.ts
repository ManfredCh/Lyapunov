import { createHash } from 'node:crypto'
import type { Frame, Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { Campaign, CampaignTask, PairMember, PairResult, PairSafetyEvidence, SampledClearanceEvidence, RunCallArtifact, TaskCheckResult } from '../../lyapunov-contracts/src/agent-graph.ts'

function sameGoal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.entries(a), right = b as Record<string, unknown>
  return left.length === Object.keys(right).length && left.every(([key, value]) => Object.hasOwn(right, key) && sameGoal(value, right[key]))
}

export function readPair(raw: unknown): PairMember {
  const value = raw as Partial<PairMember> | null
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)
    || !Number.isSafeInteger(value.seed) || typeof value.tier !== 'string' || !value.tier.trim()
    || typeof value.sceneSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sceneSha256)
    || (value.requirePreflight !== undefined && value.requirePreflight !== true)
    || (value.requireSafety !== undefined && (value.requireSafety !== true || value.requirePreflight !== true))
    || (value.variant !== 'baseline' && value.variant !== 'candidate')) throw new Error('CAMPAIGN_PAIR_INVALID: id, seed, tier, sceneSha256, variant')
  return { id: value.id, seed: value.seed!, tier: value.tier, sceneSha256: value.sceneSha256, variant: value.variant, ...(value.requirePreflight ? { requirePreflight: true as const } : {}), ...(value.requireSafety ? { requireSafety: true as const } : {}) }
}

function groupPairs<T extends Pick<CampaignTask, 'pair'>>(tasks: readonly T[]) {
  const groups = new Map<string, T[]>()
  for (const task of tasks) {
    if (task.pair) {
      const group = groups.get(task.pair.id) ?? []
      group.push(task)
      groups.set(task.pair.id, group)
    }
  }
  return groups
}

export function validatePairs(tasks: readonly Pick<CampaignTask, 'sceneId' | 'goal' | 'pair' | 'partition'>[]): void {
  for (const [id, group] of groupPairs(tasks)) {
    const [a, b] = group
    if (group.length !== 2 || !a?.pair || !b?.pair || a.pair.variant === b.pair.variant
      || a.sceneId !== b.sceneId || a.pair.seed !== b.pair.seed || a.pair.tier !== b.pair.tier
      || a.pair.sceneSha256 !== b.pair.sceneSha256 || a.pair.requirePreflight !== b.pair.requirePreflight || a.pair.requireSafety !== b.pair.requireSafety || !sameGoal(a.goal, b.goal)
      || a.partition !== 'heldout' || b.partition !== 'heldout') {
      throw new Error(`CAMPAIGN_PAIR_MISMATCH: ${id} 需要共享场景、快照摘要、谓词、种子和扰动级别的两个 heldout 对照成员`)
    }
  }
}

function nativeClearance(value: unknown): SampledClearanceEvidence | undefined {
  const summary = value as SampledClearanceEvidence | undefined
  const qualifies = (x: SampledClearanceEvidence['payload']) => x && typeof x.geom1 === 'string' && typeof x.geom2 === 'string'
    && Number.isFinite(x.distanceM) && Number.isFinite(x.timeS) && x.timeS >= 0
  return summary?.source === 'mujoco-sampled-rigid-geometry' && Number.isSafeInteger(summary.sampleCount) && summary.sampleCount > 0
    && Number.isFinite(summary.distanceCapM) && qualifies(summary.robot) && (summary.payload === null || qualifies(summary.payload))
    ? summary : undefined
}

export function attachPairEvidence(task: CampaignTask, artifact: RunCallArtifact, args: unknown, value: unknown) {
  const input = (args as { input?: Record<string, unknown> } | undefined)?.input
  if (!input || !value || typeof value !== 'object') return
  if (artifact.tool === 'sim_open') {
    const world = value as { worldId: string; sceneId: string; worldGeneration: number; appliedSceneRevision: number }
    if (world.sceneId === task.sceneId && typeof world.worldId === 'string' && Number.isInteger(world.worldGeneration) && Number.isInteger(world.appliedSceneRevision)) {
      artifact.pairEvidence = { kind: 'world', worldId: world.worldId, generation: world.worldGeneration, sceneRevision: world.appliedSceneRevision }
    }
  } else if (artifact.tool === 'robot_state' && task.pair?.requirePreflight && input.entityId === undefined) {
    const frame = value as Frame
    if (typeof frame.worldId === 'string' && frame.worldId === input.worldId && Number.isInteger(frame.generation)
      && Number.isInteger(frame.sceneRevision) && typeof frame.frameId === 'string' && frame.stepIndex === 0
      && frame.executionMode === 'physical-contact' && frame.assistAdvanceCount === 0
      && Array.isArray(frame.entities) && frame.entities.length) {
      const entities = frame.entities.map(({ entityId, transform, joints }) => ({ entityId, transform, joints: joints ?? null }))
        .sort((a,b) => a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)
      const stateSha256 = createHash('sha256').update(JSON.stringify(entities)).digest('hex')
      artifact.pairEvidence = { kind: 'initial', worldId: frame.worldId, generation: frame.generation, sceneRevision: frame.sceneRevision!, frameId: frame.frameId, stateSha256, assistAdvanceCount: frame.assistAdvanceCount }
    }
  } else if (artifact.tool === 'sim_task_check' && sameGoal(input.predicates, task.goal)) {
    const result = value as TaskCheckResult & { worldId: string; generation: number; sceneRevision: number }
    const { worldId, generation, sceneRevision, taskAchieved, frameId, stepIndex, failed } = result
    if (result.evaluated && worldId === input.worldId && generation === input.expectedGeneration
      && typeof worldId === 'string' && Number.isInteger(generation) && Number.isInteger(sceneRevision) && typeof frameId === 'string'
      && typeof taskAchieved === 'boolean' && Number.isInteger(stepIndex) && Array.isArray(failed)) {
      if (input.checkSpec === false) {
        artifact.pairEvidence = { kind: 'verdict', worldId, generation, sceneRevision, frameId, stepIndex: stepIndex!, taskAchieved, failed,
          ...(result.executionMode === undefined ? {} : { executionMode: result.executionMode }),
          ...(result.assistAdvanceCount === undefined ? {} : { assistAdvanceCount: result.assistAdvanceCount }) }
      } else if (task.pair?.requirePreflight && stepIndex === 0 && !taskAchieved && failed.length
        && !failed.some(failure => ['ENTITY_MISSING', 'JOINT_MISSING', 'OBSERVATION_UNAVAILABLE'].includes(failure.reasonCode))) {
        artifact.pairEvidence = { kind: 'preflight', worldId, generation, sceneRevision, frameId }
      }
    }
  } else if (artifact.tool === 'sim_evaluation' && (input.request as { kind?: string } | undefined)?.kind === 'monitor-stop') {
    const report = value as Omit<PairSafetyEvidence, 'kind'> & { source?: string; includesInitial?: true }
    const { worldId, generation, sceneRevision, startStep, endStep, samples, passed, violations, peaks, limits } = report
    const metricNames = ['graspForceN', 'otherForceN', 'jointSpeedRps']
    if (report.source !== 'mujoco-native-step-peak' || typeof worldId !== 'string' || worldId !== input.worldId
      || ![generation, sceneRevision, startStep, endStep, samples].every(Number.isSafeInteger)
      || startStep < 0 || endStep < startStep || samples <= 0 || samples !== endStep - startStep + (report.includesInitial ? 1 : 0) || !peaks || !limits || !Array.isArray(violations)
      || metricNames.some(name => !Number.isFinite(peaks[name]) || peaks[name]! < 0 || !Number.isFinite(limits[name]) || limits[name]! <= 0)) return
    const expected = metricNames.filter(name => peaks[name]! > limits[name]!)
    if (passed !== !expected.length || !sameGoal(expected, violations)) return
    artifact.pairEvidence = { kind: 'safety', worldId, generation, sceneRevision, startStep, endStep, samples, passed, violations,
      peaks: Object.fromEntries(metricNames.map(name => [name, peaks[name]!])),
      limits: Object.fromEntries(metricNames.map(name => [name, limits[name]!])) }
  } else if (artifact.tool === 'robot_pick' || artifact.tool === 'robot_place') {
    const run = value as { after?: Frame; afterSource?: string; taskAchieved?: boolean; reason?: unknown; actions?: unknown[]; effect?: { phaseCheckpoints?: Record<string, unknown> } }
    const frame = run.after
    if (run.afterSource !== 'fresh' || !frame || typeof frame.worldId !== 'string' || frame.worldId !== input.worldId
      || !Number.isInteger(frame.generation) || !Number.isInteger(frame.sceneRevision) || typeof frame.frameId !== 'string'
      || !Number.isInteger(frame.stepIndex) || typeof run.taskAchieved !== 'boolean' || !Array.isArray(run.actions)) return
    const actions = run.actions.flatMap(raw => {
      const action = raw as { actionId?: string; worldId?: string; generation?: number; status?: string; startStep?: number; endStep?: number; effect?: { motions?: Array<{ targetReached?: unknown; sampledClearance?: unknown; payload?: { objects?: Array<{ objectId: string; contactSteps: number; displacementM: Vec3; maxLiftM: number }> } }> } } | null
      if (!action || typeof action.actionId !== 'string' || typeof action.status !== 'string' || action.worldId !== frame.worldId || action.generation !== frame.generation) return []
      const motion = action.effect?.motions?.[0]
      const reached = motion?.targetReached
      const sampledClearance = nativeClearance(motion?.sampledClearance)
      const object = Array.isArray(motion?.payload?.objects) ? motion.payload.objects.find(row => row?.objectId === input.objectId) : undefined
      const targetContact = object && typeof object.objectId === 'string' && Number.isSafeInteger(object.contactSteps) && object.contactSteps >= 0
        && Array.isArray(object.displacementM) && object.displacementM.length === 3 && object.displacementM.every(Number.isFinite)
        && Number.isFinite(object.maxLiftM)
        ? { objectId: object.objectId, contactSteps: object.contactSteps, displacementM: object.displacementM, maxLiftM: object.maxLiftM } : undefined
      return [{ actionId: action.actionId, status: action.status,
        ...(Number.isInteger(action.startStep) ? { startStep: action.startStep! } : {}),
        ...(Number.isInteger(action.endStep) ? { endStep: action.endStep! } : {}),
        ...(typeof reached === 'boolean' ? { targetReached: reached } : {}), ...(targetContact ? { targetContact } : {}), ...(sampledClearance ? { sampledClearance } : {}) }]
    })
    const checkpoints = Object.entries(run.effect?.phaseCheckpoints ?? {}).flatMap(([phase, value]) => {
      const cp = value as { worldId?: string; generation?: number; sceneRevision?: number; checkpointId?: string; stepIndex?: number; stateSha256?: string } | null
      if (!cp || cp.worldId !== frame.worldId || cp.generation !== frame.generation || cp.sceneRevision !== frame.sceneRevision
        || typeof cp.checkpointId !== 'string' || typeof cp.stateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cp.stateSha256)
        || !Number.isSafeInteger(cp.stepIndex) || cp.stepIndex! > frame.stepIndex) return []
      return [{ phase, checkpointId: cp.checkpointId, stepIndex: cp.stepIndex!, stateSha256: cp.stateSha256 }]
    })
    artifact.pairEvidence = { kind: 'workflow', tool: artifact.tool, worldId: frame.worldId, generation: frame.generation,
      sceneRevision: frame.sceneRevision!, frameId: frame.frameId, stepIndex: frame.stepIndex, taskAchieved: run.taskAchieved,
      ...(typeof run.reason === 'string' ? { reason: run.reason } : {}), ...(checkpoints.length ? { checkpoints } : {}), actions }
  } else if (artifact.tool === 'recording_start' || artifact.tool === 'recording_stop') {
    const { recordingId, sceneId, status, frameCount } = value as { recordingId?: string; sceneId?: string; status?: string; frameCount?: number }
    if (typeof recordingId !== 'string' || sceneId !== task.sceneId) return
    if (artifact.tool === 'recording_start' && status === 'recording' && typeof input.worldId === 'string' && Number.isInteger(input.expectedGeneration)) {
      artifact.pairEvidence = { kind: 'recording-start', recordingId, worldId: input.worldId, generation: input.expectedGeneration as number }
    }
    if (artifact.tool === 'recording_stop' && status === 'completed' && recordingId === input.recordingId && (frameCount ?? 0) > 0) {
      artifact.pairEvidence = { kind: 'recording-stop', recordingId, frameCount: frameCount! }
    }
  }
}

export function pairResult(calls: readonly RunCallArtifact[], runId: string, requirePreflight?: true, requireSafety?: true): PairResult | undefined {
  const facts = calls.flatMap(({ pairEvidence }) => pairEvidence ? [pairEvidence] : [])
  const world = facts.findLast(fact => fact.kind === 'world')
  if (!world) return undefined
  const current = facts.slice(facts.lastIndexOf(world) + 1)
  const matchesWorld = (fact: { worldId: string; generation: number }) => fact.worldId === world.worldId && fact.generation === world.generation
  const verdict = current.findLast(fact => fact.kind === 'verdict' && matchesWorld(fact) && fact.sceneRevision === world.sceneRevision)
  if (!verdict || verdict.kind !== 'verdict') return undefined
  const at = current.indexOf(verdict)
  const start = current.slice(0, at).findLast(fact => fact.kind === 'recording-start' && matchesWorld(fact))
  if (!start || start.kind !== 'recording-start') return undefined
  const stop = current.slice(at + 1).find(fact => fact.kind === 'recording-stop' && fact.recordingId === start.recordingId)
  if (!stop || stop.kind !== 'recording-stop') return undefined
  const prior = current.slice(0, at)
  const initial = prior.find(fact => fact.kind === 'initial' && matchesWorld(fact) && fact.sceneRevision === verdict.sceneRevision)
  const preflight = initial?.kind === 'initial' && prior.some(fact => fact.kind === 'preflight' && matchesWorld(fact)
    && fact.sceneRevision === verdict.sceneRevision && fact.frameId === initial.frameId)
  if (requirePreflight && (!preflight || verdict.executionMode !== 'physical-contact' || verdict.assistAdvanceCount !== 0)) return undefined
  const safety = current.findLast(fact => fact.kind === 'safety' && matchesWorld(fact) && fact.sceneRevision === verdict.sceneRevision
    && fact.startStep === 0 && fact.endStep >= verdict.stepIndex)
  if (requireSafety && safety?.kind !== 'safety') return undefined
  const workflows = prior.filter(fact => fact.kind === 'workflow' && matchesWorld(fact) && fact.sceneRevision === verdict.sceneRevision
    && fact.stepIndex <= verdict.stepIndex).flatMap(fact => fact.kind === 'workflow' ? [fact] : [])
  const { kind: _kind, ...decision } = verdict
  return { ...decision, runId, recordingId: stop.recordingId, frameCount: stop.frameCount,
    ...(preflight && initial?.kind === 'initial' ? { initialStateSha256: initial.stateSha256 } : {}),
    ...(workflows.length ? { workflows } : {}), ...(safety?.kind === 'safety' ? { safety } : {}) }
}

const emptyCounts = () => ({ complete: 0, incomplete: 0, both: 0, baselineOnly: 0, candidateOnly: 0, neither: 0 })

function pairedStats(counts: ReturnType<typeof emptyCounts>) {
  const discordantPairs = counts.baselineOnly + counts.candidateOnly
  const minority = Math.min(counts.baselineOnly, counts.candidateOnly)
  // Log space keeps the exact binomial tail finite even when a campaign has thousands of discordant outcomes.
  let logMass = -discordantPairs * Math.LN2
  let logTail = logMass
  for (let i = 1; i <= minority; i++) {
    logMass += Math.log(discordantPairs - i + 1) - Math.log(i)
    logTail = logMass + Math.log1p(Math.exp(logTail - logMass))
  }
  const rate = (wins: number) => counts.complete ? (counts.both + wins) / counts.complete : null
  return { discordantPairs, baselineRate: rate(counts.baselineOnly), candidateRate: rate(counts.candidateOnly),
    exactMcNemarP: counts.complete ? Math.min(1, 2 * Math.exp(logTail)) : null }
}

export function pairedReport(campaign: Campaign) {
  const groups = groupPairs(campaign.tasks)
  if (!groups.size) return undefined
  const counts = emptyCounts()
  const safetyCounts = { complete: 0, baselineSafePass: 0, candidateSafePass: 0, candidateNewViolations: 0 }
  const tiers = new Map<string, ReturnType<typeof emptyCounts>>()
  const pairs = [...groups.values()].map(tasks => {
    const baseline = tasks.find(task => task.pair?.variant === 'baseline')!
    const candidate = tasks.find(task => task.pair?.variant === 'candidate')!
    const a = baseline.pairResult, b = candidate.pairResult
    const condition = baseline.pair!
    const incompleteReason = !a || !b ? 'EVIDENCE_MISSING' : a.sceneRevision !== b.sceneRevision ? 'SCENE_REVISION_MISMATCH'
      : condition.requirePreflight && (!a.initialStateSha256 || a.initialStateSha256 !== b.initialStateSha256) ? 'INITIAL_STATE_MISMATCH'
      : condition.requireSafety && (!a.safety || !b.safety || !sameGoal(a.safety.limits, b.safety.limits)) ? 'SAFETY_LIMITS_MISMATCH' : undefined
    const outcome = incompleteReason ? 'incomplete' : a!.taskAchieved ? (b!.taskAchieved ? 'both' : 'baselineOnly') : (b!.taskAchieved ? 'candidateOnly' : 'neither')
    const tier = tiers.get(condition.tier) ?? emptyCounts()
    tiers.set(condition.tier, tier)
    for (const tally of [counts, tier]) {
      tally[outcome]++
      if (!incompleteReason) tally.complete++
    }
    if (!incompleteReason && a?.safety && b?.safety && sameGoal(a.safety.limits,b.safety.limits)) {
      safetyCounts.complete++
      if (a.taskAchieved && a.safety.passed) safetyCounts.baselineSafePass++
      if (b.taskAchieved && b.safety.passed) safetyCounts.candidateSafePass++
      if (a.safety.passed && !b.safety.passed) safetyCounts.candidateNewViolations++
    }
    const { variant: _variant, ...pairCondition } = condition
    return { ...pairCondition, outcome, ...(incompleteReason ? { incompleteReason } : {}),
      baseline: { taskId: baseline.taskId, result: a ?? null }, candidate: { taskId: candidate.taskId, result: b ?? null } }
  })
  return { ...counts, ...(safetyCounts.complete ? { safety: safetyCounts } : {}), statistics: pairedStats(counts), tiers: [...tiers].map(([tier, count]) => ({ tier, ...count, statistics: pairedStats(count) })), pairs }
}
