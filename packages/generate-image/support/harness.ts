/**
 * 插件级测试装配：**真** cordis Context + 真 AgentLoop/AgentRegistry（后台作业要有活 owner）
 * + 真 jobs-local + 真附件服务 + 真 credentials（grant 落盘）+ 真 userQuestions（可脚本化应答），
 * 再挂上 `../../src/plugin.ts` 的工具。供应商侧是本地夹具 HTTP 服务（见 dashscope-stub.ts）。
 */
import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import AttachmentLocal from "@deepseek-ai/dsh-attachment-local"
import CredentialsLocal from "@deepseek-ai/dsh-credentials-local"
import UserQuestions from "@deepseek-ai/dsh-user-questions"
import { SessionId } from "@deepseek-ai/dsh-session"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apply } from "../src/plugin.ts"

export interface ToolCall {
  isError?: boolean
  value?: { result?: string }
  content?: Array<{ type: string; text?: string; attachment?: unknown }>
}

export interface AskedQuestion {
  id: string
  header?: string
  question: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
}

export interface InboxMessage {
  content: Array<{ type: string; text?: string; attachment?: unknown }>
  source?: { kind?: string; plugin?: string; form?: string; summary?: string }
}

export interface Harness {
  ctx: Context
  agent: Agent
  /** 问题真的被问过几次、问的是什么（弹窗文本取自这里）。 */
  asked: AskedQuestion[]
  /** 用户对接下来每个问题怎么答：给选项 label；不设（undefined）= 没有应答方（原生 NO_PROVIDER）。 */
  respondWith(label?: string): void
  /** 真附件服务实际保存的图片名（真图才存得下）。 */
  images: string[]
  call(args: Record<string, unknown>, options?: { signal?: AbortSignal; caller?: Agent }): Promise<ToolCall>
  createAgent(id: string, cwd?: string): Promise<Agent>
  claimNextStep(agent?: Agent): InboxMessage[]
  pending(agent?: Agent): { nextStep: number; nextTurn: number }
  dispose(): Promise<void>
}

export interface HarnessOptions {
  /** 开发直连的供应商地址；正式模式（mode:"formal"）下由中央路由决定入口，不需要它。 */
  baseURL?: string
  dataDirectory: string
  apiKey?: string
  model?: string
  pollIntervalMs?: number
  /** 轮询上限（用例要让"任务还在跑"这条路径停下来时显式给个小数）。 */
  pollAttempts?: number
  /** 默认 false：必须走原生授权；个别用例显式放行。 */
  allowPaidSubmission?: boolean
  cwd?: string
  /** false 用来验证"没装 attachments 时结果如实报没送到"。 */
  attachments?: boolean
  /** false 用来验证"没有原生用户问题交互时明确拒绝，而不是静默提交"。 */
  questions?: boolean
  /** false 用来验证"没有 grant 存储时明确拒绝"。 */
  credentials?: boolean
  /** 正式模式：请求经中央账户网关（accountApiUrl/accountToken），本机不带供应商 key。 */
  mode?: "formal" | "developer"
  accountApiUrl?: string
  accountToken?: string
  /** 结果图下载通道（默认全局 fetch）：全链测试里供应商 CDN 不可达，用它按 URL 供真实字节。 */
  downloadFetch?: typeof fetch
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JobsLocal)
  ctx.jobs.attachController("generate-image-test")
  const scratch = await mkdtemp(join(tmpdir(), "generate-image-harness-"))
  const images: string[] = []
  if (options.attachments !== false) {
    await ctx.plugin(AttachmentLocal, { dshHome: join(scratch, "attachments") } as never)
    const attachments = ctx.get("attachments") as { saveImage(input: { name: string }): Promise<unknown> } | undefined
    if (attachments) {
      const saveImage = attachments.saveImage.bind(attachments)
      attachments.saveImage = async (input: { name: string }) => {
        const ref = await saveImage(input)
        images.push(input.name)
        return ref
      }
    }
  }
  if (options.credentials !== false) await ctx.plugin(CredentialsLocal as never, { path: join(scratch, "credentials.yaml"), watch: false } as never)
  if (options.questions !== false) await ctx.plugin(UserQuestions as never, undefined as never)
  const asked: AskedQuestion[] = []
  // 应答方是测试自己控制的：undefined 表示"没有人回答"（原生 NO_PROVIDER），
  // 这正是"没有 UI 的装配不许静默提交"要用到的负路径。
  const answers: { current?: string } = {}
  const respondWith = (label?: string) => {
    answers.current = label
  }
  if (options.questions !== false) {
    ctx.on("user-questions/request" as never, (async (request: { questions: AskedQuestion[] }, next: () => Promise<unknown>) => {
      const question = request.questions[0]
      asked.push(question)
      const label = answers.current
      if (label === undefined) return await next()
      return { answers: [{ id: question.id, selected: [label] }] }
    }) as never)
  }
  await ctx.plugin(
    {
      name: "test-generate-image",
      inject: ["tools", "jobs"],
      apply: (scoped: Context) => {
        apply(scoped, {
          dataDirectory: options.dataDirectory,
          apiKey: options.apiKey ?? "test-key-not-real-49",
          ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
          ...(options.pollAttempts === undefined ? {} : { pollAttempts: options.pollAttempts }),
          ...(options.allowPaidSubmission === undefined ? {} : { allowPaidSubmission: options.allowPaidSubmission }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.accountApiUrl === undefined ? {} : { accountApiUrl: options.accountApiUrl }),
          ...(options.accountToken === undefined ? {} : { accountToken: options.accountToken }),
          ...(options.downloadFetch === undefined ? {} : { downloadFetch: options.downloadFetch }),
        })
      },
    } as never,
    undefined as never,
  )
  const tools = ctx.get("tools") as { execute(input: unknown): Promise<ToolCall> }
  const loop = await mountAgentLoopTestHarness(ctx)
  let sequence = 0
  const createAgent = async (id: string, cwd?: string): Promise<Agent> => await loop.create(SessionId(id), {}, cwd === undefined ? {} : { cwd })
  const agent = await createAgent("generate-image-test", options.cwd)
  const run = async (caller: Agent, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCall> =>
    await tools.execute({ signal: signal ?? new AbortController().signal, callId: ToolCallId(`image-test-${++sequence}`), name: "generate_image", agent: caller, arguments: args })
  const inbox = (target: Agent) => (target as unknown as { inbox: { nextStep: InboxMessage[]; nextTurn: InboxMessage[] } }).inbox
  return {
    ctx,
    agent,
    asked,
    respondWith,
    images,
    async call(args, callOptions) {
      return await run(callOptions?.caller ?? agent, args, callOptions?.signal)
    },
    createAgent,
    claimNextStep(caller = agent) {
      return loop.claim(caller, "next-step", 1) as unknown as InboxMessage[]
    },
    pending(caller = agent) {
      const box = inbox(caller)
      return { nextStep: box.nextStep.length, nextTurn: box.nextTurn.length }
    },
    async dispose() {
      await ctx.fiber.dispose().catch(() => undefined)
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

/** 成功调用取 `value.result`，失败调用取错误内容（读失败原因用）。 */
export function resultText(call: ToolCall): string {
  return call.isError === true ? (call.content ?? []).map((block) => block.text ?? "").join("\n") : String(call.value?.result ?? "")
}
