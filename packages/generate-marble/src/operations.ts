import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { generateWorld, extractWorldAsset, type CancellationReport, type GenerateInput, preflightGeneration } from "./provider.ts"
import { createJobRecordPersister } from "../../generate-hunyuan/src/job-record.ts"
// 产物转存只在共享模块一处（`generate-hunyuan/src/artifact-transfer.ts`，与 `job-record.ts` 同一落点判据）。
// **不传 `allowPrivate`**：本包不读 `OBJECT_GENERATOR_*`（见 `test/env-forwarding.test.ts` 的清单合同），
// 而 marble 的产物本来就在公网 CDN 上——缺省 false 就是本包要的语义，也不新增任何环境键。
import { transferWorldArtifacts } from "../../generate-hunyuan/src/artifact-transfer.ts"
// 终态结果现在带转存读数（`artifacts` / `artifactsFetched` / `artifactsFetchError`）：类型从共享模块原样转出。
export type { ArtifactTransfer, GenerationArtifacts, TransferredResult } from "../../generate-hunyuan/src/artifact-transfer.ts"
import { formalGenerationRoute, type GenerationRoutingOptions } from "@lyapunov/api-client/generation"
import type {GenerationAuthorizer} from "@lyapunov/api-client/generation-approval"
export type { CancellationReport }
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
export async function runGeneration(input: GenerateInput & { requestId: string }, options: GenerationOptions) {
  // requestId 是记录文件身份：正则会把 undefined/null/数字隐式字符串化成 "undefined"/"null"/"123"，
  // 多个不同请求因此塌缩到同一个 JobRecord，可能把前一个请求的已完成资产当成新请求的结果返回。
  if (typeof input.requestId !== "string" || !/^[\w-]+$/.test(input.requestId)) throw new Error("INVALID_REQUEST_ID")
  const route = await formalGenerationRoute(options, "marble", input.requestId)
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
  // 只有 completed 与 result 同时存在才是可用的持久结果；缺 result 的 completed（修复前的
  // 中间态窗口遗留）必须走恢复，不能把 undefined 当作结果返回。
  if (record?.status === "completed" && record.result !== undefined) return record.result
  const recovered = await route?.lookup()
  if (recovered?.status === "failed") throw new Error("GENERATION_FAILED: " + (recovered.error ?? "供应商任务已失败"))
  let operationId = recovered?.operationId ?? record?.operationId ?? input.resumeOperationId
  if (recovered && !operationId && recovered.status !== "succeeded")
    throw new Error("SUBMISSION_UNCERTAIN: " + recovered.status + " " + (recovered.error ?? ""))
  // 旧记录 completed 但缺 result：有 operationId 时只重新查询恢复（下方走 resume，不提交）；
  // 没有可恢复的供应商作业ID时明确报“无法恢复”，绝不返回 undefined，也绝不重新提交收费任务。
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
    try{prepared=await preflightGeneration({...input,...route?{apiKey:route.token,baseURL:route.providerBaseUrl}:{} })}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    let quote:Awaited<ReturnType<NonNullable<typeof route>['quote']>>|undefined
    try{quote=await route?.quote()}catch(error){throw new Error('GENERATION_BLOCKED: '+(error instanceof Error?error.message:String(error)),{cause:error})}
    if(!options.allowPaidSubmission){
      if(!options.authorizeSubmission)throw new Error("PROVIDER_UNAVAILABLE: 未授权收费提交；可以恢复既有任务")
      await options.authorizeSubmission({product:'marble',requestId:input.requestId,mode:route?'formal':'developer',accountId:route?.accountId??'developer',apiUrl:route?.apiUrl??prepared.endpoint,request:prepared.request,quote},options.signal)
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
    const result =
      recovered?.status === "succeeded" && !operationId
        ? extractWorldAsset(recovered.response)
        : await generateWorld({
            ...input,
            resumeOperationId: operationId,
            signal: options.signal,
            ...(route
              ? { apiKey: route.token, baseURL: route.providerBaseUrl, fetch: route.fetcher, centralAccount: true }
              : {}),
            onProgress: async (progress) => {
              // 供应商的 completed 只是进度通知，不能抢先成为持久结果：本地 completed 只在
              // result 随同写入时由下方 persist({status:"completed", result}) 原子落盘。
              if (progress.operationID && progress.stage !== "completed" && progress.done !== true)
                await persist({ operationId: progress.operationID, status: progress.stage ?? "running" })
            },
          })
    // 世界产物的链接同样是限时外部链接（`spzURL` 是主产物，另有 mesh/预览/全景）：终态落盘前各转存一次
    // 到 dataDirectory；转存失败如实降级（artifactsFetched:false + 原因原文）、不影响已经成功的生成任务。
    // `worldURL`（供应商在线查看页）**不在转存范围**：它是页面不是产物字节。
    const transferred = await transferWorldArtifacts(result, {
      dataDirectory: options.dataDirectory,
      requestId: input.requestId,
      ...(options.artifactFetch ? { fetch: options.artifactFetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await persist({ status: "completed", result: transferred })
    return transferred
  } catch (error) {
    const cancelledLocally = options.signal?.aborted === true
    const persistedOperationId = record?.operationId ?? operationId
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
