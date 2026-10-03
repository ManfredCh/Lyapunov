/**
 * dist-inventory · 产物陈旧性盘点
 *
 * 判据：`产物` 的输入面 = 从**构建入口**出发、按**模块解析**走出来的传递闭包；闭包里最新的 mtime
 * 晚于产物 mtime ⇒ STALE。`--scope=legacy` 复现旧口径（输入面只看 `packages/<pkg>/src/**`），
 * 用于负对照：旧口径看不见 `script/**`，所以 `packages/desktop/dist/main.js` 会被判 ok。
 *
 * 为什么输入面必须从模块解析导出（而不是硬编一份目录清单）：
 *   `packages/desktop/src/main.ts:9` import `../../../script/host.ts`，而 `script/host.ts` 又内联
 *   `script/runtime-patch.ts` / `script/engine-preference.ts` / `script/profile.ts`。
 *   ⇒ 这类产物的输入在 `packages/` 之外，任何"只扫 packages/<pkg>/src"的盘点**物理上看不见**。
 *   同理还有跨包内联（`@lyapunov/*` 未列 external 时被内联）与 node_modules 里指回工作树的软链。
 *
 * 构建计划（哪个产物由哪个入口产出）从**构建脚本本身**导出：
 *   - `script/build-plugins.ts`（`bun run build:plugins`）
 *   - `script/build-desktop.ts`（`bun run build:desktop`）
 * 包内相对入口（`join(dir,"src/plugin.ts")` 之类）按"哪个包存在该文件"展开 —— 与构建脚本自身的
 * 循环条件一致。双侧校验兜底，避免解析器悄悄漏掉一处：
 *   - DRIFT：构建脚本里的 `Bun.build(...)` 调用没有产出任何计划条目
 *   - UNEXPLAINED：磁盘上的产物没有任何计划条目解释它
 *
 * 用法：
 *   bun script/dist-inventory.ts                     # 全量盘点（resolved 口径）
 *   bun script/dist-inventory.ts --scope=legacy      # 负对照：复现旧口径的盲区
 *   bun script/dist-inventory.ts --check             # 有 STALE/MISSING/UNEXPLAINED/DRIFT 时 exit 1
 *   bun script/dist-inventory.ts --json              # 机器可读
 *   bun script/dist-inventory.ts --exact             # 逐字节复核（内存重建 + sha256；消除 mtime 口径的假阳性）
 *   bun script/dist-inventory.ts --baseline=<dir>    # 与另一棵树（如发行快照）逐字节比对产物
 *
 * 只读工具：不写任何文件（`--baseline` 也只读）。
 *
 * ── 两条"非 import 输入"必须显式补，否则物理上看不见 ──
 *   1. `new URL('字面量', import.meta.url)` 的运行期资产（构建会随包复制）—— 见 `extractSpecifiers()`
 *   2. **第 9 类：构建期读取的 `packages/<pkg>/package.json`**（`name` → `client.js` 的 ModuleLoader
 *      wrapper id；也决定 `node_modules/<name>` 软链目标 = 解析面）—— 见 `inputClosure()` 尾部。
 *      它既不是 import，也不在 `src/**` 下 ⇒ 旧口径（legacy）与"只走模块解析"的 resolved 都看不见；
 *      本工具把它**显式并入 resolved 输入面**（kind = `package-meta`），并在 SUMMARY 之后单独打印一节。
 *
 * ── `--exact` 的两条边界（别把它当万能判据）──
 *   (a) **exact 只判 bundle 字节**：`packages/blender/dist/plugin.js` 的运行期资产是
 *       `packages/blender/python/{cad_inspect,drawing_inspect,camera_fit}.py`（经 `new URL('…/python/x.py')`
 *       进闭包，但**不被复制、也不影响 bundle 字节**）。这类文件被改时：mtime 红 / exact `same`
 *       ⇒ **此时"红"是有信息的**，不能拿 `exact=same` 当"没事"。
 *       （对 `dist/*.py` 这类**复制型**产物 exact 是准的：它比的就是副本字节。）
 *   (b) **exact 不记录构建期 env**：`script/build-plugins.ts` 的 5 处 `Bun.build`（:16 / :22 / :30 / :33 / :40）
 *       **都没有 `define`**，而 Bun 默认把构建机的 `process.env.NODE_ENV` 内联进 bundle
 *       （仓内注释自己写了这件事：`script/build-desktop.ts:10`、`script/package-linux.ts:233`）。
 *       ⇒ exact 的 `same` 是"**在我这个 env 下**重建一致"；插件闭包一旦开始引用 `NODE_ENV`，
 *       就会出现"改 env 即改产物、而输入面里没有 env"的又一类盲区（今天 0 例）。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs"
import { builtinModules } from "node:module"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

export type Scope = "resolved" | "legacy"

export type Target = {
  /** 绝对路径入口 */
  entry: string
  /** 绝对路径产物 */
  output: string
  /** 产物归属的包目录（绝对路径）—— legacy 口径的输入面按它取 */
  packageDir: string
  /** 构建脚本里声明的 external（glob 或精确名）；`allBare` 为真时所有裸标识符都 external */
  externals: string[]
  allBare: boolean
  /** 纵使匹配 external 也被构建插件强制内联的裸标识符前缀 */
  forceInline: string[]
  target: "node" | "browser" | null
  /** 产物由 `copyFile` 产出（.py 之类），入口即输入 */
  copy: boolean
  /** 构建期读了本包 `package.json`（第 9 类）：`name` 进 wrapper id / 决定 `node_modules/<name>` 软链目标 */
  packageMeta: boolean
  /** 计划条目来自哪个构建脚本 */
  origin: string
  /** 该计划条目由哪一行构建脚本导出（供核对） */
  note: string
  /** ── 以下是"逐字节复核"（--exact）复现构建所需的参数 ── */
  format: "esm" | "cjs" | "iife" | null
  minify: boolean
  /** `define:{"process.env.NODE_ENV":"process.env.NODE_ENV"}`（保留运行期读取） */
  defineNodeEnvSelf: boolean
  /** 浏览器目标固定内联 production */
  defineProduction: boolean
  /** 自定义 bundler 插件（客户端/远端终端），按名字复现 */
  plugin: "native-workspace-path" | "remote-scope" | null
  /** 产物是 `dist/client.js` 的 ModuleLoader 包装（包装文本由构建脚本给出，这里按同一模板复现） */
  clientWrapper: boolean
  /** 复制源本身由计划内Bun.build产生时，递归追溯其源输入和精确字节。 */
  copyProducer?: Target
}

export type InputFile = {
  path: string
  mtimeMs: number
  /** 分类：package-src / script / packages-other / node-modules / upstream / other */
  kind: string
  /** 包名（若在 packages/<pkg>/ 下） */
  pkg: string | null
}

export type ArtifactReading = {
  output: string
  rel: string
  pkg: string | null
  verdict: "ok" | "STALE" | "MISSING"
  outputMtimeMs: number | null
  inputCount: number
  newest: InputFile | null
  /** 输入里晚于产物的文件（STALE 的成因）；按 mtime 降序 */
  contributors: InputFile[]
  /** 晚于产物、且**不在** `packages/<pkg>/src` 下的输入 —— 旧口径看不见的那部分 */
  invisibleContributors: InputFile[]
  /** 晚于产物、且**不在**任一 `packages/<pkg>/src` 下的输入 */
  outsidePackagesContributors: InputFile[]
  unresolved: string[]
  /** 逐字节复核结论（--exact） */
  exact?: ExactVerdict
}

export type ScanResult = {
  scope: Scope
  /** `--exact`：逐字节复核（内存重建 + sha256），未开时为 undefined */
  exact?: { same: number; differs: number; unavailable: number }
  artifacts: ArtifactReading[]
  unexplained: string[]
  missingTargets: string[]
  planSize: number
  drift: string[]
  stageOnlyBuilds: string[]
  /** bake.py 的复制判据命中、但 dist 下没有副本（另列，不参与 STALE/MISSING） */
  workerWithoutCopy?: string[]
  /** 第 9 类：构建期读取的 `packages/<pkg>/package.json`（旧口径看不见；本工具显式并入输入面） */
  packageMeta: PackageMetaReading[]
}

/** 第 9 类的逐产物读数：谁在构建期读了哪份 `package.json`、这个 name 进到哪、是否就是本轮 STALE 的成因 */
export type PackageMetaReading = {
  /** 产物（相对 root） */
  artifact: string
  /** 构建期读取的元数据（相对 root） */
  meta: string
  /** `name` 进的去向：client wrapper id（进字节）/ node_modules 软链目标（进解析面） */
  role: "wrapper-id" | "resolution-surface"
  /** 该元数据的 mtime 是否晚于产物（= 本轮 STALE 的成因之一） */
  contributes: boolean
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(p, "utf8")

/** 剥掉注释（保留字符串字面量、换行与长度），避免注释里的 import/from 被当成真依赖 */
export function maskComments(text: string): string {
  const out = Array.from(text)
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      i++
      while (i < n) {
        const d = text[i]!
        if (d === "\\") { i += 2; continue }
        if (d === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") { out[i] = " "; i++ }
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] !== "\n") out[i] = " "; i++ }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2 }
      continue
    }
    i++
  }
  return out.join("")
}

/**
 * 从源码里取出所有模块说明符。
 * 主路径用 **Bun 自己的 `Transpiler.scanImports`**（与 bundler 同一套解析），它天然：
 * 跳过注释、抹掉 `import type`/`export type`、认出 require / dynamic import。
 * 另补一条 `new URL(spec, import.meta.url)` —— 运行期按相对位置找的资产（构建会随包复制）。
 */
export function extractSpecifiers(text: string, file = "x.ts"): { value: string[]; typeOnly: string[] } {
  const value: string[] = []
  const typeOnly: string[] = []
  const loader = file.endsWith(".tsx") ? "tsx" : file.endsWith(".jsx") ? "jsx"
    : (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) ? "js" : "ts"
  try {
    const found = new Bun.Transpiler({ loader }).scanImports(text) as unknown as { kind: string; path: string }[]
    for (const spec of found) {
      if (!spec?.path) continue
      if (/^[a-z]+:\/\//.test(spec.path)) continue
      value.push(spec.path)
    }
  } catch {
    // 语法不识别时退回正则（保守：可能多算，不会漏算）
    const code = maskComments(text)
    for (const m of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) if (m[1]) value.push(m[1])
    for (const m of code.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)) if (m[1]) value.push(m[1])
  }
  for (const m of maskComments(text).matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) if (m[1]) value.push(m[1])
  return { value: [...new Set(value)], typeOnly }
}

const BUILTIN = /^(node:|bun:)/
const BUILTIN_BARE = new Set([...builtinModules, ...builtinModules.map(m => m.replace(/\/.*$/, ""))])
const EXT_CANDIDATES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".html", ".wasm", ".txt"]

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/** 相对/绝对说明符 → 磁盘文件（TS 口径：无扩展、`./x.js` 实指 `./x.ts` 都要命中） */
function resolvePathSpecifier(spec: string, fromFile: string): string | undefined {
  const base = spec.startsWith("/") ? spec : resolve(dirname(fromFile), spec)
  const cands = [base]
  const ext = extname(base)
  if (!ext) {
    for (const e of EXT_CANDIDATES) cands.push(base + e)
    for (const e of EXT_CANDIDATES) cands.push(join(base, "index" + e))
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const stem = base.slice(0, -ext.length)
    for (const e of [".ts", ".tsx", ".mts", ".cts"]) cands.push(stem + e)
    for (const e of EXT_CANDIDATES) cands.push(join(stem, "index" + e))
  }
  for (const c of cands) if (isFile(c)) return c
  return undefined
}

const isBare = (spec: string) => !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("#")

function externalMatch(spec: string, target: Target): boolean {
  for (const prefix of target.forceInline) if (spec === prefix || spec.startsWith(prefix + "/")) return false
  if (BUILTIN.test(spec)) return true
  if (BUILTIN_BARE.has(spec)) return true
  if (target.allBare && isBare(spec)) return true
  for (const pattern of target.externals) {
    if (pattern.endsWith("/*")) { if (spec.startsWith(pattern.slice(0, -1))) return true }
    else if (spec === pattern) return true
  }
  return false
}

/** 裸标识符 → 磁盘文件；跟随软链到真实路径（`node_modules/@lyapunov/x` 指回 `packages/x`） */
function resolveBareSpecifier(spec: string, fromFile: string): string | undefined {
  try {
    const resolved = Bun.resolveSync(spec, dirname(fromFile))
    let real = resolved
    try { real = realpathSync(resolved) } catch { /* 保留原路径 */ }
    return isFile(real) ? real : undefined
  } catch { return undefined }
}

export function classify(path: string, root: string): { kind: string; pkg: string | null } {
  const rel = relative(root, path)
  if (rel.startsWith("..")) return { kind: "outside-root", pkg: null }
  const parts = rel.split(sep)
  if (parts[0] === "packages" && parts[1]) {
    // 第 9 类：`packages/<pkg>/package.json` 是**构建期读取的元数据**（既不是 import、也不在 src/** 下）
    if (parts.length === 3 && parts[2] === "package.json") return { kind: "package-meta", pkg: parts[1] }
    const srcIdx = parts.indexOf("src")
    return { kind: srcIdx === 2 ? "package-src" : "packages-other", pkg: parts[1] }
  }
  if (parts[0] === "script") return { kind: "script", pkg: null }
  if (parts[0] === "distribution") return { kind: "distribution", pkg: null }
  if (rel.includes(`${sep}node_modules${sep}`)) return { kind: "node-modules", pkg: null }
  if (parts[0] === ".upstream") return { kind: "upstream", pkg: null }
  return { kind: "root-other", pkg: null }
}

const mtimeOf = (p: string): number => statSync(p).mtimeMs

// ── 构建计划：从构建脚本里导出 ────────────────────────────────────────────────

/** 取出 `Bun.build(` 后面的对象字面量实参（跳字符串，按括号配平） */
function extractObjectCalls(text: string, callee: string): string[] {
  const out: string[] = []
  const re = new RegExp(callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(", "g")
  for (const m of text.matchAll(re)) {
    let i = m.index + m[0].length
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text[i] !== "{") continue
    const start = i
    let depth = 0
    let quote: string | null = null
    for (; i < text.length; i++) {
      const c = text[i]!
      if (quote) {
        if (c === "\\") { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue }
      if (c === "{" || c === "[" || c === "(") depth++
      else if (c === "}" || c === "]" || c === ")") { depth--; if (depth === 0) { i++; break } }
    }
    out.push(text.slice(start, i))
  }
  return out
}

/** 对象字面量的顶层切分（逗号分隔，感知括号与字符串） */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (quote) {
      if (c === "\\") { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue }
    if (c === "{" || c === "[" || c === "(") depth++
    else if (c === "}" || c === "]" || c === ")") depth--
    else if (c === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1 }
  }
  parts.push(body.slice(start))
  return parts.map(p => p.trim()).filter(Boolean)
}

/** `{...}` → key: expr */
function properties(objLiteral: string): Map<string, string> {
  const inner = objLiteral.slice(1, -1)
  const map = new Map<string, string>()
  for (const part of splitTopLevel(inner)) {
    const idx = part.indexOf(":")
    if (idx < 0) continue
    const key = part.slice(0, idx).trim().replace(/^["']|["']$/g, "")
    map.set(key, part.slice(idx + 1).trim())
  }
  return map
}

const stringLiterals = (expr: string): string[] => [...expr.matchAll(/["']([^"']*)["']/g)].map(m => m[1]!)

/**
 * 求 `join(A, "b", "c")` / 字符串字面量 的值。
 * `bases` 把 `root`/`desktop`/`dir` 这类标识符绑到具体目录；未知标识符返回 undefined。
 */
function evalPathExpr(expr: string, bases: Record<string, string | null>): string | undefined {
  const trimmed = expr.trim()
  if (/^["']/.test(trimmed)) return stringLiterals(trimmed)[0]
  const call = /^join\s*\(([\s\S]*)\)$/.exec(trimmed)
  if (!call) return undefined
  const args = splitTopLevel(call[1]!)
  const segments: string[] = []
  for (const arg of args) {
    if (/^["']/.test(arg)) { segments.push(stringLiterals(arg)[0]!); continue }
    const ident = arg.trim()
    const bound = bases[ident]
    if (bound === undefined) return undefined
    if (bound === null) return undefined
    segments.push(bound)
  }
  return segments.length ? join(...segments) : undefined
}

/** 从 `entry:"main.ts"` + `output:join(desktop,"dist/main.js")` 的对象字面量里成对取出入口/产物 */
function pairEntryOutputLiterals(text: string, base: string): { entry: string; output: string }[] {
  const pairs: { entry: string; output: string }[] = []
  // 直接扫对象字面量：以 `{` 起、配平 `}` 止，内部同时含 entry 与 output
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    let depth = 0
    let quote: string | null = null
    let j = i
    for (; j < text.length; j++) {
      const c = text[j]!
      if (quote) { if (c === "\\") { j++; continue } if (c === quote) quote = null; continue }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue }
      if (c === "{") depth++
      else if (c === "}") { depth--; if (depth === 0) { j++; break } }
    }
    const literal = text.slice(i, j)
    if (literal.includes("\n") && literal.length > 4000) { i = j - 1; continue }
    const entry = /\bentry\s*:\s*["']([^"']+)["']/.exec(literal)
    const output = /\boutput\s*:\s*join\s*\(([\s\S]*?)\)\s*[,}]/.exec(literal)
    if (entry && output) {
      const dir = evalPathExpr("join(" + output[1] + ")", { desktop: base } as Record<string, string>)
      if (dir) pairs.push({ entry: entry[1]!, output: dir })
    }
    i = j - 1
  }
  return pairs
}

type StaticValue = string | number | boolean | StaticValue[]
type StaticEnvironment = Record<string, StaticValue>

/** 只读解析构建语句：不执行builder、不按worker名称推断产物。 */
function declaredCopyTargets(text: string, root: string, pkgNames: readonly string[]): {targets: Target[]; drift: string[]} {
  const file=ts.createSourceFile('build-plugins.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
  const targets:Target[]=[],drift=new Set<string>()
  const copies:ts.CallExpression[]=[]
  const walk=(node:ts.Node,visit:(n:ts.Node)=>void):void=>{visit(node);ts.forEachChild(node,n=>walk(n,visit))}
  walk(file,node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='copyFile')copies.push(node)})
  const unwrap=(expr:ts.Expression):ts.Expression=>ts.isAwaitExpression(expr)||ts.isParenthesizedExpression(expr)||ts.isAsExpression(expr)||ts.isTypeAssertionExpression(expr)?unwrap(expr.expression):expr
  const declaration=(name:string,use:ts.Node):ts.Expression|undefined=>{
    for(let at:ts.Node|undefined=use;at;at=at.parent){
      if(!ts.isSourceFile(at)&&!ts.isBlock(at))continue
      for(const statement of [...at.statements].reverse()){
        if(statement.pos>=use.pos||!ts.isVariableStatement(statement))continue
        for(const d of [...statement.declarationList.declarations].reverse())if(ts.isIdentifier(d.name)&&d.name.text===name)return d.initializer
      }
    }
    return undefined
  }
  const value=(raw:ts.Expression,use:ts.Node,env:StaticEnvironment,seen=new Set<string>()):StaticValue|undefined=>{
    const expr=unwrap(raw)
    if(ts.isStringLiteral(expr)||ts.isNoSubstitutionTemplateLiteral(expr))return expr.text
    if(ts.isNumericLiteral(expr))return Number(expr.text)
    if(expr.kind===ts.SyntaxKind.TrueKeyword)return true
    if(expr.kind===ts.SyntaxKind.FalseKeyword)return false
    if(ts.isIdentifier(expr)){
      if(Object.hasOwn(env,expr.text))return env[expr.text]
      if(seen.has(expr.text))return
      const bound=declaration(expr.text,use)
      return bound?value(bound,use,env,new Set([...seen,expr.text])):undefined
    }
    if(ts.isArrayLiteralExpression(expr)){
      const values=expr.elements.map(e=>value(e,use,env,seen));return values.every(v=>v!==undefined)?values as StaticValue[]:undefined
    }
    if(ts.isPropertyAccessExpression(expr)&&expr.name.text==='length'){
      const base=value(expr.expression,use,env,seen);if(typeof base==='string'||Array.isArray(base))return base.length
    }
    if(ts.isPrefixUnaryExpression(expr)&&expr.operator===ts.SyntaxKind.ExclamationToken){const v=value(expr.operand,use,env,seen);return v===undefined?undefined:!v}
    if(ts.isBinaryExpression(expr)){
      const a=value(expr.left,use,env,seen),b=value(expr.right,use,env,seen)
      switch(expr.operatorToken.kind){
        case ts.SyntaxKind.BarBarToken:return a===true||b===true?true:a===false&&b===false?false:undefined
        case ts.SyntaxKind.AmpersandAmpersandToken:return a===false||b===false?false:a===true&&b===true?true:undefined
        case ts.SyntaxKind.EqualsEqualsEqualsToken:case ts.SyntaxKind.EqualsEqualsToken:return a===undefined||b===undefined?undefined:a===b
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:case ts.SyntaxKind.ExclamationEqualsToken:return a===undefined||b===undefined?undefined:a!==b
      }
    }
    if(!ts.isCallExpression(expr))return
    if(ts.isIdentifier(expr.expression)){
      const args=expr.arguments.map(a=>value(a,use,env,seen))
      if(expr.expression.text==='join'&&args.every(a=>typeof a==='string'))return join(...args as string[])
      if(expr.expression.text==='readdir'&&typeof args[0]==='string'&&existsSync(args[0]))return readdirSync(args[0])
    }
    if(ts.isPropertyAccessExpression(expr.expression)){
      const method=expr.expression.name.text
      if(method==='exists'&&ts.isCallExpression(expr.expression.expression)&&expr.expression.expression.expression.getText(file)==='Bun.file'){
        const path=expr.expression.expression.arguments[0]?value(expr.expression.expression.arguments[0],use,env,seen):undefined
        return typeof path==='string'?isFile(path):undefined
      }
      const base=value(expr.expression.expression,use,env,seen)
      const arg=expr.arguments[0]?value(expr.arguments[0],use,env,seen):undefined
      if(method==='endsWith'&&typeof base==='string'&&typeof arg==='string')return base.endsWith(arg)
      if(method==='includes'&&(typeof base==='string'||Array.isArray(base))&&typeof arg==='string')return base.includes(arg)
      if(method==='filter'&&Array.isArray(base)&&expr.arguments[0]&&ts.isArrowFunction(expr.arguments[0])){
        const fn=expr.arguments[0],parameter=fn.parameters[0]?.name
        if(parameter&&ts.isIdentifier(parameter)&&!ts.isBlock(fn.body)){
          const filtered:StaticValue[]=[]
          for(const item of base){const accepted=value(fn.body,use,{...env,[parameter.text]:item},seen);if(accepted===undefined)return;if(accepted)filtered.push(item)}
          return filtered
        }
      }
      // bundle文本条件只认真实Bun.build的outputs→text，不把任意some/includes当构建事实。
      if(method==='some'&&ts.isIdentifier(expr.expression.expression)&&expr.arguments[0]&&ts.isArrowFunction(expr.arguments[0])){
        const fn=expr.arguments[0],parameter=fn.parameters[0]?.name
        if(!parameter||!ts.isIdentifier(parameter)||ts.isBlock(fn.body))return
        const body=unwrap(fn.body)
        if(!ts.isCallExpression(body)||!ts.isPropertyAccessExpression(body.expression)||body.expression.name.text!=='includes'||!ts.isIdentifier(body.expression.expression)||body.expression.expression.text!==parameter.text)return
        const needle=body.arguments[0]?value(body.arguments[0],use,env,seen):undefined
        const texts=declaration(expr.expression.expression.text,use)
        if(typeof needle!=='string'||!texts)return
        const producers=new Set<string>();let readsText=false
        walk(texts,n=>{
          if(ts.isPropertyAccessExpression(n)&&n.name.text==='outputs'&&ts.isIdentifier(n.expression))producers.add(n.expression.text)
          if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='text')readsText=true
        })
        if(!readsText||producers.size!==1)return
        const build=declaration([...producers][0]!,use)
        const call=build?unwrap(build):undefined
        if(!call||!ts.isCallExpression(call)||call.expression.getText(file)!=='Bun.build'||!call.arguments[0]||!ts.isObjectLiteralExpression(call.arguments[0]))return
        const entryProperty=call.arguments[0].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==='entrypoints')
        const entries=entryProperty&&ts.isPropertyAssignment(entryProperty)?value(entryProperty.initializer,use,env,seen):undefined
        if(!Array.isArray(entries)||!entries.every(e=>typeof e==='string'))return
        const outputProperty=call.arguments[0].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==='outdir')
        const outputDir=outputProperty&&ts.isPropertyAssignment(outputProperty)?value(outputProperty.initializer,use,env,seen):undefined
        const namingProperty=call.arguments[0].properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==='naming')
        const naming=namingProperty&&ts.isPropertyAssignment(namingProperty)?value(namingProperty.initializer,use,env,seen):'[name].js'
        if(typeof outputDir!=='string'||typeof naming!=='string')return
        let unavailable=false
        for(const entry of entries as string[]){
          if(!isFile(entry))continue
          const output=join(outputDir,naming.replace('[name]',basename(entry).replace(/\.[^.]+$/,'')))
          if(!isFile(output)){unavailable=true;continue}
          // 原builder测试的是实际bundle字节；源闭包里的未引用函数会被tree-shake，不能当输出标记。
          if(read(output).includes(needle))return true
        }
        return unavailable?undefined:false
      }
    }
    return undefined
  }
  for(const copy of copies){
    const ancestors:ts.Node[]=[]
    for(let at:ts.Node|undefined=copy.parent;at;at=at.parent)ancestors.unshift(at)
    const loops=ancestors.filter(ts.isForOfStatement)
    const continues:Array<{guard:ts.IfStatement;depth:number}>=[]
    for(const block of ancestors.filter(n=>ts.isBlock(n)||ts.isSourceFile(n))){
      for(const statement of (block as ts.Block|ts.SourceFile).statements){
        if(statement.end>copy.pos||!ts.isIfStatement(statement))continue
        if(ts.isContinueStatement(statement.thenStatement))continues.push({guard:statement,depth:loops.filter(loop=>statement.pos>=loop.statement.pos&&statement.end<=loop.statement.end).length})
      }
    }
    const skipped=(env:StaticEnvironment,depth:number):boolean=>{
      for(const {guard,depth:guardDepth}of continues){
        if(guardDepth>depth)continue // 尚未进入该循环时，其局部绑定还不能求值。
        const result=value(guard.expression,copy,env)
        if(result===undefined){drift.add(`script/build-plugins.ts：copyFile前置continue条件未解析 → ${guard.expression.getText(file).slice(0,120)}`);return true}
        if(result)return true
      }
      return false
    }
    let environments:StaticEnvironment[]=[{root,packages:[...pkgNames],only:[]}]
    for(const [depth,loop]of loops.entries()){
      if(!ts.isVariableDeclarationList(loop.initializer)||loop.initializer.declarations.length!==1||!ts.isIdentifier(loop.initializer.declarations[0]!.name)){environments=[];break}
      const name=(loop.initializer.declarations[0]!.name as ts.Identifier).text
      const expanded:StaticEnvironment[]=[]
      for(const env of environments){
        if(skipped(env,depth))continue
        const items=value(loop.expression,copy,env)
        if(!Array.isArray(items)){drift.add(`script/build-plugins.ts：copyFile循环集合未解析 → ${loop.expression.getText(file).slice(0,120)}`);continue}
        for(const item of items)expanded.push({...env,[name]:item})
      }
      environments=expanded
    }
    for(const env of environments){
      if(skipped(env,loops.length))continue
      let accepted=true
      for(const condition of ancestors.filter(ts.isIfStatement)){
        const result=value(condition.expression,copy,env)
        if(result===undefined){drift.add(`script/build-plugins.ts：copyFile条件未解析 → ${condition.expression.getText(file).slice(0,120)}`);accepted=false;break}
        const inThen=copy.pos>=condition.thenStatement.pos&&copy.end<=condition.thenStatement.end
        if(Boolean(result)!==inThen){accepted=false;break}
      }
      if(!accepted)continue
      const from=copy.arguments[0]?value(copy.arguments[0],copy,env):undefined,to=copy.arguments[1]?value(copy.arguments[1],copy,env):undefined
      if(typeof from!=='string'||typeof to!=='string'){drift.add(`script/build-plugins.ts：copyFile源/目标未解析 → ${copy.getText(file).slice(0,120)}`);continue}
      const owner=dirname(to)
      if(basename(owner)!=='dist'||!to.startsWith(join(root,'packages')+sep)){drift.add(`script/build-plugins.ts：copyFile目标不属于包dist → ${relative(root,to)}`);continue}
      const pkg=dirname(owner)
      targets.push({entry:from,output:to,packageDir:pkg,externals:[],allBare:true,forceInline:[],target:null,copy:true,packageMeta:false,origin:'script/build-plugins.ts',note:`copyFile ${copy.getText(file)}（字面量/词法绑定/循环展开）`,format:null,minify:false,defineNodeEnvSelf:false,defineProduction:false,plugin:null,clientWrapper:false})
    }
  }
  return {targets:[...new Map(targets.map(t=>[t.output,t])).values()],drift:[...drift]}
}

export function derivePlan(root: string): { targets: Target[]; drift: string[]; stageOnlyBuilds: string[]; workerWithoutCopy: string[] } {
  const targets: Target[] = []
  const drift: string[] = []
  const stageOnlyBuilds: string[] = []
  const workerWithoutCopy: string[] = []
  const pkgNames = readdirSync(join(root, "packages"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  const packageDir = (name: string) => join(root, "packages", name)

  // ── script/build-plugins.ts ────────────────────────────────────────────────
  const pluginsPath = join(root, "script/build-plugins.ts")
  const plugins = read(pluginsPath)
  // 构建脚本里的 `const entry=join(dir,"src/plugin.ts")` 这类绑定：入口表达式常常是个标识符
  const bindings = new Map<string, string>()
  for (const m of plugins.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(join\s*\([^\n;]*\))/g)) bindings.set(m[1]!, m[2]!)
  const calls = extractObjectCalls(plugins, "Bun.build")
  if (!calls.length) drift.push("script/build-plugins.ts：没解析到任何 Bun.build 调用")
  for (const call of calls) {
    const props = properties(call)
    const entryExprs = (props.get("entrypoints") ?? "").replace(/^\[|\]$/g, "")
    const outdirExpr = props.get("outdir")
    const naming = props.get("naming")
    const external = props.get("external")
    const allBare = /packages\s*:\s*["']external["']/.test(call)
    const targetKind = (stringLiterals(props.get("target") ?? "")[0] ?? null) as "node" | "browser" | null
    const externals = external ? stringLiterals(external) : []
    // 构建插件里 `external:false` 的 onResolve —— 命中的裸标识符会被强制内联
    const forceInline = /workspace-path/.test(call) && /external\s*:\s*false/.test(call)
      ? ["@deepseek-ai/dsh-util-workspace-path"]
      : []
    for (const rawEntry of splitTopLevel(entryExprs)) {
      let entryExpr = rawEntry.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(entryExpr) && bindings.has(entryExpr)) entryExpr = bindings.get(entryExpr)!  // const 绑定
      const literalOnly = evalPathExpr(entryExpr, { root, dir: null })
      const entries: string[] = []
      let fromPackageLoop = false   // 入口写成 `join(dir, …)` ⇒ 该 Bun.build 在 `script/build-plugins.ts` 的**逐包循环**里
      if (literalOnly) {
        entries.push(literalOnly)                                            // join(root,"packages/X/src/…")
      } else if (/^join\s*\(/.test(entryExpr)) {
        const inner = splitTopLevel(/^join\s*\(([\s\S]*)\)$/.exec(entryExpr)![1]!)
        const relSegs = inner.slice(1).filter(a => /^["']/.test(a)).map(a => stringLiterals(a)[0]!)  // dir 之外的段
        const baseExpr = inner[0]!.trim()
        if (baseExpr === "dir") {                                            // 包内相对入口：按"哪个包有该文件"展开
          fromPackageLoop = true
          for (const name of pkgNames) {
            const candidate = join(packageDir(name), ...relSegs)
            if (isFile(candidate)) entries.push(candidate)
          }
        }
      }
      if (!entries.length) { drift.push(`script/build-plugins.ts：入口表达式未解析 → ${entryExpr.replace(/\s+/g, " ").slice(0, 120)}`); continue }
      for (const entry of entries) {
        const pkgDir = dirname(dirname(entry))                                // …/packages/<name>
        const outBase = outdirExpr
          ? (evalPathExpr(outdirExpr, { root, dir: pkgDir }) ?? undefined)
          : undefined
        const stem = naming && stringLiterals(naming)[0]!.includes("[name]")
          ? basename(entry).replace(/\.[^.]+$/, "") + stringLiterals(naming)[0]!.replace("[name]", "")
          : basename(entry).replace(/\.[^.]+$/, "") + ".js"
        const output = outBase ? join(outBase, stem) : join(pkgDir, "dist", stem)
        targets.push({
          entry, output, packageDir: pkgDir, externals, allBare, forceInline,
          // 逐包循环里 `:56` 每个包都读 `package.json` 取 `pkg.name`（决定 `node_modules/<name>` 软链目标），
          // 客户端那一轮 `:62-66` 再读一次把 name 写进 wrapper id ⇒ 第 9 类输入。
          // 循环外的两次构建（:16 lyaup-migrations / :22 product-bundle cli）不读它 ⇒ false。
          packageMeta: fromPackageLoop,
          target: targetKind, copy: false, origin: "script/build-plugins.ts",
          note: `Bun.build(${entryExpr.replace(/\s+/g, " ").slice(0, 80)})`,
          format: (stringLiterals(props.get("format") ?? "")[0] ?? null) as Target["format"],
          minify: /minify\s*:\s*true/.test(call),   // Bun.build 默认不压缩；只有显式 true 才压缩
          defineNodeEnvSelf: /process\.env\.NODE_ENV["']\s*:\s*["']process\.env\.NODE_ENV["']/.test(call),
          defineProduction: /process\.env\.NODE_ENV["']\s*:\s*JSON\.stringify\(["']production["']\)/.test(call),
          plugin: /remoteScopePlugin/.test(call) ? "remote-scope" : /native-workspace-path/.test(call) ? "native-workspace-path" : null,
          clientWrapper: !outdirExpr,                                        // 客户端：无 outdir，由写手加 ModuleLoader 包装
        })
      }
    }
  }
  // copyFile的实际词法绑定/循环列表/目录枚举与条件决定复制产物；未知条件不猜。
  const declaredCopies=declaredCopyTargets(plugins,root,pkgNames)
  targets.push(...declaredCopies.targets)
  drift.push(...declaredCopies.drift)
  for(const target of declaredCopies.targets)if(!isFile(target.output))workerWithoutCopy.push(`${relative(root,target.output)}（构建明确复制，磁盘无副本）`)

  // ── script/build-desktop.ts ────────────────────────────────────────────────
  const desktopPath = join(root, "script/build-desktop.ts")
  const desktop = read(desktopPath)
  const desktopDir = join(root, "packages/desktop")
  const pairs = pairEntryOutputLiterals(desktop, desktopDir)
  if (!pairs.length) drift.push("script/build-desktop.ts：没解析到 entry/output 成对表")
  for (const pair of pairs) {
    const entry = join(desktopDir, "src", pair.entry)
    const externalExpr = (() => {
      const idx = desktop.indexOf(`entry:"${pair.entry}"`)
      if (idx < 0) return ""
      return desktop.slice(idx, idx + 400)
    })()
    const externals = stringLiterals(/external\s*:\s*(\[[^\]]*\])/.exec(externalExpr)?.[1] ?? "")
    const isBrowser = /account-view/.test(pair.entry)
    targets.push({
      entry, output: pair.output, packageDir: desktopDir, externals, allBare: false, forceInline: [],
      packageMeta: false,   // build-desktop.ts 不读 package.json
      target: isBrowser ? "browser" : "node", copy: false,
      origin: "script/build-desktop.ts", note: `entry=${pair.entry}`,
      format: (/preload/.test(pair.entry) ? "cjs" : isBrowser ? "iife" : "esm") as Target["format"],
      minify: false,
      defineNodeEnvSelf: !isBrowser,
      defineProduction: isBrowser,
      plugin: null,
      clientWrapper: false,
    })
  }
  if (!/Bun\.build/.test(desktop)) drift.push("script/build-desktop.ts：没找到 Bun.build")

  // ── 其它构建脚本（发行 stage 专用，不落 dev 树）—— 只报告，不参与 dev 树盘点 ──
  for (const file of readdirSync(join(root, "script")).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    if (file === "build-plugins.ts" || file === "build-desktop.ts") continue
    if (file === "dist-inventory.ts") continue   // 本工具自己会调 Bun.build（内存重建），不是产品构建计划
    const text = read(join(root, "script", file))
    const count = extractObjectCalls(text, "Bun.build").length
    if (count > 0) stageOnlyBuilds.push(`script/${file}（${count} 处 Bun.build；产物写发行 stage，不在 dev 树）`)
  }
  // 复制Bun产物时绑定真实producer；副本字节和输入链都不能只看陈旧dist文件。
  for(const target of targets)if(target.copy){
    const producer=targets.find(candidate=>candidate.output===target.entry&&candidate.output!==target.output)
    if(producer)target.copyProducer=producer
  }
  return { targets, drift, stageOnlyBuilds, workerWithoutCopy }
}

// ── 输入闭包 ─────────────────────────────────────────────────────────────────

export type ClosureOptions = {
  root: string
  scope: Scope
  /** 注入 mtime（负对照/测试用）；默认取真实 mtime */
  mtime?: (path: string) => number
}

// ── 逐字节复核（--exact）：按构建脚本的原参数在**内存里**重建，比 sha256 ──────────
//
// mtime 闭包是**上界**：某个输入被改了、但它改的那部分没进 bundle（tree-shaking / 未被引用的分支）
// 时，mtime 口径会报 STALE 而产物其实逐字节相同。这里用"照原参数重建 + 比 sha256"给出精确判定。

export type ExactVerdict = { verdict: "same" | "differs" | "unavailable"; reason?: string; freshBytes?: number }

const sha256 = (bytes: Uint8Array | ArrayBuffer): string => {
  const h = new Bun.CryptoHasher("sha256")
  h.update(bytes as Uint8Array)
  return h.digest("hex")
}

/** 复现 `script/build-plugins.ts:57` 的 ModuleLoader 包装 */
function clientWrapperText(js: string, pkgName: string): string {
  return `window.__ModuleLoader__.load({id:${JSON.stringify(pkgName)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${js}\nreturn module.exports;}});\n`
}

async function rebuildBytes(target: Target, root: string, seen=new Set<string>()):Promise<{bytes:Uint8Array}|{reason:string}>{
  if(seen.has(target.output))return {reason:'构建复制输入链成环'}
  const next=new Set([...seen,target.output])
  if (target.copy) {
    if(target.copyProducer)return rebuildBytes(target.copyProducer,root,next)
    if (!isFile(target.entry)) return { reason: "入口不存在" }
    return {bytes:new Uint8Array(readFileSync(target.entry))}
  }
  try {
    const plugins: Bun.BunPlugin[] = []
    if (target.plugin === "native-workspace-path") {
      plugins.push({ name: "native-workspace-path", setup(builder) { builder.onResolve({ filter: /^@deepseek-ai\/dsh-util-workspace-path(?:\/.*)?$/ }, args => ({ path: Bun.resolveSync(args.path, root), external: false })) } })
    } else if (target.plugin === "remote-scope") {
      const { remoteScopePlugin } = await import("./terminal-build.ts")
      plugins.push(remoteScopePlugin())
    }
    const built = await Bun.build({
      entrypoints: [target.entry],
      root,
      target: target.target ?? "node",
      format: target.format ?? "esm",
      external: target.externals,
      minify: target.minify,
      ...(target.defineNodeEnvSelf ? { define: { "process.env.NODE_ENV": "process.env.NODE_ENV" } } : {}),
      ...(target.defineProduction ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } } : {}),
      ...(target.allBare ? { packages: "external" as const } : {}),
      ...(plugins.length ? { plugins } : {}),
    })
    if (!built.success) return { reason: `重建失败：${built.logs.map(l => String(l)).join(" ").slice(0, 160)}` }
    let text = await built.outputs[0]!.text()
    if (target.clientWrapper) {
      const pkg = JSON.parse(read(join(target.packageDir, "package.json"))) as { name: string }
      text = clientWrapperText(text, pkg.name)
    }
    return {bytes:new TextEncoder().encode(text)}
  } catch (error) {
    return { reason: `重建异常：${String((error as Error)?.message ?? error).slice(0, 160)}` }
  }
}

export async function exactRebuild(target: Target, root: string): Promise<ExactVerdict> {
  if (!isFile(target.output)) return { verdict: "unavailable", reason: "产物不存在" }
  // Bun把进程cwd写入源注释；其它根的exact必须在该根重建，不能剥注释放松字节比较。
  if(resolve(process.cwd())!==resolve(root)){
    const program=`const {exactRebuild}=await import(${JSON.stringify(import.meta.path)});console.log(JSON.stringify(await exactRebuild(JSON.parse(process.argv[1]),process.cwd())));`
    const child=Bun.spawn([process.execPath,'--no-env-file','-e',program,JSON.stringify(target)],{cwd:root,stdout:'pipe',stderr:'pipe'})
    const [exit,text,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
    if(exit!==0)return {verdict:'unavailable',reason:`目标根重建失败：${error.slice(0,160)}`}
    return JSON.parse(text) as ExactVerdict
  }
  const fresh=await rebuildBytes(target,root)
  if('reason'in fresh)return {verdict:'unavailable',reason:fresh.reason}
  const disk=new Uint8Array(readFileSync(target.output))
  return {verdict:sha256(fresh.bytes)===sha256(disk)?'same':'differs',freshBytes:fresh.bytes.length}
}

/** legacy 口径：输入面 = `packages/<pkg>/src/**`（排除 __pycache__）—— 复现旧盘点的盲区 */
function legacyInputs(target: Target, mtime: (p: string) => number): InputFile[] {
  const out: InputFile[] = []
  const walk = (dir: string) => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) as Dirent[] } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== "__pycache__" && e.name !== "node_modules") walk(p); continue }
      if (e.name.endsWith(".pyc")) continue
      out.push({ path: p, mtimeMs: mtime(p), kind: "package-src", pkg: basename(target.packageDir) })
    }
  }
  walk(join(target.packageDir, "src"))
  return out
}

/** resolved 口径：从入口按模块解析走传递闭包（external 为叶，不进入） */
export function inputClosure(target: Target, options: ClosureOptions): { inputs: InputFile[]; unresolved: string[] } {
  const mtime = options.mtime ?? mtimeOf
  if (options.scope === "legacy") return { inputs: legacyInputs(target, mtime), unresolved: [] }
  if (target.copy) {
    if(target.copyProducer){
      const upstream=inputClosure(target.copyProducer,options)
      const inputs=[...upstream.inputs]
      if(isFile(target.entry)){const cls=classify(target.entry,options.root);inputs.push({path:target.entry,mtimeMs:mtime(target.entry),kind:cls.kind,pkg:cls.pkg})}
      else upstream.unresolved.push(target.entry)
      return {inputs:[...new Map(inputs.map(input=>[input.path,input])).values()],unresolved:upstream.unresolved}
    }
    if (!isFile(target.entry)) return { inputs: [], unresolved: [target.entry] }
    const cls = classify(target.entry, options.root)
    return { inputs: [{ path: target.entry, mtimeMs: mtime(target.entry), kind: cls.kind, pkg: cls.pkg }], unresolved: [] }
  }
  const inputs = new Map<string, InputFile>()
  const unresolved: string[] = []
  const seen = new Set<string>()
  const queue = [target.entry]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!isFile(file)) { unresolved.push(file); continue }
    const cls = classify(file, options.root)
    inputs.set(file, { path: file, mtimeMs: mtime(file), kind: cls.kind, pkg: cls.pkg })
    let text: string
    try { text = read(file) } catch { continue }
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) continue
    for (const spec of extractSpecifiers(text, file).value) {
      if (externalMatch(spec, target)) continue
      const resolvedFile = isBare(spec) || spec.startsWith("#")
        ? resolveBareSpecifier(spec, file)
        : (isAbsolute(spec) ? (isFile(spec) ? spec : undefined) : resolvePathSpecifier(spec, file))
      if (!resolvedFile) { unresolved.push(spec); continue }
      queue.push(resolvedFile)
    }
  }
  // ── 第 9 类：构建期读取的元数据（`packages/<pkg>/package.json`）──────────────────────────────
  // `script/build-plugins.ts:56` 在每个包的循环里读它取 `pkg.name`（决定 `node_modules/<name>` 软链目标 =
  // 解析面）；`:62-66` 再读一次，把 name 逐字写进 `dist/client.js` 的 ModuleLoader wrapper id（= 产物字节）。
  // 它既不是 `import`（模块解析走不到）、又不在 `src/**` 下（legacy 口径走不到）⇒ 两个 mtime 口径原本都看不见；
  // 唯一能看见它的是 `--exact`（重建时真的重读 package.json 的 name）。这里显式并进 resolved 输入面。
  if (target.packageMeta) {
    const meta = join(target.packageDir, "package.json")
    if (isFile(meta)) {
      const cls = classify(meta, options.root)
      inputs.set(meta, { path: meta, mtimeMs: mtime(meta), kind: cls.kind, pkg: cls.pkg })
    }
  }
  return { inputs: [...inputs.values()], unresolved }
}

// ── 盘点 ─────────────────────────────────────────────────────────────────────

/**
 * 磁盘产物（UNEXPLAINED 校验的**被减数**）：`packages/<pkg>/dist/**` 下所有非 `.pyc` 文件。
 *
 * 口径与 `script/build-plugins.ts` 的复制规则同形：`dist/` 下任何文件都算产物（递归），
 * 只有 `__pycache__` 与 `*.pyc` 排除 —— 那是 Python 运行期踩出来的缓存，不是构建产物。
 * 导出它，是为了让"磁盘这一侧真的会把多出来的文件读进来"能在**合成树**上被负对照钉住
 * （见 `unexplainedAgainstPlan`）。
 */
export function diskArtifacts(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const dist = join(root, "packages", name.name, "dist")
    if (!existsSync(dist)) continue
    const stack = [dist]
    while (stack.length) {
      const cur = stack.pop()!
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const p = join(cur, e.name)
        // dist 下的 __pycache__ 是 python 运行期踩出来的（与 src/__pycache__ 同类），不是构建产物
        if (e.isDirectory()) { if (e.name !== "__pycache__") stack.push(p); continue }
        if (e.name.endsWith(".pyc")) continue
        out.push(p)
      }
    }
  }
  return out.sort()
}

/**
 * **纯函数**：`磁盘产物 − 计划条目 = UNEXPLAINED`（判据本体，与文件系统无关）。
 *
 * 两个路径清单进、一个路径清单出 ⇒ 可以被**合成列表**直接钉住，不依赖工作树的当前状态：
 * 只要磁盘上多出一个计划解释不了的产物，它就必须出现在返回值里。
 *
 * 为什么单独抽出来：2026-09-27 那条历史孤儿（`packages/sim-mujoco/dist/worker.py`）被删之后，
 * 真实树上的 `unexplained` 合法地变成 `[]`；若只把期望值改成 `[]`（或给该路径开白名单），
 * 这条判据就再没有负对照 —— 判据退化成"跟着现状走"。抽成纯函数后，
 * `script/dist-inventory.test.ts` 用合成列表在"多一个文件"这一侧继续守着它。
 *
 * 比较用**全路径**（不是 basename）：`dist/worker.py` 与 `python/worker.py` 同名**不算**互相解释。
 * 返回值去重 + 排序，保证判据与遍历顺序无关。
 */
export function unexplainedAgainstPlan(disk: readonly string[], planned: Iterable<string>): string[] {
  const explained = new Set(planned)
  return [...new Set(disk)].filter(p => !explained.has(p)).sort()
}

export async function scan(root: string, scope: Scope, mtime?: (p: string) => number, exact = false): Promise<ScanResult> {
  const { targets, drift, stageOnlyBuilds, workerWithoutCopy } = derivePlan(root)
  const artifacts: ArtifactReading[] = []
  const missingTargets: string[] = []
  for (const target of targets) {
    const rel = relative(root, target.output)
    const pkg = basename(target.packageDir)
    if (!isFile(target.output)) {
      missingTargets.push(rel)
      artifacts.push({
        output: target.output, rel, pkg, verdict: "MISSING", outputMtimeMs: null, inputCount: 0,
        newest: null, contributors: [], invisibleContributors: [], outsidePackagesContributors: [], unresolved: [],
      })
      continue
    }
    const exactVerdict = exact ? await exactRebuild(target, root) : undefined
    const outputMtimeMs = (mtime ?? mtimeOf)(target.output)
    const { inputs, unresolved } = inputClosure(target, { root, scope, ...(mtime ? { mtime } : {}) })
    const sorted = [...inputs].sort((a, b) => b.mtimeMs - a.mtimeMs)
    const contributors = sorted.filter(i => i.mtimeMs > outputMtimeMs)
    const invisible = contributors.filter(i => !(i.kind === "package-src" && i.pkg === pkg))
    const outsidePackages = contributors.filter(i => !(i.kind === "package-src" && i.pkg !== null))
    artifacts.push({
      output: target.output, rel, pkg,
      verdict: contributors.length ? "STALE" : "ok",
      outputMtimeMs, inputCount: inputs.length,
      newest: sorted[0] ?? null, contributors, invisibleContributors: invisible,
      outsidePackagesContributors: outsidePackages, unresolved: [...new Set(unresolved)],
      ...(exactVerdict ? { exact: exactVerdict } : {}),
    })
  }
  const unexplained = unexplainedAgainstPlan(diskArtifacts(root), targets.map(t => t.output))
  const exactRows = artifacts.map(a => a.exact).filter(Boolean) as ExactVerdict[]
  // 第 9 类读数：构建期读了 `package.json` 的产物（`inputClosure` 已把它并进输入面）
  const packageMeta: PackageMetaReading[] = []
  for (const target of targets) {
    if (!target.packageMeta) continue
    const meta = join(target.packageDir, "package.json")
    if (!isFile(meta)) continue
    const reading = artifacts.find(a => a.output === target.output)
    packageMeta.push({
      artifact: relative(root, target.output),
      meta: relative(root, meta),
      role: target.clientWrapper ? "wrapper-id" : "resolution-surface",
      contributes: reading ? reading.contributors.some(c => c.path === meta) : false,
    })
  }
  return {
    scope,
    artifacts: artifacts.sort((a, b) => a.rel.localeCompare(b.rel)),
    unexplained: unexplained.map(p => relative(root, p)),
    missingTargets,
    planSize: targets.length,
    drift,
    stageOnlyBuilds,
    workerWithoutCopy,
    packageMeta,
    ...(exact ? { exact: {
      same: exactRows.filter(r => r.verdict === "same").length,
      differs: exactRows.filter(r => r.verdict === "differs").length,
      unavailable: exactRows.filter(r => r.verdict === "unavailable").length,
    } } : {}),
  }
}

// ── 与基线树逐字节比对 ───────────────────────────────────────────────────────

export type BaselineRow = { rel: string; verdict: "changed" | "same" | "missing-in-baseline" | "missing-here"; baselineBytes: number | null; hereBytes: number | null }

export function compareBaseline(root: string, baselineRoot: string): BaselineRow[] {
  const rows: BaselineRow[] = []
  const here = diskArtifacts(root)
  const alsoDesktop = [join(root, "packages/desktop/renderer/account.js")].filter(isFile)
  const all = [...new Set([...here, ...alsoDesktop])].sort()
  const hash = (p: string) => {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(readFileSync(p))
    return hasher.digest("hex")
  }
  for (const p of all) {
    const rel = relative(root, p)
    const base = join(baselineRoot, rel)
    if (!isFile(base)) { rows.push({ rel, verdict: "missing-in-baseline", baselineBytes: null, hereBytes: statSync(p).size }); continue }
    const a = hash(base), b = hash(p)
    rows.push({ rel, verdict: a === b ? "same" : "changed", baselineBytes: statSync(base).size, hereBytes: statSync(p).size })
  }
  return rows
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** 本地时区 `YYYY-MM-DD HH:MM:SS`（env 覆盖只影响显示，不影响判据） */
const fmt = (ms: number | null): string => {
  if (ms === null) return "(none)".padEnd(19)
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function printHuman(result: ScanResult, root: string, baseline?: BaselineRow[]): void {
  console.log(`### dist-inventory（scope=${result.scope}） ###`)
  console.log(`计划条目 ${result.planSize} / 产物 ${result.artifacts.length} / 磁盘产物 ${result.artifacts.length + result.unexplained.length}`)
  console.log("")
  const withExact = result.artifacts.some(a => a.exact)
  console.log("ARTIFACT".padEnd(48) + "VERDICT".padEnd(9) + (withExact ? "EXACT".padEnd(11) : "") + "OUT_MTIME".padEnd(21) + "IN".padEnd(5) + "NEWEST INPUT")
  for (const a of result.artifacts) {
    const newest = a.newest ? relative(root, a.newest.path) + (a.verdict === "STALE" ? ` (+${Math.round((a.newest.mtimeMs - (a.outputMtimeMs ?? 0)) / 1000)}s)` : "") : "—"
    const exactCol = withExact ? (a.exact ? (a.exact.verdict === "unavailable" ? "n/a" : a.exact.verdict === "same" ? "same" : "DIFFERS") : "—").padEnd(11) : ""
    console.log(a.rel.padEnd(48) + a.verdict.padEnd(9) + exactCol + fmt(a.outputMtimeMs).padEnd(21) + String(a.inputCount).padEnd(5) + newest)
  }
  if (withExact) {
    const differing = result.artifacts.filter(a => a.exact?.verdict === "differs")
    console.log("\n### 逐字节复核（--exact：按构建脚本原参数在内存里重建 + 比 sha256） ###")
    if (differing.length) for (const a of differing) console.log(`  DIFFERS  ${a.rel}  （重建字节 ${a.exact!.freshBytes} vs 盘上 ${statSync(a.output).size}）`)
    for (const a of result.artifacts.filter(x => x.exact?.verdict === "unavailable")) console.log(`  n/a      ${a.rel}  ${a.exact!.reason ?? ""}`)
    console.log(`  same=${result.exact?.same ?? 0} differs=${result.exact?.differs ?? 0} unavailable=${result.exact?.unavailable ?? 0}`)
  }
  // ── 第 9 类：构建期读取的元数据（package.json 的 name）───────────────────────────────────────
  if (result.packageMeta.length) {
    const wrapper = result.packageMeta.filter(r => r.role === "wrapper-id")
    const contributing = result.packageMeta.filter(r => r.contributes)
    let wrapperSame = 0
    for (const r of wrapper) {
      const dist = join(root, r.artifact)
      if (!isFile(dist)) continue
      const id = /__ModuleLoader__\.load\(\{id:("(?:[^"\\]|\\.)*")/.exec(read(dist))?.[1]
      const name = (JSON.parse(read(join(root, r.meta))) as { name?: string }).name
      if (id && name && JSON.parse(id) === name) wrapperSame++
    }
    console.log("\n### 第 9 类：构建期读取的元数据（package.json 的 name）###")
    console.log(`  构建期读它的产物：${result.packageMeta.length} / ${result.artifacts.length}（legacy 口径 0：不在 src/** 下 ⇒ 结构性看不见）`)
    if (wrapper.length) {
      console.log(`  wrapper id 逐字等于 package.json 的 name：${wrapperSame} / ${wrapper.length}` +
        `（${wrapper.map(r => r.meta.replace(/^packages\//, "").replace(/\/package\.json$/, "")).join(" / ")}）`)
    }
    for (const r of contributing) console.log(`  **STALE 成因**  ${r.artifact}  ← ${r.meta}  (${r.role})`)
    if (!contributing.length) console.log("  当前因它而 STALE 的产物：0（各 package.json 都没被写过）")
    console.log("  ↑ 改 name ⇒ 产物字节变（wrapper id）；legacy 看不见；resolved 只在它**被写过**时才红（mtime 是上界）；")
    console.log("    精确判定只有 --exact（重建时真的重读 package.json 的 name）—— 见文件头部`--exact` 的两条边界。")
  }
  const stale = result.artifacts.filter(a => a.verdict === "STALE")
  if (stale.length) {
    console.log("\n### STALE 成因（晚于产物的输入） ###")
    for (const a of stale) {
      console.log(`\n${a.rel}  ← 产物 ${fmt(a.outputMtimeMs)}`)
      for (const c of a.contributors) {
        const tag = c.kind === "package-src" && c.pkg === a.pkg ? "本包 src" : `**${c.kind}**`
        console.log(`  ${fmt(c.mtimeMs)}  ${tag.padEnd(12)}  ${relative(root, c.path)}`)
      }
      console.log(`  其中旧口径看不见的输入（不在 packages/${a.pkg}/src 下）：${a.invisibleContributors.length}`)
    }
  }
  const unresolvedAll = result.artifacts.flatMap(a => a.unresolved)
  if (unresolvedAll.length) {
    console.log(`\n### 解析不到（多为运行期资产说明符，非输入） ###`)
    for (const u of [...new Set(unresolvedAll)].slice(0, 20)) console.log(`  ${u}`)
  }
  if (result.workerWithoutCopy?.length) {
    console.log("\n### bundle 引用算法 worker 但 dist 下无副本（不进 STALE/MISSING） ###")
    for (const w of result.workerWithoutCopy) console.log(`  ${w}`)
  }
  if (result.unexplained.length) {
    console.log("\n### UNEXPLAINED：磁盘上的产物没有计划条目解释它 ###")
    for (const u of result.unexplained) console.log(`  ${u}`)
  }
  if (result.missingTargets.length) {
    console.log("\n### MISSING：计划里有、磁盘上没有 ###")
    for (const m of result.missingTargets) console.log(`  ${m}`)
  }
  if (result.drift.length) {
    console.log("\n### DRIFT：构建脚本与计划不一致 ###")
    for (const d of result.drift) console.log(`  ${d}`)
  }
  if (result.stageOnlyBuilds.length) {
    console.log("\n### 其它构建脚本（产物写发行 stage，不在 dev 树） ###")
    for (const s of result.stageOnlyBuilds) console.log(`  ${s}`)
  }
  if (baseline) {
    const changed = baseline.filter(r => r.verdict === "changed")
    console.log(`\n### 与基线树逐字节比对 ###`)
    console.log(`changed=${changed.length} same=${baseline.filter(r => r.verdict === "same").length} missing-in-baseline=${baseline.filter(r => r.verdict === "missing-in-baseline").length}`)
    for (const r of changed) console.log(`  CHANGED  ${r.rel}  ${r.baselineBytes} → ${r.hereBytes} B`)
    for (const r of baseline.filter(x => x.verdict === "missing-in-baseline")) console.log(`  NEW      ${r.rel}  ${r.hereBytes} B`)
  }
  console.log("\n### SUMMARY ###")
  console.log(`scope=${result.scope} artifacts=${result.artifacts.length} stale=${stale.length} missing=${result.missingTargets.length} unexplained=${result.unexplained.length} drift=${result.drift.length}` + (result.exact ? ` exact_same=${result.exact.same} exact_differs=${result.exact.differs} exact_na=${result.exact.unavailable}` : ""))
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const root = resolve(import.meta.dirname, "..")
  const scopeArg = argv.find(a => a.startsWith("--scope="))
  const scope: Scope = scopeArg?.split("=")[1] === "legacy" ? "legacy" : "resolved"
  const check = argv.includes("--check")
  const json = argv.includes("--json")
  const exact = argv.includes("--exact")
  const baselineRoot = argv.find(a => a.startsWith("--baseline="))?.split("=").slice(1).join("=")
  const result = await scan(root, scope, undefined, exact)
  const baseline = baselineRoot ? compareBaseline(root, resolve(baselineRoot)) : undefined
  if (json) console.log(JSON.stringify({ ...result, baseline }, null, 2))
  else printHuman(result, root, baseline)
  const bad = result.artifacts.filter(a => a.verdict !== "ok").length + result.unexplained.length + result.drift.length
    + (exact ? (result.exact?.differs ?? 0) : 0)
  process.exit(check && bad > 0 ? 1 : 0)
}
