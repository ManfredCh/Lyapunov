/**
 * 文件与终端插件的客户端入口。
 *
 * 业务状态只有一份，在 `workspace-session.tsx`；这里只做**座位登记**：
 * - `lyapunov.workbench.session`：会话级状态座位，把同一份状态包住工作台的中央视图与抽屉；
 * - `lyapunov.workbench.centre` key `file`：中央的文件编辑工作面；
 * - `lyapunov.workbench.drawer` key `terminal`：底部抽屉里的同一个真实终端；
 * 原生设置导航保留；不再增加“文件与终端”自定义设置入口，运行时仍消费既有偏好。
 *
 * 文件与终端的**唯一入口**是工作台最右工具栏（文件 / 终端 / 产物）：不再往输入区放
 * "Files & terminal" 旧大入口——那是工作台出现之前的浮层时代快捷方式，现在同一动作
 * 只在一处。工作台侧槽位由 lyapunov-shell 声明并渲染；未加载工作台时这里的注册不会激活，
 * 也不会偷偷另开一个浮层。
 */
import {registerDocumentExitParticipant,type DocumentExitBridge} from './native-documents.ts'
import {registerWorkspaceTabs} from "./native-workspace-tabs.tsx"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client"
import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type {} from "@deepseek-ai/dsh-client-locale/client"
import type {SettingsScope} from "@deepseek-ai/dsh-client-ui-settings/client"
import type {ISessions} from "@deepseek-ai/dsh-api-session-controller/client"
import type {} from "../../lyapunov-contracts/src/workbench-slots.ts"
import {WORKSPACE_PREFERENCES,type WorkspacePreferences} from "./preferences.ts"
import {addSelectionToContext} from "./selection-context.ts"
import {WorkspaceSession,WorkspaceSessionProvider,FileSurface,TerminalPanel} from "./workspace-session.tsx"
import type {WorkspaceSurface} from "./workspace-session.tsx"
export {WorkspaceSession} from "./workspace-session.tsx"
declare module "@deepseek-ai/dsh-client-ui-slots"{interface LocaleNamespaceMap{lyapunovWorkspace:"open"|"unmounted"}}
export const inject=["slots","locale","sidebarRightTabs","sidebarRight"]

export function apply(ctx:Context){
  ctx.effect(()=>registerDocumentExitParticipant(typeof window==='undefined'?undefined:window.lyapunovDesktop as unknown as DocumentExitBridge|undefined),'lyapunov-workspace: real editor exit participant')
  // `open` 仍是自包含复合体（WorkspaceSession）自己的标题，也是本包判断当前语言的探针
  // （与其他插件同一套做法）；工作台里不再有输入区入口，dockHint/dockUnavailable 已撤掉。
  ctx.effect(()=>ctx.locale.register("lyapunovWorkspace",{
    zh:{open:"文件与终端",unmounted:"工作区状态未挂载：请确认工作台插件已加载。"},
    en:{open:"Files & terminal",unmounted:"Workspace state is not mounted; make sure the workbench plugin is loaded."},
  }))
  ctx.inject(["settingsScope","sessions","conversation"],owner=>{
    const scope=owner.settingsScope.bind<WorkspacePreferences>({namespace:WORKSPACE_PREFERENCES}),sessions=owner.get("sessions") as unknown as ISessions
    const surface:WorkspaceSurface={scope,navigateFiles:options=>options.section==="search"||options.section==="review"||options.picker||options.newWorktree?owner.sidebarRight.openTab("lyapunov.workspace.tools",{params:options}):owner.sidebarRight.openTab("files"),current:id=>sessions.list.getSnapshot().current===id,addSelection:(id,selection)=>addSelectionToContext(owner,id,selection)}
    registerWorkspaceTabs(owner,surface)
    owner.slots.inject("lyapunov.workbench.session",()=>owner.slots.register({
      name:"lyapunov.workbench.session",registrant:"lyapunov-workspace",locale:"lyapunovWorkspace",
      inject:()=>({surface}),
    },WorkspaceSessionProvider))
    owner.slots.inject("lyapunov.workbench.centre",()=>owner.slots.register({
      name:"lyapunov.workbench.centre",key:"file",registrant:"lyapunov-workspace",locale:"lyapunovWorkspace",
    },FileSurface))
    owner.slots.inject("lyapunov.workbench.drawer",()=>owner.slots.register({
      name:"lyapunov.workbench.drawer",key:"terminal",registrant:"lyapunov-workspace",locale:"lyapunovWorkspace",
    },TerminalPanel))
  })
}
