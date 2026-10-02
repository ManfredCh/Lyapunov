import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import { runFleet, type FleetRunInput } from './fleet-run.ts'
import { planFleetRoute, type FleetRouteInput } from './fleet-route.ts'
import { workflowPresentationMeta } from './workflow-evidence.ts'
const num = { type: 'number' } as const
const xy = { type: 'array', items: num, description: "Two coordinates [x,y] in meters, in the right-handed Z-up frame." } as const
const xyz = { type: 'array', items: num, description: "Three coordinates [x,y,z] in meters." } as const
const required = <T extends object>(value: T) => ({ ...value, required: true as const })
export const fleetRunParameters: ParameterSchemaSpec = { input: { type: 'object', required: true, additionalProperties: false, properties: {
  worldId: required({ type: 'string' }), expectedGeneration: required({ type: 'integer', description: "Actual worldGeneration at invocation; never rewrite it to a newer generation." }),
  assignments: required({ type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    assignmentId: required({ type: 'string' }), entityId: required({ type: 'string' }), goal: required(xy), priority: num, dependsOn: { type: 'array', items: { type: 'string' }, description: "Prerequisite assignmentId values. Release them only after actual task completion, including cargo withdrawal." },
    route: { type: 'object', additionalProperties: false, properties: { points: required({ type: 'array', items: xy }), goalYawRad: num, curvatureQualifiedPath: { type: 'boolean' } }, description: "Optional route derived by robot_fleet_route; it must match the current start and goal." },
    cargo: { type: 'object', additionalProperties: false, description: "Optional physical cargo transport. The cargo is already on the forks; do not attach or place it automatically.", properties: {
      cargoId: required({ type: 'string' }), carryLiftM: required(num), releaseLiftM: required(num), minimumLiftM: required(num), expectedPlacement: required(xyz), placementToleranceM: required(num), withdrawDurationS: required(num), withdrawSpeedMps: required(num),
    } },
  } } }),
  bounds: required({ type: 'object', additionalProperties: false, properties: { min: required(xy), max: required(xy) } }),
  obstacles: required({ type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: required({ type: 'string' }), center: required(xy), radiusM: required(num) } } }),
  trafficMode: { type: 'string', enum: ['serialized','head-on'], description: "head-on connects existing negotiated oncoming curved paths to physical execution by two vehicles. It accepts only two assignments executed together. The default serialized mode retains yielding at crossing corridors." },
  clearanceM: required(num), speedMps: required(num), maxDurationS: required({ type: 'number', description: "Actual physical-time limit, at most 300s; exceeding it fails the task." }), toleranceM: num, actionPrefix: { type: 'string' },
} } }
export function applyFleet(ctx: Context) {
  const run = (input: FleetRunInput, signal: AbortSignal, agent?: unknown) => runFleet(simWorldsFor(ctx, agent), input, signal)
  const description = "Perform one bounded multi-robot assignment in the same MuJoCo/Isaac world, starting the batch on the same tick. By default, vehicles physically stop and yield at crossing corridors; trafficMode=head-on executes previously negotiated curved-path cooperation. Cargo lifting, navigation, placement, and withdrawal may be included. Determine taskAchieved from actual poses and contacts. No Fleet registration is required and no custom Agent loop is started."
  // 摘要保留 stops/afterSource/observationError：模型必须看出停止是否未确认、after 是否为本次新观测，不能只见帧来源。
  ctx.tools.register(defineTool({ name: 'robot_fleet_run', description, parameters: fleetRunParameters, output: { schema: { type: 'json' }, render: (_args, value: any) => [{ type: 'text', text: JSON.stringify({ status: value.status, taskAchieved: value.taskAchieved, reason: value.reason, worldId: value.before?.worldId, generation: value.before?.generation, afterSource: value.afterSource, observationError: value.observationError, stops: value.stops, assignments: value.assignments, events: value.events, actionIds: value.actions?.map((a: any) => a.actionId) }) }], presentationMeta: workflowPresentationMeta }, execute: async (args, exec) => JSON.parse(JSON.stringify(await run(args.input as unknown as FleetRunInput, exec.signal, exec.agent))) }))
  ctx.commands.register({ name: 'robot_fleet_run', description, input: { hint: 'FleetRunInput JSON' }, handler: async invocation => {
    try { const result = await run(JSON.parse(invocation.rawInput), invocation.signal, invocation.agent); return { kind: result.taskAchieved ? 'success' : 'error', text: JSON.stringify(result) } }
    catch (error) { return { kind: 'error', text: String(error) } }
  } })
  const routeDescription = "Use the existing pure algorithms for navigation, nonholonomic curved paths, and oncoming traffic negotiation. kind=path/steered-docking/head-on. The result explicitly reports no execution and cannot count as physical success. To execute, pass trafficMode=head-on and both vehicles' explicit assignments/routes to robot_fleet_run."
  ctx.tools.register(defineTool({ name: 'robot_fleet_route', description: routeDescription, parameters: { input: { type: 'json', required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: args => JSON.parse(JSON.stringify(planFleetRoute(args.input as unknown as FleetRouteInput))) }))
  ctx.commands.register({ name: 'robot_fleet_route', description: routeDescription, input: { hint: 'FleetRouteInput JSON' }, handler: invocation => {
    try { return { kind: 'success', text: JSON.stringify(planFleetRoute(JSON.parse(invocation.rawInput))) } } catch (error) { return { kind: 'error', text: String(error) } }
  } })
}
