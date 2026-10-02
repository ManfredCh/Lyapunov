import type {ISessions} from "@deepseek-ai/dsh-api-session-controller/client"
import type {IConversation} from "@deepseek-ai/dsh-client-ui-conversation/client"
import type {DesktopBridge} from "./bridge.ts"
export const name="lyapunov-desktop-lifecycle-client"
export const inject=["sessions","conversation"]

/** 读取/取消原生会话；聊天草稿继续由原生 Conversation store 的持久镜像管理。 */
export function apply(ctx:{sessions:ISessions;conversation:IConversation;effect:(setup:()=>()=>void,label:string)=>unknown}){
  const desktop=(window as unknown as {lyapunovDesktop?:DesktopBridge}).lyapunovDesktop
  if(!desktop?.registerExitParticipant)return
  const currentInput=()=>{
    const selected=ctx.sessions.list.getSnapshot().current
    const scope=selected?ctx.sessions.scope(selected):undefined
    return scope?{id:selected!,input:ctx.conversation.input.for(scope)}:undefined
  }
  ctx.effect(()=>desktop.registerExitParticipant("native-sessions",{
    summary:()=>{
      const list=ctx.sessions.list.getSnapshot(),current=currentInput()
      const running=list.ids.filter(id=>list.byId[id]?.running).length
      const jobs=Object.values(list.jobsBySession).flat().filter(job=>job.status==="running"||job.status==="stopping").length
      return {dirtyDrafts:current&&(current.input.state.getSnapshot().draft.trim()||current.input.state.getSnapshot().attachmentIds.length)?1:0,runningActions:running+jobs}
    },
    flush:async()=>{
      const current=currentInput()
      if(!current)return
      const draft=current.input.state.getSnapshot()
      if(draft.attachmentIds.length)throw new Error("还有未发送附件，请先发送或移除后退出；附件没有被假称保存。")
      if(!draft.draft)return
      const persisted=localStorage.getItem(`dsh.conversation.${current.id}`)
      if(!persisted||JSON.parse(persisted).draft!==draft.draft)throw new Error("聊天草稿的原生持久镜像未确认，请保留窗口后重试。")
    },
    stop:async()=>{
      const list=ctx.sessions.list.getSnapshot()
      for(const id of list.ids){
        if(!list.byId[id]?.running)continue
        const binding=ctx.sessions.binding(id)
        if(!binding)throw new Error("正在运行的会话没有可用原生绑定")
        const result=await binding.session.cancel()
        if(!result.ok)throw new Error(result.error.message)
      }
    },
  }),"desktop native Session exit")
}
