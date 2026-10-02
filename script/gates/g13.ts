/**
 * G13 的本机可验证切片。
 *
 * 合同 §6.2 G13 的通过条件里，本机（无供应商凭据 / 无 GPU / 不联网）能真实取读数的部分：
 *   1. 生成任务的**去重与恢复状态机**（对应"job 恢复不重复提交收费/运动"）——直接调
 *      `packages/generate-hunyuan/src/operations.ts` 的 `runGeneration`，读它真实落盘的
 *      JobRecord 文件与真实抛出的错误码，不用任何自建 provider/路由/骨架替代。
 *   2. **CLI/MCP 连接面**——真实 cordis Context + 上游原生 `ToolRuntime`/`CommandRuntime`
 *      装配 `@lyapunov/mcp-extras` 的真实 `apply`，读装配后的注册表（不是手写数组）。
 *   3. **记录导出可关联实际事件**（F13）——真实 `SimulationRecording` 写盘 → 真实
 *      `exportRecording` 导出 → 核对导出产物里的动作/事件/帧确实来自写盘的那次录制。
 *
 * 明确不做、且如实记为 BLOCKED 的部分见 `providerBlockedNote()`：真实远端生成重连/取消需要
 * 供应商凭据（腾讯混元 ai3d 的 API Key 或 TC3 密钥 + 中央 API 账户会话），本机没有。
 *
 * 本文件只做"调既有产品实现 → 取真实读数 → 判定"，不复制任何产品逻辑，不新建测试框架。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

import { runGeneration, type GenerationOptions, type JobRecord } from "../../packages/generate-hunyuan/src/operations.ts"
import { preflightGeneration, type CreateObjectRequest } from "../../packages/generate-hunyuan/src/provider.ts"
import { SimulationRecording } from "../../packages/robot-workflows/src/recording.ts"
import { exportRecording, recordingDirectory, writeRecordingManifest, type RecordingManifest } from "../../packages/robot-workflows/src/recording-files.ts"
import { recordingActions } from "../../packages/robot-workflows/src/recording-events.ts"
import type { ActionReceipt, Frame, SceneSnapshot, WorldHandle } from "../../packages/lyapunov-contracts/src/types.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const WORK_ROOT = join(ROOT, ".runtime/goal-verify/g13")
const GENERATION_DIR = join(WORK_ROOT, "generation-records")
const RECORDING_ROOT = join(WORK_ROOT, "recordings")

/** 判定用的字面量：全部来自被测源码，不在这里放宽。 */
const ALREADY_RUNNING = "GENERATION_ALREADY_RUNNING"
const REMOTE_LOST_CODE = "GENERATION_REMOTE_JOB_LOST"
const CANCELLED_LOCAL = "GENERATION_CANCELLED_LOCAL"
/** 本地取消路径真实抛出的文案（provider.ts `cancelledLocally`）：pre-abort 分支只有 message，没有 code 字段。 */
const CANCELLED_LOCAL_MESSAGE = "本地取消"
const SENTINEL_NO_NETWORK = "G13_SENTINEL_NO_NETWORK"

/** 无凭据时 preflight 的真实报错（provider.ts `requiredEnv`）。用来断言"确实缺凭据"，不把它当通过。 */
const MISSING_CREDENTIAL_TEXT = "is required for object generation"

/**
 * 只用于"去重路径"的占位 endpoint 配置。它让 `preflightGeneration` 的**纯配置校验**通过，
 * 从而走到记录文件排他创建那一步；任何真实 HTTP 都会打到 `*.invalid`（RFC 2606 保留，
 * 永不解析）并被本文件的哨兵 fetch 提前拦下。这**不替代供应商**：本文件不因此断言任何生成成功。
 * 轮询次数/间隔取测试值显式收敛（产品默认 180×5s），否则一次真实轮询会把门拖满。
 */
const PLACEHOLDER_ENV = {
  OBJECT_GENERATOR_API_KEY: "g13-local-dedup-placeholder-not-a-credential",
  OBJECT_GENERATOR_API_BASE_URL: "https://g13.invalid",
  OBJECT_GENERATOR_POLL_ATTEMPTS: "1",
  OBJECT_GENERATOR_POLL_INTERVAL_MS: "250",
} as const

interface CodedError extends Error { code?: string }

interface Outcome<T> { value?: T; error?: CodedError }

/** 读真实错误码/报文；不吞异常，也不把失败改写成成功。 */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === "string" ? code : ""
}

function textOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function outcomeOf<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try { return { value: await run() } } catch (error) { return { error: error instanceof Error ? error : new Error(String(error)) } }
}

function textInput(prompt: string): CreateObjectRequest {
  return { input: { mode: "text-to-3d", prompt, referenceImageUri: "" } }
}

/** 数据目录快照：文件名 → 文本内容（含 .tmp 残留，用于核对"没被第二次调用破坏"）。 */
async function snapshotDirectory(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const name of (await readdir(directory)).sort()) files.set(name, await readFile(join(directory, name), "utf8"))
  return files
}

async function readRecord(directory: string, requestId: string): Promise<JobRecord> {
  return JSON.parse(await readFile(join(directory, requestId + ".json"), "utf8")) as JobRecord
}

/** 供应商真实回执形状（`provider.ts` 的 `responseData`/`jobID`/`fileURL` 读的就是这些字段）。 */
function providerSubmitResponse(jobId: string): unknown {
  return { Response: { JobId: jobId, RequestId: "g13-fixture-request" } }
}

/** 供应商"作业不存在"业务错误（`REMOTE_JOB_LOST_PATTERN` 判定 `FailedOperation.JobNotFound`）。 */
function providerJobNotFoundResponse(): unknown {
  return { Response: { Error: { Code: "FailedOperation.JobNotFound", Message: "job not found" }, RequestId: "g13-fixture-request" } }
}

/** 供应商"作业已完成"回执：`isDone` 看 Status，`fileURL` 看 ResultFile3Ds[].Url。 */
function providerCompletedResponse(): unknown {
  return {
    Response: {
      Status: "DONE",
      ResultFile3Ds: [{ Type: "GLB", Url: "https://g13.invalid/object.glb" }],
      RequestId: "g13-fixture-request",
    },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

/** 记录 HTTP 尝试的哨兵：既用于"真实提交一次"的读数，也用于"绝不允许联网"的断言。 */
function recordingFetch(calls: string[], respond: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const requested = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(requested)
    return respond()
  }) as typeof fetch
}

function sentinelFetch(calls: string[]): typeof fetch {
  return recordingFetch(calls, () => { throw new Error(SENTINEL_NO_NETWORK) })
}

/**
 * 把进程内的 `globalThis.fetch` 换成本文件的读数/哨兵，结束后恢复。
 *
 * 为什么必须在全局这一层：`operations.ts` 只在**正式路由**存在时才把 `route.fetcher` 传给
 * `generateMesh`；开发模式路径下 `generateMesh` 用的是它自己的全局 `fetch`（provider.ts:504）。
 * 无凭据时本机建不出正式路由，所以 `options.fetcher` 对这条路径不生效。这里不做任何产品改动，
 * 只是把出口 HTTP 换成可读数的哨兵——被测状态机（记录文件、错误码、状态迁移）全部保持真实。
 */
async function withGlobalFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try { return await run() } finally { globalThis.fetch = original }
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) { previous.set(key, process.env[key]); process.env[key] = value }
  try { return await run() } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

/** 以真实调用取得"本机到底有没有供应商凭据"的读数，随后恢复现场，不改用户数据。 */
async function credentialBoundaryCheck(checks: Check[]): Promise<void> {
  const keys = Object.keys(PLACEHOLDER_ENV)
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete (process.env as Record<string, string | undefined>)[key]
  try {
    const outcome = await outcomeOf(() => runGeneration({ ...textInput("g13 credential boundary"), requestId: "g13-credential-boundary" },
      { dataDirectory: GENERATION_DIR, authorizeSubmission: async () => {} }))
    const text = textOf(outcome.error)
    const missing = outcome.error !== undefined && text.includes(MISSING_CREDENTIAL_TEXT)
    checks.push({
      name: "生成:无凭据时 runGeneration 如实报缺凭据",
      ok: missing,
      detail: `清空本文件注入的占位 endpoint 配置后真实报错原文: ${text || JSON.stringify(outcome.value)}`,
    })
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete (process.env as Record<string, string | undefined>)[key]; else process.env[key] = value }
  }
}

/**
 * 生成任务去重与恢复：读数全部来自真实的 `runGeneration`。
 *
 * 这里注入的只有两样东西，都不是"假 provider"：
 *   - `authorizeSubmission`：真实的收费提交授权回调（产品里是用户确认面）。被测行为是记录文件的
 *     排他创建，不在这里；不注入它，无凭据时根本走不到被测代码（preflight 会先报缺凭据）。
 *   - `fetcher`：把 HTTP 换成本文件的读数/哨兵，用来**证明**是否发生了提交；所有状态事实
 *     （记录文件内容、错误码、状态迁移）都是被测代码自己写盘/抛出的。
 */
/**
 * 生成任务去重与恢复：读数全部来自真实的 `runGeneration`。
 *
 * 这里注入/替换的只有三样东西，都不是"假 provider"，也不替代被测状态机：
 *   - `authorizeSubmission`：真实的收费提交授权回调（产品里是用户确认面）。被测行为是记录文件的
 *     排他创建，不在这里；不注入它，无凭据时根本走不到被测代码（preflight 会先报缺凭据）。
 *   - `globalThis.fetch`：见 `withGlobalFetch` 的说明——开发模式路径下 `generateMesh` 用全局 fetch，
 *     `options.fetcher` 对它不生效，所以在全局这一层做可读数/哨兵，且**只断言提交端点**。
 *   - 供应商应答体（JobId / FailedOperation.JobNotFound / 完成结果）按真实回执形状构造，
 *     用来驱动状态机分支；这不声称真实供应商调用过，只验证本机状态机的真实行为。
 * 所有状态事实（记录文件内容、错误码、状态迁移、HTTP 尝试序列）都是被测代码自己写盘/抛出的。
 */
async function generationChecks(checks: Check[]): Promise<void> {
  await rm(GENERATION_DIR, { recursive: true, force: true })
  await mkdir(GENERATION_DIR, { recursive: true })

  const authorizeNothing: NonNullable<GenerationOptions["authorizeSubmission"]> = async () => {}
  const baseOptions: GenerationOptions = { dataDirectory: GENERATION_DIR, authorizeSubmission: authorizeNothing }
  const submitOnly = (calls: string[]): string[] => calls.filter(url => url.includes("/submit"))

  // ---- 边界：无凭据时由 runGeneration 自己报缺什么（不是本文件的判断） ----
  await credentialBoundaryCheck(checks)

  {
    const outcome = await outcomeOf(() => runGeneration({ ...textInput("x"), requestId: "bad/../id" }, baseOptions))
    checks.push({
      name: "生成:requestId 是记录文件身份（非法值被拒）",
      ok: textOf(outcome.error).includes("INVALID_REQUEST_ID"),
      detail: outcome.error ? `真实报错原文: ${textOf(outcome.error)}` : "非法 requestId 未报错",
    })
  }

  // ---- 首次调用真实建立记录 + 真实落盘（preflight 是纯配置校验，不联网） ----
  const cellA = "g13-dedup-a"
  const abortedSignal = (() => { const controller = new AbortController(); controller.abort(); return controller.signal })()
  const callsA: string[] = []
  const first = await withGlobalFetch(sentinelFetch(callsA), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 dedup first"), requestId: cellA }, { ...baseOptions, signal: abortedSignal })))
  const recordABytes = await readFile(join(GENERATION_DIR, cellA + ".json"), "utf8").catch(() => undefined)
  const recordA = recordABytes === undefined ? undefined : JSON.parse(recordABytes) as JobRecord
  const firstRealError = textOf(first.error)
  const recordEstablished = recordABytes !== undefined
    && typeof recordA?.updatedAt === "string"
    && recordA?.mode === "developer"
    && recordA?.operationId === undefined
    && callsA.length === 1
    && submitOnly(callsA).length === 1
    && recordA?.status === "cancelled-local"
    && recordA?.cancellation?.submissionConfirmed === false
    && firstRealError.includes(CANCELLED_LOCAL_MESSAGE)
  checks.push({
    name: "生成:首次调用真实建立记录文件（落盘可核对）",
    ok: recordEstablished,
    detail: `落盘 ${cellA}.json (${recordABytes?.length ?? 0} 字节) status=${recordA?.status} mode=${recordA?.mode} ` +
      `operationId=${recordA?.operationId ?? "(无)"} 取消报告=${JSON.stringify(recordA?.cancellation ?? null)}；` +
      `真实 HTTP 尝试=${JSON.stringify(callsA)}；真实报错原文: ${firstRealError || "(无报错)"}`,
  })

  // ---- 去重语义：同 requestId 的第二次调用真实抛 GENERATION_ALREADY_RUNNING ----
  // 产品语义（operations.ts:137-141）：记录文件用 `writeFile(..., { flag: "wx" })` 排他创建，
  // 同一 requestId 已经"进行中"时，第二次进入的调用必然在写盘处拿到 EEXIST → 抛这个码。
  // 真实并发入口只有一个可挂起的 await 点：收费授权回调（operations.ts:110）。构造方式：
  //   1) 第一个调用停在授权回调（此时它还没写盘）；
  //   2) 第二个调用（allowPaidSubmission 跳过授权）真实完成排他创建 → 记录 `submitting`；
  //   3) 放行第一个调用：它的排他创建真实 EEXIST → GENERATION_ALREADY_RUNNING，先于任何 HTTP。
  const duplicate = `${cellA}-x`
  let releaseFirst: () => void = () => {}
  let authorizationCalls = 0
  const blockedAuthorize: NonNullable<GenerationOptions["authorizeSubmission"]> = () => {
    authorizationCalls += 1
    return new Promise<void>(release => { releaseFirst = release })
  }
  const callsFirst: string[] = []
  const firstRun = withGlobalFetch(sentinelFetch(callsFirst), () =>
    runGeneration({ ...textInput("g13 duplicate concurrent"), requestId: duplicate }, { ...baseOptions, authorizeSubmission: blockedAuthorize }))
  let spins = 0
  while (authorizationCalls === 0 && spins < 4000) { await new Promise<void>(resume => setTimeout(resume, 5)); spins += 1 }
  const duplicateBytesBeforeRace = await readFile(join(GENERATION_DIR, duplicate + ".json"), "utf8").catch(() => undefined)

  const callsSecond: string[] = []
  const secondDup = await withGlobalFetch(sentinelFetch(callsSecond), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 duplicate second"), requestId: duplicate }, { ...baseOptions, allowPaidSubmission: true })))
  const duplicateBytesAfterSecond = await readFile(join(GENERATION_DIR, duplicate + ".json"), "utf8").catch(() => undefined)

  releaseFirst()
  const firstOutcome = await outcomeOf(() => firstRun)
  const duplicateBytesAfterFirst = await readFile(join(GENERATION_DIR, duplicate + ".json"), "utf8").catch(() => undefined)
  const secondDupCode = codeOf(secondDup.error)
  const firstOutcomeCode = codeOf(firstOutcome.error)

  // 两个真实错误都没有单独 code 字段：EEXIST 分支抛 `GENERATION_ALREADY_RUNNING: …`（只有 message），
  // 胜出分支抛本文件的哨兵 message。按真实报文判定，不去猜错误码。
  const secondText = textOf(secondDup.error)
  const firstText = textOf(firstOutcome.error)
  const loserMessage = [secondText, firstText].find(text => text.includes(ALREADY_RUNNING)) ?? ""
  const winnerMessage = [secondText, firstText].find(text => text.includes(SENTINEL_NO_NETWORK)) ?? ""
  checks.push({
    name: "生成:同 requestId 进行中的第二次调用真实抛 GENERATION_ALREADY_RUNNING",
    ok: loserMessage.includes(ALREADY_RUNNING) && winnerMessage.includes(SENTINEL_NO_NETWORK),
    detail: `第一个调用停在授权回调（真实计数=${authorizationCalls}，写盘前记录=${duplicateBytesBeforeRace === undefined ? "(不存在)" : "(已存在)"}）；` +
      `被拒调用真实报错原文: ${loserMessage || "(无)"}；胜出调用真实报错原文: ${winnerMessage || "(无)"}`,
  })
  checks.push({
    name: "生成:被拒调用先于任何 HTTP，且首个记录未被改写",
    ok: callsFirst.length === 0
      && duplicateBytesBeforeRace === undefined
      && duplicateBytesAfterFirst !== undefined
      && callsSecond.filter(url => url.includes("/submit")).length === 1
      && ![...(await snapshotDirectory(GENERATION_DIR)).keys()].some(name => name.endsWith(".tmp")),
    detail: `被拒调用真实 HTTP 尝试=${JSON.stringify(callsFirst)}（应为 0：在写盘处即被拒）；` +
      `胜出调用真实 HTTP 尝试=${JSON.stringify(callsSecond)}（submit 恰好 1 次 = 只有一次收费提交）；` +
      `最终记录 status=${(duplicateBytesAfterFirst === undefined ? undefined : (JSON.parse(duplicateBytesAfterFirst) as JobRecord).status) ?? "(无)"}，` +
      `字节数=${duplicateBytesAfterFirst?.length ?? 0}`,
  })
  // ---- 恢复不重复提交：同一 requestId 二次调用沿持久 operationId 只查询、绝不 submit ----
  const cellB = "g13-resume-b"
  const jobB = "990000000000000002"
  const callsB1: string[] = []
  const firstB = await withGlobalFetch(sentinelFetch(callsB1), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 resume first"), requestId: cellB, resumeJobId: jobB },
      { ...baseOptions, signal: abortedSignal })))
  const recordB1Bytes = await readFile(join(GENERATION_DIR, cellB + ".json"), "utf8").catch(() => undefined)
  const recordB1 = recordB1Bytes === undefined ? undefined : JSON.parse(recordB1Bytes) as JobRecord
  checks.push({
    name: "生成:恢复调用建立带 operationId 的记录",
    ok: recordB1?.operationId === jobB && firstB.error !== undefined && submitOnly(callsB1).length === 0,
    detail: `记录 status=${recordB1?.status} operationId=${recordB1?.operationId ?? "(无)"}；` +
      `真实 HTTP 尝试=${JSON.stringify(callsB1)}（恢复路径不应有 submit）；真实报错原文: ${textOf(firstB.error) || "(无)"}`,
  })

  const callsB2: string[] = []
  const secondB = await withGlobalFetch(sentinelFetch(callsB2), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 resume second"), requestId: cellB }, baseOptions)))
  const recordB2 = await readRecord(GENERATION_DIR, cellB)
  const submitHits = submitOnly(callsB2)
  const queryHits = callsB2.filter(url => url.includes("/query"))
  const resumeOk = queryHits.length === 1
    && submitHits.length === 0
    && recordB2.operationId === jobB
    && recordB2.status !== "submitting"
    && secondB.error !== undefined
  checks.push({
    name: "生成:job 恢复不重复提交（第二次只查询、未走 submit）",
    ok: resumeOk,
    detail: `第二次真实 HTTP 尝试=${JSON.stringify(callsB2)}（submit 命中 ${submitHits.length} 次）；` +
      `记录 operationId=${recordB2.operationId ?? "(无)"}（沿用持久作业ID，与首次一致=${recordB2.operationId === recordB1?.operationId}）；` +
      `updatedAt 被本次调用刷新=${recordB2.updatedAt !== recordB1?.updatedAt}；真实报错原文: ${textOf(secondB.error) || "(无)"}`,
  })

  // ---- 真实落盘 → 冷重开 → 保存结果：唯一一次 submit 的应答 JobId 与持久记录一致，之后不再提交 ----
  const cellC = "g13-reopen-c"
  const submittedJobId = "990000000000000004"
  const meshURL = "https://g13.invalid/object.glb"
  const callsC1: string[] = []
  const openOutcome = await withGlobalFetch(recordingFetch(callsC1, () => jsonResponse(providerSubmitResponse(submittedJobId))),
    () => outcomeOf(() => runGeneration({ ...textInput("g13 reopen"), requestId: cellC }, baseOptions)))
  const persistedAfterOpen = await readRecord(GENERATION_DIR, cellC)
  const submitAfterOpen = submitOnly(callsC1).length
  const queryAfterOpen = callsC1.filter(url => url.includes("/query")).length
  const openOk = submitAfterOpen === 1
    && queryAfterOpen === 1
    && persistedAfterOpen.operationId === submittedJobId
    && persistedAfterOpen.status === "interrupted"
    && openOutcome.error !== undefined
  checks.push({
    name: "生成:首次调用走完 submit→query 并把供应商作业ID落盘",
    ok: openOk,
    detail: `真实 HTTP 尝试=${JSON.stringify(callsC1)}；持久记录 status=${persistedAfterOpen.status} operationId=${persistedAfterOpen.operationId ?? "(无)"}；` +
      `真实报错原文: ${textOf(openOutcome.error) || JSON.stringify(openOutcome.value)}`,
  })

  // 第二次调用仍然带着已落盘的 operationId：只查询，不重新提交；供应商这次回"已完成"。
  const callsC2: string[] = []
  const finishOutcome = await withGlobalFetch(recordingFetch(callsC2, () => jsonResponse(providerCompletedResponse())),
    () => outcomeOf(() => runGeneration({ ...textInput("g13 reopen"), requestId: cellC }, baseOptions)))
  const persistedAfterFinish = await readRecord(GENERATION_DIR, cellC)
  const finishOk = submitOnly(callsC2).length === 0
    && callsC2.filter(url => url.includes("/query")).length === 1
    && finishOutcome.value !== undefined
    && (finishOutcome.value as { meshURL?: string }).meshURL === meshURL
    && persistedAfterFinish.status === "completed"
    && persistedAfterFinish.operationId === submittedJobId
  checks.push({
    name: "生成:恢复只走 query 取回真实结果并落 completed（无重新提交）",
    ok: finishOk,
    detail: `真实 HTTP 尝试=${JSON.stringify(callsC2)}（submit 命中 ${submitOnly(callsC2).length} 次，应为 0）；` +
      `真实返回值=${JSON.stringify(finishOutcome.value)}；持久记录 status=${persistedAfterFinish.status} operationId=${persistedAfterFinish.operationId ?? "(无)"}；` +
      `真实报错原文: ${textOf(finishOutcome.error) || "(无报错)"}`,
  })

  const callsC3: string[] = []
  const coldOutcome = await withGlobalFetch(sentinelFetch(callsC3), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 reopen"), requestId: cellC }, baseOptions)))
  const persistedAfterCold = await readRecord(GENERATION_DIR, cellC)
  const coldReopenOk = callsC3.length === 0
    && persistedAfterCold.updatedAt === persistedAfterFinish.updatedAt
    && persistedAfterCold.status === "completed"
    && (coldOutcome.value as { meshURL?: string } | undefined)?.meshURL === meshURL
  checks.push({
    name: "生成:冷重开直接复用持久结果、0 次 HTTP（不重复提交收费任务）",
    ok: coldReopenOk,
    detail: `冷重开真实 HTTP 尝试=${JSON.stringify(callsC3)}（应为 0）；真实返回值=${JSON.stringify(coldOutcome.value)}；` +
      `记录 updatedAt 未变=${persistedAfterCold.updatedAt === persistedAfterFinish.updatedAt}；真实报错原文: ${textOf(coldOutcome.error) || "(无报错)"}`,
  })

  // ---- 终态 remote-lost：供应商确认"作业不存在" → 落终态、保留作业ID、重开不重查也不重提交 ----
  // 用一条**真实提交成功过**的记录（上面 cellC 已把 operationId 落盘）来驱动：把同一 requestId 的
  // 后续查询换成供应商的 JobNotFound 应答，走的是 runGeneration 自己的 remote-lost 分支
  // （记录已是 completed 时会先直接返回结果，所以这里换一个仍停在 interrupted 的 requestId）。
  const lostId = "g13-remote-lost-e"
  const callsLost0: string[] = []
  const lostSubmit = await withGlobalFetch(recordingFetch(callsLost0, () => jsonResponse(providerSubmitResponse(submittedJobId))),
    () => outcomeOf(() => runGeneration({ ...textInput("g13 remote lost"), requestId: lostId }, baseOptions)))
  const lostRecordSeeded = await readRecord(GENERATION_DIR, lostId)
  const callsLost1: string[] = []
  const lostOutcome = await withGlobalFetch(recordingFetch(callsLost1, () => jsonResponse(providerJobNotFoundResponse())),
    () => outcomeOf(() => runGeneration({ ...textInput("g13 remote lost"), requestId: lostId }, baseOptions)))
  const lostRecord = await readRecord(GENERATION_DIR, lostId)
  const lostBytes = await readFile(join(GENERATION_DIR, lostId + ".json"), "utf8")
  const callsLost2: string[] = []
  const lostReopen = await withGlobalFetch(sentinelFetch(callsLost2), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 reopen"), requestId: lostId }, baseOptions)))
  const lostBytesAfter = await readFile(join(GENERATION_DIR, lostId + ".json"), "utf8")
  const lostRecordAfter = JSON.parse(lostBytesAfter) as JobRecord
  const lostReopenCode = codeOf(lostReopen.error)
  checks.push({
    name: "生成:remote-lost 落终态且保留供应商作业ID",
    ok: lostRecord.status === "remote-lost" && lostRecord.operationId === submittedJobId && lostOutcome.error !== undefined
      && submitOnly(callsLost1).length === 0 && callsLost1.filter(url => url.includes("/query")).length === 1,
    detail: `提交记录 status=${lostRecordSeeded.status} operationId=${lostRecordSeeded.operationId ?? "(无)"}；` +
      `确认丢失那次 HTTP 尝试=${JSON.stringify(callsLost1)}（submit 命中 ${submitOnly(callsLost1).length} 次，应为 0：只重新查询既有作业）；` +
      `记录 status=${lostRecord.status} operationId=${lostRecord.operationId ?? "(无)"}；` +
      `真实报错原文: ${textOf(lostOutcome.error).slice(0, 300) || "(无报错)"}`,
  })
  checks.push({
    name: "生成:remote-lost 重开不重查远端（真实错误码 + 0 次 HTTP）",
    ok: lostReopenCode === REMOTE_LOST_CODE && callsLost2.length === 0 && lostBytes === lostBytesAfter
      && lostRecordAfter.status === "remote-lost" && lostRecordAfter.operationId === submittedJobId,
    detail: `重开真实错误码=${lostReopenCode || "(无)"}；重开 HTTP 尝试=${callsLost2.length} 次；` +
      `记录逐字节不变=${lostBytes === lostBytesAfter}（operationId=${lostRecordAfter.operationId ?? "(无)"}）；` +
      `真实报错原文: ${textOf(lostReopen.error).slice(0, 300) || "(无报错)"}`,
  })

  // ---- 结果缺失边界：本地 completed 但无 result 且无可恢复作业ID → 明确拒绝，不重新提交 ----
  const missingId = "g13-result-missing-f"
  await writeFile(join(GENERATION_DIR, missingId + ".json"), JSON.stringify({
    status: "completed", mode: "developer", updatedAt: new Date().toISOString(),
  } satisfies JobRecord), { mode: 0o600 })
  const callsMissing: string[] = []
  const missingOutcome = await withGlobalFetch(sentinelFetch(callsMissing), () => outcomeOf(() =>
    runGeneration({ ...textInput("g13 result missing"), requestId: missingId }, baseOptions)))
  const missingText = textOf(missingOutcome.error)
  checks.push({
    name: "生成:completed 缺结果时拒绝重新提交收费任务",
    ok: missingText.includes("GENERATION_RESULT_MISSING") && callsMissing.length === 0,
    detail: `真实报错原文: ${missingText.slice(0, 300) || "(无报错)"}；HTTP 尝试=${callsMissing.length} 次（应为 0）`,
  })
}

/** 真实插件装配读数：cordis Context + 上游原生 ToolRuntime/CommandRuntime + 产品插件自己的 apply。 */
async function mcpAssemblyChecks(checks: Check[]): Promise<void> {
  try {
    const { Context } = await import("@deepseek-ai/cordis")
    const { default: SystemPrompt } = await import("@deepseek-ai/dsh-system-prompt")
    const { default: ToolRuntime } = await import("@deepseek-ai/dsh-tools")
    const { default: CommandRuntime } = await import("@deepseek-ai/dsh-commands")
    const extras = await import("../../packages/lyapunov-mcp-extras/src/plugin.ts")

    const ctx = new Context()
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new ToolRuntime(ctx)
    new CommandRuntime(ctx)
    extras.apply(ctx)

    const schemas = ctx.tools.schemas()
    const names = schemas.map(schema => schema.name).sort()
    const expected = [
      "get_mcp_prompt", "list_mcp_prompts", "list_mcp_resource_templates", "list_mcp_resources",
      "list_mcp_servers", "mcp_auth_status", "mcp_login", "mcp_logout", "mcp_refresh_auth", "read_mcp_resource",
    ]
    const missing = expected.filter(name => !names.includes(name))
    const extra = names.filter(name => !expected.includes(name))
    const resolvable = expected.every(name => ctx.tools.get(name)?.name === name)
    const described = schemas.every(schema => typeof schema.description === "string" && schema.description.length > 0)
    checks.push({
      name: "MCP:6 个 MCP 读取 Tool + 4 个 OAuth Tool 来自真实装配",
      ok: extra.length === 0 && missing.length === 0 && resolvable && described,
      detail: `真实注册表读数=${JSON.stringify(names)}；缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)}；` +
        `逐个 ctx.tools.get 可解析=${resolvable}；未知名 get 返回=${String(ctx.tools.get("g13_not_a_tool"))}；` +
        `插件声明 inject=${JSON.stringify(extras.inject)}`,
    })
  } catch (error) {
    checks.push({
      name: "MCP:6 个 MCP 读取 Tool + 4 个 OAuth Tool 来自真实装配",
      ok: false,
      detail: `真实装配报错原文: ${textOf(error)}`,
    })
  }
}

/** 记录导出（F13）：真实录制写盘 → 真实导出 → 核对导出里的动作/事件/帧确实来自那次录制。 */
async function recordingExportChecks(checks: Check[]): Promise<void> {
  try {
    await rm(RECORDING_ROOT, { recursive: true, force: true })
    await mkdir(RECORDING_ROOT, { recursive: true })
    const recordingId = "recording-g13-export"
    const directory = recordingDirectory(RECORDING_ROOT, recordingId)
    await mkdir(directory, { recursive: true, mode: 0o700 })

    const world: WorldHandle = {
      worldId: "world-g13", sceneId: "scene-g13", engineId: "g13-fixture-engine", engineVersion: "0",
      worldGeneration: 1, appliedSceneRevision: 7, clock: "manual", timestepS: 0.002, status: "ready",
    }
    const scene: SceneSnapshot = {
      sceneId: "scene-g13", revision: 7,
      coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
      entities: [],
    }
    const frame = (stepIndex: number): Frame => ({
      worldId: world.worldId, generation: world.worldGeneration, stepIndex, simTime: stepIndex * 0.002,
      sceneRevision: world.appliedSceneRevision, frameId: `frame-${stepIndex}`,
      entities: [{
        entityId: "box", transform: { position: [stepIndex * 0.001, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      }],
    })

    // 真实帧序列：故意插回一帧旧 stepIndex，交给真实订阅过滤判断（过期帧必须被丢弃）。
    const arrival = [frame(0), frame(1), frame(1), frame(0), frame(2)]
    let listener: ((frame: Frame) => void) | undefined
    const sim = {
      observe: async () => frame(0),
      subscribeFrames: (_worldId: string, next: (frame: Frame) => void) => { listener = next; return () => { listener = undefined } },
    }
    const recorder = new SimulationRecording(directory, "session-g13")
    await recorder.start(sim as never, world.worldId)
    const receipt: ActionReceipt = {
      actionId: "action-g13", worldId: world.worldId, generation: world.worldGeneration,
      status: "completed", startStep: 0, endStep: 2, taskAchieved: true,
    }
    recorder.action(receipt, { kind: "tool", id: "call-g13" })
    for (const arrived of arrival.slice(1)) listener?.(arrived)
    const summary = await recorder.stop()

    const manifest: RecordingManifest = {
      recordingId, sessionRef: "session-g13", sceneId: "scene-g13", status: "completed",
      createdAt: new Date().toISOString(), runId: "run-g13", maxDurationS: 10,
      frameCount: summary.frameCount, eventCount: 0,
      lastFrame: { frameId: summary.lastFrameId ?? "", generation: world.worldGeneration, sceneRevision: world.appliedSceneRevision, stepIndex: 2, simTime: 0.004 },
      segments: [{ generation: world.worldGeneration, world, sceneFile: "scene.json", sourceSceneFile: "source.json" }],
      resources: [], missing: [],
    }
    await writeFile(join(directory, "scene.json"), JSON.stringify(scene, null, 2), { mode: 0o600 })
    await writeFile(join(directory, "source.json"), JSON.stringify(scene, null, 2), { mode: 0o600 })
    const eventLines = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean)
    manifest.eventCount = eventLines.length
    await writeRecordingManifest(RECORDING_ROOT, manifest)

    const events = eventLines.map(line => JSON.parse(line))
    const recordedFrameIds = events.filter(event => event.kind === "frame" || event.kind === "start").map(event => event.frame?.frameId as string)
    const exported = await exportRecording(RECORDING_ROOT, recordingId)
    const dataset = JSON.parse(await readFile(exported.manifestPath, "utf8")) as Record<string, any>
    const trajectory = (await readFile(join(exported.directory, "trajectory.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    const trajectoryIds = trajectory.map(row => row.frameId as string)
    const actionLinks = dataset.actions as Array<{ actionId: string; source?: { id?: string; callId?: string } }>
    const recordedActions = recordingActions(events)

    const framesOk = summary.frameCount === 3 && dataset.frames === 3 && dataset.manifestFrameCount === 3
    const trajectoryOk = trajectoryIds.length === 3 && trajectoryIds.every(id => recordedFrameIds.includes(id))
    const actionOk = recordedActions.length === 1
      && recordedActions[0].receipt.actionId === receipt.actionId
      && recordedActions[0].receipt.taskAchieved === true
      && actionLinks.some(action => action.actionId === receipt.actionId && action.source?.id === "call-g13")
    const artifactsOk = (await stat(join(exported.directory, "events.jsonl"))).isFile()
      && (await stat(join(exported.directory, "recording.json"))).isFile()
      && (await stat(join(exported.directory, "dataset.json"))).isFile()
      && (await stat(join(exported.directory, "trajectory.jsonl"))).isFile()
    const staleFrameDropped = recordedFrameIds.length === 3 && new Set(recordedFrameIds).size === 3 && summary.frameCount < arrival.length
    checks.push({
      name: "记录导出:导出产物可关联实际事件（帧/动作同一来源）",
      ok: framesOk && trajectoryOk && actionOk && artifactsOk && staleFrameDropped,
      detail: `真实录制帧数=${summary.frameCount}/到达帧=${arrival.length}（过期重复帧被丢弃=${staleFrameDropped}）；` +
        `导出目录=${exported.directory}；dataset.frames=${dataset.frames} trajectory=${trajectoryIds.length} 帧集合一致=${trajectoryOk}；` +
        `动作关联=${actionOk}（actionId=${receipt.actionId} source=${JSON.stringify(actionLinks[0]?.source ?? null)} taskAchieved=${String(recordedActions[0]?.receipt.taskAchieved)}）；` +
        `导出状态=${exported.status} missing=${JSON.stringify(exported.missing)}`,
    })
  } catch (error) {
    checks.push({
      name: "记录导出:导出产物可关联实际事件（帧/动作同一来源）",
      ok: false,
      detail: `真实导出报错原文: ${textOf(error)}`,
    })
  }
}

/**
 * 真实远端生成重连/取消：本机无供应商凭据，如实 BLOCKED。
 * 只报告"确实没有什么"的真实读数，不联网、不打印任何密钥内容。
 */
function providerBlockedNote(): string {
  const credentialKeys = ["OBJECT_GENERATOR_API_KEY", "HUNYUAN_3D_API_KEY", "OBJECT_GENERATOR_SECRET_ID", "OBJECT_GENERATOR_SECRET_KEY"]
  const present = credentialKeys.filter(key => (process.env[key] ?? "").trim().length > 0)
  const accountSession = ["LYAPUNOV_API_URL", "LYAPUNOV_ACCOUNT_TOKEN"].filter(key => (process.env[key] ?? "").trim().length > 0)
  return `BLOCKED（合同 §6.2 G13 的其余通过条件）：本机没有混元供应商凭据（已检查 ${credentialKeys.join("/")}，present=${present.length ? present.join(",") : "无"}），` +
    `也没有正式账户会话（${accountSession.join("/") || "LYAPUNOV_API_URL/LYAPUNOV_ACCOUNT_TOKEN"} 均未设置），` +
    `因此**真实远端生成的重连/取消**无法执行：无凭据时 runGeneration 的真实报错是 "GENERATION_BLOCKED: OBJECT_GENERATOR_API_KEY is required for object generation"（provider.ts requiredEnv）。` +
    `同样未覆盖、需真实引擎/账号/外部服务的 G13 条件：F12 Fleet/导航/传感器（sim 引擎）、ACP 真实客户端会话（本门只覆盖 MCP+commands 的真实装配面）、` +
    `多 workspace 与 F15 Session 分享（外部服务）、F08 真实供应商分割/生成（凭据）；benchmark（libero/gymnasium）SDK 不在本机。` +
    `F04（文件树/编辑/Review/搜索/终端/Git/Worktree）在本门**零 check** —— 不是"跑了没通过"：本文件里这七类关键词 grep 0 命中，` +
    `合同 §6.2 G13 行要求的这份行为证据目前不由 G13 承担；这里只如实点名，不补静态断言充数。` +
    `以上全过程未联网、未发起任何收费请求、未读取或打印任何密钥内容。`
}

export async function gateG13(): Promise<GateResult> {
  const checks: Check[] = []
  await mkdir(WORK_ROOT, { recursive: true })

  await withEnv({ ...PLACEHOLDER_ENV }, async () => {
    await generationChecks(checks)
  })
  await mcpAssemblyChecks(checks)
  await recordingExportChecks(checks)

  return { gate: "G13", checks, blocked: providerBlockedNote() }
}
