/**
 * P21 #2 的 DOM 接线验证：Native 且有真实 Inspector 时，Viewer 容器（`.lya-wb-canvas`）按
 * `TOOL_PANEL_WIDTH` 让出真实列宽；Notes（画布浮条）无右列、不占 280px 空洞；关闭工具回到整宽。
 *
 * 用已发布 SDK 的 jsdom + 真实 React `Workbench`/`ToolRail` + 注入的 viewer/HTTP 替身，不接触真实窗口、
 * 物理引擎或服务。断言的是**真实 DOM 内联样式**（`.lya-wb-canvas` 的 padding-right），不是源码常量。
 * 边界：本仓 jsdom 无布局引擎，`clientWidth` 用受控 getter 提供工作台宽度；真实截图像素由主控原生验收。
 */
import {test,expect,mock} from "bun:test"
import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
import {composeEnvironment} from "../../viewer/src/environment.ts"

let viewerFactory: (...args: unknown[]) => any = () => ({})
mock.module("@lyapunov/viewer/client", () => ({
 projectSceneCameraRigs,
 createViewer: (...args: unknown[]) => viewerFactory(...args),
 WebGLUnavailableError: class extends Error {},
}))

test("Native 有 Inspector 才给 Viewer 让列；Notes/关闭工具不占空白（真实 DOM 内联样式）", async () => {
 const {createRequire} = await import("node:module")
 const req = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))
 const {JSDOM} = req("jsdom")
 const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid", pretendToBeVisual: true})
 const saved = new Map<string, PropertyDescriptor | undefined>()
 for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : typeof (dom.window as any)[key] === "function" && key.includes("AnimationFrame") ? (dom.window as any)[key].bind(dom.window) : (dom.window as any)[key]
  Object.defineProperty(globalThis, key, {configurable: true, value})
 }
 saved.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"))
 Object.defineProperty(globalThis, "ResizeObserver", {configurable: true, value: class {observe() {} disconnect() {}}})
 saved.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"))
 const scene = {sceneId: "p21-scene", revision: 1, coordinates: {units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw"}, entities: []}
 globalThis.fetch = (async (input: any) => {
  const url = String(input)
  const data = url.includes("/state?") ? {hostInstanceId: "host-p21", scene, worlds: [], providerAvailable: false}
   : url.includes("/scenes") ? [{sceneId: scene.sceneId}]
   : url.includes("/engine-preference") ? {engine: "mujoco"}
   : url.includes("builtin-assets") ? {resources: []}
   : url.includes("/assets") || url.includes("missing-assets") ? []
   : []
  return Response.json(data)
 }) as typeof fetch
 viewerFactory = (options: any) => {
  const view = {position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: "orbit"}
  const observer = {mode: "free", navigation: "orbit", dirty: false, saving: false, scope: {}}
  const target: any = {options, calls: [], renderer: {domElement: document.createElement("canvas")}, getViewState: () => view, setScene: () => Promise.resolve(), subscribeObserverState: () => () => {}, observerState: () => observer, environmentStatus: () => ({hdriMimeTypes: [], warnings: [], ignored: []}), collisionStatus: () => ({status: "disabled"}), animationStatus: () => ({playing: false, clips: []}), dispose: () => {}}
  return new Proxy(target, {get(t, key) { if (key in t) return (t as any)[key]; return () => {} }})
 }
 ;(dom.window as any).HTMLCanvasElement.prototype.getContext = () => null
 // 受控工作台宽度：真实 1440 宽屏折左栏后的右工作区约 984。
 Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {configurable: true, get() { return 984 }})
 const {createElement, act, Fragment} = await import("react")
 const {createRoot} = await import("react-dom/client")
 const {Workbench} = await import("../src/workbench.tsx")
 const {ToolRail} = await import("../src/tool-rail.tsx")
  const {useWorkbenchUI} = await import("../src/workbench-ui.ts")
  let fixtureUI: ReturnType<typeof useWorkbenchUI> | undefined
  function FixtureUI() { fixtureUI = useWorkbenchUI(); return null }
 const root = createRoot(document.getElementById("root")!)
 const tr = (_zh: string, en: string) => en
 const flush = () => act(async () => { await new Promise(done => setTimeout(done, 40)) })
 const canvas = () => document.querySelector<HTMLElement>(".lya-wb-canvas")
 const rail = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => button.getAttribute("aria-label") === label)
 const click = async (element: Element | undefined | null) => { expect(element).toBeTruthy(); await act(async () => (element as HTMLElement).click()) }
 try {
  await act(async () => root.render(createElement(FixtureUI)))
   await act(async () => { fixtureUI!.showCentre('canvas'); fixtureUI!.setMode('collab'); fixtureUI!.closeDrawer(); fixtureUI!.closeTool() })
   await act(async () => root.render(createElement(Fragment, null,
   createElement(Workbench, {sessionId: "p21-flow", nativeTab: true, t: (key: string) => key === "open" ? "Scene workbench" : "场景工作台", renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
   createElement(ToolRail, {tr, engine: "mujoco"}),
  )))
  await flush(); await flush()
  // 无工具：不占右列。
  expect(canvas()!.style.paddingRight).toBe("")
  // Objects：真实 Inspector 出现 ⇒ Viewer 让出 264（984-264=720 可见画布）。
  await click(rail("Objects"))
  await flush()
  expect(document.querySelector('[data-tool="object"]')).not.toBeNull()
  expect(canvas()!.style.paddingRight).toBe("264px")
  // Notes：画布浮条不占右列，也不渲染空的 264px 面板。
  await click(rail("Notes"))
  await flush()
  expect(document.querySelector('[data-tool="annotation"]')).toBeNull()
  expect(canvas()!.style.paddingRight).toBe("")
  // 关闭工具：回到整宽。
  await click(rail("Objects"))
  await flush()
  expect(canvas()!.style.paddingRight).toBe("264px")
  await click(rail("Objects"))
  await flush()
  expect(canvas()!.style.paddingRight).toBe("")
  // --- P21 #3：Capture 首屏减法（真实 Workbench 内渲染） ---
  await click(rail("Capture"))
  await flush()
  const text = () => document.body.textContent ?? ""
  // 首屏：当前视角/拍照/开始拍摄是真按钮；路线是世界相机/保存视角之外的**同栏二级**。
  expect(document.querySelector('[data-testid="capture-take-image"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="capture-start-free"]')).not.toBeNull()
  for (const id of ["capture-world-camera-settings", "capture-views-section"]) {
   const section = document.querySelector<HTMLDetailsElement>(`[data-testid="${id}"]`)
   expect(section).not.toBeNull()
   expect(section!.tagName).toBe("DETAILS")
   expect(section!.open).toBe(false)
  }
  expect(document.querySelector('[data-testid="capture-route"]')).toBeNull()
  await click(document.querySelector('[data-testid="capture-route-entry"]'))
  expect(document.querySelector('[data-testid="capture-route"]')).not.toBeNull()
  expect(document.querySelector('.lya-back')!.textContent).toContain("Capture")
  await act(async () => { document.querySelector<HTMLButtonElement>('.lya-back')!.click() })
  expect(document.querySelector('[data-testid="capture-route"]')).toBeNull()
  expect(document.querySelector('[data-testid="continuous-capture"]')).not.toBeNull()
  // 长帮助只进 title，不铺在首屏文本里；“三张截图不算视频”教程不再出现；空态只一行。
  expect(text()).not.toContain("A still retains camera")
  expect(text()).not.toContain("Three stills")
  expect(text()).not.toContain("Save camera views per scene")
  expect(text()).toContain("No videos yet")
  // 展开保存视角后，Camera name/Save view 仍在（handler 可点）。
  const views = document.querySelector<HTMLDetailsElement>('[data-testid="capture-views-section"]')!
  await act(async () => { views.open = true })
  expect(document.querySelector('input[aria-label="Camera name"]')).not.toBeNull()
  expect([...document.querySelectorAll("button")].some(button => button.textContent === "Save view")).toBe(true)
  expect(text()).toContain("No saved views yet.")
  // Camera 19～21：主摘要与保存/录制入口在折叠外，Camera details 只放诊断。
  await click(rail("Camera"))
  await flush()
  // V9-19：无机器人/无草稿时只给短空态与 Add camera，不铺旧世界相机摘要/保存表单。
  expect(document.querySelector('[data-testid="camera-summary"]')).toBeNull()
  expect(document.querySelector('[data-testid="camera-mounted-list"]')).toBeNull()
  expect(document.body.textContent).toContain("Choose a robot first")
  expect([...document.querySelectorAll("button")].some(button => /Save (camera|body|current-view)/.test(button.textContent ?? ""))).toBe(false)
  // Robots：默认先 Robot Library；In scene 是清楚的第二页签，不在库前铺两个实例标题。
  await click(rail("Robots"))
  await flush()
  expect(document.querySelector('[data-testid="robot-library"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="robot-instance-list"]')).toBeNull()
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.includes("In scene"))!.click() })
  await flush()
  expect(document.querySelector('[data-testid="robot-instance-list"]')).not.toBeNull()
  // Scene 页脚不再宣称未经状态证明的“自动同步”。
  await click(rail("Scene"))
  await flush()
  expect(text()).not.toContain("scene and physics stay in sync")
 } finally {
  await act(async () => root.unmount())
  dom.window.close()
  for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
 }
}, 15000)

/**
 * 本批实际交互收口：Camera 的 Record this camera 只固定 Recording source，不接管 Main viewing camera。
 * 真 Workbench + 真 Camera/Recording 面板 + jsdom；Viewer 用明确记录 pilotCameraRig 的替身。
 */
test("旧Viewer加载失败不覆盖新版本；卸载后的state响应不写缓存",async()=>{
 const {createRequire}=await import('node:module')
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
 const {JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT','fetch','ResizeObserver']){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?class{observe(){}disconnect(){}}:typeof dom.window[key]==='function'&&key.includes('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 const scene={sceneId:'shell-lifecycle',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]}
 let revision=1,holdState=false,historyReads=0
 const held:Array<()=>void>=[]
 const payload=()=>({hostInstanceId:'shell-host',scene:{...scene,revision},worlds:[],providerAvailable:false})
 globalThis.fetch=(async(input:any)=>{
  const url=String(input)
  if(url.includes('/state?')){
   if(holdState)return new Promise<Response>(resolve=>held.push(()=>resolve(Response.json(payload()))))
   return Response.json(payload())
  }
  if(url.includes('scene-history'))historyReads++
  return Response.json(url.includes('/scenes')?[{sceneId:scene.sceneId}]:url.includes('/engine-preference')?{engine:'mujoco'}:url.includes('builtin-assets')?{resources:[]}:[])
 }) as typeof fetch
 const loads:Array<{revision:number;resolve():void;reject(error:Error):void}>=[]
 const observer={mode:'free',navigation:'orbit',dirty:false,saving:false,scope:{}}
 viewerFactory=()=>new Proxy({
  renderer:{domElement:document.createElement('canvas')},
  getViewState:()=>({position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:'orbit'}),
  observerState:()=>observer,
  subscribeObserverState:()=>()=>{},
  setScene:(snapshot:any)=>new Promise<void>((resolve,reject)=>loads.push({revision:snapshot.revision,resolve,reject})),
  environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[]}),collisionStatus:()=>({status:'disabled'}),dispose:()=>{},
 },{get(target,key){return key in target?(target as any)[key]:()=>{}}})
 dom.window.HTMLCanvasElement.prototype.getContext=()=>null
 const {act,createElement}=await import('react')
 const {createRoot}=await import('react-dom/client')
 const {Workbench}=await import('../src/workbench.tsx')
 const {useWorkbenchUI}=await import('../src/workbench-ui.ts')
 let ui:ReturnType<typeof useWorkbenchUI>|undefined
 function FixtureUI(){ui=useWorkbenchUI();return null}
 const root=createRoot(document.getElementById('root')!)
 let unmounted=false
 const flush=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,100))})
 try{
  await act(async()=>root.render(createElement(FixtureUI)))
  await act(async()=>{ui!.showCentre('canvas');ui!.setMode('collab');ui!.closeDrawer();ui!.closeTool()})
  await act(async()=>root.render(createElement(Workbench,{sessionId:'shell-unmount',nativeTab:true,t:()=> 'Scene workbench',renderSlot:(_n:any,_p:any,options:any)=>options?.fallback??null} as any)))
  for(let i=0;i<12&&!loads.some(load=>load.revision===1);i++)await flush()
  expect(loads.some(load=>load.revision===1)).toBe(true)
  revision=2
  for(let i=0;i<12&&!loads.some(load=>load.revision===2);i++)await flush()
  expect(loads.some(load=>load.revision===2)).toBe(true)
  await act(async()=>{for(const load of loads.filter(load=>load.revision===2))load.resolve()})
  await act(async()=>{for(const load of loads.filter(load=>load.revision===1))load.reject(new Error('STALE_VIEWER_LOAD_FAILURE'))})
  expect(document.body.textContent).not.toContain('STALE_VIEWER_LOAD_FAILURE')
  revision=3
  for(let i=0;i<12&&!loads.some(load=>load.revision===3);i++)await flush()
  expect(loads.some(load=>load.revision===3)).toBe(true)
  await act(async()=>{for(const load of loads.filter(load=>load.revision===3))load.reject(new Error('CURRENT_VIEWER_LOAD_FAILURE'))})
  expect(document.body.textContent).toContain('CURRENT_VIEWER_LOAD_FAILURE')
  holdState=true
  for(let i=0;i<12&&!held.length;i++)await flush()
  expect(held.length).toBeGreaterThan(0)
  const cached=sessionStorage.getItem('lyapunov.workbench.shell-unmount'),beforeHistory=historyReads
  await act(async()=>root.unmount());unmounted=true
  revision=4
  await act(async()=>{held.forEach(resolve=>resolve())})
  expect(sessionStorage.getItem('lyapunov.workbench.shell-unmount')).toBe(cached)
  expect(historyReads).toBe(beforeHistory)
 }finally{
  if(!unmounted)await act(async()=>root.unmount())
  held.forEach(resolve=>resolve())
  await act(async()=>{loads.forEach(load=>load.resolve())})
  dom.window.close()
  for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 }
})

test("Record this camera 预选真实 native source，且不调用 pilotCameraRig", async () => {
 const {createRequire} = await import("node:module")
 const req = createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json", import.meta.url))
 const {JSDOM} = req("jsdom")
 const dom = new JSDOM('<div id="root"></div>', {url: "http://fixture.invalid", pretendToBeVisual: true})
 const saved = new Map<string, PropertyDescriptor | undefined>()
 for (const key of ["window", "document", "HTMLElement", "Node", "navigator", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : typeof (dom.window as any)[key] === "function" && key.includes("AnimationFrame") ? (dom.window as any)[key].bind(dom.window) : (dom.window as any)[key]
  Object.defineProperty(globalThis, key, {configurable: true, value})
 }
 saved.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"))
 Object.defineProperty(globalThis, "ResizeObserver", {configurable: true, value: class {observe() {} disconnect() {}}})
 saved.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"))
 const robotId = "robot-1", cameraId = "cam-1", cameraName = `${cameraId}/Wrist RGB-D`
 const scene: any = {sceneId: "cam-scene", revision: 1, coordinates: {units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw"}, entities: [
  {entityId: robotId, name: "Panda One", transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {articulation: {}}},
  {entityId: cameraId, name: "Wrist RGB-D", transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {camera: {name: "Wrist RGB-D", fovYDeg: 50, width: 160, height: 120, near: .01, far: 100, mount: {entityId: robotId, bodyName: "hand", positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1]}}}},
 ]}
 const world: any = {worldId: "cam-world", sceneId: "cam-scene", engineId: "mujoco", engineVersion: "fixture", worldGeneration: 1, appliedSceneRevision: 1, status: "running"}
 const cameraRow: any = {cameraName, resolvedCameraName: cameraName, entityId: cameraId, parentEntityId: robotId, parentBodyName: "hand", cameraSource: "scene-camera", available: true, width: 160, height: 120, worldFromCamera: {positionM: [0, 0, 1.2], quaternionXyzw: [0, 0, 0, 1]}, intrinsics: {fx: 160, fy: 160, cx: 80, cy: 60, width: 160, height: 120}, nearM: .01, farM: 100, frameId: "cam-world:1:1", stepIndex: 1, generation: 1, sceneRevision: 1, simTime: 0}
 const frame: any = {worldId: "cam-world", generation: 1, stepIndex: 1, simTime: 0, sceneRevision: 1, frameId: "cam-world:1:1", cameras: [cameraRow], entities: [{entityId: robotId, sensors: {bodyWorldPoses: {hand: {positionM: [0, 0, 1], quaternionXyzw: [0, 0, 0, 1]}}}}]}
 globalThis.fetch = (async (input: any) => {
  const url = String(input)
  const data = url.includes("/state?") ? {hostInstanceId: "host-cam", scene, worlds: [world], providerAvailable: false}
   : url.includes("/scenes") ? [{sceneId: scene.sceneId}]
   : url.includes("/engine-preference") ? {engine: "mujoco"}
   : url.includes("builtin-assets") ? {resources: []}
   : url.includes("camera-list") ? {sceneId: scene.sceneId, sceneRevision: scene.revision, worldId: world.worldId, generation: world.worldGeneration, cameras: [cameraRow], bodies: [{entityId: robotId, bodyName: "hand", worldFromBody: {positionM: [0, 0, 1], quaternionXyzw: [0, 0, 0, 1]}}]}
   : url.includes("frame?") ? frame
   : url.includes("/assets") || url.includes("missing-assets") ? []
   : []
  return Response.json(data)
 }) as typeof fetch
 const pilotCalls: any[] = []
 const frameCalls: string[] = []
 viewerFactory = (options: any) => {
  const view = {position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: "orbit"}
  const observer = {mode: "free", navigation: "orbit", dirty: false, saving: false, scope: {}}
  const target: any = {options, getViewState: () => view, setScene: () => Promise.resolve(), pilotCameraRig: (...args: any[]) => pilotCalls.push(args), focus: (id: string) => frameCalls.push(`focus:${id}`), frameAll: () => frameCalls.push("scene"), subscribeObserverState: () => () => {}, observerState: () => observer, environmentStatus: () => ({hdriMimeTypes: [], warnings: [], ignored: []}), collisionStatus: () => ({status: "disabled"}), animationStatus: () => ({playing: false, clips: []}), renderer: {domElement: document.createElement("canvas")}, dispose: () => {}}
  return new Proxy(target, {get(t, key) { if (key in t) return (t as any)[key]; return () => {} }})
 }
 ;(dom.window as any).HTMLCanvasElement.prototype.getContext = () => null
 const {createElement, act, Fragment} = await import("react")
 const {createRoot} = await import("react-dom/client")
 const {Workbench} = await import("../src/workbench.tsx")
 const {ToolRail} = await import("../src/tool-rail.tsx")
  const {useWorkbenchUI} = await import("../src/workbench-ui.ts")
  let fixtureUI: ReturnType<typeof useWorkbenchUI> | undefined
  function FixtureUI() { fixtureUI = useWorkbenchUI(); return null }
 const root = createRoot(document.getElementById("root")!)
 const tr = (_zh: string, en: string) => en
 const flush = (ms = 340) => act(async () => { await new Promise(done => setTimeout(done, ms)) })
 const rail = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button => button.getAttribute("aria-label") === label)
 try {
  await act(async () => root.render(createElement(FixtureUI)))
   await act(async () => { fixtureUI!.showCentre('canvas'); fixtureUI!.setMode('collab'); fixtureUI!.closeDrawer(); fixtureUI!.closeTool() })
   await act(async () => root.render(createElement(Fragment, null,
   createElement(Workbench, {sessionId: "cam-record", nativeTab: true, t: (key: string) => key === "open" ? "Scene workbench" : "场景工作台", renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
   createElement(ToolRail, {tr, engine: "mujoco"}),
  )))
  await flush(); await flush()
  // V10：自有主画布有可发现的框选动作；无选中时 Frame selection 禁用，Frame scene 只移动查看相机。
  const frameSelection=document.querySelector<HTMLButtonElement>('[data-testid="frame-selection"]')!
  const frameScene=document.querySelector<HTMLButtonElement>('[data-testid="frame-scene"]')!
  expect(frameSelection.getAttribute('aria-label')).toBe('Frame selection')
  expect(frameSelection.disabled).toBe(true)
  expect(frameScene.getAttribute('aria-label')).toBe('Frame scene')
  await act(async () => frameScene.click())
  expect(frameCalls).toContain('scene')
  await act(async () => rail("Camera")!.click())
  await flush()
  const cameraButton = document.querySelector<HTMLButtonElement>('[data-testid="camera-mounted-scene-cam-1"]')
  expect(cameraButton).not.toBeNull()
  await act(async () => cameraButton!.click())
  await flush()
  // V8-21：画布自有浮层宿主与入口都在；打开前不铺三张大图/长表单。
  expect(document.querySelector('.lya-compare-overlay-host')).not.toBeNull()
  expect(document.querySelector('[data-testid="camera-compare-open"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="camera-compare-dialog"]')).toBeNull()
  const record = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Record this camera")
  expect(record).toBeTruthy()
  expect(record!.disabled).toBe(false)
  await act(async () => record!.click())
  await flush()
  // 录制面板按真实 camera 名预选同一 source；相机没有 pilot 接管主视角。
  const source = document.querySelector<HTMLSelectElement>('select[aria-label="Robot camera"]')
  expect(source).not.toBeNull()
  expect(source!.value).toBe(`${robotId}/hand/${cameraName}`)
  expect(pilotCalls).toHaveLength(0)
 } finally {
  await act(async () => root.unmount())
  dom.window.close()
  for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
 }
})

/**
 * 本批宿主集成的共用夹具：真 Workbench + 真 ToolRail + jsdom + Viewer/HTTP 替身。
 * 只服务本文件新增的宿主集成断言；既有用例的 FixtureUI 起点与 15000ms 超时保持不变。
 */
async function withP21Workbench(run:(ctx:any)=>Promise<void>){
 const {createRequire}=await import("node:module")
 const req=createRequire(new URL("../../../.upstream/deepseek-harness-20260911-candidate/package.json",import.meta.url))
 const {JSDOM}=req("jsdom") as any
 const dom=new JSDOM('<div id="root"></div>',{url:"http://fixture.invalid",pretendToBeVisual:true})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ["window","document","HTMLElement","Node","navigator","localStorage","sessionStorage","requestAnimationFrame","cancelAnimationFrame","IS_REACT_ACT_ENVIRONMENT"]){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  const raw=(dom.window as any)[key]
  const value=key==="IS_REACT_ACT_ENVIRONMENT"?true:typeof raw==="function"&&key.includes("AnimationFrame")?(raw as any).bind(dom.window):raw
  Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 for(const key of ["ResizeObserver","fetch","MediaRecorder"])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
 Object.defineProperty(globalThis,"ResizeObserver",{configurable:true,writable:true,value:class{observe(){}disconnect(){}}})
 ;(dom.window as any).HTMLCanvasElement.prototype.getContext=()=>null
 ;(dom.window as any).HTMLElement.prototype.attachEvent=()=>{}
 ;(dom.window as any).HTMLElement.prototype.detachEvent=()=>{}
 const {createElement,act,Fragment}=await import("react")
 const {createRoot}=await import("react-dom/client")
 const {Workbench}=await import("../src/workbench.tsx")
 const {ToolRail}=await import("../src/tool-rail.tsx")
 const {useWorkbenchUI}=await import("../src/workbench-ui.ts")
 let fixtureUI:ReturnType<typeof useWorkbenchUI>|undefined
 function FixtureUI(){fixtureUI=useWorkbenchUI();return null}
 const root=createRoot(document.getElementById("root")!)
 const tr=(_zh:string,en:string)=>en
 const flush=(ms=120)=>act(async()=>{await new Promise(done=>setTimeout(done,ms))})
 const byTestId=(id:string)=>document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
 const rail=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>(".lya-rail-item")].find(button=>button.getAttribute("aria-label")===label)
 const click=async(element:Element|undefined|null)=>{expect(element).toBeTruthy();await act(async()=>(element as HTMLElement).click())}
 let booted=false
 const mount=async(sessionId:string)=>{
  if(!booted){await act(async()=>root.render(createElement(FixtureUI)));await act(async()=>{fixtureUI!.showCentre("canvas");fixtureUI!.setMode("collab");fixtureUI!.closeDrawer();fixtureUI!.closeTool()});booted=true}
  else await act(async()=>{fixtureUI!.closeTool();fixtureUI!.setMode("collab");fixtureUI!.showCentre("canvas")})
  await act(async()=>root.render(createElement(Fragment,null,
   createElement(FixtureUI),
   createElement(Workbench,{key:sessionId,sessionId,nativeTab:true,t:(key:string)=>key==="open"?"Scene workbench":"场景工作台",renderSlot:(_n:any,_p:any,options:any)=>options?.fallback??null} as any),
   createElement(ToolRail,{tr,engine:"mujoco"}),
  )))
  await flush(140);await flush(180)
 }
 try{await run({act,flush,byTestId,rail,click,mount})}
 finally{
  await act(async()=>root.unmount())
  dom.window.close()
  for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 }
}

/** 拍摄会话进行中，宿主设置入口必须真的不可达；停止后同一批入口原样回来。 */
test("拍摄进行中宿主设置不可达，会话浮条/Viewer 保持，停止后恢复",async()=>{
 await withP21Workbench(async({flush,byTestId,rail,click,mount})=>{
  const scene={sceneId:"capture-host-lock",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[]}
  globalThis.fetch=(async(input:any)=>{
   const url=String(input)
   if(url.includes("capture-video"))return Response.json({videoId:"video-1",source:"free",container:"webm",codec:"vp8",durationMs:0,bytes:0,width:320,height:240,startedAt:"2026-10-20T00:00:00.000Z",stoppedAt:"2026-10-20T00:00:00.000Z",stopReason:"user-stop",frameRate:30})
   const data=url.includes("/state?")?{hostInstanceId:"host-capture-lock",scene,worlds:[],providerAvailable:false}
    :url.includes("/scenes")?[{sceneId:scene.sceneId}]
    :url.includes("/engine-preference")?{engine:"mujoco"}
    :url.includes("/selection")?{updated:true}
    :url.includes("builtin-assets")?{resources:[]}
    :url.includes("/assets")||url.includes("missing-assets")?[]
    :[]
   return Response.json(data)
  }) as typeof fetch
  // 只替身浏览器编码器：会话仍走真实的 ContinuousVideoRecorder 状态机与 stop 收尾。
  class FakeMediaRecorder{
   state:"inactive"|"recording"="inactive"
   mimeType="video/webm"
   ondataavailable:((event:{data:Blob})=>void)|null=null
   onerror:((event:{error?:unknown})=>void)|null=null
   onstop:(()=>void)|null=null
   constructor(_stream:unknown,options?:{mimeType?:string}){if(options?.mimeType)this.mimeType=options.mimeType}
   static isTypeSupported(){return true}
   start(){this.state="recording"}
   stop(){this.state="inactive";this.onstop?.()}
  }
  ;(globalThis as any).MediaRecorder=FakeMediaRecorder
  // viewer 处于 pilot：CameraReturnControl 是真实可见的宿主返程入口，用来验证它随拍摄一起收起。
  const observer={mode:"pilot",navigation:"orbit",dirty:false,saving:false,scope:{}}
  viewerFactory=(options:any)=>{
   const view={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:"orbit"}
   const target:any={options,renderer:{domElement:document.createElement("canvas")},getViewState:()=>view,setScene:()=>Promise.resolve(),subscribeObserverState:()=>()=>{},observerState:()=>observer,environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[],environmentSource:"builtin"}),collisionStatus:()=>({status:"disabled"}),animationStatus:()=>({playing:false,clips:[]}),captureCanvasStream:()=>({stream:{getTracks:()=>[]},width:320,height:240}),dispose:()=>{}}
   return new Proxy(target,{get(t,key){return key in t?(t as any)[key]:()=>{}}})
  }
  await mount("capture-host-lock")
  await click(rail("Capture"))
  for(let i=0;i<15&&(byTestId("capture-start-free")?.hasAttribute("disabled")??true);i++)await flush(60)
  await flush(80)
  // 空闲态：设置、世界固定机位与 CameraReturnControl 都在。
  expect(byTestId("capture-settings")).not.toBeNull()
  expect(byTestId("capture-world-camera-settings")).not.toBeNull()
  expect(document.querySelector('[aria-label="Return to main view"]')).not.toBeNull()
  await click(byTestId("capture-start-free"))
  await flush(120)
  // 拍摄中：设置子树整体不在 DOM；会话浮条/真实 Viewer 容器仍在。
  expect(byTestId("capture-recording-bar")).not.toBeNull()
  expect(byTestId("capture-host-lock")).not.toBeNull()
  // 设计稿 V8-24：拍摄态不写复述性文案；锁定只作为不可见语义标记存在。
  expect(byTestId("capture-host-lock")!.textContent).toBe("")
  expect(byTestId("capture-settings")).toBeNull()
  expect(byTestId("capture-world-camera-settings")).toBeNull()
  expect(byTestId("capture-source-scope")).toBeNull()
  expect(document.querySelector('[aria-label="Return to main view"]')).toBeNull()
  expect(document.querySelector(".lya-canvas")).not.toBeNull()
  expect(byTestId("capture-active")).not.toBeNull()
  // 停止后同一批入口恢复；浮条消失。
  await click(document.querySelector<HTMLButtonElement>('[data-testid="capture-recording-bar"] .lya-stop'))
  for(let i=0;i<25&&byTestId("capture-settings")===null;i++)await flush(80)
  expect(byTestId("capture-recording-bar")).toBeNull()
  expect(byTestId("capture-host-lock")).toBeNull()
  expect(byTestId("capture-settings")).not.toBeNull()
  expect(byTestId("capture-world-camera-settings")).not.toBeNull()
  expect(document.querySelector('[aria-label="Return to main view"]')).not.toBeNull()
 })
},20000)

/**
 * 环境二级页只保留 PanelPage 的一条返回；World/Lighting 副标题各自读真实事实；
 * Ground 摘要按 groundState + 地面实体 + visual.visible 区分，不一律 Visible。
 */
test("环境二级页只有一处返回；World/Lighting 副标题与 Ground 状态按真实事实区分",async()=>{
 await withP21Workbench(async({flush,byTestId,rail,click,mount})=>{
  const coordinates={units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"}
  const component=composeEnvironment(undefined,{}).component
  const baseStatus={component,hdriMimeTypes:[],warnings:[],ignored:[],environmentSource:"builtin",background:"color",colorBackground:"#242a32",exposure:1,toneMapping:"aces",environmentRotationDeg:[0,0,0],shadow:{mapSize:1024,bias:0,normalBias:0},environmentIntensity:.7,hemisphereIntensity:.5,shadows:true,sun:{azimuthDeg:90,elevationDeg:45,intensity:3,source:"manual"},timeHours:12,clock:{playing:false,offsetHours:0,advancedSeconds:0}}
  // 每个用例可换一份真实读数；HDRI 未落地时 World 行必须说 not loaded / still showing，不冒充成功。
  let status:any=baseStatus
  viewerFactory=(options:any)=>{
   const view={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:"orbit"}
   const observer={mode:"free",navigation:"orbit",dirty:false,saving:false,scope:{}}
   const target:any={options,renderer:{domElement:document.createElement("canvas")},getViewState:()=>view,setScene:()=>Promise.resolve(),subscribeObserverState:()=>()=>{},observerState:()=>observer,environmentStatus:()=>status,collisionStatus:()=>({status:"disabled"}),animationStatus:()=>({playing:false,clips:[]}),dispose:()=>{}}
   return new Proxy(target,{get(t,key){return key in t?(t as any)[key]:()=>{}}})
  }
  const sceneFor=(label:string,physics?:any,visible?:boolean)=>({
   sceneId:`env-${label}`,revision:1,coordinates,...(physics?{physics}:{}),
   entities:physics?.groundEntityId?[{entityId:physics.groundEntityId,name:"Ground",transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{visual:{kind:"primitive",visible}}}]:[],
  })
  const groundPhysics=(groundState:string)=>({gravityWorldMps2:[0,0,-9.81],template:"physics-workspace-v2",groundEntityId:"ground",groundState})
  const cases=[
   {label:"hidden",expected:"Hidden",physics:groundPhysics("present"),visible:false},
   {label:"visible",expected:"Visible",physics:groundPhysics("present"),visible:true},
   {label:"removed",expected:"Removed",physics:groundPhysics("removed"),visible:true},
   {label:"disabled",expected:"Disabled",physics:groundPhysics("disabled"),visible:true},
   {label:"undeclared",expected:"Not declared"},
   {label:"hdri-pending",expected:"Visible",physics:groundPhysics("present"),visible:true,hdri:{resourceId:"sky",version:2,loaded:false,loading:false,applied:{resourceId:"sky",version:1}}},
  ]
  for(const [index,entry] of cases.entries()){
   const scene:any=sceneFor(entry.label,entry.physics,entry.visible)
   status=entry.hdri?{...baseStatus,environmentSource:"builtin",hdri:entry.hdri}:baseStatus
   globalThis.fetch=(async(input:any)=>{
    const url=String(input)
    const data=url.includes("/state?")?{hostInstanceId:`host-${scene.sceneId}`,scene,worlds:[],providerAvailable:false}
     :url.includes("/scenes")?[{sceneId:scene.sceneId}]
     :url.includes("/engine-preference")?{engine:"mujoco"}
     :url.includes("/selection")?{updated:true}
     :url.includes("builtin-assets")?{resources:[]}
     :url.includes("/assets")||url.includes("missing-assets")?[]
     :[]
    return Response.json(data)
   }) as typeof fetch
   await mount(`env-host-${entry.label}`)
   await click(rail("Environment"))
   // 等真实场景/环境读数落地（setScene 完成后 readEnvironmentStatus 才会给灯光读数）。
   for(let i=0;i<20&&(byTestId("environment-lighting-status")?.textContent??"")==="Studio lighting";i++)await flush(60)
   const worldSubtitle=byTestId("environment-world-source")!.textContent
   const lightingSubtitle=byTestId("environment-lighting-status")!.textContent
   if(entry.hdri){
    expect(worldSubtitle).toContain("sky@2")
    expect(worldSubtitle).toContain("not loaded")
    expect(worldSubtitle).toContain("still showing sky@1")
   }else expect(worldSubtitle).toContain("Environment component")
   expect(lightingSubtitle).toContain("Exposure 1")
   expect(worldSubtitle).not.toBe(lightingSubtitle)
   await click(byTestId("environment-world"))
   const anchor=byTestId("environment-world-header")
   expect(anchor).not.toBeNull()
   const parentLabels=[...anchor!.querySelectorAll(".lya-eyebrow,.lya-back")].map(element=>element.textContent?.replace("‹","").trim()).filter(text=>text==="Environment")
   expect(parentLabels).toHaveLength(1)
   expect(anchor!.querySelectorAll(".lya-page-head .lya-eyebrow")).toHaveLength(0)
   expect(anchor!.querySelectorAll(".lya-back")).toHaveLength(1)
   expect(anchor!.querySelectorAll("h2")).toHaveLength(1)
   expect(anchor!.closest(".lya-panel-page")).not.toBeNull()
   const ground=byTestId("environment-world-ground")
   expect(ground).not.toBeNull()
   const summary=ground!.querySelector("summary")!.textContent!
   expect(summary).toContain(entry.expected)
   if(entry.expected!=="Visible")expect(summary).not.toContain("Visible")
   expect(ground!.textContent).toContain(entry.expected)
   // 返回仍走 PanelPage 的同一个 onBack，原始 testid 锚点继续可达。
   await click(anchor!.querySelector(".lya-back"))
   expect(byTestId("environment-world")).not.toBeNull()
   expect(byTestId("environment-world-header")).toBeNull()
   if(index===0){
    await click(byTestId("environment-lighting"))
    await flush(80)
    const detail=byTestId("environment-detail-header")
    expect(detail).not.toBeNull()
    expect(detail!.querySelectorAll(".lya-back")).toHaveLength(1)
    expect(detail!.querySelectorAll(".lya-page-head .lya-eyebrow")).toHaveLength(0)
    expect(detail!.querySelectorAll("h2")).toHaveLength(1)
    await click(detail!.querySelector(".lya-back"))
    expect(byTestId("environment-lighting")).not.toBeNull()
   }
  }
 })
},30000)

/** 对象资产页：Search assets 是列表第一个控件，导入/设置在资产列表之后，键盘顺序不靠 CSS 调换。 */
test("对象资产页 Search assets 在导入与资源列表之前",async()=>{
 await withP21Workbench(async({flush,byTestId,rail,click,mount})=>{
  const scene={sceneId:"object-order",revision:1,coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},entities:[]}
  const asset={ref:{resourceId:"cube",version:1,original:{uri:"file:///cube.glb",mimeType:"model/gltf-binary"}},name:"Cube",tags:[],folder:"",parsed:{kind:"mesh"}}
  globalThis.fetch=(async(input:any)=>{
   const url=String(input)
   const data=url.includes("/state?")?{hostInstanceId:"host-object-order",scene,worlds:[],providerAvailable:false}
    :url.includes("/scenes")?[{sceneId:scene.sceneId}]
    :url.includes("/engine-preference")?{engine:"mujoco"}
    :url.includes("/selection")?{updated:true}
    :url.includes("builtin-assets")?{resources:[]}
    :url.includes("/assets")?[asset]
    :url.includes("missing-assets")?[]
    :[]
   return Response.json(data)
  }) as typeof fetch
  viewerFactory=(options:any)=>{
   const view={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:"orbit"}
   const observer={mode:"free",navigation:"orbit",dirty:false,saving:false,scope:{}}
   const target:any={options,renderer:{domElement:document.createElement("canvas")},getViewState:()=>view,setScene:()=>Promise.resolve(),subscribeObserverState:()=>()=>{},observerState:()=>observer,environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[],environmentSource:"builtin"}),collisionStatus:()=>({status:"disabled"}),animationStatus:()=>({playing:false,clips:[]}),dispose:()=>{}}
   return new Proxy(target,{get(t,key){return key in t?(t as any)[key]:()=>{}}})
  }
  await mount("object-order")
  await click(rail("Objects"))
  for(let i=0;i<15&&(byTestId("object-add-primary")?.hasAttribute("disabled")??true);i++)await flush(60)
  await click(byTestId("object-add-primary"))
  for(let i=0;i<20&&!document.querySelector(".lya-object-asset-row");i++)await flush(60)
  const search=byTestId("object-asset-search")
  const listRoot=document.querySelector<HTMLElement>(".lya-object-asset-picker")
  const row=document.querySelector<HTMLElement>(".lya-object-asset-row")
  const importEntry=byTestId("object-import-entry")
  const importButton=byTestId("object-add-import")
  const importSettings=byTestId("object-import-settings")
  expect(search).not.toBeNull()
  expect(listRoot).not.toBeNull()
  expect(row).not.toBeNull()
  expect(importEntry).not.toBeNull()
  expect(importButton).not.toBeNull()
  expect(importSettings).not.toBeNull()
  // 设计稿 object-assets：Search assets → Import file → IMPORTED 行；高级项在列表之后（DOM 顺序，不是 CSS order）。
  expect(listRoot!.contains(search!)).toBe(true)
  expect(listRoot!.contains(row!)).toBe(true)
  expect(search!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(search!.compareDocumentPosition(importButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(importButton!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(search!.compareDocumentPosition(importSettings!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(listRoot!.contains(importEntry!)).toBe(true)
  // 选择区只保留 asset-library-panel 的一份真实搜索；管理折叠里自己的搜索不属于本页选择顺序。
  expect(listRoot!.querySelectorAll('input[aria-label="Search assets"]')).toHaveLength(1)
 })
},20000)
