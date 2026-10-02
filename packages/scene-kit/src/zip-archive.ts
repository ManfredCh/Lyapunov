/**
 * 标准 ZIP 的最小读取器：解析中央目录、按需解压被点名的条目。用途只有一个——让资产获取
 * （asset-acquisition）能从本地/已下载的压缩包里取出 .glb／.gltf 及其 bin/纹理依赖。
 *
 * 这里**不做**通用解包器：不写盘、不建索引、不按扩展名猜条目用途、不递归解包。条目名边界、
 * 解压上限与错误码都由调用侧按同一条口径执行（与 environment-assets 的 include 路径规则一致）。
 * 支持 store(0)/deflate(8) 与 Zip64 扩展字段；加密、分卷与其它压缩方法一律明确拒绝，
 * 不做静默降级——解不开就说解不开。
 */
import { crc32, inflateRawSync } from "node:zlib"

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff
const EOCD_LENGTH = 22
const MAX_COMMENT = 0xffff
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_EOCD_MIN_LENGTH = 56

/** 中央目录里的一条文件记录；目录条目（名字以 "/" 结尾）不返回。 */
export interface ZipEntry {
  /** 中央目录里的原始条目名（未做 URL 解码；调用侧再按自己的口径归一/核对边界）。 */
  name: string
  /** 压缩方法：0=store，8=deflate。 */
  method: number
  compressedBytes: number
  uncompressedBytes: number
  /** 解压后字节的 CRC-32（中央目录声明值），读取时逐条核对。 */
  crc: number
  localHeaderOffset: number
}

function need(view: DataView, offset: number, length: number): void {
  if (offset < 0 || offset + length > view.byteLength) throw new Error(`ZIP_ARCHIVE_TRUNCATED: 需要 ${offset}+${length} 字节，文件只有 ${view.byteLength}`)
}

function uint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP_ARCHIVE_SIZE_UNSUPPORTED: ${value} 字节超出本机可表示范围`)
  return Number(value)
}

/** 结尾记录必须在文件末尾（注释长度自洽），否则文件被截断或尾部有附加数据。 */
function endOfCentralDirectory(view: DataView): number {
  const oldest = Math.max(0, view.byteLength - (EOCD_LENGTH + MAX_COMMENT))
  for (let offset = view.byteLength - EOCD_LENGTH; offset >= oldest; offset--) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue
    if (offset + EOCD_LENGTH + view.getUint16(offset + 20, true) === view.byteLength) return offset
  }
  throw new Error("ZIP_ARCHIVE_NOT_ZIP: 找不到 ZIP 中央目录结尾记录（文件不是 ZIP 或被截断）。可采取的动作：确认这个文件真的是 ZIP 压缩包。")
}

/** Zip64 扩展字段里被 sentinel（0xffffffff）截断的那几个值；没被截断的字段在 extra 里**没有字节**。 */
interface Zip64Values { uncompressed?: number; compressed?: number; offset?: number }

/**
 * 条目 extra 字段里的 Zip64 值：只解被 sentinel 标记的字段，并且**按字段名返回**，
 * 绝不按位置硬解——APPNOTE 4.5.3 规定这三个值按（uncompressed, compressed, offset）固定顺序出现，
 * 且只出现被 0xffffffff 截断的那些；若"只有 compressed 是 sentinel"，extra 里第 1 个 8 字节就是
 * compressed，按位置解会把 compressed 当成 uncompressed 用（长度校验与 CRC 都会跟着错）。
 * 被截断的字段在 extra 里缺字节 → 明确拒绝，不猜。
 */
function zip64Fields(view: DataView, start: number, length: number, needed: { uncompressed: boolean; compressed: boolean; offset: boolean }): Zip64Values {
  let cursor = start
  const end = start + length
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true)
    const size = view.getUint16(cursor + 2, true)
    cursor += 4
    if (cursor + size > end) break
    if (id === 0x0001) {
      const values: Zip64Values = {}
      let at = cursor
      const read = (field: keyof Zip64Values): void => {
        if (!needed[field]) return
        if (at + 8 > cursor + size) throw new Error(`ZIP_ARCHIVE_ZIP64_EXTRA_INCOMPLETE: 条目的 Zip64 扩展字段不完整（缺 ${field} 值）`)
        values[field] = uint64(view, at)
        at += 8
      }
      read("uncompressed")
      read("compressed")
      read("offset")
      return values
    }
    cursor += size
  }
  throw new Error("ZIP_ARCHIVE_ZIP64_EXTRA_MISSING: 条目字段被 Zip64 截断，但该条目没有 Zip64 扩展字段")
}

/** 文件名按规范：UTF-8 标志（bit 11）置位时是 UTF-8；未置位时按 UTF-8 解出替换字符再用 latin1 兜底。 */
function entryName(bytes: Uint8Array, flags: number): string {
  if (flags & 0x800) return Buffer.from(bytes).toString("utf8")
  const utf8 = Buffer.from(bytes).toString("utf8")
  return utf8.includes("�") ? Buffer.from(bytes).toString("latin1") : utf8
}

/** 读取中央目录（不含条目内容）。声明与字节不符一律抛错，不返回半个目录。 */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = endOfCentralDirectory(view)
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) throw new Error("ZIP_ARCHIVE_MULTIDISK_UNSUPPORTED: 分卷 ZIP 不支持")
  let count = view.getUint16(eocd + 10, true)
  let directoryBytes = view.getUint32(eocd + 12, true)
  let directoryOffset = view.getUint32(eocd + 16, true)
  if (count === UINT16_MAX || directoryBytes === UINT32_MAX || directoryOffset === UINT32_MAX) {
    need(view, eocd - ZIP64_LOCATOR_LENGTH, ZIP64_LOCATOR_LENGTH)
    if (view.getUint32(eocd - ZIP64_LOCATOR_LENGTH, true) !== ZIP64_LOCATOR_SIGNATURE) throw new Error("ZIP_ARCHIVE_ZIP64_LOCATOR_MISSING: 中央目录字段被 Zip64 截断，但找不到 Zip64 定位记录")
    const record = uint64(view, eocd - ZIP64_LOCATOR_LENGTH + 8)
    need(view, record, ZIP64_EOCD_MIN_LENGTH)
    if (view.getUint32(record, true) !== ZIP64_EOCD_SIGNATURE) throw new Error("ZIP_ARCHIVE_ZIP64_RECORD_MISSING: Zip64 定位记录指向的不是 Zip64 结尾记录")
    count = uint64(view, record + 32)
    directoryBytes = uint64(view, record + 40)
    directoryOffset = uint64(view, record + 48)
  }
  if (directoryOffset + directoryBytes > view.byteLength) throw new Error("ZIP_ARCHIVE_TRUNCATED: 中央目录越出文件末尾")
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index++) {
    need(view, cursor, 46)
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error(`ZIP_ARCHIVE_CENTRAL_DIRECTORY_INVALID: 第 ${index} 条中央目录记录签名不符`)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const checksum = view.getUint32(cursor + 16, true)
    let compressedBytes = view.getUint32(cursor + 20, true)
    let uncompressedBytes = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    need(view, cursor + 46, nameLength + extraLength + commentLength)
    let localHeaderOffset = view.getUint32(cursor + 42, true)
    if (compressedBytes === UINT32_MAX || uncompressedBytes === UINT32_MAX || localHeaderOffset === UINT32_MAX) {
      const values = zip64Fields(view, cursor + 46 + nameLength, extraLength, { uncompressed: uncompressedBytes === UINT32_MAX, compressed: compressedBytes === UINT32_MAX, offset: localHeaderOffset === UINT32_MAX })
      uncompressedBytes = values.uncompressed ?? uncompressedBytes
      compressedBytes = values.compressed ?? compressedBytes
      localHeaderOffset = values.offset ?? localHeaderOffset
    }
    const name = entryName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags)
    // 目录条目只是路径标记，没有可读内容，交给调用侧只会变成噪声。
    if (!name.endsWith("/")) entries.push({ name, method, compressedBytes, uncompressedBytes, crc: checksum, localHeaderOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 解出一条条目并核对声明字节数与 CRC-32；maxBytes 是本次允许解出的上限（超出即拒绝，不截断）。 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Buffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  need(view, entry.localHeaderOffset, 30)
  if (view.getUint32(entry.localHeaderOffset, true) !== LOCAL_SIGNATURE) throw new Error(`ZIP_ARCHIVE_LOCAL_HEADER_INVALID: ${entry.name} 的本地头签名不符`)
  if (view.getUint16(entry.localHeaderOffset + 6, true) & 0x1) throw new Error(`ZIP_ARCHIVE_ENCRYPTED: ${entry.name} 是加密条目，本读取器不解密`)
  if (entry.uncompressedBytes > maxBytes) throw new Error(`ZIP_ARCHIVE_ENTRY_TOO_LARGE: ${entry.name} 声明 ${entry.uncompressedBytes} 字节，超过本次上限 ${maxBytes}`)
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true)
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true)
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedBytes
  if (start > view.byteLength || end > view.byteLength) throw new Error(`ZIP_ARCHIVE_ENTRY_TRUNCATED: ${entry.name} 的压缩数据越出文件末尾`)
  const compressed = bytes.subarray(start, end)
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`ZIP_ARCHIVE_METHOD_UNSUPPORTED: ${entry.name} 使用压缩方法 ${entry.method}（只支持 store/deflate）`)
  const output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxBytes })
  if (output.length !== entry.uncompressedBytes) throw new Error(`ZIP_ARCHIVE_SIZE_MISMATCH: ${entry.name} 解出 ${output.length} 字节，中央目录声明 ${entry.uncompressedBytes}`)
  if (crc32(output) !== entry.crc) throw new Error(`ZIP_ARCHIVE_CRC_MISMATCH: ${entry.name} 解出的字节与中央目录声明的 CRC-32 不符（压缩包损坏或被改写）`)
  return output
}
