export const CONTEXT_ENVELOPE_VERSION = 1 as const
export const CONTEXT_CATEGORIES = ['scene-spec', 'camera', 'ui', 'skill', 'runtime'] as const
export const CONTEXT_LIFETIMES = ['transient', 'session', 'persistent'] as const
export const CONTEXT_VISIBILITIES = ['model', 'routing', 'ui', 'internal'] as const
export type ContextEnvelopeCategory = typeof CONTEXT_CATEGORIES[number]
export type ContextEnvelopeLifetime = typeof CONTEXT_LIFETIMES[number]
export type ContextEnvelopeVisibility = typeof CONTEXT_VISIBILITIES[number]
export interface ContextEnvelopePrivacy {
  secretFree: true
  pathPolicy: 'none' | 'product-relative'
  pii: 'none' | 'user-approved'
}
export interface ContextEnvelope<T = unknown> {
  version: typeof CONTEXT_ENVELOPE_VERSION
  category: ContextEnvelopeCategory
  producer: string
  sessionId: string
  revision: number
  lifetime: ContextEnvelopeLifetime
  visibility: readonly ContextEnvelopeVisibility[]
  createdAt: string
  expiresAt?: string
  privacy: ContextEnvelopePrivacy
  payload: T
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isIso = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const containsUnsupported = (value: unknown, seen: Set<object>): boolean => {
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return true
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => containsUnsupported(item, seen))
  return Object.entries(value).some(([key, item]) => key === '__proto__' || containsUnsupported(item, seen))
}

export function assertContextEnvelope(value: unknown): asserts value is ContextEnvelope {
  if (!isRecord(value)) throw new Error('CONTEXT_ENVELOPE_INVALID')
  if (value.version !== CONTEXT_ENVELOPE_VERSION) throw new Error('CONTEXT_ENVELOPE_VERSION_INVALID')
  if (typeof value.category !== 'string' || !(CONTEXT_CATEGORIES as readonly string[]).includes(value.category)) throw new Error('CONTEXT_ENVELOPE_CATEGORY_INVALID')
  if (typeof value.producer !== 'string' || !value.producer.trim()) throw new Error('CONTEXT_ENVELOPE_PRODUCER_REQUIRED')
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) throw new Error('CONTEXT_ENVELOPE_SESSION_REQUIRED')
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('CONTEXT_ENVELOPE_REVISION_INVALID')
  if (typeof value.lifetime !== 'string' || !(CONTEXT_LIFETIMES as readonly string[]).includes(value.lifetime)) throw new Error('CONTEXT_ENVELOPE_LIFETIME_INVALID')
  if (!Array.isArray(value.visibility) || value.visibility.length === 0 || value.visibility.some(item => typeof item !== 'string' || !(CONTEXT_VISIBILITIES as readonly string[]).includes(item))) throw new Error('CONTEXT_ENVELOPE_VISIBILITY_INVALID')
  if (typeof value.createdAt !== 'string' || !isIso(value.createdAt)) throw new Error('CONTEXT_ENVELOPE_CREATED_AT_INVALID')
  if (value.lifetime === 'transient') {
    if (typeof value.expiresAt !== 'string' || !isIso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) throw new Error('CONTEXT_ENVELOPE_EXPIRY_INVALID')
  } else if (value.expiresAt !== undefined) {
    throw new Error('CONTEXT_ENVELOPE_EXPIRY_NOT_ALLOWED')
  }
  if (!isRecord(value.privacy) || value.privacy.secretFree !== true || !['none', 'product-relative'].includes(String(value.privacy.pathPolicy)) || !['none', 'user-approved'].includes(String(value.privacy.pii))) throw new Error('CONTEXT_ENVELOPE_PRIVACY_INVALID')
  if (containsUnsupported(value.payload, new Set())) throw new Error('CONTEXT_ENVELOPE_PAYLOAD_NOT_SERIALIZABLE')
}

export function createContextEnvelope<T>(input: Omit<ContextEnvelope<T>, 'version'>): ContextEnvelope<T> {
  const envelope = { version: CONTEXT_ENVELOPE_VERSION, ...input }
  assertContextEnvelope(envelope)
  return envelope
}
