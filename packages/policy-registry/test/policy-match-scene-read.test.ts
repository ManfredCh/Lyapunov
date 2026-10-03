/**
 * 回归测试：`policy_match` 读场景的**句柄契约**必须是 `SceneOperations` 的公开读法 `inspect(sceneId)`。
 *
 * 缺陷背景（N303/task-336 修复）：`policy-registry` 曾对 `ctx.get('scene').forSession(key)` 返回的
 * `SceneOperations` 直接调用 `scene.snapshot(sceneId)` —— 而 `SceneOperations` 的公开读法只有
 * `inspect(sceneId)`（`packages/scene-kit/src/operations.ts`，内部委托 `this.scene.snapshot`），
 * 于是真机上恒为 `TypeError: scene.snapshot is not a function` ⇒ `policy_match`/`policy_execute`
 * 永远到不了 `MATCHED`（任何策略都跑不起来）。
 *
 * 本测试用**桩对象**锁住契约：正例桩只有 `inspect` ⇒ 场景必须读成功（不得再出现 `SCENE_UNREADABLE`）；
 * 反例桩只有旧的 `snapshot` ⇒ 必须明确 `SCENE_UNREADABLE`（证明契约就是 `inspect`，不是 `snapshot`）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchPolicy } from '../src/match.ts'

const identity = { provider: 'github' as const, modelId: 'unitree/g1-test', revision: 'deadbeef' }
const snapshot = { sceneId: 'scene-1', revision: 3, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] }
const emptyDir = () => mkdtempSync(join(tmpdir(), 'policy-match-scene-'))

describe('policy_match 场景句柄契约（SceneOperations 公开读法 = inspect）', () => {
  test('桩只有公开读法 inspect ⇒ 场景读成功，不出现 SCENE_UNREADABLE', async () => {
    const calls: string[] = []
    const scene = { inspect: async (sceneId: string) => { calls.push(sceneId); return snapshot } }
    const result = await matchPolicy({ dataDirectory: emptyDir() }, { ...identity, sceneId: 'scene-1', entityId: 'g1' }, scene as any, undefined)
    expect(calls).toEqual(['scene-1'])
    expect(result.differences.some((d: any) => d.path === 'scene')).toBe(false)
    // 场景可读但实体不存在（空场景）⇒ 只有 entity 这一条，不是"读不到场景"
    expect(result.differences).toContainEqual({ path: 'entity', reason: 'ENTITY_NOT_FOUND', expected: 'g1' })
  })

  test('桩只有旧的 snapshot ⇒ 明确 SCENE_UNREADABLE（契约是 inspect，不是 snapshot）', async () => {
    const scene = { snapshot: async () => snapshot }
    const result = await matchPolicy({ dataDirectory: emptyDir() }, { ...identity, sceneId: 'scene-1', entityId: 'g1' }, scene as any, undefined)
    const sceneDiff = result.differences.find((d: any) => d.path === 'scene')
    expect(sceneDiff?.reason).toBe('SCENE_UNREADABLE')
    // 只接受公开读法 inspect：旧 handle 会被明确拒绝（而不是静默当成能读）
    expect(String(sceneDiff?.actual)).toContain('scene.inspect is not a function')
  })

  test('负对照：场景不存在（inspect 抛错）⇒ BLOCKED + SCENE_UNREADABLE 原因', async () => {
    const scene = { inspect: async () => { throw new Error('ENOENT: 场景不存在') } }
    const result = await matchPolicy({ dataDirectory: emptyDir() }, { ...identity, sceneId: 'missing', entityId: 'g1' }, scene as any, undefined)
    expect(result.status).toBe('BLOCKED')
    expect(result.differences.find((d: any) => d.path === 'scene')?.reason).toBe('SCENE_UNREADABLE')
  })
})
