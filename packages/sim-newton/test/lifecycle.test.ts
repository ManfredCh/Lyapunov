/** Real worker lifecycle under inert engine modules; no Newton/Warp/GPU imports. */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const python = '/usr/bin/python3'
describe.skipIf(!existsSync(python))('Newton offline lifecycle', () => {
  test('fault teardown, recovery, rollback, and protocol loop with fake native handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'newton-lifecycle-'))
    try {
      const run = spawnSync(python, ['-B', '-S', join(here, 'lifecycle_fixture.py'), join(here, '../python/worker.py')], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
      })
      expect(run.error).toBeUndefined()
      expect(run.signal).toBeNull()
      if (run.status !== 0) throw new Error(`offline lifecycle fixture failed:\n${run.stdout}\n${run.stderr}`)
      expect(run.status).toBe(0)
      expect(run.stderr).toContain('Ran 4 tests')
      expect(run.stderr).toContain('\nOK\n')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
