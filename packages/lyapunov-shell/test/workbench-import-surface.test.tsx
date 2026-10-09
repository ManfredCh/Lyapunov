/**
 * `workbench.tsx` 在宿主侧导入边界（**已登记为未覆盖项**的替代件）。
 *
 * 为什么需要它：`workbench.tsx:127` 的 `viewerResourceURI`（以及 `prepareViewerScene`）在浏览器面，
 * 宿主侧测试 import 它会拉 `@lyapunov/viewer/client` 的浏览器 ModuleLoader 产物；这里补齐其公开导入面。
 * 这份用例用 `mock.module` 只替掉那一个包，于是**产品源码那一句是真的被 import 进来跑的**，
 * 不需要在别处复刻它的正则或逻辑。
 *
 * 边界：**这不是 `prepareViewerScene` 的行为验收**（那属于 P3 的接线层口径）。它只保证
 * "宿主侧能拿到 `workbench.tsx` 里那两句并被测到"。
 *
 * 用法：`bun test packages/lyapunov-shell/test/workbench-import-surface.test.tsx`
 */
import { test, expect, mock } from "bun:test"
import * as THREE from "three"
import {SceneViewer} from "../../viewer/src/index.ts"
import { readFileSync } from "node:fs"

import {projectSceneCameraRigs} from "../../viewer/src/scene-camera-rigs.ts"
let viewerFactory:(...args:unknown[])=>any=()=>({})
mock.module("@lyapunov/viewer/client", () => ({ projectSceneCameraRigs, createViewer: (...args:unknown[]) => viewerFactory(...args), WebGLUnavailableError: class extends Error {} }))

test("`workbench.tsx` 可导入，且 `viewerResourceURI` 是真的产品实现", async () => {
  const mod = await import("../src/workbench.tsx")
  expect(typeof mod.viewerResourceURI).toBe("function")
  expect(typeof mod.prepareViewerScene).toBe("function")
  // 接线层自己写下的形状：`res:<指纹>?ext=.obj` → 标记（媒体路由按标记等值匹配）。
  expect(mod.viewerResourceURI("res:abc?ext=.obj")).toBe("res:abc")
  expect(mod.viewerResourceURI("res:abc")).toBe("res:abc")
  expect(mod.viewerResourceURI("/abs/path/x.stl")).toBe("/abs/path/x.stl")
})

test("漫游帮助写明Q下降/E上升及Shift倍率，视角中心与模型平移合同分开", async () => {
  const mod = await import("../src/workbench.tsx")
  expect(mod.VIEWER_NAVIGATION_HELP.zh).toContain("Q 下降 / E 上升")
  expect(mod.VIEWER_NAVIGATION_HELP.zh).toContain("Shift 加速 5 倍")
  expect(mod.VIEWER_NAVIGATION_HELP.en).toContain("Q down / E up")
  const plugin = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
  const start = plugin.indexOf('  name:"ui_action",')
  const contract = plugin.slice(start, plugin.indexOf('  parameters:', start))
  expect(contract).toContain("enterSceneCenter")
  expect(contract).toContain("Neither moves the model")
  expect(contract).toContain("complete transform in scene_edit")
})


test("原Workbench同Scene重建与旧promise隔离；右键当帧批注跨布局仍建marker并保存",async()=>{
 const {createRequire}=await import('node:module'),req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof dom.window[key]==='function'&&key.includes('AnimationFrame')?dom.window[key].bind(dom.window):dom.window[key]})}
 saved.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){}disconnect(){}}})
 saved.set('fetch',Object.getOwnPropertyDescriptor(globalThis,'fetch'))
 const scene={sceneId:'same-scene',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'annotation-entity',name:'Toolbox body',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{}}]};let host='host-a'
 globalThis.fetch=(async(input:any)=>{const url=String(input);const data=url.includes('/state?')?{hostInstanceId:host,scene,worlds:[],providerAvailable:false}:url.includes('/scenes')?[{sceneId:scene.sceneId}]:url.includes('/engine-preference')?{engine:'mujoco'}:url.includes('/selection')?{updated:true}:url.includes('/assets')?{assets:[]}:[];return Response.json(data)}) as typeof fetch
 const instances:any[]=[];const view={position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:'orbit'}
 viewerFactory=(options:any)=>{let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done}),state={mode:'free',navigation:'orbit',dirty:false,saving:false,scope:{}};const calls:any[]=[];const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial()),group=new THREE.Group(),camera=new THREE.PerspectiveCamera(50,1,.1,100);group.userData.entityId='annotation-entity';group.add(mesh);group.updateMatrixWorld(true);camera.position.set(0,0,5);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);let width=200;const canvas=document.createElement('canvas');canvas.getBoundingClientRect=()=>({left:0,top:0,width,height:200,right:width,bottom:200,x:0,y:0,toJSON(){}});options.container.appendChild(canvas)
 const instance:any=new Proxy({calls,resolve,options,camera,renderer:{domElement:canvas},objects:new Map([['annotation-entity',{group}]]),markers:new Map(),annotationRoot:new THREE.Group(),annotations:[],selected:'annotation-entity',resize:()=>{width=800},select:(id:string)=>{instance.selected=id},setAnnotations:SceneViewer.prototype.setAnnotations,annotationHitAtPointer:(SceneViewer.prototype as any).annotationHitAtPointer,applyAnnotationHit:(SceneViewer.prototype as any).applyAnnotationHit,openContextMenu:(SceneViewer.prototype as any).openContextMenu,setScene:(value:any)=>{instance.snapshot=value;calls.push(['setScene',value]);return pending},subscribeObserverState:()=>()=>{},observerState:()=>state,getViewState:()=>view,environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[]}),collisionStatus:()=>({status:'disabled'}),animationStatus:()=>({playing:false,clips:[]})},{get(target,key){if(key in target)return (target as any)[key];return (...args:any[])=>{calls.push([key,...args])}}});instances.push(instance);return instance}
 dom.window.HTMLCanvasElement.prototype.getContext=()=>null
 dom.window.HTMLElement.prototype.attachEvent=()=>{};dom.window.HTMLElement.prototype.detachEvent=()=>{}
 const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client'),{Workbench}=await import('../src/workbench.tsx'),root=createRoot(document.getElementById('root')!)
 const flush=()=>act(async()=>{await new Promise(done=>setTimeout(done,320))})
 try{
  await act(async()=>root.render(createElement(Workbench,{sessionId:'rebuild-session',nativeTab:true,t:()=> '场景工作台',renderSlot:(_name:any,_props:any,options:any)=>options?.fallback??null} as any)));await flush();await flush()
  const original=instances.at(-1);expect(original).toBeDefined();expect(original.calls.filter((call:any[])=>call[0]==='setScene').length).toBe(1)
  host='host-b';await flush();await flush();const rebuilt=instances.at(-1);expect(rebuilt).not.toBe(original)
  expect(rebuilt.calls.filter((call:any[])=>call[0]==='setScene').length).toBe(1)
  await act(async()=>original.resolve());expect(document.querySelector('.lya-wb-canvas')?.getAttribute('aria-busy')).toBe('true');expect(rebuilt.calls.some((call:any[])=>call[0]==='setViewState'||call[0]==='openDefaultView')).toBe(false)
  await act(async()=>rebuilt.resolve());expect(rebuilt.calls.filter((call:any[])=>call[0]==='setViewState').length).toBe(1);expect(document.querySelector('.lya-wb-canvas')?.getAttribute('aria-busy')).toBe('false')
  await act(async()=>rebuilt.options.onSelection('annotation-entity'))
  await act(async()=>rebuilt.openContextMenu(new dom.window.MouseEvent('contextmenu',{clientX:100,clientY:100,cancelable:true})))
  rebuilt.resize() // 菜单打开后布局改变；旧像素二次射线已偏离Toolbox，真实旧表面锚点必须保留。
  expect(rebuilt.annotationHitAtPointer(100,100,'annotation-entity')).toBeUndefined()
  await act(async()=>{const annotate=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button=>button.textContent==='批注');expect(annotate).toBeDefined();annotate!.click()})
  expect(rebuilt.markers.size).toBe(1);expect(rebuilt.annotations.length).toBe(1);expect(rebuilt.annotations[0].anchor.entityId).toBe('annotation-entity')
  expect(rebuilt.annotations[0].anchor.world[2]).toBeCloseTo(.512);expect(rebuilt.annotations[0].anchor.normal).toEqual([0,0,1])
  expect(JSON.parse(localStorage.getItem('lyapunov.annotations.same-scene')??'[]').length).toBe(1)
  await flush();expect(rebuilt.markers.size).toBe(1);expect(JSON.parse(localStorage.getItem('lyapunov.annotations.same-scene')??'[]').length).toBe(1)
 }finally{await act(async()=>root.unmount());viewerFactory=()=>({});dom.window.close();for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key]}}
})
