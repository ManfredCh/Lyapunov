/**
 * DEV-PRIV-01：发行隐私数据边界的产品侧唯一判据（纯函数、浏览器安全、零 node 内置）。
 *
 * 三个消费者各有各的合法字段范围，**没有 `{public, result}` 兜底**：
 *  · 模型   —— 服务端保留全量（工具 `output.render` 与 session 日志不动，模型上下文由日志重建）；
 *  · 机器 UI —— `uiCommandFields` 逐命令白名单（面板续链真正读过的字段才留）；
 *  · 人类   —— `publicCommandFace` / `publicCommandError`（卡片、截图、回放、诊断导出共用）。
 *
 * 判定在**服务端出站投影点**生效（见 `session-event-projection.ts` 与 shell 命令路由），
 * 不是 CSS 藏、不是换个字段名：浏览器载荷里根本没有内部原文。
 */

import { productRelativePath, projectResourceTokens, resourceToken, type ProductPathRoots } from "./product-paths.ts"

const EMPTY_ROOTS: ProductPathRoots = {}

/** 人类面永不出现的字段名（递归丢弃；机器面另有白名单，比这更严）。 */
export const INTERNAL_FIELD_NAMES: readonly string[] = [
  // 写给模型的行动指引（把内部工作流与计费语义教给用户的东西）
  "nextSteps",
  // 打分细节 / 目录 / 取件与计费链 / 服务架构
  "matchedBy", "plane", "endpoint", "endpoints", "mount", "mountId", "mountSnapshot", "openMountSnapshot",
  "cas", "casEntry", "catalog", "catalogRows", "aliases", "aliasDictionary", "controlPath", "inference", "stack",
  // 来源 pin（逐文件哈希 / 提交清单）
  "sha256", "gitBlob", "manifestPath", "sourceFiles",
  // 凭据形状（值另由 redactSecretsText 兜一层）
  "token", "authorization", "bearer", "packToken", "accountToken", "apiKey", "apikey", "password", "secret",
  // 内部诊断回执
  "issues", "differences", "differencesDetail", "routed", "physicalization",
]

const normalizedInternalFields = new Set(INTERNAL_FIELD_NAMES.map(name => name.replace(/[-_]/g, "").toLowerCase()))

/** 同一内部字段的大小写和下划线写法使用相同边界，不能依赖凭据值长得像某家 API key。 */
export function isInternalFieldName(name: string): boolean {
  return normalizedInternalFields.has(name.replace(/[-_]/g, "").toLowerCase())
}
/**
 * 能力包**产品词表**（packId / modelId / adapterId / weights*）不是秘密：面板与卡片都要叫得出包名，
 * 只是人类面不打印来源 pin、别名表与端点。真正要挡的是上面那份 INTERNAL_FIELD_NAMES。
 */

/** 内部状态枚举 / 错误码：人类面一律换成稳定公开码，绝不逐字上屏。 */
const INTERNAL_TOKENS: readonly RegExp[] = [
  /\bPACK_[A-Z0-9_]+\b/g,
  /\bLISTED_FROM_MOUNT_SNAPSHOT\b/g,
  /\bMANIFEST_[A-Z0-9_]+\b/g,
  /\bPOLICY_[A-Z0-9_]+\b/g,
  /\bSCENE_[A-Z0-9_]+\b/g,
  /\bVIEWER_[A-Z0-9_]+\b/g,
  /\bCOMMAND_UNAVAILABLE\b/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g,
]

/** 内部名词（服务架构 / 计费链 / 取件面）：人类文案换中性说法。 */
const INTERNAL_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/账号消费链/g, "账号链路"],
  [/计费\s*mount/g, "取件会话"],
  [/mount\s*快照/g, "取件快照"],
  [/authenticated-catalog/g, "已鉴权目录"],
  [/public-discovery/g, "公开目录"],
  [/api\.(?:[a-z0-9-]+\.)+[a-z]{2,}/gi, "服务端"],
  [/https?:\/\/\S+/g, "服务端"],
]

/** 凭据形状（值一律替换，不看字段名）：只有环境变量**名**允许出现在文本里。 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk|hf|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:PACK_TOKEN|LYAPUNOV_ACCOUNT_TOKEN|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|IMAGE_API_KEY|TRIPO_API_KEY|HUNYUAN_API_KEY|MARBLE_API_KEY)\s*[=:]\s*\S+/g,
]

export const REDACTED = "[已脱敏]"

/** 可复算的产品引用（浏览器只持有它，绝对路径在服务端派发前才展开）。 */
export const PRODUCT_REF_PREFIX = "lyapunov-ref:"

/**
 * 文本里**内嵌**的绝对路径（错误原因串、说明行里的 `/home/alice/…`）同样 basename 化：
 * 路径键改写不够，人话句子里的路径才是截图分享时最常带出的那一份。
 * 域引用（`captures/…`）与 URL（已被中性化）不匹配这条规则。
 */
export function scrubAbsolutePaths(text: string): string {
  // 只在**词边界**处匹配绝对路径：产品引用 `captures/sessions/<键>/<id>.png` 这种
  // 带斜杠的相对项不能被当成路径尾巴裁掉（那是可复算定位符，裁了就找不回文件）。
  return text.replace(/(^|[\s"'`（(，,：:；;、\[])((?:[A-Za-z]:)?[\\/](?:[\w.@+-]+[\\/])+[\w.@+-]+)/g, (_match, lead: string, path: string) => {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    const base = cut >= 0 ? path.slice(cut + 1) : path
    return lead + (base && base !== path ? base : path)
  })
}

/** 文本里去掉凭据形状；只留环境变量名，不留值。 */
export function redactSecretsText(text: string): string {
  let out = text
  for (const shape of SECRET_SHAPES) out = out.replace(shape, match => {
    const name = /^([A-Z_]{3,})\s*[=:]/.exec(match)?.[1]
    return name ? `${name}=${REDACTED}` : REDACTED
  })
  return out
}

/**
 * 人类可读路径：绝对路径一律 basename 化；产品引用原样保留（它不含用户目录结构）。
 * 用户自己写下的相对路径照旧，不猜、不改写。
 */
export function displayPath(value: unknown): string {
  const text = String(value ?? "")
  if (!text) return ""
  if (text.startsWith(PRODUCT_REF_PREFIX)) return text
  const cleaned = scrubAbsolutePaths(redactSecretsText(text))
  const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(cleaned)
  if (!absolute) return cleaned
  const cut = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"))
  return cut >= 0 ? cleaned.slice(cut + 1) || cleaned : cleaned
}

/**
 * 去掉栈痕迹（` at node:internal/…`、`/home/alice/x.ts:12:3`、`\n^` 源码行）：
 * 服务端**本来**就只写 `error.message`（`commands/src/index.ts:settleThrown`），
 * 这条是人类面的兜底——诊断导出与卡片都走这里，栈只进 Host 日志。
 */
export function stripStack(text: string): string {
  return text
    .split("\n")
    .filter(line => !/^\s*at\s+\S/.test(line) && !/^\s*[~^|]/.test(line))
    .join(" ")
    .trim()
}

/**
 * **错误码的形状**：单个全大写的下划线标识符、至少两段（`PACK_NOT_DOWNLOADED`、`POLICY_REMOTE_403`、
 * `CUA_CLIPBOARD_READ_REFUSED`）—— 就是本仓 `throw new Error("<码>: 人话")` 里那一段。
 */
const ERROR_CODE_TEXT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

/**
 * 取**结构化**的错误码：`<码>` / `<码>: 人话` / `<码>：人话` 三种形状里的那个码；形状不符 ⇒ `undefined`。
 *
 * 为什么**形状判据必须排在消息正则之前**（`SHARE-STATUS-SHAPE-20260926.md` §1.3 是同一形状的实测现场）：
 * 失败回执的形状是 `<码>: 人话`，而"人话"里常带**上游 URL、上游报文与文件路径**。在整条消息里搜词，
 * 判据就落在这些**不受控文本**上 —— 那条 lane 实测到「诊断消息第二行是 `…/ACCOUNT/v1/me`
 * ⇒ 上游 503 被抢成 401『请重新登录』」，用户的下一步动作与真实故障**完全相反**。
 *
 * 本函数**只看第一个冒号之前那一段**，并要求它**整段**是一个码：URL、上游正文、人话一个字都不参与判定。
 * 取不到码就返回 `undefined` —— 本函数不猜、也不返回"最像的那个词"（调用方按自己的兜底处置）。
 */
export function publicErrorCodeToken(text: string): string | undefined {
  const cut = text.search(/[:：]/)
  const head = (cut < 0 ? text : text.slice(0, cut)).trim()
  return ERROR_CODE_TEXT.test(head) ? head : undefined
}

/**
 * 码里出现在**整段**上的 HTTP 状态数字 → 公开码。
 *
 * 这不是新判据：改前的 `/PAYMENT_REQUIRED|402/` **本来就是一条"按码里的数字判"的规则**，只是只写了 402。
 * 这里把同一条规则按整段补齐到本仓真实存在的另外两个（`POLICY_REMOTE_403`、`NETWORK_ASSET_HTTP_404`…
 * 见回执 §②的枚举读数：全仓 src 里整段出现的状态数字只有 402/403/404/410 四个）。
 * `410` **不登记**：本仓只有 1 处（`NETWORK_ASSET_HTTP_410`），没有任何产品侧判据要求把它归到哪一类，
 * 按改前原样落 `P500` —— 不为了让表好看而发明映射。
 */
const PUBLIC_CODE_BY_STATUS_SEGMENT: ReadonlyMap<string, string> = new Map([
  ["402", "P402"], ["403", "P403"], ["404", "P404"],
])

/**
 * **段级**词表：整段相等才算；两段以上的短语要求**相邻且逐段相等**。
 *
 * 为什么不是子串：改前的 `/…|DECLARED/` 会命中 `UNDECLARED` 这个**不同的段**。语义上两者都是
 * "声明不对" ⇒ 这里把两段都登记成 P422，于是那 9 个 `*_UNDECLARED` 码的答案**一个字不改**。
 * 这一条是**不许放宽**的关键：漏掉 `UNDECLARED` 会让它们掉进 `P500`，而 `P500` 那一支的文案是
 * **回显原始消息**（见 `publicErrorMessage`）—— 那既是误判、也是泄漏。
 *
 * 顺序与改前的四条正则**逐条一致**（P402 → P404 → P422 → P403，先命中先返回），所以只改了"怎么比"，
 * 没有改"谁优先"。
 *
 * ⚠️ 一次**已撤销**的改判（W22-R2，2026-09-27 03:38–03:42，由并发 lane 落盘）：曾把 `UNAVAILABLE`
 * 移出 P422 ⇒ `X_UNAVAILABLE` 一族（全码形状 token 宇宙里 **82** 个码）从**固定句**改到 `P500` 的
 * **回显支**。Lead 更正裁定【撤销】，四条依据：
 *   ① **方向**——本单目的是"更少落 P500 = 更少回显"，这一条把净方向从 **−4** 翻成 **+80/+66**；
 *   ② **判据面**——冻结的 15 条判据（`ADMIN_SERVICE_UNAVAILABLE` 钉 P422）在它之下**永远不可能 15/0**；
 *   ③ **代价实测**——这一族里约 20 个真实码会回显**插入的内部值**（环境变量名 / PROJ 版本与运算名 /
 *      宿主引擎配置 / 上游档位错误串；脱敏层是生效的，但上面那些是**插入值**）；
 *   ④ 本仓公开码值域只有 5 个（P402/P404/P422/P403/P500，判据里有钉子），那是**契约**，
 *      不该由一条并发 lane 顺手改。
 * **反向的诚实（保留）**：P422 那句**不是处处为假** —— `CLIPBOARD_UNAVAILABLE: Wayland需要wl-paste…`、
 * `PROVIDER_UNAVAILABLE: 设置 LYAPUNOV_ALGORITHM_PYTHON…` 这类"**改自己的环境再重试**"是正确动作。
 * ⇒ 撤销 = 恢复到**回显面最小**，不是"恢复到完美"；"P422 对 `X_UNAVAILABLE` 说假话"若确实值得修，
 * 正解是**新增第 6 个公开码（P503）的独立立项**（契约变更），本单不做（Lead 已登记为待办）。
 */
const PUBLIC_CODE_BY_SEGMENTS: ReadonlyArray<readonly [string, readonly (readonly string[])[]]> = [
  ["P402", [["PAYMENT", "REQUIRED"]]],
  ["P404", [["NOT", "FOUND"], ["NOT", "DOWNLOADED"], ["NO", "MATCH"], ["MISSING"]]],
  ["P422", [["INVALID"], ["UNAVAILABLE"], ["UNSUPPORTED"], ["DECLARED"], ["UNDECLARED"]]],
  ["P403", [["BLOCKED"], ["DENIED"], ["UNAUTHORIZED"], ["FORBIDDEN"], ["EXPIRED"], ["INTEGRITY"]]],
]

/**
 * **逐码例外**：完整码 → 公开码。段级词表回答"这**一类**码是什么"，这里回答"这**一个**码是什么"；
 * 只有当某个码的语义与它自己的段所表示的类别**不符**时才登记，逐行给依据。
 *
 * 为什么必须有这一层（`INVALID` 段的两处例外）：
 *   `INVALID` 段说的是"**调用方送来的东西**不合法" ⇒ P422「请求内容不符合要求，请调整后重试」。
 *   但这三个语义是**本机/账户侧**的配置或身份不对，调用方"调整请求内容"一个字也修不好它
 *   —— 与 `SHARE-STATUS-SHAPE-20260926.md` §1.3(b) 那条「本机配置错被说成 401 ⇒ 凭据没问题、
 *   重新登录修不好它」是同一个形状。⇒ 落到 P500「操作失败」并显示**脱敏后的真实那一句**。
 * 依据（本仓真实抛出点，逐字）：
 *   · `INVALID_ACCOUNT_API_URL` —— `lyapunov-api-client/src/generation.ts:60`（账户 API 的 base URL
 *     没配/配错；该处 `throw new Error("INVALID_ACCOUNT_API_URL")` 连人话都没带）；
 *   · `INVALID_ACCOUNT_IDENTITY` —— 同文件 `:70` 与 `lyapunov-product-bundle/src/account/formal.ts:16`
 *     （账户 API 没有返回有效身份）。
 */
const PUBLIC_CODE_BY_CODE: ReadonlyMap<string, string> = new Map<string, string>([
  ["INVALID_ACCOUNT_API_URL", "P500"],
  ["INVALID_ACCOUNT_IDENTITY", "P500"],
  // Isaac 启动环境/配置故障不由调整模型请求修复。只改这些完整码，
  // 其余 UNAVAILABLE 家族保留原合同；人类面固定说明，不回显 SDK 路径。
  ["ISAAC_SDK_UNAVAILABLE", "P500"],
  ["ISAAC_SDK_VERSION_INCOMPATIBLE", "P500"],
  ["ISAAC_LICENSE_CONFIRMATION_REQUIRED", "P500"],
  ["ISAAC_ENGINE_CONFIG_UNSUPPORTED", "P500"],
  ["ISAAC_GPU_DEVICE_UNAVAILABLE", "P500"],
  ["ISAAC_KIT_START_FAILED", "P500"],
  ["ISAAC_EXTENSION_UNAVAILABLE", "P500"],
  ["ISAAC_PHYSX_UNAVAILABLE", "P500"],
  ["ASSET_BAKE_DEPENDENCY_UNAVAILABLE", "P500"],
])

/** 段序列里有没有**连续**的 `phrase`（逐段相等，不做子串匹配）。 */
function hasSegmentPhrase(segments: readonly string[], phrase: readonly string[]): boolean {
  for (let start = 0; start + phrase.length <= segments.length; start += 1) {
    let hit = true
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (segments[start + offset] !== phrase[offset]) { hit = false; break }
    }
    if (hit) return true
  }
  return false
}

/**
 * **码** → 稳定公开码。判据是这个码的**段**（以及码里整段出现的状态数字），**不看任何消息文本**。
 * 传进来的必须已经是码（用 `publicErrorCodeToken` 取），传别的串回去查词表 —— 那是调用方的错用。
 */
export function publicErrorCodeOfToken(code: string): string {
  const exact = PUBLIC_CODE_BY_CODE.get(code)
  if (exact) return exact
  const segments = code.split("_")
  for (const segment of segments) {
    const byStatus = PUBLIC_CODE_BY_STATUS_SEGMENT.get(segment)
    if (byStatus) return byStatus
  }
  for (const [publicCode, phrases] of PUBLIC_CODE_BY_SEGMENTS) {
    for (const phrase of phrases) if (hasSegmentPhrase(segments, phrase)) return publicCode
  }
  return "P500"
}

/** 人类面的错误：稳定公开码 + 人话；内部码、HTTP 数字码、绝对路径、栈只进日志。 */
export function publicCommandError(errorText: unknown): { code: string; message: string } {
  const raw = stripStack(scrubAbsolutePaths(redactSecretsText(String(errorText ?? ""))))
  const head = raw.split(/[｜|\n]/, 1)[0] ?? ""
  // **形状判据在前**：产品自己的失败形状就是 `<码>: 人话`，先按结构取码（只看第一个冒号之前、要求整段是码）。
  // 取不到才退回**改前那条**消息正则（逐字保留，既不新增第二条消息正则，也不改它的语义）。
  //
  // 改前那一行是 `?? (/\b(?:4\d\d|5\d\d)\b/.test(head) ? "P500" : "P500")` —— 两个分支同为 "P500"，
  // 即"读了 HTTP 数字码却恒返回 P500"。这里换成等价的 `?? "P500"`，行为一个字不改（回执里登记）。
  const code = publicErrorCodeToken(head)
    ?? /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(head)?.[1]
    ?? "P500"
  return { code: publicErrorCode(code), message: publicErrorMessage(code, raw) }
}

/**
 * 内部码 → 稳定公开码（同一失败在日志保留完整原始错误）。
 *
 * **顺序是判据的一部分**：
 *  1. **形状在前**（`publicErrorCodeToken`）：入参整段（或第一个冒号之前整段）是一个码 ⇒ 分类**只看这个码**
 *     —— 段级词表 + 码内整段的状态数字，消息一个字不参与。可证的一句话：这种输入下改前那条消息正则
 *     `/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/` 的首个命中**必然就是这个码本身**（它在串首且是最大的
 *     `[A-Z0-9_]` 连续段）⇒ **取码结果不变，只有分类依据从"消息里的词"换成"码里的段"**。
 *  2. **消息正则在形状之后**：入参不是码形状时保留**改前那四条正则，逐字不动**。产品路径上这一步不会
 *     发生（`publicCommandError` 传进来的就是它取出来的码或 `"P500"` 兜底）；留着它是为了不改既有
 *     外部调用的答案 —— 把"输入不是码"直接改判成 `P500` 会静默改变行为，那不是本单要的"更准"。
 */
export function publicErrorCode(internal: string): string {
  const code = publicErrorCodeToken(internal)
  if (code !== undefined) return publicErrorCodeOfToken(code)
  if (/PAYMENT_REQUIRED|402/.test(internal)) return "P402"
  if (/NOT_FOUND|NOT_DOWNLOADED|NO_MATCH|MISSING/.test(internal)) return "P404"
  if (/INVALID|UNAVAILABLE|UNSUPPORTED|DECLARED/.test(internal)) return "P422"
  if (/BLOCKED|DENIED|UNAUTHORIZED|FORBIDDEN|EXPIRED|INTEGRITY/.test(internal)) return "P403"
  return "P500"
}

/**
 * Isaac 缺 SDK 的**公开固定句**（人类面，见 `publicErrorMessage`）。
 *
 * 出站投影在服务端、没有界面语言，所以这句固定为中文；底部状态在英文界面下要有英文对应，
 * 由 shell 的 `scene-world-status.tsx` **复用同一个常量**按已有 `tr` 回译，不新建第二套错误/
 * 国际化服务。这句话只说明"安装或检查并登记已有兼容 SDK、保存后重启"，不含解释器路径——
 * 原始路径只留在内部诊断与模型日志，出站投影不显示它。
 */
export const ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE = "当前选择的 Isaac SDK 不可用；请在物理设置中安装 Isaac，或检查并登记已有的兼容本地安装，保存后重新启动 Lyapunov。"

function publicErrorMessage(internal: string, raw: string): string {
  const isaacMessage: Readonly<Record<string, string>> = {
    ISAAC_SDK_UNAVAILABLE: ISAAC_SDK_UNAVAILABLE_PUBLIC_MESSAGE,
    ISAAC_SDK_VERSION_INCOMPATIBLE: "当前 Isaac SDK 版本不兼容，请在物理设置中选择 Isaac Sim 6.0.1。",
    ISAAC_LICENSE_CONFIRMATION_REQUIRED: "当前 Isaac SDK 需要你确认 NVIDIA Omniverse 许可，请在物理设置中查看许可状态。",
    ISAAC_ENGINE_CONFIG_UNSUPPORTED: "当前 Isaac 设备或渲染配置不受支持，请检查物理引擎设置。",
    ISAAC_GPU_DEVICE_UNAVAILABLE: "当前会话无法访问 Isaac 所需的 GPU，请检查设备与驱动访问。",
    ISAAC_KIT_START_FAILED: "Isaac Kit 初始化失败，请查看物理引擎诊断中的启动阶段与原因。",
    ISAAC_EXTENSION_UNAVAILABLE: "Isaac 所需扩展未能加载，请检查所选 SDK 安装。",
    ISAAC_PHYSX_UNAVAILABLE: "Isaac PhysX 后端未能初始化，请查看物理引擎诊断。",
    ASSET_BAKE_DEPENDENCY_UNAVAILABLE: "模型碰撞生成所需的几何依赖不可用，请检查已选择 SDK 的几何环境。",
    PHYSICS_DERIVATION_FAILED: "模型碰撞生成失败，请展开模型物理状态查看具体原因。",
  }
  if (isaacMessage[internal]) return isaacMessage[internal]!
  if (publicErrorCode(internal) === "P402") return "该能力包需要订阅／额度后才能继续。"
  if (publicErrorCode(internal) === "P404") return "没有找到可用的目标，请检查选择后重试。"
  if (publicErrorCode(internal) === "P403") return "当前操作未被放行，请检查权限或状态后重试。"
  if (publicErrorCode(internal) === "P422") return "请求内容不符合要求，请调整后重试。"
  const first = raw.split(/[｜|\n]/, 1)[0] ?? ""
  const withoutCode = first.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b[:：]?\s*/g, "").trim()
  return withoutCode ? stripInternal(withoutCode).slice(0, 160) : "操作失败，请查看诊断导出。"
}

/** 文本里的内部码 / 端点 / 计费措辞 → 中性说法（人类面）。 */
export function stripInternal(text: string): string {
  let out = scrubAbsolutePaths(redactSecretsText(text))
  for (const [pattern, replacement] of INTERNAL_PHRASES) out = out.replace(pattern, replacement)
  for (const pattern of INTERNAL_TOKENS) out = out.replace(pattern, REDACTED)
  return out.replace(/\s{2,}/g, " ").trim()
}

/**
 * 内部状态字 → 公开状态字（人类面唯一口径）：卡片与摘要按公开字分支，内部枚举不上屏。
 * 已经是中性词的原样返回（动作回执的 completed/failed/cancelled 等本来就是产品文案）。
 */
export function publicStatusOf(status: unknown): string {
  const text = String(status ?? "")
  if (!text) return ""
  if (/^PACK_DIRECT_CONTROL$|^PREPARED$|^READY$|^MATCHES$|^DOWNLOADED$|^ok$|^success$/i.test(text)) return "ready"
  if (/NO_MATCH|NOT_FOUND|NOT_DOWNLOADED|ABSENT/i.test(text)) return "absent"
  if (/BLOCKED|DENIED|EXPIRED|INTEGRITY|PAYMENT_REQUIRED/i.test(text)) return "blocked"
  if (/UNAVAILABLE|UNSUPPORTED|INVALID|FAILED|ERROR/i.test(text)) return "failed"
  if (/LISTED_FROM_MOUNT_SNAPSHOT|PACK_SERVER_SIDE_INFERENCE/i.test(text)) return "ready"
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text)) return "internal"
  return text
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const PATH_KEYS = new Set(["path", "root", "outputDir", "cwd", "logFile", "sessionDir", "sessionsDir", "dshHome", "modelEntry", "splatPath", "posePath"])

function isPathKey(key: string): boolean {
  return PATH_KEYS.has(key) || key.endsWith("Path")
}

export type OutboundFace = "ui" | "human"

/**
 * 出站净化：递归丢内部字段、脱凭据、绝对路径改可复算引用（登记域外 basename）。
 *  · `human`（卡片／截图／回放／诊断导出）：文本再过内部码与计费措辞中性化，`status` 改公开字；
 *  · `ui`（工作台面板续链）：标量原值（面板按状态字分支），只丢内部字段、脱凭据、路径改引用。
 * 需要原值续链的字段走 `uiCommandFields` 白名单；**没有 `result` 兜底**。
 */
export function sanitizeOutbound(value: unknown, roots?: ProductPathRoots, face: OutboundFace = "human", depth = 0): unknown {
  if (depth > 24) return undefined
  if (typeof value === "string") {
    const referenced = productRelativePath(value, roots ?? EMPTY_ROOTS)
    // 域内＝可复算引用；域外＝basename；句子里的内嵌路径由 stripInternal 一并 scrub。
    const text = face === "human"
      ? stripInternal(referenced ?? displayPath(value))
      : scrubAbsolutePaths(redactSecretsText(referenced ?? value))
    return text
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map(row => sanitizeOutbound(row, roots, face, depth + 1)).filter(row => row !== undefined)
  if (!isPlainObject(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(value)) {
    if (isInternalFieldName(key)) continue
    if (face === "human" && key === "error" && typeof row === "string") {
      const error = publicCommandError(row)
      out[key] = `${error.code}: ${error.message}`
      continue
    }
    if (isPathKey(key) && typeof row === "string") {
      out[key] = productRelativePath(row, roots ?? EMPTY_ROOTS) ?? (face === "human" ? displayPath(row) : redactSecretsText(row))
      continue
    }
    if (key === "uri" && typeof row === "string") { out[key] = resourceToken(row); continue }
    if (face === "human" && (key === "status" || key === "publicStatus")) { out[key] = publicStatusOf(row); continue }
    const next = sanitizeOutbound(row, roots, face, depth + 1)
    if (next !== undefined) out[key] = next
  }
  return out
}

/**
 * 机器 UI 的逐命令白名单：只留面板续链**真正读过**的字段。
 * 绝不兜底穿透 `result`；未登记的字段一律不下发。路径键改写为产品引用／资源标记，
 * 命令路由与媒体路由在派发前解析回来（浏览器从不持有开发机路径）。
 */
export function uiCommandFields(name: string, value: unknown, roots?: ProductPathRoots, allowAbsolutePaths = true): Record<string, unknown> | null {
  const source = Array.isArray(value) ? { items: value } : isPlainObject(value) ? value : null
  if (!source) return null
  const out: Record<string, unknown> = {}
  const put = (key: string, row: unknown): void => {
    if (row === undefined) return
    if (key === "uri" && typeof row === "string") { out[key] = resourceToken(row); return }
    if (isPathKey(key) && typeof row === "string") {
      // 功能入参要能被派发回真实文件：落在登记域内＝产品引用（两边都安全）；
      // 域外的只有开发态保留真实路径（否则静默弄坏续链），发行态只出 basename 并由业务侧明确失败。
      out[key] = productRelativePath(row, roots ?? EMPTY_ROOTS) ?? (allowAbsolutePaths ? redactSecretsText(row) : displayPath(row))
      return
    }
    out[key] = projectOut(row, roots)
  }
  const pick = (...keys: string[]): void => { for (const key of keys) put(key, source[key]) }
  // 能力包面板要读的**最小**取件链（route 只留拼回执用的两处，不带 nextSteps/控制路径/观测表）。
  const packRoute = (route: unknown): unknown => {
    if (!isPlainObject(route)) return undefined
    const sub: Record<string, unknown> = {}
    if (route.adapterId !== undefined) sub.adapterId = route.adapterId
    if (route.kind !== undefined) sub.kind = route.kind
    if (isPlainObject(route.source)) {
      const from = route.source
      sub.source = { provider: from.provider, modelId: from.modelId, revision: from.revision }
    }
    return sub
  }
  // 本地策略 UI 只持登记 id；Host 缓存路径、包根与原件相对路径不穿透出站边界。
  const policyIdentity = (value: unknown): unknown => {
    if (!isPlainObject(value)) return undefined
    return projectOut({provider:value.provider,modelId:value.modelId,revision:value.revision},roots)
  }
  const localPolicyEntry = (value: unknown): unknown => {
    if (!isPlainObject(value)) return undefined
    const entry:Record<string,unknown>={}
    for(const key of ['id','label','registeredAt','available','sourceBytesVerified','adapterId'])if(value[key]!==undefined)entry[key]=key==='label'?displayPath(value[key]):value[key]
    if(value.identity!==undefined)entry.identity=policyIdentity(value.identity)
    entry.licenseUnchecked=value.licenseUnchecked===true||Array.isArray(value.missingLicense)&&value.missingLicense.length>0
    return projectOut(entry,roots)
  }
  const localPolicyState = (): void => {
    if(source.localEntry!==undefined)out.localEntry=localPolicyEntry(source.localEntry)
    if(isPlainObject(source.localSource)){
      const local:Record<string,unknown>={}
      for(const key of ['status','adapterId','sourceBytesVerified','prepareFrom','bundleDownloadReady','supportedEngines'])if(source.localSource[key]!==undefined)local[key]=source.localSource[key]
      if(source.localSource.identity!==undefined)local.identity=policyIdentity(source.localSource.identity)
      local.licenseUnchecked=source.localSource.licenseUnchecked===true||Array.isArray(source.localSource.missingLicense)&&source.localSource.missingLicense.length>0
      out.localSource=projectOut(local,roots)
    }
  }
  switch (name) {
    case "viewer_orientation_check_ui":
    case "viewer_orientation_stop_ui":
      pick("checkId", "status", "sceneId", "sceneRevision", "attempts", "turnStop")
      return out
    case "policy_search":
      pick("provider", "query", "total", "status")
      if (Array.isArray(source.models)) {
        out.models = (source.models as unknown[]).map(row => isPlainObject(row) ? projectOut(row, roots) : row)
      }
      return out
    case "policy_download_sources":
      pick("status", "models")
      if(Array.isArray(source.localEntries))out.localEntries=source.localEntries.map(localPolicyEntry).filter(Boolean)
      return out
    case "policy_load_state":
      pick("category", "executionKind", "ready", "runtimeChecked", "modelId", "dimensions", "missing", "nextActions", "worldBound", "policyPrepared", "robotWalkingVerified","evidence")
      localPolicyState()
      return out
    case 'policy_activate':
      pick('status','identity','snapshot','world','match','behaviorVerified','executionStarted')
      return out
    case "policy_load_local": case "policy_download_bundle":
      pick("status", "category", "executionKind", "ready", "runtimeChecked", "modelId", "identity", "source", "dimensions", "missing", "nextActions", "worldBound", "policyPrepared", "robotWalkingVerified", "code", "message", "retryable", "fallbackAction", "fallback", "reusedFiles", "downloadedFiles", "serverSideInference", "evidence")
      localPolicyState()
      return out
    case "policy_download":
    case "policy_files":
      pick("status", "files", "bytes", "updatedAt", "error", "resolvedRevision")
      return out
    case "policy_prepare":
      pick("status", "modelEntry", "weightsRequired", "worldOptions")
      if (isPlainObject(source.components)) put("components", source.components)
      { const route = packRoute(source.route); if (route !== undefined) out.route = route }
      return out
    case "policy_metadata": case "policy_verify": case "policy_match": case "policy_execute": case "policy_stop":
      pick("status", "valid", "reason", "stopped", "stepIndex", "actionId", "taskAchieved", "execution")
      return out
    case "scene_create": case "scene_prepare_workspace": case "scene_prepare_world": case "scene_configure_physics": case "scene_edit": case "scene_inspect": case "scene_list": case "scene_history":
    case "scene_restore": case "scene_save": case "scene_mount": case "scene_align":
      pick("sceneId", "revision", "snapshot", "resource", "missing", "changed", "history", "entityId", "entities", "physics", "coordinates")
      return out
    case "scene_asset_acquire":
      if (source.kind === "streamed-sog") {
        pick("kind", "container", "collectionId", "selectedLod", "quality", "levels", "expectedGaussians", "actualGaussians", "scene", "groupEntityId")
        const chunkFace = (row: unknown): Record<string, unknown> | undefined => {
          if (!isPlainObject(row)) return undefined
          const chunk: Record<string, unknown> = {}
          for (const key of ["fileIndex", "gaussians", "resourceId", "version", "entityId"]) if (row[key] !== undefined) chunk[key] = row[key]
          return chunk
        }
        if (Array.isArray(source.resources)) out.resources = source.resources.map(chunkFace).filter(Boolean)
        if (source.environment) out.environment = chunkFace(source.environment)
        return out
      }
      pick("sceneId", "resourceId", "resource", "snapshot", "revision", "name", "ref", "entityId")
      return out
    case 'scene_bind_physics':
      pick('status','snapshot','entityId','normalized','maxMatrixDelta','resource','worldNeedsSync')
      return out
    case 'scene_reconcile_physics':
      pick('snapshot','changed','pending','worldNeedsSync','issues')
      return out
    case 'scene_physics_update':
      pick('status','snapshot','entityId','changed','worldNeedsSync')
      return out
    case 'scene_import_resolve':
      // 用户原选择路径由客户端持有；目录续链只需basename，正式面不回显Host绝对路径。
      pick('kind','entryName','reason')
      return out
    case "scene_import": case "scene_import_url": case "scene_open": case "scene_package_import":
      pick("sceneId", "resourceId", "resource", "snapshot", "revision", "name", "ref", "entityId")
      return out
    // 只读分享页解析：面板/人类面只保留"能不能直接导入"的结论字段与原因，事实对象按通用净化。
    case "scene_asset_resolve":
      pick("kind", "provider", "url", "directUrl", "manifestUrl", "reason", "actions", "facts", "warnings", "resolved", "acquirable", "imported")
      return out
    case "asset_list": case "asset_edit": case "asset_verify": case "asset_bake":
      pick("items", "assets", "ref", "name", "valid", "missing", "changed", "sizeBytes", "storage", "storedEntryPath", "deletedAt", "tags", "folder", "origin")
      return out
    case "asset_authority_snapshot":
      // 界面回收/恢复仅需 CAS 版本，不把完整 registry、原件清单或 journal 下发到浏览器。
      pick("registryRevision")
      return out
    case "viewer_capture": case "sensor_capture": case "sensor_capture_ui": case "camera_capture_multi_ui":
      pick("captureId", "sceneId", "sceneRevision", "frameId", "stepIndex", "simTime", "width", "height",
        "attachment", "originalImage", "cameraName", "resolvedCameraName", "pinhole", "calibration",
        "rgb", "depth", "imagePath", "posePath", "annotations", "annotationCount", "annotationDigest",
        "visualWarnings", "lod", "lodIssue", "environment", "injectionError", "injectedMessageId", "injectedSession", "worldId", "generation", "worldGeneration",
        "worldSceneRevision", "frameSceneRevision", "capturedAt", "cameras", "prompt",
        // 观察回传的拒绝回执：没落盘时必须让调用方看见 saved:false 与 observe（settled/refused）。
        // 普通采集不带这两个键，pick 会跳过 undefined，成功回执的形状不变。
        "saved", "observe")
      return out
    case "segment_sam3": case "segment_fastgs":
      pick("provider", "masks", "output", "emptyResult", "source", "image", "overlay", "result")
      return out
    case "sim_open": case "sim_sync": case "sim_set_paused": case "sim_close": case "sim_stop":
      pick("worldId", "sceneId", "engineId", "engineVersion", "worldGeneration", "appliedSceneRevision", "status", "clock", "timestepS", "warnings",
        "closed", "stopped", "receipts", "affectedEntityIds", "stepIndex", "groundGeomNames", "capabilities", "device", "deviceKind", "deviceDegraded",
        "deviceNote", "solver", "warpVersion", "worldPhysics", "supportsPause")
      return out
    case "sim_execute_batch": case "robot_move": case "joint_move": case "vehicle_drive": case "robot_gripper":
      pick("actionId", "status", "startStep", "endStep", "effect", "taskAchieved", "reason")
      return out
    case "robot_move_tcp":
      pick("status", "taskAchieved", "reason", "executionMode", "site", "bodyName", "requestedDeltaM", "measuredDeltaM", "targetErrorM", "beforeTcp", "afterTcp", "action", "beforeStep", "afterStep", "jointNames", "beforePositions", "afterPositions", "contacts", "collisionChecked", "tracking")
      return out
    case "robot_set_tcp": case "robot_set_base":
      pick("status", "snapshot", "world", "frame", "entityId", "robot")
      return out
    case 'camera_scene_save':
      pick('status','snapshot','entityId','source','worldNeedsSync','sample','note')
      return out
    case 'robot_presets':
      pick('sceneId','sceneRevision','worldId','generation','entityId','nativeBodies','tcp','cameras','base')
      return out
    case "sim_reset":
      pick("status", "snapshot", "world", "frame", "affectedEntityIds")
      return out
    case "robot_flight":
      pick("status", "taskAchieved", "reason", "operation", "worldId", "generation", "sceneRevision", "target", "actions", "maxTiltRad", "source", "stopped", "controllerStatus", "jobId", "world", "after", "stop")
      return out
    case "robot_load": case "robot_describe":
      pick("entityId", "joints", "controlledJointNames", "capabilities", "name", "description", "bodyWrench", "freeBases", "base", "nativeBodies", "nativeSites", "controller")
      return out
    case "robot_state":
      pick("entityId", "joints", "tendons", "frameId", "stepIndex", "simTime", "entities")
      return out
    case "recording_start": case "recording_stop": case "recording_list": case "recording_inspect":
    case "recording_export":
      pick("recordingId", "status", "frameCount", "lastFrame", "items", "jobId", "outputDir")
      return out
    case "camera_list_ui": case "camera_adjust_ui": case "camera_annotation_ui": case "camera_dataset_export_ui":
      pick("sceneId", "sceneRevision", "worldId", "generation", "worldGeneration", "currentWorldGeneration",
        "stepIndex", "simTime", "frameId", "cameras", "bodies", "count", "cameraCount", "rendering",
        "cameraName", "resolvedCameraName", "override", "cleared", "clearsOn", "referenceFrame", "parentBodyName",
        "worldFromCamera", "positionM", "quaternionXyzw", "fovyDeg", "intrinsicsAtReferenceResolution", "calibration",
        "annotationId", "captureId", "pixel", "depthM", "depthSource", "cameraPointM", "worldPointM", "resolution",
        "fov", "intrinsicsSource", "receiptRoundTripPx", "reverseProjectionResidualPx",
        "datasetId", "status", "outputDir", "directory", "frameCount", "sampleCount", "annotationCount", "multiView", "missing")
      return out
    case "ui_action_ack": case "ui_engine_switch": case "ui_local_correction_record":
    case "ui_photo_viewpoint_coverage": case "viewer_annotation_send_ui":
      pick("acked", "saved", "observe", "localCorrections", "localCorrectionsCount", "cameras",
        "override", "annotationId", "captureId", "injectedMessageId", "injectedSession", "outputDir", "engine", "preference", "restart", "tables", "missing")
      return out
    default:
      return null
  }
}

/** 白名单里非路径的值：仍过一遍内部字段／凭据／内部码净化（不给内部原文留暗门）。 */
function projectOut(value: unknown, roots?: ProductPathRoots): unknown {
  return sanitizeOutbound(value, roots, "ui")
}

/**
 * 人类卡片详情区（按公共字段翻译成人话，不含任何原始 JSON）。
 * 只读 `public` 字段；内部字段在这里**零引用**。
 */
export function publicCommandFace(name: string, value: unknown, english = false): string[] {
  const tr = (cn: string, en: string) => (english ? en : cn)
  const rows: string[] = []
  const source = isPlainObject(value) ? value : {}
  const status = publicStatusOf(source.status)
  if (status && status !== "internal") rows.push(tr(`状态 ${status}`, `Status ${status}`))
  const count = (key: string): number => typeof source[key] === "number" ? source[key] as number : Array.isArray(source[key]) ? (source[key] as unknown[]).length : 0
  const num = (key: string): number | undefined => (typeof source[key] === "number" ? source[key] as number : undefined)
  if (typeof source.items === "number") rows.push(tr(`${source.items} 项`, `${source.items} items`))
  if (typeof source.total === "number") rows.push(tr(`${source.total} 个能力包`, `${source.total} packs`))
  if (typeof source.files === "number" && typeof source.bytes === "number") {
    rows.push(tr(`${source.files} 个文件 · ${(source.bytes / 1048576).toFixed(1)} MB`, `${source.files} files · ${(source.bytes / 1048576).toFixed(1)} MB`))
  }
  if (Array.isArray(value)) {
    rows.push(tr(`${value.length} 项结果`, `${value.length} results`))
    return rows
  }
  if (num("width") !== undefined && num("height") !== undefined) {
    rows.push(tr(`画面 ${num("width")} × ${num("height")}`, `Frame ${num("width")} × ${num("height")}`))
    const camera = (source.resolvedCameraName ?? source.cameraName) as string | undefined
    if (camera) rows.push(tr(`相机 ${displayPath(camera)}`, `Camera ${displayPath(camera)}`))
    rows.push(source.pinhole === false ? tr("自由相机，未标定", "Free camera, uncalibrated") : tr("已标定", "Calibrated"))
  }
  if (typeof source.captureId === "string") {
    const original = isPlainObject(source.originalImage) ? source.originalImage as Record<string, unknown> : undefined
    const width = (original?.width ?? (isPlainObject(source.attachment) ? (source.attachment as Record<string, unknown>).width : undefined)) as number | undefined
    const height = (original?.height ?? (isPlainObject(source.attachment) ? (source.attachment as Record<string, unknown>).height : undefined)) as number | undefined
    if (typeof width === "number" && typeof height === "number") rows.push(tr(`画面 ${width} × ${height}`, `Frame ${width} × ${height}`))
    if (original) rows.push(tr("附件是预览图，正本已保留", "Attachment is a preview; the original frame is kept"))
    rows.push(tr(`场景版本 ${String(source.sceneRevision ?? "—")}`, `Scene revision ${String(source.sceneRevision ?? "—")}`))
  }
  if (typeof source.sceneId === "string" && isPlainObject(source.snapshot)) {
    const snapshot = source.snapshot as Record<string, unknown>
    const entities = typeof snapshot.entityCount === "number" ? snapshot.entityCount : Array.isArray(snapshot.entities) ? (snapshot.entities as unknown[]).length : 0
    rows.push(tr(`场景版本 ${String(snapshot.revision ?? "—")} · ${entities} 个实体`, `Scene revision ${String(snapshot.revision ?? "—")} · ${entities} entities`))
    if (count("missing")) rows.push(tr(`${count("missing")} 项引用缺失`, `${count("missing")} missing references`))
  }
  if (typeof source.worldId === "string") rows.push(tr(`模拟已同步 · 世界版本 ${String(source.worldGeneration ?? "—")}`,
    `Simulation synced · world generation ${String(source.worldGeneration ?? "—")}`))
  if (source.actionId !== undefined || isPlainObject(source.effect)) {
    const motions = isPlainObject(source.effect) && Array.isArray((source.effect as Record<string, unknown>).motions)
      ? ((source.effect as Record<string, unknown>).motions as Record<string, unknown>[]) : []
    const unreached = motions.filter(motion => motion?.targetReached === false)
    rows.push(tr(unreached.length ? "动作已结束，目标未到达" : "动作已结束", unreached.length ? "Action finished; target not reached" : "Action finished"))
    if (unreached.length) {
      const tolerance = typeof unreached[0]?.tolerance === "number" ? `（${tr("容差", "tolerance")} ${unreached[0].tolerance}）` : ""
      rows.push(tr(`${unreached.length}/${motions.length} 个动作未进入容差${tolerance}`, `${unreached.length}/${motions.length} motions outside tolerance${tolerance}`))
    }
    // 负面事实的**字段级**证据一并保留（不靠原始 JSON 才看得到）：到达与否、容差都是用户该知道的产品事实。
    for (const [index, motion] of motions.entries()) {
      if (typeof motion?.targetReached === "boolean") rows.push(`targetReached: ${String(motion.targetReached)} · #${index + 1}`)
      if (typeof motion?.tolerance === "number") rows.push(`tolerance: ${String(motion.tolerance)} · #${index + 1}`)
    }
  }
  if (Array.isArray(source.masks)) rows.push(tr(`${count("masks")} 个分割结果`, `${count("masks")} masks`))
  if (isPlainObject(source.output)) {
    const artifacts = (source.output as Record<string, unknown>).artifacts
    const amount = typeof artifacts === "number" ? artifacts : Array.isArray(artifacts) ? artifacts.length : 0
    if (amount) rows.push(tr(`${amount} 个分割产物`, `${amount} segmentation artifacts`))
  }
  if (typeof source.frameCount === "number") rows.push(tr(`${source.frameCount} 帧`, `${source.frameCount} frames`))
  if (typeof source.jobId === "string") rows.push(tr("任务已启动", "Job started"))
  if (typeof source.valid === "boolean") rows.push(source.valid ? tr("检查通过", "Check passed") : tr("检查未通过", "Check failed"))
  if (typeof source.modelEntry === "string") rows.push(tr(`模型入口 ${displayPath(source.modelEntry)}`, `Model entry ${displayPath(source.modelEntry)}`))
  if (typeof source.reason === "string") rows.push(stripInternal(source.reason).slice(0, 160))
  if (!rows.length) rows.push(tr("操作完成", "Completed"))
  return rows
}

/**
 * 权限由产品 Host／发行态决定：两闸都开才允许 Raw 面。
 * 客户端拿不到可信值即按正式渲染（fail-closed），query/localStorage 一律不参与判定。
 */
export function hasRawCommandIOAccess(mode: unknown, buildAllowsRaw: boolean): boolean {
  return buildAllowsRaw && mode === "developer"
}

/**
 * 人类公共面的**字段形状**（不是"净化后的整棵树"）：
 * 只留卡片／截图／回放／诊断导出真正读过的标量与计数，外加动作回执里那两个判据字段
 * （`targetReached`/`tolerance`——R5 的负面事实必须留在人类面）。业务整棵树归机器面，
 * 内部字段与来源 pin 归服务端，三者不共用一个形状。
 */
export function publicCommandShape(name: string, value: unknown, roots?: ProductPathRoots): Record<string, unknown> {
  if (!isPlainObject(value)) return Array.isArray(value) ? { items: value.length } : {}
  if (name === "scene_asset_acquire" && value.kind === "streamed-sog") {
    const scene = isPlainObject(value.scene) ? value.scene : undefined
    return {
      kind: "streamed-sog",
      ...(typeof value.selectedLod === "number" ? { selectedLod: value.selectedLod } : {}),
      ...(typeof value.expectedGaussians === "number" ? { expectedGaussians: value.expectedGaussians } : {}),
      ...(typeof value.actualGaussians === "number" ? { actualGaussians: value.actualGaussians } : {}),
      resourceCount: Array.isArray(value.resources) ? value.resources.length : 0,
      environmentIncluded: isPlainObject(value.environment),
      ...(scene ? { sceneId: scene.sceneId, revision: scene.revision, entityCount: scene.entityCount } : {}),
      quality: "public-ssog-derived",
    }
  }
  const out: Record<string, unknown> = {}
  const scalar = (key: string, target = key): void => {
    const row = value[key]
    if (typeof row === "string") {
      out[target] = isPathKey(key) ? displayPath(row) : stripInternal(redactSecretsText(row))
      return
    }
    if (typeof row === "number" || typeof row === "boolean") out[target] = row
  }
  const count = (key: string, target = key): void => {
    const row = value[key]
    if (Array.isArray(row)) out[target] = row.length
  }
  for (const key of ["status", "reason", "provider", "valid", "stopped", "stepIndex", "startStep", "endStep",
    "actionId", "taskAchieved", "captureId", "sceneId", "revision", "sceneRevision", "frameId", "simTime", "width", "height",
    "cameraName", "resolvedCameraName", "pinhole", "worldId", "generation", "worldGeneration", "appliedSceneRevision",
    "recordingId", "frameCount", "jobId", "emptyResult", "modelEntry", "entityId", "name", "captureName", "total",
    "query", "files", "bytes", "updatedAt", "error", "resolvedRevision", "missing", "changed", "folder", "origin",
    "sizeBytes", "storage", "storedEntryPath", "deletedAt", "worldSceneRevision", "frameSceneRevision", "capturedAt",
    "annotationCount", "injectionError", "lodIssue", "outputDir", "calibration", "camera", "simEngine", "engineId"]) scalar(key)
  if (isPlainObject(value.snapshot)) {
    const snapshot = value.snapshot as Record<string, unknown>
    out.snapshot = {
      ...typeof snapshot.revision === "number" ? { revision: snapshot.revision } : {},
      entityCount: Array.isArray(snapshot.entities) ? snapshot.entities.length : typeof value.entityCount === "number" ? value.entityCount : undefined,
    }
    count("missing")
    count("changed")
  }
  if (isPlainObject(value.effect)) {
    // R5：`targetReached=false` 是**负面事实**，必须留在人类面（卡片直接写进详情，不靠原始 JSON 才看得到）。
    const motions = (value.effect as Record<string, unknown>).motions
    if (Array.isArray(motions)) {
      out.effect = { motions: motions.map((motion: unknown) => isPlainObject(motion)
        ? { ...typeof motion.targetReached === "boolean" ? { targetReached: motion.targetReached } : {},
            ...typeof motion.tolerance === "number" ? { tolerance: motion.tolerance } : {},
            ...(typeof motion.jointErrors === "number" ? { jointErrors: motion.jointErrors } : {}) }
        : {}) }
    }
  }
  if (isPlainObject(value.attachment)) {
    const attachment = value.attachment as Record<string, unknown>
    out.attachment = { ...typeof attachment.width === "number" ? { width: attachment.width } : {}, ...typeof attachment.height === "number" ? { height: attachment.height } : {} }
  }
  if (isPlainObject(value.originalImage)) {
    const original = value.originalImage as Record<string, unknown>
    out.originalImage = { ...typeof original.width === "number" ? { width: original.width } : {}, ...typeof original.height === "number" ? { height: original.height } : {} }
  }
  if (isPlainObject(value.output) && Array.isArray((value.output as Record<string, unknown>).artifacts)) {
    out.output = { artifacts: ((value.output as Record<string, unknown>).artifacts as unknown[]).length }
  }
  for (const key of ["masks", "items", "assets", "entities", "joints", "annotations", "cameras", "visualWarnings", "warnings", "history", "assignments", "actions", "files", "missing", "changed"]) count(key)
  if (isPlainObject(value.lastFrame)) {
    const last = value.lastFrame as Record<string, unknown>
    out.lastFrame = { ...typeof last.generation === "number" ? { generation: last.generation } : {}, ...typeof last.stepIndex === "number" ? { stepIndex: last.stepIndex } : {} }
  }
  if (Array.isArray(value.differences)) out.blocked = value.differences.length
  if (typeof value.status === "string") out.status = publicStatusOf(value.status)
  if (name && typeof name === "string") out.command = name
  void roots
  return out
}

/**
 * 命令 HTTP 路由的**出站响应**（唯一一份判据，shell 路由与测试共用）。
 *
 * 浏览器只拿到两个消费者各自的合法面：
 *  · `text` —— 人类公共面（卡片／截图／回放／诊断导出共用）；
 *  · `ui`   —— 正式与开发模式都保留逐命令授权字段，不能用禁用正式界面功能代替隐私隔离。
 * **没有 `.result` 兜底**：完整内部结果只留在服务端（session 日志 + Host 日志）。
 */
export function commandRouteResponse(
  name: string,
  outcome: { kind: string; text?: string },
  mode: string,
  roots?: ProductPathRoots,
): { kind: "success" | "error"; text: string; ui: Record<string, unknown> | null } {
  const parse = (raw: string | undefined): unknown => {
    if (raw === undefined) return undefined
    try {
      const value = JSON.parse(raw)
      return value === null ? undefined : value
    } catch { return undefined }
  }
  if (outcome.kind === "error") {
    const publicError = publicCommandError(outcome.text)
    return { kind: "error", text: `${publicError.code}: ${publicError.message}`, ui: null }
  }
  const value = parse(outcome.text)
  // 人类面 = 字段形状（不是整棵树）；机器面 = 逐命令白名单。两者都从服务端全量结果投影，互不兜底。
  const face = value === undefined ? "" : JSON.stringify(publicCommandShape(name, value, roots))
  const machine = value === undefined ? null : uiCommandFields(name, value, roots, mode === "developer")
  if (machine && mode !== "developer" && name === "policy_prepare") {
    machine.preparedMode = machine.status === "PREPARED" ? "policy" : "direct-control"
    machine.status = publicStatusOf(machine.status)
    // 来源 pin 和执行适配器细节不是面板装载模型的必要输入。
    delete machine.route
  }
  return { kind: "success", text: face, ui: machine }
}

/**
 * 诊断导出载荷（PRIV-06）：用户排障用的**脱敏**包——无令牌、无用户名、无绝对路径，
 * 而 Host 日志保留完整原始错误（令牌值除外），工单走日志而不是用户截图轨迹。
 * 导出内容＝同一份人类公共面投影，所以"屏幕上看不到的"在这里同样看不到。
 */
export function diagnosticsPayload(value: unknown, roots?: ProductPathRoots): unknown {
  return sanitizeOutbound(value, roots, "human")
}

/** 人类面字段形状（回放／事件投影共用同一份判据，见 `session-event-projection.ts`）。 */
export function humanEventFace(name: string, value: unknown, roots?: ProductPathRoots): string {
  return JSON.stringify(publicCommandShape(name, value, roots))
}

/**
 * 事件／工具块里以**字符串**形态承载的 JSON 结果（`tool-result.content[].text`、`command/done.text`）：
 * 先解析再按人类面裁剪——只对整串做字符串替换是不够的，`matchedBy`/`aliases`/`route.nextSteps`
 * 这些是**键名**，必须靠字段清单丢掉。解析不出来的按普通文本 scrub。
 */
export function humanTextOf(raw: string, roots?: ProductPathRoots): string {
  let parsed: unknown
  try {
    const value = JSON.parse(raw)
    parsed = value === null ? undefined : value
  } catch { parsed = undefined }
  return parsed === undefined
    ? stripInternal(raw)
    : JSON.stringify(sanitizeOutbound(parsed, roots, "human"))
}
