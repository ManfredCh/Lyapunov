import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateBehaviorEvidence } from '../src/behavior-evidence.ts'
import { inspectPack } from '../src/pack-contract.ts'

const makeRoot = () => mkdtemp(join(tmpdir(), 'behavior-evidence-'))
const issueCodes = (result: { issues: Array<{ code: string }> }) => result.issues.map((issue) => issue.code)

async function makePackRoot() {
  const root = await makeRoot()
  await mkdir(join(root, 'asset'))
  await mkdir(join(root, 'context'))
  await mkdir(join(root, 'policy'))
  await mkdir(join(root, 'vla'))
  await writeFile(join(root, 'asset', 'robot.xml'), '<mujoco model="fixture"><worldbody/></mujoco>')
  await writeFile(join(root, 'policy', 'manifest.json'), JSON.stringify({
    mode: 'direct-control',
    adapter: 'none',
    status: 'ready',
    verified: { behavior: { status: 'PASS', evidence: ['evidence/receipt.json'] } },
    action: { channelsUsed: ['fixture'] },
  }))
  await writeFile(join(root, 'pack.json'), JSON.stringify({
    packId: 'behavior-fixture',
    version: '1',
    status: 'PARTIAL:behavior-unverified',
    pieces: { asset: 'ready', context: 'ready', policy: 'ready', vla: 'blocked:test' },
    asset: { modelEntry: 'asset/robot.xml' },
    capabilities: { channels: ['fixture'] },
  }))
  return root
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true })
}

describe('behavior evidence validator', () => {
  test('accepts a plain nonempty file path and rejects empty, directory, traversal, absolute, and symlink paths', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    try {
      await mkdir(join(root, 'evidence'))
      await writeFile(join(root, 'evidence', 'ok.txt'), 'receipt')
      await mkdir(join(root, 'evidence', 'dir'))
      await writeFile(join(outside, 'outside.txt'), 'outside')
      await symlink(join(outside, 'outside.txt'), join(root, 'evidence', 'file-link'))
      await symlink(outside, join(root, 'evidence', 'dir-link'))
      await writeFile(join(root, 'evidence', 'empty.txt'), '')

      expect((await validateBehaviorEvidence(root, ['evidence/ok.txt'])).valid).toBe(true)
      const result = await validateBehaviorEvidence(root, [
        '',
        'evidence/empty.txt',
        'evidence/dir',
        '../outside.txt',
        '/tmp/evidence.txt',
        'C:/evidence.txt',
        'evidence/file-link',
        'evidence/dir-link',
        'evidence/dir-link/outside.txt',
      ])
      expect(result.valid).toBe(false)
      expect(issueCodes(result)).toEqual(expect.arrayContaining([
        'BEHAVIOR_EVIDENCE_PATH_INVALID',
        'BEHAVIOR_EVIDENCE_EMPTY',
        'BEHAVIOR_EVIDENCE_NOT_REGULAR_FILE',
        'BEHAVIOR_EVIDENCE_PATH_TRAVERSAL',
        'BEHAVIOR_EVIDENCE_SYMLINK',
      ]))
    } finally {
      await cleanup(root)
      await cleanup(outside)
    }
  })

  test('does not filter malformed evidence entries and validates only explicitly declared receipt identity fields', async () => {
    const root = await makeRoot()
    try {
      await mkdir(join(root, 'evidence'))
      await writeFile(join(root, 'evidence', 'pass.json'), JSON.stringify({
        identity: { pack: 'fixture', revision: 3 },
        robot: 'fixture-arm',
        engine: 'mujoco',
        outcome: 'PASS',
        unrelated: { ignored: true },
      }))
      const expected = await validateBehaviorEvidence(root, [
        { path: 'evidence/pass.json', format: 'json', expected: { identity: { revision: 3, pack: 'fixture' }, robot: 'fixture-arm', engine: 'mujoco', outcome: 'PASS' } },
        null,
        { path: 'evidence/pass.json', format: 'json', expected: { unsupported: true } },
        { path: 'evidence/pass.json', format: 'json', extra: 'reject-me' },
      ])
      expect(expected.valid).toBe(false)
      expect(issueCodes(expected)).toEqual(expect.arrayContaining([
        'BEHAVIOR_EVIDENCE_DESCRIPTOR_INVALID',
        'BEHAVIOR_EVIDENCE_EXPECTATION_UNSUPPORTED',
        'BEHAVIOR_EVIDENCE_DESCRIPTOR_FIELD_UNSUPPORTED',
      ]))
      expect(issueCodes(expected)).not.toContain('BEHAVIOR_EVIDENCE_RECEIPT_MISMATCH')
    } finally {
      await cleanup(root)
    }
  })

  test('requires json for structured descriptors and rejects malformed or failing receipts', async () => {
    const root = await makeRoot()
    try {
      await mkdir(join(root, 'evidence'))
      await writeFile(join(root, 'evidence', 'bad.json'), '{not-json')
      await writeFile(join(root, 'evidence', 'failed.json'), JSON.stringify({ status: 'FAILED', identity: 'wrong' }))
      await writeFile(join(root, 'evidence', 'mismatch.json'), JSON.stringify({ status: 'PASS', identity: 'other' }))
      const result = await validateBehaviorEvidence(root, [
        { path: 'evidence/failed.json', expected: { identity: 'wrong' } },
        { path: 'evidence/bad.json', format: 'json' },
        { path: 'evidence/failed.json', format: 'json', expected: { identity: 'expected' } },
        { path: 'evidence/mismatch.json', format: 'json', expected: { identity: 'expected' } },
        { path: 'evidence/mismatch.json', format: 'yaml' },
      ])
      expect(result.valid).toBe(false)
      expect(issueCodes(result)).toEqual(expect.arrayContaining([
        'BEHAVIOR_EVIDENCE_FORMAT_REQUIRED',
        'BEHAVIOR_EVIDENCE_JSON_INVALID',
        'BEHAVIOR_EVIDENCE_OUTCOME_FAILURE',
        'BEHAVIOR_EVIDENCE_RECEIPT_MISMATCH',
        'BEHAVIOR_EVIDENCE_FORMAT_UNSUPPORTED',
      ]))
    } finally {
      await cleanup(root)
    }
  })
})

describe('inspectPack behavior evidence integration', () => {
  test('uses raw evidence entries and stays false for malformed PASS declarations', async () => {
    const root = await makePackRoot()
    try {
      const manifestPath = join(root, 'policy', 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({
        mode: 'direct-control',
        adapter: 'none',
        status: 'ready',
        verified: { behavior: { status: 'PASS', evidence: ['', 'evidence/receipt.json'] } },
        action: { channelsUsed: ['fixture'] },
      }))
      await mkdir(join(root, 'evidence'))
      await writeFile(join(root, 'evidence', 'receipt.json'), '{"status":"PASS"}')
      const contract = await inspectPack(root)
      expect(contract.behaviorVerified).toBe(false)
      expect(issueCodes(contract)).toEqual(expect.arrayContaining(['BEHAVIOR_EVIDENCE_PATH_INVALID']))
    } finally {
      await cleanup(root)
    }
  })

  test('accepts a complete typed receipt descriptor without treating unrelated fields as a contract', async () => {
    const root = await makePackRoot()
    try {
      await mkdir(join(root, 'evidence'))
      await writeFile(join(root, 'evidence', 'receipt.json'), JSON.stringify({
        identity: 'behavior-fixture@1',
        robot: 'fixture-arm',
        engine: 'mujoco',
        outcome: 'PASS',
        trace: { frames: 4 },
      }))
      await writeFile(join(root, 'policy', 'manifest.json'), JSON.stringify({
        mode: 'direct-control',
        adapter: 'none',
        status: 'ready',
        verified: { behavior: { status: 'PASS', evidence: [{ path: 'evidence/receipt.json', format: 'json', expected: { identity: 'behavior-fixture@1', robot: 'fixture-arm', engine: 'mujoco', outcome: 'PASS' } }] } },
        action: { channelsUsed: ['fixture'] },
      }))
      const contract = await inspectPack(root)
      expect(contract.behaviorVerified).toBe(true)
      expect(contract.issues.some((issue) => issue.code.startsWith('BEHAVIOR_EVIDENCE_'))).toBe(false)
    } finally {
      await cleanup(root)
    }
  })
})
