/**
 * Unity ↔ Scene 交换（ENV-26/27）：把真实 Unity 场景与产品的 Scene 文档互相搬运，
 * 空间、层级、身份、资源都真正转换，损失逐条写明。
 *
 * 三层结构，各自只做一件事：
 *   1. **Unity 侧**（packages/scene-kit/unity/Editor/LyapunovSceneExchange.cs）：只做 Unity 原生的事
 *      ——遍历层级、量化读数、写 GLB、按二进制建 Mesh。它不认识产品坐标：文档里的一切变换都是
 *      **Unity 原生空间**（米、左手、Y-up、xyzw）。
 *   2. **本文件**：唯一 owner 的空间换算（位置/旋转/层级）、组件映射、身份与损失的判定，
 *      以及产品侧落盘——资源走既有 ResourceLibrary，实体走既有 SceneStore.commit，不另建一套。
 *   3. **传输**：Unity 侧唯一入口是原生菜单项 `Tools/Lyapunov Scene Exchange/Run Request`，
 *      产品侧经 DSH 原生 MCP（`mcp__unity__execute_menu_item`）触发，请求/结果各一个 JSON 文件。
 *      不新造 JSON-RPC 通道、不自己连 socket。
 *
 * ## 空间（本文件是唯一 owner；已数值验证）
 * 产品 = 右手 Z-up 米制；Unity = 左手 Y-up 米制。两者的映射是同一个线性映射
 *   M: (x,y,z) → (x,z,y)     （轴交换，自逆，det=−1）
 * 于是：
 *   - 位置/方向：p_prod = M·p_unity，同一个函数双向可用；
 *   - 旋转：q_prod = qx90 ⊗ m(q_unity) ⊗ qx90⁻¹，其中 m(q)=(−qx,−qy,qz,qw)、qx90=(√2/2,0,0,√2/2)。
 *     这是**共轭**（C(A⊗B)=C(A)⊗C(B)），所以层级无需逐层重算；公式自逆，双向同一函数；
 *     用 300 组随机四元数核对到 1e-16，语义核对（Unity 前向 vs 产品朝向）同样到 1e-16；
 *   - 缩放：跟着轴换位（同一次线性映射下局部 TRS 的共轭结果）；
 *   - 层级：父子逐层保留；本文件另把世界矩阵折出来，中间被跳过的结构节点因此不影响结果；
 *   - 几何字节：M 是镜像，顶点随 M 走、绕序翻一次（Unity 侧 GLB 写出器与本文件的 LPMESH
 *     写出器各翻一次，往返即回到原绕序）。
 *
 * ## 身份
 * Unity 对象上的 `LyapunovEntityIdentity` 组件存产品 entityId：导入时写入、导出时优先读它；
 * 没有该组件的对象按 GlobalObjectId 派生 `entity_unity_<hash>`。同一对象反复交换身份稳定，
 * 因此重复导出是"刷新同一批实体"而不是不断新增。资源 id 同样派生，命中资源库内容去重。
 *
 * ## 落地范围与损失
 * 真落地：层级+变换、网格（GLB↔LPMESH 双向真几何）、材质（baseColor/metallic/smoothness）、
 * 灯（映射到 Viewer 真渲染的 components.light）、相机/预制体元数据、**地形**（高度图 → 可渲染网格 GLB +
 * 层混合烘焙出的等价漫反射贴图 + 孔洞）与**植被**（每个用到的原型一份共享 GLB，树实例只带位置/朝向/缩放）。
 * 逐条损失写在文档 loss 列表与实体 `components.unity.losses` 里（地形法线/遮罩/逐层 smoothness、
 * 逐树着色、贴图字节、蒙皮、动画、粒子、物理、脚本、多子网格等），不假装完整。
 *
 * ## 地形与植被的闭包与写回
 * 高度**只在网格顶点**里交付（侧车原始 float32 只在 Unity 工程内，是调试副本）：产品导入后就是自己资源库里的
 * 一个网格资源 + 贴图资源，不依赖 Unity Library 的绝对路径，搬到别的 Host 也开得起来。
 * 写回时高度按"交付网格 → 地形格点"的格点映射重算、孔洞按缺失三角格反推、树按 `components.unity.terrainTree`
 * 折回 `terrainData.treeInstances`（原型仍是项目内既有 prefab，连接保留）。植被实体是产品里看得见、能改的对象，
 * 但它们**不是** Unity 场景对象：`instances` 只有被标为权威（`treeInstancesAuthoritative`）时才改 Unity 的树。
 *
 * ## 明确不做
 * 不建第二个任务状态/路由框架；不改 plugin.ts/operations.ts/runtime-patch；不复制 Unity 的
 * MCP 连接（调用方注入 port）；不建第二套地形数据库/渲染器（地形/植被就是既有资源库 + 既有实体树）。
 */
import { createHash, randomUUID } from "node:crypto"
import { readFile, mkdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Matrix4, Quaternion, Vector3 } from "three"
import { defineTool } from "@deepseek-ai/dsh-tools"
import type { ParameterSchemaSpec } from "@deepseek-ai/dsh-tools"
import type { Context } from "@deepseek-ai/cordis"
import type { Entity, ResourceRef, ScenePatch, SceneSnapshot, Transform, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { atomicJSON } from "./persistence.ts"
import { glbEntities } from "./formats.ts"
import type { ResourceRecord } from "./resources.ts"
import type { SceneOperations } from "./operations.ts"

/** 交换文档的唯一 kind/version：Unity 侧逐字核对，不匹配就拒绝。 */
export const UNITY_SCENE_KIND = "lyapunov.unity-scene"
export const UNITY_SCENE_VERSION = 1
/** Unity 侧唯一执行入口（原生菜单项，经 mcp__unity__execute_menu_item 触发）。 */
export const UNITY_EXCHANGE_MENU = "Tools/Lyapunov Scene Exchange/Run Request"
/** Unity 工程内暂存目录（不进版本控制、不进 Assets）。 */
export const UNITY_EXCHANGE_SCRATCH = "Library/LyapunovSceneExchange"
/** 原生 MCP 资源：编辑器自报的工程信息（工程根从这里发现）。 */
export const UNITY_PROJECT_INFO_URI = "mcpforunity://project/info"
/** 原生 MCP 资源：MCP for Unity 自报的实例清单（id=Name@hash、port、path）。 */
export const UNITY_INSTANCES_URI = "mcpforunity://instances"
/**
 * 原生 MCP 工具：实例绑定（服务器级设置）。`execute_menu_item` 的参数表里**只有** menu_path，
 * 实例只能经这个既有工具选（Name@hash / hash 前缀 / 端口）。不新造 RPC、不默认另一项目。
 */
export const UNITY_SET_ACTIVE_INSTANCE_TOOL = "set_active_instance"
/**
 * 交换协议的请求/结果目录（相对 scratch）。文件名就是 requestId，因此**并行调用互不覆盖**：
 * 这是"每次唯一路径"而不是共享 request.json/result.json。编辑器侧靠 rename 认领（见 C# DrainPendingRequests）。
 */
export const UNITY_EXCHANGE_REQUESTS = "requests"
export const UNITY_EXCHANGE_RESULTS = "results"
/** 交换用 GLB 的源坐标声明：Unity 侧写出时已烘焙到产品空间，因此是恒等适配。 */
export const PRODUCT_SPACE_SOURCE: ResourceRef["source"] = { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 }
/** 网格实体 components.visual 的 kind（产品既有约定）。 */
type Visual = { kind?: string; gltfNode?: number; sourceTransformApplied?: boolean }

// ────────────────────────────────────────────────────────────────────────────
// 1. 空间换算（纯函数）
// ────────────────────────────────────────────────────────────────────────────

/** 轴交换矩阵；自逆、det=−1。产品 ↔ Unity 的互相映射都是它。 */
const AXIS_SWAP = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1)
const X90 = new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2)
const X90_INVERSE = X90.clone().invert()
/** 镜像共轭 m(q)：轴分量 x/y 反号，z 与 w 不变。 */
const mirror = (q: Quaternion): Quaternion => new Quaternion(-q.x, -q.y, q.z, q.w)

/** 位置/方向换算：两个方向同一个函数（对合）。 */
export function swapUpAxis(p: readonly number[]): Vec3 { return [p[0]!, p[2]!, p[1]!] }

/** 旋转换算：两个方向同一个函数（对合）。 */
export function convertQuaternion(q: readonly number[]): [number, number, number, number] {
  const converted = X90.clone().multiply(mirror(new Quaternion(q[0], q[1], q[2], q[3]))).multiply(X90_INVERSE).normalize()
  return [converted.x, converted.y, converted.z, converted.w]
}

/**
 * 完整变换换算（位置+旋转+缩放），两个方向同一个函数。
 *
 * 缩放也走轴交换，不是"两侧都是无量纲倍数所以不换算"：几何是**按 M 映射**交付的
 * （Unity 侧 GLB 已烘焙到产品空间、产品侧 LPMESH 是 M⁻¹ 后的原始顶点），所以局部 TRS 必须整体共轭
 *   M⁻¹·(T·R·S)·M = T_{M p} · conj(R) · diag(sx, sz, sy)
 * —— 缩放的分量跟着轴换位；不换位时非均匀缩放的物体会被拉伸到错的轴
 * （真实例子：Unity 里 scale=(1,2,3) 的立方体，产品里必须沿 Z 有 3 米、沿 Y 有 2 米）。
 * 三个分量只是换位，行列式不变，因此不影响镜像判定。
 */
export function convertTransform(transform: Transform): Transform {
  return { position: swapUpAxis(transform.position), quaternion: convertQuaternion(transform.quaternion), scale: swapUpAxis(transform.scale) }
}

function localMatrix(transform: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale))
}

/**
 * 一棵树在地形**局部**空间里的变换（Unity 原生空间，还没做轴换算）。
 *
 * Unity 的 `TreeInstance` 只有归一化位置 + 绕 Y 的旋转 + 宽/高两个缩放：位置 x/z 是相对地形原点的
 * 0..1（× size.x/size.z 得米），y 也是归一化的 0..1（× size.y 得米，不是"高度比例"）；缩放是
 * (widthScale, heightScale, widthScale) —— 树在水平方向只能等比缩放，交付时不许把它写成三轴各异。
 */
export function treeInstanceTransform(instance: UnityTreeInstanceRecord, terrain: Pick<UnityTerrainRecord, "widthM" | "heightM" | "lengthM">): Transform {
  const half = instance.rotationRad / 2
  return {
    position: [instance.position[0]! * terrain.widthM, instance.position[1]! * terrain.heightM, instance.position[2]! * terrain.lengthM],
    quaternion: [0, Math.sin(half), 0, Math.cos(half)],
    scale: [instance.widthScale, instance.heightScale, instance.widthScale],
  }
}

/** 世界矩阵：把实体到根的整条链（含被跳过的结构节点）折进去。 */
export function worldMatrix(snapshot: SceneSnapshot, entityId: string): Matrix4 {
  const byId = new Map(snapshot.entities.map(entity => [entity.entityId, entity]))
  const chain: Entity[] = []
  const seen = new Set<string>()
  let current = byId.get(entityId)
  if (!current) throw new Error(`ENTITY_NOT_FOUND: ${entityId}`)
  while (current) {
    if (seen.has(current.entityId)) throw new Error(`HIERARCHY_CYCLE: ${current.entityId}`)
    seen.add(current.entityId)
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  const matrix = new Matrix4()
  for (const entity of chain) matrix.multiply(localMatrix(entity.transform))
  return matrix
}

/** 产品世界矩阵 → Unity 世界变换（共轭：W_unity = M⁻¹·W_prod·M）。 */
export function unityTransformFromProductWorld(matrix: Matrix4): { transform: Transform; mirrored: boolean } {
  const converted = AXIS_SWAP.clone().invert().multiply(matrix).multiply(AXIS_SWAP)
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
  converted.decompose(position, quaternion, scale)
  return {
    transform: { position: position.toArray() as Vec3, quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w], scale: scale.toArray() as Vec3 },
    // 镜像（负世界行列式）在 Unity 侧同样是合法的负缩放，但必须让调用方知道，作为损失写明。
    mirrored: converted.determinant() < 0,
  }
}

/** Unity 世界变换 → 产品世界矩阵（上述共轭的逆，测试与调试用）。 */
export function productWorldFromUnityTransform(transform: Transform): Matrix4 {
  return AXIS_SWAP.clone().multiply(localMatrix(transform)).multiply(AXIS_SWAP.clone().invert())
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 组件映射
// ────────────────────────────────────────────────────────────────────────────

/** 产品 components.light 的 kind：Viewer 真渲染的四种。 */
export type ProductLightKind = "sun" | "area" | "spot" | "point"
/**
 * Unity 光强 ↔ 产品 energy 的换算系数。产品的 energy 不是光度学单位，而是 Viewer 在每种灯上
 * 再除一次的数（sun 原样、area /250、spot/point /25）：乘回这个系数，才让"Unity 里看到的强度"
 * 与"产品渲染出的强度"是同一个数，不伪造物理精度。
 */
export const LIGHT_ENERGY_SCALE: Record<ProductLightKind, number> = { sun: 1, area: 250, spot: 25, point: 25 }
const UNITY_LIGHT_TYPE: Record<ProductLightKind, string> = { sun: "Directional", area: "Rectangle", spot: "Spot", point: "Point" }
/** 与 Viewer 一致的钳制上限；超过它渲染会暗于 Unity，作为损失写明。 */
const LIGHT_ENERGY_CLAMP: Record<ProductLightKind, number> = { sun: 6, area: 8, spot: 40, point: 40 }

export interface UnityLightRecord { type: string; color: number[]; intensity: number; range: number; spotAngleDeg: number; areaSize: number[]; shadows: string; bounceIntensity: number; enabled: boolean }

export function productLightKindOf(type: string): ProductLightKind {
  if (type === "Directional") return "sun"
  if (type === "Spot") return "spot"
  if (type === "Point") return "point"
  return "area"
}

/** Unity 灯 → 产品 components.light；方向用灯的 Unity 世界前向换算（灯沿 transform.forward 出射）。 */
export function unityLightToProduct(light: UnityLightRecord, worldForwardUnity: Vec3): { component: Record<string, unknown>; losses: string[] } {
  const losses: string[] = []
  const kind = productLightKindOf(light.type)
  if (kind === "area" && light.type !== "Rectangle" && light.type !== "Disc") losses.push(`LIGHT_TYPE_MAPPED: Unity ${light.type} 按面光源映射，产品只区分 sun/area/spot/point`)
  const energy = Math.max(0, light.intensity) * LIGHT_ENERGY_SCALE[kind]
  if (energy > LIGHT_ENERGY_CLAMP[kind]) losses.push(`LIGHT_ENERGY_CLAMPED: ${kind} 强度 ${light.intensity} 换算后为 ${energy}，超过 Viewer 上限 ${LIGHT_ENERGY_CLAMP[kind]}，渲染会暗于 Unity`)
  if (light.shadows && light.shadows !== "None") losses.push(`LIGHT_SHADOWS_NOT_TRANSFERRED: Unity 阴影设置(${light.shadows})不进产品，渲染用 Viewer 自己的策略`)
  if (light.bounceIntensity > 0 && light.bounceIntensity !== 1) losses.push(`LIGHT_BOUNCE_NOT_TRANSFERRED: 间接光反弹 ${light.bounceIntensity} 未交换`)
  // 产品的 light 组件没有距离衰减范围（Viewer 的 spot/point 用 distance=0 无限远），Unity 的 range 无处安放。
  if ((kind === "point" || kind === "spot") && light.range) losses.push(`LIGHT_RANGE_NOT_TRANSFERRED: Unity ${light.type} 灯的 range=${light.range} 不进产品（Viewer 的点/聚光灯不做距离衰减截断）`)
  if (light.color?.[3] !== undefined && light.color[3] !== 1) losses.push(`LIGHT_COLOR_ALPHA_DROPPED: Unity 灯色 alpha=${light.color[3]} 对灯光渲染无意义，产品只保留 RGB`)
  const component: Record<string, unknown> = {
    kind,
    // 产品按线性解读颜色，Unity 灯色同样是线性：原样传递，不做二次色彩空间转换。
    color: [light.color?.[0] ?? 1, light.color?.[1] ?? 1, light.color?.[2] ?? 1],
    energy,
    direction: swapUpAxis(worldForwardUnity),
    ...(kind === "spot" ? { spotSizeRad: ((light.spotAngleDeg || 30) * Math.PI) / 180 } : {}),
    ...(kind === "area" && light.areaSize?.[0] ? { sizeM: light.areaSize[0] } : {}),
  }
  return { component, losses }
}

/** 产品 components.light → Unity 灯记录（与上面的换算严格互逆）。 */
export function productLightToUnity(component: Record<string, unknown>, worldForwardProduct: Vec3): { light: UnityLightRecord; losses: string[] } {
  const losses: string[] = []
  const kind = String(component.kind ?? "point") as ProductLightKind
  const energy = typeof component.energy === "number" && Number.isFinite(component.energy) ? component.energy : 1
  const color = Array.isArray(component.color) ? component.color as number[] : [1, 1, 1]
  // 产品的 light 组件没有距离衰减范围（Viewer 的 spot/point 用 distance=0 无限远）：调用方若带了 rangeM，如实记为未交换。
  if (typeof component.rangeM === "number") losses.push(`LIGHT_RANGE_NOT_TRANSFERRED: rangeM=${component.rangeM} 不进 Unity（产品 light 组件没有这个量），Unity 侧按默认 10m 建灯`)
  return {
    losses,
    light: {
      type: UNITY_LIGHT_TYPE[kind] ?? "Point",
      color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, 1],
      intensity: energy / LIGHT_ENERGY_SCALE[kind],
      // Unity 的 range：产品侧没有这个量，写 Unity 默认值（点/聚光灯 10m），读方向的损失已如实记在 LIGHT_RANGE_NOT_TRANSFERRED。
      range: 10,
      spotAngleDeg: typeof component.spotSizeRad === "number" ? (component.spotSizeRad * 180) / Math.PI : 30,
      areaSize: typeof component.sizeM === "number" ? [component.sizeM, component.sizeM] : [1, 1],
      shadows: kind === "sun" ? "Soft" : "None",
      bounceIntensity: 1,
      enabled: true,
    },
  }
  // 注：世界前向由调用方按实体世界矩阵给出，Unity 侧灯朝向即 GameObject 朝向（与产品 direction 同一条换算）。
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 交换文档（字段名与 Unity 侧 JsonUtility 合同逐字一致）
// ────────────────────────────────────────────────────────────────────────────

export interface UnityMeshRecord {
  name: string; primitive: string; assetPath: string; assetGuid: string
  vertexCount: number; triangleCount: number; subMeshCount: number
  /** 与顶点数一致的 UV 个数（0 = 网格没有 UV，GLB 未写 TEXCOORD_0）。 */
  uvCount: number
  /** 顶点/法线/UV/索引按 1e-6 量化后的内容摘要：导入侧据此判"资产还是不是这份内容"，缺失不当作相同。 */
  contentDigest: string
  boundsCenter: number[]; boundsSize: number[]
  /** 网格载荷文件（Unity 项目相对路径）：fieldSpace 说明字节所在的空间。 */
  file: string; fileSpace: string; fileBytes: number
}
/** 材质上真实落地的贴图：字节已经落到产品侧（GLB 内嵌 + 文件副本），不是只有资产路径。 */
export interface UnityTextureRecord {
  property: string; assetPath: string; assetGuid: string; file: string
  mimeType: string; bytes: number; width: number; height: number
  wrapMode: string; contentDigest: string; reencoded: boolean
}
export interface UnityMaterialRecord {
  name: string; assetPath: string; assetGuid: string; shader: string
  baseColor: number[]; metallic: number; smoothness: number; textures: string[]
  textureFiles: UnityTextureRecord[]
}
/**
 * 场景级环境读数（Unity 侧 `RenderSettings` + 主相机背景 + 最亮方向光）。
 * 字段名与 `packages/viewer` 的 `SceneEnvironment`（45_environment_lighting 候选合同）是**最小映射**，
 * 不是同一份结构：只交换两边都有对应物的字段，其余在 `losses` 里逐条点名。
 */
export interface UnityEnvironmentRecord {
  present: boolean
  environmentIntensity: number; hemisphereIntensity: number; ambientMode: string
  background: string; backgroundColor: string; shadows: boolean
  sunAzimuthDeg: number; sunElevationDeg: number; sunIntensity: number; sunName: string
  dayNightEnabled: boolean; dayNightHours: number; dayNightCycleSeconds: number
  skyboxPath: string; skyboxShader: string
  hdriFile: string; hdriAssetPath: string; hdriBytes: number
  losses: string[]
}
export interface UnityCameraRecord { fieldOfViewDeg: number; nearClip: number; farClip: number; orthographic: boolean; orthographicSize: number; depth: number; clearFlags: string; background: number[]; enabled: boolean }
export interface UnityPrefabRecord { status: string; assetPath: string; assetGuid: string; isOutermost: boolean }
/** 一棵树的实例读数（Unity `TreeInstance` 原样：position 是相对地形原点的归一化 0..1，rotation 是弧度）。 */
export interface UnityTreeInstanceRecord {
  position: number[]        // [x, y, z] 归一化；x × widthM、y × heightM（高度）、z × lengthM 才是地形局部米
  widthScale: number; heightScale: number; rotationRad: number
  color: number[]           // rgba 0..1
  prototypeIndex: number
}
/** 一个植被原型：几何以**一份共享 GLB** 交付（`meshFile`，产品导入后进自己的资源库；不是逐树复制素材）。 */
export interface UnityTreePrototypeRecord {
  prefabPath: string; prefabGuid: string
  /** Unity TreePrototype.bendFactor：原型参数，原样往返（写回时不带它 Unity 会把它变成 0）。 */
  bendFactor?: number
  meshFile?: string; meshBytes?: number; vertexCount?: number; triangleCount?: number
  subMeshCount?: number; materialCount?: number; meshError?: string
}
export interface UnityTerrainRecord {
  widthM: number; heightM: number; lengthM: number; heightmapResolution: number
  minHeight: number; maxHeight: number; heightsFile: string; heightsBytes: number
  alphamapLayers: number; treeInstanceCount: number; treesFile: string
  treePrototypes: UnityTreePrototypeRecord[]
  /** 交付闭包：高度图 → 可渲染网格 GLB（顶点 y = 归一化高度 × heightM，float32 原值）。 */
  meshResolution?: number; meshFile?: string; meshFileSpace?: string; meshBytes?: number
  meshVertexCount?: number; meshTriangleCount?: number; holeCellCount?: number
  /** 层混合烘焙出的等价漫反射贴图（同一份字节也内嵌在 meshFile 的 GLB 里）。 */
  textureFile?: string; textureDigest?: string; textureWidth?: number; textureHeight?: number
  /** 植被实例**内联**（产品读的是这一份；侧车 treesFile 在 Unity 工程里，搬家后就没了）。 */
  instances?: UnityTreeInstanceRecord[]
  /**
   * `instances` 是不是**权威清单**（读到的就是全部；空数组 = 真的没有树）。
   * 只有为 true 时写回才动 Unity 的 `terrainData.treeInstances`：旧版/手写文档缺这个字段时保持 Unity 原样，
   * 不会因为"文档里没有这一项"把用户地形上的树清掉。
   */
  treeInstancesAuthoritative?: boolean
}

/** 一个 Unity 对象（文档节点）。变换是 Unity 原生空间：位置/缩放 [3]，旋转 xyzw [4]。 */
export interface UnityNode {
  index: number; parentIndex: number; name: string; entityId: string; globalId: string
  position: number[]; rotation: number[]; scale: number[]; active: boolean; tag: string; layer: number
  componentTypes: string[]
  mesh?: UnityMeshRecord | null; materials?: UnityMaterialRecord[] | null
  light?: UnityLightRecord | null; camera?: UnityCameraRecord | null
  prefab?: UnityPrefabRecord | null; terrain?: UnityTerrainRecord | null
  losses: string[]
}
export interface UnitySceneDocument {
  kind: string; version: number; generator: string; generatedAtUnixMs: number
  scenePath: string; sceneName: string; sceneGuid: string
  transformSpace: string; meshSpace: string
  /** 场景级环境（RenderSettings + 相机背景 + 太阳）。`present` 为 false 表示这次没采到。 */
  environment?: UnityEnvironmentRecord | null
  nodes: UnityNode[]
  assets: Array<{ index: number; path: string; guid: string; type: string; fileSize: number; sha256: string }>
  losses: string[]
}

/**
 * 落在产品实体上的 Unity 来源元数据（`components.unity`）。
 * 刻意**不含**位置/旋转/缩放/父子：那些必须从产品场景里的真实变换反算，
 * 否则往返核对会退化成"把原值抄回来"。
 */
export interface UnityOriginMetadata {
  space: { units: "m"; upAxis: "Y"; handedness: "left"; quaternion: "xyzw" }
  globalId: string; tag: string; layer: number; active: boolean; componentTypes: string[]
  mesh?: UnityMeshRecord | null; materials?: UnityMaterialRecord[] | null
  light?: UnityLightRecord | null; camera?: UnityCameraRecord | null
  prefab?: UnityPrefabRecord | null; terrain?: UnityTerrainRecord | null
  /** 植被实例实体：Unity 的 TreeInstance 只是一个数据条目（不是场景对象），写回时折回地形的 instances。 */
  terrainTree?: {
    terrainEntityId: string; index: number; prototypeIndex: number
    prototypePrefabPath: string; prototypePrefabGuid: string
    position: number[]; widthScale: number; heightScale: number; rotationRad: number; color: number[]
  }
  losses: string[]
}

/**
 * 记录"到底有没有"：Unity 的 JsonUtility 会把**没有的嵌套记录**写成字段默认值实例，从来不是 null。
 * 所以文档里每个节点都带一份空的 light/camera/prefab/terrain，判存在只能按内容判（判据与
 * `LyapunovSceneExchange.cs` 的 Has* 一一对应，写在 docs/UNITY_SCENE_EXCHANGE.md §6）。
 */
export function hasUnityMesh(record: UnityMeshRecord | null | undefined): boolean {
  return Boolean(record) && ((record!.vertexCount ?? 0) > 0 || Boolean(record!.assetPath) || Boolean(record!.file))
}
export function hasUnityLight(record: UnityLightRecord | null | undefined): boolean { return Boolean(record?.type) }
export function hasUnityCamera(record: UnityCameraRecord | null | undefined): boolean {
  if (!record) return false
  return (record.fieldOfViewDeg ?? 0) > 0 || (record.nearClip ?? 0) > 0 || (record.farClip ?? 0) > 0 || (record.orthographicSize ?? 0) > 0
}
export function hasUnityPrefab(record: UnityPrefabRecord | null | undefined): boolean { return Boolean(record?.assetPath || record?.status) }
export function hasUnityTerrain(record: UnityTerrainRecord | null | undefined): boolean {
  if (!record) return false
  return (record.heightmapResolution ?? 0) > 0 || (record.meshResolution ?? 0) > 0
    || (record.widthM ?? 0) > 0 || (record.heightM ?? 0) > 0 || (record.lengthM ?? 0) > 0
    || (record.treeInstanceCount ?? 0) > 0 || (record.instances?.length ?? 0) > 0
}

/** 把"空记录"清成 null：后面所有代码只处理真的存在的记录（损失、写回都不会再被空记录带偏）。 */
export function normalizeUnityNode(node: UnityNode): UnityNode {
  return {
    ...node,
    mesh: hasUnityMesh(node.mesh) ? node.mesh : null,
    light: hasUnityLight(node.light) ? node.light : null,
    camera: hasUnityCamera(node.camera) ? node.camera : null,
    prefab: hasUnityPrefab(node.prefab) ? node.prefab : null,
    terrain: hasUnityTerrain(node.terrain) ? node.terrain : null,
  }
}

export function normalizeUnityDocument(document: UnitySceneDocument): UnitySceneDocument {
  return { ...document, nodes: (document.nodes ?? []).map(normalizeUnityNode) }
}

/** 稳定身份：优先用 Unity 侧存的身份，否则由 GlobalObjectId 派生（同名对象也稳定）。 */
export function productEntityIdFor(node: { entityId: string; globalId: string; name: string }): string {
  if (node.entityId) return node.entityId
  return `entity_unity_${digestOf(node.globalId || node.name)}`
}
/** 资源身份同理：同一对象重复导出命中资源库内容去重，不每次新增版本。 */
export function unityResourceIdFor(entityId: string, seed: string): string {
  const trimmed = entityId.replace(/^entity_/, "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60)
  return `res_unity_${trimmed}_${digestOf(seed).slice(0, 8)}`
}
function digestOf(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16) }
/** 植被原型给用户看的名字：prefab 资产名（没有 prefab 路径时退回索引）。 */
function prototypeNameOf(prototype: { prefabPath: string }, index: number): string {
  const file = basename(prototype.prefabPath.replace(/\\/g, "/"))
  return file.replace(/\.[^.]+$/, "") || `植被原型 ${index}`
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 传输口（Unity 侧执行由调用方注入：产品里是原生 MCP，测试里是假件）
// ────────────────────────────────────────────────────────────────────────────

export interface UnityExchangePort {
  /** 执行一个原生 Unity MCP 工具（产品里就是 mcp__unity__* 的同一个执行入口）。 */
  call(tool: string, args?: Record<string, unknown>): Promise<{ ok: boolean; text: string; json?: unknown }>
  /**
   * 读一个原生 Unity MCP 资源。只用于**发现 Unity 工程根**：请求/回执文件必须写在工程里，
   * 而工程根只有编辑器知道（`mcpforunity://project/info`）。省略时调用方必须显式给 projectPath。
   */
  readResource?(uri: string): Promise<unknown>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  /**
   * 原子写 JSON（临时文件 + rename，复用 persistence.atomicJSON）：请求文件在被编辑器看到之前必须已经完整。
   * 直接 `writeFile` 会留下"读到半份 JSON"的窗口——编辑器一读到坏 JSON 就会把这次请求判失败。
   */
  writeJSONAtomic(path: string, value: unknown): Promise<void>
  /** 删文件（撤回尚未被编辑器认领的请求）；文件不在时静默成功。 */
  removeFile(path: string): Promise<void>
  writeBinary(path: string, bytes: Uint8Array): Promise<void>
}

/**
 * 从 `mcpforunity://project/info` 的回执里取工程根。
 * 资源读回的形状是 `{contents:[{uri,mimeType,text}]}`，text 里是 `{"data":{"projectRoot":…}}`；
 * 也接受已经解开的对象（调用方自己读了资源正文时）。
 */
export function projectRootOf(payload: unknown): string | undefined {
  const unwrap = (value: unknown): unknown => {
    if (typeof value === "string") { try { return JSON.parse(value) } catch { return undefined } }
    const contents = (value as { contents?: Array<{ text?: string }> })?.contents
    if (Array.isArray(contents) && contents[0]?.text !== undefined) return unwrap(contents[0].text)
    return value
  }
  const document = unwrap(payload) as { data?: { projectRoot?: unknown } | null; projectRoot?: unknown } | undefined
  const root = document?.data?.projectRoot ?? document?.projectRoot
  return typeof root === "string" && root.length > 0 ? root : undefined
}

export interface UnityExchangeOptions {
  /** Unity 工程根。省略时经 `status` 向编辑器要一次，之后缓存。 */
  projectPath?: string
  /**
   * 显式实例（`Name@hash` / hash 前缀 / 端口，与原生 `set_active_instance` 同一套写法）。
   * 同一工程开出多个实例时必填；只给工程根、实例清单里命中多个又没给这个，就直接报含糊错误而不是随便挑一个。
   */
  instance?: string
  /** 单次菜单调用等待回执的超时（毫秒）。只约束**本地观测**：超时不重发、不重跑。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
}

/**
 * 取消时对**远端**的观测结论，只由文件事实得出（不拿"菜单调用返回过"冒充"远端已认领"）：
 *   - `pending`   请求文件还在（撤回成功的话仍是 pending）——编辑器没拿到这次请求，它不会执行；
 *   - `claimed`   请求文件已被 `File.Move` 搬走（或撤回时被抢先搬走）——编辑器拿走了，可能正在跑或已跑完；
 *   - `completed` 本次 requestId 的回执已经落在结果文件里——远端确实做完了；
 *   - `unknown`   两个文件都读不成，判不了（按最坏情况报 `mayHaveStarted`）。
 */
export type UnityRemoteClaim = "pending" | "claimed" | "completed" | "unknown"

/** 取消/超时的观测事实；`observation` 是读文件拿到的原文，调用方可以不信我们的结论、自己看。 */
export interface UnityRemoteObservation {
  claim: UnityRemoteClaim
  /** 远端**可能**已经开始这次操作（claimed/completed/unknown 都为 true —— unknown 只是"判不了"，按最坏说）。 */
  mayHaveStarted: boolean
  observation: string
}

/** 本地停止等待（用户取消 / 上层 abort）。远端状态以观测事实为准——本错误不谎称撤销，也不谎称没事。 */
export class UnityExchangeCancelled extends Error {
  readonly code = "UNITY_WAIT_CANCELLED"
  readonly claim: UnityRemoteClaim
  readonly mayHaveStarted: boolean
  constructor(readonly detail: { op: string; requestId: string; resultPath: string; phase: string } & UnityRemoteObservation) {
    const tail = detail.claim === "pending"
      ? `观测事实：${detail.observation} —— 本次调用停在这里，编辑器不会执行这条请求。`
      : detail.claim === "completed"
        ? `观测事实：${detail.observation} —— 远端已经把这次操作做完，本调用不再等、也不重发；回执在 ${detail.resultPath}。`
        : detail.claim === "claimed"
          ? `观测事实：${detail.observation} —— 远端**可能已经开始**这次操作，本地停止不等于远端撤销，本次不报成功、也不自动重发。`
          : `观测事实：${detail.observation} —— 判不了远端是否已认领（按最坏情况算：可能已经开始），不谎称撤销、不自动重发。`
    super(`UNITY_WAIT_CANCELLED: ${detail.op} 的本地等待在「${detail.phase}」被取消（requestId ${detail.requestId || "(还没生成)"}）。`
      + tail
      + (detail.requestId ? `该请求的回执（若产生）只写 ${detail.resultPath}，不会被算到别的请求上；可用 unity_scene_status 查。` : ""))
    this.name = "UnityExchangeCancelled"
    this.claim = detail.claim
    this.mayHaveStarted = detail.mayHaveStarted
  }
}

/** 目标工程与真正要执行的那个 Unity 实例对不上：宁可不做，也不把东西导进别的项目。 */
export class UnityProjectMismatch extends Error {
  readonly code = "UNITY_PROJECT_MISMATCH"
  constructor(readonly detail: { requested: string; actual: string; source: string }) {
    super(`UNITY_PROJECT_MISMATCH: 请求的工程是 ${detail.requested}，而${detail.source}是 ${detail.actual}；`
      + `不写入请求文件、不执行导入（不默认改用另一个项目）。`)
    this.name = "UnityProjectMismatch"
  }
}

/** 路径比较用的规范化：绝对化 + 去掉结尾分隔符（Unity 报的路径可能与请求的大小写/尾斜杠不同）。 */
export function normalizePath(path: string): string {
  const absolute = resolve(path)
  return absolute.length > 1 && absolute.endsWith("/") ? absolute.slice(0, -1) : absolute
}

/** 实例清单（`mcpforunity://instances`）：只取 id/port/path（path 是 …/Project/Assets，父目录才是工程根）。 */
export interface UnityInstanceDescriptor { id: string; port?: number; projectPath?: string; status?: string }

export function parseInstances(payload: unknown): UnityInstanceDescriptor[] {
  const unwrap = (value: unknown): unknown => {
    if (typeof value === "string") { try { return JSON.parse(value) } catch { return undefined } }
    const contents = (value as { contents?: Array<{ text?: string }> })?.contents
    if (Array.isArray(contents) && contents[0]?.text !== undefined) return unwrap(contents[0].text)
    return value
  }
  const document = unwrap(payload) as { instances?: Array<{ id?: unknown; name?: unknown; hash?: unknown; port?: unknown; path?: unknown; status?: unknown }> } | undefined
  if (!Array.isArray(document?.instances)) return []
  return document.instances.flatMap(entry => {
    const id = typeof entry.id === "string" && entry.id ? entry.id : undefined
    if (!id) return []
    const path = typeof entry.path === "string" ? entry.path : undefined
    // 实例报的是 Assets 目录；工程根是它的父目录（与 mcpforunity://project/info 的 projectRoot 同一口径）。
    const projectPath = path ? (path.replace(/[\\/]+$/, "").endsWith("/Assets") ? path.replace(/[\\/]+$/, "").slice(0, -"/Assets".length) : path) : undefined
    return [{ id, ...(typeof entry.port === "number" ? { port: entry.port } : {}), ...(projectPath ? { projectPath } : {}), ...(typeof entry.status === "string" ? { status: entry.status } : {}) }]
  })
}

/** 可中断的等待：取消时立刻返回，让轮询循环在下一个 tick 判中止。 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) { await new Promise(resolve => setTimeout(resolve, ms)); return }
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(finish, ms)
    function finish(): void { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve() }
    signal.addEventListener("abort", finish, { once: true })
  })
}

/**
 * 让**本地等待**与 signal 竞速：一取消就立刻停止等待，而不是等被等的那个 Promise 结束才看 signal
 * （排队等前一条操作、等 MCP 菜单响应都属于"被等的 Promise 可能很久不结束"）。
 * `stillWaiting`：这段等待是不是还在进行（比如"还在排队"）——已经不在这里等的话就交给内层自己的取消路径，
 * 免得把"排队时取消"的说法盖到"已经在等菜单响应"的实际上。
 * 被等的 Promise 仍在后台跑，它的结果/异常都被挂上处理，不会变成 unhandled rejection。
 */
function abortable<T>(waiting: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Error, stillWaiting?: () => boolean): Promise<T> {
  if (!signal) return waiting
  if (signal.aborted && (!stillWaiting || stillWaiting())) return Promise.reject(onAbort())
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      if (stillWaiting && !stillWaiting()) return     // 已经轮到我执行了：这一层的"排队"说法不成立，交给内层
      signal.removeEventListener("abort", abort)
      reject(onAbort())
    }
    signal.addEventListener("abort", abort)
    waiting.then(
      value => { signal.removeEventListener("abort", abort); resolve(value) },
      error => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

export interface UnityExchangeReport {
  sceneId: string
  revision: number
  unityScene: { path: string; name: string; guid: string }
  entities: number
  resources: number
  identity: Array<{ entityId: string; unity: string; name: string }>
  losses: string[]
  documentPath: string
  meshFiles: number
  /** 目标绑定回执：请求工程 ↔ 编辑器自报工程（见 bindTarget）。 */
  binding?: Record<string, unknown>
  /** 执行回执（工程根/进程/场景/requestId/改动清单）：读回与写回都带，交付证据。 */
  receipt?: Record<string, unknown>
  /** 身份窄更新的账：新增/更新/删除/改挂/原样保留（用户加的组件与用户自己挂的子对象在 kept 里）。 */
  sync?: { added: string[]; updated: string[]; removed: string[]; reparented: string[]; kept: string[]; userReparented?: string[]; framesKept?: string[] }
  /** 场景级环境落到产品侧的结果（文档没采到时没有这个字段）。 */
  environment?: { entityId: string; component: ProductSceneEnvironment }
}

/**
 * 交换**负责**的组件键：只有这些会被 readScene 按 Unity 侧重写。
 * 其它键（用户自己加的批注、产品侧工具写的元数据…）一律原样保留。
 */
export const EXCHANGE_COMPONENT_KEYS = ["unity", "light", "visual", "environment"] as const

export interface UnitySyncPlan {
  patch: ScenePatch
  added: string[]; updated: string[]; removed: string[]; reparented: string[]; kept: string[]
  /** 非交换（用户）子对象改挂的 id：只有这些算"用户内容被改挂"，Unity 自己对象之间的改挂不在里面。 */
  userReparented: string[]
  /** 被删来源对象里，为保住用户子树而剥掉交换身份留作普通结构节点的 id。 */
  framesKept: string[]
}

/**
 * 身份稳定同步（纯函数）：把"这次从 Unity 采到的实体"并进既有场景，**不整棵重建**。
 *
 *   - 既有 entityId → `update`（只带交换负责的字段，components 里只换 unity/light/visual/environment，
 *     用户加的组件键原样留着）；父变了发 `reparent`；
 *   - 新 entityId → `add`（父在子前，保持层级序）；
 *   - 只在**来源真的删了**的时候删：属于本场景（GlobalObjectId 前缀）的既有交换实体这次没采到，
 *     以及交换展开的子节点（`<root>:source` / `<root>:node:i`）这次不再产出 —— 都按 id 精确删除，不用级联；
 *   - 交换实体被删时，挂在它下面的**非交换子节点**（用户自己挂的对象）不跟着死：改挂到最近还活着的祖先，
 *     并**保留世界位姿**（局部变换按提交后的父帧重算，整棵子树一起保留；装不下就记 `UNITY_USER_CHILD_POSE_SHEAR`）。
 * 另一个 Unity 场景（别的 GUID 前缀）的实体、以及用户自己的对象，都不在删除范围内。
 */
export function planUnitySync(before: SceneSnapshot, desired: Entity[], context: { sceneGuid: string; losses: string[] }): UnitySyncPlan {
  const byId = new Map(before.entities.map(entity => [entity.entityId, entity]))
  const desiredIds = new Set(desired.map(entity => entity.entityId))
  const scenePrefix = context.sceneGuid ? `GlobalObjectId_V1-2-${context.sceneGuid}-` : ""
  const unityRoots = new Set(before.entities
    .filter(entity => scenePrefix && String((entity.components?.unity as { globalId?: string } | undefined)?.globalId ?? "").startsWith(scenePrefix))
    .map(entity => entity.entityId))
  // 植被实例不是场景对象（没有 GlobalObjectId）：它们自己也由交换负责，从它们展开的子节点同理。
  const vegetationRoots = new Set(before.entities
    .filter(entity => (entity.components?.unity as UnityOriginMetadata | undefined)?.terrainTree)
    .map(entity => entity.entityId))
  /** 交换负责的既有实体：Unity 对象本身，或交换从资源/地形展开出来的子节点（根必须是交换对象或植被实例）。 */
  const owned = (entity: Entity): boolean => {
    const globalId = String((entity.components?.unity as { globalId?: string } | undefined)?.globalId ?? "")
    if (scenePrefix && globalId.startsWith(scenePrefix)) return true
    const root = exchangeExpandedRoot(entity.entityId)
    return root !== undefined && (unityRoots.has(root) || vegetationRoots.has(root))
  }

  const patch: ScenePatch = []
  const added: string[] = [], updated: string[] = [], reparented: string[] = [], kept: string[] = []
  const removed: string[] = [], userReparented: string[] = [], framesKept: string[] = []
  const plan: UnitySyncPlan = { patch, added, updated, removed, reparented, userReparented, framesKept, kept }

  const parentOf = new Map(before.entities.map(entity => [entity.entityId, entity.parentId]))
  const stale = before.entities.filter(entity => owned(entity) && !desiredIds.has(entity.entityId))
  const staleIds = new Set(stale.map(entity => entity.entityId))

  // 提交后的世界矩阵模型：这次采到的实体用 Unity 给的 transform/父节点，其它实体保持原样。
  // **本批新增的实体也在里面**（真实反例 root-100-new-ancestor-probe：同批新增的祖父不进模型时，
  // 改挂用户子对象会按一个不存在的父帧算，before x13 → after x113，还把"世界位姿保留"写进回执）。
  // 被删的实体默认不在里面（它们是保守假设），如果有子内容必须靠它们保形，再按 framesKept 补回来。
  const afterById = new Map<string, Entity>()
  for (const entity of before.entities) if (!staleIds.has(entity.entityId)) afterById.set(entity.entityId, entity)
  for (const entity of desired) afterById.set(entity.entityId, { ...entity })
  const afterSnapshot = (): SceneSnapshot => ({ ...before, entities: [...afterById.values()] })

  // 被删交换实体的非交换子节点：不能跟着死，也不能被"TRS 近似"改形状。
  //   ① 装得下（局部 TRS 分解与目标矩阵逐元素一致）→ 原短路：改挂到最近存活祖先 + 按提交后父帧重算局部；
  //   ② 装不下（父链非均匀缩放叠加旋转会产生剪切）→ **不**用近似去改用户对象（那是同步主动改用户形状）：
  //      把被删的那段祖先链剥掉可视/交换身份，留作普通结构节点，用户对象的局部变换一个字节不动。
  const survivors = new Set(afterById.keys())
  const survivingAncestor = (id: string | undefined): string | undefined => {
    let current = id
    while (current !== undefined && !survivors.has(current)) current = parentOf.get(current)
    return current
  }
  const keepFramesAbove = (id: string | undefined): void => {
    let current = id
    while (current !== undefined && staleIds.has(current)) { framesKept.push(current); survivors.add(current); current = parentOf.get(current) }
  }
  const orphaned = before.entities.filter(entity => {
    const parent = parentOf.get(entity.entityId)
    return parent !== undefined && staleIds.has(parent) && !staleIds.has(entity.entityId) && !desiredIds.has(entity.entityId)
  })
  // 第一遍：只看"被删的都当真被删"的保守模型，判断哪些子对象的局部变换装不下。
  for (const entity of orphaned) {
    const parent = parentOf.get(entity.entityId)
    if (survivingAncestor(parent) === parent) continue   // 父已经（因别处的判定）作为结构节点留下
    const pose = reparentPose(before, afterSnapshot(), entity.entityId, survivingAncestor(parent))
    if (pose.shear > POSE_SHEAR_TOLERANCE) keepFramesAbove(parent)
  }
  // 真正被删的来源对象：按 id 精确删除（不用级联）；要留作结构节点的那些不删。
  for (const entity of stale) {
    if (framesKept.includes(entity.entityId)) continue
    removed.push(entity.entityId)
    patch.push({ op: "remove", entityId: entity.entityId })
  }
  // 结构节点：剥掉交换身份与可视/灯/相机，变换与父子关系**原样不动**（用户子树的世界位姿与形状靠它保持）。
  for (const id of framesKept) {
    const entity = byId.get(id)
    if (!entity) continue
    const components = { ...((entity.components ?? {}) as Record<string, unknown>) }
    const unity = components.unity as { globalId?: string } | undefined
    delete components.unity
    delete components.visual
    delete components.light
    delete components.camera
    delete components.environment
    components.unityFrame = {
      keptFrom: id, name: entity.name, globalId: String(unity?.globalId ?? ""),
      reason: "来源对象已从 Unity 删除，但下面挂着非交换（用户）内容；原父帧在新父帧里装不下 TRS（剪切成 TRS 会改用户形状），按普通结构节点保留",
    }
    patch.push({ op: "update", entityId: id, changes: { components, resources: [] } })
  }
  // 第二遍：帧保留确定之后再落地。留下的帧也算"存活"，所以装不下那条的父帧没变 → 它原地不动。
  for (const entity of orphaned) {
    const parent = parentOf.get(entity.entityId)
    const target = survivingAncestor(parent)
    if (target === parent) continue
    const pose = reparentPose(before, afterSnapshot(), entity.entityId, target)
    patch.push({ op: "reparent", entityId: entity.entityId, parentId: target })
    patch.push({ op: "update", entityId: entity.entityId, changes: { transform: pose.transform } })
    reparented.push(entity.entityId)       // 报告/账本口径：改挂过的实体（含用户子对象）
    userReparented.push(entity.entityId)   // 只有这里才是"用户内容被改挂"的计数（来源对象之间的改挂不算）
  }
  // 保留帧补进"批后"模型，好算出用户子树跟着帧走了多少（活着的祖先没动就是 0，形状一律不变）。
  for (const id of framesKept) { const frame = byId.get(id); if (frame) afterById.set(id, frame) }
  let frameDrift = 0
  for (const entity of orphaned) {
    const parent = parentOf.get(entity.entityId)
    if (parent === undefined || survivingAncestor(parent) !== parent) continue
    const beforeWorld = worldMatrix(before, entity.entityId)
    const afterWorld = worldMatrix({ ...before, entities: [...afterById.values()] }, entity.entityId)
    for (let index = 0; index < 16; index++) frameDrift = Math.max(frameDrift, Math.abs(afterWorld.elements[index]! - beforeWorld.elements[index]!))
  }

  for (const entity of desired) {
    const existing = byId.get(entity.entityId)
    if (!existing) { patch.push({ op: "add", entity }); added.push(entity.entityId); continue }
    const changes = narrowChanges(existing, entity)
    if (changes) { patch.push({ op: "update", entityId: entity.entityId, changes }); updated.push(entity.entityId) }
    if ((existing.parentId ?? undefined) !== (entity.parentId ?? undefined)) {
      patch.push({ op: "reparent", entityId: entity.entityId, parentId: entity.parentId })
      reparented.push(entity.entityId)
    }
  }
  // 保持原样的既有实体：这次既没被改、也没被删也没改挂（用户的组件、用户自己挂的子对象都在里面）。
  const touched = new Set([...updated, ...plan.removed, ...reparented, ...framesKept])
  for (const entity of before.entities) if (!touched.has(entity.entityId)) kept.push(entity.entityId)
  const staleCount = removed.filter(entityId => unityRoots.has(entityId)).length
  if (staleCount > 0) {
    context.losses.push(`UNITY_SCENE_GHOSTS_REMOVED: ${staleCount} 个来源对象在这次捕获里已经不在 Unity 场景（globalId 前缀 ${context.sceneGuid}），连同交换展开的子节点按 id 精确删除（不用级联）`)
  }
  if (framesKept.length > 0) {
    // 保留帧之后，用户子树的世界矩阵偏差：活着的祖先没动就是 0；动了就如实报（仍然没改用户对象的局部变换）。
    const named = framesKept.map(id => byId.get(id)?.name ?? id).join("、")
    context.losses.push(`UNITY_USER_CHILD_FRAMES_KEPT: ${framesKept.length} 个来源对象（${named}）已从 Unity 删除，但下面挂着非交换子内容、原父帧在新父帧里装不下 TRS（分解偏差 > ${POSE_SHEAR_TOLERANCE}，父链非均匀缩放叠加旋转会产生剪切）；没有用 TRS 近似去改用户对象，改为剥掉交换身份/可视件后留作普通结构节点，用户对象的局部变换一个字节没动（最大世界矩阵偏差 ${frameDrift.toExponential(2)}）`)
  }
  if (userReparented.length > 0) {
    context.losses.push(`UNITY_USER_CHILDREN_KEPT: ${userReparented.length} 个非交换子节点没有跟着交换实体一起删，改挂到最近还活着的祖先（局部变换按提交后的父帧重算，世界位姿与子树一起保留）`)
  }
  if (frameDrift > POSE_SHEAR_TOLERANCE) {
    context.losses.push(`UNITY_USER_SUBTREE_FRAME_MOVED: 保留结构节点的祖先在同一批里被 Unity 改过（世界矩阵偏差 ${frameDrift.toExponential(2)}），用户子树跟着这个帧走了一段；用户对象自身没被改（局部变换与形状不变），改的是它所在帧的世界位置`)
  }
  return plan
}

/** TRS 装不下的偏差阈值：矩阵元素是米/无量纲的混合量，1e-6 只用来判"是不是真的装不下"。 */
export const POSE_SHEAR_TOLERANCE = 1e-6

/**
 * 改挂后的局部变换：把子对象**改挂前的世界矩阵**在新父**提交后**的世界矩阵里重新表达
 * （`local' = W_new_parent⁻¹ · W_child_before`）。新父为 undefined 表示改挂成根，此时局部就是世界。
 *
 * 新父本身可能在同一批里被 Unity 更新（它的世界矩阵要走"批后"模型）——否则父动了、子还按旧帧算，
 * 子对象会跟着父多动一次。返回 decompose 的矩阵偏差 `shear`：非零说明这份 TRS 装不下（父链非均匀缩放
 * 叠加旋转会产生剪切），调用方必须如实点名，不能当作无损。
 */
function reparentPose(before: SceneSnapshot, after: SceneSnapshot, entityId: string, parentId: string | undefined): { transform: Transform; shear: number } {
  const world = worldMatrix(before, entityId)
  const local = parentId === undefined ? world.clone() : worldMatrix(after, parentId).clone().invert().multiply(world)
  const transform = decomposeMatrix(local)
  // 装不下时（矩阵含剪切，列不正交）分解出的四元数不是单位四元数：归一化、缩放钳到非零，
  // 让它先成为一份**能落地的** TRS；形状偏差由下面的 shear 如实点名，不静默当无损。
  const norm = Math.hypot(transform.quaternion[0], transform.quaternion[1], transform.quaternion[2], transform.quaternion[3])
  if (norm > 0) transform.quaternion = transform.quaternion.map(value => value / norm) as [number, number, number, number]
  transform.scale = transform.scale.map(value => Math.abs(value) < 1e-6 ? 1e-6 : value) as [number, number, number]
  const rebuilt = localMatrix(transform).elements
  let shear = 0
  for (let index = 0; index < 16; index++) shear = Math.max(shear, Math.abs(rebuilt[index]! - local.elements[index]!))
  return { transform, shear }
}

/** 只挑交换负责的字段差异；没有差异就返回 undefined（不发空 update）。 */
function narrowChanges(existing: Entity, wanted: Entity): Record<string, unknown> | undefined {
  const changes: Record<string, unknown> = {}
  if (existing.name !== wanted.name) changes.name = wanted.name
  if (JSON.stringify(existing.transform) !== JSON.stringify(wanted.transform)) changes.transform = wanted.transform
  if (JSON.stringify(existing.resources ?? []) !== JSON.stringify(wanted.resources ?? [])) changes.resources = wanted.resources
  const merged: Record<string, unknown> = { ...((existing.components ?? {}) as Record<string, unknown>) }
  let touched = false
  for (const key of EXCHANGE_COMPONENT_KEYS) {
    const value: unknown = (wanted.components as Record<string, unknown> | undefined)?.[key]
    if (value === undefined) {
      if (key in merged) { delete merged[key]; touched = true }  // 来源没了（例如 Unity 里的灯被删）
      continue
    }
    if (JSON.stringify(merged[key]) !== JSON.stringify(value)) { merged[key] = value; touched = true }
  }
  if (touched) changes.components = merged
  return Object.keys(changes).length > 0 ? changes : undefined
}

/** 交换执行体：只依赖 SceneOperations（产品落盘）与 port（Unity 执行）。 */
export class UnitySceneExchange {
  private projectPath: string | undefined
  private scratch: string | undefined
  private counter = 0
  /** 进程内串行队列（见 serialized）。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 已经显式绑定过的实例 id：同一个就不重复调 set_active_instance。 */
  private boundInstance: string | undefined
  /** 上一次自动发现工程根失败的真实原因（连不上/形状不认识），只用于把 UNITY_PROJECT_UNKNOWN 说明白。 */
  private discoveryFailure: string | undefined

  constructor(readonly scene: SceneOperations, readonly port: UnityExchangePort, readonly options: UnityExchangeOptions = {}) {
    this.projectPath = options.projectPath
  }

  /**
   * 只读状态：编辑器就绪、当前场景与未保存情况、交换工具是否装好，以及
   * **目标绑定**（请求工程 vs 编辑器自报工程）与**未收完的请求/最近回执**——
   * 取消或超时之后，这次请求到底跑没跑完，看这里而不是靠猜。
   */
  async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.invoke("status", {}, signal)
    const payload = result.status as { projectPath?: string; instanceId?: string } | undefined
    if (payload?.projectPath) this.projectPath = payload.projectPath
    return {
      exchange: { menu: UNITY_EXCHANGE_MENU, projectPath: this.projectPath, scratch: this.scratchDirectory, instance: this.boundInstance ?? null },
      binding: result.binding,
      receipt: result.receipt,
      unity: result.status, warnings: result.warnings, errors: result.errors,
    }
  }

  get scratchDirectory(): string { return this.scratch ??= join(this.requireProjectPath(), UNITY_EXCHANGE_SCRATCH) }

  private requireProjectPath(): string {
    if (!this.projectPath) throw new Error("UNITY_PROJECT_UNKNOWN: 先调用 status()（或构造时给 projectPath）；自动发现需要 port.readResource 读 mcpforunity://project/info"
      + (this.discoveryFailure ? `；本次自动发现失败：${this.discoveryFailure}` : "；本次没有可用的资源读口（port.readResource 缺失）"))
    return this.projectPath
  }

  /**
   * 工程根只有编辑器知道：经原生 MCP 资源读一次，之后缓存。读不到就让 requireProjectPath 报清楚（含真实原因）。
   * 幂等：invoke 里也调它（产品口每次调用新实例，绑定一次即可），已绑定就直接返回。
   */
  private async ensureProjectPath(): Promise<void> {
    if (this.projectPath || !this.port.readResource) return
    try {
      const payload = await this.port.readResource(UNITY_PROJECT_INFO_URI)
      const root = projectRootOf(payload)
      if (root) { this.projectPath = root; return }
      const shape = (() => { try { return JSON.stringify(payload)?.slice(0, 200) } catch { return String(payload).slice(0, 200) } })()
      this.discoveryFailure = `${UNITY_PROJECT_INFO_URI} 的正文里没有工程根（形状不认识：${shape ?? ""}）`
    } catch (reason) {
      this.discoveryFailure = reason instanceof Error ? reason.message : String(reason)
    }
  }

  /**
   * 一次交换请求 = 一个**唯一文件**（`requests/<requestId>.json` → `results/<requestId>.json`）。
   *
   * 为什么不是共享 request.json/result.json：原生工具调用可以并行，两条调用同时写同一个文件时
   * 后写的会盖掉先写的（请求被吞、回执窜到另一条调用上）。这里改成：
   *   - 每次调用一个唯一文件名（时间戳 + 计数 + 随机尾巴，同机多进程也不会撞）；
   *   - 编辑器侧扫 `requests/`、用 rename **认领**（见 C# `DrainPendingRequests`），一份请求恰好执行一次；
   *   - 回执只写自己那个 result 文件，因此**结果不可能落到后来另一请求**。
   * 同一条实例内部再串行一次（下面的 `serialized`）：跨进程由文件唯一性保证，进程内不需要第二套调度器。
   */
  private async invoke(op: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    return await this.serialized(async () => {
      // 排队期间就被取消的：此刻还没写请求、没触发菜单 —— 在 run 的第一行就停，别为了前一条操作白等。
      this.throwIfStopped(signal, op, "", "开始前")
      await this.ensureProjectPath()
      // 目标绑定：工程根只说明"请求文件写在哪"，真正执行的是收到菜单的那台编辑器 —— 执行前先核对。
      const binding = await this.bindTarget(signal)
      const requestId = `lx-${Date.now().toString(36).padStart(9, "0")}-${(++this.counter).toString(36)}-${randomUUID().slice(0, 8)}-${op}`
      const requestPath = this.requestPathFor(requestId)
      const resultPath = this.resultPathFor(requestId)
      const timeoutMs = this.options.timeoutMs ?? 180_000
      // 过期时间：编辑器只认领"还没过期"的请求。取消/崩溃留下的孤儿请求因此不会在很久以后突然被执行。
      const request = { requestId, op, resultPath, expectProjectRoot: this.projectPath, deadlineUnixMs: Date.now() + Math.max(60_000, timeoutMs), ...payload }
      await this.port.writeJSONAtomic(requestPath, request)
      try {
        // 写请求之后、触发编辑器之前再看一眼取消：这一步之后请求就可能被认领执行了。
        this.throwIfStopped(signal, op, requestId, "写请求之后/触发执行之前")
        // 等 MCP 的菜单响应同样可能与 signal 竞速：MCP/编辑器忙时这次调用可能很久不返回，
        // 取消就该立刻停止本地等待，而不是等菜单响应回来才看 signal。
        const call = await abortable(this.port.call("execute_menu_item", { menu_path: UNITY_EXCHANGE_MENU }), signal,
          () => new UnityExchangeCancelled({
            op, requestId, resultPath, phase: "等 MCP 菜单响应", claim: "unknown", mayHaveStarted: true,
            observation: "菜单调用还没返回就本地取消了（它是否已经派发到编辑器，这一次判不了）",
          }))
        // 菜单项是**异步派发**：工具调用失败/超时只说明没等到编辑器这一次响应（重的导入会在主线程上跑很久），
        // 请求可能已经在跑。所以继续按 requestId 等回执，只有回执始终不出现才判失败。
        const result = await this.awaitResult(resultPath, requestId, { op, signal }).catch(error => {
          if (!call.ok) throw new Error(`UNITY_MENU_CALL_FAILED: ${call.text.slice(0, 400)}；且没等到本次回执（${String((error as Error)?.message ?? error)}）`)
          throw error
        })
        if (!result.ok) throw new Error(`UNITY_${op.toUpperCase()}_FAILED: ${(result.errors ?? []).join("; ")}`)
        // 执行回执核对：回执自报的工程/实例必须与请求一致（"两个接口名相同"不等于"同一个项目"）。
        const receipt = this.verifyReceipt(result)
        return { ...result, binding, receipt }
      } catch (error) {
        if (error instanceof UnityExchangeCancelled) {
          // 取消回执只报**观测到的文件事实**（含"这次撤回有没有成功"），不拿菜单发出过当"远端已认领"。
          const observed = await this.withdrawRequest(requestPath, await this.observeRemote(requestPath, resultPath, requestId))
          throw new UnityExchangeCancelled({ op, requestId, resultPath, phase: error.detail.phase, ...observed })
        }
        throw error
      }
    }, signal ? { signal, op } : undefined)
  }

  /**
   * 进程内串行：一次只发一条交换请求。前一条失败不影响后一条。
   * `wait`：排队等待也允许取消 —— 取消后立刻把这次调用还回去，但**内部队列顺序不变**
   * （`this.queue` 仍挂在这条请求真正结束之后），被放弃的那次 run 会在第一行看到 signal 直接退出。
   */
  private serialized<T>(run: () => Promise<T>, wait?: { signal?: AbortSignal; op: string }): Promise<T> {
    let running = false
    const start = (): Promise<T> => { running = true; return run() }
    const started = this.queue.then(start, start)
    this.queue = started.then(() => undefined, () => undefined)
    if (!wait?.signal) return started
    return abortable(started, wait.signal, () => new UnityExchangeCancelled({
      op: wait.op, requestId: "", resultPath: "", phase: "开始前（排队等前一条操作）",
      claim: "pending", mayHaveStarted: false,
      observation: "本次还没写请求文件、也没触发菜单：取消只是不再排队等前一条操作做完",
    }), () => !running)
  }

  /**
   * 取消时对远端的观测：只看文件事实，不拿"菜单调用返回过"冒充"远端已认领"。
   * 顺序上先看回执（最硬的证据）再看请求文件还在不在（认领 = 被 File.Move 搬走）。
   */
  private async observeRemote(requestPath: string, resultPath: string, requestId: string): Promise<UnityRemoteObservation> {
    if (!requestId) return { claim: "pending", mayHaveStarted: false, observation: "还没生成 requestId、没写出请求文件，远端不可能知道这次操作" }
    try {
      const receipt = JSON.parse(await this.port.readFile(resultPath)) as { requestId?: string }
      if (receipt?.requestId === requestId) return { claim: "completed", mayHaveStarted: true, observation: `结果文件里已经是本次回执（${resultPath}），远端已经做完` }
      return { claim: "claimed", mayHaveStarted: true, observation: `结果文件存在但属于 ${receipt?.requestId || "(空)"}，不是本次：远端可能已经认领了本次请求` }
    } catch { /* 还没有回执，继续看请求文件 */ }
    const present = await this.requestFilePresent(requestPath)
    if (present === true) return { claim: "pending", mayHaveStarted: false, observation: `请求文件还在 ${requestPath}（还没被编辑器认领）` }
    if (present === false) return { claim: "claimed", mayHaveStarted: true, observation: `请求文件已不在 ${requestPath}（被编辑器认领搬走了），远端可能正在执行或已做完` }
    return { claim: "unknown", mayHaveStarted: true, observation: `请求文件与回执都读不成（${present === undefined ? "路径读不到" : ""}），判不了远端是否已认领` }
  }

  /** 请求文件还在不在：`true` 在、`false` 明确不在（ENOENT）、`undefined` 读不成（判不了，别当成不在）。 */
  private async requestFilePresent(requestPath: string): Promise<boolean | undefined> {
    try { await this.port.readFile(requestPath); return true }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false : undefined }
  }

  /**
   * 撤回请求文件 —— **只对"还没被认领"的请求有效**：删完再读一次确认它确实不在了，
   * 删除竞态里编辑器抢先认领（或删不掉）都如实改判成 claimed/unknown，不谎称撤销。
   */
  private async withdrawRequest(requestPath: string, observed: UnityRemoteObservation): Promise<UnityRemoteObservation> {
    if (observed.claim !== "pending" || !requestPath) return observed
    try { await this.port.removeFile(requestPath) } catch { /* 下面按重读结果定性 */ }
    const present = await this.requestFilePresent(requestPath)
    if (present === false) return { claim: "pending", mayHaveStarted: false, observation: `${observed.observation}；本次已撤回该请求文件（编辑器不会再执行它）` }
    if (present === true) return { claim: "claimed", mayHaveStarted: true, observation: `撤回没生效：请求文件仍在 ${requestPath}，编辑器随时可能认领它` }
    return { claim: "unknown", mayHaveStarted: true, observation: `撤回后重读 ${requestPath} 读不成，无法确认请求文件是否还在` }
  }

  requestPathFor(requestId: string): string { return join(this.scratchDirectory, UNITY_EXCHANGE_REQUESTS, `${requestId}.json`) }
  resultPathFor(requestId: string): string { return join(this.scratchDirectory, UNITY_EXCHANGE_RESULTS, `${requestId}.json`) }

  /**
   * 目标绑定（复用原生单实例绑定，不新 RPC）：
   *   1. 读实例资源 `mcpforunity://instances`，按 path（…/Project/Assets 的父目录）找出工程根匹配的实例；
   *   2. 命中 1 个 → 用原生 `set_active_instance` 显式绑到它；命中 0 个 → UNITY_INSTANCE_NOT_FOUND；
   *      命中多个 → 没给 options.instance 就报 UNITY_INSTANCE_AMBIGUOUS（不随便挑）；
   *   3. 绑定后读 `mcpforunity://project/info`，工程根与请求不一致就直接 UnityProjectMismatch（不写请求、不执行）。
   * 没有资源读口时（测试用的最小 port）这一段整体跳过，但仍会经 status/回执核对工程根。
   */
  private async bindTarget(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.port.readResource) return { bound: false, reason: "NO_RESOURCE_PORT" }
    const requested = normalizePath(this.requireProjectPath())
    const listing = parseInstances(await this.port.readResource(UNITY_INSTANCES_URI).catch(() => undefined))
    let candidates = listing.filter(instance => instance.projectPath && normalizePath(instance.projectPath) === requested)
    if (this.options.instance) {
      const explicit = listing.filter(instance => instance.id === this.options.instance || instance.id.endsWith(`@${this.options.instance}`) || instance.port === Number(this.options.instance))
      if (explicit.length === 0) throw new UnityProjectMismatch({ requested, actual: `实例清单里没有 ${this.options.instance}`, source: "显式指定的实例" })
      candidates = explicit.filter(instance => !instance.projectPath || normalizePath(instance.projectPath) === requested)
      if (candidates.length === 0) throw new UnityProjectMismatch({ requested, actual: explicit[0]!.projectPath ?? "(未报路径)", source: `显式实例 ${this.options.instance} 的工程` })
    }
    if (listing.length > 0 && candidates.length === 0) throw new UnityProjectMismatch({ requested, actual: listing.map(instance => instance.projectPath ?? "(未报路径)").join(", "), source: "MCP 实例清单里在跑的工程" })
    if (candidates.length > 1) throw new Error(`UNITY_INSTANCE_AMBIGUOUS: 工程 ${requested} 有 ${candidates.length} 个实例（${candidates.map(item => item.id).join(", ")}），请在构造时给 options.instance`)
    const target = candidates[0]
    if (target && this.boundInstance !== target.id) {
      await this.port.call(UNITY_SET_ACTIVE_INSTANCE_TOOL, { instance: target.id })
      this.boundInstance = target.id
    }
    const info = await this.port.readResource(UNITY_PROJECT_INFO_URI).catch(() => undefined)
    const actual = projectRootOf(info)
    if (actual && normalizePath(actual) !== requested) throw new UnityProjectMismatch({ requested, actual, source: "编辑器自报的工程根（mcpforunity://project/info）" })
    return { bound: Boolean(target), instance: target?.id ?? null, projectRoot: actual ?? null, instances: listing.length }
  }

  /**
   * 回执核对：编辑器自报的工程根必须与请求的工程一致，否则这次执行发生在别的项目里 ——
   * 明说并以 UnityProjectMismatch 抛出（调用方看得见"打错项目了"，而不是拿着别人的结果继续）。
   * 回执携带 projectRoot/processId/scene + import 的 changed(entityId) 列表，可直接作为交付证据。
   */
  private verifyReceipt(result: any): Record<string, unknown> {
    const projectRoot = typeof result.projectRoot === "string" ? result.projectRoot : ""
    if (projectRoot && normalizePath(projectRoot) !== normalizePath(this.requireProjectPath())) {
      throw new UnityProjectMismatch({ requested: normalizePath(this.requireProjectPath()), actual: `${projectRoot}（pid ${result.processId ?? "?"}）`, source: "执行回执" })
    }
    return {
      projectRoot: projectRoot || null, processId: typeof result.processId === "number" ? result.processId : null,
      instanceName: result.instanceName ?? null,
      scene: { path: result.scenePath ?? null, name: result.sceneName ?? null, guid: result.sceneGuid ?? null },
      changed: Array.isArray(result.changed) ? result.changed : [],
      requestId: result.requestId ?? null,
      startedAtUnixMs: result.startedAtUnixMs ?? null, finishedAtUnixMs: result.finishedAtUnixMs ?? null,
    }
  }

  private throwIfStopped(signal: AbortSignal | undefined, op: string, requestId: string, phase: string): void {
    if (!signal?.aborted) return
    throw new UnityExchangeCancelled({
      op, requestId, resultPath: requestId ? this.resultPathFor(requestId) : "", phase,
      claim: "pending", mayHaveStarted: false,
      observation: `取消发生在「${phase}」：这次调用还没把菜单发给编辑器（调用方 catch 里会再读一次文件事实核对）`,
    })
  }

  /**
   * 菜单调用是异步派发的：按 requestId 轮询**本次那个**结果文件。三种收场各自说清：
   *   - 拿到回执 → 返回（无论 ok）；
   *   - signal 取消 → UnityExchangeCancelled（本地停止等待；远端可能仍在跑，不谎称撤销）；
   *   - 观测超时 → UNITY_RESULT_TIMEOUT：只是没等到回执，**不自动重发、不重跑导入**。
   */
  private async awaitResult(resultPath: string, requestId: string, context: { op: string; signal?: AbortSignal }): Promise<any> {
    const timeoutMs = this.options.timeoutMs ?? 180_000
    const deadline = Date.now() + timeoutMs
    const pollMs = this.options.pollMs ?? 250
    let last = "还没有回执"
    for (; ;) {
      if (context.signal?.aborted) throw new UnityExchangeCancelled({
        op: context.op, requestId, resultPath, phase: "等回执",
        claim: "unknown", mayHaveStarted: true, observation: "等回执期间本地取消（远端是否已认领由调用方 catch 里的读文件事实定性）",
      })
      if (Date.now() >= deadline) {
        throw new Error(`UNITY_RESULT_TIMEOUT: 等了 ${timeoutMs}ms 没等到 ${requestId} 的回执（${last}）。`
          + `这只是本地观测超时：Unity 侧可能仍在执行，本调用不重发请求、不重跑导入；`
          + `回执若出现只会写在 ${resultPath}（requestId ${requestId}），可用 unity_scene_status 查。`)
      }
      try {
        const result = JSON.parse(await this.port.readFile(resultPath)) as { requestId?: string }
        if (result.requestId === requestId) return result
        // 路径唯一，理论上不可能读到别人的回执；真读到就明说，绝不把它当本次结果。
        last = `回执属于 ${result.requestId || "(空)"}，不是本次 ${requestId}`
      } catch (error) { last = String((error as Error)?.message ?? error) }
      await sleep(pollMs, context.signal)
    }
  }

  // ── Unity → 产品 ───────────────────────────────────────────────────────────

  /**
   * 读取 Unity 场景并写入产品场景：资源经 ResourceLibrary 登记（内容去重/版本/CAS），
   * 实体经 SceneStore 一次性提交（单次 revision，不留中间态）。
   *
   * **按身份窄更新**（不是"删掉根再重建"）：同一 entityId 的既有实体只更新交换负责的字段
   * （name/transform/resources/components.unity|light|visual|environment），用户自己加的组件、
   * 自己挂到交换实体下的子节点都留着；只有**来源真的删了**才删对应来源的对象。
   */
  async readScene(input: { sceneId: string; parentId?: string; includeInactive?: boolean; exportMeshes?: boolean; maxNodes?: number }, options: { signal?: AbortSignal } = {}): Promise<UnityExchangeReport> {
    const signal = options.signal
    // 交换暂存目录要工程根：**进入 invoke 之前**就先绑定一次（产品口每次调用是一个新实例，
    // 不先绑定的话这里读 scratchDirectory 会直接报 UNITY_PROJECT_UNKNOWN，见 ensureProjectPath）。
    await this.ensureProjectPath()
    const before = await this.scene.inspect(input.sceneId)
    // 导出文档也用唯一文件名：两条并行导出共用一个 unity-scene.json 时，后写的会盖掉先写的，
    // 先那条调用再去读就会读到别人的场景（回执路径对、内容窜位）。网格/贴图二进制按对象派生，同名同内容。
    const requestedDocumentPath = join(this.scratchDirectory, `unity-scene-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`)
    const result = await this.invoke("export", { export: {
      scenePath: "", includeInactive: input.includeInactive !== false, exportMeshes: input.exportMeshes !== false,
      hashAssets: false, maxNodes: input.maxNodes ?? 20000, documentPath: requestedDocumentPath,
    } }, signal)
    // 以回执自报的文档路径为准（编辑器可能改写）；没给才回落到请求路径。
    const documentPath = String(result.export?.documentPath ?? "") || requestedDocumentPath
    if (!documentPath) throw new Error("UNITY_EXPORT_NO_DOCUMENT")
    const document = normalizeUnityDocument(JSON.parse(await this.port.readFile(documentPath)) as UnitySceneDocument)
    if (document.kind !== UNITY_SCENE_KIND || document.version !== UNITY_SCENE_VERSION) throw new Error(`UNITY_DOCUMENT_MISMATCH: ${document.kind}@${document.version}`)
    const converted = await this.buildEntities(document, { sceneId: input.sceneId, parentId: input.parentId, before, signal })
    const environment = await this.buildEnvironmentEntity(document, before, converted.losses)
    const desired = environment ? [...converted.entities, environment] : converted.entities
    const plan = planUnitySync(before, desired, { sceneGuid: document.sceneGuid, losses: converted.losses })
    const snapshot = plan.patch.length > 0 ? await this.scene.scene.commit({ sceneId: input.sceneId, expectedRevision: before.revision, patch: plan.patch }) : before
    return {
      sceneId: input.sceneId, revision: snapshot.revision,
      unityScene: { path: document.scenePath, name: document.sceneName, guid: document.sceneGuid },
      entities: converted.entities.length, resources: converted.resources, identity: converted.identity,
      losses: [...(document.losses ?? []), ...converted.losses], documentPath,
      meshFiles: result.export?.meshFileCount ?? 0,
      binding: result.binding,
      // 执行回执原文（工程/进程/场景/改动清单/requestId）：真实 MCP 任务的交付证据，随报告一起返回。
      receipt: result.receipt,
      sync: {
        added: plan.added, updated: plan.updated, removed: plan.removed, reparented: plan.reparented, kept: plan.kept,
        // 非交换（用户）子对象改挂与为保形状留下的结构节点：来源对象之间的改挂不混进"用户内容"计数。
        userReparented: plan.userReparented, framesKept: plan.framesKept,
      },
      ...(environment ? {
        environment: {
          entityId: UNITY_ENVIRONMENT_ENTITY_ID,
          component: environment.components[ENVIRONMENT_COMPONENT_KEY] as ProductSceneEnvironment,
        },
      } : {}),
    }
  }

  /**
   * 场景级环境读数 → 产品实体（`components.environment`，45 的 SceneEnvironment 合同）：
   * 强度/背景/太阳/阴影按字段映射；曝光与昼夜是 Unity 侧**没有读数**的字段，沿用产品现值（不覆盖用户设置）。
   * 文档带了 .hdr/.exr（Unity 天空盒的 HDRI 副本）时先按资源登记，组件里只留 `resourceId@version`；
   * 程序化天空盒（shader，不是 HDRI 文件）只记损失。
   */
  private async buildEnvironmentEntity(document: UnitySceneDocument, before: SceneSnapshot, losses: string[]): Promise<Entity | undefined> {
    const environment = document.environment
    if (!environment) return undefined
    if (environment.present !== true) {
      losses.push("ENVIRONMENT_ABSENT: 文档里的环境读数 present=false（这次没采到），产品侧已有环境组件不动")
      return undefined
    }
    const existing = before.entities.find(entity => entity.entityId === UNITY_ENVIRONMENT_ENTITY_ID)
    const previous = existing?.components?.[ENVIRONMENT_COMPONENT_KEY] as Record<string, unknown> | undefined
    const mapped = productEnvironmentFromUnity(environment, previous)
    if (!mapped.component) return undefined
    losses.push(...mapped.losses)

    const resources: ResourceRef[] = [...(existing?.resources ?? [])]
    if (environment.hdriFile) {
      try {
        const path = join(this.requireProjectPath(), environment.hdriFile)
        const imported = await this.scene.import({
          path, resourceId: unityResourceIdFor(UNITY_ENVIRONMENT_ENTITY_ID, environment.hdriAssetPath || environment.hdriFile),
          name: "UnitySkyboxHdri", source: { ...PRODUCT_SPACE_SOURCE }, physicalize: false,
        })
        const ref = (imported.resource as ResourceRecord).ref
        mapped.component.hdri = { resourceId: ref.resourceId, version: ref.version }
        if (!resources.some(item => item.resourceId === ref.resourceId)) resources.push(ref)
        losses.push(`ENVIRONMENT_HDRI_IMPORTED: ${environment.hdriFile}（${environment.hdriBytes} 字节，来自 ${environment.hdriAssetPath || "Unity 天空盒"}）→ ${ref.resourceId}@${ref.version}`)
      } catch (error) {
        losses.push(`ENVIRONMENT_HDRI_IMPORT_FAILED: ${environment.hdriFile} 没能作为资源登记（${String((error as Error)?.message ?? error)}），产品侧环境不含 HDRI`)
      }
    } else if (environment.skyboxShader) {
      losses.push(`ENVIRONMENT_SKYBOX_NOT_TRANSFERRED: Unity 天空盒是 shader '${environment.skyboxShader}'（程序化/非 .hdr 文件），产品侧只有 HDRI 资源或内置环境光，本次不带天空`)
    }
    return {
      entityId: UNITY_ENVIRONMENT_ENTITY_ID,
      name: existing?.name ?? `环境（Unity ${document.sceneName || "scene"}）`,
      transform: existing?.transform ?? { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources,
      components: { ...(existing?.components ?? {}), [ENVIRONMENT_COMPONENT_KEY]: mapped.component },
    }
  }

  /** 交换文档 → 产品实体（纯计算 + 资源登记，不改场景）。 */
  private async buildEntities(document: UnitySceneDocument, input: { sceneId: string; parentId?: string; before: SceneSnapshot; signal?: AbortSignal }): Promise<{ entities: Entity[]; replaced: string[]; resources: number; identity: Array<{ entityId: string; unity: string; name: string }>; losses: string[] }> {
    const snapshot = input.before
    const existing = new Set(snapshot.entities.map(entity => entity.entityId))
    const entities: Entity[] = []
    const replaced = new Set<string>()
    const identity: Array<{ entityId: string; unity: string; name: string }> = []
    const losses: string[] = []
    const mapped = new Map<number, string>()
    const byIndex = new Map(document.nodes.map(node => [node.index, node]))
    let resources = 0

    for (const node of document.nodes) {
      // 每个节点之间是可取消点：读场景可能要导入几百个网格，取消要在这里就停下。
      this.throwIfStopped(input.signal, "export", "", "逐节点落资源")
      const entityId = productEntityIdFor(node)
      const name = node.name?.trim() || `UnityNode ${node.index}`
      // Unity 侧逐节点记的损失同时进总表：元数据里也有一份，但调用方看 report.losses 就能看到全貌。
      for (const loss of node.losses ?? []) losses.push(`${name}: ${loss}`)
      const transform = convertTransform(localTransformOf(node, losses, name))
      const parentId = node.parentIndex >= 0 ? mapped.get(node.parentIndex) ?? input.parentId : input.parentId
      const origin: UnityOriginMetadata = {
        space: { units: "m", upAxis: "Y", handedness: "left", quaternion: "xyzw" },
        globalId: node.globalId ?? "", tag: node.tag ?? "", layer: node.layer ?? 0, active: node.active !== false,
        componentTypes: node.componentTypes ?? [],
        // 只写有的字段：SceneStore 只接受 JSON 值，值为 undefined 的键会被判非法文档。
        ...(node.mesh ? { mesh: node.mesh } : {}), ...(node.materials ? { materials: node.materials } : {}),
        ...(node.light ? { light: node.light } : {}), ...(node.camera ? { camera: node.camera } : {}),
        ...(node.prefab ? { prefab: node.prefab } : {}), ...(node.terrain ? { terrain: node.terrain } : {}),
        losses: [...(node.losses ?? [])],
      }
      if (existing.has(entityId)) replaced.add(entityId)
      const hasMeshBinary = Boolean(node.mesh?.file) && (node.mesh?.vertexCount ?? 0) > 0
      if (hasMeshBinary) {
        // 网格对象：资源走既有 ResourceLibrary，实体树走既有的 glbEntities（组根 + 源坐标转换 + 节点）。
        const path = join(this.requireProjectPath(), node.mesh!.file)
        const imported = await this.scene.import({ path, resourceId: unityResourceIdFor(entityId, node.globalId || name), name: node.mesh!.name || name, source: { ...PRODUCT_SPACE_SOURCE }, physicalize: false })
        // SceneOperations.import 的返回类型只声明了 ResourceRecord，运行时是 Resources.import 的原样返回（带 alreadyPresent）。
        const record = imported.resource as ResourceRecord & { alreadyPresent?: boolean }
        resources++
        if (record.alreadyPresent) losses.push(`RESOURCE_REUSED: ${name} 命中资源库内容去重（同一对象同字节不升版本）`)
        const subtree = glbEntities(record.ref, record.parsed, entityId, name, transform)
        if (parentId) subtree[0]!.parentId = parentId
        subtree[0]!.components = { ...subtree[0]!.components, unity: origin }
        if (node.light) {
          // 灯与网格同体：Viewer 见到 light 组件就只渲染灯，硬塞进去会让这个对象的网格消失。
          // 因此保留网格、把灯记为损失（Unity 侧对象本身仍在，灯的信息留在元数据里）。
          origin.losses = [...origin.losses, "LIGHT_ON_MESH_NODE_NOT_MAPPED"]
          losses.push(`LIGHT_ON_MESH_NODE_NOT_MAPPED: ${name} 同时有网格与灯，产品一次只渲染其中之一，本次保留网格`)
        }
        // 展开出来的子节点不再单独删：组根已经在 remove 里 cascade，重复删同一批会让提交报 ENTITY_NOT_FOUND。
        for (const entity of subtree) entities.push(entity)
        // 地形里的树实例：几何按**原型共享**（一份 GLB 给 N 棵树），实例只写位置/朝向/缩放。
        if (node.terrain) resources += await this.buildTreeInstances({ terrain: node.terrain, terrainEntityId: entityId, terrainName: name, entities, replaced, existing, losses })
      } else {
        const light = node.light ? unityLightToProduct(node.light, unityWorldForward(node, byIndex)) : undefined
        if (light) origin.losses = [...origin.losses, ...light.losses]
        entities.push({
          entityId, ...(parentId ? { parentId } : {}), name, transform, resources: [],
          components: { unity: origin, ...(light ? { light: light.component } : {}) },
        })
      }
      mapped.set(node.index, entityId)
      identity.push({ entityId, unity: node.globalId ?? "", name })
    }
    return { entities, replaced: [...replaced], resources, identity, losses }
  }

  /**
   * 地形里的树实例 → 产品实体。Unity 的 `TreeInstance` 只是 TerrainData 里的一条数据（不是场景对象），
   * 但它必须在产品里**看得见**，否则"Unity 里看得见"就变成"产品里没有"：
   *   - 几何按**原型共享**：每种用到的 prefab 只导入一份 GLB（`vegetation/prototype-NN.glb`），N 棵树共用这一个资源；
   *   - 实例实体只带位置/绕 Y 旋转/宽高缩放（Unity 也只给这些自由度），挂在地形对象下、走同一个轴换算，
   *     因此世界位姿与 Unity 里一致（树局部变换 = 归一化位置 × TerrainData.size，正是 Unity 的语义）；
   *   - `components.unity.terrainTree` 记原型与原始参数，写回时折回地形的 `instances`（不在地形旁边多出一堆 Unity 对象）；
   *   - 原型的几何没交付出来（或树只该是数据）时退化成"只留数据的实体"，位置照旧、写回不丢。
   */
  private async buildTreeInstances(input: {
    terrain: UnityTerrainRecord; terrainEntityId: string; terrainName: string
    entities: Entity[]; replaced: Set<string>; existing: Set<string>; losses: string[]
  }): Promise<number> {
    const { terrain, terrainEntityId, terrainName, entities, replaced, existing, losses } = input
    const instances = terrain.instances ?? []
    const declared = terrain.treeInstanceCount ?? 0
    if (instances.length === 0) {
      // 空数组是**权威**的"真的没有树"（C# 侧总是写这个数组）：不落任何实体，写回时清空 Unity 的树。
      if (declared > 0) losses.push(`TERRAIN_TREE_LIST_MISSING: ${terrainName} 文档里有 ${declared} 棵树，但实例清单是空数组，本次不带植被（写回时以清单为准）`)
      return 0
    }
    if (declared !== instances.length) losses.push(`TERRAIN_TREE_COUNT_MISMATCH: ${terrainName} 树实例清单 ${instances.length} 条与文档计数 ${declared} 不一致（按清单走）`)
    const prototypes = terrain.treePrototypes ?? []
    const used = [...new Set(instances.map(instance => instance.prototypeIndex))].sort((a, b) => a - b)
    const geometry = new Map<number, { ref: ResourceRef; parsed: ResourceRecord["parsed"] }>()
    let resources = 0
    for (const index of used) {
      const prototype = prototypes[index]
      if (!prototype) { losses.push(`TERRAIN_TREE_PROTOTYPE_INDEX_OUT_OF_RANGE: ${terrainName} 有实例引用原型 #${index}，但原型表只有 ${prototypes.length} 个，这些树只留数据`); continue }
      if (!prototype.meshFile) {
        losses.push(`TERRAIN_TREE_GEOMETRY_MISSING: ${terrainName} 原型 #${index}（${prototype.prefabPath || "无 prefab"}）没有交付几何${prototype.meshError ? `（${prototype.meshError}）` : ""}，这些树只留数据（写回照旧恢复 TreeInstance）`)
        continue
      }
      try {
        const path = join(this.requireProjectPath(), prototype.meshFile)
        const imported = await this.scene.import({
          path, resourceId: unityResourceIdFor(terrainEntityId, `vegetation:${prototype.prefabGuid || index}`),
          name: prototypeNameOf(prototype, index), source: { ...PRODUCT_SPACE_SOURCE }, physicalize: false,
        })
        const record = imported.resource as ResourceRecord & { alreadyPresent?: boolean }
        geometry.set(index, { ref: record.ref, parsed: record.parsed })
        resources++
        if (record.alreadyPresent) losses.push(`RESOURCE_REUSED: ${terrainName} 原型 #${index} 的共享几何命中资源库内容去重（同一对象同字节不升版本）`)
      } catch (error) {
        losses.push(`TERRAIN_TREE_PROTOTYPE_IMPORT_FAILED: ${terrainName} 原型 #${index} 的几何没能登记为资源（${String((error as Error)?.message ?? error)}），这些树只留数据`)
      }
    }
    let dataOnly = 0, tinted = 0
    for (const [index, instance] of instances.entries()) {
      const entityId = `${terrainEntityId}:tree:${index}`
      const prototype = prototypes[instance.prototypeIndex]
      const unity: UnityOriginMetadata = {
        space: { units: "m", upAxis: "Y", handedness: "left", quaternion: "xyzw" },
        // 树实例没有 GlobalObjectId（不是场景对象）：身份靠 `:tree:<i>` 的 id 约定，写回折进地形。
        globalId: "", tag: "", layer: 0, active: true, componentTypes: ["Transform"],
        terrainTree: {
          terrainEntityId, index, prototypeIndex: instance.prototypeIndex,
          prototypePrefabPath: prototype?.prefabPath ?? "", prototypePrefabGuid: prototype?.prefabGuid ?? "",
          position: [...instance.position], widthScale: instance.widthScale, heightScale: instance.heightScale,
          rotationRad: instance.rotationRad, color: [...instance.color],
        },
        losses: [],
      }
      const name = `${terrainName}·树${index}${prototype ? `（原型 ${prototypeNameOf(prototype, instance.prototypeIndex)}）` : ""}`
      const transform = convertTransform(treeInstanceTransform(instance, terrain))
      const bin = geometry.get(instance.prototypeIndex)
      if (bin) {
        const subtree = glbEntities(bin.ref, bin.parsed, entityId, name, transform)
        subtree[0]!.parentId = terrainEntityId
        subtree[0]!.components = { ...subtree[0]!.components, unity }
        for (const entity of subtree) entities.push(entity)
      } else {
        dataOnly++
        entities.push({ entityId, parentId: terrainEntityId, name, transform, resources: [], components: { unity } })
      }
      if (existing.has(entityId)) replaced.add(entityId)
      const [r, g, b, a] = instance.color ?? [1, 1, 1, 1]
      if ([r!, g!, b!, a!].some(value => Math.abs(value - 1) > 1e-3)) tinted++
    }
    losses.push(`TERRAIN_VEGETATION_DELIVERED: ${terrainName} ${instances.length} 棵树共用 ${geometry.size} 个原型几何（不逐树复制素材），原型 prefab 连接保留在元数据里`)
    if (tinted > 0) losses.push(`TERRAIN_TREE_COLOR_NOT_APPLIED: ${terrainName} 里 ${tinted}/${instances.length} 棵树带 Unity 的逐树 color（TreeInstance.color），产品侧按原型原色渲染，颜色只留在元数据里（写回原样恢复）`)
    if (dataOnly > 0) losses.push(`TERRAIN_TREE_DATA_ONLY: ${terrainName} 里 ${dataOnly}/${instances.length} 棵树没有可渲染几何，只留位置/参数（写回照旧恢复成 Unity 的 TreeInstance）`)
    return resources
  }

  // ── 产品 → Unity ───────────────────────────────────────────────────────────

  /**
   * 把产品场景写成 Unity 可执行文档并落到 Unity：网格以 LPMESH（原始 float32 顶点/索引）随文档交付，
   * Unity 侧直接建 Mesh 资产，不经模型导入器（不做第二次轴向/单位猜测）。
   * mode=current 写当前场景；new/additive 另开场景并保存，不动用户已打开的场景。
   */
  async writeScene(input: { sceneId: string; mode?: "current" | "new" | "additive"; scenePath?: string; assetFolder?: string; dryRun?: boolean }, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const signal = options.signal
    this.throwIfStopped(signal, "import", "", "开始前")
    // 同 readScene：文档要写进交换暂存目录（需要工程根），绑定必须在读 scratchDirectory 之前完成。
    await this.ensureProjectPath()
    const snapshot = await this.scene.inspect(input.sceneId)
    const document = await this.buildDocument(snapshot)
    this.throwIfStopped(signal, "import", "", "交付文档之前")
    // 文档名带 requestId，避免两次写并行时共用一份 product-scene.json（网格二进制同理带唯一名）。
    const documentName = `product-scene-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.json`
    const documentPath = join(this.scratchDirectory, documentName)
    await this.port.writeJSONAtomic(documentPath, document)
    const result = await this.invoke("import", { import: {
      documentPath, mode: input.mode ?? "current", scenePath: input.scenePath ?? "", saveScene: true,
      dryRun: input.dryRun === true, assetFolder: input.assetFolder ?? "Assets/LyapunovSceneExchange/Imported", metersPerUnit: 1,
    } }, signal)
    return {
      sceneId: input.sceneId, revision: snapshot.revision, documentPath, nodes: document.nodes.length,
      unity: result.import, binding: result.binding, losses: [...document.losses, ...(result.warnings ?? [])],
      receipt: result.receipt,
    }
  }

  /** 产品场景 → 交换文档（数值一律 Unity 原生空间）+ 网格二进制文件。 */
  private async buildDocument(snapshot: SceneSnapshot): Promise<UnitySceneDocument> {
    const nodes: UnityNode[] = []
    const losses: string[] = []
    const mappedIndex = new Map<string, number>()
    const suppressed = suppressedEntityIds(snapshot)
    // 植被实例实体（`<地形>:tree:<i>`）不是 Unity 场景对象：它们折进地形节点的 instances，不各写一个 Unity 对象。
    const vegetation = vegetationOf(snapshot)
    for (const entity of orderByHierarchy(snapshot)) {
      if (suppressed.has(entity.entityId)) continue
      // 交换从植被实体展开出来的子节点（`:source` / `:node:i`）跟着根一起折掉；
      // 用户挂在树下面的对象**不**折（它不是树自己的几何），它按最近映射祖先（地形）折算世界位姿。
      if (vegetation.has(entity.entityId) || vegetation.has(exchangeExpandedRoot(entity.entityId) ?? "")) continue
      const visual = entity.components.visual as Visual | undefined
      const unity = entity.components.unity as UnityOriginMetadata | undefined
      const lightComponent = entity.components.light as Record<string, unknown> | undefined
      const isUnityOrigin = Boolean(unity)
      const hasGeometry = visual?.kind === "mesh" && typeof visual.gltfNode === "number"
      if (!isUnityOrigin && !hasGeometry && !lightComponent && visual?.kind !== "splat" && visual?.kind !== "robot") continue
      const unityWorld = unityWorldMatrix(snapshot, entity.entityId)
      const world = decomposeMatrix(unityWorld)
      const nodeLosses: string[] = []
      if (unityWorld.determinant() < 0) nodeLosses.push("MIRRORED_WORLD_TRANSFORM: 世界矩阵行列式为负（镜像），Unity 侧以负缩放表达")
      const ancestorId = nearestMappedAncestor(snapshot, entity, mappedIndex)
      const local = ancestorId === undefined ? world : unityLocalTransform(unityWorld, unityWorldMatrix(snapshot, ancestorId))
      const record: UnityNode = {
        index: nodes.length, parentIndex: ancestorId === undefined ? -1 : mappedIndex.get(ancestorId)!,
        name: entity.name, entityId: entity.entityId, globalId: unity?.globalId ?? "",
        position: local.position, rotation: local.quaternion, scale: local.scale,
        active: unity?.active ?? true, tag: unity?.tag ?? "", layer: unity?.layer ?? 0,
        componentTypes: unity?.componentTypes ?? ["Transform"], losses: nodeLosses,
      }
      if (isUnityOrigin) {
        record.mesh = unity!.mesh ?? null
        record.materials = unity!.materials ?? null
        record.camera = unity!.camera ?? null
        record.prefab = unity!.prefab ?? null
        record.terrain = unity!.terrain ?? null
        // 植被实例在 Unity 里不是场景对象：把产品里的树实体反算回 TreeInstance 列表（局部修改在这里生效）。
        if (record.terrain) this.foldTreeInstances(snapshot, entity.entityId, record, vegetation, record.losses)
      }
      if (hasGeometry || (isUnityOrigin && (unity!.mesh?.vertexCount ?? 0) > 0)) {
        const geometry = geometryEntities(snapshot, entity)
        if (geometry.length === 0) record.losses.push("MESH_GEOMETRY_MISSING: 元数据说有网格，但产品里找不到几何节点")
        if (geometry.length > 1) record.losses.push(`MULTI_GEOMETRY_NODES: 资源含 ${geometry.length} 个几何节点，本次只取第一个`)
        if (geometry[0]) await this.writeMeshFile(record, geometry[0], snapshot, entity, geometry.length)
      } else if (visual?.kind === "splat" || visual?.kind === "robot") {
        record.losses.push(`VISUAL_KIND_NOT_TRANSFERRED: ${visual.kind} 不写成 Unity 网格（产品渲染件），Unity 侧只留空对象与元数据`)
      }
      if (lightComponent) {
        const forward = productLightForward(snapshot, entity.entityId)
        const converted = productLightToUnity(lightComponent, forward)
        // Unity 来源的实体：产品 light 组件表达不了的字段（阴影/反弹/range/enabled）从保留的原记录补回来，
        // 表达得了的字段（类型/颜色/强度/角度）以产品组件为准 —— 用户可能在产品里改过它们。
        const preserved = isUnityOrigin ? unity!.light ?? null : null
        record.light = preserved ? {
          ...converted.light, shadows: preserved.shadows, bounceIntensity: preserved.bounceIntensity,
          range: preserved.range, enabled: preserved.enabled,
          // 灯型被改过时，原记录的 spotAngleDeg/areaSize 不再对应，丢弃。
          ...(preserved.type === converted.light.type ? { spotAngleDeg: preserved.spotAngleDeg, areaSize: preserved.areaSize } : {}),
        } : converted.light
        record.losses.push(...converted.losses)
        const declared = Array.isArray(lightComponent.direction) ? lightComponent.direction as number[] : undefined
        if (declared && Math.hypot(declared[0]! - forward[0], declared[1]! - forward[1], declared[2]! - forward[2]) > 1e-3)
          record.losses.push("LIGHT_DIRECTION_FROM_TRANSFORM: 产品灯方向与实体朝向不一致，Unity 侧按实体朝向建灯")
      }
      // 逐节点损失同时汇总到文档总表（节点上也有一份），调用方看 losses 就能看到全貌。
      for (const loss of record.losses) losses.push(`${record.name}: ${loss}`)
      mappedIndex.set(entity.entityId, record.index)
      nodes.push(record)
    }
    const environment = unityEnvironmentFromSnapshot(snapshot)
    return {
      kind: UNITY_SCENE_KIND, version: UNITY_SCENE_VERSION, generator: `scene-kit/unity-exchange@${UNITY_SCENE_VERSION}`,
      generatedAtUnixMs: Date.now(), scenePath: "", sceneName: snapshot.sceneId, sceneGuid: "",
      transformSpace: "unity-left-handed-y-up-meters", meshSpace: "unity-left-handed-y-up-meters",
      environment: environment.environment, nodes, assets: [], losses: [...losses, ...environment.losses],
    }
  }

  /**
   * 产品里的植被实体 → 地形的 `TreeInstance` 清单（写回时的**权威**清单）。
   *
   * 位置按"相对地形对象的局部空间"反算（TerrainData 的 size 单位），再按 size 归一化回 0..1 ——
   * 与读入侧 `treeInstanceTransform` 严格互逆：在产品里把一棵树抬高 1 米，写回 Unity 就是同一棵树抬高 1 米。
   * `TreeInstance` 只有"位置 + 绕 Y 的偏航 + 水平/高度缩放"四个自由度，装不下的（绕 X/Z 的旋转、
   * 水平两轴不等比缩放、含剪切的父链）按最接近的值写回并**点名**损失，不静默四舍五入。
   */
  private foldTreeInstances(snapshot: SceneSnapshot, terrainEntityId: string, record: UnityNode, vegetation: Map<string, { entity: Entity; meta: NonNullable<UnityOriginMetadata["terrainTree"]> }>, nodeLosses: string[]): void {
    const terrain = record.terrain!
    const trees = [...vegetation.values()].filter(item => item.meta.terrainEntityId === terrainEntityId)
    if (trees.length === 0) {
      const declared = terrain.instances?.length ?? terrain.treeInstanceCount ?? 0
      if (terrain.treeInstancesAuthoritative === true) {
        // 读入时带权威清单、产品里却一棵都不剩：用户把树删光了 —— 清空（与"删一棵"同一套语义）。
        terrain.instances = []; terrain.treeInstanceCount = 0
        if (declared > 0) nodeLosses.push(`TERRAIN_TREES_CLEARED: 读入时有 ${declared} 棵树，产品场景里已一棵不剩，写回时清空 Unity 的 TreeInstance`)
      } else {
        // 旧版/手写文档：产品里没有对应的植被实体，Unity 侧保持原样，不静默删树。
        terrain.treeInstancesAuthoritative = false
        if (declared > 0) nodeLosses.push(`TERRAIN_TREE_ENTITIES_MISSING: 元数据里有 ${declared} 棵树但产品里找不到对应的植被实体（旧版读入的场景），写回时保持 Unity 侧原样，不静默删树`)
      }
      return
    }
    const prototypes = terrain.treePrototypes ?? []
    const size = [terrain.widthM, terrain.heightM, terrain.lengthM]
    const inverse = unityWorldMatrix(snapshot, terrainEntityId).clone().invert()
    const instances: UnityTreeInstanceRecord[] = []
    let unresolved = 0
    for (const { entity, meta } of trees) {
      const relative = inverse.clone().multiply(unityWorldMatrix(snapshot, entity.entityId))
      const local = decomposeMatrix(relative)
      const rebuilt = localMatrix(local)
      let shear = 0
      for (let index = 0; index < 16; index++) shear = Math.max(shear, Math.abs(rebuilt.elements[index]! - relative.elements[index]!))
      if (shear > POSE_SHEAR_TOLERANCE) nodeLosses.push(`TERRAIN_TREE_TRANSFORM_SHEAR: ${entity.name} 相对地形的变换装不进"位置+绕Y旋转+缩放"（偏差 ${shear.toExponential(3)}），按最接近的 TRS 写回`)
      const [qx, qy, qz, qw] = local.quaternion
      if (Math.abs(qx!) > 1e-6 || Math.abs(qz!) > 1e-6) nodeLosses.push(`TERRAIN_TREE_ROTATION_NOT_REPRESENTABLE: ${entity.name} 相对地形不是纯绕 Y 的旋转（四元数 x=${qx}, z=${qz}），TreeInstance 只存偏航角，写回按绕 Y 的分量`)
      const rotationRad = Math.atan2(2 * (qw! * qy! + qx! * qz!), 1 - 2 * (qy! * qy! + qz! * qz!))
      const [sx, sy, sz] = local.scale
      if (Math.abs(sx! - sz!) > 1e-6) nodeLosses.push(`TERRAIN_TREE_HORIZONTAL_SCALE_UNEQUAL: ${entity.name} 水平两轴缩放不等（x=${sx}, z=${sz}），TreeInstance 的水平缩放只有一个值，写回取平均`)
      if (sx! <= 0 || sy! <= 0 || sz! <= 0) nodeLosses.push(`TERRAIN_TREE_NONPOSITIVE_SCALE: ${entity.name} 缩放非正（${sx}, ${sy}, ${sz}），TreeInstance 的缩放是正的，写回原样带入（Unity 侧会当作镜像/退化树）`)
      const key = meta.prototypePrefabGuid || meta.prototypePrefabPath
      let prototypeIndex = key ? prototypes.findIndex(item => item.prefabGuid === key || item.prefabPath === key) : -1
      if (prototypeIndex < 0 && !key && meta.prototypeIndex >= 0 && meta.prototypeIndex < prototypes.length) prototypeIndex = meta.prototypeIndex
      if (prototypeIndex < 0) {
        unresolved++
        nodeLosses.push(`TERRAIN_TREE_PROTOTYPE_UNRESOLVED: ${entity.name} 的原型（${key || "未记"}）不在当前地形的原型表里，这棵树不写成 Unity 的 TreeInstance`)
        continue
      }
      instances.push({
        position: local.position.map((value, axis) => (size[axis] ?? 0) > 0 ? value / size[axis]! : 0),
        widthScale: (sx! + sz!) / 2, heightScale: sy!, rotationRad,
        color: [...(meta.color ?? [1, 1, 1, 1])], prototypeIndex,
      })
    }
    terrain.instances = instances
    terrain.treeInstanceCount = instances.length
    terrain.treeInstancesAuthoritative = true
    if (unresolved > 0) nodeLosses.push(`TERRAIN_TREES_PARTIAL: ${record.name} 的 ${trees.length} 棵树里有 ${unresolved} 棵原型对不上，写回的清单只有 ${instances.length} 条`)
  }

  /** 网格 → LPMESH v2 二进制（Unity 直接建 Mesh，不经导入器；UV/子网格/材质/贴图字节一起交付）。 */
  private async writeMeshFile(record: UnityNode, geometryEntity: Entity, snapshot: SceneSnapshot, rootEntity: Entity, geometryCount: number): Promise<void> {
    const ref = geometryEntity.resources[0]
    if (!ref) { record.losses.push(`MESH_RESOURCE_MISSING: ${geometryEntity.entityId}`); return }
    const visual = geometryEntity.components.visual as Visual | undefined
    const representation = ref.representations.find(rep => rep.role === "visual") ?? ref.original
    const path = representation.uri.startsWith("file:") ? decodeURIComponent(new URL(representation.uri).pathname) : representation.uri
    let geometry: GlbGeometry
    try { geometry = await readGlbGeometry(path, visual?.gltfNode) }
    catch (error) { record.losses.push(`MESH_DECODE_FAILED: ${String((error as Error)?.message ?? error)}`); return }

    // 几何节点到"产品里将被写成 GameObject 的那个实体"的相对变换（产品空间）。
    // 多数情况是恒等（几何节点就是根，或 Unity 来源对象的展开节点变换为空），
    // 但 GLB 自带的节点变换必须折进来，否则几何会错位。
    const bake = worldMatrix(snapshot, rootEntity.entityId).clone().invert().multiply(worldMatrix(snapshot, geometryEntity.entityId))
    // 顶点：先折相对变换到产品空间，再做 M⁻¹。法线用逆置转置，绕序按 det(M⁻¹·bake) 决定是否翻转。
    const toUnity = AXIS_SWAP.clone().invert().multiply(bake)
    const normalMatrix = new Matrix4().copy(toUnity).invert().transpose()
    const positions = new Float32Array(geometry.positions.length)
    const point = new Vector3()
    for (let offset = 0; offset < geometry.positions.length; offset += 3) {
      point.set(geometry.positions[offset]!, geometry.positions[offset + 1]!, geometry.positions[offset + 2]!).applyMatrix4(toUnity)
      positions[offset] = point.x; positions[offset + 1] = point.y; positions[offset + 2] = point.z
    }
    const normals = geometry.normals ? new Float32Array(geometry.normals.length) : undefined
    if (normals && geometry.normals) for (let offset = 0; offset < geometry.normals.length; offset += 3) {
      const normal = new Vector3(geometry.normals[offset]!, geometry.normals[offset + 1]!, geometry.normals[offset + 2]!).applyMatrix4(normalMatrix)
      // 只有在变换真的改了长度时才归一化：刚体/轴交换保持长度（逐分量换序，位都不差），
      // 无脑 normalize() 会把每个分量挪 1 ulp —— 1e-6 量化正好卡在边界上的分量就会翻一格，
      // 于是"内容没变"的资产被判成变了、被迫派生新资产（真实踩过：植物 345 个法线分量里 9 个翻格）。
      // 零长法线（Unity 的 RecaculateNormals 会留下 (0,0,0)）必须原样带着：给它归一化会变成 NaN。
      const length = normal.length()
      if (length > 1e-6 && Math.abs(length - 1) > 1e-6) normal.divideScalar(length)
      normals[offset] = normal.x; normals[offset + 1] = normal.y; normals[offset + 2] = normal.z
    }
    const flip = toUnity.determinant() < 0
    const indices = new Uint32Array(geometry.indices.length)
    for (let offset = 0; offset + 2 < geometry.indices.length; offset += 3) {
      indices[offset] = geometry.indices[offset]!
      indices[offset + 1] = flip ? geometry.indices[offset + 2]! : geometry.indices[offset + 1]!
      indices[offset + 2] = flip ? geometry.indices[offset + 1]! : geometry.indices[offset + 2]!
    }
    // UV：GLB 里是 glTF 约定（左上原点），LPMESH 交给 Unity 的是 Unity 约定（左下原点），
    // encodeLpmesh 按 uvSpace="gltf" 只翻 v。顶点顺序与位置一一对应，所以逐顶点原样带过去。
    const uvs = geometry.uvs ? Float32Array.from(geometry.uvs) : undefined
    // 材质表：逐子网格，顺序与 geometry.submeshes[].material 一致（Unity 子网格顺序 = primitive 顺序）。
    // Unity 来源的对象用文档里的材质记录（颜色以用户在产品里改过的值为准），其它来源用 glTF 材质；
    // 贴图字节一律来自 GLB 内嵌图片 —— 它就是 Unity 侧真的写出去的那份字节。
    const origin = rootEntity.components.unity as UnityOriginMetadata | undefined
    const materials: LpmeshMaterialInput[] = geometry.materials.map((material, index) => {
      const fromDocument = origin?.materials?.[index]
      return {
        name: fromDocument?.name ?? material.name,
        baseColor: fromDocument?.baseColor ?? material.baseColor,
        metallic: fromDocument?.metallic ?? material.metallic,
        smoothness: fromDocument?.smoothness ?? 1 - material.roughness,
        textures: material.textures.map(texture => ({
          property: texture.property, mimeType: texture.mimeType, wrapMode: texture.wrapMode,
          contentDigest: texture.contentDigest, bytes: texture.bytes,
        })),
      }
    })
    const bytes = encodeLpmesh({ positions, normals, uvs, indices, submeshes: geometry.submeshes, materials }, { uvSpace: "gltf" })
    const relative = join(UNITY_EXCHANGE_SCRATCH, "meshes", `entity-${record.index.toString().padStart(4, "0")}.lpmesh`)
    await this.port.writeBinary(join(this.requireProjectPath(), relative), bytes)
    // 几何已经折进这个 GameObject 的局部空间，因此它自己的变换就是记录里的世界变换；
    // 资源里多出来的几何节点本次不建对象（上面已记 MULTI_GEOMETRY_NODES 损失）。
    if (geometryCount === 1 && geometryEntity.entityId !== rootEntity.entityId) record.losses.push("GEOMETRY_FOLDED: 几何节点的局部变换已折进本对象的网格，资源展开层级不再单独建对象")
    // Unity 来源的对象保留它原来的资产引用、原始体类型与**内容摘要**：Unity 侧据此判"资产还是不是这份内容"
    // （摘要一致才沿用资产身份，不一致就派生新资产）。摘要缺失时导入侧不当作相同，会派生并写明。
    record.mesh = {
      name: rootEntity.name, primitive: origin?.mesh?.primitive ?? "", assetPath: origin?.mesh?.assetPath ?? "", assetGuid: origin?.mesh?.assetGuid ?? "",
      vertexCount: positions.length / 3, triangleCount: indices.length / 3, subMeshCount: geometry.submeshes.length,
      uvCount: uvs ? uvs.length / 2 : 0, contentDigest: origin?.mesh?.contentDigest ?? "",
      boundsCenter: [0, 0, 0], boundsSize: [0, 0, 0],
      file: relative, fileSpace: "unity-left-handed-y-up-meters-raw", fileBytes: bytes.length,
    }
    if (!origin?.materials?.length && geometry.materials.length > 0) {
      record.materials = geometry.materials.map(material => ({
        name: material.name, assetPath: "", assetGuid: "", shader: "Standard",
        baseColor: material.baseColor, metallic: material.metallic, smoothness: 1 - material.roughness,
        textures: material.textures.map(texture => `${texture.property}=（GLB 内嵌 ${texture.mimeType} ${texture.bytes.length} 字节 ${texture.contentDigest}）`),
        textureFiles: material.textures.map(texture => ({
          property: texture.property, assetPath: "", assetGuid: "", file: "", mimeType: texture.mimeType,
          bytes: texture.bytes.length, width: 0, height: 0, wrapMode: texture.wrapMode, contentDigest: texture.contentDigest, reencoded: false,
        })),
      }))
      record.losses.push("MATERIAL_FROM_GLTF: 材质按 glTF 的 baseColor/metallic/roughness 重建，baseColor 贴图字节随 LPMESH 内嵌交付（尺寸未解出，记 0）")
    } else if (origin?.materials?.length) record.materials = origin.materials
    const textureCount = geometry.materials.reduce((sum, material) => sum + material.textures.length, 0)
    record.losses.push(`MESH_BINARY: 几何以 LPMESH v2（原始 float32 顶点/法线/UV + ${geometry.submeshes.length} 个子网格的范围与材质下标 + ${textureCount} 张内嵌贴图）交付，Unity 侧直接建 Mesh/材质资产，不经模型导入器`)
    if (geometry.submeshes.length > 1) record.losses.push(`SUBMESHES_DELIVERED: ${geometry.submeshes.length} 个子网格按材质下标分别挂材质（不是所有面默认第一个材质）`)
    if (!uvs) record.losses.push("UV_MISSING: 该网格的 GLB 没有与顶点数一致的 TEXCOORD_0，LPMESH 不带 UV")
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 文档 ↔ 产品场景的判定辅助
// ────────────────────────────────────────────────────────────────────────────

// ── 场景级环境：产品 `components.environment`（45_environment_lighting 候选合同）↔ Unity 环境记录 ──
//
// 只换两边都有对应物的字段（强度 / 背景 / 太阳 / 阴影），Unity 侧没有概念的（烘焙 GI、雾、反射探针、
// 天空盒 shader、曝光、昼夜播放）逐条记损失；产品的昼夜/曝光在回读时**沿用产品现值**（Unity 没有读数，
// 拿默认值覆盖等于悄悄改用户设置）。这一段是唯一需要与 45 合并时对接的地方：45 合并后应改用
// `packages/viewer` 的 `SceneEnvironment`/`parseEnvironmentComponent`，这里只保留映射。

/** 环境组件在实体上的键与判别值（与 45 的 `ENVIRONMENT_COMPONENT_KEY`/`ENVIRONMENT_KIND` 逐字一致）。 */
export const ENVIRONMENT_COMPONENT_KEY = "environment"
export const ENVIRONMENT_KIND = "scene/environment"
/** 承载 Unity 环境读数的产品实体 id（固定值：重复读入是更新同一条，不会长出第二份环境）。 */
export const UNITY_ENVIRONMENT_ENTITY_ID = "entity_unity_environment"

/** 45 合同里本模块真正用到的那几个字段（其余字段原样保留在组件里，不认识的字段不动）。 */
export interface ProductSceneEnvironment {
  kind: typeof ENVIRONMENT_KIND
  environmentIntensity: number
  hemisphereIntensity: number
  exposure: number
  background: "environment" | "color"
  backgroundColor?: string
  shadows: boolean
  sun: { azimuthDeg: number; elevationDeg: number; intensity: number }
  dayNight: { enabled: boolean; timeHours: number; cycleSeconds: number }
  hdri?: { resourceId: string; version: number }
}

/** 45 的默认值（`SCENE_ENVIRONMENT_DEFAULTS`）：产品侧没有环境组件时用它补齐读数字段。 */
export const PRODUCT_ENVIRONMENT_DEFAULTS = {
  environmentIntensity: 0.7, hemisphereIntensity: 2.4, exposure: 1,
  background: "color" as const, shadows: false,
  sun: { azimuthDeg: 90, elevationDeg: 45, intensity: 3 },
  dayNight: { enabled: false, timeHours: 12, cycleSeconds: 60 },
}

/** 场景里第一条合法的 `components.environment`（与 45 的 `scanSceneEnvironment` 同一取舍：取第一条）。 */
export function firstEnvironmentOf(snapshot: SceneSnapshot): { entityId: string; component: Record<string, unknown> } | undefined {
  for (const entity of snapshot.entities) {
    const record = entity.components?.[ENVIRONMENT_COMPONENT_KEY]
    if (!record || typeof record !== "object" || Array.isArray(record)) continue
    if ((record as Record<string, unknown>).kind !== ENVIRONMENT_KIND) continue
    return { entityId: entity.entityId, component: record as Record<string, unknown> }
  }
  return undefined
}

const finiteNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** 产品环境组件 → Unity 环境记录（文档里给 Unity 侧的那一份；未支持的逐条记损失）。 */
export function unityEnvironmentFromSnapshot(snapshot: SceneSnapshot): { environment: UnityEnvironmentRecord | null; losses: string[] } {
  const found = firstEnvironmentOf(snapshot)
  // 产品场景里没有环境组件：Unity 侧沿用自身 RenderSettings。这是"没有可交换的东西"，不是覆盖，
  // 但回执里要看得见（否则用户会以为环境被同步过了）。
  if (!found) return { environment: null, losses: ["ENVIRONMENT_ABSENT_IN_PRODUCT: 产品场景没有 components.environment，写回时 Unity 侧沿用自身 RenderSettings（本次不交换环境）"] }
  const component = found.component as Record<string, unknown>
  const sun = (component.sun && typeof component.sun === "object" ? component.sun : {}) as Record<string, unknown>
  const dayNight = (component.dayNight && typeof component.dayNight === "object" ? component.dayNight : {}) as Record<string, unknown>
  const losses: string[] = []
  const environment: UnityEnvironmentRecord = {
    present: true,
    environmentIntensity: finiteNumber(component.environmentIntensity, PRODUCT_ENVIRONMENT_DEFAULTS.environmentIntensity, 0, 8),
    hemisphereIntensity: finiteNumber(component.hemisphereIntensity, PRODUCT_ENVIRONMENT_DEFAULTS.hemisphereIntensity, 0, 8),
    ambientMode: "",
    background: component.background === "environment" ? "environment" : "color",
    backgroundColor: typeof component.backgroundColor === "string" ? component.backgroundColor : "",
    shadows: component.shadows === true,
    sunAzimuthDeg: finiteNumber(sun.azimuthDeg, PRODUCT_ENVIRONMENT_DEFAULTS.sun.azimuthDeg, -3600, 3600),
    // 太阳方向写进 Unity 的是"最亮方向光"的朝向：文档给的是世界方向（光从太阳射向场景）。
    sunElevationDeg: finiteNumber(sun.elevationDeg, PRODUCT_ENVIRONMENT_DEFAULTS.sun.elevationDeg, -90, 90),
    sunIntensity: finiteNumber(sun.intensity, PRODUCT_ENVIRONMENT_DEFAULTS.sun.intensity, 0, 100),
    // 产品不知道 Unity 那盏灯叫什么：Unity 侧按"最亮的方向光"认领，回执里写明给了哪一盏。
    sunName: "",
    // Unity 没有昼夜概念：这两个字段是给回读侧一个"Unity 没意见"的显式标记。
    dayNightEnabled: dayNight.enabled === true,
    dayNightHours: finiteNumber(dayNight.timeHours, PRODUCT_ENVIRONMENT_DEFAULTS.dayNight.timeHours, 0, 24),
    dayNightCycleSeconds: finiteNumber(dayNight.cycleSeconds, PRODUCT_ENVIRONMENT_DEFAULTS.dayNight.cycleSeconds, 5, 86400),
    skyboxPath: "", skyboxShader: "", hdriFile: "", hdriAssetPath: "", hdriBytes: 0,
    losses: [],
  }
  losses.push(`ENVIRONMENT_FROM_PRODUCT: 环境读数来自实体 ${found.entityId} 的 components.environment（45 合同）`)
  const exposure = component.exposure
  if (typeof exposure === "number" && exposure !== 1) losses.push(`ENVIRONMENT_EXPOSURE_NOT_TRANSFERRED: 产品 exposure=${exposure} 不写进 Unity（色调映射曝光在渲染管线/后处理里，RenderSettings 没有这个读数）`)
  if (component.hdri && typeof component.hdri === "object") {
    const hdri = component.hdri as Record<string, unknown>
    losses.push(`ENVIRONMENT_HDRI_NOT_APPLIED: 产品侧 HDRI ${String(hdri.resourceId)}@${String(hdri.version)} 不写进 Unity 的天空盒（要建天空盒材质与导入设置，本次只交换强度/背景/太阳/阴影）`)
  }
  if (dayNight.enabled === true) losses.push("ENVIRONMENT_DAYNIGHT_VIEWER_ONLY: 昼夜播放只在产品 Viewer 的渲染时钟里，Unity 侧不跟着动（静态 timeHours 照交换）")
  environment.losses = losses
  return { environment, losses }
}

/**
 * Unity 环境记录 → 产品环境组件（只写两边都表达得了的字段）。
 * `previous` 是产品里**已有**的环境组件（上一次读入 / 用户改过的）：Unity 侧没有读数的字段
 * （曝光、昼夜）沿用它的值并记一行说明，不用默认值悄悄覆盖用户设置。
 */
export function productEnvironmentFromUnity(
  environment: UnityEnvironmentRecord | null | undefined,
  previous?: Record<string, unknown>,
): { component: ProductSceneEnvironment | null; losses: string[] } {
  if (!environment || environment.present !== true) return { component: null, losses: [] }
  const losses: string[] = []
  const priorSun = (previous?.sun && typeof previous.sun === "object" ? previous.sun : {}) as Record<string, unknown>
  const priorDayNight = (previous?.dayNight && typeof previous.dayNight === "object" ? previous.dayNight : {}) as Record<string, unknown>
  const exposure = finiteNumber(previous?.exposure, PRODUCT_ENVIRONMENT_DEFAULTS.exposure, 0, 8)
  if (previous === undefined) losses.push("ENVIRONMENT_EXPOSURE_DEFAULTED: Unity 侧没有曝光读数，产品侧取默认 1（色调映射曝光只属于产品渲染器）")
  else losses.push(`ENVIRONMENT_FIELD_PRESERVED: exposure=${exposure} 沿用产品现值（Unity 侧没有这个读数）`)
  const dayNight = previous === undefined || previous.dayNight === undefined
    ? { ...PRODUCT_ENVIRONMENT_DEFAULTS.dayNight }
    : {
        enabled: priorDayNight.enabled === true,
        timeHours: finiteNumber(priorDayNight.timeHours, PRODUCT_ENVIRONMENT_DEFAULTS.dayNight.timeHours, 0, 24),
        cycleSeconds: finiteNumber(priorDayNight.cycleSeconds, PRODUCT_ENVIRONMENT_DEFAULTS.dayNight.cycleSeconds, 5, 86400),
      }
  if (previous?.dayNight !== undefined) losses.push("ENVIRONMENT_FIELD_PRESERVED: dayNight 沿用产品现值（Unity 侧没有昼夜概念）")
  for (const loss of environment.losses ?? []) losses.push(`UNITY_${loss}`)
  const backgroundColor = /^#[0-9a-fA-F]{6}$/.test(environment.backgroundColor ?? "") ? environment.backgroundColor!.toLowerCase() : undefined
  if (environment.background === "color" && backgroundColor === undefined)
    losses.push("ENVIRONMENT_BACKGROUND_COLOR_ABSENT: Unity 文档说背景是纯色但没给合法 #rrggbb，产品侧只写 background=color（颜色沿用查看器偏好）")
  const component: ProductSceneEnvironment = {
    kind: ENVIRONMENT_KIND,
    environmentIntensity: finiteNumber(environment.environmentIntensity, PRODUCT_ENVIRONMENT_DEFAULTS.environmentIntensity, 0, 8),
    hemisphereIntensity: finiteNumber(environment.hemisphereIntensity, PRODUCT_ENVIRONMENT_DEFAULTS.hemisphereIntensity, 0, 8),
    exposure,
    background: environment.background === "environment" ? "environment" : "color",
    ...(backgroundColor ? { backgroundColor } : {}),
    shadows: environment.shadows === true,
    sun: {
      azimuthDeg: finiteNumber(environment.sunAzimuthDeg, PRODUCT_ENVIRONMENT_DEFAULTS.sun.azimuthDeg, -3600, 3600),
      elevationDeg: finiteNumber(environment.sunElevationDeg, PRODUCT_ENVIRONMENT_DEFAULTS.sun.elevationDeg, -90, 90),
      intensity: finiteNumber(environment.sunIntensity, PRODUCT_ENVIRONMENT_DEFAULTS.sun.intensity, 0, 100),
    },
    dayNight,
  }
  if (priorSun.azimuthDeg !== undefined) losses.push("ENVIRONMENT_SUN_FROM_UNITY: 太阳方位/仰角以 Unity 侧方向光为准（产品里改过的值会被 Unity 的覆盖）")
  return { component, losses }
}

/** 文档节点的局部变换（Unity 空间）→ 产品 Transform。零缩放在产品里非法，钳到极小值并写损失。 */
export function localTransformOf(node: UnityNode, losses: string[] = [], name = ""): Transform {
  const scale = [node.scale?.[0], node.scale?.[1], node.scale?.[2]]
  const degenerate = scale.some(value => typeof value !== "number" || !Number.isFinite(value) || value === 0)
  if (degenerate) losses.push(`ZERO_SCALE_CLAMPED: ${name} 的缩放 ${JSON.stringify(scale)} 含 0/非法值（产品禁止），钳为 1e-6（两侧都看不见）`)
  return {
    position: [node.position?.[0] ?? 0, node.position?.[1] ?? 0, node.position?.[2] ?? 0],
    quaternion: [node.rotation?.[0] ?? 0, node.rotation?.[1] ?? 0, node.rotation?.[2] ?? 0, node.rotation?.[3] ?? 1],
    scale: degenerate ? [1e-6, 1e-6, 1e-6] : [scale[0]!, scale[1]!, scale[2]!],
  }
}

/** 文档节点的 Unity 世界前向（父链折出）；灯的出射方向就是它。 */
function unityWorldForward(node: UnityNode, byIndex: Map<number, UnityNode>): Vec3 {
  const matrix = localMatrix(localTransformOf(node))
  let parent = node.parentIndex >= 0 ? byIndex.get(node.parentIndex) : undefined
  while (parent) {
    matrix.premultiply(localMatrix(localTransformOf(parent)))
    parent = parent.parentIndex >= 0 ? byIndex.get(parent.parentIndex) : undefined
  }
  const forward = new Vector3(0, 0, 1).applyMatrix4(new Matrix4().extractRotation(matrix)).normalize()
  return [forward.x, forward.y, forward.z]
}

/** 层级序：父在子前（提交时父引用必须已存在）。 */
function orderByHierarchy(snapshot: SceneSnapshot): Entity[] {
  const children = new Map<string, Entity[]>()
  const roots: Entity[] = []
  for (const entity of snapshot.entities) {
    if (entity.parentId) children.set(entity.parentId, [...(children.get(entity.parentId) ?? []), entity])
    else roots.push(entity)
  }
  const ordered: Entity[] = []
  const walk = (entity: Entity) => { ordered.push(entity); for (const child of children.get(entity.entityId) ?? []) walk(child) }
  for (const root of roots) walk(root)
  if (ordered.length !== snapshot.entities.length) throw new Error("HIERARCHY_INVALID: 有实体落在环里或父节点缺失")
  return ordered
}

/** 产品场景里的植被实例实体：`components.unity.terrainTree` 是唯一真值（`<地形>:tree:<i>` 的 id 只是生成的默认形态）。 */
function vegetationOf(snapshot: SceneSnapshot): Map<string, { entity: Entity; meta: NonNullable<UnityOriginMetadata["terrainTree"]> }> {
  const result = new Map<string, { entity: Entity; meta: NonNullable<UnityOriginMetadata["terrainTree"]> }>()
  for (const entity of snapshot.entities) {
    const meta = (entity.components.unity as UnityOriginMetadata | undefined)?.terrainTree
    if (meta) result.set(entity.entityId, { entity, meta })
  }
  return result
}

/** 交换展开出来的子节点（`<root>:source` / `<root>:node:i` / `<root>:tree:i`）属于哪个根；不是这类 id 就返回 undefined。 */
function exchangeExpandedRoot(entityId: string): string | undefined {
  return /^(.*):(?:source|node:\d+|tree:\d+)$/.exec(entityId)?.[1]
}

/** 某个实体子树里的几何节点（visual.kind === "mesh" 且有 gltfNode 指向真实网格）。 */
function geometryEntities(snapshot: SceneSnapshot, root: Entity): Entity[] {
  const children = new Map<string, Entity[]>()
  for (const entity of snapshot.entities) if (entity.parentId) children.set(entity.parentId, [...(children.get(entity.parentId) ?? []), entity])
  const result: Entity[] = []
  const walk = (entity: Entity) => {
    // 植被实例的几何**不属于**地形的网格（一份共享 GLB 被 N 棵树用）：不进这个子树的几何搜索，
    // 否则地形的"几何节点"里会混进树，"资源含 N 个几何节点"的损失与网格写回都会被带偏。
    if ((entity.components.unity as UnityOriginMetadata | undefined)?.terrainTree) return
    const visual = entity.components.visual as Visual | undefined
    if (visual?.kind === "mesh" && typeof visual.gltfNode === "number") result.push(entity)
    for (const child of children.get(entity.entityId) ?? []) walk(child)
  }
  // 含 root 自己：产品里直接导入的 GLB（没有 Unity 来源元数据）里，网格节点本身就是文档节点，
  // 只找子节点会让这类资源的几何一条都传不过去。
  walk(root)
  return result
}

/**
 * 哪些实体不写成 Unity 对象（它们的贡献折进子节点的世界矩阵）：
 *   - 资源坐标适配层（名字是交换器写的"源坐标转换"，且确实是资源根的子节点）；
 *   - 资源组根（visual.kind === "group"，几何在子节点上）；
 *   - 纯结构节点（没有 visual/resources/light/unity 元数据）。
 * Unity 来源的对象例外：它落在组根上，它的几何节点折进它自己（GLB 是交换专用的）。
 */
function suppressedEntityIds(snapshot: SceneSnapshot): Set<string> {
  const byId = new Map(snapshot.entities.map(entity => [entity.entityId, entity]))
  const suppressed = new Set<string>()
  for (const entity of snapshot.entities) {
    const visual = entity.components.visual as Visual | undefined
    if (entity.components.unity) {
      // 几何子节点折进 Unity 来源对象本身；对象自己就是网格节点时不能把自己也折掉。
      for (const geometry of geometryEntities(snapshot, entity)) if (geometry.entityId !== entity.entityId) suppressed.add(geometry.entityId)
      continue
    }
    if (entity.entityId.endsWith(":source") && entity.parentId !== undefined && byId.has(entity.parentId)) { suppressed.add(entity.entityId); continue }
    if (visual?.kind === "group" || visual?.kind === "source") { suppressed.add(entity.entityId); continue }
    if (!visual && !entity.components.light && entity.resources.length === 0) suppressed.add(entity.entityId)
  }
  return suppressed
}

/** 最近的一个"已经变成 Unity 对象"的祖先（层级序保证祖先先被处理）。 */
function nearestMappedAncestor(snapshot: SceneSnapshot, entity: Entity, mapped: Map<string, number>): string | undefined {
  const byId = new Map(snapshot.entities.map(item => [item.entityId, item]))
  let current = entity.parentId
  while (current) {
    if (mapped.has(current)) return current
    current = byId.get(current)?.parentId
  }
  return undefined
}

/**
 * 实体在产品空间的世界矩阵 → Unity 空间的世界矩阵（共轭 M⁻¹·W·M）。
 * 必须用矩阵而不是"先分解成 TRS 再重装"：父链上只要有非均匀缩放，世界矩阵就带切变，
 * 分解会把它丢掉，子节点的局部变换随之偏掉（往返验证里实测到 11% 缩放、3° 旋转的误差）。
 */
function unityWorldMatrix(snapshot: SceneSnapshot, entityId: string): Matrix4 {
  return AXIS_SWAP.clone().invert().multiply(worldMatrix(snapshot, entityId)).multiply(AXIS_SWAP)
}
function decomposeMatrix(matrix: Matrix4): Transform {
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  return { position: position.toArray() as Vec3, quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w], scale: scale.toArray() as Vec3 }
}
/** 子节点在 Unity 侧的局部变换：在 Unity 空间里对父的**世界矩阵**求逆（不经过分解）。 */
function unityLocalTransform(unityWorld: Matrix4, parentUnityWorld: Matrix4): Transform {
  return decomposeMatrix(parentUnityWorld.clone().invert().multiply(unityWorld))
}

/**
 * 实体在产品空间里指向"Unity 灯的出射轴"的方向：Unity 光沿对象局部 **+Z** 出射，
 * 轴交换把 Unity 的 +Z 映成产品的 **+Y**（同理产品的 +Z 是 Unity 的 +Y），所以基准向量是 (0,1,0)，
 * 不是 (0,0,1)。Unity → 产品时写入的 `light.direction` 就是它（= M·Unity世界前向），
 * 产品 → Unity 时也用同一个量核对"产品声明的方向与实体朝向是否一致"。
 */
export function productLightForward(snapshot: SceneSnapshot, entityId: string): Vec3 {
  const forward = new Vector3(0, 1, 0).applyMatrix4(new Matrix4().extractRotation(worldMatrix(snapshot, entityId))).normalize()
  return [forward.x, forward.y, forward.z]
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 网格读取/写出
// ────────────────────────────────────────────────────────────────────────────

/** glTF 材质上的贴图：字节真的从 GLB 里取出来了，不是只留一个路径。 */
export interface GlbTexture { property: string; mimeType: string; wrapMode: string; contentDigest: string; bytes: Uint8Array }
/** glTF 材质里能真实落地到 Unity 的部分（颜色/金属度/粗糙度 + baseColor 贴图字节）。 */
export interface GlbMaterial { name: string; baseColor: number[]; metallic: number; roughness: number; textures: GlbTexture[] }
/** 一个 primitive → 一个子网格（Unity 的 submesh 与材质槽一一对应）。 */
export interface GlbSubmesh { indexStart: number; indexCount: number; material: number }
export interface GlbGeometry {
  positions: Float32Array; normals?: Float32Array; uvs?: Float32Array; indices: Uint32Array
  submeshes: GlbSubmesh[]; materials: GlbMaterial[]
}

/** glTF sampler 的 wrapS/T → Unity 的 wrap 名（与 C# 侧 `WrapCodeOf` 互为反函数）。 */
function wrapNameOf(code: unknown): string {
  if (code === 33071) return "Clamp"
  if (code === 33648) return "Mirror"
  return "Repeat"
}

/**
 * 读 GLB 里某个 glTF 节点的几何与该节点用到的材质：位置/法线/UV + 每 primitive 的子网格范围 + 材质
 * （含 baseColor 贴图的**真实字节**，从 GLB 的 BIN chunk 里按 bufferView 取）。读不到就明确报错。
 */
export async function readGlbGeometry(path: string, gltfNode?: number): Promise<GlbGeometry> {
  const bytes = new Uint8Array(await readFile(path))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("GLB_MAGIC_MISMATCH")
  let offset = 12, json: any, binary: Uint8Array | undefined
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk))
    else if (type === 0x004e4942) binary = chunk
    offset += 8 + length
  }
  if (!json) throw new Error("GLB_JSON_CHUNK_MISSING")
  if (binary === undefined) throw new Error("GLB_BIN_CHUNK_MISSING")
  // accessor.bufferView.byteOffset 是相对 **BIN chunk 起点**的，不是相对文件起点：
  // 拿整文件建 DataView 会把 glTF 头当顶点读（真实踩过），所以这里只对 BIN chunk 建视图。
  const binaryView = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const nodes: any[] = json.nodes ?? []
  const node = typeof gltfNode === "number" ? nodes[gltfNode] : nodes.find(item => item.mesh !== undefined)
  if (!node) throw new Error(`GLTF_NODE_MISSING: ${String(gltfNode)}`)
  if (node.matrix) throw new Error("GLTF_NODE_MATRIX_UNSUPPORTED: 节点变换必须是 TRS")
  if (node.mesh === undefined) throw new Error(`GLTF_NODE_WITHOUT_MESH: ${String(gltfNode)}`)
  const primitives: any[] = json.meshes?.[node.mesh]?.primitives ?? []
  if (primitives.length === 0) throw new Error("GLTF_MESH_WITHOUT_PRIMITIVES")

  const floats = (accessorIndex: number, components: number): number[] => {
    const accessor = json.accessors?.[accessorIndex]
    if (!accessor) throw new Error(`GLTF_ACCESSOR_MISSING: ${accessorIndex}`)
    if (accessor.sparse) throw new Error("GLTF_SPARSE_ACCESSOR_UNSUPPORTED")
    if (accessor.componentType !== 5126) throw new Error(`GLTF_ACCESSOR_COMPONENT_UNSUPPORTED: ${accessor.componentType}`)
    const bufferView = json.bufferViews?.[accessor.bufferView]
    if (!bufferView) throw new Error("GLTF_BUFFER_VIEW_MISSING")
    if ((bufferView.buffer ?? 0) !== 0) throw new Error(`GLTF_BUFFER_UNSUPPORTED: 只支持 GLB 的 BIN chunk（buffer 0），收到 buffer ${bufferView.buffer}`)
    const stride = bufferView.byteStride ?? components * 4
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const values: number[] = []
    for (let item = 0; item < accessor.count; item++) for (let component = 0; component < components; component++) values.push(binaryView.getFloat32(base + item * stride + component * 4, true))
    return values
  }
  const indexValues = (accessorIndex: number | undefined, count: number): number[] => {
    if (accessorIndex === undefined) return Array.from({ length: count }, (_, item) => item)
    const accessor = json.accessors?.[accessorIndex]
    if (!accessor) throw new Error(`GLTF_INDEX_ACCESSOR_MISSING: ${accessorIndex}`)
    if (accessor.sparse) throw new Error("GLTF_SPARSE_ACCESSOR_UNSUPPORTED")
    const bufferView = json.bufferViews?.[accessor.bufferView]
    if (!bufferView) throw new Error("GLTF_BUFFER_VIEW_MISSING")
    if ((bufferView.buffer ?? 0) !== 0) throw new Error(`GLTF_BUFFER_UNSUPPORTED: 只支持 GLB 的 BIN chunk（buffer 0），收到 buffer ${bufferView.buffer}`)
    const sizes: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4 }
    const size = sizes[accessor.componentType]
    if (!size) throw new Error(`GLTF_INDEX_COMPONENT_UNSUPPORTED: ${accessor.componentType}`)
    const stride = bufferView.byteStride ?? size
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const values: number[] = []
    for (let item = 0; item < accessor.count; item++) {
      const at = base + item * stride
      values.push(size === 1 ? binaryView.getUint8(at) : size === 2 ? binaryView.getUint16(at, true) : binaryView.getUint32(at, true))
    }
    return values
  }
  /** 贴图字节：只支持 GLB 内嵌（bufferView），外部 uri 需要外部文件，本函数不猜路径。 */
  const imageBytes = (imageIndex: number): { bytes: Uint8Array; mimeType: string } | undefined => {
    const image = json.images?.[imageIndex]
    if (!image || image.bufferView === undefined) return undefined
    const bufferView = json.bufferViews?.[image.bufferView]
    if (!bufferView) return undefined
    const base = bufferView.byteOffset ?? 0
    return { bytes: binary.subarray(base, base + bufferView.byteLength), mimeType: String(image.mimeType ?? "image/png") }
  }

  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
  const submeshes: GlbSubmesh[] = []
  const materials: GlbMaterial[] = []
  const materialIndexOf = new Map<number, number>()
  const attributeBase = new Map<string, number>()
  let defaultMaterial = -1
  let hasNormals = true, hasUvs = true
  for (const primitive of primitives) {
    if ((primitive.mode ?? 4) !== 4) throw new Error(`GLTF_PRIMITIVE_MODE_UNSUPPORTED: ${primitive.mode}`)
    if (primitive.attributes?.POSITION === undefined) throw new Error("GLTF_POSITION_MISSING")
    const gltfMaterial = typeof primitive.material === "number" ? primitive.material : -1
    let materialSlot = materialIndexOf.get(gltfMaterial)
    if (materialSlot === undefined) {
      if (gltfMaterial < 0 && defaultMaterial >= 0) materialSlot = defaultMaterial
      else {
        materialSlot = materials.length
        materials.push(glbMaterialOf(json, gltfMaterial < 0 ? undefined : gltfMaterial, imageBytes))
        if (gltfMaterial < 0) defaultMaterial = materialSlot
      }
      materialIndexOf.set(gltfMaterial, materialSlot)
    }
    // 多个 primitive 共享同一组属性访问器时（Unity 侧写出的 GLB 就是一个 POSITION 供所有子网格用），
    // **不能按 primitive 复制顶点**：复制会让顶点数翻倍、子网格索引整体错位（真实踩过：8 顶点的板子读成 16 顶点）。
    // 按"属性访问器三元组"去重，共享的 primitive 直接复用同一段顶点区间。
    const attributeKey = `${primitive.attributes.POSITION}/${primitive.attributes.NORMAL ?? "-"}/${primitive.attributes.TEXCOORD_0 ?? "-"}`
    let base = attributeBase.get(attributeKey)
    if (base === undefined) {
      base = positions.length / 3
      attributeBase.set(attributeKey, base)
      positions.push(...floats(primitive.attributes.POSITION, 3))
      if (hasNormals && primitive.attributes.NORMAL !== undefined) normals.push(...floats(primitive.attributes.NORMAL, 3))
      else hasNormals = false
      if (hasUvs && primitive.attributes.TEXCOORD_0 !== undefined) uvs.push(...floats(primitive.attributes.TEXCOORD_0, 2))
      else hasUvs = false
    }
    const submeshIndices = indexValues(primitive.indices, positions.length / 3 - base)
    const indexStart = indices.length
    for (const value of submeshIndices) indices.push(value + base)
    submeshes.push({ indexStart, indexCount: submeshIndices.length, material: materialSlot })
  }
  // 法线/UV 要么全省略、要么与顶点一一对应；数量不符按省略处理，不写半截数据。
  const normalArray = hasNormals && normals.length === positions.length ? new Float32Array(normals) : undefined
  const uvArray = hasUvs && uvs.length === (positions.length / 3) * 2 ? new Float32Array(uvs) : undefined
  return {
    positions: new Float32Array(positions), ...(normalArray ? { normals: normalArray } : {}), ...(uvArray ? { uvs: uvArray } : {}),
    indices: new Uint32Array(indices), submeshes, materials,
  }
}

/** glTF 材质的可落地子集（缺省按 glTF 规范：白色、metallic 1、roughness 1）+ baseColor 贴图字节。 */
function glbMaterialOf(json: any, index: number | undefined, imageBytes: (imageIndex: number) => { bytes: Uint8Array; mimeType: string } | undefined): GlbMaterial {
  const material = typeof index === "number" ? json.materials?.[index] : undefined
  const pbr = material?.pbrMetallicRoughness ?? {}
  const baseColor = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length >= 3 ? pbr.baseColorFactor.slice(0, 4) : [1, 1, 1, 1]
  const textures: GlbTexture[] = []
  const baseColorTexture = pbr.baseColorTexture
  if (baseColorTexture && typeof baseColorTexture.index === "number") {
    const texture = json.textures?.[baseColorTexture.index]
    const image = texture && typeof texture.source === "number" ? imageBytes(texture.source) : undefined
    if (image) {
      const sampler = typeof texture.sampler === "number" ? json.samplers?.[texture.sampler] : undefined
      textures.push({
        property: "_MainTex", mimeType: image.mimeType, wrapMode: wrapNameOf(sampler?.wrapS),
        contentDigest: byteDigest(image.bytes), bytes: image.bytes,
      })
    }
  }
  return {
    name: material?.name ?? "glTF 默认材质",
    baseColor: [baseColor[0] ?? 1, baseColor[1] ?? 1, baseColor[2] ?? 1, baseColor[3] ?? 1],
    metallic: typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1,
    roughness: typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1,
    textures,
  }
}

// ── 内容摘要：与 Unity 侧 LyapunovSceneExchange.cs 的 DigestOf/ByteDigest 同一算法（FNV-1a 64，
//    按 8 字节小端逐字节喂），所以两边算出来的摘要能直接比。数值按 1e-6 量化。 ──────────────

/** C# `DigestOf(IEnumerable<long>)` 的同一份实现。 */
export function digestOfValues(values: ArrayLike<number>): string {
  let hash = 14695981039346656037n
  const prime = 1099511628211n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < values.length; index++) {
    const bits = BigInt.asUintN(64, BigInt(Math.trunc(values[index]!)))
    for (let shift = 0n; shift < 64n; shift += 8n) {
      hash = (hash ^ ((bits >> shift) & 0xffn)) & mask
      hash = (hash * prime) & mask
    }
  }
  return hash.toString(16).padStart(16, "0")
}

/** 贴图字节摘要：长度 + 每 97 字节一个样本（与 C# `ByteDigest` 同一算法）。 */
export function byteDigest(bytes: Uint8Array): string {
  const values: number[] = [bytes.length]
  for (let index = 0; index < bytes.length; index += 97) values.push(bytes[index]!)
  return digestOfValues(values)
}

// ── LPMESH v2：产品 → Unity 的网格载荷 ────────────────────────────────────────
//
// 为什么要有 v2：v1 只有位置/法线/索引，Unity 侧只能建一个子网格、挂第一个材质、没有 UV ——
// 带 checker 贴图的模型往返一次就丢映射。v2 补上 UV（Unity 约定）、每子网格的索引范围与材质下标、
// 以及材质表 + 内嵌贴图字节（跨工程也能真的把贴图落进目标工程）。
//
// 布局（与 C# `ReadLpmesh` 逐字节一致）：
//   magic "LPMESH02"(8) + flags(4) + vertexCount(4) + indexCount(4) + subMeshCount(4) + materialCount(4)
//   float32 位置[3n] + 可选法线[3n] + 可选 UV[2n]（uvSpace 决定是否按 1-v 转成 Unity 约定）
//   uint32 索引[indexCount]
//   uint32 子网格起始[subMeshCount]（索引个数）+ uint32 子网格长度[subMeshCount]
//   uint32 材质表 JSON 字节数 + 材质表 JSON + 贴图字节块
// flags：bit0=法线 bit1=UV bit2=子网格+材质表。

export interface LpmeshTextureInput { property: string; mimeType: string; wrapMode: string; contentDigest: string; bytes: Uint8Array }
export interface LpmeshMaterialInput {
  name: string; baseColor: number[]; metallic: number; smoothness: number; textures: LpmeshTextureInput[]
}
export interface LpmeshInput {
  positions: Float32Array; normals?: Float32Array; uvs?: Float32Array; indices: Uint32Array
  submeshes: GlbSubmesh[]; materials: LpmeshMaterialInput[]
}
export interface LpmeshOptions {
  /**
   * `uvs` 所在的空间：`gltf`（默认）= glTF/Viewer 约定（左上原点），写文件时按 1-v 转成 Unity 约定；
   * `unity` = 已经是 Unity 约定（左下原点），原样写。
   */
  uvSpace?: "gltf" | "unity"
  /** 材质表里的贴图字节是否内嵌（默认内嵌；false 时只留摘要与元数据）。 */
  embedTextures?: boolean
}

export function encodeLpmesh(input: LpmeshInput, options: LpmeshOptions = {}): Uint8Array {
  const { positions, indices } = input
  const hasNormals = input.normals !== undefined && input.normals.length === positions.length
  const hasUvs = input.uvs !== undefined && input.uvs.length === (positions.length / 3) * 2
  const submeshes = input.submeshes.length > 0 ? input.submeshes : [{ indexStart: 0, indexCount: indices.length, material: 0 }]
  let covered = 0
  for (const submesh of submeshes) {
    if (submesh.indexStart !== covered) throw new Error(`LPMESH_SUBMESH_GAP: 子网格必须首尾相接（期望 ${covered}，收到 ${submesh.indexStart}）`)
    covered += submesh.indexCount
  }
  if (covered !== indices.length) throw new Error(`LPMESH_SUBMESH_COVERAGE_MISMATCH: ${covered} ≠ ${indices.length}`)
  if (submeshes.length > 1 && input.materials.length === 0) throw new Error("LPMESH_MATERIALS_MISSING: 多子网格必须带材质表")

  const embed = options.embedTextures !== false
  const chunks: Uint8Array[] = []
  let blobLength = 0
  const materials = input.materials.map(material => ({
    name: material.name, baseColor: material.baseColor.slice(0, 4), metallic: material.metallic, smoothness: material.smoothness,
    textures: material.textures.map(texture => {
      const entry = {
        property: texture.property, mimeType: texture.mimeType, wrapMode: texture.wrapMode,
        contentDigest: texture.contentDigest, byteOffset: embed ? blobLength : 0, byteLength: embed ? texture.bytes.length : 0,
      }
      if (embed) { chunks.push(texture.bytes); blobLength += texture.bytes.length }
      return entry
    }),
  }))
  const tableJson = new TextEncoder().encode(JSON.stringify({
    textureBlobLength: blobLength, submeshMaterials: submeshes.map(submesh => submesh.material), materials,
  }))

  const vertexCount = positions.length / 3
  const header = new Uint8Array(28)
  header.set(new TextEncoder().encode("LPMESH02"), 0)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(8, (hasNormals ? 1 : 0) | (hasUvs ? 2 : 0) | 4, true)
  headerView.setUint32(12, vertexCount, true)
  headerView.setUint32(16, indices.length, true)
  headerView.setUint32(20, submeshes.length, true)
  headerView.setUint32(24, materials.length, true)

  const sized = 28 + positions.byteLength + (hasNormals ? input.normals!.byteLength : 0) + (hasUvs ? (vertexCount * 2 * 4) : 0)
    + indices.byteLength + submeshes.length * 8 + 4 + tableJson.byteLength + blobLength
  const body = new Uint8Array(sized)
  body.set(header, 0)
  let offset = 28
  body.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), offset); offset += positions.byteLength
  if (hasNormals) { body.set(new Uint8Array(input.normals!.buffer, input.normals!.byteOffset, input.normals!.byteLength), offset); offset += input.normals!.byteLength }
  if (hasUvs) {
    // UV 是贴图坐标、不随几何镜像走：只把 v 翻过来，u 不动（往返回合到 1 ulp，摘要按 1e-6 量化）。
    const flip = (options.uvSpace ?? "gltf") === "gltf"
    const view = new DataView(body.buffer, body.byteOffset + offset, vertexCount * 8)
    for (let index = 0; index < vertexCount; index++) {
      const u = input.uvs![index * 2]!, v = input.uvs![index * 2 + 1]!
      view.setFloat32(index * 8, u, true)
      view.setFloat32(index * 8 + 4, flip ? 1 - v : v, true)
    }
    offset += vertexCount * 8
  }
  body.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset); offset += indices.byteLength
  const rangeView = new DataView(body.buffer, body.byteOffset + offset)
  for (let subMesh = 0; subMesh < submeshes.length; subMesh++) rangeView.setUint32(subMesh * 4, submeshes[subMesh]!.indexStart, true)
  for (let subMesh = 0; subMesh < submeshes.length; subMesh++) rangeView.setUint32((submeshes.length + subMesh) * 4, submeshes[subMesh]!.indexCount, true)
  offset += submeshes.length * 8
  new DataView(body.buffer, body.byteOffset + offset, 4).setUint32(0, tableJson.byteLength, true)
  offset += 4
  body.set(tableJson, offset); offset += tableJson.byteLength
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
  return body
}

// ── LPMESH 读取（产品侧自己的解码器：E2E 与测试用它核对交付字节，不依赖 Unity） ──────────

export interface DecodedLpmesh {
  vertexCount: number; indexCount: number; subMeshCount: number; materialCount: number
  positions: Float32Array; normals?: Float32Array; uvs?: Float32Array; indices: Uint32Array
  submeshes: LpmeshSubmesh[]; submeshMaterials: number[]
  materials: Array<{ name: string; baseColor: number[]; metallic: number; smoothness: number; textures: Array<{ property: string; mimeType: string; contentDigest: string; bytes: Uint8Array }> }>
}
export interface LpmeshSubmesh { indexStart: number; indexCount: number; material: number }

/** 解 LPMESH v1/v2 字节（Unity 侧读的是同一份格式；这里用于核对交付物真的带了什么）。 */
export function decodeLpmesh(bytes: Uint8Array): DecodedLpmesh {
  if (bytes.byteLength < 28) throw new Error("LPMESH_TOO_SHORT")
  const magic = new TextDecoder().decode(bytes.subarray(0, 8))
  if (magic !== "LPMESH01" && magic !== "LPMESH02") throw new Error(`LPMESH_MAGIC_MISMATCH: ${magic}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const flags = view.getUint32(8, true)
  const vertexCount = view.getUint32(12, true), indexCount = view.getUint32(16, true)
  const hasNormals = (flags & 1) !== 0, hasUvs = (flags & 2) !== 0, hasTable = (flags & 4) !== 0
  const subMeshCount = magic === "LPMESH02" ? Math.max(1, view.getUint32(20, true)) : 1
  const materialCount = magic === "LPMESH02" ? view.getUint32(24, true) : 0
  const float = (count: number) => new Float32Array(count)
  let offset = 28
  const positions = float(vertexCount * 3)
  for (let index = 0; index < positions.length; index++) positions[index] = view.getFloat32(offset + index * 4, true)
  offset += vertexCount * 12
  const normals = hasNormals ? float(vertexCount * 3) : undefined
  if (normals) { for (let index = 0; index < normals.length; index++) normals[index] = view.getFloat32(offset + index * 4, true); offset += vertexCount * 12 }
  const uvs = hasUvs ? float(vertexCount * 2) : undefined
  if (uvs) { for (let index = 0; index < uvs.length; index++) uvs[index] = view.getFloat32(offset + index * 4, true); offset += vertexCount * 8 }
  const indices = new Uint32Array(indexCount)
  for (let index = 0; index < indexCount; index++) indices[index] = view.getUint32(offset + index * 4, true)
  offset += indexCount * 4
  const submeshMaterials: number[] = []
  const submeshes: LpmeshSubmesh[] = []
  let materials: DecodedLpmesh["materials"] = []
  if (hasTable) {
    const starts: number[] = [], counts: number[] = []
    for (let subMesh = 0; subMesh < subMeshCount; subMesh++) starts.push(view.getUint32(offset + subMesh * 4, true))
    offset += subMeshCount * 4
    for (let subMesh = 0; subMesh < subMeshCount; subMesh++) counts.push(view.getUint32(offset + subMesh * 4, true))
    offset += subMeshCount * 4
    const tableLength = view.getUint32(offset, true)
    offset += 4
    const table = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + tableLength))) as {
      submeshMaterials?: number[]; materials?: Array<{ name?: string; baseColor?: number[]; metallic?: number; smoothness?: number; textures?: Array<{ property?: string; mimeType?: string; contentDigest?: string; byteOffset?: number; byteLength?: number }> }>
    }
    offset += tableLength
    for (let subMesh = 0; subMesh < subMeshCount; subMesh++) {
      submeshes.push({ indexStart: starts[subMesh]!, indexCount: counts[subMesh]!, material: table.submeshMaterials?.[subMesh] ?? 0 })
    }
    submeshMaterials.push(...(table.submeshMaterials ?? []))
    materials = (table.materials ?? []).map(material => ({
      name: material.name ?? "", baseColor: material.baseColor ?? [1, 1, 1, 1], metallic: material.metallic ?? 0, smoothness: material.smoothness ?? 0.5,
      textures: (material.textures ?? []).map(texture => ({
        property: texture.property ?? "", mimeType: texture.mimeType ?? "",
        contentDigest: texture.contentDigest ?? "",
        bytes: bytes.subarray(offset + (texture.byteOffset ?? 0), offset + (texture.byteOffset ?? 0) + (texture.byteLength ?? 0)),
      })),
    }))
  } else {
    submeshes.push({ indexStart: 0, indexCount, material: 0 })
  }
  return { vertexCount, indexCount, subMeshCount, materialCount, positions, ...(normals ? { normals } : {}), ...(uvs ? { uvs } : {}), indices, submeshes, submeshMaterials, materials }
}

// ────────────────────────────────────────────────────────────────────────────
// 7. 薄接线：只注册三个工具（本文件不自行注入插件；装配见 packages/scene-kit/src/plugin.ts）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 一次**产品工具调用**的原生执行上下文（DSH `ToolRunContext` 的最窄子集）。
 * 原生 MCP 调用要带上它的身份与取消信号：agent 决定作用域与授权，parent（token）让嵌套调用
 * 在 ptc 模式下不被当成模型直呼而拒掉，signal 让取消能传到那次 MCP 调用本身。
 */
export interface UnityToolExec {
  callId?: string
  rootCallId?: string
  /** 外层执行的 token（DSH 的 parent）。 */
  token?: unknown
  agent?: unknown
  signal?: AbortSignal
}

/** 端口里与"谁在调用"无关的落盘半边（唯一 owner 在本文件）：调用方只提供原生 MCP 口。 */
export function unityExchangePort(io: Pick<UnityExchangePort, "call" | "readResource">): UnityExchangePort {
  return {
    call: io.call,
    ...(io.readResource ? { readResource: io.readResource } : {}),
    readFile: async path => await readFile(path, "utf8"),
    writeFile: async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, "utf8") },
    // 请求文件必须原子出现（临时文件 + rename）：编辑器不能读到半份 JSON。
    writeJSONAtomic: async (path, value) => { await atomicJSON(path, value) },
    removeFile: async path => { await rm(path, { force: true }) },
    writeBinary: async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) },
  }
}

export interface UnityExchangeRegistration {
  /** 静态口（`call`：测试/脚本/一条常驻连接）的固定场景操作；产品路径改用 `sceneFor` 按会话现取。 */
  scene?: SceneOperations
  /**
   * 产品 Host 接线：**按每次工具调用的会话**现取场景操作（与 `portFor` 配套）。Unity 工程是宿主级资源，
   * 但读写的是**本会话自己的产品场景**：交换不能落到某个共享 SceneStore 上。
   */
  sceneFor?: (exec?: UnityToolExec) => SceneOperations
  /** 静态原生 MCP 调用口（测试/脚本/一条常驻连接）：与 `portFor` 二选一。 */
  call?: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; text: string; json?: unknown }>
  /** 原生 MCP 资源读口（与 call 同一条连接）：发现工程根、列实例、核对目标工程；不提供时请显式给 projectPath。 */
  readResource?: (uri: string) => Promise<unknown>
  /**
   * 产品 Host 接线：**按每次工具调用**现取原生 MCP 口（把这次调用的 agent/parent/signal 带进那次调用）。
   * 每次调用现建一个交换实例——请求/回执的唯一文件名协议不依赖实例共享（见 invoke 的注释），
   * 因此不需要第二套调度器，也不会把两条并行调用的身份混在一起。
   */
  portFor?: (exec?: UnityToolExec) => Pick<UnityExchangePort, "call" | "readResource">
  projectPath?: string
  /** 显式实例（Name@hash / hash / 端口）：同一工程多实例时必填。 */
  instance?: string
  timeoutMs?: number
}

export const unityExchangeParameters: Record<"status" | "read" | "write", ParameterSchemaSpec> = {
  status: { input: { type: "object", required: true, additionalProperties: false, description: "Read-only status; no parameters.", properties: {} } },
  read: { input: { type: "object", required: true, additionalProperties: false, description: "Read the current Unity scene into the product Scene. Put parameters directly in the input object; do not JSON-encode the object as a string.", properties: {
    sceneId: { type: "string", required: true, description: "Product scene ID from scene_list or scene_create." },
    parentId: { type: "string", description: "Optional existing entity under which to mount the entire Unity scene tree." },
    includeInactive: { type: "boolean", description: "Whether to include inactive objects; default true." },
    exportMeshes: { type: "boolean", description: "Whether to write mesh bytes; default true." },
    maxNodes: { type: "integer", description: "Maximum node count; default 20000." },
  } } },
  write: { input: { type: "object", required: true, additionalProperties: false, description: "Write the product Scene to Unity. Put parameters directly in the input object; do not JSON-encode the object as a string.", properties: {
    sceneId: { type: "string", required: true, description: "Product scene ID." },
    mode: { type: "string", enum: ["current", "new", "additive"], description: "current uses the current scene (default); new/additive opens and saves another scene without changing the user's already-open scenes." },
    scenePath: { type: "string", description: "Target scene path for mode=new/additive (Assets/... .unity); open it if it already exists." },
    assetFolder: { type: "string", description: "Asset import directory; default Assets/LyapunovSceneExchange/Imported." },
    dryRun: { type: "boolean", description: "Check reachability only; do not create or modify any objects." },
  } } },
}

/**
 * 注册 `unity_scene_status` / `unity_scene_read` / `unity_scene_write`。
 * 接线见 docs/UNITY_SCENE_EXCHANGE.md §7：`call`（静态口，测试/脚本）或 `portFor`（产品 Host 按调用取口）
 * 二选一。本文件不自行注入 plugin.ts，也不新建第二条 Unity 连接——原生口由装配方给（同一上游 MCP 实例）。
 */
export function registerUnityExchangeTools(ctx: Context, options: UnityExchangeRegistration): UnitySceneExchange | undefined {
  if (!options.call === !options.portFor) throw new Error("UNITY_EXCHANGE_REGISTRATION: 必须且只能给 call（静态原生口）或 portFor（按每次工具调用取口）之一")
  const targets = { projectPath: options.projectPath, instance: options.instance, timeoutMs: options.timeoutMs }
  /**
   * 场景操作按**本次调用所在会话**取：静态口用注册时给的那一份；产品路径必须给 `sceneFor`，
   * 缺它就明确失败——不让交换工具落到某个共享 SceneStore（那就是"只藏 UI 的假隔离"）。
   */
  const sceneFor = (exec?: UnityToolExec): SceneOperations => {
    const scene = options.sceneFor ? options.sceneFor(exec) : options.scene
    if (!scene) throw new Error("UNITY_EXCHANGE_REGISTRATION: 产品接线（portFor）必须给 sceneFor —— 交换读写的是本次调用会话自己的场景")
    return scene
  }
  const port = (exec?: UnityToolExec) => options.portFor ? unityExchangePort(options.portFor(exec)) : unityExchangePort({ call: options.call!, ...(options.readResource ? { readResource: options.readResource } : {}) })
  // 返回给调用方的实例：静态口就是它（测试/脚本的读数口）；产品路径按调用各现建一个（下面 active），
  // 注册期没有会话可取场景，所以这里没有可返回的固定实例。
  const exchange = options.call ? new UnitySceneExchange(sceneFor(undefined), port(undefined), targets) : undefined
  const activeFor = (exec?: UnityToolExec): UnitySceneExchange => options.portFor ? new UnitySceneExchange(sceneFor(exec), port(exec), targets) : exchange!
  // 原生的兄弟调用**默认就是互斥的**（defineTool 不声明 isConcurrencySafe 即 exclusive，见 dsh-tools 的
  // ToolDefinition 文档），所以同一轮里的并行工具调用不会真的重叠；跨会话/跨进程则靠请求文件唯一名 +
  // 编辑器侧 rename 认领。这里不额外声明 isConcurrencySafe，也不自己造调度。
  const definitions: Array<{ name: string; description: string; parameters: ParameterSchemaSpec; run: (input: any, exec: UnityToolExec, active: UnitySceneExchange) => Promise<unknown> }> = [
    { name: "unity_scene_status", parameters: unityExchangeParameters.status, description: "Read-only: Unity editor, current scene and unsaved state, target-project binding (requested project versus editor-reported project), and unfinished requests/recent receipts in the exchange staging directory. Change nothing.", run: (_input, exec, active) => active.status(exec.signal) },
    { name: "unity_scene_read", parameters: unityExchangeParameters.read, description: "Read the current Unity scene into the product Scene with real metre and handedness conversion for positions, rotations and hierarchy. Preserve stable entityId values and narrowly update existing entities by identity: only exchange-owned fields change; user-added components and children remain. Delete corresponding objects only when the source actually deleted them. Recompute retained user children's local transforms in the committed parent frame to preserve their world pose and subtree. Meshes use the ResourceLibrary with content deduplication; material/light data is materialized. Cameras, prefabs, terrain and vegetation remain Unity-namespaced metadata, with itemized conversion losses.", run: (input, exec, active) => active.readScene(input, { ...(exec.signal ? { signal: exec.signal } : {}) }) },
    { name: "unity_scene_write", parameters: unityExchangeParameters.write, description: "Write the product Scene to Unity: deliver meshes as raw LPMESH vertices/indices for Unity to create Mesh assets; reconstruct materials, lights and cameras as native Unity components; write entityId into identity components. mode defaults to current; new/additive opens and saves another scene. Cancellation stops only local waiting; Unity may still finish an operation it has already claimed.", run: (input, exec, active) => active.writeScene(input, { ...(exec.signal ? { signal: exec.signal } : {}) }) },
  ]
  for (const definition of definitions) ctx.tools.register(defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: { schema: { type: "json" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    // exec 是原生的执行上下文：signal 一路贯通到等回执的轮询里（见 awaitResult / throwIfStopped）。
    execute: (args: any, exec: UnityToolExec) => definition.run(args?.input ?? {}, exec ?? {}, activeFor(exec)) as any,
  }))
  return exchange
}
