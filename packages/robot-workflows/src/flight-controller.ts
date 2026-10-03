import type { EntityObservation } from '../../lyapunov-contracts/src/types.ts'
import type { NativeBodyWrenchDescription } from '../../sim-contract/src/index.ts'
export type FlightVec3 = [number,number,number]
export interface FlightState { positionM:FlightVec3;quaternionXyzw:[number,number,number,number];velocityWorldMps:FlightVec3;omegaBodyRadps:FlightVec3 }
export interface FlightTarget { positionM:FlightVec3;yawRad:number }
export const CRAZYFLIE_SOURCE_SHA256='c1260dd47cded49edd5c1c02226529a5452a73f70000515f83bf223814037933'
export const CRAZYFLIE_FLIGHT_PROFILE='crazyflie-2-native-pid-v1'
const finite=(v:unknown,n:number):v is number[]=>Array.isArray(v)&&v.length===n&&v.every(x=>typeof x==='number'&&Number.isFinite(x))
export function flightState(observed:EntityObservation):FlightState {
  const base=observed.sensors?.freeBase as Record<string,unknown>|undefined
  if(!base||!finite(base.positionM,3)||!finite(base.quaternionXyzw,4)||!finite(base.linearVelocityWorldMps,3)||!finite(base.angularVelocityLocalRadps,3))throw new Error('FLIGHT_OBSERVATION_REQUIRED: 需要当前自由根的真实位置/姿态/世界线速度/机体角速度')
  const norm=Math.hypot(...base.quaternionXyzw)
  if(Math.abs(norm-1)>1e-5)throw new Error('FLIGHT_INVALID_QUATERNION')
  return {positionM:base.positionM as FlightVec3,quaternionXyzw:base.quaternionXyzw as [number,number,number,number],velocityWorldMps:base.linearVelocityWorldMps as FlightVec3,omegaBodyRadps:base.angularVelocityLocalRadps as FlightVec3}
}
export function assertFlightProfile(mapping:NativeBodyWrenchDescription|undefined){
  if(!mapping?.available)throw new Error('FLIGHT_MAPPING_UNAVAILABLE: '+(mapping&&!mapping.available?mapping.reason:'引擎没有实际 compiled wrench 读回'))
  if(mapping.sourceSha256!==CRAZYFLIE_SOURCE_SHA256)throw new Error('FLIGHT_PROFILE_UNVERIFIED: 目前只接受已核固定 Crazyflie2 原件，不把其它 drone 声明当已验证飞控')
  if(mapping.frame!=='body-root'||mapping.massKg<=0||!Number.isFinite(mapping.massKg)||mapping.actuators.join('/')!=='body_thrust/x_moment/y_moment/z_moment')throw new Error('FLIGHT_PROFILE_MISMATCH')
  if(!finite(mapping.gravityWorldMps2,3)||Math.abs(mapping.gravityWorldMps2[0])>1e-9||Math.abs(mapping.gravityWorldMps2[1])>1e-9||Math.abs(mapping.gravityWorldMps2[2]+9.81)>1e-9)throw new Error('FLIGHT_GRAVITY_PROFILE_UNVERIFIED')
  const expected=[[0,0,0,0],[0,0,0,0],[1,0,0,0],[0,-1e-5,0,0],[0,0,-1e-5,0],[0,0,0,-1e-5]]
  if(mapping.matrix.length!==6||mapping.matrix.some((row,i)=>!finite(row,4)||row.some((x,j)=>Math.abs(x-expected[i]![j]!)>1e-12)))throw new Error('FLIGHT_MAPPING_MISMATCH: 固定模型的实际 SI 映射不同')
  return mapping
}
function cross(a:FlightVec3,b:FlightVec3):FlightVec3{return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
const dot=(a:FlightVec3,b:FlightVec3)=>a.reduce((sum,v,i)=>sum+v*b[i]!,0)
const normalized=(v:FlightVec3):FlightVec3=>{const n=Math.hypot(...v);if(n<1e-10)throw new Error('FLIGHT_DEGENERATE_TARGET');return v.map(x=>x/n) as FlightVec3}
const clamp=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,v))
export function bodyRotation(q:FlightState['quaternionXyzw']):number[][]{
  const [x,y,z,w]=q
  return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]]
}
export function yawOf(q:FlightState['quaternionXyzw']){return Math.atan2(2*(q[3]*q[2]+q[0]*q[1]),1-2*(q[1]*q[1]+q[2]*q[2]))}
export function angleError(a:number,b:number){return Math.atan2(Math.sin(a-b),Math.cos(a-b))}
/** 有界级联位置/姿态 PD，只输出源预算内的机体 SI wrench。四通道是合力/合矩，不是电机 RPM。 */
export function flightControl(state:FlightState,target:FlightTarget,mapping:Extract<NativeBodyWrenchDescription,{available:true}>,integralZ=0){
  if(!finite(target.positionM,3)||!Number.isFinite(target.yawRad))throw new Error('FLIGHT_INVALID_TARGET')
  const error=target.positionM.map((v,i)=>v-state.positionM[i]!) as FlightVec3
  if(!Number.isFinite(integralZ)||Math.abs(integralZ)>.800001)throw new Error('FLIGHT_INVALID_INTEGRAL')
  const acceleration:FlightVec3=[.8*error[0]-1.8*state.velocityWorldMps[0],.8*error[1]-1.8*state.velocityWorldMps[1],4*error[2]-3*state.velocityWorldMps[2]+9.81+1.5*integralZ]
  acceleration[2]=clamp(acceleration[2],6,12)
  const horizontal=Math.hypot(acceleration[0],acceleration[1]),horizontalMax=Math.tan(.20)*acceleration[2]
  if(horizontal>horizontalMax){acceleration[0]*=horizontalMax/horizontal;acceleration[1]*=horizontalMax/horizontal}
  const b3=normalized(acceleration),b2=normalized(cross(b3,[Math.cos(target.yawRad),Math.sin(target.yawRad),0])),b1=cross(b2,b3)
  const rd=[[b1[0],b2[0],b3[0]],[b1[1],b2[1],b3[1]],[b1[2],b2[2],b3[2]]]
  const rotation=bodyRotation(state.quaternionXyzw),rtd=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>rotation.reduce((sum,row,k)=>sum+row[i]!*rd[k]![j]!,0)))
  // vee(Rd^T R - R^T Rd)/2 = 实际姿态相对于期望的误差。
  const attitude:FlightVec3=[(rtd[1]![2]!-rtd[2]![1]!)/2,(rtd[2]![0]!-rtd[0]![2]!)/2,(rtd[0]![1]!-rtd[1]![0]!)/2]
  const zBody:FlightVec3=[rotation[0]![2]!,rotation[1]![2]!,rotation[2]![2]!]
  const limits=mapping.limits.map(limit=>{
    if(!limit.ctrlrange||!finite(limit.ctrlrange,2)||!Number.isFinite(limit.gain)||limit.gain===0)throw new Error('FLIGHT_LIMITS_REQUIRED')
    let [lo,hi]=limit.ctrlrange
    if(limit.forcerange){const forceControls=limit.forcerange.map(x=>x/limit.gain);lo=Math.max(lo,Math.min(...forceControls));hi=Math.min(hi,Math.max(...forceControls))}
    if(lo>hi)throw new Error('FLIGHT_LIMITS_EMPTY')
    return [lo,hi]
  })
  const thrustN=clamp(mapping.massKg*dot(acceleration,zBody),Math.max(0,limits[0]![0]!),limits[0]![1]!)
  const torqueNm=attitude.map((e,i)=>{
    const requested=-.00020*e-.00008*state.omegaBodyRadps[i]!
    const controls=limits[i+1]!.map(x=>x*mapping.matrix[i+3]![i+1]!)
    const value=clamp(requested,Math.min(...controls),Math.max(...controls));return value===0?0:value
  }) as FlightVec3
  return {thrustN,torqueNm,errorM:Math.hypot(...error),yawErrorRad:angleError(target.yawRad,yawOf(state.quaternionXyzw)),tiltRad:Math.acos(clamp(zBody[2],-1,1)),attitudeError:attitude}
}
