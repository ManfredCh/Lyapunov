import { createHash, randomUUID } from "node:crypto"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { Readable, Transform as StreamTransform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { tmpdir } from "node:os"
import type { Entity,Matrix4Elements,Representation,ResourceRef,SceneGeometryBinding,SceneSnapshot,Transform } from "../../lyapunov-contracts/src/types.ts"
import { parseSceneGeometryBinding } from "../../lyapunov-contracts/src/types.ts"
import { atomicJSON, fileTransaction, readJSON, safeId } from "./persistence.ts"
import { fileStamp, localPath, parseAsset, sourceTransform, type FileStamp, type ParsedAsset } from "./formats.ts"
import type {SourceTexturePolicy} from './geometry-source-deps.ts'
import { materializedHome, resolveSceneLayout, type ResolvedSceneLayout, type SceneLayout, type SceneLayoutDomain } from "./layout.ts"
import { assertDirectoryCreatable, moveFilesDurable } from "./resource-transaction.ts"
import {PHYSICALIZATION_BUDGET_KEYS,physicalizationBudgets,physicalizationBudgetIdentity,validatePhysicalizationBudgets,type PhysicalizationBudgetOptions} from './physicalization-parameters.ts'

export interface ResourceNetworkProvenance { sourceUrl: string; fetchedAt: string; sha256: string; byteLength: number; glbVersion: string; contentType: string; maxBytes: number; redirectsFollowed: 0; externalDependencies: 0 }

/**
 * 许可（ENV-20 最小承载）：资源记录上多一个**可选**字段，不新建类/通道/默认值表。
 *
 * 判据只有一条"有没有事实"：调用方/清单显式声明是 `declared`，从文件元数据读出是 `file`，
 * **没有就是 `unknown`**——绝不默认成 CC0 之类的具体许可（材料库 18 条资源实测 0 条带许可，
 * 那种情况下回执必须显示 unknown）。`asset_list` 的投影点是 `storageInfo()`。
 */
export interface ResourceLicense { id: string; url?: string; attribution?: string; source?: "declared" | "file" | "unknown" }
export const UNKNOWN_RESOURCE_LICENSE: ResourceLicense = { id: "unknown", source: "unknown" }
/** 归一化：缺字段/空串/非对象/字面 "unknown" 一律收敛成 unknown，回执里不许把空值显示成具体许可。 */
export function normalizeResourceLicense(value: unknown): ResourceLicense {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...UNKNOWN_RESOURCE_LICENSE }
  const row = value as Record<string, unknown>
  const id = typeof row.id === "string" ? row.id.trim() : ""
  if (!id || id.toLowerCase() === "unknown") return { ...UNKNOWN_RESOURCE_LICENSE }
  return {
    id,
    ...(typeof row.url === "string" && row.url.trim() ? { url: row.url.trim() } : {}),
    ...(typeof row.attribution === "string" && row.attribution.trim() ? { attribution: row.attribution.trim() } : {}),
    source: row.source === "file" ? "file" : row.source === "unknown" ? "unknown" : "declared",
  }
}

export type ResourcePhysicalizationRequest = false | PhysicalizationBudgetOptions & {
  usage?: "dynamic" | "static" | "environment"
  strategy?: "auto" | "convex_hull" | "voxel_boxes" | "coacd" | "triangle_mesh" | "sdf"
}
export interface ResourceImportDefaults {mountTransform?:Transform;visualSourceTransform?:Transform;legacySource?:{resourceId:string;assetRevision?:string;sourceRef?:string;backgroundCalibration?:unknown;viewerTargetZ?:number;conversion?:string};networkProvenance?: ResourceNetworkProvenance;license?: ResourceLicense;physicalizationRequest?:ResourcePhysicalizationRequest}
/** 导入请求保留用途；重导入缺省不能把 environment 改回 dynamic，显式改派沿原变体/previous账。 */
export function validatePhysicalizationRequest(value: ResourcePhysicalizationRequest | undefined): void {
  if (value === undefined || value === false) return
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["usage", "strategy", ...PHYSICALIZATION_BUDGET_KEYS].includes(key as any))) throw new Error("PHYSICALIZATION_REQUEST_INVALID")
  if (value.usage !== undefined && !["dynamic", "static", "environment"].includes(value.usage)) throw new Error("PHYSICALIZATION_USAGE_INVALID")
  if (value.strategy !== undefined && !["auto", "convex_hull", "voxel_boxes", "coacd", "triangle_mesh", "sdf"].includes(value.strategy)) throw new Error("PHYSICALIZATION_STRATEGY_INVALID")
  validatePhysicalizationBudgets(value)
  if(value.pointCloudTiling&&(value.usage!==undefined&&value.usage!=='environment'||value.strategy!==undefined&&!['auto','voxel_boxes','triangle_mesh'].includes(value.strategy)))throw Error('POINT_CLOUD_TILING_USAGE_INVALID: full采样体素只用于environment/auto、voxel_boxes或显式triangle_mesh')
}
function retainPhysicalizationRequest(record: ResourceRecord, request: ResourcePhysicalizationRequest | undefined): boolean {
  if (request === undefined) return false
  validatePhysicalizationRequest(request)
  if (record.physicalizationRequest !== undefined) {
    if (isDeepStrictEqual(record.physicalizationRequest, request)) return false
  }
  record.physicalizationRequest = structuredClone(request)
  const previous=record.physicalization
  const compatible=request!==false&&previous?.status==='ok'&&(request.usage??(record.parsed.kind==='splat'?'environment':'dynamic'))===(previous.usage??'dynamic')&&(request.strategy??'auto')===previous.strategy&&physicalizationBudgetIdentity(request)===physicalizationBudgetIdentity(previous)
  if(!compatible)discardDerivedPhysicsDefaults(record)
  return true
}
/** 改派或开始修复后，下一次挂载不能继续消费上一请求的算法默认；显式资产定义及历史实例保留。 */
function discardDerivedPhysicsDefaults(record:ResourceRecord):void{
  const defaults=record.componentDefaults
  if(!String(defaults?.collision?.source??'').startsWith('asset-bake-'))return
  const explicit=record.explicitComponentDefaultKeys??[]
  if(!explicit.includes('collision'))delete defaults!.collision
  if(!explicit.includes('rigidBody'))delete defaults!.rigidBody
}
export type ResourceAuthorityCategory = "background" | "scene" | "robot" | "object"
export interface ResourceFileInventory { path: string; size: number; sha256: string }
export interface ResourceFileTransition {
  sourcePath: string
  targetPath: string
  inventory: ResourceFileInventory[]
  targetExisted?: boolean
  mode?: "link" | "copy"
}
export interface ResourceAuthorityTombstone {
  tombstoneID: string
  resourceId: string
  operationID: string
  sourcePath: string
  targetPath?: string
  inventory: ResourceFileInventory[]
  files?: ResourceFileTransition[]
  createdAt: string
  state: "moved" | "trashed" | "restored"
}
/**
 * 一个新版本的来历（只作说明，不参与版本身份判定）：这个版本的字节来自哪个已登记版本，以及打包器
 * 在复制时改写了哪几个文件（before/after 都是**磁盘上的真实内容戳**，登记时逐条核对）。
 * 字节一变就是新版本——这条线上没有"同一版本的另一份字节"这种例外，也没有任何用调用方声明的
 * 内容戳去改写旧版本依赖的通道；身份比较仍然只看真实字节。
 */
export interface ResourceVersionDerivation {
  kind: "external-path-rewrite"
  /** 派生自该资源 id 的哪个已登记版本。 */
  from: number
  /** 被改写的文件：source = 旧版本那侧的源文件，target = 新版本这一侧的副本，都是真实路径。 */
  files: Array<{ source: string; target: string; before: { sha256: string; size: number }; after: { sha256: string; size: number } }>
  at: string
}
interface ResourceLocation { ref: ResourceRef; parsed: ParsedAsset }
export type ResourceStorageKind = "cas" | "reference" | "materialized"
export type ResourceOrigin = "builtin" | "download" | "generated" | "import"
export interface ResourceStorageInfo { sizeBytes: number; storage: ResourceStorageKind; storedEntryPath?: string; origin: ResourceOrigin }
/**
 * materialized 落地的域内 home：原件连同依赖闭包被复制进按资源类别决定的域目录
 * （robot → <robots>/<assetId>/source、object → <assets>/<assetId>/source、
 *  world → <worlds>/environments/<assetId>/source）。同一 assetId 的新版本与已落地
 * 字节不同时退到 source/v<N>/，绝不覆盖上一版；directory/entryPath 记录的是真实落点。
 */
export interface ResourceMaterializedHome {
  domain: SceneLayoutDomain
  directory: string
  entryPath: string
  /** 本次落地的文件数（含原件） */
  files: number
  materializedAt: string
}
/**
 * 碰撞派生状态：mesh 资源登记后由物理化队列异步回写。pending 进行中；ok 产物已追加为
 * collision 表示并补入默认 collision/rigidBody 组件；failed 记 error（导入本身不回退）；
 * skipped 是调用方显式 physicalize:false 的标记。派生物按版本隔离在
 * assets/derived/<id>/v<version>/collision/<用途>/<参数变体>/——用途分目录，同一用途下每个参数
 * 变体（策略 + 体素边长 + 口径版本）再各占一个目录，同一版本换参数重派生时旧产物字节保持不变。
 *
 * ok 记录同时是**派生回执**：usage/strategy 是实际用掉的用途与策略，nodes/parts/boxes 是实际
 * 导出的节点/件/盒数，interiorPreserved 说明空腔是否保留，sourcePath 是真正被派生的源文件；
 * attempts 累计尝试次数、previous 保留上一次终止状态——失败后重试或换用途重派生都看得见。
 */
export interface ResourcePhysicalization extends PhysicalizationBudgetOptions {
  status: "pending" | "ok" | "failed" | "skipped"
  staticTriangleSurfaces?:Array<{node:string}&import('../../asset-bake/src/physicalize.ts').StaticTriangleSurface>
  /** 请求侧解析出来的策略（与产物变体目录、去重判据同一个值）。 */
  strategy?: string
  /** asset-bake 回的执行口径：只有与请求侧不同才出现——environment 缺省请求记 auto，而它自己的缺省口径
   *  是 triangle_mesh（逐节点仍可能按实测改派）。变体目录按 strategy 落位，这个字段用来对上产物内嵌
   *  physicalization.json 的 strategy，免得"记录说 triangle_mesh、目录写着 auto"。 */
  derivedStrategy?: string
  /** dynamic（旧记录缺省即此）/ static / environment；旧记录没有这个字段时按 dynamic 解释。 */
  usage?: string
  /** 派生策略口径版本（如 cavity-safe-1）：口径变了同一组参数也会重派生，回执据此说明产物出自哪套口径。 */
  policy?: string
  error?: string
  errorDetails?:Record<string,unknown>
  progress?:{mode:string;node?:string;facts:Record<string,unknown>;at:string}
  pointCloud?:Array<Record<string,unknown>>
  finishedAt?: string
  /** 碰撞产物包围盒（实体局部帧、Z-up 米）：落地对齐的物理基准。 */
  collisionBounds?: { min: [number, number, number]; max: [number, number, number] }
  /** 实际被派生的源文件（GLB 路径）；与原件不是同一个文件时能一眼看出来。 */
  sourcePath?: string
  /** 实际导出的节点数 / 碰撞件数 / 盒数（ok 回执）。 */
  nodes?: number
  parts?: number
  boxes?: number
  /** 命中近原生形状（引擎原生 geom，装配为 box/sphere/cylinder shapes）的节点数：走这条路时
   *  parts/boxes 都是 0，装配里却真有盒体——不数它会让回执与实体上的组件对不上。 */
  primitives?: number
  /** 空腔是否保留：按**实测**的逐节点表示算，不是 usage 的复述——凸分解件/不填内部的体素表面盒组/
   *  SDF/凸包即自身的精确表面都算保空腔；被凸化的（凸包、用原生形状近似凹形）或物体派生填实内部 → false。 */
  interiorPreserved?: boolean
  /** 通行**实测**状态：恒为 false —— 本工具不求解净通道宽/全场连通性，所以 interiorPreserved 只是
   *  "表示法不填补内部"的推导值，不能读成"通道可用"。实测通行只对具体夹具与目标引擎成立（验收里
   *  逐用例真跑过），随通用回执一起写出去就成了伪造证据。 */
  passageVerified?: boolean
  /** 未实测通行的说明与"要看哪个近似账"（体素分辨率 voxelResolutionM / 凸分解体积比 volumeRatios）。 */
  passageNote?: string
  /** 逐节点实际用掉的碰撞表示计数（triangle_mesh/coacd/voxel_boxes/primitive/convex_hull/sdf）：
   *  同一份资产里可以混用（凹实体走凸分解、地板走精确表面），这就是"选用策略"的实测账。 */
  selection?: Record<string, number>
  /** 被"凸包即自身"判定改派的节点（node/请求策略下的实产物/原因）：请求的 strategy 与实际产物不同时
   *  在这里如实记账，不让成功回执掩盖表示被换过。 */
  routed?: Array<{ node: string; selected: string; reason: string }>
  /** 体素表面盒组节点的实际体素边长（米，逐节点去重升序）——近似分辨率即该表示的误差上限。 */
  voxelResolutionM?: number[]
  /** 凸分解节点的"分件体积和 / 源网格体积"（1.0 = 不增不减材料，只是用凸件拼出凹形）：近似误差实测值。 */
  volumeRatios?: number[]
  /** 显式策略落到"目标引擎消费时会失去空腔/开口"的表示上的节点（node/表示/说明）：请求被如实执行，
   *  但结果里写清楚引擎会怎么消费它——interiorPreserved 也因此为 false，不由 usage 自证。 */
  cavityLostNodes?: Array<{ node: string; selected: string; notice: string }>
  /** 本次派生在同一产物目录里清掉的、没有被任何表示引用的临时件文件名：目录里剩下的就是这次的产物。 */
  prunedParts?: string[]
  /** 环境盒组的绑定体素边长（米）。 */
  voxelSizeM?: number
  /** 本版本累计派生尝试次数（每次入队 +1）：失败后重试成功时看得到 1 → 2。 */
  attempts?: number
  /** true 表示这次 ok 覆盖了同一版本上一次 ok 的派生（换用途/换策略重派生），默认组件按新产物整体替换。 */
  supersedes?: boolean
  /** 本次成功派生的完整发布集合；原件版本身份仍由 parsed.dependencies 拥有。 */
  artifactUris?: string[]
  /** 几何交接的已验证事实；reference姿态不冒充动画已物理化。 */
  geometryTransport?: {schema:string;version:number;verified:boolean;manifestPath?:string;nodeCount?:number;readBytes?:number;sourceFrame?:Record<string,unknown>;limits?:Record<string,unknown>}
  /** 上一次终止状态（重派生前），失败恢复与换用途的可见账。 */
  previous?: { status: string; usage?: string; strategy?: string; error?: string; finishedAt?: string }
}
export type ResourcePhysicalizationPatch = PhysicalizationBudgetOptions & (
  | { status: "pending"; strategy: string; usage?: string; policy?: string; voxelSizeM?: number }
  | { status: "ok"; strategy: string; derivedStrategy?: string; representations: Representation[]; componentDefaults: Entity["components"]; collisionBounds?: { min: [number, number, number]; max: [number, number, number] }; usage?: string; sourcePath?: string; nodes?: number; parts?: number; boxes?: number; primitives?: number; interiorPreserved?: boolean; passageVerified?: boolean; passageNote?: string; selection?: Record<string, number>; routed?: Array<{ node: string; selected: string; reason: string }>; voxelResolutionM?: number[]; volumeRatios?: number[]; cavityLostNodes?: Array<{ node: string; selected: string; notice: string }>; prunedParts?: string[]; policy?: string; voxelSizeM?: number; supersedes?: boolean;geometryTransport?:ResourcePhysicalization['geometryTransport'];pointCloud?:Array<Record<string,unknown>>;staticTriangleSurfaces?:ResourcePhysicalization['staticTriangleSurfaces'] }
  | { status: "failed"; strategy?: string; usage?: string; error: string;errorDetails?:Record<string,unknown> }
  | { status: "skipped"; strategy?: string }
 )
export interface ResourceRecord extends ResourceImportDefaults, ResourceLocation {
  name: string; tags: string[]; folder: string; category?: ResourceAuthorityCategory; deletedAt?: string; createdAt: string; alternateLocations?: ResourceLocation[]; operationID?: string; idempotencyKey?: string; registryRevision?: string; inventory?: ResourceFileInventory[]; tombstone?: ResourceAuthorityTombstone
  /** 这个版本的来历（哪个版本 + 打包器改写了哪几个文件）；只作说明，版本身份只看这一版自己的真实字节。 */
  derivedFrom?: ResourceVersionDerivation
  /** cas = 外部原件连同依赖闭包已复制进 <cache>/cas；reference = 引用原位置（产品自带或运行根内）；
   *  materialized = 原件连同依赖闭包已复制进按资源类别决定的域目录，落点见 home。 */
  storage?: ResourceStorageKind; storedEntryPath?: string
  /** 仅 storage='materialized' 的域内 home（域/目录/入口/文件数/时间）；其余模式不写这个字段，既有索引字节不变。 */
  home?: ResourceMaterializedHome
  /**
   * 资源默认组件：该资源自身的控制/传感器等映射（例如 controller），来自显式导入
   * 或场景文档中所有引用一致给出的组件。挂载时作为基线，实例的显式 components
   * 按组件键整体覆盖它；实例覆盖永不写回这里，因此同一资源多实例的先后差异
   * 不会把最后一个变成全局 owner。挂载会从资源原件重新合成的键（visual/mujoco/
   * articulation）不进入资源默认，避免把展示快照或路径当成资产定义。
   */
  componentDefaults?: Entity["components"]
  /** 导入时显式给出的资产定义键；自动改派不能覆盖这些用户声明。 */
  explicitComponentDefaultKeys?: string[]
  physicalization?: ResourcePhysicalization
  /** 已发布碰撞字节的独立清单，换用途不丢旧变体；不把可重建缓存塞进原件版本依赖。 */
  collisionArtifacts?: FileStamp[]
  physicalizationVariants?:Array<{artifactUris:string[];parameters:PhysicalizationBudgetOptions&{usage?:string;strategy:string;policy?:string}}>
  /**
   * splat 与其碰撞网格的持久绑定合同（scene-geometry）：导入时显式登记或按同名 .glb
   * 自动配对的文档事实，随 index.json 全量持久化。挂载时经 sceneCollisionAlignmentGate
   * 闸口，仅 machine-verified / user-confirmed 写成实体 components.collision；
   * 候选/过期保持纯视觉。不据此读取几何字节。
   */
  sceneGeometryBinding?: SceneGeometryBinding
}
interface Catalog { records: ResourceRecord[]; registryRevision?: string }

/**
 * 不进入资源默认的组件键：visual/mujoco/articulation 在挂载时总由资源原件重新合成；
 * isaac 的 sourcePath/importManifest 等指向工程本地或运行缓存的派生模型，不属于可迁移、
 * 可校验的资产定义，资源库的 move/verify 也不维护它，因此文档里的一致值同样不采集——
 * isaac 只在挂载调用显式给出 components 时按原契约下发给该实例。
 */
const NON_ASSET_COMPONENT_KEYS = ["visual", "mujoco", "articulation", "isaac"] as const
function discoverableComponentDefaults(components: Entity["components"] | undefined): Entity["components"] | undefined {
  if (!components) return undefined
  const defaults: Entity["components"] = {}
  for (const [key, value] of Object.entries(components)) {
    if ((NON_ASSET_COMPONENT_KEYS as readonly string[]).includes(key)) continue
    defaults[key] = structuredClone(value)
  }
  return Object.keys(defaults).length ? defaults : undefined
}
/**
 * 同一 resourceId@version 在一次登记中的全部引用必须都给出完全一致的组件值，
 * 才把它记为资源默认；任一实例缺失或不同就不登记——不凭名称/资格推断，也不
 * 让某个实例（如最后一个）覆盖成为全局 owner。
 */
function agreedComponentDefaults(instances: Array<Entity["components"] | undefined>): Entity["components"] | undefined {
  const candidates = instances.map(discoverableComponentDefaults)
  const first = candidates[0]
  if (!first || candidates.some(candidate => !candidate)) return undefined
  const agreed: Entity["components"] = {}
  for (const [key, value] of Object.entries(first)) {
    if (candidates.every(candidate => Object.hasOwn(candidate!, key) && isDeepStrictEqual(candidate![key], value))) agreed[key] = structuredClone(value)
  }
  return Object.keys(agreed).length ? agreed : undefined
}
/** 只补缺不改写：已登记的默认是资产定义，之后场景里的不同值属于实例覆盖。 */
function mergeComponentDefaults(existing: Entity["components"] | undefined, discovered: Entity["components"] | undefined): { value?: Entity["components"]; changed: boolean } {
  if (!discovered) return { value: existing, changed: false }
  const value = existing ? structuredClone(existing) : {}
  let changed = false
  for (const [key, item] of Object.entries(discovered)) if (!Object.hasOwn(value, key)) { value[key] = structuredClone(item); changed = true }
  return changed ? { value, changed } : { value: existing, changed: false }
}
/**
 * 重派生（换用途/换策略）时用这次派生出的组件整体替换同名的旧派生组件：只补缺的合并会把上一次
 * dynamic 的凸包/质量留在记录里，而 physicalization 已经写着 environment —— 记录与实际派生不一致。
 * 其它键的语义不变（仍是"只补缺不改写"）。
 */
function replaceDerivedComponentDefaults(existing: Entity["components"] | undefined, discovered: Entity["components"] | undefined, explicit:readonly string[]=[]): { value?: Entity["components"]; changed: boolean } {
  if (!discovered) return { value: existing, changed: false }
  const value = existing ? structuredClone(existing) : {}
  let changed = false
  for (const [key, item] of Object.entries(discovered)) {
    if(explicit.includes(key)&&Object.hasOwn(value,key))continue
    if (Object.hasOwn(value, key) && isDeepStrictEqual(value[key], item)) continue
    value[key] = structuredClone(item); changed = true
  }
  return changed ? { value, changed } : { value: existing, changed: false }
}

/** 管理面操作身份与持久账本。账本保存 before/after 快照，便于崩溃后只恢复 authority 索引，不碰用户原件。 */
export interface ResourceAuthorityIdentity {
  operationID?: string
  idempotencyKey?: string
  expectedRegistryRevision?: string
}
export interface ResourceAuthoritySnapshot { registryRevision: string; records: ResourceRecord[] }
export type ResourceAuthorityFaultStage =
  | "prepared_journal"
  | "after_file_moved"
  | "after_file_transition"
  | "after_transition_journal"
  | "index_published"
  | "journal_applied"
export interface ResourceAuthorityOptions {
  faultInjector?: (stage: ResourceAuthorityFaultStage) => void
  /** 产品安装根：其下的原件（materials/ 内置素材）导入时引用原位置，不复制进 CAS。 */
  productRoot?: string
  /** 存储分治布局；省略时五个域根都等于 directory，逐路径保持单根旧行为。 */
  layout?: SceneLayout
  /** 新导入的默认存储模式；省略时保持旧行为（产品自带/运行根内 reference，外部原件 cas）。 */
  defaultStorage?: ResourceStorageKind
  /**
   * 隔离算法解释器路径（碰撞派生 worker 用）：非秘密、显式配置。派生由本库的队列触发，解释器随库的
   * 配置走，调度处（physicalization.ts）只在这一处读取；省略时保持旧行为（asset-bake 回落环境变量）。
   */
  algorithmPython?: string
  /**
   * 显式指定 CAS 根：**按会话分治时唯一可以跨会话共享的目录**。CAS 目标名 = 内容 sha 前缀 + 文件名，
   * 内容相同才同名，写入是临时名 + 原子 link、已存在时逐字节核对 sha256（storeFileVerified），
   * 因此并发写同一目标只会写进同样的字节；这是"不可变公共素材按内容复用字节"的既有语义。
   * 派生、下载、目录索引与版本引用都**不**在此列——它们随会话目录走，不共享。
   */
  casRoot?: string
}
interface AuthorityJournalEntry {
  operationID: string
  idempotencyKey: string
  inputHash: string
  status: "prepared" | "applied"
  beforeRegistryRevision: string
  afterRegistryRevision?: string
  beforeCatalog: Catalog
  afterCatalog?: Catalog
  result?: unknown
  createdAt: string
  appliedAt?: string
  fileTransition?: ResourceFileTransition & { files?: ResourceFileTransition[]; phase: "planned" | "moved"; syncedDirectories?: string[] }
}

function registryRevision(records: ResourceRecord[]): string {
  // 操作身份是审计字段，不应让同一 authority 内容因重启/重放产生新的 CAS 版本。
  const canonical = JSON.stringify([...records].map(record => {
    const { operationID: _operationID, idempotencyKey: _idempotencyKey, registryRevision: _registryRevision, ...stable } = record
    return stable
  }).sort((a, b) => `${a.ref.resourceId}@${a.ref.version}`.localeCompare(`${b.ref.resourceId}@${b.ref.version}`)))
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}
function commandHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value) }
async function isFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile() } catch { return false } }
async function inventoryFiles(dependencies: readonly { path: string; size: number; sha256?: string }[]): Promise<ResourceFileInventory[]> {
  return Promise.all(dependencies.map(async dependency => {
    const stamp = await fileStamp(dependency.path, true)
    return { path: stamp.path, size: stamp.size, sha256: stamp.sha256 ?? dependency.sha256 ?? "" }
  }))
}
async function inventoryMatches(path: string, inventory: readonly ResourceFileInventory[]): Promise<boolean> {
  if (!inventory.length) return false
  try {
    const stamp = await fileStamp(path, true)
    return stamp.size === inventory[0]!.size && stamp.sha256 === inventory[0]!.sha256
  } catch { return false }
}
async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}
function pathInside(directory: string, path: string): boolean {
  const child = relative(resolve(directory), resolve(path))
  return child !== "" && child !== "." && !child.startsWith(".." + sep) && child !== ".." && !/^[a-zA-Z]:/.test(child)
}
function pathInsideOrEqual(directory: string, path: string): boolean {
  const child = relative(resolve(directory), resolve(path))
  return child === "" || pathInside(directory, path)
}
function commonDirectory(files: string[]): string {
  let directory = resolve(dirname(files[0]!))
  while (files.some(file => !pathInsideOrEqual(directory, file))) directory = dirname(directory)
  return directory
}
/** parseAsset 的依赖闭包第一项总是入口；按路径精确匹配，退化到第一项。 */
function entryDependency(parsed: ParsedAsset, path: string): FileStamp {
  const resolved = resolve(path)
  return parsed.dependencies.find(stamp => resolve(stamp.path) === resolved) ?? parsed.dependencies[0]!
}
const inferredRecordCategory = (kind: ParsedAsset["kind"]): ResourceAuthorityCategory => ({ splat: "background", source: "scene", robot: "robot", mesh: "object" } as const)[kind]
function recordCategory(record: ResourceRecord): ResourceAuthorityCategory {
  return record.category ?? inferredRecordCategory(record.parsed.kind)
}
/**
 * materialized 的域归属：机器人 → robots，可调用小物件 → assets，其余（background/splat 与
 * scene/source 两类世界来源）→ worlds。环境不是独立的 ResourceAuthorityCategory，world 域的
 * 落点统一收在 <worlds>/environments/<assetId>/source。
 */
function materializedDomain(category: ResourceAuthorityCategory): SceneLayoutDomain {
  return category === "robot" ? "robots" : category === "object" ? "assets" : "worlds"
}
function recordEntrySha(record: ResourceRecord): string | undefined {
  if (!record.parsed.dependencies.length) return undefined
  let entry: string | undefined
  try { entry = resolve(localPath(record.ref.original.uri)) } catch { entry = undefined }
  return (entry ? record.parsed.dependencies.find(stamp => resolve(stamp.path) === entry) : undefined)?.sha256 ?? record.parsed.dependencies[0]!.sha256
}
interface CasStore { anchor: string; entry: string; targets: Map<string, string> }
/**
 * 入口锚点 cas/<sha前2位>/<sha>-<basename>。单文件闭包记录直接指向锚点；多文件闭包
 * （MJCF include/mesh、GLB 外部 buffer）在 <锚点>_deps/<完整闭包digest>/ 镜像相对结构，
 * 目录身份包含相对路径、size、SHA；旧 _deps 不覆盖，资产内部相对引用保持闭合。
 */
function planCasStore(casRoot: string, sha: string, entryPath: string, closure: string[], stamps: ReadonlyMap<string, FileStamp>): CasStore {
  const anchor = join(casRoot, sha.slice(0, 2), `${sha}-${basename(entryPath)}`)
  if (closure.length === 1) return { anchor, entry: anchor, targets: new Map([[closure[0]!, anchor]]) }
  const common = commonDirectory(closure)
  const identity = closure.map(file => {
    const stamp = stamps.get(file)
    if (!stamp?.sha256) throw new Error(`RESOURCE_CAS_CONTENT_STAMP_REQUIRED: ${file}`)
    return { path: relative(common, file).split(sep).join("/"), size: stamp.size, sha256: stamp.sha256 }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  const directory = join(`${anchor}_deps`, digest)
  const targets = new Map(closure.map(file => [file, join(directory, relative(common, file))]))
  return { anchor, entry: targets.get(entryPath)!, targets }
}
/**
 * materialized 落点：域内 home 目录下按原件 basename 落入口；多文件闭包按入口公共目录的相对
 * 层级镜像（与 CAS 的 _deps 同一约定），资产内部的相对引用在存储副本之间保持闭合。
 */
function planMaterializedStore(root: string, entryPath: string, closure: string[]): CasStore {
  const entry = join(root, basename(entryPath))
  if (closure.length === 1) return { anchor: entry, entry, targets: new Map([[closure[0]!, entry]]) }
  const common = commonDirectory(closure)
  const targets = new Map(closure.map(file => [file, join(root, relative(common, file))]))
  return { anchor: entry, entry: targets.get(entryPath)!, targets }
}
/** 外部原件复制为独立 inode；只有内部 CAS 锚点可以共享硬链。临时名+原子 link 落位，目标已存在时不覆盖。 */
async function storeFileVerified(source: string, expected: FileStamp, target: string, created: string[], linkVerifiedSource = false): Promise<void> {
  const kept = await fileStamp(target, true).catch(() => undefined)
  if (kept) {
    if (kept.size === expected.size && kept.sha256 === expected.sha256) return
    throw new Error(`RESOURCE_CAS_TARGET_CONFLICT: ${target}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    let linked = false
    if (linkVerifiedSource) try { await link(source, temp); linked = true } catch { /* 内部锚点跨设备时回落到独立副本 */ }
    if (!linked) {
      // FICLONE 支持时用 reflink，文件系统不支持时 Node 自动做字节复制；均不共享源 inode。
      await copyFile(source, temp, constants.COPYFILE_FICLONE)
    }
    const actual = await fileStamp(temp, true)
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`RESOURCE_CAS_COPY_MISMATCH: ${source}`)
    try { await link(temp, target); created.push(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const concurrent = await fileStamp(target, true).catch(() => undefined)
      if (!concurrent || concurrent.size !== expected.size || concurrent.sha256 !== expected.sha256) throw new Error(`RESOURCE_CAS_TARGET_CONFLICT: ${target}`)
    }
    await rm(temp, { force: true })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
type PlannedTransition = ResourceFileTransition & { files?: ResourceFileTransition[]; phase: "planned" | "moved"; syncedDirectories?: string[] }
function transitionFiles(transition: PlannedTransition): ResourceFileTransition[] {
  return transition.files?.length ? transition.files : [transition]
}

const categoryKinds: Record<ResourceAuthorityCategory, ParsedAsset["kind"][]> = {
  background: ["splat"], scene: ["source"], robot: ["robot"], object: ["mesh"],
}
function authorityCategory(category: unknown, kind: ParsedAsset["kind"]): ResourceAuthorityCategory {
  if (category !== undefined && (typeof category !== "string" || !Object.hasOwn(categoryKinds, category))) throw new Error(`RESOURCE_CATEGORY_INVALID: ${String(category)}`)
  const inferred = category as ResourceAuthorityCategory | undefined ?? ({ splat: "background", source: "scene", robot: "robot", mesh: "object" } as const)[kind]
  if (!inferred || !categoryKinds[inferred].includes(kind)) throw new Error(`RESOURCE_CATEGORY_KIND_CONFLICT: ${String(inferred)}:${kind}`)
  return inferred
}

const locations = (record: ResourceRecord): ResourceLocation[] => [record, ...record.alternateLocations ?? []]
/** 碰撞派生表示（role='collision'）是版本登记后由物理化队列异步追加的；版本身份匹配忽略它们——物理化完成前保存/挂载的场景文档里的引用与已追加表示的登记仍属同一版本。 */
const refVersionIdentity = (ref: ResourceRef): ResourceRef => ({ ...ref, representations: ref.representations.filter(rep => rep.role !== "collision") })
function validResourceSource(value: unknown): value is ResourceRef['source'] {
  const source = value as ResourceRef['source'] | undefined
  return !!source && typeof source.units === 'string' && source.units.length > 0
    && ['X', 'Y', 'Z'].includes(source.upAxis) && ['right', 'left'].includes(source.handedness)
    && (source.metersPerUnit === undefined || Number.isFinite(source.metersPerUnit) && source.metersPerUnit > 0)
}
/** 旧引用只补缺字段；唯一依据是同版本已登记的原件解析事实，不猜坐标、不覆盖已有声明。 */
function sourceCompleteIdentity(ref: ResourceRef, parsed: ParsedAsset): ResourceRef {
  return refVersionIdentity(sourceCompleteRef(ref, parsed))
}
function sourceCompleteRef(ref: ResourceRef, parsed: ParsedAsset): ResourceRef {
  if (ref.source !== undefined) return ref
  return validResourceSource(parsed.source) ? { ...ref, source: parsed.source } : ref
}
async function sourceCompleteRecord(record: ResourceRecord): Promise<ResourceRecord> {
  if (record.ref.source !== undefined) return record
  if (!validResourceSource(record.parsed.source)) throw new Error('RESOURCE_SOURCE_UNAVAILABLE: 旧资源没有可核的源单位/坐标信息')
  const verified = await verifyLocation(record)
  if (!verified.valid) throw new Error('RESOURCE_SOURCE_ORIGINAL_UNAVAILABLE: 补源信息前必须核对同版本原件与依赖')
  return { ...record, ref: { ...record.ref, source: structuredClone(record.parsed.source) } }
}
const referenceShape = (ref: ResourceRef) => ({ ...ref, original: { ...ref.original, uri: '' }, representations: refVersionIdentity(ref).representations.map(rep => ({ ...rep, uri: '' })) })
/** 位置可变；版本仍绑定原件、派生表示及其依赖的已登记字节。 */
function sameVersionAtAnotherLocation(expected: ResourceLocation, actual: ResourceLocation): boolean {
  if (!isDeepStrictEqual(referenceShape(expected.ref), referenceShape(actual.ref)) || expected.parsed.dependencies.length !== actual.parsed.dependencies.length) return false
  const oldReps = [expected.ref.original, ...expected.ref.representations], newReps = [actual.ref.original, ...actual.ref.representations]
  const anchors = oldReps.map((rep, index) => [localPath(rep.uri), localPath(newReps[index]!.uri)] as const)
  const incoming = new Map(actual.parsed.dependencies.map(stamp => [localPath(stamp.path), stamp])), matched = new Set<string>()
  for (const stamp of expected.parsed.dependencies) {
    const path = localPath(stamp.path), direct = anchors.find(([source]) => source === path)
    const candidates = direct ? [direct[1]] : anchors.map(([source, target]) => resolve(dirname(target), relative(dirname(source), path)))
    const target = candidates.find(candidate => { const next = incoming.get(candidate); return next && stamp.sha256 && next.sha256 === stamp.sha256 && next.size === stamp.size })
    if (!target) return false
    matched.add(target)
  }
  return matched.size === incoming.size
}
/**
 * 跨版本找"同一份真实内容"时的**局部**规范化：只把声明里的版本号换成同一个哨兵，其余判据原样交给
 * `sameVersionAtAnotherLocation`（表示结构、source 声明、依赖条数、逐依赖 sha256/size 锚点映射一步不改）。
 * 用在"同一份字节已经登记成别处的某个版本"这一种查询里——调用方带来的 ref 版本号是它自己的声明，
 * 不能因为它写着 v1 就认不出磁盘上已经存在的 v2。全局的同版本判据不放松，也不接受第二份字节。
 */
function sameContentAcrossVersions(expected: ResourceLocation, actual: ResourceLocation): boolean {
  const normalize = (location: ResourceLocation): ResourceLocation => ({ ref: { ...location.ref, version: 0 }, parsed: location.parsed })
  return sameVersionAtAnotherLocation(normalize(expected), normalize(actual))
}
/**
 * 把一个已核实为"同一份字节"的位置采纳为记录的主位置（旧主位置降为 alternate）；返回是否真的换了位置。
 * `registerReferences` 与 `registerDerivedVersion` 共用这一份语义，位置列表始终只放同一份字节的位置。
 */
function adoptLocation(record: ResourceRecord, location: ResourceLocation): boolean {
  if (isDeepStrictEqual(record.ref, location.ref)) return false
  record.alternateLocations = locations(record).filter(previous => !isDeepStrictEqual(previous.ref, location.ref)).map(previous => ({ ref: previous.ref, parsed: previous.parsed }))
  record.ref = location.ref; record.parsed = location.parsed
  return true
}
async function verifyLocation(location: ResourceLocation): Promise<{ valid: boolean; missing: string[]; changed: string[] }> {
  const missing: string[] = [], changed: string[] = []
  for (const expected of location.parsed.dependencies) {
    try { const actual = await fileStamp(expected.path, Boolean(expected.sha256)); if (actual.size !== expected.size || (expected.sha256 ? actual.sha256 !== expected.sha256 : actual.mtimeMs !== expected.mtimeMs)) changed.push(expected.path) }
    catch { missing.push(expected.path) }
  }
  return { valid: !missing.length && !changed.length, missing, changed }
}

/**
 * 旧资源索引中没有原件时仍保留的可见引用。
 * 这不是资源替代品，也不能被 mount/portable 当作可用原件；用户补回同一
 * sourcePath 后重新运行迁移即可重新验证。asset_missing 会逐条展示这些记录。
 */
export interface MissingResourceRecord {
  resourceId: string
  legacyPath?: string
  displayName?: string
  source?: string
  sourceRef?: string
  assetRevision?: string
  status: "BLOCKED"
  reason: string
  recovery: { action: "restore-original-at-source-path-and-rerun-migration"; replacementAllowed: false }
}

/**
 * 对迁移报告中的原件做一次只读重扫。重扫只证明“同一路径现在有可读原件”，
 * 不导入、不替换、不清除 BLOCKED 记录；真正恢复仍必须由同一迁移账本重跑完成。
 */
export interface MissingResourceRescan {
  checkedAt: string
  status: "BLOCKED" | "READY_TO_RERUN" | "EMPTY"
  records: Array<MissingResourceRecord & {
    sourcePath: { state: "missing" | "present" | "not-file"; size?: number; mtimeMs?: number }
  }>
}

export class ResourceLibrary {
  private readonly verifiedCollisionFiles=new Map<string,{expected:string;identity:string}>()
  private collisionHashReads=0
  private collisionCacheHits=0
  /** 非秘密的owner缓存计数，仅用于诊断/行为验收；不是第二份资产状态。 */
  collisionVerificationStats(){return {hashReads:this.collisionHashReads,cacheHits:this.collisionCacheHits}}
  readonly indexPath: string
  readonly missingPath: string
  readonly journalPath: string
  /** 生效布局；省略 layout 时五个域根都等于 directory（split=false）。 */
  readonly layout: ResolvedSceneLayout
  /** 目录索引根（唯一真值）：旧行为 <dataRoot>/resources；域模式下即 <catalog>。 */
  readonly catalogRoot: string
  /** 内容寻址原件根：旧行为 <dataRoot>/assets/cas；域模式下即 <cache>/cas。 */
  readonly casRoot: string
  /** 碰撞派生根：旧行为 <dataRoot>/assets/derived；域模式下即 <cache>/derived。 */
  readonly derivedRoot: string
  /** 网络下载落地根：旧行为 <dataRoot>/resources/network；域模式下即 <cache>/download。 */
  readonly downloadRoot: string
  /** 生成来源判定根：旧行为 <dataRoot>/provider-jobs；域模式下即 <cache>/provider-jobs。 */
  readonly providerJobsRoot: string
  constructor(readonly directory: string, readonly options: ResourceAuthorityOptions = {}) {
    const layout = resolveSceneLayout(directory, options.layout)
    this.layout = layout
    this.catalogRoot = layout.split ? layout.catalog : join(directory, "resources")
    // 显式 casRoot 优先（会话分治下指共享的不可变 CAS）；省略时保持原有的布局推导。
    this.casRoot = options.casRoot ? resolve(options.casRoot) : layout.split ? join(layout.cache, "cas") : join(directory, "assets", "cas")
    this.derivedRoot = layout.split ? join(layout.cache, "derived") : join(directory, "assets", "derived")
    this.downloadRoot = layout.split ? join(layout.cache, "download") : join(directory, "resources", "network")
    this.providerJobsRoot = layout.split ? join(layout.cache, "provider-jobs") : join(directory, "provider-jobs")
    this.indexPath = join(this.catalogRoot, "index.json")
    this.missingPath = join(this.catalogRoot, "missing.json")
    this.journalPath = join(this.catalogRoot, "operations.json")
  }
  /** 运行根内的原件不复制：单根时即 dataRoot 之下，分治时是任一声明的域根之下。 */
  private managed(path: string): boolean { return this.layout.managedRoots.some(root => pathInside(root, path)) }
  private async index(): Promise<Catalog> {
    try { return await readJSON<Catalog>(this.indexPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return { records: [] }
    }
  }
  private revision(index: Catalog): string { return registryRevision(index.records) }
  async getRegistryRevision(): Promise<string> { return this.revision(await this.index()) }
  async authoritySnapshot(): Promise<ResourceAuthoritySnapshot> {
    const index = await this.index()
    return { registryRevision: this.revision(index), records: structuredClone(index.records) }
  }
  private async journal(): Promise<AuthorityJournalEntry[]> {
    try { return await readJSON<AuthorityJournalEntry[]>(this.journalPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  private fault(stage: ResourceAuthorityFaultStage): void { this.options.faultInjector?.(stage) }
  /**
   * 每个文件移动并 fsync 后立即把进度写进 prepared journal，让账本里记录的
   * moved 前缀永远不领先于磁盘事实；进程死在中间时恢复能据此整批回滚。
   */
  private async persistMoveProgress(operationID: string, transition: PlannedTransition): Promise<void> {
    transition.phase = "moved"
    const currentJournal = await this.journal()
    const persisted = currentJournal.find(entry => entry.operationID === operationID)
    if (!persisted) return
    persisted.fileTransition = transition
    await atomicJSON(this.journalPath, currentJournal)
  }
  private async planMoveFiles(record: ResourceRecord, destination: string): Promise<ResourceFileTransition[]> {
    const source = localPath(record.ref.original.uri), sourceDirectory = dirname(source), targetDirectory = dirname(destination)
    if (source === destination) throw new Error("RESOURCE_MOVE_SOURCE_EQUALS_TARGET")
    const primary = resolve(source)
    const seen = new Set<string>(), checkedDirectories = new Set<string>(), plannedTargets = new Set<string>(), files: ResourceFileTransition[] = []
    for (const dependency of record.parsed.dependencies) {
      const dependencyPath = resolve(dependency.path)
      if (!pathInside(sourceDirectory, dependencyPath)) throw new Error(`RESOURCE_MOVE_DEPENDENCY_OUTSIDE_DIRECTORY: ${dependencyPath}`)
      if (seen.has(dependencyPath)) continue
      seen.add(dependencyPath)
      // 主原件按用户给出的新本地路径落位（targetPath 的 basename 即改名）；
      // 依赖闭包在目标目录下保持与源目录相同的相对层级，资产内部的相对引用
      // 不因主文件改名而失效（CR-004）。
      const targetPath = dependencyPath === primary ? resolve(destination) : resolve(targetDirectory, relative(sourceDirectory, dependencyPath))
      if (targetPath === dependencyPath) {
        // 仅主原件同目录改名时其余依赖原地不动；主原件本身没有新路径可搬。
        if (dependencyPath === primary) throw new Error("RESOURCE_MOVE_SOURCE_EQUALS_TARGET")
        continue
      }
      // 新的主文件名可能与某个依赖的相对位置重合；同一批规划出两个同名目标
      // 必须在计划阶段拒绝，而不是搬到一半才由排他原语报冲突。
      if (plannedTargets.has(targetPath)) throw new Error(`RESOURCE_MOVE_TARGET_CONFLICT: ${targetPath}`)
      plannedTargets.add(targetPath)
      // 多文件/目录搬迁会按相对层级在新位置重建子目录。计划阶段就确认目标父链
      // 上没有文件挡路，避免把可预见的失败留到搬到一半才发生。
      const targetParent = dirname(targetPath)
      if (!checkedDirectories.has(targetParent)) { await assertDirectoryCreatable(targetParent); checkedDirectories.add(targetParent) }
      if (await pathExists(targetPath)) throw new Error(`RESOURCE_MOVE_TARGET_CONFLICT: ${targetPath}`)
      files.push({ sourcePath: dependencyPath, targetPath, inventory: await inventoryFiles([dependency]), targetExisted: false })
    }
    if (!files.some(file => file.sourcePath === primary)) throw new Error("RESOURCE_MOVE_PRIMARY_NOT_REGISTERED")
    return files
  }
  private async planFileTransition(index: Catalog, command: Record<string, any>): Promise<PlannedTransition | undefined> {
    if (command.kind !== "move" && command.kind !== "rollbackMove") return undefined
    const record = index.records.filter(item => item.ref.resourceId === command.resourceId).sort((a, b) => b.ref.version - a.ref.version)[0]
    if (!record) throw new Error(`RESOURCE_NOT_FOUND: ${command.resourceId}`)
    if (command.kind === "move") {
      const destination = localPath(command.target)
      const files = await this.planMoveFiles(record, destination)
      const primary = files.find(file => file.sourcePath === localPath(record.ref.original.uri))!
      return { ...primary, files, phase: "planned" }
    }
    const tombstone = record.tombstone
    if (!tombstone?.targetPath || tombstone.state !== "moved") throw new Error(`RESOURCE_MOVE_TOMBSTONE_NOT_FOUND: ${command.resourceId}`)
    const files = tombstone.files?.length ? tombstone.files.map(file => ({
      sourcePath: file.targetPath,
      targetPath: file.sourcePath,
      inventory: structuredClone(file.inventory),
      targetExisted: false,
    })) : [{
      sourcePath: tombstone.targetPath,
      targetPath: tombstone.sourcePath,
      inventory: structuredClone(tombstone.inventory),
      targetExisted: false,
    }]
    for (const file of files) {
      if (await pathExists(file.targetPath)) throw new Error(`RESOURCE_MOVE_ROLLBACK_SOURCE_EXISTS: ${file.targetPath}`)
      if (!(await pathExists(file.sourcePath)) || !(await inventoryMatches(file.sourcePath, file.inventory))) throw new Error("RESOURCE_MOVE_ROLLBACK_INVENTORY_MISMATCH")
    }
    const primary = files.find(file => file.sourcePath === tombstone.targetPath) ?? files[0]!
    return { ...primary, files, phase: "planned" }
  }
  private async authorityOperation<T>(identity: ResourceAuthorityIdentity, command: unknown, mutate: (index: Catalog, journalEntry: AuthorityJournalEntry) => Promise<{ result: T; changed?: boolean }>): Promise<T & { operationID: string; idempotencyKey: string; registryRevision: string; beforeRegistryRevision: string; replayed: boolean }> {
    const operationID = identity.operationID ?? randomUUID(), idempotencyKey = identity.idempotencyKey ?? operationID
    return fileTransaction(this.indexPath, async () => {
      const index = await this.index(), beforeRegistryRevision = this.revision(index)
      const entries = await this.journal(), inputHash = commandHash(command)
      const operationCollision = entries.find(item => item.operationID === operationID && item.idempotencyKey !== idempotencyKey)
      if (operationCollision) throw new Error(`RESOURCE_OPERATION_IDENTITY_CONFLICT: ${operationID}`)
      const replay = entries.find(item => item.idempotencyKey === idempotencyKey)
      if (replay) {
        if (replay.inputHash !== inputHash || replay.operationID !== operationID) throw new Error(`RESOURCE_IDEMPOTENCY_CONFLICT: ${idempotencyKey}`)
        if (replay.status !== "applied" || !replay.result || !replay.afterRegistryRevision) throw new Error(`RESOURCE_OPERATION_INCOMPLETE: ${operationID}`)
        return { ...(replay.result as T), operationID, idempotencyKey, registryRevision: replay.afterRegistryRevision, beforeRegistryRevision: replay.beforeRegistryRevision, replayed: true }
      }
      if (identity.expectedRegistryRevision && identity.expectedRegistryRevision !== beforeRegistryRevision) throw new Error(`RESOURCE_REGISTRY_CAS_MISMATCH: expected ${identity.expectedRegistryRevision}, actual ${beforeRegistryRevision}`)
      const prepared: AuthorityJournalEntry = { operationID, idempotencyKey, inputHash, status: "prepared", beforeRegistryRevision, beforeCatalog: structuredClone(index), createdAt: new Date().toISOString() }
      // Move 先把可验证的文件 inventory 写进 prepared journal。即使进程死在文件搬迁与 index 发布之间，
      // recovery 也能判断应回滚，而不是留下半个 authority row。
      if (isRecord(command)) prepared.fileTransition = await this.planFileTransition(index, command)
      entries.push(prepared); await atomicJSON(this.journalPath, entries)
      this.fault("prepared_journal")
      const changed = await mutate(index, prepared)
      this.fault("after_file_transition")
      const afterRegistryRevision = changed.changed === false ? beforeRegistryRevision : this.revision(index)
      if (changed.changed !== false) { index.registryRevision = afterRegistryRevision; await atomicJSON(this.indexPath, index) }
      this.fault("index_published")
      prepared.status = "applied"; prepared.afterRegistryRevision = afterRegistryRevision; prepared.afterCatalog = structuredClone(index); prepared.result = changed.result; prepared.appliedAt = new Date().toISOString()
      await atomicJSON(this.journalPath, entries)
      this.fault("journal_applied")
      return { ...(changed.result as T), operationID, idempotencyKey, registryRevision: afterRegistryRevision, beforeRegistryRevision, replayed: false }
    })
  }
  /** 从持久账本恢复最后一个完整 authority 快照；不删除或改写用户原件。
   * 与所有 authority 写事务共用同一索引锁（CR-005）：move 的文件搬迁与 index/
   * journal 发布是一个不可分割的权威事务，恢复必须等它结束后再按账本判定，
   * 否则会在中途回滚文件、随后又被原操作发布的索引/账本覆盖，留下永久不一致。 */
  async recoverResourceAuthorityOperations(): Promise<string[]> {
    return fileTransaction(this.indexPath, () => this.recoverAuthorityLocked())
  }
  private async recoverAuthorityLocked(): Promise<string[]> {
    const entries = await this.journal(), recovered: string[] = []
    if (!entries.length) return recovered
    let index: Catalog | undefined
    try { index = await this.index() } catch { index = undefined }
    const applied = entries.filter(item => item.status === "applied" && item.afterCatalog).at(-1)
    if (!index && applied?.afterCatalog) { index = applied.afterCatalog; await atomicJSON(this.indexPath, applied.afterCatalog); recovered.push(applied.operationID) }
    else if (!index) throw new Error("RESOURCE_AUTHORITY_RECOVERY_UNAVAILABLE")
    // A prepared move with source absent and target present is a file-only partial
    // transition. Restore the original path before dropping the intent. This is
    // deliberately best-effort and fail-closed when inventory does not match.
    const rolledBack = new Set<string>()
    const unsafeTransitions = new Set<string>()
    for (const entry of entries.filter(item => item.status === "prepared" && item.fileTransition)) {
      const transition = entry.fileTransition!
      const files = transitionFiles(transition)
      const movedFiles: ResourceFileTransition[] = []
      let unsafe = false
      for (const file of files) {
        const sourceExists = await isFile(file.sourcePath)
        const targetExists = await isFile(file.targetPath)
        const sourceMatches = sourceExists && await inventoryMatches(file.sourcePath, file.inventory)
        const targetMatches = targetExists && await inventoryMatches(file.targetPath, file.inventory)
        if (!sourceExists && targetMatches) movedFiles.push(file)
        else if (sourceMatches && targetExists && !targetMatches) {
          // 排他搬迁绝不覆盖已存在的目标，因此“源文件字节自洽、目标位置是
          // 别的字节”可以证明这个文件从未被本次操作移动，目标属于外部创建
          // 者。保留它、继续回滚其余已移走的文件，而不是把整批判为不明确。
          continue
        }
        else if (!sourceMatches || targetExists) {
          // Both locations, neither location, or changed bytes are ambiguous.
          // Leave the prepared intent for manual repair instead of guessing.
          unsafe = true
          break
        }
      }
      if (unsafe) { unsafeTransitions.add(entry.operationID); continue }
      if (!movedFiles.length) continue
      try {
        // 多文件/目录搬迁必须整批恢复：已移走的每个文件都搬回原路径并 fsync，
        // 然后逐一复核 inventory 与原路径清空。外部占用的目标不属于本操作，
        // 既不复核也不触碰；只有确实搬走过的目标才必须为空。
        await moveFilesDurable(movedFiles.map(file => ({ sourcePath: file.targetPath, targetPath: file.sourcePath })))
        for (const file of files) {
          if (!(await isFile(file.sourcePath)) || !(await inventoryMatches(file.sourcePath, file.inventory))) throw new Error("RESOURCE_MOVE_ROLLBACK_VERIFY_FAILED")
        }
        for (const file of movedFiles) {
          if (await isFile(file.targetPath)) throw new Error("RESOURCE_MOVE_ROLLBACK_VERIFY_FAILED")
        }
        rolledBack.add(entry.operationID)
        recovered.push(entry.operationID)
      } catch {
        // Keep the prepared intent if any file cannot be restored.
        unsafeTransitions.add(entry.operationID)
      }
    }
    // A prepared operation is never a committed operation. If the authority
    // index was already published before the journal could be marked applied,
    // restore the exact before snapshot. This closes the crash window between
    // index replacement and the second journal write; leaving the changed
    // index in place would expose a half-committed authority row.
    const discardedPrepared = new Set<string>()
    for (const [entryIndex, entry] of entries.entries()) {
      if (entry.status !== "prepared" || unsafeTransitions.has(entry.operationID)) continue
      const laterApplied = entries.slice(entryIndex + 1).some(item => item.status === "applied")
      if (laterApplied) continue
      if (rolledBack.has(entry.operationID) || this.revision(index!) !== entry.beforeRegistryRevision) {
        index = structuredClone(entry.beforeCatalog)
      }
      discardedPrepared.add(entry.operationID)
      // 被丢弃的 prepared 操作从未提交，索引已回到 beforeCatalog；它留下的
      // move_/trash_ tombstone 只是 authority 自己的遗物，一并清理避免孤儿记录。
      for (const prefix of ["move", "trash"] as const) {
        try { await rm(join(this.catalogRoot, "tombstones", `${safeId(`${prefix}_${entry.operationID}`)}.json`), { force: true }) }
        catch { /* 清理尽力而为；不改变文件与索引的一致性判定 */ }
      }
      if (!recovered.includes(entry.operationID)) recovered.push(entry.operationID)
    }
    const remaining = entries.filter(item => {
      if (item.status !== "prepared") return true
      if (discardedPrepared.has(item.operationID)) return false
      return true
    })
    if (discardedPrepared.size) await atomicJSON(this.indexPath, index)
    if (remaining.length !== entries.length) await atomicJSON(this.journalPath, remaining)
    return recovered
  }
  /** 外部原件连同依赖闭包复制进 <dataRoot>/assets/cas；任一文件失败时清理本次新建目标，不留半截。 */
  private async storeInCas(entryPath: string, parsed: ParsedAsset): Promise<{ entry: string; targets: Map<string, string> }> {
    const closure = [...new Set(parsed.dependencies.map(stamp => resolve(stamp.path)))]
    const stamps = new Map(parsed.dependencies.map(stamp => [resolve(stamp.path), stamp]))
    for (const source of closure) {
      const stamp = stamps.get(source)!
      if (!stamp.sha256) stamps.set(source, await fileStamp(source, true))
    }
    const entry = stamps.get(resolve(entryPath)) ?? entryDependency(parsed, entryPath)
    const layout = planCasStore(this.casRoot, entry.sha256!, resolve(entryPath), closure, stamps)
    const created: string[] = []
    try {
      for (const [source, target] of layout.targets) {
        const stamp = stamps.get(source)!
        await storeFileVerified(source, stamp.sha256 ? stamp : await fileStamp(source, true), target, created)
      }
      // 多文件闭包额外落内容寻址锚点（与入口副本同字节的硬链），保留 sha 命名便于排重与排查。
      if (layout.anchor !== layout.entry) await storeFileVerified(layout.entry, entry.sha256 ? entry : await fileStamp(layout.entry, true), layout.anchor, created, true)
    } catch (error) {
      for (const target of created.reverse()) await rm(target, { force: true }).catch(() => {})
      throw error
    }
    return { entry: layout.entry, targets: layout.targets }
  }
  /** 把原件连同依赖闭包写进指定根；任一文件失败时清理本次新建目标，不留半截。 */
  private async writeMaterializedTree(root: string, entryPath: string, parsed: ParsedAsset): Promise<{ entry: string; targets: Map<string, string> }> {
    const closure = [...new Set(parsed.dependencies.map(stamp => resolve(stamp.path)))]
    const stamps = new Map(parsed.dependencies.map(stamp => [resolve(stamp.path), stamp]))
    const plan = planMaterializedStore(root, resolve(entryPath), closure)
    const created: string[] = []
    try {
      for (const [source, target] of plan.targets) {
        const stamp = stamps.get(source)!
        await storeFileVerified(source, stamp.sha256 ? stamp : await fileStamp(source, true), target, created)
      }
    } catch (error) {
      for (const target of created.reverse()) await rm(target, { force: true }).catch(() => {})
      throw error
    }
    return { entry: plan.entry, targets: plan.targets }
  }
  /**
   * materialized：原件连同依赖闭包复制进按资源类别决定的域目录 <域根>/<assetId>/source/**。
   * 同字节已在位时直接复用（重复导入不报错）；同一 assetId 的新版本与已落地字节不同时退到
   * source/v<N>/，绝不覆盖上一版——域目录按资产身份稳定，版本差异留在版本子目录里。
   */
  private async storeMaterialized(entryPath: string, parsed: ParsedAsset, category: ResourceAuthorityCategory, resourceId: string, version: number): Promise<{ entry: string; targets: Map<string, string>; home: ResourceMaterializedHome }> {
    const home = materializedHome(this.layout, materializedDomain(category), resourceId)
    let directory = home.directory
    let plan: { entry: string; targets: Map<string, string> }
    try { plan = await this.writeMaterializedTree(directory, entryPath, parsed) }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("RESOURCE_CAS_TARGET_CONFLICT")) throw error
      directory = join(home.directory, `v${version}`)
      plan = await this.writeMaterializedTree(directory, entryPath, parsed)
    }
    return { entry: plan.entry, targets: plan.targets, home: { domain: home.domain, directory, entryPath: plan.entry, files: plan.targets.size, materializedAt: new Date().toISOString() } }
  }
  /**
   * splat 的场景几何绑定解析（只登记文档事实，不读取几何字节）：
   * 显式 binding：mesh 路径按产品根 materials/ 解析（与 plugin.ts builtinAssets 同一约定），
   * splat/mesh 实际 sha256 与登记不符时降级为 candidate（不伪造信任），警告随账本结果持久化。
   * 未显式给出：同名 .glb 自动配对候选（单位阵、same-stem-spz-glb-pair、revision 取 mesh 文件 sha256）。
   * 绑定路径必须满足合同的工作区相对路径规则，无法合规登记时不创建绑定。
   * mesh 原件与 splat 走同一存储分支：产品自带/运行根内引用原位置；外部原件复制进 CAS。
   */
  private async resolveSceneGeometry(givenPath: string, path: string, explicit: SceneGeometryBinding | undefined, splatSha256: string | undefined, source: ResourceRef["source"], warnings: string[]): Promise<{ binding: SceneGeometryBinding; representation: Representation } | undefined> {
    let binding: SceneGeometryBinding | undefined
    let meshPath: string | undefined
    let meshStamp: FileStamp | undefined
    if (explicit) {
      const declared = parseSceneGeometryBinding(explicit)
      if (!declared) throw new Error("SCENE_GEOMETRY_BINDING_INVALID: 显式几何绑定不符合 scene-geometry 合同")
      meshPath = this.options.productRoot ? resolve(join(this.options.productRoot, "materials"), declared.mesh.path) : resolve(declared.mesh.path)
      meshStamp = await fileStamp(meshPath, true).catch(() => undefined)
      const splatMatches = Boolean(splatSha256) && splatSha256 === declared.splat.sha256
      const meshMatches = meshStamp?.sha256 === declared.mesh.sha256
      binding = declared
      if (!splatMatches || !meshMatches) {
        binding = { ...declared, splat: { ...declared.splat }, mesh: { ...declared.mesh }, meshToSplat: [...declared.meshToSplat] as Matrix4Elements, alignmentStatus: "candidate" }
        warnings.push(`场景几何绑定与磁盘原件哈希不符（splat ${splatMatches ? "一致" : "不符"}，mesh ${meshMatches ? "一致" : "不符"}），对齐状态已降级为 candidate：${declared.mesh.path}`)
      }
    } else {
      const sibling = join(dirname(path), basename(path, extname(path)) + ".glb")
      if (!(await isFile(sibling))) return undefined
      meshPath = sibling
      meshStamp = await fileStamp(sibling, true).catch(() => undefined)
      const splatRefPath = this.sceneGeometryRefPath(path, givenPath)
      const meshRefPath = this.sceneGeometryRefPath(sibling, join(dirname(givenPath), basename(givenPath, extname(givenPath)) + ".glb"))
      if (!meshStamp?.sha256 || !splatSha256 || !splatRefPath || !meshRefPath) return undefined
      // 用合同自身复核候选（工作区相对路径、哈希形状），不合规则不登记。
      binding = parseSceneGeometryBinding({
        splat: { path: splatRefPath, sha256: splatSha256 },
        mesh: { path: meshRefPath, sha256: meshStamp.sha256 },
        meshToSplat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        alignmentStatus: "candidate",
        method: "same-stem-spz-glb-pair",
        revision: meshStamp.sha256,
      })
      if (!binding) return undefined
    }
    if (!meshPath) return undefined
    // 文件当前缺失时无字节可入 CAS，只能引用其应处位置（此时绑定已降级 candidate，不进物理）。
    let meshEntry = resolve(meshPath)
    if (meshStamp) {
      const meshExternal = !(this.options.productRoot && pathInside(this.options.productRoot, meshPath)) && !this.managed(meshPath)
      if (meshExternal) meshEntry = (await this.storeInCas(meshPath, { kind: "mesh", mimeType: "model/gltf-binary", source, dependencies: [meshStamp], metadata: {} })).entry
    }
    return { binding, representation: { uri: pathToFileURL(meshEntry).href, mimeType: "model/gltf-binary", role: "collision" } }
  }
  /** 绑定合同只收工作区相对路径：产品根内按 materials/ 相对登记；输入本身是相对路径时按原样；否则无法合规登记。 */
  private sceneGeometryRefPath(absolutePath: string, givenPath: string): string | undefined {
    const materials = this.options.productRoot ? join(this.options.productRoot, "materials") : undefined
    if (materials && pathInside(materials, absolutePath)) return relative(materials, absolutePath).split(sep).join("/")
    if (this.options.productRoot && pathInside(this.options.productRoot, absolutePath)) return relative(this.options.productRoot, absolutePath).split(sep).join("/")
    if (!isAbsolute(givenPath)) return givenPath.split(sep).join("/")
    return undefined
  }
  async import(input: { path: string; name?: string; resourceId?: string; category?: ResourceAuthorityCategory; source?: ResourceRef["source"]; sourceTexturePolicy?:SourceTexturePolicy; tags?: string[]; folder?: string; components?: Entity["components"]; sceneGeometryBinding?: SceneGeometryBinding; storage?: ResourceStorageKind } & ResourceImportDefaults & ResourceAuthorityIdentity): Promise<ResourceRecord & { replayed?: boolean; beforeRegistryRevision?: string; alreadyPresent?: boolean; warnings?: string[] }> {
    validatePhysicalizationRequest(input.physicalizationRequest)
    const path = localPath(input.path)
    const resourceId = input.resourceId ? safeId(input.resourceId) : `res_${randomUUID()}`
    const { operationID, idempotencyKey, expectedRegistryRevision, category, storage: requestedStorage, ...metadata } = input
    // 显式 storage 优先，其次是库级默认；两者都没有时保持旧行为不变。存储模式影响落盘位置，
    // 必须参与命令哈希，否则同幂等键换模式会被当成同一操作重放。
    const storageRequest = requestedStorage ?? this.options.defaultStorage
    if (storageRequest !== undefined && storageRequest !== "reference" && storageRequest !== "cas" && storageRequest !== "materialized") throw new Error(`RESOURCE_STORAGE_INVALID: ${String(storageRequest)}`)
    const result = await this.authorityOperation({ operationID, idempotencyKey, expectedRegistryRevision }, {
      kind: "import", path, resourceId, category, source: input.source, name: input.name, tags: input.tags, folder: input.folder,
      ...(input.components ? { components: input.components } : {}),
      // 绑定影响记录内容，必须参与命令哈希，否则同幂等键换绑定会被当成同一操作重放。
      ...(input.sceneGeometryBinding ? { sceneGeometryBinding: input.sceneGeometryBinding } : {}),
      ...(input.physicalizationRequest !== undefined ? { physicalizationRequest: input.physicalizationRequest } : {}),
      ...(input.sourceTexturePolicy !== undefined ? {sourceTexturePolicy:input.sourceTexturePolicy} : {}),
      ...(storageRequest ? { storage: storageRequest } : {}),
    }, async (index): Promise<{ result: ResourceRecord & { alreadyPresent?: true; warnings?: string[] }; changed?: boolean }> => {
      let parsed = await parseAsset(path, input.source,{sourceTexturePolicy:input.sourceTexturePolicy})
      const resolvedCategory = authorityCategory(category, parsed.kind)
      const existing = index.records.filter(item => item.ref.resourceId === resourceId)
      if (existing.length && existing.some(item => item.category && item.category !== resolvedCategory)) throw new Error(`RESOURCE_IDENTITY_CATEGORY_CONFLICT: ${resourceId}`)
      // 内容去重：入口字节与 category 都相同的活记录直接复用，不新增记录、不升版本（index 不发布新 revision）。
      const entrySha = entryDependency(parsed, path).sha256
      if (entrySha) {
        // 显式指定存储模式时去重只认同一模式的记录：否则「导入为 materialized」会被既有
        // reference/cas 记录吸收，原件永远进不了域目录。未指定时不过滤，保持旧行为逐字一致。
        const matches = index.records.filter(record => !record.deletedAt && recordCategory(record) === resolvedCategory && recordEntrySha(record) === entrySha
          && (record.parsed.metadata.sourceTexturePolicy??'strict')===(parsed.metadata.sourceTexturePolicy??'strict')
          && isDeepStrictEqual(record.parsed.metadata.missingTextureSnapshot??[],parsed.metadata.missingTextureSnapshot??[])
          && isDeepStrictEqual(record.ref.source, parsed.source)
          && record.parsed.dependencies.length === parsed.dependencies.length
          && record.parsed.dependencies.every(stamp => {
            const original=localPath(record.ref.original.uri)
            const incoming = resolve(localPath(stamp.path))===resolve(original)?entryDependency(parsed,path):parsed.dependencies.find(next => relative(dirname(original), localPath(stamp.path)) === relative(dirname(path), localPath(next.path)))
            return incoming !== undefined && stamp.sha256 !== undefined && stamp.sha256 === incoming.sha256 && stamp.size === incoming.size
          })
          && (storageRequest === undefined || (record.storage ?? "reference") === storageRequest))
        if (matches.length) {
          const sameId = matches.filter(record => record.ref.resourceId === resourceId).sort((a, b) => b.ref.version - a.ref.version)[0]
          const match = sameId ?? matches.sort((a, b) => b.ref.version - a.ref.version || b.createdAt.localeCompare(a.createdAt))[0]!
          const changed = retainPhysicalizationRequest(match, input.physicalizationRequest)
          return { result: { ...structuredClone(match), alreadyPresent: true as const }, changed }
        }
      }
      const version = 1 + Math.max(0, ...existing.map(item => item.ref.version))
      // 未显式指定存储模式时保持旧行为：产品自带与运行根内的原件引用原位置，外部原件连同依赖闭包复制进 CAS。
      const external = !(this.options.productRoot && pathInside(this.options.productRoot, path)) && !this.managed(path)
      const mode: ResourceStorageKind = storageRequest ?? (external ? "cas" : "reference")
      let entryPath = resolve(path), storage: ResourceStorageKind = "reference", home: ResourceMaterializedHome | undefined
      if (mode === "materialized") {
        if (!this.layout.split) throw new Error("RESOURCE_MATERIALIZE_REQUIRES_LAYOUT: 省略 layout 时只有单根，没有可落地的域目录")
        const stored = await this.storeMaterialized(path, parsed, resolvedCategory, resourceId, version)
        entryPath = stored.entry
        storage = "materialized"
        home = stored.home
        parsed = { ...parsed, dependencies: parsed.dependencies.map(stamp => ({ ...stamp, path: stored.targets.get(resolve(stamp.path)) ?? stamp.path })) }
      } else if (mode === "cas") {
        const stored = await this.storeInCas(path, parsed)
        entryPath = stored.entry
        storage = "cas"
        parsed = { ...parsed, dependencies: parsed.dependencies.map(stamp => ({ ...stamp, path: stored.targets.get(resolve(stamp.path)) ?? stamp.path })) }
      }
      const original = { uri: pathToFileURL(entryPath).href, mimeType: parsed.mimeType }
      // splat 场景几何绑定：显式登记先核对磁盘真实哈希（不符降级 candidate 并随账本结果记警告）；
      // 未给出时按同名 .glb 自动配对候选。只登记文档事实，不读取几何字节，也不改变去重/版本语义。
      const geometryWarnings: string[] = []
      const geometry = parsed.kind === "splat" ? await this.resolveSceneGeometry(input.path, path, input.sceneGeometryBinding, entrySha, parsed.source, geometryWarnings) : undefined
      // 导入时显式给出的 components 是该资产自身的声明（例如车辆控制映射）→ 记为资源默认。
      const componentDefaults = discoverableComponentDefaults(input.components)
      const textureSnapshot=(parsed.metadata.missingTextureSnapshot??[]) as Array<{kind?:string}>
      const textureTags=parsed.metadata.sourceTexturePolicy==='available'?['保留几何与现有材质',`缺失依赖 ${textureSnapshot.filter(loss=>loss.kind==='image'||loss.kind==='material-library').length}`,`空纹理声明 ${textureSnapshot.filter(loss=>loss.kind==='empty-texture-path').length}`]:[]
      const record: ResourceRecord = {
        ref: { resourceId, version, original, representations: [{ ...original, role: parsed.kind === "robot" ? "simulation" : "visual" }], source: parsed.source },
        category: resolvedCategory, name: metadata.name ?? basename(path, extname(path)), tags: [...new Set([...(metadata.tags??[]),...textureTags])], folder: metadata.folder ?? "", createdAt: new Date().toISOString(), parsed, storage, storedEntryPath: entryPath,
        // 只有 materialized 写 home；reference/cas 记录字节不变，既有索引与 registryRevision 不受影响。
        ...(home?{home}:{}),
        ...(componentDefaults?{componentDefaults,explicitComponentDefaultKeys:Object.keys(componentDefaults)}:{}),
        ...(metadata.license?{license:normalizeResourceLicense(metadata.license)}:{}),
        ...(metadata.physicalizationRequest !== undefined ? { physicalizationRequest: structuredClone(metadata.physicalizationRequest) } : {}),
        ...(metadata.mountTransform?{mountTransform:structuredClone(metadata.mountTransform)}:{}),...(metadata.visualSourceTransform?{visualSourceTransform:structuredClone(metadata.visualSourceTransform)}:{}),...(metadata.legacySource?{legacySource:structuredClone(metadata.legacySource)}:{}),...(metadata.networkProvenance?{networkProvenance:structuredClone(metadata.networkProvenance)}:{}),
        operationID: operationID ?? randomUUID(), idempotencyKey: idempotencyKey ?? operationID ?? randomUUID(),
      }
      if (geometry) {
        record.sceneGeometryBinding = geometry.binding
        record.ref.representations.push(geometry.representation)
        // Marble 成对导出（SPZ 与 GLB 同帧、Y-up）的机器核验绑定同时是轴事实：
        // 源轴→Z-up 的转换只在此导入适配器执行一次并保留原件（§2.7），Viewer 与
        // sim 不再各自转换。同名候选绑定（same-stem）轴关系未核验，不做此推断。
        if (record.visualSourceTransform === undefined && /marble|paired spz\/glb/i.test(geometry.binding.method)) {
          record.visualSourceTransform = sourceTransform({ units: "m", upAxis: "Y", handedness: "right" })
        }
      }
      index.records.push(record)
      return { result: { ...structuredClone(record), ...(geometryWarnings.length ? { warnings: geometryWarnings } : {}) } }
    })
    return result
  }
  /**
   * 工程中的不可变引用进入本账号已有资源库；保留有效跨目录路径，不搬动原件。
   * 同时把文档里所有引用一致给出的组件（例如 controller）登记为该资源的默认组件，
   * 之后 scene_mount 按 resourceId 挂载即可保留原控制语义；只补缺、不改写已有默认。
   */
  async registerReferences(entries: Array<{ ref: ResourceRef; name?: string; components?: Entity["components"] }>): Promise<ResourceRecord[]> {
    return fileTransaction(this.indexPath, async () => {
      const index = await this.index(), unique = new Map<string, { ref: ResourceRef; name?: string; instances: Array<Entity["components"] | undefined> }>()
      for (const entry of entries) {
        const key = `${entry.ref.resourceId}@${entry.ref.version}`, previous = unique.get(key)
        if (previous && !isDeepStrictEqual(refVersionIdentity(previous.ref), refVersionIdentity(entry.ref))) throw new Error(`RESOURCE_VERSION_SOURCE_CONFLICT: ${key}`)
        if (previous) previous.instances.push(entry.components)
        else unique.set(key, { ref: entry.ref, name: entry.name, instances: [entry.components] })
      }
      const failures: Array<{ resourceId: string; version: number; uri: string; reason: string }> = []
      const parsedFiles = new Map<string, Promise<ParsedAsset>>()
      const inspect = (uri: string, source: ResourceRef['source']) => {
        const key = JSON.stringify([uri, source])
        let pending = parsedFiles.get(key)
        if (!pending) { pending = parseAsset(localPath(uri), source); parsedFiles.set(key, pending) }
        return pending
      }
      const adopted: ResourceRecord[] = [], additions: ResourceRecord[] = []
      let relocated = false, defaultsChanged = false
      const selectLocation = (record: ResourceRecord, location: ResourceLocation) => {
        if (adoptLocation(record, location)) relocated = true
        adopted.push(record)
      }
      for (const { ref, name, instances } of unique.values()) {
        const discovered = agreedComponentDefaults(instances)
        const existing = index.records.find(row => row.ref.resourceId === ref.resourceId && row.ref.version === ref.version)
        const known = existing && locations(existing).find(location => isDeepStrictEqual(refVersionIdentity(location.ref), refVersionIdentity(ref)))
        if (existing && known) {
          const verification = await verifyLocation(known)
          if (!verification.valid) throw new Error(`RESOURCE_VERSION_UNAVAILABLE: ${ref.resourceId}@${ref.version} ${JSON.stringify(verification)}`)
          const merged = mergeComponentDefaults(existing.componentDefaults, discovered)
          if (merged.changed) { existing.componentDefaults = merged.value; defaultsChanged = true }
          selectLocation(existing, known); continue
        }
        const inspected = await this.inspectReference(ref, inspect)
        failures.push(...inspected.failures)
        const { parsed } = inspected
        if (!parsed) continue
        const record: ResourceRecord = { ref: structuredClone(ref), name: name ?? basename(localPath(ref.original.uri), extname(localPath(ref.original.uri))), tags: [], folder: '', createdAt: new Date().toISOString(), parsed, ...(discovered ? { componentDefaults: structuredClone(discovered) } : {}) }
        if (existing) {
          // 已登记位置的字节是版本身份的唯一依据；位置可变、字节不能变。同一版本的每一处位置都是按
          // 真实字节（sameVersionAtAnotherLocation）进来的，所以按"任一已登记位置"比对与只看主位置
          // 等价；字节真的不同就是另一个版本，由 registerDerivedVersion 另立版本号后再引用。
          if (!locations(existing).some(location => sameVersionAtAnotherLocation(location, record))) throw new Error(`RESOURCE_VERSION_SOURCE_CONFLICT: ${ref.resourceId}@${ref.version}；新位置内容或表示与已登记版本不一致`)
          const merged = mergeComponentDefaults(existing.componentDefaults, discovered)
          if (merged.changed) { existing.componentDefaults = merged.value; defaultsChanged = true }
          selectLocation(existing, record)
        } else { additions.push(record); adopted.push(record) }
      }
      if (failures.length) throw new Error(`SCENE_RESOURCE_UNAVAILABLE: ${JSON.stringify(failures)}`)
      if (additions.length || relocated || defaultsChanged) { index.records.push(...additions); await atomicJSON(this.indexPath, index) }
      return structuredClone(adopted)
    })
  }
  /**
   * 读一个引用的真实依赖集（登记与派生登记共用同一读法，避免两条路各读一套）：
   * role='collision' 的物理化派生物只核对真实存在（可由同一原件重新派生，不进版本身份依赖）；
   * 其余表示逐个按真实字节解析，不可解析的附件按文件戳计入。failures 由调用方按自己的口径汇总。
   */
  private async inspectReference(ref: ResourceRef, inspect: (uri: string, source: ResourceRef["source"]) => Promise<ParsedAsset>): Promise<{ parsed?: ParsedAsset; failures: Array<{ resourceId: string; version: number; uri: string; reason: string }> }> {
    const failures: Array<{ resourceId: string; version: number; uri: string; reason: string }> = []
    let selected: ParsedAsset | undefined
    const dependencies = new Map<string, ParsedAsset["dependencies"][number]>()
    for (const representation of [ref.original, ...ref.representations]) {
      if (representation.role === "collision" && representation !== ref.original) {
        try { await fileStamp(localPath(representation.uri)) } catch (error) { failures.push({ resourceId: ref.resourceId, version: ref.version, uri: representation.uri, reason: String(error) }) }
        continue
      }
      try {
        const value = await inspect(representation.uri, ref.source)
        for (const dependency of value.dependencies) dependencies.set(dependency.path, dependency)
        // blend/USD 原件保留；可挂载显示元数据取真实 visual 派生表示。
        if (!selected || selected.kind === "source" && representation.role === "visual" && value.kind !== "source") selected = value
      } catch (error) {
        // 非模型派生附件仍核对真实文件，不能替换不可解析的主原件。
        if (representation !== ref.original && String(error).includes("UNSUPPORTED_RESOURCE_FORMAT")) {
          try { const stamp = await fileStamp(localPath(representation.uri)); if (representation.role !== "collision") dependencies.set(stamp.path, stamp); continue } catch (failure) { error = failure }
        }
        failures.push({ resourceId: ref.resourceId, version: ref.version, uri: representation.uri, reason: String(error) })
      }
    }
    return selected ? { parsed: { ...selected, dependencies: [...dependencies.values()] }, failures } : { failures }
  }
  /**
   * 把一个**字节确定变了**的副本登记为该资源 id 的**新版本**（版本号由库分配），并记下它的来历。
   * 这里没有任何"同一版本换一份字节"的通道：调用方给的 ref 只提供新位置与表示结构，版本号一律
   * 由库按 `1 + max(已登记版本)` 另立；旧版本的记录与判据一步不动，也不存在用声明的内容戳去改写
   * 旧版本依赖的路径。逐文件只能提供"实测事实"，且逐条按真实字节核对：
   *  1) 必须声明这是一次真实改写（kind 与 files 非空，且 before/after 字节确实不同）；
   *  2) source/target 必须是磁盘上真实存在的文件，且内容戳与声明逐字节一致（声明不能凭空写）；
   *  3) from 必须是该资源 id 已登记的版本；
   *  4) 新位置的字节与**任意一个**已登记版本逐字节一致时**不另立版本**，直接复用那个版本（重复保存不涨
   *     版本）；调用方声明里的版本号不参与这次内容比对（只在局部规范化），命中后它带来的位置被采纳为
   *     该版本的位置。
   */
  async registerDerivedVersion(input: { ref: ResourceRef; derivation: ResourceVersionDerivation }): Promise<{ record: ResourceRecord; ref: ResourceRef; reused: boolean }> {
    return fileTransaction(this.indexPath, async () => {
      const index = await this.index()
      const declaration = input.derivation
      const resourceId = input.ref.resourceId
      const versions = index.records.filter(row => row.ref.resourceId === resourceId)
      if (declaration.kind !== "external-path-rewrite" || !declaration.files.length) throw new Error(`RESOURCE_DERIVATION_REQUIRED: ${resourceId}；派生版本必须说明改写了哪些文件（source/target 与改写前后的真实内容戳）`)
      if (!versions.some(row => row.ref.version === declaration.from)) throw new Error(`RESOURCE_DERIVATION_SOURCE_UNKNOWN: ${resourceId}@${declaration.from}（不是该资源 id 的已登记版本）`)
      for (const file of declaration.files) {
        const source = await this.stampOf(file.source)
        if (!source || source.size !== file.before.size || source.sha256 !== file.before.sha256) throw new Error(`RESOURCE_VERSION_MISMATCH: ${resourceId}@${declaration.from} ${file.source}（源文件的真实字节与声明的 before 不一致）`)
        const target = await this.stampOf(file.target)
        if (!target || target.size !== file.after.size || target.sha256 !== file.after.sha256) throw new Error(`RESOURCE_VERSION_MISMATCH: ${resourceId}@${declaration.from} ${file.target}（副本的真实字节与声明的 after 不一致）`)
        if (file.before.sha256 === file.after.sha256 && file.before.size === file.after.size) throw new Error(`RESOURCE_DERIVATION_REQUIRED: ${resourceId}@${declaration.from} ${file.target}（声明的改写没有改变字节：逐字节一致的副本走位置登记，不另立版本）`)
      }
      const cache = new Map<string, Promise<ParsedAsset>>()
      const inspected = await this.inspectReference(input.ref, (uri, source) => {
        const cacheKey = JSON.stringify([uri, source])
        let pending = cache.get(cacheKey)
        if (!pending) { pending = parseAsset(localPath(uri), source); cache.set(cacheKey, pending) }
        return pending
      })
      if (!inspected.parsed) throw new Error(`SCENE_RESOURCE_UNAVAILABLE: ${JSON.stringify(inspected.failures)}`)
      const candidate: ResourceLocation = { ref: structuredClone(input.ref), parsed: inspected.parsed }
      // 真实字节与某个已登记版本一致 ⇒ 那就是那个版本的另一处位置（连版本号都不用新立）。调用方带来的
      // 版本号只是它的声明（重复登记同一份派生字节时它仍写着派生来源那一版），所以这里按同一套判据
      // **跨版本**再找一次——规范化只发生在这一次查询里（见 sameContentAcrossVersions），全局的
      // 同版本判据不放松。同源同目标重复登记、同字节的另一处副本都会命中已有版本；真正不同的字节
      // 两条判据都不命中，走下面的新版本。
      const same = versions.find(row => locations(row).some(location => sameVersionAtAnotherLocation(location, candidate) || sameContentAcrossVersions(location, candidate)))
      if (same) {
        // 命中版本的真实版本号写回候选 ref，再把这个位置采纳为该版本的（主）位置：调用方拿到的 ref 指向
        // 它这次带来的那份真实文件（包内/新目录），旧位置留为 alternate；旧版本的字节一步不动。
        if (adoptLocation(same, { ref: { ...structuredClone(input.ref), version: same.ref.version }, parsed: inspected.parsed })) await atomicJSON(this.indexPath, index)
        return { record: structuredClone(same), ref: structuredClone(same.ref), reused: true }
      }
      const version = 1 + Math.max(0, ...versions.map(row => row.ref.version))
      const from = versions.find(row => row.ref.version === declaration.from)!
      // 同一个资源 id 的新版本：名字/标签/目录/类别/默认组件沿用来源版本（它们是资源级的用户设置），
      // 只有 ref（位置 + 版本号）、parsed（这一版自己的真实字节）与 derivedFrom（来历）是新的。
      const record: ResourceRecord = {
        ref: { ...structuredClone(input.ref), version },
        name: from.name, tags: structuredClone(from.tags), folder: from.folder, createdAt: new Date().toISOString(),
        ...(from.category ? { category: from.category } : {}),
        ...(from.componentDefaults ? { componentDefaults: structuredClone(from.componentDefaults) } : {}),
        ...(from.explicitComponentDefaultKeys?{explicitComponentDefaultKeys:[...from.explicitComponentDefaultKeys]}:{}),
        parsed: inspected.parsed,
        derivedFrom: structuredClone(declaration),
      }
      index.records.push(record)
      await atomicJSON(this.indexPath, index)
      return { record: structuredClone(record), ref: structuredClone(record.ref), reused: false }
    })
  }
  /** 升级早期迁移结果时只填缺失的导入默认值，不改已有场景或用户设置。 */
  async retainImportDefaults(resourceId:string,version:number,originalURI:string,defaults:ResourceImportDefaults){
    return fileTransaction(this.indexPath,async()=>{
      const index=await this.index(),record=index.records.find(row=>row.ref.resourceId===resourceId&&row.ref.version===version)
      if(!record)throw new Error('MIGRATION_RESOURCE_SOURCE_MISMATCH: '+resourceId)
      if(record.ref.original.uri!==originalURI){
        // 迁移可重入（合同 §4.6 第 5 条）：首次迁移后 original.uri 已是 CAS 路径，重跑时调用方
        // 仍传旧源路径。只要旧源内容与该版本登记的内容一致，就是同一个原件，按幂等保留默认值，
        // 并把登记位置写回这次传入的原件路径（默认值只在"旧源仍在原处"时有意义）。
        // 内容不一致才是真正的不匹配，仍然拒绝——不把判据放宽成"路径不同即通过"。
        const legacy=await this.stampOf(originalURI)
        const sameContent=legacy!==undefined&&record.parsed.dependencies.some(stamp=>stamp.sha256===legacy.sha256&&stamp.size===legacy.size)
        if(!sameContent)throw new Error('MIGRATION_RESOURCE_SOURCE_MISMATCH: '+resourceId)
        record.ref.original.uri=originalURI
        await atomicJSON(this.indexPath,index)
      }
      let changed=retainPhysicalizationRequest(record, defaults.physicalizationRequest)
      for(const key of ['mountTransform','visualSourceTransform','legacySource'] as const)if(defaults[key]!==undefined&&record[key]===undefined){Object.assign(record,{[key]:structuredClone(defaults[key])});changed=true}
      if(changed)await atomicJSON(this.indexPath,index)
      return {changed,record:structuredClone(record)}
    })
  }
  /** 显式同版本请求沿资源事务保留；复用入口不重新登记、不改原件、身份或版本。 */
  async retainPhysicalizationRequest(resourceId:string,version:number,request:ResourcePhysicalizationRequest):Promise<ResourceRecord>{
    return fileTransaction(this.indexPath,async()=>{
      const index=await this.index(),record=index.records.find(row=>row.ref.resourceId===resourceId&&row.ref.version===version)
      if(!record)throw new Error(`RESOURCE_NOT_FOUND: ${resourceId}@${version}`)
      if(retainPhysicalizationRequest(record,request))await atomicJSON(this.indexPath,index)
      return structuredClone(record)
    })
  }
  /** 取一个原件的真实内容戳（sha256+size）；不可读时返回 undefined，由调用方决定是否拒绝。 */
  private async stampOf(uri:string):Promise<{sha256:string;size:number}|undefined>{
    try{
      const path=localPath(uri),info=await stat(path),bytes=await readFile(path)
      return {sha256:createHash('sha256').update(bytes).digest('hex'),size:info.size}
    }catch{return undefined}
  }
  /**
   * 物理化队列回写：pending 先让进行中状态可见（同时累计 attempts、把上一次终止状态记进
   * previous——失败后重试/换用途重派生都留账）；ok 把碰撞产物追加为 role='collision' 的
   * 派生表示（按 uri 幂等去重，因此 portable 打包/字节核对沿用现有表示通道）并以只补缺
   * 语义并入默认 collision/rigidBody 组件（用户在导入时显式给出的组件不被覆盖）；
   * failed/skipped 只记状态。派生文件本身留在 assets/derived 版本目录，不进 CAS、不搬动。
   */
  async attachPhysicalization(resourceId: string, version: number, patch: ResourcePhysicalizationPatch): Promise<ResourceRecord> {
    return fileTransaction(this.indexPath, async () => {
      const index = await this.index(), record = index.records.find(row => row.ref.resourceId === resourceId && row.ref.version === version)
      if (!record) throw new Error(`RESOURCE_NOT_FOUND: ${resourceId}@${version}`)
      const before = record.physicalization
      if(patch.status==='pending')discardDerivedPhysicsDefaults(record)
      // 成功回执只有在产物逐字节可读后发布。旧 URI 已有发布证据时不可原位换字节；修复须发新位置。
      const artifacts = patch.status === 'ok'
        ? await Promise.all(patch.representations.filter(rep=>rep.role==='collision').map(rep=>fileStamp(localPath(rep.uri),true))) : []
      for(const artifact of artifacts){
        const previous=record.collisionArtifacts?.find(file=>localPath(file.path)===localPath(artifact.path))
        if(previous&&(previous.sha256!==artifact.sha256||previous.size!==artifact.size))throw new Error('COLLISION_ARTIFACT_IMMUTABLE: 已发布派生不能原位替换；请在新修复变体发布')
      }
      // previous 只在一次新的派生命中（pending）滚动：ok/failed 回写时保留同一次尝试开始时记下的那份。
      const previous = patch.status === "pending" && (before?.status === "ok" || before?.status === "failed")
        ? { status: before.status, ...(before.usage ? { usage: before.usage } : {}), ...(before.strategy ? { strategy: before.strategy } : {}), ...(before.error ? { error: before.error } : {}), ...(before.finishedAt ? { finishedAt: before.finishedAt } : {}) }
        : before?.previous
      record.physicalization = {
        status: patch.status,
        ...physicalizationBudgets(patch),
        ...(patch.strategy ? { strategy: patch.strategy } : {}),
        ...(patch.status === "ok" && patch.derivedStrategy ? { derivedStrategy: patch.derivedStrategy } : {}),
        ...(patch.status !== "skipped" && patch.usage ? { usage: patch.usage } : {}),
        ...(patch.status === "failed" ? { error: patch.error } : {}),
        ...(patch.status==='failed'&&patch.errorDetails?{errorDetails:patch.errorDetails}:{}),
        ...patch.status!=='pending'&&before?.progress?{progress:before.progress}:{},
        ...(patch.status !== "pending" ? { finishedAt: new Date().toISOString() } : {}),
        ...(patch.status === "ok" ? {
          artifactUris:patch.representations.filter(rep=>rep.role==='collision').map(rep=>rep.uri),
          ...patch.geometryTransport?{geometryTransport:structuredClone(patch.geometryTransport)}:{},
          ...patch.staticTriangleSurfaces?{staticTriangleSurfaces:structuredClone(patch.staticTriangleSurfaces)}:{},
          ...patch.pointCloud?{pointCloud:structuredClone(patch.pointCloud)}:{},
          ...(patch.sourcePath ? { sourcePath: patch.sourcePath } : {}),
          ...(patch.nodes !== undefined ? { nodes: patch.nodes } : {}),
          ...(patch.parts !== undefined ? { parts: patch.parts } : {}),
          ...(patch.boxes !== undefined ? { boxes: patch.boxes } : {}),
          ...(patch.primitives !== undefined ? { primitives: patch.primitives } : {}),
          ...(patch.interiorPreserved !== undefined ? { interiorPreserved: patch.interiorPreserved } : {}),
          ...(patch.passageVerified !== undefined ? { passageVerified: patch.passageVerified } : {}),
          ...(patch.passageNote ? { passageNote: patch.passageNote } : {}),
          ...(patch.selection && Object.keys(patch.selection).length ? { selection: patch.selection } : {}),
          ...(patch.routed?.length ? { routed: patch.routed } : {}),
          ...(patch.voxelResolutionM?.length ? { voxelResolutionM: patch.voxelResolutionM } : {}),
          ...(patch.volumeRatios?.length ? { volumeRatios: patch.volumeRatios } : {}),
          ...(patch.cavityLostNodes?.length ? { cavityLostNodes: patch.cavityLostNodes } : {}),
          ...(patch.prunedParts?.length ? { prunedParts: patch.prunedParts } : {}),
          ...(patch.policy ? { policy: patch.policy } : {}),
          ...(patch.voxelSizeM !== undefined ? { voxelSizeM: patch.voxelSizeM } : {}),
          ...(patch.supersedes ? { supersedes: true } : {}),
          ...(patch.collisionBounds ? { collisionBounds: patch.collisionBounds } : {}),
        } : {}),
        attempts: patch.status === "pending" ? (before?.attempts ?? 0) + 1 : (before?.attempts ?? 1),
        ...(previous ? { previous } : {}),
      }
      if (patch.status === "ok") {
        const variant={artifactUris:patch.representations.filter(rep=>rep.role==='collision').map(rep=>rep.uri),parameters:{usage:patch.usage,strategy:patch.strategy,policy:patch.policy,...physicalizationBudgets(patch)}}
        record.physicalizationVariants=[...record.physicalizationVariants??[]]
        if(!record.physicalizationVariants.some(existing=>isDeepStrictEqual(existing,variant)))record.physicalizationVariants.push(variant)
        record.collisionArtifacts=[...record.collisionArtifacts??[]]
        for(const artifact of artifacts)if(!record.collisionArtifacts.some(file=>localPath(file.path)===localPath(artifact.path)))record.collisionArtifacts.push(artifact)
        const known = new Set(record.ref.representations.map(rep => rep.uri))
        for (const rep of patch.representations) if (!known.has(rep.uri)) record.ref.representations.push(structuredClone(rep))
        // 重派生（换用途/换策略）必须整体替换这次的派生组件：只补缺的合并会把上一次 dynamic 的
        // 凸包留在记录里，而 physicalization 已经写着 environment —— 记录会说谎。
        const merged = patch.supersedes ? replaceDerivedComponentDefaults(record.componentDefaults, patch.componentDefaults,record.explicitComponentDefaultKeys) : mergeComponentDefaults(record.componentDefaults, patch.componentDefaults)
        if (merged.changed) record.componentDefaults = merged.value
      }
      await atomicJSON(this.indexPath, index)
      return structuredClone(record)
    })
  }
  /** 真实算法进度只更新本次pending参数；上一变体迟到事件不能改新任务。 */
  async notePhysicalizationProgress(resourceId:string,version:number,request:{usage?:string;strategy?:string}&PhysicalizationBudgetOptions,progress:NonNullable<ResourcePhysicalization['progress']>):Promise<void>{
    await fileTransaction(this.indexPath,async()=>{
      const index=await this.index(),record=index.records.find(r=>r.ref.resourceId===resourceId&&r.ref.version===version),current=record?.physicalization
      if(!record||current?.status!=='pending'||current.usage!==request.usage||current.strategy!==request.strategy||!isDeepStrictEqual(physicalizationBudgets(current),physicalizationBudgets(request)))return
      current.progress=structuredClone(progress);await atomicJSON(this.indexPath,index)
    })
  }
  /** 同版本已登记派生的独立可用性检查；不给其它资源或临时目录做猜测恢复。 */
  async verifyCollisionArtifacts(resourceId:string,version:number,uris?:readonly string[],options:{full?:boolean}={}):Promise<{valid:boolean;missing:string[];changed:string[];unverified:string[]}>{
    const record=await this.get(resourceId,version),missing:string[]=[],changed:string[]=[],unverified:string[]=[]
    const selected=uris??record.physicalization?.artifactUris??record.ref.representations.filter(rep=>rep.role==='collision').map(rep=>rep.uri)
    for(const uri of [...new Set(selected)]){
      const path=localPath(uri),registered=record.ref.representations.some(rep=>rep.role==='collision'&&localPath(rep.uri)===path)
      const expected=record.collisionArtifacts?.find(file=>localPath(file.path)===path)
      if(!registered||!expected?.sha256){unverified.push(uri);continue}
      const proof=`${resourceId}@${version}:${expected.size}:${expected.sha256}`
      const identityOf=(s:Awaited<ReturnType<typeof stat>>)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':')
      try{
        const before=await stat(path),identity=identityOf(before),cached=this.verifiedCollisionFiles.get(path)
        if(!options.full&&cached?.expected===proof&&cached.identity===identity){this.collisionCacheHits++;continue}
        this.verifiedCollisionFiles.delete(path);this.collisionHashReads++
        const actual=await fileStamp(path,true),after=await stat(path)
        if(identityOf(after)!==identity||actual.size!==expected.size||actual.sha256!==expected.sha256)changed.push(uri)
        else this.verifiedCollisionFiles.set(path,{expected:proof,identity})
      }catch{this.verifiedCollisionFiles.delete(path);missing.push(uri)}
    }
    return {valid:!missing.length&&!changed.length&&!unverified.length,missing,changed,unverified}
  }
  /** 旧版本首次核对派生字节后保存当前事实；调用方先核同版本来源、清单/用途及文件归属。 */
  async adoptCollisionArtifacts(resourceId:string,version:number,uris:readonly string[]):Promise<void>{
    await fileTransaction(this.indexPath,async()=>{
      const index=await this.index(),record=index.records.find(r=>r.ref.resourceId===resourceId&&r.ref.version===version)
      if(!record)throw new Error('RESOURCE_NOT_FOUND')
      const additions:FileStamp[]=[]
      for(const uri of [...new Set(uris)]){
        if(!record.ref.representations.some(rep=>rep.role==='collision'&&localPath(rep.uri)===localPath(uri)))throw Error('COLLISION_RESOURCE_MISMATCH: 派生未登记在所选资源版本')
        const actual=await fileStamp(localPath(uri),true),expected=record.collisionArtifacts?.find(file=>localPath(file.path)===actual.path)
        if(expected){if(expected.sha256!==actual.sha256||expected.size!==actual.size)throw Error('COLLISION_ARTIFACT_CHANGED: 已发布派生字节改变')}
        else additions.push(actual)
      }
      if(additions.length){record.collisionArtifacts=[...record.collisionArtifacts??[],...additions];await atomicJSON(this.indexPath,index)}
    })
  }
  async get(resourceId: string, version?: number): Promise<ResourceRecord> {
    const candidates = (await this.index()).records.filter(record => record.ref.resourceId === resourceId && (version === undefined || record.ref.version === version))
    const record = candidates.sort((a, b) => b.ref.version - a.ref.version)[0]
    if (!record) throw new Error(`RESOURCE_NOT_FOUND: ${resourceId}@${version ?? "latest"}`)
    return sourceCompleteRecord(record)
  }
  async list(options: { query?: string; folder?: string; includeDeleted?: boolean; allVersions?: boolean } = {}): Promise<Array<ResourceRecord & ResourceStorageInfo>> {
    // Commands arrive from a JSON boundary, so keep the runtime guard even
    // though the public schema says query is a string. A malformed agent call
    // must produce a stable input error instead of the opaque
    // `options.query.toLowerCase is not a function` TypeError.
    const query = options.query === undefined || options.query === null ? undefined : typeof options.query === 'string' ? options.query.toLowerCase() : (() => { throw new Error('ASSET_QUERY_MUST_BE_STRING') })()
    const records = (await this.index()).records.filter(record => (!query || `${record.name} ${record.tags.join(" ")}`.toLowerCase().includes(query)) && (options.folder === undefined || record.folder === options.folder))
    const selected = options.allVersions ? records : records.filter(record => !records.some(other => other.ref.resourceId === record.ref.resourceId && other.ref.version > record.ref.version))
    return selected.filter(record => options.includeDeleted || !record.deletedAt).map(record => this.storageInfo(record))
  }
  /** 列表投影补充占用与存储事实；旧记录没有持久化 storage 字段时按引用原位置推导。 */
  private storageInfo(record: ResourceRecord): ResourceRecord & ResourceStorageInfo {
    let entryPath: string | undefined
    try { entryPath = record.storedEntryPath ?? localPath(record.ref.original.uri) } catch { entryPath = record.storedEntryPath }
    const origin: ResourceOrigin =
      entryPath && this.options.productRoot && pathInside(this.options.productRoot, entryPath) ? "builtin"
      : record.networkProvenance?.sourceUrl ? "download"
      : entryPath && pathInside(this.providerJobsRoot, entryPath) ? "generated"
      : "import"
    // 许可如实透出：记录里没有许可事实时**显示 unknown**（不默认成任何具体许可）。
    return { ...record, sizeBytes: record.parsed.dependencies.reduce((sum, stamp) => sum + stamp.size, 0), storage: record.storage ?? "reference", storedEntryPath: entryPath, origin, license: normalizeResourceLicense(record.license) }
  }
  async listMissing(): Promise<MissingResourceRecord[]> {
    try { return await readJSON<MissingResourceRecord[]>(this.missingPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  async rescanMissing(): Promise<MissingResourceRescan> {
    const records = await this.listMissing()
    const checkedAt = new Date().toISOString()
    if (!records.length) return { checkedAt, status: "EMPTY", records: [] }
    const scanned = await Promise.all(records.map(async record => {
      if (!record.legacyPath) return { ...record, sourcePath: { state: "missing" as const } }
      try {
        const info = await stat(record.legacyPath)
        if (!info.isFile()) return { ...record, sourcePath: { state: "not-file" as const } }
        return { ...record, sourcePath: { state: "present" as const, size: info.size, mtimeMs: info.mtimeMs } }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return { ...record, sourcePath: { state: "missing" as const } }
        throw error
      }
    }))
    return { checkedAt, status: scanned.every(record => record.sourcePath.state === "present") ? "READY_TO_RERUN" : "BLOCKED", records: scanned }
  }
  async replaceMissing(records: MissingResourceRecord[]): Promise<void> {
    // 仅写当前账号的迁移报告，不触碰旧索引或任何原件。
    await atomicJSON(this.missingPath, records)
  }
  async update(resourceId: string, changes: { name?: string; tags?: string[]; folder?: string; deleted?: boolean } & ResourceAuthorityIdentity): Promise<ResourceRecord> {
    const { operationID, idempotencyKey, expectedRegistryRevision, ...metadata } = changes
    const actualOperationID = operationID ?? randomUUID()
    const result = await this.authorityOperation({ operationID: actualOperationID, idempotencyKey, expectedRegistryRevision }, { kind: "update", resourceId, metadata }, async index => {
      const records = index.records.filter(record => record.ref.resourceId === resourceId)
      if (!records.length) throw new Error(`RESOURCE_NOT_FOUND: ${resourceId}`)
      for (const record of records) {
      if (metadata.name !== undefined) record.name = metadata.name
      if (metadata.tags !== undefined) record.tags = metadata.tags
      if (metadata.folder !== undefined) record.folder = metadata.folder
      if (metadata.deleted === true) {
        record.deletedAt = new Date().toISOString()
        const inventory = await inventoryFiles(record.parsed.dependencies)
        record.inventory = inventory
        record.tombstone = { tombstoneID: `trash_${actualOperationID}`, resourceId, operationID: actualOperationID, sourcePath: localPath(record.ref.original.uri), inventory, createdAt: new Date().toISOString(), state: "trashed" }
        await atomicJSON(join(this.catalogRoot, "tombstones", `${safeId(record.tombstone.tombstoneID)}.json`), record.tombstone)
      }
      if (metadata.deleted === false) { delete record.deletedAt; if (record.tombstone) { record.tombstone = { ...record.tombstone, state: "restored" }; await atomicJSON(join(this.catalogRoot, "tombstones", `${safeId(record.tombstone.tombstoneID)}.json`), record.tombstone) } }
      }
      return { result: structuredClone(records.sort((a, b) => b.ref.version - a.ref.version)[0]!) }
    })
    return result
  }
  async trash(input: { resourceId: string; operationID?: string; idempotencyKey?: string; expectedRegistryRevision?: string }): Promise<ResourceRecord> {
    return this.update(input.resourceId, { ...input, deleted: true })
  }
  async restore(input: { resourceId: string; operationID?: string; idempotencyKey?: string; expectedRegistryRevision?: string }): Promise<ResourceRecord> {
    return this.update(input.resourceId, { ...input, deleted: false })
  }
  /** unlink 默认只解除 authority 关联并保留可恢复软删除状态；绝不物理删除用户原件。 */
  async unlink(input: { resourceId: string; operationID?: string; idempotencyKey?: string; expectedRegistryRevision?: string }): Promise<ResourceRecord> {
    const result = await this.trash(input)
    return result
  }
  async move(input: { resourceId: string; targetPath?: string; path?: string; operationID?: string; idempotencyKey?: string; expectedRegistryRevision?: string }): Promise<ResourceRecord> {
    const target = input.targetPath ?? input.path
    if (!target) throw new Error("RESOURCE_MOVE_TARGET_REQUIRED")
    const result = await this.authorityOperation(input, { kind: "move", resourceId: input.resourceId, target }, async (index, journalEntry) => {
      const records = index.records.filter(record => record.ref.resourceId === input.resourceId)
      if (!records.length) throw new Error(`RESOURCE_NOT_FOUND: ${input.resourceId}`)
      const record = records.sort((a, b) => b.ref.version - a.ref.version)[0]!
      const transition = journalEntry.fileTransition
      if (!transition) throw new Error("RESOURCE_MOVE_TRANSITION_MISSING")
      const files = transitionFiles(transition)
      const original = structuredClone(record)
      try {
        const { syncedDirectories } = await moveFilesDurable(files, {
          afterFileMoved: async (_file, index, mode) => {
            files[index]!.mode = mode
            await this.persistMoveProgress(journalEntry.operationID, transition)
            this.fault("after_file_moved")
          },
        })
        transition.syncedDirectories = syncedDirectories
        this.fault("after_transition_journal")
      } catch (error) {
        // Leave the prepared transition in place. Recovery probes every
        // inventory pair and rolls back only verified moved files.
        throw new Error(`RESOURCE_MOVE_FAILED: ${String(error)}`)
      }
      const source = localPath(original.ref.original.uri)
      const destination = localPath(target)
      const locationMap = new Map(files.map(file => [file.sourcePath, file.targetPath]))
      const replacePath = (path: string) => locationMap.get(localPath(path)) ?? localPath(path)
      const replaceUri = (uri: string) => pathToFileURL(replacePath(uri)).href
      record.alternateLocations = [...(record.alternateLocations ?? []), { ref: structuredClone(original.ref), parsed: structuredClone(original.parsed) }]
      record.ref.original.uri = replaceUri(original.ref.original.uri)
      record.ref.representations = record.ref.representations.map(rep => ({ ...rep, uri: replaceUri(rep.uri) }))
      record.parsed.dependencies = record.parsed.dependencies.map(item => ({ ...item, path: replacePath(item.path) }))
      const inventory = files.find(file => file.sourcePath === source)?.inventory ?? transition.inventory
      const tombstone: ResourceAuthorityTombstone = { tombstoneID: `move_${journalEntry.operationID}`, resourceId: input.resourceId, operationID: journalEntry.operationID, sourcePath: source, targetPath: destination, inventory, files: structuredClone(files), createdAt: new Date().toISOString(), state: "moved" }
      record.inventory = files.flatMap(file => file.inventory)
      record.tombstone = tombstone
      await atomicJSON(join(this.catalogRoot, "tombstones", `${safeId(tombstone.tombstoneID)}.json`), tombstone)
      return { result: structuredClone(record) }
    })
    return result
  }
  /** 回滚 move 产生的文件转移与 authority URI；原件字节必须匹配 inventory。 */
  async rollbackMove(input: { resourceId: string; tombstoneID?: string; operationID?: string; idempotencyKey?: string; expectedRegistryRevision?: string }): Promise<ResourceRecord> {
    const current = await this.get(input.resourceId)
    const tombstone = current.tombstone
    if (!tombstone || (input.tombstoneID && tombstone.tombstoneID !== input.tombstoneID)) throw new Error(`RESOURCE_MOVE_TOMBSTONE_NOT_FOUND: ${input.resourceId}`)
    const result = await this.authorityOperation(input, { kind: "rollbackMove", resourceId: input.resourceId, tombstoneID: tombstone.tombstoneID }, async (index, journalEntry) => {
      const row = index.records.filter(record => record.ref.resourceId === input.resourceId).sort((a, b) => b.ref.version - a.ref.version)[0]
      if (!row) throw new Error(`RESOURCE_NOT_FOUND: ${input.resourceId}`)
      const transition = journalEntry.fileTransition
      if (!transition) throw new Error("RESOURCE_MOVE_TRANSITION_MISSING")
      const files = transitionFiles(transition)
      try {
        const { syncedDirectories } = await moveFilesDurable(files, {
          afterFileMoved: async (_file, index, mode) => {
            files[index]!.mode = mode
            await this.persistMoveProgress(journalEntry.operationID, transition)
            this.fault("after_file_moved")
          },
        })
        transition.syncedDirectories = syncedDirectories
        this.fault("after_transition_journal")
      } catch (error) {
        throw new Error(`RESOURCE_MOVE_ROLLBACK_FAILED: ${String(error)}`)
      }
      const locationMap = new Map(files.map(file => [file.sourcePath, file.targetPath]))
      const replacePath = (path: string) => locationMap.get(localPath(path)) ?? localPath(path)
      const replaceUri = (uri: string) => pathToFileURL(replacePath(uri)).href
      row.ref.original.uri = replaceUri(row.ref.original.uri)
      row.ref.representations = row.ref.representations.map(rep => ({ ...rep, uri: replaceUri(rep.uri) }))
      row.parsed.dependencies = row.parsed.dependencies.map(item => ({ ...item, path: replacePath(item.path) }))
      row.tombstone = { ...tombstone, state: "restored" }
      await atomicJSON(join(this.catalogRoot, "tombstones", `${safeId(tombstone.tombstoneID)}.json`), row.tombstone)
      return { result: structuredClone(row) }
    })
    return result
  }
  async verify(resourceId: string, version?: number): Promise<{ valid: boolean; missing: string[]; changed: string[] }> {
    return verifyLocation(await this.get(resourceId, version))
  }
  async verifyReference(ref: ResourceRef): Promise<{ valid: boolean; missing: string[]; changed: string[] }> {
    const record = await this.recordFor(ref)
    if (!record) throw new Error(`RESOURCE_NOT_FOUND: ${ref.resourceId}@${ref.version}`)
    return verifyLocation(record)
  }
  /** 只选该版本已核验的位置，保存/读取旧Scene时仍使用其实际位置的文件戳。 */
  async recordFor(ref:ResourceRef):Promise<ResourceRecord|undefined>{
    const record=(await this.index()).records.find(row=>row.ref.resourceId===ref.resourceId&&row.ref.version===ref.version)
    const location = record && locations(record).find(value => isDeepStrictEqual(sourceCompleteIdentity(value.ref,value.parsed), sourceCompleteIdentity(ref,value.parsed)))
    return record && location ? sourceCompleteRecord({ ...record, ref: location.ref, parsed: location.parsed }) : undefined
  }
  /** 返回已核对的同一份字节，避免先校验源文件再另读被替换的内容。调用者仍负责Scene引用授权。 */
  async readVerifiedResource(snapshot:SceneSnapshot,uri:string):Promise<Buffer>{
    const path=localPath(uri),before=await stat(path),bytes=await readFile(path),after=await stat(path)
    const index=await this.index()
    for(const ref of snapshot.entities.flatMap(entity=>entity.resources)){
      const record=index.records.find(row=>row.ref.resourceId===ref.resourceId&&row.ref.version===ref.version)
      const location=record&&locations(record).find(value=>isDeepStrictEqual(sourceCompleteRef(value.ref,value.parsed),sourceCompleteRef(ref,value.parsed)))
      const expected=location?.parsed.dependencies.find(item=>localPath(item.path)===path)
      if(!expected)continue
      const matches=bytes.length===expected.size&&(expected.sha256?createHash('sha256').update(bytes).digest('hex')===expected.sha256:before.size===expected.size&&after.size===expected.size&&before.mtimeMs===expected.mtimeMs&&after.mtimeMs===expected.mtimeMs)
      if(!matches)throw new Error(`RESOURCE_VERSION_MISMATCH: ${ref.resourceId}@${ref.version} ${path}`)
    }
    return bytes
  }
  /** 大资源先把同一次读取的字节写入临时件并核验，再流式发送；不整份分配 Buffer，也不重新读取可能已变化的源文件。 */
  async streamVerifiedResource(snapshot:SceneSnapshot,uri:string,signal?:AbortSignal):Promise<{body:ReadableStream<Uint8Array>;size:number}>{
    signal?.throwIfAborted()
    const path=localPath(uri),before=await stat(path),index=await this.index()
    const expected=snapshot.entities.flatMap(entity=>entity.resources).flatMap(ref=>{
      const record=index.records.find(row=>row.ref.resourceId===ref.resourceId&&row.ref.version===ref.version)
      const location=record&&locations(record).find(value=>isDeepStrictEqual(sourceCompleteRef(value.ref,value.parsed),sourceCompleteRef(ref,value.parsed)))
      const stamp=location?.parsed.dependencies.find(item=>localPath(item.path)===path)
      return stamp?[{stamp,ref}]:[]
    })
    const directory=await mkdtemp(join(tmpdir(),"lyapunov-resource-")),target=join(directory,"bytes")
    try{
      const hash=createHash("sha256");let size=0
      await pipeline(createReadStream(path),new StreamTransform({transform(chunk,_encoding,done){size+=chunk.length;hash.update(chunk);done(null,chunk)}}),createWriteStream(target,{mode:0o600}),{signal})
      const after=await stat(path),digest=hash.digest("hex")
      for(const {stamp,ref} of expected){
        const matches=size===stamp.size&&(stamp.sha256?digest===stamp.sha256:before.size===stamp.size&&after.size===stamp.size&&before.mtimeMs===stamp.mtimeMs&&after.mtimeMs===stamp.mtimeMs)
        if(!matches)throw new Error(`RESOURCE_VERSION_MISMATCH: ${ref.resourceId}@${ref.version} ${path}`)
      }
      signal?.throwIfAborted()
      const stream=createReadStream(target,{signal})
      stream.once("close",()=>{void rm(directory,{recursive:true,force:true})})
      return {body:Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,size}
    }catch(error){await rm(directory,{recursive:true,force:true});throw error}
  }
}
