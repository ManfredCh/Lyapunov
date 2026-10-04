/** Offline metadata validation only; no real endpoint, asset download, or policy execution. */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { lookupPackTier, T0_ROSTER_FILE, validateT0Roster } from '../src/tier-roster.ts'

const ROOT = join(import.meta.dir, '../../..')
const PACKS = join(ROOT, 'packs')
const registry = JSON.parse(readFileSync(join(PACKS, 'registry.json'), 'utf8'))
const roster = JSON.parse(readFileSync(join(PACKS, T0_ROSTER_FILE), 'utf8'))
const copy = () => structuredClone(roster)
const codes = (value: unknown, catalog: unknown = registry) => validateT0Roster(value, catalog).map(issue => issue.code)

const T0 = [
  'allegro_hand', 'crazyflie_2', 'franka_panda', 'generic_quadrotor',
  'leap_hand', 'shadow_hand', 'unitree_a1', 'unitree_g1', 'unitree_go1', 'unitree_go2', 'ur10e',
]

describe('authoritative documented T0 roster', () => {
  test('registry points to the roster and every current pack identity/metadata agrees with pack.json', () => {
    expect(registry.tierRoster).toBe(T0_ROSTER_FILE)
    expect(validateT0Roster(roster, registry)).toEqual([])
    const dirs = readdirSync(PACKS, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'node_modules').map(entry => entry.name).sort()
    expect(registry.packs.map((entry: any) => entry.packId).sort()).toEqual(dirs)
    for (const row of registry.packs) {
      const pack = JSON.parse(readFileSync(join(PACKS, row.packId, 'pack.json'), 'utf8'))
      for (const field of ['packId', 'version', 'family', 'capabilities', 'status']) expect(row[field]).toEqual(pack[field])
      for (const piece of ['asset', 'context', 'policy', 'vla']) expect(row.pieces[piece]).toBe(piece === 'asset' || pack.pieces[piece] === 'ready')
    }
  })

  test('pins documented T0 membership and resolves each repository source reference', () => {
    expect(roster.packs.map((entry: any) => entry.packId)).toEqual(T0)
    for (const source of roster.sources) {
      const doc = readFileSync(join(ROOT, source.path), 'utf8')
      expect(doc).toContain(source.section)
    }
    for (const id of T0) expect(lookupPackTier(roster, registry, id)).toMatchObject({ packId: id, classification: 'documented', tier: 'T0' })
  })

  test('preserves the UR5e T0/T1 documentation conflict instead of guessing a winning tier', () => {
    expect(roster.conflicts).toHaveLength(1)
    const result = lookupPackTier(roster, registry, 'ur5e')
    expect(result).toEqual({ packId: 'ur5e', classification: 'conflicting-docs', tier: null, claims: [
      { tier: 'T0', sourceId: 'original-tier-table' },
      { tier: 'T1', sourceId: 'expansion-tier-table' },
    ] })
    const original = readFileSync(join(ROOT, roster.sources[0].path), 'utf8')
    const expansion = readFileSync(join(ROOT, roster.sources[1].path), 'utf8')
    expect(original).toContain('| 机械臂 | Franka Panda、UR5e/UR10e |')
    expect(expansion).toContain('| 机械臂 | ur5e | T1 |')
  })

  test('用户移出的叉车不再默认T0，原包仍在且不自动推为T1或T2',()=>{
    expect(roster.packs).toHaveLength(11)
    expect(roster.packs.some((row:any)=>row.packId==='forklift_c')).toBe(false)
    expect(registry.packs.some((row:any)=>row.packId==='forklift_c')).toBe(true)
    expect(JSON.parse(readFileSync(join(PACKS,'forklift_c','pack.json'),'utf8')).packId).toBe('forklift_c')
    expect(lookupPackTier(roster,registry,'forklift_c')).toEqual({packId:'forklift_c',classification:'unclassified',tier:null})
    expect(readFileSync(join(ROOT,'docs/ROBOT_TIERS.md'),'utf8')).toContain('用户范围调整（2026-10-04）')
  })

  test('absence from this T0 roster is unclassified, not inferred T1 or unsupported', () => {
    expect(lookupPackTier(roster, registry, 'iiwa14')).toEqual({ packId: 'iiwa14', classification: 'unclassified', tier: null })
    expect(lookupPackTier(roster, registry, 'lyaup_demo_arm')).toEqual({ packId: 'lyaup_demo_arm', classification: 'unclassified', tier: null })
  })

  test.each(['missing_pack', 'unitree_go3', 'Go2', 'packs/unitree_go2', '../unitree_go2', 'constructor', '__proto__', ''])('unknown ID %s fails explicitly without alias/family fallback', id => {
    let error: any
    try { lookupPackTier(roster, registry, id) } catch (reason) { error = reason }
    expect(error?.code).toBe('PACK_NOT_FOUND')
  })

  test('tier lookup never derives or copies contentReady/adapterReady/behaviorVerified from status', () => {
    const catalog = structuredClone(registry)
    for (const row of catalog.packs) Object.assign(row, { contentReady: true, adapterReady: true, behaviorVerified: true })
    for (const id of [...T0, 'ur5e', 'iiwa14']) {
      const result = lookupPackTier(roster, catalog, id)
      for (const key of ['contentReady', 'adapterReady', 'behaviorVerified', 'status', 'pieces']) expect(Object.hasOwn(result, key)).toBe(false)
    }
    expect(catalog.packs.find((row: any) => row.packId === 'allegro_hand').status).toBe('BLOCKED:hold-drift')
    expect(lookupPackTier(roster, catalog, 'allegro_hand').tier).toBe('T0')
    expect(catalog.packs.find((row: any) => row.packId === 'shadow_hand').status).toBe('BLOCKED:grasp-hold')
    expect(lookupPackTier(roster, catalog, 'shadow_hand').tier).toBe('T0')
  })

  test('lookup returns independent metadata, not mutable references into the roster', () => {
    const value = copy()
    const before = JSON.stringify(value)
    const documented = lookupPackTier(value, registry, 'franka_panda')
    const conflicting = lookupPackTier(value, registry, 'ur5e')
    if (documented.classification === 'documented') documented.sourceIds.push('not-a-source')
    if (conflicting.classification === 'conflicting-docs') conflicting.claims[0]!.tier = 'T2'
    expect(JSON.stringify(value)).toBe(before)
  })
})

describe('tier registry rejects malformed metadata', () => {
  test.each([null, [], {}, 'T0', 1].map(value => ({ value })))('invalid root/schema: %j', ({ value }) => {
    expect(validateT0Roster(value, registry).length).toBeGreaterThan(0)
  })

  test.each([undefined, null, '', 't0', 'T1', 0, true])('confirmed roster tier must be exactly T0: %j', value => {
    const fixture = copy()
    fixture.packs[0].tier = value
    expect(codes(fixture)).toContain('T0_TIER_INVALID')
  })

  test('dangling/duplicate packs and overlap with conflicts are rejected', () => {
    const unknown = copy()
    unknown.packs[0].packId = 'unknown_robot'
    expect(codes(unknown)).toContain('TIER_PACK_UNKNOWN')
    const duplicate = copy()
    duplicate.packs.push(duplicate.packs[0])
    expect(codes(duplicate)).toContain('TIER_PACK_DUPLICATE')
    const overlap = copy()
    overlap.conflicts[0].packId = 'franka_panda'
    expect(codes(overlap)).toContain('TIER_PACK_DUPLICATE')
    const unknownConflict = copy()
    unknownConflict.conflicts[0].packId = 'unknown_robot'
    expect(codes(unknownConflict)).toContain('TIER_PACK_UNKNOWN')
  })

  test('registry schema, pointer, invalid IDs, and duplicate IDs fail closed', () => {
    expect(codes(roster, { packs: [] })).toContain('REGISTRY_INVALID')
    const catalog = structuredClone(registry)
    catalog.tierRoster = 'not-the-authority.json'
    catalog.packs.push(catalog.packs[0], { packId: '../escape' })
    expect(codes(roster, catalog)).toEqual(expect.arrayContaining(['TIER_ROSTER_REFERENCE_INVALID', 'PACK_ID_DUPLICATE', 'PACK_ID_INVALID']))
    expect(() => lookupPackTier(roster, catalog, 'franka_panda')).toThrow('PACK_TIER_ROSTER_INVALID')
  })

  test('missing, duplicate, and unknown source refs do not silently lose provenance', () => {
    const fixture = copy()
    fixture.packs[0].sourceIds = []
    fixture.packs[1].sourceIds = ['missing']
    fixture.packs[2].sourceIds = ['original-tier-table', 'original-tier-table']
    fixture.sources.push(fixture.sources[0])
    expect(codes(fixture)).toEqual(expect.arrayContaining(['TIER_SOURCE_REFS_REQUIRED', 'TIER_SOURCE_UNKNOWN', 'TIER_SOURCE_REF_DUPLICATE', 'TIER_SOURCE_DUPLICATE']))
  })

  test.each(['/local/doc.md', '../outside.md', 'docs/../outside.md', 'https://example.test/doc.md', 'C:\\doc.md', 'docs/file.json', 'docs//file.md'])('source reference stays repository-relative: %s', path => {
    const fixture = copy()
    fixture.sources[0].path = path
    expect(codes(fixture)).toContain('TIER_SOURCE_PATH_INVALID')
  })

  test('source dates and sections must be real metadata', () => {
    const fixture = copy()
    fixture.sources[0].date = '2026-02-30'
    fixture.sources[0].section = ''
    expect(codes(fixture)).toEqual(expect.arrayContaining(['TIER_SOURCE_DATE_INVALID', 'TIER_SOURCE_SECTION_REQUIRED']))
  })

  test('conflicts need distinct documented tiers including T0 from distinct sources', () => {
    for (const claims of [[], [{ tier: 'T0', sourceId: 'original-tier-table' }], [{ tier: 'T0', sourceId: 'original-tier-table' }, { tier: 'T0', sourceId: 'expansion-tier-table' }], [{ tier: 'T0', sourceId: 'original-tier-table' }, { tier: 'T1', sourceId: 'original-tier-table' }]]) {
      const fixture = copy()
      fixture.conflicts[0].claims = claims
      expect(codes(fixture)).toContain('TIER_CONFLICT_NOT_DISTINCT')
    }
    const unknownTier = copy()
    unknownTier.conflicts[0].claims[1].tier = 'TOP'
    expect(codes(unknownTier)).toContain('TIER_CLAIM_INVALID')
  })

  test.each(['contentReady', 'adapterReady', 'behaviorVerified', 'status', 'pieces'])('rejects readiness/status field %s at every tier metadata level', key => {
    for (const location of ['root', 'source', 'entry', 'conflict', 'claim']) {
      const fixture = copy()
      const target = location === 'root' ? fixture : location === 'source' ? fixture.sources[0] : location === 'entry' ? fixture.packs[0] : location === 'conflict' ? fixture.conflicts[0] : fixture.conflicts[0].claims[0]
      target[key] = true
      expect(codes(fixture)).toContain('TIER_FIELD_UNEXPECTED')
    }
  })

  test('planning-only evidence boundary and inspectPack readiness authority are mandatory', () => {
    const fixture = copy()
    fixture.evidenceScope = 'behavior-verified'
    fixture.readinessSource = 'packs/t0-roster.json'
    expect(codes(fixture)).toEqual(expect.arrayContaining(['TIER_EVIDENCE_SCOPE_INVALID', 'READINESS_SOURCE_INVALID']))
    let error: any
    try { lookupPackTier(fixture, registry, 'franka_panda') } catch (reason) { error = reason }
    expect(error?.code).toBe('PACK_TIER_ROSTER_INVALID')
    expect(error?.issues).toEqual(validateT0Roster(fixture, registry))
  })
})
