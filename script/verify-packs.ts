#!/usr/bin/env node
// verify-packs：能力包汇总交叉核对（PACK_ENDPOINT_CONTRACT.md 合同对账）。
// 用法：node script/verify-packs.ts [--json] [--strict]
// 不修改任何文件。

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPack } from '../packages/policy-registry/src/pack-contract.ts'

const DEFAULT_PACKS_ROOT = join(fileURLToPath(import.meta.url), '..', '..', 'packs')
const PIECES = ['asset', 'context', 'policy', 'vla'] as const

type ManifestFile = { path: string; bytes: number; sha256: string }

/**
 * Recursively enumerate ordinary files without ever following a symlink.
 * A symlink is a verification error, rather than an entry to skip: skipping it
 * would make both counts and secret scans incomplete, while following it could
 * read data outside the pack root.
 */
export function walkFiles(dir: string): string[] {
  const root = lstatSync(dir)
  if (root.isSymbolicLink()) throw new Error(`symlink rejected: ${dir}`)
  if (!root.isDirectory()) throw new Error(`not a directory: ${dir}`)
  return walkFilesFromRealDirectory(dir)
}

function walkFilesFromRealDirectory(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else {
      // Re-check non-directories with lstat so a path replaced after readdir
      // cannot be mistaken for an ordinary file and then followed by a read.
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`)
      if (!stat.isFile()) throw new Error(`not a regular file: ${path}`)
      out.push(path)
    }
  }
  return out
}

/** Reject an absolute/escaping path and every symlink in its existing ancestry. */
export function resolveAssetPath(assetRoot: string, manifestPath: string): string {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    throw new Error('manifest path must be a non-empty string')
  }
  const root = resolve(assetRoot)
  const target = resolve(root, manifestPath)
  const escaped = relative(root, target)
  if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`manifest path escapes asset root: ${manifestPath}`)
  }
  assertNoSymlinkAncestors(root, target)
  return target
}

/**
 * Check an existing path component-by-component with lstat. Missing final
 * components are allowed so callers can report the normal "missing" problem;
 * an existing symlink anywhere in the path is always rejected.
 */
export function assertNoSymlinkAncestors(root: string, target: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes root: ${target}`)
  }
  let current = resolvedRoot
  for (const component of rel ? rel.split(sep) : []) {
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${current}`)
    current = join(current, component)
  }
  try {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink rejected: ${current}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function sha256File(path: string): string {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`)
  if (!stat.isFile()) throw new Error(`not a regular file: ${path}`)
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export interface AssetManifestCheck {
  problems: string[]
  diskFiles: number
}

/** Verify manifest targets and checksums against one asset directory. */
export function verifyAssetManifest(assetRoot: string, files: readonly ManifestFile[]): AssetManifestCheck {
  const problems: string[] = []
  let diskFiles = 0
  try {
    diskFiles = walkFiles(assetRoot).length
  } catch (error) {
    problems.push(`asset tree rejected: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string') {
      problems.push('台账条目缺少有效 path')
      continue
    }
    let path: string
    try {
      path = resolveAssetPath(assetRoot, file.path)
    } catch (error) {
      problems.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!existsSync(path)) {
      problems.push(`台账有而磁盘缺 ${file.path}`)
      continue
    }
    try {
      const actual = sha256File(path)
      if (actual !== file.sha256) problems.push(`sha256 不符 ${file.path}（台账 ${file.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`)
    } catch (error) {
      problems.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (diskFiles !== files.length) problems.push(`台账 ${files.length} 文件 vs 磁盘 ${diskFiles}`)
  return { problems, diskFiles }
}

function listPackDirectories(root: string): string[] {
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink()) throw new Error(`symlink rejected: ${root}`)
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`symlink rejected: ${join(root, entry.name)}`)
      return entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'node_modules'
    })
    .map((entry) => entry.name)
}

export interface VerifyPacksSummary {
  status: string
  packs: number
  contentReady: number
  adapterReady: number
  behaviorVerified: number
  not_ready: string[]
  problems: string[]
  notes: string[]
  scanned_files: number
}

export async function verifyPacks(packsRoot = DEFAULT_PACKS_ROOT): Promise<VerifyPacksSummary> {
  const problems: string[] = []
  const notes: string[] = []
  const contractRows: Array<{ id: string; contentReady: boolean; adapterReady: boolean; behaviorVerified: boolean; route: string; status: string }> = []
  let packDirs: string[] = []
  let treeSafe = false
  let treeFiles: string[] = []

  if (!existsSync(packsRoot)) {
    problems.push('packs/ 不存在')
  } else {
    try {
      packDirs = listPackDirectories(packsRoot)
      // Validate the complete tree before reading pack.json or any manifest.
      // This prevents a symlinked pack file from being followed by a direct read.
      treeFiles = walkFiles(packsRoot)
      treeSafe = true
    } catch (error) {
      problems.push(`目录树拒绝软链：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // A symlink anywhere means the tree is not safe to inspect. Return a
  // deterministic blocked report without following it in later checks.
  if (treeSafe) {
    // 1) 四件套
    for (const id of packDirs) {
      const pj = join(packsRoot, id, 'pack.json')
      if (!existsSync(pj)) { problems.push(`${id}: 缺 pack.json`); continue }
      let meta: Record<string, any> = {}
      try { meta = JSON.parse(readFileSync(pj, 'utf8')) } catch { problems.push(`${id}: pack.json 不是合法 JSON`); continue }
      for (const piece of PIECES) {
        const dir = join(packsRoot, id, piece)
        const declared = meta?.pieces?.[piece]
        const declaredStatus = typeof declared === 'string' ? declared : String(declared?.status ?? '')
        const blocked = declaredStatus.startsWith('blocked')
        const hasFiles = existsSync(dir) && walkFiles(dir).length > 0
        if (!hasFiles && !blocked) problems.push(`${id}: ${piece}/ 无文件且 pack.json 未标 blocked`)
        if (!hasFiles && blocked) notes.push(`${id}: ${piece}/ 缺件已按合同显式标注 ${declaredStatus}`)
      }
      if (meta?.packId && meta.packId !== id) problems.push(`${id}: pack.json packId=${meta.packId} 与目录名不一致`)
    }

    // 2) 资产台账对账（多台账合并：主台账 + _T1 + _ROBOVERSE + _EXTRA，各台账键=packId）
    const mfNames = readdirSync(packsRoot).filter((name) => name.startsWith('ASSET_STAGING_MANIFEST') && name.endsWith('.json')).sort()
    if (mfNames.length === 0) problems.push('缺资产台账（ASSET_STAGING_MANIFEST*.json）')
    const mf: Record<string, { files: ManifestFile[] }> = {}
    for (const name of mfNames) {
      const part = JSON.parse(readFileSync(join(packsRoot, name), 'utf8')) as Record<string, unknown>
      for (const [id, value] of Object.entries(part)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        if (mf[id]) problems.push(`台账重复键 ${id}（出现在 ${name}）`)
        mf[id] = value as { files: ManifestFile[] }
      }
    }
    if (Object.keys(mf).length > 0) {
      for (const [id, record] of Object.entries(mf)) {
        const check = verifyAssetManifest(join(packsRoot, id, 'asset'), record.files ?? [])
        for (const problem of check.problems) problems.push(`${id}: ${problem}`)
      }
      for (const id of packDirs) if (!mf[id]) problems.push(`${id}: 不在资产台账中`)
    }

    // 3) registry ↔ pack.json
    const regPath = join(packsRoot, 'registry.json')
    const registryStatus = new Map<string, string>()
    if (!existsSync(regPath)) problems.push('缺 registry.json')
    else {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'))
      const packs: Array<Record<string, any>> = reg.packs ?? reg
      for (const entry of packs) {
        const id = entry.packId
        if (!packDirs.includes(id)) { problems.push(`registry: ${id} 无对应目录`); continue }
        const meta = JSON.parse(readFileSync(join(packsRoot, id, 'pack.json'), 'utf8'))
        if (entry.status !== meta.status) problems.push(`${id}: registry.status=${entry.status} ≠ pack.json.status=${meta.status}`)
        if (entry.family !== meta.family) problems.push(`${id}: family 不一致`)
        for (const piece of PIECES) {
          const expected = piece === 'asset' ? true : meta?.pieces?.[piece] === 'ready'
          if (entry?.pieces?.[piece] !== expected) problems.push(`${id}: registry.pieces.${piece}=${entry?.pieces?.[piece]} ≠ 生成器口径复算 ${expected}（pack.json.pieces.${piece}=${JSON.stringify(meta?.pieces?.[piece])}）`)
        }
        registryStatus.set(id, String(entry.status ?? ''))
      }
      for (const id of packDirs) if (!packs.some((pack) => pack.packId === id)) problems.push(`${id}: 不在 registry.json`)
    }

    // 4) aliases 悬空检查 + 归一化歧义检查
    const alPath = join(packsRoot, 'aliases.json')
    if (!existsSync(alPath)) problems.push('缺 aliases.json')
    else {
      const al = JSON.parse(readFileSync(alPath, 'utf8'))
      const entries: Array<Record<string, any>> = Array.isArray(al) ? al : (al.aliases ?? al.entries ?? [])
      if (!Array.isArray(entries) || entries.length === 0) problems.push('aliases.json 无可识别条目（aliases/entries 均为空）')
      const targets = (entry: Record<string, any>): string[] => {
        if (typeof entry.packId === 'string') return [entry.packId]
        if (Array.isArray(entry.packIds)) return entry.packIds.filter((value: unknown) => typeof value === 'string')
        return []
      }
      for (const entry of entries) {
        const ids = targets(entry ?? {})
        if (ids.length === 0) { problems.push(`aliases: 条目缺 packId/packIds: ${JSON.stringify(entry).slice(0, 60)}`); continue }
        for (const id of ids) if (!packDirs.includes(id)) problems.push(`aliases: '${entry.alias ?? entry.pattern ?? JSON.stringify(entry).slice(0, 40)}' → ${id} 无对应包`)
      }
      const normalized = (value: string) => value.trim().toLowerCase().replace(/[\s　]+/g, '').replace(/[，。、,.;:!?！？（）()\[\]「」『』/\\·—_-]+/g, '')
      const groups = new Map<string, Array<Record<string, any>>>()
      for (const entry of entries) {
        const alias = entry?.alias ?? entry?.pattern
        if (typeof alias !== 'string' || !alias.trim()) continue
        const key = normalized(alias)
        groups.set(key, [...(groups.get(key) ?? []), entry])
      }
      for (const [key, group] of groups) {
        const best = Math.min(...group.map((entry) => (Number.isInteger(entry.priority) ? entry.priority : 100)))
        const winners = new Set(group.filter((entry) => (Number.isInteger(entry.priority) ? entry.priority : 100) === best).map((entry) => targets(entry)[0]))
        if (winners.size > 1) problems.push(`aliases: '${key}' 在最高优先级 ${best} 上指向 ${[...winners].join(' / ')}（同一说法两个目标 ⇒ 检索不确定）`)
      }
    }

    // 5) 契约复算（contentReady / adapterReady / behaviorVerified）
    const CONTRACT_PROBLEM_CODES = new Set([
      'PACK_MANIFEST_UNREADABLE', 'POLICY_MANIFEST_UNREADABLE', 'POLICY_MODE_INVALID', 'POLICY_STATUS_MISSING',
      'PIECE_MISSING_UNDECLARED', 'VLA_ADAPTER_UNREADABLE', 'WEIGHTS_NOT_OBJECT', 'WEIGHTS_BUNDLED_FLAG_MISSING',
      'WEIGHTS_FILE_MISSING', 'WEIGHTS_FILE_NOT_ON_DISK', 'WEIGHTS_IDENTITY_MISSING', 'WEIGHTS_SHA256_MISMATCH',
      'WEIGHTS_BYTES_MISMATCH', 'WEIGHTS_NOT_BUNDLED_BUT_HAS_IDENTITY', 'WEIGHTS_RESOLUTION_INCOMPLETE',
      'WEIGHTS_RESOLVABLE_WITHOUT_SOURCE', 'WEIGHTS_RESOLUTION_PROVIDER_UNSUPPORTED', 'WEIGHTS_PROVENANCE_MISSING',
      'WEIGHTS_AVAILABILITY_CONTRADICTS_BUNDLED', 'NORM_STATS_FILE_NOT_ON_DISK', 'NORM_STATS_SHA256_MISMATCH',
      'NORM_STATS_SELF_INCONSISTENT', 'NORM_STATS_BYTES_MISMATCH', 'NORM_STATS_HASH_MISSING', 'NORM_ARRAY_WIDTH_MISMATCH',
      'NORM_PADDING_NOT_ZERO', 'NORM_STATS_GROUP_MISSING', 'NORM_STATS_ROW_INVALID', 'BEHAVIOR_EVIDENCE_MISSING',
      'BEHAVIOR_EVIDENCE_NOT_ON_DISK', 'BEHAVIOR_STATUS_INVALID',
    ])
    const assertDeclaredHonestly = (id: string, meta: Record<string, any>, notReady: string[]) => {
      if (notReady.length === 0) return
      if (String(meta?.status ?? '') === 'USABLE') problems.push(`${id}: 复算未就绪（${notReady.join(', ')}）但 pack.json.status=USABLE —— 假 ready`)
    }
    for (const id of packDirs) {
      const meta = JSON.parse(readFileSync(join(packsRoot, id, 'pack.json'), 'utf8'))
      let contract
      try { contract = await inspectPack(join(packsRoot, id)) } catch (error) {
        problems.push(`${id}: 契约复算失败 ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      contractRows.push({ id, contentReady: contract.contentReady, adapterReady: contract.adapterReady, behaviorVerified: contract.behaviorVerified, route: contract.route.kind, status: contract.declaredStatus ?? '' })
      for (const issue of contract.issues) if (CONTRACT_PROBLEM_CODES.has(issue.code)) problems.push(`${id}: [${issue.code}] ${issue.path}${issue.detail ? ` — ${issue.detail}` : ''}`)
      const notReady = [
        contract.contentReady ? '' : 'contentReady=false',
        contract.adapterReady ? '' : `adapterReady=false(${contract.route.kind === 'unavailable' ? contract.route.code : contract.route.kind})`,
      ].filter(Boolean)
      assertDeclaredHonestly(id, meta, notReady)
      const manifestPath = join(packsRoot, id, 'policy', 'manifest.json')
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
      if (manifest?.status === 'ready' && !contract.adapterReady) problems.push(`${id}: policy/manifest.json status=ready 但复算 adapterReady=false（${contract.route.kind === 'unavailable' ? contract.route.code : contract.route.kind}）`)
      if (contract.adapterReady && !notReady.length) notes.push(`${id}: 复算 contentReady+adapterReady（route=${contract.route.kind}，behaviorVerified=${contract.behaviorVerified}）`)
      if (registryStatus.get(id) !== undefined) {
        const pkgStatus = String(meta?.status ?? '')
        const registry = String(registryStatus.get(id))
        const rank = (status: string) => (/^BLOCKED/i.test(status) ? 3 : /^PARTIAL|^UNVERIFIED/i.test(status) ? 2 : 1)
        if (rank(registry) < rank(pkgStatus)) notes.push(`${id}: registry.status=${registry} 比 pack.json.status=${pkgStatus} 更乐观（上面 registry↔pack.json 一致性检查已覆盖不等情形）`)
      }
    }
  }

  // 6) 密钥扫描
  const secretRe = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|Authorization:\s*Bearer\s+(?!\$\{?\w+\}?)[A-Za-z0-9])/i
  let scanned = 0
  if (treeSafe) {
    for (const file of treeFiles) {
      if (/\.(png|jpg|jpeg|gif|webp|stl|dae|obj|glb|gltf|bin|onnx|pt|pth|jit)$/i.test(file)) continue
      scanned++
      const text = readFileSync(file, 'utf8')
      const match = text.match(secretRe)
      if (match) problems.push(`疑似凭据泄露 ${file.replace(packsRoot, 'packs')}: ${match[0].slice(0, 8)}…`)
    }
  }

  const tally = {
    contentReady: contractRows.filter((row) => row.contentReady).length,
    adapterReady: contractRows.filter((row) => row.adapterReady).length,
    behaviorVerified: contractRows.filter((row) => row.behaviorVerified).length,
    notReady: contractRows.filter((row) => !row.adapterReady).map((row) => `${row.id}（route=${row.route}${row.status ? `，manifest.status=${row.status}` : ''}）`),
  }
  return { status: problems.length ? 'BLOCKED' : notes.length ? 'PASS（有已标注缺件）' : 'PASS', packs: packDirs.length, contentReady: tally.contentReady, adapterReady: tally.adapterReady, behaviorVerified: tally.behaviorVerified, not_ready: tally.notReady, problems, notes, scanned_files: scanned }
}

export async function main(argv = process.argv.slice(2), packsRoot = DEFAULT_PACKS_ROOT): Promise<number> {
  const strict = argv.includes('--strict')
  const summary = await verifyPacks(packsRoot)
  if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 1))
  else {
    console.log(`verify-packs: ${summary.status}  （包数 ${summary.packs}，扫描 ${summary.scanned_files} 文本文件）`)
    console.log(`  三级状态：contentReady ${summary.contentReady}/${summary.packs}　adapterReady ${summary.adapterReady}/${summary.packs}　behaviorVerified ${summary.behaviorVerified}/${summary.packs}`)
    for (const row of summary.not_ready) console.log(`  [未就绪] ${row}`)
    for (const note of summary.notes) console.log(`  [已标注] ${note}`)
    for (const problem of summary.problems) console.log(`  [差异]   ${problem}`)
  }
  return strict && summary.problems.length ? 1 : 0
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMainModule) process.exitCode = await main()
