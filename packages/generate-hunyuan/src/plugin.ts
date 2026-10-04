import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"
import type {} from "@deepseek-ai/dsh-jobs"
import { runGeneration, type GenerationOptions } from "./operations.ts"
import {generationAuthorizer} from "@lyapunov/api-client/generation-approval"
import {generationPublicName} from "@lyapunov/api-client/generation"
export const name = "lyapunov-generate-hunyuan"
export const inject = ["tools", "jobs"]
export interface Config extends GenerationOptions {}
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    lyapunov_generation: "lyapunov-generation"
  }
}
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(
    defineTool({
      name: "generate_hunyuan",
      description:
        "Create a Hunyuan generation or resume it by remote job ID. For a new task, verify the quote and obtain confirmation through the native user-question flow; model arguments cannot authorize charges. Resuming never resubmits the task or repeats confirmation. Cancellation stops local waiting; the provider task may continue. A job that the provider reports as missing (JobNotFound) becomes terminal remote-lost: retain its job ID, stop automatic remote checks, and never resubmit it.",
      parameters: {
        request_json: {
          type: "string",
          required: true,
          description: "JSON containing requestId and provider input; an existing remote job ID may also be supplied.",
        },
        background: { type: "boolean", description: "Run through DSH Jobs." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { result: { type: "string", required: true } },
        },
        render: (_args, v) => [{ type: "text", text: v.result }],
      },
      async execute(args, exec) {
        if (!config.dataDirectory) throw new Error("PROVIDER_UNAVAILABLE: 缺少当前账号的 dataDirectory")
        const input = JSON.parse(args.request_json)
        const authorize=generationAuthorizer(ctx,exec.agent,!args.background)
        const run = (signal: AbortSignal) => runGeneration(input, { ...config, signal,authorizeSubmission:authorize })
        if (!args.background) return { result: JSON.stringify(await run(exec.signal)) }
        await runGeneration(input,{...config,signal:exec.signal,prepareOnly:true,authorizeSubmission:generationAuthorizer(ctx,exec.agent,true)})
        const controller = new AbortController()
        if (exec.signal.aborted) throw exec.signal.reason ?? new Error("Cancelled before background Job registration")
        const jobId = ctx.jobs.start({
          kind: "lyapunov-generation",
          label: (config.mode === "formal" || process.env.LYAPUNOV_MODE?.trim() === "formal" ? generationPublicName("hunyuan") : "hunyuan") + " " + input.requestId,
          owner: exec.agent?.id,
          run: () => ({
            cancel: () => controller.abort(),
            done: run(controller.signal).then(
              (result) => ({ status: "completed" as const, result: JSON.stringify(result) }),
              (error) => ({
                status: controller.signal.aborted ? ("killed" as const) : ("failed" as const),
                result: String(error),
              }),
            ),
          }),
        })
        return { result: JSON.stringify({ jobId, requestId: input.requestId }) }
      },
    }),
  )
}
