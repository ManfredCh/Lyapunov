/**
 * 通用公开模型资产获取（ENV-20/47/49/51 的薄切片）：把**任意公开来源**的模型整理成自包含 GLB，
 * 再复用 SceneOperations.import / ResourceLibrary 登记——不另建资料库、不另记任务状态。
 *
 * 三条入口（同一个 operation）：
 *  1) url 指向 .glb／.gltf：.gltf 的相对 bin/纹理依赖、dataURI 与已内嵌 bufferView 的纹理
 *     全部真正整理进 GLB（组装复用 environment-assets 的 assembleSelfContainedGLB）；
 *  2) url 指向 .zip：下载后按中央目录取出包内 .glb／.gltf 及其包内依赖，同样整理成 GLB；
 *  3) path 指向本地 .glb／.gltf／.zip（含别处已下载的压缩包）：本地路径规则同上。
 *
 * 传输层**不复制下载器**：SSRF 预检（DNS 与连接期双重复核）、禁重定向、声明字节上限、
 * 停顿/总时长预算与取消语义全部复用 network-assets 的 assertPublicHttpsURL / fetchPublicHttpsBytesWithRetry
 * （短暂故障按可取消退避有界重试，永久失败不盲试；重试不重置字节额度）。
 * 体积与路径边界也只有一条口径：单文件、压缩包与组装后的 GLB 都不超过 maxBytes（默认 64 MiB）；
 * 本地依赖必须落在资产目录树内；压缩包内的依赖先按主资产所在成员目录归一、再回退包根，
 * 只有归一后仍越出包根（或绝对路径）才拒绝——包内 `../textures/a.png` 这类兄弟引用是合法相对引用。
 *
 * 来源事实（sourcePage/license/author）由调用方声明并原样记录：**许可证从不推断**——
 * 没给就明确写进 warnings，不按主机名/目录名猜一个许可。
 * 下载复用已有资源事实：同一 URL 已登记过、且落地文件的 sha256 与记录一致时才复用
 * （哈希按当前文件真实重算）；复用命中时**不再新建落地目录/清单、不重复登记**，
 * 直接沿既有记录与旧产物（标签变化沿原记录更新、带 sceneId 时走 operations.mount）；
 * 复用不等于"远端内容未变"，返回里如实标注未重新访问远端。
 * 相对 path 一律按调用方给的 cwd 解析（工具/命令传会话 header.cwd），不拿宿主进程 cwd 当基准。
 */
import type { Context } from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-commands"
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, posix, resolve, sep } from "node:path"
import type { ResourceRef, SceneSnapshot, Transform } from "../../lyapunov-contracts/src/types.ts"
import { assembleSelfContainedGLB } from "./environment-assets.ts"
import { assetBounds, fileStamp, glbJSON, localPath, parseAsset } from "./formats.ts"
import { modelSceneView } from "./model-view.ts"
import {
  assertMountTarget,
  assertPublicHttpsURL,
  defaultHostResolver,
  fetchPublicHttpsBytesWithRetry,
  fetchPublicHttpsFileWithRetry,
  landingIsRegistered,
  NETWORK_ASSET_MAX_BYTES,
  type HostResolver,
  type NetworkAssetProvenance,
  type NetworkAssetRetryPolicy,
  type NetworkAssetTimeouts,
  type NetworkAssetTransport,
} from "./network-assets.ts"
import { resolveAssetSharePage, sharePageTargetOf } from "./share-pages.ts"
import { acquireStreamedSog, type StreamedSogAcquisitionResult } from "./streamed-sog-acquisition.ts"
import { inspectSplatFile, isSplatExtension, isStreamableSplatFormat, splatFormatFromContentDisposition, streamableSplatFormatOf, type SplatFileFact, type StreamableSplatFormat } from "./splat-formats.ts"
import type { SceneOperations } from "./operations.ts"
import { notePhysicalizationSkipped, schedulePhysicalization, type PhysicalizeStrategy, type PhysicalizeUsage } from "./physicalization.ts"
import type { ResourceRecord } from "./resources.ts"
import { readZipDirectory, readZipEntry, type ZipEntry } from "./zip-archive.ts"

/** 默认字节上限与硬上限（与 network-assets 同一数字）：单文件、压缩包与组装后的 GLB 共用它。 */
const DEFAULT_MAX_BYTES = NETWORK_ASSET_MAX_BYTES
/**
 * 3DGS 直链的独立预算：与 GLB 的 64 MiB **不是**同一条口径。
 * 大高斯捕获常见几百 MB 到几 GB，落盘是流式写文件（不整份进 Buffer），所以限制的是"这一次允许下载多少字节"，
 * 默认 8 GiB、硬上限 32 GiB，可由调用方收紧或在此范围内提高；GLB/glTF/ZIP 仍严格守 64 MiB。
 */
const DEFAULT_SPLAT_MAX_BYTES = 8 * 1024 ** 3
const MAX_SPLAT_MAX_BYTES = 32 * 1024 ** 3
/** 3DGS 直链的 Accept：只声明二进制/模型类，HTML 页面在头部就被拒。 */
const SPLAT_ACCEPT_HEADER = "application/octet-stream, application/x-ply, application/x-spz, model/gltf-binary, */*;q=0.1"
/** 一次获取允许多少个外部依赖（bin/纹理）；与 environment-assets 的清单上限同一量级。 */
const MAX_DEPENDENCY_FILES = 96
/** ZIP 内有多个候选资产时，错误信息里最多列出多少个（列全会让错误本身变成噪声）。 */
const MAX_LISTED_CANDIDATES = 20
/** 主文件与依赖共用同一个 Accept：容器可能是 GLB/glTF/ZIP，依赖可能是 bin 或纹理。 */
const ACCEPT_HEADER = "model/gltf-binary, model/gltf+json, application/zip, application/octet-stream, image/*;q=0.9, */*;q=0.5"
const GLB_MAGIC = 0x46546c67
const LOCAL_HEADER_MAGIC = 0x04034b50
const END_OF_DIRECTORY_MAGIC = 0x06054b50
const BIN_CHUNK = 0x004e4942
/** glTF 2.0 的坐标系约定（米、Y-up、右手系）：解析与登记用同一份声明，与 scene_import 默认口径一致。 */
const GLTF_SOURCE: ResourceRef["source"] = { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 }

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 取消类别原样向上传（与 network-assets / dsh-tools 同一条语义）：用户停止不是"网络坏了"，也不是"依赖缺失"。 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === "string" ? signal.reason : "aborted")
}

/** 字节来自哪一层：远端直链、本地目录、压缩包成员。 */
export type AssetSourceKind = "network" | "file" | "archive"

export interface AssetAcquisitionInput {
  /** 公开 https 直链（.glb／.gltf／.zip）。与 path 二选一。 */
  url?: string
  /** 本地文件（.glb／.gltf／.zip，含别处已下载的压缩包）。与 url 二选一。 */
  path?: string
  /** ZIP 内主资产的成员路径（如 models/chair/chair.gltf）；包内只有一个候选时可省略。 */
  entry?: string
  sceneId?: string
  name?: string
  resourceId?: string
  entityId?: string
  parentId?: string
  transform?: Transform
  /** 本次字节上限（默认 64 MiB，也是硬上限）：单文件、压缩包与组装后的 GLB 都不超过它。 */
  maxBytes?: number
  /**
   * 3DGS 直链（.spz/.ply/.splat）的独立字节预算（默认 8 GiB，硬上限 32 GiB）：
   * 这条路径**流式落盘**、不整份读进 Buffer，所以 64 MiB 不是它的通用硬上限；可收紧或在此范围内提高。
   */
  splatMaxBytes?: number
  /** Streamed SOG 选择层；省略为公开最高细节 LOD0，预算不足不自动降级。 */
  selectedLod?: number
  /**
   * 3DGS 直链的**格式提示**（ply/spz/splat）：URL 无扩展名（如带 query 的下载端点）时用它明确走 3DGS 通路，
   * 否则无扩展名地址会按旧 GLB 入口（64 MiB）尝试。它只是路由/校验提示，**不能替代字节校验**：
   * 内容与提示不符仍报 ASSET_ACQUISITION_SPLAT_FORMAT_MISMATCH；HTML 伪装仍被按字节拒绝。
   */
  formatHint?: StreamableSplatFormat
  /** false 跳过自动碰撞派生（模块/环境类资产常用，与 scene_import 同一字段）；省略时与 scene_import 一致。 */
  physicalize?: boolean
  physicalizeStrategy?: PhysicalizeStrategy
  /** 派生用途（与 scene_import 同一枚举）：获取来的世界环境/建筑/地面用 environment——逐表面导出、
   *  不填内部、不用凸包封死通道；获取来的物体用默认 dynamic。给了它即视为要求派生。 */
  physicalizeUsage?: PhysicalizeUsage
  /** 表面体素边长（米），仅对 voxel_boxes 有意义；透传给同一派生队列。 */
  physicalizeVoxelSizeM?: number
  /** 资源目录；省略时按来源给默认值（获取资产/<主机> 或 获取资产/本地文件）。 */
  folder?: string
  /** 附加资源标签；来源页/许可/作者/清单标签由本模块按事实追加。 */
  tags?: string[]
  /** 来源页 URL（https）：只记录与核对，不抓取该页面。 */
  sourcePage?: string
  /** 调用方从来源页读到的许可名称（如 CC-BY-4.0）。省略时本模块不推断许可证。 */
  license?: string
  /** 调用方从来源页读到的作者/版权方。省略时不写。 */
  author?: string
  /** true 时忽略已取回字节重新下载（默认复用同一 URL 的已登记字节，并重算哈希核对）。 */
  refresh?: boolean
}

/**
 * signal 是原生 Tools/Jobs 的取消入口；timeouts 只给测试注入（缩短停顿/总时长以确定性驱动超时语义）。
 * cwd 是相对 path 的解析基准：工具/命令按会话 `agent.session.header.cwd` 传入——宿主进程的 cwd 是代码根，
 * 不是用户看到的工作目录，相对路径落到进程 cwd 就会取错文件（同名文件存在时还会静默取到诱饵）。
 * 独立调用 operation 时可以显式给 cwd；省略才回落到 process.cwd()。
 * retry 省略即用 network-assets 的 NETWORK_ASSET_RETRY_DEFAULTS（短暂故障最多再试 2 次，退避可取消）；
 * 显式 {retries:0} 关闭重试。重试不会绕过字节上限：每次尝试的额度都是「上限 - 已取回」。
 */
export interface AssetAcquisitionDependencies {
  resolve?: HostResolver
  transport?: NetworkAssetTransport
  signal?: AbortSignal
  timeouts?: NetworkAssetTimeouts
  cwd?: string
  retry?: NetworkAssetRetryPolicy
}

export interface AssetAcquisitionDependencyFact {
  /** 主文件里写的原始 URI（未解码），与 GLB 组装查找键一致。 */
  uri: string
  source: AssetSourceKind
  /** 具体出处：URL / 本地绝对路径 / 包内成员路径。 */
  origin: string
  bytes: number
  sha256: string
}

export interface AssetAcquisitionSourceFile {
  /** 网络/包内字节会复制进落地目录 source/；本地原件保留原位，这里给它的真实位置。 */
  path: string
  source: AssetSourceKind
  origin: string
  bytes: number
  sha256: string
  copied: boolean
}

export interface AssetAcquisitionResult {
  resource: ResourceRecord
  verification: { valid: boolean; missing: string[]; changed: string[] }
  snapshot?: SceneSnapshot
  entityId?: string
  acquisition: {
    input: { kind: "url"; url: string } | { kind: "path"; path: string }
    /** 容器形态；zip 时 entry 是包内成员路径。 */
    container: "glb" | "gltf" | "zip"
    entry: string
    dependencies: AssetAcquisitionDependencyFact[]
    /** dataURI 与已内嵌 bufferView 的纹理数：这些字节本来就在文件里，不经网络与磁盘。 */
    embedded: { dataURIBuffers: number; dataURIImages: number; bufferViewImages: number }
    glb: { path: string; bytes: number; sha256: string; externalDependencies: 0 }
    /** 本次实际花掉的字节（含主文件与压缩包本身）：远端取回 / 本地读取 / 复用已取回字节，分别记录。 */
    budget: { limitBytes: number; networkBytes: number; diskBytes: number; reusedBytes: number; networkAttempts: number; networkRetries: number }
    download: {
      /** 本次是否真的为取主资产发了网络请求。 */
      requested: boolean
      reusedFromCache: boolean
      /** 复用时的来源与复核结果；未复用时省略该字段。 */
      reusedFrom?: { resourceId: string; version: number; path: string; sha256: string; fetchedAt: string; verified: "sha256-recomputed" }
      acquiredAt: string
      /** 网络取回时的响应类型；复用已登记字节时是当时记录下的类型（本次没有响应，别当成本次事实）。 */
      contentType?: string
    }
  }
  /** 组装后 GLB 的只读结构事实：节点/网格/材质/纹理数，以及场景本地坐标下的尺度（米）。 */
  model: {
    nodes: number; meshes: number; materials: number; images: number; sizeM?: [number, number, number]
    /** 显示帧（内部 z-up、米制）下的几何范围；取不到时省略——这正是"底面/尺度不可判定"的读数。 */
    bounds?: { min: [number, number, number]; max: [number, number, number] }
    /** 底面：包围盒在落地轴（z，见 scene_mount 的 lift 计算）上的最低点，米。 */
    bottomM?: number
    /** 法线读数：有 NORMAL 与缺 NORMAL 的网格图元数（缺的会被实现按缺省光照处理）。 */
    normals?: { primitives: number; withNormals: number; missing: number }
    /** 每个材质的通道名（pbrMetallicRoughness 与顶层贴图通道），只列真实存在的键。 */
    materialChannels?: string[][]
    /** 3DGS 直链路径的形态事实：spz/ply/splat、是否高斯、PLY 的顶点数（取不到就不写）。 */
    format?: StreamableSplatFormat
    gaussian?: boolean
    vertexCount?: number
  }
  sourceFacts: { sourcePage?: string; license?: string; author?: string }
  /** 本次获取对应的清单文件；复用命中时指向**上一次**那份清单，读不到旧清单指针时省略。 */
  manifestPath?: string
  sourceFiles: AssetAcquisitionSourceFile[]
  /**
   * 资源记录上的网络来源事实：真的访问过远端时是新写的那份；本地/包内整理没有它。
   * 复用命中时带回记录里**原有的**那份（不是在暗示本次又访问了远端——本次是否发过请求看 download.requested）。
   */
  provenance?: NetworkAssetProvenance
  /** 同一字节已在资源库中时的既有记录（ResourceLibrary 的内容去重）。 */
  alreadyPresent?: true
  warnings: string[]
}

/**
 * 3DGS 直链获取（`.spz`/`.ply`/`.splat`）的结果：**不经过 GLB 组装**，登记的就是流式落地的原件。
 * 与 GLB 结果并列而不是塞进 `acquisition.glb`——把 PLY 说成 GLB 是事实错误。
 */
export interface SplatAcquisitionResult {
  resource: ResourceRecord
  verification: { valid: boolean; missing: string[]; changed: string[] }
  snapshot?: SceneSnapshot
  entityId?: string
  acquisition: {
    input: { kind: "url"; url: string } | { kind: "path"; path: string }
    container: "splat"
    format: StreamableSplatFormat
    /** 落地/本地的原件路径（登记就是它，没有第二份 GLB 组装件）。 */
    path: string
    bytes: number
    sha256: string
    contentType: string
    gaussian: boolean
    /** PLY 头里的顶点数；其它格式取不到就不写（不推断）。 */
    vertexCount?: number
    /** SOG ZIP 的 meta.json 高斯数；不冒充 PLY 顶点数。 */
    gaussianCount?: number
    budget: { limitBytes: number; networkBytes: number; diskBytes: number; reusedBytes: number; networkAttempts: number; networkRetries: number }
    download: {
      requested: boolean
      reusedFromCache: boolean
      acquiredAt: string
      contentType?: string
      reusedFrom?: { resourceId: string; version: number; path: string; sha256: string; fetchedAt: string; verified: "sha256-recomputed" }
    }
  }
  model: AssetAcquisitionResult["model"] & { format: StreamableSplatFormat; gaussian: boolean }
  sourceFacts: { sourcePage?: string; license?: string; author?: string }
  provenance?: NetworkAssetProvenance
  manifestPath?: string
  sourceFiles: AssetAcquisitionSourceFile[]
  warnings: string[]
}

export type PublicAssetAcquisitionResult = AssetAcquisitionResult | SplatAcquisitionResult | StreamedSogAcquisitionResult

/** 归一函数必须与 environment-assets 的 assembleSelfContainedGLB 查找键逐字一致，否则依赖会被当成缺失。 */
function normalizedURI(uri: string): string { return posix.normalize(uri.split(sep).join("/")) }

/** 百分号解码后的名字（落盘/找本地文件用）；转义非法时原样返回——它只是名字，不做 URL 解析。 */
function decodedName(uri: string): string { try { return decodeURIComponent(uri) } catch { return uri } }

/** 压缩包成员名与本地依赖名都走这条边界：不能是绝对路径、不能含 ..、不能为空。 */
function safeRelativeName(name: string, label: string): string {
  const normalized = posix.normalize(decodedName(name).split("\\").join("/"))
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`ASSET_ACQUISITION_PATH_UNSAFE: ${label}「${name}」不是安全的相对路径（拒绝绝对路径与 .. 越界）。可采取的动作：确认压缩包/资产目录里没有越界成员名。`)
  }
  return normalized
}

/**
 * 包内依赖的候选成员名（按优先级，已去重）：先按主资产所在成员目录归一，再回退包根同名成员。
 * `../textures/a.png` 这类**包内部的**兄弟目录引用是正常的相对引用，归一后仍在包内就必须放行；
 * 只有归一后仍越出包根（或写成绝对路径）的候选才丢掉——那才是真的越界。
 * 注意：不能在这里用 safeRelativeName——它见到 `..` 就抛，会把包内兄弟引用判死。
 */
function archiveMemberCandidates(baseDir: string, uri: string): string[] {
  const name = decodedName(uri).split("\\").join("/")
  if (posix.isAbsolute(name)) return []
  const inside = (candidate: string): boolean => candidate !== "" && candidate !== "." && candidate !== ".." && !candidate.startsWith("../")
  return [...new Set([posix.join(baseDir, name), posix.normalize(name)].filter(inside))]
}

/** 本地依赖必须落在资产目录树内：与 environment-assets 的 include 规则同一条口径。 */
function containedPath(root: string, uri: string): string {
  const name = safeRelativeName(uri, "依赖 URI")
  const target = resolve(root, name)
  if (!target.startsWith(root + sep)) throw new Error(`ASSET_ACQUISITION_PATH_UNSAFE: 依赖「${uri}」解析到资产目录之外（${target}）。可采取的动作：把依赖放在 .gltf 的同一目录树内，或改用包含它们的 ZIP。`)
  return target
}

/** 容器形态只按真实字节判定（扩展名与 Content-Type 都可能撒谎）。 */
function containerKind(bytes: Buffer): "glb" | "zip" | "gltf" {
  if (bytes.length >= 12 && bytes.readUInt32LE(0) === GLB_MAGIC) return "glb"
  if (bytes.length >= 4 && (bytes.readUInt32LE(0) === LOCAL_HEADER_MAGIC || bytes.readUInt32LE(0) === END_OF_DIRECTORY_MAGIC)) return "zip"
  return "gltf"
}

/** GLB 的 JSON 与 BIN 分块：结构校验交给 formats.glbJSON（长度/分块/glTF 版本的权威口径）。 */
function glbSections(bytes: Buffer): { json: any; bin?: Buffer } {
  const json = glbJSON(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12, bin: Buffer | undefined
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (type === BIN_CHUNK && bin === undefined) bin = bytes.subarray(start, start + length)
    offset = start + length
  }
  return { json, ...(bin ? { bin } : {}) }
}

/** glTF 核心的外部依赖面：buffers 与 images 的非 data URI（与组装器的检查面一致）。 */
function externalURIs(json: any): string[] {
  return [...json?.buffers ?? [], ...json?.images ?? []]
    .map((item: any) => item?.uri)
    .filter((uri: unknown): uri is string => typeof uri === "string" && !uri.startsWith("data:"))
}

function embeddedFacts(json: any): { dataURIBuffers: number; dataURIImages: number; bufferViewImages: number } {
  const buffers: any[] = json?.buffers ?? [], images: any[] = json?.images ?? []
  return {
    dataURIBuffers: buffers.filter(item => typeof item?.uri === "string" && item.uri.startsWith("data:")).length,
    dataURIImages: images.filter(item => typeof item?.uri === "string" && item.uri.startsWith("data:")).length,
    bufferViewImages: images.filter(item => typeof item?.bufferView === "number").length,
  }
}

interface ResolvedDependency { bytes: Buffer; source: AssetSourceKind; origin: string; name: string }
type DependencyReader = (uri: string) => Promise<ResolvedDependency>

interface AcquisitionState {
  /** 归一 URI → 依赖字节（交给 assembleSelfContainedGLB 的同一张表）。 */
  files: Map<string, Buffer>
  dependencies: AssetAcquisitionDependencyFact[]
  originals: Array<{ name: string; bytes: Buffer; source: AssetSourceKind; origin: string }>
  networkBytes: number
  diskBytes: number
  /** 真实发出的远端请求数与其中因短暂故障重发的次数（有界重试的可核对读数）。 */
  networkAttempts: number
  networkRetries: number
}

/**
 * 读取一个声明的外部依赖；失败在这里聚合成一条可采取动作的错误，不静默跳过。
 * 取消是例外：signal 一旦 abort 就立刻抛取消错误（保留取消类别），不再枚举剩下的依赖——
 * 用户按了停止不该看到"依赖缺失"，也不该为一次已经作废的获取继续发请求。
 */
async function collectDependencies(json: any, read: DependencyReader, state: AcquisitionState, signal?: AbortSignal): Promise<void> {
  const declared = new Map<string, string>()
  const add = (item: any): void => {
    const uri = item?.uri
    if (typeof uri !== "string" || uri.startsWith("data:")) return
    const key = normalizedURI(uri)
    if (!declared.has(key)) declared.set(key, uri)
  }
  for (const item of json?.buffers ?? []) add(item)
  for (const item of json?.images ?? []) add(item)
  if (state.files.size + declared.size > MAX_DEPENDENCY_FILES) throw new Error(`ASSET_ACQUISITION_TOO_MANY_FILES: 该资产声明 ${state.files.size + declared.size} 个外部依赖，超过上限 ${MAX_DEPENDENCY_FILES}`)
  const failures: string[] = []
  for (const [key, uri] of declared) {
    if (state.files.has(key)) continue
    signal?.throwIfAborted()
    try {
      const resolved = await read(uri)
      state.files.set(key, resolved.bytes)
      state.dependencies.push({ uri, source: resolved.source, origin: resolved.origin, bytes: resolved.bytes.length, sha256: digestOf(resolved.bytes) })
      state.originals.push({ name: resolved.name, bytes: resolved.bytes, source: resolved.source, origin: resolved.origin })
    } catch (error) {
      // 取消优先于缺件判定：读取失败与"用户刚按了停止"同时发生时，上报的是取消，不是网络坏。
      if (signal?.aborted) throw abortError(signal)
      failures.push(`${uri}（${messageOf(error)}）`)
    }
  }
  if (failures.length) throw new Error(`ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE: 以下外部依赖没有取到：${failures.join("；")}。可采取的动作：核对 .gltf 里的相对 URI 与它所在目录；远端依赖要确认仍在同一公开位置；压缩包内的依赖必须真的在包内。本操作不做"缺件也勉强导入"。`)
}

/**
 * 主文件 + 依赖 → 自包含 GLB，并交出**输入文档**（依赖形态的事实来自输入，不是组装产物）。
 * GLB 已经自包含时**原样返回**（不重新打包，字节与到手原件逐字节一致）；
 * GLB 仍引用外部文件时把 BIN 分块转成 data URI，再走同一个组装器（外部纹理照常并入）。
 */
async function toSelfContainedGLB(kind: "glb" | "gltf", bytes: Buffer, read: DependencyReader, state: AcquisitionState, signal?: AbortSignal): Promise<{ glb: Buffer; source: any }> {
  if (kind === "glb") {
    const { json, bin } = glbSections(bytes)
    const external = externalURIs(json)
    if (!external.length) return { glb: bytes, source: json }
    const shown = external.slice(0, 4).join(", ")
    const more = external.length > 4 ? ` 等 ${external.length} 个` : ""
    const gltf = structuredClone(json)
    if (Array.isArray(gltf.buffers) && gltf.buffers.length && gltf.buffers[0]?.uri === undefined) {
      if (!bin) throw new Error(`ASSET_ACQUISITION_GLB_BIN_MISSING: GLB 声明了 buffers[0] 却没有 BIN 分块，无法与外部依赖一起整理（引用：${shown}${more}）。可采取的动作：改用该资产的 .gltf 直链或包含全部依赖的 ZIP。`)
      gltf.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString("base64")}`
    }
    await collectDependencies(gltf, read, state, signal)
    return { glb: assembleSelfContainedGLB(gltf, state.files), source: gltf }
  }
  let json: any
  try { json = JSON.parse(bytes.toString("utf8")) } catch {
    throw new Error("ASSET_ACQUISITION_UNRECOGNIZED_CONTAINER: 取回的字节既不是 GLB、不是 ZIP，也不是 glTF JSON（常见于登录页/错误页/被中间层改写的响应）。可采取的动作：回到来源页确认这是资产文件直链。")
  }
  if (!String(json?.asset?.version ?? "").startsWith("2.")) throw new Error(`ASSET_ACQUISITION_GLTF_VERSION_UNSUPPORTED: 只支持 glTF 2.x（读到 ${String(json?.asset?.version ?? "缺失")}）。可采取的动作：换 2.x 版本，或先用 Blender 转换。`)
  await collectDependencies(json, read, state, signal)
  return { glb: assembleSelfContainedGLB(json, state.files), source: json }
}

/** ZIP 里按中央目录挑主资产：只有一个候选时自动选中，多个候选必须由调用方用 entry 指定。 */
function selectZipEntry(entries: ZipEntry[], requested: string | undefined, label: string): ZipEntry {
  const candidates = entries.filter(entry => /\.(gltf|glb)$/i.test(entry.name))
  if (requested !== undefined) {
    const wanted = normalizedURI(requested)
    const match = entries.find(entry => normalizedURI(entry.name) === wanted || normalizedURI(decodedName(entry.name)) === wanted)
    if (!match) throw new Error(`ASSET_ACQUISITION_ENTRY_NOT_FOUND: ${label} 里没有「${requested}」。${candidateList(candidates)}`)
    return match
  }
  if (candidates.length === 1) return candidates[0]!
  if (!candidates.length) throw new Error(`ASSET_ACQUISITION_NO_ASSET_IN_ARCHIVE: ${label} 内没有 .gltf/.glb 资产（共 ${entries.length} 个文件条目${entries.length ? `，例如 ${entries.slice(0, MAX_LISTED_CANDIDATES).map(entry => entry.name).join(", ")}` : ""}）。可采取的动作：换一个包含 glTF/GLB 的压缩包。`)
  throw new Error(`ASSET_ACQUISITION_ENTRY_REQUIRED: ${label} 内有多个候选资产，请用 entry 指定要获取哪一个。${candidateList(candidates)}`)
}

function candidateList(candidates: ZipEntry[]): string {
  const shown = candidates.slice(0, MAX_LISTED_CANDIDATES).map(entry => entry.name).join(", ")
  return `候选：${shown}${candidates.length > MAX_LISTED_CANDIDATES ? ` 等 ${candidates.length} 个` : ""}`
}

/** 字节上限：调用方只能收紧，不能超过硬上限（与 network-assets 同一约束）。 */
function maxBytesOf(requested: number | undefined): number {
  const maxBytes = Math.min(requested ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("ASSET_ACQUISITION_MAX_BYTES_INVALID: maxBytes 必须是正整数（字节）")
  return maxBytes
}

/** 3DGS 直链预算：默认 8 GiB，硬上限 32 GiB（流式落盘，不是 GLB 的 64 MiB 通用上限）。 */
function splatMaxBytesOf(requested: number | undefined): number {
  const maxBytes = Math.min(requested ?? DEFAULT_SPLAT_MAX_BYTES, MAX_SPLAT_MAX_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("ASSET_ACQUISITION_SPLAT_MAX_BYTES_INVALID: splatMaxBytes 必须是正整数（字节）")
  return maxBytes
}

/** 显式 formatHint 的运行时校验（JSON 边界的值）；未给就返回 undefined，由扩展名/响应头兜底。 */
function requestedSplatHint(input: AssetAcquisitionInput): StreamableSplatFormat | undefined {
  if (input.formatHint === undefined) return undefined
  if (!isStreamableSplatFormat(input.formatHint)) throw new Error(`ASSET_ACQUISITION_FORMAT_HINT_INVALID: formatHint 只接受 ply/spz/splat/sog，读到 ${JSON.stringify(input.formatHint)}`)
  return input.formatHint
}

/** 最后一段路径是否带扩展名：无扩展名的下载端点才允许靠 Content-Disposition/字节判定格式。 */
function hasPathExtension(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? ""
  return /\.[A-Za-z0-9]+$/.test(last)
}

/** 来源事实只记录调用方声明的内容：许可证从不推断，来源页只做语法核对。 */
function sourceFactsOf(input: AssetAcquisitionInput): { sourcePage?: string; license?: string; author?: string } {
  const text = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== "string" || !value.trim()) throw new Error(`ASSET_ACQUISITION_SOURCE_FACT_INVALID: ${field} 必须是非空字符串`)
    return value.trim()
  }
  const sourcePage = input.sourcePage === undefined ? undefined : (() => {
    if (!URL.canParse(input.sourcePage!)) throw new Error("ASSET_ACQUISITION_SOURCE_FACT_INVALID: sourcePage 必须是绝对 URL（含 https:// 与主机名）")
    const url = new URL(input.sourcePage!)
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("ASSET_ACQUISITION_SOURCE_FACT_INVALID: sourcePage 只接受不含凭据的 https 地址")
    return url.href
  })()
  const license = text(input.license, "license")
  const author = text(input.author, "author")
  return {
    ...(sourcePage !== undefined ? { sourcePage } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(author !== undefined ? { author } : {}),
  }
}

/**
 * 同一 URL 已取回过的字节：只有落地文件**当前真实重算**的 sha256 与记录一致才算命中
 * （fileStamp 同时核对读期间文件没有被改写）。命中只是一条本地事实——它不能说明远端内容没变。
 */
async function reusableFetch(operations: SceneOperations, sourceUrl: string): Promise<{ path: string; bytes: Buffer; resourceId: string; version: number; sha256: string; fetchedAt: string; contentType: string } | undefined> {
  const { records } = await operations.resources.authoritySnapshot()
  const candidates = records
    .filter(record => !record.deletedAt && record.networkProvenance?.sourceUrl === sourceUrl)
    .sort((a, b) => b.ref.version - a.ref.version)
  for (const record of candidates) {
    const provenance = record.networkProvenance!
    let path: string
    try { path = localPath(record.ref.original.uri) } catch { continue }
    const stamp = await fileStamp(path).catch(() => undefined)
    if (!stamp?.sha256 || stamp.sha256 !== provenance.sha256) continue
    const bytes = await readFile(path).catch(() => undefined)
    if (!bytes) continue
    return { path, bytes, resourceId: record.ref.resourceId, version: record.ref.version, sha256: stamp.sha256, fetchedAt: provenance.fetchedAt, contentType: provenance.contentType }
  }
  return undefined
}

/**
 * 复用已登记落地文件的**流式**版本：只按 fileStamp（内部流式 hash）核对，绝不 readFile/arrayBuffer。
 * 大 3DGS 原件（几 GB）走这条；命中同样只是本地事实，不能说明远端未变。
 */
async function reusableLanding(operations: SceneOperations, sourceUrl: string): Promise<{ path: string; bytes: number; resourceId: string; version: number; sha256: string; fetchedAt: string; contentType: string } | undefined> {
  const { records } = await operations.resources.authoritySnapshot()
  const candidates = records
    .filter(record => !record.deletedAt && record.networkProvenance?.sourceUrl === sourceUrl)
    .sort((a, b) => b.ref.version - a.ref.version)
  for (const record of candidates) {
    const provenance = record.networkProvenance!
    let path: string
    try { path = localPath(record.ref.original.uri) } catch { continue }
    const stamp = await fileStamp(path).catch(() => undefined)
    if (!stamp?.sha256 || stamp.sha256 !== provenance.sha256) continue
    return { path, bytes: stamp.size, resourceId: record.ref.resourceId, version: record.ref.version, sha256: stamp.sha256, fetchedAt: provenance.fetchedAt, contentType: provenance.contentType }
  }
  return undefined
}

/** 本地文件按 stat 后的真实大小守住上限，再整块读入（本地原件不复制，只读）。 */
async function boundedLocalRead(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`ASSET_ACQUISITION_FILE_NOT_FOUND: 本地文件不存在：${path}`)
    throw error
  })
  if (!info.isFile()) throw new Error(`ASSET_ACQUISITION_NOT_A_FILE: 不是普通文件：${path}`)
  if (!info.size) throw new Error(`ASSET_ACQUISITION_EMPTY_FILE: 空文件：${path}`)
  if (info.size > maxBytes) throw new Error(`ASSET_ACQUISITION_SIZE_LIMIT: ${path} 有 ${info.size} 字节，超过本次上限 ${maxBytes}。可采取的动作：提高 maxBytes（上限 64 MiB）或换更小的资产。`)
  return readFile(path)
}

/** 记录上的清单指针（每次获取都会把 `清单:` 换成最近一份）。 */
function recordedManifestPath(record: ResourceRecord): string | undefined {
  return (record.tags ?? []).filter(tag => tag.startsWith("清单:")).pop()?.slice("清单:".length) || undefined
}

/**
 * 复用路径读回上一次的清单（只读，不新建）：它是**记录**，不是重新核对。
 * 读不到（指针缺失/文件被清掉/JSON 坏了）就返回 undefined——调用侧用旧产物本身能核的事实兜底并如实说明。
 */
async function readRecordedManifest(record: ResourceRecord): Promise<any | undefined> {
  const path = recordedManifestPath(record)
  if (!path) return undefined
  try { return JSON.parse(await readFile(path, "utf8")) } catch { return undefined }
}

/** 自包含 GLB 的结构/尺度事实：唯一口径（formats.parseAsset → assetBounds），新建与复用都走它。 */
async function modelFacts(glbPath: string, json: any): Promise<AssetAcquisitionResult["model"]> {
  const parsed = await parseAsset(glbPath, GLTF_SOURCE)
  const bounds = assetBounds(parsed, parsed.source)
  const size = bounds ? [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as [number, number, number] : undefined
  // 原型检查的另外三项（法线/材质通道/底面）只读组装结果的 JSON：与 nodes/meshes/materials 同一条读数通道，
  // 不另立解析器。缺读数时省略字段，由调用侧如实告警——不推断"没问题"。
  const primitives: any[] = Array.isArray(json?.meshes) ? json.meshes.flatMap((mesh: any) => Array.isArray(mesh?.primitives) ? mesh.primitives : []) : []
  const withNormals = primitives.filter(primitive => primitive?.attributes?.NORMAL !== undefined).length
  const materials: any[] = Array.isArray(json?.materials) ? json.materials : []
  return {
    nodes: (parsed.metadata.nodes as unknown[] | undefined)?.length ?? json?.nodes?.length ?? 0,
    meshes: (parsed.metadata.meshCount as number | undefined) ?? json?.meshes?.length ?? 0,
    materials: json?.materials?.length ?? 0,
    images: json?.images?.length ?? 0,
    ...(size ? { sizeM: size.map(value => Number(value.toFixed(6))) as [number, number, number] } : {}),
    ...(bounds ? { bounds: { min: bounds.min.map(value => Number(value.toFixed(6))) as [number, number, number], max: bounds.max.map(value => Number(value.toFixed(6))) as [number, number, number] }, bottomM: Number(Math.min(bounds.min[2], bounds.max[2]).toFixed(6)) } : {}),
    ...(primitives.length ? { normals: { primitives: primitives.length, withNormals, missing: primitives.length - withNormals } } : {}),
    ...(materials.length ? { materialChannels: materials.map(material => [...new Set([...Object.keys(material?.pbrMetallicRoughness ?? {}), ...Object.keys(material ?? {}).filter(key => /texture$/i.test(key))])]) } : {}),
  }
}

/** 原型检查结论只写"事实缺口"与可采取的动作；不通过时由 scene_mount 拒绝复制（PROTOTYPE_BOUNDS_UNAVAILABLE）。 */
function prototypeWarnings(model: AssetAcquisitionResult["model"]): string[] {
  const warnings: string[] = []
  if (model.normals && model.normals.missing > 0) warnings.push(`原型检查：${model.normals.missing}/${model.normals.primitives} 个网格图元没有 NORMAL 法线数据（光照会走实现缺省，造型本身仍可判）。可采取的动作：在源工具里补算法线后重新获取。`)
  if (model.bounds === undefined) warnings.push("原型检查：几何包围盒不可得（造型范围/底面/尺度都不可判定）。可采取的动作：确认原件含可解码几何后重新获取；这份原型挂载进场景时会被 scene_mount 拒绝（除非显式 alignBottomToSurface:false 按原点落位）。")
  return warnings
}

/**
 * 3DGS 原件的只读事实：走 formats.parseAsset 的同一解析（kind=splat、metadata.format/vertexCount/aabb），
 * 尺度换算也走 assetBounds——与登记、挂载同一条口径，不另立点云解析器。
 */
async function splatModelFacts(path: string): Promise<SplatAcquisitionResult["model"]> {
  const parsed = await parseAsset(path)
  const metadata = parsed.metadata as { format?: unknown; vertexCount?: unknown; gaussianProperties?: unknown }
  const format = (typeof metadata.format === "string" ? metadata.format : "") as StreamableSplatFormat
  const bounds = assetBounds(parsed, parsed.source)
  const size = bounds ? [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as [number, number, number] : undefined
  return {
    nodes: 0, meshes: 0, materials: 0, images: 0,
    format,
    gaussian: format === "spz" || format === "splat" || metadata.gaussianProperties === true,
    ...(typeof metadata.vertexCount === "number" ? { vertexCount: metadata.vertexCount } : {}),
    ...(size ? { sizeM: size.map(value => Number(value.toFixed(6))) as [number, number, number] } : {}),
    ...(bounds ? { bounds: { min: bounds.min.map(value => Number(value.toFixed(6))) as [number, number, number], max: bounds.max.map(value => Number(value.toFixed(6))) as [number, number, number] }, bottomM: Number(Math.min(bounds.min[2], bounds.max[2]).toFixed(6)) } : {}),
  }
}

/** 落地目录内写入原件副本时避免同名互相覆盖：重名时按内容哈希前缀区分，绝不静默改写。 */
function uniqueLandingName(name: string, bytes: Buffer, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const prefixed = `${digestOf(bytes).slice(0, 8)}-${name}`
  if (used.has(prefixed)) throw new Error(`ASSET_ACQUISITION_SOURCE_NAME_CONFLICT: 落地目录里已有 ${prefixed}`)
  used.add(prefixed)
  return prefixed
}

/**
 * 获取一个公开模型资产并复用 SceneOperations.import / ResourceLibrary 登记。
 * signal：预检等待、读体、依赖枚举与落地前的闸口都响应它；取消按取消类别原样上抛（用户停止不当成"依赖缺失"，
 * 也不再把剩下的依赖枚举完），取消后不落文件、不登记资源；进入 authority 提交后按实际结果。
 * cwd：相对 path 的解析基准——工具/命令传会话 header.cwd（宿主进程 cwd 是代码根），省略才回落 process.cwd()。
 * 复用命中（同一 URL 已登记、落地文件哈希与记录一致、本次组装结果就是那份字节）时不新建落地目录、
 * 不重新登记：直接沿既有记录与旧产物返回，带 sceneId 时用 operations.mount 挂载。
 */
export async function acquireAsset(operations: SceneOperations, input: AssetAcquisitionInput, dependencies: AssetAcquisitionDependencies = {}): Promise<AssetAcquisitionResult> {
  const signal = dependencies.signal
  const hostResolver = dependencies.resolve ?? defaultHostResolver
  // 相对 path 的基准：会话 cwd 由工具/命令传进来；省略才用进程 cwd（独立调用 operation 的老行为）。
  const cwd = dependencies.cwd ?? process.cwd()
  const maxBytes = maxBytesOf(input.maxBytes)
  if ((input.url === undefined) === (input.path === undefined)) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: 需要且只需要给出 url（公开 https 直链）或 path（本地文件）之一")
  if (input.url !== undefined && (typeof input.url !== "string" || !input.url.trim())) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: url 必须是非空字符串")
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.trim())) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: path 必须是非空字符串")
  if (input.maxBytes !== undefined && typeof input.maxBytes !== "number") throw new Error("ASSET_ACQUISITION_MAX_BYTES_INVALID: maxBytes 必须是整数（字节）")
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== "string" || !tag.trim()))) throw new Error("ASSET_ACQUISITION_TAGS_INVALID: tags 必须是非空字符串数组")
  const facts = sourceFactsOf(input)
  const warnings: string[] = []
  if (facts.license === undefined) warnings.push("未提供 license：本模块不推断许可证，资源标签里不会写许可。可采取的动作：先用 web_fetch 读来源页/许可页，拿到明确的许可名称后用 license 传入并重跑（也可用 asset_edit 补标签）。")
  signal?.throwIfAborted()
  await assertMountTarget(operations, input.sceneId, input.parentId)
  signal?.throwIfAborted()

  const state: AcquisitionState = { files: new Map(), dependencies: [], originals: [], networkBytes: 0, diskBytes: 0, networkAttempts: 0, networkRetries: 0 }
  const fetched = new Map<string, Buffer>()
  /** 远端依赖：绝对 URL 原样、相对 URI 按主文件 URL 解析；每个地址都先过 SSRF 预检。 */
  const networkReader = (base: URL): DependencyReader => async (uri: string) => {
    const target = await assertPublicHttpsURL(new URL(uri, base).href, hostResolver, signal)
    const cached = fetched.get(target.href)
    if (cached) return { bytes: cached, source: "network", origin: target.href, name: decodedName(basename(target.pathname)) }
    const allowance = maxBytes - state.networkBytes
    if (allowance <= 0) throw new Error(`ASSET_ACQUISITION_SIZE_LIMIT: 已取回 ${state.networkBytes} 字节，达到本次上限 ${maxBytes}`)
    // 短暂故障（中途断流/超时/5xx）在传输层内有界重试；已取回字节按到达量计费，重试只是拿剩余额度。
    const { bytes } = await fetchPublicHttpsBytesWithRetry(target, hostResolver, allowance, {
      transport: dependencies.transport, signal, acceptHeader: ACCEPT_HEADER, timeouts: dependencies.timeouts, retry: dependencies.retry,
      onBytes: count => { state.networkBytes += count },
      // 尝试数在发起前就记、重试数是第 2 次起的尝试：失败路径上的计数同样如实。
      onAttempt: attempt => { state.networkAttempts += 1; if (attempt > 1) state.networkRetries += 1 },
    })
    fetched.set(target.href, bytes)
    return { bytes, source: "network", origin: target.href, name: decodedName(basename(target.pathname)) }
  }
  /** 本地依赖：只允许资产目录树内的相对路径。 */
  const localReader = (root: string): DependencyReader => async (uri: string) => {
    const target = containedPath(root, uri)
    const bytes = await boundedLocalRead(target, maxBytes)
    state.diskBytes += bytes.length
    return { bytes, source: "file", origin: target, name: safeRelativeName(uri, "依赖 URI") }
  }
  /**
   * 包内依赖：与其它入口同一条相对规则——依赖先按主资产所在成员目录归一（models/box/Box.gltf
   * 里的 box.bin 指 models/box/box.bin，../textures/a.png 指同一包内的兄弟目录），再回退到包根同名成员。
   * 只有归一后仍越出包根的引用才拒绝（真正指到包外），找不到就是缺件，绝不回退到网络。
   */
  const archiveReader = (baseDir: string, members: Map<string, ZipEntry>, archiveBytes: Buffer, label: string): DependencyReader => async (uri: string) => {
    const keys = archiveMemberCandidates(baseDir, uri)
    if (!keys.length) throw new Error(`ASSET_ACQUISITION_PATH_UNSAFE: 依赖「${uri}」按包内成员目录 ${baseDir || "<包根>"} 归一后越出压缩包根（拒绝包外路径与绝对路径）。可采取的动作：确认包内 .gltf 的相对引用没有指到压缩包之外。`)
    const entry = keys.map(key => members.get(key)).find(member => member !== undefined)
    if (!entry) throw new Error(`ASSET_ACQUISITION_ARCHIVE_MEMBER_MISSING: ${label} 内没有依赖「${uri}」（按成员目录 ${baseDir || "<包根>"} 与包根都找过：${keys.join("、")}）`)
    return { bytes: readZipEntry(archiveBytes, entry, maxBytes), source: "archive", origin: `${label}:${entry.name}`, name: entry.name }
  }

  // 本地输入先按 cwd 定成绝对路径：记进清单的就是真正读到的那个文件，不是"某个同名相对名"。
  const localInput = input.path === undefined ? undefined : localPath(input.path.trim(), cwd)
  const inputFacts: AssetAcquisitionResult["acquisition"]["input"] = input.url !== undefined ? { kind: "url", url: input.url.trim() } : { kind: "path", path: localInput! }
  const acquiredAt = new Date().toISOString()
  let contentType: string | undefined
  let mainName: string
  let mainBytes: Buffer
  let mainSource: AssetSourceKind
  let mainOrigin: string
  let read: DependencyReader
  let requested = false
  let reused: Awaited<ReturnType<typeof reusableFetch>>
  let sourceUrl: string | undefined

  if (input.url !== undefined) {
    const url = await assertPublicHttpsURL(input.url.trim(), hostResolver, signal)
    sourceUrl = url.href
    mainName = decodedName(basename(url.pathname)) || "asset"
    mainOrigin = url.href
    reused = input.refresh === true ? undefined : await reusableFetch(operations, url.href)
    if (reused) {
      mainBytes = reused.bytes
      mainSource = "network"
      contentType = reused.contentType
      read = networkReader(url)
    } else {
      signal?.throwIfAborted()
      const response = await fetchPublicHttpsBytesWithRetry(url, hostResolver, maxBytes, {
        transport: dependencies.transport, signal, acceptHeader: ACCEPT_HEADER, timeouts: dependencies.timeouts, retry: dependencies.retry,
        onBytes: count => { state.networkBytes += count },
        onAttempt: attempt => { state.networkAttempts += 1; if (attempt > 1) state.networkRetries += 1 },
      })
      contentType = response.contentType
      mainBytes = response.bytes
      mainSource = "network"
      requested = true
      read = networkReader(url)
    }
  } else {
    const path = localInput!
    mainName = basename(path)
    mainOrigin = path
    mainBytes = await boundedLocalRead(path, maxBytes)
    state.diskBytes += mainBytes.length
    mainSource = "file"
    read = localReader(dirname(path))
  }

  signal?.throwIfAborted()
  // 外层容器形态与主资产形态分开记：ZIP 里包的是 glTF/GLB，两者都要如实说出来。
  const container = containerKind(mainBytes)
  let assetKind: "glb" | "gltf" = container === "glb" ? "glb" : "gltf"
  if (container !== "zip" && input.entry !== undefined) warnings.push(`entry「${input.entry}」只在 ZIP 容器内有意义，本次主文件不是压缩包，已忽略。`)
  let entryName = mainName
  let rawZip: { bytes: Buffer; label: string; name: string; origin: string; path?: string } | undefined
  if (container === "zip") {
    const label = `压缩包 ${mainOrigin}`
    // 压缩包自身的名字/出处单独留一份：manifest 只指向 URL 的话，"原件到手"就只剩一个地址。
    rawZip = { bytes: mainBytes, label, name: mainName, origin: mainOrigin, ...(mainSource === "file" ? { path: mainOrigin } : {}) }
    const directory = readZipDirectory(mainBytes)
    const selected = selectZipEntry(directory, input.entry, label)
    // 成员名先过同一条路径边界，并且**用核过的最终名字**（`./` 前缀、反斜杠、百分号编码在这里一次归一）：
    // 越界条目在读出任何字节之前就拒绝（自动选中与显式 entry 都一样）。
    const finalName = safeRelativeName(selected.name, "压缩包成员名")
    entryName = finalName
    const members = new Map<string, ZipEntry>()
    for (const member of directory) if (!members.has(normalizedURI(member.name))) members.set(normalizedURI(member.name), member)
    const memberBytes = readZipEntry(mainBytes, selected, maxBytes)
    // 包内成员按自己的字节再判一次形态：ZIP 里放 .glb、.gltf 都支持，嵌套压缩包明确拒绝。
    const memberKind = containerKind(memberBytes)
    if (memberKind === "zip") throw new Error(`ASSET_ACQUISITION_NESTED_ARCHIVE_UNSUPPORTED: ${label} 内的 ${selected.name} 仍是压缩包，本操作只解一层。可采取的动作：先自行解出内层压缩包再获取。`)
    assetKind = memberKind
    mainBytes = memberBytes
    mainSource = "archive"
    mainOrigin = `${label}:${finalName}`
    mainName = finalName
    read = archiveReader(posix.dirname(finalName).replace(/^\.$/, ""), members, rawZip.bytes, label)
  }

  const { glb: assembled, source: sourceJSON } = await toSelfContainedGLB(assetKind, mainBytes, read, state, signal)
  if (assembled.length > maxBytes) throw new Error(`ASSET_ACQUISITION_SIZE_LIMIT: 组装后的 GLB ${assembled.length} 字节超过本次上限 ${maxBytes}。可采取的动作：提高 maxBytes（上限 64 MiB）或换更小的资产。`)
  const assembledJSON = glbJSON(assembled)
  const remainingExternal = externalURIs(assembledJSON)
  if (remainingExternal.length) throw new Error(`ASSET_ACQUISITION_EXTERNAL_DEPENDENCY: 组装后仍引用外部文件：${remainingExternal.join(", ")}`)
  // 实际用到的资产文件（本地原件/包内成员/直链字节）与压缩包原件都进清单：
  // 网络/包内字节复制进落地目录，本地原件保留原位只记路径与哈希。
  state.originals.push({ name: mainName, bytes: mainBytes, source: mainSource, origin: mainOrigin })
  if (rawZip) state.originals.push({ name: rawZip.name, bytes: rawZip.bytes, source: rawZip.path === undefined ? "network" : "file", origin: rawZip.origin })

  const assembledSha = digestOf(assembled)
  const fetchedAt = reused?.fetchedAt ?? acquiredAt
  // 提交点前的取消闸：abort 之后不落文件、不登记资源、也不挂载。
  signal?.throwIfAborted()
  // 复用命中（同一 URL 已登记 + 落地文件按当前字节重算的哈希与记录一致 + 本次组装结果就是那份字节）：
  // 不再新建 landing/GLB/清单，也不重新 import——旧实现每次都把整份 GLB 与全部原件再复制一遍，
  // 大资产（几十到几百 MB 的 glTF/纹理包）每调一次就多出一份重复文件。这里直接沿既有记录与旧产物：
  // 事实从旧清单读回（读不到就用旧产物本身能核的重算），标签/目录变化沿原记录更新（不新增版本、不建任务表），
  // 需要挂载就挂载。取消/失败时没有任何本次新建的产物要清理，所以这一段放在落地 try 之外。
  if (reused && assembledSha === reused.sha256) {
    const record = await operations.resources.get(reused.resourceId, reused.version)
    const manifest = await readRecordedManifest(record)
    const pointer = recordedManifestPath(record)
    if (!manifest) warnings.push(`复用命中但旧清单读不到（${pointer ? `清单标签指向 ${pointer}` : "记录上没有 清单: 标签"}）：本次只给旧产物本身能核的事实——结构/尺度按落地 GLB 重算，依赖清单与原件清单为空，不假装有。`)
    const dependencies: AssetAcquisitionDependencyFact[] = Array.isArray(manifest?.dependencies) ? manifest.dependencies : []
    const embedded = manifest?.embedded ?? embeddedFacts(sourceJSON)
    const sourceFiles: AssetAcquisitionSourceFile[] = Array.isArray(manifest?.sourceFiles) ? manifest.sourceFiles : []
    const model = manifest?.model ?? await modelFacts(reused.path, assembledJSON)
    warnings.push(...prototypeWarnings(model))
    // 元数据沿原记录更新：事实标签取并集（不清掉上一次记下的来源事实），清单指针仍指旧清单（本次没写新清单）。
    const sourceLabel = sourceUrl === undefined ? "本地文件" : new URL(sourceUrl).host
    const mintedTags = [
      ...(input.tags ?? []),
      `来源:${sourceLabel}`,
      ...(facts.license !== undefined ? [`许可:${facts.license}`] : []),
      ...(facts.sourcePage !== undefined ? [`来源页:${facts.sourcePage}`] : []),
      ...(facts.author !== undefined ? [`作者:${facts.author}`] : []),
      ...(pointer !== undefined ? [`清单:${pointer}`] : []),
    ]
    const previousTags = (record.tags ?? []).filter(tag => !tag.startsWith("清单:"))
    const tags = [...new Set([...previousTags, ...mintedTags])]
    const folder = input.folder ?? (record.folder || undefined) ?? `获取资产/${sourceLabel}`
    const unchanged = record.folder === folder && JSON.stringify(record.tags ?? []) === JSON.stringify(tags)
    const resource = unchanged ? record : await operations.resources.update(record.ref.resourceId, { tags, folder })
    // 物理化只在调用方**显式**要求时动作：复用就默认不重跑派生（record 已有状态原样保留），
    // 语义与 scene_import 的同一字段一致（false 落 skipped 标记、true/strategy 重新调度）。
    if (resource.parsed.kind === "mesh") {
      if (input.physicalize === false) await notePhysicalizationSkipped(operations.resources, resource.ref)
      else if (input.physicalize === true || input.physicalizeStrategy !== undefined || input.physicalizeUsage !== undefined) schedulePhysicalization(operations.resources, resource.ref, { strategy: input.physicalizeStrategy, usage: input.physicalizeUsage, voxelSizeM: input.physicalizeVoxelSizeM })
    }
    const mounted = input.sceneId
      ? await operations.mount({ sceneId: input.sceneId, resourceId: resource.ref.resourceId, version: resource.ref.version, entityId: input.entityId, parentId: input.parentId, transform: input.transform })
      : undefined
    const verification = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
    if (!verification.valid) throw new Error(`ASSET_ACQUISITION_VERIFY_FAILED: ${JSON.stringify(verification)}`)
    return {
      resource,
      verification,
      ...(mounted ? { snapshot: mounted.snapshot, entityId: mounted.entityId } : {}),
      acquisition: {
        input: inputFacts, container, entry: entryName,
        dependencies, embedded,
        glb: { path: reused.path, bytes: reused.bytes.length, sha256: reused.sha256, externalDependencies: 0 },
        budget: { limitBytes: maxBytes, networkBytes: state.networkBytes, diskBytes: state.diskBytes, reusedBytes: reused.bytes.length, networkAttempts: state.networkAttempts, networkRetries: state.networkRetries },
        download: {
          requested, reusedFromCache: true,
          reusedFrom: { resourceId: reused.resourceId, version: reused.version, path: reused.path, sha256: reused.sha256, fetchedAt: reused.fetchedAt, verified: "sha256-recomputed" as const },
          acquiredAt, ...(contentType !== undefined ? { contentType: contentType.split(";", 1)[0]!.trim().toLowerCase() } : {}),
        },
      },
      model, sourceFacts: facts,
      ...(pointer !== undefined ? { manifestPath: pointer } : {}),
      sourceFiles,
      // 资源记录上原有的网络来源事实照实带回（复用没有新写 provenance）；本次是否发过请求看 download.requested。
      ...(record.networkProvenance ? { provenance: record.networkProvenance } : {}),
      alreadyPresent: true as const,
      warnings: [...warnings, "复用命中：沿用同一 URL 已登记的落地 GLB 与旧清单，**没有**新建落地目录、没有重新登记、没有重跑物理化派生（需要重跑请显式给 physicalize/physicalizeStrategy/physicalizeUsage）；本次按当前文件重算 sha256 核对，仍不能据此断言远端内容未变——要确认远端时用 refresh:true 重新下载。"],
    }
  }
  const landing = join(operations.resources.downloadRoot, randomUUID())
  const glbPath = join(landing, "asset.glb")
  const manifestPath = join(landing, "manifest.json")
  const sourceRoot = join(landing, "source")
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
  try {
    // 网络/包内字节复制到 landing/source（本地原件保留原位，只记路径与哈希）。
    const used = new Set<string>()
    const sourceFiles: AssetAcquisitionSourceFile[] = []
    for (const original of state.originals) {
      const bytes = original.bytes
      const fact: AssetAcquisitionSourceFile = { path: original.source === "file" ? original.origin : "", source: original.source, origin: original.origin, bytes: bytes.length, sha256: digestOf(bytes), copied: original.source !== "file" }
      if (fact.copied) {
        const target = join(sourceRoot, uniqueLandingName(safeRelativeName(original.name, "原件名"), bytes, used))
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" })
        fact.path = target
      }
      sourceFiles.push(fact)
    }
    // 结构/尺度事实取自原生解析（formats.parseAsset → glbSceneBounds + sourceTransform）：
    // 与 ResourceLibrary 登记时是同一条口径，不另算一份包围盒。sizeM 是内部 Z-up 世界帧下的尺寸。
    await writeFile(glbPath, assembled, { mode: 0o600, flag: "wx" })
    const model = await modelFacts(glbPath, assembledJSON)
    warnings.push(...prototypeWarnings(model))
    const provenance: NetworkAssetProvenance | undefined = sourceUrl === undefined ? undefined : {
      sourceUrl, fetchedAt, sha256: assembledSha, byteLength: assembled.length, glbVersion: "2.0",
      contentType: (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase(), maxBytes, redirectsFollowed: 0, externalDependencies: 0,
    }
    const manifest = {
      generator: "lyapunov-scene-kit/asset-acquisition",
      input: inputFacts, container, entry: entryName,
      ...(rawZip ? { archive: { origin: rawZip.origin, path: rawZip.path ?? null, bytes: rawZip.bytes.length, sha256: digestOf(rawZip.bytes), retained: rawZip.path === undefined } } : {}),
      sourceFacts: facts, acquiredAt, fetchedAt,
      dependencies: state.dependencies, embedded: embeddedFacts(sourceJSON), sourceFiles,
      glb: { path: glbPath, bytes: assembled.length, sha256: assembledSha, glbVersion: "2.0" },
      model,
      budget: { limitBytes: maxBytes, networkBytes: state.networkBytes, diskBytes: state.diskBytes, reusedBytes: reused?.bytes.length ?? 0, networkAttempts: state.networkAttempts, networkRetries: state.networkRetries },
      note: "许可证/作者/来源页只记录调用方声明的事实（本工具不推断许可）；来源页本身不会被抓取。相对依赖、dataURI 与已内嵌纹理都已并入自包含 GLB。",
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" })
    // 首次 authority 提交前的取消闸：落盘期间被取消就不登记资源；异常走 catch 里对未登记 landing 的清理。
    signal?.throwIfAborted()
    const imported = await operations.import({
      path: glbPath, sceneId: input.sceneId, name: input.name, resourceId: input.resourceId, entityId: input.entityId, parentId: input.parentId, transform: input.transform,
      source: GLTF_SOURCE,
      ...(provenance ? { networkProvenance: provenance } : {}),
      ...(input.physicalize === undefined ? {} : { physicalize: input.physicalize }),
      ...(input.physicalizeStrategy === undefined ? {} : { physicalizeStrategy: input.physicalizeStrategy }),
      ...(input.physicalizeUsage === undefined ? {} : { physicalizeUsage: input.physicalizeUsage }),
      ...(input.physicalizeVoxelSizeM === undefined ? {} : { physicalizeVoxelSizeM: input.physicalizeVoxelSizeM }),
    })
    // 标签只写可核对的事实（来源/许可/来源页/作者/清单），不给资产贴"可用/完整"结论。
    const sourceLabel = sourceUrl === undefined ? "本地文件" : new URL(sourceUrl).host
    const mintedTags = [
      ...(input.tags ?? []),
      `来源:${sourceLabel}`,
      ...(facts.license !== undefined ? [`许可:${facts.license}`] : []),
      ...(facts.sourcePage !== undefined ? [`来源页:${facts.sourcePage}`] : []),
      ...(facts.author !== undefined ? [`作者:${facts.author}`] : []),
      `清单:${manifestPath}`,
    ]
    // 内容相同即同一条记录（resources.import 去重），而 resources.update 是**整体替换**标签：
    // 直接用本次标签会把上一次获取记录下的来源事实抹掉（例如同一份字节先经网络、后经本地 ZIP）。
    // 因此事实标签取并集；只有 清单: 指针换成本次的（每次获取都写一份新清单，留着旧的只会越堆越长）。
    const previous = (imported.resource.tags ?? []).filter(tag => !tag.startsWith("清单:"))
    const tags = [...new Set([...previous, ...mintedTags])]
    // import 新建的记录目录是空串（不是 undefined），去重命中时才是记录里的真实目录。
    const existingFolder = imported.resource.folder || undefined
    const folder = input.folder ?? existingFolder ?? `获取资产/${sourceLabel}`
    // 事实没变时不写标签：不因为"再获取一次"就多出一个元数据版本。
    const unchanged = imported.resource.folder === folder && JSON.stringify(imported.resource.tags ?? []) === JSON.stringify(tags)
    const resource = unchanged ? imported.resource : await operations.resources.update(imported.resource.ref.resourceId, { tags, folder })
    const verification = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
    if (!verification.valid) throw new Error(`ASSET_ACQUISITION_VERIFY_FAILED: ${JSON.stringify(verification)}`)
    const alreadyPresent = (imported.resource as ResourceRecord & { alreadyPresent?: boolean }).alreadyPresent === true ? true as const : undefined
    return {
      resource,
      verification,
      ...(imported.snapshot ? { snapshot: imported.snapshot } : {}),
      ...(imported.entityId ? { entityId: imported.entityId } : {}),
      acquisition: {
        input: inputFacts, container, entry: entryName,
        dependencies: state.dependencies, embedded: embeddedFacts(sourceJSON),
        glb: { path: glbPath, bytes: assembled.length, sha256: assembledSha, externalDependencies: 0 },
        budget: { limitBytes: maxBytes, networkBytes: state.networkBytes, diskBytes: state.diskBytes, reusedBytes: reused?.bytes.length ?? 0, networkAttempts: state.networkAttempts, networkRetries: state.networkRetries },
        download: {
          requested, reusedFromCache: reused !== undefined,
          ...(reused ? { reusedFrom: { resourceId: reused.resourceId, version: reused.version, path: reused.path, sha256: reused.sha256, fetchedAt: reused.fetchedAt, verified: "sha256-recomputed" as const } } : {}),
          acquiredAt, ...(contentType !== undefined ? { contentType: contentType.split(";", 1)[0]!.trim().toLowerCase() } : {}),
        },
      },
      model, sourceFacts: facts, manifestPath, sourceFiles,
      ...(provenance ? { provenance } : {}),
      ...(alreadyPresent ? { alreadyPresent } : {}),
      warnings: reused
        ? [...warnings, "本次复用同一 URL 已登记的本地字节（按当前文件重算 sha256 核对），**没有**重新访问远端：不能据此断言远端内容未变；需要确认远端时用 refresh:true 重新下载。"]
        : warnings,
    }
  } catch (error) {
    const registered = await landingIsRegistered(operations, glbPath).catch(() => true)
    if (!registered) await rm(landing, { recursive: true, force: true })
    throw error
  }
}

/**
 * 获取一个公开 **3DGS 直链**（`.spz`/`.ply`/`.splat`）并复用 SceneOperations.import 登记。
 * 与 `acquireAsset` 并列：不做 GLB 组装、不把点云说成网格；字节**流式落盘**，只读文件头校验真实性。
 *  · 预算是 `splatMaxBytes`（默认 8 GiB，硬上限 32 GiB），不是 GLB 的 64 MiB；
 *  · 已登记同 URL 且落地文件哈希一致时走复用（fileStamp 流式核对，不 readFile 整份）；
 *  · HTML/JSON 登录页/错误页按字节拒绝（永久错误，不重试、不登记）；取消时删掉未完成的落地件。
 */
export async function acquireSplatAsset(operations: SceneOperations, input: AssetAcquisitionInput, dependencies: AssetAcquisitionDependencies = {}): Promise<SplatAcquisitionResult> {
  const signal = dependencies.signal
  const hostResolver = dependencies.resolve ?? defaultHostResolver
  const cwd = dependencies.cwd ?? process.cwd()
  const maxBytes = splatMaxBytesOf(input.splatMaxBytes)
  if ((input.url === undefined) === (input.path === undefined)) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: 需要且只需要给出 url（公开 https 直链）或 path（本地文件）之一")
  if (input.url !== undefined && (typeof input.url !== "string" || !input.url.trim())) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: url 必须是非空字符串")
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.trim())) throw new Error("ASSET_ACQUISITION_SOURCE_REQUIRED: path 必须是非空字符串")
  if (input.splatMaxBytes !== undefined && typeof input.splatMaxBytes !== "number") throw new Error("ASSET_ACQUISITION_SPLAT_MAX_BYTES_INVALID: splatMaxBytes 必须是整数（字节）")
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== "string" || !tag.trim()))) throw new Error("ASSET_ACQUISITION_TAGS_INVALID: tags 必须是非空字符串数组")
  const facts = sourceFactsOf(input)
  const warnings: string[] = []
  if (facts.license === undefined) warnings.push("未提供 license：本模块不推断许可证，资源标签里不会写许可。可采取的动作：先用 web_fetch 读来源页/许可页，拿到明确的许可名称后用 license 传入并重跑（也可用 asset_edit 补标签）。")
  signal?.throwIfAborted()
  await assertMountTarget(operations, input.sceneId, input.parentId)
  signal?.throwIfAborted()

  const localInput = input.path === undefined ? undefined : localPath(input.path.trim(), cwd)
  const inputFacts: SplatAcquisitionResult["acquisition"]["input"] = input.url !== undefined ? { kind: "url", url: input.url.trim() } : { kind: "path", path: localInput! }
  const acquiredAt = new Date().toISOString()
  let sourceUrl: string | undefined
  let path: string
  let bytes: number
  let sha256: string
  let contentType = ""
  let fileFact: SplatFileFact | undefined
  let requested = false
  let networkBytes = 0, networkAttempts = 0, networkRetries = 0, diskBytes = 0
  let reused: Awaited<ReturnType<typeof reusableLanding>>
  let landing: string | undefined

  if (input.url !== undefined) {
    const url = await assertPublicHttpsURL(input.url.trim(), hostResolver, signal)
    sourceUrl = url.href
    // 提示优先级：显式 formatHint > URL 扩展名 >（下载中）可信 Content-Disposition；无提示则纯按字节判定。
    const explicitHint = requestedSplatHint(input)
    const urlHint = streamableSplatFormatOf(url.pathname)
    // 保留了旧语义：带扩展名却不是三种可校验格式（.glb/.gltf/.zip/.sog/...）直接明确拒绝，不落 3DGS 路径。
    if (explicitHint === undefined && urlHint === undefined && hasPathExtension(url.pathname)) {
      throw new Error(`ASSET_ACQUISITION_SPLAT_FORMAT_UNSUPPORTED: ${url.pathname} 不是可校验的 .spz/.ply/.splat 直链。可采取的动作：给出这几种格式的资源直链，或用 formatHint 指名格式；分享页先用 scene_asset_resolve 解析。`)
    }
    let headerHint: StreamableSplatFormat | undefined
    reused = input.refresh === true ? undefined : await reusableLanding(operations, url.href)
    if (reused) {
      path = reused.path
      bytes = reused.bytes
      sha256 = reused.sha256
      contentType = reused.contentType
      // 复用已登记原件：优先显式/URL 提示，其次按原落地件扩展名，最后按字节。
      fileFact = await inspectSplatFile(path, explicitHint ?? urlHint ?? streamableSplatFormatOf(path), { maxBytes, signal })
    } else {
      landing = join(operations.resources.downloadRoot, randomUUID())
      await mkdir(landing, { recursive: true, mode: 0o700 })
      const initialHint = explicitHint ?? urlHint
      const destination = join(landing, initialHint ? `asset.${initialHint}` : "asset.download")
      try {
        signal?.throwIfAborted()
        const result = await fetchPublicHttpsFileWithRetry(url, hostResolver, maxBytes, destination, {
          transport: dependencies.transport, signal, acceptHeader: SPLAT_ACCEPT_HEADER, timeouts: dependencies.timeouts, retry: dependencies.retry,
          // 头部先按类型拒绝 HTML；无扩展名时从服务端附件名取格式提示（仍只是提示，不替代字节校验）；真字节再按魔数/文件头复核。
          verifyHeaders: (type, _declared, headers) => {
            if (/^text\/html/i.test(type)) throw new Error(`NETWORK_ASSET_MIME_REJECTED: ${type || "missing"}`)
            if (headerHint === undefined) headerHint = splatFormatFromContentDisposition(headers["content-disposition"])
          },
          verifyFile: async candidate => { fileFact = await inspectSplatFile(candidate, explicitHint ?? urlHint ?? headerHint, { maxBytes, signal }) },
          onBytes: count => { networkBytes += count },
          onAttempt: attempt => { networkAttempts += 1; if (attempt > 1) networkRetries += 1 },
        })
        requested = true
        // 无提示时按字节判定出的真实格式给落地件一个 parseAsset 能识别的扩展名（内容校验优先于一切提示）。
        path = destination
        if (initialHint === undefined) {
          path = join(landing, `asset.${fileFact!.format}`)
          await rename(destination, path)
        }
        bytes = result.bytes
        sha256 = result.sha256
        contentType = result.contentType
      } catch (error) {
        await rm(landing, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
  } else {
    path = localInput!
    // 本地入口同样接受显式 formatHint；无扩展名的本地文件按字节判定。
    fileFact = await inspectSplatFile(path, requestedSplatHint(input) ?? streamableSplatFormatOf(path), { maxBytes, signal })
    const stamp = await fileStamp(path)
    bytes = stamp.size
    sha256 = stamp.sha256!
    diskBytes = bytes
  }
  signal?.throwIfAborted()
  const fact = fileFact!
  const model = await splatModelFacts(path)
  const sourceFiles: AssetAcquisitionSourceFile[] = [{ path, source: sourceUrl === undefined ? "file" : "network", origin: sourceUrl ?? path, bytes, sha256, copied: false }]
  const provenance: NetworkAssetProvenance | undefined = sourceUrl === undefined ? undefined : {
    sourceUrl, fetchedAt: reused?.fetchedAt ?? acquiredAt, sha256, byteLength: bytes, glbVersion: "",
    contentType: (contentType || "").split(";", 1)[0]!.trim().toLowerCase(), maxBytes, redirectsFollowed: 0, externalDependencies: 0,
  }

  // 复用命中：不重新下载、不新建落地目录、不重复登记；沿既有记录与旧产物返回，需要就挂载。
  if (reused) {
    const record = await operations.resources.get(reused.resourceId, reused.version)
    const manifest = await readRecordedManifest(record)
    const pointer = recordedManifestPath(record)
    if (!manifest) warnings.push(`复用命中但旧清单读不到（${pointer ? `清单标签指向 ${pointer}` : "记录上没有 清单: 标签"}）：本次只给旧产物本身能核的事实，不假装有。`)
    const sourceLabel = sourceUrl === undefined ? "本地文件" : new URL(sourceUrl).host
    const mintedTags = [...(input.tags ?? []), `来源:${sourceLabel}`, ...(facts.license !== undefined ? [`许可:${facts.license}`] : []), ...(facts.sourcePage !== undefined ? [`来源页:${facts.sourcePage}`] : []), ...(facts.author !== undefined ? [`作者:${facts.author}`] : []), ...(pointer !== undefined ? [`清单:${pointer}`] : [])]
    const previousTags = (record.tags ?? []).filter(tag => !tag.startsWith("清单:"))
    const tags = [...new Set([...previousTags, ...mintedTags])]
    const folder = input.folder ?? (record.folder || undefined) ?? `获取资产/${sourceLabel}`
    const unchanged = record.folder === folder && JSON.stringify(record.tags ?? []) === JSON.stringify(tags)
    const resource = unchanged ? record : await operations.resources.update(record.ref.resourceId, { tags, folder })
    const mounted = input.sceneId ? await operations.mount({ sceneId: input.sceneId, resourceId: resource.ref.resourceId, version: resource.ref.version, entityId: input.entityId, parentId: input.parentId, transform: input.transform }) : undefined
    const verification = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
    if (!verification.valid) throw new Error(`ASSET_ACQUISITION_VERIFY_FAILED: ${JSON.stringify(verification)}`)
    return {
      resource, verification,
      ...(mounted ? { snapshot: mounted.snapshot, entityId: mounted.entityId } : {}),
      acquisition: {
        input: inputFacts, container: "splat", format: fact.format, path, bytes, sha256, contentType, gaussian: fact.gaussian,
        ...(fact.vertexCount !== undefined ? { vertexCount: fact.vertexCount } : {}),
        ...(fact.gaussianCount !== undefined ? { gaussianCount: fact.gaussianCount } : {}),
        budget: { limitBytes: maxBytes, networkBytes: 0, diskBytes: 0, reusedBytes: bytes, networkAttempts: 0, networkRetries: 0 },
        download: {
          requested: false, reusedFromCache: true,
          reusedFrom: { resourceId: reused.resourceId, version: reused.version, path: reused.path, sha256: reused.sha256, fetchedAt: reused.fetchedAt, verified: "sha256-recomputed" as const },
          acquiredAt, ...(contentType ? { contentType: contentType.split(";", 1)[0]!.trim().toLowerCase() } : {}),
        },
      },
      model, sourceFacts: facts,
      ...(pointer !== undefined ? { manifestPath: pointer } : {}),
      sourceFiles: Array.isArray(manifest?.sourceFiles) ? manifest.sourceFiles : sourceFiles,
      ...(record.networkProvenance ? { provenance: record.networkProvenance } : {}),
      warnings: [...warnings, "复用命中：沿用同一 URL 已登记的原件与旧清单，没有重新下载、没有重复登记；本次按当前文件流式重算 sha256 核对，仍不能据此断言远端内容未变——要确认远端时用 refresh:true。"],
    }
  }

  // 新建：URL 路径写清单并复制原件到落地目录；本地原件保留原位只登记。
  const manifestPath = landing === undefined ? undefined : join(landing, "manifest.json")
  if (manifestPath !== undefined && landing !== undefined) {
    const manifest = {
      generator: "lyapunov-scene-kit/asset-acquisition/splat",
      input: inputFacts, container: "splat", format: fact.format, path, bytes, sha256,
      gaussian: fact.gaussian, ...(fact.vertexCount !== undefined ? { vertexCount: fact.vertexCount } : {}), ...(fact.gaussianCount !== undefined ? { gaussianCount: fact.gaussianCount } : {}),
      sourceFacts: facts, acquiredAt, sourceFiles,
      provenance,
      model,
      note: "3DGS 原件流式落盘后按 formats.parseAsset 登记；未做 GLB 组装、未改写成点云副本。来源事实只记录调用方声明或分享页公开读到的内容。",
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" })
  }
  signal?.throwIfAborted()
  const imported = await operations.import({
    path, sceneId: input.sceneId, name: input.name, resourceId: input.resourceId, entityId: input.entityId, parentId: input.parentId, transform: input.transform,
    source: GLTF_SOURCE,
    ...(provenance ? { networkProvenance: provenance } : {}),
    ...(input.physicalize === undefined ? {} : { physicalize: input.physicalize }),
  })
  const sourceLabel = sourceUrl === undefined ? "本地文件" : new URL(sourceUrl).host
  const mintedTags = [...(input.tags ?? []), `来源:${sourceLabel}`, ...(facts.license !== undefined ? [`许可:${facts.license}`] : []), ...(facts.sourcePage !== undefined ? [`来源页:${facts.sourcePage}`] : []), ...(facts.author !== undefined ? [`作者:${facts.author}`] : []), ...(manifestPath !== undefined ? [`清单:${manifestPath}`] : [])]
  const previous = (imported.resource.tags ?? []).filter(tag => !tag.startsWith("清单:"))
  const tags = [...new Set([...previous, ...mintedTags])]
  const existingFolder = imported.resource.folder || undefined
  const folder = input.folder ?? existingFolder ?? `获取资产/${sourceLabel}`
  const unchanged = imported.resource.folder === folder && JSON.stringify(imported.resource.tags ?? []) === JSON.stringify(tags)
  const resource = unchanged ? imported.resource : await operations.resources.update(imported.resource.ref.resourceId, { tags, folder })
  const verification = await operations.resources.verify(resource.ref.resourceId, resource.ref.version)
  if (!verification.valid) throw new Error(`ASSET_ACQUISITION_VERIFY_FAILED: ${JSON.stringify(verification)}`)
  const alreadyPresent = (imported.resource as ResourceRecord & { alreadyPresent?: boolean }).alreadyPresent === true ? true as const : undefined
  return {
    resource, verification,
    ...(imported.snapshot ? { snapshot: imported.snapshot } : {}),
    ...(imported.entityId ? { entityId: imported.entityId } : {}),
    acquisition: {
      input: inputFacts, container: "splat", format: fact.format, path, bytes, sha256, contentType, gaussian: fact.gaussian,
      ...(fact.vertexCount !== undefined ? { vertexCount: fact.vertexCount } : {}),
      ...(fact.gaussianCount !== undefined ? { gaussianCount: fact.gaussianCount } : {}),
      budget: { limitBytes: maxBytes, networkBytes, diskBytes, reusedBytes: 0, networkAttempts, networkRetries },
      download: {
        requested, reusedFromCache: false, acquiredAt,
        ...(contentType ? { contentType: contentType.split(";", 1)[0]!.trim().toLowerCase() } : {}),
      },
    },
    model, sourceFacts: facts,
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    ...(provenance ? { provenance } : {}),
    sourceFiles,
    warnings,
  }
}

/**
 * 用户给网址时的统一入口：先识别分享页并按**公开元数据**解析，再按内容/扩展名分发到 GLB 或 3DGS 直链。
 * 分享页解析出的直链会带上来源页与读到的许可/作者；不能直接导入的分享页返回可操作的事实（抛结构化错误），
 * 不假装已导入、也不让模型反复猜地址。
 */
export async function acquirePublicAsset(operations: SceneOperations, input: AssetAcquisitionInput, dependencies: AssetAcquisitionDependencies = {}): Promise<PublicAssetAcquisitionResult> {
  if (input.url !== undefined && typeof input.url === "string" && input.url.trim()) {
    const requested = input.url.trim()
    const shareBudget = sharePageTargetOf(requested) ? { limit: splatMaxBytesOf(input.splatMaxBytes), bytes: 0, attempts: 0, retries: 0 } : undefined
    const resolution = await resolveAssetSharePage(requested, {
      resolve: dependencies.resolve, transport: dependencies.transport, signal: dependencies.signal, timeouts: dependencies.timeouts, retry: dependencies.retry,
      ...(shareBudget ? {
        onBytes: (count: number) => { shareBudget.bytes += count },
        onAttempt: (attempt: number) => { shareBudget.attempts++; if (attempt > 1) shareBudget.retries++ },
        budgetRemaining: () => shareBudget.limit - shareBudget.bytes,
      } : {}),
    })
    if (resolution?.kind === "streamed-sog") {
      if (input.resourceId) throw new Error("SSOG_RESOURCE_ID_AMBIGUOUS: 多块层会登记多个资源；请用返回的 resources[]，不能给单一 resourceId")
      if (input.formatHint) throw new Error("SSOG_FORMAT_HINT_INAPPLICABLE: 分享页是多块 SSOG，formatHint 只用于单文件直链")
      if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== "string" || !tag.trim()))) throw new Error("ASSET_ACQUISITION_TAGS_INVALID: tags 必须是非空字符串数组")
      const supplied = sourceFactsOf(input)
      if (supplied.sourcePage && supplied.sourcePage !== resolution.facts.sourcePage) throw new Error("SSOG_SOURCE_PAGE_MISMATCH: 来源页与已解析分享页不符")
      return acquireStreamedSog(operations, {
        manifestUrl: resolution.manifestUrl, sourcePage: resolution.facts.sourcePage,
        title: resolution.facts.title, license: resolution.facts.license ?? supplied.license,
        licenseUrl: resolution.facts.licenseUrl, author: resolution.facts.author ?? supplied.author,
        selectedLod: input.selectedLod, maxBytes: shareBudget!.limit,
        sceneId: input.sceneId, name: input.name, entityId: input.entityId, parentId: input.parentId,
        transform: input.transform, tags: input.tags, folder: input.folder,
      }, {
        resolve: dependencies.resolve, transport: dependencies.transport, signal: dependencies.signal,
        timeouts: dependencies.timeouts, retry: dependencies.retry,
        initialNetworkBytes: shareBudget!.bytes, initialNetworkAttempts: shareBudget!.attempts, initialNetworkRetries: shareBudget!.retries,
      })
    }
    if (resolution?.kind === "unsupported") {
      // 三态显式写进错误：解析成功 ≠ 可获取 ≠ 已导入；本次没有取得任何模型字节、没有登记资源。
      throw new Error(`ASSET_ACQUISITION_SHARE_PAGE_UNSUPPORTED: resolved=true acquirable=false imported=false。${resolution.reason} 可采取的动作：${resolution.actions.join(" ")} 事实：${JSON.stringify(resolution.facts)}`)
    }
    if (resolution?.kind === "direct") {
      input = {
        ...input,
        url: resolution.directUrl,
        sourcePage: input.sourcePage ?? resolution.facts.sourcePage,
        ...(input.license === undefined && resolution.facts.license !== undefined ? { license: resolution.facts.license } : {}),
        ...(input.author === undefined && resolution.facts.author !== undefined ? { author: resolution.facts.author } : {}),
      }
    }
  }
  if (input.selectedLod !== undefined) throw new Error("SSOG_SELECTED_LOD_NOT_APPLICABLE: selectedLod 只适用于已适配的公开 Streamed SOG 分享页")
  // 显式 formatHint 优先：无扩展名的下载端点也能明确走 3DGS 通路（不再误落 64 MiB GLB 入口）。
  if (input.formatHint !== undefined) {
    requestedSplatHint(input) // 运行时校验：非法值在这里就报结构化错误
    return acquireSplatAsset(operations, input, dependencies)
  }
  const hint = input.url ?? input.path
  if (hint !== undefined && streamableSplatFormatOf(hint)) return acquireSplatAsset(operations, input, dependencies)
  if (hint !== undefined && isSplatExtension(hint)) {
    const extension = (/\.[a-z0-9]+$/i.exec(hint.split(/[?#]/, 1)[0]!) ?? [hint])[0]
    throw new Error(`ASSET_ACQUISITION_SPLAT_FORMAT_UNSUPPORTED: ${extension} 当前没有可核验的流式获取通路（只支持 .spz/.ply/.splat）。可采取的动作：换这几种直链，或先用来源工具导出为它们。`)
  }
  return acquireAsset(operations, input, dependencies)
}

export const assetAcquisitionParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Acquire models from public direct URLs or supported share pages. Assemble glTF/ZIP as GLB; stream .spz/.ply/.splat/.sog direct files to disk with byte verification. For public Streamed SOG, select one complete manifest layer and register compressed SOG blocks, defaulting to highest-detail LOD0; selectedLod explicitly changes the layer and insufficient budget never lowers detail silently. With sceneId, mount one group root and every child block atomically and return resources[]. Public layers are derived representations, not the author's original PLY. 3DGS uses splatMaxBytes rather than the GLB 64 MiB limit. Record source page/licence/author only from actual public facts; HTML/login pages and fake ZIPs are not models.",
    examples: [
      { url: "https://example.org/models/chair/chair.gltf", name: "chair", physicalize: false, sourcePage: "https://example.org/models/chair", license: "CC-BY-4.0", author: "Example author" },
      { url: "https://sparkjs.dev/assets/splats/butterfly.spz", name: "butterfly", license: "CC-BY-4.0" },
      { path: "/tmp/downloads/pack.zip", entry: "models/chair/chair.gltf" },
    ],
    properties: {
      url: { type: "string", description: "Public HTTPS direct URL for .glb/.gltf/.zip/.spz/.ply/.splat/.sog, or a SuperSplat /scene/<id> or /s?id=<id> share page. Forbid file://, private/loopback networks, credentials and redirects." },
      path: { type: "string", description: "Local .glb, .gltf or .zip path, such as an archive downloaded elsewhere. Mutually exclusive with url. Resolve relative paths from the session header.cwd, not the host process directory." },
      entry: { type: "string", description: "Primary-asset member path in a ZIP, such as models/chair/chair.gltf. Optional for a single candidate; required when multiple candidates exist, which errors will list." },
      sceneId: { type: "string", description: "Optional target scene; mounting needs no subsequent scene_mount call." },
      name: { type: "string", description: "Optional resource name; defaults to the filename." },
      resourceId: { type: "string" }, entityId: { type: "string" },
      parentId: { type: "string", description: "Optional parent entity; requires sceneId." },
      transform: { type: "object", additionalProperties: false, properties: { position: { type: "array", items: { type: "number" } }, quaternion: { type: "array", items: { type: "number" } }, scale: { type: "array", items: { type: "number" } } } },
      maxBytes: { type: "integer", description: "Byte limit for this GLB/glTF/ZIP acquisition; default and maximum 64 MiB. Archives are read wholly into memory; unpack large archives yourself first. 3DGS direct files use splatMaxBytes." },
      splatMaxBytes: { type: "integer", description: "Aggregate network-byte budget for a 3DGS direct file or public SSOG acquisition; default 8 GiB, hard maximum 32 GiB. SSOG counts pages/manifests and bytes actually received during failed attempts." },
      selectedLod: { type: "integer", description: "Public Streamed SOG share pages only. Defaults to highest-detail LOD0. Validate the available range against the actual manifest; insufficient budget reports selectable layers without automatic detail reduction." },
      formatHint: { oneOf: [{ type: "string", const: "ply" }, { type: "string", const: "spz" }, { type: "string", const: "splat" }, { type: "string", const: "sog" }], description: "Format hint for a 3DGS single-file direct URL without an extension; includes sog. A hint does not replace actual byte/ZIP-content validation. Multi-block SSOG pages use selectedLod." },
      physicalize: { type: "boolean", description: "Optional; follows scene_import defaults, including automatic collision derivation after GLB registration. Pass false to skip, for example for environment/module assets." },
      physicalizeStrategy: { oneOf: [{ type: "string", const: "auto" }, { type: "string", const: "convex_hull" }, { type: "string", const: "voxel_boxes" }, { type: "string", const: "coacd" }, { type: "string", const: "triangle_mesh" }], description: "Optional physicalization strategy to forward; ineffective when physicalize:false." },
      physicalizeUsage: { oneOf: [{ type: "string", const: "dynamic" }, { type: "string", const: "static" }, { type: "string", const: "environment" }], description: "Optional derivation usage, using the scene_import enum; default dynamic. Acquired environments/buildings/ground/modules use environment: derive per-source-node surface collision without filling interiors or sealing rooms/passages with convex hulls, and assemble static bodies. Default triangle_mesh evaluates whether each convex hull is identical to its source; concave solids route to convex decomposition and open shells to unfilled surface voxels, recorded in routed. Explicit voxel_boxes/coacd are also allowed. convex_hull/SDF are rejected with failed: hulls seal rooms, while SDF consumers already work (sim-mujoco mjGEOM_SDF consumes shape:\"sdf\" in real collisions) but the environment/SDF-fixture convention is not calibrated. Do not relax the restriction or silently switch representation. Derivation is asynchronous; physicalization is usually pending on return. Wait for asset_list status=ok before mounting collision-bearing assets." },
      physicalizeVoxelSizeM: { type: "number", description: "Optional metres: fixed surface-voxel edge length, meaningful only for voxel_boxes." },
      folder: { type: "string", description: "Resource folder; defaults according to source to the product's acquired-assets folder for the host or local files." },
      tags: { type: "array", items: { type: "string" }, description: "Additional resource tags; the tool appends factual source/licence/source-page/author/manifest tags." },
      sourcePage: { type: "string", description: "Source-page HTTPS URL for recording/checking only; the tool does not fetch that page." },
      license: { type: "string", description: "Licence name read from the actual source/licence page, such as CC-BY-4.0. The tool never infers a licence; omission adds no licence tag and returns a reminder." },
      author: { type: "string", description: "Author/copyright holder read from the source page; omitted values are not written." },
      refresh: { type: "boolean", description: "Default false: reuse a registered URL when local byte hashes still match, returning the existing record and artifact without downloading, creating a new landing directory or registering again. sceneId still mounts normally. Explicit physicalize/physicalizeStrategy/physicalizeUsage is required to rerun physicalization. true forces a new download and materialization." },
    },
  },
}

/** 工具 exec / 命令 invocation 的最小形状：会话身份（agent）与相对路径基准（会话工作目录）。 */
export interface SessionScope { agent?: { session?: { header?: { cwd?: string } } } | undefined }

export interface AssetAcquisitionToolOptions {
  /**
   * 复用已有 Scene/资源库装配：本工具只做"获取 + 整理 + 调 scene_import"，不另建资源库或任务表。
   * 按**本次调用所在会话**现取：登记与挂载落在该会话自己的资源索引/存储里，不写共享库。
   */
  operationsFor(scope: SessionScope | undefined): SceneOperations
  /** 仅测试/本机夹具注入（解析器、传输、等待预算）；生产留空用真实网络与默认上限。 */
  dependencies?: AssetAcquisitionDependencies
}

export const assetResolveParameters: ParameterSchemaSpec = {
  input: {
    type: "object", required: true, additionalProperties: false,
    description: "Read-only resolution of a supported share URL using its public page, official viewer configuration and public manifest. Return kind=direct for a real resource URL or kind=unsupported with facts, reasons and available actions. Do not download models or write the ResourceLibrary.",
    examples: [{ url: "https://superspl.at/scene/3eecfd55" }],
    properties: { url: { type: "string", description: "Share-page HTTPS URL; currently supports SuperSplat /scene/<id> and /s?id=<id>." } },
  },
}

/**
 * 真实注册 scene_asset_acquire（Tool，宿主挂载 commands 时同时注册同名 Command）：
 * 两者调用同一 operation，来源事件由 DSH 原生服务分别记账（与 plugin.ts 的既有做法一致）。
 * 接线见 docs/ASSET_ACQUISITION.md。
 */
export function registerAssetAcquisitionTools(ctx: Context, options: AssetAcquisitionToolOptions): void {
  // 相对 path 一律按**会话 cwd** 解析：进程 cwd 是宿主代码根，用户说的"model.zip"不该落到那里。
  // 场景操作同理按会话取：没有会话就没有这次登记的落点（不落到共享资源库）。
  const run = (input: unknown, scope: SessionScope | undefined, signal?: AbortSignal): Promise<PublicAssetAcquisitionResult> => {
    const cwd = scope?.agent?.session?.header?.cwd
    return acquirePublicAsset(options.operationsFor(scope), (input ?? {}) as AssetAcquisitionInput, {
      ...options.dependencies,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  // 只读分享页解析：同一份注入依赖（测试夹具），不碰资源库/场景/网络以外的任何状态。
  const resolveTool = async (input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const url = (input as { url?: unknown } | undefined)?.url
    if (typeof url !== "string" || !url.trim()) throw new Error("ASSET_RESOLVE_URL_REQUIRED: scene_asset_resolve 需要 url（已适配分享页的 https 网址）")
    const resolution = await resolveAssetSharePage(url.trim(), {
      resolve: options.dependencies?.resolve, transport: options.dependencies?.transport,
      timeouts: options.dependencies?.timeouts, retry: options.dependencies?.retry,
      ...(signal ? { signal } : {}),
    })
    if (resolution === undefined) return {
      kind: "not-applicable", url: url.trim(),
      reason: "不是已适配的分享页（当前只适配 SuperSplat 的 /scene/<id> 与 /s?id=<id>）。",
      acquirable: false, imported: false,
      actions: ["若这是公开资源直链（.glb/.gltf/.zip/.spz/.ply/.splat），直接用 scene_asset_acquire；否则请给本地文件或受支持的分享页。"],
    }
    return resolution
  }
  ctx.tools.register(defineTool({
    name: "scene_asset_acquire",
    description: "Acquire GLB/glTF/ZIP/.spz/.ply/.splat/.sog from public direct URLs, or one complete selected public SSOG layer from supported SuperSplat pages. Default highest-detail LOD0; selectedLod explicitly selects another layer, never silently degrading detail. Multiple blocks return resources[] and total Gaussian count; sceneId mounts one group root and every block atomically. Public SSOG is a derived representation, not the author's original PLY. Use anonymous public HTTPS only, verify actual bytes/ZIP content, retain aggregate splatMaxBytes/cancellation accounting, and require authorization for protected originals.",
    parameters: assetAcquisitionParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(modelSceneView(value)) }] },
    // args/exec 放宽类型（与 reference-tools 同一理由）：工具参数来自 JSON 边界，收口在这一处。
    // 会话 cwd 从 exec.agent 取（与 blender/depth-estimation 的既有口径一致），不拿进程 cwd 当基准。
    execute: async (args: any, exec: any) => await run(args?.input, exec, exec?.signal) as any,
  }))
  // 只读分享页解析：先读公开元数据（页面/viewer 配置/公开清单），返回 direct 或 unsupported 事实；
  // 不下载资源、不写资源库、不改场景，所以不是 persists。模型据此决定下一步，不必反复猜地址。
  ctx.tools.register(defineTool({
    name: "scene_asset_resolve",
    description: "Read-only resolution of supported SuperSplat pages through public pages, official viewer configuration and authoritative contentUrl manifests. Return kind=direct for a single-file URL, kind=streamed-sog for a selectable public multi-block LOD layer handled by scene_asset_acquire, or kind=unsupported with specific reasons/actions. Resolution neither downloads models nor registers resources; do not access account credentials or treat HTML/LOD manifests as models.",
    parameters: assetResolveParameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(modelSceneView(value)) }] },
    execute: async (args: any, exec: any) => await resolveTool(args?.input, exec?.signal) as any,
  }))
  const commands = ctx.get("commands")
  commands?.register({
    name: "scene_asset_acquire",
    description: "Acquire and register a model asset from a public HTTPS direct URL (.glb/.gltf/.zip or .spz/.ply/.splat) or local file; parameters are JSON.",
    input: { hint: "Asset-acquisition parameters as JSON." },
    async handler(invocation) {
      invocation.signal.throwIfAborted()
      // Command 与 Tool 同一条口径：相对 path 按会话 header.cwd 解析。
      const result = await run(JSON.parse(invocation.rawInput.trim() || "{}"), invocation, invocation.signal)
      return { kind: "success", text: JSON.stringify(result) }
    },
  })
  commands?.register({
    name: "scene_asset_resolve",
    description: "Read-only resolution of a supported share page, returning an actual direct URL or facts explaining why it cannot be imported; parameters are JSON.",
    input: { hint: "Share-page resolution parameters as JSON." },
    async handler(invocation) {
      invocation.signal.throwIfAborted()
      const result = await resolveTool(JSON.parse(invocation.rawInput.trim() || "{}"), invocation.signal)
      return { kind: "success", text: JSON.stringify(result) }
    },
  })
}
