/**
 * V9 Capture 首屏/路线二级/画布浮条的真实 React + jsdom 行为。
 *
 *  · 默认是标题 Capture + 当前视角 + 真 button 的 Take image / Start capture + **一套** Saved views；
 *  · 路线是同栏二级（返回/名称/站点/时长/预览/录制），不再在首屏摊一摞技术折叠项；
 *  · 缺失/坏机位如实标不可用并禁止录制，不补假位姿；
 *  · 录制中进度/Stop/Cancel 由画布底部 `CaptureSessionBar` 承载，失败/孤立字节仍在面板可见。
 *
 * 边界：不验证真实录制字节/浏览器编码（那由 capture-session-lifecycle 与主控原生验收覆盖）。
 */
import {test,expect} from "bun:test"
import {createRequire} from "node:module"
import {createElement,act} from "react"
import {createRoot,type Root} from "react-dom/client"
import type {ContinuousCaptureSession} from "../src/capture-session.ts"

const tr=(_zh:string,en:string)=>en

function withDom(run:(dom:{window:any;document:any;root:Root;flush:()=>Promise<void>})=>Promise<void>){
 return async()=>{
  const {JSDOM}=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))('jsdom') as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:any}}
  const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ['window','document','HTMLElement','Node','navigator','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
   saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
   const raw=(dom.window as unknown as Record<string,unknown>)[key]
   const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof raw==='function'&&key.includes('AnimationFrame')?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
   Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  const root=createRoot(document.getElementById('root')!)
  const flush=()=>act(async()=>{await new Promise(done=>setTimeout(done,0))})
  // jsdom 里 React 的 value-change polyfill 会找 IE 的 attachEvent；与既有 DOM 用例同处理。
  dom.window.HTMLElement.prototype.attachEvent=()=>{}
  dom.window.HTMLElement.prototype.detachEvent=()=>{}
  try{await run({window:dom.window,document,root,flush})}finally{
   await act(async()=>root.unmount())
   dom.window.close()
   for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
  }
 }
}

function sessionStub(overrides:Partial<ContinuousCaptureSession>={}):ContinuousCaptureSession{
 return {phase:"idle",elapsedMs:0,saving:false,error:"",notice:"",startFree(){},stop(){},cancel(){},startRoute(){},clear(){},...overrides}
}
const api:any={videoURL:(id:string)=>`/video/${id}`}
const cameras:any[]=[
 {name:"cam-a",savedAt:"",state:{position:[1,2,3],quaternion:[0,0,0,1],target:[0,0,0],fovDeg:50}},
 {name:"cam-b",savedAt:"",state:{position:[4,5,6],quaternion:[0,0,0,1],target:[0,0,0],fovDeg:50}},
]

function setNativeValue(dom:{window:any},element:HTMLElement,value:string){
 const proto=element.tagName==='SELECT'?(dom.window as any).HTMLSelectElement.prototype:(dom.window as any).HTMLInputElement.prototype
 element.focus()
 Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(element,value)
 element.dispatchEvent(new (dom.window as any).Event('input',{bubbles:true}))
 element.dispatchEvent(new (dom.window as any).Event('change',{bubbles:true}))
 element.dispatchEvent(new (dom.window as any).KeyboardEvent('keyup',{key:'1',bubbles:true}))
}
const byTestId=(id:string)=>document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonByText=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text||button.getAttribute('aria-label')===text)

const repairRoute=(routeId='repair',name='Repair route')=>({routeId,name,sceneId:'s',sceneRevision:1,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-19T00:00:00Z'})
const repairProps=()=>({session:sessionStub(),cameras:structuredClone(cameras),routes:[repairRoute()],videos:[],captures:[],api,sceneId:'s',sceneRevision:1,tr,perform:(fn:any)=>void fn(),readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async(_next:any)=>{}})
async function openRepairRoute(pose=false){
 await act(async()=>byTestId('capture-route-entry')!.click())
 ;(byTestId('capture-saved-routes') as HTMLDetailsElement).open=true
 await act(async()=>buttonByText('Repair route')!.click())
 if(pose)await act(async()=>buttonByText('Inspect stop 1')!.click())
}

for(const mode of ['preview','record'] as const)test(`站点 Apply 与 ${mode} 共享同步互锁，回执后用最新 pose 启动`,withDom(async({window,root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps(),writes:any[]=[],starts:any[]=[]
 let resolve!:()=>void
 p.session.startRoute=(...args:any[])=>starts.push(args)
 p.onUpdateCameraPose=async(name:string,state:any)=>{writes.push({name,state});await new Promise<void>(done=>{resolve=done})}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await openRepairRoute(true)
 await act(async()=>setNativeValue({window},document.querySelector<HTMLInputElement>('[aria-label="Station position XYZ"]')!,'7 8 9'))
 // 同批次尚未重渲染 disabled 时，也不能穿过写锁启动。
 await act(async()=>{buttonByText('Apply station')!.click();buttonByText(mode==='preview'?'Preview route':'Record route')!.click();buttonByText('Use current view to update station')?.click()})
 expect(writes).toHaveLength(1);expect(starts).toHaveLength(0)
 for(const label of ['Preview route','Record route','Save route','New route','Delete route Repair route','Use current view to update station'])expect(buttonByText(label)!.disabled).toBe(true)
 expect(byTestId('capture-route')!.textContent).toContain('Saving station…')
 expect(buttonByText('Inspect stop 2')!.disabled).toBe(true)
 await act(async()=>document.querySelector<HTMLButtonElement>('.lya-back')!.click())
 expect(byTestId('capture-route')).not.toBeNull()
 // 宿主提供权威新 cameras，不在本面板复制/篡改原 pose。
 p.cameras=p.cameras.map((camera:any)=>camera.name===writes[0].name?{...camera,state:writes[0].state}:camera)
 await act(async()=>{resolve();root.render(createElement(ContinuousCapturePanel,p))})
 expect(buttonByText('Preview route')!.disabled).toBe(false)
 expect(buttonByText('Record route')!.disabled).toBe(false)
 await act(async()=>buttonByText(mode==='preview'?'Preview route':'Record route')!.click())
 expect(starts).toHaveLength(1)
 expect(starts[0][2]).toBe(mode)
 expect(starts[0][1][0].state.position).toEqual([7,8,9])
 expect(cameras[0].state.position).toEqual([1,2,3])
}))

test('站点 Apply 失败保留手动草稿/错误，互锁释放后可重试成功',withDom(async({window,root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps(),writes:any[]=[]
 let reject!:(error:Error)=>void,resolve!:()=>void
 p.onUpdateCameraPose=async(_name:string,state:any)=>{writes.push(state);await new Promise<void>((yes,no)=>{resolve=yes;reject=no})}
 await act(async()=>root.render(createElement(ContinuousCapturePanel,p)));await openRepairRoute(true)
 const input=()=>document.querySelector<HTMLInputElement>('[aria-label="Station position XYZ"]')!
 await act(async()=>setNativeValue({window},input(),'7 8 9'))
 await act(async()=>buttonByText('Apply station')!.click())
 expect(buttonByText('Record route')!.disabled).toBe(true)
 await act(async()=>reject(Error('POSE_WRITE_DENIED')))
 expect(input().value).toBe('7 8 9')
 expect(byTestId('capture-station-editor')!.querySelector('[role="alert"]')!.textContent).toContain('POSE_WRITE_DENIED')
 expect(byTestId('capture-route')!.textContent).not.toContain('Station saved.')
 expect(buttonByText('Preview route')!.disabled).toBe(false)
 await act(async()=>buttonByText('Apply station')!.click())
 expect(writes).toHaveLength(2)
 expect(buttonByText('Record route')!.disabled).toBe(true)
 await act(async()=>resolve())
 expect(byTestId('capture-station-editor')!.textContent).toContain('Station saved.')
 expect(byTestId('capture-station-editor')!.querySelector('[role="alert"]')).toBeNull()
 expect(buttonByText('Record route')!.disabled).toBe(false)
}))

test('当前视角更新同样阻止双击、Apply、保存和路线启动，失败保留反馈并可重试',withDom(async({root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps(),writes:any[]=[],starts:any[]=[],saves:any[]=[]
 let reject!:(error:Error)=>void,resolve!:()=>void
 p.currentView=()=>({position:[9,8,7],quaternion:[0,0,0,1],target:[9,8,4],up:[0,1,0],fovDeg:55})
 p.onUpdateCameraPose=async(name:string,state:any)=>{writes.push({name,state});await new Promise<void>((yes,no)=>{resolve=yes;reject=no})}
 p.saveRoutes=async(next:any)=>{saves.push(next)}
 p.session.startRoute=(...args:any[])=>starts.push(args)
 await act(async()=>root.render(createElement(ContinuousCapturePanel,p)));await openRepairRoute(true)
 await act(async()=>{buttonByText('Use current view to update station')!.click();buttonByText('Use current view to update station')!.click();buttonByText('Apply station')!.click();buttonByText('Save route')!.click();buttonByText('Preview route')!.click();buttonByText('Record route')!.click()})
 expect(writes).toHaveLength(1);expect(saves).toHaveLength(0);expect(starts).toHaveLength(0)
 expect(writes[0]).toMatchObject({name:'cam-a',state:p.currentView()})
 expect(buttonByText('Apply station')!.disabled).toBe(true)
 await act(async()=>reject(Error('CURRENT_POSE_DENIED')))
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')!.textContent).toContain('CURRENT_POSE_DENIED')
 expect(buttonByText('Record route')!.disabled).toBe(false)
 await act(async()=>buttonByText('Use current view to update station')!.click())
 expect(writes).toHaveLength(2)
 p.cameras=p.cameras.map((camera:any)=>camera.name===writes[1].name?{...camera,state:writes[1].state}:camera)
 await act(async()=>{resolve();root.render(createElement(ContinuousCapturePanel,p))})
 expect(byTestId('capture-route')!.textContent).toContain('Station pose and lens saved to the named camera.')
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')).toBeNull()
 await act(async()=>buttonByText('Preview route')!.click())
 await act(async()=>buttonByText('Record route')!.click())
 expect(starts.map(args=>args[2])).toEqual(['preview','record'])
 for(const args of starts)expect(args[1][0].state.position).toEqual([9,8,7])
}))

test('路线删除与 Save 及其他删除串行，失败不清清单/草稿，成功后以宿主清单为准',withDom(async({root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps(),calls:any[]=[]
 p.routes=[repairRoute(),repairRoute('other','Other route')]
 let reject!:(error:Error)=>void,resolve!:()=>void
 p.saveRoutes=async(next:any)=>{calls.push(next);await new Promise<void>((yes,no)=>{resolve=yes;reject=no})}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await openRepairRoute(true)
 await act(async()=>{buttonByText('Delete route Repair route')!.click();buttonByText('Delete route Repair route')!.click();buttonByText('Delete route Other route')!.click();buttonByText('Save route')!.click()})
 expect(calls).toHaveLength(1);expect(calls[0].map((row:any)=>row.routeId)).toEqual(['other'])
 expect(buttonByText('Delete route Repair route')!.disabled).toBe(true)
 expect(buttonByText('Delete route Other route')!.disabled).toBe(true)
 expect(buttonByText('Save route')!.disabled).toBe(true)
 expect(buttonByText('Apply station')!.disabled).toBe(true)
 expect(buttonByText('Record route')!.disabled).toBe(true)
 expect(byTestId('capture-route')!.textContent).toContain('Deleting route…')
 expect(buttonByText('Repair route')).toBeDefined()
 await act(async()=>reject(Error('ROUTE_DELETE_DENIED')))
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')!.textContent).toContain('ROUTE_DELETE_DENIED')
 expect(byTestId('capture-route')!.textContent).not.toContain('Route deleted.')
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('Repair route')
 expect(buttonByText('Repair route')).toBeDefined();expect(buttonByText('Other route')).toBeDefined()
 expect(buttonByText('Delete route Repair route')!.disabled).toBe(false)
 await act(async()=>buttonByText('Delete route Repair route')!.click())
 expect(calls).toHaveLength(2)
 p.routes=calls[1]
 await act(async()=>{resolve();root.render(createElement(ContinuousCapturePanel,p))})
 expect(buttonByText('Repair route')).toBeUndefined();expect(buttonByText('Other route')).toBeDefined()
 expect(byTestId('capture-route')!.textContent).toContain('Route deleted.')
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('Repair route')
 // 反方向：Save 在途也阻止删除，不重叠提交同一 revision。
 await act(async()=>{buttonByText('Save route')!.click();buttonByText('Delete route Other route')!.click()})
 expect(calls).toHaveLength(3)
 expect(buttonByText('Delete route Other route')!.disabled).toBe(true)
 await act(async()=>resolve())
 expect(byTestId('capture-route')!.textContent).toContain('Route saved.')
}))

for(const kind of ['station','route-save','route-delete'] as const)for(const outcome of ['resolve','reject'] as const)test(`${kind} 迟到${outcome}不污染切 API 后再返回的上下文`,withDom(async({root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps()
 let resolve!:()=>void,reject!:(error:Error)=>void
 const pending=async()=>await new Promise<void>((yes,no)=>{resolve=yes;reject=no})
 p.onUpdateCameraPose=pending;p.saveRoutes=pending
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await openRepairRoute(true)
 await act(async()=>buttonByText(kind==='station'?'Apply station':kind==='route-save'?'Save route':'Delete route Repair route')!.click())
 const first=p.api
 p.api={...first};await render();p.api=first;await render()
 expect(buttonByText('Record route')!.disabled).toBe(true)
 await act(async()=>outcome==='resolve'?resolve():reject(Error('OLD_OWNER_WRITE_FAILED')))
 const text=byTestId('capture-route')!.textContent!
 expect(text).not.toContain('OLD_OWNER_WRITE_FAILED')
 expect(text).not.toContain('Route saved.')
 expect(text).not.toContain('Route deleted.')
 expect(text).not.toContain('Station saved.')
 expect(buttonByText('Record route')!.disabled).toBe(false)
}))

test('英语界面坏站点的直接原因保持英语，不填假 pose',withDom(async({root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 for(const [field,value,reason]of [['position',undefined,'no valid position'],['quaternion',undefined,'no valid rotation'],['fovDeg',undefined,'no lens']] as const){
  const p:any=repairProps();p.cameras[0].state[field]=value
  await act(async()=>root.render(createElement(ContinuousCapturePanel,{...p,key:field})));await openRepairRoute()
  await act(async()=>buttonByText('Inspect stop 1')!.click())
  expect(byTestId('route-stop-0')!.getAttribute('data-unavailable')).toBe('true')
  expect(byTestId('capture-route-pose')!.textContent).toContain(reason)
  expect(byTestId('capture-route')!.textContent).not.toMatch(/[\u3400-\u9fff]/)
  expect(buttonByText('Record route')!.disabled).toBe(true)
  expect(byTestId('capture-station-editor')).toBeNull()
 }
}))

test('空路线草稿也显示删除在途状态并共享互锁',withDom(async({root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const p:any=repairProps()
 let resolve!:()=>void
 p.saveRoutes=async()=>await new Promise<void>(done=>{resolve=done})
 await act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await act(async()=>byTestId('capture-route-entry')!.click())
 ;(byTestId('capture-saved-routes') as HTMLDetailsElement).open=true
 await act(async()=>buttonByText('Delete route Repair route')!.click())
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('')
 expect(byTestId('capture-route')!.textContent).toContain('Deleting route…')
 expect(buttonByText('New route')!.disabled).toBe(true)
 await act(async()=>resolve())
 expect(byTestId('capture-route')!.textContent).toContain('Route deleted.')
 expect(buttonByText('New route')!.disabled).toBe(false)
}))

test('保存路线等待真实回执且失败不报成功，可重试并保留草稿',withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 let reject!:(failure:Error)=>void,calls=0,fail=true
 const routes:any[]=[{routeId:'r',name:'Retry route',sceneId:'s',sceneRevision:1,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-19T00:00:00Z'}]
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{session:sessionStub(),cameras,routes,videos:[],captures:[],api,sceneId:'s',sceneRevision:9,tr,perform:(fn:any)=>void fn(),readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async(next:any)=>{calls++;expect(next[0].sceneRevision).toBe(9);if(fail)await new Promise((_resolve,no)=>{reject=no})}} as any)))
 await act(async()=>byTestId('capture-route-entry')!.click())
 ;(byTestId('capture-saved-routes') as HTMLDetailsElement).open=true
 await act(async()=>buttonByText('Retry route')!.click())
 await act(async()=>{buttonByText('Save route')!.click();buttonByText('Save route')!.click()})
 expect(calls).toBe(1)
 expect(buttonByText('Save route')!.disabled).toBe(true)
 expect(buttonByText('New route')!.disabled).toBe(true)
 expect(byTestId('capture-route')!.textContent).not.toContain('Route saved.')
 await act(async()=>reject(new Error('ROUTE_SAVE_DENIED')))
 await flush()
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')!.textContent).toContain('ROUTE_SAVE_DENIED')
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('Retry route')
 fail=false
 await act(async()=>buttonByText('Save route')!.click())
 expect(calls).toBe(2)
 expect(byTestId('capture-route')!.textContent).toContain('Route saved.')
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')).toBeNull()
}))

test('手动站点输入可校验、复位并保存完整真实机位',withDom(async({window,root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const writes:any[]=[],routes:any[]=[{routeId:'manual',name:'Manual',sceneId:'s',sceneRevision:3,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-19T00:00:00Z'}]
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{session:sessionStub(),cameras,routes,videos:[],captures:[],api,sceneId:'s',sceneRevision:3,tr,perform:(fn:any)=>void fn(),readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},onUpdateCameraPose:async(name:string,state:any)=>writes.push({name,state})} as any)))
 await act(async()=>byTestId('capture-route-entry')!.click())
 const saved=byTestId('capture-saved-routes') as HTMLDetailsElement
 expect(saved.open).toBe(false)
 saved.open=true
 await act(async()=>buttonByText('Manual')!.click())
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Inspect stop 1"]')!.click())
 const details=byTestId('capture-route-pose-details')!
 expect(details.tagName).not.toBe('DETAILS')
 expect(byTestId('capture-station-editor')).not.toBeNull()
 const input=(label:string)=>document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
 await act(async()=>setNativeValue({window},input('Station quaternion xyzw'),'0, 0, 0, 0'))
 await act(async()=>buttonByText('Apply station')!.click())
 expect(writes).toHaveLength(0)
 expect(byTestId('capture-station-editor')!.querySelector('[role="alert"]')).not.toBeNull()
 await act(async()=>buttonByText('Reset inputs')!.click())
 expect(input('Station quaternion xyzw').value).toBe('0, 0, 0, 1')
 expect(byTestId('capture-station-editor')!.querySelector('[role="alert"]')).toBeNull()
 await act(async()=>setNativeValue({window},input('Station position XYZ'),'7, 8, 9'))
 await act(async()=>setNativeValue({window},input('Station field of view'),'65'))
 await act(async()=>buttonByText('Apply station')!.click())
 expect(writes).toHaveLength(1)
 expect(writes[0]).toMatchObject({name:'cam-a',state:{position:[7,8,9],quaternion:[0,0,0,1],fovDeg:65}})
 expect(writes[0].state.target).toEqual([7,8,9-Math.sqrt(14)])
 expect(cameras[0].state.position).toEqual([1,2,3])
 await act(async()=>buttonByText('New route')!.click())
 expect(byTestId('capture-route-pose')).toBeNull()
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('')
}))

test('内参机位手动位置保留 K、裁剪面和视场，保存失败留局部错误',withDom(async({window,root})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const K={fx:200,fy:220,cx:160,cy:120,width:320,height:240},writes:any[]=[]
 const views=cameras.map(camera=>({...camera,state:{...camera.state,intrinsics:K,near:.02,far:120}}))
 const routes:any[]=[{routeId:'k',name:'K route',sceneId:'s',sceneRevision:1,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-19T00:00:00Z'}]
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{session:sessionStub(),cameras:views,routes,videos:[],captures:[],api,sceneId:'s',sceneRevision:1,tr,perform:(fn:any)=>void fn(),readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},onUpdateCameraPose:async(_name:string,state:any)=>{writes.push(state);throw Error('POSE_WRITE_DENIED')}} as any)))
 await act(async()=>byTestId('capture-route-entry')!.click())
 ;(byTestId('capture-saved-routes') as HTMLDetailsElement).open=true
 await act(async()=>buttonByText('K route')!.click())
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Inspect stop 1"]')!.click())
 expect(document.querySelector('[aria-label="Station field of view"]')).toBeNull()
 await act(async()=>setNativeValue({window},document.querySelector<HTMLInputElement>('[aria-label="Station position XYZ"]')!,'4 5 6'))
 await act(async()=>buttonByText('Apply station')!.click())
 expect(writes[0]).toMatchObject({position:[4,5,6],intrinsics:K,near:.02,far:120,fovDeg:50})
 expect(byTestId('capture-station-editor')!.querySelector('[role="alert"]')!.textContent).toContain('POSE_WRITE_DENIED')
 expect(byTestId('capture-station-editor')!.textContent).not.toContain('Station saved.')
}))

test('路线运行中只读状态与底条，停止恢复草稿且失败字节仍可见',withDom(async({root})=>{
 const {ContinuousCapturePanel,CaptureSessionBar}=await import('../src/capture-video-panel.tsx')
 const routes:any[]=[{routeId:'r',name:'Live route',sceneId:'s',sceneRevision:3,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-19T00:00:00Z'}]
 let session=sessionStub(),stops=0,cancels=0
 const render=()=>act(async()=>root.render(createElement('div',null,createElement(ContinuousCapturePanel,{session,cameras,routes,videos:[],captures:[],api,sceneId:'s',sceneRevision:3,tr,perform:(fn:any)=>void fn(),readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{}} as any),createElement(CaptureSessionBar,{session,tr}))))
 await render()
 await act(async()=>byTestId('capture-route-entry')!.click())
 await act(async()=>buttonByText('Live route')!.click())
 session=sessionStub({phase:'route-record',currentSegment:{index:0,phase:'move'},elapsedMs:700,totalMs:2000,stop:()=>{stops++},cancel:()=>{cancels++},error:'SAVE_FAILED',orphan:{bytes:12,url:'blob:test',fileName:'test.webm',mimeType:'video/webm',error:'SAVE_FAILED'}})
 await render()
 expect(byTestId('capture-active')).not.toBeNull()
 expect(byTestId('capture-route')).toBeNull()
 expect(document.querySelector('input')).toBeNull()
 expect(byTestId('capture-elapsed')!.textContent).toBe('A → B · 0.7 s / 2 s')
 expect(byTestId('capture-orphan')!.querySelector('a')).not.toBeNull()
 await act(async()=>buttonByText('Stop')!.click())
 await act(async()=>buttonByText('Cancel')!.click())
 expect(stops).toBe(1);expect(cancels).toBe(1)
 session=sessionStub({error:'SAVE_FAILED'})
 await render()
 expect(document.querySelector<HTMLInputElement>('[aria-label="Route name"]')!.value).toBe('Live route')
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')!.textContent).toContain('The recording could not be saved.')
 expect(byTestId('capture-route')!.querySelector('[role="alert"]')!.textContent).toContain('SAVE_FAILED')
}))

test("Capture 首屏只有一套 Saved views，拍照/开始拍摄是真按钮；路线在二级页可编辑/录制",withDom(async({window:domWindow,root,flush})=>{
 const calls:{mode:string}[]=[], take=[], saved:any[]=[], overview:any[]=[]
 let free=0
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{
  session:sessionStub({startRoute:(_route,_cameras,mode)=>calls.push({mode}),startFree:()=>{free+=1}}),
  cameras,routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async(next:any)=>{saved.push(next)},onTakeImage:()=>take.push(1),onRouteOverview:(stations:any[])=>overview.push(stations),currentView:()=>({position:[5,-6,4],quaternion:[0,0,0,1],fovDeg:40}),
 } as any)))
 await flush()
 // Free view 不再重复 Current view 标签；XYZ 只在既有 View details 内出现一次。
 expect(byTestId('continuous-capture')!.querySelector('.lya-help')?.textContent).not.toBe('Current view')
 const viewDetails=byTestId('capture-view-details') as HTMLDetailsElement
 expect(viewDetails.open).toBe(false)
 expect(viewDetails.textContent).toContain('5.000, -6.000, 4.000')
 expect((viewDetails.textContent!.match(/5\.000/g)??[]).length).toBe(1)
 // 首屏：拍/录都是真实 button，不是 ListRow 侧边文字。
 const takeButton=byTestId('capture-take-image') as HTMLButtonElement
 const startButton=byTestId('capture-start-free') as HTMLButtonElement
 expect(takeButton.tagName).toBe('BUTTON')
 expect(startButton.tagName).toBe('BUTTON')
 expect(takeButton.disabled).toBe(false)
 expect(startButton.disabled).toBe(false)
 await act(async()=>takeButton.click())
 await act(async()=>startButton.click())
 expect(take.length).toBe(1);expect(free).toBe(1)
 // 默认只有一套 Saved views；路线未展开，进入二级的入口是按钮。
 const sectionLabels=[...document.querySelectorAll('.lya-section>span:first-child')].map(item=>item.textContent)
 expect(sectionLabels.filter(text=>text==='Saved views').length).toBe(1)
 expect(byTestId('capture-saved-views')).not.toBeNull()
 expect(byTestId('capture-route')).toBeNull()
 const routeEntry=byTestId('capture-route-entry') as HTMLButtonElement
 expect(routeEntry.tagName).toBe('BUTTON')
 expect(byTestId('capture-videos')!.textContent).toContain('No videos yet')
 // 保存视角仍在具名折叠里，输入与动作保持挂载。
 const views=byTestId('capture-views-section') as HTMLDetailsElement
 expect(views.open).toBe(false)
 expect(document.querySelector('input[aria-label="Camera name"]')).not.toBeNull()
 expect([...document.querySelectorAll('button')].some(button=>button.textContent==='Save view')).toBe(true)
 // 进入路线二级。
 await act(async()=>routeEntry.click())
 await flush()
 expect(byTestId('capture-route')).not.toBeNull()
 expect(document.querySelector('.lya-back')!.textContent).toContain('Capture')
 const nameInput=document.querySelector<HTMLInputElement>('input[aria-label="Route name"]')!
 await act(async()=>setNativeValue({window:domWindow},nameInput,'R1'))
 await flush()
 expect(nameInput.value).toBe('R1')
 const select=document.querySelector<HTMLSelectElement>('select[aria-label="Add camera"]')!
 await act(async()=>setNativeValue({window:domWindow},select,'cam-a'))
 await act(async()=>buttonByText('Add stop')!.click())
 await act(async()=>setNativeValue({window:domWindow},select,'cam-b'))
 await act(async()=>buttonByText('Add stop')!.click())
 expect(byTestId('route-stop-0')!.textContent).toContain('cam-a')
 expect(byTestId('route-stop-1')!.textContent).toContain('cam-b')
 // 排序：把第一站下移，顺序真实改变。
 const moveDown=[...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')]
 await act(async()=>moveDown[0]!.click())
 expect(byTestId('route-stop-0')!.textContent).toContain('cam-b')
 // 总览动作把真实站点交给 Viewer；只作查看，不 pilot、不自动录制。
 const overviewButton=byTestId('capture-route-overview') as HTMLButtonElement
 expect(overviewButton.tagName).toBe('BUTTON')
 expect(buttonByText('Route overview')).not.toBeUndefined()
 await act(async()=>overviewButton.click())
 expect(overview).toHaveLength(1)
 expect(overview[0].map((station:any)=>station.key)).toEqual(['cam-b','cam-a'])
 expect(calls).toHaveLength(0)
 // 录制/预览 handler 收到真实草稿与模式。
 expect(buttonByText('Record route')!.disabled).toBe(false)
 await act(async()=>buttonByText('Record route')!.click())
 await act(async()=>buttonByText('Preview route')!.click())
 expect(calls.map(call=>call.mode)).toEqual(['record','preview'])
 // 保存 handler：Save route 把真实草稿交给 saveRoutes（空名/少站的拒绝判据在 capture-route 纯函数里）。
 await act(async()=>buttonByText('Save route')!.click())
 expect(saved.length).toBe(1)
 expect(saved[0][0].name).toBe('R1')
 expect(saved[0][0].stops.map((stop:any)=>stop.cameraName)).toEqual(['cam-b','cam-a'])
 // 返回后重开：草稿仍在（组件保持挂载，不重建世界）。
 await act(async()=>document.querySelector<HTMLButtonElement>('.lya-back')!.click())
 expect(byTestId('capture-route')).toBeNull()
 await act(async()=>byTestId('capture-route-entry')!.click())
 expect(document.querySelector<HTMLInputElement>('input[aria-label="Route name"]')!.value).toBe('R1')
 expect(byTestId('route-stop-0')).not.toBeNull()
 expect(byTestId('route-stop-1')).not.toBeNull()
}))

test("Capture 路线：缺失/坏机位标不可用并禁止录制，不补 [0,0,0]",withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const routes:any[]=[{routeId:'r1',name:'Missing route',sceneId:'scene-1',sceneRevision:2,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'gone',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-18T00:00:00.000Z'}]
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{
  session:sessionStub(),cameras,routes,videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},
 } as any)))
 await flush()
 await act(async()=>byTestId('capture-route-entry')!.click())
 await flush()
 // 载入一条含不存在机位的已存路线：第二站如实不可用，录制禁用。
 await act(async()=>buttonByText('Missing route')!.click())
 await flush()
 expect(byTestId('route-stop-1')!.textContent).toContain('gone')
 expect(byTestId('route-stop-1')!.getAttribute('data-unavailable')).toBe('true')
 expect(buttonByText('Record route')!.disabled).toBe(true)
 // 选中不可用站点：姿态区只给原因，没有伪造坐标。
 await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="route-stop-1"] .lya-row-main')!.click())
 expect(byTestId('capture-route-pose')!.textContent).toContain('unavailable')
 expect(byTestId('capture-route')!.textContent).not.toMatch(/[\u3400-\u9fff]/)
 expect(byTestId('capture-route')!.textContent).toContain('Choose another camera or remove this stop.')
 expect(byTestId('capture-route-pose')!.textContent).not.toContain('0.00, 0.00, 0.00')
}))

test("离开路线/卸载时清掉 Viewer 路线 helper，不遗留旧站点",withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const calls:Array<{stations:any[];selected:number}>=[]
 const routes:any[]=[{routeId:'r1',name:'Two views',sceneId:'scene-1',sceneRevision:2,stops:[{cameraName:'cam-a',holdMs:0},{cameraName:'cam-b',holdMs:0}],segmentMs:[2000],savedAt:'2026-10-18T00:00:00.000Z'}]
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{
  session:sessionStub(),cameras,routes,videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},
  onTrail:(stations:any[],selected:number)=>calls.push({stations,selected}),
 } as any)))
 await flush()
 await act(async()=>byTestId('capture-route-entry')!.click())
 await flush()
 await act(async()=>buttonByText('Two views')!.click())
 await flush()
 expect(calls.some(call=>call.stations.length===2)).toBe(true)
 const before=calls.length
 await act(async()=>root.render(createElement('div')))
 expect(calls.slice(before).some(call=>call.stations.length===0)).toBe(true)
}))

test("Capture 安全事实：画布浮条承载 Stop/Cancel，面板仍显示失败/孤立字节",withDom(async({root,flush})=>{
 let cancelled=0
 const {ContinuousCapturePanel,CaptureSessionBar}=await import('../src/capture-video-panel.tsx')
 const session=sessionStub({phase:'free',elapsedMs:1500,currentPose:{position:[1,2,3],quaternion:[0,0,0,1]},error:'RECORDING_FAILED: disk full',orphan:{bytes:2048,mimeType:'video/webm',url:'blob:x',fileName:'x.webm',error:'upload failed'},cancel:()=>{cancelled+=1}})
 await act(async()=>root.render(createElement('div',null,
  createElement(CaptureSessionBar,{session,tr} as any),
  createElement(ContinuousCapturePanel,{session,cameras,routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{}} as any),
 )))
 await flush()
 expect(byTestId('capture-recording-bar')).not.toBeNull()
 expect(byTestId('capture-recording-bar')!.textContent).toContain('Stop')
 expect(byTestId('capture-recording-bar')!.textContent).toContain('Cancel')
 expect(document.querySelector('[role="alert"]')!.textContent).toContain('RECORDING_FAILED')
 expect(byTestId('capture-orphan')!.textContent).toContain('2048')
 await act(async()=>buttonByText('Cancel')!.click())
 expect(cancelled).toBe(1)
}))


test("路线预览浮条提供真实 POV 小预览画布，并持续向 Viewer 取临时相机帧",withDom(async({root,flush})=>{
 const {CaptureSessionBar}=await import('../src/capture-video-panel.tsx')
 const frames:HTMLCanvasElement[]=[]
 const session=sessionStub({phase:'route-preview',elapsedMs:500,totalMs:4000,currentPose:{position:[1,2,3],quaternion:[0,0,0,1]}})
 await act(async()=>root.render(createElement(CaptureSessionBar,{session,tr,previewFrame:(canvas:HTMLCanvasElement)=>{frames.push(canvas);return true}} as any)))
 await flush()
 const canvas=document.querySelector<HTMLCanvasElement>('canvas[aria-label="Route camera preview"]')
 expect(canvas).not.toBeNull()
 expect(frames.length).toBeGreaterThan(0)
 expect(frames[0]).toBe(canvas!)
 await act(async()=>root.unmount())
}))

test('达到八个机位后禁止继续添加，错误段时长只显示局部错误并可新建恢复',withDom(async({window,root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{session:sessionStub(),cameras,routes:[],videos:[],captures:[],api,sceneId:'scene-limit',sceneRevision:1,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{}} as any)))
 await act(async()=>(byTestId('capture-route-entry') as HTMLButtonElement).click())
 const select=document.querySelector<HTMLSelectElement>('select[aria-label="Add camera"]')!
 await act(async()=>setNativeValue({window},select,'cam-a'))
 for(let i=0;i<8;i++)await act(async()=>buttonByText('Add stop')!.click())
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(8)
 expect(buttonByText('Add stop')!.disabled).toBe(true)
 await act(async()=>buttonByText('Add stop')!.click())
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(8)
 const segment=document.querySelector<HTMLInputElement>('input[aria-label="Segment seconds"]')!
 await act(async()=>setNativeValue({window},segment,'999999999'))
 await flush()
 expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy()
 expect(byTestId('capture-route')).not.toBeNull()
 expect(document.querySelector('[data-slot-error]')).toBeNull()
 await act(async()=>buttonByText('New route')!.click())
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(0)
 expect(buttonByText('Add stop')!.disabled).toBe(true)
 expect(select.value).toBe('')
 await act(async()=>setNativeValue({window},select,'cam-a'))
 await act(async()=>buttonByText('Add stop')!.click())
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(1)
}))

test("自由视角把当前画布当工作对象：Save current view 一眼可见，保存后立即进清单",withDom(async({window,root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const saved:string[]=[]
 const p:any={session:sessionStub(),cameras:[],routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},currentView:()=>({position:[5,-6,4],quaternion:[0,0,0,1],fovDeg:40}),onSaveView:(name:string)=>{saved.push(name);p.viewSaving=true}}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await flush()
 // 设计稿 V8-22 首屏不承载说明文：Take image / Start capture / 保存视角的区分必须由控件本身表达，
 // 说明只能进折叠。这里钉住"首屏没有这两段 prose"，避免又把长说明铺回来。
 expect(byTestId('capture-free-hint')).toBeNull()
 expect(byTestId('capture-save-view-hint')).toBeNull()
 // 保存动作在折叠外；折叠仍保留"保存内容"说明。
 const saveRow=byTestId('capture-save-view')!
 expect(saveRow).not.toBeNull()
 expect(saveRow.textContent).toContain('Save current view')
 const input=document.querySelector<HTMLInputElement>('input[aria-label="Camera name"]')!
 expect(input).not.toBeNull()
 const section=byTestId('capture-views-section') as HTMLDetailsElement
 expect(section.tagName).toBe('DETAILS')
 expect(section.open).toBe(false)
 await act(async()=>setNativeValue({window},input,'Doorway'))
 await act(async()=>buttonByText('Save view')!.click())
 expect(saved).toEqual(['Doorway'])
 expect(p.viewSaving).toBe(true)
 await render()
 // 宿主写回后清单立即出现；保存回执由真实清单新增确认，不是本地伪造行。
 p.cameras=[{name:'Doorway',savedAt:'',state:{position:[5,-6,4],quaternion:[0,0,0,1],target:[5,-6,1],fovDeg:40}}]
 p.viewSaving=false
 await render();await flush()
 expect(byTestId('capture-saved-views')!.textContent).toContain('Doorway')
 expect(byTestId('capture-view-notice')!.textContent).toContain('Saved view “Doorway” is now in the list.')
}))

test("Save current view as station 一步可达，按 A/B 顺序追加命名机位，站点详情直接给 Pose",withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const names:string[]=[]
 const view=()=>({position:[5,6,7],quaternion:[0,0,0,1],target:[5,6,4],fovDeg:50})
 const p:any={session:sessionStub(),cameras:[],routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},currentView:view,onSaveView:(name:string)=>{names.push(name);p.viewSaving=true}}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await act(async()=>byTestId('capture-route-entry')!.click())
 const quick=byTestId('capture-save-current-as-station') as HTMLButtonElement
 expect(quick).not.toBeNull()
 expect(quick.disabled).toBe(false)
 expect(byTestId('capture-route')!.textContent).toContain('Next stop A')
 // 设计稿 V8-23：首屏不放解释性长文；该 hint 已移除，语义由分区标题与按钮自身表达。
 expect(byTestId('capture-quick-station-hint')).toBeNull()
 // 不选下拉、不先保存、不展开折叠：一次点击就从当前视角建 A。
 await act(async()=>quick.click())
 expect(byTestId('capture-quick-station')!.textContent).toContain('Saving current view…')
 await render()
 p.viewSaving=true
 await render()
 p.cameras=[{name:names[0],savedAt:'',state:view()}]
 p.viewSaving=false
 await render();await flush()
 expect(names).toEqual(['Station A'])
 expect(byTestId('route-stop-0')).not.toBeNull()
 expect(byTestId('route-stop-0')!.textContent).toContain('Station A')
 expect(byTestId('route-stop-0')!.querySelector('.lya-route-pin')!.textContent).toBe('A')
 expect(byTestId('capture-route')!.textContent).toContain('Saved current view as station A: Station A.')
 // 站点详情默认展开：Pose 输入 + 当前视角更新 + 明确说明没有 target tracking。
 expect(byTestId('capture-route-pose-details')).not.toBeNull()
 expect(byTestId('capture-station-editor')).not.toBeNull()
 expect(document.querySelector('input[aria-label="Station position XYZ"]')).not.toBeNull()
 expect(document.querySelector('input[aria-label="Station quaternion xyzw"]')).not.toBeNull()
 expect(document.querySelector('input[aria-label="Station field of view"]')).not.toBeNull()
 expect(buttonByText('Use current view to update station')).not.toBeUndefined()
 expect(byTestId('capture-station-orientation-help')!.textContent).toContain('Target tracking and orientation lock are not available')
 // 下一站 B 同样一步追加，序号不跳号。
 await act(async()=>byTestId('capture-save-current-as-station')!.click())
 await render()
 p.viewSaving=true
 await render()
 p.cameras=[...p.cameras,{name:names[1],savedAt:'',state:view()}]
 p.viewSaving=false
 await render();await flush()
 expect(names).toEqual(['Station A','Station B'])
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(2)
 expect(byTestId('route-stop-1')!.querySelector('.lya-route-pin')!.textContent).toBe('B')
 expect(byTestId('route-stop-1')!.textContent).toContain('Station B')
 expect(byTestId('capture-route')!.textContent).toContain('Saved current view as station B: Station B.')
}))

test("Save current view as station 失败保留路线草稿，显示英文原因并把原始码收进折叠详情",withDom(async({window,root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const names:string[]=[]
 const view=()=>({position:[5,6,7],quaternion:[0,0,0,1],target:[5,6,4],fovDeg:50})
 const p:any={session:sessionStub(),cameras:[],routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},currentView:view,onSaveView:(name:string)=>{names.push(name);p.viewSaving=true}}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await act(async()=>byTestId('capture-route-entry')!.click())
 const nameInput=document.querySelector<HTMLInputElement>('input[aria-label="Route name"]')!
 await act(async()=>setNativeValue({window},nameInput,'Draft route'))
 await act(async()=>byTestId('capture-save-current-as-station')!.click())
 await render()
 p.viewSaving=true
 await render()
 // 宿主报告保存结束，但权威清单没有新机位：不得追加、不得报成功。
 p.viewSaving=false
 await render();await flush()
 const alert=byTestId('capture-route-error')!
 expect(alert).not.toBeNull()
 expect(alert.textContent).toContain('The host did not add the named view to the scene')
 expect(alert.textContent).toContain('VIEW_SAVE_NOT_CONFIRMED')
 expect(alert.querySelector('details')).not.toBeNull()
 expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/)
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(0)
 expect(document.querySelector<HTMLInputElement>('input[aria-label="Route name"]')!.value).toBe('Draft route')
 expect((byTestId('capture-save-current-as-station') as HTMLButtonElement).disabled).toBe(false)
 expect(byTestId('capture-route')!.textContent).toContain('Next stop A')
 // 失败后重试成功：同一草稿追加 A。
 p.onSaveView=(name:string)=>{names.push(name);p.viewSaving=true}
 await act(async()=>byTestId('capture-save-current-as-station')!.click())
 await render()
 p.viewSaving=true
 await render()
 p.cameras=[{name:names[1],savedAt:'',state:view()}]
 p.viewSaving=false
 await render();await flush()
 expect(byTestId('capture-route-error')).toBeNull()
 expect(document.querySelectorAll('[data-testid^="route-stop-"]').length).toBe(1)
 expect(byTestId('route-stop-0')!.textContent).toContain(names[1])
}))

test("拍摄运行中仍隐藏路线表单与站点快捷动作，只留简短状态",withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 let session=sessionStub()
 const p:any={session,cameras,routes:[repairRoute()],videos:[],captures:[],api,sceneId:'s',sceneRevision:1,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},currentView:()=>({position:[5,6,7],quaternion:[0,0,0,1],fovDeg:50}),onSaveView:()=>{}}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render();await act(async()=>byTestId('capture-route-entry')!.click())
 expect(byTestId('capture-save-current-as-station')).not.toBeNull()
 expect(document.querySelector('input[aria-label="Station name"]')).not.toBeNull()
 session=sessionStub({phase:'route-record',currentSegment:{index:0,phase:'move'},elapsedMs:700,totalMs:2000,stop(){},cancel(){}})
 p.session=session
 await render();await flush()
 expect(byTestId('capture-active')).not.toBeNull()
 expect(byTestId('capture-route')).toBeNull()
 expect(byTestId('capture-save-current-as-station')).toBeNull()
 expect(document.querySelector('input[aria-label="Station name"]')).toBeNull()
 expect(document.querySelector('input[aria-label="Route name"]')).toBeNull()
 // 设计稿 V8-24：拍摄态不写复述性说明文；停/取消的位置由画布浮条自身表达。
 expect(byTestId('capture-active-note')).toBeNull()
 // 回到空闲后原草稿/入口恢复（不重建 owner）。
 p.session=sessionStub()
 await render();await flush()
 expect(byTestId('capture-route')).not.toBeNull()
 expect(byTestId('capture-save-current-as-station')).not.toBeNull()
}))

test("中文 reason 在展示层变英语可读文案，原始码只在折叠详情",withDom(async({root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 await act(async()=>root.render(createElement(ContinuousCapturePanel,{session:sessionStub({error:'VIDEO_BYTES_EMPTY: 没有收到任何视频字节'}),cameras,routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{}} as any)))
 await flush()
 const alert=byTestId('capture-session-error')!
 expect(alert.textContent).toContain('No video bytes were received, so the file was not saved.')
 expect(alert.textContent).toContain('VIDEO_BYTES_EMPTY')
 expect(alert.querySelector('details')).not.toBeNull()
 expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/)
 expect(alert.querySelector('p')!.textContent).not.toContain('VIDEO_BYTES_EMPTY')
}))

test("自由视角保存失败不谎称已保存：保留输入，英文原因在折叠里给码",withDom(async({window,root,flush})=>{
 const {ContinuousCapturePanel}=await import('../src/capture-video-panel.tsx')
 const saved:string[]=[]
 const p:any={session:sessionStub(),cameras:[],routes:[],videos:[],captures:[],api,sceneId:'scene-1',sceneRevision:2,tr,perform:(fn:()=>Promise<unknown>)=>{void fn()},readOnly:false,replayActive:false,viewerVisible:true,saveRoutes:async()=>{},currentView:()=>({position:[5,-6,4],quaternion:[0,0,0,1],fovDeg:40}),onSaveView:(name:string)=>{saved.push(name);p.viewSaving=true}}
 const render=()=>act(async()=>root.render(createElement(ContinuousCapturePanel,p)))
 await render()
 const input=document.querySelector<HTMLInputElement>('input[aria-label="Camera name"]')!
 await act(async()=>setNativeValue({window},input,'Doorway'))
 await act(async()=>buttonByText('Save view')!.click())
 await render()
 // 宿主保存结束但权威清单没有新增/变化：不得显示成功回执或本地造行。
 p.viewSaving=false
 await render();await flush()
 expect(saved).toEqual(['Doorway'])
 expect(byTestId('capture-saved-views-empty')).not.toBeNull()
 expect(byTestId('capture-view-notice')).toBeNull()
 const alert=byTestId('capture-view-error')!
 expect(alert).not.toBeNull()
 expect(alert.textContent).toContain('did not appear in the saved-view list')
 expect(alert.textContent).toContain('SAVED_VIEW_NOT_CONFIRMED')
 expect(alert.querySelector('details')).not.toBeNull()
 expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/)
 expect(document.querySelector<HTMLInputElement>('input[aria-label="Camera name"]')!.value).toBe('Doorway')
 // 下一次真实写回成功：错误清除、清单出现、回执出现。
 await act(async()=>buttonByText('Save view')!.click())
 p.viewSaving=true
 await render()
 p.cameras=[{name:'Doorway',savedAt:'now',state:{position:[5,-6,4],quaternion:[0,0,0,1],target:[5,-6,1],fovDeg:40}}]
 p.viewSaving=false
 await render();await flush()
 expect(byTestId('capture-view-error')).toBeNull()
 expect(byTestId('capture-saved-views')!.textContent).toContain('Doorway')
 expect(byTestId('capture-view-notice')!.textContent).toContain('Saved view “Doorway” is now in the list.')
}))
