/** 动作效果的纯目录；宿主与前端共用，不建立UI/Session状态。 */
export const CAMERA_NAVIGATION_ACTIONS=['exitCameraView','locateTcp','locateBase'] as const
export type CameraNavigationAction=typeof CAMERA_NAVIGATION_ACTIONS[number]
export const isCameraNavigationAction=(action:string):action is CameraNavigationAction=>
  (CAMERA_NAVIGATION_ACTIONS as readonly string[]).includes(action)
export const SURFACE_ACTIONS=['openTool','showCanvas','selectEntity','focus','enterSceneCenter','openFiles','openTerminal','openResource',...CAMERA_NAVIGATION_ACTIONS] as const
/** metadata采样/图像/指定相机及场景选择只操作目标窗口；共享展示由消费者另核前台。 */
export const SESSION_ACTIONS=['selectScene','captureViewer','applyCameraViewer','renderCameraViewer','sampleCameraViewer'] as const
export const surfaceDisposition=(action:string,ownsSurface:boolean):'apply'|'defer'=>
  ownsSurface||!(SURFACE_ACTIONS as readonly string[]).includes(action)?'apply':'defer'
