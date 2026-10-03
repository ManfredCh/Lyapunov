/**
 * **按距离选出的 LOD 级别**在采集/观察回执里的窄面：这张图里每个实体用的是哪一级、哪份资源、多少三角形。
 *
 * 为什么要有它：Viewer 会按相机距离把碎石/植被这类实体换成简化件（`packages/viewer/src/lod.ts`），
 * 但这条事实从前只活在画面里——采集记录与观察回执看不到"这张图是基础几何还是简化件"。
 * 于是数据集/下游拿到一张远处拍的图，既不知道它已经简化过（该知道的没知道），
 * 也没法区分"正常按距离简化"与"该用的那一级没读进来、只能拿更粗的顶上"（该报的没报）。
 *
 * 两种事实在这里分开，措辞也因此分开（见 `lodFaceNote`）：
 *  · `simplified` —— 这一帧确实用了简化件。**正常**，不是故障；但必须如实说出来。
 *  · `coarser` / `failed` —— 比这台相机该用的级别更粗，或该读的级别没读进来。**这才是要报的问题**。
 *
 * 整形在这里做：面由 Viewer 的 `capture().lod` / `renderCameraImage().lod` 给出（**唯一 owner**，见
 * `packages/viewer/src/index.ts` 的 `LodCaptureFace`）；本模块只认白名单字段、限长限量，
 * 不重算级别、不补默认值、不替 Viewer 判断"该用哪一级"。没有这一面时它就不进记录（不写空壳）。
 *
 * **规模不设上限**：实体条数与"参与不了级别交换"的条数都不封顶。大场景（上千个带 LOD 的实体）是合法输入，
 * 从前那种"超过 N 条就整面返回 undefined"的写法会让一份合法采集的 LOD 元数据**整份消失**——
 * 下游于是把简化几何当基础件（该知道的没知道），而且丢得无声无息。要限制的只有**给模型读的那一句话**
 * （见 `lodFaceNote` 的 `MAX_LISTED`）：记录里逐条记全，摘要里点几个名、报总数。
 */

/** 单个实体的级别读数（字段与 Viewer 的 `LodEntityReading` 一一对应）。 */
export interface LodEntityReading {
  entityId: string
  /** 画面里这一帧用的级别：-1 = 基础件（未简化），≥0 = 文档 `visual.lod` 的第 N 条派生级。 */
  level: number
  /** 这台相机按距离**该用**的级别；与 `level` 不同就是"顶不上去"的降级（见 `coarser`）。 */
  requested: number
  /** 该级别的角色名（文档 `visual.lod[].role`）。 */
  role?: string
  /** 画面的几何来自哪条资源版本（`resourceId@version`）；基础件时为文档里那条原件。 */
  resource?: string
  /** 画面里这一级的三角形数（真实渲染用的那份对象）。 */
  triangles: number
  /** 相机到该实体锚点的距离（米）。 */
  distanceM: number
  /** 用的是简化件（不是基础件）。 */
  simplified: boolean
  /** 比这台相机该用的级别**更粗**——只有缺资源/读失败时才会出现，是降级不是正常简化。 */
  coarser?: boolean
  /** 该读进来却读失败的级别（角色名）。 */
  failed?: string[]
}
/** 采集记录/观察回执里的 LOD 窄面；字段与 Viewer 的 `LodCaptureFace` 一一对应。 */
export interface LodCaptureFace {
  /** 这些级别是为**哪台相机**定的：`capture` = 按指定相机出图（渲染前 settle 过），`window` = 窗口相机。 */
  camera: "capture" | "window"
  /** 这一帧参与级别选择的实体数。 */
  planned: number
  /** 逐实体读数。 */
  entries: LodEntityReading[]
  /** 参与不了级别交换的实体（例如带烘焙动画）：如实说明，不省这点面数。 */
  skipped?: Array<{ entityId: string; reason: string }>
}

const text = (value: unknown, limit: number): string | undefined => typeof value === "string" && value ? value.slice(0, limit) : undefined
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

/**
 * 整形结果：要么给出面，要么给出**为什么给不出**。
 * 分成两支是为了让调用方分得清"载荷里根本没有这一面"（`undefined`，例如旧版前端）与
 * "带了这一面但不合格"（`{issue}`）——后者绝不能装成前者：那等于把"读不出来"说成"没有 LOD"。
 */
type LodFaceShape = { face: LodCaptureFace } | { issue: string }

/**
 * 把前端送来的 LOD 面整形进采集记录。严格性刻意的：
 *  · 形状不对就**不猜、不造**——编造一面比没有这一面更糟（"看起来核过了"会让下游把简化件当基础几何、把降级当正常）；
 *  · **一条实体读数不合法，整面就作废**，不做"跳过坏的那条、留下好的"——那样留下的是一份少报的读数，
 *    而少报在这里等于说谎：回执会说"这张图里有 N 个实体用的是简化件"，少掉的那一个永远不会被下游看见。
 *  · 但**规模不是形状错误**：多少条都照收（见文件头）。
 */
function shapeLodFace(input: unknown): LodFaceShape | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== "object" || Array.isArray(input)) return { issue: `lod 必须是一个对象（收到 ${JSON.stringify(input) ?? "undefined"}）` }
  const raw = input as Record<string, unknown>
  if (raw.camera !== "capture" && raw.camera !== "window") return { issue: `lod.camera 只能是 "capture" 或 "window"（收到 ${JSON.stringify(raw.camera) ?? "undefined"}）` }
  if (!finite(raw.planned)) return { issue: `lod.planned 必须是有限数（收到 ${JSON.stringify(raw.planned) ?? "undefined"}）` }
  if (!Array.isArray(raw.entries)) return { issue: `lod.entries 必须是数组（收到 ${JSON.stringify(raw.entries) ?? "undefined"}）` }
  const entries: LodEntityReading[] = []
  for (const [index, item] of raw.entries.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { issue: `lod.entries[${String(index)}] 必须是对象` }
    const row = item as Record<string, unknown>
    const entityId = text(row.entityId, 200)
    if (!entityId) return { issue: `lod.entries[${String(index)}].entityId 必须是非空字符串` }
    if (!finite(row.level) || !finite(row.requested) || !finite(row.triangles) || !finite(row.distanceM)) return { issue: `lod.entries[${String(index)}]（${entityId}）的 level/requested/triangles/distanceM 必须都是有限数` }
    if (row.failed !== undefined && !Array.isArray(row.failed)) return { issue: `lod.entries[${String(index)}]（${entityId}）的 failed 必须是数组` }
    const role = text(row.role, 120), resource = text(row.resource, 200)
    const failed = (row.failed ?? []).flatMap(value => { const name = text(value, 120); return name ? [name] : [] }).slice(0, 8)
    entries.push({
      entityId, level: row.level, requested: row.requested,
      ...(role ? { role } : {}), ...(resource ? { resource } : {}),
      triangles: Math.max(0, Math.round(row.triangles)), distanceM: round(row.distanceM, 3),
      simplified: row.simplified === true,
      ...(row.coarser === true ? { coarser: true } : {}),
      ...(failed.length ? { failed } : {}),
    })
  }
  const skipped: Array<{ entityId: string; reason: string }> = []
  if (raw.skipped !== undefined) {
    if (!Array.isArray(raw.skipped)) return { issue: `lod.skipped 必须是数组（收到 ${JSON.stringify(raw.skipped) ?? "undefined"}）` }
    for (const [index, item] of raw.skipped.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { issue: `lod.skipped[${String(index)}] 必须是对象` }
      const row = item as Record<string, unknown>
      const entityId = text(row.entityId, 200), reason = text(row.reason, 500)
      if (!entityId || !reason) return { issue: `lod.skipped[${String(index)}] 的 entityId/reason 必须都是非空字符串` }
      skipped.push({ entityId, reason })
    }
  }
  return { face: { camera: raw.camera, planned: Math.max(0, Math.round(raw.planned)), entries, ...(skipped.length ? { skipped } : {}) } }
}

/** 整形过的 LOD 面；`undefined` = 载荷里没有这一面，或这一面不合格（原因见 `lodFaceIssue`）。 */
export function lodFaceFrom(input: unknown): LodCaptureFace | undefined {
  const shaped = shapeLodFace(input)
  return shaped && "face" in shaped ? shaped.face : undefined
}

/**
 * 带了 LOD 面但**读不出来**的原因；`undefined` = 没有问题（没有这一面，或这一面是好的）。
 *
 * 分开这一支的意义：`lodFaceFrom` 返回 undefined 时，调用方不能想当然地当成"这次没有 LOD 读数"——
 * 形状/字段不合格必须如实写进记录与回执（否则一份读不出级别的图会被下游当成"没有简化件"）。
 */
export function lodFaceIssue(input: unknown): string | undefined {
  const shaped = shapeLodFace(input)
  return shaped && "issue" in shaped ? shaped.issue : undefined
}

/** 一句话里最多列几个实体（其余只报数量）：回执是给模型读的，不是日志。 */
const MAX_LISTED = 4
const list = (ids: string[]): string => ids.length <= MAX_LISTED ? ids.join("、") : `${ids.slice(0, MAX_LISTED).join("、")} 等 ${String(ids.length)} 个`

/**
 * 给模型看的一句话。返回 undefined = 这一帧**没有任何要说的**（没有简化件、也没有降级）。
 *
 * 两种事实分开说，是因为它们对下游的含义完全不同：
 *  · 按距离用上简化件是**正常行为**（省面数正是 LOD 的目的），但数据集必须知道"这份几何不是基础件"，
 *    所以照实写清级别/资源版本/三角形数，**不写成错误或降级**；
 *  · "比该用的级别更粗"或"该读的级别没读进来"才是不正常，用降级的口气写，并点名实体与原因。
 *
 * 句子里同时给出**总数与完整读数的位置**：摘要只点几个名（这是给模型读的一句话），
 * 但逐实体读数一条不少地在采集记录的 `lod.entries` 里，模型要哪一条可以去取。
 */
export function lodFaceNote(face: LodCaptureFace | undefined): string | undefined {
  if (!face || face.entries.length === 0) return undefined
  const simplified = face.entries.filter(entry => entry.simplified)
  const degraded = face.entries.filter(entry => entry.coarser === true || (entry.failed?.length ?? 0) > 0)
  const where = `这一帧参与级别选择的实体共 ${String(face.planned)} 个，逐实体读数 ${String(face.entries.length)} 条都在本记录的 lod.entries 里。`
  const sentences: string[] = []
  if (simplified.length) {
    const triangles = simplified.reduce((sum, entry) => sum + entry.triangles, 0)
    const versions = [...new Set(simplified.map(entry => entry.resource ?? `level ${String(entry.level)}`))]
    sentences.push(`这张图里有 ${String(simplified.length)} 个实体（${list(simplified.map(entry => entry.entityId))}）用的是**按相机距离选出的简化件**：${versions.join("、")}，这 ${String(simplified.length)} 个实体合计 ${String(triangles)} 个三角形。这是按距离的正常简化，不是故障；但这份几何不是基础件——要按基础精度使用时请另取原件。（${where}）`)
  }
  if (degraded.length) {
    const rows = degraded.map(entry => {
      const why = entry.failed?.length ? `该读的 ${entry.failed.join("、")} 没读进来` : `该用级别 ${String(entry.requested)}、画面只有级别 ${String(entry.level)}`
      return `${entry.entityId}（${why}）`
    })
    sentences.push(`其中 ${String(degraded.length)} 个实体**比这台相机该用的级别更粗**：${list(rows)}——这是缺件/读取失败造成的降级，别把这张图当成它们该有的精度。（${where}）`)
  }
  return sentences.length ? sentences.join("") : undefined
}

/**
 * 采集载荷**带了 LOD 面但它不合格**时给模型的一句话（`undefined` = 没有这个问题）。
 *
 * 为什么必须单独说：`lod` 读不出来**不等于**"场景里没有 LOD"。沉默会让下游把这张图当成
 * "没有简化件"的基础几何——恰好和真相相反（这份读数读不出来的原因常常就是数据本身太乱）。
 */
export function lodFaceIssueNote(issue: string | undefined): string | undefined {
  if (!issue) return undefined
  return `注意：这次采集载荷带了 LOD 读数，但整形没通过（${issue}），这一面已整份丢弃；**不能把它当成"场景里没有 LOD / 没有用简化件"**——这份图里到底用没用简化件，这一次没有读数可查。`
}
