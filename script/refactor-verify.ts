/**
 * 重构验收薄入口（合同 §6.4）。
 *
 * 只做三件事：解析 `--gate`、调用**既有产品实现**跑一次真实行为、按退出码语义汇总。
 * 不新建测试框架、不新建 Provider、不复制产品逻辑；夹具是真实 MJCF，引擎是真实 MuJoCo worker。
 *
 * 退出码：0 全部通过；1 实际失败；2 必需依赖未完成（BLOCKED）。
 *
 * 用法：
 *   bun run script/refactor-verify.ts --gate G04 --engine mujoco
 *   bun run script/refactor-verify.ts --all
 */
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { SceneStore } from "../packages/scene-kit/src/store.ts"
import { SceneOperations } from "../packages/scene-kit/src/operations.ts"
import { MuJoCoProvider } from "../packages/sim-mujoco/src/provider.ts"
import { createRobotOperations } from "../packages/robot-tools/src/operations.ts"
// 各门实现拆到 script/gates/：独立可运行、可单独审阅，本文件只做解析/汇总/退出码。
import { gateG15 } from "./gates/g15.ts"
import { gateG14 } from "./gates/g14.ts"
import { gateG10 } from "./gates/g10.ts"
import { gateG08, gateG09, tallyGate, type GateTally, type RemovedScope } from "./gates/g08g09.ts"
import { gateG12 } from "./gates/g12.ts"
import { gateG13 } from "./gates/g13.ts"
import { gateG17 } from "./gates/g17.ts"
import { gateG13Acp } from "./gates/g13-acp.ts"
import { gateG01Live } from "./gates/g01-live.ts"
import { gateG15Live } from "./gates/g15-live.ts"
import { gateG11Live } from "./gates/g11-live.ts"
import { gateG11 } from "./gates/g11.ts"
import { FIXED_GRASP_CONFIG, liftAchieved, offsetLooksBlocked, OFFSET_BLOCKED_MIN_CLOSED_TOTAL_M } from "./gates/g07-calibration.ts"
import { reopenVerdict, singleClockVerdict, type ClockFrame } from "./gates/g03-clock.ts"
import { executePose, pick, place } from "../packages/robot-workflows/src/pick-place.ts"
import { proposeAnalytic } from "../packages/grasp-analytic/src/index.ts"
import { motionRequest } from "../packages/motion-mink/src/request.ts"
import type { SimAction } from "../packages/sim-contract/src/index.ts"
import type { Frame, GraspCandidate, MotionPlan, SceneSnapshot } from "../packages/lyapunov-contracts/src/types.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "..")
const KUKA_MJCF = join(PRODUCT_ROOT, "materials/robots/github-agent-selected-validation/kuka_iiwa_14/scene.xml")

/** 单个 check 的真实结果；expected/actual 必须来自实际调用，不接受硬编码成功。 */
interface Check { name: string; ok: boolean; detail: string }
interface GateResult { gate: string; checks: Check[]; blocked: string | null }

const engines = ["mujoco", "isaac", "none"] as const
function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) { values.set(key, next); index++ }
    else flags.add(key)
  }
  return { values, flags }
}

/** 一个临时工作根 + 真实 scene/sim/robot 装配；用完必须 dispose。 */
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "lyaup-verify-"))
  const scenes = new SceneOperations(directory, PRODUCT_ROOT)
  const provider = new MuJoCoProvider({ pythonPath: join(PRODUCT_ROOT, ".runtime/sim-python/bin/python"), workerPath: join(PRODUCT_ROOT, "packages/sim-mujoco/python/worker.py") })
  const store = new SceneStore(directory)
  const operations = createRobotOperations(provider, store)
  return {
    directory, scenes, provider, store, operations,
    async dispose() { try { await provider.dispose() } finally { await rm(directory, { recursive: true, force: true }) } },
  }
}

/**
 * G04：移除注册/Forge/记忆运行依赖后导入标准臂。
 * 合同 §6.2 G04 通过条件：无 LLM Key 确定性 load/state/move；两个 entity 独立；无动态同构 Tool 暴涨。
 * 本入口覆盖 engine 侧（load/state/move/两实体独立）；"Tool 数量不暴涨"由工具面注册计数另行登记。
 */
async function gateG04(): Promise<GateResult> {
  const checks: Check[] = []
  const h = await harness()
  try {
    const created = await h.scenes.create({ sceneId: "verify-g04", name: "g04" })
    checks.push({ name: "scene_create", ok: created.revision === 0 && created.entities.length === 0, detail: `revision=${created.revision} entities=${created.entities.length}` })

    const imported = await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm-a" })
    const revisionAfterImport = imported.snapshot?.revision
    checks.push({ name: "scene_import_mjcf", ok: Boolean(imported.entityId), detail: `entityId=${imported.entityId} revision=${revisionAfterImport}` })

    // 第二台**同型**实例在 `sim_open` **之前**就进 Scene（与 G06 同一做法）。
    // 一开始我写成 open 之后再 import + sim_sync，结果 `sim_sync` 推进了 worldGeneration，
    // 先前捕获的 `world.worldGeneration` 立即过期，动作被"直接动作请求的模型代次已过期"拒绝——
    // 这本身是 §2.8-7 期望的拒绝行为，但作为夹具写错了位置。
    const importedB = await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm-b", transform: { position: [0.9, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } })
    checks.push({ name: "scene_import_second_same_type_instance", ok: importedB.entityId === "arm-b", detail: `第二台同型实例入 Scene：entityId=${importedB.entityId}（同一 MJCF 路径）` })

    const world = await h.operations.sim_open({ sceneId: created.sceneId })
    checks.push({ name: "sim_open", ok: Boolean(world.worldId), detail: `worldId=${world.worldId} engine=${world.engineId} generation=${world.worldGeneration}` })

    const loaded = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "arm-a" })
    checks.push({ name: "robot_load", ok: loaded.robot.entityId === "arm-a", detail: `joints=${loaded.robot.joints.length} controlled=${loaded.robot.controlledJointNames.length}` })

    const frame = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    const observed = frame.entities.find(entity => entity.entityId === "arm-a")
    checks.push({ name: "robot_state", ok: observed !== undefined, detail: `stepIndex=${frame.stepIndex} entities=${frame.entities.length} observed=${observed ? "yes" : "no"}` })
    if (observed === undefined) return { gate: "G04", checks, blocked: null }

    // move：全关节写入一次完整目标（合同 §6.2 G06 要求"全关节共同写入后 step"）。
    // 容差与稳定时间显式给出，取引擎 worker 自身的默认判据（position 动作 tolerance 默认 0.03 rad、
    // settleTimeS 默认 0.3s），不另造一套更严或更松的私有阈值。
    const jointNames = loaded.robot.controlledJointNames
    const targets = jointNames.map((_, index) => 0.05 * (index + 1))
    const tolerance = 0.03
    const action: SimAction = { actionId: `verify-move-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "arm-a", jointNames, positions: targets, durationS: 1, settleTimeS: 0.5, tolerance }
    const receipt = await h.operations.robot_move({ worldId: world.worldId, action })
    checks.push({ name: "robot_move_receipt", ok: receipt.status === "completed", detail: `status=${receipt.status} startStep=${receipt.startStep} endStep=${receipt.endStep}` })

    const after = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    const movedEntity = after.entities.find(entity => entity.entityId === "arm-a")
    // joints 是并行数组（names/positions），按名取目标关节的实际位置，不按索引假设顺序。
    const measured = jointNames.map((name, index) => {
      const at = movedEntity?.joints?.names.indexOf(name) ?? -1
      return at < 0 ? Number.NaN : Math.abs((movedEntity!.joints!.positions[at] ?? Number.NaN) - targets[index]!)
    })
    const delta = measured.length && measured.every(Number.isFinite) ? Math.max(...measured) : Number.NaN
    // 真实物理位移：按上面显式声明的 tolerance 判定，并同时报告实测最大误差供复核。
    checks.push({ name: "robot_move_actual_displacement", ok: Number.isFinite(delta) && delta <= tolerance, detail: `maxError=${delta} tolerance=${tolerance} jointsMeasured=${measured.filter(Number.isFinite).length}/${jointNames.length} stepIndex=${after.stepIndex}` })

    // 引擎自身的达成判定（worker 侧 targetReached）经 Provider 回执带出。
    // 回执把每个动作的效果放在 effect.motions 里，逐 motion 读它真实给出的键，不假定存在。
    const effect = (receipt.effect ?? {}) as Record<string, unknown>
    const motions = Array.isArray(effect.motions) ? effect.motions as Array<Record<string, unknown>> : []
    const motion = motions.find(item => item.entityId === "arm-a") ?? motions[0]
    const withinTolerance = Number.isFinite(delta) && delta <= tolerance
    const engineReached = motion?.targetReached
    checks.push({
      name: "engine_target_reached",
      ok: typeof engineReached === "boolean" ? engineReached === withinTolerance : false,
      detail: `motion.targetReached=${String(engineReached)} measuredWithinTolerance=${String(withinTolerance)} motionKeys=[${motion ? Object.keys(motion).join(",") : ""}]`,
    })

    const stopped = await h.operations.robot_stop({ worldId: world.worldId, entityIds: ["arm-a"] })
    checks.push({ name: "robot_stop", ok: stopped.stopped === true, detail: `stepIndex=${stopped.stepIndex} receipts=${stopped.receipts.length}` })

    // ── 合同 §6.2 G04 的另两项通过条件：「两个 entity 独立」与「无动态同构 Tool 暴涨」。
    //    覆盖面审计指出这两条此前**全门无 check**（源码注释 L80 还曾声称"两实体独立"已覆盖，与实现不符）。
    //    第二台同型实例已在 sim_open 前入 Scene；这里加载它并对两台下**不同**目标，逐台量真实位移。
    const second = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "arm-b" })
    checks.push({
      name: "two_same_type_entities_are_independent",
      ok: second.robot.entityId === "arm-b" && second.robot.joints.length === loaded.robot.joints.length,
      detail: `第二台同型实例：entityId=${second.robot.entityId}；关节数 A=${loaded.robot.joints.length} B=${second.robot.joints.length}（同型应相等）；`
        + `受控关节名一致=${JSON.stringify(loaded.robot.controlledJointNames) === JSON.stringify(second.robot.controlledJointNames)}`,
    })

    const positionOfAll = async (): Promise<Record<string, number[]>> => {
      const snapshot = await h.operations.robot_state({ worldId: world.worldId })
      return Object.fromEntries(snapshot.entities.map(entity => [entity.entityId, (entity.joints?.positions ?? []).slice()]))
    }
    const targetsOf = (offset: number) => loaded.robot.controlledJointNames.map((_, index) => offset + 0.05 * (index + 1))
    const beforeBoth = await positionOfAll()
    const targetsA = targetsOf(0), targetsB = targetsOf(0.3)
    const moveFor = (entityId: string, positions: number[]) => ({
      actionId: `verify-g04-${entityId}-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint" as const,
      entityId, jointNames: loaded.robot.controlledJointNames, positions, durationS: 1, settleTimeS: 0.5, tolerance,
    })
    const receiptA = await h.operations.robot_move({ worldId: world.worldId, action: moveFor("arm-a", targetsA) })
    const receiptB = await h.operations.robot_move({ worldId: world.worldId, action: moveFor("arm-b", targetsB) })
    const afterBoth = await positionOfAll()
    // 逐台算"目标 vs 实测"的最大误差。若两台共用同一份状态（互相覆盖），其中一台必然明显偏离自己的目标。
    const errorFor = (entityId: string, targets: number[]): number => {
      const after = afterBoth[entityId], before = beforeBoth[entityId]
      if (!after || !before) return Number.NaN
      const errors = loaded.robot.controlledJointNames.map((name, index) => {
        const at = after.length === loaded.robot.controlledJointNames.length ? index : -1
        return at < 0 ? Number.NaN : Math.abs((after[at] ?? Number.NaN) - targets[index]!)
      })
      return errors.every(Number.isFinite) ? Math.max(...errors) : Number.NaN
    }
    const errorA = errorFor("arm-a", targetsA), errorB = errorFor("arm-b", targetsB)
    checks.push({
      name: "per_entity_commands_do_not_cross",
      ok: Number.isFinite(errorA) && Number.isFinite(errorB) && errorA <= tolerance && errorB <= tolerance
        && receiptA.status === "completed" && receiptB.status === "completed",
      detail: `两台同型机器人各自下不同目标（A 偏移 0.0 / B 偏移 0.3，同为 ${loaded.robot.controlledJointNames.length} 关节）：`
        + `A 回执=${receiptA.status}、B 回执=${receiptB.status}；**逐台实测**最大误差 A=${errorA}、B=${errorB}（容差 ${tolerance}）——`
        + `两台同时满足各自目标，即命令与状态都按 entityId 分离，不是共用一份状态`,
    })

    // 工具面：合同 §2.5 禁止"按每个机器人生成一批同构 Tools"。这条**不是**运行时读数：
    // 会话事件流里没有"已注册工具清单"事件（实测 :385 tool/call 只有 name/arguments），
    // 所以这里读的是产品的**工具面声明表**本身。它是源码级读数，**不冒充运行时计数**。
    const operationsSource = await readFile(join(PRODUCT_ROOT, "packages/robot-tools/src/operations.ts"), "utf8")
    const declaredToolNames = [...operationsSource.matchAll(/^\s{2,4}([a-z][a-z0-9_]*):/gm)].map(match => match[1]!)
    const entityBearing = declaredToolNames.filter(name => /arm[-_]?[ab0-9]|entity[-_]?[0-9]|joint[0-9]|_j[0-9]/.test(name))
    checks.push({
      name: "tool_surface_is_entity_independent_source_read",
      ok: declaredToolNames.length > 0 && entityBearing.length === 0,
      detail: `**源码级读数**（packages/robot-tools/src/operations.ts 的导出操作表）：声明工具面 ${declaredToolNames.length} 个——`
        + `[${declaredToolNames.join(", ")}]；其中**带实体/关节标识的名字=${entityBearing.length}**`
        + `${entityBearing.length ? `（${entityBearing.join(", ")}）` : "（名字里没有 arm-a/entityId/joint0 之类，目标一律由输入参数 `entityId` 指定）"}；`
        + `全关节在一个工具里以有序数组传入（joint_move/robot_move），不按关节生成同构工具。`
        + `**口径声明**：会话事件流不含"已注册工具清单"事件，故本项不是运行时计数，只证明工具面声明与实体数量/关节数量无关`,
    })

    const closed = await h.operations.sim_close({ worldId: world.worldId })
    checks.push({ name: "sim_close", ok: closed.closed === true, detail: `closed=${closed.closed}` })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return { gate: "G04", checks, blocked: null }
}

/**
 * G06：机械臂完整轨迹与双机器人 batch；中途 stop；旧代次无写入。
 * 合同 §6.2 G06 通过条件：全关节共同写入后 step；batch 同 tick 开始；停止后不继续目标；
 * 旧代次命令被拒。冲突命令与"模型整体重载"由后续切片补齐，本入口先覆盖可确定复现的四项。
 */
async function gateG06(): Promise<GateResult> {
  const checks: Check[] = []
  const h = await harness()
  try {
    const created = await h.scenes.create({ sceneId: "verify-g06", name: "g06" })
    await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm-a" })
    // 第二个实例：同型不同 entityId，各自独立位置，验证"不靠每机器人一套工具/一套实现"。
    await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm-b", transform: { position: [0.9, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } })

    const world = await h.operations.sim_open({ sceneId: created.sceneId })
    const loadedA = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "arm-a" })
    const loadedB = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "arm-b" })
    checks.push({ name: "two_instances_loaded", ok: loadedA.robot.entityId === "arm-a" && loadedB.robot.entityId === "arm-b", detail: `a_joints=${loadedA.robot.joints.length} b_joints=${loadedB.robot.joints.length}` })

    // batch：两个实体同一次提交，必须同 tick 开始（worker 要求成员实体非空且不重复）。
    const namesA = loadedA.robot.controlledJointNames
    const namesB = loadedB.robot.controlledJointNames
    const targetsA = namesA.map((_, index) => 0.04 * (index + 1))
    const targetsB = namesB.map((_, index) => -0.03 * (index + 1))
    const batch: SimAction = {
      actionId: `verify-batch-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "batch",
      motions: [
        { kind: "joint", entityId: "arm-a", jointNames: namesA, positions: targetsA, durationS: 1, settleTimeS: 0.5, tolerance: 0.03 },
        { kind: "joint", entityId: "arm-b", jointNames: namesB, positions: targetsB, durationS: 1, settleTimeS: 0.5, tolerance: 0.03 },
      ],
    }
    const receipt = await h.operations.sim_execute_batch({ worldId: world.worldId, action: batch })
    const effect = (receipt.effect ?? {}) as { motions?: Array<{ entityId?: string; startStep?: number }>; childrenStartSteps?: unknown }
    const performed = effect.motions ?? []
    // 同 tick 开始的真实依据：Provider 给出的 childrenStartSteps。它的具体形状由 Provider 决定，
    // 这里只把真实值取出来判等，不假定是数组还是映射。
    const children = effect.childrenStartSteps
    const starts: unknown[] = Array.isArray(children) ? children : children && typeof children === "object" ? Object.values(children as Record<string, unknown>) : []
    checks.push({ name: "batch_receipt_completed", ok: receipt.status === "completed", detail: `status=${receipt.status} startStep=${receipt.startStep} endStep=${receipt.endStep} childrenStartSteps=${JSON.stringify(children)}` })
    checks.push({ name: "batch_same_tick_start", ok: starts.length === 2 && starts.every(start => start === starts[0]), detail: `starts=[${starts.join(",")}] entities=[${performed.map(motion => motion.entityId).join(",")}] effectKeys=[${Object.keys(effect).join(",")}]` })

    // 两个实体都发生真实位移，且互不干扰。
    // robot_state 每次只观测一个实体；两个实体各观测一次，避免依赖"一次 observe 返回全部"的假设。
    const frameA = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    const frameB = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-b" })
    const errorFor = (frame: { entities: Array<{ entityId: string; joints?: { names: string[]; positions: number[] } }> }, entityId: string, names: string[], targets: number[]) => {
      const entity = frame.entities.find(item => item.entityId === entityId)
      const errors = names.map((name, index) => {
        const at = entity?.joints?.names.indexOf(name) ?? -1
        return at < 0 ? Number.NaN : Math.abs((entity!.joints!.positions[at] ?? Number.NaN) - targets[index]!)
      })
      return errors.every(Number.isFinite) && errors.length ? Math.max(...errors) : Number.NaN
    }
    const errorA = errorFor(frameA, "arm-a", namesA, targetsA)
    const errorB = errorFor(frameB, "arm-b", namesB, targetsB)
    checks.push({ name: "batch_both_displaced", ok: Number.isFinite(errorA) && Number.isFinite(errorB) && errorA <= 0.03 && errorB <= 0.03, detail: `maxErrorA=${errorA} maxErrorB=${errorB} tolerance=0.03 stepIndexA=${frameA.stepIndex} stepIndexB=${frameB.stepIndex}` })

    // 中途 stop：长动作执行中停止，停止后目标不再被继续驱动。
    const longAction: SimAction = { actionId: `verify-long-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "arm-a", jointNames: namesA, positions: namesA.map(() => 1.2), durationS: 8, settleTimeS: 0.2, tolerance: 0.03 }
    const pending = h.operations.robot_move({ worldId: world.worldId, action: longAction })
    await new Promise(resolve => setTimeout(resolve, 250))
    const stopped = await h.operations.robot_stop({ worldId: world.worldId, entityIds: ["arm-a"] })
    const pendingReceipt = await pending
    // 覆盖面审计指出：`pendingReceipt.status === "cancelled"`（"取消请求返回与真实停止确认分清"，
    // §2.8-8）此前只印在 detail 里、**没有进断言**——于是这条 check 名字叫 mid_action_stop，
    // 实际只断言了 `stopped.stopped === true`。现把"回执终态确实是 cancelled"纳入判据。
    checks.push({
      name: "mid_action_stop",
      ok: stopped.stopped === true && pendingReceipt.status === "cancelled",
      detail: `stoppedAtStep=${stopped.stepIndex} affected=[${(stopped.affectedEntityIds ?? []).join(",")}] `
        + `pendingReceipt.status=${pendingReceipt.status}（**须为 cancelled**）receiptKeys=[${Object.keys(pendingReceipt as unknown as Record<string, unknown>).join(",")}]`,
    })
    const afterStop = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    const settled = errorFor2(afterStop, "arm-a", namesA)
    await new Promise(resolve => setTimeout(resolve, 300))
    const later = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    const laterError = errorFor2(later, "arm-a", namesA)
    // 停止后不再朝 1.2 rad 目标继续：位置应保持（抖动小于 0.02 rad），而不是继续收敛到目标。
    checks.push({ name: "stop_halts_target", ok: Number.isFinite(settled) && Number.isFinite(laterError) && Math.abs(laterError - settled) < 0.02, detail: `errorAtStop=${settled} errorAfter300ms=${laterError} delta=${Math.abs(laterError - settled)}` })

    // 旧代次命令必须被拒（合同 §2.8 第 7 条：不得在执行时替换成最新代次）。
    let staleRejected = false, staleCode = ""
    try {
      await h.operations.robot_move({ worldId: world.worldId, action: { actionId: `verify-stale-${Date.now()}`, expectedGeneration: world.worldGeneration + 99, kind: "joint", entityId: "arm-a", jointNames: namesA, positions: namesA.map(() => 0.1), durationS: 0.2 } })
    } catch (error) { staleRejected = true; staleCode = String((error as { code?: string })?.code ?? (error as Error)?.message ?? error) }
    checks.push({ name: "stale_generation_rejected", ok: staleRejected, detail: `rejected=${staleRejected} code=${staleCode}` })

    // 模型整体重载 + 旧句柄清理 + 迟到命令（合同 §2.8 第 4、7 条；覆盖面审计点名为成片未覆盖）。
    // forceRebuild 走的是"整体重编译"路径：它必须增加 generation、清掉引用旧模型的动作/控制句柄，
    // 并且**不把旧代次的动作替换成最新代次**——迟到的旧代次直接命令必须被拒，而不是被"善意修正"。
    const genBeforeReload = (await h.operations.sim_world_list()).find(item => item.worldId === world.worldId)?.worldGeneration ?? world.worldGeneration
    const reloaded = await h.provider.sync(world.worldId, await h.store.snapshot(created.sceneId), { forceRebuild: true })
    checks.push({
      name: "model_reload_bumps_generation",
      ok: reloaded.worldGeneration > genBeforeReload,
      detail: `forceRebuild 整体重编译：worldGeneration ${genBeforeReload} → ${reloaded.worldGeneration}（须增加）；appliedSceneRevision=${reloaded.appliedSceneRevision} status=${reloaded.status}`,
    })
    let lateRejected = false, lateCode = ""
    try {
      await h.operations.robot_move({ worldId: world.worldId, action: { actionId: `verify-late-${Date.now()}`, expectedGeneration: genBeforeReload, kind: "joint", entityId: "arm-a", jointNames: namesA, positions: namesA.map(() => 0.2), durationS: 0.2 } })
    } catch (error) { lateRejected = true; lateCode = String((error as { code?: string })?.code ?? (error as Error)?.message ?? error) }
    // 重载之后世界仍可用：用**新**代次下一动作并读实测位移，证明清理旧句柄没有把世界弄坏。
    let postReloadOk = false, postReloadDetail = ""
    try {
      const target = namesA.map(() => 0.15)
      const receipt = await h.operations.robot_move({ worldId: world.worldId, action: { actionId: `verify-post-reload-${Date.now()}`, expectedGeneration: reloaded.worldGeneration, kind: "joint", entityId: "arm-a", jointNames: namesA, positions: target, durationS: 0.8, settleTimeS: 0.4, tolerance: 0.03 } })
      const frame = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
      const error = errorFor(frame, "arm-a", namesA, target)
      postReloadOk = receipt.status === "completed" && Number.isFinite(error) && error <= 0.03
      postReloadDetail = `新代次动作 status=${receipt.status} 实测最大误差=${error}`
    } catch (error) { postReloadDetail = `新代次动作抛错：${String((error as { code?: string })?.code ?? (error as Error)?.message ?? error)}` }
    checks.push({
      name: "reload_cleans_old_handles_and_rejects_late_commands",
      ok: lateRejected && postReloadOk,
      detail: `迟到旧代次命令被拒=${lateRejected}（code=${lateCode}，expectedGeneration=${genBeforeReload} vs 当前 ${reloaded.worldGeneration}）；`
        + `重载后新代次动作仍可用=${postReloadOk}（${postReloadDetail}）`,
    })

    await h.operations.sim_close({ worldId: world.worldId })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return { gate: "G06", checks, blocked: null }
}

/** 按关节名读某个实体的最大绝对位置（用于 stop 前后比较，目标不是已知定值）。 */
function errorFor2(frame: { entities: Array<{ entityId: string; joints?: { names: string[]; positions: number[] } }> }, entityId: string, names: string[]) {
  const entity = frame.entities.find(item => item.entityId === entityId)
  if (!entity?.joints) return Number.NaN
  const values = names.map(name => entity.joints!.positions[entity.joints!.names.indexOf(name)]).filter((value): value is number => typeof value === "number")
  return values.length === names.length ? Math.max(...values.map(Math.abs)) : Number.NaN
}

/**
 * G03：sim 独立时钟与 Scene→Sim 同步。
 * 合同 §6.2 G03 通过条件：simTime/step 继续推进、单时钟；applied 版本不倒退；
 * 当前帧对正确 generation；sync 失败明确未 ready。
 * 本入口**没有 Viewer**（纯 headless provider），因此任何推进都直接证明时钟不依赖 Viewer。
 */
async function gateG03(): Promise<GateResult> {
  const checks: Check[] = []
  const h = await harness()
  try {
    const created = await h.scenes.create({ sceneId: "verify-g03", name: "g03" })
    await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm-a" })
    const world = await h.operations.sim_open({ sceneId: created.sceneId })
    const loaded = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "arm-a" })
    checks.push({ name: "world_ready", ok: world.status === "ready", detail: `status=${world.status} clock=${String(world.clock)} timestepS=${String(world.timestepS)} appliedSceneRevision=${world.appliedSceneRevision}` })

    // 帧订阅：不接任何 Viewer，只由 Provider 时钟驱动。
    const frames: Array<{ stepIndex: number; generation: number; simTime: number }> = []
    const unsubscribe = h.provider.subscribeFrames(world.worldId, frame => frames.push({ stepIndex: frame.stepIndex, generation: frame.generation, simTime: frame.simTime }))

    // 一次有界动作推进物理；期间无 Viewer。
    const names = loaded.robot.controlledJointNames
    await h.operations.robot_move({ worldId: world.worldId, action: { actionId: `verify-g03-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "arm-a", jointNames: names, positions: names.map((_, index) => 0.03 * (index + 1)), durationS: 1, settleTimeS: 0.4, tolerance: 0.03 } })
    const after = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    checks.push({ name: "advance_without_viewer", ok: after.stepIndex > 0 && Number.isFinite(after.simTime) && after.simTime > 0, detail: `stepIndex=${after.stepIndex} simTime=${after.simTime} framesReceived=${frames.length}` })
    checks.push({ name: "frames_monotonic", ok: frames.length > 1 && frames.every((frame, index) => index === 0 || frame.stepIndex >= frames[index - 1]!.stepIndex), detail: `frames=${frames.length} first=${frames[0]?.stepIndex} last=${frames.at(-1)?.stepIndex}` })
    unsubscribe()

    // ── DEV-027 F09：上面两条只证明"有帧且不回退"，**没有**「单时钟」与「再开 Viewer 后继续」的判据。
    // 本入口是纯 headless provider（无 Viewer），故取等价动作：退订帧通道＝关 Viewer，重新订阅＝再开 Viewer。
    const clock = singleClockVerdict(frames, world.timestepS ?? 0)
    checks.push({
      name: "single_clock_consistent_timebase",
      ok: clock.ok,
      detail: `timestepS=${world.timestepS} frames=${frames.length} 相邻帧对=${clock.pairs} generation 集合=${JSON.stringify([...new Set(frames.map(frame => frame.generation))])} 最大时基误差=${clock.maxErrorS.toExponential(3)}s；`
        + `判据：同一 generation + stepIndex/simTime 不回退 + |ΔsimTime−ΔstepIndex×timestepS| ≤ max(15%×期望, 4×timestepS)（第二个时钟会让误差接近 100%）`
        + (clock.ok ? "" : `；不满足：${clock.reasons.join("；")}`),
    })

    const detachedBefore = frames.at(-1)
    const moveAgain = async (tag: string): Promise<void> => {
      await h.operations.robot_move({ worldId: world.worldId, action: { actionId: `verify-g03-${tag}-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "arm-a", jointNames: names, positions: names.map((_, index) => 0.02 * (index + 1)), durationS: 0.6, settleTimeS: 0.3, tolerance: 0.03 } })
    }
    // 关 Viewer：退订后物理照跑（期间没有任何消费者）。
    await moveAgain("detached")
    const detachedAfter = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    // 再开 Viewer：重新订阅，再推进一次物理，看是否继续给帧。
    const resumed: ClockFrame[] = []
    const unsubscribeResumed = h.provider.subscribeFrames(world.worldId, frame => resumed.push({ stepIndex: frame.stepIndex, generation: frame.generation, simTime: frame.simTime }))
    await moveAgain("reattached")
    unsubscribeResumed()
    const reopen = reopenVerdict(detachedBefore, detachedAfter, resumed)
    checks.push({
      name: "clock_continues_across_viewer_reattach",
      ok: reopen.ok,
      detail: `关消费者期间真实推进=${reopen.detachedSteps} 步（${detachedBefore?.stepIndex ?? "n/a"}→${detachedAfter.stepIndex}）；重连后收到帧=${reopen.resumedFrames}（末帧 stepIndex=${resumed.at(-1)?.stepIndex ?? "n/a"}）；generation 断开前后=${detachedBefore?.generation ?? "n/a"}→${resumed.at(-1)?.generation ?? "n/a"}`
        + (reopen.ok ? "；判据：无消费者时时钟不停 + 重连后继续推进且代次不变" : `；不满足：${reopen.reasons.join("；")}`),
    })

    // applied 版本单调：提交新 revision 并 sync 后必须前进；随后低版本 sync 不得回退。
    const committed = await h.store.commit({ sceneId: created.sceneId, expectedRevision: (await h.store.snapshot(created.sceneId)).revision, patch: [{ op: "update", entityId: "arm-a", changes: { name: "arm-a-renamed" } }] })
    const synced = await h.operations.sim_sync({ sceneId: created.sceneId, worldId: world.worldId })
    checks.push({ name: "sync_advances_revision", ok: synced.appliedSceneRevision === committed.revision, detail: `committedRevision=${committed.revision} appliedSceneRevision=${synced.appliedSceneRevision} generation=${synced.worldGeneration}` })
    const stale = await h.provider.sync(world.worldId, { ...committed, revision: 0, entities: committed.entities })
    checks.push({ name: "sync_no_revision_regression", ok: stale.appliedSceneRevision >= committed.revision, detail: `afterLowRevisionSync=${stale.appliedSceneRevision} expected>=${committed.revision}` })

    // 帧的 generation 必须与当前 world 一致（旧代次帧要被丢弃，不能冒充当前）。
    const fresh = await h.operations.robot_state({ worldId: world.worldId, entityId: "arm-a" })
    checks.push({ name: "frame_generation_matches", ok: fresh.generation === synced.worldGeneration, detail: `frameGeneration=${fresh.generation} worldGeneration=${synced.worldGeneration} sceneRevision=${String(fresh.sceneRevision)}` })

    // 并发不同 revision 的 sync（合同 §2.8 第 3 条）：按 world 串行、applied 单调前进，且
    // "旧请求晚结束不能覆盖新版本"。构造办法：先取旧快照，再让它**晚于**新快照提交，
    // 即制造乱序到达——这正是该条款要防的情形。
    const oldest = await h.store.snapshot(created.sceneId)
    const newer = await h.store.commit({ sceneId: created.sceneId, expectedRevision: oldest.revision, patch: [{ op: "update", entityId: "arm-a", changes: { name: "arm-a-newer" } }] })
    const newest = await h.store.commit({ sceneId: created.sceneId, expectedRevision: newer.revision, patch: [{ op: "update", entityId: "arm-a", changes: { name: "arm-a-newest" } }] })
    const appliedNewer = await h.provider.sync(world.worldId, newer)
    const appliedOldest = await h.provider.sync(world.worldId, oldest)
    const appliedNewest = await h.provider.sync(world.worldId, newest)
    checks.push({
      name: "concurrent_sync_no_regression",
      ok: appliedOldest.appliedSceneRevision >= appliedNewer.appliedSceneRevision && appliedNewest.appliedSceneRevision >= appliedNewer.appliedSceneRevision,
      detail: `乱序提交 newer(r${newer.revision})→applied=${appliedNewer.appliedSceneRevision}，随后 oldest(r${oldest.revision})→applied=${appliedOldest.appliedSceneRevision}（未回退），再 newest(r${newest.revision})→applied=${appliedNewest.appliedSceneRevision}`,
    })

    // sync 失败必须**返回原因**且保留可编辑文档（合同 §2.8 第 5 条前半、§2.16）。
    //
    // 本条曾叫 `sync_failure_explicit_and_document_intact`，但它**只断言了"抛错 + 文档不变"**，
    // 名字却暗示已覆盖 §2.8-5 的后半句"运行 world 标为 unsynced/unavailable"。覆盖审计实测：
    // 跨 scene 失败与 forceRebuild 重编译失败（`COMPILE_FAILED`）之后，world 仍 `status=ready`。
    // 而 `packages/sim-mujoco/python/worker.py:670-681` 的注释自认这是**显式设计**：
    // "编译失败时旧 model/data、实体映射、地面名与告警原样保留，世界保持可用（状态不变）"。
    // 所以这不是"没实现"，而是**实现语义与合同字面不同**。按 §7 不替产品圆场：
    // 把 check 改名为它真正断言的内容，并把这条偏差作为 UNCOVERED 显式列出。
    let failure = ""
    try {
      const foreign = await h.provider.sync(world.worldId, { ...newest, sceneId: "verify-g03-foreign" })
      failure = `未抛错，status=${foreign.status}`
    } catch (error) { failure = String((error as { code?: string })?.code ?? (error as Error)?.message ?? error) }
    const documentIntact = (await h.store.snapshot(created.sceneId)).revision === newest.revision
    checks.push({
      name: "sync_failure_returns_reason_and_keeps_document",
      ok: !failure.startsWith("未抛错") && documentIntact,
      detail: `跨 scene sync 的错误=${failure}；文档 revision=${newest.revision} 未受影响=${documentIntact}`,
    })

    await h.operations.sim_close({ worldId: world.worldId })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return {
    gate: "G03",
    checks,
    // §6.2 G03 的「sync 失败明确未 ready」尚未达成：实现选择"保留上一可用世界 + 报 COMPILE_FAILED",
    // 世界状态保持 ready。按 §7 如实记为未覆盖，**不用别的证据顶替**，也不替产品把语义说圆。
    blocked: "未覆盖（UNCOVERED）：合同 §2.8-5 / §6.2 G03 要求「sync 失败明确未 ready」——"
      + "实测跨 scene 失败（`SCENE_MISMATCH`）与 forceRebuild 重编译失败（`COMPILE_FAILED`）之后，"
      + "world 仍报告 `status=ready`、`appliedSceneRevision` 不变；"
      + "`packages/sim-mujoco/python/worker.py:670-681` 注释自认这是显式设计（保留上一可用世界）。"
      + "本门只断言「返回原因 + 文档保持可编辑」。此为**实现语义与合同字面不一致**，记录在案。",
  }
}

/**
 * G02：导入 GLB/splat/robot 资源、创建/编辑层级、保存/重开、CAS 冲突。
 * 合同 §6.2 G02 通过条件：纯视觉也可用；实体/资源引用不丢；冲突不覆盖；无物理化强制门槛。
 */
async function gateG02(): Promise<GateResult> {
  const checks: Check[] = []
  const h = await harness()
  const GLB = join(PRODUCT_ROOT, "materials/mcp-env/assets/kenney-props/visual/prop_10_traffic-light.glb")
  const SPLAT = join(PRODUCT_ROOT, "materials/worlds/background/luxury-suite.spz")
  try {
    const created = await h.scenes.create({ sceneId: "verify-g02", name: "g02" })

    // 纯视觉：显式 physicalize:false，不得成为"能否用"的前置门槛。
    const visual = await h.scenes.import({ path: GLB, sceneId: created.sceneId, entityId: "prop", physicalize: false })
    checks.push({ name: "import_glb_visual_only", ok: visual.entityId === "prop", detail: `entityId=${visual.entityId} kind=${visual.resource.parsed.kind} physicalize=false` })

    const splat = await h.scenes.import({ path: SPLAT, sceneId: created.sceneId, entityId: "room" })
    checks.push({ name: "import_splat", ok: splat.resource.parsed.kind === "splat", detail: `kind=${splat.resource.parsed.kind} mime=${splat.resource.ref.original.mimeType}` })

    const robot = await h.scenes.import({ path: KUKA_MJCF, sceneId: created.sceneId, entityId: "arm" })
    checks.push({ name: "import_robot", ok: robot.resource.parsed.kind === "robot", detail: `kind=${robot.resource.parsed.kind} mime=${robot.resource.ref.original.mimeType}` })

    // 层级：把 prop 挂到 arm 下（reparent 是显式 patch 操作，不是改字段）。
    const beforeParent = await h.store.snapshot(created.sceneId)
    const parented = await h.store.commit({ sceneId: created.sceneId, expectedRevision: beforeParent.revision, patch: [{ op: "reparent", entityId: "prop", parentId: "arm" }] })
    const child = parented.entities.find(entity => entity.entityId === "prop")
    checks.push({ name: "hierarchy_parenting", ok: child?.parentId === "arm", detail: `entities=${parented.entities.length} ids=[${parented.entities.map(entity => entity.entityId).join(",")}] prop.parentId=${String(child?.parentId)} revision=${parented.revision}` })

    // CAS 冲突：用过期的 expectedRevision 提交，必须拒绝且不覆盖新文档。
    const staleRevision = parented.revision - 1
    let conflictCode = ""
    try { await h.store.commit({ sceneId: created.sceneId, expectedRevision: staleRevision, patch: [{ op: "update", entityId: "prop", changes: { name: "SHOULD-NOT-APPLY" } }] }) }
    catch (error) { conflictCode = String((error as { code?: string })?.code ?? (error as Error)?.message ?? error) }
    const afterConflict = await h.store.snapshot(created.sceneId)
    const untouched = afterConflict.entities.find(entity => entity.entityId === "prop")?.name !== "SHOULD-NOT-APPLY"
    checks.push({ name: "cas_conflict_rejected", ok: conflictCode.length > 0 && afterConflict.revision === parented.revision && untouched, detail: `code=${conflictCode} revision=${afterConflict.revision}(expected ${parented.revision}) contentUntouched=${untouched}` })

    // 保存 → 重开：实体/资源引用/层级不丢。portable 让工程自包含。
    const savedPath = join(h.directory, "portable-scene.json")
    const saved = await h.scenes.save(created.sceneId, savedPath, { portable: true })
    const reopened = await h.scenes.open(savedPath, { sceneId: "verify-g02-reopened" })
    // DEV-027 F08：旧口径只比 entityId/parentId/资源串，**不比 transform/components**——
    // "保存重开不丢"因此在位姿/组件被丢弃时仍会 PASS。这里把 transform 与 components 一并纳入
    // 规范化比较（键排序后再比，避免把序列化顺序差异当成丢数据）。
    const canonical = (value: unknown): unknown => Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
        : value
    // portable 保存（`scene_save {portable:true}`）的既定行为是**把依赖复制进工程并改写引用路径**
    // （原件字节不动、副本自包含）。所以"保存重开"比较不能把"引用改指工程内副本"当成丢数据：
    // 依赖位置归一成 `@<文件名>`（位置可变、**身份不变**才算一致；换了文档名仍然会失败）。
    const locationBlind = (value: unknown): unknown => {
      if (typeof value === "string") return /^(file:|\.{0,2}\/|\/)/.test(value) ? `@${value.split(/[\\/]/).pop() ?? value}` : value
      if (Array.isArray(value)) return value.map(locationBlind)
      if (value !== null && typeof value === "object")
        return Object.fromEntries(Object.keys(value as Record<string, unknown>).map(key => [key, locationBlind((value as Record<string, unknown>)[key])]))
      return value
    }
    const shape = (snapshot: typeof reopened) => snapshot.entities.map(entity => ({
      entityId: entity.entityId, parentId: entity.parentId ?? null,
      transform: canonical(entity.transform),
      components: canonical(locationBlind(entity.components ?? {})),
      resources: entity.resources.map(ref => `${ref.resourceId}@${ref.version}:${ref.original.mimeType}`).sort(),
    })).sort((left, right) => left.entityId.localeCompare(right.entityId))
    const beforeShape = shape(parented), afterShape = shape(reopened)
    const identical = JSON.stringify(beforeShape) === JSON.stringify(afterShape)
    // 失败时给出**可核对的差异定位**（哪个实体、哪个字段），而不是只报 shapeEqual=false。
    const fields = ["parentId", "transform", "components", "resources"] as const
    const firstDiff = (() => {
      for (const [index, row] of beforeShape.entries()) {
        const other = afterShape[index]
        if (!other) return `${row.entityId}: 重开后该实体不存在`
        if (JSON.stringify(row) === JSON.stringify(other)) continue
        const changed = fields.filter(field => JSON.stringify((row as Record<string, unknown>)[field]) !== JSON.stringify((other as Record<string, unknown>)[field]))
        const sample = changed.length
          ? `；before(${changed[0]})=${JSON.stringify((row as Record<string, unknown>)[changed[0]!]).slice(0, 260)}；after(${changed[0]})=${JSON.stringify((other as Record<string, unknown>)[changed[0]!]).slice(0, 260)}`
          : ""
        return `${row.entityId}: ${changed.length ? changed.join("/") : "实体顺序或数量"}${sample}`
      }
      return afterShape.length > beforeShape.length ? `重开后多出实体 ${afterShape.slice(beforeShape.length).map(row => row.entityId).join(",")}` : "（无逐字段差异）"
    })()
    checks.push({ name: "save_reopen_references_intact", ok: identical, detail: `entities=${reopened.entities.length} missing=${saved.missing.length} shapeEqual=${identical}（比较 entityId/parentId/**transform**/**components**/资源引用）；首个差异=${firstDiff}` })
    const reopenedChild = reopened.entities.find(entity => entity.entityId === "prop")
    checks.push({ name: "save_reopen_hierarchy_intact", ok: reopenedChild?.parentId === "arm", detail: `prop.parentId=${String(reopenedChild?.parentId)}` })

    // 重开后资源仍可用：拿一个引用去核对真实文件存在（引用不丢不等于文件还在）。
    const resolved = reopened.entities.flatMap(entity => entity.resources.flatMap(ref => [ref.original, ...ref.representations])).filter(rep => rep.uri.startsWith("file:"))
    let readable = 0
    for (const rep of resolved) { try { await access(fileURLToPath(rep.uri)); readable++ } catch { /* 记入差值 */ } }
    checks.push({ name: "reopened_files_resolvable", ok: resolved.length > 0 && readable === resolved.length, detail: `fileRefs=${resolved.length} readable=${readable} missing=${saved.missing.length}` })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return { gate: "G02", checks, blocked: null }
}

/**
 * G05：通用叉车运动/转向语义（合同 §2.10 / §6.2 G05）。
 * 通过条件：speed/steering 单位一致；零速转向不产生驱动；普通控制不依赖 Fleet；用户只增加资产。
 */
async function gateG05(): Promise<GateResult> {
  const checks: Check[] = []
  // 夹具优先级：Dev 自带 → 历史主线自带 → DSH 开发证据（LyapunovDSH 已不存在，故不从那里取）。
  const candidates = [
    join(PRODUCT_ROOT, "materials/robots/forklift_c/forklift_c.xml"),
    resolve(PRODUCT_ROOT, "../History/Main/packages/app/public/mujoco/forklift_c/forklift_c.xml"),
    resolve(PRODUCT_ROOT, "../DSH/.runtime/github-upload-20260906/part-01-original-source/packages/app/public/mujoco/forklift_c/forklift_c.xml"),
  ]
  let fixture = ""
  for (const candidate of candidates) { try { await access(candidate); fixture = candidate; break } catch { /* 继续找下一个 */ } }
  if (!fixture) return { gate: "G05", checks, blocked: `叉车夹具不在已知位置：${candidates.join(" | ")}` }

  const h = await harness()
  try {
    const created = await h.scenes.create({ sceneId: "verify-g05", name: "g05" })
    // 真实跑通过的控制映射（取自 agent-loop-forklift-20260911 回执场景，非本轮臆造）；
    // 该 MJCF 自身不含 controller 组件，故按 §2.9「只补缺项配置」在导入时挂上。
    const controller = {
      type: "vehicle", wheelbaseM: 0.55156, trackWidthM: 0.3983,
      wheels: [
        { actuator: "left_front_wheel_joint_velocity", side: "left", radiusM: 0.1085 },
        { actuator: "right_front_wheel_joint_velocity", side: "right", radiusM: 0.1085 },
        { actuator: "left_back_wheel_joint_velocity", side: "left", radiusM: 0.0865 },
        { actuator: "right_back_wheel_joint_velocity", side: "right", radiusM: 0.0865 },
      ],
      steering: { actuators: ["left_rotator_position", "right_rotator_position"], axle: "rear", rangeRad: [-0.55, 0.55] },
      lift: { actuator: "lift_position", joint: "lift_joint", rangeM: [0, 0.61], gravityCompensationM: 0.052 },
    }
    const imported = await h.scenes.import({ path: fixture, sceneId: created.sceneId, entityId: "forklift", components: { controller } })
    const snapshot = await h.store.snapshot(created.sceneId)
    const entity = snapshot.entities.find(item => item.entityId === "forklift")
    const declared = entity?.components?.controller as typeof controller | undefined
    checks.push({ name: "asset_carries_controller", ok: declared?.type === "vehicle" && (declared.wheels?.length ?? 0) === 4, detail: `type=${String(declared?.type)} wheels=${declared?.wheels?.length ?? 0} radii=[${(declared?.wheels ?? []).map(wheel => wheel.radiusM).join(",")}] axle=${String(declared?.steering?.axle)} imported=${imported.entityId}` })
    // 夹具来源必须是**仓库内**路径。此前这条写成 `ok: true` 的常量——一个恒真的"检查"混进 8/8，
    // 等于把"干净 checkout 上也能跑"这个真实约束从回执里抹掉了。现改成真断言。
    const fixtureInRepo = fixture.startsWith(join(PRODUCT_ROOT, "materials") + "/")
    checks.push({
      name: "fixture_source_inside_repo",
      ok: fixtureInRepo,
      detail: `夹具=${fixture}；在仓库内 materials/ 下=${fixtureInRepo}（干净 checkout 可跑的前提）`,
    })

    const world = await h.operations.sim_open({ sceneId: created.sceneId })
    // 当前 worldGeneration 必须**每次同步后重新读**：`sim_sync` 会推进代次，
    // 沿用 open 时捕获的旧代次会被产品正当地拒绝（§2.8-7），那是夹具写错不是产品缺陷。
    let generation = world.worldGeneration
    const loaded = await h.operations.robot_load({ worldId: world.worldId, sceneId: created.sceneId, entityId: "forklift" })
    const jointNames = loaded.robot.joints.map(joint => joint.name)
    checks.push({ name: "load_without_fleet", ok: loaded.robot.entityId === "forklift", detail: `joints=${jointNames.length} hasLift=${jointNames.includes("lift_joint")} wheels=${jointNames.filter(name => name.endsWith("_wheel_joint")).length}` })

    const positionOf = async () => {
      const frame = await h.operations.robot_state({ worldId: world.worldId, entityId: "forklift" })
      const observed = frame.entities.find(item => item.entityId === "forklift")
      return { xyz: observed?.transform.position ?? [Number.NaN, Number.NaN, Number.NaN], frame }
    }
    const start = await positionOf()
    const liftIndex = loaded.robot.joints.findIndex(joint => joint.name === "lift_joint")

    // 1) 直线行驶：speedMps 是底盘线速度，实测位移应接近 speed×duration。
    const speedMps = 0.3, durationS = 1.5
    const drive: SimAction = { actionId: `verify-drive-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift", speedMps, durationS }
    const driveReceipt = await h.operations.vehicle_drive({ worldId: world.worldId, action: drive })
    const afterDrive = await positionOf()
    const dx = afterDrive.xyz[0] - start.xyz[0], dy = afterDrive.xyz[1] - start.xyz[1]
    const travelled = Math.hypot(dx, dy), expected = speedMps * durationS
    checks.push({ name: "speed_is_body_velocity", ok: driveReceipt.status === "completed" && travelled > expected * 0.5 && travelled < expected * 1.5, detail: `travelledM=${travelled} expected≈${expected} ratio=${travelled / expected} status=${driveReceipt.status}` })

    // 2b) 倒车与单位一致性：`speedMps<0` 必须真的往后退（符号约定），
    //     且**换一套合法轮径**后同一 speed 仍对应同一底盘线速度——这正是合同 §6.2 G05
    //     "speed/steering 单位一致"与"另一个合法轮径配置"的可判定形式。
    //     实现侧依据：worker.py:1258 `target = linear / wheel['radiusM'] * driveSign`
    //     ——speedMps 是底盘线速度，不是轮角速度，所以换轮径不该改变车身位移。
    const beforeReverse = await positionOf()
    const reverseSpeed = -0.3
    const reverseReceipt = await h.operations.vehicle_drive({ worldId: world.worldId, action: { actionId: `verify-reverse-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift", speedMps: reverseSpeed, durationS } })
    const afterReverse = await positionOf()
    const alongForward = afterReverse.xyz[0] - beforeReverse.xyz[0]
    const reverseTravelled = Math.hypot(alongForward, afterReverse.xyz[1] - beforeReverse.xyz[1])
    checks.push({
      name: "reverse_speed_goes_backward_with_consistent_units",
      ok: reverseReceipt.status === "completed" && alongForward < 0
        && reverseTravelled > Math.abs(reverseSpeed) * durationS * 0.5 && reverseTravelled < Math.abs(reverseSpeed) * durationS * 1.5,
      detail: `speedMps=${reverseSpeed} durationS=${durationS}：沿前进轴位移=${alongForward}（**须为负**）、位移模长=${reverseTravelled}（期望≈${Math.abs(reverseSpeed) * durationS}）status=${reverseReceipt.status}`,
    })

    // 第二台同型叉车，但**换一套合法轮径**（前轮 0.1085→0.12、后轮 0.0865→0.095）。
    // 该 MJCF 不含 controller 组件，故与第一台同样在导入时补 controller（§2.9「只补缺项配置」），
    // 差别只在轮径——这样两台的读数差异只能来自轮径，不能来自别的因素。
    await h.scenes.import({
      path: fixture, sceneId: created.sceneId, entityId: "forklift-b",
      transform: { position: [0, 2.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { controller: { ...controller, wheels: controller.wheels.map(wheel => ({ ...wheel, radiusM: wheel.actuator.includes("front") ? 0.12 : 0.095 })) } },
    })
    await h.operations.sim_sync({ sceneId: created.sceneId, worldId: world.worldId })
    // sim_sync 会推进 worldGeneration（这正是 §2.8-7 要的：旧代次必须被拒），
    // 所以要**重新读**当前代次再下发动作，不能沿用 open 时捕获的那个。
    generation = (await h.operations.sim_world_list()).find(item => item.worldId === world.worldId)?.worldGeneration ?? generation
    const positionOfB = async () => {
      const frame = await h.operations.robot_state({ worldId: world.worldId, entityId: "forklift-b" })
      return (frame.entities.find(item => item.entityId === "forklift-b")?.transform.position ?? [Number.NaN, Number.NaN, Number.NaN]) as [number, number, number]
    }
    const startB = await positionOfB()
    const receiptB = await h.operations.vehicle_drive({ worldId: world.worldId, action: { actionId: `verify-wheelradius-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift-b", speedMps, durationS } })
    const endB = await positionOfB()
    const travelledB = Math.hypot(endB[0] - startB[0], endB[1] - startB[1])
    const ratioB = travelledB / expected
    checks.push({
      name: "legal_second_wheel_radius_keeps_body_speed",
      ok: receiptB.status === "completed" && ratioB > 0.5 && ratioB < 1.5,
      detail: `第二台同型叉车改用另一套合法轮径（前 0.1085→0.12 m、后 0.0865→0.095 m）：`
        + `speedMps=${speedMps} × ${durationS}s 期望位移≈${expected}m、实测=${travelledB}m（比值=${ratioB}）status=${receiptB.status}；`
        + `第一台同参数实测=${travelled}m（比值=${travelled / expected}）——两套轮径给出同一底盘线速度，即 speedMps 是车身速度而非轮角速度`,
    })

    //    该车是后轮转向（steering.axle=rear），故走 steeringAngleRad 分支而非差速 yawRateRadps。
    const steerAngleRad = 0.5
    const beforeTurn = await positionOf()
    const turnReceipt = await h.operations.vehicle_drive({ worldId: world.worldId, action: { actionId: `verify-turn-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift", speedMps: 0, steeringAngleRad: steerAngleRad, durationS: 1 } })
    const afterTurn = await positionOf()
    const turnShift = Math.hypot(afterTurn.xyz[0] - beforeTurn.xyz[0], afterTurn.xyz[1] - beforeTurn.xyz[1])
    // 转向机构确实动了：读真实 rotator 关节角，证明"零速转向只转机构"而不是什么都没做。
    const rotatorIndex = loaded.robot.joints.findIndex(joint => joint.name === "left_rotator_joint")
    const rotatorAngle = rotatorIndex >= 0 ? afterTurn.frame.entities.find(item => item.entityId === "forklift")?.joints?.positions[rotatorIndex] : undefined
    checks.push({ name: "zero_speed_turn_no_translation", ok: turnReceipt.status === "completed" && turnShift < 0.01, detail: `translationM=${turnShift} status=${turnReceipt.status} steeringAngleRad=${steerAngleRad} speedMps=0 rotatorJointAfter=${String(rotatorAngle)}` })

    // 3) 两种转向语义互斥：转向轴车辆不得接受 yawRateRadps。
    let exclusiveCode = ""
    try { await h.operations.vehicle_drive({ worldId: world.worldId, action: { actionId: `verify-both-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift", speedMps: 0.1, steeringAngleRad: 0.1, yawRateRadps: 0.2, durationS: 0.2 } }) }
    catch (error) { exclusiveCode = String((error as { code?: string })?.code ?? (error as Error)?.message ?? error) }
    checks.push({ name: "steering_and_yawrate_mutually_exclusive", ok: exclusiveCode.length > 0, detail: `code=${exclusiveCode}` })

    // 4) 升降用绝对 positionM，按实测关节位移核对，不按调用次数累加。
    const liftTarget = 0.3
    const liftReceipt = await h.operations.joint_move({ worldId: world.worldId, action: { actionId: `verify-lift-${Date.now()}`, expectedGeneration: generation, kind: "lift", entityId: "forklift", positionM: liftTarget, durationS: 1.5, tolerance: 0.01 } })
    const liftFrame = await h.operations.robot_state({ worldId: world.worldId, entityId: "forklift" })
    const liftEntity = liftFrame.entities.find(item => item.entityId === "forklift")
    const liftActual = liftIndex >= 0 ? liftEntity?.joints?.positions[liftIndex] : undefined
    checks.push({ name: "lift_is_absolute_position", ok: liftReceipt.status === "completed" && typeof liftActual === "number" && Math.abs(liftActual - liftTarget) <= 0.01, detail: `target=${liftTarget} actual=${String(liftActual)} error=${typeof liftActual === "number" ? Math.abs(liftActual - liftTarget) : "n/a"} status=${liftReceipt.status}` })

    // 5) stop 立即生效：停止后不再继续行驶。
    const moving = h.operations.vehicle_drive({ worldId: world.worldId, action: { actionId: `verify-stop-${Date.now()}`, expectedGeneration: generation, kind: "vehicle", entityId: "forklift", speedMps: 0.5, durationS: 8 } })
    await new Promise(resolve => setTimeout(resolve, 200))
    const stopped = await h.operations.robot_stop({ worldId: world.worldId, entityIds: ["forklift"] })
    const stopReceipt = await moving
    const atStop = await positionOf()
    await new Promise(resolve => setTimeout(resolve, 400))
    const later = await positionOf()
    const driftM = Math.hypot(later.xyz[0] - atStop.xyz[0], later.xyz[1] - atStop.xyz[1])
    checks.push({ name: "stop_halts_vehicle", ok: stopped.stopped === true && driftM < 0.02, detail: `stopped=${stopped.stopped} pendingStatus=${stopReceipt.status} driftAfter400ms=${driftM}` })

    await h.operations.sim_close({ worldId: world.worldId })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return { gate: "G05", checks, blocked: null }
}

/**
 * G07：抓放的真实接触反馈与"失败不报成功"（合同 §6.2 G07）。
 * 场景与阈值取自原回执脚本 `D-evidence/graspgenx-pick-place.ts` 的 fixture 定义（非本轮臆造）：
 * 台面 z=0.2、40mm/50g 立方体、minimumLiftM=0.08、holdTimeS=0.5。
 * 抓取候选由确定性解析 provider 给出（不依赖 GraspGenX 模型/容器）。
 */
async function gateG07(): Promise<GateResult> {
  const checks: Check[] = []
  const h = await harness()
  const PANDA = join(PRODUCT_ROOT, "materials/robots/franka_panda/franka_emika_panda/panda.xml")
  const PYTHON = join(PRODUCT_ROOT, ".runtime/sim-python/bin/python")
  const SOLVER = join(PRODUCT_ROOT, "packages/motion-mink/src/solve.py")
  try {
    await access(PANDA)
    // 控制映射只补夹具缺的项（§2.9）：夹爪由单 tendon 执行器 actuator8 驱动两指，
    // maxWidthM=0.08 与 controlRange=[0,255] 均取自 panda.xml 自身（ctrlrange="0 255"、两指各 0~0.04）。
    const pandaController = { gripper: { actuator: "actuator8", jointNames: ["finger_joint1", "finger_joint2"], maxWidthM: 0.08, controlRange: [0, 255] } }
    // 与原始 G07 回执完全一致的场景：机器人基座在原点、台面 z=0.1(半高 .1)、立方体在 [.45,0,.2205]。
    const snapshot: SceneSnapshot = {
      sceneId: "verify-g07", revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
      entities: [
        { entityId: "panda", name: "panda", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { mujoco: { sourcePath: PANDA }, controller: pandaController } },
        { entityId: "table", name: "支撑台", transform: { position: [0.5, 0, 0.1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { collision: { shape: "box", halfExtents: [0.3, 0.3, 0.1], friction: [1, 0.05, 0.001] }, rigidBody: { type: "static" } } },
        { entityId: "cube", name: "40mm方块", transform: { position: [0.45, 0, 0.2205], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { collision: { shape: "box", halfExtents: [0.02, 0.02, 0.02], friction: [1.4, 0.1, 0.002] }, rigidBody: { type: "dynamic", massKg: 0.05 } } },
      ],
    }
    const world = await h.provider.open(snapshot)
    const description = await h.provider.describe(world.worldId, "panda")
    // DEV-027 F16：合同 §2.7 要求 MotionPlan 带"机器人/模型版本"。旧实现把资源列表字符串化，
    // 无资源时恒为 `"[]"`，而此前**没有任何门断言其非空**（MuJoCo 分支不要求 Boolean(modelVersion)）。
    // 这里对真实 describe 读数直接断言：非空、且不是 "[]" 这种占位。
    checks.push({
      name: "describe_reports_real_model_version",
      ok: typeof description.modelVersion === "string" && description.modelVersion.trim().length > 0 && description.modelVersion !== "[]",
      detail: `modelVersion=${JSON.stringify(description.modelVersion)}（须非空且非 "[]"；MuJoCo worker 用 MJCF sourcePath 或 inline-mjcf:<model>#<n>res 构造）`,
    })

    // 真实 IK 规划：调产品既有的 mink 求解脚本（同一入参协议），不新建求解器。
    // planner 按 TCP 偏移参数化：偏移是待标定量，不能在函数体里写死。
    const plannerWith = (tcpOffsetM: number) => async (request: { worldId: string; entityId: string; start: Frame; targetPose: GraspCandidate["tcpPose"]; signal?: AbortSignal }) => {
      const observed = request.start.entities.find(entity => entity.entityId === request.entityId)!.joints!
      const names = description.controlledJointNames
      const startPositions = names.map(name => observed.positions[observed.names.indexOf(name)]!)
      const fingerIndex = observed.names.findIndex(name => name === "finger_joint1")
      // 与产品插件同一份求解脚本、同一入参规范化（motionRequest 负责 quaternionXyzw→quaternion 换名），
      // 不重写求解器也不自定义字段契约。
      const structured = {
        modelPath: PANDA, entityId: request.entityId, modelVersion: description.modelVersion, collisionContextVersion: description.collisionContextVersion,
        expectedGeneration: request.start.generation, tcp: { body: "hand", offsetM: [0, 0, tcpOffsetM] },
        jointNames: names, startPositions, seeds: [startPositions, [0, -0.6, 0, -2.2, 0, 1.8, 0.7853981634]],
        fixedJoints: fingerIndex >= 0 ? { finger_joint1: observed.positions[fingerIndex], finger_joint2: observed.positions[fingerIndex + 1] } : {},
        targetPose: { position: request.targetPose.position, quaternionXyzw: request.targetPose.quaternion },
        durationS: 2, positionToleranceM: 0.0005, orientationToleranceRad: 0.01,
      }
      const payload = motionRequest({ plan: structured })
      const child = spawn(PYTHON, [SOLVER], { stdio: "pipe" })
      child.stdin.write(JSON.stringify(payload)); child.stdin.end()
      const chunks: Buffer[] = []
      for await (const chunk of child.stdout) chunks.push(chunk as Buffer)
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { plan?: MotionPlan; result?: { converged?: boolean }; error?: string; message?: string }
      if (!parsed.plan || !parsed.result?.converged) throw new Error(`IK_NOT_CONVERGED: ${parsed.error ?? ""} ${parsed.message ?? "未收敛"}`)
      return parsed.plan
    }
    const planner = plannerWith(0.1029)

    const cubeOf = (frame: Frame) => frame.entities.find(entity => entity.entityId === "cube")!.transform.position
    // 真实 geom 名 = 实体前缀 + 原件里的名字（`worker.py:919 prefix = eid + '/'`；实测形如 `panda/__geom_69`）。
    // 旧写法 `/finger|hand/.test(geom1)` 匹配不到任何真实名，于是"手指接触数"这一支在本夹具上是**死代码**，
    // `tcp_offset_calibration` 退化成纯宽度阈值。这里改按实体前缀取"机器人与非机器人"的接触（与 §2.9
    // `robotContactCount` 同口径：一侧是机器人、另一侧是别的实体，排除自接触）。
    const ROBOT_GEOM_PREFIX = "panda/"
    const robotContactsOf = (frame: Frame): number => (frame.contacts ?? []).filter(contact => {
      const first = contact.geom1.startsWith(ROBOT_GEOM_PREFIX), second = contact.geom2.startsWith(ROBOT_GEOM_PREFIX)
      return first !== second
    }).length
    const fingersOf = (frame: Frame) => {
      const joints = frame.entities.find(entity => entity.entityId === "panda")?.joints
      if (!joints) return undefined
      const at = joints.names.indexOf("finger_joint1"), bt = joints.names.indexOf("finger_joint2")
      return at < 0 || bt < 0 ? undefined : { each: [joints.positions[at]!, joints.positions[bt]!] as [number, number], total: joints.positions[at]! + joints.positions[bt]! }
    }
    const before = await h.provider.observe(world.worldId, { contacts: true })

    // 隔离实验：先让手臂离开物体、在自由空间里闭合夹爪。
    // 目的：区分"夹爪本身到不了命令宽度"与"闭合被物体/台面挡住"——两种情况修法完全不同。
    await h.provider.execute(world.worldId, { actionId: "verify-g07-free-open", expectedGeneration: world.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.08, durationS: 0.5 })
    const freeOpen = fingersOf(await h.provider.observe(world.worldId, { contacts: true }))
    await h.provider.execute(world.worldId, { actionId: "verify-g07-free-close", expectedGeneration: world.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.0384, durationS: 0.7, settleTimeS: 0.5 })
    const freeClosed = fingersOf(await h.provider.observe(world.worldId, { contacts: true }))
    checks.push({
      name: "gripper_reaches_commanded_width_in_free_space",
      ok: freeClosed !== undefined && Math.abs(freeClosed.total - 0.0384) <= 0.002,
      detail: `自由空间 开=${freeOpen?.total} 闭=${freeClosed?.total}（命令 0.0384，各指=${freeClosed?.each.join("/")}）`,
    })

    // 确定性解析候选：从 40mm 立方体几何直接给顶抓候选。
    const candidates = proposeAnalytic({ entityId: "cube", frameId: before.frameId, centerM: cubeOf(before), sizeM: [0.04, 0.04, 0.04], maxWidthM: 0.08 })
    const candidate = candidates[0]
    checks.push({ name: "analytic_candidate", ok: candidate !== undefined, detail: candidates.length ? `provider=${candidate.provider} widthM=${candidate.widthM} approach=[${candidate.approach.join(",")}]` : "无候选" })
    if (!candidate) return { gate: "G07", checks, blocked: null }

    // TCP 偏移标定：自由空间实验已证明夹爪本身能到位，问题是下降后手指落在物体外侧。
    // 手掌相对 link7 有 -45° 安装旋转，手指伸展方向随臂姿态变化，凭推算容易搞反符号；
    // 这里对候选偏移逐个做真实下降+闭合，只用真实读数（闭合总宽 / 机器人接触数）判定，不做推测。
    const offsets = [0.1029, -0.1029, 0.0584, 0]
    const rows: Array<{ offset: number; closedTotal?: number; robotContacts?: number }> = []
    // DEV-027 F14：`chosenOffset` 不再由上面的搜索挑选——判定只认**固定配置**（`g07-calibration.ts`）。
    const chosenOffset = FIXED_GRASP_CONFIG.tcpOffsetM
    for (const offset of offsets) {
      const attempt = await h.provider.open({ ...snapshot, sceneId: `verify-g07-cal-${offset}` })
      const pose = { position: candidate.tcpPose.position as [number, number, number], quaternion: candidate.tcpPose.quaternion }
      try {
        await h.provider.execute(attempt.worldId, { actionId: `cal-open-${offset}`, expectedGeneration: attempt.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.08, durationS: 0.5 })
        await executePose(h.provider, plannerWith(offset) as never, attempt.worldId, "panda", pose, `cal-descend-${offset}`)
        await h.provider.execute(attempt.worldId, { actionId: `cal-close-${offset}`, expectedGeneration: attempt.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.0384, durationS: 0.7, settleTimeS: 0.5 })
        const closed = await h.provider.observe(attempt.worldId, { contacts: true })
        rows.push({ offset, closedTotal: fingersOf(closed)?.total, robotContacts: robotContactsOf(closed) })
      } catch {
        rows.push({ offset, closedTotal: undefined, robotContacts: undefined })
      }
      await h.provider.close(attempt.worldId)
    }
    // DEV-027 F14：这里原本是 `rows.find(row => …)` 挑第一个"被挡住"的偏移并把它当 `chosenOffset`，
    // 于是判据成了"网格里存在能过的组合"。现在判定**只认固定配置那一档**，其余档位照旧打印作证据。
    const chosenRow = rows.find(row => row.offset === FIXED_GRASP_CONFIG.tcpOffsetM)
    const fixedOffsetBlocked = offsetLooksBlocked(chosenRow)
    checks.push({
      name: "tcp_offset_calibration",
      ok: fixedOffsetBlocked,
      detail: `逐偏移真实下降+闭合读数：${rows.map(row => `offset=${row.offset}→闭合总宽=${row.closedTotal ?? "IK失败"} 手指接触=${row.robotContacts ?? "n/a"}`).join(" | ")}；判定只用**固定配置** tcpOffsetM=${FIXED_GRASP_CONFIG.tcpOffsetM}（该档 手指接触=${chosenRow?.robotContacts ?? "n/a"} 闭合总宽=${chosenRow?.closedTotal ?? "n/a"}）——不按搜索命中项挑值`,
    })
    if (!fixedOffsetBlocked) return { gate: "G07", checks, blocked: `固定配置 tcpOffsetM=${FIXED_GRASP_CONFIG.tcpOffsetM} 在本机未复现"手指被物体挡住"（真实接触=0 且闭合总宽未超 ${OFFSET_BLOCKED_MIN_CLOSED_TOTAL_M}）；不改回"搜索到哪档就算哪档"，换值需先给真实读数依据` }

    // 闭合深度标定：既然正号偏移下手指跨度确实收窄（被挡），就用更深的目标宽度换真实接触。
    // 只认 `手指接触数>0` 或真实抬升 ≥ 0.08 的读数；不接受"看起来夹住了"。
    const closeWidths = [0.0384, 0.03, 0.024, 0.02]
    const depthRows: Array<{ width: number; total?: number; contacts?: number; liftM?: number }> = []
    // DEV-027 F14：`chosenClose` 同样不再由搜索挑选，固定为配置值。
    const chosenClose = FIXED_GRASP_CONFIG.closeWidthM
    for (const width of closeWidths) {
      const attempt = await h.provider.open({ ...snapshot, sceneId: `verify-g07-depth-${width}` })
      const base = await h.provider.observe(attempt.worldId, { contacts: true })
      const baseZ = cubeOf(base)[2]
      try {
        await h.provider.execute(attempt.worldId, { actionId: `depth-open-${width}`, expectedGeneration: attempt.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.08, durationS: 0.4 })
        await executePose(h.provider, plannerWith(chosenOffset) as never, attempt.worldId, "panda", { position: candidate.tcpPose.position as [number, number, number], quaternion: candidate.tcpPose.quaternion }, `depth-descend-${width}`)
        await h.provider.execute(attempt.worldId, { actionId: `depth-close-${width}`, expectedGeneration: attempt.worldGeneration, kind: "gripper", entityId: "panda", widthM: width, durationS: 0.7, settleTimeS: 0.5 })
        const closed = await h.provider.observe(attempt.worldId, { contacts: true })
        const fingerContacts = robotContactsOf(closed)
        // 真实抬升尝试：抬 12 cm 后看物体是否跟着起来（这才是"夹住了"的硬证据）。
        await executePose(h.provider, plannerWith(chosenOffset) as never, attempt.worldId, "panda", { position: [candidate.tcpPose.position[0], candidate.tcpPose.position[1], candidate.tcpPose.position[2] + 0.12], quaternion: candidate.tcpPose.quaternion }, `depth-lift-${width}`)
        const lifted = await h.provider.observe(attempt.worldId, { contacts: true })
        depthRows.push({ width, total: fingersOf(closed)?.total, contacts: fingerContacts, liftM: cubeOf(lifted)[2] - baseZ })
      } catch {
        depthRows.push({ width })
      }
      await h.provider.close(attempt.worldId)
    }
    // 判定用**真实抬升**（≥0.08 m）：接触数只作读数与"过滤器是否活着"的交叉核对。
    // A/B 实测（DEV-027 Round 2）：仅凭 `contacts>0` 会选中 close=0.0384——手指确实碰到物体（4 个接触），
    // 但抬不起来（lift≈0），于是下游 pick 失败；真正抬得起来的是 close=0.03（lift=0.1135）。
    // 抓取契约本身要求 lift≥0.08（`minimumLiftM`），这里取同一口径，避免"瞬时接触被算成夹住"。
    // DEV-027 F14：原本 `depthRows.find(...)` 挑第一档 lift≥0.08 当 `chosenClose`（同样是把"扫到过"
    // 当成"契约可复现"）。现在判定只认固定配置那一档；其余档位仍是真实读数，只作证据。
    const chosenDepthRow = depthRows.find(row => row.width === FIXED_GRASP_CONFIG.closeWidthM)
    const fixedDepthGripped = liftAchieved(chosenDepthRow)
    checks.push({
      name: "close_depth_calibration",
      ok: fixedDepthGripped,
      detail: `逐闭合宽度真实读数：${depthRows.map(row => `close=${row.width}→闭合总宽=${row.total ?? "IK失败"} 手指接触=${row.contacts ?? "n/a"} 实测抬升=${row.liftM ?? "n/a"}`).join(" | ")}；判定只用**固定配置** closeWidthM=${FIXED_GRASP_CONFIG.closeWidthM}（该档 实测抬升=${chosenDepthRow?.liftM ?? "n/a"}）——不按搜索命中项挑值`,
    })
    if (!fixedDepthGripped) return { gate: "G07", checks, blocked: `固定配置 closeWidthM=${FIXED_GRASP_CONFIG.closeWidthM} 在本机未复现 lift≥${0.08}；不放宽阈值，也不改回"搜索后判定"` }

    const picked = await pick(h.provider, plannerWith(chosenOffset) as never, { worldId: world.worldId, robotId: "panda", objectId: "cube", candidate, approachDistanceM: 0.1, liftHeightM: 0.12, minimumLiftM: 0.08, holdTimeS: 0.5, openWidthM: 0.08, closeWidthM: chosenClose, actionPrefix: "verify-g07" })
    const liftM = cubeOf(picked.after)[2] - cubeOf(picked.before)[2]
    // 手指闭合后的真实总宽：用于区分"夹住了但没抬起"与"根本没夹到"。
    const fingerWidthM = (() => {
      const joints = picked.after.entities.find(entity => entity.entityId === "panda")?.joints
      if (!joints) return undefined
      const at = joints.names.indexOf("finger_joint1"), bt = joints.names.indexOf("finger_joint2")
      return at < 0 || bt < 0 ? undefined : joints.positions[at]! + joints.positions[bt]!
    })()
    checks.push({
      name: "pick_reports_mode_and_outcome",
      ok: picked.executionMode === "physical-contact" && typeof picked.taskAchieved === "boolean",
      detail: `status=${picked.status} taskAchieved=${picked.taskAchieved} executionMode=${picked.executionMode} reason=${String(picked.reason)} facts=${JSON.stringify(picked.effect)}`,
    })
    checks.push({
      name: "pick_outcome_matches_measured_lift",
      ok: picked.taskAchieved === (liftM >= 0.08),
      detail: `measuredLiftM=${liftM} threshold=0.08 taskAchieved=${picked.taskAchieved} 手指闭合后总宽=${fingerWidthM ?? "n/a"}（命令 closeWidthM=${FIXED_GRASP_CONFIG.closeWidthM}＝固定配置值；此前这里印的是写死的 0.0384，与实际入参不符）`,
    })
    if (picked.taskAchieved) {
      const placed = await place(h.provider, planner as never, { worldId: world.worldId, robotId: "panda", objectId: "cube", targetPose: { position: [0.55, 0, 0.222], quaternion: [1, 0, 0, 0] }, openWidthM: 0.08, expectedSupportZ: 0.22, supportToleranceM: 0.01, stableSpeedMps: 0.03, holdTimeS: 0.5, retreatM: 0.12, actionPrefix: "verify-g07-place" })
      // 这里曾读 `effect.support`——**该字段不存在**，恒为 null，于是 detail 里那半句永远是空话。
      // 真正的字段是 `supportContactCount`（见 `robot-workflows/src/pick-place.ts:114`）。
      // 现在按合同 §6.2 G07「回执含实际物体位移/支撑事实」直接断言**测量事实**，
      // 而不是只断言产品自己算出来的 `status/taskAchieved`（那是同一事实的第二个 owner）。
      const placeEffect = placed.effect as { objectZ?: number; speedMps?: number; supportContactCount?: number; robotContactCount?: number; releaseReached?: unknown }
      const supportHolds = typeof placeEffect.supportContactCount === "number" && placeEffect.supportContactCount > 0
      const releasedFromRobot = placeEffect.robotContactCount === 0
      const zWithinTolerance = typeof placeEffect.objectZ === "number" && Math.abs(placeEffect.objectZ - 0.22) <= 0.01
      const settledSpeed = typeof placeEffect.speedMps === "number" && placeEffect.speedMps <= 0.03
      checks.push({
        name: "place_supported_after_release",
        ok: placed.status === "completed" && placed.taskAchieved === true
          && placed.executionMode === "physical-contact" && supportHolds && releasedFromRobot && zWithinTolerance && settledSpeed,
        detail: `status=${placed.status} taskAchieved=${placed.taskAchieved} executionMode=${placed.executionMode}`
          + `；**测量事实**：objectZ=${placeEffect.objectZ ?? "n/a"}（期望 0.22±0.01）、speedMps=${placeEffect.speedMps ?? "n/a"}（≤0.03）、支撑接触=${placeEffect.supportContactCount ?? "n/a"}（须>0）、机器人接触=${placeEffect.robotContactCount ?? "n/a"}（须=0）`,
      })
    } else {
      checks.push({ name: "place_supported_after_release", ok: false, detail: `抓取未达成（status=${picked.status} reason=${String(picked.reason)}），未执行放置` })
    }

    // 负例：把候选横向偏移 12cm（与原脚本 --failure 相同的做法），必须失败且不得报成功。
    const failedWorld = await h.provider.open({ ...snapshot, sceneId: "verify-g07-failure" })
    const failedBefore = await h.provider.observe(failedWorld.worldId, { contacts: true })
    const failedCandidates = proposeAnalytic({ entityId: "cube", frameId: failedBefore.frameId, centerM: cubeOf(failedBefore), sizeM: [0.04, 0.04, 0.04], maxWidthM: 0.08 })
    const offsetCandidate = { ...failedCandidates[0]!, tcpPose: { ...failedCandidates[0]!.tcpPose, position: [failedCandidates[0]!.tcpPose.position[0], failedCandidates[0]!.tcpPose.position[1] + 0.12, failedCandidates[0]!.tcpPose.position[2]] as [number, number, number] } }
    const failedPick = await pick(h.provider, planner as never, { worldId: failedWorld.worldId, robotId: "panda", objectId: "cube", candidate: offsetCandidate, approachDistanceM: 0.1, liftHeightM: 0.12, minimumLiftM: 0.08, holdTimeS: 0.5, openWidthM: 0.08, closeWidthM: 0.0384, actionPrefix: "verify-g07-fail" })
    const failedLiftM = cubeOf(failedPick.after)[2] - cubeOf(failedPick.before)[2]
    checks.push({
      name: "failure_does_not_report_success",
      ok: failedPick.taskAchieved === false,
      detail: `status=${failedPick.status} taskAchieved=${failedPick.taskAchieved} measuredLiftM=${failedLiftM} threshold=0.08 reason=${String(failedPick.reason)}`,
    })

    // assisted（attach/teleport）必须单列，不能计入物理抓取成功。
    const assistedWorld = await h.provider.open({ ...snapshot, sceneId: "verify-g07-assisted" })
    const assistedBefore = await h.provider.observe(assistedWorld.worldId, { contacts: true })
    // 顺序很重要：先把手臂开到物体附近就位，再 attach，最后才抬。
    // 反过来（先 attach 再让手臂从 Home 跳到远处）会把物体猛拽走，测到的是我自己造成的位移。
    await h.provider.execute(assistedWorld.worldId, { actionId: "assisted-open", expectedGeneration: assistedWorld.worldGeneration, kind: "gripper", entityId: "panda", widthM: 0.08, durationS: 0.4 })
    await executePose(h.provider, plannerWith(chosenOffset) as never, assistedWorld.worldId, "panda", { position: candidate.tcpPose.position as [number, number, number], quaternion: candidate.tcpPose.quaternion }, "assisted-descend")
    const assistedAtContact = await h.provider.observe(assistedWorld.worldId, { contacts: true })
    await h.provider.assist(assistedWorld.worldId, { mode: "attach", expectedGeneration: assistedWorld.worldGeneration, objectId: "cube", robotId: "panda", anchorBody: "hand" })
    await executePose(h.provider, plannerWith(chosenOffset) as never, assistedWorld.worldId, "panda", { position: [candidate.tcpPose.position[0], candidate.tcpPose.position[1], candidate.tcpPose.position[2] + 0.12], quaternion: candidate.tcpPose.quaternion }, "assisted-lift")
    const assistedAfter = await h.provider.observe(assistedWorld.worldId, { contacts: true })
    const assistedLift = cubeOf(assistedAfter)[2] - cubeOf(assistedAtContact)[2]
    checks.push({ name: "assisted_is_separate_from_physical", ok: assistedLift >= 0.08, detail: `assistedLiftM=${assistedLift} countsAsPhysicalGrasp=false（辅助搬移单列，不计接触抓取成功数）` })
    await h.provider.assist(assistedWorld.worldId, { mode: "release", expectedGeneration: assistedWorld.worldGeneration, objectId: "cube" })

    await h.provider.close(world.worldId); await h.provider.close(failedWorld.worldId); await h.provider.close(assistedWorld.worldId)
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await h.dispose()
  }
  return { gate: "G07", checks, blocked: null }
}

/**
 * G01：DSH 文本→真实 Tool→结果→会话恢复。
 * 合同 §6.2 G01 通过条件：真实使用 DSH 且只一条语言 Loop；Tool 结果可查看；恢复历史后继续对话。
 *
 * 诚实边界：现场产生新回合需要真实模型凭据。本入口在**没有凭据**时只验证不需要模型的部分
 * （真实会话产物的事件完整性），并把"现场回合 + 恢复后继续对话"明确报 BLOCKED，不用假回合充数。
 * 依合同 §7，不伪造模型调用、不伪造账户。
 */
async function gateG01(): Promise<GateResult> {
  const checks: Check[] = []
  const sessionsRoot = join(PRODUCT_ROOT, ".runtime/developer/developer/dsh/sessions")
  try {
    await access(sessionsRoot)
  } catch {
    return { gate: "G01", checks, blocked: `本机没有真实会话根 ${sessionsRoot}：无法验证任何真实回合产物` }
  }

  // 1) 找一份真实会话产物（每会话一个目录，内含 zstd 压缩的 v3 事件流）。
  const dirs: string[] = []
  for await (const scope of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    for await (const session of await readdir(join(sessionsRoot, scope.name), { withFileTypes: true })) {
      if (session.isDirectory()) dirs.push(join(sessionsRoot, scope.name, session.name))
    }
  }
  checks.push({ name: "real_session_artifacts_found", ok: dirs.length > 0, detail: `会话目录数=${dirs.length}` })
  if (!dirs.length) return { gate: "G01", checks, blocked: "会话根存在但没有会话目录" }

  // 2) 解压每一份产物并核对事件是否构成"真实的一轮 + 真实工具结果"。
  const tally: Array<{ session: string; turnEnd: string; calls: number; results: number; steps: number; tools: string[] }> = []
  for (const dir of dirs) {
    const file = (await readdir(dir)).find(name => name.endsWith(".jsonl.zstd"))
    if (!file) continue
    const raw = Bun.zstdDecompressSync(await readFile(join(dir, file)))
    let turnEnd = "", calls = 0, results = 0, steps = 0
    const tools = new Set<string>()
    for (const line of raw.toString("utf8").split("\n")) {
      if (!line.trim()) continue
      let event: { type?: string; data?: { name?: string; reason?: { kind?: string } } }
      try { event = JSON.parse(line) as typeof event } catch { continue }
      if (event.type === "turn/end") turnEnd = event.data?.reason?.kind ?? ""
      if (event.type === "step/start") steps++
      if (event.type === "tool/call") { calls++; if (event.data?.name) tools.add(event.data.name) }
      if (event.type === "tool/result") results++
    }
    tally.push({ session: file, turnEnd, calls, results, steps, tools: [...tools] })
  }
  const withTools = tally.filter(row => row.calls > 0)
  const complete = withTools.filter(row => row.calls === row.results && row.turnEnd === "completed")
  checks.push({
    name: "real_tool_round_trip_present",
    ok: complete.length > 0,
    detail: `含工具调用的会话=${withTools.length}，其中 call==result 且 turnEnd=completed 的=${complete.length}；样例 ${complete[0] ? `calls=${complete[0].calls} steps=${complete[0].steps} tools=[${complete[0].tools.join(",")}]` : "无"}`,
  })
  if (!complete.length) return { gate: "G01", checks, blocked: "没有一份产物同时具备 真实 tool/call==tool/result 与 turn/end=completed" }

  // 3) 真实工具执行面：真实技能文件可被按名定位并解析出描述，确认工具面不是空壳。
  const skillName = "scene-construction"
  const skillFile = join(PRODUCT_ROOT, "packages/lyapunov-shell/skills", skillName, "SKILL.md")
  let skillDescription = ""
  try {
    const text = await readFile(skillFile, "utf8")
    const match = /^---\n([\s\S]*?)\n---/.exec(text)
    skillDescription = (match?.[1] ?? "").split("\n").find(line => line.startsWith("description:")) ?? ""
  } catch { /* 记为不可解析 */ }
  checks.push({
    name: "tool_surface_real",
    ok: skillDescription.length > 0,
    detail: `技能 ${skillName} 的真实 SKILL.md 可解析=${skillDescription.length > 0}；该技能在真实会话中被调用过（见上一条 tools 列表）`,
  })

  // 4) 现场回合与"恢复后继续对话"：本入口**不做**现场回合（它由 G01LIVE 跑）。
  //
  // 这里曾有一个**假通过**：`blocked = Boolean(process.env.DEEPSEEK_API_KEY) ? null : "缺凭据"`。
  // 于是 `DEEPSEEK_API_KEY=dummy-not-a-real-key … --gate G01` 会打印 `3/3 通过` 并**退出 0**——
  // 全程没有任何模型回合、没有启动 DSH，仅凭"环境变量非空"就把现场条件判成已验证。
  // 这违反 §6.1（验收必须留下真实证据）、§6.4（退出码要反映真实结果）、§7（不得虚构）。
  // 已删除该推断：本入口**恒**把现场部分记为 BLOCKED，并指明真正跑现场的入口。
  return {
    gate: "G01",
    checks,
    blocked: "本入口只核对**既有会话产物**（历史证据）与工具面；《现场回合 + 恢复历史后继续对话》不由本入口验证："
      + "请跑 `bun run script/refactor-verify.ts --gate G01LIVE`（真实模型回合、真实 Tool、单语言 Loop）。"
      + "注意：**环境变量非空不等于已验证**——本条曾因此产生过假通过，已修正。",
  }
}

/** 未知或尚未接线的门：明确报 BLOCKED 与缺项，不返回成功。 */
function gateBlocked(gate: string, reason: string): GateResult {
  return { gate, checks: [], blocked: reason }
}

/**
 * 门的返回可以比共享最小合同多带 `removed`／`tally`（当前只有 G08/G09 这么返回）：
 * 薄入口只把已有结构打印出来，不另造格式、不重算计数——`removed` 行与四类计数直接取自门的返回值。
 */
type DetailedGateResult = GateResult & { removed?: RemovedScope[]; tally?: GateTally }

function report(result: DetailedGateResult): number {
  // UNCOVERED 行必须与 PASS 行**视觉可分**：此前薄入口把 `contract/*` 未覆盖项也打成
  // `PASS`，读回执的人会把"本环境没覆盖到"看成"已通过"。驱动 `run-g12.ts` 已会重分类，
  // 薄入口漏了这一步，现补齐——未覆盖项单独成类，既不进通过分子也不进失败分子。
  //
  // DEV-014 残留修复（2026-09-22／N39）：**四类计数与退出码不再自算**，统一取门内唯一判据 `tallyGate`
  // （`script/gates/g08g09.ts`，驱动 `run-g08g09.ts` 用的是同一个导出）。下面这两个列表只用于**分行打印**
  // （PASS/FAIL 与 UNCOVERED 必须视觉可分），它们自身不参与任何分子/分母/退出码——
  // **注意别误读成"未覆盖不影响退出码"**：未覆盖项由 `tallyGate` 计入 `uncovered`，使退出码为 2
  // （DEV-027 Round 7 裁决；文案见下面汇总行）。本注释说的只是"这两个本地列表是打印用的"。
  const isUncovered = (check: Check): boolean => check.name.startsWith("contract/") || check.detail.includes("UNCOVERED")
  const uncovered = result.checks.filter(check => isUncovered(check) && check.ok)
  const judged = result.checks.filter(check => !uncovered.includes(check))
  // 有 `tally` 的门（G08/G09）直接用门给的；其它门用它算同一形状（判据同源、结果逐项一致）。
  const tally: GateTally = result.tally ?? tallyGate({ checks: result.checks, blocked: result.blocked, removed: result.removed ?? [] })
  for (const check of judged) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
  for (const check of uncovered) console.log(`UNCOVERED  ${result.gate}/${check.name}  ${check.detail}`)
  // 移出范围行不进 `checks`（T6 的计数语义），只按门的 `removed` 单列打印：不能打成 PASS。
  for (const row of result.removed ?? []) console.log(`REMOVED  ${result.gate}/${row.name}  ${row.status}  ${row.detail}`)
  // 有 `tally` 的门（G08/G09）汇总行与驱动 `run-g08g09.ts` 同一表达：四类计数 + exitCode 逐项可复算。
  const summary = result.tally
    ? `${result.gate}: ${result.tally.passed}/${result.tally.judged} 通过，${result.tally.failed} 失败，移出范围 ${result.tally.removed}，未覆盖 ${result.tally.uncovered}（exitCode=${result.tally.exitCode}）`
    : undefined
  // 退出码优先级：**真实失败(1) 高于 BLOCKED/未覆盖(2)**。
  // 此前 `if (result.blocked) return 2` 判在失败之前，于是"1 条 FAIL + 有 BLOCKED 文案"会退 2，
  // 而且因为提前 return，连"20/21 通过，1 失败"这行汇总都不打印——失败被 BLOCKED 吞掉。
  // §6.4 的语义是 1=实测失败、2=缺依赖/未覆盖；两者同时存在时必须报更严重的那个。
  // 已用负对照实测：`G12_OPERATION_ATTEMPTS=0 … --gate G12` 曾在打印 FAIL 的情况下退出 2。
  // DEV-014 残留修复（N39）：分支条件与返回码都取 `tally`（`tallyGate` 已按同一优先级给 exitCode），
  // 分支结构保持原样只是为了保留各分支的**打印**差异；四类数字不再自算。
  if (tally.failed) {
    console.log(summary ?? `${result.gate}: ${tally.passed}/${tally.judged} 通过，${tally.failed} 失败${tally.uncovered ? `，另有未覆盖合同条件 ${tally.uncovered} 条` : ""}`)
    return tally.exitCode
  }
  if (result.checks.length === 0) {
    // 没有任何 check 时**不报"0/0 通过"**——那行会被读成"有结论"。
    console.log(`BLOCKED  ${result.gate}  ${result.blocked ?? "该门没有已接线的真实入口"}`)
    return 2
  }
  if (result.blocked) {
    // 即使全部测得的 check 都通过，也必须**同时**报出通过计数——否则回执里只有 4 行 PASS
    // 和一个 BLOCKED，读者无法一眼看出"测得几项、过几项"（G11LIVE 就曾这样）。
    console.log(summary ?? `${result.gate}: ${tally.passed}/${tally.judged} 通过${tally.uncovered ? `，另有未覆盖合同条件 ${tally.uncovered} 条` : ""}`)
    console.log(`BLOCKED  ${result.gate}  ${result.blocked}`)
    return tally.exitCode
  }
  if (tally.uncovered) {
    console.log(summary ?? `${result.gate}: ${tally.passed}/${tally.judged} 通过，另有未覆盖合同条件 ${tally.uncovered} 条（未覆盖条件不计入通过分子，但**使退出码为 2**：未完成，不是通过）`)
    return tally.exitCode
  }
  console.log(summary ?? `${result.gate}: ${tally.passed}/${tally.judged} 通过`)
  return tally.exitCode
}

/** 已知存在但尚未接入本入口的门 → 它自己的驱动命令；用于把 BLOCKED 说得准确。 */
const GATE_DRIVERS: Record<string, string> = {
  G10B: "node script/gates/run-g10b.mts",
  // G19 与 G10B 同一约束（bun 下 dsh-tools 模块图因 node:util 缺导出而崩），且它要真起 Cordis 树
  // + 真跑 Blender，不宜塞进薄入口。差别在**运行器**：`run-g19.ts` 在 bun 下**自切 node**
  // （`LYAPUNOV_G19_REEXEC=1` 防递归；node 起不来则明确 BLOCKED/2），所以这里给 `bun run …`。
  // 2026-09-27 收口：此前指 `run-g19.mts`，与 `bun run gate:drivers` 的「正确命令」列不一致
  // （机制那里按约定名 `run-<id>.ts` 优先，且 `.mts` 那条没有自切、bun 下是假失败）。
  G19: "bun run script/gates/run-g19.ts",
  // G18（3D 视口批注：附着/文字落盘/同源编号）同样不进薄入口：它要真起宿主 + 真浏览器，
  // 在没有可用 WebGL 的机器上应报 BLOCKED 而不是"未接线"。登记后薄入口会给准确指路文案。
  G18: "bun run script/gates/run-g18.ts",
}

const WIRED = new Set(["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "G12", "G13", "G14", "G15", "G16", "G17", "G01LIVE", "G11LIVE", "G15LIVE", "G13ACP"])

async function runGate(gate: string): Promise<number> {
  const normalized = gate.toUpperCase()
  if (!/^G(0[1-9]|1[0-9])(B|ACP|LIVE)?$/.test(normalized)) { console.log(`BLOCKED  ${gate}  未知门号`); return 2 }
  if (normalized === "G04") return report(await gateG04())
  if (normalized === "G06") return report(await gateG06())
  if (normalized === "G03") return report(await gateG03())
  if (normalized === "G02") return report(await gateG02())
  if (normalized === "G05") return report(await gateG05())
  if (normalized === "G07") return report(await gateG07())
  if (normalized === "G01LIVE") return report(await gateG01Live())
  if (normalized === "G15LIVE") return report(await gateG15Live())
  if (normalized === "G11LIVE") return report(await gateG11Live())
  // DEV-027 F18：G11 此前不在 WIRED、也没有 dispatch 分支 ⇒ `--gate G11` 与 `--all` 都只能落进
  // "该门尚未接线"的泛化文案（"没跑到"与"没有这一项"不可区分）。现给出**点名缺口的真入口**：
  // checks=[] + BLOCKED（多模态通路缺失），并把已接线部分指向 `--gate G11LIVE`。
  if (normalized === "G11") return report(gateG11())
  if (normalized === "G01") return report(await gateG01())
  if (normalized === "G15") return report(await gateG15())
  if (normalized === "G14") return report(await gateG14())
  if (normalized === "G10") return report(await gateG10())
  if (normalized === "G08") return report(await gateG08())
  if (normalized === "G09") return report(await gateG09())
  if (normalized === "G12") return report(await gateG12())
  // G16（服务端计价链门）随服务端源码于 2026-09-26 移出本仓库，归
  // LyapunovOM `backend/dev-server/_coupled/script/gates/g16.ts`。本仓不再有该门实现，
  // 入口如实报"已移出"，既不谎报通过，也不落进下面"该门尚未接线"的泛化文案
  // （那会把"验的是服务端"与"还没接"混为一谈）。
  if (normalized === "G16") return report(gateBlocked(normalized, "该门验的是服务端计价链（auth/central-billing/gateway/db/models），已随服务端源码移出本仓库；产品面不再提供入口，请到 LyapunovOM backend/dev-server/ 运行"))
  if (normalized === "G13") return report(await gateG13())
  if (normalized === "G17") return report(await gateG17())
  if (normalized === "G13ACP") return report(await gateG13Acp())
  if (WIRED.has(normalized)) return report(gateBlocked(normalized, "入口缺失"))
  // 措辞必须区分两种缺口，否则会误报成"没有实现"：
  //  · 本仓从未有验收入口的门 —— 证据产生于开发仓，测试脚本未随发布源复制；
  //  · 实现已存在、只是尚未接入本入口的门（此时应指明该跑哪个驱动）。
  const driveable = GATE_DRIVERS[normalized]
  return report(gateBlocked(normalized, driveable
    // 有独立驱动的门是**有意**不塞进薄入口（运行器约束），不是"还没接"——文案必须说清这点，
    // 否则读者会以为是一项待办。G10B/G19 都属于这一类。
    ? `该门有独立驱动，**有意不进薄入口**（运行器约束）：请用 \`${driveable}\``
    : "该门尚未接线：开发仓的验证脚本未随发布源复制，需要按合同 §6.4 逐门接线后才有真实入口"))
}

const LIVE_VARIANTS = ["G01LIVE", "G11LIVE", "G15LIVE", "G13ACP"]
const { values, flags } = parseArgs(process.argv.slice(2))
const requested = flags.has("all")
  // `--all` 必须覆盖**现场切片**：此前只列 G01–G17，于是 G01LIVE/G11LIVE/G15LIVE/G13ACP
  // 这些真正的现场证据被静默跳过——"没跑到"和"通过了"在回执上无法区分。现一并纳入。
  ? [...Array.from({ length: 17 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`), ...LIVE_VARIANTS, "G10B"]
  : [values.get("gate") ?? ""]
if (!requested[0]) { console.log("用法：bun run script/refactor-verify.ts --gate G04 [--engine mujoco] [--grasp analytic] | --all"); process.exit(2) }

// 退出码聚合：`1`（实测失败）**优先于** `2`（BLOCKED/未覆盖）。
// 此前用 `Math.max` 取最坏值，于是"某门真的失败了(1)"会被"另一门 BLOCKED(2)"盖成 2——
// 回执看起来只是"有未覆盖"，实际失败被吞掉。§6.4 明确 `--all` 不得吞掉失败。
let sawFailure = false, sawBlocked = false
for (const gate of requested) {
  const code = await runGate(gate)
  if (code === 1) sawFailure = true
  if (code === 2) sawBlocked = true
}
process.exit(sawFailure ? 1 : sawBlocked ? 2 : 0)
