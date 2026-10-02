/** 使用现有私有 SDK 的 jsdom；合成 DOM/引擎回执，不接触真实桌面或 GPU。 */
import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {identityTransform,type Entity,type EntityObservation} from '../../lyapunov-contracts/src/types.ts'
import type {EntityMotion,RobotDescription} from '../../sim-contract/src/index.ts'
import type {NativeJointResult} from '../src/robot-control-panel.tsx'
import type {ControlGestureDisplay} from '../src/control-gesture.ts'

const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
test('真实React pointer一次ID及final，非法草稿保留，Stop/scope/失败清待发',async()=>{
 const {JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 const old=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){
  old.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})
 }
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{act,Simulate}=await import('react-dom/test-utils'),{RobotControlPanel}=await import('../src/robot-control-panel.tsx')
 const host=document.getElementById('root')!,root=createRoot(host)
 const sent:Array<{motion:EntityMotion;display:ControlGestureDisplay}>=[]
 const pending:Array<{resolve:(result:NativeJointResult)=>void;reject:(error:unknown)=>void}>=[]
 const drafts:Array<boolean|undefined>=[]
 const entity:Entity={entityId:'robot',name:'robot',transform:identityTransform(),resources:[],components:{}}
 const description:RobotDescription={entityId:'robot',modelVersion:'v1',expectedGeneration:1,collisionContextVersion:'c1',controlledJointNames:['j1'],joints:[{name:'j1',range:[-2,2],unit:'rad',type:'hinge',controlMode:'position'}]}
 const observation:EntityObservation={entityId:'robot',transform:identityTransform(),joints:{names:['j1'],positions:[0],velocities:[0]}}
 let registered:(()=>ControlGestureDisplay|undefined)|undefined
 function Harness({generation,blocked=false}:{generation:number;blocked?:boolean}){
  const [targets,setTargets]=React.useState<Record<string,number>>({j1:0})
  return React.createElement(RobotControlPanel,{
   entity,description,observation,targets,setTargets:(values,draft)=>{drafts.push(draft);setTargets(values)},ready:true,duration:1,setDuration:()=>{},describe:()=>{},move:()=>{},
   fullMotion:():EntityMotion=>({kind:'joint',entityId:'robot',jointNames:['j1'],positions:[targets.j1!],durationS:1}),tr:zh=>zh,
   controlScope:{worldId:'world',generation},controlKey:'world:'+generation,controlBlocked:blocked,
   liveMove:(motion,display)=>{if(!display)throw Error('测试要求真实手势metadata');sent.push({motion,display});return new Promise<NativeJointResult>((resolve,reject)=>pending.push({resolve,reject}))},
   registerLiveCancel:fn=>{registered=fn},cancelLive:()=>{},
  })
 }
 const draw=(generation=1,blocked=false)=>root.render(React.createElement(Harness,{key:generation,generation,blocked}))
 const result=(status:'completed'|'cancelled',display:ControlGestureDisplay):NativeJointResult=>({receipt:{actionId:'a'+display.sequence,worldId:'world',generation:display.generation,status,effect:{motions:[{targetReached:false}]}},observedStep:1,actualPosition:.1,observedLatencyMs:0,display})
 try{
  await act(async()=>{draw()})
  let range=host.querySelector('input[type=range]') as HTMLInputElement
  const captured:number[]=[];range.setPointerCapture=id=>{captured.push(id)}
  act(()=>{Simulate.pointerDown(range,{pointerId:1} as any);Simulate.change(range,{target:{value:'.2'}} as any);Simulate.change(range,{target:{value:'.8'}} as any);Simulate.pointerUp(range,{pointerId:1} as any)})
  expect(sent).toHaveLength(1);expect(sent[0]!.display.phase).toBe('update')
  expect(captured).toEqual([1])
  await act(async()=>{pending.shift()!.resolve(result('completed',sent[0]!.display));await Promise.resolve()})
  expect(sent).toHaveLength(2);expect(sent[1]!.display.phase).toBe('final')
  expect(sent[1]!.motion.kind).toBe('joint')
  if(sent[1]!.motion.kind!=='joint'||sent[0]!.motion.kind!=='joint')throw Error('测试要求单关节动作')
  expect(sent[1]!.motion.positions).toEqual([.8]);expect(sent[1]!.motion.settleTimeS).toBeGreaterThan(sent[0]!.motion.settleTimeS!)
  expect(sent[0]!.display.gestureId).toBe(sent[1]!.display.gestureId)
  const stop=registered?.();expect(stop?.phase).toBe('stop')
  await act(async()=>{draw(2);pending.shift()!.resolve(result('cancelled',sent[1]!.display));await Promise.resolve()})
  expect(sent).toHaveLength(2)

  const numeric=host.querySelector('input[aria-label="关节目标 j1"]') as HTMLInputElement
  const buttons=[...host.querySelectorAll('button')]
  const full=buttons.find(button=>button.textContent==='全部关节同步运动')!
  act(()=>{Simulate.change(numeric,{target:{value:'3'}} as any);Simulate.blur(numeric)})
  expect(numeric.value).toBe('3');expect(numeric.getAttribute('aria-invalid')).toBe('true');expect(full.disabled).toBe(true);expect(drafts.at(-1)).toBe(true)
  act(()=>{Simulate.click(buttons.find(button=>button.textContent==='实测值填入目标')!)})
  expect(numeric.value).toBe('0');expect(numeric.getAttribute('aria-invalid')).toBe('false');expect(full.disabled).toBe(false);expect(drafts.at(-1)).toBe(false)
  expect(sent).toHaveLength(2)

  range=host.querySelector('input[type=range]') as HTMLInputElement
  act(()=>{Simulate.pointerDown(range,{pointerId:2} as any);Simulate.change(range,{target:{value:'1.2'}} as any);Simulate.pointerUp(range,{pointerId:2} as any)})
  expect(sent).toHaveLength(3)
  await act(async()=>{pending.shift()!.reject(Error('STALE_GENERATION'));await Promise.resolve()})
  act(()=>Simulate.pointerUp(range,{pointerId:2} as any))
  expect(sent).toHaveLength(3);expect(host.textContent).toContain('STALE_GENERATION')
  await act(async()=>{draw(2,true)})
  expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
  act(()=>{Simulate.pointerDown(range,{pointerId:3} as any);Simulate.change(range,{target:{value:'-.5'}} as any);Simulate.pointerUp(range,{pointerId:3} as any)})
  expect(sent).toHaveLength(3)
  await act(async()=>{draw(2,false)})
  expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false)
 }finally{
  await act(async()=>root.unmount());dom.window.close()
  for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key]}
 }
})
