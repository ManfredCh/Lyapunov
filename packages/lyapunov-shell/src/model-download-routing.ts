/**
 * 「模型面」的**共享形状与显示/取件口径**：一个包提供哪些模型、权重从哪个上游来源取、按哪份清单取，
 * 以及这些事实该怎么显示（来源坐标、件数、字节、取件前提、落盘状态）。
 *
 * 消费者只有一处：包面板 `pack-library-panel.tsx`（浏览器侧，只有 catalog 行 + `policy_files` 的缓存回执）；
 * 面板用它拼 `policy_download` 的参数、渲染中英文文案，这些口径在本仓库只有这一份。
 *
 * **本模块不是每步判定处**：客户端曾经按步判定"这步到底要不要下载权重"的那一层（JEV 结构化选择题
 * `jev-context-routing.ts`，以及 `plugin.ts` 里的调用）已经删除；这里不再决定任何事，也不产生任何给模型
 * 看的提示文本——只剩形状（`ModelRouteLike`）与纯显示/参数辅助函数。
 *
 * 仍在用的几条口径（面板照此显示，不另立一套）：
 *  - **上游来源才有权重**：`packs` 是小件四件套流，权重不走那里（合同 §0.5）⇒ `weightSource` 不给坐标；
 *    来源缺失分三种说（有坐标 / 没坐标但登记了来源说明 / 真没登记），缓存三态分开（未读到 ≠ 没下过）。
 *  - **件数只说选择项，不猜展开后的件数**：以 `/` 结尾的是目录选择项，真实文件数由固定来源清单决定
 *    （把 π0.5 的 2 个前缀写成"2 件权重"是假读数）。
 *  - **「可下载」与「可执行」分开说**：本模块只讲字节；能不能跑由包政策面 routeKind/routeCode 决定。
 */
import type { PackModelFace } from '../../policy-registry/src/pack-contract.ts'

/**
 * 判定只需要"包身份 + 模型面 + 本机缓存"这三样：写成**最小形状**而不是直接依赖 `PackModelRoute`，
 * 面板（浏览器侧，只有 catalog 行 + `policy_files` 的缓存回执）才能用**同一份**函数拼命令、写文案，
 * 不至于宿主机说一套、界面说另一套。`PackModelRoute` 在结构上可直接传入。
 */
export interface ModelRouteLike {
  packId: string
  aliases: readonly string[]
  model: PackModelFace
  cache: { status: string; files: number; bytes: number } | null
}

/** 权重取件的**上游**来源坐标：packs 源是小件流，权重不走那里（合同 §0.5），故不算可取件。 */
export const weightSource = (route: ModelRouteLike) => {
  const source = route.model.source
  return route.model.downloadable && source && source.provider !== 'packs' ? source : null
}

/**
 * 取件选择项的两类写法（与 `policy-registry/src/source.ts` 的 `policyFileSelector` 同一约定，
 * 但不 import 那个模块——它带 `node:fs`，而本模块要进浏览器包）：以 `/` 结尾的是**目录选择项**
 * （来源侧按前缀在来源的**真实清单**上展开成一批文件，见 `selectSourceFiles`），其余是精确文件路径。
 *
 * 既是取件参数的事实，也是**文案的口径**：π0.5 的 `["assets/","params/"]` 是 2 个目录选择项，在固定
 * 提交的清单上实际选中 29 件——写成"2 件权重"是假读数；G0.5 的 4 条精确路径确实是"4 件"。客户端
 * **只数选择项，不猜展开后的件数**（展开多少由固定来源清单决定，客户端不该凭空算一个数字出来）。
 */
const isDirectorySelector = (file: string) => file.endsWith('/')
/** 件数的单行说法：选择项全是精确文件 ⇒ 「N 件」；含目录选择项 ⇒ 说清有几项、真实文件数由来源清单定。 */
export function fileCountText(files: readonly string[], lang: 'zh' | 'en' = 'zh'): string {
  const selectors = files.filter(isDirectorySelector).length
  const exact = files.length - selectors
  if (!selectors) return lang === 'en' ? `${exact} file${exact === 1 ? '' : 's'}` : `${exact} 件`
  const directories = lang === 'en'
    ? `${selectors} directory selector${selectors === 1 ? '' : 's'} (the actual files are fixed by the source manifest)`
    : `${selectors} 个目录选择项（实际文件由固定来源清单确定）`
  if (!exact) return directories
  return lang === 'en' ? `${exact} file${exact === 1 ? '' : 's'} + ${directories}` : `${exact} 件 + ${directories}`
}
/** 人类可读的字节数（只用于提示里的量级，判定不看它）。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '字节数未登记'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
/**
 * 权重取件的**参数**（唯一一份）：面板按钮直接拿它调 `policy_download`，注入提示拿它的字符串形式。
 * 两处同源，界面里点的和提示里叫模型调的是同一条命令。
 */
export function weightDownloadArgs(route: ModelRouteLike): Record<string, unknown> | null {
  const source = weightSource(route)
  if (!source || !route.model.files.length) return null
  return { provider: source.provider, modelId: source.modelId, revision: source.revision, files: [...route.model.files] }
}
/**
 * 取件**前提**的可见说法：来源声明的是凭据**种类**（内容侧事实），这里只把它翻成用户该准备什么。
 * 中英两份放在同一处（面板与决策共读，不各写一套）；未登记的种别原样带出（不编解释）。
 * 这是**非阻断**的——它说"点之前要知道什么"，不说"取不到"。
 */
const CREDENTIAL_REQUIREMENT_TEXT: Record<string, readonly [string, string]> = {
  'huggingface-token': ['需本机 HF 授权（HF_TOKEN 或本机 HF 登录缓存）', 'needs local HF authorization (HF_TOKEN or the local HF login cache)'],
}
export const credentialRequirementText = (requiresAuth: string | null, lang: 'zh' | 'en' = 'zh'): string => {
  if (!requiresAuth) return ''
  const text = CREDENTIAL_REQUIREMENT_TEXT[requiresAuth]
  return lang === 'en' ? `; ${text ? text[1] : `needs a local credential: ${requiresAuth}`}` : `；${text ? text[0] : `需本机凭据：${requiresAuth}`}`
}
/**
 * 模型面事实的单行描述（来源/件数/字节/取件前提/落盘状态），提示语与面板共用同一份口径。
 * 件数走 `fileCountText`：目录选择项（`前缀/`）不数成"件"（把 π0.5 的 2 个前缀写成"2 件权重"是假读数）。
 * 三种"来源缺失"分开说，不含糊：**没有登记坐标但登记了来源说明**（如 π0.5 的 gs:// 检查点）时把那句
 * 说明原样带出——它是内容侧的**事实**，不是可下载地址；只有这样才不会被读成"这个包没写来源"。
 * 缓存三态同样分开：未读到（null）≠ 没下过（NOT_DOWNLOADED）——把"读不到"说成"没下过"是假读数。
 */
export function modelFaceText(route: ModelRouteLike): string {
  const source = weightSource(route) ?? route.model.source
  const provenance = route.model.provenance
  const from = source
    ? `${source.provider}:${source.modelId}@${source.revision.slice(0, 12)}…`
    : provenance
      ? `未登记可校验取件坐标（登记来源说明：${provenance.length > 60 ? provenance.slice(0, 60) + '…' : provenance}）`
      : '未登记来源坐标'
  // 无来源坐标时缓存无从读起（`policy_files({cache:true})` 按来源坐标定位缓存目录），故不写缓存结论。
  const cached = !source ? ''
    : route.cache === null ? '；本机缓存未读'
      : route.cache.status === 'NOT_DOWNLOADED' ? '；本机未下载'
        : `；本机缓存 ${route.cache.status}（${route.cache.files} 件 / ${formatBytes(route.cache.bytes)}）`
  return `${route.packId}：${from}，${fileCountText(route.model.files)} / ${formatBytes(route.model.bytes)}${credentialRequirementText(route.model.requiresAuth)}${cached}`
}
