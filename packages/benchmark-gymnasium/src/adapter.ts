import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProcessSimProvider } from '../../sim-contract/src/python-transport.ts'
import { resolveMuJoCoGlBackend } from '../../sim-contract/src/mujoco-gl.ts'
import { SimError, type SimAction, type SimWorlds, type ObservationSelection, type StopSelection, type WorldOptions } from '../../sim-contract/src/index.ts'
import { SCENE_COORDINATES, type ActionReceipt, type Frame, type SceneSnapshot, type WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { isBenchmarkUnavailable, type BenchmarkTaskSpec, type BenchmarkUnavailable } from '../../benchmark-contract/src/index.ts'
import { AdapterConcurrency } from '../../benchmark-contract/src/adapter-concurrency.ts'
import { catalogTasks, DEFAULT_TASK, officialTaskSpec } from './catalog.ts'
import { prepareGymnasiumSdk } from './prepare.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ENTITY_ID = 'ant'

export interface GymnasiumAdapterConfig {
  pythonPath?: string
  workerPath?: string
  isolatedRoot?: string
  outputRoot?: string
}

/** Worker handle plus the episode artifact paths it owns. */
export interface GymnasiumWorkerHandle extends WorldHandle { recordPath?: string; trajectoryPath?: string }

/** Product view of the official episode score record written by the worker. */
export interface GymnasiumRecordSummary {
  recordPath?: string
  trajectoryPath?: string
  available: boolean
  reason?: string
  episodeId?: string
  status?: string
  stepIndex?: number
  episodeReturn?: number
  terminated?: boolean
  truncated?: boolean
  terminal?: Record<string, unknown> | null
  release?: Record<string, unknown> | null
  closed?: Record<string, unknown> | null
  recording?: Record<string, unknown>
  trajectory?: Record<string, unknown> | null
  score?: Record<string, unknown>
}

/** Result of bench_close: the released episode plus its finalized record. */
export interface GymnasiumReleaseSummary {
  status: 'closed'
  worldId: string
  episodeId: string
  taskId: string
  terminalStatus: string
  episodeReturn: number
  stepIndex: number
  terminated: boolean
  truncated: boolean
  terminal?: Record<string, unknown> | null
  release?: Record<string, unknown> | null
  closed?: Record<string, unknown> | null
  recording: Record<string, unknown>
  record: { recordPath?: string; trajectoryPath?: string; written: boolean; error: string | null; summary?: Record<string, unknown> | null }
}

type EpisodeStatus = 'ready' | 'running' | 'failure' | 'timeout' | 'cancelled'
type TerminalReason = 'terminated' | 'horizon' | 'cancelled'

interface ActiveWorld {
  task: BenchmarkTaskSpec
  handle: GymnasiumWorkerHandle
  transport: ProcessSimProvider
  generation: number
  stepIndex: number
  current: Frame
  initial: Frame
  receipts: Map<string, ActionReceipt>
  /** 已受理动作的规范化请求指纹，与 receipts 同生命周期；同 ID 改参时用于 ACTION_ID_CONFLICT。 */
  requests: Map<string, string>
  /** 首执行尚未返回的同 ID 等待点：同请求并入同一次执行（瞬态单飞），settle 后即清除。 */
  inFlight: Map<string, { request: string; result: Promise<ActionReceipt> }>
  status: EpisodeStatus
  score: number
  episodeReturn: number
  terminated: boolean
  truncated: boolean
  terminalReason?: TerminalReason
  recordPath?: string
  trajectoryPath?: string
  record?: Record<string, unknown>
  recording: { directory?: string; frames: number; renderAvailable?: boolean; renderError?: string | null }
}

function emptyScene(sceneId: string, revision = 0): SceneSnapshot { return { sceneId, revision, coordinates: SCENE_COORDINATES, entities: [] } }

/**
 * 动作请求的规范化指纹，语义对齐 sim-mujoco/isaac worker 的 requests/receipts：
 * 同一 actionId 只有请求本身逐字段相同才算重试；参数变了必须 ACTION_ID_CONFLICT，
 * 不得拿旧回执冒充新动作。
 */
function actionRequestFingerprint(values: unknown, stepCount: unknown): string {
  return JSON.stringify({ entityId: ENTITY_ID, kind: 'control', positions: values, stepCount })
}

function readJsonRecord(path?: string): any | undefined {
  if (!path || !existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class GymnasiumAntAdapter implements SimWorlds {
  private world?: ActiveWorld
  private closed = false
  /** DEV-018：串行 load + 释放只跑一次这条规则只有一处实现（两包此前各抄一份逐字相同的副本）。 */
  private readonly concurrency = new AdapterConcurrency()
  constructor(readonly config: GymnasiumAdapterConfig = {}) {}
  pythonPath() { return this.config.pythonPath ?? resolve(here, '../../../.runtime/bench/gymnasium-env/bin/python') }
  workerPath() { return this.config.workerPath ?? resolve(here, '../python/worker.py') }
  isolatedRoot() { return this.config.isolatedRoot ?? resolve(here, '../../../.runtime/bench/gymnasium') }
  outputRoot() { return this.config.outputRoot ? resolve(this.config.outputRoot) : resolve(this.isolatedRoot(), 'runs') }
  catalog() { return { suite: 'gymnasium-mujoco', revision: 'v1.2.0', tasks: catalogTasks() } }
  prepare() { return prepareGymnasiumSdk({ pythonPath: this.pythonPath(), isolatedRoot: this.isolatedRoot() }) }

  async load(input: { taskId?: string; seed?: number; worldId?: string } = {}, signal?: AbortSignal): Promise<WorldHandle | BenchmarkUnavailable> {
    this.guard()
    if (signal?.aborted) throw new SimError('CANCELLED', 'load 在提交前已取消')
    // 串行化 load：并发 load 必须按调用顺序替换世界。否则两次 open 会先后写 this.world，
    // 先完成的那次 world/worker 再无人持有（连 dispose 都找不到它），进程泄漏。
    return this.concurrency.serialize(async () => {
      this.guard() // dispose 可能发生在上一个 load 正持锁期间
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 在排队等待期间已取消')
      return await this.loadExclusive(input, signal)
    })
  }

  private async loadExclusive(input: { taskId?: string; seed?: number; worldId?: string }, signal?: AbortSignal): Promise<WorldHandle | BenchmarkUnavailable> {
    const catalogTask = officialTaskSpec(input.taskId ?? DEFAULT_TASK)
    // 本次 episode 真实使用的 seed 随 world.task 进入回执与结果，不冒用目录默认值。
    const task: BenchmarkTaskSpec = { ...catalogTask, episode: { ...catalogTask.episode, seed: input.seed ?? catalogTask.episode.seed } }
    const prepared = await this.prepare()
    this.guard() // 释放发生在 prepare await 期间：不得再 spawn worker
    if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 prepare 期间已取消')
    if (isBenchmarkUnavailable(prepared)) return prepared
    await this.replaceWorld()
    this.guard()
    const transport = new ProcessSimProvider({ pythonPath: prepared.pythonPath, workerPath: this.workerPath(), engineName: 'gymnasium', env: { PYTHONUNBUFFERED: '1', MUJOCO_GL: resolveMuJoCoGlBackend(), LYAPUNOV_GYM_OUTPUT: this.outputRoot() } })
    try {
      const handle = await transport.open(emptyScene(task.sceneId), { worldId: input.worldId, clock: 'manual', timestepS: 1 / task.episode.controlFrequencyHz, seed: task.episode.seed, horizonSteps: task.episode.horizonSteps, outputDir: this.outputRoot() } as any)
      // dispose 在 open await 期间返回：销毁刚拉起的 worker 后 fail-closed，绝不 adopt 到已释放的适配器上。
      this.guard()
      // 取消在 open await 期间到达：同样销毁 worker 后 fail-closed，不 adopt 未被认领的世界。
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 open 期间已取消')
      const workerHandle = handle as GymnasiumWorkerHandle
      const frame = await transport.observe(handle.worldId)
      this.guard()
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 observe 期间已取消')
      const initialImage = frame.entities.find(entity => entity.entityId === ENTITY_ID)?.sensors?.antview
      const initialImagePath = initialImage && typeof initialImage === 'object' && !Array.isArray(initialImage) && 'path' in initialImage && typeof initialImage.path === 'string' ? initialImage.path : undefined
      const recordPath = typeof workerHandle.recordPath === 'string' ? workerHandle.recordPath : undefined
      this.world = {
        task,
        handle: { ...workerHandle, engineId: 'gymnasium', status: 'ready' },
        transport,
        generation: handle.worldGeneration,
        stepIndex: frame.stepIndex,
        current: frame,
        initial: frame,
        receipts: new Map(),
        requests: new Map(),
        inFlight: new Map(),
        status: 'ready',
        score: 0,
        episodeReturn: 0,
        terminated: false,
        truncated: false,
        recordPath,
        trajectoryPath: typeof workerHandle.trajectoryPath === 'string' ? workerHandle.trajectoryPath : undefined,
        recording: { directory: initialImagePath ? dirname(initialImagePath) : recordPath ? resolve(dirname(recordPath), 'generation-1') : undefined, frames: initialImagePath ? 1 : 0, renderAvailable: initialImagePath !== undefined },
      }
      return this.world.handle
    } catch (error) {
      await transport.dispose().catch(() => undefined)
      // 生命周期/取消错误必须原样上报，不能被折叠成“SDK 不可用”。
      if (error instanceof SimError && (error.code === 'PROVIDER_CLOSED' || error.code === 'CANCELLED')) throw error
      return { status: 'BLOCKED', code: 'GYMNASIUM_SDK_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), details: { pythonPath: prepared.pythonPath } }
    }
  }

  async step(input: { worldId: string; actionId: string; expectedGeneration: number; values: number[]; stepCount?: number }, signal?: AbortSignal): Promise<ActionReceipt> {
    const world = this.require(input.worldId)
    if (input.expectedGeneration !== world.generation) throw new SimError('STALE_GENERATION', '动作代次与当前世界不一致')
    // 契约 §2.8.9：相同 actionId 的重试必须返回同一回执，不得重复推进物理。
    const request = actionRequestFingerprint(input.values, input.stepCount ?? 1)
    const retried = world.receipts.get(input.actionId)
    if (retried) {
      if (world.requests.get(input.actionId) !== request) throw new SimError('ACTION_ID_CONFLICT', '相同 actionId 不得改变请求')
      return structuredClone(retried)
    }
    // 首执行未返回时的同 ID 到达：同请求并入同一次执行（瞬态单飞），请求不同立即冲突。
    const inflight = world.inFlight.get(input.actionId)
    if (inflight) {
      if (inflight.request !== request) throw new SimError('ACTION_ID_CONFLICT', '相同 actionId 不得改变请求')
      return structuredClone(await inflight.result)
    }
    // 终态只拦新动作：到达 terminated/horizon/cancelled 后，既有 actionId 的重试/冲突
    // 已在上面按回执语义处理完；此处再拒绝会把“已发生的执行事实”误报成 episode 不存在。
    if (world.status === 'failure' || world.status === 'timeout' || world.status === 'cancelled' || world.terminalReason !== undefined) throw new SimError('BENCHMARK_EPISODE_TERMINAL', 'episode 已结束')
    const execution = this.runStep(world, input, request, signal)
    world.inFlight.set(input.actionId, { request, result: execution })
    try {
      return await execution
    } finally {
      world.inFlight.delete(input.actionId)
    }
  }

  private async runStep(world: ActiveWorld, input: { worldId: string; actionId: string; expectedGeneration: number; values: number[]; stepCount?: number }, request: string, signal?: AbortSignal): Promise<ActionReceipt> {
    // 提交前已取消：不触碰运行时，也不推进本地状态。
    if (signal?.aborted) throw new SimError('CANCELLED', '动作在提交前已取消')
    if (!Array.isArray(input.values) || input.values.length !== taskActionDim(world.task) || !input.values.every(Number.isFinite)) throw new SimError('GYMNASIUM_ACTION_INVALID', 'Ant-v5 需要 8 个 [-1,1] 有限 torque 值')
    if (input.values.some(v => v < -1 || v > 1)) throw new SimError('GYMNASIUM_ACTION_OUT_OF_RANGE', 'Ant-v5 torque 必须在 [-1,1]')
    const count = input.stepCount ?? 1
    if (!Number.isInteger(count) || count <= 0) throw new SimError('GYMNASIUM_STEP_COUNT_INVALID', 'stepCount 必须为正整数')
    // 契约 §2.8 item 8：AbortSignal 必须传到运行时。transport 在取消时向 worker 发送真实
    // stop，并且只在收到停止确认后才返回（失败会抛错，不会冒充已停止）。
    const receipt = await world.transport.execute(world.handle.worldId, { actionId: input.actionId, expectedGeneration: world.generation, kind: 'control', entityId: ENTITY_ID, jointNames: world.task.robot?.controlledJointNames ?? [], positions: input.values, stepCount: count }, signal)
    world.stepIndex = receipt.endStep ?? world.stepIndex
    if (receipt.finalState) world.current = receipt.finalState
    const effect = receipt.effect ?? {}
    world.episodeReturn = finiteOrUndefined(effect.episodeReturn) ?? world.episodeReturn + (finiteOrUndefined(effect.reward) ?? 0)
    world.score = world.episodeReturn
    world.terminated = effect.terminated === true
    world.truncated = effect.truncated === true
    // 官方同一控制步可能同时给出 terminated 与 truncated；terminated 优先作为终态原因，
    // 但两个官方布尔值都保持原样，不互相覆盖。
    if (world.terminated || effect.terminalReason === 'terminated') world.terminalReason = 'terminated'
    else if (effect.terminalReason === 'horizon' || world.stepIndex >= world.task.episode.horizonSteps) {
      world.terminalReason = 'horizon'
      world.truncated = true
    }
    // worker 的真实取消事实（显式 stop 中断批次）优先于本地 signal 推断：官方终态已在上方
    // 先行判定，其余情况若回执自报 cancelled，就必须按取消收尾，不能退回 running。
    else if (effect.terminalReason === 'cancelled' || receipt.status === 'cancelled') world.terminalReason = 'cancelled'
    const record = effect.record
    if (record && typeof record === 'object') {
      world.record = record as Record<string, unknown>
      if (typeof (record as any).path === 'string') world.recordPath = (record as any).path
      if (typeof (record as any).trajectoryPath === 'string') world.trajectoryPath = (record as any).trajectoryPath
      world.recording.frames = finiteOrUndefined((record as any).frames) ?? world.recording.frames
      if (typeof (record as any).renderAvailable === 'boolean') world.recording.renderAvailable = (record as any).renderAvailable
      if (typeof (record as any).renderError === 'string' || (record as any).renderError === null) world.recording.renderError = (record as any).renderError
    }
    world.status = world.terminalReason === 'terminated' ? 'failure' : world.terminalReason === 'horizon' ? 'timeout' : world.terminalReason === 'cancelled' ? 'cancelled' : 'running'
    // signal 推断只是兜底：worker 回执未自报终态、但本次调用已被取消时，同样按 cancelled 收尾。
    // 官方终态（terminated/horizon）是已发生的事实，不得改写。
    if (signal?.aborted && world.terminalReason === undefined) {
      world.terminalReason = 'cancelled'
      world.status = 'cancelled'
    }
    world.handle = { ...world.handle, status: world.status === 'running' ? 'running' : 'paused' }
    const normalized: ActionReceipt = {
      ...receipt,
      taskAchieved: false,
      reason: world.terminalReason,
      effect: {
        ...effect,
        scoreOnly: true,
        evaluator: world.task.evaluator.source,
        episodeReturn: world.episodeReturn,
        terminated: world.terminated,
        truncated: world.truncated,
        terminalReason: world.terminalReason ?? null,
        record: world.record ?? null,
        recording: { ...world.recording },
      },
    }
    world.requests.set(input.actionId, request)
    world.receipts.set(input.actionId, normalized)
    return normalized
  }

  result(input: { worldId?: string } = {}) {
    const world = input.worldId ? this.require(input.worldId) : this.world
    if (!world) throw new SimError('WORLD_NOT_FOUND', '没有活动的 Gymnasium 世界')
    return {
      episode: { episodeId: world.handle.worldId, benchId: world.task.benchId, benchRevision: world.task.benchRevision, taskId: world.task.taskId, sceneId: world.task.sceneId, sceneRevision: world.handle.appliedSceneRevision, worldId: world.handle.worldId, generation: world.generation, seed: world.task.episode.seed, horizonSteps: world.task.episode.horizonSteps, stepIndex: world.stepIndex, status: world.status },
      task: world.task,
      initialObservation: world.initial,
      finalObservation: world.current,
      receipts: [...world.receipts.values()],
      status: world.status === 'ready' || world.status === 'running' ? 'running' : world.status,
      success: false,
      score: world.score,
      episodeReturn: world.episodeReturn,
      terminated: world.terminated,
      truncated: world.truncated,
      horizonReached: world.stepIndex >= world.task.episode.horizonSteps,
      terminal: world.terminalReason ? { reason: world.terminalReason, stepIndex: world.stepIndex, episodeReturn: world.episodeReturn, terminated: world.terminated, truncated: world.truncated } : null,
      recording: { ...world.recording, source: 'gymnasium.render', framePattern: 'step-%06d-antview.png' },
      record: this.recordSummary(world),
      source: world.task.source,
    }
  }

  /** Read the official score record the worker wrote for one episode. */
  record(input: { worldId?: string } = {}) {
    const world = input.worldId ? this.require(input.worldId) : this.world
    if (!world) throw new SimError('WORLD_NOT_FOUND', '没有活动的 Gymnasium 世界')
    return this.recordSummary(world)
  }

  /** 关闭并正常释放 episode；返回已被产品工具链消费的终态与记录摘要。 */
  async release(worldId: string): Promise<GymnasiumReleaseSummary> {
    const world = this.require(worldId)
    const before = this.recordSummary(world)
    const episodeId = world.handle.worldId
    const taskId = world.task.taskId
    const recordPath = world.recordPath
    const trajectoryPath = world.trajectoryPath
    // close 负责两件事：落盘最终记录、回收该 episode 独占的 worker 进程。
    // 任一失败都会抛出（GYMNASIUM_CLOSE_FAILED），release 绝不在此情况下声称 closed。
    await this.close(worldId)
    const after = readJsonRecord(recordPath)
    return {
      status: 'closed',
      worldId,
      episodeId,
      taskId,
      terminalStatus: typeof after?.status === 'string' ? after.status : world.status,
      episodeReturn: finiteOrUndefined(after?.score?.episodeReturn) ?? world.episodeReturn,
      stepIndex: finiteOrUndefined(after?.stepIndex) ?? world.stepIndex,
      terminated: after?.terminated === true || world.terminated,
      truncated: after?.truncated === true || world.truncated,
      terminal: after?.terminal ?? before.terminal ?? null,
      release: after?.release ?? null,
      closed: after?.closed ?? null,
      recording: after?.recording ?? before.recording ?? { ...world.recording, source: 'gymnasium.render' },
      record: {
        recordPath,
        trajectoryPath,
        written: after !== undefined,
        error: after === undefined ? (before.reason ?? 'RECORD_NOT_WRITTEN') : null,
        summary: after?.trajectory ?? before.trajectory ?? null,
      },
    }
  }

  async runSuite(signal?: AbortSignal) {
    const loaded = await this.load({}, signal)
    if (isBenchmarkUnavailable(loaded)) return loaded
    const task = officialTaskSpec()
    const receipt = await this.step({ worldId: loaded.worldId, actionId: 'gymnasium-zero-baseline', expectedGeneration: loaded.worldGeneration, values: Array.from({ length: task.action.dimensions }, () => 0), stepCount: task.episode.horizonSteps }, signal)
    const result = this.result({ worldId: loaded.worldId })
    const released = await this.release(loaded.worldId)
    return { suite: 'gymnasium-mujoco', taskId: task.taskId, status: result.status, success: false, score: result.score, episodeReturn: result.episodeReturn, stepIndex: result.episode.stepIndex, horizonSteps: task.episode.horizonSteps, terminalReached: result.status === 'failure' || result.status === 'timeout', terminated: result.terminated, truncated: result.truncated, terminal: result.terminal, evaluator: task.evaluator.source, recording: result.recording, record: released.record, release: released.release, receipt }
  }
  async listWorlds() { this.guard(); return this.world ? [this.world.handle] : [] }
  async open(_snapshot: SceneSnapshot, _options?: WorldOptions): Promise<WorldHandle> { throw new SimError('PROVIDER_UNAVAILABLE', 'Gymnasium 世界请通过 bench_load 载入') }
  async sync(worldId: string) { return this.require(worldId).handle }
  async describe(worldId: string, entityId: string) { if (entityId !== ENTITY_ID) throw new SimError('ENTITY_NOT_FOUND', entityId); return this.require(worldId).transport.describe(worldId, entityId) }
  async observe(worldId: string, selection?: ObservationSelection) { return this.require(worldId).transport.observe(worldId, selection) }
  async execute(worldId: string, action: SimAction, signal?: AbortSignal) { if (action.kind !== 'control') throw new SimError('GYMNASIUM_ACTION_KIND_UNSUPPORTED', 'Ant-v5 只接受 controller torque'); return this.step({ worldId, actionId: action.actionId, expectedGeneration: action.expectedGeneration, values: action.positions, stepCount: action.stepCount }, signal) }
  async receipt(worldId: string, actionId: string) { const world = this.require(worldId); const receipt = world.receipts.get(actionId); if (!receipt) throw new SimError('ACTION_NOT_FOUND', actionId); return structuredClone(receipt) }
  async stop(worldId: string, selection?: StopSelection) {
    const world = this.require(worldId)
    // stop selection 是正常输入，不能因为 generation 恒为 1 就静默忽略：与 MuJoCo/Isaac worker 同语义，
    // 过期代次拒绝、无效 actionId 在触碰世界状态前拒绝；首执行未返回的动作同样算“存在”。
    if (selection?.expectedGeneration !== undefined && selection.expectedGeneration !== world.generation) throw new SimError('STALE_GENERATION', '停止代次过期')
    if (selection?.actionId !== undefined && !world.receipts.has(selection.actionId) && !world.inFlight.has(selection.actionId)) throw new SimError('ACTION_NOT_FOUND', selection.actionId)
    const result = await world.transport.stop(worldId, selection)
    if (world.terminalReason === undefined) { world.terminalReason = 'cancelled'; world.status = 'cancelled'; world.handle = { ...world.handle, status: 'paused' } }
    const record = (result as any).record
    if (record && typeof record === 'object') world.record = record
    const released = finiteOrUndefined((result as any).episodeReturn)
    if (released !== undefined) { world.episodeReturn = released; world.score = released }
    return result
  }
  subscribeFrames(worldId: string, listener: (frame: Frame) => void) { return this.require(worldId).transport.subscribeFrames(worldId, listener) }
  async close(worldId: string) {
    await this.closeWorld(this.require(worldId))
  }
  /** 世界与其独占 worker 的真实回收；不做 guard，公开 close 与 dispose 共用同一实现。 */
  private async closeWorld(world: ActiveWorld) {
    const worldId = world.handle.worldId
    const failures: string[] = []
    // 世界关闭：worker 落盘最终记录并关闭官方 env。失败不吞掉，由本方法统一上报。
    try { await world.transport.close(worldId) } catch (error) { failures.push(`world close: ${error instanceof Error ? error.message : String(error)}`) }
    // 每个 episode 独占一个 worker 进程：必须先在仍有引用时处置 transport，再清空 this.world；
    // 否则 dispose 再也找不到它，标准 close→dispose 泄漏。
    try { await world.transport.dispose() } catch (error) { failures.push(`worker dispose: ${error instanceof Error ? error.message : String(error)}`) }
    // 身份守卫：只清掉本次回收的那个世界，绝不清掉释放期间可能出现的其他世界。
    if (this.world === world) this.world = undefined
    if (failures.length) throw new SimError('GYMNASIUM_CLOSE_FAILED', `episode 关闭未完全成功: ${failures.join('; ')}`)
  }
  async assist(_worldId: string, _options: { mode: 'attach'|'release'; expectedGeneration: number; objectId: string; robotId?: string; anchorBody?: string }): Promise<Record<string, unknown>> { throw new SimError('UNSUPPORTED', 'Gymnasium benchmark 不允许辅助 teleport') }
  async capture(_worldId: string, _options: { outputDir: string; cameraName?: string; width?: number; height?: number }): Promise<Record<string, unknown>> { throw new SimError('UNSUPPORTED', 'Gymnasium observation 由 env.render 提供') }
  // 命名相机族只由 MuJoCo provider 提供：Gymnasium 的观测来自官方 env.render 帧，没有自由相机可标定/调整。
  async captureMulti(): Promise<never> { throw new SimError('UNSUPPORTED', 'Gymnasium 不提供自由命名相机，多视角采集只由 MuJoCo provider 提供') }
  async listCameras(): Promise<never> { throw new SimError('UNSUPPORTED', 'Gymnasium 不暴露命名相机清单') }
  async adjustCamera(): Promise<never> { throw new SimError('UNSUPPORTED', 'Gymnasium 不允许调整相机位姿或视场') }
  async projectAnnotation(): Promise<never> { throw new SimError('UNSUPPORTED', 'Gymnasium 观测来自 env.render，无法做像素+真实深度的三维标注') }
  async exportCameraDataset(): Promise<never> { throw new SimError('UNSUPPORTED', 'Gymnasium 没有多视角采集，无法导出相机数据集') }
  async dispose(): Promise<void> {
    return this.concurrency.disposeOnce(() => this.teardown())
  }
  private async teardown(): Promise<void> {
    // 释放态先行：置位发生在任何 await 之前。释放窗口内到达的并发 load 会在 guard 处失败，
    // 不会 spawn 新 worker、更不会把一个新世界 adopt 进正在释放的适配器（旧顺序会丢引用泄漏进程）。
    this.closed = true
    // 等待在途 load 释放其 turn：load 的 worker 回收发生在 open/observe await 之后的 guard
    // 失败路径里（catch 中 await transport.dispose），若此处不等待，首载 open 尚未返回
    // （this.world 仍 undefined）时 dispose 会先于真实回收 resolve，插件卸载“等待真实回收”
    // 的承诺即不成立。load/replaceWorld 都不依赖 dispose，等待方向单向，不会互等死锁。
    await this.concurrency.pending.catch(() => undefined)
    const world = this.world
    // 由内部路径回收所持世界与 worker；不再经过 require()/guard()，否则已释放态下关不掉。
    if (world) await this.closeWorld(world).catch(() => undefined)
    // 身份守卫：只清掉等待在途 load 结束后仍持有的那个世界。
    if (this.world === world) this.world = undefined
  }
  private guard() { if (this.closed) throw new SimError('PROVIDER_CLOSED', 'Gymnasium 适配器已释放') }
  private require(worldId: string) { this.guard(); if (!this.world || this.world.handle.worldId !== worldId) throw new SimError('WORLD_NOT_FOUND', worldId); return this.world }
  private async replaceWorld() {
    const previous = this.world
    if (!previous) return
    // close 会一并回收旧 episode 独占的 worker 进程，避免孤儿 Python 进程。
    await this.close(previous.handle.worldId)
  }

  private recordSummary(world: ActiveWorld): GymnasiumRecordSummary {
    const recordPath = world.recordPath
    if (!recordPath) return { available: false, reason: 'RECORD_PATH_UNKNOWN', episodeId: world.handle.worldId, status: world.status, stepIndex: world.stepIndex, episodeReturn: world.episodeReturn, terminated: world.terminated, truncated: world.truncated }
    const file = readJsonRecord(recordPath)
    if (file) {
      return {
        recordPath,
        trajectoryPath: world.trajectoryPath,
        available: true,
        episodeId: typeof file.episodeId === 'string' ? file.episodeId : world.handle.worldId,
        status: typeof file.status === 'string' ? file.status : undefined,
        stepIndex: finiteOrUndefined(file.stepIndex),
        episodeReturn: finiteOrUndefined(file.score?.episodeReturn),
        terminated: file.terminated === true,
        truncated: file.truncated === true,
        terminal: file.terminal ?? null,
        release: file.release ?? null,
        closed: file.closed ?? null,
        recording: file.recording,
        trajectory: file.trajectory,
        score: file.score,
      }
    }
    return {
      recordPath,
      trajectoryPath: world.trajectoryPath,
      available: false,
      reason: existsSync(recordPath) ? 'RECORD_UNREADABLE' : 'RECORD_NOT_WRITTEN',
      episodeId: world.handle.worldId,
      status: world.status,
      stepIndex: world.stepIndex,
      episodeReturn: world.episodeReturn,
      terminated: world.terminated,
      truncated: world.truncated,
      terminal: world.terminalReason ? { reason: world.terminalReason, stepIndex: world.stepIndex, episodeReturn: world.episodeReturn, terminated: world.terminated, truncated: world.truncated } : null,
      release: null,
      closed: null,
      recording: { ...world.recording },
      trajectory: null,
      score: { kind: 'score-only', episodeReturn: world.episodeReturn, stepCount: world.stepIndex },
    }
  }
}

function taskActionDim(task: BenchmarkTaskSpec) { return task.action.dimensions }
