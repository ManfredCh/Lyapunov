/**
 * 源坐标轴向的**怀疑判别**（ENV-20）：声明的 `upAxis` 与**逐个网格自身**的实测包围盒不一致时说一句，不改渲染。
 *
 * 为什么按"逐网格"而不是"整棵对象树"判：同一素材族里两种约定并存（实测 Kenney 素材：
 * `kenney_props_yup.glb` 的每个道具高度沿 Y，而 `prop_11_construction-cone.glb`/`kenney_props_zup.glb`
 * 的高度沿 Z）。整棵树判会**误报**——15 个道具摊在街道上时，整批包围盒的 Z 向占地本来就可能大于 Y 向高度，
 * 但每个道具自己仍是正的。逐网格判才对准"这个物件是不是躺着"这个事实。
 *
 * 判据只用两件真事实：声明的 upAxis + 每个网格的三轴尺寸；判不了（尺寸退化/非有限/轴向未知）就什么都不说。
 * 纯函数：浏览器与 Node 侧脚本同一份判据（与 DEV-025 的 `splat-support.ts` 同一风格）。
 */

export interface AxisExtents { x: number; y: number; z: number }

export interface AxisSuspect {
  code: 'VIEWER_SOURCE_AXIS_SUSPECT'
  detail: string
  /** 命中判据的网格数 / 检查过的网格数（回执里可复核比例）。 */
  offenders: number
  checked: number
}

const usable = (value: number) => Number.isFinite(value) && value > 0

/**
 * `meshes` 是**每个网格自身**的三轴尺寸（米）。声明 Y-up 而某网格的 Z 向明显大于 Y 向（默认 1.1 倍，
 * 且 Z 不短于 X）⇒ 该网格很可能是 Z-up 模型被按 Y-up 转 90°；声明 Z-up 时对称判定。
 */
export function axisSuspect(upAxis: string | undefined, meshes: readonly AxisExtents[], options: { ratio?: number } = {}): AxisSuspect | null {
  const declared = (upAxis ?? '').toUpperCase()
  if (declared !== 'Y' && declared !== 'Z') return null
  const ratio = options.ratio ?? 1.1
  let offenders = 0
  let checked = 0
  let sample: AxisExtents | null = null
  for (const extents of meshes) {
    if (!usable(extents.x) || !usable(extents.y) || !usable(extents.z)) continue
    checked += 1
    const lying = declared === 'Y'
      ? extents.z > extents.y * ratio && extents.z >= extents.x
      : extents.y > extents.z * ratio && extents.y >= extents.x
    if (lying) { offenders += 1; sample ??= extents }
  }
  if (offenders === 0 || sample === null) return null
  const measured = `${sample.x.toFixed(3)}×${sample.y.toFixed(3)}×${sample.z.toFixed(3)} m`
  const expected = declared === 'Y' ? 'Y' : 'Z'
  const actual = declared === 'Y' ? 'Z' : 'Y'
  return {
    code: 'VIEWER_SOURCE_AXIS_SUSPECT',
    offenders,
    checked,
    detail: `资源声明 upAxis=${declared}，但 ${offenders}/${checked} 个网格的竖直方向在 ${actual}（样本实测 ${measured}）：画面里这些部件很可能被转成侧倒/躺平。来源轴向要按来源核（不能统一假定 +Y-up）；修法是在来源侧改正轴向，或给它显式 sourceTransform——Viewer 不替它猜（期望竖直方向 ${expected}）。`,
  }
}

/** glTF 的多网格资源可能是装配体：零件没有独立“站立方向”，不能用零件长宽推断整件轴向。
 * 此处依据完整资源的 mesh 数，而不是某个已展开实体/克隆子节点的 mesh 数。
 * 单网格来源沿用原可疑诊断；多网格未知，不改变 source 元数据或原坐标转换。
 */
export function axisSuspectForGltf(upAxis:string|undefined,meshes:readonly AxisExtents[],resourceMeshCount:number):AxisSuspect|null {
  if(resourceMeshCount!==1)return null
  return axisSuspect(upAxis,meshes)
}
