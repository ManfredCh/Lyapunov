/**
 * Creative software/model chooser and native MCP routing.
 *
 * `creative-tools-catalog.ts` owns creative-tool identity, URLs, revisions,
 * mirrors, files, gates, and local integration facts. This module owns the
 * reusable dispatch layer: it turns those facts into inert argv/process plans.
 * It never downloads, installs, starts MCP, calls inference, reads secrets, or
 * edits plugin files.
 */
import {
  CREATIVE_TOOLS_CATALOG,
  downloadPlan,
  type CreativeToolCatalogEntry,
  type CreativeToolId,
  type DownloadPlan,
} from './creative-tools-catalog.ts'
import { MCP_CLIENT_PLUGIN } from './unity-mcp.ts'
import {
  mcpCallPlan as catalogMcpCallPlan,
  type NativeMcpConfiguration,
} from './creative-tool-install-catalog.ts'
export type { NativeMcpConfiguration, NativeMcpToolBinding } from './creative-tool-install-catalog.ts'

/** Optional selection of catalogue IDs; facts always resolve against the shared catalog. */
export type CreativeCatalog = readonly CreativeToolCatalogEntry[]
export type DownloadSourcePreference = 'auto' | 'mirror' | 'official'
export type CreativeRequestAction = 'download' | 'install' | 'inference' | 'mcp-install' | 'mcp-configure' | 'mcp-call'

export interface CreativeProcessPlan {
  /** Shell-safe argv. The caller must use spawn(argv[0], argv.slice(1)), never a shell. */
  argv: readonly string[]
  env: Readonly<Record<string, string>>
  cwd?: string
  credentials?: DownloadPlan['credentials']
  requires?: readonly string[]
  label: string
  requiresConfirmation: true
  inert: true
  sideEffect: 'open-url' | 'download' | 'ensure-mcp' | 'validate-mcp'
}

export interface CreativeDownloadOption {
  id: CreativeToolId
  name: string
  catalogKind: 'software' | 'model'
  acquisition: 'software-installer' | 'hf-weights'
  planKind: DownloadPlan['kind']
  sourceUrl: string
  sourceRole: 'software-download' | 'model-weights' | 'source-code'
  /** A catalog-backed source choice; this is not a hosted inference endpoint. */
  sourceOptions: readonly ('official-page' | 'hf-mirror')[]
  downloadOptions: readonly DownloadPlan['kind'][]
  modelId?: string
  revision?: string
  mirrorUrl?: string
  gated?: boolean | 'manual'
  license?: string
}

export interface CreativeInstallOption extends CreativeDownloadOption {
  mcp: boolean
  mcpOwner?: string
}

export type CreativePlan =
  | {
      kind: 'software-installer'
      toolId: CreativeToolId
      process: CreativeProcessPlan
      notes: readonly string[]
    }
  | {
      kind: 'hf-weights'
      toolId: CreativeToolId
      process: CreativeProcessPlan
      source: 'hf-mirror'
      modelId: string
      revision: string
      gated: boolean | 'manual'
      notes: readonly string[]
    }
  | {
      kind: 'mcp-install-plan' | 'mcp-configure-plan'
      toolId: CreativeToolId
      owner: string
      process: CreativeProcessPlan
      notes: readonly string[]
    }
  | {
      kind: 'mcp-call-plan'
      toolId: CreativeToolId
      client: typeof MCP_CLIENT_PLUGIN
      serverName: string
      transport: string
      toolName: string
      arguments: Readonly<Record<string, unknown>>
      nativeConfiguration: NativeMcpConfiguration
      live: false
      background: boolean
      jobAction: 'direct-native-call' | 'start-native-job'
      qualifiedTool: string
      notes: readonly string[]
    }
  | {
      kind: 'native-job-proposal'
      toolId?: CreativeToolId
      commands: readonly CreativeProcessPlan[]
      taskActions: readonly string[]
      notes: readonly string[]
    }

export type CreativePlanFailureReason =
  | 'CREATIVE_TOOL_NOT_FOUND'
  | 'CREATIVE_TOOL_NOT_DOWNLOADABLE'
  | 'SOURCE_NOT_CATALOGUED'
  | 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL'
  | 'INFERENCE_ENDPOINT_NOT_CATALOGUED'
  | 'MCP_UNSUPPORTED'
  | 'MCP_INSTALLER_UNAVAILABLE'
  | 'REQUEST_NEGATED'
  | 'MCP_CONFIGURATION_OWNER_MISSING'
  | 'MCP_CONFIGURATION_MISSING'
  | 'MCP_CONFIGURATION_INVALID'
  | 'MCP_TOOL_NAME_MISSING'
  | 'MCP_TOOL_SERVER_MISMATCH'
  | 'MCP_TOOL_NOT_DISCOVERED'

export interface CreativePlanFailure {
  kind: 'blocked'
  toolId?: CreativeToolId
  action?: CreativeRequestAction
  reason: CreativePlanFailureReason
  notes: readonly string[]
}

export type CreativePlanResult = CreativePlan | CreativePlanFailure

export interface CreativeChoiceResult {
  kind: 'choose'
  reason: 'TOOL_REQUIRED' | 'ACTION_REQUIRED' | 'SOURCE_REQUIRED'
  options: readonly CreativeDownloadOption[]
}

export interface CreativeRequest {
  text: string
  catalog?: CreativeCatalog
  source?: DownloadSourcePreference
  localDir?: string
  allowGated?: boolean
  /** Kept for API clarity; catalogued paid inference is always absent/blocked. */
  allowPaidInference?: boolean
  nativeConfiguration?: NativeMcpConfiguration
  toolName?: string
  arguments?: Readonly<Record<string, unknown>>
  background?: boolean
  bunCommand?: string
  cwd?: string
}

export interface McpInstallOptions {
  bunCommand?: string
  cwd?: string
  offline?: boolean
  /** Unity has a validator, not an installer; select this mode explicitly. */
  mode?: 'install' | 'configure'
}

export interface McpCallRequest {
  toolId: CreativeToolId
  toolName: string
  arguments?: Readonly<Record<string, unknown>>
  nativeConfiguration?: NativeMcpConfiguration
  background?: boolean
}

export interface ProcessExecutionResult {
  exitCode: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
}

export type ProcessExecutor = (plan: CreativeProcessPlan) => Promise<ProcessExecutionResult> | ProcessExecutionResult

const DEFAULT_MODEL_ROOT = '.runtime/creative-tools'
const DOWNLOAD_WORDS = /(?:\b(?:download|fetch|pull)\b|下载|拉取|取回)/iu
const INSTALL_WORDS = /(?:\b(?:install|setup|set\s+up)\b|安装|装软件)/iu
const MCP_WORDS = /(?:\bmcp\b|原生工具)/iu
const MCP_CONFIG_WORDS = /(?:\b(?:configure|connect)\b|配置|连接|接入)/iu
const ENDPOINT_WORDS = /(?:\b(?:endpoint|inference|api|remote|hosted)\b|推理|接口)/iu
const CALL_WORDS = /(?:\b(?:call|invoke|run|use)\b|调用|执行|使用)/iu
const MIRROR_WORDS = /(?:\b(?:mirror|hf-mirror)\b|镜像)/iu
const OFFICIAL_WORDS = /(?:\b(?:official|huggingface\.co)\b|官方|官网)/iu
const NEGATED_ACTION = /(?:\b(?:do\s+not|don['’]t|never|without|not)\b[^.!?;，。！？；\n]*\b(?:download|fetch|pull|install|setup|configure|connect|call|invoke|run|use)\b|(?:不要|不需要|不用|禁止|别|取消)[^.!?;，。！？；\n]*(?:下载|拉取|取回|安装|配置|连接|接入|调用|执行|使用))/iu

function entriesOf(catalog?: CreativeCatalog): CreativeCatalog {
  if (catalog === undefined) return CREATIVE_TOOLS_CATALOG
  const allowed = new Set(catalog.map(entry => entry.id))
  return CREATIVE_TOOLS_CATALOG.filter(entry => allowed.has(entry.id))
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-./]+/gu, '')
}

function entryLabels(entry: CreativeToolCatalogEntry): readonly string[] {
  const aliases: Record<string, readonly string[]> = {
    sam3: ['sam 3', 'sam3'],
    sam3d: ['sam 3d', 'sam3d', 'sam 3d objects'],
    da3: ['da3', 'depth anything 3'],
  }
  return [entry.id, entry.name, ...(aliases[entry.id] ?? [])]
}

function matchesEntry(entry: CreativeToolCatalogEntry, text: string): boolean {
  return entryLabels(entry).some(label => {
    const term = normalize(label)
    if (term.length < 2) return false
    const escaped = [...term].map(char => char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    const pattern = escaped.join('[\\s_./-]*')
    // SAM3 is distinct from SAM3D, but a request may explicitly name both.
    const suffix = entry.id === 'sam3' ? '(?![\\s_-]*d\\b)' : ''
    return new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])${suffix}`, 'iu').test(text)
  })
}

function findEntry(catalog: CreativeCatalog, id: string): CreativeToolCatalogEntry | undefined {
  const wanted = normalize(id)
  return catalog.find(entry => entryLabels(entry).some(label => normalize(label) === wanted))
}

function gated(model: NonNullable<CreativeToolCatalogEntry['model']>): boolean | 'manual' {
  return model.gated
}

function isGated(model: NonNullable<CreativeToolCatalogEntry['model']>): boolean {
  return model.gated === true || model.gated === 'manual'
}

function optionFor(entry: CreativeToolCatalogEntry): CreativeDownloadOption {
  if (entry.model) {
    return {
      id: entry.id, name: entry.name, catalogKind: entry.kind, acquisition: 'hf-weights', planKind: 'hf-download',
      sourceUrl: entry.model.sourceUrl, sourceRole: 'model-weights', sourceOptions: ['hf-mirror'], downloadOptions: entry.downloadOptions,
      modelId: entry.model.modelId, revision: entry.model.revision, mirrorUrl: entry.model.mirrorUrl, gated: gated(entry.model), license: entry.model.license,
    }
  }
  return {
    id: entry.id, name: entry.name, catalogKind: entry.kind, acquisition: 'software-installer', planKind: 'open-url',
    sourceUrl: entry.source.url, sourceRole: entry.source.role, sourceOptions: ['official-page'], downloadOptions: entry.downloadOptions,
  }
}

function processPlan(input: Omit<CreativeProcessPlan, 'requiresConfirmation' | 'inert'>): CreativeProcessPlan {
  return { ...input, requiresConfirmation: true, inert: true }
}

function asProcess(plan: DownloadPlan, label: string, sideEffect: 'open-url' | 'download', cwd?: string): CreativeProcessPlan {
  return processPlan({ argv: [...plan.argv], env: { ...plan.env }, credentials: plan.credentials, requires: [...plan.requires], ...(cwd === undefined ? {} : { cwd }), label, sideEffect })
}

function blocked(reason: CreativePlanFailureReason, notes: readonly string[], toolId?: CreativeToolId, action?: CreativeRequestAction): CreativePlanFailure {
  return { kind: 'blocked', ...(toolId === undefined ? {} : { toolId }), ...(action === undefined ? {} : { action }), reason, notes }
}

/** Closed-set catalog matching; it never creates a URL/model/endpoint from user text. */
export function creativeToolMatches(text: string, catalog: CreativeCatalog = CREATIVE_TOOLS_CATALOG): CreativeToolCatalogEntry[] {
  return entriesOf(catalog).filter(entry => matchesEntry(entry, text))
}

/** Software installer pages and local HF weight acquisition choices. */
export function creativeDownloadOptions(catalog: CreativeCatalog = CREATIVE_TOOLS_CATALOG, query = ''): CreativeDownloadOption[] {
  const entries = query.trim() ? creativeToolMatches(query, catalog) : entriesOf(catalog)
  return entries.filter(entry => entry.downloadOptions.length > 0).map(optionFor)
}

/** Adds upstream MCP choices to the acquisition list without claiming a live connection. */
export function creativeInstallOptions(catalog: CreativeCatalog = CREATIVE_TOOLS_CATALOG, query = ''): CreativeInstallOption[] {
  const entries = query.trim() ? creativeToolMatches(query, catalog) : entriesOf(catalog)
  return entries.filter(entry => entry.downloadOptions.length > 0 || entry.localIntegration?.mcp?.supported).map(entry => ({
    ...optionFor(entry), mcp: entry.localIntegration?.mcp?.supported === true,
    ...(entry.localIntegration?.mcp?.configSource ? { mcpOwner: entry.localIntegration.mcp.configSource } : {}),
  }))
}

function entryFor(id: string, catalog: CreativeCatalog): CreativeToolCatalogEntry | CreativePlanFailure {
  const entry = findEntry(catalog, id)
  return entry ?? blocked('CREATIVE_TOOL_NOT_FOUND', ['The request must name a catalogued creative tool; no source was invented.'])
}

/** Build the catalogued software-page plan. Opening the page is the only software action here. */
export function buildSoftwarePlan(args: { toolId: CreativeToolId; catalog?: CreativeCatalog; source?: DownloadSourcePreference; cwd?: string }): CreativePlanResult {
  const catalog = entriesOf(args.catalog)
  const entry = entryFor(args.toolId, catalog)
  if ('kind' in entry && entry.kind === 'blocked') return entry
  if (args.source === 'mirror') return blocked('SOURCE_NOT_CATALOGUED', ['Software entries expose the catalogued official download page only; no alternate installer mirror is claimed.'], entry.id, 'install')
  if (entry.kind !== 'software' || !entry.downloadOptions.includes('open-url')) return blocked('CREATIVE_TOOL_NOT_DOWNLOADABLE', ['This catalog entry has no software page plan.'], entry.id, 'install')
  const plan = downloadPlan(entry.id)
  return {
    kind: 'software-installer', toolId: entry.id, process: asProcess(plan, `Open the official ${entry.name} download page`, 'open-url', args.cwd),
    notes: ['This opens the official page and does not silently install software.', 'Review and install Blender/Unity manually; the MCP package is a separate concern.', 'The software page is not an inference endpoint.'],
  }
}

/** Build a gated/ungated HF weights plan using only the catalogued HF mirror. */
export function buildWeightsPlan(args: { toolId: CreativeToolId; catalog?: CreativeCatalog; source?: DownloadSourcePreference; localDir?: string; allowGated?: boolean }): CreativePlanResult {
  const catalog = entriesOf(args.catalog)
  const entry = entryFor(args.toolId, catalog)
  if ('kind' in entry && entry.kind === 'blocked') return entry
  if (entry.kind !== 'model' || !entry.model || !entry.downloadOptions.includes('hf-download')) return blocked('CREATIVE_TOOL_NOT_DOWNLOADABLE', ['No catalogued HF weight plan exists for this tool.'], entry.id, 'download')
  if (args.source === 'official') return blocked('SOURCE_NOT_CATALOGUED', ['The official Hub URL is provenance; the catalog permits the configured HF mirror as a download endpoint.'], entry.id, 'download')
  if (isGated(entry.model) && args.allowGated !== true) return blocked('GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL', ['This model is catalog-marked gated/manual. Obtain user access approval before preparing its large weight download.'], entry.id, 'download')
  const localDir = args.localDir ?? `${DEFAULT_MODEL_ROOT}/${entry.id}`
  const plan = downloadPlan(entry.id, { endpoint: entry.model.mirrorUrl, localDir })
  if (plan.kind !== 'hf-download') return blocked('CREATIVE_TOOL_NOT_DOWNLOADABLE', ['Catalog returned a non-HF plan for a model entry.'], entry.id, 'download')
  return {
    kind: 'hf-weights', toolId: entry.id, process: asProcess(plan, `Download ${entry.name} weights`, 'download'), source: 'hf-mirror', modelId: entry.model.modelId, revision: entry.model.revision, gated: entry.model.gated,
    notes: [...plan.notes, 'This acquires local weights only; it does not install an SDK, make a package DA3-compatible, or expose an inference endpoint.'],
  }
}

/** The catalog has no hosted inference endpoints; never reinterpret HF/source URLs as one. */
export function buildEndpointPlan(args: { toolId: string; catalog?: CreativeCatalog }): CreativePlanFailure {
  const catalog = entriesOf(args.catalog)
  const entry = findEntry(catalog, args.toolId)
  return blocked('INFERENCE_ENDPOINT_NOT_CATALOGUED', [entry ? `${entry.name} is catalogued for software or local weights only.` : 'The requested tool is not catalogued.', 'No paid or external inference request was made; source URLs and HF mirrors are not endpoints.'], entry?.id, 'inference')
}

/** Route MCP provisioning to the existing owner, without installing Blender/Unity or creating a client. */
export function mcpInstallPlan(toolId: CreativeToolId, options: McpInstallOptions = {}, catalog: CreativeCatalog = CREATIVE_TOOLS_CATALOG): CreativePlanResult {
  const entry = findEntry(entriesOf(catalog), toolId)
  if (!entry) return blocked('CREATIVE_TOOL_NOT_FOUND', ['The MCP request must name a catalogued tool.'])
  const mcp = entry.localIntegration?.mcp
  if (!mcp?.supported) return blocked('MCP_UNSUPPORTED', ['The catalog entry does not advertise upstream MCP support; no replacement server was created.'], entry.id, 'mcp-install')
  if (!mcp.configSource || mcp.configSource === 'none') return blocked('MCP_CONFIGURATION_OWNER_MISSING', ['The catalog has no existing MCP configuration owner.'], entry.id, 'mcp-install')
  if (entry.id === 'unity' && options.mode !== 'configure') return blocked('MCP_INSTALLER_UNAVAILABLE', [`${mcp.configSource} validates explicit configuration only; it does not install or start Unity MCP.`, 'Configure an existing user-owned server through the native MCP owner instead.'], entry.id, 'mcp-install')
  if (options.mode === 'configure' && entry.id !== 'unity') return nativeJobProposal(entry.id)
  const argv = [options.bunCommand ?? 'bun', 'run', mcp.configSource]
  if (options.offline && mcp.configSource === 'script/blender-mcp.ts') argv.push('--offline')
  const sideEffect = mcp.configSource === 'script/blender-mcp.ts' ? 'ensure-mcp' : 'validate-mcp'
  return {
    kind: options.mode === 'configure' ? 'mcp-configure-plan' : 'mcp-install-plan', toolId: entry.id, owner: mcp.configSource,
    process: processPlan({ argv, env: {}, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), label: `Route ${entry.name} MCP through ${mcp.configSource}`, sideEffect }),
    notes: [`Uses the existing native/upstream MCP owner ${mcp.configSource}.`, mcp.configSource === 'script/blender-mcp.ts' ? 'This ensures the pinned upstream Blender MCP package/addon; it does not install Blender.' : 'Unity configuration is explicit and user-owned; this validates wiring but does not install or start Unity.', 'Use the host MCP client and list_mcp_servers for live connection/capability truth.'],
  }
}

/** Extend the catalog adapter's native-discovery-validated call descriptor with Jobs routing. */
export function mcpCallPlan(request: McpCallRequest, catalog: CreativeCatalog = CREATIVE_TOOLS_CATALOG): CreativePlanResult {
  const entry = findEntry(entriesOf(catalog), request.toolId)
  if (!entry) return blocked('CREATIVE_TOOL_NOT_FOUND', ['The MCP request must name a catalogued tool.'])
  const planned = catalogMcpCallPlan({ ...request, toolId: entry.id })
  if (planned.kind === 'blocked') return blocked(planned.reason, planned.notes, entry.id, 'mcp-call')
  const background = request.background === true
  return {
    ...planned, toolId: entry.id, background,
    jobAction: background ? 'start-native-job' : 'direct-native-call',
    notes: [...planned.notes, background ? 'Proposal: wrap the existing native MCP call in ctx.jobs.start; do not create a second registry.' : 'Use the current native tool binding; no call is executed here.'],
  }
}

/** Explicit native Jobs/plugin proposal for hosts that need a plugin integration. */
export function nativeJobProposal(toolId?: CreativeToolId): CreativePlan {
  return {
    kind: 'native-job-proposal', ...(toolId === undefined ? {} : { toolId }), commands: [],
    taskActions: [
      'Propose a plan/review command through ctx.commands.register, using the same operation as an optional ctx.tools.register action.',
      'After host approval, wrap a confirmed argv executor or an existing native MCP call in ctx.jobs.start with owner, cancel, and done hooks.',
      'Use native job_output/job_kill and revalidate MCP raw/public tool bindings at dispatch; do not create another registry or MCP client.',
    ],
    notes: ['Proposal only: no plugin.ts edit, process, download, or live tool call was performed.'],
  }
}

export const buildMcpInstallPlan = mcpInstallPlan
export const buildMcpCallPlan = mcpCallPlan

function actionFor(text: string): CreativeRequestAction | 'none' {
  if (NEGATED_ACTION.test(text)) return 'none'
  if (MCP_WORDS.test(text) && INSTALL_WORDS.test(text)) return 'mcp-install'
  if (MCP_WORDS.test(text) && MCP_CONFIG_WORDS.test(text)) return 'mcp-configure'
  if (MCP_WORDS.test(text) && CALL_WORDS.test(text)) return 'mcp-call'
  if (ENDPOINT_WORDS.test(text) && CALL_WORDS.test(text)) return 'inference'
  if (INSTALL_WORDS.test(text)) return 'install'
  if (DOWNLOAD_WORDS.test(text)) return 'download'
  return 'none'
}

function mcpCandidates(entries: CreativeCatalog): CreativeDownloadOption[] {
  return entries.filter(entry => entry.localIntegration?.mcp?.supported).map(optionFor)
}

/** Natural-language chooser. Ambiguity returns options; it never guesses a source or endpoint. */
export function planCreativeRequest(request: CreativeRequest): CreativePlanResult | CreativeChoiceResult {
  const catalog = entriesOf(request.catalog)
  const entries = creativeToolMatches(request.text, catalog)
  if (NEGATED_ACTION.test(request.text)) return blocked('REQUEST_NEGATED', ['No action plan is emitted for a negated request; ask for an unambiguous positive action.'], entries.length === 1 ? entries[0]!.id : undefined)
  const action = /[?？]/u.test(request.text) ? 'none' : actionFor(request.text)
  const isMcp = action === 'mcp-install' || action === 'mcp-configure' || action === 'mcp-call'
  if (!entries.length) {
    if (action === 'download' || action === 'install') return { kind: 'choose', reason: 'TOOL_REQUIRED', options: creativeDownloadOptions(catalog) }
    if (isMcp) return { kind: 'choose', reason: 'TOOL_REQUIRED', options: mcpCandidates(catalog) }
    return blocked('CREATIVE_TOOL_NOT_FOUND', ['Request did not match a catalog entry; no URL, repository, endpoint, or tool was invented.'])
  }
  if (entries.length > 1) return { kind: 'choose', reason: 'TOOL_REQUIRED', options: isMcp ? mcpCandidates(entries) : entries.map(optionFor) }
  const entry = entries[0]!
  if (action === 'none') return { kind: 'choose', reason: 'ACTION_REQUIRED', options: [optionFor(entry)] }
  if (action === 'inference') return buildEndpointPlan({ toolId: entry.id, catalog })
  if (action === 'mcp-install' || action === 'mcp-configure') return mcpInstallPlan(entry.id, { bunCommand: request.bunCommand, cwd: request.cwd, mode: action === 'mcp-configure' ? 'configure' : 'install' }, catalog)
  if (action === 'mcp-call') {
    const toolName = request.toolName ?? /(?:\btool\b|工具)\s*[:=]?\s*([A-Za-z0-9_.:-]+)/iu.exec(request.text)?.[1] ?? ''
    return mcpCallPlan({ toolId: entry.id, toolName, arguments: request.arguments, nativeConfiguration: request.nativeConfiguration, background: request.background }, catalog)
  }
  // Merely mentioning MCP/hosted inference is never permission to download software/weights instead.
  if (MCP_WORDS.test(request.text) || ENDPOINT_WORDS.test(request.text)) return { kind: 'choose', reason: 'ACTION_REQUIRED', options: [optionFor(entry)] }
  const mirror = MIRROR_WORDS.test(request.text), official = OFFICIAL_WORDS.test(request.text)
  if ((!request.source || request.source === 'auto') && mirror && official) return { kind: 'choose', reason: 'SOURCE_REQUIRED', options: [optionFor(entry)] }
  const source = request.source && request.source !== 'auto' ? request.source : mirror ? 'mirror' : official ? 'official' : 'auto'
  if (entry.kind === 'software') return buildSoftwarePlan({ toolId: entry.id, catalog, source, cwd: request.cwd })
  return buildWeightsPlan({ toolId: entry.id, catalog, source, localDir: request.localDir, allowGated: request.allowGated })
}

/** Execute only a reviewed process plan through a caller-provided executor. */
export async function executeProcessPlan(plan: CreativeProcessPlan, execute: ProcessExecutor, options: { confirmed?: boolean } = {}): Promise<ProcessExecutionResult> {
  if (!plan.inert || plan.requiresConfirmation !== true || options.confirmed !== true) throw new Error('CREATIVE_PLAN_CONFIRMATION_REQUIRED')
  if (!Array.isArray(plan.argv) || plan.argv.length === 0 || plan.argv.some(token => typeof token !== 'string')) throw new Error('CREATIVE_PROCESS_PLAN_INVALID')
  return await execute({ ...plan, argv: [...plan.argv], env: { ...plan.env } })
}

export const executeCreativeProcess = executeProcessPlan

export function formatCreativePlan(plan: CreativePlan | CreativePlanFailure): string {
  if (plan.kind === 'blocked') return `${plan.reason}: ${plan.notes.join(' ')}`
  if (plan.kind === 'native-job-proposal') return `${plan.kind}: native plugin integration required`
  if (plan.kind === 'software-installer') return `${plan.kind}: argv=${JSON.stringify(plan.process.argv)}; manual install only`
  if (plan.kind === 'hf-weights') return `${plan.kind}: argv=${JSON.stringify(plan.process.argv)}; source=${plan.source}`
  if (plan.kind === 'mcp-call-plan') return `${plan.kind}: ${plan.qualifiedTool} (${plan.jobAction})`
  return `${plan.kind}: ${plan.owner}`
}

if (import.meta.main) {
  console.error('creative-tool-install.ts is a library. Import a catalog and call planCreativeRequest(); no implicit download or install is performed.')
  process.exitCode = 2
}
