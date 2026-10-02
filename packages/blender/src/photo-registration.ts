/**
 * ENV-09 最小配准承载（N312）：两视/多视**真实照片**的刚体配准 + 残差读数 + 融合网格。
 *
 * 为什么放在这里：产品的深度/几何通路（`packages/depth-estimation` 的 `depth_geometry`）**明确不做配准**
 * （`packages/depth-estimation/src/geometry.ts:15`「不做配准：多图合并要求调用方给每个条目同一个
 * `registration.frameId`，不一致直接拒绝」、`:398`「本工具不做配准，也不验证该声明」），
 * 而 ENV-09 要的正是"配准"这一步。本模块只做**纯计算 + 一份 GLB 写盘**，不新建服务、不加依赖、
 * 不引入第二套真值：输入是调用方给的点云/深度＋内参，输出是刚体变换、逐点残差统计与融合网格。
 *
 * 判据与容差来源（可复算、写在报告里）：
 *  · `lateralPixelFootprintM = depthMeanM / fx`：一个像素在平均景深处张开多少米（针孔模型）；
 *  · 深度量化：数据集深度是毫米整数 ⇒ 0.001 m；
 *  · `toleranceM = max(2 × lateralPixelFootprintM, 0.005)`：**中位残差**落在这个量级内才算"达容差"，
 *    即"不比一次像素量化 + 一次深度量化更差"；这是本模块的判定来源，不是外部拍脑袋阈值。
 *
 * 失败语义（N331，两条缺陷修复；充分性度量 N339 对齐；重叠度 N341 补齐）：① 配对不足（末轮 `pairs == 0` 或**残差样本数** `< MIN_REGISTRATION_PAIRS`）
 * 或**重叠度不足**（`overlapRatio < MIN_OVERLAP_RATIO`，N341）⇒
 * **可判定失败** `REGISTRATION_INSUFFICIENT_PAIRS`，不返回残差/变换冒充结果（旧实现静默返回上一轮读数——该路径已删除）；
 * ② 无效深度像素（NaN/Inf/非正值）不产生顶点，`writeGlbMesh` 拒绝写出 NaN/Inf 顶点（`GLB_NON_FINITE_VERTEX`）。
 *
 * 估计器（N340 修复，N341 切默认）：`RegisterOptions.stepComposition:"aligned"` 修 `compose` 的旋转步复合（旧实算 R_base·(I−[ω]×)，
 * 与文档式/平移半边自相矛盾 ⇒ 37 mm 真实对发散到 |t|=553.77 mm）；**自 N341 起默认 `"aligned"`**（37 mm 判据构造 3.2980 mm ≤ 13.1339 mm 达标），
 * `"legacy"` 分支保留、可显式选（逐位＝N340 修前实算）。判据/容差一字未动；失败语义由重叠度闸补齐（N331 完成，见 `MIN_OVERLAP_RATIO`）。
 */
import { writeFileSync } from "node:fs"

export interface Intrinsics { fx: number; fy: number; cx: number; cy: number }
/** 列主序 3×3 旋转（与 glTF 的列主序一致）+ 米制平移。 */
export interface RigidTransform { rotation: readonly number[]; translation: readonly [number, number, number] }
export type PointSet = Float32Array
export type ResidualMode = "point-to-point" | "point-to-plane"
export interface RegisterOptions {
  maxIterations?: number
  /** 残差/求解模式：`point-to-plane` 用目标法线（点对面），对平滑表面比点到点稳。默认 point-to-point（保持既有行为）。 */
  residualMode?: ResidualMode
  /** 目标点云法线（与 target 同长；point-to-plane 需要）。不给就从 target 现算不了——调用方给 `normalsFromDepth()` 的结果。 */
  targetNormals?: PointSet
  /** 点到面模式下：法线夹角超过这个余弦（默认 0.5≈60°）的配对当外点剔除。 */
  normalCosMin?: number
  /** 最近邻超过这个距离的点当外点剔除（米）。默认 0.05。 */
  trimM?: number
  /** 参与配准的最大点数（按步长抽样）。默认 4000。 */
  maxPoints?: number
  /** 初始变换（不给就是单位阵；双目/同机位小基线场景够用）。 */
  initial?: RigidTransform
  /** 步复合口径（N340 修复，N341 切默认）：`"aligned"`（默认）＝旋转步复合按 `compose` 自己的文档式
   *  `R_new = R_delta · R_base`（与平移半边 `D·τ+t`、求解 `s+ω×s+t` 同一约定）；`"legacy"` 分支保留、可显式选＝既有实算**逐位不变**。
   *  N341 切默认（Lead 授权）：①钉缺陷现场的 7 处断言改钉修后现场；②补重叠度闸＝N331 失败语义的完成（无它则零重叠/跨场景对过 600 样本闸返回假变换）。
   *  判据/容差/分位/推导一字未动。 */
  stepComposition?: "legacy" | "aligned"
}
export interface ResidualStats { count: number; medianM: number; p90M: number; p95M: number; meanM: number; maxM: number }

export const IDENTITY_TRANSFORM: RigidTransform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] }

/** 米制锚点：没有它就不能宣称绝对精度（本模块据此降级为"相对"）。 */
export interface ScaleAnchor { kind: "dataset-calibration" | "measured" | "assumed"; valueM?: number; source: string }

/**
 * 视图的**登记事实**（ENV-09 过滤面，N354b）：三个字段全部可选——**给了才用，缺了不推断**
 * （本模块不做 EXIF/年代猜测，与 `scene-kit/reference-tools.ts` 的"不做 EXIF 推断"同一诚实语义）。
 */
export interface RegistrationFacts {
  /** 采集坐标系/帧标识：**两侧都已声明且不同** ⇒ 直接拒绝配对（不同坐标系不得配准）；一侧未声明 ⇒ 不比较。 */
  frameId?: string
  /** 对象标签：与参考视**已声明**的标签不同 ⇒ 该视不参与配对（计入 `excluded`），不静默混融。 */
  objectTag?: string
  /** 采集时间（自由文本）：仅在 `targetEra` 已声明时参与年代匹配；**缺失 ⇒ 不排除、不推断**。 */
  captureTime?: string
}

/** 被过滤掉的视图（不参与配对的事实）：回执里恒给数组（无排除 ⇒ 空数组，不省略字段）。 */
export interface ExcludedView { viewId: string; reason: "object-tag-mismatch" | "era-mismatch"; field: "objectTag" | "captureTime" }

/** 年代过滤是否生效：**未声明 `targetEra` 时必须显式写 `"not-declared"`**（省略就算漏报）。 */
export type EraExclusion = "applied:targetEra" | "not-declared"

/**
 * 年代标签匹配（最小实现，不做别的猜测）：相等即匹配；`YYYYs`（如 `1990s`）额外接受 `captureTime` 里
 * **四位年份**落在该十年内的写法（如 `1995-06-01`）。其它格式一律算不匹配——不猜时区、不猜缺位。
 */
function matchesEra(captureTime: string, targetEra: string): boolean {
  if (captureTime === targetEra) return true
  const decade = /^(\d{3})0s$/.exec(targetEra)
  if (!decade) return false
  const year = /(\d{4})/.exec(captureTime)
  if (!year) return false
  const start = Number(decade[1]) * 10
  const value = Number(year[1])
  return value >= start && value < start + 10
}

export interface RegisterViewsInput {
  /** 只有米制（绝对尺度）输入才允许给 `meter`；`relative` 直接降级，不给米制结论。 */
  units: "meter" | "relative"
  views: Array<{ viewId: string; points: PointSet; intrinsics: Intrinsics; depthMeanM: number; anchor?: ScaleAnchor; registration?: RegistrationFacts }>
  options?: RegisterOptions
  /** 目标年代标签（如 `"1990s"`）：**仅在显式声明时**参与过滤；未声明 ⇒ 回执写 `eraExclusion:"not-declared"`，不推断。 */
  targetEra?: string
}

/** 逐点残差（米）：中位 + 分位。空集返回 null，不返回伪 0。 */
export function residualStats(values: readonly number[]): ResidualStats | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  return { count: sorted.length, medianM: at(0.5), p90M: at(0.9), p95M: at(0.95), meanM: sum / sorted.length, maxM: sorted[sorted.length - 1]! }
}

/** 容差（米）+ 来源文本：像素足迹与深度量化谁大取谁，再留 2× 余量。 */
export function toleranceFor(intrinsics: Intrinsics, depthMeanM: number): { toleranceM: number; lateralPixelFootprintM: number; source: string } {
  const lateralPixelFootprintM = depthMeanM / intrinsics.fx
  const toleranceM = Math.max(2 * lateralPixelFootprintM, 0.005)
  return { toleranceM, lateralPixelFootprintM, source: `max(2 × (depthMean ${depthMeanM.toFixed(5)} m / fx ${intrinsics.fx} px) = ${(2 * lateralPixelFootprintM).toFixed(5)} m, 0.005 m 深度量化下限)` }
}

/** 深度图（沿相机轴的米制 Z，0 表示无效）→ 相机坐标系点云（针孔反投影）。 */
export function depthToPoints(depth: PointSet, width: number, height: number, k: Intrinsics): PointSet {
  const out: number[] = []
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const z = depth[v * width + u]!
      if (!(z > 0) || !Number.isFinite(z)) continue
      out.push(((u - k.cx) * z) / k.fx, ((v - k.cy) * z) / k.fy, z)
    }
  }
  return Float32Array.from(out)
}

/** 由深度图**现算**法线（相机坐标系，单位向量；无效/边界像素给 (0,0,1) 并由调用方按 valid 掩码剔除）。 */
export function normalsFromDepth(depth: PointSet, width: number, height: number, k: Intrinsics): PointSet {
  const out = new Float32Array(width * height * 3)
  const at = (u: number, v: number): [number, number, number] | null => {
    if (u < 0 || v < 0 || u >= width || v >= height) return null
    const z = depth[v * width + u]!
    if (!(z > 0)) return null
    return [((u - k.cx) * z) / k.fx, ((v - k.cy) * z) / k.fy, z]
  }
  for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
    const dx = at(u + 1, v) && at(u - 1, v) ? [at(u + 1, v)![0] - at(u - 1, v)![0], at(u + 1, v)![1] - at(u - 1, v)![1], at(u + 1, v)![2] - at(u - 1, v)![2]] : null
    const dy = at(u, v + 1) && at(u, v - 1) ? [at(u, v + 1)![0] - at(u, v - 1)![0], at(u, v + 1)![1] - at(u, v - 1)![1], at(u, v + 1)![2] - at(u, v - 1)![2]] : null
    let n: [number, number, number] = [0, 0, 1]
    if (dx && dy) {
      const cross: [number, number, number] = [dx[1]! * dy[2]! - dx[2]! * dy[1]!, dx[2]! * dy[0]! - dx[0]! * dy[2]!, dx[0]! * dy[1]! - dx[1]! * dy[0]!]
      const len = Math.hypot(cross[0], cross[1], cross[2])
      if (len > 1e-9) n = [cross[0] / len, cross[1] / len, cross[2] / len]
    }
    out[(v * width + u) * 3] = n[0]; out[(v * width + u) * 3 + 1] = n[1]; out[(v * width + u) * 3 + 2] = n[2]
  }
  return out
}

/** 点到面线性化：最小化 Σ ((s + ω×s + t − q)·n)²；系数对 (ω,t) 是 [(s×n), n]。 */
function solvePointToPlane(pairs: Array<{ s: [number, number, number]; q: [number, number, number]; n: [number, number, number] }>): { omega: [number, number, number]; t: [number, number, number] } {
  const ata = Array.from({ length: 6 }, () => new Array<number>(6).fill(0))
  const atb = new Array<number>(6).fill(0)
  for (const { s, q, n } of pairs) {
    const cross: [number, number, number] = [s[1] * n[2] - s[2] * n[1], s[2] * n[0] - s[0] * n[2], s[0] * n[1] - s[1] * n[0]]
    const row = [cross[0], cross[1], cross[2], n[0], n[1], n[2]]
    const residual = (s[0] - q[0]) * n[0] + (s[1] - q[1]) * n[1] + (s[2] - q[2]) * n[2]
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) ata[i]![j] += row[i]! * row[j]!
      atb[i] -= row[i]! * residual
    }
  }
  const n = 6
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(ata[row]![col]!) > Math.abs(ata[pivot]![col]!)) pivot = row
    if (Math.abs(ata[pivot]![col]!) < 1e-12) continue
    ;[ata[col], ata[pivot]] = [ata[pivot]!, ata[col]!]
    ;[atb[col], atb[pivot]] = [atb[pivot]!, atb[col]!]
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = ata[row]![col]! / ata[col]![col]!
      if (!factor) continue
      for (let j = col; j < n; j++) ata[row]![j]! -= factor * ata[col]![j]!
      atb[row]! -= factor * atb[col]!
    }
  }
  const solution = atb.map((value, i) => (Math.abs(ata[i]![i]!) < 1e-12 ? 0 : value / ata[i]![i]!))
  return { omega: [solution[0]!, solution[1]!, solution[2]!], t: [solution[3]!, solution[4]!, solution[5]!] }
}

const apply = (t: RigidTransform, x: number, y: number, z: number): [number, number, number] => [
  t.rotation[0]! * x + t.rotation[3]! * y + t.rotation[6]! * z + t.translation[0],
  t.rotation[1]! * x + t.rotation[4]! * y + t.rotation[7]! * z + t.translation[1],
  t.rotation[2]! * x + t.rotation[5]! * y + t.rotation[8]! * z + t.translation[2],
]

/** 按步长抽样到 maxPoints 个点（确定性，不用随机数）。 */
function subsample(points: PointSet, maxPoints: number): PointSet {
  const count = points.length / 3
  if (count <= maxPoints) return points
  const stride = Math.ceil(count / maxPoints)
  const out: number[] = []
  for (let i = 0; i < count; i += stride) out.push(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!)
  return Float32Array.from(out)
}

/** 5 cm 体素哈希的最近邻（外点会被 trimM 挡掉，不返回"最近的远点"）。 */
class GridIndex {
  private readonly cell = 0.05
  private readonly map = new Map<string, number[]>()
  private readonly points: PointSet
  constructor(points: PointSet) {
    this.points = points
    for (let i = 0; i < points.length / 3; i++) {
      const key = this.key(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!)
      const bucket = this.map.get(key)
      if (bucket) bucket.push(i)
      else this.map.set(key, [i])
    }
  }
  private key(x: number, y: number, z: number): string { return `${Math.floor(x / this.cell)}|${Math.floor(y / this.cell)}|${Math.floor(z / this.cell)}` }
  nearest(x: number, y: number, z: number, maxDistance: number): { index: number; distance: number } | null {
    const radius = Math.max(1, Math.ceil(maxDistance / this.cell))
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell), cz = Math.floor(z / this.cell)
    let best = -1, bestSq = maxDistance * maxDistance
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
      const bucket = this.map.get(`${cx + dx}|${cy + dy}|${cz + dz}`)
      if (!bucket) continue
      for (const index of bucket) {
        const ddx = this.points[index * 3]! - x, ddy = this.points[index * 3 + 1]! - y, ddz = this.points[index * 3 + 2]! - z
        const sq = ddx * ddx + ddy * ddy + ddz * ddz
        if (sq < bestSq) { bestSq = sq; best = index }
      }
    }
    return best < 0 ? null : { index: best, distance: Math.sqrt(bestSq) }
  }
}

/** 小角度线性化的 6×6 最小二乘（ω, t）：够用于同机位/小基线配准；大角度请给 initial 或先粗对齐。 */
function solveSmallAngle(pairs: Array<{ s: [number, number, number]; t: [number, number, number] }>): { omega: [number, number, number]; t: [number, number, number] } {
  const ata = Array.from({ length: 6 }, () => new Array<number>(6).fill(0))
  const atb = new Array<number>(6).fill(0)
  for (const { s, t } of pairs) {
    // 残差 = s + ω×s + t − t_target；对 (ωx,ωy,ωz,tx,ty,tz) 的雅可比：
    // ω×s = (−ωz·sy + ωy·sz, ωz·sx − ωx·sz, −ωy·sx + ωx·sy)
    const rows: number[][] = [
      [0, s[2], -s[1], 1, 0, 0],
      [-s[2], 0, s[0], 0, 1, 0],
      [s[1], -s[0], 0, 0, 0, 1],
    ]
    const residual = [s[0] - t[0], s[1] - t[1], s[2] - t[2]]
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) ata[i]![j] += rows[r]![i]! * rows[r]![j]!
        atb[i] -= rows[r]![i]! * residual[r]!
      }
    }
  }
  // 高斯消元（6×6，带部分主元）
  const n = 6
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) if (Math.abs(ata[row]![col]!) > Math.abs(ata[pivot]![col]!)) pivot = row
    if (Math.abs(ata[pivot]![col]!) < 1e-12) continue
    ;[ata[col], ata[pivot]] = [ata[pivot]!, ata[col]!]
    ;[atb[col], atb[pivot]] = [atb[pivot]!, atb[col]!]
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = ata[row]![col]! / ata[col]![col]!
      if (!factor) continue
      for (let j = col; j < n; j++) ata[row]![j]! -= factor * ata[col]![j]!
      atb[row]! -= factor * atb[col]!
    }
  }
  const solution = atb.map((value, i) => (Math.abs(ata[i]![i]!) < 1e-12 ? 0 : value / ata[i]![i]!))
  return { omega: [solution[0]!, solution[1]!, solution[2]!], t: [solution[3]!, solution[4]!, solution[5]!] }
}

function compose(base: RigidTransform, omega: [number, number, number], t: [number, number, number], alignedRotation = false): RigidTransform {
  // R_delta ≈ I + [ω]×（小角度），再用一阶 Taylor 复合：R_new ≈ R_delta · R_base
  // （N340 `stepComposition:"aligned"`＝N341 起**默认**，按该式实算 R_delta·R_base。显式 `"legacy"` **逐位保留**既有实算
  //   `mul[i*3+j] = Σ_k d[i*3+k]·r[k*3+j]`——列主序视角下它是 M_base·(I−[ω]×)（旋转步反号、乘在右侧），
  //   与上一行文档和平移半边 `D·τ + t`（Δ∘T、输出帧约定）自相矛盾；37 mm 真实对上它把 |t| 推到 553.77 mm
  //   （rotErr 32°，而该对真值是纯平移）。两分支只差旋转复合这一步，判据/容差/闸门/残差口径不在此函数内。）
  const [wx, wy, wz] = omega
  const d = [1, -wz, wy, wz, 1, -wx, -wy, wx, 1]
  const r = base.rotation, mul = new Array<number>(9).fill(0)
  if (alignedRotation) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let sum = 0; for (let k = 0; k < 3; k++) sum += d[i * 3 + k]! * r[j * 3 + k]!; mul[j * 3 + i] = sum }
  } else {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let sum = 0; for (let k = 0; k < 3; k++) sum += d[i * 3 + k]! * r[k * 3 + j]!; mul[i * 3 + j] = sum }
  }
  const nt: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) nt[i] = d[i * 3]! * base.translation[0] + d[i * 3 + 1]! * base.translation[1] + d[i * 3 + 2]! * base.translation[2] + t[i]!
  return { rotation: mul, translation: nt }
}

/** 可判定失败（N331）：`insufficient-pairs` ⇒ 无残差/变换；`no-convergence` ⇒ 读数保留但结论是失败（不冒充结果）。 */
export type RegistrationFailure =
  /** `overlapRatio`（N341）只在**重叠度闸**拒绝时给；计数闸（`pairs==0`/残差样本<600）路径的失败对象逐位不变。 */
  | { code: "REGISTRATION_INSUFFICIENT_PAIRS"; pairs: number; minPairs: number; overlapRatio?: number }
  | { code: "REGISTRATION_NO_CONVERGENCE"; medianM: number; toleranceM: number }

/**
 * 配对充分性阈值（N331 新常量，N339 度量对齐）：末轮**残差样本数**低于它 ⇒ `REGISTRATION_INSUFFICIENT_PAIRS`，不返回残差/变换（阈值度量＝残差样本数，与 p95 推导同域）。
 * 依据：本模块对外报告的残差分位含 **p95**，p95 的 5% 尾部要有 ≥ 30 个样本才有统计意义 ⇒ 30 / 0.05 = 600；
 * 求解本身的代数下限仍是 12（6 个未知数、每对 3 个方程，留 2× 裕量）——那只保证方程组可解，不保证结论可判。
 * （点到点下 `pairs` 恒等于残差样本数；点到面下 `pairs` 只计通过视角过滤、进入求解的配对——故充分性按**残差样本数**判、`pairs` 只用于求解下限 12；`minPairs` 字段语义＝「最少残差样本数」。）
 */
export const MIN_REGISTRATION_PAIRS = 600
/** 求解下限（沿用既有值 12，判据不改）：低于此不进 6×6 解算。 */
const MIN_SOLVER_PAIRS = 12

/**
 * 重叠度阈值（N341 新常量；＝N331 失败语义的**完成**、裁决 C，非新判据）：末轮重叠度低于它 ⇒ `REGISTRATION_INSUFFICIENT_PAIRS`（失败对象带 `overlapRatio`）。
 * 统计口径：残差样本所处的**同一测量轮**（与 p95/600 推导同域），对参与配准的每个源采样点（`subsample(source, maxPoints)` 输出）取对应距离——
 *   最近邻门 `trim` 内命中记 `d ≤ trim`、未命中记 `d > trim` ⇒ 重叠度 `overlapRatio = |{d ≤ trim}| / 源采样点数 = 残差样本数 / 源采样点数`
 *   （＝对应距离分布的闸内占比；未命中样本即分布里 `d > trim` 的部分）。
 * 公式与数值：`MIN_OVERLAP_RATIO = 1/2 = 0.5`。推导（照 `MIN_REGISTRATION_PAIRS = 600 = 30/0.05` 的范式：统计口径、公式、数值）：
 *  · 机理（真重叠）：两视覆盖同一表面、配准到位 ⇒ 每个源采样点的对应距离都落在传感器误差带内 ⇒ 占比 → 1（实测 37 mm 真实对 = 1.000）；
 *    机理（零重叠/跨场景）：命中只是门内**偶然就近**（占空比），随场景差异单调下降（实测大基线零重叠对 = 0.424、跨场景对 = 0.256——
 *    这两对过 600 样本闸后返回的假变换 |t| = 1,488/1,817 mm，即「配对够但几何不可能」必须拒绝的现场）。
 *  · 分界取**过半**（最小严格多数）：重叠区过半 ⇒ 多数对应共同约束刚体 6 自由度；不过半 ⇒ 未命中方向（沿面滑移/法向漂移）无对应约束，
 *    位姿可漂移出任意假变换而残差照样"好看"。
 *  · 统计精度：该比例的有效样本量 n = 残差样本数，已由 600 闸保证 n ≥ 600 ⇒ 二项比例在 p=1/2 处标准误 ≤ 0.5/√600 ≈ 0.020
 *    （3σ ≈ ±0.061）⇒ 阈值两侧 0.56/0.44 之外的判定在 600 样本下互不重叠（实测过闸侧 ≥ 0.584、拒判侧 ≤ 0.424，不落灰带）。
 *  · 候选「互最近邻比」已实测**否决**（不作闸）：零重叠对 = 0.574 反而高于错内参负对照 = 0.527 ⇒ 任何阈值都无法同时保住
 *    「错内参仍给残差读数」与「零重叠判不足」（逐构造读数见回执 Round 26）。
 */
export const MIN_OVERLAP_RATIO = 0.5

export interface RegistrationReport {
  viewId: string
  metric: boolean
  /** `insufficient-pairs`（N331 新增成员）：末轮配对不足，残差/变换一律不给（见 `failure`）。 */
  verdict: "within-tolerance" | "outside-tolerance" | "relative-only" | "insufficient-pairs"
  /** 配准变换；`null` ⇔ 配对不足、没有可信变换，**不得当结果用**（N331 失败语义；原实现会带回上一轮变换）。 */
  transform: RigidTransform | null
  iterations: number
  pairs: number
  /** 判定用的残差（与 `mode` 一致：点到点或点到面）。 */
  residuals: ResidualStats | null
  /** 同一配准结果下的另一种残差读数（对照用，不参与判定）。 */
  residualsOtherMode: ResidualStats | null
  mode: ResidualMode
  toleranceM: number
  toleranceSource: string
  /** 可判定失败（N331）：配对不足（无残差/变换）或跑满轮数仍未达既有容差判据（读数保留、结论是失败）。 */
  failure?: RegistrationFailure
  blocked?: string
}

/** 把 source 点云配到 target 上：ICP（最近邻 + 小角度线性化解 + 外点剔除）。
 * 失败语义（N331；充分性度量 N339 对齐；重叠度 N341 补齐）：末轮 `pairs == 0`、**残差样本数** `< MIN_REGISTRATION_PAIRS` 或
 * **重叠度** `overlapRatio < MIN_OVERLAP_RATIO` ⇒ **可判定失败** `REGISTRATION_INSUFFICIENT_PAIRS`，
 * `transform` 为 `null`、`residuals*` 为空数组——**不返回残差/变换冒充结果**（旧实现在 `pairs<12` 静默 break 后返回上一轮读数，该路径已删除）。 */
export function registerPointClouds(source: PointSet, target: PointSet, options: RegisterOptions = {}): { transform: RigidTransform | null; iterations: number; pairs: number; residualsM: number[]; residualsPointToPlaneM: number[]; mode: ResidualMode; failure?: RegistrationFailure } {
  const mode: ResidualMode = options.residualMode ?? "point-to-point"
  const maxIterations = options.maxIterations ?? 30
  const initial = options.initial ?? IDENTITY_TRANSFORM
  const trimBase = options.trimM ?? 0.05
  const normalCosMin = options.normalCosMin ?? 0.5
  const src = subsample(source, options.maxPoints ?? 4000)
  const index = new GridIndex(target)
  let transform = initial
  let lastResiduals: number[] = []
  let lastPlaneResiduals: number[] = []
  let iterations = 0, pairs = 0
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterations = iteration + 1
    const pointPairs: Array<{ s: [number, number, number]; t: [number, number, number] }> = []
    const planePairs: Array<{ s: [number, number, number]; q: [number, number, number]; n: [number, number, number] }> = []
    const distances: number[] = []
    const planeDistances: number[] = []
    const trim = iteration < 3 ? trimBase * 4 : trimBase // 前几轮先放宽，避免一开始就无配对
    for (let i = 0; i < src.length / 3; i++) {
      const s = apply(transform, src[i * 3]!, src[i * 3 + 1]!, src[i * 3 + 2]!)
      const hit = index.nearest(s[0], s[1], s[2], trim)
      if (!hit) continue
      const q: [number, number, number] = [target[hit.index * 3]!, target[hit.index * 3 + 1]!, target[hit.index * 3 + 2]!]
      distances.push(hit.distance)
      const normal: [number, number, number] = options.targetNormals
        ? [options.targetNormals[hit.index * 3]!, options.targetNormals[hit.index * 3 + 1]!, options.targetNormals[hit.index * 3 + 2]!]
        : [0, 0, 1]
      // 点对面残差（只统计，供报告）
      planeDistances.push(Math.abs((s[0] - q[0]) * normal[0] + (s[1] - q[1]) * normal[1] + (s[2] - q[2]) * normal[2]))
      if (mode === "point-to-plane") {
        // 视角差太大（法线与视线夹角过小）的配对不参与求解：点对面在这种配对上是病态的
        const view = Math.hypot(s[0], s[1], s[2]) > 1e-9 ? [-s[0] / Math.hypot(s[0], s[1], s[2]), -s[1] / Math.hypot(s[0], s[1], s[2]), -s[2] / Math.hypot(s[0], s[1], s[2])] : [0, 0, -1]
        const facing = Math.abs(normal[0] * view[0]! + normal[1] * view[1]! + normal[2] * view[2]!)
        if (facing < normalCosMin) continue
        planePairs.push({ s, q, n: normal })
      } else {
        pointPairs.push({ s, t: q })
      }
    }
    pairs = mode === "point-to-plane" ? planePairs.length : pointPairs.length
    // 低于求解下限不再解算；**也不再静默返回上一轮读数**——跳出后统一落到下面的配对不足失败判定
    if (pairs < MIN_SOLVER_PAIRS) break
    const step = mode === "point-to-plane" ? solvePointToPlane(planePairs) : solveSmallAngle(pointPairs)
    transform = compose(transform, step.omega, step.t, options.stepComposition !== "legacy") // N341：默认 `"aligned"`（只有显式 `"legacy"` 走旧实算）
    lastResiduals = distances
    lastPlaneResiduals = planeDistances
  }
  // 配对充分性＝可判定失败（N339 度量对齐）：阈值度量＝残差样本数，与 p95 推导同域（p95 的 5% 尾部样本来自残差数组）；
  // 求解下限 12 按 pairs（`pairs`，方程可解性，不动）。点到面下 `pairs` 只计求解子集 ⇒ 用它判充分性会误杀（37 mm 对 pairs=550、残差样本 1,449），
  // 故充分性闸门改判残差样本数（`sampleCount`＝对应模式残差数组长度：点到点 `residualsM.length`、点到面 `residualsPointToPlaneM.length`）。
  // `pairs === 0` 仍硬失败（无配对即无残差）；`failure.minPairs` 语义随改为「最少残差样本数」（值仍 = MIN_REGISTRATION_PAIRS = 600，p95 推导不变；最薄实现：不加 minSamples 字段）。
  const sampleCount = mode === "point-to-plane" ? lastPlaneResiduals.length : lastResiduals.length
  if (pairs === 0 || sampleCount < MIN_REGISTRATION_PAIRS) {
    return { transform: null, iterations, pairs, residualsM: [], residualsPointToPlaneM: [], mode, failure: { code: "REGISTRATION_INSUFFICIENT_PAIRS", pairs, minPairs: MIN_REGISTRATION_PAIRS } }
  }
  // 重叠度闸（N341，＝N331 失败语义的完成）：判的是**返回位姿处的对应重叠证据**（不是视图血缘）——对应距离分布的闸内占比
  // （残差样本数 / 源采样点数）低于 `MIN_OVERLAP_RATIO` ⇒ 重叠不足以约束刚体 6 自由度，**可判定失败**
  // `REGISTRATION_INSUFFICIENT_PAIRS`（带 `overlapRatio`），不返回残差/变换冒充结果（零重叠/跨场景对过 600 样本闸后的假变换路径即此）。
  const sampledSource = src.length / 3
  const overlapRatio = sampledSource > 0 ? sampleCount / sampledSource : 0
  if (overlapRatio < MIN_OVERLAP_RATIO) {
    return { transform: null, iterations, pairs, residualsM: [], residualsPointToPlaneM: [], mode, failure: { code: "REGISTRATION_INSUFFICIENT_PAIRS", pairs, minPairs: MIN_REGISTRATION_PAIRS, overlapRatio } }
  }
  return { transform, iterations, pairs, residualsM: lastResiduals, residualsPointToPlaneM: lastPlaneResiduals, mode }
}

/** 逐视配准 + 残差统计 + 容差判定；`units:"relative"` 或没有米制锚点 ⇒ 只给相对结论。 */
export function registerViews(input: RegisterViewsInput): { reference: RegistrationReport; others: RegistrationReport[]; metric: boolean; blocked?: string; excluded: ExcludedView[]; eraExclusion: EraExclusion } {
  const [first, ...rest] = input.views
  if (!first) throw new Error("PHOTO_REGISTRATION_NO_VIEWS: 至少给一个视图")
  // 配对前闸（ENV-09 过滤面，N354b）：**先过滤再配对**。
  //  · frameId：两侧都已声明且不同 ⇒ 直接抛错（不同坐标系不得配准，与 depth-estimation 的 frameId 一致性闸同一语义）；
  //  · objectTag / 年代：与参考视不一致 ⇒ 该视**不参与配对**、如实计入 `excluded`——不静默混融，也不拿缺失字段推断。
  const referenceFrameId = first.registration?.frameId
  const referenceObjectTag = first.registration?.objectTag
  const targetEra = input.targetEra
  const excluded: ExcludedView[] = []
  const candidates = rest.filter((view) => {
    const frameId = view.registration?.frameId
    if (referenceFrameId !== undefined && frameId !== undefined && frameId !== referenceFrameId)
      throw new Error(`REGISTRATION_FRAME_MISMATCH: 视图 ${view.viewId} 的 frameId=${frameId} 与参考视 ${first.viewId} 的 ${referenceFrameId} 不同——不同坐标系不得配准`)
    const objectTag = view.registration?.objectTag
    if (referenceObjectTag !== undefined && objectTag !== undefined && objectTag !== referenceObjectTag) {
      excluded.push({ viewId: view.viewId, reason: "object-tag-mismatch", field: "objectTag" })
      return false
    }
    if (targetEra !== undefined) {
      const captureTime = view.registration?.captureTime
      // 缺失 ⇒ 不排除、不推断（"没有这个事实"不等于"不匹配"）
      if (captureTime !== undefined && !matchesEra(captureTime, targetEra)) {
        excluded.push({ viewId: view.viewId, reason: "era-mismatch", field: "captureTime" })
        return false
      }
    }
    return true
  })
  const eraExclusion: EraExclusion = targetEra === undefined ? "not-declared" : "applied:targetEra"
  const metricAllowed = input.units === "meter" && input.views.every(view => view.anchor !== undefined)
  const blocked = metricAllowed ? undefined : `无米制锚点：units=${input.units}，views 里 ${input.views.filter(view => !view.anchor).map(view => view.viewId).join("、") || "(全部)"} 没有 scaleAnchor ⇒ 只输出相对配准，**不宣称绝对（米制）精度**`
  const tol = toleranceFor(first.intrinsics, first.depthMeanM)
  const make = (view: { viewId: string }, run: ReturnType<typeof registerPointClouds>): RegistrationReport => {
    // 配对不足 ⇒ 可判定失败：不给残差/变换（N331；insufficient-pairs 判定优先于 metric/relative 降级说明）
    if (run.failure) {
      return { viewId: view.viewId, metric: Boolean(metricAllowed), verdict: "insufficient-pairs", transform: null, iterations: run.iterations, pairs: run.pairs, residuals: null, residualsOtherMode: null, mode: run.mode, toleranceM: tol.toleranceM, toleranceSource: tol.source, failure: run.failure, ...(blocked ? { blocked } : {}) }
    }
    const primary = residualStats(run.mode === "point-to-plane" ? run.residualsPointToPlaneM : run.residualsM)
    const secondary = residualStats(run.mode === "point-to-plane" ? run.residualsM : run.residualsPointToPlaneM)
    const within = primary !== null && primary.medianM <= tol.toleranceM
    return {
      viewId: view.viewId,
      metric: Boolean(metricAllowed),
      verdict: !metricAllowed ? "relative-only" : within ? "within-tolerance" : "outside-tolerance",
      transform: run.transform, iterations: run.iterations, pairs: run.pairs, residuals: primary, residualsOtherMode: secondary, mode: run.mode,
      toleranceM: tol.toleranceM, toleranceSource: tol.source,
      // 配对足够但跑满轮数仍未达既有容差判据 ⇒ 可判定失败"不收敛"（读数如实保留，但不得当成功结果用；N331）
      ...(metricAllowed && primary !== null && !within ? { failure: { code: "REGISTRATION_NO_CONVERGENCE" as const, medianM: primary.medianM, toleranceM: tol.toleranceM } } : {}),
      ...(blocked ? { blocked } : {}),
    }
  }
  const mode: ResidualMode = input.options?.residualMode ?? "point-to-point"
  const reference: RegistrationReport = { viewId: first.viewId, metric: Boolean(metricAllowed), verdict: metricAllowed ? "within-tolerance" : "relative-only", transform: IDENTITY_TRANSFORM, iterations: 0, pairs: first.points.length / 3, residuals: null, residualsOtherMode: null, mode, toleranceM: tol.toleranceM, toleranceSource: tol.source, ...(blocked ? { blocked } : {}) }
  const others = candidates.map(view => make(view, registerPointClouds(view.points, first.points, input.options)))
  return { reference, others, metric: Boolean(metricAllowed), excluded, eraExclusion, ...(blocked ? { blocked } : {}) }
}

/** 深度网格 → 三角面（米制世界坐标；给 2×2 有效像素四边形两个三角形）。
 * 失败域语义（N331）：无效深度像素（NaN/Inf/非正值，与 `depthToPoints` 同一有效域）**跳过**——不产生顶点/三角形，顶点数 == 有效像素数。 */
export function meshFromDepth(depth: PointSet, width: number, height: number, k: Intrinsics, transform: RigidTransform = IDENTITY_TRANSFORM): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = []
  const indexOf = new Int32Array(width * height).fill(-1)
  for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
    const z = depth[v * width + u]!
    if (!(z > 0) || !Number.isFinite(z)) continue // 无效深度（NaN/Inf/非正值）：跳过，不让 Inf 经 0×Inf 污染成 NaN 顶点
    const p = apply(transform, ((u - k.cx) * z) / k.fx, ((v - k.cy) * z) / k.fy, z)
    indexOf[v * width + u] = positions.length / 3
    positions.push(p[0], p[1], p[2])
  }
  const indices: number[] = []
  for (let v = 0; v + 1 < height; v++) for (let u = 0; u + 1 < width; u++) {
    const a = indexOf[v * width + u]!, b = indexOf[v * width + u + 1]!, c = indexOf[(v + 1) * width + u]!, d = indexOf[(v + 1) * width + u + 1]!
    if (a < 0 || b < 0 || c < 0 || d < 0) continue
    indices.push(a, c, b, b, c, d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

export function mergeMeshes(parts: Array<{ positions: Float32Array; indices: Uint32Array }>): { positions: Float32Array; indices: Uint32Array; faces: number } {
  const positions: number[] = []
  const indices: number[] = []
  for (const part of parts) {
    const offset = positions.length / 3
    for (let i = 0; i < part.positions.length; i++) positions.push(part.positions[i]!)
    for (let i = 0; i < part.indices.length; i++) indices.push(part.indices[i]! + offset)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces: indices.length / 3 }
}

/** 极简 glTF 2.0 二进制（POSITION + 索引，无材质）：融合产物的落盘格式。
 * 失败域语义（N331）：**拒绝写出 NaN/Inf 顶点**——明确报错 `GLB_NON_FINITE_VERTEX`（不静默剔除，产物几何/bbox 不得带非有限值）。 */
export function writeGlbMesh(path: string, positions: Float32Array, indices: Uint32Array): { bytes: number; faces: number } {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i]!)) throw new Error(`GLB_NON_FINITE_VERTEX: 顶点 ${Math.floor(i / 3)} 的第 ${i % 3} 个分量是 ${String(positions[i])}——NaN/Inf 顶点拒绝写出`)
  }
  const vertexBytes = positions.byteLength
  const indexBytes = indices.byteLength
  const pad = (n: number): number => (4 - (n % 4)) % 4
  const indexPadding = pad(indexBytes)
  const binary = Buffer.concat([Buffer.from(positions.buffer, positions.byteOffset, vertexBytes), Buffer.alloc(indexPadding), Buffer.from(indices.buffer, indices.byteOffset, indexBytes)])
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length / 3; i++) for (let axis = 0; axis < 3; axis++) {
    const value = positions[i * 3 + axis]!
    if (value < min[axis]!) min[axis] = value
    if (value > max[axis]!) max[axis] = value
  }
  const json = {
    asset: { version: "2.0", generator: "lyapunov-photo-registration/N312" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexBytes, target: 34962 },
      { buffer: 0, byteOffset: vertexBytes + indexPadding, byteLength: indexBytes, target: 34963 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
  }
  const jsonBuffer = Buffer.from(JSON.stringify(json), "utf8")
  const jsonPadding = pad(jsonBuffer.byteLength)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBuffer.byteLength + jsonPadding + 8 + binary.byteLength, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonBuffer.byteLength + jsonPadding, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4) // "JSON"
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binary.byteLength, 0)
  binHeader.writeUInt32LE(0x004e4942, 4) // "BIN"
  const glb = Buffer.concat([header, jsonHeader, jsonBuffer, Buffer.alloc(jsonPadding, 0x20), binHeader, binary])
  writeFileSync(path, glb)
  return { bytes: glb.byteLength, faces: indices.length / 3 }
}
