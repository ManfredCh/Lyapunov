/**
 * P8 Notes 底部浮条回归（RC v4 R-007 / 用户批注 6、14、15、16）。
 *
 * 判据：默认只有一条短状态；有标记时只有一个当前正文输入与发送/更多/结束小图标；
 * 列表/坐标/说明/截图收进按需菜单；不再出现 Start annotating / Capture for the model 大按钮与右列整列教程。
 * 交互覆盖：自动聚焦、IME 组合回车不提交、普通回车提交（blur）、Escape 不丢草稿且不冒泡、
 * 发送等待真实回执期间禁用、删除与列表选中走原回调。
 * 离线 jsdom + 真 React 组件，注入回调替身；不发真实截图、不连模型、不启动引擎。
 */
import {afterEach,describe,expect,test} from "bun:test"
import {createRequire} from "node:module"
import {createElement,act} from "react"
import {renderToStaticMarkup} from "react-dom/server"
import {AnnotationPanel} from "../src/annotation-panel.tsx"

const note=(over:Record<string,unknown>={})=>({annotationId:"note-a",index:1,text:"tighten",anchor:{entityId:"ent-a",local:[0,0,0],world:[1,2,3]},...over})
function baseProps(over:Record<string,unknown>={}){
 return {annotations:[note()],activeId:"note-a",annotating:true,readOnly:false,replayActive:false,viewerVisible:true,sceneReady:true,hasEntities:true,sceneId:"scene-a",focusRequest:{annotationId:"note-a",sceneId:"scene-a",token:1},
  entityName:(id:string)=>id==="ent-a"?"Arm":undefined,onToggleMode:()=>{},onSelect:()=>{},onText:()=>{},onRemove:()=>{},onCapture:()=>{},inject:true,onInject:()=>{},captures:[],tr:((_zh:string,en:string)=>en),...over}
}

describe("notes bar static states",()=>{
 test("有标记时只有一个当前正文输入与 Send/更多/结束，不再是大教程按钮",()=>{
  const html=renderToStaticMarkup(createElement(AnnotationPanel,baseProps() as never) as never)
  expect(html).toContain('class="lya-notes-bar"')
  expect(html).toContain("tighten")
  // V11：发送是与设计稿一致的图标按钮（纸飞机）；可读名在 aria-label/title，不再有带字按钮。
  expect(html).toContain('aria-label="Send capture and description to the model"')
  expect(html).not.toContain(">Send<")
  // V10：删除只在按需菜单里，底栏不再常驻删除按钮。
  expect(html).toContain("Delete annotation 1")
  expect(html).not.toContain("Delete note 1")
  expect(html).toContain("End notes")
  expect(html).not.toContain("Start annotating")
  expect(html).not.toContain("Stop annotating")
  expect(html).not.toContain("Capture for the model")
  // 默认不铺开列表/说明/截图：菜单是 details（收起）。
  expect(html).toContain("<details")
  expect(html).not.toContain("<details open")
 })

 test("无标记只给一行短提示",()=>{
  const html=renderToStaticMarkup(createElement(AnnotationPanel,baseProps({annotations:[],activeId:undefined}) as never) as never)
  expect(html).toContain('class="lya-notes-bar"')
  expect(html).toContain("Click a surface to leave a note.")
  expect(html).not.toContain("<textarea")
 })

 test("空场景/无实体、只读、回放、Viewer 关闭各有具体短状态",()=>{
  const empty=renderToStaticMarkup(createElement(AnnotationPanel,baseProps({annotations:[],activeId:undefined,hasEntities:false}) as never) as never)
  expect(empty).toContain("Add an object to leave a note.")
  const readOnly=renderToStaticMarkup(createElement(AnnotationPanel,baseProps({readOnly:true}) as never) as never)
  expect(readOnly).toContain("Notes are read-only in this world.")
  const replay=renderToStaticMarkup(createElement(AnnotationPanel,baseProps({replayActive:true}) as never) as never)
  expect(replay).toContain("Replay notes are read-only.")
  const closed=renderToStaticMarkup(createElement(AnnotationPanel,baseProps({viewerVisible:false}) as never) as never)
  expect(closed).toContain("Viewer is closed")
 })
})

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

describe("notes bar interaction",()=>{
 test("正文仅一组操作，附加内容留在收起菜单；保存模式措辞真实",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({inject:false}) as never) as never))
   const bar=document.querySelector(".lya-notes-bar")!
   expect(bar.querySelectorAll(".lya-notes-input")).toHaveLength(1)
   expect(bar.querySelectorAll(".lya-notes-actions")).toHaveLength(1)
   expect(bar.querySelectorAll(".lya-notes-actions > button")).toHaveLength(2)
   expect(bar.querySelector(".lya-notes-more")!.hasAttribute("open")).toBe(false)
   expect(bar.querySelector(".lya-annotation-remove")!.closest("details")).not.toBeNull()
   expect(bar.querySelector(".lya-notes-send")!.getAttribute("aria-label")).toBe("Save capture and description")
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps({annotations:[],activeId:undefined,hasEntities:false}) as never) as never))
   expect(bar.querySelectorAll(".lya-notes-actions")).toHaveLength(1)
   expect(bar.querySelectorAll("button")).toHaveLength(1)
   expect(bar.querySelector("[role=status]")!.textContent).toBe("Add an object to leave a note.")
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("正文回车不泄漏到外层快捷键；更多菜单 Escape 返回入口",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  const leaked:string[]=[]
  const listener=(event:KeyboardEvent)=>leaked.push(event.key)
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,baseProps() as never) as never))
   document.addEventListener("keydown",listener)
   const textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   await act(async()=>{textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))})
   expect(leaked).toEqual([])
   const details=document.querySelector<HTMLDetailsElement>(".lya-notes-more")!
   details.open=true
   const remove=details.querySelector<HTMLButtonElement>(".lya-annotation-remove")!
   remove.focus()
   await act(async()=>{remove.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))})
   expect(details.open).toBe(false)
   expect(document.activeElement===details.querySelector("summary")).toBe(true)
   expect(leaked).toEqual([])
  }finally{document.removeEventListener("keydown",listener);await act(async()=>root.unmount());dom.window.close()}
 })
 test("自动聚焦当前输入；IME 回车不提交、普通回车提交；Escape 不丢草稿也不冒泡",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  const texts:Array<[string,string]>=[];let selects=0
  const props=baseProps({onText:(id:string,text:string)=>texts.push([id,text]),onSelect:()=>selects++})
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,props as never) as never))
   const textarea=document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!
   expect(document.activeElement).toBe(textarea)
   // IME 组合期间的回车是选字，不触发提交（blur）。
   const composing=new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true})
   Object.defineProperty(composing,"isComposing",{value:true})
   textarea.dispatchEvent(composing)
    const compositionEscape=new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true,isComposing:true})
    await act(async()=>{textarea.dispatchEvent(compositionEscape)})
    expect(document.activeElement).toBe(textarea)
    expect(compositionEscape.defaultPrevented).toBe(false)
   expect(document.activeElement).toBe(textarea)
   // 普通回车提交：收起输入焦点（正文已由 onChange 实时保存）。
   await act(async()=>{textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}))})
   expect(document.activeElement).not.toBe(textarea)
   // Escape 不冒泡到原生对话：document 上的监听器不应收到。
   let leaked=0
   const listener=()=>{leaked++}
   document.addEventListener("keydown",listener)
   textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}))
   document.removeEventListener("keydown",listener)
   expect(leaked).toBe(0)
   expect(texts).toEqual([])
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("发送等待真实回执期间禁用并显示进行中，失败后草稿仍在",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  let rejectCapture:(reason:Error)=>void=()=>{},captures=0
  const props=baseProps({onCapture:()=>{captures++;return new Promise<void>((_resolve,reject)=>{rejectCapture=reject})}})
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,props as never) as never))
   const send=document.querySelector<HTMLButtonElement>(".lya-notes-send")!
   await act(async()=>{send.click()})
   expect(captures).toBe(1)
   expect(send.disabled).toBe(true)
   expect(send.textContent).toContain("…")
   await act(async()=>{rejectCapture(new Error("CAPTURE_FAILED"))})
   expect(send.disabled).toBe(false)
   // 失败回执后回到可再发的图标按钮（可读名不变）。
   expect(send.getAttribute("aria-label")).toBe("Send capture and description to the model")
   expect(send.textContent).not.toContain("Send")
   expect(document.querySelector<HTMLTextAreaElement>(".lya-notes-input")!.value).toBe("tighten")
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })

 test("删除与列表选中都走原回调，index/annotationId 同源",async()=>{
  const dom=installDom();const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!)
  const selected:string[]=[],removed:string[]=[]
  const second=note({annotationId:"note-b",index:2,text:"loosen",anchor:{entityId:"ent-b",local:[0,1,0],world:[4,5,6]}})
  const props=baseProps({annotations:[note(),second],onSelect:(id:string)=>selected.push(id),onRemove:(id:string)=>removed.push(id),entityName:(id:string)=>id==="ent-a"?"Arm":id==="ent-b"?"Base":undefined})
  try{
   await act(async()=>root.render(createElement(AnnotationPanel,props as never) as never))
   const details=document.querySelector<HTMLDetailsElement>(".lya-notes-more")!
   details.open=true
   await act(async()=>{details.querySelectorAll<HTMLButtonElement>(".lya-annotation-pin")[1]!.click()})
   expect(selected).toEqual(["note-a","note-b"])
   // 列表点击后菜单收起。
   expect(details.open).toBe(false)
   details.open=true
   await act(async()=>{document.querySelector<HTMLButtonElement>(".lya-annotation-remove[aria-label='Delete annotation 1']")!.click()})
   expect(removed).toEqual(["note-a"])
  }finally{await act(async()=>root.unmount());dom.window.close()}
 })
})
