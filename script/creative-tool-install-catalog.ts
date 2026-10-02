/**
 * Catalog-backed creative-tool acquisition and native MCP planning.
 *
 * This adapter owns no tool/model facts. All IDs, URLs, revisions, files, gates,
 * and MCP configuration owners come from creative-tools-catalog.ts. Plans are
 * inert data until a caller explicitly executes one through an injected runner.
 */
import {
  CREATIVE_TOOLS_CATALOG,
  downloadPlan,
  type CreativeToolId,
  type DownloadPlan,
  type DownloadPlanKind,
} from './creative-tools-catalog.ts'
import { MCP_CLIENT_PLUGIN } from './unity-mcp.ts'

export type CreativeToolKey = string
export type CreativeRequestAction = 'download' | 'install' | 'inference'

export interface CreativeDownloadOption {
  id: CreativeToolKey
  name: string
  catalogKind: 'software' | 'model'
  acquisition: 'software-installer' | 'hf-weights'
  planKind: DownloadPlan['kind']
  sourceUrl: string
  downloadOptions: readonly DownloadPlanKind[]
  modelId?: string
  revision?: string
  gated?: boolean | 'manual'
  license?: string
}

function entryFor(id: CreativeToolKey) {
  const entry = CREATIVE_TOOLS_CATALOG.find(candidate => candidate.id === id)
  if (!entry) throw new Error(`CREATIVE_TOOL_UNKNOWN: ${id}`)
  return entry
}

/** Project catalog rows without inventing a source URL, model, or endpoint. */
export function creativeDownloadOptions(): CreativeDownloadOption[] {
  return CREATIVE_TOOLS_CATALOG
    .filter(entry => entry.downloadOptions.length > 0)
    .map(entry => {
      const model = entry.model
      return {
        id: entry.id,
        name: entry.name,
        catalogKind: entry.kind,
        acquisition: entry.kind === 'software' ? 'software-installer' : 'hf-weights',
        planKind: entry.downloadOptions[0]!,
        sourceUrl: entry.source.url,
        downloadOptions: entry.downloadOptions,
        ...(model ? {
          modelId: model.modelId,
          revision: model.revision,
          gated: model.gated,
          license: model.license,
        } : {}),
      }
    })
}

export type CreativeRequestPlan =
  | {
      kind: 'software-installer'
      toolId: CreativeToolKey
      process: DownloadPlan
      notes: readonly string[]
    }
  | {
      kind: 'hf-weights'
      toolId: CreativeToolKey
      process: DownloadPlan
      notes: readonly string[]
    }
  | {
      kind: 'blocked'
      toolId: CreativeToolKey
      action: CreativeRequestAction
      reason: 'INFERENCE_ENDPOINT_NOT_CATALOGUED' | 'CREATIVE_TOOL_NOT_DOWNLOADABLE' | 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL'
      notes: readonly string[]
    }

export interface CreativeRequest {
  toolId: CreativeToolKey
  action: CreativeRequestAction
  endpoint?: string
  localDir?: string
  allowGated?: boolean
}

/**
 * Plan a catalogued software-page or local-weight acquisition. Inference is
 * deliberately blocked: provenance/source URLs and HF mirrors are not endpoints.
 */
export function planCreativeRequest(request: CreativeRequest): CreativeRequestPlan {
  const entry = entryFor(request.toolId)
  if (request.action === 'inference') {
    return {
      kind: 'blocked',
      toolId: entry.id,
      action: request.action,
      reason: 'INFERENCE_ENDPOINT_NOT_CATALOGUED',
      notes: [
        'The catalog records software pages and local model weights, not hosted inference endpoints.',
        'Do not reinterpret a source URL or HF mirror as an inference endpoint.',
      ],
    }
  }
  if (entry.downloadOptions.length === 0) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      action: request.action,
      reason: 'CREATIVE_TOOL_NOT_DOWNLOADABLE',
      notes: ['No catalogued download option exists for this tool.'],
    }
  }
  if (entry.model?.gated && request.allowGated !== true) {
    return {
      kind: 'blocked', toolId: entry.id, action: request.action,
      reason: 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL',
      notes: ['Obtain explicit gated-model approval and repository access before preparing the weight download.'],
    }
  }
  const process = downloadPlan(entry.id as CreativeToolId, {
    ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }),
    ...(request.localDir === undefined ? {} : { localDir: request.localDir }),
  })
  if (process.kind === 'open-url') {
    return {
      kind: 'software-installer',
      toolId: entry.id,
      process,
      notes: [
        'This opens the official software download page; it is not a silent installer.',
        'The software page is not an inference endpoint.',
      ],
    }
  }
  return {
    kind: 'hf-weights',
    toolId: entry.id,
    process,
    notes: [
      'This acquires local HF weights only; it does not install software.',
      'Downloaded weights are not an inference endpoint.',
    ],
  }
}

export interface McpInstallOptions {
  bunCommand?: string
  cwd?: string
  offline?: boolean
}

export type McpInstallPlan =
  | {
      kind: 'mcp-install-plan'
      toolId: CreativeToolKey
      owner: string
      process: ProcessPlan
      notes: readonly string[]
    }
  | {
      kind: 'blocked'
      toolId: CreativeToolKey
      reason: 'MCP_UNSUPPORTED' | 'MCP_CONFIGURATION_OWNER_MISSING' | 'MCP_INSTALLER_UNAVAILABLE'
      notes: readonly string[]
    }

/**
 * Route provisioning/validation through the existing owner recorded in the
 * catalog. This does not create an MCP client or a replacement server.
 */
export function mcpInstallPlan(toolId: CreativeToolKey, options: McpInstallOptions = {}): McpInstallPlan {
  const entry = entryFor(toolId)
  const mcp = entry.localIntegration?.mcp
  if (!mcp?.supported) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_UNSUPPORTED',
      notes: ['The catalog entry does not advertise MCP support.'],
    }
  }
  if (!mcp.configSource || mcp.configSource === 'none') {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_CONFIGURATION_OWNER_MISSING',
      notes: ['The catalog has no existing native/upstream MCP configuration owner.'],
    }
  }
  // Unity's owner is a config validator only; it cannot install or start the user-owned server.
  if (entry.id === 'unity') {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_INSTALLER_UNAVAILABLE',
      notes: [
        'The existing Unity MCP module validates explicit native configuration but does not install or start Unity MCP.',
        'Fail closed until the host supplies native/upstream configuration.',
      ],
    }
  }
  const argv = [options.bunCommand ?? 'bun', 'run', mcp.configSource]
  if (options.offline) argv.push('--offline')
  return {
    kind: 'mcp-install-plan',
    toolId: entry.id,
    owner: mcp.configSource,
    process: {
      argv,
      env: {},
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
    notes: [
      `Uses the existing native/upstream MCP owner ${mcp.configSource}.`,
      'This plan does not implement, replace, or claim a live MCP client.',
    ],
  }
}

/** One identity copied by the host from its native MCP tool registry. */
export interface NativeMcpToolBinding {
  serverName: string
  rawName: string
  publicName: string
}

export interface NativeMcpConfiguration {
  source: 'native-upstream'
  /** Must identify the existing catalog configuration owner. */
  configSource: string
  config: Readonly<Record<string, unknown>>
  /** Host-supplied snapshot, not user text. The host must revalidate it before dispatch. */
  discoveredTools?: readonly NativeMcpToolBinding[]
}

export interface McpCallRequest {
  toolId: CreativeToolKey
  toolName: string
  arguments?: Readonly<Record<string, unknown>>
  nativeConfiguration?: NativeMcpConfiguration
}

export type McpCallPlan =
  | {
      kind: 'mcp-call-plan'
      toolId: CreativeToolKey
      client: typeof MCP_CLIENT_PLUGIN
      serverName: string
      transport: string
      /** Raw wire name from native discovery; never recovered from a public name. */
      toolName: string
      qualifiedTool: string
      arguments: Readonly<Record<string, unknown>>
      nativeConfiguration: NativeMcpConfiguration
      live: false
      notes: readonly string[]
    }
  | {
      kind: 'blocked'
      toolId: CreativeToolKey
      reason: 'MCP_UNSUPPORTED' | 'MCP_CONFIGURATION_MISSING' | 'MCP_CONFIGURATION_INVALID' | 'MCP_TOOL_NAME_MISSING' | 'MCP_TOOL_SERVER_MISMATCH' | 'MCP_TOOL_NOT_DISCOVERED'
      notes: readonly string[]
    }

/**
 * Build a descriptor for the host's existing MCP client. No connection, client,
 * subprocess, or live-call claim is made here; missing native configuration blocks.
 */
export function mcpCallPlan(request: McpCallRequest): McpCallPlan {
  const entry = entryFor(request.toolId)
  const mcp = entry.localIntegration?.mcp
  if (!mcp?.supported) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_UNSUPPORTED',
      notes: ['The catalog entry does not advertise MCP support.'],
    }
  }
  if (!request.toolName.trim()) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_TOOL_NAME_MISSING',
      notes: ['An MCP tool name is required; no call was made.'],
    }
  }
  const native = request.nativeConfiguration
  if (!native) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_CONFIGURATION_MISSING',
      notes: ['Native/upstream MCP configuration is absent; no replacement client or endpoint is created.'],
    }
  }
  if (native.source !== 'native-upstream' || native.configSource !== mcp.configSource
    || !isRecord(native.config)
    || typeof native.config.serverName !== 'string'
    || native.config.serverName !== expectedServerName(entry.id)
    || typeof native.config.transport !== 'string'
    || !mcp.transport.includes(native.config.transport as 'stdio' | 'streamable-http' | 'sse')
    || (native.config.transport === 'stdio'
      ? typeof native.config.command !== 'string' || !native.config.command.trim() || native.config.url !== undefined
      : !isHttpTarget(native.config.url) || native.config.command !== undefined)) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_CONFIGURATION_INVALID',
      notes: ['The call must use the catalogued native/upstream configuration owner and transport.'],
    }
  }
  const prefix = `mcp__${native.config.serverName}__`
  if (request.toolName.startsWith('mcp__') && !request.toolName.startsWith(prefix)) {
    return { kind: 'blocked', toolId: entry.id, reason: 'MCP_TOOL_SERVER_MISMATCH', notes: ['The requested public name belongs to another server; no call was made.'] }
  }
  const bindings = native.discoveredTools
  if (!Array.isArray(bindings) || !bindings.every(isMcpBinding)) {
    return { kind: 'blocked', toolId: entry.id, reason: 'MCP_TOOL_NOT_DISCOVERED', notes: ['Host-supplied native MCP discovery is required; configuration alone is not a discovered capability.'] }
  }
  const matches = bindings.filter(binding => binding.serverName === native.config.serverName
    && (binding.rawName === request.toolName || binding.publicName === request.toolName))
  const selected = matches[0]
  if (matches.length !== 1 || !selected || !selected.publicName.startsWith(prefix)
    || selected.publicName.length === prefix.length
    || bindings.some(binding => binding !== selected && (binding.publicName === selected.publicName
      || binding.serverName === selected.serverName && binding.rawName === selected.rawName))) {
    return { kind: 'blocked', toolId: entry.id, reason: 'MCP_TOOL_NOT_DISCOVERED', notes: ['The native registry must provide one unambiguous raw/public tool binding for this server.'] }
  }
  const args = request.arguments ?? {}
  if (!isRecord(args)) {
    return {
      kind: 'blocked',
      toolId: entry.id,
      reason: 'MCP_CONFIGURATION_INVALID',
      notes: ['MCP arguments must be a record; no call was made.'],
    }
  }
  return {
    kind: 'mcp-call-plan',
    toolId: entry.id,
    client: MCP_CLIENT_PLUGIN,
    serverName: native.config.serverName,
    transport: native.config.transport,
    toolName: selected.rawName,
    qualifiedTool: selected.publicName,
    arguments: { ...args },
    nativeConfiguration: native,
    live: false,
    notes: [
      'This is an inert descriptor for the existing upstream MCP client.',
      'The host must revalidate the binding in its current native registry and execute through that integration; this module never connects.',
    ],
  }
}

export interface ProcessPlan {
  argv: readonly string[]
  env: Readonly<Record<string, string>>
  cwd?: string
}

export interface ProcessExecutionResult {
  exitCode: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
}

export type ProcessExecutor = (plan: ProcessPlan) => Promise<ProcessExecutionResult> | ProcessExecutionResult
export type ExecutableProcessPlan = DownloadPlan | ProcessPlan

/** Execute only after explicit caller confirmation, using argv rather than a shell. */
export async function executeProcessPlan(plan: ExecutableProcessPlan, execute: ProcessExecutor, options: { confirmed?: boolean } = {}): Promise<ProcessExecutionResult> {
  if (options.confirmed !== true) throw new Error('CREATIVE_PLAN_CONFIRMATION_REQUIRED')
  if (!Array.isArray(plan.argv) || plan.argv.length === 0 || plan.argv.some(token => typeof token !== 'string')) {
    throw new Error('CREATIVE_PROCESS_PLAN_INVALID')
  }
  return await execute({
    argv: [...plan.argv],
    env: { ...plan.env },
    ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectedServerName(toolId: CreativeToolKey): string | undefined {
  if (toolId === 'blender' || toolId === 'unity') return toolId
  return undefined
}

function isHttpTarget(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isMcpBinding(value: unknown): value is NativeMcpToolBinding {
  return isRecord(value)
    && typeof value.serverName === 'string' && value.serverName.trim().length > 0
    && typeof value.rawName === 'string' && value.rawName.trim().length > 0
    && typeof value.publicName === 'string' && value.publicName.trim().length > 0
    && !/[\s\u0000]/u.test(value.serverName)
    && !/[\s\u0000]/u.test(value.publicName)
}
