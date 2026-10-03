import {webglNotice} from './environment-readiness.ts'

/** 呈现层只报告 Viewer 的失败；宿主 GPU/驱动处置仍由环境面板拥有。 */
export type RenderFailureTranslate = (zh:string,en:string)=>string
export const WEBGL_UNAVAILABLE_CODE='VIEWER_WEBGL_UNAVAILABLE'
export interface RenderFailureContent {title:string;summary:string;code:string;diagnostic:string}

export function isWebGLUnavailable(value:unknown):boolean{
 if(typeof value==='object'&&value!==null&&(value as {code?:unknown}).code===WEBGL_UNAVAILABLE_CODE)return true
 const raw=value instanceof Error?value.message:String(value??'')
 return raw.includes(WEBGL_UNAVAILABLE_CODE)||/WebGL/i.test(raw)
}

/** 短说明与原文分别呈现，不能从一个浏览器异常推断宿主驱动状态。 */
export function describeRenderFailure(value:unknown,tr:RenderFailureTranslate):RenderFailureContent{
 const diagnostic=value instanceof Error?value.message:String(value)
 if(!isWebGLUnavailable(value))return {
  title:tr('3D 渲染初始化失败','3D rendering failed to initialise'),
  summary:tr('无法打开 3D 画面。请重试；若仍失败，展开诊断详情并反馈。','The 3D view could not open. Retry; if it still fails, include the diagnostic details in your report.'),
  code:'VIEWER_INITIALIZATION_FAILED',diagnostic,
 }
 const notice=webglNotice({status:'broken',reading:`WebGL 上下文创建失败：${diagnostic}`,evidence:[diagnostic]})
 return {
  title:tr('3D 渲染不可用','3D rendering unavailable'),
  summary:tr('当前运行环境未能创建 WebGL 画面。请重试；若仍失败，展开诊断详情并反馈。','This environment could not create a WebGL view. Retry; if it still fails, include the diagnostic details in your report.'),
  code:notice.code,diagnostic,
 }
}
