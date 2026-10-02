import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENE_COORDINATES, identityTransform, type ActionReceipt, type Frame, type SceneSnapshot, type WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { SimError, type ObservationSelection, type SimAction, type SimWorlds, type StopSelection, type WorldOptions } from '../../sim-contract/src/index.ts'
import { ProcessSimProvider } from '../../sim-contract/src/python-transport.ts'
import { assertBenchmarkPlacementRegion, isBenchmarkUnavailable, type BenchmarkPlacementRegion, type BenchmarkTaskSpec, type BenchmarkUnavailable } from '../../benchmark-contract/src/index.ts'
import { AdapterConcurrency } from '../../benchmark-contract/src/adapter-concurrency.ts'
import { DEFAULT_SUITE, catalogTasks, lookupTask } from './catalog.ts'
import { prepareIsolatedSdk, sdkProcessEnv } from './prepare.ts'
import { projectionSummary, robotJoints, sceneProjectionFrom, unavailableSceneProjection, type SceneProjectionState, type WorkerOpenResult } from './projection.ts'
import { persistProjectedScene, type SceneProjectionResult } from './scene-projection.ts'
import type { OfficialEnv, OfficialProtocol } from './protocol.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ENTITY_ID = 'official-robot'
const ENGINE_ID = 'official-suite'

export type BenchmarkLoadedWorld = WorldHandle & {
  placementRegions?: BenchmarkPlacementRegion[]
  /** 官方模型投影摘要（真实实体/关节）；Scene 文档本身只在 sim.scene(worldId) 或 viewer 接线里取。 */
  projection?: Record<string, unknown>  /** N208／DEV-034：投影落盘的可见回执（加性可选字段；ok=false 时带 code+错误原文，绝不静默）。 */
  sceneProjection?: SceneProjectionResult
}

function frameRegions(frame?: Frame): BenchmarkPlacementRegion[] | undefined {
  const regions = frame?.entities.find(entity => entity.entityId === ENTITY_ID)?.sensors?.placementRegions
  if (regions === undefined) return undefined
  if (!Array.isArray(regions)) throw new Error('BENCHMARK_PLACEMENT_REGIONS_INVALID')
  return structuredClone(regions.map(assertBenchmarkPlacementRegion))
}

/**
 * 动作请求的规范化指纹，语义对齐 sim-mujoco/isaac worker 的 requests/receipts：
 * 同一 actionId 只有请求本身逐字段相同才算重试；参数变了必须 ACTION_ID_CONFLICT，
 * 不得拿旧回执冒充新动作。
 */
function actionRequestFingerprint(values: unknown, stepCount: unknown, continuation = false): string {
  return JSON.stringify({ entityId: ENTITY_ID, kind: 'control', positions: values, stepCount, continuation })
}

/**
 * 从 worker 的 open 结果里剥出 canonical 运行句柄：只保留共享 WorldHandle 字段，
 * 不带 scene / raw projection —— 官方 Scene 约 163KB，混进任何工具输出都会被 spill 截断；
 * 完整投影继续只存在于 world.projection（Viewer 走 sim.scene(worldId) / sceneProjection(worldId)）。
 */
function canonicalWorldHandle(opened: WorkerOpenResult): WorldHandle {
  return {
    worldId: opened.worldId,
    sceneId: opened.sceneId,
    engineId: ENGINE_ID,
    engineVersion: opened.engineVersion,
    worldGeneration: opened.worldGeneration,
    appliedSceneRevision: opened.appliedSceneRevision ?? 0,
    clock: 'manual',
    timestepS: opened.timestepS,
    status: 'ready',
  }
}

export interface AdapterConfig {
  /** N190／DEV-034：worlds 根（scene-kit 的 layout.worlds 同源，由 runtime-patch 注入）；缺失时不猜路径。 */
  sceneDataRoot?: string
  /** N204／DEV-034：会话 id（场景命名空间按会话分目录 <worlds>/sessions/<sessionId>）；取不到时不猜路径。 */
  sessionId?: string
  pythonPath?: string
  workerPath?: string
  isolatedRoot?: string
  /** Root for immutable per-episode observation images; defaults to isolatedRoot/runs. */
  outputRoot?: string
  protocol?: OfficialProtocol
  onWorkerSpawn?: () => void
  /** 可选 Host 级自动载入：这份 episode 归属哪个会话必须显式声明（没有模型回合可推）。 */
  autoload?: { suite?: string; taskIndex?: number; runToEnd?: boolean; sessionId?: string }
  /** Optional product-side budget for autonomous Agent episodes; official horizon remains separate. */
  agentStepBudget?: number
}

interface ActiveWorld {
  task: BenchmarkTaskSpec
  handle: WorldHandle
  generation: number
  stepIndex: number
  status: 'ready' | 'running' | 'success' | 'timeout' | 'cancelled'
  lastSuccess: boolean
  /** 首次官方成功保留；后续交互的当前判据可变为false。 */
  firstSuccess?: {stepIndex:number;frameId?:string}
  initial: Frame
  /** Latest official frame; its image provenance is kept aligned with stepIndex/frameId. */
  current?: Frame
  receipts: Map<string, ActionReceipt>
  /** 已受理动作的规范化请求指纹，与 receipts 同生命周期；同 ID 改参时用于 ACTION_ID_CONFLICT。 */
  requests: Map<string, string>
  /** 首执行尚未返回的同 ID 等待点：同请求并入同一次执行（瞬态单飞），settle 后即清除。 */
  inFlight: Map<string, { request: string; result: Promise<ActionReceipt> }>
  env?: OfficialEnv
  transport?: ProcessSimProvider
  recording?: Record<string, unknown>
  /** 官方编译模型的真实投影；UNAVAILABLE 时只降级视觉，不中断 episode。 */
  projection: SceneProjectionState
}

function emptyScene(sceneId: string, revision = 0): SceneSnapshot {
  return { sceneId, revision, coordinates: SCENE_COORDINATES, entities: [] }
}

export class BenchmarkAdapter implements SimWorlds {
  private world?: ActiveWorld
  private closed = false
  /** DEV-018：串行 load + 释放只跑一次这条规则只有一处实现（两包此前各抄一份逐字相同的副本）。 */
  private readonly concurrency = new AdapterConcurrency()
  private listeners = new Map<string, Set<(frame: Frame) => void>>()
  autoloadTask?: Promise<void>
  constructor(readonly config: AdapterConfig = {}) {}

  startAutoload(spec: { suite?: string; taskIndex?: number; runToEnd?: boolean } = {}) {
    this.autoloadTask = this.runAutoload(spec)
    return this.autoloadTask
  }

  private async runAutoload(spec: { suite?: string; taskIndex?: number; runToEnd?: boolean }) {
    const loaded = await this.load({ suite: spec.suite, taskIndex: spec.taskIndex ?? 0 })
    if (isBenchmarkUnavailable(loaded) || this.closed) return
    if (!spec.runToEnd) return
    const snapshot = this.result({ worldId: loaded.worldId })
    const remaining = snapshot.episode.horizonSteps - snapshot.episode.stepIndex
    if (remaining <= 0) return
    const zeros = Array.from({ length: snapshot.task.action.dimensions }, () => 0)
    await this.step({
      worldId: loaded.worldId,
      actionId: 'host-run-to-end',
      expectedGeneration: loaded.worldGeneration,
      values: zeros,
      stepCount: remaining,
    })
  }

  pythonPath() {
    return this.config.pythonPath ?? resolve(here, '../../../.runtime/bench/libero-env/bin/python')
  }
  isolatedRoot() {
    return this.config.isolatedRoot ?? resolve(here, '../../../.runtime/bench')
  }
  workerPath() {
    return this.config.workerPath ?? resolve(here, '../python/worker.py')
  }
  outputRoot() {
    return this.config.outputRoot ?? join(this.isolatedRoot(), 'runs')
  }

  catalog(input: { suite?: string } = {}) {
    const suite = input.suite ?? DEFAULT_SUITE
    const tasks = catalogTasks(suite)
    return {
      suite,
      revision: tasks[0]?.benchRevision,
      tasks: tasks.map(task => ({
        taskId: task.taskId,
        languageInstruction: task.languageInstruction,
        sceneId: task.sceneId,
        source: task.source,
        episode: task.episode,
        observation: task.observation,
        action: task.action,
        evaluator: task.evaluator,
      })),
    }
  }

  prepare() {
    return prepareIsolatedSdk({ pythonPath: this.pythonPath(), isolatedRoot: this.isolatedRoot() })
  }

  async load(input: { suite?: string; taskId?: string; taskIndex?: number; seed?: number; initialStateRef?: string; worldId?: string }, signal?: AbortSignal): Promise<BenchmarkLoadedWorld | BenchmarkUnavailable> {
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

  private async loadExclusive(input: { suite?: string; taskId?: string; taskIndex?: number; seed?: number; initialStateRef?: string; worldId?: string }, signal?: AbortSignal): Promise<BenchmarkLoadedWorld | BenchmarkUnavailable> {
    const catalogTask = lookupTask(input.suite ?? DEFAULT_SUITE, input.taskId, input.taskIndex)
    // 本次 episode 真实使用的 seed/初始状态随 world.task 进入回执与结果，
    // 不能继续用目录默认值冒充调用方传入并已交给 worker/env 的输入。
    const task: BenchmarkTaskSpec = {
      ...catalogTask,
      episode: {
        ...catalogTask.episode,
        seed: input.seed ?? catalogTask.episode.seed,
        initialStateRef: input.initialStateRef ?? catalogTask.episode.initialStateRef,
      },
    }
    if (this.config.protocol) {
      await this.replaceWorld()
      this.guard() // 释放发生在 await 期间：不得再 adopt 新世界
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 已取消：不 adopt 未完成的官方世界')
      const env = this.config.protocol.createEnv({
        taskId: task.taskId,
        suite: task.benchId,
        seed: task.episode.seed,
        initialStateRef: task.episode.initialStateRef,
        horizonSteps: task.episode.horizonSteps,
        controlFrequencyHz: task.episode.controlFrequencyHz,
        actionDim: task.action.dimensions,
      })
      env.reset()
      env.setInitState(task.episode.initialStateRef)
      return this.adoptEnv(task, env, input.worldId)
    }
    const prepared = await this.prepare()
    this.guard() // 释放发生在 prepare await 期间：不得再 spawn worker
    if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 prepare 期间已取消')
    if (isBenchmarkUnavailable(prepared)) return prepared
    await this.replaceWorld()
    this.guard()
    this.config.onWorkerSpawn?.()
    const transport = new ProcessSimProvider({
      pythonPath: prepared.pythonPath,
      workerPath: this.workerPath(),
      engineName: ENGINE_ID,
      env: {
        ...sdkProcessEnv(this.isolatedRoot()),
        LYAPUNOV_BENCH_SUITE: task.benchId,
        LYAPUNOV_BENCH_TASK_ID: task.taskId,
        LYAPUNOV_BENCH_INIT: task.episode.initialStateRef,
        LYAPUNOV_BENCH_SEED: String(task.episode.seed),
        LYAPUNOV_BENCH_HORIZON: String(task.episode.horizonSteps),
        LYAPUNOV_BENCH_FREQ: String(task.episode.controlFrequencyHz),
        LYAPUNOV_BENCH_OUTPUT: this.outputRoot(),
      },
    })
    try {
      // worker 的 open 结果比共享 WorldHandle 多带 scene/projection；这里立刻剥离，
      // 只把 canonical 句柄存进 world.handle，load 返回值也只有轻量句柄 + 投影摘要 + placementRegions。
      const opened: WorkerOpenResult = await transport.open(emptyScene(task.sceneId), { worldId: input.worldId, clock: 'manual', timestepS: 1 / task.episode.controlFrequencyHz })
      // dispose 在 open await 期间返回：销毁刚拉起的 worker 后 fail-closed，绝不 adopt 到已释放的适配器上。
      this.guard()
      // 取消在 open await 期间到达：同样销毁 worker 后 fail-closed（由下方 catch 统一回收），
      // 不把无人认领的官方世界 adopt 进已取消的调用。
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 open 期间已取消')
      // 官方世界在 open 里带回真实 Scene 投影；校验通过才交给 Viewer，失败只降级视觉。
      const projection = sceneProjectionFrom(opened)
      // N190／DEV-034：投影校验通过 ⇒ 用**既有** SceneStore/atomicJSON 把它落成该会话命名空间里的 scene 文档，
      // 使既有 scene_open / 3D 面板能打开它（DEV-034 的 Viewer 侧对照通路）。
      // 失败**不中断**官方 episode（与投影 fail-closed 但不断流一致），但**不静默**：错误原文落到 projection.bridgeError。
      const bridge = await persistProjectedScene({ sceneDataRoot: this.config.sceneDataRoot, sessionId: this.config.sessionId ?? this.config.autoload?.sessionId }, projection.scene)
      if (!bridge.ok) (projection as { bridgeError?: string }).bridgeError = bridge.error
      const frame = await transport.observe(opened.worldId)
      this.guard()
      if (signal?.aborted) throw new SimError('CANCELLED', 'load 在 observe 期间已取消')
      const handle = canonicalWorldHandle(opened)
      this.world = {
        task,
        handle,
        generation: handle.worldGeneration,
        stepIndex: frame.stepIndex,
        status: 'ready',
        lastSuccess: false,
        initial: frame,
        current: frame,
        receipts: new Map(),
        requests: new Map(),
        inFlight: new Map(),
        transport,
        projection,
      }
      this.emit(frame)
      const regions = frameRegions(frame)
      return {
        ...handle,
        ...(regions === undefined ? {} : { placementRegions: regions }),
        projection: projectionSummary(projection, frame),
        // N208／DEV-034：投影落盘的**可见回执**（加性字段，不改既有字段语义）：bench_load 回执里直接能读到 ok/path/error。
        sceneProjection: bridge,
      }
    } catch (error) {
      await transport.dispose().catch(() => undefined)
      // 生命周期/取消错误必须原样上报，不能被折叠成“SDK 不可用”。
      if (error instanceof SimError && (error.code === 'PROVIDER_CLOSED' || error.code === 'CANCELLED')) throw error
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'BLOCKED', code: 'BENCHMARK_SDK_UNAVAILABLE', message, details: { pythonPath: prepared.pythonPath } }
    }
  }

  async step(input: { worldId: string; actionId: string; expectedGeneration: number; values: number[]; stepCount?: number; continueAfterSuccess?: boolean }, signal?: AbortSignal): Promise<ActionReceipt> {
    const world = this.require(input.worldId)
    if (input.expectedGeneration !== world.generation) throw new SimError('STALE_GENERATION', '动作代次与当前世界不一致')
    // 契约 §2.8.9：相同 actionId 的重试必须返回同一回执，不得重复推进官方物理。
    const request = actionRequestFingerprint(input.values, input.stepCount ?? 1, input.continueAfterSuccess === true)
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
    // 官方成功是一次性事实：firstSuccess 记录后不撤销，而 world.status 会随续接失去成功条件而回到 running。
    // 两个门共用同一份“已记录官方成功”事实，并按“先判终态、再判续接资格”排序：
    // - 终态只拦新动作：最后一步到达 success/timeout/cancelled 后，既有 actionId 的重试/冲突已在上面按回执
    //   语义处理完；此处再拒绝会把“已发生的执行事实”误报成 episode 不存在。成功后默认拒绝必须同时看
    //   firstSuccess，否则续接把 status 降回 running 后，未声明续接的普通动作会被重新放行。
    // - 续接只认已记录的首次官方成功；status 自称 success 却没有任何成功回执时 fail-closed，不凭空开续接通路。
    const recordedSuccess = world.firstSuccess !== undefined
    if (((recordedSuccess || world.status === 'success') && input.continueAfterSuccess !== true) || world.status === 'timeout' || world.status === 'cancelled') throw new SimError('BENCHMARK_EPISODE_TERMINAL', 'episode 已结束')
    if (input.continueAfterSuccess === true && !recordedSuccess) throw new SimError('BENCHMARK_CONTINUATION_REQUIRES_SUCCESS', '继续交互必须在首次官方成功之后')
    const execution = this.runStep(world, input, request, signal)
    world.inFlight.set(input.actionId, { request, result: execution })
    try {
      return await execution
    } finally {
      world.inFlight.delete(input.actionId)
    }
  }

  private async runStep(world: ActiveWorld, input: { worldId: string; actionId: string; expectedGeneration: number; values: number[]; stepCount?: number; continueAfterSuccess?: boolean }, request: string, signal?: AbortSignal): Promise<ActionReceipt> {
    // 提交前已取消：不触碰运行时，也不推进本地状态。
    if (signal?.aborted) throw new SimError('CANCELLED', '动作在提交前已取消')
    const values = input.values
    if (!Array.isArray(values) || values.length !== world.task.action.dimensions) throw new SimError('BENCHMARK_ACTION_DIMENSION_MISMATCH', '动作维数必须与官方控制器一致')
    if (!values.every(Number.isFinite)) throw new SimError('BENCHMARK_ACTION_NOT_FINITE', '动作必须有限')
    const requestedStepCount = input.stepCount ?? 1
    const agentBudget = this.config.agentStepBudget
    if (agentBudget !== undefined && (!Number.isInteger(agentBudget) || agentBudget <= 0)) throw new SimError('BENCHMARK_AGENT_BUDGET_INVALID', 'agentStepBudget 必须为正整数')
    if (agentBudget !== undefined && world.stepIndex >= agentBudget) throw new SimError('BENCHMARK_AGENT_BUDGET_EXCEEDED', 'Agent episode 已达到产品步数预算，请先 bench_close')
    const stepCount = agentBudget === undefined ? requestedStepCount : Math.min(requestedStepCount, agentBudget - world.stepIndex)
    if (!Number.isInteger(stepCount) || stepCount <= 0) throw new SimError('BENCHMARK_STEP_COUNT_INVALID', 'stepCount 必须是正整数')
    if (world.transport) {
      // 契约 §2.8 item 8：AbortSignal 必须传到运行时。transport 在取消时向 worker 发送
      // 真实 stop，并且只在收到停止确认后才返回（失败会抛错，不会冒充已停止）。
      const receipt = await world.transport.execute(world.handle.worldId, {
        actionId: input.actionId,
        expectedGeneration: world.generation,
        kind: 'control',
        entityId: ENTITY_ID,
        jointNames: values.map((_, index) => `u${index}`),
        positions: values,
        stepCount,
        ...(input.continueAfterSuccess === true ? { continueAfterSuccess: true } : {}),
      }, signal)
      world.stepIndex = receipt.endStep ?? world.stepIndex
      // Worker receipts carry the exact official observation frame. Keep it as
      // the result source; never reconstruct an image path from a shared file.
      if (receipt.finalState) world.current = structuredClone(receipt.finalState)
      else world.current = await world.transport.observe(world.handle.worldId)
      world.lastSuccess = receipt.taskAchieved === true
      if(world.lastSuccess&&!world.firstSuccess)world.firstSuccess={stepIndex:world.stepIndex,frameId:world.current?.frameId}
      const benchmarkStatus = typeof receipt.effect?.benchmarkStatus === 'string' ? receipt.effect.benchmarkStatus : undefined
      if (world.lastSuccess || benchmarkStatus === 'success') world.status = 'success'
      else if (benchmarkStatus === 'timeout' || receipt.reason === 'horizon' || world.stepIndex >= world.task.episode.horizonSteps) world.status = 'timeout'
      else if (benchmarkStatus === 'cancelled') world.status = 'cancelled'
      else world.status = 'running'
      // 本次调用已被取消且 transport 已带停止确认返回：官方终态（success/timeout）是已发生的
      // 事实，不得改写；仍在进行/未终结的世界转 cancelled，后续 step fail-closed。
      if (signal?.aborted && world.status !== 'success' && world.status !== 'timeout') world.status = 'cancelled'
      if (agentBudget !== undefined && world.stepIndex >= agentBudget && world.status === 'running') {
        world.status = 'timeout'
        receipt.reason = 'agent-budget'
        receipt.effect = { ...(receipt.effect ?? {}), benchmarkStatus: 'timeout', evaluator: world.task.evaluator.source, budget: { kind: 'agentStepBudget', limit: agentBudget } }
      }
      world.handle = { ...world.handle, status: world.status === 'running' ? 'running' : world.status === 'cancelled' ? 'paused' : world.handle.status }
      const recording = receipt.effect?.recording
      if (recording && typeof recording === 'object') world.recording = recording as Record<string, unknown>
      world.requests.set(input.actionId, request)
      world.receipts.set(input.actionId, receipt)
      if (receipt.finalState) this.emit(receipt.finalState)
      return receipt
    }
    const env = world.env!
    const start = world.stepIndex + 1
    let reward = 0
    let done = false
    for (let i = 0; i < stepCount; i++) {
      // 与 worker 的批次边界同语义：单次 env.step 不可中断，取消在下一个边界生效，剩余步数不再推进。
      if (signal?.aborted) break
      const result = env.step(values)
      world.stepIndex += 1
      world.lastSuccess = env.checkSuccess()
      reward = result.reward
      done = result.done
      if ((world.lastSuccess && input.continueAfterSuccess !== true) || done || world.stepIndex >= env.horizon) break
    }
    if(world.lastSuccess&&!world.firstSuccess)world.firstSuccess={stepIndex:world.stepIndex}
    if (world.lastSuccess) world.status = 'success'
    else if (world.stepIndex >= env.horizon || done) world.status = 'timeout'
    else world.status = 'running'
    // 本次调用已被取消且未达到官方终态：episode 转 cancelled，后续 step fail-closed（与 transport 路径同规则）。
    if (signal?.aborted && world.status !== 'success' && world.status !== 'timeout') world.status = 'cancelled'
    const frame = this.frame(world)
    world.current = frame
    const receipt: ActionReceipt = {
      actionId: input.actionId,
      worldId: world.handle.worldId,
      generation: world.generation,
      status: world.status === 'cancelled' && signal?.aborted === true ? 'cancelled' : 'completed',
      startStep: start,
      endStep: world.stepIndex,
      finalState: frame,
      taskAchieved: world.lastSuccess,
      reason: world.lastSuccess ? 'check_success' : world.status === 'timeout' ? 'horizon' : undefined,
      effect: { controlMode: 'official-controller', reward, done, benchmarkStatus: world.status, evaluator: world.task.evaluator.source, appliedControl: { kind: 'control', first: [...values], last: [...values], steps: world.stepIndex - start + 1 }, ...(input.continueAfterSuccess === true ? { continuedInteraction: true } : {}) },
    }
    if (agentBudget !== undefined && world.stepIndex >= agentBudget && world.status === 'running') {
      world.status = 'timeout'
      receipt.reason = 'agent-budget'
      receipt.effect = { ...receipt.effect, benchmarkStatus: 'timeout', budget: { kind: 'agentStepBudget', limit: agentBudget } }
    }
    world.requests.set(input.actionId, request)
    world.receipts.set(input.actionId, receipt)
    world.handle = { ...world.handle, status: world.status === 'running' ? 'running' : 'paused' }
    this.emit(frame)
    return receipt
  }

  /**
   * 终态原因：官方成功判定优先；timeout 档再按**最后一条回执的 reason** 区分"官方 horizon 走完"与
   * "产品 agent 步数预算耗尽"（两者 status 都是 timeout，只报 status 会混为一谈）。运行中返回 undefined。
   */
  private terminationReason(world: ActiveWorld): 'check_success' | 'horizon' | 'agent-budget' | 'cancelled' | undefined {
    if (world.status === 'success') return 'check_success'
    if (world.status === 'cancelled') return 'cancelled'
    if (world.status !== 'timeout') return undefined
    const last = [...world.receipts.values()].at(-1) as { reason?: string } | undefined
    return last?.reason === 'agent-budget' ? 'agent-budget' : 'horizon'
  }

  result(input: { worldId?: string } = {}) {
    const world = input.worldId ? this.require(input.worldId) : this.world
    if (!world) throw new SimError('WORLD_NOT_FOUND', '没有活动的官方套件世界')
    return {
      episode: {
        episodeId: world.handle.worldId,
        benchId: world.task.benchId,
        benchRevision: world.task.benchRevision,
        taskId: world.task.taskId,
        sceneId: world.task.sceneId,
        sceneRevision: world.handle.appliedSceneRevision,
        worldId: world.handle.worldId,
        generation: world.generation,
        seed: world.task.episode.seed,
        horizonSteps: world.task.episode.horizonSteps,
        stepIndex: world.stepIndex,
        status: world.status,
        // 终止原因必须显式带出：status 只有 timeout 一档，官方 horizon 与产品预算耗尽的 status 相同，
        // 只报 status 时调用方分不出这两件事（DEV-023 要求逐 episode 保留终止原因）。
        ...(this.terminationReason(world) === undefined ? {} : { terminationReason: this.terminationReason(world) }),
      },
      task: this.taskMetadata(world),
      initialObservation: world.initial,
      finalObservation: structuredClone(world.current ?? this.frame(world)),
      receipts: [...world.receipts.values()],
      status: world.status === 'ready' || world.status === 'running' ? 'running' : world.status,
      success: world.lastSuccess,
      ...(world.firstSuccess?{firstSuccess:world.firstSuccess}:{}),
      source: world.task.source,
      recording: world.recording ?? (world.receipts.size ? [...world.receipts.values()].at(-1)?.effect?.recording : undefined),
      // 投影状态与当前 Frame 的实体覆盖情况：让 Agent/Viewer 能判断画面与物理是否同源。
      projection: projectionSummary(world.projection, world.current),
      observation: {
        camera: (() => {
          const sensors = world.current?.entities?.find(entity => entity.entityId === ENTITY_ID)?.sensors
          const image = Object.values(sensors ?? {}).find(value => value && typeof value === 'object' && typeof (value as any).path === 'string') as any
          return typeof image?.camera === 'string' ? image.camera : 'agentview_image'
        })(),
        source: 'official-env',
        fields: world.task.observation.fields,
        ...(() => {
          const sensors = world.current?.entities?.find(entity => entity.entityId === ENTITY_ID)?.sensors
          const image = Object.values(sensors ?? {}).find(value => value && typeof value === 'object' && typeof (value as any).path === 'string') as any
          return image && typeof image.path === 'string'
            ? { agentviewPath: image.path, imagePath: image.path, image: structuredClone(image) }
            : {}
        })(),
      },
    }
  }

  /** 产品套件入口：对目录中每个 task 走同一套 bench_load/step/result/close，不注入解题动作。 */
  async runSuite(input: { suite?: string } = {}, signal?: AbortSignal) {
    if (!this.config.protocol) {
      const prepared = await this.prepare()
      if (isBenchmarkUnavailable(prepared)) return prepared
    }
    if (signal?.aborted) throw new SimError('CANCELLED', 'runSuite 在开始前已取消')
    const catalog = this.catalog({ suite: input.suite })
    const tasks: Array<Record<string, unknown>> = []
    for (let taskIndex = 0; taskIndex < catalog.tasks.length; taskIndex++) {
      const spec = catalog.tasks[taskIndex]!
      const loaded = await this.load({ suite: catalog.suite, taskIndex, taskId: spec.taskId }, signal)
      if (isBenchmarkUnavailable(loaded)) return loaded
      const values = Array.from({ length: spec.action.dimensions }, () => 0)
      await this.step({
        worldId: loaded.worldId,
        actionId: `suite-${taskIndex}`,
        expectedGeneration: loaded.worldGeneration,
        values,
        stepCount: spec.episode.horizonSteps,
      }, signal)
      const finished = this.result({ worldId: loaded.worldId })
      tasks.push({
        taskId: spec.taskId,
        taskIndex,
        status: finished.status,
        stepIndex: finished.episode.stepIndex,
        horizonSteps: finished.episode.horizonSteps,
        success: finished.success,
        evaluator: spec.evaluator.source,
        recording: finished.recording,
        // DEV-023：套件级路径也必须逐 episode 保留 observation/action/reward/终止/官方判定。
        // 此前这里只回 title/status/stepIndex/success —— 五件事实里只剩"官方判定"一件，
        // 事后从 bench_run_suite 的产物里答不出"它发了什么动作、看到什么、为什么停"。
        seed: finished.episode.seed,
        terminationReason: finished.episode.terminationReason ?? null,
        observation: {
          source: finished.observation.source,
          camera: finished.observation.camera,
          fields: finished.observation.fields,
          agentviewPath: finished.observation.agentviewPath ?? null,
        },
        actions: finished.receipts.map(receipt => ({
          actionId: receipt.actionId,
          startStep: receipt.startStep ?? null,
          endStep: receipt.endStep ?? null,
          appliedControl: receipt.effect?.appliedControl ?? null,
        })),
        rewards: finished.receipts.map(receipt => ({
          actionId: receipt.actionId,
          reward: receipt.effect?.reward ?? null,
          done: receipt.effect?.done ?? null,
          benchmarkStatus: receipt.effect?.benchmarkStatus ?? null,
        })),
        officialJudgement: { evaluator: spec.evaluator.source, success: finished.success, status: finished.status },
      })
      await this.close(loaded.worldId)
    }
    return {
      suite: catalog.suite,
      revision: catalog.revision,
      tasks,
      incomplete: tasks.some(task => task.status === 'running'),
    }
  }

  async listWorlds() {
    this.guard()
    return this.world ? [this.world.handle] : []
  }
  /**
   * 官方 Scene 投影：实体来自编译模型的真实 body/mesh/关节，可直接交给 viewer.setScene + setWorld。
   * 取不到时抛 SimError（fail-closed），不会给 Viewer 一个半成品场景。
   */
  scene(worldId: string): SceneSnapshot {
    const world = this.require(worldId)
    if (!world.projection.scene) {
      throw new SimError(world.projection.code ?? 'BENCHMARK_SCENE_UNAVAILABLE', world.projection.message ?? '当前世界没有官方 Scene 投影')
    }
    return structuredClone(world.projection.scene)
  }
  /** Scene 投影摘要 + 当前 Frame 覆盖检查；供 shell 在接线前确认实体/关节是否对得上。 */
  sceneProjection(worldId: string) {
    const world = this.require(worldId)
    return projectionSummary(world.projection, world.current ?? this.frame(world))
  }
  async open(_snapshot: SceneSnapshot, _options?: WorldOptions): Promise<WorldHandle> {
    throw new SimError('PROVIDER_UNAVAILABLE', '官方套件世界请通过 bench_load 载入；Scene 文档不能代替官方 reset/set_init_state')
  }
  async sync(worldId: string) {
    return this.require(worldId).handle
  }
  async describe(worldId: string, entityId: string) {
    const world = this.require(worldId)
    const robot = world.task.robot
    if (entityId !== (robot?.entityId ?? ENTITY_ID)) throw new SimError('ENTITY_NOT_FOUND', entityId)
    // 真实关节优先：名称/类型/单位来自官方编译模型，而不是任务清单里的占位名。
    const projected = robotJoints(world.projection)
    return {
      entityId: robot?.entityId ?? entityId,
      modelVersion: robot?.modelVersion ?? world.task.taskId,
      expectedGeneration: world.generation,
      collisionContextVersion: world.task.taskId,
      joints: projected.length
        ? projected.map(joint => ({ name: joint.name, type: joint.type, unit: joint.unit }))
        : (robot?.joints ?? []).map(name => ({ name, type: 'hinge' as const, unit: 'rad' as const })),
      controlledJointNames: robot?.controlledJointNames ?? [],
      ...(() => {
        const regions = this.taskMetadata(world).placementRegions
        return regions === undefined ? {} : { placementRegions: regions }
      })(),
      controller: { controlMode: 'official-controller', kind: world.task.action.kind, dimensions: world.task.action.dimensions, units: world.task.action.units, lower: world.task.action.lower, upper: world.task.action.upper, frequencyHz: world.task.action.controlFrequencyHz, coordinateFrame: world.task.action.coordinateFrame, axisNames: world.task.action.axisNames, observationFields: world.task.observation.fields, gripper: { maxWidthM: 0.08 } },
    }
  }
  async observe(worldId: string, _selection?: ObservationSelection) {
    const world = this.require(worldId)
    if (world.transport) {
      world.current = await world.transport.observe(worldId)
      return structuredClone(world.current)
    }
    return this.frame(world)
  }
  async execute(worldId: string, action: SimAction, signal?: AbortSignal) {
    if (action.kind === 'joint' || action.kind === 'gripper') {
      // 面板直控：原样转发 worker 的 servo 通道（诚实物理，不走 qpos 旁路）；回执状态同步与 runStep 同规则。
      const world = this.require(worldId)
      if (action.expectedGeneration !== world.generation) throw new SimError('STALE_GENERATION', '动作代次与当前世界不一致')
      // 官方成功是一次性事实：firstSuccess 记录后即使 status 回落也不得重新放开面板直控（面板直控没有续接通道）。
      if (world.firstSuccess !== undefined || world.status === 'success' || world.status === 'timeout' || world.status === 'cancelled') throw new SimError('BENCHMARK_EPISODE_TERMINAL', 'episode 已结束')
      if (!world.transport) throw new SimError('BENCHMARK_ACTION_KIND_UNSUPPORTED', '注入的 protocol double 不支持面板直控')
      const receipt = await world.transport.execute(world.handle.worldId, action, signal)
      world.stepIndex = receipt.endStep ?? world.stepIndex
      if (receipt.finalState) world.current = structuredClone(receipt.finalState)
      else world.current = await world.transport.observe(world.handle.worldId)
      world.lastSuccess = receipt.taskAchieved === true
      const benchmarkStatus = typeof receipt.effect?.benchmarkStatus === 'string' ? receipt.effect.benchmarkStatus : undefined
      if (world.lastSuccess || benchmarkStatus === 'success') world.status = 'success'
      else if (benchmarkStatus === 'timeout' || receipt.reason === 'horizon' || world.stepIndex >= world.task.episode.horizonSteps) world.status = 'timeout'
      else if (benchmarkStatus === 'cancelled') world.status = 'cancelled'
      else world.status = 'running'
      if (signal?.aborted && world.status !== 'success' && world.status !== 'timeout') world.status = 'cancelled'
      world.handle = { ...world.handle, status: world.status === 'running' ? 'running' : world.status === 'cancelled' ? 'paused' : world.handle.status }
      const recording = receipt.effect?.recording
      if (recording && typeof recording === 'object') world.recording = recording as Record<string, unknown>
      world.receipts.set(action.actionId, receipt)
      if (receipt.finalState) this.emit(receipt.finalState)
      return receipt
    }
    if (action.kind !== 'control') throw new SimError('BENCHMARK_ACTION_KIND_UNSUPPORTED', '官方套件只接受控制器动作，请使用 bench_step')
    return this.step({ worldId, actionId: action.actionId, expectedGeneration: action.expectedGeneration, values: action.positions, stepCount: action.stepCount }, signal)
  }
  async receipt(worldId: string, actionId: string) {
    const world = this.require(worldId)
    const cached = world.receipts.get(actionId)
    if (cached) return structuredClone(cached)
    if (world.transport) return world.transport.receipt(worldId, actionId)
    throw new SimError('ACTION_NOT_FOUND', actionId)
  }
  async stop(worldId: string, selection?: StopSelection) {
    const world = this.require(worldId)
    if (selection?.expectedGeneration !== undefined && selection.expectedGeneration !== world.generation) throw new SimError('STALE_GENERATION', '停止代次过期')
    // stop selection 与 MuJoCo/Isaac worker 同语义：无效 actionId 必须在触碰世界状态之前拒绝；
    // 首执行尚未返回的动作同样算“存在”——stop 的用途之一就是中断活动 execute。
    if (selection?.actionId !== undefined && !world.receipts.has(selection.actionId) && !world.inFlight.has(selection.actionId)) {
      throw new SimError('ACTION_NOT_FOUND', selection.actionId)
    }
    // 契约 §2.8 item 8：取消请求返回与真实停止确认分清。先拿运行时确认，再改产品状态；
    // 停止失败（worker 拒绝 / 传输错误）不得冒充已停止，否则世界卡在 cancelled 终态门而物理未停。
    const result = world.transport
      ? await world.transport.stop(worldId, selection)
      : { stopped: true as const, stepIndex: world.stepIndex, receipts: [...world.receipts.values()] }
    // 官方终态（success/timeout）是已发生的事实，不能被“停止”改写成 cancelled；
    // 仍在跑的 episode 在确认真实停止后才转 cancelled。
    if (world.status !== 'success' && world.status !== 'timeout') world.status = 'cancelled'
    world.handle = { ...world.handle, status: 'paused' }
    return result
  }
  subscribeFrames(worldId: string, listener: (frame: Frame) => void) {
    let set = this.listeners.get(worldId)
    if (!set) this.listeners.set(worldId, set = new Set())
    set.add(listener)
    return () => { set!.delete(listener) }
  }
  async close(worldId: string) {
    await this.closeWorld(this.require(worldId))
  }
  /** 世界与其独占 worker 的真实回收；不做 guard，公开 close 与 dispose 共用同一实现。 */
  private async closeWorld(world: ActiveWorld) {
    const worldId = world.handle.worldId
    this.listeners.delete(worldId)
    const failures: string[] = []
    // 注入的 protocol double 由适配器持有，随世界一起关闭；真实 worker 的官方 env 由 worker 自己关闭。
    try { world.env?.close() } catch (error) { failures.push(`env close: ${error instanceof Error ? error.message : String(error)}`) }
    // 每个 episode 独占一个 worker 进程：必须先在仍有引用时处置 transport，再清空 this.world；
    // 否则 dispose 再也找不到它，标准 close→dispose 泄漏。
    try { await world.transport?.close(worldId) } catch (error) { failures.push(`world close: ${error instanceof Error ? error.message : String(error)}`) }
    try { await world.transport?.dispose() } catch (error) { failures.push(`worker dispose: ${error instanceof Error ? error.message : String(error)}`) }
    // 身份守卫：只清掉本次回收的那个世界，绝不清掉释放期间可能出现的其他世界。
    if (this.world === world) this.world = undefined
    if (failures.length) throw new SimError('BENCHMARK_CLOSE_FAILED', `episode 关闭未完全成功: ${failures.join('; ')}`)
  }
  async assist(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件不允许 attach/teleport 辅助')
  }
  async capture(): Promise<never> {
    throw new SimError('UNSUPPORTED', '请使用官方观察；采集走 bench_step 返回的 observation')
  }
  // 命名相机族只由 MuJoCo provider 提供：官方套件的相机由套件自己固定，没有可调整/可标定的命名相机。
  async captureMulti(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件不提供自由命名相机；多视角采集只由 MuJoCo provider 提供')
  }
  async listCameras(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件不暴露命名相机清单')
  }
  async adjustCamera(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件不允许调整相机位姿或视场')
  }
  async projectAnnotation(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件观测由 bench_step 提供，无法做像素+真实深度的三维标注')
  }
  async exportCameraDataset(): Promise<never> {
    throw new SimError('UNSUPPORTED', '官方套件没有多视角采集，无法导出相机数据集')
  }
  async dispose(): Promise<void> {
    return this.concurrency.disposeOnce(() => this.teardown())
  }
  private async teardown(): Promise<void> {
    // 释放态先行：置位发生在任何 await 之前。释放窗口内到达的并发 load 会在 guard 处失败，
    // 不会 spawn 新 worker、更不会把一个新世界 adopt 进正在释放的适配器（旧顺序会丢引用泄漏进程）。
    this.closed = true
    // 等待在途 load 释放其 turn：load 的 worker 回收发生在 open/observe await 之后的 guard
    // 失败路径里，若此处不等待，首载 open 尚未返回（this.world 仍 undefined）时 dispose 会
    // 先于真实回收 resolve，插件卸载“等待真实回收”的承诺即不成立。load 不依赖 dispose，
    // 等待方向单向，不会与 load/replaceWorld 互等。
    await this.concurrency.pending.catch(() => undefined)
    const world = this.world
    // 由内部路径回收所持世界与 worker；不再经过 require()/guard()，否则已释放态下关不掉。
    if (world) await this.closeWorld(world).catch(() => undefined)
    // 身份守卫：只清掉等待在途 load 结束后仍持有的那个世界。
    if (this.world === world) this.world = undefined
  }

  private guard() {
    if (this.closed) throw new SimError('PROVIDER_CLOSED', '官方套件适配器已释放')
  }
  private require(worldId: string) {
    this.guard()
    if (!this.world || this.world.handle.worldId !== worldId) throw new SimError('WORLD_NOT_FOUND', worldId)
    return this.world
  }
  private async replaceWorld() {
    const previous = this.world
    if (!previous) return
    // close 会一并回收旧 episode 独占的 worker 进程；旧世界关不掉时不能吞掉失败假装新世界载入成功。
    await this.close(previous.handle.worldId)
  }
  private adoptEnv(task: BenchmarkTaskSpec, env: OfficialEnv, worldId?: string) {
    const handle: WorldHandle = {
      worldId: worldId ?? randomUUID(),
      sceneId: task.sceneId,
      engineId: ENGINE_ID,
      engineVersion: task.benchRevision,
      worldGeneration: 1,
      appliedSceneRevision: 0,
      clock: 'manual',
      timestepS: 1 / task.episode.controlFrequencyHz,
      status: 'ready',
    }
    const world: ActiveWorld = {
      task, handle, generation: 1, stepIndex: 0, status: 'ready', lastSuccess: env.checkSuccess(), receipts: new Map(), requests: new Map(), inFlight: new Map(), env,
      projection: unavailableSceneProjection('BENCHMARK_SCENE_UNAVAILABLE', '注入的 protocol double 不提供官方模型投影；只有真实 worker 会产出 Scene'),
      initial: { worldId: handle.worldId, generation: 1, sceneRevision: 0, stepIndex: 0, simTime: 0, frameId: `${handle.worldId}:1:0`, entities: [{ entityId: ENTITY_ID, transform: identityTransform() }] },
    }
    world.initial = this.frame(world)
    this.world = world
    this.emit(world.initial)
    const regions = frameRegions(world.initial)
    return { ...handle, ...(regions === undefined ? {} : { placementRegions: regions }), projection: projectionSummary(world.projection, world.initial) }
  }
  private taskMetadata(world: ActiveWorld): BenchmarkTaskSpec {
    const regions = frameRegions(world.current ?? this.frame(world))
    return { ...world.task, ...(regions === undefined ? {} : { placementRegions: regions }) }
  }
  private frame(world: ActiveWorld): Frame {
    const regions = world.env?.placementRegions?.()
    return {
      worldId: world.handle.worldId,
      generation: world.generation,
      sceneRevision: world.handle.appliedSceneRevision,
      stepIndex: world.stepIndex,
      simTime: world.stepIndex / world.task.episode.controlFrequencyHz,
      frameId: `${world.handle.worldId}:${world.generation}:${world.stepIndex}`,
      entities: [{ entityId: ENTITY_ID, transform: identityTransform(), ...(regions === undefined ? {} : { sensors: { placementRegions: structuredClone(regions) } }) }],
    }
  }
  private emit(frame: Frame) {
    for (const listener of this.listeners.get(frame.worldId) ?? []) {
      try { listener(structuredClone(frame)) } catch { /* 订阅者不能中断官方时钟 */ }
    }
  }
}
