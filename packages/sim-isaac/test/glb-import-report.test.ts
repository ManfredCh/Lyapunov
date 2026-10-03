/**
 * GLB 视觉导入的保留/丢弃回执（ISAAC-19，离线解析，不启动 Isaac）。
 *
 * 背景：`glb_visual.node_document` 无条件 `doc.pop('animations'/'skins')`，`convert_glb` 又设
 * `context.ignore_animations = True`，两条路径都静默丢弃且没有调用方可见的回执。本文件锁三件事，
 * 全部按外部可观测输出判定：
 *   ① 带 animations 的 GLB 交付前必须给出结构化“丢弃动画”事实，缓存命中路径同样给；
 *   ② 指定节点带 skin 仍然明确拒绝（UNSUPPORTED_CAPABILITY），不因本次改动放宽、也不产生交付口径的提示；
 *   ③ 无动画的真实 GLB 不产生任何提示，避免误导。
 *
 * 本机没有 omni/Isaac，`convert` 模式用最小 stub 顶替 `omni.kit.asset_converter`，目的只是真实跑通
 * glb_visual 的控制流（read_document → dependencies → cache → report_import → converter），stub 只写一个
 * 非空占位产物、不产生任何 USD 内容。**这不是引擎实测**；拒绝路径（②）不装 stub，是完全真实的代码路径。
 *
 * 运行：bun test packages/sim-isaac/test/glb-import-report.test.ts
 * 解释器：LYAPUNOV_ISAAC_PYTHON 可覆盖，默认 python3；都不可用时整组 skip，不静默当成通过。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pythonDir = resolve(here, '../python')
const realFixture = resolve(here, '../../../materials/mcp-env/assets/kenney-props/visual/prop_10_traffic-light.glb')
const WARNING_PREFIX = '[lyapunov] GLB 视觉导入: '

function findPython(): string | undefined {
  const candidates = [process.env.LYAPUNOV_ISAAC_PYTHON, 'python3']
  for (const candidate of candidates) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
  }
  return undefined
}

const python = findPython()
const suite = python === undefined ? describe.skip : describe

/** 最小 python 驱动：跑一次 convert_glb，把结果与 warnings 记录成 JSON 打到 stdout。 */
const DRIVER = String.raw`
import json, os, sys, types, warnings
from pathlib import Path

sys.path.insert(0, os.environ['LYAPUNOV_GLB_PY_DIR'])
import glb_visual

mode, source, cache = sys.argv[1], sys.argv[2], sys.argv[3]
node_index = int(sys.argv[4]) if len(sys.argv) > 4 else None
calls = []

def install_converter_stub():
    """omni.kit.asset_converter 的最小替身：只为跑通控制流，写非空占位产物；不是引擎实测。"""
    kit = types.ModuleType('omni.kit')
    app = types.ModuleType('omni.kit.app')
    class ExtensionManager:
        def set_extension_enabled_immediate(self, *args): return True
    class App:
        def get_extension_manager(self): return ExtensionManager()
        def update(self): pass
    app.get_app = lambda: App()
    converter = types.ModuleType('omni.kit.asset_converter')
    converter.AssetConverterContext = type('AssetConverterContext', (), {})
    class Task:
        def __init__(self, destination): self.destination = destination
        def wait_until_finished(self): Path(self.destination).write_bytes(b'stub-usdc')
        def cancel(self): pass
        def get_error_message(self): return ''
    class Instance:
        def create_converter_task(self, src, dst, parent, context):
            calls.append([str(src), str(dst)]); return Task(dst)
    converter.get_instance = lambda: Instance()
    async_engine = types.ModuleType('omni.kit.async_engine')
    class Finished:
        def done(self): return True
        def result(self): return True
        def cancel(self): pass
    async_engine.run_coroutine = lambda pending: Finished()
    omni = types.ModuleType('omni')
    omni.kit = kit
    kit.app = app; kit.asset_converter = converter; kit.async_engine = async_engine
    sys.modules.update({'omni': omni, 'omni.kit': kit, 'omni.kit.app': app,
                        'omni.kit.asset_converter': converter, 'omni.kit.async_engine': async_engine})

if mode == 'convert': install_converter_stub()
with warnings.catch_warnings(record=True) as record:
    warnings.simplefilter('always')
    try:
        output = glb_visual.convert_glb(source, cache, node_index)
        payload = {'ok': True, 'output': output, 'converterCalls': len(calls)}
    except glb_visual.VisualError as error:
        payload = {'ok': False, 'code': error.code, 'message': str(error), 'converterCalls': len(calls)}
    payload['warnings'] = [str(item.message) for item in record]
print(json.dumps(payload, ensure_ascii=False))
`

interface DriverResult {
  ok: boolean
  output?: string | null
  converterCalls: number
  code?: string
  message?: string
  warnings: string[]
}

interface ImportFacts {
  source: string
  nodeIndex: number | null
  kept: { nodes: number; mesh?: number; meshes?: number }
  dropped: { kind: string; count: number; reason: string }[]
}

function runDriver(mode: 'convert' | 'cached' | 'reject', glb: string, cacheRoot: string, nodeIndex?: number): DriverResult {
  const args = ['-c', DRIVER, mode, glb, cacheRoot]
  if (nodeIndex !== undefined) args.push(String(nodeIndex))
  const run = spawnSync(python as string, args, { encoding: 'utf8', env: { ...process.env, LYAPUNOV_GLB_PY_DIR: pythonDir } })
  if (run.status !== 0) throw new Error(`python 驱动失败(status=${run.status}): ${run.stderr}`)
  return JSON.parse(run.stdout) as DriverResult
}

/** 告警必须都是本模块的结构化回执，并解析回同一份报告。 */
function factsFrom(warnings: string[]): ImportFacts[] {
  return warnings.map((message) => {
    if (!message.startsWith(WARNING_PREFIX)) throw new Error(`非预期告警: ${message}`)
    return JSON.parse(message.slice(WARNING_PREFIX.length)) as ImportFacts
  })
}

function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  return found
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/** 组装最小合法 glTF 2 GLB（JSON chunk + 36 字节 BIN chunk）。 */
function glbBytes(document: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(document), 'utf8')
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const binary = Buffer.alloc(36)
  const binChunk = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4, 0)])
  const chunks = Buffer.concat([
    u32(jsonChunk.length), u32(0x4e4f534a), jsonChunk,
    u32(binChunk.length), u32(0x004e4942), binChunk,
  ])
  return Buffer.concat([u32(0x46546c67), u32(2), u32(12 + chunks.length), chunks])
}

const COMMON = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
}

function animatedDocument(): Record<string, unknown> {
  return {
    ...COMMON,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'animated', mesh: 0 }],
    animations: [{ channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 0, output: 0, interpolation: 'LINEAR' }] }],
  }
}

function skinnedDocument(): Record<string, unknown> {
  return {
    ...COMMON,
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'skinned', mesh: 0, skin: 0 }],
    skins: [{ joints: [0] }],
  }
}

function multiNodeDocument(): Record<string, unknown> {
  return {
    ...COMMON,
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'kept', mesh: 0 }, { name: 'dropped', mesh: 0 }],
  }
}

suite('GLB 动画/skin 导入回执（ISAAC-19）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lyapunov-glb-report-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('带 animations 的 GLB：交付前给出结构化“已丢弃动画”事实', () => {
    const glb = join(root, 'animated.glb')
    writeFileSync(glb, glbBytes(animatedDocument()))
    const result = runDriver('convert', glb, join(root, 'cache-animated'))
    expect(result.ok).toBe(true)
    expect(result.converterCalls).toBe(1) // 确实走到转换器，而不是靠某条提前返回“通过”
    expect(result.output).toBeTruthy()
    expect(existsSync(result.output as string)).toBe(true)
    const facts = factsFrom(result.warnings)
    expect(facts.length).toBe(1)
    expect(facts[0].source).toBe(glb)
    expect(facts[0].nodeIndex).toBeNull()
    expect(facts[0].kept).toEqual({ nodes: 1, meshes: 1 })
    expect(facts[0].dropped).toEqual([{ kind: 'animations', count: 1, reason: '视觉 USD 不写动画通道' }])
  })

  test('缓存命中的导入同样回执，不因复用缓存再次静默（不装 stub，缓存没命中就会失败）', () => {
    const glb = join(root, 'animated-cached.glb')
    const cache = join(root, 'cache-hit')
    writeFileSync(glb, glbBytes(animatedDocument()))
    expect(runDriver('convert', glb, cache).converterCalls).toBe(1)
    const hit = runDriver('cached', glb, cache)
    expect(hit.ok).toBe(true)
    expect(hit.converterCalls).toBe(0)
    const facts = factsFrom(hit.warnings)
    expect(facts.length).toBe(1)
    expect(facts[0].dropped[0].kind).toBe('animations')
  })

  test('指定节点带 skin：仍然明确拒绝，不放宽、也不给交付口径的提示', () => {
    const glb = join(root, 'skinned.glb')
    const cache = join(root, 'cache-skin')
    writeFileSync(glb, glbBytes(skinnedDocument()))
    const result = runDriver('reject', glb, cache, 0)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(result.message).toBe('glTF skin 需单独动画适配')
    expect(result.converterCalls).toBe(0)
    expect(result.warnings).toEqual([]) // 没有交付任何东西，就不该有“已导入/已丢弃”的提示
    expect(filesUnder(cache).filter((path) => path.endsWith('asset.usdc'))).toEqual([])
  })

  test('节点分片：报告只保留 gltfNode 指定的节点，其余节点计入丢弃', () => {
    const glb = join(root, 'multi.glb')
    writeFileSync(glb, glbBytes(multiNodeDocument()))
    const result = runDriver('convert', glb, join(root, 'cache-node'), 1)
    expect(result.ok).toBe(true)
    const facts = factsFrom(result.warnings)
    expect(facts.length).toBe(1)
    expect(facts[0].nodeIndex).toBe(1)
    expect(facts[0].kept).toEqual({ nodes: 1, mesh: 0 })
    expect(facts[0].dropped).toEqual([{ kind: 'nodes', count: 1, reason: '节点分片只保留 gltfNode 指定的节点' }])
  })

  test('无动画的真实 GLB 夹具：不产生任何提示', () => {
    expect(existsSync(realFixture)).toBe(true) // 前置：真实夹具随仓库提供
    const result = runDriver('convert', realFixture, join(root, 'cache-real'))
    expect(result.ok).toBe(true)
    expect(result.converterCalls).toBe(1) // 真的导入了，不是因为没有动画而被跳过
    expect(result.warnings).toEqual([])
  })
})
