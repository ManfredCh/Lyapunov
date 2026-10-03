/** 公开 Streamed SOG：按所选层下载标准 chunk，再原字节封装成现有 Viewer 可读的 SOG。 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"
import type { Transform } from "../../lyapunov-contracts/src/types.ts"
import {
  assertMountTarget, assertPublicHttpsURL, defaultHostResolver, fetchPublicHttpsBytesWithRetry, fetchPublicHttpsFileWithRetry,
  type HostResolver, type NetworkAssetRetryPolicy, type NetworkAssetTimeouts, type NetworkAssetTransport,
} from "./network-assets.ts"
import { planSsogLod, requireWholeSsogChunk, safeSsogPath, type SsogLodPlan } from "./ssog-manifest.ts"
import { inspectSogZipFile, parseSogMeta, safeSogMember, validWebpHead, writeSogZip } from "./sog-zip.ts"
import type { SceneOperations } from "./operations.ts"

const JSON_MAX_BYTES = 8 * 1024 * 1024
const META_MAX_BYTES = 1024 * 1024
const MAX_SOURCE_FILES = 2048
const SOG_SOURCE = { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 } as const

export interface StreamedSogRequest {
  manifestUrl: string
  sourcePage: string
  title?: string
  license?: string
  licenseUrl?: string
  author?: string
  selectedLod?: number
  maxBytes: number
  sceneId?: string
  name?: string
  entityId?: string
  parentId?: string
  transform?: Transform
  tags?: string[]
  folder?: string
}

export interface StreamedSogDependencies {
  resolve?: HostResolver
  transport?: NetworkAssetTransport
  signal?: AbortSignal
  timeouts?: NetworkAssetTimeouts
  retry?: NetworkAssetRetryPolicy
  /** 分享页与 viewer 配置已取回的真实字节/尝试数，也属于这次调用的预算。 */
  initialNetworkBytes?: number
  initialNetworkAttempts?: number
  initialNetworkRetries?: number
}

export interface StreamedSogResource {
  fileIndex: number | "environment"
  metaUrl: string
  gaussians: number
  resourceId: string
  version: number
  archiveBytes: number
  archiveSha256: string
  entityId?: string
}

export interface StreamedSogAcquisitionResult {
  kind: "streamed-sog"
  container: "ssog"
  collectionId: string
  selectedLod: number
  quality: "public-ssog-derived"
  levels: Array<{ lod: number; gaussians: number }>
  expectedGaussians: number
  actualGaussians: number
  resources: StreamedSogResource[]
  environment?: StreamedSogResource
  groupEntityId?: string
  scene?: { sceneId: string; revision: number; entityCount: number }
  sourceFacts: { sourcePage: string; manifestUrl: string; license?: string; licenseUrl?: string; author?: string }
  budget: { limitBytes: number; networkBytes: number; diskBytes: number; diskBytesScope: "this-collection-source-and-archives"; archiveBytes: number; networkAttempts: number; networkRetries: number; reusedNetworkBytes: 0 }
  warnings: string[]
}

interface SourceFile { url: string; name: string; bytes: number; sha256: string }
interface PreparedChunk {
  fileIndex: number | "environment"
  metaUrl: string
  count: number
  archivePath: string
  archiveBytes: number
  archiveSha256: string
  sourceFiles: SourceFile[]
}

function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 只把清单中的相对路径解析在官方 contentUrl 所在目录之下。 */
function childUrl(base: string, relativePath: string): string {
  safeSsogPath(relativePath)
  const parent = new URL(".", base), target = new URL(relativePath, parent)
  if (target.origin !== parent.origin || !target.pathname.startsWith(parent.pathname)) throw new Error(`SSOG_DEPENDENCY_PATH_INVALID: ${relativePath}`)
  return target.href
}

export async function acquireStreamedSog(operations: SceneOperations, request: StreamedSogRequest, deps: StreamedSogDependencies = {}): Promise<StreamedSogAcquisitionResult> {
  const signal = deps.signal
  const resolve = deps.resolve ?? defaultHostResolver
  signal?.throwIfAborted()
  await assertMountTarget(operations, request.sceneId, request.parentId)
  const collectionId = `ssog_${randomUUID()}`
  let networkBytes = deps.initialNetworkBytes ?? 0
  let networkAttempts = deps.initialNetworkAttempts ?? 0
  let networkRetries = deps.initialNetworkRetries ?? 0
  let diskBytes = 0, archiveBytes = 0
  let plan: SsogLodPlan | undefined
  const refs: StreamedSogResource[] = []
  const registered: Array<{ fileIndex: number | "environment"; resourceId: string; version: number }> = []
  const diskLimit = Math.min(request.maxBytes * 3, 96 * 1024 ** 3)
  const remaining = (): number => Math.max(0, request.maxBytes - networkBytes)
  const charge = (count: number): void => { networkBytes += count }
  const attempt = (number: number): void => { networkAttempts++; if (number > 1) networkRetries++ }
  const requireBudget = (): number => {
    const left = remaining()
    if (left <= 0) throw new Error("NETWORK_ASSET_SIZE_LIMIT: SSOG 本次累计网络预算已用完")
    return left
  }
  const markDisk = (count: number): void => {
    diskBytes += count
    if (diskBytes > diskLimit) throw new Error(`SSOG_DISK_SIZE_LIMIT: 已落地 ${diskBytes} 字节，上限 ${diskLimit}`)
  }
  const fetchJson = async (url: string, maxBytes: number, destination: string): Promise<{ value: unknown; file: SourceFile }> => {
    const target = await assertPublicHttpsURL(url, resolve, signal)
    const { bytes } = await fetchPublicHttpsBytesWithRetry(target, resolve, Math.min(maxBytes, requireBudget()), {
      transport: deps.transport, signal, timeouts: deps.timeouts, retry: deps.retry,
      acceptHeader: "application/json,text/plain;q=0.9,*/*;q=0.1", onBytes: charge, onAttempt: attempt,
    })
    const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes
    if (body.length > maxBytes) throw new Error(`SSOG_JSON_SIZE_LIMIT: ${url}`)
    let value: unknown
    try { value = JSON.parse(body.toString("utf8")) } catch { throw new Error(`SSOG_JSON_INVALID: ${url} 不是 JSON`) }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, body, { flag: "wx", mode: 0o600 })
    markDisk(body.length)
    return { value, file: { url, name: destination.split("/").pop()!, bytes: body.length, sha256: sha(body) } }
  }
  const fetchWebp = async (url: string, destination: string, name: string): Promise<SourceFile> => {
    const target = await assertPublicHttpsURL(url, resolve, signal)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const result = await fetchPublicHttpsFileWithRetry(target, resolve, requireBudget(), destination, {
      transport: deps.transport, signal, timeouts: deps.timeouts, retry: deps.retry,
      acceptHeader: "image/webp,application/octet-stream;q=0.9,*/*;q=0.1", onBytes: charge, onAttempt: attempt,
      verifyHeaders: type => { if (/^text\/html/i.test(type)) throw new Error(`NETWORK_ASSET_MIME_REJECTED: ${url} 返回 HTML`) },
      verifyFile: async candidate => {
        const file = await open(candidate, "r")
        try {
          const size = (await file.stat()).size, head = Buffer.alloc(Math.min(32, size))
          await file.read(head, 0, head.length, 0)
          if (!validWebpHead(head, size)) throw new Error(`ASSET_ACQUISITION_MIME_REJECTED: ${url} 不是完整 WebP`)
        } finally { await file.close() }
      },
    })
    markDisk(result.bytes)
    return { url, name, bytes: result.bytes, sha256: result.sha256 }
  }

  const landing = join(operations.resources.downloadRoot, collectionId)
  try {
    await mkdir(operations.resources.downloadRoot, { recursive: true, mode: 0o700 })
    await mkdir(landing, { recursive: false, mode: 0o700 })
  } catch (error) {
    throw new Error(`SSOG_LANDING_UNAVAILABLE: 当前会话下载目录不可用（${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}）`)
  }
  let importsStarted = false
  try {
    const manifest = await fetchJson(request.manifestUrl, JSON_MAX_BYTES, join(landing, "source", "lod-meta.json"))
    plan = planSsogLod(manifest.value, request.selectedLod ?? 0)
    const pending: Array<{ fileIndex: number | "environment"; metaPath: string; ranges?: SsogLodPlan["chunks"][number] }> = [
      ...plan.chunks.map(chunk => ({ fileIndex: chunk.fileIndex, metaPath: chunk.metaPath, ranges: chunk })),
      ...(plan.environment ? [{ fileIndex: "environment" as const, metaPath: plan.environment }] : []),
    ]
    const prepared: PreparedChunk[] = []
    let fileCount = 1
    for (const target of pending) {
      signal?.throwIfAborted()
      const metaUrl = childUrl(request.manifestUrl, target.metaPath)
      const sourceRoot = join(landing, "source", String(target.fileIndex))
      const chunkMeta = await fetchJson(metaUrl, META_MAX_BYTES, join(sourceRoot, "meta.json"))
      const { meta, members } = parseSogMeta(chunkMeta.value)
      if (target.ranges) requireWholeSsogChunk(target.ranges, meta.count)
      fileCount += members.length
      if (fileCount > MAX_SOURCE_FILES) throw new Error(`SSOG_FILE_COUNT_LIMIT: ${fileCount}`)
      const sourceFiles = [chunkMeta.file]
      for (const member of members.slice(1)) {
        signal?.throwIfAborted()
        safeSogMember(member)
        const url = childUrl(metaUrl, member)
        sourceFiles.push(await fetchWebp(url, join(sourceRoot, member), member))
      }
      const archivePath = join(landing, "chunks", `${target.fileIndex}.sog`)
      await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 })
      const archive = await writeSogZip(archivePath, sourceRoot, members, signal)
      markDisk(archive.bytes); archiveBytes += archive.bytes
      const verified = await inspectSogZipFile(archivePath, request.maxBytes, signal)
      if (verified.count !== meta.count || verified.members.length !== members.length) throw new Error(`SSOG_ARCHIVE_VERIFY_FAILED: ${target.metaPath}`)
      prepared.push({ fileIndex: target.fileIndex, metaUrl, count: meta.count, archivePath, archiveBytes: archive.bytes, archiveSha256: archive.sha256, sourceFiles })
    }
    const layerCount = prepared.filter(chunk => chunk.fileIndex !== "environment").reduce((sum, chunk) => sum + chunk.count, 0)
    if (layerCount !== plan.expectedGaussians) throw new Error(`SSOG_COUNT_MISMATCH: ${layerCount} != ${plan.expectedGaussians}`)
    const sourceFacts = {
      sourcePage: request.sourcePage, manifestUrl: request.manifestUrl,
      ...(request.license ? { license: request.license } : {}),
      ...(request.licenseUrl ? { licenseUrl: request.licenseUrl } : {}),
      ...(request.author ? { author: request.author } : {}),
    }
    const manifestText = JSON.stringify({
      kind: "public-ssog-derived", collectionId, selectedLod: plan.selectedLod, levels: plan.levels,
      expectedGaussians: plan.expectedGaussians, environment: plan.environment ?? null,
      sourceFacts, sourceBounds: plan.sourceBounds, inputManifest: manifest.file,
      chunks: prepared.map(chunk => ({ fileIndex: chunk.fileIndex, metaUrl: chunk.metaUrl, gaussians: chunk.count, archiveBytes: chunk.archiveBytes, archiveSha256: chunk.archiveSha256, sourceFiles: chunk.sourceFiles })),
      budget: { limitBytes: request.maxBytes, networkBytes, diskBytes, archiveBytes, networkAttempts, networkRetries },
    }, null, 2)
    await writeFile(join(landing, "manifest.json"), manifestText, { flag: "wx", mode: 0o600 })
    markDisk(Buffer.byteLength(manifestText))
    importsStarted = true
    let environment: StreamedSogResource | undefined
    for (const chunk of prepared) {
      signal?.throwIfAborted()
      const tags = [...(request.tags ?? []), `SSOG集合:${collectionId}`, `公开SSOG派生:LOD${plan.selectedLod}`, `来源页:${request.sourcePage}`, `清单URL:${request.manifestUrl}`,
        ...(request.license ? [`许可:${request.license}`] : []), ...(request.author ? [`作者:${request.author}`] : []), `块:${chunk.fileIndex}`]
      const imported = await operations.import({ path: chunk.archivePath, name: `${request.name ?? request.title ?? "公开SSOG"} · ${chunk.fileIndex}`, source: SOG_SOURCE, tags, folder: request.folder ?? "获取资产/公开SSOG", physicalize: false })
      registered.push({ fileIndex: chunk.fileIndex, resourceId: imported.resource.ref.resourceId, version: imported.resource.ref.version })
      signal?.throwIfAborted()
      const mergedTags = [...new Set([...(imported.resource.tags ?? []), ...tags])]
      const resource = mergedTags.length === (imported.resource.tags ?? []).length ? imported.resource : await operations.resources.update(imported.resource.ref.resourceId, { tags: mergedTags })
      const verified = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
      signal?.throwIfAborted()
      if (!verified.valid) throw new Error(`SSOG_RESOURCE_VERIFY_FAILED: ${chunk.fileIndex}`)
      const item: StreamedSogResource = { fileIndex: chunk.fileIndex, metaUrl: chunk.metaUrl, gaussians: chunk.count, resourceId: resource.ref.resourceId, version: resource.ref.version, archiveBytes: chunk.archiveBytes, archiveSha256: chunk.archiveSha256 }
      if (chunk.fileIndex === "environment") environment = item
      else refs.push(item)
    }
    signal?.throwIfAborted()
    // 可追溯登记写在场景副作用之前；后续 Scene CAS 成功不再依赖附属文件落盘。
    const registrationText = JSON.stringify({ collectionId, resources: refs, environment: environment ?? null }, null, 2)
    await writeFile(join(landing, "registration.json"), registrationText, { flag: "wx", mode: 0o600 })
    markDisk(Buffer.byteLength(registrationText))
    signal?.throwIfAborted()
    const mounted = request.sceneId ? await operations.mountSogCollection({
      sceneId: request.sceneId, name: request.name ?? request.title ?? "公开SSOG", entityId: request.entityId,
      parentId: request.parentId, transform: request.transform,
      resources: [...refs, ...(environment ? [environment] : [])].map(item => ({ resourceId: item.resourceId, version: item.version, name: String(item.fileIndex) })),
    }, signal) : undefined
    if (mounted) for (const [index, entityId] of mounted.entityIds.entries()) {
      const item = index < refs.length ? refs[index]! : environment!
      item.entityId = entityId
    }
    const result: StreamedSogAcquisitionResult = {
      kind: "streamed-sog", container: "ssog", collectionId, selectedLod: plan.selectedLod,
      quality: "public-ssog-derived", levels: plan.levels, expectedGaussians: plan.expectedGaussians, actualGaussians: layerCount,
      resources: refs, ...(environment ? { environment } : {}),
      ...(mounted ? { groupEntityId: mounted.groupEntityId, scene: { sceneId: mounted.snapshot.sceneId, revision: mounted.snapshot.revision, entityCount: mounted.snapshot.entities.length } } : {}),
      sourceFacts,
      budget: { limitBytes: request.maxBytes, networkBytes, diskBytes, diskBytesScope: "this-collection-source-and-archives", archiveBytes, networkAttempts, networkRetries, reusedNetworkBytes: 0 },
      warnings: ["所选层是公开 Streamed SOG 的压缩派生表示，不是作者原始 PLY；资源已登记，是否在目标窗口显示需同 revision 的 viewer_observe 确认。"],
    }
    return result
  } catch (error) {
    const publicReason = reason(error).replaceAll(landing, "<本会话下载目录>").replaceAll(operations.resources.downloadRoot, "<本会话下载根>")
    if (!importsStarted) await rm(landing, { recursive: true, force: true }).catch(() => undefined)
    if (importsStarted) throw new Error(`SSOG_PARTIAL_IMPORT: 已登记 ${JSON.stringify(registered)}，场景只以实际 CAS 结果为准；${publicReason}`)
    const text = publicReason
    if (plan && /SIZE_LIMIT|BUDGET/.test(text)) throw new Error(`SSOG_BUDGET_INSUFFICIENT: 所选 LOD${plan.selectedLod} 需要完整闭包，已到网络 ${networkBytes}/${request.maxBytes} 字节或磁盘 ${diskBytes}/${diskLimit} 字节；可显式选择 ${JSON.stringify(plan.levels)}，未自动降级。原因：${text}`)
    throw new Error(text)
  }
}
