/**
 * `script/gates/*` 的共享最小契约。
 *
 * 与 `script/refactor-verify.ts` 内的 `Check` / `GateResult` 结构一致，
 * 因此薄入口把某个门接线进来时不需要适配层。
 */
export interface Check { name: string; ok: boolean; detail: string }
export interface GateResult { gate: string; checks: Check[]; blocked: string | null }
