/**
 * 大场景的 LOD **判定**：从实体**已有的** `resources` 与 `visual` 组件里解析出"离多远改用哪个派生表示"，
 * 再按相机距离选当前该用哪一级。
 *
 * 为什么只有纯函数：级别的目标必须是 `entity.resources` 里**已经存在的资源引用**（派生物，见 LARGE_SCENES.md 的
 * 资产约定）——那份引用来自 ResourceLibrary 的正常登记（`scene_import`/`scene_mount` 写的就是资源库的 ref），
 * 这里不查资源库、不拼路径、不造第二份资源索引——解析不出来就如实记一条 problem 并跳过该级别，绝不拿别的资源顶替。
 * 谁把解析结果加载出来、什么时候交换、失败怎么办，是 `index.ts` 里那条既有加载路径的事。
 *
 * 级别编号：基础级别（实体原本的 `visual` 表示）是 `LOD_BASE`(-1)；派生级别从 0 起，按距离升序。
 */
import { Matrix4, type Object3D } from "three"
import type { Entity, Representation, ResourceRef } from "../../lyapunov-contracts/src/types.ts"

/** 派生文件内的节点地址：显式索引、显式节点名，或两者都不给（运行时按名字/唯一网格节点解析）。 */
export interface LodNodeAddress { index?: number; name?: string }
/** 一个派生级别：相机距离 ≥ `minDistanceM`（米）时改用它。 */
export interface LodLevel { role: string; minDistanceM: number; ref: ResourceRef; representation: Representation; node?: LodNodeAddress }
export interface LodPlan { levels: LodLevel[]; problems: string[] }
/** 基础级别在级别编号里的取值（实体原本的 `visual` 表示，也是分辨率最高的那一级）。 */
export const LOD_BASE = -1
/**
 * 滞回系数：**变粗**到阈值就切，**变细**要回到 `阈值 × 0.9` 以内才切。
 * 没有它，相机停在阈值上时每帧都会来回换级别（画面抖动，还白读两次资源）。
 */
export const LOD_HYSTERESIS = 0.9

/** 实体里承载可视几何的那个资源引用。与 `index.ts` 选基础表示用的是**同一条判据**（只有这一份）。 */
export function primaryResource(entity: Entity): ResourceRef | undefined {
  return entity.resources.find(ref => ref.representations.some(rep => rep.role === "visual" || rep.mimeType === "model/gltf-binary")) ?? entity.resources[0]
}
/** 实体基础级别**实际加载**的那条表示（`index.ts` 的 `loadVisual` 用的是同一条判据）。 */
export function baseRepresentation(ref: ResourceRef): Representation {
  return ref.representations.find(rep => rep.role === "visual") ?? ref.representations[0] ?? ref.original
}

/**
 * 解析实体的 LOD 计划。`visual.lod` 的每一项形如
 * `{ "role": "visual", "minDistanceM": 20, "resourceId": "potted_plant_lod1", "version": 1 }`，
 * 可选 `gltfNode`/`gltfNodeName` 指明派生**文件内**的节点（与基础文件的节点号无关）。
 *
 * 级别目标的两条硬要求（都由本函数判定，不在别处再写一遍）：
 *  1. 必须指向**本实体 resources 里另一条已登记的资源版本**。指向基础表示自己（同一个 URI）等于永远不换级别，
 *     是配置错误不是 LOD。正常登记进来的 LOD 资源其表示角色就是 `"visual"`（ResourceLibrary 对网格资源只写这一个
 *     角色），所以这里**允许** `role:"visual"`，只要它落在另一条资源版本上。
 *  2. 基础视觉是"源坐标已烘焙"（`visual.sourceTransformApplied === true`，GLB 展开节点实体就是这种）时，
 *     派生资源声明的 `source`（轴/手性/单位）必须与基础资源一致：这种实体的源坐标转换由父链上基础资源那条
 *     变换完成，派生文件若换了轴系，画面会静默歪掉——宁可拒绝该级别并如实报，也不悄悄多转一次。
 *
 * 没有 `lod`、不是数组、或一个合法级别都没有时返回 `undefined`（"没有 LOD"与"LOD 全是错的"都按没有处理，
 * 后者的问题清单照常带回，让上层记成缺件警告而不是默默降级）。
 */
export function resolveLodPlan(entity: Entity): LodPlan | undefined {
  const visual = entity.components.visual as { lod?: unknown; sourceTransformApplied?: unknown } | undefined
  const raw = visual?.lod
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const base = primaryResource(entity)
  const baseRep = base ? baseRepresentation(base) : undefined
  const levels: LodLevel[] = [], problems: string[] = []
  for (const [index, entry] of raw.entries()) {
    const spec = (entry ?? {}) as { role?: unknown; minDistanceM?: unknown; resourceId?: unknown; version?: unknown; gltfNode?: unknown; gltfNodeName?: unknown }
    const role = typeof spec.role === "string" && spec.role.length > 0 ? spec.role : undefined
    const minDistanceM = typeof spec.minDistanceM === "number" && Number.isFinite(spec.minDistanceM) && spec.minDistanceM >= 0 ? spec.minDistanceM : undefined
    if (!role || minDistanceM === undefined) { problems.push(`LOD_LEVEL_INVALID: #${index} 需要 role 与非负 minDistanceM`); continue }
    const ref = typeof spec.resourceId === "string"
      ? entity.resources.find(item => item.resourceId === spec.resourceId && (spec.version === undefined || item.version === spec.version))
      : base
    if (!ref) { problems.push(`LOD_RESOURCE_NOT_FOUND: #${index} ${String(spec.resourceId)}@${String(spec.version ?? "?")} 不在本实体的 resources 里（派生件要用 scene_import 登记并成为该实体的资源引用）`); continue }
    const representation = ref.representations.find(rep => rep.role === role)
    if (!representation) { problems.push(`LOD_REPRESENTATION_NOT_FOUND: #${index} ${ref.resourceId} 上没有 role="${role}" 的表示`); continue }
    // 与基础表示同一条渲染路径：只认 GLB。别的格式在这里就是"这一级用不了"，如实报，不去猜转换。
    if (representation.mimeType !== "model/gltf-binary") { problems.push(`LOD_REPRESENTATION_UNSUPPORTED: #${index} ${role} ${representation.mimeType}`); continue }
    // 级别指向基础表示自己（同一个文件）＝永远不换级别；跨资源但 URI 相同同理。
    if (baseRep && representation.uri === baseRep.uri) { problems.push(`LOD_LEVEL_NOT_DERIVED: #${index} ${ref.resourceId}@${ref.version} 指向基础表示本身`); continue }
    if (visual?.sourceTransformApplied === true && base && !sameSourceFrame(base, ref)) {
      problems.push(`LOD_LEVEL_SOURCE_MISMATCH: #${index} 派生资源 ${ref.resourceId} 的 source(${describeSource(ref)}) 与基础资源 source(${describeSource(base)}) 不一致；源坐标已烘焙在实体父链上，换了轴系会歪，本级别不启用`)
      continue
    }
    const node: LodNodeAddress = {}
    if (spec.gltfNode !== undefined) {
      if (typeof spec.gltfNode !== "number" || !Number.isInteger(spec.gltfNode) || spec.gltfNode < 0) { problems.push(`LOD_LEVEL_NODE_INVALID: #${index} gltfNode 需要非负整数（派生文件内的节点号）`); continue }
      node.index = spec.gltfNode
    }
    if (spec.gltfNodeName !== undefined) {
      if (typeof spec.gltfNodeName !== "string" || spec.gltfNodeName.length === 0) { problems.push(`LOD_LEVEL_NODE_INVALID: #${index} gltfNodeName 需要非空字符串（派生文件内的节点名）`); continue }
      node.name = spec.gltfNodeName
    }
    levels.push({ role, minDistanceM, ref, representation, ...(node.index === undefined && node.name === undefined ? {} : { node }) })
  }
  if (levels.length === 0) return { levels, problems }
  levels.sort((left, right) => left.minDistanceM - right.minDistanceM)
  return { levels, problems }
}

/** 派生资源与基础资源的源坐标声明是否同一套（轴/手性/单位换算）。 */
export function sameSourceFrame(base: ResourceRef, derived: ResourceRef): boolean {
  const left = base.source, right = derived.source
  return left.upAxis === right.upAxis && left.handedness === right.handedness && left.units === right.units && left.metersPerUnit === right.metersPerUnit
}
function describeSource(ref: ResourceRef): string {
  return `up=${ref.source.upAxis},${ref.source.handedness},units=${ref.source.units},metersPerUnit=${String(ref.source.metersPerUnit ?? "?")}`
}

/** 派生 GLB 里的一个候选节点：静态描述（不依赖 three），用来单独测"选哪一个"。 */
export interface DerivedNodeCandidate { index: number; name: string; hasMesh: boolean }

/**
 * 选派生文件里的哪个节点来代表基础级别显示的那个对象。
 *
 * 为什么不直接沿用基础文件的 `gltfNode`：两个文件的节点号是两个命名空间。实测的常见形状是基础件是多节点
 * （一个 GLB 里 pot 在 node1、pebbles 在 node3），派生件是"只导出那一个对象"的单节点文件（只有 node0）。
 * 把基础号硬套过去只会得到 `GLTF_NODE_NOT_FOUND`，把派生件的 node0 硬当作基础 node3 则是取错对象。
 *
 * 判据（按优先级，每一步都不猜）：
 *  1. 级别条目显式给了 `gltfNode` → 就用这个号；文件里没有 → `LOD_LEVEL_NODE_NOT_FOUND`。
 *  2. 级别条目显式给了 `gltfNodeName` → 按名字匹配；匹配不到 → `LOD_LEVEL_NODE_NOT_FOUND`；多个同名 → 歧义。
 *  3. 用基础节点名（派生件通常是"从那个对象导出的"，对象名会跟着过来）；**唯一**匹配才用。
 *  4. 派生文件里只有一个带网格的节点 → 用它（多节点文件不适用；这不算猜，没有别的候选）。
 *  5. 其余情况 → `LOD_LEVEL_NODE_AMBIGUOUS`，带上候选名单，保持当前级别显示。
 */
export function chooseDerivedNode(candidates: DerivedNodeCandidate[], address: LodNodeAddress | undefined, baseNodeName?: string): { index: number } | { problem: string } {
  if (address?.index !== undefined) {
    return candidates.some(candidate => candidate.index === address.index) ? { index: address.index } : { problem: `LOD_LEVEL_NODE_NOT_FOUND: gltfNode=${address.index}` }
  }
  if (address?.name !== undefined) {
    const matches = candidates.filter(candidate => candidate.name === address.name)
    if (matches.length === 1) return { index: matches[0]!.index }
    return { problem: matches.length === 0 ? `LOD_LEVEL_NODE_NOT_FOUND: gltfNodeName="${address.name}"` : `LOD_LEVEL_NODE_AMBIGUOUS: gltfNodeName="${address.name}" 匹配到 ${matches.length} 个节点` }
  }
  if (baseNodeName) {
    const byName = candidates.filter(candidate => candidate.name === baseNodeName)
    if (byName.length === 1) return { index: byName[0]!.index }
  }
  const meshes = candidates.filter(candidate => candidate.hasMesh)
  if (meshes.length === 1) return { index: meshes[0]!.index }
  return { problem: `LOD_LEVEL_NODE_AMBIGUOUS: 派生文件里${meshes.length === 0 ? "没有带网格的节点" : `${meshes.length} 个带网格的节点`}，请在该级别条目上写 gltfNode 或 gltfNodeName（候选：${candidates.map(candidate => `${candidate.index}:${candidate.name || "∅"}`).join(", ") || "无"}）` }
}

/**
 * 一个 glTF 节点在**它自己文件内部**的完整变换链：从文件根一路乘到该节点（`父 × … × 自己`）。
 *
 * `isFileNode` 用来界定"文件内部"的边界：从该节点往上走，只累加**仍是该文件 glTF 节点**的祖先，
 * 碰到第一个非 glTF 节点（GLTFLoader 插入的 wrapper、`gltf.scene` 本身）就停。Scene 侧的父变换
 * （底座、实体自己的位姿）绝不能进来——那样同一份派生件换个摆放位置，相对矩阵就跟着变了。
 *
 * 为什么要用完整链而不是节点自己的局部矩阵（ENV-95 点 1 实测）：Blender/Unity 导出的普通文件是
 * "非 identity 父节点 → 网格子节点"，而 `glbEntities` 会把整棵节点树展开成实体链，基础级别的显示
 * 位置 = 场景侧位姿 × **整条文件链**。派生件有两种常见写法，只有完整链能同时覆盖：
 *   · 把父变换烘进顶点导出（单节点、局部矩阵 = 单位阵）→ 局部矩阵比出来是"基础节点局部矩阵的逆"，
 *     只抵消了子节点那一层，父变换被**又施加了一遍**（95 号实测：盆整体偏 0.41 m）；
 *   · 自己保留了另一层父节点 → 两个文件里子节点的局部矩阵可能逐字相同，比出来是单位阵，
 *     派生件的父变换**整条丢掉**（实测：偏 0.80 m）。
 */
export function fileNodeChain(node: Object3D, isFileNode: (object: Object3D) => boolean): Matrix4 {
  const chain: Object3D[] = []
  for (let current: Object3D | null = node; current && isFileNode(current); current = current.parent) chain.push(current)
  const result = new Matrix4()
  for (let index = chain.length - 1; index >= 0; index--) {
    const item = chain[index]!
    item.updateMatrix() // glTF 节点给的是 TRS（或已被解析成 TRS 的 matrix），这里统一取局部矩阵
    result.multiply(item.matrix)
  }
  return result
}

/**
 * 派生节点相对基础节点的变换：`基础节点完整链⁻¹ × 派生节点完整链`（两个链都必须来自**各自文件内部**，
 * 见 `fileNodeChain`；传进来的若是节点局部矩阵，就会退化成"只抵一层"的老行为）。
 *
 * 基础级别在加载时把节点自身变换置零（文件里那串变换已经由实体链承担），所以派生级别要落在同一世界位置，
 * 就得先把派生文件里那串变换"减掉基础文件那串"再交给实体：
 *  · 派生件保留父链与对象变换导出 → 两条链相同 → 结果是单位矩阵（与基础逐字一致）；
 *  · 派生件导出时把整条链烘进了网格 → 派生链是单位阵 → 结果是基础链的逆，正好抵消实体上那串；
 *  · 派生件换了另一层父节点 → 结果 = 基础链⁻¹ × 新父链，落点跟着新父链走。
 * 三种情况由同一行矩阵算法覆盖：不需要派生件把节点号/原点硬凑成一样，也不需要猜它是怎么导出的。
 */
export function derivedNodeMatrix(base: Matrix4, derived: Matrix4): Matrix4 {
  return new Matrix4().copy(base).invert().multiply(derived)
}

/**
 * 按距离直接算目标级别（无滞回）：`LOD_BASE` 或派生级别下标。
 *
 * "按指定相机出图"用的就是它（见 `index.ts` 的 `updateLod(camera, { settle })`）：那一次判级不需要防抖，
 * 需要的是一步到位——一次性相机拍完就走，逐级回落只会让这张图停在中间级别上（拿远景的粗级别冒充近景）。
 */
export function rawLodLevel(plan: LodPlan, distanceM: number): number {
  let target = LOD_BASE
  for (let index = 0; index < plan.levels.length; index++) if (distanceM >= plan.levels[index]!.minDistanceM) target = index
  return target
}

/**
 * 按距离选级别：返回 `LOD_BASE` 或派生级别下标。
 *
 * 规则：变粗可以直接跳到目标级别（远处一次到位，不必逐级加载）；变细一次只回一级，且必须越过滞回线。
 * `current` 传当前**正在显示**的级别，这样滞回判据只依赖已显示的事实，不依赖在途加载。
 */
export function selectLodLevel(plan: LodPlan, distanceM: number, current: number): number {
  const target = rawLodLevel(plan, distanceM)
  if (current === LOD_BASE || target >= current) return target
  // "进入当前这一级"的阈值就是它自己的 minDistanceM：要退出去，得回到它以内 `LOD_HYSTERESIS` 倍的距离。
  const boundary = plan.levels[current]!.minDistanceM
  return distanceM <= boundary * LOD_HYSTERESIS ? current - 1 : current
}
