/**
 * 生成产物**转存**（本族唯一一处下载实现）。
 *
 * 供应商（混元 / Tripo / Marble）的终态产物是**限时外部链接**，而本族原先只把链接写进
 * `{requestId}.json`：链接一过期，记录里剩下的就是死链。这一处负责——终态落盘**前**把每件产物
 * 各下载一次写进 `dataDirectory`（`{mode:0o600}`），并在返回结果里补
 * `artifacts.<件>.{localPath,bytes,sha256,downloadedAt}`。
 *
 * **为什么落在这里**：与 `./job-record.ts`、`./url-safety.ts` 同一条落点判据——`generate-hunyuan/src/`
 * 已是这一族的共享助手位置，包内 `./`、包外 `../../generate-hunyuan/src/` 复用，不需要新包、新的
 * exports 映射或新框架。
 *
 * **`generate-image` 不接这里**（有意）：图像链在生成阶段就已下载字节
 * （`generate-image/src/provider.ts` `downloadGeneratedImage` → `operations.ts` `persistImages`），
 * 产物本来就是本地文件；再接一次等于同一份字节下两遍。详见回执的"需不需要"判定。
 *
 * 两个入口形状不同、**下载语义是同一份**（都走 `transferTargets`）：
 *  - `transferArtifacts`：`meshURL` + `thumbnailURL`（hunyuan / tripo 的 `GeneratedMesh`）；
 *  - `transferWorldArtifacts`：`spzURL`（主产物）+ `meshURL` + `thumbnailURL` + `panoURL`（marble 的 `WorldAsset`）。
 *    Marble 的 `worldURL` **有意不转存**：它是供应商的**在线查看页**（HTML 页面），不是产物字节。
 *
 * 三条不可放宽的语义（与 Tripo 2026-09-22 落地版逐字一致，本次只是搬家 + 复用）：
 *  1. **永不抛错**：下载失败不让已经成功的生成任务失败，如实降级 `artifactsFetched:false` +
 *     `artifactsFetchError`（原因原文，可多件拼接）；一件链接都没有也算 `false`（没取到任何字节不能报成功）。
 *  2. **下载前过公网守卫**（`./url-safety.ts`）：这些 URL 由供应商响应决定，属不可信输入；
 *     `redirect:"manual"` 逐跳过守卫（≤3 跳），另有 256 MiB 上限、空响应拒绝、默认 120 s 超时。
 *  3. **`allowPrivate` 由调用方给**（缺省 `false` = 不放行私网/localhost）：hunyuan / tripo 显式传本包
 *     已声明的 `allowPrivateAssetURLs()`（保持既有行为、不新增环境键）；marble 不传——该包不读
 *     `OBJECT_GENERATOR_*`（见 `packages/generate-marble/test/env-forwarding.test.ts` 的清单合同），
 *     而它的产物本来就在公网 CDN 上。
 */
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assertPublicHttpsURL, parsePublicHttpsURL } from "./url-safety.ts"

/** 产物类别：决定文件名后缀兜底与返回结果里 `artifacts.<件>` 的键名。 */
export type ArtifactKind = "mesh" | "thumbnail" | "spz" | "pano"

/** 产物转存元数据：每件产物一组，落在返回 result 的 `artifacts.<件>`。 */
export interface ArtifactTransfer {
  /** 转存后的本地文件路径（`dataDirectory` 下，写入 `{mode:0o600}`）。 */
  localPath: string
  bytes: number
  sha256: string
  downloadedAt: string
}
export interface GenerationArtifacts {
  mesh?: ArtifactTransfer
  thumbnail?: ArtifactTransfer
  /** Marble 的主产物（3DGS 泼溅，`.spz`）。 */
  spz?: ArtifactTransfer
  /** Marble 的全景图。 */
  pano?: ArtifactTransfer
}
/** 终态结果 + 产物转存读数；`artifactsFetched:false` 必带 `artifactsFetchError`（原因原文），绝不静默只留链接。 */
export type TransferredResult<T extends object = MeshArtifactSource> = T & {
  artifacts: GenerationArtifacts
  artifactsFetched: boolean
  artifactsFetchError?: string
}

/** `transferArtifacts` 的输入形状：hunyuan / tripo 的 `GeneratedMesh` 结构上就是它。 */
export interface MeshArtifactSource {
  readonly meshURL?: string
  readonly thumbnailURL?: string
}
/** `transferWorldArtifacts` 的输入形状：marble 的 `WorldAsset` 结构上就是它。 */
export interface WorldArtifactSource {
  readonly spzURL?: string
  readonly meshURL?: string
  readonly thumbnailURL?: string
  readonly panoURL?: string
}

const ARTIFACT_MAX_BYTES = 256 * 1024 * 1024
const ARTIFACT_TIMEOUT_MS = 120_000
const ARTIFACT_MAX_REDIRECTS = 3

const ARTIFACT_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "model/gltf-binary": ".glb",
  "model/gltf+json": ".gltf",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/avif": ".avif",
}
/** URL 路径后缀白名单（content-type 分辨不出格式时的第二判据；`spz` 是 marble 主产物）。 */
const ARTIFACT_URL_SUFFIXES = ["glb", "gltf", "png", "webp", "jpg", "jpeg", "avif", "spz"]
/**
 * 两条判据都给不出格式时的兜底。`spz` 与 `pano` 是本次（marble 接线）新增的件：
 * `pano` 兜底取 `.jpg` 与 marble provider 自己的全景提取次序（先找 `.jpg` 再找 `.png`）一致。
 */
const ARTIFACT_FALLBACK_EXTENSIONS: Record<ArtifactKind, string> = {
  mesh: ".glb",
  thumbnail: ".png",
  spz: ".spz",
  pano: ".jpg",
}

/** 扩展名：content-type 优先；`application/octet-stream`（GLB 实测就是它）分辨不出格式，回落 URL 路径后缀，最后按产物兜底。 */
function artifactExtension(kind: ArtifactKind, contentType: string | undefined, url: string) {
  const fromType = ARTIFACT_CONTENT_TYPE_EXTENSIONS[(contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""]
  if (fromType) return fromType
  const match = ((url.split("?")[0] ?? "").split("#")[0]?.toLowerCase() ?? "").match(/\.([a-z0-9]+)$/)
  const suffix = match?.[1]
  if (suffix && ARTIFACT_URL_SUFFIXES.includes(suffix)) return suffix === "jpeg" ? ".jpg" : "." + suffix
  return ARTIFACT_FALLBACK_EXTENSIONS[kind]
}

/** 转存 URL 沿用既有公网守卫（`./url-safety.ts`）：与各包 provider 的 `publicImageURL` 同一语义，不放宽。 */
async function artifactURL(raw: string, kind: ArtifactKind, allowPrivate: boolean) {
  const options = { label: `${kind} 转存URL`, allowPrivate }
  parsePublicHttpsURL(raw, options)
  return await assertPublicHttpsURL(raw, options)
}

/** 单件产物下载一次：重定向逐跳过公网守卫（≤3 跳）；超时、大小上限、空体都算这次下载失败。 */
async function fetchArtifact(
  url: URL,
  kind: ArtifactKind,
  options: { fetch: typeof fetch; signal?: AbortSignal; timeoutMs: number; allowPrivate: boolean },
) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    let current = url
    for (let hop = 0; hop <= ARTIFACT_MAX_REDIRECTS; hop++) {
      let response: Response
      try {
        response = await options.fetch(current.href, { signal: controller.signal, redirect: "manual" })
      } catch (error) {
        if (timedOut) throw new Error(`转存下载超时（${options.timeoutMs} ms 内未完成）`)
        throw error
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) throw new Error(`转存下载重定向缺少 Location（HTTP ${response.status}）`)
        current = await artifactURL(new URL(location, current).href, kind, options.allowPrivate)
        continue
      }
      if (!response.ok) throw new Error(`转存下载失败：HTTP ${response.status} ${response.statusText}`.trimEnd())
      const declared = response.headers.get("content-length")
      if (declared && Number(declared) > ARTIFACT_MAX_BYTES) throw new Error(`转存产物超过大小上限（${ARTIFACT_MAX_BYTES} 字节）`)
      let bytes: Buffer
      try {
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (timedOut) throw new Error(`转存下载超时（${options.timeoutMs} ms 内未完成）`)
        throw error
      }
      if (!bytes.length) throw new Error("转存下载得到空响应")
      if (bytes.length > ARTIFACT_MAX_BYTES) throw new Error(`转存产物超过大小上限（${ARTIFACT_MAX_BYTES} 字节）`)
      return { bytes, contentType: response.headers.get("content-type") ?? undefined, url: current.href }
    }
    throw new Error(`转存下载重定向超过 ${ARTIFACT_MAX_REDIRECTS} 次`)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

export interface ArtifactTransferOptions {
  dataDirectory: string
  requestId: string
  /** 产物下载用的 fetch（测试替身注入点，缺省全局 fetch）。刻意与各包中央路由 `fetcher` 分开：供应商 CDN 产物链接不走中央网关。 */
  fetch?: typeof fetch
  signal?: AbortSignal
  /** 单件产物下载总时长上限（缺省 120 s），仅测试用于缩短。 */
  timeoutMs?: number
  /**
   * 放行私网 / localhost 产物地址（缺省 `false`）。**由调用方按本包已声明的环境键决定**，
   * 共享模块自己不读环境（见文件头第 3 条）。
   */
  allowPrivate?: boolean
}

/** 一件产物的转存目标：类别 + 供应商给的链接（链接缺失 = 这件本来就没有，不算失败）。 */
type ArtifactTarget = readonly [ArtifactKind, string | undefined]

/** 两条入口共用的下载/落盘/降级实现：逐件 try/catch，一件失败不影响另一件，也绝不让任务失败。 */
async function transferTargets<T extends object>(
  result: T,
  targets: readonly ArtifactTarget[],
  options: ArtifactTransferOptions,
  /** 一件链接都没有时的报错里点名缺的是哪几个字段（各入口字段名不同）。 */
  linkNames: string,
): Promise<TransferredResult<T>> {
  if (typeof options.requestId !== "string" || !/^[\w-]+$/.test(options.requestId)) throw new Error("INVALID_REQUEST_ID")
  await mkdir(options.dataDirectory, { recursive: true })
  const artifacts: GenerationArtifacts = {}
  const failures: string[] = []
  let attempted = 0
  for (const [kind, raw] of targets) {
    if (!raw) continue
    attempted++
    try {
      const downloaded = await fetchArtifact(await artifactURL(raw, kind, options.allowPrivate === true), kind, {
        fetch: options.fetch ?? fetch,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs ?? ARTIFACT_TIMEOUT_MS,
        allowPrivate: options.allowPrivate === true,
      })
      const localPath = join(
        options.dataDirectory,
        `${options.requestId}-${kind}${artifactExtension(kind, downloaded.contentType, downloaded.url)}`,
      )
      await writeFile(localPath, downloaded.bytes, { mode: 0o600 })
      artifacts[kind] = {
        localPath,
        bytes: downloaded.bytes.length,
        sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
        downloadedAt: new Date().toISOString(),
      }
    } catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!attempted)
    return { ...result, artifacts, artifactsFetched: false, artifactsFetchError: `没有可下载的产物链接（${linkNames} 均缺失）` }
  if (failures.length) return { ...result, artifacts, artifactsFetched: false, artifactsFetchError: failures.join("；") }
  return { ...result, artifacts, artifactsFetched: true }
}

/**
 * 三维对象产物转存（hunyuan / tripo）：对 `meshURL` 与 `thumbnailURL` **各下载一次**，
 * 文件名带 `requestId` 前缀 + 按 content-type / URL 路径判定的扩展名。
 */
export async function transferArtifacts<T extends MeshArtifactSource>(
  result: T,
  options: ArtifactTransferOptions,
): Promise<TransferredResult<T>> {
  return await transferTargets(result, [["mesh", result.meshURL], ["thumbnail", result.thumbnailURL]], options, "meshURL/thumbnailURL")
}

/**
 * 世界（3DGS）产物转存（marble）：主产物 `spzURL` 与 `meshURL` / `thumbnailURL` / `panoURL` 各下载一次。
 * `worldURL`（供应商在线查看页）不在转存范围内——它不是产物字节。
 */
export async function transferWorldArtifacts<T extends WorldArtifactSource>(
  result: T,
  options: ArtifactTransferOptions,
): Promise<TransferredResult<T>> {
  return await transferTargets(
    result,
    [
      ["spz", result.spzURL],
      ["mesh", result.meshURL],
      ["thumbnail", result.thumbnailURL],
      ["pano", result.panoURL],
    ],
    options,
    "spzURL/meshURL/thumbnailURL/panoURL",
  )
}
