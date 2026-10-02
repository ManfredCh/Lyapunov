import type { GraspCandidate,Quaternion,Vec3 } from '../../lyapunov-contracts/src/types.ts'
const multiply=(a:Quaternion,b:Quaternion):Quaternion=>[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]]
const rotate=(q:Quaternion,v:Vec3):Vec3=>{const p=multiply(multiply(q,[...v,0]),[-q[0],-q[1],-q[2],q[3]]);return [p[0],p[1],p[2]]}
/** 候选框架的显式刚体变换；所有抓取方法只需公共候选值，不接触SDK对象。 */
export function transformCandidate(candidate:GraspCandidate,framePose:{position:Vec3;quaternion:Quaternion},frameId:string):GraspCandidate{
 const p=rotate(framePose.quaternion,candidate.tcpPose.position)
 return {...candidate,frameId,tcpPose:{position:p.map((v,i)=>v+framePose.position[i]) as Vec3,quaternion:multiply(framePose.quaternion,candidate.tcpPose.quaternion)},approach:rotate(framePose.quaternion,candidate.approach)}
}
