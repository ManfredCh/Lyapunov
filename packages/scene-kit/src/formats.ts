import { open, readFile, stat } from "node:fs/promises"
import { blendExternalFiles } from "./blend-deps.ts"
import {geometrySourceFacts,objMaterialFiles,type SourceTexturePolicy} from './geometry-source-deps.ts'
import { splatBounds } from "./splat-bounds.ts"
import { createReadStream, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, extname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { Euler, Matrix4, Quaternion, Vector3 } from "three"
import type { Entity, ResourceRef, Transform, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"

export type AssetKind = "mesh" | "splat" | "robot" | "source"
export interface FileStamp { path: string; size: number; mtimeMs: number; sha256?: string }
export interface ParsedAsset {
  kind: AssetKind
  mimeType: string
  source: ResourceRef["source"]
  dependencies: FileStamp[]
  /** 开放形状（各格式自带事实）。GLB 另带材质事实 `materials: GlbMaterialFact[]`：材质事实进入收件元数据，供"材质整理"核对。 */
  metadata: Record<string, unknown>
}
const splatExtensions = [".ply", ".spz", ".sog", ".rad", ".splat", ".ksplat"]
// MuJoCo 只编译 STL/OBJ/MSH 网格（PLY 到 3.4 才支持，GLB 到 3.13.0 仍然没有解码器）。
const mujocoMeshExtensions = [".stl", ".obj", ".msh"]
/**
 * **登记闭包**（依赖闭包 → 媒体路由候选集）接受的网格扩展名 = MuJoCo 可编译的 ∪ Viewer 装载器已接线的。
 *
 * `.glb` 只满足后者，但必须收：用户导入的机器人文档里就有 `<mesh file="…glb">`（真件 `banana.xml`，
 * 见 `bugfixHistory/ROBOT-GLB-MESH-20260927.md`）。拒绝登记 ⇒ 依赖闭包为空 ⇒ 媒体路由候选集里没有它 ⇒
 * 即使 Viewer 的装载器分派认 `.glb`，**字节也到不了浏览器**（用户可见现象："机器人装不上"）。
 *
 * 物理侧**不假装**支持：MuJoCo 3.13.0 对同一份文档实测
 * `no decoder found for mesh file '…/banana.glb'`（Element name 'banana_mesh'），
 * 那条错误由 MuJoCo 自己在编译时报，比在登记层拦下来更精确（带元素名与行号）。
 */
const robotMeshExtensions = [...mujocoMeshExtensions, ".glb"]

export function localPath(uri: string, base = process.cwd()): string {
  if (uri.startsWith("file:")) return fileURLToPath(uri)
  if (/^[a-z][a-z+.-]*:/i.test(uri)) throw new Error(`LOCAL_FILE_REQUIRED: ${uri}`)
  return resolve(base, uri)
}
export async function fileStamp(path: string, content = true): Promise<FileStamp> {
  const value = await stat(path)
  if (!value.isFile() || !value.size) throw new Error(`EMPTY_OR_NON_FILE: ${path}`)
  if (!content) return { path, size: value.size, mtimeMs: value.mtimeMs }
  const hash=createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  const after=await stat(path)
  if(after.size!==value.size||after.mtimeMs!==value.mtimeMs)throw new Error(`RESOURCE_CHANGED_DURING_READ: ${path}`)
  return { path, size: value.size, mtimeMs: value.mtimeMs, sha256:hash.digest('hex') }
}

export function glbJSON(buffer: Uint8Array): any {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (buffer.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.length) throw new Error("INVALID_GLB_HEADER")
  const jsonLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength + 20 > buffer.length) throw new Error("INVALID_GLB_JSON_CHUNK")
  const json = JSON.parse(new TextDecoder().decode(buffer.subarray(20, 20 + jsonLength)))
  if (!json.asset?.version?.startsWith("2.")) throw new Error("UNSUPPORTED_GLTF_VERSION")
  let offset = 12
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error("INVALID_GLB_CHUNK")
    offset += 8 + view.getUint32(offset, true)
  }
  if (offset !== buffer.length) throw new Error("INVALID_GLB_LENGTH")
  return json
}

/** glTF 规范要求 POSITION accessor 带 min/max：沿默认场景图累计节点变换得到源坐标 AABB；任一网格缺数据则整体放弃。 */
function glbSceneBounds(json: any): { min: Vec3; max: Vec3 } | undefined {
  const nodes: any[] = json.nodes ?? [], meshes: any[] = json.meshes ?? [], accessors: any[] = json.accessors ?? []
  const roots: number[] = json.scenes?.[Number(json.scene ?? 0)]?.nodes ?? nodes.map((_, index) => index).filter(index => !nodes.some(node => node.children?.includes(index)))
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  const visited = new Set<number>()
  let incomplete = false
  function walk(index: number, parent: Matrix4): void {
    if (visited.has(index) || incomplete) return
    visited.add(index)
    const node = nodes[index]
    if (!node) return
    const transform = transformOf(node)
    const world = new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale)).premultiply(parent)
    if (node.mesh !== undefined) {
      const primitives = meshes[node.mesh]?.primitives
      if (!Array.isArray(primitives)) { incomplete = true; return }
      for (const primitive of primitives) {
        const accessor = accessors[primitive?.attributes?.POSITION]
        if (!accessor?.min || !accessor?.max) { incomplete = true; return }
        for (const x of [accessor.min[0], accessor.max[0]]) for (const y of [accessor.min[1], accessor.max[1]]) for (const z of [accessor.min[2], accessor.max[2]]) {
          const corner = new Vector3(x, y, z).applyMatrix4(world)
          min.min(corner); max.max(corner)
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world)
  }
  for (const index of roots) walk(index, new Matrix4())
  if (incomplete || min.x > max.x) return undefined
  return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 }
}

/** 一个贴图槽位的读数：槽位指向的 texture 索引 + 它的 image 事实（原文照抄；glTF 里没声明的字段缺省，不编造）。 */
export interface GlbTextureSlotFact {
  /** glTF textureInfo.index（textures 数组索引）——该槽位用的贴图。 */
  index: number
  /** textures[index].source（images 数组索引）；像素由扩展提供、无 core source 时缺省。 */
  source?: number
  /** images[source].name / images[source].mimeType 原文；glTF 里没声明就缺省。 */
  name?: string
  mimeType?: string
}

/** 一个材质的材质事实：glTF 材质名 + 各贴图槽位读数（槽位名＝glTF 属性名去掉 `Texture` 尾缀：baseColor/metallicRoughness/normal/occlusion/emissive/…）。 */
export interface GlbMaterialFact {
  /** glTF materials[i].name 原文；没名字就不给这个字段。 */
  name?: string
  /** 贴图槽位 → 读数；材质没有贴图就是空对象。同名槽位被多个 holder 重复给出时以后者为准。 */
  textures: Record<string, GlbTextureSlotFact>
  /** 真实 glTF 值；材质名字不是颜色，没写时不从名字推断。 */
  baseColorFactor?:[number,number,number,number]
  metallicFactor?:number
  roughnessFactor?:number
  alphaMode?:string
}

/**
 * GLB 材质事实进入收件元数据，供"材质整理"核对：只照抄导入解析时已有的 glTF JSON
 * （materials/textures/images，与依赖/aabb 同一条读数通道、不新起第二套解析），缺读数就缺省字段。
 */
function glbMaterials(json: any): GlbMaterialFact[] {
  const textureTable: any[] = Array.isArray(json?.textures) ? json.textures : []
  const imageTable: any[] = Array.isArray(json?.images) ? json.images : []
  return (Array.isArray(json?.materials) ? json.materials : []).map((material: any): GlbMaterialFact => {
    const slots: Record<string, GlbTextureSlotFact> = {}
    const holders = [material, material?.pbrMetallicRoughness, ...Object.values(material?.extensions ?? {})]
    for (const holder of holders) for (const [key, value] of Object.entries(holder ?? {})) {
      const index = (value as { index?: unknown } | null | undefined)?.index
      if (!key.endsWith("Texture") || typeof index !== "number") continue
      const source = textureTable[index]?.source
      const image = typeof source === "number" ? imageTable[source] : undefined
      slots[key.slice(0, -"Texture".length)] = { index, ...(typeof source === "number" ? { source } : {}), ...(typeof image?.name === "string" && image.name ? { name: image.name } : {}), ...(typeof image?.mimeType === "string" && image.mimeType ? { mimeType: image.mimeType } : {}) }
    }
    const pbr=material?.pbrMetallicRoughness
    return { ...(typeof material?.name === "string" && material.name ? { name: material.name } : {}), textures: slots,
      ...(Array.isArray(pbr?.baseColorFactor)&&pbr.baseColorFactor.length===4&&pbr.baseColorFactor.every((v:unknown)=>typeof v==='number'&&Number.isFinite(v))?{baseColorFactor:[...pbr.baseColorFactor] as [number,number,number,number]}:{}),
      ...(typeof pbr?.metallicFactor==='number'?{metallicFactor:pbr.metallicFactor}:{}),...(typeof pbr?.roughnessFactor==='number'?{roughnessFactor:pbr.roughnessFactor}:{}),...(typeof material?.alphaMode==='string'?{alphaMode:material.alphaMode}:{}) }
  })
}

/** 资源视觉包围盒换算到实体根本地坐标（含源坐标转换）；无 aabb 元数据（robot/旧登记资源、无法解码的泼溅件）返回 undefined。 */
export function assetBounds(parsed: ParsedAsset, source: ResourceRef["source"]): { min: Vec3; max: Vec3 } | undefined {
  const aabb = parsed.metadata.aabb as { min: Vec3; max: Vec3 } | undefined
  if (!aabb) return undefined
  const transform = sourceTransform(source)
  const matrix = new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale))
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [aabb.min[0], aabb.max[0]]) for (const y of [aabb.min[1], aabb.max[1]]) for (const z of [aabb.min[2], aabb.max[2]]) {
    const corner = new Vector3(x, y, z).applyMatrix4(matrix)
    min.min(corner); max.max(corner)
  }
  return { min: min.toArray() as Vec3, max: max.toArray() as Vec3 }
}

const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false })
const numbers = (value: unknown, defaults: number[]): number[] => typeof value === "string" ? value.trim().split(/\s+/).map(Number) : defaults

function readXml(text: string): any {
  const valid = XMLValidator.validate(text)
  if (valid !== true) throw new Error(`INVALID_ROBOT_XML: ${valid.err.msg}`)
  return xmlParser.parse(text)
}

/** 同一段的若干份内容按出现顺序接起来：段内的元素列表本来就允许重复。 */
function mergeChildLists(parts: any[]): Record<string, any> {
  const merged: Record<string, any> = {}
  for (const part of parts) for (const [key, value] of Object.entries(part ?? {})) merged[key] = merged[key] === undefined ? value : [...array(merged[key]), ...array(value)]
  return merged
}

/** 段自身的属性（`compiler` 的 `angle`／`meshdir` 等）；重复段给成数组时后者覆盖前者。 */
const attributesOf = (value: any): Record<string, any> => Object.assign({}, ...array(value))

/** 把一份段集合并入合并结果（只按本机 MuJoCo 3.12.0 的实测行为）：`asset`／`worldbody` 的元素列表
 *  接着排，`compiler` 后写下的属性覆盖先写下的，其余段按重复段保留两侧（消费方本来就按 list() 读）。 */
function mergeSections(target: Record<string, any>, source: Record<string, any>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "include") continue
    const current = target[key]
    if (current === undefined) target[key] = value
    else if (key === "asset" || key === "worldbody") target[key] = mergeChildLists([current, value])
    else if (key === "compiler") target[key] = { ...attributesOf(current), ...attributesOf(value) }
    else target[key] = [...array(current), ...array(value)]
  }
}

const orderParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, preserveOrder: true })

/**
 * 根元素名与它直属子元素的出现顺序。普通解析会把重复段并成一个数组、丢掉它与其他段（尤其
 * `<include>`、夹在重复段之间的 `<compiler>`）的先后，还会把 XML 声明解析成 `?xml` 键；这里用
 * `preserveOrder` 只读顺序，内容仍走普通解析（同一段重复 N 次就是长度 N 的数组，按序对号入座）。
 */
function topLevelOrder(text: string): { root: string; children: string[] } {
  const nodeOf = (item: any): string | undefined => Object.keys(item ?? {}).find(key => key !== ":@" && key !== "#text")
  const nodes = orderParser.parse(text) as any[]
  const root = nodes.map(nodeOf).find(name => name && !name.startsWith("?") && !name.startsWith("!"))
  const items = nodes.find(node => nodeOf(node) === root)?.[root as string] ?? []
  return { root: root ?? "", children: items.map(nodeOf).filter((name: string) => name && !name.startsWith("?")) }
}

/** 某个文件里的资产元素 + 该文件相对主文档的目录（`file` 落位用）。 */
interface IncludedAsset { item: any; tag: string; dir: string }

/**
 * 读一份 MJCF 的段集合并就地展开 include，返回合并后的段集合、展开过的 include 文件（供依赖闭包）
 * 与各文件自己的资产元素（供 `expandMjcfDocument` 落位）。
 * 实测（MuJoCo 3.12.0）：被 include 的文件只按"根元素的子元素"取段——根叫 `<mujoco>` 或
 * `<mujocoinclude>` 都一样，不要求有 worldbody；根是 `<robot>` 的 URDF 不是 MJCF，忽略它等于引用方
 * 无声地少一整份内容，所以报错。
 */
async function expandMjcf(path: string, seen: Set<string> = new Set(), dir = ""): Promise<{ sections: Record<string, any>; includes: string[]; assets: IncludedAsset[] }> {
  const text = await readFile(path, "utf8")
  const document = readXml(text)
  if (document.robot) throw new Error(`ROBOT_INCLUDE_NOT_MJCF: ${path}`)
  const { root, children } = topLevelOrder(text)
  const content = document[root] ?? {}
  const merged: Record<string, any> = {}
  const includes: string[] = []
  const assets: IncludedAsset[] = []
  const used = new Map<string, number>()
  for (const name of children) {
    const index = used.get(name) ?? 0
    used.set(name, index + 1)
    if (name !== "include") {
      const value = Array.isArray(content[name]) ? content[name][index] : content[name]
      if (value !== undefined) {
        mergeSections(merged, { [name]: value })
        // 只记这一层自己的资产元素：被 include 的文件由它自己那一层记，目录才是它的。
        if (name === "asset") for (const section of array<any>(value)) for (const [tag, items] of Object.entries(section ?? {})) for (const item of array<any>(items)) if (item && typeof item === "object") assets.push({ item, tag, dir })
      }
      continue
    }
    const include = array<any>(content.include)[index]
    if (!include) continue
    const target = resolve(dirname(path), include.file)
    if (seen.has(target)) throw new Error(`ROBOT_INCLUDE_CYCLE: ${target}`)
    includes.push(target)
    const childDir = [dir, relative(dirname(path), dirname(target)).replaceAll("\\", "/")].filter(Boolean).join("/")
    const child = await expandMjcf(target, new Set(seen).add(target), childDir)
    includes.push(...child.includes)
    assets.push(...child.assets)
    mergeSections(merged, child.sections)
  }
  return { sections: merged, includes, assets }
}

/**
 * 展开 include，并把**被 include 文件**里的资产引用落位到本机 MuJoCo 3.12.0 实测会读的那一份文件：
 * `file` 先按主文档目录找（`meshdir/file`，与写在主文档里一样），找不到才按
 * `meshdir/<子文件所在目录>/file` 找；两者都在时实测读的是前者（`checks/mjcf_probe3/probe_priority2.py`）。
 * 只改落进后备位置的那些引用，主文档自己的引用与同目录 include 一个字节都不动；后备位置也没有就原样
 * 留着，由缺件警告/依赖闭包去暴露。显示侧与依赖闭包共用这一份段集合。
 */
async function expandMjcfDocument(path: string, seen: Set<string> = new Set()): Promise<{ sections: Record<string, any>; includes: string[] }> {
  const expanded = await expandMjcf(path, seen)
  const compiler = attributesOf(expanded.sections.compiler)
  const root = dirname(path)
  for (const { item, tag, dir } of expanded.assets) {
    if (!dir || typeof item.file !== "string" || item.file.startsWith("package://")) continue
    const prefix = tag === "mesh" ? compiler.meshdir ?? compiler.assetdir ?? "" : tag === "texture" ? compiler.texturedir ?? compiler.assetdir ?? "" : ""
    if (existsSync(resolve(root, prefix, item.file))) continue           // 主文档目录下已经有这一份
    if (!existsSync(resolve(root, prefix, dir, item.file))) continue     // 后备位置也没有
    item.file = `${dir}/${item.file}`
  }
  return expanded
}

async function robotDependencies(path: string, seen = new Set<string>(), unsupportedMeshes?: string[]): Promise<FileStamp[]> {
  path = resolve(path)
  if (seen.has(path)) return []
  seen.add(path)
  const root = unsupportedMeshes === undefined
  const failures = unsupportedMeshes ?? []
  const result = [await fileStamp(path)]
  const document = readXml(await readFile(path, "utf8"))
  // MJCF 走"已展开 include 的段集合 + 生效 compiler"，与显示侧（robotVisual 同用 expandMjcfDocument）
  // 同一口径，被 include 的文件本身也进闭包；URDF 没有这套展开，按文档原样走。
  const expanded = document.mujoco ? await expandMjcfDocument(path) : undefined
  const compiler = expanded ? attributesOf(expanded.sections.compiler) : {}
  for (const include of expanded?.includes ?? []) if (!seen.has(include)) { seen.add(include); result.push(await fileStamp(include)) }
  async function walk(node: any, tag: string): Promise<void> {
    if (!node || typeof node !== "object") return
    for (const item of array<any>(node)) {
      if (item.file || item.filename) {
        const reference = item.file ?? item.filename
        if (reference.startsWith("package://")) throw new Error(`RESOURCE_PACKAGE_MAPPING_REQUIRED: ${reference}`)
        if (tag === "mesh" && !robotMeshExtensions.includes(extname(reference).toLowerCase())) failures.push(reference)
        const dir = tag === "mesh" ? compiler.meshdir ?? compiler.assetdir ?? "" : tag === "texture" ? compiler.texturedir ?? compiler.assetdir ?? "" : ""
        const dependency = resolve(dirname(path), dir, reference)
        if (tag === "include") result.push(...await robotDependencies(dependency, seen, failures))
        else if (!seen.has(dependency)) { seen.add(dependency); result.push(await fileStamp(dependency)) }
      }
      for (const [key, child] of Object.entries(item)) if (typeof child === "object") await walk(child, key)
    }
  }
  await walk(expanded?.sections ?? document, "root")
  if (root && failures.length) throw new Error(`UNSUPPORTED_ROBOT_MESH_FORMAT: ${failures.join(", ")} — 机器人网格引用只接受 MuJoCo 可编译的 STL/OBJ/MSH 与 Viewer 可装载的 GLB；其余格式请先转换再引用（参考 assets/banana/convert_obj.py 的转换做法）`)
  return result
}

/**
 * GLB 的默认源坐标声明：glTF 规范就是 Y-up、米制、右手。导出成常量是因为**几何事实**（mesh-geometry.ts）
 * 也要按同一份换算把顶点读到"实体本地、米"，不能只在这里写死。
 */
export const GLTF_SOURCE: ResourceRef["source"] = { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 }

export async function parseAsset(path: string, override?: ResourceRef["source"],options:{sourceTexturePolicy?:SourceTexturePolicy}={}): Promise<ParsedAsset> {
  path = localPath(path)
  const stamp = await fileStamp(path)
  const extension = extname(path).toLowerCase()
  const defaultSource: ResourceRef["source"] = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 }
  if(extension==='.max')throw new Error('MAX_CONVERSION_REQUIRED: .max 不是可直接读取的通用模型；请在3ds Max中导出FBX（含材质/纹理）或GLB后导入，不能改后缀冒充支持')
  if(extension==='.obj'||extension==='.fbx'){
    if(extension==='.fbx'){
      const handle=await open(path,'r');const header=Buffer.alloc(256);try{await handle.read(header,0,header.length,0)}finally{await handle.close()}
      if(!header.subarray(0,21).toString('ascii').startsWith('Kaydara FBX Binary')&&!header.toString('utf8').includes('FBXHeaderExtension'))throw new Error('INVALID_FBX_HEADER')
    }
    const sourceTexturePolicy=options.sourceTexturePolicy??'strict'
    const mtls=extension==='.obj'?await objMaterialFiles(path):[],availableMtls:string[]=[],missingMtls:string[]=[]
    for(const mtl of mtls){if(await stat(mtl).then(s=>s.isFile(),()=>false))availableMtls.push(mtl);else if(sourceTexturePolicy==='strict')throw new Error('RESOURCE_DEPENDENCY_MISSING: '+basename(mtl));else missingMtls.push(mtl)}
    const facts=await geometrySourceFacts(path,extension==='.obj'?'obj':'fbx',sourceTexturePolicy)
    const dependencies=[stamp]
    for(const file of [...availableMtls,...facts.images.filter(v=>v.exists).map(v=>v.resolved)])if(!dependencies.some(d=>d.path===file))dependencies.push(await fileStamp(file))
    const missingTextureSnapshot=[...missingMtls.map(path=>({kind:'material-library',path})),...facts.missingImages.map(image=>({kind:'image',path:image.resolved,raw:image.raw})),...facts.emptyTextureDeclarations]
    return {kind:'source',mimeType:extension==='.obj'?'model/obj':'application/x-fbx',source:override??defaultSource,dependencies,metadata:{format:extension.slice(1),sourceTexturePolicy,missingTextureSnapshot,externals:{source:'blender-import',state:sourceTexturePolicy==='available'?'available-snapshot':'confirmed',files:dependencies.map(d=>d.path),complete:missingTextureSnapshot.length===0},importFacts:facts}}
  }
  if (extension === ".glb") {
    const json = glbJSON(await readFile(path))
    const dependencies = [stamp]
    for (const item of [...json.buffers ?? [], ...json.images ?? []]) {
      if (item.uri && !item.uri.startsWith("data:")) dependencies.push(await fileStamp(localPath(item.uri, dirname(path))))
    }
    const bounds = glbSceneBounds(json)
    return { kind: "mesh", mimeType: "model/gltf-binary", source: override ?? GLTF_SOURCE, dependencies, metadata: { nodes: json.nodes ?? [], scenes: json.scenes ?? [], scene: json.scene ?? 0, meshCount: json.meshes?.length ?? 0, materials: glbMaterials(json), ...((json.skins?.length??0)>0||(json.animations?.length??0)>0?{animatedAssembly:true,skinCount:json.skins?.length??0,animationCount:json.animations?.length??0}:{}), ...(bounds ? { aabb: bounds } : {}) } }
  }
  if (splatExtensions.includes(extension)) {
    const metadata: Record<string, unknown> = { format: extension.slice(1) }
    if (extension === ".splat") {
      if (stamp.size % 32 !== 0) throw new Error("INVALID_SPLAT_RECORD_LENGTH")
      metadata.splatCount = stamp.size / 32
    } else if (extension === ".ply") {
      const handle = await open(path, "r")
      let header: string
      try {
        const head = Buffer.alloc(65536)
        const { bytesRead } = await handle.read(head, 0, head.length, 0)
        header = head.subarray(0, bytesRead).toString("utf8")
      } finally { await handle.close() }
      if (!header.startsWith("ply\n") && !header.startsWith("ply\r\n")) throw new Error("INVALID_PLY_HEADER")
      const count = header.match(/element vertex (\d+)/)?.[1]
      if (!count || !header.includes("end_header")) throw new Error("INVALID_PLY_HEADER")
      metadata.vertexCount = Number(count)
      metadata.gaussianProperties = /property float (?:f_dc_0|scale_0)/.test(header)
    }
    // 高斯泼溅（.spz/.splat/.ply）按生态惯例是 **Y-up**：本仓的成对导出判据也把它当轴事实
    // （resources.ts 的 Marble 成对 SPZ/GLB 分支显式给 Y-up 的 visualSourceTransform），而同名 .glb
    // 走 glTF 规范同样是 Y-up。旧实现在这里沿用 defaultSource 的 Z-up，于是同一帧里的 splat 与它的
    // GLB 声明互相矛盾：Viewer 拿到单位转换 → 直接把 Y-up 场景渲染成竖墙/竖柱（用户可见的"导入后是歪的"）。
    // 真正 Z-up 的泼溅件仍可用 parseAsset(path, override) / visualSourceTransform 显式声明。
    // 泼溅件自身包围盒：过去没有 aabb，scene_mount 的落地对齐对 splat 直接跳过，
    // 而真实捕获的点云原点常在中部/上部（实测街道件自身 Y ∈ [−33.8, +2.3]），不抬升就会
    // 整片沉到地面以下。解码失败一律不写 aabb（保持旧行为，不猜）。
    const bounds = await splatBounds(path, extension).catch(() => undefined)
    return { kind: "splat", mimeType: extension === ".ply" ? "application/x-ply" : `application/x-${extension.slice(1)}`, source: override ?? { ...defaultSource, upAxis: "Y" }, dependencies: [stamp], metadata: { ...metadata, ...(bounds ? { aabb: bounds } : {}) } }
  }
  if ([".xml", ".mjcf", ".urdf"].includes(extension)) {
    const document = readXml(await readFile(path, "utf8"))
    const root = document.mujoco ?? document.robot
    if (!root) throw new Error("UNSUPPORTED_ROBOT_XML_ROOT")
    return { kind: "robot", mimeType: document.mujoco ? "application/x-mjcf+xml" : "application/x-urdf+xml", source: override ?? defaultSource, dependencies: await robotDependencies(path), metadata: { format: document.mujoco ? "mjcf" : "urdf", modelName: root.model ?? root.name ?? basename(path) } }
  }
  if ([".hdr", ".exr"].includes(extension)) {
    // HDRI（环境光照的 IBL/天空盒来源）：登记为普通资源，Viewer 按 representation 的 mimeType
    // 认出它（viewer/environment.ts 的 HDRI_MIME_TYPES）。这里只读文件头做真实性校验与尺寸元数据，
    // 不解码像素——解码归 THREE 的 HDRLoader/EXRLoader（渲染器侧唯一 owner）。
    return { kind: "source", mimeType: extension === ".hdr" ? "image/vnd.radiance" : "image/x-exr", source: override ?? defaultSource, dependencies: [stamp], metadata: { format: extension.slice(1), ...await hdriMetadata(path, extension) } }
  }
  if (extension === ".blend") {
    // 源工程的外部纹理/链接库/字体只存在于 Blender 的数据块里，文件字节里没有索引。依赖闭包与版本
    // 验证要覆盖它们，只能问配置的 Blender（blend-deps 的唯一权威读法）；本机没有 Blender 时依赖
    // **未知**，如实记在 metadata 里，不假装闭合、也不当成"没有依赖"。
    const externals = await blendExternalFiles(path)
    const dependencies = [stamp]
    for (const file of externals.files) {
      const dependency = await fileStamp(file)
      if (dependency.sha256 === stamp.sha256) continue
      dependencies.push(dependency)
    }
    const metadata: Record<string, unknown> = externals.state === "confirmed"
      ? { format: "blend", externals: { source: "blender", blender: externals.blender, files: externals.files, ...(externals.missing.length ? { missing: externals.missing.map(row => ({ datablock: row.datablock, kind: row.kind, resolved: row.resolved })) } : {}) } }
      : { format: "blend", externals: "unknown", externalsReason: externals.reason }
    return { kind: "source", mimeType: "application/x-blender", source: override ?? defaultSource, dependencies, metadata }
  }
  if ([".usd", ".usda", ".usdc"].includes(extension)) return { kind: "source", mimeType: "model/vnd.usd", source: override ?? defaultSource, dependencies: [stamp], metadata: { format: extension.slice(1) } }
  throw new Error(`UNSUPPORTED_RESOURCE_FORMAT: ${extension}`)
}

/**
 * HDRI 文件头校验与尺寸读数（读前 64 KiB，不整份读进内存）。
 *
 * `.hdr`（Radiance RGBE）：必须以 `#?RADIANCE`/`#?RGBE` 开头，且带 `-Y <高> +X <宽>` 分辨率行；
 * 没有 `FORMAT=32-bit_rle_rgbe|xyze` 的旧式平铺文件也接受（Radiance 规范允许），但分辨率行不能缺。
 * `.exr`：魔数 0x76 0x2f 0x31 0x01，版本字段低字节是版本号。
 * 判据是**文件头**而不是扩展名：改名的 .jpg 不会因为叫 .hdr 就被登记成环境贴图。
 */
async function hdriMetadata(path: string, extension: string): Promise<Record<string, unknown>> {
  const handle = await open(path, "r")
  try {
    const head = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const bytes = head.subarray(0, bytesRead)
    if (extension === ".hdr") {
      const text = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("latin1")
      const magic = text.split(/\r?\n/, 1)[0]?.trim()
      if (magic !== "#?RADIANCE" && magic !== "#?RGBE") throw new Error("INVALID_HDR_HEADER")
      const resolution = text.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/)
      if (!resolution) throw new Error("INVALID_HDR_RESOLUTION")
      // ENV-20（Round 4）：分辨率行之后**必须还有像素数据**。只校验文件头会把"头合法、零像素"的截断件
      // 登记成合法环境贴图——真机实测 112 B 的那种件被 Viewer 以 `loaded:true` 静默接受（画面只有黑背景）。
      // 判据只看"头之后还有没有字节"，不解读编码：对 `32-bit_rle_rgbe`（RLE 扫描线）与旧式平铺两种
      // 编码同样成立，因为合法 .hdr 的分辨率行后一定有扫描线数据。错误形状与上面几条一致（不新增错误类）。
      const resolutionEnd = resolution.index! + resolution[0].length
      const lineEnd = text.indexOf("\n", resolutionEnd)
      const payloadOffset = (lineEnd < 0 ? resolutionEnd : lineEnd) + 1
      if (bytes.length < payloadOffset + 1) throw new Error("INVALID_HDR_PAYLOAD")
      const format = text.match(/^FORMAT=(.+)$/m)?.[1]?.trim()
      if (format && format !== "32-bit_rle_rgbe" && format !== "32-bit_rle_xyze") throw new Error(`UNSUPPORTED_HDR_FORMAT: ${format}`)
      return { width: Number(resolution[2]), height: Number(resolution[1]), ...(format ? { encoding: format } : {}), encodingKind: format?.includes("xyze") ? "xyze" : "rgbe" }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 8 || view.getUint32(0, true) !== 0x01312f76) throw new Error("INVALID_EXR_HEADER")
    return { version: view.getUint32(4, true) & 0xff }
  } finally { await handle.close() }
}

function transformOf(node: any): Transform {
  if (node.matrix) {
    const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
    new Matrix4().fromArray(node.matrix).decompose(position, quaternion, scale)
    return { position: position.toArray() as Vec3, quaternion: quaternion.toArray(), scale: scale.toArray() as Vec3 }
  }
  return { position: node.translation ?? [0, 0, 0], quaternion: node.rotation ?? [0, 0, 0, 1], scale: node.scale ?? [1, 1, 1] }
}

export function sourceTransform(source: ResourceRef["source"]): Transform {
  if (source.handedness !== "right") throw new Error("SOURCE_COORDINATE_ADAPTER_REQUIRED: left-handed")
  const quaternion = new Quaternion()
  if (source.upAxis === "Y") quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
  else if (source.upAxis === "X") quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2)
  const scale = source.metersPerUnit ?? (source.units === "m" ? 1 : NaN)
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("SOURCE_UNIT_SCALE_REQUIRED")
  return { position: [0, 0, 0], quaternion: quaternion.toArray(), scale: [scale, scale, scale] }
}

export function glbEntities(ref: ResourceRef, parsed: ParsedAsset, rootId: string, name: string, pose = identityTransform()): Entity[] {
  // Skin骨骼与动画track须在同一装配树；逐node拆成独立实体会把骨骼引用留在GLTF缓存旧树上。
  // 静态GLB仍保持既有独立节点编辑；动画/skin由一个真实装配实例拥有原文件层级与mixer。
  if(parsed.metadata.animatedAssembly===true)return [{entityId:rootId,name,transform:pose,resources:[ref],components:{visual:{kind:'mesh',animatedAssembly:true}}}]
  const nodes = parsed.metadata.nodes as any[]
  const entities: Entity[] = [{ entityId: rootId, name, transform: pose, resources: [ref], components: { visual: { kind: "group" } } }]
  const sourceId = `${rootId}:source`
  entities.push({ entityId: sourceId, parentId: rootId, name: "源坐标转换", transform: sourceTransform(ref.source), resources: [], components: {} })
  const scenes = parsed.metadata.scenes as any[]
  const roots: number[] = scenes[Number(parsed.metadata.scene)]?.nodes ?? nodes.map((_, i) => i).filter(i => !nodes.some(n => n.children?.includes(i)))
  const visited = new Set<number>()
  function walk(index: number, parentId: string): void {
    if (visited.has(index)) throw new Error(`GLTF_NODE_CYCLE_OR_MULTI_PARENT: ${index}`)
    visited.add(index)
    const node = nodes[index]
    if (!node) throw new Error(`GLTF_NODE_MISSING: ${index}`)
    const entityId = `${rootId}:node:${index}`
    entities.push({ entityId, parentId, name: node.name ?? `节点 ${index}`, transform: structuredClone(transformOf(node)), resources: [ref], components: { visual: { kind: "mesh", gltfNode: index, sourceTransformApplied: true }, ...(node.extras ? { "gltf.extras": node.extras } : {}) } })
    for (const child of node.children ?? []) walk(child, entityId)
  }
  for (const index of roots) walk(index, sourceId)
  return entities
}

/** 机器人原件交给真实引擎。此显示描述只投影 MJCF/URDF 视觉，不注册业务资格。 */
export async function robotVisual(path: string, ancestors = new Set<string>()): Promise<Record<string, unknown>> {
  path = resolve(path)
  // 循环 include 会让展开永远递归；菱形 include（同一文件经不同分支到达）仍然允许。
  if (ancestors.has(path)) throw new Error(`ROBOT_INCLUDE_CYCLE: ${path}`)
  const document = readXml(await readFile(path, "utf8"))
  if (document.robot) return { format: "urdf", document: document.robot, baseUri: pathToFileURL(dirname(path) + "/").href }
  // 主文档必须是 `<mujoco>` 根（MuJoCo 对别的根报 "Unrecognized XML model type"）。没有 worldbody 的
  // 文档是合法的（实测能编译，只是画不出东西）：留给 Viewer 的 ROBOT_VISUAL_EMPTY 警告，这里不报错。
  if (!document.mujoco) throw new Error("INVALID_MJCF")
  return { format: "mjcf", document: (await expandMjcfDocument(path, new Set(ancestors))).sections, baseUri: pathToFileURL(dirname(path) + "/").href }
}

export { array, numbers }
