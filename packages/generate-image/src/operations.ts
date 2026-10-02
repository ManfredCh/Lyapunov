/**
 * 图像生成的**本地作业记录**（与 generate-tripo / hunyuan / marble 同一套状态词表）：
 * 每个 requestId 一份 JSON，记录远端 task_id、状态、结果与取消报告，落盘在插件的 dataDirectory。
 * 它存在的唯一理由是"重启/重试时不要第二次提交收费任务"——不是第二套任务系统：
 * 后台作业身份仍走原生 `ctx.jobs`，远端任务身份就是百炼的 task_id。
 *
 * 两条路由（与 tripo 同形，同一份共享客户端）：
 * - **formal**：`formalGenerationRoute` 拿到中央账户 fetcher + 真实报价；密钥只在服务端，
 *   本机不需要供应商 key；恢复时先 `lookup()` 读服务端终态，有 operationId 就只查询、不重新提交。
 * - **developer**：直连百炼，用本地配置的 `IMAGE_API_KEY` / `IMAGE_BASE_URL`。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { formalGenerationRoute, type GenerationRoutingOptions } from "@lyapunov/api-client/generation"
import type { GenerationAuthorizer } from "@lyapunov/api-client/generation-approval"
import { createJobRecordPersister, writeFileAtomic0600 } from "../../generate-hunyuan/src/job-record.ts"
import {
  generateImages,
  preflightImageGeneration,
  REMOTE_JOB_LOST_CODE,
  taskFromServerResponse,
  type CancellationReport,
  type GenerateImageRequest,
  type ImageTaskOptions,
  type ImageTaskResult,
  type PreparedImageRequest,
  type ReferenceImageReport,
} from "./provider.ts"

export type { CancellationReport }
export { REMOTE_JOB_LOST_CODE }
export type { GenerationAuthorizer }

/**
 * 作业状态：submitting/resuming/running 进行中；completed 终态（本地已落盘的图仍可用）；
 * cancelled-local 本地取消（远端可能仍在跑）；interrupted 可重试中断（网络/查询临时失败）；
 * remote-lost 供应商明确任务不存在（task_status UNKNOWN）的自动恢复终态——保留 task_id，
 * 冷重开不再自动重查远端，也不会重新提交收费任务。
 */
export interface JobRecord {
  operationId?: string
  status: string
  result?: unknown
  updatedAt: string
  error?: string
  mode: "formal" | "developer"
  /** 正式路由绑定的中央账户与入口；换账户/换入口时同一份记录会被拒绝（不把别人的任务当自己的）。 */
  accountId?: string
  apiUrl?: string
  /**
   * **本次实际生效**的模型：正式路由是服务端提交快照，开发直连是本地配置。
   * 恢复时读它，不用当前配置顶替；字段缺失 = 明确未知（v9 前的历史记录/中央库里的 model 为 NULL）。
   */
  model?: string
  /** 服务端请求行 id（正式路由）。 */
  serverRequestId?: string
  /**
   * 请求输入指纹（提示词/参考图引用/参数）。同一个 requestId 换了实际请求必须显式冲突，
   * 否则会把上一次的图当成这一次的结果返回。
   */
  requestFingerprint?: string
  cancellation?: CancellationReport | null
}

/** 已落盘的生成图：官方链接 24 小时有效，所以本地文件才是产品里长期可用的那一份。 */
export interface GeneratedImageFile {
  path: string
  url: string
  mediaType: string
  bytes: number
}

export type ImageGenerationResult = {
  requestId: string
  /**
   * 本次实际生效的模型。正式路由下是服务端快照；恢复没有模型信息的历史记录时**缺省**
   * （不拿当前配置冒充）。
   */
  model?: string
  taskId?: string
  requestIds: { submit?: string; query?: string }
  usage?: Record<string, unknown>
  images: GeneratedImageFile[]
  referenceImages: ReferenceImageReport[]
  /** 提交请求体（含 Base64 参考图时也在其中；不含任何凭据）。服务端回放恢复时为空。 */
  request: Record<string, unknown>
  /** 结果来自服务端持久化应答的回放（本次没有提交、没有查询供应商，也没有读本地参考图）。 */
  restoredFromServer?: true
}

/** `prepareOnly` 的返回值：*不是*生成结果，只是"提交前检查已通过"。 */
export type PreparedOnly = { prepared: true; requestId: string; recovering: boolean }
export type ImageRunResult = ImageGenerationResult | PreparedOnly
export function isPreparedOnly(value: ImageRunResult): value is PreparedOnly {
  return (value as PreparedOnly).prepared === true
}

export interface GenerationOptions extends GenerationRoutingOptions {
  /** 本插件的产物目录（落盘记录 + 生成图）。 */
  dataDirectory: string
  /** 显式放行收费提交（测试/已授权的本机脚本用）；默认 false 时必须走 authorizeSubmission。 */
  allowPaidSubmission?: boolean
  /** 原生收费授权（plugin 传共享 `generationAuthorizer`）。 */
  authorizeSubmission?: GenerationAuthorizer
  /** 只做提交前检查（解析参考图、校验参数、发起报价与授权问答），不提交。 */
  prepareOnly?: boolean
  /** 开发直连的可信配置；模型 JSON 传不进来（plugin 显式拒绝 apiKey/baseURL/endpoint/model）。 */
  apiKey?: string
  baseURL?: string
  model?: string
  fetch?: typeof fetch
  /** 结果图下载用的 fetcher（默认全局 fetch：结果在供应商 CDN，不走账户会话）。 */
  downloadFetch?: typeof fetch
  pollIntervalMs?: number
  pollAttempts?: number
}

function remoteJobLostError(message: string, cause?: unknown) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  ;(error as { code?: string }).code = REMOTE_JOB_LOST_CODE
  return error
}

/** 供应商明确"任务不存在"时的产品级说明：保留任务 ID 与动作含义，隐去 request_id 等排查细节。 */
function remoteJobLostMessage(input: { operationId?: string; detail: string; reopened: boolean }) {
  const job = input.operationId ? `远端任务 ${input.operationId}` : "远端任务（任务ID未记录）"
  const withoutCode = input.detail.startsWith(REMOTE_JOB_LOST_CODE + ": ")
    ? input.detail.slice(REMOTE_JOB_LOST_CODE.length + 2)
    : input.detail
  const detail = withoutCode.replace(/[\s　]*[(（]request_id[:：][^)）]*[)）]\s*$/i, "")
  return input.reopened
    ? `GENERATION_REMOTE_JOB_LOST: 记录已是终态 remote-lost（${job} 已被供应商确认为不存在）；本次未重新查询供应商、未提交新任务。本地已落盘的生成图不受影响；如需再次生成，请按正常流程发起新的生成请求。原记录：${detail}`
    : `GENERATION_REMOTE_JOB_LOST: ${job} 已被供应商确认为不存在；本产品据此把自动恢复记为终态 remote-lost——不再自动重查远端，也不会在没有新的用户确认时重新提交收费任务。本地已落盘的生成图不受影响。供应商信息：${detail}`
}

function extensionFor(mediaType: string) {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/webp") return "webp"
  if (mediaType === "image/gif") return "gif"
  return "png"
}

/** 与共享 `generation-approval` 同一套指纹口径（canonical JSON + sha256），便于两层对得上。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && typeof item !== "function")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

/**
 * 请求输入身份：提示词 + 参考图引用 + 生成参数。
 *
 * 只覆盖**输入本身**（不含 resumeTaskId、不含供应商凭据/入口，也不读参考图文件内容）：
 * 恢复一条已有任务时输入可能已经不可读（参考图被删掉），指纹必须还能算出来并逐字一致，
 * 否则"纯恢复"会变成"要求原文件还在"。
 */
function requestFingerprint(input: GenerateImageRequest) {
  const { prompt, referenceImages, size, n, negativePrompt, seed, promptExtend, watermark } = input?.input ?? {}
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          prompt,
          referenceImages: referenceImages ?? [],
          size: size ?? null,
          n: n ?? null,
          negativePrompt: negativePrompt ?? null,
          seed: seed ?? null,
          promptExtend: promptExtend ?? null,
          watermark: watermark ?? null,
        }),
      ),
    )
    .digest("hex")
}

/**
 * 本次调用到底有没有给出"新请求的输入"。两种意图必须区分开：
 * - **新提交有输入**：给了 input 里的任何一个字段 → 必须与这个 requestId 原有的请求核对身份；
 * - **只恢复原请求**：只给 requestId（不给 input）→ 直接取回该 requestId 原来的结果，
 *   不要求用户再回旧提示词，也不要求原参考图文件还在。
 */
function hasRequestInput(input: GenerateImageRequest) {
  const value = input?.input
  if (!value || typeof value !== "object") return false
  return Object.values(value).some((item) => item !== undefined)
}

/**
 * 请求**体**指纹（注意与上面的输入指纹不同）：与中央 `generation-gateway` 的 `fingerprint()` 同一口径——
 * `sha256(canonical(JSON.parse(rawBody)))`，rawBody 就是 `JSON.stringify(payload)`。服务端在提交时把它
 * 连同请求行一起保存，lookup 时回给客户端；冷重开没有本地记录时，这是唯一能证明"这次输入=那条请求"
 * 的证据（链路上有真实处理器的一致性测试，见 chain/image-formal-chain.test.ts）。
 */
function payloadFingerprint(payload: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(payload)))))
    .digest("hex")
}

/**
 * 同一个 requestId 被另一次不同输入的请求占用。`where` 说明是哪一边的证据对不上
 * （本地记录 / 中央服务保存的请求），两种情况都给出同一条出路：只给 requestId 做纯恢复。
 */
function requestIdConflict(where: string, record?: JobRecord) {
  return new Error(
    "GENERATION_REQUEST_ID_CONFLICT: 这个 requestId 已经用于另一次不同的图像请求（提示词/参考图/生成参数不同），" +
      `${where}的输入对不上；请为新的请求换一个 requestId——同一次身份不会返回上一次的图。` +
      "如果只是想取回该 requestId 原来生成的结果，请只给 requestId（不要带 input）再调用一次。" +
      (record ? ` 原记录：${record.status}${record.model ? ` / 模型 ${record.model}` : ""}` : ""),
  )
}

/** 带了新输入却无法核对身份：宁可拒绝，也不把上一次的结果当成这一次的返回。 */
function inputUnverified(reason: string) {
  return new Error(
    `GENERATION_INPUT_UNVERIFIED: 这次带了新输入，但无法确认它与该 requestId 原有请求是同一次（${reason}）；` +
      "为避免把上一次的结果当成这一次的，本次既不提交也不回放。只想取回该 requestId 原来生成的结果时，请只给 requestId（不要带 input）再调用一次。",
  )
}

/**
 * 给原生授权弹窗的请求对象 = 真正要提交的请求体（指纹绑定的就是它），外加一个顶层 `prompt`。
 * 共享 `generation-approval` 的渲染只认顶层 `prompt`；图像请求体的提示词在
 * `input.messages[].content[].text`，不投影的话用户在弹窗里只看得到模型和报价、看不到这次要生成什么。
 * 参考图只报张数（见共享渲染），Base64 内容不会逐字回显。
 */
function approvalRequest(prepared: PreparedImageRequest, prompt: string) {
  return { ...prepared.request, prompt }
}

/** 生成图落盘：官方 URL 24 小时失效，产品里长期可用的是这份本地文件。 */
async function persistImages(dataDirectory: string, requestId: string, task: { images: ImageTaskResult["images"] }) {
  const directory = join(dataDirectory, requestId)
  await mkdir(directory, { recursive: true })
  const files: GeneratedImageFile[] = []
  for (const [index, image] of task.images.entries()) {
    const path = join(directory, `${requestId}-${index + 1}.${extensionFor(image.mediaType)}`)
    // 落盘同样走本族唯一一处"临时文件 + rename + 0600"（与作业记录同规则，只是内容是图像字节）。
    await writeFileAtomic0600(path, image.data)
    files.push({ path, url: image.url, mediaType: image.mediaType, bytes: image.bytes })
  }
  return files
}

/** 提交/查询通道：正式路由用中央账户 fetcher（本机没有供应商 key），开发直连用本地配置。 */
function channelOptions(
  options: GenerationOptions,
  route: Awaited<ReturnType<typeof formalGenerationRoute>>,
): ImageTaskOptions {
  const shared: ImageTaskOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.pollAttempts !== undefined ? { pollAttempts: options.pollAttempts } : {}),
    ...(options.downloadFetch !== undefined ? { downloadFetch: options.downloadFetch } : {}),
  }
  if (route)
    return { ...shared, mode: "formal", apiKey: route.token, baseURL: route.providerBaseUrl, fetch: route.fetcher }
  return {
    ...shared,
    mode: "developer",
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  }
}

export async function runImageGeneration(
  input: GenerateImageRequest & { requestId: string; resumeTaskId?: string },
  options: GenerationOptions,
): Promise<ImageRunResult> {
  // requestId 是记录文件身份：隐式字符串化会让不同请求塌缩到同一份记录。
  if (typeof input.requestId !== "string" || !/^[\w-]+$/.test(input.requestId)) throw new Error("INVALID_REQUEST_ID")
  if (!options.dataDirectory) throw new Error("PROVIDER_UNAVAILABLE: 缺少当前账号的 dataDirectory")
  const route = await formalGenerationRoute(options, "image", input.requestId)
  await mkdir(options.dataDirectory, { recursive: true })
  const file = join(options.dataDirectory, input.requestId + ".json")
  let record: JobRecord | undefined
  try {
    record = JSON.parse(await readFile(file, "utf8")) as JobRecord
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
  }
  if (route && record && (record.mode !== "formal" || record.accountId !== route.accountId || record.apiUrl !== route.apiUrl))
    throw new Error("GENERATION_ACCOUNT_MISMATCH: 该记录未绑定当前正式账户和中央API")
  if (!route && record?.mode === "formal")
    throw new Error("GENERATION_MODE_MISMATCH: 开发模式不能读取正式生成记录")
  // 输入身份先于"已完成"判定：同一个 requestId 换了提示词/参考图/参数时**必须显式冲突**，
  // 否则会把上一次的图当成这一次的结果悄悄返回。纯恢复（只给 requestId，不给 input）不在此列。
  const hasInput = hasRequestInput(input)
  // 身份合同：指纹只由"这次真的带了输入"的调用产生，纯恢复（只给 requestId）保留记录里已有的身份；
  // 记录里本来就没有（老记录/只给 resumeTaskId）就保持未知——不写、不猜。
  const fingerprint = hasInput ? requestFingerprint(input) : record?.requestFingerprint
  if (hasInput && record?.requestFingerprint && record.requestFingerprint !== fingerprint)
    throw requestIdConflict("这份本地记录", record)
  // 记录在、身份却**未知**（更早版本写的记录，或建立记录时只给了 resumeTaskId、没有输入可算指纹）：
  // 带 input 时不拿这份记录的结果回放——它证不了"这次输入=原来那次"。只给 requestId 的纯恢复不受影响。
  if (hasInput && record && !record.requestFingerprint) throw inputUnverified("这份本地记录没有保存原请求的输入指纹")
  // 已完成且结果还在：直接返回本地结果，不重新提交、也不重新查询。
  if (record?.status === "completed" && record.result !== undefined) return record.result as ImageGenerationResult
  if (record?.status === "remote-lost")
    throw remoteJobLostError(
      remoteJobLostMessage({ operationId: record.operationId, detail: record.error ?? "（记录未保存供应商错误）", reopened: true }),
    )
  // 正式路由：先读服务端这一行的终态与远端 task_id（只读，不会触发供应商请求，也不会二次收费）。
  const recovered = await route?.lookup()
  // 服务端提交时保存的请求体指纹，是**本地没有记录**时（冷重开/换机器/换 dataDirectory）唯一的身份来源：
  // 上面那条本地判据在那种情况下没有机会比对。带了 input 就是"新请求"意图，必须与那一行核对，核对不了就拒绝。
  if (hasInput && recovered) {
    let identity: PreparedImageRequest
    try {
      identity = await preflightImageGeneration(input, channelOptions(options, route))
    } catch (error) {
      throw inputUnverified(error instanceof Error ? error.message : String(error))
    }
    const stored = recovered.requestFingerprint
    if (typeof stored !== "string" || !/^[a-f0-9]{64}$/.test(stored))
      throw inputUnverified("中央服务那条记录没有保存请求指纹，无法据此核对")
    if (stored !== payloadFingerprint(identity.request)) throw requestIdConflict("中央服务上这条请求")
  }
  if (recovered?.status === "failed")
    throw new Error("GENERATION_FAILED: " + (recovered.error ?? "中央服务已把这次请求记为失败"))
  let operationId = recovered?.operationId ?? record?.operationId ?? input.resumeTaskId
  if (recovered && !operationId && recovered.status !== "succeeded")
    throw new Error("SUBMISSION_UNCERTAIN: " + recovered.status + " " + (recovered.error ?? ""))
  // 服务端已判成成功的终态回放不需要远端 ID（直接取那份持久化应答）；其余情况没有可恢复的 task_id
  // 一律禁止重新提交——那会变成第二次收费。
  const succeededReplay = recovered?.status === "succeeded"
  if (record && !operationId && !succeededReplay)
    throw new Error("SUBMISSION_UNCERTAIN: 本地记录没有可恢复的远端 task_id，禁止重新提交收费任务")
  let prepared: PreparedImageRequest | undefined
  if (!operationId && !recovered) {
    try {
      prepared = await preflightImageGeneration(input, channelOptions(options, route))
    } catch (error) {
      throw new Error("GENERATION_BLOCKED: " + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
    let quote: Awaited<ReturnType<NonNullable<typeof route>["quote"]>> | undefined
    try {
      quote = await route?.quote()
    } catch (error) {
      throw new Error("GENERATION_BLOCKED: " + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
    if (!options.allowPaidSubmission) {
      if (!options.authorizeSubmission) throw new Error("PROVIDER_UNAVAILABLE: 未授权收费提交；可以恢复既有任务")
      await options.authorizeSubmission(
        {
          product: "image",
          requestId: input.requestId,
          mode: route ? "formal" : "developer",
          accountId: route?.accountId ?? "developer",
          // 开发直连没有本应用可用的报价接口：如实按供应商入口说明"可能产生费用"，不编造点数。
          apiUrl: route?.apiUrl ?? new URL(prepared.endpoint).origin,
          request: approvalRequest(prepared, input.input.prompt),
          ...(quote ? { quote } : {}),
        },
        options.signal,
      )
    }
    if (quote) route!.useQuote(quote)
  }
  if (options.prepareOnly) return { prepared: true, requestId: input.requestId, recovering: !!operationId || !!recovered }
  const binding: { mode: JobRecord["mode"] } & Partial<JobRecord> = route
    ? {
        mode: "formal",
        accountId: route.accountId,
        apiUrl: route.apiUrl,
        ...(recovered ? { serverRequestId: recovered.serverRequestId } : {}),
      }
    : { mode: "developer" }
  // 记录落盘规则（合并顺序 + 临时文件 + rename + 0600）只在 generate-hunyuan/src/job-record.ts 一处；四包同一份实现。
  const persist = createJobRecordPersister<JobRecord>({
    file,
    binding,
    read: () => record,
    write: (value) => { record = value },
  })
  if (!record) {
    record = {
      ...binding,
      status: operationId ? "resuming" : "submitting",
      requestFingerprint: fingerprint,
      ...(operationId ? { operationId } : {}),
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: "wx" })
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") throw new Error("GENERATION_ALREADY_RUNNING: 同 requestId 已开始")
      throw error
    }
  }
  await persist({
    status: operationId ? "resuming" : "submitting",
    cancellation: null,
    requestFingerprint: fingerprint,
    ...(operationId ? { operationId } : {}),
  })
  try {
    // 服务端已判定成功且持久化了应答：直接回放那份响应（不提交、不查询供应商、不需要原参考图）。
    const restored = recovered?.status === "succeeded"
    const task: ImageTaskResult = restored
      ? { ...(await taskFromServerResponse(recovered!.response, channelOptions(options, route))), referenceImages: [], request: {} }
      : await generateImages(input, {
          ...channelOptions(options, route),
          resumeTaskId: operationId,
          ...(prepared ? { prepared } : {}),
          onSubmitted: async (taskId, requestId, snapshot) => {
            // 记录"实际生效的模型"：正式路由只认服务端快照；开发直连用本次真正提交的本地模型。
            // 正式模式下本地模型名只是请求体占位，服务端没给快照就如实不记（恢复时不猜）。
            const observed = snapshot?.model ?? (route ? undefined : prepared?.model)
            await persist({
              operationId: taskId,
              status: "running",
              ...(requestId ? { serverRequestId: requestId } : {}),
              ...(observed ? { model: observed } : {}),
            })
          },
        })
    // 模型只认"实际生效"的那一个：服务端快照 > 本次提交用的本地模型 > 记录里那次的值。
    // 都没有就缺省——绝不用当前配置给历史任务补一个模型名。
    const model = recovered?.model ?? task.model ?? record?.model
    const result: ImageGenerationResult = {
      requestId: input.requestId,
      ...(model ? { model } : {}),
      ...(task.taskId ? { taskId: task.taskId } : {}),
      requestIds: task.requestIds,
      ...(task.usage ? { usage: task.usage } : {}),
      images: await persistImages(options.dataDirectory, input.requestId, task),
      referenceImages: task.referenceImages ?? [],
      request: task.request ?? {},
      ...(restored ? { restoredFromServer: true as const } : {}),
    }
    await persist({
      status: "completed",
      result,
      ...(task.taskId ? { operationId: task.taskId } : {}),
      ...(model ? { model } : {}),
    })
    return result
  } catch (error) {
    const cancelledLocally = options.signal?.aborted === true
    const persistedOperationId = record?.operationId ?? operationId
    if (!cancelledLocally && (error as { code?: string } | undefined)?.code === REMOTE_JOB_LOST_CODE) {
      const failure = remoteJobLostError(
        remoteJobLostMessage({
          operationId: persistedOperationId,
          detail: error instanceof Error ? error.message : String(error),
          reopened: false,
        }),
        error,
      )
      await persist({ status: "remote-lost", error: failure.message, ...(persistedOperationId ? { operationId: persistedOperationId } : {}) })
      throw failure
    }
    await persist({
      status: cancelledLocally ? "cancelled-local" : "interrupted",
      error: error instanceof Error ? error.message : String(error),
      ...(cancelledLocally
        ? {
            cancellation:
              (error as { cancellation?: CancellationReport } | undefined)?.cancellation ??
              ({
                scope: "local",
                remoteStopRequested: false,
                remoteMayStillRun: true,
                submissionConfirmed: persistedOperationId !== undefined,
                ...(persistedOperationId ? { operationId: persistedOperationId } : {}),
              } satisfies CancellationReport),
          }
        : {}),
    })
    throw error
  }
}
