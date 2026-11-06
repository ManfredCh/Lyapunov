/** 真实 Workbench DOM，后端为受控夹具：已失败 world 的旧 running Frame 不能继续冒充运行中。 */
import {test,expect,mock} from 'bun:test'
import {createRequire} from 'node:module'
import {projectSceneCameraRigs} from '../../viewer/src/scene-camera-rigs.ts'
let viewerFactory:(...args:unknown[])=>any=()=>({})
mock.module('@lyapunov/viewer/client',()=>({createViewer:(...args:unknown[])=>viewerFactory(...args),projectSceneCameraRigs,WebGLUnavailableError:class extends Error{}}))

test.each(['拒绝关闭','正常关闭','关闭回执前轮询已移除世界'] as const)('轮询读回 unavailable 后更新原生命周期：%s',async(mode)=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-0.2.0-rc.2/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','HTMLElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof (dom.window as any)[key]==='function'&&key.includes('AnimationFrame')?(dom.window as any)[key].bind(dom.window):(dom.window as any)[key];Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 saved.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'));Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){} disconnect(){}}})
 saved.set('fetch',Object.getOwnPropertyDescriptor(globalThis,'fetch'))
 const scene={sceneId:'fault-scene',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'ground',name:'ground',resources:[],transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:{collision:{shape:'plane',infinite:true,size:[0,0,.1]},rigidBody:{type:'static'}}}]}
 const running={worldId:'world-a',sceneId:scene.sceneId,engineId:'newton',engineVersion:'1.6.0',worldGeneration:1,appliedSceneRevision:1,status:'running',clock:'realtime',timestepS:.002}
 const frame={worldId:'world-a',generation:1,sceneRevision:1,frameId:'world-a:1:216',stepIndex:216,simTime:.432,worldStatus:'running',entities:[]}
 let failed=false,removed=false,frameCalls=0,closeCalls=0,finishClose:(()=>void)|undefined
 globalThis.fetch=(async(input:any,init?:RequestInit)=>{const url=String(input)
  if(url.includes('/state?'))return Response.json({hostInstanceId:'fixture-host',scene,worlds:removed?[]:[failed?{...running,status:'unavailable',statusReason:'SimError: Newton nonfinite body state'}:running],providerAvailable:true})
  if(url.includes('/frame?')){frameCalls++;return failed?Response.json({error:'WORLD_UNAVAILABLE: Newton nonfinite body state'},{status:409}):Response.json(frame)}
  if(url.includes('/scenes'))return Response.json([{sceneId:scene.sceneId}])
  if(url.includes('/engine-preference'))return Response.json({engine:'newton'})
  if(url.includes('/scene-history'))return Response.json([])
  if(url.includes('/selection'))return Response.json({updated:true})
  if(url.includes('/command')){const command=JSON.parse(String(init?.body??'{}'));if(command.name==='sim_close'){closeCalls++;await new Promise<void>(resolve=>{finishClose=resolve});if(mode==='拒绝关闭')return Response.json({kind:'error',text:'WORLD_UNAVAILABLE: fixture close rejected'});removed=true;return Response.json({kind:'success',ui:{closed:true}})}return Response.json({kind:'success',ui:{}})}
  if(url.includes('builtin-assets'))return Response.json({resources:[]})
  return Response.json([])
 }) as typeof fetch
 const observer={mode:'free',navigation:'orbit',dirty:false,saving:false,scope:{}}
 viewerFactory=()=>new Proxy({renderer:{domElement:document.createElement('canvas')},getViewState:()=>({position:[5,-6,4],quaternion:[0,0,0,1],target:[0,0,.7],up:[0,0,1],fov:50,near:.1,far:1000,zoom:1,navigation:'orbit'}),setScene:()=>Promise.resolve(),subscribeObserverState:()=>()=>{},observerState:()=>observer,environmentStatus:()=>({hdriMimeTypes:[],warnings:[],ignored:[]}),collisionStatus:()=>({status:'disabled'}),animationStatus:()=>({playing:false,clips:[]}),dispose:()=>{}},{get:(target,key)=>key in target?(target as any)[key]:()=>{}})
 const {createElement,act,Fragment}=await import('react'),{createRoot}=await import('react-dom/client'),{Workbench}=await import('../src/workbench.tsx'),{ToolRail}=await import('../src/tool-rail.tsx')
 const root=createRoot(document.getElementById('root')!)
 const flush=()=>act(async()=>{await new Promise(done=>setTimeout(done,600))})
 try{
  await act(async()=>root.render(createElement(Fragment,null,createElement(Workbench,{sessionId:'fault-fixture',nativeTab:true,t:()=> '场景工作台',renderSlot:(_n:any,_p:any,options:any)=>options?.fallback??null} as any),createElement(ToolRail,{tr:(_zh:string,en:string)=>en,engine:'newton'}))))
  await flush();await flush();expect(frameCalls).toBeGreaterThan(0);expect(document.querySelector('[data-testid="scene-world-lifecycle"]')?.getAttribute('data-world-phase')).toBe('running')
  failed=true;await flush();await flush()
  const status=document.querySelector('[data-testid="scene-world-lifecycle"]')!;expect(status.getAttribute('data-world-phase')).toBe('failed');expect(status.textContent).toContain('Newton nonfinite body state');expect(status.textContent).not.toContain('物理世界运行中')
  expect(document.querySelector('[data-testid="world-step"]')).toBeNull()
  const rail=[...document.querySelectorAll<HTMLButtonElement>('.lya-rail-item')].find(button=>button.getAttribute('aria-label')==='Physics');expect(rail).toBeTruthy();if(!document.querySelector('[data-testid="world-more-actions"]')){await act(async()=>rail!.click());await flush()}
  const summary=document.querySelector<HTMLElement>('[data-testid="world-more-actions"] summary');expect(summary).toBeTruthy();await act(async()=>summary!.click())
  const close=[...document.querySelectorAll<HTMLButtonElement>('[data-testid="world-more-actions"] button')].find(button=>/关闭物理世界|Close physics world/.test(button.textContent??''));expect(close).toBeTruthy();await act(async()=>close!.click())
  expect(closeCalls).toBe(1);expect(document.querySelector('[data-testid="scene-world-lifecycle"]')?.getAttribute('data-world-phase')).toBe('failed');expect(finishClose).toBeDefined()
  if(mode==='关闭回执前轮询已移除世界'){removed=true;await flush();await flush()}
  await act(async()=>finishClose!());await flush()
  const final=document.querySelector('[data-testid="scene-world-lifecycle"]')!
  if(mode==='拒绝关闭'){expect(final.getAttribute('data-world-phase')).toBe('failed');expect(final.textContent).not.toContain('物理世界已关闭')}
  else{expect(final.getAttribute('data-world-phase')).toBe('closed');expect(final.textContent).toContain('物理世界已关闭')}
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete (globalThis as any)[key]}
},20_000)
