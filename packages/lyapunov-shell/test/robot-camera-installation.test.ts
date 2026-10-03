import {describe,expect,test} from 'bun:test'
import * as THREE from 'three'
import type {SceneSnapshot,Frame,Entity,SceneCameraComponent} from '../../lyapunov-contracts/src/types.ts'
import {annotationAnchorAtHit,annotationAnchorOf,annotationAtCapture,resolveAnnotationWorld} from '../../viewer/src/annotations.ts'
import {capturePins} from '../src/capture-content.ts'
import {SceneViewer} from '../../viewer/src/index.ts'
import {frustumFromReceipt} from '../../viewer/src/camera-frustum.ts'
import {cameraForward,normalizeIntrinsics,quaternionAngleDeg} from '../../viewer/src/camera-view.ts'
import {cameraDraftFromInstallation,cameraQuaternionFromNormal} from '../src/camera-installation-input.ts'
import {cameraInstallationCommit,restoredCameraDraft} from '../src/camera-installation.ts'
import {applyCameraNavigation} from '../src/camera-navigation-actions.ts'
import {nativeCameraPreset} from '../../robot-tools/src/presets.ts'

const robot:Entity={entityId:'robot',name:'user robot',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}
const scene:SceneSnapshot={sceneId:'010',revision:7,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[robot]}
const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2).toArray() as [number,number,number,number]
const bodies=[{entityId:'robot',bodyName:'actual_wrist',worldFromBody:{positionM:[1,2,3] as [number,number,number],quaternionXyzw:q},frameId:'world:3:11',stepIndex:11}]
const scope={mount:{entityId:'robot',bodyName:'actual_wrist'},bodies,worldId:'world',generation:3,frameId:'world:3:11',stepIndex:11}
const K=normalizeIntrinsics({fx:610,fy:720,cx:341,cy:201,width:800,height:600})
const vector=(text:string)=>text.split(' ').map(Number)
const near=(a:number[],b:number[])=>a.forEach((n,i)=>expect(n).toBeCloseTo(b[i]!,9))

describe('010 明确机器人安装与真实批注',()=>{
 test('parent offset 和 world XYZ 正确转换，normal/up 采用相机 -Z；只新增相机不改机器人',()=>{
  const local=cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[.1,.2,.3],normal:[1,0,0],up:[0,0,1],fovYDeg:70},scope)
  near(vector(local.position),[.1,.2,.3]);near(cameraForward(vector(local.quaternion) as any),[1,0,0])
  const world=cameraDraftFromInstallation(scene,{referenceFrame:'world',positionM:[1,3,3],normal:[0,1,0]},scope)
  near(vector(world.position),[1,0,0]);near(cameraForward(vector(world.quaternion) as any),[1,0,0])
  const patch=cameraInstallationCommit(scene,local,bodies,'eye','manual').patch
  expect(patch).toHaveLength(1);expect(patch[0]?.op).toBe('add');expect(JSON.stringify(robot)).toBe(JSON.stringify(scene.entities[0]))
  if(patch[0]?.op!=='add')throw Error('expected add')
  expect((patch[0].entity.components.camera as SceneCameraComponent).mount?.bodyName).toBe('actual_wrist')
 })
 test('零normal、共线up、模糊参考/中心、缺body与异帧均拒绝',()=>{
  expect(()=>cameraDraftFromInstallation(scene,{positionM:[0,0,1]},scope)).toThrow('REFERENCE_REQUIRED')
  expect(()=>cameraDraftFromInstallation(scene,{},scope)).toThrow('POSITION_REQUIRED')
  expect(()=>cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[0,0,1]},scope)).toThrow('ORIENTATION_REQUIRED')
  for(const input of [{normal:[0,0,0]},{normal:[0,0,1],up:[0,0,2]},{normal:[0,1,0],quaternionXyzw:[0,0,0,1]},{positionM:[NaN,0,0]}])expect(()=>cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[0,0,1],...input} as any,scope)).toThrow()
  for(const opts of [{bodies:[]},{frameId:'world:3:10'},{stepIndex:10},{mount:{entityId:'robot',bodyName:'guessed_head'}},{bodies:[...bodies,...bodies]}])expect(()=>cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[0,0,1]}, {...scope,...opts})).toThrow('BODY_FRAME_REQUIRED')
 })
 test('direction-only 最短旋转保roll，完整K/基线在 FOV 编辑和 restore 后保留',()=>{
  const roll=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.7).toArray() as [number,number,number,number]
  expect(quaternionAngleDeg(cameraQuaternionFromNormal([0,0,-1],roll),roll)).toBeLessThan(1e-5)
  const first=cameraDraftFromInstallation(scene,{referenceFrame:'parent',positionM:[.1,0,.2],quaternionXyzw:roll,intrinsics:K},scope)
  const added=cameraInstallationCommit(scene,first,bodies,'eye','manual').patch[0]!
  if(added.op!=='add')throw Error('expected add')
  const existing=added.entity,current={...scene,entities:[robot,existing]}
  const changed=cameraDraftFromInstallation(current,{fovYDeg:85},{...scope,existing})
  const patch=cameraInstallationCommit(current,changed,bodies,'eye','manual').patch[0]!
  if(patch.op!=='update')throw Error('expected update')
  const edited=patch.changes.components!.camera as SceneCameraComponent
  expect(edited.intrinsics!.fx/edited.intrinsics!.fy).toBeCloseTo(K.fx/K.fy,10)
  expect(edited.intrinsics!.cx).toBe(K.cx);expect(edited.intrinsics!.cy).toBe(K.cy)
  expect(edited.mount?.positionM).toEqual([.1,0,.2])
  const restored=restoredCameraDraft({...existing,components:{camera:edited}})
  expect(restored.intrinsics).toEqual(K);expect(restored.quaternion).toBe(roll.join(' '))
 })
 test('真实hit祖先配同帧FK，批注随该body运动；同body local 直接安装，无root local猜测',()=>{
  const group=new THREE.Group(),wrist=new THREE.Group(),head=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial())
  group.add(wrist);wrist.add(head);head.add(mesh);head.position.set(1,2,3);head.quaternion.set(...q);group.updateWorldMatrix(true,true)
  const carrier={group,robot:{bodyNode:(name:string)=>name==='actual_wrist'?head:name==='ancestor'?wrist:undefined}}
  const frame:Frame={worldId:'world',generation:3,frameId:'world:3:11',stepIndex:11,simTime:.02,sceneRevision:7,entities:[{entityId:'robot',transform:robot.transform,sensors:{bodyWorldPoses:{ancestor:{positionM:[0,0,0],quaternionXyzw:[0,0,0,1]},actual_wrist:bodies[0]!.worldFromBody}}}]}
  const anchor=annotationAnchorAtHit('robot',carrier,mesh,new THREE.Vector3(1,3,3),new THREE.Vector3(0,1,0),scene,frame)
  expect(anchor.body?.bodyName).toBe('actual_wrist');near(anchor.body!.localM,[1.012,0,0]);near(anchor.body!.surfaceLocalM!,[1,0,0])
  const annotation={annotationId:'real-hit',index:1,text:'install eye',anchor},world=resolveAnnotationWorld(annotation,new Map([['robot',carrier]]))!
  near(world.toArray(),anchor.world)
  head.position.set(4,5,6);head.quaternion.identity();group.updateWorldMatrix(true,true)
  near(resolveAnnotationWorld(annotation,new Map([['robot',carrier]]))!.toArray(),[5.012,5,6])
  const movedFrame={...frame,frameId:'world:3:12',stepIndex:12,entities:[{entityId:'robot',transform:robot.transform,sensors:{bodyWorldPoses:{actual_wrist:{positionM:[4,5,6],quaternionXyzw:[0,0,0,1]}}}}]} as Frame
  const captured=annotationAtCapture(annotation,carrier,resolveAnnotationWorld(annotation,new Map([['robot',carrier]]))!,scene,movedFrame)
  near(captured.anchor.world,[5.012,5,6]);near(captured.anchor.normal!,[1,0,0]);expect(captured.anchor.body!.frameId).toBe(movedFrame.frameId)
  expect(capturePins([{annotationId:'real-hit',index:1,text:annotation.text,entityId:'robot',point:[50,50],normalized:[.5,.5],local:captured.anchor.local,world:captured.anchor.world}],{annotations:[{...captured,entityId:'robot'}],attachment:{width:100,height:100}} as any)?.[0]?.world).toEqual(captured.anchor.world)
  expect(()=>annotationAtCapture(annotation,carrier,new THREE.Vector3(),scene,{...movedFrame,generation:4})).toThrow('FRAME_REQUIRED')
  const draft=cameraDraftFromInstallation(scene,{annotationId:'real-hit',offsetM:[0,0,.01]},{...scope,annotation:{...annotation,entityId:'robot',sceneId:scene.sceneId,sceneRevision:scene.revision}})
  near(vector(draft.position),[1,0,.01]);near(cameraForward(vector(draft.quaternion) as any),[1,0,0])
  expect(annotationAnchorOf(JSON.parse(JSON.stringify(anchor)))).toEqual(anchor)
  expect(annotationAnchorAtHit('robot',carrier,mesh,new THREE.Vector3(),undefined,scene).body).toBeUndefined()
  for(const change of [{sceneRevision:6},{entityId:'another'},{anchor:{...anchor,body:{...anchor.body,generation:2}}}])expect(()=>cameraDraftFromInstallation(scene,{annotationId:'real-hit'},{...scope,annotation:{...annotation,entityId:'robot',sceneId:scene.sceneId,sceneRevision:scene.revision,...change} as any})).toThrow()
 })
 test('URDF预设完整源K/分辨率和原名字/光学局部姿态保留，不取临时override',()=>{
  const row={cameraName:'robot/calibrated',localName:'calibrated',cameraSource:'urdf',entityId:'robot',parentBodyName:'robot/actual_wrist',worldFromCamera:{positionM:[1,3,3],quaternionXyzw:q},intrinsics:{...K,width:640,height:480},declaredIntrinsicsPx:K,nearM:.01,farM:100,declaredNearM:.03,declaredFarM:50,worldId:'world',generation:3,frameId:'world:3:11',stepIndex:11,sceneRevision:7}
  const receipt={worldId:'world',generation:3,frameId:'world:3:11',stepIndex:11,sceneRevision:7,bodies:bodies.map(b=>({...b,worldId:'world',generation:3,sceneRevision:7}))}
  const preset=nativeCameraPreset(row,receipt,[robot]);expect(preset.intrinsics).toEqual(K);expect(preset.source).toBe('urdf');expect(preset.sourceCameraName).toBe(row.cameraName);expect(preset.near).toBe(.03);expect(preset.far).toBe(50);near(preset.pose.positionM,[1,0,0])
  expect(()=>nativeCameraPreset({...row,override:true},receipt,[robot])).toThrow('UNAVAILABLE')
 })
})

function viewerFixture(){
 const viewer:any=Object.create(SceneViewer.prototype),group=new THREE.Group(),body=new THREE.Group(),helper=new THREE.Group()
 group.add(body);body.position.set(1,2,3);body.updateWorldMatrix(true,true)
 viewer.scene=new THREE.Scene();viewer.cameraRigs=new Map();viewer.cameraRigRoot=new THREE.Group();viewer.objects=new Map([['robot',{group,robot:{bodyNode:(name:string)=>name==='actual_wrist'?body:undefined}}]])
 viewer.camera=new THREE.PerspectiveCamera();viewer.controls={enabled:true};viewer.transformControls={object:undefined,enabled:true,attach(object:any){this.object=object},detach(){this.object=undefined},getHelper:()=>helper}
 viewer.firstPerson={active:false,setActive(value:boolean){this.active=value},clearInput(){}}
 const main={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,1],navigation:'orbit'};viewer.getViewState=()=>main
 const applied:any[]=[],restored:any[]=[];viewer.applyCameraView=(request:any)=>{applied.push(request);viewer.camera.position.set(...request.position);viewer.camera.quaternion.set(...request.quaternion)};viewer.setViewState=(state:any)=>restored.push(state);viewer.setCaptureGate=()=>{}
 const spec=frustumFromReceipt({cameraName:'eye',entityId:'eye',parentEntityId:'robot',parentBodyName:'actual_wrist',parentFromCamera:{positionM:[.1,.2,.3],quaternionXyzw:[0,0,0,1]},worldFromCamera:{positionM:[1.1,2.2,3.3],quaternionXyzw:[0,0,0,1]},intrinsics:K,nearM:.03,farM:50})
 if(!spec.ok)throw Error('invalid fixture');viewer.setCameraRigs([spec.spec]);viewer.selectCameraRig('eye')
 return {viewer,body,main,applied,restored,spec:spec.spec,helper}
}
describe('010 单一Viewer编辑会话的原点锁位',()=>{
 test('进入锁位、body运动跟随局部offset；原点/箭头可见，旋转与FOV同一ACK保存',async()=>{
  const {viewer,body,applied,restored,main,helper}=viewerFixture(),rig=viewer.cameraRigs.get('eye')
  expect(rig.group.getObjectByName('camera-install-origin')).toBeDefined();expect(rig.group.getObjectByName('camera-view-normal')).toBeDefined()
  viewer.aimCameraRig('eye');expect(viewer.observerState().positionLocked).toBe(true);expect(viewer.firstPerson.rotationOnly).toBe(true);expect(viewer.controls.enabled).toBe(false);expect(helper.visible).toBe(false)
  body.position.set(7,8,9);body.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);body.updateWorldMatrix(true,true);viewer.applyCameraRigLook()
  near(applied.at(-1).position,[6.8,8.1,9.3]);expect(rig.group.position.toArray()).toEqual([.1,.2,.3])
  viewer.camera.quaternion.setFromAxisAngle(new THREE.Vector3(1,0,0),.4);viewer.firstPerson.onRotate();expect(viewer.observerState().dirty).toBe(true)
  viewer.setCameraRigAimFov(80);const edits:any[]=[];viewer.onCameraRigEdit=async(_key:string,edit:any)=>{edits.push(edit)}
  await viewer.finishCameraRigEditing({discard:false});expect(edits).toHaveLength(1);expect(edits[0].localPose.positionM).toEqual([.1,.2,.3]);expect(edits[0].intrinsics.fx/edits[0].intrinsics.fy).toBeCloseTo(K.fx/K.fy,9);expect(edits[0].intrinsics.cx).toBe(K.cx)
  expect(viewer.observerState().mode).toBe('free');expect(viewer.firstPerson.rotationOnly).toBe(false);expect(viewer.controls.enabled).toBe(true);expect(restored).toEqual([main]);expect(helper.visible).toBe(true)
 })
 test('Esc/返回放弃同一草稿；切Scene清理不会把旧Scene返回位写入新Scene',()=>{
  const {viewer,restored,main,spec}=viewerFixture()
  viewer.aimCameraRig('eye');viewer.setCameraRigAimFov(90);viewer.exitCameraMode()
  expect(restored).toEqual([main]);expect(viewer.observerState().dirty).toBe(false);expect(viewer.cameraRigs.get('eye').lines.geometry.getAttribute('position').count).toBeGreaterThan(0)
  viewer.aimCameraRig('eye');viewer.exitCameraMode({restoreView:false});expect(restored).toEqual([main])
  viewer.aimCameraRig('eye');viewer.setCameraRigs([]);expect(viewer.observerState().mode).toBe('free');expect(viewer.observerState().positionLocked).toBeUndefined()
  viewer.setCameraRigs([spec]);const rig=viewer.cameraRigs.get('eye');expect(rig.group.position.toArray()).toEqual([.1,.2,.3])
 })
 test('NL入口解析真实cameraId/Scene实体，前台/只读/过期Scene和不存在key拒绝',()=>{
  const {viewer}=viewerFixture(),calls:string[]=[]
  const ports={clientId:'window',ownsSurface:()=>true,viewerVisible:()=>true,scene:()=>scene,viewer:()=>viewer,ui:{showCentre:()=>{},openTool:(value:string)=>calls.push(value)},selectEntity:()=>{}}
  expect(applyCameraNavigation({action:'aimCameraView',cameraId:'eye',sceneId:'010'},ports).applied).toBe(true);expect(calls).toEqual(['camera'])
  expect(applyCameraNavigation({action:'aimCameraView',cameraId:'eye',clientId:'other'},ports).disposition).toBe('foreign')
  expect(()=>applyCameraNavigation({action:'aimCameraView',cameraId:'guess'},ports)).toThrow('UNAVAILABLE')
  expect(()=>applyCameraNavigation({action:'aimCameraView',cameraId:'eye',sceneId:'stale'},ports)).toThrow('SCENE_STALE')
  expect(()=>applyCameraNavigation({action:'aimCameraView',cameraId:'eye'},{...ports,readOnly:()=>true})).toThrow('READ_ONLY')
  viewer.exitCameraMode();viewer.snapshot=scene;viewer.world={worldId:'world',sceneId:scene.sceneId,worldGeneration:3,appliedSceneRevision:scene.revision,status:'ready'}
  expect(()=>viewer.aimCameraRig('eye')).toThrow('BODY_FRAME_REQUIRED')
 })
})
