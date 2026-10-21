/**
 * P8 焦点返修：Notes 浮条正文的**显式编辑焦点请求**回归。
 *
 * 真机失败：点物体落批注后浏览器补发的 mousedown 默认动作把焦点从浮条输入框抢回画布
 * （事件序复现见 .rc-evidence/p8-focus-fix）。这里钉住面板侧的另一半契约——
 *   · 焦点只由 workbench 发出的 `focusRequest`（带自增 token）驱动，不是 "activeId 变了" 的副作用；
 *   · 同一条标记 blur 后再点，activeId 不变，只要 token 变了就必须重新聚焦（用户要求"再点它回到正文"）；
 *   · 请求身份（annotationId + sceneId）与当前正文不一致时一律不聚焦，迟到的请求不抢别的输入焦点；
 *   · 没有请求（例如刷新后装载旧标记）不自动聚焦。
 * 这里**不冒充**真实浏览器：mousedown 默认聚焦是浏览器行为，jsdom 不实现，由真机验收与
 * `.rc-evidence/p8-focus-fix` 的真实 Edge 事件序覆盖。离线 jsdom + 真 React 组件。
 */
import {afterEach,describe,expect,test} from "bun:test"
import {createRequire} from "node:module"
import {createElement,act} from "react"
import {AnnotationPanel} from "../src/annotation-panel.tsx"

const note=(over:Record<string,unknown>={})=>({annotationId:"note-a",index:1,text:"tighten",anchor:{entityId:"ent-a",local:[0,0,0],world:[1,2,3]},...over})
function baseProps(over:Record<string,unknown>={}){
 return {annotations:[note()],activeId:"note-a",annotating:true,readOnly:false,replayActive:false,viewerVisible:true,sceneReady:true,hasEntities:true,sceneId:"scene-a",focusRequest:{annotationId:"note-a",sceneId:"scene-a",token:1},
  entityName:(id:string)=>id==="ent-a"?"Arm":undefined,onToggleMode:()=>{},onSelect:()=>{},onText:()=>{},onRemove:()=>{},onCapture:()=>{},inject:true,onInject:()=>{},captures:[],tr:((_zh:string,en:string)=>en),...over}
}

const saved=new Map<string,PropertyDescriptor|undefined>()
function installDom(){
 const req=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))
 const {JSDOM}=req("jsdom"),dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
 for(const key of ["window","document","HTMLElement","Node","navigator","KeyboardEvent","IS_REACT_ACT_ENVIRONMENT"]){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  const value=key==="IS_REACT_ACT_ENVIRONMENT"?true:(dom.window as never as Record<string,unknown>)[key]
  Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 return dom
}
afterEach(()=>{for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as never as Record<string,unknown>)[key]}saved.clear()})

describe("notes editor focus request",()=>{
 test("落点请求聚焦；同一条标记 blur 后重选（activeId 不变、token 变）仍重新聚焦",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps() as never) as never))
   let textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   expect(document.activeElement).toBe(textarea)
   // 用户 Escape/Enter 收起焦点（产品里 textarea.blur），正文仍在。
   await act(async()=>{textarea.blur()})
   expect(document.activeElement).not.toBe(textarea)
   // 再点同一条标记：activeId 不变，workbench 仍发一次新 token 的请求。
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:{annotationId:"note-a",sceneId:"scene-a",token:2}}) as never) as never))
   textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   expect(document.activeElement).toBe(textarea)
   expect(textarea.value).toBe("tighten")
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("身份不符的迟到请求不聚焦：换到别的批注/别的场景都不抢当前焦点",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:undefined}) as never) as never))
   const textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   expect(document.activeElement).not.toBe(textarea)
   // 请求指向另一条批注：正文是 note-a，不聚焦。
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:{annotationId:"note-b",sceneId:"scene-a",token:2}}) as never) as never))
   expect(document.activeElement).not.toBe(textarea)
   // 请求是同一批注但另一个场景：同样不聚焦。
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:{annotationId:"note-a",sceneId:"scene-b",token:3}}) as never) as never))
   expect(document.activeElement).not.toBe(textarea)
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("刷新后装载旧标记（没有请求）不自动聚焦；请求到达才聚焦",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:undefined}) as never) as never))
   const textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   expect(document.activeElement).not.toBe(textarea)
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:{annotationId:"note-a",sceneId:"scene-a",token:9}}) as never) as never))
   expect(document.activeElement).toBe(textarea)
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("旧焦点请求不会在批注列表更新时抢回已离开的焦点",async()=>{
   const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
   try{
    const props=baseProps()
    await act(async()=>root.render(createElement(AnnotationPanel,props as never) as never))
    const other=document.createElement("input")
    document.getElementById("root")!.append(other)
    other.focus()
    const second=note({annotationId:"note-b",index:2,text:"loosen"})
    await act(async()=>root.render(createElement(AnnotationPanel,{...props,annotations:[note(),second]} as never) as never))
    expect(document.activeElement===other).toBe(true)
   }finally{await act(async()=>root.unmount());dom.window.close()}
  })

  test("批注从列表移除后，指向它的迟到请求不聚焦也不报错",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({focusRequest:undefined}) as never) as never))
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({annotations:[],activeId:undefined,focusRequest:undefined}) as never) as never))
   expect(document.querySelector(".lya-notes-input")).toBeNull()
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })
})
