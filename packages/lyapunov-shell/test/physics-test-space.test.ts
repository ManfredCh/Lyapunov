import { expect, test } from 'bun:test'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { physicalTestSpaceOf, physicalTestWorldInput,physicalTestMissingCapabilities,uncontrolledFreeRootEntityIds } from '../src/physics-test-space.ts'
const scene = (kind?: string): SceneSnapshot => ({ sceneId: 'test', revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [{ entityId: 'arm', name: '机械臂', resources: [], transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, components: kind ? { testSpace: { kind } } : {} }] })
test('正式测试包按实际provider核能力，保留实时钟/包内地板/0.002秒步长', () => {
  const value = scene('franka-physical-playground-v2')
  expect(physicalTestSpaceOf(value)?.robotId).toBe('arm')
  expect(physicalTestWorldInput(value, 'mujoco')).toEqual({ sceneId: 'test', options: { clock: 'realtime', ground: false, timestepS: .002 } })
  expect(physicalTestWorldInput(value, 'isaac')).toEqual(physicalTestWorldInput(value,'mujoco'))
  expect(() => physicalTestWorldInput(value, null)).toThrow('PHYSICS_TEST_PROVIDER_REQUIRED')
})
test('普通场景不改变引擎/时钟；未知标记不冒充已支持空间', () => {
  expect(physicalTestSpaceOf(scene())).toBeUndefined()
  expect(physicalTestSpaceOf(scene('unknown'))).toBeUndefined()
  expect(physicalTestWorldInput(scene(), 'isaac')).toEqual({ sceneId: 'test',options:{clock:'realtime',ground:false} })
})
test('只按展开MJCF实际根自由关节和控制声明准备，名称/pack/权重登记不冒充控制器',()=>{
 const value=scene(),entity=value.entities[0]!
 entity.name='Panda';entity.components={mujoco:{sourcePath:'/fixture/g1.xml'},packBinding:{packId:'unitree_g1',policyPath:'/fixture/policy.pt'},visual:{robot:{format:'mjcf',document:{worldbody:{body:[{name:'pelvis',freejoint:''},{name:'other'}]}}}}}
 expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 entity.components.controller={robot:'unitree_g1'};expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 entity.components.controller={controlMode:'unknown'};expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 entity.components.controller={controlMode:'position',policyAdapter:'torchscript'};expect(uncontrolledFreeRootEntityIds(value)).toEqual([])
 entity.components.controller=undefined;entity.components.mujoco={rootBody:'other'};expect(uncontrolledFreeRootEntityIds(value)).toEqual([])
 entity.components.mujoco={rootBody:'pelvis'};expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 const doc=(entity.components.visual!.robot as any).document;doc.worldbody.body=[{name:'fixed'},{name:'cube',freejoint:''}];entity.components.mujoco={};entity.name='G1'
 expect(uncontrolledFreeRootEntityIds(value)).toEqual([])
 doc.worldbody.body=[{name:'root',joint:{type:'free'}}];expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 doc.worldbody.body[0].joint.type='hinge';expect(uncontrolledFreeRootEntityIds(value)).toEqual([])
})
test('准备startPaused透传普通/测试模板分支；省略或false保固定Panda原选项',()=>{
 expect(physicalTestWorldInput(scene(),'mujoco',true)).toEqual({sceneId:'test',options:{clock:'realtime',ground:false,startPaused:true}})
 const value=scene('franka-physical-playground-v2'),defaults={sceneId:'test',options:{clock:'realtime' as const,ground:false,timestepS:.002}}
 expect(physicalTestWorldInput(value,'mujoco')).toEqual(defaults)
 expect(physicalTestWorldInput(value,'mujoco',false)).toEqual(defaults)
 expect(physicalTestWorldInput(value,'mujoco',true)).toEqual({...defaults,options:{...defaults.options,startPaused:true}})
 value.entities.push({...value.entities[0]!,entityId:'free-robot',name:'自由根',components:{mujoco:{},visual:{robot:{format:'mjcf',document:{worldbody:{body:{name:'base',freejoint:''}}}}}}})
 expect(uncontrolledFreeRootEntityIds(value)).toEqual(['free-robot'])
 expect(physicalTestWorldInput(value,'isaac',true)).toEqual({...defaults,options:{...defaults.options,startPaused:true}})
})
test('既有drone/vehicle/quadruped真实映射省略controlMode时仍是控制声明，类型标签或缺映射不算',()=>{
 const value=scene(),entity=value.entities[0]!
 entity.components={mujoco:{},visual:{robot:{format:'mjcf',document:{worldbody:{body:{name:'root',freejoint:''}}}}}}
 for(const controller of [{type:'drone',thrustActuator:'thrust',torqueActuators:{x:'tx',y:'ty',z:'tz'}},{type:'vehicle',wheels:[{actuator:'wheel',radiusM:.1}]},{type:'quadruped',legs:Array.from({length:4},(_,i)=>[`ab${i}`,`th${i}`,`kn${i}`])}]){
  entity.components.controller=controller;expect(uncontrolledFreeRootEntityIds(value)).toEqual([])
 }
 for(const controller of [{type:'drone'},{type:'drone',thrustActuator:'thrust',torqueActuators:{x:'tx'}},{type:'vehicle',wheels:[]},{type:'quadruped',legs:[['ab','th','kn']]}]){
  entity.components.controller=controller;expect(uncontrolledFreeRootEntityIds(value)).toEqual(['arm'])
 }
})
test('名称是Isaac也须有真实关节/声明site/接触/时钟，缺项一次返回',()=>{
 const value=scene('franka-physical-playground-v2');value.entities[0]!.components.controller={tcp:{site:'tcp'}}
 const world:any={sceneId:'test',worldId:'w',worldGeneration:1,appliedSceneRevision:0,clock:'realtime',timestepS:.002,engineId:'isaac'},description:any={controlledJointNames:['j']}
 const frame:any={worldId:'w',generation:1,sceneRevision:0,entities:[{entityId:'arm',joints:{names:['j'],positions:[.7]},sensors:{sites:{tcp:{positionM:[.5,0,.9],quaternionXyzw:[0,0,0,1]}}}}],contacts:[]}
 expect(physicalTestMissingCapabilities(value,world,description,frame)).toEqual([])
 frame.entities[0].sensors={};frame.entities[0].joints.positions=[NaN];delete frame.contacts
 expect(physicalTestMissingCapabilities(value,world,description,frame)).toEqual(['measured controlled joint positions','measured controller.tcp site pose','actual contact observation channel'])
})
