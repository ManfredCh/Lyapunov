/**
 * ISAAC-19／D4：GLB 导入回执必须出现在 `WorldHandle.warnings`（实现有、可见面本来没有）。
 *
 * 两层：
 *  ① 离线行为测试（总跑）：用系统 python3 从 `python/worker.py` 里按 AST 抽出**真实函数**
 *     `glb_import_warnings` 与它的前缀常量，喂真实的 warnings 记录形状，断言：带前缀的 GLB 回执
 *     原样转成 `{code, message}`（message 保留原始 JSON、不裁剪）；无关告警不出现（不产生噪音）。
 *  ② 真实引擎测试（有 Isaac 解释器时才跑，跳过会写明原因）：真 Kit 打开一个含**带 animations 的 GLB**
 *     的 Scene，断言句柄带上 `GLB_IMPORT_DROPPED_CONTENT`，并断言 message 里真的写着 animations 被丢弃。
 *     这不是桩：走 `packages/sim-isaac/python/worker.py` + 真 `omni.kit.asset_converter`。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsaacProvider } from '../src/provider.ts'
import { SCENE_COORDINATES, type SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, '../python/worker.py')
const PRODUCT_ROOT = resolve(HERE, '../../..')
const ISAAC_PYTHON = join(PRODUCT_ROOT, '.runtime/conda/envs/isaac/bin/python')

/** 从 worker.py 按 AST 抽出 `glb_import_warnings` 与它的前缀常量，用合成记录跑一遍。 */
function runHelper(caughtJson: string): { ok: boolean; output?: unknown; error?: string } {
  const driver = [
    'import ast, json, sys',
    `worker = ${JSON.stringify(WORKER)}`,
    'source = open(worker, encoding="utf-8").read()',
    'tree = ast.parse(source)',
    'fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "glb_import_warnings"), None)',
    'prefix = next((n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "GLB_IMPORT_WARNING_PREFIX" for t in n.targets)), None)',
    'assert fn is not None and prefix is not None, "worker.py 里找不到 glb_import_warnings / GLB_IMPORT_WARNING_PREFIX"',
    'namespace = {}',
    'exec(compile(ast.Module(body=[prefix, fn], type_ignores=[]), worker, "exec"), namespace)',
    'class Caught:',
    '    def __init__(self, message): self.message = message',
    `caught = [Caught(m) for m in json.loads(sys.argv[1])]`,
    'print(json.dumps(namespace["glb_import_warnings"](caught), ensure_ascii=False))',
  ].join('\n')
  const run = spawnSync('python3', ['-c', driver, caughtJson], { encoding: 'utf8', timeout: 60_000 })
  if (run.status !== 0) return { ok: false, error: (run.stderr || run.stdout || '').slice(-600) }
  return { ok: true, output: JSON.parse(run.stdout.trim().split('\n').at(-1)!) }
}

const PREFIX = '[lyapunov] GLB 视觉导入: '
const report = JSON.stringify({ source: '/tmp/animated.glb', nodeIndex: null, kept: { meshes: 1, nodes: 1 }, dropped: [{ kind: 'animations', count: 1, reason: '视觉 USD 不写动画通道' }] })

describe('D4：GLB 导入回执 → WorldHandle.warnings（离线行为）', () => {
  test('带前缀的 GLB 回执原样转成 {code, message}，message 保留原始 JSON', () => {
    const result = runHelper(JSON.stringify([PREFIX + report]))
    expect(result.ok).toBe(true)
    expect(result.output).toEqual([{ code: 'GLB_IMPORT_DROPPED_CONTENT', message: report }])
  })

  test('无关告警不出现（负对照：不产生噪音）', () => {
    const result = runHelper(JSON.stringify(['某个无关的 UserWarning', 'deprecation: 别的模块']))
    expect(result.ok).toBe(true)
    expect(result.output).toEqual([])
  })

  test('多条回执按顺序全部保留', () => {
    const second = JSON.stringify({ source: '/tmp/two.glb', dropped: [{ kind: 'skins', count: 1, reason: '节点分片移除 skin' }] })
    const result = runHelper(JSON.stringify([PREFIX + report, '无关', PREFIX + second]))
    expect(result.ok).toBe(true)
    expect(result.output).toEqual([
      { code: 'GLB_IMPORT_DROPPED_CONTENT', message: report },
      { code: 'GLB_IMPORT_DROPPED_CONTENT', message: second },
    ])
  })
})

/* --------------------------------------------------------- 真实引擎（有 SDK 才跑） */

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}
/** 最小合法 glTF 2 GLB：一个 mesh + 一条 animations（与 T7 离线用例同一形状）。 */
function animatedGlb(): Buffer {
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'animated', mesh: 0 }],
    animations: [{ channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 0, output: 0, interpolation: 'LINEAR' }] }],
  }
  const json = Buffer.from(JSON.stringify(document), 'utf8')
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const binary = Buffer.alloc(36)
  const binChunk = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4, 0)])
  const chunks = Buffer.concat([u32(jsonChunk.length), u32(0x4e4f534a), jsonChunk, u32(binChunk.length), u32(0x004e4942), binChunk])
  return Buffer.concat([u32(0x46546c67), u32(2), u32(12 + chunks.length), chunks])
}

const engineRoot = mkdtempSync(join(tmpdir(), 'lyapunov-d4-engine-'))
afterAll(() => rmSync(engineRoot, { recursive: true, force: true }))

describe('D4：GLB 导入回执 → WorldHandle.warnings（真实 Isaac）', () => {
  const maybe = existsSync(ISAAC_PYTHON) ? test : test.skip
  maybe(
    `真实 Kit：含 animations 的 GLB 打开后句柄带回执（解释器 ${ISAAC_PYTHON}）`,
    async () => {
      const glb = join(engineRoot, 'animated.glb')
      writeFileSync(glb, animatedGlb())
      const provider = new IsaacProvider({
        pythonPath: ISAAC_PYTHON,
        workerPath: WORKER,
        cacheRoot: join(engineRoot, 'cache'),
        physicsDevice: 'cpu',
        rendering: 'none',
      })
      const scene: SceneSnapshot = {
        sceneId: 'd4-glb',
        revision: 0,
        coordinates: SCENE_COORDINATES,
        entities: [
          {
            entityId: 'animated-glb',
            name: 'animated-glb',
            transform: { position: [0, 0, 0.3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
            resources: [{ resourceId: 'animated-glb', version: 1, original: { uri: glb, mimeType: 'model/gltf-binary' }, representations: [], source: { units: 'm', upAxis: 'Y', handedness: 'right', metersPerUnit: 1 } }],
            components: { visual: { kind: 'mesh', visualOnly: true } },
          },
        ],
      }
      try {
        const world = await provider.open(scene, { clock: 'realtime', ground: true, worldId: 'd4-world' })
        const warnings = (world as { warnings?: Array<{ code: string; message: string; entityId?: string }> }).warnings ?? []
        // N36/ISAAC-10 起：纯视觉实体（本用例的实体正是 visualOnly）还会带一条 ENTITY_VISUAL_ONLY。
        // 两条都是真实事实，故按 code 断言，而不是把总数钉成 1。
        const glbWarnings = warnings.filter(w => w.code === 'GLB_IMPORT_DROPPED_CONTENT')
        expect(glbWarnings.length).toBe(1)
        expect(glbWarnings[0]!.message).toContain('animations')
        expect(glbWarnings[0]!.message).toContain(glb)
        expect(warnings.filter(w => w.code === 'ENTITY_VISUAL_ONLY').map(w => w.entityId)).toEqual(['animated-glb'])
        await provider.close(world.worldId)
      } finally {
        await provider.dispose().catch(() => undefined)
      }
    },
    { timeout: 300_000 },
  )
})
