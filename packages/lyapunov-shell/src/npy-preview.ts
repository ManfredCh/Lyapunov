/**
 * P7A2：窄 NPY 显示辅助（相机轴向 Z 深度 / LiDAR range 的**真实**热图来源）。
 *
 * 存在理由：Camera 面板此前只能下载 NPY，看不到相机深度；把它重命名成 LiDAR 或拿占位热图冒充都违反 R-005。
 * 这里只做一件窄事——把原生 worker 真正落盘的 `.npy`（`np.save` 产物）解出来，按**具名**颜色规则画到 Canvas。
 *
 * 诚实边界（有意不做的）：
 *  · 只认实际原生形状：`<f4` / `<f8`、little-endian、二维、C 顺序。`>f4`（大端）、非浮点 dtype、`fortran_order=True`、
 *    一维/三维、截断正文一律**显式失败**，不猜、不补齐、不换字节序重读——读错字节序会把真实米数画成假图。
 *  · 不引入通用科学计算栈：解码只提升为 `Float64Array`，NaN/±Inf 原样保留（LiDAR 无返回以 NaN 落盘）。
 *  · 不是像素级对齐/相减：相机是沿光轴 Z 的欧氏量，LiDAR 是沿射线的欧氏量，两套投影不同，只做视觉并列与分源图例。
 */

/** 原生写入的小端浮点 dtype（`np.save` 在 x86 上实际写 `<f4`/`<f8`）。 */
export type NpyDtype = 'f4' | 'f8'

/** 解出的二维数组：`index = row * width + column`（C 顺序，与 NPY 头声明一致）。 */
export interface NpyArray {
  dtype: NpyDtype
  /** NPY 头里的 shape 原文（如实回显，不参与渲染换算）。 */
  declaredShape: string
  /** [rows, columns]。 */
  shape: [number, number]
  width: number
  height: number
  /** 逐元素值；float32/float64 都提升为 double，NaN/±Inf 原样保留。 */
  values: Float64Array
}

/** 失败码是稳定判据（测试与 UI 都读它），不靠错误文案猜。 */
export type NpyFormatCode =
  | 'NPY_MAGIC_INVALID'
  | 'NPY_VERSION_UNSUPPORTED'
  | 'NPY_HEADER_INVALID'
  | 'NPY_DTYPE_UNSUPPORTED'
  | 'NPY_BIG_ENDIAN'
  | 'NPY_FORTRAN_ORDER'
  | 'NPY_SHAPE_UNSUPPORTED'
  | 'NPY_TRUNCATED'

export class NpyFormatError extends Error {
  code: NpyFormatCode
  constructor(code: NpyFormatCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'NpyFormatError'
    this.code = code
  }
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

const fail = (code: NpyFormatCode, message: string): never => { throw new NpyFormatError(code, message) }

const asBytes = (input: ArrayBuffer | Uint8Array): Uint8Array => input instanceof Uint8Array ? input : new Uint8Array(input)

const parseShape = (shapeText: string): number[] => {
  const parts = shapeText.split(',').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) fail('NPY_HEADER_INVALID', 'shape 元组为空')
  return parts.map(part => {
    if (!/^\d+$/.test(part)) fail('NPY_HEADER_INVALID', `shape 元素不是非负整数: ${part}`)
    return Number(part)
  })
}

/**
 * 解码一个原生 NPY 缓冲区。只接受二维 little-endian float32/float64。
 * @throws {NpyFormatError} 带稳定 code；调用方据此如实显示，而不是画一张假图。
 */
export function decodeNpy(input: ArrayBuffer | Uint8Array): NpyArray {
  const bytes = asBytes(input)
  if (bytes.byteLength < 10 || bytes[0] !== 0x93 || bytes[1] !== 0x4e || bytes[2] !== 0x55 || bytes[3] !== 0x4d || bytes[4] !== 0x50 || bytes[5] !== 0x59) {
    return fail('NPY_MAGIC_INVALID', '不是 NPY 文件（缺少 93 4E 55 4D 50 59 魔数）')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const major = bytes[6]!, minor = bytes[7]!
  let headerLength: number, headerStart: number
  if (major === 1) { headerLength = view.getUint16(8, true); headerStart = 10 }
  else if (major === 2 || major === 3) { headerLength = view.getUint32(8, true); headerStart = 12 }
  else return fail('NPY_VERSION_UNSUPPORTED', `不支持的 NPY 版本 ${major}.${minor}`)
  if (headerStart + headerLength > bytes.byteLength) return fail('NPY_HEADER_INVALID', 'NPY 头长度越过文件末尾')
  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLength))
  const descr = /'descr'\s*:\s*'([^']*)'/.exec(header)?.[1]
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1]
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1]
  if (descr === undefined || fortran === undefined || shapeMatch === undefined) return fail('NPY_HEADER_INVALID', 'NPY 头缺少 descr / fortran_order / shape')
  const dtypeMatch = /^([<>=|])([a-zA-Z])(\d+)$/.exec(descr)
  if (!dtypeMatch) return fail('NPY_DTYPE_UNSUPPORTED', `无法解析 descr: ${descr}`)
  const [, byteOrder, kind, widthText] = dtypeMatch
  if (byteOrder === '>') return fail('NPY_BIG_ENDIAN', `不支持大端 dtype ${descr}（原生产物为小端）`)
  if (byteOrder !== '<' || kind !== 'f' || (widthText !== '4' && widthText !== '8')) return fail('NPY_DTYPE_UNSUPPORTED', `不支持的 dtype ${descr}（只认 <f4 / <f8）`)
  if (fortran !== 'False') return fail('NPY_FORTRAN_ORDER', 'fortran_order=True：列优先二维数组不支持（原生产物为 C 顺序）')
  const shape = parseShape(shapeMatch)
  if (shape.length !== 2) return fail('NPY_SHAPE_UNSUPPORTED', `只支持二维 shape，收到 ${shape.length} 维 (${shape.join(', ')})`)
  const [height, width] = shape as [number, number]
  if (height < 1 || width < 1) return fail('NPY_SHAPE_UNSUPPORTED', `shape 含非正维度 (${shape.join(', ')})`)
  const dtype: NpyDtype = widthText === '4' ? 'f4' : 'f8'
  const itemSize = dtype === 'f4' ? 4 : 8
  const count = height * width
  const dataStart = headerStart + headerLength
  if (dataStart + count * itemSize > bytes.byteLength) return fail('NPY_TRUNCATED', `正文字节不足：需要 ${count * itemSize}，只有 ${bytes.byteLength - dataStart}`)
  const values = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    values[index] = dtype === 'f4' ? view.getFloat32(dataStart + index * 4, true) : view.getFloat64(dataStart + index * 8, true)
  }
  return { dtype, declaredShape: `(${shape.join(', ')})`, shape: [height, width], width, height, values }
}

export interface NpyStats {
  count: number
  finiteCount: number
  nanCount: number
  posInfCount: number
  negInfCount: number
  /** 统计量只对有限值计算；没有有限值时是 undefined（不拿 0 冒充）。 */
  min?: number
  max?: number
  mean?: number
}

/** 对解出的值做诚实统计：有限值参与 min/max/mean，NaN/±Inf 分开计数。 */
export function npyStats(values: ArrayLike<number>): NpyStats {
  let finiteCount = 0, nanCount = 0, posInfCount = 0, negInfCount = 0, min = Infinity, max = -Infinity, sum = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (Number.isNaN(value)) { nanCount++; continue }
    if (value === Infinity) { posInfCount++; continue }
    if (value === -Infinity) { negInfCount++; continue }
    finiteCount++; sum += value
    if (value < min) min = value
    if (value > max) max = value
  }
  return {
    count: values.length, finiteCount, nanCount, posInfCount, negInfCount,
    ...(finiteCount > 0 ? { min, max, mean: sum / finiteCount } : {}),
  }
}

/** 具名颜色规则：id/说明/单位都随图例显示，避免把两种测量语义混成一个图例。 */
export interface NpyColorRule {
  id: string
  zh: string
  en: string
  units: 'm'
  /** 固定的归一化上限（米）。给了就用 [0, spanM]；不给则用有限值 min/max。 */
  spanM?: number
}

/**
 * 相机深度：沿光轴 Z 的轴向米制距离，近亮远暗（灰度）。有限值按 [min, max] 做对数映射以保留近景层次
 * （近端 ≤0 时退化为线性）；min/max 与颜色都要能从原数组复算。与 LiDAR 的绿→红射线欧氏 range 是两种语义。
 */
export const CAMERA_DEPTH_COLOR_RULE: NpyColorRule = {
  id: 'camera-axial-z-gray',
  zh: '灰度：近端白、远端黑；有限值按 [min, max] 对数映射（近端 ≤0 退化线性）',
  en: 'gray: near white, far black; finite values log-mapped over [min, max] (linear fallback when near ≤ 0)',
  units: 'm',
}

/**
 * LiDAR range：沿射线欧氏距离，复用 worker `preview.colorRule` 的比例色（R=255t、G=255(1−t)、B=64）
 * 与声明量程 `rangeM`；无返回（NaN/±Inf）用**独立**洋红，不落成 0 米。
 */
export const LIDAR_RANGE_COLOR_RULE: NpyColorRule = {
  id: 'lidar-range-euclidean-ratio',
  zh: '红→绿：R=255t、G=255(1−t)、B=64，t=clamp(range/量程,0,1)；无返回独立洋红',
  en: 'red→green: R=255t, G=255(1−t), B=64 with t=clamp(range/span,0,1); no-return is separate magenta',
  units: 'm',
}

/** 非有限像素（NaN/±Inf = LiDAR 无返回/无效）的独立颜色；绝不与 0 米混淆。 */
export const NPY_INVALID_RGBA: readonly [number, number, number, number] = [255, 0, 255, 255]

export interface NpyImage {
  ruleId: string
  width: number
  height: number
  rgba: Uint8ClampedArray
  /** 归一化用的实际区间（米），渲染时与图例一致。 */
  spanMin?: number
  spanMax?: number
  /** 有限但越出归一化区间的像素数（用固定 spanM 时可能出现）。 */
  belowMin: number
  aboveMax: number
  /** 非有限像素数（无返回/无效），显示为独立颜色。 */
  invalid: number
}

const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value

/**
 * 把解出的数组按具名规则画成 RGBA（纯函数，便于单测复算）。
 * @throws {NpyFormatError} 数据非有限且规则无法给区间时仍照常渲染（invalid 像素），不抛。
 */
export function colorizeNpy(array: NpyArray, rule: NpyColorRule, options: {spanM?: number} = {}): NpyImage {
  const { values, width, height } = array
  const stats = npyStats(values)
  const fixedSpan = options.spanM !== undefined && Number.isFinite(options.spanM) && options.spanM > 0 ? options.spanM : rule.spanM
  const spanMin = fixedSpan === undefined ? (stats.finiteCount > 0 ? stats.min! : undefined) : 0
  const spanMax = fixedSpan === undefined ? (stats.finiteCount > 0 ? stats.max! : undefined) : fixedSpan
  const span = spanMin !== undefined && spanMax !== undefined ? spanMax - spanMin : 0
  const rgba = new Uint8ClampedArray(width * height * 4)
  let invalid = 0, belowMin = 0, aboveMax = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    const offset = index * 4
    if (!Number.isFinite(value)) {
      invalid++
      rgba[offset] = NPY_INVALID_RGBA[0]; rgba[offset + 1] = NPY_INVALID_RGBA[1]; rgba[offset + 2] = NPY_INVALID_RGBA[2]; rgba[offset + 3] = NPY_INVALID_RGBA[3]
      continue
    }
    let t = 0
    if (span > 0) {
      if (value < spanMin!) { belowMin++; t = 0 }
      else if (value > spanMax!) { aboveMax++; t = 1 }
      // 相机 Depth 覆盖近景到远背景（量级可达百倍），用对数压暗远端才看得清近处层次；
      // 近端 ≤0 时对数无定义，退化为线性。LiDAR 用固定量程，保持 worker preview 的线性比例。
      else if (rule.id === CAMERA_DEPTH_COLOR_RULE.id && spanMin! > 0) t = clamp01(Math.log(value / spanMin!) / Math.log(spanMax! / spanMin!))
      else t = clamp01((value - spanMin!) / span)
    }
    let red: number, green: number, blue = 64
    if (rule.id === CAMERA_DEPTH_COLOR_RULE.id) { const gray = Math.round(255 * (1 - t)); red = gray; green = gray; blue = gray }
    else { red = Math.round(255 * t); green = Math.round(255 * (1 - t)) }
    rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue; rgba[offset + 3] = 255
  }
  return { ruleId: rule.id, width, height, rgba, spanMin, spanMax, belowMin, aboveMax, invalid }
}

/**
 * 该 NPY 是否属于当前浏览器字节序。仅用于诊断显示，不改变解码路径：
 * 我们**要求**产物是小端（`<f4`/`<f8`），大端会在 `decodeNpy` 直接失败而不是被静默换序。
 */
export function npyHostIsLittleEndian(): boolean { return LITTLE_ENDIAN_HOST }
