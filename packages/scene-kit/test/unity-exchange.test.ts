/**
 * ENV-26/27 Unity ↔ Scene 交换的真实行为测试。
 *
 * 真的部分：SceneOperations（真 SceneStore + 真 ResourceLibrary + 真文件/CAS + 真 revision）、
 * 真 GLB 字节解析、真 LPMESH 解码（本文件按线格式独立实现解码，不复用编码器）、真 fs。
 * 假的部分只有 Unity 编辑器本身：`fakeUnity` 是**协议层**替身，它按 C# 工具的合同读写
 * request/result 文件并产出真字节，不假装几何/坐标——那部分由 44 号任务里的真 Unity 端到端
 * 验收覆盖（原生 MCP 触发菜单项、真编辑器里建对象/存场景/重开），见该任务 REPORT.md。
 *
 * 空间换算的判据不用"重抄一遍公式"：位置用矩阵 M 直接映射、旋转用**矩阵共轭** R' = M·R·M⁻¹
 * 独立算出来对账，因此这些断言真的能抓到四元数公式写错（历史上就写错过一次）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Matrix4, Quaternion, Vector3 } from "three"
import type { Entity } from "../../lyapunov-contracts/src/types.ts"
import { localPath } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"
import type { UnityEnvironmentRecord, UnityExchangePort, UnityLightRecord, UnityMaterialRecord, UnityMeshRecord, UnityNode, UnityOriginMetadata, UnitySceneDocument, UnitySyncPlan, UnityTerrainRecord } from "../src/unity-exchange.ts"
import {
  ENVIRONMENT_KIND, LIGHT_ENERGY_SCALE, PRODUCT_ENVIRONMENT_DEFAULTS, UNITY_ENVIRONMENT_ENTITY_ID, UNITY_EXCHANGE_MENU, UNITY_EXCHANGE_SCRATCH,
  UNITY_INSTANCES_URI, UNITY_PROJECT_INFO_URI, UNITY_SET_ACTIVE_INSTANCE_TOOL, UnityExchangeCancelled, UnityProjectMismatch, UnitySceneExchange, byteDigest, convertQuaternion, convertTransform, digestOfValues, encodeLpmesh,
  firstEnvironmentOf, localTransformOf, normalizePath, parseInstances, planUnitySync, productEntityIdFor, productEnvironmentFromUnity, productLightForward,
  productLightToUnity, productWorldFromUnityTransform, projectRootOf, readGlbGeometry, registerUnityExchangeTools, swapUpAxis, treeInstanceTransform,
  unityEnvironmentFromSnapshot, unityLightToProduct, unityResourceIdFor, unityTransformFromProductWorld, worldMatrix,
} from "../src/unity-exchange.ts"

let base: string, dataRoot: string, unityProject: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-unity-exchange-"))
  dataRoot = join(base, "data")
  unityProject = join(base, "unity-project")
  await mkdir(join(unityProject, "Assets"), { recursive: true })
  operations = new SceneOperations(dataRoot)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

// ────────────────────────────────────────────────────────────────────────────
// 夹具：真 GLB 字节、真 LPMESH 解码、协议层假 Unity、Unity 场景文档
// ────────────────────────────────────────────────────────────────────────────

/** 与产品同一个轴交换矩阵，但在测试里独立构造（不复用模块常量，才抓得到模块写错）。 */
const AXIS = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1)
/** 独立参考实现：位置 (x,y,z)→(x,z,y)。 */
const referenceSwap = (v: readonly number[]): number[] => new Vector3(v[0], v[1], v[2]).applyMatrix4(AXIS).toArray()
/** 独立参考实现：旋转按矩阵共轭 R' = M·R·M⁻¹。 */
function referenceQuaternion(q: readonly number[]): Quaternion {
  return new Quaternion().setFromRotationMatrix(AXIS.clone().multiply(new Matrix4().makeRotationFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]))).multiply(AXIS.clone().invert()))
}
const referenceTransform = (t: { position: number[]; quaternion: number[]; scale: number[] }) => ({
  position: referenceSwap(t.position), quaternion: referenceQuaternion(t.quaternion).toArray(), scale: referenceSwap(t.scale),
})
/** 交换文档里的节点用 `rotation` 字段（Unity 是 xyzw 四元数），这里转成参考换算的输入。 */
const referenceOf = (node: { position: number[]; rotation: number[]; scale: number[] }) => referenceTransform({ position: node.position, quaternion: node.rotation, scale: node.scale })

function expectQuaternionClose(actual: readonly number[], expected: readonly number[], digits = 12): void {
  const dot = actual[0]! * expected[0]! + actual[1]! * expected[1]! + actual[2]! * expected[2]! + actual[3]! * expected[3]!
  const sign = dot < 0 ? -1 : 1
  for (let index = 0; index < 4; index++) expect(actual[index]! * sign).toBeCloseTo(expected[index]!, digits)
}
/** 同一个旋转可以有 q 与 −q 两种写法的整体比较。 */
function expectTransformClose(actual: { position: number[]; quaternion: number[]; scale: number[] }, expected: { position: number[]; quaternion: number[]; scale: number[] }, digits = 9): void {
  for (let index = 0; index < 3; index++) expect(actual.position[index]!).toBeCloseTo(expected.position[index]!, digits)
  for (let index = 0; index < 3; index++) expect(actual.scale[index]!).toBeCloseTo(expected.scale[index]!, digits)
  expectQuaternionClose(actual.quaternion, expected.quaternion, digits)
}
/** 绕任意轴的旋转（非轴对齐，非 90° 的倍数）。 */
const axisAngle = (axis: readonly number[], degrees: number): number[] => { const q = new Quaternion().setFromAxisAngle(new Vector3(axis[0], axis[1], axis[2]).normalize(), (degrees * Math.PI) / 180); return [q.x, q.y, q.z, q.w] }
const flipWinding = (indices: readonly number[]): number[] => indices.flatMap((_, index) => index % 3 === 0 ? [indices[index]!, indices[index + 2]!, indices[index + 1]!] : [])

const padTo4 = (buffer: Buffer, fill: number): Buffer => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4, fill)])

/** 一个 glTF primitive 的输入：真 float32 顶点/法线/UV + 索引 + 材质 + 内嵌在 BIN chunk 里的贴图字节。 */
interface GlbPrimitiveSpec {
  positions: number[]; normals: number[]; indices: number[]
  uvs?: number[]
  material?: Record<string, unknown>
  texture?: { bytes: Uint8Array; mimeType: string; wrapS?: number }
}
/**
 * 最小但**合法且有真几何**的 GLB：JSON + BIN 两个 chunk，POSITION/NORMAL/TEXCOORD_0/indices 真字节，
 * 每个 primitive 一份材质（可带内嵌贴图字节），bufferView 全部 4 字节对齐（与真导出器一样）。
 * 多 primitive 时各自带自己的顶点缓冲 —— 展开时按 `base` 偏移拼索引正是要测的那条路径。
 */
function glbMulti(primitives: GlbPrimitiveSpec[]): Buffer {
  const chunks: Buffer[] = []
  const bufferViews: Array<Record<string, number>> = []
  const append = (buffer: Buffer, target?: number): number => {
    const byteOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    chunks.push(padTo4(buffer, 0))
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length, ...(target ? { target } : {}) })
    return bufferViews.length - 1
  }
  const accessors: Array<Record<string, unknown>> = []
  const materials: Array<Record<string, unknown>> = []
  const images: Array<Record<string, unknown>> = []
  const samplers: Array<Record<string, unknown>> = []
  const textures: Array<Record<string, unknown>> = []
  const gltfPrimitives = primitives.map(spec => {
    const positionView = append(Buffer.from(new Float32Array(spec.positions).buffer), 34962)
    accessors.push({
      bufferView: positionView, componentType: 5126, count: spec.positions.length / 3, type: "VEC3",
      min: [0, 1, 2].map(axis => Math.min(...spec.positions.filter((_, index) => index % 3 === axis))),
      max: [0, 1, 2].map(axis => Math.max(...spec.positions.filter((_, index) => index % 3 === axis))),
    })
    const positionAccessor = accessors.length - 1
    const normalView = append(Buffer.from(new Float32Array(spec.normals).buffer), 34962)
    accessors.push({ bufferView: normalView, componentType: 5126, count: spec.normals.length / 3, type: "VEC3" })
    const normalAccessor = accessors.length - 1
    let uvAccessor: number | undefined
    if (spec.uvs) {
      const uvView = append(Buffer.from(new Float32Array(spec.uvs).buffer), 34962)
      accessors.push({ bufferView: uvView, componentType: 5126, count: spec.uvs.length / 2, type: "VEC2" })
      uvAccessor = accessors.length - 1
    }
    const indexView = append(Buffer.from(new Uint32Array(spec.indices).buffer), 34963)
    accessors.push({ bufferView: indexView, componentType: 5125, count: spec.indices.length, type: "SCALAR" })
    const indexAccessor = accessors.length - 1
    const attributes: Record<string, number> = { POSITION: positionAccessor, NORMAL: normalAccessor }
    if (uvAccessor !== undefined) attributes.TEXCOORD_0 = uvAccessor
    const material = { ...(spec.material ?? { name: "默认", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }) }
    if (spec.texture) {
      // 图片 bufferView 不带 target（图片不是顶点缓冲）；sampler 缺省就是 Repeat/Repeat。
      const imageView = append(Buffer.from(spec.texture.bytes))
      images.push({ bufferView: imageView, mimeType: spec.texture.mimeType })
      samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: spec.texture.wrapS ?? 10497, wrapT: spec.texture.wrapS ?? 10497 })
      textures.push({ sampler: samplers.length - 1, source: images.length - 1 })
      material.pbrMetallicRoughness = { ...((material.pbrMetallicRoughness as Record<string, unknown>) ?? {}), baseColorTexture: { index: textures.length - 1 } }
    }
    materials.push(material)
    return { attributes, indices: indexAccessor, material: materials.length - 1 }
  })
  const binary = Buffer.concat(chunks)
  return assembleGlb({
    asset: { version: "2.0", generator: "lyapunov-unity-exchange-test" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "网格", mesh: 0 }],
    meshes: [{ name: "网格", primitives: gltfPrimitives }],
    materials, accessors, bufferViews,
    ...(images.length > 0 ? { images, samplers, textures } : {}),
    buffers: [{ byteLength: binary.length }],
  }, binary)
}
const glbMesh = (input: GlbPrimitiveSpec): Buffer => glbMulti([input])

/** JSON + BIN 两个 chunk 装成 GLB（chunk 长度按 4 字节对齐）。 */
function assembleGlb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const jsonChunk = padTo4(Buffer.from(JSON.stringify(json), "utf8"), 0x20)
  const binChunk = padTo4(binary, 0)
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk])
}

/**
 * 与 C# 写出器同形的最小 GLB：**所有 primitive 共用同一组 POSITION/NORMAL/TEXCOORD_0 访问器**，
 * 每个 primitive 只有自己的索引访问器（Unity 是"一个网格一份顶点、每个子网格一份索引"）。
 * 产品侧若按 primitive 复制顶点，顶点数会翻倍、子网格索引整体错位 —— 这个形状专测那条路径。
 */
function glbSharedAttributes(spec: {
  positions: number[]; normals: number[]; uvs: number[]
  submeshes: Array<{ indices: number[]; material?: Record<string, unknown> }>
}): Buffer {
  const chunks: Buffer[] = []
  const bufferViews: Array<Record<string, number>> = []
  const append = (buffer: Buffer, target?: number): number => {
    const byteOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    chunks.push(padTo4(buffer, 0))
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length, ...(target ? { target } : {}) })
    return bufferViews.length - 1
  }
  const accessors: Array<Record<string, unknown>> = []
  accessors.push({
    bufferView: append(Buffer.from(new Float32Array(spec.positions).buffer), 34962), componentType: 5126, count: spec.positions.length / 3, type: "VEC3",
    min: [0, 1, 2].map(axis => Math.min(...spec.positions.filter((_, index) => index % 3 === axis))),
    max: [0, 1, 2].map(axis => Math.max(...spec.positions.filter((_, index) => index % 3 === axis))),
  })
  const positionAccessor = accessors.length - 1
  accessors.push({ bufferView: append(Buffer.from(new Float32Array(spec.normals).buffer), 34962), componentType: 5126, count: spec.normals.length / 3, type: "VEC3" })
  const normalAccessor = accessors.length - 1
  accessors.push({ bufferView: append(Buffer.from(new Float32Array(spec.uvs).buffer), 34962), componentType: 5126, count: spec.uvs.length / 2, type: "VEC2" })
  const uvAccessor = accessors.length - 1
  const materials: Array<Record<string, unknown>> = []
  const gltfPrimitives = spec.submeshes.map(submesh => {
    accessors.push({ bufferView: append(Buffer.from(new Uint32Array(submesh.indices).buffer), 34963), componentType: 5125, count: submesh.indices.length, type: "SCALAR" })
    materials.push(submesh.material ?? { name: "默认", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } })
    return { attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor }, indices: accessors.length - 1, material: materials.length - 1 }
  })
  const binary = Buffer.concat(chunks)
  return assembleGlb({
    asset: { version: "2.0", generator: "lyapunov-unity-exchange-test" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "网格", mesh: 0 }],
    meshes: [{ name: "网格", primitives: gltfPrimitives }],
    materials, accessors, bufferViews, buffers: [{ byteLength: binary.length }],
  }, binary)
}

/** 一张 PNG 的头（真 PNG 签名 + IHDR），字节本身不重要 —— 重要的是它原样往返、不被重编码。 */
const pngBytes = (seed: number, length = 320): Uint8Array => {
  const bytes = new Uint8Array(length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
  for (let index = 16; index < length; index++) bytes[index] = (index * 31 + seed * 7) & 0xff
  return bytes
}

interface TestLpmesh {
  vertexCount: number; indexCount: number; subMeshCount: number; materialCount: number
  positions: Float32Array; normals?: Float32Array; uvs?: Float32Array; indices: Uint32Array
  submeshes: Array<{ indexStart: number; indexCount: number; material: number }>
  materials: Array<{ name: string; baseColor: number[]; metallic: number; smoothness: number; textures: Array<{ property: string; mimeType: string; wrapMode: string; contentDigest: string; bytes: Uint8Array }> }>
}
/** LPMESH v2 独立解码（按线格式逐字节写，不复用 encodeLpmesh；表 JSON 的键名也照抄 C# DTO）。 */
function decodeLpmesh(bytes: Uint8Array): TestLpmesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("LPMESH02")
  const flags = view.getUint32(8, true), vertexCount = view.getUint32(12, true), indexCount = view.getUint32(16, true)
  const subMeshCount = view.getUint32(20, true), materialCount = view.getUint32(24, true)
  let offset = 28
  const readFloats = (count: number) => {
    const values = new Float32Array(count)
    for (let index = 0; index < count; index++) values[index] = view.getFloat32(offset + index * 4, true)
    offset += count * 4
    return values
  }
  const positions = readFloats(vertexCount * 3)
  const normals = flags & 1 ? readFloats(vertexCount * 3) : undefined
  const uvs = flags & 2 ? readFloats(vertexCount * 2) : undefined
  expect(flags & 4).toBe(4)
  const indices = new Uint32Array(indexCount)
  for (let index = 0; index < indexCount; index++) indices[index] = view.getUint32(offset + index * 4, true)
  offset += indexCount * 4
  const submeshes: TestLpmesh["submeshes"] = []
  const starts: number[] = [], counts: number[] = []
  for (let subMesh = 0; subMesh < subMeshCount; subMesh++) { starts.push(view.getUint32(offset, true)); offset += 4 }
  for (let subMesh = 0; subMesh < subMeshCount; subMesh++) { counts.push(view.getUint32(offset, true)); offset += 4 }
  const tableLength = view.getUint32(offset, true)
  offset += 4
  const table = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + tableLength))) as {
    textureBlobLength: number
    submeshMaterials: number[]
    materials: Array<{ name: string; baseColor: number[]; metallic: number; smoothness: number; textures: Array<{ property: string; mimeType: string; wrapMode: string; contentDigest: string; byteOffset: number; byteLength: number }> }>
  }
  offset += tableLength
  const blob = bytes.subarray(offset)
  expect(blob.length).toBe(table.textureBlobLength)
  const materials = table.materials.map(material => ({
    name: material.name, baseColor: material.baseColor, metallic: material.metallic, smoothness: material.smoothness,
    textures: material.textures.map(texture => ({
      property: texture.property, mimeType: texture.mimeType, wrapMode: texture.wrapMode, contentDigest: texture.contentDigest,
      bytes: blob.subarray(texture.byteOffset, texture.byteOffset + texture.byteLength),
    })),
  }))
  for (let subMesh = 0; subMesh < subMeshCount; subMesh++) submeshes.push({ indexStart: starts[subMesh]!, indexCount: counts[subMesh]!, material: table.submeshMaterials[subMesh]! })
  expect(materials.length).toBe(materialCount)
  return { vertexCount, indexCount, subMeshCount, materialCount, positions, ...(normals ? { normals } : {}), ...(uvs ? { uvs } : {}), indices, submeshes, materials }
}

type FakeMode = "ok" | "menu-fail" | "menu-timeout" | "silent" | "result-not-ok"

/**
 * 与真机一致的原生资源回执形状（真 Unity MCP 的 `mcpforunity://project/info` 就是这个形状，
 * 2026-09-20 在真编辑器上读过一次；本文件不重造协议，只重放同一个形状）。
 */
const projectInfoResource = (projectRoot: string) => ({ contents: [{ uri: UNITY_PROJECT_INFO_URI, mimeType: "text/plain", text: JSON.stringify({ success: true, data: { projectRoot, projectName: "UnityMCPStarter", unityVersion: "6000.3.24f1", assetsPath: `${projectRoot}/Assets` } }) }] })
/** 真机 `mcpforunity://instances` 的形状（id=Name@hash、path 是 …/Project/Assets、port）。 */
const instancesResource = (instances: Array<{ id: string; projectPath?: string; port?: number }>) => ({
  contents: [{ uri: UNITY_INSTANCES_URI, mimeType: "text/plain", text: JSON.stringify({ success: true, transport: "stdio", instance_count: instances.length, instances: instances.map(instance => ({ id: instance.id, name: instance.id.split("@")[0], hash: instance.id.split("@")[1] ?? "", path: instance.projectPath ? join(instance.projectPath, "Assets") : "", port: instance.port ?? 6400, status: "running", unity_version: "6000.3.24f1", project_scoped_tools: false })) }) }],
})

/** Unity 编辑器（协议层）替身：按 C# 工具的合同扫 requests/、认领、写各自 result，产出真字节。 */
function fakeUnity(options: {
  /** 导出/导入用的文档。给函数时按请求生成：并行用例用它证明"每条调用读到的是自己那份导出"。 */
  document?: UnitySceneDocument | ((request: Record<string, any>) => UnitySceneDocument)
  mode?: FakeMode
  status?: Record<string, unknown>
  projectRoot?: string | null
  /** 实例清单（缺省 = 就本工程一个实例）。null = 资源读不到。 */
  instances?: Array<{ id: string; projectPath?: string; port?: number }> | null
  /** 每次执行前的延迟：给并行用例造出真正的重叠窗口。 */
  delayMs?: number
  /** 每次菜单调用时插进来的回调（例如在读取期间提交另一版产品场景，制造 CAS 冲突；或在这时取消）。 */
  onMenu?: () => Promise<void>
  /** 写请求文件时的回调（测试用它拿到本次 requestId/路径，不靠轮询猜）。 */
  onRequest?: (path: string, request: Record<string, any>) => void
  /** 回执里自报的工程根（默认=本工程）：用来演"菜单其实打到另一台实例"的受控反例。 */
  receiptProjectRoot?: string
}) {
  const scratch = join(unityProject, UNITY_EXCHANGE_SCRATCH)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const resources: string[] = []
  const imported: UnitySceneDocument[] = []
  /** 真正执行过的 requestId（按顺序）：用来证明"一份请求恰好执行一次"。 */
  const executed: string[] = []
  /** set_active_instance 绑过的实例。 */
  const bindings: string[] = []

  const write = async (request: Record<string, any>, payload: Record<string, unknown>) => {
    const path = request.resultPath as string
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ requestId: request.requestId, op: request.op, ok: true, errors: [], warnings: [], projectRoot: options.receiptProjectRoot ?? options.projectRoot ?? unityProject, processId: 4242, instanceName: "UnityMCPStarter", scenePath: "Assets/Scenes/Main.unity", sceneName: "Main", sceneGuid: "guid-main", changed: [], ...payload }))
  }
  const execute = async (request: Record<string, any>) => {
    executed.push(request.requestId)
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    // C# 侧的目标核对：请求声明的工程与本编辑器不一致就什么都不做（回一份 PROJECT_MISMATCH）。
    if (request.expectProjectRoot && normalizePath(request.expectProjectRoot) !== normalizePath(options.projectRoot ?? unityProject)) {
      await write(request, { ok: false, errors: [`PROJECT_MISMATCH: 请求指定工程 ${request.expectProjectRoot}，本编辑器是 ${options.projectRoot ?? unityProject}（不执行任何导入/导出）`] })
      return
    }
    if (request.op === "status") {
      await write(request, { status: options.status ?? { unityVersion: "6000.3.24f1", platform: "LinuxEditor", projectPath: unityProject, isDirty: false, activeScene: { name: "Main", path: "Assets/Scenes/Main.unity", isDirty: false }, loadedScenes: [], pendingRequests: [], recentResults: [] } })
    } else if (request.op === "export") {
      // 与 C# 同形：空的 documentPath 落回**共用**的 unity-scene.json（谁都没指定时必然互相覆盖），
      // 请求里给了路径就用它 —— 产品必须自己保证并行导出不共用一份文档。
      const documentPath = String(request.export?.documentPath ?? "") || join(scratch, "unity-scene.json")
      const document = typeof options.document === "function" ? options.document(request) : options.document!
      await writeFile(documentPath, JSON.stringify(document))
      await write(request, {
        ok: options.mode !== "result-not-ok", errors: options.mode === "result-not-ok" ? ["EXPORT_FAILED_IN_UNITY"] : [],
        export: { scenePath: document.scenePath, documentPath, nodeCount: document.nodes.length, rootCount: 1, assetCount: document.assets.length, meshFileCount: document.nodes.filter(node => node.mesh?.file).length, documentBytes: JSON.stringify(document).length, losses: [] },
      })
    } else if (request.op === "import") {
      const document = JSON.parse(await readFile(request.import.documentPath as string, "utf8")) as UnitySceneDocument
      imported.push(document)
      await write(request, {
        import: { scenePath: request.import.scenePath, mode: request.import.mode, dryRun: request.import.dryRun, created: document.nodes.length, updated: 0, skipped: 0, assetFilesCopied: 0, nodes: [], losses: [] },
        changed: document.nodes.map(node => `created:${node.entityId}:${node.globalId}:${node.name}`),
      })
    }
  }
  /** 与 C# DrainPendingRequests 同形：扫 requests/，`rm` 认领（并发时只有一个能删掉），再逐份执行。 */
  const drain = async (): Promise<number> => {
    const directory = join(scratch, "requests")
    let names: string[] = []
    try { names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort() } catch { return 0 }
    let count = 0
    for (const name of names) {
      const path = join(directory, name)
      let request: Record<string, any>
      try { request = JSON.parse(await readFile(path, "utf8")) as Record<string, any> } catch { continue }
      try { await rm(path) } catch { continue }   // 已被另一次运行认领
      count++
      // 过期请求：编辑器只写一份 REQUEST_EXPIRED 回执，不执行（取消/崩溃留下的孤儿不会很久以后突然跑）。
      if (typeof request.deadlineUnixMs === "number" && Date.now() > request.deadlineUnixMs) {
        await write(request, { ok: false, errors: [`REQUEST_EXPIRED: 请求 ${request.requestId} 已过期（deadlineUnixMs ${request.deadlineUnixMs}），编辑器不执行`] })
        continue
      }
      await execute(request)
    }
    return count
  }
  const port: UnityExchangePort = {
    async readResource(uri) {
      resources.push(uri)
      if (uri === UNITY_INSTANCES_URI) {
        if (options.instances === null) throw new Error("RESOURCE_UNAVAILABLE")
        return instancesResource(options.instances ?? [{ id: "UnityMCPStarter@114e4a37", projectPath: options.projectRoot ?? unityProject, port: 6400 }])
      }
      if (options.projectRoot === null) throw new Error("RESOURCE_UNAVAILABLE")
      return projectInfoResource(options.projectRoot ?? unityProject)
    },
    async call(tool, args = {}) {
      calls.push({ tool, args })
      if (tool === "set_active_instance") { bindings.push(String(args.instance)); return { ok: true, text: "ok" } }
      if (options.onMenu) await options.onMenu()
      // 菜单本身没找到 / 调用失败：编辑器根本不会跑。
      if (options.mode === "menu-fail") return { ok: false, text: "MENU_ITEM_NOT_FOUND" }
      // 菜单返回成功但回执永不出现（编辑器卡住/工具没装好）：调用方必须等超时并报错，不能当成功。
      if (options.mode === "silent") return { ok: true, text: "ok" }
      // 原生 execute_menu_item 自己超时、但菜单项其实已经在编辑器里跑起来并写回执（真机上的重导入就是这样）。
      const drained = await drain()
      if (options.mode === "menu-timeout") return { ok: false, text: `Error: Request timed out（编辑器已认领 ${drained} 份）` }
      return { ok: true, text: `ok drained=${drained}` }
    },
    readFile: async path => await readFile(path, "utf8"),
    writeFile: async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, "utf8") },
    writeJSONAtomic: async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value)}\n`); options.onRequest?.(path, value as Record<string, any>) },
    removeFile: async path => { await rm(path, { force: true }) },
    writeBinary: async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) },
  }
  return { port, calls, resources, imported, executed, bindings, scratch }
}

/** Unity 侧网格（Unity 原生空间，UV 是 Unity 约定：左下原点）与它在 GLB 里的样子（M 一次 + 绕序翻转 + v 翻转）。 */
const unityMesh = {
  positions: [0, 0, 0, 1, 0, 0, 1, 0.5, 0.25, 0, 0.5, 0.25],
  normals: [0.26726124, 0.53452248, 0.80178373, 0.26726124, 0.53452248, 0.80178373, 0.26726124, 0.53452248, 0.80178373, 0.26726124, 0.53452248, 0.80178373],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 1, 3, 2],
}
/** Unity 空间的顶点数组 → glTF 空间（轴交换），逐顶点成对处理。 */
const toGltf = (values: readonly number[], components: number): number[] => values.flatMap((_, index, array) => index % components === 0 ? referenceSwap(array.slice(index, index + components)) : [])
/** Unity 约定 UV → glTF 约定 UV（只翻 v）。 */
const toGltfUvs = (uvs: readonly number[]): number[] => uvs.map((value, index) => index % 2 === 0 ? value : 1 - value)
const glbForUnityMesh = (material?: Record<string, unknown>, texture?: GlbPrimitiveSpec["texture"]) => glbMesh({
  positions: toGltf(unityMesh.positions, 3), normals: toGltf(unityMesh.normals, 3),
  uvs: toGltfUvs(unityMesh.uvs), indices: flipWinding(unityMesh.indices), material, texture,
})

const lightRecord = (overrides: Partial<UnityLightRecord> = {}): UnityLightRecord => ({
  type: "Point", color: [1, 0.5, 0.25], intensity: 8, range: 30, spotAngleDeg: 30, areaSize: [1, 1], shadows: "Soft", bounceIntensity: 1, enabled: true, ...overrides,
})

/**
 * 一份"真 Unity 导出"形状的文档：父子三层、非轴对齐旋转、非均匀缩放、网格与灯。
 * GlobalObjectId 用真机形状 `GlobalObjectId_V1-2-<场景GUID>-<本地ID>-<类型>`：前缀里的场景 GUID
 * 是"这个对象属于哪个 Unity 场景"的判据（身份窄更新与幽灵删除都按它划范围）。
 */
function unityDocument(overrides: { sceneGuid?: string; meshFile?: string; mesh?: Partial<UnityMeshRecord>; materials?: UnityMaterialRecord[]; environment?: UnityEnvironmentRecord } = {}): UnitySceneDocument {
  const meshFile = overrides.meshFile ?? join(UNITY_EXCHANGE_SCRATCH, "meshes", "site.glb")
  const sceneGuid = overrides.sceneGuid ?? "guid-acceptance"
  const nodes: UnityNode[] = [
    {
      index: 0, parentIndex: -1, name: "场地", entityId: "entity_unity_site", globalId: `GlobalObjectId_V1-2-${sceneGuid}-1-0`,
      position: [1.5, 2.25, -0.5], rotation: axisAngle([0.3, 0.8, 0.52], 37), scale: [1, 1, 1], active: true, tag: "Untagged", layer: 0,
      componentTypes: ["Transform", "MeshFilter", "MeshRenderer"], losses: [],
      mesh: { name: "场地网格", primitive: "", assetPath: "Assets/LyapunovEnvironmentAcceptance/Meshes/site.asset", assetGuid: "guid-site", vertexCount: 4, triangleCount: 2, subMeshCount: 1, uvCount: 4, contentDigest: "1f2e3d4c5b6a7988", boundsCenter: [0.5, 0.25, 0.125], boundsSize: [1, 0.5, 0.25], file: meshFile, fileSpace: "unity-left-handed-y-up-meters-raw", fileBytes: 0, ...overrides.mesh },
      materials: overrides.materials ?? [{ name: "钢", assetPath: "Assets/Materials/Steel.mat", assetGuid: "guid-steel", shader: "Standard", baseColor: [0.2, 0.6, 0.9, 1], metallic: 0.3, smoothness: 0.6, textures: [], textureFiles: [] }],
    },
    {
      index: 1, parentIndex: 0, name: "灯杆", entityId: "entity_unity_pole", globalId: `GlobalObjectId_V1-2-${sceneGuid}-2-0`,
      position: [-3, 0.75, 1.25], rotation: axisAngle([1, 1, 1], 55), scale: [1.5, 0.8, 1.2], active: true, tag: "Untagged", layer: 0,
      componentTypes: ["Transform"], losses: [],
    },
    {
      index: 2, parentIndex: 1, name: "顶灯", entityId: "entity_unity_lamp", globalId: `GlobalObjectId_V1-2-${sceneGuid}-3-0`,
      position: [0.25, 2.5, -0.125], rotation: axisAngle([1, -0.4, 0.2], 118), scale: [1, 1, 1], active: true, tag: "Untagged", layer: 0,
      componentTypes: ["Transform", "Light"], losses: [], light: lightRecord(),
    },
  ]
  return {
    kind: "lyapunov.unity-scene", version: 1, generator: "scene-kit/unity-exchange@1", generatedAtUnixMs: Date.now(),
    scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/Acceptance.unity", sceneName: "Acceptance", sceneGuid,
    transformSpace: "unity-left-handed-y-up-meters", meshSpace: "unity-left-handed-y-up-meters",
    ...(overrides.environment ? { environment: overrides.environment } : {}), nodes, assets: [], losses: [],
  }
}

/** 一份 Unity 侧环境读数（RenderSettings + 相机背景 + 最亮方向光），形状与 C# `CaptureEnvironment` 一致。 */
const environmentRecord = (overrides: Partial<UnityEnvironmentRecord> = {}): UnityEnvironmentRecord => ({
  present: true, environmentIntensity: 1.35, hemisphereIntensity: 3.6, ambientMode: "Skybox",
  background: "color", backgroundColor: "#336699", shadows: true,
  sunAzimuthDeg: 128.5, sunElevationDeg: 33.25, sunIntensity: 2.75, sunName: "太阳",
  dayNightEnabled: false, dayNightHours: 9, dayNightCycleSeconds: 120,
  skyboxPath: "", skyboxShader: "", hdriFile: "", hdriAssetPath: "", hdriBytes: 0,
  losses: [], ...overrides,
})

/**
 * 真 Unity 的 JsonUtility 把"没有的嵌套记录"写成**字段默认值实例**（不是 null）：2026-09-20 在真导出文档里
 * 数过——7 个节点、每个都带着空的 light/camera/prefab/terrain。这里复现同一个形状。
 */
function withUnityJsonDefaults(document: UnitySceneDocument): UnitySceneDocument {
  return {
    ...document,
    nodes: document.nodes.map(node => ({
      ...node,
      light: node.light ?? { type: "", color: [0, 0, 0, 0], intensity: 0, range: 0, spotAngleDeg: 0, areaSize: [0, 0], shadows: "", bounceIntensity: 0, enabled: true },
      camera: node.camera ?? { fieldOfViewDeg: 0, nearClip: 0, farClip: 0, orthographic: false, orthographicSize: 0, depth: 0, clearFlags: "", background: [0, 0, 0, 0], enabled: true },
      prefab: node.prefab ?? { status: "", assetPath: "", assetGuid: "", isOutermost: false },
      terrain: node.terrain ?? { widthM: 0, heightM: 0, lengthM: 0, heightmapResolution: 0, minHeight: 0, maxHeight: 0, heightsFile: "", heightsBytes: 0, alphamapLayers: 0, treeInstanceCount: 0, treesFile: "", treePrototypes: [] },
    })),
  }
}

async function writeUnityMeshFile(document: UnitySceneDocument, bytes: Buffer): Promise<string> {
  return await writeUnityFile(document.nodes[0]!.mesh!.file, bytes)
}

/** 往"Unity 工程"里写一个交付件（地形网格/植被原型 GLB）：产品侧要从这个路径把它登记进自己的资源库。 */
async function writeUnityFile(relative: string, bytes: Buffer): Promise<string> {
  const path = join(unityProject, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

async function sceneWith(document: UnitySceneDocument, options: { mode?: FakeMode; glb?: Buffer } = {}) {
  await writeUnityMeshFile(document, options.glb ?? glbForUnityMesh({ name: "钢", pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.9, 1], metallicFactor: 0.3, roughnessFactor: 0.4 } }))
  await operations.create({ sceneId: "scene_acc" })
  const unity = fakeUnity({ document, mode: options.mode })
  const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 2_000, pollMs: 5 })
  return { unity, exchange }
}
/** components 是 `[namespace: string]: unknown` 的字典：Unity 来源元数据与 light 组件按统一形状取用。 */
const unityOf = (entity: Entity): UnityOriginMetadata => entity.components.unity as UnityOriginMetadata
const lightOf = (entity: Entity): { kind: string; color: number[]; energy: number; direction: number[] } => entity.components.light as { kind: string; color: number[]; energy: number; direction: number[] }
const entityOf = (entities: Entity[], entityId: string): Entity => {
  const entity = entities.find(item => item.entityId === entityId)
  if (!entity) throw new Error(`ENTITY_MISSING: ${entityId} in ${entities.map(item => item.entityId).join(",")}`)
  return entity
}

// ────────────────────────────────────────────────────────────────────────────

describe("ENV-26/27 空间换算", () => {
  test("位置与旋转的换算是同一个对合函数，且与矩阵 M 的共轭逐项一致（300 组随机非轴对齐旋转）", () => {
    for (let index = 0; index < 300; index++) {
      const axis = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1]
      if (Math.hypot(...axis) < 0.1) axis[0] = 1
      const q = axisAngle(axis, Math.random() * 360 - 180)
      const converted = convertQuaternion(q)
      // 旋转：与矩阵共轭 R' = M·R·M⁻¹ 一致（独立路径，不是同一个公式）。
      expectQuaternionClose(converted, referenceQuaternion(q).toArray(), 12)
      // 对合：换算两次回到原值（同一个函数双向可用）。
      expectQuaternionClose(convertQuaternion(converted), q, 12)
      // 位置与缩放都按 M 走（几何本身是 M 映射交付的，局部 TRS 必须整体共轭）。
      const position = [Math.random() * 20 - 10, Math.random() * 20 - 10, Math.random() * 20 - 10]
      const scale = [1 + Math.random(), 0.1 + Math.random(), 1 + Math.random() * 3]
      const transform = convertTransform({ position: position as [number, number, number], quaternion: q as [number, number, number, number], scale: scale as [number, number, number] })
      expect([...transform.position]).toEqual(referenceSwap(position))
      expect([...transform.scale]).toEqual(referenceSwap(scale))
      expect(transform.scale).not.toEqual(scale)
      expectTransformClose(convertTransform(transform), { position, quaternion: q, scale }, 12)
    }
    // 缩放换位的物理含义：Unity 里沿 Y 拉长 2 倍的物体，在产品里必须沿 Z 拉长 2 倍。
    const stretched = convertTransform({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 2, 3] })
    expect(stretched.scale).toEqual([1, 3, 2])
    expect(referenceSwap(new Vector3(0, 1, 0).multiply(new Vector3(1, 2, 3)).toArray())).toEqual([0, 0, 2])
    // 世界矩阵层面的判据：局部的共轭 = 共轭的局部（M⁻¹·(T·R·S)·M）。
    for (const sample of [[1, 2, 3], [0.5, 1, 0.25], [-1, 1, 1]]) {
      const local = new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion(...axisAngle([0.2, 0.5, -0.7], 41)), new Vector3(...(sample as number[])))
      const converted = referenceTransform({ position: [1, 2, 3], quaternion: axisAngle([0.2, 0.5, -0.7], 41), scale: sample as number[] })
      const composed = new Matrix4().compose(new Vector3(...converted.position), new Quaternion(...converted.quaternion), new Vector3(...converted.scale))
      const conjugate = AXIS.clone().invert().multiply(local).multiply(AXIS)
      for (let index = 0; index < 16; index++) expect(composed.elements[index]!).toBeCloseTo(conjugate.elements[index]!, 12)
    }
    // 非单位四元数按方向处理（归一化），不把长度当角度。
    const scaled = convertQuaternion([0.2, -0.4, 0.1, 0.7])
    expect(Math.hypot(...scaled)).toBeCloseTo(1, 12)
    expectQuaternionClose(scaled, convertQuaternion(new Quaternion(0.2, -0.4, 0.1, 0.7).normalize().toArray()), 12)
  })

  test("语义核对：Unity 的出射轴换算后就是产品的对应轴向（不是镜像或反向）", () => {
    // Unity 的对象出射轴是它自己的局部 +Z；轴交换把 Unity 的 +Z 映成产品的 +Y，
    // 所以判据是「产品局部 (0,1,0) 经过换算后的旋转」⇔「Unity 被旋转过的 (0,0,1) 经轴交换」。
    // 直接拿产品 (0,0,1) 当基准会得到 Unity +Y 的像，那是另一根轴（这次就是这样被测试抓出来的）。
    for (let index = 0; index < 200; index++) {
      const q = axisAngle([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1], Math.random() * 360 - 180)
      const converted = convertQuaternion(q)
      const unityForward = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...q)).toArray()
      const productForwardByFormula = new Vector3(...referenceSwap([0, 0, 1])).applyQuaternion(new Quaternion(...converted)).toArray()
      const productForwardByMapping = referenceSwap(unityForward)
      for (let component = 0; component < 3; component++) expect(productForwardByFormula[component]!).toBeCloseTo(productForwardByMapping[component]!, 12)
      // 轴向身份：Unity 的 +Y（上）映到产品的 +Z（上）；Unity 的 +Z（出射）映到产品的 +Y。
      expect(referenceSwap([0, 1, 0])).toEqual([0, 0, 1])
      expect(referenceSwap([0, 0, 1])).toEqual([0, 1, 0])
    }
  })

  test("换算对层级可乘：convert(A⊗B) = convert(A)⊗convert(B)，父子链无需逐层重算", () => {
    for (let index = 0; index < 100; index++) {
      const a = axisAngle([Math.random() * 2 - 1, 1, Math.random() * 2 - 1], Math.random() * 360 - 180)
      const b = axisAngle([1, Math.random() * 2 - 1, -0.5], Math.random() * 360 - 180)
      const product = new Quaternion(...a).multiply(new Quaternion(...b))
      expectQuaternionClose(convertQuaternion(product.toArray()), new Quaternion(...convertQuaternion(a)).multiply(new Quaternion(...convertQuaternion(b))).toArray(), 12)
    }
  })

  test("世界矩阵 ⇄ Unity 世界变换：同一共轭、位置经 M 映射、行列式为负时如实报告镜像", () => {
    const productWorld = new Matrix4().compose(new Vector3(1.5, -2.25, 0.5), new Quaternion(...axisAngle([0.2, 0.9, 0.4], 63)), new Vector3(2, 0.5, 1.25))
    const unity = unityTransformFromProductWorld(productWorld)
    expect(unity.mirrored).toBe(false)
    // 位置：M⁻¹·t；旋转：矩阵共轭；把 Unity 世界变换折回产品世界矩阵必须逐项还原。
    expect([...unity.transform.position]).toEqual(referenceSwap([1.5, -2.25, 0.5]))
    expectQuaternionClose(unity.transform.quaternion, referenceQuaternion(new Quaternion(...axisAngle([0.2, 0.9, 0.4], 63)).toArray()).toArray(), 12)
    const back = productWorldFromUnityTransform(unity.transform)
    for (let index = 0; index < 16; index++) expect(back.elements[index]!).toBeCloseTo(productWorld.elements[index]!, 9)
    // 镜像：同一个变换额外加一个负缩放，det<0 必须报出来（Unity 侧就是负缩放，但调用方要知道）。
    const mirrored = productWorld.clone().multiply(new Matrix4().makeScale(1, 1, -1))
    const mirroredUnity = unityTransformFromProductWorld(mirrored)
    expect(mirroredUnity.mirrored).toBe(true)
    const mirroredBack = productWorldFromUnityTransform(mirroredUnity.transform)
    for (let index = 0; index < 16; index++) expect(mirroredBack.elements[index]!).toBeCloseTo(mirrored.elements[index]!, 9)
  })

  test("零缩放与非法缩放不静默：钳到产品合法值并写明损失", () => {
    const losses: string[] = []
    const node = { index: 0, parentIndex: -1, name: "退化", entityId: "e1", globalId: "", position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 0, 2], active: true, tag: "", layer: 0, componentTypes: [], losses: [] } as UnityNode
    const transform = convertTransform(localTransformOf(node, losses, "退化"))
    expect(transform.scale).toEqual([1e-6, 1e-6, 1e-6])
    expect(losses.join("\n")).toMatch(/ZERO_SCALE_CLAMPED/)
    // 非法值（NaN）同样被钳，且位置/旋转给缺省值而不是 undefined。
    const missing = localTransformOf({ ...node, position: [] as number[], rotation: [] as number[], scale: [Number.NaN, 1, 1] } as UnityNode, losses, "缺字段")
    expect(missing.position).toEqual([0, 0, 0])
    expect(missing.quaternion).toEqual([0, 0, 0, 1])
    expect(losses.filter(loss => loss.startsWith("ZERO_SCALE_CLAMPED")).length).toBe(2)
  })
})

describe("ENV-27 Unity → 产品（真 SceneStore/真资源库）", () => {
  test("真文档读成产品场景：身份/层级/非轴对齐变换落地，网格进资源库且字节一致", async () => {
    const document = unityDocument()
    const { exchange, unity } = await sceneWith(document)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    // 只执行原生菜单项（外加一次实例绑定，见"目标绑定"那组用例）：没有第二套 RPC。
    expect(unity.calls.filter(call => call.tool !== UNITY_SET_ACTIVE_INSTANCE_TOOL).every(call => call.tool === "execute_menu_item" && call.args.menu_path === UNITY_EXCHANGE_MENU)).toBe(true)
    const snapshot = await operations.inspect("scene_acc")
    // GLB 展开成 组根 + 源坐标转换 + 节点；网格节点是 Unity 对象的身份载体。
    expect(snapshot.entities.map(entity => entity.entityId)).toEqual(["entity_unity_site", "entity_unity_site:source", "entity_unity_site:node:0", "entity_unity_pole", "entity_unity_lamp"])
    expect(report.entities).toBe(5)
    expect(report.unityScene.path).toBe("Assets/LyapunovEnvironmentAcceptance/Scenes/Acceptance.unity")
    expect(snapshot.revision).toBe(1)

    // 变换：每个实体的局部变换 = 文档局部变换经 M 换算（独立参考实现逐项对账）。
    for (const node of document.nodes) {
      const entity = entityOf(snapshot.entities, productEntityIdFor(node))
      expectTransformClose(entity.transform, referenceOf(node), 9)
      expect(unityOf(entity)).toMatchObject({ layer: 0, tag: "Untagged", active: true })
    }
    expect(entityOf(snapshot.entities, "entity_unity_site:node:0").transform).toMatchObject({ position: [0, 0, 0], scale: [1, 1, 1] })
    // 世界矩阵：把文档父链折出来（Unity 空间原值 / 换算后的两条独立路径）⇔ 产品场景里折父链。
    const asMatrix = (node: UnityNode): Matrix4 => new Matrix4().compose(new Vector3(...node.position), new Quaternion(...node.rotation), new Vector3(...node.scale))
    const productLocal = (node: UnityNode): Matrix4 => { const reference = referenceOf(node); return new Matrix4().compose(new Vector3(...reference.position), new Quaternion(...reference.quaternion), new Vector3(...reference.scale)) }
    const expectedLampUnityWorld = asMatrix(document.nodes[2]!).premultiply(asMatrix(document.nodes[1]!).premultiply(asMatrix(document.nodes[0]!)))
    const expectedWorld = productLocal(document.nodes[1]!).premultiply(productLocal(document.nodes[0]!))
    const lampWorld = worldMatrix(snapshot, "entity_unity_lamp")
    const expectedLampWorld = productLocal(document.nodes[2]!).premultiply(expectedWorld)
    for (let index = 0; index < 16; index++) expect(lampWorld.elements[index]!).toBeCloseTo(expectedLampWorld.elements[index]!, 9)
    // 灯的出射方向：Unity 空间里父链折出的世界前向（局部 +Z）经 M 换算 ⇔ 产品侧记录的 direction。
    expect(document.nodes[2]!.light).toBeDefined()
    const unityLampForward = referenceSwap(new Vector3(0, 0, 1).applyMatrix4(new Matrix4().extractRotation(expectedLampUnityWorld)).normalize().toArray())
    const lampForward = productLightForward(snapshot, "entity_unity_lamp")
    for (let index = 0; index < 3; index++) expect(lampForward[index]!).toBeCloseTo(unityLampForward[index]!, 12)

    // 网格：真资源进 CAS，字节与 Unity 写出的 GLB 逐字节一致（内容去重的前提）。
    const meshEntity = entityOf(snapshot.entities, "entity_unity_site:node:0")
    // 资源与几何挂在展开出的节点上，Unity 来源元数据挂在承载 Unity 对象身份的组根上。
    const ref = meshEntity.resources[0]!
    expect(ref.source).toEqual({ units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 })
    expect(new Uint8Array(await readFile(localPath(ref.original.uri)))).toEqual(new Uint8Array(glbForUnityMesh({ name: "钢", pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.9, 1], metallicFactor: 0.3, roughnessFactor: 0.4 } })))
    expect(unityOf(entityOf(snapshot.entities, "entity_unity_site"))).toMatchObject({ mesh: { vertexCount: 4, triangleCount: 2, fileSpace: "unity-left-handed-y-up-meters-raw" } })
    // 灯：映射到 Viewer 真渲染的 components.light；方向与实体世界朝向一致。
    const lamp = entityOf(snapshot.entities, "entity_unity_lamp")
    expect(lightOf(lamp)).toMatchObject({ kind: "point", color: [1, 0.5, 0.25], energy: 8 * LIGHT_ENERGY_SCALE.point })
    for (let index = 0; index < 3; index++) expect(lightOf(lamp).direction[index]!).toBeCloseTo(productLightForward(snapshot, "entity_unity_lamp")[index]!, 12)
    expect(unityOf(lamp).losses.join("\n")).toMatch(/LIGHT_SHADOWS_NOT_TRANSFERRED/)
    // 网格对象上的材质记录随身份一起落地（往返时 Unity 侧优先用原资产）。
    expect(unityOf(entityOf(snapshot.entities, "entity_unity_site"))).toMatchObject({ materials: [{ assetPath: "Assets/Materials/Steel.mat", metallic: 0.3, smoothness: 0.6 }] })
  })

  test("重复读取是刷新同一批实体：身份稳定、资源命中内容去重、内容没变就不提交新版本也不重复实体", async () => {
    const document = unityDocument()
    const { exchange } = await sceneWith(document)
    const first = await exchange.readScene({ sceneId: "scene_acc" })
    const before = await operations.inspect("scene_acc")
    const firstRef = entityOf(before.entities, "entity_unity_site:node:0").resources[0]!

    const second = await exchange.readScene({ sceneId: "scene_acc" })

    const after = await operations.inspect("scene_acc")
    expect(after.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    // 内容没变 → 空补丁不提交（不是每次读都造一个新版本）；真要改的内容见下一组用例。
    expect(second.revision).toBe(first.revision)
    expect(second.sync).toEqual({ added: [], updated: [], removed: [], reparented: [], kept: before.entities.map(entity => entity.entityId), userReparented: [], framesKept: [] })
    expect(second.identity).toEqual(first.identity)
    // 同一对象 → 同一个确定性 resourceId；同字节 → 同一个版本（内容去重，不是每次新增 v2）。
    const secondRef = entityOf(after.entities, "entity_unity_site:node:0").resources[0]!
    expect(secondRef.resourceId).toBe(firstRef.resourceId)
    expect(secondRef.version).toBe(firstRef.version)
    expect(second.losses.join("\n")).toMatch(/RESOURCE_REUSED/)
    expect(unityOf(entityOf(after.entities, "entity_unity_site"))).toMatchObject({ mesh: { vertexCount: 4 } })
    // 身份派生：没有 identity 组件时按 GlobalObjectId 派生，同名不同对象也不撞。
    expect(productEntityIdFor({ entityId: "", globalId: "GlobalObjectId_V1-2-abc-9", name: "同名" })).toMatch(/^entity_unity_[0-9a-f]{16}$/)
    expect(productEntityIdFor({ entityId: "", globalId: "GlobalObjectId_V1-2-abc-9", name: "同名" })).not.toBe(productEntityIdFor({ entityId: "", globalId: "GlobalObjectId_V1-2-abc-8", name: "同名" }))
    expect(unityResourceIdFor("entity_unity_ab:cd", "seed")).toMatch(/^res_unity_[A-Za-z0-9_.:-]+_[0-9a-f]{8}$/)
  })

  test("相机/预制体/地形与植被：作为 Unity 命名空间元数据落地（不是假装渲染），且不冒充可渲染视觉", async () => {
    const document = unityDocument()
    const terrain = { widthM: 500, heightM: 30, lengthM: 400, heightmapResolution: 513, minHeight: 0, maxHeight: 30, heightsFile: join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0002.f32"), heightsBytes: 513 * 513 * 4, alphamapLayers: 2, treeInstanceCount: 2, treesFile: join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0002-trees.json"), treePrototypes: [{ prefabPath: "Assets/Prefabs/Tree.prefab", prefabGuid: "guid-tree" }] }
    document.nodes.push(
      { index: 3, parentIndex: -1, name: "相机", entityId: "entity_unity_camera", globalId: "g-cam", position: [4, 3, 8], rotation: axisAngle([0, 1, 0.2], 25), scale: [1, 1, 1], active: true, tag: "MainCamera", layer: 0, componentTypes: ["Transform", "Camera"], losses: [], camera: { fieldOfViewDeg: 60, nearClip: 0.1, farClip: 1000, orthographic: false, orthographicSize: 5, depth: -1, clearFlags: "Skybox", background: [0.2, 0.3, 0.4, 1], enabled: true } },
      { index: 4, parentIndex: -1, name: "路灯预制体", entityId: "entity_unity_prefab", globalId: "g-prefab", position: [6, 0, -2], rotation: axisAngle([1, 0, 0.3], 15), scale: [1, 1, 1], active: true, tag: "Untagged", layer: 0, componentTypes: ["Transform"], losses: [], prefab: { status: "instance", assetPath: "Assets/Prefabs/StreetLamp.prefab", assetGuid: "guid-lamp", isOutermost: true } },
      { index: 5, parentIndex: -1, name: "地形", entityId: "entity_unity_terrain", globalId: "g-terrain", position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], active: true, tag: "Untagged", layer: 0, componentTypes: ["Transform", "Terrain", "TerrainCollider"], losses: ["TERRAIN_MESH_NOT_TRANSFERRED"], terrain },
    )
    const { exchange } = await sceneWith(document)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const camera = entityOf(snapshot.entities, "entity_unity_camera")
    const prefab = entityOf(snapshot.entities, "entity_unity_prefab")
    const terrainEntity = entityOf(snapshot.entities, "entity_unity_terrain")
    expect(unityOf(camera).camera).toMatchObject({ fieldOfViewDeg: 60, nearClip: 0.1, farClip: 1000, clearFlags: "Skybox" })
    expect(unityOf(prefab).prefab).toMatchObject({ status: "instance", assetPath: "Assets/Prefabs/StreetLamp.prefab", isOutermost: true })
    expect(unityOf(terrainEntity).terrain).toMatchObject({ widthM: 500, heightM: 30, heightmapResolution: 513, treeInstanceCount: 2, treePrototypes: [{ prefabGuid: "guid-tree" }] })
    // 落地的是「有位置的 Unity 对象 + 元数据」，不是伪造的可渲染视觉或灯。
    for (const entity of [camera, prefab, terrainEntity]) {
      expect(entity.components.visual).toBeUndefined()
      expect(entity.components.light).toBeUndefined()
      expect(entity.resources).toEqual([])
    }
    expect(report.losses.some(loss => loss.includes("TERRAIN_MESH_NOT_TRANSFERRED"))).toBe(true)
    expect(unityOf(terrainEntity).losses).toContain("TERRAIN_MESH_NOT_TRANSFERRED")
    // 相机不带 Unity 的宽高比/深度纹理等未交换字段的假值：文档里有什么就是什么。
    expect(unityOf(camera).camera).not.toHaveProperty("aspect")
  })

  test("网格与灯在同一对象上：保留网格、灯记为损失（产品一次只渲染其中之一，不静默丢一个）", async () => {
    const document = unityDocument()
    document.nodes[0]!.light = lightRecord({ type: "Spot", intensity: 3 })
    const { exchange } = await sceneWith(document)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const site = entityOf(snapshot.entities, "entity_unity_site")
    expect(site.components.light).toBeUndefined()
    expect(unityOf(site).losses.join("\n")).toMatch(/LIGHT_ON_MESH_NODE_NOT_MAPPED/)
    expect(report.losses.join("\n")).toMatch(/LIGHT_ON_MESH_NODE_NOT_MAPPED/)
  })

  test("JsonUtility 的空记录（每个节点都带的空 light/camera/terrain/prefab）不当成真有：不出假损失、不回写垃圾", async () => {
    const document = withUnityJsonDefaults(unityDocument())
    const { exchange, unity } = await sceneWith(document)
    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const site = entityOf(snapshot.entities, "entity_unity_site")
    // 场地有网格没有灯：空记录不能变成"同时有网格与灯"，也不能冒充相机/地形/预制体。
    expect(unityOf(site).light).toBeUndefined()
    expect(unityOf(site).camera).toBeUndefined()
    expect(unityOf(site).terrain).toBeUndefined()
    expect(unityOf(site).prefab).toBeUndefined()
    expect(report.losses.join("\n")).not.toMatch(/LIGHT_ON_MESH_NODE_NOT_MAPPED/)
    // 灯杆同样只剩变换；真的那盏灯（顶灯）照样在。
    expect(unityOf(entityOf(snapshot.entities, "entity_unity_pole")).light).toBeUndefined()
    expect(lightOf(entityOf(snapshot.entities, "entity_unity_lamp")).kind).toBe("point")

    await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })
    const written = unity.imported.at(-1)!
    // 写回文档里这些字段是显式 null（不是空实例）：Unity 侧因此不会再为每个对象建 TerrainData/Camera。
    for (const node of written.nodes) {
      expect(node.camera ?? null).toBeNull()
      expect(node.terrain ?? null).toBeNull()
      expect(node.prefab ?? null).toBeNull()
      if (node.entityId !== "entity_unity_lamp") expect(node.light ?? null).toBeNull()
    }
    expect(written.nodes.find(node => node.entityId === "entity_unity_lamp")!.light!.type).toBe("Point")
  })
})

describe("ENV-27 产品 → Unity（真文档产出）", () => {
  test("产品场景写进 Unity：非轴对齐旋转与父子变换对称还原，网格 LPMESH 逐点还原且绕序复原", async () => {
    const document = unityDocument()
    const { exchange, unity } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })

    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })

    expect(unity.imported.length).toBe(1)
    const written = unity.imported[0]!
    expect(result.nodes).toBe(3)
    expect(written.kind).toBe("lyapunov.unity-scene")
    expect(written.version).toBe(1)
    expect(written.transformSpace).toBe("unity-left-handed-y-up-meters")
    // 文档里只有 Unity 原生空间的值：把它们经 M 折回产品空间，必须与产品场景的世界矩阵一致；
    // 同时逐节点比较局部变换与原始 Unity 文档（对称往返）。
    const unityById = new Map(document.nodes.map(node => [node.entityId, node]))
    expect(written.nodes.map(node => node.entityId).sort()).toEqual([...unityById.keys()].sort())
    expect(written.nodes.map(node => [node.entityId, node.parentIndex])).toEqual([["entity_unity_site", -1], ["entity_unity_pole", 0], ["entity_unity_lamp", 1]])
    /** 文档节点（Unity 原生空间）→ 它在产品空间的局部变换；父链折出后就是要对账的世界矩阵。 */
    const asProductLocal = (node: UnityNode): Matrix4 => productWorldFromUnityTransform({ position: node.position as [number, number, number], quaternion: node.rotation as [number, number, number, number], scale: node.scale as [number, number, number] })
    const snapshot = await operations.inspect("scene_acc")
    let previousWorld: Matrix4 | undefined
    for (const node of written.nodes) {
      const original = unityById.get(node.entityId)!
      expect(node.name).toBe(original.name)
      expect(node.globalId).toBe(original.globalId)
      expectTransformClose({ position: node.position, quaternion: node.rotation, scale: node.scale }, { position: original.position, quaternion: original.rotation, scale: original.scale }, 8)
      // 与产品场景里同一实体的世界变换对账（走 M⁻¹ 共轭，不是抄文档原值）。
      const world = node.parentIndex >= 0 ? asProductLocal(node).premultiply(previousWorld!) : asProductLocal(node)
      const expectedNode = worldMatrix(snapshot, node.entityId)
      for (let index = 0; index < 16; index++) expect(world.elements[index]!).toBeCloseTo(expectedNode.elements[index]!, 7)
      previousWorld = world
    }
    // 网格：LPMESH 解码回来必须是 Unity 空间的原几何（顶点 M 一次、绕序翻两次 ⇒ 复原）。
    const meshNode = written.nodes.find(node => node.mesh)!
    const bytes = new Uint8Array(await readFile(join(unityProject, meshNode.mesh!.file)))
    const geometry = decodeLpmesh(bytes)
    expect(bytes.length).toBe(meshNode.mesh!.fileBytes)
    for (let index = 0; index < unityMesh.positions.length; index++) expect(geometry.positions[index]!).toBeCloseTo(unityMesh.positions[index]!, 6)
    for (let index = 0; index < unityMesh.normals.length; index++) expect(geometry.normals![index]!).toBeCloseTo(unityMesh.normals[index]!, 6)
    expect([...geometry.indices]).toEqual(unityMesh.indices)
    expect(meshNode.mesh!.vertexCount).toBe(4)
    // Unity 来源的对象保留原资产引用与材质（同工程往返不多出一份网格副本）。
    expect(meshNode.mesh!.assetPath).toBe("Assets/LyapunovEnvironmentAcceptance/Meshes/site.asset")
    expect(meshNode.materials).toMatchObject([{ assetPath: "Assets/Materials/Steel.mat", baseColor: [0.2, 0.6, 0.9, 1], metallic: 0.3, smoothness: 0.6 }])
    // 灯：Unity 原生记录还原（强度按 Viewer 的比例除回去），阴影/反弹不假装还原。
    const lightNode = written.nodes.find(node => node.light)!
    expect(lightNode.light).toMatchObject({ type: "Point", intensity: 8, color: [1, 0.5, 0.25, 1] })
    // Unity 来源的灯：产品组件表达不了的字段（阴影/range/反弹/enabled）从保留的原记录补回，往返后不丢也不报假损失。
    expect(lightNode.light).toMatchObject({ shadows: "Soft", range: 30, bounceIntensity: 1, enabled: true })
    expect((result.losses as string[]).join("\n")).not.toMatch(/LIGHT_SHADOWS_NOT_TRANSFERRED|LIGHT_RANGE_NOT_TRANSFERRED/)
  })

  test("产品里直接导入的 GLB → Unity：几何与材质真落地（无需 Unity 来源元数据）", async () => {
    const glb = glbForUnityMesh({ name: "玻璃", pbrMetallicRoughness: { baseColorFactor: [0.1, 0.9, 0.4, 1], metallicFactor: 0.8, roughnessFactor: 0.25 } })
    const path = join(base, "imported.glb")
    await writeFile(path, glb)
    await operations.create({ sceneId: "scene_glb" })
    await operations.import({ path, sceneId: "scene_glb", entityId: "entity_imported", name: "导入的树", resourceId: "res_imported", physicalize: false })
    const unity = fakeUnity({ document: unityDocument() })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 2_000, pollMs: 5 })

    await exchange.writeScene({ sceneId: "scene_glb", mode: "new", assetFolder: "Assets/LyapunovEnvironmentAcceptance/Imported" })

    const written = unity.imported[0]!
    // 组根与源坐标转换不建对象；网格节点自己建对象并带网格。
    expect(written.nodes.map(node => node.entityId)).toEqual(["entity_imported:node:0"])
    const node = written.nodes[0]!
    expect(node.mesh).toMatchObject({ vertexCount: 4, triangleCount: 2, fileSpace: "unity-left-handed-y-up-meters-raw" })
    const geometry = decodeLpmesh(new Uint8Array(await readFile(join(unityProject, node.mesh!.file))))
    for (let index = 0; index < unityMesh.positions.length; index++) expect(geometry.positions[index]!).toBeCloseTo(unityMesh.positions[index]!, 6)
    expect([...geometry.indices]).toEqual(unityMesh.indices)
    // 材质按 glTF 的 baseColor/metallic/roughness 重建，贴图不复制（有损失写明）。
    expect(node.materials).toMatchObject([{ name: "玻璃", shader: "Standard", baseColor: [0.1, 0.9, 0.4, 1], metallic: 0.8, smoothness: 0.75, textures: [] }])
    expect(node.losses.join("\n")).toMatch(/MATERIAL_FROM_GLTF/)
    // 无 Unity 来源元数据时没有额外损失；节点损失按"节点名: 损失"汇总进文档总表，
    // 只有"产品里没有环境组件"这一条是文档级说明（Unity 沿用自身 RenderSettings）。
    expect(written.losses).toEqual([
      ...node.losses.map(loss => `${node.name}: ${loss}`),
      "ENVIRONMENT_ABSENT_IN_PRODUCT: 产品场景没有 components.environment，写回时 Unity 侧沿用自身 RenderSettings（本次不交换环境）",
    ])
    expect(unity.imported[0]!.losses.join("\n")).not.toMatch(/UNITY_ORIGIN_MISSING|MESH_RESOURCE_MISSING|MESH_DECODE_FAILED/)
  })

  test("镜像世界矩阵（负行列式）：如实写损失并在 Unity 文档里以负缩放表达，不静默变成旋转", async () => {
    const document = unityDocument()
    document.nodes[1]!.scale = [-1, 1, 1]
    const { exchange, unity } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })

    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "current" })

    const written = unity.imported[0]!
    const pole = written.nodes.find(node => node.entityId === "entity_unity_pole")!
    expect(pole.losses.join("\n")).toMatch(/MIRRORED_WORLD_TRANSFORM/)
    expect((result.losses as string[]).some(loss => loss.includes("MIRRORED_WORLD_TRANSFORM: 世界矩阵行列式为负（镜像），Unity 侧以负缩放表达"))).toBe(true)
    // 负缩放确实表达出来了：世界矩阵仍是镜像（det<0），位置与父子关系不变。
    const snapshot = await operations.inspect("scene_acc")
    const poleWorld = productWorldFromUnityTransform({ position: pole.position as [number, number, number], quaternion: pole.rotation as [number, number, number, number], scale: pole.scale as [number, number, number] })
      .premultiply(productWorldFromUnityTransform(unityTransformFromProductWorld(worldMatrix(snapshot, "entity_unity_site")).transform))
    expect(poleWorld.determinant()).toBeLessThan(0)
    for (let index = 0; index < 16; index++) expect(poleWorld.elements[index]!).toBeCloseTo(worldMatrix(snapshot, "entity_unity_pole").elements[index]!, 7)
  })

  test("产品灯 → Unity 灯：四种灯型映射、能量按 Viewer 比例还原、rangeM 与阴影如实记为未交换", async () => {
    const lossSet: string[] = []
    const forward = [0.2, 0.4, -0.9] as [number, number, number]
    for (const [kind, unityType] of [["sun", "Directional"], ["area", "Rectangle"], ["spot", "Spot"], ["point", "Point"]] as const) {
      const component = { kind, color: [0.9, 0.8, 0.7], energy: 200, direction: forward, ...(kind === "spot" ? { spotSizeRad: Math.PI / 5 } : {}), ...(kind === "area" ? { sizeM: 4 } : {}), ...(kind === "point" || kind === "spot" ? { rangeM: 25 } : {}) }
      const back = productLightToUnity(component as Record<string, unknown>, forward)
      expect(back.light.type).toBe(unityType)
      expect(back.light.intensity).toBeCloseTo(200 / LIGHT_ENERGY_SCALE[kind], 12)
      if (kind === "spot") expect(back.light.spotAngleDeg).toBeCloseTo(36, 9)
      if (kind === "area") expect(back.light.areaSize).toEqual([4, 4])
      if (kind === "point" || kind === "spot") expect(back.losses.join("\n")).toMatch(/LIGHT_RANGE_NOT_TRANSFERRED/)
    }
    // 反方向：Unity 强度 × 比例 = 产品 energy；太阳灯方向取实体的 Unity 世界前向经 M。
    const unityLight = lightRecord({ type: "Directional", intensity: 5, shadows: "Hard", bounceIntensity: 3 })
    const product = unityLightToProduct(unityLight, [0, -1, 0])
    expect(product.component).toMatchObject({ kind: "sun", energy: 5, direction: [0, 0, -1] })
    expect(product.losses.join("\n")).toMatch(/LIGHT_SHADOWS_NOT_TRANSFERRED/)
    expect(product.losses.join("\n")).toMatch(/LIGHT_BOUNCE_NOT_TRANSFERRED/)
    // 超上限：如实报告渲染会暗于 Unity（钳制在 Viewer 侧，这里只报告不悄悄截断）。
    const tooStrong = unityLightToProduct(lightRecord({ type: "Point", intensity: 99 }), [0, 0, 1])
    expect(tooStrong.component.energy).toBe(99 * LIGHT_ENERGY_SCALE.point)
    expect(tooStrong.losses.join("\n")).toMatch(/LIGHT_ENERGY_CLAMPED/)
    // 非基础灯型（Unity Rectangle/Disc 之外的矩形/圆盘/其它）：按面光源映射并写明。
    expect(unityLightToProduct(lightRecord({ type: "Pyramid" }), [0, 0, 1]).losses.join("\n")).toMatch(/LIGHT_TYPE_MAPPED/)
    expect(lossSet).toEqual([])
    // 位置/方向是同一个函数：东向 (1,0,0) 不变，Unity 上 (0,1,0) 在产品里是 (0,0,1)。
    expect(swapUpAxis([1, 0, 0])).toEqual([1, 0, 0])
    expect(swapUpAxis([0, 1, 0])).toEqual([0, 0, 1])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 109 地形与植被：交付闭包（高度/层混合/植被几何真的进产品资源库）与写回折叠
// ────────────────────────────────────────────────────────────────────────────

const TERRAIN_MESH_FILE = join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0003.glb")
const TERRAIN_TEXTURE_FILE = join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0003-blend.png")
const PROTOTYPE_MESH_FILE = join(UNITY_EXCHANGE_SCRATCH, "vegetation", "prototype-00.glb")
/** 3×3 高度格点（Unity 归一化高度，行主序）→ 交付网格顶点（产品空间：glTF [u·sizeX, v·sizeZ, h·sizeY]）。 */
const terrainHeights = [0, 0.25, 0, 0.25, 0.5, 0.25, 0, 0.25, 0]
const terrainGridGlb = (): Buffer => glbMesh({
  positions: terrainHeights.flatMap((height, index) => [(index % 3) * 20, Math.floor(index / 3) * 20, height * 6]),
  normals: terrainHeights.flatMap(() => [0, 0, 1]),
  uvs: terrainHeights.flatMap((_, index) => [(index % 3) / 2, Math.floor(index / 3) / 2]),
  indices: [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8],
})
/** 一棵树的原型几何（prefab 局部空间：树干+树冠一块面片；一份几何给 N 棵树共用）。 */
const prototypeGlb = (): Buffer => glbMesh({
  positions: [0, 0, 0, 0.4, 0, 0, 0.4, 2.5, 0, 0, 2.5, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material: { name: "阔叶", pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.2, 1], metallicFactor: 0, roughnessFactor: 1 } },
})

/** Unity 侧的地形读数（C# `DescribeTerrain` + `ExportTerrain` 的形状）：高度只由交付网格携带。 */
function terrainRecord(overrides: Partial<UnityTerrainRecord> = {}): UnityTerrainRecord {
  return {
    widthM: 40, heightM: 6, lengthM: 40, heightmapResolution: 3, minHeight: 0, maxHeight: 6,
    heightsFile: join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0003.f32"), heightsBytes: 3 * 3 * 4,
    alphamapLayers: 2, treeInstanceCount: 2, treesFile: join(UNITY_EXCHANGE_SCRATCH, "terrain", "terrain-0003-trees.json"),
    treePrototypes: [{
      prefabPath: "Assets/LyapunovEnvironmentAcceptance/terrain-109/Vegetation/Broadleaf.prefab", prefabGuid: "guid-broadleaf",
      meshFile: PROTOTYPE_MESH_FILE, meshBytes: prototypeGlb().length, vertexCount: 4, triangleCount: 2, subMeshCount: 1, materialCount: 1,
    }],
    meshResolution: 3, meshFile: TERRAIN_MESH_FILE, meshFileSpace: "product-right-handed-z-up-meters",
    meshBytes: terrainGridGlb().length, meshVertexCount: 9, meshTriangleCount: 8, holeCellCount: 0,
    textureFile: TERRAIN_TEXTURE_FILE, textureDigest: "a1b2c3d4e5f60718", textureWidth: 256, textureHeight: 256,
    instances: [
      { position: [0.25, 0.5, 0.25], widthScale: 1.5, heightScale: 2, rotationRad: Math.PI / 6, color: [1, 1, 1, 1], prototypeIndex: 0 },
      { position: [0.75, 0.5, 0.6], widthScale: 0.8, heightScale: 0.9, rotationRad: -Math.PI / 3, color: [1, 0.5, 1, 1], prototypeIndex: 0 },
    ],
    treeInstancesAuthoritative: true,
    ...overrides,
  }
}

/** 地形带旋转/位移（树写回必须按"地形对象自己的局部帧"反算，不是世界轴）。 */
function terrainDocument(overrides: Partial<UnityTerrainRecord> = {}): UnitySceneDocument {
  const document = unityDocument()
  const terrain = terrainRecord(overrides)
  document.nodes.push({
    index: 3, parentIndex: -1, name: "地形", entityId: "entity_unity_terrain", globalId: `GlobalObjectId_V1-2-${document.sceneGuid}-7-0`,
    position: [2, 0.5, -1], rotation: axisAngle([0.2, 1, 0.35], 27), scale: [1, 1, 1], active: true, tag: "Untagged", layer: 0,
    componentTypes: ["Transform", "Terrain", "TerrainCollider"], losses: [],
    mesh: {
      name: "地形网格", primitive: "", assetPath: "", assetGuid: "", vertexCount: 9, triangleCount: 8, subMeshCount: 1, uvCount: 9,
      contentDigest: "", boundsCenter: [20, 20, 3], boundsSize: [40, 40, 6], file: TERRAIN_MESH_FILE, fileSpace: "product-right-handed-z-up-meters-raw", fileBytes: terrainGridGlb().length,
    },
    materials: [{ name: "Terrain/LayerBlend", assetPath: "", assetGuid: "", shader: "Terrain/LayerBlend(baked)", baseColor: [1, 1, 1, 1], metallic: 0, smoothness: 0.5, textures: [], textureFiles: [] }],
    terrain,
  })
  return document
}

/** 交付件落盘（地形网格 + 原型几何 GLB 真字节）：产品侧 import 的是这些文件。 */
async function writeDeliveryFiles(prototype: Buffer | null = prototypeGlb()): Promise<void> {
  await writeUnityFile(TERRAIN_MESH_FILE, terrainGridGlb())
  await writeUnityFile(TERRAIN_TEXTURE_FILE, Buffer.from(pngBytes(3)))
  if (prototype) await writeUnityFile(PROTOTYPE_MESH_FILE, prototype)
}

const terrainEntityOf = (entities: Entity[]) => entityOf(entities, "entity_unity_terrain")

describe("109 地形与植被：读入时的交付闭包（可渲染网格 + 共享植被几何）", () => {
  test("地形网格与贴图真的进产品资源库；两棵树共用**一份**原型几何（不是逐树复制素材）", async () => {
    const document = terrainDocument()
    const { exchange } = await sceneWith(document)
    await writeDeliveryFiles()

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const terrain = terrainEntityOf(snapshot.entities)
    // 地形本体就是既有资源库里的一个网格资源（可渲染），不是"只有元数据"。
    expect(unityOf(terrain).terrain!.meshResolution).toBe(3)
    expect(terrain.resources).toHaveLength(1)
    const geometry = entityOf(snapshot.entities, "entity_unity_terrain:node:0")
    expect((geometry.components.visual as { kind: string }).kind).toBe("mesh")
    expect(geometry.resources[0]!.resourceId).toBe(terrain.resources[0]!.resourceId)
    // 资源登记数 = 场地网格 + 地形网格 + **一份**被两棵树共用的原型几何（原型的 prefab 连接仍在元数据里）。
    expect(report.resources).toBe(3)

    const trees = snapshot.entities.filter(entity => (entity.components.unity as UnityOriginMetadata | undefined)?.terrainTree)
    expect(trees.map(entity => entity.entityId).sort()).toEqual(["entity_unity_terrain:tree:0", "entity_unity_terrain:tree:1"])
    const prototypes = new Set(trees.map(entity => entity.resources[0]?.resourceId))
    expect(prototypes.size).toBe(1)
    expect([...prototypes][0]).toBeDefined()
    for (const tree of trees) {
      expect(tree.parentId).toBe("entity_unity_terrain")
      expect((tree.components.visual as { kind: string }).kind).toBe("group")
      expect(unityOf(tree).terrainTree!.prototypePrefabGuid).toBe("guid-broadleaf")
      // 树的几何也是真的（共享 GLB 展开出来的网格节点），不是空壳。
      const leaf = entityOf(snapshot.entities, `${tree.entityId}:node:0`)
      expect((leaf.components.visual as { kind: string }).kind).toBe("mesh")
    }

    // 位置/朝向/缩放按 Unity 的 TreeInstance 语义换算（独立参考实现：轴交换 + 旋转共轭）。
    const first = unityOf(entityOf(snapshot.entities, "entity_unity_terrain:tree:0")).terrainTree!
    expectTransformClose(entityOf(snapshot.entities, "entity_unity_terrain:tree:0").transform,
      referenceTransform(treeInstanceTransform(terrainRecord().instances![0]!, terrainRecord())), 6)
    expect(first.position).toEqual([0.25, 0.5, 0.25])
    expect(report.losses.join("\n")).toMatch(/TERRAIN_VEGETATION_DELIVERED: 地形 2 棵树共用 1 个原型几何/)
    // 逐树 color 只存在于元数据（产品按原型原色渲染）：第二棵带非白 tint，必须点名。
    expect(report.losses.join("\n")).toMatch(/TERRAIN_TREE_COLOR_NOT_APPLIED: 地形 里 1\/2 棵树/)

    // 再读一次是刷新同一批实体：身份稳定，不重复新增（树也是）。
    const before = snapshot.entities.length
    const again = await exchange.readScene({ sceneId: "scene_acc" })
    expect((await operations.inspect("scene_acc")).entities.length).toBe(before)
    expect(again.sync?.added).toEqual([])
  })

  test("原型几何没交付出来：树仍以**数据实体**落地（位置照旧、写回不丢），并点名损失", async () => {
    const document = terrainDocument({ treePrototypes: [{ prefabPath: "Assets/Prefabs/Broadleaf.prefab", prefabGuid: "guid-broadleaf", meshError: "PREFAB_MESH_UNREADABLE" }] })
    const { exchange } = await sceneWith(document)
    await writeDeliveryFiles(null)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const tree = entityOf(snapshot.entities, "entity_unity_terrain:tree:1")
    expect(tree.resources).toEqual([])
    expect((tree.components.visual as { kind: string } | undefined)?.kind).toBeUndefined()
    expectTransformClose(tree.transform, referenceTransform(treeInstanceTransform(terrainRecord().instances![1]!, terrainRecord())), 6)
    // 只有场地网格 + 地形网格这两份资源：没有原型几何可交付时不硬造。
    expect(report.resources).toBe(2)
    expect(report.losses.join("\n")).toMatch(/TERRAIN_TREE_GEOMETRY_MISSING: 地形 原型 #0/)
    expect(report.losses.join("\n")).toMatch(/TERRAIN_TREE_DATA_ONLY: 地形 里 2\/2 棵树/)
  })

  test("原型几何后来没了：树实体变回数据实体，旧几何子节点按精确 id 删掉（不留幽灵网格）", async () => {
    const document = terrainDocument()
    const { exchange } = await sceneWith(document)
    await writeDeliveryFiles()

    await exchange.readScene({ sceneId: "scene_acc" })
    expect((await operations.inspect("scene_acc")).entities.some(entity => entity.entityId === "entity_unity_terrain:tree:0:node:0")).toBe(true)

    document.nodes[3]!.terrain = terrainRecord({ treePrototypes: [{ prefabPath: "Assets/Prefabs/Broadleaf.prefab", prefabGuid: "guid-broadleaf", meshError: "PREFAB_MESH_UNREADABLE" }] })
    const second = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    for (const gone of ["entity_unity_terrain:tree:0:node:0", "entity_unity_terrain:tree:0:source"]) {
      expect(snapshot.entities.some(entity => entity.entityId === gone)).toBe(false)
    }
    // 树实体自己还在（数据实体），只有展开出来的几何没了。
    expect(entityOf(snapshot.entities, "entity_unity_terrain:tree:0").resources).toEqual([])
    expect(second.sync?.removed.sort()).toEqual(["entity_unity_terrain:tree:0:node:0", "entity_unity_terrain:tree:0:source", "entity_unity_terrain:tree:1:node:0", "entity_unity_terrain:tree:1:source"])
    expect(second.sync?.framesKept).toEqual([])
  })

  test("树实体不是 Unity 场景对象：折回地形的 instances（原样往返逐值一致），文档里不多出树节点", async () => {
    const document = terrainDocument()
    const { exchange, unity } = await sceneWith(document)
    await writeDeliveryFiles()
    await exchange.readScene({ sceneId: "scene_acc" })

    await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })

    const written = unity.imported.at(-1)!
    expect(written.nodes.some(node => node.name.includes("·树"))).toBe(false)
    // 节点数与原文档一致：场地/灯杆/顶灯/地形。
    expect(written.nodes.map(node => node.entityId)).toEqual(["entity_unity_site", "entity_unity_pole", "entity_unity_lamp", "entity_unity_terrain"])
    const terrain = written.nodes[3]!.terrain!
    expect(terrain.treeInstancesAuthoritative).toBe(true)
    expect(terrain.treeInstanceCount).toBe(2)
    const source = terrainRecord().instances!
    for (const [index, instance] of terrain.instances!.entries()) {
      for (const axis of [0, 1, 2]) expect(instance.position[axis]!).toBeCloseTo(source[index]!.position[axis]!, 6)
      expect(instance.widthScale).toBeCloseTo(source[index]!.widthScale, 6)
      expect(instance.heightScale).toBeCloseTo(source[index]!.heightScale, 6)
      expect(instance.rotationRad).toBeCloseTo(source[index]!.rotationRad, 6)
      expect(instance.prototypeIndex).toBe(0)
      expect(instance.color).toEqual(source[index]!.color)
    }
  })

  test("产品里的局部修改写回：把树抬高 1 米、水平放大、再删掉另一棵 —— 高度/缩放/数量都跟着走", async () => {
    const document = terrainDocument()
    const { exchange, unity } = await sceneWith(document)
    await writeDeliveryFiles()
    await exchange.readScene({ sceneId: "scene_acc" })

    const tree = entityOf((await operations.inspect("scene_acc")).entities, "entity_unity_terrain:tree:0")
    await operations.scene.commit({
      sceneId: "scene_acc", expectedRevision: (await operations.inspect("scene_acc")).revision,
      patch: [
        // 地形局部抬高 1 米 = 该实体局部 +Z 1 米（轴交换把 Unity 的 y 映到产品的 z，所以产品的 z 才是树高方向）；
        // 水平两轴（产品 x/y）放大到 2、高度（产品 z）压到 1.5。
        { op: "update", entityId: "entity_unity_terrain:tree:0", changes: { transform: { ...tree.transform, position: [tree.transform.position[0]!, tree.transform.position[1]!, tree.transform.position[2]! + 1], scale: [2, 2, 1.5] } } },
        { op: "remove", entityId: "entity_unity_terrain:tree:1", cascade: true },
      ],
    } as never)

    await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })

    const terrain = unity.imported.at(-1)!.nodes[3]!.terrain!
    expect(terrain.instances).toHaveLength(1)
    expect(terrain.treeInstanceCount).toBe(1)
    expect(terrain.treeInstancesAuthoritative).toBe(true)
    const moved = terrain.instances![0]!
    expect(moved.position[1]).toBeCloseTo(0.5 + 1 / 6, 6)     // 地形局部 1 米 = 归一化 1/heightM
    expect(moved.position[0]).toBeCloseTo(0.25, 6)
    expect(moved.position[2]).toBeCloseTo(0.25, 6)
    expect(moved.widthScale).toBeCloseTo(2, 6)
    expect(moved.heightScale).toBeCloseTo(1.5, 6)
    expect(moved.rotationRad).toBeCloseTo(Math.PI / 6, 6)
    // 被删的那棵真的没了（权威清单），且不是靠"没有实体所以不动"蒙对的。
    expect(terrain.instances!.every(item => Math.abs(item.position[0]! - 0.75) > 1e-6)).toBe(true)
  })

  test("文档没带权威植被清单（旧版/手写）：不静默删 Unity 的树，写回保持原样并点名", async () => {
    const document = terrainDocument({ instances: undefined, treeInstancesAuthoritative: false })
    const { exchange, unity } = await sceneWith(document)
    await writeDeliveryFiles()

    const report = await exchange.readScene({ sceneId: "scene_acc" })
    expect((await operations.inspect("scene_acc")).entities.some(entity => (entity.components.unity as UnityOriginMetadata | undefined)?.terrainTree)).toBe(false)
    expect(report.losses.join("\n")).toMatch(/TERRAIN_TREE_LIST_MISSING: 地形 文档里有 2 棵树/)

    await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })

    const written = unity.imported.at(-1)!
    const terrain = written.nodes[3]!.terrain!
    expect(terrain.treeInstancesAuthoritative).not.toBe(true)
    expect(terrain.instances ?? null).toBeNull()
    expect(terrain.treeInstanceCount).toBe(2)
    expect(terrain.treePrototypes).toHaveLength(1)
    expect(written.nodes[3]!.losses.join("\n")).toMatch(/TERRAIN_TREE_ENTITIES_MISSING/)
  })
})

describe("ENV-27 传输协议与失败路径", () => {
  test("状态查询：只读、工程根经原生资源发现后缓存、暂存目录落在工程内、不匹配的版本被拒绝", async () => {
    const unity = fakeUnity({ document: unityDocument() })
    // 不给 projectPath：经由原生 MCP 资源 mcpforunity://project/info 发现（形状与真机一致）。
    const exchange = new UnitySceneExchange(operations, unity.port, { timeoutMs: 1_000, pollMs: 5 })
    expect(() => exchange.scratchDirectory).toThrow(/UNITY_PROJECT_UNKNOWN/)

    const status = await exchange.status()

    expect(status.exchange).toEqual({ menu: UNITY_EXCHANGE_MENU, projectPath: unityProject, scratch: join(unityProject, UNITY_EXCHANGE_SCRATCH), instance: "UnityMCPStarter@114e4a37" })
    expect(unity.resources).toEqual([UNITY_PROJECT_INFO_URI, UNITY_INSTANCES_URI, UNITY_PROJECT_INFO_URI])
    // 执行前先用原生 set_active_instance 显式绑到工程匹配的那个实例，然后才触发菜单项。
    expect(unity.calls.map(call => call.tool)).toEqual([UNITY_SET_ACTIVE_INSTANCE_TOOL, "execute_menu_item"])
    expect(unity.bindings).toEqual(["UnityMCPStarter@114e4a37"])
    expect((status.binding as Record<string, unknown>).instance).toBe("UnityMCPStarter@114e4a37")
    // 工程根来自回执：换一个工程根时不会继续用上一次的缓存。
    expect(projectRootOf(projectInfoResource("/elsewhere/Project"))).toBe("/elsewhere/Project")
    expect(projectRootOf({ data: { projectRoot: "/p" } })).toBe("/p")
    expect(projectRootOf({ contents: [{ text: "not json" }] })).toBeUndefined()
    expect(projectRootOf(undefined)).toBeUndefined()
    // 资源读不到（连接里没有 project/info）时必须明确报错，不能凭空猜路径。
    const blind = fakeUnity({ document: unityDocument(), projectRoot: null })
    const noDiscovery = new UnitySceneExchange(operations, blind.port, { timeoutMs: 100, pollMs: 5 })
    await expect(noDiscovery.status()).rejects.toThrow(/UNITY_PROJECT_UNKNOWN/)
    expect(exchange.scratchDirectory).toBe(join(unityProject, UNITY_EXCHANGE_SCRATCH))
    // 文档合同不符（kind/version 不同）必须拒绝，不按"大概能读"解析。
    const mismatched = fakeUnity({ document: { ...unityDocument(), version: 2 } })
    const second = new UnitySceneExchange(operations, mismatched.port, { projectPath: unityProject, timeoutMs: 1_000, pollMs: 5 })
    await operations.create({ sceneId: "scene_mismatch" })
    await expect(second.readScene({ sceneId: "scene_mismatch" })).rejects.toThrow(/UNITY_DOCUMENT_MISMATCH/)
    expect((await operations.inspect("scene_mismatch")).entities).toEqual([])
  })

  test("产品口每次调用一个新实例：readScene/writeScene 自己经原生资源绑定工程根（不依赖上一次 status 的缓存）", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_bindless" })
    // 真机产品口就是这样：每调用现建一个 UnitySceneExchange，只有原生 port，没有 projectPath 缓存。
    const unity = fakeUnity({ document })
    const exchange = new UnitySceneExchange(operations, unity.port, { timeoutMs: 2_000, pollMs: 5 })

    const report = await exchange.readScene({ sceneId: "scene_bindless" })

    expect(report.entities).toBe(5)
    // 绑定发生在**读暂存目录之前**：第一次原生调用就是资源发现（绑定晚了会先撞 UNITY_PROJECT_UNKNOWN）。
    expect(unity.resources[0]).toBe(UNITY_PROJECT_INFO_URI)
    expect(unity.calls.map(call => call.tool)).toEqual([UNITY_SET_ACTIVE_INSTANCE_TOOL, "execute_menu_item"])

    // 写回同理：交付文档要落进交换暂存目录（也在工程根下）。
    const written = await exchange.writeScene({ sceneId: "scene_bindless", dryRun: true })
    expect(String(written.documentPath)).toContain(UNITY_EXCHANGE_SCRATCH)
    expect((await operations.inspect("scene_bindless")).entities.length).toBe(5)
  })

  test("菜单调用超时但回执到达：按异步派发语义算成功（重的导入会在主线程上跑过工具超时）", async () => {
    await writeUnityMeshFile(unityDocument(), glbForUnityMesh())
    await operations.create({ sceneId: "scene_timeout" })
    const timeout = fakeUnity({ document: unityDocument(), mode: "menu-timeout" })
    const exchange = new UnitySceneExchange(operations, timeout.port, { projectPath: unityProject, timeoutMs: 2_000, pollMs: 5 })
    const report = await exchange.readScene({ sceneId: "scene_timeout" })
    // 3 个对象 + 网格展开出来的"源坐标转换 + 几何节点"2 个。
    expect(report.entities).toBe(5)
    expect((await operations.inspect("scene_timeout")).entities.length).toBe(5)
  })

  test("失败路径全部明确报错：菜单调用失败、回执永不到达、Unity 侧 ok=false，且都不写产品场景", async () => {
    await writeUnityMeshFile(unityDocument(), glbForUnityMesh())
    await operations.create({ sceneId: "scene_fail" })
    const failing = fakeUnity({ document: unityDocument(), mode: "menu-fail" })
    const menuFailure = new UnitySceneExchange(operations, failing.port, { projectPath: unityProject, timeoutMs: 100, pollMs: 5 })
    await expect(menuFailure.readScene({ sceneId: "scene_fail" })).rejects.toThrow(/UNITY_MENU_CALL_FAILED/)

    const silent = fakeUnity({ document: unityDocument(), mode: "silent" })
    const noReceipt = new UnitySceneExchange(operations, silent.port, { projectPath: unityProject, timeoutMs: 60, pollMs: 5 })
    await expect(noReceipt.readScene({ sceneId: "scene_fail" })).rejects.toThrow(/UNITY_RESULT_TIMEOUT/)

    const notOk = fakeUnity({ document: unityDocument(), mode: "result-not-ok" })
    const rejected = new UnitySceneExchange(operations, notOk.port, { projectPath: unityProject, timeoutMs: 200, pollMs: 5 })
    await expect(rejected.readScene({ sceneId: "scene_fail" })).rejects.toThrow(/UNITY_EXPORT_FAILED: EXPORT_FAILED_IN_UNITY/)

    expect((await operations.inspect("scene_fail")).entities).toEqual([])
    expect((await operations.inspect("scene_fail")).revision).toBe(0)
  })
})

describe("ENV-27 薄接线（只验证注册与真实执行一次，不代表模型行为）", () => {
  test("registerUnityExchangeTools 注册三个工具：schema 严格、execute 真的走通一次 status", async () => {
    const registered: Array<{ name: string; parameters: Record<string, unknown>; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    const ctx = { tools: { register: (tool: unknown) => { registered.push(tool as never) } } } as never
    const unity = fakeUnity({ document: unityDocument() })
    const exchange = registerUnityExchangeTools(ctx, { scene: operations, call: unity.port.call, projectPath: unityProject, timeoutMs: 1_000 })

    expect(registered.map(tool => tool.name)).toEqual(["unity_scene_status", "unity_scene_read", "unity_scene_write"])
    // 参数按 DSH 工具约定包在 input 里（defineTool 把 ParameterSchemaSpec 展开成外层对象）。
    expect(registered[0]!.parameters).toMatchObject({ type: "object", required: ["input"], properties: { input: { type: "object", additionalProperties: false, properties: {} } } })
    expect((registered[2]!.parameters as { properties: { input: { properties: { mode: { enum: string[] } } } } }).properties.input.properties.mode.enum).toEqual(["current", "new", "additive"])
    // 参数多余字段在派发前就被 schema 拒绝。
    await expect(registered[0]!.execute({ input: { nope: 1 } }, {})).rejects.toThrow(/additional|nope/i)

    const status = await registered[0]!.execute({ input: {} }, {}) as { exchange: { projectPath: string } }

    expect(status.exchange.projectPath).toBe(unityProject)
    // portFor 路径下没有注册期实例（场景按调用会话现取）；静态 call 口这里必然有实例。
    expect(exchange!.scratchDirectory).toBe(join(unityProject, UNITY_EXCHANGE_SCRATCH))
    // 网格写出与读取都走注入的同一个原生 MCP 口（不新开连接）。
    expect(unity.calls.every(call => call.tool === "execute_menu_item")).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 保真（任务 63）：UV/材质子网格映射、贴图字节落地、场景级环境交换
// ────────────────────────────────────────────────────────────────────────────

/** 第二个子网格（另一个四边形：与子网格 0 不共顶点，UV 是 2×2 平铺，用来分辨两套贴图坐标）。 */
const unityMeshB = {
  positions: [2, 0, 0, 3, 0, 0, 3, 0.5, 0.25, 2, 0.5, 0.25],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  uvs: [0, 0, 2, 0, 2, 2, 0, 2],
  indices: [0, 1, 2, 1, 3, 2],
}
/** 真·checker 贴图字节（PNG 签名 + 可辨认的载荷；内容被原样往返才说明没被重编码）。 */
const CHECKER = pngBytes(7, 288)
/** Unity 侧材质记录：棋盘材质带 _MainTex 贴图（贴图字节已落到产品侧文件里），纯色材质没有贴图。 */
const checkerMaterials: UnityMaterialRecord[] = [
  {
    name: "棋盘", assetPath: "Assets/LyapunovEnvironmentAcceptance/Materials/Checker.mat", assetGuid: "guid-checker", shader: "Standard",
    baseColor: [1, 1, 1, 1], metallic: 0, smoothness: 0.5, textures: ["_MainTex=_MainTex (UnityEngine.Texture2D)"],
    textureFiles: [{
      property: "_MainTex", assetPath: "Assets/LyapunovEnvironmentAcceptance/Textures/Checker.png", assetGuid: "guid-checker-png",
      file: "Assets/LyapunovEnvironmentAcceptance/Textures/Checker.png", mimeType: "image/png", bytes: CHECKER.length,
      width: 8, height: 8, wrapMode: "Repeat", contentDigest: byteDigest(CHECKER), reencoded: false,
    }],
  },
  {
    name: "纯色（Unity 资产里的名字）", assetPath: "Assets/LyapunovEnvironmentAcceptance/Materials/Plain.mat", assetGuid: "guid-plain", shader: "Standard",
    baseColor: [0.9, 0.3, 0.05, 1], metallic: 0.1, smoothness: 0.6, textures: [], textureFiles: [],
  },
]
/** 两子网格 GLB：几何与 C# 导出器一致（M 一次 + 绕序翻转 + v 翻转），贴图内嵌在 BIN chunk 里。 */
const glbForTwoSubmeshes = (texture?: GlbPrimitiveSpec["texture"]) => glbMulti([
  {
    positions: toGltf(unityMesh.positions, 3), normals: toGltf(unityMesh.normals, 3), uvs: toGltfUvs(unityMesh.uvs),
    indices: flipWinding(unityMesh.indices), material: { name: "glTF 棋盘", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5 } }, texture,
  },
  {
    positions: toGltf(unityMeshB.positions, 3), normals: toGltf(unityMeshB.normals, 3), uvs: toGltfUvs(unityMeshB.uvs),
    indices: flipWinding(unityMeshB.indices), material: { name: "glTF 纯色", pbrMetallicRoughness: { baseColorFactor: [1, 0.4, 0.1, 1], metallicFactor: 0.2, roughnessFactor: 0.7 } },
  },
])

/** 独立实现同一份摘要规范（C# `DigestOf`/`ByteDigest`）：FNV-1a 64，每个 long 按 8 字节小端喂。 */
function referenceDigest(values: readonly number[]): string {
  let hash = 0xcbf29ce484222325n
  for (const value of values) {
    const bits = BigInt.asUintN(64, BigInt(Math.trunc(value)))
    for (let byte = 0; byte < 8; byte++) {
      hash = (hash ^ ((bits >> BigInt(byte * 8)) & 0xffn)) & 0xffffffffffffffffn
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
  }
  return hash.toString(16).padStart(16, "0")
}
const referenceByteDigest = (bytes: Uint8Array): string => referenceDigest([bytes.length, ...[...bytes].filter((_, index) => index % 97 === 0)])

describe("ENV-25 保真：LPMESH v2 带 UV / 材质子网格 / 内嵌贴图", () => {
  test("LPMESH v2 线格式：UV 按 Unity 约定交付、子网格材质下标与贴图字节逐字节带过去（独立解码器核对）", () => {
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    const input = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs, indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      submeshes: [{ indexStart: 0, indexCount: 3, material: 0 }, { indexStart: 3, indexCount: 3, material: 1 }],
      materials: [
        { name: "棋盘", baseColor: [1, 1, 1, 1], metallic: 0, smoothness: 0.5, textures: [{ property: "_MainTex", mimeType: "image/png", wrapMode: "Repeat", contentDigest: byteDigest(CHECKER), bytes: CHECKER }] },
        { name: "纯色", baseColor: [1, 0.4, 0.1, 1], metallic: 0.2, smoothness: 0.7, textures: [] },
      ],
    }
    const decoded = decodeLpmesh(encodeLpmesh(input, { uvSpace: "gltf" }))
    expect([decoded.vertexCount, decoded.indexCount, decoded.subMeshCount, decoded.materialCount]).toEqual([4, 6, 2, 2])
    // UV：glTF 约定 → Unity 约定只翻 v，u 一点不动（翻 u 会让贴图左右颠倒）。
    expect([...decoded.uvs!]).toEqual([0, 1, 1, 1, 1, 0, 0, 0])
    expect([...input.uvs]).toEqual([...uvs])
    expect(decoded.submeshes).toEqual([{ indexStart: 0, indexCount: 3, material: 0 }, { indexStart: 3, indexCount: 3, material: 1 }])
    expect(decoded.materials.map(material => material.name)).toEqual(["棋盘", "纯色"])
    expect(decoded.materials[1]!.baseColor).toEqual([1, 0.4, 0.1, 1])
    expect([...decoded.materials[0]!.textures[0]!.bytes]).toEqual([...CHECKER])
    expect(decoded.materials[0]!.textures[0]!.contentDigest).toBe(byteDigest(CHECKER))
    expect(decoded.materials[0]!.textures[0]!.wrapMode).toBe("Repeat")
    expect(decoded.materials[1]!.textures).toEqual([])
    // `uvSpace: "unity"` 是幂等的：已经是 Unity 约定的坐标不能再翻一次。
    expect([...decodeLpmesh(encodeLpmesh(input, { uvSpace: "unity" })).uvs!]).toEqual([...uvs])
    // 子网格必须首尾相接覆盖全部索引；多子网格必须带材质表 —— 违反就是编码期错误，不许静默。
    expect(() => encodeLpmesh({ ...input, submeshes: [{ indexStart: 1, indexCount: 5, material: 0 }] })).toThrow(/LPMESH_SUBMESH_GAP/)
    expect(() => encodeLpmesh({ ...input, submeshes: [{ indexStart: 0, indexCount: 4, material: 0 }, { indexStart: 4, indexCount: 1, material: 1 }] })).toThrow(/LPMESH_SUBMESH_COVERAGE_MISMATCH/)
    expect(() => encodeLpmesh({ ...input, submeshes: input.submeshes, materials: [] })).toThrow(/LPMESH_MATERIALS_MISSING/)
    // 摘要按 C# 的规范独立复算（写错素数/字节序/量化都会被这条抓住）。
    expect(digestOfValues([0, 1, -1, 123456789])).toBe(referenceDigest([0, 1, -1, 123456789]))
    expect(byteDigest(CHECKER)).toBe(referenceByteDigest(CHECKER))
  })

  test("GLB 两个 primitive：读成两个子网格（各自材质），TEXCOORD_0 与内嵌贴图字节/sampler 逐字节读出", async () => {
    const path = join(base, "two-submeshes.glb")
    await writeFile(path, glbForTwoSubmeshes({ bytes: CHECKER, mimeType: "image/png", wrapS: 33071 }))
    const geometry = await readGlbGeometry(path)
    expect(geometry.positions.length).toBe(24)
    expect(geometry.submeshes).toEqual([{ indexStart: 0, indexCount: 6, material: 0 }, { indexStart: 6, indexCount: 6, material: 1 }])
    // 第二个 primitive 的索引按顶点基址偏移（否则两个子网格会互相串顶点）。
    expect([...geometry.indices]).toEqual([...flipWinding(unityMesh.indices), ...flipWinding(unityMesh.indices).map(index => index + 4)])
    expect([...geometry.uvs!]).toEqual([...toGltfUvs(unityMesh.uvs), ...toGltfUvs(unityMeshB.uvs)])
    expect(geometry.materials.map(material => material.baseColor)).toEqual([[1, 1, 1, 1], [1, 0.4, 0.1, 1]])
    expect(geometry.materials[0]!.textures.length).toBe(1)
    expect([...geometry.materials[0]!.textures[0]!.bytes]).toEqual([...CHECKER])
    expect(geometry.materials[0]!.textures[0]!.contentDigest).toBe(referenceByteDigest(CHECKER))
    expect(geometry.materials[0]!.textures[0]!.wrapMode).toBe("Clamp")
    expect(geometry.materials[1]!.textures).toEqual([])
  })

  test("GLB 多 primitive 共用一组顶点访问器（Unity 写出器的形状）：顶点不复制、索引不串位、交付几何与资产同份", async () => {
    const path = join(base, "shared-attributes.glb")
    await writeFile(path, glbSharedAttributes({
      positions: toGltf([...unityMesh.positions, ...unityMeshB.positions], 3),
      normals: toGltf([...unityMesh.normals, ...unityMeshB.normals], 3),
      uvs: toGltfUvs([...unityMesh.uvs, ...unityMeshB.uvs]),
      submeshes: [
        { indices: flipWinding(unityMesh.indices), material: { name: "glTF 棋盘" } },
        { indices: flipWinding(unityMeshB.indices).map(index => index + 4), material: { name: "glTF 纯色" } },
      ],
    }))
    const geometry = await readGlbGeometry(path)
    // 曾经按 primitive 复制顶点：8 个顶点读成 16 个、索引整体错位（真机上表现为越界读）。
    expect(geometry.positions.length).toBe(24)
    expect([...geometry.indices]).toEqual([...flipWinding(unityMesh.indices), ...flipWinding(unityMeshB.indices).map(index => index + 4)])
    expect([...geometry.uvs!]).toEqual([...toGltfUvs(unityMesh.uvs), ...toGltfUvs(unityMeshB.uvs)])
    expect(geometry.submeshes).toEqual([{ indexStart: 0, indexCount: 6, material: 0 }, { indexStart: 6, indexCount: 6, material: 1 }])

    const document = unityDocument({ mesh: { vertexCount: 8, triangleCount: 4, subMeshCount: 2, uvCount: 8 }, materials: checkerMaterials })
    const { exchange, unity } = await sceneWith(document, { glb: glbSharedAttributes({
      positions: toGltf([...unityMesh.positions, ...unityMeshB.positions], 3),
      normals: toGltf([...unityMesh.normals, ...unityMeshB.normals], 3),
      uvs: toGltfUvs([...unityMesh.uvs, ...unityMeshB.uvs]),
      submeshes: [{ indices: flipWinding(unityMesh.indices) }, { indices: flipWinding(unityMeshB.indices).map(index => index + 4) }],
    }) })
    await exchange.readScene({ sceneId: "scene_acc" })
    await exchange.writeScene({ sceneId: "scene_acc", mode: "new" })
    const node = unity.imported[0]!.nodes.find(item => item.mesh)!
    const delivered = decodeLpmesh(new Uint8Array(await readFile(join(unityProject, node.mesh!.file))))
    // 交付字节必须是**资产那一份几何**：顶点数、绕序、UV 都回到 Unity 约定，
    // 这样 Unity 侧才能用"交付字节自己算的摘要"和资产摘要对上（身份不是靠声明值给的）。
    expect(delivered.vertexCount).toBe(8)
    // 顶点过了一次矩阵乘（M⁻¹），会有 ~1e-16 的浮点噪声 —— 身份判据是**量化到 1e-6 的摘要**，
    // 所以这里按同一档容差比对，而不是逐位相等（逐位相等连恒等变换都不满足）。
    const closeTo = (actual: Float32Array, expected: number[], epsilon = 1e-6) =>
      actual.length === expected.length && [...actual].every((value, index) => Math.abs(value - expected[index]!) <= epsilon)
    expect(closeTo(delivered.positions, [...unityMesh.positions, ...unityMeshB.positions])).toBe(true)
    expect(closeTo(delivered.uvs!, [...unityMesh.uvs, ...unityMeshB.uvs])).toBe(true)
    // 索引逐位相等（绕序也回到 Unity 约定）：子网格 B 的 4 个顶点在共享顶点集里是 4..7。
    expect([...delivered.indices]).toEqual([...unityMesh.indices, ...unityMeshB.indices.map(index => index + 4)])
  })

  test("产品 → Unity：带 checker 与两子网格的模型交付 LPMESH v2，资产身份/内容摘要原样保留（不靠放松身份检查）", async () => {
    const document = unityDocument({
      mesh: { vertexCount: 8, triangleCount: 4, subMeshCount: 2, uvCount: 8 },
      materials: checkerMaterials,
    })
    const { exchange, unity } = await sceneWith(document, { glb: glbForTwoSubmeshes({ bytes: CHECKER, mimeType: "image/png" }) })
    await exchange.readScene({ sceneId: "scene_acc" })

    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity", assetFolder: "Assets/LyapunovEnvironmentAcceptance/Imported" })
    const written = unity.imported[0]!
    const node = written.nodes.find(item => item.mesh)!
    // 资产身份与内容摘要逐字保留：Unity 侧据此判"同一项目里这个资产还是不是这份内容"，能复用才复用。
    expect(node.mesh).toMatchObject({
      assetPath: "Assets/LyapunovEnvironmentAcceptance/Meshes/site.asset", assetGuid: "guid-site", contentDigest: "1f2e3d4c5b6a7988",
      subMeshCount: 2, uvCount: 8, vertexCount: 8, triangleCount: 4, fileSpace: "unity-left-handed-y-up-meters-raw",
    })
    expect(node.mesh!.file).not.toBe(document.nodes[0]!.mesh!.file)
    expect(node.mesh!.fileBytes).toBe(new Uint8Array(await readFile(join(unityProject, node.mesh!.file))).length)
    const delivered = decodeLpmesh(new Uint8Array(await readFile(join(unityProject, node.mesh!.file))))
    // 两个子网格各自挂自己的材质（不是所有面都吃第一个材质）。
    expect(delivered.submeshes).toEqual([{ indexStart: 0, indexCount: 6, material: 0 }, { indexStart: 6, indexCount: 6, material: 1 }])
    expect([...delivered.indices]).toEqual([...unityMesh.indices, ...unityMeshB.indices.map(index => index + 4)])
    expect([...delivered.uvs!]).toEqual([...unityMesh.uvs, ...unityMeshB.uvs])
    // 材质名/颜色/贴图：以产品文档里的记录为准（用户可能改过颜色），贴图字节来自 GLB 内嵌的那份。
    expect(delivered.materials.map(material => material.name)).toEqual(["棋盘", "纯色（Unity 资产里的名字）"])
    expect(delivered.materials[1]!.baseColor).toEqual([0.9, 0.3, 0.05, 1])
    expect(delivered.materials[1]!.smoothness).toBe(0.6)
    expect([...delivered.materials[0]!.textures[0]!.bytes]).toEqual([...CHECKER])
    expect(delivered.materials[0]!.textures[0]!.contentDigest).toBe(byteDigest(CHECKER))
    expect(node.materials!.map(material => material.assetGuid)).toEqual(["guid-checker", "guid-plain"])
    expect(node.losses.join("\n")).toMatch(/SUBMESHES_DELIVERED/)
    expect(node.losses.join("\n")).not.toMatch(/UV_MISSING/)
    // 产品侧回执也说清楚交付了什么（用户不必去猜 LPMESH 里有没有 UV）。
    expect((result.losses as string[]).join("\n")).toMatch(/MESH_BINARY: 几何以 LPMESH v2/)
  })

  test("没有 UV 的网格如实报 UV_MISSING，不静默交付一张没有贴图坐标的网格", async () => {
    const document = unityDocument({ mesh: { uvCount: 0, subMeshCount: 1 } })
    const { exchange, unity } = await sceneWith(document, { glb: glbMesh({ positions: toGltf(unityMesh.positions, 3), normals: toGltf(unityMesh.normals, 3), indices: flipWinding(unityMesh.indices) }) })
    await exchange.readScene({ sceneId: "scene_acc" })
    await exchange.writeScene({ sceneId: "scene_acc", mode: "new" })
    const node = unity.imported[0]!.nodes.find(item => item.mesh)!
    expect(node.mesh!.uvCount).toBe(0)
    expect(node.losses.join("\n")).toMatch(/UV_MISSING/)
    expect(decodeLpmesh(new Uint8Array(await readFile(join(unityProject, node.mesh!.file)))).uvs).toBeUndefined()
  })
})

describe("ENV-27 保真：场景级环境（45 SceneEnvironment 合同的最小映射）", () => {
  test("Unity → 产品：强度/背景/太阳/阴影落成 components.environment；曝光与昼夜沿用产品现值并记说明", async () => {
    const document = unityDocument({ environment: environmentRecord({ losses: ["SKYBOX_NOT_TRANSFERRED: 程序化天空盒只记损失"] }) })
    const { exchange } = await sceneWith(document)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    const snapshot = await operations.inspect("scene_acc")
    const entity = entityOf(snapshot.entities, UNITY_ENVIRONMENT_ENTITY_ID)
    expect(entity.components.environment).toMatchObject({
      kind: ENVIRONMENT_KIND, environmentIntensity: 1.35, hemisphereIntensity: 3.6,
      background: "color", backgroundColor: "#336699", shadows: true,
      sun: { azimuthDeg: 128.5, elevationDeg: 33.25, intensity: 2.75 },
      exposure: PRODUCT_ENVIRONMENT_DEFAULTS.exposure,
      dayNight: { ...PRODUCT_ENVIRONMENT_DEFAULTS.dayNight },
    })
    expect(report.environment).toEqual({ entityId: UNITY_ENVIRONMENT_ENTITY_ID, component: entity.components.environment as never })
    // Unity 侧的逐条说明带前缀并入总损失；曝光是产品独有字段，如实写明"用的是默认值"。
    expect(report.losses.join("\n")).toMatch(/UNITY_SKYBOX_NOT_TRANSFERRED/)
    expect(report.losses.join("\n")).toMatch(/ENVIRONMENT_EXPOSURE_DEFAULTED/)
    // 环境实体本身不建 Unity 对象（它只有环境组件），也不会被当成普通节点写回去。
    expect(report.entities).toBe(5)
    // 重复读入：更新同一条实体，不会长出第二份环境。
    await exchange.readScene({ sceneId: "scene_acc" })
    const second = await operations.inspect("scene_acc")
    expect(second.entities.filter(item => item.entityId === UNITY_ENVIRONMENT_ENTITY_ID).length).toBe(1)
    expect(second.entities.length).toBe(6)
  })

  test("产品 → Unity：产品里改过的强度/背景/太阳写回文档；曝光/HDRI/昼夜只记损失；产品没有环境时不覆盖 Unity", async () => {
    const document = unityDocument({ environment: environmentRecord() })
    const { exchange, unity } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })
    // 用户在产品里改了环境（强度/背景/曝光/昼夜/HDRI）——写回必须以产品现值为准。
    const before = await operations.inspect("scene_acc")
    const current = entityOf(before.entities, UNITY_ENVIRONMENT_ENTITY_ID).components.environment as Record<string, unknown>
    await operations.scene.commit({
      sceneId: "scene_acc", expectedRevision: before.revision,
      patch: [{
        op: "update", entityId: UNITY_ENVIRONMENT_ENTITY_ID,
        changes: {
          components: {
            ...entityOf(before.entities, UNITY_ENVIRONMENT_ENTITY_ID).components,
            environment: {
              ...current, environmentIntensity: 2.5, hemisphereIntensity: 1.1, background: "environment", backgroundColor: "#ff8800",
              shadows: false, sun: { azimuthDeg: -35.5, elevationDeg: 71.25, intensity: 4.5 },
              exposure: 1.8, hdri: { resourceId: "res_hdri", version: 3 },
              dayNight: { enabled: true, timeHours: 18.5, cycleSeconds: 90 },
            },
          },
        },
      }],
    })
    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "new", scenePath: "Assets/LyapunovEnvironmentAcceptance/Scenes/RoundTrip.unity" })

    const written = unity.imported[0]!
    expect(written.environment).toMatchObject({
      present: true, environmentIntensity: 2.5, hemisphereIntensity: 1.1, background: "environment", backgroundColor: "#ff8800",
      shadows: false, sunAzimuthDeg: -35.5, sunElevationDeg: 71.25, sunIntensity: 4.5,
      dayNightEnabled: true, dayNightHours: 18.5, dayNightCycleSeconds: 90,
    })
    // 太阳灯的名字由 Unity 侧按"最亮的方向光"认领，产品不硬编码名字。
    expect(written.environment!.sunName).toBe("")
    const losses = (result.losses as string[]).join("\n")
    expect(losses).toMatch(/ENVIRONMENT_FROM_PRODUCT/)
    expect(losses).toMatch(/ENVIRONMENT_EXPOSURE_NOT_TRANSFERRED/)
    expect(losses).toMatch(/ENVIRONMENT_HDRI_NOT_APPLIED/)
    expect(losses).toMatch(/ENVIRONMENT_DAYNIGHT_VIEWER_ONLY/)
    // 环境本身不是 Unity 对象：写回文档里没有多出实体。
    expect(written.nodes.map(node => node.entityId)).toEqual(document.nodes.map(node => node.entityId))
  })

  test("产品场景没有环境组件时写回不带环境：Unity 沿用自身 RenderSettings（回执写明，不编一份默认值去覆盖）", async () => {
    const { exchange, unity } = await sceneWith(unityDocument())
    await exchange.readScene({ sceneId: "scene_acc" })
    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "new" })
    expect(unity.imported[0]!.environment ?? null).toBeNull()
    expect((result.losses as string[]).join("\n")).toMatch(/ENVIRONMENT_ABSENT_IN_PRODUCT/)
  })

  test("productEnvironmentFromUnity 只有一边有时不假装同步：present=false 不动产品，previous 的曝光/昼夜逐字保留", () => {
    const previous = { exposure: 0.42, dayNight: { enabled: true, timeHours: 21, cycleSeconds: 33 }, sun: { azimuthDeg: 12, elevationDeg: 3, intensity: 1 } }
    const mapped = productEnvironmentFromUnity(environmentRecord(), previous)
    expect(mapped.component!.exposure).toBe(0.42)
    expect(mapped.component!.dayNight).toEqual({ enabled: true, timeHours: 21, cycleSeconds: 33 })
    expect(mapped.component!.sun.azimuthDeg).toBe(128.5)
    expect(mapped.losses.join("\n")).toMatch(/ENVIRONMENT_FIELD_PRESERVED: exposure=0.42/)
    expect(mapped.losses.join("\n")).toMatch(/ENVIRONMENT_FIELD_PRESERVED: dayNight/)
    expect(mapped.losses.join("\n")).toMatch(/ENVIRONMENT_SUN_FROM_UNITY/)
    // 背景是纯色但没给合法 #rrggbb：只写 background=color，不编颜色。
    const noColor = productEnvironmentFromUnity(environmentRecord({ backgroundColor: "Skybox" }))
    expect(noColor.component!.backgroundColor).toBeUndefined()
    expect(noColor.losses.join("\n")).toMatch(/ENVIRONMENT_BACKGROUND_COLOR_ABSENT/)
    // present=false（这次没采到）：不动产品里已有的环境，也不编一份出来。
    expect(productEnvironmentFromUnity(environmentRecord({ present: false }), previous).component).toBeNull()
    expect(productEnvironmentFromUnity(null, previous).component).toBeNull()
  })

  test("firstEnvironmentOf 只认 kind=scene/environment 的组件；非环境实体上的同名字段不被当成环境", async () => {
    const document = unityDocument({ environment: environmentRecord() })
    const { exchange } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })
    // 产品里已经有环境时再读一次：产品场景里的环境读数以 **Unity 那一次读入的值**为准，
    // 而写回文档读的是产品当前值（firstEnvironmentOf 取第一条合法组件）。
    const before = await operations.inspect("scene_acc")
    const found = firstEnvironmentOf(before)!
    expect(found.entityId).toBe(UNITY_ENVIRONMENT_ENTITY_ID)
    expect(found.component.kind).toBe(ENVIRONMENT_KIND)
    // kind 不对的同名组件不算环境（45 的判据一致）：改掉 kind 后就找不到环境了。
    await operations.scene.commit({
      sceneId: "scene_acc", expectedRevision: before.revision,
      patch: [{ op: "update", entityId: UNITY_ENVIRONMENT_ENTITY_ID, changes: { components: { ...entityOf(before.entities, UNITY_ENVIRONMENT_ENTITY_ID).components, environment: { ...(found.component as Record<string, unknown>), kind: "not/environment" } } } }],
    })
    const after = await operations.inspect("scene_acc")
    expect(firstEnvironmentOf(after)).toBeUndefined()
    // 产品里没有环境组件时写回文档不带环境（Unity 沿用自身设置，回执写明）。
    const result = await exchange.writeScene({ sceneId: "scene_acc", mode: "new" })
    expect((result.losses as string[]).join("\n")).toMatch(/ENVIRONMENT_ABSENT_IN_PRODUCT/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 84：并发请求隔离 / signal / 身份窄更新 / 目标绑定
// ────────────────────────────────────────────────────────────────────────────

/** 用户自己往产品场景里加的东西：挂在交换实体下的注释牌。 */
const userEntity = (entityId: string, parentId: string): Entity => ({
  entityId, parentId, name: "用户注释牌",
  transform: { position: [0, 0, 1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  resources: [], components: { annotation: { note: "用户自己挂的（不是交换范围）" } },
})
/** 测试用的确定性旋转（轴 + 角度 → 归一化四元数）。 */
const rot = (axis: [number, number, number], degrees: number): [number, number, number, number] => {
  const radians = (degrees * Math.PI) / 180, half = Math.sin(radians / 2), length = Math.hypot(axis[0], axis[1], axis[2])
  return [axis[0] / length * half, axis[1] / length * half, axis[2] / length * half, Math.cos(radians / 2)]
}
const matrixOf = (transform: { position: number[]; quaternion: number[]; scale: number[] }): Matrix4 =>
  new Matrix4().compose(
    new Vector3(transform.position[0]!, transform.position[1]!, transform.position[2]!),
    new Quaternion(transform.quaternion[0]!, transform.quaternion[1]!, transform.quaternion[2]!, transform.quaternion[3]!),
    new Vector3(transform.scale[0]!, transform.scale[1]!, transform.scale[2]!))
const matrixClose = (a: Matrix4, b: Matrix4, tolerance = 1e-9): boolean => a.elements.every((value, index) => Math.abs(value - b.elements[index]!) <= tolerance)
const positionClose = (a: Matrix4, b: Matrix4, tolerance = 1e-9): boolean => [12, 13, 14].every(index => Math.abs(a.elements[index]! - b.elements[index]!) <= tolerance)
/**
 * 位姿夹具：`舞台(旋转+非均匀缩放) → 灯柱(旋转+非均匀缩放) → 用户注释牌 → 用户子子对象`。
 * 轴对齐的旋转让父链折起来仍是 TRS（可以精确保持世界位姿）；一般角度留给剪切用例。
 */
async function poseScene(sceneGuid: string): Promise<void> {
  await operations.create({ sceneId: "scene_pose" })
  await operations.scene.commit({
    sceneId: "scene_pose", expectedRevision: 0,
    patch: [
      { op: "add", entity: { entityId: "entity_unity_stage", name: "舞台", transform: { position: [3, 1, -2], quaternion: rot([0, 1, 0], 90), scale: [2, 3, 0.5] }, resources: [], components: { unity: { globalId: `GlobalObjectId_V1-2-${sceneGuid}-1-0` } } } },
      { op: "add", entity: { entityId: "entity_unity_pillar", parentId: "entity_unity_stage", name: "灯柱", transform: { position: [0, 4, 1.5], quaternion: rot([0, 1, 0], 90), scale: [0.5, 1.25, 2] }, resources: [], components: { unity: { globalId: `GlobalObjectId_V1-2-${sceneGuid}-2-0` } } } },
      { op: "add", entity: { entityId: "entity_user_child", parentId: "entity_unity_pillar", name: "用户注释牌", transform: { position: [1, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { annotation: { note: "用户自己挂的（不是交换范围）" } } } },
      { op: "add", entity: { entityId: "entity_user_grandchild", parentId: "entity_user_child", name: "用户子子对象", transform: { position: [0, 0, 1], quaternion: rot([1, 0, 0], 180), scale: [1, 2, 1] }, resources: [], components: { annotation: { note: "子树也要跟着走" } } } },
    ] as any,
  })
}
/** 目录里的文件名（目录不存在时按空处理）。 */
async function namesIn(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort() } catch { return [] }
}

describe("84 请求隔离：并行调用各写各的请求文件（不共用 request.json/result.json）", () => {
  test("反例（旧协议）：共用 request.json/result.json 时两次同时调用，先写的那次请求被吞、回执还会窜到另一条调用上", async () => {
    // 这段**按 84 之前的协议手工驱动**（产品代码里已经没有这条路径）：固定 request.json / 固定 result.json。
    // 它存在的意义是留个可执行的反例：证明"同时调用"在旧协议下真的会丢请求，而不是只担心。
    const scratch = join(unityProject, UNITY_EXCHANGE_SCRATCH)
    await mkdir(scratch, { recursive: true })
    const requestPath = join(scratch, "request.json")
    const resultPath = join(scratch, "result.json")
    const executedLegacy: string[] = []
    const receipts: Array<{ by: string; requestId: string; ok?: boolean }> = []
    /** 旧协议的"发出请求"：两次调用进的是**同一份** request.json，文件里最后只剩一份。 */
    const legacySend = async (requestId: string, op: string): Promise<void> => {
      await writeFile(requestPath, JSON.stringify({ requestId, op, resultPath }))
    }
    /** 旧协议的"取回执"：编辑器读那份共享请求、执行、把回执写进共享 result.json；调用方只按 requestId 认自己的。 */
    const legacyRoundTrip = async (callerRequestId: string): Promise<string> => {
      const request = JSON.parse(await readFile(requestPath, "utf8")) as { requestId: string; op: string }
      executedLegacy.push(request.requestId)                                        // 编辑器只看得见文件里留下的那份
      await writeFile(resultPath, JSON.stringify({ requestId: request.requestId, op: request.op, ok: true }))
      const result = JSON.parse(await readFile(resultPath, "utf8")) as { requestId: string; ok: boolean }
      receipts.push({ by: callerRequestId, requestId: result.requestId, ok: result.ok })
      return result.requestId
    }
    // 两条调用同时发出（各自的请求都已经写进文件、都还没拿到任何回执）：请求落进的是同一个文件。
    // 两次写入按 A→B 排定——两个并发 writeFile 的**落盘先后**本来就不保证，那不是本反例要证明的东西；
    // 反例证明的是：共享单文件时文件里最后只剩一份，两条调用都只能读这一份。
    await legacySend("lx-A", "status")
    await legacySend("lx-B", "export")
    expect(JSON.parse(await readFile(requestPath, "utf8")).requestId).toBe("lx-B")   // A 那份已经被覆盖掉了
    const aReceipt = await legacyRoundTrip("lx-A")
    const bReceipt = await legacyRoundTrip("lx-B")

    // A 的 status 请求被 B 覆盖：编辑器两次读到的都是 B 那份，A 从来没被执行过。
    expect(executedLegacy).toEqual(["lx-B", "lx-B"])
    expect(executedLegacy).not.toContain("lx-A")
    // 两条调用等到的都是 B 的回执（同一份 result.json）：A 只能拿到别人的结果。
    expect(aReceipt).toBe("lx-B")
    expect(bReceipt).toBe("lx-B")
    expect(receipts.find(item => item.by === "lx-A")!.requestId).toBe("lx-B")
  })

  test("修复后：两个 exchange 实例（同一条 MCP 连接）真正并发，各自写自己的请求文件、各自拿自己的回执", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    await operations.create({ sceneId: "scene_two" })
    // 每次导出写一份**内容带本次 requestId** 的文档：如果两条调用共用同一份文档路径，后写的会盖掉先写的，
    // 先那条读到的就是别人的场景（场景名不再是自己那次导出的）——这条断言专门盯这个窜位。
    const unity = fakeUnity({ document: request => ({ ...document, sceneName: `Unity-${request.requestId}` }), delayMs: 20 })   // 真并发：两边在编辑器里重叠
    // 两个实例共用一个 port，绕过进程内串行 —— 跟"两条原生工具调用并行"是同一个交错。
    const one = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 3_000, pollMs: 5 })
    const two = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 3_000, pollMs: 5 })
    const [first, second] = await Promise.all([one.readScene({ sceneId: "scene_acc" }), two.readScene({ sceneId: "scene_two" })])

    // 两份请求、两次执行、requestId 各不同：没有一份被另一份盖掉。
    expect(unity.executed.length).toBe(2)
    expect(new Set(unity.executed).size).toBe(2)
    expect(await namesIn(join(unity.scratch, "requests"))).toEqual([])        // 都被认领执行完了
    expect((await namesIn(join(unity.scratch, "results"))).length).toBe(2)    // 回执各写各的
    // 各自读的是**自己那次**导出的文档（回执不会落到另一条请求上，内容也不会窜位）。
    expect(first.documentPath).not.toBe(second.documentPath)
    const ids = unity.executed
    expect([first.unityScene!.name, second.unityScene!.name].sort()).toEqual(ids.map(id => `Unity-${id}`).sort())
    expect(first.sync!.added.length).toBe(5)
    expect(second.sync!.added.length).toBe(5)
    expect((await operations.inspect("scene_acc")).entities.length).toBe(5)
    expect((await operations.inspect("scene_two")).entities.length).toBe(5)
  })

  test("一份请求恰好执行一次：两次菜单调用（重复触发）不会把同一份请求导入两遍", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    const unity = fakeUnity({ document })
    const scratch = join(unityProject, UNITY_EXCHANGE_SCRATCH)
    const requests = join(scratch, "requests")
    await mkdir(requests, { recursive: true })
    const requestPath = join(requests, "lx-1.json")
    await writeFile(requestPath, JSON.stringify({ requestId: "lx-1", op: "export", resultPath: join(scratch, "results", "lx-1.json"), expectProjectRoot: unityProject, deadlineUnixMs: Date.now() + 60_000, export: { scenePath: "", includeInactive: true, exportMeshes: true, hashAssets: false, maxNodes: 100, documentPath: "" } }))

    // 原生菜单项被触发两次（重试/两条调用同时到）：认领是 rename，第二次来的人找不到文件。
    await unity.port.call("execute_menu_item", { menu_path: UNITY_EXCHANGE_MENU })
    await unity.port.call("execute_menu_item", { menu_path: UNITY_EXCHANGE_MENU })

    expect(unity.executed).toEqual(["lx-1"])
    expect(await namesIn(requests)).toEqual([])
  })

  test("编辑器只认领没过期的请求：取消/崩溃留下的孤儿请求不会在很久以后突然被执行", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    const unity = fakeUnity({ document })
    const scratch = join(unityProject, UNITY_EXCHANGE_SCRATCH)
    const requests = join(scratch, "requests")
    await mkdir(requests, { recursive: true })
    await writeFile(join(requests, "lx-expired.json"), JSON.stringify({ requestId: "lx-expired", op: "import", resultPath: join(scratch, "results", "lx-expired.json"), expectProjectRoot: unityProject, deadlineUnixMs: Date.now() - 1, import: { documentPath: "/nope.json", scenePath: "", mode: "current", dryRun: false } }))

    await unity.port.call("execute_menu_item", { menu_path: UNITY_EXCHANGE_MENU })

    expect(unity.executed).toEqual([])
    expect(unity.imported).toEqual([])
  })
})

describe("84 signal：等待可停、开始前不算、超时只是观测、结果只落到自己的请求上", () => {
  test("菜单返回过但编辑器根本没认领（silent）：取消按**文件事实**报 pending 并撤回请求，不拿菜单发出过冒充远端已认领", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    // silent = 菜单调用返回 ok，但编辑器一份请求都没扫（请求文件原样躺在 requests/ 里）。
    // 这正是"await port.call 返回了"≠"远端已认领"的反例：取消必须按文件事实说清楚。
    const controller = new AbortController()
    let requestWritten = ""
    const base = fakeUnity({ document, mode: "silent", onRequest: path => { requestWritten = path } })
    const exchange = new UnitySceneExchange(operations, base.port, { projectPath: unityProject, timeoutMs: 5_000, pollMs: 5 })
    const pending = exchange.readScene({ sceneId: "scene_acc" }, { signal: controller.signal })
    // 等菜单响应真的返回、调用进入"等回执"之后才取消：这正是"await port.call 返回过"曾经被当成 claimed 的那一刻。
    for (let attempt = 0; attempt < 400 && !base.calls.some(call => call.tool === "execute_menu_item"); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const error = await pending.then(() => { throw new Error("EXPECTED_UNITY_WAIT_CANCELLED_BUT_RESOLVED") }, reason => reason as Error)

    expect(error).toBeInstanceOf(UnityExchangeCancelled)
    expect((error as unknown as { code: string }).code).toBe("UNITY_WAIT_CANCELLED")
    expect((error as unknown as { detail: { claim: string; mayHaveStarted: boolean; phase: string } }).detail)
      .toMatchObject({ claim: "pending", mayHaveStarted: false, phase: "等回执" })
    expect((error as unknown as { detail: { observation: string } }).detail.observation).toMatch(/还没被编辑器认领|已撤回/)
    expect(error.message).toMatch(/编辑器不会执行这条请求/)
    expect(error.message).not.toMatch(/可能已经开始/)
    // 取消前请求确实写下去了；撤回后就该从 requests/ 里消失（编辑器不会再执行它）。
    expect(requestWritten).toContain("requests/lx-")
    expect(await namesIn(join(base.scratch, "requests"))).toEqual([])
    expect((await operations.inspect("scene_acc")).entities).toEqual([])
    expect((await operations.inspect("scene_acc")).revision).toBe(0)
  })

  test("取消时请求文件已被编辑器认领搬走：报 claimed + mayHaveStarted，不谎称撤销也不自动重发", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const controller = new AbortController()
    let claimedPath = ""
    const base = fakeUnity({ document, mode: "silent", onRequest: path => { claimedPath = path } })
    // 模拟 C# 的 File.Move 认领：请求文件被搬走（编辑器拿走了），但回执还没写出来。
    const port: UnityExchangePort = { ...base.port, call: async (tool, args) => { if (tool === "execute_menu_item" && !claimedPath) throw new Error("EXPECTED_REQUEST_WRITTEN"); if (tool === "execute_menu_item") { await rm(claimedPath, { force: true }); controller.abort() } return await base.port.call(tool, args) } }
    const exchange = new UnitySceneExchange(operations, port, { projectPath: unityProject, timeoutMs: 5_000, pollMs: 5 })
    const pending = exchange.readScene({ sceneId: "scene_acc" }, { signal: controller.signal })
    const error = await pending.then(() => { throw new Error("EXPECTED_UNITY_WAIT_CANCELLED_BUT_RESOLVED") }, reason => reason as Error)

    const detail = (error as unknown as { detail: { claim: string; mayHaveStarted: boolean; observation: string; requestId: string } }).detail
    expect(error).toBeInstanceOf(UnityExchangeCancelled)
    expect(detail).toMatchObject({ claim: "claimed", mayHaveStarted: true })
    expect(detail.observation).toMatch(/认领|搬走/)
    expect(error.message).toMatch(/本地停止不等于远端撤销/)
    // 已认领的请求**不删**（它已经不在 requests/ 里了，撤回无从谈起）、也**不重发**：只有那一次菜单调用。
    expect(base.calls.filter(call => call.tool === "execute_menu_item").length).toBe(1)
    expect(await namesIn(join(base.scratch, "requests"))).toEqual([])
  })

  test("排队等前一条操作时取消：本次调用立刻返回，不等前一条做完，也不写自己的请求文件", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const unity = fakeUnity({ document, delayMs: 400 })      // 前一条真在"编辑器"里跑 400ms
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 5_000, pollMs: 5 })
    const controller = new AbortController()
    const first = exchange.status()                            // 占住串行队列
    for (let attempt = 0; attempt < 400 && !unity.calls.some(call => call.tool === "execute_menu_item"); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(unity.calls.some(call => call.tool === "execute_menu_item")).toBe(true)   // 前一条已在等菜单响应

    const started = Date.now()
    const second = exchange.status(controller.signal)           // 排在后一位，此刻取消
    controller.abort()
    await expect(second).rejects.toThrow(/UNITY_WAIT_CANCELLED.*开始前（排队等前一条操作）/)
    expect(Date.now() - started).toBeLessThan(300)              // 没等前一条那 400ms 跑完才看 signal

    await first
    // 被放弃的那次即使之后轮到它，也不写请求文件、不触发菜单：只有前一条被真执行。
    expect(unity.executed.length).toBe(1)
    expect(await namesIn(join(unity.scratch, "requests"))).toEqual([])
  })

  test("开始前就带取消信号：不绑实例、不写请求文件、不触发菜单（原生工具层也会在派发前拒绝）", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const unity = fakeUnity({ document })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 200, pollMs: 5 })
    const controller = new AbortController()
    controller.abort()

    await expect(exchange.readScene({ sceneId: "scene_acc" }, { signal: controller.signal })).rejects.toThrow(/UNITY_WAIT_CANCELLED.*开始前/)

    expect(unity.calls).toEqual([])
    expect(await namesIn(join(unity.scratch, "requests"))).toEqual([])
    expect((await operations.inspect("scene_acc")).entities).toEqual([])
  })

  test("等 MCP 菜单响应时取消：立刻停止本地等待（不等那次调用返回），仍按文件事实定性并撤回", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const controller = new AbortController()
    // 菜单调用永不返回（MCP/编辑器卡住）：取消不能等它。
    const unity = fakeUnity({ document, mode: "silent", onMenu: async () => { await new Promise(() => { /* 永不返回 */ }) } })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 5_000, pollMs: 5 })
    const pending = exchange.readScene({ sceneId: "scene_acc" }, { signal: controller.signal })
    for (let attempt = 0; attempt < 400 && !unity.calls.some(call => call.tool === "execute_menu_item"); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(unity.calls.some(call => call.tool === "execute_menu_item")).toBe(true)

    const started = Date.now()
    controller.abort()
    const error = await pending.then(() => { throw new Error("EXPECTED_UNITY_WAIT_CANCELLED_BUT_RESOLVED") }, reason => reason as Error)
    expect(Date.now() - started).toBeLessThan(200)            // 一取消就返回，不等那次调用结束
    expect((error as unknown as { detail: { claim: string; mayHaveStarted: boolean; phase: string } }).detail)
      .toMatchObject({ claim: "pending", mayHaveStarted: false, phase: "等 MCP 菜单响应" })
    expect(await namesIn(join(unity.scratch, "requests"))).toEqual([])
  })

  test("观测超时只是没等到回执：不自动重发、不重跑导入，请求文件原样留着可查", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const unity = fakeUnity({ document, mode: "silent" })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 60, pollMs: 5 })

    await expect(exchange.readScene({ sceneId: "scene_acc" })).rejects.toThrow(/UNITY_RESULT_TIMEOUT.*不重发请求、不重跑导入/s)

    // 只触发过一次菜单项（没有第二次导入），请求文件仍在 requests/ 里（`unity_scene_status` 查得到）。
    expect(unity.calls.filter(call => call.tool === "execute_menu_item").length).toBe(1)
    expect(unity.executed).toEqual([])
    expect((await namesIn(join(unity.scratch, "requests"))).length).toBe(1)
    expect((await operations.inspect("scene_acc")).entities).toEqual([])
  })

  test("取消后迟到的回执不会被下一条调用收下：回执只认自己的 requestId/自己的文件", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    // 第一次调用永远不写回执（silent），在菜单调用里取消；随后把"第一次那份迟到的回执"塞回去。
    const controller = new AbortController()
    let firstRequestPath = ""
    const unity = fakeUnity({ document, mode: "silent", onRequest: path => { firstRequestPath = path }, onMenu: async () => { controller.abort() } })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 5_000, pollMs: 5 })
    const pending = exchange.readScene({ sceneId: "scene_acc" }, { signal: controller.signal })
    const error = await pending.then(() => { throw new Error("EXPECTED_UNITY_WAIT_CANCELLED_BUT_RESOLVED") }, reason => reason as Error)
    expect(error).toBeInstanceOf(UnityExchangeCancelled)
    const firstRequest = firstRequestPath.slice(firstRequestPath.lastIndexOf("/") + 1).replace(/\.json$/, "")
    expect(firstRequest).toStartWith("lx-")
    // 迟到的回执：内容与"本次会话"无关（0 个节点），文件路径是**第一次**那份请求的。
    const lateDocument = join(unity.scratch, "late.json")
    const results = join(unity.scratch, "results")
    await writeFile(lateDocument, JSON.stringify({ ...document, nodes: [] }))
    await mkdir(results, { recursive: true })
    await writeFile(join(results, `${firstRequest}.json`), JSON.stringify({ requestId: firstRequest, op: "export", ok: true, errors: [], warnings: [], projectRoot: unityProject, export: { scenePath: document.scenePath, documentPath: lateDocument, nodeCount: 0, rootCount: 0, assetCount: 0, meshFileCount: 0, documentBytes: 2, losses: [] } }))

    // 第二次调用：它必须拿它自己那份请求的回执，而不是第一次迟到的。
    const working = fakeUnity({ document })
    const second = new UnitySceneExchange(operations, working.port, { projectPath: unityProject, timeoutMs: 3_000, pollMs: 5 })
    const report = await second.readScene({ sceneId: "scene_acc" })

    expect(report.entities).toBe(5)                       // 不是迟到回执的 0 个节点
    expect(report.documentPath).not.toBe(lateDocument)
    expect(working.executed.length).toBe(1)
  })
})

describe("84 身份窄更新：按 identity 更新 Unity 负责的字段，用户的东西留着，真删才删，CAS 冲突如实报", () => {
  test("第二次读取只写交换负责的字段：用户加的组件、自定义字段、自己挂的子对象都原样保留", async () => {
    const document = unityDocument()
    const { exchange } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })
    const first = await operations.inspect("scene_acc")
    // 用户在产品侧：在 Unity 对象上加批注组件、加自定义字段，并挂一个自己的子对象。
    const lamp = entityOf(first.entities, "entity_unity_lamp")
    const userChild = userEntity("entity_user_note", "entity_unity_site:node:0")
    const edited = await operations.scene.commit({
      sceneId: "scene_acc", expectedRevision: first.revision,
      patch: [
        { op: "update", entityId: "entity_unity_lamp", changes: { components: { ...lamp.components, annotation: { note: "用户批注", color: "#ff0" }, userTool: { nested: [1, 2, 3] } } } },
        { op: "add", entity: userChild },
      ],
    })
    // Unity 侧同时改了灯的位置（这次读取要更新的就是这个）。
    document.nodes[2]!.position = [3.5, 4.5, -1.5]

    const second = await exchange.readScene({ sceneId: "scene_acc" })

    const after = await operations.inspect("scene_acc")
    const afterLamp = entityOf(after.entities, "entity_unity_lamp")
    // Unity 负责的字段按 Unity 更新（灯的位置换成新值，父链不动）。
    expect([...afterLamp.transform.position]).toEqual(referenceSwap([3.5, 4.5, -1.5]))
    expect(afterLamp.parentId).toBe("entity_unity_pole")
    expect(second.sync!.updated).toEqual(["entity_unity_lamp"])
    expect(second.sync!.removed).toEqual([])
    // 用户加的组件键一个不少（交换只动 unity/light/visual/environment）。
    expect(afterLamp.components.annotation).toEqual({ note: "用户批注", color: "#ff0" })
    expect(afterLamp.components.userTool).toEqual({ nested: [1, 2, 3] })
    expect(unityOf(afterLamp).globalId).toBe(document.nodes[2]!.globalId)
    // 用户自己挂的子对象还在原位（挂在交换展开出来的节点下）。
    expect(entityOf(after.entities, "entity_user_note").parentId).toBe("entity_unity_site:node:0")
    expect(entityOf(after.entities, "entity_user_note").components.annotation).toEqual({ note: "用户自己挂的（不是交换范围）" })
    expect(second.sync!.kept).toContain("entity_user_note")
    expect(after.revision).toBe(edited.revision + 1)
  })

  test("来源真删了才删：Unity 里删掉的节点与展开子节点按 id 精确删除；别的场景的对象与用户子对象都不跟着死", async () => {
    const document = unityDocument()
    const { exchange } = await sceneWith(document)
    await exchange.readScene({ sceneId: "scene_acc" })
    const first = await operations.inspect("scene_acc")
    // 用户挂一个子对象到交换展开的几何节点下；再放一个"别的 Unity 场景"的对象（另一个 GUID 前缀）。
    await operations.scene.commit({
      sceneId: "scene_acc", expectedRevision: first.revision,
      patch: [
        { op: "add", entity: userEntity("entity_user_note", "entity_unity_site:node:0") },
        { op: "add", entity: { ...userEntity("entity_other_scene", "entity_user_note"), components: { unity: { globalId: "GlobalObjectId_V1-2-other-scene-guid-1-0", namespace: "unity" }, annotation: { note: "另一个 Unity 场景的对象" } } } },
      ],
    })
    // Unity 侧把"场地"整个删掉（灯杆改挂到根，顶灯仍挂在灯杆下）：来源没了，交换对象与它展开出来的子节点才该删。
    document.nodes.shift()
    document.nodes[0]!.parentIndex = -1
    document.nodes[1]!.parentIndex = 0
    document.nodes.forEach((node, index) => { node.index = index })   // 真文档里 index 与 parentIndex 同一套编号

    const second = await exchange.readScene({ sceneId: "scene_acc" })

    const after = await operations.inspect("scene_acc")
    const ids = after.entities.map(entity => entity.entityId)
    expect(ids).not.toContain("entity_unity_site")
    expect(ids).not.toContain("entity_unity_site:source")
    expect(ids).not.toContain("entity_unity_site:node:0")
    expect(second.sync!.removed.sort()).toEqual(["entity_unity_site", "entity_unity_site:node:0", "entity_unity_site:source"])
    expect(second.losses.join("\n")).toMatch(/UNITY_SCENE_GHOSTS_REMOVED/)
    // 没被删的交换对象照常更新（父从被删的场地改成根），不是整棵重建。
    expect(entityOf(after.entities, "entity_unity_pole").parentId).toBeUndefined()
    expect(entityOf(after.entities, "entity_unity_lamp").parentId).toBe("entity_unity_pole")
    // 用户挂在被删对象下的子对象：改挂到最近还活着的祖先（这里被删到根了），不是跟着死。
    expect(entityOf(after.entities, "entity_user_note").parentId).toBeUndefined()
    expect(entityOf(after.entities, "entity_user_note").components.annotation).toEqual({ note: "用户自己挂的（不是交换范围）" })
    // 另一个 Unity 场景的对象不在本次交换范围内：不删、不动。
    expect(entityOf(after.entities, "entity_other_scene").components.unity).toEqual({ globalId: "GlobalObjectId_V1-2-other-scene-guid-1-0", namespace: "unity" })
    expect(second.sync!.reparented).toContain("entity_user_note")   // 改挂，不是删除
    expect(second.sync!.kept).toEqual(["entity_other_scene"])       // 别的场景的对象原样不动
    expect(second.losses.join("\n")).toMatch(/UNITY_USER_CHILDREN_KEPT/)
  })

  test("删来源父对象时保留用户子对象的**世界位姿**：平移+旋转+非均匀缩放的父链，用户子树一起走（真 SceneStore 提交）", async () => {
    // 真实反例（根探针）：父 world x=10、子 local x=1，父被删后只 reparent 不改 transform，
    // 子对象 id 还在、世界位置却从 x=11 掉到 x=1。这里按"改挂前的世界矩阵 × 新父提交后世界的逆"核对。
    const sceneGuid = "pose-scene-guid"
    await poseScene(sceneGuid)
    const before = await operations.inspect("scene_pose")
    const childWorldBefore = worldMatrix(before, "entity_user_child")
    const grandWorldBefore = worldMatrix(before, "entity_user_grandchild")

    // Unity 侧这次只采到"舞台"（它自己也没动）：它下面的 "灯柱" 没了 → 用户子对象改挂到舞台。
    const stage = entityOf(before.entities, "entity_unity_stage")
    const losses: string[] = []
    const plan = planUnitySync(before, [stage], { sceneGuid, losses })
    expect(plan.removed).toEqual(["entity_unity_pillar"])
    expect(plan.reparented).toEqual(["entity_user_child"])
    const after = await operations.scene.commit({ sceneId: "scene_pose", expectedRevision: before.revision, patch: plan.patch })

    // 世界位姿逐元素一致（父链带旋转与非均匀缩放，局部变换必须重算而不是原样搬过去）。
    expect(entityOf(after.entities, "entity_user_child").parentId).toBe("entity_unity_stage")
    expect(matrixClose(worldMatrix(after, "entity_user_child"), childWorldBefore)).toBe(true)
    expect(matrixClose(worldMatrix(after, "entity_user_grandchild"), grandWorldBefore)).toBe(true)
    expect(losses.join("\n")).toMatch(/UNITY_USER_CHILDREN_KEPT/)
    expect(losses.join("\n")).not.toMatch(/UNITY_USER_CHILD_POSE_SHEAR/)
  })

  test("最近存活祖先在同一批被 Unity 更新：改挂的目标帧按**提交后**算（子对象不会跟着父多动一次）", async () => {
    const sceneGuid = "pose-scene-guid"
    await poseScene(sceneGuid)
    const before = await operations.inspect("scene_pose")
    const childWorldBefore = worldMatrix(before, "entity_user_child")
    // 同一个批次里 Unity 也把"舞台"挪了：目标帧必须用它的新世界矩阵，否则子对象会再叠一次父的位移。
    const moved = { ...entityOf(before.entities, "entity_unity_stage"), transform: { position: [7, -4, 2] as [number, number, number], quaternion: rot([1, 0, 1], 33), scale: [1, 1, 1] as [number, number, number] } }
    const plan = planUnitySync(before, [moved], { sceneGuid, losses: [] as string[] })
    const after = await operations.scene.commit({ sceneId: "scene_pose", expectedRevision: before.revision, patch: plan.patch })
    expect(matrixClose(worldMatrix(after, "entity_user_child"), childWorldBefore)).toBe(true)
    // 反面：用**旧**父帧算出来的局部变换会让孩子跟着父多走一次（这就是"父动了还按旧帧"的错法）。
    const naive = worldMatrix(before, "entity_unity_stage").clone().invert().multiply(childWorldBefore)
    expect(matrixClose(matrixOf(entityOf(after.entities, "entity_user_child").transform), naive)).toBe(false)
  })

  test("非均匀缩放叠加旋转装不下时：**不**改用户对象（局部变换一个字节不动），把被删的祖先链留作普通结构节点，世界矩阵逐元素不变", async () => {
    // 100 真机 D6 的真实形态：改挂目标的局部矩阵含剪切，单个 TRS 装不下。
    // 旧行为是"近似一个 TRS 再写一条 SHEAR 警告"——那等于同步主动改了用户对象的形状（实测偏差 0.798）。
    // 现在：装不下就走"保留原帧"——被删的祖先链剥掉交换身份留作普通结构节点，用户对象一个字都不动。
    const sceneGuid = "pose-shear-guid"
    await operations.create({ sceneId: "scene_shear" })
    const identity = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }
    const before = await operations.scene.commit({
      sceneId: "scene_shear", expectedRevision: 0,
      patch: [
        { op: "add", entity: { entityId: "entity_unity_pillar", name: "灯柱", transform: { ...identity, scale: [2, 3, 1] }, resources: [], components: { unity: { globalId: `GlobalObjectId_V1-2-${sceneGuid}-1-0` } } } },
        // 子对象带旋转：父的非均匀缩放先作用在它身上 → 世界矩阵是 S·R，单个 TRS 装不下（要剪切）。
        { op: "add", entity: { entityId: "entity_user_child", parentId: "entity_unity_pillar", name: "用户注释牌", transform: { ...identity, position: [1, 0, 0], quaternion: rot([0, 0, 1], 45), scale: [1.25, 0.8, 1.1] }, resources: [], components: { annotation: { note: "别丢我" } } } },
      ] as any,
    })
    const childWorldBefore = worldMatrix(before, "entity_user_child")
    const childTransformBefore = JSON.stringify(entityOf(before.entities, "entity_user_child").transform)
    const losses: string[] = []
    const plan = planUnitySync(before, [], { sceneGuid, losses })
    const after = await operations.scene.commit({ sceneId: "scene_shear", expectedRevision: before.revision, patch: plan.patch })
    // 用户对象：局部变换（含缩放）逐字没变，世界矩阵逐元素一致 —— 不是"位置保住、形状近似"。
    expect(JSON.stringify(entityOf(after.entities, "entity_user_child").transform)).toBe(childTransformBefore)
    expect(matrixClose(worldMatrix(after, "entity_user_child"), childWorldBefore)).toBe(true)
    // 被删的祖先没被删：剥掉交换身份（写回不会再当来源对象交付），留作可审计的普通结构节点。
    expect(plan.removed).toEqual([])
    expect(plan.framesKept).toEqual(["entity_unity_pillar"])
    const frame = entityOf(after.entities, "entity_unity_pillar")
    expect(frame.components.unity).toBeUndefined()
    expect((frame.components as { unityFrame?: { keptFrom?: string } }).unityFrame?.keptFrom).toBe("entity_unity_pillar")
    expect(matrixClose(matrixOf(frame.transform), matrixOf(entityOf(before.entities, "entity_unity_pillar").transform))).toBe(true)
    expect(losses.join("\n")).toMatch(/UNITY_USER_CHILD_FRAMES_KEPT/)
    expect(losses.join("\n")).not.toMatch(/UNITY_USER_CHILD_POSE_SHEAR/)
  })

  test("同一批里 Unity 新增了祖先：改挂的用户子对象按**提交后**的完整层级算（新增/改父/删除都在模型里，不只看旧实体）", async () => {
    // 真实反例（根探针 root-100-new-ancestor-probe）：before grand x10 → parent x2 → user x1（世界 13）；
    // 同一批里新增 new_root x100、grand 挂到 new_root 下 local 20、parent 被删。
    // 只映射 before.entities 的"批后"模型里 grand 的父链是断的 → 算出 local -7 → 提交后用户世界变成 113，
    // 而回执还写着"世界位姿保留"。这里按提交后的真层级核对用户的世界矩阵。
    const sceneGuid = "new-ancestor-guid"
    await operations.create({ sceneId: "scene_new_ancestor" })
    const identity = { quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }
    const unityAt = (entityId: string, x: number, parentId?: string) =>
      ({ entityId, name: entityId, ...(parentId ? { parentId } : {}), transform: { ...identity, position: [x, 0, 0] as [number, number, number] }, resources: [], components: { unity: { globalId: `GlobalObjectId_V1-2-${sceneGuid}-${entityId}` } } })
    const before = await operations.scene.commit({
      sceneId: "scene_new_ancestor", expectedRevision: 0,
      patch: [
        { op: "add", entity: unityAt("grand", 10) },
        { op: "add", entity: unityAt("parent", 2, "grand") },
        { op: "add", entity: { entityId: "entity_user_leaf", parentId: "parent", name: "用户叶子", transform: { ...identity, position: [1, 0, 0] }, resources: [], components: { annotation: { note: "保留" } } } },
      ] as any,
    })
    const leafWorldBefore = worldMatrix(before, "entity_user_leaf")
    const losses: string[] = []
    const plan = planUnitySync(before, [unityAt("new_root", 100) as any, unityAt("grand", 20, "new_root") as any], { sceneGuid, losses })
    const after = await operations.scene.commit({ sceneId: "scene_new_ancestor", expectedRevision: before.revision, patch: plan.patch })
    expect(entityOf(after.entities, "entity_user_leaf").parentId).toBe("grand")
    expect(matrixClose(worldMatrix(after, "entity_user_leaf"), leafWorldBefore)).toBe(true)
    // 用户那条改挂只算一次（Unity 自己把 grand 改挂到 new_root 不算"非交换子节点"）。
    expect(plan.userReparented).toEqual(["entity_user_leaf"])
    expect(losses.join("\n")).toMatch(/UNITY_USER_CHILDREN_KEPT: 1 个非交换子节点/)
  })


  test("读取期间别人提交了产品场景：CAS 冲突如实报错，不覆盖别人的改动也不留下半成品", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    let menuCalls = 0
    const unity = fakeUnity({
      document,
      onMenu: async () => {
        menuCalls++
        // 只在第二次读取期间插一次别人的提交（第一次是正常读入）。
        if (menuCalls !== 2) return
        const current = await operations.inspect("scene_acc")
        await operations.scene.commit({
          sceneId: "scene_acc", expectedRevision: current.revision,
          patch: [{ op: "update", entityId: "entity_unity_lamp", changes: { components: { ...entityOf(current.entities, "entity_unity_lamp").components, annotation: { note: "并发写入者的批注" } } } }],
        })
      },
    })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 2_000, pollMs: 5 })
    await exchange.readScene({ sceneId: "scene_acc" })
    const before = await operations.inspect("scene_acc")
    // 这次读取本来会落地一个改动（灯挪了位置），于是读取期间的并发提交才会撞上 CAS。
    document.nodes[2]!.position = [7, 7, 7]

    await expect(exchange.readScene({ sceneId: "scene_acc" })).rejects.toThrow(/SCENE_REVISION_CONFLICT|已是版本/)

    const after = await operations.inspect("scene_acc")
    // 冲突的那次没有落地：版本停在别人提交后那一版，别人的字段还在。
    expect(after.revision).toBe(before.revision + 1)
    expect(entityOf(after.entities, "entity_unity_lamp").components.annotation).toEqual({ note: "并发写入者的批注" })
  })
})

describe("84 目标绑定：绑定到实际 MCP 目标，项目不一致宁可不做", () => {
  test("实例清单里工程匹配的那一个被显式绑定（原生 set_active_instance），执行回执自报工程与请求一致", async () => {
    const document = unityDocument()
    const { exchange, unity } = await sceneWith(document)

    const report = await exchange.readScene({ sceneId: "scene_acc" })

    expect(unity.bindings).toEqual(["UnityMCPStarter@114e4a37"])
    expect(report.binding).toMatchObject({ bound: true, instance: "UnityMCPStarter@114e4a37", projectRoot: unityProject, instances: 1 })
    expect(unity.calls.filter(call => call.tool === UNITY_SET_ACTIVE_INSTANCE_TOOL).length).toBe(1)
  })

  test("在跑的实例都不是这个工程：在写请求文件之前就拒绝（不留请求、不触发菜单、不碰产品场景）", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const unity = fakeUnity({ document, instances: [{ id: "AnotherProject@deadbeef", projectPath: "/srv/other-project", port: 6411 }] })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 200, pollMs: 5 })

    const error = await exchange.readScene({ sceneId: "scene_acc" }).catch(none => none) as Error

    expect(error).toBeInstanceOf(UnityProjectMismatch)
    expect(error.message).toMatch(/不默认改用另一个项目/)
    expect((error as unknown as { detail: { requested: string; actual: string } }).detail.requested).toBe(normalizePath(unityProject))
    expect((error as unknown as { detail: { actual: string } }).detail.actual).toBe("/srv/other-project")
    expect(unity.calls).toEqual([])
    expect(await namesIn(join(unity.scratch, "requests"))).toEqual([])
    expect((await operations.inspect("scene_acc")).entities).toEqual([])
  })

  test("显式指定了实例、可它的工程不是请求的工程：明确报错，不默认打到那个项目", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    const unity = fakeUnity({
      document,
      instances: [
        { id: "UnityMCPStarter@114e4a37", projectPath: unityProject, port: 6400 },
        { id: "AnotherProject@deadbeef", projectPath: "/srv/other-project", port: 6411 },
      ],
    })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, instance: "AnotherProject@deadbeef", timeoutMs: 200, pollMs: 5 })

    await expect(exchange.readScene({ sceneId: "scene_acc" })).rejects.toThrow(/UNITY_PROJECT_MISMATCH.*显式实例/s)

    expect(unity.calls).toEqual([])
  })

  test("受控边界反例：实例清单报的工程一致但执行回执自报的是另一个 → 拒绝收下这次结果并点名实际工程", async () => {
    const document = unityDocument()
    await writeUnityMeshFile(document, glbForUnityMesh())
    await operations.create({ sceneId: "scene_acc" })
    // 编排出来的"打错项目"现场：清单/路径都对得上，但真正执行的那台编辑器自报是别的工程。
    const unity = fakeUnity({ document, receiptProjectRoot: "/srv/other-project" })
    const exchange = new UnitySceneExchange(operations, unity.port, { projectPath: unityProject, timeoutMs: 2_000, pollMs: 5 })

    const error = await exchange.readScene({ sceneId: "scene_acc" }).catch(none => none) as Error

    expect(error).toBeInstanceOf(UnityProjectMismatch)
    expect((error as unknown as { detail: { actual: string } }).detail.actual).toContain("/srv/other-project")
    expect(error.message).toMatch(/pid 4242/)
    // 结果没有被当成"本次交换"用掉：产品场景一个实体都没写。
    expect((await operations.inspect("scene_acc")).entities).toEqual([])
    expect((await operations.inspect("scene_acc")).revision).toBe(0)
  })

  test("实例清单按真机形状解析：path 是 …/Project/Assets，工程根取它的父目录；缺字段不编", () => {
    const parsed = parseInstances(instancesResource([{ id: "UnityMCPStarter@114e4a37", projectPath: unityProject, port: 6400 }, { id: "NoPath@0" }]).contents[0]!.text)
    expect(parsed).toEqual([
      { id: "UnityMCPStarter@114e4a37", port: 6400, projectPath: unityProject, status: "running" },
      { id: "NoPath@0", port: 6400, status: "running" },
    ])
    expect(parseInstances({ instances: "nope" })).toEqual([])
    expect(parseInstances(undefined)).toEqual([])
  })
})
