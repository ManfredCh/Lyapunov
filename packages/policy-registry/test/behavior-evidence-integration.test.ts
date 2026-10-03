import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectPack } from '../src/pack-contract.ts'

const packJson = {
  packId: 'behavior-evidence-fixture',
  version: 'test',
  asset: { modelEntry: 'asset/model.xml' },
  pieces: { asset: 'ready', context: 'ready', policy: 'ready', vla: 'ready' },
  capabilities: { channels: ['joint'] },
}

const manifest = (evidence: unknown[]) => ({
  schemaVersion: 1,
  packId: packJson.packId,
  version: packJson.version,
  mode: 'direct-control',
  adapter: 'none',
  weights: null,
  status: 'ready',
  action: { semantics: 'fixture', channelsUsed: ['joint'] },
  verified: { behavior: { status: 'PASS', evidence } },
})

async function fixturePack(evidence: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'behavior-evidence-pack-'))
  await Promise.all([
    mkdir(join(root, 'asset')),
    mkdir(join(root, 'context')),
    mkdir(join(root, 'policy')),
    mkdir(join(root, 'vla')),
  ])
  await Promise.all([
    writeFile(join(root, 'pack.json'), JSON.stringify(packJson)),
    writeFile(join(root, 'asset', 'model.xml'), '<mujoco model="fixture"><worldbody/></mujoco>'),
    writeFile(join(root, 'policy', 'manifest.json'), JSON.stringify(manifest(evidence))),
    writeFile(join(root, 'vla', 'adapter.json'), JSON.stringify({ observation: {}, action: {} })),
  ])
  return root
}

async function withFixture(evidence: unknown[], action: (root: string) => Promise<void>) {
  const root = await fixturePack(evidence)
  try { await action(root) } finally { await rm(root, { recursive: true, force: true }) }
}

describe('inspectPack behavior evidence integration', () => {
  test('PASS declaration with a symlink receipt is false and surfaces the validator issue', async () => {
    await withFixture([{ path: 'context/receipt.json', format: 'json' }], async (root) => {
      const target = join(root, 'context', 'receipt-source.json')
      await writeFile(target, JSON.stringify({ outcome: 'PASS' }))
      await symlink(target, join(root, 'context', 'receipt.json'))
      const contract = await inspectPack(root)
      expect(contract.behaviorVerified).toBe(false)
      expect(contract.issues).toContainEqual({
        path: 'policy.verified.behavior.evidence[0]',
        code: 'BEHAVIOR_EVIDENCE_SYMLINK',
        detail: 'context/receipt.json',
      })
    })
  })

  test('PASS declaration with a mismatched structured JSON receipt is false and surfaces the mismatch', async () => {
    await withFixture([{ path: 'context/receipt.json', format: 'json', expected: { identity: 'declared-id' } }], async (root) => {
      await writeFile(join(root, 'context', 'receipt.json'), JSON.stringify({ identity: 'actual-id', outcome: 'PASS' }))
      const contract = await inspectPack(root)
      expect(contract.behaviorVerified).toBe(false)
      expect(contract.issues).toContainEqual({
        path: 'policy.verified.behavior.evidence[0].expected.identity',
        code: 'BEHAVIOR_EVIDENCE_RECEIPT_MISMATCH',
        detail: 'identity',
      })
    })
  })
})
