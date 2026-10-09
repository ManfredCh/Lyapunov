import { afterEach, describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SceneViewer, type ViewerViewState } from '../src/index.ts'
import { FrameProjection } from '../src/projection.ts'
import { FirstPersonNavigation } from '../src/first-person.ts'
import { frustumFromReceipt, type FrustumSpec } from '../src/camera-frustum.ts'
import { composeViewerCameraComponent, normalizeIntrinsics, quaternionAngleDeg } from '../src/camera-view.ts'
import type { Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { enterSavedCameraView, settleSceneCameraLoad } from '../../lyapunov-shell/src/camera-navigation-actions.ts'
import { applyCameraNavigation } from '../../lyapunov-shell/src/camera-navigation-actions.ts'
import { CameraReturnControl } from '../../lyapunov-shell/src/scene-camera-panel.tsx'
import { projectSceneCameraRigs } from '../src/scene-camera-rigs.ts'
import { createRequire } from 'node:module'

// 真Viewer原型、真Three/OrbitControls；只替换WebGL画布与TransformControls事件表面。
// 不量浏览器像素、原生仿真或GUI手感，避免把本地行为证明当成最终包验收。
class Canvas extends EventTarget {
  width=1280; height=720; clientWidth=1280; clientHeight=720
  style:Record<string,string>={}; dataset:Record<string,string>={}; tabIndex=0; focused=0
  isConnected=true
  ownerDocument={addEventListener(){},removeEventListener(){},defaultView:new EventTarget(),activeElement:this,hasFocus:()=>true}
  getRootNode(){return this.ownerDocument}
  getBoundingClientRect(){return {left:0,top:0,width:this.width,height:this.height,right:this.width,bottom:this.height}}
  focus(){this.focused++}
  setPointerCapture(){}; releasePointerCapture(){}; hasPointerCapture(){return false}
  toDataURL(){throw new Error('元数据采样不得截图')}
}
const cleanups:Array<()=>void>=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()})

function harness(){
  const viewer:any=Object.create(SceneViewer.prototype),canvas=new Canvas()
  viewer.renderer={domElement:canvas,render(){}}
  viewer.camera=new THREE.PerspectiveCamera(50,1280/720,.1,1000)
  viewer.camera.up.set(0,0,1);viewer.camera.position.set(5,-6,4)
  viewer.controls=new OrbitControls(viewer.camera,canvas as unknown as HTMLElement)
  viewer.controls.target.set(0,0,.7);viewer.controls.update();viewer.controls.enableDamping=true
  cleanups.push(()=>viewer.controls.dispose())
  viewer.scene=new THREE.Scene();viewer.objects=new Map();viewer.cameraRigs=new Map();viewer.cameraRigRoot=new THREE.Group();viewer.scene.add(viewer.cameraRigRoot)
  viewer.projection=new FrameProjection();viewer.editing=false;viewer.disposed=false;viewer.navigationPreference='first-person'
  viewer.firstPerson={active:true,clears:0,update(){},setActive(value:boolean){this.active=value},clearInput(){this.clears++}}
  viewer.transformControls={object:undefined,enabled:true,dragging:false,detaches:0,attach(object:THREE.Object3D){this.object=object},detach(){this.detaches++;this.object=undefined},setMode(){}}
  viewer.options={container:{clientWidth:1280,clientHeight:720},resolveResource(){throw new Error('本测试没有资源读取')},onError(){}}
  viewer.splatBounds=new WeakMap();viewer.splatViewBounds=new WeakMap()
  // 与相机模式无关的显示流水线不需要WebGL。
  viewer.updateLod=()=>{};viewer.advanceAnimations=()=>{};viewer.advanceDayNight=()=>{};viewer.updateAnnotationMarkers=()=>{}
  return {viewer,canvas}
}
const K=normalizeIntrinsics({fx:600,fy:610,cx:359,cy:201,width:640,height:480})
const poseQuaternion=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2)).toArray() as [number,number,number,number]
function spec(key='camera-a',position=[1,2,3],intrinsics=K):FrustumSpec{
  const result=frustumFromReceipt({cameraName:key,worldFromCamera:{positionM:position,quaternionXyzw:poseQuaternion},intrinsics,nearM:.05,farM:100})
  if(!result.ok)throw new Error(result.unavailable)
  return result.spec
}
function scene(revision=3):SceneSnapshot{return {sceneId:'scene-a',revision,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]}}
function world(sceneRevision=3):WorldHandle{return {worldId:'world-a',sceneId:'scene-a',engineId:'mujoco',engineVersion:'test',worldGeneration:7,appliedSceneRevision:sceneRevision,status:'ready'}}
function frame(stepIndex:number):Frame{return {worldId:'world-a',generation:7,sceneRevision:3,stepIndex,frameId:`world-a:7:${stepIndex}`,simTime:stepIndex*.002,entities:[{entityId:'robot-a',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},sensors:{bodyWorldPoses:{wrist:{positionM:[stepIndex,2,3],quaternionXyzw:[0,0,0,1]}}}}]}}
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function expectSameView(actual:ViewerViewState,expected:ViewerViewState){
  for(const key of ['position','target','up'] as const){expect(actual[key]?.length).toBe(expected[key]?.length);for(let i=0;i<(expected[key]?.length??0);i++)expect(actual[key]![i]).toBeCloseTo(expected[key]![i]!,9)}
  expect(quaternionAngleDeg(actual.quaternion,expected.quaternion)).toBeLessThan(1e-5)
  for(const key of ['fovDeg','near','far'] as const)expect(actual[key]!).toBeCloseTo(expected[key]!,9)
  expect(actual.navigation).toBe(expected.navigation)
  if(expected.intrinsics){expect(actual.intrinsics?.width).toBe(expected.intrinsics.width);expect(actual.intrinsics?.height).toBe(expected.intrinsics.height);for(const key of ['fx','fy','cx','cy'] as const)expect(actual.intrinsics?.[key]!).toBeCloseTo(expected.intrinsics[key],9)}
  else expect(actual.intrinsics).toBeUndefined()
}

test('原导航DOM随同一locale显示Orbit/Roam和相机出口；换语言不通知观察状态或改机位',()=>{
  const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=sdkRequire('jsdom')
  const dom=new JSDOM('<div id="viewer"></div>',{url:'http://viewer-copy.fixture.invalid'}),previous=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','CustomEvent','Node','localStorage']){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true,writable:true})}
  try{
    const {viewer}=harness(),host=document.getElementById('viewer')!
    let language:'zh'|'en'='zh'
    viewer.options.container=host;viewer.options.translate=(zh:string,en:string)=>language==='en'?en:zh
    viewer.navigationButtons=[];viewer.initializeNavigationBar();viewer.setNavigationMode('orbit',false)
    const buttons=()=>[...host.querySelectorAll('button')],find=(label:string)=>buttons().find(button=>button.textContent===label)!
    expect(find('环绕').getAttribute('aria-label')).toBe('查看器环绕');expect(find('漫游').title).toBe('中键转头 · Shift+中键平移 · 滚轮前后移动 · WASD/QE · Shift加速')
    const before=viewer.getViewState();let updates=0;const unsubscribe=viewer.subscribeObserverState(()=>updates++)
    language='en';viewer.renderFrame()
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Viewer navigation')
    expect(find('Orbit').title).toBe('Middle-drag to orbit selection · Shift+middle-drag to pan · wheel to zoom');expect(find('Roam').getAttribute('aria-label')).toBe('Roam view')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Free orbit')
    expect(updates).toBe(0);expectSameView(viewer.getViewState(),before)
    find('Roam').click();expect(viewer.observerState().navigation).toBe('first-person');expect(find('Roam').getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Free movement · WASD/QE')
    viewer.setCameraRigs([spec()]);viewer.pilotCameraRig('camera-a')
    expect(find('Exit camera').hidden).toBe(false);expect(find('Exit camera').title).toBe('Return to the main view')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Viewing camera (locked)')
    find('Exit camera').click();expect(viewer.observerState().mode).toBe('free');expect(find('Exit camera').hidden).toBe(true)
    const returned=viewer.getViewState(),after=updates;language='zh';viewer.renderFrame()
    expect(find('环绕')).toBeTruthy();expect(find('漫游')).toBeTruthy();expect(find('退出相机').getAttribute('aria-label')).toBe('退出相机')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('自由漫游 · WASD/QE')
    expect(updates).toBe(after);expectSameView(viewer.getViewState(),returned);unsubscribe()
  }finally{dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key]}}
})

describe('A08统一观察模式与全部出口',()=>{
  test('无World已保存机位保持完整target/K/clips，切机位及Scene metadata保存不丢主视图返程',()=>{
    const {viewer}=harness()
    viewer.applyCameraView({position:[1,2,3],quaternion:poseQuaternion,targetDistanceM:7,intrinsics:K,near:.07,far:140})
    const saved=viewer.getViewState()
    viewer.applyCameraView({position:[8,9,10],quaternion:poseQuaternion,targetDistanceM:2,near:.12,far:700,fovYDeg:40})
    const main=viewer.getViewState()
    viewer.snapshot=scene();viewer.snapshot.entities=[{entityId:'views',name:'视角',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{viewerCamera:composeViewerCameraComponent([{name:'roll90',savedAt:'2026-10-02T00:00:00Z',state:saved}])}}]
    viewer.setCameraRigs([]);expect(viewer.cameraRigs.get('views/roll90').spec.source).toBe('named-view')
    enterSavedCameraView(viewer,viewer.snapshot,'roll90');expect(viewer.observerState().mode).toBe('pilot')
    expect(viewer.controls.target.distanceTo(new THREE.Vector3(...saved.target))).toBeLessThan(1e-9)
    expect(viewer.camera.near).toBe(.07);expect(viewer.camera.far).toBe(140)
    expectSameView(viewer.getViewState(),saved)
    viewer.snapshot.revision++;viewer.setCameraRigs([])
    expect(viewer.observerState()).toMatchObject({mode:'pilot',cameraId:'views/roll90'})
    for(const next of [world(4),{...world(4),worldGeneration:8},{...world(4),status:'closed' as const}]){viewer.setWorld(next);expect(viewer.observerState()).toMatchObject({mode:'pilot',cameraId:'views/roll90'});expectSameView(viewer.getViewState(),saved)}
    viewer.returnFromCameraRig();expectSameView(viewer.getViewState(),main);expect(viewer.firstPerson.active).toBe(true)
    viewer.setCameraRigs([]);expectSameView(viewer.getViewState(),main)
  })
  test('同Scene异步加载等待期间真实D游览，完成不重放旧pose或K；新Scene仍恢复缓存机位',async()=>{
    const {viewer,canvas}=harness(),loaded=deferred(),cached=viewer.getViewState()
    const nav=new FirstPersonNavigation(viewer.camera,canvas as unknown as HTMLCanvasElement,viewer.controls.target,()=>nav.setActive(false))
    cleanups.push(()=>nav.dispose());viewer.firstPerson=nav;nav.setActive(true);nav.update(100)
    const pending=loaded.promise.then(()=>settleSceneCameraLoad(viewer,true,cached))
    const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{code:{value:'KeyD'},ctrlKey:{value:false},altKey:{value:false},metaKey:{value:false}});canvas.dispatchEvent(event)
    for(let time=150;time<=600;time+=50)nav.update(time)
    expect(viewer.camera.position.distanceTo(new THREE.Vector3(...cached.position))).toBeGreaterThan(1)
    const toured=viewer.getViewState();loaded.resolve();await pending
    expect(viewer.getViewState()).toEqual(toured);expect(nav.active).toBe(true)
    settleSceneCameraLoad(viewer,false,cached);expectSameView(viewer.getViewState(),cached)
  })
  test('自由漫游held键跨World不可用/代次/Scene版本刷新继续，由输入owner失焦才停止',()=>{
    const {viewer,canvas}=harness();viewer.snapshot=scene();viewer.world=world();viewer.setCameraRigs([])
    const nav=new FirstPersonNavigation(viewer.camera,canvas as unknown as HTMLCanvasElement,viewer.controls.target,()=>nav.setActive(false))
    cleanups.push(()=>nav.dispose());viewer.firstPerson=nav;nav.setActive(true);nav.update(100)
    const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{code:{value:'KeyW'},ctrlKey:{value:false},altKey:{value:false},metaKey:{value:false}});canvas.dispatchEvent(event)
    let time=100
    for(const refresh of [()=>{},()=>viewer.setWorld({...world(),status:'failed'}),()=>viewer.setWorld({...world(),worldGeneration:8}),()=>{viewer.snapshot.revision++;viewer.setCameraRigs([])}]){
      const before=viewer.camera.position.clone();refresh();nav.update(time+=50)
      expect(viewer.camera.position.distanceTo(before)).toBeCloseTo(.15,9);expect(viewer.observerState().mode).toBe('free')
    }
    const before=viewer.camera.position.clone();canvas.dispatchEvent(new Event('blur'));nav.update(time+50);expect(viewer.camera.position.distanceTo(before)).toBe(0)
  })
  test('保存视角入口拒绝另Scene/旧revision/缺名字，换Scene不沿用旧返回位',()=>{
    const {viewer}=harness();viewer.snapshot=scene()
    expect(()=>enterSavedCameraView(viewer,{...scene(),sceneId:'other'},'missing')).toThrow('CAMERA_NAVIGATION_SCENE_STALE')
    expect(()=>enterSavedCameraView(viewer,scene(4),'missing')).toThrow('CAMERA_NAVIGATION_SCENE_STALE')
    expect(()=>enterSavedCameraView(viewer,scene(),'missing')).toThrow('CAMERA_NAVIGATION_SAVED_VIEW_MISSING')
    viewer.snapshot.entities=[{entityId:'cam',name:'机位',transform:{position:[1,2,3],quaternion:poseQuaternion,scale:[1,1,1]},resources:[],components:{camera:{fovYDeg:60,width:640,height:480,near:.05,far:100}}}]
    viewer.setCameraRigs([]);viewer.pilotCameraRig('cam/机位');const previousSensor=viewer.camera.position.clone()
    viewer.snapshot={...scene(),sceneId:'other',entities:viewer.snapshot.entities};viewer.setCameraRigs([])
    expect(viewer.observerState().mode).toBe('free');expect(viewer.camera.position.distanceTo(previousSensor)).toBeLessThan(1e-9)
  })
  test('传感器World失效恢复同Scene主姿态/FOV而非留在传感器位置；后续Frame不回弹',()=>{
    const {viewer,canvas}=harness();viewer.snapshot=scene();viewer.world=world()
    viewer.projection.setScene(viewer.snapshot);viewer.projection.setWorld(viewer.world)
    const row={cameraName:'native-camera',worldFromCamera:{positionM:[1,2,3],quaternionXyzw:poseQuaternion},intrinsics:K,nearM:.04,farM:80,generation:7,sceneRevision:3,stepIndex:10}
    const result=frustumFromReceipt(row);if(!result.ok)throw Error(result.unavailable)
    viewer.setCameraRigs([result.spec]);const main=viewer.getViewState()
    viewer.pilotCameraRig('native-camera');expect(viewer.camera.near).toBe(.04);expect(viewer.camera.far).toBe(80)
    const focuses=canvas.focused;viewer.setWorld({...world(),status:'closed'});expect(canvas.focused).toBe(focuses)
    expect(viewer.observerState().mode).toBe('free');expectSameView(viewer.getViewState(),main)
    viewer.setWorld(world());viewer.projection.setWorld(viewer.world)
    const next={...frame(12),cameras:[{...row,frameId:'world-a:7:12',stepIndex:12,available:true as const}]}
    viewer.pushFrame(next);viewer.renderFrame();expectSameView(viewer.getViewState(),main)
  })
  test('Esc不依赖inactive漫游；返回完整光学机位、导航、焦点并清输入，连续退出幂等',()=>{
    const {viewer,canvas}=harness();viewer.setCameraRigs([spec()]);const before=viewer.getViewState()
    viewer.pilotCameraRig('camera-a');expect(viewer.observerState().mode).toBe('pilot');expect(viewer.firstPerson.active).toBe(false);expect(viewer.controls.enabled).toBe(false)
    canvas.addEventListener('keydown',(event)=>viewer.handleObserverKey(event),true)
    const event=new Event('keydown',{cancelable:true});Object.defineProperties(event,{code:{value:'Escape'},ctrlKey:{value:false},altKey:{value:false},metaKey:{value:false}});canvas.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true);expect(viewer.observerState().mode).toBe('free');expect(viewer.firstPerson.active).toBe(true)
    expect(viewer.camera.position.distanceTo(new THREE.Vector3(...before.position))).toBeLessThan(1e-8)
    expect(quaternionAngleDeg(viewer.camera.quaternion.toArray(),before.quaternion)).toBeLessThan(1e-5)
    expect(viewer.captureGateSpec).toBeUndefined();expect(canvas.focused).toBeGreaterThan(0);expect(viewer.firstPerson.clears).toBeGreaterThan(0)
    expect(viewer.exitCameraMode()).toBe(false)
  })
  test('预设、书签、直接视角、全景、焦点与导航按钮解除pilot；后续刷新不回弹',()=>{
    const {viewer}=harness(),group=new THREE.Group();group.add(new THREE.Mesh(new THREE.BoxGeometry(2,3,4)));viewer.scene.add(group);viewer.objects.set('subject',{group})
    viewer.setCameraRigs([spec()]);const bookmark=viewer.getViewState()
    const exits=[()=>viewer.cameraPreset('top'),()=>viewer.setViewState(bookmark),()=>viewer.applyCameraView({position:[8,9,10],quaternion:poseQuaternion}),()=>viewer.frameAll(),()=>viewer.focus('subject'),()=>viewer.setNavigationMode('orbit',false)]
    for(const exit of exits){viewer.pilotCameraRig('camera-a');exit();const view=viewer.cameraView();expect(viewer.pilotedCameraRig()).toBeUndefined();expect(viewer.observerState().mode).toBe('free');viewer.setCameraRigs([spec('camera-a',[70,80,90])]);expect(viewer.camera.position.toArray()).toEqual(view.position);expect(quaternionAngleDeg(viewer.camera.quaternion.toArray(),view.quaternion)).toBeLessThan(1e-5)}
  })
  test('锁定机位保持roll和K，真实Orbit残余阻尼不能破坏进入或每一显示帧',()=>{
    const {viewer}=harness();viewer.controls._rotateLeft(.12);viewer.controls.update()
    viewer.setCameraRigs([spec()]);viewer.pilotCameraRig('camera-a');const before=viewer.cameraView()
    for(let i=0;i<12;i++)viewer.renderFrame()
    const after=viewer.cameraView();expect(after.position).toEqual(before.position);expect(quaternionAngleDeg(after.quaternion,poseQuaternion)).toBeLessThan(1e-5);expect(after.intrinsics).toEqual(before.intrinsics);expect(Math.abs(after.rollDeg)).toBeCloseTo(90)
  })
  test('订阅读同一稳定快照，只在模式或dirty变化时通知，取消订阅生效',async()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);let updates=0
    const initial=viewer.observerState(),unsubscribe=viewer.subscribeObserverState(()=>updates++)
    expect(viewer.observerState()).toBe(initial);viewer.setCameraRigs([spec()]);expect(updates).toBe(0)
    viewer.pilotCameraRig('camera-a');expect(updates).toBe(1);viewer.setCameraRigs([spec('camera-a',[4,5,6])]);expect(updates).toBe(1)
    viewer.returnFromCameraRig();expect(updates).toBe(2);unsubscribe();viewer.pilotCameraRig('camera-a');expect(updates).toBe(2)
    // 冷包反例：同key的原生Frame优先于保存元数据，真正订阅/渲染的侧栏仍必须给pilot出口。
    const {viewer:live}=harness(),main=live.getViewState()
    live.applyCameraView({position:[1,2,3],quaternion:poseQuaternion,intrinsics:K,near:.07,far:140});const saved=live.getViewState();live.setViewState(main,{focus:false})
    live.snapshot=scene();live.snapshot.entities=[{entityId:'views',name:'保存机位',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{viewerCamera:composeViewerCameraComponent([{name:'View 1',savedAt:'2026-10-02T00:00:00Z',state:saved}])}}]
    live.setWorld(world());const native={cameraName:'views/View 1',worldFromCamera:{positionM:[1,2,3] as [number,number,number],quaternionXyzw:poseQuaternion},intrinsics:K,nearM:.07,farM:140,available:true as const}
    const next={...frame(10),cameras:[{...native,frameId:'world-a:7:10',stepIndex:10,generation:7,sceneRevision:3}]};live.pushFrame(next);live.renderFrame()
    let projected=projectSceneCameraRigs(live.snapshot,live.world,live.displayedFrame)
    expect(projected.find(row=>row.key==='views/View 1')?.source).toBe('engine')
    const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<aside id="camera-panel"></aside>',{url:'http://camera-exit.fixture.invalid'})
    const previous=new Map<string,PropertyDescriptor|undefined>()
    for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})}
    const React=await import('react'),{createRoot}=await import('react-dom/client'),{act,Simulate}=await import('react-dom/test-utils'),host=document.getElementById('camera-panel')!,root=createRoot(host)
    const exit=()=>applyCameraNavigation({action:'exitCameraView'},{clientId:'fixture',ownsSurface:()=>true,viewerVisible:()=>true,scene:()=>live.snapshot,viewer:()=>live,ui:{showCentre(){},openTool(){throw Error('返回不应打开其它面板')}},selectEntity(){throw Error('返回不应切换机器人')}})
    function Panel({owner}:{owner?:typeof live}){
      const subscribe=React.useCallback((listener:()=>void)=>owner?.subscribeObserverState(listener)??(()=>{}),[owner]),snapshot=React.useCallback(()=>owner?.observerState(),[owner])
      const observer=React.useSyncExternalStore(subscribe,snapshot,()=>undefined),props={mode:observer?.mode,cameraId:observer?.cameraId,cameraSpecs:projected,returnView:exit,tr:(cn:string)=>cn}
      return React.createElement(CameraReturnControl,props)
    }
    const draw=(owner:typeof live|undefined=live)=>root.render(React.createElement(Panel,{owner})),button=()=>host.querySelector<HTMLButtonElement>('button[aria-label="返回主视图"]')
    try{
      await act(async()=>draw());expect(button()).toBeNull()
      for(const rows of [projected,[],[{...projected[0]!,key:'wrong-key',source:'scene' as const}]]){
        projected=rows;await act(async()=>{draw();enterSavedCameraView(live,live.snapshot,'View 1')})
        expect(live.observerState().mode).toBe('pilot');expect(button()).not.toBeNull();expect(button()!.disabled).toBe(false)
        act(()=>Simulate.click(button()!));expect(live.observerState().mode).toBe('free');expectSameView(live.getViewState(),main);expect(button()).toBeNull()
      }
      await act(async()=>{enterSavedCameraView(live,live.snapshot,'View 1');live.setWorld({...world(),worldGeneration:8})});expect(button()).toBeNull();expectSameView(live.getViewState(),main)
      const synced={...frame(11),generation:8,frameId:'world-a:8:11',cameras:[{...native,frameId:'world-a:8:11',stepIndex:11,generation:8,sceneRevision:3}]}
      await act(async()=>{live.pushFrame(synced);live.renderFrame();enterSavedCameraView(live,live.snapshot,'View 1')});expect(button()).not.toBeNull()
      await act(async()=>{live.snapshot={...scene(),sceneId:'other-scene'};live.setCameraRigs([])});expect(live.observerState().mode).toBe('free');expect(button()).toBeNull()
      await act(async()=>root.render(React.createElement(Panel,{})));expect(button()).toBeNull();expect(live.observerListeners?.size??0).toBe(0)
    }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key]}}
  })
})

describe('A08稳定视锥、编辑草稿与异步ACK',()=>{
  test('跨连续更新复用group/pick/几何与gizmo；保持镜头草稿，退出采用新元数据，真实删除释放',()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);const rig=viewer.cameraRigs.get('camera-a'),geometry=rig.lines.geometry,pickGeometry=rig.pick.geometry
    viewer.attachCameraRigGizmo('camera-a');rig.group.position.x=9;viewer.publishObserverState()
    const detaches=viewer.transformControls.detaches
    for(let i=0;i<8;i++)viewer.setCameraRigs([spec('camera-a',[i,20,30])])
    expect(viewer.cameraRigs.get('camera-a')).toBe(rig);expect(rig.lines.geometry).toBe(geometry);expect(rig.pick.geometry).toBe(pickGeometry);expect(viewer.transformControls.object).toBe(rig.group);expect(viewer.transformControls.detaches).toBe(detaches);expect(rig.group.position.x).toBe(9);expect(viewer.observerState().dirty).toBe(true)
    let disposed=0;geometry.addEventListener('dispose',()=>disposed++)
    viewer.setCameraRigs([spec('camera-a',[1,2,3],{...K,fx:900})])
    expect(disposed).toBe(0);expect(rig.lines.geometry).toBe(geometry);expect(viewer.cameraRigs.get('camera-a')).toBe(rig);expect(viewer.transformControls.object).toBe(rig.group)
    expect(rig.spec.intrinsics.fx).toBe(900);expect(viewer.cameraRigEditLens).toEqual(K);expect(rig.group.position.x).toBe(9)
    viewer.finishCameraRigEditing({discard:true})
    expect(disposed).toBe(1);expect(rig.lines.geometry).not.toBe(geometry);expect(rig.group.position.toArray()).toEqual([1,2,3]);expect(viewer.cameraRigEditLens).toBeUndefined();expect(viewer.observerState().mode).toBe('free')
    const next=rig.lines.geometry;next.addEventListener('dispose',()=>disposed++);viewer.setCameraRigs([])
    expect(disposed).toBe(2);expect(rig.group.parent).toBeNull();expect(viewer.transformControls.object).toBeUndefined();expect(viewer.observerState().mode).toBe('free')
  })
  test('取消拖拽清pointer/drag与草稿，不发保存；恢复最新权威读数',()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);viewer.attachCameraRigGizmo('camera-a');const rig=viewer.cameraRigs.get('camera-a');rig.group.position.x=11
    viewer.setCameraRigs([spec('camera-a',[4,5,6])]);let calls=0;viewer.onCameraRigEdit=()=>calls++;viewer.transformControls.dragging=true;viewer.editing=true
    viewer.finishCameraRigEditing();expect(calls).toBe(0);expect(rig.group.position.toArray()).toEqual([4,5,6]);expect(viewer.transformControls.dragging).toBe(false);expect(viewer.editing).toBe(false);expect(viewer.observerState().dirty).toBe(false)
  })
  test('保存single-flight，失败保草稿与原因，显式保存并结束可重试同一DTO',async()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);viewer.attachCameraRigGizmo('camera-a');viewer.cameraRigs.get('camera-a').group.position.x=11
    const first=deferred();let calls=0;const dtos:any[]=[];viewer.onCameraRigEdit=(_key:string,edit:any)=>{calls++;dtos.push(edit);return calls===1?first.promise:Promise.resolve()}
    const saving=viewer.emitCameraRigEdit();expect(viewer.observerState().saving).toBe(true);expect(viewer.observerState().dirty).toBe(true);expect(viewer.emitCameraRigEdit()).toBe(saving);expect(calls).toBe(1)
    first.reject(new Error('SCENE_REVISION_CONFLICT'));await expect(saving).rejects.toThrow('SCENE_REVISION_CONFLICT')
    expect(viewer.observerState()).toMatchObject({mode:'camera-edit',dirty:true,saving:false,error:'SCENE_REVISION_CONFLICT'});expect(viewer.cameraRigs.get('camera-a').group.position.x).toBe(11)
    await viewer.finishCameraRigEditing({discard:false});expect(calls).toBe(2);expect(dtos[1]).toEqual(dtos[0]);expect(viewer.observerState()).toMatchObject({mode:'free',dirty:false,saving:false});expect(viewer.cameraRigs.get('camera-a').group.position.x).toBe(11)
  })
  test('旧void回调不能冒充持久保存ACK，保存并结束拒绝且保留编辑',async()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);viewer.attachCameraRigGizmo('camera-a');viewer.cameraRigs.get('camera-a').group.position.x=11;viewer.onCameraRigEdit=()=>{}
    await expect(viewer.finishCameraRigEditing({discard:false})).rejects.toThrow('VIEWER_CAMERA_EDIT_ACK_REQUIRED');expect(viewer.observerState().mode).toBe('camera-edit');expect(viewer.observerState().dirty).toBe(true)
  })
  test('旧保存结果与finally不得清理新编辑/新save，取消不取消已发Scene事务',async()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec('a'),spec('b')]);const a=deferred(),b=deferred();viewer.onCameraRigEdit=(key:string)=>key==='a'?a.promise:b.promise
    viewer.attachCameraRigGizmo('a');viewer.cameraRigs.get('a').group.position.x=10;const old=viewer.emitCameraRigEdit();viewer.finishCameraRigEditing()
    viewer.attachCameraRigGizmo('b');viewer.cameraRigs.get('b').group.position.x=20;const current=viewer.emitCameraRigEdit()
    a.resolve();await old;expect(viewer.observerState()).toMatchObject({mode:'camera-edit',cameraId:'b',dirty:true,saving:true});expect(viewer.transformControls.enabled).toBe(false)
    b.resolve();await current;expect(viewer.observerState()).toMatchObject({mode:'camera-edit',cameraId:'b',dirty:false,saving:false})
  })
  test('scene/world generation作用域改变释放旧对象和编辑；不会跨会话保留pilot',()=>{
    const {viewer}=harness();viewer.snapshot=scene();viewer.snapshot.entities=[{entityId:'cam',name:'主机位',transform:{position:[1,2,3],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{camera:{name:'主机位',fovYDeg:60,width:640,height:480,near:.05,far:100}}}]
    viewer.world=world();viewer.setCameraRigs([]);const rig=viewer.cameraRigs.get('cam/主机位');viewer.attachCameraRigGizmo('cam/主机位');let disposed=0;rig.lines.geometry.addEventListener('dispose',()=>disposed++)
    viewer.world.worldGeneration++;viewer.setCameraRigs([]);expect(disposed).toBe(1);expect(viewer.cameraRigs.get('cam/主机位').group).not.toBe(rig.group);expect(viewer.observerState().mode).toBe('free');expect(viewer.transformControls.object).toBeUndefined()
    viewer.pilotCameraRig('cam/主机位');viewer.world.status='closed';viewer.setWorld(viewer.world);expect(viewer.pilotedCameraRig()).toBeUndefined()
  })
})

describe('A08实际displayedFrame元数据采样',()=>{
  test('无World静态相机可采样完整K/clips且不截图，有World只采用已显示Frame的body',()=>{
    const {viewer}=harness();viewer.snapshot=scene();const staticSample=viewer.sampleCameraAuthoring();expect(staticSample.sceneRevision).toBe(3);expect(staticSample.worldId).toBeUndefined();expect(staticSample.camera.intrinsics.width).toBe(1280)
    viewer.world=world();viewer.projection.setScene(viewer.snapshot);viewer.projection.setWorld(viewer.world);viewer.displayedFrame=frame(10);viewer.projection.push(frame(11))
    const sample=viewer.sampleCameraAuthoring();expect(sample.frameId).toBe('world-a:7:10');expect(sample.stepIndex).toBe(10);expect(sample.bodies).toEqual([{entityId:'robot-a',bodyName:'wrist',worldFromBody:{positionM:[10,2,3],quaternionXyzw:[0,0,0,1]},frameId:'world-a:7:10',stepIndex:10}]);expect(sample.camera.near).toBe(.1);expect(sample.camera.far).toBe(1000);expect(sample.camera.projectionMatrix).toHaveLength(16)
    viewer.world.worldGeneration++;expect(viewer.sampleCameraAuthoring().bodies).toBeUndefined()
  })
  test('编辑中的Frame不consume丢失；结束后真正应用才推进authoring采样',()=>{
    const {viewer}=harness();viewer.snapshot=scene();viewer.world=world();viewer.projection.setScene(viewer.snapshot);viewer.projection.setWorld(viewer.world);viewer.displayedFrame=frame(10);viewer.projection.push(frame(11));viewer.editing=true
    viewer.renderFrame();expect(viewer.sampleCameraAuthoring().stepIndex).toBe(10);viewer.editing=false;viewer.renderFrame();expect(viewer.sampleCameraAuthoring().stepIndex).toBe(11)
  })
  test('gizmo DTO包含实际displayedFrame、同一Scene身份和完整镜头，world缺席不阻断世界相机编辑',async()=>{
    const {viewer}=harness();viewer.setCameraRigs([spec()]);viewer.snapshot=scene();viewer.world=world();viewer.displayedFrame=frame(10);viewer.projection.setScene(viewer.snapshot);viewer.projection.setWorld(viewer.world);viewer.projection.push(frame(11));viewer.attachCameraRigGizmo('camera-a')
    let dto:any;viewer.onCameraRigEdit=(_key:string,edit:any)=>{dto=edit;return Promise.resolve()};await viewer.emitCameraRigEdit();expect(dto).toMatchObject({sceneId:'scene-a',revision:3,sceneRevision:3,worldId:'world-a',generation:7,frameId:'world-a:7:10',stepIndex:10,intrinsics:K,width:640,height:480,near:.05,far:100})
    viewer.world=undefined;viewer.displayedFrame=undefined;await viewer.emitCameraRigEdit();expect(dto.sceneId).toBe('scene-a');expect(dto.worldId).toBeUndefined();expect(dto.frameId).toBeUndefined()
  })
  test('TCP/base定位只读实际原生标志，不改机器人根，错作用域/缺TCP给明确不可用',()=>{
    const {viewer}=harness();viewer.snapshot=scene();viewer.world=world();viewer.displayedFrame=frame(10);viewer.displayedFrame.entities[0].sensors.tcp={positionM:[2,4,6],quaternionXyzw:[0,0,0,1]};viewer.displayedFrame.entities[0].sensors.robotBase={worldFromBody:{positionM:[1,3,5],quaternionXyzw:[0,0,0,1]}}
    const robot=new THREE.Group();robot.position.set(99,98,97);viewer.objects.set('robot-a',{group:robot})
    viewer.focusRobotAnchor('robot-a','tcp');expect(viewer.controls.target.distanceTo(new THREE.Vector3(2,4,6))).toBeLessThan(1e-9);viewer.focusRobotAnchor('robot-a','base');expect(viewer.controls.target.distanceTo(new THREE.Vector3(1,3,5))).toBeLessThan(1e-9);expect(robot.position.toArray()).toEqual([99,98,97])
    viewer.world.worldGeneration++;expect(()=>viewer.focusRobotAnchor('robot-a','tcp')).toThrow('VIEWER_ROBOT_ANCHOR_UNAVAILABLE')
  })
})
