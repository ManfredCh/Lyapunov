import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export type URLSafetyOptions = {
  readonly label: string
  readonly allowPrivate?: boolean
  readonly allowedHosts?: readonly string[]
}

function isTruthy(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true"
}

export function allowPrivateAssetURLs() {
  return isTruthy(process.env.OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS?.trim())
}

export function allowedHostsFromEnv(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function matchesAllowedHost(hostname: string, allowedHosts: readonly string[]) {
  if (allowedHosts.length === 0) return true
  const host = hostname.toLowerCase()
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith(".")) return host.endsWith(allowed)
    return host === allowed
  })
}

function privateIPv4(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function privateIPv6(address: string) {
  const normalized = address.toLowerCase()
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  )
}

function privateAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return privateIPv4(address)
  if (family === 6) return privateIPv6(address)
  return true
}

export function parsePublicHttpsURL(url: string, options: URLSafetyOptions) {
  if (!URL.canParse(url)) throw new Error(`${options.label} must be an absolute URL`)
  const parsed = new URL(url)
  if (parsed.protocol !== "https:") throw new Error(`${options.label} must use https`)
  if (parsed.username || parsed.password) throw new Error(`${options.label} must not include credentials`)
  if (!matchesAllowedHost(parsed.hostname, options.allowedHosts ?? [])) {
    throw new Error(`${options.label} host is not allowed`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!options.allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error(`${options.label} must not target localhost`)
  }
  if (!options.allowPrivate && isIP(host) && privateAddress(host)) {
    throw new Error(`${options.label} must not target a private address`)
  }
  return parsed
}

export async function assertPublicHttpsURL(url: string, options: URLSafetyOptions) {
  const parsed = parsePublicHttpsURL(url, options)
  if (options.allowPrivate) return parsed
  if (isIP(parsed.hostname)) return parsed
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((address) => privateAddress(address.address))) {
    throw new Error(`${options.label} resolved to a private address`)
  }
  return parsed
}
