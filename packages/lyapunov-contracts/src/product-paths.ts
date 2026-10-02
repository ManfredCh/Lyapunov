/**
 * 产品路径引用（DEV-PRIV-01 L2：用户机器隐私）。
 *
 * 功能要用到的路径**不能只 basename**（`scene_import` / `segment_sam3` / `segment_fastgs` / 能力包装配
 * 都要真实文件），也不能把开发机绝对路径发给浏览器。口径是**服务端归属解析**：
 *  · 出站：落在已登记产品域根下的绝对路径 → `<域>/<相对>` 引用（如 `captures/sessions/<键>/<id>.png`）；
 *  · 入站：命令路由在派发前把 `<域>/<相对>` 解析回绝对路径，越界（`..` / 非登记域）一律不解析。
 *
 * 不造第二资源库：引用只改写字符串，不复制字节；用户自己写下的相对路径照旧交给
 * scene-kit 的 `sessionPath`（按任务工作区解析），本模块不碰它。
 */

/** 域名 → 该域的绝对根。域名是产品词表，不含机器路径。 */
export type ProductPathRoots = Readonly<Record<string, string>>

const DOMAIN_PATTERN = /^[a-z][a-z0-9-]*$/

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean)
}

/**
 * 绝对路径 → 域引用。取**最长匹配**的域根（`product` 这类大根不会盖住 `captures`）。
 * 不在任何登记域下的路径返回 undefined（调用方按显示路径 basename 处理，不臆造引用）。
 */
export function productRelativePath(value: unknown, roots: ProductPathRoots): string | undefined {
  if (typeof value !== "string" || !value || !isAbsoluteLike(value)) return undefined
  const normalized = value.replace(/\\/g, "/")
  let best: { domain: string; rel: string } | undefined
  for (const [domain, root] of Object.entries(roots)) {
    if (!DOMAIN_PATTERN.test(domain) || typeof root !== "string" || !root) continue
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
    if (normalized === base) continue
    if (!normalized.startsWith(base + "/")) continue
    const rel = normalized.slice(base.length + 1)
    if (!rel || segments(rel).includes("..")) continue
    if (!best || rel.length < best.rel.length) best = { domain, rel }
  }
  return best ? `${best.domain}/${best.rel}` : undefined
}

/**
 * 域引用 → 绝对路径。只有形状是 `<登记域>/<无 `..` 的相对>` 才解析；
 * 用户相对路径、别的 URI、越界写法一律返回 undefined（原样交给业务侧的解析器）。
 */
export function resolveProductRelativePath(value: unknown, roots: ProductPathRoots): string | undefined {
  if (typeof value !== "string" || !value || isAbsoluteLike(value)) return undefined
  const normalized = value.replace(/\\/g, "/")
  const slash = normalized.indexOf("/")
  if (slash <= 0) return undefined
  const domain = normalized.slice(0, slash)
  const rel = normalized.slice(slash + 1)
  if (!DOMAIN_PATTERN.test(domain) || !rel) return undefined
  const root = roots[domain]
  if (typeof root !== "string" || !root) return undefined
  const parts = segments(rel)
  if (!parts.length || parts.includes("..") || parts.includes(".")) return undefined
  return `${root.replace(/\/+$/, "")}/${parts.join("/")}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** 出站：递归把登记域内的绝对路径改成域引用（其余字符串原样）。 */
export function projectProductPaths(value: unknown, roots: ProductPathRoots, depth = 0): unknown {
  if (depth > 24) return undefined
  if (typeof value === "string") return productRelativePath(value, roots) ?? value
  if (Array.isArray(value)) return value.map(row => projectProductPaths(row, roots, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(value)) out[key] = projectProductPaths(row, roots, depth + 1)
  return out
}

/** 入站：递归把域引用解析回绝对路径（其余字符串原样，用户相对路径不动）。 */
export function resolveProductPaths(value: unknown, roots: ProductPathRoots, depth = 0): unknown {
  if (depth > 24) return value
  if (typeof value === "string") return resolveProductRelativePath(value, roots) ?? value
  if (Array.isArray(value)) return value.map(row => resolveProductPaths(row, roots, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(value)) out[key] = resolveProductPaths(row, roots, depth + 1)
  return out
}

/**
 * 资源标记（媒体寻址用）：Viewer 只需要**能换回那一个文件的定位符**，不需要它的绝对路径。
 *
 * `resource` / `segmentation-resource` 两条媒体路由本来就是**按授权集合成员资格**放行的
 * （场景资源表 / 分割产物准入清单），所以标记＝在该集合内可匹配的指纹：
 * 浏览器拿到的是不可逆的短指纹，解析只在服务端对着已授权候选集做等值匹配——
 * 不建第二资源库，也不把绝对路径发出去。
 */
export const RESOURCE_TOKEN_PREFIX = "res:"

/** FNV-1a 64 + djb2 64 双哈希（纯 JS、同步、浏览器安全；不引 node:crypto）。 */
function fingerprint(text: string): string {
  let fnv = 0xcbf29ce484222325n, djb = 5381n
  const prime = 0x100000001b3n, mod = 0x10000000000000000n, djbMod = 0x100000000n
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    fnv = (fnv ^ BigInt(code)) * prime % mod
    djb = (djb * 33n + BigInt(code)) % djbMod
  }
  let mixed = (fnv ^ djb) % mod
  let out = ""
  for (let index = 0; index < 32; index++) {
    out += "0123456789abcdef"[Number(mixed & 0xfn)]
    mixed >>= 4n
  }
  return out
}

/** 绝对路径／`file:` URI → 资源标记。 */
export function resourceToken(uri: string): string {
  return RESOURCE_TOKEN_PREFIX + fingerprint(uri)
}

/** 已授权候选集里匹配该标记的真实 URI（无匹配即 undefined，调用方按未授权失败）。 */
export function matchResourceToken(token: string, candidates: Iterable<string>): string | undefined {
  if (!token.startsWith(RESOURCE_TOKEN_PREFIX)) return undefined
  for (const candidate of candidates) if (resourceToken(candidate) === token) return candidate
  return undefined
}

/**
 * 场景／资源表出站：只改写**定位符**（`uri`、`file:` 与登记域内绝对路径 → 标记／引用），
 * 不删任何业务字段（Viewer 要整份几何与组件）。人类文案净化不在这一层，由 `sanitizeOutbound` 负责。
 */
export function projectPathsOnly(value: unknown, roots: ProductPathRoots = {}, depth = 0): unknown {
  if (depth > 32) return value
  if (typeof value === "string") {
    if (value.startsWith("file:")) return resourceToken(value)
    return productRelativePath(value, roots) ?? value
  }
  if (Array.isArray(value)) return value.map(row => projectPathsOnly(row, roots, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(value)) {
    out[key] = key === "uri" && typeof row === "string" ? resourceToken(row) : projectPathsOnly(row, roots, depth + 1)
  }
  return out
}

/** 出站：`uri` 与 `file:` 字符串一律换资源标记（其余交给路径域规则）。 */
export function projectResourceTokens(value: unknown, depth = 0): unknown {
  if (depth > 24) return undefined
  if (typeof value === "string") return value.startsWith("file:") ? resourceToken(value) : value
  if (Array.isArray(value)) return value.map(row => projectResourceTokens(row, depth + 1))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, row] of Object.entries(value)) {
    out[key] = key === "uri" && typeof row === "string" ? resourceToken(row) : projectResourceTokens(row, depth + 1)
  }
  return out
}
