/**
 * 工作台自身的槽位契约（声明者是 Lyapunov 工作台，不是 DSH 平台）。
 *
 * 中央工作区分成三块内容：画布（固定入口，属于 lyapunov-shell）、文件编辑工作面与底部抽屉里的
 * 终端（属于 lyapunov-workspace）。两个客户端插件各自打包，跨插件复用同一份呈现只能用槽位，
 * 不能互相 import 源码（那会把同一份业务打进两个 bundle，等于复制）。
 *
 * 槽位由工作台的注册项声明（与原生 ui-conversation 用 `main` key `conversation` 声明
 * `main.conversation` 的做法一致），工作台在自己的布局里渲染它们；注册方只贡献呈现，
 * 会话/草稿/终端等状态仍由各自现有所有者持有。
 */
import type {ReactNode} from "react"
import type {} from "@deepseek-ai/dsh-client-ui-slots"

/** 工作台内容槽位的 owner 参数：当前会话 id（根作用域槽位不会自动注入会话）。 */
export interface WorkbenchSurfaceOwnerProps {
  /** 当前会话；没有会话时内容槽位不渲染。 */
  sessionId?: string
  /**
   * 该工作面当前是否在屏。宿主**常驻挂载**（切走只 `hidden` 不卸载），所以占用者不能用
   * 挂载/卸载判断可见性：轮询、订阅这类"只在看得见时才做"的事要读这个参数。
   */
  visible?: boolean
}

/**
 * 呈现层开合请求：外壳把"切到文件工作面 / 打开终端抽屉 / 回到画布"的能力交给占用者。
 * 这几个是**同进程的回调函数**（不是端点、不是新状态），占用者只在自己界面里转发点击意图。
 */
export interface WorkbenchReveal {
  canvas?: () => void
  file?: () => void
  terminal?: () => void
  toggleTerminal?: () => void
}

/** 会话级组合座位：占用者用同一个客户端状态包住工作台的中央视图与抽屉。 */
export interface WorkbenchSessionOwnerProps extends WorkbenchSurfaceOwnerProps {
  /** 工作台自己的中央视图 + 底部抽屉：占用者必须原样渲染（透传，不复制）。 */
  children?: ReactNode
  /** 占用者提供的工作面当前是否在屏（据实决定是否加载目录/轮询终端，不猜）。 */
  exposed?: boolean
  /** 开合请求（见 WorkbenchReveal）。 */
  reveal?: WorkbenchReveal
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /**
     * 会话级业务状态座位（single/root）：`lyapunov-workspace` 在这里挂**一份**客户端状态
     * （文件草稿 / 保存与冲突 / 终端选择）并渲染 `children`，中央视图与抽屉里的两个消费组件
     * 用同一个 context 读它——不存在"两处渲染＝两个 owner"。未占用时 children 原样透传。
     */
    "lyapunov.workbench.session": {
      kind: "single"
      scope: "session"
      owner: WorkbenchSessionOwnerProps
    }
    /**
     * 中央工作区的主视图，按 key 派发：`file` 是文件编辑工作面（lyapunov-workspace 提供）。
     * 场景画布不走这里——它是工作台自己的固定入口。
     */
    "lyapunov.workbench.centre": {
      kind: "keyed"
      scope: "session"
      owner: WorkbenchSurfaceOwnerProps
    }
    /**
     * 底部抽屉内容，按 key 派发：`terminal` 是真实终端（lyapunov-workspace 提供，
     * host ctx.terminals 的同一个 PTY 会话，切换只换渲染位置）。
     */
    "lyapunov.workbench.drawer": {
      kind: "keyed"
      scope: "session"
      owner: WorkbenchSurfaceOwnerProps
    }
  }
}
