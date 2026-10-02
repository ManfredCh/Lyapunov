/**
 * DEV-027 F09 负对照（Round 6）：G03 的「单时钟」与「再开 Viewer 后继续」判据必须**有失败能力**。
 *
 * 负对照覆盖三类真实故障形态：
 *   · 两个时钟/两个循环 ⇒ ΔsimTime 与 ΔstepIndex×timestepS 的比值被打歪（这里用 2 倍与 0 倍）；
 *   · simTime 回退 / stepIndex 回退 ⇒ 判否；
 *   · generation 变了（旧代次帧混入）⇒ 判否；
 *   · 关 Viewer 期间时钟停了 / 重连后不推进 ⇒ 判否。
 * 谓词与常量在 `script/gates/g03-clock.ts`（薄入口是顶层 CLI，测试不能 import 它）。
 */
import { describe, expect, test } from "bun:test"
import { reopenVerdict, singleClockVerdict, type ClockFrame } from "./g03-clock.ts"

const DT = 0.002
/** 真实读数形态：`g03-before-f09.log` 里 42 帧跨 704 步（≈17 步/帧，ΔsimTime≈0.034）。 */
const realFrames: ClockFrame[] = Array.from({ length: 5 }, (_, index) => ({ stepIndex: 1 + index * 17, generation: 1, simTime: 0.002 * (1 + index * 17) }))

describe("G03 单时钟判据（F09）", () => {
  test("真实形态：同一代次、单一时基 ⇒ 通过", () => {
    const verdict = singleClockVerdict(realFrames, DT)
    expect(verdict.ok).toBe(true)
    expect(verdict.pairs).toBe(4)
    expect(verdict.maxErrorS).toBeLessThan(1e-9)
  })

  test("负对照：两个时钟（ΔsimTime 是 Δstep 的 2 倍）⇒ 必须判失败", () => {
    const doubled = realFrames.map((frame, index) => ({ ...frame, simTime: frame.simTime * 2 }))
    const verdict = singleClockVerdict(doubled, DT)
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.some(reason => reason.includes("时基不符"))).toBe(true)
  })

  test("负对照：时钟停摆（ΔsimTime=0 而 stepIndex 仍前进）⇒ 必须判失败", () => {
    const frozen = realFrames.map(frame => ({ ...frame, simTime: 0.034 }))
    expect(singleClockVerdict(frozen, DT).ok).toBe(false)
  })

  test("负对照：simTime/stepIndex 回退、generation 混代 ⇒ 必须判失败", () => {
    expect(singleClockVerdict([...realFrames].reverse(), DT).ok).toBe(false)
    expect(singleClockVerdict([{ stepIndex: 10, generation: 1, simTime: 0.02 }, { stepIndex: 12, generation: 2, simTime: 0.024 }], DT).ok).toBe(false)
    expect(singleClockVerdict([realFrames[0]!], DT).ok).toBe(false)
  })

  test("再开 Viewer：断开期真实推进 + 重连后继续 + 代次不变 ⇒ 通过", () => {
    const verdict = reopenVerdict(realFrames.at(-1), { stepIndex: 200, generation: 1, simTime: 0.4 }, realFrames.map(frame => ({ ...frame, stepIndex: frame.stepIndex + 300, simTime: frame.simTime + 0.6 })))
    expect(verdict.ok).toBe(true)
    expect(verdict.detachedSteps).toBe(200 - realFrames.at(-1)!.stepIndex)
  })

  test("负对照：断开期间时钟停了 / 重连后不推进 ⇒ 必须判失败", () => {
    const stopped = reopenVerdict(realFrames.at(-1), { stepIndex: realFrames.at(-1)!.stepIndex, generation: 1, simTime: 0.4 }, realFrames.map(frame => ({ ...frame, stepIndex: frame.stepIndex + 300, simTime: frame.simTime + 0.6 })))
    expect(stopped.ok).toBe(false)
    const noResume = reopenVerdict(realFrames.at(-1), { stepIndex: 200, generation: 1, simTime: 0.4 }, [{ stepIndex: 200, generation: 1, simTime: 0.4 }])
    expect(noResume.ok).toBe(false)
    const missing = reopenVerdict(undefined, undefined, realFrames)
    expect(missing.ok).toBe(false)
  })
})
