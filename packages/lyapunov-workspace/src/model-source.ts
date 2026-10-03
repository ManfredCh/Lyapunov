/**
 * 可转换源格式的**纯分类表**（无 node/fs 依赖，浏览器与服务端共用同一份）。
 *
 * 为什么单独一个文件：`model-convert.ts` 会 import `node:crypto/node:fs`，因此浏览器侧的拖拽
 * 分派（`local-file-import.ts`）不能 import 它；但"哪些扩展名能走 Blender 转换"这件事必须只有
 * 一份真相。这里只放扩展名与判定，不碰任何宿主能力；`model-convert.ts` 从这里取，拖拽侧也取它。
 */
/** 能走 Blender 转换的源格式族：`blend` 与 `usd` 只区分导入方式。 */
export type ModelConvertSource = "blend" | "usd" | "obj" | "fbx"
const BLEND_EXTENSIONS = [".blend"] as const
/**
 * `.usdz` 与 `.usd*` 同一分支：它是 USD 的 zip 包（`PK\x03\x04`），Blender 的 `usd_import`
 * 直接吃二进制包，实测 round-trip 通。
 */
const USD_EXTENSIONS = [".usd", ".usda", ".usdc", ".usdz"] as const
/** 源路径 → 转换族；不是可转换格式就返回 undefined。 */
export function convertSourceOf(path: string): ModelConvertSource | undefined {
  const lower = path.toLowerCase()
  if (BLEND_EXTENSIONS.some(extension => lower.endsWith(extension))) return "blend"
  if (USD_EXTENSIONS.some(extension => lower.endsWith(extension))) return "usd"
  if(lower.endsWith('.obj'))return 'obj'
  if(lower.endsWith('.fbx'))return 'fbx'
  return undefined
}
/**
 * `SceneOperations`（`parseAsset`）真正能**登记**的源工程：拖拽导入是"先 scene_import 保留原件、
 * 再转换"，因此分派必须用它，而不能只看转换器能力。
 *
 * `.usdz` 只出现在 `convertSourceOf`（模型预览面直接把 zip 字节交给 Blender 的 usd_import，不经过
 * 资源登记）；它**不**进这张表——`parseAsset` 目前不接受 `.usdz`，先登记就会失败，把它列进拖拽
 * 支持面等于用一个必然失败的入口骗用户。要把它接进拖拽，必须先在 scene service 侧接通合法 USDZ
 * 源件登记并端到端验证，而不是在这里放宽字符串。
 */
export const REGISTRABLE_SOURCE_EXTENSIONS = [".blend", ".usd", ".usda", ".usdc", ".obj", ".fbx"] as const
/** 源路径 → 可登记且可转换的族；`.usdz` 等不可登记的格式返回 undefined。 */
export function registrableConvertSourceOf(path: string): ModelConvertSource | undefined {
  const lower = path.toLowerCase()
  if (!REGISTRABLE_SOURCE_EXTENSIONS.some(extension => lower.endsWith(extension))) return undefined
  return convertSourceOf(path)
}
/** 人类可读的源格式标签（失败原因里用；没有可转换扩展名时为 null）。 */
export function convertSourceLabel(path: string): string | null {
  const source = convertSourceOf(path)
  return source === "blend" ? "Blender 工程（.blend）" : source === "usd" ? "USD（.usd/.usda/.usdc/.usdz）" : source==='obj'?'OBJ/MTL/纹理':source==='fbx'?'FBX层级/骨骼/动画':null
}
