export type BalanceStateLike = {
  status: string
  user?: { id: string; email: string }
  balances?: unknown
  message?: string
}

export type BalancePresentation =
  | { kind: "loading"; text: string }
  | { kind: "ready"; text?: string }
  | { kind: "signed-out"; text: string }
  | { kind: "error"; text: string }

export function balancePresentation(input: {
  loading: boolean
  state?: BalanceStateLike
  error?: string
  locale: string
}): BalancePresentation {
  const zh = input.locale.toLowerCase().startsWith("zh")
  const message = input.state?.message || input.error
  if (input.loading || ["restoring", "waiting-login", "starting", "syncing"].includes(input.state?.status ?? "")) {
    return { kind: "loading", text: zh ? "正在读取账户…" : "Loading account…" }
  }
  if (message) return { kind: "error", text: message }
  if (input.state?.status === "ready") return { kind: "ready" }
  if (input.state?.status === "error") return { kind: "error", text: zh ? "账户同步失败。" : "Unable to sync account." }
  return { kind: "signed-out", text: zh ? "登录正式账户后在此显示余额。" : "Sign in with a formal account to see your balance here." }
}

export function bridgeUnavailableText(locale: string) {
  return locale.toLowerCase().startsWith("zh")
    ? "桌面账户桥接能力不可用；原生注入传输能力就绪前无法提供远程账户或计费操作。请从 Lyapunov 桌面应用打开此页面。"
    : "The desktop account bridge is unavailable; remote account and billing actions require a native injected transport. Open this page from the Lyapunov desktop app."
}
