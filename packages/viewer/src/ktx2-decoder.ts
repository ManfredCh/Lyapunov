/**
 * KTX2（`KHR_texture_basisu`）转码器接线：**转码器字节内联在客户端产物里**，与 DRACO 同一形状。
 *
 * ## 为什么必须有这个模块（根因，逐环可核）
 *
 * three 的 `GLTFLoader` 遇到 `KHR_texture_basisu` 贴图时先看有没有 `ktx2Loader`
 * （`node_modules/three/examples/jsm/loaders/GLTFLoader.js:1554`）：
 *
 * ```
 * if ( ! loader ) {
 *   if ( json.extensionsRequired && json.extensionsRequired.indexOf( this.name ) >= 0 ) {
 *     throw new Error( 'THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures' );
 *   } else {
 *     // Assumes that the extension is optional and that a fallback texture is present
 *     return null;
 *   }
 * }
 * ```
 *
 * 那是**构造期抛出、且没人接**（`GLTFParser._invokeOne()` 不吞异常，见 `GLTFLoader.js:2904`）
 * ⇒ `loadAsync()` 整件被拒 ⇒ 该实体一个网格都建不出来，与 DRACO 修前的形状**完全同形**。
 * 实测（本单真件，见回执 §2）：不带解码器时两份真 `.glb` 逐字报
 * `THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures`。
 *
 * ## 第二条硬要求：`detectSupport(renderer)`
 *
 * 光 `setKTX2Loader()` 还不够。`KTX2Loader.load()/parse()` 在 `workerConfig === null` 时**直接抛**
 * `THREE.KTX2Loader: Missing initialization with '.detectSupport( renderer )'.`（`KTX2Loader.js:343/374`），
 * 而 `workerConfig` 只有 `detectSupport()`（读渲染器的压缩纹理扩展能力）才会被写上。
 *
 * ⚠️ 这条的**后果面比上一条隐蔽**（读源码 + 实测各确认一遍）：那个抛发生在贴图加载链里，会被
 * `GLTFLoader.js:3351` 的 `.catch( function () { return null; } )` **吞掉** —— 几何照建、
 * **贴图静默丢失**、控制台只留一行 `THREE.GLTFLoader: Couldn't load texture blob:…`，
 * 而整个 `loadAsync()` 照样 resolve。也就是说"装了 KTX2Loader 但没探测能力"给用户的是
 * **一个没有贴图的模型**，不是一条明确的失败。所以渲染器必须一路带到这里
 * （`index.ts` 传的是本 Viewer 自己的 `renderer`；用例把这两种失败面分别钉住）。
 *
 * ## 转码器从哪来：**内联**，不是运行时取
 *
 * `KTX2Loader.init()` 用 `FileLoader` 去 `transcoderPath + 文件名` 取 `basis_transcoder.js`（文本，57,529 B）
 * 与 `basis_transcoder.wasm`（二进制，527,333 B），再把两者拼进一个 Blob 里起 Worker。**它必须来自产品自己** ——
 * 干净安装的客户机上不能临时出网取。理由与 DRACO 那份逐字相同（见 `draco-decoder.ts` 的模块头）：
 * 另一条"宿主路由"路线会把 viewer 绑到别人包的路径命名与挂载状态上（workspace 的 model-preview 就是这么做的，
 * 它自带了一份 `packages/lyapunov-workspace/assets/decoder/` 副本 + `/api/lyapunov/model-preview/asset/basis/` 路由）。
 * 内联让转码器跟着**已经内联了 three 的那个客户端产物**（`packages/viewer/dist/client.js`）一起走：
 * 零运行时出网、零安装形态依赖、零跨包耦合。代价是产物多约 780 KB（584,862 B 字节的 base64）。
 *
 * 数据在 `ktx2-transcoder-data.ts`（生成文件，带源文件长度与 sha256；`gltf-ktx2-meshopt-decoders.test.ts`
 * 对着盘上真实的 three 文件逐字节核对，所以这份副本不会与依赖树悄悄分叉）。
 *
 * `setTranscoderPath(KTX2_TRANSCODER_ROUTE)` 仍然设着，理由与 DRACO 同：万一有**没内联**的名字被请求，
 * 报错里给出一条绝对、可辨认的 URL，而不是相对当前页面的裸文件名。Viewer **没有**注册这条路由，
 * 正常情况下一次网络请求都不会发出去（由用例与真机读数各钉一遍）。
 */
import type { LoadingManager, WebGLRenderer } from "three"
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js"

import { inlineBytesByName } from "./decoder-inline-bytes.ts"
import type { InlineDecoderRoute } from "./decoder-inline-bytes.ts"
import { KTX2_INLINE_TRANSCODER } from "./ktx2-transcoder-data.ts"

/**
 * 转码器的名义基址。**没有任何宿主注册这条路由**：转码器字节全部内联（见模块头）。
 * 它的唯一作用是把"没内联的转码器文件名"变成一个绝对、可辨认的 URL 出现在报错里。
 */
export const KTX2_TRANSCODER_ROUTE = "/api/lyapunov/viewer/asset/basis/"

/**
 * 内联表里的文件名（= `KTX2Loader.init()` 会去取的那两个名字）。
 * **顺序固定**：这是"该被改写到 blob URL 的请求"的完整集合，用例按它逐名核对。
 */
export const KTX2_INLINE_FILE_NAMES: readonly string[] = ["basis_transcoder.js", "basis_transcoder.wasm"]

/** 这条路由交给共用改写器的形状（`decoder-inline-bytes.ts`）。 */
export const KTX2_INLINE_ROUTE: InlineDecoderRoute = { route: KTX2_TRANSCODER_ROUTE, table: KTX2_INLINE_TRANSCODER }

/** 文件名 → 内联字节；表里没有就 `undefined`（**不猜、不回落网络**）。入参允许带 `transcoderPath` 前缀。 */
export function ktx2InlineBytes(file: string): Uint8Array | undefined {
  const name = file.startsWith(KTX2_TRANSCODER_ROUTE) ? file.slice(KTX2_TRANSCODER_ROUTE.length) : file
  return inlineBytesByName([KTX2_INLINE_ROUTE], name)
}

/**
 * `KTX2Loader.detectSupport()` **真正读到的形状**（`KTX2Loader.js:223-258` 只碰这三处：
 * `isWebGPURenderer`、`extensions.has()`、`extensions.get().getSupportedProfiles()`）。
 *
 * 按"读到的形状"声明而不是直接要 `THREE.WebGLRenderer`，是为了让用例能喂一个**能力替身**
 * （本机跑 bun 测试时没有 WebGL 上下文），从而在不假装有 GPU 的前提下把接线钉住。
 * 真的 `THREE.WebGLRenderer` 结构上满足这个接口 —— `index.ts` 传的就是它。
 */
export interface Ktx2SupportProbe {
  isWebGPURenderer?: boolean
  extensions: {
    has(name: string): boolean
    get(name: string): { getSupportedProfiles(): string[] }
  }
}

/**
 * 把渲染器能力探测接到装载器上。**不探测就等于没接**（模块头第二条硬要求）：
 * `workerConfig` 一直是 `null` 时，`KTX2Loader.load()` 会抛出它自己的那句初始化错误 ——
 * 而那句会被 `GLTFLoader` 吞掉（贴图静默丢失），所以这里**宁可当场炸**。
 *
 * 入参不像渲染器（没有 `extensions.has/get`）时抛一条**指名道姓**的错误，而不是让
 * `undefined.has` 的 TypeError 冒到别处 —— 后者在真机上不可能出现，只有"用残缺替身顶替渲染器"
 * 的测试夹具会踩到，报错就该直接说清这件事。
 */
export function detectKtx2Support(loader: KTX2Loader, probe: Ktx2SupportProbe): KTX2Loader {
  if (!probe || typeof probe.extensions?.has !== "function" || typeof probe.extensions?.get !== "function") {
    throw new Error("VIEWER_KTX2_SUPPORT_PROBE_INVALID: detectSupport 需要一个带 `extensions.has/get` 的渲染器"
      + "（three 的 KTX2Loader 只读这两处，KTX2Loader.js:223-258）；拿到的东西不像渲染器。"
      + "缺能力探测 ⇒ KTX2 贴图会静默丢失，所以这里拒绝跳过。")
  }
  // `@types/three` 把入参声明成全量的 `WebGLRenderer | WebGPURenderer`，与这里的结构类型不能直接互认；
  // 这个窄化是**唯一**的转换点，且只交出上面按源码核对过的三处能力（不是 `any`）。
  return loader.detectSupport(probe as unknown as WebGLRenderer)
}

/**
 * 建一个**带内联 KTX2 转码器**的 `KTX2Loader`。
 *
 * 与 DRACO 同：转码器字节只在真遇到 KTX2 贴图时才会被 `init()` 取用（那时才建 blob URL 与 Worker）；
 * 不带 KTX2 的 glTF 走这条路时，一个 blob 都不建、一个 Worker 都不起、一次网络请求都不发。
 */
export function createKtx2Loader(manager: LoadingManager, probe?: Ktx2SupportProbe): KTX2Loader {
  const loader = new KTX2Loader(manager).setTranscoderPath(KTX2_TRANSCODER_ROUTE)
  return probe ? detectKtx2Support(loader, probe) : loader
}
