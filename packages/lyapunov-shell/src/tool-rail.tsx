/**
 * 右侧固定工具栏（PLAN §三.5）：工作台最右，宽屏 60px、窄屏 46px，三种模式都在。
 *
 * 上组是内容/采集工具：Scene（场景与组成）、Objects（物件清单）、Environment（环境与光照）、
 * Robots（机器人）、Camera（机器人机位）、Capture（自由视角）、Recording（记录作业）、Notes（批注）。
 * 下组是运行与工作面：Physics（物理世界独立配置）、当前引擎（单击切换偏好）、Files、Terminal、Outputs。
 * Physics 与其余工具一样开工作面上的面板；它放在下组是因为它描述**运行环境**而不是内容编辑。
 *
 * 窄屏收成紧凑图标列：短标签隐藏，可访问名称（aria-label）与 tooltip（title）保留。
 * 标签规则：按钮里那行标签必须放得进按钮（中文用完整短词；英文用缩写），完整名称始终在
 * aria-label/title 里。标签只允许在按钮内省略，不允许横向溢出到按钮外。
 *
 * 这里只发展示状态命令；面板内容由 work-surface 负责，场景/world 数据仍属于既有 host 所有者。
 */
import {WorkbenchIcon,type WorkbenchIconId} from "./vendor/tabler/icons.tsx"
import type {Translate} from "./entity-editor.tsx"
import {useWorkbenchUI,type ToolId} from "./workbench-ui.ts"

/**
 * 每个入口两个名字：`zh`/`en` 是完整名称（aria-label 与 tooltip），`zh`/`shortEn` 是
 * 按钮里那行可见标签。中文本来就短；英文在 60px 宽的按钮里换成公认缩写，
 * 完整词始终留在 tooltip/可访问名称里，任何宽度都不横向溢出。
 *
 * `group` 只决定视觉分组（上组内容/采集，下组运行/工作面）；`behavior` 才决定点击做什么——
 * Physics 在下组但仍是**工具面板**，引擎是偏好切换，Files/Terminal/Outputs 是工作面/抽屉。
 * 泛用 `Library`（旧 `asset`）不再是一级轨项（R-008）：GLB 归 Objects、XML 机器人归 Robots、
 * 环境资源归 Environment，导入/复用从各域进入。
 */
export type RailBehavior="tool"|"engine"|"surface"
export interface RailEntry{id:ToolId|"engine"|"file"|"terminal"|"deliverable";zh:string;en:string;shortEn:string;group:"tool"|"work";behavior:RailBehavior;/** id 不在 WorkbenchIconId 白名单内时才给：图标沿用既有 id 而不是为单个入口扩图标库。 */ icon?:WorkbenchIconId}

export const RAIL_ENTRIES:readonly RailEntry[]=[
  {id:"scene",zh:"场景",en:"Scene",shortEn:"Scene",group:"tool",behavior:"tool"},
  {id:"object",zh:"物件",en:"Objects",shortEn:"Objects",group:"tool",behavior:"tool"},
  {id:"environment",zh:"环境",en:"Environment",shortEn:"Env",group:"tool",behavior:"tool"},
  {id:"robot",zh:"机器人",en:"Robots",shortEn:"Robots",group:"tool",behavior:"tool"},
  {id:"camera",zh:"相机",en:"Camera",shortEn:"Camera",group:"tool",behavior:"tool"},
  {id:"capture",zh:"拍摄",en:"Capture",shortEn:"Capture",group:"tool",behavior:"tool"},
  {id:"recording",zh:"录制",en:"Recording",shortEn:"Recording",group:"tool",behavior:"tool"},
  {id:"annotation",zh:"批注",en:"Notes",shortEn:"Notes",group:"tool",behavior:"tool"},
  // 运行环境与工作面（下组）：Physics 仍是工具面板，引擎是**唯一的偏好切换**（单击，不新造设置页）。
  {id:"physics",zh:"物理",en:"Physics",shortEn:"Physics",group:"work",behavior:"tool"},
  // Campaign 描述 agent 运行（worker/verifier 循环），归运行组；无同名图标，沿用 terminal 读作“代理执行”。
  {id:"campaign",zh:"巡检",en:"Campaigns",shortEn:"Camp",group:"work",behavior:"tool",icon:"terminal"},
  {id:"engine",zh:"引擎",en:"Engine",shortEn:"Engine",group:"work",behavior:"engine"},
  {id:"file",zh:"文件",en:"Files",shortEn:"Files",group:"work",behavior:"surface"},
  {id:"terminal",zh:"终端",en:"Terminal",shortEn:"Terminal",group:"work",behavior:"surface"},
  {id:"deliverable",zh:"产物",en:"Outputs",shortEn:"Outputs",group:"work",behavior:"surface"},
]


export function ToolRail({tr,compact=false,nativeSceneActive,revealScene,openFiles,openTerminal,engine,preference,onSwitchEngine}:{tr:Translate;compact?:boolean;nativeSceneActive?:boolean;revealScene?:()=>void;openFiles?:()=>void;openTerminal?:()=>void;engine?:string;preference?:string;onSwitchEngine?:(next:"isaac"|"mujoco")=>void}){
  const ui=useWorkbenchUI()
  const state=ui.getSnapshot()
  const render=(entry:RailEntry)=>{
    // 运行中的引擎只用于“当前状态”短说明；切换的**下一次动作**一律按最新保存偏好计算，
    // 否则运行 MuJoCo 时两次点击都会请求 Isaac（旧缺陷 R-009）。
    const runningEngine=engine==="isaac"?"Isaac":engine==="mujoco"?"MuJoCo":engine||"—"
    const savedEngine=preference==="isaac"?"Isaac":preference==="mujoco"?"MuJoCo":undefined
    const label=entry.id==="engine"
      ?savedEngine?tr(`物理引擎：运行 ${runningEngine}，已保存偏好 ${savedEngine}（点击切换偏好）`,`Physics engine: running ${runningEngine}, saved preference ${savedEngine} (click to change preference)`)
        :tr(`物理引擎：${runningEngine}（点击切换偏好）`,`Physics engine: ${runningEngine} (click to change preference)`)
      :tr(entry.zh,entry.en)
    const shortLabel=entry.id==="engine"?runningEngine:tr(entry.zh,entry.shortEn)
    const active=(nativeSceneActive??(state.mode!=="chat"))&&(
      entry.behavior==="tool"?state.tool===entry.id&&state.centre==="canvas"
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
      data-engine-preference={entry.id==="engine"?preference:undefined}
      data-rail-behavior={entry.behavior}
      onClick={()=>{
        if(entry.behavior==="engine"){const base=preference==="isaac"||preference==="mujoco"?preference:engine;onSwitchEngine?.(base==="isaac"?"mujoco":"isaac");return}
        if(entry.id==="file"&&openFiles){openFiles();return}
        if(entry.id==="terminal"&&openTerminal){openTerminal();return}
        revealScene?.()
        if(entry.behavior==="tool"){
          if(nativeSceneActive===false)ui.openTool(entry.id as ToolId)
          else ui.toggleTool(entry.id as ToolId)
        }else if(entry.id==="file")ui.toggleCentre("file")
        else if(nativeSceneActive===false)ui.showDrawer(entry.id==="terminal"?"terminal":"deliverable")
        else ui.toggleDrawer(entry.id==="terminal"?"terminal":"deliverable")
      }}
    >
      <WorkbenchIcon id={entry.icon??(entry.id as WorkbenchIconId)} size={16}/>
      <span className="lya-rail-label">{shortLabel}</span>
    </button>
  }
  // data-group-label 只把既有的两组分组写进 DOM 给 CSS 当分组小标题用（窄栏隐藏），
  // 分组本身与按钮顺序不变，aria-label/title/aria-pressed 仍由上面每个入口各自提供。
  // P17：工具轨一律图标化（宽屏也不在图标下铺文字）；data-compact 标记它当前是“图标/紧凑”态，
  // 分组、按钮顺序与每个入口自己的 aria-label/title/aria-pressed 不变。
  return <nav className="lya-rail" data-compact={compact?"compact":"icon"} aria-label={tr("工作台工具","Workbench tools")}>
    <div className="lya-rail-group" data-group-label={tr("工具","Tools")}>{RAIL_ENTRIES.filter(item=>item.group==="tool").map(render)}</div>
    <div className="lya-rail-group lya-rail-bottom" data-group-label={tr("运行与工作面","Runtime and surfaces")}>{RAIL_ENTRIES.filter(item=>item.group==="work").map(render)}</div>
  </nav>
}
