/** 标准 SOG ZIP 的有界文件校验与原字节封装；不解码高斯、不整包读入内存。 */
import { createReadStream } from "node:fs"
import { open, rm, stat, type FileHandle } from "node:fs/promises"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { createInflateRaw, crc32 } from "node:zlib"
import { finished } from "node:stream/promises"
import { Zip, ZipPassThrough } from "fflate"

const META_MAX_BYTES = 1024 * 1024
const DIRECTORY_MAX_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const ZIP32_OUTPUT_LIMIT = 0xffffffff - 1024 * 1024
const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_U16 = 0xffff
const ZIP64_U32 = 0xffffffff

export interface SogMeta {
  version: 2
  count: number
  means: { mins: number[]; maxs: number[]; files: string[] }
  scales: { codebook: number[]; files: string[] }
  quats: { files: string[] }
  sh0: { codebook: number[]; files: string[] }
  shN?: { count: number; bands: number; codebook: number[]; files: string[] }
  [key: string]: unknown
}

export interface SogZipFact {
  count: number
  shBands: number
  archiveBytes: number
  members: Array<{ name: string; bytes: number; crc32: number }>
}

function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`) }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
function finiteArray(value: unknown, size: number): value is number[] { return Array.isArray(value) && value.length === size && value.every(item => typeof item === "number" && Number.isFinite(item)) }

/** 仅接受 ZIP 内安全相对成员名；不把元数据给出的路径当宿主绝对路径。 */
export function safeSogMember(name: unknown): string {
  if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/") || name.includes("\0") || /^[A-Za-z]:/.test(name)) fail("SOG_MEMBER_PATH_INVALID", String(name))
  const parts = name.split("/")
  if (parts.some(part => !part || part === "." || part === "..")) fail("SOG_MEMBER_PATH_INVALID", name)
  return name
}

function filesOf(value: unknown, length: number, part: string): string[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files)) fail("SOG_META_INVALID", `${part}.files 缺失`)
  const files = (value as { files: unknown[] }).files
  if (files.length !== length) fail("SOG_META_INVALID", `${part}.files 应有 ${length} 项，实际 ${files.length}`)
  return files.map(safeSogMember)
}

/** 已安装 Spark 2.0.0 支持的 SOG v2；返回所需成员，不把 ZIP 头当内容证明。 */
export function parseSogMeta(value: unknown): { meta: SogMeta; members: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SOG_META_INVALID", "meta.json 必须是对象")
  const meta = value as SogMeta
  if (meta.version !== 2 || !integer(meta.count) || meta.count <= 0) fail("SOG_META_INVALID", "需要 SOG v2 且 count 为正整数")
  const means = filesOf(meta.means, 2, "means")
  const scales = filesOf(meta.scales, 1, "scales")
  const quats = filesOf(meta.quats, 1, "quats")
  const sh0 = filesOf(meta.sh0, 1, "sh0")
  if (!finiteArray(meta.means?.mins, 3) || !finiteArray(meta.means?.maxs, 3)) fail("SOG_META_INVALID", "means.mins/maxs 需三个有限数")
  if (!finiteArray(meta.scales?.codebook, 256) || !finiteArray(meta.sh0?.codebook, 256)) fail("SOG_META_INVALID", "scales/sh0.codebook 需 256 个有限数")
  let shN: string[] = []
  if (meta.shN !== undefined) {
    shN = filesOf(meta.shN, 2, "shN")
    if (!integer(meta.shN.count) || meta.shN.count <= 0 || meta.shN.count > 65536 || !integer(meta.shN.bands) || meta.shN.bands < 1 || meta.shN.bands > 3 || !finiteArray(meta.shN.codebook, 256)) fail("SOG_META_INVALID", "shN.count/bands/codebook 不符")
  }
  const members = ["meta.json", ...means, ...scales, ...quats, ...sh0, ...shN]
  if (new Set(members).size !== members.length) fail("SOG_META_INVALID", "成员路径重复")
  if (members.slice(1).some(name => !name.toLowerCase().endsWith(".webp"))) fail("SOG_IMAGE_UNSUPPORTED", "当前 Spark SOG 接线只接受元数据引用的 WebP 图像")
  return { meta, members }
}

async function readAt(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) fail("SOG_ZIP_RANGE_INVALID", `${offset}+${length}`)
  const result = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await file.read(result, filled, length - filled, offset + filled)
    if (!bytesRead) fail("SOG_ZIP_TRUNCATED", `${offset}+${length}`)
    filled += bytesRead
  }
  return result
}

function safeBigInt(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("SOG_ZIP_SIZE_UNSUPPORTED", String(value))
  return Number(value)
}

interface ZipMember { name: string; method: number; compressed: number; bytes: number; crc: number; localOffset: number }

async function zipDirectory(file: FileHandle, size: number): Promise<ZipMember[]> {
  if (size < 22) fail("SOG_ZIP_INVALID", "文件短于 ZIP 结尾记录")
  const tailStart = Math.max(0, size - 22 - 65535)
  const tail = await readAt(file, tailStart, size - tailStart)
  let eocd = -1
  for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === EOCD_SIG && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { eocd = at; break }
  if (eocd < 0) fail("SOG_ZIP_INVALID", "未找到自洽的中央目录结尾")
  if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6)) fail("SOG_ZIP_UNSUPPORTED", "分卷 ZIP")
  let count = tail.readUInt16LE(eocd + 10), dirSize = tail.readUInt32LE(eocd + 12), dirOffset = tail.readUInt32LE(eocd + 16)
  if (count === ZIP64_U16 || dirSize === ZIP64_U32 || dirOffset === ZIP64_U32) {
    const locator = await readAt(file, tailStart + eocd - 20, 20)
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) fail("SOG_ZIP_INVALID", "Zip64 定位记录缺失")
    const zip64At = safeBigInt(new DataView(locator.buffer, locator.byteOffset, locator.byteLength), 8)
    const record = await readAt(file, zip64At, 56)
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) fail("SOG_ZIP_INVALID", "Zip64 记录签名不符")
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength)
    count = safeBigInt(view, 32); dirSize = safeBigInt(view, 40); dirOffset = safeBigInt(view, 48)
  }
  if (count < 1 || count > MAX_ENTRIES || dirSize > DIRECTORY_MAX_BYTES || dirOffset + dirSize > size) fail("SOG_ZIP_SIZE_LIMIT", `目录 ${count} 项/${dirSize} 字节`)
  const dir = await readAt(file, dirOffset, dirSize)
  const members: ZipMember[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL_SIG) fail("SOG_ZIP_INVALID", `中央目录第 ${i} 项损坏`)
    const flags = dir.readUInt16LE(at + 8), method = dir.readUInt16LE(at + 10)
    if (flags & 1 || (method !== 0 && method !== 8)) fail("SOG_ZIP_UNSUPPORTED", `第 ${i} 项加密或压缩方法 ${method} 不支持`)
    const crc = dir.readUInt32LE(at + 16)
    let compressed = dir.readUInt32LE(at + 20), bytes = dir.readUInt32LE(at + 24), localOffset = dir.readUInt32LE(at + 42)
    const nameLength = dir.readUInt16LE(at + 28), extraLength = dir.readUInt16LE(at + 30), commentLength = dir.readUInt16LE(at + 32)
    if (at + 46 + nameLength + extraLength + commentLength > dir.length) fail("SOG_ZIP_INVALID", "中央目录条目截断")
    const name = safeSogMember(dir.subarray(at + 46, at + 46 + nameLength).toString("utf8"))
    if (name.includes("�")) fail("SOG_ZIP_INVALID", "成员名不是有效 UTF-8")
    if (compressed === ZIP64_U32 || bytes === ZIP64_U32 || localOffset === ZIP64_U32) {
      let extraAt = at + 46 + nameLength
      const extraEnd = extraAt + extraLength
      let found = false
      while (extraAt + 4 <= extraEnd) {
        const id = dir.readUInt16LE(extraAt), len = dir.readUInt16LE(extraAt + 2)
        extraAt += 4
        if (extraAt + len > extraEnd) fail("SOG_ZIP_INVALID", "Zip64 扩展字段截断")
        if (id === 1) {
          const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
          let p = extraAt
          if (bytes === ZIP64_U32) { if (p + 8 > extraAt + len) fail("SOG_ZIP_INVALID", "Zip64 bytes 缺失"); bytes = safeBigInt(view, p); p += 8 }
          if (compressed === ZIP64_U32) { if (p + 8 > extraAt + len) fail("SOG_ZIP_INVALID", "Zip64 compressed 缺失"); compressed = safeBigInt(view, p); p += 8 }
          if (localOffset === ZIP64_U32) { if (p + 8 > extraAt + len) fail("SOG_ZIP_INVALID", "Zip64 offset 缺失"); localOffset = safeBigInt(view, p) }
          found = true; break
        }
        extraAt += len
      }
      if (!found) fail("SOG_ZIP_INVALID", "Zip64 扩展字段缺失")
    }
    members.push({ name, method, compressed, bytes, crc, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  if (new Set(members.map(member => member.name)).size !== members.length) fail("SOG_ZIP_INVALID", "ZIP 成员名重复")
  return members
}

async function inspectMember(file: FileHandle, archivePath: string, member: ZipMember, archiveBytes: number, limit: number, keep: boolean, signal?: AbortSignal): Promise<{ bytes: number; head: Buffer; body?: Buffer }> {
  signal?.throwIfAborted()
  if (member.bytes > limit) fail("SOG_MEMBER_SIZE_LIMIT", `${member.name} ${member.bytes} > ${limit}`)
  if (member.compressed <= 0) fail("SOG_ZIP_INVALID", `${member.name} 压缩体为空`)
  const local = await readAt(file, member.localOffset, 30)
  if (local.readUInt32LE(0) !== LOCAL_SIG || local.readUInt16LE(8) !== member.method || local.readUInt16LE(6) & 1) fail("SOG_ZIP_INVALID", `${member.name} 本地头不符`)
  const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28)
  const localName = (await readAt(file, member.localOffset + 30, nameLength)).toString("utf8")
  if (localName !== member.name) fail("SOG_ZIP_INVALID", `${member.name} 本地名不符`)
  const start = member.localOffset + 30 + nameLength + extraLength
  if (start + member.compressed > archiveBytes) fail("SOG_ZIP_TRUNCATED", member.name)
  const input = createReadStream(archivePath, { start, end: start + member.compressed - 1, ...(signal ? { signal } : {}) })
  const stream = member.method === 8 ? input.pipe(createInflateRaw()) : input
  if (stream !== input) input.on("error", error => stream.destroy(error))
  const parts: Buffer[] = []
  let head = Buffer.alloc(0), bytes = 0, crc = 0
  try {
    for await (const raw of stream) {
      signal?.throwIfAborted()
      const chunk = Buffer.from(raw as Uint8Array)
      bytes += chunk.length
      if (bytes > limit || bytes > member.bytes) fail("SOG_MEMBER_SIZE_LIMIT", member.name)
      crc = crc32(chunk, crc)
      if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)])
      if (keep) parts.push(chunk)
    }
  } finally {
    input.destroy()
    if (stream !== input) stream.destroy()
  }
  if (bytes !== member.bytes || crc !== member.crc) fail("SOG_ZIP_CRC_MISMATCH", member.name)
  return { bytes, head, ...(keep ? { body: Buffer.concat(parts) } : {}) }
}

export function validWebpHead(head: Buffer, bytes: number): boolean {
  if (head.length < 21 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WEBP") return false
  if (head.readUInt32LE(4) + 8 !== bytes) return false
  const kind = head.toString("ascii", 12, 16), chunkBytes = head.readUInt32LE(16)
  if (kind !== "VP8L" && kind !== "VP8X" && kind !== "VP8 ") return false
  if (20 + chunkBytes + (chunkBytes & 1) > bytes || chunkBytes < (kind === "VP8L" ? 5 : 10)) return false
  return kind !== "VP8L" || head[20] === 0x2f
}

export async function inspectSogZipFile(path: string, maxArchiveBytes: number, signal?: AbortSignal): Promise<SogZipFact> {
  signal?.throwIfAborted()
  const file = await open(path, "r")
  try {
    const archiveBytes = (await file.stat()).size
    if (archiveBytes > maxArchiveBytes) fail("SOG_ZIP_SIZE_LIMIT", `${archiveBytes} > ${maxArchiveBytes}`)
    const members = await zipDirectory(file, archiveBytes)
    const byName = new Map(members.map(member => [member.name, member]))
    const metaEntry = byName.get("meta.json")
    if (!metaEntry) fail("SOG_META_MISSING", "ZIP 根目录缺 meta.json")
    const metaRead = await inspectMember(file, path, metaEntry, archiveBytes, META_MAX_BYTES, true, signal)
    let parsed: unknown
    try { parsed = JSON.parse(metaRead.body!.toString("utf8")) } catch { fail("SOG_META_INVALID", "meta.json 不是 JSON") }
    const { meta, members: required } = parseSogMeta(parsed)
    const requiredBytes = required.reduce((sum, name) => sum + (byName.get(name)?.bytes ?? 0), 0)
    if (requiredBytes > maxArchiveBytes) fail("SOG_MEMBER_SIZE_LIMIT", `必要成员解压后 ${requiredBytes} > ${maxArchiveBytes}`)
    const checked: SogZipFact["members"] = [{ name: "meta.json", bytes: metaRead.bytes, crc32: metaEntry.crc }]
    for (const name of required.slice(1)) {
      const entry = byName.get(name)
      if (!entry) fail("SOG_MEMBER_MISSING", name)
      const read = await inspectMember(file, path, entry, archiveBytes, maxArchiveBytes, false, signal)
      if (!validWebpHead(read.head, read.bytes)) fail("SOG_IMAGE_INVALID", name)
      checked.push({ name, bytes: read.bytes, crc32: entry.crc })
    }
    return { count: meta.count, shBands: meta.shN?.bands ?? 0, archiveBytes, members: checked }
  } finally { await file.close() }
}

/** 已下载成员原样写入标准 ZIP，FFlate 只生成 ZIP 结构，不再压缩 WebP。 */
export async function writeSogZip(destination: string, sourceRoot: string, members: readonly string[], signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  if (members.length < 2 || members.length > MAX_ENTRIES) fail("SOG_ZIP_SIZE_LIMIT", `成员数 ${members.length}`)
  let sourceBytes = 0
  for (const name of members) {
    safeSogMember(name)
    sourceBytes += (await stat(join(sourceRoot, name))).size
  }
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes > ZIP32_OUTPUT_LIMIT) fail("SOG_ZIP_SIZE_LIMIT", `ZIP writer 当前不写 Zip64，源成员共 ${sourceBytes} 字节`)
  signal?.throwIfAborted()
  const file = await open(destination, "wx", 0o600)
  const writer = file.createWriteStream({ autoClose: true })
  const writerFinished = finished(writer)
  const hash = createHash("sha256")
  let bytes = 0, done = false, pendingDrain: Promise<unknown> | undefined
  let input: ReturnType<typeof createReadStream> | undefined
  let writeFailure: unknown
  void writerFinished.catch(error => { writeFailure = error; input?.destroy(error) }) // 早期写错误立即中止正在读的源文件。
  const awaitOutput = async (): Promise<void> => {
    const pending = pendingDrain
    pendingDrain = undefined
    if (pending) await pending
    if (writeFailure !== undefined) throw writeFailure
  }
  const zip = new Zip((error, chunk, final) => {
    if (error) { writeFailure = error; input?.destroy(error); writer.destroy(error); return }
    if (writer.destroyed) return
    if (chunk?.length) {
      const copy = Buffer.from(chunk)
      hash.update(copy); bytes += copy.length
      if (bytes > ZIP32_OUTPUT_LIMIT) { const error = new Error("SOG_ZIP_SIZE_LIMIT: archive 超过当前 ZIP32 writer 的上限"); writeFailure = error; input?.destroy(error); writer.destroy(error); return }
      if (!writer.write(copy)) { pendingDrain = once(writer, "drain"); void pendingDrain.catch(() => undefined) }
    }
    if (final) writer.end()
  })
  const onAbort = (): void => {
    const error = signal?.reason instanceof Error ? signal.reason : new Error("SOG_ZIP_ABORTED")
    input?.destroy(error)
    writer.destroy(error)
    zip.terminate()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    for (const name of members) {
      signal?.throwIfAborted()
      const entry = new ZipPassThrough(name)
      zip.add(entry)
      await awaitOutput() // zip.add 可先写本地头；不能先开始读大文件再发现输出失败。
      input = createReadStream(join(sourceRoot, name), signal ? { signal } : undefined)
      try {
        for await (const raw of input) {
          signal?.throwIfAborted()
          if (writeFailure !== undefined) throw writeFailure
          entry.push(new Uint8Array(raw as Buffer), false)
          await awaitOutput()
        }
      } finally {
        input.destroy()
        input = undefined
      }
      entry.push(new Uint8Array(), true)
      await awaitOutput()
    }
    zip.end()
    await writerFinished
    if (writeFailure !== undefined) throw writeFailure
    done = true
    return { bytes, sha256: hash.digest("hex") }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!done) { zip.terminate(); writer.destroy() }
    await writerFinished.catch(() => undefined)
    if (!done) await rm(destination, { force: true })
  }
}
