/**
 * P7A2：比较区的身份判据与缺件诚实性（`lidar-scan-panel.tsx`）。
 *
 * 这里只量判据函数与 SSR 结构，不冒充浏览器：同帧只在 frame/step/world 三者真实相同时成立；
 * 换机位/换 world 后旧钉住采集作废；缺 RGB-D 或 LiDAR 时不画任何图/画布。真机像素验收见回执未验项。
 */
import {describe,expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {renderToStaticMarkup} from 'react-dom/server'
import {compareFrameIdentity,compareSources,comparisonCaptureOf,visibleLidarResult,visibleNpyState,cameraCaptureRef,LidarScanPanel,type CameraCaptureRef} from '../src/lidar-scan-panel.tsx'
import type {CameraWorldIdentity} from '../src/capture-panel.tsx'

const identity:CameraWorldIdentity={sceneId:'s',sceneRevision:3,worldId:'w',worldGeneration:2}
const tr=(zh:string,_en:string)=>zh
const camera:any={captureId:'cap-1',cameraName:'arm/cam',frameId:'w:2:7',stepIndex:7,simTime:0.35,worldGeneration:2,sceneRevision:3}

describe('P7A2 同帧判定：只有 frame/step/world 真相同才算同帧',()=>{
 test('三字段全等才判同帧',()=>{
  expect(compareFrameIdentity(camera,{...camera})).toEqual({status:'same-frame',frameId:'w:2:7',stepIndex:7,worldGeneration:2})
 })
 test('step 不同：明确非同帧并给出 Δstep',()=>{
  const verdict=compareFrameIdentity(camera,{...camera,captureId:'cap-2',stepIndex:9,simTime:0.45})
  expect(verdict.status).toBe('different-frame')
  if(verdict.status!=='different-frame')throw new Error('应为非同帧')
  expect(verdict.reason).toBe('step');expect(verdict.stepDelta).toBe(7-9);expect(verdict.timeDeltaS).toBeCloseTo(-0.1,10)
 })
 test('frame 不同或代次不同：各自点名原因，不用相近 step 冒充',()=>{
  const frame=compareFrameIdentity(camera,{...camera,frameId:'w:2:8'})
  expect(frame.status==='different-frame'&&frame.reason).toBe('frame')
  const world=compareFrameIdentity(camera,{...camera,worldGeneration:3})
  expect(world.status==='different-frame'&&world.reason).toBe('world')
 })
 test('缺 frame/step/来源：判身份不完整，不判同帧',()=>{
  expect(compareFrameIdentity(camera,{...camera,frameId:undefined}).status).toBe('incomplete')
  expect(compareFrameIdentity(camera,{...camera,stepIndex:undefined}).status).toBe('incomplete')
  expect(compareFrameIdentity(undefined,{...camera}).status).toBe('incomplete')
 })
})

describe('P7A2 来源可得性与钉住归属',()=>{
 test('缺 RGB-D 或缺 LiDAR 时对应通道标记缺件，不冒充有图',()=>{
  expect(compareSources(undefined,undefined)).toEqual({cameraReady:false,lidarReady:false,rgb:false,cameraDepth:false,lidarRange:false})
  expect(compareSources({captureId:'c',cameraName:'arm/cam'},undefined)).toMatchObject({cameraReady:true,cameraDepth:true,lidarReady:false})
  expect(compareSources(undefined,{captureId:'l',range:{uri:'res://x'}})).toMatchObject({cameraReady:false,lidarReady:true,lidarRange:true})
 })
 test('钉住的采集优先；换机位/换 world 后旧钉子作废退回直播',()=>{
  const live:CameraCaptureRef={captureId:'live',cameraName:'arm/cam'}
  const pinned={key:'k1',capture:{captureId:'pinned',cameraName:'arm/cam'} as CameraCaptureRef}
  expect(comparisonCaptureOf(pinned,'k1',live)).toEqual({capture:pinned.capture,pinned:true})
  expect(comparisonCaptureOf(pinned,'k2',live)).toEqual({capture:live,pinned:false})
  expect(comparisonCaptureOf(pinned,'k1',undefined)).toEqual({capture:pinned.capture,pinned:true})
 })
 test('换机位后 NPY 旧成功与旧失败都不显示（按 scope key 归属）',()=>{
  const ready={key:'cam-A',status:'ready'as const}
  const failed={key:'cam-A',status:'error'as const,message:'old failure'}
  expect(visibleNpyState(ready,'cam-A')).toBe(ready)
  expect(visibleNpyState(ready,'cam-B')).toBeUndefined()
  expect(visibleNpyState(failed,'cam-B')).toBeUndefined()
  expect(visibleNpyState(undefined,'cam-B')).toBeUndefined()
 })
 test('cameraCaptureRef 只从同一次真实采集投影身份；缺 captureId/相机名返回 undefined',()=>{
  const ref=cameraCaptureRef({captureId:'c1',frameId:'w:2:7',stepIndex:7,simTime:0.35,worldGeneration:2,sceneRevision:3},{cameraName:'arm/cam',resolvedCameraName:'entity/arm/cam',depthRangeM:[1,9]})
  expect(ref).toEqual({captureId:'c1',cameraName:'arm/cam',resolvedCameraName:'entity/arm/cam',frameId:'w:2:7',stepIndex:7,simTime:0.35,worldGeneration:2,sceneRevision:3,depthRangeM:[1,9]})
  expect(cameraCaptureRef({}, {cameraName:'arm/cam'})).toBeUndefined()
  expect(cameraCaptureRef({captureId:'c'}, {})).toBeUndefined()
 })
})

describe('P7A2 缺件诚实性（SSR 结构）',()=>{
 const api:any={clientId:'test',mediaURL:(path:string,_query:Record<string,string|undefined>)=>`/api/lyapunov/${path}`,request:async()=>({})}
 test('缺 RGB-D 且无 LiDAR：不渲染任何图或画布，只留入口',()=>{
  const markup=renderToStaticMarkup(createElement(LidarScanPanel,{api,identity,ready:false,tr,perform:()=>{}}))
  expect(markup).toContain('RGB / 相机Depth / LiDAR 比较')
  expect(markup).not.toContain('<canvas')
  expect(markup).not.toContain('<img')
 })
 test('有真实相机采集但无 LiDAR：RGB 出真实 img，Depth/LiDAR 明确缺件，无假热图',()=>{
  const markup=renderToStaticMarkup(createElement(LidarScanPanel,{api,identity,ready:true,cameraName:'arm/cam',cameraCapture:{captureId:'cap-1',cameraName:'arm/cam',frameId:'w:2:7',stepIndex:7,worldGeneration:2} as CameraCaptureRef,tr,perform:()=>{}}))
  expect(markup).toContain('<img')
  expect(markup).toContain('/api/lyapunov/capture')
  expect(markup).not.toContain('data:image')
  expect(markup).toContain('缺件：尚无该来源的原生产物')
 })
 test('非当前 world 的旧 LiDAR 回执不得显示（判据仍由 visibleLidarResult 把守）',()=>{
  expect(visibleLidarResult({sceneId:'s',sceneRevision:3,worldId:'w',worldGeneration:1,cameraName:'arm/cam',range:{uri:'res://x'}},identity,'arm/cam')).toBeUndefined()
 })
})

/** 真实 React/DOM：V8-21 的浮层打开/关闭、三量标签与 Refresh 行为（不触网、不触引擎）。 */
function withDom(run:(root:Root,flush:(ms?:number)=>Promise<void>)=>Promise<void>){
 return async()=>{
  const {JSDOM}=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))('jsdom') as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:Window&typeof globalThis}}
  const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ['window','document','HTMLElement','HTMLCanvasElement','HTMLInputElement','HTMLSelectElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
   saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
   const raw=(dom.window as unknown as Record<string,unknown>)[key]
   const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof raw==='function'&&key.includes('AnimationFrame')?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
   Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  saved.set('ResizeObserver',Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'))
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){} disconnect(){}}})
  saved.set('fetch',Object.getOwnPropertyDescriptor(globalThis,'fetch'))
  globalThis.fetch=(async()=>new Response('missing',{status:404})) as unknown as typeof fetch
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.attachEvent=()=>{}
  ;(dom.window as unknown as {HTMLElement:{prototype:Record<string,unknown>}}).HTMLElement.prototype.detachEvent=()=>{}
  const root=createRoot(document.getElementById('root')!)
  const flush=async(ms=0)=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms))})}
  try{await run(root,flush)}
  finally{
   await act(async()=>root.unmount())
   dom.window.close()
   for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
  }
 }
}

describe('V8-21 画布内三通道短对照',()=>{
 test('打开/关闭浮层，三列量与标签准确；Refresh 只重采同一机位，不触发 LiDAR/Scene 写',withDom(async(root,flush)=>{
  const requests:unknown[]=[]
  const api:any={clientId:'test',mediaURL:(path:string,query:Record<string,string|undefined>={})=>{
   const search=new URLSearchParams()
   for(const [key,value] of Object.entries(query))if(value!==undefined)search.set(key,value)
   return `/api/lyapunov/${path}?${search.toString()}`
  },request:async(...args:unknown[])=>{requests.push(args);return {}}}
  const host=document.createElement('div')
  document.body.appendChild(host)
  const hostRef={current:host}
  let captures=0
  const capture:CameraCaptureRef={captureId:'cap-1',cameraName:'arm/cam',resolvedCameraName:'arm/wrist/cam',frameId:'w:2:7',stepIndex:7,simTime:0.35,worldGeneration:2,sceneRevision:3,depthAvailable:true}
  const en=(_zh:string,text:string)=>text
  await act(async()=>root.render(createElement(LidarScanPanel,{api,identity,ready:true,cameraName:'arm/cam',cameraLabel:'Wrist camera',cameraCapture:capture,captureCamera:async()=>{captures+=1;return {...capture,captureId:'cap-2'}},tr:en,perform:(fn:()=>Promise<unknown>)=>{void fn()},compareOverlayHost:hostRef} as never)))
  await flush()
  expect(host.querySelector('[data-testid="camera-compare-dialog"]')).toBeNull()
  await act(async()=> (document.querySelector('[data-testid="camera-compare-open"]') as HTMLButtonElement).click())
  await flush()
  const dialog=host.querySelector('[data-testid="camera-compare-dialog"]') as HTMLElement
  expect(dialog).not.toBeNull()
  expect(dialog.hasAttribute('hidden')).toBe(false)
  expect(dialog.textContent).toContain('Wrist camera')
  const rgb=dialog.querySelector('[data-testid="compare-rgb"]')!
  const depth=dialog.querySelector('[data-testid="compare-camera-depth"]')!
  const lidar=dialog.querySelector('[data-testid="compare-lidar-range"]')!
  expect(rgb.getAttribute('data-channel')).toBe('rgb')
  expect(depth.getAttribute('data-channel')).toBe('camera-depth')
  expect(lidar.getAttribute('data-channel')).toBe('lidar-range')
  expect(rgb.textContent).toContain('RGB')
  expect(depth.textContent).toContain('Camera Z-depth (m)')
  expect(depth.textContent).toContain('axial Z')
  expect(lidar.textContent).toContain('LiDAR ray range (m)')
  expect(lidar.textContent).toContain('Euclidean along ray')
  expect(dialog.querySelector('[data-testid="compare-settings"]')!.hasAttribute('open')).toBe(false)
  expect(dialog.querySelector('[data-testid="frame-verdict"]')!.textContent).toContain('Identity incomplete')
  expect(requests).toEqual([])
  await act(async()=> (dialog.querySelector('[data-testid="compare-refresh"]') as HTMLButtonElement).click())
  await flush()
  expect(captures).toBe(1)
  expect(requests).toEqual([])
  await act(async()=> (dialog.querySelector('[data-testid="camera-compare-close"]') as HTMLButtonElement).click())
  await flush()
  expect(host.querySelector('[data-testid="camera-compare-dialog"]')).toBeNull()
 }))
 test('不支持深度通道时诚实标 Unavailable，不拿 RGB 充深度',withDom(async(root,flush)=>{
  const api:any={clientId:'test',mediaURL:(path:string,_query:Record<string,string|undefined>)=>`/api/lyapunov/${path}`,request:async()=>({})}
  const host=document.createElement('div')
  document.body.appendChild(host)
  const en=(_zh:string,text:string)=>text
  await act(async()=>root.render(createElement(LidarScanPanel,{api,identity,ready:true,cameraName:'arm/cam',cameraCapture:{captureId:'cap-1',cameraName:'arm/cam',depthAvailable:false} as CameraCaptureRef,tr:en,perform:()=>{},compareOverlayHost:{current:host}} as never)))
  await flush()
  await act(async()=> (document.querySelector('[data-testid="camera-compare-open"]') as HTMLButtonElement).click())
  await flush()
  const depth=host.querySelector('[data-testid="compare-camera-depth"]') as HTMLElement
  expect(depth.getAttribute('data-available')).toBe('false')
  expect(depth.textContent).toContain('this capture has no depth channel')
  expect(depth.querySelector('canvas')).toBeNull()
 }))

 test('V11-P21：overlay host 在首帧后才由兄弟节点挂载时，Compare 仍要打开（render 里读 ref.current 会永久拿到 null）',withDom(async(root,flush)=>{
  const host=document.createElement('div')
  document.body.appendChild(host)
  const hostRef={current:null as HTMLElement|null}
  const en=(_zh:string,text:string)=>text
  const api:any={clientId:'test',mediaURL:(path:string)=>`/api/lyapunov/${path}`,request:async()=>({})}
  function Wrapper(){return createElement('div',null,createElement('div',{ref:(el:HTMLElement|null)=>{if(el)hostRef.current=el}}),createElement(LidarScanPanel,{api,identity,ready:true,cameraName:'arm/cam',tr:en,perform:()=>{},compareOverlayHost:hostRef} as never))}
  await act(async()=>root.render(createElement(Wrapper)))
  await flush()
  expect(hostRef.current).not.toBeNull()
  await act(async()=> (document.querySelector('[data-testid="camera-compare-open"]') as HTMLButtonElement).click())
  await flush()
  const dialog=hostRef.current!.querySelector('[data-testid="camera-compare-dialog"]')
  expect(dialog).not.toBeNull()
 }))
})
