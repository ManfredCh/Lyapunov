import { readRuntimeEnv } from '../packages/lyapunov-product-bundle/src/runtime-paths.ts'

/** 开发者默认：线路 id 为已验证视觉的 v4 flash；界面名称固定 Deepseek-flash。 */
export const DEVELOPER_DEFAULT_PROVIDER = 'deepseek-official'
export const DEVELOPER_DEFAULT_MODEL_ID = 'deepseek-v4-flash-vision-exp'
export const DEVELOPER_DEFAULT_DISPLAY_NAME = 'Deepseek-flash'
export const DEVELOPER_DEFAULT_REASONING_EFFORT = 'max'

export function developerDefaultModelId(env: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(env, 'developerModel') ?? DEVELOPER_DEFAULT_MODEL_ID
}

export function developerDefaultProvider(env: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(env, 'developerProvider') ?? DEVELOPER_DEFAULT_PROVIDER
}

export function developerDefaultReasoningEffort(env: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(env, 'developerReasoningEffort') ?? DEVELOPER_DEFAULT_REASONING_EFFORT
}

export function developerDefaultCatalog(env: NodeJS.ProcessEnv = process.env) {
  const declared = developerDefaultModelId(env)
  const base = [
    {
      id: DEVELOPER_DEFAULT_MODEL_ID,
      name: DEVELOPER_DEFAULT_DISPLAY_NAME,
      inputModalities: ['text', 'image'] as const,
      contextWindow: 1_000_000,
    },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
  ]
  // 路由声明（`LYAPUNOV_DEVELOPER_MODEL`，由开发者 Profile 注入）必须同时出现在**厂商目录**里。
  // 否则"先列目录、再让调用方选模型"的消费者（ACP 的 `model` 配置项就是这样）只能看到写死的三个 id：
  // 实测把路由指向本地端点后，ACP 会话仍只能选 `deepseek-v4-flash`，于是拿到
  // `Internal error: turn failed: model 'deepseek-v4-flash' not found`。
  // 模型路由是部署/Profile 的选择（合同 §2.14），不该要求改业务代码才能生效。
  // 声明值排在最前；与内置项同 id 时不重复。
  return base.some(model => model.id === declared)
    ? base
    : [{ id: declared, name: declared, contextWindow: 1_000_000 }, ...base]
}

export function developerAgentDefaultModel(env: NodeJS.ProcessEnv = process.env) {
  return {
    provider: developerDefaultProvider(env),
    model: developerDefaultModelId(env),
    displayName: DEVELOPER_DEFAULT_DISPLAY_NAME,
    reasoningEffort: developerDefaultReasoningEffort(env),
  }
}
