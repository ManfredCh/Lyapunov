/**
 * 工作面布局（PLAN §三.6）：中央视图 + 工具面板列 + 底部抽屉 + 最右工具栏。
 *
 * 结构固定，切换模式/工具只改 CSS 与抽屉高度，**不卸载**任何一块：
 * - 中央视图：场景画布（工作台自有固定入口）与文件工作面（`lyapunov.workbench.centre` key `file`）
 *   **同时挂载**在 `.lya-wb-centre` 的两个 layer 里，用 `hidden` 切可见性——画布切走再切回
 *   是同一个 Viewer 实例（同相机、同选中、同 world），文件草稿也不因切换而重建；
 * - 工具面板：Claude 式 side page——不占布局轨道，覆盖在中央右侧（absolute + 阴影 + 滑入动画），
 *   一次一个，内容由 lyapunov-shell 的场景状态提供，标题栏同 rail 图标并可关闭；
 * - 底部抽屉：终端（`lyapunov.workbench.drawer` key `terminal`，真实 PTY 会话）与运行产物
 *   同样是常驻 layer，关闭抽屉只隐藏不卸载；占用者通过 owner 参数 `visible` 决定是否轮询；
 * - 会话级 Provider 座位（`lyapunov.workbench.session`）：lyapunov-workspace 把它的**同一份**
 *   客户端状态（草稿/保存/冲突/终端选择）注入一次，包住中央视图与抽屉，两块共享同一个实例，
 *   不存在"渲染两处＝两个 owner"。未注册时原样透传（fallback 就是 children 本身）。
 *
 * 槽位由注册方声明，这里的 renderSlot 是注册方传下来的授权函数（与原生 AppFrame 把 renderSlot
 * 交给 MainPanel 的用法一致）。
 */
import {useMemo,useRef} from "react"
import {createPortal} from "react-dom"
import type {CSSProperties,ReactNode} from "react"
import type {PropsRenderSlots} from "@deepseek-ai/dsh-client-ui-slots"
import type {Translate} from "./entity-editor.tsx"
import {WorkbenchIcon,type WorkbenchIconId} from "./vendor/tabler/icons.tsx"
import {useWorkbenchUI,DRAWER_MIN_HEIGHT,DRAWER_MAX_HEIGHT,TOOL_PANEL_WIDTH} from "./workbench-ui.ts"
import {appSidePanelHost} from "./app-side.ts"

/** 工作台自己声明的三个子槽位（注册项在 client.tsx 里声明同一份）。 */
export type WorkbenchSlotKeys="lyapunov.workbench.session"|"lyapunov.workbench.centre"|"lyapunov.workbench.drawer"
export type WorkbenchRenderSlot=PropsRenderSlots<WorkbenchSlotKeys>["renderSlot"]

function MissingSurface({tr,what}:{tr:Translate;what:string}){
  return <div className="lya-wb-missing" role="status">
    <strong>{tr(`${what}不可用`,"Surface unavailable")}</strong>
    <p className="lya-help">{tr("提供该工作面的客户端插件没有加载；场景画布与其余面板不受影响。","The client plugin owning this surface is not loaded; the scene canvas and other panels are unaffected.")}</p>
  </div>
}

/** 面板标题复用 rail 同一枚图标（同一套 Tabler 几何），让“点了哪个入口”在面板上仍然可读。 */
const PANEL_ICONS:Record<string,WorkbenchIconId>={scene:"scene",environment:"environment",robot:"robot",object:"object",camera:"camera",capture:"capture",recording:"recording",physics:"physics"}
/** 画布浮条工具：不占右列，由画布底部自己的浮条承载（Notes）。 */
const CANVAS_TOOLS:ReadonlySet<string>=new Set(["annotation"])

export function PanelColumn({tr,title,tool,children,onClose,hidden=false}:{tr:Translate;title:string;tool:string;children:ReactNode;onClose:()=>void;hidden?:boolean}){
  return <aside className="lya-wb-panel" data-tool={tool} hidden={hidden} {...hidden?{inert:''}:{}} style={{width:TOOL_PANEL_WIDTH,...hidden?{display:'none'}:{}}} aria-label={title}>
    <div className="lya-panel-head">
      <button type="button" className="lya-panel-close" aria-label={tr("关闭面板","Close panel")} title={tr("关闭面板","Close panel")} onClick={onClose}>×</button>
    </div>
    <div className="lya-wb-panel-body">{children}</div>
  </aside>
}

/**
 * 工具面板 / 抽屉的标题映射在 workbench.tsx（它握着场景状态）；这里只负责座位与几何。
 */
export function WorkSurface({sessionId,tr,renderSlot,centre,panel,retainedPanel,deliverables,active=true,nativeTab=false,revealScene,panelSuppressed=false}:{
  active?:boolean
  nativeTab?:boolean
  revealScene?:()=>void
  sessionId?:string
  tr:Translate
  renderSlot:WorkbenchRenderSlot
  /** 场景画布节点：固定入口，始终挂载。 */
  centre:ReactNode
  /** 当前工具面板内容（由 workbench.tsx 按 state.tool 提供）。 */
  panel:ReactNode
  /** 临时模式（放置/表面拾取）下让出右侧面板，保证画布浮条可达。 */
  panelSuppressed?:boolean
  /** 仅真实草稿编辑器常驻；物理/资源面板保持原按需生命周期。 */
  retainedPanel?:{tool:string;children:ReactNode;hidden?:boolean}
  /** 产物抽屉内容（录制/回放/截图）。 */
  deliverables:ReactNode
}){
  const ui=useWorkbenchUI()
  const state=ui.getSnapshot()
  // Portal脱离会话的隐藏树；根可见性必须消费原生当前会话/标签的active事实。
  // 临时模式（放置/拾取）只**隐藏**当前面板，不卸载它：返回时草稿与同一组件 owner 仍在。
  // Notes 这类"画布工具"没有右列面板：它由画布上的浮条承载，这里不渲染空的面板列。
  const panelTool=state.tool&&!CANVAS_TOOLS.has(state.tool)?state.tool:null
  const panelRendered=active&&(nativeTab||state.centre==='canvas')&&Boolean(panelTool)
  const panelVisible=!panelSuppressed&&panelRendered
  // 缓存原React编辑器座位，不复制Draft/Scene；跨工具开合和暂时取消选择不卸载该owner。
  const retained=useRef<{sessionId?:string;tool:string;children:ReactNode;hidden?:boolean}>()
  if(retained.current?.sessionId!==sessionId)retained.current=undefined
  if(retainedPanel&&(retained.current||panelVisible&&state.tool===retainedPanel.tool))retained.current={sessionId,...retainedPanel}
  const retainedVisible=Boolean(panelVisible&&retainedPanel&&state.tool===retainedPanel.tool&&!retainedPanel.hidden)
  // retained 编辑器可见时，同工具的 active 面板只是空壳（object inspector 的占位）⇒ 不挂载、不占 flex/gap。
  const activeVisible=panelRendered&&!retainedVisible
  // 交给占用者的开合请求（同进程函数，不是端点、不是新状态）；identity 稳定，避免占用者反复登记。
  const reveal=useMemo(()=>({canvas:()=>{revealScene?.();ui.showCentre("canvas")},file:()=>ui.showCentre("file"),terminal:()=>{revealScene?.();ui.showDrawer("terminal")},toggleTerminal:()=>{revealScene?.();if(nativeTab&&!active)ui.showDrawer("terminal");else ui.toggleDrawer("terminal")}}),[ui,revealScene,nativeTab,active])
  const exposed=active&&state.centre==="file"
  // 中央与抽屉的宿主**常驻挂载**：画布/文件状态/录制/终端宿主换的只是可见性（hidden + CSS），
  // 不是 React 位置。切走再切回不重建 Viewer、不丢未保存草稿、不新建 PTY。
  const fileVisible=!nativeTab&&active&&state.centre==="file",deliverableVisible=active&&state.drawer==="deliverable"
  const fileSurface=nativeTab?null:renderSlot("lyapunov.workbench.centre",{sessionId,visible:fileVisible},{entryKey:"file",fallback:<MissingSurface tr={tr} what={tr("文件工作面","File work surface")}/>})
  const body=<>
    <div className="lya-wb-main">
      <div className="lya-wb-centre">
        <div className="lya-wb-layer" data-layer="canvas" hidden={fileVisible}>{centre}</div>
        {!nativeTab&&<div className="lya-wb-layer" data-layer="file" hidden={!fileVisible}>{fileSurface}</div>}
      </div>
      {panelTool||retained.current?(()=>{
        const tool=panelTool??retained.current!.tool
        const node=<PanelColumn key={sessionId} tr={tr} tool={tool} title={panelTitle(tr,tool)} hidden={!panelVisible} onClose={()=>ui.closeTool()}>
          {retained.current&&<div key="retained-editor" className="lya-panel-slot" hidden={!retainedVisible} {...!retainedVisible?{inert:''}:{}} style={!retainedVisible?{display:'none'}:undefined}>{retained.current.children}</div>}
          <div key="active-panel" className="lya-panel-slot" hidden={!activeVisible}>{activeVisible?panel:null}</div>
        </PanelColumn>
        // 只在共享宿主是真实、已连接 DOM 时 portal；测试/卸载竞态留下的假宿主退回就地渲染。
        const host=appSidePanelHost.current
        return host?.isConnected&&typeof host.appendChild==="function"?createPortal(node,host):node
      })():null}
    </div>
    <section className="lya-wb-drawer" hidden={state.drawer!=="deliverable"&&state.drawer!=="terminal"} style={{height:state.drawerHeight,"--lya-drawer-height":`${state.drawerHeight}px`} as CSSProperties} aria-label={tr("底部抽屉","Bottom drawer")}>
      <div className="lya-wb-drawer-handle" role="separator" aria-orientation="horizontal" aria-label={tr("调整抽屉高度","Resize drawer")}
        onPointerDown={event=>{
          const startY=event.clientY,startHeight=state.drawerHeight
          event.currentTarget.setPointerCapture(event.pointerId)
          const node=event.currentTarget
          const move=(moveEvent:PointerEvent)=>{if(moveEvent.buttons!==1)return;ui.setDrawerHeight(Math.min(DRAWER_MAX_HEIGHT,Math.max(DRAWER_MIN_HEIGHT,startHeight-(moveEvent.clientY-startY))))}
          const up=()=>{node.removeEventListener("pointermove",move);node.removeEventListener("pointerup",up)}
          node.addEventListener("pointermove",move);node.addEventListener("pointerup",up)
        }}/>
      <div className="lya-wb-drawer-body">
        <div className="lya-wb-layer" data-layer="deliverable" hidden={!deliverableVisible}>{deliverables}</div>
      </div>
    </section>
  </>
  return <section className="lya-wb-surface">
    {renderSlot("lyapunov.workbench.session",{sessionId,children:body,exposed,reveal},{fallback:body})}
  </section>
}

/** 面板标题：与 rail 的标签同一套词表，避免同一工具两处叫法不同。 */
export function panelTitle(tr:Translate,tool:string):string{
  const zh:Record<string,string>={scene:"场景",environment:"环境",robot:"机器人",object:"物件",camera:"相机",capture:"拍摄",recording:"录制",annotation:"批注",physics:"物理"}
  const en:Record<string,string>={scene:"Scene",environment:"Environment",robot:"Robots",object:"Objects",camera:"Camera",capture:"Capture",recording:"Recording",annotation:"Notes",physics:"Physics"}
  return tr(zh[tool]??tool,en[tool]??tool)
}
