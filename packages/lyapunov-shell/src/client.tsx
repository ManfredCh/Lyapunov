/** 产品客户端：原生对话保持在主列，3D和文件使用原生标签工作区。 */
import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client"
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type {} from "@deepseek-ai/dsh-client-locale/client"
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client"
import {applyProductUI} from "./product-ui.tsx"
import {applyDomainCommandCards} from "./domain-command-card.tsx"
import {applyPreferencesClient} from "./preferences-client.tsx"
import {registerNativeWorkspace} from "./native-workspace.tsx"
import {applyBalanceSection} from "./balance-section.tsx"
import {applyEngineSettings} from "./engine-settings.tsx"
import {applyExternalToolsSettings} from "./external-tools-settings.tsx"
import {applyExecutionGraphClient} from "./execution-graph-client.tsx"
import {applyFilesNavigationClient} from "./files-navigation-client.tsx"

declare module "@deepseek-ai/dsh-client-ui-slots" {
 interface LocaleNamespaceMap {lyapunov:"open"|"sceneTab"|"balance"|"credits"|"refresh"|"openAccount"|"signinHint"|"devHint"}
}
export const inject=["slots","locale","configForms","layout","sidebarRightTabs","sidebarRight","sessions","workspaces","uiWorkspace"]
export function apply(ctx:Context){
 applyProductUI(ctx)
 applyPreferencesClient(ctx)
 ctx.effect(()=>ctx.locale.register("lyapunov",{
  zh:{open:"场景工作台",sceneTab:"3D 场景",balance:"余额",credits:"可用点数",refresh:"刷新",openAccount:"打开账户",signinHint:"登录正式账户后在此显示余额。",devHint:"开发者模式不显示消费者余额。"},
  en:{open:"Scene workbench",sceneTab:"3D scene",balance:"Balance",credits:"Available credits",refresh:"Refresh",openAccount:"Open account",signinHint:"Sign in with a formal account to see your balance here.",devHint:"Developer mode does not show consumer balance."},
 }))
 applyDomainCommandCards(ctx)
 registerNativeWorkspace(ctx)
 applyBalanceSection(ctx)
 applyEngineSettings(ctx)
 applyExternalToolsSettings(ctx)
 applyExecutionGraphClient(ctx)
 applyFilesNavigationClient(ctx)
}
