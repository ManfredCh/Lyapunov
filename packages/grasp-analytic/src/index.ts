import type { GraspCandidate, Vec3 } from '../../lyapunov-contracts/src/types.ts'
/** 几何轴对齐盒的确定性平行夹爪候选；不代表学习模型推理。 */
export function proposeAnalytic(input: { entityId: string; frameId: string; centerM: Vec3; sizeM: Vec3; maxWidthM: number }): GraspCandidate[] {
  if (![...input.centerM, ...input.sizeM, input.maxWidthM].every(Number.isFinite) || input.sizeM.some(v => v <= 0) || input.maxWidthM <= 0) throw new Error('INVALID_GEOMETRY')
  const candidates: GraspCandidate[] = []
  for (const axis of [0,1] as const) {
    const width = input.sizeM[axis] + .008
    if (width > input.maxWidthM) continue
    const quaternion: [number,number,number,number] = axis === 0 ? [Math.SQRT1_2, Math.SQRT1_2, 0, 0] : [1,0,0,0]
    candidates.push({candidateId:`analytic-top-${axis}`,provider:'analytic',entityId:input.entityId,frameId:input.frameId,tcpPose:{position:[...input.centerM],quaternion},widthM:width,approach:[0,0,-1],score:1-width/input.maxWidthM,scoreKind:'analytic-width-margin'})
  }
  return filterCandidates(candidates).sort((a,b)=>b.score-a.score)
}

/** 开发者可修改的候选筛选；由正常解析候选入口复用，可独立回滚。 */
export function filterCandidates(candidates: GraspCandidate[]): GraspCandidate[] {
  return candidates.filter(candidate => candidate.score >= 0)
}
