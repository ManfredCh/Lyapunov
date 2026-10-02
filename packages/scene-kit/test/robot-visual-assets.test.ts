/**
 * DEV-PROJ-02：**机器人文档资产引用 → 已授权件的媒体标记**（`scene-kit/src/robot-visual-assets.ts`）。
 *
 * 为什么这条要有测试：出站投影（`product-paths.ts:projectPathsOnly`）只认识字符串形状，看不见
 * "这条引用是相对哪份文档写的"。机器人视觉的资产引用是**文档内引用**（`viewer/src/robot.ts` 的
 * `composeAssetReference(meshdir,file)` + `new URL(ref,baseUri)`），`baseUri` 被换成标记之后，
 * 相对引用在浏览器里没有基址可解、域内绝对路径会变成域引用（媒体路由按标记/绝对件等值匹配，两者都匹配不上）。
 *
 * 三条纪律：
 *  1. **夹具是真的**：`test/fixtures/mjcf-duplicate-sections/scene.xml`（带 `include`、两段 `<asset>`）
 *     过真生产者 `formats.ts:robotVisual` + 真依赖闭包 `parseAsset`，文件真的在磁盘上；
 *     mimeType 的消费侧判据拿真函数 `viewer/src/asset-locator.ts:pairDocumentAssets` 验，不手写期望。
 *  2. **负对照在文件里**：候选集空 / 行没有 `name` / 扩展名不在 mimeType 表里 / 引用已带 scheme
 *     ——四条各有一条"一条都不改"的读数。放宽本模块的判据（例如取消 `name` 判据或不过滤候选集），
 *     正向用例仍绿而**负对照精确变红**。
 *  3. **不放宽授权**：候选集成员资格是唯一闸门，而候选集由调用方按"已登记资源 + 文档依赖闭包"构造，
 *     与 `plugin.ts` 的 `resource` 路由同一批输入；本模块只对成员发标记。
 *
 * ## ⑤⑥⑦：`.glb` 真件链（B3 / `bugfixHistory/ROBOT-VISUAL-GLB-MIME-20260927.md`）
 *
 * `.glb` 是这张表里唯一**官方投影不写**的扩展名，所以它也是唯一一条"表漏了就整条链路静默降级"的路：
 * 行被 `skip` ⇒ `pairDocumentAssets` 返回 `[]` ⇒ 装载器没有声明可分派 ⇒ 只能回落定位符真名后缀
 * （网格**仍然装得出来**，肉眼看不出来），同时浏览器里留下一条 `ROBOT_VISUAL_REFERENCE_UNRESOLVED`。
 * 这三条**只有走真链才量得出来**，所以 ⑤ 用真件（`viewer/test/fixtures/robot-glb-mesh/banana.{xml,glb}`，
 * 未改字节的真件拷贝）+ 真出站层（`plugin.ts:projectSceneForBrowser`）+ 真媒体路由
 * （`lyapunov-shell/test/resource-route-harness.ts` 的真宿主）+ 真消费侧声明表接线
 * （`viewer/src/index.ts:756` 的 `assetDeclarations`）+ 真装配器（`viewer/src/robot.ts:buildRobotVisual`）。
 * ⑦ 的 `.obj` 孪生件是**同一份文档、同一份几何**（只换 `file` 的扩展名），钉"既有格式逐项不变"。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import * as THREE from "three"

import { matchResourceToken, projectPathsOnly, resourceToken, type ProductPathRoots } from "../../lyapunov-contracts/src/product-paths.ts"
import { glbJSON, localPath, parseAsset, robotVisual } from "../src/formats.ts"
import { authorizedAssetIndex, robotDocumentAssetLocators, ROBOT_VISUAL_MIME_BY_EXTENSION, sceneRobotDocumentAssetLocators } from "../src/robot-visual-assets.ts"
import { assetFormatFromMimeType, pairDocumentAssets } from "../../viewer/src/asset-locator.ts"
import { buildRobotVisual, type RobotVisual } from "../../viewer/src/robot.ts"
import { projectSceneForBrowser } from "../../lyapunov-shell/src/plugin.ts"
import { boot, fetchResource, SESSION, viewerResourceURI, writeScene } from "../../lyapunov-shell/test/resource-route-harness.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "mjcf-duplicate-sections")
const SCENE_XML = join(FIXTURES, "scene.xml")
/** 域根故意罩住夹具目录：不做这一步时域内绝对路径会被投影写成域引用（正是要修的那一类）。 */
const ROOTS: ProductPathRoots = { runtime: FIXTURES }

/** 真生产者（`robotVisual`）+ 真依赖闭包（`parseAsset`）造出的实体，形状与 scene-kit 挂载后的一致。 */
async function realEntity() {
  const robot = await robotVisual(SCENE_XML)
  const parsed = await parseAsset(SCENE_XML)
  const entity = {
    entityId: "arm", name: "arm",
    resources: [{
      resourceId: "arm-1", version: 1,
      original: { uri: pathToFileURL(SCENE_XML).href, mimeType: parsed.mimeType, role: "source" },
      representations: [{ uri: pathToFileURL(SCENE_XML).href, mimeType: parsed.mimeType, role: "source" }],
      source: parsed.source,
    }],
    components: { visual: { kind: "robot", robot }, mujoco: { sourcePath: SCENE_XML } },
  }
  const candidates = [...entity.resources.flatMap(ref => [ref.original, ...ref.representations]).map(rep => rep.uri), SCENE_XML, ...parsed.dependencies.flatMap(item => [item.path, pathToFileURL(item.path).href])]
  return { entity, candidates, parsed }
}
/** 文档段可能是数组（同一份文档出现多段 `<asset>`/`<compiler>`）：逐段摊平后取 `file`。 */
const sectionsOf = (entity: any): any[] => {
  const asset = entity.components.visual.robot.document.asset
  return Array.isArray(asset) ? asset : [asset]
}
const meshRows = (entity: any): any[] => sectionsOf(entity).flatMap(section => section.mesh === undefined ? [] : Array.isArray(section.mesh) ? section.mesh : [section.mesh])
const meshFiles = (entity: any): string[] => meshRows(entity).map(row => row.file)
/** 只改夹具里的网格行（其余字段原样），用于构造负对照。 */
const withDocument = (entity: any, mutate: (document: any) => void) => {
  const document = structuredClone(entity.components.visual.robot.document)
  mutate(document)
  return { ...entity, components: { ...entity.components, visual: { kind: "robot", robot: { ...entity.components.visual.robot, document } } } }
}
const eachMesh = (document: any, mutate: (row: any) => void): void => {
  for (const section of Array.isArray(document.asset) ? document.asset : [document.asset])
    for (const row of (Array.isArray(section.mesh) ? section.mesh : [section.mesh]).filter(Boolean)) mutate(row)
}

describe("① 相对引用（`meshdir` + `<mesh name=… file=…>`）：换成已授权件的标记", () => {
  test("真夹具：三条网格全部换成标记，且标记在候选集里能换回**磁盘上的那一件**", async () => {
    const { entity, candidates } = await realEntity()
    const fixed = robotDocumentAssetLocators(entity, authorizedAssetIndex(candidates))
    // 夹具里那条 `builtin="checker"` 的贴图没有 `file` ⇒ 如实计入 skipped（不是"改写了 0 条"）。
    expect(fixed.facts).toEqual({ entities: 1, meshes: 3, textures: 0, skipped: 1 })
    expect(meshFiles(entity)).toEqual(["a.stl", "b.stl", "c.stl"])   // 入参一个字节没被改（copy-on-write）
    const files = meshFiles(fixed.entity)
    expect(files.every(file => file.startsWith("res:"))).toBe(true)
    for (const file of files) {
      const real = matchResourceToken(file, candidates)
      expect(real).toBeTruthy()
      expect(localPath(real!)).toMatch(/\/meshes\/[abc]\.stl$/)
    }
  })

  test("投影之后：`pairDocumentAssets` 拿得回声明 mimeType（装载器分派不再靠定位符猜扩展名）", async () => {
    const { entity, candidates } = await realEntity()
    const projected = projectPathsOnly(robotDocumentAssetLocators(entity, authorizedAssetIndex(candidates)).entity, ROOTS) as any
    // 标记带 scheme，投影不动它：文档引用与表示 uri 因此**逐字相等**（直接命中）。
    const pairs = pairDocumentAssets(projected)
    expect(pairs.map(row => row.mimeType)).toEqual(["model/stl", "model/stl", "model/stl"])
    expect(pairs.map(row => assetFormatFromMimeType(row.mimeType))).toEqual(["stl", "stl", "stl"])
    expect(pairs.every(row => row.file === row.uri)).toBe(true)
  })

  test("补进去的表示写的是候选串、文档引用写的是**同一条串的标记**（同一件资产不许两种写法）", async () => {
    const { entity, candidates } = await realEntity()
    const fixed = robotDocumentAssetLocators(entity, authorizedAssetIndex(candidates)).entity as any
    const representations = fixed.resources[0].representations as Array<{ uri: string; mimeType: string }>
    expect(representations.slice(1).map(rep => rep.uri)).toEqual([
      pathToFileURL(join(FIXTURES, "meshes", "a.stl")).href,
      pathToFileURL(join(FIXTURES, "meshes", "b.stl")).href,
      pathToFileURL(join(FIXTURES, "meshes", "c.stl")).href,
    ])
    expect(representations.slice(1).every(rep => rep.mimeType === "model/stl")).toBe(true)
    // 文档引用 = 表示 uri 的**标记**：投影之后两侧逐字相等（`pairDocumentAssets` 的直接命中）。
    expect(meshFiles(fixed)).toEqual(representations.slice(1).map(rep => resourceToken(rep.uri)))
  })

  test("整场入口 `sceneRobotDocumentAssetLocators`：累加各实体读数，没有任何改写时原样返回入参", async () => {
    const { entity, candidates } = await realEntity()
    const scene = { sceneId: "s", revision: 1, entities: [entity, { entityId: "other", components: {} }] }
    const fixed = sceneRobotDocumentAssetLocators(scene, authorizedAssetIndex(candidates))
    expect(fixed.facts).toEqual({ entities: 1, meshes: 3, textures: 0, skipped: 1 })
    expect((fixed.scene as any).entities).toHaveLength(2)
    expect((fixed.scene as any).entities[1]).toBe(scene.entities[1])
    const untouched = sceneRobotDocumentAssetLocators(scene, authorizedAssetIndex([]))
    expect(untouched.scene).toBe(scene)
    expect(untouched.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
  })
})

describe("② 负对照：判据一放宽就精确变红", () => {
  test("候选集空（= 件没被授权）⇒ 一条都不改，文档引用逐字原样", async () => {
    const { entity } = await realEntity()
    const before = meshFiles(entity)
    const fixed = robotDocumentAssetLocators(entity, authorizedAssetIndex([]))
    expect(fixed.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
    expect(fixed.entity).toBe(entity)                      // 没有任何改写时原样返回入参
    expect(meshFiles(fixed.entity)).toEqual(before)
  })

  test("行没有 `name` ⇒ 不动（Viewer 的资产表键由文件名推出来，换了引用就换了键）", async () => {
    const { entity, candidates } = await realEntity()
    const unnamed = withDocument(entity, document => eachMesh(document, row => { delete row.name }))
    const fixed = robotDocumentAssetLocators(unnamed, authorizedAssetIndex(candidates))
    expect(fixed.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
    expect(meshFiles(fixed.entity)).toEqual(["a.stl", "b.stl", "c.stl"])
  })

  // 这一条原来拿 `.glb` 当"表里没有的扩展名"的实例。`.glb` 进表之后换成 `.ply`：
  // **判据一个字没动**（不在表里的扩展名 ⇒ 一条都不改），只换了实例——`.ply` 至今不在
  // `ROBOT_VISUAL_MIME_BY_EXTENSION` 里，也没有装载分支，正是这条判据要防的形状。
  test("扩展名不在 mimeType 表里（`.ply`）⇒ 不动：标记会让装载器判不出格式", async () => {
    const { entity, candidates } = await realEntity()
    const renamed = withDocument(entity, document => eachMesh(document, row => { row.file = row.file.replace(/\.stl$/, ".ply") }))
    const fixed = robotDocumentAssetLocators(renamed, authorizedAssetIndex(candidates))
    expect(fixed.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
    expect(meshFiles(fixed.entity).every(file => file.endsWith(".ply"))).toBe(true)
  })

  test("引用已带 scheme（接线层历史 `?ext=` 形状 / 已投影过的场景）⇒ 不动，幂等", async () => {
    const { entity, candidates } = await realEntity()
    const index = authorizedAssetIndex(candidates)
    const once = robotDocumentAssetLocators(entity, index).entity
    const legacy = withDocument(once, document => eachMesh(document, row => { row.file = `${row.file}?ext=.stl` }))
    const twice = robotDocumentAssetLocators(legacy, index)
    expect(twice.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
    expect(meshFiles(twice.entity).every(file => file.endsWith("?ext=.stl"))).toBe(true)
    // 幂等：已经换过一次的那一份再走一遍，读数与内容都不变。
    const again = robotDocumentAssetLocators(once, index)
    expect(again.facts.meshes).toBe(0)
    expect(meshFiles(again.entity)).toEqual(meshFiles(once))
  })

  test("绝对引用不受 `meshdir` 影响（MuJoCo 语义：绝对路径优先），且入参一个字节没被改写", async () => {
    const { entity, candidates } = await realEntity()
    const absolute = join(FIXTURES, "meshes", "a.stl")
    const rewritten = withDocument(entity, document => eachMesh(document, row => { row.file = absolute }))
    const before = JSON.stringify(entity)
    const fixed = robotDocumentAssetLocators(rewritten, authorizedAssetIndex(candidates))
    expect(fixed.facts).toEqual({ entities: 1, meshes: 3, textures: 0, skipped: 1 })
    expect(new Set(meshFiles(fixed.entity)).size).toBe(1)   // 三条都指向同一件
    expect(matchResourceToken(meshFiles(fixed.entity)[0]!, candidates)).toBeTruthy()
    expect(JSON.stringify(entity)).toBe(before)             // copy-on-write：入参没被改
  })

  test("实体不带机器人文档（普通网格实体）⇒ 不进这条路径", async () => {
    const { candidates } = await realEntity()
    const plain = { entityId: "box", components: { visual: { kind: "mesh" }, mujoco: { sourcePath: SCENE_XML } } }
    expect(robotDocumentAssetLocators(plain, authorizedAssetIndex(candidates)).facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 0 })
  })
})

describe("③ 与既有表的契约：mimeType 表不许与 Viewer 的反向表漂移", () => {
  test("网格四项：每个 (扩展名 → mimeType) 都能被 `assetFormatFromMimeType` 判回同一个格式名", () => {
    for (const extension of [".stl", ".obj", ".dae", ".glb"]) {
      const mimeType = ROBOT_VISUAL_MIME_BY_EXTENSION[extension]!
      expect({ extension, format: assetFormatFromMimeType(mimeType) }).toEqual({ extension, format: extension.slice(1) })
    }
  })
  test("贴图项：值是 `image/*`，且与生产者 `scene_projection.py:36-38` 的 VIEWER_TEXTURE_MIME 逐条相同", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".bmp", ".tga", ".webp"]) {
      const mimeType = ROBOT_VISUAL_MIME_BY_EXTENSION[extension]!
      expect({ extension, image: mimeType.startsWith("image/") }).toEqual({ extension, image: true })
    }
    expect([ROBOT_VISUAL_MIME_BY_EXTENSION[".png"], ROBOT_VISUAL_MIME_BY_EXTENSION[".jpg"], ROBOT_VISUAL_MIME_BY_EXTENSION[".jpeg"], ROBOT_VISUAL_MIME_BY_EXTENSION[".webp"]]).toEqual(["image/png", "image/jpeg", "image/jpeg", "image/webp"])
    // 键集**逐个写死**：这一行是"只多 `.glb`、没有顺手改别的扩展名"的判据本身。
    expect(Object.keys(ROBOT_VISUAL_MIME_BY_EXTENSION).sort()).toEqual([".bmp", ".dae", ".glb", ".jpeg", ".jpg", ".obj", ".png", ".stl", ".tga", ".webp"])
  })
  test("官方生产者写的三种网格 mimeType 都在这张表里（`scene_projection.py:32` 的 VIEWER_MESH_MIME）", () => {
    expect(ROBOT_VISUAL_MIME_BY_EXTENSION[".stl"]).toBe("model/stl")
    expect(ROBOT_VISUAL_MIME_BY_EXTENSION[".obj"]).toBe("model/obj")
    expect(ROBOT_VISUAL_MIME_BY_EXTENSION[".dae"]).toBe("model/vnd.collada+xml")
  })
  // `.glb` **不在**官方投影的 VIEWER_MESH_MIME 里（`scene_projection.py:32` 只有 stl/obj/dae），
  // 它的取值来自本仓自己的 GLB 生产者，所以单独一条：三处同源才成立（表 / 反向表 / 生产者）。
  test("`.glb` 的取值三处同源：本表 = `FORMAT_BY_MIME` 的反向判读 = `formats.ts` 的 GLB 分支", () => {
    expect(ROBOT_VISUAL_MIME_BY_EXTENSION[".glb"]).toBe("model/gltf-binary")
    expect(assetFormatFromMimeType(ROBOT_VISUAL_MIME_BY_EXTENSION[".glb"]!)).toBe("glb")
    expect(assetFormatFromMimeType("model/gltf-binary")).toBe("glb")
    // 生产者写的就是这一个值（`formats.ts` 的 GLB 分支）；取文本是判"同源"，行为面见 ⑤ 的真链。
    expect(readFileSync(join(import.meta.dir, "..", "src", "formats.ts"), "utf8")).toContain('mimeType: "model/gltf-binary"')
  })
})

describe("④ 标记就是路由的准入货币：换出来的标记必须能被候选集换回真身", () => {
  test("标记 ↔ 候选串是同一把指纹（`resourceToken`），不是第二套编码", async () => {
    const { entity, candidates } = await realEntity()
    const fixed = robotDocumentAssetLocators(entity, authorizedAssetIndex(candidates)).entity
    for (const file of meshFiles(fixed)) {
      const real = matchResourceToken(file, candidates)!
      expect(real).toBeTruthy()
      expect(file).toBe(resourceToken(real))
    }
  })
})

/* ─────────────────── ⑤⑥⑦ `.glb`（B3）：真件链一条到底 ─────────────────── */

/** Bun 没有 `ProgressEvent`（three 的 `FileLoader` 会 `new` 它）：补一个只当进度事件对象的垫片。 */
class ProgressEventShim extends Event {
  lengthComputable = false; loaded = 0; total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}
;(globalThis as any).ProgressEvent ??= ProgressEventShim

/**
 * 真件：`banana.{xml,glb}` 是**未改一个字节**的真件拷贝（原件在产品 CAS 依赖目录里，
 * 来源与几何事实见 `packages/viewer/test/fixtures/robot-glb-mesh/PROVENANCE.md`）。
 * sha256 写在下面：夹具被改/被换会当场红，不会静默变成"另一件也算过"。
 */
const BANANA_FIXTURE = join(import.meta.dir, "..", "..", "viewer", "test", "fixtures", "robot-glb-mesh")
const BANANA_XML = join(BANANA_FIXTURE, "banana.xml")
const BANANA_GLB = join(BANANA_FIXTURE, "banana.glb")
const BANANA_XML_SHA256 = "8c279e975def17bef5b1681706dfe9128519e34d7d4a37bd05286c5870a9d77f"
const BANANA_GLB_SHA256 = "15ed7207a485b8c696a20ae5547f4cb023c552819cac4dfa5f91408bef50c3b0"
/**
 * 真 `.obj` 孪生件：**同一份文档、同一份几何**，只把 `<mesh file>` 的扩展名换成 `.obj`
 *（原件是产品 CAS 里那次 developer 会话的另一条修订）。它在 `.runtime`（gitignore）里 ⇒
 * 干净 checkout 上没有，所以那一条用 `test.skipIf` 显式跳过（不假装跑过），
 * 另有一条**由真 GLB 的 accessor 逐位转录**的孪生件在仓内夹具上常年覆盖同一判据。
 */
const BANANA_OBJ_TWIN_DIR = join(import.meta.dir, "..", "..", "..", ".runtime", "desktop", "developer", "runtime", "developer", "cache", "cas", "ed", "edeb119dc472056a46f31c7ba59e553b7a29c5db13a61849b8587082a80f7132-banana.xml_deps")
const BANANA_OBJ_TWIN_XML = join(BANANA_OBJ_TWIN_DIR, "banana.xml")
const BANANA_OBJ_TWIN = join(BANANA_OBJ_TWIN_DIR, "banana.obj")
const BANANA_OBJ_TWIN_XML_SHA256 = "edeb119dc472056a46f31c7ba59e553b7a29c5db13a61849b8587082a80f7132"
const BANANA_OBJ_TWIN_SHA256 = "a29e2b21a42aca9661bf03b5f6c5f4cbffc4138e15a6000090cd8d1cc34a35da"

const GLB_SCENE = "robot-visual-glb-mime"
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** 真机器人实体（形状与真落盘场景 `banana-p2.json` 的实体一致：一条 MJCF 表示 + `mujoco.sourcePath`）。 */
async function robotDocumentEntity(sourcePath: string, entityId = "banana") {
  const robot = await robotVisual(sourcePath)
  const parsed = await parseAsset(sourcePath)
  const uri = pathToFileURL(sourcePath).href
  return {
    entityId, name: entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{ resourceId: `${entityId}-1`, version: 1, original: { uri, mimeType: parsed.mimeType, role: "source" }, representations: [{ uri, mimeType: parsed.mimeType, role: "source" }], source: parsed.source }],
    components: { mujoco: { sourcePath }, visual: { kind: "robot", robot } },
  } as any
}
const robotScene = (entity: unknown) => ({ sceneId: GLB_SCENE, revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [entity] }) as never

/**
 * 出站改写器的读数（`skipped` / `entities`）。候选集**不另写第二份算法**：先跑一次真
 * `projectSceneForBrowser`（它把该文档的依赖闭包按 `session|scene:rev|source` 写进 `dependencyCache`，
 * 与 `resource` 路由同一把缓存键），再把这份**真闭包**连同已登记表示读回来。
 * 判据的权威仍是真路由：标记换不回字节时 ⑤ 的路由断言当场红，这里只是同一件事的读数面。
 */
function outboundReadings(scene: any, cache: Map<string, Set<string>>) {
  const candidates: string[] = []
  for (const entity of scene.entities) for (const ref of entity.resources ?? []) for (const rep of [ref.original, ...(ref.representations ?? [])]) if (typeof rep?.uri === "string") candidates.push(rep.uri)
  for (const entity of scene.entities) { const native = entity.components?.mujoco?.sourcePath; if (typeof native === "string" && native) candidates.push(native) }
  for (const set of cache.values()) candidates.push(...set)
  return sceneRobotDocumentAssetLocators(scene, authorizedAssetIndex(candidates))
}

/** 建出来的网格读数：Mesh 个数 / 图元组数（`geometry.groups`，无组按 1 算）/ 三角形数。 */
function geometryOf(visual: RobotVisual) {
  let meshes = 0, primitives = 0, triangles = 0
  visual.root.traverse((object: THREE.Object3D) => {
    if (!(object instanceof THREE.Mesh)) return
    meshes++
    const geometry = object.geometry as THREE.BufferGeometry
    primitives += geometry.groups.length || 1
    triangles += Math.round((geometry.index?.count ?? geometry.attributes.position!.count) / 3)
  })
  return { meshes, primitives, triangles }
}

/**
 * 真件链一条到底：真出站层（`projectSceneForBrowser`）→ 真 `pairDocumentAssets` → 真媒体路由
 * （`resource-route-harness` 的真宿主：真 `SceneOperations` + 真依赖闭包）→ 真 `buildRobotVisual`。
 *
 * `resolveURI` 交回的是**路由回的那些字节**（base64 `data:` URL），不是另读一份盘 ⇒
 * "网格建出来了"与"路由放行了同一份字节"在同一条链上，分不开。
 * 声明表接线与 `viewer/src/index.ts:756` 逐字同一句（装配器只认声明，不猜扩展名）。
 */
async function realChain(scene: any, artifact: string) {
  const harness = await boot()
  try {
    await writeScene(harness, scene)
    const cache = new Map<string, Set<string>>()
    const out: any = await projectSceneForBrowser(scene, SESSION, {}, cache)
    const entity = out.entities[0]
    const reference = meshFiles(entity)[0]!
    const declarations = new Map(pairDocumentAssets(entity).map((row: any) => [row.file, row.mimeType]))
    const first = await fetchResource(harness, GLB_SCENE, viewerResourceURI(reference))
    const served: Array<{ status: number; bytes: number; sha: string }> = []
    const visual = await buildRobotVisual({ ...entity.components.visual.robot, assetDeclarations: declarations }, async (uri: string) => {
      const read = await fetchResource(harness, GLB_SCENE, viewerResourceURI(uri))
      served.push({ status: read.status, bytes: read.bytes.length, sha: createHash("sha256").update(read.bytes).digest("hex") })
      if (read.status !== 200) throw new Error(`RESOURCE_ROUTE_${read.status}: ${read.error}`)
      return `data:application/octet-stream;base64,${read.bytes.toString("base64")}`
    })
    return {
      facts: outboundReadings(scene, cache).facts,
      dependencyUris: [...cache.values()].flatMap(set => [...set]),
      reference,
      base: entity.components.visual.robot.baseUri as string,
      declarations: pairDocumentAssets(entity).map((row: any) => ({ file: row.file, mimeType: row.mimeType })),
      route: first.status === 200
        ? { status: 200, bytes: first.bytes.length, shaMatchDisk: createHash("sha256").update(first.bytes).digest("hex") === sha256(artifact) }
        : { status: first.status, bytes: first.bytes.length, shaMatchDisk: false, error: first.error },
      served,
      geometry: geometryOf(visual),
      unresolved: visual.warnings.filter(text => text.startsWith("ROBOT_VISUAL_REFERENCE_UNRESOLVED")),
      loadFailures: visual.warnings.filter(text => text.startsWith("MESH_LOAD_FAILED") || text.startsWith("UNSUPPORTED_ROBOT_VISUAL_MESH")),
    }
  } finally { await harness.dispose() }
}

/**
 * `.obj` 孪生件（**几何逐位来自真 GLB 的 accessor**，不是手写的假几何）：把真件的 POSITION 与索引
 * 逐位转录成 OBJ，顶点数/面数因此与 GLB 容器自己的 accessor 计数**逐字相同**（下面断言钉住）。
 * 存在的理由只有一条：真原件在 `.runtime` 里，干净 checkout 上不存在。
 */
function transcribeObjTwin(): { document: string; positions: number; faces: number } {
  const container = new Uint8Array(readFileSync(BANANA_GLB))
  const json = glbJSON(container)
  const header = new DataView(container.buffer, container.byteOffset, container.byteLength)
  const binary = container.subarray(20 + header.getUint32(12, true) + 8)
  const componentsOf: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
  const widthOf: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }
  const readAccessor = (index: number): number[] => {
    const accessor = json.accessors[index]
    const bufferView = json.bufferViews[accessor.bufferView]
    const components = componentsOf[accessor.type]!, width = widthOf[accessor.componentType]!
    const stride = bufferView.byteStride ?? components * width
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
    const values: number[] = []
    for (let i = 0; i < accessor.count; i++) for (let c = 0; c < components; c++) {
      const at = start + i * stride + c * width
      values.push(accessor.componentType === 5126 ? data.getFloat32(at, true)
        : accessor.componentType === 5125 ? data.getUint32(at, true)
          : accessor.componentType === 5123 ? data.getUint16(at, true) : data.getUint8(at))
    }
    return values
  }
  const primitive = json.meshes[0].primitives[0]
  const positions = readAccessor(primitive.attributes.POSITION), indices = readAccessor(primitive.indices)
  const lines = ["# transcribed bit-for-bit from banana.glb accessors (see robot-visual-assets.test.ts ⑦)"]
  for (let i = 0; i < positions.length; i += 3) lines.push(`v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`)
  for (let i = 0; i < indices.length; i += 3) lines.push(`f ${indices[i]! + 1} ${indices[i + 1]! + 1} ${indices[i + 2]! + 1}`)
  const directory = mkdtempSync(join(tmpdir(), "robot-visual-obj-twin-"))
  writeFileSync(join(directory, "banana.obj"), `${lines.join("\n")}\n`)
  writeFileSync(join(directory, "banana.xml"), readFileSync(BANANA_XML, "utf8").replace("banana.glb", "banana.obj"))
  return { document: join(directory, "banana.xml"), positions: positions.length / 3, faces: indices.length / 3 }
}

describe("⑤ `.glb` 真件链（B3）：出站层不再 skip、声明表拿得回、浏览器不再留未解析告警", () => {
  test("真件核对：`banana.{xml,glb}` 是未改字节的真件拷贝（sha256 + 264,012 B）", () => {
    expect(sha256(BANANA_XML)).toBe(BANANA_XML_SHA256)
    expect(sha256(BANANA_GLB)).toBe(BANANA_GLB_SHA256)
    expect(readFileSync(BANANA_GLB).length).toBe(264012)
  })

  // 下面三条**故意分开**：B3 的断点只在第一、三条上，第二条（路由回字节）**修前就是绿的**
  // ——因为路由有一条"相对引用按机器人文档目录解析"的回退。三个方向各自红/绿才是负对照要的读数形状。
  test("① 出站层：不再 skip（entities 1 / skipped 0）、引用是标记、`pairDocumentAssets` 不是 `[]`", async () => {
    const scene: any = robotScene(await robotDocumentEntity(BANANA_XML))
    const reading = await realChain(scene, BANANA_GLB)
    // 登记闭包里就有这一件（B1 的闭包）：没有它，路由的候选集里就没有 glb，标记也换不回字节。
    expect(reading.dependencyUris).toContain(pathToFileURL(BANANA_GLB).href)
    // **这一对数字就是 B3 的判据**（修前是 skipped 1 / entities 0）；skipped 0 也说明这张表没有反噬别的行。
    expect(reading.facts).toEqual({ entities: 1, meshes: 1, textures: 0, skipped: 0 })
    // 文档引用是标记（不是相对串）⇒ 浏览器不必靠"路由解析相对引用"那条回退。
    expect(reading.reference.startsWith("res:")).toBe(true)
    expect(reading.base.startsWith("res:")).toBe(true)
    // `pairDocumentAssets` 不再是空数组：装载器拿得到声明（修前 `[]` ⇒ 声明表空 ⇒ 只能猜后缀）。
    expect(reading.declarations).toEqual([{ file: reading.reference, mimeType: "model/gltf-binary" }])
    expect(assetFormatFromMimeType(reading.declarations[0]!.mimeType)).toBe("glb")
  })

  test("① 真资源路由：标记换回来的是磁盘上同一份字节（200 / 264,012 B / sha256 逐字节相同）", async () => {
    const scene: any = robotScene(await robotDocumentEntity(BANANA_XML))
    const reading = await realChain(scene, BANANA_GLB)
    expect(reading.route).toEqual({ status: 200, bytes: 264012, shaMatchDisk: true })
    expect(reading.served).toEqual([{ status: 200, bytes: 264012, sha: BANANA_GLB_SHA256 }])
  })

  test("① 真装配器：2 Mesh / 7 图元 / 11,820 三角形，且**不再有** `ROBOT_VISUAL_REFERENCE_UNRESOLVED`", async () => {
    const scene: any = robotScene(await robotDocumentEntity(BANANA_XML))
    const reading = await realChain(scene, BANANA_GLB)
    // 与 GLB 容器自己的 accessor 计数一致：5,993 顶点 / 11,808 面 + 碰撞盒 12 面。
    expect(reading.geometry).toEqual({ meshes: 2, primitives: 7, triangles: 11820 })
    // 修前走的是回退路径：网格**照样**是这三个数，但浏览器里留下一条未解析告警 —— 所以这一条必须分开判。
    expect(reading.unresolved).toEqual([])
    expect(reading.loadFailures).toEqual([])
  })
})

describe("⑥ 判据没有被放宽：表里没有的扩展名，**件在候选集里**也一条都不改", () => {
  test("`.ply`（授权候选齐全）⇒ skipped 4 / entities 0，引用逐字原样", async () => {
    const { entity } = await realEntity()
    const renamed = withDocument(entity, document => eachMesh(document, row => { row.file = row.file.replace(/\.stl$/, ".ply") }))
    // 与真夹具同目录同名的 `.ply` 候选串（件在磁盘上不存在，但**授权索引只认串**）：
    // 这样这条用例量的就纯粹是"扩展名不在 mimeType 表里"，不靠授权闸门替它挡。
    const candidates = ["a", "b", "c"].map(name => join(FIXTURES, "meshes", `${name}.ply`))
    expect(authorizedAssetIndex(candidates).size).toBe(3)
    const fixed = robotDocumentAssetLocators(renamed, authorizedAssetIndex(candidates))
    // 4 = 三条被改名的网格行 + 夹具里那条 `builtin="checker"`（没有 `file`，与既有用例同一口径）。
    expect(fixed.facts).toEqual({ entities: 0, meshes: 0, textures: 0, skipped: 4 })
    expect(fixed.entity).toBe(renamed)
    expect(meshFiles(fixed.entity)).toEqual(["a.ply", "b.ply", "c.ply"])
  })

  test("只多 `.glb`：既有 9 项的值逐字未变，且 `.gltf`/`.ply`/`.fbx`/`.msh`/`.usd` 仍然不在表里", () => {
    const EXISTING: Readonly<Record<string, string>> = {
      ".obj": "model/obj", ".stl": "model/stl", ".dae": "model/vnd.collada+xml",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".bmp": "image/bmp", ".tga": "image/x-tga", ".webp": "image/webp",
    }
    // 既有 9 项**值逐字未变**（这一条只判"没被改坏"，单独看它对"少了一项"是盲的）。
    expect(Object.fromEntries(Object.entries(ROBOT_VISUAL_MIME_BY_EXTENSION).filter(([extension]) => extension !== ".glb"))).toEqual(EXISTING)
    // ⇒ 所以键集要**显式判**：恰好是既有 9 项 + `.glb`（多一项不行，少一项也不行）。
    expect(Object.keys(ROBOT_VISUAL_MIME_BY_EXTENSION).sort()).toEqual([...Object.keys(EXISTING), ".glb"].sort())
    for (const extension of [".gltf", ".ply", ".fbx", ".msh", ".usd"]) expect(ROBOT_VISUAL_MIME_BY_EXTENSION[extension]).toBeUndefined()
  })
})

describe("⑦ `.obj` 孪生件（同一份文档、同一份几何，只换 `file` 的扩展名）：逐项不变", () => {
  test.skipIf(!existsSync(BANANA_OBJ_TWIN))("真原件（产品 CAS 里的 `banana.obj`，781,267 B）：读数与 `.glb` 逐项相同，且无未解析告警", async () => {
    expect(sha256(BANANA_OBJ_TWIN_XML)).toBe(BANANA_OBJ_TWIN_XML_SHA256)
    expect(sha256(BANANA_OBJ_TWIN)).toBe(BANANA_OBJ_TWIN_SHA256)
    const scene: any = robotScene(await robotDocumentEntity(BANANA_OBJ_TWIN_XML))
    const reading = await realChain(scene, BANANA_OBJ_TWIN)
    expect(reading.facts).toEqual({ entities: 1, meshes: 1, textures: 0, skipped: 0 })
    expect(reading.reference.startsWith("res:")).toBe(true)
    expect(reading.declarations).toEqual([{ file: reading.reference, mimeType: "model/obj" }])
    expect(reading.route).toEqual({ status: 200, bytes: 781267, shaMatchDisk: true })
    expect(reading.geometry).toEqual({ meshes: 2, primitives: 7, triangles: 11820 })
    expect(reading.unresolved).toEqual([])
    expect(reading.loadFailures).toEqual([])
  })

  test("仓内孪生件（几何逐位转录自真 GLB 的 accessor）：读数同样 2 / 7 / 11,820", async () => {
    const twin = transcribeObjTwin()
    // 转录的几何与 GLB 容器自己的 accessor 计数逐字相同（不是"另画了一个香蕉"）。
    const json = glbJSON(new Uint8Array(readFileSync(BANANA_GLB)))
    expect(twin.positions).toBe(json.accessors[json.meshes[0].primitives[0].attributes.POSITION].count)
    expect(twin.faces).toBe(json.accessors[json.meshes[0].primitives[0].indices].count / 3)
    expect({ positions: twin.positions, faces: twin.faces }).toEqual({ positions: 5993, faces: 11808 })

    const scene: any = robotScene(await robotDocumentEntity(twin.document, "banana-twin"))
    const reading = await realChain(scene, join(dirname(twin.document), "banana.obj"))
    expect(reading.facts).toEqual({ entities: 1, meshes: 1, textures: 0, skipped: 0 })
    expect(reading.declarations.map(row => row.mimeType)).toEqual(["model/obj"])
    expect(reading.route.shaMatchDisk).toBe(true)
    expect(reading.geometry).toEqual({ meshes: 2, primitives: 7, triangles: 11820 })
    expect(reading.unresolved).toEqual([])
    expect(reading.loadFailures).toEqual([])
  })

  test("既有 `.stl` 真夹具（三条网格）：读数逐项不变（3 meshes / model/stl / skipped 1）", async () => {
    const { entity, candidates } = await realEntity()
    const fixed = robotDocumentAssetLocators(entity, authorizedAssetIndex(candidates))
    expect(fixed.facts).toEqual({ entities: 1, meshes: 3, textures: 0, skipped: 1 })
    const projected = projectPathsOnly(fixed.entity, ROOTS) as any
    expect(pairDocumentAssets(projected).map(row => row.mimeType)).toEqual(["model/stl", "model/stl", "model/stl"])
    expect(assetFormatFromMimeType(ROBOT_VISUAL_MIME_BY_EXTENSION[".dae"]!)).toBe("dae")
  })
})
