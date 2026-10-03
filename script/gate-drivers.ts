#!/usr/bin/env bun
/**
 * 门的身份与驱动 —— 机制 2（2026-09-26 收敛；2026-09-27 补两次盲区）
 *
 * ## 为什么需要这个文件
 *
 * 本仓的门是**两文件约定**：
 *
 *   script/gates/<id>.ts        门的【实现】—— 纯导出模块（`export async function gateXxx`），
 *                               顶层零执行语句
 *   script/gates/run-<id>.ts    门的【驱动】—— `await gateXxx()` + `process.exit(code)`
 *   script/refactor-verify.ts   汇总器，直接调实现
 *
 * 后果：`bun run script/gates/g17.ts` **什么都不做，并且 exit 0**。
 *
 * 这个坑真的踩过（2026-09-26，Lead）：把一个空转模块的退出码当成"G17 门通过"，
 * 并在两轮回执里引用它作佐证。真驱动 `run-g17.ts` 当时是 **exit=1（21/24）**。
 *
 * 空转模块的 `exit 0` 是最危险的一种假绿灯：它与"通过"**无法从退出码上区分**。
 * 所以把"哪个门该用哪条命令跑"变成可查询的事实，并标出**没有驱动的门**。
 *
 * ## 盲区一（2026-09-27，验收队实测：机制自己漏看了一个对象）
 *
 * 首版用 `f.endsWith(".ts")` 收 `script/gates/`，于是 **`g10b.mts`（导出 `gateG10b`、
 * 顶层零执行、有驱动 `run-g10b.mts`）无声消失** —— 机制报"实现 14 个，全部有驱动"，
 * 而真实实现文件是 **15** 个。**一个检查报"全部通过"，而它根本看不见其中一个对象。**
 * 两条修法：
 *
 *   ① 收全扩展名（`CODE_EXTENSIONS`；本目录实测存在 `.ts` 45 / `.mts` 3 / `.mjs` 1）
 *   ② 输出**分两类**：「已审计」（遵守两文件约定的实现）与「未纳入审计」
 *      （G01–G07 定义在汇总器 `script/refactor-verify.ts` 内部、无独立实现文件
 *      ⇒ 两文件约定不适用，本机制**不要求**它们有驱动，但**必须把它们报出来**；
 *      否则读者会把"表上 15 行绿"误当成"每个门都能单独复跑"）
 *
 * **判据一个字没放宽**：已审计的实现没有驱动 ⇒ **exit 2**。
 * 「未纳入审计」不是缺陷，是**审计范围边界**，所以不计入退出码 —— 但它必须在输出里看得见。
 *
 * ## 盲区二（2026-09-27，验收队 `VERIFY2-LANDED-FIXES-20260926.md` 第 ② 条）
 *
 * 补完上面两条之后，机制仍然只看得见"导出 `gate*` 的实现 + 驱动"这一种形状。
 * 验收队实测点名：
 *
 *   (a) `g08g09.ts` **一举实现 2 个门身份**（`exported=['gateG08','gateG09']`），
 *       而回执把它算成 1 个 ⇒ 「门身份合计 22」口径不严密：真门身份 ≥ 23。
 *   (b) `script/gates/domain-pointers.ts` 是**真门禁**（`package.json` 有
 *       `gate:domain-pointers`，`docs/A_CLASS_WORKBREAKDOWN_20260926.md:111` 引 31/31），
 *       而在输出里 **0 次出现** —— **既非已审计也非未纳入审计**。
 *       同类的还有 `blender-mcp-live.ts` / `computer-use-blender.ts` /
 *       `viewer-play.ts` / `anim-glb.mjs`。
 *   (c) `contract.ts` / `g03-clock.ts` / `g07-calibration.ts` / `g12-exit.ts` /
 *       `probe-launch-chain.ts` 五个文件既非实现也非审计对象，**全部不可见**；
 *       其中 `g03-clock` / `g07-calibration` **承 G03/G07 的判定谓词**
 *       （`script/refactor-verify.ts:36-37` import）⇒ 回执说"G01–G07 无独立实现文件"
 *       **对 G03/G07 只对一半**。另有 `G16` 有 `--gate` 路由（blocked）也不在 22 里。
 *
 * ⇒ **同一个形状的第三次**：**一个检查报"全部通过"，而它看不见几个对象。**
 * 这一次的修法不是再补一个关键字，是把**判据本身**换成一句可复算的等式：
 *
 * > **输出里列出的文件数 == `script/gates/` 目录下真实存在的文件数。**
 *
 * 也就是说：目录下**每一个**文件都必须落进一个**具名类别**，并带一条可 grep 复算的
 * 「为什么」；任何文件落不进类别 ⇒ `UNCLASSIFIED` + exit 2（**看得见**，不是少报）。
 * 类别见 `GateFileKind`；「其它」不是垃圾桶，是**有依据的分类**：
 *
 *   · **子探针**       —— 被本目录内某个门以命令行调用（`g17.ts:913` / `g19.ts:38,255` /
 *                        `g10b.mts:118`），自带入口，但不驱动任何实现
 *   · **目录级门禁**   —— `package.json` 里有指向它的脚本（`domain-pointers.ts`），
 *                        自带入口、单文件成门 ⇒ **是真门禁，但不遵守两文件约定**
 *   · **共享谓词**     —— 顶层零执行、导出非门符号、被别的门 import 的纯判定模块
 *   · **独立现场驱动** —— 自带入口、无门引用、无 `package.json` 脚本（未接线）
 *   · **测试**         —— `*.test.*` 一族（`preflight`/`test:ci` 的发现面，本机制不重复审）
 *   · **非脚本**       —— 扩展名不在 `CODE_EXTENSIONS` 里的文件（**照样列出来**，
 *                        不允许"扩展名不在表里"静默消失 —— 这正是盲区一的形状）
 *
 * **门身份按身份计数，同时给文件数**（验收队 (a)）：`g08g09.ts` 贡献 **2** 个身份，
 * `run-g19.ts` + `run-g19.mts` 是 **1** 个门的 2 条驱动 ⇒ 三组数字互不相等，
 * 输出里必须同时出现，不许拿其中一个冒充另一个。
 *
 * ## 用法
 *
 *   bun run script/gate-drivers.ts              # 全表 + 文件级清单 + 缺驱动/看不见则 exit 2
 *   bun run script/gate-drivers.ts --gate G19   # 只查一个门（未纳入审计的门也答）
 *   bun run script/gate-drivers.ts --json       # 机器可读：**已审计**那一类的数组
 *   bun run script/gate-drivers.ts --json-all   # 机器可读：两类 + 文件清单 + 覆盖面 + 合计
 *   bun run script/gate-drivers.ts --root <dir> # 换发现根（负对照夹具用；默认仓根）
 *
 * ⚠️ `--json` 的 stdout **必须**是一个自足 JSON 数组，且它之后不能再出现 `]`：
 *    `script/release-gate.ts` 的 `parseGateDrivers()` 取 `indexOf("[")` 到
 *    `lastIndexOf("]")` 再 `JSON.parse`，而它把 **stdout 与 stderr 拼接**后交给解析器
 *    （`run()` 里 `out = stdout + stderr`）。所以 `--json` 模式下写到 stderr 的提示
 *    **不许含方括号**。`script/gate-drivers.test.ts` 有一条用例按同一口径钉住这个契约。
 *
 * ⚠️ `script/release-gate.ts` 的 `gate-drivers` lane 是另一条 lane（R2）的写域。
 *    本文件只保证 `--json` 的形状不变；**把本机制的新读数接进 release-gate 要报 R2 接**。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const DEFAULT_ROOT = resolve(import.meta.dirname, "..")

/**
 * 收全**本仓实际存在**的脚本扩展名。
 *
 * 首版只收 `.ts` —— 于是 `g10b.mts` 无声消失（见文件头）。本目录实测：
 * `.ts` 45 / `.mts` 3 / `.mjs` 1（三个 `.mts` 是 `g10b.mts`、`run-g10b.mts`、`run-g19.mts`；
 * `.mjs` 是 `anim-glb.mjs`）。把 `.cts` / `.tsx` / `.js` / `.cjs` 一并收进来，
 * 是为了**下次有人换扩展名时不重演同一个盲区**，代价只是多列几个文件。
 *
 * ⚠️ 这张表**不再是发现集合的边界**：不在表里的扩展名不会再静默消失，而是以
 *    「非脚本」这个具名类别进文件清单（见 `GateFileKind`）。判据是等式
 *    「清单文件数 == 目录文件数」，不是"表里有没有"。
 */
export const CODE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"] as const

/** 测试类文件名（与 `script/test-ci.ts:88` 的发现规则同一族，扩展名全谱）。 */
const TEST_LIKE = /(?:\.test|\.spec|\.smoke)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/**
 * 顶层可执行语句的判据 —— 这是**审计判据的一半**（实现 vs 驱动），一个字不许放宽。
 * 故意保守：只认"语句位于第 0 列"这一族。
 *
 * ⚠️ 它**同时**是"哪些文件能被两文件约定审计"的边界，所以 `probe-launch-chain.ts`
 *    （顶层 `try {` + `await import(...)`）落不进它 —— 那个文件既不是实现也不是驱动。
 *    「其它」的分类另有一套更宽的 `SELF_EXEC`（只用于**把它们报出来**，不参与审计判据）。
 */
const TOP_LEVEL_EXEC = /^(await |if \(|for \(|while \(|process\.exit|void |[A-Za-z_$][\w$]*\()/m

/**
 * 「自带入口」判据 —— **只用于给「其它」分类**，不参与"已审计"的判定。
 * 比 `TOP_LEVEL_EXEC` 宽：多认 `try {` / `switch (` / `console.log(`，
 * 因为这里的目标是**别把文件漏掉**，不是收紧审计面。
 */
const SELF_EXEC = /^(?:await |try \{|if \(|for \(|while \(|switch \(|process\.exit|console\.log|void |[A-Za-z_$][\w$]*\()/m

/** 实现里导出的门函数名。 */
const GATE_FN = /^export\s+(?:async\s+)?function\s+(gate[A-Za-z0-9_]*)/gm

/** 非门导出（共享谓词/契约/常量的证据）。 */
const OTHER_EXPORT = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

/**
 * 汇总器**内部**的门定义：`async function gateG05()`。
 * 只认后跟两位门号的（`gateBlocked` 这类辅助函数不是门）；`gateG01Live` 因末尾
 * `(?![A-Za-z0-9_])` 不会被误认成 `G01`。与 `TOP_LEVEL_EXEC` 同口径，只认第 0 列。
 */
const AGGREGATOR_GATE_FN = /^(?:export\s+)?(?:async\s+)?function\s+gate(G\d{2})(?![A-Za-z0-9_])/gm

/**
 * 汇总器薄入口的路由：`if (normalized === "G05") return report(await gateG05())`。
 *
 * 门号全谱：`G05` / `G01LIVE` / `G13ACP` / `G10B` / `G16`（首个版本只认 `G\d{2}`，
 * 于是 `G01LIVE` 一族与 `G16` 都不在路由集合里）。
 */
const AGGREGATOR_ROUTE = /normalized\s*===\s*"(G[A-Z0-9]{2,7})"/g

/** 汇总器里 `GATE_DRIVERS` 的登记（`G10B: "node script/gates/run-g10b.mts"`）。 */
const AGGREGATOR_DRIVER_HINT = /^\s{2}(G[A-Z0-9]{2,7}):\s*"([^"]+)"/gm

/**
 * 本目录内**以命令行调用**另一个文件的证据：**双引号/单引号**里的 `script/gates/<file>`。
 *
 * ⚠️ 故意不认反引号：`g10b.mts:16` 的头注释用反引号提到 `blender-mcp-live.ts`（只是"提及"），
 *    真正的调用点在同文件 `:118` 的 `join(PRODUCT_ROOT, "script/gates/blender-mcp-live.ts")`。
 *    把注释里的提及当成调用，会让"子探针"这一类说假话。
 */
const INVOKE_REF = /["']script\/gates\/([A-Za-z0-9_.-]+)["']/g

/** `package.json` 的脚本里指向 `script/gates/<file>` 的引用。 */
const PKG_GATE_REF = /script\/gates\/([A-Za-z0-9_.-]+)/g

/** import 说明符（`from "…"` / `import("…")` / `import "…"`）。 */
const IMPORT_SPEC = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g

/**
 * 必须在 **node** 下跑的驱动（例外表）。
 *
 * 为什么需要这张表：机制按 `run-<id>.ts` 约定给出 `bun run …`。但本仓有两个门在 bun 下
 * 会因 `@deepseek-ai/dsh-subprocess-local` 静态 `import { getSystemErrorMessage } from "node:util"`
 * 而崩（bun 1.3.13 的 `node:util` 没有该导出）。**实测**：
 *
 *   bun -e 'import("@deepseek-ai/dsh-subprocess-local")'
 *     ⇒ LOAD_FAILED: Export named 'getSystemErrorMessage' not found in module 'node:util'
 *
 * 两个门的处置**不一样**：
 *
 *   - `run-g19.ts`  **在 bun 下自切 node**（`LYAPUNOV_G19_REEXEC=1` 防递归）⇒ `bun run …` 可用；
 *   - `run-g10b.mts` **没有自切**，头部自述「必须在 **node** 下运行」、
 *     「用法：… node script/gates/run-g10b.mts」⇒ 对它给 `bun run …` 会得到一个
 *     **与门判据无关的假失败**。
 *
 * ⚠️ 收全扩展名之后 `g10b` **第一次**进入这张表 —— **只补扩展名而不处理运行器，
 *    修盲区的动作本身就会引入一条新的假读数**。所以例外必须显式登记，不能靠猜：
 *    机制无法从"驱动没写自切"推出"它需要 node"（绝大多数驱动在 bun 下正常）。
 *
 * 表**自校验**（`verifyRunnerOverrides()`）：驱动必须存在、头部必须仍自述 `node script/gates/<自己>`、
 * 且不得已经自带 bun→node 自切。任一条不成立 ⇒ `RUNNER-STALE` + exit 2 ——
 * 这样表不会在驱动被改成自切之后继续推荐 node（机制 11：判定必须稳定，陈旧必须报出来）。
 *
 * ⚠️ 同一份知识在 `script/refactor-verify.ts` 的 `GATE_DRIVERS` 里也有一份（薄入口的指路文案）。
 *    两处都改了才算改完 —— 本机制**只读**解析那张表并在 `--json-all` 的
 *    `aggregator.driverHints` 里报出来，`script/gate-drivers.test.ts` 有一条用例核对两者一致。
 */
const NODE_ONLY_DRIVERS: Record<string, string> = {
  "run-g10b.mts": "驱动头部自述「必须在 node 下运行（bun 无法加载 dsh-subprocess-local）」，且没有 bun 自切",
}

export interface GateDriver {
  /** 门标识，取自实现文件名（如 `g17`、`g08g09`、`g13-acp`、`g10b`）。 */
  id: string
  /** 实现文件（相对仓根）。 */
  implementation: string
  /** 实现导出的门函数名。 */
  exported: string[]
  /** 该实现贡献的**门身份**（`gateG08`/`gateG09` ⇒ `G08`/`G09`；一个文件可以给多个）。 */
  identities: string[]
  /** 驱动文件（相对仓根）；缺驱动时为空。 */
  driver: string | null
  /** 该门实际可跑的命令；缺驱动时为空。 */
  command: string | null
  /** 同门还有哪些候选驱动（只报告，不隐藏）。 */
  alternates: string[]
  /** 命令用的运行器：`bun`（约定）或 `node`（例外表，见 `NODE_ONLY_DRIVERS`）。 */
  runner: string
}

/** 「未纳入审计」的门：门身份存在，但没有独立实现文件 ⇒ 本机制审不了它。 */
export interface UnauditedGate {
  /** 门标识（如 `G01`）。 */
  id: string
  /** **为什么**它不在本机制的审计范围内。 */
  reason: string
  /** 定义位置（相对仓根：行）。 */
  definedAt: string[]
  /** 单跑命令；汇总器没有该门的 `--gate` 路由时为 `null`。 */
  command: string | null
  /**
   * 与这个门相关、但**不在**「已审计」里的文件（相对仓根）。
   *
   * 为什么要有这一列：`G03` / `G07` 的判定谓词在 `script/gates/g03-clock.ts` /
   * `g07-calibration.ts` 里（被汇总器 `script/refactor-verify.ts:37/:36` import）。
   * 只说"G01–G07 无独立实现文件"**对 G03/G07 只对了一半** —— 没有实现**文件**，
   * 但有判定谓词文件。这一列就是把那另一半摆出来。
   */
  relatedFiles: string[]
}

/** 汇总器路由了、但本仓既无实现也无内部定义的门（如 `G16`）。 */
export interface RoutedOnlyGate {
  id: string
  /** 路由位置（相对仓根：行）。 */
  routedAt: string
  /** 该路由是不是 `gateBlocked(...)`（真跑不了，而不是"还没接"）。 */
  blocked: boolean
  /** `gateBlocked` 的理由原文（能抓到就抓，抓不到为 null）。 */
  reason: string | null
  /** 单跑命令：本来就没有实现，故为 null（不许给一条假命令）。 */
  command: null
}

/** 汇总器（`script/refactor-verify.ts`）那一侧的可见面 —— 只读解析，不改它。 */
export interface AggregatorSurface {
  present: boolean
  defined: UnauditedGate[]
  routedOnly: RoutedOnlyGate[]
  /** 汇总器认识的全部门号（`normalized === "…"` 全集）。 */
  routes: string[]
  /** 汇总器里 `GATE_DRIVERS` 的登记：门号 → 指路命令（与机制输出是同一份知识的副本）。 */
  driverHints: Record<string, string>
}

/**
 * `script/gates/` 下一个文件的类别。
 *
 * 这张表的判据是**完备性**：目录下每个文件必须恰好落进一类，落不进 ⇒ `UNCLASSIFIED` + exit 2。
 */
export type GateFileKind =
  /** 遵守两文件约定的实现（`export function gate*` + 顶层零执行）。 */
  | "实现"
  /** 实现了某个门的驱动（顶层有执行 + 引用了某个实现的导出）。 */
  | "驱动"
  /** 被本目录内某个门以命令行调用的子探针（自带入口，不驱动实现）。 */
  | "子探针"
  /** `package.json` 里有脚本指向它、自带入口的单文件门禁（如 `domain-pointers.ts`）。 */
  | "目录级门禁"
  /** 顶层零执行、导出非门符号、被别的门 import 的纯判定模块。 */
  | "共享谓词"
  /** 自带入口、无门引用、无 `package.json` 脚本的独立现场驱动（未接线）。 */
  | "独立现场驱动"
  /** `*.test.*` 一族（`preflight` / `test:ci` 的发现面）。 */
  | "测试"
  /** 扩展名不在 `CODE_EXTENSIONS` 里的文件 —— 照样列出来，不允许它静默消失。 */
  | "非脚本"
  /** 落不进任何一类 ⇒ 覆盖面缺口，exit 2。 */
  | "未知"

/** 全部类别（输出与合计按固定顺序遍历，判定才稳定 —— 机制 11）。 */
export const GATE_FILE_KINDS: readonly GateFileKind[] =
  ["实现", "驱动", "子探针", "目录级门禁", "共享谓词", "独立现场驱动", "测试", "非脚本", "未知"]

/** 文件级清单的一行：「这个文件是什么、服务哪个门、凭什么这么说」。 */
export interface GateFileRow {
  /** 相对仓根（`script/gates/<name>`）。 */
  file: string
  kind: GateFileKind
  /** 该文件服务/实现的门身份（按身份给，可能多个；查不出来就是空）。 */
  serves: string[]
  /** **为什么**算这一类 —— 必须是可 grep 复算的证据（行号/符号名/脚本名）。 */
  why: string
  /**
   * 引号路径引用点（`file:line`）—— 别的文件里出现 `"script/gates/<自己>"` 的地方。
   *
   * ⚠️ **这是"这里有引用"的事实，不是"一定在跑"的断言**：`g17.ts:814` 里的
   *    `script/gates/run-g17.ts` 是 tsc include / 扫描器自检的路径提及，不是调用。
   *    所以这一列是**给人核对的线索**；机制不替读者断言那几行在做什么。
   */
  referencedBy: string[]
  /** 被谁 import（共享谓词/实现的消费方，`file:line`）。 */
  importedBy: string[]
  /** `package.json` 里指向它的脚本名。 */
  scripts: string[]
  /** 可直接跑的命令；本机制给不出可靠命令时为 null（宁可不给，也不给假命令）。 */
  command: string | null
}

/** `package.json` 里指向 `script/gates/<file>` 的一条脚本。 */
export interface GateScriptRef {
  name: string
  target: string
  exists: boolean
}

/** 覆盖面自校验 —— 判据就是这一组等式。 */
export interface Coverage {
  /** 目录下**文件**总数（任意扩展名，含测试）。 */
  filesInDir: number
  /** 清单里的文件数。 */
  ledgerFiles: number
  /** 落不进任何类别的文件。 */
  unclassified: string[]
  /** 目录下的子目录（把"把门塞进子目录"这种躲法也摆出来）。 */
  subdirectories: { name: string; files: number }[]
  byKind: Record<string, number>
  gateScripts: GateScriptRef[]
  /** `package.json` 指向了、但盘上不存在的 —— 挂空的门脚本（如藏掉 domain-pointers.ts）。 */
  dangling: GateScriptRef[]
  /** 非空的 ⇒ exit 2（`UNCLASSIFIED` / `GATE-SCRIPT-DANGLING` / `GATES-DIR-MISSING`）。 */
  problems: string[]
}

export interface Discovery {
  gates: GateDriver[]
  drivers: string[]
  unaudited: UnauditedGate[]
  /** 汇总器路由了但本仓无实现的门（`G16`）。 */
  routedOnly: RoutedOnlyGate[]
  aggregator: AggregatorSurface
  /** 文件级清单：目录下**每一个**文件恰好一行。 */
  ledger: GateFileRow[]
  coverage: Coverage
  /** 发现根（绝对路径）。 */
  root: string
  /** `script/gates/` 里实际出现的扩展名 → 文件数（含测试文件，如实计数）。 */
  present: Record<string, number>
  /** 目录下文件总数（= `coverage.filesInDir`，单独给一份便于读）。 */
  fileCount: number
  /** 例外表的自校验问题；非空 ⇒ exit 2。 */
  runnerProblems: string[]
  totals: {
    /** 遵守两文件约定的**实现文件**数。 */
    auditedFiles: number
    /** 这些实现贡献的**门身份**数（`g08g09.ts` 贡献 2 ⇒ 16 ≠ 15）。 */
    auditedIdentities: number
    /** 有驱动的实现**文件**数。 */
    withDriver: number
    /** 缺驱动的实现**文件**数（非 0 ⇒ exit 2）。 */
    withoutDriver: number
    /** 驱动**文件**数（`g19` 两条驱动 ⇒ 16 ≠ 15）。 */
    driverFiles: number
    /** 汇总器内部定义、无独立实现文件的**门身份**数（`G01`–`G07`）。 */
    unaudited: number
    /** 汇总器路由了但本仓无实现的**门身份**数（`G16`）。 */
    routedNoImplementation: number
    /**
     * **门身份合计** = 已审计实现身份 + 汇总器内部 + 汇总器路由无实现。
     * ⚠️ 与"文件数"不是一回事，两个都要给（验收队 ②(a)）。
     */
    identities: number
    /** 上面那 23 个里"本仓有实现或定义"的（不含已移出的 `G16`）。 */
    identitiesPresentInRepo: number
    /** 覆盖面：目录下文件数 / 清单文件数 / 未归类数。 */
    filesInDir: number
    ledgerFiles: number
    unclassified: number
    byKind: Record<string, number>
    /** 兼容别名：= `auditedFiles`（旧字段，语义已写明，不再当身份数用）。 */
    audited: number
  }
}

/** `script/gates/` 下**全部**文件（任意扩展名）—— 覆盖面的分母。 */
export function allFilesInGates(root: string = DEFAULT_ROOT): string[] {
  const dir = join(root, "script", "gates")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name)
    .sort()
}

/** `script/gates/` 下**收得进发现集合**的文件（收全扩展名、排除测试类）。 */
export function filesInGates(root: string = DEFAULT_ROOT): string[] {
  return allFilesInGates(root)
    .filter(f => CODE_EXTENSIONS.some(ext => f.endsWith(ext)))
    .filter(f => !TEST_LIKE.test(f))
}

/** 命令模板：`bun run <file>`（机制约定）与 `node <file>`（例外表）**不是**同一个形状。 */
function commandFor(runner: string, file: string): string {
  return runner === "node" ? `node script/gates/${file}` : `bun run script/gates/${file}`
}

/** 候选驱动的排序：约定名 `run-<id>.ts` 最优，其次约定名的其它扩展名，最后才是"只是提到了这个函数"。 */
function driverRank(id: string, file: string): number {
  if (file.replace(/\.[^.]+$/, "") !== `run-${id}`) return 2
  return file.endsWith(".ts") ? 0 : 1
}

/** 文件主干名（`g08g09.ts` → `g08g09`）。 */
function stem(file: string): string {
  return file.replace(/\.[^.]+$/, "")
}

/**
 * 导出的门函数名 → **门身份**（验收队 ②(a) 的口径）。
 *
 *   gateG08     → G08
 *   gateG01Live → G01LIVE
 *   gateG13Acp  → G13ACP
 *   gateG10b    → G10B
 *
 * 认不出来（不是 `gateG<两位数字><后缀>`）⇒ `null`：那个导出会被列在 `exported` 里、
 * 但**不计入门身份** —— 不猜。
 */
export function identityOf(exported: string): string | null {
  const m = /^gate(G\d{2})([A-Za-z0-9]*)$/.exec(exported)
  if (!m) return null
  return `${m[1]}${m[2]!.toUpperCase()}`
}

/**
 * 例外表自校验。返回问题清单（空 = 表仍与现实一致）。三条判据都可 grep 复算：
 *   ① 登记的文件必须真的在驱动集合里；
 *   ② 驱动头部必须仍自述 `node script/gates/<自己>`（运行器声明还在）；
 *   ③ 驱动不得已经自带 `process.versions.bun` 自切（那样 `bun run` 已经可用 ⇒ 该从表里删掉）。
 */
function verifyRunnerOverrides(root: string, driverFiles: string[]): string[] {
  const problems: string[] = []
  for (const [file, why] of Object.entries(NODE_ONLY_DRIVERS)) {
    if (!driverFiles.includes(file)) {
      problems.push(`${file} 登记为 node-only，但它已不在驱动集合里（登记理由：${why}）`)
      continue
    }
    const source = readFileSync(join(root, "script", "gates", file), "utf8")
    // 只要求"这个驱动自述要用 node 跑自己"，**不**要求扩展名逐字相同：
    // `run-g10b.mts` 头部写的是 `node script/gates/run-g10b.ts`（它自己那行就是旧扩展名），
    // 卡到扩展名会把一条**真实存在**的例外误判成过期 —— 那是判定说假话，比不检查更坏。
    const escaped = stem(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`node\\s+script/gates/${escaped}\\.[A-Za-z]+`).test(source)) {
      problems.push(`${file} 头部不再出现 \`node script/gates/${stem(file)}.<ext>\``
        + ` 的运行器声明 ⇒ 本例外已过期，请删掉或更新`)
    }
    if (/process\.versions\.bun/.test(source)) {
      problems.push(`${file} 已自带 bun→node 自切 ⇒ 本例外已过期，应从 NODE_ONLY_DRIVERS 删掉`)
    }
  }
  return problems
}

// ─────────────────────────────────────────────────────────────────────────────
// 只读解析汇总器：未纳入审计的门 / 路由了但本仓无实现的门 / GATE_DRIVERS 登记

/**
 * 汇总器内部定义的门 —— 机制**审不了**它们，但必须报出来。
 *
 * 为什么不能只字不提：它们没有 `script/gates/<id>.ts` 可审，两文件约定对它们不适用，
 * 所以"已审计的那一类全绿"**不等于**"每个门都能单独复跑"。不提 = 又一次静默看不见。
 *
 * ⚠️ `relatedFiles` 由调用方（`discover()`）用文件清单补齐 —— `G03`/`G07` 的判定谓词
 *    在 `script/gates/g03-clock.ts` / `g07-calibration.ts`，只说"无独立实现文件"只对一半。
 */
function scanAggregator(root: string, auditedIdentities: Set<string>): AggregatorSurface {
  const rel = "script/refactor-verify.ts"
  const file = join(root, rel)
  if (!existsSync(file)) {
    return { present: false, defined: [], routedOnly: [], routes: [], driverHints: {} }
  }
  const source = readFileSync(file, "utf8")
  const routed = new Map<string, { at: string; blocked: boolean; reason: string | null }>()
  for (const m of source.matchAll(AGGREGATOR_ROUTE)) {
    const id = m[1]!
    if (routed.has(id)) continue
    const line = source.slice(0, m.index).split("\n").length
    const tail = source.slice(m.index, m.index + 1200)
    const reason = /gateBlocked\(\s*normalized\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(tail)?.[1] ?? null
    routed.set(id, { at: `${rel}:${line}`, blocked: /gateBlocked\(/.test(tail), reason })
  }

  const defined: UnauditedGate[] = []
  const seen = new Set<string>()
  for (const m of source.matchAll(AGGREGATOR_GATE_FN)) {
    const id = m[1]!
    if (seen.has(id) || auditedIdentities.has(id)) continue
    seen.add(id)
    const line = source.slice(0, m.index).split("\n").length
    defined.push({
      id,
      reason: `无独立实现文件：门定义在汇总器内部（${rel}:${line}），两文件约定`
        + `（script/gates/<id>.ts + 驱动）对它们不适用 ⇒ 本机制**不要求**它们有驱动，`
        + `也**无法**审计它们；引用它们时不能说"gate:drivers 已覆盖"`,
      definedAt: [`${rel}:${line}`],
      command: routed.has(id) ? `bun run script/refactor-verify.ts --gate ${id}` : null,
      relatedFiles: [],
    })
  }
  defined.sort((a, b) => a.id.localeCompare(b.id))

  const routedOnly: RoutedOnlyGate[] = []
  for (const [id, info] of routed) {
    if (seen.has(id) || auditedIdentities.has(id)) continue
    routedOnly.push({ id, routedAt: info.at, blocked: info.blocked, reason: info.reason, command: null })
  }
  routedOnly.sort((a, b) => a.id.localeCompare(b.id))

  const driverHints: Record<string, string> = {}
  for (const m of source.matchAll(AGGREGATOR_DRIVER_HINT)) driverHints[m[1]!] = m[2]!
  // 只认门号形状的键（`GATE_DRIVERS` 之外的同形状字面量不在这里下结论）。
  for (const key of Object.keys(driverHints)) {
    if (!/^G\d{2}(B|ACP|LIVE)?$/.test(key)) delete driverHints[key]
  }

  return {
    present: true,
    defined,
    routedOnly,
    routes: [...routed.keys()].sort(),
    driverHints,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件级清单：script/gates/ 下每一个文件都必须落进一个具名类别

/** `file:line` 形式的一条引用。 */
interface Ref { file: string; line: number }

/** 被谁 import：把 `script/` 下所有代码文件的 import 说明符解析成绝对路径后反查。 */
function scanImporters(root: string): Map<string, Ref[]> {
  const out = new Map<string, Ref[]>()
  const key = (p: string): string => p.replace(/\.[A-Za-z0-9]+$/, "")
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(abs)
        continue
      }
      if (!CODE_EXTENSIONS.some(ext => e.name.endsWith(ext))) continue
      const source = readFileSync(abs, "utf8")
      for (const m of source.matchAll(IMPORT_SPEC)) {
        const spec = m[1]!
        if (!spec.startsWith(".")) continue
        const k = key(resolve(dirname(abs), spec))
        const arr = out.get(k) ?? []
        const ref = { file: relative(root, abs), line: source.slice(0, m.index).split("\n").length }
        if (!arr.some(x => x.file === ref.file && x.line === ref.line)) arr.push(ref)
        out.set(k, arr)
      }
    }
  }
  walk(join(root, "script"))
  return out
}

/**
 * 引号路径引用点：别的文件里出现 `"script/gates/<自己>"` 的地方（注释里的反引号提及不算）。
 *
 * ⚠️ 这是**引用**，不是**调用** —— 见 `GateFileRow.referencedBy` 的说明。
 */
function scanReferencedPaths(root: string, files: string[]): Map<string, Ref[]> {
  const out = new Map<string, Ref[]>()
  for (const f of files) {
    const source = readFileSync(join(root, "script", "gates", f), "utf8")
    for (const m of source.matchAll(INVOKE_REF)) {
      const target = m[1]!
      if (target === f || !files.includes(target)) continue
      const arr = out.get(target) ?? []
      const ref = { file: f, line: source.slice(0, m.index).split("\n").length }
      if (!arr.some(x => x.file === ref.file && x.line === ref.line)) arr.push(ref)
      out.set(target, arr)
    }
  }
  // 汇总器也扫一次（`script/refactor-verify.ts` 不在本目录）。
  const agg = join(root, "script", "refactor-verify.ts")
  if (existsSync(agg)) {
    const source = readFileSync(agg, "utf8")
    for (const m of source.matchAll(INVOKE_REF)) {
      const target = m[1]!
      if (!files.includes(target)) continue
      const arr = out.get(target) ?? []
      const ref = { file: "script/refactor-verify.ts", line: source.slice(0, m.index).split("\n").length }
      if (!arr.some(x => x.file === ref.file && x.line === ref.line)) arr.push(ref)
      out.set(target, arr)
    }
  }
  return out
}

/** `package.json` 里指向 `script/gates/` 的脚本。 */
function readGateScripts(root: string): GateScriptRef[] {
  const pkg = join(root, "package.json")
  if (!existsSync(pkg)) return []
  let scripts: Record<string, string> = {}
  try {
    scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}
  } catch { return [] }
  const onDisk = new Set(allFilesInGates(root))
  const refs: GateScriptRef[] = []
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== "string") continue
    for (const m of cmd.matchAll(PKG_GATE_REF)) {
      const target = `script/gates/${m[1]!}`
      if (!refs.some(r => r.name === name && r.target === target)) {
        refs.push({ name, target, exists: onDisk.has(m[1]!) })
      }
    }
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target))
}

const fmtRefs = (refs: Ref[]): string[] => refs.map(r => `${r.file}:${r.line}`)

/**
 * 给目录下每个文件定一个类别。
 *
 * ⚠️ 顺序即判据，写死在这里（机制 11：判定必须稳定，不许同一棵树两次得出不同类别）。
 *    先非脚本，再测试（`*.test.*` 是 `test:ci` 的发现面，本机制不重复审），再实现，再驱动，
 *    再子探针/目录级门禁，再共享谓词，再独立现场驱动，最后剩下的一律 `未知`（exit 2）。
 *
 * `serves` 由 `discover()` 预先按"这个文件服务哪个门"算好传进来（实现按导出、
 * 驱动按它引用的导出、子探针按调用方、测试与谓词按文件名前缀）。
 */
function classifyFile(input: {
  file: string
  source: string
  exportedGates: string[]
  otherExports: string[]
  isTest: boolean
  isCode: boolean
  /** 该文件驱动的实现导出名（驱动判据）。 */
  drivenExports: string[]
  invocations: Ref[]
  importers: Ref[]
  scripts: string[]
  serves: string[]
}): GateFileRow {
  const { file, source, exportedGates, otherExports, isTest, isCode, serves } = input
  const rel = `script/gates/${file}`
  const top = TOP_LEVEL_EXEC.test(source)
  const self = SELF_EXEC.test(source)
  const base = {
    file: rel,
    serves,
    referencedBy: fmtRefs(input.invocations),
    importedBy: fmtRefs(input.importers),
    scripts: input.scripts,
  }

  if (!isCode) {
    const ext = /(\.[A-Za-z0-9]+)$/.exec(file)?.[1] ?? "(无扩展名)"
    return {
      ...base, kind: "非脚本", command: null,
      why: `扩展名 ${ext} 不在 CODE_EXTENSIONS 里 ⇒ 本机制不解析它；`
        + `但它**照样进清单**（否则"换一个扩展名"又会重演 g10b.mts 那次静默消失）`,
    }
  }
  if (isTest) {
    return {
      ...base, kind: "测试", command: null,
      why: `测试类文件（TEST_LIKE）⇒ 由 preflight / test:ci 的发现面负责，本机制不重复审；`
        + `但它是 script/gates/ 里的文件，就必须在清单里`,
    }
  }
  if (exportedGates.length > 0 && !top) {
    return {
      ...base, kind: "实现", command: null,
      why: `导出 ${exportedGates.join(" / ")} 且顶层零执行 ⇒ 遵守两文件约定；`
        + `单跑请用它的驱动（见上表「正确命令」列），直接跑本文件只会空转 exit 0`,
    }
  }
  if (top && input.drivenExports.length > 0) {
    return {
      ...base, kind: "驱动", command: null,
      why: `顶层有执行，且引用了实现导出的 ${input.drivenExports.join(" / ")} ⇒ 它是这条门的驱动`,
    }
  }
  if (self && input.invocations.length > 0) {
    return {
      ...base, kind: "子探针", command: null,
      why: `自带入口、不是实现也不是驱动，且有引号路径引用点（${fmtRefs(input.invocations).join(" / ")}）`
        + ` ⇒ 归入"子探针"这一类（本仓 g17/g19/g10b 的头部自述也是这么叫的）；`
        + `引用点要人看一眼是不是真调用 —— 本机制只保证它看得见；`
        + `不给"单跑命令"（参数/运行器由调用点决定，猜一条就是造一条假命令，g10b 那次就是这么来的）`,
    }
  }
  if (self && input.scripts.length > 0) {
    return {
      ...base, kind: "目录级门禁", command: `bun run ${input.scripts[0]!}`,
      why: `package.json 有指向它的脚本（${input.scripts.join(" / ")}）⇒ 它是**真门禁**；`
        + `但它自带入口（同一个文件既是实现又是 CLI），**不遵守两文件约定** ⇒ 不进「已审计」；`
        + `也不进「未纳入审计」（那一类的定义是"没有实现文件可审"，而它有文件、有入口、有独立脚本）`,
    }
  }
  if (!self && otherExports.length > 0) {
    return {
      ...base, kind: "共享谓词", command: null,
      why: `顶层零执行、导出非门符号 ${otherExports.slice(0, 4).join(" / ")}`
        + `${otherExports.length > 4 ? " 等" : ""}，被 ${input.importers.length} 处 import`
        + ` ⇒ 判定谓词/契约模块（本机制审不了它，但它必须看得见）`,
    }
  }
  if (self) {
    return {
      ...base, kind: "独立现场驱动", command: null,
      why: `自带入口，但既没有被本目录任何门或汇总器以命令行引用、也没有 package.json 脚本、`
        + `也不是实现/驱动 ⇒ 未接线的独立现场驱动（本机制只保证它看得见，不报它通过）`,
    }
  }
  return {
    ...base, kind: "未知", command: null,
    why: `落不进任何一类（没有门导出、顶层零执行、没有非门导出、没有 import 方、没有 package.json 脚本）`
      + ` ⇒ **覆盖面缺口**：本机制说不出它是什么，必须报出来而不是跳过`,
  }
}

export function discover(root: string = DEFAULT_ROOT): Discovery {
  const absRoot = resolve(root)
  const dir = join(absRoot, "script", "gates")

  const present: Record<string, number> = {}
  const subdirectories: { name: string; files: number }[] = []
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // `.parked/` 是目录，不是扩展名 —— 但它也是"能把东西藏起来"的地方，故列出来。
        subdirectories.push({ name: `${e.name}/`, files: readdirSync(join(dir, e.name)).length })
        continue
      }
      if (!e.isFile()) continue
      const m = /(\.[A-Za-z0-9]+)$/.exec(e.name)
      const ext = m ? m[1]! : "(无扩展名)"
      present[ext] = (present[ext] ?? 0) + 1
    }
  }
  subdirectories.sort((a, b) => a.name.localeCompare(b.name))

  const all = filesInGates(absRoot)
  const everyFile = allFilesInGates(absRoot)

  // 1) 找实现：导出 gate* 且顶层零执行；其余"有顶层执行"的算驱动候选
  const impls: { file: string; exported: string[] }[] = []
  const drivers: string[] = []
  const driverSource = new Map<string, string>()
  for (const f of all) {
    const source = readFileSync(join(dir, f), "utf8")
    const exported = [...source.matchAll(GATE_FN)].map(m => m[1]!)
    const hasTopLevel = TOP_LEVEL_EXEC.test(source)
    if (exported.length > 0 && !hasTopLevel) impls.push({ file: f, exported })
    else if (hasTopLevel) { drivers.push(f); driverSource.set(f, source) }
  }

  // 2) 找驱动：顶层有执行，且提到了某个实现的导出函数名
  const drivenExports = new Set<string>()
  const gates: GateDriver[] = impls.map(({ file, exported }) => {
    const id = stem(file)
    const candidates = drivers.filter(d => exported.some(fn => new RegExp(`\\b${fn}\\b`).test(driverSource.get(d)!)))
    for (const fn of exported) if (candidates.length > 0) drivenExports.add(fn)
    // 约定名优先：`run-<id>.ts` 优于 `run-<id>.mts`。本仓 G19 的 `.mts` 老驱动是 node-only，
    // 而 `.ts` 驱动在 bun 下自切 node —— 不这样排，收全扩展名反而会让推荐命令退化成假失败那条。
    // 同分按字典序，保证判定稳定（机制 11）。
    const ranked = [...candidates].sort((a, b) => driverRank(id, a) - driverRank(id, b) || a.localeCompare(b))
    const driver = ranked[0] ?? null
    const runner = driver !== null && NODE_ONLY_DRIVERS[driver] !== undefined ? "node" : "bun"
    return {
      id,
      implementation: `script/gates/${file}`,
      exported,
      identities: exported.map(identityOf).filter((x): x is string => x !== null),
      driver: driver ? `script/gates/${driver}` : null,
      command: driver ? commandFor(runner, driver) : null,
      alternates: ranked.slice(1).map(d => `script/gates/${d}`),
      runner: driver ? runner : "—",
    }
  })

  const auditedIdentities = new Set(gates.flatMap(g => g.identities))

  // 3) 文件级清单：目录下每个文件都要落进一类（判据：清单文件数 == 目录文件数）
  const importers = scanImporters(absRoot)
  const invocations = scanReferencedPaths(absRoot, everyFile)
  const gateScripts = readGateScripts(absRoot)
  const key = (p: string): string => resolve(p).replace(/\.[A-Za-z0-9]+$/, "")
  const sourceOf = new Map<string, string>()
  for (const f of everyFile) sourceOf.set(f, readFileSync(join(dir, f), "utf8"))

  /**
   * 这个文件**引用了**哪些实现导出（驱动判据）。
   * ⚠️ 不是"这个文件自己导出了什么" —— 驱动文件自己不导出 `gate*`，它只是**调用**。
   */
  const allGateExports = gates.flatMap(g => g.exported)
  const referencedGateExports = new Map<string, string[]>()
  for (const f of everyFile) {
    const s = sourceOf.get(f)!
    referencedGateExports.set(f, allGateExports.filter(fn => new RegExp(`\\b${fn}\\b`).test(s)))
  }

  // 「这个文件服务哪个门」：实现按导出、驱动按它引用的导出、测试与谓词按文件名主干/前缀
  // （测试先按"被它测的那个实现"的主干名对齐：`g08g09.test.ts` 的主干是 `g08g09`，
  //  要对上 `g08g09.ts` 的 G08+G09 两个身份，不能只按 `^g(\d\d)` 取到 G08）。
  // 子探针要等上面两类算完才知道引用方的身份 ⇒ 第二轮补（见下）。
  const servesByFile = new Map<string, string[]>()
  for (const g of gates) servesByFile.set(g.implementation.replace(/^script\/gates\//, ""), g.identities)
  for (const g of gates) {
    for (const d of [g.driver, ...g.alternates]) {
      if (d) servesByFile.set(d.replace(/^script\/gates\//, ""), g.identities)
    }
  }
  for (const f of everyFile) {
    if (servesByFile.has(f)) continue
    // 测试文件的主干要去掉 `.test` / `.spec` / `.smoke` 那一段再对齐实现名。
    const base = stem(f).replace(/\.(?:test|spec|smoke)$/, "")
    const byStem = gates.find(g => stem(g.implementation.replace(/^script\/gates\//, "")) === base)
    if (byStem) { servesByFile.set(f, byStem.identities); continue }
    const pref = /^g(\d\d)/.exec(base)
    if (pref) servesByFile.set(f, [`G${pref[1]!}`])
  }

  const ledger: GateFileRow[] = everyFile.map(file => {
    const source = sourceOf.get(file)!
    const exportedGates = [...source.matchAll(GATE_FN)].map(m => m[1]!)
    return classifyFile({
      file,
      source,
      exportedGates,
      otherExports: [...source.matchAll(OTHER_EXPORT)].map(m => m[1]!),
      isTest: TEST_LIKE.test(file),
      isCode: CODE_EXTENSIONS.some(ext => file.endsWith(ext)),
      drivenExports: referencedGateExports.get(file) ?? [],
      invocations: invocations.get(file) ?? [],
      importers: importers.get(key(join(dir, file))) ?? [],
      scripts: gateScripts.filter(s => s.target === `script/gates/${file}`).map(s => s.name),
      serves: servesByFile.get(file) ?? [],
    })
  })

  // 子探针的 `serves` 依赖"谁调用了它" —— 调用方的身份上面已经算好，这里回填。
  for (const row of ledger) {
    if (row.kind !== "子探针") continue
    const name = row.file.replace(/^script\/gates\//, "")
    const serves = new Set<string>()
    for (const ref of invocations.get(name) ?? []) {
      for (const id of servesByFile.get(ref.file.replace(/^script\/gates\//, "")) ?? []) serves.add(id)
    }
    row.serves = [...serves].sort()
  }

  const aggregator = scanAggregator(absRoot, auditedIdentities)
  // G03/G07 的判定谓词在 script/gates/ 里 —— 把「另一半」补进"未纳入审计"的登记。
  for (const g of aggregator.defined) {
    g.relatedFiles = ledger
      .filter(r => r.serves.includes(g.id) && r.kind !== "实现")
      .map(r => r.file)
  }

  const unclassified = ledger.filter(r => r.kind === "未知").map(r => r.file)
  const dangling = gateScripts.filter(s => !s.exists)
  const byKind: Record<string, number> = {}
  for (const k of GATE_FILE_KINDS) byKind[k] = 0
  for (const r of ledger) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1

  const problems: string[] = []
  if (!existsSync(dir)) problems.push(`GATES-DIR-MISSING\t${dir} 不存在：本机制无从谈起`)
  for (const f of unclassified) {
    problems.push(`UNCLASSIFIED\t${f} 落不进任何一类 ⇒ 清单不完整（判据：清单文件数 == 目录文件数）`)
  }
  if (ledger.length !== everyFile.length) {
    problems.push(`UNCLASSIFIED\t清单 ${ledger.length} 个文件 ≠ 目录下 ${everyFile.length} 个 ⇒ 有文件静默消失`)
  }
  for (const s of dangling) {
    problems.push(`GATE-SCRIPT-DANGLING\tpackage.json 的 ${s.name} 指向 ${s.target}，但盘上没有这个文件`
      + ` ⇒ 门脚本挂空，且它**没有**以任何形式出现在本清单里`)
  }
  for (const d of subdirectories) {
    if (d.files > 0) {
      problems.push(`SUB-DIR-CONTENT\t${d.name} 里有 ${d.files} 个文件；`
        + `本机制的清单只覆盖目录顶层 ⇒ 这些文件在覆盖面之外（子目录不许当藏东西的地方）`)
    }
  }

  const coverage: Coverage = {
    filesInDir: everyFile.length,
    ledgerFiles: ledger.length,
    unclassified,
    subdirectories,
    byKind,
    gateScripts,
    dangling,
    problems,
  }

  const without = gates.filter(g => g.driver === null).length
  const routedNoImplementation = aggregator.routedOnly.length
  const auditedIdentityCount = gates.reduce((n, g) => n + g.identities.length, 0)

  return {
    gates,
    drivers,
    unaudited: aggregator.defined,
    routedOnly: aggregator.routedOnly,
    aggregator,
    ledger,
    coverage,
    root: absRoot,
    present,
    fileCount: everyFile.length,
    runnerProblems: verifyRunnerOverrides(absRoot, drivers),
    totals: {
      auditedFiles: gates.length,
      auditedIdentities: auditedIdentityCount,
      withDriver: gates.length - without,
      withoutDriver: without,
      driverFiles: gates.reduce((n, g) => n + (g.driver ? 1 : 0) + g.alternates.length, 0),
      unaudited: aggregator.defined.length,
      routedNoImplementation,
      identities: auditedIdentityCount + aggregator.defined.length + routedNoImplementation,
      identitiesPresentInRepo: auditedIdentityCount + aggregator.defined.length,
      filesInDir: everyFile.length,
      ledgerFiles: ledger.length,
      unclassified: unclassified.length,
      byKind,
      audited: gates.length,
    },
  }
}

const TABLE_HEAD = "门标识          实现                           驱动                           正确命令\n"

function printAudited(gates: GateDriver[]): void {
  process.stdout.write(TABLE_HEAD)
  for (const g of gates) {
    process.stdout.write(
      `${g.id.padEnd(15)} ${g.implementation.padEnd(31)} ${(g.driver ?? "（缺）").padEnd(31)} ${g.command ?? "—— 无驱动，不可单独复跑"}\n`)
  }
}

/** 已审计那一类的**身份**读数（文件数 ≠ 身份数，两个都给）。 */
function printAuditedTotals(d: Discovery): void {
  const notes: string[] = []
  for (const g of d.gates) {
    const file = g.implementation.replace(/^script\/gates\//, "")
    if (g.identities.length > 1) notes.push(`${file} 一举实现 ${g.identities.join("+")}`)
    for (const fn of g.exported) {
      if (identityOf(fn) === null) notes.push(`${file} 导出的 ${fn} 不计入门身份（名字不是 gateG+两位门号）`)
    }
  }
  process.stdout.write(`\n# 已审计：实现【文件】${d.totals.auditedFiles} 个 / 门【身份】${d.totals.auditedIdentities} 个`
    + `（两者不相等的地方：${notes.join("；") || "无"}）；驱动【文件】${d.totals.driverFiles} 个`
    + `（${d.gates.filter(g => g.alternates.length > 0)
      .map(g => `${g.id} 有 ${1 + g.alternates.length} 条`).join("；") || "无同门多驱动"}）。\n`)
  process.stdout.write(`# 已审计的判据一个字没放宽：缺驱动 ${d.totals.withoutDriver} 个`
    + `（非 0 ⇒ exit 2）。\n`)
}

function printUnaudited(unaudited: UnauditedGate[]): void {
  process.stdout.write("\n── 未纳入审计（无独立实现文件 ⇒ 两文件约定不适用）──\n")
  if (unaudited.length === 0) {
    process.stdout.write("（无）\n")
    return
  }
  process.stdout.write("门标识   定义位置                       单跑命令                                  相关文件（非实现，但服务这个门）\n")
  for (const g of unaudited) {
    process.stdout.write(
      `${g.id.padEnd(8)} ${g.definedAt.join(",").padEnd(30)} ${(g.command ?? "—— 无 --gate 路由").padEnd(40)} ${g.relatedFiles.join(" / ") || "——"}\n`)
  }
  process.stdout.write(`未纳入审计 ${unaudited.length} 个。**为什么**：它们没有 script/gates/<id>.ts 可审，`
    + `本机制不要求它们有驱动，也不报它们"通过"；引用它们时不能说"gate:drivers 已覆盖"。\n`)
}

function printRoutedOnly(routedOnly: RoutedOnlyGate[]): void {
  process.stdout.write("\n── 汇总器路由了、但本仓无实现（不许静默不算）──\n")
  if (routedOnly.length === 0) {
    process.stdout.write("（无）\n")
    return
  }
  for (const g of routedOnly) {
    process.stdout.write(`${g.id.padEnd(6)} ${g.routedAt.padEnd(30)} `
      + `${g.blocked ? "BLOCKED" : "有路由"}  ${g.reason ?? "（未抓到 gateBlocked 理由原文）"}\n`)
    process.stdout.write(`${" ".repeat(6)} 单跑命令：—— 本仓没有它的实现，给不出命令（也不许拿别的命令顶替）\n`)
  }
  process.stdout.write(`这一类 ${routedOnly.length} 个：门号在汇总器里有路由，但本仓既没有实现文件、`
    + `也没有内部定义。**它不是"通过"，也不是"未纳入审计"** —— 是"本仓没有这个门"。\n`)
}

function printLedger(d: Discovery, rows: GateFileRow[]): void {
  process.stdout.write("\n── 文件清单：script/gates/ 下每一个文件（含测试与非脚本 —— 一个都不许消失）──\n")
  process.stdout.write("类别           文件                                    服务门               凭什么这么说 / 命令\n")
  for (const r of rows) {
    process.stdout.write(`${r.kind.padEnd(14)} ${r.file.padEnd(39)} ${(r.serves.join(",") || "——").padEnd(20)} ${r.why}\n`)
    if (r.scripts.length > 0) process.stdout.write(`${" ".repeat(14)} ↳ package.json 脚本：${r.scripts.join(" / ")}；命令：${r.command ?? "——"}\n`)
    if (r.kind === "子探针" && r.referencedBy.length > 0) {
      process.stdout.write(`${" ".repeat(14)} ↳ 引号路径引用点（引用≠一定在跑，需人核对那几行）：`
        + `${r.referencedBy.join(" / ")}\n`)
    }
    if (r.importedBy.length > 0) {
      process.stdout.write(`${" ".repeat(14)} ↳ 被 import：${r.importedBy.join(" / ")}\n`)
    }
  }
  process.stdout.write(`清单 ${rows.length} 个文件。\n`)
}

function printCoverage(d: Discovery): void {
  const byKind = GATE_FILE_KINDS
    .filter(k => (d.totals.byKind[k] ?? 0) > 0)
    .map(k => `${k} ${d.totals.byKind[k]!}`).join(" / ")
  process.stdout.write("\n── 覆盖面自校验（判据：输出里的文件数 == 目录下的文件数）──\n")
  process.stdout.write(`# 目录下文件 ${d.coverage.filesInDir} 个 = 清单 ${d.coverage.ledgerFiles} 个`
    + `（未归类 ${d.coverage.unclassified.length} 个）；类计数：${byKind}。\n`)
  if (d.coverage.subdirectories.length > 0) {
    process.stdout.write(`# 目录下子目录 ${d.coverage.subdirectories.length} 个：`
      + d.coverage.subdirectories.map(s => `${s.name}（${s.files} 个文件）`).join(" / ") + "\n")
  }
  process.stdout.write(`# package.json 指向 script/gates/ 的脚本 ${d.coverage.gateScripts.length} 条`
    + `（${d.coverage.gateScripts.map(s => `${s.name}→${s.target}`).join(" / ") || "无"}），挂空 ${d.coverage.dangling.length} 条。\n`)
  process.stdout.write(`# 门身份合计 ${d.totals.identities} 个 = 已审计实现 ${d.totals.auditedIdentities}`
    + `（${d.totals.auditedFiles} 个文件）+ 汇总器内部 ${d.totals.unaudited}`
    + ` + 汇总器路由但本仓无实现 ${d.totals.routedNoImplementation}`
    + `；其中"本仓有实现或定义"的 ${d.totals.identitiesPresentInRepo} 个。\n`)
}

/** 扩展名清单：把"机制到底看了哪些文件"变成可核对的事实，而不是让读者去猜。 */
function extensionNote(d: Discovery): string {
  const actual = Object.entries(d.present)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, n]) => `${ext} ${n}`).join(" / ")
  return `发现根：${d.root}\n扫描扩展名：${CODE_EXTENSIONS.join(" ")}\n`
    + `script/gates/ 实际存在：${actual} → 文件 ${d.fileCount} 个\n`
}

function main(): number {
  const argv = process.argv.slice(2)
  const json = argv.includes("--json")
  const jsonAll = argv.includes("--json-all")
  const only = argv.includes("--gate") ? argv[argv.indexOf("--gate") + 1] : undefined
  const rootArg = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : undefined
  if (rootArg !== undefined && !existsSync(rootArg)) {
    process.stdout.write(`GATE-IDENTITY\t--root 指向的目录不存在：${rootArg}\n`)
    return 2
  }

  const d = discover(rootArg ?? DEFAULT_ROOT)
  const needle = only?.toUpperCase()
  const shown = only ? d.gates.filter(g => g.id.toLowerCase() === only.toLowerCase()) : d.gates
  const unauditedShown = needle ? d.unaudited.filter(g => g.id === needle) : d.unaudited
  const routedShown = needle ? d.routedOnly.filter(g => g.id === needle) : d.routedOnly
  // 单个门查询也要能看见"服务这个门但不是实现"的文件（`g03-clock.ts` 这类）。
  const ledgerShown = needle
    ? d.ledger.filter(r => r.serves.includes(needle)
      || r.file.replace(/^script\/gates\//, "").toLowerCase().startsWith(only!.toLowerCase()))
    : d.ledger

  if (only && shown.length === 0 && unauditedShown.length === 0
    && routedShown.length === 0 && ledgerShown.length === 0) {
    process.stdout.write(`GATE-IDENTITY\t未找到门「${only}」：script/gates/ 下没有导出 gate* 的实现，`
      + `汇总器内部也没有该门的定义，文件清单里也没有服务它的文件\n`)
    return 2
  }

  // 机器可读：`--json` 只给**已审计**那一类，形状是 release-gate 的 `parseGateDrivers()` 认的自足数组。
  if (json || jsonAll) {
    if (jsonAll) {
      process.stdout.write(JSON.stringify({
        root: d.root,
        scannedExtensions: [...CODE_EXTENSIONS],
        present: d.present,
        fileCount: d.fileCount,
        audited: shown,
        unaudited: unauditedShown,
        routedOnly: routedShown,
        aggregator: d.aggregator,
        ledger: ledgerShown,
        coverage: d.coverage,
        runnerProblems: d.runnerProblems,
        totals: d.totals,
      }, null, 2) + "\n")
    } else {
      process.stdout.write(JSON.stringify(shown, null, 2) + "\n")
      // ⚠️ 以下写 stderr 的行**不含方括号** —— 见文件头对 `parseGateDrivers()` 的说明。
      process.stderr.write(`# 本表只含"已审计"那一类：实现文件 ${d.totals.auditedFiles} 个`
        + `（门身份 ${d.totals.auditedIdentities} 个；缺驱动 ${d.totals.withoutDriver} 个）；`
        + `另有未纳入审计 ${d.totals.unaudited} 个、汇总器路由但本仓无实现 ${d.totals.routedNoImplementation} 个，`
        + `门身份合计 ${d.totals.identities} 个；目录下文件 ${d.totals.filesInDir} 个 = 清单 ${d.totals.ledgerFiles} 个`
        + `（未归类 ${d.totals.unclassified} 个）—— 完整面见 --json-all\n`)
    }
  } else {
    process.stdout.write(extensionNote(d))
    if (shown.length > 0) printAudited(shown)
    for (const g of shown) {
      for (const alt of g.alternates) {
        process.stdout.write(`DUP-DRIVER\t${g.id}  同门还有 ${alt}（未被选为推荐命令；推荐 ${g.driver}）\n`)
      }
      if (g.runner === "node") {
        process.stdout.write(`RUNNER\t${g.id}  该驱动**必须在 node 下跑**（bun 下模块图崩），故命令用 node：${g.command}\n`)
      }
    }
    printAuditedTotals(d)
    if (!only || unauditedShown.length > 0) printUnaudited(unauditedShown)
    else printUnaudited([])
    if (!only || routedShown.length > 0) printRoutedOnly(routedShown)
    else printRoutedOnly([])
    printLedger(d, ledgerShown)
    printCoverage(d)
  }

  const machine = json || jsonAll
  /**
   * 诊断面：表格模式走 stdout（给人看）；`--json*` 模式 stdout 是**机器契约**
   * （见文件头：`parseGateDrivers()` 会 `indexOf("[")`…`lastIndexOf("]")` 再 parse），
   * 所以诊断改走 stderr，且措辞里**不许出现方括号**。
   */
  const diag = (s: string): void => { void (machine ? process.stderr : process.stdout).write(s) }

  const missing = shown.filter(g => g.driver === null)
  /**
   * 两条来源的"机制在说假话"通道，**各自带自己的 TAG**：
   *   · `RUNNER-STALE`  —— 例外表与现实不符（登记理由已过期）；
   *   · `UNCLASSIFIED` / `GATE-SCRIPT-DANGLING` / `SUB-DIR-CONTENT` / `GATES-DIR-MISSING`
   *                      —— 覆盖面问题（`coverage.problems` 的字符串自带 TAG 与制表符）。
   */
  const problems: { tag: string; text: string }[] = [
    ...d.runnerProblems.map(p => ({ tag: "RUNNER-STALE", text: p })),
    ...d.coverage.problems.map(p => {
      const cut = p.indexOf("\t")
      return cut < 0 ? { tag: "COVERAGE", text: p } : { tag: p.slice(0, cut), text: p.slice(cut + 1) }
    }),
  ]
  let code = 0
  if (missing.length > 0) {
    if (!machine) process.stdout.write("\n")
    for (const g of missing) {
      diag(`NO-DRIVER\t${g.implementation} 导出 ${g.exported.join("/")} 但没有驱动；`
        + `直接运行它只会退出 0，不代表门通过\n`)
    }
    diag(`缺驱动 ${missing.length} 个：这些门只能经 script/refactor-verify.ts 跑到，` +
      `想单独复跑的人会拿到空转的 exit 0。\n`)
    code = 2
  }
  if (problems.length > 0) {
    if (!machine) process.stdout.write("\n")
    for (const p of problems) diag(`${p.tag}\t${p.text}\n`)
    diag(`覆盖面/例外表的问题 ${problems.length} 条：清单不完整或例外已过期 —— `
      + `**看不见的对象必须先被看见**，修好之前别信这张表。\n`)
    code = 2
  }
  if (machine && code === 0) {
    process.stderr.write(`# 覆盖面自校验通过：目录下文件 ${d.totals.filesInDir} 个 = 清单 ${d.totals.ledgerFiles} 个，`
      + `未归类 0 个，挂空门脚本 0 条\n`)
  }

  if (!machine && code === 0) {
    process.stdout.write(`\n# 已审计 ${d.totals.auditedFiles} 个实现（script/gates/ 收全扩展名后），全部有驱动；`
      + `未纳入审计 ${d.totals.unaudited} 个（无独立实现文件，见上）；`
      + `目录下 ${d.totals.filesInDir} 个文件一个没丢（清单 ${d.totals.ledgerFiles} 个）。\n`)
    process.stdout.write(`# 门身份合计 ${d.totals.identities} 个 = 已审计实现身份 ${d.totals.auditedIdentities}`
      + ` + 汇总器内部 ${d.totals.unaudited} + 汇总器路由但本仓无实现 ${d.totals.routedNoImplementation}。`
      + `可直接运行的门请用上表「正确命令」列，不要直接跑实现文件。\n`)
  }
  return code
}

if (import.meta.main) process.exit(main())
