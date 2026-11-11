import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, validateArgs, ToolArgsError, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import { sceneOperationsFor } from '../../scene-kit/src/plugin.ts'
import { moveTcp } from '../../robot-workflows/src/move-tcp.ts'
import type { Vec3 } from '../../lyapunov-contracts/src/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const name = 'lyapunov-teleop-capture'
export const inject = ['tools', 'commands', 'jobs', 'scene', 'subprocess']
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'capture-teleop': 'capture-teleop' } }

export const keyboardKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyX', 'KeyT', 'KeyG', 'KeyC', 'KeyV', 'KeyK']
type Scope = { worldId: string; entityId: string; expectedGeneration: number; stepCount: number }
type Input = Scope & { teleopId: string; key: string; eventTimeMs: number }
type Grip = { open: Record<string, number>; closed: Record<string, number> }
type Active = Scope & {
 id: string; owner: string; controller: AbortController; jobId: string; pending?: Promise<unknown>
 timer?: ReturnType<typeof setTimeout>; off?: () => void; finish(reason: string): Promise<void>
 gripperClosed: boolean; gripperTargets: Record<string, number>; lastEventTime?: number
}
const textField = { type: 'string', required: true } as const
const intField = { type: 'integer', required: true } as const

export function apply(ctx: Context, config: { python?: string }) {
 const active = new Map<string, Active>()
 const owned = (id: string, agent: Agent) => {
  const value = active.get(id)
  if (!value || value.owner !== agent.id) throw new Error('TELEOP_SESSION_NOT_FOUND')
  return value
 }
 const getWorld = async (sim: ReturnType<typeof simWorldsFor>, scope: Scope) => {
  const world = (await sim.listWorlds()).find(w => w.worldId === scope.worldId)
  if (!world || world.worldGeneration !== scope.expectedGeneration || world.clock !== 'manual') throw new Error('TELEOP_MANUAL_WORLD_REQUIRED')
  return world
 }
 const operations = {
  async robot_teleop_start(input: Scope, agent: Agent) {
   const python = config.python
   if (!python || !isAbsolute(python) || !existsSync(python)) throw new Error('CAPTURE_RUNTIME_UNAVAILABLE: 请配置独立 Capture 解释器')
   if (input.stepCount < 1 || input.stepCount > 250) throw new Error('TELEOP_CONTROL_STEPS_OUT_OF_RANGE')
   const sim = simWorldsFor(ctx, agent)
   const world = await getWorld(sim, input)
   const robot = await sim.describe(input.worldId, input.entityId)
   if (!robot.controlledJointNames.length || world.status !== 'ready') throw new Error('TELEOP_ROBOT_UNAVAILABLE_OR_BUSY')
   if ([...active.values()].some(s => s.owner === agent.id && s.worldId === input.worldId)) throw new Error('TELEOP_WORLD_BUSY')
   const id = randomUUID(), controller = new AbortController()
   const done = Promise.withResolvers<{ status: 'completed' | 'killed'; result: string }>()
   let finishing: Promise<void> | undefined
   const session: Active = { ...input, id, owner: agent.id, controller, jobId: '', gripperClosed: false, gripperTargets: {},
    finish(reason) {
     return finishing ??= (async () => {
      controller.abort(new Error(reason)); clearTimeout(session.timer); session.off?.()
      await session.pending?.catch(() => undefined)
      active.delete(id)
      done.resolve({ status: reason === 'TELEOP_STOPPED' ? 'completed' : 'killed', result: reason })
     })()
    },
   }
   active.set(id, session)
   try {
    session.jobId = ctx.jobs.start({ kind: 'capture-teleop', label: 'Capture 键盘遥操作', owner: agent.id,
     run: () => ({ cancel: () => { void session.finish('TELEOP_CANCELLED') }, done: done.promise }) })
    session.off = sim.subscribeFrames(input.worldId, frame => {
     if (frame.generation !== input.expectedGeneration || frame.sceneRevision !== world.appliedSceneRevision) void session.finish('TELEOP_SOURCE_CHANGED')
    })
    session.timer = setTimeout(() => void session.finish('TELEOP_INPUT_DISCONNECTED'), 30_000)
    return { teleopId: id, jobId: session.jobId, worldId: input.worldId, entityId: input.entityId, generation: input.expectedGeneration, keys: keyboardKeys }
   } catch (error) { await session.finish('TELEOP_START_FAILED'); throw error }
  },
  async robot_teleop_key(input: Input, agent: Agent, signal: AbortSignal) {
   const session = owned(input.teleopId, agent)
   session.controller.signal.throwIfAborted()
   if (session.pending) throw new Error('TELEOP_INPUT_BUSY')
   if (Math.abs(Date.now() - input.eventTimeMs) > 2000 || input.eventTimeMs <= (session.lastEventTime ?? 0)) throw new Error('TELEOP_INPUT_EXPIRED')
   session.lastEventTime = input.eventTimeMs
   clearTimeout(session.timer)
   const opSignal = AbortSignal.any([signal, session.controller.signal, AbortSignal.timeout(20_000)])
   session.pending = (async () => {
    const sim = simWorldsFor(ctx, agent)
    const world = await getWorld(sim, session)
    const snapshot = await sceneOperationsFor(ctx, agent).scene.snapshot(world.sceneId)
    if (world.appliedSceneRevision !== snapshot.revision) throw new Error('TELEOP_SOURCE_CHANGED')
    const child = ctx.subprocess.spawn({ argv: [config.python!, fileURLToPath(new URL('../python/keyboard.py', import.meta.url))], cwd: agent.session.header.cwd ?? process.cwd(), signal: opSignal, graceMs: 2000,
     stdio: { stdin: { data: JSON.stringify({ key: input.key, gripperClosed: session.gripperClosed }) }, stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } } })
    const outcome = await child.done
    opSignal.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error(`CAPTURE_RETARGET_FAILED: ${child.collected.stderr?.readFrom(0).text ?? ''}`)
    const output = JSON.parse(child.collected.stdout?.readFrom(0).text.trim().split('\n').at(-1) ?? '') as { delta: number[]; gripperClosed: boolean }
    const actionId = `capture-${randomUUID()}`
    const motion = { worldId: session.worldId, robotId: session.entityId, expectedGeneration: session.expectedGeneration, actionId }
    const evidence = { worldId: session.worldId, generation: session.expectedGeneration, entityId: session.entityId, actionId, input: { key: input.key, eventTimeMs: input.eventTimeMs }, retargeted: output }
    if (input.key === 'KeyK') {
     const mapping = snapshot.entities.find(e => e.entityId === session.entityId)?.components.controller?.teleopGripper as Grip | undefined
     const grip = mapping?.[output.gripperClosed ? 'closed' : 'open']
     const names = (await sim.describe(session.worldId, session.entityId)).controlledJointNames
     if (!grip || !Object.keys(grip).length || Object.entries(grip).some(([joint, value]) => !names.includes(joint) || !Number.isFinite(value))) throw new Error('TELEOP_GRIPPER_POSITION_MAPPING_REQUIRED')
     const frame = await sim.observe(session.worldId, { entityIds: [session.entityId] })
     const joints = frame.entities.find(e => e.entityId === session.entityId)?.joints
     const positions = names.map(name => grip[name] ?? joints?.positions[joints.names.indexOf(name)])
     if (!positions.every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('JOINT_OBSERVATION_MISSING')
     const receipt = await sim.execute(session.worldId, { actionId, expectedGeneration: session.expectedGeneration, kind: 'control', entityId: session.entityId, jointNames: names, positions: positions as number[], stepCount: session.stepCount }, opSignal)
     if (receipt.status === 'completed') { session.gripperClosed = output.gripperClosed; session.gripperTargets = { ...grip } }
     return { ...evidence, status: receipt.status, receipts: [receipt] }
    }
    const result = await moveTcp(sim, snapshot, { ...motion, deltaM: output.delta.slice(0, 3) as Vec3 }, async (request, planningSignal) => {
     const response = await ctx.tools.execute({ name: 'motion_plan', arguments: { request_json: JSON.stringify(request) }, callId: ToolCallId(`${actionId}:plan`), agent, signal: planningSignal ?? opSignal })
     if (response.isError) throw new Error(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
     const value = response.value as { result?: string }
     return typeof value.result === 'string' ? JSON.parse(value.result) : value
    }, opSignal, { stepCount: session.stepCount, rotationVector: output.delta.slice(3) as Vec3, gripperTargets: session.gripperTargets })
    return { ...result, ...evidence, receipts: [result.action] }
   })()
   try { return await session.pending }
   finally {
    session.pending = undefined
    if (!session.controller.signal.aborted) session.timer = setTimeout(() => void session.finish('TELEOP_INPUT_DISCONNECTED'), 30_000)
   }
  },
  async robot_teleop_inspect(input: Pick<Input, 'teleopId'>, agent: Agent) {
   const s = owned(input.teleopId, agent)
   return { teleopId: s.id, jobId: s.jobId, worldId: s.worldId, entityId: s.entityId, generation: s.expectedGeneration, busy: Boolean(s.pending) }
  },
  async robot_teleop_stop(input: Pick<Input, 'teleopId'>, agent: Agent) {
   await owned(input.teleopId, agent).finish('TELEOP_STOPPED')
   return { teleopId: input.teleopId, status: 'stopped' }
  },
 }
 const parameters = {
  robot_teleop_start: { worldId: textField, entityId: textField, expectedGeneration: intField, stepCount: intField },
  robot_teleop_key: { teleopId: textField, key: { ...textField, enum: keyboardKeys }, eventTimeMs: intField },
  robot_teleop_inspect: { teleopId: textField }, robot_teleop_stop: { teleopId: textField },
 }
 const descriptions = {
  robot_teleop_start: 'Start Capture keyboard control in an existing ready manual world.',
  robot_teleop_key: 'Apply one fresh Capture keyboard event. eventTimeMs is the current Unix epoch in milliseconds.',
  robot_teleop_inspect: 'Read the scope and in-flight state of a Capture keyboard session.',
  robot_teleop_stop: 'End the Capture keyboard session and cancel its in-flight action.',
 }
 for (const name of Object.keys(operations) as (keyof typeof operations)[]) {
  const schema: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: parameters[name] } }
  const invoke = (input: unknown, agent: Agent | undefined, signal: AbortSignal) => {
   const errors = validateArgs(schema, { input })
   if (errors.length) throw new ToolArgsError(errors)
   if (!agent) throw new Error('TELEOP_AGENT_REQUIRED')
   return operations[name](input as Input, agent, signal)
  }
  ctx.tools.register(defineTool({ name, description: descriptions[name], parameters: schema, output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute: async (args, exec) => await invoke(args.input, exec.agent, exec.signal) as JsonValue }))
  ctx.commands.register({ name, description: descriptions[name], input: { hint: 'Capture keyboard JSON' }, async handler(invocation) {
   try { return { kind: 'success', text: JSON.stringify(await invoke(JSON.parse(invocation.rawInput), invocation.agent, invocation.signal)) } }
   catch (error) { return { kind: 'error', text: String(error) } }
  } })
 }
 ctx.effect(() => async () => { await Promise.all([...active.values()].map(s => s.finish('TELEOP_HOST_DISPOSED'))) })
}
