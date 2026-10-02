#!/usr/bin/env bun
/**
 * 退化链接只读守卫（SELFLINK-READONLY-GUARD，2026-09-26）
 *
 * ## 为什么存在（两层，缺一层都不够）
 *
 * 1. **P10**（`bugfixHistory/UPSTREAM-SELFLINK-INVENTORY-20260926.md`）盘点了 `.upstream` 里的自指软链，
 *    推荐 = A（不动）+ C（保留 W6 的"跳过 + 记账"兜底）+ **新增一条只读守卫**：
 *    「**命中即报告（不自动删）**，把"环境被污染"的事实显性化 + 给出复建指引」。
 * 2. **V15**（`bugfixHistory/VERIFY-P10-UPSTREAM-20260926.md` §B.1/§B.4）查出一件对推荐有实质影响的事：
 *    **同形状的链在 `.upstream` 之外现场复现过**（`node_modules/@lyapunov/@lyapunov`，23:40:40 建、23:42:45 删），
 *    ⇒ 守卫若写死"只对 `.upstream` 跑 D1/D2"，**这类复现一条都抓不到**；
 *    且 §3.2 的 1112 条 `find -L` 诊断里 1094 条来自 pnpm 网格，**守卫若只报 22 条会给出"环境基本干净"的错误印象**。
 *    （**Lead 裁决**：守卫作用域从 `.upstream` 扩到所有"按依赖清单 materialize 出来的 `node_modules` 落点"。）
 *
 * ## 判据（**照抄 P10 用过的 D2，不新造**）
 *
 * ```
 * 退化(L)  ⟺  realpath(L) === realpath(dirname(L))
 * ```
 *
 * 即"链解析回自己的父目录" ⇒ `path.relative(dirname(L), realpath(L))` 是**空串** ⇒ `symlink('')` 直接 ENOENT。
 * 这个形状**不炸，它降解**：`realpath` 成功、不报 ELOOP，报错只会出现在下游的裸 ENOENT 里
 * （W6 构建 #1 现场）。所以必须有人主动去查。
 *
 * ## 两类分开报（P10 §3.2 + V15 §B.4 的硬要求）
 *
 * | 类 | 是什么 | 怎么量 |
 * | --- | --- | --- |
 * | **1 自指链** | 链解析回自己的父目录（= P10 的 D2） | 逐条 `realpath` 比对，**点名到路径** |
 * | **2 网格互指** | 跟随软链的遍历在这棵树上看到的**目录环**（pnpm 网格互指的主体） | `find -L <root> -maxdepth 6 2>&1 >/dev/null \| wc -l`，**与 P10 §3.2 / V15 §2 同一把尺** |
 *
 * **两类必须分开报，而且必须都报。** 只报类 1（22 条）会给出"环境基本干净"的错误印象：本机实测
 * **一个 2 层的 pnpm 网格子树**（`.upstream/…-candidate/packages`，`-maxdepth 6`）就有 **1112** 条环诊断，
 * 而 `.upstream` 全域（`-maxdepth 6`）另有 30 条。数字与深度上限绑死，引用时必须连 `maxdepth` 一起写。
 *
 * ## 一条必须写下来的更正（否则"两类"会被读成"两种互不相干的坏链"）
 *
 * 本守卫实测：那 1112 条环诊断里的路径**逐条**都能落到**已知的链**上（1112/1112），而按物理路径去重后是
 * **1112 条不同的链**，其中 **18 条**是类 1 的自指链、**1094 条**是 pnpm 目录软链
 * （`node_modules/@deepseek-ai/<名>` → `../../<组>/<名>` 这种**指到兄弟包目录**的链）。
 * ⇒ **那 1094 条本身不是 D2 退化链**（它们的 `realpath` 不等于父目录，`realpath` 也不报错）。
 * ⇒ V15 §B.4 的「1094 条第二类退化链接」与 P10 §3.2 的「pnpm 网格互指」说的是**同一批目录软链**；
 *    它们在**跟随软链的遍历**里循环，不是因为它们自指，而是因为 pnpm 的 scope 目录把树**别名**了。
 * ⇒ 所以本守卫**两条都报**：类 1 给"有多少条真退化链"，类 2 给"跟随软链的遍历会不会在这棵树上翻车"。
 *    **两个数缺一个，读者就会得出相反的结论。**
 *
 * ## 与 P10 的关系（作用域、口径、纪律各一处更正/收紧）
 *
 * - **作用域**：P10 的 D1/D2 只跑 `.upstream`。本守卫按 Lead 裁决跑**两个根**——
 *   `node_modules/`（所有 scope 落点）与 `.upstream/`（含其中的 nested `node_modules`）。
 *   一个链只算一次：**先按 `node_modules/` 认领，认领不到才算 `.upstream/` 的**（见 `scopeOf()`）。
 * - **口径**：P10 的 D1（`-lname '/*'`，"目标是绝对路径"）自己注明"是本机巧合，别当定义"。
 *   本守卫**只用 D2**，不用 D1；`D1 == D2` 这件事在 `.upstream` 上会被顺带复算出来（见输出里的 `D1==D2` 列）。
 * - **纪律**：**只读**。本文件不 `rm`、不 `symlink`、不 `unlink`、不写任何文件；
 *   唯一的写动作是 stdout/stderr。`--selftest` 用**内存夹具**，不落盘。
 *
 * ## 用法
 *
 * ```
 * bun run script/env-self-link-guard.ts                # 人读报告（缺省）
 * bun run script/env-self-link-guard.ts --json         # 机器可读（发布门按这个取数）
 * bun run script/env-self-link-guard.ts --json --strict # 命中即 exit 1（人用；门不用——见下）
 * bun run script/env-self-link-guard.ts --selftest     # 判据自检（内存夹具，不落盘）
 * bun run script/env-self-link-guard.ts --root . --maxdepth 6
 * ```
 *
 * **退出码**：`0` = 扫到读数（**命中不退 1**，命中写在数字里）；`1` = `--strict` 且命中；`2` = 扫描面一个都读不到（无读数）。
 * **门为什么不用 `--strict`**：这是**环境读数**，不是产品缺陷。把"邻居 lane 造了一条负对照链"变成发布门判红，
 * 会让门在被测量的东西没变的情况下变红——那不是判据，那是噪声。门取的是**数字**，不是"干净/不干净"。
 */
import { readdirSync, readlinkSync, realpathSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'

export const GUARD_VERSION = 1

/** 判据原文（与 P10 §1 的 D2 逐字同形）。打进 JSON，让读者不必回到回执去对。 */
export const CRITERION = 'realpath(L) === realpath(dirname(L))'

// ─────────────────────────────────────────────────────────────────────────────
// 扫描：只走**物理目录**，不跟随任何软链
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么不跟随：跟随会把 `node_modules/@deepseek-ai/*` → `.upstream/**` 这类**跨根**链接整棵展开，
// 既慢又会让同一条链按别名重复计数。判据本身**不需要**跟随——D2 只需要 `realpath(链)` 与
// `realpath(父目录)`，两者都能单独算出来。链的传递解析由 `resolveLink()` 在**链图**上做（有环保护）。
//
// 代价（必须写出来，不许装作没有）：走不进"只由软链才能到达"的物理目录。本机实测该集合为空
// （`node_modules/.bun/*/node_modules/*` 与 `.upstream/.../.pnpm/*` 都是**真目录**，逐个进得去），
// 而且 V15 §B.1 现场复现的那条（`node_modules/@lyapunov/@lyapunov`）就在物理路径上。

export type ScopeId = 'node_modules' | '.upstream'

export interface LinkRecord {
  /** 相对 `<root>` 的路径，POSIX 分隔符。 */
  path: string
  /** `readlink` 原文（不做任何解析）。 */
  target: string
  /** 该链被归到哪个作用域。 */
  scope: ScopeId
  /** 解析链的最终落点；`null` = 解析不出（悬空 / ELOOP）。 */
  real: string | null
  /** 解析失败的机器可读原因（`ENOENT` / `ELOOP` / …）。 */
  realError?: string
  /** `realpath(dirname(L))`；`null` = 父目录都解析不出。 */
  parentReal: string | null
  /** 相对 `<root>` 的 `parentReal`。 */
  parentRealRel: string | null
  /** D2 命中（类 1）。 */
  selfReferential: boolean
}

export interface ScopeReport {
  id: ScopeId
  /** 相对 `<root>` 的扫描根。 */
  root: string
  exists: boolean
  /** 实际走到的物理目录数（只读的规模证据）。 */
  physicalDirs: number
  /** 该作用域下的软链数（每条只算一次）。 */
  links: number
  /** 类 1：`realpath(链) === realpath(父)`（P10 的 D2）。 */
  selfReferential: number
  /** 解析不出的链（悬空 / ELOOP）。**不是**类 1，单列。 */
  dangling: number
  /** 类 1 中"目标原文是绝对路径"的条数 —— P10 的 D1 口径，用来复算 `D1 == D2`。 */
  selfReferentialAbsoluteTarget: number
}

/** 类 2（网格互指）的一格读数：**量的是遍历，不是链**（见文件头"一条必须写下来的更正"）。 */
export interface GridReading {
  /** `find -L` 的扫描根（相对 `<root>`）。 */
  root: string
  /** 深度上限（**必须连同数字一起引用**，否则这个数是不可复算的）。 */
  maxdepth: number
  /** `find -L … 2>&1 >/dev/null | wc -l`：目录环诊断**行数**（P10 §3.2 / V15 §2 的同一把尺）。 */
  cycleDiagnosticLines: number
  /**
   * 诊断里引用的路径**去重后**有多少条能落到本守卫扫过的链上。
   * 它证明"这棵树的环不是凭空来的，就是这些链在别名里互相咬住"。
   * **只在扫描根落在 `node_modules` / `.upstream` 之内时才算**（这是本守卫的扫描面）。
   */
  distinctScannedLinksCited: number
  /** 同上，其中属于类 1（D2）的条数。 */
  selfReferentialCited: number
  /** 同上，其余（pnpm scope 目录软链）的条数 —— V15 §B.4 那个数的准确归属。 */
  scopeAliasCited: number
  /** 这一格是否落在这两个扫描面之内；`false` ⇒ 上面三个 cited 数无意义（记 -1，不冒充 0）。 */
  withinScanSurface: boolean
  /**
   * `false` = 这一格**受 maxdepth 限制，不是这棵树的全部**。
   * 本仓 `.bun` / `.pnpm` 布局很深，任何有限 maxdepth 都只是下界；引用时不许当成"总量"。
   */
  depthComplete: boolean
  /** `find -L` 没起来/超时 ⇒ 无读数（不写成 0）。 */
  error: string | null
}

export interface GuardReport {
  schema: typeof GUARD_VERSION
  tool: 'env-self-link-guard'
  criterion: string
  criterionNote: string
  /** 扫描发生在这个根下（绝对路径）。 */
  root: string
  readOnly: true
  /** 至少一个作用域扫到 ⇒ 有读数。 */
  scanOk: boolean
  scopes: ScopeReport[]
  totals: {
    links: number
    selfReferential: number
    dangling: number
  }
  /** 类 1 的逐条清单（**点名到路径**，不是只给一个数）。 */
  hits: LinkRecord[]
  /** 类 2：网格互指（逐根）。 */
  grid: GridReading[]
  /** `find` 不可用等原因导致类 2 无读数 —— 这时它出现在 `findings` 里，不冒充 0。 */
  gridUnproven: boolean
  /** 命中时的处置指引（P10 明确要求：**报告，不自动删**）。 */
  remediation: string[]
  /** 本守卫有意不做的事（边界，别当成"已覆盖"）。 */
  notCovered: string[]
  ms: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 作用域归属：一个链只算一次
// ─────────────────────────────────────────────────────────────────────────────
//
// `.upstream/**` 里面**也有** nested `node_modules/`（pnpm 网格就在那儿），所以两个扫描根天然重叠。
// 规则：**先按 `node_modules` 段认领**（`node_modules/` 出现在路径里 ⇒ 归 `node_modules` 作用域），
// 否则归 `.upstream`。这样 `.upstream/…/packages/x/y/node_modules/z` 归 `node_modules`（它确实是
// materialize 出来的落点），`.upstream/.upstream` 与 `.upstream/…/vendor/cordis/cordis` 归 `.upstream`。
// 两个数加起来 = 全量，不重不漏。
export function scopeOf(relPath: string): ScopeId {
  const parts = relPath.split(sep)
  return parts.includes('node_modules') ? 'node_modules' : '.upstream'
}

const SCAN_ROOTS: { id: ScopeId; rel: string }[] = [
  { id: 'node_modules', rel: 'node_modules' },
  { id: '.upstream', rel: '.upstream' },
]

// ─────────────────────────────────────────────────────────────────────────────
// 链图解析（有环保护）：不跟随目录，只解链
// ─────────────────────────────────────────────────────────────────────────────

interface LinkGraph {
  /** 绝对路径 → readlink 原文。 */
  targets: Map<string, string>
  /** 绝对路径 → 分类结果。 */
  result: Map<string, { real: string | null; error: string | null }>
  /** 类 1（D2 自指）的绝对路径集合 —— 类 2 的读数要拿它做拆分。 */
  selfReferential: Set<string>
}

export function makeGraph(): LinkGraph {
  return { targets: new Map(), result: new Map(), selfReferential: new Set() }
}

/** 沿链图解析到第一个非软链落点。环 ⇒ `ELOOP`；断链 ⇒ `ENOENT`；映射到仓外 ⇒ `OUTSIDE`。 */
export function resolveLink(g: LinkGraph, abs: string, root: string, stack: Set<string> = new Set()): { real: string | null; error: string | null } {
  const cached = g.result.get(abs)
  if (cached) return cached
  if (stack.has(abs)) return { real: null, error: 'ELOOP' }
  const target = g.targets.get(abs)
  if (target === undefined) {
    // 非软链：正常 realpath。
    try {
      return { real: realpathSync(abs), error: null }
    } catch (e) {
      return { real: null, error: errCode(e) }
    }
  }
  stack.add(abs)
  const next = isAbsolute(target) ? resolve(target) : resolve(dirname(abs), target)
  let out: { real: string | null; error: string | null }
  if (!isInside(root, next) && !existsSync(next)) out = { real: null, error: 'ENOENT' }
  else out = resolveLink(g, next, root, stack)
  stack.delete(abs)
  // 仓外落点：仍然要报出来（`node_modules/typescript -> ~/.bun/install/cache/…` 就是这种），
  // 但**不跟随**它去走目录——解析到此为止，`real` 用 `realpath` 拿一次即可。
  if (out.real === null && out.error === null) out = { real: null, error: 'UNKNOWN' }
  g.result.set(abs, out)
  return out
}

function errCode(e: unknown): string {
  const c = (e as { code?: string })?.code
  return typeof c === 'string' ? c : String(e)
}

function isInside(root: string, p: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep
  return p === root || p.startsWith(r)
}

function posix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────────────────────

export function scan(root: string, maxdepth = 6, gridRoot?: string): GuardReport {
  const t0 = Date.now()
  const g = makeGraph()
  const scopes: ScopeReport[] = []
  const hits: LinkRecord[] = []
  let anyScopeRead = false

  for (const s of SCAN_ROOTS) {
    const absRoot = join(root, s.rel)
    const rep: ScopeReport = {
      id: s.id,
      root: posix(s.rel),
      exists: existsSync(absRoot),
      physicalDirs: 0,
      links: 0,
      selfReferential: 0,
      dangling: 0,
      selfReferentialAbsoluteTarget: 0,
    }
    if (!rep.exists) {
      scopes.push(rep)
      continue
    }
    anyScopeRead = true
    const found: LinkRecord[] = []
    walkPhysical(absRoot, (rel, abs, target) => {
      found.push({
        path: posix(join(s.rel, rel)),
        target,
        scope: s.id,
        real: null,
        parentReal: null,
        parentRealRel: null,
        selfReferential: false,
      })
      g.targets.set(abs, target)
    }, rep)
    for (const l of found) {
      const abs = join(root, l.path)
      const r = resolveLink(g, abs, root)
      l.real = r.real
      l.realError = r.error ?? undefined
      let parentReal: string | null = null
      try {
        parentReal = realpathSync(dirname(abs))
      } catch {
        parentReal = null
      }
      l.parentReal = parentReal
      l.parentRealRel = parentReal === null ? null : posix(relative(root, parentReal))
      rep.links++
      if (l.real === null) {
        rep.dangling++
      } else if (parentReal !== null && l.real === parentReal) {
        l.selfReferential = true
        rep.selfReferential++
        g.selfReferential.add(abs)
        if (isAbsolute(l.target)) rep.selfReferentialAbsoluteTarget++
      }
      if (l.selfReferential) hits.push(l)
    }
    scopes.push(rep)
  }

  const totals = {
    links: scopes.reduce((n, s) => n + s.links, 0),
    selfReferential: scopes.reduce((n, s) => n + s.selfReferential, 0),
    dangling: scopes.reduce((n, s) => n + s.dangling, 0),
  }

  const grid = measureGrid(root, g, maxdepth, gridRoot)

  return {
    schema: GUARD_VERSION,
    tool: 'env-self-link-guard',
    criterion: CRITERION,
    criterionNote: '链解析回自己的父目录 ⇒ 相对目标为空串 ⇒ symlink("") ENOENT。realpath 不报错，只在别处表现为裸 ENOENT。',
    root,
    readOnly: true,
    scanOk: anyScopeRead,
    scopes,
    totals,
    hits,
    grid,
    gridUnproven: grid.some((x) => x.error !== null),
    remediation: buildRemediation(totals, grid),
    notCovered: NOT_COVERED,
    ms: Date.now() - t0,
  }
}

/** 只走物理目录（`isDirectory()` 不跟随软链），遇到软链就登记，绝不下钻。 */
function walkPhysical(dir: string, onLink: (rel: string, abs: string, target: string) => void, rep: ScopeReport, base = dir): void {
  let ents
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  rep.physicalDirs++
  for (const e of ents) {
    const abs = join(dir, e.name)
    if (e.isSymbolicLink()) {
      let target = ''
      try {
        target = readlinkSync(abs)
      } catch {
        continue
      }
      onLink(relative(base, abs), abs, target)
      continue
    }
    if (e.isDirectory()) walkPhysical(abs, onLink, rep, base)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 类 2 · 网格互指：量的是**遍历**，不是链（V15 §B.4 那 1094 条的准确归属）
// ─────────────────────────────────────────────────────────────────────────────
//
// 口径与 P10 §3.2 / V15 §2 逐字相同：`find -L <root> -maxdepth <d> 2>&1 >/dev/null | wc -l`，
// 数的是 **stderr 诊断行数**（"探测到文件系统循环；A 是 B 所处于的文件系统循环的一部分"）。
//
// 为什么用 `find` 而不是自己重写一个遍历：这一格要的正是"外部工具在这棵树上看到多少条"，
// 自己重写会换掉口径，与 P10/V15 的数字就不可比了。`find` 只读、不写盘。
//
// 同时把诊断里引用的路径**映射回本守卫扫过的链**（`distinctScannedLinksCited`），
// 这样才能说清"这 1112 条到底是谁"：实测 1112/1112 全部落到已知链上，其中 18 条是类 1、
// 1094 条是 pnpm scope 目录软链 —— 后者**不是** D2 退化，是"跟随软链会绕圈"的那一类。
//
// 三个根都量：`node_modules`（本仓）、`.upstream`（P10 的根）、以及 P10 §3.2 用过的那个更深的根
// （`.upstream/<lock.directory>/packages`）—— 同行对比才看得出 1112 是哪来的。
//
// ⚠ 第三格**不落在本守卫的扫描面里**（扫描面是 `node_modules` + `.upstream` 两棵树本身），
// 所以那格的 `*Cited` 三个数记 **-1**（无意义），不冒充 0；它的用途只有一个：复算 P10 §3.2 的 1112。
export function measureGrid(root: string, g: LinkGraph, maxdepth = 6, gridRoot?: string): GridReading[] {
  const rels = ['node_modules', '.upstream']
  const deep = deepGridRoot(root, gridRoot)
  if (deep !== null) rels.push(deep)
  return rels
    .filter((rel) => existsSync(join(root, rel)))
    .map((rel) => {
      const within = rel === 'node_modules' || rel === '.upstream'
      const r = spawnSync('find', ['-L', rel, '-maxdepth', String(maxdepth)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300_000 })
      if (r.error !== undefined || r.status === null) {
        return {
          root: posix(rel),
          maxdepth,
          cycleDiagnosticLines: -1,
          distinctScannedLinksCited: -1,
          selfReferentialCited: -1,
          scopeAliasCited: -1,
          withinScanSurface: within,
          depthComplete: false,
          error: String((r.error as Error | undefined)?.message ?? 'find 未返回'),
        }
      }
      const lines = (r.stderr ?? '').split('\n').filter(Boolean)
      const cited = new Set<string>()
      if (within)
        for (const line of lines) {
          // 只认"引号里的、看起来像路径的"片段，且必须**是本守卫扫过的链**。
          // 不按消息文本过滤：文本随 locale 变，而"这条路径是不是我扫过的链"是 locale 无关的。
          for (const m of line.matchAll(/[\u2018\u2019']([^\u2018\u2019']+)[\u2018\u2019']/g)) {
            const t = m[1]!
            if (!t.includes('/')) continue
            const abs = join(root, t)
            if (g.targets.has(abs)) cited.add(abs)
          }
        }
      const selfRef = within ? [...cited].filter((p) => g.selfReferential.has(p)).length : -1
      return {
        root: posix(rel),
        maxdepth,
        cycleDiagnosticLines: lines.length,
        distinctScannedLinksCited: within ? cited.size : -1,
        selfReferentialCited: selfRef,
        scopeAliasCited: within ? cited.size - selfRef : -1,
        withinScanSurface: within,
        depthComplete: false,
        error: null,
      }
    })
}

/**
 * 深根（P10 §3.2 的 `packages`）的相对路径。`UPSTREAM_LOCK.json` 的 `directory` **本身就带 `.upstream/` 前缀**，
 * 所以这里必须剥掉再拼 —— 否则会得到 `.upstream/.upstream/...`（本守卫首版就踩了这个，读数印出来才发现）。
 * 推不出就返回 `null`（不猜、不硬编码上游目录名）。
 */
function deepGridRoot(root: string, explicit?: string): string | null {
  if (explicit !== undefined) return explicit
  const lock = lockDirectoryOf(root)
  if (lock === null) return null
  const rel = lock.replace(/^\.upstream\//, '')
  return `${'.upstream'}/${rel}/packages`
}

/** 从 `UPSTREAM_LOCK.json` 读上游目录名；读不到返回 `null`（不猜）。 */
function lockDirectoryOf(root: string): string | null {
  try {
    const raw = require('node:fs').readFileSync(join(root, 'UPSTREAM_LOCK.json'), 'utf8') as string
    const j = JSON.parse(raw) as { directory?: unknown }
    return typeof j.directory === 'string' ? j.directory : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 复建指引（P10 §5：**报告，不自动删**；`.upstream` 那类走 bootstrap，不要逐条 rm）
// ─────────────────────────────────────────────────────────────────────────────

export const NOT_COVERED = [
  '悬空链（目标不存在）只计数、不判退化 —— P10 的 D2 管的是"解析回父目录"，不是"目标没了"。',
  '不跟随软链做目录遍历（判据不需要；跟随会把跨根链接整棵展开，并让同一条链按别名重复计数）。本机实测"只由软链才能到达的物理目录"为空。',
  '不判"该不该有这条链"（正向链接 `node_modules/<scope>/<name>` → 上游包目录是 bootstrap 的正常产物，本守卫不碰）。',
  '不判上游检出是否 pristine（`git status` 那 7 M + 21 ??，见 P10 §3.4 / V15 §B.3）。',
  '不自动删、不自动修、不备份 —— 唯一的动作是把事实打印出来。',
]

export function buildRemediation(totals: GuardReport['totals'], grid: GridReading[] = []): string[] {
  const gridLines = grid.map((x) =>
    x.error === null
      ? `类 2 在 ${x.root}（-maxdepth ${x.maxdepth}）有 ${x.cycleDiagnosticLines} 条环诊断，其中 ${x.scopeAliasCited} 条来自 pnpm scope 目录软链`
      : `类 2 在 ${x.root}（-maxdepth ${x.maxdepth}）**无读数**（不写成 0）：${x.error}`,
  )
  if (totals.selfReferential === 0) {
    return [
      '类 1（自指链）本次 0 条 —— 这就是那"一个数字"，不是"通过"两个字。',
      ...gridLines,
      `类 1 = 0 **不等于**"环境基本干净"：类 2（网格互指）不是 0 时，跟随软链的归档/同步/遍历照样会翻车。两类必须一起读。`,
      `另：还有 ${totals.dangling} 条**悬空链**（目标不存在）—— 第三类形状，单列不混。`,
      '再出现同形状（任何 `realpath → relative → symlink` 的新消费者）时，重跑本守卫即可看到。',
    ]
  }
  return [
    `类 1 命中 ${totals.selfReferential} 条自指链 —— **本守卫不自动删**（P10 §5-B：手工修等于把"环境事件"伪装成"上游内容"）。`,
    '`.upstream/**` 那一类走 **bootstrap 复建**：删掉 `.upstream` 后重跑 `bun run bootstrap`（删的是可重建产物，不是用户数据；顺带验证"复建后是否复发"）。**不要逐条 `rm`。**',
    '`node_modules/**` 那一类走**重装**：删掉 `node_modules` 后重跑安装。它同样不是手工 `rm` 一条链能了结的 —— 触发工作流未定位时会再犯。',
    ...gridLines,
    '类 2（网格互指）来自 pnpm 的 scope 目录软链，**是这棵树的正常结构**，不是"坏链"：处置办法是"别让流程跟随软链"（不要用 `cp -rL` / `rsync -L` / `tar -h` / `find -L` 做归档、同步、计数），而不是去删它们。',
    '打包侧已有兜底（W6：`payloadLinkTarget()` 跳过 + `skippedSelfLinks` 记账；依赖收闭侧 `resolvesToOwnParent` + `skippedSelfLinksInClosure`），**那是发行侧兜底，不替代本守卫的诊断作用**。',
    '若要把本守卫接到 CI 的 fail-closed 上，用 `--strict`（类 1 命中 exit 1）；发布门默认**不用** —— 它是环境读数，不是产品缺陷。',
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────────

export function renderText(r: GuardReport): string {
  const L: string[] = []
  L.push(`退化链接只读守卫 v${r.schema}（判据 = P10 的 D2：${r.criterion}）`)
  L.push(`root=${r.root}  只读（不删/不改/不建任何文件）  用时 ${r.ms}ms`)
  L.push('')
  L.push('【类 1】自指链 —— 逐条 realpath 比对，点名到路径')
  L.push('作用域            链总数   自指链   悬空链   D1==D2  物理目录')
  for (const s of r.scopes) {
    if (!s.exists) {
      L.push(`${s.root.padEnd(16)}  （扫描根不存在）`)
      continue
    }
    const d1 = s.selfReferential === s.selfReferentialAbsoluteTarget ? '是' : '否'
    L.push(
      `${s.root.padEnd(16)}${String(s.links).padStart(7)}${String(s.selfReferential).padStart(9)}${String(s.dangling).padStart(9)}  ${d1.padEnd(7)}${s.physicalDirs}`,
    )
  }
  L.push(`${'合计'.padEnd(15)}${String(r.totals.links).padStart(7)}${String(r.totals.selfReferential).padStart(9)}${String(r.totals.dangling).padStart(9)}`)
  L.push('')
  L.push('【类 2】网格互指 —— 口径 = `find -L <root> -maxdepth N 2>&1 >/dev/null | wc -l`（与 P10 §3.2 / V15 §2 同一把尺）')
  if (r.grid.length === 0) L.push('  无读数：没有可扫的根')
  for (const a of r.grid) {
    if (a.error !== null) {
      L.push(`  ${a.root}  -maxdepth ${a.maxdepth}  **无读数**（不写成 0）：${a.error}`)
      continue
    }
    const cited = a.withinScanSurface
      ? `诊断引用到的路径里 ${a.distinctScannedLinksCited} 条能落到本次扫描的链上（其中类 1 = ${a.selfReferentialCited}，pnpm scope 目录软链 = ${a.scopeAliasCited}）`
      : '这一格不在扫描面内（`node_modules` / `.upstream` 两棵树本身）⇒ 不折算成链，只作复算参照'
    L.push(`  ${a.root}  -maxdepth ${a.maxdepth}：环诊断 ${a.cycleDiagnosticLines} 行；${cited}`)
  }
  L.push('  ⇒ 类 2 量的是**遍历**：pnpm 的 scope 目录把树**别名**了，跟随软链的遍历会在上面绕圈。')
  L.push('  ⇒ 每一格都是 `-maxdepth N` 的**下界**，不是这棵树的全部（本仓 `.bun` / `.pnpm` 布局很深）：引用时必须连 maxdepth 一起写。')
  L.push('  ⇒ **两个数缺一个就会得出相反的结论**：只报类 1 会像"环境基本干净"，只报类 2 会像"遍地坏链"。')
  L.push('')
  if (r.hits.length === 0) {
    L.push(`类 1 命中：0 条 —— 这就是那"一个数字"，不是"通过"两个字。`)
  } else {
    L.push(`类 1 命中 ${r.hits.length} 条（**不自动删**）：`)
    for (const h of r.hits) {
      L.push(`  自指链    ${h.path}`)
      L.push(`              ->  ${h.target}`)
      if (h.real !== null) L.push(`              realpath(L)=${h.real}`)
      if (h.parentReal !== null) L.push(`              realpath(dirname(L))=${h.parentReal}   ← 相同（相对目标 = 空串）`)
    }
  }
  L.push('')
  L.push('处置指引：')
  for (const s of r.remediation) L.push(`  · ${s}`)
  L.push('')
  L.push('本守卫有意不做（别当成"已覆盖"）：')
  for (const s of r.notCovered) L.push(`  · ${s}`)
  return L.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 判据自检（内存夹具，**不落盘**）
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfTestRow {
  name: string
  ok: boolean
  detail: string
}

/**
 * 用**内存夹具**驱动两条判据函数，证明"报出来的数字来自判据，不是来自某个 if 的巧合"。
 *
 * 这里刻意不去建真实软链：建链是写操作，而本守卫的纪律是只读；真实链的负对照属于**调用方**
 * 的动作（见回执"负对照"一节：造链 → 报出并点名 → 删链 → 归零），本函数只负责判据本身。
 */
export function selftest(): SelfTestRow[] {
  const rows: SelfTestRow[] = []
  const push = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail })

  // 类 1：把链解析成"父目录自己"。
  {
    const root = '/x'
    const linkAbs = '/x/node_modules/@lyapunov/@lyapunov'
    const parentAbs = '/x/node_modules/@lyapunov'
    const g = makeGraph()
    g.targets.set(linkAbs, parentAbs)
    g.result.set(parentAbs, { real: parentAbs, error: null })
    const r = resolveLink(g, linkAbs, root)
    push('类1：链 → 父目录（D2 命中）', r.real === parentAbs, `resolveLink=${String(r.real)} parent=${parentAbs}`)
  }
  // 类 1 的反面：正向链接（`node_modules/@deepseek-ai/x` → 上游包目录）**不许**算命中。
  {
    const root = '/x'
    const linkAbs: string = '/x/node_modules/@deepseek-ai/x'
    const pkg: string = '/x/.upstream/c/packages/a/b'
    const g = makeGraph()
    g.targets.set(linkAbs, pkg)
    g.result.set(pkg, { real: pkg, error: null })
    const r = resolveLink(g, linkAbs, root)
    push('反面：正向链接不命中', r.real === pkg && r.real !== '/x/node_modules/@deepseek-ai', `resolveLink=${String(r.real)}`)
  }
  // 反面：pnpm scope 目录软链（→ 兄弟包目录）**不许**算类 1 命中 —— 它是类 2 的主体。
  {
    const root = '/x'
    const linkAbs: string = '/x/.upstream/c/packages/client/ui/node_modules/@deepseek-ai/dsh-session'
    const pkg: string = '/x/.upstream/c/packages/core/session'
    const g = makeGraph()
    g.targets.set(linkAbs, pkg)
    g.result.set(pkg, { real: pkg, error: null })
    const r = resolveLink(g, linkAbs, root)
    push('反面：scope 目录软链不是类 1', r.real === pkg && r.real !== '/x/.upstream/c/packages/client/ui/node_modules/@deepseek-ai', `resolveLink=${String(r.real)}`)
  }
  // ELOOP：环上解析不出来，必须记成"解析不出"，不许静默当 0。
  {
    const g = makeGraph()
    g.targets.set('/x/a', '/x/b')
    g.targets.set('/x/b', '/x/a')
    const r = resolveLink(g, '/x/a', '/x')
    push('环 ⇒ ELOOP（不是 0）', r.real === null && r.error === 'ELOOP', `error=${String(r.error)}`)
  }
  // 断链 ⇒ ENOENT（与"退化"分开）。
  {
    const g = makeGraph()
    g.targets.set('/x/a', '/x/nope')
    const r = resolveLink(g, '/x/a', '/x')
    push('断链 ⇒ ENOENT（与退化分开）', r.real === null && r.error === 'ENOENT', `error=${String(r.error)}`)
  }
  // 作用域归属：一个链只算一次，nested node_modules 归 node_modules。
  {
    const cases: [string, ScopeId][] = [
      ['node_modules/@lyapunov/@lyapunov', 'node_modules'],
      ['.upstream/.upstream', '.upstream'],
      ['.upstream/deepseek-harness-20260911-candidate/packages/core/tools/dsh-tools', '.upstream'],
      ['.upstream/deepseek-harness-20260911-candidate/packages/x/node_modules/@deepseek-ai/y/y', 'node_modules'],
    ]
    const bad = cases.filter(([p, want]) => scopeOf(p) !== want)
    push('作用域归属不重不漏', bad.length === 0, bad.length === 0 ? '4/4' : JSON.stringify(bad))
  }
  // 复建指引：有类 1 命中时必须落在"不自动删 + bootstrap 复建"上。
  {
    const rem = buildRemediation({ links: 0, selfReferential: 3, dangling: 0 })
    const ok = rem.some((s) => s.includes('不自动删')) && rem.some((s) => s.includes('bootstrap')) && rem.some((s) => s.includes('不要逐条'))
    push('类 1 命中时的指引 = 报告不删 + bootstrap 复建', ok, rem.length + ' 条')
  }
  // 零命中时的指引不许是"通过"两个字，必须带数字，而且必须拦住"环境基本干净"的读法。
  {
    const rem = buildRemediation({ links: 0, selfReferential: 0, dangling: 7 })
    const ok = rem[0]!.includes('0') && rem.some((s) => s.includes('7')) && rem.some((s) => s.includes('不等于'))
    push('零命中时的文字带数字 + 拦住"基本干净"读法', ok, rem[0]!)
  }
  // 渲染：命中时必须点名到路径。
  {
    const r: GuardReport = {
      schema: GUARD_VERSION,
      tool: 'env-self-link-guard',
      criterion: CRITERION,
      criterionNote: '',
      root: '/x',
      readOnly: true,
      scanOk: true,
      scopes: [{ id: 'node_modules', root: 'node_modules', exists: true, physicalDirs: 1, links: 1, selfReferential: 1, dangling: 0, selfReferentialAbsoluteTarget: 1 }],
      totals: { links: 1, selfReferential: 1, dangling: 0 },
      hits: [
        {
          path: 'node_modules/@lyapunov/@lyapunov',
          target: '/x/node_modules/@lyapunov',
          scope: 'node_modules',
          real: '/x/node_modules/@lyapunov',
          parentReal: '/x/node_modules/@lyapunov',
          parentRealRel: 'node_modules/@lyapunov',
          selfReferential: true,
        },
      ],
      grid: [{ root: 'node_modules', maxdepth: 6, cycleDiagnosticLines: 42, distinctScannedLinksCited: 3, selfReferentialCited: 1, scopeAliasCited: 2, withinScanSurface: true, depthComplete: false, error: null }],
      gridUnproven: false,
      remediation: buildRemediation({ links: 1, selfReferential: 1, dangling: 0 }),
      notCovered: NOT_COVERED,
      ms: 1,
    }
    const txt = renderText(r)
    const ok =
      txt.includes('node_modules/@lyapunov/@lyapunov') &&
      txt.includes('自指链') &&
      txt.includes('不自动删') &&
      txt.includes('网格互指') &&
      txt.includes('42') &&
      txt.includes('缺一个就会得出相反的结论')
    push('渲染：点名到路径 + 两类数字都在', ok, ok ? 'ok' : txt.slice(0, 300))
  }
  // 类 2 无读数时不许冒充 0。
  {
    const rem = buildRemediation({ links: 0, selfReferential: 1, dangling: 0 }, [{ root: 'x', maxdepth: 6, cycleDiagnosticLines: -1, distinctScannedLinksCited: -1, selfReferentialCited: -1, scopeAliasCited: -1, withinScanSurface: true, depthComplete: false, error: 'find 未返回' }])
    const ok = rem.some((s) => s.includes('无读数'))
    push('类 2 无读数时在指引里出现', ok, rem.length + ' 条')
  }
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (n: string): boolean => argv.includes(n)

  if (has('--selftest')) {
    const rows = selftest()
    for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  （${r.detail}）`)
    const bad = rows.filter((r) => !r.ok).length
    console.log(`# selftest rows=${rows.length} pass=${rows.length - bad} fail=${bad}  （内存夹具，未落盘、未建链）`)
    return bad === 0 ? 0 : 1
  }

  const root = resolve(arg('--root') ?? process.cwd())
  const maxdepth = Number(arg('--maxdepth') ?? 6)
  const gridRoot = arg('--grid-root')
  const report = scan(root, maxdepth, gridRoot)

  if (has('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderText(report))

  if (!report.scanOk) return 2
  return has('--strict') && report.totals.selfReferential > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
