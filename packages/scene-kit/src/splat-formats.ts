/**
 * 3DGS 直链的**内容真实性校验**（不是扩展名判据）：只读文件头/流式解一小段，绝不整份读进内存。
 *
 * 为什么单独一条：`.ply`/`.spz` 直链被 HTML 登录页/错误页/被中间层改写的响应顶替时，
 * 扩展名与 Content-Type 都可能撒谎（真实会话里旧模型就把 HTML 当 PLY 反复提交）。这里按**字节**判定：
 *  · `.spz` —— 裸流 magic `NGSP`，或 gzip 容器内解出的前 4 字节是 `NGSP`（流式解，只取 4 字节）；
 *  · `.ply` —— `ply` 明文头 + `format ... 1.0` + `element vertex N`，并按属性判是否高斯（f_dc_/scale_/rot_/opacity）；
 *  · `.splat` —— 无 magic，只能按"记录长度 32 的整数倍 + 不是 HTML/JSON"判，是三者里最弱的判据（如实记录）。
 * HTML/JSON 一律以 `ASSET_ACQUISITION_MIME_REJECTED` 拒绝；容器与预期不符（GLB/ZIP）单独报，不静默当模型。
 */
import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { createGunzip } from "node:zlib"
import { inspectSogZipFile } from "./sog-zip.ts"

/** `parseAsset` 认得的 3DGS 扩展名（与 formats.ts 的 splatExtensions 同集合）。 */
export const SPLAT_EXTENSIONS = [".ply", ".spz", ".sog", ".rad", ".splat", ".ksplat"] as const

/** 本模块有字节级校验、可直接流式落地的格式；rad/ksplat 仍明确不支持。 */
export const STREAMABLE_SPLAT_EXTENSIONS = [".ply", ".spz", ".splat", ".sog"] as const

export type StreamableSplatFormat = "spz" | "ply" | "splat" | "sog"

export interface SplatFileFact {
  format: StreamableSplatFormat
  /** 是否是高斯泼溅（含位置以外的颜色/不透明度/尺度/旋转/SH 属性）；`.spz` 与 `.splat` 按生态惯例恒为 true。 */
  gaussian: boolean
  /** `.ply` 头里的 element vertex 计数；其它格式给不出就不写。 */
  vertexCount?: number
  /** SOG meta.json 的高斯数；不把它塞进 PLY 专用的 vertexCount。 */
  gaussianCount?: number
  /** `.spz` 是否 gzip 容器（裸流为 false）。 */
  compressed?: boolean
}

/** 扩展名 → 是否 3DGS。仅作路由提示，最终判据仍是字节。 */
export function isSplatExtension(pathOrUrl: string): boolean {
  const clean = pathOrUrl.split(/[?#]/, 1)[0]!.toLowerCase()
  const match = /(\.[a-z0-9]+)$/.exec(clean)
  return match !== null && (SPLAT_EXTENSIONS as readonly string[]).includes(match[1]!)
}

/** 扩展名 → 本模块可校验的格式；rad/ksplat 返回 undefined。 */
export function streamableSplatFormatOf(pathOrUrl: string): StreamableSplatFormat | undefined {
  const clean = pathOrUrl.split(/[?#]/, 1)[0]!.toLowerCase()
  const match = /\.(ply|spz|splat|sog)$/.exec(clean)
  return match ? match[1] as StreamableSplatFormat : undefined
}

/** 显式 formatHint 的运行时收窄（JSON 边界的值必须真正校验，不靠 TS 类型）。 */
export function isStreamableSplatFormat(value: unknown): value is StreamableSplatFormat {
  return value === "ply" || value === "spz" || value === "splat" || value === "sog"
}

/**
 * 从响应 `Content-Disposition` 的 filename 取格式**提示**（不是判据）：服务端声明的附件名常带真实扩展名，
 * 供无扩展名 URL 的场景做路由提示；解析不出或不是三种可校验格式就返回 undefined。最终仍以字节校验为准。
 */
export function splatFormatFromContentDisposition(value: string | string[] | undefined): StreamableSplatFormat | undefined {
  const text = Array.isArray(value) ? value[0] : value
  if (!text) return undefined
  const filename = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(text)?.[1]
  if (!filename) return undefined
  let decoded = filename.trim()
  try { decoded = decodeURIComponent(decoded) } catch { /* 不是合法编码就按原样看扩展名 */ }
  return streamableSplatFormatOf(decoded)
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function rejection(what: string, sample: string): Error {
  return new Error(`ASSET_ACQUISITION_MIME_REJECTED: 取回的内容是${what}（开头 ${JSON.stringify(sample.slice(0, 48))}），不是 3DGS 模型。可采取的动作：核对链接是不是资源文件直链；登录页/错误页/分享页 HTML 不能当模型导入。`)
}

/** 前若干字节以 `<`/`{`/`[`（允许 BOM 与空白）开头 ⇒ 按文本/HTML 拒绝，不看扩展名。 */
function leadingTextKind(bytes: Buffer): string | undefined {
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048))
  // 含 NUL 的样本按二进制处理：合法的 HTML/JSON 文本头里不会有 NUL，而 `.splat` 的浮点字节可能有 0x7b('{')。
  if (sample.includes(0)) return undefined
  const text = sample.toString("utf8").replace(/^\uFEFF/, "").trimStart()
  if (/^<!doctype\s+html/i.test(text)) return "HTML 文档"
  if (/^<html[\s>]/i.test(text)) return "HTML 文档"
  if (/^<!--/.test(text)) return "HTML 注释"
  if (/^<\?xml/i.test(text)) return "XML 文档"
  if (/^<svg[\s>]/i.test(text)) return "SVG 文档"
  if (/^\{/.test(text) || /^\[/.test(text)) return "JSON 文档"
  return undefined
}

/** 流式解 gzip 只取解压前 4 字节（不整份 gunzip；超大 .spz 也不会因此占用内存）。 */
async function gunzipMagic(path: string): Promise<number | undefined> {
  const input = createReadStream(path)
  const gunzip = createGunzip()
  let head = Buffer.alloc(0)
  let settled = false
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        if (settled) return
        settled = true
        input.destroy()
        gunzip.destroy()
        error ? reject(error) : resolve()
      }
      gunzip.on("data", (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        if (head.length >= 4) done()
      })
      gunzip.once("error", error => done(error))
      gunzip.once("end", () => done())
      input.once("error", error => done(error))
      input.pipe(gunzip)
    })
  } catch { return undefined }
  return head.length >= 4 ? head.readUInt32LE(0) : undefined
}

const PLY_GAUSSIAN_PROPERTY = /^property\s+\S+\s+(?:f_dc_\d+|f_rest_\d+|scale_\d+|rot_\d+|opacity)\b/m

function plyFact(bytes: Buffer): SplatFileFact {
  const text = bytes.toString("latin1")
  const end = text.match(/(?:^|\n)end_header\r?\n/)
  if (!/^ply\r?\n/.test(text) || !end) throw new Error("ASSET_ACQUISITION_INVALID_PLY: 不是完整的 PLY 头（缺 ply 魔数或 end_header）。可采取的动作：确认链接指向真正的 .ply 文件。")
  const header = text.slice(0, end.index! + end[0].length)
  if (!/^format\s+(?:binary_little_endian|binary_big_endian|ascii)\s+1\.0\s*$/m.test(header)) throw new Error("ASSET_ACQUISITION_INVALID_PLY: PLY 的 format 行不是受支持的 1.0 形态。可采取的动作：换一份标准 PLY。")
  const countText = header.match(/^element\s+vertex\s+(\d+)\s*$/m)?.[1]
  if (countText === undefined) throw new Error("ASSET_ACQUISITION_INVALID_PLY: PLY 头缺 element vertex。可采取的动作：确认这不是普通网格/点云之外的伪文件。")
  const vertexCount = Number(countText)
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) throw new Error("ASSET_ACQUISITION_INVALID_PLY: PLY 的顶点数无效。")
  return { format: "ply", gaussian: PLY_GAUSSIAN_PROPERTY.test(header), vertexCount }
}

/**
 * 读出并校验一个本地 3DGS 文件。失败一律抛**结构化错误**（不返回伪事实）：
 * HTML/JSON → `ASSET_ACQUISITION_MIME_REJECTED`（永久，不重试）；GLB/ZIP 容器 → `ASSET_ACQUISITION_CONTAINER_MISMATCH`；
 * 扩展名提示与真实字节不一致 → `ASSET_ACQUISITION_SPLAT_FORMAT_MISMATCH`；其它无法识别 → `ASSET_ACQUISITION_UNRECOGNIZED_SPLAT`。
 * `hint` 来自 URL/路径扩展名（`.spz`/`.ply`/`.splat`）；`.sog/.rad/.ksplat` 由调用方先拒绝，不走这里。
 */
export async function inspectSplatFile(path: string, hint?: StreamableSplatFormat, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<SplatFileFact> {
  options.signal?.throwIfAborted()
  const info = await stat(path).catch(error => { throw new Error(`ASSET_ACQUISITION_FILE_NOT_FOUND: 本地文件不存在：${path}（${messageOf(error)}）`) })
  if (!info.isFile()) throw new Error(`ASSET_ACQUISITION_NOT_A_FILE: 不是普通文件：${path}`)
  if (!info.size) throw new Error(`ASSET_ACQUISITION_EMPTY_FILE: 空文件：${path}`)
  const handle = await open(path, "r")
  let head: Buffer
  try {
    const raw = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0)
    head = raw.subarray(0, bytesRead)
  } finally { await handle.close() }

  const textKind = leadingTextKind(head)
  if (textKind) throw rejection(textKind, head.subarray(0, 48).toString("utf8"))
  if (head.length >= 12 && head.readUInt32LE(0) === 0x46546c67) throw new Error("ASSET_ACQUISITION_CONTAINER_MISMATCH: 内容是 GLB 容器，不是 3DGS 直链。可采取的动作：改用 scene_asset_acquire 的 GLB 入口（.glb 直链）。")
  const zip = head.length >= 4 && (head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50)
  if (zip && hint !== undefined && hint !== "sog") throw new Error("ASSET_ACQUISITION_CONTAINER_MISMATCH: 内容是 ZIP 容器，与 3DGS 格式提示不符。")

  let fact: SplatFileFact
  if (zip) {
    const sog = await inspectSogZipFile(path, options.maxBytes ?? info.size, options.signal)
    fact = { format: "sog", gaussian: true, gaussianCount: sog.count }
  }
  else if (head.length >= 4 && head.readUInt32LE(0) === 0x5053474e) fact = { format: "spz", gaussian: true, compressed: false }
  else if (head[0] === 0x1f && head[1] === 0x8b) {
    const magic = await gunzipMagic(path)
    if (magic !== 0x5053474e) throw new Error("ASSET_ACQUISITION_MIME_REJECTED: gzip 容器解出的内容不是 SPZ（NGSP magic 不符）。可采取的动作：换真正的 .spz 直链。")
    fact = { format: "spz", gaussian: true, compressed: true }
  }
  else if (/^ply\r?\n/.test(head.toString("latin1"))) fact = plyFact(head)
  // .splat 无 magic：只按"记录长度 32 的整数倍"判，判据最弱，且只在提示就是 .splat（或调用方没给提示）时采用。
  else if (info.size % 32 === 0 && (hint === undefined || hint === "splat")) fact = { format: "splat", gaussian: true }
  else throw new Error(`ASSET_ACQUISITION_UNRECOGNIZED_SPLAT: 前 ${head.length} 字节既不是 NGSP/gzip、不是 PLY 头，也不是 32 字节对齐的 .splat 记录。可采取的动作：确认链接是 .spz/.ply/.splat 资源直链；分享页请先用 scene_asset_resolve 解析。`)

  if (hint !== undefined && fact.format !== hint) throw new Error(`ASSET_ACQUISITION_SPLAT_FORMAT_MISMATCH: 扩展名提示 .${hint}，但按字节判是 .${fact.format}（不按扩展名将错就错）。可采取的动作：给出与内容一致的直链。`)
  return fact
}
