import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"
import type {} from "@deepseek-ai/dsh-jobs"
import { runGeneration, type GenerationOptions } from "./operations.ts"
import {generationAuthorizer} from "@lyapunov/api-client/generation-approval"
import {generationPublicName} from "@lyapunov/api-client/generation"
export const name = "lyapunov-generate-marble"
export const inject = ["tools", "jobs"]
/** 模型 request_json 只提供生成输入；凭据与供应商入口只能来自可信 Config/环境（正式中央路由或 WORLDLABS_API_KEY / WORLDLABS_API_BASE_URL）。 */
const MODEL_CREDENTIAL_REDIRECT_KEYS = ["apiKey", "baseURL"] as const
function rejectModelCredentialRedirect(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const rejected = MODEL_CREDENTIAL_REDIRECT_KEYS.filter((key) => key in input)
  if (!rejected.length) return
  throw new Error(
    `GENERATION_CREDENTIAL_REDIRECT_REJECTED: 工具参数不能包含 ${rejected.join("、")}；` +
      "模型 JSON 不能更改生成凭据或供应商地址（防止已配置的 WORLDLABS_API_KEY 被改送到其它地址）。" +
      "供应商凭据与合法入口只能来自可信配置：正式中央路由，或宿主环境 WORLDLABS_API_KEY / WORLDLABS_API_BASE_URL。",
  )
}
export interface Config extends GenerationOptions {}
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    lyapunov_generation: "lyapunov-generation"
  }
}
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(
    defineTool({
      name: "generate_marble",
      description:
        "Create a Marble generation or resume it by remote job ID. For a new task, verify the quote and obtain confirmation through the native user-question flow. Model arguments cannot authorize charges or supply credentials/provider addresses (apiKey/baseURL are rejected). Resuming never resubmits the task or repeats confirmation. Cancellation stops local waiting; the provider task may continue.",
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
        // 新任务与恢复路径共用同一入口检查：模型 JSON 的 baseURL/apiKey 一律显式拒绝，
        // 已配置的凭据不会被改送到模型指定的地址（SDK 层 runGeneration 仍可显式传测试 key/baseURL）。
        rejectModelCredentialRedirect(input)
        const authorize=generationAuthorizer(ctx,exec.agent,!args.background)
        const run = (signal: AbortSignal) => runGeneration(input, { ...config, signal,authorizeSubmission:authorize })
        if (!args.background) return { result: JSON.stringify(await run(exec.signal)) }
        await runGeneration(input,{...config,signal:exec.signal,prepareOnly:true,authorizeSubmission:generationAuthorizer(ctx,exec.agent,true)})
        const controller = new AbortController()
        exec.signal.addEventListener("abort", () => controller.abort(exec.signal.reason), { once: true })
        const jobId = ctx.jobs.start({
          kind: "lyapunov-generation",
          label: (config.mode === "formal" || process.env.LYAPUNOV_MODE?.trim() === "formal" ? generationPublicName("marble") : "marble") + " " + input.requestId,
          owner: exec.agent,
          run: () => ({
            cancel: () => controller.abort(),
            done: run(controller.signal).then(
              (result) => ({ status: "completed" as const, output: JSON.stringify(result) }),
              (error) => ({
                status: controller.signal.aborted ? ("killed" as const) : ("failed" as const),
                output: String(error),
              }),
            ),
          }),
        })
        return { result: JSON.stringify({ jobId, requestId: input.requestId }) }
      },
    }),
  )
}
