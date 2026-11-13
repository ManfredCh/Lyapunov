/** 原生场景标签内的画布、工具面板与产物抽屉。 */
import {useMemo,useRef} from "react"
import {createPortal} from "react-dom"
import type {CSSProperties,ReactNode} from "react"
import type {PropsRenderSlots} from "@deepseek-ai/dsh-client-ui-slots"
import type {Translate} from "./entity-editor.tsx"
import {useWorkbenchUI,DRAWER_MIN_HEIGHT,DRAWER_MAX_HEIGHT,TOOL_PANEL_WIDTH,CANVAS_TOOL_IDS} from "./workbench-ui.ts"
import {appSidePanelHost} from "./app-side.ts"

/** 工作台自己声明的两个子槽位（注册项在 client.tsx 里声明同一份）。 */
export type WorkbenchSlotKeys="lyapunov.workbench.session"
export type WorkbenchRenderSlot=PropsRenderSlots<WorkbenchSlotKeys>["renderSlot"]

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
export function WorkSurface({sessionId,tr,renderSlot,centre,panel,retainedPanel,deliverables,active=true,revealScene,openTerminal,panelSuppressed=false}:{
  active?:boolean
  revealScene?:()=>void
  /** 打开原生侧栏终端标签；终端生命周期完全由 DSH 原生 owner 持有。 */
  openTerminal?:()=>void
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
  const panelTool=state.tool&&!CANVAS_TOOL_IDS.has(state.tool)?state.tool:null
  const panelRendered=active&&Boolean(panelTool)
  const panelVisible=!panelSuppressed&&panelRendered
  // 缓存原React编辑器座位，不复制Draft/Scene；跨工具开合和暂时取消选择不卸载该owner。
  const retained=useRef<{sessionId?:string;tool:string;children:ReactNode;hidden?:boolean}>()
  if(retained.current?.sessionId!==sessionId)retained.current=undefined
  if(retainedPanel&&(retained.current||panelVisible&&state.tool===retainedPanel.tool))retained.current={sessionId,...retainedPanel}
  const retainedVisible=Boolean(panelVisible&&retainedPanel&&state.tool===retainedPanel.tool&&!retainedPanel.hidden)
  // retained 编辑器可见时，同工具的 active 面板只是空壳（object inspector 的占位）⇒ 不挂载、不占 flex/gap。
  const activeVisible=panelRendered&&!retainedVisible
  // 交给占用者的开合请求（同进程函数，不是端点、不是新状态）；identity 稳定，避免占用者反复登记。
  const reveal=useMemo(()=>({canvas:revealScene,terminal:openTerminal}),[revealScene,openTerminal])
  const deliverableVisible=active&&state.drawer==="deliverable"
  const body=<>
    <div className="lya-wb-main">
      <div className="lya-wb-centre">
        <div className="lya-wb-layer" data-layer="canvas">{centre}</div>
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
    <section className="lya-wb-drawer" hidden={state.drawer!=="deliverable"} style={{height:state.drawerHeight,"--lya-drawer-height":`${state.drawerHeight}px`} as CSSProperties} aria-label={tr("底部抽屉","Bottom drawer")}>
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
    {renderSlot("lyapunov.workbench.session",{sessionId,children:body,reveal},{fallback:body})}
  </section>
}

/** 面板标题：与 rail 的标签同一套词表，避免同一工具两处叫法不同。 */
export function panelTitle(tr:Translate,tool:string):string{
  const zh:Record<string,string>={scene:"场景",environment:"环境",robot:"机器人",object:"物件",camera:"相机",capture:"拍摄",recording:"录制",annotation:"批注",physics:"物理"}
  const en:Record<string,string>={scene:"Scene",environment:"Environment",robot:"Robots",object:"Objects",camera:"Camera",capture:"Capture",recording:"Recording",annotation:"Notes",physics:"Physics"}
  return tr(zh[tool]??tool,en[tool]??tool)
}
