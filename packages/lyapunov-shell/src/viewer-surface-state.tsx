import type {ReactNode} from 'react'
import {describeRenderFailure,type RenderFailureTranslate} from './render-failure.ts'
import {SceneCreationActions,type SceneCreationTemplate} from './scene-creation.tsx'

/** 顶部控件参与同一排布，提示换行时也不覆盖相邻控件。 */
export function ViewerOverlays({navigation,importChoice,children}:{navigation:ReactNode;importChoice?:ReactNode;children?:ReactNode}){
 return <div className="lya-viewport-overlays"><div className="lya-first-person-hint">{navigation}</div>{importChoice&&<div className="lya-viewport-import">{importChoice}</div>}{children}</div>
}

/** 只投影现有 Viewer/Scene 状态，不持有另一份渲染或场景状态。 */
export function ViewerSurfaceState({visible,failure,hasScene,available,creating,tr,retry,reopen,create,stop,children}:{
 visible:boolean;failure?:{cause:unknown};hasScene:boolean;available:boolean;creating?:SceneCreationTemplate
 tr:RenderFailureTranslate;retry:()=>void;reopen:()=>void;create:(template:SceneCreationTemplate)=>void;stop?:()=>void;children:ReactNode
}){
 if(!visible)return <div className="lya-viewport-state" data-testid="viewer-closed"><div className="lya-viewport-card">
  <strong>{tr('Viewer 已关闭','Viewer closed')}</strong>
  <p>{tr('场景和物理世界保持原状态，停止按钮仍可用。','The scene and physics world keep their current state. Stop remains available.')}</p>
  <button onClick={reopen}>{tr('重开 Viewer','Reopen viewer')}</button>
  {stop&&<button className="lya-stop" onClick={stop}>{tr('停止世界动作','Stop world actions')}</button>}
 </div></div>
 if(failure){
  const message=describeRenderFailure(failure.cause,tr)
  return <div className="lya-viewport-state" role="alert" data-testid="viewer-render-failure"><div className="lya-viewport-card">
   <strong>{message.title}</strong><p>{message.summary}</p>
   <p>{tr('场景和物理世界保持原状态，停止按钮仍可用。','The scene and physics world keep their current state. Stop remains available.')}</p>
   <button className="lya-primary" onClick={retry}>{tr('重试 3D 画面','Retry 3D view')}</button>
   {stop&&<button className="lya-stop" onClick={stop}>{tr('停止世界动作','Stop world actions')}</button>}
   <details><summary>{tr('诊断详情','Diagnostic details')}</summary><pre>{message.code+'\n'+message.diagnostic}</pre></details>
  </div></div>
 }
 return <>{children}{!hasScene&&<div className="lya-viewport-state" data-testid="scene-empty"><div className="lya-viewport-card lya-scene-empty">
  <strong>{tr('开始制作场景','Start a scene')}</strong>
  <SceneCreationActions initial disabled={!available} busy={creating} tr={tr} create={create}/>
  <p>{available?tr('创建带地面的物理工作区，或从空白场景开始。也可拖入 3D 文件或打开素材库。','Create a physics workspace with a ground, or start with a blank scene. You can also drop a 3D file or open the library.'):tr('先在左侧选择工作区。','Choose a workspace on the left first.')}</p>
 </div></div>}</>
}
