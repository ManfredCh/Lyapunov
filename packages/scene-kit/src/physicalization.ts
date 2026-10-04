import { mkdir, readdir, rm, readFile, access } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {createHash} from 'node:crypto'
import type { Entity, Representation } from "../../lyapunov-contracts/src/types.ts"
import { localPath } from "./formats.ts"
import type { ResourceLibrary, ResourceRecord,ResourcePhysicalization } from "./resources.ts"
import {validatePhysicalizationRequest} from './resources.ts'
import {activeCollisionUris,ensureCollisionArtifacts} from './collision-references.ts'
import {physicalizationBudgets,physicalizationBudgetIdentity,validatePhysicalizationBudgets,type PhysicalizationBudgetOptions} from './physicalization-parameters.ts'

export type PhysicalizeStrategy = "auto" | "convex_hull" | "voxel_boxes" | "coacd" | "triangle_mesh" | "sdf"

/**
 * 派生用途：决定"这份碰撞是给谁用的"，不只是形状近似度（asset-bake 早已实现，这里把它接通）。
 * - dynamic（缺省，旧行为逐字不变）：物体/道具。几何派生走既有 auto（凹腔判定后 CoACD/体素盒组），
 *   需要体积的路径填实内部，装配为动态体（freejoint + 质量）。
 * - static：不动的构件。缺省/auto 与 environment 同样保留未填充表面，装配为静态体。
 * - environment：世界环境（地面/墙/门洞/建筑构件）。不填内部、不用凸包把房间/通道封死，
 *   装配为静态体。**缺省不钉死表示**：逐节点按实测选"在把 mesh geom 当凸包消费的引擎里仍是同一形状"
 *   的那种表示（凸包即自身→精确表面、其余源面→不填内部的体素表面盒组），改派与
 *   原因记在 routed。**显式策略**按请求导出，目标引擎消费时会失去空腔的节点记 cavityLostNodes 且
 *   interiorPreserved=false（不静默替换请求的表示）；environment 下 convex_hull/sdf 直接拒绝，
 *   并作为 failed 写进记录。回执同时写 passageVerified=false + passageNote：interiorPreserved 是
 *   "所选表示不填补内部"的推导值，**不是**通行实测（本工具不求解净通道宽/连通性）。
 */
export type PhysicalizeUsage = "dynamic" | "static" | "environment"

/**
 * mesh 资源导入后的自动碰撞派生：串行队列 fire-and-forget，scene_import 的同步路径不等待、
 * 也不因物理化失败而失败。asset-bake 经运行时动态 import 接入——它是可选工具包，模块缺失
 * 或 python 解释器未配置都只落 status='failed'，不影响 scene-kit 其余能力。
 * 同一 dataRoot 的同一 resourceId@version **同一组派生参数**同时在队列里只跑一次（用途/策略/体素
 * 边长不同的请求各自入队，不被静默合并掉）；已按同一组参数 ok 的版本不重复跑，参数不同则重派生
 * 并把上一次终止状态记进 previous（failed/崩溃残留的 pending 通过显式同版本请求恢复，返工/定制仍走手工 asset_bake）。
 */
export interface PhysicalizationOptions extends PhysicalizationBudgetOptions {strategy?:PhysicalizeStrategy;usage?:PhysicalizeUsage;signal?:AbortSignal}
export function resourcePhysicalizationOptions(record:ResourceRecord,overrides:PhysicalizationOptions={}):PhysicalizationOptions{
  const request=record.physicalizationRequest&&typeof record.physicalizationRequest==="object"?record.physicalizationRequest:undefined
  return {
    ...physicalizationBudgets(request??record.physicalization),...physicalizationBudgets(overrides),
    usage:overrides.usage??request?.usage??(!request?record.physicalization?.usage as PhysicalizeUsage|undefined:undefined)??(record.parsed.kind==="splat"?"environment":"dynamic"),
    strategy:overrides.strategy??request?.strategy??(!request?record.physicalization?.strategy as PhysicalizeStrategy|undefined:undefined)??"auto",
    voxelSizeM:overrides.voxelSizeM??request?.voxelSizeM??(!request?record.physicalization?.voxelSizeM:undefined),
  }
}
/** 只有同请求、同策略口径的成功默认才能直接挂载；状态 ok 本身不能代表新请求已完成。 */
export function physicalizationMatchesRequest(record:ResourceRecord,options:PhysicalizationOptions):boolean{
  const current=record.physicalization
  return current?.status==='ok'&&current.policy===PHYSICALIZATION_POLICY&&(current.usage??'dynamic')===options.usage&&current.strategy===options.strategy&&physicalizationBudgetIdentity(current)===physicalizationBudgetIdentity(options)
}
const inFlight = new Map<string,Promise<ResourceRecord|undefined>>()
let queue: Promise<void> = Promise.resolve()

/** 派生**策略口径**的版本号：同一组请求参数在不同口径下产出的碰撞不是同一个东西（例如 environment
 *  缺省从"逐面网格直出"改成"逐节点判凸包即自身后再选表示"），旧记录不能按参数相同就复用。
 *  记录里存 policy，去重时一并比对——口径变了就重派生一次（supersedes 记账），不让旧产物继续顶着
 *  新的回执口径。只在口径真的变时才改这个值。 */
export const PHYSICALIZATION_POLICY = "cavity-safe-5"

const flightKey=(library:ResourceLibrary,ref:{resourceId:string;version:number},options:PhysicalizationOptions)=>`${library.directory}:${ref.resourceId}@${ref.version}#${options.usage??'dynamic'}#${options.strategy??'auto'}#${physicalizationBudgetIdentity(options)}`
/** 后挂载只接已经存在的同参数作业，读 failed 不自动重跑大件。 */
export function pendingPhysicalization(library:ResourceLibrary,ref:{resourceId:string;version:number},options:PhysicalizationOptions):Promise<ResourceRecord|undefined>|undefined{return inFlight.get(flightKey(library,ref,options))}

export async function schedulePhysicalization(library: ResourceLibrary, ref: { resourceId: string; version: number }, options?: PhysicalizationOptions): Promise<ResourceRecord|undefined> {
  // 调用时冻结用途/参数，不在排队执行时再读会被后续显式改派更新的request。
  const record=options?.usage!==undefined?undefined:await library.get(ref.resourceId,ref.version)
  const resolved=options?{...options,usage:options.usage??(record!.parsed.kind==="splat"?"environment":"dynamic"),strategy:options.strategy??"auto"}:resourcePhysicalizationOptions(record!)
  validatePhysicalizationBudgets(resolved)
  validatePhysicalizationRequest({usage:resolved.usage,strategy:resolved.strategy,...physicalizationBudgets(resolved)})
  const key = flightKey(library,ref,resolved)
  const previous=inFlight.get(key);if(previous)return previous
  const result = queue.then(() => runPhysicalization(library, ref.resourceId, ref.version, resolved))
  queue = result.then(()=>undefined)
    .catch(error => console.debug(`physicalization 队列异常 ${ref.resourceId}@${ref.version}: ${String(error)}`))
    .finally(() => { inFlight.delete(key) })
  inFlight.set(key,result);return result
}

/**
 * 请求侧的策略口径（唯一一处）：**缺省与显式 auto 同义 = 没钉死碰撞表示**，交给 asset-bake 按用途与
 * 实测逐节点选（static/environment 非等价源面→未填充体素表面盒组）；显式策略原样返回、
 * 按请求导出。记录里的 strategy、去重判据与产物变体目录都用这个值——"请求什么"和"实际用了什么"
 * 因此不会混为一谈（实际用的逐节点表示记在 selection/routed 里）。
 */
export function resolvePhysicalization(_usage: PhysicalizeUsage, strategy?: PhysicalizeStrategy): PhysicalizeStrategy {
  return strategy ?? "auto"
}

/**
 * 产物**变体目录名**：只由"决定产物字节"的请求参数与策略口径拼成（请求策略 + 体素边长 + 口径版本）。
 * 同一 resource@version 换策略/换体素边长/换口径再派生时各自落在自己的目录里——旧场景/旧引用指向的
 * 文件字节不动，新声明读新产物；同参数 + 同口径命中即不重派生（去重判据与此逐字一致）。
 * 不用哈希做审计：这几个参数就是产物身份。
 */
export function physicalizationVariant(strategy: string, voxelSizeM?: number, policy = PHYSICALIZATION_POLICY,budgets:PhysicalizationBudgetOptions={}): string {
  const {voxelSizeM:_voxel,...additional}=physicalizationBudgets(budgets)
  const suffix=Object.keys(additional).length?'-limits-'+createHash('sha256').update(physicalizationBudgetIdentity(additional)).digest('hex'):''
  return `${strategy}${voxelSizeM !== undefined ? `-voxel${voxelSizeM}` : ""}@${policy}${suffix}`
}

/** physicalize:false 的可见标记；已有任何物理化状态（含崩溃残留）时不覆盖。失败只记日志。 */
export async function notePhysicalizationSkipped(library: ResourceLibrary, ref: { resourceId: string; version: number }): Promise<void> {
  try {
    const record = await library.get(ref.resourceId, ref.version)
    if (record.physicalization) return
    await library.attachPhysicalization(ref.resourceId, ref.version, { status: "skipped" })
  } catch (error) {
    console.debug(`physicalization 跳过标记失败 ${ref.resourceId}@${ref.version}: ${String(error)}`)
  }
}

interface PhysicalizedResult {
  strategy: string
  objects: PhysicalizedObject[]
  /** 本次派生清掉的、没有被任何表示引用的临时件文件名（生命周期收尾的真实记录）。 */
  prunedParts?: string[]
  geometryTransport?:ResourcePhysicalization['geometryTransport']
}

interface PhysicalizedObject {
  node: string
  sourceKind?: "point_cloud"
  selected: string
  staticTriangleSurface?:import('../../asset-bake/src/physicalize.ts').StaticTriangleSurface
  /** 源网格在"引擎把 mesh geom 当凸包"的消费下是否还是同一个形状（asset-bake 实测得出）。 */
  hullSafe?: boolean
  /** 逐节点改派原因（非等价源面→未填充体素表面）：请求策略与实产物不同时留账。 */
  routeReason?: string
  /** 显式策略落在引擎消费后会失去空腔/开口的表示上时，asset-bake 给出的消费限制说明。 */
  consumerNotice?: string
  /** 凸分解的近似误差：分件体积和 / 源网格体积。 */
  volumeRatio?: number
  /** 体素表面盒组的实际分辨率与晶格（近似误差来源）。 */
  decomposition?: { voxelSizeM: number; gridDims: [number, number, number]; tiles: number; fillInterior: boolean; sourceTriangles?: number }
  parts?: string[]
  boxes?: Array<{ center: [number, number, number]; halfExtents: [number, number, number] }>
  primitive?: { shape: "box" | "sphere" | "cylinder"; center: [number, number, number]; halfExtents: [number, number, number] }
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  material: string
  materialProperties: { densityKgM3: number; friction: readonly [number, number, number] }
  pointCloud?:Record<string,unknown>
  massKg?: number | null
  convexVolumeM3?: number | null
}

function primitiveVolume(p: NonNullable<PhysicalizedObject["primitive"]>): number {
  if (p.shape === "box") return 8 * p.halfExtents[0] * p.halfExtents[1] * p.halfExtents[2]
  if (p.shape === "sphere") return 4 / 3 * Math.PI * p.halfExtents[0] ** 3
  return Math.PI * p.halfExtents[0] ** 2 * 2 * p.halfExtents[1]
}

/** 物理 worker 契约：凸包/网格 parts 用 file:// URI；体素盒组给 center+halfExtents；质量取实测值，非封闭网格按碰撞体体积×材质密度估计（与 asset-bake 同一 clamp）。 */
function collisionContract(objects: PhysicalizedObject[], massFromVolume: (volumeM3: number, material: string | undefined) => { massKg: number }, usage: PhysicalizeUsage): Entity["components"] {
  const material = objects[0]!.material
  const friction = [...objects[0]!.materialProperties.friction]
  // dynamic = 旧行为逐字不变（动态体 + 质量）；static/environment 是不动的世界构件：
  // 装配成静态体（不挂 freejoint），也不写质量——表面/构件没有可测量的封闭体积，
  // 拿凸包体积乘密度凑一个数字就是"弱替身读数"。
  const moving = usage === "dynamic"
  const withMass = (collision: Record<string, unknown>, volumeOf: (object: PhysicalizedObject) => number | undefined): Entity["components"] => {
    if (!moving) return { collision, rigidBody: { type: "static" } }
    let massKg = 0
    let massKnown = true
    for (const object of objects) {
      if(object.sourceKind==="point_cloud"){massKnown=false;continue}
      if (typeof object.massKg === "number") { massKg += object.massKg; continue }
      const volume = volumeOf(object)
      if (typeof volume === "number" && volume > 0) massKg += massFromVolume(volume, object.material).massKg
      else massKnown = false
    }
    return { collision, ...(massKnown ? { rigidBody: { type: "dynamic", massKg, massSource:"asset-bake", massScalePolicy:"density" } } : {}) }
  }
  // 近原生形状（asset-bake fitPrimitive）：全部节点命中时直接用原生 geom 契约。
  // 单节点球/圆柱给 shape+center+halfExtents；盒与多节点统一走 box shapes（多节点球/圆柱
  // 退为其 AABB 盒近似——保守方向，不虚构引擎表达不了的组合）。
  if (objects.length > 0 && objects.every(object => object.primitive)) {
    const collision: Record<string, unknown> = objects.length === 1 && objects[0]!.primitive!.shape !== "box"
      ? { shape: objects[0]!.primitive!.shape, halfExtents: objects[0]!.primitive!.halfExtents, center: objects[0]!.primitive!.center, friction, material, source: "asset-bake-primitive" }
      : { shape: "box", shapes: objects.map(object => ({ center: object.primitive!.center, halfExtents: object.primitive!.halfExtents })), friction, material, source: "asset-bake-primitive" }
    return withMass(collision, object => primitiveVolume(object.primitive!))
  }
  // SDF 深腔容器（显式 strategy='sdf'）：geom 按源网格符号距离场碰撞，不凸化、不封腔。
  if (objects.some(object => object.selected === "sdf") && !objects.every(object => object.selected === "sdf")) throw new Error("PHYSICS_MIXED_SDF_UNSUPPORTED: 该资产同时含SDF和其它碰撞件；当前组合契约不能保真表达，不把SDF当凸包")
  if (objects.every(object => object.selected === "sdf")) {
    const parts = objects.flatMap(object => object.parts ?? [])
    if (!parts.length) throw new Error("EMPTY_GEOMETRY: 没有可物理化的网格节点")
    return withMass({ shape: "sdf", parts: parts.map(part => pathToFileURL(part).href), friction, material, source: "asset-bake-sdf" }, object => object.convexVolumeM3 ?? undefined)
  }
  const parts = objects.flatMap(object => object.boxes ? [] : object.parts ?? [])
  const shapes = objects.flatMap(object => object.boxes ?? (object.primitive?.shape==="box"?[{center:object.primitive.center,halfExtents:object.primitive.halfExtents}]:[]))
  if (!parts.length && !shapes.length) throw new Error("EMPTY_GEOMETRY: 没有可物理化的网格节点")
  // source 只作来源标注（引擎按 shape 分支处理）：环境逐表面产物与物体的凸包/体素产物分开标注，
  // 回执里能一眼看出这份 collision 到底是哪条派生出来的。
  const collision: Record<string, unknown> = parts.length
    ? { shape: "mesh", parts: parts.map(part => pathToFileURL(part).href), friction, material, source: usage === "environment"||objects.some(object=>object.staticTriangleSurface) ? "asset-bake-surface" : "asset-bake-hull", ...(objects.some(object=>object.staticTriangleSurface)?{meshTopology:'static-triangles',surfaceRadiusM:1e-9}:{}), ...(shapes.length ? { shapes } : {}) }
    : { shape: "box", shapes, friction, material, source: usage === "environment" ? "asset-bake-environment" : "asset-bake-voxel" }
  return withMass(collision, object => object.boxes
    ? object.boxes.reduce((sum, box) => sum + 8 * box.halfExtents[0] * box.halfExtents[1] * box.halfExtents[2], 0)
    : object.convexVolumeM3 ?? undefined)
}

async function runPhysicalization(library: ResourceLibrary, resourceId: string, version: number, options: PhysicalizationOptions): Promise<ResourceRecord|undefined> {
  const record = await library.get(resourceId, version)
  if (record.deletedAt || !["mesh", "splat"].includes(record.parsed.kind)) return
  // 点云没有可信实体体积；显式请求而未给用途时按静态环境采样碰撞处理。mesh 缺省仍为 dynamic。
  const usage = options.usage ?? (record.parsed.kind === "splat" ? "environment" : "dynamic")
  const strategy = resolvePhysicalization(usage, options.strategy)
  if(options.signal?.aborted){
    if(record.physicalization?.status!=='ok')await library.attachPhysicalization(resourceId,version,{status:'failed',usage,strategy,error:'PHYSICS_DERIVATION_CANCELLED: 派生在队列中已取消'})
    return library.get(resourceId,version)
  }
  // 已按同一组参数**且同一策略口径**派生成功过就不重复跑；用途/策略/体素边长/口径变了则重派生
  // （上一次终止状态记进 previous）——旧调用（只给 strategy）解析出来的这组参数与旧记录逐字相同，
  // 因此旧行为不变；口径升级时旧记录会被重派生一次，不留着旧的"保空腔"结论继续被引用。
  const current = record.physicalization
  const supportedFrame=record.ref.source.handedness==="right"&&["Y","Z"].includes(record.ref.source.upAxis)
  const sameVariant=supportedFrame&&current?.status==='ok'&&current.policy===PHYSICALIZATION_POLICY&&(current.usage??'dynamic')===usage&&current.strategy===strategy&&physicalizationBudgetIdentity(current)===physicalizationBudgetIdentity(options)
  let repair=false
  if(sameVariant){
    try{const uris=activeCollisionUris(library,record);if(!uris.length)throw Error('COLLISION_MANIFEST_REQUIRED');await ensureCollisionArtifacts(library,record,uris);if(record.componentDefaults?.collision)return library.get(resourceId,version)}
    catch{repair=true}
  }
  const supersedes = current?.status === "ok" || String(record.componentDefaults?.collision?.source??'').startsWith('asset-bake-')
  await library.attachPhysicalization(resourceId, version, { status: "pending", strategy, usage, ...physicalizationBudgets(options) }).catch(error => console.debug(`physicalization 进行中标记失败 ${resourceId}@${version}: ${String(error)}`))
  let progressChain=Promise.resolve(),latestProgress:ResourcePhysicalization['progress'],lastProgressAt=0
  const onProgress=(value:{mode:string;node?:string;facts:Record<string,unknown>})=>{
    if(JSON.stringify(value).length>16384)return
    latestProgress={...value,at:new Date().toISOString()}
    if(Date.now()-lastProgressAt<500)return
    lastProgressAt=Date.now();const progress=latestProgress
    progressChain=progressChain.then(()=>library.notePhysicalizationProgress(resourceId,version,{usage,strategy,...physicalizationBudgets(options)},progress)).catch(error=>console.debug('派生进度写入失败: '+String(error)))
  }
  const flushProgress=async()=>{await progressChain;if(latestProgress)await library.notePhysicalizationProgress(resourceId,version,{usage,strategy,...physicalizationBudgets(options)},latestProgress)}
  const failure = async (error: unknown) => {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500)
    const details=error&&typeof error==='object'?(error as {details?:unknown;cause?:unknown}).details??(error as {cause?:unknown}).cause:undefined
    const errorDetails=details&&typeof details==='object'&&!Array.isArray(details)&&JSON.stringify(details).length<=16384?details as Record<string,unknown>:undefined
    await flushProgress()
    await library.attachPhysicalization(resourceId, version, { status: "failed", strategy, usage, error: message,...physicalizationBudgets(options),...errorDetails?{errorDetails}:{} }).catch(attachError => console.debug(`physicalization 失败标记失败 ${resourceId}@${version}: ${String(attachError)}`))
  }
  // 失败收尾只碰"本次尝试新建的字节"：进目录前先记账已有文件，失败后删掉的都是这次attempt多出来的
  // （整目录都是本次建的则整目录回收）。同一变体目录里上一次成功的产物不会被递归删除；目录不为空就留着，
  // 交给下一次同变体成功时的 prune 收尾——回执记 failed，没有表示引用这些文件，所以不能拿"没被引用"当删除依据。
  let preexisting: Set<string> | undefined
  let outputDirectory: string | undefined
  const discardAttemptOutput = async () => {
    if (!outputDirectory) return
    try {
      if (preexisting === undefined) { await rm(outputDirectory, { recursive: true, force: true }); return }
      for (const name of await readdir(outputDirectory)) if (!preexisting.has(name)) await rm(join(outputDirectory, name), { recursive: true, force: true })
    } catch (error) { console.debug(`physicalization 失败清理 ${resourceId}@${version}: ${String(error)}`) }
  }
  try {
    const [{ physicalize }, { massFromVolume }] = await Promise.all([
      import("../../asset-bake/src/physicalize.ts"),
      import("../../asset-bake/src/materials.ts"),
    ])
    // 派生根跟随 cache 域：省略 layout 时仍是 <dataRoot>/assets/derived，逐字一致。
    // 落位口径：collision/<用途>/<变体>——用途分目录，**同一用途下的每个参数变体再各占一个目录**
    // （请求策略 + 体素边长 + 口径版本）。同一版本换策略/换体素边长重派生时，旧场景/旧引用指向的
    // 旧文件字节保持不变，新声明读新产物；同参数 + 同口径命中则整个跳过（去重判据与目录名同源）。
    const baseDirectory=join(library.derivedRoot, resourceId, `v${version}`, "collision", usage, physicalizationVariant(strategy, options.voxelSizeM,PHYSICALIZATION_POLICY,options))
    const baseManifest=pathToFileURL(join(baseDirectory,'physicalization.json')).href
    if(!repair&&record.ref.representations.some(rep=>rep.role==='collision'&&rep.uri===baseManifest)){
      try{await ensureCollisionArtifacts(library,record,[baseManifest])}catch{repair=true}
    }
    // 冷缓存修复发新变体位置，原URI即便已损坏也不原位换字节；其它旧实例/历史不被暗改。
    outputDirectory=repair?join(baseDirectory,`repair-${(current?.attempts??0)+1}`):baseDirectory
    preexisting = await readdir(outputDirectory).then(names => new Set(names), () => undefined)
    await mkdir(outputDirectory, { recursive: true })
    const source = record.ref.source
    if(record.parsed.kind==="mesh"&&(!["Y","Z"].includes(source.upAxis)||source.handedness!=="right"))throw new Error("PHYSICS_SOURCE_COORDINATES_UNSUPPORTED: 当前派生支持已声明右手Y/Z-up；不猜轴或把左手原件按右手烘焙")
    const sourcePath = localPath(record.ref.original.uri)
    if (record.parsed.kind === "splat" && !sourcePath.toLowerCase().endsWith(".ply")) throw new Error("POINT_CLOUD_FORMAT_UNSUPPORTED: 当前碰撞派生支持带 XYZ 的 PLY；SPZ/SOG/splat 不通过未实现的解码假报成功，请提供同源 XYZ PLY")
    if (record.parsed.kind === "splat" && (source.handedness !== "right" || !["Y", "Z"].includes(source.upAxis))) throw new Error("POINT_CLOUD_SOURCE_COORDINATES_UNSUPPORTED: 必须是已声明的右手 Y/Z-up 源坐标，不能猜轴/镜像")
    if (record.parsed.kind === "splat" && source.units !== "m" && source.metersPerUnit === undefined) throw new Error("SOURCE_UNIT_SCALE_REQUIRED: 非米点云源必须声明 metersPerUnit")
    // 解释器只在库的配置里读一处：隔离 Host（终端/管理员）不传环境变量，装配方在运行时 patch 里
    // 显式给；省略时 asset-bake 自己回落 LYAPUNOV_ALGORITHM_PYTHON（旧行为不变）。
    const python = library.options.algorithmPython
    const original=await library.verify(resourceId,version)
    if(!original.valid)throw new Error("PHYSICS_DERIVATION_ORIGINAL_UNVERIFIED: 原件/依赖已缺失或变化")
    const publishedManifest=pathToFileURL(join(outputDirectory,"physicalization.json")).href
    let reusable=Boolean(preexisting?.has("physicalization.json")&&record.ref.representations.some(rep=>rep.role==="collision"&&rep.uri===publishedManifest))
    if(reusable){try{await ensureCollisionArtifacts(library,record,[publishedManifest])}catch{reusable=false}}
    // 再次选回已发布变体只读复用；不重烘焙/清理其它已挂载实例仍引用的旧碰撞文件。
    const result = reusable ? JSON.parse(await readFile(join(outputDirectory,"physicalization.json"),"utf8")) as PhysicalizedResult : await physicalize({
      sourcePath,
      outputDirectory,
      sourceUpAxis: source.upAxis === "Y" ? "Y" : "Z",
      metersPerUnit: source.metersPerUnit ?? 1,
      // 请求口径原样下传：缺省/auto 表示"没钉死表示"（asset-bake 按实测逐节点选保空腔的表示），
      // 显式策略按请求导出并由回执如实报告引擎消费后的限制。解析后的 strategy 仍用于记录与去重。
      strategy: options.strategy === "auto" ? undefined : options.strategy,
      usage,
      ...physicalizationBudgets(options),
    }, {...python?{python}:{},...options.signal?{signal:options.signal}:{},...{onProgress}})
    options.signal?.throwIfAborted()
    const transport=(result as PhysicalizedResult).geometryTransport
    if(transport?.schema==='lyapunov.geometry.v2'){
      const frame=transport.sourceFrame
      if(transport.version!==2||transport.verified!==true||frame?.derivedUnits!=='m'||frame.derivedUpAxis!=='Z'||frame.sourceUpAxis!==(source.upAxis==='Y'?'Y':'Z')||frame.metersPerUnit!==(source.metersPerUnit??1))throw Error('PHYSICS_GEOMETRY_TRANSPORT_UNVERIFIED: 几何交接未完整校验或源坐标不匹配')
    }
    if(reusable){
      if(!Array.isArray(result.objects)||!result.objects.length)throw new Error("PHYSICS_VARIANT_UNVERIFIED: 已发布变体清单没有真实节点")
      for(const object of result.objects)for(const part of object.parts??[])await access(part)
    }
    const objects = (result as PhysicalizedResult).objects
    const representations: Representation[] = [
      ...objects.flatMap(object => (object.parts ?? []).map(part => ({ uri: pathToFileURL(part).href, mimeType: part.endsWith(".json") ? "application/json" : "model/obj", role: "collision" }))),
      { uri: pathToFileURL(join(outputDirectory, "physicalization.json")).href, mimeType: "application/json", role: "collision" },
    ]
    // 空区保留由实际派生事实推导：未填充表面盒不填远离源面的室内，实测hull等价源面按原表面消费。
  // 表面盒仍有pitch量化厚度，不能据此声称源solid材料体积精确保全；usage和策略名不证明输出保孔。
  // 策略名 coacd/sdf 不能证明实际派生孔洞还在；盒组要有生产者的真实 fillInterior=false 回执。
  const cavitySafe = (object: PhysicalizedObject) => !object.consumerNotice && (object.hullSafe === true || object.selected === "voxel_boxes" && object.decomposition?.fillInterior === false || object.selected==='triangle_surface'&&object.staticTriangleSurface?.schema==='lyapunov.static-triangle-surface.v1')
  const interiorPreserved = usage !== "dynamic" && objects.length > 0 && objects.every(cavitySafe)
  // 通行没被实测：本工具不求解净通道宽/全场连通性，interiorPreserved 只是"所选表示不填补内部"的
  // **推导**值——实测里 0.25 m 体素把 0.7 m 门洞量化成 0.5 m 净宽，0.5 m 车过不去，而它仍是 true。
  // 所以把两件事分开写：空间保留（推导）与通行未实测（事实）。实测通行只对具体夹具与引擎成立，
  // 不随通用回执宣称。近似账本来就有：voxelResolutionM（分辨率）/volumeRatios（凸分解体积比）。
  const passage = usage !== "dynamic"
    ? {
        passageVerified: false as const,
        passageNote: "Passage is unverified: clearance and scene connectivity are not measured. interiorPreserved is inferred from unfilled surface voxels, a measured hull-equivalent source or declared native static triangles. Native triangles require a supported consumer (MuJoCo >=3.13 rigid-flex, radius 1e-9 m; Isaac static none); ordinary mesh convexification is not equivalent. voxelResolutionM reports finite voxel thickness.",
      }
    : {}
  // 选用策略/近似误差的实测账：逐节点表示计数、被改派的节点、体素实际分辨率、凸分解体积比。
  const selection: Record<string, number> = {}
  for (const object of objects) selection[object.selected] = (selection[object.selected] ?? 0) + 1
  const routed = objects.filter(object => object.routeReason).map(object => ({ node: object.node, selected: object.selected, reason: object.routeReason! }))
  const voxelResolutionM = [...new Set(objects.map(object => object.decomposition?.voxelSizeM).filter((value): value is number => typeof value === "number"))].sort((a, b) => a - b)
  const volumeRatios = objects.map(object => object.volumeRatio).filter((value): value is number => typeof value === "number")
  const cavityLostNodes = objects.filter(object => object.consumerNotice).map(object => ({ node: object.node, selected: object.selected, notice: object.consumerNotice! }))
  // 碰撞产物包围盒（实体局部帧）的并集：落地对齐的物理基准，mount 优先于视觉 aabb 使用。
    const boundsList = objects.map(object => object.bounds).filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds))
    const collisionBounds = boundsList.length
      ? {
          min: [0, 1, 2].map(axis => Math.min(...boundsList.map(bounds => bounds.min[axis as 0 | 1 | 2]))) as [number, number, number],
          max: [0, 1, 2].map(axis => Math.max(...boundsList.map(bounds => bounds.max[axis as 0 | 1 | 2]))) as [number, number, number],
        }
      : undefined
    // 回执字段取**实际产出**：件数/盒数/被导出的节点数来自 asset-bake 结果，不是请求参数的复述。
    // 近原生形状（fitPrimitive）走的是引擎原生 geom：它既不是 part 也不是体素盒，装配里却有盒体，
    // 所以单独计数——否则会出现"回执 boxes:0、实体上却挂着 6 个盒"的对不上。
    const partCount = objects.reduce((sum, object) => sum + (object.parts?.length ?? 0), 0)
    const boxCount = objects.reduce((sum, object) => sum + (object.boxes?.length ?? 0), 0)
    const primitiveCount = objects.filter(object => object.primitive).length
    await flushProgress()
    return await library.attachPhysicalization(resourceId, version, {
      // strategy 记**请求侧**解析值（与产物变体目录、去重判据同源）；asset-bake 回的 strategy 是它自己的
      // 缺省口径（environment 缺省时它是 triangle_mesh，而逐节点可能已改派成凸分解），两者不同就留在
      // derivedStrategy 里，免得"记录说 triangle_mesh、目录写着 auto"这种对不上。
      status: "ok", strategy, ...(result.strategy !== strategy ? { derivedStrategy: result.strategy } : {}), usage, representations, componentDefaults: collisionContract(objects, massFromVolume, usage),
      sourcePath, nodes: objects.length, parts: partCount, boxes: boxCount, primitives: primitiveCount, interiorPreserved, ...passage,
      selection, routed, voxelResolutionM, volumeRatios, cavityLostNodes, prunedParts: (result as PhysicalizedResult).prunedParts, policy: PHYSICALIZATION_POLICY,
      ...transport?{geometryTransport:transport}:{},
      ...physicalizationBudgets(options),
      ...objects.some(object=>object.pointCloud)?{pointCloud:objects.flatMap(object=>object.pointCloud?[{node:object.node,...object.sourceKind?{sourceKind:object.sourceKind}:{},...object.pointCloud}]:[])}:{},
      ...objects.some(object=>object.staticTriangleSurface)?{staticTriangleSurfaces:objects.flatMap(object=>object.staticTriangleSurface?[{node:object.node,...object.staticTriangleSurface}]:[])}:{},
      ...(supersedes ? { supersedes: true } : {}),
      ...(collisionBounds ? { collisionBounds } : {}),
    })
  } catch (error) {
    await failure(error)
    await discardAttemptOutput()
    return library.get(resourceId,version)
  }
}
