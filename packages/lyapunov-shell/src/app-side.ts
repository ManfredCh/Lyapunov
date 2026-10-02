/** 应用层并列侧栏宿主：工具窗经 portal 挂到这里，渲染位置脱离 sidepage（工作台）层。 */
export const appSidePanelHost:{current:HTMLElement|null}={current:null}

/** Portal 的固定坐标来自实际工作台边界；原生工具轨位于该边界右侧，不按窗口宽度猜工具轨宽。 */
export function appSidePanelGeometry(frame:{left:number;right:number;top:number;bottom:number},viewport:{width:number;height:number},preferredWidth:number){
 const clamp=(value:number,max:number)=>Math.min(max,Math.max(0,value))
 const left=clamp(frame.left,viewport.width),right=Math.max(left,clamp(frame.right,viewport.width))
 const top=clamp(frame.top,viewport.height),bottom=Math.max(top,clamp(frame.bottom,viewport.height))
 return {top,right:viewport.width-right,width:Math.min(preferredWidth,right-left),height:bottom-top}
}
