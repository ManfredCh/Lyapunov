import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-ui-layout/client"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client"
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client"
import type {ISessions} from "@deepseek-ai/dsh-api-session-controller/client"
import type {SessionId} from "@deepseek-ai/dsh-session/types"
import {fileAddressFor} from "@deepseek-ai/dsh-util-workspace-path"
import {openExpectationFor,openReceiptVerdict} from "./ui-action-open.ts"
import {openExistingHistorySession,type ExistingHistoryEntry} from "./history-navigation.ts"

/** 桌面和独立插件共用 DSH 的资源标签与会话导航。 */
export function createNativeNavigation(ctx:Context){
 const sessions=ctx.get("sessions") as unknown as ISessions
 /**
  * `ui_action` 的 `openResource` 落点：**复用原生资源地址与标签所有者**（不另造 iframe/文件页）。
  * path 按会话工作区解析成 `dsh-resource://file/...`；`source` 点名工作区包的源编辑器 kind
  * （HTML→`HTML_EDITOR_KIND`，其余→`EDITOR_KIND`，方式确定才可核对），`preview` 交给注册表排名。
  * 打开后**回读真实激活标签**：回执里的 address/kind 取标签自己的 `contentId`/`kind`，绝不把请求
  * 参数当回执；再与请求期望逐项核对，错误文件/错误方式直接失败（不 ack 成功）。
  */
 const settleActiveTab=async(address:string)=>{
  const deadline=Date.now()+2000
  for(;;){
   const active=ctx.sidebarRight.active()
   if(active&&active.contentId===address)return active
   if(Date.now()>=deadline)return undefined
   await new Promise(resolve=>setTimeout(resolve,16))
  }
 }
 const openResource=async(sessionId:string|undefined,path:string,target:"preview"|"source")=>{
  if(!sessionId)throw Error("UI_ACTION_OPEN_SESSION_REQUIRED: 没有会话，无法解析资源地址")
  const response=await fetch("/api/lyapunov/workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,action:"info",input:{}})})
  const info=await response.json() as {cwd?:string;error?:string}
  if(!response.ok)throw Error(info.error??response.statusText)
  const address=fileAddressFor(sessionId,info.cwd,path)
  const expectation=openExpectationFor({path,target,address})
  // source 是点名打开（kind 确定）；preview 交给注册表排名。
  const namedKind=target==="source"?expectation.expectedKind:undefined
  ctx.sidebarRight.openResourceIn(sessionId as SessionId,address,namedKind?{kind:namedKind}:undefined)
  // 打开后**当场回读**真实激活标签：标签列真的展开、且活动标签就是刚打开的那一个地址，才算 visible。
  const tab=await settleActiveTab(address)
  const receipt={opened:tab!==undefined,visible:tab!==undefined&&ctx.sidebarRight.isExpanded(),address:tab?.contentId??null,kind:tab?.kind??null}
  const verdict=openReceiptVerdict(receipt,expectation)
  if(!verdict.ok)throw Error(verdict.reason)
  return receipt
 }
 return {
  openResource,
  openHistorySession:(entry:ExistingHistoryEntry)=>openExistingHistorySession(entry,{
   refresh:()=>sessions.refresh(),
   snapshot:()=>sessions.list.getSnapshot(),
   open:id=>ctx.uiWorkspace.openSession(id as SessionId),
  },ctx.layout.beginNavigation()),
 }
}
