/**
 * CCMM-07：CI **真实离线行为**入口（有界、可复跑、逐文件独立进程、传播真实退出码）。
 *
 * 存在理由：CI 里此前只有 bootstrap / 构建 / 三套 tsc / 资产布局 / 锁一致性——全是**静态**检查，
 * 行为一个没跑。本入口把"默认安全"的离线行为用例真的跑起来，并把**没跑的**用例连同理由一起吐出来，
 * 让"通过"只等于"跑过并通过"，而不是"没跑所以没红"。
 *
 * 硬判据（都必须体现在报告里，不许静默）：
 *  1. **runner 独立进程**：每个用例文件一个进程，不把 bun/python 混进同一个进程，也不把失败吞掉；
 *     harness 自己的退出码 = 0 全过 / 1 有行为失败或超时 / 2 配置或分类问题。
 *  2. **默认安全集合**：只跑无 `realmodel`/`net_fetch`/`hf_download`/`gpu_cuda`/`unity`/`blender`/`isaac`/`envgate`
 *     标记的用例。其余一律 **exclude 且带理由**（`not-run` ≠ `pass`）。
 *  3. **fail-closed 分类**：发现规则（见 `isTestLikeName`，双单引号 + 扩展名都认）扫到、但清单里没有的文件
 *     ⇒ 报 `unclassified` 并以退出码 2 结束。没被人工审过的新用例不会被"顺手跑绿"。
 *  4. **纳入的文件缺失 = 配置错误**（CCMM-09）：`decision=include` 而磁盘上没有的条目**不是跳过**，
 *     ⇒ 记 `status=missing`、点名文件、harness 退出码 **2**。`--list` 与 run 模式都点名，且**不被
 *     `--filter` 掩盖**（判定看的是全部纳入条目的存在性，不是本次筛选子集）。exclude 条目不在此列——
 *     "有意不跑" 与 "该跑的不在" 是两回事，后者不许顶着 exit 0 混过去。
 *  5. **执行器解析与调用方 shell 的 PATH 无关**（NESTED-BUN-127）：`resolveBun()` 四路兜底
 *     （TESTCI_BUN / `process.execPath` / PATH / `$HOME|%USERPROFILE%|passwd 库` 的 `.bun/bin/bun`），
 *     都认不出时返回 `null` 并**在起任何子进程之前**由 `executorProblem()` 点名 ⇒ 退出码 2。
 *     改前是拿名字 `spawn('bun')`：bun 不在 PATH 时每条用例各撞一次 ENOENT，报告里写成
 *     「真实非 0 退出码 127」（本机实测 1/1 条红、exit=1）——把"没有执行器"说成了"用例失败"。
 *
 * runner 实测映射（2026-09-23，本树，见 REPORT）：
 *  · `bun:test`  ⇒ `TESTCI_BUN --no-env-file test <file>`（未设置时为 `bun`；唯一可靠执行器）。
 *  · `node:test` ⇒ **仍用 `TESTCI_BUN --no-env-file test <file>`**。裸 `node --test` 在本树无法执行这三个文件：
 *      - `packages/robot-tools/test/session-path.test.ts` 撞 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
 *        （产品源码里的 TS 参数属性 `constructor(private readonly …)`，node strip-only 不支持）；
 *      - `packages/generate-marble/test/env-forwarding.test.ts`、`packages/robot-workflows/test/recording-root.test.ts`
 *        撞 `ERR_MODULE_NOT_FOUND`（产品源码用**无扩展名**相对导入，node ESM 不解析）；
 *    即便加 `--experimental-transform-types` 也是 2/3 失败（那两条 ERR_MODULE_NOT_FOUND 不解）。
 *    bun 能解析这两类写法且**同样执行 `node:test` 的 API**，故声明 runner 与执行器分开记：
 *    `declaredRunner` = 文件自己 import 的测试 API，`executedBy` = 真正起的进程。
 *  · `python`    ⇒ `TESTCI_PYTHON <file>`（未设置时回退到 `.runtime/bench/gymnasium-env/bin/python` 或 `python3`，见 resolvePython）。
 *  · `plain`     ⇒ `TESTCI_BUN --no-env-file <file>`（未设置时为 `bun`；脚本自带 main，退出码即结果；文件头写明不是 `bun test` 用例）。
 *
 * 用法：
 *   bun run test:ci                      # 跑默认安全集合（= 清单 include 集）
 *   bun run test:ci --list               # 只打印纳入/排除与理由
 *   bun run test:ci --filter scene-kit    # 只跑路径命中的子集（调试用，不改清单）
 *   bun run test:ci --json out.json      # 另存机器可读结果
 *   bun run test:ci --root <dir> --manifest <file>   # 换根：失败传播小样用私有 tmp 树
 *   bun run test:ci --emit-manifest-from-tsv <tsv>   # 从 06 的库存 TSV 生成清单 JSON（stdout）
 *
 * 边界（有意不做的）：不做全仓索引器、不统计用例总数、不改任何被测代码与既有判据、不下载模型/权重。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 文件自己声明的测试 API（不是执行器）。`plain-node/none` 归一到 `plain`。 */
export type DeclaredRunner = 'bun:test' | 'node:test' | 'python' | 'plain'

export type Decision = 'include' | 'exclude'

export interface ManifestEntry {
  path: string
  declaredRunner: DeclaredRunner
  /** 06 库存里记的外部标记；`[]` = 无外部依赖 */
  markers: string[]
  decision: Decision
  /** 纳入/排除理由，写进清单与报告，供人审 */
  reason: string
  /**
   * **per-entry 超时**（毫秒，可选）。缺省 ⇒ 仍用全局 `TESTCI_TIMEOUT_MS`（默认 120_000）。
   *
   * 为什么需要（STALL-CAP-TIMEOUT）：有的用例**自己的判据就是真实长耗时**——
   * `policy-source-stall-cap.test.ts` 单跑约 55s（其中一条用真实默认常量 30s 做 trickle），
   * 全局 120s 在负载高时会被撞成 `TIMEOUT`，那是**假红**：把"机器忙"记成"用例失败"。
   * 这条用例**不许 skip、不许缩短它的真尺度**（那 30s 就是判据本身），所以只能给它一条单列的超时。
   *
   * 两条纪律（都由 `timeoutProblems()` 在**跑之前**强制，不是靠自觉）：
   *  1. **必须写理由**：`reason` 里要出现 `per-entry 超时`（把"为什么这条要单列"写在清单里，供人审）；
   *  2. **不许用来掩盖挂住**：值必须是正整数且有上界（≤ 3_600_000ms）；**收紧**（小于全局）永远允许。
   *
   * 它**只改等待上限**：判据、断言、退出码语义一个字不动；单列的条目照样真跑，超时照样记 `timeout` + 退出码 1。
   */
  timeoutMs?: number
}

export interface Manifest {
  schema: 1
  note: string
  safeDefault: string
  runnerNotes: Record<string, string>
  entries: ManifestEntry[]
}

/** 标记 ⇒ 不跑的理由。默认安全集合就是"没有这些标记"。 */
export const MARKER_REASONS: Record<string, string> = {
  realmodel: '调用真实供应商模型/计费（realmodel）',
  net_fetch: '需要出网抓取（net_fetch）',
  hf_download: '需要 HuggingFace 权重下载（hf_download）',
  gpu_cuda: '需要 CUDA/GPU 槽（gpu_cuda）',
  unity: '需要 Unity 真机 + 重装重编译（unity）',
  blender: '需要 Blender 可执行与实例（blender）',
  isaac: '需要 Isaac 仿真栈（isaac）',
  envgate: '依赖本机 lane 环境变量/凭据（envgate）',
}

export const SAFE_DEFAULT_REASON =
  '无外部标记：离线纯逻辑，不触碰供应商模型/网络抓取/权重下载/GPU/Unity/Blender/Isaac/本机 lane 凭据'

/** 发现规则：认双引号/单引号/反引号，且**扩展名全谱**（.ts/.tsx/.mts/.cts/.js/.mjs/.py）。 */
const TEST_LIKE =
  /(?:\.test|\.spec|\.smoke)\.(?:ts|tsx|mts|cts|js|mjs)$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/

/** 走查根：清单里每个条目都必须落在其一之下（运行期自检，落不进 ⇒ 退出码 2 并精确列出）。 */
export const SEARCH_ROOTS = ['packages/*/test', 'packages/*/chain', 'packages/*/python', 'services/*/test', 'script', 'distribution/*']

/** 只认测试 API 的裸模块 id，不认路径形态（路径形态会在 parseImportSpecifiers 里被一并取出再筛）。 */
const RUNNER_MODULE_IDS: Record<string, DeclaredRunner> = {
  'bun:test': 'bun:test',
  'node:test': 'node:test',
}

export function isTestLikeName(filePath: string): boolean {
  return TEST_LIKE.test(filePath)
}

/**
 * 抽出 import/require 的模块说明符。**三种引号都认**：只匹配单一引号会漏掉另一半文件，
 * 那种"我扫过了"的结论是假的。
 */
export function parseImportSpecifiers(source: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom\s+|\bimport\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"`])([^'"`\n]+)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[2]!)
  return out
}

/** 从源码判定**声明的**测试 API。`.py` 直接归 python；否则看模块 id，认不出 ⇒ plain。 */
export function detectDeclaredRunner(source: string, filePath: string): DeclaredRunner {
  if (/\.py$/i.test(filePath)) return 'python'
  const specs = parseImportSpecifiers(source)
  for (const s of specs) {
    const hit = RUNNER_MODULE_IDS[s]
    if (hit) return hit
  }
  return 'plain'
}

/** 标记 ⇒ 决定与理由。`markers` 为空即默认安全集合。 */
export function classifyMarkers(markers: string[]): { decision: Decision; reason: string } {
  const known = markers.filter((m) => m in MARKER_REASONS)
  const unknown = markers.filter((m) => !(m in MARKER_REASONS))
  if (markers.length === 0) return { decision: 'include', reason: SAFE_DEFAULT_REASON }
  const parts = known.map((m) => MARKER_REASONS[m]!)
  if (unknown.length > 0) parts.push(`未知标记 ${unknown.join(',')}（按不安全处理）`)
  return { decision: 'exclude', reason: `not-run：${parts.join('；')}` }
}

/**
 * 用例计数行。两种形态都要认，只认一种会把另一半读成 0：
 *  · bun：` 3 pass` / ` 0 fail` / ` 2 skip`（**数在前**）
 *  · TAP / node --test：`# pass 4` / `# fail 0` / `# skipped 5`（**词在前**）
 */
export function parseCounts(output: string): { pass: number; fail: number; skip: number } {
  const counts = { pass: 0, fail: 0, skip: 0 }
  const label = String.raw`(?:skipped|skip|pass|fail|todo)`
  const re = new RegExp(String.raw`^\s*#?\s*(?:(\d+)\s+(${label})|(${label})\s+(\d+))\s*$`, 'gim')
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    const kind = (m[2] || m[3])!.toLowerCase()
    const n = Number(m[1] ?? m[4])
    if (kind === 'pass') counts.pass += n
    else if (kind === 'fail') counts.fail += n
    else counts.skip += n
  }
  return counts
}

export function normalizeRunnerLabel(raw: string): DeclaredRunner {
  if (raw === 'bun:test' || raw === 'node:test' || raw === 'python') return raw
  if (raw === 'plain-node/none' || raw === 'plain' || raw === 'none') return 'plain'
  return 'plain'
}

function parseTsv(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [path, runner, markersRaw] = line.split('\t')
    if (!path || !runner) continue
    const markers = !markersRaw || markersRaw === '-' ? [] : markersRaw.split(',').map((s) => s.trim()).filter(Boolean)
    const declaredRunner = normalizeRunnerLabel(runner.trim())
    const { decision, reason } = classifyMarkers(markers)
    entries.push({ path: path.trim(), declaredRunner, markers, decision, reason })
  }
  return entries
}

function manifestFromTsv(text: string): Manifest {
  return {
    schema: 1,
    note:
      'CCMM-07 默认安全行为清单：由 CCMM-06 的库存 TSV（total=190）逐行分类生成；decision=include 才会在 CI 跑，' +
      'exclude 全部带 not-run 理由（不跑 ≠ 通过）。',
    safeDefault: SAFE_DEFAULT_REASON,
    runnerNotes: {
      'bun:test': 'TESTCI_BUN --no-env-file test <file>（未设置时回退到 bun）',
      'node:test': '声明 node:test，仍由 TESTCI_BUN --no-env-file test <file> 执行（未设置时回退到 bun；裸 node --test 在本树跑不起来，见文件头实测）',
      python: 'TESTCI_PYTHON <file>（未设置时回退到 .runtime/bench/gymnasium-env/bin/python 或 python3；缺 numpy/Pillow 的解释器不算通过）',
      plain: 'TESTCI_BUN --no-env-file <file>（未设置时回退到 bun；脚本自带 main，退出码即结果）',
    },
    entries: parseTsv(text),
  }
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git' || it.name === 'dist' || it.name === '.upstream' || it.name === '.runtime' || it.name === '__pycache__') continue
    const full = join(dir, it.name)
    if (it.isDirectory()) await walk(full, acc)
    else if (it.isFile() && isTestLikeName(full)) acc.push(full)
  }
}

function expandRoots(root: string, patterns: string[]): string[] {
  const out: string[] = []
  for (const p of patterns) {
    const parts = p.split('/')
    const star = parts.indexOf('*')
    if (star < 0) {
      out.push(join(root, p))
      continue
    }
    const head = parts.slice(0, star).join('/')
    const tail = parts.slice(star + 1).join('/')
    let names: string[] = []
    try {
      names = readdirSyncSafe(join(root, head))
    } catch {
      names = []
    }
    for (const n of names) out.push(tail ? join(root, head, n, tail) : join(root, head, n))
  }
  return out
}

function readdirSyncSafe(dir: string): string[] {
  // 同步只用于展开一层包名通配（构造待走查目录名），不做全仓统计。
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

/** 发现规则扫到、但清单未覆盖的文件 ⇒ fail-closed。 */
export async function findUnclassified(root: string, manifestPaths: Set<string>): Promise<string[]> {
  const acc: string[] = []
  for (const dir of expandRoots(root, SEARCH_ROOTS)) await walk(dir, acc)
  const rel = (p: string) => relative(root, p).split('\\').join('/')
  return acc.map(rel).filter((p) => !manifestPaths.has(p)).sort()
}

/** 清单条目必须落在 SEARCH_ROOTS 之下，否则发现规则对它永远失明 ⇒ 返回这些"根外"条目。 */
export function findOutsideRoots(root: string, manifestPaths: string[]): string[] {
  const inside = expandRoots(root, SEARCH_ROOTS).map((p) => relative(root, p).split('\\').join('/'))
  return manifestPaths.filter((p) => {
    const dir = dirname(p).split('\\').join('/')
    // 允许更深一层（例如 script/gates/g03-clock.test.ts 落在 script/ 之下）
    return !inside.some((d) => dir === d || dir.startsWith(d + '/'))
  })
}

/** passwd 库里的 home（**不是** `$HOME`）。取不到 ⇒ `null`（`os.userInfo()` 在无 uid 的环境会抛）。 */
export function userDbHome(): string | null {
  try {
    const home = userInfo().homedir
    return home && isAbsolute(home) ? home : null
  } catch {
    return null
  }
}

/**
 * 候选 home 目录：`env.HOME` → `env.USERPROFILE` → **passwd 库里的 home**。
 *
 * 第三条不是装饰：`env -i PATH=/usr/bin:/bin` 下 `HOME` 是空的，只看 `process.env.HOME`
 * 就会漏掉本机明明装着的 `~/.bun/bin/bun` —— 门那边 `bunBin()` 的 `$HOME` 兜底正是这个形状
 * （`env -i` + 非 bun 解释器 ⇒ 兜底拿不到 ⇒ UNPROVEN）。
 */
export function homeCandidates(env: NodeJS.ProcessEnv = process.env, dbHome: string | null = null): string[] {
  const out: string[] = []
  for (const raw of [env.HOME, env.USERPROFILE, dbHome]) {
    const home = raw?.trim()
    if (home && isAbsolute(home) && !out.includes(home)) out.push(home)
  }
  return out
}

/** PATH 上找**可执行**的 `bun`（纯查找，不 spawn）。找不到 ⇒ `null`。 */
export function whichBun(pathValue: string | undefined, platform: string = process.platform): string | null {
  const names = platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun']
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // 存在但不可执行：继续找 —— 别把一个不可执行的同名文件当执行器。
      }
    }
  }
  return null
}

/**
 * 解析 js 执行器（bun）。**前四路都与调用方 shell 的 PATH 无关**（形状照 `script/release-gate.ts`
 * 的 `bunBin()`；门那边已经为同一条坑打过补丁）：
 *   ① `TESTCI_BUN`（CI 用它钉执行器，见 `.github/workflows/ci.yml` 的 `command -v bun`）
 *   ② `process.execPath` 自己就是 bun —— `bun run …` / `bun script/test-ci.ts` 起的进程都命中
 *   ③ PATH 上的 bun（`whichBun`，纯查找，不起子进程）
 *   ④ `$HOME` / `%USERPROFILE%` / **passwd 库**三者之一下的 `.bun/bin/bun`
 *   ⑤ 都认不出 ⇒ **`null`**
 *
 * **为什么返回 `null` 而不是 `'bun'`**（改前就是后者）：bun 不在 PATH 时 `spawn('bun')` 拿到的是
 * `ENOENT`，而旧代码把它记成 `exitCode 127`、报告里写成「真实非 0 退出码 127」—— 读的人会以为
 * **用例真的失败了**。实测（本机，非登录 shell，node 在 PATH、bun 不在）：`bun --no-env-file
 * script/test-ci.ts --filter test-ci.test.ts` ⇒ `FAIL … 真实非 0 退出码 127`、harness exit=1，
 * 而同一棵树加 `TESTCI_BUN=<绝对路径>` 就是 `PASS exit=0`。判据不许说假话：起不了执行器就要说
 * 「起不了执行器」，并且**在起进程之前**就说（见 `executorProblem()`）。
 */
export function resolveBun(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  dbHome: string | null = userDbHome(),
): string | null {
  const configured = env.TESTCI_BUN?.trim()
  if (configured) return configured
  if (/(^|[\\/])bun(\.exe)?$/.test(execPath)) return execPath
  const onPath = whichBun(env.PATH)
  if (onPath) return onPath
  for (const home of homeCandidates(env, dbHome)) {
    for (const name of ['bun', 'bun.exe']) {
      const fallback = join(home, '.bun/bin', name)
      if (existsSync(fallback)) return fallback
    }
  }
  return null
}

/**
 * 执行器**前置检查**（在任何子进程之前跑一次）。返回 `null` = 没问题；返回字符串 = 必须点名的配置错误。
 *
 * 为什么要有这一条（NESTED-BUN-127）：`bun` 不在 PATH 时，改前的行为是**每个纳入条目各撞一次
 * ENOENT**——195 条里 195 条写成「真实非 0 退出码 127」、harness 退出 1。那是**假红**：把「环境里
 * 没有执行器」说成了「用例失败」。这里把它换成**一次点名 + 退出码 2（配置错误）**。
 * **不是跳过**：调用方（`--list` / run 模式 / 门）拿到的是非 0 + 可读原因，不许顶着 0 混过去。
 */
export function executorProblem(entries: ManifestEntry[]): string | null {
  // 只有 js 执行器的条目才需要 bun：纯 python 清单不该因为缺 bun 而红。
  const needsJs = entries.some((e) => e.decision === 'include' && e.declaredRunner !== 'python')
  if (!needsJs) return null
  const configured = process.env.TESTCI_BUN?.trim()
  if (configured && isAbsolute(configured) && !existsSync(configured)) {
    return `TESTCI_BUN 指向的执行器在磁盘上不存在：${configured} ⇒ 一条 js 用例都起不来（这不是用例失败，是执行器配置错）`
  }
  if (resolveBun() === null) {
    return (
      '环境里找不到 js 执行器 bun（TESTCI_BUN / process.execPath / PATH / $HOME|passwd 库的 .bun/bin/bun 四路都认不出）' +
      ' ⇒ 纳入集里的 js 用例一条都起不来；这不是「跳过」，也不是「用例失败」'
    )
  }
  return null
}

/**
 * **纳入**条目里磁盘上没有的文件（CCMM-09）。
 *
 * 只看 `decision=include`：exclude 是"有意不跑"，不在本判据内。存在性与 `--filter` 无关——
 * 清单里写明要跑、又拿不出来的文件，本来就不是"换个子集"能糊过去的。
 */
export function findMissingIncluded(root: string, entries: ManifestEntry[]): string[] {
  return entries
    .filter((e) => e.decision === 'include' && !existsSync(resolve(root, e.path)))
    .map((e) => e.path)
    .sort()
}

export function resolvePython(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TESTCI_PYTHON?.trim()
  if (configured) return configured
  const bench = join(root, '.runtime/bench/gymnasium-env/bin/python')
  return existsSync(bench) ? bench : 'python3'
}

/** per-entry 超时的上界：单列可以放宽，但不许写成"等于不设上限"（挂住的用例仍要被记成 timeout）。 */
export const MAX_ENTRY_TIMEOUT_MS = 3_600_000

/**
 * 本条目**实际**用的等待上限。
 *
 * 规则（有意做成"两条都生效"）：
 *  · 条目**没写** `timeoutMs` ⇒ 全局值（`TESTCI_TIMEOUT_MS`，默认 120_000）。**默认行为一个字不变。**
 *  · 条目**写了合法值** ⇒ 以条目值为准：可以**放宽**（慢用例的真尺度不会被全局值掐断），
 *    也可以**收紧**（条目值更小 ⇒ 红得更早）。两者都必须显式写在清单里并带理由（见 `timeoutProblems()`）。
 *  · 条目值**不合法**（非正整数）⇒ 回落到全局值；这不是"静默放行"，`timeoutProblems()` 已经
 *    在跑之前把它记成配置错误并让 harness 退出 2。
 */
export function effectiveTimeoutMs(entry: Pick<ManifestEntry, 'timeoutMs'>, globalTimeoutMs: number): number {
  const declared = entry.timeoutMs
  if (declared === undefined) return globalTimeoutMs
  if (!Number.isInteger(declared) || declared <= 0) return globalTimeoutMs
  return declared
}

/**
 * 清单里 `timeoutMs` 的**写前纪律**（在任何子进程之前跑一次）。返回要打印的问题行（空 = 没问题）。
 *
 * 为什么要有这一条：一个"可以随便加的超时字段"就是一条**把红变绿的捷径**——给挂住的用例加个大超时，
 * 它会"变绿"（其实是多等了几分钟）。这里堵的正是那条路：
 *  · 只有**纳入**条目才允许写（exclude 不跑，写超时没有意义，还会误导读者）；
 *  · 必须**正整数**且 ≤ `MAX_ENTRY_TIMEOUT_MS`；
 *  · `reason` 里必须出现 `per-entry 超时` ⇒ 单列这件事**在清单里可读**，不是偷偷加的。
 * 收紧（值 < 全局）不额外要求理由之外的东西：它只会让红更早出现，不会掩盖挂住。
 */
export function timeoutProblems(entries: ManifestEntry[], globalTimeoutMs: number): string[] {
  const problems: string[] = []
  for (const e of entries) {
    if (e.timeoutMs === undefined) continue
    const shown = `${e.path}：timeoutMs=${String(e.timeoutMs)}`
    if (e.decision !== 'include') problems.push(`${shown} —— 只有 decision=include 的条目允许单列超时（exclude 根本不跑）`)
    if (!Number.isInteger(e.timeoutMs) || e.timeoutMs <= 0) problems.push(`${shown} —— 必须是正整数毫秒`)
    else if (e.timeoutMs > MAX_ENTRY_TIMEOUT_MS) problems.push(`${shown} —— 超过上界 ${MAX_ENTRY_TIMEOUT_MS}ms（再长就不是"给慢用例留余量"，是"把挂住藏起来"）`)
    if (!e.reason.includes('per-entry 超时')) problems.push(`${shown} —— reason 里必须写明 per-entry 超时的理由（缺了就是把单列藏起来，人审看不到为什么这条特殊）`)
  }
  return problems
}

export interface FileResult {
  path: string
  declaredRunner: DeclaredRunner
  executedBy: string
  command: string
  decision: Decision
  /**
   * `missing` 只给 **decision=include 但磁盘上没有** 的条目：这是配置错误（harness 退出码 2），
   * 不是 `skip`（`skip` 只表示"有意不跑"= exclude / not-run）。
   */
  status: 'pass' | 'fail' | 'timeout' | 'skip' | 'missing'
  exitCode: number | null
  /** 本条**实际**用的等待上限（per-entry 单列值，或全局 `timeoutMs`）——报告里要能直接读到，不用反推。 */
  timeoutMs: number
  pass: number
  fail: number
  skip: number
  reason?: string
  logTail: string
}

function commandFor(entry: ManifestEntry, root: string): { cmd: string | null; args: string[]; executedBy: string } {
  // resolve 而不是 join：绝对路径条目（失败传播小样）不能被拼到 root 后面去。
  const file = resolve(root, entry.path)
  if (entry.declaredRunner === 'python') {
    const py = resolvePython(root)
    return { cmd: py, args: [file], executedBy: py }
  }
  const bun = resolveBun()
  // 解析不出执行器 ⇒ **不许拿名字去 spawn**（那只会得到 ENOENT/127，且会被误读成"用例失败"）。
  if (bun === null) return { cmd: null, args: [], executedBy: '-' }
  if (entry.declaredRunner === 'plain') return { cmd: bun, args: ['--no-env-file', file], executedBy: bun }
  // bun:test 与 node:test 都用 bun test（node:test 的理由见文件头实测）
  return { cmd: bun, args: ['--no-env-file', 'test', file], executedBy: bun }
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    const onData = (b: Buffer) => {
      out += b.toString('utf8')
      if (out.length > 200_000) out = out.slice(-200_000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code ?? String(err)
      // **不谎报 127**：起不了进程时退出码是"没有"，不是 127。旧代码把它写成 127，报告里就成了
      // 「真实非 0 退出码 127」——那是把"执行器缺失"说成"用例失败"（本单实测到的假红）。
      res({ code: null, signal: null, out: out + `\n[spawn error] ${String(err)}`, timedOut, spawnError: code })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      res({ code, signal, out, timedOut })
    })
  })
}

export async function runEntry(entry: ManifestEntry, root: string, timeoutMs: number): Promise<FileResult> {
  const base: FileResult = {
    path: entry.path,
    declaredRunner: entry.declaredRunner,
    executedBy: '-',
    command: '-',
    decision: entry.decision,
    status: 'skip',
    exitCode: null,
    // 缺省就是全局值；条目单列时下面 `runProcess` 之前会换成条目值（同一变量，报告与超时用同一个数）。
    timeoutMs,
    pass: 0,
    fail: 0,
    skip: 0,
    logTail: '',
  }
  if (entry.decision === 'exclude') {
    return { ...base, status: 'skip', reason: entry.reason }
  }
  // resolve 而不是 join：失败传播小样用私有 tmp 里的绝对路径驱动同一条执行路径。
  // 纳入却缺文件 ⇒ `missing`（配置错误，退出码 2），**不是** `skip`：跳过是"不跑"，缺件是"说要跑却没得跑"。
  if (!existsSync(resolve(root, entry.path))) {
    return { ...base, status: 'missing', reason: `清单里有、磁盘上没有：${entry.path}` }
  }
  const { cmd, args, executedBy } = commandFor(entry, root)
  // 执行器解析不出来 ⇒ 记 `fail` 并**点名原因**：既不 spawn（撞 ENOENT），也不许记成 pass/skip。
  // 正常路径上 `main()` 的 `executorProblem()` 已经先拦住了；这里兜住"直接调 runEntry"的调用方。
  if (cmd === null) {
    return {
      ...base,
      status: 'fail',
      reason:
        '环境里找不到 js 执行器 bun（TESTCI_BUN / process.execPath / PATH / $HOME|passwd 库的 .bun/bin/bun 四路都认不出）' +
        ' —— 不是用例失败，是执行器缺失（一条命令都没起）',
    }
  }
  // 只把**落在 root 之内**的绝对路径改写成相对；`test` 这种固定 token 不能被 relative() 当路径解析
  // （它按进程 cwd 解析，会渲染成 `../../<repo>/test` 这种读不出来的命令行），root 外的绝对路径
  // （失败传播小样用的私有 tmp）也保持原样——报告里的 `command` 要能照着敲。
  const render = (a: string) => {
    if (!isAbsolute(a)) return a
    const rel = relative(root, a)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : a
  }
  const command = [cmd, ...args.map(render)].join(' ')
  // per-entry 超时：条目写了就用条目的（见 effectiveTimeoutMs）。`timeoutMs` 参数在这里的角色从
  // "这条的上限"变成"没单列时的上限"——默认行为不变（没有条目写 timeoutMs 时逐字相同）。
  const entryTimeoutMs = effectiveTimeoutMs(entry, timeoutMs)
  const { code, signal, out, timedOut, spawnError } = await runProcess(cmd, args, root, entryTimeoutMs)
  const counts = parseCounts(out)
  const ok = code === 0 && !timedOut && !spawnError
  const reason = timedOut
    ? `超时 ${entryTimeoutMs}ms（SIGKILL${entryTimeoutMs === timeoutMs ? '' : `；本条单列 per-entry 超时，全局 ${timeoutMs}ms`}）`
    : spawnError
      ? `起不了执行器（${spawnError}）：${cmd} —— 这不是用例失败，是执行器起不来`
      : ok
        ? undefined
        : `真实非 0 退出码 ${code}${signal ? ` (signal ${signal})` : ''}`
  return {
    ...base,
    executedBy,
    command,
    timeoutMs: entryTimeoutMs,
    status: timedOut ? 'timeout' : ok ? 'pass' : 'fail',
    exitCode: code,
    pass: counts.pass,
    fail: counts.fail,
    skip: counts.skip,
    reason,
    logTail: out.split('\n').slice(-12).join('\n'),
  }
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string) => argv.includes(name)
  // --root：失败传播小样要在私有 tmp 里用**同一条执行路径**跑，不能借用真仓当假现场。
  const root = resolve(arg('--root') || resolve(import.meta.dir, '..'))

  const tsvPath = arg('--emit-manifest-from-tsv')
  if (tsvPath) {
    process.stdout.write(JSON.stringify(manifestFromTsv(await readFile(tsvPath, 'utf8')), null, 2) + '\n')
    return 0
  }

  const manifestPath = resolve(root, arg('--manifest') || 'script/test-ci.manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  const entries = manifest.entries
  const known = new Set(entries.map((e) => e.path))

  // 自检 1：清单条目必须落在发现规则看得见的根下（否则 fail-closed 对它失明）
  const outside = findOutsideRoots(root, entries.map((e) => e.path))
  // 自检 2：发现规则扫到但清单没有的 ⇒ 不许"顺手跑绿"
  const unclassified = await findUnclassified(root, known)
  // 自检 3：清单声明的 runner 必须与源码实际 import 的测试 API 一致（引号/扩展名全谱重扫）
  const mismatches: string[] = []
  for (const e of entries) {
    const full = join(root, e.path)
    if (!existsSync(full)) continue
    const detected = detectDeclaredRunner(await readFile(full, 'utf8'), e.path)
    if (detected !== e.declaredRunner) mismatches.push(`${e.path}: 清单=${e.declaredRunner} 源码=${detected}`)
  }
  // 自检 4（CCMM-09）：**纳入**的条目必须真在磁盘上。缺文件不是"跳过"，是"说要跑却没得跑"。
  // 只算 include：exclude 是有意不跑；且与 --filter 无关（看的是整个纳入集的完整性）。
  const missing = findMissingIncluded(root, entries)
  // 自检 5（STALL-CAP-TIMEOUT）：`timeoutMs` 这个字段的**写前纪律**（只有 include 能写、正整数、
  // 有上界、reason 里必须写明）。理由见 `timeoutProblems()`：一个可以随便加的超时字段就是
  // "把挂住的用例等成绿的"那条捷径，必须在**跑之前**堵掉，而不是靠 reviewer 事后发现。
  const timeoutMs = Number(process.env.TESTCI_TIMEOUT_MS || 120_000)
  const timeoutIssues = timeoutProblems(entries, timeoutMs)

  // 配置问题共用一份输出：list 与 run 模式都必须**点名**是哪一个文件，
  // 只报"退出码 2"而不出名字是没法修的。
  const configProblems = () => {
    // 第 4 类（NESTED-BUN-127）：执行器起不来。放在最前面，因为它比"哪一条没审过"更根本 ——
    // 没有执行器时后面那些条目一条都跑不了，而改前的行为是拿名字去 spawn、把 ENOENT 记成 127。
    const execProblem = executorProblem(entries)
    if (execProblem) process.stdout.write(`CONFIG-ERROR\t${execProblem}\n`)
    for (const p of outside) process.stdout.write(`CONFIG-ERROR\t清单条目不在任何发现根下：${p}\n`)
    for (const p of unclassified) process.stdout.write(`UNCLASSIFIED\t发现规则扫到但清单未覆盖：${p}\n`)
    for (const p of mismatches) process.stdout.write(`RUNNER-MISMATCH\t${p}\n`)
    for (const p of timeoutIssues) process.stdout.write(`CONFIG-ERROR\tper-entry 超时字段不合纪律：${p}\n`)
    if (execProblem || outside.length || unclassified.length || mismatches.length || timeoutIssues.length) {
      process.stdout.write('fail-closed：以上未审/不一致/执行器缺失/超时字段不合纪律条目一律不跑，也不算通过。\n')
      return 2
    }
    return 0
  }

  // 纳入缺件单列一条账（CCMM-09），**不**并进上面三类：那三条拦的是"没审过/不一致的条目"，
  // 缺件的条目早已审过、只是文件没了。它照样必须让 harness 退出 2，但不拦住其余用例的实跑——
  // 报告里要留每文件真实结果（跑过的照跑、exclude 的 not-run 照记），缺件单独记账。
  const nameMissing = () => {
    for (const p of missing) process.stdout.write(`MISSING\t已纳入但磁盘上没有：${p}\n`)
    if (missing.length > 0)
      process.stdout.write('纳入集缺件：清单里要跑、磁盘上却没有的文件不是"跳过"，harness 退出码 2，不许顶着 0 混过去。\n')
  }

  if (has('--list')) {
    for (const e of entries) {
      const tag = e.decision === 'include' ? 'RUN ' : 'SKIP'
      process.stdout.write(`${tag}\t${e.declaredRunner}\t${e.path}\t${e.reason}\n`)
    }
    nameMissing()
    process.stdout.write(`# include=${entries.filter((e) => e.decision === 'include').length} exclude=${entries.filter((e) => e.decision === 'exclude').length} missing=${missing.length}\n`)
    return configProblems() || (missing.length > 0 ? 2 : 0)
  }

  const configExit = configProblems()
  if (configExit !== 0) return configExit
  nameMissing()

  const filter = arg('--filter')
  const results: FileResult[] = []
  for (const e of entries) {
    if (e.decision === 'exclude') {
      results.push(await runEntry(e, root, timeoutMs))
      continue
    }
    // 纳入缺件**不受 --filter 掩盖**：它跟"本次只跑哪个子集"无关，整份纳入集都得是完整的。
    if (!existsSync(resolve(root, e.path))) {
      results.push(await runEntry(e, root, timeoutMs))
      continue
    }
    if (filter && !e.path.includes(filter)) {
      results.push({ ...(await runEntry({ ...e, decision: 'exclude' }, root, timeoutMs)), decision: 'include', reason: `--filter ${filter} 未命中（本次未跑）` })
      continue
    }
    const r = await runEntry(e, root, timeoutMs)
    results.push(r)
    const mark =
      r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : r.status === 'timeout' ? 'TIMEOUT' : r.status === 'missing' ? 'MISSING' : 'FAIL'
    process.stdout.write(`${mark}\t${r.declaredRunner}\t${r.path}\t${r.reason || `exit=${r.exitCode}`}\n`)
  }

  const ran = results.filter((r) => r.decision === 'include' && r.status !== 'skip' && r.status !== 'missing')
  const passed = ran.filter((r) => r.status === 'pass')
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'timeout')
  const skipped = results.filter((r) => r.status === 'skip')
  // 纳入却缺件：既不算 ran、也不算 skip，单独记账并让 harness 退出 2。
  const missingRan = results.filter((r) => r.status === 'missing')
  const byRunner: Record<string, { include: number; passed: number; failed: number; notRun: number; missing: number }> = {}
  for (const r of results) {
    const b = (byRunner[r.declaredRunner] ||= { include: 0, passed: 0, failed: 0, notRun: 0, missing: 0 })
    if (r.decision === 'include') b.include++
    if (r.status === 'pass') b.passed++
    else if (r.status === 'fail' || r.status === 'timeout') b.failed++
    else if (r.status === 'missing') b.missing++
    else b.notRun++
  }
  // 0 全过 / 1 有行为失败或超时 / 2 配置或分类问题。缺件是配置问题，优先于行为失败报出来。
  const harnessExitCode = missingRan.length > 0 ? 2 : failed.length > 0 ? 1 : 0

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    manifest: relative(root, manifestPath),
    timeoutMs,
    // 单列了 per-entry 超时的条目：报告里**点名**列出来，读报告的人不必去翻清单就知道
    // "哪几条的等待上限不是全局那个数"。空数组 = 一条都没单列（= 与改前逐字同形）。
    perEntryTimeouts: entries
      .filter((e) => e.timeoutMs !== undefined)
      .map((e) => ({ path: e.path, decision: e.decision, timeoutMs: effectiveTimeoutMs(e, timeoutMs), globalTimeoutMs: timeoutMs })),
    filter: filter || null,
    summary: {
      manifestEntries: results.length,
      included: results.filter((r) => r.decision === 'include').length,
      excludedNotRun: results.filter((r) => r.decision === 'exclude').length,
      ran: ran.length,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      missing: missingRan.length,
      byRunner,
      harnessExitCode,
    },
    excludedReasons: results.filter((r) => r.decision === 'exclude').map((r) => ({ path: r.path, reason: r.reason })),
    results,
  }
  const outPath = arg('--json')
  const json = JSON.stringify(report, null, 2) + '\n'
  if (outPath) {
    await writeFile(resolve(root, outPath), json)
    process.stdout.write(`# report -> ${outPath}\n`)
  } else {
    process.stdout.write(json)
  }
  process.stdout.write(
    `# summary include=${report.summary.included} ran=${ran.length} pass=${passed.length} fail=${failed.length} skip=${skipped.length} missing=${missingRan.length} not-run=${report.summary.excludedNotRun}\n`,
  )
  return harnessExitCode
}

/**
 * 收尾：**不许在最后一次 `write` 之后立刻 `process.exit()`**。
 *
 * Bun 的 stdout/stderr 在**管道**上是异步刷写：`main()` 的最后一句是收尾行
 * `# include=… exclude=… missing=…`（`--list` 形态的最后一行），紧跟一次硬切的 `process.exit(code)`
 * 会把还没冲刷出去的那一截一起丢掉，**而退出码仍是 0** —— 于是 `bun run preflight | grep …`、
 * CI 抓输出、任何解析它的脚本都会偶发"少一行却看起来成功"（本单实测：`bun run preflight` 经管道
 * 丢 9/300，`bun script/test-ci.ts --list` 丢 5/300；丢的形态可复算：完整 37486 字符 / 56006 字节，
 * 丢时停在 46046 / 50706 字节处，尾部约 5–10 KB 凭空消失）。
 *
 * `process.exitCode = code` 让事件循环把 stdout/stderr 排空后**自然退出**；退出码语义一个字不变
 * （0 全过 / 1 行为失败或超时 / 2 配置或分类问题）。本脚本没有挂住的句柄：子进程在 `runProcess`
 * 里等到 `close`，超时定时器已 `clearTimeout`，走查用的都是 `await` 收口的 fs 调用。
 * 失败分支同理：`process.exit(2)` 会把刚写进 stderr 的那句错误也一起丢掉。
 */
if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      process.stderr.write(`test-ci harness error: ${String(err)}\n`)
      process.exitCode = 2
    },
  )
}
