export type AccountUser = {
  id: string
  email: string
}

export type AccountBalances = {
  combo: number
  opus: number
  points?: number
  reservedPoints?: number
}

export type AccountBalanceSyncStatus = "idle" | "syncing" | "ready" | "error"

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Balance data is allowed to come from either the live API or the encrypted
 * saved session. Treat malformed data as unavailable instead of projecting it
 * as a zero balance.
 */
export function normalizeAccountBalances(value: unknown): AccountBalances | undefined {
  if (!record(value)) return undefined
  if (!nonNegativeFiniteNumber(value.combo) || !nonNegativeFiniteNumber(value.opus)) return undefined
  if (value.points !== undefined && !nonNegativeFiniteNumber(value.points)) return undefined
  if (value.reservedPoints !== undefined && !nonNegativeFiniteNumber(value.reservedPoints)) return undefined
  return {
    combo: value.combo,
    opus: value.opus,
    ...(value.points !== undefined ? { points: value.points } : {}),
    ...(value.reservedPoints !== undefined ? { reservedPoints: value.reservedPoints } : {}),
  }
}

export function totalAccountPoints(balances: AccountBalances) {
  return balances.points ?? balances.combo + balances.opus
}

export function formatAccountPointValue(value?: number, locale = "zh") {
  if (value === undefined) return "—"
  const zh = locale.toLowerCase().startsWith("zh")
  if (value >= 999_999_999) return zh ? "无限" : "Unlimited"
  return new Intl.NumberFormat(zh ? "zh-CN" : "en-US").format(value)
}

export function formatAccountPoints(balances?: AccountBalances, locale = "zh") {
  return formatAccountPointValue(balances ? totalAccountPoints(balances) : undefined, locale)
}

export function formatAccountBalanceDisplay(input: {
  balances?: AccountBalances
  status: AccountBalanceSyncStatus
  locale?: string
}) {
  const zh = input.locale?.toLowerCase().startsWith("zh") ?? true
  const status =
    input.status === "syncing"
      ? zh
        ? "同步中…"
        : "Syncing…"
      : input.status === "error"
        ? zh
          ? "同步失败"
          : "Sync failed"
        : undefined
  const points = input.balances ? formatAccountPoints(input.balances, input.locale) : undefined
  if (!points) return status ?? "—"
  return status ? `${points} · ${status}` : points
}

export type AccountSession = {
  token: string
  expiresAt: string
}

export type AccountAuthResult = {
  user: AccountUser
  session: AccountSession
}

export type WebsiteLoginStart = {
  flowId: string
  authorizeUrl: string
  expiresAt: string
}

export type WebsiteLoginComplete = AccountAuthResult | { status: "pending" }

export type AccountMe = {
  user: AccountUser
  balances: AccountBalances
}

export type CreditBucket = "combo" | "opus"
export type PaymentProvider = "alipay" | "wechat"

export type CreditPlan = {
  id: string
  bucket?: CreditBucket
  name: string
  credits: number
  priceFen: number
  currency: "CNY"
}

export type PaymentMethod = {
  id: PaymentProvider
  available: boolean
}

export type AccountOrder = {
  id: string
  planId: string
  bucket?: CreditBucket
  name?: string
  credits: number
  amountFen: number
  currency: "CNY"
  provider: PaymentProvider
  checkoutUrl?: string
  status: "pending" | "paid" | "cancelled" | "refunded"
  createdAt: string
  paidAt?: string
}

export type AccountLedgerEntry = {
  id: string
  type: "purchase" | "admin" | "credit" | "reserve" | "settle" | "release" | "refund"
  availableDelta: number
  reservedDelta: number
  balanceAfterAvailable?: number
  balanceAfterReserved?: number
  reason?: string
  orderId?: string
  reservationId?: string
  createdAt: string
}

/**
 * User-side account usage is intentionally separate from the OM/APIOM supplier
 * ledger. The current API does not return an account-period boundary, so the
 * `used` value remains unavailable until the server supplies that contract.
 */
export type AccountUsageSummary = {
  available: number
  reserved?: number
  used?: number
  usedStatus: "unavailable" | "available"
  periodStart?: string
  periodEnd?: string
}

export function summarizeAccountUsage(
  balances: AccountBalances,
  entries: AccountLedgerEntry[],
): AccountUsageSummary {
  // `/v1/ledger` currently exposes deltas but no period boundary. Summing all
  // returned entries would be an arbitrary page total, not current-period use.
  return {
    available: totalAccountPoints(balances),
    ...(balances.reservedPoints !== undefined ? { reserved: balances.reservedPoints } : {}),
    usedStatus: "unavailable",
  }
}

export type CreateOrderResult = {
  order: AccountOrder
  checkout: { provider: PaymentProvider; url: string }
}

export class AccountApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message)
    this.name = "AccountApiError"
    this.status = status
    this.code = code
  }
}

export function normalizeAccountApiUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("Lyapunov account API URL is not configured")
  const url = new URL(trimmed)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Lyapunov account API must use HTTPS outside localhost")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Lyapunov account API URL must not include credentials, query parameters, or a fragment")
  }
  return url.toString().replace(/\/$/, "")
}

async function decode<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as { error?: string; message?: string } | T | undefined
  if (!response.ok) {
    const failure = body as { error?: string; message?: string } | undefined
    throw new AccountApiError(
      failure?.message || `Request failed (${response.status})`,
      response.status,
      failure?.error,
    )
  }
  return body as T
}

export function createAccountClient(input: {
  baseUrl: string
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}) {
  const baseUrl = normalizeAccountApiUrl(input.baseUrl)
  const fetcher = input.fetcher ?? fetch

  const request = async <T>(pathname: string, init: RequestInit = {}, token?: string) => {
    const headers = new Headers(init.headers)
    headers.set("accept", "application/json")
    if (init.body !== undefined) headers.set("content-type", "application/json")
    if (token) headers.set("authorization", `Bearer ${token}`)
    return decode<T>(
      await fetcher(`${baseUrl}${pathname}`, {
        ...init,
        headers,
        cache: "no-store",
      }),
    )
  }

  return {
    register(email: string, password: string) {
      return request<AccountAuthResult>("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })
    },
    login(email: string, password: string) {
      return request<AccountAuthResult>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })
    },
    startWebsiteLogin(signal?: AbortSignal) {
      return request<WebsiteLoginStart>("/v1/auth/website/start", { method: "POST", signal })
    },
    exchangeWebsiteLogin(flowId: string, code: string) {
      return request<AccountAuthResult>("/v1/auth/website/exchange", {
        method: "POST",
        body: JSON.stringify({ flowId, code }),
      })
    },
    completeWebsiteLogin(flowId: string, signal?: AbortSignal) {
      return request<WebsiteLoginComplete>("/v1/auth/website/complete", {
        method: "POST",
        signal,
        body: JSON.stringify({ flowId }),
      })
    },
    me(token: string, signal?: AbortSignal) {
      return request<AccountMe>("/v1/me", { signal }, token)
    },
    logout(token: string, signal?: AbortSignal) {
      return request<{ ok: true }>("/v1/auth/logout", { method: "POST", signal }, token)
    },
    plans() {
      return request<{ plans: CreditPlan[]; pointValueFen: number }>("/v1/plans")
    },
    paymentMethods(token: string) {
      return request<{ methods: PaymentMethod[] }>("/v1/payment-methods", {}, token)
    },
    orders(token: string) {
      return request<{ orders: AccountOrder[] }>("/v1/orders", {}, token)
    },
    ledger(token: string, signal?: AbortSignal) {
      return request<{ entries: AccountLedgerEntry[] }>("/v1/ledger", { signal }, token)
    },
    order(token: string, orderId: string) {
      return request<{ order: AccountOrder }>(`/v1/orders/${encodeURIComponent(orderId)}`, {}, token)
    },
    createOrder(token: string, planId: string, provider: PaymentProvider) {
      return request<CreateOrderResult>(
        "/v1/orders",
        { method: "POST", body: JSON.stringify({ planId, provider }) },
        token,
      )
    },
  }
}
