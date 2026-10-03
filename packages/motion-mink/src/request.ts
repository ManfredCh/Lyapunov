/** motion_plan 的入参规范化：纯函数、无 DSH 依赖，便于独立验证。 */

export interface MotionPlanToolArgs { plan?: Record<string, unknown>; request_json?: string }

/**
 * 结构化 `plan` 与兼容的 `request_json` 严格二选一：
 * 两个都给或都不给都明确拒绝，避免"看起来设了但没生效"的静默误用。
 * 结构化路径只做字段换名（quaternionXyzw→quaternion），其余字段原样交给 solve.py 的既有契约；
 * 不在这里补默认值、不做几何换算，默认值仍由算法解释器拥有。
 */
export function motionRequest(args: MotionPlanToolArgs): Record<string, unknown> {
  const hasPlan = args.plan !== undefined, hasJson = args.request_json !== undefined
  if (hasPlan === hasJson) throw new Error('INVALID_ARGUMENT: plan 与 request_json 必须二选一')
  if (!hasPlan) return JSON.parse(args.request_json as string)
  const { targetPose, ...rest } = args.plan as Record<string, unknown>
  const pose = (targetPose ?? {}) as { position?: unknown; quaternionXyzw?: unknown }
  return { ...rest, targetPose: { position: pose.position, quaternion: pose.quaternionXyzw } }
}
