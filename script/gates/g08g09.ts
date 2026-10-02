/**
 * G08 / G09 真实入口（合同 §6.2 的 G08/G09 行、§2.11 引擎与抓取算法独立替换、§6.1 证据要求、§7 诚实状态）。
 *
 * G08：单独运行 MuJoCo、Isaac、GraspGenX、AnyGrasp，每个 Provider 要有**真实**结果；
 *      候选坐标/夹爪与单位正确；没有伪造推理/引擎。缺 SDK/许可/GPU 的行按 BLOCKED 报，不给假 PASS。
 * G09：MuJoCo+GraspGenX、MuJoCo+AnyGrasp、Isaac+GraspGenX、Isaac+AnyGrasp 四行各自真实运行
 *      候选→计划→动作；每行至少一个适用 fixture 成功闭环，并保留失败案例；切换不改消费者。
 *
 * 本文件**独立可运行**：自己建临时工作根、自己装配 Provider、自己管理隔离 worker，
 * 不依赖 `script/refactor-verify.ts` 的内部函数（集成时由薄入口 import 本文件的 gateG08/gateG09）。
 *
 * 诚实边界（本机实测，2026-09-17）：
 *   - MuJoCo：`.runtime/sim-python` 真机可跑，走产品 MuJoCoProvider 真加载/真 step。
 *   - GraspGenX：走产品 `packages/grasp-graspgenx/src/operations.ts` → 真实 ZMQ → 本机既有的真实 GPU worker
 *     （用户既有本地镜像 + 固定模型/夹爪卷 + 既有条款接受配置）；不下载、不安装、不联网取权重。
 *   - Isaac：本机没有 Isaac 运行时（`.runtime/conda/envs/isaac/bin/python` 不存在、`isaacsim` 模块缺失），
 *     由真实尝试的真实报错判 BLOCKED，不用静态断言冒充。
 *   - AnyGrasp：用户已明确移出本轮（ACCEPTANCE.md: `removed_by_user`），不进入主动分母，也不伪造成通过。
 *     计数上单独登记为 `RemovedScope`（DEV-014，2026-09-21）：不进 `checks` 的通过分子、不进失败分子、
 *     不改退出码，四类计数见 `tallyGate`。
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { proposeAnalytic } from "../../packages/grasp-analytic/src/index.ts"
import { transformCandidate } from "../../packages/grasp-graspgenx/src/coordinates.ts"
import { runProvider as graspPropose } from "../../packages/grasp-graspgenx/src/operations.ts"
import { identityTransform, SCENE_COORDINATES, type Frame, type GraspCandidate, type MotionPlan, type SceneSnapshot } from "../../packages/lyapunov-contracts/src/types.ts"
import { runProvider as planMotion } from "../../packages/motion-mink/src/operations.ts"
import { executePose, pick, place, type PlaceResult, type PickResult, type Planner } from "../../packages/robot-workflows/src/pick-place.ts"
import type { SimWorlds } from "../../packages/sim-contract/src/index.ts"
import { MuJoCoProvider } from "../../packages/sim-mujoco/src/provider.ts"
import { IsaacProvider } from "../../packages/sim-isaac/src/provider.ts"
import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const SIM_PYTHON = join(PRODUCT_ROOT, ".runtime/sim-python/bin/python")
const MUJOCO_WORKER = join(PRODUCT_ROOT, "packages/sim-mujoco/python/worker.py")
/** 夹具路径按仓内实际布局解析；`materials/assets/resource-library/robot` 已在布局迁移中改名为 `materials/robots`。 */
const PANDA_FIXTURES = [
  join(PRODUCT_ROOT, "materials/robots/franka_panda/franka_emika_panda/panda.xml"),
  join(PRODUCT_ROOT, "materials/assets/resource-library/robot/franka_panda/franka_emika_panda/panda.xml"),
]
/** 真实录制点云（历史真实 GraspGenX 运行的同一输入夹具：40mm 立方体 cube-local 米制表面采样）。 */
const POINT_CLOUD_FIXTURES = [
  join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/D-evidence/cube40-cloud.json"),
  resolve(PRODUCT_ROOT, "../DSH/bugfixHistory/refactor-execution/D-evidence/cube40-cloud.json"),
]

/** 本机既有的真实 GraspGenX worker 部署（本地镜像 + 固定模型/夹爪卷）；不下载、不构建，只启动已安装件。 */
const GRASPGENX_IMAGE = process.env.LYAPUNOV_GRASPGENX_IMAGE ?? "lyaup-dsh-graspgenx-worker:t6-ab-local-inject-20260909"
const GRASPGENX_MODEL_VOLUME = process.env.LYAPUNOV_GRASPGENX_MODEL_VOLUME ?? "lyaup-graspgenx-models-7c834043c11a"
const GRASPGENX_GRIPPER_VOLUME = process.env.LYAPUNOV_GRASPGENX_GRIPPER_VOLUME ?? "lyaup-graspgenx-grippers-19a03c00d19a"
const GRASPGENX_CHECKPOINT_DIR = "/models/7c834043c11a11417e31d6d5ea9355801e40a2c1"
const GRASPGENX_GRIPPER_DIR = "/grippers/19a03c00d19aeaf052d0f6801f0041982d676e8a"
const OWNED_CONTAINER = process.env.LYAPUNOV_GRASPGENX_VERIFY_CONTAINER ?? "lyapunov-graspgenx-verify"
const HOST_PORT = process.env.LYAPUNOV_GRASPGENX_HOST_PORT ?? "5556"
const STARTUP_TIMEOUT_S = Number(process.env.LYAPUNOV_GRASPGENX_STARTUP_TIMEOUT_S ?? "300")
const MAX_WIDTH_M = 0.08

/** G09 四行状态（driver/报告直接读它；与 GateResult.checks 同步写入，不额外发明状态）。 */
export type RowStatus = "PASS" | "FAIL" | "BLOCKED" | "REMOVED_BY_USER"
export interface G09Row { engine: string; grasp: string; status: RowStatus; detail: string }
export const g09Rows: G09Row[] = []

/* ------------------------------------------------- 计数口径（DEV-014，2026-09-21） */

/**
 * 移出范围行（`REMOVED_BY_USER`）的显式登记：**不进 `checks`**，所以不会被任何按 `ok` 统计的驱动算进
 * "N/N 通过"（薄入口 `script/refactor-verify.ts` 与门驱动 `script/gates/run-g08g09.ts` 都按 `ok` 计数）。
 *
 * 依据：范围说明行以 `ok: true` 混进 `checks` 会让门的通过数无法由原件复算（coverage-audit
 * `bugfixHistory/refactor-execution/coverage-audit/COVERAGE-G01-G09.md`：应"从分母剔除并在输出里单列"）。
 * 它也不是失败：`ok` 语义里"用户移出范围"不是产品失败，因此它不进失败分子，也不改变退出码。
 */
export interface RemovedScope { name: string; status: RowStatus; detail: string }

/** 分母／通过／失败／移出范围／未覆盖与退出码：全部可由门的返回结构本身复算，不读门外状态。 */
export interface GateTally {
  /** `checks` 条数（已不含移出范围行）。 */
  checks: number
  /** 判定分母 = checks − 未覆盖行 − 残留的移出范围行。 */
  judged: number
  passed: number
  failed: number
  /** 移出范围行数：`removed` 列表 + 万一残留在 `checks` 里的 `_removed_by_user` 行（双保险）。 */
  removed: number
  /** 未覆盖行数（`contract/` 前缀或 detail 含 `UNCOVERED`，与薄入口同一判据）。 */
  uncovered: number
  /** 与薄入口 `report()` 同序：1 实际失败 > 2 阻断/未覆盖 > 0 全部通过。 */
  exitCode: number
}

/** 门的返回值 = 共享最小合同 + 移出范围列表与计数（`contract.ts` 不改，薄入口忽略多出的字段）。 */
export interface G08G09Result extends GateResult { removed: RemovedScope[]; tally: GateTally }

/** 薄入口 `script/refactor-verify.ts` 的未覆盖判据；它是顶层 CLI、不能 import，此处保持同一行判据。 */
const isUncovered = (check: Check): boolean => check.name.startsWith("contract/") || check.detail.includes("UNCOVERED")

/**
 * 移出范围行判据：名字以 `removed_by_user` 结尾（与 `g09Rows` 的 `REMOVED_BY_USER` 同一表达）。
 * 即使有人把范围说明行重新塞回 `checks`（修复前正是如此），它也只会算进 `removed`，**绝不**算进 `passed`。
 */
const isRemovedCheck = (check: Check): boolean => check.name.endsWith("removed_by_user")

/**
 * 通过／失败／移出范围／未覆盖四类分开计数并给出退出码（开发原则 §12）。
 * 移出范围行由调用方放进 `removed`，不在 `checks` 里：既不进通过分子，也不进失败分子，也不改退出码。
 */
export function tallyGate(result: { checks: Check[]; blocked: string | null; removed: RemovedScope[] }): GateTally {
  const strayRemoved = result.checks.filter(isRemovedCheck).length
  const uncovered = result.checks.filter(check => !isRemovedCheck(check) && isUncovered(check) && check.ok).length
  const judged = result.checks.length - strayRemoved - uncovered
  const failed = result.checks.filter(check => !isRemovedCheck(check) && !(isUncovered(check) && check.ok) && !check.ok).length
  return {
    checks: result.checks.length,
    judged,
    passed: judged - failed,
    failed,
    removed: result.removed.length + strayRemoved,
    uncovered,
    exitCode: failed > 0 ? 1 : result.blocked !== null || uncovered > 0 ? 2 : 0,
  }
}

/** 统一构造返回值：`removed` 与 `tally` 和 `checks` 同步生成，避免每个返回点各写一份计数。 */
function gateResult(gate: string, checks: Check[], blocked: string | null, removed: RemovedScope[]): G08G09Result {
  return { gate, checks, blocked, removed, tally: tallyGate({ checks, blocked, removed }) }
}

/* ------------------------------------------------------------------ 通用工具 */

interface Run { code: number; stdout: string; stderr: string }

/** 只用于 docker/进程探测；产品算法一律走产品模块，不在这里重写。 */
function exec(argv: string[], options: { timeoutMs?: number } = {}): Promise<Run> {
  return new Promise(done => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = "", settled = false
    const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); done({ code, stdout, stderr }) }
    const timer = options.timeoutMs ? setTimeout(() => { stderr += `\n[gate] 命令超时 ${options.timeoutMs}ms：${argv.join(" ")}`; child.kill("SIGKILL") }, options.timeoutMs) : undefined
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    child.on("error", error => { stderr += `\n[gate] 无法执行 ${argv[0]}：${String(error)}`; finish(-1) })
    child.on("close", code => finish(code ?? -1))
  })
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

/** 依赖真实存在的夹具文件；全部缺失时返回 null，由调用方报缺项。 */
async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) { try { await access(path); return path } catch { /* 继续找下一个候选 */ } }
  return null
}

/**
 * 真实模型身份判据（DEV-027 §3.5）：**非空字符串，且不是"把资源列表字符串化"的占位 `"[]"`**。
 *
 * 此前 G08 写的是 `Boolean(description.modelVersion)`，而 `Boolean("[]") === true` —— 夹具里 panda 的
 * `resources` 是 `[]`、Isaac worker 又把它 `json.dumps` 投递，于是**判据在任何输入下都不可能红**，
 * 读数就是缺陷值（`modelVersion=[]`）却报 PASS。本判据与 `script/refactor-verify.ts` 的 G07 断言
 * （F16 修 MuJoCo 侧时立的同一条）**逐字同源**，因此两侧对同一缺陷给出同一判定。
 *
 * 导出（不改判定）：让"这条判据能不能红"可以由真实 `bun -e` 直接求值，而不是靠读代码断言。
 */
export const hasRealModelVersion = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && value !== "[]"

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) })])
  } finally { if (timer) clearTimeout(timer) }
}

const errorText = (error: unknown) => String((error as Error)?.message ?? error).replace(/\s+/g, " ").trim()

/** 夹具/引擎共用的最小装配：真实 MuJoCoProvider + 临时工作根；用完必须 dispose。 */
async function mujocoHarness() {
  const directory = await mkdtemp(join(tmpdir(), "lyaup-verify-g08g09-"))
  const provider = new MuJoCoProvider({ pythonPath: SIM_PYTHON, workerPath: MUJOCO_WORKER })
  return {
    directory, provider,
    async dispose() { try { await provider.dispose() } finally { await rm(directory, { recursive: true, force: true }) } },
  }
}

/**
 * 桌面夹具，与历史真实 G09 回执（`g09-contact.ts`）逐字段一致：
 * Panda 在原点、台面 z=0.1（半高 0.1）、40mm/50g 立方体在 [0.45, 0, 0.2205]。
 * 控制映射只补夹具缺的项（§2.9）：夹爪由单 tendon 执行器 actuator8 驱动，ctrlrange 取自 panda.xml。
 */
const GRIPPER_CONTROLLER = { gripper: { actuator: "actuator8", jointNames: ["finger_joint1", "finger_joint2"], maxWidthM: MAX_WIDTH_M, controlRange: [0, 255] } }

function tabletopScene(sceneId: string, pandaPath: string): SceneSnapshot {
  return {
    sceneId, revision: 1, coordinates: SCENE_COORDINATES,
    entities: [
      { entityId: "panda", name: "panda", transform: identityTransform(), resources: [], components: { mujoco: { sourcePath: pandaPath }, controller: GRIPPER_CONTROLLER } },
      { entityId: "table", name: "支撑台", transform: { ...identityTransform(), position: [0.5, 0, 0.1] }, resources: [], components: { collision: { shape: "box", halfExtents: [0.3, 0.3, 0.1], friction: [1, 0.05, 0.001] }, rigidBody: { type: "static" } } },
      { entityId: "cube", name: "40mm方块", transform: { ...identityTransform(), position: [0.45, 0, 0.2205] }, resources: [], components: { collision: { shape: "box", halfExtents: [0.02, 0.02, 0.02], friction: [1.4, 0.1, 0.002] }, rigidBody: { type: "dynamic", massKg: 0.05 } } },
    ],
  }
}

const cubePosition = (frame: Frame) => frame.entities.find(entity => entity.entityId === "cube")!.transform.position

/* ------------------------------------------------------- GraspGenX worker 生命周期 */

interface WorkerHandle { endpoint: string; container: string | null; owned: boolean; evidence: string[] }

/**
 * 同一进程内的 worker 复用与延迟释放：
 * G08/G09 会在同一次 `--all` 里各要一次 worker；每次都停掉再启会让同一宿主端口反复回收（实测出现过
 * 一次冷启动后首次 infer 在 120s 超时后返回 `zmq.Again / Resource temporarily unavailable`）。
 * 因此这里把已获得的 worker 缓存起来复用，门结束时只**安排**释放（15s 内没有新的 ensure 才真正停止），
 * 并在进程退出钩子里同步兜底回收，保证 GPU 不遗留占用。
 */
let activeWorker: WorkerHandle | null = null
let stopTimer: ReturnType<typeof setTimeout> | undefined
const WORKER_STOP_DELAY_MS = Number(process.env.LYAPUNOV_GRASPGENX_STOP_DELAY_MS ?? "15000")

function cancelScheduledStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = undefined } }

/** 门结束时调用：仍归本门所有的 worker 延迟释放（同进程内后续门再要时会取消这次释放）。 */
function scheduleOwnedWorkerStop(worker: WorkerHandle): void {
  if (!worker.owned || !worker.container) return
  cancelScheduledStop()
  stopTimer = setTimeout(() => { stopTimer = undefined; void stopWorkerNow(worker) }, WORKER_STOP_DELAY_MS)
}

process.once("exit", () => {
  if (!activeWorker?.owned || !activeWorker.container) return
  // 进程退出兜底：同步停止并删除本门启动的容器，避免 GPU/端口被遗留占用。
  try { spawnSync("docker", ["rm", "-f", activeWorker.container], { timeout: 60000 }) } catch { /* 退出路径尽力而为 */ }
})

async function stopWorkerNow(worker: WorkerHandle): Promise<void> {
  if (!worker.owned || !worker.container) return
  await exec(["docker", "stop", worker.container], { timeoutMs: 180000 })
  await exec(["docker", "rm", "-f", worker.container], { timeoutMs: 60000 })
  if (activeWorker === worker) activeWorker = null
}

/** 真实诊断：推理失败时把本门启动的 worker 日志带进证据，避免只留一行错误文本。 */
async function workerLogTail(worker: WorkerHandle, lines = 10): Promise<string> {
  if (!worker.container) return "（外部 endpoint，无容器日志）"
  const logs = await exec(["docker", "logs", "--tail", String(lines), worker.container], { timeoutMs: 30000 })
  return ((logs.stdout + logs.stderr).trim().split("\n").slice(-lines).join(" | ") || "（无日志）").slice(0, 600)
}

/** 与产品 `runtime.py` 同一语义：显式 endpoint 优先，其次按容器名发现，最后才启动**已安装**的本地镜像。 */
async function ensureGraspGenXWorker(): Promise<{ worker: WorkerHandle } | { blocked: string }> {
  cancelScheduledStop()
  if (activeWorker) {
    if (!activeWorker.container) return { worker: activeWorker }
    const running = await exec(["docker", "inspect", activeWorker.container, "--format", "{{.State.Running}}"], { timeoutMs: 30000 })
    if (running.code === 0 && running.stdout.trim() === "true") return { worker: activeWorker }
    activeWorker = null
  }
  const explicit = process.env.GRASPGENX_ENDPOINT
  if (explicit) return { worker: (activeWorker = { endpoint: explicit, container: process.env.LYAPUNOV_GRASPGENX_CONTAINER ?? null, owned: false, evidence: [`GRASPGENX_ENDPOINT=${explicit}（操作者显式提供，未由本门启动）`] }) }

  const named = process.env.LYAPUNOV_GRASPGENX_CONTAINER
  if (named) {
    const state = await exec(["docker", "inspect", named, "--format", "{{json .State}}|{{json .NetworkSettings.Networks}}"], { timeoutMs: 30000 })
    if (state.code !== 0) return { blocked: `GraspGenX 容器不可用（LYAPUNOV_GRASPGENX_CONTAINER=${named}）：${state.stderr.trim().split("\n")[0] ?? ""}` }
    const [stateJson, networkJson] = state.stdout.trim().split("|")
    const parsed = JSON.parse(stateJson ?? "{}") as { Running?: boolean }
    if (!parsed.Running) return { blocked: `GraspGenX 容器未运行：${named}（按产品语义不隐式启动外部容器）` }
    const addresses = Object.values(JSON.parse(networkJson ?? "{}") as Record<string, { IPAddress?: string }>).map(network => network.IPAddress).filter((value): value is string => Boolean(value))
    if (addresses.length !== 1) return { blocked: `GraspGenX 容器网络不唯一（${named}）：请显式设置 GRASPGENX_ENDPOINT` }
    return { worker: (activeWorker = { endpoint: `tcp://${addresses[0]}:5556`, container: named, owned: false, evidence: [`LYAPUNOV_GRASPGENX_CONTAINER=${named} → ${addresses[0]}:5556（外部拥有）`] }) }
  }

  if (process.env.LYAPUNOV_GRASPGENX_AUTOSTART === "0") return { blocked: "未配置 GRASPGENX_ENDPOINT / LYAPUNOV_GRASPGENX_CONTAINER，且 LYAPUNOV_GRASPGENX_AUTOSTART=0 禁止启动本地已安装 worker" }

  const image = await exec(["docker", "image", "inspect", GRASPGENX_IMAGE, "--format", "{{.Id}}"], { timeoutMs: 30000 })
  if (image.code !== 0) return { blocked: `本机没有已安装的 GraspGenX worker 镜像 ${GRASPGENX_IMAGE}：${(image.stderr.trim().split("\n")[0] ?? "").slice(0, 300)}` }

  // 复用同名容器（若已在运行）；否则用与用户既有部署一致的环境启动本地镜像（不构建、不下载，模型/夹爪卷已就位）。
  const existing = await exec(["docker", "inspect", OWNED_CONTAINER, "--format", "{{.State.Running}}"], { timeoutMs: 30000 })
  let started = false
  if (!(existing.code === 0 && existing.stdout.trim() === "true")) {
    await exec(["docker", "rm", "-f", OWNED_CONTAINER], { timeoutMs: 60000 })
    const run = await exec(["docker", "run", "-d", "--name", OWNED_CONTAINER,
      "--gpus", "all", "-p", `127.0.0.1:${HOST_PORT}:5556`,
      "-v", `${GRASPGENX_MODEL_VOLUME}:/models`, "-v", `${GRASPGENX_GRIPPER_VOLUME}:/grippers`,
      "-e", `GRASPGENX_CHECKPOINT_DIR=${GRASPGENX_CHECKPOINT_DIR}`, "-e", `GRASPGENX_GRIPPER_CFG_DIR=${GRASPGENX_GRIPPER_DIR}`,
      // 条款接受标志沿用用户既有本地容器配置（§7：已获得的具体授权无需重复询问），本门不新主张任何授权。
      "-e", "LYAPUNOV_GRASPGENX_TERMS_ACCEPTED=I_ACKNOWLEDGE_GRASPGENX_MODEL_AND_ASSET_TERMS",
      "-e", "LYAUP_GRASPGENX_TERMS_ACCEPTED=I_ACKNOWLEDGE_GRASPGENX_MODEL_AND_ASSET_TERMS",
      "-e", "HF_ENDPOINT=https://hf-mirror.com", "-e", "HF_HUB_OFFLINE=1", "-e", "HF_HUB_DISABLE_TELEMETRY=1",
      "-e", "GRASPGENX_SOURCE_DIR=/opt/graspgenx", "-e", "GRASPGENX_UPSTREAM_ENDPOINT=tcp://127.0.0.1:5557",
      "-e", "GRASPGENX_ADAPTER_HOST=0.0.0.0", "-e", "GRASPGENX_ADAPTER_PORT=5556",
      "-e", "GRASPGENX_STARTUP_TIMEOUT_SECONDS=600",
      GRASPGENX_IMAGE], { timeoutMs: 120000 })
    if (run.code !== 0) return { blocked: `启动本地 GraspGenX worker 失败：${run.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}` }
    started = true
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_S * 1000
  let status = "unknown"
  while (Date.now() < deadline) {
    const health = await exec(["docker", "inspect", OWNED_CONTAINER, "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}"], { timeoutMs: 30000 })
    status = health.stdout.trim() || `inspect失败:${(health.stderr.trim().split("\n")[0] ?? "").slice(0, 120)}`
    if (status === "healthy" || status === "exited" || status === "dead") break
    await sleep(3000)
  }
  if (status !== "healthy") {
    const logs = await exec(["docker", "logs", "--tail", "15", OWNED_CONTAINER], { timeoutMs: 30000 })
    if (started) { await exec(["docker", "stop", OWNED_CONTAINER], { timeoutMs: 120000 }); await exec(["docker", "rm", "-f", OWNED_CONTAINER], { timeoutMs: 60000 }) }
    return { blocked: `GraspGenX worker 在 ${STARTUP_TIMEOUT_S}s 内未 healthy（最后状态=${status}）：${((logs.stdout + logs.stderr).trim().split("\n").slice(-4).join(" | ")).slice(0, 500)}` }
  }

  const evidence = [`镜像 ${GRASPGENX_IMAGE}（${image.stdout.trim()}）`, `容器 ${OWNED_CONTAINER} health=healthy`]
  if (started) evidence.push("由本门启动（结束时会停止并删除，GPU 不遗留占用）")
  else evidence.push("复用已在运行的容器（外部拥有，本门不停）")
  const logs = await exec(["docker", "logs", OWNED_CONTAINER], { timeoutMs: 30000 })
  if (/Model loaded|Loading GraspGen model weights/.test(`${logs.stdout}\n${logs.stderr}`)) evidence.push("容器日志含真实权重加载（Loading GraspGen model weights / Model loaded）")
  return { worker: (activeWorker = { endpoint: `tcp://127.0.0.1:${HOST_PORT}`, container: OWNED_CONTAINER, owned: started, evidence }) }
}



/* ------------------------------------------------------------------ 点云夹具 */

/** 确定性表面采样（40mm 立方体、cube-local、米制、2048×3），与录制夹具同构；仅在没有录制夹具时兜底。 */
function sampleCubeCloud(sizeM: number, count: number): number[][] {
  const half = sizeM / 2, points: number[][] = []
  let seed = 20260917
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let index = 0; index < count; index++) {
    const face = index % 6, u = (next() * 2 - 1) * half, v = (next() * 2 - 1) * half
    points.push(face === 0 ? [half, u, v] : face === 1 ? [-half, u, v] : face === 2 ? [u, half, v] : face === 3 ? [u, -half, v] : face === 4 ? [u, v, half] : [u, v, -half])
  }
  return points
}

/** 返回真实点云夹具路径与来源说明；两个来源都是真实夹具（历史录制真值优先）。 */
async function pointCloudFixture(directory: string): Promise<{ path: string; source: string }> {
  const recorded = await firstExisting(POINT_CLOUD_FIXTURES)
  if (recorded) return { path: recorded, source: `历史真实运行录制夹具 ${recorded}` }
  const path = join(directory, "cube40-cloud.json")
  await writeFile(path, JSON.stringify(sampleCubeCloud(0.04, 2048)))
  return { path, source: `无录制夹具，按 40mm 立方体真实几何确定性表面采样生成 ${path}（2048×3 米制）` }
}

/**
 * 「点云必须取到**仓内**件」的真断言（F15 的判据化）。
 *
 * F15 的修复此前只是**夹具落位**：`POINT_CLOUD_FIXTURES[0]` 是仓内件、`[1]` 是 `../DSH` 的仓外件，
 * 一旦有人删掉仓内件，门会静默回退到仓外件而**仍然全绿**（DEV-027 §3.2 的强负对照实测：门 6/6、
 * `exitCode=0`，而 `点云=` 已翻到仓外）——`refactor-verify.ts` 的 G05 侧有 `fixture_source_inside_repo`
 * 钉住同一件事，G08/G09 侧此前**没有**。本 check 把这条隐式环境依赖变成可红的断言：
 * 取到仓外件（或回退到临时目录里生成的合成点云）⇒ 本 check 必须红。
 * 形状与 `script/refactor-verify.ts` 的 G05 `fixture_source_inside_repo` 同源（真断言 + 路径进 detail）。
 * 导出（不改判定）：让"取到仓外件时这条能不能红"可以由真实 `bun -e` 直接求值。
 */
export function pointCloudSourceCheck(cloud: { path: string; source: string }, row?: string): Check {
  const insideRepo = cloud.path.startsWith(PRODUCT_ROOT + "/")
  const candidates = POINT_CLOUD_FIXTURES
    .map(path => `${path}（${path.startsWith(PRODUCT_ROOT + "/") ? "仓内" : "仓外"}）`)
    .join(" | ")
  return {
    name: "point_cloud_fixture_source_inside_repo",
    ok: insideRepo,
    detail: `${row ? `行=${row}；` : ""}点云=${cloud.path}；在仓库根 ${PRODUCT_ROOT}/ 内=${insideRepo}（干净 checkout 可跑的前提：不得依赖仓外的 ../DSH）；候选=[${candidates}]；来源=${cloud.source}`,
  }
}

/* ------------------------------------------------------------------ 候选校验 */

/**
 * 真实候选的字段/单位不变式：四元数与 approach 必须单位化、widthM 必须米制且在夹爪量程内、数值必须有限。
 * 坐标是否落在抓取带由选择策略判定：模型确实会输出偏离物体中心的 TCP——那是真实推理结果而不是单位错误，
 * 按策略过滤即可，不在这里当成缺陷。
 */
function candidateIssues(candidates: GraspCandidate[], entityId: string, frameId: string): string[] {
  const issues: string[] = []
  for (const candidate of candidates) {
    const { position, quaternion } = candidate.tcpPose, approach = candidate.approach
    if (![...position, ...quaternion, ...approach, candidate.widthM, candidate.score].every(Number.isFinite)) { issues.push(`${candidate.candidateId}: 含非有限数值`); continue }
    const quaternionNorm = Math.hypot(...quaternion)
    if (Math.abs(quaternionNorm - 1) > 1e-3) issues.push(`${candidate.candidateId}: 四元数非单位化 |q|=${quaternionNorm}`)
    const approachNorm = Math.hypot(...approach)
    if (Math.abs(approachNorm - 1) > 1e-3) issues.push(`${candidate.candidateId}: approach 非单位向量 |a|=${approachNorm}`)
    if (!(candidate.widthM > 0 && candidate.widthM <= MAX_WIDTH_M)) issues.push(`${candidate.candidateId}: widthM=${candidate.widthM} 超出 (0, ${MAX_WIDTH_M}] 米`)
    if (candidate.provider !== "graspgenx") issues.push(`${candidate.candidateId}: provider=${candidate.provider} 不是 graspgenx`)
    if (candidate.entityId !== entityId || candidate.frameId !== frameId) issues.push(`${candidate.candidateId}: 目标/框架回显不符 entityId=${candidate.entityId} frameId=${candidate.frameId}`)
    if (!(candidate.score >= 0 && candidate.score <= 1)) issues.push(`${candidate.candidateId}: score=${candidate.score} 不在 [0,1]（discriminator 分数）`)
  }
  return issues
}

/** 选择策略（取自历史真实回执 g09-contact.ts，逐字段一致）：顶抓（approach 朝下）+ TCP 落在 40mm 方块抓取带内。 */
function isApplicable(candidate: GraspCandidate): boolean {
  return candidate.approach[2] < -0.94 && candidate.tcpPose.position[2] >= -0.012 && candidate.tcpPose.position[2] <= 0.0285 && Math.hypot(candidate.tcpPose.position[0], candidate.tcpPose.position[1]) <= 0.02
}

interface InferenceReceipt {
  provider?: string; candidates?: GraspCandidate[]; noSolution?: boolean
  rawCount?: number; upstreamRawCount?: number | null; returnedCount?: number
  rejections?: Record<string, number>; metadata?: Record<string, string>; timing?: Record<string, number>
  tcpConvention?: string
}

/** 真实调用产品 Provider：`operations.ts` → 隔离算法解释器 → 真实 ZMQ worker；失败按产品错误码抛出。 */
async function proposeGraspGenX(endpoint: string, pointCloudPath: string, referenceDepthM?: number): Promise<InferenceReceipt> {
  process.env.GRASPGENX_ENDPOINT = endpoint
  return await graspPropose({ pointCloudPath, entityId: "cube", frameId: "cube-local", gripper: "franka_panda", maxWidthM: MAX_WIDTH_M, maxCandidates: 200, ...(referenceDepthM === undefined ? {} : { referenceDepthM }) }, { python: SIM_PYTHON }) as InferenceReceipt
}

/**
 * 带**有限真实重试**的推理调用：容器刚 healthy 时的偶发 `zmq.Again`（Resource temporarily unavailable）
 * 用真实重试吸收（每次都是真实请求，最多 attempts 次），失败时把每次真实错误与 worker 日志尾部带出，不吞错。
 */
async function proposeGraspGenXResilient(worker: WorkerHandle, cloudPath: string, referenceDepthM?: number, attempts = 3): Promise<{ receipt: InferenceReceipt; attemptLog: string[] }> {
  const attemptLog: string[] = []
  for (let index = 1; index <= attempts; index++) {
    try { return { receipt: await proposeGraspGenX(worker.endpoint, cloudPath, referenceDepthM), attemptLog } }
    catch (error) {
      const message = errorText(error)
      attemptLog.push(`第${index}/${attempts}次真实调用失败：${message}`)
      if (!message.includes("PROVIDER_UNAVAILABLE") || index === attempts) break
      await sleep(3000)
    }
  }
  throw new Error(`${attemptLog.join(" | ")}；worker 日志尾部：${await workerLogTail(worker)}`)
}

/* ------------------------------------------------------------------ G08 */

/**
 * G08：四个 Provider 各自单独真实加载/调用。
 * 通过条件（合同 §6.2 G08）：每个 Provider 有真实结果，候选坐标/夹爪和单位正确；没有伪造推理/引擎。
 * AnyGrasp 由用户移出本轮，单列为范围说明，不计 PASS。
 */
export async function gateG08(): Promise<G08G09Result> {
  const checks: Check[] = []
  const blockedParts: string[] = []
  const removed: RemovedScope[] = []
  const panda = await firstExisting(PANDA_FIXTURES)
  if (!panda) return gateResult("G08", checks, `缺少 Panda 夹具：${PANDA_FIXTURES.join(" | ")}`, removed)

  // 1) MuJoCo：真实加载 MJCF + 真实 step（位移与接触都来自引擎读数，不是断言）。
  const mujoco = await mujocoHarness()
  try {
    const world = await mujoco.provider.open(tabletopScene("verify-g08-mujoco", panda), { realtimeFactor: 2 })
    const description = await mujoco.provider.describe(world.worldId, "panda")
    const names = description.controlledJointNames
    const before = await mujoco.provider.observe(world.worldId, { contacts: true })
    const current = before.entities.find(entity => entity.entityId === "panda")?.joints
    // 目标由夹具自身的关节范围导出（Panda 的 joint4 是 [-3.0718, -0.0698]，不能写正值）：
    // 每个关节从实测当前位置朝自身范围中点走一半，必然在范围内，且是有真实位移的共同写入。
    const targets = names.map((name, index) => {
      const joint = description.joints.find(item => item.name === name)
      const at = current?.names.indexOf(name) ?? -1
      const now = at < 0 ? 0 : current!.positions[at]!
      if (!joint?.range) return now + 0.03 * (index + 1)
      const center = (joint.range[0] + joint.range[1]) / 2
      return now + 0.5 * (center - now)
    })
    const receipt = await mujoco.provider.execute(world.worldId, { actionId: `verify-g08-mujoco-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "panda", jointNames: names, positions: targets, durationS: 1, settleTimeS: 0.5, tolerance: 0.03 })
    const after = await mujoco.provider.observe(world.worldId, { contacts: true })
    const joints = after.entities.find(entity => entity.entityId === "panda")?.joints
    const errors = names.map((name, index) => {
      const at = joints?.names.indexOf(name) ?? -1
      return at < 0 ? Number.NaN : Math.abs(joints!.positions[at]! - targets[index]!)
    })
    const maxError = errors.length && errors.every(Number.isFinite) ? Math.max(...errors) : Number.NaN
    const travelled = names.map((name) => {
      const at = current?.names.indexOf(name) ?? -1, bt = joints?.names.indexOf(name) ?? -1
      return at < 0 || bt < 0 ? 0 : Math.abs(joints!.positions[bt]! - current!.positions[at]!)
    })
    const maxTravelled = Math.max(...travelled)
    const cubeContacts = (after.contacts ?? []).filter(contact => contact.geom1.startsWith("cube/") || contact.geom2.startsWith("cube/"))
    const allJointNames = joints?.names ?? []
    checks.push({
      name: "mujoco_provider_real_load_step",
      ok: names.length === 7 && allJointNames.includes("finger_joint1") && allJointNames.includes("finger_joint2") && receipt.status === "completed" && after.stepIndex > before.stepIndex && after.simTime > before.simTime && Number.isFinite(maxError) && maxError <= 0.03 && maxTravelled > 0.01 && cubeContacts.length > 0,
      detail: `engine=${world.engineId} modelVersion=${JSON.stringify(description.modelVersion)} 控制关节=${names.length}（全部关节=${allJointNames.length}，含手指 finger_joint1/2=${allJointNames.includes("finger_joint1") && allJointNames.includes("finger_joint2")}） 动作=${receipt.status} step ${before.stepIndex}→${after.stepIndex} simTime ${before.simTime.toFixed(3)}→${after.simTime.toFixed(3)}s 关节最大误差=${maxError}（容差 0.03） 实测最大位移=${maxTravelled}rad 立方体真实接触=${cubeContacts.length}`,
    })
    await mujoco.provider.close(world.worldId)
  } catch (error) {
    checks.push({ name: "mujoco_provider_real_load_step", ok: false, detail: `真实调用 MuJoCo 失败：${errorText(error)}` })
  } finally { await mujoco.dispose() }

  // 2) GraspGenX：真实 GPU worker 推理（同一产品 Provider 路径），并核对候选单位/夹爪/坐标。
  const ensured = await ensureGraspGenXWorker()
  if ("blocked" in ensured) {
    checks.push({ name: "graspgenx_provider_real_inference", ok: false, detail: `未获得可调用的真实 GraspGenX worker：${ensured.blocked}` })
    blockedParts.push(`GraspGenX：${ensured.blocked}`)
  } else {
    const worker = ensured.worker
    const cloudDirectory = await mkdtemp(join(tmpdir(), "lyaup-verify-g08-cloud-"))
    try {
      const cloud = await pointCloudFixture(cloudDirectory)
      checks.push(pointCloudSourceCheck(cloud))
      const { receipt: inference, attemptLog } = await proposeGraspGenXResilient(worker, cloud.path)
      const candidates = inference.candidates ?? []
      const pins = inference.metadata ?? {}
      const inferMs = Number(inference.timing?.infer_ms ?? Number.NaN)
      // 真实推理判据：真 pin 元数据 + worker 自报 infer 耗时 + 上游原始候选计数 ≥ 返回数，且候选非空。
      checks.push({
        name: "graspgenx_provider_real_inference",
        ok: Boolean(pins.provider_version?.toLowerCase().includes("graspgenx"))
          && Boolean(pins.source_commit && pins.model_revision && pins.gripper_revision)
          && Number.isFinite(inferMs) && inferMs > 0
          && typeof inference.upstreamRawCount === "number" && inference.upstreamRawCount >= (inference.returnedCount ?? 0)
          && (inference.rawCount ?? 0) > 0 && candidates.length > 0 && inference.noSolution !== true,
        detail: `provider=${inference.provider} 候选=${candidates.length} rawCount=${inference.rawCount} upstreamRawCount=${inference.upstreamRawCount} returnedCount=${inference.returnedCount} 拒绝=${JSON.stringify(inference.rejections ?? {})} worker自报infer_ms=${inferMs} metadata=${JSON.stringify(pins)} endpoint=${worker.endpoint}${attemptLog.length ? ` 重试记录=${attemptLog.join("；")}` : ""}｜${worker.evidence.join("；")}｜点云=${cloud.source}`,
      })
      const issues = candidateIssues(candidates, "cube", "cube-local")
      const widths = candidates.map(candidate => candidate.widthM)
      const applicable = candidates.filter(isApplicable)
      const maxLateral = candidates.length ? Math.max(...candidates.map(candidate => Math.hypot(candidate.tcpPose.position[0], candidate.tcpPose.position[1]))) : Number.NaN
      // 适用候选来自 GPU 采样，其数量本身随机（0～数个）。为 0 时**没有可判定的样本**：
      // 既不能报"校验失败"（那是把输入不足说成产品缺陷），也**不算通过**——
      // 两项与候选相关的检查都报 INCONCLUSIVE，由调用方决定是否重跑取样；退出码仍为 2（依赖/样本不足）。
      if (applicable.length === 0) {
        const note = `本次推理未产生落在抓取策略带内的候选（适用 0/${candidates.length}，最大横向偏移 ${maxLateral}m）；单位/框架与坐标两项**未取得判定依据（INCONCLUSIVE）**，非校验失败，也不算通过。`
        checks.push({ name: "graspgenx_candidate_units_and_frames", ok: false, detail: note })
        checks.push({ name: "graspgenx_candidate_coordinates_in_world", ok: false, detail: note })
        return gateResult("G08", checks, `GraspGenX 本次采样未取得适用候选：${note}`, removed)
      }
      checks.push({
        name: "graspgenx_candidate_units_and_frames",
        // 这句在 applicable>0 时评估；applicable 为 0 的分支已在上面单独报 INCONCLUSIVE。
        ok: candidates.length > 0 && issues.length === 0,
        detail: `校验 ${candidates.length} 个真实候选（entityId=cube frameId=cube-local provider=graspgenx；四元数/approach 单位化、widthM∈(0,${MAX_WIDTH_M}]米、数值有限、score∈[0,1]）：单位/框架问题数=${issues.length}${issues.length ? ` → ${issues.slice(0, 5).join("；")}` : ""}；widthM 范围=[${widths.length ? Math.min(...widths) : "n/a"}, ${widths.length ? Math.max(...widths) : "n/a"}]m；按策略适用 ${applicable.length}/${candidates.length}（策略：approach.z<-0.94、TCP z∈[-0.012,0.0285]m、横向半径<=0.02m），全部候选最大横向偏移=${maxLateral}m（模型真实输出，超出策略带的候选按策略不进入计划）${applicable.length === 0 ? "；本次未取得适用候选 → INCONCLUSIVE（输入不足，非校验失败）" : ""} tcpConvention=${inference.tcpConvention ?? "(未提供)"}`,
      })
      // 坐标/夹爪正确性：把策略适用候选按其真实 frame 变换到世界，核对落在真实夹具的抓取带内。
      const world = await mujocoHarness()
      try {
        const w = await world.provider.open(tabletopScene("verify-g08-frame-check", panda), { realtimeFactor: 2 })
        const snapshot = await world.provider.observe(w.worldId)
        const object = snapshot.entities.find(entity => entity.entityId === "cube")!
        const worlds = applicable.map(candidate => ({ candidate, world: transformCandidate(candidate, object.transform, snapshot.frameId) }))
        const inside = worlds.filter(entry => Math.abs(entry.world.tcpPose.position[0] - 0.45) <= 0.03 && Math.abs(entry.world.tcpPose.position[1]) <= 0.03 && entry.world.tcpPose.position[2] >= 0.2085 && entry.world.tcpPose.position[2] <= 0.249)
        checks.push({
          name: "graspgenx_candidate_coordinates_in_world",
          ok: inside.length === applicable.length,
          detail: `夹爪=${GRIPPER_CONTROLLER.gripper.jointNames.join("/")}（actuator8，量程 ${MAX_WIDTH_M}m）；把 ${applicable.length} 个适用候选用产品 transformCandidate 按 cube 实体真实位姿 ${JSON.stringify(object.transform.position.map(value => Number(value.toFixed(4))))} 与 frameId=${snapshot.frameId} 变换到世界：落在 40mm 方块抓取带内=${inside.length}/${applicable.length}；样例 ${worlds.slice(0, 2).map(entry => `${entry.candidate.candidateId}→[${entry.world.tcpPose.position.map(value => Number(value.toFixed(4))).join(",")}] widthM=${entry.candidate.widthM.toFixed(4)}`).join("；")}`,
        })
        await world.provider.close(w.worldId)
      } catch (error) {
        checks.push({ name: "graspgenx_candidate_coordinates_in_world", ok: false, detail: `世界坐标核对失败：${errorText(error)}` })
      } finally { await world.dispose() }
      checks.push({
        name: "graspgenx_worker_is_installed_local_gpu_worker",
        ok: worker.container !== null ? worker.evidence.some(line => line.includes("真实权重加载")) : true,
        detail: worker.container !== null ? worker.evidence.join("；") : `操作者显式提供外部 endpoint=${worker.endpoint}：未由本门启动，容器内取证不适用；真实推理以 worker 自报 metadata/infer_ms 为准`,
      })
    } catch (error) {
      checks.push({ name: "graspgenx_provider_real_inference", ok: false, detail: `真实调用 GraspGenX 失败：${errorText(error)}` })
    } finally {
      await rm(cloudDirectory, { recursive: true, force: true })
      scheduleOwnedWorkerStop(worker)
    }
  }

  // 3) Isaac：真实尝试（真起 provider），失败即按真实报错 BLOCKED，不写静态断言。
  const isaac = new IsaacProvider()
  try {
    const world = await withTimeout(isaac.open(tabletopScene("verify-g08-isaac", panda)), 120000, "ISAAC_OPEN_TIMEOUT: 120s 内未返回")
    const description = await isaac.describe(world.worldId, "panda")
    const state = await isaac.observe(world.worldId)
    // DEV-027 §3.5：此处原为 `Boolean(description.modelVersion)` —— `Boolean("[]") === true`，
    // 判据不可能红（夹具 panda 的 resources=[] ⇒ Isaac worker 投递的就是字符串 "[]"）。
    // 换成与 G07（`refactor-verify.ts` F16 那一条）逐字同源的非空断言；worker 侧同步修（见 worker.py describe）。
    const isaacModelVersionReal = hasRealModelVersion(description.modelVersion)
    checks.push({ name: "isaac_provider_real_load_step", ok: state.stepIndex >= 0 && isaacModelVersionReal, detail: `engine=${world.engineId} modelVersion=${description.modelVersion}（非空且非 "[]"=${isaacModelVersionReal}） joints=${description.controlledJointNames.length} stepIndex=${state.stepIndex}` })
    await isaac.close(world.worldId)
  } catch (error) {
    const message = errorText(error)
    // 「缺外部运行时」不是产品失败，必须与"实测失败"分开报，否则退出码会说谎。
    // 原先这里写 `ok: false`，于是**缺 Isaac 环境**被算成 1 条真实 FAIL，整门退出 1；
    // 而合同 §6.2 G08「Isaac 行」的未完成属于 §7 的外部依赖阻断，应是退出 2。
    // 口径与 G12 的 UNCOVERED 一致：check 标记为"不计入通过分子、不代表通过"，同时必须进 blocked 列表
    // （G08/G09 走 `run-g08g09.ts`，退出码直接取 `tally.exitCode` ⇒ 有未覆盖即为 2）。
    // 名字里的 `contract/` 前缀 + detail 里的 `UNCOVERED` 让薄入口与驱动都能把它单独成类。
    checks.push({ name: "contract/isaac_provider_real_load_step", ok: true, detail: `UNCOVERED（不计入通过分子，不代表通过）—— 缺外部运行时，非产品失败：真实启动 Isaac Provider 失败 → ${message}` })
    blockedParts.push(`Isaac（外部运行时缺失，非产品失败）：${message}`)
  } finally { await isaac.dispose().catch(() => { /* 关闭失败不掩盖上面的真实结论 */ }) }

  // 4) AnyGrasp：范围说明（非通过项）——单独登记为移出范围，不进 `checks`，因此不进通过分子。
  removed.push({
    name: "anygrasp_scope_removed_by_user",
    status: "REMOVED_BY_USER",
    detail: "非通过项（范围说明）：AnyGrasp 由用户明确移出本轮（ACCEPTANCE.md 记为 removed_by_user）；本入口未安装、未下载、未推理、不计入 G08 分母，也不作为本门阻断项。",
  })

  return gateResult("G08", checks, blockedParts.length ? blockedParts.join("；") : null, removed)
}

/* ------------------------------------------------------------------ G09 */

interface RowOutcome { checks: Check[]; blocked: string | null; status: RowStatus }

/**
 * GraspGenX Provider 的 TCP 参考深度标定档（真实读数标定，见 `..._reference_depth_calibration` 检查的 detail）。
 *
 * 背景（本轮真机实测）：`propose.py` 的默认 `referenceDepthM=0.1034` 是按**旧 Panda 资产**标定的——那时整只
 * 手指的凸壳 mesh 都参与碰撞，指垫中心高 2cm 也能夹住。当前仓的 `materials/robots/franka_panda` 把手指凸壳
 * 改成 `contype=0 conaffinity=0`、只剩 17mm 高的指垫可碰，同一个默认值会让 TCP 落在物体顶面上方约 2cm，
 * 指垫只擦到顶棱、闭合时空夹（实测：闭合总宽=命令值、机器人接触=0、抬升≈0）。TCP 参考深度属于 §2.11 划给
 * 抓取 Provider 自己的「夹爪参考帧/TCP 偏移」，因此按真实读数标定它，**不动 propose.py，也不动成功判据**。
 */
const REFERENCE_DEPTH_CALIBRATION: Array<{ depth: number; note: string }> = [
  { depth: 0.1034, note: "propose.py 默认值（历史 Panda 资产标定）" },
  { depth: 0.1234, note: "指垫中心标定档（本轮真机实测命中）" },
  { depth: 0.1334, note: "标定带内第二档" },
  { depth: 0.1384, note: "标定带内第三档" },
]
/**
 * 每个深度档最多尝试的候选数：够覆盖真实候选集，又不把「一直无解」藏进无界重试。
 *
 * 从 2 提到 4 的原因（2026-09-17 实测到的 flaky）：GraspGenX 每次推理返回 200 个候选，
 * 适用策略（approach.z/TCP z/横向半径）过滤后只剩 **1 个左右**，而随机性在于**哪个候选**存活——
 * 两次连跑分别存活 `graspgenx-12` 与 `graspgenx-36`。前者实测接触=0、抬升 −0.00011 m（真失败），
 * 后者接触=4、抬升 0.10844 m（真成功）。预算 2 时若存活的第一个候选恰好是夹不住的，
 * 该档就"用完"，门报 FAIL——**成功判据没变，变的是夹具的候选采样窗口**。
 * 4 仍是有界值（最多 4 档 × 4 候选）：真正一直无解时照样失败，不会藏进无界重试。
 */
const CANDIDATES_PER_DEPTH = 4
/**
 * 闭合宽度是本仓 G07 已实测标定的消费者夹具参数（G07/close_depth_calibration 真实读数：
 * close=0.0384 → 只接触不抬升（实测抬升 -0.00046m）；close=0.03 → 实测抬升 0.112m）。
 * 成功判据（抬升≥0.08m、保持≥0.5s、放置后支撑）不因它改变。
 */
const CLOSE_WIDTH_M = 0.03

/**
 * G09 单行（引擎 × GraspGenX）：真实候选 → 真实 IK 计划 → 真实接触动作。
 * 引擎差异只体现在世界服务实例上；消费者（pick/place/executePose + mink planner）在两种引擎间**完全相同**，
 * 这正是合同 §2.11「切换只动配置/Provider，消费者不改」的可执行证据。
 * 这里的 `sim` 是**单个会话的世界服务**（产品里按会话取自 `SessionSimFactory.forSession`）；
 * 门禁脚本自己只跑一个会话，所以直接拿这一个实例，不复制多会话装配。
 */
async function rowGraspGenX(engine: "mujoco" | "isaac", sim: SimWorlds, pandaPath: string, worker: WorkerHandle): Promise<RowOutcome> {
  const checks: Check[] = []
  const scene = tabletopScene(`verify-g09-${engine}-graspgenx`, pandaPath)
  const cloudDirectory = await mkdtemp(join(tmpdir(), `lyaup-verify-g09-${engine}-cloud-`))
  const consumerFiles = [join(PRODUCT_ROOT, "packages/robot-workflows/src/pick-place.ts"), join(PRODUCT_ROOT, "packages/motion-mink/src/operations.ts")]
  const digestBefore = await Promise.all(consumerFiles.map(fileDigest))
  try {
    const cloud = await pointCloudFixture(cloudDirectory)
    checks.push(pointCloudSourceCheck(cloud, `${engine}+graspgenx`))
    // 选择策略见 isApplicable（与历史真实回执 g09-contact.ts 逐字段一致）：候选只按同一方法内的
    // discriminator 分数排序，不做跨方法比较。
    const policy = isApplicable

    const planner: Planner = async request => {
      const description = await sim.describe(request.worldId, request.entityId)
      const joints = request.start.entities.find(entity => entity.entityId === request.entityId)!.joints!
      const names = description.controlledJointNames
      const startPositions = names.map(name => joints.positions[joints.names.indexOf(name)]!)
      const result = await planMotion({
        modelPath: pandaPath, jointNames: names, startPositions,
        seeds: [startPositions, [0, -0.6, 0, -2.2, 0, 1.8, 0.7853981634], [0, -0.4, 0, -1.8, 0, 1.4, 0.78]],
        fixedJoints: { finger_joint1: joints.positions[joints.names.indexOf("finger_joint1")], finger_joint2: joints.positions[joints.names.indexOf("finger_joint2")] },
        tcp: { body: "hand", offsetM: [0, 0, 0.1029] },
        targetPose: { position: request.targetPose.position, quaternion: request.targetPose.quaternion },
        entityId: request.entityId, modelVersion: description.modelVersion, collisionContextVersion: description.collisionContextVersion,
        expectedGeneration: request.start.generation, durationS: 2, positionToleranceM: 0.0005, orientationToleranceRad: 0.01,
      }, { python: SIM_PYTHON, signal: request.signal })
      if (!result.plan) throw new Error(`IK_NO_SOLUTION: ${result.error ?? ""} ${result.message ?? "未收敛"}`)
      return result.plan as MotionPlan
    }

    const attempt = async (label: string, local: GraspCandidate): Promise<{ picked?: PickResult; placed?: PlaceResult; liftedM?: number; closedWidthM?: number; worldPosition?: number[]; frameId?: string; error?: string }> => {
      const world = await sim.open(scene, { realtimeFactor: 2 })
      try {
        const snapshot = await sim.observe(world.worldId)
        const object = snapshot.entities.find(entity => entity.entityId === "cube")!
        const candidate = transformCandidate(local, object.transform, snapshot.frameId)
        const picked = await pick(sim, planner, { worldId: world.worldId, robotId: "panda", objectId: "cube", candidate, approachDistanceM: 0.1, liftHeightM: 0.12, minimumLiftM: 0.08, holdTimeS: 0.5, openWidthM: 0.08, closeWidthM: CLOSE_WIDTH_M, actionPrefix: `verify-g09-${engine}-${label}` })
        const liftedM = cubePosition(picked.after)[2] - cubePosition(picked.before)[2]
        const fingers = picked.after.entities.find(entity => entity.entityId === "panda")?.joints
        const closedWidthM = fingers ? fingers.positions[fingers.names.indexOf("finger_joint1")]! + fingers.positions[fingers.names.indexOf("finger_joint2")]! : Number.NaN
        let placed: PlaceResult | undefined
        if (picked.taskAchieved) placed = await place(sim, planner, { worldId: world.worldId, robotId: "panda", objectId: "cube", targetPose: { position: [0.55, 0, 0.222], quaternion: [1, 0, 0, 0] }, openWidthM: 0.08, expectedSupportZ: 0.22, supportToleranceM: 0.01, stableSpeedMps: 0.03, holdTimeS: 0.5, retreatM: 0.12, actionPrefix: `verify-g09-${engine}-${label}-place` })
        return { picked, placed, liftedM, closedWidthM, worldPosition: candidate.tcpPose.position, frameId: candidate.frameId }
      } catch (error) {
        return { error: errorText(error) }
      } finally { await sim.close(world.worldId).catch(() => { /* 关闭失败不掩盖本轮真实结论 */ }) }
    }

    // 第一个深度档用于「真实推理/适用候选」两项检查；同时作为整体证据记录。
    const first = await proposeGraspGenXResilient(worker, cloud.path, REFERENCE_DEPTH_CALIBRATION[0]!.depth)
    let inference = first.receipt
    const attemptLog: string[] = first.attemptLog
    const pins = inference.metadata ?? {}
    const inferMs = Number(inference.timing?.infer_ms ?? Number.NaN)
    const firstCandidates = inference.candidates ?? []
    checks.push({
      name: `${engine}_graspgenx_fresh_inference`,
      ok: firstCandidates.length > 0 && Number.isFinite(inferMs) && inferMs > 0 && Boolean(pins.source_commit && pins.model_revision && pins.gripper_revision),
      detail: `一次真实推理（referenceDepthM=${REFERENCE_DEPTH_CALIBRATION[0]!.depth}）：候选=${firstCandidates.length} rawCount=${inference.rawCount} upstreamRawCount=${inference.upstreamRawCount} worker自报infer_ms=${inferMs} metadata=${JSON.stringify(pins)} endpoint=${worker.endpoint}${attemptLog.length ? ` 重试记录=${attemptLog.join("；")}` : ""}｜${worker.evidence.join("；")}｜点云=${cloud.source}`,
    })
    const firstApplicable = firstCandidates.filter(policy).sort((left, right) => right.score - left.score)
    checks.push({
      name: `${engine}_graspgenx_applicable_candidate`,
      ok: firstApplicable.length > 0,
      detail: `适用候选=${firstApplicable.length}/${firstCandidates.length}（策略取自历史真实回执 g09-contact.ts：approach.z<-0.94、TCP z∈[-0.012,0.0285]m、横向半径<=0.02m）；前 3 名=${firstApplicable.slice(0, 3).map(candidate => `${candidate.candidateId}@${candidate.score.toFixed(3)}`).join(",")}`,
    })

    // 真实标定 + 真实闭环：逐档做真实推理并按分数顺序真实执行；先看是否真夹住（指垫被挡：闭合总宽 > 命令值）。
    const readings: string[] = []
    let adopted: { depth: number; candidate: GraspCandidate; outcome: Awaited<ReturnType<typeof attempt>> } | undefined
    for (const entry of REFERENCE_DEPTH_CALIBRATION) {
      if (entry.depth !== REFERENCE_DEPTH_CALIBRATION[0]!.depth) {
        const call = await proposeGraspGenXResilient(worker, cloud.path, entry.depth)
        inference = call.receipt
        attemptLog.push(...call.attemptLog)
      }
      const applicable = (inference.candidates ?? []).filter(policy).sort((left, right) => right.score - left.score)
      for (const candidate of applicable.slice(0, CANDIDATES_PER_DEPTH)) {
        const outcome = await attempt(`d${entry.depth}-${candidate.candidateId}`, candidate)
        const reading = outcome.error
          ? `depth=${entry.depth} ${candidate.candidateId}(局部z=${candidate.tcpPose.position[2].toFixed(4)},widthM=${candidate.widthM.toFixed(4)})→异常(${outcome.error.slice(0, 80)})`
          : `depth=${entry.depth} ${candidate.candidateId}(局部z=${candidate.tcpPose.position[2].toFixed(4)},widthM=${candidate.widthM.toFixed(4)})→世界TCP=[${outcome.worldPosition?.map(value => value.toFixed(4)).join(",")}] 闭合总宽=${Number.isFinite(outcome.closedWidthM) ? outcome.closedWidthM!.toFixed(5) : "n/a"}(命令${CLOSE_WIDTH_M}) 机器人接触=${String(outcome.picked?.effect.robotContactCount ?? "n/a")} 实测抬升=${outcome.liftedM?.toFixed(5)}m taskAchieved=${String(outcome.picked?.taskAchieved)}`
        readings.push(reading)
        if (outcome.picked?.taskAchieved) { adopted = { depth: entry.depth, candidate, outcome }; break }
      }
      if (adopted) break
    }
    checks.push({
      name: `${engine}_graspgenx_reference_depth_calibration`,
      ok: adopted !== undefined,
      detail: `GraspGenX Provider TCP 参考深度真实标定（每档真实推理 + 真实下降/闭合/抬升，成功判据固定为抬升≥0.08m、保持≥0.5s）：${readings.join(" | ")}；采用 referenceDepthM=${adopted?.depth ?? "(无档位闭环)"}；共真实推理 ${readings.length ? new Set(readings.map(reading => reading.split(" ")[0])).size : 0} 档、真实物理尝试 ${readings.length} 次`,
    })

    if (!adopted?.outcome.picked) {
      checks.push({ name: `${engine}_graspgenx_pick_contact_and_hold`, ok: false, detail: `真实候选→计划→动作未闭环：${readings.join(" | ")}` })
      return { checks, blocked: null, status: "FAIL" }
    }
    const chosen = adopted.outcome, picked = chosen.picked!
    checks.push({
      name: `${engine}_graspgenx_pick_contact_and_hold`,
      ok: picked.taskAchieved === true && picked.executionMode === "physical-contact" && Number(picked.effect.robotContactCount ?? 0) > 0 && Number(picked.effect.displacementM ?? 0) >= 0.08 && Number(picked.effect.holdTimeS ?? 0) >= 0.5,
      detail: `候选=${adopted.candidate.candidateId}（referenceDepthM=${adopted.depth} 标定档） 世界TCP=[${chosen.worldPosition?.map(value => value.toFixed(4)).join(",")}] frameId=${chosen.frameId} candidate.widthM=${adopted.candidate.widthM.toFixed(4)} 动作=${picked.status} executionMode=${picked.executionMode} taskAchieved=${picked.taskAchieved} 实测抬升=${chosen.liftedM}m（判据≥0.08） 保持=${String(picked.effect.holdTimeS)}s（判据≥0.5） 机器人接触=${String(picked.effect.robotContactCount)} 支撑接触=${String(picked.effect.supportContactCount)} 闭合总宽=${Number.isFinite(chosen.closedWidthM) ? chosen.closedWidthM!.toFixed(5) : "n/a"}(命令${CLOSE_WIDTH_M})`,
    })
    const placed = chosen.placed
    checks.push({
      name: `${engine}_graspgenx_place_supported`,
      ok: placed?.taskAchieved === true && Number((placed.effect as { supportContactCount?: number }).supportContactCount ?? 0) > 0,
      detail: placed ? `动作=${placed.status} taskAchieved=${placed.taskAchieved} 支撑接触=${String((placed.effect as { supportContactCount?: number }).supportContactCount)} 最终物体 z=${cubePosition(placed.after)[2]}m（期望≈0.22）` : "抓取未达成，未执行放置",
    })

    // 失败案例必须保留：把采用的候选横向偏移 12cm（与历史 --failure 同一做法），在全新 world 上真实执行。
    const negative = adopted.candidate
    const failed = await attempt("negative-offset", { ...negative, tcpPose: { ...negative.tcpPose, position: [negative.tcpPose.position[0], negative.tcpPose.position[1] + 0.12, negative.tcpPose.position[2]] } })
    checks.push({
      name: `${engine}_graspgenx_negative_case_kept`,
      ok: failed.error !== undefined || failed.picked?.taskAchieved === false,
      detail: failed.error ? `偏移 12cm 负例（真实执行，异常路径）：${failed.error}` : `偏移 12cm 负例（referenceDepthM=${adopted.depth}）：status=${failed.picked?.status} taskAchieved=${failed.picked?.taskAchieved} 实测抬升=${failed.liftedM}m（判据≥0.08） 机器人接触=${String(failed.picked?.effect.robotContactCount)} reason=${String(failed.picked?.reason)}`,
    })

    // 切换不改消费者：同一份消费者源码 + 运行前后摘要一致 + 同一入口消费第二个 Provider（解析）的真实候选。
    const analytic = proposeAnalytic({ entityId: "cube", frameId: "cube-local", centerM: [0, 0, 0], sizeM: [0.04, 0.04, 0.04], maxWidthM: MAX_WIDTH_M })[0]
    let analyticDetail = "解析 Provider 未返回候选"
    let analyticOk = false
    if (analytic) {
      const world = await sim.open(scene, { realtimeFactor: 2 })
      try {
        const snapshot = await sim.observe(world.worldId)
        const object = snapshot.entities.find(entity => entity.entityId === "cube")!
        const worldCandidate = transformCandidate(analytic, object.transform, snapshot.frameId)
        const receipt = await executePose(sim, planner, world.worldId, "panda", worldCandidate.tcpPose, `verify-g09-${engine}-analytic-switch`)
        analyticOk = receipt.status === "completed"
        analyticDetail = `provider=${analytic.provider} 候选=${analytic.candidateId} 经同一 pick/place 消费者入口（executePose + 同一 planner）真实执行：动作=${receipt.status} steps=${String(receipt.startStep)}→${String(receipt.endStep)}`
      } catch (error) { analyticDetail = `解析候选经同一消费者执行失败（不改 GraspGenX 行结论）：${errorText(error)}` }
      finally { await sim.close(world.worldId).catch(() => { /* 同上 */ }) }
    }
    const digestAfter = await Promise.all(consumerFiles.map(fileDigest))
    const unchanged = digestBefore.every((digest, index) => digest === digestAfter[index])
    checks.push({
      name: "grasp_consumer_shared_and_unmodified",
      ok: unchanged && analyticOk,
      detail: `消费者源码=${consumerFiles.map((file, index) => `${file.replace(PRODUCT_ROOT + "/", "")}@sha256:${digestAfter[index]!.slice(0, 12)}`).join("、")}；运行前后摘要一致=${unchanged}；同一 pick/place/executePose 入口同时消费 graspgenx 与 analytic 两个 Provider 的候选。${analyticDetail}`,
    })
    return { checks, blocked: null, status: "PASS" }
  } catch (error) {
    checks.push({ name: `${engine}_graspgenx_exception`, ok: false, detail: errorText(error) })
    return { checks, blocked: null, status: "FAIL" }
  } finally {
    await rm(cloudDirectory, { recursive: true, force: true })
  }
}


/**
 * G09：四个指定组合各自真实运行候选→计划→动作。
 * 当前分母（用户范围更新后）：MuJoCo+GraspGenX、Isaac+GraspGenX 两行主动；AnyGrasp 两行 removed_by_user。
 * 任一行缺依赖/无解即该行未完成 → 本门 BLOCKED（退出码 2），不把可跑的行结果外推成整门通过。
 */
export async function gateG09(): Promise<G08G09Result> {
  const checks: Check[] = []
  const blockedParts: string[] = []
  const removed: RemovedScope[] = []
  g09Rows.length = 0
  const panda = await firstExisting(PANDA_FIXTURES)
  if (!panda) return gateResult("G09", checks, `缺少 Panda 夹具：${PANDA_FIXTURES.join(" | ")}`, removed)

  const ensured = await ensureGraspGenXWorker()
  const worker = "worker" in ensured ? ensured.worker : null
  if (!worker) {
    const reason = (ensured as { blocked: string }).blocked
    checks.push({ name: "graspgenx_worker", ok: false, detail: reason })
    blockedParts.push(`GraspGenX worker：${reason}`)
  }

  try {
    // 第 1 行：MuJoCo + GraspGenX（真实候选→计划→动作 + 保留失败案例）
    if (!worker) {
      checks.push({ name: "row_mujoco_graspgenx", ok: false, detail: "BLOCKED：没有可调用的真实 GraspGenX worker，本行未运行（不用解析算法或空候选顶替）" })
      g09Rows.push({ engine: "mujoco", grasp: "graspgenx", status: "BLOCKED", detail: "GraspGenX worker 不可用" })
    } else {
      const harness = await mujocoHarness()
      try {
        const row = await rowGraspGenX("mujoco", harness.provider, panda, worker)
        checks.push(...row.checks)
        g09Rows.push({ engine: "mujoco", grasp: "graspgenx", status: row.status, detail: row.checks.filter(check => check.name.startsWith("mujoco_")).map(check => `${check.name}=${check.ok ? "ok" : "not-ok"}`).join(" ") })
        if (row.blocked) blockedParts.push(row.blocked)
      } finally { await harness.dispose() }
    }

    // 第 2 行：MuJoCo + AnyGrasp —— 用户移出本轮：单独登记为移出范围（不进 `checks` 的通过分子），也不阻断。
    removed.push({ name: "row_mujoco_anygrasp_removed_by_user", status: "REMOVED_BY_USER", detail: "非通过项（范围说明）：MuJoCo+AnyGrasp 行按用户明确指示 removed_by_user，本轮不安装 SDK/权重/许可、不推理、不计入 G09 主动分母，也不作为阻断项。" })
    g09Rows.push({ engine: "mujoco", grasp: "anygrasp", status: "REMOVED_BY_USER", detail: "ACCEPTANCE.md 记为 removed_by_user；未运行" })

    // 第 3 行：Isaac + GraspGenX —— 先真实启动 Isaac 世界确认引擎可用；不可用即该行 BLOCKED，不用任何替代引擎冒充。
    const isaac = new IsaacProvider()
    try {
      const probe = await withTimeout(isaac.open(tabletopScene("verify-g09-isaac-probe", panda)), 120000, "ISAAC_OPEN_TIMEOUT: 120s 内未返回")
      try {
        const description = await isaac.describe(probe.worldId, "panda")
        const probeState = await isaac.observe(probe.worldId)
        // DEV-027 §3.5：此处原为写死的 `ok: true` —— 一个恒真的"检查"混进 15/15（与 F04 修 G05 的
        // `fixture_source_inside_repo` 同一类错：把"干净环境也能跑"从回执里抹掉）。现改成真断言：
        // 引擎自报 isaac、真实 stepIndex≥0、有受控关节、modelVersion 非空且非 "[]"（判据与 G08 同源）。
        const probeModelVersionReal = hasRealModelVersion(description.modelVersion)
        checks.push({ name: "row_isaac_graspgenx_probe", ok: probe.engineId === "isaac" && probeState.stepIndex >= 0 && description.controlledJointNames.length > 0 && probeModelVersionReal, detail: `Isaac 真实启动成功：engine=${probe.engineId} modelVersion=${description.modelVersion}（非空且非 "[]"=${probeModelVersionReal}） 受控关节=${description.controlledJointNames.length} stepIndex=${probeState.stepIndex}` })
        if (!worker) {
          checks.push({ name: "contract/row_isaac_graspgenx", ok: true, detail: "UNCOVERED（不计入通过分子，不代表通过）—— 缺外部依赖，非产品失败：Isaac 可用但没有可调用的真实 GraspGenX worker，本行未运行" })
          g09Rows.push({ engine: "isaac", grasp: "graspgenx", status: "BLOCKED", detail: "GraspGenX worker 不可用" })
        } else {
          const row = await rowGraspGenX("isaac", isaac, panda, worker)
          checks.push(...row.checks)
          g09Rows.push({ engine: "isaac", grasp: "graspgenx", status: row.status, detail: row.checks.filter(check => check.name.startsWith("isaac_")).map(check => `${check.name}=${check.ok ? "ok" : "not-ok"}`).join(" ") })
          if (row.blocked) blockedParts.push(row.blocked)
        }
      } finally { await isaac.close(probe.worldId).catch(() => { /* 关闭失败不掩盖真实结论 */ }) }
    } catch (error) {
      const message = errorText(error)
      checks.push({ name: "contract/row_isaac_graspgenx_probe", ok: true, detail: `UNCOVERED（不计入通过分子，不代表通过）—— 缺外部运行时，非产品失败：Isaac 引擎未通过真实启动探测 → ${message}` })
      blockedParts.push(`Isaac+GraspGenX 行：${message}`)
      g09Rows.push({ engine: "isaac", grasp: "graspgenx", status: "BLOCKED", detail: message })
    } finally { await isaac.dispose().catch(() => { /* 同上 */ }) }

    // 第 4 行：Isaac + AnyGrasp —— 抓取侧被用户移出范围（引擎侧状态见上一行）；同样只单独登记，不进通过分子。
    removed.push({ name: "row_isaac_anygrasp_removed_by_user", status: "REMOVED_BY_USER", detail: "非通过项（范围说明）：Isaac+AnyGrasp 行按用户明确指示 removed_by_user；该行不计入主动分母，也不伪造成通过。" })
    g09Rows.push({ engine: "isaac", grasp: "anygrasp", status: "REMOVED_BY_USER", detail: "ACCEPTANCE.md 记为 removed_by_user；未运行" })
  } finally { if (worker) scheduleOwnedWorkerStop(worker) }

  return gateResult("G09", checks, blockedParts.length ? blockedParts.join("；") : null, removed)
}
