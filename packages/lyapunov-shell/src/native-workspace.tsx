import {useCallback,useEffect,useState} from "react"
/** 原生标签与场景工具的薄接线；标签状态仍归DSH sidebarRight。 */
import type {Context} from "@deepseek-ai/cordis"
import type {PropsLocale,PropsRenderSlots,PropsRuntime} from "@deepseek-ai/dsh-client-ui-slots"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client"
import type {} from "@deepseek-ai/dsh-client-ui-layout/client"
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client"
import type {ISessions} from "@deepseek-ai/dsh-api-session-controller/client"
import type {SessionId} from "@deepseek-ai/dsh-session/types"
import {fileAddressFor} from "@deepseek-ai/dsh-util-workspace-path"
import type {} from "../../lyapunov-contracts/src/workbench-slots.ts"
// openResource 的期望与回执判据（与宿主 `plugin.ts` 共用同一份纯函数）。
import {openExpectationFor,openReceiptVerdict} from "./ui-action-open.ts"
import {Workbench} from "./workbench.tsx"
import {ToolRail} from "./tool-rail.tsx"
import {workbenchStyle} from "./workbench-style.ts"
import {useEnginePreference} from "./engine-preference-client.ts"
import {WORKBENCH_CHILDREN} from "./hosting.ts"
import {appSidePanelHost} from "./app-side.ts"
import {openExistingHistorySession} from "./history-navigation.ts"
import type {WorkbenchSlotKeys} from "./work-surface.tsx"

export const SCENE_TAB_KIND="lyapunov.scene"
const SCENE_TAB_ID="@lyapunov/shell/scene"
type SceneTabProps=PropsRuntime<"sidebar.right.pane.tab">&PropsRenderSlots<WorkbenchSlotKeys>&PropsLocale<"lyapunov">

type ToolsProps=PropsRuntime<"sidebar.right.surface.actions">&PropsLocale<"lyapunov">&{openScene:()=>void;openFiles:()=>void;openTerminal:()=>void}
function WorkspaceTools({t,activeTab,openScene,openFiles,openTerminal,sessionId}:ToolsProps){
 const tr=(zh:string,en:string)=>t("open")==="Scene workbench"?en:zh
 // 引擎切换必须接在**这里**：原生工作台模式下渲染工具轨的就是本组件（`Workbench` 里的那份 rail
 // 只在非原生模式渲染）。此前只接了 Workbench 那一份，于是原生模式下按钮是个**空壳**——
 // 实测点它既不写偏好也不更新标签，而 `engine` 恒为 undefined 显示成"—"。
 // 与 Workbench 共用同一份引擎状态/切换逻辑（此前两处各写一份，原生模式下那份是后补的）。
 const {state:engineState,switchEngine:applyEnginePreference}=useEnginePreference(sessionId)
 const [engineNotice,setEngineNotice]=useState("")
 const engine=engineState.engine??engineState.preference??undefined
 const switchEngine=useCallback((next:"isaac"|"mujoco")=>{
   setEngineNotice("")
   void applyEnginePreference(next)
     .then(()=>setEngineNotice(tr(`已选择 ${next==="isaac"?"Isaac":"MuJoCo"}；引擎在启动时装配，下次启动工作台后生效（当前会话与动作不受影响）。`,
                          `${next==="isaac"?"Isaac":"MuJoCo"} selected. The engine is composed at startup, so it takes effect after the next workbench start; this session and its actions are unaffected.`)))
     .catch((error:unknown)=>setEngineNotice(tr("切换失败：","Switch failed: ")+String(error instanceof Error?error.message:error)))
 },[applyEnginePreference,tr])
 return <div className="lya-wb lya-workspace-tools"><style>{workbenchStyle}</style>
  <ToolRail tr={tr} nativeSceneActive={activeTab?.kind===SCENE_TAB_KIND} revealScene={openScene} openFiles={openFiles} openTerminal={openTerminal} engine={engine} onSwitchEngine={switchEngine}/>
  {engineNotice?<p className="lya-rail-engine-notice" role="status">{engineNotice}</p>:null}
 </div>
}
export function registerNativeWorkspace(ctx:Context){
 const tr=ctx.locale.bind("lyapunov")
 // 与原生ui-workspace同一client face；本仓同时检查Host同名SessionStore类型，不能当客户端目录用。
 const sessions=ctx.get('sessions') as unknown as ISessions
 const definition={id:SCENE_TAB_ID,kind:SCENE_TAB_KIND,title:()=>tr("sceneTab"),pinned:true,keepMounted:true}
 ctx.effect(()=>ctx.sidebarRightTabs.register(definition))
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
  if(namedKind)ctx.sidebarRight.openResourceIn(sessionId as SessionId,address,{kind:namedKind})
  else ctx.sidebarRight.openResource(address)
  // 打开后**当场回读**真实激活标签：标签列真的展开、且活动标签就是刚打开的那一个地址，才算 visible。
  const tab=await settleActiveTab(address)
  const receipt={opened:tab!==undefined,visible:tab!==undefined&&ctx.sidebarRight.isExpanded(),address:tab?.contentId??null,kind:tab?.kind??null}
  const verdict=openReceiptVerdict(receipt,expectation)
  if(!verdict.ok)throw Error(verdict.reason)
  return receipt
 }
 function SceneTab({sessionId,t,renderSlot,useTabInfo}:SceneTabProps){
  const {tab}=useTabInfo()
  return <Workbench key={sessionId} sessionId={sessionId} t={t} renderSlot={renderSlot} nativeTab visible={tab.visible} revealScene={()=>tab.actions.openTab(SCENE_TAB_KIND)} openFiles={()=>tab.actions.openTab("files")} openTerminal={()=>tab.actions.openTab("terminal")} openResource={(path,target)=>openResource(sessionId,path,target)} openHistorySession={entry=>openExistingHistorySession(entry,{refresh:()=>sessions.refresh(),snapshot:()=>sessions.list.getSnapshot(),open:id=>ctx.uiWorkspace.openSession(id as SessionId)},ctx.layout.beginNavigation())}/>
 }
 ctx.effect(()=>{
  // 宿主带 lya-wb：portal 过去的工具窗在 DOM 上脱离工作台，令牌（--lya-*）与按钮/输入皮肤
  // 都按类作用域定义，宿主同类同皮肤；宿主的背景/溢出已由 .lya-appside-panel-host 规则中和。
  const host=document.createElement("div")
  host.className="lya-appside-panel-host lya-wb"
  document.body.appendChild(host)
  appSidePanelHost.current=host
  return()=>{host.remove();appSidePanelHost.current=null}
 })
 ctx.effect(()=>ctx.slots.inject("sidebar.right.pane.tab",()=>ctx.slots.register({
  name:"sidebar.right.pane.tab",key:SCENE_TAB_ID,locale:"lyapunov",children:WORKBENCH_CHILDREN,
 },SceneTab)))
 ctx.effect(()=>ctx.slots.inject("sidebar.right.surface.actions",()=>ctx.slots.register({
  name:"sidebar.right.surface.actions",id:"lyapunov-tools",locale:"lyapunov",
  // DEV-017（N46 rev9）：终端入口幂等——**已经显示着终端就不再 open**（每次 open 都新叠一个 `bash` 标签：实测 3 连点出 3 个）。
  // DEV-017（N114 rev）：曾按"收起后打不开"的假设改成幂等收敛（`openTab("terminal")` 交给上游 Pages 去重，契约见 `ui-sidebar-right/contract/slots.ts:118`），
  // 构建后真机复测**终端仍然打不开**（`xterm`=0、点击前后无任何终端 DOM）⇒ 该假设**未被证实**，阻断点在守卫**上游**（rail 的 `openTerminal` prop 接线/抽屉 key `terminal` 的挂载），故此处**回退**为原守卫。
  // 不用 `replaceTab`（它要的是 TabId，不是布尔；实测传 `true` 会把终端入口整个打没，见回执 ⑩）；这里只做"同 kind 已在前台就不动"。
  inject:()=>({openScene:()=>ctx.sidebarRight.openTab(SCENE_TAB_KIND),openFiles:()=>ctx.sidebarRight.openTab("files"),openTerminal:()=>{if(ctx.sidebarRight.active()?.kind==="terminal")return;ctx.sidebarRight.openTab("terminal")}}),
 },WorkspaceTools)))
}
