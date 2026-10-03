/** Offline adversarial coverage for the managed-provider discovery patch. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const lock = JSON.parse(readFileSync(join(root, 'UPSTREAM_LOCK.json'), 'utf8')) as { commit: string; directory: string }
const registry = require('./upstream-patches.mjs') as {
  upstreamPatches: (root: string) => Array<{ file: string; package: string }>
}
const upstream = join(root, lock.directory)
const patch = join(root, 'packages/lyapunov-shell/patches/dsh-managed-provider-discovery.patch')
const llmRelative = 'packages/llm/llm-pi-ai/src'
const settingsRelative = 'packages/settings/settings/src/index.ts'

/** Read one file straight from the pinned commit's git object — never the developer worktree. */
function committed(relative: string): string {
  return execFileSync('git', ['show', `${lock.commit}:${relative}`], { cwd: upstream, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function copyPatchedTree(): string {
  const work = mkdtempSync(join(tmpdir(), 'dsh-managed-discovery-'))
  after(() => rmSync(work, { recursive: true, force: true }))
  try {
    const llm = join(work, 'packages/llm/llm-pi-ai')
    const settings = join(work, 'packages/settings/settings')
    mkdirSync(join(llm, 'src'), { recursive: true })
    mkdirSync(join(settings, 'src'), { recursive: true })
    // The temporary tree is built from the **locked commit's git objects**, so this test no
    // longer reads the developer worktree's uncommitted managed-discovery.ts / config.ts. The
    // formal patch is then applied to that clean baseline, exactly as bootstrap does.
    for (const file of ['discovery.ts', 'catalog.ts', 'index.ts', 'config.ts']) {
      writeFileSync(join(llm, 'src', file), committed(`${llmRelative}/${file}`))
    }
    writeFileSync(join(settings, 'src/index.ts'), committed(settingsRelative))
    // Resolve the native package's declared dependencies, without modifying its links.
    symlinkSync(join(upstream, 'packages/llm/llm-pi-ai/node_modules'), join(llm, 'node_modules'), 'dir')
    execFileSync('git', ['init', '-q'], { cwd: work })
    execFileSync('git', ['apply', '--check', patch], { cwd: work })
    execFileSync('git', ['apply', patch], { cwd: work })
    return work
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw error
  }
}

const work = copyPatchedTree()
const llmSource = join(work, llmRelative)
const settingsSource = join(work, settingsRelative)
const managed = await import(pathToFileURL(join(llmSource, 'managed-discovery.ts')).href)
const discovery = await import(pathToFileURL(join(llmSource, 'discovery.ts')).href)

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

// Bun's fetch has a preconnect entrypoint; the fixture must never delegate it to the network.
function offlineFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(implementation, {
    preconnect: () => { throw new Error('network preconnect must not be reached') },
  })
}

test('patch applies cleanly and preserves the catalog directory path', () => {
  const patchedIndex = readFileSync(join(llmSource, 'index.ts'), 'utf8')
  const patchedSettings = readFileSync(settingsSource, 'utf8')
  assert.match(patchedIndex, /ensureDirectory\(\)/)
  assert.match(patchedIndex, /catalogProviderIds\(\)/)
  assert.match(patchedIndex, /assertManagedProfileAuthority\(value\.providers, config\.providers\)/)
  assert.doesNotMatch(patchedSettings, /writeAccess|requires its native owner scope/)
  // Reverse applicability confirms the exact patch is installed in the disposable tree.
  assert.equal(execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: work, encoding: 'utf8' }), '')
})

test('the formal patch is registered in the build flow and repeated application is a no-op', () => {
  // Registration: the patch must be part of upstreamPatches(), or a clean lock checkout
  // could neither build the implementation nor even import managed-discovery.ts.
  const entry = registry.upstreamPatches(root).find(candidate => resolve(candidate.file) === resolve(patch))
  assert.ok(entry, 'dsh-managed-provider-discovery.patch must appear in upstreamPatches()')
  assert.equal(entry.package, '@deepseek-ai/dsh-llm-pi-ai')

  // Idempotency: applyUpstreamPatches() treats a patch whose reverse check succeeds as
  // "already-applied". The tree is in that state now, so a repeated call is a no-op and a
  // second forward application is rejected rather than double-applied.
  assert.equal(execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: work, encoding: 'utf8' }), '')
  assert.throws(() => execFileSync('git', ['apply', '--check', patch], { cwd: work, stdio: 'pipe' }))

  // The formal flow is repeatable: unapply, then re-apply from the clean-baseline state.
  execFileSync('git', ['apply', '--reverse', patch], { cwd: work })
  execFileSync('git', ['apply', '--check', patch], { cwd: work })
  execFileSync('git', ['apply', patch], { cwd: work })
})

test('managed endpoint normalization rejects non-HTTP and credential-bearing values', () => {
  assert.equal(managed.normalizeManagedEndpoint('https://gateway.invalid/v1/'), 'https://gateway.invalid/v1')
  assert.equal(managed.sameManagedEndpoint('https://gateway.invalid/v1/', 'https://gateway.invalid/v1'), true)
  for (const value of [
    'ftp://gateway.invalid/v1',
    'https://user:pass@gateway.invalid/v1',
    'https://gateway.invalid/v1?tenant=secret',
    'https://gateway.invalid/v1#fragment',
  ]) {
    assert.throws(() => managed.normalizeManagedEndpoint(value))
    assert.equal(managed.sameManagedEndpoint(value, 'https://gateway.invalid/v1'), false)
  }
})

test('stored headers and API keys bind to the host endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = offlineFetch(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response({ data: [{ id: 'offline-model' }] })
  })
  try {
    let resolves = 0
    const stored = () => ({
      configuredBaseURL: 'https://gateway.invalid/v1',
      headers: { 'x-managed-tenant': 'tenant-sentinel' },
      managedBaseURL: undefined,
      resolveApiKey: async () => { resolves += 1; return 'key-sentinel' },
    })
    await discovery.discoverModels({ provider: 'offline-route', baseURL: 'https://gateway.invalid/v1' }, stored)
    assert.equal(resolves, 1)
    const sameEndpoint = calls.at(-1)
    assert.ok(sameEndpoint)
    const headers = new Headers(sameEndpoint.init.headers)
    assert.equal(headers.get('authorization'), 'Bearer key-sentinel')
    assert.equal(headers.get('x-managed-tenant'), 'tenant-sentinel')
    assert.equal(sameEndpoint.init.redirect, 'manual')

    for (const baseURL of [
      'https://attacker.invalid/v1',
      'https://gateway.invalid/v2',
      'https://gateway.invalid:8443/v1',
      'http://gateway.invalid/v1',
      'https://user:pass@gateway.invalid/v1',
      'https://gateway.invalid/v1?tenant=other',
      'https://gateway.invalid/v1#other',
    ]) {
      await discovery.discoverModels({ provider: 'offline-route', baseURL }, stored)
      const editedEndpoint = calls.at(-1)
      assert.ok(editedEndpoint)
      const editedHeaders = new Headers(editedEndpoint.init.headers)
      assert.equal(editedHeaders.get('authorization'), null)
      assert.equal(editedHeaders.get('x-managed-tenant'), null)
    }
    assert.equal(resolves, 1)
    await discovery.discoverModels({
      provider: 'offline-route',
      baseURL: 'https://attacker.invalid/v1',
      apiKey: 'typed-sentinel',
    }, stored)
    const typedEndpoint = calls.at(-1)
    assert.ok(typedEndpoint)
    const typedHeaders = new Headers(typedEndpoint.init.headers)
    assert.equal(typedHeaders.get('authorization'), 'Bearer typed-sentinel')
    assert.equal(typedHeaders.get('x-managed-tenant'), null)
    assert.equal(resolves, 1)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('discovery refuses every redirect status and never invokes a second destination', async () => {
  const previousFetch = globalThis.fetch
  try {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      let count = 0
      globalThis.fetch = offlineFetch(async (_url, init) => {
        count += 1
        assert.equal(init?.redirect, 'manual')
        return new Response(null, { status, headers: { location: 'https://attacker.invalid/models' } })
      })
      await assert.rejects(
        discovery.discoverModels({ provider: 'offline-route', baseURL: 'https://gateway.invalid/v1', apiKey: 'typed-sentinel' }),
        /will not follow it/,
      )
      assert.equal(count, 1)
    }
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('managed route endpoint equality rejects edited drafts before fetch', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = offlineFetch(async () => response({ data: [{ id: 'unexpected' }] }))
  try {
    await assert.rejects(
      discovery.discoverModels(
        { provider: 'managed-route', baseURL: 'https://attacker.invalid/v1' },
        () => ({
          configuredBaseURL: 'https://gateway.invalid/v1',
          headers: { authorization: 'Bearer secret-sentinel' },
          managedBaseURL: 'https://gateway.invalid/v1',
          resolveApiKey: async () => 'secret-sentinel',
        }),
      ),
      /cannot discover models at a different endpoint/,
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('catalog discovery stays local and does not resolve stored credentials', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = offlineFetch(async () => { throw new Error('network must not be reached') })
  try {
    const models = await discovery.discoverModels(
      { provider: 'deepseek' },
      () => ({
        configuredBaseURL: 'https://gateway.invalid/v1',
        headers: { authorization: 'Bearer secret-sentinel' },
        managedBaseURL: undefined,
        resolveApiKey: async () => { throw new Error('credential must stay lazy') },
      }),
    )
    assert.ok(models.length > 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('settings authority rejects forged managed markers but permits ordinary profile edits', () => {
  const composition = {
    managed: { baseURL: 'https://gateway.invalid/v1', managedBaseURL: 'https://gateway.invalid/v1' },
    ordinary: { baseURL: 'https://ordinary.invalid/v1' },
  }
  assert.doesNotThrow(() => managed.assertManagedProfileAuthority({
    ...composition,
    ordinary: { baseURL: 'https://ordinary-edited.invalid/v1' },
  }, composition))
  for (const providers of [
    { ...composition, ordinary: { managedBaseURL: 'https://attacker.invalid/v1' } },
    { ...composition, managed: { baseURL: 'https://gateway.invalid/v1' } },
    { ...composition, managed: { baseURL: 'https://attacker.invalid/v1', managedBaseURL: 'https://gateway.invalid/v1' } },
    { ordinary: composition.ordinary },
  ]) {
    assert.throws(() => managed.assertManagedProfileAuthority(providers, composition), /managed|composition endpoint/)
  }
})
