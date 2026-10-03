/**
 * 右侧固定工具栏（PLAN §三.5）：工作台最右，宽屏 60px、窄屏 46px，三种模式都在。
 *
 * 上组是工具（场景/环境/机器人/物体/相机/素材，点击开合工作面上的工具面板列），下组是工作面入口
 * （文件＝中央视图切到文件工作面；终端/产物＝底部抽屉）。窄屏收成紧凑图标列：短标签隐藏，
 * 可访问名称（aria-label）与 tooltip（title）保留。
 *
 * 标签规则：按钮里那行标签必须放得进按钮（中文用完整短词；英文用缩写），完整名称始终在
 * aria-label/title 里。标签只允许在按钮内省略，不允许横向溢出到按钮外。
 *
 * 这里只发展示状态命令；面板内容由 work-surface 负责，场景/world 数据仍属于既有 host 所有者。
 */
import {WorkbenchIcon} from "./vendor/tabler/icons.tsx"
import type {Translate} from "./entity-editor.tsx"
import {useWorkbenchUI,type ToolId} from "./workbench-ui.ts"

/**
 * 每个入口两个名字：`zh`/`en` 是完整名称（aria-label 与 tooltip），`zh`/`shortEn` 是
 * 按钮里那行可见标签。中文本来就短；英文在 60px 宽的按钮里换成公认缩写，
 * 完整词始终留在 tooltip/可访问名称里，任何宽度都不横向溢出。
 */
type RailEntry={id:ToolId|"engine"|"file"|"terminal"|"deliverable";zh:string;en:string;shortEn:string;group:"tool"|"work"}

// 工具轨按存储分域列入口：场景（worlds/scenes）、物件（assets）、环境（worlds/environments）、
// 机器人（robots）、素材（聚合库）。五个入口与磁盘上的域目录一一对应，避免“只有素材看得到”。
// 批注不是存储域，而是**画布上的操作模式**（落点锚在实体上、文字是人的说明），入口紧跟相机之后。
const ENTRIES:RailEntry[]=[
  {id:"scene",zh:"场景",en:"Scene",shortEn:"Scene",group:"tool"},
  {id:"object",zh:"物件",en:"Objects",shortEn:"Object",group:"tool"},
  {id:"environment",zh:"环境",en:"Environment",shortEn:"Env",group:"tool"},
  {id:"robot",zh:"机器人",en:"Robot",shortEn:"Robot",group:"tool"},
  {id:"camera",zh:"相机",en:"Camera",shortEn:"Camera",group:"tool"},
  {id:"annotation",zh:"批注",en:"Annotations",shortEn:"Note",group:"tool"},
  {id:"asset",zh:"素材",en:"Assets",shortEn:"Library",group:"tool"},
  // 引擎切换与"文件"并列（用户要求"在 IDE 旁边加一个一模一样的按钮"）：同一套渲染与可访问名，
  // 不新造第二种按钮外观。它不是工具面板，而是**一个唯一的设置项**：写引擎偏好。
  {id:"engine",zh:"引擎",en:"Engine",shortEn:"Engine",group:"work"},
  {id:"file",zh:"文件",en:"Files",shortEn:"Files",group:"work"},
  {id:"terminal",zh:"终端",en:"Terminal",shortEn:"Term",group:"work"},
  {id:"deliverable",zh:"产物",en:"Outputs",shortEn:"Outputs",group:"work"},
]


export function ToolRail({tr,compact=false,nativeSceneActive,revealScene,openFiles,openTerminal,engine,onSwitchEngine}:{tr:Translate;compact?:boolean;nativeSceneActive?:boolean;revealScene?:()=>void;openFiles?:()=>void;openTerminal?:()=>void;engine?:string;onSwitchEngine?:(next:"isaac"|"mujoco")=>void}){
  const ui=useWorkbenchUI()
  const state=ui.getSnapshot()
  const render=(entry:RailEntry)=>{
    // 引擎按钮的可见标签带当前引擎名（中文短、英文也是公认词），完整名称仍在 aria-label/title。
    const currentEngine=engine==="isaac"?"Isaac":engine==="mujoco"?"MuJoCo":engine||"—"
    // 可见标签：中文用完整短词、英文用缩写（文件头既定规则）；引擎按钮显示**当前引擎名**。
    // 每个入口都渲染自己的标签——此前只有引擎按钮渲染，会让其余按钮看起来是空按钮。
    const label=entry.id==="engine"?tr(`物理引擎：${currentEngine}（点击切换）`,`Physics engine: ${currentEngine} (click to switch)`):tr(entry.zh,entry.en)
    const shortLabel=entry.id==="engine"?currentEngine:tr(entry.zh,entry.shortEn)
    const active=(nativeSceneActive??(state.mode!=="chat"))&&(entry.group==="tool"?state.tool===entry.id
      :entry.id==="file"?state.centre==="file"
      :entry.id==="engine"?false
      :state.drawer===entry.id)
    return <button
      key={entry.id}
      type="button"
      className="lya-rail-item"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-engine={entry.id==="engine"?engine:undefined}
      onClick={()=>{
        if(entry.id==="engine"){onSwitchEngine?.(engine==="isaac"?"mujoco":"isaac");return}
        if(entry.id==="file"&&openFiles){openFiles();return}
        if(entry.id==="terminal"&&openTerminal){openTerminal();return}
        revealScene?.()
        if(entry.group==="tool"){
          if(nativeSceneActive===false)ui.openTool(entry.id as ToolId)
          else ui.toggleTool(entry.id as ToolId)
        }else if(entry.id==="file")ui.toggleCentre("file")
        else if(nativeSceneActive===false)ui.showDrawer(entry.id==="terminal"?"terminal":"deliverable")
        else ui.toggleDrawer(entry.id==="terminal"?"terminal":"deliverable")
      }}
    >
      <WorkbenchIcon id={entry.id} size={16}/>
      <span className="lya-rail-label">{shortLabel}</span>
    </button>
  }
  // data-group-label 只把既有的两组分组写进 DOM 给 CSS 当分组小标题用（窄栏隐藏），
  // 分组本身与按钮顺序不变，aria-label/title/aria-pressed 仍由上面每个入口各自提供。
  return <nav className="lya-rail" data-compact={compact||undefined} aria-label={tr("工作台工具","Workbench tools")}>
    <div className="lya-rail-group" data-group-label={tr("工具","Tools")}>{ENTRIES.filter(item=>item.group==="tool").map(render)}</div>
    <div className="lya-rail-group lya-rail-bottom" data-group-label={tr("工作面","Surfaces")}>{ENTRIES.filter(item=>item.group==="work").map(render)}</div>
  </nav>
}
