/**
 * 机器人文档里的 `.glb` 网格：**登记得进依赖闭包、装载器分派建得出网格**（ROBOT-GLB-MESH-20260927）。
 *
 * ## 真件（不是合成夹具）
 *
 * `test/fixtures/robot-glb-mesh/banana.{xml,glb}` 是**未改一个字节**的真件拷贝：原件在
 * `.runtime/desktop/developer/runtime/developer/worlds/scenes/banana-p2.json` 这条真落盘场景的
 * CAS 依赖目录里。全工作区扫描"机器人文档引用 `.glb`"只命中这一处（判据与扫描命令见
 * `fixtures/robot-glb-mesh/PROVENANCE.md`）。`banana.xml` 是标准 MJCF
 * （`<mesh name="banana_mesh" file="banana.glb"/>` + `<geom type="mesh" mesh="banana_mesh"/>`），
 * `banana.glb` 是 264,012 B 的真 GLB（1 mesh / 1 primitive / POSITION 5,993 / indices 35,424，
 * **不带** Draco、不带 meshopt、不带 KTX2）。
 *
 * ## 本文件钉住的两条失败点（两个不同根因，不是同一处代码）
 *
 *  · **B1 `packages/scene-kit/src/formats.ts`**：`.glb` 不在登记闭包接受的扩展名里 ⇒
 *    `parseAsset(机器人文档)` 抛 `UNSUPPORTED_ROBOT_MESH_FORMAT` ⇒ 依赖闭包为空 ⇒ 媒体路由候选集里
 *    **根本没有 `banana.glb`** ⇒ 字节到不了浏览器（用户可见："机器人装不上"）。
 *  · **B2 `packages/viewer/src/robot.ts`**：装载器分派只有 stl/obj/dae ⇒ 就算字节到了也抛
 *    `UNSUPPORTED_ROBOT_VISUAL_MESH`（它连 `GLTFLoader` 都没调）。
 *
 * ⇒ 所以本文件两个方向都断言：**真件建得出网格**（几何读数对着 GLB 容器自己的 accessor 计数核）、
 * **既有 stl/obj/dae 三种真机器人不受影响**、**登记判据没有被放宽**（两种读法都不认的格式照旧抛）。
 *
 * 环境说明：Bun 没有 `ProgressEvent`（three 的 `FileLoader` 会 `new` 它）⇒ 补一个只当进度事件对象的垫片；
 * `resolveURI` 交回**真 `file:` URL**，字节从盘上读（`fileURLToPath` 失败即 ENOENT，路径解析错了当场红）。
 * DAE 分支要 `DOMParser`（`ColladaLoader`），Bun 没有 ⇒ 那一条只判"仍走 dae 分支、没有回落成
 * `UNSUPPORTED_ROBOT_VISUAL_MESH`"，解码本身留给浏览器（如实登记在回执里）。
 *
 * 运行：`bun test packages/viewer/test/robot-glb-mesh.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as THREE from "three"

import { glbJSON, parseAsset, robotVisual } from "../../scene-kit/src/formats.ts"
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"

class ProgressEventShim extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}
;(globalThis as any).ProgressEvent ??= ProgressEventShim

const ROOT = join(import.meta.dir, "..", "..", "..")
const FIXTURE = join(import.meta.dir, "fixtures", "robot-glb-mesh")
const BANANA_XML = join(FIXTURE, "banana.xml")
const BANANA_GLB = join(FIXTURE, "banana.glb")
/** 真件原件的 sha256（拷贝自 CAS 依赖目录，逐字节相同；见 PROVENANCE.md）。 */
const BANANA_XML_SHA256 = "8c279e975def17bef5b1681706dfe9128519e34d7d4a37bd05286c5870a9d77f"
const BANANA_GLB_SHA256 = "15ed7207a485b8c696a20ae5547f4cb023c552819cac4dfa5f91408bef50c3b0"

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** 真机器人文档（仓库内已入库的真件），用来量"既有三种格式不受影响"。 */
const GO1_MJCF = join(ROOT, "materials", "robots", "unitree_go1", "menagerie", "go1.xml")
/** 已批准公开的原版 Menagerie Panda 闭包；Apache-2.0，59 OBJ + 8 STL，见原目录 LICENSE。 */
const PANDA_MJCF = join(ROOT, "materials", "robots", "franka_panda", "franka_emika_panda", "panda.xml")
/** 真 Go2 URDF（`../dae/*.dae`）：在 `.runtime`（gitignore）里 ⇒ 不在的机器上跳过，不假装跑过。 */
const GO2_URDF = join(ROOT, ".runtime", "g1-archive", "extract", "resources", "robots", "go2", "urdf", "go2.urdf")

interface MeshFacts { positions: number; indices: number }
/** 建出来的网格几何读数：`positions`/`indices` 直接对着 GLB 容器自己的 accessor 计数核。 */
function meshFacts(visual: RobotVisual): MeshFacts[] {
  const facts: MeshFacts[] = []
  visual.root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    const geometry = object.geometry as THREE.BufferGeometry
    facts.push({ positions: geometry.attributes.position!.count, indices: geometry.index?.count ?? 0 })
  })
  return facts
}
/** 大网格（真 GLB 件 5,993 顶点）——把 MJCF 里的图元（碰撞盒 24 顶点、平面 4 顶点）分开。 */
const glbMeshes = (visual: RobotVisual): MeshFacts[] => meshFacts(visual).filter(facts => facts.positions > 1000)
/** 交回真 `file:` URL（真字节从盘上读；路径错了 `fileURLToPath` 直接 ENOENT）。 */
const serveRealBytes = (requested: string[]) => (uri: string): string => { requested.push(uri); readFileSync(fileURLToPath(uri)); return pathToFileURL(fileURLToPath(uri)).href }
/** 装载器 reject 的那一类警告（缺件/格式不支持），按主语分开记。 */
const loadFailures = (visual: RobotVisual): string[] => visual.warnings.filter(text => text.startsWith("MESH_LOAD_FAILED") || text.startsWith("UNSUPPORTED_ROBOT_VISUAL_MESH"))

describe("真件核对：banana 就是「机器人文档 + .glb 网格」", () => {
  test("两个夹具是**未改字节**的真件拷贝（sha256 对着原件）", () => {
    expect(sha256(BANANA_XML)).toBe(BANANA_XML_SHA256)
    expect(sha256(BANANA_GLB)).toBe(BANANA_GLB_SHA256)
    expect(readFileSync(BANANA_GLB).length).toBe(264012)
  })

  test("banana.glb 的容器事实：1 mesh、非 Draco、非 meshopt、非 KTX2", () => {
    const json = glbJSON(readFileSync(BANANA_GLB))
    expect(json.meshes.length).toBe(1)
    expect(json.extensionsRequired ?? []).toEqual([])                    // 没有必需扩展
    expect(json.extensionsUsed ?? []).toEqual(["KHR_materials_specular"]) // 没有 KHR_texture_basisu / EXT_meshopt_compression
    expect(json.images ?? []).toEqual([])                                 // 连贴图都没有 ⇒ 与 KTX2 无关
    const primitive = json.meshes[0].primitives[0]
    expect(json.accessors[primitive.attributes.POSITION].count).toBe(5993)
    expect(json.accessors[primitive.indices].count).toBe(35424)
  })
})

describe("B1：`.glb` 进依赖闭包（媒体路由候选集的唯一来源）", () => {
  test("parseAsset(真件文档) 不再抛 UNSUPPORTED_ROBOT_MESH_FORMAT，闭包里就有 banana.glb", async () => {
    const parsed = await parseAsset(BANANA_XML)
    expect(parsed.kind).toBe("robot")
    const paths = parsed.dependencies.map(item => item.path)
    expect(paths).toContain(BANANA_GLB)
    expect(paths).toContain(BANANA_XML)
    // 依赖是**内容寻址**的：闭包里的 .glb 就是那份真件（不是同名别的件）。
    const glb = parsed.dependencies.find(item => item.path === BANANA_GLB)!
    expect(glb.size).toBe(264012)
    expect(glb.sha256).toBe(BANANA_GLB_SHA256)
  })

  test("Viewer 请求的那一条定位符，逐字落在依赖闭包里（路由的 authorized 判据因此成立）", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(BANANA_XML) as any, serveRealBytes(requested))
    expect(requested).toEqual([pathToFileURL(BANANA_GLB).href])
    const parsed = await parseAsset(BANANA_XML)
    const dependencyUris = parsed.dependencies.map(item => pathToFileURL(item.path).href)
    expect(dependencyUris).toContain(requested[0]!)
    expect(meshFacts(visual).length).toBeGreaterThan(0)     // 断言不是空跑：这一条真的建出了网格
  })
})

describe("B2：真字节 ⇒ 真几何（装载器分派认 glb）", () => {
  test("buildRobotVisual 用真 .glb 字节建出网格，顶点/索引数与 GLB 自己的 accessor 一致", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(BANANA_XML) as any, serveRealBytes(requested))
    // 真件文档有 2 个 geom：1 个 mesh geom（.glb）+ 1 个碰撞盒图元 ⇒ 网格 ≥ 1 是硬判据，
    // 而 GLB 那一件的几何必须与容器里的 accessor 计数逐字相等（"建出来了"而不是"建了个空壳"）。
    const fromGlb = glbMeshes(visual)
    expect(fromGlb).toEqual([{ positions: 5993, indices: 35424 }])
    expect(requested).toEqual([pathToFileURL(BANANA_GLB).href])
    expect(loadFailures(visual)).toEqual([])
    expect(visual.warnings).toEqual([])
  })

  test("真件的碰撞盒图元照旧建出来（新增 glb 分支不影响同一文档里的其它 geom）", async () => {
    const visual = await buildRobotVisual(await robotVisual(BANANA_XML) as any, serveRealBytes([]))
    expect(meshFacts(visual).filter(facts => facts.positions <= 1000).length).toBe(1)
  })

  test("glTF 场景图整体进来（不是只挑第一个 Mesh）：节点名与容器里的 node name 一致", async () => {
    const json = glbJSON(readFileSync(BANANA_GLB))
    const names: string[] = []
    const visual = await buildRobotVisual(await robotVisual(BANANA_XML) as any, serveRealBytes([]))
    visual.root.traverse(object => { if (object.name) names.push(object.name) })
    for (const node of json.nodes) if (node.name) expect(names).toContain(node.name)
  })
})

describe("既有三种格式（真机器人文档 + 真字节）不受影响", () => {
  test("stl：Unitree Go1 MJCF（真件 + 13 个真 STL）", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(GO1_MJCF) as any, serveRealBytes(requested))
    expect(requested.length).toBe(13)
    expect(meshFacts(visual).length).toBe(55)
    expect(loadFailures(visual)).toEqual([])
    expect(visual.warnings).toEqual([])
  })

  test("obj：许可 Panda 原版 MJCF（59 个真实 OBJ，保原生 STL 碰撞依赖）", async () => {
    const parsed = await parseAsset(PANDA_MJCF)
    const objDependencies = parsed.dependencies.filter(item => item.path.endsWith('.obj'))
    expect(objDependencies.length).toBe(59)
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(PANDA_MJCF) as any, serveRealBytes(requested))
    // 原XML的worldbody声明81个geom，其中71个mesh实例（含两指复用），其余为原生图元。
    expect(requested.length).toBe(71)
    expect(meshFacts(visual).length).toBe(81)
    const dependencyUris=parsed.dependencies.map(item=>pathToFileURL(item.path).href)
    for(const uri of requested)expect(dependencyUris).toContain(uri)
    expect(requested.filter(uri=>uri.endsWith('.obj')).length).toBeGreaterThan(0)
    expect(meshFacts(visual).every(facts=>facts.positions>0)).toBe(true)
    expect(loadFailures(visual)).toEqual([])
    expect(visual.warnings).toEqual([])
  })

  test.skipIf(!existsSync(GO2_URDF))("dae：Unitree Go2 URDF 仍走 dae 分支（解码要 DOMParser，归浏览器）", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(GO2_URDF) as any, serveRealBytes(requested))
    expect(requested.length).toBe(17)
    expect(requested.every(uri => uri.endsWith(".dae"))).toBe(true)
    // 分派没回落：17 条一条都不是 UNSUPPORTED_ROBOT_VISUAL_MESH（Bun 没有 DOMParser，
    // ColladaLoader 在本机解不了 ⇒ 几何读数由真机/浏览器给，见回执"未覆盖"）。
    expect(visual.warnings.some(text => text.includes("UNSUPPORTED_ROBOT_VISUAL_MESH"))).toBe(false)
  })
})

describe("登记判据没有被放宽（负对照：还原 B1 的话这两条必须红）", () => {
  /** 临时真文档：MJCF 里引用一个指定扩展名的网格；网格文件写 1 字节（过 `EMPTY_OR_NON_FILE` 即可）。 */
  function documentWith(extension: string): { directory: string; document: string } {
    const directory = mkdtempSync(join(tmpdir(), "robot-glb-gate-"))
    writeFileSync(join(directory, `asset${extension}`), "x")
    writeFileSync(join(directory, "robot.xml"), `<mujoco model="gate"><compiler angle="radian" meshdir="." /><asset><mesh name="part" file="asset${extension}" /></asset><worldbody><body name="base"><geom type="mesh" mesh="part" /></body></worldbody></mujoco>`)
    return { directory, document: join(directory, "robot.xml") }
  }

  test("两种读法都不认的扩展名（.ply/.fbx）照旧抛 UNSUPPORTED_ROBOT_MESH_FORMAT", async () => {
    for (const extension of [".ply", ".fbx"]) {
      const failure = await parseAsset(documentWith(extension).document).then(() => undefined, (error: Error) => error.message)
      expect(failure).toContain("UNSUPPORTED_ROBOT_MESH_FORMAT")
      expect(failure).toContain(`asset${extension}`)
    }
  })

  test(".dae 仍不在登记闭包里（本单只收 .glb，没有顺手放宽别的格式）", async () => {
    const failure = await parseAsset(documentWith(".dae").document).then(() => undefined, (error: Error) => error.message)
    expect(failure).toContain("UNSUPPORTED_ROBOT_MESH_FORMAT")
  })

  test("原本就收的 .stl/.obj/.msh 照旧过（真 STL 字节）", async () => {
    const realStl = join(ROOT, "packages", "scene-kit", "test", "fixtures", "mjcf-duplicate-sections", "meshes", "a.stl")
    for (const extension of [".stl", ".obj", ".msh"]) {
      const { directory, document } = documentWith(extension)
      copyFileSync(realStl, join(directory, `asset${extension}`))       // 真 STL 字节，扩展名按参数改
      const parsed = await parseAsset(document)
      expect(parsed.dependencies.map(item => item.path)).toContain(join(directory, `asset${extension}`))
    }
  })

  test("glb 分支用的是 Viewer 那条**带解码器**的工厂（结构判据，行为面见 gltf-draco-decoder.test.ts）", () => {
    // 与 `gltf-draco-decoder.test.ts` ④ 同一条口径：Viewer 要 WebGL/DOM 才能构造，本机跑不起行为面，
    // 所以"用没用带解码器的装载器"读源码文本 —— 裸 `new GLTFLoader()` 遇到 Draco 件会在构造期抛
    // `No DRACOLoader instance provided`（上一单的根因），这条判据防的就是它。
    //
    // ROBOT-GLB-KTX2-TEXTURE-20260927 起这条钉得**更严**（不是放宽）：工厂入参必须带 `renderer`
    // （KTX2 转码要先 `detectSupport`，不带就静默丢贴图），装载后必须过一遍
    // `noteTexturesNotAttached`（把那种"静默"变成一条明确警告）。
    const source = readFileSync(join(import.meta.dir, "..", "src", "robot.ts"), "utf8")
    expect(source).toContain('import { createGltfLoader } from "./draco-decoder.ts"')
    expect(source).toContain("createGltfLoader({ renderer: options.renderer })")
    expect(source).toContain("noteTexturesNotAttached(gltf, file)")
    // 注释里可以提这件事（上面那段 doc 就提了），判据看的是**代码**：先剥掉注释再判。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).not.toContain("new GLTFLoader(")
  })
})
