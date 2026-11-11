import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

test('固定 Lab 数据模块与上游字节一致，许可随模块交付', async () => {
 const root = fileURLToPath(new URL('../python/vendor/isaaclab_data/', import.meta.url))
 const lock = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'))
 expect(lock.revision).toBe('e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4')
 expect(lock.license).toBe('BSD-3-Clause')
 expect(lock.files).toHaveLength(5)
 for (const entry of lock.files) {
  const bytes = await readFile(join(root, entry.path))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
  if (entry.path.endsWith('.py')) expect(bytes.toString()).toContain('SPDX-License-Identifier: BSD-3-Clause')
 }
 expect(await readFile(join(root, 'LICENSE'), 'utf8')).toContain('Redistribution and use')
})
