/**
 * 环境就绪的共享字段与话术（GPU/引擎/界面共用）。
 *
 * 这里是**类型与纯话术**的唯一 owner；真实探测留在宿主侧模块。GPU 事实由
 * `sim-contract/gpu-facts.ts` 维护，Shell 与 Provider 都从这里/那里消费，不各写一份。
 */

/** 契约版本：形状变了就 +1；宿主与界面都读它，避免"字段悄悄换了名字"而编译期不报。 */
export const ENVIRONMENT_CONTRACT_VERSION = 1
/** D4：钉住本契约判据的回归测试（每行的 `contractTest` 都指向它，便于"判据↔测试"互相追溯）。 */
export const ENVIRONMENT_CONTRACT_TEST = "packages/lyapunov-shell/test/environment-readiness.test.ts"

export type EnvironmentStatus = "ready" | "degraded" | "missing" | "broken" | "unknown"

/** 状态的人话标签：界面直接用这一份，避免每个面板各译一遍。 */
export const ENVIRONMENT_STATUS_LABEL: Record<EnvironmentStatus, string> = {
  ready: "就绪", degraded: "降级", missing: "缺失", broken: "损坏", unknown: "未知",
}

export type EnvironmentKind = "gpu" | "runtime" | "graphics" | "network" | "quota" | "desktop" | "device" | "tool"

/** D3 的"可执行的下一步"：装什么、去哪装、需要什么权限。**不许**只写"环境有问题"。 */
export interface EnvironmentRemedy {
  summary: string
  steps: readonly string[]
  permission?: string
  docUrl?: string
}

/** D2 的降级路径：有替代就走替代，并讲清"在走什么、为什么、怎么改回"。 */
export interface EnvironmentDegradation {
  /** 替代路径是什么（"回退 MuJoCo 跑 CPU 物理"）。 */
  path: string
  /** 现在是否**已经**在走这条路（"装好后自动改回"的另一半）。 */
  active: boolean
  /** 怎么改回完整能力。 */
  restore: string
}

/** 一行依赖的完整状态：D1 读数 + 影响面 + D2 降级 + D3 处置。 */
export interface EnvironmentRow {
  id: string
  kind: EnvironmentKind
  label: string
  status: EnvironmentStatus
  /** 细分态（GPU 五态、运行时空壳…）；无细分时为 null。 */
  state: string | null
  /** 一句话实测读数，界面直接显示。 */
  reading: string
  /** 影响面：缺了**具体**会怎样（说到功能，不写"可能有问题"）。 */
  impact: string
  /** 这个判定是否**不确定**（读数可能有误/不完整/只是启发式）。true 时话术必须原样带出下面的说明。 */
  uncertain: boolean
  /**
   * 这一行**自己的**不确定性说明（`uncertain === true` 时由通用话术原样带出）。
   *
   * 为什么放行数据里而不是话术函数里：不同依赖"不确定"的原因完全不同——GPU 是"可能是沙箱/容器误报"，
   * 宿主 GL 是"无显示≠用户浏览器没有 WebGL"，HTML 预检是"只扫了前 N 字节"。把某一方的句子硬编码进
   * 通用分支，别的调用方就只能**绕开** `uncertain`（等于没有这个机制）——这正是 2026-09-26 修掉的那个错。
   * 缺省（不给）= 通用分支只说中性的"这个判定不确定，别据此下结论"。
   */
  uncertaintyNote?: string | null
  /** 原始证据行（不含凭据），可原样贴进回执。 */
  evidence: readonly string[]
  /** D2：有替代路径就给；`null` = 无替代 → 由 D3 明确拒绝。 */
  degradation: EnvironmentDegradation | null
  /** D3：处置建议。 */
  remedy: EnvironmentRemedy
  /**
   * 这一行怎么参与总评（三种语义，界面也可以按它分组）：
   *  · `overall` 必答项：缺了且无降级路径 → 总评 `unusable`；缺了 → `degraded`；
   *  · `detail` 必答明细（单引擎运行时）：缺了 → `degraded`，但永远不判 `unusable`；
   *  · `optional` 按需能力（真机/额度/安装前置/浏览器 WebGL）：只登记不降总评——
   *    "没插机器人"不许被报成"这台机器不可用"。
   */
  scope: "overall" | "detail" | "optional"
  /** D4：钉住这一行判据的回归测试。 */
  contractTest: string
}

/** N1：用户可见的**一屏**（GPU/驱动、各引擎运行时、WebGL、网络、额度…）。 */
export interface EnvironmentPanel {
  schema: typeof ENVIRONMENT_CONTRACT_VERSION
  generatedAt: string
  /** 总评：`unusable` 只给"必答项缺失且无替代路径"（例如三个模拟引擎一个都没装）。 */
  overall: "ready" | "degraded" | "unusable"
  summary: string
  /** 读不到的依赖 id。unknown ≠ ready，界面必须显式列出而不是留空。 */
  unknown: readonly string[]
  /** 明细里不可用的依赖 id（按需能力：真机/额度/单引擎）。 */
  unavailable: readonly string[]
  rows: readonly EnvironmentRow[]
}

export function environmentRowById(panel: EnvironmentPanel, id: string): EnvironmentRow | undefined {
  return panel.rows.find(row => row.id === id)
}

// ───────────────────────────── 统一话术（D2/D3） ─────────────────────────────

/**
 * 一行依赖的**统一话术**：状态 → 影响 → 现在怎么办 → 怎么改回。
 *
 * 四个功能（引擎回退、Provider 安装、Provider 运行、界面呈现）都说这四句，界面直接逐行渲染即可；
 * 需要换措辞时改这一处——这正是 N4"统一话术"的落点。
 */
export function environmentRowWording(row: EnvironmentRow): string[] {
  // 通用分支**不塞任何调用方专属的句子**：行自己给了 uncertaintyNote 就原样带出，没给就说中性那句。
  const note = row.uncertaintyNote ?? null
  const uncertainty = row.uncertain
    ? note !== null && note !== undefined && note.trim() !== ""
      ? `（${note.trim()}）`
      : "（**这个判定不确定**：不得据此下结论，按下面的步骤复核后再行动）"
    : ""
  const head = `[${row.label}] ${ENVIRONMENT_STATUS_LABEL[row.status]}：${row.reading}${uncertainty}`
  const impact = `影响：${row.impact}`
  if (row.status === "unknown") {
    // 读不到时**只**说"怎么把它测清楚"：既不放行也不阻断，绝不拿降级路径冒充"已经查清"。
    return [head, impact, "现在：未知不等于可用，先按下面的步骤把读数测清楚（既不放行、也不阻断）", `怎么测清楚：${row.remedy.summary}`, ...row.remedy.steps.map(step => `· ${step}`)]
  }
  const current = row.degradation
    ? `现在：${row.degradation.path}${row.degradation.active ? "（已在走这条路）" : "（可用时自动切换）"}`
    : row.status === "ready"
      ? "现在：无需处置"
      : "现在：**无替代路径**，该能力将被明确拒绝（不会静默留空）"
  const fix = row.degradation ? `怎么改回：${row.degradation.restore}` : `怎么解决：${row.remedy.summary}`
  return [head, impact, current, fix, ...row.remedy.steps.map(step => `· ${step}`)]
}

/** 整屏话术：总述 + 每个非就绪行的四句话（就绪行不刷屏）。 */
export function environmentPanelWording(panel: EnvironmentPanel): string[] {
  const lines = [`环境就绪：${panel.summary}`]
  for (const row of panel.rows) if (row.status !== "ready") lines.push("", ...environmentRowWording(row))
  return lines
}

/** 稳定错误码：`ENVIRONMENT_<依赖ID>_<状态>`——可 grep、可进回执、界面可直接显示。 */
export function environmentCode(dependencyId: string, state: string | null, status: EnvironmentStatus): string {
  const id = dependencyId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  const detail = (state ?? status).toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  return `ENVIRONMENT_${id}_${detail}`
}

