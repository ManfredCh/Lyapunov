/**
 * Viewer 的浏览器入口（DSH 客户端模块）。
 *
 * 为什么单独开这个入口：three + @sparkjsdev/spark 体积大（约 6 MB），而 **shell（工作台/录制面板）
 * 与 workspace（模型预览）都要用同一个 viewer**。过去两边各自用相对路径 import，于是 three 被
 * 分别内联进两份客户端 bundle（workspace 的 client.js 因此涨到 7.2 MB）。
 * 现在 viewer 作为独立客户端模块下发，消费方按包名 external 引用 `@lyapunov/viewer/client`，
 * 全站只有一份 three+spark，也顺带让预览的解码器/静态资源有统一宿主。
 *
 * 这里只做再导出：viewer 的公开面仍是 `packages/viewer/src/index.ts` 那一套，行为零变化。
 */
export { createViewer, SceneViewer, applyWorldPoses, WebGLUnavailableError } from "./index.ts"
export type { ViewerOptions, ViewerDisplaySettings, ViewerViewState, ViewerObserverState, ViewerCameraAuthoringSample, ViewerCameraEdit, CollisionTopologyStatus } from "./index.ts"
export type { ViewerAnnotation, ViewerAnnotationAnchor } from "./annotations.ts"
export { projectSceneCameraRigs, currentCameraFrame } from "./scene-camera-rigs.ts"

/**
 * 客户端插件的空 apply。
 *
 * 为什么需要：DSH 的客户端模块加载器把每个登记模块当**插件**装载，要求导出对象带 `apply`
 * （否则页面直接报 "invalid plugin, expect function or object with an apply method"）。
 * viewer 不注册任何界面插槽，这里只提供空的挂载点，公开面仍是上面的再导出。
 */
export function apply(): void {}

/**
 * three 与各格式 loader 的转出。
 *
 * 为什么由这里转出：模型预览要用 three 的 loader，而 `three/addons/**` 内部 `import 'three'`——
 * 若预览自己按路径导入，打包器会把 **three 整份**再内联一遍（workspace 客户端 bundle 因此多出约 1.2 MB，
 * 控制台还会报 "Multiple instances of Three.js being imported"）。改为从本模块转出后，
 * 全站只有 viewer 这一份 three；预览 bundle 不再含 three 内核。
 */
export * as THREE from "three"
export {GLTFLoader} from "three/addons/loaders/GLTFLoader.js"
export {DRACOLoader} from "three/addons/loaders/DRACOLoader.js"
export {KTX2Loader} from "three/addons/loaders/KTX2Loader.js"
export {MeshoptDecoder} from "three/addons/libs/meshopt_decoder.module.js"
export {STLLoader} from "three/addons/loaders/STLLoader.js"
export {OBJLoader} from "three/addons/loaders/OBJLoader.js"
export {MTLLoader} from "three/addons/loaders/MTLLoader.js"
export {FBXLoader} from "three/addons/loaders/FBXLoader.js"
export {ColladaLoader} from "three/addons/loaders/ColladaLoader.js"
export {ThreeMFLoader} from "three/addons/loaders/3MFLoader.js"
export {USDLoader} from "three/addons/loaders/USDLoader.js"
export {VTKLoader} from "three/addons/loaders/VTKLoader.js"
export {PLYLoader} from "three/addons/loaders/PLYLoader.js"
