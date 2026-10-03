/** 场景标签声明工作台子槽位；标签和会话归属由DSH原生工作区管理。 */
import type {ChildrenDecl} from "@deepseek-ai/dsh-client-ui-slots"
/** 工作台自己声明的子槽位：注册方声明＝独占渲染权，只有我们 renderSlot。 */
export const WORKBENCH_CHILDREN:ChildrenDecl={
  "lyapunov.workbench.session":{kind:"single",scope:"session"},
  "lyapunov.workbench.centre":{kind:"keyed",scope:"session"},
  "lyapunov.workbench.drawer":{kind:"keyed",scope:"session"},
}
