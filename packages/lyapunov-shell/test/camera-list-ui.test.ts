/**
 * 相机清单面板的**判据**（`capture-panel.tsx` 的 `cameraStatus`/`selectableCameras`）：哪些条目能勾选采集、
 * 不可用的条目拿什么原因显示。判据只有一条来源——`frustumFromReceipt`（可用位姿＋K 的跨引擎合同），
 * UI 不另立第二套可用性口径，也不给缺位姿/K 的条目编一个视锥出来。
 *
 * 诚实边界（不冒充已完成）：本仓**没有**浏览器 DOM 夹具（无 happy-dom/jsdom/linkedom），所以这里跑的是
 * 面板用的**判据函数**，不是渲染出来的界面——"点勾选/看见原因"的真机验收见回执的未验证项（PARTIAL）。
 * 运行：`bun test packages/lyapunov-shell/test/camera-list-ui.test.ts`
 */
import { describe, expect, test } from 'bun:test'
import { adoptableReceipt, adjustAppliedRefreshFailedMessage, cameraListSequencer, cameraRigSpecs, cameraStatus, cameraWorldKey, emptyCameraScope, nextCameraSelection, receiptGenerationText, receiptMatchesWorld, receiptWorldKey, scopeAfterFailedListRefresh, scopedPatch, selectableCameras, stillCurrentWorld, usableCameraSpec, visibleCameraScope, type CameraScope, type CameraWorldIdentity } from '../src/capture-panel.tsx'
import {cameraMountBodies,sceneCameraCommit,sceneCameraDraftOf,sceneCamerasOfScene} from '../src/workbench-camera.ts'
import type {Entity,SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import * as THREE from 'three'
import {describeCameraView,projectionMatrixFromIntrinsics,cameraStateFromView} from '../../viewer/src/camera-view.ts'
import {cameraDraftFromRigEdit,cameraDraftFromSample,type CameraAuthoringSnapshot} from '../src/camera-authoring.ts'
import {sceneCameraDraftAtBody} from '../src/workbench-camera.ts'
import {cameraDraftOfScene,cameraInstallationCommit,restoredCameraDraft} from '../src/camera-installation.ts'
import {projectSceneCameraRigs} from '../../viewer/src/scene-camera-rigs.ts'
import {nativeCameraPreset,readRobotPresets,robotPresetProjection} from '../../robot-tools/src/presets.ts'
import {SceneStore} from '../../scene-kit/src/store.ts'
import {atomicJSON} from '../../scene-kit/src/persistence.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {renderToStaticMarkup} from 'react-dom/server'
import {createElement} from 'react'
import {SceneCameraPanel} from '../src/scene-camera-panel.tsx'
import type {SimWorlds,RobotDescription} from '../../sim-contract/src/index.ts'
import type {SceneCameraComponent} from '../../lyapunov-contracts/src/types.ts'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'

/** 两台引擎交出来的条目形状（Isaac：`available`+`reason`；MuJoCo：没有 `available` 字段，位姿/K 在就可用）。 */
const ISAAC_READY = { cameraName: 'e1/wrist', entityId: 'e1', localName: 'wrist', parentBodyName: 'link6', referenceFrame: 'parent',
  available: true, intrinsicsSource: 'usd-camera-focalLength-aperture', poseSource: 'usd-xformcache-readback',
  intrinsics: { fx: 554.256, fy: 554.256, cx: 319.5, cy: 239.5, width: 640, height: 480, fovyDeg: 45 },
  worldFromCamera: { positionM: [0.4, -0.2, 0.9], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }
const ISAAC_REJECTED = { cameraName: 'e1/gripper', entityId: 'e1', localName: 'gripper', parentBodyName: 'link6',
  available: false, reason: '当前Profile未启动RTX：该相机的原生prim未导入' }
const MUJOCO_READY = { cameraName: 'arm-a/cam_mono', entityId: 'arm-a', localName: 'cam_mono', parentBodyName: 'arm-a/head',
  intrinsicsSource: 'fovy', fovyDeg: 45,
  intrinsics: { fx: 579.4, fy: 579.4, cx: 319.5, cy: 239.5, width: 640, height: 480, fovyDeg: 45 },
  worldFromCamera: { positionM: [0.05, -0.08, 0.82], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }

describe('R-015 场景相机创建与真实 body 标定',()=>{
 const robot:Entity={entityId:'arm-a',name:'机械臂',transform:{position:[1,2,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{kind:'arm'}}}
 const scene:SceneSnapshot={sceneId:'camera-scene',revision:7,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[robot]}
 const bodies=[{entityId:'arm-a',bodyName:'wrist',worldFromBody:{positionM:[1,2,1] as [number,number,number],quaternionXyzw:[0,0,0,1] as [number,number,number,number]}}]
 test('新相机经 Scene CAS 新增，保存世界米制 pose、FOV 与像素 K',()=>{
  const draft={...sceneCameraDraftOf(),name:'侧视',position:'1 2 3',quaternion:'0 0 0 2',fovYDeg:'60',width:'800',height:'600'}
  const input=sceneCameraCommit(scene,draft,bodies,'camera-a')
  expect(input.sceneId).toBe(scene.sceneId);expect(input.expectedRevision).toBe(7)
  const patch=input.patch[0]!;expect(patch.op).toBe('add')
  if(patch.op!=='add')throw new Error('应新增')
  expect(patch.entity.transform).toEqual({position:[1,2,3],quaternion:[0,0,0,1],scale:[1,1,1]})
  const camera=sceneCamerasOfScene([patch.entity])[0]!.component
  expect(camera.mount).toBeUndefined();expect(camera.intrinsics?.width).toBe(800);expect(camera.intrinsics?.height).toBe(600)
  expect(camera.intrinsics?.fy).toBeCloseTo(600/(2*Math.tan(Math.PI/6)),10)
 })
 test('挂载只能选择当前实体内唯一的实际 body，局部安装标定随 Scene 保存重开',()=>{
  const draft={...sceneCameraDraftOf(),name:'腕部',parentEntityId:'arm-a',bodyName:'wrist',position:'0.02 -0.03 0.04',quaternion:'0 0 1 1'}
  const input=sceneCameraCommit(scene,draft,[...bodies,{...bodies[0]!,entityId:'arm-b'}],'camera-a'),patch=input.patch[0]!
  if(patch.op!=='add')throw new Error('应新增')
  const reopened=sceneCamerasOfScene(JSON.parse(JSON.stringify([patch.entity])))[0]!
  expect(reopened.component.mount?.entityId).toBe('arm-a');expect(reopened.component.mount?.bodyName).toBe('wrist')
  expect(reopened.component.mount?.positionM).toEqual([0.02,-0.03,0.04])
  expect(sceneCameraDraftOf(reopened.entity).parentEntityId).toBe('arm-a');expect(sceneCameraDraftOf(reopened.entity).position).toBe('0.02 -0.03 0.04')
  expect(()=>sceneCameraCommit(scene,draft,[],'camera-a')).toThrow('原生读回')
  expect(()=>sceneCameraCommit(scene,draft,[...bodies,...bodies],'camera-a')).toThrow('不唯一')
 })
 test('编辑相机保留资源与其它组件，明确保存的 CAS revision 不绕过并发写入',()=>{
  const entity:Entity={...robot,entityId:'camera-a',components:{camera:{fovYDeg:50},annotation:{keep:true}},resources:[{resourceId:'r',version:1,original:{uri:'file:///fixture',mimeType:'text/plain'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}]}
  const input=sceneCameraCommit({...scene,entities:[robot,entity]}, {...sceneCameraDraftOf(entity),position:'2 3 4'},bodies,'camera-a'),patch=input.patch[0]!
  if(patch.op!=='update')throw new Error('应更新')
  expect(patch.changes.components?.annotation).toEqual({keep:true});expect(patch.changes.resources).toBeUndefined();expect(input.expectedRevision).toBe(7)
 })
 test('body 候选只从 native 清单及当前 Scene owner 产生，不编节点或吞歧义',()=>{
  const rows=cameraMountBodies({bodies:[...bodies,...bodies,{entityId:'outside-scene',bodyName:'head'}, {entityId:'arm-a',bodyName:2}]},scene.entities)
  expect(rows.map(row=>row.bodyName)).toEqual(['wrist','wrist']);expect(rows[0]?.worldFromBody?.positionM).toEqual([1,2,1])
  expect(cameraMountBodies({cameras:[MUJOCO_READY]},scene.entities)).toEqual([])
 })
 test('非法旋转、光学或像素声明拒绝，不保存默认替代值',()=>{
  const draft=sceneCameraDraftOf()
  for(const change of [{quaternion:'0 0 0 0'},{position:'1 2'},{width:'600.1'},{height:'0'},{fovYDeg:'180'},{near:'2',far:'1'}])expect(()=>sceneCameraCommit(scene,{...draft,...change},bodies,'camera-a')).toThrow()
 })
})

describe('A08 保存当前画面与同一已显示Frame安装',()=>{
 const robot:Entity={entityId:'arm',name:'机械臂',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}
 const scene:SceneSnapshot={sceneId:'current-view',revision:3,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[robot]}
 const world={worldId:'world',sceneId:scene.sceneId,engineId:'mujoco',engineVersion:'test',worldGeneration:4,appliedSceneRevision:3,status:'ready' as const}
 const sample=():CameraAuthoringSnapshot=>{
  const camera=new THREE.PerspectiveCamera(50,800/600,.03,4321);camera.position.set(5,6,7);camera.quaternion.setFromEuler(new THREE.Euler(.2,.3,.4))
  camera.projectionMatrix.fromArray(projectionMatrixFromIntrinsics({fx:830,fy:720,cx:405.25,cy:291.5,width:800,height:600},camera.near,camera.far))
  return {sceneId:scene.sceneId,sceneRevision:3,worldId:'world',generation:4,frameId:'world:4:15',stepIndex:15,view:cameraStateFromView(camera,{width:800,height:600},[0,0,0]),camera:describeCameraView(camera,{width:800,height:600}),bodies:[{entityId:'arm',bodyName:'wrist',worldFromBody:{positionM:[1,2,3],quaternionXyzw:[0,0,0,1]},frameId:'world:4:15',stepIndex:15}]}
 }
 test('无world保存世界画面，真实pose/偏心非方形像素K/裁剪和重开都保留',()=>{
  const shot=sample(),draft=cameraDraftFromSample(scene,shot),commit=sceneCameraCommit(scene,draft,[],'saved')
  const patch=commit.patch[0]!;if(patch.op!=='add')throw Error('未新增')
  const reopened=sceneCamerasOfScene(JSON.parse(JSON.stringify([patch.entity])))[0]!
  expect(patch.entity.transform.position).toEqual([5,6,7]);expect(patch.entity.transform.quaternion).toEqual(shot.camera.quaternion)
  expect(reopened.component.mount).toBeUndefined();expect(reopened.component.near).toBe(.03);expect(reopened.component.far).toBe(4321)
  for(const key of ['fx','fy','cx','cy','width','height']as const)expect(reopened.component.intrinsics![key]).toBeCloseTo(shot.camera.intrinsics[key],10)
  expect(sceneCameraDraftOf(reopened.entity).intrinsics).toEqual(reopened.component.intrinsics)
 })
 test('当前画面挂wrist保存瞬间不吸原点，原负例world5/6/7对应local4/4/4',()=>{
  const shot=sample(),draft=cameraDraftFromSample(scene,shot,{world,mount:{entityId:'arm',bodyName:'wrist'}})
  expect(draft.position).toBe('4 4 4');expect(draft.quaternion).toBe(shot.camera.quaternion.join(' '))
  expect(sceneCameraDraftAtBody(robot,shot.bodies!,'wrist',shot.view).position).toBe('4 4 4')
  expect(()=>sceneCameraDraftAtBody(robot,shot.bodies!,'wrist')).toThrow('真实位姿')
 })
 test('Frame或Scope不一致拒绝，不与最新轮询body拼出虚假同帧安装',()=>{
  for(const change of [{sceneId:'other'},{sceneRevision:2},{generation:3},{frameId:'world:4:14'},{stepIndex:14}])expect(()=>cameraDraftFromSample(scene,{...sample(),...change},{world,mount:{entityId:'arm',bodyName:'wrist'}})).toThrow()
  expect(()=>cameraDraftFromSample(scene,sample(),{mount:{entityId:'arm',bodyName:'wrist'}})).toThrow('同代次')
  expect(()=>cameraDraftFromSample(scene,{...sample(),bodies:[]},{world,mount:{entityId:'arm',bodyName:'wrist'}})).toThrow('唯一')
 })
 test('真实SceneStore持久安装、编辑与重开保留首次基线，restore恢复完整pose/K',async()=>{
  const root=await mkdtemp(join(tmpdir(),'a08-camera-installation-')),store=new SceneStore(root)
  try{
   await atomicJSON(store.path(scene.sceneId),scene)
   const shot=sample(),first=await store.commit(cameraInstallationCommit(scene,cameraDraftFromSample(scene,shot),[],'saved','current-view'))
   const original=first.entities.find(entity=>entity.entityId==='saved')!,baseline=(original.components.camera as SceneCameraComponent).installation!
   const changed=await store.commit(cameraInstallationCommit(first,{...sceneCameraDraftOf(original),position:'9 8 7',width:'1000',height:'750',fovYDeg:'65'},[],'saved','manual'))
   const reopened=await new SceneStore(root).snapshot(scene.sceneId),edited=reopened.entities.find(entity=>entity.entityId==='saved')!
   expect(reopened.revision).toBe(changed.revision);expect(edited.transform.position).toEqual([9,8,7]);expect((edited.components.camera as SceneCameraComponent).installation).toEqual(baseline)
   const restored=await store.commit(cameraInstallationCommit(reopened,restoredCameraDraft(edited),[],'saved','scene-baseline'))
   const camera=restored.entities.find(entity=>entity.entityId==='saved')!
   expect(camera.transform.position).toEqual(shot.camera.position);expect(camera.transform.quaternion).toEqual(shot.camera.quaternion)
   for(const key of ['fx','fy','cx','cy','width','height']as const)expect((camera.components.camera as SceneCameraComponent).intrinsics![key]).toBeCloseTo(shot.camera.intrinsics[key],10)
   expect((camera.components.camera as SceneCameraComponent).near).toBe(.03);expect((camera.components.camera as SceneCameraComponent).far).toBe(4321)
   await expect(store.commit(cameraInstallationCommit(reopened,restoredCameraDraft(edited),[],'saved','scene-baseline'))).rejects.toThrow('请求基于')
   expect(await store.snapshot(scene.sceneId)).toEqual(restored)
  }finally{await rm(root,{recursive:true,force:true})}
 })
 test('原有Scene父层级的世界机位编辑反解局部TRS，已有基线保原世界安装',()=>{
  const shot=sample(),q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2)
  const parent:Entity={...robot,entityId:'parent',transform:{position:[1,2,3],quaternion:q.toArray(),scale:[2,2,2]}}
  const original:Entity={...robot,entityId:'camera',parentId:'parent',transform:{position:[.1,.2,.3],quaternion:[0,0,0,1],scale:[1,1,1]},components:{camera:{name:'child',fovYDeg:50,width:800,height:600,near:.03,far:4321,intrinsics:shot.camera.intrinsics}}}
  const hierarchy={...scene,entities:[parent,original]},prior=cameraDraftOfScene(hierarchy,original)
  const commit=cameraInstallationCommit(hierarchy,{...prior,position:'4 5 6',quaternion:shot.camera.quaternion.join(' ')},[],'camera','manual'),patch=commit.patch[0]!
  if(patch.op!=='update')throw Error('未更新')
  const changed={...original,...patch.changes},next={...hierarchy,entities:[parent,changed]},rig=projectSceneCameraRigs(next)[0]!
  for(let i=0;i<3;i++)expect(rig.positionM[i]).toBeCloseTo([4,5,6][i]!,10)
  const baseline=(changed.components.camera as SceneCameraComponent).installation!.baseline
  for(let i=0;i<3;i++)expect(baseline.positionM[i]).toBeCloseTo(Number(prior.position.split(' ')[i]),10)
  expect(changed.parentId).toBe('parent');expect(parent.transform.scale).toEqual([2,2,2])
 })
 test('gizmo世界相机无World仍可保存；挂载编辑须同scope完整K、父owner与局部pose',()=>{
  const shot=sample(),p=sceneCameraCommit(scene,cameraDraftFromSample(scene,shot),[],'saved').patch[0]!
  if(p.op!=='add')throw Error('未新增')
  const edit={sceneId:scene.sceneId,revision:scene.revision,worldPose:{positionM:[8,9,10],quaternionXyzw:shot.camera.quaternion},intrinsics:shot.camera.intrinsics,width:800,height:600,near:.03,far:4321}
  expect(cameraDraftFromRigEdit(scene,undefined,p.entity,edit).position).toBe('8 9 10')
  const mounted={...p.entity,components:{camera:{...p.entity.components.camera as SceneCameraComponent,mount:{entityId:'arm',bodyName:'wrist',positionM:[4,4,4],quaternionXyzw:shot.camera.quaternion}}}}
  const local={...edit,worldId:'world',generation:4,frameId:'world:4:15',stepIndex:15,parentEntityId:'arm',parentBodyName:'arm/wrist',localPose:{positionM:[.1,.2,.3],quaternionXyzw:shot.camera.quaternion}}
  expect(cameraDraftFromRigEdit(scene,world,mounted,local).position).toBe('0.1 0.2 0.3')
  for(const change of [{revision:2},{worldId:'other'},{generation:3},{frameId:undefined},{parentEntityId:'other'},{parentBodyName:'other/wrist'},{localPose:undefined},{width:640},{near:0}])expect(()=>cameraDraftFromRigEdit(scene,world,mounted,{...local,...change})).toThrow()
 })
 test('SSR世界相机保存入口无World可用，并显示当前画面自动采样；不是GUI验收',()=>{
  const markup=renderToStaticMarkup(createElement(SceneCameraPanel,{api:{clientId:'window'}as any,scene,readOnly:false,tr:(zh:string)=>zh,perform:()=>{},commit:async()=>scene,sampleCurrent:sample,saveInstallation:async()=>({snapshot:scene,entityId:'saved'}),pilot:()=>{},returnView:()=>{},selectCamera:()=>{},prepareWorld:async()=>undefined,sceneSpecs:[],refresh:async()=>undefined}))
  expect(markup).toContain('保存时自动采当前完整画面');expect(markup).toContain('>保存固定相机</button>');expect(markup).not.toContain('disabled="">保存固定相机')
 })
 test('组件effect/事件夹具：选机器人、打开/新建/保存世界相机均不prepare；明确挂载才prepare',()=>{
  // 隔离进程替换hooks，执行真实组件的effect与事件；无DOM/Kit，不能签原生冷启动或像素。
  const script=`
   import {mock} from 'bun:test'; import * as react from 'react'; import * as THREE from 'three';
   const cells=[];let index=0,changed=false,effects=[];
   const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
   mock.module('react',()=>({...react,
    useState(init){const i=index++;cells[i]??={value:typeof init==='function'?init():init};return[cells[i].value,value=>{const next=typeof value==='function'?value(cells[i].value):value;if(!Object.is(next,cells[i].value)){cells[i].value=next;changed=true}}]},
    useRef(value){const i=index++;cells[i]??={ref:{current:value}};return cells[i].ref},
    useCallback(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={value:fn,deps};return cells[i].value},
    useEffect(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const old=cells[i];cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=fn()})}}
   }));
   const {SceneCameraPanel}=await import('./packages/lyapunov-shell/src/scene-camera-panel.tsx');
   const {describeCameraView,cameraStateFromView}=await import('./packages/viewer/src/camera-view.ts');
   const scene={sceneId:'static-with-robot',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'arm',name:'arm',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]};
   const camera=new THREE.PerspectiveCamera(50,640/480,.02,2345);camera.position.set(5,6,7);camera.quaternion.setFromEuler(new THREE.Euler(.2,.3,.4));
   const sample={sceneId:scene.sceneId,sceneRevision:1,view:cameraStateFromView(camera,{width:640,height:480},[0,0,0]),camera:describeCameraView(camera,{width:640,height:480})};
   let prepareCalls=0,saveCalls=[],tasks=[],tree;
   const props={api:{clientId:'component-window'},scene,selectedRobotEntityId:'arm',readOnly:false,tr:zh=>zh,perform:fn=>{tasks.push(fn())},commit:async()=>scene,sampleCurrent:()=>sample,saveInstallation:async input=>{saveCalls.push(input);return{snapshot:scene,entityId:input.entityId}},pilot:()=>{},returnView:()=>{},selectCamera:()=>{},prepareWorld:async()=>{prepareCalls++;return undefined},sceneSpecs:[],refresh:async()=>undefined};
   async function render(){for(let i=0;i<20;i++){index=0;changed=false;effects=[];tree=SceneCameraPanel(props);for(const effect of effects)effect();await Promise.resolve();if(!changed)return}throw Error('组件夹具effect未收敛')}
   function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return[];return[value,...nodes(value.props?.children)]}
   function text(value){if(Array.isArray(value))return value.map(text).join('');if(value&&typeof value==='object')return text(value.props?.children);return typeof value==='string'?value:''}
   const button=label=>{const target=nodes(tree).find(node=>node.type==='button'&&text(node)===label);if(!target||target.props.disabled)throw Error('按钮不可用:'+label);return target};
   await render();const opened=prepareCalls;
   button('从当前视角新建世界相机').props.onClick();await render();const worldNew=prepareCalls;
   button('保存固定相机').props.onClick();await Promise.all(tasks.splice(0));await render();const worldSave=prepareCalls;
   button('把当前画面挂到所选机器人').props.onClick();await Promise.all(tasks.splice(0));await render();
   console.log(JSON.stringify({opened,worldNew,worldSave,explicitMount:prepareCalls,mode:saveCalls[0]?.mode,hasMount:Boolean(saveCalls[0]?.mount),hasPrepareButton:nodes(tree).some(node=>node.type==='button'&&text(node)==='读取真实连杆（需物理）')}));
  `
  const result=spawnSync(process.execPath,['--no-env-file','--eval',script],{cwd:resolve(import.meta.dir,'../../..'),encoding:'utf8',timeout:10000})
  if(result.status!==0)throw Error(result.stderr||result.stdout||'组件夹具失败')
  const value=JSON.parse(result.stdout.trim())
  expect(value).toEqual({opened:0,worldNew:0,worldSave:0,explicitMount:1,mode:'current-view',hasMount:false,hasPrepareButton:true})
 })
 test('原生camera preset只采用同帧真实owner/原光学；override/错帧/缺clip不作源安装',()=>{
  const shot=sample(),identity={worldId:'world',generation:4,sceneRevision:3,frameId:shot.frameId,stepIndex:15}
  const row={...identity,cameraName:'arm/wrist_cam',localName:'wrist_cam',cameraSource:'mjcf',entityId:'arm',parentEntityId:'arm',parentBodyName:'arm/wrist',worldFromCamera:{positionM:shot.camera.position,quaternionXyzw:shot.camera.quaternion},intrinsics:shot.camera.intrinsics,nearM:.03,farM:4321,override:false}
  const receipt={...identity,cameras:[row],bodies:shot.bodies!.map(body=>({...identity,...body}))},preset=nativeCameraPreset(row,receipt,scene.entities)
  expect(preset.pose.positionM).toEqual([4,4,4]);expect(preset.mount).toEqual({entityId:'arm',bodyName:'wrist'});expect(preset.source).toBe('mjcf');expect(preset.intrinsics).toEqual(shot.camera.intrinsics)
  for(const change of [{override:true},{cameraSource:'scene-camera'},{frameId:'other'},{parentEntityId:'other'},{farM:undefined},{intrinsics:undefined}])expect(()=>nativeCameraPreset({...row,...change},receipt,scene.entities)).toThrow()
  expect(()=>nativeCameraPreset(row,{...receipt,bodies:receipt.bodies.map(body=>({...body,stepIndex:14}))},scene.entities)).toThrow('同帧')
 })
 test('无site/无camera描述仅给人工真实候选，不注册通用Panda TCP或手腕安装',()=>{
  const description={entityId:'arm',expectedGeneration:4,modelVersion:'fixture',collisionContextVersion:'fixture',joints:[],controlledJointNames:[],nativeBodies:[{name:'hand',root:false,jointTypes:[]}],nativeSites:[]} satisfies RobotDescription
  const projected=robotPresetProjection(scene,description)
  expect(projected.tcp.configured).toBeNull();expect(projected.tcp.sites).toEqual([]);expect(projected.tcp.source).toBe('unset');expect(projected.nativeBodies[0]!.name).toBe('hand');expect(projected.cameras.presets).toEqual([]);expect(projected.cameras.reason).toContain('当前画面标定')
  expect(JSON.parse(JSON.stringify(projected))).toEqual(projected)
 })
 test('只读robot_presets保留真实site候选/源base，camera缺能力有具体原因；世代变更拒回执',async()=>{
  let handle:import('../../lyapunov-contracts/src/types.ts').WorldHandle={...world},calls=0
  const description={entityId:'arm',expectedGeneration:4,modelVersion:'fixture',collisionContextVersion:'fixture',joints:[],controlledJointNames:[],nativeBodies:[{name:'hand',root:false,jointTypes:[]}],nativeSites:[{name:'existing',bodyName:'hand',positionM:[.01,0,.02],quaternionXyzw:[0,0,0,1]}]} satisfies RobotDescription
  const sim={listWorlds:async()=>[handle],describe:async()=>description,listCameras:async()=>{calls++;throw Error('UNSUPPORTED_CAPABILITY: no camera channel')}}as unknown as SimWorlds
  const input={worldId:'world',sceneId:scene.sceneId,expectedRevision:3,expectedGeneration:4,entityId:'arm'}
  const value=await readRobotPresets(sim,{snapshot:()=>scene,commit:()=>{throw Error('不允许写')}},input)
  expect(value.tcp.sites).toEqual(description.nativeSites);expect(value.cameras.presets).toEqual([]);expect(value.cameras.reason).toContain('UNSUPPORTED_CAPABILITY');expect(calls).toBe(1)
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  handle={...handle,status:'closed'};await expect(readRobotPresets(sim,{snapshot:()=>scene,commit:()=>scene},input)).rejects.toThrow('ROBOT_PRESETS_STALE');expect(calls).toBe(1)
 })
})

describe('相机清单 UI 判据：能勾的、不能勾的、原因从哪来', () => {
  test('合同完整且引擎没拒 ⇒ 可勾选；`cameraStatus` 给出待画的 spec', () => {
    for (const row of [ISAAC_READY, MUJOCO_READY]) {
      const status = cameraStatus(row)
      expect(status.ok).toBe(true)
      expect(status.reason).toBeUndefined()
      expect(status.rig.ok && status.rig.spec.key).toBe(row.cameraName)
      expect(selectableCameras([row])).toHaveLength(1)
    }
  })

  test('引擎明确拒绝（available:false）⇒ 不可勾选，原因是回执自己的 reason', () => {
    const status = cameraStatus(ISAAC_REJECTED)
    expect(status.ok).toBe(false)
    expect(status.reason).toBe('当前Profile未启动RTX：该相机的原生prim未导入')
    expect(selectableCameras([ISAAC_REJECTED])).toHaveLength(0)
  })

  test('位姿/K 缺一截 ⇒ 不可勾选，原因是**合同**给的拒绝原因（不猜、不画锥）', () => {
    const noPose = { ...ISAAC_READY, worldFromCamera: undefined }
    const noK = { ...ISAAC_READY, intrinsics: undefined, fovyDeg: undefined }
    expect(cameraStatus(noPose).reason).toContain('worldFromCamera')
    expect(cameraStatus(noK).reason).toContain('缺 intrinsics')
    expect(selectableCameras([noPose, noK])).toHaveLength(0)
  })

  test('available 缺失（MuJoCo 形状）不影响可用性：只有合同说了才算；引擎的拒绝优先于数据齐全', () => {
    expect(selectableCameras([{ ...MUJOCO_READY, available: undefined }])).toHaveLength(1)
    // 引擎说不可用、但条目里恰好带着完整位姿/K：仍然不可勾选（引擎的判定优先，不让 UI 把拒绝变成采集）。
    const rejectedButComplete = { ...ISAAC_READY, available: false, reason: '该相机在 RTX Profile 下不可用' }
    expect(cameraStatus(rejectedButComplete).rig.ok).toBe(true) // 数学合同完整，但产品状态必须尊重引擎拒绝。
    expect(cameraStatus(rejectedButComplete).ok).toBe(false)
    expect(cameraStatus(rejectedButComplete).reason).toBe('该相机在 RTX Profile 下不可用')
    expect(usableCameraSpec(rejectedButComplete)).toBeUndefined() // 但去向判据答"不可用"：引擎拒了就不勾、不画
    expect(selectableCameras([rejectedButComplete])).toHaveLength(0)
  })

  test('fovy-only 条目可用，但如实标成派生 K（不是标定事实）', () => {
    const derived = { cameraName: 'arm-a/cam_old', entityId: 'arm-a', parentBodyName: 'arm-a/head', fovyDeg: 30,
      worldFromCamera: { positionM: [0, 0, 1], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }
    const status = cameraStatus(derived)
    expect(status.ok).toBe(true)
    expect(status.rig.ok && status.rig.spec.intrinsicsSource).toBe('fovy-derived')
    expect(status.rig.ok && status.rig.spec.notes?.join('')).toContain('按 fovy 派生')
    expect(selectableCameras([derived])).toHaveLength(1)
  })
})

/**
 * 面板状态与 world 身份的绑定（同一份 `capture-panel.tsx`）：清单/勾选/多视角/标注/导出/调整回执
 * 全都是**某一个 world 的事实**——身份（场景＋修订＋world＋代次）一变就整块作废，迟到的旧请求不许写回新 world。
 * 这里量的是判据函数本身；"渲染出来的界面"仍未真机验收（无 DOM 夹具，见文件头）。
 */
const WORLD_A: CameraWorldIdentity = { sceneId: 'scene-1', sceneRevision: 7, worldId: 'w-a', worldGeneration: 3 }
const WORLD_B: CameraWorldIdentity = { ...WORLD_A, worldId: 'w-b' }
/**
 * 回执形状照**真实返回**（`plugin.ts` + 两台引擎 worker 的 base）：
 * 清单与调整回执都带 `worldId`/`generation`/`sceneRevision`（`sceneId` 由 Shell 边界补上），
 * `camera_capture_multi_ui`/`camera_dataset_export_ui` 另外报 `worldGeneration`——两个键名同一件事。
 */
const listReceipt = (world: CameraWorldIdentity, cameras: any[]) => ({ sceneId: world.sceneId, sceneRevision: world.sceneRevision, worldId: world.worldId, generation: world.worldGeneration, cameras })
const adjustReceipt = (world: CameraWorldIdentity) => ({ sceneId: world.sceneId, sceneRevision: world.sceneRevision, worldId: world.worldId, generation: world.worldGeneration, override: true, referenceFrame: 'parent', worldFromCamera: { positionM: [0.1, 0.2, 0.3] } })
const multiReceipt = (world: CameraWorldIdentity) => ({ sceneId: world.sceneId, sceneRevision: world.sceneRevision, worldId: world.worldId, worldGeneration: world.worldGeneration, captureId: 'cap-1' })

describe('相机面板与 world 身份：谁的回执算数、什么时候整块作废', () => {
  test('身份键四字段各自区分；回执的两个代次键名（generation / worldGeneration）认成同一件事', () => {
    expect(cameraWorldKey({ ...WORLD_A })).toBe(cameraWorldKey(WORLD_A))
    for (const other of [{ ...WORLD_A, sceneId: 'scene-2' }, { ...WORLD_A, sceneRevision: 8 }, { ...WORLD_A, worldId: 'w-b' }, { ...WORLD_A, worldGeneration: 4 }]) {
      expect(cameraWorldKey(other)).not.toBe(cameraWorldKey(WORLD_A))
    }
    expect(receiptWorldKey(listReceipt(WORLD_A, []))).toBe(cameraWorldKey(WORLD_A))
    expect(receiptWorldKey(adjustReceipt(WORLD_A))).toBe(cameraWorldKey(WORLD_A))
    expect(receiptWorldKey(multiReceipt(WORLD_A))).toBe(cameraWorldKey(WORLD_A))
  })

  test('回执缺身份字段 ⇒ 无身份（不当成"匹配任何 world"）', () => {
    expect(receiptWorldKey(undefined)).toBeUndefined()
    expect(receiptWorldKey({ cameras: [] })).toBeUndefined()
    expect(receiptWorldKey({ ...listReceipt(WORLD_A, []), generation: undefined })).toBeUndefined()
    expect(receiptWorldKey({ ...listReceipt(WORLD_A, []), worldId: 42 })).toBeUndefined()
    expect(receiptMatchesWorld({ cameras: [] }, WORLD_A)).toBe(false)
  })

  test('只有四字段全等的回执才算"这个 world 的"；没有当前 world 时谁都不算', () => {
    expect(receiptMatchesWorld(listReceipt(WORLD_A, [ISAAC_READY]), WORLD_A)).toBe(true)
    expect(receiptMatchesWorld(listReceipt(WORLD_B, [ISAAC_READY]), WORLD_A)).toBe(false)
    expect(receiptMatchesWorld(listReceipt({ ...WORLD_A, worldGeneration: 4 }, []), WORLD_A)).toBe(false)
    expect(receiptMatchesWorld(listReceipt({ ...WORLD_A, sceneRevision: 8 }, []), WORLD_A)).toBe(false)
    expect(receiptMatchesWorld(listReceipt(WORLD_A, []), { ...WORLD_A, worldId: undefined })).toBe(false)
  })

  test('调整后同身份重读的清单被采用；迟到的旧 world 回执一律作废（不串 world）', () => {
    const request = WORLD_A, current = cameraWorldKey(WORLD_A)
    expect(adoptableReceipt(adjustReceipt(WORLD_A), request, current)).toBe(true)
    expect(adoptableReceipt(listReceipt(WORLD_A, [ISAAC_READY]), request, current)).toBe(true)
    expect(adoptableReceipt(multiReceipt(WORLD_A), request, current)).toBe(true)
    // 请求发出后 world 换了：回执再"正确"也不许写回新 world（调整回执与随后的重读清单都不许）
    expect(adoptableReceipt(adjustReceipt(WORLD_A), request, cameraWorldKey(WORLD_B))).toBe(false)
    expect(adoptableReceipt(listReceipt(WORLD_A, [ISAAC_READY]), request, cameraWorldKey(WORLD_B))).toBe(false)
    // 回执自报的是另一个 world（张冠李戴）：当前身份仍等于请求身份也不采用
    expect(adoptableReceipt(listReceipt(WORLD_B, []), request, current)).toBe(false)
    // 回执不带身份的命令（标注）：只核"请求时的身份仍是当前身份"
    expect(stillCurrentWorld(request, current)).toBe(true)
    expect(stillCurrentWorld(request, cameraWorldKey(WORLD_B))).toBe(false)
  })

  test('换身份：整块快照折成空（清单、勾选、调整回执都不留）；在新身份上改快照不继承旧字段', () => {
    const loaded = scopedPatch(emptyCameraScope(cameraWorldKey(WORLD_A)), cameraWorldKey(WORLD_A), base => ({ rows: [ISAAC_READY], selected: nextCameraSelection(base.selected, [ISAAC_READY]) }))
    const adjusted = scopedPatch(loaded, cameraWorldKey(WORLD_A), { adjustResult: adjustReceipt(WORLD_A) })
    expect(visibleCameraScope(adjusted, cameraWorldKey(WORLD_A)).rows).toHaveLength(1)
    expect(visibleCameraScope(adjusted, cameraWorldKey(WORLD_A)).selected).toEqual(['e1/wrist'])
    expect(visibleCameraScope(adjusted, cameraWorldKey(WORLD_A)).adjustResult?.override).toBe(true)
    const atB = visibleCameraScope(adjusted, cameraWorldKey(WORLD_B))
    expect(atB.rows).toBeUndefined()
    expect(atB.selected).toEqual([])
    expect(atB.adjustResult).toBeUndefined()
    const reloadedAtB = scopedPatch(adjusted, cameraWorldKey(WORLD_B), { rows: [MUJOCO_READY] })
    expect(reloadedAtB.key).toBe(cameraWorldKey(WORLD_B))
    expect(reloadedAtB.rows).toHaveLength(1)
    expect(reloadedAtB.selected).toEqual([])
  })

  test('勾选：首读默认勾上全部可用条目，再读保留用户选择并滤掉已不可用的', () => {
    expect(nextCameraSelection([], [ISAAC_READY, ISAAC_REJECTED, MUJOCO_READY])).toEqual(['e1/wrist', 'arm-a/cam_mono'])
    expect(nextCameraSelection(['e1/wrist'], [ISAAC_REJECTED])).toEqual([])
    expect(nextCameraSelection(['e1/wrist', 'arm-a/cam_mono'], [MUJOCO_READY])).toEqual(['arm-a/cam_mono'])
  })

  test('用户显式取消全部勾选后重读：空选保持空（只有首次加载才默认全选可用相机）', () => {
    const key = cameraWorldKey(WORLD_A)
    const load = (scope: CameraScope, rows: any[]) => scopedPatch(scope, key, base => ({ rows, selected: nextCameraSelection(base.selected, rows, base.selectionInitialized), selectionInitialized: true }))
    let scope = load(emptyCameraScope(key), [ISAAC_READY, MUJOCO_READY])
    expect(scope.selected).toEqual(['e1/wrist', 'arm-a/cam_mono'])       // 首读：默认全选
    scope = load(scopedPatch(scope, key, { selected: [] }), [ISAAC_READY, MUJOCO_READY])
    expect(scope.rows).toHaveLength(2)
    expect(scope.selected).toEqual([])                                   // 用户显式空选：重读不被重新全选
    // "空数组"本身不代表首读——已读过的身份下它就是用户的空选。
    expect(nextCameraSelection([], [ISAAC_READY], true)).toEqual([])
    // 换身份＝那个身份下的首读：整块快照已折成空，仍然默认全选（口径不变）。
    expect(nextCameraSelection([], [ISAAC_READY])).toEqual(['e1/wrist'])
  })

  test('视锥只从可用条目出：引擎拒的（即使带着完整位姿/K）与缺位姿/K 的一条都不进 3D（与勾选同一条判据）', () => {
    expect(cameraRigSpecs([ISAAC_READY, ISAAC_REJECTED, MUJOCO_READY]).map(spec => spec.key)).toEqual(['e1/wrist', 'arm-a/cam_mono'])
    // 引擎明确拒、但数据恰好齐全：合同能画，**也不画**——否则 3D 里会出现一台采集不到、也勾不上的相机。
    const rejectedButComplete = { ...ISAAC_READY, available: false, reason: '该相机在 RTX Profile 下不可用' }
    expect(cameraRigSpecs([rejectedButComplete])).toEqual([])
    expect(cameraRigSpecs([rejectedButComplete, MUJOCO_READY]).map(spec => spec.key)).toEqual(['arm-a/cam_mono'])
    expect(cameraRigSpecs(undefined)).toEqual([])
  })
})

/**
 * 主控审查上一轮补丁发现的四个缺口（同一面板内）＋"调整已生效但清单刷新失败"的诚实反馈：
 * ①引擎拒的条目不进 3D；②显式空选在重读后保持；③同 world 内先发后到的旧清单不覆盖新清单；④读数卡代次不是 undefined。
 * 仍然只量判据函数——"渲染出来的界面"未真机验收（无 DOM 夹具，见文件头 PARTIAL 说明）。
 */
describe('相机面板回退修正：顺序、代次与刷新失败的诚实反馈', () => {
  test('同 world 内的清单新旧：只有最后发出的那次读取能写回（较早发出、较晚返回的旧清单被丢弃）', () => {
    const orders = cameraListSequencer()
    const slowFirstRead = orders.begin()          // 用户点了"读取"，这一趟慢
    const readAfterAdjust = orders.begin()        // 调整成功后的重读：同走 begin ⇒ 成为最新一次
    expect(orders.accept(readAfterAdjust)).toBe(true)
    expect(orders.accept(slowFirstRead)).toBe(false)   // 迟到的旧清单：不写回，不覆盖调整后的较新清单
    const manualRead = orders.begin()             // 用户又点了一次读取
    expect(orders.accept(readAfterAdjust)).toBe(false)  // 上上次的重读也过期了
    expect(orders.accept(manualRead)).toBe(true)
    // 每个面板各自一套号（不同身份/实例之间不共用顺序）
    expect(cameraListSequencer().accept(1)).toBe(false)
    expect(cameraListSequencer().begin()).toBe(1)
  })

  test('调整读数卡的代次取回执真实值：两个键名都认，都没有就显示 —（绝不显示 undefined）', () => {
    expect(receiptGenerationText(adjustReceipt(WORLD_A))).toBe('3')                  // camera_adjust 回执报 generation
    expect(receiptGenerationText({ worldGeneration: 9 })).toBe('9')                  // capture_multi/dataset 那套键名
    expect(receiptGenerationText({ worldGeneration: 9, generation: 3 })).toBe('9')   // 都在：worldGeneration 优先
    expect(receiptGenerationText({})).toBe('—')
    expect(receiptGenerationText(undefined)).toBe('—')
    expect(receiptGenerationText({ generation: 'abc' })).toBe('—')                   // 坏值不摆出来
    expect(receiptGenerationText({ generation: Number.NaN })).toBe('—')
  })

  test('调整成功但清单刷新失败：调整回执保留、旧清单/视锥撤下，且如实说"调整已生效"（不写"调整失败"）', () => {
    const key = cameraWorldKey(WORLD_A)
    const adjusted = scopedPatch(emptyCameraScope(key), key, { rows: [ISAAC_READY, MUJOCO_READY], selectionInitialized: true, selected: ['e1/wrist'], adjustResult: adjustReceipt(WORLD_A) })
    expect(cameraRigSpecs(adjusted.rows)).toHaveLength(2)
    const failed = scopeAfterFailedListRefresh(adjusted, key, key)
    // 失败发生在**别的身份**上（请求的 world 已不是当前的）：那一块本来就不显示，也不借此把新 world 的清单抹掉。
    const atB = scopedPatch(emptyCameraScope(cameraWorldKey(WORLD_B)), cameraWorldKey(WORLD_B), { rows: [MUJOCO_READY], selectionInitialized: true })
    expect(scopeAfterFailedListRefresh(atB, key, cameraWorldKey(WORLD_B))).toBe(atB)
    expect(failed.adjustResult?.override).toBe(true)      // 已生效的调整回执**保留**（重读失败不撤销它）
    expect(failed.rows).toBeUndefined()                   // 调整前的旧清单不再是"当前事实"
    expect(cameraRigSpecs(failed.rows)).toEqual([])       // 视锥随之撤下：3D 里不留调整前的旧读数
    expect(failed.selected).toEqual(['e1/wrist'])         // 勾选保留
    // 清空清单 ≠ 回到"首读"：用户的选择还在，下次读取按它过滤（不因为清单被清空就重新全选）。
    const reloaded = scopedPatch(failed, key, base => ({ rows: [ISAAC_READY, MUJOCO_READY], selected: nextCameraSelection(base.selected, [ISAAC_READY, MUJOCO_READY], base.selectionInitialized), selectionInitialized: true }))
    expect(reloaded.selected).toEqual(['e1/wrist'])
    // 文案：说的是"调整已生效、清单刷新失败"，不是"调整失败"（调整确实已经生效）。
    const zh = adjustAppliedRefreshFailedMessage((cn) => cn)
    expect(zh).toContain('调整已生效')
    expect(zh).toContain('清单刷新失败')
    expect(zh).not.toContain('调整失败')
    const en = adjustAppliedRefreshFailedMessage((_cn, english) => english)
    expect(en).toContain('applied')
    expect(en).toContain('refreshing the camera list failed')
    expect(en).not.toContain('adjust failed')
  })
})
