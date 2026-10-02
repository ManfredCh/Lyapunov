/**
 * mat4 — 极简列主序 4x4 矩阵工具（无依赖，替代参考实现里的 THREE.Matrix4）。
 *
 * 布局与 THREE.Matrix4.elements / glTF node.matrix 一致：列主序 16 元素，
 * 即 m[0..3] 是第一列，平移在 m[12..14]。向量按列向量右乘：p' = M * p。
 * 四元数序为 xyzw（Scene 合同 `coordinates.quaternion: "xyzw"`，与
 * THREE.Quaternion.fromArray 相同）。
 */

/** 列主序 4x4 矩阵（16 个有限数）。 */
export type Mat4 = number[]

export interface TrsTransform {
  readonly position: readonly [number, number, number]
  readonly quaternion: readonly [number, number, number, number]
  readonly scale: readonly [number, number, number]
}

export function identityMat4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

export function isFiniteMat4(m: readonly number[]): boolean {
  return Array.isArray(m) && m.length === 16 && m.every(Number.isFinite)
}

/** out = a * b（列向量语义：先应用 b，再应用 a）。 */
export function multiplyMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out: Mat4 = new Array<number>(16)
  for (let column = 0; column < 4; column++) {
    const b0 = b[column * 4]!
    const b1 = b[column * 4 + 1]!
    const b2 = b[column * 4 + 2]!
    const b3 = b[column * 4 + 3]!
    out[column * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3
    out[column * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3
    out[column * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3
    out[column * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3
  }
  return out
}

/** 与 THREE.Matrix4.compose 等价的 TRS 合成（四元数 xyzw，不要求归一）。 */
export function mat4FromTrs(transform: TrsTransform): Mat4 {
  const [px, py, pz] = transform.position
  const [qx, qy, qz, qw] = transform.quaternion
  const [sx, sy, sz] = transform.scale
  const x2 = qx + qx
  const y2 = qy + qy
  const z2 = qz + qz
  const xx = qx * x2
  const xy = qx * y2
  const xz = qx * z2
  const yy = qy * y2
  const yz = qy * z2
  const zz = qz * z2
  const wx = qw * x2
  const wy = qw * y2
  const wz = qw * z2
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    px,
    py,
    pz,
    1,
  ]
}

/** p' = M * p，含透视除法（本模块的矩阵都是仿射的，w 恒为 1）。 */
export function applyMat4ToPoint(
  m: readonly number[],
  point: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = point
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  const invW = w === 0 ? 1 : 1 / w
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * invW,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * invW,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * invW,
  ]
}
