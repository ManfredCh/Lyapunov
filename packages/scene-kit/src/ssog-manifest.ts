/** Streamed SOG v1 的选层闭包。只按 tree/filenames 真值，不猜 chunk 文件名前缀。 */

export interface SsogLevelFact { lod: number; gaussians: number }
export interface SsogChunkPlan { fileIndex: number; metaPath: string; ranges: Array<{ offset: number; count: number }>; referencedCount: number }
export interface SsogLodPlan {
  selectedLod: number
  expectedGaussians: number
  levels: SsogLevelFact[]
  chunks: SsogChunkPlan[]
  environment?: string
  sourceBounds: { min: [number, number, number]; max: [number, number, number] }
}

function bad(detail: string): never { throw new Error(`SSOG_MANIFEST_INVALID: ${detail}`) }
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** 公开 JSON 路径只按站点清单相对路径解析，拒绝越界/绝对 URL/反斜杠。 */
export function safeSsogPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.includes("?") || value.includes("#") || /^[A-Za-z][\w+.-]*:/.test(value) || value.includes("\0")) bad(`非法相对路径 ${JSON.stringify(value)}`)
  const parts = value.split("/")
  if (parts.some(part => !part || part === "." || part === "..")) bad(`非法相对路径 ${value}`)
  return value
}

function boundsOf(value: unknown): { min: [number, number, number]; max: [number, number, number] } {
  if (!value || typeof value !== "object") bad("tree.bound 缺失")
  const bound = value as { min?: unknown; max?: unknown }
  const tuple = (item: unknown): item is [number, number, number] => Array.isArray(item) && item.length === 3 && item.every(v => typeof v === "number" && Number.isFinite(v))
  const min = bound.min, max = bound.max
  if (!tuple(min) || !tuple(max)) bad("tree.bound 非有限或倒序")
  if (min.some((v, i) => v > max[i])) bad("tree.bound 倒序")
  return { min, max }
}

export function planSsogLod(value: unknown, selectedLod = 0): SsogLodPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("根必须是 JSON 对象")
  const manifest = value as Record<string, unknown>
  if (manifest.version !== 1 || !safeInt(manifest.lodLevels) || manifest.lodLevels < 1 || manifest.lodLevels > 32) bad("只支持 Streamed SOG v1 与 1..32 层")
  if (!Array.isArray(manifest.counts) || manifest.counts.length !== manifest.lodLevels || !manifest.counts.every(n => safeInt(n) && n > 0)) bad("counts 与 lodLevels 不符")
  if (!safeInt(manifest.count) || manifest.count !== (manifest.counts as number[]).reduce((sum, n) => sum + n, 0)) bad("count 不是各 LOD 层合计")
  if (!Number.isSafeInteger(selectedLod) || selectedLod < 0 || selectedLod >= manifest.lodLevels) bad(`selectedLod=${selectedLod} 超出 0..${manifest.lodLevels - 1}`)
  if (!Array.isArray(manifest.filenames) || manifest.filenames.length < 1 || manifest.filenames.length > 4096) bad("filenames 数量无效")
  const filenames = manifest.filenames.map(safeSsogPath)
  if (filenames.some(name => !name.endsWith("/meta.json")) || new Set(filenames).size !== filenames.length) bad("filenames 需是互异 chunk meta.json 相对路径")
  const environment = manifest.environment === undefined ? undefined : safeSsogPath(manifest.environment)
  if (environment !== undefined && !environment.endsWith("/meta.json")) bad("environment 需指向 meta.json")
  if (!manifest.tree || typeof manifest.tree !== "object" || Array.isArray(manifest.tree)) bad("tree 缺失")
  const sourceBounds = boundsOf((manifest.tree as Record<string, unknown>).bound)
  const ranges = new Map<number, SsogChunkPlan>()
  let total = 0, nodes = 0
  const stack: Array<{ node: unknown; depth: number }> = [{ node: manifest.tree, depth: 0 }]
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (++nodes > 100000 || depth > 64 || !node || typeof node !== "object" || Array.isArray(node)) bad("tree 节点数量/深度/形状无效")
    const tree = node as Record<string, unknown>
    boundsOf(tree.bound)
    if (tree.children !== undefined) {
      if (!Array.isArray(tree.children) || tree.children.length !== 2) bad("内部节点应有两个 children")
      for (const child of tree.children) stack.push({ node: child, depth: depth + 1 })
      continue
    }
    if (!tree.lods || typeof tree.lods !== "object" || Array.isArray(tree.lods)) bad("叶节点缺 lods")
    const ref = (tree.lods as Record<string, unknown>)[String(selectedLod)]
    if (ref === undefined) continue
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) bad("lod 引用不是对象")
    const row = ref as { file?: unknown; offset?: unknown; count?: unknown }
    if (!safeInt(row.file) || row.file >= filenames.length || !safeInt(row.offset) || !safeInt(row.count) || row.count <= 0 || !Number.isSafeInteger(row.offset + row.count)) bad("lod file/offset/count 无效")
    const chunk = ranges.get(row.file) ?? { fileIndex: row.file, metaPath: filenames[row.file]!, ranges: [], referencedCount: 0 }
    chunk.ranges.push({ offset: row.offset, count: row.count })
    chunk.referencedCount += row.count
    ranges.set(row.file, chunk)
    total += row.count
  }
  if (total !== (manifest.counts as number[])[selectedLod]) bad(`LOD${selectedLod} tree 行数 ${total} 与 counts ${manifest.counts[selectedLod]} 不符`)
  return {
    selectedLod, expectedGaussians: total,
    levels: (manifest.counts as number[]).map((gaussians, lod) => ({ lod, gaussians })),
    chunks: [...ranges.values()].sort((a, b) => a.fileIndex - b.fileIndex),
    ...(environment ? { environment } : {}), sourceBounds,
  }
}

/** 整块 ZIP 会带走 meta.count 所有点；引用若只覆盖其中一部分，必须换精确选行方法。 */
export function requireWholeSsogChunk(chunk: SsogChunkPlan, metaCount: number): void {
  if (!safeInt(metaCount) || metaCount <= 0) bad(`${chunk.metaPath} count 无效`)
  let cursor = 0
  for (const part of [...chunk.ranges].sort((a, b) => a.offset - b.offset)) {
    if (part.offset !== cursor) throw new Error(`SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE: ${chunk.metaPath} 引用在 ${cursor}/${part.offset} 有空洞或重叠；原样封装会多载或漏载点，需官方库精确选行，不把整块冒充该 LOD`)
    cursor += part.count
  }
  if (cursor !== metaCount) throw new Error(`SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE: ${chunk.metaPath} 只引用 ${cursor}/${metaCount} 点；需官方库精确选行，不把整块冒充该 LOD`)
}
