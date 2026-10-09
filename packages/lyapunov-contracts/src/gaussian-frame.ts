/**
 * 高斯泼溅文件里**由导出侧写死的首相机坐标约定**（纯数据/坐标 helper，浏览器与 Node 侧共用）。
 *
 * 为什么需要这条合同：3DGS 训练输出通常把世界刚体归一到"第一台相机"的坐标系，但"第一台相机"在不同
 * 工具链里的轴约定并不相同。文件一旦离开生成它的管线，消费端只能靠**明确的文件坐标标记**还原朝向，
 * 不能靠包围盒、不能猜、更不能让用户手工转 180°。这里只识别两种已终止、真正 Gaussian 的 PLY 头标记：
 *
 *  · `first_camera_c2w_v2`（旧合格 High / OpenCV 约定）：X 右、Y 下、Z 前；首相机原点、朝 +Z、up −Y。
 *  · `first_camera_opengl_v3`（新标准 High / OpenGL 约定）：X 右、Y 上、Z 后；首相机原点、朝 −Z、up +Y。
 *
 * 本模块**不**决定相机变换矩阵怎么装配（那属于各消费端），只回答两件可核对的事实：
 * 文件头里有没有一条、且仅一条已知坐标标记；以及该标记在**文件空间**里的首相机前向/上向单位向量。
 * 未知资产、坏头、正文里才出现的字符串、或同时出现两种 frame 的冲突件一律返回 `undefined`，
 * 让调用方沿用既有行为——识别失败绝不等于随便挑一个。
 */

/** 已知的高斯文件坐标约定。字符串即生产侧写入 PLY 头的精确标记值。 */
export type GaussianCameraFrame = 'first-camera-c2w-v2' | 'first-camera-opengl-v3'

/** `comment` 行的完整文本（含 `comment ` 前缀），与生产侧 `gaussian_ply_header` 逐字一致。 */
export const GAUSSIAN_CAMERA_FRAME_MARKERS: Readonly<Record<GaussianCameraFrame, string>> = Object.freeze({
  'first-camera-c2w-v2': 'comment Lyapunov idle coordinate_frame first_camera_c2w_v2',
  'first-camera-opengl-v3': 'comment Lyapunov idle coordinate_frame first_camera_opengl_v3',
})

/** 文件空间下的首相机视线方向与上方向（右手系，单位向量）。 */
export interface GaussianCameraBasis {
  forward: readonly [number, number, number]
  up: readonly [number, number, number]
}

export const GAUSSIAN_CAMERA_BASIS: Readonly<Record<GaussianCameraFrame, GaussianCameraBasis>> = Object.freeze({
  // OpenCV：看向 +Z，图像 up 是世界 −Y。
  'first-camera-c2w-v2': { forward: [0, 0, 1], up: [0, -1, 0] },
  // OpenGL：看向 −Z，up 是 +Y。
  'first-camera-opengl-v3': { forward: [0, 0, -1], up: [0, 1, 0] },
})

export function isGaussianCameraFrame(value: unknown): value is GaussianCameraFrame {
  return value === 'first-camera-c2w-v2' || value === 'first-camera-opengl-v3'
}

/** PLY 头只在开头；与既有 `formats.parseAsset` 的 64 KiB 头读取窗口同量级。 */
export const PLY_HEADER_SCAN_BYTES = 65536
/** 生产侧 `gaussian_ply_header` 写死的 14 个 float vertex 属性，按写入顺序。只有完整命中这一份布局
 *  的已终止头才可能自动识别 frame；未知的其它合法 PLY 仍由原 decoder/默认入口处理，不改判、不拦。 */
export const GAUSSIAN_PLY_PROPERTIES: readonly string[] = Object.freeze([
  'x', 'y', 'z',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
])
/** 生产侧实际生成的是 binary little endian（`format binary_little_endian 1.0`）。 */
const BINARY_LITTLE_ENDIAN_FORMAT = 'format binary_little_endian 1.0'
/** 坐标标记 comment 的统一前缀：`comment Lyapunov idle coordinate_frame <frame>`。 */
const COORDINATE_FRAME_PREFIX = 'comment Lyapunov idle coordinate_frame '
const END_HEADER_LINE = /^end_header[ \t]*\r?$/m
const ELEMENT_LINE = /^element\s+(\S+)\s+(\S+)$/
const PROPERTY_LINE = /^property\s+(\S+)\s+(\S+)$/

/** 把字节按 latin-1 逐字节转字符串：PLY 头是 ASCII，正文里的二进制不会被当成字符串规则匹配。 */
function latin1(bytes: Uint8Array, limit: number): string {
  const chars = new Array<string>(limit)
  for (let index = 0; index < limit; index += 1) chars[index] = String.fromCharCode(bytes[index]!)
  return chars.join('')
}

/**
 * 一个已终止 PLY 头的真实读数（只扫描 `end_header` 之前，正文永不参与）。
 *
 * 这是 frame 识别与 `formats.parseAsset` 的公共底座：属性只取 `element vertex` 段里**真实声明**的
 * `property` 行，comment 里恰好提到 `property float f_dc_0` 也绝不伪造成 Gaussian；`vertexCount` 只在
 * 唯一一个 `element vertex` 且为安全正整数时给出，重复 vertex 段或 0/非安全整数一律 `undefined`。
 */
export interface PlyHeaderScan {
  /** 唯一一个 vertex 段的顶点数（安全正整数）。 */
  vertexCount: number
  /** vertex 段里真实声明的属性行原文（`property <type> <name>`，按出现顺序）。 */
  propertyLines: readonly string[]
  /** `end_header` 之前的头行（已去首尾空白），供调用方读取 `format`/`comment`。 */
  lines: readonly string[]
}

/**
 * 扫描一个已终止 PLY 头。返回 `undefined` 表示头本身不可用（缺 `end_header`、非法 vertex 数、
 * 重复 vertex 段等），调用方据此沿用既有行为。
 */
export function scanPlyHeader(bytes: Uint8Array): PlyHeaderScan | undefined {
  if (bytes.length === 0) return undefined
  const limit = Math.min(bytes.length, PLY_HEADER_SCAN_BYTES)
  const text = latin1(bytes, limit)
  if (!text.startsWith('ply\n') && !text.startsWith('ply\r\n')) return undefined
  const end = END_HEADER_LINE.exec(text)
  if (!end) return undefined
  const lines = text.slice(0, end.index).split(/\r?\n/).map(line => line.trim())
  const propertyLines: string[] = []
  let vertexCount: number | undefined
  let inVertex = false
  for (const line of lines) {
    const element = ELEMENT_LINE.exec(line)
    if (element) {
      inVertex = element[1] === 'vertex'
      if (inVertex) {
        if (vertexCount !== undefined) return undefined
        const count = Number(element[2])
        if (!Number.isSafeInteger(count) || count <= 0) return undefined
        vertexCount = count
      }
      continue
    }
    if (inVertex && PROPERTY_LINE.test(line)) propertyLines.push(line)
  }
  if (vertexCount === undefined) return undefined
  return { vertexCount, propertyLines, lines }
}

/** 生产约定完整 Gaussian 头：binary little endian + 14 个 `property float` 按写入顺序。 */
function isProductionGaussianHeader(scan: PlyHeaderScan): boolean {
  if (!scan.lines.includes(BINARY_LITTLE_ENDIAN_FORMAT)) return false
  const canonical = GAUSSIAN_PLY_PROPERTIES.map(name => `property float ${name}`)
  return scan.propertyLines.length === canonical.length
    && scan.propertyLines.every((line, index) => line === canonical[index])
}

/** 严格识别出的生产 Gaussian 头事实：唯一坐标标记 + 同一次头扫描的安全顶点数。 */
export interface GaussianPlyFacts {
  /** 头里恰好一条、逐字等于已知标记的坐标约定。 */
  frame: GaussianCameraFrame
  /** 唯一一个 vertex 段的安全正整数顶点数；与 `formats.parseAsset` 写进 `metadata.vertexCount` 同源同判据。 */
  sourcePointCount: number
}

/**
 * 严格识别已终止的 Gaussian PLY 头里**唯一一条**已知坐标标记，并同时给出同一次扫描的安全顶点数。
 *
 * 判据逐条：
 *  1. 前 64 KiB 内必须以 `ply\n` 或 `ply\r\n` 开头；没有 `end_header` 行 ⇒ 头未终止，拒绝。
 *  2. 只检查 `end_header` **之前**的字节，正文（二进制或 ASCII）里的同一字符串永不参与匹配。
 *  3. 头里必须恰好一个 `element vertex <安全正整数>`，且 vertex 段真实声明生产约定的 14 个
 *     `property float`（x/y/z、f_dc_0..2、opacity、scale_0..2、rot_0..3），format 为
 *     `binary_little_endian`；comment 里提到 `property` 不算属性，普通网格/未知 PLY 不认。
 *  4. 全文恰有一条 `comment Lyapunov idle coordinate_frame …`；0 条、≥2 条（含同标记重复、
 *     未知 Lyapunov frame 与已知混用）都不自动识别。
 *  5. 那唯一一条必须逐字等于某个已知标记；前缀/后缀扩展（如 `..._v2_extra`）不匹配。
 *
 * 只有整套判据都通过才返回事实：`sourcePointCount` 直接取 `scanPlyHeader` 的安全正整数读数，
 * 0/超大/重复 `element vertex` 与任何未知/冲突头一律 `undefined`，调用方沿用既有行为。
 */
export function parseGaussianPlyFacts(bytes: Uint8Array): GaussianPlyFacts | undefined {
  const scan = scanPlyHeader(bytes)
  if (!scan || !isProductionGaussianHeader(scan)) return undefined
  const frameComments = scan.lines.filter(line => line.startsWith(COORDINATE_FRAME_PREFIX))
  if (frameComments.length !== 1) return undefined
  const marker = frameComments[0]!
  for (const [frame, value] of Object.entries(GAUSSIAN_CAMERA_FRAME_MARKERS) as Array<[GaussianCameraFrame, string]>) {
    if (marker === value) return { frame, sourcePointCount: scan.vertexCount }
  }
  return undefined
}

/** 只取严格识别出的坐标标记（判据与安全顶点数见 `parseGaussianPlyFacts`，同一次扫描）。 */
export function parseGaussianCameraFramePlyHeader(bytes: Uint8Array): GaussianCameraFrame | undefined {
  return parseGaussianPlyFacts(bytes)?.frame
}
