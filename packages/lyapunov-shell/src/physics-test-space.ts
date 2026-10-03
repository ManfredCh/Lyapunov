import type { SceneSnapshot,WorldHandle,Frame } from '../../lyapunov-contracts/src/types.ts'
import type {RobotDescription} from '../../sim-contract/src/index.ts'
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const items=(value:unknown):unknown[]=>value===undefined?[]:Array.isArray(value)?value:[value]
/** 导入器已按原件展开 include；只读同一 MJCF 的实际根，不按名称或策略登记猜能力。 */
export function uncontrolledFreeRootEntityIds(scene:SceneSnapshot|undefined):string[]{
 return scene?.entities.filter(entity=>{
  const native=record(entity.components.mujoco),robot=record(entity.components.visual?.robot)
  if(robot.format!=='mjcf'||!entity.components.mujoco&&!entity.components.isaac)return false
  const document=record(robot.document),bodies=items(document.worldbody).flatMap(section=>items(record(section).body)).map(record)
  // 与原生装配相同：声明 rootBody 则按精确名字，省略时选第一直属 body。
  const rootName=native.rootBody??record(entity.components.isaac).rootBody,root=rootName?bodies.find(body=>body.name===rootName):bodies[0]
  if(!root||!('freejoint' in root)&&!items(root.joint).some(joint=>record(joint).type==='free'))return false
  const controller=entity.components.controller
  // 控制模式是资产自己的声明；空对象、robot 标签、pack/权重路径都不是控制器绑定。
  // 声明存在也不等于控制循环已经开始，更不能当作站稳或 get-up 的证据。
  if(!controller)return true
  const named=(value:unknown)=>typeof value==='string'&&value.length>0
  const drone=controller.type==='drone'&&named(controller.thrustActuator)&&['x','y','z'].every(axis=>named(record(controller.torqueActuators)[axis]))
  const vehicle=controller.type==='vehicle'&&Array.isArray(controller.wheels)&&controller.wheels.length>0&&controller.wheels.every(wheel=>named(record(wheel).actuator)&&Number.isFinite(record(wheel).radiusM)&&Number(record(wheel).radiusM)>0)
  const quadruped=controller.type==='quadruped'&&Array.isArray(controller.legs)&&controller.legs.length===4&&controller.legs.every(leg=>Array.isArray(leg)&&leg.length===3&&leg.every(named))
  return !['position','velocity','torque'].includes(String(controller.controlMode))&&!drone&&!vehicle&&!quadruped
 }).map(entity=>entity.entityId)??[]
}
export const PHYSICS_TEST_KIND = 'franka-physical-playground-v2'
/** 只认正式测试包的显式标记；引擎仍由正式Host按用户偏好装配。 */
export function physicalTestSpaceOf(scene: SceneSnapshot | undefined) {
  const entity = scene?.entities.find(e => (e.components.testSpace as { kind?: string } | undefined)?.kind === PHYSICS_TEST_KIND)
  if (!entity) return undefined
  return { robotId: entity.entityId, title: '机械臂与动态方块 · 物理交互测试', tasks: [
    '观察右侧6厘米方块受重力落到地板。',
    '在对话中输入：让机械臂末端下降5厘米。',
    '在对话中输入：让机械臂左转0.1弧度推箱，并报告方块位移和真实接触力。',
    '在对话中输入：停止机械臂动作；或点击“停止动作”。',
  ], options: { clock: 'realtime' as const, ground: false, timestepS: .002 } }
}
export function physicalTestWorldInput(scene: SceneSnapshot, engine: string | null | undefined, startPaused=false) {
  const test = physicalTestSpaceOf(scene)
  if (!test) return { sceneId: scene.sceneId,options:{clock:'realtime' as const,ground:false,...startPaused?{startPaused:true}:{}} }
  if (!engine||engine==='none') throw new Error('PHYSICS_TEST_PROVIDER_REQUIRED: 正式Host尚未装配实际provider；检查当前偏好及运行依赖，sim_open没有引擎参数。')
  return { sceneId: scene.sceneId, options: {...test.options,...startPaused?{startPaused:true}:{}} }
}
/** 名称不代表能力；按同world/gen/rev的真实描述与首帧核验任务所需观测。 */
export function physicalTestMissingCapabilities(scene:SceneSnapshot,world:WorldHandle,description:RobotDescription,frame:Frame):string[]{
 const test=physicalTestSpaceOf(scene);if(!test)return []
 const missing:string[]=[]
 if(world.sceneId!==scene.sceneId||world.appliedSceneRevision!==scene.revision||frame.worldId!==world.worldId||frame.generation!==world.worldGeneration||frame.sceneRevision!==scene.revision)missing.push('current scene/world/generation/frame binding')
 if(world.clock!=='realtime')missing.push('realtime clock')
 if(Math.abs((world.timestepS??0)-test.options.timestepS)>1e-9)missing.push('0.002s physics timestep')
 const observation=frame.entities.find(e=>e.entityId===test.robotId),joints=observation?.joints
 if(!description.controlledJointNames.length)missing.push('native controlled joints')
 if(description.controlledJointNames.some(n=>{const i=joints?.names.indexOf(n)??-1;return i<0||!Number.isFinite(joints?.positions[i])}))missing.push('measured controlled joint positions')
 const tcp=scene.entities.find(e=>e.entityId===test.robotId)?.components.controller?.tcp as {site?:string}|undefined
 const sites=observation?.sensors?.sites as Record<string,{positionM?:number[];quaternionXyzw?:number[]}>|undefined,pose=tcp?.site?sites?.[tcp.site]:undefined
 if(!pose||pose.positionM?.length!==3||pose.quaternionXyzw?.length!==4||![...pose.positionM,...pose.quaternionXyzw].every(Number.isFinite))missing.push('measured controller.tcp site pose')
 if(!Array.isArray(frame.contacts))missing.push('actual contact observation channel')
 return missing
}
