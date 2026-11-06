/** 拍摄工作面使用真实 Workbench/工具栏，验证固定机位清单从当前世界读取。 */
import {test,expect,mock} from 'bun:test'
import {createRequire} from 'node:module'
import {projectSceneCameraRigs} from '../../viewer/src/scene-camera-rigs.ts'
let viewerFactory:(...args:unknown[])=>any=()=>({})
mock.module('@lyapunov/viewer/client',()=>({createViewer:(...args:unknown[])=>viewerFactory(...args),projectSceneCameraRigs,WebGLUnavailableError:class extends Error{}}))

test('打开拍摄面板会从当前世界读取相机清单',async()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-0.2.0-rc.2/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof (dom.window as any)[key]==='function'&&key.includes('AnimationFrame')?(dom.window as any)[key].bind(dom.window):(dom.window as any)[key];Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 saved.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){} disconnect(){}}})
 saved.set('fetch',Object.getOwnPropertyDescriptor(globalThis,'fetch'))
 const scene={sceneId:'camera-scene',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]}
 const world={worldId:'camera-world',sceneId:scene.sceneId,engineId:'newton',engineVersion:'1.6.0',worldGeneration:1,appliedSceneRevision:1,status:'running',clock:'realtime',timestepS:.002}
 const frame={worldId:world.worldId,generation:1,sceneRevision:1,frameId:'camera-world:1:1',stepIndex:1,simTime:.002,worldStatus:'running',entities:[]}
 let cameraReads=0
 globalThis.fetch=(async(input:any)=>{const url=String(input)
  if(url.includes('/state?'))return Response.json({hostInstanceId:'fixture-host',scene,worlds:[world],providerAvailable:true})
  if(url.includes('/frame?'))return Response.json(frame)
  if(url.includes('/camera-list?')){cameraReads++;return Response.json({sceneId:scene.sceneId,sceneRevision:1,worldId:world.worldId,generation:1,cameras:[],bodies:[]})}
  if(url.includes('/scenes'))return Response.json([{sceneId:scene.sceneId}])
  if(url.includes('/engine-preference'))return Response.json({engine:'newton'})
  if(url.includes('/scene-history'))return Response.json([])
  if(url.includes('/selection'))return Response.json({updated:true})
  if(url.includes('builtin-assets'))return Response.json({resources:[]})
  return Response.json([])
 }) as typeof fetch
 const observer={mode:'free',navigation:'orbit',dirty:false,saving:false,scope:{}}
 viewerFactory=()=>new Proxy({renderer:{domElement:document.createElement('canvas')},getViewState:()=>({position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:'orbit'}),setScene:()=>Promise.resolve(),subscribeObserverState:()=>()=>{},observerState:()=>observer,environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[]}),collisionStatus:()=>({status:'disabled'}),animationStatus:()=>({playing:false,clips:[]}),dispose:()=>{}},{get:(target,key)=>key in target?(target as any)[key]:()=>{}})
 const {createElement,act,Fragment}=await import('react'),{createRoot}=await import('react-dom/client'),{Workbench}=await import('../src/workbench.tsx'),{ToolRail}=await import('../src/tool-rail.tsx')
 const root=createRoot(document.getElementById('root')!),flush=()=>act(async()=>{await new Promise(done=>setTimeout(done,600))})
 try{
  await act(async()=>root.render(createElement(Fragment,null,createElement(Workbench,{sessionId:'camera-fixture',nativeTab:true,t:()=> '场景工作台',renderSlot:(_n:any,_p:any,options:any)=>options?.fallback??null} as any),createElement(ToolRail,{tr:(_zh:string,en:string)=>en,engine:'newton'}))))
  await flush();await flush()
  const capture=[...document.querySelectorAll<HTMLButtonElement>('.lya-rail-item')].find(button=>button.getAttribute('aria-label')==='Capture')
  expect(capture).toBeTruthy();await act(async()=>capture!.click());await flush();await flush()
  expect(cameraReads).toBeGreaterThan(0)
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete (globalThis as any)[key]}
},20_000)
