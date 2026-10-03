import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  CREATIVE_TOOLS_CATALOG,
  HF_DEFAULT_MIRROR,
  catalogSummary,
  downloadPlan,
  getCreativeTool,
  validateHfEndpoint,
} from './creative-tools-catalog.ts'

describe('creative tools catalog', () => {
  let previousEndpoint: string | undefined
  beforeEach(() => {
    previousEndpoint = process.env.HF_ENDPOINT
    delete process.env.HF_ENDPOINT
  })
  afterEach(() => {
    if (previousEndpoint === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = previousEndpoint
  })

  test('has five distinct software/model entries and no inference endpoint claim', () => {
    expect(CREATIVE_TOOLS_CATALOG.map(entry => entry.id)).toEqual(['blender', 'unity', 'sam3', 'sam3d', 'da3'])
    for (const entry of CREATIVE_TOOLS_CATALOG) {
      expect(entry.source.url.startsWith('https://')).toBe(true)
      expect(entry.source.role).not.toBe('source-code')
      expect(entry.source.url).not.toContain('api.')
      if (entry.model) expect(entry.source.role).toBe('model-weights')
    }
  })

  test('keeps official software URLs separate from HF model repositories', () => {
    const blender = getCreativeTool('blender')
    const unity = getCreativeTool('unity')
    const sam3d = getCreativeTool('sam3d')
    const da3 = getCreativeTool('da3')
    expect(blender.source.url).toBe('https://www.blender.org/download/')
    expect(unity.source.url).toBe('https://unity.com/download')
    expect(sam3d.model?.modelId).toBe('facebook/sam-3d-objects')
    expect(da3.model?.modelId).toBe('depth-anything/DA3-BASE')
    expect(sam3d.source.url).toBe('https://huggingface.co/facebook/sam-3d-objects')
    expect(da3.source.url).toBe('https://huggingface.co/depth-anything/DA3-BASE')
  })

  test('records pinned revisions and evidence-backed gated/license/size metadata', () => {
    const sam3 = getCreativeTool('sam3').model!
    const sam3d = getCreativeTool('sam3d').model!
    const da3 = getCreativeTool('da3').model!
    expect(sam3.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(sam3.gated).toBe('manual')
    expect(sam3.license).toBe('other')
    expect(sam3.usedStorageBytes).toBe(10_329_938_097)
    expect(sam3d.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(sam3d.gated).toBe('manual')
    expect(sam3d.license).toBe('other')
    expect(sam3d.usedStorageBytes).toBe(13_338_859_690)
    expect(da3.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(da3.gated).toBe(false)
    expect(da3.license).toBe('apache-2.0')
    expect(da3.usedStorageBytes).toBe(541_518_028)
  })

  test('software plans are explicit official-page argv, not installers or inference calls', () => {
    const plan = downloadPlan('blender')
    expect(plan.kind).toBe('open-url')
    const expectedOpener = process.platform === 'darwin'
      ? ['open', 'https://www.blender.org/download/']
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', 'https://www.blender.org/download/']
        : ['xdg-open', 'https://www.blender.org/download/']
    expect(plan.argv).toEqual(expectedOpener)
    expect(plan.env).toEqual({})
    expect(plan.credentials).toBe('none')
    expect(plan.argv.join(' ')).not.toContain('HF_ENDPOINT')
  })

  test('HF plans use pinned revision, selected files, mirror endpoint and no token argv', () => {
    const plan = downloadPlan('da3', { localDir: '/tmp/da3' })
    expect(plan.kind).toBe('hf-download')
    expect(plan.argv).toEqual([
      'hf', 'download', 'depth-anything/DA3-BASE', '--revision', 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e',
      'config.json', 'model.safetensors', '--local-dir', '/tmp/da3',
    ])
    expect(plan.env).toEqual({ HF_ENDPOINT: HF_DEFAULT_MIRROR, HF_HUB_DISABLE_TELEMETRY: '1' })
    expect(plan.credentials).toBe('none')
    expect(plan.argv.some(token => token.includes('TOKEN') || token.includes('Bearer'))).toBe(false)
    expect(plan.notes.join(' ')).toContain('not an inference endpoint')
  })

  test('gated SAM3D plans make access a prerequisite without downloading weights in tests', () => {
    const plan = downloadPlan('sam3d', { localDir: '/tmp/sam3d' })
    expect(plan.argv[0]).toBe('hf')
    expect(plan.argv).toContain('facebook/sam-3d-objects')
    expect(plan.argv).toContain('2e73555018d2741ccd486e56c24fac41155a1dc6')
    expect(plan.credentials).toBe('hf-token-to-configured-mirror-only')
    expect(plan.notes.join(' ')).toContain('gated/manual')
    expect(plan.argv).toContain('checkpoints/slat_generator.ckpt')
    expect(plan.argv).toContain('checkpoints/ss_encoder.safetensors')
    expect(plan.argv.some(token => token.startsWith('http'))).toBe(false)
  })

  test('endpoint validation rejects official Hub, non-mirror, insecure, and credential-bearing URLs', () => {
    expect(validateHfEndpoint(HF_DEFAULT_MIRROR)).toBe(HF_DEFAULT_MIRROR)
    expect(() => validateHfEndpoint('https://huggingface.co')).toThrow('CREATIVE_HF_ENDPOINT_OFFICIAL_FORBIDDEN')
    expect(() => validateHfEndpoint('https://evil.example')).toThrow('CREATIVE_HF_ENDPOINT_MIRROR_FORBIDDEN')
    expect(() => validateHfEndpoint('http://hf-mirror.com')).toThrow('CREATIVE_HF_ENDPOINT_HTTPS_REQUIRED')
    expect(() => validateHfEndpoint('https://token@hf-mirror.com')).toThrow('CREATIVE_HF_ENDPOINT_CREDENTIALS_FORBIDDEN')
  })

  test('endpoint validation pins the HTTPS origin, not just a hostname', () => {
    expect(validateHfEndpoint('https://hf-mirror.com/')).toBe(HF_DEFAULT_MIRROR)
    expect(validateHfEndpoint('https://hf-mirror.com:443')).toBe(HF_DEFAULT_MIRROR)
    for (const endpoint of [
      'https://hf-mirror.com:8443', 'https://hf-mirror.com/api',
      'https://hf-mirror.com.evil.example', 'https://cdn.hf-mirror.com',
      'https://hf-mirror.com@evil.example', 'https://sub.huggingface.co',
      'https://hf-mirror.com?token=not-a-secret', 'https://hf-mirror.com#fragment',
      'not a URL',
    ]) expect(() => validateHfEndpoint(endpoint)).toThrow()
  })

  test('explicit endpoint overrides environment, but an unsafe inherited endpoint fails', () => {
    process.env.HF_ENDPOINT = 'https://unapproved.example'
    expect(() => downloadPlan('da3', { localDir: '/tmp/model' })).toThrow('CREATIVE_HF_ENDPOINT_MIRROR_FORBIDDEN')
    expect(downloadPlan('da3', { localDir: '/tmp/model', endpoint: HF_DEFAULT_MIRROR }).env.HF_ENDPOINT).toBe(HF_DEFAULT_MIRROR)
    process.env.HF_ENDPOINT = `${HF_DEFAULT_MIRROR}/`
    expect(downloadPlan('da3', { localDir: '/tmp/model' }).env.HF_ENDPOINT).toBe(HF_DEFAULT_MIRROR)
  })

  test('weight plans require a real destination and reject option/control injection', () => {
    expect(() => downloadPlan('da3')).toThrow('CREATIVE_MODEL_DIRECTORY_REQUIRED')
    for (const localDir of ['', ' ', '<MODEL_DIR>']) {
      expect(() => downloadPlan('da3', { localDir })).toThrow('CREATIVE_MODEL_DIRECTORY_REQUIRED')
    }
    for (const localDir of ['--token', '--local-dir=/tmp/other', '/tmp/model\u0000', '/tmp/model\nother']) {
      expect(() => downloadPlan('da3', { localDir })).toThrow('CREATIVE_MODEL_DIRECTORY_INVALID')
    }
    const destination = '/tmp/model folder;$(never-execute)'
    const plan = downloadPlan('da3', { localDir: destination })
    expect(plan.argv.slice(-2)).toEqual(['--local-dir', destination])
    expect(plan.argv[0]).toBe('hf')
    expect(plan.env).not.toHaveProperty('HF_TOKEN')
  })

  test('SAM3 plans use the checkpoint consumed by the existing SDK, not duplicate weights', () => {
    const plan = downloadPlan('sam3', { localDir: '/tmp/sam3' })
    expect(getCreativeTool('sam3').model?.files).toEqual(['sam3.pt'])
    expect(plan.argv).toContain('sam3.pt')
    expect(plan.argv).not.toContain('model.safetensors')
  })

  test('local integration metadata does not invent packages or compatible loaders', () => {
    expect(getCreativeTool('sam3d').localIntegration).toBeUndefined()
    expect(getCreativeTool('da3').localIntegration?.status).toBe('different-model')
    expect(getCreativeTool('sam3').localIntegration?.status).toBe('adapter-present')
    expect(getCreativeTool('unity').sources.find(source => source.url.includes('CoplayDev'))?.kind).toBe('community-repository')
    expect(getCreativeTool('blender').localIntegration?.mcp?.configSource).toBe('script/blender-mcp.ts')
    expect(getCreativeTool('unity').localIntegration?.mcp?.configSource).toBe('script/unity-mcp.ts')
  })

  test('unknown runtime tool ids fail rather than invent a source', () => {
    expect(() => getCreativeTool('unknown' as Parameters<typeof getCreativeTool>[0])).toThrow('CREATIVE_TOOL_NOT_FOUND')
  })

  test('summary is redacted and preserves model identity metadata', () => {
    const summary = catalogSummary()
    expect(summary).toHaveLength(5)
    expect(summary.find(row => row.id === 'da3')).toMatchObject({ modelId: 'depth-anything/DA3-BASE', gated: false })
    expect(JSON.stringify(summary)).not.toContain('HF_TOKEN')
    expect(JSON.stringify(summary)).not.toContain('Bearer')
  })
})
