/** Offline tests for the catalog-backed creative install chooser. */
import { expect, test } from 'bun:test'
import { CREATIVE_TOOLS_CATALOG } from './creative-tools-catalog.ts'
import {
  buildEndpointPlan,
  buildSoftwarePlan,
  buildWeightsPlan,
  creativeDownloadOptions,
  creativeInstallOptions,
  creativeToolMatches,
  executeProcessPlan,
  mcpCallPlan,
  mcpInstallPlan,
  nativeJobProposal,
  planCreativeRequest,
  type CreativeProcessPlan,
  type NativeMcpConfiguration,
  type NativeMcpToolBinding,
} from './creative-tool-install.ts'

const catalog = CREATIVE_TOOLS_CATALOG
const native = (configSource: string, config: Readonly<Record<string, unknown>>, discoveredTools?: readonly NativeMcpToolBinding[]): NativeMcpConfiguration => ({ source: 'native-upstream', configSource, config, discoveredTools })

// ── Closed catalog chooser and source boundaries ─────────────────────────────
test('download chooser projects software pages and local HF weights only', () => {
  const options = creativeDownloadOptions(catalog)
  expect(options.map(option => option.id)).toEqual(['blender', 'unity', 'sam3', 'sam3d', 'da3'])
  expect(options.find(option => option.id === 'blender')).toMatchObject({ acquisition: 'software-installer', planKind: 'open-url', sourceOptions: ['official-page'] })
  expect(options.find(option => option.id === 'da3')).toMatchObject({ acquisition: 'hf-weights', modelId: 'depth-anything/DA3-BASE', sourceOptions: ['hf-mirror'] })
  expect(options.some(option => option.sourceUrl.includes('/inference'))).toBe(false)
  expect(creativeDownloadOptions(catalog, 'unknown tool')).toEqual([])
})

test('install chooser annotates existing MCP owners without inventing a server', () => {
  const options = creativeInstallOptions(catalog)
  expect(options.find(option => option.id === 'blender')).toMatchObject({ mcp: true, mcpOwner: 'script/blender-mcp.ts' })
  expect(options.find(option => option.id === 'unity')).toMatchObject({ mcp: true, mcpOwner: 'script/unity-mcp.ts' })
  expect(options.find(option => option.id === 'sam3d')?.mcp).toBe(false)
})

test('software plan opens official page and never silently installs Blender or Unity', () => {
  const result = buildSoftwarePlan({ toolId: 'blender', cwd: '/tmp/review-only' })
  expect(result.kind).toBe('software-installer')
  if (result.kind !== 'software-installer') return
  const opener = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open']
  expect(result.process.argv).toEqual([...opener, 'https://www.blender.org/download/'])
  expect(result.process.env).toEqual({})
  expect(result.process.sideEffect).toBe('open-url')
  expect(result.notes.join(' ')).toContain('does not silently install')
  expect(buildSoftwarePlan({ toolId: 'unity', source: 'mirror' })).toMatchObject({ kind: 'blocked', reason: 'SOURCE_NOT_CATALOGUED' })
})

// ── HF mirror, gated SAM3D, and no endpoint invention ─────────────────────────
test('gated SAM3D weights require explicit approval and plan HF mirror argv', () => {
  const blocked = buildWeightsPlan({ toolId: 'sam3d', localDir: '/tmp/sam3d' })
  expect(blocked).toMatchObject({ kind: 'blocked', reason: 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL' })

  const approved = buildWeightsPlan({ toolId: 'sam3d', localDir: '/tmp/sam3d', allowGated: true })
  expect(approved.kind).toBe('hf-weights')
  if (approved.kind !== 'hf-weights') return
  expect(approved.source).toBe('hf-mirror')
  expect(approved.modelId).toBe('facebook/sam-3d-objects')
  expect(approved.process.argv.slice(0, 6)).toEqual(['hf', 'download', 'facebook/sam-3d-objects', '--revision', '2e73555018d2741ccd486e56c24fac41155a1dc6', 'checkpoints/pipeline.yaml'])
  expect(approved.process.env).toEqual({ HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_TELEMETRY: '1' })
  expect(approved.process.requiresConfirmation).toBe(true)
  expect(approved.process.inert).toBe(true)
  expect(approved.notes.join(' ')).toContain('local weights only')
})

test('DA3 weights remain local weights and official endpoint selection is blocked', () => {
  const result = planCreativeRequest({ text: 'download DA3', localDir: '/tmp/da3' })
  expect(result.kind).toBe('hf-weights')
  if (result.kind === 'hf-weights') expect(result.process.argv).toContain('depth-anything/DA3-BASE')
  expect(buildWeightsPlan({ toolId: 'da3', source: 'official' })).toMatchObject({ kind: 'blocked', reason: 'SOURCE_NOT_CATALOGUED' })
})

test('all inference requests fail closed because catalog has no hosted endpoints', () => {
  expect(buildEndpointPlan({ toolId: 'sam3d' })).toMatchObject({ kind: 'blocked', reason: 'INFERENCE_ENDPOINT_NOT_CATALOGUED' })
  expect(planCreativeRequest({ text: 'call DA3 inference endpoint' })).toMatchObject({ kind: 'blocked', reason: 'INFERENCE_ENDPOINT_NOT_CATALOGUED' })
})

// ── Existing MCP owners and native Jobs boundary ──────────────────────────────
test('Blender MCP installation delegates to existing owner and supports offline mode', () => {
  const result = mcpInstallPlan('blender', { bunCommand: '/review/bun', cwd: '/repo', offline: true })
  expect(result.kind).toBe('mcp-install-plan')
  if (result.kind !== 'mcp-install-plan') return
  expect(result.owner).toBe('script/blender-mcp.ts')
  expect(result.process.argv).toEqual(['/review/bun', 'run', 'script/blender-mcp.ts', '--offline'])
  expect(result.process.sideEffect).toBe('ensure-mcp')
  expect(result.notes.join(' ')).toContain('does not install Blender')
})

test('Unity MCP installation is unavailable but explicit configuration routes to its owner', () => {
  expect(mcpInstallPlan('unity')).toMatchObject({ kind: 'blocked', reason: 'MCP_INSTALLER_UNAVAILABLE' })
  const result = mcpInstallPlan('unity', { bunCommand: '/review/bun', cwd: '/repo', mode: 'configure' })
  expect(result.kind).toBe('mcp-configure-plan')
  if (result.kind !== 'mcp-configure-plan') return
  expect(result.owner).toBe('script/unity-mcp.ts')
  expect(result.process.argv).toEqual(['/review/bun', 'run', 'script/unity-mcp.ts'])
  expect(result.process.sideEffect).toBe('validate-mcp')
  expect(result.notes.join(' ')).toContain('does not install or start Unity')
})

test('unsupported model MCP installation fails closed', () => {
  expect(mcpInstallPlan('sam3d')).toMatchObject({ kind: 'blocked', reason: 'MCP_UNSUPPORTED' })
})

test('MCP calls require catalogued native configuration and use existing client', () => {
  expect(mcpCallPlan({ toolId: 'blender', toolName: 'scene_export' })).toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_MISSING' })
  const result = mcpCallPlan({
    toolId: 'unity', toolName: 'mcp__unity__execute_menu_item', arguments: { menuItem: 'File/Save' }, background: true,
    nativeConfiguration: native('script/unity-mcp.ts', { serverName: 'unity', transport: 'stdio', command: '/fixture/unity-mcp' }, [{ serverName: 'unity', rawName: 'execute_menu_item', publicName: 'mcp__unity__execute_menu_item' }]),
  })
  expect(result.kind).toBe('mcp-call-plan')
  if (result.kind !== 'mcp-call-plan') return
  expect(result.client).toBe('@deepseek-ai/dsh-mcp-client')
  expect(result.qualifiedTool).toBe('mcp__unity__execute_menu_item')
  expect(result.live).toBe(false)
  expect(result.jobAction).toBe('start-native-job')
  expect(result.notes.join(' ')).toContain('ctx.jobs.start')
})

test('MCP config owner, transport, and namespace must match existing catalog facts', () => {
  expect(mcpCallPlan({ toolId: 'unity', toolName: 'execute_menu_item', nativeConfiguration: native('invented-client.ts', { serverName: 'unity', transport: 'stdio' }) })).toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
  expect(mcpCallPlan({ toolId: 'unity', toolName: 'mcp__blender__wrong_server', nativeConfiguration: native('script/unity-mcp.ts', { serverName: 'unity', transport: 'stdio', command: '/fixture/unity-mcp' }) })).toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_SERVER_MISMATCH' })
})

test('native Jobs integration produces proposal only', () => {
  const proposal = nativeJobProposal('blender')
  expect(proposal.kind).toBe('native-job-proposal')
  if (proposal.kind !== 'native-job-proposal') return
  expect(proposal.commands).toEqual([])
  expect(proposal.notes.join(' ')).toContain('no plugin.ts edit')
  expect(proposal.taskActions.join(' ')).toContain('ctx.jobs.start')
})

// ── Natural language chooser and injectable execution ─────────────────────────
test('ambiguous natural-language request returns choices instead of guessing', () => {
  const result = planCreativeRequest({ text: 'download' })
  expect(result.kind).toBe('choose')
  if (result.kind === 'choose') expect(result.reason).toBe('TOOL_REQUIRED')
})

test('natural-language gated download remains blocked without approval', () => {
  expect(planCreativeRequest({ text: 'download SAM3D weights' })).toMatchObject({ kind: 'blocked', reason: 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL' })
})

test('natural-language negation, questions, and source ambiguity do not authorize actions', () => {
  expect(planCreativeRequest({ text: 'do not download DA3' })).toMatchObject({ kind: 'blocked', reason: 'REQUEST_NEGATED' })
  expect(planCreativeRequest({ text: 'download DA3?' })).toMatchObject({ kind: 'choose', reason: 'ACTION_REQUIRED' })
  expect(planCreativeRequest({ text: 'download DA3 from the official mirror' })).toMatchObject({ kind: 'choose', reason: 'SOURCE_REQUIRED' })
})

test('tool matching separates SAM3 from SAM3D without hiding explicitly named siblings', () => {
  for (const text of ['SAM3D', 'SAM 3 D', '下载SAM-3D权重']) {
    expect(creativeToolMatches(text).map(entry => entry.id)).toEqual(['sam3d'])
  }
  expect(creativeToolMatches('SAM3 and SAM3D').map(entry => entry.id)).toEqual(['sam3', 'sam3d'])
  expect(creativeToolMatches('community model DA30')).toEqual([])
})

test('mere mentions and non-install words keep the action chooser open', () => {
  for (const text of ['DA3 model weights', 'Blender installation guide', 'uninstall Blender', 'Blender MCP']) {
    expect(planCreativeRequest({ text })).toMatchObject({ kind: 'choose', reason: 'ACTION_REQUIRED' })
  }
  expect(planCreativeRequest({ text: '下载DA3权重' })).toMatchObject({ kind: 'hf-weights', toolId: 'da3' })
  expect(planCreativeRequest({ text: '不要下载DA3' })).toMatchObject({ kind: 'blocked', reason: 'REQUEST_NEGATED' })
})

test('natural-language sources and MCP configuration preserve category boundaries', () => {
  expect(planCreativeRequest({ text: 'download DA3 from a mirror' })).toMatchObject({ kind: 'hf-weights', source: 'hf-mirror' })
  expect(planCreativeRequest({ text: 'download DA3 from huggingface.co' })).toMatchObject({ kind: 'blocked', reason: 'SOURCE_NOT_CATALOGUED' })
  expect(planCreativeRequest({ text: 'download Blender from a mirror' })).toMatchObject({ kind: 'blocked', reason: 'SOURCE_NOT_CATALOGUED' })
  expect(planCreativeRequest({ text: 'install Unity MCP' })).toMatchObject({ kind: 'blocked', reason: 'MCP_INSTALLER_UNAVAILABLE' })
  expect(planCreativeRequest({ text: 'configure Unity MCP' })).toMatchObject({ kind: 'mcp-configure-plan', process: { sideEffect: 'validate-mcp' } })
  expect(planCreativeRequest({ text: 'download Blender MCP' })).toMatchObject({ kind: 'choose', reason: 'ACTION_REQUIRED' })
})

test('catalog selection cannot replace model identities or bypass the shared access gate', () => {
  const sam = catalog.find(entry => entry.id === 'sam3d')!
  const selection = [{ ...sam, model: { ...sam.model!, gated: false, modelId: 'fixture/forged-model' } }]
  expect(buildWeightsPlan({ toolId: 'sam3d', catalog: selection })).toMatchObject({ kind: 'blocked', reason: 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL' })
  expect(creativeDownloadOptions(selection)).toMatchObject([{ id: 'sam3d', modelId: sam.model!.modelId, gated: 'manual' }])
  expect(buildWeightsPlan({ toolId: 'da3', catalog: selection })).toMatchObject({ kind: 'blocked', reason: 'CREATIVE_TOOL_NOT_FOUND' })
})

test('MCP wrapper preserves discovered identities and never fabricates a public namespace', () => {
  const config = { serverName: 'blender', transport: 'stdio', command: '/fixture/blender-mcp' }
  const binding = { serverName: 'blender', rawName: 'scene.export', publicName: 'mcp__blender__scene_export_faea3b85c527' }
  expect(mcpCallPlan({ toolId: 'blender', toolName: binding.rawName, nativeConfiguration: native('script/blender-mcp.ts', config) })).toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_NOT_DISCOVERED' })
  expect(mcpCallPlan({ toolId: 'blender', toolName: binding.publicName, nativeConfiguration: native('script/blender-mcp.ts', config, [binding]) })).toMatchObject({ kind: 'mcp-call-plan', toolName: binding.rawName, qualifiedTool: binding.publicName, live: false, jobAction: 'direct-native-call' })
})

test('injectable executor receives argv and requires explicit confirmation', async () => {
  const result = buildWeightsPlan({ toolId: 'da3', localDir: '/tmp/fixture-da3' })
  expect(result.kind).toBe('hf-weights')
  if (result.kind !== 'hf-weights') return
  const seen: CreativeProcessPlan[] = []
  await expect(executeProcessPlan(result.process, plan => { seen.push(plan); return { exitCode: 0, stdout: 'offline fixture' } })).rejects.toThrow('CREATIVE_PLAN_CONFIRMATION_REQUIRED')
  const execution = await executeProcessPlan(result.process, plan => { seen.push(plan); return { exitCode: 0, stdout: 'offline fixture' } }, { confirmed: true })
  expect(execution).toEqual({ exitCode: 0, stdout: 'offline fixture' })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.argv[0]).toBe('hf')
})
