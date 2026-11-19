export type DiscoveryKind = 'software' | 'mcp' | 'bundle' | 'model' | 'tool' | 'asset'

export interface DiscoveredExtension {
  id: string
  name: string
  kind: DiscoveryKind
  description?: string
  version?: string
  catalogId?: 'blender' | 'unity-mcp'
  url?: string
}

export interface DiscoverySource {
  id: string
  name: string
  url: string
  checkedAt: number
  entries: DiscoveredExtension[]
  error?: string
}

interface SourceDefinition {
  id: string
  name: string
  url: string
  endpoint: string
  parse: (body: unknown) => DiscoveredExtension[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function label(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined
}

function localized(value: unknown, max: number): string | undefined {
  return label(value, max) ?? label(object(value)?.zh, max) ?? label(object(value)?.en, max)
}

function parseBlenderCask(body: unknown): DiscoveredExtension[] {
  const cask = object(body)
  const version = label(cask?.version, 80)
  if (cask?.token !== 'blender' || !version) throw Error('Unexpected Blender cask metadata')
  if (cask.disabled === true) return []
  return [{id: 'software:blender', kind: 'software', name: 'Blender', version, catalogId: 'blender'}]
}

function parseMcpRegistry(body: unknown): DiscoveredExtension[] {
  const servers = object(body)?.servers
  if (!Array.isArray(servers)) throw Error('Unexpected MCP Registry response')
  const entries = new Map<string, DiscoveredExtension>()
  for (const item of servers) {
    const row = object(item)
    const server = object(row?.server)
    const official = object(object(row?._meta)?.['io.modelcontextprotocol.registry/official'])
    const name = label(server?.name, 200)
    const version = label(server?.version, 80)
    if (!name || !/^[a-z0-9.-]+\/[a-z0-9._-]+$/i.test(name) || !version || official?.status !== 'active') continue
    const id = `mcp:${name.toLowerCase()}`
    if (entries.has(id)) continue
    entries.set(id, {
      id, name: label(server?.title, 120) ?? name, kind: 'mcp', version,
      description: [name, label(server?.description, 320)].filter(Boolean).join(' · '),
      url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    })
  }
  return [...entries.values()]
}

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/

function dshReleaseUrl(name: string, source: unknown): string | undefined {
  const spec = object(source)
  if (spec?.type === 'npm' && (spec.registry === undefined || spec.registry === 'https://registry.npmjs.org/')) {
    return `https://www.npmjs.com/package/${name}`
  }
  if (spec?.type !== 'git' || typeof spec.url !== 'string' || typeof spec.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(spec.commit)) return
  const match = spec.url.match(/^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9._-]+?)(?:\.git)?\/?$/i)
  if (match) return `https://github.com/${match[1]}/tree/${spec.commit}`
}

function parseDshIndex(body: unknown): DiscoveredExtension[] {
  const index = object(body)
  if (index?.format !== 1 || !Array.isArray(index.plugins)) throw Error('Unsupported DSH index format')
  const entries = new Map<string, DiscoveredExtension>()
  for (const item of index.plugins) {
    const row = object(item)
    const name = label(row?.name, 214)
    if (!name || !packageName.test(name) || !Array.isArray(row?.versions)) continue
    let version: string | undefined
    let url: string | undefined
    let publishedAt = -Infinity
    for (const value of row.versions) {
      const release = object(value)
      const candidate = label(release?.version, 80)
      const timestamp = release?.publishTimestamp
      if (!candidate || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= publishedAt) continue
      version = candidate
      url = dshReleaseUrl(name, release?.source)
      publishedAt = timestamp
    }
    if (!version || entries.has(name)) continue
    entries.set(name, {
      id: `dsh:${name}`, kind: 'bundle', name: localized(row.title, 120) ?? name, version, url,
      description: [name, localized(row.description, 320)].filter(Boolean).join(' · '),
    })
  }
  return [...entries.values()]
}

function parseUnityRelease(body: unknown): DiscoveredExtension[] {
  const release = object(body)
  const version = label(release?.tag_name, 80)
  if (!version || release?.draft !== false || release.prerelease !== false) throw Error('Unexpected Unity MCP release metadata')
  return [{id: 'mcp:unity-mcp', kind: 'mcp', name: 'Unity MCP', version, catalogId: 'unity-mcp'}]
}

const sources: readonly SourceDefinition[] = [
  {id: 'homebrew', name: 'Homebrew Cask', url: 'https://formulae.brew.sh/cask/blender',
    endpoint: 'https://formulae.brew.sh/api/cask/blender.json', parse: parseBlenderCask},
  {id: 'mcp-registry', name: 'MCP Registry', url: 'https://modelcontextprotocol.io/registry/about',
    endpoint: 'https://registry.modelcontextprotocol.io/v0.1/servers?search=blender&version=latest&limit=20', parse: parseMcpRegistry},
  {id: 'dsh-community', name: 'Silentforfar DSH', url: 'https://github.com/Silentforfar/dsh-market-index',
    endpoint: 'https://silentforfar.github.io/dsh-market-index/index.json', parse: parseDshIndex},
  {id: 'unity-releases', name: 'CoplayDev Unity MCP', url: 'https://github.com/CoplayDev/unity-mcp/releases',
    endpoint: 'https://api.github.com/repos/CoplayDev/unity-mcp/releases/latest', parse: parseUnityRelease},
]

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw Error(`HTTP ${response.status}`)
  if (!response.body) throw Error('Empty response')
  const maxBytes = 4 * 1024 * 1024
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let json = ''
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw Error('Index exceeds 4 MiB')
      }
      json += decoder.decode(value, {stream: true})
    }
    return JSON.parse(json + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}

/** 仅访问登记的公开来源。发现结果只含元数据，安装动作始终由现有本地条目决定。 */
export async function discoverExtensions(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DiscoverySource[]> {
  return await Promise.all(sources.map(async ({id, name, url, endpoint, parse}) => {
    try {
      const response = await fetcher(endpoint, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        redirect: 'error',
        credentials: 'omit',
        headers: {accept: 'application/json', 'user-agent': 'Lyapunov-Extension-Discovery'},
      })
      const entries = parse(await readJson(response))
      return {id, name, url, checkedAt: Date.now(), entries}
    } catch (error) {
      return {id, name, url, checkedAt: Date.now(), entries: [], error: label(error instanceof Error ? error.message : error, 180) ?? 'Request failed'}
    }
  }))
}
