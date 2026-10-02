/**
 * Viewer 唯一的 **glTF 装载器工厂**：带 DRACO 解码器 + KTX2（`KHR_texture_basisu`）转码器 +
 * meshopt（`EXT_meshopt_compression`）解码器，**解码器字节全部来自产品自己（内联或模块自带）**。
 *
 * > 文件名是历史：本模块最早只接 DRACO（那一单的判据与读数见 `GLB-DRACO-RENDER-20260926.md`）。
 * > 现在它是**唯一**一处造 glTF 装载器的地方（`index.ts` 里一处裸构造都没有，由用例钉住），
 * > 三种压缩由它统一接上 —— 加新解码器要改的就是这里一处。
 *
 * ## 为什么必须有这个模块（根因，逐环可核）
 *
 * three 的 `GLTFLoader` 遇到 `KHR_draco_mesh_compression` 时，**先看有没有 `dracoLoader`**：
 *
 * ```
 * node_modules/three/examples/jsm/loaders/GLTFLoader.js:1994
 *   throw new Error( 'THREE.GLTFLoader: No DRACOLoader instance provided.' );
 * ```
 *
 * 那是**构造期抛错**（不是 warn、不是跳过几何）⇒ 整个 `loadAsync()` 被拒 ⇒ 实体一个网格都建不出来。
 * Viewer 过去在 `index.ts` 里直接 `new GLTFLoader().loadAsync(url)`，**从来没接过解码器** ——
 * 不是"接了没生效"：全仓 `packages/<包>/src` 里做过 `setDRACOLoader` 的只有 `lyapunov-workspace`
 * 的模型预览（另一条链），viewer 自己的加载路径一处都没有。实测读数见
 * `bugfixHistory/GLB-DRACO-RENDER-20260926.md`：真件 `天安门广场_网页.glb`（68,730,772 B，
 * `extensionsRequired=["KHR_draco_mesh_compression"]`，67/67 primitive 全走 Draco）
 * 在真产品页面上逐字报 `Error: THREE.GLTFLoader: No DRACOLoader instance provided.`、画面是空网格。
 *
 * ## 解码器从哪来：**内联**，不是运行时取
 *
 * `DRACOLoader` 取解码器只有一条路：`_loadLibrary()` 用 `FileLoader` 去 `decoderPath + 文件名` 读
 * `draco_wasm_wrapper.js`（文本）与 `draco_decoder.wasm`（二进制）。**它必须来自产品自己** ——
 * 干净安装的客户机上不能临时出网取。两条"宿主路由"路线都被否掉：
 *
 *  1. **读本机 `node_modules/three/...` 起静态路由**：安装形态可能被裁剪（只带产品包、依赖被裁）。
 *     `lyapunov-workspace/src/model-convert.ts` 的 `decoderAssetDirectory()` 注释里就记着这个坑 ——
 *     它因此**另存了一份产品自带副本**。viewer 若走同一条路，就是在同一个坑上再站一次。
 *  2. **复用 workspace 那条既有路由**（`/api/lyapunov/model-preview/asset/draco/`）：那是把 viewer
 *     绑到另一个包的路径命名与挂载状态上 —— 那条链一改名或那个插件没挂，解码器静默 404，
 *     又变成"干净安装上就是坏的"。
 *
 * 内联把解码器放进**已经内联了 three 的那个客户端产物**（`packages/viewer/dist/client.js`）：
 * 零运行时出网、零安装形态依赖、零跨包耦合。代价是产物多约 460 KB（base64 后的 344,510 B 字节）。
 *
 * 数据在 `draco-decoder-data.ts`（生成文件，带源文件长度与 sha256；`gltf-draco-decoder.test.ts`
 * 对着盘上真实的 three 文件逐字节核对，所以这份副本不会与依赖树悄悄分叉）。
 *
 * ## 怎么把内联字节喂给 DRACOLoader
 *
 * `DRACOLoader._loadLibrary()` 走的是 `FileLoader`，而 `FileLoader.load()` 第一步就是
 * `url = this.manager.resolveURL(url)`（`three.core.js:43987`）。所以挂一个**私有 LoadingManager**
 * 的 `setURLModifier`，把解码器那两个 URL 改写成由内联字节建出来的 `blob:` URL 即可 ——
 * 不改 three 的私有实现、不假装网络可用。改写**只认这张表的键**（精确到 `decoderPath + 文件名`），
 * glTF 自己的 bin/贴图 URL 原样放行。
 *
 * `setDecoderPath(DRACO_DECODER_ROUTE)` 仍然设着，理由只有一个：万一有**没内联**的解码器文件名被请求
 * （见下面的未覆盖面），报错里给出一条绝对、可辨认的 URL，而不是一个相对当前页面的裸文件名。
 * Viewer **没有**注册这条路由，正常情况下一次网络请求都不会发出去（由用例钉住）。
 *
 * **未覆盖面（如实登记）**：three 在 `typeof WebAssembly !== 'object'` 时会退到 JS 解码器
 * （`draco_decoder.js`，719,410 B）。那份**没有内联**（体积是 wasm 的两倍多，且该分支要求浏览器
 * 没有 WebAssembly —— 本产品要跑的 WebGL2 环境不存在这种浏览器）。真走到那条分支时，取
 * `draco_decoder.js` 会 404，报错是"解码器不可用"，不会静默渲染出错误的几何。
 *
 * ## 另外两种压缩（同一形状，各自的根因见各自模块）
 *
 *  - `KHR_texture_basisu` → `ktx2-decoder.ts`：`GLTFLoader.js:1554` 在没有 `ktx2Loader` 时**throw**；
 *    并且 KTX2Loader 还要求先 `detectSupport(renderer)`（`KTX2Loader.js:343/374` 的 throw），
 *    所以本工厂的入参要把渲染器带进来。
 *  - `EXT_meshopt_compression` → `GLTFLoader.js:1697` 在没有 `meshoptDecoder` 时**throw**；
 *    解码器用 three 自带的 `meshopt_decoder.module.js`，**wasm 已经 base64 内嵌在那个模块里**
 *    （它不 fetch、不 importScripts），所以这一条**不需要额外的内联数据文件**，接线本身就是全部工作。
 */
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js"
import { DRACO_INLINE_DECODER } from "./draco-decoder-data.ts"
import type { DecoderBlobSource } from "./decoder-inline-bytes.ts"
import { createInlineBlobSource, inlineBytesByName } from "./decoder-inline-bytes.ts"
import type { Ktx2SupportProbe } from "./ktx2-decoder.ts"
import { KTX2_INLINE_ROUTE, createKtx2Loader } from "./ktx2-decoder.ts"

export type { DecoderBlobSource }

/**
 * 解码器的名义基址。**没有任何宿主注册这条路由**：解码器字节全部内联（见模块头）。
 * 它的唯一作用是把"没内联的解码器文件名"变成一个绝对、可辨认的 URL 出现在报错里。
 */
export const DRACO_DECODER_ROUTE = "/api/lyapunov/viewer/asset/draco/"

/**
 * 内联表里的文件名（= `DRACOLoader` 会去取的那两个名字）。
 * **顺序固定**：这是"该被改写到 blob URL 的请求"的完整集合，用例按它逐名核对。
 */
export const DRACO_INLINE_FILE_NAMES: readonly string[] = ["draco_wasm_wrapper.js", "draco_decoder.wasm"]

/** DRACO 这条路由交给共用改写器的形状（`decoder-inline-bytes.ts`）。 */
export const DRACO_INLINE_ROUTE = { route: DRACO_DECODER_ROUTE, table: DRACO_INLINE_DECODER } as const

/**
 * 本 Viewer 内联的**全部**解码器路由。改写器只认这些表里登记过的键 —— 加解码器就在这张清单上加一条，
 * 别去放宽 `rewrite()` 的匹配（见 `decoder-inline-bytes.ts` 的模块头）。
 */
export const INLINE_DECODER_ROUTES = [DRACO_INLINE_ROUTE, KTX2_INLINE_ROUTE] as const

/**
 * 文件名 → 内联字节。表里没有就 `undefined`（**不猜、不回落网络**）。
 * 入参允许带 `decoderPath` 前缀（调用方手里常常是整个 URL）。
 */
export function dracoInlineBytes(file: string): Uint8Array | undefined {
  const name = file.startsWith(DRACO_DECODER_ROUTE) ? file.slice(DRACO_DECODER_ROUTE.length) : file
  return inlineBytesByName([DRACO_INLINE_ROUTE], name)
}

/**
 * 解码器请求的 blob URL 源（DRACO 与 KTX2 共用同一份改写器）。
 *
 * `rewrite` 只认 `${路由}${内联文件名}`，其余一律 `undefined`（= 调用方原样放行）；
 * blob URL 按需建、按名缓存 ⇒ **不带压缩的 glTF 一次都不建 blob、一次网络请求也不发**
 * （由用例与真机读数各钉一遍）。`revoke` 撤掉建过的那些（没建过就是空操作）。
 */
export function createDecoderBlobSource(): DecoderBlobSource {
  return createInlineBlobSource(INLINE_DECODER_ROUTES)
}

/** 每个装载器（= 每个 Viewer）的释放动作：撤 blob URL + 关解码器/转码器的 worker。 */
const releasers = new WeakMap<GLTFLoader, () => void>()

/** `createGltfLoader()` 的入参。 */
export interface GltfLoaderOptions {
  /**
   * 渲染器能力探针（`index.ts` 传的是本 Viewer 自己的 `renderer`）。
   *
   * **KTX2 必须有它**：`KTX2Loader` 的 transcode 目标格式由渲染器的压缩纹理扩展能力决定，
   * 没探测过就 `workerConfig === null` ⇒ `KTX2Loader.load()` 抛 `Missing initialization with
   * '.detectSupport( renderer )'`（`KTX2Loader.js:343`），而这个抛会被 `GLTFLoader.js:3351`
   * 的 catch 吞掉 ⇒ **贴图静默丢失**（几何照建、`loadAsync()` 照样成功）。
   * 不传 = 只装了转码器但没接上能力探测；调用方应当总是传（`index.ts` 那处由结构判据钉住）。
   */
  renderer?: Ktx2SupportProbe
}

/**
 * 建一个**带三种压缩解码器**的 `GLTFLoader`：DRACO（内联 wasm）、KTX2（内联转码器）、
 * meshopt（three 自带模块，wasm 已内嵌，无需额外数据文件）。
 *
 * 为什么是"工厂 + 由 Viewer 持有单例"而不是每次读取都新建：`DRACOLoader`/`KTX2Loader` 一初始化就起
 * worker 池（各默认 4 个），一个 URL 一个装载器会在多 GLB 场景里起一堆 worker；而且
 * `_initDecoder()`/`init()` 一旦完成就复用（内联字节也因此只 base64 解码一次）。
 *
 * 三个解码器**都懒初始化**：只有真遇到对应扩展时才会跑各自的 `init`，才建 blob URL 与 worker。
 * 所以不带这些扩展的 glTF 走这条路时，行为与"没有解码器"时逐字相同（网络、worker、内存都不变）。
 */
export function createGltfLoader(options: GltfLoaderOptions = {}): GLTFLoader {
  const manager = new THREE.LoadingManager()
  const source = createDecoderBlobSource()
  manager.setURLModifier(url => source.rewrite(url) ?? url)
  const draco = new DRACOLoader(manager).setDecoderPath(DRACO_DECODER_ROUTE)
  const ktx2 = createKtx2Loader(manager, options.renderer)
  const loader = new GLTFLoader(manager)
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder)
  releasers.set(loader, () => { draco.dispose(); ktx2.dispose(); source.revoke() })
  return loader
}

/**
 * 释放一个由 `createGltfLoader()` 建的装载器：关掉解码器/转码器的 worker、撤掉内联字节建出的 blob URL。
 * **没有解码器需求时是空操作**（没建过 worker，也没建过 blob）。传给别的装载器（例如外部自己
 * `new` 的）同样是空操作 —— 本模块不去释放不是自己建的东西。
 */
export function releaseGltfLoader(loader: GLTFLoader): void {
  const release = releasers.get(loader)
  if (!release) return
  releasers.delete(loader)
  release()
}
