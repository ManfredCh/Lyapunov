/**
 * 工作台展示状态：布局模式、中央视图、工具面板、底部抽屉。
 *
 * 这里只有"怎么显示"。会话、消息、输入、权限属于原生 ui-conversation；场景/world/选择/资产
 * 属于既有 host 所有者；文件草稿与终端属于 lyapunov-workspace。展示状态本身是**一台界面一份**
 * 的偏好（不是会话数据），所以只有唯一一个模块级实例，切换会话不需要也不能把它复制成 N 份：
 * 既不是无界缓存，也不会出现同一会话两个 owner 各持一份、互相覆盖。
 * 跨会话/刷新保留靠 localStorage，字段逐个取白名单校验，坏值一律回默认。
 *
 * **可见性口径（DEV-005）**：本文件里的 `WorkbenchUIState` 六个字段就是"**页面共享、可共享**"的
 * 布局偏好（mode／tool／centre／drawer／drawerHeight／conversationWidth，一台界面一份、跨会话保留）；
 * 它们**不是**任何会话的私有视图。因此改动它们的界面动作只在发出请求的窗口就是当前可见工作面时
 * 才落地（判据见下面的 `surfaceDisposition`，调用点在 `workbench.tsx` 的 `drainUiActions`）：
 * 后台窗口的展示请求保持排队，等它自己被切到前台再执行，不会无提示改前台工作面。
 */
import {useSyncExternalStore} from "react"
export {surfaceDisposition} from './ui-action-scope.ts'

/** 三种展示模式：对话专注 / 协作 / 场景专注。 */
export type LayoutMode="chat"|"collab"|"scene"
/** 工具面板条目：一次只开一个，位于工作面右侧。 */
export type ToolId="scene"|"environment"|"robot"|"object"|"camera"|"asset"|"annotation"
/** 中央视图：场景画布（固定入口）⟷ 文件工作面。 */
export type CentreId="canvas"|"file"
/** 底部抽屉：终端 / 运行产物，一次一个。 */
export type DrawerId="terminal"|"deliverable"

export interface WorkbenchUIState {
  readonly mode:LayoutMode
  /** null 表示工具面板关闭（画布收回整块空间）。 */
  readonly tool:ToolId|null
  readonly centre:CentreId
  readonly drawer:DrawerId|null
  readonly drawerHeight:number
  /** 协作模式下对话列宽（px）；拖拽与默认值都夹在 CONVERSATION_MIN/MAX 之间。 */
  readonly conversationWidth:number
}

const STORAGE_KEY="lyapunov.workbench.ui"
const DEFAULT_STATE:WorkbenchUIState={mode:"collab",tool:null,centre:"canvas",drawer:null,drawerHeight:240,conversationWidth:380}
/** 抽屉高度夹取：太矮放不下提示，太高会把画布挤没。 */
export const DRAWER_MIN_HEIGHT=140
export const DRAWER_MAX_HEIGHT=520
/** 工具面板列宽（PLAN §三.6：288–320）。 */
export const TOOL_PANEL_WIDTH=300
/**
 * 协作模式对话列宽（PLAN §三.6：360–420，画布优先）。
 * 默认取区间中点偏小的一侧，拖拽也只在这个区间里走：对话够读，画布拿到其余全部宽度。
 */
export const CONVERSATION_MIN_WIDTH=360
export const CONVERSATION_MAX_WIDTH=420
export const CONVERSATION_DEFAULT_WIDTH=380
const clampConversationWidth=(value:number)=>Math.min(CONVERSATION_MAX_WIDTH,Math.max(CONVERSATION_MIN_WIDTH,Math.round(value)))

/**
 * 会改**页面级工作面**的界面动作：四个改共享布局偏好的动作（openTool／showCanvas／selectEntity／focus）
 * 加三个改右侧栏可见标签的动作（openFiles／openTerminal／openResource —— "把前台切到文件/终端/指定资源"就是它们）。
 * 相机定位会切换画布和机器人面板，退出相机会恢复观察位并聚焦画布，也必须由前台执行。
 * 其余动作（selectScene／captureViewer／applyCameraViewer／renderCameraViewer／sampleCameraViewer）落在本会话自己的
 * 场景、选中与窗口上，不是页面共享偏好，不受这条规则限制。
 */

/**
 * 展示请求的落地规则（DEV-005）：改页面级工作面的动作只允许**当前可见**的工作台窗口落地（`"apply"`），
 * 后台窗口一律 `"defer"`——调用方不确认出队，这条请求留在队列里，等它的窗口被切到前台再执行。
 * 于是后台会话的展示请求既不会无提示改前台工作面（共享布局偏好见文件头），也不会被丢掉。
 */

const MODES:LayoutMode[]=["chat","collab","scene"]
const TOOLS:ToolId[]=["scene","environment","robot","object","camera","asset","annotation"]
const CENTRES:CentreId[]=["canvas","file"]
const DRAWERS:DrawerId[]=["terminal","deliverable"]
const oneOf=<T extends string>(list:readonly T[],value:unknown,fallback:T):T=>list.includes(value as T)?value as T:fallback
/** 可空字段：显式 null 保持 null（合法值），其余只接受白名单成员。 */
const oneOfOrNull=<T extends string>(list:readonly T[],value:unknown):T|null=>value===null?null:list.includes(value as T)?value as T:null

function sanitize(value:Partial<WorkbenchUIState>|undefined):WorkbenchUIState{
  if(!value||typeof value!=="object")return DEFAULT_STATE
  const height=Number(value.drawerHeight),width=Number(value.conversationWidth)
  return {
    mode:oneOf(MODES,value.mode,DEFAULT_STATE.mode),
    tool:oneOfOrNull<ToolId>(TOOLS,value.tool),
    centre:oneOf(CENTRES,value.centre,DEFAULT_STATE.centre),
    drawer:oneOfOrNull<DrawerId>(DRAWERS,value.drawer),
    drawerHeight:Number.isFinite(height)?Math.min(DRAWER_MAX_HEIGHT,Math.max(DRAWER_MIN_HEIGHT,Math.round(height))):DEFAULT_STATE.drawerHeight,
    conversationWidth:Number.isFinite(width)?clampConversationWidth(width):DEFAULT_STATE.conversationWidth,
  }
}
function readStored():WorkbenchUIState{
  try{return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)??"null") as Partial<WorkbenchUIState>)}catch{return DEFAULT_STATE}
}

/** 唯一实例：一台界面一份展示状态，随页面存在，不随会话累积。 */
function createStore(){
  let state:WorkbenchUIState=readStored()
  const listeners=new Set<()=>void>()
  const emit=()=>{for(const listener of listeners)listener()}
  const set=(patch:Partial<WorkbenchUIState>)=>{
    const next={...state,...patch}
    if(Object.keys(next).every(key=>next[key as keyof WorkbenchUIState]===state[key as keyof WorkbenchUIState]))return
    state=next
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{/* 隐私模式：本次会话内仍然生效 */}
    emit()
  }
  return {
    getSnapshot:():WorkbenchUIState=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
    /** 模式切换只改展示；协作/场景专注在窄屏下由布局自己收敛。 */
    setMode:(mode:LayoutMode)=>set({mode}),
    /** 用户点击工具就显露工作面；只有工具已可见时，再点才收起。 */
    toggleTool:(tool:ToolId)=>set({tool:state.mode!=="chat"&&state.centre==="canvas"&&state.tool===tool?null:tool,centre:"canvas",mode:state.mode==="chat"?"collab":state.mode}),
    /** 打开指定工具面板（已经是它就不动，用于"动作后展示结果"这类跳转）。 */
    openTool:(tool:ToolId)=>set({tool,centre:"canvas",mode:state.mode==="chat"?"collab":state.mode}),
    closeTool:()=>set({tool:null}),
    /** 中央视图：点同一个视图＝回到画布（场景画布始终可达）。 */
    showCentre:(centre:CentreId)=>set({centre,...centre==="file"?{tool:null}:{},mode:state.mode==="chat"?"collab":state.mode}),
    toggleCentre:(centre:CentreId)=>set({centre:state.mode!=="chat"&&state.centre===centre&&centre!=="canvas"?"canvas":centre,tool:null,mode:state.mode==="chat"?"collab":state.mode}),
    /** 抽屉入口：显示指定抽屉；再点当前抽屉＝关闭。 */
    toggleDrawer:(drawer:DrawerId)=>set({drawer:state.mode!=="chat"&&state.drawer===drawer?null:drawer,mode:state.mode==="chat"?"collab":state.mode}),
    /** 来自界面动作的打开（已经是它就不动，用于"新终端后把抽屉露出来"这类跳转）。 */
    showDrawer:(drawer:DrawerId)=>set({drawer,mode:state.mode==="chat"?"collab":state.mode}),
    closeDrawer:()=>set({drawer:null}),
    setDrawerHeight:(height:number)=>set({drawerHeight:Math.min(DRAWER_MAX_HEIGHT,Math.max(DRAWER_MIN_HEIGHT,Math.round(height)))}),
    /** 拖拽对话列：只改宽度，夹在 360–420 之间（画布优先）。 */
    setConversationWidth:(width:number)=>set({conversationWidth:clampConversationWidth(width)}),
  }
}
export type WorkbenchUIStore=ReturnType<typeof createStore>
const store=createStore()

/** 当前展示状态（任意组件都能读；展示状态没有会话作用域，见文件头）。 */
export function useWorkbenchUI():WorkbenchUIStore{
  useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)
  return store
}
