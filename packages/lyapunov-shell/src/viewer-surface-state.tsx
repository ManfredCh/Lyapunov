import {useState} from 'react'
import type {ReactNode} from 'react'
import {describeRenderFailure,type RenderFailureTranslate} from './render-failure.ts'
import {SceneCreationActions,type SceneCreationTemplate} from './scene-creation.tsx'

/**
 * 视口默认只留画面与一枚简短操作入口：完整鼠标/键盘键位收进按钮控制的帮助面板，
 * 展开才**挂载**并显示（不是用 CSS 藏起来），再点即关闭。按钮可聚焦、有 aria-expanded/title，
 * 关闭后完整键位不在 DOM 里；导入用途选择不再铺在画面上，它归 Objects/Environment/Scene 的导入二级界面。
 * 放置/安装确认、取消、退出与错误仍由 `children` 原样承载，不在这里隐藏。
 */
export function ViewerOverlays({navigation,tr,children,actions}:{navigation:ReactNode;tr:(zh:string,en:string)=>string;children?:ReactNode;/** 与 Controls 同一行的 Lyapunov 自有紧凑动作（取景/Scene focus）；自然 flex 排布，不绝对定位叠角。 */actions?:ReactNode}){
 const [open,setOpen]=useState(false)
 const label=tr('查看鼠标与键盘操作','Show mouse and keyboard controls')
 return <div className="lya-viewport-overlays">
  <div className="lya-canvas-toolbar">
   <div className="lya-viewport-help" data-testid="viewer-controls-help" data-open={open||undefined}>
    <button type="button" className="lya-viewport-help-toggle" aria-expanded={open} aria-label={label} title={label} onClick={()=>setOpen(value=>!value)}>{tr('操作','Controls')}</button>
    {open&&<div className="lya-viewport-help-body" role="region" aria-label={label}>{navigation}</div>}
   </div>
   {actions}
  </div>
  {children}
 </div>
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
