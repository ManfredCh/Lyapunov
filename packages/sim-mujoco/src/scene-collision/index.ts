/**
 * scene-collision — Scene 快照 → MuJoCo 分层碰撞补丁编译入口。
 *
 * 当一个同步到 MuJoCo 的 Scene 快照包含带可信 mesh 碰撞绑定
 * （components.collision = { shape:"mesh", binding: SceneGeometryBinding }，
 * alignmentStatus 为 machine-verified / user-confirmed）的 splat 实体时，
 * 本模块从该实体 ResourceRef 上 role:"collision" 的派生表示读取配套 GLB，
 * 编译出分层碰撞补丁（地面高度场 + 竖直墙体盒），作为 sync 的附加参数
 * collisionPatches 交给 python worker。
 *
 * 信任链（与 scene-kit readVerifiedResource 同一原则：校验与使用同一份字节）：
 * 严格解析 binding → sceneCollisionAlignmentGate 门禁 → 读一次 mesh 文件并
 * 对该 buffer 求 sha256，必须等于 binding.mesh.sha256 → 才允许进入几何编译。
 * 任何失败都返回 null + 告警，绝不向 sync 抛异常。
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  parseSceneGeometryBinding,
  sceneCollisionAlignmentGate,
  type Entity,
  type SceneGeometryBinding,
  type SceneSnapshot,
} from "../../../lyapunov-contracts/src/types.ts"
import {
  AlignedMeshWorldMatrixError,
  alignedSceneMeshWorldMatrix,
  entityWorldMatrix,
  splatSourceMatrix,
} from "./aligned-mesh-source.ts"
import type { SceneCollisionPart } from "./contracts.ts"
import { readGlbTriangleSoup } from "./glb-mesh.ts"
import { buildSceneLayeredCollision } from "./layered-scene-provider.ts"
import type { Mat4 } from "./mat4.ts"
import {
  AlignedSceneMeshSourceCache,
  alignedSceneMeshSourceKey,
  type AlignedSceneMeshSource,
} from "./source-cache.ts"

// ---- worker sync 附加参数合同（python worker 按此实现；勿改形状） ----

export type AxisAlignedBox = { center: [number, number, number]; halfExtents: [number, number, number] }
/** 墙体盒：缺省为轴对齐；带 quat(wxyz) 时为场景世界系中的朝向盒（旧系统 XML 路径同款能力）。 */
export type WallBox = AxisAlignedBox & { quat?: [number, number, number, number] }

export type SceneCollisionCompilation = {
  entityId?: string
  sourceKey: string
  frame: "mujoco-z-up-meters"
  suppressDefaultGround: true
  ground:
    | { kind: "hfield"; name: string; nrow: number; ncol: number; origin: [number, number, number]; size: [number, number, number, number]; elevation: number[] }
    | { kind: "boxes"; boxes: AxisAlignedBox[] }
  /** 竖直墙体盒：轴对齐或带 quat 的朝向盒（Scene 世界系）。 */
  walls: WallBox[]
  /** 补丁底面 − 2m。 */
  catchNetZ: number | null
  warnings: string[]
}

// ---- 构建告警（合并进 sync 句柄 warnings 时 code 前缀即 SCENE_COLLISION_*） ----

export interface SceneCollisionBuildWarning {
  code: string
  message: string
  entityId?: string
}

export interface SceneCollisionBuildResult {
  compilation: SceneCollisionCompilation | null
  warnings: SceneCollisionBuildWarning[]
}

/** 廉价阶段（无 IO）的产物：绑定实体、合成矩阵与 sourceKey。 */
export interface SceneCollisionPlan {
  entity: Entity
  binding: SceneGeometryBinding
  sourceToTarget: Mat4
  sourceKey: string
  /** 该绑定实体所在快照的 Scene revision（编译缓存键的一部分）。 */
  revision: number
}

const MAX_CACHED_COMPILATIONS = 8
/** 墙板件 quat 视为“轴对齐”的容差：纯 Z 旋转且 yaw 距 k·90° 不超过 1e-3 rad。 */
const AXIS_ALIGNED_YAW_EPSILON = 1e-3

function warning(code: string, message: string, entityId?: string): SceneCollisionBuildWarning {
  return entityId === undefined ? { code, message } : { code, message, entityId }
}

/** 墙体盒换算：近轴对齐（含 90° 整数倍偏航）归并为无 quat；其余朝向保留 quat(wxyz)
 *  （与旧系统 XML 发射能力一致——MuJoCo geom 原生支持朝向盒）；quat 非法才丢弃。 */
function wallBox(part: Extract<SceneCollisionPart, { representation: "voxel-box" }>): WallBox | null {
  const [w, x, y, z] = part.quat
  const norm = Math.hypot(w, x, y, z)
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-3) return null
  const halfExtents: [number, number, number] = [part.halfExtents[0], part.halfExtents[1], part.halfExtents[2]]
  if (halfExtents.some((value) => !(value > 0) || !Number.isFinite(value))) return null
  const center: [number, number, number] = [part.center[0], part.center[1], part.center[2]]
  if (Math.abs(x) <= AXIS_ALIGNED_YAW_EPSILON && Math.abs(y) <= AXIS_ALIGNED_YAW_EPSILON) {
    const yaw = 2 * Math.atan2(z, w)
    const snapped = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2)
    if (Math.abs(yaw - snapped) <= AXIS_ALIGNED_YAW_EPSILON) {
      const quarterTurns = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4
      if (quarterTurns === 1 || quarterTurns === 3) {
        // 绕盒心 Z 轴 ±90°：盒仍轴对齐，x/y 半长互换。
        halfExtents[0] = part.halfExtents[1]
        halfExtents[1] = part.halfExtents[0]
      }
      return { center, halfExtents }
    }
  }
  return { center, halfExtents, quat: [w / norm, x / norm, y / norm, z / norm] }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * 场景碰撞构建器：持有 canonical 源 LRU（AlignedSceneMeshSourceCache）与
 * 按 (sourceKey, 绑定实体 Scene revision) 键控的编译结果缓存，稳态 sync 廉价。
 */
export class SceneCollisionBuilder {
  readonly sources: AlignedSceneMeshSourceCache
  #compilations = new Map<string, SceneCollisionBuildResult>()

  constructor(options: { sources?: AlignedSceneMeshSourceCache } = {}) {
    this.sources = options.sources ?? new AlignedSceneMeshSourceCache()
  }

  /**
   * 廉价阶段：扫描可信绑定实体、跑门禁、合成目标矩阵并给出 sourceKey。
   * 不触碰文件系统；无法形成计划时 plan 为 null 并附告警。
   */
  plan(snapshot: SceneSnapshot): { plan: SceneCollisionPlan | null; warnings: SceneCollisionBuildWarning[] } {
    const warnings: SceneCollisionBuildWarning[] = []
    const candidates = snapshot.entities.filter((entity) => {
      const collision = entity.components.collision
      // 只处理声明了 binding 的 splat 网格碰撞；asset-bake 的 parts 网格碰撞走 worker 实体分支，不在此误报。
      return collision?.shape === "mesh" && (collision as Record<string, unknown>).binding !== undefined
    })
    let trusted: { entity: Entity; binding: SceneGeometryBinding } | null = null
    for (const entity of candidates) {
      const collision = entity.components.collision!
      if (collision.frame !== undefined && collision.frame !== "mujoco-z-up-meters") {
        warnings.push(
          warning("SCENE_COLLISION_FRAME_UNSUPPORTED", `实体 ${entity.entityId} 的 mesh 碰撞坐标系不受支持: ${String(collision.frame)}`, entity.entityId),
        )
        continue
      }
      const binding = parseSceneGeometryBinding(collision.binding)
      if (!binding) {
        warnings.push(warning("SCENE_COLLISION_BINDING_INVALID", `实体 ${entity.entityId} 的 mesh 碰撞绑定无法严格解析`, entity.entityId))
        continue
      }
      const gate = sceneCollisionAlignmentGate({ binding })
      if (!gate.ok) {
        warnings.push(
          warning("SCENE_COLLISION_ALIGNMENT_BLOCKED", `实体 ${entity.entityId} 未通过对齐门禁(${gate.reason}): ${gate.message}`, entity.entityId),
        )
        continue
      }
      if (trusted) {
        // 旧系统只支持一个场景背景：第一个可信实体胜出，其余仅记录。
        warnings.push(
          warning("SCENE_COLLISION_EXTRA_BINDING", `实体 ${entity.entityId} 也有可信 mesh 碰撞绑定；只编译第一个可信实体 ${trusted.entity.entityId}`, entity.entityId),
        )
        continue
      }
      trusted = { entity, binding: gate.binding }
    }
    if (!trusted) return { plan: null, warnings }

    try {
      const entityWorld = entityWorldMatrix(snapshot, trusted.entity)
      const splatSource = splatSourceMatrix(trusted.entity)
      const sourceToTarget = alignedSceneMeshWorldMatrix({ binding: trusted.binding, entityWorld, splatSource })
      const sourceKey = alignedSceneMeshSourceKey({ binding: trusted.binding, sourceToTarget })
      return { plan: { entity: trusted.entity, binding: trusted.binding, sourceToTarget, sourceKey, revision: snapshot.revision }, warnings }
    } catch (error) {
      const detail = error instanceof AlignedMeshWorldMatrixError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
      warnings.push(warning("SCENE_COLLISION_TRANSFORM_INVALID", `实体 ${trusted.entity.entityId} 的碰撞矩阵合成失败: ${detail}`, trusted.entity.entityId))
      return { plan: null, warnings }
    }
  }

  /** 完整构建：plan → （编译缓存命中？）→ 读文件验哈希 → canonical 源 → 分层编译。 */
  async build(snapshot: SceneSnapshot): Promise<SceneCollisionBuildResult> {
    const { plan, warnings } = this.plan(snapshot)
    if (!plan) return { compilation: null, warnings }
    // 内容键：编译产物只由 sourceKey（mesh 哈希 + 对齐 revision + 世界矩阵 17 位）
    // 与实体名（hfield 命名）决定；Scene revision 不参与——无关编辑不触发重编译。
    const cacheKey = `${plan.sourceKey}#${plan.entity.entityId}#${plan.entity.name}`
    const cached = this.#compilations.get(cacheKey)
    if (cached) {
      this.#compilations.delete(cacheKey)
      this.#compilations.set(cacheKey, cached)
      return { compilation: cached.compilation, warnings: [...warnings, ...cached.warnings] }
    }
    const built = await this.#buildUncached(plan)
    const result: SceneCollisionBuildResult = { compilation: built.compilation, warnings: built.warnings }
    this.#compilations.set(cacheKey, result)
    while (this.#compilations.size > MAX_CACHED_COMPILATIONS) {
      const oldest = this.#compilations.keys().next().value!
      this.#compilations.delete(oldest)
    }
    return { compilation: built.compilation, warnings: [...warnings, ...built.warnings] }
  }

  /** 显式失效：对齐 revision 变化时同时清掉 canonical 源与编译结果。 */
  invalidateRevision(alignmentRevision: string): void {
    this.sources.invalidateRevision(alignmentRevision)
    this.#compilations.clear()
  }

  clear(): void {
    this.sources.clear()
    this.#compilations.clear()
  }

  async #buildUncached(plan: SceneCollisionPlan): Promise<SceneCollisionBuildResult> {
    const warnings: SceneCollisionBuildWarning[] = []
    const entityId = plan.entity.entityId

    const representation = plan.entity.resources
      .flatMap((resource) => resource.representations)
      .find((item) => item.role === "collision")
    if (!representation) {
      warnings.push(warning("SCENE_COLLISION_MESH_REPRESENTATION_MISSING", `实体 ${entityId} 没有 role:"collision" 的 mesh 派生表示`, entityId))
      return { compilation: null, warnings }
    }
    if (!representation.uri.startsWith("file://")) {
      warnings.push(warning("SCENE_COLLISION_MESH_URI_UNSUPPORTED", `实体 ${entityId} 的碰撞 mesh URI 不是 file:// : ${representation.uri}`, entityId))
      return { compilation: null, warnings }
    }

    let bytes: Uint8Array
    let path: string
    try {
      path = fileURLToPath(representation.uri)
      bytes = await readFile(path)
    } catch (error) {
      warnings.push(
        warning("SCENE_COLLISION_MESH_READ_FAILED", `实体 ${entityId} 的碰撞 mesh 读取失败: ${error instanceof Error ? error.message : String(error)}`, entityId),
      )
      return { compilation: null, warnings }
    }
    // 校验与使用同一份字节（readVerifiedResource 原则）：哈希必须等于绑定记录。
    const actualSha256 = sha256Hex(bytes)
    if (actualSha256 !== plan.binding.mesh.sha256) {
      warnings.push(
        warning(
          "SCENE_COLLISION_MESH_HASH_MISMATCH",
          `实体 ${entityId} 的碰撞 mesh sha256 与绑定记录不符(实际 ${actualSha256}, 记录 ${plan.binding.mesh.sha256})`,
          entityId,
        ),
      )
      return { compilation: null, warnings }
    }

    let source: AlignedSceneMeshSource
    const cachedSource = this.sources.get(plan.sourceKey)
    if (cachedSource) {
      source = cachedSource
    } else {
      try {
        const soup = readGlbTriangleSoup(bytes)
        source = this.sources.build({
          sourceKey: plan.sourceKey,
          binding: plan.binding,
          source: soup,
          sourceToTarget: plan.sourceToTarget,
        })
      } catch (error) {
        warnings.push(
          warning("SCENE_COLLISION_MESH_PARSE_FAILED", `实体 ${entityId} 的碰撞 mesh 解析失败: ${error instanceof Error ? error.message : String(error)}`, entityId),
        )
        return { compilation: null, warnings }
      }
    }

    const layered = buildSceneLayeredCollision({
      index: source.spatialIndex,
      name: plan.entity.name || entityId,
      sourceMeshHash: plan.binding.mesh.sha256,
      alignmentRevision: plan.binding.revision,
      groundSampleStepM: 0.05,
      maxRows: 224,
      maxCols: 224,
      maxVerticalBoxes: 24,
    })
    if (!layered) {
      warnings.push(warning("SCENE_COLLISION_BUILD_EMPTY", `实体 ${entityId} 的网格没有产出可用的地面高度场或墙体`, entityId))
      return { compilation: null, warnings }
    }
    for (const message of layered.warnings) {
      warnings.push(warning("SCENE_COLLISION_PROVIDER_NOTE", message, entityId))
    }

    const walls: WallBox[] = []
    const mappingWarnings: string[] = []
    for (const part of layered.verticalPatch?.parts ?? []) {
      if (part.representation !== "voxel-box") {
        const message = `墙体板件 ${part.partId} 的表示 ${part.representation} 不受支持，已丢弃`
        warnings.push(warning("SCENE_COLLISION_WALL_DROPPED", message, entityId))
        mappingWarnings.push(message)
        continue
      }
      const box = wallBox(part)
      if (!box) {
        const message = `墙体板件 ${part.partId} 的 quat 或半长非法，已丢弃`
        warnings.push(warning("SCENE_COLLISION_WALL_DROPPED", message, entityId))
        mappingWarnings.push(message)
        continue
      }
      walls.push(box)
    }

    const hfield = layered.groundHfield
    const ground: SceneCollisionCompilation["ground"] = hfield
      ? {
          kind: "hfield",
          name: hfield.name,
          nrow: hfield.nrow,
          ncol: hfield.ncol,
          origin: [hfield.origin[0], hfield.origin[1], hfield.origin[2]],
          size: [hfield.size[0]!, hfield.size[1]!, hfield.size[2]!, hfield.size[3]!],
          elevation: Array.from(hfield.elevation),
        }
      : { kind: "boxes", boxes: [] }
    if (!hfield) {
      warnings.push(warning("SCENE_COLLISION_PROVIDER_NOTE", "分层编译没有产出地面高度场；ground 退化为空 boxes", entityId))
    }

    const patchBottom = layered.verticalPatch?.coverage.min[2] ?? hfield?.bounds.min[2] ?? null
    const catchNetZ = patchBottom !== null && Number.isFinite(patchBottom) ? patchBottom - 2 : null

    return {
      compilation: {
        entityId: plan.entity.entityId,
        sourceKey: plan.sourceKey,
        frame: "mujoco-z-up-meters",
        suppressDefaultGround: true,
        ground,
        walls,
        catchNetZ,
        warnings: [...layered.warnings, ...mappingWarnings],
      },
      warnings,
    }
  }
}

const sharedBuilder = new SceneCollisionBuilder()

/**
 * 为 Scene 快照编译场景碰撞补丁；无可信绑定或任何失败都返回 null。
 * 告警面向 sync 路径：需要告警时请使用 SceneCollisionBuilder.build。
 */
export async function buildSceneCollisionForSnapshot(snapshot: SceneSnapshot): Promise<SceneCollisionCompilation | null> {
  return (await sharedBuilder.build(snapshot)).compilation
}

export {
  AlignedSceneMeshSourceCache,
  alignedSceneMeshSourceKey,
  type AlignedSceneMeshSource,
} from "./source-cache.ts"
export { readGlbTriangleSoup, canonicalizeTriangleSoup, type CanonicalTriangleMesh, type GltfTriangleSoup } from "./glb-mesh.ts"
export { CanonicalTriangleSpatialIndex } from "./spatial-index.ts"
export { createAlignedMeshGroundResolver, type SceneGroundResolver } from "./scene-ground.ts"
export { buildSceneHeightfieldCollision, sampleSceneHeightfieldTopZ, type SceneHeightfieldCollision } from "./hfield-provider.ts"
export { buildSceneLayeredCollision, type SceneLayeredCollision } from "./layered-scene-provider.ts"
export { alignedSceneMeshWorldMatrix, entityWorldMatrix, splatSourceMatrix } from "./aligned-mesh-source.ts"
