/**
 * 根因判据：**viewer 的 glTF 读取路径必须带 DRACO 解码器，而且解码器字节来自产品自己（内联）**。
 *
 * 这一族缺陷的现场（`bugfixHistory/DEV003-198-FOUR-SESSIONS-20260926.md`）：
 * 真件 `天安门广场_网页.glb`（68,730,772 B，`extensionsRequired=["KHR_draco_mesh_compression"]`）
 * 归属成立但**一个网格都没建出来**，标签页逐字报
 * `Error: THREE.GLTFLoader: No DRACOLoader instance provided.`。
 * 成因是 `GLTFLoader.js:1994` 在**构造 Draco 扩展时抛错** —— 整个 `loadAsync()` 被拒。
 *
 * 本文件钉住的四件事（每件都有可读的失败信息）：
 *  ① 装载器真的带上了 `DRACOLoader`，且装载器的解码器基址与改写器的判据**是同一个**（不一致 ⇒ 改写永不命中）；
 *  ② 内联的那 344,510 B 与盘上 `node_modules/three/examples/jsm/libs/draco/` 的**真实解码器逐字节相同**
 *     （长度 + sha256 + wasm 魔数），不是占位、不是空壳；
 *  ③ 改写器**只**认解码器请求：glTF 自己的 bin/贴图 URL、`res:` 媒体路由 URL 一律原样放行 ⇒
 *     不带 Draco 的 glTF 走这条路时**一个 blob 都不建、一次解码器请求都不发**（第二方向的判据）；
 *  ④ `index.ts` 里不再有任何一处 `new GLTFLoader(`（**结构判据**：读了源码文本，不是行为判据 ——
 *     Viewer 要 WebGL 才能构造，本机没有 DOM/WebGL，行为面由真机读数覆盖，见回执）。
 *
 * 运行：`bun test packages/viewer/test/gltf-draco-decoder.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"

import {
  DRACO_DECODER_ROUTE, DRACO_INLINE_FILE_NAMES, createDecoderBlobSource, createGltfLoader, dracoInlineBytes, releaseGltfLoader,
} from "../src/draco-decoder.ts"
import { DRACO_INLINE_DECODER } from "../src/draco-decoder-data.ts"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const THREE_DRACO_DIR = join(ROOT, "node_modules", "three", "examples", "jsm", "libs", "draco")
const THREE_DRACO_LOADER = join(ROOT, "node_modules", "three", "examples", "jsm", "loaders", "DRACOLoader.js")
const VIEWER_INDEX = join(ROOT, "packages", "viewer", "src", "index.ts")

/**
 * `DRACOLoader.decoderPath` 是**真行为**（`_loadLibrary` 用它拼 URL），但 `@types/three@0.180` 没有声明它。
 * 断言它必须走这个窄化读取，别把测试写成 `as any`（那样连字段名写错都发现不了）。
 */
function decoderPathOf(loader: GLTFLoader): string | undefined {
  const draco = loader.dracoLoader
  return draco ? (draco as unknown as { decoderPath?: string }).decoderPath : undefined
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

describe("① 装载器带解码器", () => {
  test("createGltfLoader() 的 dracoLoader 是真的 DRACOLoader，且基址与改写判据同一份", () => {
    const loader = createGltfLoader()
    try {
      expect(loader.dracoLoader).toBeInstanceOf(DRACOLoader)
      // 装载器与改写器必须用**同一个**基址：不一致时改写器一个请求都匹配不上，
      // 表现就和"没接解码器"一样（Draco 几何仍然建不出来），而且没有任何报错提示这件事。
      expect(decoderPathOf(loader)).toBe(DRACO_DECODER_ROUTE)
    } finally {
      releaseGltfLoader(loader)
    }
  })

  test("改前的形状确实会拒载：没有 dracoLoader 的新装载器就是那条 throw 的入口", () => {
    // 这条不是"测试实现细节"，而是把**被修的那个缺陷**钉成事实：
    // `GLTFLoader` 只在 `dracoLoader` 为假值时抛 `No DRACOLoader instance provided.`。
    expect(new GLTFLoader().dracoLoader).toBeNull()
  })

  test("releaseGltfLoader 只释放自己建的装载器（别人的是空操作，不误伤）", () => {
    const foreign = new GLTFLoader()
    expect(() => releaseGltfLoader(foreign)).not.toThrow()
    expect(foreign.dracoLoader).toBeNull()
  })
})

describe("② 内联字节 = 盘上 three 的真实解码器", () => {
  test("长度、sha256、wasm 魔数与盘上文件逐项相同", async () => {
    for (const name of DRACO_INLINE_FILE_NAMES) {
      const entry = DRACO_INLINE_DECODER[name]
      expect(entry, `内联表里没有 ${name}`).toBeDefined()
      const onDisk = await readFile(join(THREE_DRACO_DIR, name))
      const inlined = dracoInlineBytes(name)!
      expect(inlined.byteLength, `${name} 长度`).toBe(onDisk.byteLength)
      expect(inlined.byteLength, `${name} 与表中登记的长度`).toBe(entry!.bytes)
      expect(sha256(inlined), `${name} sha256`).toBe(sha256(onDisk))
      expect(sha256(inlined), `${name} 与表中登记的 sha256`).toBe(entry!.sha256)
    }
    // wasm 魔数 `\0asm`：证明内联的是真的 WebAssembly 模块，不是被 base64 过的占位文本。
    const wasm = dracoInlineBytes("draco_decoder.wasm")!
    expect([...wasm.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d])
    // wrapper 是真 JS：`DRACOLoader` 会把它整段拼进 worker 源码里，必须能找到它导出的那个工厂名。
    expect(new TextDecoder().decode(dracoInlineBytes("draco_wasm_wrapper.js")!)).toContain("DracoDecoderModule")
  })

  test("内联表覆盖 DRACOLoader 的 wasm 路径会取的两个文件名，且没多没少", async () => {
    const source = await readFile(THREE_DRACO_LOADER, "utf8")
    // 直接读 three 的实现，把"它会请求哪两个名字"当成**上游事实**核对，不靠本文件里的印象。
    const requested = [...source.matchAll(/_loadLibrary\(\s*'([^']+)'/g)].map(match => match[1]!)
    expect(requested).toEqual(["draco_decoder.js", "draco_wasm_wrapper.js", "draco_decoder.wasm"])
    expect([...DRACO_INLINE_FILE_NAMES].sort()).toEqual(["draco_decoder.wasm", "draco_wasm_wrapper.js"])
    expect(Object.keys(DRACO_INLINE_DECODER).sort()).toEqual([...DRACO_INLINE_FILE_NAMES].sort())
    // **未覆盖面登记成判据**：JS 回退解码器（没有 WebAssembly 的浏览器才走）没有内联。
    // 这一行红了，说明 three 换了文件集合 —— 那时要么补内联，要么回执里的边界要改写。
    expect(requested).toContain("draco_decoder.js")
    expect(DRACO_INLINE_DECODER["draco_decoder.js"]).toBeUndefined()
  })
})

describe("③ 改写器只动解码器请求（第二方向：不带 Draco 的件一个 blob 都不建）", () => {
  test("解码器请求 → blob URL；其余一律 undefined（调用方原样放行）", () => {
    const source = createDecoderBlobSource()
    try {
      expect(source.created()).toEqual([])
      // glTF 自己的资源：产品媒体路由、res: 标记、绝对 http、相对文件名 —— 一个都不许被动。
      for (const untouched of [
        "/api/lyapunov/resource?sceneId=dev003-c-tiananmen&uri=res%3Ae0200a9d",
        "res:e0200a9d-99ae-4215-8a0f-6c78d3e40e77",
        "https://example.test/models/scene.glb",
        "draco_decoder.wasm",
        "/somewhere/else/draco_wasm_wrapper.js",
      ]) expect(source.rewrite(untouched), untouched).toBeUndefined()
      // 走完上面这些，解码器缓存仍是空的 ⇒ 不带 Draco 的加载**不会**建 blob、不会发解码器请求。
      expect(source.created()).toEqual([])

      const wasm = source.rewrite(`${DRACO_DECODER_ROUTE}draco_decoder.wasm`)
      const wrapper = source.rewrite(`${DRACO_DECODER_ROUTE}draco_wasm_wrapper.js`)
      expect(String(wasm).startsWith("blob:")).toBe(true)
      expect(String(wrapper).startsWith("blob:")).toBe(true)
      // 同名再问一次拿到同一个 URL（blob 不重复建）。
      expect(source.rewrite(`${DRACO_DECODER_ROUTE}draco_decoder.wasm`)).toBe(wasm!)
      expect(source.created().sort()).toEqual(["draco_decoder.wasm", "draco_wasm_wrapper.js"])
      // JS 回退解码器没内联 ⇒ 不假装有，交回 undefined（= 真的去取那个不存在的 URL，如实失败）。
      expect(source.rewrite(`${DRACO_DECODER_ROUTE}draco_decoder.js`)).toBeUndefined()
    } finally {
      source.revoke()
    }
    // revoke 之后不再留着 URL（读数由 `created()` 的语义承担：撤过就清空）。
    expect(source.created()).toEqual([])
  })

  test("blob URL 里的字节就是内联字节（改写不是空壳 URL）", async () => {
    const source = createDecoderBlobSource()
    try {
      const url = source.rewrite(`${DRACO_DECODER_ROUTE}draco_decoder.wasm`)!
      const fetched = new Uint8Array(await (await fetch(url)).arrayBuffer())
      expect(fetched.byteLength).toBe(DRACO_INLINE_DECODER["draco_decoder.wasm"]!.bytes)
      expect(sha256(fetched)).toBe(DRACO_INLINE_DECODER["draco_decoder.wasm"]!.sha256)
    } finally {
      source.revoke()
    }
  })
})

describe("④ 结构判据：viewer 里只有一处造 glTF 装载器", () => {
  test("index.ts 的**代码**里没有裸构造 GLTFLoader，而是走 createGltfLoader()", async () => {
    const text = await readFile(VIEWER_INDEX, "utf8")
    // 只看代码行：注释里提到 `new GLTFLoader()` 是在解释"为什么不再那么写"，不是第二处构造点。
    const code = text.split("\n").filter(line => {
      const trimmed = line.trim()
      return !(trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//"))
    }).join("\n")
    expect(code).not.toContain("new GLTFLoader(")
    // 调用形状随 KTX2 接线变成"带选项"（该工厂现在要把渲染器带进去做 KTX2 能力探测）：
    // 断言仍然要求"必须走工厂"，且**不接受**零参形式（那不是本 Viewer 的接线）。
    // 选项内容（`renderer: this.renderer`）由 `gltf-ktx2-meshopt-decoders.test.ts` 单独钉住。
    expect(code).toContain("createGltfLoader({")
  })
})
