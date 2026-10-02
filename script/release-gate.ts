#!/usr/bin/env bun
/**
 * P9 · release gate（2026-09-26）—— 一条命令回答「四天后发出去的是**绿的**还是**对的**」。
 *
 * ## 为什么需要它（本仓四次"绿 ≠ 对"的实证）
 *
 * 1. **空转模块的 exit 0**：`script/gates/g17.ts` 是纯导出模块，直接跑什么都不做却退出 0；
 *    Lead 把它当成"G17 门通过"并在两轮回执里引用过。真驱动当时是 exit=1。**空转的 0 与通过的 0
 *    在退出码上无法区分** —— 所以本 gate 的每条判据都必须给出**自己的数字**，没有数字 = `UNPROVEN`。
 * 2. **哑探针报绿**：g17 的 `legacy.opencode-*` 探针模式含 `(?:…)`，POSIX ERE 编译失败 ⇒ 恒定 0 命中 ⇒
 *    判据 PASS。所以本 gate **把"0"与"没量到"分开**：解析不出读数一律 `UNPROVEN`，不是 PASS。
 * 3. **单帧夹具 vs 多帧现实**（W9）：夹具与真实数据形状不同 ⇒ 106 份会话标题全 0，而测试一直绿。
 *    所以本 gate 登记每条用例**量的是什么**（`purpose`），并对**断言站点数**与**通过数**各设冻结下限：
 *    只留一个空壳 describe 的文件既过不了 `minSites`，也过不了 `minPass`。
 * 4. **18 行矩阵全非隔离**（W2）：修复只在隔离下生效 ⇒ 结构上证明不了。所以本 gate 只接受**在磁盘上、
 *    在清单里、真跑起来有读数**的用例；"not-run ≠ pass"落成三条判据（preflight / caseset-coverage /
 *    case-integrity）。
 *
 * ## 判据与各自的独有数字
 *
 * | 判据 | 量的是什么 | 读数（独有数字） |
 * | --- | --- | --- |
 * | `preflight` | 四类配置问题 | include / exclude / missing / unclassified / config / runnerMismatch |
 * | `gate-drivers` | 每个门实现有没有驱动 | implementations / withDriver / withoutDriver |
 * | `offline-ci` | **同一次运行里**真跑 `script/test-ci.ts` 完整默认集的逐文件报告是否可信、纳入集是否全跑成功 | include / ran / passed / failed / missing / excluded / validationProblems / exit |
 * | `tsc-product` | 产品编译闭包 | errors / files |
 * | `tsc-gates` | 门编译闭包 | errors / files |
 * | `regression.<主题>` ×6 | 本轮回归用例（静默降级/跨会话误写/撤销边界/预检假警报/取件五要素/其它） | cases=绿/总、pass=Σ/Σ下限、assert=Σ/Σ下限 |
 * | `claim-consistency` | 回执自己声明的读数是否仍成立（终态语义 vs 声明） | claims / ok / shortfall |
 * | `caseset-coverage` | 由工作树 + 本轮回执反查出的用例是否都被接进门 | derived / declared / drift / unregistered / staleCitation |
 * | `manifest-gate-gap` | **清单 `include` 里有多少条用例发布门不跑**（不许悄悄长） | includeTestLike / gateRuns / waived / notRun / frozen / frozenGone / delta / digest |
 * | `case-integrity` | 每条用例：在盘上 / runner 与清单一致 / 断言站点不低于下限 | cases / exists / runnerOk / sitesOk |
 * | `floor-drift` | **冻结下限有没有漂**：`minPass` 低于实测 ⇒ 删掉 N 条仍然绿 | checked / drift / assertGapReported / sitesGapReported |
 * | `skip-accounting` | skip 永不算通过 | skips / waived / unwaived |
 * | `gate-selfcheck` | 本 gate 自己：有没有"没数字的通过"、有没有"跑了但没读数"的用例 | criteria / numbered / cases / readings / noReading |
 *
 * ## 三值裁决（不把"没量到"混进绿） * - `GREEN`    每条判据都有读数且达标 ⇒ exit 0
 * - `RED`      有判据实测不达标 ⇒ exit 1（点名到用例/文件）
 * - `UNPROVEN` 没有 RED，但有判据**产不出读数**（工具缺失、输出解析不了、超时）⇒ exit 2
 * - `PARTIAL`  只跑了子集（`--only`）⇒ exit 3（**永不为 0**：子集不许冒充发布通过）
 *
 * 三种非绿都拦住发布；`UNPROVEN` 与 `RED` 分开，是为了让读的人知道该去补环境还是去改代码。
 *
 * ## 退出码表（完整，**这张表只有这里一份**）
 *
 * | 码 | 名字 | 含义 | 谁产生 |
 * | --- | --- | --- | --- |
 * | `0` | `GREEN` | 每条判据都有读数且达标 | `main()` 的裁决 |
 * | `1` | `RED` | 有判据实测不达标 | `main()` 的裁决 |
 * | `2` | `UNPROVEN` | 无红，但有判据产不出读数 | `main()` 的裁决 |
 * | `3` | `PARTIAL` | 只跑了子集（`--only`） | `main()` 的裁决 |
 * | `4` | 参数守卫 | `--cases` 没带 `--selftest` / `--selftest` 没带 `--expect` / `--expect` 没带 `--selftest` | `main()` 的参数守卫 |
 * | `5` | `EPIPE` | **stdout 的读端提前走了，判据没送达** | 输出层（`writeTo` 捕获 / 收尾探针） |
 * | `6` | `SELFTEST` | **`--selftest --cases` 夹具模式的自检通过**（跑的不是发布用例表） | `main()` 的自检分支 |
 *
 * `5` 与 `0/1/2/3` **可区分**：它不是绿、**也不是红** —— 它说的是"这次读数没人收到"。
 * 详见文末「EPIPE = 独立退出码 5」（GATE-EPIPE-EXIT-CODE 单）。
 * `6` **只在夹具模式出现**（`--selftest --cases`），见下节；**发布裁决永远只用 `0/1/2/3`**。
 *
 * ## `--selftest` 不许成为"退 0 的口"（GATE-SELFTEST-EXIT-DOOR 单）
 *
 * 改前实测（门 sha256 `7fe6b2e94643`，2026-09-27 00:2x）：
 *
 * ```
 * $ bun script/release-gate.ts --selftest --cases <fixture> --expect green   # 只有 5 条判据
 *   ⇒ exit 0（preflight / gate-drivers / tsc×2 / caseset-coverage **一条都没跑**）
 * $ bun script/release-gate.ts --selftest --expect red                       # 树实测 RED
 *   ⇒ exit 0（gate-selfcheck checked=9 total=10 —— 10 条判据，不是 17）
 * ```
 *
 * 两条口子：**（甲）** 自检模式**跳过五条结构性判据**（守卫只加在 `--cases` 上）；
 * **（乙）** 退出码**由调用方 `--expect` 决定**（`ok = expect!==undefined && verdict===expect`）。
 * 后果：CI 里误留一个 `--selftest` 就能拿到 `exit 0` 的"绿"，而输出里没有任何字段能被机器判成
 * "这不是发布裁决"（`COMMIT-OK` 不打印，但退出码是 0）。**这正是本门开头第 1 条要防的形状。**
 *
 * 现在两条都堵死：
 *
 * | 模式 | 跑什么 | 退出码 |
 * | --- | --- | --- |
 * | 发布（无 `--selftest`） | 全部判据 | `EXIT_OF[verdict]`（`0/1/2/3`） |
 * | `--selftest`（**无** `--cases`）= `full` | **与发布完全相同的判据集合**（含五条结构性判据） | 期望不符 ⇒ `1`；否则 = **实测裁决**（**只有全绿才是 0**） |
 * | `--selftest --cases` = `fixture` | 夹具用例 + 对夹具可求值的判据（结构性判据对夹具无意义，如实不跑） | 期望不符 ⇒ `1`；相符 ⇒ **`6`（永不为 0）** |
 *
 * 四条不变式（本单的验收判据）：
 * 1. **`--selftest` 与 `--expect` 必须成对**（缺一 ⇒ 参数守卫 `4`）：退出码不再"由调用方指定"，
 *    `--expect` 只回答"自检是否通过"，**退几由实测裁决决定**。
 * 2. **夹具模式（`--cases`）永远不给 0** ⇒ 任何"自检绿灯"都不可能被当成发布通过。
 * 3. **`full` 模式给 0 的前提是发布判据集合全绿** ⇒ `exit 0` 一定意味着五条结构性判据**真跑了**。
 * 4. `--only`（子集）在**两种模式里**都判 `PARTIAL`（子集永不为绿），不再被 `--selftest` 豁免。
 *
 * ## 用法
 *
 *   bun run release-gate                           # 一条命令，全量（package.json 里已登记同名脚本）
 *   bun run release-gate --json out.json           # 另存机器可读报告
 *   bun run release-gate --only tsc                # 只跑命中的判据（判定 PARTIAL / exit 3，永不为 0）
 *   bun run release-gate --selftest --cases f.json --expect red   # 负对照自检（夹具模式 ⇒ exit 6 = 自检通过）
 *   bun run release-gate --selftest --expect green                # 断言"真发布门是绿的"（跑全量判据）
 *
 * ## 读数自带的身份（PROVENANCE）—— "是门变了还是树变了"必须第一眼看得出来
 *
 * 每张读数都自带**门自己**与**被量对象**的身份：
 *
 * | 字段 | 是什么 | 它变了说明 |
 * | --- | --- | --- |
 * | `gate=` | **执行中那份门源文件**的 sha256（前 12 位） | 门文件在两次运行之间被改过（读数不再可比） |
 * | `gateFile=` | 那份文件的路径（相对 `--root`） | 跑的不是 `<root>/script/release-gate.ts`（例如冻结副本 + `--root`） |
 * | `HEAD=` | 工作树 HEAD（前 12 位） | 树换了提交 |
 * | `dirty=` | `git status --porcelain` 的条目数 | 改动条数变了 |
 * | `worktree=` | **同一份 porcelain 文本**的 sha256（前 12 位） | 改动**集合本身**变了（条数相同也看得出来） |
 * | `mode=`（`GATE-MODE` 行） | 这次跑的是哪一档：`release` / `selftest-full` / `selftest-fixture` | 读数的**用途**变了（自检不许被当成发布裁决） |
 * | `negctl=`（`GATE-MODE` 行） | **负对照哨兵**：`none` = 交付态；别的值 ⇒ 这份读数出自一个**故意改坏**的门 | 见「负对照改在副本上做」 |
 *
 * 为什么需要（`bugfixHistory/GATE-NONDETERMINISM-20260926.md` §7.R3）：`cases=58→62` 那次"同一棵树
 * 两次两样"的**唯一**解释是门文件在两次运行之间被改了，而当时的读数里没有任何字段记住门的版本 ——
 * 只能靠 mtime 与别人落在盘上的读数倒推，`cases` 那个"硬线索"也就成了孤证。
 * 现在门自带版本：`gate=` 不同 ⇒ 门变了；`gate=` 相同而 `HEAD`/`dirty`/`worktree` 不同 ⇒ 树变了。
 *
 * ## 负对照改在副本上做（`docs/VERIFICATION_MECHANISMS.md` 机制 12）
 *
 * 验收队实测：2026-09-27 00:30–00:52 的 22 分钟里，**这份共享文件被改了 9 个版本**，其中至少三个是
 * **故意把修复关掉**的负对照态（判定式被恒假条件短路 / 一行 `criteria.push` 被注释掉）⇒ 那一窗口里跑门的
 * 人拿到的是**假读数**，而当时的 `PROVENANCE` 里**没有任何字段**能提示"这是负对照态"
 * （`gate=` 只说"门变了"，不说"门变坏了"）。所以：
 *
 * - **首选**：`cp` 一份门到副本目录，让**副本**用 `--root <真仓>` 跑（`gateFile=` 会写明是副本）；
 * - **就地改（不推荐）**：必须设 `NEGATIVE_CONTROL` 哨兵 —— `GATE-MODE` 行会印 `negctl=`，
 *   收尾区再印一次 `NEGATIVE-CONTROL`；**交付态必须是 `null`**（门自测有静态不变式拦）。
 *
 * **这几个字段只报告、不参与任何判据**（读不到就写 `unknown` / `-1`，不把门判红）：
 * 身份不是读数，判据的语义与门槛一个字没动。`gate=` 与 `worktree=` 取**单次快照**：
 * HEAD、porcelain、门源文件各读一次，读数只对它运行时那一刻负责。
 *
 * ## 有意不做（边界，别当成"已覆盖"）
 *
 * - **不跑** `bun run test:ci`（Lead 的集成门，慢且不是本单判据）；本 gate 自己起 66 个用例进程（每条一个进程、独立退出码）。
 * - **不跑** `refactor-verify.ts` / `run-g17.ts` / G13/G15 等门（那是另一条入口：`bun run script/gates/run-g17.ts`
 *   本轮实测 **22/24，exit=1**，2 条为 `project_typecheck` 与 `delivery_archive_matches_head`）。
 *   本 gate 与它是**互补**的，不互相替代：那边量门自身的判据，这边量本轮回归用例与配置面。
 * - **不判真机**：不启 Host、不起 GUI、不联网、不下载权重、不碰 Blender/Unity/Isaac 真机。
 * - **不改任何被测文件**：本文件只读代码与清单、只起子进程。
 * - `minPass` / `minAssert` / `minSites` 是**冻结下限**：下调等于缩减覆盖，必须是一次被 review 的改动。
 *   `minPass` 有**两条**判据守着（`floor-drift`）：`minPass < 实测通过数` ⇒ 红（只写一个下限数字而没人比，
 *   等于"删掉 N 条用例仍然绿"）；**实测 < `FLOOR_BASELINE_FROZEN`** ⇒ 红（"先删用例、再把下限调到新实测"
 *   这条路以前是通的 —— 验收队实测 `minPass=15 / 实测=15 ⇒ GREEN`，现在被冻结基线堵死）。
 *   `minSites` / `minAssert` 只保留下界检查，见该判据的注释。
 * - **门绿 ≠ CI 绿**（`docs/VERIFICATION_MECHANISMS.md` 机制 13）：清单 `include` 里有相当一批 test-like
 *   用例**发布门根本不跑**，这个数**每条读数都印**（判据行 `manifest-gate-gap` 的 `notRun=`，收尾区
 *   `CI-GAP` 行再印一次）。**具体条数不要手抄在这里**（抄一次就漂一次 —— 验收报告 §4-X3 抓到的
 *   `113 / 121 / 123` 三个数并存就是这么来的）：以 `MANIFEST_GAP_FROZEN` 为**唯一**权威源，
 *   现算值以每次读数的 `--json` 报告 `manifestGap.notRun` 为准。
 *   这不是"已覆盖"，是**登记在明面上的缺口**：新增的没进门用例判红，见该判据的注释。**别为了让这条变绿去调冻结值**
 *   —— 那正是"承认现状"的动作，必须是一次被 review 的改动（判据点名行里会直接印出现算的 `{ count, digest }`）。
 * - **用例集合的派生只有两个来源**：工作树（`git status`）+ 本轮回执（`bugfixHistory/*-<ROUND>.md`）。
 *   ⇒ 一个"本轮新增、已提交、且任何回执都没提到"的测试文件**派生不出来**。这是已知残余洞口；
 *   缓解靠纪律（每个工作面必须在回执里单列新增/改名测试文件）+ `preflight` 的 fail-closed 登记面。
 *   试过用 `git log --diff-filter=A --since=<轮次开始>` 补第三个来源，实测一次目录级重排提交就吐 236 个
 *   文件（几乎全树），噪声压过信号，因此**有意不做**，改为在回执里如实登记。
 * - 候选集若派生出来但**有意不接进门**，必须写进 `COVERAGE_WAIVERS` 并给出理由（空理由判红）：
 *   这是"不许静默漏掉回归用例"的唯一出口。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
/** 执行中的这份门源文件。**不是** `<root>/script/release-gate.ts`：`--root` 可以指向别处（冻结副本），
 *  那时两者不同 —— `gateFile=` 会把这个差别写在明面上。 */
const GATE_SOURCE = fileURLToPath(import.meta.url)
/**
 * **负对照哨兵**（GATE-FINALIZATION 单 2026-09-27）：交付态必须是 `null`。
 *
 * ## 它为什么存在
 *
 * 2026-09-27 00:30–00:52 的验收窗口里，**这份共享文件被改了 9 个版本**，其中至少三个是
 * **故意把修复关掉**的负对照态（验收队抓到的原文：④ 的判定式被一个恒假条件短路
 * `if (false […] && r.counts.pass > s.minPass)`，③ 的 `criteria.push(evalManifestGap(…))` 整行被注释掉）。
 * 验收队在其中一版（`gate=02f2756169e6`，
 * 00:37:14）实测到 ① 仍然漏（`--selftest` full 只跑 11 条判据）。⇒ 那一窗口里任何人跑门，
 * 拿到的都是**假读数**，而 `PROVENANCE` 里**没有任何字段**提示"这是负对照态"：
 * `gate=` 只说"门变了"，**不说"门变坏了"**。
 *
 * ## 规矩（`docs/VERIFICATION_MECHANISMS.md` 机制 12）
 *
 * 1. **负对照改在副本上做**（首选）：`cp` 一份门到仓外目录，让**副本**用 `--root <真仓>` 跑 ——
 *    读数里的 `gateFile=` 会直接写明跑的不是 `<root>/script/release-gate.ts`。
 *    `script/release-gate.test.ts` 的 PROVENANCE 负对照早就是这么跑的，照做即可，不需要新工具。
 * 2. **就地改（不推荐）必须挂哨兵**：把它设成一句话（如 `'④-baseline-off'`）⇒ `PROVENANCE` 印
 *    `negctl=…`、收尾多一行 `NEGATIVE-CONTROL`、`--json` 的 `provenance.negativeControl` 也带上。
 * 3. **交付前必须还原成 `null`**：`script/release-gate.test.ts` 有一条静态不变式拦"哨兵忘了撤"。
 *
 * 取任何读数前**先读三件套**：`gate=` / `gateFile=` / `negctl=`。
 */
export const NEGATIVE_CONTROL: string | null = null
/** 本轮的日期标记：从工作树 + 这一天的回执反查用例集合。换轮次时改这里。 */
const ROUND = '20260926'
const ROUND_LABEL = '2026-09-26'

// ─────────────────────────────────────────────────────────────────────────────
// 输出层：判据必须**送达到读的人**，送不到就不许报成任何一档裁决
// ─────────────────────────────────────────────────────────────────────────────

/** 完整退出码表见文件头「退出码表」。`EPIPE_EXIT` = 输出被截断、判据未送达（**不是 RED**）。 */
export const GREEN_EXIT = 0
export const RED_EXIT = 1
export const UNPROVEN_EXIT = 2
export const PARTIAL_EXIT = 3
export const ARGS_EXIT = 4
export const EPIPE_EXIT = 5
/**
 * `--selftest --cases`（夹具模式）的**唯一成功码**。见文件头「`--selftest` 不许成为"退 0 的口"」。
 *
 * 为什么不用 `0`：夹具模式跑的不是发布用例表（且五条结构性判据对夹具无意义，如实不跑），
 * 所以它的"自检通过"**不能**与"发布裁决是绿的"共用同一个退出码 —— 那正是改前那条口子
 * （CI 里误留一个 `--selftest` 就能拿到 `exit 0`，而输出里没有任何字段能被机器判成"这不是发布裁决"）。
 */
export const SELFTEST_EXIT = 6

/**
 * stdout 的读端提前走了（`bun run release-gate | head -1`、`grep -q`、CI 的早退消费者）。
 *
 * 为什么**必须**与 `RED=1` / `GREEN=0` 都区分开（Lead 裁定，2026-09-26）：EPIPE 意味着**消费者走了、
 * 判据没送达** —— 那不是"绿"，也不是"红"，是"**没人听**"。退成 0 就是本仓反复抓的那个形状
 * 「一个说谎的成功信号」；退成 1 又会被 CI 里的 `release-gate | grep -q`、`| head` 误读成"门红了"。
 * 所以给它自己的码，并在 stderr 说明白。
 */
let stdoutPipeClosed = false

/** 降级面：`writeSync` 在这个 fd 上不可用（如 Windows 控制台句柄）⇒ 退回 `process.stdout.write`。 */
let stdoutSyncBroken = false

function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && code.length > 0) return code
  const msg = (e as Error | null)?.message
  return typeof msg === 'string' ? msg : 'unknown'
}

/**
 * 输出被截断时**唯一**的一段说明。写到 stderr（stdout 正是断的那一根）。
 * 措辞是"这不是 RED"的明文版：读的人扫一眼 stderr 就能分清"门红了"与"没人听"。
 * 导出是给测试用的：负对照要能逐字断言"送出去的是哪句话"，而不是断言一个自己拼的近似串。
 */
export const EPIPE_NOTICE =
  'release-gate：EPIPE —— stdout 的读端提前关闭，本次输出被截断、**判据未送达**。\n' +
  `（退出码 ${EPIPE_EXIT} = 判据没送到消费者手上，**这不是 RED**：没有判据被判为不达标。\n` +
  ' 要拿完整读数：把输出落到文件、或让消费者读满（如 `| cat`、`| grep` 全量、`> out.txt`）；\n' +
  ' 只取前几行（`| head -1`）时本码是**预期的**，不要当成发布门变红。）\n'

/**
 * 记录"stdout 读端已走"并尽力把说明送到 stderr。**恰好一次**（后面的写都直接跳过）。
 * stderr 自己也可能断（`2>&1 | head -1`）：那时连这行也送不到，但退出码仍然是 5 —— 不静默。
 */
function noteStdoutPipeClosed(): void {
  if (stdoutPipeClosed) return
  stdoutPipeClosed = true
  try {
    process.stderr.write(EPIPE_NOTICE)
  } catch {
    /* stderr 也断了：说明送不出去，但退出码照旧 —— 不许吞成一个 0 */
  }
}

/** 本进程是否已判定"输出被截断、判据未送达"。 */
export function outputTruncated(): boolean {
  return stdoutPipeClosed
}

/**
 * 门的**唯一**输出口（`process.exit(0)` 之类的硬切曾把尾部静默丢掉，见文末 GATE-EXIT-FLUSH）。
 *
 * 为什么是 `node:fs` 的 `writeSync` 而不是 `process.stdout.write`：本单实测（bun 1.3.13）——
 * 流式写**根本量不到**这条断管：写 30 万行到 `| head -1`，`'error'` 事件 0 次、`write('')` 收尾探针
 * 不抛、`exitCode` 仍是 0 ⇒ 它会把 EPIPE 吞成一个**说谎的成功信号**（本单第一版就这么写的，负对照抓出来了）。
 * `writeSync` 是**同步系统调用**：读端一走，下一次写**立刻**抛 `EPIPE`（实测 `| head -1` 在第 67 行左右抛、
 * 300 次 300 抛；同一路径经 `| cat >/dev/null` 读满 300 次 0 抛）—— 于是截断变成一个**可捕获、可赋码**的事实。
 * 另一个好处：写不再滞留在流的缓冲区里，"门打算说什么"与"消费者收到什么"由 `writeSync` 的返回对齐。
 *
 * 非 EPIPE 的错（EBADF 等）**不吞**：抛出去，照旧是该崩就崩。
 */
export function writeTo(fd: 1 | 2, s: string): void {
  if (s.length === 0) return
  if (fd === 1) {
    if (stdoutPipeClosed) return
    if (!stdoutSyncBroken) {
      try {
        writeSync(1, s)
        return
      } catch (e) {
        const code = errnoOf(e)
        if (code === 'EPIPE') {
          noteStdoutPipeClosed()
          return
        }
        // Windows 控制台句柄这类"同步写不可用"的场合：退回流式写（那里本来也不会给 EPIPE）。
        // 其余错误照旧抛出。
        if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EBADF') stdoutSyncBroken = true
        else throw e
      }
    }
    process.stdout.write(s)
    return
  }
  try {
    writeSync(2, s)
  } catch {
    /* stderr 送不出去不是判据问题（stdout 那条路另有 EPIPE_EXIT 兜底），静默 */
  }
}

/**
 * 收尾探针：读完最后一截之后再问一次"读端还在不在"。
 *
 * 为什么需要：`writeSync` 只在**真写**的时候抛。上一写刚好把读端喂饱、消费者此时才走，
 * 那么"判据未送达"就差一次系统调用才看得出来。零字节写是**同步的 no-op**（不产出任何字节、
 * 不改变输出），却是当下就能问的那一次系统调用。实测：EPIPE 后零字节写照样抛；
 * 读满（`| cat`、`| wc -l`）时不抛 ⇒ 正常情况退出码语义一个字不改。
 */
export function flushCheck(): void {
  if (stdoutPipeClosed) return
  try {
    writeSync(1, '')
  } catch (e) {
    if (errnoOf(e) === 'EPIPE') noteStdoutPipeClosed()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例表（66 条：本轮回执引用过 + 工作树新增，并在磁盘上、离线可跑的全部）
// ─────────────────────────────────────────────────────────────────────────────

export type Theme =
  | 'silent-degradation'
  | 'cross-session-write'
  | 'undo-boundary'
  | 'preflight-false-alarm'
  | 'fetch-five-elements'
  | 'other-round'

export const THEMES: readonly Theme[] = [
  'silent-degradation',
  'cross-session-write',
  'undo-boundary',
  'preflight-false-alarm',
  'fetch-five-elements',
  'other-round',
]

export const THEME_TITLES: Record<Theme, string> = {
  'silent-degradation': '静默降级',
  'cross-session-write': '跨会话误写',
  'undo-boundary': '撤销边界',
  'preflight-false-alarm': '预检假警报',
  'fetch-five-elements': '取件五要素',
  'other-round': '本轮其它登记项',
}

export interface CaseSpec {
  id: string
  path: string
  theme: Theme
  /** 清单声明的 runner：`bun:test` 用 `bun test <file>`；`plain` 用 `bun <file>`。
   *  **写错执行器 = 空转 exit 0**（本单实测过：把 plain 脚本当 `bun test` 跑得到 0 读数 0 退出码）。 */
  runner: 'bun:test' | 'node:test' | 'plain' | 'python'
  /** 该用例在 CI 清单里的处置：run=CI 会跑 / not-run=CI 有意不跑（本 gate 仍直接跑）/ unregistered=清单里没有 */
  ci: 'run' | 'not-run' | 'unregistered'
  /** 这条用例**量的是什么**（不是"跑了什么"） */
  purpose: string
  minPass: number
  minAssert: number
  minSites: number
  /** 回执自己声明的通过数；实测 < 声明 ⇒ claim-consistency 点名 */
  claimPass?: number
  waiveSkip?: number
  waiveSkipReason?: string
  /** 本轮回执引用该用例的次数（派生用，0 = 只有工作树状态能派生出来） */
  citedBy: number
}

// 由 2026-09-26 实测生成（bun 1.3.13 / 工作树 HEAD b1b6427）。
// minPass = 实测通过用例数（冻结下限）；minAssert = 实测断言读数（expect() 调用数；plain 脚本用自报用例数）。
export const CASES: readonly CaseSpec[] = [
  { id: 'app-side-panel-boundary', path: 'packages/lyapunov-shell/test/app-side.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '应用层侧面板按工作台边界定位，保留工具轨并处理窄面与出界；仅本地几何，真实 GUI 另验', minPass: 4, minAssert: 21, minSites: 13, citedBy: 0 },
  { id: 'linux-user-installer', path: 'distribution/linux/install.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '用户安装入口的校验、续传、失败保留 current、导入隔离与 Conda 不支持前缀的下载前拒绝；临时路径/loopback/替身载荷，真实 SDK 与物理另验', minPass: 12, minAssert: 63, minSites: 57, citedBy: 0 },
  { id: 'manual-control-gesture', path: 'packages/lyapunov-shell/test/manual-events.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A08 F5真实Commands逐事件保留、gesture节点稳定/跨scope/Stop/真实false、完整目标限位与隐私', minPass: 8, minAssert: 121, minSites: 97, citedBy: 0 },
  { id: 'manual-control-pointer', path: 'packages/lyapunov-shell/test/manual-gesture.dom.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A08 F5现有jsdom合成DOM的真实React pointer/final/settle/scope行为，无桌面/GPU', minPass: 1, minAssert: 26, minSites: 26, citedBy: 0 },
  // A06 2026-10-01：八条按 a4a51eb 候选逐文件实跑冻结；只有上调，无删除/下调。
  { id: 'legacy-resource-source', path: 'packages/scene-kit/test/legacy-resource-source.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 4, minAssert: 19, minSites: 18, citedBy: 0 },
  { id: 'domain-instance-projection', path: 'packages/lyapunov-shell/test/domain-instance-projection.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 5, minAssert: 86, minSites: 51, citedBy: 0 },
  { id: 'scene-world-lifecycle', path: 'packages/lyapunov-shell/test/scene-world-lifecycle.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 23, minAssert: 29, minSites: 29, citedBy: 0 },
  { id: 'scene-ptc-input', path: 'packages/scene-kit/test/scene-ptc-input.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 1, minAssert: 8, minSites: 6, citedBy: 0 },
  { id: 'peiri-search-client', path: 'packages/lyapunov-api-client/test/search-client.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 10, minAssert: 93, minSites: 43, citedBy: 0 },
  { id: 'brand-welcome', path: 'packages/lyapunov-shell/test/brand-welcome.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 3, minAssert: 27, minSites: 23, citedBy: 0 },
  { id: 'flight-controller', path: 'packages/robot-workflows/test/flight-controller.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 4, minAssert: 18, minSites: 18, citedBy: 0 },
  { id: 'physics-binding', path: 'packages/scene-kit/test/physics-binding.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run', purpose: 'A06已登记定向回归；实际GUI/SDK单独签收', minPass: 8, minAssert: 68, minSites: 22, citedBy: 0 },
  { id: 'geometry-source-contract', path: 'packages/scene-kit/test/geometry-source-contract.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'OBJ/FBX分类与登记转换同源、真实MTL原名和缺件拒绝、MAX明确转换要求；真实Blender/材质渲染另验', minPass: 3, minAssert: 13, minSites: 10, citedBy: 0 },
  { id: 'physics-state', path: 'packages/scene-kit/test/physics-state.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '同实例物理owner、固定/动态质量与开关、真实Scene CAS/历史保存重开和不同几何替换；原生worker另验', minPass: 5, minAssert: 27, minSites: 27, citedBy: 0 },
  { id: 'physics-controls', path: 'packages/lyapunov-shell/test/physics-controls.test.tsx', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '物理控件同帧/版本读回、机器人只读、质量不猜、绑定用途与单CAS同步/取消；真实GUI另验', minPass: 17, minAssert: 83, minSites: 80, citedBy: 0 },
  { id: 'environment-routing-selection', path: 'packages/lyapunov-shell/test/environment-routing-selection.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '当前选择与口语建造/修改、显式Blender/Peiri与组合路线、停止/只方案/导入继续守原阶段；真实生成另验', minPass: 14, minAssert: 112, minSites: 44, citedBy: 0 },
  { id: 'isaac-local-discovery', path: 'packages/lyapunov-shell/test/isaac-local-discovery.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '本地Isaac SDK无导入探测、显式保存与优先级、standalone兼容以及安装收尾只验包内SDK', minPass: 9, minAssert: 61, minSites: 56, citedBy: 0 },
  { id: 'viewer-first-person-speed', path: 'packages/viewer/test/first-person-speed.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '第一人称默认移速、左右Shift加速与释放、失焦停止、相机目标同步和组合归一化', minPass: 15, minAssert: 35, minSites: 30, citedBy: 0 },
  { id: 'viewer-splat-runtime', path: 'packages/viewer/test/splat-runtime.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '泼溅 LOD 数据源、真实中心边界、分片让出与取消、交互预算和图形读数语义；实机性能另行验收', minPass: 20, minAssert: 150, minSites: 125, citedBy: 0 },
  { id: 'render-failure', path: 'packages/lyapunov-shell/test/render-failure.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    // minPass 6 → 10（2026-09-27，GATE-FLOOR-DRIFT 实测点出来的 9 条之一）
    purpose: '渲染失败必须走到可见的失败面，不得静默降级成空白/成功', minPass: 10, minAssert: 26, claimPass: 6, minSites: 26, citedBy: 2 },
  { id: 'capability-truth', path: 'packages/sim-newton/test/capability-truth.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    // GATE-AB-20260927：降级分支改用 `CUDA_VISIBLE_DEVICES=''` + `NVIDIA_VISIBLE_DEVICES=''` 的**可验证隔离**，
    //   不再由宿主有没有 CUDA 决定跑不跑（GPU 主机上原来 expect 97 < 下限 100）。实测 11 pass / 109 expect / sites 70。
    purpose: '能力声明与真实可用性一致（capability truth）', minPass: 11, minAssert: 109, claimPass: 11, minSites: 70, citedBy: 1 },
  { id: 'gpu-device-hidden-notice', path: 'packages/sim-isaac/test/gpu-device-hidden-notice.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    // GATE-AB-20260927：宿主观测与合同测试分清——五态合同分支改用合成夹具（宿主无关），
    //   原 GPU 可见宿主上 expect 只有 16 < 下限 31 的漂移消失。实测：设备隐藏宿主 11 pass / 71 expect；
    //   设备可见宿主少 10 条（宿主观测分支），故下限取**两态都满足**的 61；sites=71。
    purpose: 'GPU 在本会话不可见必须被说出来，不是静默降级', minPass: 11, minAssert: 61, minSites: 71, citedBy: 1 },
  { id: 'isaac-orphan-close-failure', path: 'packages/sim-isaac/test/isaac-orphan-close-failure.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    purpose: '关闭失败不得冒充成功（孤儿进程路径）', minPass: 3, minAssert: 27, claimPass: 3, minSites: 28, citedBy: 1 },
  { id: 'isaac-entry-lifecycle', path: 'packages/sim-isaac/test/isaac-entry-lifecycle.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    // GATE-AB-20260927：`test.skipIf(... probeGpuDeviceVisibility().visible)` 改为**可控探针替身**构造"无 GPU 会话"，
    //   合同分支不再因宿主有 GPU 而跳过（原来 GPU 主机 6 pass / 1 skip，下限 7 判红）。实测 8 pass / 48 expect / sites 44。
    purpose: 'Isaac 入口生命周期：失败要带结构化原因', minPass: 8, minAssert: 48, minSites: 44, citedBy: 2 },
  { id: 'engine-panel-decision', path: 'packages/lyapunov-shell/test/engine-panel-decision.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    purpose: '引擎面板的每个决定都能解释（不是黑箱）', minPass: 11, minAssert: 37, claimPass: 5, minSites: 30, citedBy: 2 },
  { id: 'isaac-startup-budget-entry', path: 'packages/sim-isaac/test/isaac-startup-budget-entry.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'not-run',
    purpose: '启动预算：超时必须报出来', minPass: 7, minAssert: 28, minSites: 21, citedBy: 2 },
  { id: 'isaac-startup-budget-wiring', path: 'packages/sim-isaac/test/isaac-startup-budget-wiring.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'not-run',
    purpose: '启动预算接线：超时判据真的接进入口', minPass: 4, minAssert: 21, minSites: 16, citedBy: 1 },
  { id: 'engine-selection-consistency', path: 'packages/sim-isaac/test/engine-selection-consistency.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'not-run',
    purpose: '默认引擎判据在终端与共享解析两处必须可从一门复算', minPass: 6, minAssert: 36, minSites: 36, citedBy: 1 },
  { id: 'session-ownership-two-sessions', path: 'packages/lyapunov-shell/test/session-ownership-two-sessions.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '两会话互不可见、互不可写（跨会话误写）', minPass: 13, minAssert: 114, claimPass: 13, minSites: 101, citedBy: 1 },
  { id: 'cua-input-single-flight', path: 'packages/lyapunov-shell/test/cua-input-single-flight.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    // minPass 8 → 12（GATE-CLOSER，`floor-drift` 实测点名：8 < 12 ⇒ 删掉 4 条仍然绿。**上调，不是放宽**）
    // 12 → 15 + minAssert 49 → 105 + minSites 42 → 92（GATE-AB-20260927，`floor-drift` 再次点名：
    //   实测 15 pass / 105 expect / sites 92；只上调冻结下限到实测值，不删旧条目、不降低旧下限）。
    purpose: '桌面输入单飞：等待与占用分开，失败也释放', minPass: 16, minAssert: 105, claimPass: 6, minSites: 92, citedBy: 3 },
  { id: 'computer-use-input-scope', path: 'packages/lyapunov-shell/test/computer-use-input-scope.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    // minPass 22 → 32（2026-09-27，GATE-FLOOR-DRIFT 实测点出来的 9 条之一）
    // 32 → 46（GATE-CLOSER，同一判据再点一次：01:32 整门实测 pass=46 / 0 fail ⇒ 下限 32 等于
    //   "删掉 14 条用例仍然绿"。**上调到实测值，不是放宽。**
    //   ⚠️ 该文件此刻仍在被写：01:38 单跑复测得 45 pass / 1 fail（它自己红，与本下限无关）。
    //   本数字取自 01:32 整门读数；该 lane 落定后若条数变了，`floor-drift` 会立刻再点一次。）
    // 46 → 62 + minAssert 147 → 965 + minSites 92 → 400（GATE-AB-20260927，`floor-drift` 点名：
    //   实测 62 pass / 965 expect / sites 400；只上调到实测值）。
    purpose: 'computer-use 输入作用域与拒绝清单', minPass: 62, minAssert: 965, claimPass: 22, minSites: 400, citedBy: 2 },
  { id: 'domain-pointer-rules-turn', path: 'packages/lyapunov-shell/test/domain-pointer-rules-turn.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '域指针规则按回合判定', minPass: 4, minAssert: 27, claimPass: 3, minSites: 22, citedBy: 8 },
  { id: 'session-context-cross', path: 'packages/lyapunov-shell/test/session-context-cross.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '跨会话上下文可区分，不串味', minPass: 5, minAssert: 64, claimPass: 2, minSites: 48, citedBy: 2 },
  { id: 'session-history', path: 'packages/lyapunov-shell/test/session-history.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '会话历史恢复：窗口与意图不丢', minPass: 26, minAssert: 127, claimPass: 21, minSites: 125, citedBy: 1 },
  { id: 'conversation-history', path: 'packages/lyapunov-shell/test/conversation-history.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '会话标题/意图判定（单帧夹具 vs 多帧现实的回归）', minPass: 7, minAssert: 27, claimPass: 7, minSites: 27, citedBy: 1 },
  { id: 'privacy-boundary', path: 'packages/lyapunov-shell/test/privacy-boundary.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    // GATE-AB-20260927：`floor-drift` 点名 minPass 29 < 实测 31（删掉 2 条仍然绿）⇒ 连同 minAssert
    //   332 → 365、minSites 118 → 146 一起上调到实测值（只提高，不下调）。
    purpose: '隐私边界：绝对路径与合成标记不外泄', minPass: 41, minAssert: 365, minSites: 146, citedBy: 2 },
  { id: 'host-projection-candidate', path: 'packages/lyapunov-shell/test/host-projection-candidate.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '候选出站投影：合成标记不入正文', minPass: 9, minAssert: 195, minSites: 63, citedBy: 3 },
  { id: 'target-window', path: 'packages/lyapunov-shell/test/target-window.test.ts', theme: 'cross-session-write', runner: 'bun:test', ci: 'run',
    purpose: '定向动作只投目标窗口，别的窗口确认不出队', minPass: 7, minAssert: 34, claimPass: 7, minSites: 27, citedBy: 1 },
  { id: 'history-boundary', path: 'packages/lyapunov-session-undo/test/history-boundary.test.ts', theme: 'undo-boundary', runner: 'bun:test', ci: 'run',
    purpose: '撤销边界不后退、失败现场可定位', minPass: 5, minAssert: 11, claimPass: 5, minSites: 11, citedBy: 1 },
  // claimPass 由 6 更正为 5（2026-09-26 勘误，见 bugfixHistory/SESSION-UNDO-CHAIN-20260926.md §9）：
  //   原声明"test/worktree-snapshots.test.ts（6 例）"是把**冷恢复两分支**（同一条 `recover()` 用例内）数成了
  //   两条。该文件的 5 条 `test(` 站点、`bun test` 的 `5 pass / 0 fail`、以及本门 undo-boundary 主题
  //   10 = 本文件 5 + history-boundary 5 三处互相印证，且无 skip ⇒ 这个文件**不存在第 6 条**。
  //   `minPass` 始终是"实测通过数"（本表 66 条里 65 条 minPass==实测，唯一例外 viewer-texture-and-autoframe
  //   是实测 22 > 下限 15），所以下限 5 本来就是对的那个；错的是 claimPass。**不是为了让门变绿而下调下限。**
  { id: 'worktree-snapshots', path: 'packages/lyapunov-session-undo/test/worktree-snapshots.test.ts', theme: 'undo-boundary', runner: 'bun:test', ci: 'run',
    purpose: '工作树快照五类变更 + 会话私有运行目录不进撤销域', minPass: 5, minAssert: 31, claimPass: 5, minSites: 31, citedBy: 2 },
  // minPass 45 → 46 → 47（2026-09-27 00:5x / 01:1x，GATE-CLOSER 单，按 `floor-drift` 自己的修法**上调到实测值**）：
  //   45 → 46：ORDER-DEPENDENT-GPU-PROBE 单在这个文件里 +1 条用例（「探测顺序无关」，6 expect），
  //   实测 **46 pass / 0 fail / 364 expect**（单独跑 = 门里跑 = 反序跑，逐项相同）。
  //   46 → 47：同一文件在该 lane 落定后又长出 1 条，`floor-drift` 再点一次（整门实测 **47**）。
  //   下限不跟上 ⇒ "删掉那条顺序不变式仍然绿" ⇒ 正是 `floor-drift` 存在的意义。**不是放宽，是收紧。**
  //   （定版核对：`GATE-FINALIZATION` 单 2026-09-27 01:4x 复算 —— 本注释与值 47 一致。改前注释停在 46。）
  { id: 'environment-readiness', path: 'packages/lyapunov-shell/test/environment-readiness.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: '环境预检不得假警报/假通过（装不上就说装不上）', minPass: 50, minAssert: 354, claimPass: 35, minSites: 238, citedBy: 1 },
  { id: 'prepare-env-guard', path: 'packages/benchmark-libero/test/prepare-env-guard.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: '空/空白环境值必须抛，不静默改写设备可见性', minPass: 3, minAssert: 10, claimPass: 3, minSites: 5, citedBy: 2 },
  { id: 'environment-routing', path: 'packages/lyapunov-shell/test/environment-routing.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: '环境路由选择与可见性', minPass: 96, minAssert: 273, claimPass: 81, minSites: 217, citedBy: 1 },
  { id: 'model-download-routing', path: 'packages/lyapunov-shell/test/model-download-routing.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: '模型下载路由（缺资产 vs 设备不可见）', minPass: 5, minAssert: 31, claimPass: 5, minSites: 27, citedBy: 1 },
  { id: 'pack-library-actions', path: 'packages/lyapunov-shell/test/pack-library-actions.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: '能力包面板消费者行为', minPass: 7, minAssert: 23, claimPass: 7, minSites: 23, citedBy: 1 },
  { id: 'provider-installer', path: 'packages/lyapunov-shell/test/provider-installer.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    purpose: 'provider 安装器：失败不报成功', minPass: 28, minAssert: 191, minSites: 146, citedBy: 1 },
  { id: 'engine-preference', path: 'script/engine-preference.test.ts', theme: 'preflight-false-alarm', runner: 'plain', ci: 'not-run',
    purpose: '引擎就绪判据：空壳 venv 不算就绪（plain 脚本，自报 N/M）', minPass: 59, minAssert: 37, minSites: 30, citedBy: 2 },
  { id: 'terminal-options', path: 'script/terminal-options.test.ts', theme: 'preflight-false-alarm', runner: 'plain', ci: 'not-run',
    purpose: '终端 --engine 入口一致（plain 脚本，自报 N/M）', minPass: 30, minAssert: 30, minSites: 23, citedBy: 1 },
  { id: 'policy-source-bounded-fetch', path: 'packages/policy-registry/test/policy-source-bounded-fetch.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    purpose: '取件有界：超时/重试/可诊断五要素（W25）', minPass: 8, minAssert: 43, claimPass: 8, minSites: 43, citedBy: 1 },
  { id: 'mamba-license', path: 'distribution/licenses/mamba-license.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    // minPass 14 → 24（2026-09-27，GATE-FLOOR-DRIFT 实测点出来的 9 条之一）
    // 24 → 25（GATE-CLOSER，同一判据再点一次：实测 25 pass / 0 fail / 123 expect；**上调，不是放宽**）
    purpose: '打包取件有界 + 缓存命中 0 网络（W16）', minPass: 25, minAssert: 61, claimPass: 14, minSites: 61, citedBy: 2 },
  { id: 'payload-contract', path: 'distribution/linux/payload-contract.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    purpose: '发行载荷契约 + micromamba 取件有界（W6）', minPass: 19, minAssert: 47, claimPass: 13, minSites: 47, citedBy: 3 },
  { id: 'vla-official-scene-binding', path: 'packages/policy-registry/test/vla-official-scene-binding.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    purpose: '官方策略取件与场景绑定', minPass: 6, minAssert: 9, claimPass: 6, minSites: 9, citedBy: 1 },
  { id: 'operations-bounded-fetch', path: 'packages/lyapunov-share/test/operations-bounded-fetch.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    // minPass 由 11 上调到 29（2026-09-27，GATE-FLOOR-DRIFT）：R-fix#5/#7 把这个文件从 11 pass 长到 29 pass，
    // 下限留在 11 就等于"删掉 18 条用例仍然绿"。**只上调，不下调**（本判据的判据就是这一条）。
    // 29 → 36（GATE-CLOSER，同一判据再点一次：单跑实测 36 pass / 0 fail / 267 expect，**上调，不是放宽**）
    purpose: '分享取件有界（P8/W25 同口径第三处）', minPass: 36, minAssert: 69, minSites: 69, citedBy: 2 },
  { id: 'episode-record-fields', path: 'packages/benchmark-libero/test/episode-record-fields.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'episode 记录字段（appliedControl 逐字段）', minPass: 6, minAssert: 40, minSites: 40, citedBy: 1 },
  { id: 'scene-projection', path: 'packages/benchmark-libero/test/scene-projection.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '改名后回归：scene-bridge → scene-projection', minPass: 8, minAssert: 30, minSites: 30, citedBy: 2 },
  { id: 'behavior-evidence', path: 'packages/policy-registry/test/behavior-evidence.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '行为证据套件', minPass: 5, minAssert: 12, minSites: 12, citedBy: 1 },
  { id: 'html-preview-entry', path: 'packages/lyapunov-shell/test/html-preview-entry.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'HTML 预览入口一致性', minPass: 50, minAssert: 182, claimPass: 48, minSites: 182, citedBy: 1 },
  { id: 'dev032-html-plan-wiring', path: 'packages/lyapunov-workspace/test/dev032-html-plan-wiring.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'DEV-032 HTML 计划接线', minPass: 5, minAssert: 31, claimPass: 4, minSites: 31, citedBy: 1 },
  { id: 'portability', path: 'packages/lyaup-migrations/test/portability.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '迁移可移植性（含回退边界）', minPass: 11, minAssert: 121, claimPass: 11, minSites: 121, citedBy: 1 },
  { id: 'migrate-workspace-layout', path: 'script/migrate-workspace-layout.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '工作区布局迁移', minPass: 11, minAssert: 117, claimPass: 11, minSites: 76, citedBy: 1 },
  { id: 'runtime-patch', path: 'script/runtime-patch.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    // minPass 8 → 16（2026-09-27，GATE-FLOOR-DRIFT 实测点出来的 9 条之一）
    purpose: '运行补丁替身与源码守卫', minPass: 26, minAssert: 172, claimPass: 8, minSites: 161, citedBy: 1 },
  { id: 'g17-legacy-residue', path: 'script/gates/g17-legacy-residue.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'g17 哑探针的失败能力单测（(?:…) 在 POSIX ERE 下无效）', minPass: 12, minAssert: 44, claimPass: 12, minSites: 34, citedBy: 1 },
  { id: 'package-linux', path: 'script/package-linux.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '发行根清单名与产品链接归属同一身份（W6/DEV-020）+ 出处守卫（载荷相关脏 ⇒ 拒包）', minPass: 13, minAssert: 73, claimPass: 7, minSites: 62, citedBy: 3 },
  { id: 'g19-building-robot-task', path: 'packages/scene-kit/test/g19-building-robot-task.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'G19 建筑-机器人任务链', minPass: 2, minAssert: 30, minSites: 31, citedBy: 2 },
  { id: 'g19-building-scale-animation', path: 'packages/scene-kit/test/g19-building-scale-animation.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'G19 动画只驱动显示、不进物理', minPass: 8, minAssert: 29, minSites: 29, citedBy: 2,
    waiveSkip: 1,
    waiveSkipReason: '物理侧派生要求 LYAPUNOV_ALGORITHM_PYTHON；A06同版完整门已真实执行8/8且无skip。未设变量时的1skip仅保留历史环境说明，7pass低于当前8下限必须RED，不得算通过' },
  { id: 'open-cancel', path: 'packages/sim-mujoco/test/open-cancel.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '打开中途取消不留下半个会话', minPass: 4, minAssert: 28, minSites: 29, citedBy: 1 },
  { id: 'formal-model', path: 'packages/lyapunov-product-bundle/test/formal-model.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '正式模型面', minPass: 2, minAssert: 6, minSites: 6, citedBy: 1 },
  { id: 'session-launch', path: 'packages/sim-contract/test/session-launch.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'not-run',
    purpose: '会话启动契约', minPass: 30, minAssert: 93, minSites: 93, citedBy: 1 },
  { id: 'isaac-startup-budget', path: 'packages/sim-contract/test/isaac-startup-budget.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'not-run',
    purpose: 'Isaac 启动预算（契约层）', minPass: 6, minAssert: 33, minSites: 34, citedBy: 2 },
  { id: 'scene-adapter-transform', path: 'packages/sim-isaac/test/scene-adapter-transform.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'not-run',
    purpose: 'Isaac 场景适配变换', minPass: 7, minAssert: 63, minSites: 20, citedBy: 1 },
  { id: 'worker-robot-metadata', path: 'packages/sim-isaac/test/worker-robot-metadata.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'not-run',
    purpose: 'worker 机器人元数据', minPass: 11, minAssert: 167, minSites: 50, citedBy: 1 },
  { id: 'blender-executable', path: 'script/blender-executable.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'not-run',
    purpose: 'Blender 可执行解析（同模块邻居，防回归）', minPass: 7, minAssert: 10, claimPass: 7, minSites: 10, citedBy: 1 },
  { id: 'unity-mcp', path: 'script/unity-mcp.test.ts', theme: 'other-round', runner: 'plain', ci: 'not-run',
    purpose: 'Unity MCP 接线（plain 脚本，合成标记不入正文）', minPass: 11, minAssert: 11, minSites: 11, citedBy: 4 },
  // ↓ 首次全量跑（2026-09-26 19:xx）由 caseset-coverage 的 DRIFT 点出来的 4 条：本轮新增/被回执引用的
  //   用例，当时没接进门。**这正是该判据存在的理由** —— 不接进来，发布门就不会跑它们。
  { id: 'job-record-hunyuan', path: 'packages/generate-hunyuan/test/job-record.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '生成任务记录持久化（DEV-018 persist 合一后）', minPass: 11, minAssert: 47, minSites: 32, citedBy: 1 },
  { id: 'job-record-marble', path: 'packages/generate-marble/test/job-record.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '生成任务记录持久化（DEV-018 persist 合一后）', minPass: 3, minAssert: 19, minSites: 19, citedBy: 1 },
  { id: 'workbench-camera-initial-framing', path: 'packages/lyapunov-shell/test/workbench-camera-initial-framing.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '初始机位不被巨大地面/隐藏碰撞几何拉远', minPass: 11, minAssert: 77, minSites: 62, citedBy: 2 },
  { id: 'viewer-texture-and-autoframe', path: 'packages/viewer/test/texture-and-autoframe.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    // minPass 由 15 上调到 27（2026-09-27，GATE-FLOOR-DRIFT，验收报告 §4-N8 点名的那一条）：
    // DEV-034 把该文件从 15 条长到 27 条，下限留在 15 就等于"删掉 12 条用例仍然绿"。
    purpose: '2D 纹理真的进材质 + 自动取景只看可见有限几何（DEV-034）', minPass: 30, minAssert: 42, minSites: 42, citedBy: 2 },
  // ↓ 2026-09-26 第二轮 caseset-coverage 反查又点出的 4 条 DRIFT（同一机制、同一理由：不接进门，发布门就不跑它）。
  //   四条都实测于本轮（bun 1.3.13 / 工作树 HEAD b1b6427）：minPass=实测通过数、minAssert=实测 expect 读数、
  //   minSites=门的 countAssertSites 静态站点数。四条都**无外部标记**（不起 python/不联网/不碰真机），
  //   离线可跑，故不进 COVERAGE_WAIVERS。
  //   第 5 条 DRIFT（packages/policy-registry/test/wtw-identity-dispatch.test.ts）**有意不接**，理由见 COVERAGE_WAIVERS。
  { id: 'policy-source-github-quota', path: 'packages/policy-registry/test/policy-source-github-quota.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    // minPass 由 27 上调到 39（2026-09-27，GATE-FLOOR-DRIFT）：R-fix#3/#8 把这个文件从 27 pass 长到 39 pass。
    purpose: 'GitHub 取件的匿名配额隐式依赖与凭据入口：一次取件 3 个 api 请求、token 只发 api.github.com、403 配额与权限可分、429 限流不重试（W26/W26-R1）', minPass: 39, minAssert: 136, minSites: 136, citedBy: 3 },
  { id: 'scene-kit-formats-mjcf-sections', path: 'packages/scene-kit/test/formats-mjcf-sections.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '重复 MJCF 顶层段与 include 组合的归一化（DEV-030）：并段后网格/body/关节仍在、meshdir 生效、类边界不被并掉', minPass: 16, minAssert: 62, minSites: 60, citedBy: 1 },
  { id: 'viewer-projection-consumer', path: 'packages/viewer/test/projection-consumer.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    // minPass 18 → 19（2026-09-27，GATE-FLOOR-DRIFT 实测点出来的 9 条之一）
    purpose: '出站投影的消费侧回归（DEV-PROJ-01）：`res:<指纹>` 之后装载器/基址/格式分派不得再拿定位符串猜语义（P15 实测打坏的 5 处消费点）', minPass: 19, minAssert: 91, minSites: 79, citedBy: 3 },
  { id: 'viewer-splat-support', path: 'packages/viewer/test/splat-support.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: 'splat 成因分类（DEV-025）：格式不支持/解码器缺失/依赖缺失/配准轴向/正常分开，稳定码与异常文本归类', minPass: 12, minAssert: 47, minSites: 34, citedBy: 1 },
  // ↓ 2026-09-26 19:18 追加的 3 条：`bugfixHistory/SIX-UNCONFIRMABLE-20260926.md` 落地后派生集**长大**
  //   （derived 64 → 67），把这三条被该回执举过证的路径带了进来。三条都是清单 `include`、都不带外部标记
  //   （离线可跑），故按同一纪律接进门；读数同样实测于本轮。
  //   **这条现场本身记进回执**：派生集是活的 —— 一张 release-gate 读数只对它运行时的那一刻负责，
  //   并行的写手落下新回执就会把它作废（本单实际发生过一次）。
  { id: 'desktop-restart-recovery', path: 'packages/desktop/test/restart-recovery.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '重启恢复规则（DEV-036）：唯一未归档会话按记录次序恢复、多工作区不猜"最近一个"、归档会话永不恢复、失效 world 不重发动作、渲染/句柄耗尽/文件监控耗尽各自归因且不改系统限额', minPass: 19, minAssert: 52, minSites: 45, citedBy: 1 },
  { id: 'share-export', path: 'packages/lyapunov-share/test/export.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '分享导出：archiveDigest 与 assetType 按字节和后缀给出稳定结果', minPass: 1, minAssert: 3, minSites: 3, citedBy: 1 },
  { id: 'notification-no-replay', path: 'packages/lyapunov-shell/test/notification-no-replay.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '通知不重放动作（DEV-035）：重复读不增标记不改读数、保留策略是纯过滤、导出面没有动作类入口', minPass: 3, minAssert: 13, minSites: 12, citedBy: 1 },
  // ↓ 2026-09-26 追加：**harness 自己的用例**（P23 报出的覆盖缺口，Lead 裁定"接进门，不用 waiver"）。
  //   它一直在 CI 清单里（`decision=include`）却不在本表 ⇒ 任何回执逐字引用它的路径都会被
  //   `caseset-coverage` 判 DRIFT（P23 因此**有意没写逐字路径**，读数只能留在 .runtime 证据日志里）。
  //   为什么接得进来（两条先判，逐条有实测）：
  //   ① **不递归/不自指**：它 spawn 的是 `script/test-ci.ts`（拿到的是 `--root <私有 tmp 树>` +
  //      `--manifest manifest.json`，清单是 tmp 里合成的两条），全程不碰本门；本门跑它是"门的子进程
  //      再起 harness 的子进程"，深度 2、无环（strace -f 全量 execve 里 `release-gate` 出现 0 次）。
  //      耗时实测 275–294ms（门给它所在用例的单条超时是 600_000ms）。
  //   ② **无外部标记、离线可跑**：不起 python/不联网/不碰真机（清单与 preflight 两处一致）。
  //   覆盖的是**真 CLI 退出码（0/2）与真子进程**（合成缺件树 ⇒ 退出码 2 并点名文件），
  //   正是门该跑的东西。minPass/minAssert 实测（bun 1.3.13）：18 pass / 0 fail / 72 expect；
  //   minSites=门的 countAssertSites 静态站点数 60；claimPass 取 P23 回执声明的那份读数。
  { id: 'test-ci-harness-cli', path: 'script/test-ci.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    // minPass 18 → 28（GATE-CLOSER，`floor-drift` 实测点名：18 < 28 ⇒ 删掉 10 条仍然绿。**上调，不是放宽**）
    // 28 → 33（GATE-CLOSER 再次点名：28 < 33；01:48 单跑实测 33 pass / 0 fail / 133 expect、sites=119。**只上调**）
    purpose: 'CI harness（= `bun run preflight` 的引擎）的分类与失败传播：不跑≠通过（未审标记 fail-closed）、纳入缺件必须 exit 2 并点名、真 CLI 退出码 0/2 与真子进程（CCMM-07/09）', minPass: 33, minAssert: 133, claimPass: 18, minSites: 119, citedBy: 1 },
  // ↓ 2026-09-27 00:5x 追加两条（GATE-CLOSER 单）。两条都是**在飞 lane 造的用例、因不在写域没人接进门**：
  //   `caseset-coverage` 会把它们判 DRIFT（"新增回归用例必须接进门，或写进 COVERAGE_WAIVERS 并给理由"），
  //   而 `manifest-gate-gap` 只登记"有多少条不进门"，不替谁接线。两条都**离线可跑**（无 python/无网络/
  //   不碰真机），故按同一纪律**接进门而不是写 waiver**。读数都是本机实测（bun 1.3.13，00:5x）：
  //
  //   ① `gate-drivers-mechanism`（来源 `bugfixHistory/GATE-DRIVERS-BLIND-SPOT-20260926.md`，Lead 在
  //      `docs/REMAINING_WORK_PLAN.md` §六之补二 ① 登记为待办）：机制 2（门必须有驱动）**自己**的用例。
  //      它一直只在清单里、不在门里 ⇒ 机制下次再对某个实现失明，发布门不会红。
  //      ⚠️ 本条目接进门后**当场就抓到一条真漂移**：`script/gate-drivers.ts` 在 01:0x 被改（G16 路由 +
  //      `identities` 22→24 + `byKind`），而 `script/gate-drivers.test.ts` 还是 00:17 那版 ⇒ 门里跑出
  //      `fail=4`（单跑同样 11/4）。那条 lane 01:13 补齐用例后转绿。
  //      读数因此**抬过两档**：接门时实测 15/128（sites=76），01:13 复测 **29 pass / 0 fail / 342 expect**、
  //      `minSites` 用门的 `countAssertSites()` 读源文得 **177** —— 按 `floor-drift` 的修法**上调到实测值**。
  //      任何人再改这个文件，都要把这三个数**一起**改（不然 `floor-drift` 会立刻点名）。
  //   ② `gpu-misdiagnosis-guard`（来源 `bugfixHistory/GPU-MISDIAGNOSIS-FIX-20260926.md` +
  //      `VERIFY-ENV-READINESS-GPU-20260926.md`）：A1/A2/A3 三条误诊的**负对照**（不许把既有正确分型一起改掉）
  //      + C1 装配点共用同一份"设备可见"判据 + **B2 探测顺序不变式的最强守卫**（连读三次 state/headline/
  //      指纹/deviceExtras 全一致，且副作用已算进第一次读数；`nvidia-smi` 自己造的条目**不许留在盘上、也不许进证据**）。
  //      ⚠️ 这条**正是** `bugfixHistory/ORDER-DEPENDENCY-RECHECK-20260926.md` §6 残留②点名的那个洞：
  //      "最强的那条顺序守卫没进门"（当时在 `notRun` 的 123 条里）。接它进来 = 给那条不变式加机器守卫。
  //      接门时实测 14/150（sites=126）；01:1x 复测 **16 pass / 0 fail / 173 expect**、`minSites` = **145**
  //      ⇒ 同样按 `floor-drift` 的修法**上调到实测值**（该文件此刻仍被 GPU lane 改写，这两个数只对
  //      2026-09-27 01:1x 那一刻负责；再有变化由 `floor-drift` 点名）。
  { id: 'gate-drivers-mechanism', path: 'script/gate-drivers.test.ts', theme: 'other-round', runner: 'bun:test', ci: 'run',
    purpose: '机制 2（门必须有驱动）自身：发现集合收全扩展名（g10b.mts 不许无声消失）、已审计/未纳入审计两类数字加得上、缺驱动与例外表过期都必须 fail-closed；含 release-gate parseGateDrivers() 的 --json 契约', minPass: 29, minAssert: 342, minSites: 177, citedBy: 1 },
  { id: 'gpu-misdiagnosis-guard', path: 'packages/lyapunov-shell/test/gpu-misdiagnosis-guard.test.ts', theme: 'preflight-false-alarm', runner: 'bun:test', ci: 'run',
    // GATE-AB-20260927：`W21 真机读数锁` 的 5 条断言原来只在"宿主恰好 device-hidden"时跑（GPU 可见宿主
    //   全文件 expect 237 < 下限 242）。五态合同分支改由合成夹具矩阵全覆盖、真机那格退化为宿主观测后，
    //   读数**与宿主无关**：实测 23 pass / 265 expect / sites 218。三条下限一起上调到实测值。
    purpose: 'GPU 误诊守卫（A1 缺工具≠驱动坏 / A2 读不到≠没有 / A3 驱动在卡不在，三条各有负对照）+ C1 装配点与契约共用同一份"设备可见"判据 + **探测顺序与调用次数无关**（连读三次逐字段相同，副作用已算进第一次读数）', minPass: 23, minAssert: 265, minSites: 218, citedBy: 1 },
  // ↓ 2026-09-27（CI-FIX 单）：`manifest-gate-gap` 的现算值比冻结点多 4 条（notRun 135 vs 冻结 131）。
  //   主控用 `manifestGapDigest` 逐项复算定位出这 4 条：它们都在清单 `include`、都能离线跑，只是没人接进门。
  //   本轮按同一纪律**接进门而不是写 waiver**；去掉这 4 条后 notRun 的摘要恰好回到原冻结 `62127a5e1e71`
  //   （现算 after+4 = 131 / `62127a5e1e71`，与冻结值逐字相同 ⇒ 不重冻、不提高 `MANIFEST_GAP_FROZEN`）。
  //   四条读数均为本机实测（bun 1.3.13，2026-09-27 15:24），`minSites` = 本门 `countAssertSites()` 静态站点数，
  //   `minAssert` = 运行期 `N expect() calls`。四条都无真实网络/外部 GPU 调用（renderer 能力替身、真实本地
  //   编码夹具、fetch 替身），故不写 `COVERAGE_WAIVERS`。
  { id: 'computer-use-wording', path: 'packages/lyapunov-shell/test/computer-use-wording.test.tsx', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    purpose: 'computer-use 三句用户可见文案的判据（USER-VISIBLE-WORDING-20260927）：用户话里不许出现 CUA_* 错误码 / 产品 rule id / 驱动工具名 / 内部英文枚举 / 字段名 / 裸 ISO 时间戳，同时可行动信息（哪个动作被拒、为什么、去哪儿改）与安全事实（被拒条数、可见指示状态、恢复失败项数）一条不许少；证据含 `renderToStaticMarkup` 渲染文本 + 源码文本守卫，只证明这两层，不证明完整 GUI / 真浏览器交互。', minPass: 15, minAssert: 409, minSites: 81, citedBy: 1 },
  { id: 'policy-archive-level3-wiring', path: 'packages/policy-registry/test/policy-archive-level3-wiring.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    purpose: '第 3 级整仓归档在产品路径 `downloadPolicy` 上的接线（ARCHIVE-REACHABILITY-AND-MEMO-20260927）：只在传输层失败时换级、身份不够强不换、校验/4xx 不换、取消不换级、门①门②逐件不省、第 3 级失败留痕（attempt-failed + 五要素挂 cause）、packs 源不适用、缓存读数；归档字节现场造 + `globalThis.fetch` 替身，零出网。', minPass: 13, minAssert: 79, minSites: 68, citedBy: 1 },
  { id: 'policy-source-json-body-timeout-shape', path: 'packages/policy-registry/test/policy-source-json-body-timeout-shape.test.ts', theme: 'fetch-five-elements', runner: 'bun:test', ci: 'run',
    purpose: '`getJSON` 正文阶段超时的错误形状（同形残留）：裸 DOMException(TimeoutError) 必须变成带五要素、`attempts` 非空、且写明"读正文阶段撞上本次尝试上限 + 在此之前已收到多少字节"的 `PolicyFetchError`；同时钉住 `POLICY_FETCH_ATTEMPTS=3` 不变、超时那一跳没有新增重试层、调用方取消原样传播、404 裸码与正文非 JSON 的 SyntaxError 不变；fetch 替身，零出网。', minPass: 5, minAssert: 29, minSites: 29, citedBy: 1 },
  { id: 'robot-glb-ktx2-texture', path: 'packages/viewer/test/robot-glb-ktx2-texture.test.ts', theme: 'silent-degradation', runner: 'bun:test', ci: 'run',
    purpose: '机器人文档里带 KTX2（KHR_texture_basisu）贴图的 `.glb`：传 renderer 时贴图真的挂上（CompressedTexture / 8×8 / 4 级 mipmap、`warnings` 为空），不带 KTX2 的真件读数逐项不变，不传 renderer 或声明 MJCF material 时必须有一条明确警告（不再是"无贴图、无报错"）；真编码器夹具经 `file:` URL 从盘上读字节，零出网。渲染器能力用替身 ⇒ 只证明视觉贴图接线，不证明物理碰撞/渲染，也不证明真实 GPU。', minPass: 13, minAssert: 69, minSites: 69, citedBy: 1 },
]

/**
 * 派生出来了、但**有意不接进门**的候选。每一条都必须写明理由 —— 这是"不许静默漏掉回归用例"的
 * 唯一出口，所以它要显式、可审计、且会在输出里以 WAIVED 出现。
 */
export const COVERAGE_WAIVERS: readonly { path: string; reason: string }[] = [
  {
    path: 'script/env-self-link-guard.test.ts',
    reason:
      'SELFLINK-READONLY-GUARD（P10 的只读守卫，本门新增判据 `env-self-link-guard` 的测试）。**有意不接进 CASES**，' +
      '理由是"接进来是自证循环"：它测的正是本门那条判据的取数与判定（`parseSelfLinkGuard` / `evalSelfLinkCriterion`），' +
      '而它自己又 import 本门、并 spawn `script/env-self-link-guard.ts` 子进程 —— 接进 CASES 等于让门用"自己跑自己"来证明自己。' +
      '证据面已由别处覆盖：① 每条判据函数/负对照都是 `bun:test` 真断言（21 pass / 0 fail / 67 expect）；' +
      '② "接线真的通"由本门自己的输出证明 —— 判据行 `env-self-link-guard GREEN links=… selfReferential=… gridDiagnostics=…` 就是它要求的两个数；' +
      '③ 它已在 `script/test-ci.manifest.json` 里 `include`，由 preflight（清单纳入面）与 CI 覆盖。' +
      '残余洞口（如实登记）：这条用例因此不受本门的 case-integrity / pass 下限保护 —— 它下次被改坏不会被发布门发现，只会在 CI 里红。',
  },
  {
    path: 'script/release-gate.test.ts',
    reason:
      '本 gate 自己的测试：接进来会自我递归（该测试会再 spawn 本 gate 跑用例），且它验的是门自身而不是产品行为。' +
      '它的可用性由 preflight（清单纳入面）与本 gate 的负对照自检覆盖。',
  },
  {
    path: 'packages/policy-registry/test/wtw-identity-dispatch.test.ts',
    reason:
      '本机策略 python 隐式依赖：文件在**模块加载期**就调 `pythonPath()`（`adapter.ts:40`）解析' +
      '`.runtime/sim-python/bin/python`（可被 `LYAPUNOV_POLICY_PYTHON`/`LYAPUNOV_MUJOCO_PYTHON` 覆盖），' +
      '正向用例必须真跑 `../python/prepare_wtw.py`（mujoco+numpy）⇒ 该路径不存在时**不是 skip 而是硬失败**：' +
      '本轮负对照实测 `LYAPUNOV_POLICY_PYTHON=/nonexistent/python` ⇒ 3 pass / 4 fail（`ENOENT` 于 ' +
      '`adapter.ts:344` execFile）。`.runtime/**` 是机器产物、干净 checkout 里不存在，所以把它接进门会让' +
      '**发布门依赖某台开发机的运行时根**（与本文件开头"不判真机、不碰 .runtime"的边界冲突）。' +
      '清单 `script/test-ci.manifest.json` 已把它判为 `exclude`（CI 有意不跑），本豁免与那条处置一致。' +
      '**本轮已实测**：本机（该 python 存在）`bun test` ⇒ 7 pass / 0 fail / 54 expect，故这不是"跑不起来的' +
      '死用例"，而是**有环境前置条件的活用例**。' +
      '残余洞口（如实登记）：这条路径因此不受本门的 case-integrity / pass 下限保护 —— 它下次被改坏或长回去' +
      '不会被发布门发现。' +
      '另注：清单给它的 exclude 标记是 `net_fetch, realmodel`，与该文件头"**网络无关**"（合成 pkl + 最小 Go1 ' +
      'MJCF，全用替身）不符；标记是否该改成"需要产品策略 python"应报 Lead 定，本轮不动清单（非本单写入域）。',
  },
  // ── ↓ 2026-09-27（WAIVERS-AND-FIXTURE 单 · Lead 裁定 A：写 waiver，不重冻、不接进门）
  //   下面 9 条由 `preflight` 的 UNCLASSIFIED 报出、经 CI-REDS-CLEAR 单补登记为 `include` 的在途候选，
  //   **有意不接进 CASES**（Lead 已裁「不接进门」）⇒ 按本文件开头那条自述，走"唯一出口"：登记在明面上 + 给理由。
  //   **为什么必须配对写**：只登记不配对 ⇒ `manifest.include − CASES − COVERAGE_WAIVERS` 由 131 涨到 140、
  //   digest 由 `62127a5e1e71` 变成 `40dc696e9e67` ⇒ `manifest-gate-gap` 与 `script/release-gate.test.ts` 的
  //   「真仓不变式：冻结点与现算值一致」**一起红**（本单改前实测：判据 RED / 那条测试 fail；改后两条都 GREEN）。
  //   **本单对 script/release-gate.ts 的改动只有本数组这 9 条**：判据式 / 下限 / 冻结值一个字没动。
  //   读数口径（逐条写在各自理由里）：本单独立复跑两次（与发布门同一执行器 `bun --no-env-file test <file>`、
  //   同一读数函数 `parseCaseOutput` / `countAssertSites`），两次 pass/fail/expect 逐字相同、跑前跑后 mtime 未动；
  //   `sha256`/`mtime` 是采样时刻（§7.17 ③：并发改写窗口里的文件只按 blob 哈希 + 时刻锚定）。
  //   ⚠️ 如实登记：其中 ①⑦⑧ **没有**技术障碍（离线可跑、无环境前置）——不接进门的依据是**裁定与归属**
  //   （接进门 = 替交付 lane 冻结 minPass/minAssert/minSites 三条下限并把它纳入 ratchet），不假装它们"跑不了"。
  {
    path: 'distribution/linux/rollback-boundary-doc.test.ts',
    reason:
      '回退边界的「覆盖不对称」与 Linux 侧四条欠账 L1–L4 的**文档字节守卫**（来源 `bugfixHistory/MACOS-RELEASE-NOTES-BOUNDARY-20260926.md` §10 第 2 条 + ' +
      '`bugfixHistory/LINUX-ROLLBACK-BOUNDARY-DEBTS-20260926.md`）：三面断言全部只读两份随包 README 的当前字节——A 面 macOS README 仍有「迁移是移动语义」「只读备份」且落在升级/回退节里；' +
      'B 面 Linux README 的 L1–L4 修法仍在（快照在升级之前、回退流程里有快照恢复、弱信号表述、限制句紧邻回退目标、有条件表述）；C 面 macOS 专有的数据根/凭据设施没被塞进 Linux 载荷。' +
      '**有意不接进 CASES**（Lead 对本轮在途候选的裁定「只补清单、不接进门」，见 `script/test-ci.manifest.json` 的 `note` 里 CI-REDS-CLEAR 段）：它判的是**两份随包文档的当前字节**，' +
      '而 `distribution/linux/README.md` 与 `distribution/macos/README.md` 此刻在工作树里都是 `M`（本单读数时 `git status` 两条都有未提交改动）⇒ 是否把它挂进发布门，应由文档面收工、文案冻结时决定；' +
      '现在挂等于替一份还在改动的文案背书。**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 c321dfaec5ef8eb6…`、13,009 B、mtime 2026-09-27 01:28:34）：' +
      '两次均 **9 pass / 0 fail / 14 expect**；门的 `countAssertSites()` 静态站点 **13**。' +
      '残余洞口（如实登记）：这条用例因此不受本门的 case-integrity / pass 下限 / `FLOOR_BASELINE_FROZEN` ratchet 保护——它下次被改坏不会被发布门发现，只会在 CI 里红；' +
      '它也**不在** `MANIFEST_GAP_FROZEN` 的 131 条缺口里（写 waiver 正是为了让 notRun 恒为 131）。',
  },
  {
    path: 'packages/lyapunov-shell/test/computer-use-visibility.test.tsx',
    reason:
      'D1+D3 可见性回归（来源 `bugfixHistory/VISIBILITY-HOLES-20260926.md`，缺陷本体出自只读审计 `bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md`：`computerUse` 在 `workbench.tsx` 零消费、' +
      '`WorldHandle.warnings/deviceDegraded/deviceNote/deviceKind/warpVersion` 在 `packages/*/src` 整片零读取）。两层证据缺一不可：渲染层用 `renderToStaticMarkup` 渲染真组件、把「用户看到的那句话」逐字钉住；' +
      '挂载层是**源码文本守卫**（该文件头自述本仓**没有浏览器 DOM 夹具**，所以「真的挂在页面上」只能由源码守卫钉）。' +
      '**有意不接进 CASES**：①第二层是文本判据而不是行为判据；②它用 `mock.module("@lyapunov/viewer/client")` 把插件打包产物换成最小桩（否则 bun test 里 import 会挂在 `createViewer` 未导出）；' +
      '③界面级验收（真 DOM / 真浏览器）按本门自述的边界（不启 Host、不起 GUI）本就不在门里 ⇒ 完整证据留在上面两份只读审计单与 `bugfixHistory/VISIBILITY-HOLES-20260926.md`，不在发布门 CASES。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 8e247b45ba0d6cbd…`、12,270 B、mtime 2026-09-27 01:39:13）：两次均 **11 pass / 0 fail / 54 expect**；静态站点 **50**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护（下次被改坏只在 CI 红）；不在 131 条缺口里。',
  },
  {
    path: 'packages/lyapunov-shell/test/html-preview-served-root.test.ts',
    reason:
      'BASE-SERVED-ROOT-MISMATCH 回归 F1/F2/F3（来源 `bugfixHistory/BASE-SERVED-ROOT-MISMATCH-20260926.md`）：守三件事——问对根（服务根未知时存在性只由服务端实测回答，本地文件系统只在服务根已声明/已实测时作数）、' +
      '结构性不变式（同一块计划里 `assetService.state === "ready"` ⇒ `missing` 与 `outsideRoot` 都为空）、两个方向的负对照（真缺件仍报缺件、真存在不许报缺件）。' +
      '**有意不接进 CASES**：它跑的是**真回环 HTTP**（`Bun.serve` + 真 fetch）⇒ 不是本门 CASES 里那类「离线纯逻辑」用例（本门自述边界：不启 Host、不联网、不判真机）；' +
      '而这条缺陷的界面级串（真 Chrome + 真宿主 + `Demo/tools/media-server.py`）该文件头自述**没有**跑，那份读数在同一份回执里。是否把它接进门，应连同「门要不要收带监听端口的用例」一并由 Lead 定。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 1d633edfc3344833…`、20,718 B、mtime 2026-09-27 01:58:19）：两次均 **13 pass / 0 fail / 68 expect**；静态站点 **66**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/lyapunov-shell/test/workbench-import-surface.test.tsx',
    reason:
      '`workbench.tsx` 在宿主侧的**导入面**（`viewerResourceURI` / `prepareViewerScene` 真的被 import 进来跑，而不是在别处复刻一遍正则或逻辑）——它是「已登记为未覆盖项」的**替代件**，' +
      '来源是 `ZERO-CONSUMER-FIELD-AUDIT-20260926.md` 那条宿主侧导入边界。' +
      '**有意不接进 CASES**：①它的文件头逐字写着「**这不是** `prepareViewerScene` 的行为验收（那属于 P3 的接线层口径）」，把它挂进门＝把一条烟测升格成验收、替 P3 背书；' +
      '②它只有 1 条用例 / 5 个 expect 站点，冻结 `minPass`/`minAssert`/`minSites` 三条下限等于给一条随时会被真行为用例取代的替代件上锁；③它同样 `mock.module("@lyapunov/viewer/client")`。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 98641cdd27ceb2db…`、1,540 B、mtime 2026-09-27 01:33:13）：两次均 **1 pass / 0 fail / 5 expect**；静态站点 **5**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/mirror-archive-memo.test.ts',
    reason:
      '归档取件的两条真缺口（U3 记忆化：同一个归档 URL 只取一次字节、只解一次包，但判据一步不省；U4 只放宽归档这一跳，其它每一跳的 30 s 逐字不变），来源 `bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md`。' +
      '**有意不接进 CASES**：①仓内这 3 件夹具是该回执里 G1 实测 **68 件**真链路的「同形缩小版」，而真字节读数落在 `.runtime/archive-memo/**`（机器产物，干净 checkout 里不存在）⇒ 门挂它只能守到缩小版那一片记忆化语义，' +
      '真实体量的那件事**在门外**；②它用 `setTimeout` 造流式归档字节（时间面），把一条时间敏感夹具钉成冻结下限，遇到机器负载会变成假红。是否接线应由该 lane 连同 `.runtime` 证据口径一起交。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 fe44c77c8b324b0b…`、22,709 B、mtime 2026-09-27 01:49:12）：两次均 **13 pass / 0 fail / 54 expect**；静态站点 **49**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/policy-mirror-refusal.test.ts',
    reason:
      'D4 回归：`mirrorDiscoveryRequest()` 的 **refuses 明文真的送进了给模型的失败报文**（来源只读审计 `bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D4）。三件事：有强身份就有 refuses 逐条原文与指纹判据；' +
      '没身份就如实说出不了、不编一份没有指纹的拒绝清单；packs 源走它自己的拒绝原文（`POLICY_MIRROR_PACKS_FORBIDDEN`，不回落公开源）。' +
      '**有意不接进 CASES**：它属 D1/D3/D4 同一族**零消费可见性**钉子（与上面的 `computer-use-visibility` 同一审计单、同一验收归属），且用例自己要**改 `process.env.PACK_TOKEN`**（`afterEach` 清理）并替换 `globalThis.fetch` —— ' +
      '进程级全局可变面；按本单裁定不替该 lane 冻结下限。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 e62801fc97eaffc2…`、10,768 B、mtime 2026-09-27 01:43:01）：两次均 **7 pass / 0 fail / 33 expect**；静态站点 **33**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/policy-source-exhausted-rate-limit.test.ts',
    reason:
      '「429 **尝试耗尽**之后仍要给出限流诊断」这条**已验收出口**的钉子（复核单 `bugfixHistory/CLASSIFYEXHAUSTED-RESTORE-20260926.md` F3）。它钉的是「绿着断开」那一次：并发的 lane-stall 在 00:48:16 的 922 行版里把 `boundedFetch` 里 W26-R2 的应答级分类接线整段切掉' +
      '（`const classified = options.classifyExhausted?.(…)` 与 `retryable`/`diagnosis` 两个投递点一起消失），而 `getJSON`/`sourceSnapshot` 仍在传 ⇒ `TS2353` + 已验收出口被静默切断（限流被说成瞬时网络故障）。' +
      '**有意不接进 CASES**：它守的那段产品实现（`packages/policy-registry/src/source.ts` 的耗尽出口）此刻仍在被多条 lane 并发改写（同一回执逐字记着那次整段重写）⇒ 报文措辞的断言面与产品实现同处一个在飞窗口；' +
      '本单按裁定不替 `CLASSIFYEXHAUSTED-RESTORE` lane 冻结下限（**如实登记：这条本身没有技术障碍**——离线、可跑、无环境前置；不接门的依据是裁定与归属，不是"跑不了"）。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 35273b6cb000062e…`、8,977 B、mtime 2026-09-27 01:22:35）：两次均 **3 pass / 0 fail / 21 expect**；静态站点 **21**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/policy-source-exhausted-rate-limit-evidenced.test.ts',
    reason:
      '同一个耗尽出口的**第二类输入**：429 **带** `x-ratelimit-*` 证据（`hasRateLimitEvidence` 为真 ⇒ 走「配额（限流）已用尽 + 重置于 <时刻> + 处置建议」那一支）。与上一条的分工：上一条钉**证据缺失**那一支，本文件钉**证据在场**那一支——同一出口、不同报文分支，只钉一支时另一支的措辞可在无人察觉时退化。' +
      '**有意不接进 CASES**：与上一条同源、同裁定、同一在飞窗口（该文件头逐字记着 00:48:16 那次整段重写与 Lead 的判据原文）；本单不替该 lane 冻结下限。' +
      '**如实登记：这条本身没有技术障碍**（离线、可跑、无环境前置），不接门的依据是裁定与归属。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 15e2a2bf5398113d…`、8,360 B、mtime 2026-09-27 01:37:16）：两次均 **2 pass / 0 fail / 19 expect**；静态站点 **19**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/viewer/test/gltf-draco-decoder.test.ts',
    reason:
      '根因判据：viewer 的 glTF 读取路径必须带 DRACO 解码器，且解码器字节来自产品自己（内联）。四件事：装载器真带 `DRACOLoader` 且基址与改写器判据同一个；内联的 344,510 B 与盘上 three 的真解码器**逐字节相同**（长度 + sha256 + wasm 魔数）；' +
      '改写器只认解码器请求（glTF 自身 bin/贴图与 `res:` 媒体路由 URL 一律原样放行，第二方向「一个 blob 都不建」）；`index.ts` 里不再有裸 `new GLTFLoader(`（**源码文本结构判据**——Viewer 要 WebGL 才能构造，本机没有 DOM/WebGL，行为面由真机读数覆盖）。' +
      '**有意不接进 CASES**：②面**逐字节比对 `node_modules/three/examples/jsm/libs/draco/**` 与 `node_modules/three/examples/jsm/loaders/DRACOLoader.js`**（第三方包在盘上的文件）⇒ 判据面依赖**本机 `node_modules` 里 three 的具体版本与内容**，' +
      '与本数组既有那条「机器局部依赖」豁免（`wtw-identity-dispatch`）同一类：干净 checkout（无 `node_modules`）或换一个 three 版本，读数就不是现在这个；④面又是源码文本判据。是否接线应由 viewer/DRACO 那条 lane 连同「依赖第三方包字节」的口径一起交 Lead 定。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:4x；文件静止：`sha256 8c45a262d3e8e1e8…`、9,699 B、mtime 2026-09-27 01:48:28）：两次均 **8 pass / 0 fail / 39 expect**；静态站点 **30**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  // ── ↓ 2026-09-27（WAIVERS2-AND-DANGLING-REFS 单 · Lead 裁定 A：补 waiver，不重冻、不接进门）
  //   下面 9 条是 `CI-REDS-CLEAR-20260927.md` **第二批**登记为 `include` 的在途候选（该回执表里 #10–#18），
  //   **有意不接进 CASES**（与本数组上一批 9 条同一处理方式、同一裁定）⇒ 按本文件开头那条自述走「唯一出口」。
  //   **为什么必须配对写**：只登记不配对 ⇒ `manifest.include − CASES − COVERAGE_WAIVERS` 停在 140、digest 由
  //   `62127a5e1e71` 变成 `d6376af82aa7` ⇒ `manifest-gate-gap`（判据 RED）与 `script/release-gate.test.ts` 的
  //   「真仓不变式：冻结点与现算值一致」（1 fail）**一起红**（本单改前实测两条都红；改后两条都 GREEN）。
  //   **本单对 `script/release-gate.ts` 的改动只有本数组这 9 条**：判据式 / 下限 / 冻结值一个字没动
  //   （`MANIFEST_GAP_FROZEN` 仍是 `{count: 131, digest: '62127a5e1e71'}`；补 waiver 正是为了让 notRun 恒为 131）。
  //   读数口径（逐条写在各自理由里）：本单**先算后跑** —— 先用门导出的 `manifestGateGap` + `manifestGapDigest`
  //   现算「补这 9 条之后」的 notRun/digest（= 131 / `62127a5e1e71`，与冻结值逐字相同）；再逐条复跑，
  //   用的是与发布门**同一执行器**（`run()`：`bun --no-env-file test <file>`、`capture=file`）与**同一读数函数**
  //   （`parseCaseOutput` / `countAssertSites`）。两次复跑（bun 1.3.13，2026-09-27 03:51:42–03:51:52）逐条
  //   pass/fail/expect 相同、跑前跑后 mtime + sha256 未动；`sha256`/`mtime` 是采样时刻
  //   （§7.17 ③：并发改写窗口里的文件只按 blob 哈希 + 时刻锚定，行号只作附注）。
  //   ⚠️ 如实登记：「没有技术障碍」/「有前置条件」逐条写在各自理由里，不合并成一句 —— 不接进门的依据是
  //   **裁定与归属**（接进门 = 替交付 lane 冻结 `minPass`/`minAssert`/`minSites` 三条下限并纳入 ratchet），
  //   不是假装它们"跑不了"。
  {
    path: 'packages/lyapunov-contracts/test/command-privacy-error-code.test.ts',
    reason:
      '`publicErrorCode()` 的**判据形状**：形状在前、按码分类，不是在消息里搜词（清单登记来源 `bugfixHistory/SHARE-STATUS-SHAPE-20260926.md` §1.2③ + §9-3(a)；' +
      '该文件本体是 `bugfixHistory/KTX2-AND-PRIVACY-20260927.md` §2-B/§3 的 ② 面）。' +
      '**有意不接进 CASES**：①它守的产品码 `packages/lyapunov-contracts/src/command-privacy.ts` 与相邻的 `packages/lyapunov-shell/test/privacy-boundary.test.ts` 此刻在工作树里都是 `M`（在飞）；' +
      '②它钉的那张码表的语义**在同一个窗口里被另一条 lane 改判过**（`*_UNAVAILABLE` 一族 P422 → P500，2026-09-27 03:38–03:42，影响全仓 84 个码），' +
      '而该用例自己把这条改判登记成一条**独立的登记用例**并逐字写明代价（P500 的回显支比 P422 的固定句多显示一句原文）**要 Lead 裁定**；' +
      '现在挂进门 = 替一个**未决语义**冻结三条下限，等于抢在裁定之前把一侧钉死。' +
      '**版本锚定（本节最该看清的一条）**：`CI-REDS-CLEAR-20260927.md` 记的「稳定红 14 pass / 1 fail（rc=1）/ 147 expect」是**另一份字节**的读数 ——' +
      '那份字节是 `sha256 532879149bff9a51…`、13,062 B、mtime 2026-09-27 03:37:09（本单在同一份字节上复现：仍 14 pass / 1 fail / 147 expect、rc=1，失败项逐字就是该回执点名的那一条；' +
      '副本路径 `.runtime/cleanup-batch-20260927/nc4b/packages/lyapunov-contracts/test/command-privacy-error-code.test.ts`，其 `../src/command-privacy.ts` 与现盘逐字节相同）。' +
      '**交付态字节**是 `sha256 92e83491840cfed4…`、15,155 B、mtime 2026-09-27 03:45:37 —— 该 lane 把被改判的那一族移出**它自己**的 corpus（不再替别人的改判背书），并新增一条把该改判钉住的登记用例 ⇒ 现读数 **16 pass / 0 fail**。' +
      '★**红既没有被藏起来、也不是拿 waiver 盖掉的**：CI-REDS-CLEAR 当时**没有**为了凑 exit 0 把它标 `exclude`，而是如实登记为 `include` 并把稳定红写进 reason；本条的豁免理由与"它红不红"无关（是上面 ①②③ 的裁定与归属）。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 92e83491840cfed4…`、15,155 B、mtime 2026-09-27 03:45:37）：两次均 **16 pass / 0 fail / 176 expect**；静态站点 **44**。' +
      '★顺带登记一处**清单读数已过期**（不在本单写入域）：`script/test-ci.manifest.json` 给本条记的是「14 pass / 1 fail、静态站点 41、13,062 B、`532879149bff9a51…`」，那是 03:37:09 那份字节。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护（下次被改坏不会被发布门发现，只会在 CI 里红）；不在 131 条缺口里（写 waiver 正是为了让 notRun 恒为 131）。',
  },
  {
    path: 'packages/lyapunov-shell/test/recording-panel-missing-visibility.test.tsx',
    reason:
      'D2 回归：录制**缺件**用户在面板上看得到（来源只读审计 `bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D2；交付回执 `bugfixHistory/STATUS-WORDING-AND-VISIBILITY-20260927.md` §2）。' +
      '缺陷形状：`missingCount`/`missing` 由 `recordingSummary()` 一直在算、由 `register(recordings)` 一直在发（面板每 1.5s 轮询），而客户端 `recording-panel.tsx` 的 `Pick<...>` **缺这两个键** ⇒ 全仓 0 读 ⇒ 缺件对用户不可见。' +
      '**有意不接进 CASES**：①这条可见性钉子是**渲染层 + 挂载层**两层（与本仓 D1/D3 同一形状），而挂载层按本门自述边界（不启 Host、不起 GUI、无浏览器 DOM 夹具）**本就不在门里** ⇒ 挂进 CASES 只能守到渲染层那半边，' +
      '等于给一条**只覆盖一半证据面**的用例冻结下限并替该 lane 背书；②它渲染的是"渲染与判据共用的同一个"组件（这条纪律是对的），但它守的产品面 `packages/lyapunov-shell/src/recording-panel.tsx` 此刻是 `M`（在飞）；' +
      '③该单自己还留着一个**未决归属**：`STATUS-WORDING-AND-VISIBILITY-20260927.md` §8 第 1 条问"② 是重复派单还是接力、谁是 owner"、第 2 条问"那条被本单改掉的断言该不该由原 lane 自己改"——两条都还没裁。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 2e5f828b60f7c014…`、8,541 B、mtime 2026-09-27 03:37:08）：两次均 **5 pass / 0 fail / 19 expect**；静态站点 **19**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/mirror-archive-body-timeout-shape.test.ts',
    reason:
      '**U4** 回归：归档正文阶段超时**不再裸奔**（来源 `bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md` §7-U4）。' +
      '机制：`abort` 落在 `fetchArchiveBytes` 的**正文循环**里，而那里在 `boundedFetch` 的 `try/catch` **之外** ⇒ 抛出来的是**裸 `DOMException`（TimeoutError）**：`trace.attempts` 为空、没有五要素、也不重试。' +
      '本文件用「正文停摆」替身造出那个状态（应答头立刻给、正文一个字节不发，超时 signal 一 abort 就让 body 以 `signal.reason` 拒绝，与真 fetch 同形），判据两条（其一：错误**带五要素**且 `attempts` 非空）。' +
      '**有意不接进 CASES**：①它是一条**时间/流式夹具**（用 `setTimeout` 造停摆与推迟应答）—— 把一条时间敏感夹具钉成冻结下限，遇到机器负载会变成假红（与本数组既有那条 `mirror-archive-memo` 的第 ② 条同一类理由）；' +
      '②它守的产品实现 `packages/policy-registry/src/mirror-search.ts` 是**未入库的新文件**（`git status` 里是 `??`），且在同一窗口里被别的 lane 改过（`SOURCE-MEMO-WIRING-AND-SENTINEL-20260927.md` 逐字记着 2026-09-27 03:37:58 另一条 lane 自己改了 `mirror-search.ts`）⇒ 断言面与产品实现同处一个在飞窗口。' +
      '**如实登记：这条本身没有技术障碍**（离线、可跑、无环境前置），不接门的依据是裁定与归属。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 fbfd6c94d0e8d587…`、8,071 B、mtime 2026-09-27 03:37:01）：两次均 **4 pass / 0 fail / 24 expect**；静态站点 **24**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/policy-archive-memo-wiring.test.ts',
    reason:
      '**产品侧接线**：`source.ts` 的 `fetchPolicyFileViaArchive()` 把归档记忆化真正接上（来源与施工者：`bugfixHistory/SOURCE-MEMO-WIRING-AND-SENTINEL-20260927.md`，该回执本单已核实**确实落在盘上**：`sha256 abe95242f70a3cea…`、31,886 B、mtime 2026-09-27 03:51:40）。' +
      '它钉的是：`mirror-search.ts` 的记忆化**没钉时默认不缓存**（`resolveMirrorArchiveCache = options.cache ?? (options.expectedSha256 ? defaultMirrorArchiveCache : undefined)`），而产品侧既没有钉、也没有交实例 ⇒ 一次取件里 68 件同属一棵树时仍然是 **68 次取字节 + 68 次解包**。' +
      '**有意不接进 CASES**：①它 pin 的是**接线本身**，而真实体量的那条读数（G1 的 68 件 ×2 轮）落在 `.runtime/archive-memo-wiring/**`（机器产物，干净 checkout 里不存在）⇒ 门挂它只能守到缩小版那一片，真实体量那件事**在门外**；' +
      '②这条接线依赖的 `packages/policy-registry/src/source.ts` 是本仓**被切最多**的文件（该回执自己逐字记着 03:37:11 另一条 lane 就地切掉了停摆上限那条修复），而该 lane 给这条接线配的守卫是**新挂在** `packages/policy-registry/test/policy-source-stall-cap.test.ts` 的哨兵（同样是未入库的新文件、同样未进门）⇒ 归属应连同哨兵一并由 Lead 定。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 5b740299f4ab28d6…`、12,405 B、mtime 2026-09-27 03:46:36）：两次均 **5 pass / 0 fail / 25 expect**；静态站点 **20**。' +
      '★顺带登记一处**清单读数已过期**（不在本单写入域）：`script/test-ci.manifest.json` 给本条记的是「11,786 B、`c8b7a6afc4582213…`（03:32:48）」，该文件在那之后又被改过一次。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/policy-registry/test/policy-source-github-status-who-layering.test.ts',
    reason:
      '① 401 与「权限 403」两条正文的 `who` 按层分岔（F5／2026-09-27；交付回执 `bugfixHistory/STATUS-WORDING-AND-VISIBILITY-20260927.md` §1，登记来源 `bugfixHistory/RETRYLAYER-WIRING-20260926.md` §5③ 与 §10 U3）。' +
      '它钉的是「**同一句报文不许在两条路径上给出对方的事实**」：上一单把限流正文按 `retryLayer` 分岔了三处，但 401 与权限 403 两条正文仍共用含 core 口径的 `who` ⇒ 检索链的报文里写着「未设置（匿名 ⇒ core 仅 60 次/小时…）」，' +
      '而 core 是**取件链**吃的那个桶（检索端点自己有单独一份、与 core 分开计）⇒ 报文指向那条路径上不存在的东西。' +
      '**有意不接进 CASES**：①它是一条**报文措辞**判据，而它守的产品实现 `packages/policy-registry/src/source.ts` 不但是本仓被切最多的文件，该单还在 §8 第 3 条留着一个**未决请求**——' +
      '"该文件在本单窗口内被重写 3 次，请确认它们的落盘方式不会把 F5 那三处覆盖掉"；②措辞的断言面与产品实现**同处一个在飞窗口**，此刻挂进门 = 替该 lane 冻结下限并替一份还在被多人重写的文件背书。' +
      '**如实登记：这条本身没有技术障碍**（离线、可跑、无环境前置），不接门的依据是裁定与归属。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 1a6320a90c63ec36…`、11,493 B、mtime 2026-09-27 03:26:56）：两次均 **7 pass / 0 fail / 43 expect**；静态站点 **33**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/robot-workflows/test/fleet-fork-engagement-fields.test.ts',
    reason:
      'D5：`measureForkPocketEngagement` 逐叉孔行里那个「带符号侧向误差」字段 —— 裁定**删**（来源只读审计 `bugfixHistory/ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D5；裁定与理由在交付回执 `bugfixHistory/STATUS-WORDING-AND-VISIBILITY-20260927.md` §3 ③）。' +
      '判据（Lead 逐字）：「改完那个字段要么有消费点、要么不存在」。这个用例是**裁定落地的钉子**，引用点在该文件第 6 行。' +
      '**有意不接进 CASES**：①它的证据面是**混的** —— 三条里两条是**源码文本守卫**（全仓产品 `src` 0 命中那个名字；`cargo-transfer.ts` 的两次 `liftTo` 门槛在读它），不是行为判据；' +
      '②该裁定**还没结**：`STATUS-WORDING-AND-VISIBILITY-20260927.md` §8 第 4 条逐字写着"D5 的裁定：本单选**删**…若 Lead 更希望保留带符号侧向残差，请按 §3.1 的反向记录**先指定它的交付面**，我再按那条面接"；' +
      '③该 lane 自己登记的唯一保留意见（`cargo-transfer-plugin.ts:30` 的 render 把 `phases[].detail` 裁掉）也不在门里。裁定未结前挂进门 = 把一侧钉死。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 ce6b0a0d9061e166…`、7,084 B、mtime 2026-09-27 03:31:00；登记该条时它**正在被写**：03:30:36 是 6,612 B、03:31:00 变成 7,084 B，本单读数是**静止后**那份）：两次均 **5 pass / 0 fail / 23 expect**；静态站点 **17**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/sim-mujoco/test/camera-capture-generation.test.ts',
    reason:
      'MuJoCo 采集代次守卫（DEV-009 待裁 ②，Lead 裁定：**补 MuJoCo、不放宽 Isaac**）：`captureId` 必须与**当前世界代次**同代 —— Isaac 侧 `select_capture`/`export_dataset` 同时校验 `generation`，' +
      '而 MuJoCo 侧改前只校验"captureId 存在 / 相机在不在这次采集里 / 深度可不可复用"、**不校验 generation** ⇒ 同一个 `captureId` 在 `sync` 之后仍被算成一个世界点、仍被导出。判据以 Isaac 为准，两个方向都钉（旧代次 ⇒ `STALE_GENERATION` 且发生在写盘之前；新代次 ⇒ 仍然放行）。' +
      '**有意不接进 CASES**：①它有一条**机器局部运行时前置**——该文件头自述"解释器：`LYAPUNOV_MUJOCO_PYTHON`（未设时用仓库内 `.runtime/sim-python/bin/python`）；没有解释器时**整份显式 skip** 并说明原因，不假装通过"，' +
      '而 `.runtime/**` 是机器产物、干净 checkout 里不存在 ⇒ 与本数组既有那条 `wtw-identity-dispatch` 豁免**同一类**：门挂它会把"发布门依赖某台开发机的运行时根"写成一条下限（这里更糟：没解释器时它是 **skip**，而 `skip-accounting` 判据自述"skip 永不算通过"）；' +
      '②它是本批 9 条里**唯一**带重依赖的（两次复跑 `ms=2421 / 2018`，比其余 8 条的 79–337 ms 高一个量级）⇒ 时间面也会变成假红源。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 f2569bb22bd9ecec…`、11,393 B、mtime 2026-09-27 03:25:00）：两次均 **3 pass / 0 fail / 35 expect**（本机有解释器 ⇒ 真跑了，不是 skip；`skip=0`）；静态站点 **35**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。**这条的未覆盖面比别条大**：门一旦不跑它，"没解释器就静默 skip"这件事没有任何发布门守卫看着。',
  },
  {
    path: 'packages/viewer/test/gltf-ktx2-meshopt-decoders.test.ts',
    reason:
      '根因判据：**viewer 的 glTF 读取路径必须带 KTX2（`KHR_texture_basisu`）与 meshopt（`EXT_meshopt_compression`）解码器**，而且解码器字节来自产品自己（内联/模块自带）。现场（`GLB-DRACO-RENDER-20260926.md` §7 第 3 条）：DRACO 修好之后渲染路径仍没有接这两个解码器 —— `client.tsx:36-37` 只是把 `KTX2Loader`/`MeshoptDecoder` **对外转出**，`index.ts` 一处都没 `new` 过 ⇒ **转出 ≠ 接上**。' +
      '**有意不接进 CASES**：①第 ② 面**逐字节比对 `node_modules/three/examples/jsm/libs/basis/**`**（第三方包在**盘上**的文件）⇒ 与本数组既有那条 `gltf-draco-decoder` 同一类"机器局部依赖"：干净 checkout（无 `node_modules`）或换一个 three 版本，读数就不是现在这个；' +
      '②第 ④/⑦ 面是**源码文本结构判据**（改写器的路由表、`index.ts` 里不再有裸 `new GLTFLoader(`）；③它守的接线（`packages/viewer/src/index.ts`、`draco-decoder.ts`、`ktx2-decoder.ts`）在清单登记后**又改过一次**（登记时 21,650 B / `509d3919f58698fa…` / 03:39:11；**本单读数窗口内它又改过两次**：03:43:26 的 22,219 B / `462484a066a54c3a…`、03:53:59 的 22,545 B / `4cf5c08a7cc1f86f…` —— 三次读数 pass/fail/expect 恰好都是 16/0/80，只是**字节**在动）⇒ 一条在 14 分钟里被改两次的用例，现在挂进门就是给一个还在长的交付物上锁；是否接线应由 viewer 那条 lane 连同"依赖第三方包字节"的口径一起交 Lead 定。' +
      '★**悬空引用（本单顺带处置）**：该文件第 39 行把"真机（真 Chrome + 真产品 host）的读数"指向 `bugfixHistory/KTX2-MESHOPT-WIRING-20260927.md` —— **那份回执不存在**；实际承载那份读数的是 `bugfixHistory/KTX2-AND-PRIVACY-20260927.md` §1.4（`sha256 d9520a6f6722d0d0…`、33,122 B、mtime 2026-09-27 03:43:06），本单已按"事后补写"补一份**指路回执**把这条引用接上（见 `bugfixHistory/WAIVERS2-AND-DANGLING-REFS-20260927.md` ② 与 `bugfixHistory/KTX2-MESHOPT-WIRING-20260927.md`）。' +
      '**本单独立读数**（三次复跑，bun 1.3.13，2026-09-27 03:51:4x 两次 + 04:0x 一次；文件静止：`sha256 4cf5c08a7cc1f86f…`、22,545 B、mtime 2026-09-27 03:53:59）：三次均 **16 pass / 0 fail / 80 expect**；静态站点 **59**。' +
      '（03:51 那两次落在 22,219 B / `462484a066a54c3a…` / mtime 03:43:26 那份字节上，读数与上面逐字相同 ⇒ 本条读数**对两次采样各自的 sha 负责**，不并成一个数。）' +
      '⚠️**这条读数依赖两个 blob，不是一个**：它还取决于被量对象 `packages/viewer/src/draco-decoder.ts`（viewer 唯一的 glTF 装载器工厂）。' +
      '该文件在 **2026-09-27 04:04:36** 被并发 lane 重写（现 `sha256 695defcff818baea…`、10,867 B）：**KTX2/meshopt 的挂载已不在 `createGltfLoader()` 里** —— 函数体现在只剩 `new GLTFLoader(manager).setDRACOLoader(draco)`，`renderer` 被 `void options` 丢掉（文件头仍自述"三件都挂上"，`INLINE_DECODER_ROUTES` 里也还列着 `KTX2_INLINE_ROUTE` ⇒ **注释与接线不一致**）。' +
      '⇒ 同一份用例文件（`4cf5c08a7cc1f86f…` 未变）上，现读 **10 pass / 6 fail**（2026-09-27 04:05–04:07 复核两次，同一读数；6 条红逐条点名：① 三条"装载器带 KTX2 + meshopt 解码器"+ ⑤ 两条真件解不出 + ⑥ 一条负对照）。' +
      '⇒ 所以上面那个 **16 pass / 0 fail / 80 expect 只对 04:04:36 之前**那份 `draco-decoder.ts` 负责。**这正好是本条不接进 CASES 的活证据**：接线对象在 14 分钟里被改两次、随后被当场整段切掉 ⇒ 挂进门就是给一个正在被另一条 lane 重写的对象冻结 `minPass`/`minAssert`/`minSites`。' +
      '**本单只登记，不修**（`packages/viewer/src/**` 不在本单写入域；按 §五"红点文件先看 mtime"：该文件 mtime 距本单读数 <60s ⇒ 标 `IN-FLIGHT`，不按点名文件派单）。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
  {
    path: 'packages/viewer/test/robot-glb-mesh.test.ts',
    reason:
      '机器人文档里的 `.glb` 网格：**登记得进依赖闭包、装载器分派建得出网格**（来源与施工者：`bugfixHistory/ROBOT-GLB-MESH-20260927.md`，该回执本单已核实**确实落在盘上**：`sha256 ca84c539eb373664…`、27,195 B、mtime 2026-09-27 03:53:24）。' +
      '两个根因各一处代码：`packages/scene-kit/src/formats.ts` 的登记闭包接受集（`.glb` 只满足"Viewer 装载器已接线"、**不假装** MuJoCo 支持）+ `packages/viewer/src/robot.ts` 的 glb 分支。真件不是合成夹具：`test/fixtures/robot-glb-mesh/banana.{xml,glb}` 是**未改一个字节**的真件拷贝。' +
      '**有意不接进 CASES**：①这条真件在**物理侧不成立** —— MuJoCo 3.13.0 对同一份文档实测 `no decoder found for mesh file \'…/banana.glb\'`（Element name \'banana_mesh\'）⇒ 它是**视觉专用**判据，门挂它只能守到视觉那半边，而"物理侧报错怎么给用户看"在那份回执 §8 里是**如实登记的未修项**；' +
      '②它守的两处产品码 `formats.ts` 与 `packages/viewer/src/robot.ts` 此刻都是 `M`（在飞）；③同族缺口未闭合：`.gltf`（JSON 形式）**没接线**、`packages/scene-kit/src/robot-visual-assets.ts` 的 `.glb` mime 映射**缺失**（该回执 §8 第 4/7 条如实登记、第 7 条明写"**需 Lead 派单**"）⇒ 缺口未闭合前不替该 lane 冻结下限。' +
      '**本单独立读数**（两次复跑，bun 1.3.13，2026-09-27 03:51:4x；文件静止：`sha256 3e22aeb093c1d54f…`、14,332 B、mtime 2026-09-27 03:34:16）：两次均 **14 pass / 0 fail / 45 expect**；静态站点 **41**。' +
      '残余洞口（如实登记）：不受本门 ratchet 保护；不在 131 条缺口里。',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 冻结基线（③/④）：下限与"没进门的用例数"都不许悄悄漂
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「清单 include 里发布门**不跑**的用例」的**冻结点**（GATE-MANIFEST-GAP 单，见 `evalManifestGap`）。
 *
 * 为什么不逐条列这 131 个路径（`MANIFEST_GAP_FROZEN.count`，2026-09-27 01:20 交付冻结）：
 * 这条判据要拦的是**变化**，而"条数 + 集合摘要"两件事就够把变化逼出来
 * （只冻条数 ⇒ "条数不变、成员换了一个"会溜过去；只冻摘要 ⇒ 丢掉"多少条"这个给人读的数字）。
 * 全量清单在每次读数的 `--json` 报告里（`manifestGap.notRun`），也在本轮回执里逐条登记。
 *
 * **同步方法**：判据判红时会把现算值直接印在点名行上，把 `{ count, digest }` 抄回来即可 ——
 * 那是一次**必须被 review 的改动**（"门又多了一条不跑的用例"不许悄悄发生）。
 */
export const MANIFEST_GAP_FROZEN: { count: number; digest: string; at: string } = {
  // 冻结时刻的实测（`manifestGateGap` + `manifestGapDigest`，见回执的复算命令）。
  // 2026-09-27T00:2x 首次冻结（121）；逐次重冻：00:12 → 113 / 00:30 → 121 / 00:40 → 125 / 01:05 → 129
  // / **01:20 → 131（交付值）**。清单在本轮被并行 lane 持续补登记，**这个数只会往上走**。
  count: 131,
  digest: '62127a5e1e71',
  at: '2026-09-27T01:20+0800',
}

/**
 * **④ 的冻结基线**（GATE-FLOOR-DRIFT 的第二半，2026-09-27 定版）：每条用例**实测通过数**的冻结点。
 *
 * ## 为什么 ③ 有冻结基线而 ④ 原来没有（同一份修复里的两种口径）
 *
 * ④ 原来只有"**下限 vs 本次实测**"的**相对比较** ⇒ 把实测压到下限即可消红：验收队实测
 * `minPass=15 / 实测=15 ⇒ GREEN`，也就是说"**先删用例、再把下限调到新实测**"这条路当时是通的
 * （验收报告 §4-X4）。根因不是判据写错，是**基线取的是运行时实测值本身** ⇒ "删用例"与"上调下限"
 * 在判据眼里长得一样（都把 `pass − minPass` 压到 0）。
 *
 * ⇒ 这里把**交付那一刻的实测通过数**冻进源码（与 `MANIFEST_GAP_FROZEN` 同一形状：`at` + `digest`
 * + 逐条值）。判定变成**有方向的 ratchet**：
 *
 * | 形状 | 判定 |
 * | --- | --- |
 * | 实测 `pass` **低于**冻结基线 | **RED** —— 有人删了用例/把用例改小（"先删用例"那条路被堵死） |
 * | 冻结基线 **低于** `minPass` | **RED** —— 基线没跟着下限一起抬（否则旧基线会变成天花板下的暗格） |
 * | 冻结基线里有、本次**一个读数都没有** | **RED** —— 用例被删/改名/从 `CASES` 里去掉 |
 * | 实测 `pass` **高于**基线 | 不判红 —— 那是收紧方向；它已由"下限低于实测"那条要求把下限一起抬 |
 * | 判绿但基线里没有（新增用例） | 只记 `unfrozen` 数（不判红：新增不缩减覆盖） |
 *
 * ## 冻结基准这一版的三条边界（如实登记）
 *
 * 1. 冻结时刻（`at`）**只有判绿的用例进基线**：当时自身红的 3 条（`engine-panel-decision` /
 *    `cua-input-single-flight` / `policy-source-github-quota`）**不在**基线里 ⇒ 它们的"删用例洗红"
 *    路径本次**不被拦**（它们一变绿就会进 `unfrozen` 计数，要纳入 ratchet 必须重冻）。
 * 2. 基线管的是**通过数**，看不见"删掉一条本来就红的用例"（通过数不变）——那是用例自身红的问题。
 * 3. `minAssert` / `minSites` **仍然不 ratchet**（理由见 `evalFloorDrift` 注释）：`assertGapReported`
 *    / `sitesGapReported` 只报数。
 *
 * **同步方法**：判红时点名行会把"该抬到多少"直接印出来；重冻 = 改这里的值与 `digest`（`at` 一起改），
 * 并且**必须是一次被 review 的改动** —— 缩减覆盖不许悄悄发生。
 */
export interface FloorBaseline {
  at: string
  /** 排序后逐行 `id=pass` 拼接的 sha256 前 12 位（与 `gate=`/`worktree=` 同一打印口径） */
  digest: string
  /** 冻结时刻**判绿**用例的实测通过数。`minPass` 是**下限**，这里是**实测值**：两者不许互相顶替。 */
  pass: Record<string, number>
}

export const FLOOR_BASELINE_FROZEN: FloorBaseline = {
  // 01:37 由并行 lane 重冻（68 条）；**01:52 由 GATE-CLOSER 同步 2 条**（`floor-drift` 又点了一次）：
  //   `test-ci-harness-cli` 28 → 33、`gpu-misdiagnosis-guard` 16 → 22 —— 与同一次被抬的 `minPass` 一致。
  //   **基线永远不许低于 `minPass`**（否则"先删用例"能藏在过期基线之上）。**只上调，没有下调。**
  //   ⚠️ 这两个文件此刻都还在被并行 lane 写（`gpu-misdiagnosis-guard` 一小时内 14 → 16 → 22），
  //   所以这两个数只对 01:52 那一刻负责；再动就由 `floor-drift` 点名。
  // CI-FIX 单（2026-09-27T15:24+0800）：随 4 条用例接进门，`pass` 追加这 4 条的实测通过数
  //   （15 / 13 / 5 / 13）、`digest` 由 `fd3a731eb4aa` 重算为 `8a80726afcff`（72 条，4 条新增、0 条删除）。
  // GATE-AB-20260927T17:00+0800：A（stdout/stderr 分离）与 B（硬件依赖去宿主化 + 冻结读数）落定后按
  //   **真实实测**重冻 7 条 `pass`（只上调，0 条删除）：capability-truth 11（不变，隔离后 11 pass）、
  //   gpu-device-hidden-notice 5 → 11、isaac-entry-lifecycle 7 → 8、gpu-misdiagnosis-guard 22 → 23、
  //   cua-input-single-flight 12 → 15、computer-use-input-scope 46 → 62、privacy-boundary 29 → 31。
  //   与同刻同步上调的 `minPass` 一一相等（基线不许低于下限）。digest 随 `pass` 重算。
  // 2026-09-28 主控按真实回归读数复核：五项新增覆盖只上调，既有条目不删不降。
  // 2026-09-29 Round3 floor audit：以下 10 项按独立零失败复跑的实测 pass 只上调。
  // 2026-09-29 Round7 privacy audit：新增 command/done、command/run 与递归 UI 三条纯合成隐私分支测试，
  // 隐私行为覆盖从 36 增至 39；据此只上调 privacy-boundary 与 baseline，session-history 仍保持完整 21/127/125。
  // 2026-09-30 A05主控：按同版完整发布门实测只上调routing，并冻结新增的9/10/18覆盖。
  // g19第8条有明确算法解释器前提；A06第三完整门da755425已真实8pass/29expect/0skip，只上调。
  // A06 2026-10-01：复用 floorBaselineDigest 对全部 87 条排序后的 id=pass 重算。
  // 八条新增门首批逐文件零失败、零 skip；主控 24d6e91 继续实跑搜索 10、点云 20，
  // 几何源新增 3 条纯测试同时纳入 CASES/manifest；其余旧基线不删不降，缺口冻结不扩张。
  // 主控 b58073b 再逐文件实跑物理状态/控件、口语选路、实例和发行回归，新增/增长只上调。
  // A08 Source a2f217f：同版全门九项新增行为按真实pass只上调；89项不删，SDK缺PY的skip不降门。
  // A08 发布登记：正式 harness 同版实跑新增侧面板 4/21/13、用户安装入口 12/63/57；原 89 项不删不降。
  at: '2026-10-02T10:42:30Z',
  digest: '8b69645315ac',
  // A07：仅上调场景生命周期8→11、上下文2→4；87项未删除，摘要同步实测冻结表。
  pass: {
  'app-side-panel-boundary': 4, 'linux-user-installer': 12,
  // A08 F5：新增gesture8 / pointer1，并按真实路由复测仅上调双会话12→13；其他冻结行原样保留。
  'manual-control-gesture': 8, 'manual-control-pointer': 1,
  'legacy-resource-source': 4,
  'domain-instance-projection': 5,
  'scene-world-lifecycle': 23,
  'scene-ptc-input': 1,
  'peiri-search-client': 10,
  'brand-welcome': 3,
  'flight-controller': 4,
  'physics-binding': 8,
  'geometry-source-contract': 3,
  'physics-state': 5,
  'physics-controls': 17,
  'environment-routing-selection': 14,

  'behavior-evidence': 5, 'blender-executable': 7, 'capability-truth': 11,
  'computer-use-input-scope': 62, 'conversation-history': 7, 'cua-input-single-flight': 16,
  'desktop-restart-recovery': 19, 'dev032-html-plan-wiring': 5, 'domain-pointer-rules-turn': 4,
  'engine-panel-decision': 11, 'engine-preference': 59, 'engine-selection-consistency': 6,
  'environment-readiness': 50, 'environment-routing': 96, 'episode-record-fields': 6, 'formal-model': 2,
  'g17-legacy-residue': 12, 'g19-building-robot-task': 2, 'g19-building-scale-animation': 8,
  'gate-drivers-mechanism': 29, 'gpu-device-hidden-notice': 11, 'gpu-misdiagnosis-guard': 23,
  'history-boundary': 5, 'host-projection-candidate': 9, 'html-preview-entry': 50,
  'isaac-entry-lifecycle': 8, 'isaac-orphan-close-failure': 3, 'isaac-startup-budget': 6,
  'isaac-startup-budget-entry': 7, 'isaac-startup-budget-wiring': 4, 'job-record-hunyuan': 11,
  'job-record-marble': 3, 'mamba-license': 25, 'migrate-workspace-layout': 11,
  'model-download-routing': 5, 'notification-no-replay': 3, 'open-cancel': 4,
  'operations-bounded-fetch': 36, 'pack-library-actions': 7, 'package-linux': 13, 'payload-contract': 19,
  'policy-source-bounded-fetch': 8, 'policy-source-github-quota': 39, 'portability': 11,
  'prepare-env-guard': 3, 'privacy-boundary': 41, 'provider-installer': 28, 'render-failure': 10,
  'runtime-patch': 26, 'scene-adapter-transform': 7, 'scene-kit-formats-mjcf-sections': 16,
  'scene-projection': 8, 'session-context-cross': 5, 'session-history': 26, 'session-launch': 30,
  'session-ownership-two-sessions': 13, 'share-export': 1, 'target-window': 7, 'terminal-options': 30,
  'test-ci-harness-cli': 33, 'unity-mcp': 11, 'viewer-projection-consumer': 19,
  'viewer-splat-support': 12, 'viewer-texture-and-autoframe': 30, 'vla-official-scene-binding': 6,
  'workbench-camera-initial-framing': 11, 'worker-robot-metadata': 11, 'worktree-snapshots': 5,
  // CI-FIX 单（2026-09-27）：随 4 条用例接进门**新增**的冻结基线（真实实测通过数，只增不减、不删除/不降低既有条目）。
  'computer-use-wording': 15, 'policy-archive-level3-wiring': 13,
  'policy-source-json-body-timeout-shape': 5, 'robot-glb-ktx2-texture': 13,
  'isaac-local-discovery': 9, 'viewer-first-person-speed': 15, 'viewer-splat-runtime': 20,
  },
}

/** 基线的集合摘要：**排序后逐行 `id=pass`** 的 sha256 前 12 位（与 `manifestGapDigest` 同一口径）。 */
export function floorBaselineDigest(pass: Record<string, number>): string {
  return sha256Hex(
    Object.keys(pass)
      .sort()
      .map((id) => `${id}=${pass[id]}`)
      .join('\n'),
  ).slice(0, 12)
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出解析（三个解析器都要认全：只认一种会把另一半读成 0，而 0 会被当成"干净"）
// ─────────────────────────────────────────────────────────────────────────────

export interface CaseCounts {
  pass: number
  fail: number
  skip: number
  /** 断言读数（bun 的 `N expect() calls`）；没有该行时退回 pass */
  assertions: number
  /** 读数来自哪种格式。`null` = **没有量到**，绝不当成 0 通过。 */
  format: 'bun-summary' | 'tap' | 'plain-cn' | null
  /** 记号行交叉核对：(pass)/(skip) 行数 vs 汇总行；不一致说明解析或输出被截断 */
  markerPass: number
  markerSkip: number
}

/**
 * 用例输出解析。三种形态都认：
 *  · bun:test     → ` 3 pass` / ` 0 fail` / ` 1 skip`（数在前）
 *  · node:test/TAP→ `# pass 4` / `# fail 0`（词在前）
 *  · plain 脚本   → 本仓约定 `PASS <name>` / `ok <name>` / `FAIL <name>` 逐行 + 收尾 `N/M 通过`
 * **一个都认不出 ⇒ format=null ⇒ UNPROVEN**。实测教训：把 plain 脚本按 `bun test` 跑，得到的是
 * exit 0 + 0 读数 —— 那是本仓最危险的一种假绿灯，不能算通过。
 */
export function parseCaseOutput(raw: string): CaseCounts {
  const counts: CaseCounts = { pass: 0, fail: 0, skip: 0, assertions: 0, format: null, markerPass: 0, markerSkip: 0 }
  const label = String.raw`(?:skipped|skip|pass|fail|todo)`
  const re = new RegExp(String.raw`^\s*#?\s*(?:(\d+)\s+(${label})|(${label})\s+(\d+))\s*$`, 'gim')
  let hit = false
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    hit = true
    const kind = (m[2] || m[3])!.toLowerCase()
    const n = Number(m[1] ?? m[4])
    if (kind === 'pass') counts.pass += n
    else if (kind === 'fail') counts.fail += n
    else counts.skip += n
  }
  if (hit) counts.format = /^\s*#\s*(?:pass|fail|skip)/im.test(raw) ? 'tap' : 'bun-summary'

  // plain 脚本的收尾行：`N/M 通过`（N=通过、M=总数）。与逐行记号交叉核对，不一致就不采信。
  const cn = /(\d+)\s*\/\s*(\d+)\s*通过/.exec(raw)
  if (cn) {
    const pass = Number(cn[1])
    const total = Number(cn[2])
    const linePass = (raw.match(/^(?:ok|PASS)\s/gm) || []).length
    const lineFail = (raw.match(/^(?:FAIL|not ok)\s/gm) || []).length
    if (linePass + lineFail === total && pass === linePass) {
      counts.pass = pass
      counts.fail = total - pass
      counts.skip = 0
      counts.format = 'plain-cn'
    } else if (counts.format === null) {
      // 收尾行与逐行记号对不上：宁可没读数，也不猜。
      counts.format = null
    }
  }

  const ex = /(\d+)\s+expect\(\)/.exec(raw)
  counts.assertions = ex ? Number(ex[1]) : counts.pass + counts.fail
  counts.markerPass = (raw.match(/^\((?:pass)\)/gm) || []).length
  counts.markerSkip = (raw.match(/^\((?:skip|todo)\)/gm) || []).length
  return counts
}

export interface PreflightReading {
  include: number
  exclude: number
  missing: number
  /** 纳入却缺件的**文件名**（只报数不够：`missing=1` 修不了，`missing=1（哪个文件）`才修得了） */
  missingNames: string[]
  unclassified: string[]
  configErrors: string[]
  runnerMismatch: string[]
  exit: number | null
}

/**
 * `bun run preflight`（=`script/test-ci.ts --list`）的读数。**两条独立读数必须互相印证**：
 *  · 收尾行 `# include=… exclude=… missing=…`
 *  · 逐行列表的行数（`test-ci.ts` 对每个清单条目恰好打一行：纳入 `RUN \t`、有意不跑 `SKIP\t`、
 *    纳入却缺件 `MISSING\t`）
 * 两者不一致 ⇒ 无读数：只认收尾行会把"列表少了一段"读成干净，只认行数会把"收尾行丢了"读成没量到。
 * **注意纳入行的 tag 是 `'RUN '`（RUN 后面有一个空格再接 tab，见 `test-ci.ts:446`）** ——
 * 按 `RUN\t` 数会恒得 0，把"整段列表都在"读成"一条都没有"（本单第一版探针就踩了这个）。
 */
export function parsePreflight(raw: string, exit: number | null): PreflightReading | null {
  const m = /^#\s*include=(\d+)\s+exclude=(\d+)\s+missing=(\d+)\s*$/m.exec(raw)
  if (!m) return null
  const lines = raw.split('\n')
  const pick = (tag: string) =>
    lines.filter((l) => l.startsWith(`${tag}\t`)).map((l) => l.slice(tag.length + 1).trim())
  const count = (tag: string) => lines.filter((l) => l.startsWith(`${tag}\t`)).length
  const listed = { include: count('RUN '), exclude: count('SKIP'), missing: count('MISSING') }
  if (listed.include !== Number(m[1]) || listed.exclude !== Number(m[2]) || listed.missing !== Number(m[3])) return null
  return {
    include: Number(m[1]),
    exclude: Number(m[2]),
    missing: Number(m[3]),
    // preflight 的原文形如 `MISSING\t已纳入但磁盘上没有：<path>`，把 `<path>` 取出来点名。
    missingNames: pick('MISSING').map((l) => l.replace(/^已纳入但磁盘上没有：/, '').trim()),
    unclassified: pick('UNCLASSIFIED').map((l) => l.replace(/^发现规则扫到但清单未覆盖：/, '').trim()),
    configErrors: [...pick('CONFIG-ERROR'), ...pick('RUNNER-MISMATCH')],
    runnerMismatch: pick('RUNNER-MISMATCH'),
    exit,
  }
}

export interface GateDriverReading {
  implementations: number
  withDriver: number
  withoutDriver: string[]
  exit: number | null
}

/**
 * `bun run gate:drivers --json` 的读数。**只从 stdout 取**（机器协议与诊断分离，GATE-AB-20260927）：
 * 真实调用里 JSON 在 stdout，而 `package.json` 脚本前缀 `[ -x "$npm_execpath" ] && …` 在 stderr；
 * 把两者拼起来按"第一个 `[` 到最后一个 `]`"解析会被 stderr 那对方括号切走 JSON 的收尾 ⇒ UNPROVEN。
 * 形参名保持 `raw` 以兼容既有纯函数调用（负对照直接把 stdout 原文喂进来），调用方传 `run.stdout`。
 * JSON 解不开 / 空 stdout ⇒ 无读数（不退回解析表格文本，也不拿 stderr 里的 `[` 兜底）。
 */
export function parseGateDrivers(raw: string, exit: number | null): GateDriverReading | null {
  const start = raw.indexOf('[')
  if (start < 0) return null
  let rows: unknown
  try {
    rows = JSON.parse(raw.slice(start, raw.lastIndexOf(']') + 1))
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const list = rows as { id?: string; implementation?: string; driver?: string | null }[]
  const without = list.filter((r) => !r.driver).map((r) => r.implementation ?? r.id ?? '?')
  return { implementations: list.length, withDriver: list.length - without.length, withoutDriver: without, exit }
}

/**
 * `gate:drivers（门必须有驱动）` 判据：**读数解不开 ⇒ UNPROVEN；解开了但 exit≠0 / 实现 0 个 /
 * 有缺驱动 ⇒ RED；只有三个条件同时成立才 GREEN**。
 *
 * 为什么单列成导出函数（GATE-AB-20260927）：`execCriteria` 里它原来是一段内联分支，只有"解不开"
 * 与"解开"两支被 `runPackageScript` 真跑才碰得到，**"无驱动仍 RED"这一支没有可直接驱动的负对照**。
 * 拆出来后 `script/release-gate.test.ts` 能用合成读数把三态（UNPROVEN / RED / GREEN）逐条钉住，
 * 而不必真造一棵缺驱动的树（那条真夹具在 `script/gate-drivers.test.ts` 里另有覆盖）。
 */
export function evalGateDriversCriterion(
  g: GateDriverReading | null,
  exit: number | null,
  ms: number,
  stdout: string,
  stderr: string,
  infra?: string,
): CriterionResult {
  if (!g) {
    const stdoutHead = stdout.trim().slice(0, 200) || '(空)'
    const stderrHead = stderr.trim().slice(0, 200)
    return {
      id: 'gate-drivers',
      title: 'gate:drivers（门必须有驱动）',
      status: 'UNPROVEN',
      metrics: { exit: exit ?? -1, ms },
      findings: [
        `gate:drivers --json 的 **stdout** 解不开 ⇒ 无读数（stderr 只作诊断，不参与机器解析）；` +
          `exit=${String(exit)}${infra ? ` infra=${infra}` : ''}；stdout 前 200 字：${stdoutHead}` +
          (stderrHead ? `；stderr 前 200 字：${stderrHead}` : ''),
      ],
      waivers: [],
    }
  }
  return {
    id: 'gate-drivers',
    title: 'gate:drivers（门必须有驱动）',
    status: g.exit === 0 && g.implementations > 0 && g.withoutDriver.length === 0 ? 'GREEN' : 'RED',
    metrics: {
      implementations: g.implementations,
      withDriver: g.withDriver,
      withoutDriver: g.withoutDriver.length,
      exit: g.exit ?? -1,
    },
    findings: [
      ...g.withoutDriver.map((x) => `NO-DRIVER：${x} 只能直接跑实现文件（那会空转 exit 0）`),
      ...(g.implementations === 0 ? ['实现 0 个：这条"通过"没有内容'] : []),
    ],
    waivers: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// env-self-link-guard：退化链接只读守卫（SELFLINK-READONLY-GUARD-20260926）
// ─────────────────────────────────────────────────────────────────────────────
//
// 判据来自 P10（`bugfixHistory/UPSTREAM-SELFLINK-INVENTORY-20260926.md` §5-C 的"新增一条只读守卫"），
// **作用域按 V15 §B.1 的实测扩大**（`bugfixHistory/VERIFY-P10-UPSTREAM-20260926.md`：同形状的链在
// `.upstream` 之外现场复现过）+ **Lead 裁决**：从 `.upstream` 扩到所有"按依赖清单 materialize 出来的
// `node_modules` 落点"。判据原文 = P10 用过的 D2：`realpath(L) === realpath(dirname(L))`。
//
// **为什么这条判据不以"命中就 RED"的形式接进门**（这是有意的，不是漏了）：
// 它量的是**环境**（开发检出里的链接形状），不是产品产物。把"邻居 lane 正在造负对照链"变成发布门判红，
// 会让门在**被测量的东西一个字没变**的情况下变红 —— 那不是判据，那是噪声。所以本条的绿/红判的是
// **"这次量到了没有"**（有读数 = GREEN，`find` 起不来 / JSON 解不开 = UNPROVEN），
// 而**两类退化链接的条数原样进 `metrics`**，一个都不许省：门要防的正是"只报一个数 ⇒ 得出相反结论"。
//
// 想让它 fail-closed 的人走 `--strict`（脚本自己支持，类 1 命中即 exit 1）；别在这里偷偷改语义。
export interface SelfLinkReading {
  links: number
  selfReferential: number
  dangling: number
  byScope: { scope: string; links: number; selfReferential: number }[]
  grid: { root: string; maxdepth: number; cycleDiagnosticLines: number; withinScanSurface: boolean }[]
  gridUnproven: boolean
  scanOk: boolean
  /** 类 1 的逐条路径（点名用）。 */
  hits: string[]
  ms: number
}

/** `bun run script/env-self-link-guard.ts --json` 的读数。JSON 解不开 ⇒ 无读数（不退回解析文本）。 */
export function parseSelfLinkGuard(raw: string, exit: number | null): SelfLinkReading | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let j: unknown
  try {
    j = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1))
  } catch {
    return null
  }
  const o = j as {
    scanOk?: unknown
    tool?: unknown
    totals?: { links?: unknown; selfReferential?: unknown; dangling?: unknown }
    scopes?: { root?: unknown; links?: unknown; selfReferential?: unknown }[]
    grid?: { root?: unknown; maxdepth?: unknown; cycleDiagnosticLines?: unknown; withinScanSurface?: unknown; error?: unknown }[]
    gridUnproven?: unknown
    hits?: { path?: unknown }[]
    ms?: unknown
  }
  if (o.tool !== 'env-self-link-guard' || o.totals === undefined || !Array.isArray(o.scopes)) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : -1)
  return {
    links: n(o.totals.links),
    selfReferential: n(o.totals.selfReferential),
    dangling: n(o.totals.dangling),
    byScope: o.scopes.map((s) => ({ scope: String(s.root ?? '?'), links: n(s.links), selfReferential: n(s.selfReferential) })),
    grid: (o.grid ?? []).map((g) => ({
      root: String(g.root ?? '?'),
      maxdepth: n(g.maxdepth),
      cycleDiagnosticLines: n(g.cycleDiagnosticLines),
      withinScanSurface: g.withinScanSurface === true,
    })),
    gridUnproven: o.gridUnproven === true,
    scanOk: o.scanOk === true,
    hits: (o.hits ?? []).map((h) => String(h.path ?? '?')),
    ms: n(o.ms),
  }
}

/**
 * 判据：退化链接只读守卫。**有读数 = GREEN**（命中不退门，命中进数字与点名）；无读数 = UNPROVEN。
 * `--strict` 故意**不用**：见上面那段"为什么这条判据不以命中就 RED 的形式接进门"。
 */
export function evalSelfLinkCriterion(raw: string, exit: number | null, ms: number, capture: 'file' | 'pipe'): CriterionResult {
  const title = 'env-self-link-guard（退化链接只读守卫：D2 自指 与 pnpm 网格互指 分开报）'
  const g = parseSelfLinkGuard(raw, exit)
  if (!g || !g.scanOk) {
    return {
      id: 'env-self-link-guard',
      title,
      status: 'UNPROVEN',
      metrics: { exit: exit ?? -1, ms, capture, scanOk: g === null ? -1 : 1 },
      findings: [
        `${g === null ? '--json 解不开' : '扫描根一个都读不到（node_modules 与 .upstream 都不存在）'} ⇒ 无读数（不拿"没量到"冒充"没有退化链接"）；exit=${String(exit)}；输出前 200 字：${raw.trim().slice(0, 200) || '(空)'}`,
      ],
      waivers: [],
    }
  }
  const unprovenGrid = g.grid.filter((x) => x.cycleDiagnosticLines < 0)
  return {
    id: 'env-self-link-guard',
    title,
    status: 'GREEN',
    metrics: {
      links: g.links,
      selfReferential: g.selfReferential,
      dangling: g.dangling,
      gridRoots: g.grid.length,
      gridDiagnostics: g.grid.reduce((n2, x) => n2 + Math.max(0, x.cycleDiagnosticLines), 0),
      gridUnproven: unprovenGrid.length,
      exit: exit ?? -1,
      ms,
      capture,
    },
    findings: [
      // 逐条点名（类 1 每条一个路径）。这是"命中时用户看到什么"的门内那一半。
      ...g.hits.map((p) => `SELF-REFERENTIAL：${p}（realpath(链) === realpath(父目录) ⇒ 相对目标为空串；**只报告，不自动删**）`),
      ...g.byScope.map(
        (s) => `作用域 ${s.scope}：链 ${s.links} 条，其中自指链 ${s.selfReferential} 条`,
      ),
      ...g.grid.map(
        (x) =>
          `类 2 网格互指 ${x.root} -maxdepth ${x.maxdepth}：环诊断 ${x.cycleDiagnosticLines < 0 ? '无读数' : `${x.cycleDiagnosticLines} 行`}${x.withinScanSurface ? '' : '（不在扫描面内，只作复算参照）'}`,
      ),
      ...(g.selfReferential === 0
        ? ['类 1 = 0 ⇒ 无自指链；**这不等于"环境基本干净"** —— 类 2（网格互指）的条数见上面那几行。']
        : []),
      ...unprovenGrid.map((x) => `类 2 在 ${x.root} 无读数（find 没起来/超时）⇒ 不写成 0`),
    ],
    waivers: [
      '本判据只量环境形状，**命中不改裁决**（环境读数不是产品缺陷）；要 fail-closed 请用 `--strict`，不要在这里改语义。',
      '类 2 的每一格都是 `-maxdepth N` 的**下界**，引用时必须连 maxdepth 一起写。',
    ],
  }
}

export interface TscReading {
  errors: number
  files: number
  /** 出错文件（去重，供点名） */
  errorFiles: string[]
  exit: number | null
}

/**
 * `tsc -p <cfg> --listFiles` 的读数。`--listFiles` 只是让"检查了多少文件"变成可读数字，
 * **不改编译语义**（同一配置下 error 集合与不加该开关一致，本单实测过）。
 * files=0（例如 tsc 根本没起来）⇒ 无读数 ⇒ UNPROVEN。
 */
export function parseTscOutput(raw: string, exit: number | null, root: string): TscReading | null {
  const lines = raw.split('\n')
  const errLines = lines.filter((l) => /\berror TS\d+/.test(l))
  // 数"检查了多少文件"时要把诊断行排除掉：诊断行也以 root 开头（`<path>(3,1): error TS…`），
  // 不排除就会把错误数加进文件数里 —— 那正好是"读数被自己污染"的一种。
  const files = lines.filter((l) => l.startsWith(root + '/') && !/\(\d+,\d+\):\s*(?:error|warning)/.test(l)).length
  if (files === 0 && errLines.length === 0) return null
  const errorFiles = [...new Set(errLines.map((l) => l.split('(')[0]!.trim()))].filter(Boolean).slice(0, 20)
  return { errors: errLines.length, files, errorFiles, exit }
}

/**
 * `tsc-*` 判据的判定（**纯函数**，见下为什么必须能单独驱动）。
 *
 * ## 为什么判定式里必须有退出码（GATE-TSC-EXIT-CODE 单）
 *
 * 改前的判定式是 `t.errors === 0 && t.files > 0 ? 'GREEN' : 'RED'` —— **只看输出文本，不看退出码**。
 * 而 `tsc -p … --listFiles` 的文件清单是在**类型检查之前**就写出去的，于是：
 *
 * ```
 * 喂 (文件列表 + "FATAL ERROR: Reached heap limit …", exit=null)
 *   ⇒ parseTscOutput ⇒ {errors:0, files:2, exit:null}
 *   ⇒ 旧判定式 ⇒ **GREEN**（metrics 里只留一个 exit=-1，没人看）
 * ```
 *
 * 真实形状：3232 个文件的闭包并不小，V8 OOM / 被 OOM killer `SIGKILL` / 被超时掐断时，
 * 子进程**根本没有退出码**（`code===null`、`infra===undefined`、只有 `signal` 说得清），
 * stderr 里一条 `error TS` 都没有 ⇒ 一个"崩了但没报错"的形状被读成**编译通过**。
 * 那正是本门开头第 1 条要防的假绿灯，所以这里与 `preflight` / `gate-drivers` 取**同一口径**：
 * **`exit !== 0` ⇒ 不许判绿**（不是 UNPROVEN，是 RED —— 与另外两条结构性判据一致）。
 *
 * **导出**：负对照要能直接喂"OOM 形状"的读数，而不是让测试自己重抄一遍判定式
 * （抄一遍只能证明"我抄对了"，证明不了"门是这么判的"）。
 */
export function evalTscCriterion(id: string, title: string, t: TscReading, ms: number, signal: string | null): CriterionResult {
  const crashed = t.exit !== 0
  return {
    id,
    title,
    status: crashed || t.errors > 0 || t.files === 0 ? 'RED' : 'GREEN',
    metrics: { errors: t.errors, files: t.files, exit: t.exit ?? -1, signal: signal ?? '-', ms },
    findings: [
      ...(t.errors > 0 ? [`${t.errors} 条 error TS，涉及 ${t.errorFiles.length} 个文件：`, ...t.errorFiles.map((f) => `  ${f}`)] : []),
      // "崩溃假绿"这条**只在"退出码非 0 且一条 error TS 都没有"时**才写：那正是改前会被读成绿的形状
      // （`exit` 非 0 但**有** error TS 时，红的原因就是那些错误，别用"崩溃"盖住它）。
      ...(crashed && t.errors === 0
        ? [
            `tsc 退出码非 0（exit=${t.exit === null ? 'null' : t.exit}${signal ? `，signal=${signal}` : ''}）` +
              `却**一条 error TS 都没有** ⇒ **崩溃假绿**的形状：` +
              (t.exit === null
                ? '拿不到退出码（被信号杀死 / 被超时掐断 / 起进程失败）⇒ `--listFiles` 的清单已经打出来了，但**编译闭包没有被量到**。'
                : '编译器自己报了失败却没有诊断 ⇒ 编译闭包没有被量到。') +
              `不许判绿：先查 OOM（V8 heap）/ 信号 / 超时，再判"编译通过"。`,
          ]
        : []),
      ...(crashed && t.errors > 0
        ? [`（退出码 exit=${t.exit === null ? 'null' : t.exit}${signal ? `，signal=${signal}` : ''} 与上面 ${t.errors} 条 error TS 一致：这是普通编译失败，不是"崩溃假绿"。）`]
        : []),
      ...(t.files === 0 ? [`文件数 0 ⇒ 这条"通过"没有内容`] : []),
    ],
    waivers: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定模型
// ─────────────────────────────────────────────────────────────────────────────

export type Status = 'GREEN' | 'RED' | 'UNPROVEN'

export interface CriterionResult {
  id: string
  title: string
  status: Status
  /** **该判据独有的数字**。空 ⇒ gate-selfcheck 判它为"没数字的通过"。 */
  metrics: Record<string, number | string>
  /** 点名的行（红/未证的直接原因，精确到用例或文件） */
  findings: string[]
  /** 登记在案、不算通过的豁免（如按设计被环境门控的 skip） */
  waivers: string[]
}

export interface CaseReading {
  spec: CaseSpec
  /** 真跑了吗；没跑（例如用例文件不存在）时为 false */
  ran: boolean
  exit: number | null
  counts: CaseCounts
  /** 静态断言站点数（`expect(`/`assert(`/`check(` 出现次数） */
  staticSites: number
  ms: number
  /** 起进程失败/超时等人为原因 */
  infra?: string
}

export const CASE_STATUS = ['GREEN', 'RED', 'UNPROVEN'] as const
export type CaseStatus = (typeof CASE_STATUS)[number]

/**
 * 单条用例的判定。**每一条非绿都要说出是哪一条、差多少**。
 * 顺序即优先级：先"没读数"，再"真红"，再"低于下限"。
 */
export function evalCase(r: CaseReading): { status: CaseStatus; finding?: string; note: string } {
  const s = r.spec
  const c = r.counts
  if (!r.ran) return { status: 'UNPROVEN', finding: `${s.id} 未跑：${r.infra ?? '用例文件缺失'}`, note: 'no-run' }
  if (r.infra) return { status: 'UNPROVEN', finding: `${s.id} 起进程失败：${r.infra}`, note: 'infra' }
  if (r.exit === null) return { status: 'UNPROVEN', finding: `${s.id} 拿不到退出码`, note: 'no-exit' }
  if (c.format === null)
    return {
      status: 'UNPROVEN',
      finding: `${s.id} 产出不了读数：输出既不是 bun 汇总/TAP，也不是 plain 的 \`N/M 通过\`（exit=${r.exit}）——「跑完没读数」不算通过`,
      note: 'no-reading',
    }
  // 汇总行与逐条记号行必须互相印证：对不上说明解析错或输出被截断，宁可不判也不猜。
  if (c.format === 'bun-summary' && c.markerPass > 0 && (c.markerPass !== c.pass || c.markerSkip !== c.skip))
    return {
      status: 'UNPROVEN',
      finding: `${s.id} 汇总行与记号行不一致：汇总 pass=${c.pass} skip=${c.skip}，记号 (pass)=${c.markerPass} (skip)=${c.markerSkip} —— 读数不可信`,
      note: 'cross-check',
    }
  if (r.exit !== 0 || c.fail > 0)
    return { status: 'RED', finding: `${s.id} 实测失败：exit=${r.exit} fail=${c.fail}（${s.path}）`, note: `fail=${c.fail}` }
  if (c.pass < s.minPass)
    return { status: 'RED', finding: `${s.id} 通过数低于冻结下限：pass=${c.pass} < minPass=${s.minPass}（${s.path}）`, note: 'pass-floor' }
  if (c.assertions < s.minAssert)
    return { status: 'RED', finding: `${s.id} 断言读数低于冻结下限：assert=${c.assertions} < minAssert=${s.minAssert}`, note: 'assert-floor' }
  const skipOver = c.skip - (s.waiveSkip ?? 0)
  if (skipOver > 0)
    return { status: 'RED', finding: `${s.id} 有未登记的 skip=${skipOver}（skip 不是通过；要么修好，要么在表里写明理由）`, note: 'skip' }
  return { status: 'GREEN', note: c.skip > 0 ? `pass=${c.pass} +skip=${c.skip}(登记)` : `pass=${c.pass}` }
}

export function evalTheme(theme: Theme, readings: CaseReading[]): CriterionResult {
  const mine = readings.filter((r) => r.spec.theme === theme)
  const evald = mine.map((r) => ({ r, e: evalCase(r) }))
  const green = evald.filter((x) => x.e.status === 'GREEN')
  const red = evald.filter((x) => x.e.status === 'RED')
  const unproven = evald.filter((x) => x.e.status === 'UNPROVEN')
  const sum = (f: (r: CaseReading) => number) => mine.reduce((a, r) => a + f(r), 0)
  const status: Status = red.length > 0 ? 'RED' : unproven.length > 0 ? 'UNPROVEN' : 'GREEN'
  return {
    id: `regression.${theme}`,
    title: `本轮回归用例 · ${THEME_TITLES[theme]}`,
    status,
    metrics: {
      cases: `${green.length}/${mine.length}`,
      pass: `${sum((r) => r.counts.pass)}/${sum((r) => r.spec.minPass)}`,
      assert: `${sum((r) => r.counts.assertions)}/${sum((r) => r.spec.minAssert)}`,
      skip: sum((r) => r.counts.skip),
    },
    findings: [...red, ...unproven].map((x) => x.e.finding!).filter(Boolean),
    waivers: evald
      .filter((x) => x.e.status === 'GREEN' && x.r.counts.skip > 0)
      .map((x) => `${x.r.spec.id}: ${x.r.spec.waiveSkipReason ?? '已登记 skip'}`),
  }
}

/**
 * 终态语义 vs 声明：回执自己写下的读数，是回执对交付物的**声明**。
 * 实测 < 声明 ⇒ 红并点名（回执说了、代码里对不上，是验收手第一类问题）。
 * 实测 > 声明 ⇒ 绿（覆盖长上去了），读数里标 `+N`。
 */
export function evalClaimConsistency(readings: CaseReading[]): CriterionResult {
  const declared = readings.filter((r) => r.spec.claimPass !== undefined)
  // **只核对"量到了"的那些**：用例没产出读数时，回执的声明既没被证实也没被推翻 —— 那是 UNPROVEN，
  // 不能算作"声明与终态不一致"（否则一个跑不起来的用例会被记成两次红，掩盖真原因）。
  const claimed = declared.filter((r) => r.counts.format !== null)
  const short = claimed.filter((r) => r.counts.pass < r.spec.claimPass!)
  const grew = claimed.filter((r) => r.counts.pass > r.spec.claimPass!)
  return {
    id: 'claim-consistency',
    title: '回执声明 vs 实测（终态语义与声明一致）',
    status: short.length > 0 ? 'RED' : claimed.length === 0 ? 'UNPROVEN' : 'GREEN',
    metrics: {
      declared: declared.length,
      comparable: claimed.length,
      ok: claimed.length - short.length,
      shortfall: short.length,
      grew: grew.length,
    },
    findings: short.map(
      (r) => `${r.spec.id} 回执声明 pass=${r.spec.claimPass}，实测 pass=${r.counts.pass}（差 ${r.spec.claimPass! - r.counts.pass}）—— 回执与终态对不上，需回执作者说明是删了用例还是写错了数（${r.spec.path}）`,
    ),
    waivers: grew.map((r) => `${r.spec.id}: 声明 ${r.spec.claimPass}，实测 ${r.counts.pass}（+${r.counts.pass - r.spec.claimPass!}）`),
  }
}

/** 文件自己 import 的测试 API（不认执行器）。用来核对表里的 runner 与文件实际形态一致。 */
export function detectRunnerStyle(source: string, path: string): 'bun:test' | 'node:test' | 'plain' {
  if (/\.py$/i.test(path)) return 'plain'
  if (/\bfrom\s*['"]bun:test['"]|\brequire\(\s*['"]bun:test['"]/.test(source)) return 'bun:test'
  if (/\bfrom\s*['"]node:test['"]|\brequire\(\s*['"]node:test['"]/.test(source)) return 'node:test'
  return 'plain'
}

export function countAssertSites(source: string): number {
  return (source.match(/\bexpect\(|\bassert\.|\bassert\(|\bcheck\(/g) || []).length
}

/** 每条用例自身的静态健全性：在盘上 / runner 与文件形态一致 / 断言站点不低于下限。 */
export function evalCaseIntegrity(readings: CaseReading[], root: string): CriterionResult {
  const missing: string[] = []
  const runnerBad: string[] = []
  const sitesBad: string[] = []
  for (const r of readings) {
    const s = r.spec
    const full = resolve(root, s.path)
    if (!existsSync(full)) {
      missing.push(`${s.id} 表里有、磁盘上没有：${s.path}`)
      continue
    }
    const source = readFileSync(full, 'utf8')
    const detected = detectRunnerStyle(source, s.path)
    const expectPlain = s.runner === 'plain'
    if (expectPlain !== (detected === 'plain'))
      runnerBad.push(`${s.id} 表声明 runner=${s.runner}，文件形态=${detected}（${s.path}）—— 执行器选错会得到空转的 exit 0`)
    if (r.staticSites < s.minSites)
      sitesBad.push(`${s.id} 静态断言站点 ${r.staticSites} < 冻结下限 ${s.minSites}（${s.path}）—— 断言被删/被掏空`)
  }
  const findings = [...missing, ...runnerBad, ...sitesBad]
  return {
    id: 'case-integrity',
    title: '用例自身健全（在盘上 / 执行器正确 / 断言站点不缩水）',
    status: findings.length > 0 ? 'RED' : readings.length === 0 ? 'UNPROVEN' : 'GREEN',
    metrics: {
      cases: readings.length,
      exists: readings.length - missing.length,
      runnerOk: readings.length - runnerBad.length,
      sitesOk: readings.length - sitesBad.length,
      ciRun: readings.filter((r) => r.spec.ci === 'run').length,
      ciNotRun: readings.filter((r) => r.spec.ci === 'not-run').length,
      ciUnregistered: readings.filter((r) => r.spec.ci === 'unregistered').length,
    },
    findings,
    waivers: [],
  }
}

/** skip 永不算通过：把 skip 单独记账，未被登记的 skip 直接红。 */
export function evalSkipAccounting(readings: CaseReading[]): CriterionResult {
  const skips = readings.reduce((a, r) => a + r.counts.skip, 0)
  const waived = readings.reduce((a, r) => a + Math.min(r.counts.skip, r.spec.waiveSkip ?? 0), 0)
  const over = readings
    .filter((r) => r.counts.skip > (r.spec.waiveSkip ?? 0))
    .map((r) => `${r.spec.id}: skip=${r.counts.skip}，登记豁免=${r.spec.waiveSkip ?? 0}`)
  return {
    id: 'skip-accounting',
    title: 'skip 记账（skip 不是通过）',
    status: over.length > 0 ? 'RED' : 'GREEN',
    metrics: { skips: skips, waived: waived, unwaived: skips - waived },
    findings: over,
    waivers: readings
      .filter((r) => r.counts.skip > 0)
      .map((r) => `${r.spec.id}: skip=${r.counts.skip} —— ${r.spec.waiveSkipReason ?? '未登记理由（应判红）'}`),
  }
}

export interface CoverageInput {
  /** 由工作树 + 本轮回执反查出的候选（相对路径，已按"磁盘上存在"过滤） */
  derived: string[]
  /** 门里真接上的用例路径（重点回归表 `CASES`，本次实跑） */
  declared: string[]
  /**
   * 本次**同一次运行里**完整离线 CI（`script/test-ci.ts` 默认集）**实跑成功**的 include 路径
   * （GATE-C-20260927）。缺省 `[]` ⇒ 本次没有执行证据：**不得**把"清单里有"当成"跑过了"。
   */
  offlineExecuted?: string[]
  /** 清单里已知的路径 → 是否纳入 CI */
  manifest: Map<string, 'include' | 'exclude'>
  /**
   * 清单里 `exclude` 条目的理由。有理由的显式排除归"外部验收/未运行"（不是 drift、也不算通过）；
   * 没有理由的排除判红。缺省 ⇒ 所有 exclude 都按"没写理由"处理。
   */
  excludeReasons?: Map<string, string>
  /** 回执引用过、磁盘上却没有的路径（改名/删除留下的旧引用） */
  staleCitation: string[]
  /** 显式声明"有意不接"的候选（理由为空 ⇒ 判红：空理由等于静默漏掉） */
  waivers: readonly { path: string; reason: string }[]
}

/** 候选的逐类归属（GATE-C）：每个候选只进一类，各类合起来 = `derived`。 */
export interface CoverageAttribution {
  /** 重点回归（`CASES`）本次实跑覆盖 */
  declared: string[]
  /** 本次完整离线 CI 实跑**成功**覆盖 */
  offlineExecuted: string[]
  /** 既有审查豁免（`COVERAGE_WAIVERS`，有意不接进门） */
  waived: string[]
  /** 清单显式 `exclude` 且给了外部条件理由（归"外部验收/未运行"，不计通过） */
  externalExcluded: string[]
  /** 清单 `exclude` 却没写理由 ⇒ 判红 */
  excludeNoReason: string[]
  /** 清单 `include`、本次该跑却没实跑成功（失败/超时/缺件/没执行）⇒ 判红 */
  drift: string[]
  /** 清单里根本没有（那条红归 `preflight` 的 UNCLASSIFIED，这里只报数） */
  unregistered: string[]
}

/**
 * 集合反查的**归属**计算（纯函数，`evalCoverage` 与 `--json` 报告共用同一份判定）。
 *
 * 每个候选按固定优先级只落一类：重点回归实跑 > 既有审查豁免 > 本次完整离线 CI 实跑成功 >
 * 清单显式外部排除 > 其余（include 未跑成功 = drift；清单没有 = unregistered）。
 * 全量实际 CI 执行另由 `offline-ci` 记录（本函数只做归属，不在这里重复计）。
 * **文档里提到过不等于跑过**：旧回执引用只能把候选带进来，是否算覆盖只看本次有没有实跑成功。
 */
export function coverageAttribution(input: CoverageInput): CoverageAttribution {
  const declared = new Set(input.declared)
  const offline = new Set(input.offlineExecuted ?? [])
  const waiver = new Map(input.waivers.map((w) => [w.path, w.reason]))
  const out: CoverageAttribution = {
    declared: [],
    offlineExecuted: [],
    waived: [],
    externalExcluded: [],
    excludeNoReason: [],
    drift: [],
    unregistered: [],
  }
  for (const p of input.derived) {
    if (declared.has(p)) {
      out.declared.push(p)
      continue
    }
    // 豁免优先于"本次离线实跑"：`COVERAGE_WAIVERS` 表达的是"**有意不接进 CASES**"，
    // 一条已经豁免的路径被 CI 顺带跑到，并不改变"它不在重点回归表"这件事。
    // （它到底有没有跑，由 `offline-ci` 与 `manifest-gate-gap` 各自如实报，不在这里重复计。）
    if (waiver.has(p)) {
      out.waived.push(p)
      continue
    }
    if (offline.has(p)) {
      out.offlineExecuted.push(p)
      continue
    }
    const decision = input.manifest.get(p)
    if (decision === 'exclude') {
      if ((input.excludeReasons?.get(p) ?? '').trim()) out.externalExcluded.push(p)
      else out.excludeNoReason.push(p)
      continue
    }
    if (decision === 'include') {
      out.drift.push(p)
      continue
    }
    out.unregistered.push(p)
  }
  return out
}

/**
 * 集合反查（机制 3）：用例集合不许凭印象列。
 * 派生 = `git status` 里的 test-like 文件 ∪ 本轮 `bugfixHistory/*-<ROUND>.md` 里出现的 test-like 路径，
 * 再按"磁盘上存在"过滤。
 *
 * **drift 判红**：清单判 `include`，但**本次没有实跑成功**（重点回归实跑 / 本次完整离线 CI 实跑都算不上）。
 * 旧文档引用本身**不是**通过理由 —— 它只负责把候选带进来。
 * **unregistered 只报数**：那条红归 `preflight` 的 UNCLASSIFIED，不重复计。
 * **`GREEN` 的语义**（GATE-C）：本门范围内的候选都有明确归属，**不等于**外部功能全部验收通过。
 */
export function evalCoverage(input: CoverageInput): CriterionResult {
  const a = coverageAttribution(input)
  const emptyReason = input.waivers.filter((w) => !w.reason.trim()).map((w) => w.path)
  const bad = a.drift.length + a.excludeNoReason.length + emptyReason.length
  return {
    id: 'caseset-coverage',
    title: '用例集合反查（工作树 + 本轮回执 → 重点实跑 / 离线CI实跑 / 显式排除 / 豁免 的归属）',
    status: bad > 0 ? 'RED' : input.derived.length === 0 ? 'UNPROVEN' : 'GREEN',
    metrics: {
      derived: input.derived.length,
      declared: a.declared.length,
      offlineExecuted: a.offlineExecuted.length,
      drift: a.drift.length,
      waived: a.waived.length,
      externalExcluded: a.externalExcluded.length,
      excludeNoReason: a.excludeNoReason.length,
      unregistered: a.unregistered.length,
      staleCitation: input.staleCitation.length,
    },
    findings: [
      ...a.drift.map(
        (p) =>
          `DRIFT：${p} 在本轮候选集里、清单判 include，但**本次没有实跑成功** —— 必须真跑通过` +
          `（重点回归实跑 / 本次完整离线 CI 实跑），或写进 COVERAGE_WAIVERS 并给出理由。` +
          `**旧文档引用过不算覆盖**`,
      ),
      ...a.excludeNoReason.map((p) => `EXCLUDE-NO-REASON：${p} 在清单里判 exclude 却没有理由 —— 无理由的排除等于静默漏掉`),
      ...emptyReason.map((p) => `WAIVER-NO-REASON：${p} 写了豁免但没写理由 —— 无理由的豁免等于静默漏掉`),
      ...a.unregistered.map((p) => `UNREGISTERED：${p} 不在 CI 清单里（该红由 preflight 的 UNCLASSIFIED 判，这里只报数）`),
      ...input.staleCitation.map(
        (p) => `STALE-CITATION：${p} 被本轮回执引用过但磁盘上已不存在（改名/删除留下的旧引用；不判红，保留为历史提示）`,
      ),
    ],
    waivers: [
      ...(a.offlineExecuted.length > 0
        ? [
            `本次完整离线 CI 实跑成功覆盖 ${a.offlineExecuted.length} 条（不是"清单里有"；全量见 --json 的 coverageAttribution.offlineExecuted）` +
              `：${a.offlineExecuted.slice(0, 5).join(' / ')}${a.offlineExecuted.length > 5 ? ` …（共 ${a.offlineExecuted.length} 条）` : ''}`,
          ]
        : []),
      ...(a.externalExcluded.length > 0
        ? [
            `清单显式 exclude（外部条件）${a.externalExcluded.length} 条 ⇒ 归"外部验收/未运行"，**不计通过**` +
              `（全量见 --json 的 coverageAttribution.externalExcluded）：${a.externalExcluded.slice(0, 5).join(' / ')}${a.externalExcluded.length > 5 ? ` …（共 ${a.externalExcluded.length} 条）` : ''}`,
          ]
        : []),
      ...input.waivers
        .filter((w) => a.waived.includes(w.path))
        .map((w) => `${w.path}：既有审查豁免、有意不接进门 —— ${w.reason}`),
      'GREEN 只说明"本门范围内的候选都有明确归属"（重点回归实跑 + 本次完整离线 CI 实跑 + 显式外部排除 + 既有审查豁免）；' +
        '它**不等于**外部功能全部验收通过（真机/图形/GPU/账户/打包不在本门内）。',
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// offline-ci：同一次运行里真跑 `script/test-ci.ts` 完整默认集，按 --json 报告核验执行覆盖（GATE-C）
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么要有这条判据（GATE-C-20260927）：`caseset-coverage` 原来只看"清单认不认这个路径"，
// 于是**历史回执提到过**就会把一条用例判成"该进 CASES"的 drift，而它其实早已由 CI 的完整默认集真跑过。
// 反过来，只看清单 `include` 又等于把"清单里有"当成"跑过了"。两边都不对。
// ⇒ 本判据在**同一次运行**里真起一次 `script/test-ci.ts`（无 `--filter` 的完整默认集），收它 `--json`
//   写出的逐文件报告；只有"报告有效 + 逐条与当前清单一致 + 该 include 真跑成功"才算已执行覆盖。
//
// 三条纪律：
//  1. **不许只读历史报告**：证据必须是本次进程起的子进程产出的（报告路径/日志目录都随读数印出）。
//  2. **报告无效/只跑子集 ⇒ 不算覆盖**：`filter` 非 null、缺行、重复、decision/runner 不一致、
//     `pass` 但退出码非 0、`fail` 却退出码 0 —— 一律记问题并判 RED。
//  3. **失败/超时/缺件不是通过**：显式 `exclude` 只归"外部验收/未运行"，既不算 drift 也不算通过。

/**
 * 本次完整离线 CI 的等待上限。实测（2026-09-27，本机）默认集约 3 分钟；给 30 分钟余量。
 * 超时按 UNPROVEN（无读数），**不**冒充覆盖。
 */
export const OFFLINE_CI_BUDGET_MS = 1_800_000

/**
 * 依赖"本次离线 CI 实跑证据"的判据 id。`--only` **命中这些**才真跑完整离线 CI：
 *  · 全量发布跑法（无 `--only`）永远跑；
 *  · `--only gate-drivers` 之类不依赖它的子集**不跑** —— 这同时避免递归
 *    （`test-ci` 会跑 `script/release-gate.test.ts`，而它的 full 自测只跑 `--only gate-drivers`）。
 *  · 夹具模式（`--selftest --cases`）本来就不跑结构性判据，更不跑真仓 CI。
 */
export const OFFLINE_CI_DEPENDENT_CRITERIA = ['offline-ci', 'caseset-coverage', 'manifest-gate-gap'] as const

/** `--only` 选择下要不要真跑完整离线 CI（纯函数，便于负对照与静态不变式直接驱动）。 */
export function offlineCiNeededFor(only: string | undefined): boolean {
  return only === undefined || OFFLINE_CI_DEPENDENT_CRITERIA.some((id) => id.includes(only))
}

/** `test-ci.ts --json` 的逐文件结果（字段与 `script/test-ci.ts` 的 `FileResult` 对齐）。 */
export interface OfflineCiFileResult {
  path: string
  declaredRunner: string
  executedBy: string
  command: string
  decision: 'include' | 'exclude'
  status: 'pass' | 'fail' | 'timeout' | 'skip' | 'missing'
  exitCode: number | null
  timeoutMs: number
  pass: number
  fail: number
  skip: number
  reason?: string
  logTail: string
}

export interface OfflineCiReport {
  schema: number
  generatedAt: string
  manifest: string
  timeoutMs: number
  filter: string | null
  summary: {
    manifestEntries: number
    included: number
    excludedNotRun: number
    ran: number
    passed: number
    failed: number
    skipped: number
    missing: number
    harnessExitCode: number
  }
  excludedReasons: { path: string; reason: string }[]
  results: OfflineCiFileResult[]
}

/** `test-ci.ts --json` 报告的解码。结构不对（schema/字段/类型）⇒ `null`（无读数，不猜）。 */
export function parseOfflineCiReport(raw: string): OfflineCiReport | null {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null) return null
  const o = j as Partial<OfflineCiReport>
  if (o.schema !== 1) return null
  if (!Array.isArray(o.results)) return null
  if (typeof o.summary !== 'object' || o.summary === null) return null
  // `filter` 必须在场（null 也要在场）：缺字段说明不是本门认识的那份报告。
  if (!Object.prototype.hasOwnProperty.call(o, 'filter')) return null
  const s = o.summary as OfflineCiReport['summary']
  if (typeof s.manifestEntries !== 'number' || typeof s.harnessExitCode !== 'number' || typeof s.included !== 'number') return null
  return o as OfflineCiReport
}

export interface OfflineCiValidation {
  /** 报告本身的问题（filter 非 null / 与清单不一致 / 重复 / 缺行 / runner / exit-status 对不上）⇒ 判 RED */
  problems: string[]
  /** 纳入且**真起了进程**（pass/fail/timeout）——"实际执行集合"用这个（不许把没跑的贴成跑过） */
  ran: string[]
  /** 纳入、本次实跑**成功** —— 只有这个能当"已执行覆盖" */
  passed: string[]
  failed: string[]
  missing: string[]
  /** 显式 `exclude`（有意不跑），归"外部验收/未运行"，不计通过 */
  excluded: string[]
  /** `exclude` 但没写理由 */
  excludedNoReason: string[]
}

/**
 * 报告 vs 当前清单的**逐条核对**（纯函数）。判定只信这里的产物，不信"报告里写了 pass"。
 * 有意不查每文件 `pass` 计数是否为 0：`test-ci` 的通过判定以**进程退出码**为准（plain 脚本的
 * 中文收尾行 `N/M 通过` 不在 `test-ci.parseCounts` 的识别面里），拿"pass>0"当门槛会误伤合法 plain 用例。
 */
export function validateOfflineCiReport(
  report: OfflineCiReport,
  manifest: Map<string, ManifestEntryFull>,
  runExit: number | null,
): OfflineCiValidation {
  const v: OfflineCiValidation = { problems: [], ran: [], passed: [], failed: [], missing: [], excluded: [], excludedNoReason: [] }
  if (report.filter !== null) v.problems.push(`报告 filter=${report.filter} 不是 null ⇒ 本次只跑了子集，不能冒充完整离线 CI 覆盖`)
  if (runExit === null) v.problems.push('拿不到 test-ci 的退出码')
  const seen = new Set<string>()
  for (const r of report.results) {
    if (seen.has(r.path)) v.problems.push(`报告里重复出现同一条路径：${r.path}`)
    seen.add(r.path)
    const entry = manifest.get(r.path)
    if (!entry) {
      v.problems.push(`报告里的路径不在当前清单：${r.path}`)
      continue
    }
    if (entry.decision !== r.decision) v.problems.push(`${r.path}：报告 decision=${r.decision}，当前清单=${entry.decision}`)
    if (entry.declaredRunner !== r.declaredRunner) v.problems.push(`${r.path}：报告 runner=${r.declaredRunner}，当前清单=${entry.declaredRunner}`)
    if (r.decision === 'exclude') {
      v.excluded.push(r.path)
      if (!(r.reason ?? '').trim()) v.excludedNoReason.push(r.path)
      if (r.status !== 'skip') v.problems.push(`${r.path}：exclude 条目的 status=${r.status}（应为 skip）`)
      continue
    }
    if (r.status === 'skip') {
      v.problems.push(`${r.path}：include 条目却是 skip ⇒ include 没有实际结果`)
      continue
    }
    if (r.status === 'missing') {
      v.missing.push(r.path)
      continue
    }
    v.ran.push(r.path)
    if (r.status === 'pass') {
      v.passed.push(r.path)
      if (r.exitCode !== 0) v.problems.push(`${r.path}：status=pass 但 exitCode=${String(r.exitCode)}`)
    } else {
      v.failed.push(r.path)
      if (r.exitCode === 0) v.problems.push(`${r.path}：status=${r.status} 却 exitCode=0`)
    }
    if (r.executedBy === '-') v.problems.push(`${r.path}：status=${r.status} 但没有真实执行器（executedBy=-）`)
  }
  for (const p of manifest.keys()) if (!seen.has(p)) v.problems.push(`当前清单里的条目在报告里缺行：${p}`)
  return v
}

/** 本次离线 CI 的原始证据（报告文本 + 日志目录 + 退出码）。`reportRaw === null` ⇒ 没有可用报告。 */
export interface OfflineCiEvidence {
  reportRaw: string | null
  reportPath: string
  logDir: string
  exit: number | null
  ms: number
  stdout: string
  stderr: string
  capture: 'file' | 'pipe'
  infra?: string
}

/**
 * 离线 CI 证据（报告 + 日志）落在哪个父目录。优先级：函数参数 → 环境变量
 * `RELEASE_GATE_CI_EVIDENCE_DIR` → `os.tmpdir()`。
 *
 * 为什么要这个环境变量（GATE-C 实测）：本仓的 /tmp 在一个后台沙箱进程退出后会被清掉，
 * 于是"日志保留"落空。交付/复跑时把它指到任务私有运行根（例如 `.runtime/.../gate-c/`），
 * 证据就能随回执留在盘上。**不改任何判据语义**：只是证据落点。
 */
export function offlineCiEvidenceParent(configured: string | undefined = process.env.RELEASE_GATE_CI_EVIDENCE_DIR, fallback: string = tmpdir()): string {
  const dir = configured?.trim()
  return dir ? dir : fallback
}

/**
 * 起一次**完整**（不带 `--filter`）的 `script/test-ci.ts`，把 `--json` 报告与 stdout/stderr 落到
 * 同一个**保留**的临时目录（日志不删，路径随读数印出）。不新建第二套执行器：直接复用既有入口。
 *
 * `evidenceParent` 只是给测试/上层指定证据落点；缺省取 `offlineCiEvidenceParent()`
 * （`RELEASE_GATE_CI_EVIDENCE_DIR`，否则 `os.tmpdir()`）。
 */
export function collectOfflineCi(root: string, budgetMs: number, evidenceParent?: string): OfflineCiEvidence {
  let dir: string
  try {
    const parent = evidenceParent ?? offlineCiEvidenceParent()
    // 证据父目录不存在就建（`RELEASE_GATE_CI_EVIDENCE_DIR` 指到任务私有根时常见）；建不出按 infra 处理。
    mkdirSync(parent, { recursive: true })
    dir = mkdtempSync(join(parent, 'release-gate-offline-ci-'))
  } catch (e) {
    return { reportRaw: null, reportPath: '', logDir: '', exit: null, ms: 0, stdout: '', stderr: '', capture: 'pipe', infra: `建不出证据目录：${String(e)}` }
  }
  const reportPath = join(dir, 'test-ci-report.json')
  const r = run(bunBin(), ['--no-env-file', join(root, 'script/test-ci.ts'), '--json', reportPath], root, budgetMs)
  writeFileSync(join(dir, 'test-ci.stdout.log'), r.stdout)
  writeFileSync(join(dir, 'test-ci.stderr.log'), r.stderr)
  const reportRaw = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null
  return { reportRaw, reportPath, logDir: dir, exit: r.code, ms: r.ms, stdout: r.stdout, stderr: r.stderr, capture: r.capture, infra: r.infra }
}

export interface OfflineCiCriterionInput {
  /** `null` ⇒ 本次没有收集离线 CI 证据（夹具模式 / `--only` 未命中依赖判据） */
  evidence: OfflineCiEvidence | null
  manifest: Map<string, ManifestEntryFull> | null
}

/**
 * `offline-ci` 判据：**有有效报告且纳入集全绿** = GREEN；有失败/缺件/报告问题 = RED；
 * 报告读不到/解不开/起不了进程 = UNPROVEN（无读数，不冒充任何一侧）。
 */
export function evalOfflineCiCriterion(input: OfflineCiCriterionInput): CriterionResult {
  const title = 'offline-ci（同一次运行里真跑 test-ci 完整默认集，按报告核验执行覆盖）'
  const { evidence } = input
  if (!evidence) {
    return {
      id: 'offline-ci',
      title,
      status: 'UNPROVEN',
      metrics: { ran: 0, reportValid: -1 },
      findings: ['本次没有收集离线 CI 证据（夹具模式，或 `--only` 未命中依赖它的判据）⇒ 无读数；**这不是"跑过了"**'],
      waivers: [],
    }
  }
  if (evidence.infra) {
    return {
      id: 'offline-ci',
      title,
      status: 'UNPROVEN',
      metrics: { exit: evidence.exit ?? -1, ms: evidence.ms, capture: evidence.capture, reportValid: -1 },
      findings: [`test-ci 起不来/超时：${evidence.infra} ⇒ 无读数（不拿"没量到"当覆盖）；日志目录 ${evidence.logDir || '(未建)'}`],
      waivers: [],
    }
  }
  if (evidence.reportRaw === null) {
    return {
      id: 'offline-ci',
      title,
      status: 'UNPROVEN',
      metrics: { exit: evidence.exit ?? -1, ms: evidence.ms, capture: evidence.capture, reportValid: 0 },
      findings: [`test-ci --json 报告读不到（${evidence.reportPath}）⇒ 无读数；exit=${String(evidence.exit)}；日志目录 ${evidence.logDir}`],
      waivers: [],
    }
  }
  const report = parseOfflineCiReport(evidence.reportRaw)
  if (!report) {
    return {
      id: 'offline-ci',
      title,
      status: 'UNPROVEN',
      metrics: { exit: evidence.exit ?? -1, ms: evidence.ms, capture: evidence.capture, reportValid: 0 },
      findings: [`test-ci --json 报告解不开 ⇒ 无读数（不猜"跑过"）；日志目录 ${evidence.logDir}`],
      waivers: [],
    }
  }
  if (!input.manifest) {
    return {
      id: 'offline-ci',
      title,
      status: 'UNPROVEN',
      metrics: { exit: evidence.exit ?? -1, ms: evidence.ms, capture: evidence.capture, reportValid: 0 },
      findings: [`脚本清单读不到 ⇒ 无法逐条核对报告与当前清单 ⇒ 无读数；日志目录 ${evidence.logDir}`],
      waivers: [],
    }
  }
  const v = validateOfflineCiReport(report, input.manifest, evidence.exit)
  const red = v.problems.length > 0 || evidence.exit !== 0 || v.failed.length > 0 || v.missing.length > 0
  const status: Status = red ? 'RED' : v.passed.length === 0 ? 'UNPROVEN' : 'GREEN'
  const reasonOf = (p: string) => report.results.find((r) => r.path === p)?.reason ?? ''
  return {
    id: 'offline-ci',
    title,
    status,
    metrics: {
      include: report.summary.included,
      ran: v.ran.length,
      passed: v.passed.length,
      failed: v.failed.length,
      missing: v.missing.length,
      excluded: v.excluded.length,
      filter: report.filter === null ? 'null' : report.filter,
      reportValid: v.problems.length === 0 ? 1 : 0,
      validationProblems: v.problems.length,
      exit: evidence.exit ?? -1,
      ms: evidence.ms,
      capture: evidence.capture,
    },
    findings: [
      ...v.problems.map((x) => `REPORT-INVALID：${x}`),
      ...v.failed.map((p) => `OFFLINE-CI-FAIL：${p} —— ${reasonOf(p)}`),
      ...v.missing.map((p) => `OFFLINE-CI-MISSING：${p} 已纳入却缺文件`),
      ...v.excludedNoReason.map((p) => `EXCLUDE-NO-REASON：${p} 在清单里 exclude 却没有理由`),
      ...(evidence.exit !== 0 && v.problems.length === 0 && v.failed.length === 0 && v.missing.length === 0
        ? [`test-ci 退出码非 0（exit=${String(evidence.exit)}）而报告里没有失败项 ⇒ 配置/分类问题（例如未审用例），不可当绿`]
        : []),
      ...(v.passed.length === 0 ? ['纳入集本次一条都没跑成功 ⇒ 这条"通过"没有内容'] : []),
    ],
    waivers: [
      `证据来历：本次进程起的 \`bun --no-env-file script/test-ci.ts --json\`；报告 ${evidence.reportPath}；日志 ${evidence.logDir}`,
      ...(v.excluded.length > 0
        ? [
            `显式 exclude ${v.excluded.length} 条 ⇒ 归"外部验收/未运行"，**不计通过**` +
              `（逐条理由见清单 reason 与 --json 的 offlineCi）：${v.excluded.slice(0, 5).join(' / ')}${v.excluded.length > 5 ? ` …（共 ${v.excluded.length} 条）` : ''}`,
          ]
        : []),
      'GREEN 只说明"本次完整离线默认集跑了、纳入项都过了"；真机/图形/GPU/账户/打包不在本门内。',
    ],
  }
}

/**
 * 清单 `include` vs 发布门：**门不跑的 CI 用例有多少条、是哪些**（GATE-MANIFEST-GAP 单）。
 *
 * 这条判据来自验收报告 §4-N2/§4-N5⑥ 的建设性建议：门**已经读了清单**（`readManifest`），
 * `manifest.include − CASES − COVERAGE_WAIVERS` 是**零成本**可算的 —— 也就是说"发布门没跑这些 CI 用例"
 * 从来不是算不出来，而是**没人报、也没人守**。
 *
 * ```
 * 验收读数（23:39，clean tree）：清单 test-like include 165 条，门跑 55 条 ⇒ 110 条不进门，而门不报这个数
 * 本单读数（2026-09-27 00:12 → 交付）：113 → 121 → … ⇒ 冻结点见 `MANIFEST_GAP_FROZEN`（清单在同一天被
 * 并行 lane 补登记了十几条新用例 —— 这个数字是**活的**，所以它必须被冻结点守着，否则"门不跑它"会一直悄悄变）
 * ```
 *
 * 判定：**只拦"长"** —— `notRun` 条数变多 ⇒ RED；条数**相同**而成员换了（摘要不符）⇒ RED；
 * 条数变少（接进门 / 清单收紧）**不判红**，只在读数里记 `frozenGone` —— 那是收紧方向，拦住它等于惩罚改好的人。
 * 要同步这份冻结点，直接把判据点名行里打印出来的 `{ count, digest }` 抄回来：**这是一次必须被 review 的改动**
 * （"门又多了一条不跑的用例"必须在明面上）。
 */
export interface ManifestGap {
  /** 清单里 `decision=include` 且 test-like 的路径（排序） */
  includeTestLike: string[]
  /** 其中发布门**真接进 `CASES` 会跑的** */
  declared: string[]
  /** 其中**显式豁免**（`COVERAGE_WAIVERS`，有条目也有理由）的 */
  waived: string[]
  /** 其余 = 发布门**不跑**的（`include − CASES − WAIVERS`） */
  notRun: string[]
}

export function manifestGateGap(
  manifest: Map<string, 'include' | 'exclude'>,
  declared: readonly string[],
  waivers: readonly { path: string }[],
): ManifestGap {
  const declaredSet = new Set(declared)
  const waiverSet = new Set(waivers.map((w) => w.path))
  const includeTestLike = [...manifest.entries()]
    .filter(([, d]) => d === 'include')
    .map(([p]) => p)
    .filter((p) => TEST_LIKE.test(p))
    .sort()
  return {
    includeTestLike,
    declared: includeTestLike.filter((p) => declaredSet.has(p)),
    waived: includeTestLike.filter((p) => !declaredSet.has(p) && waiverSet.has(p)),
    notRun: includeTestLike.filter((p) => !declaredSet.has(p) && !waiverSet.has(p)),
  }
}

/**
 * 集合摘要：**排序后逐行拼接**的 sha256 前 12 位（与 `gate=`/`worktree=` 同一打印口径）。
 * 只冻条数会让"条数不变、成员换了一个"溜过去；只冻摘要则丢掉"多少条"这个给人读的数字。两个都要。
 */
export function manifestGapDigest(notRun: readonly string[]): string {
  return sha256Hex([...notRun].sort().join('\n')).slice(0, 12)
}

export function evalManifestGap(
  manifest: Map<string, 'include' | 'exclude'> | null,
  declared: readonly string[],
  waivers: readonly { path: string; reason: string }[],
  frozen: { count: number; digest: string },
): CriterionResult {
  const title = '清单 include vs 发布门（没进门的用例数必须报出来，且不许悄悄长）'
  if (manifest === null)
    return {
      id: 'manifest-gate-gap',
      title,
      status: 'UNPROVEN',
      metrics: { includeTestLike: 0, gateRuns: 0, notRun: 0, frozen: frozen.count, newOnes: -1 },
      findings: ['script/test-ci.manifest.json 读不到 ⇒ 数不出"清单 include 里有多少条没进门" ⇒ 无读数（不拿"数不出"冒充"没缺口"）'],
      waivers: [],
    }
  const { includeTestLike, declared: declaredIncl, waived: waivedIncl, notRun } = manifestGateGap(manifest, declared, waivers)
  const digest = manifestGapDigest(notRun)
  // **只拦"长"**：条数变多 ⇒ 红；条数**相同**而成员换了 ⇒ 红（摘要那一维）；条数变少 ⇒ 不判红（收紧方向，
  // 只记 `frozenGone`）—— 拦住"变好"等于惩罚改好的人。
  const grew = notRun.length > frozen.count || (notRun.length === frozen.count && digest !== frozen.digest)
  // 冻结值里"已经不在没进门集合里"的规模：不判红，只如实记数（收紧方向）。
  const frozenGone = Math.max(0, frozen.count - notRun.length)
  return {
    id: 'manifest-gate-gap',
    title,
    status: grew ? 'RED' : 'GREEN',
    metrics: {
      includeTestLike: includeTestLike.length,
      gateRuns: declaredIncl.length,
      waived: waivedIncl.length,
      notRun: notRun.length,
      frozen: frozen.count,
      frozenGone,
      delta: notRun.length - frozen.count,
      digest,
    },
    findings: grew
      ? [
          `MANIFEST-GAP：清单 include 的 test-like 用例 ${includeTestLike.length} 条，发布门只跑 ${declaredIncl.length} 条` +
            `（另有 ${waivedIncl.length} 条显式豁免）⇒ **没进门的 ${notRun.length} 条**` +
            `（冻结 ${frozen.count} 条 / digest 冻结 ${frozen.digest}，现算 ${digest}）——` +
            `"门不跑它"这件事必须在明面上：要么接进 CASES，要么写进 COVERAGE_WAIVERS 并给理由；` +
            `要承认现状就把 MANIFEST_GAP_FROZEN 更新成 \`{ count: ${notRun.length}, digest: '${digest}' }\`（必须被 review 的改动）。` +
            `当前没进门的用例（前 12 条，全量见 --json 的 \`manifestGap.notRun\`）：${notRun.slice(0, 12).join(' / ')}${notRun.length > 12 ? ` …（共 ${notRun.length} 条）` : ''}`,
        ]
      : [],
    waivers: [
      `清单 include 的 test-like 用例 ${includeTestLike.length} 条；发布门跑其中 ${declaredIncl.length} 条，显式豁免 ${waivedIncl.length} 条 ⇒` +
        ` **没进门的 ${notRun.length} 条**已按冻结值登记（count=${frozen.count} / digest=${frozen.digest}${frozenGone > 0 ? `；其中 ${frozenGone} 条已不在缺口里（收紧方向，冻结值可同步）` : ''}）。` +
        `**这不是"已覆盖"，是登记在明面上的缺口**`,
    ],
  }
}

/**
 * 冻结下限漂移 + **冻结基线**（GATE-FLOOR-DRIFT / GATE-FINALIZATION）：两种漂移各管一半。
 *
 * ## 上半（本单原有）：`minPass` **低于实测通过数** ⇒ 红
 *
 * 改前没有任何判据守这件事（验收报告 §4-N8）：`viewer-texture-and-autoframe` 下限写 15、文件现有 22 条、
 * 实测 22 ⇒ **删掉 7 条仍然绿**，而门里连"下限已经比用例数低 7"这句话都没有。
 * 只写一个下限数字而没人拿它跟实测比，"冻结下限"就只是一句自述。
 *
 * ## 下半（定版单新增）：实测 **低于冻结基线** ⇒ 红
 *
 * 只有上半时，"**先删用例、再把 `minPass` 调到新实测**"仍然能把红洗掉（验收队实测
 * `minPass=15 / 实测=15 ⇒ GREEN`）。下半把交付那一刻的实测值冻进 `FLOOR_BASELINE_FROZEN`：
 * 删用例 ⇒ 实测跌到基线之下 ⇒ 红，**下限跟着降也没用**。两个方向合起来才是 ratchet：
 *
 * ```
 * 实测 pass > minPass            ⇒ RED（下限太松：删掉 N 条仍然绿）—— 修法：把下限抬到实测
 * 实测 pass < FLOOR_BASELINE[id] ⇒ RED（用例被删/改小）      —— 修法：恢复覆盖，或走 review 改基线
 * FLOOR_BASELINE[id] < minPass   ⇒ RED（基线没跟着下限抬）  —— 修法：把基线抬到实测
 * ```
 *
 * 只对**实测判绿**的用例做上面三条：用例本身红/没读数时，"下限低于实测"既无意义也无危害
 * （没有任何东西被放宽，门已经是红的）—— 那样也不会让一条正在修的文件被记两次。
 * `gone`（基线里有、本次一个读数都没有）只在**全量内建用例**跑法下判（`--only` 子集与
 * `--selftest --cases` 夹具跑的不是同一批用例，拿它们报"用例没了"是假红）。
 *
 * ## 有意不 ratchet `minAssert` / `minSites`（如实登记，别当成已覆盖）
 *
 * 这两条**只保留下界检查**（`case-integrity` 的 `staticSites < minSites`、`evalCase` 的
 * `assertions < minAssert` ⇒ RED，方向是"不许缩水"）。没有对它们做同样的 `实测 > 下限 ⇒ 红`：
 *  · `minSites` 是 `countAssertSites(文件字节)`，`minAssert` 是运行期 `N expect() calls` ——
 *    两者都随"给已接门的用例加一条断言"而变，而那**从来不缩减覆盖**；硬绑会让门在无关改动上长期变红，
 *    红的原因还不是"覆盖被砍"。
 *  · 真正要防的"下限被下调"对这三条是同一形状；本单按验收报告点名的那一条（`minPass`）建 ratchet，
 *    其余两条**登记为未覆盖**（metrics 里报数）。
 */
export function evalFloorDrift(
  readings: CaseReading[],
  frozen: FloorBaseline = FLOOR_BASELINE_FROZEN,
  /** 本次跑的是不是**全量内建用例**（`--only` 子集 / `--cases` 夹具 ⇒ false ⇒ 不报 `gone`） */
  fullBuiltinRun = false,
): CriterionResult {
  const title = '冻结下限漂移（minPass 低于实测 ⇒ 删掉 N 条仍然绿；实测低于冻结基线 ⇒ 已经删过）'
  const checked = readings.filter((r) => r.ran && r.counts.format !== null && evalCase(r).status === 'GREEN')
  const byId = new Map(readings.map((r) => [r.spec.id, r]))
  const drift: string[] = []
  const shrink: string[] = []
  const stale: string[] = []
  const gone: string[] = []
  const unfrozen: string[] = []
  let assertGapReported = 0
  let sitesGapReported = 0
  for (const r of checked) {
    const s = r.spec
    if (r.counts.pass > s.minPass)
      drift.push(
        `${s.id} minPass 低于实测：下限 ${s.minPass} < 实测 pass=${r.counts.pass}（差 ${r.counts.pass - s.minPass}）` +
          `⇒ **删掉 ${r.counts.pass - s.minPass} 条用例仍然绿**（${s.path}）—— 修法是把下限上调到实测值`,
      )
    const base = frozen.pass[s.id]
    if (base === undefined) unfrozen.push(s.id)
    else {
      if (r.counts.pass < base)
        shrink.push(
          `${s.id} 实测 pass=${r.counts.pass} **低于冻结基线 ${base}**（差 ${base - r.counts.pass}）` +
            `⇒ **有人删了用例 / 把用例改小了**（${s.path}）—— 下限 minPass=${s.minPass} 就算跟着降下来也没用：` +
            `要缩减覆盖，必须是一次被 review 的改动（改 FLOOR_BASELINE_FROZEN.at/`+`digest/pass）`,
        )
      if (base < s.minPass)
        stale.push(
          `${s.id} 冻结基线 ${base} **低于冻结下限 minPass=${s.minPass}** ⇒ 基线没跟着下限一起抬` +
            `（基线必须是**上一次 review 那一刻**的实测值，否则"先删用例"可以藏在过期基线之上）—— 把基线抬到实测 ${r.counts.pass}`,
        )
    }
    if (r.counts.assertions > s.minAssert) assertGapReported++
    if (r.staticSites > s.minSites) sitesGapReported++
  }
  if (fullBuiltinRun) for (const id of Object.keys(frozen.pass)) if (!byId.has(id)) gone.push(id)
  const goneFindings = gone.map(
    (id) => `${id} 在冻结基线里、本次**一个读数都没有** ⇒ 用例被删/改名/从 CASES 里去掉（冻结基线 ${frozen.pass[id]} 条通过）—— 缩减覆盖必须是一次被 review 的改动`,
  )
  const measured: Record<string, number> = {}
  for (const r of checked) measured[r.spec.id] = r.counts.pass
  const bad = drift.length + shrink.length + stale.length + gone.length
  return {
    id: 'floor-drift',
    title,
    status: bad > 0 ? 'RED' : checked.length === 0 ? 'UNPROVEN' : 'GREEN',
    metrics: {
      checked: checked.length,
      drift: drift.length,
      // 定版单新增（下同）：基线方向的三档 + 两条只报数的缺口
      shrink: shrink.length,
      staleBaseline: stale.length,
      gone: gone.length,
      unfrozen: unfrozen.length,
      baseline: Object.keys(frozen.pass).length,
      digest: floorBaselineDigest(measured),
      baseDigest: frozen.digest,
      assertGapReported,
      sitesGapReported,
    },
    findings: [...drift, ...shrink, ...stale, ...goneFindings],
    waivers: [
      ...(unfrozen.length > 0
        ? [
            `判绿但**不在冻结基线**里的用例 ${unfrozen.length} 条（新增；只报数不判红 —— 新增不缩减覆盖）：${unfrozen.slice(0, 8).join(' / ')}${unfrozen.length > 8 ? ` …（共 ${unfrozen.length} 条）` : ''}`,
          ]
        : []),
      ...(assertGapReported + sitesGapReported > 0
        ? [
            `下限比现存量松、但本判据不拦的：minAssert ${assertGapReported} 条 / minSites ${sitesGapReported} 条` +
              `（只保留下界检查；理由见 evalFloorDrift 注释 —— 它们随"加断言"而变，硬绑会在与覆盖无关的改动上长期变红）`,
          ]
        : []),
    ],
  }
}

/** 本 gate 的自我核对：不许存在"没有数字的通过"，也不许存在"跑了却没读数"的用例。 */
export function evalSelfCheck(criteria: CriterionResult[], readings: CaseReading[], declared: number): CriterionResult {
  const numbered = criteria.filter((c) => Object.keys(c.metrics).length > 0)
  const noNumberGreen = criteria.filter((c) => c.status === 'GREEN' && Object.keys(c.metrics).length === 0)
  const readingsGot = readings.filter((r) => r.counts.format !== null)
  const missing: string[] = []
  // 声明了 N 条用例，就必须真起 N 次进程：表与执行数对不上说明有静默跳过。
  if (readings.length !== declared) missing.push(`声明用例 ${declared} 条，实际执行 ${readings.length} 条`)
  for (const c of noNumberGreen) missing.push(`${c.id} 判绿但没有任何数字`)
  // 注意：**"用例没产出读数"不在这里判红** —— 那条已经由 evalCase 记成 UNPROVEN（不是通过）。
  // 这里只留结构性不变式：不许有"没数字的通过"、不许声明数与执行数不符、不许一条都没跑。
  if (readings.length === 0) missing.push('一条用例都没执行')
  return {
    id: 'gate-selfcheck',
    title: '本门自检（没有数字的通过 / 跑了没读数）',
    status: missing.length > 0 || numbered.length !== criteria.length ? 'RED' : 'GREEN',
    metrics: {
      checked: criteria.length,
      total: criteria.length + 1,
      numbered: numbered.length,
      unnumbered: criteria.length - numbered.length,
      declaredCases: declared,
      readings: readingsGot.length,
      noReading: readings.length - readingsGot.length,
    },
    findings: missing,
    waivers: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程与派生
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null
  /**
   * **混合日志**（`stdout + stderr`，顺序与裸管道一致）。保留给"人读日志"的消费者与既有回执口径；
   * 需要**机器协议**的消费者（JSON/行协议）必须只读 {@link RunResult.stdout} —— 见 `run()` 里那段
   * "机器结果与诊断分离"的说明。
   */
  out: string
  /**
   * 子进程的 **stdout 原文**（只有它；stderr 不混进来）。
   *
   * 为什么要单列（GATE-AB-20260927 的实测缺陷）：`bun run gate:drivers --json` 的合法 JSON 在 stdout，
   * 而 `package.json` 脚本的 shell 前缀 `[ -x "$npm_execpath" ] && …` 落在 **stderr**。旧口径把两者拼成
   * `out` 再按"第一个 `[` 到最后一个 `]`"解析 ⇒ stderr 那对 `[`/`]` 把 JSON 的收尾切走 ⇒ 一条能 GREEN
   * 的判据被读成 UNPROVEN。机器结果与诊断从此分离：解析只认这一份，诊断仍留在 {@link out}/{@link stderr}。
   */
  stdout: string
  /** 子进程的 **stderr 原文**（只作诊断/回执；**不**参与任何机器协议解析）。 */
  stderr: string
  ms: number
  timedOut: boolean
  infra?: string
  /** 输出采集面：`file`=临时文件（默认）；`pipe`=临时目录建不出来时的退回路径（会丢尾部，见 `run()`）。 */
  capture: 'file' | 'pipe'
  /**
   * 子进程**被信号杀死**时的信号名（`SIGKILL`/`SIGABRT`/`SIGSEGV`…）；正常退出或拿不到 ⇒ `null`。
   *
   * 为什么单列这一个字段（GATE-TSC-EXIT-CODE）：OOM 被内核杀掉时 `code === null` 且
   * `error === undefined` —— 也就是 `infra` 那一路**读不到任何线索**，只有 `signal` 说得清"它是被杀死的"。
   * 那正是 `tsc` 假绿的形状：`--listFiles` 的清单已经写出来了，人却被打死，输出里一条 `error TS` 都没有。
   */
  signal: string | null
}

/**
 * 起子进程并取回 `stdout+stderr`。**默认把两个 fd 落到临时文件，不走管道** —— 理由是本单实测到的一条
 * 真实丢数路径（它同时解释了两次"同一命令两样结果"里的 preflight 那一条）：
 *
 *  · Bun 的 stdout 在**管道**上是异步刷写；`script/test-ci.ts` 的收尾是
 *    `main(...).then((code) => process.exit(code))` —— **最后一次 write 之后立刻 `process.exit()`**，
 *    管道上还没刷出去的那一截就此丢掉。丢掉的正好是它的最后一行 `# include=…`（preflight 的收尾行），
 *    而 **exit 仍是 0** ⇒ 门把一条能 GREEN 的判据报成"没读数（UNPROVEN）"。
 *  · 实测（同一台机、同一条命令、同一棵树，各 150 次）：
 *      `bun run preflight`            经管道 **丢 12 次**
 *      `bun script/test-ci.ts --list` 经管道 **丢 10 次**
 *      上面两条改成写文件后              **各 0 次**
 *    丢的形状也可复算：完整输出 37180 字符 → 丢失时 30601 / 34357，末尾停在半行上。
 *  · 这类丢尾部对 `tsc --listFiles` 是**假绿风险**（诊断行在尾部，丢了就等于"errors=0"），
 *    对 `bun test` 是"读数不可信"，所以这里对所有子进程一视同仁。
 *
 * `stdout` 与 `stderr` 仍分两个文件读、按 `stdout+stderr` 的顺序拼进 `out`；同时**各自原文**单列在
 * `stdout`/`stderr` 字段里 —— 与走管道时逐字同口径。机器协议消费者只读 `stdout`：
 * `bun run gate:drivers --json` 的 JSON 在 stdout，而 `package.json` 脚本的 shell 前缀
 * `[ -x "$npm_execpath" ] && …` 在 stderr，把两者拼起来解析就会被那对方括号切坏（实测形状见
 * `RunResult.stdout` 的注释）。
 * 临时目录建不出来（只读 /tmp 等）才退回管道，并在 `capture` 里留痕。**两条路径都必须填好三个字段**
 * （`out`/`stdout`/`stderr`），不许只在文件路径上分离、退回管道后又混起来。
 *
 * **导出**：本函数是本门唯一的取数口，负对照要能直接驱动它（`script/release-gate.test.ts` 的
 * "放大版夹具"两条就是拿它跟裸管道对比的）。
 */
export function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): RunResult {
  const t0 = Date.now()
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'release-gate-'))
  } catch {
    dir = null
  }
  if (dir !== null) {
    const outPath = join(dir, 'stdout')
    const errPath = join(dir, 'stderr')
    const fo = openSync(outPath, 'w')
    const fe = openSync(errPath, 'w')
    let r: ReturnType<typeof spawnSync>
    try {
      r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, stdio: ['ignore', fo, fe], env })
    } finally {
      closeSync(fo)
      closeSync(fe)
    }
    const stdout = readFileSync(outPath, 'utf8')
    const stderr = readFileSync(errPath, 'utf8')
    const out = `${stdout}${stderr}`
    rmSync(dir, { recursive: true, force: true })
    const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return {
      code: r.status,
      out,
      stdout,
      stderr,
      ms: Date.now() - t0,
      timedOut,
      infra: r.error ? (timedOut ? `超时 ${timeoutMs}ms` : String(r.error.message ?? r.error)) : undefined,
      capture: 'file',
      signal: r.signal ?? null,
    }
  }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  const out = `${stdout}${stderr}`
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  return {
    code: r.status,
    out,
    stdout,
    stderr,
    ms: Date.now() - t0,
    timedOut,
    infra: r.error ? (timedOut ? `超时 ${timeoutMs}ms` : String(r.error.message ?? r.error)) : undefined,
    capture: 'pipe',
    signal: r.signal ?? null,
  }
}

/**
 * 跑 `package.json` 里的脚本（`bun run <name>`）。**必须显式补 PATH**：脚本体自己又是一次
 * `bun run …`（如 `"preflight": "bun run script/test-ci.ts --list"`），嵌套那次靠 PATH 解析 `bun`。
 * 门用 `process.execPath` 的绝对路径起子进程时，PATH 上未必有 `bun` —— 那时嵌套调用会得到
 * `error: script "preflight" exited with code 127` + **零输出** ⇒ 判据 UNPROVEN（本机实测过）。
 * 这里只把执行器所在目录并进 PATH，**命令与参数一个字不改**。
 *
 * **导出**：同 `run()`，供负对照直接驱动（PATH 负对照：裸 `bun run` 与它两条路各跑一次）。
 */
export function runPackageScript(name: string, extraArgs: string[], root: string, timeoutMs: number): RunResult {
  const bin = bunBin()
  const dir = dirname(bin)
  const path = dir && dir !== '.' ? `${dir}:${process.env.PATH ?? ''}` : process.env.PATH
  return run(bin, ['run', name, ...extraArgs], root, timeoutMs, { ...process.env, PATH: path })
}

/**
 * 执行器：优先 `TESTCI_BUN`，其次当前 bun（`bun run` 起的进程里 execPath 就是 bun）。
 * 用 `node script/release-gate.ts` 起的时候 `bun` 未必在 PATH 上，所以再退一步认本仓回执里一贯用的
 * `$HOME/.bun/bin/bun`；都认不出就照实返回 `bun`，让 `run()` 的 infra 把"执行器找不到"印成 UNPROVEN —— 不是绿。
 */
function bunBin(): string {
  const configured = process.env.TESTCI_BUN?.trim()
  if (configured) return configured
  if (/(^|\/)bun$/.test(process.execPath)) return process.execPath
  if (spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0) return 'bun'
  const fallback = process.env.HOME ? join(process.env.HOME, '.bun/bin/bun') : ''
  if (fallback && existsSync(fallback)) return fallback
  return 'bun'
}

/**
 * 执行器与参数。**必须按清单声明的 runner 选**：
 * `bun:test`/`node:test` ⇒ `bun --no-env-file test <file>`（裸 node --test 在本树跑不起来，见 test-ci.ts 实测）；
 * `plain` ⇒ `bun --no-env-file <file>`；`python` ⇒ `TESTCI_PYTHON ?? python3 <file>`。
 * 选错执行器的后果本单实测过：plain 脚本按 `bun test` 跑 ⇒ **exit 0 + 0 读数**，是最危险的一种假绿灯。
 */
function caseExec(spec: CaseSpec): { cmd: string; args: string[] } {
  if (spec.runner === 'plain') return { cmd: bunBin(), args: ['--no-env-file', spec.path] }
  if (spec.runner === 'python') return { cmd: process.env.TESTCI_PYTHON?.trim() || 'python3', args: [spec.path] }
  return { cmd: bunBin(), args: ['--no-env-file', 'test', spec.path] }
}

function tscBin(root: string): { cmd: string; pre: string[]; display: string } {
  const js = join(root, 'node_modules/typescript/bin/tsc')
  if (existsSync(js)) return { cmd: process.execPath, pre: [js], display: './node_modules/.bin/tsc' }
  return { cmd: 'npx', pre: ['tsc'], display: 'npx tsc' }
}

function gitRead(root: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 })
  return r.status === 0 ? (r.stdout ?? '') : null
}

/**
 * PROVENANCE 用的身份摘要（**只报告，不参与任何判据**）。
 *
 * 取单次快照：`sha256Hex` 不认识"哪一个更新"，所以调用方必须一次读一样、把结果一起打印 ——
 * HEAD / porcelain / 门源文件各读一次，读数只对它运行时那一刻负责（与各条判据同一口径）。
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 读文件算 sha256（十六进制全文）。读不到 ⇒ `null`（身份读不到就写 `unknown`，不把门判红）。 */
export function sourceSha256(path: string): string | null {
  try {
    return sha256Hex(readFileSync(path))
  } catch {
    return null
  }
}

/** 身份字段的打印口径：全文取前 12 位；读不到一律 `unknown`（`dirty` 那条是 `-1`，沿用原口径）。 */
function id12(hex: string | null): string {
  return hex === null ? 'unknown' : hex.slice(0, 12)
}

const TEST_LIKE = /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs)$/

/**
 * 派生本轮的候选用例集。
 * 两条独立来源，任何一条单独都能发现"新加了回归用例"：
 *  · 工作树：`git status --porcelain` 里的 test-like 文件（本轮新写/改写的）
 *  · 回执：`bugfixHistory/*-<ROUND>.md` 里被引用的 test-like 路径（**回执自己举证用了哪个用例**）
 * `git` 不可用 ⇒ 返回 null ⇒ `caseset-coverage` 判 UNPROVEN（不拿"派生不出"冒充"没 drift"）。
 */
export function deriveRoundCandidates(root: string): { derived: string[]; stale: string[]; fromStatus: number; fromReceipts: number } | null {
  const status = gitRead(root, ['status', '--porcelain'])
  if (status === null) return null
  const fromStatus = status
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((p) => TEST_LIKE.test(p))

  const dir = join(root, 'bugfixHistory')
  if (!existsSync(dir)) return null
  const receipts = readdirSync(dir).filter((f) => f.endsWith(`-${ROUND}.md`))
  const pat = /(?:packages|script|services|distribution)\/[A-Za-z0-9_./-]+\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs)/g
  const cited = new Set<string>()
  for (const f of receipts) {
    const text = readFileSync(join(dir, f), 'utf8')
    for (const m of text.matchAll(pat)) cited.add(m[0])
  }

  const derived: string[] = []
  const stale: string[] = []
  for (const p of new Set([...fromStatus, ...cited])) {
    if (existsSync(join(root, p))) derived.push(p)
    else if (cited.has(p)) stale.push(p)
  }
  return { derived: derived.sort(), stale: stale.sort(), fromStatus: fromStatus.length, fromReceipts: cited.size }
}

/** 清单条目的完整读数（`offline-ci` 的逐条核对要 decision + runner + 理由，不止 decision）。 */
export interface ManifestEntryFull {
  decision: 'include' | 'exclude'
  declaredRunner: string
  reason: string
}

/** 读 CI 清单的**完整**条目。读不到 / 解不开 ⇒ `null`（→ UNPROVEN）。 */
export function readManifestFull(root: string): Map<string, ManifestEntryFull> | null {
  const f = join(root, 'script/test-ci.manifest.json')
  if (!existsSync(f)) return null
  try {
    const m = JSON.parse(readFileSync(f, 'utf8')) as {
      entries?: { path: string; decision: string; declaredRunner?: string; reason?: string }[]
    }
    if (!Array.isArray(m.entries)) return null
    return new Map(
      m.entries.map((e) => [
        e.path,
        { decision: e.decision === 'include' ? 'include' : 'exclude', declaredRunner: e.declaredRunner ?? '?', reason: e.reason ?? '' },
      ]),
    )
  } catch {
    return null
  }
}

/** 读 CI 清单（`script/test-ci.manifest.json`）⇒ 路径 → 是否纳入。读不到 / 解不开 ⇒ `null`（→ UNPROVEN）。
 *  **导出**：`manifest-gate-gap` 的负对照与"冻结点复算"都要能在不改门的前提下驱动它。 */
export function readManifest(root: string): Map<string, 'include' | 'exclude'> | null {
  const full = readManifestFull(root)
  if (full === null) return null
  return new Map([...full].map(([p, e]) => [p, e.decision]))
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = 'GREEN' | 'RED' | 'UNPROVEN' | 'PARTIAL'

/** 四档裁决的**唯一**枚举（`--expect` 的取值域也用它：非法值 ⇒ 参数守卫 4，不许静默永不匹配）。 */
export const VERDICTS: readonly Verdict[] = ['GREEN', 'RED', 'UNPROVEN', 'PARTIAL']

export function aggregate(criteria: CriterionResult[], partial: boolean): Verdict {
  if (partial) return 'PARTIAL'
  if (criteria.some((c) => c.status === 'RED')) return 'RED'
  if (criteria.some((c) => c.status === 'UNPROVEN')) return 'UNPROVEN'
  return 'GREEN'
}

const EXIT_OF: Record<Verdict, number> = { GREEN: GREEN_EXIT, RED: RED_EXIT, UNPROVEN: UNPROVEN_EXIT, PARTIAL: PARTIAL_EXIT }

const PAD = 34

function line(c: CriterionResult): string {
  const metrics = Object.entries(c.metrics)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return `${c.id.padEnd(PAD)} ${c.status.padEnd(9)} ${metrics}`
}

interface Options {
  root: string
  only?: string
  casesFile?: string
  selftest: boolean
  expect?: Verdict
  jsonPath?: string
  quiet: boolean
}

function loadCases(path: string | undefined, root: string): CaseSpec[] {
  if (!path) return [...CASES]
  const raw = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Partial<CaseSpec>[] | { cases: Partial<CaseSpec>[] }
  const rows = Array.isArray(raw) ? raw : raw.cases
  return rows.map((r, i) => ({
    id: r.id ?? `case-${i}`,
    path: r.path!,
    theme: (r.theme ?? 'other-round') as Theme,
    runner: (r.runner ??
      detectRunnerStyle(existsSync(resolve(root, r.path!)) ? readFileSync(resolve(root, r.path!), 'utf8') : '', r.path!)) as CaseSpec['runner'],
    ci: (r.ci ?? 'unregistered') as CaseSpec['ci'],
    purpose: r.purpose ?? '（自检夹具）',
    minPass: r.minPass ?? 1,
    minAssert: r.minAssert ?? 1,
    minSites: r.minSites ?? 0,
    claimPass: r.claimPass,
    waiveSkip: r.waiveSkip,
    waiveSkipReason: r.waiveSkipReason,
    citedBy: r.citedBy ?? 0,
  }))
}

function runCases(specs: CaseSpec[], root: string, quiet: boolean, timeoutMs: number): CaseReading[] {
  const readings: CaseReading[] = []
  for (const spec of specs) {
    // resolve 而不是 join：自检夹具是 tmp 里的绝对路径，不能被拼到 root 后面去。
    const full = resolve(root, spec.path)
    if (!existsSync(full)) {
      readings.push({ spec, ran: false, exit: null, counts: parseCaseOutput(''), staticSites: 0, ms: 0, infra: '用例文件缺失' })
      if (!quiet) writeTo(1, `  · ${spec.id.padEnd(38)} UNPROVEN 文件缺失\n`)
      continue
    }
    const source = readFileSync(full, 'utf8')
    const { cmd, args } = caseExec(spec)
    const r = run(cmd, args, root, timeoutMs)
    const reading: CaseReading = {
      spec,
      ran: true,
      exit: r.code,
      counts: parseCaseOutput(r.out),
      staticSites: countAssertSites(source),
      ms: r.ms,
      infra: r.infra,
    }
    readings.push(reading)
    if (!quiet) {
      const e = evalCase(reading)
      writeTo(1, `  · ${spec.id.padEnd(38)} ${e.status.padEnd(9)} ${e.note.padEnd(22)} ${r.ms}ms\n`)
    }
  }
  return readings
}

/**
 * preflight 判据的判定（纯函数，便于负对照）。读不出读数时**不许把"没量到"混进绿**，
 * 而且要**说清是哪一种没量到**：收尾行缺失（输出被截断的典型形状）与"列表还在、只是不一致"是两回事。
 */
export function evalPreflightCriterion(
  raw: string,
  exit: number | null,
  ms: number,
  capture: 'file' | 'pipe' = 'file',
): CriterionResult {
  const title = 'preflight（四类配置问题）'
  const p = parsePreflight(raw, exit)
  if (!p) {
    // 诊断面：列表行数 + 末尾是否完整。截断的典型形状是**末行没有换行收尾**（停在半行上）。
    const listingLines = (raw.match(/^(?:RUN |SKIP\t|MISSING\t|UNCLASSIFIED\t|CONFIG-ERROR\t|RUNNER-MISMATCH\t)/gm) || []).length
    const endsClean = raw.endsWith('\n')
    return {
      id: 'preflight',
      title,
      status: 'UNPROVEN',
      metrics: { exit: exit ?? -1, ms, capture, listingLines, outputComplete: endsClean ? 1 : 0 },
      findings: [
        `preflight 收尾行（# include=… exclude=… missing=…）读不到 ⇒ 无读数；exit=${String(exit)}；采集面=${capture}` +
          `；列表行=${listingLines}；输出末尾${endsClean ? '完整（不是被截断的形状）' : '**停在半行上 ⇒ 疑似管道截断**'}` +
          `（本门的子进程输出已落文件；若仍读到截断，先查执行器与采集面，不要改判据）`,
      ],
      waivers: [],
    }
  }
  const bad = p.unclassified.length + p.configErrors.length + p.missing
  return {
    id: 'preflight',
    title,
    status: p.exit === 0 && bad === 0 && p.include > 0 ? 'GREEN' : 'RED',
    metrics: {
      include: p.include,
      exclude: p.exclude,
      missing: p.missing,
      unclassified: p.unclassified.length,
      config: p.configErrors.length,
      runnerMismatch: p.runnerMismatch.length,
      exit: p.exit ?? -1,
      ms,
      capture,
    },
    findings: [
      ...p.unclassified.map((x) => `UNCLASSIFIED：${x}（发现规则扫到但清单未覆盖 ⇒ fail-closed）`),
      ...p.configErrors.map((x) => `CONFIG-ERROR：${x}`),
      ...p.missingNames.map((x) => `MISSING：清单里写明要跑、磁盘上没有：${x}（不是"跳过"，是"说要跑却没得跑"）`),
      ...(p.include === 0 ? ['include=0：纳入集是空的，"没有失败"来自"什么都没跑"'] : []),
    ],
    waivers: [],
  }
}

function execCriteria(root: string, quiet: boolean): CriterionResult[] {
  const out: CriterionResult[] = []

  // 1) preflight：四类配置问题
  {
    const r = runPackageScript('preflight', [], root, 600_000)
    out.push(evalPreflightCriterion(r.out, r.code, r.ms, r.capture))
  }

  // 2) gate:drivers：门必须有驱动（空转实现的 exit 0 与通过无法从退出码区分）
  {
    // 注意脚本名是 `gate:drivers`（带冒号，见 package.json）。写成连字符会得到
    // `error: Script not found` + exit 1 —— 本 gate 首版就踩过，所以这里把 stderr 也带进点名。
    // **机器结果只读 stdout**（GATE-AB-20260927）：真实调用的合法 JSON 在 stdout，而 package.json
    // 脚本前缀 `[ -x "$npm_execpath" ] && …` 在 stderr；拼起来解析会被 stderr 的方括号切坏 ⇒ UNPROVEN。
    const r = runPackageScript('gate:drivers', ['--json'], root, 300_000)
    out.push(evalGateDriversCriterion(parseGateDrivers(r.stdout, r.code), r.code, r.ms, r.stdout, r.stderr, r.infra))
  }

  // 2.5) env-self-link-guard：退化链接只读守卫（P10 的 D2；作用域按 V15 §B.1 + Lead 裁决扩大）
  //      走 `run()` 直接跑脚本、不新开 package.json 脚本名 —— 少一处与并发工作面抢的共享面。
  //      这条**只读**：脚本不 rm / 不 symlink / 不写任何文件（唯一写动作是 stdout）。
  //      与 gate:drivers 同一条纪律：**JSON 机器结果只读 stdout**（诊断可能在 stderr 里带 `{}`，
  //      按"第一个 `{` 到最后一个 `}`"解析会被它污染）。preflight/tsc 是行协议，仍读混合 `out`
  //      （多出的诊断行不会匹配 `RUN \t`/`error TS`，而 tsc 的 stderr 诊断一个字都不能丢）。
  {
    const r = run(bunBin(), ['run', join(root, 'script/env-self-link-guard.ts'), '--json'], root, 300_000)
    out.push(evalSelfLinkCriterion(r.stdout, r.code, r.ms, r.capture))
  }

  // 3/4) 双 tsc
  for (const [id, config] of [
    ['tsc-product', 'tsconfig.json'],
    ['tsc-gates', 'script/tsconfig.gates.json'],
  ] as const) {
    const tsc = tscBin(root)
    const r = run(tsc.cmd, [...tsc.pre, '-p', config, '--listFiles'], root, 1_800_000)
    const t = parseTscOutput(r.out, r.code, root)
    if (!t)
      out.push({
        id,
        title: `${tsc.display} -p ${config} --listFiles`,
        status: 'UNPROVEN',
        metrics: { exit: r.code ?? -1, signal: r.signal ?? '-', ms: r.ms },
        findings: [`tsc 没报出任何文件 ⇒ 无读数（编译闭包为空或 tsc 没起来）；exit=${String(r.code)}${r.signal ? ` signal=${r.signal}` : ''}${r.infra ? ` infra=${r.infra}` : ''}`],
        waivers: [],
      })
    else out.push(evalTscCriterion(id, `${tsc.display} -p ${config} --listFiles`, t, r.ms, r.signal))
  }
  return out
}

function main(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(name)

  const root = resolve(arg('--root') ?? ROOT)
  const selftest = has('--selftest')
  const casesFile = arg('--cases')
  const expectRaw = (arg('--expect') ?? '').toUpperCase()
  if (casesFile && !selftest) {
    writeTo(2, 'release-gate：`--cases` 只用于负对照自检，必须与 `--selftest` 同用。\n' + '（否则任何人都能用一份自造用例表把发布门刷绿 —— 那正是本门要防的事。）\n')
    return ARGS_EXIT
  }
  // `--selftest` 与 `--expect` **必须成对**（GATE-SELFTEST-EXIT-DOOR 单）：退出码不再"由调用方指定"，
  // `--expect` 只回答"自检是否通过"。缺一个 ⇒ 参数守卫 4 —— 而 4 不是 0（改前缺 `--expect` 时自检必然
  // "不通过"，但那是**碰巧**；现在把它变成参数错误，省得读的人去猜）。
  if (selftest && !(VERDICTS as readonly string[]).includes(expectRaw)) {
    writeTo(
      2,
      'release-gate：`--selftest` 必须与 `--expect <GREEN|RED|UNPROVEN|PARTIAL>` 同用。\n' +
        '（自检的退出码取**实测裁决**，不由调用方指定；`--expect` 只用来判"自检是否通过"。\n' +
        '  `--selftest --cases` 夹具模式的自检通过码是 6 —— 它**永远不是 0**，因为它跑的不是发布用例表。）\n',
    )
    return ARGS_EXIT
  }
  if (!selftest && arg('--expect') !== undefined) {
    writeTo(2, 'release-gate：`--expect` 只用于 `--selftest` 自检，单独用等于"写了期望却没人比"。\n')
    return ARGS_EXIT
  }
  const opts: Options = {
    root,
    only: arg('--only'),
    casesFile,
    selftest,
    expect: selftest ? (expectRaw as Verdict) : undefined,
    jsonPath: arg('--json'),
    quiet: has('--quiet'),
  }
  /**
   * 夹具模式：`--selftest --cases <f>`。跑的**不是发布用例表**，所以：
   *  · 结构性判据（preflight / gate-drivers / tsc×2 / caseset-coverage / manifest-gate-gap）**如实不跑** ——
   *    它们量的是 `--root` 那棵树，对夹具无意义（`--root` 还可能指向一棵没有 tsconfig 的冻结副本）；
   *  · 退出码**永不为 0**（自检通过 = `SELFTEST_EXIT=6`），见文件头「`--selftest` 不许成为"退 0 的口"」。
   */
  const fixtureMode = selftest && casesFile !== undefined
  const runStructural = !fixtureMode

  const specs = loadCases(opts.casesFile, root)
  const t0 = Date.now()
  /** 这次跑的是哪一档（机器可读）：发布裁决 / 自检 full / 自检夹具。与 `--selftest` 的表头同一口径。 */
  const gateMode = opts.selftest ? (fixtureMode ? 'selftest-fixture' : 'selftest-full') : 'release'
  // ── 身份快照（只报告，不参与判据）────────────────────────────────────────────
  // `gate=`：执行中的那份门源文件。`--root` 指向别处时它未必是 `<root>/script/release-gate.ts`，
  //          所以连路径一起打印（`gateFile=`）—— 否则"冻结副本跑真仓"这种口径会被误读成真文件。
  const gatePath = GATE_SOURCE
  const gateSha = sourceSha256(gatePath)
  const gateFile = relative(root, gatePath) || gatePath
  const head = gitRead(root, ['rev-parse', 'HEAD'])?.trim() ?? 'unknown'
  // porcelain 只读一次：`dirty`（条数）与 `worktree=`（同一份文本的 sha256）必须出自**同一次**快照，
  // 否则"条数相同、集合不同"这一档会被两次读之间的树变化悄悄抹平。条数的算法与原来逐字一致。
  const porcelain = gitRead(root, ['status', '--porcelain'])
  const dirty = porcelain === null ? -1 : porcelain.split('\n').filter(Boolean).length
  const worktreeSha = porcelain === null ? null : sha256Hex(porcelain)

  // `--only` 只用于调试：命中的判据才跑，且**裁决强制为 PARTIAL（exit 3，永不为 0）**。
  // 非回归判据（如 --only tsc）时连用例进程都不起，省掉 90 秒。
  const only = opts.only
  const onlyHitsRegression = Boolean(only) && THEMES.some((t) => `regression.${t}`.includes(only!))
  const specsToRun = only ? (onlyHitsRegression ? specs.filter((s) => `regression.${s.theme}`.includes(only!) || s.id.includes(only!)) : []) : specs

  const w = (s: string) => writeTo(1, s)
  if (!opts.quiet) {
    w(
      `\nrelease-gate · P9（${ROUND_LABEL}）· 一条命令 = 本轮发布门` +
        `${opts.selftest ? `  [SELFTEST 自检模式 · ${fixtureMode ? 'fixture（--cases 夹具：跑的不是发布用例表，退出码永不为 0）' : 'full（跑的是发布判据集合）'}]` : ''}\n`,
    )
    w(`PROVENANCE  gate=${id12(gateSha)}  gateFile=${gateFile}  HEAD=${head.slice(0, 12)}  dirty=${dirty}  worktree=${id12(worktreeSha)}  bun=${process.versions.bun ?? '?'}  node=${process.versions.node}  root=${root}\n`)
    // 机器可读的**跑法**与**负对照哨兵**（机制 12）：只报告、不参与判据。
    // `mode=` 让人一眼分清「发布裁决」与两种自检；`negctl=` 非 `none` ⇒ **这不是交付态读数**。
    w(`GATE-MODE  mode=${gateMode}  negctl=${NEGATIVE_CONTROL ?? 'none'}${NEGATIVE_CONTROL !== null ? '  ⇒ **这不是交付态**：门正跑在负对照态上（规矩见 docs/VERIFICATION_MECHANISMS.md 机制 12）' : ''}\n`)
    w(`用例集来源   ${opts.casesFile ? `--cases ${opts.casesFile}（自检夹具，不是发布用例表）` : `内建 CASES 表（${specs.length} 条，${ROUND_LABEL} 实测冻结）`}\n`)
    if (only) w(`调试子集     --only ${only} ⇒ 本次跑 ${specsToRun.length}/${specs.length} 条用例，裁决必为 PARTIAL\n`)
    w(`\n逐条用例读数\n`)
  }

  const readings = runCases(specsToRun, root, opts.quiet, 600_000)

  const criteria: CriterionResult[] = []
  /** ③ 的明细（全量"没进门"清单）：只在 `--json` 报告里给，判据行上给条数与摘要。 */
  let manifestGapForReport: { includeTestLike: number; gateRuns: number; waived: number; notRun: string[]; digest: string } | null = null
  /** GATE-C：本次离线 CI 证据的机器可读摘要（判据行只给计数；全量日志路径在这里）。 */
  let offlineCiForReport: Record<string, number | string | boolean | null> | null = null
  /** GATE-C：候选逐项归属全量（判据行给各类计数；逐条清单在这里）。 */
  let coverageAttributionForReport: (CoverageAttribution & { staleCitation: string[] }) | null = null
  // 结构性命据（preflight / gate-drivers / tsc×2 / offline-ci / caseset-coverage / manifest-gate-gap）：
  // **发布跑什么，`--selftest`（full 模式）就跑什么** —— 否则自检就是一条"跳过判据还能退 0"的口子。
  // 唯一例外是 `offline-ci` 的**完整 CI 子进程**：只在依赖它的跑法（全量发布 / `--only` 命中依赖判据）才起，
  // 避免 `test-ci → release-gate.test.ts → full 自测(--only gate-drivers)` 递归回完整 CI。
  if (runStructural) criteria.push(...execCriteria(root, opts.quiet))
  for (const theme of THEMES) {
    const mine = readings.filter((r) => r.spec.theme === theme)
    if (mine.length === 0) continue
    criteria.push(evalTheme(theme, readings))
  }
  criteria.push(evalClaimConsistency(readings))
  if (runStructural) {
    const manifestFull = readManifestFull(root)
    const manifest = manifestFull === null ? null : new Map([...manifestFull].map(([p, e]) => [p, e.decision]))
    const runOfflineCi = offlineCiNeededFor(only)
    const evidence = runOfflineCi ? collectOfflineCi(root, OFFLINE_CI_BUDGET_MS) : null
    if (runOfflineCi) criteria.push(evalOfflineCiCriterion({ evidence, manifest: manifestFull }))
    // 只有"报告解得开 + 逐条与当前清单一致"时才采信它的实际执行/通过集合；否则一律当**没有证据**：
    // 不拿清单 include 当 declared 填充，也不把解不开的报告当覆盖。
    const report = evidence?.reportRaw != null ? parseOfflineCiReport(evidence.reportRaw) : null
    const validation = report !== null && manifestFull !== null ? validateOfflineCiReport(report, manifestFull, evidence!.exit) : null
    const trust = validation !== null && validation.problems.length === 0
    const offlineRan = trust ? validation!.ran : []
    const offlinePassed = trust ? validation!.passed : []
    if (evidence) {
      offlineCiForReport = {
        ran: runOfflineCi,
        exit: evidence.exit,
        reportPath: evidence.reportPath,
        logDir: evidence.logDir,
        filter: report?.filter ?? null,
        include: report?.summary.included ?? -1,
        ranCount: offlineRan.length,
        passed: offlinePassed.length,
        failed: validation?.failed.length ?? -1,
        missing: validation?.missing.length ?? -1,
        excluded: validation?.excluded.length ?? -1,
        validationProblems: validation?.problems.length ?? -1,
        trusted: trust,
      }
    }
    const cand = deriveRoundCandidates(root)
    if (!manifest || !cand) {
      criteria.push({
        id: 'caseset-coverage',
        title: '用例集合反查（工作树 + 本轮回执 → 门里是否都接了）',
        status: 'UNPROVEN',
        metrics: { derived: 0, declared: specs.length, drift: 0 },
        findings: [`${!manifest ? 'script/test-ci.manifest.json 读不到' : 'git 不可用'} ⇒ 反查不出候选集 ⇒ 无读数（不拿"派生不出"冒充"没 drift"）`],
        waivers: [],
      })
    } else {
      const excludeReasons =
        manifestFull === null
          ? undefined
          : new Map([...manifestFull].filter(([, e]) => e.decision === 'exclude').map(([p, e]) => [p, e.reason]))
      const coverageInput: CoverageInput = {
        derived: cand.derived,
        declared: specs.map((s) => s.path),
        offlineExecuted: offlinePassed,
        manifest,
        excludeReasons,
        staleCitation: cand.stale,
        waivers: COVERAGE_WAIVERS,
      }
      coverageAttributionForReport = { ...coverageAttribution(coverageInput), staleCitation: cand.stale }
      criteria.push(evalCoverage(coverageInput))
      // ③ 「清单 include 里有多少条没进门」——**必须在每条读数上报出来**，并由冻结值守着（不许悄悄长）。
      // **按实际执行集合**衡量：重点回归路径 + 本次离线 CI **实际执行**的 include 路径
      // （不是拿清单 include 当 declared 填充；没有证据时 offlineRan=[]，退回只看重点回归）。
      const declaredForGap = [...specs.map((s) => s.path), ...offlineRan]
      const gap = manifestGateGap(manifest, declaredForGap, COVERAGE_WAIVERS)
      manifestGapForReport = {
        includeTestLike: gap.includeTestLike.length,
        gateRuns: gap.declared.length,
        waived: gap.waived.length,
        notRun: gap.notRun,
        digest: manifestGapDigest(gap.notRun),
      }
      criteria.push(evalManifestGap(manifest, declaredForGap, COVERAGE_WAIVERS, MANIFEST_GAP_FROZEN))
    }
  }
  criteria.push(evalCaseIntegrity(readings, root))
  // ④ 冻结下限漂移 + 冻结基线：`minPass` 低于实测 ⇒ 删掉 N 条仍然绿；实测**低于冻结基线** ⇒ 已经删过。
  // 第三个参数是"这次跑的是不是全量内建用例表"：`--only` 子集与 `--selftest --cases` 夹具跑的不是同一批
  // 用例，拿它们报"基线里的用例没了"（`gone`）是假红 ⇒ 只有全量内建跑法才判 `gone`。
  criteria.push(evalFloorDrift(readings, FLOOR_BASELINE_FROZEN, !opts.only && !fixtureMode))
  criteria.push(evalSkipAccounting(readings))
  criteria.push(evalSelfCheck(criteria, readings, specsToRun.length))

  const filtered = opts.only ? criteria.filter((c) => c.id.includes(opts.only!)) : criteria
  // `--only`（子集）**在两种模式里**都判 PARTIAL：子集永不为绿。改前这一条被 `!opts.selftest` 豁免，
  // 于是 `--selftest --only <子集>` 可以拿着"只跑了两条判据"的结果退 0 —— 与"退 0 的口"同一形状。
  const partial = Boolean(opts.only)
  const verdict = aggregate(filtered, partial)

  if (!opts.quiet) {
    w(`\n判据（每条都带自己的数字；没有数字 = UNPROVEN，不是通过）\n`)
    for (const c of filtered) w(`${line(c)}\n`)
    const named = filtered.filter((c) => c.findings.length > 0)
    if (named.length > 0) {
      w(`\n点名（RED / UNPROVEN / 登记项的逐条原因）\n`)
      for (const c of named) for (const f of c.findings) w(`  ${c.status.padEnd(9)} ${c.id}  ${f}\n`)
    }
    const waived = filtered.filter((c) => c.waivers.length > 0)
    if (waived.length > 0) {
      w(`\n已登记、不算通过的豁免（开着写在明面上）\n`)
      for (const c of waived) for (const x of c.waivers) w(`  WAIVED    ${c.id}  ${x}\n`)
    }
  }

  // 机制 13（门绿 ≠ CI 绿）：这个数**必须一直印着**，而且印在收尾区 —— 只 `| tail` 的人也看得到。
  // 判据行上已经有它（`manifest-gate-gap` 的 `notRun=`）；这里是同一份数字的第二次露出，
  // **不是**新的判据、不改任何门槛。GATE-C 起：`gateRuns` = 重点回归 ∪ **本次离线 CI 实际执行**的
  // include 路径（不是拿清单 include 填的）；没有证据时退回只看重点回归。
  if (!opts.quiet && manifestGapForReport)
    w(
      `\nCI-GAP  includeTestLike=${manifestGapForReport.includeTestLike}  gateRuns=${manifestGapForReport.gateRuns}` +
        `  waived=${manifestGapForReport.waived}  notRun=${manifestGapForReport.notRun.length}  digest=${manifestGapForReport.digest}` +
        `  offlineExecuted=${offlineCiForReport ? offlineCiForReport.passed : 'n/a'}` +
        `\n        ⇒ notRun 是"既没进重点回归、也**没被本次离线 CI 实跑**"的条数；本次离线 CI 只在依赖它的` +
        `跑法（全量发布 / --only 命中 caseset-coverage·manifest-gate-gap·offline-ci）才起，没有证据时 ` +
        `gateRuns 退回只看重点回归。**门绿只覆盖本门范围（离线行为 + 静态合同），不等于真机/图形/GPU/账户/打包验收通过。**` +
        `（全量见 --json 的 manifestGap.notRun / coverageAttribution / offlineCi；规矩见 docs/VERIFICATION_MECHANISMS.md 机制 13）\n`,
    )

  const counts = {
    green: filtered.filter((c) => c.status === 'GREEN').length,
    red: filtered.filter((c) => c.status === 'RED').length,
    unproven: filtered.filter((c) => c.status === 'UNPROVEN').length,
  }
  const elapsed = Date.now() - t0

  /**
   * **实际要退的码**（GATE-SELFTEST-EXIT-DOOR 单）。与改前最大的区别：`--expect` **不再决定退几**。
   *
   * | 情形 | 退几 |
   * | --- | --- |
   * | 发布模式 | `EXIT_OF[verdict]`（语义一个字没改） |
   * | 自检 · 期望不符 | `1`（自检不通过） |
   * | 自检 · 期望相符 · 夹具模式（`--cases`） | **`6`**（永不为 0：跑的不是发布用例表） |
   * | 自检 · 期望相符 · full 模式 | **`EXIT_OF[verdict]`** ⇒ 只有"判据集合全绿"才可能是 0 |
   */
  const selftestMatched = opts.selftest && opts.expect !== undefined && verdict === opts.expect
  const finalCode = !opts.selftest ? EXIT_OF[verdict] : selftestMatched ? (fixtureMode ? SELFTEST_EXIT : EXIT_OF[verdict]) : RED_EXIT

  const report = {
    schema: 1,
    gate: 'release-gate',
    round: ROUND_LABEL,
    generatedAt: new Date().toISOString(),
    provenance: {
      // 门自己（执行中那份源文件）：全文 sha256 + 路径。两次读数不同时先看这两个。
      gate: { path: gatePath, sha256: gateSha },
      // 被量对象：HEAD + porcelain 条数 + porcelain 文本的摘要（条数相同、集合不同也分得开）。
      head,
      dirty,
      worktreeSha256: worktreeSha,
      bun: process.versions.bun ?? null,
      node: process.versions.node,
      root,
      // 跑法 + 负对照哨兵（机制 12）：机器可读，读报告的人不必去猜"这是不是交付态"。
      mode: gateMode,
      negativeControl: NEGATIVE_CONTROL,
    },
    /** ④ 的冻结基线（只报告）：`at`/`digest`/条数；逐条实测值在 `cases[].pass` 里。 */
    floorBaseline: {
      at: FLOOR_BASELINE_FROZEN.at,
      digest: FLOOR_BASELINE_FROZEN.digest,
      cases: Object.keys(FLOOR_BASELINE_FROZEN.pass).length,
    },
    verdict,
    // 与**进程实际退出码**一致（自检模式下不等于 `EXIT_OF[verdict]`，见 `finalCode`）。
    exit: finalCode,
    verdictExit: EXIT_OF[verdict],
    selftest: opts.selftest,
    selftestMode: opts.selftest ? (fixtureMode ? 'fixture' : 'full') : 'release',
    expected: opts.expect ?? null,
    /** ③ 的全量明细：清单 include 里发布门**不跑**的用例（判据行上只有条数与摘要）。 */
    manifestGap: manifestGapForReport,
    /** GATE-C：本次离线 CI 的报告/日志来历与逐项计数（`reportPath`/`logDir` 是证据锚点）。 */
    offlineCi: offlineCiForReport,
    /** GATE-C：候选逐项归属全量（每一条只进一类；含 15 条陈旧引用，保留为历史提示）。 */
    coverageAttribution: coverageAttributionForReport,
    elapsedMs: elapsed,
    summary: { criteria: filtered.length, ...counts },
    cases: readings.map((r) => ({
      id: r.spec.id,
      path: r.spec.path,
      theme: r.spec.theme,
      purpose: r.spec.purpose,
      runner: r.spec.runner,
      ci: r.spec.ci,
      status: evalCase(r).status,
      pass: r.counts.pass,
      fail: r.counts.fail,
      skip: r.counts.skip,
      assertions: r.counts.assertions,
      format: r.counts.format,
      exit: r.exit,
      ms: r.ms,
      minPass: r.spec.minPass,
      minAssert: r.spec.minAssert,
      minSites: r.spec.minSites,
      staticSites: r.staticSites,
      claimPass: r.spec.claimPass ?? null,
    })),
    criteria: filtered.map((c) => ({ ...c })),
  }
  if (opts.jsonPath) writeFileSync(resolve(root, opts.jsonPath), `${JSON.stringify(report, null, 2)}\n`)

  if (NEGATIVE_CONTROL !== null)
    w(`\nNEGATIVE-CONTROL  negctl=${NEGATIVE_CONTROL}  ⇒ **这不是交付态读数**（负对照态；规矩见 docs/VERIFICATION_MECHANISMS.md 机制 12）\n`)

  if (opts.selftest) {
    w(
      `\nSELFTEST  mode=${fixtureMode ? 'fixture' : 'full'}  cases=${opts.casesFile ?? 'builtin'}  expected=${opts.expect ?? '(缺 --expect)'}` +
        `  actual=${verdict}  ⇒ ${selftestMatched ? '自检通过' : '自检不通过'}  exit=${finalCode}` +
        `${selftestMatched && fixtureMode ? '（夹具模式的通过码 6：**这不是发布通过**）' : ''}\n`,
    )
    return finalCode
  }

  w(
    `\nVERDICT  ${verdict}  criteria=${filtered.length} green=${counts.green} red=${counts.red} unproven=${counts.unproven}` +
      `  cases=${readings.length}  elapsed=${(elapsed / 1000).toFixed(1)}s\n`,
  )
  if (verdict === 'GREEN') w('COMMIT-OK  每条判据都有读数且达标；这是"对的"的**必要**条件，不是充分条件（真机/图形/账户面不在本门内）\n')
  else if (verdict === 'RED') w('BLOCKED   有判据实测不达标：按上面「点名」逐条修，不要靠改门槛变绿\n')
  else if (verdict === 'UNPROVEN') w('BLOCKED   没有红，但有判据产不出读数：UNPROVEN 不是通过，补环境或补证据后再判\n')
  else w('PARTIAL   只跑了子集，本结果永不代表发布通过\n')
  w(`exit=${finalCode}\n`)
  return finalCode
}

/**
 * 收尾：**不许在最后一次 `write` 之后立刻 `process.exit()`**（与 `script/test-ci.ts` 同一形状、同一修法）。
 *
 * Bun 的 stdout/stderr 在**管道**上是异步刷写：`main()` 的最后一次写是 `exit=…` 那一行，紧跟一次
 * 硬切的 `process.exit(code)` 会把还没冲刷出去的那一截一起丢掉，**而退出码不变** ⇒
 * `bun run release-gate | grep …`、CI 抓输出、任何解析它的脚本都会偶发"少一截却看起来成功"。
 *
 * 本单实测（bun 1.3.13；读端 = Bun `spawnSync` + 管道，与 P23 复现那条的口径一致）：
 *  · **真实体量**（11.8 KB / 111 行 / 65 条用例）经管道 **0/300 丢** —— 如实登记：这一档本机**没有**
 *    复现出丢尾（同形快速口径 300 次亦 0），所以这条修法在本门当前体量下不是"已知正在丢"，
 *    而是**同一类缺陷的潜伏形态**：丢尾是静默的（`exit` 仍是 0），一旦收尾 burst 变大就会兑现。
 *  · 把收尾 burst 只放大到真实体量的 **1.8× / 3.6×**（100 / 200 条缺件夹具 ⇒ 21,691 / 42,791 字符输出）
 *    就复现：**1/300 与 11/300（3.7%）丢**，其中 3 次正好停在 30,367 字符 —— 与 P23 在 `test-ci.ts` 上
 *    独立测到的 30,758 字符**同一量级**（同一条竞态、同一类截断签名）；`process.exitCode` 版 **0/300**。
 *  · **放大到门自己的收尾 burst**（单条夹具用例 id 撑到 8 MB ⇒ `runCases` 那一行就是一次 ~8 MB 的
 *    write，随后走同一收尾与退出点）**300/300 丢**：输出停在 0.65–11.7 MB 处、收尾行与末尾换行都没了、
 *    **`exit` 仍是 0**。`process.exitCode` 版 **0/300**，25,166,868 字符逐字节完整。
 *  · 还原（改回 `process.exit(...)`）⇒ 300/300 重现；再改回 `process.exitCode` ⇒ 0/300。
 *  · 同一个放大夹具**落文件**（`> out.txt`）改前也不丢（8/8 完整）⇒ 受害面就是**管道**这一档。
 *
 * `process.exitCode = code` 让事件循环把 stdout/stderr 排空后**自然退出**；退出码语义一个字不变
 * （0 GREEN / 1 RED / 2 UNPROVEN / 3 PARTIAL / 4 参数守卫 / 5 EPIPE 输出被截断，见下）。
 *
 * **本文件没有挂住的句柄**（所以不需要"先显式清理再 exitCode"）：全文只有同步 API ——
 * `spawnSync` 会等到子进程被回收才返回（`run()` 里还先 `closeSync` 了两个 fd），
 * 无 `setTimeout`/`setInterval`/`setImmediate`、无事件监听、无 `Bun.spawn`、无 `async`/`await`。
 * 实测改后全量门 wall=81–83s、exit=0，与改前同 ⇒ 没有"等 drain 变慢"，也没有挂住不退。
 *
 * ## EPIPE = 独立退出码 5（GATE-EPIPE-EXIT-CODE 单，2026-09-26）
 *
 * 消费者提前走人时（`bun run release-gate | head -1`）**不许**让门退成 0。
 * EPIPE 意味着**消费者走了、判据没送达**：那不是"绿"，也不是"红"，是"**没人听**"。
 * 退成 0 就是本仓反复抓的那个形状——「一个说谎的成功信号」。所以：
 *
 *  · 输出层（`writeTo` / `flushCheck`）捕获 stdout 的 `EPIPE`（**同步**系统调用抛的，不是流事件），
 *    置 `stdoutPipeClosed`；
 *  · 入口据此把退出码改写成 `EPIPE_EXIT = 5`，**覆盖**裁决码（判据送不到时，"它是几"没有意义）；
 *  · stderr 打一行说明"输出被截断、判据未送达、这不是 RED"（`EPIPE_NOTICE`），**恰好一次**；
 *  · **不吞判据**：读满时（`| cat`、`| wc -l`、`> out.txt`）退出码语义一个字不改
 *    （0/1/2/3/4 逐字照旧），截断才是 5。
 *
 * 改前实测（bun 1.3.13，`| head -1`）：门在 `main()` 的写里被**未捕获的 EPIPE** 打死 ⇒ **exit=1**，
 * 与 RED 逐字同码（3/3 重现）⇒ CI 里 `release-gate | head/grep -q` 会被**误读成门红了**。
 * 改后同一命令 exit=5，stderr 有那一行说明；`| head -100000`（读满）⇒ 仍是原语义。
 */
if (import.meta.main) {
  const code = main(process.argv.slice(2))
  // 收尾探针放在**最后一次真写之后**：判据与 `exit=` 行都已经写出去了，此刻才问"读端还在不在"。
  flushCheck()
  process.exitCode = stdoutPipeClosed ? EPIPE_EXIT : code
}
