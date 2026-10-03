import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { generateMesh, extractGeneratedMesh, type CancellationReport, type CreateObjectRequest, preflightGeneration, REMOTE_JOB_LOST_CODE } from "./provider.ts"
import { createJobRecordPersister } from "./job-record.ts"
// 产物转存与公网守卫都在本包的共享模块里（`./artifact-transfer.ts` / `./url-safety.ts`）：
// 转存实现只有这一份，marble / tripo 以相对路径复用；这里的 `allowPrivate` 沿用本包已声明的
// `OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS`（`provider.ts:122` 的清单里本来就有它），不新增环境键。
import { transferArtifacts } from "./artifact-transfer.ts"
import { allowPrivateAssetURLs } from "./url-safety.ts"
// 终态结果现在带转存读数（`artifacts` / `artifactsFetched` / `artifactsFetchError`）：类型从共享模块原样转出，
// 调用方与测试不必知道实现在哪个文件（tripo / marble 同样转出）。
export type { ArtifactTransfer, GenerationArtifacts, TransferredResult } from "./artifact-transfer.ts"
import { formalGenerationRoute, type GenerationRoutingOptions } from "@lyapunov/api-client/generation"
import type {GenerationAuthorizer} from "@lyapunov/api-client/generation-approval"
export type { CancellationReport }
/**
 * 作业状态：submitting/resuming/running 进行中；completed 终态（本地已完成资产仍可用）；
 * cancelled-local 本地取消（远端可能仍在运行）；interrupted 可重试中断（网络/查询临时失败）；
 * remote-lost 供应商业务错误确认作业不存在（如 FailedOperation.JobNotFound）的自动恢复终态：
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

/** 供应商明确“作业不存在”时的产品级说明：保留作业ID与动作含义，隐去 requestId 等实现细节。 */
function remoteJobLostMessage(input: { operationId?: string; detail: string; reopened: boolean }) {
  const job = input.operationId ? `远端作业 ${input.operationId}` : "远端作业（作业ID未记录）"
  const withoutCode = input.detail.startsWith(REMOTE_JOB_LOST_CODE + ": ")
    ? input.detail.slice(REMOTE_JOB_LOST_CODE.length + 2)
    : input.detail
  // 面向终端用户的文案不携带供应商请求追踪号等排查细节。
  const detail = withoutCode.replace(/[\s　]*[(（]RequestId[:：][^)）]*[)）]\s*$/i, "")
  return input.reopened
    ? `GENERATION_REMOTE_JOB_LOST: 记录已是终态 remote-lost（${job} 已被供应商确认为不存在）；本次未重新查询供应商、未提交新任务。本产品不会自动重试该作业；如用户判断需要，可显式重试恢复（只重新查询该作业，不会提交新任务）。本地已完成的生成资产不受影响；如需再次生成，请按正常生成流程发起新的生成请求（仍会走既有确认）。原记录：${detail}`
    : `GENERATION_REMOTE_JOB_LOST: ${job} 已被供应商确认为不存在；本产品据此把自动恢复记为终态 remote-lost——不再自动重查远端，也不会在没有新确认的情况下重新提交收费任务。本地已完成的生成资产不受影响；如需再次生成，请按正常生成流程发起新的生成请求（仍会走既有确认）。供应商信息：${detail}`
}
export async function runGeneration(
  input: CreateObjectRequest & { resumeJobId?: string } & { requestId: string },
  options: GenerationOptions,
) {
  // requestId 是记录文件身份：正则会把 undefined/null/数字隐式字符串化成 "undefined"/"null"/"123"，
  // 多个不同请求因此塌缩到同一个 JobRecord，可能把前一个请求的已完成资产当成新请求的结果返回。
  if (typeof input.requestId !== "string" || !/^[\w-]+$/.test(input.requestId)) throw new Error("INVALID_REQUEST_ID")
  if (input.resumeJobId !== undefined && (typeof input.resumeJobId !== "string" || !input.resumeJobId.trim()))
    throw new Error("INVALID_RESUME_JOB_ID: 恢复必须使用原供应商作业ID，未提交新任务")
  const route = await formalGenerationRoute(options, "hunyuan", input.requestId)
  await mkdir(options.dataDirectory, { recursive: true })
  const file = join(options.dataDirectory, input.requestId + ".json")
  let record: JobRecord | undefined
  try {
    record = JSON.parse(await readFile(file, "utf8"))
    if (
      !record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.status !== "string" || !record.status.trim() ||
      (record.operationId !== undefined && (typeof record.operationId !== "string" || !record.operationId.trim()))
    ) throw new Error("GENERATION_RECORD_INVALID: 本地恢复记录无效，禁止重新提交收费任务")
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
  // 与 marble 同口径：只有 completed 与 result 同时存在才是可用的持久结果。
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
  if (recovered?.status === "failed") throw new Error("GENERATION_FAILED: " + (recovered.error ?? "供应商任务已失败"))
  const operationId = recovered?.operationId ?? record?.operationId ?? input.resumeJobId
  let recoveredResult: ReturnType<typeof extractGeneratedMesh> | undefined
  if (recovered?.status === "succeeded") {
    try {
      recoveredResult = extractGeneratedMesh(recovered.response)
    } catch (error) {
      if (!operationId) throw error
    }
  }
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
  if (record && !operationId && !recoveredResult)
    throw new Error("SUBMISSION_UNCERTAIN: 本地记录没有可恢复的供应商作业ID，禁止重新提交收费任务")
  let prepared:Awaited<ReturnType<typeof preflightGeneration>>|undefined
  if(!operationId&&!recovered){
    try{prepared=await preflightGeneration(input,route?{apiKey:route.token,baseURL:route.providerBaseUrl,submitPath:'/v1/ai3d/submit'}:{})}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    let quote:Awaited<ReturnType<NonNullable<typeof route>['quote']>>|undefined
    try{quote=await route?.quote()}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    if(!options.allowPaidSubmission){
      if(!options.authorizeSubmission)throw new Error("PROVIDER_UNAVAILABLE: 未授权收费提交；可以恢复既有任务")
      await options.authorizeSubmission({product:'hunyuan',requestId:input.requestId,mode:route?'formal':'developer',accountId:route?.accountId??'developer',apiUrl:route?.apiUrl??prepared.endpoint,request:prepared.request,quote},options.signal)
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
  // 记录落盘规则（合并顺序 + 临时文件 + rename + 0600）只在 ./job-record.ts 一处；四包同一份实现。
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
  await persist({ status: operationId ? "resuming" : "submitting", cancellation: null, ...(operationId ? { operationId } : {}) })
  try {
    // Prefer the saved result: completed provider jobs may already have expired from its query API.
    const result = recoveredResult ?? await generateMesh(input, {
      resumeJobId: operationId,
      preparedPayload: prepared?.request,
      signal: options.signal,
      ...(route
        ? {
            apiKey: route.token,
            baseURL: route.providerBaseUrl,
            submitPath: "/v1/ai3d/submit",
            queryPath: "/v1/ai3d/query",
            fetch: route.fetcher,
          }
        : {}),
      onSubmitted: async (id) => {
        await persist({ operationId: id, status: "running" })
      },
    })
    // 供应商产物链接是限时外部链接（本产品只长期持有本地字节）：终态落盘前先把 mesh/预览各转存一次到
    // dataDirectory；转存失败如实降级（artifactsFetched:false + 原因原文）、不影响已经成功的生成任务。
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
    // 供应商业务错误确认作业不存在：落自动恢复终态 remote-lost（保留作业ID、可读说明），与可重试的 interrupted 区分。
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
