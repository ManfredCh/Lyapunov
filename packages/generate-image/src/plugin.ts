/**
 * 图像生成工具（阿里云百炼 · 千问图像 3.0）。
 *
 * 只做三件最薄的事：把模型给的输入交给 `operations.runImageGeneration`、把收费提交交给一次原生
 * 用户确认（共享 `generation-approval` 的 `generationAuthorizer`，不再维护图像专用副本）、
 * 把生成的图**真的送进模型上下文**（前台跟工具结果走，后台跟原生作业完成通知走）。
 * 任务状态不另造一套：后台身份是原生 `ctx.jobs`，远端身份是百炼的 task_id，记录在 operations 里。
 */
import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import type { JobId, JobOutcome } from "@deepseek-ai/dsh-jobs"
import type {} from "@deepseek-ai/dsh-jobs"
import type {} from "@deepseek-ai/dsh-user-questions"
import { isAbsolute, resolve } from "node:path"
import { generationAuthorizer } from "@lyapunov/api-client/generation-approval"
import { generationPublicName } from "@lyapunov/api-client/generation"
import { attachResultImages, noteImageDelivery } from "../../blender/src/result.ts"
import type { ImageReport, ImageStore } from "../../blender/src/result.ts"
import { isPreparedOnly, runImageGeneration, type GenerationOptions, type ImageGenerationResult } from "./operations.ts"

export const name = "lyapunov-generate-image"
// `attachments` 与 blender 同口径**不进 inject**：它是可选增强（带图）而不是本工具的必需服务，
// 声明进来会让"没装附件服务的装配"整插件不激活；运行时用 ctx.get('attachments') 判空。
export const inject = ["tools", "jobs"]

/** 一次结果最多带进模型上下文的图像张数（官方 n 上限 6，超出部分仍以真实路径留在结果 JSON 里）。 */
const MAX_RESULT_IMAGES = 4

export interface Config extends GenerationOptions {
  /** 没有会话 cwd 时相对参考图的解析基准（与 blender 同口径，不悄悄拿进程 cwd 当基准）。 */
  workspace?: string
}

/**
 * 模型 request_json 只提供生成输入；凭据与供应商入口只能来自可信配置/环境。
 * `model` 也一并拒绝：模型档位决定计费（1k/2k、标准/pro 单价不同），
 * 让模型自选档位等于让它改价格——档位只能由可信配置 `IMAGE_MODEL`/Config.model 决定。
 */
const MODEL_CREDENTIAL_REDIRECT_KEYS = ["apiKey", "baseURL", "endpoint", "model"] as const
function rejectModelCredentialRedirect(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const rejected = MODEL_CREDENTIAL_REDIRECT_KEYS.filter((key) => key in input)
  if (!rejected.length) return
  throw new Error(
    `GENERATION_CREDENTIAL_REDIRECT_REJECTED: 工具参数不能包含 ${rejected.join("、")}；` +
      "模型 JSON 不能更改生成凭据、供应商地址或模型档位（防止已配置的 IMAGE_API_KEY / DASHSCOPE_API_KEY 被改送到其它地址或改到更贵的档位）。" +
      "凭据与入口只能来自可信配置：宿主环境 IMAGE_API_KEY（回落 DASHSCOPE_API_KEY）、IMAGE_API_BASE_URL / IMAGE_WORKSPACE_ID，模型档位来 IMAGE_MODEL。",
  )
}

/** 附件服务（可选）：装配了就把图真的送进上下文，没装配就如实记进图片读数。 */
function attachmentStore(ctx: Context): ImageStore | undefined {
  return ctx.get("attachments") as ImageStore | undefined
}

/**
 * 一张图都没送到时，让**结果文本本身**说明"这次到底有没有看到图"。
 * 后台带图时同一读数走 job-notice 车道（见 deliverImagesToOwner）。
 */
function withDelivery(value: ImageGenerationResult, report: ImageReport): string {
  // 键名刻意不叫 images：那个键在结果里是**逐张生成图的真实路径**，不能被读数覆盖。
  return JSON.stringify({ ...value, imageDelivery: report })
}

/**
 * 后台作业完成时，用**原生 Agent 消息**把同一批生成图投给 owner。
 *
 * 与 blender 的投递同口径（那份是模块私有的，这里按同一形状重写 15 行，不为了共用去改别的包）：
 * `owner.inject` 把消息排进 owner 的下一步（durable）而**不唤醒**驱动——原生作业完成通知的那一次
 * 唤醒因此不会被复制，不会多开一轮模型请求。投递失败（owner 已释放等）时把原因写回读数，
 * 结果文本里明说"图没送到"。
 */
function deliverImagesToOwner(owner: unknown, jobId: string | undefined, report: ImageReport, refs: readonly unknown[]): void {
  const target = owner as { inject?: (message: unknown) => void } | undefined
  if (typeof target?.inject !== "function") {
    report.delivery = "none"
    report.deliveryError = "执行上下文没有可投递的 owner agent（inject 不可用）：图只能按结果里的路径自行读取"
    return
  }
  const where = jobId === undefined ? "" : `（作业 ${jobId}）`
  const text =
    `图像生成完成${where}：随本条消息附上 ${refs.length} 张生成图` +
    `（结果里共 ${report.requested} 张路径${report.skipped.length ? `，本次只带 ${MAX_RESULT_IMAGES} 张` : "，全部带到"}）。` +
    "这些图来自本次作业的结果行；本地文件路径见作业结果里的 images。"
  const content: ContentBlock[] = [{ type: "text", text }, ...refs.map((ref) => ({ type: "image", attachment: ref } as ContentBlock))]
  try {
    target.inject(createUserMessage({ content, source: { kind: "plugin", plugin: name, form: "notice", summary: `生成图 ${refs.length} 张${where}` } }))
    report.delivery = "job-notice"
  } catch (error) {
    report.delivery = "none"
    report.deliveryError = `投递失败：${String(error instanceof Error ? error.message : String(error))}`
  }
}

declare module "@deepseek-ai/dsh-jobs" {
  /** 与 marble/hunyuan/tripo 共用同一个作业类别（同一处装配、同一套取消/读取工具），label 区分产品。 */
  interface JobKindMap {
    lyapunov_generation: "lyapunov-generation"
  }
}

export function apply(ctx: Context, config: Config) {
  /** 与 blender 同一条解析：相对路径的基准是**任务工作区**（原生会话 header cwd），没有就明确报错。 */
  const absolute = (exec: { agent?: { session?: { header?: { cwd?: string } } } | undefined }, value: string, label: string): string => {
    if (isAbsolute(value)) return value
    const cwd = exec.agent?.session?.header?.cwd ?? (config.workspace ? resolve(config.workspace) : undefined)
    if (!cwd) throw new Error(`IMAGE_CWD_UNRESOLVED: ${label} 是相对路径（${value}），但当前执行上下文没有会话工作目录、本插件也未配置 workspace；请传绝对路径`)
    return resolve(cwd, value)
  }
  /** 参考图可以给本地文件（按任务工作区解析）或公网 URL；官方协议两种都收，所以不逼用户先上传。 */
  const resolveReferenceImages = (exec: { agent?: { session?: { header?: { cwd?: string } } } | undefined }, value: unknown): void => {
    const input = value as { input?: { referenceImages?: unknown } } | undefined
    const references = input?.input?.referenceImages
    if (references === undefined) return
    if (!Array.isArray(references)) throw new Error(`IMAGE_ARGUMENT_INVALID: input.referenceImages 需要字符串数组，收到 ${JSON.stringify(references)}`)
    input!.input!.referenceImages = references.map((reference, index) => {
      if (typeof reference !== "string" || !reference.trim()) throw new Error(`IMAGE_ARGUMENT_INVALID: input.referenceImages[${index}] 需要非空字符串（本地路径或 http(s) URL）`)
      return /^https?:\/\//i.test(reference) ? reference : absolute(exec, reference, `input.referenceImages[${index}]`)
    })
  }
  /**
   * 结果文本 → 本次要带进模型上下文的图像附件。`output.render` 必须**同步**返回 ContentBlock[]，
   * 而附件化是异步的，所以图在 `execute` 里就附件化好，这里只做同步取用；取用后即删，
   * 避免长会话里按结果文本无限增长。
   */
  const attachmentsByResult = new Map<string, unknown[]>()
  ctx.tools.register(
    defineTool({
      name: "generate_image",
      description:
        "Generate images with Alibaba Cloud Bailian Qwen Image 3.0. input.prompt alone performs text-to-image; adding input.referenceImages (1-3 local paths or URLs) performs image-to-image/local edits, for example replacing stone material while preserving openings." +
        "Submit a new request only after native user-question confirmation; model arguments cannot authorize charges. One requestId identifies exactly one request. Changes to the prompt/reference images/arguments require a new requestId; otherwise GENERATION_REQUEST_ID_CONFLICT prevents returning the previous image as the new result. In formal mode, the central service's stored request fingerprint enforces this check across cold reopenings." +
        "To resume an existing task, reuse its original requestId and omit input. Supplying requestId alone retrieves only the original result: no resubmission, repeated confirmation, or requirement for the original reference files. Supplying input denotes a new request and is checked against the original requestId. If it cannot be verified, for example because a reference file is missing, return GENERATION_INPUT_UNVERIFIED rather than treating an old result as a new one." +
        "Formal mode uses the central account gateway, with keys kept on the server and no local provider key required. Developer mode connects directly to the provider. Credentials, provider endpoints, and model tiers must come only from trusted configuration; apiKey/baseURL/endpoint/model are rejected in arguments." +
        "The result's model is the model actually used for this request, taken from the server snapshot in formal mode. If a historical record lacks model information, leave it absent instead of substituting current configuration." +
        "Save generated images in this session's dataDirectory and return image attachments to the model. Generated images are concept references; begin text-based creation with a small set of concepts and do not replace site/physical evidence. background:true delegates execution to native Jobs and attaches images directly in the completion notification." +
        "Cancellation stops local waiting; the remote task may continue. A task confirmed missing by the provider (task_status UNKNOWN / query 404) becomes terminal remote-lost: retain task_id, stop automatic checks, and never resubmit the paid task.",
      parameters: {
        request_json: {
          type: "string",
          required: true,
          description:
            "JSON: {\"requestId\":\"...\",\"input\":{\"prompt\":\"...\",\"referenceImages\":[\"...\"],\"size\":\"1024*1024\",\"n\":1,\"seed\":0,\"negativePrompt\":\"...\",\"promptExtend\":true,\"watermark\":false}}. An existing remote task ID {\"resumeTaskId\":\"...\"} may also be supplied. To retrieve the original result, omit input and supply only {\"requestId\":\"...\"}. Resolve relative reference-image paths against the current session's task workspace.",
        },
        background: { type: "boolean", description: "Run through DSH Jobs." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { result: { type: "string", required: true } },
        },
        render: (_args, value) => {
          const refs = attachmentsByResult.get(value.result)
          attachmentsByResult.delete(value.result)
          const blocks: ContentBlock[] = [{ type: "text", text: value.result }]
          for (const ref of refs ?? []) blocks.push({ type: "image", attachment: ref as never })
          return blocks
        },
      },
      async execute(args, exec) {
        if (!config.dataDirectory) throw new Error("PROVIDER_UNAVAILABLE: 缺少当前账号的 dataDirectory")
        const input = JSON.parse(args.request_json)
        // 新任务与恢复路径共用同一入口检查：模型 JSON 的 apiKey/baseURL/endpoint/model 一律显式拒绝，
        // 已配置的凭据不会被改送到模型指定的地址（SDK 层 runImageGeneration 仍可显式传测试值）。
        rejectModelCredentialRedirect(input)
        resolveReferenceImages(exec, input)
        // 收费授权用**共享** generation-approval（它已支持 image）：同一套原生问答、凭据 scope 与指纹，
        // 不再维护一份图像专用副本。后台先在前台把授权做完，所以后台路径也可以弹这一次确认。
        const authorize = generationAuthorizer(ctx, exec.agent, !args.background)
        const run = (signal: AbortSignal) => runImageGeneration(input, { ...config, signal, authorizeSubmission: authorize })
        if (!args.background) {
          const result = await run(exec.signal)
          // 非后台路径不可能走到 prepareOnly；真发生了就如实报错，不假装拿到结果。
          if (isPreparedOnly(result)) throw new Error("PROVIDER_UNAVAILABLE: 前台调用走到了只做检查的分支")
          const { refs, report } = await attachResultImages(attachmentStore(ctx), result.images.map((image) => image.path), MAX_RESULT_IMAGES, "tool-result")
          noteImageDelivery(report, { lane: "tool-result", renderRequested: true })
          if (exec.signal.aborted) throw new Error("IMAGE_CANCELLED: 调用在附件化阶段被取消（本次不返回结果）")
          const text = withDelivery(result, report)
          if (refs.length > 0) attachmentsByResult.set(text, refs)
          return { result: text }
        }
        // 后台：先在**前台**把提交前检查与授权问答做完（后台里问不了用户），再交给原生 Jobs。
        await runImageGeneration(input, { ...config, signal: exec.signal, prepareOnly: true, authorizeSubmission: generationAuthorizer(ctx, exec.agent, true) })
        const controller = new AbortController()
        exec.signal.addEventListener("abort", () => controller.abort(exec.signal.reason), { once: true })
        let started: JobId | undefined
        started = ctx.jobs.start({
          kind: "lyapunov-generation",
          label: (config.mode === "formal" || process.env.LYAPUNOV_MODE?.trim() === "formal" ? generationPublicName("image") : "image") + " " + input.requestId,
          owner: exec.agent,
          run: () => {
            const done = (async (): Promise<JobOutcome> => {
              const result = await run(controller.signal)
              if (isPreparedOnly(result)) return { status: "failed" as const, output: "PROVIDER_UNAVAILABLE: 后台作业只完成了提交前检查，没有提交" }
              // 图必须先附件化再投递：`output.render` 只有前台有，后台的唯一交付通道是 owner.inject。
              const { refs, report } = await attachResultImages(attachmentStore(ctx), result.images.map((image) => image.path), MAX_RESULT_IMAGES, "job-notice")
              // 取消的作业**不作为本次产出发图**：附件化之后不再有异步步骤，否则"作业被取消"与"完成通知带图发出"会同时成立。
              if (controller.signal.aborted) {
                report.delivery = "none"
                report.deliveryError = "作业在附件化阶段被取消：本次不投递图片（取消的作业不作为本次产出发给模型）"
                return { status: "killed" as const, output: "IMAGE_CANCELLED: 作业在附件化阶段被取消（已附件化 " + report.attached + " 张，全部不投递）" }
              }
              if (refs.length > 0) deliverImagesToOwner(exec.agent, started, report, refs)
              else noteImageDelivery(report, { lane: "job-notice", renderRequested: true })
              return { status: "completed" as const, output: withDelivery(result, report) }
            })()
            return {
              cancel: () => controller.abort(),
              done: done.catch((error) => ({
                status: controller.signal.aborted ? ("killed" as const) : ("failed" as const),
                output: error instanceof Error ? error.message : String(error),
              })),
            }
          },
        })
        return { result: JSON.stringify({ jobId: started, requestId: input.requestId }) }
      },
    }),
  )
}
