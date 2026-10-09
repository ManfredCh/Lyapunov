import * as THREE from "three"
import { GAUSSIAN_CAMERA_BASIS, isGaussianCameraFrame } from "../../lyapunov-contracts/src/gaussian-frame.ts"

/**
 * 已识别首相机在**世界空间**里的位姿。位姿完全由文件里的坐标标记 + 该可视对象真实的 `matrixWorld`
 * （实体放置 × 源坐标适配 × 单位缩放）导出：不硬编码任何大厅的坐标/包围盒，也不改模型或物理世界。
 */
export interface GaussianFirstCameraPose {
  /** 首相机中心（文件坐标原点经 matrixWorld 的平移）。 */
  position: THREE.Vector3
  /** 文件空间视线方向经 matrixWorld 的旋转部分变换后的世界单位向量。 */
  forward: THREE.Vector3
  /** 文件空间 up 经 matrixWorld 的旋转部分变换后的世界单位向量。 */
  up: THREE.Vector3
}

/**
 * 从已识别的 frame 与对象世界矩阵算首相机位姿；任何非有限值、零向量、或 forward/up 退化成平行时
 * 返回 `undefined`，调用方据此沿用既有默认视角——识别得了标记但矩阵坏掉时不硬跳。
 */
export function gaussianFirstCameraPose(frame: unknown, matrixWorld: THREE.Matrix4): GaussianFirstCameraPose | undefined {
  if (!isGaussianCameraFrame(frame)) return undefined
  const basis = GAUSSIAN_CAMERA_BASIS[frame]
  const position = new THREE.Vector3().setFromMatrixPosition(matrixWorld)
  const forward = new THREE.Vector3(basis.forward[0], basis.forward[1], basis.forward[2]).transformDirection(matrixWorld)
  const up = new THREE.Vector3(basis.up[0], basis.up[1], basis.up[2]).transformDirection(matrixWorld)
  if (![...position.toArray(), ...forward.toArray(), ...up.toArray()].every(Number.isFinite)) return undefined
  if (forward.lengthSq() < 1e-12 || up.lengthSq() < 1e-12) return undefined
  if (new THREE.Vector3().crossVectors(forward, up).lengthSq() < 1e-12) return undefined
  return { position, forward, up }
}
