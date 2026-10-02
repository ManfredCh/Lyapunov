import type { ParameterSchemaSpec, ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

const text = (description: string): ValueSchemaSpec => ({ type: 'string', description })
const integer = (description: string): ValueSchemaSpec => ({ type: 'integer', description })
const required = (schema: ValueSchemaSpec): ParameterPropertySpec => ({ ...schema, required: true })
const input = (properties: ParameterSchemaSpec, description: string): ParameterSchemaSpec => ({
  input: required({ type: 'object', properties, additionalProperties: false, description }),
})
const worldId = text("worldId returned by bench_load; it must refer to the currently active world.")
const suite = text("Official suite ID from bench_catalog, such as libero_10.")

/** 使用 DSH author schema 的字段级 required，保证模型看到真实调用字段。 */
export const benchmarkToolParameters: Record<string, ParameterSchemaSpec> = {
  bench_prepare: {},
  bench_catalog: input({ suite }, "Read the task catalog without executing actions."),
  bench_load: input({
    suite,
    taskId: text("Task ID from the catalog; may replace taskIndex."),
    taskIndex: integer("Task index in the catalog; defaults to 0."),
    seed: integer("Optional random seed."),
    initialStateRef: text("Official initial-state reference."),
    worldId: text("Optional world ID; the official environment determines the actual returned value."),
  }, "Load using official reset/set_init_state. Return worldId and worldGeneration for subsequent requests to use unchanged."),
  bench_step: input({
    worldId: required(worldId),
    actionId: required(text("Unique ID for this action.")),
    expectedGeneration: required(integer("Use worldGeneration returned by bench_load unchanged; never omit or guess it.")),
    values: required({ type: 'array', items: { type: 'number' }, description: "Official controller action vector. Read its length, normalized bounds, and semantics from the current task's action declaration. The field is values, not action or positions." }),
    stepCount: integer("Positive integer number of control steps holding this action; defaults to 1."),
    continueAfterSuccess: {type:'boolean',description:"Explicitly allow demonstration interaction after official success. After the first success, new actions without this flag receive BENCHMARK_EPISODE_TERMINAL. This does not bypass timeout, cancellation, or step budgets. Subsequent actions are not new benchmark evaluation; retain the original success receipt."},
  }, "Execute one controller vector in the current official world. Only the official evaluator determines success."),
  bench_result: input({ worldId }, "Read the current official state, observations, and result without executing actions."),
  bench_close: input({ worldId: required(worldId) }, "Close the specified official world."),
  bench_run_suite: input({ suite }, "Zero-action suite availability check, not autonomous Agent task execution."),
}
