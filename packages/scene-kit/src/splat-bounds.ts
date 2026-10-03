import { createReadStream } from "node:fs"
import { open } from "node:fs/promises"
import { createGunzip } from "node:zlib"
import type { Vec3 } from "../../lyapunov-contracts/src/types.ts"

/**
 * 高斯泼溅点云的自身包围盒（源坐标系、米）。
 *
 * 为什么需要它：泼溅资源过去没有 aabb，导致
 * ① `scene_mount` 的 `alignBottomToSurface` 对 splat 直接跳过（`assetBounds` 只认 mesh），
 * ② 真实捕获的点云原点常在场景中部/上部（实测 `clean-outdoor-street-sweeper-test.spz` 的
 *    自身 Y ∈ [−33.776, +2.313]），不抬升就会让整条街道**沉到地面以下**——用户看到的就是
 *    "环境陷进地里/上下颠倒"。有了 aabb，落地对齐与包围盒查询都能像 mesh 一样工作。
 *
 * 只读文件头与位置块，不做解码质量判断；任何结构不符预期一律返回 undefined（保持旧行为，
 * 绝不猜一个可能错误的包围盒）。支持 `.spz`（v1-v3，gzip 或裸流）、`.splat`、二进制 `.ply`。
 */
export async function splatBounds(path: string, extension: string): Promise<{ min: Vec3; max: Vec3 } | undefined> {
 if (extension === ".ply" || extension === ".splat") return recordFileBounds(path, extension)
 if (extension !== ".spz") return undefined
 return spzFileBounds(path)
}

/** 大 PLY 只保留一个顶点块；文件大小不再受 readFile 的 2 GiB 上限约束。 */
async function recordFileBounds(path: string, extension: string): Promise<{ min: Vec3; max: Vec3 } | undefined> {
 const file = await open(path, "r")
 try {
  const { size } = await file.stat()
  let start = 0, stride = 32, count = size / 32
  let slots = [0, 4, 8].map(offset => ({ offset, type: "float" }))
  const readers: Record<string, { size: number; read: (b: Buffer, o: number) => number }> = {
   char: { size: 1, read: (b,o) => b.readInt8(o) }, uchar: { size: 1, read: (b,o) => b.readUInt8(o) },
   short: { size: 2, read: (b,o) => b.readInt16LE(o) }, ushort: { size: 2, read: (b,o) => b.readUInt16LE(o) },
   int: { size: 4, read: (b,o) => b.readInt32LE(o) }, uint: { size: 4, read: (b,o) => b.readUInt32LE(o) },
   float: { size: 4, read: (b,o) => b.readFloatLE(o) }, double: { size: 8, read: (b,o) => b.readDoubleLE(o) },
  }
  for (const [alias, type] of Object.entries({ int8:"char", uint8:"uchar", int16:"short", uint16:"ushort", int32:"int", uint32:"uint", float32:"float", float64:"double" })) readers[alias] = readers[type]!
  if (extension === ".ply") {
   const head = Buffer.alloc(65536), { bytesRead } = await file.read(head, 0, head.length, 0)
   const text = head.subarray(0, bytesRead).toString("latin1"), end = text.match(/(?:^|\n)end_header\r?\n/)
   if (!text.startsWith("ply") || !end || !/format binary_little_endian 1\.0/.test(text.slice(0, end.index))) return undefined
   start = end.index! + end[0].length
   let inVertex = false
   const offsets: Record<string, { offset: number; type: string }> = {}
   stride = 0; count = 0
   for (const line of text.slice(0, start).split(/\r?\n/)) {
    const element = line.match(/^element\s+(\S+)\s+(\d+)/)
    if (element) {
     // 顶点之前不能有另一段非空数据，否则 bodyStart 并非顶点起点。
     if (!count && element[1] !== "vertex" && Number(element[2]) > 0) return undefined
     inVertex = element[1] === "vertex"
     if (inVertex) count = Number(element[2])
     continue
    }
    if (!inVertex || !line.startsWith("property ")) continue
    const property = line.match(/^property\s+(\S+)\s+(\S+)$/), type = property?.[1]
    if (!type || !readers[type]) return undefined
    offsets[property![2]!] = { offset: stride, type }; stride += readers[type]!.size
   }
   if (!["x","y","z"].every(axis => offsets[axis])) return undefined
   slots = [offsets.x!, offsets.y!, offsets.z!]
  }
  if (!Number.isSafeInteger(count) || count <= 0 || !stride || start + count * stride > size) return undefined
  const blockCount = Math.max(1, Math.floor(1024 * 1024 / stride)), block = Buffer.alloc(blockCount * stride)
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i += blockCount) {
   const length = Math.min(blockCount, count - i) * stride
   let filled = 0
   while (filled < length) { const read = await file.read(block, filled, length - filled, start + i * stride + filled); if (!read.bytesRead) return undefined; filled += read.bytesRead }
   for (let offset = 0; offset < length; offset += stride) for (let axis = 0; axis < 3; axis++) {
    const slot = slots[axis]!, value = readers[slot.type]!.read(block, offset + slot.offset)
    if (!Number.isFinite(value)) return undefined
    min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value)
   }
  }
  return { min, max }
 } finally { await file.close() }
}

/** 前 2 字节是否是 gzip 魔数（决定 .spz 要不要经 gunzip 流）。 */
async function isGzip(path: string): Promise<boolean> {
 const file = await open(path, "r")
 try {
  const magic = Buffer.alloc(2)
  const { bytesRead } = await file.read(magic, 0, 2, 0)
  return bytesRead >= 2 && magic[0] === 0x1f && magic[1] === 0x8b
 } finally { await file.close() }
}

/**
 * SPZ 包围盒的**流式**读法：按字节顺序只读 16 字节头与位置块（每点 9 字节），逐块累积 min/max；
 * 不 readFile 整份、不 gunzipSync 整份——几 GB 的 SPZ 也不会把整个文件读进内存。
 * gzip 容器经 createGunzip 流式解，内存上界约为一个 chunk；结构不符/截断/非有限值一律返回 undefined（不猜）。
 * 布局（v1–v3 一致）：magic 'NGSP' + version + numPoints + shDegree/fractionalBits/flags/reserved，
 * 随后 numPoints × 3 × 3 字节的 24 位小端有符号定点位置。
 */
async function spzFileBounds(path: string): Promise<{ min: Vec3; max: Vec3 } | undefined> {
 const compressed = await isGzip(path)
 const source = createReadStream(path)
 const input = compressed ? source.pipe(createGunzip()) : source
 if (input !== source) source.on("error", error => input.destroy(error))
 const min: Vec3 = [Infinity, Infinity, Infinity]
 const max: Vec3 = [-Infinity, -Infinity, -Infinity]
 let pending = Buffer.alloc(0)
 let parsed = false
 let count = 0
 let scale = 1
 let records = 0
 try {
  for await (const chunk of input) {
   pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : Buffer.from(chunk as Buffer)
   if (!parsed) {
    if (pending.length < 16) continue
    if (pending.readUInt32LE(0) !== 0x5053474e) return undefined
    const version = pending.readUInt32LE(4)
    // 位置布局在 v1–v3 一致；更高版本未核对，宁可不给包围盒。
    if (version < 1 || version > 3) return undefined
    count = pending.readUInt32LE(8)
    if (count <= 0) return undefined
    scale = 1 / 2 ** pending.readUInt8(13)
    pending = pending.subarray(16)
    parsed = true
   }
   // 9 字节一点；跨 chunk 边界由 pending 残留补齐（内存上界 = 一个 chunk + 8 字节）。
   while (records < count && pending.length >= 9) {
    for (let axis = 0; axis < 3; axis += 1) {
     const offset = axis * 3
     const raw = pending[offset]! | (pending[offset + 1]! << 8) | (pending[offset + 2]! << 16)
     const value = (raw & 0x800000 ? raw - 0x1000000 : raw) * scale
     if (!Number.isFinite(value)) return undefined
     if (value < min[axis]!) min[axis] = value
     if (value > max[axis]!) max[axis] = value
    }
    records += 1
    pending = pending.subarray(9)
   }
   if (records >= count) break
  }
 } finally {
  source.destroy()
  if (input !== source) input.destroy()
 }
 if (!parsed || records < count) return undefined
 if (!(min[0]! <= max[0]! && min[1]! <= max[1]! && min[2]! <= max[2]!)) return undefined
 return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}
