/**
 * 近原生形状检测：轴对齐盒 / 球 / z 轴圆柱拟合。
 * 命中即用引擎原生 geom（零误差、零烘焙成本，根治外凸包对简单形状的过冲——实测 2m 立方体
 * 外凸包过冲 32%）；任何不确定都返回 undefined 退回凸包路径，保守方向不出错几何。
 */
export interface PrimitiveFit { shape: 'box' | 'sphere' | 'cylinder'; center: [number, number, number]; halfExtents: [number, number, number] }

export function fitPrimitive(vertices: Float64Array, meshVolumeM3: number): PrimitiveFit | undefined {
  if (vertices.length < 9) return undefined
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let axis = 0; axis < 3; axis++)
    for (let i = axis; i < vertices.length; i += 3) {
      if (vertices[i]! < min[axis]!) min[axis] = vertices[i]!
      if (vertices[i]! > max[axis]!) max[axis] = vertices[i]!
    }
  const center = min.map((v, i) => (v + max[i]!) / 2) as [number, number, number]
  const half = min.map((v, i) => (max[i]! - v) / 2) as [number, number, number]
  if (half.some(h => !(h > 0))) return undefined
  const volume = Math.abs(meshVolumeM3)
  if (!(volume > 0)) return undefined
  // 盒：网格体积≈AABB 体积。倒角/圆角盒体积亏损超过 2%，挡在凸包路径（保守）。
  const boxVolume = 8 * half[0] * half[1] * half[2]
  if (volume / boxVolume >= 0.98) return { shape: 'box', center, halfExtents: half }
  // 球：三向等径且体积≈外接球（细分球体体积略小于理想球，8% 容差）。
  const r = (half[0] + half[1] + half[2]) / 3
  const sphereVolume = 4 / 3 * Math.PI * r ** 3
  if (half.every(h => Math.abs(h - r) / r <= 0.03) && Math.abs(volume / sphereVolume - 1) <= 0.08)
    return { shape: 'sphere', center, halfExtents: [r, 0, 0] }
  // z 轴圆柱：x/y 等径。worker 派生 geom 不支持逐 geom 旋转，其他轴向一律退回凸包。
  const rc = (half[0] + half[1]) / 2
  const cylinderVolume = Math.PI * rc * rc * 2 * half[2]
  if (Math.abs(half[0] - half[1]) / rc <= 0.03 && Math.abs(volume / cylinderVolume - 1) <= 0.08)
    return { shape: 'cylinder', center, halfExtents: [rc, half[2], 0] }
  return undefined
}
