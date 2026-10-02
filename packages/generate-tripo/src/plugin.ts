import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"
import type {} from "@deepseek-ai/dsh-jobs"
import { runGeneration, type GenerationOptions } from "./operations.ts"
import {generationAuthorizer} from "@lyapunov/api-client/generation-approval"
import {generationPublicName,generationPublicError} from "@lyapunov/api-client/generation"
export const name = "lyapunov-generate-tripo"
export const inject = ["tools", "jobs"]
/** 模型 request_json 只提供生成输入；凭据与供应商入口只能来自可信 Config/环境（正式中央路由或 TRIPO_API_KEY / DASHSCOPE_API_KEY / TRIPO_WORKSPACE_ID / TRIPO_API_BASE_URL）。 */
const MODEL_CREDENTIAL_REDIRECT_KEYS = ["apiKey", "baseURL"] as const
function rejectModelCredentialRedirect(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const rejected = MODEL_CREDENTIAL_REDIRECT_KEYS.filter((key) => key in input)
  if (!rejected.length) return
  throw new Error(
    `GENERATION_CREDENTIAL_REDIRECT_REJECTED: 工具参数不能包含 ${rejected.join("、")}；` +
      "模型 JSON 不能更改生成凭据或供应商地址。正式 Peiri 3D 使用当前账号的中央服务，开发直连只读取可信宿主配置。",
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
      name: "generate_tripo",
      description:
        "Create a Peiri 3D generation or resume it by remote job ID. Use this route for new assets requiring semantic form and realistic appearance; Blender can create precise regular geometry. For a new task, verify the quote and obtain confirmation through the native user-question flow. Stop if configuration or a positive-credit quote is missing; do not loop retries or repeat questions. Model arguments cannot authorize charges or supply credentials/provider addresses (apiKey/baseURL are rejected). Resuming never resubmits or repeats confirmation. Cancellation stops local waiting; the remote task may continue. Missing tasks become terminal remote-lost, without automatic rechecks or resubmission.",
      parameters: {
        request_json: {
          type: "string",
          required: true,
          description: "JSON containing requestId and input:{mode,prompt,referenceImageUri?,referenceImageUris?}; an existing remote job ID may also be supplied. For real materials on new outputs, explicitly set top-level pbr:true and texture:true; quality may be standard/detailed. Material arguments change this request's identity and quote confirmation. Do not modify an old request and replay its old untextured model.",
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
        const formal=config.mode === "formal" || process.env.LYAPUNOV_MODE?.trim() === "formal"
        const authorize=generationAuthorizer(ctx,exec.agent,!args.background)
        const executeGeneration = async (signal: AbortSignal, prepareOnly = false) => {
          try { return await runGeneration(input, { ...config, signal,prepareOnly,authorizeSubmission:prepareOnly?generationAuthorizer(ctx,exec.agent,true):authorize }) }
          catch(error) { throw formal?generationPublicError(error,"tripo"):error }
        }
        const run = (signal: AbortSignal) => executeGeneration(signal)
        if (!args.background) return { result: JSON.stringify(await run(exec.signal)) }
        await executeGeneration(exec.signal,true)
        const controller = new AbortController()
        exec.signal.addEventListener("abort", () => controller.abort(exec.signal.reason), { once: true })
        const jobId = ctx.jobs.start({
          kind: "lyapunov-generation",
          label: (formal ? generationPublicName("tripo") : "tripo") + " " + input.requestId,
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
