/**
 * DEV-039：把 3D 渲染失败翻译成**用户能照着做**的一段话。
 *
 * 为什么单独成模块：这是"环境缺能力"这一类失败的**呈现层**，需要能被单独测试，
 * 而不必把整个 workbench 组件树拉进测试里。
 *
 * ── 2026-09-26 对齐（验收 `VERIFY-ENV-READINESS-GPU-20260926.md` §3 的 C3）──
 *
 * 这里原来自己造了一套"四条常见原因"，其中
 * `③ 显卡驱动过旧或升级后异常 → 更新/重装驱动` 与 `④ 显卡不存在或被占用 → 换机器`
 * 与 W14/W21 的环境契约**互相打脸**：契约的 `device-hidden` 行明写「**不要**重装驱动、**不要**换卡」。
 *
 * **两种场景不是同一个场景，所以两句话都要在 —— 但必须各说各的、不许越界**：
 *
 *  · 本模块讲的是 **浏览器侧**：`createViewer()` 创建 WebGL 上下文失败（`VIEWER_WEBGL_UNAVAILABLE`）。
 *    它可能源于浏览器/会话（硬件加速被关、远程桌面无 GL、企业策略放行），也可能源于**宿主侧**的 GPU 问题
 *    —— 而**浏览器读不到宿主的 `/dev`、`/proc/driver`、`nvidia-smi`**，所以这一层**没有资格**判定
 *    "驱动坏了"还是"设备被会话隐藏"。
 *  · 契约（`environment-readiness.ts` 的 GPU 行）讲的是**宿主侧**：按 卡 / 驱动注册 / 驱动挂载 /
 *    设备节点 / `nvidia-smi` 五件事分型，**每一态的处置不同**：`device-hidden`／`card-unknown`／
 *    `smi-missing`／`unknown` 四态明文「**不要**重装驱动」（`no-device` 也只有「加卡或用带 GPU 的机器」
 *    才成立），只有 `driver-broken`／`driver-missing`／`driver-outdated` 三态才允许动驱动。
 *
 * ⇒ 处置：**宿主侧的处置不由这里造句**。WebGL 分支改为消费契约的 `webglNotice()`，
 *   `remedy.summary` 与 `remedy.steps` 逐字来自契约（含它自己的「修复顺序：GPU 行 → 宿主 GL 行 → 本行」），
 *   本层只加两句它自己才知道的话：**世界仍在跑**（工作台状态）与**诊断原文**，
 *   再补一句**边界声明**：驱动/换卡不是第一步，且那两种处置只在 GPU 行确证后才成立。
 *   （旧文件头写着"W14 落地后这里应改为消费那份统一契约"——这就是那一步。）
 *
 * 客户机上 WebGL 可能因为「没有 GPU／驱动挂了／浏览器禁用了硬件加速／远程会话里没有 GL」
 * 而不存在。这不是"场景坏了"，也不是用户的错 —— 所以既不能静默留空座位，也不能只把
 * three.js 的原始异常字符串甩出去。
 */

// 契约是"环境缺能力"的**唯一话术 owner**：WebGL 行的处置从那里来，不在这里重写一遍。
//
// 客户端侧代价（2026-09-26 本机实测：`packages/lyapunov-shell/src/client.tsx` + `target:"browser"`）：
//   shell 客户端产物 603,192 B → 628,192 B（**+24.4 KB / +4.05%**），大头是 Bun 给本模块的
//   `node:path` 内联的浏览器 polyfill。契约的探测函数体**被摇掉**（`procDriverDir`/`probeGpuFacts`/
//   `scanGpuDevices`/`classifyGpu` 在产物里 0 命中），`node:fs`/`node:child_process` 只剩两个空对象桩：
//   **不会被调用**，但**也不会在构建期报错** —— 所以别在客户端引用任何 `probe*`，那会变成运行期
//   TypeError 而不是构建失败。接线由 `test/render-failure.test.ts` 的守卫钉住。
import { webglNotice } from "./environment-readiness.ts"

/** 与 workbench 的 `tr` 同形：中文在前、英文在后。 */
export type RenderFailureTranslate = (zh: string, en: string) => string

/** WebGL 不可用错误的 code，与 `@lyapunov/viewer` 的 `WebGLUnavailableError.code` 一致。 */
export const WEBGL_UNAVAILABLE_CODE = "VIEWER_WEBGL_UNAVAILABLE"

/**
 * 契约里**允许正向处置驱动**的三态，与**允许加卡/换机器**的一态。
 * 只用于下面那句边界声明；`test/render-failure.test.ts` 会拿 `GPU_STATE_WORDING` 逐态核对
 * —— 契约哪天真加了第四个"该动驱动"的态，那个用例先红，而不是让用户读到一句过期的边界。
 */
export const DRIVER_ACTION_STATES = ["driver-broken", "driver-missing", "driver-outdated"] as const
export const CARD_ACTION_STATES = ["no-device"] as const

/** 契约 WebGL 行 `remedy.summary` 的英文对照（契约本身只有中文）。 */
export const WEBGL_REMEDY_SUMMARY_EN = "Turn on browser hardware acceleration; if the driver is unusable, fix GPU visibility/driver first (see the GPU row)."

/** 契约那 4 条处置步骤的英文对照（契约本身只有中文）。步数由用例钉住：契约加一步就必须补一句译文。 */
export const WEBGL_REMEDY_STEPS_EN: readonly string[] = [
  "Turn on “Use hardware acceleration” in the browser settings and restart the browser",
  "WebGL is often disabled in remote-desktop/VM sessions: re-check in a local session",
  "If an enterprise policy blocks WebGL, allow it (chrome://flags or group policy)",
  "Fix order: GPU row → host GL row → this row; if the host has a driver but the session cannot see the GPU, the browser cannot get it either",
]

/** 该失败是否属于"这台机器画不出 3D"（环境缺能力），而不是"这次渲染坏了"。 */
export function isWebGLUnavailable(value: unknown): boolean {
  if (typeof value === "object" && value !== null && (value as { code?: unknown }).code === WEBGL_UNAVAILABLE_CODE) return true
  const raw = value instanceof Error ? value.message : String(value ?? "")
  return raw.includes(WEBGL_UNAVAILABLE_CODE) || /WebGL/i.test(raw)
}

export function describeRenderFailure(value: unknown, tr: RenderFailureTranslate): string {
  const raw = value instanceof Error ? value.message : String(value)
  if (!isWebGLUnavailable(value)) {
    return tr(`3D 渲染初始化失败：${raw}。可重开 Viewer 再试；若持续失败，把这段原文连同日志一起反馈。`,
              `3D rendering failed to initialise: ${raw}. Reopen the viewer to retry; if it persists, report this text with the logs.`)
  }
  // 浏览器在创建上下文失败时把失败**原样上报**给契约，拿回统一的码与处置（本层不判型）。
  const notice = webglNotice({ status: "broken", reading: `WebGL 上下文创建失败：${raw}`, evidence: [raw] })
  // 处置 = 契约的 summary + steps，逐字；英文面自带译文（契约只有中文，混排会露出中文）。
  const stepsZh = notice.remedy.steps.map(step => ` · ${step}`).join("") + "。"
  const stepsEn = WEBGL_REMEDY_STEPS_EN.map(step => ` · ${step}`).join("") + ". "
  return tr("3D 渲染不可用（WebGL 上下文创建失败，" + notice.code + "）。这台机器上画布画不出来，世界仍可运行、停止按钮始终可用。"
          + "怎么解决：" + notice.remedy.summary + stepsZh
          + "先不要把「重装驱动」或「换卡/换机器」当第一步：浏览器这边读不到宿主侧的设备读数，"
          + `这两种处置只在环境面板的 GPU 行确证成 ${DRIVER_ACTION_STATES.join(" / ")}（驱动问题）或 ${CARD_ACTION_STATES.join(" / ")}（确实没有卡）时才成立。`
          + `诊断原文：${raw}`,
            "3D rendering is unavailable (WebGL context creation failed, " + notice.code + "). The canvas cannot render on this machine; "
          + "the world keeps running and Stop stays available. How to fix: " + WEBGL_REMEDY_SUMMARY_EN + stepsEn
          + "Do not start with “reinstall the driver” or “replace the card/machine”: the browser cannot read the host's device state, "
          + `and those two fixes only apply once the GPU row in the environment panel confirms ${DRIVER_ACTION_STATES.join(" / ")} (driver problem) or ${CARD_ACTION_STATES.join(" / ")} (no card). `
          + `Diagnostic text: ${raw}`)
}
