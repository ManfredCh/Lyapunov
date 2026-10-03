/**
 * N190／DEV-034：投影落盘（投影 → 会话场景命名空间内的 scene 文档）三条钉子。
 * 证据边界：本文件用**真 fs 临时目录** + 既有 `SceneStore` 读取路径，不启动官方 SDK、不起宿主。
 * 2026-09-26（W24／DEV-027）：模块与测试随 g17 探针撞名整改一并改名（理由见 src/scene-projection.ts 头注）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneStore } from '@lyapunov/scene-kit'
import { persistProjectedScene, namespaceSceneId } from '../src/scene-projection.ts'

const dirs: string[] = []
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'n190-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const scene = (sceneId: string, revision = 3) => ({
  sceneId, revision,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities: [
    { entityId: 'basket_1', name: 'basket_1', transform: { position: [0.01483511, 0.25211826, -0.00477295], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: {} },
    { entityId: 'alphabet_soup_1', name: 'alphabet_soup_1', transform: { position: [-0.11905544, -0.23977768, 0.04611156], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: {} },
  ],
})

describe('N190 投影落盘：投影 → scene 文档', () => {
  test('①经既有读取路径读回同一快照（sceneId/revision/entityCount 一致）', async () => {
    const root = scratch()
    const session = 'session-n204'
    const result = await persistProjectedScene({ sceneDataRoot: root, sessionId: session }, scene('official-n190'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entityCount).toBe(2)
    // N204：场景按会话落在 <worlds>/sessions/<sessionId>/scenes/（与 scene-kit layout.worlds 的会话目录一致）
    expect(result.path).toBe(join(root, 'sessions', session, 'scenes', 'official-n190.json'))
    // 既有读取路径：SceneStore.snapshot()（不是我们自己的读法）
    const read = await new SceneStore(join(root, 'sessions', session)).snapshot('official-n190')
    expect(read.sceneId).toBe('official-n190')
    expect(read.revision).toBe(3)
    expect(read.entities.length).toBe(2)
    expect(JSON.stringify(read.entities)).toBe(JSON.stringify(scene('official-n190').entities))
    // 历史版本也按既有 store 落盘（.history/<id>/revision-3.json）
    const versions = await new SceneStore(join(root, 'sessions', session)).versions('official-n190')
    expect(versions.some(v => v.revision === 3)).toBe(true)
  })

  test('②sceneDataRoot 缺失 ⇒ 明确报未配置、不静默、不落盘', async () => {
    const result = await persistProjectedScene({ sessionId: 'session-n204' }, scene('official-n190-missing'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('BENCHMARK_SCENE_DATA_ROOT_UNSET')
    expect(result.error).toContain('BENCHMARK_SCENE_DATA_ROOT_UNSET')
  })

  test('②′sessionId 缺失 ⇒ 明确报未配置、不静默、不落盘（N204 新增）', async () => {
    const root = scratch()
    const result = await persistProjectedScene({ sceneDataRoot: root }, scene('official-n190-nosession'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('BENCHMARK_SCENE_SESSION_UNSET')
    expect(result.error).toContain('BENCHMARK_SCENE_SESSION_UNSET')
  })

  test('③落盘失败不静默（root 指向不可写路径）', async () => {
    const file = join(scratch(), 'not-a-dir')
    writeFileSync(file, 'x')
    const result = await persistProjectedScene({ sceneDataRoot: join(file, 'scenes'), sessionId: 'session-n204' }, scene('official-n190-fail'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('BENCHMARK_SCENE_WRITE_FAILED')
    expect(result.error.length).toBeGreaterThan(0)
  })

  // N221：真机暴露——官方 sceneId 带 `/`（`libero_object/pick_up_the_alphabet_soup_and_place_it_in_the_basket`），
  // scene-kit `safeId` 契约不允许 ⇒ 投影层在**落盘前**确定性映射，并把落盘 id 一并回执。
  test('④官方 id 带 `/` ⇒ 映射成命名空间合法 id 并真的落盘（N221 新增）', async () => {
    const root = scratch()
    const session = 'session-n221'
    const official = 'libero_object/pick_up_the_alphabet_soup_and_place_it_in_the_basket'
    const result = await persistProjectedScene({ sceneDataRoot: root, sessionId: session }, scene(official))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sceneId).toBe('libero_object-pick_up_the_alphabet_soup_and_place_it_in_the_basket')
    expect(result.path).toBe(join(root, 'sessions', session, 'scenes', `${result.sceneId}.json`))
    expect(result.entityCount).toBe(2)
    // 既有读取路径按落盘 id 读回（证明不是只改回执）
    const read = await new SceneStore(join(root, 'sessions', session)).snapshot(result.sceneId)
    expect(read.sceneId).toBe(result.sceneId)
    expect(read.entities.length).toBe(2)
  })

  test('④′已合法的 id 映射恒等（不改变既有行为）', async () => {
    const root = scratch()
    const result = await persistProjectedScene({ sceneDataRoot: root, sessionId: 'session-n221b' }, scene('official-n221'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sceneId).toBe('official-n221')
    expect(result.path).toBe(join(root, 'sessions', 'session-n221b', 'scenes', 'official-n221.json'))
  })

  test('④″namespaceSceneId：折叠非法字符/去头/截断；全非法 ⇒ 空（调用方按投影非法报）', () => {
    expect(namespaceSceneId('a/b c')).toBe('a-b-c')
    expect(namespaceSceneId('/lead')).toBe('lead')
    expect(namespaceSceneId('///')).toBe('')
    expect(namespaceSceneId('x'.repeat(200)).length).toBe(160)
  })
})

test('真实 worker 的世界句柄与可见投影使用同一 sceneId', () => {
 const worker=new URL('../python/worker.py',import.meta.url).pathname
 const code=`
import ast,json,pathlib,types
module=ast.parse(pathlib.Path(${JSON.stringify(worker)}).read_text())
method=next(m for c in module.body if isinstance(c,ast.ClassDef) for m in c.body if isinstance(m,ast.FunctionDef) and m.name=='handle')
subset=ast.Module(body=[method],type_ignores=[]);ns={};exec(compile(ast.fix_missing_locations(subset),'worker-handle','exec'),ns)
w=types.SimpleNamespace(episode_id='w',scene={'sceneId':'suite/task'},task=types.SimpleNamespace(name='task'),projection={'scene':{'sceneId':'suite-task'}},scene_revision=1,status='ready',timestep=.05)
projected=ns['handle'](w);w.projection=None;fallback=ns['handle'](w)
print(json.dumps({'projected':projected['sceneId'],'fallback':fallback['sceneId']}))
`
 const result=Bun.spawnSync([process.env.TESTCI_PYTHON??'python3','-c',code])
 expect(result.exitCode).toBe(0)
 expect(JSON.parse(result.stdout.toString())).toEqual({projected:'suite-task',fallback:'suite/task'})
})
