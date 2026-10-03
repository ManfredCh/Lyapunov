/**
 * contracts — scene-collision 内部 DTO（移植自 History scene-collision/contracts.ts
 * 的几何/补丁部分；绑定合同已由 packages/lyapunov-contracts 拥有，此处不重复）。
 */
export type Vec3 = readonly [number, number, number]
/** 四元数 wxyz（History 补丁 DTO 的既有顺序，仅用于竖直墙板件的朝向表达）。 */
export type QuatWxyz = readonly [number, number, number, number]

export interface Bounds3 {
  min: [number, number, number]
  max: [number, number, number]
}

export type SceneCollisionPart =
  | {
      partId: string
      representation: "voxel-box"
      center: Vec3
      halfExtents: Vec3
      quat: QuatWxyz
      bounds: Bounds3
    }
  | {
      partId: string
      representation: "convex-mesh"
      /** Vertices are local to the centre of `bounds`; the adapter supplies the world position. */
      vertices: Float32Array
      indices: Uint32Array
      bounds: Bounds3
    }

export interface SceneCollisionPatch {
  patchId: string
  sourceMeshHash: string
  alignmentRevision: string
  requestHash: string
  frame: "mujoco-z-up-meters"
  parts: readonly SceneCollisionPart[]
  coverage: Bounds3
  provenance: {
    provider: string
    providerVersion: string
    voxelSizeM: number
    sourceTriangleCount: number
    outputTriangleCount: number
    buildDurationMs: number
  }
  warnings: readonly string[]
}
