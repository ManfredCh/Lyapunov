import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '../../scene-kit/src/plugin.ts'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import { transferCargo, type CargoTransferInput } from './cargo-transfer.ts'
import { worldScene } from './world-scene.ts'
import { workflowPresentationMeta } from './workflow-evidence.ts'
const string = (description: string, required = false) => ({ type: 'string' as const, description, ...(required ? { required: true as const } : {}) })
const xy = { type: 'array' as const, items: { type: 'number' as const }, description: "XY coordinates in meters." }
const parameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: {
 worldId: string("Current actual worldId.", true), expectedGeneration: { type: 'integer', required: true }, vehicleId: string("entityId of the ordinary cargo-carrying robot.", true), cargoId: string("entityId of cargo with fork_pockets geometry.", true), supportId: string("entityId of a support with cargo_shelf geometry.", true),
 levelId: string("Optional real support-layer ID."), slotId: string("Optional semantic-slot ID declared by the asset."),
 supportAssignments: { type: 'array', description: "Optional vehicle-to-support assignments for the current task. The existing geometric algorithm uses them to determine shared-rack passages; no global Registry is created.", items: { type: 'object', additionalProperties: false, properties: { vehicleId: string("Vehicle entity.", true), supportId: string("Support entity.", true) } } },
 bounds: { type: 'object', additionalProperties: false, properties: { min: { ...xy, required: true }, max: { ...xy, required: true } } },
 obstacles: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: string("Obstacle ID.", true), center: { ...xy, required: true }, radiusM: { type: 'number', required: true } } } },
 speedMps: { type: 'number', description: "Navigation speed limit in m/s; contact phases have a separate slower limit." }, carryClearanceM: { type: 'number', description: "Target cargo-bottom clearance above the ground, in meters." }, minimumLiftM: { type: 'number', description: "Minimum measured lifting displacement required by the task, in meters." }, placementToleranceM: { type: 'number', description: "Tolerance between the actual cargo center and the semantic-slot target, in meters." }, maxDurationS: { type: 'number', description: "Physical-time limit for the complete workflow, at most 300 seconds." }, actionPrefix: string("Optional action-ID prefix for this invocation."),
} } }
export function applyCargoTransfer(ctx: Context) {
 const run = async (input: CargoTransferInput, signal: AbortSignal, agent?: unknown) => {
  // 世界服务按执行这次调用的会话取（缺会话明确失败），不读别人的世界表。
  const sim = simWorldsFor(ctx, agent)
  const world = (await sim.listWorlds()).find(w => w.worldId === input.worldId)
  if (!world) throw new Error('WORLD_NOT_FOUND')
  // 官方world的Scene只由该活动的只读投影拥有；普通Scene仍读SceneStore。
  return transferCargo(sim, (await worldScene(ctx, sim, world, agent)).snapshot, input, signal)
 }
 const description = "Perform the physical workflow for cargo that is not already loaded. Use asset loadCarrier sites, fork_pockets, and cargo_shelf/semantic-slot geometry to align, insert, lift, transport, place, and withdraw the forks. Only fresh engine sites, contacts, displacement, and velocity determine success. Do not attach or write poses; on failure, perform only bounded safe withdrawal. The existing preloaded cargo interface remains available."
 // 摘要保留 stops/afterSource/observationError：模型必须看出停止是否未确认、after 是否为本次最后实际观测（last-known 时如实标注）。
 ctx.tools.register(defineTool({ name: 'robot_cargo_transfer', description, parameters, output: { schema: { type: 'json' }, render: (_args, result: any) => [{ type: 'text', text: JSON.stringify({ status: result.status, taskAchieved: result.taskAchieved, reason: result.reason, failedPhase: result.failedPhase, recovery: result.recovery, afterSource: result.afterSource, observationError: result.observationError, stops: result.stops, effect: result.effect, source: result.source, phases: result.phases?.map((p: any) => ({ phase: p.phase, frameId: p.frameId, stepIndex: p.stepIndex })), actions: { count: result.actions?.length ?? 0, first: result.actions?.[0]?.actionId, last: result.actions?.at(-1)?.actionId } }) }], presentationMeta: workflowPresentationMeta }, execute: async (args, execution) => JSON.parse(JSON.stringify(await run(args.input as unknown as CargoTransferInput, execution.signal, execution.agent))) }))
 ctx.commands.register({ name: 'robot_cargo_transfer', description, input: { hint: "CargoTransferInput JSON; specify the entities and semantic support." }, handler: async invocation => {
  try { const result = await run(JSON.parse(invocation.rawInput), invocation.signal, invocation.agent); return { kind: result.taskAchieved ? 'success' : 'error', text: JSON.stringify(result) } }
  catch (error) { return { kind: 'error', text: String(error) } }
 } })
}
