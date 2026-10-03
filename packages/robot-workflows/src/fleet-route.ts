import { planFleetNavigation, resolveFleetSteeredDockingRoute } from './fleet/fleet-navigation.ts'
import { FleetTrafficManager, type FleetTrajectoryProposal } from './fleet/fleet-traffic-manager.ts'
export type FleetRouteInput =
  | { kind: 'path'; request: Parameters<typeof planFleetNavigation>[0] }
  | { kind: 'steered-docking'; request: Parameters<typeof resolveFleetSteeredDockingRoute>[0] }
  | { kind: 'head-on'; simulationTimeMs: number; proposals: FleetTrajectoryProposal[] }
/** 原有路线/弧线与对向协商纯算法入口。结果须显式交给有界执行，不写模拟状态。 */
export function planFleetRoute(input: FleetRouteInput) {
  if (input.kind === 'path') return { execution: 'not-started', taskAchieved: false, route: planFleetNavigation(input.request) }
  if (input.kind === 'steered-docking') return { execution: 'not-started', taskAchieved: false, route: resolveFleetSteeredDockingRoute(input.request) }
  if (input.kind === 'head-on') {
    if (!Number.isFinite(input.simulationTimeMs) || !input.proposals.length) throw new Error('INVALID_ARGUMENT: 物理时间与路线提案不能为空')
    const traffic = new FleetTrafficManager(() => input.simulationTimeMs)
    return { execution: 'not-started', taskAchieved: false, decisions: input.proposals.map(p => traffic.propose(p)), routes: traffic.snapshot() }
  }
  throw new Error('INVALID_ARGUMENT: 未知路线类型')
}
