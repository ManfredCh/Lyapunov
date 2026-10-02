import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {CameraAuthoringViewer} from './camera-authoring.ts'
import type {WorkbenchUIStore} from './workbench-ui.ts'
import {surfaceDisposition,type CameraNavigationAction} from './ui-action-scope.ts'
import type {ViewerViewState} from '@lyapunov/viewer/client'
import {namedCamerasOfScene} from '../../viewer/src/camera-view.ts'
export {isCameraNavigationAction} from './ui-action-scope.ts'
/** 加载完成只为新Scene初始化机位；同Scene文档保存不能重放等待前的姿态或退出正在观察的相机。 */
export function settleSceneCameraLoad(viewer:{setViewState(state:ViewerViewState):void;openDefaultView():void},sameScene:boolean,savedView?:ViewerViewState){
  if(sameScene)return
  if(savedView)viewer.setViewState(savedView);else viewer.openDefaultView()
}
/** 保存机位从当前Scene元数据进入既有观察owner；不要求或制造原生camera_list标定。 */
export function enterSavedCameraView(viewer:Pick<CameraAuthoringViewer,'sampleCameraAuthoring'>&{pilotCameraRig(key:string,lens?:boolean):void},scene:SceneSnapshot,name:string){
  const sampled=viewer.sampleCameraAuthoring()
  if(sampled.sceneId!==scene.sceneId||sampled.sceneRevision!==scene.revision)throw Error('CAMERA_NAVIGATION_SCENE_STALE: 当前画面不属于已保存视角的场景版本')
  const named=namedCamerasOfScene(scene.entities)
  if(!named.carrier||!named.cameras.some(row=>row.name===name))throw Error('CAMERA_NAVIGATION_SAVED_VIEW_MISSING: 当前Scene没有所选保存视角')
  viewer.pilotCameraRig(`${named.carrier}/${name}`,true)
}
export interface CameraNavigationInput {action:CameraNavigationAction;clientId?:string;sceneId?:string;entityId?:string}
export interface CameraNavigationPorts {
  clientId:string;ownsSurface():boolean;viewerVisible():boolean;scene():SceneSnapshot|undefined
  viewer():Partial<CameraAuthoringViewer>|undefined
  ui:Pick<WorkbenchUIStore,'showCentre'|'openTool'>;selectEntity(entityId:string):void
}
/** 手工与NL共同消费入口：定位改共享工具栏，退出改观察位及画布焦点，均属于前台工作面。 */
export function applyCameraNavigation(input:CameraNavigationInput,ports:CameraNavigationPorts){
  if(input.clientId!==undefined&&input.clientId!==ports.clientId)return {applied:false,disposition:'foreign' as const}
  if(surfaceDisposition(input.action,ports.ownsSurface())==='defer')return {applied:false,disposition:'defer' as const}
  const scene=ports.scene(),viewer=ports.viewer()
  if(input.sceneId!==undefined&&scene?.sceneId!==input.sceneId)throw Error('CAMERA_NAVIGATION_SCENE_STALE: 当前窗口已切换场景')
  if(!ports.viewerVisible()||!viewer)throw Error('CAMERA_NAVIGATION_VIEWER_UNAVAILABLE: 请先打开本窗口的Viewer')
  if(input.action==='exitCameraView'){
    if(typeof viewer.exitCameraMode!=='function')throw Error('CAMERA_NAVIGATION_EXIT_UNSUPPORTED: 当前Viewer不支持统一退出接口')
    ports.ui.showCentre('canvas')
    viewer.exitCameraMode({restoreView:true,focus:true})
  }else{
    if(!input.entityId||!scene?.entities.some(entity=>entity.entityId===input.entityId))throw Error('CAMERA_NAVIGATION_ENTITY_MISSING: 在当前场景选择真实机器人实例')
    if(typeof viewer.focusRobotAnchor!=='function')throw Error('ROBOT_ANCHOR_FOCUS_UNAVAILABLE: 当前Viewer不支持原生标记定位')
    ports.ui.showCentre('canvas');ports.ui.openTool('robot');ports.selectEntity(input.entityId)
    viewer.focusRobotAnchor(input.entityId,input.action==='locateTcp'?'tcp':'base')
  }
  return {applied:true,disposition:'apply' as const,action:input.action,clientId:ports.clientId}
}
