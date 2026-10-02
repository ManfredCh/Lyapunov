import {useCallback,useEffect,useRef,useState} from "react"
import type {Entity,SceneCommit,SceneSnapshot,WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import {type FrustumSpec} from "../../viewer/src/camera-frustum.ts"
import {adoptableReceipt,cameraWorldKey,receiptMatchesWorld,usableCameraSpec,type CameraWorldIdentity} from "./capture-panel.tsx"
import {cameraMountBodies,cameraMountLabel,recommendedCameraMount,sceneCameraDraftOf,sceneCamerasOfScene,type SceneCameraDraft} from "./workbench-camera.ts"
import {cameraDraftFromSample,type CameraAuthoringSnapshot,type CameraExitBridge} from './camera-authoring.ts'
import {cameraDraftOfScene,type CameraSceneSaveInput} from './camera-installation.ts'
import {nativeCameraPreset,registeredCameraPresets,type RobotCameraPreset} from '../../robot-tools/src/presets.ts'
import {cameraListFingerprint,queryNativeCameraList} from "./camera-ui-query.ts"
import type {SceneWorldState} from "./scene-world-lifecycle.ts"
import type {Translate} from "./entity-editor.tsx"
import {workbenchAPI} from "./workbench-api.ts"

/** 出口只消费Viewer-owned mode；原生读回或清单刷新不决定用户能否返回主视图。 */
export function CameraReturnControl({mode,returnView,tr}:{mode?:'free'|'pilot'|'camera-edit';returnView:()=>void;tr:Translate}){
 if(mode!=='pilot')return null
 return <div className="lya-row"><button type="button" aria-label={tr('返回主视图','Return to main view')} onClick={returnView}>{tr('返回主视图','Return to main view')}</button></div>
}

/** 现有 camera_list 的当前作用域投影，两个相机面板共享；不会创建或保存第二份相机。 */
export function useNativeCameraList({api,scene,world,active}:{api:ReturnType<typeof workbenchAPI>;scene?:SceneSnapshot;world?:WorldHandle;active:boolean}){
 const identity:CameraWorldIdentity={sceneId:scene?.sceneId,sceneRevision:scene?.revision,worldId:world?.worldId,worldGeneration:world?.worldGeneration}
 const key=cameraWorldKey(identity),current=useRef<{key:string;api:typeof api;sequence:number;controller?:AbortController;pending?:Promise<any>}>({key,api,sequence:0})
 const activeRef=useRef(active);activeRef.current=active
 if(current.current.key!==key||current.current.api!==api){current.current.controller?.abort();current.current={key,api,sequence:current.current.sequence+1}}
 const [readback,setReadback]=useState<{key:string;api:typeof api;receipt:any;fingerprint:string}>(),[failure,setFailure]=useState<{key:string;api:typeof api;message:string}>()
 const ready=Boolean(scene&&world&&world.sceneId===scene.sceneId&&world.appliedSceneRevision===scene.revision&&["ready","running","paused"].includes(world.status))
 const refresh=useCallback(async(force=true)=>{
  // 旧闭包不能借新 scope 的 pending/controller 发旧 Scene/world 请求。
  if(!activeRef.current||current.current.api!==api||current.current.key!==key)return undefined
  if(!ready||!scene||!world)throw new Error("相机需要当前场景已同步的物理世界")
  if(current.current.pending)return await current.current.pending
  const scope=current.current,sequence=++scope.sequence,controller=new AbortController();scope.controller=controller
  const pending=(async()=>{
   try{
    const value=await queryNativeCameraList(api,identity,controller.signal,force)
    if(!activeRef.current||controller.signal.aborted||current.current!==scope||scope.sequence!==sequence||!adoptableReceipt(value,identity,current.current.key))return undefined
    const fingerprint=cameraListFingerprint(value)
    setReadback(old=>old?.key===key&&old.api===api&&old.fingerprint===fingerprint?old:{key,api,receipt:value,fingerprint});setFailure(old=>old?undefined:old)
    return value
   }catch(error){if(controller.signal.aborted)return undefined;if(current.current===scope&&scope.sequence===sequence)setFailure({key,api,message:String(error)});throw error}
   finally{if(scope.controller===controller){scope.pending=undefined;scope.controller=undefined}}
  })()
  scope.pending=pending;return await pending
 },[api,key,ready])
 useEffect(()=>{
  const scope=current.current
  if(!active||!ready){scope.controller?.abort();return}
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
  const read=async()=>{let delay=750;try{await refresh(false)}catch{delay=1500}if(!cancelled)timer=setTimeout(read,delay)}
  void read();return()=>{cancelled=true;if(timer)clearTimeout(timer);scope.controller?.abort();scope.sequence++}
 },[active,ready,refresh])
 return {receipt:readback?.key===key&&readback.api===api?readback.receipt:undefined,error:failure?.key===key&&failure.api===api?failure.message:undefined,refresh,ready,key}
}

export function SceneCameraPanel({api,scene,world,receipt,error,readOnly,tr,perform,commit,sampleCurrent,saveInstallation,pilot,returnView,piloted,selectCamera,selectedCameraEntityId,selectedRobotEntityId,prepareWorld,worldState,sceneSpecs,refresh,exitBridge}:{
 api:ReturnType<typeof workbenchAPI>;scene?:SceneSnapshot;world?:WorldHandle;receipt?:any;error?:string;readOnly:boolean;tr:Translate;
 perform:(fn:()=>Promise<unknown>)=>void;commit:(input:SceneCommit)=>Promise<SceneSnapshot>;sampleCurrent:()=>CameraAuthoringSnapshot;saveInstallation:(input:CameraSceneSaveInput)=>Promise<{snapshot:SceneSnapshot;entityId:string}>;
 pilot:(key:string)=>void;returnView:()=>void;piloted?:string;selectCamera:(key:string)=>void;selectedCameraEntityId?:string;selectedRobotEntityId?:string;
 prepareWorld:(sceneId:string)=>Promise<WorldHandle|undefined>;worldState?:SceneWorldState;sceneSpecs:readonly FrustumSpec[];refresh:()=>Promise<any>
 exitBridge?:CameraExitBridge
}){
 const cameras=sceneCamerasOfScene(scene?.entities),[editing,setEditing]=useState(""),[draft,setDraft]=useState<SceneCameraDraft>(()=>sceneCameraDraftOf())
 const [draftMode,setDraftMode]=useState<'current-view'|'draft'>('current-view'),[draftDirty,setDraftDirty]=useState(false),[presetId,setPresetId]=useState('')
 const [preview,setPreview]=useState<any>(),[previewError,setPreviewError]=useState(""),[livePreview,setLivePreview]=useState(true),[previewBusy,setPreviewBusy]=useState(false)
 const [preparing,setPreparing]=useState(false),[prepareError,setPrepareError]=useState(""),[saving,setSaving]=useState(false)
 const pendingSave=useRef<Promise<void>>()
 const previewInFlight=useRef(false),previewController=useRef<AbortController>(),prepareInFlight=useRef<Promise<WorldHandle|undefined>>()
 const identity:CameraWorldIdentity={sceneId:scene?.sceneId,sceneRevision:scene?.revision,worldId:world?.worldId,worldGeneration:world?.worldGeneration},key=cameraWorldKey(identity)
 const current=useRef({key,editing,sceneId:scene?.sceneId,api,sampleCurrent,prepareWorld});current.current={key,editing,sceneId:scene?.sceneId,api,sampleCurrent,prepareWorld}
 const selected=cameras.find(row=>row.entity.entityId===editing)
 // 清单是当前 world 的投影；旧 revision/generation 的 body 不能用于新安装标定。
 const scopedReceipt=receiptMatchesWorld(receipt,identity)?receipt:undefined,bodies=cameraMountBodies(scopedReceipt,scene?.entities??[])
 const rows:any[]=scopedReceipt?.cameras??[],native=selected?rows.find(row=>row.entityId===editing||row.cameraName===`${editing}/${selected.component.name??selected.entity.name}`):undefined
 const nativeSpec=usableCameraSpec(native),spec=native?.available===false?undefined:nativeSpec??sceneSpecs.find(row=>row.entityId===editing),nativeKey=nativeSpec?.key
 const ready=Boolean(!readOnly&&world&&scene&&world.sceneId===scene.sceneId&&world.appliedSceneRevision===scene.revision&&["ready","running","paused"].includes(world.status))
 const mountEntity=scene?.entities.find(row=>row.entityId===draft.parentEntityId),selectedRobot=scene?.entities.find(row=>row.entityId===selectedRobotEntityId)
 const bodyOwners=Array.from(new Set(bodies.map(body=>body.entityId))),bodyChoices=bodies.filter(body=>body.entityId===draft.parentEntityId)
 const availableBody=(name:string)=>{const matches=bodyChoices.filter(body=>body.bodyName===name);return matches.length===1&&Boolean(matches[0]!.worldFromBody)}
 const recommendations=bodyChoices.filter(body=>availableBody(body.bodyName)&&cameraMountLabel(body.bodyName).priority<4).sort((a,b)=>cameraMountLabel(a.bodyName).priority-cameraMountLabel(b.bodyName).priority).slice(0,3)
 const mountedCameras=cameras.filter(row=>draft.parentEntityId?row.component.mount?.entityId===draft.parentEntityId:!row.component.mount)
 const presets:RobotCameraPreset[]=scene?[...rows.flatMap(row=>{try{return [nativeCameraPreset(row,scopedReceipt,scene.entities)]}catch{return []}}),...(draft.parentEntityId?registeredCameraPresets(scene,draft.parentEntityId):[])].filter(row=>!draft.parentEntityId||row.mount?.entityId===draft.parentEntityId):[]
 const previews=rows.filter(row=>row.override&&(!draft.parentEntityId||row.entityId===draft.parentEntityId||row.parentEntityId===draft.parentEntityId||row.entityId===editing))
 const worldIssue=worldState&&scene&&worldState.sceneId===scene.sceneId&&["failed","blocked"].includes(worldState.phase)?worldState:undefined
 const preparationDetail=prepareError||(draft.parentEntityId?(worldIssue?.detail||error):undefined),preparationCode=prepareError.match(/^([A-Z][A-Z0-9_]+)/)?.[1]??(draft.parentEntityId?worldIssue?.code:undefined)
 const prepare=async(mountEntityId=draft.parentEntityId)=>{
  if(!scene||readOnly)throw new Error("CAMERA_SCENE_READ_ONLY: 当前场景不可编辑")
  if(!mountEntityId||!scene.entities.some(entity=>entity.entityId===mountEntityId))throw new Error('CAMERA_MOUNT_INTENT_REQUIRED: 先明确选择当前画面要挂载的实体；世界相机无需启动物理')
  if(prepareInFlight.current)return await prepareInFlight.current
  const sceneId=scene.sceneId,requestAPI=api
  setPreparing(true);setPrepareError("")
  const pending=current.current.prepareWorld(sceneId)
  prepareInFlight.current=pending
  try{return await pending}catch(failure){if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setPrepareError(failure instanceof Error?failure.message:String(failure));throw failure}
  finally{if(prepareInFlight.current===pending)prepareInFlight.current=undefined;if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setPreparing(false)}
 }
 const newCamera=(mountRobot=false)=>{
  let next=sceneCameraDraftOf()
  if(scene){try{next=cameraDraftFromSample(scene,sampleCurrent())}catch(value){setPrepareError(value instanceof Error?value.message:String(value))}}
  setEditing('');setDraft({...next,parentEntityId:mountRobot?selectedRobot?.entityId??'':''});setDraftMode('current-view');setDraftDirty(false);setPresetId('');setPrepareError('');setPreview(undefined);setPreviewError('');setLivePreview(false)
 }
 const beginMount=async()=>{if(!selectedRobot)throw Error('CAMERA_MOUNT_ENTITY_REQUIRED');newCamera(true);if(!ready)await prepare(selectedRobot.entityId);else await refresh()}
 const choose=(entity:Entity)=>{setEditing(entity.entityId);setDraft(cameraDraftOfScene(scene!,entity));setDraftMode('draft');setDraftDirty(false);setPresetId('');setPreview(undefined);setPreviewError("");setLivePreview(true);const component=entity.components.camera as {name?:string}|undefined;selectCamera(`${entity.entityId}/${component?.name??entity.name}`)}
 useEffect(()=>{setEditing("");setDraft(sceneCameraDraftOf());setDraftMode('current-view');setDraftDirty(false);setPresetId('');setPreview(undefined);setPreviewError("");setPrepareError("");setPreparing(false);setLivePreview(false)},[scene?.sceneId,api])
 // 选中机器人只给明确挂载入口；不改世界相机草稿，也不从selection effect冷启SDK。
 // 只推荐真实名称；保存时再采同一显示帧，不用轮询位姿预填局部安装。
 useEffect(()=>{
  if(editing||!mountEntity||draft.bodyName||!ready)return
  const body=recommendedCameraMount(bodies,mountEntity.entityId);if(!body)return
  try{
   const next=cameraDraftFromSample(scene!,current.current.sampleCurrent(),{name:draft.name,world,mount:{entityId:mountEntity.entityId,bodyName:body.bodyName}})
   setDraft(old=>old.parentEntityId===mountEntity.entityId&&!old.bodyName?next:old);setPrepareError('')
  }catch(failure){setPrepareError(failure instanceof Error?failure.message:String(failure))}
 },[scopedReceipt,editing,draft.parentEntityId,draft.bodyName,ready])
 // Scene 是声明 owner；重开或外部 scene_edit 后显示文档里的安装标定。
 useEffect(()=>{if(editing&&!draftDirty){const entity=scene?.entities.find(row=>row.entityId===editing);if(entity)setDraft(cameraDraftOfScene(scene!,entity));else{setEditing("");setDraft(sceneCameraDraftOf());setDraftMode('current-view')}}},[scene?.revision,editing,draftDirty])
 useEffect(()=>{if(selectedCameraEntityId&&selectedCameraEntityId!==editing){const row=cameras.find(row=>row.entity.entityId===selectedCameraEntityId);if(row)choose(row.entity)}},[selectedCameraEntityId])
 const field=(name:keyof SceneCameraDraft,value:string)=>{
  let next=draft
  if(name!=='name'&&draftMode==='current-view'){
   try{if(!scene)throw Error('CAMERA_SCENE_REQUIRED');next=cameraDraftFromSample(scene,sampleCurrent(),{name:draft.name,world,mount:draft.parentEntityId?{entityId:draft.parentEntityId,bodyName:draft.bodyName}:undefined})}
   catch(failure){setPrepareError(failure instanceof Error?failure.message:String(failure));return}
  }
  if(name!=='name')setDraftMode('draft');setDraftDirty(true);setDraft({...next,[name]:value})
 }
 const chooseBody=(bodyName:string)=>{
  if(!mountEntity)throw new Error("CAMERA_MOUNT_ENTITY_REQUIRED: 请先选中当前机器人")
  if(!availableBody(bodyName))throw new Error('CAMERA_MOUNT_BODY_REQUIRED: 选择当前真实唯一连杆')
  const next=cameraDraftFromSample(scene!,sampleCurrent(),{name:draft.name,world,mount:{entityId:mountEntity.entityId,bodyName}})
  setDraft(next);setDraftMode('current-view');setDraftDirty(true);setPrepareError('')
 }
 const fromView=()=>{
  if(!scene)throw new Error('CAMERA_SCENE_REQUIRED')
  const sampled=sampleCurrent(),next=cameraDraftFromSample(scene,sampled,{name:draft.name,world,mount:draft.parentEntityId?{entityId:draft.parentEntityId,bodyName:draft.bodyName}:undefined})
  setDraft(next);setDraftMode('current-view');setDraftDirty(true)
 }
 const save=(mode:CameraSceneSaveInput['mode']=draftMode):Promise<void>=>{
  if(pendingSave.current)return pendingSave.current
  const pending=(async()=>{
  if(!scene||readOnly)throw new Error("当前场景不可编辑")
  const entityId=editing||crypto.randomUUID(),sceneId=scene.sceneId,requestAPI=api
  setSaving(true)
  try{
   const saved=await saveInstallation({sceneId,expectedRevision:scene.revision,entityId,mode,name:draft.name,...mode==='draft'?{draft}:mode==='current-view'&&draft.parentEntityId?{mount:{entityId:draft.parentEntityId,bodyName:draft.bodyName}}:mode==='native-preset'?{presetId}:{},...(world&&world.sceneId===sceneId?{worldId:world.worldId,expectedGeneration:world.worldGeneration}:{})})
   if(current.current.sceneId!==sceneId||current.current.api!==requestAPI)return
   setEditing(saved.entityId);setDraft(cameraDraftOfScene(saved.snapshot,saved.snapshot.entities.find(row=>row.entityId===saved.entityId)));setDraftMode('draft');setDraftDirty(false);exitDraft.current.dirty=false;setPreview(undefined);setLivePreview(true)
   // 保存只写Scene。物理同步经现有World owner，静态世界相机当场可用。
  }finally{if(current.current.sceneId===sceneId&&current.current.api===requestAPI)setSaving(false)}
  })()
  pendingSave.current=pending
  void pending.finally(()=>{if(pendingSave.current===pending)pendingSave.current=undefined}).catch(()=>undefined)
  return pending
 }
 const exitDraft=useRef({dirty:draftDirty,save});exitDraft.current={dirty:draftDirty,save}
 useEffect(()=>exitBridge?.registerExitParticipant?.('camera-form:'+api.clientId,{summary:()=>({dirtyDrafts:exitDraft.current.dirty?1:0,runningActions:0}),flush:async()=>{if(pendingSave.current)await pendingSave.current;if(exitDraft.current.dirty)await exitDraft.current.save()}}),[exitBridge,api.clientId])
 const remove=async()=>{if(!scene||readOnly||!editing)throw new Error("当前没有可删除的场景相机");await commit({sceneId:scene.sceneId,expectedRevision:scene.revision,patch:[{op:"remove",entityId:editing,cascade:true}]});if(current.current.sceneId===scene.sceneId&&current.current.api===api)newCamera()}
 const capturePreview=useCallback(async()=>{
  if(!ready||!scene||!world||!nativeKey||!selected)throw new Error("所选相机尚无可采集的原生位姿与内参")
  if(previewInFlight.current)return
  const controller=new AbortController();previewController.current=controller
  previewInFlight.current=true;setPreviewBusy(true)
  try{
   const target=editing,request=identity
   const value=await api.request<any>("camera-preview",{method:"POST",signal:controller.signal,body:JSON.stringify({sceneId:scene.sceneId,sceneRevision:scene.revision,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraNames:[nativeKey],width:selected.component.width??640,height:selected.component.height??480})})
   if(current.current.api!==api||current.current.editing!==target||!adoptableReceipt(value,request,current.current.key))return
   const image=value.cameras?.find((row:any)=>row.cameraName===nativeKey)
   if(!image||!value.captureId)throw new Error("原生采集没有返回所选相机图像记录")
   setPreview({...value,camera:image});setPreviewError("")
  }catch(failure){if(!controller.signal.aborted)throw failure}
  finally{if(previewController.current===controller)previewController.current=undefined;previewInFlight.current=false;setPreviewBusy(false)}
 },[api,key,editing,nativeKey,ready,selected?.component.width,selected?.component.height])
 useEffect(()=>{
  setPreview(undefined);setPreviewError("")
  if(!nativeKey||!ready||!livePreview)return
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
  const capture=async()=>{try{await capturePreview();if(!cancelled&&livePreview)timer=setTimeout(capture,1000)}catch(failure){if(!cancelled){setPreviewError(String(failure));setLivePreview(false)}}}
  void capture();return()=>{cancelled=true;if(timer)clearTimeout(timer);previewController.current?.abort()}
 },[nativeKey,key,editing,ready,livePreview,capturePreview])
 const visiblePreview=preview&&receiptMatchesWorld(preview,identity)?preview:undefined
 const mountReady=Boolean(ready&&!preparing&&!prepareError&&draft.parentEntityId&&availableBody(draft.bodyName))
 return <fieldset className="lya-property-editor" data-testid="robot-camera-panel"><legend>{tr("机器人相机","Robot camera")}</legend>
  <div className="lya-row"><strong>{mountEntity?.name??(draft.parentEntityId?tr("挂载实体已不存在","Mount entity missing"):tr("世界固定相机","World camera"))}</strong><button disabled={readOnly||!scene||saving} onClick={()=>newCamera()}>{tr('从当前视角新建世界相机','New world camera from current view')}</button></div>
  {selectedRobot&&<div className="lya-row"><span>{selectedRobot.name}</span><button disabled={readOnly||saving||preparing} onClick={()=>perform(beginMount)}>{tr('把当前画面挂到所选机器人','Mount current view on selected robot')}</button></div>}
  <p className="lya-help" data-testid="camera-authoring-mode">{draftMode==='current-view'?tr('保存时自动采当前完整画面。绑定时保留当前机位，换算到所选连杆；保存后仍留在主视图。','Save samples the complete current view. Mounting preserves that view in the selected body frame; it does not enter camera view.'):tr('当前为已保存安装或人工草稿；保存局部外参与镜头。','This is a saved installation or manual draft; save its local pose and lens.')}</p>
  {!selectedRobot&&!editing&&!draft.parentEntityId&&<p className="lya-help">{tr("在场景里选中机器人，即可选择它的相机挂载位置。","Select a robot in the scene to choose its camera mount.")}</p>}
  {mountedCameras.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{mountedCameras.map(row=><button key={row.entity.entityId} aria-pressed={editing===row.entity.entityId} onClick={()=>choose(row.entity)}>{row.component.name??row.entity.name}</button>)}</div>}
  {draft.parentEntityId&&<>
   {recommendations.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{recommendations.map(body=>{const label=cameraMountLabel(body.bodyName);return <button key={body.bodyName} disabled={readOnly||saving} title={body.bodyName} aria-pressed={draft.bodyName===body.bodyName} onClick={()=>perform(async()=>chooseBody(body.bodyName))}>{tr(label.zh,label.en)}{label.priority===0?tr("（推荐）"," (suggested)"):""}</button>})}</div>}
   <label className="lya-field-label">{tr("挂载位置","Mount location")}<select aria-label={tr("挂载位置","Mount location")} value={draft.bodyName} disabled={readOnly||!ready||saving} onChange={event=>{if(event.target.value)perform(async()=>chooseBody(event.target.value))}}><option value="">{preparing?tr("正在读取连杆…","Reading links…"):tr("选择真实连杆","Choose a native link")}</option>{draft.bodyName&&!bodyChoices.some(row=>row.bodyName===draft.bodyName)&&<option value={draft.bodyName}>{draft.bodyName} · {tr("等待读回","awaiting readback")}</option>}{bodyChoices.map((body,index)=>{const label=cameraMountLabel(body.bodyName);return <option key={`${body.bodyName}:${index}`} value={body.bodyName} disabled={!availableBody(body.bodyName)}>{tr(label.zh,label.en)} · {body.bodyName}{availableBody(body.bodyName)?"":tr("（不可用）"," (unavailable)")}</option>})}</select></label>
   {mountReady&&<p className="lya-help">{tr('相机跟随真实连杆。当前画面安装使用同一显示帧的连杆和镜头。','The camera follows the native link. Current-view installation uses the body and camera from one displayed frame.')}</p>}
  </>}
  <div className="lya-row">{draft.parentEntityId&&<button disabled={readOnly||!scene||preparing||saving} onClick={()=>perform(ready?refresh:()=>prepare())}>{preparing?tr("正在读取连杆…","Reading links…"):ready?tr("刷新连杆","Refresh links"):preparationDetail?tr("重试读取真实连杆","Retry native links"):tr("读取真实连杆（需物理）","Read native links (needs physics)")}</button>}<button className="lya-primary" disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(save)}>{saving?tr("正在保存…","Saving…"):draft.parentEntityId?tr("保存连杆安装","Save body installation"):tr("保存固定相机","Save world camera")}</button></div>
  {preparationDetail&&<><p className="lya-help" role="alert">{tr("相机准备受阻","Camera preparation blocked")}{preparationCode?` · ${preparationCode}`:""}</p><details><summary>{tr("查看原因","Show reason")}</summary><p className="lya-help" style={{overflowWrap:"anywhere"}}>{preparationDetail}</p></details></>}
  <div className="lya-row"><button disabled={readOnly||!scene||saving||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(()=>save('current-view'))}>{tr('保存当前画面安装','Save current-view installation')}</button><button disabled={readOnly||!selected?.component.installation||saving||Boolean(selected?.component.mount&&!mountReady)} onClick={()=>perform(()=>save('restore'))}>{tr('恢复安装基线','Restore installation baseline')}</button></div>
  {presets.length>0?<div className="lya-row"><select aria-label={tr('真实相机预设','Verified camera preset')} value={presetId} onChange={event=>setPresetId(event.target.value)}><option value="">{tr('选择已存在的安装','Choose an existing installation')}</option>{presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name} · {preset.source==='scene-baseline'?tr('Scene用户基线','Scene user baseline'):preset.source.toUpperCase()}</option>)}</select><button disabled={readOnly||!ready||!presetId||saving} onClick={()=>perform(()=>save('native-preset'))}>{tr('采用此安装','Use this installation')}</button></div>:draft.parentEntityId&&<p className="lya-help">{tr('当前本体没有可用原生相机预设。请选择真实连杆，用当前画面标定，或在高级设置明确编辑局部外参。','This robot has no available native camera preset. Choose a real body and calibrate from the current view, or edit a local installation explicitly.')}</p>}
  {previews.length>0&&<><p className="lya-help">{tr('下列相机正在临时试拍，原件安装预设待清除试拍后重新读取。','These cameras have temporary preview overrides. Clear them to reread their original installations.')}</p><div className="lya-row" style={{flexWrap:'wrap'}}>{previews.map(row=><button key={row.cameraName} disabled={readOnly||!ready||saving} onClick={()=>perform(async()=>{if(!scene||!world)throw Error('CAMERA_WORLD_REQUIRED');const requested=key;await api.command('camera_adjust_ui',{sceneId:scene.sceneId,worldId:world.worldId,expectedGeneration:world.worldGeneration,cameraName:row.cameraName,clear:true});if(current.current.key===requested&&current.current.api===api)await refresh()})}>{tr('清除试拍：','Clear preview: ')}{row.localName??row.cameraName}</button>)}</div></>}
  {selected&&<>
   <p className="lya-help" role="status">{native?.available===false?`${tr("此相机暂不可用","Camera unavailable")}：${native.reason??tr("引擎未提供原因","No reason reported")}`:nativeSpec?tr("原生相机已就绪，可进入视角。","Native camera ready; enter its view."):spec&&!selected.component.mount?tr("机位已保存，可进入视角；原生采集需物理世界就绪。","View saved; enter it now. Native capture requires a ready physical world."):!ready?tr("绑定已保存，正在等待物理世界同步。","Mount saved; awaiting physical world synchronization."):tr("绑定已保存，正在读取原生相机。","Mount saved; reading the native camera.")}</p>
   <div className="lya-row"><button className="lya-primary" disabled={!spec||readOnly||Boolean(selected.component.mount&&!ready)} onClick={()=>spec&&pilot(spec.key)}>{selected.component.mount?tr("进入并跟随相机视角","Enter and follow camera"):tr("进入相机视角","Enter camera")}</button><button disabled={!piloted} onClick={returnView}>{tr("返回主视图","Return to main view")}</button><button disabled={!nativeSpec||!ready||previewBusy} onClick={()=>perform(capturePreview)}>{tr("刷新画面","Refresh image")}</button></div>
   <label><input type="checkbox" aria-label={tr("选中相机实时预览","Selected camera live preview")} checked={livePreview} disabled={!nativeSpec||!ready} onChange={event=>setLivePreview(event.target.checked)}/>{tr("实时预览","Live preview")}</label>
  </>}
  {previewBusy&&<p className="lya-help" role="status">{tr("正在采集相机画面…","Capturing camera image…")}</p>}
  {previewError&&<details><summary role="alert">{tr("相机画面采集失败","Camera capture failed")}</summary><p className="lya-help" style={{overflowWrap:"anywhere"}}>{previewError}</p></details>}
  {visiblePreview&&<><img style={{width:"100%",height:"auto"}} alt={tr("选中相机真实图像","Selected camera native image")} src={api.mediaURL("capture",{captureId:visiblePreview.captureId,camera:visiblePreview.camera.cameraName,sensor:"rgb"})}/><details><summary>{tr("图像与同帧标定","Image and same-frame calibration")}</summary><p className="lya-help">rev {visiblePreview.sceneRevision} · g{visiblePreview.worldGeneration??visiblePreview.generation} · step {visiblePreview.stepIndex} · frame {visiblePreview.frameId??"—"}<br/>{tr("相机世界位置","Camera world position")}：{visiblePreview.camera.calibration?.worldFromCamera?.positionM?.map((value:number)=>value.toFixed(4)).join(" / ")??"—"}</p></details></>}
  <details className="lya-advanced" data-testid="scene-camera-advanced"><summary>{tr("高级相机设置","Advanced camera settings")}</summary>
   <label className="lya-field-label">{tr("场景相机名称","Scene camera name")}<input aria-label={tr("场景相机名称","Scene camera name")} value={draft.name} disabled={readOnly} onChange={event=>field("name",event.target.value)}/></label>
   <label className="lya-field-label">{tr("挂载实体","Mount entity")}<select aria-label={tr("挂载实体","Mount entity")} value={draft.parentEntityId} disabled={readOnly} onChange={event=>{setDraft(old=>({...old,parentEntityId:event.target.value,bodyName:""}));setDraftMode('current-view');setDraftDirty(true)}}><option value="">{tr("世界固定相机","World camera")}</option>{draft.parentEntityId&&!bodyOwners.includes(draft.parentEntityId)&&<option value={draft.parentEntityId}>{mountEntity?.name??draft.parentEntityId} · {tr("等待原生读回","awaiting native readback")}</option>}{bodyOwners.map(entityId=><option key={entityId} value={entityId}>{scene?.entities.find(row=>row.entityId===entityId)?.name??entityId}</option>)}</select></label>
   <p className="lya-help">{draft.parentEntityId?tr("位姿为连杆局部系，单位米、四元数 xyzw。","Pose in the link's local frame, meters and xyzw."):tr("位姿为右手 Z-up 世界系，单位米、四元数 xyzw。","Pose in the right-handed Z-up world frame, meters and xyzw.")} {tr("相机 +X 右 / +Y 上 / -Z 前。","Camera axes: +X right / +Y up / -Z forward.")}</p>
   <label className="lya-field-label">{tr("相机位置 XYZ 米","Camera position XYZ m")}<input aria-label={tr("相机位置 XYZ 米","Camera position XYZ m")} value={draft.position} disabled={readOnly} onChange={event=>field("position",event.target.value)}/></label>
   <label className="lya-field-label">{tr("相机旋转 xyzw","Camera rotation xyzw")}<input aria-label={tr("相机旋转 xyzw","Camera rotation xyzw")} value={draft.quaternion} disabled={readOnly} onChange={event=>field("quaternion",event.target.value)}/></label>
   <div className="lya-row">{([['fovYDeg','竖直 FOV 度','Vertical FOV deg'],['width','相机宽度像素','Camera width px'],['height','相机高度像素','Camera height px'],['near','near 裁剪声明米','Declared near clip m'],['far','far 裁剪声明米','Declared far clip m']] as const).map(([name,zh,en])=><label key={name}>{tr(zh,en)}<input type="number" aria-label={tr(zh,en)} value={draft[name]} disabled={readOnly} onChange={event=>field(name,event.target.value)} style={{width:78}}/></label>)}</div>
   {native?.clipPlanesPerCameraSupported===false&&<p className="lya-help">{tr("当前引擎使用全局裁剪；实际范围","This engine uses global clipping; actual range")}：{native.nearM??"—"} / {native.farM??"—"} m。</p>}
   {draft.intrinsics&&<p className="lya-help" data-testid="camera-lens-k">K：fx {draft.intrinsics.fx.toFixed(3)} · fy {draft.intrinsics.fy.toFixed(3)} · cx {draft.intrinsics.cx.toFixed(3)} · cy {draft.intrinsics.cy.toFixed(3)} · {draft.intrinsics.width} × {draft.intrinsics.height}</p>}
   {selected?.component.installation&&<p className="lya-help">{tr('安装基线来源：','Installation baseline source: ')}{selected.component.installation.source} {selected.component.installation.sourceCameraName??''}</p>}
   <div className="lya-row"><button disabled={readOnly||Boolean(draft.parentEntityId&&!mountReady)} onClick={()=>perform(async()=>fromView())}>{tr("用当前机位标定","Calibrate from current view")}</button><button disabled={readOnly} onClick={()=>newCamera()}>{tr("新建世界固定相机","New world camera")}</button><button disabled={readOnly||!editing||saving} onClick={()=>perform(remove)}>{tr("删除场景相机","Delete scene camera")}</button></div>
   {cameras.length>0&&<div className="lya-row" style={{flexWrap:"wrap"}}>{cameras.map(row=><button key={row.entity.entityId} aria-pressed={editing===row.entity.entityId} onClick={()=>choose(row.entity)}>{row.component.name??row.entity.name}</button>)}</div>}
   {spec&&<p className="lya-help">{nativeKey} · rev {scene?.revision} · g{world?.worldGeneration} · step {spec.measured?.stepIndex??scopedReceipt?.stepIndex??"—"}</p>}
  </details>
 </fieldset>
}
