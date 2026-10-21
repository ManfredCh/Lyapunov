/**
 * P21 布局时序与 Viewer 让列判据（无 DOM 的纯判据 / 初始化顺序）。
 *
 * 1. `compactLeftSidebarOnce`：默认紧凑左栏必须在**首次 openRightbar/注册 tab 之前**用公开
 *    `ctx.layout.toggleSidebar()` 折起；宽视口只折一次（用户本页再展开/拖拽不被抢）；<1024 不调用
 *    （SDK 已自动折叠，toggle 会反向展开）；DOM 已折叠（HMR/二次求值）不重复 toggle。
 *    `registerNativeWorkspace` 的真实调用顺序用 stub ctx 记录：`compact-sidebar` 必须早于 `register-scene-tab`。
 * 2. `viewerReservedWidth`：Native 且有真实 Inspector 才按 TOOL_PANEL_WIDTH 让列；Notes/无工具/非 Native/
 *    临时模式/窄到放不下都为 0（不占空白、不引入横向滚动）。
 *
 * 边界：这里不渲染 React、不测 CSS 像素；DOM 端的样式接线在 `p21-viewer-reserve.test.tsx` 里验证。
 */
import {describe,expect,mock,test} from "bun:test"
import {viewerReservedWidth,TOOL_PANEL_WIDTH,MIN_VIEWER_WIDTH} from "../src/workbench-ui.ts"
import {workbenchStyle} from "../src/workbench-style.ts"

// native-workspace 经 workbench 依赖已构建的 viewer client；本文件不渲染，只按名字满足导入。
mock.module("@lyapunov/viewer/client", () => ({
 projectSceneCameraRigs: () => [],
 createViewer: () => ({}),
 WebGLUnavailableError: class extends Error {},
}))
const {compactLeftSidebarOnce,registerNativeWorkspace,resetSidebarCompactionForTests,seedPinnedSceneRightbar}=await import("../src/native-workspace.tsx")

type Globals={window?:unknown;document?:unknown}
function withGlobals<T>(next:Globals,run:()=>T):T{
 const saved:Array<[string,PropertyDescriptor|undefined]>=[]
 for(const key of ["window","document"] as const){
  saved.push([key,Object.getOwnPropertyDescriptor(globalThis,key)])
  if(next[key]===undefined)Reflect.deleteProperty(globalThis,key)
  else Object.defineProperty(globalThis,key,{configurable:true,value:next[key]})
 }
 try{return run()}finally{for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}}
}
function windowStub(innerWidth:number){return {innerWidth}}
function documentStub(collapsed=false){
 return {
  querySelector:(selector:string)=>collapsed&&selector==='[data-sidebar-collapsed="true"]'?{name:"frame"}:null,
  createElement:()=>({className:"",dataset:{} as Record<string,string>,style:{},remove(){}}),
  body:{appendChild(){}},
 }
}
/** 记录调用顺序的 stub ctx；`effect` 同步执行（cordis 的 effect 在应用时同步跑）。 */
function stubContext(order:string[],toggle:()=>void){
 const ctx:any={
  layout:{toggleSidebar:toggle,openRightbar:(track:boolean,fullscreen:boolean,alongside?:boolean)=>{order.push(`open-rightbar:${String(track)}:${String(fullscreen)}:${String(alongside)}`)},closeRightbar:()=>{order.push("close-rightbar")}},
  locale:{bind:()=>(zh:string,en:string)=>en||zh},
  get:(name:string)=>name==="sessions"?{scope:()=>undefined,refresh(){},list:{getSnapshot:()=>[]}}:undefined,
  sidebarRightTabs:{register:()=>{order.push("register-scene-tab");return()=>{}}},
  sidebarRight:{openTab(){},active:()=>undefined,openResource(){},openResourceIn(){},isExpanded:()=>false},
  slots:{inject:()=>()=>{},register:()=>()=>{}},
  effect:(fn:()=>unknown)=>{const dispose=fn();return typeof dispose==="function"?dispose:()=>{}},
  conversation:{input:{for:()=>({insertReference:()=>false,focus(){}})}},
  uiWorkspace:{openSession(){}},
 }
 return ctx
}

describe("P21 首次右栏 openRightbar 之前的公开 collapse（真实初始化顺序）",()=>{
 test("registerNativeWorkspace：宽视口先 toggleSidebar，再注册 Scene tab（顺序可观测）",()=>{
  resetSidebarCompactionForTests()
  const order:string[]=[]
  withGlobals({window:windowStub(1440),document:documentStub(false)},()=>{
   registerNativeWorkspace(stubContext(order,()=>order.push("compact-sidebar")))
  })
  expect(order.filter(step=>step==="compact-sidebar")).toHaveLength(1)
  expect(order.indexOf("compact-sidebar")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("compact-sidebar")).toBeLessThan(order.indexOf("register-scene-tab"))
 })

 test("宽视口只折一次：用户本页再展开/拖拽不会被下一次调用抢回",()=>{
  resetSidebarCompactionForTests()
  let calls=0
  withGlobals({window:windowStub(1440),document:documentStub(false)},()=>{
   expect(compactLeftSidebarOnce({layout:{toggleSidebar:()=>{calls+=1}}} as never)).toBe(true)
   expect(compactLeftSidebarOnce({layout:{toggleSidebar:()=>{calls+=1}}} as never)).toBe(false)
  })
  expect(calls).toBe(1)
 })

 test("窄视口（974）不误展开：SDK 已自动折叠，产品不再 toggle",()=>{
  resetSidebarCompactionForTests()
  let calls=0
  const result=withGlobals({window:windowStub(974),document:documentStub(false)},()=>compactLeftSidebarOnce({layout:{toggleSidebar:()=>{calls+=1}}} as never))
  expect(result).toBe(false)
  expect(calls).toBe(0)
 })

 test("DOM 已是折叠态（HMR/二次求值）不再 toggle，避免宽屏反向展开成 280px",()=>{
  resetSidebarCompactionForTests()
  let calls=0
  const result=withGlobals({window:windowStub(1440),document:documentStub(true)},()=>compactLeftSidebarOnce({layout:{toggleSidebar:()=>{calls+=1}}} as never))
  expect(result).toBe(false)
  expect(calls).toBe(0)
 })
})

describe("V10 pinned Scene 首开 alongside 正常默认（公开 ILayout 动作，真实初始化顺序）",()=>{
 test("注册 Scene tab 之前先 openRightbar(false,false,true) 再 close，只预置首开默认宽度",()=>{
  resetSidebarCompactionForTests()
  const order:string[]=[]
  withGlobals({window:windowStub(1440),document:documentStub(false)},()=>{
   registerNativeWorkspace(stubContext(order,()=>order.push("compact-sidebar")))
  })
  const open=order.filter(step=>step.startsWith("open-rightbar:"))
  expect(open).toEqual(["open-rightbar:false:false:true"])
  expect(order.indexOf("open-rightbar:false:false:true")).toBeLessThan(order.indexOf("register-scene-tab"))
  expect(order.indexOf("close-rightbar")).toBeGreaterThan(order.indexOf("open-rightbar:false:false:true"))
  expect(order.indexOf("close-rightbar")).toBeLessThan(order.indexOf("register-scene-tab"))
 })
 test("只初始化一次；右栏已展开时不写/不重置已存在宽度",()=>{
  resetSidebarCompactionForTests()
  let calls=0
  const ctx:any={layout:{openRightbar:()=>{calls+=1},closeRightbar:()=>{calls+=1}},sidebarRight:{isExpanded:()=>false}}
  expect(seedPinnedSceneRightbar(ctx)).toBe(true)
  expect(seedPinnedSceneRightbar(ctx)).toBe(false)
  expect(calls).toBe(2)
  resetSidebarCompactionForTests()
  const expanded:any={layout:{openRightbar:()=>{calls+=1},closeRightbar:()=>{calls+=1}},sidebarRight:{isExpanded:()=>true}}
  expect(seedPinnedSceneRightbar(expanded)).toBe(false)
  expect(calls).toBe(2)
 })
})

test("V10 真实 Layout store：预置 alongside 后首开保持 984px，不再落成 45% 的 648px",async()=>{
 resetSidebarCompactionForTests()
 const {createLayoutStore}=await import("../../../.upstream/deepseek-harness-20260911-candidate/packages/client/ui-layout/src/client/stores.ts")
 withGlobals({window:windowStub(1440)},()=>{
  const {store,actions}=createLayoutStore().create()
  // 与真实首开顺序一致：先折左栏（280→0），再注册 pinned Scene 前预置 alongside。
  actions.toggleSidebar()
  const ctx:any={layout:{openRightbar:actions.openRightbar,closeRightbar:actions.closeRightbar},sidebarRight:{isExpanded:()=>false}}
  expect(seedPinnedSceneRightbar(ctx)).toBe(true)
  const seeded=store.getSnapshot().layoutInfo
  expect(seeded.rightbarShown).toBe(false)
  expect(seeded.rightbar).toBe(984) // 1440 - 56 - 400
  // 首次普通 open（SDK ensurePinned 之前的 layout effect）不得把已初始化宽度重算成 45%。
  actions.openRightbar(true,false)
  expect(store.getSnapshot().layoutInfo.rightbar).toBe(984)
  expect(store.getSnapshot().layoutInfo.rightbar).not.toBe(648)
 })
})

describe("P21 Viewer 给 Inspector 让列的判据（Native 且有真实 Inspector 才占列）",()=>{
 const base={native:true,active:true,tool:"object",panelSuppressed:false,fullWidth:984}
 test("1440 宽屏右工作区 984：让出 264，可见画布约 720",()=>{
  expect(viewerReservedWidth(base)).toBe(TOOL_PANEL_WIDTH)
  expect(base.fullWidth-viewerReservedWidth(base)).toBe(720)
 })
 test("Notes 画布浮条 / 无工具 / 非 Native / 临时模式：0 空白",()=>{
  expect(viewerReservedWidth({...base,tool:"annotation"})).toBe(0)
  expect(viewerReservedWidth({...base,tool:null})).toBe(0)
  expect(viewerReservedWidth({...base,native:false})).toBe(0)
  expect(viewerReservedWidth({...base,active:false})).toBe(0)
  expect(viewerReservedWidth({...base,panelSuppressed:true})).toBe(0)
 })
 test("窄到放不下一块可用画布时不再占列（沿用 SDK 响应布局，不制造横向滚动）",()=>{
  expect(viewerReservedWidth({...base,fullWidth:MIN_VIEWER_WIDTH+TOOL_PANEL_WIDTH-1})).toBe(0)
  expect(viewerReservedWidth({...base,fullWidth:MIN_VIEWER_WIDTH+TOOL_PANEL_WIDTH})).toBe(TOOL_PANEL_WIDTH)
  expect(viewerReservedWidth({...base,fullWidth:0})).toBe(0)
 })
})


describe("V9 视觉收口二：自有面板局部默认与排版",()=>{
 test("264px 面板用继承 color-scheme 的 light-dark 局部变量，不改全局 token",()=>{
  for(const declaration of [
   "--lya-panel-bg:light-dark(#f7f8fa,#181b1f)",
   "--lya-field:light-dark(#ffffff,#22262c)",
   "--lya-panel-divider:light-dark(#d7dde5,#2c3138)",
   "--lya-panel-text:light-dark(#1a1f26,#e1e6ec)",
   "--lya-panel-secondary:light-dark(#5b6572,#929ca9)",
   "--lya-panel-action:light-dark(#2f6bd8,#3578ee)",
  ])expect(workbenchStyle).toContain(declaration)
  // 变量只挂在 .lya-wb-panel 作用域；没有写 body/html 或原生 Chat/Sidebar/Files/Terminal。
  expect(workbenchStyle).not.toContain('[data-sidebar-right-toggle]')
  expect(workbenchStyle).not.toMatch(/body\{[^}]*--lya-panel/)
  expect(workbenchStyle).not.toMatch(/\.lya-wb\{[^}]*--lya-panel/)
 })
 test("空态扁平 88px；整页不再损失右 22px，只有标题行让位关闭按钮",()=>{
  expect(workbenchStyle).toMatch(/\.lya-wb-panel \.lya-empty-state\{[^}]*min-height:88px[^}]*border:0[^}]*background:transparent/)
  expect(workbenchStyle).toMatch(/\.lya-wb-panel \.lya-empty-icon\{[^}]*background:transparent/)
  expect(workbenchStyle).not.toMatch(/\.lya-wb-panel \.lya-panel-page\{[^}]*padding-right:22px/)
  expect(workbenchStyle).toContain(".lya-wb-panel .lya-panel-page{display:flex;flex-direction:column;gap:12px;min-width:0;flex:1 0 auto;padding-right:0}")
  expect(workbenchStyle).toContain(".lya-wb-panel .lya-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-height:28px;padding-right:22px}")
  expect(workbenchStyle).toMatch(/\.lya-wb-panel \.lya-panel-foot\{[^}]*margin:auto -16px -16px/)
 })
 test("Notes 与 Capture 同开时两条画布浮条竖向错开，不互相覆盖",()=>{
  expect(workbenchStyle).toContain(".lya-wb-canvas[data-notes-open] .lya-capture-session-bar{bottom:56px}")
  expect(workbenchStyle).toContain(".lya-notes-bar{position:absolute;left:50%;bottom:10px;")
 })
})

describe("V10 窄窗 Scene focus 只接公开控制器",()=>{
 test("Scene focus 用 commandTarget + toggleFullscreen，不写私有 rightbar 宽度",async()=>{
  const source=await Bun.file(new URL("../src/native-workspace.tsx",import.meta.url)).text()
  expect(source).toContain("ctx.sidebarRight.commandTarget()")
  expect(source).toContain("ctx.sidebarRight.toggleFullscreen(target)")
  expect(source).not.toMatch(/setRightbar|rightbar\s*=|localStorage[^\n]*rightbar|data-sidebar-right[^\n]*style/)
 })
})
