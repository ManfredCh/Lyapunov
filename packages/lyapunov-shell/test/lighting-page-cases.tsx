/**
 * V8-11 Lighting 二级页回归：
 *  · 首屏必须出现设计稿四行（Preset / Intensity / Sun elevation / Color），未启用时禁用并明确
 *    写成 `Not declared`，不得用一枚蓝色按钮顶替整页；
 *  · 选择 Studio、拖 Intensity、改 Sun elevation 必须把**真实补丁**交给 `apply`；
 *  · 全链路再走一遍真实 Workbench：补丁经既有 `scene_edit` HTTP 命令提交，服务端回读后页面
 *    才显示新值——不是面板自己的本地假状态。
 *
 * 边界：Viewer 用本文件的替身（无 WebGL），服务端用内存 Scene 替身；这验证的是面板↔Workbench↔
 * command 的接线与回读，不替代同候选包的真机截图/渲染验收。
 */
import {expect,test,mock} from "bun:test"
import {createElement} from "react"
import {renderToStaticMarkup} from "react-dom/server"
import {EnvironmentPanel} from "../src/environment-panel.tsx"
import {composeEnvironment} from "../../viewer/src/environment.ts"
import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"

let viewerFactory:(...args:unknown[])=>any=()=>({})
mock.module("@lyapunov/viewer/client",()=>({
 projectSceneCameraRigs,
 createViewer:(...args:unknown[])=>viewerFactory(...args),
 WebGLUnavailableError:class extends Error{},
}))

const noop=()=>{}
const studioComponent=()=>composeEnvironment(undefined,{environmentIntensity:1,shadows:true,sun:{elevationDeg:35}}).component
const statusFor=(component?:any,carrier?:string):any=>({
 ...(component?{...(carrier?{carrier}:{}),component}:{}),
 hdriMimeTypes:[],warnings:[],ignored:[],
 environmentSource:"builtin",background:"color",colorBackground:"#242a32",
 exposure:1,toneMapping:"aces",environmentRotationDeg:[0,0,0],
 shadow:{mapSize:512,bias:-.0005,normalBias:0},
 environmentIntensity:component?.environmentIntensity??.7,
 hemisphereIntensity:component?.hemisphereIntensity??2.4,
 shadows:component?.shadows??false,
 sun:component?.sun?{...component.sun,source:"manual"}:{azimuthDeg:90,elevationDeg:45,intensity:3,source:"manual"},
 timeHours:12,clock:{playing:false,offsetHours:0,advancedSeconds:0},
})
const envProps=(patch:any={}):any=>({status:statusFor(patch.component),hdris:[],hdriBusy:false,readOnly:false,viewerVisible:true,busy:false,apply:noop,remove:noop,setPlaying:noop,color:"#242a32",setColor:noop,importHdri:noop,refresh:noop,tr:(_zh:string,en:string)=>en,...patch})

test("Lighting 首屏四行读真实组件：Studio / 1.0 / 35° / Color 未声明",()=>{
 const html=renderToStaticMarkup(createElement(EnvironmentPanel,envProps({component:studioComponent()})))
 expect(html).toContain('data-testid="environment-lighting-preset"')
 expect(html).toContain('data-testid="environment-lighting-intensity"')
 expect(html).toContain('data-testid="environment-lighting-sun-elevation"')
 expect(html).toContain('data-testid="environment-lighting-color"')
 expect(html).toContain('aria-label="Lighting preset"')
 expect(html).toContain('aria-label="Intensity"')
 expect(html).toContain('aria-label="Sun elevation"')
 expect(html).toContain('aria-label="Lighting color"')
 expect(html).toContain('<option value="studio" selected="">Studio</option>')
 expect(html).toContain('value="1.0"')
 expect(html).toContain('value="35"')
 expect(html).toContain('°')
 expect(html).toContain('Shadows · On')
 expect(html).toContain('value="not-declared" selected=""')
 expect(html).not.toContain('Neutral white')
 expect(html).toContain('disabled="" title="The scene environment component has no light color field')
 // 高级/阴影/技术说明默认收起；首屏没有 UUID、矩阵或实现教学段落。
 expect(html.match(/<details[^>]*>/g)?.every(tag=>!tag.includes("open"))).toBe(true)
 expect(html).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-/)
})

test("未启用时四行仍渲染但禁用，唯一的蓝色主按钮写入真实 Studio 补丁",()=>{
 const patches:any[]=[]
 const html=renderToStaticMarkup(createElement(EnvironmentPanel,envProps({apply:(patch:any)=>patches.push(patch)})))
 expect(html).toContain('data-testid="environment-lighting-preset"')
 expect(html).toContain('data-testid="environment-lighting-sun-elevation"')
 expect(html).toContain('value="Not declared"')
 expect(html).toContain('class="lya-primary"')
 expect((html.match(/class="lya-primary"/g)??[]).length).toBe(1)
 expect(html.match(/<button[^>]*>Enable environment lighting<\/button>/)?.[0]).not.toContain("disabled")
})

test("Studio 预设写入整组确定值；Intensity/Sun elevation 只提交一次真实补丁",async()=>{
 const {createRequire}=await import("node:module")
 const req=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))
 const {JSDOM}=req("jsdom")
 const dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ["window","document","HTMLElement","Node","navigator","IS_REACT_ACT_ENVIRONMENT"]){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==="IS_REACT_ACT_ENVIRONMENT"?true:(dom.window as any)[key]})
 }
 const {createElement:reactCreate,act}=await import("react")
 const {createRoot}=await import("react-dom/client")
 const patches:any[]=[]
 let component:any=undefined
 const root=createRoot(document.getElementById("root")!)
 const render=()=>root.render(reactCreate(EnvironmentPanel,envProps({component,apply:(patch:any)=>{patches.push(patch);component=composeEnvironment(component,patch).component;render()}})))
 const select=(label:string)=>document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
 const input=(label:string)=>document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
 const setNumber=async(element:HTMLInputElement,value:string)=>{
  await act(async()=>{
   element.focus()
   Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(element,value)
   element.dispatchEvent(new dom.window.Event("input",{bubbles:true}))
  })
  await act(async()=>element.blur())
 }
 try{
  await act(async()=>render())
  // 初始状态没有组件：四行禁用、Color 只读。
  expect(input("Sun elevation").value).toBe("Not declared")
  expect(input("Sun elevation").disabled).toBe(true)
  expect(select("Lighting color").disabled).toBe(true)
  // 启用写 Studio：IBL 1.0、仰角 35°、阴影开。
  const enable=[...document.querySelectorAll("button")].find(button=>button.textContent==="Enable environment lighting")!
  await act(async()=>enable.click())
  expect(patches.at(-1)).toMatchObject({environmentIntensity:1,shadows:true,sun:{elevationDeg:35}})
  expect(component).toBeDefined()
  expect(select("Lighting preset").value).toBe("studio")
  expect(input("Intensity (0–8)").value).toBe("1.0")
  expect(input("Sun elevation").value).toBe("35")
  expect(document.querySelector('[data-testid="environment-shadows"] > summary')?.textContent).toBe("Shadows · On")
  // 切换 Builtin 写真实值；再切回 Studio 也写整组值。
  const preset=select("Lighting preset")
  await act(async()=>{preset.value="builtin";preset.dispatchEvent(new dom.window.Event("change",{bubbles:true}))})
  expect(patches.at(-1)).toMatchObject({toneMapping:"aces",environmentIntensity:.7,shadows:false})
  expect(select("Lighting preset").value).toBe("builtin")
  await act(async()=>{preset.value="studio";preset.dispatchEvent(new dom.window.Event("change",{bubbles:true}))})
  expect(patches.at(-1)).toMatchObject({environmentIntensity:1,shadows:true,sun:{elevationDeg:35}})
  // Intensity：输入过程中不写，失焦提交一次。
  const count=patches.length
  const intensity=input("Intensity (0–8)")
  await setNumber(intensity,"2.4")
  expect(patches.length).toBe(count+1)
  expect(patches.at(-1)).toEqual({environmentIntensity:2.4})
  expect(input("Intensity (0–8)").value).toBe("2.4")
  // Sun elevation：同样的失焦单次提交，写入 sun 子对象。
  const beforeSun=patches.length
  await setNumber(input("Sun elevation"),"50")
  expect(patches.length).toBe(beforeSun+1)
  expect(patches.at(-1)).toEqual({sun:{elevationDeg:50}})
  expect(input("Sun elevation").value).toBe("50")
  // Color 不可写：仍然只有 Not declared 一个选项，disabled。
  expect(select("Lighting color").value).toBe("not-declared")
  expect(select("Lighting color").disabled).toBe(true)
 }finally{
  await act(async()=>root.unmount())
  dom.window.close()
  for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 }
},20000)

/**
 * 真实 Workbench 接线：同一份 EnvironmentPanel 经 `perform(()=>applyEnvironmentPatch(patch))`
 * 提交 `scene_edit`，服务端回读后才显示新值。
 */
test("Lighting 写值经 Workbench 的 scene_edit 命令提交并在回读后更新页面",async()=>{
 const {createRequire}=await import("node:module")
 const req=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))
 const {JSDOM}=req("jsdom")
 const dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ["window","document","HTMLElement","Node","navigator","localStorage","sessionStorage","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT"]){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  const raw=(dom.window as any)[key]
  const value=key==="IS_REACT_ACT_ENVIRONMENT"?true:typeof raw==="function"&&key.includes("AnimationFrame")?(raw as any).bind(dom.window):raw
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 for(const key of ["ResizeObserver","fetch"])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
 Object.defineProperty(globalThis,"ResizeObserver",{configurable:true,writable:true,value:class{observe(){}disconnect(){}}})
 ;(dom.window as any).HTMLCanvasElement.prototype.getContext=()=>null
 let scene:any={sceneId:"lighting-api-scene",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[]}
 let component:any,carrier:string|undefined
 const commands:any[]=[]
 globalThis.fetch=(async(input:any,init?:RequestInit)=>{
  const url=String(input)
  if(init?.method==="POST"){
   const body=JSON.parse(String(init.body))
   commands.push(body)
   if(body.name==="scene_edit"){
    let next=structuredClone(scene)
    for(const change of body.input.patch??[]){
     if(change.op==="add"&&change.entity){
      next.entities.push(structuredClone(change.entity))
      const environment=change.entity.components?.environment
      if(environment){component=structuredClone(environment);carrier=change.entity.entityId}
     }else if(change.op==="update"&&change.entityId){
      const target=next.entities.find((entity:any)=>entity.entityId===change.entityId)
      if(target&&change.changes?.components?.environment)component=structuredClone(change.changes.components.environment)
      if(target&&change.changes)Object.assign(target,structuredClone(change.changes))
     }
    }
    next.revision=scene.revision+1
    scene=next
    return Response.json({kind:"success",ui:next})
   }
   if(body.name==="ui_action_ack")return Response.json({kind:"success",ui:null})
   return Response.json({kind:"success",ui:null})
  }
  const data=url.includes("/state?")?{hostInstanceId:"host-lighting",scene,worlds:[],providerAvailable:false}
   :url.includes("/scenes")?[{sceneId:scene.sceneId}]
   :url.includes("/engine-preference")?{engine:"mujoco"}
   :url.includes("/selection")?{updated:true}
   :url.includes("builtin-assets")?{resources:[]}
   :url.includes("/assets")||url.includes("missing-assets")?[]
   :[]
  return Response.json(data)
 }) as typeof fetch
 viewerFactory=(options:any)=>{
  const view={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:"orbit"}
  const observer={mode:"free",navigation:"orbit",dirty:false,saving:false,scope:{}}
  const target:any={
   options,renderer:{domElement:document.createElement("canvas")},
   getViewState:()=>view,setScene:()=>Promise.resolve(),
   subscribeObserverState:()=>()=>{},observerState:()=>observer,
   environmentStatus:()=>statusFor(component,carrier),
   composeEnvironment:(patch:any)=>composeEnvironment(component,patch),
   collisionStatus:()=>({status:"disabled"}),animationStatus:()=>({playing:false,clips:[]}),
   dispose:()=>{},
  }
  return new Proxy(target,{get(t,key){return key in t?(t as any)[key]:()=>{}}})
 }
 const {createElement:reactCreate,act,Fragment}=await import("react")
 const {createRoot}=await import("react-dom/client")
 const {Workbench}=await import("../src/workbench.tsx")
 const {ToolRail}=await import("../src/tool-rail.tsx")
 const {useWorkbenchUI}=await import("../src/workbench-ui.ts")
 let fixtureUI:any
 function FixtureUI(){fixtureUI=useWorkbenchUI();return null}
 const root=createRoot(document.getElementById("root")!)
 const flush=(ms=140)=>act(async()=>{await new Promise(done=>setTimeout(done,ms))})
 const byTestId=(id:string)=>document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
 const rail=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button=>button.getAttribute("aria-label")===label)
 try{
  await act(async()=>root.render(reactCreate(FixtureUI)))
  await act(async()=>{fixtureUI.showCentre("canvas");fixtureUI.setMode("collab");fixtureUI.closeDrawer();fixtureUI.closeTool()})
  await act(async()=>root.render(reactCreate(Fragment,null,
   reactCreate(FixtureUI),
   reactCreate(Workbench,{sessionId:"lighting-api-session",nativeTab:true,t:()=>"Scene workbench",renderSlot:(_name:any,_props:any,options:any)=>options?.fallback??null} as any),
   reactCreate(ToolRail,{tr:(_zh:string,en:string)=>en,engine:"mujoco"} as any)
  )))
  await flush();await flush()
  await act(async()=>(rail("Environment") as HTMLElement).click())
  await flush(80)
  const row=byTestId("environment-lighting")
  expect(row).not.toBeNull()
  await act(async()=>row!.click())
  await flush(80)
  // 未启用：四行都在，启用按钮是唯一主按钮。
  expect(byTestId("environment-lighting-preset")).not.toBeNull()
  expect(document.querySelector<HTMLInputElement>('[data-testid="environment-lighting-sun-elevation"]')!.value).toBe("Not declared")
  expect(byTestId("environment-detail-header")!.querySelectorAll(".lya-primary").length).toBe(1)
  const enable=[...document.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="Enable environment lighting")!
  await act(async()=>enable.click())
  for(let i=0;i<30&&!commands.some(command=>command.name==="scene_edit");i++)await flush(80)
  const edit=commands.find(command=>command.name==="scene_edit")
  expect(edit).toBeDefined()
  const added=edit.input.patch.find((change:any)=>change.op==="add"&&change.entity?.components?.environment)?.entity
  expect(added.components.environment).toMatchObject({kind:"scene/environment",environmentIntensity:1,shadows:true,sun:{elevationDeg:35}})
  // 由服务端回读驱动：页面显示 Studio/1.0/35°/Shadows On，而不是本地乐观值。
  for(let i=0;i<30&&document.querySelector<HTMLSelectElement>('[data-testid="environment-lighting-preset"]')?.value!=="studio";i++)await flush(80)
  expect(document.querySelector<HTMLSelectElement>('[data-testid="environment-lighting-preset"]')!.value).toBe("studio")
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Intensity (0–8)"]')!.value).toBe("1.0")
  expect(document.querySelector<HTMLInputElement>('[data-testid="environment-lighting-sun-elevation"]')!.value).toBe("35")
  expect(document.querySelector('[data-testid="environment-shadows"] > summary')?.textContent).toBe("Shadows · On")
  expect(document.querySelector<HTMLSelectElement>('[data-testid="environment-lighting-color"]')!.disabled).toBe(true)
  // 改 Intensity 也走同一命令；回执里是真实场景组件的新值。
  const intensity=document.querySelector<HTMLInputElement>('input[aria-label="Intensity (0–8)"]')!
  await act(async()=>{
   intensity.focus()
   Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(intensity,"2")
   intensity.dispatchEvent(new dom.window.Event("input",{bubbles:true}))
  })
  await act(async()=>intensity.blur())
  for(let i=0;i<30&&commands.filter(command=>command.name==="scene_edit").length<2;i++)await flush(80)
  const updates=commands.filter(command=>command.name==="scene_edit")
  expect(updates.length).toBeGreaterThanOrEqual(2)
  const latest=updates.at(-1)
  const changed=latest.input.patch.find((change:any)=>change.op==="update")
  expect(changed.changes.components.environment.environmentIntensity).toBe(2)
  for(let i=0;i<30&&document.querySelector<HTMLInputElement>('input[aria-label="Intensity (0–8)"]')?.value!=="2.0";i++)await flush(80)
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Intensity (0–8)"]')!.value).toBe("2.0")
 }finally{
  await act(async()=>root.unmount())
  dom.window.close()
  for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 }
},30000)
