/**
 * 资产**语义**（格式）与**定位符**（`uri`／`file` 串）分开（DEV-PROJ-01）。
 *
 * 为什么需要这一层：场景在到达浏览器之前会过一遍出站投影
 * （`lyapunov-contracts/src/product-paths.ts:projectPathsOnly`，生产侧调用点只有
 * `plugin.ts:1857` 的 `state` 轮询与 `plugin.ts:1865` 的 `scene` 路由），把定位符换成产品自己的两种引用：
 * `uri` 键与 `file:` 串 → 标记 `res:<指纹>`；登记域内绝对路径 → `<域>/<相对>`。
 * 定位符因此**不再携带路径语义**：`res:<指纹>` 没有扩展名，也当不了 `new URL` 的基址
 * （实测 `new URL("meshes/pelvis.STL","res:<指纹>")` 抛 `Invalid URL`；而
 * `<域>/<相对>`、`file:///…` 这类"真名"定位符照旧带扩展名）。
 *
 * ⚠️ **标记不是黑盒，也不是内容摘要。** 它的定义只有一份：
 * `product-paths.ts:100-121` 的 `resourceToken(uri) = "res:" + fingerprint(uri)`，
 * 其中 `fingerprint` 是 FNV-1a 64 ⊕ djb2 64、按 16 进制小端打 32 位（高 16 位因此恒为 `0`）。
 * 三点后果，本模块按这三点行事（新增 `assetMarkerOf`／`resolveAssetMarker` 把定义摊开）：
 *  1. 标记是**定位符串**的指纹 —— **不是**文件内容的 sha256（`scene_projection.py:596/660` 的
 *     `sha256(bytes)[:16]` 是**派生目录名**，与标记是两个不同的函数、不同的输入、不同的长度）；
 *  2. 因此标记**不能反推路径或内容**，任何"标记 → 目录名"的解析都是猜；
 *  3. 但它**可算**：对着**授权候选集**逐个重算指纹就能等值匹配 —— 这正是媒体路由
 *     `admitResourceToken` 的既有判据，也是 `resolveAssetMarker` 的实现。
 *
 * P15 的只读盘点（`bugfixHistory/PROJECTION-BLAST-RADIUS-20260926.md`）实测这条投影打坏了 4 处消费点，
 * 共同成因只有一个：**拿定位符串去猜语义**（扩展名 / URL 可解析性 / 格式）。
 * 本模块只做一件事：把语义事实从**登记记录**里取出来（`Representation.mimeType`，投影不动它），
 * 只有定位符确实带着真名时才回落到它的后缀；对标记一律返回 `undefined` —— **不猜**，
 * 由调用方如实记一条缺件警告（走既有的 `visualWarnings`／`lodWarnings` 通道）。
 * 需要"这个标记对应哪一件"时用 `resolveAssetMarker(marker, 授权候选集)`：**解不出就是解不出**。
 *
 * 本模块是纯函数、不做 IO、不引新依赖：Node 侧脚本与浏览器里跑的是同一份判据。
 */
import { RESOURCE_TOKEN_PREFIX, matchResourceToken, resourceToken } from "../../lyapunov-contracts/src/product-paths.ts"
import type { Representation } from "../../lyapunov-contracts/src/types.ts"

/**
 * 已知格式名（小写、无点）的**唯一一份**词表。
 * 其中 splat 的 6 个（ply/spz/splat/ksplat/sog/rad）与 `splat-support.ts:SPLAT_FILE_TYPE_NAMES`
 * 是同一批事实——两份表由测试钉住（`projection-consumer.test.ts`），不靠人工同步。
 */
export const ASSET_FORMATS = ["stl", "obj", "dae", "glb", "gltf", "ply", "spz", "splat", "ksplat", "sog", "rad", "hdr", "exr"] as const

/**
 * 细粒度 mimeType → 格式名。取值逐条对应生产侧的写法：
 *  · mesh：`benchmark-libero/python/scene_projection.py:32` 的 `VIEWER_MESH_MIME`；
 *  · glTF：`scene-kit/src/formats.ts:312`；
 *  · HDRI：`viewer/src/environment.ts:20` 的 `HDRI_MIME_TYPES`。
 * 泛型 mimeType（`application/octet-stream`、`text/plain`、空）**故意不在表里**：它们不构成断言，
 * 命中不了就回落到定位符真名后缀，而不是当成"格式未知"。
 */
const FORMAT_BY_MIME: Readonly<Record<string, string>> = {
  "model/stl": "stl",
  "model/obj": "obj",
  "model/vnd.collada+xml": "dae",
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "image/vnd.radiance": "hdr",
  "image/x-exr": "exr",
}

const KNOWN = new Set<string>(ASSET_FORMATS)
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** 定位符是否**自带 scheme**（`res:<指纹>`、`file:///…`、`data:…`、`recording:/…`）——绝对定位符不再叠加基址。 */
export function hasLocatorScheme(value: unknown): boolean {
  return typeof value === "string" && SCHEME.test(value)
}

/**
 * 登记声明（`Representation.mimeType`）→ 格式名。认不出就 `undefined`（不臆造）。
 * 另外认 `application/x-<格式>` 这条既有约定（`scene-kit/src/formats.ts:336` 用它写 splat：
 * `.ply → application/x-ply`、`.spz → application/x-spz`……），但**只认词表里有的格式名**，
 * `application/x-foo` 不会变成格式 `foo`。
 */
export function assetFormatFromMimeType(mimeType: unknown): string | undefined {
  const text = typeof mimeType === "string" ? mimeType.split(";")[0]!.trim().toLowerCase() : ""
  if (!text) return undefined
  const declared = FORMAT_BY_MIME[text]
  if (declared) return declared
  const suffix = text.startsWith("application/x-") ? text.slice("application/x-".length) : ""
  return suffix && KNOWN.has(suffix) ? suffix : undefined
}

/**
 * 定位符 → 格式名。**只有它确实带着真名时才给**：
 *  · `res:<指纹>` ⇒ `undefined`（标记里只有定位符的指纹，没有后缀也没有真名；**不猜**）；
 *  · `meshes/pelvis.STL`、`runtime/agent/assets/meshes/a.stl`、`file:///a/b.dae` ⇒ `stl`／`dae`；
 *  · 无后缀、点开头、点结尾 ⇒ `undefined`。
 * 查询串与片段先剥掉（`a.stl?v=2` 的格式是 `stl`）。
 */
export function assetFormatFromLocator(locator: unknown): string | undefined {
  if (typeof locator !== "string" || !locator) return undefined
  if (locator.startsWith(RESOURCE_TOKEN_PREFIX)) return undefined
  const path = locator.split(/[?#]/)[0] ?? ""
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return undefined
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 定位符 → **产生端会为它写下的标记**（`res:<指纹>`）。`undefined`＝空串／非字符串。
 *
 * 存在的理由只有一个：**这个函数是"标记是什么"的唯一一份消费侧说法**。
 * 它直接转 `product-paths.ts` 的 `resourceToken`，本模块**不自带第二套指纹算法** ——
 * 两端一旦分叉，`resolveAssetMarker` 与媒体路由的准入判据会同时失效而**没人看得见**。
 */
export function assetMarkerOf(locator: unknown): string | undefined {
  return typeof locator === "string" && locator ? resourceToken(locator) : undefined
}

/**
 * 按**产生端的定义**解析标记：标记是**定位符**的指纹（见模块头），所以它只能对着
 * **授权候选集**逐个重算指纹来等值匹配 —— 与媒体路由 `plugin.ts` 的 `admitResourceToken`
 * 是同一把判据（`matchResourceToken`），本模块不另立一套。
 *
 * 三种"解不出"，一律 `undefined`（**不猜**，调用方按既有 `unresolved` 语义如实上报）：
 *  1. 入参不是标记（空串、非字符串、别的定位符形状）；
 *  2. 候选集里没有哪一件的指纹等于它（未授权／不在这份场景里）；
 *  3. 候选集为空。
 *
 * ⚠️ **候选集必须是"原像"定位符**（`file:` URI／绝对路径这类投影**之前**的串），
 * **不是**标记串。把标记当候选永远解不出 —— `resourceToken("res:…")` 是"对标记再指纹一次"，
 * 不等于标记本身。这条由用例 ④/⑤ 钉住。类型契约是 `Iterable<string>`：混进非字符串成员会由
 * `resourceToken` 当场抛（不静默跳过，免得"少了一件"被当成"没这一件"）。
 *
 * **不要拿它当"标记 → 内容摘要"或"标记 → 路径"的解码器**：它做不到，而且**不能假装做得到**。
 * 它回答的是「这个标记是候选集里**哪一件**」，也就是"能不能定位到实际文件"这个问题本身。
 */
export function resolveAssetMarker(marker: unknown, candidates: Iterable<string>): string | undefined {
  if (typeof marker !== "string" || !marker.startsWith(RESOURCE_TOKEN_PREFIX)) return undefined
  return matchResourceToken(marker, candidates)
}

/**
 * 语义优先级**只有一条**：登记里声明的 mimeType > 定位符真名后缀。
 * 顺序不能反：投影后的 `uri` 是标记（无后缀），而 mimeType 不受投影影响；反过来，
 * 声明太泛（`application/octet-stream`）时后缀是唯一线索。
 */
export function assetFormatOf(hints: { mimeType?: unknown; locator?: unknown }): string | undefined {
  return assetFormatFromMimeType(hints.mimeType) ?? assetFormatFromLocator(hints.locator)
}

/**
 * 缺件警告里的人话：把"引用长什么样、声明过什么、判出来是什么、为什么判不出来"一次说清。
 * 判据失败必须能一眼看出是**哪一种**失败（标记没有真名 ≠ 文件真没有后缀 ≠ 声明了不支持的格式），
 * 否则又是一条读不懂的报错。
 */
export function describeAssetReference(reference: unknown, hints: { mimeType?: unknown; format?: unknown } = {}): string {
  const shown = typeof reference === "string" ? reference : String(reference)
  const declared = typeof hints.mimeType === "string" && hints.mimeType ? hints.mimeType : "无"
  const format = typeof hints.format === "string" && hints.format ? hints.format : "无"
  if (typeof reference === "string" && reference.startsWith(RESOURCE_TOKEN_PREFIX))
    return `${shown}（不可逆标记 = 定位符指纹：反推不出路径或内容，只能对着授权候选集重算匹配；没有真名，不能从定位符判格式；登记 mimeType：${declared}；判出格式：${format}）`
  return `${shown}（定位符没有可用后缀；登记 mimeType：${declared}；判出格式：${format}）`
}

/**
 * 文档内引用 → 交给 `resolveResource` 的定位符。与今天 `new URL(file, baseUri).href` **逐例等价**，
 * 只有一处不同：基址不可用时**不再抛**。
 *
 * 今天的行为是 `TypeError: … cannot be parsed as a URL`——这句话读起来像"文档坏了"，
 * 实际是"基址被出站投影换成了不透明标记"。判据：
 *  1. 引用自带 scheme（标记 `res:<指纹>`、`file:///…`）⇒ 原样，基址不参与；
 *  2. 基址能当 URL 基准（`file:///dir/`、`recording:/resources/0/`）⇒ 照旧相对解析（`based:true`）；
 *  3. 基址不能当基准（`res:<指纹>`、`res:unresolved`、缺失、`data:`）⇒ 原样交出（`based:false`）。
 *
 * 为什么不在这里"还原"绝对路径：不可逆标记是**设计**（`product-paths.ts:98-121`），消费侧无从还原。
 * 相对引用在标记基址上的真实解析属于媒体路由（`plugin.ts` 的 `resource` 路由，入站侧已有
 * `resolveProductPaths` 这一套），不在 Viewer 的写入域里——见回执的跨域依赖一节。
 */
export function documentReferenceLocator(reference: unknown, base: unknown): { locator: string; based: boolean } {
  const text = typeof reference === "string" ? reference : ""
  if (!text) return { locator: text, based: false }
  if (hasLocatorScheme(text)) return { locator: text, based: false }
  if (typeof base === "string" && base) {
    try {
      return { locator: new URL(text, base).href, based: true }
    } catch {
      // 基址存在但当不了基准（`res:<指纹>` 是不透明路径）。这里**不抛**：调用方按 `based:false` 如实上报。
    }
  }
  return { locator: text, based: false }
}

/**
 * 文档引用 + `meshdir`/`texturedir` 目录前缀 → 交给解析器的引用。
 *
 * **已经定位符化的引用不再加前缀**：接线层把 `file` 换成 `res:<指纹>` 之后，它本身就是一条绝对定位符，
 * 再加 `meshdir` 会拼出 `meshes/res:<指纹>` —— 既不是标记也不是路径，媒体路由一条也匹配不上。
 * （官方 LIBERO 的派生文档没有 `meshdir`（原件是绝对 `file`），所以那条路上看不出这个坑；
 * 带 `meshdir` 的文档一旦被接线层改写就会踩到。）
 */
export function composeAssetReference(directory: unknown, file: unknown): string {
  const name = typeof file === "string" ? file : ""
  if (!name) return ""
  if (hasLocatorScheme(name)) return name
  const prefix = typeof directory === "string" ? directory : ""
  return prefix ? `${prefix}/${name}` : name
}

/** 文档资产段（`document.asset.mesh` 等）的两种容器形状：解析器给单条时是对象、多条时是数组。 */
const assetRows = (value: unknown): Record<string, unknown>[] =>
  value === undefined ? [] : Array.isArray(value) ? value.filter(row => typeof row === "object" && row !== null) as Record<string, unknown>[]
    : typeof value === "object" && value !== null ? [value as Record<string, unknown>] : []

/** 机器人视觉实体里本模块要用到的部分（结构化，不把整份 `Entity` 拖进来）。 */
export interface DocumentAssetEntity {
  resources?: readonly { original?: Representation; representations?: readonly Representation[] }[] | undefined
  components?: Record<string, unknown> | undefined
}

/** 一条配对结果：文档里的引用串 → 该引用对应的**已登记表示**（uri 与它声明的 mimeType）。 */
export interface DocumentAssetPairing { file: string; uri: string; mimeType: string }

/**
 * 接线层**早期形状**自写的后缀：`res:<指纹>?ext=.obj`。
 *
 * 产生端原文（`workbench.tsx` 旧 `:107-110`）是 `extension` 为真时写 `${token}?ext=.${extension}`、否则写 `${token}`，
 * 扩展名取自**改写前**的文档引用；它当时是为了让旧 Viewer 的"按扩展名选装载器"能认出格式。
 * 现在产生端已经不再写它（**P3-WIRING-REWORK**，`workbench.tsx:112` 只写纯标记），
 * 但**它写过的场景/产物仍会带着这个后缀进来**，接线层的 `viewerResourceURI` 也仍在兜这个历史形状 ——
 * 所以需要一份"历史形状长什么样"的**可调用说明**。 */
const WIRING_EXTENSION_SUFFIX = /\?ext=\.[A-Za-z0-9]+$/

/**
 * 历史形状的归一化：把接线层早期自写的 `?ext=.<格式名>` 后缀剥掉。
 * 剥完是空串（整串就是后缀那种病态输入）就原样返回，不制造空键。
 *
 * ⚠️ **本函数不参与配对**（Lead 裁定 §七之十八 ③）：`pairDocumentAssets` 里一处都不调用它，
 * 比较点是逐字相等。它留在这里只作**诊断／迁移**用 —— 要在历史产物上估"这条引用裸标记是什么"时
 * 可以调它；**配不配得上永远不由它决定**。别把它接回配对路径（接回去 = 产生端漂移再也看不见）。
 * `asset-locator-pairing.test.ts` 有一条用例专门钉住"配对判据不接受 `?ext=` 形状"。
 */
export function normalizeAssetLocator(value: unknown): string {
  const text = typeof value === "string" ? value : ""
  const base = text.replace(WIRING_EXTENSION_SUFFIX, "")
  return base || text
}

/**
 * **文档内引用 → 已登记表示**的配对判据（DEV-PROJ-01）。
 *
 * 与 P3 的接线层（`packages/lyapunov-shell/src/workbench.tsx:78-97` 的 `assetLocatorTokens`）是**同一套规则**，
 * 这里是它收敛后的唯一一份；两条判据都是**逐字相等**，没有一条靠猜：
 *  1. **直接命中**：引用串本身等于某条表示的 `uri`。接线层把 `file` 换成标记之后就是这个形状
 *     （它写的正是 `slice[index].uri`），所以投影 + 接线之后的官方场景走这一条。
 *     **它为什么成立**：投影之后两侧都是 `res:<指纹>`，而指纹是定位符串的纯函数（`assetMarkerOf`），
 *     所以"两个标记逐字相等"⟺"两份定位符逐字相等"。注意消费端这一步做的是**等值比较**：
 *     它手里只有标记、没有原像，**不能**（也不需要）重算指纹。要对原像重算，得由持有候选集的
 *     那一侧用 `resolveAssetMarker(marker, 原像候选集)` —— 媒体路由的 `admitResourceToken`
 *     就是这么做的。别把标记当黑盒，也别以为它可逆。
 *  2. **顺序配对**（生产者约定）：`representations = [派生文档] + [逐 mesh 一条] + [逐 texture 一条]`，
 *     且 `document.asset.<段>[i].file` 与镜像 `components.mujoco.<meshes|textures>[i].file` 逐字相等、
 *     段位 mimeType 形状（mesh 段不能是图片、texture 段必须是图片）也对得上。
 *     **三条同时成立才配**——任一条不成立就放弃，不拿别的资源顶替。
 *
 * ⚠️ **两条判据都不做归一化**（Lead 裁定 2026-09-27 §七之十八 ②③，`docs/REMAINING_WORK_PLAN.md:1245-1257`）：
 * 比较点只有**逐字相等**，`normalizeAssetLocator` **不在本函数的调用路径上**。改回去就是违反裁定。
 *
 * 为什么必须这样（不是洁癖，是**可测的后果**）：本模块曾经在比较前把两侧的 `?ext=` 后缀都剥掉，
 * 理由是"让匹配对形状漂移免疫"。**"免疫"与"看不见"是同一件事**：产生端哪天再写回 `?ext=`，
 * 消费端会把它静默吸收。真实语料四臂实测（`libero_goal-turn_on_the_stove`，10 实体 / 80 mesh 行 / 13 texture 行）：
 *
 * ```
 * 臂                                    声明表 / UNSUPPORTED / 建出网格
 * A 改前产生端(`?ext=`) + 严格消费端      0  /  82 / 157   ← 改前基线
 * B 当前产生端(纯标记) + 当前消费端       93 /   0 / 239
 * C 改前产生端(`?ext=`) + 带归一化消费端  93 /   0 / 239   ← 与 B【逐格相同】：错误被吸收
 * D 当前产生端(纯标记) + 严格消费端       93 /   0 / 239
 * ```
 * ⇒ 只看那三个数**分不出**"产生端修好了"与"消费端把错误吸收了"（C 与 D 同读数），
 * 归一化唯一的可测作用就是**遮住产生端漂移**。所以它撤出配对路径：留严格比较，
 * 让产生端漂移**看得见**（还原产生端 ⇒ 读数必须精确回到 A 那一行）。
 *
 * `normalizeAssetLocator` 仍然导出（诊断／迁移历史产物用），但它**不参与任何配对判定**；
 * 配对路径上调用它一次都算破坏这条判据（`asset-locator-pairing.test.ts` 与
 * `projection-consumer.test.ts` 的真链用例一起钉住这一点）。
 *
 * 配不上就返回空数组（用户自己的机器人没有那个 LIBERO 镜像，本来就不该走这一条）。
 */
export function pairDocumentAssets(entity: DocumentAssetEntity): DocumentAssetPairing[] {
  const visual = entity.components?.visual as { kind?: unknown; robot?: { document?: unknown } } | undefined
  const asset = (visual?.robot?.document as { asset?: Record<string, unknown> } | undefined)?.asset
  if (visual?.kind !== "robot" || !asset) return []
  const refs = entity.resources ?? []
  const representations: readonly Representation[] = refs.flatMap(ref => ref.representations ?? [])
  const direct = new Map<string, Representation>()
  for (const rep of [...representations, ...refs.map(ref => ref.original)]) {
    if (rep && typeof rep.uri === "string" && rep.uri) direct.set(rep.uri, rep)
  }
  const groups = [
    { key: "mesh", mirror: "meshes", image: false },
    { key: "texture", mirror: "textures", image: true },
  ] as const
  const listed = groups.map(group => ({ group, values: assetRows(asset[group.key]) }))
  // 顺序配对的成立判据（与接线层逐条对应）：条数 + 段位形状。
  const ordered = representations.length === 1 + listed.reduce((sum, item) => sum + item.values.length, 0)
    && (() => {
      let cursor = 1
      for (const { group, values } of listed) {
        const slice = representations.slice(cursor, cursor + values.length)
        cursor += values.length
        if (slice.some(rep => String(rep?.mimeType ?? "").startsWith("image/") !== group.image)) return false
      }
      return true
    })()
  const pairings: DocumentAssetPairing[] = []
  let cursor = 1
  for (const { group, values } of listed) {
    const slice = ordered ? representations.slice(cursor, cursor + values.length) : []
    cursor += values.length
    const mirror = assetRows((entity.components?.mujoco as Record<string, unknown> | undefined)?.[group.mirror])
    values.forEach((value, index) => {
      const file = typeof value.file === "string" ? value.file : ""
      if (!file) return
      const hit = direct.get(file)
      if (hit) { pairings.push({ file, uri: hit.uri, mimeType: String(hit.mimeType ?? "") }); return }
      const rep = slice[index]
      if (rep && typeof rep.uri === "string" && rep.uri && mirror[index]?.file === file)
        pairings.push({ file, uri: rep.uri, mimeType: String(rep.mimeType ?? "") })
    })
  }
  return pairings
}
