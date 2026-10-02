import { normalizeAccountApiUrl } from "./client.ts"

export const VORYNEL_ADMIN_API_URL = "https://vorynel.com/admin/api"

export interface VerifiedAdministrator {
  source: "vorynel-admin"
  apiUrl: string
  admin: { id: string; username: string; role: "super_admin" }
  /** 仅由启动进程持有，不写入日志、界面或模型子进程环境。 */
  cookieHeader: string
}

export interface AdministratorCredentials {
  apiUrl?: string
  username: string
  password: string
}

export interface AdministratorSession {
  apiUrl?: string
  cookieHeader: string
}

function apiUrl(value?: string) {
  return normalizeAccountApiUrl(value ?? VORYNEL_ADMIN_API_URL)
}

function sessionCookie(value: string) {
  // 只接受本服务的单个会话 Cookie，不携带其他浏览器身份或 Set-Cookie 属性。
  if (!/^admin_session=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value)) {
    throw new Error("ADMIN_SESSION_INVALID: 管理员会话无效")
  }
  return value
}

async function request(base: string, path: string, init: RequestInit) {
  let response: Response
  try {
    response = await fetch(base + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // 网络错误和重定向可能包含请求细节，不向调用方回显凭据。
    throw new Error("ADMIN_SERVICE_UNAVAILABLE: 管理员认证服务请求失败")
  }
  if (!response.ok) {
    throw new Error(`ADMIN_AUTH_HTTP_${response.status}: 管理员认证服务拒绝请求`)
  }
  return response
}

/** 验证现网 AdminService 身份；普通 admin 不具备超级管理员启动权限。 */
export async function verifyAdministrator(input: AdministratorSession): Promise<VerifiedAdministrator> {
  const base = apiUrl(input.apiUrl)
  const cookieHeader = sessionCookie(input.cookieHeader)
  const response = await request(base, "/auth/me", {
    headers: { accept: "application/json", cookie: cookieHeader },
  })
  const payload: unknown = await response.json().catch(() => undefined)
  const admin = payload && typeof payload === "object" && "admin" in payload
    ? payload.admin
    : undefined
  if (!admin || typeof admin !== "object" || !("id" in admin) || !("username" in admin)
    || typeof admin.id !== "string" || !admin.id.trim()
    || typeof admin.username !== "string" || !admin.username.trim()) {
    throw new Error("ADMIN_IDENTITY_INVALID: 管理员服务没有返回有效身份")
  }
  if (!("role" in admin) || admin.role !== "super_admin") {
    throw new Error("SUPER_ADMIN_REQUIRED: 当前管理员没有超级管理员启动权限")
  }
  return {
    source: "vorynel-admin",
    apiUrl: base,
    admin: { id: admin.id, username: admin.username, role: admin.role },
    cookieHeader,
  }
}

/** 使用现有后台用户名与密码登录，再用 auth/me 确认服务器身份和角色。 */
export async function loginAdministrator(input: AdministratorCredentials): Promise<VerifiedAdministrator> {
  const base = apiUrl(input.apiUrl)
  if (typeof input.username !== "string" || !input.username.trim()
    || typeof input.password !== "string" || !input.password) {
    throw new Error("ADMIN_CREDENTIALS_REQUIRED: 需要现有管理员用户名与密码")
  }
  const response = await request(base, "/auth/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username: input.username.trim(), password: input.password }),
  })
  const cookies = response.headers.getSetCookie()
    .map(value => value.split(";", 1)[0]!.trim())
    .filter(value => value.startsWith("admin_session="))
  if (cookies.length !== 1) {
    throw new Error("ADMIN_SESSION_INVALID: 管理员登录没有返回唯一会话")
  }
  const session = { apiUrl: base, cookieHeader: sessionCookie(cookies[0]!) }
  try {
    return await verifyAdministrator(session)
  } catch (error) {
    try {
      await logoutAdministrator(session)
    } catch {
      throw new Error("ADMIN_VERIFICATION_FAILED: 管理员身份验证失败，且服务端会话撤销未确认")
    }
    throw error
  }
}

/** 撤销现有 AdminService 会话；成功必须由服务端明确返回 ok:true。 */
export async function logoutAdministrator(input: AdministratorSession): Promise<void> {
  const response = await request(apiUrl(input.apiUrl), "/auth/logout", {
    method: "POST",
    headers: { accept: "application/json", cookie: sessionCookie(input.cookieHeader) },
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
    throw new Error("ADMIN_LOGOUT_UNCONFIRMED: 管理员服务未确认会话撤销")
  }
}
