import { listSceneSummaries } from "./list-scenes.ts"
import {physicsWorkspaceSettings,standardGroundEntity,type SceneTemplate} from './scene-template.ts'
import {validateScenePhysics,DEFAULT_WORLD_GRAVITY} from '../../lyapunov-contracts/src/world-physics.ts'
import { randomUUID } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { Matrix4, Quaternion, Vector3 } from "three"
import type { Entity, ResourceRef, SceneGeometryBinding, SceneMeshCollisionComponent, ScenePatch, SceneSnapshot, Transform, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform, SCENE_COORDINATES, sceneCollisionAlignmentGate } from "../../lyapunov-contracts/src/types.ts"
import { atomicJSON, fileTransaction, readJSON, safeId } from "./persistence.ts"
import { glbEntities, localPath, parseAsset, robotVisual, sourceTransform, assetBounds } from "./formats.ts"
import type {SourceTexturePolicy} from './geometry-source-deps.ts'
import { compareGlbGeometry, glbGeometryFacts, type GlbGeometryFacts } from "./mesh-geometry.ts"
import { resolveSceneLayout, type ResolvedSceneLayout, type SceneLayout } from "./layout.ts"
import { ResourceLibrary, type ResourceRecord, type ResourceNetworkProvenance, type ResourceStorageKind, type ResourcePhysicalizationRequest } from "./resources.ts"
import { notePhysicalizationSkipped, schedulePhysicalization,pendingPhysicalization,resourcePhysicalizationOptions,physicalizationMatchesRequest,PHYSICALIZATION_POLICY, type PhysicalizeStrategy, type PhysicalizeUsage } from "./physicalization.ts"
import {activeCollisionUris,ensureCollisionArtifacts,resolveLegacyCollisionUri,validateSceneCollisionReferences,collisionVariant} from './collision-references.ts'
import {physicalizationBudgets,validatePhysicalizationBudgets,type PhysicalizationBudgetOptions} from './physicalization-parameters.ts'
import { PortableArchive, copyPortableProjectFiles } from './portable.ts' 
import {planPhysicsBinding,physicsBindingFacts,validatePhysicsBindingType,type PhysicsBindInput} from './physics-binding.ts'
import {physicsOwner,planPhysicsUpdate,sameDerivedPhysics,preservePhysicsControls,type PhysicsUpdateInput} from './physics-state.ts'
import { SceneConflict, SceneStore, validateSnapshot } from "./store.ts"

/** 资源引用的替换/去重身份：resourceId@version（同一版本的其它位置由 SceneStore 与 ResourceLibrary 核对）。 */
const referenceKey = (ref: ResourceRef): string => `${ref.resourceId}@${ref.version}`
const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= 1e-6)
const sameTransform = (a: Transform, b: Transform): boolean => sameNumbers(a.position, b.position) && sameNumbers(a.quaternion, b.quaternion) && sameNumbers(a.scale, b.scale)
function visualKind(entity: Entity): string | undefined { const kind = entity.components.visual?.kind; return typeof kind === "string" ? kind : undefined }
function gltfNodeIndex(entity: Entity): number | undefined { const index = entity.components.visual?.gltfNode; return typeof index === "number" ? index : undefined }
/** 挂载时按视觉类型决定的引用读取方式（viewer 的实际分支）：替换只换引用，因此类型必须一致。 */
const REQUIRED_TARGET_KIND: Record<string, string> = { group: "mesh", mesh: "mesh", splat: "splat", robot: "robot", source: "source" }
/** 源坐标转换由 viewer 包装的视觉类型；robot 的轴/单位在机器人文档内处理，不在此列。 */
const SOURCE_TRANSFORM_KINDS = ["mesh", "splat"]
/**
 * 由资源原件派生、换引用后未必还能沿用的组件（mount/物理化/引擎映射的产物）。
 * 其中 collision/rigidBody/controller 是**几何派生**的：新旧原件的几何逐节点一致（典型是
 * 材质/贴图变化）时旧值仍然适配，几何真的变了就必须按目标资源的派生默认原位重派生。
 * articulation/mujoco/isaac 与 visual.robot 由机器人原生文档派生，没有可核对的 GLB 几何事实，
 * 仍然一律拒绝，交给重建挂载。
 */
const RESOURCE_DERIVED_COMPONENTS = ["collision", "rigidBody", "articulation", "controller", "mujoco", "isaac"]
/** 只随几何派生的组件：可按几何事实核对结果保留，或按目标资源默认原位重派生。 */
const GEOMETRY_DERIVED_COMPONENTS = ["collision", "rigidBody", "controller"]

/**
 * 引用里承载视觉几何的 GLB：原件优先，其次 role='visual' 的表示。
 * role='collision' 的派生表示（asset-bake parts、配对碰撞 GLB）不是视觉原件，不参与几何判定。
 */
function visualGeometryUri(ref: ResourceRef): string | undefined {
  const candidates = [ref.original, ...ref.representations].filter(rep => rep.role !== "collision")
  return (candidates.find(rep => rep.mimeType === "model/gltf-binary") ?? candidates.find(rep => rep.uri.toLowerCase().endsWith(".glb")))?.uri
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function applySplatPreviewFacts(resource: ResourceRecord, visual: Record<string, unknown>): void {
  // 只投影当前资源版本的数值事实，不把磁盘路径或万能 metadata 带进 Scene。
  // 此处保留源坐标中心边界；Viewer 的 sourceTransform wrapper 负责一次坐标换算。
  delete visual.sourceBounds; delete visual.sourcePointCount
  const aabb = resource.parsed.metadata.aabb as { min?: unknown; max?: unknown } | undefined
  const min = aabb?.min, max = aabb?.max
  if (Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3
    && [...min, ...max].every(value => typeof value === "number" && Number.isFinite(value))
    && min.every((value, axis) => value <= max[axis])) {
    visual.sourceBounds = { min: min.map(value => value === 0 ? 0 : value), max: max.map(value => value === 0 ? 0 : value) }
  }
  const count = resource.parsed.metadata.vertexCount ?? resource.parsed.metadata.splatCount
  if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) visual.sourcePointCount = count
}

/** 单文件与 SSOG 多块共用这一份 splat 源坐标/可信碰撞装配规则。 */
function applySplatMountFacts(resource: ResourceRecord, components: Entity["components"]): void {
  components.visual ??= { kind: "splat" }
  components.visual.sourceTransform = resource.visualSourceTransform ?? sourceTransform(resource.ref.source)
  components.visual.sourceTransformApplied = false
  applySplatPreviewFacts(resource, components.visual)
  if (resource.sceneGeometryBinding) {
    const alignment = sceneCollisionAlignmentGate({ binding: resource.sceneGeometryBinding })
    if (alignment.ok && components.collision === undefined) components.collision = { shape: "mesh", frame: "mujoco-z-up-meters", binding: alignment.binding } satisfies SceneMeshCollisionComponent
  }
}

/**
 * 场景文档入口的 JSON 规范化：`-0` 是**合法**的 JSON 字面量（RFC 8259 的 number 含可选负号），
 * Blender 导出的四元数就带着它，所以它会被如实解析进内存；分歧出在写回去这一步——`JSON.stringify(-0)`
 * 只写得出 `0`，而 DSH 的工具结果 lossless 判据要求值能与它的序列化形式逐值往返（`Object.is` 级别），
 * 于是把 `-0` 和非有限数并列拒收。一个 `-0` 就让整次 `scene_open` 回执变成
 * "value is not lossless JSON"：场景其实已落库，模型却只看到失败（48 N1）。
 * 只把 `-0` 写成 `0`（数值语义不变），不删字段、不改几何、不吞其它错误；`NaN/Infinity` 不是合法 JSON
 * 字面量，解析阶段就给不出，不在这里兜底。
 */
function canonicalizeNegativeZero(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) { const item = value[index]; if (Object.is(item, -0)) value[index] = 0; else canonicalizeNegativeZero(item) }
    return
  }
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) { const item = record[key]; if (Object.is(item, -0)) record[key] = 0; else canonicalizeNegativeZero(item) }
}

/** 同一Scene只允许资源位置变化；字节等价由同一事务中的资源版本登记继续核对。 */
function sceneWithoutResourceLocations(value: SceneSnapshot): SceneSnapshot {
  const snapshot = structuredClone(value)
  for (const entity of snapshot.entities) {
    const mapped = new Map<string, string>()
    for (const ref of entity.resources) for (const [index, rep] of [ref.original, ...ref.representations].entries()) {
      const marker = `resource:${ref.resourceId}@${ref.version}:${index}`
      mapped.set(rep.uri, marker); mapped.set(localPath(rep.uri), marker); rep.uri = marker
    }
    for (const key of ['mujoco', 'isaac']) {
      const component = entity.components[key] as { sourcePath?: string } | undefined
      if (component?.sourcePath && mapped.has(component.sourcePath)) component.sourcePath = mapped.get(component.sourcePath)!
    }
    const collisionParts = (entity.components.collision as { parts?: unknown } | undefined)?.parts
    if (Array.isArray(collisionParts)) for (const [index, part] of collisionParts.entries()) if (typeof part === 'string' && mapped.has(part)) collisionParts[index] = mapped.get(part)!
    const source = entity.components.articulation?.source as { uri?: string } | undefined
    if (source?.uri && mapped.has(source.uri)) source.uri = mapped.get(source.uri)!
    const robot = entity.components.visual?.robot as { baseUri?: string } | undefined
    if (robot?.baseUri) for (const [uri, marker] of mapped) if (uri.startsWith('file:') && robot.baseUri === pathToFileURL(dirname(localPath(uri)) + '/').href) { robot.baseUri = marker + ':directory'; break }
  }
  return snapshot
}

/**
 * 文档里的引用按场景文件所在目录解析成 file:// URI。`open` 用它读工程，
 * 便携保存用它登记派生位置——两边必须用同一条规则，否则登记的位置就不是重开后文档指向的位置。
 */
function resolveReferenceUris(ref: ResourceRef, base: string): ResourceRef {
  const resolveUri = (uri: string): string => /^[a-z][a-z+.-]*:/i.test(uri) ? uri : pathToFileURL(resolve(base, uri)).href
  return { ...ref, original: { ...ref.original, uri: resolveUri(ref.original.uri) }, representations: ref.representations.map(rep => ({ ...rep, uri: resolveUri(rep.uri) })) }
}

/**
 * 便携文档里的本地路径按包目录解析回绝对路径（与 open 的读法逐条对应）。切引用时当前场景必须用
 * 绝对路径——相对路径只在包里成立；打包时删掉的 visual.robot 也一并删掉（重开时按包内原件重建）。
 */
function absoluteComponents(components: Entity["components"], base: string): Entity["components"] {
  const result = structuredClone(components)
  const mujoco = result.mujoco as { sourcePath?: string } | undefined
  if (mujoco?.sourcePath) mujoco.sourcePath = localPath(mujoco.sourcePath, base)
  const isaac = result.isaac as { sourcePath?: string } | undefined
  if (isaac?.sourcePath) isaac.sourcePath = localPath(isaac.sourcePath, base)
  const parts = (result.collision as { parts?: unknown } | undefined)?.parts
  if (Array.isArray(parts)) for (const [index, part] of parts.entries()) if (typeof part === "string" && !/^[a-z][a-z+.-]*:/i.test(part)) parts[index] = localPath(part, base)
  const articulation = result.articulation?.source as { uri?: string } | undefined
  if (articulation?.uri && !/^[a-z][a-z+.-]*:/i.test(articulation.uri)) articulation.uri = pathToFileURL(localPath(articulation.uri, base)).href
  if (result.visual?.robot) delete result.visual.robot
  return result
}

/** SceneOperations 的构造选项。第二参数仍兼容旧的 productRoot 字符串写法。 */
export interface SceneOperationsOptions {
  /** 产品安装根：其下的原件（materials/ 内置素材）导入时引用原位置，不复制。 */
  productRoot?: string
  /** 存储分治布局；省略时五个域根都等于 dataRoot，逐路径保持单根旧行为。 */
  layout?: SceneLayout
  /** 新导入的默认存储模式；省略时保持旧行为（产品自带/运行根内 reference，外部原件 cas）。 */
  defaultStorage?: ResourceStorageKind
  /**
   * 隔离算法解释器（碰撞派生用）：显式非秘密配置，隔离/管理员 Host 里没有 LYAPUNOV_ALGORITHM_PYTHON，
   * 靠装配方在运行时 patch 里与 sim/其他 provider 同一处解析后传入；省略时保持旧行为（asset-bake 自己
   * 回落环境变量，再缺即 PROVIDER_UNAVAILABLE）。
   */
  algorithmPython?: string
  /** 共享 CAS 根（见 ResourceLibrary 的 casRoot）：会话分治下唯一跨会话共享的字节目录。 */
  casRoot?: string
}

/**
 * 便携保存里的版本变更事实：哪些文件的字节在打包时被改写（before/after 都是**磁盘上的真实内容戳**），
 * 因此这个资源在这个包里是**新版本**——fromVersion → version。版本号由库分配，旧版本与其字节一步不动；
 * 场景引用随之切到新版本（save 会用一次原生 CAS 提交把当前场景一起切过去，revision 前进）。
 * reused 为 true 表示副本与某个已登记版本逐字节一致，直接复用那个版本、没有新立版本号（重复保存不涨版本）。
 */
export interface PortableDerivedSource {
  resourceId: string
  /** 打包前场景引用的版本。 */
  fromVersion: number
  /** 打包后场景引用的版本（新立；reused 时等于逐字节对上的那个已登记版本）。 */
  version: number
  reused: boolean
  /** 被改写的文件（相对便携目录）与改写前后的 sha256。 */
  files: Array<{ path: string; before: string; after: string }>
}

/**
 * ENV-29 局部资源替换输入：resourceId/version 是资源库里已登记的目标资源（version 省略取最新），
 * fromResourceId/fromVersion 用于在实体有多个资源引用时指定要替换掉的那一条。
 */
export interface ReplaceResourceInput {
  sceneId: string
  entityId: string
  expectedRevision: number
  resourceId: string
  version?: number
  fromResourceId?: string
  fromVersion?: number
}

/** 替换只改写被指定实体的资源引用（以及 GLB 展开组的派生节点引用），不新增/删除实体、不改位姿与用户组件。 */
export interface ReplaceResourceResult {
  sceneId: string
  entityId: string
  revision: number
  changed: boolean
  /** 本次实际改写引用的实体；未写入时为数组为空。 */
  entityIds: string[]
  from: { resourceId: string; version: number; uri: string }
  to: { resourceId: string; version: number; uri: string }
  warnings: string[]
  /**
   * 几何核对事实（只读自新旧原件的 GLB 字节）：nodes 是参与比对的网格节点数，digest 是逐节点
   * 「顶点位置集合 + 三角面多重集合」量化后的指纹。坐标是**实体本地、米**——原件里所有节点的
   * 祖先 TRS/matrix 与源坐标换算（轴适配 + metersPerUnit）都已计入，正是 collision 所在的坐标系；
   * 实体自己的位姿（用户可编辑）不参与。只在实体实际携带几何派生组件、本次替换需要判定几何是否
   * 变化时出现；bbox 只作为报告里的人工核对依据，不参与判定。
   */
  geometry?: { status: "identical" | "changed"; nodes: number; vertices: number; triangles: number; fromDigest: string; toDigest: string; frame: string; fromBounds: { min: Vec3; max: Vec3 }; toBounds: { min: Vec3; max: Vec3 } }
  /** 几何派生组件（collision/rigidBody/controller）的处理方式：kept=几何一致、原样保留；rederived=几何已变、按目标资源默认原位更新。 */
  physics?: { mode: "kept" | "rederived"; components: string[]; basis: string }
  snapshot: SceneSnapshot
}

export class SceneOperations {
  readonly scene: SceneStore
  readonly resources: ResourceLibrary
  /** 生效布局：省略 layout 时五个域根都等于 directory（split=false），此时场景仍在 <directory>/scenes。 */
  readonly layout: ResolvedSceneLayout
  constructor(readonly directory: string, productRootOrOptions?: string | SceneOperationsOptions) {
    // 旧调用把 productRoot 直接当第二参数传（script/refactor-verify.ts）；新调用一律用选项对象。
    const options: SceneOperationsOptions = typeof productRootOrOptions === "string" ? { productRoot: productRootOrOptions } : productRootOrOptions ?? {}
    this.layout = resolveSceneLayout(directory, options.layout)
    // 场景文档跟随 world 域；省略 layout 时 worlds === directory，路径与旧行为逐字一致。
    this.resources = new ResourceLibrary(directory, { productRoot: options.productRoot, layout: options.layout, defaultStorage: options.defaultStorage, algorithmPython: options.algorithmPython, casRoot: options.casRoot })
    this.scene = new SceneStore(this.layout.worlds,async(draft,current,kind)=>{
      if(kind==='restore')await this.repairCollisionReferences(draft)
      await validateSceneCollisionReferences(this.resources,draft,current)
    })
  }
  private async templateGround(){
    return standardGroundEntity()
  }
  async create(input: { sceneId?: string; name?: string; template?:SceneTemplate } = {}): Promise<SceneSnapshot> {
    if(input.template!==undefined&&!['blank','physics-workspace'].includes(input.template))throw Error('SCENE_TEMPLATE_INVALID')
    const sceneId = input.sceneId ?? `scene_${randomUUID()}`
    const snapshot: SceneSnapshot = { sceneId, revision: 0, coordinates: { ...SCENE_COORDINATES }, entities: [] }
    return fileTransaction(this.scene.path(sceneId), async () => {
      try { await this.scene.snapshot(sceneId); throw new Error(`SCENE_ALREADY_EXISTS: ${sceneId}`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if(input.template==='physics-workspace'){
        snapshot.entities=[await this.templateGround()];snapshot.physics=physicsWorkspaceSettings()
      }else if(input.template==='blank')snapshot.physics={gravityWorldMps2:[...DEFAULT_WORLD_GRAVITY],template:'blank'}
      validateSnapshot(snapshot)
      await atomicJSON(this.scene.path(sceneId), snapshot)
      await this.scene.recordVersion(snapshot)
      return snapshot
    })
  }
  /** 显式准备现有空白；已准备模板不重置用户编辑或再造被删除的地面。 */
  async prepareWorkspace(input:{sceneId:string;expectedRevision:number}):Promise<SceneSnapshot>{
    const current=await this.scene.snapshot(input.sceneId)
    if(current.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,current.revision)
    if(['physics-workspace-v1','physics-workspace-v2'].includes(current.physics?.template??'')||['removed','disabled'].includes(current.physics?.groundState??''))return current
    const existing=current.entities.filter(e=>(e.components.supportSurface as {kind?:string}|undefined)?.kind==='ground'&&e.components.collision?.shape==='plane'&&e.components.collision?.infinite===true)
    if(existing.length>1)throw Error('SCENE_GROUND_SELECTION_REQUIRED: 已有多个明确地面，请选择支持面')
    const ground=existing[0]??await this.templateGround(),physics={...physicsWorkspaceSettings(),gravityWorldMps2:current.physics?.gravityWorldMps2??[...DEFAULT_WORLD_GRAVITY],groundEntityId:ground.entityId}
    return this.scene.commit({sceneId:current.sceneId,expectedRevision:current.revision,patch:existing.length?[]:[{op:'add',entity:ground}],physics})
  }
  /** 首次创建物理世界才准备；明确ground=false记录禁用选择，不偷偷补Collider。 */
  async prepareWorld(input:{sceneId:string;expectedRevision:number;ground?:boolean}):Promise<SceneSnapshot>{
    const current=await this.scene.snapshot(input.sceneId)
    if(current.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,current.revision)
    if(['physics-workspace-v1','physics-workspace-v2'].includes(current.physics?.template??'')||['removed','disabled'].includes(current.physics?.groundState??''))return current
    if(input.ground===false)return this.scene.commit({sceneId:current.sceneId,expectedRevision:current.revision,patch:[],physics:{...current.physics,gravityWorldMps2:current.physics?.gravityWorldMps2??[...DEFAULT_WORLD_GRAVITY],template:'physics-workspace-v2',groundState:'disabled'}})
    return this.prepareWorkspace(input)
  }
  async configurePhysics(input:{sceneId:string;expectedRevision:number;gravityWorldMps2:Vec3}):Promise<SceneSnapshot>{
    const current=await this.scene.snapshot(input.sceneId),physics={...current.physics,gravityWorldMps2:input.gravityWorldMps2}
    validateScenePhysics(physics)
    return this.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:[],physics})
  }
  async list(): Promise<Array<{ sceneId: string; revision: number; entityCount: number }>> {
    // 场景目录投影跟随 world 域；省略 layout 时 worlds === directory。
    return listSceneSummaries(this.layout.worlds, sceneId => this.scene.snapshot(sceneId))
  }
  async open(path: string, options: { sceneId?: string } = {}): Promise<SceneSnapshot> {
    path = localPath(path)
    if (/\.scene-package\.json$/i.test(path)) return this.importPackage(path, options)
    const snapshot = await readJSON<SceneSnapshot>(path)
    if (options.sceneId) snapshot.sceneId = safeId(options.sceneId)
    for (const entity of snapshot.entities) {
      for (const ref of entity.resources) {
        const resolved = resolveReferenceUris(ref, dirname(path))
        ref.original = resolved.original
        ref.representations = resolved.representations
        // 文件存在不等于依赖可用；重开机器人前核对真实依赖闭包。
        if(["application/x-mjcf+xml","application/x-urdf+xml"].includes(ref.original.mimeType))await parseAsset(localPath(ref.original.uri),ref.source)
      }
      const mujoco = entity.components.mujoco as { sourcePath?: string } | undefined
      if (mujoco?.sourcePath) mujoco.sourcePath = localPath(mujoco.sourcePath, dirname(path))
      const isaac=entity.components.isaac as {sourcePath?:string}|undefined
      if(isaac?.sourcePath)isaac.sourcePath=localPath(isaac.sourcePath,dirname(path))
      // portable 保存时 collision.parts 被改写成相对路径；重开时按场景文件位置还原为绝对路径（worker 契约允许 file:// 或绝对路径）。
      const collisionParts=(entity.components.collision as {parts?:unknown}|undefined)?.parts
      if(Array.isArray(collisionParts))for(const [index,part] of collisionParts.entries())if(typeof part==='string'&&!/^[a-z][a-z+.-]*:/i.test(part))collisionParts[index]=localPath(part,dirname(path))
      const articulationSource = entity.components.articulation?.source as { uri?: string } | undefined
      if (articulationSource?.uri && !/^[a-z][a-z+.-]*:/i.test(articulationSource.uri)) articulationSource.uri = pathToFileURL(resolve(dirname(path), articulationSource.uri)).href
      if (entity.components.visual?.kind === "robot" && !entity.components.visual.robot) {
        const native = entity.resources.flatMap(ref => [ref.original, ...ref.representations]).find(rep => ["application/x-mjcf+xml", "application/x-urdf+xml"].includes(rep.mimeType))
        if (native) entity.components.visual.robot = await robotVisual(localPath(native.uri))
      }
    }
    // 读到原件后、校验与落盘之前：把 producer 写的 -0 规范化成 0，让返回值与落库件都是可往返的 JSON
    // （否则第一次 open 的回执被判 invalid output，第二次 open 又因 -0 ≠ 0 报重开冲突）。
    canonicalizeNegativeZero(snapshot)
    validateSnapshot(snapshot)
    await fileTransaction(this.scene.path(snapshot.sceneId), async () => {
      let unchanged = false
      let existing:SceneSnapshot|undefined
      try {
        const current = await this.scene.snapshot(snapshot.sceneId)
        existing=current
        unchanged = isDeepStrictEqual(current, snapshot)
        if (!unchanged && !isDeepStrictEqual(sceneWithoutResourceLocations(current), sceneWithoutResourceLocations(snapshot))) throw new Error(`SCENE_ALREADY_EXISTS: ${snapshot.sceneId}；重开冲突需显式指定新的 sceneId`)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      // 旧版本已打开过的工程也会补登记；同一版本幂等，不覆盖资源的用户元数据。
      // 一并带上实体的 components：文档里所有引用一致给出的控制/传感器映射会成为资源默认。
      await this.resources.registerReferences(snapshot.entities.flatMap(entity => entity.resources.map(ref => ({ ref, name: entity.name, components: entity.components }))))
      if(!unchanged){
        const before=structuredClone(snapshot)
        const repaired=await this.repairCollisionReferences(snapshot)
        await validateSceneCollisionReferences(this.resources,snapshot,existing)
        if(repaired){await this.scene.recordVersion(existing??before);snapshot.revision=Math.max(snapshot.revision,existing?.revision??0)+1}
        await atomicJSON(this.scene.path(snapshot.sceneId), snapshot)
      }
    })
    return (await this.reconcilePhysics({sceneId:snapshot.sceneId})).snapshot
  }
  /**
   * 导入自包含场景包：逐件走资源库的真实解析/CAS 闭包登记，再把库产生的完整 Ref
   * 交给 Scene。保留实例位姿、比例和物理声明，不把 GLB 展开成额外的 1m 实体。
   * 与 open 保留既有身份不同，包的实例始终是新 Scene，不覆盖已经打开的用户场景。
   */
  async importPackage(path: string, options: { sceneId?: string } = {}): Promise<SceneSnapshot> {
    path = localPath(path)
    const snapshot = await readJSON<SceneSnapshot>(path)
    const base = await realpath(dirname(path))
    const sceneId = options.sceneId ? safeId(options.sceneId) : `scene_${randomUUID()}`
    snapshot.sceneId = sceneId
    snapshot.revision = 0
    canonicalizeNegativeZero(snapshot)
    validateSnapshot(snapshot)
    const files = new Map<string, { path: string; ref: ResourceRef; name: string; components: Entity["components"] }>()
    const insidePackage = async (entry: string): Promise<string> => {
      const actual = await realpath(entry)
      const rel = relative(base, actual)
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("SCENE_PACKAGE_OUTSIDE_ROOT: 资源或依赖必须在场景包目录内")
      return actual
    }
    // 全部原件与声明依赖先预检。缺件一次列出，不建半个场景、也不逐件试错下载。
    const issues: string[] = []
    for (const entity of snapshot.entities) for (const ref of entity.resources) {
      try {
        const resolved = resolveReferenceUris(ref, base)
        const entry = await insidePackage(localPath(resolved.original.uri))
        if (resolved.representations.some(rep => localPath(rep.uri) !== localPath(resolved.original.uri))) throw new Error("SCENE_PACKAGE_DERIVED_REPRESENTATION_UNSUPPORTED: 独立派生表示需先按资源库协议登记")
        if (!files.has(entry)) {
          const parsed = await parseAsset(entry, ref.source)
          for (const dependency of parsed.dependencies) await insidePackage(dependency.path)
          files.set(entry, { path: entry, ref, name: entity.name, components: absoluteComponents(entity.components, base) })
        }
      } catch (error) { issues.push(`${entity.name}: ${errorText(error)}`) }
    }
    if (issues.length) throw new Error(`SCENE_PACKAGE_ASSETS_INVALID: ${JSON.stringify([...new Set(issues)])}`)
    return fileTransaction(this.scene.path(sceneId), async () => {
      try { await this.scene.snapshot(sceneId); throw new Error(`SCENE_ALREADY_EXISTS: ${sceneId}；场景包请作为新场景导入`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      const records = new Map<string, ResourceRecord>()
      for (const file of files.values()) {
        records.set(file.path, await this.resources.import({ path: file.path, name: file.name, source: file.ref.source, components: file.components, storage: "cas" }))
      }
      for (const entity of snapshot.entities) {
        const remap = new Map<string, string>()
        entity.resources = await Promise.all(entity.resources.map(async ref => {
          const oldPath = await realpath(localPath(resolveReferenceUris(ref, base).original.uri))
          const record = records.get(oldPath)!
          remap.set(oldPath, localPath(record.ref.original.uri))
          return structuredClone(record.ref)
        }))
        entity.components = absoluteComponents(entity.components, base)
        const remapPath = async (value: string): Promise<string> => {
          const source = await realpath(localPath(value, base))
          const next = remap.get(source)
          if (!next) throw new Error("SCENE_PACKAGE_SOURCE_NOT_REGISTERED: 引擎 sourcePath 必须对应本实体已登记的原件")
          return next
        }
        for (const key of ["mujoco", "isaac"] as const) {
          const component = entity.components[key] as { sourcePath?: string } | undefined
          if (component?.sourcePath) component.sourcePath = await remapPath(component.sourcePath)
        }
        const articulation = entity.components.articulation?.source as { uri?: string } | undefined
        if (articulation?.uri) articulation.uri = pathToFileURL(await remapPath(articulation.uri)).href
        if (entity.components.visual?.kind === "robot") {
          const native = entity.resources.find(ref => ["application/x-mjcf+xml", "application/x-urdf+xml"].includes(ref.original.mimeType))
          if (!native) throw new Error("SCENE_PACKAGE_ROBOT_SOURCE_REQUIRED: 机器人可视化需要已登记的原生文档")
          entity.components.visual.robot = await robotVisual(localPath(native.original.uri))
        }
      }
      canonicalizeNegativeZero(snapshot)
      validateSnapshot(snapshot)
      await atomicJSON(this.scene.path(sceneId), snapshot)
      await this.scene.recordVersion(snapshot)
      return snapshot
    })
  }
  /**
   * 两次 revision 之间的**变更集**（只读）：ENV-32 的"增量导出"在本设计下就落在这里。
   *
   * 为什么不是"只写变更实体"：磁盘上的每一份 revision 都是**完整、不可变**的快照
   * （`store.ts:15` 的契约 + `store.ts:89-93` 对同一 revision 不同字节直接报
   * `SCENE_HISTORY_CONFLICT`），导出物必须能被 `scene_open` 直接读回，所以导出文件本身
   * 只能继续是全量文档。缺的那一块是"给消费方的变更集"：哪些实体在两次 revision 之间
   * 新增/改动/删除——按实体逐字段比较（JSON 字符串，与 Viewer 的 signature 复用一个口径），
   * 不猜、不按时间戳。
   */
  private changeset(base: SceneSnapshot, next: SceneSnapshot): { summary: { kind: "scene-changeset"; sceneId: string; fromRevision: number; toRevision: number; added: string[]; updated: string[]; removed: string[]; unchanged: number; entityCount: number }; entities: { added: Entity[]; updated: Entity[] } } {
    const before = new Map(base.entities.map(entity => [entity.entityId, JSON.stringify(entity)]))
    const after = new Map(next.entities.map(entity => [entity.entityId, JSON.stringify(entity)]))
    const added: string[] = [], updated: string[] = [], removed: string[] = []
    for (const [entityId, json] of after) {
      const prior = before.get(entityId)
      if (prior === undefined) added.push(entityId)
      else if (prior !== json) updated.push(entityId)
    }
    for (const entityId of before.keys()) if (!after.has(entityId)) removed.push(entityId)
    const changed = new Set([...added, ...updated])
    return {
      summary: { kind: "scene-changeset", sceneId: next.sceneId, fromRevision: base.revision, toRevision: next.revision, added, updated, removed, unchanged: after.size - changed.size, entityCount: after.size },
      entities: { added: next.entities.filter(entity => added.includes(entity.entityId)), updated: next.entities.filter(entity => updated.includes(entity.entityId)) },
    }
  }

  /** 把变更集算出来（可选写一份只含变更实体的 changeset 文件）；只在给了 sinceRevision 时生效。 */
  private async emitChangeset(base: SceneSnapshot | undefined, next: SceneSnapshot, diffPath?: string): Promise<{ diff?: { kind: "scene-changeset"; sceneId: string; fromRevision: number; toRevision: number; added: string[]; updated: string[]; removed: string[]; unchanged: number; entityCount: number }; diffPath?: string; diffBytes?: number }> {
    if (base === undefined) return {}
    const { summary, entities } = this.changeset(base, next)
    if (diffPath === undefined) return { diff: summary }
    const target = localPath(diffPath)
    await atomicJSON(target, { ...summary, entities })
    const { stat } = await import("node:fs/promises")
    return { diff: summary, diffPath: target, diffBytes: (await stat(target)).size }
  }

  async save(sceneId: string, path: string, options: { portable?: boolean; projectFiles?: string[]; sinceRevision?: number; diffPath?: string } = {}): Promise<{ path: string; snapshot: SceneSnapshot; missing: string[]; projectFiles?: string[]; derivedFiles?: string[]; derivedSources?: PortableDerivedSource[]; packagedFileCount?: number; diff?: { kind: "scene-changeset"; sceneId: string; fromRevision: number; toRevision: number; added: string[]; updated: string[]; removed: string[]; unchanged: number; entityCount: number }; diffPath?: string; diffBytes?: number }> {
    const snapshot = (await this.reconcilePhysics({sceneId})).snapshot
    if (options.sinceRevision !== undefined && (!Number.isInteger(options.sinceRevision) || options.sinceRevision < 0)) throw new Error(`INVALID_REVISION: sinceRevision=${String(options.sinceRevision)}`)
    if (options.diffPath !== undefined && options.sinceRevision === undefined) throw new Error("DIFF_REQUIRES_SINCE_REVISION: diffPath 只在同时给出 sinceRevision 时才有意义（没有基准 revision 就没有变更集）")
    // 基准必须是**已存在**的那一版；不存在的 revision 由 store.version 明确报错，不退化成本次快照的自比。
    const diffBase = options.sinceRevision === undefined ? undefined : await this.scene.version(sceneId, options.sinceRevision)
    path = localPath(path)
    const base = dirname(path)
    const missing: string[] = []
    // 项目文件只在便携保存里有意义：非便携保存不复制任何用户文件。
    if (options.projectFiles?.length && !options.portable) throw new Error("PORTABLE_REQUIRED_FOR_PROJECT_FILES")
    // 不把同一路径的新字节标成旧version输出。场景结构本身仍然可读取/编辑。
    for(const entity of snapshot.entities)for(const ref of entity.resources){
      const record=await this.resources.recordFor(ref)
      if(record){const verification=await this.resources.verifyReference(ref);if(!verification.valid)throw new Error(`RESOURCE_VERSION_UNAVAILABLE: ${ref.resourceId}@${ref.version} ${JSON.stringify(verification)}`)}
    }
    if (options.portable) {
      const archive=new PortableArchive(base)
      // 用户点名的项目文件（脚本/参考图/贴图）先落位：场景里若有引用指向它们，下面的改写同样覆盖。
      const project=await copyPortableProjectFiles(archive,(options.projectFiles??[]).map(file=>resolve(base,file)),join(base,"project"))
      const bundles=new Map<string,{uri:string;copied:Map<string,string>;ref:ResourceRef;record?:ResourceRecord}>()
      for (const entity of snapshot.entities) {
        const copied=new Map<string,string>(project)
        for (const ref of entity.resources) {
          const key=`${ref.resourceId}@${ref.version}`,uri=ref.original.uri
          let bundle=bundles.get(key)
          if(bundle&&bundle.uri!==uri)throw new Error(`RESOURCE_VERSION_SOURCE_CONFLICT: ${key}`)
          if(!bundle){const record=await this.resources.recordFor(ref);bundle={uri,ref:structuredClone(ref),copied:await archive.copyResource(ref,record),record};bundles.set(key,bundle)}
          for(const [source,target] of bundle.copied)copied.set(source,target)
          const reps = [ref.original, ...ref.representations]
          for (const rep of reps) {
            // ENV-60：与 `copyResource` 同一解析口径——相对 URI 相对**导出目录**（base），不是进程 CWD。
            const target = copied.get(localPath(rep.uri, base))
            if (target) rep.uri = relative(base, target)
          }
        }
        // 组件里的本地路径（原件位置、碰撞派生 parts）同样跟着随包文件走；不在随包清单里的保持原样。
        const remap=(value:string):string|undefined=>{try{return copied.get(localPath(value,base))}catch{return undefined}}
        const mujoco = entity.components.mujoco as { sourcePath?: string } | undefined
        if (mujoco?.sourcePath) { const target=remap(mujoco.sourcePath); if (target) mujoco.sourcePath = relative(base, target) }
        const isaac=entity.components.isaac as {sourcePath?:string}|undefined
        if(isaac?.sourcePath){const target=remap(isaac.sourcePath);if(target)isaac.sourcePath=relative(base,target)}
        const articulationSource = entity.components.articulation?.source as { uri?: string } | undefined
        if (articulationSource?.uri) {
          const target = remap(articulationSource.uri)
          if (target) articulationSource.uri = relative(base, target)
        }
        // 碰撞派生 parts（凸包 OBJ 等）随表示通道一起打包；指向已复制派生物的引用改写成相对路径，便携工程自包含。
        const collisionParts=(entity.components.collision as {parts?:unknown}|undefined)?.parts
        if(Array.isArray(collisionParts))for(const [index,part] of collisionParts.entries())if(typeof part==='string'){const target=remap(part);if(target)collisionParts[index]=relative(base,target)}
        // Display descriptions point at robot meshes; rebuild from portable source when reopened.
        if (entity.components.visual?.robot) delete entity.components.visual.robot
      }
      // 副本被改写过（绝对引用改成随包相对路径）＝字节真的变了＝**新版本**。按库的原生版本机制另立
      // 版本号（旧版本、旧版本的字节与其判据一步不动），再把随包文档与**当前场景**一起切到新版本引用：
      // 场景走一次原生 CAS 提交（expectedRevision 就是上面读到的 revision），revision 前进。这里没有
      // 任何"同一版本换一份字节"的通道，也没有用调用方声明的内容戳去改写旧版本依赖的路径——真正改了
      // 内容的副本只会成为另一个版本，冒充不了原版本。副本与已登记版本逐字节一致时不另立版本（重复
      // 保存不涨版本）。
      const derivedSources: PortableDerivedSource[] = []
      const switched = new Map<string,PortableDerivedSource>()
      for (const [key,bundle] of bundles) {
        if(!bundle.record)continue
        const files=[...bundle.copied.entries()].flatMap(([source,target])=>{const rewrite=archive.rewrites.get(target);return rewrite?[{source,target,before:{sha256:rewrite.before.sha256!,size:rewrite.before.size},after:{sha256:rewrite.after.sha256!,size:rewrite.after.size}}]:[]})
        if(!files.length)continue
        const inside=(uri:string)=>pathToFileURL(bundle.copied.get(localPath(uri,base))??localPath(uri,base)).href
        const located:ResourceRef={...structuredClone(bundle.ref),original:{...bundle.ref.original,uri:inside(bundle.ref.original.uri)},representations:bundle.ref.representations.map(rep=>({...rep,uri:inside(rep.uri)}))}
        const registered=await this.resources.registerDerivedVersion({ ref:located, derivation:{ kind:"external-path-rewrite", from:bundle.ref.version, files, at:new Date().toISOString() } })
        const change={ resourceId:bundle.ref.resourceId, fromVersion:bundle.ref.version, version:registered.ref.version, reused:registered.reused, files:files.map(file=>({ path:relative(base,file.target), before:file.before.sha256, after:file.after.sha256 })) }
        switched.set(key,change); derivedSources.push(change)
      }
      const mutated = new Set<string>()
      for (const entity of snapshot.entities) for (const ref of entity.resources) {
        const change=switched.get(`${ref.resourceId}@${ref.version}`)
        if(change){ref.version=change.version;mutated.add(entity.entityId)}
      }
      if (mutated.size) {
        // 当前场景跟着切：引用用绝对路径（场景文档自身没有 base），组件里的本地路径同样还原成绝对路径，
        // 打包时删掉的 visual.robot 也一并删——重开随包文档时 open 会把相对路径解析回同一批绝对路径，
        // 因此文档与当前场景是同一个 revision、逐字段可比，不会撞 SCENE_ALREADY_EXISTS。
        const committed=await this.scene.commit({ sceneId, expectedRevision:snapshot.revision, patch:snapshot.entities.filter(entity=>mutated.has(entity.entityId)).map(entity=>({op:"update" as const,entityId:entity.entityId,changes:{resources:entity.resources.map(ref=>({...ref,original:{...ref.original,uri:pathToFileURL(localPath(ref.original.uri,base)).href},representations:ref.representations.map(rep=>({...rep,uri:pathToFileURL(localPath(rep.uri,base)).href}))})),components:absoluteComponents(entity.components,base)}})) })
        snapshot.revision=committed.revision
      }
      await atomicJSON(path, snapshot)
      return {
        path, snapshot, missing,
        projectFiles: [...project.values()].map(target=>relative(base,target)).sort(),
        derivedFiles: [...archive.derived].map(target=>relative(base,target)).sort(),
        ...(derivedSources.length?{derivedSources}:{}),
        packagedFileCount: archive.targets.size,
        // 便携分支的 snapshot 可能刚被改写过（引用切新版本、revision 前进），变更集按**导出的这一份**算。
        ...(await this.emitChangeset(diffBase, snapshot, options.diffPath)),
      }
    } else {
      for (const entity of snapshot.entities) for (const ref of entity.resources) {
        const { access } = await import("node:fs/promises")
        for (const rep of [ref.original, ...ref.representations]) {
          try { await access(localPath(rep.uri)) } catch { missing.push(rep.uri) }
        }
      }
    }
    await atomicJSON(path, snapshot)
    return { path, snapshot, missing: [...new Set(missing)], ...(await this.emitChangeset(diffBase, snapshot, options.diffPath)) }
  }
  async import(input: { path: string; sceneId?: string; name?: string; resourceId?: string; entityId?: string; source?: ResourceRef["source"]; sourceTexturePolicy?:SourceTexturePolicy; parentId?: string; transform?: Transform; alignBottomToSurface?: boolean; components?: Entity["components"]; sceneGeometryBinding?: SceneGeometryBinding; networkProvenance?: ResourceNetworkProvenance; physicalize?: boolean; physicalizeStrategy?: PhysicalizeStrategy; physicalizeUsage?: PhysicalizeUsage; physicalizeVoxelSizeM?: number; physicalizationRequest?: ResourcePhysicalizationRequest; storage?: ResourceStorageKind; tags?: string[]; folder?: string }): Promise<{ resource: ResourceRecord; snapshot?: SceneSnapshot; entityId?: string }> {
    const explicit = input.physicalize !== undefined || input.physicalizeUsage !== undefined || input.physicalizeStrategy !== undefined || input.physicalizeVoxelSizeM !== undefined
    if(explicit&&input.physicalizationRequest!==undefined)throw Error('PHYSICS_REQUEST_MIXED: 结构化请求与旧平面物理参数只选一组')
    const request: ResourcePhysicalizationRequest | undefined = explicit
      ? input.physicalize === false ? false : { ...(input.physicalizeUsage !== undefined ? {usage:input.physicalizeUsage} : {}), ...(input.physicalizeStrategy !== undefined ? {strategy:input.physicalizeStrategy} : {}), ...(input.physicalizeVoxelSizeM !== undefined ? {voxelSizeM:input.physicalizeVoxelSizeM} : {}) }
      : input.physicalizationRequest
    let resource = await this.resources.import({...input,...request !== undefined ? {physicalizationRequest:request} : {}})
    // 物理更新后可重读/采用派生快照；本次 import 的瞬时回执不能随最新 Record 被丢掉，也不能落库。
    const receiptKeys = ["alreadyPresent", "replayed", "beforeRegistryRevision", "warnings", "operationID", "idempotencyKey", "registryRevision"] as const
    const importReceipt = Object.fromEntries(receiptKeys.filter(key => resource[key] !== undefined).map(key => [key, resource[key]]))
    // mesh 资源登记成功后异步派生碰撞：fire-and-forget，同步导入路径不因物理化失败而失败。
    // 用途/策略/体素边长都只是透传给同一个派生队列；不给用途时解析为 dynamic，旧行为逐字不变。
    // 大点云普通导入仍不自动多读/烘焙；只有明确提出物理化的点云才走同一资源版本队列。
    const requestedSplatPhysics = resource.parsed.kind === "splat" && resource.physicalizationRequest !== undefined && resource.physicalizationRequest !== false
    const requested=resourcePhysicalizationOptions(resource)
    let pending: Promise<ResourceRecord|undefined> | undefined
    if (resource.parsed.kind === "mesh" || requestedSplatPhysics) {
      if (resource.physicalizationRequest === false) {await notePhysicalizationSkipped(this.resources, resource.ref);resource=await this.resources.get(resource.ref.resourceId,resource.ref.version)}
      else {
        pending=pendingPhysicalization(this.resources,resource.ref,requested)
        const stopped=importReceipt.alreadyPresent===true&&!pending&&['failed','pending'].includes(resource.physicalization?.status??'')
        // 重导入旧失败/中断记录时保留可恢复终态；显式请求才重派，正常首次导入仍自动生成。
        if(!stopped||request!==undefined)pending=pending??schedulePhysicalization(this.resources,resource.ref,requested)
        if(resource.parsed.kind==='mesh'&&input.sceneId&&resource.parsed.dependencies.reduce((n,d)=>n+d.size,0)<=16*1024*1024)resource=await pending??resource
      }
    }
    resource = { ...resource, ...importReceipt }
    if (!input.sceneId) return { resource }
    const mountRecord=structuredClone(resource)
    if(pending&&!physicalizationMatchesRequest(resource,requested)){
      // 新实例不能套上一用途的已派生默认；显式用户组件仍由mount的input.components承载。
      if(typeof mountRecord.componentDefaults?.collision?.source==="string"&&mountRecord.componentDefaults.collision.source.startsWith("asset-bake")){
        if(!resource.explicitComponentDefaultKeys?.includes('collision'))delete mountRecord.componentDefaults.collision
        if(!resource.explicitComponentDefaultKeys?.includes('rigidBody'))delete mountRecord.componentDefaults.rigidBody
      }
      mountRecord.physicalization={status:"pending",usage:requested.usage,strategy:requested.strategy}
    }
    const result = await this.mount({ ...input, sceneId: input.sceneId, resourceId: resource.ref.resourceId, version: resource.ref.version },mountRecord)
    return { resource, ...result }
  }
  private completionPatch(scene:SceneSnapshot,entityId:string,ref:ResourceRef,record:ResourceRecord,repairBound=false):ScenePatch {
    const entity=scene.entities.find(e=>e.entityId===entityId)
    if(!entity||!entity.resources.some(r=>referenceKey(r)===referenceKey(ref))||entity.components.collision&&!repairBound)return []
    const binding=entity.components.physicsBinding as {derivedComponents?:Entity['components']}|undefined
    const baseline=binding?.derivedComponents?.collision
    const canRepair=Boolean(repairBound&&baseline&&sameDerivedPhysics('collision',entity.components.collision,baseline))
    try{
      if(record.physicalization?.status==='pending')throw Error('PHYSICS_DERIVATION_NOT_RUNNING: 本版本派生作业已不在运行，请在物理面板显式恢复')
      if(record.physicalization?.status!=='ok')throw Error('PHYSICS_DERIVATION_FAILED: '+(record.physicalization?.error??record.physicalization?.status??'未完成'))
      let candidate=scene
      if(entity.components.collision){
        if(!canRepair)throw Error('PHYSICS_BIND_CUSTOMIZED: 冷缓存恢复不覆盖用户碰撞')
        candidate=structuredClone(scene)
        const owner=candidate.entities.find(e=>e.entityId===entityId)!
        delete owner.components.collision;delete owner.components.physicsBinding
      }
      const plan=planPhysicsBinding(candidate,record,{sceneId:scene.sceneId,entityId,expectedRevision:scene.revision})
      const update=plan.patch[0]
      if(entity.components.collision&&update?.op==='update'&&update.changes.components?.collision)
        update.changes.components.collision=preservePhysicsControls('collision',update.changes.components.collision,entity.components.collision)
      const pendingEnabled=(entity.components.physicsBinding as {pendingCollisionEnabled?:unknown}|undefined)?.pendingCollisionEnabled
      if(typeof pendingEnabled==='boolean'&&update?.op==='update'&&update.changes.components?.collision)update.changes.components.collision.enabled=pendingEnabled
      return plan.patch
    }catch(error){
      if(entity.components.collision&&!canRepair)throw error
      const components={...entity.components,physicsBinding:{...entity.components.physicsBinding as Record<string,unknown>,resourceId:ref.resourceId,version:ref.version,status:'BIND_REQUIRED',reason:errorText(error)}}
      if(canRepair)delete components.collision
      return isDeepStrictEqual(components,entity.components)?[]:[{op:'update',entityId,changes:{components}}]
    }
  }
  private async completeImportedPhysics(sceneId:string,entityId:string,ref:ResourceRef,derived?:ResourceRecord,repairBound=false){
    const record=derived??await this.resources.get(ref.resourceId,ref.version)
    if(record.physicalization?.status==='ok'){
      if(!(await this.resources.verify(ref.resourceId,ref.version)).valid)throw Error('PHYSICS_BIND_ORIGINAL_UNVERIFIED')
      await ensureCollisionArtifacts(this.resources,record,activeCollisionUris(this.resources,record))
    }
    for(let attempt=0;attempt<3;attempt++){
      const scene=await this.scene.snapshot(sceneId),target=scene.entities.find(e=>e.entityId===entityId)
      if(!target)return
      // 同版本同变体的多个实例一次提交，避免先修一个却被另一个缺缓存的旧实例挡住。
      const targets=repairBound?scene.entities.filter(e=>e.resources.some(r=>referenceKey(r)===referenceKey(ref))&&isDeepStrictEqual(e.components.collision?.parts,target.components.collision?.parts)):[target]
      const patch=targets.flatMap(e=>this.completionPatch(scene,e.entityId,ref,record,repairBound))
      if(!patch.length)return
      try{await this.scene.commit({sceneId,expectedRevision:scene.revision,patch});return}
      catch(error){if(!(error instanceof SceneConflict)||attempt===2)throw error}
    }
  }
  private async repairCollisionReferences(snapshot:SceneSnapshot):Promise<boolean>{
    let changed=false
    for(const entity of snapshot.entities){
      const collision=entity.components.collision,parts=collision?.parts
      if(!String(collision?.source??'').startsWith('asset-bake-')||!Array.isArray(parts)||!parts.length)continue
      if(entity.resources.length!==1)throw Error('COLLISION_RECOVERY_RESOURCE_REQUIRED: 选择同版本资源的完整实例')
      const record=await this.resources.recordFor(entity.resources[0]!)
      if(!record)throw Error('COLLISION_RECOVERY_RESOURCE_REQUIRED: 当前会话未登记该引用版本')
      const resolved=await Promise.all(parts.map(uri=>resolveLegacyCollisionUri(this.resources,record,String(uri))))
      if(!isDeepStrictEqual(parts,resolved)){
        entity.components.collision={...collision,parts:resolved}
        const binding=entity.components.physicsBinding as {derivedComponents?:Entity['components']}|undefined
        if(binding?.derivedComponents?.collision&&isDeepStrictEqual(binding.derivedComponents.collision,collision))binding.derivedComponents.collision=structuredClone(entity.components.collision)
        changed=true
      }
      if(!entity.components.physicsBinding){
        const variant=collisionVariant(record,resolved)
        if(variant){
          let status='BOUND',reason:string|undefined
          try{await ensureCollisionArtifacts(this.resources,record,resolved)}catch(error){status='BIND_REQUIRED';reason=errorText(error)}
          entity.components.physicsBinding={resourceId:record.ref.resourceId,version:record.ref.version,status,...variant,derivedComponents:{collision:structuredClone(entity.components.collision),...entity.components.rigidBody?{rigidBody:structuredClone(entity.components.rigidBody)}:{}},...reason?{reason}:{}}
          changed=true
        }
      }
    }
    return changed
  }
  /** 显式恢复现Scene事实。读snapshot不暗写；失败资源默认只收终态，不悄悄重烘焙大件。 */
  async reconcilePhysics(input:{sceneId:string;expectedRevision?:number;retryFailed?:boolean;waitForPending?:boolean},signal?:AbortSignal):Promise<{snapshot:SceneSnapshot;changed:boolean;pending:boolean;worldNeedsSync:boolean;issues:Array<{entityId:string;resourceId?:string;version?:number;reason:string}>}>{
    signal?.throwIfAborted()
    const initial=await this.scene.snapshot(input.sceneId)
    if(input.expectedRevision!==undefined&&initial.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,initial.revision)
    const draft=structuredClone(initial),issues:Array<{entityId:string;resourceId?:string;version?:number;reason:string}>=[],follow:Array<()=>void>=[]
    await this.repairCollisionReferences(draft)
    let pending=false
    const completed=new Map<string,ResourceRecord>()
    for(const entity of draft.entities){
      signal?.throwIfAborted()
      if(entity.resources.length!==1)continue
      const binding=entity.components.physicsBinding as {resourceId?:string;version?:number;status?:string;reason?:string;usage?:PhysicalizeUsage;strategy?:PhysicalizeStrategy;voxelSizeM?:number;policy?:string}|undefined,ref=entity.resources[0]!
      if(!binding||binding.resourceId!==ref.resourceId||binding.version!==ref.version)continue
      let record=await this.resources.get(ref.resourceId,ref.version),repairBound=false
      const requested=resourcePhysicalizationOptions(record,{...binding.usage?{usage:binding.usage}:{},...binding.strategy?{strategy:binding.strategy}:{},...physicalizationBudgets(binding)})
      const variantKey=referenceKey(ref)+'|'+JSON.stringify(requested)
      record=completed.get(variantKey)??record
      const obsoleteEnvironment=requested.usage==='environment'&&requested.strategy==='auto'&&binding.policy!==PHYSICALIZATION_POLICY
      if(entity.components.collision){
        if(binding.status==='BOUND'||binding.status==='BIND_REQUIRED'){
          try{await ensureCollisionArtifacts(this.resources,record,(entity.components.collision.parts as string[]|undefined)??activeCollisionUris(this.resources,record));if(!obsoleteEnvironment)continue;repairBound=true}
          catch{repairBound=true}
        }else continue
      }
      let flight=pendingPhysicalization(this.resources,ref,requested)
      if(!flight&&(record.physicalization?.status==='ok'||repairBound||input.retryFailed===true&&record.physicalizationRequest!==false))flight=schedulePhysicalization(this.resources,ref,{...requested,...signal?{signal}:{}})
      if(flight){
        if(!input.waitForPending&&!input.retryFailed){
          pending=true
          const work=flight
          if(repairBound&&entity.components.collision){
            const baseline=(entity.components.physicsBinding as {derivedComponents?:Entity['components']}|undefined)?.derivedComponents?.collision
            if(!baseline||!sameDerivedPhysics('collision',entity.components.collision,baseline))throw Error('PHYSICS_BIND_CUSTOMIZED: 不覆盖用户碰撞，旧auto环境尚未确认安全')
            const enabled=entity.components.collision.enabled
            delete entity.components.collision
            entity.components.physicsBinding={...entity.components.physicsBinding as Record<string,unknown>,status:'PENDING',...typeof enabled==='boolean'?{pendingCollisionEnabled:enabled}:{}}
            repairBound=false
          }
          follow.push(()=>{void work.then(record=>this.completeImportedPhysics(input.sceneId,entity.entityId,ref,record,repairBound)).catch(error=>console.debug('物理恢复失败: '+errorText(error)))})
          continue
        }
        record=await flight??record;signal?.throwIfAborted()
      }
      completed.set(variantKey,record)
      if(record.physicalization?.status==='ok')await ensureCollisionArtifacts(this.resources,record,activeCollisionUris(this.resources,record))
      const patch=this.completionPatch(draft,entity.entityId,ref,record,repairBound)
      for(const op of patch)if(op.op==='update'){const at=draft.entities.findIndex(e=>e.entityId===op.entityId);draft.entities[at]={...draft.entities[at]!,...op.changes}}
      if(record.physicalization?.status!=='ok')issues.push({entityId:entity.entityId,resourceId:ref.resourceId,version:ref.version,reason:record.physicalization?.status==='pending'?'PHYSICS_DERIVATION_NOT_RUNNING: 本版本派生作业已不在运行，请在物理面板显式恢复':record.physicalization?.error??record.physicalization?.status??'未派生'})
    }
    // 多资源/多实例恢复一次Scene CAS，保留开始时版本。等待期间用户编辑即明确冲突，不覆新状态。
    const patch:ScenePatch=draft.entities.flatMap(entity=>{const old=initial.entities.find(e=>e.entityId===entity.entityId)!;return isDeepStrictEqual(entity,old)?[]:[{op:'update' as const,entityId:entity.entityId,changes:{components:entity.components,resources:entity.resources,transform:entity.transform}}]})
    const snapshot=patch.length?await this.scene.commit({sceneId:input.sceneId,expectedRevision:initial.revision,patch}):await this.scene.snapshot(input.sceneId)
    for(const followup of follow)followup()
    return {snapshot,changed:snapshot.revision!==initial.revision,pending:pending||snapshot.entities.some(e=>(e.components.physicsBinding as {status?:string}|undefined)?.status==='PENDING'),worldNeedsSync:snapshot.revision!==initial.revision,issues}
  }
  async bindPhysics(input:PhysicsBindInput,signal?:AbortSignal){
    signal?.throwIfAborted()
    validatePhysicsBindingType(input)
    const scene=await this.scene.snapshot(input.sceneId),entity=scene.entities.find(e=>e.entityId===input.entityId)
    if(scene.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,scene.revision)
    if(!entity||entity.resources.length!==1)throw Error('PHYSICS_BIND_RESOURCE_REQUIRED: 选择同版本mesh实例')
    const ref=entity.resources[0]!,verified=await this.resources.verify(ref.resourceId,ref.version)
    if(!verified.valid)throw Error('PHYSICS_BIND_ORIGINAL_UNVERIFIED: 原件或依赖缺失/变化，不从其它来源替换')
    const original=await this.resources.get(ref.resourceId,ref.version)
    validatePhysicalizationBudgets(input)
    const requested=resourcePhysicalizationOptions(original,{usage:input.usage,strategy:input.strategy,...physicalizationBudgets(input)})
    await this.resources.retainPhysicalizationRequest(ref.resourceId,ref.version,{usage:requested.usage,strategy:requested.strategy,...physicalizationBudgets(requested)})
    const record=await schedulePhysicalization(this.resources,ref,{...requested,...signal?{signal}:{}})??original
    if(record.physicalization?.status!=='ok')throw Error('PHYSICS_DERIVATION_FAILED: '+(record.physicalization?.status==='failed'?record.physicalization.error:'派生未完成'))
    const plan=planPhysicsBinding(scene,record,input);signal?.throwIfAborted()
    const snapshot=await this.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:plan.patch})
    return {status:'BOUND',snapshot,entityId:plan.rootEntityId,normalized:plan.normalized,maxMatrixDelta:plan.maxMatrixDelta,resource:{resourceId:ref.resourceId,version:ref.version},physics:record.physicalization,worldNeedsSync:true}
  }
  async updatePhysics(input:PhysicsUpdateInput){
    const scene=await this.scene.snapshot(input.sceneId)
    if(scene.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,scene.revision)
    const owner=physicsOwner(scene,input.entityId),ref=owner.resources.length===1?owner.resources[0]:undefined
    const record=ref?await this.resources.get(ref.resourceId,ref.version):undefined
    const plan=planPhysicsUpdate(scene,input,record?.componentDefaults?.rigidBody)
    const snapshot=plan.changed?await this.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:plan.patch}):await this.scene.snapshot(input.sceneId)
    if(!plan.changed&&snapshot.revision!==input.expectedRevision)throw new SceneConflict(input.sceneId,input.expectedRevision,snapshot.revision)
    return {status:plan.changed?'UPDATED':'UNCHANGED',snapshot,entityId:plan.entity.entityId,changed:plan.changed,physics:{rigidBody:plan.entity.components.rigidBody,collision:plan.entity.components.collision},worldNeedsSync:plan.changed}
  }
  /**
   * 挂载按 resourceId 保留资源默认组件（例如车辆 controller），实例的显式 components
   * 按组件键整体覆盖它——覆盖只作用于本次挂载的实体，不回写资源默认，也不逐字段
   * 混合出第二个控制 owner。visual/mujoco/articulation 始终从资源原件重新合成。
   * 调用方显式给 transform.position 时默认做落地对齐：实体包围盒底面贴到该高度，
   * 而不是把原点戳在命中点；alignBottomToSurface:false 恢复原点精确落位。
   */
  async mount(input: { sceneId: string; resourceId: string; version?: number; entityId?: string; parentId?: string; transform?: Transform; alignBottomToSurface?: boolean; components?: Entity["components"] },imported?:ResourceRecord): Promise<{ snapshot: SceneSnapshot; entityId: string }> {
    let resource = imported ?? await this.resources.get(input.resourceId, input.version)
    if(resource.ref.resourceId!==input.resourceId||input.version!==undefined&&resource.ref.version!==input.version)throw new Error("PHYSICS_BIND_RESOURCE_MISMATCH")
    if (resource.deletedAt) throw new Error("RESOURCE_IN_TRASH")
    const verification = await this.resources.verify(input.resourceId, resource.ref.version)
    if (!verification.valid) throw new Error(`RESOURCE_UNAVAILABLE: ${JSON.stringify(verification)}`)
    const requested=resourcePhysicalizationOptions(resource)
    let flight=resource.physicalizationRequest===false?undefined:pendingPhysicalization(this.resources,resource.ref,requested)
    const derivedDefaults=String(resource.componentDefaults?.collision?.source??'').startsWith('asset-bake-')
    if(derivedDefaults&&(resource.physicalizationRequest===false||!physicalizationMatchesRequest(resource,requested))){
      resource=structuredClone(resource)
      if(!resource.explicitComponentDefaultKeys?.includes('collision'))delete resource.componentDefaults?.collision
      if(!resource.explicitComponentDefaultKeys?.includes('rigidBody'))delete resource.componentDefaults?.rigidBody
    }
    if(resource.physicalization?.status==='ok'&&resource.physicalizationRequest!==false&&derivedDefaults){
      try{await ensureCollisionArtifacts(this.resources,resource,activeCollisionUris(this.resources,resource));if(resource.physicalization.usage==='environment'&&resource.physicalization.strategy==='auto'&&resource.physicalization.policy!==PHYSICALIZATION_POLICY)throw Error('PHYSICS_POLICY_OBSOLETE: 自动环境碰撞需要使用当前保腔策略')}
      catch{
        flight=schedulePhysicalization(this.resources,resource.ref,resourcePhysicalizationOptions(resource))
        resource=structuredClone(resource)
        if(!resource.explicitComponentDefaultKeys?.includes('collision'))delete resource.componentDefaults?.collision
        if(!resource.explicitComponentDefaultKeys?.includes('rigidBody'))delete resource.componentDefaults?.rigidBody
        resource.physicalization={status:'pending',...resourcePhysicalizationOptions(resource)}
      }
    }
    const entityId = input.entityId ?? `entity_${randomUUID()}`
    let entities: Entity[]
    let transform=input.transform??resource.mountTransform
    if(input.alignBottomToSurface!==false&&input.transform?.position&&transform){
      // 落地对齐优先用碰撞产物包围盒（物理基准，含凸包/盒组真实外形）；物理化未完成或无产物时退回视觉 aabb。
      // 泼溅件现在也带 aabb（formats.ts 解码自身点云），落地对齐一视同仁；仍以碰撞产物包围盒优先。
      const bounds=resource.physicalization?.collisionBounds??assetBounds(resource.parsed,resource.ref.source)
      if(!bounds)throw new Error(`PROTOTYPE_BOUNDS_UNAVAILABLE: 资源 ${input.resourceId}@${resource.ref.version} 没有可用的几何包围盒，默认的"底面贴到 position 高度"无法执行——造型/底面/尺度都不可判定，因此不把这份原型复制进场景（ENV-21：原型不通过不铺开）。可采取的动作：先核对原型原件（几何范围/底面/法线/材质/尺度）后重新导入；确实要按原点精确落位时显式传 alignBottomToSurface:false。`)
      const matrix=new Matrix4().compose(new Vector3(),new Quaternion(...transform.quaternion),new Vector3(...transform.scale))
      let lift=Infinity
      for(const x of [bounds.min[0],bounds.max[0]])for(const y of [bounds.min[1],bounds.max[1]])for(const z of [bounds.min[2],bounds.max[2]])lift=Math.min(lift,new Vector3(x,y,z).applyMatrix4(matrix).z)
      transform={...transform,position:[transform.position[0],transform.position[1],transform.position[2]-lift]}
    }
    const defaults = resource.componentDefaults ? structuredClone(resource.componentDefaults) : {}
    if (resource.parsed.kind === "mesh") {
      entities = glbEntities(resource.ref, resource.parsed, entityId, resource.name, transform)
      if (resource.componentDefaults || input.components) entities[0]!.components = { ...entities[0]!.components, ...defaults, ...(input.components ? structuredClone(input.components) : {}) }
    }
    else {
      const provided = { ...defaults, ...(input.components ? structuredClone(input.components) : {}) }
      const components: Entity["components"] = { ...provided, visual: { ...provided.visual, kind: resource.parsed.kind } }
      if (resource.parsed.kind === "robot") {
        const sourcePath = localPath(resource.ref.original.uri)
        if (resource.parsed.metadata.format === "mjcf") components.mujoco = { sourcePath }
        components.articulation = { ...provided.articulation, source: resource.ref.original, format: resource.parsed.metadata.format }
        components.visual = { ...components.visual, robot: await robotVisual(sourcePath) }
      }
      entities = [{ entityId, name: resource.name, transform: transform ?? identityTransform(), resources: [resource.ref], components }]
      if (resource.parsed.kind === "splat") {
        // 可信绑定以外仍保持纯视觉，不从公开 SSOG 猜碰撞。
        applySplatMountFacts(resource, components)
      }
    }
    if(resource.physicalization?.status==='ok'&&entities[0]!.components.collision && isDeepStrictEqual(entities[0]!.components.collision,resource.componentDefaults?.collision))entities[0]!.components.physicsBinding=physicsBindingFacts(resource)
    else if(resource.physicalizationRequest!==false&&!entities[0]!.components.collision&&(resource.physicalization||flight)){
      const pending=flight!==undefined
      if(resource.physicalization?.status!=='skipped')entities[0]!.components.physicsBinding={resourceId:resource.ref.resourceId,version:resource.ref.version,status:pending?'PENDING':'BIND_REQUIRED',usage:requested.usage,strategy:requested.strategy,...physicalizationBudgets(requested),...!pending?{reason:resource.physicalization?.error??'PHYSICS_DERIVATION_NOT_RUNNING: 派生作业未运行，请显式恢复同版本碰撞'}:{}}
    }
    if (input.parentId) entities[0]!.parentId = input.parentId
    const current = await this.scene.snapshot(input.sceneId)
    const snapshot = await this.scene.commit({ sceneId: input.sceneId, expectedRevision: current.revision, patch: entities.map(entity => ({ op: "add", entity })) })
    if(flight&&!entities[0]!.components.collision)void flight.then(record=>this.completeImportedPhysics(input.sceneId,entityId,resource.ref,record)).catch(error=>console.debug('自动物理绑定失败: '+errorText(error)))
    return { snapshot, entityId }
  }

  /** 同一公开 SSOG 层：资源全部已登记/核对后，一次 CAS 挂一个组根及每块各一可视子实体。 */
  async mountSogCollection(input: { sceneId: string; name: string; entityId?: string; parentId?: string; transform?: Transform; resources: Array<{ resourceId: string; version: number; name: string }> }, signal?: AbortSignal): Promise<{ snapshot: SceneSnapshot; groupEntityId: string; entityIds: string[] }> {
    signal?.throwIfAborted()
    if (!input.resources.length) throw new Error("SSOG_COLLECTION_EMPTY: 无可挂载资源")
    const current = await this.scene.snapshot(input.sceneId)
    const groupEntityId = input.entityId ?? `entity_${randomUUID()}`
    const group: Entity = {
      entityId: groupEntityId, name: input.name, ...(input.parentId ? { parentId: input.parentId } : {}),
      transform: input.transform ?? identityTransform(), resources: [], components: { visual: { kind: "group" } },
    }
    const children: Entity[] = []
    for (const item of input.resources) {
      signal?.throwIfAborted()
      const resource = await this.resources.get(item.resourceId, item.version)
      if (resource.deletedAt || resource.parsed.kind !== "splat") throw new Error(`SSOG_RESOURCE_UNAVAILABLE: ${item.resourceId}@${item.version}`)
      const verified = await this.resources.verify(item.resourceId, item.version)
      signal?.throwIfAborted()
      if (!verified.valid) throw new Error(`SSOG_RESOURCE_VERIFY_FAILED: ${item.resourceId}@${item.version}`)
      const components: Entity["components"] = { visual: { kind: "splat" } }
      applySplatMountFacts(resource, components)
      children.push({
        entityId: `entity_${randomUUID()}`, parentId: groupEntityId, name: `${input.name} · ${item.name}`,
        transform: identityTransform(), resources: [resource.ref], components,
      })
    }
    signal?.throwIfAborted() // 只在 CAS 前拦停止；CAS 已成功后返回真实提交，绝不假装回滚。
    const snapshot = await this.scene.commit({
      sceneId: input.sceneId, expectedRevision: current.revision,
      patch: [group, ...children].map(entity => ({ op: "add" as const, entity })),
    })
    return { snapshot, groupEntityId, entityIds: children.map(item => item.entityId) }
  }
  /**
   * ENV-29 场景局部资源替换：把既有实体的资源引用指向资源库中另一个已登记版本（或另一资源）。
   * entityId、name、transform、parentId、用户组件与无关实体保持不变；patch 只发 `update`，
   * 与 mount 的 `add` 分工明确，两者不能互相冒充。文档写入只有一处：
   * `SceneStore.commit` 的 expectedRevision CAS，所有拒绝都发生在提交之前，不产生半提交。
   *
   * 由资源派生的组件分两类处理，判据是**原件字节里的几何事实**（逐节点顶点位置集合 + 三角面
   * 多重集合，量化 1e-6 m），不是 bbox 相同、也不是调用方自称"没改几何"：
   * - collision/rigidBody/controller：几何逐节点一致（材质/贴图这类视觉更新）时旧值仍然适配，
   *   原样保留；几何确实变了就按目标资源已登记的派生默认**原位重派生**（只改这些组件，不碰用户组件），
   *   派生未就绪时报 "REPLACE_RESOURCE_PHYSICS_NOT_DERIVED" 并说明待办，绝不留下"文档新、物理旧"。
   * - articulation/mujoco/isaac 与 visual.robot 由机器人原生文档派生，没有可比对的 GLB 几何事实，
   *   仍然一律拒绝，走重建挂载（mount 会按新资源重新派生）。
   *
   * 其余明确边界（同样一律拒绝而不静默处理）：
   * - GLB 展开组以“组根实体”为单位替换。组身份 = `${rootId}:source` / `${rootId}:node:<index>`
   *   这个 ID 命名空间，所以同一资源在别处挂载的实例（另一个组根 + 它自己的派生节点）不在本次范围，
   *   原样保留；命名空间内有实体不在组根子树里（被移出组）时拒绝，避免同一组混用两个版本。
   * - 目标版本的展开结构（节点集合、父子关系）必须与文档一致，绝不增删子节点。
   * - 节点局部变换是导入布局（`sourceTransformApplied:true` 已把源坐标烘焙进节点变换），
   *   用户也可能移动过节点：目标版本节点变换不同时无法无损映射（保留旧值=新网格配旧布局，
   *   采用新值=可能丢掉用户的移动），因此拒绝，由重建挂载处理。节点名/gltf.extras 分歧只报 warning。
   * - 派生节点、`:source` 节点不能作为替换入口。
   * - 视觉类型必须与目标资源一致（group→mesh、mesh→mesh、splat→splat、robot→robot）；换类型等于重建挂载。
   * - 新版本改变源坐标转换（轴/手性/单位）时拒绝，避免引用指向新文件而显示仍按旧轴。
   */
  async replaceResource(input: ReplaceResourceInput): Promise<ReplaceResourceResult> {
    const sceneId = safeId(input.sceneId), entityId = safeId(input.entityId)
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("INVALID_REVISION")
    const resourceId = safeId(input.resourceId)
    const fromResourceId = input.fromResourceId === undefined ? undefined : safeId(input.fromResourceId)
    for (const [label, version] of [["version", input.version], ["fromVersion", input.fromVersion]] as const) {
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error(`INVALID_RESOURCE_VERSION: ${label}=${String(version)}`)
    }
    const snapshot = await this.scene.snapshot(sceneId)
    // 先按观察到的版本快速失败；即使之后有人提交，提交点的 CAS 仍会再拒一次。
    if (snapshot.revision !== input.expectedRevision) throw new SceneConflict(sceneId, input.expectedRevision, snapshot.revision)
    const entity = snapshot.entities.find(item => item.entityId === entityId)
    if (!entity) throw new Error(`ENTITY_NOT_FOUND: ${entityId}`)
    // 派生节点 `X:node:N` / `X:source` 只承载组内一个节点；单独替换会让同组其它实体仍指旧版本。
    if (gltfNodeIndex(entity) !== undefined || (entity.entityId === `${entity.parentId ?? ""}:source` && entity.resources.length === 0)) {
      throw new Error(`REPLACE_RESOURCE_GROUP_ROOT_REQUIRED: ${entityId} 是资源展开的派生节点，请用它所属的组根实体发起替换`)
    }
    const distinct = new Map<string, ResourceRef>()
    for (const ref of entity.resources) if (!distinct.has(referenceKey(ref))) distinct.set(referenceKey(ref), ref)
    let selected: ResourceRef
    if (fromResourceId !== undefined || input.fromVersion !== undefined) {
      const matches = [...distinct.values()].filter(ref => (fromResourceId === undefined || ref.resourceId === fromResourceId) && (input.fromVersion === undefined || ref.version === input.fromVersion))
      if (!matches.length) throw new Error(`ENTITY_RESOURCE_NOT_FOUND: ${entityId} 未引用 ${fromResourceId ?? resourceId}@${input.fromVersion ?? "任意版本"}`)
      if (matches.length > 1) throw new Error(`REPLACE_RESOURCE_TARGET_AMBIGUOUS: ${entityId} 有多个匹配引用（${matches.map(referenceKey).join(", ")}），请同时给出 fromResourceId 与 fromVersion`)
      selected = matches[0]!
    } else {
      if (!distinct.size) throw new Error(`ENTITY_RESOURCE_NOT_FOUND: ${entityId} 没有资源引用`)
      if (distinct.size > 1) throw new Error(`REPLACE_RESOURCE_TARGET_REQUIRED: ${entityId} 引用 ${[...distinct.keys()].join(", ")}，请用 fromResourceId/fromVersion 指定要替换的那一条`)
      selected = [...distinct.values()][0]!
    }
    // 目标必须是已登记、未进回收站、字节仍可核对的版本；未登记的 resourceId/version 由资源库明确报错。
    const record = await this.resources.get(resourceId, input.version)
    if (record.deletedAt) throw new Error(`RESOURCE_IN_TRASH: ${record.ref.resourceId}@${record.ref.version}`)
    const verification = await this.resources.verify(resourceId, record.ref.version)
    if (!verification.valid) throw new Error(`RESOURCE_UNAVAILABLE: ${JSON.stringify(verification)}`)
    const targetRef = structuredClone(record.ref), targetKind = record.parsed.kind, key = referenceKey(selected)
    // 视觉类型必须与目标资源一致：换类型等于换结构（GLB 组 ↔ 单实体），要重建挂载而不是换引用。
    const kind = visualKind(entity), requiredKind = kind === undefined ? undefined : REQUIRED_TARGET_KIND[kind]
    if (requiredKind !== undefined && targetKind !== requiredKind) throw new Error(`REPLACE_RESOURCE_KIND_MISMATCH: 实体视觉类型 ${kind} 需要 ${requiredKind} 资源，目标 ${referenceKey(targetRef)} 是 ${targetKind}；换类型要重建挂载`)

    const children = new Map<string, Entity[]>()
    for (const item of snapshot.entities) if (item.parentId !== undefined) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
    const subtree = new Set([entityId])
    const pending = [entityId]
    while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!subtree.has(child.entityId)) { subtree.add(child.entityId); pending.push(child.entityId) }
    // 组身份按 ID 命名空间界定（导入时由 glbEntities 生成）：同一资源的其它实例用别的组根，
    // 它们的派生节点不落在本命名空间里，因此不会被当成"本组混版"而误拒。
    const group = snapshot.entities.filter(item => item !== entity && item.entityId.startsWith(`${entityId}:`))
    const orphans = group.filter(item => !subtree.has(item.entityId))
    if (orphans.length) throw new Error(`REPLACE_RESOURCE_GROUP_INCOMPLETE: ${orphans.map(item => item.entityId).join(", ")} 属于 ${entityId} 的派生命名空间但不在它的子树里（可能被移出组），整组替换会让同一组混用两个版本`)
    const nodeEntities = group.filter(item => gltfNodeIndex(item) !== undefined)
    const sourceNode = group.find(item => item.entityId === `${entityId}:source`)
    // 实体（与组内派生节点）上携带的资源派生组件。原生文档派生的（articulation/mujoco/isaac/visual.robot）
    // 没有可核对的 GLB 几何事实，一律拒绝；只带几何派生组件的走下面的几何核对。
    const derivedCarriers = [entity, ...group].map(carrier => ({
      carrier,
      names: [...RESOURCE_DERIVED_COMPONENTS.filter(name => carrier.components[name] !== undefined), ...(carrier.components.visual?.robot !== undefined ? ["visual.robot"] : [])],
    })).filter(item => item.names.length)
    const nativeCarriers = derivedCarriers.filter(item => item.names.some(name => !GEOMETRY_DERIVED_COMPONENTS.includes(name)))
    if (nativeCarriers.length) throw new Error(`REPLACE_RESOURCE_UNSUPPORTED_COMPONENTS: ${nativeCarriers.map(item => `${item.carrier.entityId} 携带由旧原件派生的 [${item.names.join(", ")}]`).join("；")}，这些组件由机器人原生文档/引擎映射派生，没有可比对的几何事实；本片只支持纯视觉实体，或只带 [${GEOMETRY_DERIVED_COMPONENTS.join(", ")}] 且几何事实可核对的替换，请重建挂载`)
    const expansionWarnings: string[] = []
    if (nodeEntities.length || sourceNode) {
      // 组内（派生节点）必须都引用同一条被替换的引用；缺一条就说明文档已不是该资源的展开结果。
      const strays = nodeEntities.filter(item => !item.resources.some(ref => referenceKey(ref) === key))
      if (strays.length) throw new Error(`REPLACE_RESOURCE_GROUP_INCOMPLETE: ${strays.map(item => item.entityId).join(", ")} 未引用 ${key}，不能整组替换`)
      for (const item of nodeEntities) if (item.entityId !== `${entityId}:node:${gltfNodeIndex(item)}`) throw new Error(`REPLACE_RESOURCE_STRUCTURE_MISMATCH: ${item.entityId} 的 ID 与 gltfNode ${gltfNodeIndex(item)} 不自洽`)
      let expansion: Entity[] = []
      if (targetKind === "mesh") {
        try { expansion = glbEntities(targetRef, record.parsed, entityId, entity.name, entity.transform) }
        catch (error) { throw new Error(`REPLACE_RESOURCE_STRUCTURE_MISMATCH: ${entityId} 是 GLB 展开组，目标 ${referenceKey(targetRef)} 无法展开（${String(error instanceof Error ? error.message : error)}）`) }
      }
      const expected = new Map(expansion.filter(item => item.entityId !== entityId).map(item => [item.entityId, item]))
      const documentIds = [...nodeEntities.map(item => item.entityId), ...(sourceNode ? [sourceNode.entityId] : [])]
      const missing = documentIds.filter(id => !expected.has(id)), added = [...expected.keys()].filter(id => !documentIds.includes(id))
      if (missing.length || added.length) throw new Error(`REPLACE_RESOURCE_STRUCTURE_MISMATCH: ${entityId} 现有派生节点 ${documentIds.length} 个，目标 ${referenceKey(targetRef)} 展开 ${expected.size} 个；缺失 [${missing.join(", ")}] 新增 [${added.join(", ")}]。结构不同请重建挂载，不在这里增删子节点`)
      for (const item of [...nodeEntities, ...(sourceNode ? [sourceNode] : [])]) {
        const wanted = expected.get(item.entityId)!
        if (wanted.parentId !== item.parentId) throw new Error(`REPLACE_RESOURCE_STRUCTURE_MISMATCH: ${item.entityId} 的父节点是 ${item.parentId}，目标版本展开为 ${wanted.parentId}`)
      }
      // 节点局部变换是导入布局（也可能被用户移动过）：目标版本不同既不能保留旧值（新网格配旧布局会错形），
      // 也不能悄悄采用新值（会丢掉用户的移动），一律拒绝。节点名与 gltf.extras 不参与几何，分歧只报 warning。
      for (const item of nodeEntities) {
        const wanted = expected.get(item.entityId)!
        if (!sameTransform(wanted.transform, item.transform)) throw new Error(`REPLACE_RESOURCE_NODE_TRANSFORM_MISMATCH: ${item.entityId} 的文档局部变换与目标 ${referenceKey(targetRef)} 的节点变换不同，无法无损映射（保留旧值会错形，采用新值可能丢掉用户的移动），请重建挂载`)
        if (wanted.name !== item.name) expansionWarnings.push(`REPLACE_RESOURCE_NODE_NAME_DIVERGED: ${item.entityId} 保留「${item.name}」，目标版本节点名为「${wanted.name}」`)
        if (!isDeepStrictEqual(wanted.components["gltf.extras"], item.components["gltf.extras"])) expansionWarnings.push(`REPLACE_RESOURCE_NODE_EXTRAS_DIVERGED: ${item.entityId} 保留文档 gltf.extras，与目标版本不同`)
      }
    }
    const sourceOf = (ref: ResourceRef, where: string): Transform => {
      try { return sourceTransform(ref.source) }
      catch (error) { throw new Error(`REPLACE_RESOURCE_COORDINATE_UNVERIFIABLE: ${where} 的源坐标声明无法换算（${String(error instanceof Error ? error.message : error)}）`) }
    }
    if (sourceNode && (kind === "group" || kind === "mesh") && !sameTransform(sourceOf(targetRef, referenceKey(targetRef)), sourceNode.transform)) {
      throw new Error(`REPLACE_RESOURCE_COORDINATE_MISMATCH: ${sourceNode.entityId} 承载的源坐标转换与目标 ${referenceKey(targetRef)} 的声明不同（轴/手性/单位变化会让既有节点变换失效），请重建挂载或显式修正`)
    }
    for (const carrier of [entity, ...nodeEntities]) {
      const visual = carrier.components.visual
      // sourceTransformApplied 的实体（GLB 节点）轴已烘焙进节点变换；带显式 sourceTransform 的实体保留自己的包装。
      if (!visual || visual.sourceTransformApplied === true || visual.sourceTransform !== undefined) continue
      if (!SOURCE_TRANSFORM_KINDS.includes(visualKind(carrier) ?? "")) continue
      const current = carrier.resources.find(ref => referenceKey(ref) === key)
      if (current && !sameTransform(sourceOf(current, referenceKey(current)), sourceOf(targetRef, referenceKey(targetRef)))) {
        throw new Error(`REPLACE_RESOURCE_COORDINATE_MISMATCH: ${carrier.entityId} 没有自己的源坐标转换节点，替换后轴/单位会静默变化（${referenceKey(current)} → ${referenceKey(targetRef)}）`)
      }
    }
    const warnings = [...expansionWarnings]
    /**
     * 几何派生组件（collision/rigidBody/controller）的处置。判据是**原件字节里的实际几何事实**
     * （逐节点顶点位置集合 + 三角面多重集合，实体本地米制；节点全部祖先 TRS/matrix 与源坐标换算
     * 都已计入）：bbox 相同不算、模型自称没改几何不算、只读顶点数组更不算——只改内部节点位姿/缩放
     * 的新版本在画面里已经移位/变形，必须按"几何已变"处理。
     * 一致 → 视觉更新（材质/贴图），旧派生组件仍然适配，原样保留；
     * 不一致 → 旧值已经不适配，按目标资源的派生默认原位重派生；派生未就绪就明确报状态，不假装成功。
     */
    let geometry: ReplaceResourceResult["geometry"], physics: ReplaceResourceResult["physics"]
    /** 几何变化时按目标资源默认原位更新的实体组件（patch 用）。 */
    const rederived = new Map<string, Record<string, unknown>>()
    const geometryCarriers = derivedCarriers.filter(item => !nativeCarriers.includes(item))
    if (geometryCarriers.length) {
      const components = [...new Set(geometryCarriers.flatMap(item => item.names))]
      const oldVerification = await this.resources.verifyReference(selected).catch(error => {
        throw new Error(`REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE: 旧引用 ${key} 不在资源库里（${errorText(error)}），无法按登记字节核对几何；几何派生组件 [${components.join(", ")}] 不能在没有几何事实的情况下沿用，请先恢复该资源或重建挂载`)
      })
      if (!oldVerification.valid) throw new Error(`REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE: 旧引用 ${key} 的原件已不可核对（${JSON.stringify(oldVerification)}），无法证明新版本几何未变；几何派生组件 [${components.join(", ")}] 不能沿用旧值，请先恢复原件或重建挂载`)
      const from = await this.geometryFacts(selected, key, components)
      const to = await this.geometryFacts(targetRef, referenceKey(targetRef), components)
      const comparison = compareGlbGeometry(from, to)
      geometry = {
        status: comparison.identical ? "identical" : "changed",
        nodes: from.nodes.size, vertices: from.vertexCount, triangles: from.triangleCount,
        fromDigest: from.digest, toDigest: to.digest, frame: from.frame,
        fromBounds: from.bounds, toBounds: to.bounds,
      }
      const targetDefaults = record.componentDefaults ?? {}
      if (comparison.identical) {
        physics = { mode: "kept", components, basis: `geometry-identical nodes=${from.nodes.size} vertices=${from.vertexCount} triangles=${from.triangleCount} frame=${from.frame}` }
        const carriersOf = (name: string) => geometryCarriers.filter(item => item.carrier.components[name] !== undefined)
        for (const name of components) {
          // 目标版本自带同名派生默认时如实报分歧：几何一致，实体现值（可能被用户调过）优先，本次不改写。
          if (targetDefaults[name] !== undefined && carriersOf(name).some(item => !isDeepStrictEqual(targetDefaults[name], item.carrier.components[name]))) {
            warnings.push(`REPLACE_RESOURCE_PHYSICS_DIVERGED: 目标 ${referenceKey(targetRef)} 的派生 ${name} 与实体现值不同（几何逐节点一致），本次保留实体现值、未改写`)
          }
        }
        const absent = components.filter(name => targetDefaults[name] === undefined)
        if (absent.length) warnings.push(`REPLACE_RESOURCE_PHYSICS_KEPT: ${geometryCarriers.map(item => item.carrier.entityId).join(", ")} 的 [${absent.join(", ")}] 由旧原件派生，目标 ${referenceKey(targetRef)} 没有可用的重派生值（physicalization.status=${record.physicalization?.status ?? "none"}${record.physicalization?.error ? `：${record.physicalization.error}` : ""}）；本次几何逐节点核对一致（节点 ${from.nodes.size}、顶点 ${from.vertexCount}、三角面 ${from.triangleCount}），旧值仍然适配，原样保留`)
      } else {
        // 几何确实变了：旧碰撞/刚体/控制不再适配。只允许按目标资源已登记的派生默认原位替换；
        // 用户改过的值不覆盖、目标没派生就报清晰的待办，都不留下"文档新、物理旧"的场景。
        const oldRecord = await this.resources.recordFor(selected)
        const oldDefaults = oldRecord?.componentDefaults ?? {}
        const customized: string[] = [], missing: string[] = []
        for (const { carrier, names } of geometryCarriers) for (const name of names) {
          const binding=carrier.components.physicsBinding as Record<string,unknown>|undefined
          const baseline=binding?.resourceId===selected.resourceId&&binding?.version===selected.version?(binding.derivedComponents as Entity['components']|undefined)??oldDefaults:oldDefaults
          if (!Object.hasOwn(baseline, name) || !sameDerivedPhysics(name,carrier.components[name],baseline[name])) customized.push(`${carrier.entityId}.${name}`)
          else if (!Object.hasOwn(targetDefaults, name)) missing.push(`${carrier.entityId}.${name}`)
          else rederived.set(carrier.entityId, { ...(rederived.get(carrier.entityId) ?? {}), [name]: preservePhysicsControls(name,targetDefaults[name] as Record<string,unknown>,carrier.components[name] as Record<string,unknown>,baseline[name] as Record<string,unknown>) })
        }
        if (customized.length) throw new Error(`REPLACE_RESOURCE_DERIVED_COMPONENT_CUSTOMIZED: ${customized.join(", ")} 与旧版本 ${key} 登记的派生默认不同（用户/场景改过），几何已变（${comparison.reason}），替换会丢掉这些改动；请先显式撤销自定义，或重建挂载`)
        if (missing.length) {
          // 派生未就绪：沿既有物理化机制排一次（导入时显式 physicalize:false 的版本不自动重跑），并如实报状态。
          const skipped = record.physicalizationRequest===false || record.physicalization?.status === "skipped"
          // 重派生必须带**这个资源版本上已经明确记录过的**用途/策略/体素边长：environment 的构件不能因为
          // 排一次重试就退回 dynamic（那会把内部空腔填实、把房间/通道封死）。记录里没有意图的旧版本不替它
          // 猜用途，沿用旧缺省（dynamic）——这里只搬既有记录，不引入第二个状态源。
          if (!skipped) void schedulePhysicalization(this.resources,targetRef,resourcePhysicalizationOptions(record)).catch(error=>console.debug('替换物理派生失败: '+errorText(error)))
          throw new Error(`REPLACE_RESOURCE_PHYSICS_NOT_DERIVED: 几何已变（${comparison.reason}），而目标 ${referenceKey(targetRef)} 尚未派生 [${missing.map(item => item.split(".").pop()).join(", ")}]（physicalization.status=${record.physicalization?.status ?? "none"}${record.physicalization?.error ? `：${record.physicalization.error}` : ""}）；不能用旧碰撞冒充新几何。${skipped ? "该版本导入时声明了 physicalize:false，请显式派生（asset_bake）后再替换" : "已按既有派生机制排队重派生，稍后重试即可"}；也可以直接重建挂载`)
        }
        physics = { mode: "rederived", components: [...new Set([...rederived.values()].flatMap(value => Object.keys(value)))], basis: `resource-defaults ${referenceKey(targetRef)} geometry-changed nodes=${from.nodes.size} vertices=${from.vertexCount}→${to.vertexCount} triangles=${from.triangleCount}→${to.triangleCount}` }
        warnings.push(`REPLACE_RESOURCE_PHYSICS_REDERIVED: 几何已变（${comparison.reason}），实体的 [${physics.components.join(", ")}] 已按目标资源 ${referenceKey(targetRef)} 的派生默认原位更新；重派生值即该资源物理化/登记的产物`)
      }
    }
    // 目标资源自带资源默认组件（如物理化产物）时如实说明：替换只改引用、不重放默认，
    // 需要这些能力请重建挂载；不把它说成"已完整替换"。几何派生组件已由上面的核对分支处理，不重复报。
    const defaultKeys = Object.keys(record.componentDefaults ?? {}).filter(name => (name === "visual" || RESOURCE_DERIVED_COMPONENTS.includes(name)) && !physics?.components.includes(name))
    if (defaultKeys.length) warnings.push(`REPLACE_RESOURCE_DEFAULTS_NOT_APPLIED: 目标 ${referenceKey(targetRef)} 带资源默认组件 [${defaultKeys.join(", ")}]，替换只改引用、不重放默认；需要这些能力请重建挂载`)
    // 引用同一条资源版本、但不属于本组的实体（同一资源的其它实例、独立引用）：保持不动，只记警告。
    const others = snapshot.entities.filter(item => item !== entity && !group.includes(item) && item.resources.some(ref => referenceKey(ref) === key))
    if (others.length) {
      const listed = others.slice(0, 6).map(item => item.entityId).join(", ")
      warnings.push(`REPLACE_RESOURCE_OTHER_REFERENCES_UNCHANGED: ${listed}${others.length > 6 ? ` 等 ${others.length} 个实体` : ""} 仍引用 ${key}（其它实例/独立引用，本次不改动）`)
    }
    if (targetRef.resourceId === selected.resourceId && targetRef.version < selected.version) warnings.push(`REPLACE_RESOURCE_DOWNGRADE: ${targetRef.resourceId} ${selected.version} → ${targetRef.version}`)

    const patch: ScenePatch = [], entityIds: string[] = []
    for (const carrier of [entity, ...nodeEntities]) {
      const changes: Partial<Omit<Entity, "entityId" | "parentId">> = {}
      const resources = carrier.resources.map(ref => referenceKey(ref) === key ? structuredClone(targetRef) : ref)
      if (!isDeepStrictEqual(resources, carrier.resources)) changes.resources = resources
      // 几何变化时的重派生只改派生组件本身（原位、同实体），其它用户组件逐字保留。
      const updates = rederived.get(carrier.entityId)
      if (updates) changes.components = { ...carrier.components, ...updates }
      const currentBinding=carrier.components.physicsBinding as Record<string,unknown>|undefined
      if(currentBinding?.resourceId===selected.resourceId&&currentBinding?.version===selected.version){
        const binding=geometry?.status==='changed'?physicsBindingFacts(record):{...currentBinding,resourceId:targetRef.resourceId,version:targetRef.version}
        changes.components={...(changes.components??carrier.components),physicsBinding:binding}
      }
      if (targetKind === "splat" && carrier.components.visual?.kind === "splat" && carrier.resources.some(ref => referenceKey(ref) === key)) {
        // 缓存属于资源版本；仅刷新预览数值，不重放源坐标转换或其它用户/物理组件。
        const components = structuredClone(changes.components ?? carrier.components)
        if (carrier.resources.every(ref => referenceKey(ref) === key)) applySplatPreviewFacts(record, components.visual!)
        else {
          // 多源实体不能把选中的另一份资源误作当前基础视觉；让 Viewer 从实际数据源分片重算。
          delete components.visual!.sourceBounds; delete components.visual!.sourcePointCount
        }
        if (!isDeepStrictEqual(components, carrier.components)) changes.components = components
      }
      if (Object.keys(changes).length) { patch.push({ op: "update", entityId: carrier.entityId, changes }); entityIds.push(carrier.entityId) }
    }
    if (!patch.length) {
      // 无写入也要确认此刻的 revision：解析资源期间别人可能已提交，不能把旧快照当当前结果交回。
      const fresh = await this.scene.snapshot(sceneId)
      if (fresh.revision !== input.expectedRevision) throw new SceneConflict(sceneId, input.expectedRevision, fresh.revision)
      return { sceneId, entityId, revision: fresh.revision, changed: false, entityIds, from: { resourceId: selected.resourceId, version: selected.version, uri: selected.original.uri }, to: { resourceId: targetRef.resourceId, version: targetRef.version, uri: targetRef.original.uri }, ...(geometry ? { geometry } : {}), ...(physics ? { physics } : {}), warnings: [...warnings, `REPLACE_RESOURCE_UNCHANGED: ${entityId} 已引用 ${referenceKey(targetRef)}，未写入新 revision`], snapshot: fresh }
    }
    const committed = await this.scene.commit({ sceneId, expectedRevision: input.expectedRevision, patch })
    return { sceneId, entityId, revision: committed.revision, changed: true, entityIds, from: { resourceId: selected.resourceId, version: selected.version, uri: selected.original.uri }, to: { resourceId: targetRef.resourceId, version: targetRef.version, uri: targetRef.original.uri }, ...(geometry ? { geometry } : {}), ...(physics ? { physics } : {}), warnings, snapshot: committed }
  }
  /**
   * 按引用实际指向的原件字节算几何事实。读不出来（没有视觉 GLB、外部 buffer、非三角面图元、
   * 坐标非有限…）一律报"不可核对"：绝不退回 bbox 之类的弱证据，也绝不放行。
   */
  private async geometryFacts(ref: ResourceRef, where: string, components: string[]): Promise<GlbGeometryFacts> {
    const detail = `几何派生组件 [${components.join(", ")}] 不能在没有实际几何事实的情况下沿用（读的是实体本地米制、含节点层级世界变换与源坐标换算的位置集合）`
    const uri = visualGeometryUri(ref)
    if (!uri) throw new Error(`REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE: ${where} 的引用里没有可核对的视觉 GLB（现有表示：[${[ref.original, ...ref.representations].map(rep => rep.mimeType).join(", ")}]），${detail}；请重建挂载`)
    try { return glbGeometryFacts(await readFile(localPath(uri)), { source: ref.source }) }
    catch (error) { throw new Error(`REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE: ${where} 的视觉 GLB 实际几何读不出（${errorText(error)}），${detail}；请重建挂载`) }
  }
  async completeResourceSources(snapshot: SceneSnapshot): Promise<SceneSnapshot> {
    if (!snapshot.entities.some(entity => entity.resources.some(ref => ref.source === undefined))) return snapshot
    const result = structuredClone(snapshot)
    for (const entity of result.entities) for (const ref of entity.resources) {
      if (ref.source !== undefined) continue
      const record = await this.resources.recordFor(ref)
      if (!record?.ref.source) throw new Error('SCENE_RESOURCE_SOURCE_UNAVAILABLE: 旧场景引用缺少同版本已验源信息')
      ref.source = structuredClone(record.ref.source)
    }
    return result
  }
  async inspect(sceneId: string): Promise<SceneSnapshot> { return this.completeResourceSources(await this.scene.snapshot(sceneId)) }
  /** 正常 CAS 新版本修复旧引用；历史保留旧文档，已有源声明和实例变换不变。 */
  async repairResourceSources(sceneId: string): Promise<SceneSnapshot> {
    const current = await this.scene.snapshot(sceneId)
    const complete = await this.completeResourceSources(current)
    if (complete === current) return current
    const patch = complete.entities.filter((entity,index) => current.entities[index]!.resources.some(ref => ref.source === undefined))
      .map(entity => ({ op: 'update' as const, entityId: entity.entityId, changes: { resources: entity.resources } }))
    try { return await this.scene.commit({sceneId, expectedRevision:current.revision, patch}) }
    catch (error) {
      if (!(error instanceof SceneConflict)) throw error
      // 并发编辑获胜；读取最新版本，不回写旧位姿，也不循环重试。
      return this.inspect(sceneId)
    }
  }
  versions(sceneId: string) { return this.scene.versions(sceneId) }
  /** Resource Authority 管理面入口与 Tools 共用，避免 UI/命令各自维护状态。 */
  assetAuthoritySnapshot() { return this.resources.authoritySnapshot() }
  assetAuthorityRecover() { return this.resources.recoverResourceAuthorityOperations() }
  assetMove(input: Parameters<ResourceLibrary['move']>[0]) { return this.resources.move(input) }
  assetTrash(input: Parameters<ResourceLibrary['trash']>[0]) { return this.resources.trash(input) }
  assetRestore(input: Parameters<ResourceLibrary['restore']>[0]) { return this.resources.restore(input) }
  assetUnlink(input: Parameters<ResourceLibrary['unlink']>[0]) { return this.resources.unlink(input) }
  restore(input: { sceneId: string; revision: number; expectedRevision: number }): Promise<SceneSnapshot> { return this.scene.restore(input) }
  async align(input: { sceneId: string; entityId: string; expectedRevision: number; sourcePoints: Vec3[]; targetPoints: Vec3[] }): Promise<SceneSnapshot> {
    if (input.sourcePoints.length !== 3 || input.targetPoints.length !== 3) throw new Error("ALIGN_REQUIRES_THREE_POINTS")
    const basis = (points: Vec3[]) => {
      const origin = new Vector3(...points[0]!)
      const x = new Vector3(...points[1]!).sub(origin)
      const y = new Vector3(...points[2]!).sub(origin)
      if (x.length() < 1e-9 || new Vector3().crossVectors(x, y).length() < 1e-9) throw new Error("ALIGN_COLLINEAR_POINTS")
      x.normalize()
      const z = new Vector3().crossVectors(x, y).normalize()
      y.crossVectors(z, x).normalize()
      return new Matrix4().makeBasis(x, y, z).setPosition(origin)
    }
    const delta = basis(input.targetPoints).multiply(basis(input.sourcePoints).invert())
    const snapshot = await this.scene.snapshot(input.sceneId)
    const entity = snapshot.entities.find(item => item.entityId === input.entityId)
    if (!entity) throw new Error("ENTITY_NOT_FOUND")
    const worldMatrix = (target: Entity): Matrix4 => {
      const local = new Matrix4().compose(new Vector3(...target.transform.position), new Quaternion(...target.transform.quaternion), new Vector3(...target.transform.scale))
      return target.parentId ? worldMatrix(snapshot.entities.find(item => item.entityId === target.parentId)!).multiply(local) : local
    }
    const matrix = delta.multiply(worldMatrix(entity))
    if (entity.parentId) matrix.premultiply(worldMatrix(snapshot.entities.find(item => item.entityId === entity.parentId)!).invert())
    const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
    matrix.decompose(position, quaternion, scale)
    return this.scene.commit({ sceneId: input.sceneId, expectedRevision: input.expectedRevision, patch: [{ op: "update", entityId: input.entityId, changes: { transform: { position: position.toArray(), quaternion: quaternion.toArray(), scale: scale.toArray() } } }] })
  }
}
