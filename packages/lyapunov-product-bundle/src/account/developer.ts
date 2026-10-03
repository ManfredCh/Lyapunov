import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface DeveloperCredential {
  version: 1
  username: string
  salt: string
  digest: string
  createdAt: string
}

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/

export function validateDeveloperUsername(value: unknown): string {
  if (typeof value !== 'string' || !USERNAME.test(value.trim())) {
    throw new Error('开发者用户名必须为 2–64 位字母、数字、点、下划线或连字符')
  }
  return value.trim()
}

export function validateDeveloperPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
    throw new Error('开发者密码必须为 12–256 个字符')
  }
  return value
}

function digest(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function createDeveloperCredential(usernameInput: unknown, passwordInput: unknown, now = new Date()): DeveloperCredential {
  const username = validateDeveloperUsername(usernameInput)
  const password = validateDeveloperPassword(passwordInput)
  const salt = randomBytes(16)
  return {
    version: 1,
    username,
    salt: salt.toString('base64url'),
    digest: digest(password, salt).toString('base64url'),
    createdAt: now.toISOString(),
  }
}

export function verifyDeveloperCredential(record: DeveloperCredential, usernameInput: unknown, passwordInput: unknown): boolean {
  try {
    const username = validateDeveloperUsername(usernameInput)
    const password = validateDeveloperPassword(passwordInput)
    if (record.version !== 1 || record.username !== username) return false
    const salt = Buffer.from(record.salt, 'base64url')
    const expected = Buffer.from(record.digest, 'base64url')
    const actual = digest(password, salt)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export async function readDeveloperCredential(path: string): Promise<DeveloperCredential> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('开发者账号文件必须是 JSON 对象')
  const record = value as Partial<DeveloperCredential>
  if (record.version !== 1 || typeof record.username !== 'string' || typeof record.salt !== 'string' || typeof record.digest !== 'string') {
    throw new Error('开发者账号文件格式无效')
  }
  validateDeveloperUsername(record.username)
  if (!/^[A-Za-z0-9_-]{16,}$/.test(record.salt) || !/^[A-Za-z0-9_-]{32,}$/.test(record.digest)) throw new Error('开发者账号摘要格式无效')
  return record as DeveloperCredential
}

/** 仅用于审计/日志去重，不用于认证，不暴露账号或密码。 */
export function developerCredentialFingerprint(record: DeveloperCredential): string {
  return createHash('sha256').update(`${record.version}\0${record.username}\0${record.salt}\0${record.digest}`).digest('hex').slice(0, 16)
}
