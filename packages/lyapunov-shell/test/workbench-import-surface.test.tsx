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
import {createRequire} from "node:module"
import {AssetLibraryPanel,AssetPlacementBar,assetPlacementOf,assetPlacementInput,type AssetPlacement} from "../src/asset-library-panel.tsx"
import type {AssetRecord} from "../src/workbench-api.ts"

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
 globalThis.fetch=(async(input:any)=>{const url=String(input);const data=url.includes('/state?')?{hostInstanceId:host,scene,worlds:[],providerAvailable:false}:url.includes('/scenes')?[{sceneId:scene.sceneId}]:url.includes('/engine-preference')?{engine:'mujoco'}:url.includes('/selection')?{updated:true}:url.includes('/assets')?[]:[];return Response.json(data)}) as typeof fetch
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

test("原环境/材质/面积灯面板提交真实补丁；空数值不写0，重置恢复源引用",async()=>{
 const {createRequire}=await import('node:module'),req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="controls"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','IS_REACT_ACT_ENVIRONMENT']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key]})}
 dom.window.HTMLElement.prototype.attachEvent=()=>{};dom.window.HTMLElement.prototype.detachEvent=()=>{}
 const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client'),{MaterialPanel}=await import('../src/material-panel.tsx'),{EnvironmentPanel}=await import('../src/environment-panel.tsx'),{SceneLightPanel}=await import('../src/scene-light-panel.tsx')
 const {EntityMaterialOverride,composeMaterialOverride,parseMaterialOverride}=await import('../../viewer/src/material-override.ts'),{defaultSceneEnvironment,parseEnvironmentComponent}=await import('../../viewer/src/environment.ts')
 const {renderControlDiagnostic}=await import('../src/render-control-diagnostics.ts')
 const owner=new EntityMaterialOverride(),source=new THREE.MeshStandardMaterial({roughness:.38,metalness:.1,map:new THREE.Texture()}),group=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),source);group.add(mesh)
 const root=createRoot(document.getElementById('controls')!),patches:any[]=[],tr=(zh:string)=>zh
 let component:any
 const renderMaterial=()=>root.render(createElement(MaterialPanel,{status:{entityId:'selected',loaded:true,declared:Boolean(component),component,warnings:[],...owner.readings([group])},busy:false,readOnly:false,tr,apply:(patch:any)=>{patches.push(patch);component=composeMaterialOverride(component,patch).component;owner.apply([group],component);renderMaterial()},reset:()=>{component=undefined;owner.reset();renderMaterial()}}))
 const input=(label:string)=>document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
 const setValue=async(element:HTMLInputElement,value:string)=>{await act(async()=>{element.focus();Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));element.dispatchEvent(new dom.window.KeyboardEvent('keyup',{key:'1',bubbles:true}))});await act(async()=>element.blur())}
 try{
  await act(async()=>renderMaterial())
  expect(input('粗糙度').value).toBe('0.38');expect(input('法线强度倍率').disabled).toBe(true)
  await setValue(input('粗糙度'),'0.66')
  expect(patches.at(-1)).toEqual({roughness:.66});expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(.66);expect(source.roughness).toBe(.38)
  const count=patches.length;await setValue(input('不透明度'),'');expect(patches.length).toBe(count)
  await act(async()=>input('使用原贴图').click());expect((mesh.material as THREE.MeshStandardMaterial).map).toBeNull();expect(source.map).toBeInstanceOf(THREE.Texture)
  await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='重置为原始材质')!.click());expect(mesh.material).toBe(source)
  const env=defaultSceneEnvironment(),status:any={component:env,hdriMimeTypes:[],warnings:[],ignored:[],environmentSource:'builtin',environmentIntensity:.7,exposure:1,hemisphereIntensity:2.4,shadows:false,sun:{...env.sun,source:'manual'},timeHours:12,clock:{playing:false,offsetHours:0,advancedSeconds:0},colorBackground:'#121a24'}
  await act(async()=>root.render(createElement(EnvironmentPanel,{status,hdris:[],hdriBusy:false,readOnly:false,viewerVisible:true,busy:false,tr,color:'#121a24',apply:(patch:any)=>patches.push(patch),remove:()=>{},setPlaying:()=>{},setColor:()=>{},importHdri:()=>{},refresh:()=>{}})))
  // 默认只给四个短控件；高级/HDRI 的提交控件在具名折叠里，驱动前先展开。
  const advanced=document.querySelector<HTMLDetailsElement>('[data-testid="environment-lighting-advanced"]')!
  expect(advanced.open).toBe(false)
  await act(async()=>{advanced.open=true})
  const hdriFold=document.querySelector<HTMLDetailsElement>('[data-testid="environment-hdri"]')!
  expect(hdriFold.open).toBe(false)
  await act(async()=>{hdriFold.open=true})
  expect(input('曝光倍率（1 = 0 EV） (0–8)').value).toBe('1')
  const mapping=document.querySelector<HTMLSelectElement>('select[aria-label="色调映射"]')!
  await act(async()=>{mapping.value='agx';mapping.dispatchEvent(new dom.window.Event('change',{bubbles:true}))});expect(patches.at(-1)).toEqual({toneMapping:'agx'})
  await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='AgX 中性起点')!.click());expect(patches.at(-1)).toEqual({toneMapping:'agx',exposure:1,environmentIntensity:1,hemisphereIntensity:0,sun:{intensity:0}})
  await setValue(input('环境方向 Z（度） (0–360)'),'75');expect(patches.at(-1)).toEqual({environmentRotationDeg:[0,0,75]})
  await act(async()=>root.render(createElement(SceneLightPanel,{light:{kind:'area',energy:500,widthM:2,heightM:1,color:[1,1,1]},disabled:false,tr,apply:(value:any)=>patches.push(value)})))
  await setValue(input('面光高度（米）'),'3');expect(patches.at(-1)).toMatchObject({kind:'area',energy:500,widthM:2,heightM:3,color:[1,1,1]})
  const en=(_zh:string,english:string)=>english
  const materialWarnings=parseMaterialOverride({kind:'visual/material-override',baseColor:'red',roughness:4,opacity:'',textures:'no'}).warnings
  const parsedEnv=parseEnvironmentComponent({kind:'scene/environment',toneMapping:'unsupported',environmentRotationDeg:[1,NaN,450],shadow:{mapSize:999,bias:-2,normalBias:'bad'}})
  if('error' in parsedEnv)throw Error(parsedEnv.error)
  const areaWarning='AREA_SHAPE_RECTANGULAR: disk uses a rectangular emitter in the viewer; area lights do not cast shadows'
  const runtimeWarnings=['MATERIAL_PBR_UNSUPPORTED: The entity has no overridable PBR mesh materials; values were not applied','MATERIAL_NORMAL_MAP_MISSING: Source materials have no normal map; normal strength was not applied',areaWarning]
  for(const warning of [...materialWarnings,...parsedEnv.warnings,...runtimeWarnings]){
   expect(renderControlDiagnostic(warning,en)).not.toMatch(/\p{Script=Han}/u)
   expect(renderControlDiagnostic(warning,tr)).toMatch(/\p{Script=Han}/u)
   expect(renderControlDiagnostic(warning,en).split(':')[0]).toBe(warning.split(':')[0])
  }
  expect(renderControlDiagnostic('Oak | UV: '+areaWarning,tr).startsWith('Oak | UV: AREA_SHAPE_RECTANGULAR:')).toBe(true)
  const legacy='ENVIRONMENT_FIELD_DEFAULTED: sun 不是对象，用默认值'
  expect(renderControlDiagnostic(legacy,en)).toBe(legacy)
  const materialStatus={entityId:'selected',loaded:true,declared:true,warnings:materialWarnings,...owner.readings([group])}
  await act(async()=>root.render(createElement(MaterialPanel,{status:materialStatus,busy:false,readOnly:false,tr:en,apply:()=>{},reset:()=>{}})))
  expect(document.getElementById('controls')!.textContent).not.toMatch(/\p{Script=Han}/u)
  expect(document.getElementById('controls')!.textContent).toContain('roughness clamped to [0, 1]')
  await act(async()=>root.render(createElement(MaterialPanel,{status:materialStatus,busy:false,readOnly:false,tr,apply:()=>{},reset:()=>{}})))
  expect(document.getElementById('controls')!.textContent).toContain('roughness 已收敛到 [0, 1]')
  const envProps={status:{...status,warnings:parsedEnv.warnings},hdris:[],hdriBusy:false,readOnly:false,viewerVisible:true,busy:false,color:'#121a24',apply:()=>{},remove:()=>{},setPlaying:()=>{},setColor:()=>{},importHdri:()=>{},refresh:()=>{}}
  await act(async()=>root.render(createElement(EnvironmentPanel,{...envProps,tr:en})))
  expect(document.getElementById('controls')!.textContent).not.toMatch(/\p{Script=Han}/u)
  expect(input('Exposure multiplier (1 = 0 EV) (0–8)').value).toBe('1')
  await act(async()=>root.render(createElement(EnvironmentPanel,{...envProps,tr})))
  expect(document.getElementById('controls')!.textContent).toContain('toneMapping 不受支持')

 }finally{await act(async()=>root.unmount());owner.reset();dom.window.close();for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key]}}
})

// 真实SDK jsdom + 原素材库/放置条，继续使用已发布放置基准开关，不是原生窗口点击验收。
test('原生USD素材库真实DOM按源原点进入scene_mount，明确选择底面对齐与取消仍走原放置条',async()=>{
 const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=sdkRequire('jsdom')
 const dom=new JSDOM('<div id="native-placement"></div>',{url:'http://fixture.invalid'}),previous=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})}
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{Simulate}=await import('react-dom/test-utils'),root=createRoot(document.getElementById('native-placement')!)
 const asset:AssetRecord={name:'Water',folder:'',tags:[],ref:{resourceId:'water',version:1,original:{uri:'file:///water.usda',mimeType:'model/vnd.usd'}},parsed:{kind:'source'}}
 const commands:unknown[]=[],noop=()=>{}
 function Harness(){
  const [placement,setPlacement]=React.useState<AssetPlacement>()
  return React.createElement(React.Fragment,null,React.createElement(AssetLibraryPanel,{assets:[asset],builtin:[],builtinBusy:false,query:'',loading:false,includeDeleted:false,canMount:true,available:true,tr:(_zh:string,en:string)=>en,setQuery:noop,setIncludeDeleted:noop,search:noop,refresh:noop,mount:value=>setPlacement(assetPlacementOf(value)),verify:noop,rename:noop,toggleDeleted:noop,importFile:noop,importBuiltin:noop,browseEnvironment:noop}),placement&&React.createElement(AssetPlacementBar,{asset:placement,point:[1,2,3],tr:(_zh:string,en:string)=>en,alignment:value=>setPlacement({...placement,alignBottomToSurface:value}),confirm:()=>commands.push(assetPlacementInput('scene',placement,[1,2,3])),cancel:()=>setPlacement(undefined)}))
 }
 try{
  await React.act(async()=>root.render(React.createElement(Harness)))
  const button=()=>document.querySelector('.lya-asset-use') as HTMLButtonElement
  expect(button().disabled).toBe(false)
  await React.act(async()=>Simulate.click(button()))
  const basis=()=>document.querySelector('select[aria-label="Placement basis"]') as HTMLSelectElement
  expect(basis().value).toBe('origin');expect(document.body.textContent).toContain('Native USD defaults to its source origin')
  // 设计稿 placement：主按钮文案是 Place object（不是 Place）。
 const confirm=()=>[...document.querySelectorAll('button')].find(row=>row.textContent==='Place object')!
  await React.act(async()=>Simulate.click(confirm()))
  expect(commands[0]).toEqual({sceneId:'scene',resourceId:'water',version:1,alignBottomToSurface:false,transform:{position:[1,2,3],quaternion:[0,0,0,1],scale:[1,1,1]}})
  await React.act(async()=>Simulate.change(basis(),{target:{value:'bottom'}} as any))
  await React.act(async()=>Simulate.click(confirm()));expect(commands[1]).toMatchObject({alignBottomToSurface:true})
  await React.act(async()=>Simulate.click([...document.querySelectorAll('button')].find(row=>row.textContent==='Cancel')!))
  expect(document.querySelector('.lya-placement-bar')).toBeNull()
  expect(assetPlacementOf({...asset,parsed:{kind:'mesh'}}).alignBottomToSurface).toBe(false)
  expect(assetPlacementOf({...asset,ref:{...asset.ref,original:{uri:'file:///box.glb',mimeType:'model/gltf-binary'}},parsed:{kind:'mesh'}}).alignBottomToSurface).toBe(true)
  expect(assetPlacementOf({...asset,ref:{...asset.ref,original:{uri:'file:///arm.xml',mimeType:'application/x-mjcf+xml'}},parsed:{kind:'robot'}}).alignBottomToSurface).toBe(false)
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
 }
})

test("放置预览 A 慢/B 快：旧回调只清自己的 token，B 的 ghost 不被清掉", async () => {
  const mod = await import("../src/workbench.tsx")
  const calls: string[] = []
  let token = "B"
  const instance = {
    placementPreviewStatus: () => ({ active: true, token }),
    clearPlacementPreview: () => { calls.push(token) },
  }
  // A 返回 SUPERSEDED 时当前 ghost 是 B：旧 token 不得清 B，也不递增 generation。
  expect(mod.clearPlacementPreviewIfOwned(instance, "A")).toBe(false)
  expect(calls).toEqual([])
  expect(instance.placementPreviewStatus().token).toBe("B")
  // 当前 ghost 就是自己的 token 时才清；这是取消/失败路径的合法清理。
  expect(mod.clearPlacementPreviewIfOwned(instance, "B")).toBe(true)
  expect(calls).toEqual(["B"])
  const source = readFileSync(new URL("../src/workbench.tsx", import.meta.url), "utf8")
  // 产品 requestPlacementPreview 的迟到分支必须走同一所有权判据，不能再无条件 clear。
  const request = source.slice(source.indexOf("async function requestPlacementPreview"), source.indexOf("placePointRef.current=point=>"))
  expect(request).toContain("clearPlacementPreviewIfOwned(instance,token)")
  expect(request).not.toContain("instance.clearPlacementPreview();return")
})

test("放置确认单飞：双击 Place 只提交一次 scene_mount，确认中禁用；取消零写由原放置条用例保留", async () => {
  const {createRequire} = await import('node:module')
  const req = createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json', import.meta.url))
  const {JSDOM} = req('jsdom') as {JSDOM: new (html: string, options?: {url?: string; pretendToBeVisual?: boolean}) => {window: Window & typeof globalThis}}
  const dom = new JSDOM('<div id="root"></div>', {url: 'http://fixture.invalid', pretendToBeVisual: true})
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window','document','HTMLElement','HTMLCanvasElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT'] as const) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const raw = (dom.window as unknown as Record<string, unknown>)[key]
    const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : typeof raw === 'function' && key.includes('AnimationFrame') ? (raw as (...args: unknown[]) => unknown).bind(dom.window) : raw
    Object.defineProperty(globalThis, key, {configurable: true, value})
  }
  saved.set('ResizeObserver', Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'))
  Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: class {observe() {} disconnect() {}}})
  ;(dom.window as any).HTMLElement.prototype.attachEvent = () => {}
  ;(dom.window as any).HTMLElement.prototype.detachEvent = () => {}
  ;(dom.window as any).HTMLCanvasElement.prototype.getContext = () => null
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const scene = {sceneId: 'place-scene', revision: 1, coordinates: {units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw'}, entities: []}
  const mountedSnapshot = {...scene, revision: 2, entities: [{entityId: 'mounted-box', name: 'Box', transform: {position: [1,2,3], quaternion: [0,0,0,1], scale: [1,1,1]}, resources: [], components: {}}]}
  const box = {ref: {resourceId: 'res-box', version: 1, original: {uri: 'res:box', mimeType: 'model/gltf-binary'}}, name: 'Box', tags: [], folder: '', parsed: {kind: 'mesh'}, sizeBytes: 32}
  let mountCalls = 0, releaseMount!: () => void
  const mountGate = new Promise<void>(resolve => {releaseMount = resolve})
  let previewCalls = 0, releasePreviewA!: () => void
  const previewGateA = new Promise<void>(resolve => {releasePreviewA = resolve})
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/lyapunov/command')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.name === 'asset_placement_preview') {
        previewCalls += 1
        if (previewCalls === 1) await previewGateA
        const position = body.input?.transform?.position ?? [1,2,3]
        return Response.json({kind: 'success', ui: {status: 'PREVIEW', sceneId: scene.sceneId, resourceId: 'res-box', version: 1, transform: {position, quaternion: [0,0,0,1], scale: [1,1,1]}, entities: [{entityId: 'box-ghost', name: 'Box', transform: {position, quaternion: [0,0,0,1], scale: [1,1,1]}, resources: [], components: {visual: {kind: 'mesh'}}}]}})
      }
      if (body.name === 'scene_mount') { mountCalls += 1; await mountGate; return Response.json({kind: 'success', ui: {snapshot: mountedSnapshot, entityId: 'mounted-box'}}) }
      return Response.json({kind: 'success', ui: {}})
    }
    const data = url.includes('/state?') ? {hostInstanceId: 'host-place', scene, worlds: [], providerAvailable: false}
      : url.includes('/scenes') ? [{sceneId: scene.sceneId}]
      : url.includes('/engine-preference') ? {engine: 'mujoco'}
      : url.includes('/selection') ? {updated: true}
      : url.includes('builtin-assets') ? {resources: []}
      : url.includes('/assets') || url.includes('missing-assets') ? [box]
      : []
    return Response.json(data)
  }) as typeof fetch
  let instance: any, activePreviewToken = ''
  const previewClears: string[] = []
  viewerFactory = (options: any) => {
    const view = {position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: 'orbit'}
    const observer = {mode: 'free', navigation: 'orbit', dirty: false, saving: false, scope: {}}
    const target: any = {
      options, renderer: {domElement: document.createElement('canvas')}, getViewState: () => view, setScene: () => Promise.resolve(), subscribeObserverState: () => () => {}, observerState: () => observer,
      environmentStatus: () => ({hdriMimeTypes: [], warnings: [], ignored: []}), collisionStatus: () => ({status: 'disabled'}), animationStatus: () => ({playing: false, clips: []}), dispose: () => {},
      previewPlacement: async (spec: any) => { activePreviewToken = spec.token; return {status: 'PREVIEW', token: spec.token} },
      placementPreviewStatus: () => ({active: Boolean(activePreviewToken), ...(activePreviewToken ? {token: activePreviewToken} : {})}),
      clearPlacementPreview: () => { previewClears.push(activePreviewToken); activePreviewToken = '' },
      framePlacementPreview: () => ({ok: true}),
    }
    instance = new Proxy(target, {get(t, key) { if (key in t) return (t as any)[key]; return () => {} }})
    return instance
  }
  const {createElement, act, Fragment} = await import('react')
  const {createRoot} = await import('react-dom/client')
  const {Workbench} = await import('../src/workbench.tsx')
  const {ToolRail} = await import('../src/tool-rail.tsx')
  const root = createRoot(document.getElementById('root')!)
  const flush = (ms = 320) => act(async () => { await new Promise(done => setTimeout(done, ms)) })
  try {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Workbench, {sessionId: 'place-flow', nativeTab: true, t: (key: string) => key === 'open' ? 'Scene workbench' : '场景工作台', renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
      createElement(ToolRail, {tr: (_zh: string, en: string) => en, engine: 'mujoco'}),
    )))
    await flush(); await flush()
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.includes(label))
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.lya-rail-item')].find(row => row.getAttribute('aria-label') === 'Objects')!.click())
    await flush()
    await act(async () => (document.querySelector('[data-testid="object-add-primary"]') as HTMLButtonElement).click())
    await flush()
    await act(async () => button('Select')!.click())
    await flush()
    await act(async () => (document.querySelector('[data-testid="object-add-place"]') as HTMLButtonElement).click())
    await flush()
    // 没有落点时不能确认；先经真实 onPlacePoint 触发只读预览。
    expect(document.querySelector('[data-testid="asset-placement-confirm"]')).toBeNull()
    // A 慢/B 快：A 的服务器预览仍在途时 B 先显示；A 迟到返回后旧 token 不得清掉 B。
    await act(async () => { instance.options.onPlacePoint([0,0,0]); await Promise.resolve() })
    expect(previewCalls).toBe(1)
    await act(async () => { instance.options.onPlacePoint([1,2,3]); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(previewCalls).toBe(2)
    expect(activePreviewToken).not.toBe('')
    const tokenB = activePreviewToken
    await act(async () => { releasePreviewA(); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(activePreviewToken).toBe(tokenB)
    expect(previewClears).not.toContain(tokenB)
    const confirm = () => document.querySelector('[data-testid="asset-placement-confirm"]') as HTMLButtonElement
    expect(confirm()).not.toBeNull()
    expect(confirm().disabled).toBe(false)
    await act(async () => { confirm().click(); confirm().click(); await Promise.resolve() })
    expect(mountCalls).toBe(1)
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toContain('Placing')
    // 取消只在确认前合法；这里确认已单飞，释放后只落一次 scene_mount。
    await act(async () => { releaseMount(); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(mountCalls).toBe(1)
    expect(document.querySelector('[data-testid="asset-placement-bar"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    viewerFactory = () => ({})
    dom.window.close()
    if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch); else Reflect.deleteProperty(globalThis, 'fetch')
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
})
