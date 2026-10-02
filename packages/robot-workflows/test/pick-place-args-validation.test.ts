/**
 * L384：`robot_pick` / `robot_place` 的入参缺必填不再漏原生 TypeError——两层同一条判据：
 *   1. 模型可见 `parameters`（`pick-place.ts` 的 `robotPickParameters`/`robotPlaceParameters`）：
 *      `defineTool` 的 execute 包装在派发时强制（上游 `core/tools/src/schema.ts:566-568,585-589`）；
 *   2. `assertWorkflowArguments`（`perform` 第一步，命令面与 operation 面共用）：同一份 spec 走框架
 *      的 `validateArgs`，所以命令面与工具面错误文本/错误码逐字相同；再补 JSON Schema 表达不了的
 *      值语义（三个位置分量/四个四元数分量的长度）。
 *
 * 修前读数（真机与本地探针一致，见 `bugfixHistory/TOOL-ARGS-VALIDATION-20260923.md`）：
 * `robot_pick` 缺 `planning` 时 planner 直接读 `input.planning.jointNames` ⇒
 * `TypeError: … reading 'jointNames'`（真机 `docs/VERIFICATION_LEDGER.md:2032` 第②步原文）；
 * 本文件用真插件 + 真 ToolRegistry/CommandRuntime 复现并断言它已被结构化拒绝。
 *
 * 两个替身是**测试夹具**（按真 Provider 契约给出一个活动世界与一份确定性计划），不是被测对象。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as workflows from '../src/plugin.ts'
import { tcpArrival } from '../src/tcp-tracking.ts'
import { moveTcp } from '../src/move-tcp.ts'
import { SCENE_COORDINATES, identityTransform, type Frame, type SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { SimAction, SimWorlds } from '../../sim-contract/src/index.ts'

const WORLD_ID = 'w-1'
let mode: 'pick' | 'place' = 'pick'
let observes = 0

const simStub = {
  listWorlds: async () => [],
  observe: async (id: unknown) => {
    // 真机读数：空参时 worker 收到的请求少了 worldId（`SimError: 'worldId'`，见回执引用）。
    if (typeof id !== 'string' || id === '') throw new Error("SimError: 'worldId'")
    observes += 1
    const z = mode === 'pick' && observes >= 2 ? 0.13 : 0.03
    return {
      worldId: WORLD_ID, generation: 1, stepIndex: observes, simTime: observes * 0.1, sceneRevision: 1,
      frameId: `${WORLD_ID}:1:${observes}`, executionMode: 'physical-contact',
      entities: [
        { entityId: 'robot-1', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, joints: { names: ['j1'], positions: [0] }, components: {} },
        { entityId: 'obj-1', transform: { position: [0.5, 0, z], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, joints: { names: [], positions: [] }, sensors: mode === 'place' ? { bodyLinearVelocityMps: [0, 0, 0] } : {}, components: {} },
      ],
      contacts: mode === 'pick' ? [{ geom1: 'robot-1/gripper', geom2: 'obj-1/body' }] : [{ geom1: '__ground/floor', geom2: 'obj-1/body' }],
    }
  },
  describe: async () => ({ entityId: 'robot-1', modelVersion: 'mv-1', collisionContextVersion: 'ccv-1', controlledJointNames: ['j1'], joints: [{ name: 'j1', range: [-1, 1] }], capabilities: [] }),
  execute: async (id: string, action: { actionId: string }) => ({ actionId: action.actionId, worldId: id, generation: 1, status: 'completed', effect: { executionMode: 'physical-contact', motions: [{ kind: 'gripper', targetReached: true }] } }),
  receipt: async () => { throw new Error('receipt 未被本用例使用') },
  stop: async () => ({ stopped: true, stepIndex: observes, receipts: [], affectedEntityIds: ['robot-1'] }),
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

const pickLegal = {
  worldId: WORLD_ID, robotId: 'robot-1', objectId: 'obj-1',
  candidate: { candidateId: 'cand-1', provider: 'analytic', entityId: 'obj-1', frameId: `${WORLD_ID}:1:0`, tcpPose: { position: [0.5, 0, 0.03], quaternion: [0, 0, 0, 1] }, widthM: 0.03, approach: [0, 0, -1], score: 1, scoreKind: 'analytic' },
  approachDistanceM: 0.1, liftHeightM: 0.1, minimumLiftM: 0.05, holdTimeS: 0.2, openWidthM: 0.08, closeWidthM: 0.03,
}
const placeLegal = {
  worldId: WORLD_ID, robotId: 'robot-1', objectId: 'obj-1',
  targetPose: { position: [0.5, 0, 0.03], quaternion: [0, 0, 0, 1] },
  openWidthM: 0.08, expectedSupportZ: 0.03, supportToleranceM: 0.01, stableSpeedMps: 0.05, holdTimeS: 0.2, retreatM: 0.05,
}
const planning = { modelPath: 'materials/robot/panda.xml', tcp: { body: 'hand' } }

let ctx: Context, agent: Awaited<ReturnType<Awaited<ReturnType<typeof mountAgentLoopTestHarness>>['create']>>, fiber: { dispose(): Promise<void> }

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  await ctx.plugin(LocalJobRegistry)
  ctx.reflect.provide('scene', { snapshot: async () => { throw new Error('SCENE_NOT_USED_IN_THIS_TEST') } } as never)
  ctx.reflect.provide('sim', { forSession: () => simStub, dispose: async () => undefined } as never)
  ctx.tools.register(defineTool({
    name: 'motion_plan', description: '测试夹具：确定性返回与本次代次一致的计划。',
    parameters: { request_json: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value: any) => [{ type: 'text', text: String(value.result) }] },
    execute: async () => ({ result: JSON.stringify({ plan: { jointNames: ['j1'], points: [[0]], expectedGeneration: 1 } }) }),
  }))
  fiber = await ctx.plugin(workflows, {}) as { dispose(): Promise<void> }
  const loop = await mountAgentLoopTestHarness(ctx)
  agent = await loop.create(SessionId(`lane384-pick-place-args-${Math.trunc(Date.now() % 1e9)}`), {})
})

afterEach(async () => {
  await fiber.dispose().catch(() => undefined)
  await ctx.fiber.dispose().catch(() => undefined)
})

async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  mode = name === 'robot_place' ? 'place' : 'pick'
  observes = 0
  const result = await ctx.tools.execute({ callId: ToolCallId(`lane384-${name}`), name, arguments: args, signal: new AbortController().signal, agent })
  return { isError: result.isError === true, text: (result.content ?? []).map((block: any) => block.text ?? '').join('') }
}

async function callCommand(name: string, rawInput: string): Promise<{ kind: string; text: string }> {
  mode = name === 'robot_place' ? 'place' : 'pick'
  observes = 0
  const execution = await ctx.commands.execute(agent, `/${name} ${rawInput}`, [], new AbortController().signal)
  if (!execution) throw new Error(`命令没有解析成功：/${name}`)
  return execution.result as { kind: string; text: string }
}

describe('L384 robot_pick / robot_place：缺必填 ⇒ 结构化拒绝（两条面同一条判据）', () => {
  test('robot_pick/robot_place 空 input：列出全部缺失字段，且不再漏原生 TypeError', async () => {
    const pick = await callTool('robot_pick', { input: {} })
    expect(pick.isError).toBe(true)
    expect(pick.text).toContain('invalid arguments: missing required property "input.worldId"')
    expect(pick.text).toContain('missing required property "input.candidate"')
    expect(pick.text).toContain('missing required property "input.planning"')
    expect(pick.text).not.toContain('is not an object')
    expect(pick.text).not.toContain('/')

    const place = await callTool('robot_place', { input: {} })
    expect(place.isError).toBe(true)
    expect(place.text).toContain('missing required property "input.targetPose"')
    expect(place.text).toContain('missing required property "input.planning"')
    expect(place.text).not.toContain('is not an object')

    // 连 input 都没给：工具面 schema（外层 required）照旧先挡，本次没动它。
    expect((await callTool('robot_pick', {})).text).toContain('invalid arguments: missing required property "input"')
    expect((await callTool('robot_place', {})).text).toContain('invalid arguments: missing required property "input"')
  })

  test('缺 planning（真机第②步的形态）：工具面与命令面逐字同形，不再抛 reading jointNames', async () => {
    const tool = await callTool('robot_pick', { input: { ...pickLegal } })
    expect(tool.isError).toBe(true)
    const message = tool.text.replace(/^Error: /, '')
    expect(message).toBe('invalid arguments: missing required property "input.planning"')
    expect(message).not.toContain('jointNames')
    expect(message).not.toContain('/')

    const command = await callCommand('robot_pick', JSON.stringify(pickLegal))
    expect(command.kind).toBe('error')
    expect(command.text).toBe(`ToolArgsError: ${message}`)

    // place 同一条（planner 是共用的）。
    expect((await callTool('robot_place', { input: { ...placeLegal } })).text).toBe('Error: ' + message.replace('robot_pick', 'robot_place').replace('input.planning', 'input.planning'))
    const placeCommand = await callCommand('robot_place', JSON.stringify(placeLegal))
    expect(placeCommand.kind).toBe('error')
    expect(placeCommand.text).toContain('missing required property "input.planning"')
  })

  test('planning 缺 modelPath/tcp（真机 KeyError modelPath 的形态）在 schema 层被拒', async () => {
    const pick = await callTool('robot_pick', { input: { ...pickLegal, planning: {} } })
    expect(pick.isError).toBe(true)
    expect(pick.text).toBe('Error: invalid arguments: missing required property "input.planning.modelPath"; missing required property "input.planning.tcp"')
    const command = await callCommand('robot_pick', JSON.stringify({ ...pickLegal, planning: {} }))
    expect(command.kind).toBe('error')
    expect(command.text).toContain('missing required property "input.planning.modelPath"')
  })

  test('值语义那一层：位置不是三元组/四元数不是四元数 ⇒ ROBOT_ARGS_INVALID（schema 表达不了长度）', async () => {
    const badPick = await callTool('robot_pick', { input: { ...pickLegal, candidate: { ...pickLegal.candidate, tcpPose: { position: [0.5, 0], quaternion: [0, 0, 0, 1] }, approach: [0, 0] }, planning } })
    expect(badPick.isError).toBe(true)
    expect(badPick.text).toContain('ROBOT_ARGS_INVALID')
    expect(badPick.text).toContain('candidate.tcpPose.position')
    expect(badPick.text).toContain('candidate.approach')
    expect(badPick.text).not.toContain('is not an object')
    expect(badPick.text).not.toContain('/')

    const badPlace = await callTool('robot_place', { input: { ...placeLegal, targetPose: { position: [0.5, 0, 0.03], quaternion: [0, 0, 1] }, planning } })
    expect(badPlace.isError).toBe(true)
    expect(badPlace.text).toContain('ROBOT_ARGS_INVALID')
    expect(badPlace.text).toContain('targetPose.quaternion')

    const command = await callCommand('robot_pick', JSON.stringify({ ...pickLegal, candidate: { ...pickLegal.candidate, approach: [0, 0] }, planning }))
    expect(command.kind).toBe('error')
    expect(command.text).toContain('ROBOT_ARGS_INVALID')
    expect(command.text).toContain('candidate.approach')
    // 类型不对先由 schema 判（同一条 spec），值语义再由上一条守卫判。
    const typed = await callCommand('robot_pick', JSON.stringify({ ...pickLegal, candidate: { ...pickLegal.candidate, approach: 'down' }, planning }))
    expect(typed.kind).toBe('error')
    expect(typed.text).toBe('ToolArgsError: invalid arguments: "input.candidate.approach" must be an array')
  })

  test('正例：全必填（含 planning.modelPath/tcp）工具面与命令面各自完成，行为与修前逐字相同', async () => {
    const tool = await callTool('robot_pick', { input: { ...pickLegal, planning } })
    expect(tool.isError).toBe(false)
    const toolValue = JSON.parse(tool.text) as { status: string; taskAchieved: boolean; executionMode: string; reason?: string }
    expect(toolValue.status).toBe('completed')
    expect(toolValue.taskAchieved).toBe(true)
    expect(toolValue.executionMode).toBe('physical-contact')
    expect(toolValue.reason).toBeUndefined()

    const command = await callCommand('robot_pick', JSON.stringify({ ...pickLegal, planning }))
    expect(command.kind).toBe('success')
    expect((JSON.parse(command.text) as { taskAchieved: boolean }).taskAchieved).toBe(true)

    const placed = await callTool('robot_place', { input: { ...placeLegal, planning } })
    expect(placed.isError).toBe(false)
    const placeValue = JSON.parse(placed.text) as { status: string; taskAchieved: boolean }
    expect(placeValue.status).toBe('completed')
    expect(placeValue.taskAchieved).toBe(true)

    const placeCommand = await callCommand('robot_place', JSON.stringify({ ...placeLegal, planning }))
    expect(placeCommand.kind).toBe('success')
    expect((JSON.parse(placeCommand.text) as { taskAchieved: boolean }).taskAchieved).toBe(true)
  })
})


// ee5b768 的实际Panda反向5mm回执：IK收敛不等于物理末端到达。
describe('末端小步的实测方向与幅度判据', () => {
  test('5mm上升却向下1.827mm不能被1cm旧容差判成功', () => {
    const actual = tcpArrival([0, 0, .005], [.0012634390183868804, -.00004436594815217446, -.0018274500134481952])
    expect(actual.toleranceM).toBe(.0005)
    expect(actual.targetErrorM).toBeCloseTo(.006943509211967077, 12)
    expect(actual.directionMatches).toBe(false)
    expect(actual.reached).toBe(false)
  })
  test('真实lift rig的20mm升降实测值保持通过', () => {
    expect(tcpArrival([0, 0, .02], [0, 0, .01958761998002001]).reached).toBe(true)
    expect(tcpArrival([0, 0, -.02], [0, 0, -.02037241998001993]).reached).toBe(true)
  })
  test('堵住未位移或只有横向滑动，方向正但幅度不足仍未达到', () => {
    expect(tcpArrival([0, 0, .005], [0, 0, 0]).reached).toBe(false)
    expect(tcpArrival([0, 0, .005], [.002, 0, .005]).reached).toBe(false)
    expect(tcpArrival([0, 0, .001], [0, 0, .00085]).reached).toBe(false)
    expect(tcpArrival([0, 0, .001], [0, 0, .00095]).reached).toBe(true)
  })
})

// 接口夹具仅核回执字段的范围：原计划检查不能替经过补偿后的轨迹背书，不签原生物理。
describe('末端反馈后的碰撞检查来源', () => {
  for (const corrected of [false, true]) test(corrected ? 'planner=true但第二轮非零bias改变轨迹，collisionChecked=false' : '零bias原轨迹保留planner真实collisionChecked=true', async () => {
    const snapshot: SceneSnapshot = { sceneId: 'tcp-check', revision: 1, coordinates: SCENE_COORDINATES, entities: [{ entityId: 'arm', name: 'arm', transform: identityTransform(), resources: [], components: { mujoco: { sourcePath: 'fixture.xml' }, controller: { tcp: { body: 'hand', offsetM: [0, 0, 0] } } } }] }
    const executed: SimAction[] = []
    let plans = 0
    const fakeFrame = (): Frame => {
      const position = executed.length === 0 ? 0 : corrected && executed.length === 1 ? .002 : .005
      return { worldId: 'tcp-world', generation: 1, stepIndex: executed.length * 10, simTime: executed.length * .1, sceneRevision: 1, frameId: `tcp-world:1:${executed.length * 10}`, executionMode: 'physical-contact', contacts: [], entities: [{ entityId: 'arm', transform: identityTransform(), joints: { names: ['slide'], positions: [position], velocities: [0] }, sensors: { tcp: { bodyName: 'hand', positionM: [0, 0, position], quaternionXyzw: [0, 0, 0, 1] } } }] }
    }
    const sim = {
      listWorlds: async () => [{ worldId: 'tcp-world', sceneId: snapshot.sceneId, worldGeneration: 1, appliedSceneRevision: 1, status: 'ready' }],
      describe: async () => ({ entityId: 'arm', modelVersion: 'fixture.xml', expectedGeneration: 1, collisionContextVersion: '1', controlledJointNames: ['slide'], joints: [{ name: 'slide', type: 'slide', unit: 'm', range: [0, 1], controlMode: 'position' }] }),
      observe: async () => fakeFrame(),
      execute: async (_worldId: string, action: SimAction) => { executed.push(action); return { actionId: action.actionId, status: 'completed', startStep: executed.length * 10 - 9, endStep: executed.length * 10 } },
      stop: async () => ({ stopped: true, stepIndex: executed.length * 10, receipts: [] }),
    } as unknown as SimWorlds
    const result = await moveTcp(sim, snapshot, { worldId: 'tcp-world', robotId: 'arm', expectedGeneration: 1, deltaM: [0, 0, .005], durationS: .1 }, async request => ({ collisionChecked: true, plan: { planId: `checked-plan-${++plans}`, entityId: 'arm', modelVersion: 'fixture.xml', collisionContextVersion: '1', expectedGeneration: 1, jointNames: ['slide'], points: [{ timeS: 0, positions: request.startPositions as number[] }, { timeS: .1, positions: [.005] }] } }))
    expect(result.taskAchieved).toBe(true)
    expect(result.collisionChecked).toBe(!corrected)
    expect(executed).toHaveLength(corrected ? 2 : 1)
    expect(snapshot.entities[0]!.transform).toEqual(identityTransform())
    if (corrected) {
      const second = executed[1]!
      expect(second.kind).toBe('trajectory')
      if (second.kind !== 'trajectory') throw new Error('夹具未收到第二次轨迹')
      expect(second.points.at(-1)!.positions[0]).toBeCloseTo(.008, 12)
      expect(result.tracking.attempts[1]!.maxJointBias).toBeGreaterThan(0)
    }
  })
})
