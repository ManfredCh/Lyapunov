#!/usr/bin/env bun
// e2e-pack-download：policy-registry 的 packs 客户端 ↔ pack-endpoint 服务端 跨实现互操作实测。
// 两个实现由不同任务独立开发，本脚本验证合同（PACK_ENDPOINT_CONTRACT.md）在两端一致兑现。
// 用法：
//   PACK_ENDPOINT=http://127.0.0.1:8797 PACK_TOKEN=<token> bun script/e2e-pack-download.ts [packId] [pieces...]
// 判据：downloadPack 成功；落盘文件逐个 sha256 与 open 清单一致；manifest 不含任何 URL；token 不落盘。
// 只写临时目录与 stdout；不写 token。exit 0=PASS，1=FAIL。

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadPack, type PackPiece } from '../packages/policy-registry/src/pack-source.ts'

const packId = process.argv[2] ?? 'fixture_pack'
const pieces = (process.argv.slice(3).length ? process.argv.slice(3) : ['asset', 'context']) as PackPiece[]
const dataDirectory = mkdtempSync(join(tmpdir(), 'pack-e2e-'))
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
let failed = 0
const check = (ok: boolean, label: string) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`); if (!ok) failed++ }

try {
  const controller = new AbortController()
  const manifest = await downloadPack({ dataDirectory, modelId: `packs/${packId}`, pieces, signal: controller.signal })
  check(true, `downloadPack(packs/${packId}, pieces=${pieces.join(',')}) 成功`)

  const files = Array.isArray((manifest as { files?: unknown }).files) ? (manifest as { files: Array<{ path: string; sha256: string }> }).files : []
  const entries = files.length ? files : ((manifest as unknown as { sourceFiles?: Array<{ path: string; sha256: string }> }).sourceFiles ?? [])
  check(entries.length > 0, `清单非空（${entries.length} 件）`)

  const root = join(dataDirectory, 'policies', 'packs')
  const clientManifest = walk(root).find((p) => /manifest\.json$/.test(p) && !p.includes('/asset/') && !p.includes('/context/') && !p.includes('/policy/') && !p.includes('/vla/')) ?? join(root, 'manifest.json')
  const landed = walk(root).filter((p) => p !== clientManifest)
  check(landed.length >= entries.length, `落盘文件数 ${landed.length} ≥ 清单 ${entries.length}`)
  for (const e of entries) {
    const hit = landed.find((p) => p.endsWith(e.path))
    check(!!hit && sha256(hit as string) === e.sha256, `sha256 对账 ${e.path}`)
  }

  const manifestPath = clientManifest
  const text = readFileSync(manifestPath, 'utf8')
  check(!/https?:\/\//i.test(text) && !/"url"/i.test(text), 'manifest 无任何 URL/来源直链（合同 §0.2）')
  check(!text.includes(process.env.PACK_TOKEN ?? '{never-match}'), 'manifest 不含 token（§0.4）')
} catch (e) {
  check(false, `downloadPack 抛错：${(e as { code?: string }).code ?? ''} ${(e as Error).message}`)
} finally {
  rmSync(dataDirectory, { recursive: true, force: true })
}
console.log(failed ? `E2E FAIL（${failed} 项）` : 'E2E PASS：跨实现互操作全对账')
process.exit(failed ? 1 : 0)
