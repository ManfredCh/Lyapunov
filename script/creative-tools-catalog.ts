/**
 * Reusable catalog for creative software and model-weight acquisition.
 *
 * This module is deliberately independent of the shell/plugin and installer layers. It
 * describes where a tool comes from and produces argv/env plans that those layers can
 * execute later. A source URL is provenance only; it is never a running inference
 * endpoint. Model entries identify Hub sources separately from local adapters;
 * adapter presence is not proof of compatible weights or runtime readiness.
 */

export type CreativeToolId = 'blender' | 'unity' | 'sam3' | 'sam3d' | 'da3'
export type CreativeToolKind = 'software' | 'model'
export type DownloadPlanKind = 'open-url' | 'hf-download'
export type HfEndpointChoice = 'default-mirror' | 'configured-mirror'

export interface OfficialSource {
  kind: 'official-software' | 'official-repository' | 'community-repository' | 'huggingface-model'
  url: string
  /** A URL is documentation/provenance; it is not an inference endpoint. */
  role: 'software-download' | 'source-code' | 'model-weights'
}

export interface HfModelSource {
  provider: 'huggingface'
  modelId: string
  revision: string
  /** Public Hub metadata observed with `hf models info`; no weight bytes are bundled. */
  gated: boolean | 'manual'
  license: string
  /** Snapshot of Hub `used_storage`, not a selected-file download size. */
  usedStorageBytes?: number
  sourceUrl: string
  mirrorUrl: string
  /** Explicit repository paths passed to `hf download`; include model bytes when acquisition is requested. */
  files: readonly string[]
  /** Public metadata visibility; this does not imply anonymous access to the files. */
  publicMetadata: boolean
}

export interface DownloadPlan {
  kind: DownloadPlanKind
  /** Shell-safe command: each token is an argv element, never a shell command string. */
  argv: readonly string[]
  env: Readonly<Record<string, string>>
  cwd?: string
  /** Credentials are deliberately not represented in this plan. */
  credentials: 'none' | 'hf-token-to-configured-mirror-only'
  requires: readonly string[]
  notes: readonly string[]
}

export interface CreativeToolCatalogEntry {
  id: CreativeToolId
  kind: CreativeToolKind
  name: string
  description: string
  source: OfficialSource
  sources: readonly OfficialSource[]
  /** An adapter in the checkout, not a probe of installed software or runtime readiness. */
  localIntegration?: {
    packagePath: string
    status: 'adapter-present' | 'different-model'
    inferenceMode: 'local-weights-only' | 'software-process' | 'mcp'
    mcp?: {
      supported: boolean
      transport: readonly ('stdio' | 'streamable-http' | 'sse')[]
      configSource: string
    }
  }
  model?: HfModelSource
  downloadOptions: readonly DownloadPlanKind[]
  installNotes: readonly string[]
}

export const HF_DEFAULT_MIRROR = 'https://hf-mirror.com'
const OFFICIAL_HF_HOST = 'huggingface.co'
const MIRROR_HOST = 'hf-mirror.com'

const isOfficialHfHost = (hostname: string) => hostname === OFFICIAL_HF_HOST || hostname.endsWith(`.${OFFICIAL_HF_HOST}`)

/**
 * Validate the only endpoint choices supported by this catalog. Official Hub URLs
 * remain useful as model provenance, but cannot be selected as a download endpoint.
 */
export function validateHfEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('CREATIVE_HF_ENDPOINT_INVALID') }
  if (url.protocol !== 'https:') throw new Error('CREATIVE_HF_ENDPOINT_HTTPS_REQUIRED')
  if (isOfficialHfHost(url.hostname)) throw new Error('CREATIVE_HF_ENDPOINT_OFFICIAL_FORBIDDEN')
  if (url.hostname !== MIRROR_HOST) throw new Error('CREATIVE_HF_ENDPOINT_MIRROR_FORBIDDEN')
  if (url.username || url.password || url.search || url.hash) throw new Error('CREATIVE_HF_ENDPOINT_CREDENTIALS_FORBIDDEN')
  if (url.port || url.pathname !== '/') throw new Error('CREATIVE_HF_ENDPOINT_ORIGIN_REQUIRED')
  return url.origin
}

function hfPlan(model: HfModelSource, endpoint: string, localDir: string | undefined): DownloadPlan {
  const resolved = validateHfEndpoint(endpoint)
  if (typeof localDir !== 'string' || !localDir.trim() || localDir === '<MODEL_DIR>') {
    throw new Error('CREATIVE_MODEL_DIRECTORY_REQUIRED')
  }
  if (localDir.startsWith('-') || /[\x00-\x1f\x7f]/.test(localDir)) {
    throw new Error('CREATIVE_MODEL_DIRECTORY_INVALID')
  }
  const argv = ['hf', 'download', model.modelId, '--revision', model.revision]
  for (const file of model.files) argv.push(file)
  argv.push('--local-dir', localDir)
  return {
    kind: 'hf-download',
    argv,
    env: { HF_ENDPOINT: resolved, HF_HUB_DISABLE_TELEMETRY: '1' },
    credentials: model.gated ? 'hf-token-to-configured-mirror-only' : 'none',
    requires: ['hf CLI (hf)'],
    notes: [
      'Run as argv, not through a shell; localDir is supplied by the caller.',
      'Do not place HF_TOKEN in argv, URLs, logs, manifests, or arbitrary mirror requests.',
      model.gated ? 'This repository is gated/manual: the user must obtain access before downloading.' : 'Hub metadata reports this repository as ungated.',
      'A downloaded checkpoint is local input to a package; it is not an inference endpoint.',
    ],
  }
}

function openUrlPlan(url: string, note: string): DownloadPlan {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('CREATIVE_SOURCE_HTTPS_REQUIRED')
  const opener = process.platform === 'darwin'
    ? ['open', parsed.href]
    : process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', parsed.href]
      : ['xdg-open', parsed.href]
  return {
    kind: 'open-url',
    argv: opener,
    env: {},
    credentials: 'none',
    requires: ['a browser or OS URL handler'],
    notes: [note, 'This opens the official source page; it does not silently download or install software.'],
  }
}

const SAM3_MODEL: HfModelSource = {
  provider: 'huggingface', modelId: 'facebook/sam3',
  revision: '3c879f39826c281e95690f02c7821c4de09afae7', gated: 'manual', license: 'other',
  usedStorageBytes: 10_329_938_097, sourceUrl: 'https://huggingface.co/facebook/sam3', mirrorUrl: HF_DEFAULT_MIRROR,
  // The existing segment-sam3 SDK consumes sam3.pt, not the separate Transformers weights.
  files: ['sam3.pt'], publicMetadata: true,
}

const SAM3D_MODEL: HfModelSource = {
  provider: 'huggingface', modelId: 'facebook/sam-3d-objects',
  revision: '2e73555018d2741ccd486e56c24fac41155a1dc6', gated: 'manual', license: 'other',
  usedStorageBytes: 13_338_859_690, sourceUrl: 'https://huggingface.co/facebook/sam-3d-objects', mirrorUrl: HF_DEFAULT_MIRROR,
  // The plan is explicit so the installer can acquire the actual checkpoint set; no bytes are bundled here.
  files: [
    'checkpoints/pipeline.yaml',
    'checkpoints/slat_decoder_gs.ckpt', 'checkpoints/slat_decoder_gs.yaml',
    'checkpoints/slat_decoder_gs_4.ckpt', 'checkpoints/slat_decoder_gs_4.yaml',
    'checkpoints/slat_decoder_mesh.ckpt', 'checkpoints/slat_decoder_mesh.pt', 'checkpoints/slat_decoder_mesh.yaml',
    'checkpoints/slat_encoder.ckpt', 'checkpoints/slat_encoder.yaml',
    'checkpoints/slat_generator.ckpt', 'checkpoints/slat_generator.yaml',
    'checkpoints/ss_decoder.ckpt', 'checkpoints/ss_decoder.yaml',
    'checkpoints/ss_encoder.ckpt', 'checkpoints/ss_encoder.safetensors', 'checkpoints/ss_encoder.yaml',
    'checkpoints/ss_generator.ckpt', 'checkpoints/ss_generator.yaml',
  ], publicMetadata: true,
}

const DA3_BASE_MODEL: HfModelSource = {
  provider: 'huggingface', modelId: 'depth-anything/DA3-BASE',
  revision: 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e', gated: false, license: 'apache-2.0',
  usedStorageBytes: 541_518_028, sourceUrl: 'https://huggingface.co/depth-anything/DA3-BASE', mirrorUrl: HF_DEFAULT_MIRROR,
  files: ['config.json', 'model.safetensors'], publicMetadata: true,
}

export const CREATIVE_TOOLS_CATALOG: readonly CreativeToolCatalogEntry[] = [
  {
    id: 'blender', kind: 'software', name: 'Blender',
    description: 'Official Blender desktop software and scripting runtime.',
    source: { kind: 'official-software', url: 'https://www.blender.org/download/', role: 'software-download' },
    sources: [
      { kind: 'official-software', url: 'https://www.blender.org/download/', role: 'software-download' },
      { kind: 'official-repository', url: 'https://projects.blender.org/blender/blender', role: 'source-code' },
    ],
    localIntegration: { packagePath: 'packages/blender', status: 'adapter-present', inferenceMode: 'software-process', mcp: { supported: true, transport: ['stdio'], configSource: 'script/blender-mcp.ts' } },
    downloadOptions: ['open-url'],
    installNotes: ['Use the official download page for platform-specific installers.', 'Blender MCP is a separate upstream package/addon and is not the Blender application itself.'],
  },
  {
    id: 'unity', kind: 'software', name: 'Unity',
    description: 'Official Unity editor and Hub download page.',
    source: { kind: 'official-software', url: 'https://unity.com/download', role: 'software-download' },
    sources: [
      { kind: 'official-software', url: 'https://unity.com/download', role: 'software-download' },
      { kind: 'community-repository', url: 'https://github.com/CoplayDev/unity-mcp', role: 'source-code' },
    ],
    localIntegration: { packagePath: 'script/unity-mcp.ts', status: 'adapter-present', inferenceMode: 'mcp', mcp: { supported: true, transport: ['stdio', 'streamable-http', 'sse'], configSource: 'script/unity-mcp.ts' } },
    downloadOptions: ['open-url'],
    installNotes: ['Install the editor with Unity Hub or the official platform installer.', 'Unity MCP connection settings are explicit configuration; this catalog does not claim that Unity is running.'],
  },
  {
    id: 'sam3', kind: 'model', name: 'SAM 3',
    description: 'Meta SAM 3 segmentation weights; local checkpoint acquisition only.',
    source: { kind: 'huggingface-model', url: SAM3_MODEL.sourceUrl, role: 'model-weights' },
    sources: [
      { kind: 'huggingface-model', url: SAM3_MODEL.sourceUrl, role: 'model-weights' },
      { kind: 'official-repository', url: 'https://github.com/facebookresearch/sam3', role: 'source-code' },
    ],
    localIntegration: { packagePath: 'packages/segment-sam3', status: 'adapter-present', inferenceMode: 'local-weights-only', mcp: { supported: false, transport: [], configSource: 'none' } },
    model: SAM3_MODEL, downloadOptions: ['hf-download'],
    installNotes: ['HF metadata marks the repository gated/manual and license as other; access and license acceptance are prerequisites.', 'Existing segment-sam3 runs offline from a local checkpoint and does not expose a hosted inference endpoint.', 'This source URL is a Hub repository, not a hosted inference endpoint.'],
  },
  {
    id: 'sam3d', kind: 'model', name: 'SAM 3D Objects',
    description: 'Meta SAM 3D Objects weights; local checkpoint acquisition only.',
    source: { kind: 'huggingface-model', url: SAM3D_MODEL.sourceUrl, role: 'model-weights' },
    sources: [
      { kind: 'huggingface-model', url: SAM3D_MODEL.sourceUrl, role: 'model-weights' },
      { kind: 'official-repository', url: 'https://github.com/facebookresearch/sam-3d-objects', role: 'source-code' },
    ],
    model: SAM3D_MODEL, downloadOptions: ['hf-download'],
    installNotes: ['HF metadata marks the repository gated/manual and license as other; do not claim access or a license beyond those facts.', 'This source URL is a Hub repository, not a hosted inference endpoint.'],
  },
  {
    id: 'da3', kind: 'model', name: 'Depth Anything 3 BASE',
    description: 'Depth Anything 3 BASE weights for local depth/geometry pipelines.',
    source: { kind: 'huggingface-model', url: DA3_BASE_MODEL.sourceUrl, role: 'model-weights' },
    sources: [
      { kind: 'huggingface-model', url: DA3_BASE_MODEL.sourceUrl, role: 'model-weights' },
      { kind: 'official-repository', url: 'https://github.com/ByteDance-Seed/Depth-Anything-3', role: 'source-code' },
    ],
    localIntegration: { packagePath: 'packages/depth-estimation', status: 'different-model', inferenceMode: 'local-weights-only', mcp: { supported: false, transport: [], configSource: 'none' } },
    model: DA3_BASE_MODEL, downloadOptions: ['hf-download'],
    installNotes: ['HF metadata reports ungated apache-2.0 for this BASE repository.', 'Existing depth-estimation package currently consumes Depth-Anything-V2 Small; downloading DA3 does not automatically make that package DA3-compatible.', 'This source URL is a Hub repository, not a hosted inference endpoint.'],
  },
] as const

export function getCreativeTool(id: CreativeToolId): CreativeToolCatalogEntry {
  const entry = CREATIVE_TOOLS_CATALOG.find(item => item.id === id)
  if (!entry) throw new Error(`CREATIVE_TOOL_NOT_FOUND: ${id}`)
  return entry
}

export function downloadPlan(id: CreativeToolId, options: { endpoint?: string; localDir?: string } = {}): DownloadPlan {
  const entry = getCreativeTool(id)
  if (entry.model) return hfPlan(entry.model, options.endpoint ?? process.env.HF_ENDPOINT ?? HF_DEFAULT_MIRROR, options.localDir)
  return openUrlPlan(entry.source.url, `Install ${entry.name} from its official software page.`)
}

/** Public, redacted summary suitable for discovery/UI; no token or arbitrary endpoint is returned. */
export function catalogSummary() {
  return CREATIVE_TOOLS_CATALOG.map(entry => ({
    id: entry.id, kind: entry.kind, name: entry.name, sourceUrl: entry.source.url,
    modelId: entry.model?.modelId, revision: entry.model?.revision, gated: entry.model?.gated,
    license: entry.model?.license, usedStorageBytes: entry.model?.usedStorageBytes,
    downloadOptions: entry.downloadOptions,
  }))
}
