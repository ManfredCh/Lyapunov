/**
 * Tabler Icons（MIT），按需保留原始图形：内容/采集入口（第 12–14 枚 capture/recording/physics 为 RC 新增）。
 * 来源与许可见同目录 LICENSE 和 SOURCE.json。
 *
 * 例外：`annotation`（Notes）自 P14 起为用户确认的 **Lyapunov 自绘**图形（单一路径，非 Tabler 原图），
 * 几何来自 `@lyapunov/contracts` 的 `note-icon.ts`，与三维场景标记/截图叠加共用同一份路径；
 * 其余 13 枚仍是 Tabler 原图，许可与来源不变。
 */
import {NOTE_ICON_PATH,NOTE_ICON_TOOLBAR_STROKE_WIDTH} from "../../../../lyapunov-contracts/src/note-icon.ts"
export type WorkbenchIconId = 'scene'|'environment'|'robot'|'object'|'camera'|'capture'|'recording'|'physics'|'asset'|'file'|'terminal'|'deliverable'|'engine'|'annotation'
/**
 * 各入口共用同一套几何：24 网格、1.7 线宽、圆头端点与圆角连接，只有尺寸可调，
 * 因此图标放到标题栏（size=18）时与 66px 工具栏里的视觉重量、圆角、对齐一致。
 * 路径数据逐字节等于 vendor 下来的 Tabler 原始图形（映射表见 SOURCE.json 的 icons）；
 * `annotation` 除外：它消费共享的 Lyapunov 自绘路径，并把线宽改为确认稿的 1.65。
 * `data-icon` 只暴露“这一个是哪一枚”，供验收与样式定位；不影响 id/aria-label/点击顺序。
 * `data-icon-library` 标明该枚图形的来路（tabler / lyapunov），不参与布局与交互。
 */
export function WorkbenchIcon({id,size=22}:{id:WorkbenchIconId;size?:number}) {
 const common={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,focusable:"false" as const,"aria-hidden":true,"data-icon":id,"data-icon-library":"tabler"}
 switch(id){
  case "scene":return <svg {...common}><path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5"/><path d="M12 12l8 -4.5"/><path d="M12 12l0 9"/><path d="M12 12l-8 -4.5"/></svg>
  case "environment":return <svg {...common}><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/></svg>
  case "robot":return <svg {...common}><path d="M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2"/><path d="M9 16c1 .667 2 1 3 1s2 -.333 3 -1"/><path d="M9 7l-1 -4"/><path d="M15 7l1 -4"/><path d="M9 12v-1"/><path d="M15 12v-1"/></svg>
  case "object":return <svg {...common}><path d="M19.875 6.27c.7 .398 1.13 1.143 1.125 1.948v7.284c0 .809 -.443 1.555 -1.158 1.948l-6.75 4.27a2.27 2.27 0 0 1 -2.184 0l-6.75 -4.27a2.23 2.23 0 0 1 -1.158 -1.948v-7.285c0 -.809 .443 -1.554 1.158 -1.947l6.75 -3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98l-.033 0"/><path d="M15.5 9.422c.312 .18 .503 .515 .5 .876v3.277c0 .364 -.197 .7 -.515 .877l-3 1.922a1 1 0 0 1 -.97 0l-3 -1.922a1 1 0 0 1 -.515 -.876v-3.278c0 -.364 .197 -.7 .514 -.877l3 -1.79c.311 -.174 .69 -.174 1 0l3 1.79h-.014l0 .001"/></svg>
  case "camera":return <svg {...common}><path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2"/><path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>
  case "capture":return <svg {...common}><path d="M12 20h-7a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v3.5"/><path d="M16 19h6"/><path d="M19 16v6"/><path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>
  case "recording":return <svg {...common}><path d="M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/></svg>
  case "physics":return <svg {...common}><path d="M21 12h-2c-.894 0 -1.662 -.857 -1.761 -2c-.296 -3.45 -.749 -6 -2.749 -6s-2.5 3.582 -2.5 8s-.5 8 -2.5 8s-2.452 -2.547 -2.749 -6c-.1 -1.147 -.867 -2 -1.763 -2h-2"/></svg>
  case "asset":return <svg {...common}><path d="M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2"/></svg>
  case "file":return <svg {...common}><path d="M15 3v4a1 1 0 0 0 1 1h4"/><path d="M18 17h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h4l5 5v7a2 2 0 0 1 -2 2"/><path d="M16 17v2a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h2"/></svg>
  case "terminal":return <svg {...common}><path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"/></svg>
  case "engine":return <svg {...common}><path d="M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -12"/><path d="M9 9h6v6h-6l0 -6"/><path d="M3 10h2"/><path d="M3 14h2"/><path d="M10 3v2"/><path d="M14 3v2"/><path d="M21 10h-2"/><path d="M21 14h-2"/><path d="M14 21v-2"/><path d="M10 21v-2"/></svg>
  case "deliverable":return <svg {...common}><path d="M12 4l-8 4l8 4l8 -4l-8 -4"/><path d="M4 12l8 4l8 -4"/><path d="M4 16l8 4l8 -4"/></svg>
  case "annotation":return <svg {...common} strokeWidth={NOTE_ICON_TOOLBAR_STROKE_WIDTH} data-icon-library="lyapunov"><path d={NOTE_ICON_PATH}/></svg>
 }
}
