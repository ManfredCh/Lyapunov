import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { generateMesh, extractGeneratedMesh, type CancellationReport, type CreateObjectRequest, preflightGeneration, REMOTE_JOB_LOST_CODE } from "./provider.ts"
// 转存 URL 的私网放行开关由**调用方**给（共享模块自己不读环境）：本包沿用 `OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS`
// ——它本来就在 `TRIPO_DEVELOPER_ENV_KEYS` 清单里（`provider.ts:89`），接线不新增任何环境键。
import { allowPrivateAssetURLs } from "../../generate-hunyuan/src/url-safety.ts"
import { transferArtifacts } from "../../generate-hunyuan/src/artifact-transfer.ts"
import { createJobRecordPersister } from "../../generate-hunyuan/src/job-record.ts"
import { formalGenerationRoute, type GenerationRoutingOptions } from "@lyapunov/api-client/generation"
import type {GenerationAuthorizer} from "@lyapunov/api-client/generation-approval"
export type { CancellationReport }
/**
 * 作业状态：submitting/resuming/running 进行中；completed 终态（本地已完成资产仍可用）；
 * cancelled-local 本地取消（远端可能仍在运行）；interrupted 可重试中断（网络/查询临时失败）；
 * remote-lost 供应商明确任务不存在（task_status UNKNOWN）的自动恢复终态：
 * 保留 operationId，冷重开不再自动查询远端、也不会重新提交收费任务；用户可显式重试恢复。
 */
export interface JobRecord {
  operationId?: string
  status: string
  result?: unknown
  updatedAt: string
  error?: string
  mode?: "formal" | "developer"
  accountId?: string
  apiUrl?: string
  serverRequestId?: string
  /**
   * 请求输入指纹（模式/提示词/参考图/质量参数）。同一个 requestId 换了实际请求必须显式冲突，
   * 否则会把上一次的模型当成这一次的结果返回。缺失 = 身份未知（只给 resumeJobId 建立的记录），
   * 此时带输入恢复必须明确拒绝，纯 requestId 恢复不受影响。
   */
  requestFingerprint?: string
  /** 取消只停止本地等待时的显式报告；只有 cancelled-local 状态会写入。 */
  cancellation?: CancellationReport | null
}
export interface GenerationOptions extends GenerationRoutingOptions {
  dataDirectory: string
  allowPaidSubmission?: boolean
  authorizeSubmission?: GenerationAuthorizer
  prepareOnly?:boolean
  /**
   * 产物**转存下载**用的 fetch（测试替身注入点，缺省全局 fetch）。刻意与中央路由 `fetcher` 分开：
   * 供应商 CDN 产物链接不走中央网关，用路由 fetcher 会被 origin 判定拒掉。
   */
  artifactFetch?: typeof fetch
}

function remoteJobLostError(message: string, cause?: unknown) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause })
  ;(error as { code?: string }).code = REMOTE_JOB_LOST_CODE
  return error
}

/** 供应商明确“任务不存在”时的产品级说明：保留作业ID与动作含义，隐去 requestId 等实现细节。 */
function remoteJobLostMessage(input: { operationId?: string; detail: string; reopened: boolean }) {
  const job = input.operationId ? `远端作业 ${input.operationId}` : "远端作业（作业ID未记录）"
  const withoutCode = input.detail.startsWith(REMOTE_JOB_LOST_CODE + ": ")
    ? input.detail.slice(REMOTE_JOB_LOST_CODE.length + 2)
    : input.detail
  // 面向终端用户的文案不携带供应商请求追踪号等排查细节。
  const detail = withoutCode.replace(/[\s　]*[(（]request_id[:：][^)）]*[)）]\s*$/i, "")
  return input.reopened
    ? `GENERATION_REMOTE_JOB_LOST: 记录已是终态 remote-lost（${job} 已被供应商确认为不存在）；本次未重新查询供应商、未提交新任务。本产品不会自动重试该作业；如用户判断需要，可显式重试恢复（只重新查询该作业，不会提交新任务）。本地已完成的生成资产不受影响；如需再次生成，请按正常生成流程发起新的生成请求（仍会走既有确认）。原记录：${detail}`
    : `GENERATION_REMOTE_JOB_LOST: ${job} 已被供应商确认为不存在；本产品据此把自动恢复记为终态 remote-lost——不再自动重查远端，也不会在没有新确认的情况下重新提交收费任务。本地已完成的生成资产不受影响；如需再次生成，请按正常生成流程发起新的生成请求（仍会走既有确认）。供应商信息：${detail}`
}

/** 与共享 `generation-approval` / `generate-image` 同一套指纹口径（canonical JSON + sha256），便于各层对得上。 */
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
 * 请求输入身份：生成模式 + 提示词 + 参考图引用 + 质量参数 + 显式材质参数。
 * 只覆盖**输入本身**（不含 resumeJobId、不含供应商凭据/入口，也不读参考图文件内容）：
 * 恢复一条已有任务时输入可能已经不可用，指纹必须还能算出来并逐字一致，否则"纯恢复"会变成"要求原文件还在"。
 */
function requestFingerprint(input: CreateObjectRequest) {
  const { mode, prompt, referenceImageUri, referenceImageUris } = input?.input ?? {}
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          mode: mode ?? null,
          prompt: prompt ?? null,
          referenceImageUri: referenceImageUri ?? null,
          referenceImageUris: referenceImageUris ?? [],
          quality: input?.quality ?? null,
          // 未传参时不新增指纹字段，旧请求的恢复身份保持原样。
          ...(input.pbr !== undefined ? { pbr: input.pbr } : {}),
          ...(input.texture !== undefined ? { texture: input.texture } : {}),
        }),
      ),
    )
    .digest("hex")
}

/** 只有这两个键的调用才是"只恢复原请求"；其余任何键都表示调用方这次给了要生成的东西。 */
const RECOVERY_ONLY_KEYS = new Set(["requestId", "resumeJobId"])

/**
 * 本次调用到底有没有给出"新请求的输入"。两种意图必须区分开：
 * - **新提交有输入**：给了 `input` 里的字段、顶层 `quality`，或任何别的键 → 必须与这个 requestId
 *   原有的请求核对身份；
 * - **只恢复原请求**：只给 requestId（可附 resumeJobId）→ 取回该 requestId 原来的结果，
 *   不要求调用方再交一遍旧提示词或旧参考图。
 *
 * 形状写错（例如把 prompt 写在顶层）也算"带了输入"：那是调用方想生成别的东西，
 * 不能当纯恢复放行、把上一次的模型当成这次的结果返回——后面的 preflight 会明确拒绝它。
 */
function hasRequestInput(input: CreateObjectRequest) {
  const value = input?.input
  if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some((item) => item !== undefined))
    return true
  return Object.keys(input ?? {}).some((key) => key !== "input" && !RECOVERY_ONLY_KEYS.has(key))
}

/**
 * 请求**体**指纹（注意与上面的输入指纹不同）：与中央 `generation-gateway` 的 `fingerprint()` 同一口径——
 * `sha256(canonical(JSON.parse(rawBody)))`，rawBody 就是 `JSON.stringify(payload)`（见 provider `callAPI`）。
 * 服务端提交时把它连同请求行保存，lookup 时回给客户端；冷重开没有本地记录时，这是唯一能证明
 * "这次输入 = 那条请求"的证据。
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
    "GENERATION_REQUEST_ID_CONFLICT: 这个 requestId 已经用于另一次不同的 3D 生成请求（模式/提示词/参考图/质量参数不同），" +
      `${where}的输入对不上；请为新的请求换一个 requestId——同一次身份不会返回上一次的模型。` +
      "如果只是想取回该 requestId 原来生成的结果，请只给 requestId（不要带 input）再调用一次。" +
      (record ? ` 原记录：${record.status}${record.operationId ? ` / 作业 ${record.operationId}` : ""}` : ""),
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
 * 产物转存（`meshURL` + `thumbnailURL` 各下载一次写 `dataDirectory`）**只在共享模块一处实现**
 * （`generate-hunyuan/src/artifact-transfer.ts`，与 `job-record.ts` / `url-safety.ts` 同一落点判据）：
 * 本包不再持有第二份拷贝，只把公开面原样转出去。
 */
export { transferArtifacts } from "../../generate-hunyuan/src/artifact-transfer.ts"
export type {
  ArtifactTransfer,
  ArtifactTransferOptions,
  GenerationArtifacts,
  TransferredResult,
} from "../../generate-hunyuan/src/artifact-transfer.ts"

export async function runGeneration(
  input: CreateObjectRequest & { resumeJobId?: string } & { requestId: string },
  options: GenerationOptions,
) {
  // requestId 是记录文件身份：正则会把 undefined/null/数字隐式字符串化成 "undefined"/"null"/"123"，
  // 多个不同请求因此塌缩到同一个 JobRecord，可能把前一个请求的已完成资产当成新请求的结果返回。
  if (typeof input.requestId !== "string" || !/^[\w-]+$/.test(input.requestId)) throw new Error("INVALID_REQUEST_ID")
  const route = await formalGenerationRoute(options, "tripo", input.requestId)
  await mkdir(options.dataDirectory, { recursive: true })
  const file = join(options.dataDirectory, input.requestId + ".json")
  let record: JobRecord | undefined
  try {
    record = JSON.parse(await readFile(file, "utf8"))
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error
  }
  if (
    route &&
    record &&
    (record.mode !== "formal" || record.accountId !== route.accountId || record.apiUrl !== route.apiUrl)
  )
    throw new Error("GENERATION_ACCOUNT_MISMATCH: 该记录未绑定当前正式账户和中央API")
  if (!route && record?.mode === "formal") throw new Error("GENERATION_MODE_MISMATCH: 开发模式不能读取正式生成记录")
  // 输入身份先于"已完成"判定：同一个 requestId 换了模式/提示词/参考图/质量参数时必须**显式冲突**，
  // 否则会把上一次的模型当成这一次的结果悄悄返回。纯恢复（只给 requestId，不给 input）不在此列。
  const hasInput = hasRequestInput(input)
  // 身份合同：指纹只由"这次真的带了输入"的调用产生，纯恢复保留记录里已有的身份；
  // 记录里本来就没有（老记录/只给 resumeJobId 建立）就保持未知——不写、不猜。
  const fingerprint = hasInput ? requestFingerprint(input) : record?.requestFingerprint
  if (hasInput && record?.requestFingerprint && record.requestFingerprint !== fingerprint)
    throw requestIdConflict("这份本地记录", record)
  // 记录在、身份却**未知**：带 input 时不拿这份记录的结果回放——它证不了"这次输入=原来那次"。
  if (hasInput && record && !record.requestFingerprint) throw inputUnverified("这份本地记录没有保存原请求的输入指纹")
  // 与 marble/hunyuan 同口径：只有 completed 与 result 同时存在才是可用的持久结果。
  if (record?.status === "completed" && record.result !== undefined) return record.result
  // 自动恢复终态：不重新查询供应商（也不会重新提交），直接给出可读说明；operationId 保留在记录里。
  if (record?.status === "remote-lost")
    throw remoteJobLostError(
      remoteJobLostMessage({
        operationId: record.operationId,
        detail: record.error ?? "（记录未保存供应商错误）",
        reopened: true,
      }),
    )
  const recovered = await route?.lookup()
  // 服务端提交时保存的请求体指纹，是**本地没有记录**时（冷重开/换机器/换 dataDirectory）唯一的身份来源：
  // 上面那条本地判据在那种情况下没有机会比对。带了 input 就是"新请求"意图，必须与那一行核对，
  // 核对不了就拒绝——否则会把上一次那次请求的旧模型当成这次输入的结果返回。
  if (hasInput && recovered) {
    let identity: Awaited<ReturnType<typeof preflightGeneration>>
    try {
      identity = await preflightGeneration(input, route ? { apiKey: route.token, baseURL: route.providerBaseUrl } : {})
    } catch (error) {
      throw inputUnverified(error instanceof Error ? error.message : String(error))
    }
    const stored = recovered.requestFingerprint
    if (typeof stored !== "string" || !/^[a-f0-9]{64}$/.test(stored))
      throw inputUnverified("中央服务那条记录没有保存请求指纹，无法据此核对")
    if (stored !== payloadFingerprint(identity.request)) throw requestIdConflict("中央服务上这条请求")
  }
  if (recovered?.status === "failed") throw new Error("GENERATION_FAILED: " + (recovered.error ?? "供应商任务已失败"))
  let operationId = recovered?.operationId ?? record?.operationId ?? input.resumeJobId
  if (recovered && !operationId && recovered.status !== "succeeded")
    throw new Error("SUBMISSION_UNCERTAIN: " + recovered.status + " " + (recovered.error ?? ""))
  // 旧记录 completed 但缺 result：有作业ID时只重新查询恢复（不提交）；没有可恢复作业ID时明确报无法恢复，不返回 undefined。
  if (record?.status === "completed" && record.result === undefined && !operationId && recovered?.status !== "succeeded")
    throw new Error(
      "GENERATION_RESULT_MISSING: 本地记录为 completed 但缺少结果，且没有可恢复的供应商作业ID；" +
        "不会重新提交收费任务。请在供应商侧确认该作业状态后按新的生成请求发起。",
    )
  // A local record written before the provider response is an uncertain
  // submission boundary.  Even with a formal route, a missing central row
  // must not turn a host restart into a second paid submission.
  if (record && !operationId && ["submitting", "resuming", "running", "cancelled-local", "interrupted"].includes(record.status))
    throw new Error("SUBMISSION_UNCERTAIN: 本地记录没有可恢复的供应商作业ID，禁止重新提交收费任务")
  if (!route && !operationId && record) throw new Error("SUBMISSION_UNCERTAIN: 供应商作业ID未知，不能重新发起收费任务")
  let prepared:Awaited<ReturnType<typeof preflightGeneration>>|undefined
  if(!operationId&&!recovered){
    try{prepared=await preflightGeneration(input,route?{apiKey:route.token,baseURL:route.providerBaseUrl}:{})}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    let quote:Awaited<ReturnType<NonNullable<typeof route>['quote']>>|undefined
    try{quote=await route?.quote()}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    if(!options.allowPaidSubmission){
      if(!options.authorizeSubmission)throw new Error("PROVIDER_UNAVAILABLE: 未授权收费提交；可以恢复既有任务")
      await options.authorizeSubmission({product:'tripo',requestId:input.requestId,mode:route?'formal':'developer',accountId:route?.accountId??'developer',apiUrl:route?.apiUrl??prepared.endpoint,request:prepared.request,quote},options.signal)
    }
    if(quote)route!.useQuote(quote)
  }
  if(options.prepareOnly)return {prepared:true,requestId:input.requestId,recovering:!!operationId||!!recovered}
  const binding: Partial<JobRecord> = route
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
      // 没有输入就没有身份：不写、不猜（纯恢复不带 input 时这里就是 undefined，键不会被落盘）。
      requestFingerprint: fingerprint,
      ...(operationId ? { operationId } : {}),
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: "wx" })
    } catch (error: any) {
      if (error.code === "EEXIST") throw new Error("GENERATION_ALREADY_RUNNING: 同requestId已开始")
      throw error
    }
  }
  await persist({
    status: operationId ? "resuming" : "submitting",
    cancellation: null,
    // 纯恢复时 fingerprint 就是记录里原有的值：只回写、不覆盖（也不把空输入顶替成身份）。
    requestFingerprint: fingerprint,
    ...(operationId ? { operationId } : {}),
  })
  try {
    const result =
      recovered?.status === "succeeded" && !operationId
        ? extractGeneratedMesh(recovered.response)
        : await generateMesh(input, {
            resumeJobId: operationId,
            preparedPayload:prepared?.request,
            signal: options.signal,
            ...(route
              ? {
                  apiKey: route.token,
                  baseURL: route.providerBaseUrl,
                  fetch: route.fetcher,
                }
              : {}),
            onSubmitted: async (id) => {
              await persist({ operationId: id, status: "running" })
            },
          })
    // 供应商产物链接只 2 小时有效：终态落盘前先把字节转存到 dataDirectory；转存失败如实降级、不影响任务成功。
    const transferred = await transferArtifacts(result, {
      dataDirectory: options.dataDirectory,
      requestId: input.requestId,
      allowPrivate: allowPrivateAssetURLs(),
      ...(options.artifactFetch ? { fetch: options.artifactFetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await persist({ status: "completed", result: transferred })
    return transferred
  } catch (error) {
    const cancelledLocally = options.signal?.aborted === true
    const persistedOperationId = record?.operationId ?? operationId
    // 供应商明确任务不存在：落自动恢复终态 remote-lost（保留作业ID、可读说明），与可重试的 interrupted 区分。
    if (!cancelledLocally && (error as { code?: string } | undefined)?.code === REMOTE_JOB_LOST_CODE) {
      const failure = remoteJobLostError(
        remoteJobLostMessage({
          operationId: persistedOperationId,
          detail: error instanceof Error ? error.message : String(error),
          reopened: false,
        }),
        error,
      )
      await persist({
        status: "remote-lost",
        error: failure.message,
        ...(persistedOperationId ? { operationId: persistedOperationId } : {}),
      })
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
