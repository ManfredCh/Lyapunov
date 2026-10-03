import { describe, expect, test } from 'bun:test'
import { assertContextEnvelope, createContextEnvelope, type ContextEnvelope } from '../src/context-envelope.ts'

const base = (overrides: Partial<ContextEnvelope> = {}) => ({
  version: 1 as const,
  category: 'scene-spec' as const,
  producer: 'lyapunov-shell',
  sessionId: 'session-a',
  revision: 1,
  lifetime: 'transient' as const,
  visibility: ['model', 'routing'] as const,
  createdAt: '2026-09-25T00:00:00.000Z',
  expiresAt: '2026-09-25T00:15:00.000Z',
  privacy: { secretFree: true as const, pathPolicy: 'product-relative' as const, pii: 'none' as const },
  payload: { task: 'yard scene', dimensions: [1, 2, 3] },
  ...overrides,
})

describe('product context envelope contract', () => {
  test('creates JSON-safe session-owned snapshots with explicit visibility and expiry', () => {
    const envelope = createContextEnvelope(base())
    expect(envelope.version).toBe(1)
    expect(envelope.sessionId).toBe('session-a')
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
  })

  test('supports all producer categories and non-expiring session/persistent lifetimes', () => {
    for (const category of ['scene-spec', 'camera', 'ui', 'skill', 'runtime'] as const) {
      const envelope = createContextEnvelope(base({ category, lifetime: 'session', expiresAt: undefined }))
      expect(envelope.category).toBe(category)
      expect(envelope.expiresAt).toBeUndefined()
    }
    expect(createContextEnvelope(base({ lifetime: 'persistent', expiresAt: undefined })).lifetime).toBe('persistent')
  })

  test('rejects missing owner, invalid revision, missing visibility, and unsupported version', () => {
    for (const input of [
      base({ sessionId: '' }),
      base({ revision: -1 }),
      base({ visibility: [] }),
      { ...base(), version: 2 },
    ]) expect(() => assertContextEnvelope(input)).toThrow()
  })

  test('transient context requires a future expiry; durable context forbids one', () => {
    expect(() => assertContextEnvelope(base({ expiresAt: '2026-09-25T00:00:00.000Z' }))).toThrow('CONTEXT_ENVELOPE_EXPIRY_INVALID')
    expect(() => assertContextEnvelope(base({ lifetime: 'session' }))).toThrow('CONTEXT_ENVELOPE_EXPIRY_NOT_ALLOWED')
  })

  test('privacy metadata is explicit and payload rejects non-JSON values and cycles', () => {
    expect(() => assertContextEnvelope(base({ privacy: { secretFree: false as never, pathPolicy: 'none', pii: 'none' } as never }))).toThrow('CONTEXT_ENVELOPE_PRIVACY_INVALID')
    expect(() => assertContextEnvelope(base({ payload: undefined }))).toThrow('CONTEXT_ENVELOPE_PAYLOAD_NOT_SERIALIZABLE')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => assertContextEnvelope(base({ payload: cyclic }))).toThrow('CONTEXT_ENVELOPE_PAYLOAD_NOT_SERIALIZABLE')
  })
})
