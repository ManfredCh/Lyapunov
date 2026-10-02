/**
 * Tier priority is planning metadata, not a fourth readiness state.
 * `packs/t0-roster.json` is the authority for documented T0 membership; pack.json
 * remains the content authority and inspectPack remains the readiness authority.
 * This module only validates supplied JSON and performs exact-ID lookups: no I/O,
 * asset inspection, policy preparation, inference, downloads, or tier inference.
 */
export const T0_ROSTER_FILE = 't0-roster.json'
export const PACK_TIERS = ['T0', 'T1', 'T1+', 'T2'] as const
export type PackTier = typeof PACK_TIERS[number]

export interface TierSource { id: string; path: string; section: string; date: string; note: string }
export interface T0Entry { packId: string; tier: 'T0'; sourceIds: string[] }
export interface TierClaim { tier: PackTier; sourceId: string }
export interface TierConflict { packId: string; claims: TierClaim[]; note: string }
export interface T0Roster {
  schemaVersion: 1
  scope: 'documented-t0-priority'
  evidenceScope: 'planning-only'
  note: string
  readinessSource: 'packages/policy-registry/src/pack-contract.ts#inspectPack'
  sources: TierSource[]
  packs: T0Entry[]
  conflicts: TierConflict[]
}
export interface TierRosterIssue { path: string; code: string }
export type PackTierMetadata =
  | { packId: string; classification: 'documented'; tier: 'T0'; sourceIds: string[] }
  | { packId: string; classification: 'conflicting-docs'; tier: null; claims: TierClaim[] }
  | { packId: string; classification: 'unclassified'; tier: null }
export type TierRosterError = Error & { code: 'PACK_TIER_ROSTER_INVALID' | 'PACK_NOT_FOUND'; issues?: TierRosterIssue[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const packId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value)
const tier = (value: unknown): value is PackTier => (PACK_TIERS as readonly unknown[]).includes(value)
const sourcePath = (value: unknown): value is string => text(value) && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') && !value.split('/').some(part => !part || part === '.' || part === '..') && value.endsWith('.md')

/** Validate tier metadata against the current registry, without reading assets. */
export function validateT0Roster(roster: unknown, registry: unknown): TierRosterIssue[] {
  const issues: TierRosterIssue[] = []
  const add = (path: string, code: string) => issues.push({ path, code })
  const fields = (value: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${path}.${key}`, 'TIER_FIELD_UNEXPECTED')
  }
  const ids = new Set<string>()
  if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.packs)) {
    add('registry', 'REGISTRY_INVALID')
  } else {
    if (registry.tierRoster !== T0_ROSTER_FILE) add('registry.tierRoster', 'TIER_ROSTER_REFERENCE_INVALID')
    for (const [index, entry] of registry.packs.entries()) {
      if (!object(entry) || !packId(entry.packId)) { add(`registry.packs[${index}].packId`, 'PACK_ID_INVALID'); continue }
      if (ids.has(entry.packId)) add(`registry.packs[${index}].packId`, 'PACK_ID_DUPLICATE')
      ids.add(entry.packId)
    }
  }
  if (!object(roster)) { add('roster', 'TIER_ROSTER_INVALID'); return issues }
  fields(roster, ['schemaVersion', 'scope', 'evidenceScope', 'note', 'readinessSource', 'sources', 'packs', 'conflicts'], 'roster')
  if (roster.schemaVersion !== 1) add('roster.schemaVersion', 'TIER_SCHEMA_VERSION_INVALID')
  if (roster.scope !== 'documented-t0-priority') add('roster.scope', 'TIER_SCOPE_INVALID')
  if (roster.evidenceScope !== 'planning-only') add('roster.evidenceScope', 'TIER_EVIDENCE_SCOPE_INVALID')
  if (!text(roster.note)) add('roster.note', 'TIER_NOTE_REQUIRED')
  if (roster.readinessSource !== 'packages/policy-registry/src/pack-contract.ts#inspectPack') add('roster.readinessSource', 'READINESS_SOURCE_INVALID')

  const sources = new Set<string>()
  if (!Array.isArray(roster.sources) || !roster.sources.length) add('roster.sources', 'TIER_SOURCES_REQUIRED')
  else for (const [index, source] of roster.sources.entries()) {
    const path = `roster.sources[${index}]`
    if (!object(source)) { add(path, 'TIER_SOURCE_INVALID'); continue }
    fields(source, ['id', 'path', 'section', 'date', 'note'], path)
    if (!text(source.id)) add(`${path}.id`, 'TIER_SOURCE_ID_INVALID')
    else { if (sources.has(source.id)) add(`${path}.id`, 'TIER_SOURCE_DUPLICATE'); sources.add(source.id) }
    if (!sourcePath(source.path)) add(`${path}.path`, 'TIER_SOURCE_PATH_INVALID')
    if (!text(source.section)) add(`${path}.section`, 'TIER_SOURCE_SECTION_REQUIRED')
    if (typeof source.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.date) || !Number.isFinite(Date.parse(`${source.date}T00:00:00Z`)) || new Date(`${source.date}T00:00:00Z`).toISOString().slice(0, 10) !== source.date) add(`${path}.date`, 'TIER_SOURCE_DATE_INVALID')
    if (!text(source.note)) add(`${path}.note`, 'TIER_NOTE_REQUIRED')
  }
  const sourceRef = (value: unknown, path: string) => {
    if (!text(value) || !sources.has(value)) add(path, 'TIER_SOURCE_UNKNOWN')
  }
  const seen = new Set<string>()
  const member = (value: unknown, path: string) => {
    if (!packId(value)) { add(path, 'PACK_ID_INVALID'); return }
    if (!ids.has(value)) add(path, 'TIER_PACK_UNKNOWN')
    if (seen.has(value)) add(path, 'TIER_PACK_DUPLICATE')
    seen.add(value)
  }
  if (!Array.isArray(roster.packs) || !roster.packs.length) add('roster.packs', 'T0_PACKS_REQUIRED')
  else for (const [index, entry] of roster.packs.entries()) {
    const path = `roster.packs[${index}]`
    if (!object(entry)) { add(path, 'TIER_ENTRY_INVALID'); continue }
    fields(entry, ['packId', 'tier', 'sourceIds'], path)
    member(entry.packId, `${path}.packId`)
    if (entry.tier !== 'T0') add(`${path}.tier`, 'T0_TIER_INVALID')
    if (!Array.isArray(entry.sourceIds) || !entry.sourceIds.length) add(`${path}.sourceIds`, 'TIER_SOURCE_REFS_REQUIRED')
    else {
      entry.sourceIds.forEach((id, i) => sourceRef(id, `${path}.sourceIds[${i}]`))
      if (new Set(entry.sourceIds).size !== entry.sourceIds.length) add(`${path}.sourceIds`, 'TIER_SOURCE_REF_DUPLICATE')
    }
  }
  if (!Array.isArray(roster.conflicts)) add('roster.conflicts', 'TIER_CONFLICTS_INVALID')
  else for (const [index, conflict] of roster.conflicts.entries()) {
    const path = `roster.conflicts[${index}]`
    if (!object(conflict)) { add(path, 'TIER_CONFLICT_INVALID'); continue }
    fields(conflict, ['packId', 'claims', 'note'], path)
    member(conflict.packId, `${path}.packId`)
    if (!text(conflict.note)) add(`${path}.note`, 'TIER_NOTE_REQUIRED')
    const tiers = new Set<PackTier>()
    const claimSources = new Set<string>()
    if (!Array.isArray(conflict.claims)) add(`${path}.claims`, 'TIER_CONFLICT_CLAIMS_REQUIRED')
    else for (const [i, claim] of conflict.claims.entries()) {
      const claimPath = `${path}.claims[${i}]`
      if (!object(claim)) { add(claimPath, 'TIER_CLAIM_INVALID'); continue }
      fields(claim, ['tier', 'sourceId'], claimPath)
      if (!tier(claim.tier)) add(`${claimPath}.tier`, 'TIER_CLAIM_INVALID')
      else tiers.add(claim.tier)
      sourceRef(claim.sourceId, `${claimPath}.sourceId`)
      if (text(claim.sourceId)) {
        if (claimSources.has(claim.sourceId)) add(`${claimPath}.sourceId`, 'TIER_SOURCE_REF_DUPLICATE')
        claimSources.add(claim.sourceId)
      }
    }
    if (tiers.size < 2 || !tiers.has('T0') || claimSources.size < 2) add(`${path}.claims`, 'TIER_CONFLICT_NOT_DISTINCT')
  }
  return issues
}

/** Exact registered IDs only. No aliases, fallback pack, inferred T1, or readiness flags. */
export function lookupPackTier(roster: unknown, registry: unknown, id: string): PackTierMetadata {
  const issues = validateT0Roster(roster, registry)
  if (issues.length) throw Object.assign(new Error('PACK_TIER_ROSTER_INVALID'), { code: 'PACK_TIER_ROSTER_INVALID', issues }) as TierRosterError
  const registered = registry as { packs: Array<{ packId: string }> }
  if (!registered.packs.some(entry => entry.packId === id)) throw Object.assign(new Error(`PACK_NOT_FOUND: ${id}`), { code: 'PACK_NOT_FOUND' }) as TierRosterError
  const value = roster as T0Roster
  const entry = value.packs.find(entry => entry.packId === id)
  if (entry) return { packId: id, classification: 'documented', tier: 'T0', sourceIds: [...entry.sourceIds] }
  const conflict = value.conflicts.find(entry => entry.packId === id)
  if (conflict) return { packId: id, classification: 'conflicting-docs', tier: null, claims: conflict.claims.map(claim => ({ ...claim })) }
  return { packId: id, classification: 'unclassified', tier: null }
}
