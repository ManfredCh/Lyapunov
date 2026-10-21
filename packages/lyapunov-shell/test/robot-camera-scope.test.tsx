/**
 * V8-19/20 机器人机位 scope 回归：mounted 清单不铺世界相机表单、New camera 只用当前机器人
 * 的真实 native body、缺 body 时 Save 不可用且提交路径拒绝，world scope 仍可保存世界固定相机。
 *
 * 这里用真 React 组件 + jsdom 事件，不是原生 WebGL/截图验收；engine 读回与 Scene 写入仍由宿主
 * 的 saveInstallation 端口在真机验收。
 */
import {afterEach,beforeEach,expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import * as THREE from 'three'
import {SceneCameraPanel} from '../src/scene-camera-panel.tsx'
import {describeCameraView,cameraStateFromView,projectionMatrixFromIntrinsics} from '../../viewer/src/camera-view.ts'
import type {Entity,SceneSnapshot,WorldHandle} from '../../lyapunov-contracts/src/types.ts'
import type {CameraAuthoringSnapshot} from '../src/camera-authoring.ts'

const robot:Entity={entityId:'arm',name:'Panda One',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}
const scene:SceneSnapshot={sceneId:'s',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[robot]}
const world:WorldHandle={worldId:'w',sceneId:'s',engineId:'mujoco',engineVersion:'fixture',worldGeneration:1,appliedSceneRevision:1,status:'ready'}
const sample=():CameraAuthoringSnapshot=>{
 const camera=new THREE.PerspectiveCamera(50,800/600,.03,100);camera.position.set(2,3,4);camera.quaternion.setFromEuler(new THREE.Euler(.1,.2,.3))
 camera.projectionMatrix.fromArray(projectionMatrixFromIntrinsics({fx:830,fy:720,cx:405.25,cy:291.5,width:800,height:600},camera.near,camera.far))
 return {sceneId:'s',sceneRevision:1,worldId:'w',generation:1,frameId:'w:1:1',stepIndex:1,view:cameraStateFromView(camera,{width:800,height:600},[0,0,0]),camera:describeCameraView(camera,{width:800,height:600}),bodies:[{entityId:'arm',bodyName:'link6',worldFromBody:{positionM:[0,0,1],quaternionXyzw:[0,0,0,1]},frameId:'w:1:1',stepIndex:1}]}
}
const receipt=(bodies:boolean)=>({sceneId:'s',sceneRevision:1,worldId:'w',generation:1,...bodies?{bodies:[{entityId:'arm',bodyName:'link6',worldFromBody:{positionM:[0,0,1],quaternionXyzw:[0,0,0,1]},frameId:'w:1:1',stepIndex:1}]}:{}})

let root:Root|undefined,dom:any
const saved=new Map<string,PropertyDescriptor|undefined>()
beforeEach(()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
 const {JSDOM}=req('jsdom');dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 for(const key of ['window','document','HTMLElement','Node','navigator','IS_REACT_ACT_ENVIRONMENT']){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as unknown as Record<string,unknown>)[key]})
 }
 root=createRoot(document.getElementById('root')!)
})
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount())
 dom?.window.close()
 for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 saved.clear()
})

const text=()=>document.body.textContent??''
const byTest=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLElement|null
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent===label) as HTMLButtonElement|undefined

async function render(props:Record<string,unknown>){await act(async()=>root!.render(createElement(SceneCameraPanel,props as never)))}

test('mounted 无草稿只给清单与 Add camera；New camera 用英文默认名且 Save 只认机器人真实连杆',async()=>{
 const tasks:Promise<unknown>[]=[],saves:any[]=[]
 const base:any={api:{clientId:'mounted-window'},scene,world,receipt:receipt(true),readOnly:false,tr:(_zh:string,en:string)=>en,perform:(fn:()=>Promise<unknown>)=>{tasks.push(fn())},commit:async()=>scene,sampleCurrent:sample,saveInstallation:async(input:any)=>{saves.push(input);return{snapshot:{...scene,revision:2},entityId:'cam-1'}},pilot:()=>{},returnView:()=>{},selectCamera:()=>{},selectedRobotEntityId:'arm',prepareWorld:async()=>world,sceneSpecs:[],refresh:async()=>undefined,scope:'mounted'}
 await render(base)
 expect(byTest('camera-summary')).toBeNull()
 expect(byTest('camera-mounted-list')).not.toBeNull()
 expect(text()).not.toContain('World camera')
 expect(byTest('camera-mounted-empty')).not.toBeNull()
 const add=byTest('camera-add-to-robot') as HTMLButtonElement
 expect(add.textContent).toContain('Add camera to this robot')
 await act(async()=>add.click())
 await act(async()=>{await Promise.resolve();await Promise.resolve()})
 // 同栏 New camera 二级页；不再同时铺世界相机表单。
 expect(text()).toContain('New camera')
 expect(byTest('camera-summary')).toBeNull()
 const name=document.querySelector('input[aria-label="Scene camera name"]') as HTMLInputElement
 expect(name.value).toBe('Camera')
 const mount=document.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement
 expect([...mount.options].map(row=>row.value)).toEqual(['','link6'])
 expect([...mount.options].map(row=>row.textContent).join(' ')).not.toContain('World')
 // V8-19：首屏只留 Save camera/Cancel；Refresh links 与 Save current-view 在默认收起的 More / Installation details。
 const more=byTest('camera-installation-more') as HTMLDetailsElement
 expect(more).not.toBeNull()
 expect(more.open).toBe(false)
 const buttons=[...document.querySelectorAll('button')]
 const refresh=buttons.find(node=>node.textContent==='Refresh links')!
 const currentView=buttons.find(node=>node.textContent==='Save current-view installation')!
 expect(refresh.closest('details')).toBe(more)
 expect(currentView.closest('details')).toBe(more)
 expect(buttons.filter(node=>node.textContent==='Save camera')).toHaveLength(1)
 const save=byTest('camera-save') as HTMLButtonElement
 await act(async()=>{await Promise.resolve()})
 expect(save.disabled).toBe(false)
 await act(async()=>save.click())
 await act(async()=>{await Promise.all(tasks.splice(0))})
 expect(saves).toHaveLength(1)
 expect(saves[0]).toMatchObject({sceneId:'s',entityId:expect.any(String),name:'Camera',mount:{entityId:'arm',bodyName:'link6'}})
 expect(saves[0].entityId).not.toBe('')
})

test('mounted 缺真实 body 时不给可用的 Save，也不出现 World camera / Infinite ground 挂载项',async()=>{
 const tasks:Promise<unknown>[]=[],saves:any[]=[]
 await render({api:{clientId:'mounted-window'},scene,world,receipt:receipt(false),readOnly:false,tr:(_zh:string,en:string)=>en,perform:(fn:()=>Promise<unknown>)=>{tasks.push(fn())},commit:async()=>scene,sampleCurrent:sample,saveInstallation:async(input:any)=>{saves.push(input);return{snapshot:scene,entityId:'cam-1'}},pilot:()=>{},returnView:()=>{},selectCamera:()=>{},selectedRobotEntityId:'arm',prepareWorld:async()=>world,sceneSpecs:[],refresh:async()=>undefined,scope:'mounted'})
 await act(async()=>(byTest('camera-add-to-robot') as HTMLButtonElement).click())
 await act(async()=>{await Promise.resolve();await Promise.resolve()})
 expect(text()).not.toContain('World camera')
 const save=byTest('camera-save') as HTMLButtonElement
 expect(save.disabled).toBe(true)
 expect(byTest('camera-save-blocked')).not.toBeNull()
 await act(async()=>save.click())
 await act(async()=>{await Promise.all(tasks.splice(0))})
 expect(saves).toHaveLength(0)
})

test('world scope 仍保留世界固定相机新建与保存能力',async()=>{
 const tasks:Promise<unknown>[]=[],saves:any[]=[]
 await render({api:{clientId:'world-window'},scene,world,receipt:undefined,readOnly:false,tr:(_zh:string,en:string)=>en,perform:(fn:()=>Promise<unknown>)=>{tasks.push(fn())},commit:async()=>scene,sampleCurrent:sample,saveInstallation:async(input:any)=>{saves.push(input);return{snapshot:scene,entityId:'cam-world'}},pilot:()=>{},returnView:()=>{},selectCamera:()=>{},prepareWorld:async()=>world,sceneSpecs:[],refresh:async()=>undefined,scope:'world'})
 expect(byTest('camera-summary')).not.toBeNull()
 const robot=document.querySelector('select[aria-label="Mount entity"]') as HTMLSelectElement
 expect([...robot.options].map(row=>row.value)).toContain('')
 expect([...robot.options].map(row=>row.textContent)).toContain('World camera')
 const save=byTest('camera-save') as HTMLButtonElement
 expect(save.disabled).toBe(false)
 await act(async()=>save.click())
 await act(async()=>{await Promise.all(tasks.splice(0))})
 expect(saves).toHaveLength(1)
 expect(saves[0]).toMatchObject({sceneId:'s',name:'Camera'})
 expect(saves[0].mount).toBeUndefined()
})
