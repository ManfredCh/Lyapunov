import {describe,expect,test} from "bun:test"
import {appSidePanelGeometry} from "../src/app-side.ts"
import {createRequire} from 'node:module'
import type {Context} from '@deepseek-ai/cordis'

describe("应用层工具面板的工作台边界",()=>{
 test("1070×863 窗口内的已知 Camera 点击点位于面板右侧",()=>{
  // 旧 GUI 真实按钮坐标；工作台右界取按钮左界作为保守夹具，不冒充实测工作台 DOMRect。
  const camera={x:919.078125,y:164,width:35,height:36.5},viewport={width:1070,height:863}
  const point={x:camera.x+camera.width/2,y:camera.y+camera.height/2}
  const legacy={left:viewport.width-44-300,right:viewport.width-44,top:0,bottom:viewport.height}
  expect(point.x>legacy.left&&point.x<legacy.right&&point.y>legacy.top&&point.y<legacy.bottom).toBe(true)
  const panel=appSidePanelGeometry({left:280, right:camera.x,top:38,bottom:572},viewport,300)
  const right=viewport.width-panel.right
  expect(right).toBeLessThanOrEqual(camera.x)
  expect(point.x).toBeGreaterThan(right)
  expect(panel).toEqual({top:38,right:150.921875,width:300,height:534})
 })

 test("正常宽度按工作台边界定位，保留工具轨的全部宽度",()=>{
  const viewport={width:1440,height:1000}
  for(const railWidth of [44,46,64]){
   const frame={left:400,right:1320-railWidth,top:60,bottom:900}
   const panel=appSidePanelGeometry(frame,viewport,300),right=viewport.width-panel.right
   expect(right).toBe(frame.right)
   expect(right-panel.width).toBeGreaterThanOrEqual(frame.left)
   expect(panel.top+panel.height).toBe(frame.bottom)
   expect(right).toBeLessThan(1320)
  }
 })

 test("窄工作面让面板收缩，不以最小宽度侵入工具轨或左侧区域",()=>{
  const frame={left:720,right:900,top:80,bottom:700}
  const panel=appSidePanelGeometry(frame,{width:1070,height:863},300)
  expect(panel.width).toBe(180)
  expect(1070-panel.right-panel.width).toBe(frame.left)
  expect(1070-panel.right).toBe(frame.right)
 })

 test("工作台超出窗口或尚未可见时不生成窗口外面板",()=>{
  expect(appSidePanelGeometry({left:-20,right:920,top:-10,bottom:900},{width:1070,height:863},300)).toEqual({top:0,right:150,width:300,height:863})
  expect(appSidePanelGeometry({left:1070,right:1250,top:0,bottom:0},{width:1070,height:863},300)).toEqual({top:0,right:0,width:0,height:0})
 })
})

test('执行图只注册原生标签，不新增整高 surface action 或默认打开',async()=>{
 const {applyExecutionGraphClient,EXECUTION_GRAPH_KIND}=await import('../src/execution-graph-client.tsx')
 type Tab={id:string;kind:string;priority?:string;title:()=>string;pinned?:boolean}
 const slots:string[]=[],tabs:Tab[]=[]
 let opened=0
 const ctx={
  effect:(fn:()=>unknown)=>fn(),locale:{register:()=>()=>{},bind:()=>((key:string)=>key)},
  sidebarRightTabs:{register:(value:Tab)=>{tabs.push(value);return()=>{}}},
  sidebarRight:{openTab:()=>{opened++}},
  slots:{inject:(name:string,fn:()=>unknown)=>{slots.push(name);return fn()},register:()=>()=>{}},
 } as unknown as Context
 applyExecutionGraphClient(ctx)
 expect(tabs).toEqual([{id:'@lyapunov/shell/execution-graph',kind:EXECUTION_GRAPH_KIND,priority:'builtin',title:expect.any(Function)}])
 expect(slots).toEqual(['sidebar.right.pane.tab'])
 expect(opened).toBe(0)
})

test('执行图与场景工具共享一个rail；文件页只在用户确认目录后请求切工作区',async()=>{
 const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
 const {JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 const globals=['window','document','navigator','HTMLElement','Event','MouseEvent','Node','localStorage','IS_REACT_ACT_ENVIRONMENT']
 for(const key of globals){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})}
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{act}=React
 const {ToolRail}=await import('../src/tool-rail.tsx'),{FilesNavigationActions}=await import('../src/files-navigation-client.tsx')
 const host=document.getElementById('root')!,root=createRoot(host),controller=new AbortController()
 let graphOpened=0,sceneOpened=0
 const adopted:string[]=[]
 type Flow=import('@deepseek-ai/dsh-client-ui-slots').PropsRuntime<'sidebar.right.tab.files.directoryFlow'>
 let flow:Flow|undefined
 // 夹具只驱动本组件声明的一个座位；框架的泛型 key/备用分支不参与这次渲染。
 const renderSlot=((_name:string,owner:Flow)=>{flow=owner;return owner.open?React.createElement('button',{onClick:()=>owner.onPicked('/tmp/selected-workspace')},'作为工作区打开'):null}) as Parameters<typeof FilesNavigationActions>[0]['renderSlot']
 const dictionary={browse:'浏览电脑目录',workspace:'当前工作区',hint:'浏览按电脑用户权限；确认后打开工作区。',unavailable:'目录选择不可用',error:'无法打开工作区：'}
 try{
  await act(async()=>{root.render(React.createElement(React.Fragment,null,
   React.createElement(ToolRail,{tr:zh=>zh,nativeSceneActive:false,openGraph:()=>{graphOpened++},revealScene:()=>{sceneOpened++}}),
   // 这条DOM夹具不读取框架提供的全局Session/Workspace hooks，直接驱动实际使用的owner份额。
   React.createElement(FilesNavigationActions,{sessionId:'current',absolutePath:'/tmp/private/child',rootPath:'/tmp/private',signal:controller.signal,openResource:()=>{},renderSlot,t:(key:string)=>dictionary[key as keyof typeof dictionary]??key,openWorkspaceDirectory:async(path:string)=>{adopted.push(path)}} as unknown as Parameters<typeof FilesNavigationActions>[0]),
  ))})
  const graph=host.querySelector<HTMLButtonElement>('button[aria-label="执行图"]')!
  expect(graph.closest('nav[aria-label="工作台工具"]')).not.toBeNull()
  expect(host.querySelectorAll('nav[aria-label="工作台工具"]')).toHaveLength(1)
  await act(async()=>{graph.click()})
  expect(graphOpened).toBe(1);expect(sceneOpened).toBe(0)
  expect(host.textContent).toContain('/tmp/private')
  expect(flow?.open).toBe(false);expect(adopted).toEqual([])
  await act(async()=>{[...host.querySelectorAll('button')].find(button=>button.textContent==='浏览电脑目录')!.click()})
  expect(flow?.initialPath).toBe('/tmp/private/child');expect(flow?.open).toBe(true);expect(adopted).toEqual([])
  await act(async()=>{[...host.querySelectorAll('button')].find(button=>button.textContent==='作为工作区打开')!.click()})
  expect(adopted).toEqual(['/tmp/selected-workspace']);expect(flow?.open).toBe(false)
 }finally{
  await act(async()=>root.unmount());dom.window.close()
  for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
 }
})
