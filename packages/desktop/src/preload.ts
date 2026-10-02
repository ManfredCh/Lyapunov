import {contextBridge,ipcRenderer,webUtils} from "electron"
import type {DesktopBridge} from "./bridge.ts"
import {ExitParticipants} from "./exit-coordinator.ts"
const invoke=(name:string,...args:unknown[])=>ipcRenderer.invoke("lyapunov:"+name,...args)
const exitParticipants=new ExitParticipants()
let committing=false
const exitListeners=new Set<(committing:boolean)=>void>()
ipcRenderer.on("lyapunov:exit-state",(_event,value:boolean)=>{committing=value===true;for(const listener of exitListeners)listener(committing)})
// 确认后冻结新的用户输入；草稿/动作事实仍由各参与者原 owner 读取和保存。
for(const name of ["pointerdown","click","keydown","beforeinput","drop"]){window.addEventListener(name,event=>{if(committing){event.preventDefault();event.stopImmediatePropagation()}},true)}
ipcRenderer.on("lyapunov:exit-request",async(_event,request:{id:string;phase:"summary"|"flush"|"stop"})=>{
  try{
    const value=request.phase==="summary"?await exitParticipants.summary():await exitParticipants[request.phase]()
    ipcRenderer.send("lyapunov:exit-response",{id:request.id,phase:request.phase,ok:true,value})
  }catch(error){ipcRenderer.send("lyapunov:exit-response",{id:request.id,phase:request.phase,ok:false,message:error instanceof Error?error.message:String(error)})}
})
const api:DesktopBridge={
  guest:()=>invoke("guest"),
  registerExitParticipant:(id,participant)=>exitParticipants.register(id,participant),
  onExitStateChanged:listener=>{exitListeners.add(listener);listener(committing);return()=>exitListeners.delete(listener)},
  getDroppedFilePaths:files=>files.map(file=>webUtils.getPathForFile(file)),
  showAccount:()=>invoke("show-account"),
  mode:()=>invoke("mode"),accountState:()=>invoke("account-state"),login:()=>invoke("login"),cancelLogin:()=>invoke("cancel-login"),logout:()=>invoke("logout"),switchAccount:()=>invoke("switch-account"),restore:()=>invoke("restore"),refresh:()=>invoke("refresh"),commerce:()=>invoke("commerce"),createOrder:(plan,provider)=>invoke("create-order",plan,provider),showWorkspace:()=>invoke("workspace"),selectFiles:()=>invoke("select-files"),version:()=>invoke("version"),checkUpdates:()=>invoke("check-updates"),installUpdate:()=>invoke("install-update"),
  onAccountChanged(listener){const handler=(_event:Electron.IpcRendererEvent,state:Parameters<typeof listener>[0])=>listener(state);ipcRenderer.on("lyapunov:account-changed",handler);return()=>ipcRenderer.removeListener("lyapunov:account-changed",handler)},
}
contextBridge.exposeInMainWorld("lyapunovDesktop",api)
