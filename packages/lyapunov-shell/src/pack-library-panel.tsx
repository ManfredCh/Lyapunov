import { useRef, useState, type CSSProperties } from "react"
import type { Translate } from "./entity-editor.tsx"
// 模型面的显示与取件口径**只有一份**（纯函数模块，宿主 pre-step 决策与这里共用，见 model-download-routing.ts）。
import { credentialRequirementText, fileCountText, formatBytes, modelFaceText, weightDownloadArgs, weightSource, type ModelRouteLike } from "./model-download-routing.ts"
// `policy.model` 的形状收束也是同一份（纯模块，浏览器安全）：面板与宿主的 policyModels 服务不会各收一套。
import { packModelFace } from "../../policy-registry/src/model-face.ts"
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
export function packSceneInstances(scene:SceneSnapshot|undefined,row:PackCatalogRow){const source=row.policy?.source;return (scene?.entities??[]).filter(e=>{const pack=e.components.packBinding as {packId?:string}|undefined,policy=e.components.policyBinding as {identity?:{provider?:string;modelId?:string;revision?:string}}|undefined;return pack?.packId===row.packId||Boolean(source&&policy?.identity&&source.provider===policy.identity.provider&&source.modelId===policy.identity.modelId&&source.revision===policy.identity.revision)})}

/**
 * 服务器能力包（`provider:"packs"`）在**现有机器人面板**里的最小入口：发现 → 取件 → 装配 →
 * 交给既有 `scene_import` 载入当前场景。面板自身不新增框架、不复用第二份状态：
 * 每一条都调既有的 `policy_search`/`policy_download`/`policy_prepare` 三个产品命令，
 * 载入动作交回 workbench 已有的 `scene_import + 选中` 路径（见 workbench.tsx 的 loadPackModel）。
 *
 * 只展示服务端**如实复算**的事实（routeKind/routeCode/pieces/权重来源）——不可用的包在这一行就写明原因，
 * 点击也按产品命令的真实错误码失败，不用"下一步字符串"冒充已加载。
 */
export interface PackCatalogRow {
  packId: string
  version?: string
  family?: string
  status?: string
  pieces?: Record<string, unknown>
  aliases?: Array<{ alias: string }>
  policy?: {
    mode?: string | null
    adapter?: string | null
    declaredStatus?: string | null
    routeKind?: string
    routeCode?: string | null
    /** 基础策略包的结构化权重来源（服务端 policyFace 给的事实，面板照实显示，用户不必背内部 id）。 */
    source?: { provider?: string; modelId?: string; revision?: string } | null
    weightsAvailability?: string | null
    /**
     * 模型面（**下载侧**事实，与执行侧各自独立）：形状由 `packModelFace` 收束，这里按 `unknown` 收，
     * 不假设端点给了什么——旧端点没这一块时面板要如实说"事实缺失"，不是"不可用"。
     */
    model?: unknown
  }
}
/** 本机权重缓存回执（`policy_files({cache:true})` 只读本地 manifest，不重算哈希、不访问来源）。 */
export interface PackCacheFact { status: string; files: number; bytes: number; updatedAt: string | null; error?: string }

const ROUTE_LABEL: Record<string, [string, string]> = {
  "direct-control": ["直控适配已登记（实例与世界待核，无需权重）", "Direct adapter registered (instance/world unchecked; no weights)"],
  "policy-source": ["基础策略（本机执行，权重按登记来源取件）", "Base policy (runs locally; weights from the registered source)"],
  "server-side-inference": ["服务端推理", "Server-side inference"],
  unavailable: ["不可用", "Unavailable"],
}

const WEIGHTS_LABEL: Record<string, [string, string]> = {
  bundled: ["随包", "bundled"],
  resolvable: ["按来源取件", "resolvable from source"],
  "server-side": ["留在服务端", "server-side only"],
  unavailable: ["取不到", "unavailable"],
}

const PIECES = ["asset", "context", "policy", "vla"] as const

/** 行内反馈占满一整行：`flexBasis:100%` 让它在允许换行的卡片里自成一行，长绝对路径按任意位置断行。 */
const FEEDBACK_LINE: CSSProperties = { flexBasis: "100%", minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }

/**
 * 件状态按**服务端实际给的形式**显示：catalog/discovery 给的是布尔（registry 台账），
 * 包内 pack.json 给的是字符串（ready / blocked:原因）。两者都不解释成"可用"——那是 route 的事。
 */
function pieceText(value: unknown, tr: Translate) {
  if (typeof value === "boolean") return value ? tr("已备", "ready") : tr("未备", "missing")
  if (typeof value === "string") return value
  return value && typeof value === "object" ? tr("按引用", "by ref") : "—"
}

const reasonText = (reason: unknown) => String(reason instanceof Error ? reason.message : reason)
/**
 * 一条反馈的归属：`panel` = 面板级（清单读取），`row` = 触发它的那一行。分两个显式形状而不是
 * 「packId 为空串」这种约定——约定写错时编译器不说话，而真实 CU 已经抓到过一次这种错配
 * （面板级反馈配上行键 ⇒ 提示根本不显示）。
 */
export type PackFeedback = { scope: "panel"; text: string } | { scope: "row"; packId: string; text: string }

export interface PackActionPorts {
  command(name: string, args: Record<string, unknown>): Promise<any>
  /**
   * 交既有 `scene_import` 载入并选中模型，**返回 Promise**：模型真的挂进场景后才 resolve，
   * 失败则 reject（面板据此保持忙态并显示真实错误，见 R1）。
   */
  load(modelPath: string, packId: string, provenance?:Record<string,unknown>): Promise<void>
}

/**
 * 「取件 → 装配 → 载入」的一次完整动作（面板与 workbench 之间唯一的异步契约）。
 *
 * 关键纪律（独立验收 R1/R3）：
 *  - **await 真实载入**：`load` 返回前本函数不 resolve，调用方因此不会在 `scene_import` 完成前清忙态、
 *    也不会把"开始载入"当成"已经载入"（假完成）；
 *  - **两条已支持的装配路由同等对待**：直控包交付 `modelEntry`；基础策略包（Go2/G1/Go1）装配成功返回
 *    `status=PREPARED` 与执行适配器用的机器人模型 `components.mujoco.sourcePath`——两者都是本次已校验
 *    缓存根下的绝对路径，都交给同一个 `scene_import`，不再对 PREPARED 无条件 throw；
 *  - 其余状态照实抛出产品返回的状态与路由（不吞、不替换成"下一步"）。
 */
export async function fetchPrepareLoad(ports: PackActionPorts, row: PackCatalogRow, tr: Translate): Promise<string> {
  const id = `packs/${row.packId}`
  const pulled = await ports.command("policy_download", { provider: "packs", modelId: id, pieces: [...PIECES] })
  const prepared = await ports.command("policy_prepare", { provider: "packs", modelId: id })
  const modelPath = typeof prepared?.modelEntry === "string" && prepared.modelEntry
    ? prepared.modelEntry
    : typeof prepared?.components?.mujoco?.sourcePath === "string" ? prepared.components.mujoco.sourcePath : ""
  if (!["PACK_DIRECT_CONTROL", "PREPARED", "ready"].includes(String(prepared?.status)) || !modelPath) {
    throw new Error(`${String(prepared?.status ?? "UNKNOWN")}: ${JSON.stringify(prepared?.route ?? prepared)}`)
  }
  await ports.load(modelPath, row.packId,{packId:row.packId,...row.version?{version:row.version}:{},source:prepared.route?.source??{provider:'packs',modelId:id}})
  const fetched = String(pulled?.status ?? "?")
  if (prepared.status === "PREPARED" || prepared.preparedMode === "policy") {
    if (!prepared.route) return tr(`${row.packId} 已取件并装配；模型已加入场景并选中。`, `${row.packId} fetched and prepared; the model was added to the scene and selected.`)
    const source = prepared?.route?.source
    const from = source ? `${source.provider}:${source.modelId}@${String(source.revision).slice(0, 12)}…` : tr("登记来源", "the registered source")
    return tr(
      `${row.packId} 已取件（${fetched}）并按执行适配器 ${String(prepared?.route?.adapterId ?? "?")} 装配（权重来源 ${from}，本机执行）；模型已加入场景并选中。`,
      `${row.packId} fetched (${fetched}) and prepared with adapter ${String(prepared?.route?.adapterId ?? "?")} (weights from ${from}, executed locally); the model was added to the scene and selected.`,
    )
  }
  return tr(
    `${row.packId} 已取件（${fetched}）并装配为直控路由（不需要权重，权重来源不适用）；模型已加入场景并选中。`,
    `${row.packId} fetched (${fetched}) and prepared as direct control (no weights involved); the model was added to the scene and selected.`,
  )
}

export function PackLibraryPanel({ available, canLoad, busy, tr, command, load,scene }: {
  scene?:SceneSnapshot
  available: boolean
  /** 当前会话有可编辑场景（没有时面板会先建一个，见 loadPackModel）。 */
  canLoad: boolean
  busy: boolean
  tr: Translate
  command(name: string, args: Record<string, unknown>): Promise<any>
  load(modelPath: string, packId: string, provenance?:Record<string,unknown>): Promise<void>
}) {
  const [rows, setRows] = useState<PackCatalogRow[] | null>(null)
  const [working, setWorking] = useState("")
  const [notice, setNotice] = useState<PackFeedback | null>(null)
  const [error, setError] = useState<PackFeedback | null>(null)
  /** 本机权重缓存事实：按 packId 存；读不到时留 error **不假装 0 件**（那是把"读不到"说成"没下过"）。 */
  const [cache, setCache] = useState<Record<string, PackCacheFact>>({})
  // 重入闸：`working` 是 state，同一帧内连点两次都能从按钮的 disabled 之前过去；用 ref 记住正在跑的那一行。
  const running = useRef("")
  /**
   * 一次动作的公共壳：忙态从**动作开始**保持到**动作真正结束**（含 scene_import 完成），
   * 错误留在触发它的那一行（`packId=null` 表示面板级动作，如清单读取）。
   * action 的 rejection 在这里被显示，不产生无人处理的 Promise。
   */
  const run = (packId: string | null, action: () => Promise<string>) => {
    if (running.current) return
    const marker = packId ?? "search"
    running.current = marker; setWorking(marker); setError(null); setNotice(null)
    const feedback = (text: string): PackFeedback => packId === null ? { scope: "panel", text } : { scope: "row", packId, text }
    void action()
      .then(text => setNotice(feedback(text)))
      .catch(reason => setError(feedback(reasonText(reason))))
      .finally(() => { running.current = ""; setWorking("") })
  }
  /** 一行变成模型路由条目（与宿主 policyModels 服务同一形状）⇒ 取件命令/文案复用同一份纯函数。 */
  const routeOf = (row: PackCatalogRow, fact: PackCacheFact | null): ModelRouteLike | null => {
    const model = packModelFace(row.policy?.model)
    return model ? { packId: row.packId, aliases: (row.aliases ?? []).map(item => item.alias), model, cache: fact ?? null } : null
  }
  /**
   * 权重缓存事实：只对有来源坐标的行读（`cache:true` 走本地 manifest，不联网、不重算哈希）。
   * **合并**进已有事实而不是整表替换：`pullWeights` 只读它点的那一行，若整表替换，其余行的缓存事实会被
   * 清成"未读"（实测出现过：点过一次 Go2 的下载后，G05 行的缓存变成"未读"）。返回**本次读到的那部分**。
   */
  const readCache = async (models: PackCatalogRow[]): Promise<Record<string, PackCacheFact>> => {
    const withSource = models.map(row => ({ row, model: packModelFace(row.policy?.model) })).filter(entry => entry.model?.source)
    const entries = await Promise.all(withSource.map(async ({ row, model }): Promise<[string, PackCacheFact]> => {
      const source = model!.source!
      try {
        const value = await command("policy_files", { provider: source.provider, modelId: source.modelId, revision: source.revision, cache: true })
        return [row.packId, { status: String(value?.status ?? "?"), files: Number(value?.files ?? 0), bytes: Number(value?.bytes ?? 0), updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null }]
      } catch (reason) { return [row.packId, { status: "UNREADABLE", files: 0, bytes: 0, updatedAt: null, error: reasonText(reason) }] }
    }))
    const read = Object.fromEntries(entries) as Record<string, PackCacheFact>
    setCache(previous => ({ ...previous, ...read }))
    return read
  }
  const search = () => run(null, async () => {
    // pageSize 取既有契约的上限（50）：面板要一次列出库里的全部包——默认 10 会把用户要找的那个漏掉。
    const value = await command("policy_search", { provider: "packs", query: "", pageSize: 50 })
    const models: PackCatalogRow[] = Array.isArray(value?.models) ? value.models : []
    setRows(models)
    await readCache(models)
    return tr(`${value?.plane === "public-discovery" ? "匿名发现" : "鉴权 catalog"}：${models.length} 个能力包`, `${value?.plane === "public-discovery" ? "Anonymous discovery" : "Authenticated catalog"}: ${models.length} packs`)
  })
  const pull = (row: PackCatalogRow) => run(row.packId, async () => {
    const pulled = await command("policy_download", { provider: "packs", modelId: `packs/${row.packId}`, pieces: [...PIECES] })
    return tr(`${row.packId} 已取件（${String(pulled?.status ?? "?")}），落本机缓存。`, `${row.packId} fetched (${String(pulled?.status ?? "?")}) into the local cache.`)
  })
  const loadPack = (row: PackCatalogRow) => run(row.packId, () => fetchPrepareLoad({ command, load }, row, tr))
  /**
   * 权重取件（**模型下载入口**）：一次显式点击 = 一次明确请求，按登记的**上游来源坐标与文件清单**
   * 调既有的 `policy_download`（不建第二套下载器，也不经小件 stream 拉权重）。取不到的包按钮就是
   * 禁用的，原因写在 title 里——点了也不会假装开始下载。
   */
  const pullWeights = (row: PackCatalogRow) => run(row.packId, async () => {
    const route = routeOf(row, cache[row.packId] ?? null)
    const args = route ? weightDownloadArgs(route) : null
    if (!route || !args) throw new Error(tr(`${row.packId} 没有可执行的权重取件路由（模型面未给出来源坐标与文件清单）。`, `${row.packId} has no runnable weight route (no source coordinates + file list in the model face).`))
    const pulled = await command("policy_download", args)
    // 反馈文案要写**取件之后**的缓存事实：拿取件前的 route 拼话会把刚落盘的 DOWNLOADED 说成"本机未下载"
    // （实测出现过：行内已是 DOWNLOADED，反馈行还写未下载）。
    const facts = await readCache([row])
    const after = routeOf(row, facts[row.packId] ?? cache[row.packId] ?? null) ?? route
    return tr(`${row.packId} 权重已取件（${String(pulled?.status ?? "?")}）：${modelFaceText(after)}；下载完成不等于可执行，执行侧看该包政策面。`,
      `${row.packId} weights fetched (${String(pulled?.status ?? "?")}): ${modelFaceText(after)}; a finished download does not mean the pack is runnable — see its policy face.`)
  })
  const busyRow = Boolean(working)
  return <div className="lya-domain" aria-label={tr("服务器能力包", "Server capability packs")}>
    <div className="lya-section"><span>{tr("服务器能力包", "Server capability packs")}</span><span className="lya-section-side">{rows?.length ?? 0}</span></div>
    <p className="lya-help">{tr("清单匿名可查；取件需登录账号，先落本机缓存再装配。直控包不需要权重；基础策略包的权重按登记来源取回，并在本机执行。", "The catalog is browsable anonymously; fetching needs a signed-in account and lands in the local cache before assembly. Direct-control packs need no weights; base-policy packs fetch weights from their registered source and run locally.")}</p>
    <div className="lya-row">
      <button disabled={!available || busyRow || busy} onClick={search} data-testid="lya-pack-search">{working === "search" ? tr("读取中…", "Loading…") : tr("读取能力包清单", "Read pack catalog")}</button>
    </div>
    {error?.scope === "panel" && <p className="lya-help lya-stop" data-lane="pack-error" role="alert">{error.text}</p>}
    {notice?.scope === "panel" && <p className="lya-help" data-lane="pack-notice">{notice.text}</p>}
    {rows?.map(row => {
      // 端点没给 policy 块时**不能**回落成"不可用"——那是把「我们不知道」说成「这包不行」。
      // 如实显示"事实缺失"，点击仍走产品命令的真实错误码。
      const route = String(row.policy?.routeKind ?? "")
      const known = Boolean(row.policy)
      const label = known ? (ROUTE_LABEL[route] ?? [route, route]) : [tr("端点未给政策面事实", "Endpoint gave no policy face"), "no policy face"]
      const direct = route === "direct-control"
      const supported = direct || route === "policy-source"
      // 政策面已明说不可用的包：装配必然失败（真实 CU 里 SO101 就是这样）。按钮不再装作可用，
      // 原因写在 title 里；要看服务端的真实错误码点「仅取件」，那一条的路由不受影响。
      const loadable = known ? supported : true
      const source = row.policy?.source
      const weights = row.policy?.weightsAvailability ? WEIGHTS_LABEL[String(row.policy.weightsAvailability)] : undefined
      // 模型面（下载侧）：端点没给 ⇒ 如实说"事实缺失"；给了但取不到 ⇒ 写明 code/detail，不给下载入口。
      const face = packModelFace(row.policy?.model)
      const modelRoute = routeOf(row, cache[row.packId] ?? null)
      const wsource = modelRoute ? weightSource(modelRoute) : null
      const fact = cache[row.packId]
      const cacheText = !fact ? tr("缓存未读", "cache not read")
        : fact.status === "UNREADABLE" ? tr(`缓存读不到（${fact.error ?? "?"}）`, `cache unreadable (${fact.error ?? "?"})`)
          : fact.status === "NOT_DOWNLOADED" ? tr("本机未下载", "not downloaded locally")
            : tr(`${fact.status}：${fact.files} 件 / ${formatBytes(fact.bytes)}`, `${fact.status}: ${fact.files} files / ${formatBytes(fact.bytes)}`)
      /**
       * 本卡片是本文件唯一会往卡片里**追加反馈行**的：共享 `.lya-env-card` 是 flex 且默认 nowrap，
       * 反馈行会被当成横向的第三项——真实 CU 里卡片 259px、反馈 649px，包名区被挤成 0 宽、反馈溢出卡片。
       * 只在这一处局部放行换行，不改共享卡片样式（其他面板的卡片没有卡片内反馈）。
       */
      return <div className="lya-env-card" style={{flexWrap:"wrap"}} key={row.packId} data-testid={`lya-pack-${row.packId}`}>
        <div className="lya-env-main" title={row.packId}>
          <strong>{row.packId}</strong>
          <span className="lya-help">{packSceneInstances(scene,row).length?tr(`当前场景已放置 ${packSceneInstances(scene,row).length} 个实例`,`Placed in this scene: ${packSceneInstances(scene,row).length}`):tr('尚未放置，可加入当前场景','Not placed; available to add')} · {cache[row.packId]?.status==='DOWNLOADED'?tr('权重缓存已取件；完整包与实例兼容待核','Weights cached; complete bundle and instance compatibility unchecked'):tr('本机权重取件状态待核','Local weight download unchecked')}</span>
          <span>{row.family ?? "—"}{row.version ? ` · ${row.version}` : ""}{row.status ? ` · ${row.status}` : ""}</span>
          <span className={direct ? "lya-help" : "lya-asset-requirement"}>{label[0]}{row.policy?.routeCode ? `（${row.policy.routeCode}）` : ""}{row.policy?.declaredStatus ? ` · policy ${row.policy.declaredStatus}` : ""}</span>
          {source && <span className="lya-help">{tr("权重来源", "Weights from")}：{Source(source)}{weights ? ` · ${tr(weights[0], weights[1])}` : ""}</span>}
          {/* 模型面：来源坐标 / 文件清单 / 字节 / 能不能取 / 本机缓存到哪一步——「可下载」与「可执行」分开写。 */}
          {face ? <span className={wsource ? "lya-help" : "lya-asset-requirement"} data-lane={`pack-model-${row.packId}`}>
            {tr("模型", "Model")}：{modelRoute ? modelFaceText(modelRoute) : `${face.source ? `${face.source.provider}:${face.source.modelId}` : tr("未登记来源", "no source")}，${fileCountText(face.files)} / ${formatBytes(face.bytes)}${credentialRequirementText(face.requiresAuth)}`}
            {wsource ? "" : ` · ${tr("不可下载", "not downloadable")}：${face.code ?? tr("未给原因", "no reason")}`}
            {/* 缓存事实在 modelFaceText 里已经有一份口径；这里只在**读不到**时补原因，且只在有来源坐标
                （缓存按来源坐标定位，无坐标就无从读起）时补——不重复、也不把"无从读起"说成"未读"。 */}
            {face.source && (!fact || fact.status === "UNREADABLE") ? ` · ${tr("缓存", "cache")} ${cacheText}` : ""}
          </span> : row.policy ? <span className="lya-help" data-lane={`pack-model-${row.packId}`}>{tr("端点未给模型面", "Endpoint gave no model face")}</span> : null}
          <span className="lya-help">{PIECES.map(piece => `${piece}=${pieceText(row.pieces?.[piece], tr)}`).join(" · ")}</span>
          {row.aliases && row.aliases.length > 0 && <span className="lya-help">{tr("别名", "Aliases")}：{row.aliases.slice(0, 4).map(item => item.alias).join(" / ")}</span>}
        </div>
        <div className="lya-env-actions">
          {/* 模型下载入口：只有模型的来源坐标 + 文件清单齐备、且内容侧没声明门禁时才可点。
              取不到时禁用并给出真实 code/detail（不换源、不编 URL、不说成"稍后可用"）。 */}
          {face && <button className="lya-chip" disabled={!available || !wsource || busyRow || busy}
            title={wsource ? tr(`按登记来源取权重到本机缓存：${face.source!.provider}:${face.source!.modelId}@${String(face.source!.revision).slice(0, 12)}…（${fileCountText(face.files)} / ${formatBytes(face.bytes)}）${credentialRequirementText(face.requiresAuth)}`, `Fetch weights into the local cache from the registered source: ${face.source!.provider}:${face.source!.modelId}@${String(face.source!.revision).slice(0, 12)}… (${fileCountText(face.files, 'en')} / ${formatBytes(face.bytes)})${credentialRequirementText(face.requiresAuth, 'en')}`)
              : tr(`取不到：${face.code ?? "未给原因"}${face.detail ? `（${face.detail}）` : ""}`, `Not fetchable: ${face.code ?? "no reason"}${face.detail ? ` (${face.detail})` : ""}`)}
            onClick={() => pullWeights(row)} data-testid={`lya-pack-weights-${row.packId}`}>{tr("下载权重", "Fetch weights")}</button>}
          <button className="lya-chip" disabled={!available || busyRow || busy} onClick={() => pull(row)} data-testid={`lya-pack-pull-${row.packId}`}>{tr("仅取件", "Fetch")}</button>
          <button className="lya-chip lya-chip-accent" disabled={!available || !canLoad || !loadable || busyRow || busy}
            title={!loadable ? tr(`端点已判该包政策面不可用（${row.policy?.routeCode ?? "unavailable"}）：装配必然失败，故不再提供该入口。要核对服务端的真实错误码，点左边「仅取件」。`, `The endpoint reports this pack's policy face as unavailable (${row.policy?.routeCode ?? "unavailable"}); assembly cannot succeed. Use Fetch to see the server's real error code.`)
              : direct ? tr("取件、装配为直控路由（不需要权重）并载入模型", "Fetch, prepare as direct control (no weights) and load the model")
                : route === "policy-source" ? tr("取件、按登记适配器装配（权重按本行来源取回）并载入机器人模型", "Fetch, prepare with the registered adapter (weights from the source on this row) and load the robot model")
                  : tr("取件、装配并载入模型", "Fetch, prepare and load the model")}
            onClick={() => loadPack(row)} data-testid={`lya-pack-load-${row.packId}`}>{route === "policy-source" ? tr("取件、装配并载入", "Fetch, prepare and load") : tr("取件并载入", "Fetch and load")}</button>
        </div>
        {/* 反馈留在**这一行**（用户点的是这里），不再追加到 32 行列表末尾。
            占满独立一整行（flexBasis 100%）：否则它会去挤上面那行的包名区；长绝对路径可断行。 */}
        {error?.scope === "row" && error.packId === row.packId && <p className="lya-help lya-stop" style={FEEDBACK_LINE} data-lane="pack-error" role="alert">{error.text}</p>}
        {notice?.scope === "row" && notice.packId === row.packId && <p className="lya-help" style={FEEDBACK_LINE} data-lane="pack-notice">{notice.text}</p>}
      </div>
    })}
    {rows?.length === 0 && <p className="lya-help">{tr("清单为空：当前端点没有可用的能力包。", "The catalog is empty: this endpoint has no packs.")}</p>}
  </div>
}

/** 权重来源的单行口径：provider:modelId@revision（截断只截 revision，取件要用完整来源坐标时看这一行）。 */
function Source(source: { provider?: string; modelId?: string; revision?: string }) {
  return `${source.provider ?? "?"}:${source.modelId ?? "?"}@${String(source.revision ?? "").slice(0, 12)}…`
}
