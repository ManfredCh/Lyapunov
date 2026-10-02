import {test,expect} from "bun:test"
import {writeFile} from "node:fs/promises"
import {browserRuntimeFailure} from "@deepseek-ai/dsh-experimental-browser-use-runtime/src/mcp.ts"
import {BrowserRootObserver,type BrowserRootObservation} from "@deepseek-ai/dsh-experimental-browser-use-runtime/src/root-state.ts"
import {observeBrowserRoot,releaseBrowserRoots,type ObservedBrowser,type OwnedBrowserProcess} from "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp/src/owner-state.ts"
const phrase="Target page, context or browser has been closed"
const root=(overrides:Partial<BrowserRootObservation>={}):BrowserRootObservation=>({owner:"fixture",sequence:1,ownership:"session",rootConnected:true,targetAlive:false,processExited:false,...overrides})
test("复合关闭词组/CDP方法字样不能证明浏览器根断开",()=>{
  for(const message of [phrase,"Protocol error (Target.setDiscoverTargets): Target closed","Browser has been closed","browser process crashed"]){
    expect(browserRuntimeFailure(message)).toMatchObject({kind:"closure-unverified",recovery:"select-page"})
    expect(browserRuntimeFailure(message,root())).toMatchObject({kind:"page-closed",recovery:"select-page"})
  }
  expect(browserRuntimeFailure("Protocol error (Target.setDiscoverTargets): permission denied")).toBeUndefined()
  expect(browserRuntimeFailure(phrase,root({rootConnected:false}))).toMatchObject({kind:"browser-closed",recovery:"rebuild"})
  expect(browserRuntimeFailure(phrase,root({rootConnected:false,processExited:true,exitCode:0}))).toMatchObject({kind:"browser-closed",recovery:"rebuild"})
  expect(browserRuntimeFailure(phrase,root({rootConnected:false,processExited:true,exitCode:1}))).toMatchObject({kind:"browser-crashed",recovery:"rebuild"})
  expect(browserRuntimeFailure(phrase,root({rootConnected:false,ownership:"external"}))).toMatchObject({recovery:"blocked"})
})
test("launch/display/sandbox/profile/transport优先，不被根关闭短语粗重建",()=>{
  for(const [message,kind] of [["No usable sandbox","sandbox-unavailable"],["Missing X server","display-unavailable"],["SingletonLock","profile-in-use"],["Failed to launch browser","launch-failed"],["transport closed","transport-closed"]]){
    expect(browserRuntimeFailure(message+": "+phrase)).toMatchObject({kind,recovery:"blocked"})
    expect(browserRuntimeFailure(message+": "+phrase,root({rootConnected:false}))).toMatchObject({kind,recovery:"blocked"})
  }
})
test("代次唯一的私有元信息拒旧owner/退后sequence/释放未知；双owner隔离",async()=>{
  const a=await BrowserRootObserver.create(),b=await BrowserRootObserver.create()
  try{
    const ea=await a.begin(),eb=await b.begin()
    expect(ea.DSH_BROWSER_RUNTIME_OWNER).not.toBe(eb.DSH_BROWSER_RUNTIME_OWNER)
    expect(await a.read()).toBeUndefined()
    await writeFile(a.path,JSON.stringify(root({owner:eb.DSH_BROWSER_RUNTIME_OWNER})))
    expect(await a.read()).toBeUndefined()
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:3})))
    expect((await a.read())?.sequence).toBe(3)
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:2})))
    expect(await a.read()).toBeUndefined()
    await expect(a.verifyRelease()).rejects.toThrow("BROWSER_RELEASE_UNVERIFIED")
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:4,released:true,rootConnected:null,processExited:true})))
    await expect(a.verifyRelease()).rejects.toThrow("BROWSER_RELEASE_UNVERIFIED")
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:4,released:true,rootConnected:false,processExited:false})))
    await expect(a.verifyRelease()).rejects.toThrow("BROWSER_RELEASE_UNVERIFIED")
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:5,released:true,rootConnected:false,processExited:true})))
    await a.verifyRelease();expect(await b.read()).toBeUndefined()
    const old=a.beginOperation(),current=a.beginOperation()
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:6,operation:old})))
    expect(await a.readForOperation(current,5)).toBeUndefined()
    await writeFile(a.path,JSON.stringify(root({owner:ea.DSH_BROWSER_RUNTIME_OWNER,sequence:7,operation:current})))
    expect((await a.readForOperation(current,6))?.operation).toBe(current)
    await a.begin();expect(await a.read()).toBeUndefined()
  }finally{await a.dispose();await b.dispose()}
})
test("真实Browser结构 SPI读取connected/选页，而不是PID；外部只disconnect",async()=>{
  let closed=0,disconnected=0,exit!:(()=>void)
  const process:OwnedBrowserProcess={exitCode:null,signalCode:null,once:(_event,listener)=>{exit=listener},off:()=>{}}
  const browser:ObservedBrowser={connected:true,process:()=>process,close:async()=>{closed++;browser.connected=false;process.exitCode=0;exit()},disconnect:async()=>{disconnected++;browser.connected=false}}
  const context={browser,getSelectedMcpPage:()=>({pptrPage:{isClosed:()=>true}}),getPageById:()=>({pptrPage:{isClosed:()=>false}})}
  expect(observeBrowserRoot(context,browser)).toMatchObject({rootConnected:true,targetAlive:false,processExited:false})
  expect(observeBrowserRoot({...context,getSelectedMcpPage:()=>{throw new Error("not selected")}},browser).targetAlive).toBeNull()
  expect(observeBrowserRoot(undefined,{...browser,get connected():boolean{throw new Error("getter failed")},process:()=>{throw new Error("getter failed")}})).toMatchObject({rootConnected:null,processExited:null})
  expect(observeBrowserRoot(context,browser,7).targetAlive).toBe(true)
  expect(await releaseBrowserRoots([browser],false,20)).toBe(true);expect(closed).toBe(1)
  browser.connected=true
  expect(await releaseBrowserRoots([browser],true,20)).toBe(true);expect(disconnected).toBe(1);expect(closed).toBe(1)
})
test("自有Browser关闭拒绝/挂起或缺进程事实不得签释放",async()=>{
  const process:OwnedBrowserProcess={exitCode:null,signalCode:null,once:()=>{},off:()=>{}}
  const browser:ObservedBrowser={connected:false,process:()=>process,close:async()=>{throw new Error("release denied")},disconnect:async()=>{}}
  expect(await releaseBrowserRoots([browser],false,5)).toBe(false)
  browser.close=()=>new Promise(()=>{})
  expect(await releaseBrowserRoots([browser],false,5)).toBe(false)
  expect(await releaseBrowserRoots([{...browser,process:()=>null}],false,5)).toBe(false)
})
test("已退出的自有进程仍须确认旧根连接断开，不伪造connected=false",async()=>{
  const process:OwnedBrowserProcess={exitCode:0,signalCode:null,once:()=>{},off:()=>{}}
  let disconnects=0
  const browser:ObservedBrowser={connected:true,process:()=>process,close:async()=>{throw new Error("已退出不再close")},disconnect:async()=>{disconnects++}}
  expect(await releaseBrowserRoots([browser],false,5)).toBe(false);expect(browser.connected).toBe(true)
  browser.disconnect=async()=>{disconnects++;browser.connected=false}
  expect(await releaseBrowserRoots([browser],false,5)).toBe(true);expect(disconnects).toBe(2)
})
