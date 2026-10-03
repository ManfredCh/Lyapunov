/**
 * G03 的「单一时基」与「消费者断开/重连后时钟继续」判定（DEV-027 F09）。
 *
 * 覆盖审计的 F09：G03 只断言"帧数>1 且 stepIndex 不回退"——既没有"**只有一个时钟/一个循环**"的
 * 可判定断言，也没有"再开 Viewer 后继续"的断言。本入口是**纯 headless provider，没有 Viewer**，
 * 故这里用它的等价动作：
 *   · 「关 Viewer」= 退订帧通道（`unsubscribe()`）；
 *   · 「再开 Viewer」= 重新订阅帧通道；
 *   · 「单时钟」= 同一 generation 下，`ΔsimTime` 必须等于 `ΔstepIndex × timestepS`（同一个时基）。
 * 第二个循环/第二个时钟会让这个比值明显偏离 1（实测本机 timestepS=0.002、42 帧跨 704 步、比值≈0.00200）。
 *
 * 谓词放这里（薄入口是顶层 CLI、import 即执行，不能被测试 import），便于跑负对照单测。
 */

/** 一帧的最小读数（与 `subscribeFrames` / `robot_state` 的公共字段一致）。 */
export interface ClockFrame { stepIndex: number; generation: number; simTime: number }

export interface SingleClockVerdict {
  ok: boolean
  /** 参与时基比对（Δstep>0）的相邻帧对数。 */
  pairs: number
  /** 观测到的最大 |ΔsimTime − ΔstepIndex×timestepS|（秒）。 */
  maxErrorS: number
  reasons: string[]
}

/**
 * 单一时基判定：帧数≥2、同一 generation、stepIndex 与 simTime 均不回退，
 * 且每对相邻帧满足 `|ΔsimTime − ΔstepIndex×timestepS| ≤ max(15% × ΔsimTime, 4×timestepS)`。
 * 15% 的容差足以容纳浮点与调度抖动，但第二个时钟会让误差接近 100%。
 */
export function singleClockVerdict(frames: readonly ClockFrame[], timestepS: number): SingleClockVerdict {
  const reasons: string[] = []
  if (frames.length < 2) reasons.push(`帧数不足（${frames.length}）`)
  if (!(timestepS > 0)) reasons.push(`timestepS 非正（${timestepS}）`)
  const generations = new Set(frames.map(frame => frame.generation))
  if (generations.size > 1) reasons.push(`generation 不唯一（${[...generations].join(",")}）`)
  let pairs = 0, maxErrorS = 0
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!, current = frames[index]!
    if (current.stepIndex < previous.stepIndex) reasons.push(`stepIndex 回退（${previous.stepIndex}→${current.stepIndex}）`)
    if (current.simTime < previous.simTime) reasons.push(`simTime 回退（${previous.simTime}→${current.simTime}）`)
    const deltaStep = current.stepIndex - previous.stepIndex
    if (deltaStep <= 0) continue
    pairs += 1
    const expected = deltaStep * timestepS
    const error = Math.abs((current.simTime - previous.simTime) - expected)
    maxErrorS = Math.max(maxErrorS, error)
    const tolerance = Math.max(0.15 * expected, 4 * timestepS)
    if (error > tolerance) reasons.push(`第 ${index} 对时基不符：Δstep=${deltaStep} 期望 ΔsimTime=${expected.toFixed(6)} 实测=${(current.simTime - previous.simTime).toFixed(6)} 误差=${error.toFixed(6)}>${tolerance.toFixed(6)}`)
  }
  if (pairs === 0 && reasons.length === 0) reasons.push("没有任何 Δstep>0 的相邻帧对，无法判时基")
  return { ok: reasons.length === 0, pairs, maxErrorS, reasons }
}

export interface ReopenVerdict { ok: boolean; detachedSteps: number; resumedFrames: number; reasons: string[] }

/**
 * 「关消费者（关 Viewer）期间时钟照跑 + 重连（再开 Viewer）后继续推进」判定：
 *   · 断开窗口内必须真实前进（`after.stepIndex > before.stepIndex`）——时钟不依赖消费者；
 *   · 重连后必须继续前进（`post` 末帧 stepIndex > 重连时读数）且 generation 不变。
 */
export function reopenVerdict(
  before: ClockFrame | undefined,
  after: ClockFrame | undefined,
  post: readonly ClockFrame[],
): ReopenVerdict {
  const reasons: string[] = []
  if (before === undefined || after === undefined) reasons.push("断开窗口两侧缺读数")
  const detachedSteps = before && after ? after.stepIndex - before.stepIndex : 0
  if (before && after && detachedSteps <= 0) reasons.push(`无消费者期间时钟没有前进（${before.stepIndex}→${after.stepIndex}）`)
  const last = post.at(-1)
  if (post.length < 2) reasons.push(`重连后帧数不足（${post.length}）`)
  if (after && last && last.stepIndex <= after.stepIndex) reasons.push(`重连后没有继续推进（${after.stepIndex}→${last.stepIndex}）`)
  const generations = new Set([...(before ? [before] : []), ...(after ? [after] : []), ...post].map(frame => frame.generation))
  if (generations.size > 1) reasons.push(`断开/重连期间 generation 变了（${[...generations].join(",")}）`)
  return { ok: reasons.length === 0, detachedSteps, resumedFrames: post.length, reasons }
}
