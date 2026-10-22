/**
 * `sim_task_check` 工具/命令面端到端：真插件 + 真 ToolRegistry/CommandRuntime，
 * sim/scene 两个替身按各自契约给出确定读数（替身不是被测对象）。
 * 断言执行序：schema 校验 → 谓词形状校验 → 世界/代次 → spec 门 → 帧级评估。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as taskCheck from '../src/plugin.ts'
import { writeProposal, recordVerify, promoteSkill } from '../../policy-registry/src/skill-library.ts'
import { SCENE_COORDINATES, identityTransform, type EntityObservation, type Frame, type SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const WORLD_ID = 'w-1'
const SCENE_ID = 'scene-1'

const observed = (entities: EntityObservation[], extra: Partial<Frame> = {}): Frame =>
  ({ worldId: WORLD_ID, generation: 2, stepIndex: 4, simTime: 0.4, frameId: `${WORLD_ID}:2:4`, entities, ...extra })
const cube = (x: number): EntityObservation => ({ entityId: 'cube', transform: { position: [x, 0, 0.03], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } })

const snapshot: SceneSnapshot = {
  sceneId: SCENE_ID, revision: 1, coordinates: SCENE_COORDINATES,
  entities: [{ entityId: 'cube', name: 'cube', transform: identityTransform(), resources: [], components: {} }],
}

let frame: Frame = observed([cube(0.03)])
const simStub = {
  listWorlds: async () => [{ worldId: WORLD_ID, sceneId: SCENE_ID, engineId: 'stub', engineVersion: '0', worldGeneration: 2, appliedSceneRevision: 1, status: 'ready' }],
  describe: async () => { throw new Error('describe 未被本用例使用') },
  observe: async () => frame,
  execute: async () => { throw new Error('execute 未被本用例使用') },
  receipt: async () => { throw new Error('receipt 未被本用例使用') },
  stop: async () => ({ stopped: true, stepIndex: 4, receipts: [] }),
  subscribeFrames: () => () => undefined,
  close: async () => undefined,
  assist: async () => { throw new Error('assist 未被本用例使用') },
  capture: async () => { throw new Error('capture 未被本用例使用') },
  captureMulti: async () => { throw new Error('captureMulti 未被本用例使用') },
  listCameras: async () => { throw new Error('listCameras 未被本用例使用') },
  adjustCamera: async () => { throw new Error('adjustCamera 未被本用例使用') },
  projectAnnotation: async () => { throw new Error('projectAnnotation 未被本用例使用') },
  exportCameraDataset: async () => { throw new Error('exportCameraDataset 未被本用例使用') },
  dispose: async () => undefined,
}
const sceneStub = { forSession: () => ({ scene: { snapshot: async () => snapshot } }) }

let ctx: Context, agent: Awaited<ReturnType<Awaited<ReturnType<typeof mountAgentLoopTestHarness>>['create']>>, fiber: { dispose(): Promise<void> }, packsDir: string

beforeEach(async () => {
  packsDir = mkdtempSync(join(tmpdir(), 'sim-task-check-packs-'))
  frame = observed([cube(0.03)])
  ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(LocalJobRegistry)
  ctx.reflect.provide('scene', sceneStub as never)
  ctx.reflect.provide('sim', { forSession: () => simStub, dispose: async () => undefined } as never)
  fiber = await ctx.plugin(taskCheck, { packsDirectory: packsDir }) as { dispose(): Promise<void> }
  const loop = await mountAgentLoopTestHarness(ctx)
  agent = await loop.create(SessionId(`sim-task-check-${Math.trunc(Date.now() % 1e9)}`), {})
})

afterEach(async () => {
  await fiber.dispose().catch(() => undefined)
  await ctx.fiber.dispose().catch(() => undefined)
  rmSync(packsDir, { recursive: true, force: true })
})

const inBox = { kind: 'entity-in-box', entityId: 'cube', center: [0, 0, 0.03], halfExtents: [0.1, 0.1, 0.1] }

async function callTool(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await ctx.tools.execute({ callId: ToolCallId(`stc-${Math.random().toString(36).slice(2)}`), name: 'sim_task_check', arguments: args, signal: new AbortController().signal, agent })
  return { isError: result.isError === true, text: (result.content ?? []).map((block: any) => block.text ?? '').join('') }
}

async function callCommand(rawInput: string): Promise<{ kind: string; text: string }> {
  const execution = await ctx.commands.execute(agent, `/sim_task_check ${rawInput}`, [], new AbortController().signal)
  if (!execution) throw new Error('命令没有解析成功：/sim_task_check')
  return execution.result as { kind: string; text: string }
}

describe('sim_task_check 工具/命令面', () => {
  test('缺必填与非法谓词：两条面同一处结构化拒绝', async () => {
    const missing = await callTool({ input: {} })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('invalid arguments: missing required property "input.worldId"')
    const badExpr = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: { kind: 'wish' } } })
    expect(badExpr.isError).toBe(true)
    expect(badExpr.text).toContain('TASK_CHECK_PREDICATE_INVALID')
    expect(badExpr.text).toContain('kind 未知')
    const command = await callCommand(JSON.stringify({ worldId: WORLD_ID, expectedGeneration: 2, predicates: { kind: 'wish' } }))
    expect(command.kind).toBe('error')
    expect(command.text).toContain('TASK_CHECK_PREDICATE_INVALID')
  })

  test('世界缺失与代次不符各自具名拒绝', async () => {
    const noWorld = await callTool({ input: { worldId: 'w-other', expectedGeneration: 2, predicates: inBox } })
    expect(noWorld.text).toContain('TASK_CHECK_WORLD_REQUIRED')
    const stale = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 1, predicates: inBox } })
    expect(stale.text).toContain('TASK_CHECK_STALE_GENERATION')
  })

  test('真值路径：谓词成立与失败都返回 TaskCheckResult 完整字段', async () => {
    const pass = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: inBox } })
    expect(pass.isError).toBe(false)
    const passValue = JSON.parse(pass.text)
    expect(passValue).toMatchObject({ taskAchieved: true, evaluated: true, failed: [], frameId: `${WORLD_ID}:2:4`, stepIndex: 4 })

    frame = observed([cube(0.5)])
    const fail = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: inBox } })
    const failValue = JSON.parse(fail.text)
    expect(failValue.taskAchieved).toBe(false)
    expect(failValue.failed[0].reasonCode).toBe('POSE_OUTSIDE_BOX')

    const command = await callCommand(JSON.stringify({ worldId: WORLD_ID, expectedGeneration: 2, predicates: inBox }))
    expect(command.kind).toBe('success')
    expect((JSON.parse(command.text)).taskAchieved).toBe(false)
  })

  test('spec 门：场景声明里缺席的实体被 SPEC_ENTITY_MISSING 拦截且不推进评估', async () => {
    const ghost = { kind: 'entity-in-box', entityId: 'ghost', center: [0, 0, 0], halfExtents: [1, 1, 1] }
    const result = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: ghost } })
    const value = JSON.parse(result.text)
    expect(value.rejectedBy).toBe('SPEC_ENTITY_MISSING')
    expect(value.evaluated).toBe(false)

    // checkSpec:false 显式关门后走帧级评估：同一缺席如实报 ENTITY_MISSING（evaluated=true）。
    const open = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: ghost, checkSpec: false } })
    const openValue = JSON.parse(open.text)
    expect(openValue.rejectedBy).toBeUndefined()
    expect(openValue.evaluated).toBe(true)
    expect(openValue.failed[0].reasonCode).toBe('ENTITY_MISSING')
  })

  test('L1 谓词下沉：单步 robot_move 携带 predicates 时自动将写死 false 的回执升级为真实谓词判定', async () => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    ctx.tools.register(defineTool({
      name: 'robot_move',
      description: 'stub robot_move returning legacy taskAchieved:false',
      parameters: { input: { type: 'json', required: true, description: 'input' } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async () => ({ actionId: 'act-1', status: 'completed', generation: 2, startStep: 0, endStep: 4, taskAchieved: false }),
    }))
    // 1) 谓词满足：taskAchieved 从 false 升为 true
    const passRes = await ctx.tools.execute({
      callId: ToolCallId('m-pass'), name: 'robot_move',
      arguments: { input: { worldId: WORLD_ID, action: { expectedGeneration: 2 }, predicates: inBox } },
      signal: new AbortController().signal, agent,
    })
    expect((passRes.value as any).taskAchieved).toBe(true)
    expect((passRes.value as any).taskCheck.evaluated).toBe(true)

    // 2) 谓词不满足：taskAchieved=false 且附带具名 reasonCode
    frame = observed([cube(0.5)])
    const failRes = await ctx.tools.execute({
      callId: ToolCallId('m-fail'), name: 'robot_move',
      arguments: { input: { worldId: WORLD_ID, action: { expectedGeneration: 2 }, predicates: inBox } },
      signal: new AbortController().signal, agent,
    })
    expect((failRes.value as any).taskAchieved).toBe(false)
    expect((failRes.value as any).reason).toBe('POSE_OUTSIDE_BOX')
    expect((failRes.value as any).taskCheck.failed[0].reasonCode).toBe('POSE_OUTSIDE_BOX')
  })

  test('故障自动召回技能：谓词失败时按 reasonCode 自动从 packs/<id>/skills/ 附带已准入修复技能', async () => {
    mkdirSync(join(packsDir, 'franka_panda'), { recursive: true })
    await writeProposal(packsDir, {
      skillId: 'recenter-before-drop',
      packId: 'franka_panda',
      failureSignature: { reasonCodes: ['POSE_OUTSIDE_BOX'], description: '放置位姿偏移出界' },
      applicableWhen: { robotKinds: ['arm'], description: '桌面放置' },
      fixStrategy: '下放前将末端 X/Y 对齐托盘中心再松爪',
      program: [{ tool: 'sim_task_check', input: { predicates: inBox } }],
      devEvidence: { runIds: ['run-dev-1'], checkedAt: '2026-10-22T00:00:00.000Z' },
    })
    await recordVerify(packsDir, 'recenter-before-drop', { verifierRunId: 'run-ver-1', reproducedTaskIds: ['t1'], attempts: 1, passed: true }, 'franka_panda')
    await promoteSkill(packsDir, 'recenter-before-drop', 'franka_panda')

    frame = observed([cube(0.5)])
    const res = await callTool({ input: { worldId: WORLD_ID, expectedGeneration: 2, predicates: inBox } })
    const value = JSON.parse(res.text)
    expect(value.taskAchieved).toBe(false)
    expect(value.matchedSkills).toEqual([{
      packId: 'franka_panda',
      skillId: 'recenter-before-drop',
      fixStrategy: '下放前将末端 X/Y 对齐托盘中心再松爪',
      reasonCodes: ['POSE_OUTSIDE_BOX'],
    }])
  })
})
