
/**
 * 取消报告：本地等待已停止，但供应商 API 没有远端取消能力（或未请求远端取消），
 * 因此远端作业可能仍在运行。调用方必须据此决定是恢复查询还是人工处理。
 */
export type CancellationReport = {
  scope: "local"
  remoteStopRequested: false
  remoteMayStillRun: true
  /** 取消发生时是否已确认供应商 operation ID；false 表示提交结果未知（远端可能已创建作业）。 */
  submissionConfirmed: boolean
  operationId?: string
}

export class MarbleError extends Error {
  code?: string
  cancellation?: CancellationReport
  constructor(input: {message:string}) { super(input.message); this.name="MarbleError" }
}

export type GenerateInput = {
  prompt: string
  resumeOperationId?: string
  title?: string
  model?: string
  quality?: "low" | "medium" | "high" | "max"
  referenceImageUris?: string[]
  apiKey?: string
  baseURL?: string
  centralAccount?: boolean
  pollIntervalMs?: number
  pollAttempts?: number
  submitTimeoutMs?: number
  pollRequestTimeoutMs?: number
  mediaRequestTimeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: OperationProgress) => void | Promise<void>
  fetch?: typeof fetch
}

export type OperationProgress = {
  stage?: "connecting" | "submitted" | "polling" | "downloading" | "completed"
  operationID?: string
  worldID?: string
  status?: string
  description?: string
  percent?: number
  done?: boolean
  attempt?: number
  totalAttempts?: number
  updatedAt?: string
}

type ImagePrompt =
  | {
      source: "uri"
      uri: string
    }
  | {
      source: "media_asset"
      media_asset_id: string
    }

export type WorldAsset = {
  operationID?: string
  worldID?: string
  model?: string
  spzURL: string
  resolution?: string
  /** Scene mesh GLB URL, if Marble returned one (P6-4). */
  meshURL?: string
  worldURL?: string
  thumbnailURL?: string
  panoURL?: string
  caption?: string
  coordinateSystem?: string
}

export const provider = {
  id: "worldlabs-marble",
  name: "World Labs Marble",
  description: "World Labs world model provider for text, image, multi-image, and video to 3DGS generation.",
  models: [
    {
      id: "marble-1.1-plus",
      name: "Marble 1.1 Plus",
      description: "Highest-capacity world generation with dynamic world sizing for larger spaces.",
      tags: ["best", "large-world", "variable-cost"],
    },
    {
      id: "marble-1.1",
      name: "Marble 1.1",
      description: "Recommended standard Marble world model with improved quality at fixed cost.",
      default: true,
      tags: ["recommended", "fixed-cost"],
    },
    {
      id: "marble-1.0",
      name: "Marble 1.0",
      description: "Legacy standard model retained for existing explorations.",
      tags: ["legacy", "fixed-cost"],
    },
    {
      id: "marble-1.0-draft",
      name: "Marble 1.0 Draft",
      description: "Fast draft model for prompt iteration and cheap previews.",
      tags: ["draft", "fast"],
    },
  ],
} as const

const POLL_ATTEMPTS_DEFAULT = 180
const POLL_ATTEMPTS_MAX = 240
const POLL_INTERVAL_MS_DEFAULT = 5_000
const POLL_INTERVAL_MS_MIN = 250
const POLL_INTERVAL_MS_MAX = 30_000
const REQUEST_TIMEOUT_MS_MIN = 10
const REQUEST_TIMEOUT_MS_MAX = 5 * 60_000
const SUBMIT_TIMEOUT_MS_DEFAULT = 30_000
const POLL_REQUEST_TIMEOUT_MS_DEFAULT = 30_000
const MEDIA_REQUEST_TIMEOUT_MS_DEFAULT = 60_000
const ALLOWED_MODELS = provider.models.map((model) => model.id)
const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024
const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}
const DISPLAY_NAME_MAX_LENGTH = 64

/**
 * **开发直连**（不经中央账户网关）时本插件从宿主环境读取的键，按下面每一处读取逐条登记：
 *   `WORLDLABS_API_KEY`——凭据（`generateWorld` / `extractWorldAsset`，`process.env` 直读）；
 *   `WORLDLABS_MODEL`——模型档位（`defaultModel`，`process.env` 直读）；
 *   `WORLDLABS_API_BASE_URL`——显式供应商入口（`configuredBaseURL`，`process.env` 直读）；
 *   `WORLDLABS_POLL_ATTEMPTS` / `WORLDLABS_POLL_INTERVAL_MS`——轮询（`pollGeneration` 的 `envInt` 首参字面量）；
 *   `WORLDLABS_SUBMIT_TIMEOUT_MS` / `WORLDLABS_POLL_REQUEST_TIMEOUT_MS` / `WORLDLABS_MEDIA_REQUEST_TIMEOUT_MS`
 *     ——各请求超时（`requestTimeout(…, envKey, …)` → `envInt(envKey)`，经包装器取名，不是首参字面量）。
 *
 * **本包不经共享助手读任何 `OBJECT_GENERATOR_*`**（`generate-hunyuan/src/url-safety.ts` 的共享助手只被
 * `generate-hunyuan` 与 `generate-tripo` 复用，`generate-marble` 无 `url-safety` 引入），故清单只含 `WORLDLABS_*`。
 *
 * 装配方**只按这份清单**搬运，不整体透传父进程环境：隔离启动的开发 Host（终端、管理员 Web）照样拿到开发者
 * 显式配置的这几个值，其它变量（HOME/XDG、别的凭据）继续隔离。清单与读取处的一一对应由
 * `test/env-forwarding.test.ts` 看着（机械扫：直接从 `process.env` 取名 + `envInt` 首参字面量，再逐条登记
 * `requestTimeout` 经包装器取名的间接项），避免"文档里有、实际不读"或反过来的漂移。
 * **正式模式永不搬运**：那条路由经中央账户网关，供应商密钥只在服务端。
 */
export const MARBLE_DEVELOPER_ENV_KEYS = [
  // 凭据与入口
  "WORLDLABS_API_KEY",
  "WORLDLABS_MODEL",
  "WORLDLABS_API_BASE_URL",
  // 轮询
  "WORLDLABS_POLL_ATTEMPTS",
  "WORLDLABS_POLL_INTERVAL_MS",
  // 各请求超时
  "WORLDLABS_SUBMIT_TIMEOUT_MS",
  "WORLDLABS_POLL_REQUEST_TIMEOUT_MS",
  "WORLDLABS_MEDIA_REQUEST_TIMEOUT_MS",
] as const

export function defaultModel() {
  return process.env.WORLDLABS_MODEL ?? "marble-1.1"
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  const integer = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(integer, min), max)
}

function envInt(key: string) {
  const value = process.env[key]
  if (!value) return
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return
  return parsed
}

function requestTimeout(value: number | undefined, envKey: string, fallback: number) {
  return clampInt(value ?? envInt(envKey), fallback, REQUEST_TIMEOUT_MS_MIN, REQUEST_TIMEOUT_MS_MAX)
}

function displayName(input: string | undefined, fallback: string) {
  const clean = (input ?? fallback).replace(/\s+/g, " ").trim() || fallback
  return Array.from(clean).slice(0, DISPLAY_NAME_MAX_LENGTH).join("")
}

function modelID(value: string | undefined) {
  const model = value ?? defaultModel()
  if (ALLOWED_MODELS.includes(model as (typeof ALLOWED_MODELS)[number])) return model
  throw new MarbleError({
    message: `Unsupported World Labs Marble model "${model}". Allowed models: ${ALLOWED_MODELS.join(", ")}`,
  })
}

function baseURLIssue(input: string) {
  if (!URL.canParse(input)) return "WORLDLABS_API_BASE_URL must be an absolute URL"
  const parsed = new URL(input)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)))
    return "WORLDLABS_API_BASE_URL must use https outside localhost"
  if (parsed.username || parsed.password) return "WORLDLABS_API_BASE_URL must not include credentials"
}

function configuredBaseURL(override?: string) {
  const input = override ?? process.env.WORLDLABS_API_BASE_URL ?? "https://api.worldlabs.ai"
  const issue = baseURLIssue(input)
  if (issue) throw new MarbleError({ message: issue })
  return input.replace(/\/$/, "")
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

function recordField(value: unknown, key: string) {
  return record(record(value)?.[key])
}

function boolField(value: unknown, key: string) {
  const item = record(value)?.[key]
  if (typeof item !== "boolean") return
  return item
}

function numberField(value: unknown, key: string) {
  const item = record(value)?.[key]
  if (typeof item === "number" && Number.isFinite(item)) return item
  if (typeof item !== "string") return
  const parsed = Number(item)
  if (Number.isFinite(parsed)) return parsed
}

function firstString(input: unknown) {
  if (typeof input === "string" && input.length > 0) return input
  if (!Array.isArray(input)) return
  return input.find((item): item is string => typeof item === "string" && item.length > 0)
}

function firstURL(input: unknown) {
  return firstString(input) ?? (record(input) ? firstString(Object.values(record(input)!)) : undefined)
}

function firstMessage(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim()
  if (Array.isArray(input)) return input.map(firstMessage).find((item): item is string => !!item)
  const value = record(input)
  if (!value) return
  const direct =
    firstString(value.message) ??
    firstString(value.detail) ??
    firstString(value.description) ??
    firstString(value.reason) ??
    firstString(value.code)
  if (direct) return direct
  return ["error", "errors", "metadata", "progress", "response", "data", "details"]
    .map((key) => firstMessage(value[key]))
    .find((item): item is string => !!item)
}

function responseErrorMessage(input: unknown) {
  const message = firstMessage(input)
  if (!message) return
  return message.length > 800 ? message.slice(0, 797) + "..." : message
}

function redactedProviderMessage(input: string, sensitiveValues: readonly string[] = []) {
  let value = input
  for (const secret of sensitiveValues) {
    if (!secret) continue
    value = value.split(secret).join("[redacted]")
  }
  return value
    .replace(/(WLT-Api-Key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]")
}

function findURL(input: unknown, suffix: string): string | undefined {
  if (typeof input === "string") return input.includes(suffix) ? input : undefined
  if (Array.isArray(input)) {
    return input.map((item) => findURL(item, suffix)).find((item): item is string => !!item)
  }
  const value = record(input)
  if (!value) return
  return Object.values(value)
    .map((item) => findURL(item, suffix))
    .find((item): item is string => !!item)
}

function normalizeWorld(input: unknown): Record<string, unknown> {
  const value = record(input) ?? {}
  return recordField(value, "world") ?? recordField(value, "result") ?? recordField(value, "response") ?? value
}

function extractSpz(world: Record<string, unknown>) {
  const splats = recordField(recordField(world, "assets"), "splats")
  const spzURLs = recordField(splats, "spz_urls") ?? recordField(splats, "spzUrls")
  const ordered = ["500k", "100k", "full_res", "full", "2m", "1m"]
    .map((key) => firstString(spzURLs?.[key]))
    .find((item): item is string => !!item)
  if (ordered)
    return {
      url: ordered,
      resolution: Object.entries(spzURLs ?? {}).find(([, value]) => firstString(value) === ordered)?.[0],
    }

  const nested = firstURL(spzURLs) ?? findURL(splats, ".spz") ?? findURL(world, ".spz")
  if (!nested) return
  return {
    url: nested,
    resolution: Object.entries(spzURLs ?? {}).find(([, value]) => firstString(value) === nested)?.[0],
  }
}

/**
 * Best-effort scene mesh GLB URL from the Marble response (P6-4). Marble's mesh
 * field is undocumented here, so this recursively searches for any `.glb` URL —
 * thumbnails / panos are `.jpg`/`.png`, so they are never matched. Returns
 * undefined when the provider gives no mesh.
 */
function extractMesh(world: Record<string, unknown>): string | undefined {
  const mesh = recordField(recordField(world, "assets"), "mesh")
  return (
    stringField(mesh, "collider_mesh_url") ??
    stringField(mesh, "colliderMeshUrl") ??
    stringField(mesh, "mesh_url") ??
    stringField(mesh, "meshUrl") ??
    findURL(world, ".glb")
  )
}

export function extractWorldAsset(input: unknown, operationID?: string): WorldAsset {
  const world = normalizeWorld(input)
  const spz = extractSpz(world)
  if (!spz) {
    throw new MarbleError({ message: "World Labs Marble response did not include assets.splats.spz_urls" })
  }
  const assets = recordField(world, "assets")
  const imagery = recordField(assets, "imagery")
  const pano = recordField(assets, "pano") ?? recordField(assets, "panorama") ?? imagery
  return {
    operationID: operationID ?? stringField(input, "operation_id") ?? stringField(input, "operationID"),
    worldID: stringField(world, "id") ?? stringField(world, "world_id") ?? stringField(world, "worldID"),
    model: stringField(world, "model"),
    spzURL: spz.url,
    resolution: spz.resolution,
    meshURL: extractMesh(world),
    worldURL:
      stringField(world, "world_marble_url") ??
      stringField(world, "url") ??
      stringField(world, "web_url") ??
      stringField(world, "webURL"),
    thumbnailURL:
      stringField(assets, "thumbnail_url") ??
      stringField(world, "thumbnail_url") ??
      stringField(world, "thumbnailURL") ??
      firstURL(recordField(assets, "thumbnail")),
    panoURL:
      stringField(imagery, "pano_url") ??
      stringField(world, "pano_url") ??
      stringField(world, "panoURL") ??
      firstURL(pano) ??
      findURL(recordField(assets, "pano"), ".jpg") ??
      findURL(recordField(assets, "pano"), ".png"),
    caption: stringField(assets, "caption") ?? stringField(world, "caption") ?? stringField(world, "display_name"),
    coordinateSystem:
      "World Labs Marble .spz loaded as Spark Gaussian splat; axis/unit normalization is deferred to viewer controls.",
  }
}

function operationID(input: unknown) {
  return (
    stringField(input, "operation_id") ??
    stringField(input, "operationID") ??
    stringField(input, "id") ??
    stringField(recordField(input, "operation"), "id")
  )
}

function statusURL(input: unknown, baseURL: string, id: string) {
  const parsed = new URL(
    stringField(input, "status_url") ?? stringField(input, "statusURL") ?? `/marble/v1/operations/${id}`,
    baseURL,
  )
  const base = new URL(baseURL)
  if (parsed.origin !== base.origin || parsed.username || parsed.password) {
    throw new MarbleError({ message: "World Labs Marble status URL must stay on WORLDLABS_API_BASE_URL origin" })
  }
  return parsed.toString()
}

function progressPercent(...values: Array<number | undefined>) {
  const value = values.find((item): item is number => typeof item === "number" && Number.isFinite(item))
  if (value === undefined) return
  const normalized = value <= 1 && value >= 0 ? value * 100 : value
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

function operationDone(input: unknown) {
  const done = boolField(input, "done")
  if (done !== undefined) return done
  const status = (stringField(input, "status") ?? "").toLowerCase()
  const state = (stringField(input, "state") ?? "").toLowerCase()
  const progress = (stringField(recordField(recordField(input, "metadata"), "progress"), "status") ?? "").toLowerCase()
  return (
    ["done", "succeeded", "complete", "completed"].includes(status) ||
    ["done", "succeeded", "complete", "completed"].includes(state) ||
    ["succeeded", "completed"].includes(progress)
  )
}

function operationProgress(input: unknown, id: string, attempt: number, totalAttempts: number): OperationProgress {
  const metadata = recordField(input, "metadata")
  const progress = recordField(metadata, "progress") ?? recordField(input, "progress") ?? {}
  return {
    stage: operationDone(input) ? "completed" : "polling",
    operationID: id,
    worldID: stringField(metadata, "world_id") ?? stringField(metadata, "worldID") ?? stringField(input, "world_id"),
    status:
      stringField(progress, "status") ??
      stringField(input, "status") ??
      stringField(input, "state") ??
      (operationDone(input) ? "COMPLETED" : undefined),
    description:
      stringField(progress, "description") ??
      stringField(progress, "message") ??
      stringField(metadata, "description") ??
      stringField(input, "description"),
    percent: progressPercent(
      numberField(progress, "percent"),
      numberField(progress, "percentage"),
      numberField(progress, "progress"),
      numberField(progress, "progress_percent"),
      numberField(progress, "progressPercentage"),
      numberField(progress, "percent_done"),
      numberField(progress, "percentDone"),
      numberField(metadata, "percent"),
      numberField(metadata, "percentage"),
      numberField(metadata, "progress_percent"),
      numberField(metadata, "percent_done"),
      numberField(metadata, "percentDone"),
    ),
    done: operationDone(input),
    attempt,
    totalAttempts,
    updatedAt: stringField(input, "updated_at") ?? stringField(input, "updatedAt"),
  }
}

function operationFailed(input: unknown) {
  const status = (stringField(input, "status") ?? "").toLowerCase()
  const state = (stringField(input, "state") ?? "").toLowerCase()
  const progress = (stringField(recordField(recordField(input, "metadata"), "progress"), "status") ?? "").toLowerCase()
  return (
    !!firstMessage(record(input)?.error) ||
    ["failed", "error", "cancelled", "canceled"].includes(status) ||
    ["failed", "error", "cancelled", "canceled"].includes(state) ||
    ["failed", "error", "cancelled", "canceled"].includes(progress)
  )
}

async function withDeadline<T>(input: {
  signal?: AbortSignal
  timeoutMs: number
  timeoutMessage: string
  /** 取消报告要携带的供应商 operation ID；提交确认前未知，省略即报告 submissionConfirmed:false。 */
  operationID?: string
  run: (signal: AbortSignal) => Promise<T>
}) {
  throwIfAborted(input.signal, input.operationID)
  const controller = new AbortController()
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
    }
    const succeed = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      controller.abort()
      fail(abortError(input.operationID))
    }
    const timer = setTimeout(() => {
      controller.abort()
      fail(new MarbleError({ message: input.timeoutMessage }))
    }, input.timeoutMs)
    input.signal?.addEventListener("abort", onAbort, { once: true })
    void input.run(controller.signal).then(succeed, (error) => {
      if (input.signal?.aborted) return fail(abortError(input.operationID))
      fail(error)
    })
  })
}

async function json(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  deadline: {
    signal?: AbortSignal
    timeoutMs: number
    timeoutMessage: string
    failureMessage: string
    sensitiveValues?: readonly string[]
    operationID?: string
  },
) {
  let response: Response
  let text: string
  try {
    ;[response, text] = await withDeadline({
      signal: deadline.signal,
      timeoutMs: deadline.timeoutMs,
      timeoutMessage: deadline.timeoutMessage,
      operationID: deadline.operationID,
      run: async (signal) => {
        const result = await fetcher(url, { ...init, signal })
        return [result, await result.text()] as const
      },
    })
  } catch (error) {
    if (error instanceof MarbleError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new MarbleError({
      message: [deadline.failureMessage, redactedProviderMessage(detail, deadline.sensitiveValues)]
        .filter(Boolean)
        .join(": "),
    })
  }
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
    : undefined
  if (!response.ok) {
    const rawMessage = responseErrorMessage(parsed) ?? (text.trim() ? text.trim() : undefined)
    const message = rawMessage ? redactedProviderMessage(rawMessage, deadline.sensitiveValues) : undefined
    throw new MarbleError({
      message: [`World Labs Marble request failed: ${response.status} ${response.statusText}`, message]
        .filter(Boolean)
        .join(": "),
    })
  }
  return parsed ?? {}
}

function abortError(operationID?: string) {
  const remote = operationID
    ? `远端作业未取消且可能仍在运行（operation ID: ${operationID}）`
    : "提交结果未确认，远端作业可能已被创建并仍在运行"
  const error = new MarbleError({ message: `本地取消：已停止等待 Marble 生成；${remote}` })
  error.code = "GENERATION_CANCELLED_LOCAL"
  error.cancellation = {
    scope: "local",
    remoteStopRequested: false,
    remoteMayStillRun: true,
    submissionConfirmed: operationID !== undefined,
    ...(operationID ? { operationId: operationID } : {}),
  }
  return error
}

function throwIfAborted(signal: AbortSignal | undefined, operationID?: string) {
  if (signal?.aborted) throw abortError(operationID)
}

async function waitForPoll(ms: number, signal: AbortSignal | undefined, operationID?: string) {
  throwIfAborted(signal, operationID)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // 每次轮询等待都注册 abort 监听；无论计时完成还是取消，都要注销，避免长任务在 signal 上堆积监听器。
    const cleanup = () => {
      clearTimeout(timeout)
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
      reject(abortError(operationID))
    }
    const timeout = setTimeout(succeed, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
  throwIfAborted(signal, operationID)
}

function parseDataURL(input: string) {
  const match = input.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
  if (!match) return
  const mime = (match[1] ?? "").toLowerCase()
  const extension = IMAGE_MIME_TO_EXTENSION[mime]
  if (!extension) {
    throw new MarbleError({
      message: `World Labs Marble reference image must be jpg, png, or webp; got ${mime || "unknown"}`,
    })
  }
  const body = match[3] ?? ""
  const bytes = match[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body))
  if (bytes.byteLength === 0) throw new MarbleError({ message: "World Labs Marble reference image is empty" })
  if (bytes.byteLength > IMAGE_SIZE_LIMIT) {
    throw new MarbleError({ message: "World Labs Marble reference image must be 20 MB or smaller" })
  }
  return { mime, extension, bytes }
}

function uploadInfo(input: unknown) {
  const media = recordField(input, "media_asset")
  const upload = recordField(input, "upload_info")
  const id = stringField(media, "id") ?? stringField(media, "media_asset_id") ?? stringField(input, "media_asset_id")
  const uploadURL = stringField(upload, "upload_url") ?? stringField(upload, "uploadURL")
  const uploadMethod = stringField(upload, "upload_method") ?? stringField(upload, "uploadMethod") ?? "PUT"
  const rawHeaders = recordField(upload, "required_headers") ?? {}
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  if (!id || !uploadURL) {
    throw new MarbleError({ message: "World Labs Marble media upload response was missing upload information" })
  }
  return { id, uploadURL, uploadMethod, headers }
}

async function uploadImageAsset(input: {
  baseURL: string
  fetcher: typeof fetch
  key: string
  index: number
  image: ReturnType<typeof parseDataURL>
  signal?: AbortSignal
  timeoutMs: number
}) {
  if (!input.image) throw new MarbleError({ message: "World Labs Marble reference image is invalid" })
  const image = input.image
  throwIfAborted(input.signal)
  const prepared = await json(
    input.fetcher,
    `${input.baseURL}/marble/v1/media-assets:prepare_upload`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "WLT-Api-Key": input.key,
      },
      body: JSON.stringify({
        file_name: `reference-${input.index + 1}.${image.extension}`,
        kind: "image",
        extension: image.extension,
      }),
    },
    {
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      timeoutMessage: "未能提交 Marble 参考图：准备上传超时",
      failureMessage: "未能提交 Marble 参考图",
      sensitiveValues: [input.key],
    },
  )
  const upload = uploadInfo(prepared)
  const headers: Record<string, string> = { ...upload.headers }
  // 错误响应体的读取必须和响应头同处一个媒体 deadline/取消生命周期：
  // 若在 withDeadline 之后才读，非 2xx 后拖住/不发响应体的上传错误既不受超时也不受取消约束。
  const { response, errorText } = await withDeadline({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    timeoutMessage: "未能提交 Marble 参考图：上传超时",
    run: async (signal) => {
      const response = await input.fetcher(upload.uploadURL, {
        method: upload.uploadMethod,
        headers,
        body: image.bytes,
        signal,
      })
      // 完整的错误体照旧读出；读取本身失败（含超时/取消中止）仍按空体处理。
      const errorText = response.ok ? "" : await response.text().catch(() => "")
      return { response, errorText }
    },
  })
  if (!response.ok) {
    throw new MarbleError({
      message: [
        `World Labs Marble media upload failed: ${response.status} ${response.statusText}`,
        errorText.trim() || undefined,
      ]
        .filter(Boolean)
        .join(": "),
    })
  }
  return {
    source: "media_asset",
    media_asset_id: upload.id,
  } satisfies ImagePrompt
}

async function imagePrompt(input: {
  baseURL: string
  fetcher: typeof fetch
  key: string
  uri: string
  index: number
  signal?: AbortSignal
  timeoutMs: number
}): Promise<ImagePrompt> {
  if (input.uri.startsWith("data:")) {
    return uploadImageAsset({
      baseURL: input.baseURL,
      fetcher: input.fetcher,
      key: input.key,
      index: input.index,
      image: parseDataURL(input.uri),
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    })
  }
  if (!URL.canParse(input.uri)) {
    throw new MarbleError({ message: "World Labs Marble reference image URL is invalid" })
  }
  const parsed = new URL(input.uri)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new MarbleError({ message: "World Labs Marble reference image URL must use http or https" })
  }
  return {
    source: "uri",
    uri: input.uri,
  }
}

function multiImageAzimuth(index: number, total: number) {
  if (total <= 1) return 0
  return Math.round((360 / total) * index) % 360
}

/** 只读提交前检查，不上传图像、不创建供应商任务。 */
export function preflightGeneration(input:GenerateInput){
  const key=(input.apiKey??process.env.WORLDLABS_API_KEY)?.trim();if(!key)throw new MarbleError({message:'WORLDLABS_API_KEY is required for scene generate'})
  const baseURL=configuredBaseURL(input.baseURL),model=modelID(input.model),references=input.referenceImageUris?.map(uri=>uri.trim()).filter(Boolean)??[]
  if(typeof input.prompt!=='string'||(!input.prompt.trim()&&!references.length))throw new MarbleError({message:'生成需要文字提示或参考图像'})
  for(const uri of references){if(uri.startsWith('data:')){if(!parseDataURL(uri))throw new MarbleError({message:'参考图像data URL无效'})}else if(!URL.canParse(uri)||!['http:','https:'].includes(new URL(uri).protocol))throw new MarbleError({message:'参考图像URL无效'})}
  return {endpoint:baseURL,request:{prompt:input.prompt,title:displayName(input.title,input.prompt),model,quality:input.quality,referenceImageUris:references}}
}
export async function generateWorld(input: GenerateInput): Promise<WorldAsset> {
  const key = (input.apiKey ?? process.env.WORLDLABS_API_KEY)?.trim()
  if (!key) throw new MarbleError({ message: "WORLDLABS_API_KEY is required for scene generate" })

  const baseURL = configuredBaseURL(input.baseURL)
  const fetcher = input.fetch ?? fetch
  const model = modelID(input.model)
  const submitTimeoutMs = requestTimeout(
    input.submitTimeoutMs,
    "WORLDLABS_SUBMIT_TIMEOUT_MS",
    SUBMIT_TIMEOUT_MS_DEFAULT,
  )
  const pollRequestTimeoutMs = requestTimeout(
    input.pollRequestTimeoutMs,
    "WORLDLABS_POLL_REQUEST_TIMEOUT_MS",
    POLL_REQUEST_TIMEOUT_MS_DEFAULT,
  )
  const mediaRequestTimeoutMs = requestTimeout(
    input.mediaRequestTimeoutMs,
    "WORLDLABS_MEDIA_REQUEST_TIMEOUT_MS",
    MEDIA_REQUEST_TIMEOUT_MS_DEFAULT,
  )
  const referenceImageUris = input.resumeOperationId ? [] : input.referenceImageUris?.map((uri) => uri.trim()).filter(Boolean) ?? []
  const imagePrompts = await Promise.all(
    referenceImageUris.map((uri, index) =>
      imagePrompt({ baseURL, fetcher, key, uri, index, signal: input.signal, timeoutMs: mediaRequestTimeoutMs }),
    ),
  )
  const worldPrompt = referenceImageUris.length
    ? imagePrompts.length === 1
      ? {
          type: "image",
          image_prompt: imagePrompts[0],
          text_prompt: input.prompt,
        }
      : {
          type: "multi-image",
          multi_image_prompt: imagePrompts.map((content, index) => ({
            azimuth: multiImageAzimuth(index, imagePrompts.length),
            content,
          })),
          text_prompt: input.prompt,
        }
    : {
        type: "text",
        text_prompt: input.prompt,
      }
  await input.onProgress?.({
    stage: "connecting",
    status: "CONNECTING",
    description: "正在连接 Marble 生成服务",
    done: false,
    attempt: 0,
  })
  const submit = input.resumeOperationId ? { operation_id: input.resumeOperationId } : await json(
    fetcher,
    `${baseURL}/marble/v1/worlds:generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "WLT-Api-Key": key,
      },
      body: JSON.stringify({
        display_name: displayName(input.title, input.prompt),
        model,
        world_prompt: worldPrompt,
        ...(input.quality ? { quality: input.quality } : {}),
      }),
    },
    {
      signal: input.signal,
      timeoutMs: submitTimeoutMs,
      timeoutMessage: `未能提交到 Marble：连接生成服务超过 ${submitTimeoutMs}ms`,
      failureMessage: "未能提交到 Marble",
      sensitiveValues: [key],
    },
  )
  const id = operationID(submit)
  if (!id) return extractWorldAsset(submit)
  await input.onProgress?.({
    stage: "submitted",
    operationID: id,
    status: "SUBMITTED",
    description: `已提交到 Marble · operation ID: ${id}`,
    percent: 0,
    done: false,
    attempt: 0,
  })

  const url = input.centralAccount ? `${baseURL}/marble/v1/operations/${encodeURIComponent(id)}` : statusURL(submit, baseURL, id)
  const pollAttempts = clampInt(
    input.pollAttempts ?? envInt("WORLDLABS_POLL_ATTEMPTS"),
    POLL_ATTEMPTS_DEFAULT,
    1,
    POLL_ATTEMPTS_MAX,
  )
  const pollIntervalMs = clampInt(
    input.pollIntervalMs ?? envInt("WORLDLABS_POLL_INTERVAL_MS"),
    POLL_INTERVAL_MS_DEFAULT,
    POLL_INTERVAL_MS_MIN,
    POLL_INTERVAL_MS_MAX,
  )
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    throwIfAborted(input.signal, id)
    const operation = await json(
      fetcher,
      url,
      {
        headers: {
          "WLT-Api-Key": key,
        },
      },
      {
        signal: input.signal,
        timeoutMs: pollRequestTimeoutMs,
        timeoutMessage: `查询 Marble 状态超时（operation ID: ${id}）`,
        failureMessage: `查询 Marble 状态失败（operation ID: ${id}）`,
        sensitiveValues: [key],
        operationID: id,
      },
    )
    const progress = operationProgress(operation, id, attempt + 1, pollAttempts)
    await input.onProgress?.(progress)
    if (operationFailed(operation)) {
      const message = responseErrorMessage(
        recordField(operation, "error") ?? recordField(operation, "metadata") ?? operation,
      )
      throw new MarbleError({
        message: ["World Labs Marble generation failed", message].filter(Boolean).join(": "),
      })
    }
    if (operationDone(operation)) {
      await input.onProgress?.({
        ...progress,
        stage: "completed",
        status: progress.status ?? "COMPLETED",
        percent: 100,
        done: true,
      })
      return extractWorldAsset(recordField(operation, "response") ?? operation, id)
    }
    await waitForPoll(pollIntervalMs, input.signal, id)
  }
  throw new MarbleError({ message: "World Labs Marble generation did not finish before poll timeout" })
}
