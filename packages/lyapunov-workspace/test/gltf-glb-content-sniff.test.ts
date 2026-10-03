/**
 * DEV-025 Round 2（N229）回归守卫：**`.gltf` 的内容嗅探**。
 *
 * 钉住的事实（缺陷原文见 `bugfixHistory/DEV025-SUPPORT-MATRIX-20260922.md` §3.4）：
 *  1. 真实文件 `…/source/DamagedHelmet.gltf`（3,773,916 B）**内容是二进制 GLB**（magic `glTF` v2）；
 *     改前按扩展名走文本 JSON 分支 ⇒ `SyntaxError: JSON parse error: Unexpected identifier "glTF"`；
 *  2. 改后在 `loadGltf` 开头按魔数嗅探，命中即交给 `parseGltf(toArrayBuffer(bytes),'')`（`GLTFLoader.parse`
 *     本就同时吃 GLB `ArrayBuffer` 与 JSON 字符串）⇒ 同一份字节能解析出真实几何；
 *  3. **负对照**：真 JSON 的 `.gltf` 魔数不命中，仍走原来的 JSON 分支（错误文案 `glTF JSON 解析失败：` 不变）。
 *
 * 为什么是"静态契约 + 真实字节"而不是直接调用 `loadGltf`：`model-preview.tsx` 在模块求值期就会把
 * `@lyapunov/viewer/client`（浏览器包）拖进来，在 bun 下无法导入（`Export named 'OBJLoader' not found`）。
 * 这与 `restart-tab-notice.test.ts` 的做法一致：**断言真实源码里的契约 + 用真实字节跑该分支真正执行的那两步**
 * （`isBinaryGltf` 的魔数判据 / `JSON.parse(decodeText)` / `GLTFLoader.parseAsync(ArrayBuffer)`）。
 */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const SOURCE = readFileSync(join(import.meta.dirname, '../src/model-preview.tsx'), 'utf8')
/** 真实缺陷样例（crawler 把 `.glb` 存成 `.gltf`）：不在仓库跟踪范围内，缺失时只跳过它那一组。 */
const REAL = join(
  import.meta.dirname,
  '../../../.runtime/ccds-environment-20260919T164516Z/39_asset_acquisition/acceptance-data/resources/network/'
  + '5a50be4c-7137-4889-beb6-bff8a3677d37/source/DamagedHelmet.gltf',
)

/** 与产品 `isBinaryGltf()` 同一判据（源码里的字面量在下面单独钉住，改一处两处都会红）。 */
const isBinaryGltf = (bytes: Uint8Array) => bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const toArrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

interface Geometry { meshes: number; vertices: number }
/** 该分支真正执行的那一步：`parseGltf` → `gltfLoaderWithDecoders().parseAsync(input,'')`。 */
async function parse(bytes: Uint8Array): Promise<Geometry> {
  const gltf = await new GLTFLoader().parseAsync(toArrayBuffer(bytes), '')
  let meshes = 0, vertices = 0
  gltf.scene.traverse(object => {
    const mesh = object as unknown as { isMesh?: boolean; geometry?: { getAttribute?: (name: string) => { count: number } | undefined } }
    if (!mesh.isMesh) return
    meshes += 1
    vertices += mesh.geometry?.getAttribute?.('position')?.count ?? 0
  })
  return { meshes, vertices }
}
/** 合成一个最小二进制 GLB（1 个三角面），避免测试依赖任何仓库外文件。 */
function syntheticGlb(): Uint8Array {
  let json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }],
  })
  while (json.length % 4) json += ' ' // JSON chunk 必须 4 字节对齐（GLB 规范用空格补齐）
  const jsonBytes = new TextEncoder().encode(json)
  const bin = new Uint8Array(36)
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out.set([0x67, 0x6c, 0x54, 0x46], 0)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.byteLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.byteLength, bin.byteLength, true)
  view.setUint32(24 + jsonBytes.byteLength, 0x004e4942, true)
  out.set(bin, 28 + jsonBytes.byteLength)
  return out
}

test('源码契约：loadGltf 在 JSON 分支之前按 glTF 魔数嗅探，且命中后走 parseGltf(ArrayBuffer)', () => {
  const sniff = SOURCE.indexOf('isBinaryGltf(bytes)')
  const jsonBranch = SOURCE.indexOf('json=JSON.parse(decodeText(bytes))')
  expect(sniff).toBeGreaterThan(-1)
  expect(jsonBranch).toBeGreaterThan(-1)
  // 嗅探必须在 JSON 解析之前（否则等于没修）
  expect(sniff).toBeLessThan(jsonBranch)
  // 判据字面量逐字节钉死（0x67/0x6c/0x54/0x46 = 'g','l','T','F'）
  expect(SOURCE).toContain('bytes[0]===0x67&&bytes[1]===0x6c&&bytes[2]===0x54&&bytes[3]===0x46')
  // 命中分支交给 GLTFLoader 的二进制入口
  expect(SOURCE.slice(sniff, jsonBranch)).toContain("await parseGltf(toArrayBuffer(bytes),'')")
  // 既有 JSON 分支与错误文案保持不变
  expect(SOURCE).toContain('throw Error(`glTF JSON 解析失败：${messageOf(reason)}`)')
})

test('真实样例：内容是 GLB 的 .gltf 魔数命中，旧分支会抛 SyntaxError，新分支解析成功', async () => {
  if (!existsSync(REAL)) {
    console.warn(`SKIP 真实样例不在盘上（不伪装通过）：${REAL}`)
    return
  }
  const bytes = new Uint8Array(readFileSync(REAL))
  expect(bytes.byteLength).toBe(3773916)
  // 内容确实是二进制 GLB
  expect(decodeText(bytes.subarray(0, 4))).toBe('glTF')
  expect(new DataView(toArrayBuffer(bytes)).getUint32(4, true)).toBe(2)
  // 魔数命中 ⇒ 新分支
  expect(isBinaryGltf(bytes)).toBe(true)
  // 负向：改前那条路（文本 JSON）在这份字节上确实抛 SyntaxError，且报文里点名 "glTF"
  let oldError: unknown
  try { JSON.parse(decodeText(bytes)) } catch (reason) { oldError = reason }
  expect(oldError).toBeInstanceOf(SyntaxError)
  expect(String((oldError as Error).message)).toContain('glTF')
  // 正向：新分支真正执行的那一步解析出真实几何
  const geometry = await parse(bytes)
  expect(geometry.meshes).toBeGreaterThan(0)
  expect(geometry.vertices).toBeGreaterThan(0)
  console.log(`REAL DamagedHelmet.gltf bytes=${bytes.byteLength} meshes=${geometry.meshes} vertices=${geometry.vertices}`)
})

test('合成夹具：`.gltf` 扩展名 + GLB 内容（1 三角面）也走嗅探分支并解析成功', async () => {
  const bytes = syntheticGlb()
  expect(decodeText(bytes.subarray(0, 4))).toBe('glTF')
  expect(bytes.byteLength % 4).toBe(0)
  expect(isBinaryGltf(bytes)).toBe(true)
  const geometry = await parse(bytes)
  expect(geometry.meshes).toBe(1)
  expect(geometry.vertices).toBe(3)
})

test('负对照：真 JSON 的 .gltf 魔数不命中 ⇒ 仍走原 JSON 分支', () => {
  const bytes = new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":[{"nodes":[]}],"scene":0}')
  expect(isBinaryGltf(bytes)).toBe(false)
  expect(() => JSON.parse(decodeText(bytes))).not.toThrow()
  // 首字节是 '{'（0x7b）而不是 'g'（0x67）——把判据钉在内容上，不看扩展名
  expect(bytes[0]).toBe(0x7b)
})
