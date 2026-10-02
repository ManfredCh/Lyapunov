/**
 * 根因判据：**viewer 的 glTF 读取路径必须带 KTX2（`KHR_texture_basisu`）与 meshopt（`EXT_meshopt_compression`）
 * 解码器**，而且解码器字节来自产品自己（内联 / 模块自带）。
 *
 * 这一族缺陷的现场（`bugfixHistory/GLB-DRACO-RENDER-20260926.md` §7 第 3 条）：
 * DRACO 修好之后，viewer 的渲染路径**仍然没有**接这两个解码器 —— 与 DRACO 修前**同形**：
 * `client.tsx:36-37` 只是把 `KTX2Loader`/`MeshoptDecoder` **对外转出**（那是给 workspace 用的公开面），
 * `index.ts` 一处都没 `new` 过 ⇒ **转出 ≠ 接上**。带这两个扩展的 `.glb` 整件加载失败。
 *
 * three 侧的两条 throw（**读源码确认，不猜**）：
 * ```
 * GLTFLoader.js:1554  throw new Error( 'THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures' );
 * GLTFLoader.js:1697  throw new Error( 'THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files' );
 * ```
 * 两条都只在 `extensionsRequired` 里点名该扩展时抛（否则 `return null` 当可选扩展放过），
 * 且**都没人接**（`GLTFParser._invokeOne()` 不吞异常，`GLTFLoader.js:2904`）⇒ 整个 `loadAsync()` 被拒。
 * 另有一条 KTX2 专属的硬要求：`KTX2Loader.load()/parse()` 在 `workerConfig === null` 时抛
 * `THREE.KTX2Loader: Missing initialization with '.detectSupport( renderer )'.`（`KTX2Loader.js:343/374`）。
 * ⚠️ 这一条的**后果面更隐蔽**：那个抛发生在贴图加载链里，被 `GLTFLoader.js:3351` 的
 * `.catch( function () { return null; } )` 吞掉 ⇒ 几何照建、**贴图静默丢失**、`loadAsync()` 照样成功。
 * 所以"装了 KTX2Loader 但没探测渲染器能力"≠"修好了"。
 *
 * 本文件钉住的七件事：
 *  ① 装载器真的带上了 `KTX2Loader` 与 `MeshoptDecoder`（meshopt 那个对象**就是** three 自带的模块导出）；
 *  ② 内联的 584,862 B 转码器与盘上 `node_modules/three/examples/jsm/libs/basis/` 的**真实文件逐字节相同**
 *     （长度 + sha256 + wasm 魔数），不是占位、不是空壳；
 *  ③ meshopt 侧**不需要**额外内联数据文件（three 的模块里 wasm 已 base64 内嵌、不 fetch/不 importScripts），
 *     把这条事实读出来钉住，免得下次有人以为"漏了一份数据"；
 *  ④ 改写器**只**认登记过的解码器请求（两条路由、精确到文件名）—— glTF 自己的资源一个都不动；
 *  ⑤ **真件判据（本单的关键）**：`test/fixtures/ktx2-meshopt/` 那两份真 `.glb`（真编码器产出，
 *     见该目录 `PROVENANCE.md`）在**带解码器**的装载器上真的解出来了 —— 几何读出 24 顶点/12 三角形，
 *     KTX2 读出 `CompressedTexture` + 4 级 mipmap；对照件（不带压缩）照旧能加载；
 *  ⑥ **负对照（同一份真件）**：不带解码器的裸 `GLTFLoader` 对同一份字节逐字报上面那两句 ⇒
 *     证明"没接上就是整件加载失败"，这正是被修的那个缺陷；
 *  ⑦ 结构判据：`index.ts` 把**渲染器**带进工厂（不带 = KTX2 还是坏的）。
 *
 * 本机跑 bun 测试没有 WebGL 上下文，所以 ⑤ 里的渲染器能力用一个**能力替身**（没有任何压缩纹理扩展）
 * 喂给 `detectSupport` —— 那是 three 文档里的 RGBA 回落路径，不是假装有 GPU。真机（真 Chrome + 真产品
 * host）的读数见回执 `bugfixHistory/KTX2-MESHOPT-WIRING-20260927-IMPL.md` §5（前后两个方向都在那里）。
 *
 * 运行：`bun test packages/viewer/test/gltf-ktx2-meshopt-decoders.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"

import {
  DRACO_DECODER_ROUTE, INLINE_DECODER_ROUTES, createDecoderBlobSource, createGltfLoader, releaseGltfLoader,
} from "../src/draco-decoder.ts"
import {
  KTX2_INLINE_FILE_NAMES, KTX2_TRANSCODER_ROUTE, ktx2InlineBytes, type Ktx2SupportProbe,
} from "../src/ktx2-decoder.ts"
import { KTX2_INLINE_TRANSCODER } from "../src/ktx2-transcoder-data.ts"

const ROOT = join(import.meta.dirname, "..", "..", "..")
// 路径常量**不许**叫 `THREE`：那与上面 `import * as THREE from "three"` 的模块命名空间同名
// （`TS2440: Import declaration conflicts with local declaration of 'THREE'`）。命名跟同族的
// `gltf-draco-decoder.test.ts` 的 `THREE_DRACO_DIR` 一条规矩。
const THREE_JSM_DIR = join(ROOT, "node_modules", "three", "examples", "jsm")
const BASIS_DIR = join(THREE_JSM_DIR, "libs", "basis")
const GLTF_LOADER_SOURCE = join(THREE_JSM_DIR, "loaders", "GLTFLoader.js")
const KTX2_LOADER_SOURCE = join(THREE_JSM_DIR, "loaders", "KTX2Loader.js")
const MESHOPT_MODULE = join(THREE_JSM_DIR, "libs", "meshopt_decoder.module.js")
const VIEWER_INDEX = join(ROOT, "packages", "viewer", "src", "index.ts")
const FIXTURES = join(import.meta.dirname, "fixtures", "ktx2-meshopt")

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const readFixture = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FIXTURES, name)))
/** 判据只读**当时的字节**：`.slice()` 让下面每个 parse 都拿到独立 ArrayBuffer（three 会转移/复用视图）。 */
const bufferOf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer

/**
 * `KTX2Loader.workerConfig` 是**真行为**（`load()` 靠它判断有没有探测过渲染器能力），
 * 但 `@types/three` 把它声明成非空 ⇒ 断言必须走这个窄化读取，别把测试写成 `as any`
 * （那样连字段名写错都发现不了）。
 */
const workerConfigOf = (loader: KTX2Loader): unknown => (loader as unknown as { workerConfig: unknown }).workerConfig

/**
 * **渲染器能力替身**：本机跑 bun 测试时没有 WebGL 上下文，而 `detectSupport()` 只读
 * `isWebGPURenderer` / `extensions.has()` / `extensions.get().getSupportedProfiles()` 三处
 * （`KTX2Loader.js:223-258`，逐行读过）。这里如实报"没有任何压缩纹理扩展" ⇒ 转码目标是 RGBA 回落路径。
 */
const NO_COMPRESSED_TEXTURE_SUPPORT: Ktx2SupportProbe = {
  extensions: { has: () => false, get: () => ({ getSupportedProfiles: () => [] }) },
}

/** bun 没实现 `ProgressEvent`，而 three 的 `FileLoader` 在进度回调里会构造它（读内联转码器时会走到）。 */
class TestProgressEvent extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
  constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
    super(type)
    this.lengthComputable = init.lengthComputable ?? false
    this.loaded = init.loaded ?? 0
    this.total = init.total ?? 0
  }
}
;(globalThis as unknown as { ProgressEvent?: unknown }).ProgressEvent ??= TestProgressEvent

const meshStats = (gltf: { scene: THREE.Object3D }): { vertices: number; triangles: number; meshes: number } => {
  let vertices = 0, triangles = 0, meshes = 0
  gltf.scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    meshes += 1
    const geometry = mesh.geometry as THREE.BufferGeometry
    vertices += geometry.getAttribute("position")?.count ?? 0
    triangles += (geometry.index ? geometry.index.count : geometry.getAttribute("position")?.count ?? 0) / 3
  })
  return { vertices, triangles, meshes }
}

/** 解析一份真件，返回 three 的 GLTF 结果；用于 `parseAsync`（本机没有 DOM/WebGL 也能解几何与 CompressedTexture）。 */
const parseFixture = async (loader: GLTFLoader, name: string) => await loader.parseAsync(bufferOf(await readFixture(name)), "")

describe("① 装载器带 KTX2 + meshopt 解码器（与 DRACO 同一个工厂）", () => {
  test("ktx2Loader 是真的 KTX2Loader，且转码器基址与改写判据同一份", () => {
    const loader = createGltfLoader({ renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    try {
      expect(loader.ktx2Loader).toBeInstanceOf(KTX2Loader)
      // 装载器与改写器必须用**同一个**基址：不一致时改写器一个请求都匹配不上，
      // 表现就和"没接解码器"一样（KTX2 贴图仍然建不出来），而且没有任何报错提示这件事。
      expect(loader.ktx2Loader!.transcoderPath).toBe(KTX2_TRANSCODER_ROUTE)
      expect(KTX2_TRANSCODER_ROUTE.startsWith("/api/lyapunov/viewer/asset/")).toBe(true)
    } finally {
      releaseGltfLoader(loader)
    }
  })

  test("meshoptDecoder 就是 three 自带那个模块导出（不是替身、不是空对象）", () => {
    const loader = createGltfLoader()
    try {
      expect(loader.meshoptDecoder).toBe(MeshoptDecoder)
      // 解码器自己声明它可用（`supported` 为假时 three 会当成"没接"并抛错，见 ⑥）。
      expect((MeshoptDecoder as unknown as { supported: boolean }).supported).toBe(true)
    } finally {
      releaseGltfLoader(loader)
    }
  })

  test("没传 renderer 时 workerConfig 仍是 null（KTX2 会抛它自己的初始化错误，不是静默通过）", () => {
    // 这不是"测试实现细节"：`KTX2Loader.load()` 正是用 `workerConfig === null` 判断"没探测过能力"。
    const bare = createGltfLoader()
    const probed = createGltfLoader({ renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    try {
      expect(workerConfigOf(bare.ktx2Loader!)).toBeNull()
      expect(workerConfigOf(probed.ktx2Loader!)).not.toBeNull()
      expect(workerConfigOf(probed.ktx2Loader!)).toMatchObject({ astcSupported: false, etc1Supported: false, dxtSupported: false })
    } finally {
      releaseGltfLoader(bare); releaseGltfLoader(probed)
    }
  })
})

describe("② 内联转码器字节 = 盘上 three 的真实文件", () => {
  test("长度、sha256、wasm 魔数与盘上文件逐项相同", async () => {
    for (const name of KTX2_INLINE_FILE_NAMES) {
      const entry = KTX2_INLINE_TRANSCODER[name]
      expect(entry, `内联表里没有 ${name}`).toBeDefined()
      const onDisk = await readFile(join(BASIS_DIR, name))
      const inlined = ktx2InlineBytes(name)!
      expect(inlined.byteLength, `${name} 长度`).toBe(onDisk.byteLength)
      expect(inlined.byteLength, `${name} 与表中登记的长度`).toBe(entry!.bytes)
      expect(sha256(inlined), `${name} sha256`).toBe(sha256(onDisk))
      expect(sha256(inlined), `${name} 与表中登记的 sha256`).toBe(entry!.sha256)
    }
    // wasm 魔数 `\0asm`：证明内联的是真的 WebAssembly 模块，不是被 base64 过的占位文本。
    const wasm = ktx2InlineBytes("basis_transcoder.wasm")!
    expect([...wasm.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d])
    // wrapper 是真 JS：`KTX2Loader.init()` 会把它整段拼进 Worker 源码里，必须能找到它导出的那个工厂名。
    expect(new TextDecoder().decode(ktx2InlineBytes("basis_transcoder.js")!)).toContain("BASIS")
  })

  test("内联表覆盖 KTX2Loader.init() 会取的两个文件名，且没多没少", async () => {
    const source = await readFile(KTX2_LOADER_SOURCE, "utf8")
    // 直接读 three 的实现，把"它会请求哪两个名字"当成**上游事实**核对，不靠本文件里的印象。
    const requested = [...source.matchAll(/jsLoader\.loadAsync\(\s*'([^']+)'|binaryLoader\.loadAsync\(\s*'([^']+)'/g)]
      .map(match => match[1] ?? match[2]!)
    expect(requested).toEqual([...KTX2_INLINE_FILE_NAMES])
    expect(Object.keys(KTX2_INLINE_TRANSCODER).sort()).toEqual([...KTX2_INLINE_FILE_NAMES].sort())
    // 转码器只有这两个文件（three 的 basis 目录里就是它们）；多一个文件 = 这张白名单要重核。
    expect(KTX2_INLINE_FILE_NAMES.length).toBe(2)
  })
})

describe("③ meshopt 解码器自带 wasm ⇒ 不需要额外内联数据文件", () => {
  test("three 的 meshopt_decoder.module.js 不取任何网络资源，wasm 以 base64 内嵌在模块里", async () => {
    const source = await readFile(MESHOPT_MODULE, "utf8")
    // "自带"这条事实必须**读出来**：它决定本单要不要再加一份 `*-data.ts`（DRACO/KTX2 都要，它不要）。
    expect(source).not.toContain("fetch(")
    expect(source).not.toContain("XMLHttpRequest")
    expect(source).not.toContain("importScripts")
    expect(source).toContain("WebAssembly.instantiate")
    // 内嵌的 wasm 是一段很长的自定义字母表 base64（`var wasm_base = '...'` / `wasm_simd`），不是外链。
    // 注意：meshopt 的 base64 字母表里有 `:` 与 `;`，不能用标准的 A-Za-z0-9+/= 去匹配。
    const embedded = [...source.matchAll(/var (wasm_base|wasm_simd) =\s*\n?\s*'([^']{1000,})'/g)]
    expect(embedded.map(match => match[1]).sort()).toEqual(["wasm_base", "wasm_simd"])
    // 两份内嵌字节的实测长度：wasm_base 7,025 / wasm_simd 11,846 个字符（自定义字母表）。
    // 下界取 5,000：红了就说明 three 换了装法（那时"不需要额外数据文件"这条结论要重核）。
    for (const match of embedded) expect(match[2]!.length, `${match[1]} 的 base64 长度`).toBeGreaterThan(5_000)
  })
})

describe("④ 改写器：只动登记过的解码器请求（两条路由）", () => {
  test("KTX2 路由 → blob；裸文件名、别人的路由、glTF 资源一律 undefined", () => {
    const source = createDecoderBlobSource()
    try {
      expect(source.created()).toEqual([])
      for (const untouched of [
        "/api/lyapunov/resource?sceneId=ktx2-meshopt&uri=res%3Ae0200a9d",
        "res:e0200a9d-99ae-4215-8a0f-6c78d3e40e77",
        "https://example.test/models/scene.glb",
        // 裸文件名不是改写器的输入形状（装载器手里是整个 URL）：不认，避免"顺手也把相对路径换了"。
        "basis_transcoder.js", "basis_transcoder.wasm", "draco_decoder.wasm",
        // 前缀相近但不是这条路由：不许被前缀匹配吃掉。
        "/api/lyapunov/viewer/asset/basis-extra/basis_transcoder.js",
        "/somewhere/else/basis_transcoder.wasm",
        // workspace 那条链自己的路由：viewer 不许借用（跨包耦合）。
        "/api/lyapunov/model-preview/asset/basis/basis_transcoder.wasm",
      ]) expect(source.rewrite(untouched), untouched).toBeUndefined()
      expect(source.created()).toEqual([])

      const wasm = source.rewrite(`${KTX2_TRANSCODER_ROUTE}basis_transcoder.wasm`)
      const js = source.rewrite(`${KTX2_TRANSCODER_ROUTE}basis_transcoder.js`)
      const draco = source.rewrite(`${DRACO_DECODER_ROUTE}draco_decoder.wasm`)
      expect(String(wasm).startsWith("blob:")).toBe(true)
      expect(String(js).startsWith("blob:")).toBe(true)
      expect(String(draco).startsWith("blob:")).toBe(true)
      expect(source.rewrite(`${KTX2_TRANSCODER_ROUTE}basis_transcoder.wasm`)).toBe(wasm!)
      expect(source.created().sort()).toEqual(["basis_transcoder.js", "basis_transcoder.wasm", "draco_decoder.wasm"])
    } finally {
      source.revoke()
    }
    expect(source.created()).toEqual([])
  })

  test("两条路由的表 key 不重叠（`created()` 按文件名回读不会有歧义）", () => {
    const names = INLINE_DECODER_ROUTES.flatMap(route => Object.keys(route.table))
    expect(new Set(names).size, `重名：${names.join(",")}`).toBe(names.length)
  })

  test("blob URL 里的字节就是内联字节（改写不是空壳 URL）", async () => {
    const source = createDecoderBlobSource()
    try {
      const url = source.rewrite(`${KTX2_TRANSCODER_ROUTE}basis_transcoder.wasm`)!
      const fetched = new Uint8Array(await (await fetch(url)).arrayBuffer())
      expect(fetched.byteLength).toBe(KTX2_INLINE_TRANSCODER["basis_transcoder.wasm"]!.bytes)
      expect(sha256(fetched)).toBe(KTX2_INLINE_TRANSCODER["basis_transcoder.wasm"]!.sha256)
    } finally {
      source.revoke()
    }
  })
})

describe("⑤ 真件：两份 .glb 真的解出来了（本单判据）", () => {
  test("EXT_meshopt_compression 真件 → 24 顶点 / 12 三角形", async () => {
    const loader = createGltfLoader({ renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    try {
      const gltf = await parseFixture(loader, "cube-meshopt.glb")
      expect(meshStats(gltf)).toEqual({ vertices: 24, triangles: 12, meshes: 1 })
      expect(gltf.parser.json.extensionsRequired).toContain("EXT_meshopt_compression")
    } finally {
      releaseGltfLoader(loader)
    }
  })

  test("KHR_texture_basisu 真件（ETC1S 与 UASTC 各一份）→ 真的 CompressedTexture + 4 级 mipmap", async () => {
    for (const name of ["cube-ktx2-etc1s.glb", "cube-ktx2-uastc.glb"]) {
      const loader = createGltfLoader({ renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
      try {
        const gltf = await parseFixture(loader, name)
        expect(gltf.parser.json.extensionsRequired, name).toContain("KHR_texture_basisu")
        expect(meshStats(gltf), name).toEqual({ vertices: 24, triangles: 12, meshes: 1 })
        const maps: THREE.Texture[] = []
        gltf.scene.traverse(object => {
          const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
          if (material?.map) maps.push(material.map)
        })
        expect(maps.length, `${name} 的 baseColorTexture`).toBe(1)
        const texture = maps[0] as THREE.CompressedTexture
        expect(texture.isCompressedTexture, `${name} 必须是转码后的压缩纹理`).toBe(true)
        // 源件是 8×8、4 级 mipmap 的真 KTX2（BasisLZ / UASTC 各一份，见夹具 PROVENANCE）。
        expect(texture.image.width, `${name} 宽度`).toBe(8)
        expect(texture.image.height, `${name} 高度`).toBe(8)
        expect(texture.mipmaps.length, `${name} mipmap 级数`).toBe(4)
      } finally {
        releaseGltfLoader(loader)
      }
    }
  })

  test("第二方向：对照件（不带任何压缩扩展）照旧能加载 —— 加了两个解码器不许动到它", async () => {
    // 对照件用**无贴图**的 `cube-plain.glb`（而不是带 PNG 的 `cube-png.glb`）：后者的贴图走 three 的
    // `ImageLoader`（要真 DOM），而别的测试文件会往 `globalThis` 装 `document` 替身 ⇒ 整包跑时那次贴图
    // 加载可能永远不 settle（本 lane 实测到过：同一条用例单跑 3 ms、整包跑 5 s 超时）。
    // 判据不该依赖"别的文件有没有装 DOM 替身"，所以这里只钉几何与"没有压缩扩展"这两件。
    const loader = createGltfLoader({ renderer: NO_COMPRESSED_TEXTURE_SUPPORT })
    try {
      const gltf = await parseFixture(loader, "cube-plain.glb")
      expect(meshStats(gltf)).toEqual({ vertices: 24, triangles: 12, meshes: 1 })
      expect(gltf.parser.json.extensionsUsed ?? []).toEqual([])
      expect(gltf.parser.json.extensionsRequired ?? []).toEqual([])
    } finally {
      releaseGltfLoader(loader)
    }
  })
})

describe("⑥ 真件负对照：不接解码器 ⇒ 同一份字节整件被拒（本单修的就是这个）", () => {
  test("裸 GLTFLoader 对 meshopt 真件逐字报 setMeshoptDecoder must be called", async () => {
    const bare = new GLTFLoader()
    expect(bare.meshoptDecoder).toBeNull()
    await expect(parseFixture(bare, "cube-meshopt.glb")).rejects.toThrow(
      "THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files")
  })

  test("裸 GLTFLoader 对 KTX2 真件逐字报 setKTX2Loader must be called", async () => {
    const bare = new GLTFLoader()
    expect(bare.ktx2Loader).toBeNull()
    await expect(parseFixture(bare, "cube-ktx2-etc1s.glb")).rejects.toThrow(
      "THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures")
  })

  test("只接了转码器、没探测渲染器能力 ⇒ 转码器自己抛初始化错误，而 GLTFLoader 会把它**吞掉**（贴图静默丢失）", async () => {
    // 这条钉住"detectSupport 不是可选项"，而且钉住它**失败得有多安静**：
    //  - 直接问转码器：`KTX2Loader.load()` 抛 `Missing initialization with '.detectSupport( renderer )'.`（KTX2Loader.js:343）；
    //  - 走 glTF：那个抛发生在贴图加载链里，被 `GLTFLoader.js:3351` 的 `.catch(() => null)` 吞掉 ⇒
    //    几何照建、**贴图没了**、控制台一行 `Couldn't load texture`。整件静默降级 —— 这正是"必须把
    //    renderer 带进工厂"的后果面（有人去掉 `createGltfLoader({ renderer })` 时在这里变红）。
    const loader = createGltfLoader()
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")) }
    try {
      await expect(loader.ktx2Loader!.loadAsync("anything.ktx2")).rejects.toThrow(
        "THREE.KTX2Loader: Missing initialization with `.detectSupport( renderer )`.")

      const gltf = await parseFixture(loader, "cube-ktx2-etc1s.glb")
      expect(meshStats(gltf), "几何照样建出来（这就是'静默'的意思）").toEqual({ vertices: 24, triangles: 12, meshes: 1 })
      const maps: THREE.Texture[] = []
      gltf.scene.traverse(object => {
        const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
        if (material?.map) maps.push(material.map)
      })
      expect(maps.length, "贴图应当是缺失的（不是解出来了）").toBe(0)
      expect(logged.some(line => line.includes("Couldn't load texture")), `实际日志：${logged.join(" | ")}`).toBe(true)
    } finally {
      console.error = original
      releaseGltfLoader(loader)
    }
  })
})

describe("⑦ 结构判据：index.ts 把渲染器带进工厂", () => {
  test("调用点写的是 createGltfLoader({ renderer: this.renderer })", async () => {
    const text = await readFile(VIEWER_INDEX, "utf8")
    const code = text.split("\n").filter(line => {
      const trimmed = line.trim()
      return !(trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//"))
    }).join("\n")
    expect(code).toContain("createGltfLoader({ renderer: this.renderer })")
    expect(code).not.toContain("new GLTFLoader(")
    // 反过来钉：这个 Viewer 里不许再出现第二个 glTF 装载器工厂 / 第二处 `new KTX2Loader(`。
    expect(code).not.toContain("new KTX2Loader(")
  })
})
