import { createHash, createHmac } from "node:crypto"
export interface CreateObjectRequest { input: {mode:"text-to-3d"|"image-to-3d";prompt:string;referenceImageUri:string;referenceImageUris?:string[]};quality?:string }
import { allowedHostsFromEnv, allowPrivateAssetURLs, assertPublicHttpsURL, parsePublicHttpsURL } from "./url-safety.ts"

/**
 * 取消报告：本地等待已停止，但供应商 API 没有远端取消能力（或未请求远端取消），
 * 因此远端作业可能仍在运行。调用方必须据此决定是恢复查询还是人工处理。
 */
export type CancellationReport = {
  scope: "local"
  remoteStopRequested: false
  remoteMayStillRun: true
  /** 取消发生时是否已确认供应商 JobId；false 表示提交结果未知（远端可能已创建作业）。 */
  submissionConfirmed: boolean
  operationId?: string
}

export class ObjectGeneratorError extends Error {
  code?: string
  cancellation?: CancellationReport
  constructor(input: {message:string}) { super(input.message); this.name="ObjectGeneratorError" }
}

/**
 * 供应商业务错误码明确表示“该作业在供应商侧不存在”（如 FailedOperation.JobNotFound）。
 * 本产品把这种明确应答作为**自动恢复的终态**：自动重试不再打在这个作业上（避免无限暗重试），
 * 记录落 remote-lost；如用户判断需要，可显式发起重试（只重新查询该作业，不会提交新任务）。
 * 该标识只描述本产品的自动重试策略，不声称远端作业永远不可能再出现。
 */
const REMOTE_JOB_LOST_PATTERN = /(?:^|[._])JobNotFound$/i
/** 跨层标识：provider 抛错时打上，operations 状态机据此把记录落为自动恢复终态 remote-lost。 */
export const REMOTE_JOB_LOST_CODE = "GENERATION_REMOTE_JOB_LOST"

export type GeneratedMesh = {
  readonly meshURL: string
  readonly thumbnailURL?: string
  readonly response: unknown
}

const POLL_ATTEMPTS_DEFAULT = 180
const POLL_INTERVAL_MS_DEFAULT = 5_000
const POLL_INTERVAL_MS_MIN = 250
const POLL_INTERVAL_MS_MAX = 30_000
type AuthMode = "tc3" | "api-key"
type RequestKind = "submit" | "query"
export type GenerateMeshOptions = {
  preparedPayload?:Record<string,unknown>
  submitPath?:string
  queryPath?:string
  resumeJobId?: string
  onSubmitted?: (id:string)=>Promise<void>
  signal?: AbortSignal
  fetch?: typeof fetch
  apiKey?: string
  baseURL?: string
}

const API_KEY_BASE_URL_DEFAULT = "https://api.ai3d.cloud.tencent.com"

/**
 * **开发直连**（不经中央账户网关）时本插件从宿主环境读取的键，按下面每一处读取逐条登记：
 *   `OBJECT_GENERATOR_API_KEY`（回落 `HUNYUAN_3D_API_KEY`）——凭据（`apiKey` / `authMode`）；
 *   `OBJECT_GENERATOR_AUTH_MODE`——鉴权模式（`authMode`）；
 *   `OBJECT_GENERATOR_SECRET_ID` / `OBJECT_GENERATOR_SECRET_KEY` / `OBJECT_GENERATOR_API_SERVICE`
 *     ——TC3 签名凭据（`signedHeaders`，preflight 的 `requiredEnv` 循环也校验）；
 *   `OBJECT_GENERATOR_SESSION_TOKEN`——临时会话令牌（`signedHeaders` 的 `X-TC-Token`）；
 *   `OBJECT_GENERATOR_API_BASE_URL`（显式入口）> `OBJECT_GENERATOR_API_HOST` + `OBJECT_GENERATOR_API_SCHEME`
 *     （+ `OBJECT_GENERATOR_ALLOW_INSECURE_API`）——端点（`endpoint`）；
 *   `OBJECT_GENERATOR_SUBMIT_PATH` / `OBJECT_GENERATOR_QUERY_PATH`——提交与查询路径（`apiKeyPath`，经
 *     `env(name)` 三元取名，不是首参字面量）；
 *   `OBJECT_GENERATOR_SUBMIT_ACTION` / `OBJECT_GENERATOR_QUERY_ACTION`——TC3 Action（`callAPI` 的
 *     `requiredEnv(kind==="submit"?"…_SUBMIT_ACTION":"…_QUERY_ACTION")` 与 preflight 的 `requiredEnv(key)` 循环）；
 *   `OBJECT_GENERATOR_API_VERSION` / `OBJECT_GENERATOR_API_REGION`——TC3 版本与地域（`callAPI` 的 `signedHeaders`）；
 *   `OBJECT_GENERATOR_MODEL` / `OBJECT_GENERATOR_GENERATE_TYPE` / `OBJECT_GENERATOR_POLYGON_TYPE` /
 *   `OBJECT_GENERATOR_RESULT_FORMAT` / `OBJECT_GENERATOR_ENABLE_PBR` / `OBJECT_GENERATOR_FACE_COUNT`
 *     ——模型与生成档位（`generationOptionsPayload`；`FACE_COUNT` 经 `optionalEnvInt` 包装取名）；
 *   `OBJECT_GENERATOR_POLL_ATTEMPTS` / `OBJECT_GENERATOR_POLL_INTERVAL_MS`——轮询（`generateMesh`）；
 *   `OBJECT_GENERATOR_REFERENCE_IMAGE_HOSTS`——参考图公共 URL 允许主机（`allowedHostsFromEnv`）；
 *   `OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS`——私有地址放行开关（`allowPrivateAssetURLs`，
 *     `./url-safety.ts:15` 处 `process.env` 直读）。
 *
 * 装配方**只按这份清单**搬运，不整体透传父进程环境：隔离启动的开发 Host（终端、管理员 Web）照样拿到开发者
 * 显式配置的这几个值，其它变量（HOME/XDG、别的凭据）继续隔离。清单与读取处的一一对应由
 * `test/env-forwarding.test.ts` 看着（机械扫：直接从 `process.env` 取名 + `env`/`envInt`/`envBool`/`requiredEnv`/
 * `allowedHostsFromEnv` 的首参字面量；再逐条登记 `apiKeyPath`、`requiredEnv` 三元/循环参数、`optionalEnvInt`
 * 等经包装器取名的间接项），
 * 避免"文档里有、实际不读"或反过来的漂移。**正式模式永不搬运**：那条路由经中央账户网关，供应商密钥只在服务端。
 */
export const HUNYUAN_DEVELOPER_ENV_KEYS = [
  // 凭据与鉴权
  "OBJECT_GENERATOR_API_KEY",
  "HUNYUAN_3D_API_KEY",
  "OBJECT_GENERATOR_AUTH_MODE",
  "OBJECT_GENERATOR_SECRET_ID",
  "OBJECT_GENERATOR_SECRET_KEY",
  "OBJECT_GENERATOR_API_SERVICE",
  "OBJECT_GENERATOR_SESSION_TOKEN",
  // 端点
  "OBJECT_GENERATOR_API_BASE_URL",
  "OBJECT_GENERATOR_API_HOST",
  "OBJECT_GENERATOR_API_SCHEME",
  "OBJECT_GENERATOR_ALLOW_INSECURE_API",
  // 提交/查询路径与 TC3 Action、版本、地域
  "OBJECT_GENERATOR_SUBMIT_PATH",
  "OBJECT_GENERATOR_QUERY_PATH",
  "OBJECT_GENERATOR_SUBMIT_ACTION",
  "OBJECT_GENERATOR_QUERY_ACTION",
  "OBJECT_GENERATOR_API_VERSION",
  "OBJECT_GENERATOR_API_REGION",
  // 模型与生成档位
  "OBJECT_GENERATOR_MODEL",
  "OBJECT_GENERATOR_GENERATE_TYPE",
  "OBJECT_GENERATOR_POLYGON_TYPE",
  "OBJECT_GENERATOR_RESULT_FORMAT",
  "OBJECT_GENERATOR_ENABLE_PBR",
  "OBJECT_GENERATOR_FACE_COUNT",
  // 轮询
  "OBJECT_GENERATOR_POLL_ATTEMPTS",
  "OBJECT_GENERATOR_POLL_INTERVAL_MS",
  // 参考图 URL 安全
  "OBJECT_GENERATOR_REFERENCE_IMAGE_HOSTS",
  "OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS",
] as const

function env(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function requiredEnv(name: string) {
  const value = env(name)
  if (!value) throw new ObjectGeneratorError({ message: `${name} is required for object generation` })
  return value
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(env(name))
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  return Math.min(Math.max(value, min), max)
}

function optionalEnvInt(name: string, min: number, max: number) {
  const value = env(name)
  if (!value) return
  return envInt(name, min, min, max)
}

function envBool(name: string) {
  const value = env(name)?.toLowerCase()
  if (!value) return
  return ["1", "true", "yes", "on"].includes(value)
}

function authMode(apiKey?: string): AuthMode {
  if (apiKey) return "api-key"
  const mode = env("OBJECT_GENERATOR_AUTH_MODE")
  if (mode === "tc3" || mode === "api-key") return mode
  if (env("OBJECT_GENERATOR_API_KEY") || env("HUNYUAN_3D_API_KEY")) return "api-key"
  if (env("OBJECT_GENERATOR_SECRET_ID") && env("OBJECT_GENERATOR_SECRET_KEY")) return "tc3"
  return "api-key"
}

function apiKey(value?: string) {
  return (
    value ?? env("OBJECT_GENERATOR_API_KEY") ?? env("HUNYUAN_3D_API_KEY") ?? requiredEnv("OBJECT_GENERATOR_API_KEY")
  )
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function hmac(key: Buffer | string, input: string) {
  return createHmac("sha256", key).update(input).digest()
}

function signedHeaders(input: {
  host: string
  body: string
  timestamp: number
  action: string
  version: string
  region?: string
}) {
  const secretID = requiredEnv("OBJECT_GENERATOR_SECRET_ID")
  const secretKey = requiredEnv("OBJECT_GENERATOR_SECRET_KEY")
  const service = requiredEnv("OBJECT_GENERATOR_API_SERVICE")
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10)
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${input.host}\n`
  const signedHeaderNames = "content-type;host"
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaderNames, sha256(input.body)].join("\n")
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = ["TC3-HMAC-SHA256", input.timestamp, credentialScope, sha256(canonicalRequest)].join("\n")
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, "tc3_request")
  const signature = hmac(secretSigning, stringToSign).toString("hex")
  const authorization =
    "TC3-HMAC-SHA256 " +
    [`Credential=${secretID}/${credentialScope}`, `SignedHeaders=${signedHeaderNames}`, `Signature=${signature}`].join(
      ", ",
    )

  return {
    Authorization: authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: input.host,
    "X-TC-Action": input.action,
    "X-TC-Timestamp": String(input.timestamp),
    "X-TC-Version": input.version,
    ...(input.region ? { "X-TC-Region": input.region } : {}),
    ...(env("OBJECT_GENERATOR_SESSION_TOKEN") ? { "X-TC-Token": env("OBJECT_GENERATOR_SESSION_TOKEN")! } : {}),
  }
}

function endpoint(pathname = "", mode: AuthMode = "tc3", overrideBaseURL?: string) {
  const baseURL = overrideBaseURL ?? env("OBJECT_GENERATOR_API_BASE_URL") ?? (mode === "api-key" ? API_KEY_BASE_URL_DEFAULT : undefined)
  if (baseURL) {
    const parsed = new URL(baseURL)
    return { host: parsed.host, url: new URL(pathname, parsed).toString() }
  }
  const host = requiredEnv("OBJECT_GENERATOR_API_HOST")
  const scheme = env("OBJECT_GENERATOR_API_SCHEME") ?? "https"
  const allowInsecure =
    env("OBJECT_GENERATOR_ALLOW_INSECURE_API") === "1" || env("OBJECT_GENERATOR_ALLOW_INSECURE_API") === "true"
  if (scheme !== "https" && !(allowInsecure && scheme === "http")) {
    throw new ObjectGeneratorError({ message: "OBJECT_GENERATOR_API_SCHEME must be https" })
  }
  if (host.includes("/") || host.includes("@"))
    throw new ObjectGeneratorError({ message: "OBJECT_GENERATOR_API_HOST is invalid" })
  return { host, url: `${scheme}://${host}${pathname}` }
}

function apiKeyPath(kind: RequestKind) {
  const name = kind === "submit" ? "OBJECT_GENERATOR_SUBMIT_PATH" : "OBJECT_GENERATOR_QUERY_PATH"
  return env(name) ?? (kind === "submit" ? "/v1/ai3d/submit" : "/v1/ai3d/query")
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringField(value: unknown, key: string) {
  const item = record(value)?.[key]
  if (typeof item !== "string" || item.length === 0) return
  return item
}

function arrayField(value: unknown, key: string) {
  const item = record(value)?.[key]
  return Array.isArray(item) ? item : []
}

function responseData(input: unknown) {
  const response = record(input)?.Response
  if (response) return response
  const data = record(input)?.data
  if (record(data)) return data
  return input
}

function providerErrorCode(input: unknown) {
  const response = responseData(input)
  const error = record(response)?.Error ?? record(response)?.error ?? record(input)?.error
  return stringField(error, "Code") ?? stringField(error, "code")
}

function errorMessage(input: unknown) {
  const response = responseData(input)
  const error = record(response)?.Error ?? record(response)?.error ?? record(input)?.error
  const code = providerErrorCode(input)
  const message = stringField(error, "Message") ?? stringField(error, "message")
  const topCode = record(input)?.code
  const topMessage = stringField(input, "message")
  const requestID = stringField(response, "RequestId") ?? stringField(response, "RequestID")
  if (!code && !message && !(typeof topCode === "number" && topCode !== 0) && !topMessage) return
  if (typeof topCode === "number" && topCode === 0) return
  return [
    code ? `[${code}]` : typeof topCode === "number" ? `[${topCode}]` : undefined,
    message ?? topMessage ?? code,
    requestID ? `(RequestId: ${requestID})` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
}

function taskErrorMessage(input: unknown) {
  const response = responseData(input)
  const code = stringField(response, "ErrorCode")
  const message = stringField(response, "ErrorMessage")
  const requestID = stringField(response, "RequestId") ?? stringField(response, "RequestID")
  if (!code && !message) return errorMessage(input)
  return [code ? `[${code}]` : undefined, message ?? code, requestID ? `(RequestId: ${requestID})` : undefined]
    .filter(Boolean)
    .join(" ")
}

function jobID(input: unknown) {
  const response = responseData(input)
  const data = record(input)?.data
  return (
    stringField(response, "JobId") ??
    stringField(response, "JobID") ??
    stringField(response, "TaskId") ??
    stringField(response, "TaskID") ??
    numberJobID(data)
  )
}

/**
 * data 字段的数字型作业ID只在可被精确表示（安全整数）时才继续使用：超出 IEEE-754 安全
 * 整数范围的 JSON 数字在 JSON.parse 时已被改写，String() 打印的是另一个ID，拿去查询会
 * 命中不存在的作业并被供应商判为 JobNotFound。此时明确拒绝（不带 remote-lost 码，按
 * interrupted 处理），绝不把被四舍五入的数字当ID查询。
 */
function numberJobID(data: unknown) {
  if (typeof data === "string") return data
  if (typeof data !== "number") return undefined
  if (!Number.isSafeInteger(data))
    throw new ObjectGeneratorError({
      message: `Object generator returned a numeric job ID outside the safe integer range (${data}); refusing to query with a rounded job ID`,
    })
  return String(data)
}

function status(input: unknown) {
  return (
    stringField(responseData(input), "Status") ??
    stringField(responseData(input), "JobStatus") ??
    ""
  ).toUpperCase()
}

function isDone(input: unknown) {
  return ["DONE", "SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status(input))
}

function isFailed(input: unknown) {
  return ["FAIL", "FAILED", "ERROR", "CANCELED", "CANCELLED"].includes(status(input)) || !!taskErrorMessage(input)
}

function selectedFile(input: unknown) {
  const response = responseData(input)
  const candidates = [
    ...arrayField(response, "ResultFile3Ds"),
    ...arrayField(response, "ResultFiles"),
    ...arrayField(response, "Files"),
  ]
  const glb = candidates.find((item) => {
    const type = (stringField(item, "Type") ?? stringField(item, "Format") ?? "").toLowerCase()
    const url = stringField(item, "Url") ?? stringField(item, "URL")
    return type === "glb" || url?.split("?")[0]?.split("#")[0]?.toLowerCase().endsWith(".glb")
  })
  return glb ?? candidates[0]
}

function fileURL(input: unknown) {
  const response = responseData(input)
  const selected = selectedFile(input)
  const output = record(response)?.output
  return (
    stringField(selected, "Url") ??
    stringField(selected, "URL") ??
    stringField(response, "ModelUrl") ??
    stringField(response, "ModelURL") ??
    stringField(output, "resultUrl") ??
    stringField(output, "modelUrl")
  )
}

function thumbnailURL(input: unknown) {
  const response = responseData(input)
  const selected = selectedFile(input)
  return (
    stringField(selected, "PreviewImageUrl") ??
    stringField(selected, "PreviewImageURL") ??
    stringField(response, "ThumbnailUrl") ??
    stringField(response, "ThumbnailURL") ??
    stringField(response, "PreviewImageUrl")
  )
}

/** 本地取消错误：明确区分“本地不再等待”与“远端已停止”。 */
function cancelledLocally(jobId?: string) {
  const remote = jobId
    ? `远端作业未取消且可能仍在运行（JobId: ${jobId}）`
    : "提交结果未确认，远端作业可能已被创建并仍在运行"
  const error = new ObjectGeneratorError({ message: `本地取消：已停止等待混元生成；${remote}` })
  error.code = "GENERATION_CANCELLED_LOCAL"
  error.cancellation = {
    scope: "local",
    remoteStopRequested: false,
    remoteMayStillRun: true,
    submissionConfirmed: jobId !== undefined,
    ...(jobId ? { operationId: jobId } : {}),
  }
  return error
}

function throwIfAborted(signal: AbortSignal | undefined, jobId?: string) {
  if (signal?.aborted) throw cancelledLocally(jobId)
}

async function waitForPoll(ms: number, signal: AbortSignal | undefined, jobId?: string) {
  throwIfAborted(signal, jobId)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // 每次轮询等待都注册 abort 监听；无论计时完成还是取消，都要注销，避免长任务在 signal 上堆积监听器。
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(cancelledLocally(jobId))
    }
    const timer = setTimeout(succeed, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
  throwIfAborted(signal, jobId)
}

/** 供应商错误 → ObjectGeneratorError；“作业不存在”的业务错误额外打上自动恢复终态标识供状态机识别。 */
function requestFailure(input: unknown, fallbackMessage: string) {
  const error = new ObjectGeneratorError({ message: errorMessage(input) ?? fallbackMessage })
  if (REMOTE_JOB_LOST_PATTERN.test(providerErrorCode(input) ?? "")) error.code = REMOTE_JOB_LOST_CODE
  return error
}

async function callAPI(
  kind: RequestKind,
  payload: Record<string, unknown>,
  fetcher: typeof fetch,
  options?: GenerateMeshOptions,
) {
  const mode = authMode(options?.apiKey)
  const { host, url } = endpoint(mode === "api-key" ? (kind === "submit" ? options?.submitPath : options?.queryPath) ?? apiKeyPath(kind) : "", mode, options?.baseURL)
  const body = JSON.stringify(payload)
  const headers =
    mode === "api-key"
      ? {
          Authorization: apiKey(options?.apiKey),
          "Content-Type": "application/json",
        }
      : signedHeaders({
          host,
          body,
          timestamp: Math.floor(Date.now() / 1000),
          action: requiredEnv(kind === "submit" ? "OBJECT_GENERATOR_SUBMIT_ACTION" : "OBJECT_GENERATOR_QUERY_ACTION"),
          version: requiredEnv("OBJECT_GENERATOR_API_VERSION"),
          region: env("OBJECT_GENERATOR_API_REGION"),
        })
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body,
    signal: options?.signal,
  })
  const json = (await response.json().catch(() => undefined)) as unknown
  if (!response.ok)
    throw requestFailure(json, `Object generator request failed: ${response.status} ${response.statusText}`)
  const message = errorMessage(json)
  if (message) throw requestFailure(json, message)
  return json
}

async function inputPayload(input: CreateObjectRequest, _mode: AuthMode) {
  if (input.input.mode === "text-to-3d") {
    return {
      Prompt: input.input.prompt,
    }
  }

  const uris = Array.from(
    new Set(
      [input.input.referenceImageUri, ...(input.input.referenceImageUris ?? [])]
        .map((uri) => uri.trim())
        .filter(Boolean),
    ),
  )
  const uri = uris[0]
  if (!uri) throw new ObjectGeneratorError({ message: "referenceImageUri is required for image-to-3d generation" })
  const imagePrompt =
    env("OBJECT_GENERATOR_GENERATE_TYPE")?.toLowerCase() === "sketch" && input.input.prompt
      ? { Prompt: input.input.prompt }
      : {}

  const base64Images: string[] = []
  const imageUrls: string[] = []
  for (const ref of uris) {
    if (ref.startsWith("data:")) {
      const [, data] = ref.split(",", 2)
      if (!data) throw new ObjectGeneratorError({ message: "referenceImageUri data URL is empty" })
      base64Images.push(data)
      continue
    }

    try {
      parsePublicHttpsURL(ref, {
        label: "referenceImageUri",
        allowPrivate: allowPrivateAssetURLs(),
        allowedHosts: allowedHostsFromEnv("OBJECT_GENERATOR_REFERENCE_IMAGE_HOSTS"),
      })
      await assertPublicHttpsURL(ref, {
        label: "referenceImageUri",
        allowPrivate: allowPrivateAssetURLs(),
        allowedHosts: allowedHostsFromEnv("OBJECT_GENERATOR_REFERENCE_IMAGE_HOSTS"),
      })
      imageUrls.push(ref)
    } catch (error) {
      throw new ObjectGeneratorError({
        message: error instanceof Error ? error.message : "referenceImageUri is not allowed",
      })
    }
  }

  return {
    ...(base64Images[0] ? { ImageBase64: base64Images[0] } : {}),
    ...(imageUrls[0] && !base64Images[0] ? { ImageUrl: imageUrls[0] } : {}),
    ...(base64Images.length > 1 ? { ImagesBase64: base64Images } : {}),
    ...(imageUrls.length > 0 && uris.length > 1 ? { ImageUrls: imageUrls } : {}),
    ...(uris.length > 1 ? { ReferenceImageUris: uris } : {}),
    ...imagePrompt,
  }
}

function generationOptionsPayload(input: CreateObjectRequest) {
  const generateType = env("OBJECT_GENERATOR_GENERATE_TYPE")
  const isGeometry = generateType === "Geometry"
  const faceCount = optionalEnvInt(
    "OBJECT_GENERATOR_FACE_COUNT",
    generateType === "LowPoly" ? 100 : 3_000,
    generateType === "LowPoly" ? 1_000 : 1_500_000,
  )
  const resultFormat = env("OBJECT_GENERATOR_RESULT_FORMAT")
  const enablePBR = envBool("OBJECT_GENERATOR_ENABLE_PBR")
  return {
    ...(env("OBJECT_GENERATOR_MODEL") ? { Model: env("OBJECT_GENERATOR_MODEL") } : {}),
    ...(generateType ? { GenerateType: generateType } : {}),
    ...(faceCount ? { FaceCount: faceCount } : {}),
    ...(!isGeometry && enablePBR !== undefined ? { EnablePBR: enablePBR } : {}),
    ...(!isGeometry && env("OBJECT_GENERATOR_POLYGON_TYPE")
      ? { PolygonType: env("OBJECT_GENERATOR_POLYGON_TYPE") }
      : {}),
    ...(!isGeometry && resultFormat && resultFormat !== "GLB" ? { ResultFormat: resultFormat } : {}),
    ...(input.quality ? { Quality: input.quality, quality: input.quality } : {}),
  }
}

/** 只读配置/输入检查；图像URL只沿用既有URL安全校验，不提交任务。 */
export async function preflightGeneration(input:CreateObjectRequest,options:GenerateMeshOptions={}){
 const mode=authMode(options.apiKey),target=endpoint(mode==='api-key'?options.submitPath??apiKeyPath('submit'):'',mode,options.baseURL)
 if(mode==='api-key')apiKey(options.apiKey)
 else for(const key of ['OBJECT_GENERATOR_SECRET_ID','OBJECT_GENERATOR_SECRET_KEY','OBJECT_GENERATOR_API_SERVICE','OBJECT_GENERATOR_SUBMIT_ACTION','OBJECT_GENERATOR_QUERY_ACTION','OBJECT_GENERATOR_API_VERSION'])requiredEnv(key)
 if(!input?.input||!['text-to-3d','image-to-3d'].includes(input.input.mode)||typeof input.input.prompt!=='string'||(input.input.mode==='text-to-3d'&&!input.input.prompt.trim()))throw new ObjectGeneratorError({message:'生成模式或提示无效'})
 const request={...await inputPayload(input,mode),...generationOptionsPayload(input)}
 return {endpoint:target.url,request}
}
export async function generateMesh(input: CreateObjectRequest, options?: GenerateMeshOptions): Promise<GeneratedMesh> {
  const fetcher = options?.fetch ?? fetch
  const mode = authMode(options?.apiKey)
  let submitted: unknown
  try {
    submitted = options?.resumeJobId ? { JobId:options.resumeJobId } : await callAPI(
      "submit",
      {
        ...(options?.preparedPayload??{...await inputPayload(input,mode),...generationOptionsPayload(input)}),
      },
      fetcher,
      options,
    )
  } catch (error) {
    // 提交阶段被中断：无法确认远端是否已创建作业，报告 submissionConfirmed:false。
    if (options?.signal?.aborted) throw cancelledLocally()
    throw error
  }
  const id = jobID(submitted)
  if (!id) {
    const meshURL = fileURL(submitted)
    if (!meshURL)
      throw new ObjectGeneratorError({ message: "Object generator response did not include a job id or mesh URL" })
    return { meshURL, thumbnailURL: thumbnailURL(submitted), response: submitted }
  }

  await options?.onSubmitted?.(id)
  const pollAttempts = envInt("OBJECT_GENERATOR_POLL_ATTEMPTS", POLL_ATTEMPTS_DEFAULT, 1, 240)
  const pollIntervalMs = envInt(
    "OBJECT_GENERATOR_POLL_INTERVAL_MS",
    POLL_INTERVAL_MS_DEFAULT,
    POLL_INTERVAL_MS_MIN,
    POLL_INTERVAL_MS_MAX,
  )
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    throwIfAborted(options?.signal, id)
    let result: unknown
    try {
      result = await callAPI("query", { JobId: id }, fetcher, options)
    } catch (error) {
      // 作业ID已确认：本地取消必须报告远端作业可能仍在运行。
      if (options?.signal?.aborted) throw cancelledLocally(id)
      throw error
    }
    if (isFailed(result))
      throw new ObjectGeneratorError({ message: taskErrorMessage(result) ?? "Object generation failed" })
    if (isDone(result)) {
      const meshURL = fileURL(result)
      if (!meshURL)
        throw new ObjectGeneratorError({ message: "Completed object generation did not include a mesh URL" })
      return { meshURL, thumbnailURL: thumbnailURL(result), response: result }
    }
    await waitForPoll(pollIntervalMs, options?.signal, id)
  }
  throw new ObjectGeneratorError({ message: "Object generation did not finish before poll timeout" })
}

export function extractGeneratedMesh(value:unknown):GeneratedMesh { const meshURL=fileURL(value);if(!meshURL)throw new ObjectGeneratorError({message:"生成结果没有模型URL"});return {meshURL,thumbnailURL:thumbnailURL(value),response:value} }
