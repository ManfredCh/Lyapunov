/** 生成插件共享的中央API客户端函数；不含钱包实现、Agent或任务调度。 */
import { env } from "./env"
// Source-only 4090 recipe selection is shared with the gateway; it is not a formal provider route.
export { worldGenerationRecipe, parseWorldGenerationSelection } from "./world-generation-contract"
export type {
  WorldGenerationTier, WorldGenerationRecipeId, HistoricalWorldGenerationRecipeId,
  WorldGenerationSelection, WorldGenerationRecipe,
} from "./world-generation-contract"
export type GenerationProduct = "marble" | "hunyuan" | "tripo" | "image"
/** 正式产品名称与内部 product 分开；协议与审计继续使用原 product。 */
export function generationPublicName(product: GenerationProduct): string {
  return product === "image" ? "图像生成 / Image generation" : "Pontryagin 3D"
}

/** 正式工具的错误投影；原始 provider 错误保留在 cause/任务审计，不用于产品正文。 */
export function generationPublicError(error: unknown, product: GenerationProduct): Error {
  const original = error instanceof Error ? error : new Error(String(error))
  const name = generationPublicName(product)
  const code = (original as { code?: string }).code ?? original.message.match(/^([A-Z][A-Z_]+):/)?.[1]
  const messages: Record<string,string> = {
    GENERATION_CANCELLED_LOCAL: `${name} 已停止本地等待；远端任务可能继续，保留当前作业，不重新提交。`,
    GENERATION_REMOTE_JOB_LOST: `${name} 的远端作业已不存在，本次恢复停止；不再自动查询或重新提交。已有本地产物保留，重新生成须发起新请求并确认实际报价。`,
  }
  let message = code && messages[code]
  if (!message && /tripo|dashscope|aliyuncs/i.test(original.message)) {
    message = /referenceImageUri.*(?:data URL|public image URL)/i.test(original.message)
      ? `${name} 图生需要公开可访问的图片 URL，本地文件或 data URL 尚未提交。`
      : /at most 4 reference images/i.test(original.message)
        ? `${name} 图生最多接受 4 张参考图，未提交本次请求。`
        : /is required|not configured|must be standard|must use https|base_url|workspace_id/i.test(original.message)
          ? `${name} 当前生成配置未就绪；停止本次尝试，配置由服务端处理，不需要客户端供应商密钥。`
          : `${name} 本次生成或恢复未完成；保留当前请求与已取得的产物，不重新提交或循环重试。`
  }
  if (!message) return original
  const projected = new Error(`${code ?? "GENERATION_FAILED"}: ${message}`,{cause:original})
  if (code) (projected as {code?:string}).code = code
  return projected
}

/** 只投影已识别的配置缺口，不把供应商原始响应或入口带到用户文案。 */
async function unavailableGeneration(response: Response, product: GenerationProduct, stage: "报价" | "恢复"): Promise<string> {
  const body = await response.clone().json().catch(() => undefined) as { error?: unknown; message?: unknown } | undefined
  const configured = [body?.error, body?.message].some(value => typeof value === "string" && /generation is not configured|generation_(?:provider|pricing)_unavailable/.test(value))
  const reason = configured ? "中央服务的生成配置或正积分报价未就绪" : `中央${stage}接口未完成本次请求`
  return `${generationPublicName(product)} ${stage}受阻（HTTP ${response.status}）：${reason}；未提交新任务。停止本次尝试，配置就绪后再继续，不需要客户端供应商密钥。`
}
export type GenerationFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export interface GenerationRoutingOptions {
  mode?: "formal" | "developer"
  accountApiUrl?: string
  accountToken?: string
  fetcher?: GenerationFetch
  signal?: AbortSignal
}
/**
 * 服务端报价。`model` 是**服务端实际生效**的模型（只有服务端固定模型的产品才有，例如 image）；
 * 客户端请求体里的 `model` 不一定是实际模型，别拿输入当实际模型展示或记账。
 */
export interface GenerationQuote {product:GenerationProduct;accountId:string;quoteId:string;points:number;unit:'points';pricing:'configured-fixed';reservationCreated:false;model?:string}
export interface RequestLookup {
  requestId: string
  serverRequestId: string
  product: GenerationProduct
  status: string
  operationId: string | null
  /** 本次提交时服务端实际生效的模型快照；null = 该记录没有模型信息（历史行），不要拿当前配置顶替。 */
  model: string | null
  /**
   * 提交时服务端保存的**请求体**哈希（canonical JSON + sha256）；null = 该行没有保存指纹。
   * 冷重开（本地没有记录）时，客户端只能靠它核对"这次的输入与该 requestId 原有请求是不是同一次"，
   * 不同就必须显式冲突，而不是把上一次的结果回放出去。
   */
  requestFingerprint: string | null
  estimatedPoints: number
  chargedPoints: number | null
  error: string | null
  response: unknown
}
export async function formalGenerationRoute(
  options: GenerationRoutingOptions,
  product: GenerationProduct,
  requestId: string,
) {
  const formal = env(process.env, "LYAPUNOV_MODE") === "formal" || options.mode === "formal"
  if (!formal) return undefined
  const apiUrl = (options.accountApiUrl ?? env(process.env, "LYAPUNOV_API_URL") ?? "").replace(/\/$/, ""),
    token = options.accountToken ?? env(process.env, "LYAPUNOV_ACCOUNT_TOKEN")
  if (!apiUrl || !token) throw new Error("AUTH_REQUIRED: 正式生成需要当前账户会话")
  const base = new URL(apiUrl)
  if (
    (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("INVALID_ACCOUNT_API_URL")
  const fetcher = options.fetcher ?? fetch
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-lyapunov-request-id": requestId,
  })
  const meResponse = await fetcher(apiUrl + "/v1/me", { headers, signal: options.signal, redirect: "error" })
  if (!meResponse.ok) throw new Error("AUTH_REQUIRED: 当前账户会话验证失败")
  const me = (await meResponse.json()) as { user?: { id?: string } }
  if (!me.user?.id) throw new Error("INVALID_ACCOUNT_IDENTITY")
  const signedUploads = new Set<string>()
  const accountFetch: GenerationFetch = async (input, init = {}) => {
    const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (signedUploads.has(requested.href)) {
      const uploadHeaders = new Headers(init.headers)
      for (const [key, value] of uploadHeaders) if (value.includes(token)) uploadHeaders.delete(key)
      return fetcher(requested, { ...init, headers: uploadHeaders, redirect: "error" })
    }
    if (requested.origin !== base.origin) throw new Error("CENTRAL_GENERATION_ROUTE_REQUIRED")
    let suffix: string | undefined
    // 插件按**供应商形状**发请求，这里按产品改写成本服务的入口；改写只发生在这层可信 fetcher 里。
    if (product === "marble")
      suffix = requested.pathname.match(
        /\/marble\/v1\/(?:worlds:generate|media-assets:prepare_upload|operations\/[^/]+)$/,
      )?.[0]
    if (product === "hunyuan") suffix = requested.pathname.match(/\/v1\/ai3d\/(?:submit|query)$/)?.[0]
    if (product === "tripo")
      suffix = requested.pathname.match(
        /\/api\/v1\/(?:services\/aigc\/video-generation\/3d-generation|tasks\/[^/]+)$/,
      )?.[0]
    // image（百炼异步图像）：插件按官方形状发提交 `/api/v1/services/aigc/image-generation/generation`
    // 与查询 `/api/v1/tasks/{task_id}`；后者与 tripo **同名**，所以两者都映射到本服务产品独立的中央入口
    // （提交 `/v1/images/generations`、查询 `/v1/images/tasks/{task_id}`），同一个远端 task_id 不会在两产品间串。
    let mapped: string | undefined
    if (product === "image") {
      const task = requested.pathname.match(/\/api\/v1\/tasks\/([^/]+)$/)
      if (task) mapped = `/v1/images/tasks/${encodeURIComponent(task[1]!)}`
      else if (/\/api\/v1\/services\/aigc\/image-generation\/generation$/.test(requested.pathname))
        mapped = "/v1/images/generations"
    }
    if (!suffix && !mapped) throw new Error("CENTRAL_GENERATION_ROUTE_REQUIRED")
    const target = apiUrl + (mapped ?? (product === "marble" ? "/v1" : "") + suffix) + requested.search
    const response = await fetcher(target, {
      ...init,
      headers,
      signal: init.signal ?? options.signal,
      redirect: "error",
    })
    if (product === "marble" && suffix?.endsWith("media-assets:prepare_upload") && response.ok) {
      const prepared = (await response.clone().json()) as any
      const url = prepared.upload_info?.upload_url ?? prepared.upload_info?.uploadURL
      if (typeof url === "string" && new URL(url).protocol === "https:") signedUploads.add(new URL(url).href)
    }
    return response
  }
  const quote=async():Promise<GenerationQuote>=>{
    const response=await fetcher(`${apiUrl}/v1/generation-quotes/${product}`,{headers,signal:options.signal,redirect:'error'})
    if(!response.ok)throw new Error(`CENTRAL_GENERATION_QUOTE_UNAVAILABLE: ${await unavailableGeneration(response,product,"报价")}`)
    const value=await response.json() as GenerationQuote
    if(value.product!==product||value.accountId!==me.user!.id||value.pricing!=='configured-fixed'||value.unit!=='points'||!Number.isSafeInteger(value.points)||value.points<=0||typeof value.quoteId!=='string'||!/^[a-f0-9]{64}$/.test(value.quoteId)||value.reservationCreated!==false||(value.model!==undefined&&(typeof value.model!=='string'||!value.model.trim())))throw new Error('CENTRAL_GENERATION_QUOTE_INVALID')
    return value
  }
  const useQuote=(value:GenerationQuote)=>{if(value.accountId!==me.user!.id||value.product!==product)throw new Error('GENERATION_QUOTE_ACCOUNT_MISMATCH');headers.set('x-lyapunov-generation-quote',value.quoteId)}
  const lookup = async () => {
    const result = await fetcher(`${apiUrl}/v1/generation-requests/${product}/${encodeURIComponent(requestId)}`, {
      headers,
      signal: options.signal,
      redirect: "error",
    })
    if (result.status === 404) {
      const body=await result.json().catch(()=>undefined) as {error?:string}|undefined
      if(body?.error==='generation_request_not_found')return undefined
      throw new Error(`CENTRAL_GENERATION_RECOVERY_UNAVAILABLE: ${generationPublicName(product)} 当前服务尚未提供可确认的请求恢复接口，未提交新的收费任务；停止本次尝试，不重新提交或重复询问收费确认`)
    }
    if (!result.ok) throw new Error(`CENTRAL_GENERATION_LOOKUP_FAILED: ${await unavailableGeneration(result,product,"恢复")}`)
    const value = (await result.json()) as RequestLookup
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.requestId !== requestId || value.product !== product ||
      typeof value.serverRequestId !== "string" || !value.serverRequestId.trim() ||
      typeof value.status !== "string" || !value.status.trim() ||
      (value.operationId !== null && (typeof value.operationId !== "string" || !value.operationId.trim()))
    ) throw new Error("CENTRAL_GENERATION_LOOKUP_INVALID: 请求恢复记录身份或状态无效，未提交新的收费任务")
    return value
  }
  return {
    accountId: me.user.id,
    apiUrl,
    token,
    fetcher: accountFetch as typeof fetch,
    lookup,quote,useQuote,
    providerBaseUrl: product === "marble" ? apiUrl + "/v1" : apiUrl,
  }
}
