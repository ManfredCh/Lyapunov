import type {Frame} from "../../lyapunov-contracts/src/types.ts"
import type {PreparedAdapter} from "./adapter.ts"
import type {RobotDescription} from "../../sim-contract/src/index.ts"

/** 仅对应这个固定GitHub来源；与旧82/390来源及12关节适配器独立。 */
export const G1_23_75_ID="jlog-g1-23-75-torchscript-v1"
export const G1_23_75_MODEL="jloganolson/g1_23dof_locomotion_isaac"
export const G1_23_75_REVISION="fbfa38706b817e2d4b19e444db95ae7fb2537b46"
export const G1_23_75_SHA256="1123d5348c5f7638363f7af24e5c243adedd8dcdfd2838127d388410f7b7ad47"
export const G1_23_75_BYTES=299424
export const G1_23_75_ORDER=[0,6,12,1,7,2,8,3,9,13,18,4,10,14,19,5,11,15,20,16,21,17,22]

/** 来源deploy_sim.py的75槽位；真实IMU位姿与关节反馈，按策略顺序重排。 */
export function g1Observation75(adapter:PreparedAdapter,frame:Frame,entityId:string,command:number[],previous:number[]):number[]{
 const entity=frame.entities.find(e=>e.entityId===entityId),joints=entity?.joints
 const sites=entity?.sensors?.sites as Record<string,{quaternionXyzw?:unknown}>|undefined,q=sites?.imu_in_pelvis?.quaternionXyzw
 if(!joints||!Array.isArray(q)||q.length!==4||!q.every(Number.isFinite)||Math.abs(Math.hypot(...q)-1)>1e-4)throw new Error("POLICY_OBSERVATION_UNAVAILABLE: 75适配器需要真实imu_in_pelvis世界姿态")
 const names=adapter.jointNames,indices=names.map(name=>joints.names.indexOf(name))
 if(names.length!==23||new Set(names).size!==23||joints.names.length!==23||new Set(joints.names).size!==23||indices.some(i=>i<0)||joints.positions.length!==23||joints.velocities.length!==23)throw new Error("POLICY_JOINT_SET_MISMATCH")
 if(command.length!==3||previous.length!==23||![...command,...previous].every(Number.isFinite))throw new Error("POLICY_OBSERVATION_INVALID")
 const diagnostic=entity?.sensors?.policyDiagnostics as {gravityWorldMps2?:unknown;accelerationsRadps2?:unknown;engineWarningCounts?:unknown;duplicateCollisionPlanes?:unknown}|undefined,worldGravity=diagnostic?.gravityWorldMps2
 if(!Array.isArray(diagnostic?.duplicateCollisionPlanes))throw new Error("POLICY_OBSERVATION_UNAVAILABLE: 需要真实碰撞平面诊断")
 if(diagnostic.duplicateCollisionPlanes.length)throw new Error("POLICY_DUPLICATE_GROUND: 当前世界存在重合碰撞平面；请按policy_prepare的ground设置重建世界")
 const qacc=diagnostic?.accelerationsRadps2,warnings=diagnostic?.engineWarningCounts
 if(!Array.isArray(qacc)||qacc.length!==23||!qacc.every(Number.isFinite)||!Array.isArray(warnings)||!warnings.every(v=>Number.isInteger(v)&&v===0))throw new Error("POLICY_PHYSICS_STATE_INVALID: 需要有限真实qacc和无引擎告警的帧")
 if(!Array.isArray(worldGravity)||worldGravity.length!==3||!worldGravity.every(Number.isFinite)||Math.hypot(...worldGravity)<1e-9)throw new Error("POLICY_OBSERVATION_UNAVAILABLE: 需要真实世界重力")
 const norm=Math.hypot(...worldGravity),[gx,gy,gz]=worldGravity.map(v=>v/norm),[x,y,z,w]=q as number[]
 const gravity=[(1-2*(y!*y!+z!*z!))*gx!+2*(x!*y!+w!*z!)*gy!+2*(x!*z!-w!*y!)*gz!,2*(x!*y!-w!*z!)*gx!+(1-2*(x!*x!+z!*z!))*gy!+2*(y!*z!+w!*x!)*gz!,2*(x!*z!+w!*y!)*gx!+2*(y!*z!-w!*x!)*gy!+(1-2*(x!*x!+y!*y!))*gz!]
 const positions=indices.map((j,i)=>joints.positions[j]!-adapter.config.default_angles[i]),velocities=indices.map(j=>joints.velocities[j]!)
 const order=adapter.config.policy_joint_indices as number[]
 if(order?.length!==23||new Set(order).size!==23||order.some(i=>!Number.isInteger(i)||i<0||i>=23))throw new Error("ADAPTER_CONTRACT_MISMATCH: policy_joint_indices")
 const obs=[...gravity,...command,...order.map(i=>positions[i]!),...order.map(i=>velocities[i]!),...previous]
 if(obs.length!==75||!obs.every(Number.isFinite))throw new Error("POLICY_OBSERVATION_INVALID")
 return obs
}

/** 网络动作保持策略序用于下一观测；位置目标反排到实际23关节序。 */
export function g1Targets75(adapter:PreparedAdapter,action:number[]):number[]{
 const order=adapter.config.policy_joint_indices as number[]
 if(action.length!==23||!action.every(Number.isFinite))throw new Error("POLICY_ACTION_INVALID")
 const targets=[...adapter.config.default_angles] as number[]
 for(let i=0;i<23;i++)targets[order[i]!]=targets[order[i]!]!+action[i]!*adapter.config.action_scale
 const limits=adapter.config.joint_ranges as Array<[number,number]|null>|undefined
 if(limits)for(let i=0;i<23;i++){const limit=limits[i];if(limit)targets[i]=Math.max(limit[0],Math.min(limit[1],targets[i]!))}
 return targets
}

/** 补充固定75来源的真实IMU和驱动增益匹配；不足时给具体字段，禁止推进物理。 */
export function g1MatchDifferences75(adapter:PreparedAdapter,frame:Frame|undefined,entityId:string,description:RobotDescription|undefined):Array<{path:string;reason:string;expected?:unknown;actual?:unknown}>{
 if(adapter.adapter!==G1_23_75_ID)return []
 const differences:Array<{path:string;reason:string;expected?:unknown;actual?:unknown}>=[]
 try{if(!frame)throw new Error("帧缺失");g1Observation75(adapter,frame,entityId,[0,0,0],Array(23).fill(0))}catch(error){differences.push({path:String(error).includes("POLICY_DUPLICATE_GROUND")?"world.collisionPlanes":"observations.imu_in_pelvis",reason:String(error).includes("POLICY_DUPLICATE_GROUND")?"DUPLICATE_COLLISION_PLANES":"OBSERVATION_SOURCE_MISSING",actual:String(error)})}
 for(let i=0;i<adapter.jointNames.length;i++){
  const name=adapter.jointNames[i]!,joint=description?.joints.find(j=>j.name===name)
  for(const [key,value]of [["driveStiffness",adapter.config.kps[i]],["driveDamping",adapter.config.kds[i]]] as const)if(joint?.[key]!==value)differences.push({path:`joints.${name}.${key}`,reason:"DRIVE_PD_GAIN_MISMATCH",expected:value,actual:joint?.[key]})
 }
 return differences
}
