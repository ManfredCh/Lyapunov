import type { Context } from '@deepseek-ai/cordis'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import { defineTool, validateArgs, ToolArgsError, type ToolExecution, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import type { RobotDescription } from '../../sim-contract/src/index.ts'
import { applyRecording, type RecordingConfig } from './recording-plugin.ts'
import { applyCargoTransfer } from './cargo-transfer-plugin.ts'
import { applyFleet } from './fleet-plugin.ts'
import { assertWorkflowArguments, pick, place, robotPickParameters, robotPlaceParameters, type Planner, type PickInput, type PlaceInput } from './pick-place.ts'
import { actionSummary, frameSource, workflowPresentationMeta } from './workflow-evidence.ts'
import { sceneOperationsFor } from '../../scene-kit/src/plugin.ts'
import { moveTcp, type TcpMoveInput } from './move-tcp.ts'
import { applyFlight } from './flight-tools.ts'
export const name = 'lyapunov-robot-workflows'
export const inject = ['tools', 'commands', 'jobs', 'scene']
/**
 * 夹爪自己的关节集：优先 provider 自报的 gripper 能力（`capabilities[kind=gripper].jointNames`），
 * 回退到资产映射 `controller.gripper.jointNames`（MuJoCo provider 只产出后者）。两处都是既有读数。
 * 手臂相位的 IK 关节集要减掉这个集合：夹爪相位按 `widthM` 走资产映射，不由手臂轨迹顺带驱动夹爪关节。
 */
function gripperJointsOf(description: RobotDescription): Set<string> {
  const declared = (description.capabilities ?? []).filter(capability => capability.kind === 'gripper' && capability.available).flatMap(capability => capability.jointNames ?? [])
  if (declared.length) return new Set(declared)
  const mapping = (description.controller as { gripper?: { jointNames?: unknown } } | undefined)?.gripper?.jointNames
  return new Set(Array.isArray(mapping) ? mapping.filter((n): n is string => typeof n === 'string') : [])
}
/** 组合只消费当前Profile注册的 motion_plan，不依赖 Mink 或其他Provider私有实现。 */
export function apply(ctx: Context, config: RecordingConfig = {}) {
  applyRecording(ctx, config)
  applyFleet(ctx)
  applyFlight(ctx)
  applyCargoTransfer(ctx)
  const tcpParameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: {
    worldId: { type: 'string', required: true }, robotId: { type: 'string', required: true },
    expectedGeneration: { type: 'integer', required: true, description: "Current generation reported by sim_open/robot_describe." },
    deltaM: { type: 'array', items: { type: 'number' }, required: true, description: "Relative end-effector displacement in world coordinates, in meters, right-handed Z-up. For a 5-centimeter descent, use [0,0,-0.05]." },
    durationS: { type: 'number', description: "From 0 to 5 seconds; defaults to 1 second." }, actionId: { type: 'string' },
  } } }
  const tcpDescription = "Move the arm end effector by a small relative Cartesian displacement. An arm descent must use this tool or a real IK joint trajectory, never scene_edit to move the robot root. First open a real world for the current Scene. Start from the real site or body-local TCP declared by controller.tcp and same-frame joint observations; call the existing motion_plan then sim.execute and read back measured end-effector displacement. deltaM uses meters: descend 5 centimeters with [0,0,-0.05]. If the TCP mapping is missing, select a real end effector with robot_set_tcp or the robot sidebar. Missing observations or an IK solution produce one explicit error; do not download a policy or claim arrival."
  const tcpPerform = async (input: TcpMoveInput, parent: Partial<ToolExecution>, signal?: AbortSignal) => {
    const errors = validateArgs(tcpParameters, { input })
    if (errors.length) throw new ToolArgsError(errors)
    signal ??= new AbortController().signal
    const sim = simWorldsFor(ctx, parent.agent)
    const world = (await sim.listWorlds()).find(w => w.worldId === input.worldId)
    if (!world) throw new Error('WORLD_REQUIRED: 先为当前Scene调用sim_open，再传worldId和worldGeneration')
    const snapshot = await sceneOperationsFor(ctx, parent.agent).scene.snapshot(world.sceneId)
    return moveTcp(sim, snapshot, input, async (request, planningSignal) => {
      const response = await ctx.tools.execute({ name: 'motion_plan', arguments: { request_json: JSON.stringify(request) }, callId: ToolCallId(`${parent.callId ?? input.actionId ?? 'tcp'}:motion:${Date.now()}`), rootCallId: parent.rootCallId ?? parent.callId, parent: parent.token, agent: parent.agent, signal: planningSignal ?? signal })
      if (response.isError) throw new Error(response.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
      const value = response.value as { result?: string }
      return typeof value.result === 'string' ? JSON.parse(value.result) : value
    }, signal)
  }
  ctx.tools.register(compatibleToolInput(defineTool({ name: 'robot_move_tcp', description: tcpDescription, parameters: tcpParameters, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => await tcpPerform(args.input as unknown as TcpMoveInput, exec, exec.signal) as any })))
  ctx.commands.register({ name: 'robot_move_tcp', description: tcpDescription, input: { hint: 'worldId/robotId/expectedGeneration/deltaM JSON' }, handler: async invocation => {
    try { return { kind: 'success', text: JSON.stringify(await tcpPerform(JSON.parse(invocation.rawInput), { agent: invocation.agent }, invocation.signal)) } }
    catch (error) { return { kind: 'error', text: String(error) } }
  } })
  const perform = async (name: 'robot_pick' | 'robot_place', input: any, signal: AbortSignal, parent?: ToolExecution) => {
    // 入参守卫先于任何世界访问（命令面与工具面同一处）：缺必填或形状不对时给结构化拒绝，
    // 不再让原生 TypeError 从 `input.candidate.tcpPose` / planner 的 `input.planning.jointNames`
    // 这些解引用点漏进回执（真机原文见 bugfixHistory/TOOL-ARGS-VALIDATION-20260923.md）。
    assertWorkflowArguments(name, input)
    // 世界服务按**执行本次调用的会话**取：没有可核实会话就明确失败，不落到别人的世界。
    const sim = simWorldsFor(ctx, parent?.agent)
    let counter = 0
    const planner: Planner = async request => {
      const description = await sim.describe(request.worldId, request.entityId)
      const observed = request.start.entities.find(e => e.entityId === request.entityId)!.joints!
      // 手臂相位只规划**非夹爪**关节（手臂轨迹里的夹爪列会被 provider 每 tick 当成位置目标写进 ctrl，
      // 从而覆盖夹爪动作建立的夹持力）：排掉夹爪关节后轨迹只是受控关节的**子集**，
      // 由 executePose 带 `partialJointVector:true` 显式声明（未列出的关节保持上一次 ctrl）。
      const gripperJointNames = gripperJointsOf(description)
      const requestedJointNames = (input.planning.jointNames ?? description.controlledJointNames) as string[]
      const jointNames = requestedJointNames.filter(n => !gripperJointNames.has(n))
      // IK 起点必须落在关节真实 range 内：实测值可能越界（合爪后实测 finger_joint1=−0.0066），直接下发会让
      // 计划的首个路点越界；无 range（无界关节）的关节不钳。
      const jointRanges = new Map(description.joints.map(joint => [joint.name, joint.range]))
      const startPositionOf = (n: string) => {
        const value = observed.positions[observed.names.indexOf(n)]
        const range = jointRanges.get(n)
        return range && typeof value === 'number' ? Math.min(range[1], Math.max(range[0], value)) : value
      }
      const requestInput = { ...input.planning, targetPose: request.targetPose, entityId: request.entityId, jointNames, startPositions: jointNames.map(startPositionOf), modelVersion: description.modelVersion, collisionContextVersion: description.collisionContextVersion, expectedGeneration: request.start.generation }
      const result = await ctx.tools.execute({ name: 'motion_plan', arguments: { request_json: JSON.stringify(requestInput) }, callId: ToolCallId(`${parent?.callId ?? input.actionPrefix ?? name}:motion:${++counter}`), rootCallId: parent?.rootCallId ?? parent?.callId, parent: parent?.token, agent: parent?.agent, signal })
      if (result.isError) throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
      const value = result.value as any
      const parsed = typeof value.result === 'string' ? JSON.parse(value.result) : value
      if (!parsed.plan) throw new Error('MOTION_NO_SOLUTION')
      return parsed.plan
    }
    return name === 'robot_pick' ? pick(sim, planner, input as PickInput, signal) : place(sim, planner, input as PlaceInput, signal)
  }
  for (const operation of ['robot_pick', 'robot_place'] as const) {
    const description = operation === 'robot_pick' ? "Perform one bounded contact grasp using existing candidates and the current motion_plan: complete trajectory, close, then lift and hold. Determine taskAchieved from actual object displacement/support. Input includes PickInput and the planning model/TCP configuration." : "Perform one bounded placement using the existing motion_plan: descend, release the gripper, then withdraw. Actual support height and velocity determine success."
    // 模型只看摘要（状态/执行模式/效果/来源帧/停止确认/观察来源/动作清单）；逐条回执证据经原生 presentationMeta 持久化在会话日志，供录制消费。
    // stop/afterSource/observationError 是本轮真实小字段：模型必须能看出 after 是上次观测还是新观测、停止是否未确认，不能只见 after 帧。
    ctx.tools.register(defineTool({ name: operation, description, parameters: operation === 'robot_pick' ? robotPickParameters : robotPlaceParameters, output: { schema: { type: 'json' }, render: (_args, value: any) => [{ type: 'text', text: JSON.stringify({ status: value.status, taskAchieved: value.taskAchieved, executionMode: value.executionMode, reason: value.reason, candidateId: value.candidate?.candidateId, effect: value.effect, before: frameSource(value.before), after: frameSource(value.after), afterSource: value.afterSource, observationError: value.observationError, stop: value.stop, actions: actionSummary(value.actions) }) }], presentationMeta: workflowPresentationMeta }, execute: async (args, exec) => JSON.parse(JSON.stringify(await perform(operation, args.input, exec.signal, exec))) }))
    ctx.commands.register({ name: operation, description, input: { hint: "Workflow arguments as JSON." }, handler: async invocation => {
      try { return { kind: 'success', text: JSON.stringify(await perform(operation, JSON.parse(invocation.rawInput), invocation.signal, { agent: invocation.agent } as ToolExecution)) } }
      catch (e) { return { kind: 'error', text: String(e) } }
    } })
  }
}
