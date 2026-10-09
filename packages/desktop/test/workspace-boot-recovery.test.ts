import {expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {watchWorkspaceBoot,mountWorkspaceBootFailure,safeWorkspaceBootDetail} from '../src/workspace-boot-recovery.ts'

const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
const {JSDOM}=sdkRequire('jsdom')
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))

async function inDocument(run:(document:Document,window:any)=>Promise<void>){
 const dom=new JSDOM('<body><div data-dsh-boot><span data-dsh-boot-spinner></span></div></body>',{url:'http://127.0.0.1:12345'})
 const previous=Object.getOwnPropertyDescriptor(globalThis,'MutationObserver')
 Object.defineProperty(globalThis,'MutationObserver',{value:dom.window.MutationObserver,configurable:true})
 try{await run(dom.window.document,dom.window)}finally{dom.window.close();if(previous)Object.defineProperty(globalThis,'MutationObserver',previous);else Reflect.deleteProperty(globalThis,'MutationObserver')}
}

test('shell失败时独立于shell呈现返回登录；详情折叠，原生按钮调用有效',()=>inDocument(async document=>{
 let failed=0,returned=0,retried=0,ready=0
 const stop=watchWorkspaceBoot(document,{locale:async()=>'en',failed:()=>{failed++},ready:()=>{ready++},retry:async()=>{retried++},returnToLogin:async()=>{returned++}})
 expect(document.querySelector('[data-lyapunov-workspace-failure]')).toBeNull()
 document.querySelector('[data-dsh-boot]')!.textContent='HARNESS Failed to load plugins @lyapunov/shell web boot: 1 entry did not activate'
 await tick()
 expect(failed).toBe(1);expect(ready).toBe(0)
 expect(document.querySelector('[data-lyapunov-workspace-failure]')).not.toBeNull()
 expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(false)
 ;(document.querySelector('[data-lyapunov-return-to-login]') as HTMLButtonElement).click();await tick()
 expect(returned).toBe(1);expect(retried).toBe(0)
 document.body.append(document.createElement('span'));await tick();expect(failed).toBe(1)
 stop()
}))

test('只有见过boot正常dispose才回报ready；pagehide清理且后续DOM不再观察',()=>inDocument(async(document,window)=>{
 let ready=0,failed=0
 const stop=watchWorkspaceBoot(document,{locale:async()=>'zh',failed:()=>{failed++},ready:()=>{ready++},retry:async()=>{},returnToLogin:async()=>{}})
 document.querySelector('[data-dsh-boot]')!.remove();await tick();expect(ready).toBe(1);expect(failed).toBe(0)
 const other=document.createElement('div');other.dataset.dshBoot='';other.textContent='web boot: failure';document.body.append(other);await tick();expect(ready).toBe(1);expect(failed).toBe(0)
 window.dispatchEvent(new window.Event('pagehide'));stop()
}))

test('失败重试走原生入口；拒绝后保可操作返回，诊断令牌脱敏',()=>inDocument(async document=>{
 let retries=0
 const remove=mountWorkspaceBootFailure(document,'web boot: failed https://fixture.invalid/?token=private-fixture',{locale:async()=>'zh',failed:()=>{},retry:async()=>{retries++;throw Error('重试未完成')},returnToLogin:async()=>{}})
 await tick();expect(document.body.textContent).toContain('返回登录');expect(document.body.textContent).not.toContain('private-fixture')
 ;(document.querySelector('[data-lyapunov-workspace-retry]') as HTMLButtonElement).click();await tick()
 expect(retries).toBe(1);expect((document.querySelector('[data-lyapunov-return-to-login]') as HTMLButtonElement).disabled).toBe(false)
 expect(safeWorkspaceBootDetail('Bearer test-credential')).toBe('Bearer [redacted]');remove()
}))

// 运行原主进程的切页函数和回调；不启动 Electron、不碰账户或 Host。
const desktopMain=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8')
function mainCallback(prefix:string,suffix:string,names:string[],values:unknown[]){
 const start=desktopMain.indexOf(prefix),end=desktopMain.indexOf(suffix,start+prefix.length)
 expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start)
 return new Function(...names,desktopMain.slice(start,end))(...values)
}

test('返回登录和显式返回工作台均将键盘交给当前可见 WebContents',async()=>{
 const calls:string[]=[]
 const account={getURL:()=> 'account://existing',focus:()=>calls.push('account-page')}
 const workspace={focus:()=>calls.push('workspace-page')}
 const target={webContents:account,loadFile:async()=>{calls.push('load-account')},show:()=>calls.push('show-window'),focus:()=>calls.push('focus-window')}
 const body=desktopMain.slice(desktopMain.indexOf('async function showAccount(){'),desktopMain.indexOf('async function openWorkspace'))
 const run=new Function('controller','detachWorkspaceView','ensureWindow','accountURL','renderer',body+';return showAccount;')(undefined,()=>calls.push('detach-workspace'),async()=>target,'account://existing','account.html')
 await run()
 expect(calls).toEqual(['detach-workspace','show-window','focus-window','account-page'])
 calls.length=0
 let workspaceAction:(()=>Promise<void>)|undefined
 mainCallback('  handle("workspace",', '\n  handle("show-account",',
  ['handle','host','ensureWindow','attachWorkspaceView','workspaceView'],
  [(_name:string,action:()=>Promise<void>)=>{workspaceAction=action},{},async()=>target,()=>calls.push('attach-workspace'),{webContents:workspace}])
 await workspaceAction!()
 expect(calls).toEqual(['attach-workspace','show-window','focus-window','workspace-page'])
})

test('异步工作台加载完成只在同一可见且已聚焦窗口交接，不从其它应用夺焦点',async()=>{
 const start=desktopMain.indexOf('    try{signal?.throwIfAborted();await contents.loadURL(started.url);')
 const end=desktopMain.indexOf('    void started.exited',start)
 const code=desktopMain.slice(start,end)
 const run=new Function('signal','contents','started','viewAttached','workspaceView','target','dispose',
  'return (async()=>{'+code+'})();')
 let focuses=0,windowFocuses=0,loaded=0
 const contents={loadURL:async()=>{loaded++},focus:()=>{focuses++}}
 const target={isFocused:()=>true,focus:()=>{windowFocuses++}}
 await run(undefined,contents,{url:'http://127.0.0.1/'},true,{webContents:contents},target,async()=>{})
 expect(loaded).toBe(1);expect(focuses).toBe(1);expect(windowFocuses).toBe(0)
 await run(undefined,contents,{url:'http://127.0.0.1/'},true,{webContents:contents},{...target,isFocused:()=>false},async()=>{})
 await run(undefined,contents,{url:'http://127.0.0.1/'},false,{webContents:contents},target,async()=>{})
 expect(focuses).toBe(1);expect(windowFocuses).toBe(0)
})

test('第二次正常启动仅聚焦既有窗口中当前可见页，不新建工作台',async()=>{
 let action:(()=>void)|undefined
 const calls:string[]=[]
 const target={show:()=>calls.push('show-window'),focus:()=>calls.push('focus-window'),webContents:{focus:()=>calls.push('account-page')}}
 mainCallback('  app.on("second-instance",','\n  app.on("activate",',
  ['app','ensureWindow','viewAttached','workspaceView'],
  [{on:(_name:string,handler:()=>void)=>{action=handler}},async()=>target,true,{webContents:{focus:()=>calls.push('workspace-page')}}])
 action!();await tick()
 expect(calls).toEqual(['show-window','focus-window','workspace-page'])
})

test('窗口真实重新激活后恢复可见工作台键盘焦点；隐藏或已卸载页不参与',()=>{
 const start=desktopMain.indexOf('  created.on("focus",')
 const end=desktopMain.indexOf('\n',start)
 expect(start).toBeGreaterThanOrEqual(0)
 const code=desktopMain.slice(start,end)
 let current:()=>void=()=>{}
 let focuses=0
 const workspace={webContents:{isDestroyed:()=>false,focus:()=>{focuses++}}}
 const bind=new Function('created','viewAttached','workspaceView',code)
 const created={on:(name:string,callback:()=>void)=>{expect(name).toBe('focus');current=callback}}
 bind(created,true,workspace)
 expect(focuses).toBe(0)
 current();expect(focuses).toBe(1)
 bind(created,false,workspace);current()
 bind(created,true,{webContents:{...workspace.webContents,isDestroyed:()=>true}});current()
 expect(focuses).toBe(1)
})
