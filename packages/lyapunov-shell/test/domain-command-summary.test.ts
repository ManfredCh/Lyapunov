/**
 * R5：动作回执的摘要不得把「指令结束」说成「到达目标」。
 *
 * 真实回执（独立验收 `codex-cu/motion-receipt.json`，UI 下发目标 [base_yaw=.45, shoulder_pitch=.25, 其余 0]）：
 * `status="completed"`，base_yaw 0.45005（进容差），shoulder_pitch 0.28031 → 误差 0.0303 > tolerance 0.03，
 * 因此引擎明确给出 `effect.motions[0].targetReached=false`。旧摘要只写"执行完成"，把"目标未到达"这层
 * 事实藏在展开的原回执里（上一轮回执也正是据此误写成"与目标一致"，本轮纠正）。原回照旧整份保留在展开区。
 *
 * 正向对照：同样形状但 `targetReached=true` 的回执仍读作"执行完成"，不是把成功也标成未达成。
 */
import { describe, expect, test } from "bun:test"

import { domainCommandSummary } from "../src/domain-command-card.tsx"
import { ActionCards } from "../src/robot-control-panel.tsx"

/** 真实回执的字段形状（仅去掉与摘要无关的 finalState 大块）。 */
const receipt = (targetReached: boolean) => ({
  actionId: "cf95ecdf-1bf2-4474-8b0f-d1743f6ee0c8",
  status: "completed",
  startStep: 50182,
  endStep: 50831,
  effect: {
    motions: [{
      kind: "joint",
      jointErrors: [0.00005018496299619146, 0.030312900751154115, 0.0035007196872758693, 0.000006478319326862552, 0.000025724550142984468, 0.00003831240260346892],
      targetReached,
      tolerance: 0.03,
    }],
    executionMode: "physical-contact",
  },
})

const summarize = (value: unknown, name = "robot_move", english = false) =>
  domainCommandSummary(name, JSON.stringify(value), "success", english)

describe("R5：动作回执摘要", () => {
  test("completed 但 targetReached=false ⇒ 写「动作已结束，目标未到达」并点出未进容差的动作数与容差", () => {
    const info = summarize(receipt(false))
    expect(info.summary).toContain("动作已结束，目标未到达")
    expect(info.summary).not.toContain("执行完成")
    expect(info.summary).toContain("1/1 个动作未进入容差")
    expect(info.summary).toContain("容差 0.03")
    // step 区间照旧给出（原回执在展开区完整保留，摘要是压缩不是替换）
    expect(info.summary).toContain("step 50182 → 50831")
    expect(info.tone).toBe("warning")
  })

  test("同样的回执 targetReached=true ⇒ 仍是「执行完成」（不把成功标成未达成）", () => {
    const info = summarize(receipt(true))
    expect(info.summary).toContain("执行完成")
    expect(info.summary).not.toContain("目标未到达")
    expect(info.summary).not.toContain("未进入容差")
    expect(info.tone).toBe("ok")
  })

  test("英文摘要同样区分（界面语言切换不改变判据）", () => {
    expect(summarize(receipt(false), "robot_move", true).summary).toContain("Action finished; target not reached")
    expect(summarize(receipt(true), "robot_move", true).summary).toContain("Completed")
  })

  test("停止回执照旧按 stopped 读数（停止＝取消确认，不是精确保持的证明）", () => {
    const info = domainCommandSummary("sim_stop", JSON.stringify({ stopped: true, stepIndex: 23979 }), "success", false)
    expect(info.summary).toBe("已停止 · step 23979")
    expect(info.tone).toBe("ok")
  })

  test("任务级回执的 taskAchieved 判据不受影响", () => {
    expect(domainCommandSummary("robot_fleet_run", JSON.stringify({ assignments: [], actions: [], taskAchieved: false }), "success", false).tone).toBe("warning")
  })
})

describe("R5：机器人面板「动作结果」卡片（紧挨提交动作的按钮，过去只写 status）", () => {
  /** 面板卡片是纯函数组件：返回值就是元素树，直接走一遍取文本，不需要渲染器（本仓没有 jsdom）。 */
  const texts = (node: any, out: string[] = []): string[] => {
    if (node === null || node === undefined || typeof node === "boolean") return out
    if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
    if (typeof node === "object") texts(node.props?.children, out)
    return out
  }
  const cardText = (receipt: unknown, opts?: { allowRaw?: boolean; mode?: string }) => texts(ActionCards({
    actions: [{ id: "a1", label: "robot_move", waiting: false, receipt: receipt as any }],
    tr: (cn: string) => cn,
    ...opts ?? {},
  } as never)).join(" | ")

  /**
   * DEV-PRIV-01 改判（不是回退 R5）：R5 的**失败摘要语义**原样保留（"动作已结束，目标未到达"
   * + 未进容差计数 + 容差值，三者都在人类面）。原先"原回执整份保留在展开区"的断言正是要关掉的泄露面——
   * 人类卡片与机器 UI 同处一个不可信浏览器边界，逐字 JSON 不得随回执下发。原回执改为：
   * ① 人类面保留其中的**负面事实字段**（`targetReached`/`tolerance`，见下面第二断言）；
   * ② 整份 JSON 只在"构建允许 + 可信 profile 为 developer"两闸都开的诊断面出现。
   */
  test("completed 但目标未到达：面板卡片写「动作已结束，目标未到达」，不再只写 completed", () => {
    const text = cardText(receipt(false))
    expect(text).toContain("动作已结束，目标未到达")
    expect(text).toContain("1/1 个动作未进入容差")
    expect(text).toContain("容差 0.03")
    // 发行/正式面：负面上屏的是事实行，不是原始 JSON
    expect(text).not.toContain('"targetReached": false')
    expect(text).toContain("targetReached: false")
    expect(text).toContain("tolerance: 0.03")
  })

  test("原回执整份只在两闸都开的诊断面出现（构建允许 + 可信 profile=developer）", () => {
    const raw = cardText(receipt(false), { allowRaw: true, mode: "developer" })
    expect(raw).toContain('"targetReached": false')
    // 只开一闸都不出原始面：发布构建的 define 恒为 false，运行期不是 developer 也一样
    expect(cardText(receipt(false), { allowRaw: true, mode: "formal" })).not.toContain('"targetReached": false')
    expect(cardText(receipt(false), { allowRaw: false, mode: "developer" })).not.toContain('"targetReached": false')
  })

  test("目标到达的回执照旧读作执行完成，且卡片外形不变（标题 + 文本 + 原回执）", () => {
    const text = cardText(receipt(true))
    expect(text).toContain("完整关节运动")
    expect(text).toContain("执行完成")
    expect(text).not.toContain("目标未到达")
  })

  test("未完成时不伪造结果：等待中的卡片写明请求已提交", () => {
    const text = texts(ActionCards({ actions: [{ id: "a2", label: "robot_move", waiting: true }], tr: (cn: string) => cn })).join(" | ")
    expect(text).toContain("请求已提交，等待引擎结果…")
  })
})
