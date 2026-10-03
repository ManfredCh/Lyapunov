/**
 * DEV-027 F14 负对照（Round 6）：G07 的判定必须锚在**固定配置**上，而不是"搜索命中的那一档"。
 *
 * 这里钉两件事：
 *   1. 固定配置常量就是历史真机读数（防止有人为了"让它过"随手改值）；
 *   2. 判定谓词对**不达标/缺失**的档位必须判否——包括真实出现过的
 *      "手指碰到但抬不起来"（lift≈8.7e-5）与"压根没复现挡住"（接触=0、闭合总宽=命令值）。
 * 谓词与常量在 `script/gates/g07-calibration.ts`（薄入口是顶层 CLI，测试不能 import 它）。
 */
import { describe, expect, test } from "bun:test"
import { FIXED_GRASP_CONFIG, liftAchieved, offsetLooksBlocked } from "./g07-calibration.ts"

/** 真实读数：`.runtime/lane-dev027f/g07-before-calibration.log` 的逐档原始值。 */
const REAL_OFFSET_ROWS = [
  { offset: 0.1029, closedTotal: 0.04636082520891582, robotContacts: 4 },
  { offset: -0.1029, closedTotal: 0.0384315325671214, robotContacts: 2 },
  { offset: 0.0584, closedTotal: -0.01144208067057235, robotContacts: 6 },
  { offset: 0, closedTotal: -0.00010097241699852204, robotContacts: 6 },
]
const REAL_DEPTH_ROWS = [
  { width: 0.0384, liftM: -0.0004618982739200139 },
  { width: 0.03, liftM: 0.11249385631473477 },
  { width: 0.024, liftM: 0.11820260366304372 },
  { width: 0.02, liftM: 0.11857971620103594 },
]

describe("G07 固定抓取配置（F14）", () => {
  test("固定配置 = 历史真机读数（0.1029 / 0.03）", () => {
    expect(FIXED_GRASP_CONFIG.tcpOffsetM).toBe(0.1029)
    expect(FIXED_GRASP_CONFIG.closeWidthM).toBe(0.03)
  })

  test("固定偏移档在真实读数里成立；**其余档位成立与否不再决定判定**", () => {
    const fixed = REAL_OFFSET_ROWS.find(row => row.offset === FIXED_GRASP_CONFIG.tcpOffsetM)
    expect(offsetLooksBlocked(fixed)).toBe(true)
    // 语义钉子：-0.1029 档也有真实接触（搜索会命中它），但它不是判定依据。
    expect(offsetLooksBlocked(REAL_OFFSET_ROWS[1])).toBe(true)
    expect(REAL_OFFSET_ROWS[1]!.offset).not.toBe(FIXED_GRASP_CONFIG.tcpOffsetM)
  })

  test("负对照：固定档缺失（undefined）⇒ 判否，不默认通过", () => {
    expect(offsetLooksBlocked(undefined)).toBe(false)
    expect(liftAchieved(undefined)).toBe(false)
    expect(offsetLooksBlocked(REAL_OFFSET_ROWS.find(row => row.offset === 0.999))).toBe(false)
  })

  test("负对照：接触=0 且闭合总宽未超阈值 ⇒ 判否（不能靠宽度阈值单独放行）", () => {
    expect(offsetLooksBlocked({ robotContacts: 0, closedTotal: 0.0384315325671214 })).toBe(false)
    expect(offsetLooksBlocked({ robotContacts: 0, closedTotal: undefined })).toBe(false)
  })

  test("负对照：真实出现过的'碰到但抬不起来'（lift=8.7e-5）与负抬升 ⇒ 判否", () => {
    expect(liftAchieved({ liftM: 0.00008746172608004033 })).toBe(false)
    expect(liftAchieved({ liftM: -0.0004618982739200139 })).toBe(false)
  })

  test("固定闭合档在真实读数里成立（lift=0.1125 ≥ 0.08）", () => {
    const fixed = REAL_DEPTH_ROWS.find(row => row.width === FIXED_GRASP_CONFIG.closeWidthM)
    expect(liftAchieved(fixed)).toBe(true)
    // 语义钉子：0.024/0.02 档抬得更高，但判定只用固定值——"扫到更深"不算通过依据。
    expect(REAL_DEPTH_ROWS.filter(row => liftAchieved(row)).length).toBe(3)
  })
})
