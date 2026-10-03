/**
 * G07 抓取验收的**固定配置**与判定谓词（DEV-027 F14）。
 *
 * 覆盖审计的 F14：门在验收期先做"TCP 偏移四档搜索"，再 `rows.find(...)` 取命中的那一档当
 * `chosenOffset`，闭合深度同理（四档里取第一档 lift≥0.08）——**判据于是退化成
 * "扫过的网格里存在一个能过的组合"**：门换一个夹具/换一台机器时，只要某档侥幸过去就算通过，
 * "通过"不再说明任何**预先声明**的配置可复现。这不是产品缺陷，而是**验收语义**问题：
 * 验收要求的是"按声明好的配置复现契约"，不是"现场调参调到过"。
 *
 * 这里把判定用的配置冻成常量（值取自历史真机读数，见
 * `.runtime/lane-dev027f/g07-before-calibration.log` 的逐档原始读数）：
 *   · tcpOffsetM = 0.1029 → 手指接触=4、闭合总宽=0.04636082520891582（> 命令 0.0384 ⇒ 被物体挡住）
 *   · closeWidthM = 0.03   → 实测抬升=0.11249385631473477（≥ 0.08）
 * 门只断言"**这两档固定值**在本机复现"；其余档位的读数照旧打印，但只作证据，不参与挑值。
 * 固定值在本机不复现 ⇒ 门如实 BLOCKED 并指名是哪一档（不回退成"搜索到就算过"，也不放宽阈值）。
 *
 * 谓词与常量放在这里（而不是 `script/refactor-verify.ts` 内）是为了能跑**负对照单测**：
 * 薄入口是顶层 CLI、import 即执行，不能被测试 import。
 */

/** 验收用固定抓取配置（F14）：判定只认这两个值，搜索不再参与挑值。 */
export const FIXED_GRASP_CONFIG = {
  /** 手掌 TCP 相对 link7 的安装偏移（m）。 */
  tcpOffsetM: 0.1029,
  /** 闭合命令宽度（m）。夹爪被 40mm 物体挡住时闭合总宽≈0.04。 */
  closeWidthM: 0.03,
} as const

/**
 * "手指确实被物体挡住"的宽度阈值（m）。夹爪自由闭合到命令值 0.0384，被物体挡住时停在物体宽度附近；
 * 单独用宽度会把"压根没碰到"也算成功，故与"真实机器人接触数>0"取或（与门内原判据同一口径）。
 */
export const OFFSET_BLOCKED_MIN_CLOSED_TOTAL_M = 0.041

/** 抓取契约要求的真实抬升下限（m），与 `minimumLiftM` 同一口径。 */
export const MINIMUM_LIFT_M = 0.08

/** 某一档 TCP 偏移是否"手指被物体挡住"（真实接触 >0 或闭合总宽超阈值）。`undefined`（该档缺失/IK 失败）判否。 */
export function offsetLooksBlocked(row: { robotContacts?: number; closedTotal?: number } | undefined): boolean {
  if (row === undefined) return false
  return (row.robotContacts ?? 0) > 0
    || (row.closedTotal !== undefined && row.closedTotal > OFFSET_BLOCKED_MIN_CLOSED_TOTAL_M)
}

/** 某一档闭合深度是否真的夹住并抬起（实测抬升 ≥ 0.08）。`undefined`（该档缺失/异常）判否。 */
export function liftAchieved(row: { liftM?: number } | undefined): boolean {
  if (row === undefined) return false
  return (row.liftM ?? 0) >= MINIMUM_LIFT_M
}
