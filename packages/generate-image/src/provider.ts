/**
 * 百炼（DashScope）千问图像 3.0 的**异步**协议客户端。
 *
 * 官方文档（2026-09-20 抓取 `https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference`）：
 * 千问图像 3.0 有 OpenAI 兼容（同步）、DashScope 同步、DashScope 异步三种入口，模型能力一致。
 * 这里只实现**一种**：DashScope 异步——
 *   POST {base}/api/v1/services/aigc/image-generation/generation   （必须带 X-DashScope-Async: enable）
 *   GET  {base}/api/v1/tasks/{task_id}
 * 选它的理由不是"兼容更多"，而是本产品需要的东西只在异步口上有：远端 `task_id`（取消/恢复的锚点）、
 * 提交与结果是两次独立请求（连接不会被一次长生成占住），以及失败/排队状态可查。
 * 文档明确"本节的 Endpoint 仅受理异步请求"，所以不做"同步回落"这种第二协议。
 *
 * 请求体形状（T2I 只有 text；I2I 是 1-3 个 image + 1 个 text，见官方 curl 示例）：
 *   {model, input:{messages:[{role:"user",content:[{image|dataURL},...,{text}]}]}, parameters:{...}}
 * 参考图既支持公网 URL 也支持 Base64 data URL（`data:{mime};base64,{...}`），所以本地文件不必先上传。
 */
export const REMOTE_JOB_LOST_CODE = "GENERATION_REMOTE_JOB_LOST"

/** 取消报告：与 generate-tripo/hunyuan 同一口径——本地等待已停，远端作业可能仍在运行。 */
export type CancellationReport = {
  scope: "local"
  remoteStopRequested: false
  remoteMayStillRun: true
  /** 取消时是否已确认远端 task_id；false 表示提交结果未知（远端可能已创建任务）。 */
  submissionConfirmed: boolean
  operationId?: string
}

export class ImageError extends Error {
  code?: string
  cancellation?: CancellationReport
  constructor(input: { message: string }) {
    super(input.message)
    this.name = "ImageError"
  }
}

export interface GenerateImageInput {
  /** 正向提示词（文生图），或编辑指令（图生图）。 */
  prompt: string
  /**
   * 可选参考图，1-3 张。元素是本地文件**绝对路径**（由调用方按任务 cwd 解析后传入）或公网 http(s) URL。
   * 传了就是图生图/图像编辑；不传就是文生图。
   */
  referenceImages?: string[]
  /** 输出分辨率 `宽x高` 或 `宽*高`（官方协议用星号）；缺省由模型按提示词自选。 */
  size?: string
  /** 输出张数 1-6，缺省 1。 */
  n?: number
  negativePrompt?: string
  /** 随机种子 [0, 2147483647]；固定种子让结果相对稳定。 */
  seed?: number
  /** 提示词智能改写，官方默认 true 且建议开启。 */
  promptExtend?: boolean
  watermark?: boolean
}

export interface GenerateImageRequest {
  input: GenerateImageInput
}

export type ReferenceImageReport = {
  /** 模型给出的原始引用（本地路径或 URL）。 */
  source: string
  kind: "file" | "url"
  bytes?: number
  mediaType?: string
}

export type GeneratedImage = {
  /** 官方结果 URL（有效期 24 小时，官方文档明确）。 */
  url: string
  mediaType: string
  bytes: number
  data: Uint8Array
}

export type ImageTaskResult = {
  /**
   * 本次**实际生效**的模型：正式路由下取服务端快照（提交/查询应答的 `lyapunov.model`），
   * 开发直连下取本地配置。恢复一条没有模型信息的历史记录时是 `undefined`——**不拿当前配置顶替**。
   */
  model?: string
  /** 远端任务 ID；恢复/排查都用它。 */
  taskId?: string
  /** 官方 request_id：提交与最终查询各一个（OpenAI 兼容口不在响应体里给，只有 x-request-id 头——这是选 DashScope 的另一条实际好处）。 */
  requestIds: { submit?: string; query?: string }
  /** 官方 usage 原样透传（图片计量档位 qima_input_1k/2k、qima_output_1k/2k 等），不做换算。 */
  usage?: Record<string, unknown>
  images: GeneratedImage[]
  /** 本次实际送入模型的参考图读数。 */
  referenceImages: ReferenceImageReport[]
  /** 提交请求体（不含凭据），供本地记录与核对。 */
  request: Record<string, unknown>
}

export type ImageTaskOptions = {
  /** 已有远端 task_id：只查询，不提交。 */
  resumeTaskId?: string
  signal?: AbortSignal
  /** 提交/查询用的 fetcher。正式路由下是中央账户 fetcher（它替换掉本插件自带的一切鉴权头）。 */
  fetch?: typeof fetch
  /**
   * 结果图下载用的 fetcher。**默认是全局 fetch**：结果 URL 在供应商 CDN，不是账户服务 origin；
   * 用账户 fetcher 下载会被它的同源白名单拒绝（CENTRAL_GENERATION_ROUTE_REQUIRED），也会把账号会话带到 CDN。
   */
  downloadFetch?: typeof fetch
  /** 可信配置里的 key；模型 JSON 传不进来（plugin 显式拒绝 apiKey/baseURL）。 */
  apiKey?: string
  baseURL?: string
  model?: string
  submitPath?: string
  queryPath?: string
  pollIntervalMs?: number
  pollAttempts?: number
  /**
   * `formal`：请求经中央账户网关，密钥只在服务端，本机**不需要**供应商 key；
   * `developer`（默认）：直连供应商，必须有本地 key。两种模式不混用。
   */
  mode?: "formal" | "developer"
  /**
   * 已经做过的提交前检查结果（含已解析的参考图 Base64 与请求体）。
   * 授权弹窗确认的就是这份请求，所以提交时必须**逐字用它**，不再重新读一遍文件。
   */
  prepared?: PreparedImageRequest
  /** 已确认 task_id 后回调（把远端 ID 落盘，重启后据此恢复而不是重新提交）。 */
  onSubmitted?: (taskId: string, requestId?: string, snapshot?: { model?: string }) => Promise<void>
}

const PROMPT_MAX_REFERENCE_IMAGES = 3
const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const RESULT_IMAGE_MAX_BYTES = 64 * 1024 * 1024
const MIN_PIXELS = 512 * 512
const MAX_PIXELS = 2048 * 2048
const MAX_ASPECT = 8
const DEFAULT_MODEL = "qwen-image-3.0"
const DEFAULT_SUBMIT_PATH = "/api/v1/services/aigc/image-generation/generation"
const DEFAULT_QUERY_PATH = "/api/v1/tasks/"
const CLASSIC_BASE_URL_DEFAULT = "https://dashscope.aliyuncs.com"
const WORKSPACE_HOST_SUFFIX = ".cn-beijing.maas.aliyuncs.com"
const POLL_ATTEMPTS_DEFAULT = 200
const POLL_INTERVAL_MS_DEFAULT = 3_000
const POLL_INTERVAL_MS_MIN = 500
const POLL_INTERVAL_MS_MAX = 60_000

function env(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(env(name))
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  return Math.min(Math.max(value, min), max)
}

/**
 * **开发直连**（不经中央账户网关）时本插件从宿主环境读取的键，按下面每一处读取逐条登记：
 *   `IMAGE_API_KEY`（回落 `DASHSCOPE_API_KEY`）——凭据（`apiKey`）；
 *   `IMAGE_API_BASE_URL`——显式供应商入口（`endpoint`）；
 *   `IMAGE_WORKSPACE_ID`（回落 `TRIPO_WORKSPACE_ID`）——业务空间域名（`workspaceBaseURL`）；
 *   `IMAGE_MODEL`——模型档位（`preflightImageGeneration`）；
 *   `IMAGE_POLL_ATTEMPTS` / `IMAGE_POLL_INTERVAL_MS`——轮询（`generateImages`）。
 *
 * 装配方**只按这份清单**搬运，不整体透传父进程环境：隔离启动的开发 Host（终端、管理员 Web）
 * 照样拿到开发者显式配置的这几个值，其它变量（HOME/XDG、别的凭据）继续隔离。清单与读取处的
 * 一一对应由 `test/env-forwarding.test.ts` 看着，避免"文档里有、实际不读"或反过来的漂移。
 * **正式模式永不搬运**：那条路由经中央账户网关，供应商密钥只在服务端（见 `apiKey` 的 mode 分支）。
 */
export const IMAGE_DEVELOPER_ENV_KEYS = [
  "IMAGE_API_KEY",
  "DASHSCOPE_API_KEY",
  "IMAGE_API_BASE_URL",
  "IMAGE_WORKSPACE_ID",
  "TRIPO_WORKSPACE_ID",
  "IMAGE_MODEL",
  "IMAGE_POLL_ATTEMPTS",
  "IMAGE_POLL_INTERVAL_MS",
] as const

/**
 * 凭据只从可信配置来：显式 options.apiKey > 环境 IMAGE_API_KEY > 环境 DASHSCOPE_API_KEY（官方约定的百炼变量）。
 * 模型给出的 request_json 永远进不了这里（plugin 层拒绝 apiKey/baseURL）。
 *
 * **正式路由（mode: "formal"）不要求本机 key**：请求由中央账户网关转发，供应商密钥只在服务端；
 * 本机没有 key 不是错误，也不是"回落"到某个默认值——此时这里返回 undefined，调用方不带任何供应商鉴权头。
 */
function apiKey(value: string | undefined, mode: "formal" | "developer" | undefined) {
  const key = value ?? env("IMAGE_API_KEY") ?? env("DASHSCOPE_API_KEY")
  if (!key && mode !== "formal")
    throw new ImageError({ message: "IMAGE_API_KEY is required for image generation（回落变量：DASHSCOPE_API_KEY）" })
  return key
}

/**
 * 入口优先级：IMAGE_API_BASE_URL 显式覆盖 > IMAGE_WORKSPACE_ID 拼业务空间域名 >
 * TRIPO_WORKSPACE_ID（同一地域同一账号，generate-tripo 已有的业务空间）> 百炼经典域名。
 * 官方要求"模型、endpoint、API Key 同一地域"，所以业务空间域名固定拼北京地域后缀。
 */
function endpoint(pathname = "", overrideBaseURL?: string) {
  const baseURL = overrideBaseURL ?? env("IMAGE_API_BASE_URL") ?? workspaceBaseURL() ?? CLASSIC_BASE_URL_DEFAULT
  if (!URL.canParse(baseURL)) throw new ImageError({ message: "IMAGE_API_BASE_URL must be an absolute URL" })
  const parsed = new URL(baseURL)
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    throw new ImageError({ message: "IMAGE_API_BASE_URL must use https outside localhost" })
  if (parsed.username || parsed.password) throw new ImageError({ message: "IMAGE_API_BASE_URL must not include credentials" })
  return new URL(pathname, parsed).toString()
}

function workspaceBaseURL() {
  const workspace = env("IMAGE_WORKSPACE_ID") ?? env("TRIPO_WORKSPACE_ID")
  if (!workspace) return
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(workspace)) throw new ImageError({ message: "IMAGE_WORKSPACE_ID is invalid" })
  return `https://${workspace.toLowerCase()}${WORKSPACE_HOST_SUFFIX}`
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

/** 官方响应有两层形状：异步任务在 `output` 里，错误/提交响应在顶层。这里统一取"该看的那一层"。 */
function output(value: unknown): Record<string, unknown> | undefined {
  const outer = record(value)
  return record(outer?.output) ?? outer
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

function taskID(input: unknown) {
  return stringField(output(input), "task_id") ?? stringField(output(input), "taskId")
}

function taskStatus(input: unknown) {
  return (stringField(output(input), "task_status") ?? "").toUpperCase()
}

function requestID(input: unknown) {
  return stringField(input, "request_id") ?? stringField(output(input), "request_id")
}

/** 官方异步查询的图片位置：output.choices[].message.content[].image。 */
function imageURLs(input: unknown) {
  const urls: string[] = []
  for (const choice of arrayField(output(input), "choices")) {
    for (const block of arrayField(record(choice)?.message, "content")) {
      const url = stringField(block, "image")
      if (url) urls.push(url)
    }
  }
  return urls
}

/**
 * 中央账户网关的计费/终态块（正式路由才有）。它的 `error` 与 `model` 是**服务端**的判定：
 * 供应商原样应答里可能仍写着 SUCCEEDED，服务端判成失败（例如"成功但没出图"的 provider_result_empty）时
 * 以这个字段为准；`model` 是那次提交时服务端实际生效的模型快照，本插件不拿本地配置顶替。
 */
function lyapunovBlock(input: unknown): Record<string, unknown> | undefined {
  return record(record(input)?.lyapunov)
}

/**
 * 服务端的 `error` 代码不只是"失败"：提交结果未知与计费对账未确认也带 `error`，
 * 但那两种情况下预扣还留着、更不是"成功"，对用户说的话也完全不同。
 */
const SERVER_VERDICTS: Record<string, string> = {
  missing_remote_job_id: "中央服务没有拿到远端 task_id：这次提交结果未知（预扣保留、未结算）。同一个 requestId 不会重复提交；要重试请换新的 requestId 并由用户重新确认。",
  provider_submission_unknown: "中央服务未能确认这次提交是否已被供应商受理（预扣保留、未结算）。同一个 requestId 不会重复提交；要重试请换新的 requestId 并由用户重新确认。",
  reservation_unknown: "中央服务对这次预扣的结果未确认，已标记为需要对账（不假装已提交）。",
  settlement_unknown: "中央服务对这次结算的结果未确认，已标记为需要对账（不假装成功）。",
  release_unknown: "中央服务对这次预扣释放的结果未确认，已标记为需要对账。",
}

/** 服务端明确判定的终态 → 直接如实上抛（不再往下按供应商状态判断"这算不算成功"）。 */
function serverFailure(input: unknown) {
  const code = stringField(lyapunovBlock(input), "error")
  if (!code) return
  const verdict = SERVER_VERDICTS[code]
  return new ImageError({ message: verdict ? `[${code}] ${verdict}` : `[${code}] 中央服务判定本次图像生成失败（供应商应答可能仍写着 SUCCEEDED）` })
}

/** 服务端记录的模型快照；没有（开发直连/历史记录）就是 undefined，本插件不猜。 */
function serverModel(input: unknown) {
  return stringField(lyapunovBlock(input), "model")
}

/**
 * 本地配置的模型只在**本次真的用它提交过**时才算数。
 * 恢复一条已有远端任务的路径不做提交，因此这里恒为 undefined——绝不用当前配置给历史任务"补"一个模型名。
 */
function localModel(prepared: PreparedImageRequest | undefined) {
  return prepared?.model
}

/** 已确认 task_id 的本地取消：明确区分"本地不再等待"与"远端已停止"。 */
function cancelledLocally(taskId?: string) {
  const remote = taskId
    ? `远端任务未取消且可能仍在运行（task_id: ${taskId}）`
    : "提交结果未确认，远端任务可能已被创建并仍在运行"
  const error = new ImageError({ message: `本地取消：已停止等待图像生成；${remote}` })
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
    // 每轮等待都注册并注销 abort 监听：长任务不会在同一个 signal 上堆积监听器。
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

/** 供应商错误 → ImageError；任务不存在的明确应答额外打上自动恢复终态标识供状态机识别。 */
function requestFailure(input: unknown, fallbackMessage: string, lost = false) {
  const error = new ImageError({ message: errorMessage(input) ?? fallbackMessage })
  if (lost) error.code = REMOTE_JOB_LOST_CODE
  return error
}

function mediaTypeOf(bytes: Uint8Array, path: string) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  // 官方还收 BMP/TIFF；这两种没有做魔数分支（产品里不产出），按扩展名如实声明，其余一律拒绝。
  const extension = path.toLowerCase().split("?")[0]?.split("#")[0]?.split(".").pop()
  if (extension === "bmp") return "image/bmp"
  if (extension === "tif" || extension === "tiff") return "image/tiff"
  return undefined
}

function parseSize(size: string) {
  const match = /^(\d{1,5})\s*[*x×]\s*(\d{1,5})$/.exec(size.trim())
  if (!match) throw new ImageError({ message: `size 需要形如 1024*1024 或 1024x1024，收到「${size}」` })
  const width = Number(match[1])
  const height = Number(match[2])
  const pixels = width * height
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS)
    throw new ImageError({ message: `size 总像素需在 512*512 至 2048*2048 之间（本产品上限；百炼 API 实际允许 512*512–2560*2560＝6,553,600 px，2026-09-22 实测其报错原文），收到 ${width}*${height}` })
  const aspect = Math.max(width / height, height / width)
  if (aspect > MAX_ASPECT) throw new ImageError({ message: `size 宽高比需在 1:8 至 8:1 之间（本产品上限），收到 ${width}*${height}` })
  // 官方协议用星号；这里统一回星号格式，避免把 OpenAI 的 x 直接发过去。
  return `${width}*${height}`
}

/** 参数校验 + 请求体构造（含本地参考图读取）分开，是因为 `prepareOnly` 需要"先看一遍要花什么钱"。 */
async function referenceContent(reference: string, signal: AbortSignal | undefined) {
  const source = reference.trim()
  if (!source) throw new ImageError({ message: "referenceImages 里不能有空字符串" })
  if (URL.canParse(source) && /^https?:$/.test(new URL(source).protocol)) return { content: { image: source }, report: { source, kind: "url" as const } }
  const { readFile } = await import("node:fs/promises")
  let bytes: Buffer
  try {
    bytes = await readFile(source, { signal })
  } catch (error) {
    throw new ImageError({ message: `读不到参考图「${source}」：${error instanceof Error ? error.message : String(error)}` })
  }
  if (bytes.byteLength > REFERENCE_IMAGE_MAX_BYTES)
    throw new ImageError({ message: `参考图「${source}」超过官方 10MB 上限（${bytes.byteLength} 字节）` })
  const mediaType = mediaTypeOf(bytes, source)
  if (!mediaType)
    throw new ImageError({
      message: `参考图「${source}」不是官方支持的图像格式（JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF），按魔数与扩展名都识别不出来`,
    })
  return {
    content: { image: `data:${mediaType};base64,${bytes.toString("base64")}` },
    report: { source, kind: "file" as const, bytes: bytes.byteLength, mediaType },
  }
}

export type PreparedImageRequest = {
  endpoint: string
  request: Record<string, unknown>
  model: string
  referenceImages: ReferenceImageReport[]
}

/** 只做配置/输入检查与请求体构造，不提交任何任务。 */
export async function preflightImageGeneration(
  input: GenerateImageRequest,
  options: ImageTaskOptions = {},
): Promise<PreparedImageRequest> {
  const prompt = input?.input?.prompt
  if (typeof prompt !== "string" || !prompt.trim()) throw new ImageError({ message: "prompt 不能为空" })
  const references = input.input.referenceImages ?? []
  if (!Array.isArray(references)) throw new ImageError({ message: "referenceImages 需要字符串数组" })
  if (references.length > PROMPT_MAX_REFERENCE_IMAGES)
    throw new ImageError({ message: `参考图最多 ${PROMPT_MAX_REFERENCE_IMAGES} 张（官方限制），收到 ${references.length} 张` })
  const n = input.input.n
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 6))
    throw new ImageError({ message: `n 需要 1-6 的整数（本产品上限），收到 ${JSON.stringify(n)}` })
  const seed = input.input.seed
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647))
    throw new ImageError({ message: `seed 需要 [0, 2147483647] 的整数，收到 ${JSON.stringify(seed)}` })
  // 凭据也算"提交前检查"的一部分：缺 key 时必须在**弹窗问用户之前**就失败，
  // 而不是让用户确认一次收费提交、再拿一句"没有 key"结束（解析出的值不落记录、不进请求体）。
  // 正式路由例外：密钥在中央服务，本机没有供应商 key 是正常情况。
  apiKey(options.apiKey, options.mode)
  const model = options.model ?? env("IMAGE_MODEL") ?? DEFAULT_MODEL
  const size = input.input.size === undefined ? undefined : parseSize(input.input.size)
  const contents: Array<Record<string, unknown>> = []
  const reports: ReferenceImageReport[] = []
  for (const reference of references) {
    const built = await referenceContent(reference, options.signal)
    contents.push(built.content)
    reports.push(built.report)
  }
  contents.push({ text: prompt })
  const parameters: Record<string, unknown> = {
    ...(input.input.promptExtend !== undefined ? { prompt_extend: input.input.promptExtend } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(input.input.negativePrompt !== undefined ? { negative_prompt: input.input.negativePrompt } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(input.input.watermark !== undefined ? { watermark: input.input.watermark } : {}),
  }
  return {
    endpoint: endpoint(options.submitPath ?? DEFAULT_SUBMIT_PATH, options.baseURL),
    model,
    referenceImages: reports,
    request: {
      model,
      input: { messages: [{ role: "user", content: contents }] },
      ...(Object.keys(parameters).length ? { parameters } : {}),
    },
  }
}

async function callAPI(
  kind: "submit" | "query",
  payload: Record<string, unknown> | undefined,
  taskId: string | undefined,
  fetcher: typeof fetch,
  options: ImageTaskOptions,
) {
  const path = kind === "submit" ? (options.submitPath ?? DEFAULT_SUBMIT_PATH) : (options.queryPath ?? DEFAULT_QUERY_PATH)
  const url =
    kind === "submit"
      ? endpoint(path, options.baseURL)
      : endpoint(path.endsWith("/") ? path + encodeURIComponent(taskId ?? "") : path, options.baseURL)
  const key = apiKey(options.apiKey, options.mode)
  // 正式路由下本机没有供应商 key：不带 Authorization（中央账户 fetcher 会换成账号会话并补上服务端凭据）。
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key.replace(/^Bearer\s+/i, "")}` } : {}
  if (kind === "submit") {
    headers["Content-Type"] = "application/json"
    // 图像生成本节 Endpoint 只受理异步调用；缺这个头官方直接报 "current user api does not support synchronous calls"。
    headers["X-DashScope-Async"] = "enable"
  }
  const response = await fetcher(url, {
    method: kind === "submit" ? "POST" : "GET",
    headers,
    ...(kind === "submit" ? { body: JSON.stringify(payload ?? {}) } : {}),
    signal: options.signal,
  })
  const json = (await response.json().catch(() => undefined)) as unknown
  if (!response.ok) {
    // 查询已不存在的任务（404 或任务过期）按"作业不存在"终态处理，与 tripo/hunyuan 同口径。
    const lost = kind === "query" && response.status === 404
    throw requestFailure(json, `DashScope ${kind} failed: ${response.status} ${response.statusText}`, lost)
  }
  const message = errorMessage(json)
  if (message) throw requestFailure(json, message)
  return json
}

/** 下载官方结果 URL（24 小时有效）并在本地读一次真实像素字节；URL 过期/被清理时明确失败。 */
export async function downloadGeneratedImage(url: string, options: ImageTaskOptions = {}) {
  // 刻意不用 options.fetch：那是提交/查询用的（正式路由下是中央账户 fetcher，只放行账户同源路径，
  // 且会带上账号会话）。结果图在供应商 CDN，跨 origin，必须用普通 fetch。
  const fetcher = options.downloadFetch ?? fetch
  const response = await fetcher(url, { signal: options.signal })
  if (!response.ok) throw new ImageError({ message: `下载生成图失败：HTTP ${response.status} ${response.statusText}（官方链接 24 小时有效）` })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new ImageError({ message: "下载生成图失败：响应为空" })
  if (bytes.byteLength > RESULT_IMAGE_MAX_BYTES)
    throw new ImageError({ message: `生成图超过 ${RESULT_IMAGE_MAX_BYTES} 字节上限，拒绝落盘` })
  // 类型先按魔数判（URL 里可能没有扩展名），再看响应头；都识别不出来就如实拒绝。
  const headerType = response.headers.get("content-type")?.split(";")[0]?.trim()
  const mediaType = mediaTypeOf(bytes, url) ?? (headerType?.startsWith("image/") ? headerType : undefined)
  if (!mediaType || !mediaType.startsWith("image/"))
    throw new ImageError({ message: `生成图不是可识别的图像（content-type: ${response.headers.get("content-type") ?? "无"}）` })
  return { url, mediaType, bytes: bytes.byteLength, data: bytes }
}

export async function generateImages(input: GenerateImageRequest, options: ImageTaskOptions = {}): Promise<ImageTaskResult> {
  const fetcher = options.fetch ?? fetch
  const prepared = options.resumeTaskId ? undefined : (options.prepared ?? (await preflightImageGeneration(input, options)))
  let submitResponse: unknown
  let taskId = options.resumeTaskId
  if (!taskId) {
    try {
      submitResponse = await callAPI("submit", prepared!.request, undefined, fetcher, options)
    } catch (error) {
      // 提交阶段被中断：无法确认远端是否已创建任务，submissionConfirmed:false。
      if (options.signal?.aborted) throw cancelledLocally()
      throw error
    }
    const rejected = serverFailure(submitResponse)
    if (rejected) throw rejected
    taskId = taskID(submitResponse)
    if (!taskId) throw new ImageError({ message: "提交响应里没有 task_id（异步接口本应返回它），无法查询结果" })
    await options.onSubmitted?.(taskId, requestID(submitResponse), { model: serverModel(submitResponse) })
  }
  const pollAttempts = options.pollAttempts ?? envInt("IMAGE_POLL_ATTEMPTS", POLL_ATTEMPTS_DEFAULT, 1, 2_000)
  const pollIntervalMs = options.pollIntervalMs ?? envInt("IMAGE_POLL_INTERVAL_MS", POLL_INTERVAL_MS_DEFAULT, POLL_INTERVAL_MS_MIN, POLL_INTERVAL_MS_MAX)
  const requestIds: { submit?: string; query?: string } = { submit: submitResponse ? requestID(submitResponse) : undefined }
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    throwIfAborted(options.signal, taskId)
    let queried: unknown
    try {
      queried = await callAPI("query", undefined, taskId, fetcher, options)
    } catch (error) {
      // 任务 ID 已确认：本地取消必须报告远端任务可能仍在运行。
      if (options.signal?.aborted) throw cancelledLocally(taskId)
      throw error
    }
    requestIds.query = requestID(queried)
    // 服务端判定的失败终态优先：供应商原样应答可能仍写着 SUCCEEDED（例如"成功但一张图都没有"）。
    const rejected = serverFailure(queried)
    if (rejected) throw rejected
    const status = taskStatus(queried)
    if (status === "UNKNOWN") throw requestFailure(queried, `图像任务状态未知：${taskId}`, true)
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED")
      throw new ImageError({ message: errorMessage(queried) ?? `图像任务 ${status}` })
    if (status === "SUCCEEDED") {
      const urls = imageURLs(queried)
      // 本地这一层同样不把"没有图的 SUCCEEDED"当成功（正式路由下服务端已经先判过了）。
      if (!urls.length) throw new ImageError({ message: "任务成功但结果里没有图片 URL（output.choices[].message.content[].image）" })
      const images: GeneratedImage[] = []
      for (const url of urls) {
        throwIfAborted(options.signal, taskId)
        images.push(await downloadGeneratedImage(url, options))
      }
      return {
        // 正式路由下本地那个模型名只是请求体里的占位（服务端会覆盖），绝不能当"实际生效的模型"展示。
        model: serverModel(submitResponse) ?? serverModel(queried) ?? (options.mode === "formal" ? undefined : localModel(prepared)),
        taskId,
        requestIds,
        usage: record(output(queried)?.usage ?? record(queried)?.usage) ?? undefined,
        images,
        referenceImages: prepared?.referenceImages ?? [],
        request: prepared?.request ?? {},
      }
    }
    await waitForPoll(pollIntervalMs, options.signal, taskId)
  }
  throw new ImageError({ message: `图像任务在轮询超时前没有完成（task_id: ${taskId}，已轮询 ${pollAttempts} 次）` })
}

/**
 * 从**服务端持久化的应答**恢复一条已完成的结果（正式路由的 `lookup()` 回放）。
 * 只读应答本身：不提交、不再查询供应商，也**不要求原来的参考图文件还在**。
 */
export async function taskFromServerResponse(
  response: unknown,
  options: ImageTaskOptions = {},
): Promise<Pick<ImageTaskResult, "model" | "taskId" | "requestIds" | "usage" | "images">> {
  const rejected = serverFailure(response)
  if (rejected) throw rejected
  const urls = imageURLs(response)
  if (!urls.length) throw new ImageError({ message: "服务端回放的记录里没有图片 URL，无法恢复结果" })
  const images: GeneratedImage[] = []
  for (const url of urls) images.push(await downloadGeneratedImage(url, options))
  return {
    model: serverModel(response),
    taskId: taskID(response),
    requestIds: { query: requestID(response) },
    usage: record(output(response)?.usage ?? record(response)?.usage) ?? undefined,
    images,
  }
}
