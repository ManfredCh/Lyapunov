/** 产品 Shell 的方向图像消息使用的是真实 DSH Agent.send/Inbox 目标语义。 */
import { describe, expect, it } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import { AttachmentId } from "@deepseek-ai/dsh-attachment"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { SessionId } from "@deepseek-ai/dsh-session"
import { MockAdapter } from "../../../.upstream/deepseek-harness-20260911-candidate/packages/core/agent-loop/tests/mock-adapter.ts"
import type {} from '../../lyapunov-contracts/src/message-sources.ts'
import { OrientationChecks } from "../src/orientation-check.ts"

async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 300 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 1))
  if (!predicate()) throw new Error("NATIVE_AGENT_NOT_RUNNING")
}

describe("真实原生 Inbox：活动导入把图交下一 step，Stop 清掉待处理图", () => {
  it("send(next-step,true) 持久记录了图像块，user cancel 不把它转成新回合", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter(["hang", "hang"])
      ctx.llm.registerAdapter(["mock"], adapter)
      const agent = await ctx.agentLoop.create(SessionId("orientation-inbox-native"), { provider: "mock", model: "mock" })
      agent.followup(createUserMessage({ content: [{ type: "text", text: "加载资源" }], source: { kind: "user" } }))
      await until(() => agent.status === "running" && adapter.requests.length > 0)
      const image = createUserMessage({
        content: [
          { type: "text", text: "应用自动方向检查：真实图像附件" },
          { type: "image", attachment: { attachmentId: AttachmentId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), mediaType: "image/png", bytes: 156, width: 8, height: 6 } },
        ],
        source: { kind: "lyapunov-orientation" },
      })
      agent.send(image, "next-step", true)
      const splices = agent.session.snapshotEvents().filter(event => event.type === "agent/inbox/spliced")
      const inserted = splices.at(-1)
      expect(inserted?.data.target).toBe("next-step")
      expect(inserted?.data.inserted[0]?.id).toBe(image.id)
      expect(inserted?.data.inserted[0]?.content.some(block => block.type === "image")).toBe(true)
      agent.cancel({ kind: "user" })
      await agent.whenIdle()
      expect(agent.inbox.nextStep).toHaveLength(0)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === "agent/inbox/spliced" && event.data.target === "next-turn" && event.data.inserted.some(message => message.id === image.id))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it("生产 Stop 的 keepInbox=true 后按消息 ID 撤方向图，保留别的待处理用户消息", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter(["hang", "hang"])
      ctx.llm.registerAdapter(["mock"], adapter)
      const agent = await ctx.agentLoop.create(SessionId("orientation-keep-inbox-native"), { provider: "mock", model: "mock" })
      agent.followup(createUserMessage({ content: [{ type: "text", text: "加载资源" }], source: { kind: "user" } }))
      await until(() => agent.status === "running" && adapter.requests.length > 0)
      const image = createUserMessage({ content: [{ type: "text", text: "方向检查图" }], source: { kind: "lyapunov-orientation" } })
      const other = createUserMessage({ content: [{ type: "text", text: "用户后续要求" }], source: { kind: "user" } })
      agent.send(image, "next-step", true)
      agent.send(other, "next-turn", false)
      expect(agent.inbox.nextStep.some(item => item.id === image.id)).toBe(true)
      expect(agent.inbox.nextTurn.some(item => item.id === other.id)).toBe(true)
      agent.cancel({ kind: "user" }, { keepInbox: true })
      expect(agent.inbox.remove(image.id)).toBe(true)
      expect(agent.inbox.nextStep.some(item => item.id === image.id)).toBe(false)
      expect(agent.inbox.nextTurn.some(item => item.id === other.id)).toBe(true)
      agent.cancel({ kind: "user" })
    } finally { await ctx.fiber.dispose() }
  })

  it("空闲会话的 runMaintenance 被原生 Agent.cancel 中止，不依赖 HTTP request.signal", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const agent = await ctx.agentLoop.create(SessionId("orientation-maintenance-native"), { provider: "mock", model: "mock" })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const activity = agent.runMaintenance(async signal => {
        entered()
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        return { aborted: signal.aborted, cause: (signal.reason as { kind?: string } | undefined)?.kind }
      })
      await started
      agent.cancel({ kind: "user" })
      expect(await activity).toEqual({ aborted: true, cause: "user" })
      expect(agent.inbox.nextTurn).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it("空闲拖拽的维护阶段投 next-turn 图像，维护结束后原生 Agent 自动唤醒模型", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter(["hang"])
      ctx.llm.registerAdapter(["mock"], adapter)
      const agent = await ctx.agentLoop.create(SessionId("orientation-drag-wakeup-native"), { provider: "mock", model: "mock" })
      const claimedIds:string[]=[]
      ctx.on("agent/inbox/claimed",({message})=>claimedIds.push(message.id))
      const image = createUserMessage({
        content: [{ type: "text", text: "拖拽方向检查" }, { type: "image", attachment: { attachmentId: AttachmentId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), mediaType: "image/png", bytes: 160, width: 8, height: 6 } }],
        source: { kind: "lyapunov-orientation" },
      })
      await agent.runMaintenance(async signal => { expect(signal.aborted).toBe(false); agent.send(image, "next-turn", true) })
      await until(() => adapter.requests.length > 0)
      expect(agent.status).toBe("running")
      expect(claimedIds).toContain(image.id)
      agent.cancel({ kind: "user" })
      await agent.whenIdle()
    } finally { await ctx.fiber.dispose() }
  })

  it("独立图像 turn 的原生取消产生匹配 aborted 终态，保留用户待办并能同会话继续", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter(["hang", "hang"])
      ctx.llm.registerAdapter(["mock"], adapter)
      const agent = await ctx.agentLoop.create(SessionId("orientation-dedicated-stop-native"), { provider: "mock", model: "mock" })
      const image = createUserMessage({ content: [{ type: "text", text: "独立拖拽方向图" }, { type: "image", attachment: { attachmentId: AttachmentId("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"), mediaType: "image/png", bytes: 160, width: 8, height: 6 } }], source: { kind: "lyapunov-orientation" } })
      const user = createUserMessage({ content: [{ type: "text", text: "用户后续任务" }], source: { kind: "user" } })
      let imageTurn=0
      const ends:Array<{turn:number;kind:string;cause?:string}>=[]
      ctx.on("agent/inbox/claimed",({message,turn})=>{if(message.id===image.id)imageTurn=turn})
      ctx.on("session/event",(session,event)=>{if(session===agent.session&&event.type==="turn/end")ends.push({turn:event.data.turn,kind:event.data.reason.kind,cause:event.data.reason.kind==="aborted"?event.data.reason.reason.kind:undefined})})
      await agent.runMaintenance(async()=>{agent.send(image,"next-turn",true)})
      await until(()=>adapter.requests.length===1&&imageTurn>0)
      agent.send(user,"next-turn",false)
      const boundary=ctx.sessionProjections.stateOf(agent.session,"turnBoundary")
      expect(boundary?.openTurnStartSeq).not.toBeNull()
      expect(boundary?.lastTurn).toBe(imageTurn)
      expect(agent.status).toBe("running")
      agent.cancel({kind:"user"},{keepInbox:true})
      await until(()=>ends.some(end=>end.turn===imageTurn))
      expect(ends.find(end=>end.turn===imageTurn)).toEqual({turn:imageTurn,kind:"aborted",cause:"user"})
      expect(agent.inbox.nextTurn.some(item=>item.id===user.id)).toBe(true)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      agent.followup(createUserMessage({content:[{type:"text",text:"继续"}],source:{kind:"user"}}))
      await until(()=>adapter.requests.length===2)
      expect(agent.status).toBe("running")
      agent.cancel({kind:"user"})
      await agent.whenIdle()
    } finally { await ctx.fiber.dispose() }
  })

  it("真实模型回合仍活跃时，可控时钟超过旧阈值仍准许首次修正和新图终态", async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter(["hang"])
      ctx.llm.registerAdapter(["mock"], adapter)
      const sessionKey="orientation-long-native"
      const agent = await ctx.agentLoop.create(SessionId(sessionKey), { provider: "mock", model: "mock" })
      let now=0
      const timers=new Map<object,{at:number;callback:()=>void}>()
      const clock={setTimeout:(callback:()=>void,delay:number)=>{const timer={unref:()=>{}};timers.set(timer,{at:now+delay,callback});return timer as ReturnType<typeof setTimeout>},clearTimeout:(timer:ReturnType<typeof setTimeout>)=>{timers.delete(timer)}}
      const checks=new OrientationChecks(undefined,120_000,clock)
      const row=checks.begin({sessionKey,sceneId:"native-scene",revision:1,clientId:"native-window",rootEntityIds:["root"],origin:"ui"}).face
      checks.initial(sessionKey,row.checkId,{sceneId:"native-scene",sceneRevision:1,clientId:"native-window",captureId:"before"})
      const image=createUserMessage({content:[{type:"text",text:"请检查图像"},{type:"image",attachment:{attachmentId:AttachmentId("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),mediaType:"image/png",bytes:160,width:8,height:6}}],source:{kind:"lyapunov-orientation"}})
      checks.queued(sessionKey,row.checkId,image.id)
      ctx.on("agent/inbox/claimed",({message,turn})=>{if(message.id===image.id)checks.claimed(sessionKey,message.id,turn)})
      ctx.on("session/event",(session,event)=>{if(session===agent.session&&event.type==="turn/end")checks.endTurn(sessionKey,event.data.turn,event.data.reason)})
      await agent.runMaintenance(async()=>{agent.send(image,"next-turn",true)})
      await until(()=>adapter.requests.length===1&&checks.get(sessionKey,row.checkId)?.status==="checking")
      now+=230_000
      for(const [timer,task] of [...timers])if(task.at<=now){timers.delete(timer);task.callback()}
      expect(agent.status).toBe("running")
      expect(checks.get(sessionKey,row.checkId)?.status).toBe("checking")
      checks.reserveAdjustment(sessionKey,row.checkId,"asset")
      checks.applied(sessionKey,row.checkId,"asset",2)
      checks.observed(sessionKey,{sceneId:"native-scene",sceneRevision:2,clientId:"native-window",captureId:"after"})
      expect(checks.finish(sessionKey,row.checkId,"corrected","after").status).toBe("corrected")
      agent.cancel({kind:"user"})
      await agent.whenIdle()
      expect(checks.get(sessionKey,row.checkId)?.status).toBe("corrected")
    } finally { await ctx.fiber.dispose() }
  })
})
