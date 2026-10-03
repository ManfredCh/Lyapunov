/**
 * 批量控制的「发出身份」判据（CR057）。
 *
 * batch() 先按需 await describe(id) 若干次（每个未就绪的描述一个等待边界），最后才调用
 * move()；而 move 在「调用时」才取 worldRef.current。于是从发起批量到真正发出动作之间，
 * 用户完全可能在这些等待边界里把视图切到同名机器人的另一个 world——旧批量会带着等待
 * 期间就绪的「新描述/新目标」，发到「不是发起时那个」world/代次上去。
 *
 * 这里只回答一个问题：等待边界之后，当前 world 句柄是否仍是发起时绑定的那一个。
 * 判据只比较 worldId 与句柄代次 worldGeneration，任一改变都视为目标已变，不提交动作。
 * 不建新的 owner/epoch，也不锁任何 UI：用户照常切场景/切世界，只是这一次批量被撤销。
 */
export type WorldBinding = { worldId: string; worldGeneration: number }

/** 批量发起时绑定的 world 与等待边界之后的当前 world 是否为同一个（id 与代次都相同）。 */
export function sameWorldBinding(bound: WorldBinding | undefined | null, current: WorldBinding | undefined | null): boolean {
  if (!bound || !current) return false
  return bound.worldId === current.worldId && bound.worldGeneration === current.worldGeneration
}
