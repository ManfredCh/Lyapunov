/**
 * P7B 复核修复：连续视频会话（`useContinuousCaptureSession`）的生命周期归属回归。
 *
 * 边界与主控探针 `capture-lifecycle-probe.tsx` 同一层级：真 React hook + jsdom + 受控
 * Viewer/MediaRecorder/API 替身，验证**操作实例归属**——不是视频可播放/浏览器验收。
 *  · 正常停止：Recorder 停一次、轨道释放、按开始时的原 API 保存一次并转发当前 UI。
 *  · Viewer 关闭/更换：终结真实 Recorder 与流，已有字节按真实 stopReason 保存。
 *  · 切 Scene：迟到保存仍上传原 owner，但不把旧 Scene 记录转发给新 Scene。
 *  · 切 API：上传固定用操作开始时的 API，不把旧场景视频发到新会话。
 *  · A→B→A：会话身份按对象实例判断，第一次 A 的迟到回执不冒充回到 A 的当前操作。
 *  · Stop 重复不重复保存；保存失败保留已录字节（不先标成功）；Cancel 停表不产出记录。
 */
import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {useContinuousCaptureSession} from '../src/capture-session.ts'

const tr=(_zh:string,en:string)=>en

interface Counts { stops:number; trackStops:number; recorders:any[]; ackStops:()=>void; ackLatest:()=>void }

function withDom(run:(ctx:{root:Root;counts:Counts})=>Promise<void>,options:{holdStop?:boolean;empty?:boolean}={}){
  return async()=>{
    const {JSDOM}=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))('jsdom') as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:Window&typeof globalThis}}
    const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
    const saved=new Map<string,PropertyDescriptor|undefined>()
    for(const key of ['window','document','HTMLElement','Node','navigator','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
      saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
      const raw=(dom.window as unknown as Record<string,unknown>)[key]
      const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof raw==='function'&&key.includes('AnimationFrame')?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
      Object.defineProperty(globalThis,key,{configurable:true,value})
    }
    const counts:Counts={stops:0,trackStops:0,recorders:[],ackStops:()=>{},ackLatest:()=>{}}
    counts.ackStops=()=>{for(const recorder of counts.recorders)recorder.ack?.()}
    counts.ackLatest=()=>counts.recorders.at(-1)?.ack?.()
    const previousRecorder=Object.getOwnPropertyDescriptor(globalThis,'MediaRecorder')
    class FakeRecorder{
      static isTypeSupported(){return true}
      state='inactive'; mimeType='video/webm;codecs=vp9'; ondataavailable:any; onerror:any; onstop:any
      constructor(public stream:any){counts.recorders.push(this)}
      start(){this.state='recording'}
      stop(){counts.stops++;this.state='inactive';if(!options.empty)this.ondataavailable?.({data:new Blob(['capture-lifecycle-fixture'],{type:this.mimeType})});if(!options.holdStop)queueMicrotask(()=>this.onstop?.())}
      ack(){this.onstop?.()}
    }
    Object.defineProperty(globalThis,'MediaRecorder',{configurable:true,value:FakeRecorder})
    const root=createRoot(document.getElementById('root')!)
    try{await run({root,counts})}
    finally{
      try{await act(async()=>root.unmount())}catch{/* 用例内已卸载 */}
      dom.window.close()
      if(previousRecorder)Object.defineProperty(globalThis,'MediaRecorder',previousRecorder);else Reflect.deleteProperty(globalThis,'MediaRecorder')
      for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
    }
  }
}

interface Harness {
  props:any
  session:()=>any
  render:()=>Promise<void>
  release:()=>void
  saves:any[]
  forwarded:any[]
  apiA:any
  apiB:any
  state:{instance:any;session:any}
  metrics:{routeViews:any[];routeClears:number;overview:any[];mainViews:any[]}
}

/** 真 hook 的受控挂载：props 就地改动后 `render()` 提交，hook 读到当刻值。 */
function makeHarness(root:Root,counts:Counts,options:{hold?:boolean;fail?:boolean;onError?:(message:string)=>void}={}):Harness{
  const original={position:[0,0,3],quaternion:[0,0,0,1],target:[0,0,0],up:[0,0,1],fovDeg:50}
  const metrics:{routeViews:any[];routeClears:number;overview:any[];mainViews:any[]}={routeViews:[],routeClears:0,overview:[],mainViews:[]}
  let routeView:any
  const instance:any={getViewState:()=>structuredClone(original),setViewState:(state:any)=>{metrics.mainViews.push(structuredClone(state))},captureCanvasStream:()=>({width:160,height:120,stream:{getTracks:()=>[{stop:()=>{counts.trackStops++}}]}})}
  instance.setRouteCaptureView=(view?:any)=>{routeView=view?structuredClone(view):undefined;metrics.routeViews.push(routeView?structuredClone(routeView):undefined)}
  instance.clearRouteCaptureView=()=>{routeView=undefined;metrics.routeClears++}
  instance.routeCaptureState=()=>routeView?structuredClone(routeView):undefined
  instance.frameCaptureRoute=(stations:any[])=>{metrics.overview.push(structuredClone(stations));return {ok:true,stations:stations.length,available:stations.length}}
  const state:{instance:any;session:any}={instance,session:undefined}
  const saves:any[]=[],forwarded:any[]=[]
  let releaseSave:(()=>void)|undefined
  const makeAPI=(owner:string)=>({saveVideo:(input:any)=>{
    saves.push({owner,blobSize:input.blob.size,...input.metadata})
    const result={...input.metadata,videoId:'v-'+owner,bytes:input.blob.size,container:'webm',codec:'vp9'}
    if(options.fail)return Promise.reject(new Error('SESSION_WRITE_DENIED'))
    if(options.hold)return new Promise<any>(resolve=>{releaseSave=()=>resolve(result)})
    return Promise.resolve(result)
  }})
  const apiA=makeAPI('api-a'),apiB=makeAPI('api-b')
  const props:any={api:apiA,viewer:()=>state.instance,viewerVisible:true,sceneId:'s',sceneRevision:1,tr,onSaved:(record:any)=>forwarded.push({activeScene:props.sceneId,recordScene:record.sceneId}),onError:options.onError??(()=>{})}
  function Harness(){state.session=useContinuousCaptureSession(props);return createElement('div',null,state.session.phase)}
  return {props,apiA,apiB,saves,forwarded,metrics,release:()=>releaseSave?.(),session:()=>state.session,render:async()=>{await act(async()=>{root.render(createElement(Harness))})},state}
}

const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,25))}

test('正常停止：Recorder 停一次、轨道释放、按原 API 保存一次并转发当前 UI',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts)
  await h.render()
  await act(async()=>h.session().startFree())
  await act(async()=>{h.session().stop();await settle()})
  expect(h.session().phase).toBe('idle')
  expect(counts.stops).toBe(1)
  expect(counts.trackStops).toBeGreaterThan(0)
  expect(h.saves).toHaveLength(1)
  expect(h.saves[0]).toMatchObject({owner:'api-a',sceneId:'s',stopReason:'user-stop'})
  expect(h.forwarded).toHaveLength(1)
}))

test('重复 Stop 不重复保存；Cancel 停表且不产出记录',withDom(async({root,counts})=>{
  const first=makeHarness(root,counts)
  await first.render()
  await act(async()=>first.session().startFree())
  await act(async()=>{first.session().stop();first.session().stop();await settle()})
  expect(first.saves).toHaveLength(1)
}))

test('Viewer 关闭：终结 Recorder 与流，按 renderer-closed 保存已有字节',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts)
  await h.render()
  await act(async()=>h.session().startFree())
  h.props.viewerVisible=false
  h.state.instance=undefined
  await act(async()=>{await h.render();await settle()})
  expect(h.session().phase).toBe('idle')
  expect(counts.trackStops).toBeGreaterThan(0)
  expect(h.saves).toHaveLength(1)
  expect(h.saves[0]).toMatchObject({owner:'api-a',sceneId:'s',stopReason:'renderer-closed'})
}))

test('切 Scene 迟到保存：上传原 owner，但不把旧 Scene 记录转发给新 Scene',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts,{hold:true})
  await h.render()
  await act(async()=>h.session().startFree())
  await act(async()=>{h.session().stop();await settle()})
  h.props.sceneId='s2'
  await act(async()=>{await h.render();await settle()})
  await act(async()=>{h.release();await settle()})
  expect(h.saves).toHaveLength(1)
  expect(h.saves[0]).toMatchObject({owner:'api-a',sceneId:'s'})
  expect(h.forwarded).toHaveLength(0)
}))

test('切 API 迟到保存：固定用操作开始时的 API，不用新会话上传',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts,{hold:true})
  await h.render()
  await act(async()=>h.session().startFree())
  h.props.api=h.apiB
  await act(async()=>{await h.render();await settle()})
  await act(async()=>{h.release();await settle()})
  expect(h.saves).toHaveLength(1)
  expect(h.saves[0].owner).toBe('api-a')
  expect(h.forwarded).toHaveLength(0)
}))

test('A→B→A：按会话对象实例判断，第一次 A 的迟到回执不算当前操作',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts,{hold:true})
  await h.render()
  await act(async()=>h.session().startFree())
  h.props.sceneId='s2'
  await act(async()=>{await h.render();await settle()})
  h.props.sceneId='s'
  await act(async()=>{await h.render();await settle()})
  await act(async()=>{h.release();await settle()})
  expect(h.saves).toHaveLength(1)
  expect(h.saves[0]).toMatchObject({owner:'api-a',sceneId:'s'})
  expect(h.forwarded).toHaveLength(0)
}))

test('保存失败：保留已录字节（orphan）并如实报错，不先标成功',withDom(async({root,counts})=>{
  const h=makeHarness(root,counts,{fail:true})
  await h.render()
  await act(async()=>h.session().startFree())
  await act(async()=>{h.session().stop();await settle()})
  expect(h.session().phase).toBe('idle')
  expect(h.session().error).toContain('SESSION_WRITE_DENIED')
  expect(h.session().orphan?.bytes).toBeGreaterThan(0)
  expect(h.forwarded).toHaveLength(0)
}))


test('路线记录：先总览、再用 A 设临时 POV 开流；主相机不被每 tick 挪走；取消清 POV 并恢复原机位',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 const original=h.state.instance.getViewState(),a={...structuredClone(original),position:[1,0,3]},b={...structuredClone(original),position:[2,0,3]}
 const overview={...structuredClone(original),position:[9,9,9]}
 let current=structuredClone(original),opened:any
 h.state.instance.getViewState=()=>structuredClone(current)
 h.state.instance.setViewState=(value:any)=>{current=structuredClone(value);h.metrics.mainViews.push(structuredClone(value))}
 // 模拟真实 Viewer：总览动作只移动主相机；随后临时 POV 设到 A，主相机不再被 tick 改。
 h.state.instance.frameCaptureRoute=(stations:any[])=>{h.metrics.overview.push(structuredClone(stations));current=structuredClone(overview);return {ok:true,stations:stations.length,available:stations.length}}
 h.state.instance.captureCanvasStream=()=>{opened={view:h.state.instance.routeCaptureState(),main:structuredClone(current)};return {width:160,height:120,stream:{getTracks:()=>[{stop:()=>{counts.trackStops++}}]}}}
 const route={routeId:'route-a-b',name:'A to B',sceneId:'s',sceneRevision:1,savedAt:'2026-10-17T00:00:00Z',stops:[{cameraName:'A',holdMs:200},{cameraName:'B',holdMs:200}],segmentMs:[2000]}
 const cameras=[{name:'A',savedAt:route.savedAt,state:a},{name:'B',savedAt:route.savedAt,state:b}]
 await h.render()
 await act(async()=>h.session().startRoute(route,cameras,'record'))
 // 首帧来自 A：开流那一刻临时 capture view 已经是 A；主相机停在总览，不在 A。
 expect(opened.view.position).toEqual(a.position)
 expect(opened.main.position).toEqual(overview.position)
 expect(h.metrics.overview).toHaveLength(1)
 expect(h.metrics.overview[0].map((station:any)=>station.key)).toEqual(['A','B'])
 expect(h.session().phase).toBe('route-record')
 // 让真实的 rAF tick 跑几轮：主相机仍是总览，没有被路线采样挪走。
 await act(async()=>{await settle()})
 expect(current.position).toEqual(overview.position)
 expect(h.state.instance.routeCaptureState()!.position).not.toEqual(overview.position)
 await act(async()=>h.session().cancel())
 expect(current).toEqual(original)
 expect(h.state.instance.routeCaptureState()).toBeUndefined()
 expect(h.metrics.routeClears).toBeGreaterThan(0)
 expect(h.session().phase).toBe('idle')
 expect(h.saves).toHaveLength(0)
 // 开流失败：临时 POV 清理、主相机恢复，不留 half-open 录制。
 h.state.instance.captureCanvasStream=()=>{throw new Error('FIXTURE_CAPTURE_START_FAILED')}
 await act(async()=>h.session().startRoute(route,cameras,'record'))
 expect(current).toEqual(original)
 expect(h.state.instance.routeCaptureState()).toBeUndefined()
 expect(h.session().phase).toBe('idle')
 expect(h.session().error).toContain('FIXTURE_CAPTURE_START_FAILED')
 expect(h.saves).toHaveLength(0)
}))

test('路线正常停止：清临时 POV、按原 owner 保存、恢复原机位',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 const original=h.state.instance.getViewState(),a={...structuredClone(original),position:[1,0,3]},b={...structuredClone(original),position:[2,0,3]}
 let current=structuredClone(original)
 h.state.instance.getViewState=()=>structuredClone(current)
 h.state.instance.setViewState=(value:any)=>{current=structuredClone(value)}
 h.state.instance.captureCanvasStream=()=>({width:160,height:120,stream:{getTracks:()=>[{stop:()=>{counts.trackStops++}}]}})
 const route={routeId:'route-a-b',name:'A to B',sceneId:'s',sceneRevision:1,savedAt:'2026-10-17T00:00:00Z',stops:[{cameraName:'A',holdMs:200},{cameraName:'B',holdMs:200}],segmentMs:[2000]}
 const cameras=[{name:'A',savedAt:route.savedAt,state:a},{name:'B',savedAt:route.savedAt,state:b}]
 await h.render()
 await act(async()=>h.session().startRoute(route,cameras,'record'))
 expect(h.state.instance.routeCaptureState()).toBeDefined()
 await act(async()=>{h.session().stop();await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.state.instance.routeCaptureState()).toBeUndefined()
 expect(h.metrics.routeClears).toBeGreaterThan(0)
 expect(h.saves).toHaveLength(1)
 expect(h.saves[0]).toMatchObject({owner:'api-a',sceneId:'s',stopReason:'user-stop'})
 expect(current).toEqual(original)
}))

test('路线预览时 Viewer 更换：清掉旧实例的临时 POV 并回到 idle',withDom(async({root})=>{
 const h=makeHarness(root,{stops:0,trackStops:0} as any)
 const original=h.state.instance.getViewState(),a={...structuredClone(original),position:[1,0,3]},b={...structuredClone(original),position:[2,0,3]}
 const route={routeId:'route-a-b',name:'A to B',sceneId:'s',sceneRevision:1,savedAt:'2026-10-17T00:00:00Z',stops:[{cameraName:'A',holdMs:0},{cameraName:'B',holdMs:0}],segmentMs:[2000]}
 const cameras=[{name:'A',savedAt:route.savedAt,state:a},{name:'B',savedAt:route.savedAt,state:b}]
 await h.render()
 await act(async()=>h.session().startRoute(route,cameras,'preview'))
 expect(h.session().phase).toBe('route-preview')
 expect(h.state.instance.routeCaptureState()).toBeDefined()
 const old=h.state.instance
 h.state.instance={...old,routeCaptureState:()=>undefined}
 await act(async()=>{await h.render();await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.metrics.routeClears).toBeGreaterThan(0)
}))

test('Cancel→restart：onstop ack 前保持 Cancelling 且拒绝 Start，ack 后释放轨道并允许重录/Stop',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 await h.render()
 await act(async()=>h.session().startFree())
 expect(h.session().phase).toBe('free')
 const opened=counts.recorders.length
 let cancelPromise!:Promise<void>,done=false
 await act(async()=>{cancelPromise=Promise.resolve(h.session().cancel());void cancelPromise.then(()=>{done=true});await Promise.resolve()})
 expect(h.session().phase).toBe('cancelling')
 // ack 之前再点 Start：不得创建第二段录制，也不得偷偷回到 idle。
 await act(async()=>{h.session().startFree();await Promise.resolve()})
 expect(counts.recorders).toHaveLength(opened)
 expect(h.session().phase).toBe('cancelling')
 expect(done).toBe(false)
 expect(h.saves).toHaveLength(0)
 expect(h.session().orphan).toBeUndefined()
 // 原生 onstop 到了才释放轨道/允许重开。
 await act(async()=>{counts.ackLatest();await cancelPromise;await settle()})
 expect(done).toBe(true)
 expect(h.session().phase).toBe('idle')
 expect(counts.trackStops).toBeGreaterThan(0)
 await act(async()=>h.session().startFree())
 expect(h.session().phase).toBe('free')
 await act(async()=>{h.session().stop();await Promise.resolve()})
 await act(async()=>{counts.ackLatest();await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.saves).toHaveLength(1)
 expect(h.saves[0].blobSize).toBeGreaterThan(0)
},{holdStop:true}))

test('Cancel 幂等；ack 后旧 ondata/onstop 迟到不写进新录制',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 await h.render()
 await act(async()=>h.session().startFree())
 const first=counts.recorders[0]
 let p1!:Promise<void>,p2!:Promise<void>
 await act(async()=>{p1=Promise.resolve(h.session().cancel());p2=Promise.resolve(h.session().cancel());await Promise.resolve()})
 expect(p2).toBe(p1)
 const lateStop=first.onstop
 await act(async()=>{counts.ackLatest();await p1;await settle()})
 await act(async()=>h.session().startFree())
 // 第一段录制的迟到事件：字节与 onstop 都不得污染第二段。
 first.ondataavailable?.({data:new Blob([new Uint8Array(4096)],{type:first.mimeType})})
 lateStop?.()
 await act(async()=>{await settle()})
 expect(h.session().phase).toBe('free')
 await act(async()=>{h.session().stop();await Promise.resolve()})
 await act(async()=>{counts.ackLatest();await settle()})
 expect(h.saves).toHaveLength(1)
 expect(h.saves[0].blobSize).toBe('capture-lifecycle-fixture'.length)
},{holdStop:true}))

test('Stop 期间 Cancel：等同一个 onstop 确认、不保存也不留下 0B 恢复入口，随后可重录',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 await h.render()
 await act(async()=>h.session().startFree())
 await act(async()=>{h.session().stop();await Promise.resolve()})
 expect(counts.stops).toBe(1)
 let cancelPromise!:Promise<void>
 await act(async()=>{cancelPromise=Promise.resolve(h.session().cancel());await Promise.resolve()})
 expect(h.session().phase).toBe('cancelling')
 await act(async()=>{counts.ackLatest();await cancelPromise;await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.saves).toHaveLength(0)
 expect(h.session().orphan).toBeUndefined()
 expect(h.session().error).not.toContain('bytes kept')
 // 取消完成后仍可正常走完下一段。
 await act(async()=>h.session().startFree())
 await act(async()=>{h.session().stop();await Promise.resolve()})
 await act(async()=>{counts.ackLatest();await settle()})
 expect(h.saves).toHaveLength(1)
},{holdStop:true}))

test('保存中 Cancel：旧保存回执不覆盖新录制的 phase/notice',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts,{hold:true})
 await h.render()
 await act(async()=>h.session().startFree())
 await act(async()=>{h.session().stop();await settle()})
 expect(h.saves).toHaveLength(1)
 expect(h.session().saving).toBe(true)
 let cancelPromise!:Promise<void>
 await act(async()=>{cancelPromise=Promise.resolve(h.session().cancel());await cancelPromise})
 expect(h.session().phase).toBe('idle')
 expect(h.session().saving).toBe(false)
 await act(async()=>h.session().startFree())
 expect(h.session().phase).toBe('free')
 await act(async()=>{h.release();await settle()})
 // 旧操作已落盘到原 owner，但不得清掉新录制的 phase/写 notice。
 expect(h.session().phase).toBe('free')
 expect(h.session().notice).toBe('')
 expect(h.forwarded).toHaveLength(0)
 await act(async()=>{const p=Promise.resolve(h.session().cancel());await p;await settle()})
},{holdStop:false}))

test('0B 停止明确失败：不上传、不生成 orphan/下载，也不显示“已保留字节”',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 await h.render()
 await act(async()=>h.session().startFree())
 await act(async()=>{h.session().stop();await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.saves).toHaveLength(0)
 expect(h.session().orphan).toBeUndefined()
 expect(h.session().error).toContain('VIDEO_BYTES_EMPTY')
 expect(h.session().error).not.toContain('bytes kept')
},{empty:true}))

test('切 Scene 时 Cancel：旧停止回执不把旧相机恢复到新场景，也不保存旧字节',withDom(async({root,counts})=>{
 const h=makeHarness(root,counts)
 await h.render()
 await act(async()=>h.session().startFree())
 h.props.sceneId='s2'
 let cancelPromise!:Promise<void>
 await act(async()=>{await h.render();await Promise.resolve()})
 expect(counts.stops).toBe(1)
 await act(async()=>{cancelPromise=Promise.resolve(h.session().cancel());await Promise.resolve()})
 await act(async()=>{counts.ackLatest();await cancelPromise;await settle()})
 expect(h.session().phase).toBe('idle')
 expect(h.saves).toHaveLength(0)
 expect(h.metrics.mainViews).toHaveLength(0)
},{holdStop:true}))
