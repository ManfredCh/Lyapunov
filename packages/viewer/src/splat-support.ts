/**
 * splat/SPZ 预览的**成因分类**（DEV-025）：把"格式不支持 / 解码器缺失 / 依赖缺失 / 配准或轴向 / 正常"
 * 分开，让回执与警告说的是**具体成因**，而不是一句通用失败。
 *
 * 这里只做判定，不做 IO、不引入任何新依赖：输入是文件名、依赖是否可用、解码结果/异常文本这三类事实。
 * 纯函数 ⇒ 既能在浏览器里被 Viewer 调用，也能在 Node 侧的矩阵脚本里逐文件跑（同一份判据，不写第二套）。
 *
 * DEV-PROJ-01：输入侧的**格式**不再只从文件名字符串取。出站投影把 `uri` 换成不可逆标记
 * `res:<指纹>`（`lyapunov-contracts/src/product-paths.ts:134-147`），文件名里的扩展名就此消失，
 * 于是 `assessSplatInput` 一律判 `unsupported-format`、3DGS 场景整块消失。格式的**第一判据**改为
 * 登记声明（`Representation.mimeType`，投影不动它），定位符只作回落——见 `assessSplatDeclaration`。
 */
import { assetFormatOf, hasLocatorScheme } from "./asset-locator.ts"

/** 与成因分类一一对应的稳定取值（回执/警告里逐字用这几个词）。 */
export type SplatCause = 'ok' | 'unsupported-format' | 'decoder-missing' | 'dependency-missing' | 'registration-or-axis'

/** 扩展名 → spark 的文件类型名（`SplatFileType` 的键）。**唯一一份**，Viewer 与矩阵脚本共用。 */
export const SPLAT_FILE_TYPE_NAMES: Record<string, string> = {
  ply: 'PLY', spz: 'SPZ', splat: 'SPLAT', ksplat: 'KSPLAT', sog: 'PCSOGSZIP', rad: 'RAD',
}

export interface SplatInputAssessment {
  extension: string
  fileTypeName: string | null
  supported: boolean
  cause: SplatCause
  detail: string
}

/** 纯 TS 解码器（`scene-kit/src/splat-bounds.ts`）**真的有分支**的扩展名——与 spark 的类型表不是一回事。 */
export const TS_DECODER_EXTENSIONS = ['spz', 'splat', 'ply'] as const

/** 文件名 → 扩展名（小写，无点）。取不到就给空串，不猜。 */
export function splatExtensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase()
}

/**
 * 输入侧判定：扩展名 + 预览依赖是否可用。
 * · 扩展名不在 spark 类型表里 → `unsupported-format`（明确说"没这个格式的解码器分支"）；
 * · 在类型表里但预览依赖（`@sparkjsdev/spark`）不可用 → `dependency-missing`（明确点名依赖）；
 * · 预览依赖在、格式也认识 → 交给解码结果判定（`ok` 只是"可以尝试"，不代表已经出图）。
 *
 * **第一判据是登记声明**（`mimeType`），定位符（文件名/URI）只作回落：投影后的 `uri` 是
 * `res:<指纹>`，从它取不到扩展名，但 `Representation.mimeType` 不受投影影响。
 */
export function assessSplatInput(filename: string, options: { dependencyAvailable: boolean }): SplatInputAssessment {
  return assessSplatDeclaration({ locator: filename }, options)
}

/**
 * 与 `assessSplatInput` 同一套判据，但输入是**声明**而不是一个字符串：
 * `{ mimeType, locator }` 里 `mimeType` 优先（`application/x-spz` → `spz`），
 * 只有声明缺失或太泛（`application/octet-stream`）时才回落到定位符的真名后缀。
 *
 * 判不出格式时，detail 还要说清**是"这个格式不支持"还是"根本判不出格式"**：定位符是不可逆标记
 * 且登记里没有 mimeType 时，那是投影把语义拿掉了，不是文件真的没有扩展名——两者处置完全不同。
 */
export function assessSplatDeclaration(declaration: { mimeType?: unknown; locator?: unknown }, options: { dependencyAvailable: boolean }): SplatInputAssessment {
  const extension = assetFormatOf(declaration) ?? ''
  const fileTypeName = SPLAT_FILE_TYPE_NAMES[extension] ?? null
  if (!fileTypeName) {
    const unsupported = `扩展名「.${extension || '(无)'}」不在 splat 预览支持表里（支持：${Object.keys(SPLAT_FILE_TYPE_NAMES).map(item => `.${item}`).join('/')}）`
    // 标记且无声明 ⇒ 判据缺失，不是"格式不认识"：原因写进 detail，别让它读成后者。
    const marker = !extension && !assetFormatOf({ mimeType: declaration.mimeType, locator: '' }) && hasLocatorScheme(declaration.locator)
    return {
      extension, fileTypeName: null, supported: false, cause: 'unsupported-format',
      detail: marker ? `${unsupported}；定位符是不可逆标记（出站投影产物）且登记里没有可用的 mimeType ⇒ 判不出格式，不是文件真的没有扩展名` : unsupported,
    }
  }
  if (!options.dependencyAvailable) {
    return {
      extension, fileTypeName, supported: false, cause: 'dependency-missing',
      detail: `预览需要依赖 @sparkjsdev/spark（它会为 .${extension} 提供 ${fileTypeName} 解码器），当前不可用`,
    }
  }
  return { extension, fileTypeName, supported: true, cause: 'ok', detail: `按 ${fileTypeName} 交给 splat 解码器` }
}

/**
 * 解码失败 → 成因。判据只看异常文本里的**稳定事实**（模块缺失/网络/格式魔数/截断），不做关键字猜测之外的推断。
 * 未归类的失败给 `unsupported-format`（文件按当前形态解析不了），detail 保留原始文本便于回查。
 */
export function assessSplatFailure(error: unknown, options: { extension: string; dependencyAvailable: boolean }): { cause: SplatCause; detail: string } {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (!options.dependencyAvailable || /cannot find module|failed to resolve module|is not a function|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|dynamically imported/i.test(text))
    return { cause: 'dependency-missing', detail: `依赖/模块不可用：${text.slice(0, 300)}` }
  if (/404|not found|failed to fetch|network|ENOENT|ECONNREFUSED/i.test(text))
    return { cause: 'dependency-missing', detail: `资源取不到（网络/文件缺失）：${text.slice(0, 300)}` }
  if (/unsupported|unknown file ?type|invalid (file|header|magic)|unexpected end|bad magic|corrupt|gunzip/i.test(text))
    return { cause: 'unsupported-format', detail: `文件不是可解析的 .${options.extension || '(未知)'} 实例：${text.slice(0, 300)}` }
  return { cause: 'unsupported-format', detail: `解码失败（未归类，原文保留）：${text.slice(0, 300)}` }
}

/**
 * 解码**成功**之后的判定：splat 数为 0 ⇒ 解码器给了空结果（`decoder-missing`：等于这个格式没有真正可用的
 * 解码分支）；包围盒非有限或退化 ⇒ `registration-or-axis`（配准/轴向问题，不是"没渲染"）。
 */
export function assessSplatDecoded(input: { numSplats: number | null; bounds: { min: number[]; max: number[] } | null }): { cause: SplatCause; detail: string } {
  if (input.numSplats !== null && input.numSplats <= 0)
    return { cause: 'decoder-missing', detail: '解码器返回 0 个高斯点：该格式没有真正可用的解码分支' }
  const bounds = input.bounds
  if (!bounds || bounds.min.length < 3 || bounds.max.length < 3)
    return { cause: 'registration-or-axis', detail: '取不到包围盒：无法判定位姿/尺度（配准或轴向问题）' }
  const finite = [...bounds.min, ...bounds.max].every(value => Number.isFinite(value))
  if (!finite)
    return { cause: 'registration-or-axis', detail: `包围盒含非有限值：min=${JSON.stringify(bounds.min)} max=${JSON.stringify(bounds.max)}` }
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]!)
  if (size.every(value => value === 0))
    return { cause: 'registration-or-axis', detail: `包围盒退化（三轴尺寸全 0）：min=${JSON.stringify(bounds.min)}` }
  return { cause: 'ok', detail: `包围盒 ${size.map(value => value.toFixed(3)).join('×')} m` }
}

/** 成因 → 既有警告通道里用的稳定码（`VIEWER_SPLAT_<码>`），与回执里的分类词一一对应。 */
export function splatWarningCode(cause: SplatCause): string {
  return `VIEWER_SPLAT_${cause.toUpperCase().replace(/-/g, '_')}`
}
