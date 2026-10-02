import { describe, expect, test } from 'bun:test'
import {
  creativeDownloadOptions,
  executeProcessPlan,
  mcpCallPlan,
  mcpInstallPlan,
  planCreativeRequest,
  type ProcessPlan,
} from './creative-tool-install-catalog.ts'

describe('catalog-backed creative tool install planner', () => {
  test('projects only catalogued acquisition facts', () => {
    const options = creativeDownloadOptions()
    expect(options.map(option => option.id)).toEqual(['blender', 'unity', 'sam3', 'sam3d', 'da3'])
    expect(options.find(option => option.id === 'blender')).toMatchObject({
      acquisition: 'software-installer',
      sourceUrl: 'https://www.blender.org/download/',
      planKind: 'open-url',
    })
    expect(options.find(option => option.id === 'da3')).toMatchObject({
      acquisition: 'hf-weights',
      modelId: 'depth-anything/DA3-BASE',
      revision: 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e',
      planKind: 'hf-download',
    })
    expect(options.some(option => option.sourceUrl.includes('/inference'))).toBe(false)
  })

  test('software request is an official-page plan, never a model or endpoint plan', () => {
    const planned = planCreativeRequest({ toolId: 'blender', action: 'install', localDir: '/tmp/ignored-by-open-url' })
    expect(planned.kind).toBe('software-installer')
    if (planned.kind !== 'software-installer') return
    const opener = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open']
    expect(planned.process.argv).toEqual([...opener, 'https://www.blender.org/download/'])
    expect(planned.process.env).toEqual({})
    expect(planned.notes.join(' ')).toContain('not an inference endpoint')
  })

  test('HF request is weights-only with catalog revision and no token in argv', () => {
    const planned = planCreativeRequest({ toolId: 'da3', action: 'download', localDir: '/tmp/da3' })
    expect(planned.kind).toBe('hf-weights')
    if (planned.kind !== 'hf-weights') return
    expect(planned.process.argv).toEqual([
      'hf', 'download', 'depth-anything/DA3-BASE', '--revision', 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e',
      'config.json', 'model.safetensors', '--local-dir', '/tmp/da3',
    ])
    expect(planned.process.env).toEqual({ HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_TELEMETRY: '1' })
    expect(planned.process.argv.join(' ')).not.toContain('HF_TOKEN')
    expect(planned.notes.join(' ')).toContain('not an inference endpoint')
  })

  test('inference is fail-closed because the catalog does not claim hosted endpoints', () => {
    const planned = planCreativeRequest({ toolId: 'sam3d', action: 'inference' })
    expect(planned).toMatchObject({ kind: 'blocked', reason: 'INFERENCE_ENDPOINT_NOT_CATALOGUED' })
  })

  test('Blender MCP install delegates to the existing owner and supports offline mode', () => {
    const planned = mcpInstallPlan('blender', { bunCommand: '/home/s18/.bun/bin/bun', cwd: '/repo', offline: true })
    expect(planned.kind).toBe('mcp-install-plan')
    if (planned.kind !== 'mcp-install-plan') return
    expect(planned.owner).toBe('script/blender-mcp.ts')
    expect(planned.process).toEqual({
      argv: ['/home/s18/.bun/bin/bun', 'run', 'script/blender-mcp.ts', '--offline'],
      env: {},
      cwd: '/repo',
    })
    expect(planned.notes.join(' ')).toContain('existing native/upstream MCP owner')
  })

  test('unsupported model MCP installation fails closed', () => {
    expect(mcpInstallPlan('sam3d')).toMatchObject({ kind: 'blocked', reason: 'MCP_UNSUPPORTED' })
  })

  test('Unity MCP validation is not misreported as an installer', () => {
    expect(mcpInstallPlan('unity')).toMatchObject({ kind: 'blocked', reason: 'MCP_INSTALLER_UNAVAILABLE' })
  })

  test('MCP calls fail closed without native/upstream configuration', () => {
    expect(mcpCallPlan({ toolId: 'blender', toolName: 'scene_export' })).toMatchObject({
      kind: 'blocked', reason: 'MCP_CONFIGURATION_MISSING',
    })
  })

  test('MCP call is an inert descriptor using the existing upstream client and config owner', () => {
    const planned = mcpCallPlan({
      toolId: 'unity',
      toolName: 'execute_menu_item',
      arguments: { menuItem: 'File/Save' },
      nativeConfiguration: {
        source: 'native-upstream',
        configSource: 'script/unity-mcp.ts',
        config: { serverName: 'unity', transport: 'stdio', command: 'mcp-for-unity' },
        discoveredTools: [{ serverName: 'unity', rawName: 'execute_menu_item', publicName: 'mcp__unity__execute_menu_item' }],
      },
    })
    expect(planned.kind).toBe('mcp-call-plan')
    if (planned.kind !== 'mcp-call-plan') return
    expect(planned.client).toBe('@deepseek-ai/dsh-mcp-client')
    expect(planned.serverName).toBe('unity')
    expect(planned.live).toBe(false)
    expect(planned.toolName).toBe('execute_menu_item')
    expect(planned.qualifiedTool).toBe('mcp__unity__execute_menu_item')
    expect(planned.notes.join(' ')).toContain('never connects')
  })

  test('MCP config owner and transport must match catalog facts', () => {
    expect(mcpCallPlan({
      toolId: 'unity',
      toolName: 'execute_menu_item',
      nativeConfiguration: {
        source: 'native-upstream', configSource: 'invented-client.ts',
        config: { serverName: 'unity', transport: 'stdio' },
      },
    })).toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
    expect(mcpCallPlan({
      toolId: 'unity',
      toolName: 'execute_menu_item',
      nativeConfiguration: {
        source: 'native-upstream', configSource: 'script/unity-mcp.ts',
        config: { serverName: 'unity', transport: 'websocket' },
      },
    })).toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
  })

  test('gated acquisition needs explicit approval while inference stays blocked', () => {
    for (const toolId of ['sam3', 'sam3d']) {
      expect(planCreativeRequest({ toolId, action: 'download', localDir: `/tmp/${toolId}` }))
        .toMatchObject({ kind: 'blocked', reason: 'GATED_MODEL_REQUIRES_EXPLICIT_APPROVAL' })
      expect(planCreativeRequest({ toolId, action: 'download', localDir: `/tmp/${toolId}`, allowGated: true }).kind).toBe('hf-weights')
      expect(planCreativeRequest({ toolId, action: 'inference', allowGated: true }).kind).toBe('blocked')
    }
  })

  test('MCP rejects another server, missing targets, and missing native discovery', () => {
    const config = { serverName: 'unity', transport: 'stdio', command: '/fixture/unity-mcp' }
    const native = { source: 'native-upstream' as const, configSource: 'script/unity-mcp.ts', config }
    const request = { toolId: 'unity', toolName: 'execute_menu_item', nativeConfiguration: native }
    for (const serverName of ['', 'blender', 'invented', ' unity ']) {
      expect(mcpCallPlan({ ...request, nativeConfiguration: { ...native, config: { ...config, serverName } } }))
        .toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
    }
    for (const command of [undefined, '', '   ']) {
      expect(mcpCallPlan({ ...request, nativeConfiguration: { ...native, config: { ...config, command } } }))
        .toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
    }
    expect(mcpCallPlan(request)).toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_NOT_DISCOVERED' })
    expect(mcpCallPlan({ ...request, nativeConfiguration: { ...native, discoveredTools: [] } }))
      .toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_NOT_DISCOVERED' })
    expect(mcpCallPlan({ ...request, toolName: 'mcp__blender__execute_menu_item' }))
      .toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_SERVER_MISMATCH' })
  })

  test('MCP preserves discovered raw/public identities instead of normalizing or parsing', () => {
    const binding = { serverName: 'blender', rawName: 'scene.export', publicName: 'mcp__blender__scene_export_faea3b85c527' }
    const native = {
      source: 'native-upstream' as const, configSource: 'script/blender-mcp.ts',
      config: { serverName: 'blender', transport: 'stdio', command: '/fixture/blender-mcp' },
      discoveredTools: [binding],
    }
    for (const toolName of [binding.rawName, binding.publicName]) {
      expect(mcpCallPlan({ toolId: 'blender', toolName, nativeConfiguration: native }))
        .toMatchObject({ kind: 'mcp-call-plan', toolName: binding.rawName, qualifiedTool: binding.publicName, live: false })
    }
    for (const discoveredTools of [
      [{ ...binding, serverName: 'unity' }],
      [{ ...binding, publicName: 'mcp__unity__scene_export' }],
      [binding, { ...binding }],
      [binding, { ...binding, rawName: 'other' }],
      [binding, { ...binding, publicName: 'mcp__blender__other' }],
    ]) {
      expect(mcpCallPlan({ toolId: 'blender', toolName: binding.rawName, nativeConfiguration: { ...native, discoveredTools } }))
        .toMatchObject({ kind: 'blocked', reason: 'MCP_TOOL_NOT_DISCOVERED' })
    }
    expect(mcpCallPlan({ toolId: 'blender', toolName: 'scene_export', nativeConfiguration: native }).kind).toBe('blocked')
    const longBinding = { ...binding, rawName: 'scene.'.repeat(30), publicName: `mcp__blender__${'a'.repeat(38)}_123456789abc` }
    expect(mcpCallPlan({ toolId: 'blender', toolName: longBinding.rawName, nativeConfiguration: { ...native, discoveredTools: [longBinding] } }))
      .toMatchObject({ kind: 'mcp-call-plan', toolName: longBinding.rawName, qualifiedTool: longBinding.publicName })
  })

  test('MCP HTTP transport requires an explicit HTTP target, not a command', () => {
    const binding = { serverName: 'unity', rawName: 'scene', publicName: 'mcp__unity__scene' }
    const native = { source: 'native-upstream' as const, configSource: 'script/unity-mcp.ts', discoveredTools: [binding] }
    for (const transport of ['streamable-http', 'sse']) {
      const config = { serverName: 'unity', transport, url: 'http://127.0.0.1:43210/mcp' }
      expect(mcpCallPlan({ toolId: 'unity', toolName: 'scene', nativeConfiguration: { ...native, config } }).kind).toBe('mcp-call-plan')
      for (const url of ['', 'not a URL', 'file:///tmp/mcp']) {
        expect(mcpCallPlan({ toolId: 'unity', toolName: 'scene', nativeConfiguration: { ...native, config: { ...config, url } } }))
          .toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
      }
      expect(mcpCallPlan({ toolId: 'unity', toolName: 'scene', nativeConfiguration: { ...native, config: { ...config, command: 'ambiguous' } } }))
        .toMatchObject({ kind: 'blocked', reason: 'MCP_CONFIGURATION_INVALID' })
    }
  })

  test('injected process executor receives argv arrays and no process is implicit', async () => {
    const plan: ProcessPlan = { argv: ['echo', 'fixture'], env: { TEST_MODE: '1' }, cwd: '/tmp' }
    const seen: ProcessPlan[] = []
    await expect(executeProcessPlan(plan, request => {
      seen.push(request)
      return { exitCode: 0 }
    })).rejects.toThrow('CREATIVE_PLAN_CONFIRMATION_REQUIRED')
    expect(seen).toHaveLength(0)
    const result = await executeProcessPlan(plan, request => {
      seen.push(request)
      return { exitCode: 0, stdout: 'offline fixture' }
    }, { confirmed: true })
    expect(result).toEqual({ exitCode: 0, stdout: 'offline fixture' })
    expect(seen).toEqual([plan])
  })
})
