import {app,BrowserWindow,WebContentsView,ipcMain,safeStorage,shell,dialog,Menu} from "electron"
import type {WebContents} from "electron"
import {randomUUID} from "node:crypto"
import {ExitCoordinator,type ExitOrigin,type ExitSummary} from "./exit-coordinator.ts"
import Store from "electron-store"
import windowState from "electron-window-state"
import updater from "electron-updater"
import {appendFile,mkdir,writeFile} from "node:fs/promises"
import {existsSync,mkdirSync} from "node:fs"
import {dirname,join,resolve} from "node:path"
import {pathToFileURL} from "node:url"
import {startWebHost,type HostHandle} from "../../../script/host.ts"
import {PRODUCT_ROOT} from "../../../script/profile.ts"
import {readEnginePreference} from "../../../script/engine-preference.ts"
import {RuntimeOwner,readRuntimeEnv} from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import {createAccountSessionStore,ACCOUNT_SESSION_KEY,ACCOUNT_SESSION_STORE,ACCOUNT_SESSION_MIGRATION_KEY,LEGACY_ACCOUNT_SESSION_STORE,migrateLegacyAccountSession} from "./account-session-store.ts"
import {DesktopAccountController} from "./account-controller.ts"
import {resolveAccountApiUrl} from '../../lyapunov-product-bundle/src/account/url.ts'
import {applySoftwareGlSwitches} from "./software-rendering.ts"
import {resolveDesktopDataRoot} from "./data-root.ts"
import {classifyStartupFailure,planRestartRecovery,readWorkspaceRecords,resolveWorkspaceHostMode} from "./restart-recovery.ts"
import {LOCAL_IMPORT_FILE_FILTERS} from "../../lyapunov-shell/src/local-file-import.ts"
import {desktopExitDialog,desktopExitFailureDialog,desktopShortcut,desktopWindowTitle} from "./window-chrome.ts"
import {accountLocale,DesktopLocaleMirror,desktopLocales,SUPPORT_MAILTO} from "./account-locales.ts"

const mode=process.argv.includes("--developer")?"developer":"formal"
if(mode==="developer"&&(app.isPackaged||process.env.NODE_ENV==="production"))throw new Error("发行构建不允许开发模式")
app.setName("LyapunovDSH")
// 与发行.desktop及既有X11 class对齐；不改app名称或用户数据路径。
if(process.platform==="linux")app.setDesktopName("lyapunov-desktop.desktop")
// 环境文件里常见的空值必须回落到平台默认数据目录；否则 resolve("") 会把数据根变成当前工作目录。
const configuredDataRoot=readRuntimeEnv(process.env,"desktopDataDir")?.trim()
const dataRoot=resolveDesktopDataRoot({configured:configuredDataRoot,packaged:app.isPackaged,defaultUserData:app.getPath("userData"),productRoot:PRODUCT_ROOT,mode})
mkdirSync(dataRoot,{recursive:true})
app.setPath("userData",dataRoot)
if(process.argv.includes("--software-rendering"))applySoftwareGlSwitches()
const diagnosticsArg=process.argv.find(value=>value.startsWith("--acceptance-output="))
const diagnostics=!app.isPackaged&&diagnosticsArg?resolve(diagnosticsArg.slice("--acceptance-output=".length)):undefined
const owner=new RuntimeOwner()
const localeMirror=new DesktopLocaleMirror(accountLocale(app.getLocale())??"en")
let workspaceView:WebContentsView|undefined,viewAttached=false,workspaceMode:"formal"|"developer"|"guest"|undefined
let win:BrowserWindow|undefined,host:HostHandle|undefined,controller:DesktopAccountController|undefined,quitting=false,recovering=false,startupFinished=false
const renderer=join(import.meta.dirname,"../renderer/index.html")
const preload=join(import.meta.dirname,"preload.cjs")
// src/ 和 dist/ 均以 ../icons 解析发行包内的既有品牌资源。
const icons=join(import.meta.dirname,"../icons")
const windowIcon=process.platform==="win32"?join(icons,"lyapunov.ico"):join(icons,"lyapunov.png")
const dockIcon=join(icons,"lyapunov.png")
const accountURL=pathToFileURL(renderer).href
const incidentFile=join(dataRoot,"desktop-incidents.jsonl")
const safeIncidentUrl=(raw:string)=>{try{const parsed=new URL(raw);return `${parsed.origin}${parsed.pathname}`}catch{return "unparseable"}}
const recordIncident=(kind:string,details:Record<string,unknown>={})=>{void appendFile(incidentFile,JSON.stringify({kind,...details,time:new Date().toISOString()})+"\n").catch(error=>console.error("桌面事件回执写入失败：",error instanceof Error?error.message:String(error)))}
// 唯一支持邮箱例外：只放行精确的 mailto:voryneltech@gmail.com；其他收件人、query 或 body 一律拒绝，其余协议限制不变。
const openExternal=async(raw:string)=>{if(raw===SUPPORT_MAILTO){await shell.openExternal(SUPPORT_MAILTO);return}const url=new URL(raw);if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw new Error("不支持的外部地址");await shell.openExternal(url.href)}
// 正式账户仍登录先行；游客仅由可信显式按钮或 --guest 进入独立无模型身份。
// 未登录/已退出/会话失效不自动回落到游客 Host。
const allowed=(url:string)=>url===accountURL||(host!==undefined&&new URL(url).origin===host.origin)
function syncWindowTitle(){
 if(!win||win.isDestroyed())return
 const contents=viewAttached&&workspaceView?workspaceView.webContents:win.webContents
 win.setTitle(desktopWindowTitle(contents.getTitle(),localeMirror.getSnapshot().active,viewAttached&&workspaceMode==="guest"))
}
function syncApplicationMenu(){
 const t=desktopLocales[localeMirror.getSnapshot().active]
 Menu.setApplicationMenu(process.platform==="darwin"?Menu.buildFromTemplate([{label:"Lyapunov",submenu:[{label:t.account,enabled:mode==="formal",click:()=>void showAccount()},{label:t.quit,click:()=>void exits.request("menu")}]},{label:t.edit,submenu:[{role:"undo",label:t.undo},{role:"redo",label:t.redo},{type:"separator"},{role:"cut",label:t.cut},{role:"copy",label:t.copy},{role:"paste",label:t.paste},{role:"selectAll",label:t.selectAll}]},{label:t.view,submenu:[{role:"reload",label:t.reload},{role:"togglefullscreen",label:t.fullscreen},...(mode==="developer"&&!app.isPackaged?[{role:"toggleDevTools" as const,label:t.devtools}]:[])]}]):null)
}
function configure(target:BrowserWindow,contents:WebContents=target.webContents){
  contents.on("page-title-updated",(event,title)=>{event.preventDefault();if(contents!==(viewAttached?workspaceView?.webContents:target.webContents))return;target.setTitle(desktopWindowTitle(title,localeMirror.getSnapshot().active,viewAttached&&workspaceMode==="guest"))})
  if(process.platform!=="darwin")contents.on("before-input-event",(event,input)=>{
    const action=desktopShortcut(input,mode==="developer"&&!app.isPackaged)
    if(!action)return
    event.preventDefault()
    if(action==="fullscreen")target.setFullScreen(!target.isFullScreen())
    else if(action==="close")void exits.request("shortcut")
    else if(action==="quit")void exits.request("shortcut")
    else if(action==="devtools")contents.toggleDevTools()
    else contents[action]()
  })
  contents.setWindowOpenHandler(({url})=>{void openExternal(url).catch(()=>{});return {action:"deny"}})
  contents.on("will-navigate",(event,url)=>{if(!allowed(url)){event.preventDefault();void openExternal(url).catch(()=>{})}})
  contents.on("did-fail-load",(_event,errorCode,errorDescription,validatedURL,isMainFrame)=>recordIncident("did-fail-load",{errorCode,errorDescription,url:safeIncidentUrl(validatedURL),isMainFrame}))
  contents.on("render-process-gone",(_event,details)=>recordIncident("render-process-gone",{reason:details.reason,exitCode:details.exitCode,url:safeIncidentUrl(contents.getURL())}))
  contents.on("unresponsive",()=>recordIncident("unresponsive",{url:safeIncidentUrl(contents.getURL())}))
  contents.on("responsive",()=>recordIncident("responsive",{url:safeIncidentUrl(contents.getURL())}))
  if(diagnostics)contents.once("did-finish-load",()=>{
    setTimeout(()=>{void(async()=>{
      if(target.isDestroyed())return
      await mkdir(diagnostics,{recursive:true})
      // 回执先落盘，截图后补：GPU/合成器不可用时 `capturePage()` 会抛（本机 mesa 就抛 UnknownVizError），
      // 把两者绑在一条 await 链上会让**整份回执**跟着丢——诊断数据的价值不该由截图成败决定。
      // Electron43运行时提供此只读诊断方法，发行d.ts未声明；仅本机构建采集使用。
      const preferences=(contents as unknown as {getLastWebPreferences():{contextIsolation?:boolean;nodeIntegration?:boolean;sandbox?:boolean}}).getLastWebPreferences()
      await writeFile(join(diagnostics,"shell.json"),JSON.stringify({mode,title:target.getTitle(),url:new URL(contents.getURL()).origin,visible:target.isVisible(),electron:process.versions.electron,chrome:process.versions.chrome,hostPid:host?.pid,
        // 桌面入口自己的引擎回执：`engine/engineSource/engineReason` 是**这次实际装配**的那一份
        // （HostHandle.engine，与 Host 进程里回写的 LYAPUNOV_SIM_ENGINE 同源），
        // `enginePreference` 是**已在偏好文件里保存的**值。两者是不同读回值，不能互相顶替：
        // 保存偏好只影响下次启动，当前 Host 不会因它换引擎。
        engine:host?.engine.engine??null,engineSource:host?.engine.source??null,engineReason:host?.engine.reason??null,enginePreference:readEnginePreference()??null,
        webPreferences:{contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration,sandbox:preferences.sandbox},time:new Date().toISOString()},null,2))
      try{const image=await contents.capturePage();await writeFile(join(diagnostics,"shell.png"),image.toPNG())}
      catch(error){console.error("桌面截图失败（回执已落盘）：",error instanceof Error?error.message:String(error))}
    })().catch(error=>console.error("桌面诊断写入失败：",error instanceof Error?error.message:String(error)))},1500)
  })
}
// 账户页可以隐藏工作台；退出仍向持有草稿和动作的工作台 owner 请求清理。
function exitOwnerContents(){return host&&workspaceView&&!workspaceView.webContents.isDestroyed()?workspaceView.webContents:win?.webContents}
const exitReplies=new Map<string,{sender:WebContents;phase:string;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
function rendererExit(phase:"summary"|"flush"|"stop"):Promise<any>{
  const contents=exitOwnerContents()
  if(!contents||contents.isDestroyed())return phase==="summary"?Promise.resolve(undefined):Promise.reject(new Error(desktopLocales[localeMirror.getSnapshot().active].rendererUnavailable))
  const id=randomUUID()
  return new Promise((resolveReply,reject)=>{
    const timer=setTimeout(()=>{exitReplies.delete(id);reject(new Error(desktopLocales[localeMirror.getSnapshot().active].rendererTimeout.replace("{phase}",phase)))},phase==="summary"?3000:15000)
    exitReplies.set(id,{sender:contents,phase,resolve:resolveReply,reject,timer})
    contents.send("lyapunov:exit-request",{id,phase})
  })
}
const exits=new ExitCoordinator({
  summary:async()=>{try{const value=await rendererExit("summary");return host&&!value?.participants?undefined:value as ExitSummary|undefined}catch{return undefined}},
  confirm:async(summary)=>{
    const options=desktopExitDialog(localeMirror.getSnapshot().active,summary)
    return (await (win&&!win.isDestroyed()?dialog.showMessageBox(win,options):dialog.showMessageBox(options))).response===1
  },
  stateChanged:committing=>{for(const contents of [win?.webContents,workspaceView?.webContents])if(contents&&!contents.isDestroyed())contents.send("lyapunov:exit-state",committing)},
  flush:async()=>{if(!host)return;await rendererExit("flush");exitOwnerContents()?.session.flushStorageData()},
  stop:async()=>{controller?.cancelLogin();if(host)await rendererExit("stop")},
  close:()=>owner.close(),
  exit:(origin,force)=>{quitting=true;if(force){recordIncident("exit-forced",{origin,code:"EXIT_CLEANUP_UNCONFIRMED"});try{disposeWorkspaceView()}finally{app.exit(0)}return}disposeWorkspaceView();if(origin==="update")updater.autoUpdater.quitAndInstall();else app.quit()},
  failed:async(error,origin,forced)=>{
    const message=error instanceof Error?error.message:String(error)
    recordIncident("exit-failed",{origin,code:"EXIT_CLEANUP_UNCONFIRMED"})
    if(forced||origin==="system"||origin==="startup-error"){console.error("退出清理未确认：",message);return}
    const options=desktopExitFailureDialog(localeMirror.getSnapshot().active,message)
    const {response}=await(win&&!win.isDestroyed()?dialog.showMessageBox(win,options):dialog.showMessageBox(options))
    return response===2?"force":response===1?"retry":"return"
  },
})
function detachWorkspaceView(){if(workspaceView&&viewAttached&&win&&!win.isDestroyed()){win.contentView.removeChildView(workspaceView);viewAttached=false;syncWindowTitle()}}
function disposeWorkspaceView(){detachWorkspaceView();workspaceView?.webContents.close({waitForBeforeUnload:false});workspaceView=undefined;workspaceMode=undefined}
function fitWorkspaceView(){if(workspaceView&&win&&!win.isDestroyed()){const {width,height}=win.getContentBounds();workspaceView.setBounds({x:0,y:0,width,height})}}
function attachWorkspaceView(){if(!workspaceView||!win)return;if(!viewAttached){win.contentView.addChildView(workspaceView);viewAttached=true}fitWorkspaceView();syncWindowTitle()}
async function ensureWindow(){
  if(win&&!win.isDestroyed())return win
  const state=windowState({defaultWidth:1440,defaultHeight:960,path:dataRoot,file:"window-state.json"})
  const created=new BrowserWindow({x:state.x,y:state.y,width:state.width,height:state.height,title:"Lyapunov",icon:windowIcon,show:true,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,partition:`persist:${mode}-desktop`}})
  win=created;configure(created);state.manage(created)
  created.on("close",event=>{if(exits.approved)return;event.preventDefault();void exits.request("window")})
  created.on("resize",fitWorkspaceView)
  if(process.platform==="win32"){created.on("query-session-end",()=>void exits.request("system"));created.on("session-end",()=>void exits.request("system"))}
  created.on("closed",()=>{if(win===created)win=undefined})
  return created
}
async function showAccount(){
  if(controller&&["guest","guest-starting"].includes(controller.view().status)){await controller.leaveGuest()}
  detachWorkspaceView()
  const target=await ensureWindow()
  if(target.webContents.getURL()!==accountURL)await target.loadFile(renderer)
  target.show();target.focus()
}
async function openWorkspace(account?:Parameters<typeof startWebHost>[0]["account"],signal?:AbortSignal,requestedMode:"formal"|"developer"|"guest"=mode){
  await owner.switch(async()=>{
    // 正式模式必须先持有已通过 /v1/me 验证的账户；缺账户时抛错，绝不回落到匿名本地 Host。
    const hostMode=requestedMode==="guest"?"guest":resolveWorkspaceHostMode(requestedMode,account)
    // 引擎不在这里写死（原缺省是 none）：交给 Host 端的共享解析，桌面不再自己算一个值。
    const started=await startWebHost({mode:hostMode,account,accountApiUrl:hostMode==="formal"?resolveAccountApiUrl({configured:readRuntimeEnv(process.env,"apiUrl"),dev:false}):undefined,signal,runtimeRoot:join(dataRoot,"runtime"),grasp:(readRuntimeEnv(process.env,"graspProvider")?.trim()||"analytic") as "none"|"analytic"|"graspgenx"|"anygrasp"})
    const target=await ensureWindow()
    host=started;workspaceMode=hostMode
    const partition=hostMode==="formal"?`persist:lyapunov-account-${started.identity}`:`persist:lyapunov-${hostMode}`
    workspaceView=new WebContentsView({webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,partition}})
    configure(target,workspaceView.webContents);attachWorkspaceView()
    const contents=workspaceView.webContents
    let disposing=false
    const dispose=async()=>{disposing=true;await started.stop();if(host===started){host=undefined;disposeWorkspaceView()}}
    const abort=()=>{void dispose()};signal?.addEventListener("abort",abort,{once:true})
    try{signal?.throwIfAborted();await contents.loadURL(started.url);signal?.throwIfAborted()}catch(error){await dispose();throw error}
    void started.exited.then(async()=>{
      if(disposing||quitting||host!==started)return
      recovering=true
      await dispose()
      if(host||quitting){recovering=false;return}
      if(hostMode==="formal"||hostMode==="guest"){
        // Host 异常退出后回到同一窗口的登录页；会话可能已失效，由用户在登录页重连或重新登录。
        controller?.hostStopped()
        await showAccount().catch(error=>console.error("返回登录页失败：",error instanceof Error?error.message:String(error)))
      }
      else{
        // 原生记录只提供恢复建议；openWorkspace 尚未接收计划目标，不承诺自动打开该会话。
        const plan=planRestartRecovery(readWorkspaceRecords(join(dataRoot,"runtime"),mode))
        const target=plan.action==="open-session"?`会话 ${plan.sessionId}（工作区 ${plan.workspaceId}）`:plan.action==="open-workspace"?`工作区 ${plan.workspaceId}（未锁定会话）`:"工作区选择"
        const result=await dialog.showMessageBox({type:"error",title:"Lyapunov",message:"工作台进程已退出",detail:`重新连接将重启工作台。根据原生记录，建议打开：${target}；此目标尚未自动应用，请在工作台中确认选择。依据：${plan.reason}${plan.downgrades.length?`；降级：${plan.downgrades.join("；")}`:""}。机器人动作不会自动重发。`,buttons:["重新连接","退出"],cancelId:1})
        if(result.response===0)await openWorkspace();else app.quit()
      }
      recovering=false
    }).catch(error=>{recovering=false;console.error("工作台恢复失败：",error.message)})
    return async()=>{signal?.removeEventListener("abort",abort);await dispose()}
  })
}
function trusted(event:Electron.IpcMainInvokeEvent){
  if(!win||(event.sender!==win.webContents&&event.sender!==workspaceView?.webContents)||event.senderFrame!==event.sender.mainFrame)throw new Error("IPC_ORIGIN_REJECTED")
  if(!allowed(event.senderFrame.url))throw new Error("IPC_ORIGIN_REJECTED")
}
function handle(name:string,handler:(...args:any[])=>unknown){ipcMain.handle("lyapunov:"+name,(event,...args)=>{trusted(event);return handler(...args)})}
ipcMain.on("lyapunov:exit-response",(event,response)=>{
  try{trusted(event as Electron.IpcMainInvokeEvent)}catch{return}
  const pending=exitReplies.get(response?.id)
  if(!pending||pending.sender!==event.sender||pending.phase!==response.phase)return
  clearTimeout(pending.timer);exitReplies.delete(response.id)
  if(response.ok===true)pending.resolve(response.value);else pending.reject(new Error(typeof response.message==="string"?response.message:desktopLocales[localeMirror.getSnapshot().active].participantUnconfirmed))
})
ipcMain.on('lyapunov:workspace-client-failed',(event,report)=>{
  try{trusted(event as Electron.IpcMainInvokeEvent)}catch{return}
  if(event.sender!==workspaceView?.webContents||typeof report?.detail!=='string')return
  const detail=report.detail.slice(0,8192).replace(/([?&](?:token|access_token|api_key|key)=)[^\s&]+/gi,'$1[redacted]')
  recordIncident('workspace-client-failed',{url:safeIncidentUrl(event.senderFrame!.url),detail})
  controller?.workspaceFailed(localeMirror.getSnapshot().active==='zh'?'工作台界面未能加载，可重试或返回登录页。':'The workspace could not load. Retry or return to sign-in.')
})
ipcMain.on('lyapunov:workspace-client-ready',event=>{
  try{trusted(event as Electron.IpcMainInvokeEvent)}catch{return}
  if(event.sender===workspaceView?.webContents)controller?.workspaceReloaded()
})
function requireController(){if(!controller)throw new Error("开发模式不访问正式账户");return controller}
void app.whenReady().then(async()=>{
if(!app.requestSingleInstanceLock()){app.quit()}else{
  if(process.platform==="darwin")app.dock?.setIcon(dockIcon)
  if(mode==="formal"){
    let savedSessions:ReturnType<typeof createAccountSessionStore>|undefined
    const accountSessions=()=>{
      if(savedSessions)return savedSessions
    const canonicalFileExisted=existsSync(join(dataRoot,`${ACCOUNT_SESSION_STORE}.json`))
    const store=new Store<Record<string,unknown>>({name:ACCOUNT_SESSION_STORE,cwd:dataRoot})
    const legacyStore=new Store<Record<string,unknown>>({name:LEGACY_ACCOUNT_SESSION_STORE,cwd:dataRoot})
    migrateLegacyAccountSession({
      canonical:{
        read:()=>store.get(ACCOUNT_SESSION_KEY),
        fileExisted:canonicalFileExisted,
        replace:value=>store.set(ACCOUNT_SESSION_KEY,value),
        readMarker:()=>store.get(ACCOUNT_SESSION_MIGRATION_KEY),
        writeMarker:()=>store.set(ACCOUNT_SESSION_MIGRATION_KEY,true),
      },
      legacy:{read:()=>legacyStore.get(ACCOUNT_SESSION_KEY)},
    })
    const sessions=createAccountSessionStore({safeStorage,storage:{read:()=>store.get(ACCOUNT_SESSION_KEY),replace:v=>store.set(ACCOUNT_SESSION_KEY,v),replaceIfCurrent:(expected,value)=>{if(store.get(ACCOUNT_SESSION_KEY)!==expected)return false;store.set(ACCOUNT_SESSION_KEY,value);return true},delete:()=>store.delete(ACCOUNT_SESSION_KEY)}})
      savedSessions=sessions
      return sessions
    }
    // 游客冷入口不打开账户存储；登录/恢复时才访问同一真实 store。
    const lazySessions={get:()=>accountSessions().get(),set:(value:string)=>accountSessions().set(value),delete:()=>accountSessions().delete()}
    controller=new DesktopAccountController({apiUrl:resolveAccountApiUrl({configured:readRuntimeEnv(process.env,"apiUrl"),dev:false}),store:lazySessions,openExternal,startHost:openWorkspace,startGuestHost:signal=>openWorkspace(undefined,signal,"guest"),stopHost:()=>owner.close(),changed:state=>{if(win&&!win.isDestroyed())win.webContents.send("lyapunov:account-changed",state);if(state.status==="signed-out"&&startupFinished&&!quitting)void showAccount().catch(error=>console.error("返回登录页失败：",error instanceof Error?error.message:String(error)))}})
  }
  handle("mode",()=>workspaceMode??mode);handle("guest",()=>requireController().enterGuest());handle("version",()=>app.getVersion());handle("account-state",()=>controller?.view()??{status:"signed-out"})
  handle("ui-locale",()=>localeMirror.getSnapshot())
  ipcMain.handle("lyapunov:set-ui-locale",(event,value,userChoice=false)=>{
    trusted(event)
    if(value!=="zh"&&value!=="en")throw new Error("UI_LOCALE_INVALID")
    const previous=localeMirror.getSnapshot(),next=localeMirror.report(value,event.sender===workspaceView?.webContents?"workspace":"account",userChoice===true)
    if(next!==previous){for(const contents of [win?.webContents,workspaceView?.webContents])if(contents&&!contents.isDestroyed())contents.send("lyapunov:locale-changed",next);syncWindowTitle();syncApplicationMenu()}
  })
  handle("login",()=>{void requireController().login()});handle("cancel-login",()=>requireController().cancelLogin());handle("logout",()=>requireController().logout());handle("restore",()=>requireController().restore());handle("switch-account",async()=>{await requireController().logout();void requireController().login()});handle("refresh",()=>requireController().refresh());handle("commerce",()=>requireController().commerce());handle("create-order",(plan,provider)=>{if(typeof plan!=="string"||!['alipay','wechat'].includes(provider))throw new Error("无效订单参数");return requireController().createOrder(plan,provider)})
  handle("workspace",async()=>{if(host){const target=await ensureWindow();attachWorkspaceView();target.show();target.focus()}else throw new Error("工作台未启动")})
  handle("show-account",()=>showAccount())
  handle('return-to-login',async()=>{await requireController().returnToLogin();await showAccount()})
  handle('retry-workspace',async()=>{
    if(!host||!workspaceView||workspaceView.webContents.isDestroyed())throw new Error('WORKSPACE_NOT_STARTED')
    await workspaceView.webContents.loadURL(host.origin+'/')
  })
  handle("select-files",async()=>{const result=await dialog.showOpenDialog({properties:["openFile","multiSelections"],filters:LOCAL_IMPORT_FILE_FILTERS});return result.canceled?[]:result.filePaths})
  const {autoUpdater}=updater;autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false
  if(readRuntimeEnv(process.env,"updateUrl"))autoUpdater.setFeedURL({provider:"generic",url:readRuntimeEnv(process.env,"updateUrl")!})
  let downloaded=false
  handle("check-updates",async()=>{if(!app.isPackaged||!readRuntimeEnv(process.env,"updateUrl"))return {available:false,reason:"本机构建未配置更新源"};const result=await autoUpdater.checkForUpdates();return {available:result?.isUpdateAvailable??false,version:result?.updateInfo.version}})
  handle("install-update",async()=>{if(!app.isPackaged||!readRuntimeEnv(process.env,"updateUrl"))throw new Error("更新源未配置");if(!downloaded){await autoUpdater.downloadUpdate();downloaded=true}await exits.request("update")})
  // macOS 菜单位于系统顶栏；Linux／Windows 不再占用窗口内一行，快捷键由本窗口保留。
  syncApplicationMenu()
  app.on("second-instance",()=>{void ensureWindow().then(target=>{target.show();target.focus()})})
  app.on("activate",()=>{if(!win){if(mode==="formal")void (async()=>{await showAccount();await controller!.restore()})();else void openWorkspace()}})
  app.on("window-all-closed",()=>{if(process.platform!=="darwin"&&!recovering)app.quit()})
  app.on("before-quit",event=>{if(exits.approved)return;event.preventDefault();void exits.request("app")})
  process.once("SIGTERM",()=>void exits.request("system"));process.once("SIGINT",()=>void exits.request("system"))
  // 登录先行：先把登录页装进同一窗口，再做会话恢复；恢复成功由控制器在同一窗口加载工作台，
  // 未授权/过期/失败则保留登录页，绝不启动匿名 Host。
  if(mode==="developer")await openWorkspace();else if(process.argv.includes("--guest")){await showAccount();await controller!.enterGuest()}else{await showAccount();await controller!.restore()}
  startupFinished=true
}
}).catch(error=>{const message=String(error?.message??error).replace(/([?&]token=)[^\s]+/g,"$1[redacted]");const failure=classifyStartupFailure(message);console.error(`桌面启动失败[${failure.kind}]：`,message);dialog.showErrorBox(`Lyapunov 启动失败（${failure.kind}）`,`${message}\n\n归因：${failure.reason}`);void exits.request("startup-error")})
