export interface CreateObjectRequest { input: {mode:"text-to-3d"|"image-to-3d";prompt:string;referenceImageUri:string;referenceImageUris?:string[]};quality?:string;pbr?:boolean;texture?:boolean }
import { allowedHostsFromEnv, allowPrivateAssetURLs, assertPublicHttpsURL, parsePublicHttpsURL } from "../../generate-hunyuan/src/url-safety.ts"

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

export class TripoError extends Error {
  code?: string
  cancellation?: CancellationReport
  constructor(input: {message:string}) { super(input.message); this.name="TripoError" }
}

/** 跨层标识：provider 抛错时打上，operations 状态机据此把记录落为自动恢复终态 remote-lost。 */
export const REMOTE_JOB_LOST_CODE = "GENERATION_REMOTE_JOB_LOST"

export type GeneratedMesh = {
  readonly meshURL: string
  readonly thumbnailURL?: string
  readonly response: unknown
}

const POLL_ATTEMPTS_DEFAULT = 120
const POLL_INTERVAL_MS_DEFAULT = 15_000
const POLL_INTERVAL_MS_MIN = 1_000
const POLL_INTERVAL_MS_MAX = 60_000
const PROMPT_MAX_LENGTH = 1_024
const WORKSPACE_HOST_SUFFIX = ".cn-beijing.maas.aliyuncs.com"
/** 百炼经典域名：官方文档以 {WorkspaceId}.cn-beijing.maas.aliyuncs.com 为准，经典域名仍可正常使用。 */
const CLASSIC_BASE_URL_DEFAULT = "https://dashscope.aliyuncs.com"
const SUBMIT_PATH_DEFAULT = "/api/v1/services/aigc/video-generation/3d-generation"
const QUERY_PATH_DEFAULT = "/api/v1/tasks/"
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

/**
 * **开发直连**（不经中央账户网关）时本插件从宿主环境读取的键，按下面每一处读取逐条登记：
 *   `TRIPO_API_KEY`（回落 `DASHSCOPE_API_KEY`）——凭据（`apiKey`）；
 *   `TRIPO_API_BASE_URL`——显式供应商入口（`endpoint`）；
 *   `TRIPO_WORKSPACE_ID`——业务空间域名（`workspaceBaseURL`）；
 *   `TRIPO_SUBMIT_PATH` / `TRIPO_QUERY_PATH`——提交与查询路径（`requestPath`）；
 *   `TRIPO_MODEL` / `TRIPO_TEXTURE_QUALITY` / `TRIPO_GEOMETRY_QUALITY` / `TRIPO_PBR` / `TRIPO_TEXTURE`
 *     ——模型与生成档位（`generationOptionsPayload`）；
 *   `TRIPO_POLL_ATTEMPTS` / `TRIPO_POLL_INTERVAL_MS`——轮询（`pollGeneration`）；
 *   `TRIPO_REFERENCE_IMAGE_HOSTS`——参考图公共 URL 的允许主机（`publicImageURL`）；
 *   `OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS`——**经共享助手**读到的私有地址放行开关
 *     （`allowPrivateAssetURLs()`，`packages/generate-hunyuan/src/url-safety.ts:14-23`；本文件的 `publicImageURL`
 *     在 `parsePublicHttpsURL` / `assertPublicHttpsURL` 两处调用它）。
 *
 * 装配方**只按这份清单**搬运，不整体透传父进程环境：隔离启动的开发 Host（终端、管理员 Web）照样拿到
 * 开发者显式配置的这几个值，其它变量（HOME/XDG、别的凭据）继续隔离。清单与读取处的一一对应由
 * `test/env-forwarding.test.ts` 看着，避免"文档里有、实际不读"或反过来的漂移。
 * **正式模式永不搬运**：那条路由经中央账户网关，供应商密钥只在服务端（见 `apiKey` 的 mode 分支）。
 */
export const TRIPO_DEVELOPER_ENV_KEYS = [
  "TRIPO_API_KEY",
  "DASHSCOPE_API_KEY",
  "TRIPO_API_BASE_URL",
  "TRIPO_WORKSPACE_ID",
  "TRIPO_SUBMIT_PATH",
  "TRIPO_QUERY_PATH",
  "TRIPO_TEXTURE_QUALITY",
  "TRIPO_GEOMETRY_QUALITY",
  "TRIPO_PBR",
  "TRIPO_TEXTURE",
  "TRIPO_MODEL",
  "TRIPO_POLL_ATTEMPTS",
  "TRIPO_POLL_INTERVAL_MS",
  "TRIPO_REFERENCE_IMAGE_HOSTS",
  "OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS",
] as const

function env(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function requiredEnv(name: string) {
  const value = env(name)
  if (!value) throw new TripoError({ message: `${name} is required for object generation` })
  return value
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(env(name))
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  return Math.min(Math.max(value, min), max)
}

function envBool(name: string) {
  const value = env(name)?.toLowerCase()
  if (!value) return
  return ["1", "true", "yes", "on"].includes(value)
}

/** 开发直连使用 TRIPO_API_KEY，沿用百炼官方约定的 DASHSCOPE_API_KEY 作为回落。 */
function apiKey(value?: string) {
  return value ?? env("TRIPO_API_KEY") ?? env("DASHSCOPE_API_KEY") ?? requiredEnv("TRIPO_API_KEY")
}

/**
 * 入口优先级：TRIPO_API_BASE_URL 显式覆盖 > TRIPO_WORKSPACE_ID 拼业务空间域名 > 百炼经典域名。
 * 百炼 Tripo 只在北京地域提供服务：TRIPO_WORKSPACE_ID 拼出 {WorkspaceId}.cn-beijing.maas.aliyuncs.com。
 */
function endpoint(pathname = "", overrideBaseURL?: string) {
  const baseURL = overrideBaseURL ?? env("TRIPO_API_BASE_URL") ?? workspaceBaseURL() ?? CLASSIC_BASE_URL_DEFAULT
  if (!URL.canParse(baseURL)) throw new TripoError({ message: "TRIPO_API_BASE_URL must be an absolute URL" })
  const parsed = new URL(baseURL)
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new TripoError({ message: "TRIPO_API_BASE_URL must use https outside localhost" })
  if (parsed.username || parsed.password) throw new TripoError({ message: "TRIPO_API_BASE_URL must not include credentials" })
  return new URL(pathname, parsed).toString()
}

function workspaceBaseURL() {
  const workspace = env("TRIPO_WORKSPACE_ID")
  if (!workspace) return
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(workspace)) throw new TripoError({ message: "TRIPO_WORKSPACE_ID is invalid" })
  return `https://${workspace.toLowerCase()}${WORKSPACE_HOST_SUFFIX}`
}

function requestPath(kind: RequestKind, taskId?: string, options?: GenerateMeshOptions) {
  if (kind === "submit") return options?.submitPath ?? env("TRIPO_SUBMIT_PATH") ?? SUBMIT_PATH_DEFAULT
  const base = options?.queryPath ?? env("TRIPO_QUERY_PATH") ?? QUERY_PATH_DEFAULT
  return base.endsWith("/") ? base + encodeURIComponent(taskId ?? "") : base
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

function output(value: unknown) {
  return record(value)?.output ?? record(value)
}

function providerErrorCode(input: unknown) {
  return stringField(input, "code") ?? stringField(output(input), "code")
}

function errorMessage(input: unknown) {
  const code = providerErrorCode(input)
  const message = stringField(input, "message") ?? stringField(output(input), "message")
  const requestID = stringField(input, "request_id") ?? stringField(input, "requestId")
  if (!code && !message) return
  return [code ? `[${code}]` : undefined, message ?? code, requestID ? `(request_id: ${requestID})` : undefined]
    .filter(Boolean)
    .join(" ")
}

function jobID(input: unknown) {
  return stringField(output(input), "task_id") ?? stringField(output(input), "taskId")
}

function status(input: unknown) {
  return (stringField(output(input), "task_status") ?? "").toUpperCase()
}

function isDone(input: unknown) {
  return status(input) === "SUCCEEDED"
}

function isFailed(input: unknown) {
  return ["FAILED", "CANCELED", "CANCELLED"].includes(status(input))
}

/** UNKNOWN 表示供应商侧任务不存在或状态未知：与混元 JobNotFound 同口径，按自动恢复终态处理。 */
function isRemoteLost(input: unknown) {
  return status(input) === "UNKNOWN"
}

function taskFailureMessage(input: unknown) {
  return errorMessage(input) ?? `Tripo task ${status(input) || "FAILED"}`
}

function resultEntry(input: unknown) {
  const results = arrayField(output(input), "results")
  return record(results[0])
}

function fileURL(input: unknown) {
  const entry = resultEntry(input)
  return stringField(entry, "pbr_model_url") ?? stringField(entry, "base_model_url")
}

function thumbnailURL(input: unknown) {
  return stringField(resultEntry(input), "rendered_image_url")
}

/** 本地取消错误：明确区分“本地不再等待”与“远端已停止”。 */
function cancelledLocally(taskId?: string) {
  const remote = taskId
    ? `远端作业未取消且可能仍在运行（task_id: ${taskId}）`
    : "提交结果未确认，远端作业可能已被创建并仍在运行"
  const error = new TripoError({ message: `本地取消：已停止等待 Tripo 生成；${remote}` })
  error.code = "GENERATION_CANCELLED_LOCAL"
  error.cancellation = {
    scope: "local",
    remoteStopRequested: false,
    remoteMayStillRun: true,
    submissionConfirmed: taskId !== undefined,
    ...(taskId ? { operationId: taskId } : {}),
  }
  return error
}

function throwIfAborted(signal: AbortSignal | undefined, taskId?: string) {
  if (signal?.aborted) throw cancelledLocally(taskId)
}

async function waitForPoll(ms: number, signal: AbortSignal | undefined, taskId?: string) {
  throwIfAborted(signal, taskId)
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
      reject(cancelledLocally(taskId))
    }
    const timer = setTimeout(succeed, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
  throwIfAborted(signal, taskId)
}

/** 供应商错误 → TripoError；任务不存在的明确应答额外打上自动恢复终态标识供状态机识别。 */
function requestFailure(input: unknown, fallbackMessage: string, lost = false) {
  const error = new TripoError({ message: errorMessage(input) ?? fallbackMessage })
  if (lost) error.code = REMOTE_JOB_LOST_CODE
  return error
}

async function callAPI(
  kind: RequestKind,
  payload: Record<string, unknown> | undefined,
  taskId: string | undefined,
  fetcher: typeof fetch,
  options?: GenerateMeshOptions,
) {
  const url = endpoint(requestPath(kind, taskId, options), options?.baseURL)
  const key = apiKey(options?.apiKey)
  const headers: Record<string, string> = { Authorization: `Bearer ${key.replace(/^Bearer\s+/i, "")}` }
  if (kind === "submit") {
    headers["Content-Type"] = "application/json"
    // 百炼 3D 生成只支持异步调用，缺少该头会被拒绝。
    headers["X-DashScope-Async"] = "enable"
  }
  const response = await fetcher(url, {
    method: kind === "submit" ? "POST" : "GET",
    headers,
    ...(kind === "submit" ? { body: JSON.stringify(payload ?? {}) } : {}),
    signal: options?.signal,
  })
  const json = (await response.json().catch(() => undefined)) as unknown
  if (!response.ok) {
    // 查询已不存在的任务（HTTP 404 或任务过期）按“作业不存在”终态处理。
    const lost = kind === "query" && response.status === 404
    throw requestFailure(json, `Tripo request failed: ${response.status} ${response.statusText}`, lost)
  }
  const message = errorMessage(json)
  if (message) throw requestFailure(json, message)
  return json
}

async function publicImageURL(uri: string) {
  if (uri.startsWith("data:"))
    throw new TripoError({ message: "referenceImageUri data URL is not supported: Tripo requires a public image URL" })
  try {
    parsePublicHttpsURL(uri, {
      label: "referenceImageUri",
      allowPrivate: allowPrivateAssetURLs(),
      allowedHosts: allowedHostsFromEnv("TRIPO_REFERENCE_IMAGE_HOSTS"),
    })
    await assertPublicHttpsURL(uri, {
      label: "referenceImageUri",
      allowPrivate: allowPrivateAssetURLs(),
      allowedHosts: allowedHostsFromEnv("TRIPO_REFERENCE_IMAGE_HOSTS"),
    })
  } catch (error) {
    throw new TripoError({ message: error instanceof Error ? error.message : "referenceImageUri is not allowed" })
  }
  return uri
}

function imageType(uri: string) {
  const path = uri.split("?")[0]?.split("#")[0]?.toLowerCase() ?? ""
  if (path.endsWith(".png")) return "png"
  return "jpeg"
}

async function inputPayload(input: CreateObjectRequest) {
  if (input.input.mode === "text-to-3d") {
    const prompt = input.input.prompt
    if (typeof prompt !== "string" || !prompt.trim())
      throw new TripoError({ message: "prompt is required for text-to-3d generation" })
    if ([...prompt].length > PROMPT_MAX_LENGTH)
      throw new TripoError({ message: `prompt must be at most ${PROMPT_MAX_LENGTH} characters` })
    return { prompt }
  }

  const uris = Array.from(
    new Set(
      [input.input.referenceImageUri, ...(input.input.referenceImageUris ?? [])]
        .map((uri) => uri.trim())
        .filter(Boolean),
    ),
  )
  if (!uris[0]) throw new TripoError({ message: "referenceImageUri is required for image-to-3d generation" })
  const checked: string[] = []
  for (const uri of uris) checked.push(await publicImageURL(uri))
  if (checked.length === 1) return { image: checked[0] }
  if (checked.length > 4) throw new TripoError({ message: "Tripo multi-image generation accepts at most 4 reference images" })
  // 多图生 3D 的 images 固定长度 4（前、左、后、右），缺省视角补空对象。
  const images: Array<Record<string, unknown>> = checked.map((uri) => ({ type: imageType(uri), file_token: uri }))
  while (images.length < 4) images.push({})
  return { images }
}

function generationOptionsPayload(input: CreateObjectRequest) {
  const textureQuality = env("TRIPO_TEXTURE_QUALITY")
  if (textureQuality && !["standard", "detailed"].includes(textureQuality))
    throw new TripoError({ message: "TRIPO_TEXTURE_QUALITY must be standard or detailed" })
  const geometryQuality = env("TRIPO_GEOMETRY_QUALITY")
  if (geometryQuality && !["standard", "ultra"].includes(geometryQuality))
    throw new TripoError({ message: "TRIPO_GEOMETRY_QUALITY must be standard or ultra" })
  if (input.pbr !== undefined && typeof input.pbr !== "boolean")
    throw new TripoError({ message: "pbr 必须是布尔值，未提交生成任务" })
  if (input.texture !== undefined && typeof input.texture !== "boolean")
    throw new TripoError({ message: "texture 必须是布尔值，未提交生成任务" })
  const pbr = input.pbr ?? envBool("TRIPO_PBR")
  const texture = input.texture ?? envBool("TRIPO_TEXTURE")
  const quality = input.quality?.trim().toLowerCase()
  if (quality && !["standard", "detailed"].includes(quality))
    throw new TripoError({ message: "quality must be standard or detailed（对应贴图质量 texture_quality）" })
  return {
    model: env("TRIPO_MODEL") ?? "Tripo/Tripo-P1.0",
    parameters: {
      ...(quality ?? textureQuality ? { texture_quality: quality ?? textureQuality } : {}),
      ...(geometryQuality ? { geometry_quality: geometryQuality } : {}),
      ...(pbr !== undefined ? { pbr } : {}),
      ...(texture !== undefined ? { texture } : {}),
    },
  }
}

/** 只读配置/输入检查；图像URL只沿用既有URL安全校验，不提交任务。 */
export async function preflightGeneration(input:CreateObjectRequest,options:GenerateMeshOptions={}){
 const target=endpoint(requestPath('submit',undefined,options),options.baseURL)
 apiKey(options.apiKey)
 if(!input?.input||!['text-to-3d','image-to-3d'].includes(input.input.mode)||typeof input.input.prompt!=='string'||(input.input.mode==='text-to-3d'&&!input.input.prompt.trim()))throw new TripoError({message:'生成模式或提示无效'})
 const merged=generationOptionsPayload(input)
 const request={model:merged.model,input:await inputPayload(input),...(Object.keys(merged.parameters).length?{parameters:merged.parameters}:{})}
 return {endpoint:target,request}
}
export async function generateMesh(input: CreateObjectRequest, options?: GenerateMeshOptions): Promise<GeneratedMesh> {
  const fetcher = options?.fetch ?? fetch
  let submitted: unknown
  try {
    submitted = options?.resumeJobId
      ? { output: { task_id: options.resumeJobId } }
      : await callAPI(
          "submit",
          options?.preparedPayload ?? (await preflightGeneration(input, options)).request,
          undefined,
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
      throw new TripoError({ message: "Object generator response did not include a task id or mesh URL" })
    return { meshURL, thumbnailURL: thumbnailURL(submitted), response: submitted }
  }

  await options?.onSubmitted?.(id)
  const pollAttempts = envInt("TRIPO_POLL_ATTEMPTS", POLL_ATTEMPTS_DEFAULT, 1, 480)
  const pollIntervalMs = envInt(
    "TRIPO_POLL_INTERVAL_MS",
    POLL_INTERVAL_MS_DEFAULT,
    POLL_INTERVAL_MS_MIN,
    POLL_INTERVAL_MS_MAX,
  )
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    throwIfAborted(options?.signal, id)
    let result: unknown
    try {
      result = await callAPI("query", undefined, id, fetcher, options)
    } catch (error) {
      // 作业ID已确认：本地取消必须报告远端作业可能仍在运行。
      if (options?.signal?.aborted) throw cancelledLocally(id)
      throw error
    }
    if (isRemoteLost(result))
      throw requestFailure(result, taskFailureMessage(result), true)
    if (isFailed(result)) throw new TripoError({ message: taskFailureMessage(result) })
    if (isDone(result)) {
      const meshURL = fileURL(result)
      if (!meshURL)
        throw new TripoError({ message: "Completed object generation did not include a mesh URL" })
      return { meshURL, thumbnailURL: thumbnailURL(result), response: result }
    }
    await waitForPoll(pollIntervalMs, options?.signal, id)
  }
  throw new TripoError({ message: "Object generation did not finish before poll timeout" })
}

export function extractGeneratedMesh(value:unknown):GeneratedMesh { const meshURL=fileURL(value);if(!meshURL)throw new TripoError({message:"生成结果没有模型URL"});return {meshURL,thumbnailURL:thumbnailURL(value),response:value} }
