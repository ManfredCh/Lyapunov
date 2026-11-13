/**
 * 工作台自身的槽位契约（声明者是 Lyapunov 工作台，不是 DSH 平台）。
 *
 * 场景画布由工作台呈现，文件与终端由 DSH 原生侧栏标签承载。
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
 * 呈现层开合请求：外壳把"切到文件工作面 / 打开原生终端标签 / 回到画布"的能力交给占用者。
 * 这几个是**同进程的回调函数**（不是端点、不是新状态），占用者只在自己界面里转发点击意图。
 */
export interface WorkbenchReveal {
  canvas?: () => void
  file?: () => void
  terminal?: () => void
  toggleTerminal?: () => void
}

/** 会话级组合座位：占用者用同一个客户端状态包住工作台的中央视图与产物抽屉。 */
export interface WorkbenchSessionOwnerProps extends WorkbenchSurfaceOwnerProps {
  /** 工作台自己的中央视图 + 产物抽屉：占用者必须原样渲染（透传，不复制）。 */
  children?: ReactNode
  /** 占用者提供的工作面当前是否在屏（据实决定是否加载目录，不猜）。 */
  exposed?: boolean
  /** 开合请求（见 WorkbenchReveal）。 */
  reveal?: WorkbenchReveal
}

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    /**
     * 会话级业务状态座位（single/root）：`lyapunov-workspace` 在这里挂**一份**客户端状态
     * （文件草稿 / 保存与冲突）并渲染 `children`，中央视图与消费组件用同一个 context 读它
     * ——不存在"两处渲染＝两个 owner"。未占用时 children 原样透传。
     */
    "lyapunov.workbench.session": {
      kind: "single"
      scope: "session"
      owner: WorkbenchSessionOwnerProps
    }
  }
}
