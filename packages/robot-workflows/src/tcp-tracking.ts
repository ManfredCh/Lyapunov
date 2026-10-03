import type { Vec3 } from '../../lyapunov-contracts/src/types.ts'

/** 请求1mm→0.1mm容差、5mm→0.5mm、20mm及以上→1mm；容差始终小于请求幅度。 */
export function tcpArrival(requested: Vec3, measured: Vec3) {
  const requestedDistanceM = Math.hypot(...requested)
  const toleranceM = Math.min(.001, requestedDistanceM * .1)
  const targetErrorM = Math.hypot(...measured.map((value, index) => value - requested[index]!))
  const progressM = measured.reduce((sum, value, index) => sum + value * requested[index]!, 0) / requestedDistanceM
  const lateralErrorM = Math.sqrt(Math.max(0, measured.reduce((sum, value) => sum + value * value, 0) - progressM * progressM))
  const directionMatches = progressM > 0
  return { requestedDistanceM, toleranceM, targetErrorM, progressM, lateralErrorM, directionMatches, reached: directionMatches && targetErrorM <= toleranceM && lateralErrorM <= toleranceM }
}
