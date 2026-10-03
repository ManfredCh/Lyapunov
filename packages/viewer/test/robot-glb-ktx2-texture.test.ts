/**
 * 机器人文档里的 **带 KTX2（`KHR_texture_basisu`）贴图的 `.glb`**：
 * **贴图必须真的贴上；贴不上必须明确报错**（ROBOT-GLB-KTX2-TEXTURE-20260927）。
 *
 * ## 这一单修的是什么（跨单接线缺口，逐环读源码确认）
 *
 * `robot.ts` 的 glb 分支调的是 `createGltfLoader()`（**不带 renderer**），而
 * `createKtx2Loader(manager, probe?)` 在 `probe` 缺省时**跳过 `detectSupport`**（`ktx2-decoder.ts`）
 * ⇒ `KTX2Loader.workerConfig` 一直是 `null` ⇒ `load()` 抛
 * `THREE.KTX2Loader: Missing initialization with '.detectSupport( renderer )'.`（`KTX2Loader.js:341-343`）
 * ⇒ **而那个抛会被 `GLTFLoader` 吞掉**（`GLTFLoader.js:3349-3353` 的 `.catch(function () { return null; })`；
 * 上一环 `loadImageSource` 的 catch 只在控制台留一行 `THREE.GLTFLoader: Couldn't load texture` 就 rethrow，
 * `assignTexture()` 拿到 null 直接 `return null`）⇒ 几何照建、`loadAsync()` 照样 resolve、
 * `warnings` 是空数组 ⇒ **用户看到"机器人没有贴图"，而不是任何报错**。
 *
 * ## 真件（不是合成夹具）
 *
 * `test/fixtures/robot-glb-ktx2/`：手写的**最小真 MJCF 机器人文档**（带一个 hinge 关节、一个 `.glb`
 * 网格图元、一个碰撞盒）+ 一份**真编码器产出的 KTX2 `.glb`**
 * （`gltf-transform etc1s`，后端 KTX-Software 4.4.0 的 `ktx`；逐字节拷贝自 `fixtures/ktx2-meshopt/`，
 * 来源与 sha256 见该目录 `PROVENANCE.md`）。那份 `.glb` 的 `extensionsRequired` 里就有
 * `KHR_texture_basisu`、`images[0].mimeType === "image/ktx2"` —— 容器事实由本文件自己读出来核。
 *
 * ## 三个方向
 *
 *  ① 传 renderer ⇒ 贴图真的挂上（`CompressedTexture`、8×8、4 级 mipmap）、`warnings` 为空；
 *  ② 不带 KTX2 的 `.glb`（真件 `banana.glb`）与真 STL 机器人 ⇒ 读数**逐项不变**；
 *  ③ 不传 renderer / 声明了 MJCF material ⇒ **必须有一条明确警告**，不再是"无贴图、无报错"。
 *
 * 本机跑 bun 测试没有 WebGL 上下文，渲染器能力用**能力替身**（如实报"没有任何压缩纹理扩展"）——
 * 那是 three 文档里的 RGBA 回落路径，不是假装有 GPU（与 `gltf-ktx2-meshopt-decoders.test.ts` 同一份替身）。
 *
 * 零出网：字节经真 `file:` URL 从盘上读（`fileURLToPath` 失败即 ENOENT，路径错了当场红）。
 * 运行：`bun test packages/viewer/test/robot-glb-ktx2-texture.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as THREE from "three"

import { glbJSON, parseAsset, robotVisual } from "../../scene-kit/src/formats.ts"
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"
import type { Ktx2SupportProbe } from "../src/ktx2-decoder.ts"

/** bun 没实现 `ProgressEvent`，而 three 的 `FileLoader` 在进度回调里会构造它。 */
class ProgressEventShim extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}
;(globalThis as any).ProgressEvent ??= ProgressEventShim

const ROOT = join(import.meta.dir, "..", "..", "..")
const FIXTURE = join(import.meta.dir, "fixtures", "robot-glb-ktx2")
const ROBOT_XML = join(FIXTURE, "robot-ktx2.xml")
const ROBOT_MATERIAL_XML = join(FIXTURE, "robot-ktx2-material.xml")
const ROBOT_EXTERNAL_XML = join(FIXTURE, "robot-ktx2-external.xml")
const KTX2_GLB = join(FIXTURE, "cube-ktx2-etc1s.glb")
/** 真编码器产物的 sha256（`fixtures/ktx2-meshopt/PROVENANCE.md` 里那一份，逐字节相同）。 */
const KTX2_GLB_SHA256 = "a2113d1561d8e06138502c26338308b5b59e16c1944d117b69db48d3d8de7b87"
/**
 * 并入件：**贴图是外部文件**的 `.glb`（由上面那份真编码器产物派生：把 `images[0]` 的字节抽成同目录的
 * `checker8.ktx2`，几何仍内嵌）。派生脚本与逐字节对照见 `PROVENANCE.md`。
 */
const EXTERNAL_GLB = join(FIXTURE, "cube-ktx2-etc1s-external-image.glb")
const EXTERNAL_IMAGE = join(FIXTURE, "checker8.ktx2")
const EXTERNAL_GLB_SHA256 = "5347c2a17ad457afe89213bd5e7bca46e838d2ff2f72f4d5a5f93d75140f0831"
const EXTERNAL_IMAGE_SHA256 = "871904d7a51f557d9c3eb2d9b5ddc256881c38071272685d83a88855c2b180d6"
/** 不带 KTX2 的真件（上一单的夹具）：用来量方向 ②"逐项不变"。 */
const BANANA_XML = join(import.meta.dir, "fixtures", "robot-glb-mesh", "banana.xml")
const GO1_XML = join(ROOT, "materials", "robots", "unitree_go1", "menagerie", "go1.xml")

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

const NO_COMPRESSED_TEXTURE_SUPPORT: Ktx2SupportProbe = {
  extensions: { has: () => false, get: () => ({ getSupportedProfiles: () => [] }) },
}

/** 交回真 `file:` URL（真字节从盘上读；路径错了 `fileURLToPath` 直接 ENOENT）。 */
const serveRealBytes = (requested: string[] = []) => (uri: string): string => {
  requested.push(uri)
  return pathToFileURL(fileURLToPath(uri)).href
}

interface TextureFacts {
  /** 挂到材质上的**不同**贴图实例数（clone 出来的算不同实例）。 */
  textures: number
  kinds: string[]
  sizes: string[]
  mipmaps: number[]
  materials: string[]
  meshes: Array<{ positions: number; indices: number }>
}
function textureFacts(visual: RobotVisual): TextureFacts {
  const maps = new Set<THREE.Texture>()
  const materials: string[] = []
  const meshes: Array<{ positions: number; indices: number }> = []
  visual.root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    meshes.push({ positions: geometry.getAttribute("position")?.count ?? 0, indices: geometry.index?.count ?? 0 })
    const material = mesh.material as THREE.MeshStandardMaterial
    materials.push(`${material.type}${material.map ? "+map" : ""}`)
    if (material.map) maps.add(material.map)
  })
  const list = [...maps]
  return {
    textures: list.length,
    kinds: list.map(texture => (texture as THREE.CompressedTexture).isCompressedTexture ? "CompressedTexture" : String(texture.type)),
    sizes: list.map(texture => `${(texture.image as any)?.width ?? "?"}×${(texture.image as any)?.height ?? "?"}`),
    mipmaps: list.map(texture => (texture as THREE.CompressedTexture).mipmaps?.length ?? 0),
    materials, meshes,
  }
}
const meshFacts = (visual: RobotVisual): Array<{ positions: number; indices: number }> => textureFacts(visual).meshes
const warningsMatching = (visual: RobotVisual, code: string): string[] => visual.warnings.filter(text => text.startsWith(code))

/** 跑一条真链：真 MJCF 文档 → 真 `buildRobotVisual`；`renderer` 传/不传是**唯一的自变量**。 */
async function runRobot(document: string, options?: { renderer?: Ktx2SupportProbe }): Promise<RobotVisual> {
  const input = await robotVisual(document)
  return options ? await buildRobotVisual(input as any, serveRealBytes(), options) : await buildRobotVisual(input as any, serveRealBytes())
}

describe("真件：MJCF 机器人文档 + 带 KTX2 贴图的 .glb", () => {
  test("那份 .glb 真的是 KTX2 件（容器事实自己读，不看别人的登记）", () => {
    expect(sha256(KTX2_GLB)).toBe(KTX2_GLB_SHA256)
    const json = glbJSON(readFileSync(KTX2_GLB))
    expect(json.extensionsUsed).toContain("KHR_texture_basisu")
    expect(json.extensionsRequired).toContain("KHR_texture_basisu")
    expect(json.textures.length).toBe(1)
    expect(json.images.length).toBe(1)
    expect(json.images[0].mimeType).toBe("image/ktx2")
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture.index).toBe(0)
    // 同族的对照事实：这份件**没有** Draco、没有 meshopt（本单只量 KTX2 那条路）。
    expect(json.extensionsUsed).not.toContain("KHR_draco_mesh_compression")
    expect(json.extensionsUsed).not.toContain("EXT_meshopt_compression")
  })

  test("机器人文档真的引用它：依赖闭包里有那份 .glb（登记得进 ⇒ 字节取得到）", async () => {
    const parsed = await parseAsset(ROBOT_XML)
    expect(parsed.kind).toBe("robot")
    const paths = parsed.dependencies.map(item => item.path)
    expect(paths).toContain(KTX2_GLB)
    expect(paths).toContain(ROBOT_XML)
    expect(parsed.dependencies.find(item => item.path === KTX2_GLB)!.sha256).toBe(KTX2_GLB_SHA256)
  })
})

describe("① 判据（核心）：带 KTX2 贴图的机器人 glb ⇒ 贴图**真的贴上**", () => {
  test("传 renderer：贴图挂上了（CompressedTexture、8×8、4 级 mipmap），几何也照旧，且没有告警", async () => {
    const requested: string[] = []
    const input = await robotVisual(ROBOT_XML)
    const visual = await buildRobotVisual(input as any, serveRealBytes(requested), { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    expect(requested).toEqual([pathToFileURL(KTX2_GLB).href])
    const facts = textureFacts(visual)
    // 几何：那份 .glb 是 24 顶点 / 36 索引（12 三角形），另有一个碰撞盒图元。
    expect(facts.meshes).toEqual([{ positions: 24, indices: 36 }, { positions: 24, indices: 36 }])
    // ★ 本单的判据：贴图真的在材质上（不是"没有、也不报错"）。
    expect(facts.textures).toBe(1)
    expect(facts.kinds).toEqual(["CompressedTexture"])
    expect(facts.sizes).toEqual(["8×8"])
    expect(facts.mipmaps).toEqual([4])
    expect(facts.materials).toEqual(["MeshStandardMaterial+map", "MeshStandardMaterial"])
    // 贴上了就不该有"贴图没挂上"那类告警（否则就是误报）。
    expect(warningsMatching(visual, "ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED")).toEqual([])
    expect(visual.warnings).toEqual([])
  })
})

describe("③ 判据：静默必须消失 —— 贴不上就【明确报错】", () => {
  test("同一份件不传 renderer：贴图挂不上，但**必须有一条指名道姓的警告**（改前这里是 `warnings = []` 的静默丢失）", async () => {
    // 这一段会有一行 three 自己的 `console.error`（那条"被吞掉"的痕迹）；收起来当证据，别污染测试输出。
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")) }
    let visual: RobotVisual
    try {
      visual = await runRobot(ROBOT_XML)
    } finally {
      console.error = original
    }
    const facts = textureFacts(visual)
    expect(facts.textures, "贴图确实没挂上（这就是那条链的后果）").toBe(0)
    expect(facts.meshes, "几何照旧建出来 —— 所以失败是'安静的'").toEqual([{ positions: 24, indices: 36 }, { positions: 24, indices: 36 }])
    // ★ 判据：不许再出现"无贴图、无报错"。
    const reported = warningsMatching(visual, "ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED")
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain("cube-ktx2-etc1s.glb")
    expect(reported[0]).toContain("glTF 声明 1 张贴图，装载后只挂上 0 张")
    expect(reported[0]).toContain("没传 renderer")
    // 旁证：被吞掉的那条失败在控制台只留一行 three 自己的话（产品侧原本一条都不留）。
    expect(logged.some(line => line.includes("Couldn't load texture"))).toBe(true)
  })

  test("传了 renderer 但贴图链仍失败时，报的是另一条成因（不是把锅甩给 renderer）", async () => {
    // 用一份**假渲染器**：`extensions.has` 直接抛 —— 能力探测当场失败 ⇒ `createKtx2Loader` 的
    // `detectKtx2Support` 拒绝跳过（`VIEWER_KTX2_SUPPORT_PROBE_INVALID` 那条），
    // 整件装载 reject ⇒ 走既有的 `MESH_LOAD_FAILED` 通道，而不是静默。
    const broken = { extensions: { has: () => { throw new Error("probe exploded") }, get: () => ({ getSupportedProfiles: () => [] }) } } as unknown as Ktx2SupportProbe
    const visual = await runRobot(ROBOT_XML, { renderer: broken })
    const failures = visual.warnings.filter(text => text.startsWith("MESH_LOAD_FAILED"))
    expect(failures.length, `实际警告：${visual.warnings.join(" | ")}`).toBe(1)
    expect(failures[0]).toContain("shell")                 // 主语是文档里的网格名（与既有 MESH_LOAD_FAILED 同一把键）
    expect(failures[0]).toContain("probe exploded")
    expect(textureFacts(visual).textures).toBe(0)
    expect(visual.warnings.some(text => text.includes("ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED"))).toBe(false)
  })

  test("图元声明了 MJCF material（无贴图）⇒ `.glb` 自带贴图被调制语义替换，但那**不是静默**", async () => {
    const visual = await runRobot(ROBOT_MATERIAL_XML, { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    const overridden = warningsMatching(visual, "ROBOT_VISUAL_GLB_TEXTURE_OVERRIDDEN")
    expect(overridden.length).toBe(1)
    expect(overridden[0]).toContain("cube-ktx2-etc1s.glb")
    expect(overridden[0]).toContain("shell_paint")
    // 渲染语义**一个字没改**：材质仍按 MJCF 调制色走，贴图不参与（本单只把这件事说出来）。
    const facts = textureFacts(visual)
    expect(facts.textures).toBe(0)
    expect(facts.materials).toEqual(["MeshStandardMaterial", "MeshStandardMaterial"])
    // 这一条与"KTX2 没挂上"是两种不同的成因，不许混成一条。
    expect(warningsMatching(visual, "ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED")).toEqual([])
  })
})

describe("并入件：`.glb` 自带**外部** buffers/images ⇒ 字节取不到时必须明确报错（不许静默）", () => {
  test("容器事实：那份 .glb 的贴图真的是**外部文件**，且外部字节与源件里那段逐字节相同", () => {
    expect(sha256(EXTERNAL_GLB)).toBe(EXTERNAL_GLB_SHA256)
    const json = glbJSON(readFileSync(EXTERNAL_GLB))
    expect(json.extensionsRequired).toContain("KHR_texture_basisu")
    expect(json.images[0]).toEqual({ name: "checker8", mimeType: "image/ktx2", uri: "checker8.ktx2" })
    expect(json.buffers[0].uri, "几何仍是内嵌 BIN chunk（派生动的是 image 的指向，不是几何）").toBeUndefined()
    expect(json.textures.length).toBe(1)
    // 外部文件里的字节 = 源件（内嵌版）里那段 image 的字节：派生没有换内容，只换了**指向**。
    const source = readFileSync(KTX2_GLB)
    const sourceJson = glbJSON(source)
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
    const bin = source.subarray(20 + view.getUint32(12, true) + 8)
    const bufferView = sourceJson.bufferViews[sourceJson.images[0].bufferView]
    const embedded = bin.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength)
    expect(sha256(EXTERNAL_IMAGE)).toBe(EXTERNAL_IMAGE_SHA256)
    expect([...embedded]).toEqual([...readFileSync(EXTERNAL_IMAGE)])
  })

  test("伴生文件取不到（路由 404）⇒ 贴图挂不上，但**必须有一条点名那个外部文件的警告**", async () => {
    // 忠实模拟产品侧的失败面：媒体路由对"没登记进依赖闭包"的文件回 404（这里用 `fetch` 替身，
    // 只拦那一个外部文件；`file:` 的其它请求照旧走本地，全程零出网）。
    const originalFetch = globalThis.fetch
    const logged: string[] = []
    const originalError = console.error
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input)
      if (url.endsWith("checker8.ktx2")) return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }))
      return originalFetch(input, init)
    }) as typeof fetch
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")) }
    let visual: RobotVisual
    try {
      visual = await runRobot(ROBOT_EXTERNAL_XML, { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    } finally {
      globalThis.fetch = originalFetch
      console.error = originalError
    }
    const facts = textureFacts(visual)
    expect(facts.textures, "贴图确实没挂上（那个外部文件没交付）").toBe(0)
    expect(facts.meshes, "几何是内嵌的 ⇒ 照旧建出来（所以这一态也是'安静'的）").toEqual([{ positions: 24, indices: 36 }, { positions: 24, indices: 36 }])
    // ★ 判据：取不到字节可以，但**不许静默** —— 警告必须点名那个伴生文件与闭包边界这件事。
    const reported = warningsMatching(visual, "ROBOT_VISUAL_GLB_TEXTURE_NOT_ATTACHED")
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain("checker8.ktx2")
    expect(reported[0]).toContain("机器人依赖闭包只收 .glb 本身")
    expect(logged.some(line => line.includes("Couldn't load texture"))).toBe(true)
  })

  test("伴生文件也在（同一目录）⇒ 贴图挂上：证明缺的是**交付/登记**，不是这份件或这条链", async () => {
    const visual = await runRobot(ROBOT_EXTERNAL_XML, { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    const facts = textureFacts(visual)
    expect(facts.textures).toBe(1)
    expect(facts.kinds).toEqual(["CompressedTexture"])
    expect(facts.sizes).toEqual(["8×8"])
    expect(facts.mipmaps).toEqual([4])
    expect(visual.warnings).toEqual([])
  })
})

describe("② 判据：不带 KTX2 的件**逐项不变**", () => {
  test("真件 banana.glb：传 renderer 与不传 renderer，几何/材质/告警逐项相同", async () => {
    const withProbe = await runRobot(BANANA_XML, { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    const withoutProbe = await runRobot(BANANA_XML)
    const facts = (visual: RobotVisual) => ({ ...textureFacts(visual), warnings: visual.warnings })
    expect(facts(withProbe)).toEqual(facts(withoutProbe))
    // 与上一单的既有读数逐项相同：5,993 顶点 / 35,424 索引 + 碰撞盒，11,820 三角形，无告警。
    expect(meshFacts(withProbe)).toEqual([{ positions: 5993, indices: 35424 }, { positions: 24, indices: 36 }])
    expect(textureFacts(withProbe).textures).toBe(0)          // 那份件本来就没有贴图（images=0）
    expect(withProbe.warnings).toEqual([])
  })

  test("真 STL 机器人 Go1（13 个真 STL）：55 个 Mesh、无告警", async () => {
    const visual = await runRobot(GO1_XML, { renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    expect(meshFacts(visual).length).toBe(55)
    expect(visual.warnings).toEqual([])
  })
})

describe("结构判据：glb 分支把 renderer 带进工厂", () => {
  test("源码里 glb 分支写的是 `createGltfLoader({ renderer: options.renderer })`，且没有裸构造", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "robot.ts"), "utf8")
    expect(source).toContain('import { createGltfLoader } from "./draco-decoder.ts"')
    expect(source).toContain("createGltfLoader({ renderer: options.renderer })")
    // 注释里可以提这件事；判据看的是**代码**，先剥注释再判。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    expect(code).not.toContain("new GLTFLoader(")
  })

  test("★产品调用点把 renderer 交给装配器：`index.ts` 的 `buildRobotVisual(...)` 带第三个实参", () => {
    // 判据 ① 在**真机用户路径**上成立的前提就是这一行：装配器是纯函数、手里没有 renderer，
    // 缺这个实参时它只能走"不传 renderer"那条（贴图挂不上，只剩一条明确警告）。
    const code = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
      .split("\n").filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n")
    expect(code).toContain("buildRobotVisual(")
    const call = code.slice(code.indexOf("buildRobotVisual("))
    expect(call.slice(0, call.indexOf("\n"))).toContain("{ renderer: this.renderer }")
  })
})
