/**
 * P7A2 切换机位后的扫描状态归属：真 React 组件 + jsdom + 受控 API Promise。
 *
 * 边界：`api.request` 是测试替身，验证面板把**请求实例归属**收对——换机位后新来源立即可操作，
 * 旧请求的迟到成功/失败/`finally` 都不改写新操作的状态，A→B→A 时 key 文字重新相同也不接受旧 A 请求。
 * 原生 LiDAR 射线、真实浏览器与真实相机像素由主控独立验证；本文件不冒充原生/浏览器验收。
 */
import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {LidarScanPanel} from '../src/lidar-scan-panel.tsx'

const tr=(_zh:string,en:string)=>en
type Pending={resolve:(value:unknown)=>void;reject:(reason:unknown)=>void;signal?:AbortSignal}

function withDom(run:(host:HTMLElement,root:Root,render:(props:any)=>Promise<void>)=>Promise<void>){
 return async()=>{
  const {JSDOM}=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))('jsdom') as {JSDOM:new(html:string,options?:{url?:string;pretendToBeVisual?:boolean})=>{window:Window&typeof globalThis}}
  const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
  const saved=new Map<string,PropertyDescriptor|undefined>()
  for(const key of ['window','document','HTMLElement','HTMLCanvasElement','Node','navigator','localStorage','sessionStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT']){
   saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
   const raw=(dom.window as unknown as Record<string,unknown>)[key]
   const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:typeof raw==='function'&&key.includes('AnimationFrame')?(raw as (...args:unknown[])=>unknown).bind(dom.window):raw
   Object.defineProperty(globalThis,key,{configurable:true,value})
  }
  const host=document.getElementById('root')!
  const root=createRoot(host)
  const render=async(props:any)=>{await act(async()=>{root.render(createElement(LidarScanPanel,props))});await act(async()=>{(host.querySelector('[data-testid=camera-compare-open]') as HTMLButtonElement).click()})}
  try{await run(host,root,render)}
  finally{
   try{await act(async()=>root.unmount())}catch{/* 用例内已卸载 */}
   dom.window.close()
   for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
  }
 }
}

const scene={sceneId:'s',revision:1,entities:[]}
const world={worldId:'w',sceneId:'s',worldGeneration:1}
const identity={sceneId:'s',sceneRevision:1,worldId:'w',worldGeneration:1}
const receipt=(cameraName:string,captureId:string)=>({captureId,cameraName,resolvedCameraName:cameraName,sceneId:'s',sceneRevision:1,worldId:'w',generation:1,worldGeneration:1,rayCount:1,validCount:1})

/** 受控 API：每次 `camera-lidar` 调用都把 resolve/reject 交给用例，用来精确制造迟到回执。 */
function harness(cameraName='camera-a'){
 const pending:Pending[]=[],tasks:Promise<unknown>[]=[]
 const api:any={
  request:(_name:string,options:any)=>new Promise<unknown>((resolve,reject)=>pending.push({resolve,reject,signal:options?.signal})),
  mediaURL:(path:string,query:any)=>`/api/lyapunov/${path}?captureId=${query.captureId}`,
 }
 const base:any={api,scene,world,identity,ready:true,cameraName,cameraLabel:cameraName,tr,perform:(fn:()=>Promise<unknown>)=>{const task=fn();tasks.push(task);task.catch(()=>{})}}
 return {pending,tasks,base}
}
const scanButton=(host:HTMLElement)=>host.querySelector('[data-testid=compare-scan]') as HTMLButtonElement

test('正常完成：扫描成功后按钮重新可用',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 expect(pending.length).toBe(1)
 expect(scanButton(host).disabled).toBe(true)
 pending[0]!.resolve(receipt('camera-a','scan-a'))
 await act(async()=>{await tasks[0]})
 expect(scanButton(host).disabled).toBe(false)
 expect(scanButton(host).textContent).toBe('Scan LiDAR');expect(scanButton(host).getAttribute('title')).toContain('Cast native LiDAR rays at this mount')
}))

test('A 扫描未完成时切到 B：B 立即可操作，旧 A 迟到完成不改 B',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 expect(scanButton(host).disabled).toBe(true)
 await render({...base,cameraName:'camera-b',cameraLabel:'Camera B'})
 // 换机位后新来源立即可操作（原缺陷：B 永久 disabled 且显示 Casting native rays）。
 expect(scanButton(host).disabled).toBe(false)
 pending[0]!.resolve(receipt('camera-a','scan-a'))
 await act(async()=>{await tasks[0]})
 expect(scanButton(host).disabled).toBe(false)
 expect(host.textContent).not.toContain('Casting native rays')
}))

test('A1 未完成→B→A 再发起 A2：A1 迟到 finally 不得清掉 A2 的 busy',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 await render({...base,cameraName:'camera-b',cameraLabel:'Camera B'})
 await render(base)
 await act(async()=>{scanButton(host).click()})
 expect(pending.length).toBe(2)
 expect(scanButton(host).disabled).toBe(true)
 // 旧 A1 迟到完成：key 文字重新等于 A，但它已不属于当前 A2 请求。
 pending[0]!.resolve(receipt('camera-a','scan-a1'))
 await act(async()=>{await tasks[0]})
 expect(scanButton(host).disabled).toBe(true)
 expect(host.textContent).toContain('Casting native rays')
 // 当前 A2 完成后才恢复可操作。
 pending[1]!.resolve(receipt('camera-a','scan-a2'))
 await act(async()=>{await tasks[1]})
 expect(scanButton(host).disabled).toBe(false)
}))

test('旧机位迟到失败不得在新机位显示为当前错误',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 await render({...base,cameraName:'camera-b',cameraLabel:'Camera B'})
 pending[0]!.reject(new Error('late camera-a failure'))
 await act(async()=>{await tasks[0].catch(()=>{})})
 expect(host.querySelector('[role="alert"]')).toBeNull()
 expect(scanButton(host).disabled).toBe(false)
}))

test('当前操作失败如实显示错误并可再次操作',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 pending[0]!.reject(new Error('current failure'))
 await act(async()=>{await tasks[0].catch(()=>{})})
 const alert=host.querySelector('[role="alert"]')
 expect(alert?.textContent).toContain('current failure')
 expect(scanButton(host).disabled).toBe(false)
}))

/**
 * 与 `workbench.tsx::perform` 一致的错误消费者：任务拒绝进入工作台全局错误面。
 * 主控边界探针（`lidar-consumer-boundary-probe.tsx`）用它复现两项缺陷；这里以同一形状回归。
 */
function consumerHarness(cameraName='camera-a'){
 const pending:Pending[]=[],outerErrors:string[]=[]
 const api:any={request:(_name:string,options:any)=>new Promise<unknown>((resolve,reject)=>pending.push({resolve,reject,signal:options?.signal})),mediaURL:()=>'/media'}
 const base:any={api,scene,world,identity,ready:true,cameraName,cameraLabel:cameraName,tr,perform:(fn:()=>Promise<unknown>)=>{void fn().catch(error=>{outerErrors.push(String(error))})}}
 return {pending,outerErrors,base}
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))

test('API 对象变化但 world/机位 key 相同：新来源立即可操作，busy 不卡死',withDom(async(host,root,render)=>{
 const {pending,base}=consumerHarness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 expect(scanButton(host).disabled).toBe(true)
 // 换 API 对象（key 不变）：原缺陷是 busy 重置 effect 只依赖 key，新 API 来源永久 disabled。
 await render({...base,api:{...base.api}})
 expect(scanButton(host).disabled).toBe(false)
 expect(host.textContent).not.toContain('Casting native rays')
 pending[0]!.resolve(receipt('camera-a','scan-a'))
 await act(async()=>{await flush()})
}))

test('旧机位迟到失败不传播给当前 Workbench 错误消费者；当前失败仍如实传播',withDom(async(host,root,render)=>{
 const {pending,outerErrors,base}=consumerHarness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 await render({...base,cameraName:'camera-b',cameraLabel:'Camera B'})
 pending[0]!.reject(new Error('late camera-a failure'))
 await act(async()=>{await flush()})
 expect(outerErrors).toEqual([])
 // 当前操作的真实失败：既显示 local alert，也传到当前错误消费者。
 await act(async()=>{scanButton(host).click()})
 pending[1]!.reject(new Error('current failure'))
 await act(async()=>{await flush()})
 expect(outerErrors).toEqual(['Error: current failure'])
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('current failure')
}))

test('卸载中止在途请求并作废迟到回执',withDom(async(host,root,render)=>{
 const {pending,tasks,base}=harness()
 await render(base)
 await act(async()=>{scanButton(host).click()})
 const signal=pending[0]!.signal!
 expect(signal.aborted).toBe(false)
 await act(async()=>{root.unmount()})
 expect(signal.aborted).toBe(true)
 // 卸载后迟到回执不得再抛错或写状态。
 pending[0]!.resolve(receipt('camera-a','scan-a'))
 await act(async()=>{await tasks[0]})
}))
