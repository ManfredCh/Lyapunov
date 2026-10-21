import type {InputActions,SessionInput} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type {InsertViewerReference} from "./viewer-context-menu.tsx"
import {useCallback,useState} from "react"
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
/**
 * P21 真实初始布局时序：默认紧凑左栏必须在**首次右工作区宽度初始化之前**折起。
 *
 * P17 把这次折叠放在 SceneTab 的 `tab.visible` effect 里 ⇒ SDK 早已按 280px 左栏调过 `openRightbar`
 * （`stores.ts` 的 `rightbar ??= viewport - (sidebar||56) - 400`），rightbar 偏好被钉在 760px，
 * 折左栏腾出的 224px 全被聊天列吃掉。这里提前到**插件初始化**（`registerNativeWorkspace` 定义/注册
 * tab 之前、React 首次渲染与 RightbarRoot 首次 `openRightbar` 之前），只用公开 `ctx.layout.toggleSidebar()`。
 *
 * - **一次性内存守卫**（同一 page load 只折一次，不落 localStorage）：刷新 = 新页面 = 重新给合理默认；
 *   用户本页之后手动展开/拖拽不会再被抢回。
 * - **窄视口不调用**：SDK 在 <1024 已自动折叠，此时 `toggleSidebar` 翻转 `narrowExpanded` 反而会展开左栏。
 * - **不持久化任何宽度**：只调用公开 toggle，不碰共享 store、不发假键盘事件、不直接改 inline grid。
 * - 生产无 HMR：模块只求值一次；开发 HMR 会重新求值，但首次调用后 SDK 左栏已为 0（DOM 带
 *   `data-sidebar-collapsed`），下面的 DOM 检查会跳过，不会又展开回去。
 */
const SIDEBAR_AUTO_COLLAPSE=1024
let sidebarCompactedThisPage=false
let rightbarAlongsideSeededThisPage=false
/** 仅测试用：重置“本页已折叠/已预置 alongside”内存守卫（生产路径不调用）。 */
export function resetSidebarCompactionForTests(){sidebarCompactedThisPage=false;rightbarAlongsideSeededThisPage=false}
/**
 * V10 原生宽度：pinned Scene 首次 openRightbar 之前先按公开 `openRightbar(...,alongside)` 报告一次
 * alongside，随后立即 `closeRightbar()` 只留下“首开正常默认宽度”的初始化结果。
 *
 * 为什么需要：SDK 的 `SidebarRight.ensurePinned` 在 **passive effect** 里补 pinned tab，而首次
 * `syncPresentation` 在 layout effect 里已经不带 alongside 调过 `openRightbar`，于是 `rightbar ??=`
 * 先按 45% 钉死；之后 alongside 再来也改不回 Chat 400px 的默认。这里在注册 pinned Scene 之前用
 * 同一份公开动作预置，只影响本页第一次初始化；已展开的右栏/已存在用户宽度不碰。
 */
export function seedPinnedSceneRightbar(ctx:Context):boolean{
 if(rightbarAlongsideSeededThisPage)return false
 rightbarAlongsideSeededThisPage=true
 if(ctx.sidebarRight?.isExpanded?.())return false
 try{ctx.layout.openRightbar(false,false,true);ctx.layout.closeRightbar();return true}catch{return false}
}
/**
 * 首次进入宽视口时折起 SDK 左栏一次。返回是否真的调用了公开 `toggleSidebar`。
 * 没有公开 layout 服务、窄视口、DOM 已是折叠态、或本页已折过 ⇒ 不调用，保持原布局。
 */
export function compactLeftSidebarOnce(ctx:Context):boolean{
 if(sidebarCompactedThisPage)return false
 sidebarCompactedThisPage=true
 if(typeof window!=="undefined"&&window.innerWidth<SIDEBAR_AUTO_COLLAPSE)return false
 // HMR/二次求值：DOM 已折叠就不再 toggle（宽屏 toggle 会反向展开成 280px）。
 if(typeof document!=="undefined"&&document.querySelector('[data-sidebar-collapsed="true"]'))return false
 try{ctx.layout.toggleSidebar();return true}catch{return false}
}
type SceneTabProps=PropsRuntime<"sidebar.right.pane.tab">&PropsRenderSlots<WorkbenchSlotKeys>&PropsLocale<"lyapunov">

type ToolsProps=PropsRuntime<"sidebar.right.surface.actions">&PropsLocale<"lyapunov">&{openScene:()=>void;openFiles:()=>void;openTerminal:()=>void}
function WorkspaceTools({t,activeTab,openScene,openFiles,openTerminal,sessionId}:ToolsProps){
 const tr=(zh:string,en:string)=>t("open")==="Scene workbench"?en:zh
 // 引擎切换必须接在**这里**：原生工作台模式下渲染工具轨的就是本组件（`Workbench` 里的那份 rail
 // 只在非原生模式渲染）。此前只接了 Workbench 那一份，于是原生模式下按钮是个**空壳**——
 // 实测点它既不写偏好也不更新标签，而 `engine` 恒为 undefined 显示成"—"。
 // 与 Workbench 共用同一份引擎状态/切换逻辑（此前两处各写一份，原生模式下那份是后补的）。
 const {state:engineState,switchEngine:applyEnginePreference}=useEnginePreference(sessionId)
 const [engineNotice,setEngineNotice]=useState<{text:string;detail:string}|undefined>(undefined)
 const switchEngine=useCallback((next:"isaac"|"mujoco")=>{
  const label=next==="isaac"?"Isaac":"MuJoCo"
  setEngineNotice(undefined)
  void applyEnginePreference(next)
    .then(()=>setEngineNotice({text:tr(`${label} · 下次启动生效`,`${label} · next start`),detail:tr("引擎在启动时装配；当前会话与动作不受影响，按回执提示重启工作台后生效。","Composed at startup; this session and its actions are unaffected. Restart the workbench as the receipt explains.")}))
    .catch((error:unknown)=>setEngineNotice({text:tr("引擎切换失败","Engine switch failed"),detail:String(error instanceof Error?error.message:error)}))
 },[applyEnginePreference,tr])
 return <div className="lya-wb lya-workspace-tools"><style>{workbenchStyle}</style>
  <ToolRail tr={tr} nativeSceneActive={activeTab?.kind===SCENE_TAB_KIND} revealScene={openScene} openFiles={openFiles} openTerminal={openTerminal} engine={engineState.engine??undefined} preference={engineState.preference??undefined} onSwitchEngine={switchEngine}/>
  {engineNotice?<p className="lya-rail-engine-notice" role="status" title={engineNotice.detail}>{engineNotice.text}</p>:null}
 </div>
}
export function registerNativeWorkspace(ctx:Context){
 // P21：在注册 tab / 首次 openRightbar 之前先折默认紧凑左栏（公开 toggle、一次性内存守卫，见上）。
 compactLeftSidebarOnce(ctx)
 // V10：pinned Scene 首开前用公开 openRightbar(alongside) 预置正常默认宽度（只本页第一次）。
 seedPinnedSceneRightbar(ctx)
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
  const {tab,sidebar}=useTabInfo()
  // V10 窄窗 Scene 专注：只用公开 sidebarRight 的 fullscreen 动作；目标取被点击按钮所在的真实 dock 面板，
  // 不读私有 store、不写宽度偏好、也不伪造键盘。返回时仍走原生全屏控件。
  const sceneFocus=()=>{
   const target=ctx.sidebarRight.commandTarget()
   if(target)ctx.sidebarRight.toggleFullscreen(target)
  }
  const insertViewerReference:InsertViewerReference=reference=>{
   if(!sessionId)return false
   const scope=sessions.scope(sessionId as SessionId)
   if(!scope)return false
   const input=ctx.conversation.input.for(scope) as SessionInput & {actions:InputActions}
   const applied=input.insertReference(reference,input.actions.captureInsertion())
   if(applied)input.focus()
   return applied
  }
  return <Workbench insertViewerReference={insertViewerReference} key={sessionId} sessionId={sessionId} t={t} renderSlot={renderSlot} nativeTab visible={tab.visible} revealScene={()=>tab.actions.openTab(SCENE_TAB_KIND)} openFiles={()=>tab.actions.openTab("files")} openTerminal={()=>tab.actions.openTab("terminal")} openResource={(path,target)=>openResource(sessionId,path,target)} openHistorySession={entry=>openExistingHistorySession(entry,{refresh:()=>sessions.refresh(),snapshot:()=>sessions.list.getSnapshot(),open:id=>ctx.uiWorkspace.openSession(id as SessionId)},ctx.layout.beginNavigation())} sceneFocus={sceneFocus} sceneFocusActive={sidebar.fullscreen}/>
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
