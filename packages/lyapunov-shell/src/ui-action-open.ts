/**
 * `ui_action` 的 `openResource` 契约（宿主与前端共用的**纯函数**）。
 *
 * 为什么单独一份：宿主在等前端的打开确认（`plugin.ts` 的 `settleOpenAction`），前端在产出这份确认
 * （`native-workspace.tsx` 的 `openResource`）。两侧要是各写一套判定，就会出现"前端认为成功、宿主认为失败"
 * 或反过来"只排队也叫打开"的假成功。这里只放判据本身，不 import 任何宿主/浏览器能力。
 *
 * 回执里的 `address`/`kind` 必须是前端**从真实激活标签回读**的事实（标签的 `contentId` 即资源地址，
 * `kind` 即打开它的类型），不是把请求参数抄回来。宿主再把它与"请求 path 对应的规范资源地址 + 点名 kind"
 * 对照：错误文件、错误打开方式、只排队、标签没显示都不算成立。
 */
// 源码编辑器的 kind 只有工作区包这一份（`native-workspace-tabs.tsx` 注册它们）。
import { EDITOR_KIND, HTML_EDITOR_KIND } from "../../lyapunov-workspace/src/workspace-kinds.ts"

/** 前端窗口真实打开一个资源后的回执（`opened`/`visible` 都是**调用之后**读到的布局事实）。 */
export interface OpenResourceReceipt {
  opened: boolean
  visible: boolean
  /** 从真实激活标签读回的规范资源地址（`TabRecord.contentId` = `dsh-resource://file/...`）；没有为 null。 */
  address: string | null
  /** 从真实激活标签读回的 kind；没有为 null。 */
  kind: string | null
}

/**
 * 一次打开的**期望**（宿主按"发起会话 + 该会话 cwd + 请求 path"算出的规范地址，与前端用同一个
 * `fileAddressFor`；kind 由打开方式决定）。`expectedKind` 用于 `source`（点名打开，类型确定）；
 * `forbiddenKind` 用于 `preview`（交给注册表排名，但必须排除被点名的源码编辑器——那就是"错误打开方式"）。
 */
export interface OpenExpectation {
  address: string
  target: "preview" | "source"
  expectedKind?: string
  forbiddenKind?: string
}

/**
 * 请求 → 期望：`source` 点名打开（HTML 源码编辑器 / 普通文本编辑器），因此期望 kind 确定；
 * `preview` 由注册表排名（`.html` 由原生页面预览胜出），只禁止落到源码编辑器的 kind。
 */
export function openExpectationFor(input: { path: string; target: "preview" | "source"; address: string }): OpenExpectation {
  const html = /\.html?$/i.test(input.path)
  return input.target === "source"
    ? { address: input.address, target: "source", expectedKind: html ? HTML_EDITOR_KIND : EDITOR_KIND }
    : { address: input.address, target: "preview", forbiddenKind: HTML_EDITOR_KIND }
}

/** 判据结果：成功带回执原值，失败带回稳定错误码 + 人话。 */
export type OpenReceiptVerdict = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string }

/**
 * 回执是否**真的**证明被请求的资源已按请求的方式打开且用户看得见。
 *
 * 始终检查：`opened=true` 且 `visible=true`，且带真实激活标签的 `address`/`kind`（缺一即形状不合格）。
 * 给了 `expect` 时再核对：地址必须是请求 path 的规范资源地址（错误文件不算），`source` 的 kind 必须是
 * 点名的那个（错误打开方式不算），`preview` 不得落到被禁止的源码编辑器 kind。
 */
export function openReceiptVerdict(value: unknown, expect?: OpenExpectation): OpenReceiptVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "UI_ACTION_OPEN_RECEIPT_INVALID: 窗口没有给出结构化的打开回执（opened/visible/address/kind）" }
  }
  const receipt = value as { opened?: unknown; visible?: unknown; address?: unknown; kind?: unknown }
  if (receipt.opened !== true || receipt.visible !== true) {
    return { ok: false, reason: "UI_ACTION_OPEN_NOT_VISIBLE: 窗口回执没有给出 opened=true 且 visible=true 的真实打开事实（只排队/标签未显示都不算打开），这次打开不能算成立" }
  }
  if (typeof receipt.address !== "string" || !receipt.address) {
    return { ok: false, reason: "UI_ACTION_OPEN_RECEIPT_INVALID: 回执没有给出真实激活标签的规范资源地址（address）——不能拿请求参数当回执" }
  }
  if (typeof receipt.kind !== "string" || !receipt.kind) {
    return { ok: false, reason: "UI_ACTION_OPEN_RECEIPT_INVALID: 回执没有给出真实激活标签的 kind——无法证明用的是哪种打开方式" }
  }
  if (expect) {
    if (receipt.address !== expect.address) {
      return { ok: false, reason: `UI_ACTION_OPEN_ADDRESS_MISMATCH: 窗口真实激活的标签是 ${receipt.address}，请求的是 ${expect.address}；不是被请求的那个文件，这次打开不能算成立` }
    }
    if (expect.expectedKind && receipt.kind !== expect.expectedKind) {
      return { ok: false, reason: `UI_ACTION_OPEN_KIND_MISMATCH: 窗口用 kind=${receipt.kind} 打开了资源，请求的是 kind=${expect.expectedKind}（${expect.target === "source" ? "源码" : "预览"}方式）；错误打开方式不能算成功` }
    }
    if (expect.forbiddenKind && receipt.kind === expect.forbiddenKind) {
      return { ok: false, reason: `UI_ACTION_OPEN_KIND_MISMATCH: 请求的是预览，窗口却用源码编辑器（kind=${receipt.kind}）打开了它；错误打开方式不能算成功` }
    }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 把已核验的打开结果交给模型时只说用户关心的文件和方式；原始回执仍保留在工具结果中。 */
export function uiActionModelText(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = value as Record<string, unknown>
    if (result.action === "openResource"
      && typeof result.path === "string" && result.path.length > 0
      && (result.target === "preview" || result.target === "source")
      && openReceiptVerdict(value).ok) {
      return `已在工作台打开「${result.path}」的${result.target === "source" ? "源码" : "预览"}。`
    }
  }
  return JSON.stringify(value) ?? String(value)
}

/**
 * 一条打开确认的归属：必须是**发起会话 + 被指定窗口**自己的回执。
 * 返回 undefined 表示归属成立；否则返回一条可原样交给等待者的拒绝原因。
 * 与采集/相机共用同一套"会话 + 窗口"归属口径（打开没有场景/版本可对版）。
 */
export function openWaiterOwnership(
  waiter: { sessionKey: string; clientId: string },
  caller: { sessionKey: string; clientId?: unknown },
): { kind: "foreign" | "client"; reason: string } | undefined {
  if (waiter.sessionKey !== caller.sessionKey) {
    return { kind: "foreign", reason: "UI_ACTION_OPEN_FOREIGN_SESSION: 这次打开不属于本次调用所在的会话，已忽略该回执" }
  }
  if (waiter.clientId !== caller.clientId) {
    return { kind: "client", reason: `UI_ACTION_OPEN_CLIENT_MISMATCH: 这条确认来自窗口 ${caller.clientId === undefined ? "（未标注）" : String(caller.clientId)}，不是被请求的 ${waiter.clientId}` }
  }
  return undefined
}
