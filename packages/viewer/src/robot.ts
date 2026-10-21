import * as THREE from "three"
import { STLLoader } from "three/addons/loaders/STLLoader.js"
import { OBJLoader } from "three/addons/loaders/OBJLoader.js"
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js"
import type { GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { createGltfLoader } from "./draco-decoder.ts"
import type { Ktx2SupportProbe } from "./ktx2-decoder.ts"
import { assetFormatOf, composeAssetReference, describeAssetReference, documentReferenceLocator, hasLocatorScheme } from "./asset-locator.ts"

const list = <T>(value?: T | T[]): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const nums = (value: unknown, defaults: number[]) => typeof value === "string" ? value.trim().split(/\s+/).map(Number) : defaults
/** 展示层炸开的位移尺度：整机包围盒对角线的这个比例 × spread。纯显示，不写任何原生矩阵。 */
const EXPLODE_RADIUS_FACTOR = 0.35
/** 重复的顶层段（解析器给成数组时）按出现顺序逐段取值；G1 原件就是两段 `<asset>`、两段 `<worldbody>`。 */
const sectionItems = (sections: any, key: string): any[] => list<any>(sections).flatMap(section => list<any>(section?.[key]))
/** 段属性合并成一份（后出现的段覆盖先出现的），供 `compiler.angle`／`meshdir` 这类读取。 */
const sectionAttributes = (sections: any): Record<string, any> => Object.assign({}, ...list<any>(sections))
/**
 * STL 的存储法线不可全信。MuJoCo 装载 STL 时**忽略文件里的 facet normal**、按三角形环绕
 * 方向自算顶点法线；`STLLoader` 却把存储法线逐字拷进 `normal` 属性。真件 unitree_go1 的
 * hip/thigh/thigh_mirror/calf 四个 STL 存储法线**整批是零向量**（Unitree 导出件的已知形态），
 * 直接采用 ⇒ 腿在 PBR 下没有光照方向可算、渲染成纯黑（trunk.stl 法线正常 ⇒ 出现
 * "机身亮、四腿全黑"）。这里按 MuJoCo 同一条口径修复：**多数**面的存储法线对不上环绕
 * 方向（零向量或反向）时按环绕方向重算（非索引几何的 `computeVertexNormals` 逐面取
 * 环绕法线，索引几何同样以 index 序为准）；一致或仅个别面异常的件原样不动。
 * 法线缺失时同样重算（否则 PBR 无光照方向可算）。
 */
function repairStlNormals(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position")
  if (!position || position.count < 3) return
  const normal = geometry.getAttribute("normal")
  if (!normal) { geometry.computeVertexNormals(); return }
  const index = geometry.getIndex()
  const count = index ? index.count : position.count
  const vertexOf = (i: number): number => index ? index.getX(i) : i
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const winding = new THREE.Vector3(), edge = new THREE.Vector3(), stored = new THREE.Vector3()
  let bad = 0, checked = 0
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = vertexOf(i), i1 = vertexOf(i + 1), i2 = vertexOf(i + 2)
    a.fromBufferAttribute(position, i0); b.fromBufferAttribute(position, i1); c.fromBufferAttribute(position, i2)
    winding.copy(b).sub(a); edge.copy(c).sub(a); winding.cross(edge)
    if (winding.lengthSq() < 1e-24) continue   // 退化面（顶点共线）不计票
    checked++
    stored.fromBufferAttribute(normal, i0)
    if (winding.dot(stored) <= 0) bad++        // 零向量或背向：都对不上环绕方向
  }
  if (bad > checked / 2) geometry.computeVertexNormals()
}
interface Joint { node: THREE.Object3D; base: THREE.Matrix4; axis: THREE.Vector3; kind: string; origin: THREE.Vector3 }
/**
 * 一个**真实部件**（R-011 部件级选择的最小身份）。
 *
 * 身份不靠显示名：`partId` 由"类型 + 文档里的下标路径"构成（`body:0.2.1` / `link:3`），
 * 同一份文档里两个同名 body/link 也各有各的 id；`name`/`path` 只用于展示。
 *
 * **展示层与原生层分离**：`node` 是原生 body/link 节点（FK/相机挂载/TCP/碰撞全部读它，炸开不改它）；
 * `presentation` 是它的可视几何所在的子组，炸开偏移只写 `presentation.position`，因此原生矩阵
 * 一个数都不动。世界位姿由原生 `node` 决定，展开姿态不会被下一帧 FK 覆盖，也不会回灌给 sim。
 */
export interface RobotPart {
  partId: string
  name: string
  kind: "body" | "link"
  /** 从机器人根到该部件的原生名字路径（仅展示用，不参与身份）。 */
  path: string[]
  /** 这个部件有自己的可视几何（可被炸开展示）；纯变换节点为 false。 */
  hasVisual: boolean
  /** `hierarchy` = 真实 body/link 关节层级；`single` = 单网格容器（不虚构可拆面）。 */
  granularity: "hierarchy" | "single"
  /** 原生节点（FK 真相所在）。 */
  node: THREE.Object3D
  /** 展示层节点：可视几何挂在这里，炸开偏移只写它。 */
  presentation: THREE.Object3D
}
export interface RobotVisual {
  root: THREE.Group
  rootFrameInverse: THREE.Matrix4
  setJoints(names: string[], positions: number[]): void
  setBodyWorldPoses(poses: unknown, documentWorldMatrix?: THREE.Matrix4): void
  /** body 名 → 场景图节点（相机视锥 S2 结构化挂载用：挂到它下面即随 FK 走，不逐帧重算）。MJCF body 与 URDF link 同名共用。 */
  bodyNode(bodyName: string): THREE.Object3D | undefined
  projectedDocumentMatrix(): THREE.Matrix4 | undefined
  resetPose(): void
  setCollisionVisible(visible: boolean): void
  warnings: string[]
  /** 真实部件目录（MJCF body / URDF link），身份稳定、与显示名无关。 */
  parts: RobotPart[]
  /**
   * 只读展示层炸开：`spread` 0→1。每次调用先**把全部展示偏移归零**、按当前装配位姿重算基准，
   * 再从头写入新偏移，因此天然可逆、不会逐帧累加。原生 `node` 矩阵（FK/相机/碰撞）一个数都不改。
   * `spread=0` 等价于 `restore`（全部归零）。
   */
  setExplodeSpread(spread: number): void
  /** 当前展示层展开比例（0 = 合拢）。 */
  explodeSpread(): number
  /** 当前实际写入的展示偏移（partId → 该部件展示组的局部平移），供观察元数据/验收读取。 */
  explodeOffsets(): ReadonlyMap<string, [number, number, number]>
}

/**
 * `buildRobotVisual()` 的**可选**第三个入参（不传 = 与旧签名逐项同行为）。
 *
 * 为什么要它：机器人文档里的 `.glb` 网格可能与主场景的 `.glb` 一样带压缩扩展，而 KTX2
 * （`KHR_texture_basisu`）的转码目标格式由**渲染器的压缩纹理扩展能力**决定 —— `KTX2Loader` 在没
 * `detectSupport(renderer)` 过时 `workerConfig === null`，`load()` 会抛
 * `Missing initialization with '.detectSupport( renderer )'`，**而那个抛会被 `GLTFLoader` 吞成 null**
 * （几何照建、贴图静默丢失，见 `ktx2-decoder.ts` 模块头与 `draco-decoder.ts` 的 `GltfLoaderOptions`）。
 * 本函数是纯函数、手里没有 renderer ⇒ 由调用方（`index.ts` 传的是本 Viewer 自己的 `renderer`）带进来。
 *
 * **不传 renderer 也不会静默**：真遇到带贴图的 `.glb` 时逐件核对"glTF 声明的贴图数 vs 装载后挂上的张数"，
 * 差一张就写一条 `ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED`（明确报错），几何照旧可见。
 */
export interface RobotVisualOptions {
  renderer?: Ktx2SupportProbe
}

export async function buildRobotVisual(input: any, resolveURI: (uri: string) => Promise<string> | string, options: RobotVisualOptions = {}): Promise<RobotVisual> {
  const root = new THREE.Group()
  const joints = new Map<string, Joint>()
  const bodies = new Map<string, { node: THREE.Object3D; base: THREE.Matrix4; stages?: THREE.Object3D[] }>()
  const hiddenCollisionGeoms: THREE.Object3D[] = []
  let projectingBodies = false
  const warnings: string[] = []
  const tasks: Promise<void>[] = []
  let frameAnchor: THREE.Object3D | undefined
  /** 实际建出的可视节点数（MJCF 的 geom 容器、URDF 的 visual 容器）。0 就是"没有内容可显示"。 */
  let visualNodes = 0
  /** 真实部件目录（原生节点 + 展示层组）。 */
  const parts: RobotPart[] = []
  let explodeSpreadValue = 0
  const presentationOffsets = new Map<string, [number, number, number]>()
  /**
   * 展示层炸开：先把全部展示组归零、刷新世界矩阵取**装配基准**，再按"部件中心相对机器人中心"
   * 的确定方向写入平移。方向与半径都来自这一次的原生矩阵（不是上一帧的展示结果），所以反复
   * 0→中间→最大→0 不会累计漂移；`spread=0` 就是完全合拢。
   */
  function setExplodeSpread(spread: number): void {
    const value = Number.isFinite(spread) ? Math.max(0, Math.min(1, spread)) : 0
    for (const part of parts) part.presentation.position.set(0, 0, 0)
    presentationOffsets.clear()
    root.updateWorldMatrix(true, true)
    if (value <= 0) { explodeSpreadValue = 0; return }
    // 基准只用**部件自己的可视几何**（不含 worldbody 的静态地面/墙）：用整棵 root 会让一块 20 m
    // 的参考地板把机器人包围盒撑大，展开位移量级失控。每个部件中心也只取自己的展示组（不含子树）。
    const partBoxes = new Map<string, THREE.Box3>()
    const robotBox = new THREE.Box3()
    for (const part of parts) {
      if (!part.hasVisual) continue
      part.presentation.updateWorldMatrix(true, false)
      const partBox = new THREE.Box3().setFromObject(part.presentation)
      if (partBox.isEmpty()) continue
      partBoxes.set(part.partId, partBox)
      robotBox.union(partBox)
    }
    if (robotBox.isEmpty()) { explodeSpreadValue = value; return }
    const center = robotBox.getCenter(new THREE.Vector3())
    const radius = Math.max(robotBox.getSize(new THREE.Vector3()).length() * 0.5, 1e-6)
    const distance = radius * EXPLODE_RADIUS_FACTOR * value
    for (const part of parts) {
      const partBox = partBoxes.get(part.partId)
      if (!partBox) continue
      const direction = partBox.getCenter(new THREE.Vector3()).sub(center)
      if (direction.lengthSq() < 1e-12) continue
      direction.normalize().multiplyScalar(distance)
      const parent = part.presentation.parent
      if (!parent) continue
      parent.updateWorldMatrix(true, false)
      const basis = new THREE.Matrix4().copy(parent.matrixWorld)
      basis.setPosition(0, 0, 0)
      part.presentation.position.copy(direction.applyMatrix4(basis.invert()))
      presentationOffsets.set(part.partId, part.presentation.position.toArray() as [number, number, number])
    }
    explodeSpreadValue = value
    root.updateWorldMatrix(true, true)
  }
  // 贴图与基色是**相乘**关系（MuJoCo 的 "texture color is combined with the object color in
  // GL_MODULATE mode"），所以基色仍按材质/geom 的 rgba 走，贴图只负责纹理细节。
  const material = (rgba?: string, map?: THREE.Texture | null) => {
    const color = nums(rgba, [0.36, 0.58, 0.8, 1])
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(color[0]!, color[1]!, color[2]!), map: map ?? null, opacity: color[3] ?? 1, transparent: (color[3] ?? 1) < 1, roughness: 0.65, metalness: 0.1 })
  }
  /**
   * 相对引用 + 不可用的基址 ⇒ 只有媒体路由能解析（出站投影把 `baseUri` 换成了不可逆标记）。
   * 如实记一条**判据缺失**（去重），不抛 `TypeError: … cannot be parsed as a URL`——那句话读起来像
   * "文档坏了"，实际是定位符里已经没有可解析的层级了（P15 实测 52 条网格 + 贴图全是这个形状）。
   */
  const unresolvedWarned = new Set<string>()
  function noteUnresolved(file: string): void {
    if (unresolvedWarned.has(file)) return
    unresolvedWarned.add(file)
    warnings.push(`ROBOT_VISUAL_REFERENCE_UNRESOLVED: ${file}（文档里是相对引用，但 baseUri 不是可解析的基址：${String(input.baseUri)}——出站投影把基址换成了不可逆标记，相对解析只能由媒体路由做）`)
  }
  /** 被 MJCF 调制色替换掉的 `.glb` 自带贴图（去重：同一份网格可能被多个图元引用）。 */
  const overriddenTextures = new Set<string>()
  /**
   * glTF 声明了贴图、但装载后**没挂上** ⇒ **明确报错**，不许静默（ROBOT-GLB-KTX2-TEXTURE-20260927）。
   *
   * 判据是两件可读事实，不是猜：`parser.json.textures` 是**容器声明的**张数；`parser.associations`
   * 里带 `textures` 的条目是**真的建出来了**的（three 只在贴图加载成功的 `.then()` 里
   * `associations.set(texture, { textures: index })`，见 `GLTFLoader.js` 的 `loadTextureImage`）。
   * 挂少了就说明贴图链上有失败被吞掉了 —— 那条链的尾部是 `.catch(function () { return null; })`
   * （`GLTFLoader.js:3349-3353`），KTX2 转码器的初始化抛错正是死在这里：几何照建、`loadAsync()`
   * 照样 resolve、`warnings` 为空 ⇒ 用户看到的是"机器人没有贴图"，而不是任何报错。
   */
  function noteTexturesNotAttached(gltf: GLTF, reference: string): void {
    const declared: number = gltf.parser.json?.textures?.length ?? 0
    if (!declared) return
    const attached = new Set<number>()
    for (const association of gltf.parser.associations.values()) {
      if (typeof association?.textures === "number") attached.add(association.textures)
    }
    if (attached.size >= declared) return
    const cause = options.renderer
      ? "装载时有失败被 GLTFLoader 吞掉（`GLTFLoader.js` 的 `.catch(() => null)`；控制台会有一行 `THREE.GLTFLoader: Couldn't load texture`）"
      : "本次调用没传 renderer ⇒ KTX2Loader 没做过 `detectSupport` 能力探测，转码器抛的初始化错误被 GLTFLoader 吞掉"
    // `.glb` 自己声明的**外部** buffers/images：机器人依赖闭包（`robotDependencies`）只收 `.glb` 本身，
    // 这些伴生文件登记不上 ⇒ 媒体路由不会给字节。真遇到时把它们的名字念出来，才查得下去
    // （`parseAsset(".glb")` 那条路是收的，两条路的闭包口径不一致，已登记在回执里）。
    const external: string[] = []
    for (const item of [...(gltf.parser.json?.buffers ?? []), ...(gltf.parser.json?.images ?? [])]) {
      const uri: unknown = item?.uri
      if (typeof uri === "string" && !uri.startsWith("data:") && !external.includes(uri)) external.push(uri)
    }
    const companion = external.length
      ? `；该容器还声明了外部文件 ${external.join("、")}——机器人依赖闭包只收 .glb 本身，这些伴生文件登记不上就取不到字节`
      : ""
    warnings.push(`ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED: ${reference}（glTF 声明 ${declared} 张贴图，装载后只挂上 ${attached.size} 张：${cause}${companion}；几何照旧可见）`)
  }
  /**
   * 机器人文档里的 **GLB** 装载器（懒建、本函数作用域单例）。
   *
   * 复用 Viewer 自己那条 `createGltfLoader()`（`draco-decoder.ts`：DRACO 解码器**内联**在客户端产物里）——
   * 这里**不新开**第二条 glTF 读取路径、更不裸 `new GLTFLoader()`：裸构造遇到
   * `KHR_draco_mesh_compression` 会在构造期抛 `No DRACOLoader instance provided`（上一单的根因，
   * `bugfixHistory/GLB-DRACO-RENDER-20260926.md`），整件网格直接建不出来。
   *
   * 单例的理由与 Viewer 侧逐字相同：`DRACOLoader` 初始化解码器会起 worker 池（默认 4 个），
   * 一个网格一个装载器会起一堆。解码器**懒初始化**：不带 Draco 的 `.glb`（本单真件就是）走这条路时
   * 一次也不建 worker、一次网络请求也不发。
   *
   * 工厂的入参是 `RobotVisualOptions` 里的 `renderer`（调用方带进来，见该接口的注释）：KTX2 转码
   * 需要渲染器能力探测，这一条**不能省**，否则贴图静默丢失。
   *
   * 生命周期：随页面存活（`RobotVisual` 没有 dispose 钩子 ⇒ 这里没有释放点，已如实登记在回执里）。
   */
  let gltfMeshLoader: GLTFLoader | undefined
  /**
   * `file` 是**含 meshdir 前缀**的文档引用；`declarationKey` 是文档里的原始引用串
   * （`document.asset.mesh[i].file`，与 `pairDocumentAssets` 同一把键），用来查登记声明的 mimeType。
   * 装载器分派看**声明**而不是定位符串：出站投影把引用换成 `res:<指纹>` 之后，原来的 `\.stl$` 判据恒不成立。
   *
   * 四个分支与 `asset-locator.ts:ASSET_FORMATS` 里**已接线**的那几个一一对应（stl/obj/dae/glb）；
   * 没接线的格式如实抛 `UNSUPPORTED_ROBOT_VISUAL_MESH`，不静默回落成空节点。
   */
  async function loadMesh(file: string, declarationKey: string = file): Promise<THREE.Object3D> {
    const mimeType = (input.assetDeclarations as Map<string, string> | undefined)?.get(declarationKey)
    const format = assetFormatOf({ mimeType, locator: file })
    const { locator, based } = documentReferenceLocator(file, input.baseUri)
    if (!based && !hasLocatorScheme(file)) noteUnresolved(file)
    const url = await resolveURI(locator)
    if (format === "stl") {
      const geometry = await new STLLoader().loadAsync(url)
      repairStlNormals(geometry)
      return new THREE.Mesh(geometry, material())
    }
    if (format === "obj") return new OBJLoader().loadAsync(url)
    if (format === "dae") return (await new ColladaLoader().loadAsync(url)).scene
    // GLB：`robotDependencies` 已把 `.glb` 收进依赖闭包（媒体路由候选集里因此有它），
    // 这里只负责把它交给**带解码器**的那一个装载器。`gltf.scene` 是整棵 glTF 场景图
    // （真件 `banana.glb`：1 node / 1 mesh / 5,993 顶点），不是单个 Mesh ⇒ 由调用方 traverse 上材质。
    //
    // ⚠️ `renderer` 必须带进工厂：不带的话 KTX2（`KHR_texture_basisu`）贴图会**静默丢失**
    // （`KTX2Loader` 没探测过能力就抛，而那个抛被 `GLTFLoader` 吞成 null）——`noteTexturesNotAttached`
    // 把那种"静默"变成一条明确警告（ROBOT-GLB-KTX2-TEXTURE-20260927）。
    if (format === "glb") {
      const gltf = await (gltfMeshLoader ??= createGltfLoader({ renderer: options.renderer })).loadAsync(url)
      noteTexturesNotAttached(gltf, file)
      return gltf.scene
    }
    throw new Error(`UNSUPPORTED_ROBOT_VISUAL_MESH: ${describeAssetReference(file, { mimeType, format })}`)
  }
  // 贴图按文件路径缓存（含失败）：同一张图被多个材质引用时只解码一次。使用时 clone()，
  // repeat/wrap 归各自所有；three 的 Source 机制保证同一张 image 只上传一次显存。
  const textureSources = new Map<string, Promise<THREE.Texture>>()
  function loadTexture(file: string, colorspace?: string): Promise<THREE.Texture> {
    let pending = textureSources.get(file)
    if (!pending) {
      pending = (async () => {
        const { locator, based } = documentReferenceLocator(file, input.baseUri)
        if (!based && !hasLocatorScheme(file)) noteUnresolved(file)
        const url = await resolveURI(locator)
        const texture = await new THREE.TextureLoader().loadAsync(url)
        // MJCF texture colorspace：sRGB 表示文件里是 sRGB 编码的 albedo（PNG 未标注时的默认），
        // linear 表示文件里已是线性值。Viewer 的 outputColorSpace 是 SRGB，标错会让整张贴图
        // 偏亮/偏暗（sRGB 当 linear 读偏亮，反之偏暗）。auto/未声明按非 cube 贴图的常规当 sRGB。
        texture.colorSpace = colorspace === "linear" ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
        // 2D 纹理在 MJCF 里就是铺开的图案（texrepeat 控制重复次数），不能停在 clamp 边缘。
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping
        return texture
      })()
      textureSources.set(file, pending)
    }
    return pending
  }
  /** 材质 texrepeat，默认 "1 1"。 */
  const texrepeatOf = (spec: any): [number, number] => {
    const repeat = nums(spec?.texrepeat, [1, 1])
    return [repeat[0] ?? 1, repeat[1] ?? 1]
  }
  function pose(node: THREE.Object3D, value: any, degrees = false): void {
    node.position.fromArray(nums(value.pos ?? value.xyz, [0, 0, 0]))
    if (value.quat) { const q = nums(value.quat, [1, 0, 0, 0]); node.quaternion.set(q[1]!, q[2]!, q[3]!, q[0]!).normalize() }
    else if (value.euler || value.rpy) {
      const q = nums(value.euler ?? value.rpy, [0, 0, 0]).map(x => x * (degrees ? Math.PI / 180 : 1))
      node.quaternion.setFromEuler(new THREE.Euler(q[0]!, q[1]!, q[2]!, "XYZ"))
    } else if (value.axisangle) {
      const aa = nums(value.axisangle, [0, 0, 1, 0])
      node.quaternion.setFromAxisAngle(new THREE.Vector3(aa[0], aa[1], aa[2]).normalize(), aa[3]! * (degrees ? Math.PI / 180 : 1))
    }
  }
  function primitive(geom: any): THREE.Object3D {
    const size = nums(geom.size, [0.05, 0.05, 0.05])
    const fromto = geom.fromto ? nums(geom.fromto, []) : undefined
    const start = fromto ? new THREE.Vector3(...fromto.slice(0, 3) as [number, number, number]) : undefined
    const end = fromto ? new THREE.Vector3(...fromto.slice(3, 6) as [number, number, number]) : undefined
    const length = start && end ? start.distanceTo(end) : (size[1] ?? size[0]!) * 2
    let geometry: THREE.BufferGeometry
    if (geom.type === "box") geometry = new THREE.BoxGeometry(size[0]! * 2, (size[1] ?? size[0]!) * 2, (size[2] ?? size[0]!) * 2)
    else if (geom.type === "cylinder") geometry = new THREE.CylinderGeometry(size[0], size[0], length, 24).rotateX(Math.PI / 2)
    else if (geom.type === "capsule") geometry = new THREE.CapsuleGeometry(size[0], length, 6, 18).rotateX(Math.PI / 2)
    else if (geom.type === "plane") geometry = new THREE.PlaneGeometry((size[0] || 10) * 2, (size[1] || 10) * 2)
    else if (geom.type === "ellipsoid") geometry = new THREE.SphereGeometry(1, 24, 16).scale(size[0]!, size[1] ?? size[0]!, size[2] ?? size[0]!)
    else geometry = new THREE.SphereGeometry(size[0], 24, 16)
    const object = new THREE.Mesh(geometry, material(geom.rgba))
    if (start && end) {
      object.position.copy(start).add(end).multiplyScalar(0.5)
      object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(start).normalize())
    }
    return object
  }
  if (input.format === "mjcf") {
    const doc = input.document
    const compiler = sectionAttributes(doc.compiler)
    const degrees = compiler.angle !== "radian"
    const defaults = new Map<string, any>()
    function defaultTree(value: any, inherited: any = {}): void {
      for (const item of list<any>(value)) {
        const merged = { geom: { ...inherited.geom, ...item.geom }, joint: { ...inherited.joint, ...item.joint }, mesh: { ...inherited.mesh, ...item.mesh }, material: { ...inherited.material, ...item.material }, texture: { ...inherited.texture, ...item.texture } }
        defaults.set(item.class ?? "", merged)
        defaultTree(item.default, merged)
      }
    }
    defaultTree(doc.default)
    const assets = new Map(sectionItems(doc.asset, "mesh").map(item => {
      const mesh = { ...defaults.get(item.class ?? "")?.mesh, ...item }
      return [mesh.name ?? mesh.file?.split("/").pop()?.replace(/\.[^.]+$/, ""), mesh]
    }))
    const materials = new Map(sectionItems(doc.asset, "material").map(item => {
      const spec = { ...defaults.get(item.class ?? "")?.material, ...item }
      return [spec.name, spec]
    }))
    // texuniform=true 时纹理按「每米重复 texrepeat 次」铺（与该图元尺寸无关）；plane 的 UV 覆盖
    // 整张面，直接乘面边长即可；box 每个面的 (u,v) 边长不同，逐面烘进 UV（此时 repeat 留 1）。
    // sphere/capsule/cylinder/ellipsoid 的官方映射用经纬坐标，这里不假装等价，退回 texrepeat。
    function uniformRepeatUV(geometry: THREE.BufferGeometry, geom: any, repeat: [number, number]): [number, number] | undefined {
      const size = nums(geom.size, [0.05, 0.05, 0.05])
      if (geom.type === "plane") return [(size[0] || 10) * 2 * repeat[0], (size[1] || 10) * 2 * repeat[1]]
      if (geom.type !== "box") return undefined
      const uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined
      // three 的 BoxGeometry 逐面 4 顶点，面序 +x,-x,+y,-y,+z,-z；每面的 u/v 轴见其 buildPlane 参数。
      const faces: [number, number][] = [
        [(size[2] ?? 0) * 2, (size[1] ?? 0) * 2], [(size[2] ?? 0) * 2, (size[1] ?? 0) * 2],
        [(size[0] ?? 0) * 2, (size[2] ?? 0) * 2], [(size[0] ?? 0) * 2, (size[2] ?? 0) * 2],
        [(size[0] ?? 0) * 2, (size[1] ?? 0) * 2], [(size[0] ?? 0) * 2, (size[1] ?? 0) * 2],
      ]
      if (!uv || uv.count < faces.length * 4) return undefined
      for (let face = 0; face < faces.length; face++) {
        const [scaleU, scaleV] = [faces[face]![0] * repeat[0], faces[face]![1] * repeat[1]]
        for (let index = face * 4; index < face * 4 + 4; index++) uv.setXY(index, uv.getX(index) * scaleU, uv.getY(index) * scaleV)
      }
      uv.needsUpdate = true
      return [1, 1]
    }
    // 纹理是独立 asset，材质用名字引用它。texrepeat/texuniform 长在 material 上，色空间长在 texture 上。
    const textureAssets = new Map(sectionItems(doc.asset, "texture").map(item => {
      const texture = { ...defaults.get(item.class ?? "")?.texture, ...item }
      return [texture.name, texture]
    }))
    const texturePrefix = compiler.texturedir ?? compiler.assetdir ?? ""
    function geomNode(item: any, parent: THREE.Object3D, childClass?: string): void {
      const geom = { ...defaults.get(item.class ?? childClass ?? "")?.geom, ...item }
      // 颜色随**材质**走，而不是随图元：编译投影里 geom rgba 是 0.5 占位灰（官方编译模型的
      // geom_rgba 就长这样），真实外观在同名 material 上。
      //
      // 官方侧读数（`official_rgba_ablation2.py`，另见 `official-ablation/rgba-ablation.json`；
      // 两份脚本的均值口径不同，数字不互相替代）：
      //  · 把 14 个带纹理图元的 `geom_rgba` 从 0.5 改成 1.0，agentview **逐像素 0 变化**；
      //  · 把它们的 `mat_rgba` 改成 0.5，**93.8% 像素变化**（该脚本把 alpha 也写成了 0.5，
      //    属半透明效应；验收队把 alpha 固定 1.0、只改 RGB 重跑是 **93.85% / mean|Δ| 64.789**）。
      // ⇒ 调制色由**材质**决定，这个定性结论两种口径下都成立。
      const spec = geom.material ? materials.get(geom.material) : undefined
      // 材质色优先，geom rgba 只作回落（既有语义：没有材质的图元走自己的 rgba）。
      if (spec?.rgba) geom.rgba = spec.rgba
      /**
       * 调制色：**引用了 material 就用材质色**（材质未声明 rgba ⇒ 官方编译默认值**白 `1 1 1 1`**）；
       * **只有完全没引用 material 的图元**才走 `geom.rgba`。与贴图有没有挂上无关。
       *
       * 依据：官方 `mjv_updateScene` 出来的 `mjvGeom.rgba`（真正参与着色的有效色）实测规则是
       * 「图元 rgba 是默认占位灰 ⇒ 用材质 rgba，否则用图元 rgba」，**与材质有没有纹理无关**；
       * 本案投影文档里凡引用 material 的图元其 `geom.rgba` 全是 `0.5 0.5 0.5 1` 占位灰
       * （机器人 65 个图元逐一核过），所以两条口径在本案逐图元等价。
       * 旧写法 `map && spec?.texture ? "1 1 1 1" : geom.rgba` 把「材质没写 rgba 又没贴图」的图元
       * （本案机器人 21 个）画成 0.5 灰，而官方是白 —— 那是本轮修掉的残留（验收报告 C1）。
       */
      const modulation: string | undefined = spec ? (spec.rgba ?? "1 1 1 1") : geom.rgba
      const container = new THREE.Group()
      container.name = geom.name ?? geom.type ?? "geom"
      pose(container, geom, degrees)
      // 只有声明了官方碰撞分组语义的调用方才隐藏 group 0。普通 MJCF 的可见
      // 图元同样默认属于 group 0，不能因官方环境的显示约定而全局隐藏。
      const hiddenGroup = Number(geom.group) === 3 || (input.hideCollisionGeoms === true && Number(geom.group ?? 0) === 0)
      const collides = Number(geom.contype ?? 1) !== 0 || Number(geom.conaffinity ?? 1) !== 0
      container.visible = !hiddenGroup || (collides && input.showCollisionGeoms === true)
      if (hiddenGroup && collides) hiddenCollisionGeoms.push(container)
      parent.add(container)
      visualNodes++
      // 材质引用的纹理（官方投影已把 PNG 字节复制到 derived 目录并在片段里写成绝对路径）。
      // 失败只记一条警告：几何照旧可见，外观退回**材质色**（材质未声明 rgba ⇒ 白）。
      const texture = ((): Promise<THREE.Texture | null> | undefined => {
        const asset = spec?.texture ? textureAssets.get(spec.texture) : undefined
        if (!asset?.file) return undefined
        const reference = composeAssetReference(texturePrefix, asset.file)
        return loadTexture(reference, asset.colorspace).then(base => {
          const clone = base.clone()
          clone.needsUpdate = true
          return clone
        // 取图失败只记一条警告：几何照旧可见，外观退回**材质色**（不是图元的占位灰）。但警告必须说清**哪一张**：
        // three 在 `<img>` 失败时 reject 的是事件对象、甚至 `undefined`（实测原生 Viewer 取不到图时
        // `String(error)` 落成字面量 "undefined"，`visualWarnings` 里只剩一条无法归因的噪声）。
        // 这里用材质引用的**文档引用串**做主语，错误信息只在真的是 Error 时附上。
        }).catch(error => { warnings.push(`TEXTURE_LOAD_FAILED: ${reference}${error instanceof Error && error.message ? `（${error.message}）` : ""}`); return null })
      })()
      if (geom.mesh) {
        const mesh = assets.get(geom.mesh)
        if (!mesh?.file) { warnings.push(`MESH_ASSET_MISSING: ${geom.mesh}`); return }
        const prefix = compiler.meshdir ?? compiler.assetdir ?? ""
        tasks.push(Promise.all([loadMesh(composeAssetReference(prefix, mesh.file), mesh.file), texture]).then(([object, map]) => {
          // 派生 XML 里 mesh 的 pos/quat/scale 是官方编译 mesh 帧 (p, R, S) = model.mesh_pos/
          // mesh_quat/mesh_scale。逐顶点数值实测（robosuite link0_vis_0 单顶点、wall_decoration
          // 非均匀缩放 [0.4,0.1,0.4]、mm 单位 textured_vis 三类）确定原始文件顶点到官方编译顶点的
          // 关系是 v_compiled = Rᵀ·(S·v_raw − p)：先按 S 缩放、再减 p（p = S·原始包围盒中心）、
          // 最后左乘 Rᵀ；编译器已把该帧补偿进引用 geom 的 pos/quat，官方渲染直接用 v_compiled。
          // Viewer 加载的是原始文件顶点，因此这里应用 A = Rᵀ·T(−p)·S。用矩阵直乘而不是
          // 对 pos/quat/scale 再分解，非均匀缩放（0.4/0.1/0.4）也精确。
          const position = nums(mesh.pos, [0, 0, 0])
          const rotation = nums(mesh.quat, [1, 0, 0, 0])
          const scale = nums(mesh.scale, [1, 1, 1])
          object.matrix.makeRotationFromQuaternion(
            new THREE.Quaternion(rotation[1]!, rotation[2]!, rotation[3]!, rotation[0]!).normalize()).transpose()
            .multiply(new THREE.Matrix4().makeTranslation(-position[0]!, -position[1]!, -position[2]!))
            .multiply(new THREE.Matrix4().makeScale(scale[0]!, scale[1]!, scale[2]!))
          object.matrixAutoUpdate = false
          // mesh 自带显式 UV（.msh -> .obj 保留了 vt）：显式纹理坐标优先，texuniform 的自动映射
          // 不参与，只按 texrepeat 缩放已有 UV。
          if (map) map.repeat.set(...texrepeatOf(spec))
          if (spec || geom.rgba || map) object.traverse(part => {
            if (!(part instanceof THREE.Mesh)) return
            // 调制语义按既有口径替换材质（颜色随材质走）。代价是**`.glb` 自带的贴图会被替换掉**：
            // 那种"无贴图"同样不许静默 —— 逐条记一条明确警告（几何照旧可见、渲染结果一个字不改）。
            const replaced = (part.material as THREE.MeshStandardMaterial | undefined)?.map
            if (!map && replaced) {
              const reference = composeAssetReference(prefix, mesh.file)
              if (!overriddenTextures.has(reference)) {
                overriddenTextures.add(reference)
                warnings.push(`ROBOT_VISUAL_GLB_TEXTURE_OVERRIDDEN: ${reference}（图元 ${String(geom.name ?? geom.type ?? "geom")} 引用的材质 ${String(spec?.name ?? "")} 声明了调制色但没有贴图 ⇒ 按既有调制语义用材质色替换，glTF 自带的贴图不参与渲染；几何照旧可见）`)
              }
            }
            part.material = material(modulation, map ?? null)
          })
          container.add(object)
        // 与贴图同一条口径：装载器 reject 的不一定是 Error（可能是事件对象/undefined），
        // 警告的主语必须是**文档里的引用串**，否则回执里只剩一条无法归因的噪声。
        }).catch(error => { warnings.push(`MESH_LOAD_FAILED: ${String(geom.mesh)}${error instanceof Error && error.message ? `（${error.message}）` : ""}`) }))
      } else {
        const object = primitive(geom)
        container.add(object)
        // 图元分支的基色同样按调制色：`primitive()` 只拿到 `geom.rgba`，会把"引用 material 的图元"
        // 画成 0.5 占位灰（缺纹理的地板就是这一格）。贴图挂上后下面再换成带 map 的材质。
        if (object instanceof THREE.Mesh) object.material = material(modulation, null)
        if (texture) tasks.push(texture.then(map => {
          if (!map || !(object instanceof THREE.Mesh)) return
          const repeat = (String(spec?.texuniform) === "true" ? uniformRepeatUV(object.geometry, geom, texrepeatOf(spec)) : undefined) ?? texrepeatOf(spec)
          map.repeat.set(repeat[0], repeat[1])
          object.material = material(modulation, map)
        }))
      }
    }
    function body(item: any, parent: THREE.Object3D, childClass?: string, parentPath: string[] = [], indexPrefix: number[] = [], childIndex = 0): void {
      const node = new THREE.Group()
      node.name = item.name ?? "body"
      pose(node, item, degrees)
      node.updateMatrix()
      /**
       * 本 body 自己的关节层级。`setBodyWorldPoses` 收到的目标是 MuJoCo 的 **body 世界位姿**，
       * 它已经把该 body 自己的关节运动算进去了；而可视 geom 挂在关节 stage 之下。投影身体位姿时
       * 必须把 stage 归零，否则同一段关节运动会再作用一次到可视几何上（body 节点本身是对的，
       * 只有展示层被多转了一次 ⇒ 肘/腕/夹爪出现缝隙）。把 stage 登记在这里，投影时精确归零。
       */
      const stages: THREE.Object3D[] = []
      if (item.name) bodies.set(item.name, { node, base: node.matrix.clone(), stages })
      parent.add(node)
      if (input.rootBody ? item.name === input.rootBody : parent === root && !frameAnchor) frameAnchor = node
      let movable: THREE.Object3D = node
      for (const joint of list<any>(item.joint)) {
        const spec = { ...defaults.get(joint.class ?? item.childclass ?? childClass ?? "")?.joint, ...joint }
        if (!spec.name || !["hinge", "slide", undefined].includes(spec.type)) continue
        const stage = new THREE.Group()
        movable.add(stage)
        stage.updateMatrix()
        stages.push(stage)
        joints.set(spec.name, { node: stage, base: stage.matrix.clone(), axis: new THREE.Vector3(...nums(spec.axis, [0, 0, 1]) as [number, number, number]).normalize(), kind: spec.type ?? "hinge", origin: new THREE.Vector3(...nums(spec.pos, [0, 0, 0]) as [number, number, number]) })
        movable = stage
      }
      // 展示层：本 body 自己的可见 geom 挂在这个子组下；子 body 仍挂原生 movable（FK 链不变）。
      const presentation = new THREE.Group()
      presentation.name = `presentation:${node.name}`
      movable.add(presentation)
      const partId = `body:${[...indexPrefix, childIndex].join(".")}`
      if (item.name) { node.userData.partId = partId; presentation.userData.partId = partId }
      parts.push({ partId, name: item.name ?? "body", kind: "body", path: [...parentPath, item.name ?? "body"], hasVisual: list<any>(item.geom).length > 0, granularity: "hierarchy", node, presentation })
      for (const geom of list<any>(item.geom)) geomNode(geom, presentation, item.childclass ?? childClass)
      list<any>(item.body).forEach((child, index) => body(child, movable, item.childclass ?? childClass, [...parentPath, item.name ?? "body"], [...indexPrefix, childIndex], index))
    }
    for (const geom of sectionItems(doc.worldbody, "geom")) geomNode(geom, root)
    sectionItems(doc.worldbody, "body").forEach((item, index) => body(item, root, undefined, [], [], index))
  } else if (input.format === "urdf") {
    const links = new Map<string, THREE.Group>()
    /** link 名 → 源文档下标：partId 的**稳定身份**，不随呈现次序或根/子声明顺序改变。 */
    const linkOrder = new Map<string, number>()
    /** link 名 → 自己的展示组（炸开偏移只写它；原生 link 矩阵不动）。 */
    const presentations = new Map<string, THREE.Group>()
    const hasVisual = new Map<string, boolean>()
    list<any>(input.document.link).forEach((link, linkIndex) => {
      const node = new THREE.Group(); node.name = link.name; links.set(link.name, node)
      linkOrder.set(link.name, linkIndex)
      // URDF 的 link 就是真实部件：登记进 bodies（与 MJCF body 同一张表），这样 `bodyNode()`
      // 对 URDF 也能给出真实节点（相机挂载/动态几何/部件选择共用这一条查询），resetPose 一并覆盖。
      bodies.set(link.name, { node, base: node.matrix.clone() })
      const presentation = new THREE.Group(); presentation.name = `presentation:${link.name}`; node.add(presentation)
      presentations.set(link.name, presentation)
      hasVisual.set(link.name, list<any>(link.visual).length > 0)
      for (const visual of list<any>(link.visual)) {
        const container = new THREE.Group(); pose(container, visual.origin ?? {}); presentation.add(container)
        visualNodes++
        const geom = visual.geometry
        if (geom?.mesh) tasks.push(loadMesh(geom.mesh.filename).then(mesh => { mesh.scale.fromArray(nums(geom.mesh.scale, [1, 1, 1])); container.add(mesh) }).catch(error => { warnings.push(String(error)) }))
        else if (geom?.box) container.add(primitive({ type: "box", size: nums(geom.box.size, [1, 1, 1]).map(v => v / 2).join(" ") }))
        else if (geom?.cylinder) container.add(primitive({ type: "cylinder", size: `${geom.cylinder.radius} ${Number(geom.cylinder.length) / 2}` }))
        else if (geom?.sphere) container.add(primitive({ type: "sphere", size: geom.sphere.radius }))
      }
    })
    /** 真实关节声明的父子关系：parent link → child link（按关节声明顺序）。 */
    const childLinks = new Map<string, string[]>()
    const childNames = new Set<string>()
    for (const item of list<any>(input.document.joint)) {
      const parent = links.get(item.parent?.link), child = links.get(item.child?.link)
      if (!parent || !child) { warnings.push(`URDF_LINK_MISSING: ${item.name}`); continue }
      const node = new THREE.Group(); pose(node, item.origin ?? {}); node.updateMatrix(); parent.add(node); node.add(child)
      if (["revolute", "continuous", "prismatic"].includes(item.type)) joints.set(item.name, { node, base: node.matrix.clone(), axis: new THREE.Vector3(...nums(item.axis?.xyz, [1, 0, 0]) as [number, number, number]).normalize(), kind: item.type === "prismatic" ? "slide" : "hinge", origin: new THREE.Vector3() })
      childNames.add(item.child!.link)
      const siblings = childLinks.get(item.parent!.link) ?? []
      siblings.push(item.child!.link)
      childLinks.set(item.parent!.link, siblings)
    }
    // 父先子后呈现：从真实根 link 沿关节树 DFS，`path` 反映实际关节层级；`partId` 仍绑定源文档下标
    // （`link:<源下标>`）。因此 child 在 root 之前声明时，呈现次序会按父子重排，身份一个都不变。
    const visited = new Set<string>()
    const appendLink = (name: string, path: string[]): void => {
      if (visited.has(name)) return
      visited.add(name)
      const node = links.get(name), presentation = presentations.get(name)
      if (!node || !presentation) return
      parts.push({ partId: `link:${linkOrder.get(name)}`, name, kind: "link", path: [...path, name], hasVisual: hasVisual.get(name) === true, granularity: "hierarchy", node, presentation })
      for (const child of childLinks.get(name) ?? []) appendLink(child, [...path, name])
    }
    for (const link of list<any>(input.document.link)) if (!childNames.has(link.name)) appendLink(link.name, [])
    // 环/重复父级在合法 URDF 里不存在；真遇到时也把未呈现的 link 如实列出，不静默丢节点。
    for (const link of list<any>(input.document.link)) if (!visited.has(link.name)) appendLink(link.name, [])
    for (const node of links.values()) if (!node.parent) root.add(node)
  } else throw new Error("UNSUPPORTED_ROBOT_VISUAL_FORMAT")
  await Promise.all(tasks)
  // 一个可视节点都没建出来时不能报"显示就绪"：DEV-030 的现象就是"空组 + loadingErrors 为空"。
  // 这条与缺件警告走同一张表（Viewer 的 `visualWarnings`）：采集门照实说不完整，不把空机器人当成功。
  if (!visualNodes) warnings.push(`ROBOT_VISUAL_EMPTY: ${String(input.format)} 文档里没有可显示的 geom/link，建出的可视节点为 0`)
  // Sim 帧给出基座的世界位姿；原件的基座局部变换仍用于静态场景，
  // 运行投影时只抵消一次，避免源文件 pos/quat 和物理位姿重复应用。
  root.updateWorldMatrix(true, true)
  const rootBase = root.matrix.clone()
  const rootFrameInverse = frameAnchor ? frameAnchor.matrixWorld.clone().invert() : new THREE.Matrix4()
  return { root, rootFrameInverse, warnings, parts,
    projectedDocumentMatrix() {
      if (!projectingBodies || root.matrixAutoUpdate) return undefined
      root.updateWorldMatrix(true, false)
      return root.matrixWorld.clone()
    },
    setCollisionVisible(visible) { for (const node of hiddenCollisionGeoms) node.visible = visible },
    resetPose() {
      projectingBodies = false
      // 回到装配姿态时展示层一并合拢：不留"位姿复位了但几何还散着"的中间态。
      setExplodeSpread(0)
      for (const { node, base } of [{ node: root, base: rootBase }, ...bodies.values(), ...joints.values()]) {
        node.matrix.copy(base)
        base.decompose(node.position, node.quaternion, node.scale)
        node.matrixAutoUpdate = true
        node.matrixWorldNeedsUpdate = true
      }
    },
    setExplodeSpread,
    explodeSpread: () => explodeSpreadValue,
    explodeOffsets: () => new Map(presentationOffsets),
    bodyNode: (bodyName: string) => bodies.get(bodyName)?.node,
    setBodyWorldPoses(poses, documentWorldMatrix) {
      const finiteVector = (value: unknown, size: number): value is number[] => Array.isArray(value) && value.length === size && value.every(x => typeof x === "number" && Number.isFinite(x))
      const targets = new Map<string, THREE.Matrix4>()
      for (const value of poses && typeof poses === "object" && !Array.isArray(poses) ? Object.values(poses) : []) {
        if (!value || typeof value !== "object") continue
        const pose = value as Record<string, unknown>
        if (typeof pose.bodyName !== "string" || !bodies.has(pose.bodyName) || !finiteVector(pose.positionM, 3) || !finiteVector(pose.quaternionXyzw, 4)) continue
        const rotation = new THREE.Quaternion().fromArray(pose.quaternionXyzw)
        if (rotation.lengthSq() === 0) continue
        targets.set(pose.bodyName, new THREE.Matrix4().compose(new THREE.Vector3().fromArray(pose.positionM), rotation.normalize(), new THREE.Vector3(1, 1, 1)))
      }
      if (targets.size) projectingBodies = true
      if (!projectingBodies) return
      // MJCF 的固定桌面、固定根与自由 body 共用模型坐标系；不能让第一个自由根带着整套场景移动。
      // 外层实体仍跟随运行位姿供选择/gizmo使用，模型层抵消这个投影并保留文档装配坐标系。
      if (documentWorldMatrix && root.parent) {
        root.parent.updateWorldMatrix(true, false)
        root.matrix.copy(root.parent.matrixWorld).invert().multiply(documentWorldMatrix)
        root.matrixAutoUpdate = false
        root.matrixWorldNeedsUpdate = true
      }
      // 必须按**实际 Object3D 父子顺序**投影，而不是 `bodies` 的登记顺序：URDF 允许 child link 在
      // root 之前声明，按登记顺序先算 child 会把"父矩阵还没更新"的旧值当成父世界矩阵，局部矩阵就错了
      // （真实现象：root 给 x=10、child 给 x=12，读回 child=22）。按深度排序后父一定先于子，
      // 局部矩阵 = 父实际世界矩阵⁻¹ × 目标世界矩阵；原生节点本身不被展示偏移污染。
      const depthOf = (node: THREE.Object3D): number => { let depth = 0; for (let cursor = node.parent; cursor; cursor = cursor.parent) depth++; return depth }
      const ordered = [...bodies.entries()].sort((left, right) => depthOf(left[1].node) - depthOf(right[1].node))
      for (const [name, { node, stages }] of ordered) {
        const target = targets.get(name)
        if (!target || !node.parent) continue
        node.parent.updateWorldMatrix(true, false)
        node.matrix.copy(node.parent.matrixWorld).invert().multiply(target)
        node.matrixAutoUpdate = false
        node.matrixWorldNeedsUpdate = true
        // `target` 是 MuJoCo 的 body 世界位姿，**已经包含本 body 自己的关节运动**。可视 geom 与
        // 子 body 都挂在关节 stage 下；`setJoints` 写在 stage 上的那份运动若继续生效，就会在
        // 原生 body 位姿之上再叠加一次（重复 FK）：body 节点/相机挂载仍对，画面里的外壳却被
        // 多转了一个关节角（真实 Panda 的肘 link4、腕 link7、手前 link6 因此出现缝隙）。
        // 投影 body 位姿时把本 body 的 stage 归零，让展示层与原生 body 同帧；下一帧 `setJoints`
        // 会按 `base` 重新写入，合拢/炸开仍只动 presentation。
        for (const stage of stages ?? []) {
          stage.matrix.identity()
          stage.matrix.decompose(stage.position, stage.quaternion, stage.scale)
          stage.matrixWorldNeedsUpdate = true
        }
      }
    },
    setJoints(names, positions) {
    names.forEach((name, i) => {
      const joint = joints.get(name), value = positions[i]
      if (!joint || value === undefined || !Number.isFinite(value)) return
      const motion = joint.kind === "slide" ? new THREE.Matrix4().makeTranslation(joint.axis.clone().multiplyScalar(value)) : new THREE.Matrix4().makeTranslation(joint.origin).multiply(new THREE.Matrix4().makeRotationAxis(joint.axis, value)).multiply(new THREE.Matrix4().makeTranslation(joint.origin.clone().negate()))
      joint.node.matrix.copy(joint.base).multiply(motion)
      joint.node.matrix.decompose(joint.node.position, joint.node.quaternion, joint.node.scale)
    })
  } }
}
