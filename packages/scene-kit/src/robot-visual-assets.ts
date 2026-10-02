/**
 * 机器人视觉的**文档资产引用 → 已授权媒体定位符**（DEV-PROJ-02）。
 *
 * 为什么需要这一层：`cbce00a` 起，场景在交给浏览器前会过一遍出站隐私投影
 * （`lyapunov-contracts/src/product-paths.ts:projectPathsOnly`，生产侧调用点只有
 * `lyapunov-shell/src/plugin.ts` 的 `state` / `scene` 两条路由）。投影只认识两种形状：
 * `uri` 键与 `file:` 串 → 不可逆标记 `res:<指纹>`；登记域内绝对路径 → `<域>/<相对>`。
 * 而机器人视觉是**文档内引用**：`viewer/src/robot.ts` 用 `composeAssetReference(meshdir, file)` +
 * `new URL(reference, baseUri)` 定位网格/贴图，两个输入都来自这份文档。`baseUri` 被换成标记之后
 * "相对引用"在浏览器里就没有基址可解了——**这份引用必须在服务端就地定位**。
 *
 * 本模块做且只做一件事：对 MJCF 实体，把 `document.asset.{mesh,texture}[i].file`
 * 换成**该文件的媒体标记**，并把同一条已登记表示补进 `resources[].representations`
 * （Viewer 的 `pairDocumentAssets` 靠"文档引用串 === 表示 uri"把装载器需要的 mimeType 取回来）。
 * 标记是媒体路由**既有的准入货币**：路由拿它对着该 Scene 的已授权候选集做等值匹配，
 * 匹配不上就拒绝。所以这里**不放宽任何授权**——本模块只对 `authorized` 索引里的成员发标记，
 * 而那个索引由调用方按"该实体自己已登记的资源 + 该文档的依赖闭包"构造；真正的闸门仍在路由。
 *
 * 三条不许越界的判据（越界就是改语义，不是修 bug）：
 *  1. **只改能原样保住 Viewer 侧键的行**：`robot.ts` 的资产表键是 `name ?? 文件名的去扩展名段`
 *     （`viewer/src/robot.ts:143-146`）。引用换成标记之后"文件名"就没了，所以**没有 `name` 的行一律不动**
 *     ——改了会换掉 `geom → mesh` 的映射，网格会整批变成 `MESH_ASSET_MISSING`（实测：panda 67 条里有 56 条无 `name`）。
 *  2. **只改已经在候选集里的件**：`authorized` 里没有的行原样留着，由既有的缺件通道如实上报。
 *  3. **不新增定位符语法**：写进去的就是 `product-paths.ts` 的 `res:<指纹>`，
 *     与 `uri` 键被投影之后得到的形状**逐字同一套**；不引入"标记+相对路径"这类第二套语法。
 */
import { dirname, extname, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import { resourceToken } from "../../lyapunov-contracts/src/product-paths.ts"
import { localPath } from "./formats.ts"

/**
 * 扩展名 → 声明 mimeType。**取值逐条对齐**生产者 `benchmark-libero/python/scene_projection.py:32-38`
 * 的 `VIEWER_MESH_MIME` / `VIEWER_TEXTURE_MIME`（官方投影对同一种件写的就是这几个值），
 * 反向表在 `viewer/src/asset-locator.ts:49` 的 `FORMAT_BY_MIME`——两张表由测试钉住，不靠人工同步。
 *
 * `.glb` 是这张表里唯一**官方投影不写**的一项（`VIEWER_MESH_MIME` 只有 stl/obj/dae）。为什么仍要在表里：
 * 用户导入的机器人文档里就有 `<mesh file="…glb">`（真件 `banana.xml`，见 `bugfixHistory/ROBOT-GLB-MESH-20260927.md`），
 * 而**声明 mimeType 是装载器分派的唯一依据**——引用一旦换成标记 `res:<指纹>`，定位符里就没有真名后缀可猜了。
 * 取值来自本仓自己的 GLB 生产者（`scene-kit/src/formats.ts` 的 GLB 分支写的 `model/gltf-binary`），
 * 与 `viewer/src/asset-locator.ts` 的反向表同值，且 `viewer/src/robot.ts` 确有 glb 装载分支（三者由测试钉住）。
 * 漏了这一行 ⇒ 该行被 `skip` ⇒ `pairDocumentAssets` 返回 `[]`（无声明可分派）⇒ 装载器只能回落定位符真名后缀、
 * 浏览器里留下 `ROBOT_VISUAL_REFERENCE_UNRESOLVED`（真件链读数见 `bugfixHistory/ROBOT-VISUAL-GLB-MIME-20260927.md`）。
 */
export const ROBOT_VISUAL_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".obj": "model/obj", ".stl": "model/stl", ".dae": "model/vnd.collada+xml", ".glb": "model/gltf-binary",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".bmp": "image/bmp", ".tga": "image/x-tga", ".webp": "image/webp",
}

/** 已授权候选串（`file:` URI 或绝对路径）→ **绝对路径** 的索引。同一件有多种写法时按优先级取一个。 */
export type AuthorizedAssetIndex = ReadonlyMap<string, string>

/**
 * 候选集 → 「绝对路径 → 候选串」索引。
 *
 * 优先级：`file:` 写法优先，绝对路径写法垫底（各自先来后到）。原因只有一条：写进文档的标记要与
 * `resources[].representations[].uri` 被投影后得到的标记**逐字相等**，所以能复用已登记表示的那条原串时
 * 一定复用——官方投影写的是 Python 的 `Path.as_uri()`，与 JS 的 `pathToFileURL` 在少见字符上
 * 并不保证逐字相同，不能靠"拼出来一样"来假定相等。
 */
export function authorizedAssetIndex(candidates: Iterable<string>): AuthorizedAssetIndex {
  const fileUris = new Map<string, string>(), paths = new Map<string, string>()
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue
    let path: string
    try { path = localPath(candidate) } catch { continue }   // `res:<指纹>` 这类非本地定位符不进索引
    if (candidate.startsWith("file:")) { if (!fileUris.has(path)) fileUris.set(path, candidate) }
    else if (!paths.has(path)) paths.set(path, candidate)
  }
  return new Map([...paths, ...fileUris])
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
/** 段可能是**数组**（同一份文档里出现多段 `<asset>`/`<compiler>`：本仓解析器保留重复段，G1 原件就有两段 `<asset>`）。 */
const sectionList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []
/** 解析器给单条资产时是对象、多条时是数组（与 `viewer/src/asset-locator.ts:156` 同一口径）。 */
const assetRows = (value: unknown): Record<string, unknown>[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []
/** 资产段属性：`meshdir`/`texturedir`，以及 MuJoCo 的 `assetdir` 兜底（与 `robot.ts:231/178` 同一条链）。 */
const directoryOf = (compiler: Record<string, unknown>, group: "mesh" | "texture"): string => {
  const value = group === "mesh" ? compiler.meshdir : compiler.texturedir
  if (typeof value === "string" && value) return value
  return typeof compiler.assetdir === "string" ? compiler.assetdir : ""
}
/** 已有 scheme 的引用（标记、`file:`、`package://`）一律不动：它本身就是绝对定位符。 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/

/** 机器人文档所在目录（**不含** meshdir）：`baseUri` 是 `file:` 时以它为准（与 Viewer 同一把基址）。 */
function documentDirectory(robot: Record<string, unknown>, entity: Record<string, unknown>): string | undefined {
  const baseUri = robot.baseUri
  if (typeof baseUri === "string" && baseUri.startsWith("file:")) {
    try { return resolvePath(fileURLToPath(new URL(".", baseUri))) } catch { /* 坏 baseUri 退回 sourcePath */ }
  }
  const components = entity.components
  for (const key of ["mujoco", "isaac"] as const) {
    const native = isRecord(components) ? components[key] : undefined
    const sourcePath = isRecord(native) ? native.sourcePath : undefined
    if (typeof sourcePath !== "string" || !sourcePath) continue
    try {
      const path = sourcePath.startsWith("file:") ? fileURLToPath(sourcePath) : sourcePath
      const directory = dirname(path)
      if (directory && directory !== ".") return resolvePath(directory)
    } catch { /* 继续找下一个 */ }
  }
  return undefined
}

export interface RobotAssetLocatorFacts {
  /** 被改写的实体数（只要有一条引用被改写就计 1）。 */
  entities: number
  meshes: number
  textures: number
  /** 看见了但没改写的引用条数：没有 `name`（改了会换掉 Viewer 侧键）、不在候选集里、或扩展名不在 mimeType 表里。 */
  skipped: number
}

/**
 * 单个实体的改写。返回的实体是**副本**（只沿被改写的路径复制，原对象不被改写）；
 * 没有任何一条被改写时**原样返回入参**（`result.entity === entity`）。
 */
export function robotDocumentAssetLocators(entity: unknown, authorized: AuthorizedAssetIndex): { entity: unknown; facts: RobotAssetLocatorFacts } {
  const facts: RobotAssetLocatorFacts = { entities: 0, meshes: 0, textures: 0, skipped: 0 }
  if (!isRecord(entity)) return { entity, facts }
  const components = entity.components
  const visual = isRecord(components) ? components.visual : undefined
  const robot = isRecord(visual) ? visual.robot : undefined
  const document = isRecord(robot) ? robot.document : undefined
  const sections = isRecord(document) ? sectionList(document.asset) : []
  // 只认 MJCF：URDF 的 `<mesh filename>` 没有 `asset` 段，Viewer 那条路也不查声明（见回执"未覆盖"）。
  if (!isRecord(visual) || visual.kind !== "robot" || !isRecord(robot) || !isRecord(document) || !sections.length) return { entity, facts }
  const directory = documentDirectory(robot, entity as Record<string, unknown>)
  if (!directory) return { entity, facts }
  const compiler = Object.assign({}, ...sectionList(document.compiler)) as Record<string, unknown>

  const nextSections = [...sections]
  const added: Array<{ uri: string; mimeType: string; role: string }> = []
  let changed = false
  sections.forEach((section, sectionIndex) => {
    const nextSection: Record<string, unknown> = { ...section }
    for (const group of ["mesh", "texture"] as const) {
      const source = section[group]
      const rows = assetRows(source)
      if (!rows.length) continue
      const prefix = directoryOf(compiler, group)
      let groupChanged = false
      const mapped = rows.map(row => {
        const reference = row.file
        const name = row.name
        const skip = (): Record<string, unknown> => { facts.skipped++; return row }
        // 判据 ①：Viewer 的键由 `name` 给；没有 `name` 的行改了引用就换了键，一律不动。
        if (typeof reference !== "string" || !reference || SCHEME.test(reference) || typeof name !== "string" || !name) return skip()
        const mimeType = ROBOT_VISUAL_MIME_BY_EXTENSION[extname(reference).toLowerCase()]
        if (!mimeType) return skip()
        // MuJoCo 语义：绝对路径**不受 meshdir 影响**（`formats.ts:282` 的依赖闭包同一条规则）。
        const absolute = ABSOLUTE.test(reference) ? resolvePath(reference) : resolvePath(directory, prefix, reference)
        // 判据 ②：只对已授权件发标记。真正的闸门仍是媒体路由的候选集，这里只是**提前**判据。
        const candidate = authorized.get(absolute)
        if (!candidate) return skip()
        facts[group === "mesh" ? "meshes" : "textures"]++
        added.push({ uri: candidate, mimeType, role: "visual" })
        groupChanged = true
        return { ...row, file: resourceToken(candidate) }
      })
      if (!groupChanged) continue
      changed = true
      nextSection[group] = Array.isArray(source) ? mapped : mapped[0]
    }
    if (nextSection !== section) nextSections[sectionIndex] = nextSection
  })
  if (!changed) return { entity, facts }
  facts.entities = 1
  const resources = Array.isArray(entity.resources) ? entity.resources : []
  const mimeOf = (value: unknown): string[] => assetRows(value).flatMap(row => typeof row.mimeType === "string" ? [row.mimeType] : [])
  // 表示补进**携带机器人文档的那条资源**（找不到就退到第一条）；`pairDocumentAssets` 跨全部引用收集，位置不影响判据。
  const owner = resources.findIndex(ref => isRecord(ref) && [...mimeOf(ref.original), ...mimeOf(ref.representations)].some(mime => ["application/x-mjcf+xml", "application/x-urdf+xml"].includes(mime)))
  const nextResources = resources.map((ref, index) => {
    if (index !== (owner >= 0 ? owner : 0) || !isRecord(ref)) return ref
    const representations = Array.isArray(ref.representations) ? [...ref.representations] : []
    const existing = new Set(representations.flatMap(row => isRecord(row) && typeof row.uri === "string" ? [row.uri] : []))
    for (const rep of added) if (!existing.has(rep.uri)) { representations.push(rep); existing.add(rep.uri) }
    return { ...ref, representations }
  })
  return { entity: { ...entity, resources: nextResources, components: { ...(components as Record<string, unknown>), visual: { ...visual, robot: { ...robot, document: { ...document, asset: Array.isArray(document.asset) ? nextSections : nextSections[0] } } } } }, facts }
}

/** 整场改写（`scene.entities` 逐实体）。只沿被改写的路径复制；没有任何改写时 `scene` 原样返回。 */
export function sceneRobotDocumentAssetLocators(scene: unknown, authorized: AuthorizedAssetIndex): { scene: unknown; facts: RobotAssetLocatorFacts } {
  const facts: RobotAssetLocatorFacts = { entities: 0, meshes: 0, textures: 0, skipped: 0 }
  if (!isRecord(scene) || !Array.isArray(scene.entities)) return { scene, facts }
  let changed = false
  const entities = scene.entities.map(entity => {
    const result = robotDocumentAssetLocators(entity, authorized)
    if (result.entity !== entity) changed = true
    facts.entities += result.facts.entities
    facts.meshes += result.facts.meshes
    facts.textures += result.facts.textures
    facts.skipped += result.facts.skipped
    return result.entity
  })
  return { scene: changed ? { ...scene, entities } : scene, facts }
}
