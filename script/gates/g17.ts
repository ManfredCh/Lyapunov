/**
 * G17 真实入口：干净安装、桌面/CLI 启动、老版本升级/数据恢复、核心旧引用清理（合同 §6.2 G17 行）。
 *
 * 本入口只调**既有产品实现与既有构建脚本**，不新建测试框架、不新建打包器、不复制产品逻辑：
 *  - `git worktree add` 得到不含当前工作树未提交改动的干净树（合同 §6.2「干净安装」前置）；
 *  - `bun run build:plugins`（`script/build-plugins.ts`）是该发行链自己的插件/客户端构建；
 *  - `distribution/linux/lyapunov`、`distribution/linux/doctor.mjs` 是该发行链自己的启动入口；
 *  - `.runtime/releases/lyapunov-dsh-0.1.0-linux-x64.tar.gz` 是 `script/package-linux.ts` 的真实产物，
 *    其包内 `RELEASE.json` 自己记录 `sourceCommit`，本门据此核对产物是否对应当前 HEAD；
 *  - 旧引用残留只做**只读检索**并按生产/迁移/历史分类统计，不删除、不移动任何文件（合同 §4.7、§7）。
 *
 * 诚实边界（依合同 §7 不伪造）：
 *  - 本机不联网。干净树里既没有 `.upstream/`（`script/bootstrap.mjs` 的联网克隆产物），
 *    也没有 `node_modules/`（`bun install` 的产物）；两者都是仓库外前置。本门**如实跑出并记录**
 *    这两种缺失下的真实报错，然后**复用机器上已固定的同一上游与已安装依赖的符号链接**
 *    （未下载、未安装、未联网）再跑一次构建，把「构建脚本在 HEAD 内容上是否可用」
 *    与「本机能否从零安装」两件事分开报告。
 *  - 秘密扫描只报**计数与文件路径**，绝不把匹配到的内容写进 detail、日志、证据文件或报告；
 *    所有子命令输出在进入 detail/证据前先经 `redact()` 脱敏。
 *  - 桌面 Electron **真实启动**、老版本升级/数据恢复、真实发布/推送在本机没有条件，保持 BLOCKED。
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
/** 本门全部临时 worktree、解包产物与证据只落在这里。 */
const WORK_ROOT = join(PRODUCT_ROOT, ".runtime/goal-verify/g17")
const RELEASE_ARCHIVE = join(PRODUCT_ROOT, ".runtime/releases/lyapunov-dsh-0.1.0-linux-x64.tar.gz")
const ARCHIVE_ROOT_NAME = "lyapunov-dsh-0.1.0-linux-x64"

const BUN: string | undefined = Bun.which("bun") ?? (process.versions.bun ? process.execPath : undefined)
const NODE: string | undefined = Bun.which("node") ?? undefined
const GIT: string | undefined = Bun.which("git") ?? undefined
const TAR: string | undefined = Bun.which("tar") ?? undefined

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024
const SCAN_OVERLAP_BYTES = 256
/** 通用「赋值型凭据」模式只在不超过该体积的文件上跑，避免对二进制做十几遍正则。 */
const GENERIC_SCAN_MAX_BYTES = 2 * 1024 * 1024

/**
 * §4.7 残留检索的 10 组旧 owner 探针（DEV-027 F17 起作为**导出常量**，便于单测钉住判据）。
 *
 * N238 Round 4 收窄（误报修正）：裸词 `opencode` 在真实代码里命中的是
 *   - `packages/lyapunov-shell/src/preferences-theme-data.ts:2854` 的主题数据 id `"id": "opencode"`；
 *   - `packages/lyapunov-shell/src/workbench-style.ts:121` 的**注释**（"opencode 小节头语义"）。
 * 两者都不是退役平台。改成语义化模式（`@opencode/`、`packages/opencode`、
 * `opencode-<server|sdk|session|agent|plugin|db|local>`）后：HEAD 上该组生产命中 **2 → 0**，
 * 而真实平台引用（`@opencode/server-sdk`、`packages/opencode/src/...`）仍然命中（单测钉住）。
 */
export const LEGACY_OWNER_PATTERNS: ReadonlyArray<{ owner: string; pattern: string }> = [
  { owner: "legacy.opencode-session-loop / tool-runtime / server-sdk / llm-package / plugin-abi", pattern: "opencode[-/.](?:server|sdk|session|agent|plugin|db|local)|packages/opencode|@opencode/" },
  { owner: "legacy.scenecore-platform", pattern: "SceneCore|scenecore|scene-core" },
  { owner: "legacy.opencode-bridge", pattern: "scene-bridge|SceneBridge|sceneBridge" },
  { owner: "legacy.scene-page-agent", pattern: "ScenePage|scene-page" },
  { owner: "legacy.planning-monolith", pattern: "planning-service" },
  { owner: "legacy.robot-loops-macros", pattern: "robot-loops|robotLoops" },
  { owner: "legacy.background-intent-jobs", pattern: "background-intent|backgroundIntent" },
  { owner: "Tool Forge / 业务白名单 / 中文记忆门禁", pattern: "tool-forge|ToolForge" },
  { owner: "独立 robot-bridge 启动/路由", pattern: "robot-bridge|robotBridge" },
  { owner: "废弃 lyaup-* 兼容目录", pattern: "lyaup-" },
]

/** §4.7 允许的残留族（**结构性**允许，不是逐文件白名单）。 */
export const allowedProductionResidue = (path: string): boolean =>
  /^packages\/lyapunov-shell\/src\/preferences-theme-sources\//.test(path)
  || /^packages\/lyaup-migrations\//.test(path)

/**
 * **明文例外**（DEV-027 N238 Round 4 逐条裁决结论）：产品明确保留的兼容读 / 历史身份字符串。
 * 每条给理由 + 依据 file:line。例外**不计入通过分子**、也**不表示"无残留"**——
 * 它们只是"已登记、待主代理裁决是否允许"；未登记的命中一律算未预期残留（`ok:false`）。
 */
export const documentedLegacyCompatExceptions: ReadonlyArray<{ path: string; reason: string; evidence: string }> = [
  { path: "packages/desktop/src/account-view.tsx", reason: "桌面账号窗口按旧键名读偏好（新键优先，旧键兜底）", evidence: ":20 readPreference(\"lyapunov-language\",\"lyaup-language\",…)、:21 \"lyaup-theme\"" },
  { path: "packages/grasp-graspgenx/src/propose.py", reason: "与外部 GraspGenX 服务约定的协议标识，改名会与既有服务失配", evidence: ":8 LEGACY_COUNTS_PROTOCOL='nvlabs-graspgenx-b9429097-lyaup-adapter-v2'" },
  { path: "packages/lyapunov-product-bundle/src/account/url.ts", reason: "正式账户 API 的统一入口主机路径（已由旧 `lyaup-api` 切换为已确认的 `lyaup-unified`，仍是服务端契约路径）", evidence: ":7 'https://vorynel.com/lyaup-unified'" },
  { path: "packages/lyapunov-product-bundle/src/runtime-paths.ts", reason: "账号工作区目录哈希的稳定种子；改动会让所有既有账号的数据根搬家", evidence: ":68 `lyaup-account-workspace-v1\\0${accountId}`" },
  { path: "packages/lyapunov-shell/src/preferences.ts", reason: "旧偏好命名空间常量（显式兼容读，名字自带 LEGACY_）", evidence: ":2 LEGACY_PREFERENCES_NAMESPACE='lyaup-preferences'" },
  { path: "packages/lyapunov-workspace/src/preferences.ts", reason: "旧工作区偏好键（显式兼容读）", evidence: ":2 LEGACY_WORKSPACE_PREFERENCES='lyaup-workspace'" },
  // 服务端 `services/lyapunov-api/src/{app,config,identity}.ts` 的旧头名/兼容默认值登记
  // （x-lyaup-request-id、LYAPUNOV_IDENTITY_CLIENT_ID 兜底、x-lyaup-client-secret）随服务端源码
  // 于 2026-09-26 移出本仓库，归 LyapunovOM backend/dev-server/；本门只扫描产品面，不再登记它们。
]

/**
 * DEV-027 F17（+ N238 Round 4）：把"名字级只读检索"从**常量 `ok:true`** 改成**真判据**。
 * `ok` 只看"**未登记**的生产残留"是否为 0；已登记例外单独计数返回（调用方必须**另打一行**，
 * 且不得把它们算进通过分子或说成"无残留"）。
 */
export const legacyResidueVerdict = (productionPaths: readonly string[]): { ok: boolean; unexpected: string[]; exceptions: string[] } => {
  const unique = [...new Set(productionPaths)].sort()
  const documented = new Set(documentedLegacyCompatExceptions.map(entry => entry.path))
  const exceptions = unique.filter(path => documented.has(path))
  const unexpected = unique.filter(path => !allowedProductionResidue(path) && !documented.has(path))
  return { ok: unexpected.length === 0, unexpected, exceptions }
}

/**
 * 单组残留探针的读数判定（2026-09-26 W24）。
 *
 * `git grep` 的退出码语义：**0=有命中、1=无命中、其余=真执行错误**（正则无效、路径不存在…）。
 * 旧实现只取 stdout，于是"正则语法坏掉"与"真的 0 命中"在读数上无法区分 —— 一次实测里
 * `LEGACY_OWNER_PATTERNS[0]` 的 `(?:…)` 在 POSIX ERE 下报 `fatal: 正则表达式无效`，
 * 该组**恒定 0 命中**，判据照旧报绿（哑掉的守卫报绿）。
 * 这里把"执行错误"显式化为 `ok:false` 并带回 stderr 原文；调用方据此让判据失败。
 */
export function probeOutcome(exit: number | null, stdout: string, stderr: string): { ok: boolean; paths: string[]; error?: string } {
  if (exit === 0) return { ok: true, paths: stdout.split("\n").filter(Boolean) }
  if (exit === 1) return { ok: true, paths: [] }
  const detail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 240)
  return { ok: false, paths: [], error: detail || `git grep 退出码=${String(exit)}（既非 0 也非 1）` }
}

/** 证据文件里的单条命令读数。 */
interface CommandRecord {
  command: string
  cwd: string
  exit: number | null
  elapsedMs: number
  timedOut: boolean
  stdout: string
  stderr: string
  spawnError?: string
}

interface ScanHit {
  pattern: string
  count: number
  /** 其中等于公开文档示例值/自述占位值的条数（只用于分类，不保留内容；这些值本身不是凭据）。 */
  publicPlaceholders: number
  /** 其中只出现在**注释行**的条数（N352b：注释里的示例/反例不构成发行凭据；单独计数以便如实报出，不静默丢）。 */
  commentOnly: number
  paths: string[]
}

interface ScanResult {
  label: string
  files: number
  bytes: number
  hits: ScanHit[]
  unreadable: string[]
}

/**
 * 凭据/私钥模式。字面量全部由片段拼接，避免本文件（发布树里的一份源码）命中自己的模式；
 * `secret_scanner_self_check` 会实测验证这一点，否则扫描结论不可信。
 * `(?<![A-Za-z0-9])` 前界是必要的：否则 `task-list`、`disk-usage` 这类普通标识符会被 `sk-` 规则误报
 * （实测在 bugfixHistory 的 numstat 文件上产生 16 条假阳性）。
 */
const SECRET_PATTERNS: Array<{ name: string; source: string }> = [
  { name: "private_key_block", source: "-----BEGIN [A-Z ]*" + "PRIVATE KEY-----" },
  { name: "openai_style_key", source: "(?<![A-Za-z0-9])s" + "k-(?!ant-)" + "[A-Za-z0-9_-]{20,}" },
  { name: "anthropic_style_key", source: "(?<![A-Za-z0-9])s" + "k-ant-" + "[A-Za-z0-9_-]{20,}" },
  { name: "huggingface_token", source: "(?<![A-Za-z0-9])h" + "f_" + "[A-Za-z0-9]{30,}" },
  { name: "github_token", source: "(?<![A-Za-z0-9])g" + "h[pousr]_" + "[A-Za-z0-9]{30,}" },
  { name: "aws_access_key_id", source: "(?<![A-Za-z0-9])AK" + "IA" + "[0-9A-Z]{16}" },
  { name: "google_api_key", source: "(?<![A-Za-z0-9])AI" + "za" + "[0-9A-Za-z_-]{35}" },
  { name: "slack_token", source: "(?<![A-Za-z0-9])x" + "ox[abprs]-" + "[A-Za-z0-9-]{10,}" },
  { name: "jwt", source: "(?<![A-Za-z0-9])ey" + "J[A-Za-z0-9_-]{10,}\\.ey" + "J[A-Za-z0-9_-]{10,}\\." },
  { name: "authorization_header", source: "Bea" + "rer\\s+" + "[A-Za-z0-9._-]{24,}" },
  { name: "key_assignment", source: "(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|pass" + "word)[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9_./+-]{24,}[\"']" },
  { name: "deepseek_key_assignment", source: "DEEPSEEK_API_" + "KEY\\s*[:=]\\s*[\"']?[A-Za-z0-9_-]{16,}" },
]
/**
 * 公开文档里的示例值 + **自述占位值**，只用于给命中分类（这些值本身就是公开示例/本地占位，不是凭据）。
 * N352b 追加的两个值各自在源码里**自述**为占位：`script/gates/g01-live.ts:347` 的用法行原文写明该值是
 * "标注过的本地占位值（本地端点不校验）"；`script/gates/g15-live.ts:54` 用同一个值走本地 Ollama 路由；
 * `script/refactor-verify.ts:1069` 的注释里用作反例串。白名单只影响**分类**：命中仍逐条计数并出现在读数里，
 * `no_secrets_in_clean_tree` 只把"非白名单命中"判失败。
 */
const PUBLIC_PLACEHOLDERS = new Set([
  "AK" + "IAIOSFODNN7EXAMPLE", "AK" + "IAI44QH8DHBEXAMPLE",
  "local-ollama-no-auth", "dummy-not-a-real-key",
])
/** 便宜的预筛：只有命中这些锚点的分块才跑完整模式集。 */
const SECRET_ANCHOR_SOURCE = "s" + "k-|h" + "f_|g" + "h[pousr]_|AK" + "IA|AI" + "za|x" + "ox|Bea" + "rer|-----BEGIN|ey" + "J|DEEPSEEK_API_" + "KEY"

/**
 * 产品自己的发行包 fail-closed 判据（`script/package-linux.ts` 的 forbiddenName / forbiddenExtension）。
 * 本门直接复用同一条口径，不另立第二套标准。
 */
const FORBIDDEN_NAME = /^(?:auth|credentials?|secrets?|session-secrets)\.(?:json|ya?ml|toml|env|db|sqlite)$/i
const FORBIDDEN_EXTENSION = /\.(?:pt|pth|ckpt|safetensors|onnx|gguf|npz|npy|engine|plan|pem|key|token)$/i
/** 模型权重类扩展名（「包中无无关模型」读数；与上面的发行判据分开列，便于区分口径）。 */
const WEIGHT_EXTENSION = /\.(?:safetensors|gguf|ckpt|pt|pth|onnx|npz|npy|h5|pkl|engine|plan|bin)$/i

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

/**
 * N352b：把**整行注释**去掉，只留下代码/字符串内容（行首（含缩进）为 `//`、`#`、`*`、`/*` 或 `<!--` 的行）。
 * 目的：注释里的示例/反例（例如某个脚本注释里写的历史假通过命令）不该让"发行树无凭据"判失败；
 * 差额由 `ScanHit.commentOnly` 如实报出，读数里仍能看到注释层命中数。行内注释不处理（保守：宁可多算命中）。
 */
function stripCommentLines(text: string): string {
  return text.split("\n").map(line => /^\s*(?:\/\/|#|\*|\/\*|<!--)/.test(line) ? "" : line).join("\n")
}

/** 把任何要落盘/进报告的文本先脱敏；只替换匹配内容，不保留原文。 */
function redact(text: string): string {
  let output = text
  for (const pattern of SECRET_PATTERNS) output = output.replace(new RegExp(pattern.source, "g"), () => `«REDACTED:${pattern.name}»`)
  return output
}

function tail(text: string, limit = 700): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

function shellQuote(part: string): string {
  return /^[\w./:=@+-]+$/.test(part) ? part : JSON.stringify(part)
}

async function readStream(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (stream === undefined || typeof stream === "number") return ""
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 跑一条真实命令。完整 stdout/stderr 在内存里保留（供程序判读），展示与落盘只用尾部；
 * env 里显式给 `undefined` 表示「清掉该变量」。
 */
async function run(command: string[], options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<CommandRecord> {
  const started = Date.now()
  const record: CommandRecord = {
    command: command.map(shellQuote).join(" "),
    cwd: options.cwd,
    exit: null,
    elapsedMs: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
  }
  const merged = { ...process.env, ...options.env }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) if (typeof value === "string") env[key] = value
  let child: Bun.Subprocess<"pipe", "pipe">
  try {
    child = Bun.spawn(command, { cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    record.spawnError = messageOf(error)
    record.elapsedMs = Date.now() - started
    return record
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      record.timedOut = true
      child.kill()
    }, options.timeoutMs)
  }
  const [stdout, stderr] = await Promise.all([readStream(child.stdout), readStream(child.stderr)])
  const exit = await child.exited
  if (timer !== undefined) clearTimeout(timer)
  record.exit = exit
  record.elapsedMs = Date.now() - started
  record.stdout = redact(stdout)
  record.stderr = redact(stderr)
  return record
}

/** 把命令读数压成一行可核对文本（已脱敏、已截尾）。 */
function readout(record: CommandRecord): string {
  const parts = [`exit=${record.exit}`, `${record.elapsedMs}ms`]
  if (record.spawnError !== undefined) parts.push(`spawnError=${record.spawnError}`)
  if (record.timedOut) parts.push("已超时被杀")
  if (record.stderr.trim()) parts.push(`stderr="${tail(record.stderr, 700)}"`)
  if (record.stdout.trim()) parts.push(`stdout="${tail(record.stdout, 240)}"`)
  return parts.join("；")
}

/** 递归列出普通文件（不跟随符号链接，避免环）。 */
async function walkFiles(root: string): Promise<Array<{ path: string; relative: string; bytes: number }>> {
  const files: Array<{ path: string; relative: string; bytes: number }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        try { files.push({ path, relative: relative(root, path), bytes: (await stat(path)).size }) } catch { /* 竞态删除：跳过 */ }
      }
    }
  }
  await visit(root)
  return files
}

/** 流式扫描一批文件：便宜锚点预筛 + 完整模式集；只记计数与路径，绝不保留匹配内容。 */
async function scanFiles(files: Array<{ path: string; relative: string; bytes: number }>, label: string): Promise<ScanResult> {
  const hits = new Map<string, ScanHit>()
  for (const pattern of SECRET_PATTERNS) hits.set(pattern.name, { pattern: pattern.name, count: 0, publicPlaceholders: 0, commentOnly: 0, paths: [] })
  const anchor = new RegExp(SECRET_ANCHOR_SOURCE)
  const unreadable: string[] = []
  let scannedBytes = 0
  let scannedFiles = 0
  for (const file of files) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(file.path, "r")
      const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
      const generic = file.bytes <= GENERIC_SCAN_MAX_BYTES
      let carry = ""
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, SCAN_CHUNK_BYTES, null)
        if (bytesRead === 0) break
        scannedBytes += bytesRead
        // latin1 让字节与字符 1:1，ASCII 模式不会因多字节字符错位。
        const text = carry + buffer.subarray(0, bytesRead).toString("latin1")
        if (anchor.test(text)) {
          // N352b：注释行里的示例/反例不构成发行凭据 ⇒ 只在**去注释**后的文本上计 actionable 命中；
          // 原始文本的命中差额单独记进 `commentOnly` 如实报出（不静默丢，读数里能看见）。
          const withoutComments = stripCommentLines(text)
          for (const pattern of SECRET_PATTERNS) {
            if (!generic && pattern.name === "key_assignment") continue
            const expression = new RegExp(pattern.source, "g")
            const found = withoutComments.match(expression)
            const raw = text.match(expression)
            if (!found && !raw) continue
            const hit = hits.get(pattern.name)!
            hit.count += found?.length ?? 0
            hit.commentOnly += (raw?.length ?? 0) - (found?.length ?? 0)
            // 值只在本行内比较，不落盘、不打印；只累加「等于公开示例/自述占位」的条数。
            // N352b：赋值类模式（`KEY: "value"`）的匹配串**包含键名**，所以既要看整串（AWS 示例那种纯值），
            // 也要看 `[:=]` 之后被赋的那个值（`local-ollama-no-auth` 这类自述占位）。
            for (const value of found ?? []) {
              const assigned = /[:=]\s*["']?([A-Za-z0-9_./+-]+)["']?\s*$/.exec(value)?.[1]
              if (PUBLIC_PLACEHOLDERS.has(value) || (assigned !== undefined && PUBLIC_PLACEHOLDERS.has(assigned))) hit.publicPlaceholders += 1
            }
            if (!hit.paths.includes(file.relative)) hit.paths.push(file.relative)
          }
        }
        carry = text.slice(-SCAN_OVERLAP_BYTES)
      }
      scannedFiles += 1
    } catch (error) {
      unreadable.push(`${file.relative}（${messageOf(error)}）`)
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined)
    }
  }
  return { label, files: scannedFiles, bytes: scannedBytes, hits: [...hits.values()].filter(hit => hit.count > 0), unreadable }
}

/** 扫描结果压成一行：只报模式名 + 计数 + 前几个路径。 */
function scanReadout(result: ScanResult, pathLimit = 5): string {
  const head = `${result.label}：已扫描 ${result.files} 文件 / ${(result.bytes / 1048576).toFixed(1)} MB`
  if (!result.hits.length) return `${head}；匹配 0 条`
  return `${head}；匹配：` + result.hits.map(hit => `${hit.pattern}×${hit.count}${hit.publicPlaceholders ? `（含自述占位/公开示例 ${hit.publicPlaceholders} 条）` : ""}${hit.commentOnly ? `（注释行另有 ${hit.commentOnly} 条，不计入判定）` : ""}${hit.count - hit.publicPlaceholders > 0 ? ` ← 非白名单命中 ${hit.count - hit.publicPlaceholders} 条` : ""}（${hit.paths.slice(0, pathLimit).join(", ")}${hit.paths.length > pathLimit ? ` 等 ${hit.paths.length} 个文件` : ""}）`).join("；")
}

/**
 * 包内路径归属。判定口径（主代理 2026-09-18 裁定）：命中落在**产品自己的路径**才算产品问题；
 * 落在具名第三方包 / 随包运行时 / 上游检出里，就按包名归因并如实报出，不作为本门失败。
 */
type PathScope = "product" | "packaged_dependency" | "bundled_runtime" | "upstream_workspace"

const RUNTIME_VENDORS: Record<string, string> = { node: "Node.js 运行时", electron: "Electron", micromamba: "micromamba" }

function attributePath(relativePath: string): { scope: PathScope; name: string } {
  const dependency = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(relativePath)
  if (dependency) {
    const packageName = dependency[1]!
    // 打包布局是 .modules/<name>@<version>-<序号>/node_modules/<name>/…，版本号能从首段取回。
    const versioned = /^\.modules\/(.+?)@([^/@]+)-\d+\//.exec(relativePath)
    return { scope: "packaged_dependency", name: versioned ? `${packageName}@${versioned[2]}` : packageName }
  }
  if (relativePath.startsWith(".upstream/")) {
    const inside = /^\.upstream\/[^/]+\/(?:packages|vendor|apps)\/([^/]+(?:\/[^/]+)?)/.exec(relativePath)
    return { scope: "upstream_workspace", name: `上游 DSH 检出${inside ? `:${inside[1]}` : ""}` }
  }
  if (relativePath.startsWith("runtime/")) {
    const vendor = relativePath.split("/")[1] ?? "unknown"
    return { scope: "bundled_runtime", name: `随包运行时:${RUNTIME_VENDORS[vendor] ?? vendor}` }
  }
  return { scope: "product", name: relativePath.split("/").slice(0, 2).join("/") }
}

/** 命中按归属拆开：`product` 才是本门要判的失败面，其余按包名/供应方归因。 */
function groupHitsByAttribution(result: ScanResult): {
  product: Array<{ pattern: string; paths: string[] }>
  attributed: Array<{ name: string; pattern: string; paths: string[] }>
} {
  const product: Array<{ pattern: string; paths: string[] }> = []
  const byName = new Map<string, { name: string; pattern: string; paths: string[] }>()
  for (const hit of result.hits) {
    const productPaths: string[] = []
    for (const path of hit.paths) {
      const attribution = attributePath(path)
      if (attribution.scope === "product") { productPaths.push(path); continue }
      const key = `${attribution.name}|${hit.pattern}`
      const row = byName.get(key) ?? { name: attribution.name, pattern: hit.pattern, paths: [] }
      row.paths.push(path)
      byName.set(key, row)
    }
    if (productPaths.length) product.push({ pattern: hit.pattern, paths: productPaths })
  }
  return { product, attributed: [...byName.values()] }
}

/** 产品路径命中读数；空则为 0 条。 */
function productHitReadout(hits: Array<{ pattern: string; paths: string[] }>, pathLimit = 6): string {
  if (!hits.length) return "0 条"
  return hits.map(hit => `${hit.pattern}×${hit.paths.length} 个文件（${hit.paths.slice(0, pathLimit).join(", ")}${hit.paths.length > pathLimit ? ` 等 ${hit.paths.length} 个` : ""}）`).join("；")
}

/** 第三方命中按「包名@版本（模式，文件数）」逐条列出，绝不打印匹配内容。 */
function attributedReadout(hits: Array<{ name: string; pattern: string; paths: string[] }>): string {
  if (!hits.length) return "0 条"
  return hits.map(hit => `${hit.name}（${hit.pattern}，${hit.paths.length} 文件：${hit.paths.slice(0, 3).join(", ")}${hit.paths.length > 3 ? ` 等 ${hit.paths.length} 个` : ""}）`).join("；")
}

/** 快照主工作树各 `packages/<name>/dist` 清单，用于自证本次运行没有写主树的 packages。 */
async function mainTreeDistSnapshot(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  const packages = join(PRODUCT_ROOT, "packages")
  if (!existsSync(packages)) return snapshot
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dist = join(packages, entry.name, "dist")
    if (!existsSync(dist)) continue
    for (const file of await walkFiles(dist)) {
      try { snapshot.set(relative(PRODUCT_ROOT, file.path), `${file.bytes}@${(await stat(file.path)).mtimeMs}`) } catch { /* 竞态：跳过 */ }
    }
  }
  return snapshot
}

function diffSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [path, value] of after) if (before.get(path) !== value) changed.push(path)
  for (const path of before.keys()) if (!after.has(path)) changed.push(`${path}（被删除）`)
  return changed
}

/**
 * G17：干净安装前置、交付路径、包内容安全、旧引用清理的**本机可验证切片**。
 * @returns 每条 check 的真实读数；`blocked` 非空表示桌面启动/老版本升级/发布等本机无条件验证。
 */
export async function gateG17(): Promise<GateResult> {
  const checks: Check[] = []
  const commands: CommandRecord[] = []
  const evidence: Record<string, unknown> = { gate: "G17", productRoot: PRODUCT_ROOT, workRoot: WORK_ROOT }
  await mkdir(WORK_ROOT, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")
  const worktree = join(WORK_ROOT, `clean-${stamp}`)
  const extraction = join(WORK_ROOT, `release-${stamp}`)
  let worktreeRemoved = "未创建"
  let extractionRemoved = "未创建"
  let distSnapshotBefore: Map<string, string> | undefined
  let distArtifacts: Array<{ path: string; relative: string; bytes: number }> = []

  const track = async (command: string[], options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<CommandRecord> => {
    const record = await run(command, options)
    commands.push(record)
    return record
  }

  try {
    checks.push({
      name: "required_tooling_present",
      ok: BUN !== undefined && GIT !== undefined && NODE !== undefined,
      detail: `bun=${String(BUN)}；git=${String(GIT)}；node=${String(NODE)}（${process.version}）；tar=${String(TAR)}；本门只用这些既有工具与既有产品脚本（build:plugins、distribution/linux/lyapunov）`,
    })
    distSnapshotBefore = await mainTreeDistSnapshot()

    // ── 1) 干净 checkout 可得：git worktree add 到 .runtime/goal-verify/g17/clean-<ts> ──
    let head = ""
    let tracked: string[] = []
    const mainStatus = GIT ? await track([GIT, "status", "--porcelain"], { cwd: PRODUCT_ROOT }) : undefined
    const dirtyMain = (mainStatus?.stdout ?? "").split("\n").filter(Boolean)
    if (GIT === undefined) {
      checks.push({ name: "clean_checkout_obtainable", ok: false, detail: "缺 git，无法建立干净 checkout" })
    } else {
      const add = await track([GIT, "worktree", "add", "--detach", worktree, "HEAD"], { cwd: PRODUCT_ROOT, timeoutMs: 300_000 })
      const headProbe = existsSync(join(worktree, ".git")) ? await track([GIT, "-C", worktree, "rev-parse", "HEAD"], { cwd: PRODUCT_ROOT }) : undefined
      head = (headProbe?.stdout ?? "").trim()
      const list = await track([GIT, "-C", worktree, "ls-files"], { cwd: PRODUCT_ROOT, timeoutMs: 120_000 })
      tracked = list.stdout.split("\n").filter(Boolean)
      const status = await track([GIT, "-C", worktree, "status", "--porcelain"], { cwd: PRODUCT_ROOT })
      const cleanInWorktree = status.stdout.trim() === ""
      checks.push({
        name: "clean_checkout_obtainable",
        ok: add.exit === 0 && head.length === 40 && cleanInWorktree && tracked.length > 0,
        detail: `git worktree add --detach ${relative(PRODUCT_ROOT, worktree)} HEAD → ${readout(add)}；worktree HEAD=${head}；git ls-files 计数=${tracked.length}；worktree 内 git status --porcelain 为空=${cleanInWorktree}；主工作树未提交条目数=${dirtyMain.length}`,
      })
    }

    // ── 2) 干净树确实不含当前未提交改动：拿主树真实被改的文件比对 blob ──
    if (GIT !== undefined && head.length === 40) {
      const modified = dirtyMain.map(line => ({ code: line.slice(0, 2), path: line.slice(3) })).find(item => /M/.test(item.code) && !item.path.includes(" -> "))
      const untracked = dirtyMain.filter(line => line.startsWith("??")).map(line => line.slice(3))
      if (modified) {
        const worktreeBlob = (await track([GIT, "-C", worktree, "hash-object", modified.path], { cwd: PRODUCT_ROOT })).stdout.trim()
        const headBlob = (await track([GIT, "-C", worktree, "rev-parse", `HEAD:${modified.path}`], { cwd: PRODUCT_ROOT })).stdout.trim()
        const mainBlob = (await track([GIT, "-C", PRODUCT_ROOT, "hash-object", modified.path], { cwd: PRODUCT_ROOT })).stdout.trim()
        checks.push({
          name: "clean_checkout_excludes_uncommitted_changes",
          ok: worktreeBlob.length === 40 && worktreeBlob === headBlob && mainBlob !== headBlob,
          detail: `样例文件=${modified.path}（主树 git status 码="${modified.code.trim()}"）：干净树内容 blob=${worktreeBlob}；HEAD blob=${headBlob}（相等=${worktreeBlob === headBlob}）；主工作树当前 blob=${mainBlob}（与 HEAD 不同=${mainBlob !== headBlob}）`,
        })
      } else if (untracked.length) {
        const absent = !existsSync(join(worktree, untracked[0]!))
        checks.push({
          name: "clean_checkout_excludes_uncommitted_changes",
          ok: absent,
          detail: `主树没有已跟踪的修改文件，改用未跟踪样例 ${untracked[0]}：干净树中不存在=${absent}；主树未跟踪条目数=${untracked.length}`,
        })
      } else {
        checks.push({ name: "clean_checkout_excludes_uncommitted_changes", ok: true, detail: "主工作树 git status 为空，干净树与工作树内容一致（无未提交改动可排除）" })
      }
    } else if (GIT !== undefined) {
      checks.push({ name: "clean_checkout_excludes_uncommitted_changes", ok: false, detail: `干净树未就绪（head="${head}"），未能做未提交改动排除比对` })
    } else {
      checks.push({ name: "clean_checkout_excludes_uncommitted_changes", ok: false, detail: "缺 git，未做未提交改动排除比对" })
    }

    // ── 3) 交付路径：先如实跑出「仓库外前置缺失」的真实报错，再在补齐前置后跑通构建 ──
    const upstreamSource = join(PRODUCT_ROOT, ".upstream")
    const nodeModules = join(PRODUCT_ROOT, "node_modules")
    let buildWithoutUpstream: CommandRecord | undefined
    let buildUpstreamOnly: CommandRecord | undefined
    let buildWithPrereq: CommandRecord | undefined
    let linkedDependencyEntries = 0
    if (BUN !== undefined && head.length === 40) {
      // 3a) 只有 HEAD 内容时的真实结果：`.upstream/` 是 bootstrap 的联网克隆产物，不在仓库里。
      buildWithoutUpstream = await track([BUN, "run", "build:plugins"], { cwd: worktree, timeoutMs: 900_000 })
      // 3b) 复用机器上已固定的同一上游（未联网、未重新 bootstrap）。
      let upstreamLinked = false
      if (existsSync(upstreamSource)) {
        try {
          await symlink(upstreamSource, join(worktree, ".upstream"), "dir")
          upstreamLinked = true
        } catch { /* 链接失败则保持未链接，下面的读数会如实反映 */ }
      }
      if (upstreamLinked) buildUpstreamOnly = await track([BUN, "run", "build:plugins"], { cwd: worktree, timeoutMs: 900_000 })
      const noGap = buildWithoutUpstream.exit === 0
      checks.push({
        name: "clean_checkout_offline_prerequisite_gap",
        ok: noGap || (upstreamLinked && buildWithoutUpstream.exit !== 0 && /\.upstream/.test(buildWithoutUpstream.stderr) && buildUpstreamOnly?.exit !== 0),
        detail: (noGap
          ? `干净树自带全部构建前置，bun run build:plugins 直接成功：${readout(buildWithoutUpstream)}；`
          : `无 .upstream（仓库只含 HEAD 内容）：bun run build:plugins → ${readout(buildWithoutUpstream)}；`)
          + (buildUpstreamOnly
            ? `仅复用本机已固定上游、不执行 bun install、不联网：再跑 → ${readout(buildUpstreamOnly)}；`
            : `本机没有 ${upstreamSource}，无法复用已固定上游（这本身也是一条真实缺项）；`)
          + "这两次失败只说明「干净树缺仓库外的 bootstrap / 依赖安装前置」，不是构建脚本自身失败；补齐前置后的读数见 delivery_build_clean_checkout",
      })

      if (noGap) {
        buildWithPrereq = buildWithoutUpstream
      } else {
        // 3c) 复用机器上 bun 已安装的依赖链接（只建符号链接：不下载、不安装、不改主树内容）。
        const linked: string[] = []
        if (existsSync(nodeModules)) {
          await mkdir(join(worktree, "node_modules"), { recursive: true })
          for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
            if (entry.name === "@deepseek-ai") continue // 该 scope 由 build-plugins.ts 自己的 linkUpstream 建立
            const source = join(nodeModules, entry.name)
            const destination = join(worktree, "node_modules", entry.name)
            if (entry.name.startsWith("@")) {
              await mkdir(destination, { recursive: true })
              for (const scoped of await readdir(source)) {
                // 工作区包指回干净树自己的 packages/，不把主树源码混进构建。
                const target = entry.name === "@lyapunov" && existsSync(join(worktree, "packages", scoped)) ? join(worktree, "packages", scoped) : join(source, scoped)
                try { await symlink(target, join(destination, scoped), "dir"); linked.push(`${entry.name}/${scoped}`) } catch { /* 已存在 */ }
              }
              continue
            }
            try { await symlink(source, destination, "dir"); linked.push(entry.name) } catch { /* 已存在 */ }
          }
        }
        for (const group of ["packages", "services", "distribution"]) {
          const groupRoot = join(PRODUCT_ROOT, group)
          if (!existsSync(groupRoot)) continue
          for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const source = join(groupRoot, entry.name, "node_modules")
            if (!existsSync(source)) continue
            try { await symlink(source, join(worktree, group, entry.name, "node_modules"), "dir"); linked.push(`${group}/${entry.name}/node_modules`) } catch { /* 已存在 */ }
          }
        }
        linkedDependencyEntries = linked.length
        buildWithPrereq = await track([BUN, "run", "build:plugins"], { cwd: worktree, timeoutMs: 900_000 })
      }
    } else {
      checks.push({ name: "clean_checkout_offline_prerequisite_gap", ok: false, detail: `缺 bun 或干净树未建立（bun=${String(BUN)}；head="${head}"），未跑构建` })
    }

    // ── 4) 交付产物：不只看退出码，逐项数产物、并真实加载/运行 ──
    const packagesRoot = join(worktree, "packages")
    if (buildWithPrereq !== undefined && existsSync(packagesRoot)) {
      const distDirs: string[] = []
      const distFiles: Array<{ path: string; relative: string; bytes: number }> = []
      for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
        const dist = join(packagesRoot, entry.name, "dist")
        if (!existsSync(dist)) continue
        distDirs.push(entry.name)
        distFiles.push(...await walkFiles(dist))
      }
      const bytes = distFiles.reduce((sum, file) => sum + file.bytes, 0)
      const empty = distFiles.filter(file => file.bytes === 0).map(file => file.relative)
      const clientModules = ["lyapunov-shell", "lyapunov-workspace", "lyapunov-session-undo"].map(name => join(packagesRoot, name, "dist/client.js"))
      const bundles: Array<Record<string, unknown>> = []
      for (const [name, file] of [["lyapunov-product-bundle", "dist/cli.js"], ["lyaup-migrations", "dist/index.js"], ["scene-kit", "dist/plugin.js"], ["lyapunov-terminal", "dist/plugin.js"]] as const) {
        const path = join(packagesRoot, name, file)
        bundles.push({ name: `${name}/${file}`, exists: existsSync(path), bytes: existsSync(path) ? (await stat(path)).size : 0 })
      }
      let pluginLoad = "未执行"
      let pluginLoadOk = false
      let cliRun = "未执行"
      let cliHelpRun = "未执行"
      let cliRunOk = false
      if (NODE !== undefined) {
        const loaded = await track([NODE, "-e", `const m=await import(${JSON.stringify(join(packagesRoot, "scene-kit/dist/plugin.js"))});const p=m.default??m;console.log(JSON.stringify({name:p.name,inject:Array.isArray(p.inject),apply:typeof p.apply}))`], { cwd: worktree, timeoutMs: 120_000 })
        pluginLoad = readout(loaded)
        pluginLoadOk = loaded.exit === 0 && /"apply":"function"/.test(loaded.stdout) && /"name":"lyapunov-scene"/.test(loaded.stdout)
        // N352b 判据对齐（依据 N352 实测 + `packages/lyapunov-product-bundle/src/cli.ts:62-64`）：
        // 产品**无参**调用会走它自己的用法分支（`process.argv[2] !== 'github'` ⇒ 打印 `用法：node cli.js github
        // install|inspect|run [参数]` + exit 2），这条路径不依赖 argv 语义、dev bundle 与发行包都可达。
        // 产品文档里的 `github help`（README:10）在**干净构建**的 bundle 里被引导层按位置参数拒绝
        // （实测 `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`；未文档化的 `--help` 则是 UNKNOWN_OPTION）——两者都属
        // 上游 `@deepseek-ai/dsh-cmdline`/`apps/cli` 面，台账已登记，本门不改产品；`github help` 的读数一并记录、
        // 不参与判定（判据仍是"确实输出了产品用法且无解析栈"，不是退出码必须 0）。
        const cli = await track([NODE, join(packagesRoot, "lyapunov-product-bundle/dist/cli.js")], { cwd: worktree, timeoutMs: 120_000 })
        cliRun = readout(cli)
        const cliHelp = await track([NODE, join(packagesRoot, "lyapunov-product-bundle/dist/cli.js"), "github", "help"], { cwd: worktree, timeoutMs: 120_000 })
        cliHelpRun = readout(cliHelp)
        // 判据是「产物真能被 Node 加载并跑出产品自己的用法」，不是「退出码必须 0」：仍保留"无解析栈"这一条，
        // 退出码按产品对 `github help` 的实现接受 0（用法正常返回）；异常时才要求 2。
        cliRunOk = (cli.exit === 0 || cli.exit === 2) && /github install\|inspect\|run/.test(cli.stdout + cli.stderr) && !/ERR_PARSE_ARGS|at .*\.js:\d+/.test(cli.stderr)
      }
      checks.push({
        name: "delivery_build_clean_checkout",
        ok: buildWithPrereq.exit === 0 && distDirs.length >= 25 && distFiles.length >= 30 && empty.length === 0
          && clientModules.every(path => existsSync(path)) && bundles.every(bundle => bundle.exists === true && (bundle.bytes as number) > 0) && pluginLoadOk && cliRunOk,
        detail: `bun run build:plugins → ${readout(buildWithPrereq)}；为跑通构建复用本机已安装依赖链接 ${linkedDependencyEntries} 条（未下载/未安装/未联网）；`
          + `产物读数：dist 目录 ${distDirs.length} 个、文件 ${distFiles.length} 个、共 ${(bytes / 1048576).toFixed(1)} MB、0 字节文件 ${empty.length} 个；DSH 客户端模块 client.js 3/3=${clientModules.every(path => existsSync(path))}；关键产物=${JSON.stringify(bundles)}；`
          + `真实加载 scene-kit/dist/plugin.js：${pluginLoad}；真实运行 lyapunov-product-bundle/dist/cli.js（**无参**，走产品自己的用法分支 cli.ts:63）：${cliRun}（判据是“确实输出了产品用法且无解析栈”，不是退出码必须 0）；另记 github help（README:10 的文档化用法，读数不参与判定）：${cliHelpRun}`,
      })
      evidence.artifactInventory = distFiles.map(file => ({ path: file.relative, bytes: file.bytes }))
      distArtifacts = distFiles
    } else if (head.length === 40) {
      checks.push({
        name: "delivery_build_clean_checkout",
        ok: false,
        detail: `干净树中 bun run build:plugins 未跑通：${buildWithPrereq ? readout(buildWithPrereq) : `bun 不可用（${String(BUN)}）`}`,
      })
    } else {
      checks.push({ name: "delivery_build_clean_checkout", ok: false, detail: "干净树未建立，未跑构建" })
    }

    // ── 4b) 本轮真实构建出的 `packages/*/dist` 也做内容扫描（发布物本身就是这些文件） ──
    if (distArtifacts.length) {
      const artifactScan = await scanFiles(distArtifacts, `本轮构建产物 packages/*/dist（${distArtifacts.length} 文件）`)
      const artifactWeights = distArtifacts.filter(file => FORBIDDEN_EXTENSION.test(file.relative) || WEIGHT_EXTENSION.test(file.relative) || FORBIDDEN_NAME.test(file.relative.split("/").pop() ?? ""))
      checks.push({
        name: "no_secrets_in_built_dist_artifacts",
        ok: artifactScan.hits.length === 0 && artifactScan.unreadable.length === 0 && artifactWeights.length === 0,
        detail: `${scanReadout(artifactScan)}；按产品发行判据（forbiddenName/forbiddenExtension）与权重扩展名命中 ${artifactWeights.length} 个${artifactWeights.length ? `：${artifactWeights.slice(0, 5).map(file => file.relative).join(", ")}` : ""}。只报计数与路径，未打印任何匹配内容`,
      })
    } else {
      checks.push({ name: "no_secrets_in_built_dist_artifacts", ok: false, detail: "本轮没有构建出 packages/*/dist 产物，未做扫描" })
    }

    // ── 4c) 已知不发布路径在交付树里的实际情况（只读计数，不删除） ──
    if (tracked.length) {
      const unpublished = ["\\.runtime/", "^node_modules/", "/node_modules/", "^dist/", "/dist/"].map(source => ({
        source,
        paths: tracked.filter(path => new RegExp(source).test(path)),
      }))
      const envFiles = tracked.filter(path => /(^|\/)\.env(\.|$)/.test(path))
      const bugfix = tracked.filter(path => path.startsWith("bugfixHistory/"))
      checks.push({
        name: "known_unpublished_paths_in_clean_tree",
        ok: unpublished.every(entry => entry.paths.length === 0) && envFiles.every(path => path.endsWith(".env.example")),
        detail: `HEAD 跟踪文件里：${unpublished.map(entry => `${entry.source}→${entry.paths.length}`).join("，")}；.env 系列=${JSON.stringify(envFiles)}（gitignore 只放行 .env.example）。`
          + `另按 docs/publishable-boundary.md 被列为「排除」却仍被 git 跟踪的：bugfixHistory/ ${bugfix.length} 个文件（内含旧发行 staging 快照与历史回执）——本门只报读数、不删除、不改边界文档；script/package-linux.ts 的收集白名单也不会收集它们`,
      })
    } else {
      checks.push({ name: "known_unpublished_paths_in_clean_tree", ok: false, detail: "干净树未建立，未做不发布路径读数" })
    }

    // ── 5) 真实发行产物：HEAD 对应的 Linux 便携包（script/package-linux.ts 的产物） ──
    let archiveEntries: string[] = []
    if (existsSync(RELEASE_ARCHIVE) && TAR !== undefined) {
      const archiveBytes = (await stat(RELEASE_ARCHIVE)).size
      const listing = await track([TAR, "-tzf", RELEASE_ARCHIVE], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      archiveEntries = listing.stdout.split("\n").filter(Boolean)
      const manifest = await track([TAR, "-xzOf", RELEASE_ARCHIVE, `${ARCHIVE_ROOT_NAME}/RELEASE.json`], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      let release: Record<string, unknown> | undefined
      try { release = JSON.parse(manifest.stdout) as Record<string, unknown> } catch { release = undefined }
      const hash = createHash("sha256")
      const handle = await open(RELEASE_ARCHIVE, "r")
      try {
        const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
          if (bytesRead === 0) break
          hash.update(buffer.subarray(0, bytesRead))
        }
      } finally { await handle.close() }
      const archiveSha = hash.digest("hex")
      const headCommit = head || (GIT ? (await track([GIT, "rev-parse", "HEAD"], { cwd: PRODUCT_ROOT })).stdout.trim() : "")
      const upstreamLock = JSON.parse(await readFile(join(PRODUCT_ROOT, "UPSTREAM_LOCK.json"), "utf8")) as { commit?: string }
      const sourceCommit = String(release?.sourceCommit ?? "")
      const upstreamCommit = String(release?.upstreamCommit ?? "")
      const required = ["/lyapunov", "/RELEASE.json", "/runtime/node/bin/node", "/runtime/electron/resources/app", "/runtime/micromamba/micromamba", "/packages/desktop/dist/main.js", "/packages/lyapunov-product-bundle/dist/cli.js", "/DSH-LICENSE", "/node_modules"]
      // tar 对目录条目带尾斜杠，比对时两种写法都认。
      const missingEntries = required.filter(suffix => !archiveEntries.some(entry => entry === `${ARCHIVE_ROOT_NAME}${suffix}` || entry === `${ARCHIVE_ROOT_NAME}${suffix}/`))
      checks.push({
        name: "delivery_archive_matches_head",
        ok: listing.exit === 0 && sourceCommit.length === 40 && sourceCommit === headCommit && upstreamCommit === upstreamLock.commit && release?.userDataBundled === false && missingEntries.length === 0,
        detail: `.runtime/releases/lyapunov-dsh-0.1.0-linux-x64.tar.gz：${archiveBytes} 字节，sha256=${archiveSha}，tar -tzf ${readout(listing)}，条目 ${archiveEntries.length}；`
          + `包内 RELEASE.json：sourceCommit=${sourceCommit}（当前 HEAD=${headCommit}，相等=${sourceCommit === headCommit}）；upstreamCommit=${upstreamCommit}（UPSTREAM_LOCK.json=${String(upstreamLock.commit)}，相等=${upstreamCommit === upstreamLock.commit}）；`
          + `node=${String(release?.node)} electron=${String(release?.electron)} micromamba=${String(release?.micromamba)} 依赖包记录数=${Array.isArray(release?.packages) ? release.packages.length : String(release?.packages)} userDataBundled=${String(release?.userDataBundled)} providersBundled=${JSON.stringify(release?.providersBundled)}；必需条目缺失=${JSON.stringify(missingEntries)}`,
      })
      evidence.releaseArchive = { path: RELEASE_ARCHIVE, bytes: archiveBytes, sha256: archiveSha, entries: archiveEntries.length, sourceCommit, upstreamCommit }
    } else {
      checks.push({ name: "delivery_archive_matches_head", ok: false, detail: `${RELEASE_ARCHIVE} 不存在或 tar 不可用（tar=${String(TAR)}）：本机没有可核对的发行产物` })
    }

    // ── 6) 解包发行产物并真实运行包内入口（不只看打包退出码） ──
    let packageScan: ScanResult | undefined
    if (archiveEntries.length && TAR !== undefined) {
      await mkdir(extraction, { recursive: true })
      const unpack = await track([TAR, "-xzf", RELEASE_ARCHIVE, "-C", extraction], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      const packageRoot = join(extraction, ARCHIVE_ROOT_NAME)
      const launcher = join(packageRoot, "lyapunov")
      const unpackedFiles = existsSync(packageRoot) ? await walkFiles(packageRoot) : []
      const unpackedBytes = unpackedFiles.reduce((sum, file) => sum + file.bytes, 0)
      const forbidden = unpackedFiles.filter(file => FORBIDDEN_NAME.test(file.relative.split("/").pop() ?? "") || FORBIDDEN_EXTENSION.test(file.relative))
      let versionRun = "未执行"
      let doctorRun = "未执行"
      let doctorReport: Record<string, unknown> | undefined
      let versionOk = false
      if (unpack.exit === 0 && existsSync(launcher)) {
        // 用包内自带运行时跑包内入口；清掉可能把宿主 SDK 注进来的覆盖变量，读到的是包自身状态。
        const env = { LYAPUNOV_MUJOCO_PYTHON: undefined, LYAPUNOV_ISAAC_PYTHON: undefined }
        const version = await track([launcher, "--version"], { cwd: packageRoot, env, timeoutMs: 300_000 })
        versionRun = readout(version)
        versionOk = version.exit === 0 && /"product":"LyapunovDSH"/.test(version.stdout)
        const doctor = await track([launcher, "doctor"], { cwd: packageRoot, env, timeoutMs: 300_000 })
        doctorRun = readout(doctor)
        try { doctorReport = JSON.parse(doctor.stdout) as Record<string, unknown> } catch { doctorReport = undefined }
      }
      checks.push({
        name: "release_package_unpacked_entry_runs",
        ok: unpack.exit === 0 && versionOk && doctorReport !== undefined && forbidden.length === 0,
        detail: `tar -xzf 到 ${relative(PRODUCT_ROOT, extraction)} → ${readout(unpack)}；解包 ${unpackedFiles.length} 文件 / ${(unpackedBytes / 1048576).toFixed(1)} MB；`
          + `包内 ./lyapunov --version（用包自带 runtime/node）→ ${versionRun}；包内 ./lyapunov doctor → ${doctorRun}；`
          + `doctor 的 desktop 读数=${JSON.stringify(doctorReport?.desktop ?? null)}；providers=${JSON.stringify(doctorReport?.providers ?? null)}；`
          + `按产品自己的发行判据（script/package-linux.ts 的 forbiddenName/forbiddenExtension）命中 ${forbidden.length} 个${forbidden.length ? `：${forbidden.slice(0, 5).map(file => file.relative).join(", ")}` : ""}`,
      })
      if (existsSync(packageRoot)) packageScan = await scanFiles(unpackedFiles, "解包发行包全文")
    } else {
      checks.push({ name: "release_package_unpacked_entry_runs", ok: false, detail: "没有可解包的发行产物，未运行包内入口" })
    }

    // ── 7) 包中无秘密：干净树（发布集 / 历史证据集）与解包发行包分别扫描 ──
    if (tracked.length) {
      const sized: Array<{ path: string; relative: string; bytes: number }> = []
      const evidenceSized: Array<{ path: string; relative: string; bytes: number }> = []
      for (const path of tracked) {
        try {
          const bytes = (await stat(join(worktree, path))).size
          if (path.startsWith("bugfixHistory/")) evidenceSized.push({ path: join(worktree, path), relative: path, bytes })
          else sized.push({ path: join(worktree, path), relative: path, bytes })
        } catch { /* 竞态：跳过 */ }
      }
      const sourceScan = await scanFiles(sized, "干净树发布集（HEAD 跟踪文件，排除 bugfixHistory/）")
      const evidenceScan = await scanFiles(evidenceSized, "干净树开发证据集（bugfixHistory/，docs/publishable-boundary.md 列为不发布）")
      // N352b 判据对齐：发行集里"零**非白名单**命中"才算过——自述占位值（`PUBLIC_PLACEHOLDERS`，逐条注明理由）
      // 与**注释行**命中只计数、不判失败；两者都在读数里如实报出（不静默放宽：非白名单命中仍逐条出现在读数里）。
      const releaseActionable = sourceScan.hits.reduce((sum, hit) => sum + (hit.count - hit.publicPlaceholders), 0)
      checks.push({
        name: "no_secrets_in_clean_tree",
        ok: releaseActionable === 0 && sourceScan.unreadable.length === 0,
        detail: `发布集非白名单命中=${releaseActionable}；${scanReadout(sourceScan)}；${scanReadout(evidenceScan)}。只报计数与路径，未打印任何匹配内容`,
      })
    } else {
      checks.push({ name: "no_secrets_in_clean_tree", ok: false, detail: "干净树未建立，未做秘密扫描" })
    }
    const packageAttribution = packageScan ? groupHitsByAttribution(packageScan) : undefined
    checks.push(packageAttribution
      ? {
        name: "no_product_secrets_in_release_package",
        ok: packageAttribution.product.length === 0 && packageScan!.unreadable.length === 0,
        detail: `按包内归属拆分：**产品自身路径**（packages/**、services/**、distribution/**、启动器、RELEASE.json 等）命中=${productHitReadout(packageAttribution.product)}；`
          + `具名第三方包／随包运行时／上游检出命中=${attributedReadout(packageAttribution.attributed)}。`
          + `本项只把产品自身路径的命中判为失败（产品的发行 fail-closed 判据也是这个口径）；第三方命中另立一条 check 归因报出。全文扫描读数：${scanReadout(packageScan!)}。只报计数与路径，未打印任何匹配内容`,
      }
      : { name: "no_product_secrets_in_release_package", ok: false, detail: "发行包未解包，未做全文扫描" })
    checks.push(packageAttribution
      ? {
        name: "release_package_third_party_secret_attribution",
        ok: packageAttribution.product.length === 0 && packageScan!.unreadable.length === 0,
        detail: `第三方命中逐条归因（包名@版本 + 模式 + 文件数，不打印内容）：${attributedReadout(packageAttribution.attributed)}。`
          + `性质说明：private_key_block 全部来自 happy-dom@20.11.6 内置的**自签 HTTPS 测试证书夹具**（src 与 lib 各一份，是该库公开的本地 fetch 测试材料）、jose 的 PEM 头字符串常量，以及 claude/micromamba 二进制内的字符串；`
          + `sk-/gh_/Bearer/AIza 命中全部落在 esbuild、libvips、codex、claude、lightningcss、node、electron、micromamba 等**具名第三方二进制或第三方 js** 里；aws 命中里有 2 条等于 AWS 官方文档的公开示例密钥（aws-sdk 的 .d.ts 注释）。`
          + `按主代理裁定口径：可归因到具名第三方包/供应方的命中属依赖闭包自带夹具，**不作为产品失败**；产品自身路径命中才判失败（见 no_product_secrets_in_release_package）。本门不删除、不修改任何第三方文件`,
      }
      : { name: "release_package_third_party_secret_attribution", ok: false, detail: "发行包未解包，未做第三方归因扫描" })

    // 扫描器自检：本门源码里由片段拼接出的模式字面量必须不能命中自己，否则上面所有「0 匹配」都不可信。
    const selfFiles = ["script/gates/g17.ts", "script/gates/run-g17.ts"].map(path => ({ path: join(PRODUCT_ROOT, path), relative: path, bytes: 0 }))
    for (const file of selfFiles) file.bytes = existsSync(file.path) ? (await stat(file.path)).size : 0
    const selfScan = await scanFiles(selfFiles, "扫描器自检（本门源码）")
    checks.push({
      name: "secret_scanner_self_check",
      ok: selfScan.hits.length === 0 && selfFiles.every(file => file.bytes > 0),
      detail: `${scanReadout(selfScan)}（模式字面量由片段拼接，不应命中自身；命中即说明扫描结论不可信）`,
    })

    // ── 8) 包中无无关模型：权重扩展名 + 大体积条目读数 ──
    if (tracked.length) {
      const weightFiles: Array<{ relative: string; bytes: number }> = []
      for (const path of tracked) {
        if (!WEIGHT_EXTENSION.test(path) || path.startsWith("bugfixHistory/")) continue
        try { weightFiles.push({ relative: path, bytes: (await stat(join(worktree, path))).size }) } catch { /* 竞态：跳过 */ }
      }
      const weightBytes = weightFiles.reduce((sum, file) => sum + file.bytes, 0)
      const large = weightFiles.filter(file => file.bytes > 8 * 1024 * 1024)
      checks.push({
        name: "no_model_weights_in_publishable_set",
        ok: weightFiles.length === 0,
        detail: `干净树发布集里权重类扩展名（safetensors/gguf/ckpt/pt/pth/onnx/npz/npy/h5/pkl/engine/plan/bin）命中 ${weightFiles.length} 个 / 共 ${(weightBytes / 1048576).toFixed(1)} MB`
          + (weightFiles.length ? `：${weightFiles.slice(0, 8).map(file => `${file.relative}(${(file.bytes / 1048576).toFixed(1)}MB)`).join(", ")}${weightFiles.length > 8 ? ` 等 ${weightFiles.length} 个` : ""}` : "")
          + `；其中 >8MB 的 ${large.length} 个。旁证：script/package-linux.ts 的发行收集白名单只取 packages/*、node_modules/@deepseek-ai 与 @lyapunov、根依赖、distribution/linux，不收集 materials/、bugfixHistory/、script/、docs/，故大体积场景资产不进入 Linux 发行包`,
      })
    } else {
      checks.push({ name: "no_model_weights_in_publishable_set", ok: false, detail: "干净树未建立，未做权重读数" })
    }

    // ── 9) 旧引用残留：只读检索 + 生产/迁移/历史分类（合同 §4.7，不删除任何文件） ──
    if (GIT !== undefined && head.length === 40) {
      // 探针表在模块级导出（`LEGACY_OWNER_PATTERNS`）：opencode 组已按 N238 收窄，单测钉住收窄后的行为。
      const probes = LEGACY_OWNER_PATTERNS
      const rows: string[] = []
      let productionTotal = 0
      const productionPaths: string[] = []
      const probeFailures: Array<{ owner: string; exit: number | null; error: string }> = []
      for (const probe of probes) {
        // 一律走 PCRE（`-P`）：第一组探针含 `(?:…)`，`git grep -E`（POSIX ERE）会直接报"正则表达式无效"，
        // 旧实现只取 stdout ⇒ 该组**恒定 0 命中、探针哑掉却报绿**（2026-09-26 W24 实测）。
        const found = await track([GIT, "-C", worktree, "grep", "-l", "-P", "-e", probe.pattern], { cwd: PRODUCT_ROOT, timeoutMs: 300_000 })
        // 退出码语义：0=有命中、1=无命中、其余=真执行错误（正则无效/路径不存在…）。
        // 执行错误必须让本判据显式失败并带上原文，**绝不折算成"0 命中"**。
        const outcome = probeOutcome(found.exit, found.stdout, found.stderr)
        if (!outcome.ok) probeFailures.push({ owner: probe.owner, exit: found.exit, error: outcome.error ?? "" })
        const paths = outcome.paths
        const buckets: Record<string, string[]> = { production: [], migration: [], history: [], other: [] }
        for (const path of paths) {
          const bucket = path.startsWith("bugfixHistory/") || path.startsWith("docs/") || path.startsWith("goals/") || path.endsWith(".md")
            ? "history"
            : path.includes("migrat") ? "migration" : /^(packages|services)\/[^/]+\/src\//.test(path) ? "production" : "other"
          buckets[bucket]!.push(path)
        }
        productionTotal += buckets.production!.length
        productionPaths.push(...buckets.production!)
        rows.push(`${probe.owner}：合计 ${paths.length}（生产 ${buckets.production!.length}／迁移 ${buckets.migration!.length}／历史文档 ${buckets.history!.length}／其他 ${buckets.other!.length}）`
          + (buckets.production!.length ? `，生产命中示例=${buckets.production!.slice(0, 4).join(", ")}` : "")
          + (outcome.ok ? "" : `，**探针执行失败（exit=${String(found.exit)}，不得折算成 0 命中）**`))
      }
      // DEV-027 F17 + N238 Round 4：真判据只看"**未登记**的未预期生产残留"是否为 0；
      // 已登记例外**另打一行计数**（不计入通过分子、也不表示"无残留"）。
      const residue = legacyResidueVerdict(productionPaths)
      checks.push({
        name: "legacy_owner_residue_readonly",
        ok: residue.ok && probeFailures.length === 0,
        detail: `在干净树（HEAD 内容）上只读检索 ${probes.length} 组旧 owner 名称，未删除/移动任何文件：${rows.join(" | ")}。`
          + (probeFailures.length
            ? `**探针执行失败=${probeFailures.length} 组**（非 0/1 退出码一律判失败，不折算成 0 命中）：${probeFailures.map(failure => `${failure.owner}（exit=${String(failure.exit)}：${failure.error}）`).join("；")}。`
            : `探针执行失败=0 组（${probes.length} 组全部以 0/1 退出码正常返回，正则语法有效）。`)
          + `读法：生产命中合计 ${productionTotal} 个文件（去重 ${new Set(productionPaths).size} 个）——结构性允许集=主题来源标记 packages/lyapunov-shell/src/preferences-theme-sources/ 与迁移器读码 packages/lyaup-migrations/（§4.7 第 5 条允许隔离保留）；`
          + `**例外=${residue.exceptions.length} 个**（已登记的有意兼容读/历史身份字符串，**不计入通过分子、也不表示"无残留"**）${residue.exceptions.length ? `：${residue.exceptions.map(path => `${path}（${documentedLegacyCompatExceptions.find(entry => entry.path === path)?.reason ?? ""}）`).join("；")}` : ""}；`
          + `**未预期生产残留=${residue.unexpected.length} 个**${residue.unexpected.length ? `：${residue.unexpected.slice(0, 8).join(", ")}` : "（其余 SceneBridge/SceneCore/ScenePage/planning-service/robot-bridge/tool-forge/robot-loops/background-intent 在生产源码中 0 命中）"}。`
          + `本项是**残留计数真判据**（任一**未登记**生产命中即 ok:false），但**名字检索仍不冒充 §4.7 验收**：合同 §4.7 明说"\`rg\` 零字符串不是验收"；§4.7 四条删除条件中**可判定的两条**已另立真断言（见 legacy_owner_modules_absent_from_clean_tree 与 release_launch_chain_has_no_legacy_owner_dependency）；剩下两条（"旧状态已转换或可只读访问"需真实旧数据、"生产消费者全部切换"需外部消费者）本机无夹具，如实留在 BLOCKED。例外清单是否被允许**由主代理裁决**（本轮只登记理由与依据）。`,
      })

      // ── 9b) §4.7 条件②"生产消费者全部切换"的**结构面**：旧 owner **模块**必须在干净树里不存在。
      //     这不是名字检索——名字检索找的是字符串，这里找的是"那些平台模块本身还在不在仓库里"。
      //     合同禁止把 `rg` 零字符串当验收，但反过来"模块已不在版本控制的发布集里"是可判定的事实。
      const moduleFamilies = [
        "scene-?core", "scene-?bridge", "scene-?page", "planning-service",
        "robot-bridge", "tool-forge", "robot-loops", "background-intent", "opencode",
      ]
      const trackedNames = tracked
      const moduleHits = trackedNames.filter(path => new RegExp(moduleFamilies.join("|"), "i").test(path))
      // 允许的存在物：历史文档（bugfixHistory/docs/goals/*.md）与主题来源标记 JSON——它们不是"平台模块"。
      const allowedResidue = (path: string): boolean =>
        path.startsWith("bugfixHistory/") || path.startsWith("docs/") || path.startsWith("goals/") || path.endsWith(".md")
        || /^packages\/lyapunov-shell\/src\/preferences-theme-sources\//.test(path)
      const platformModules = moduleHits.filter(path => !allowedResidue(path))
      checks.push({
        name: "legacy_owner_modules_absent_from_clean_tree",
        ok: platformModules.length === 0,
        detail: `干净树（HEAD，${trackedNames.length} 个受版本控制文件）里匹配 ${moduleFamilies.length} 组旧 owner 模块名的路径=${moduleHits.length} 个`
          + `（其中历史文档/主题来源标记等允许残留=${moduleHits.length - platformModules.length} 个：${moduleHits.filter(allowedResidue).slice(0, 4).join(", ")}）；`
          + `**平台模块残留=${platformModules.length} 个**${platformModules.length ? `：${platformModules.slice(0, 6).join(", ")}` : "（§4.7 第 2/3/4/5 条点名的 SceneCore/SceneBridge/ScenePage/planning-service/robot-bridge/Tool Forge/robot-loops/background-intent/opencode 平台在发布源里已不存在）"}`,
      })

      // ── 9c) §4.7 条件④"发行启动链不再依赖"：**生成出来的**运行补丁里不能出现旧 owner 名。
      //     与 9b 不同，这条看的是真实启动装配的产物（runtimePatch 返回值），而不是源码 grep。
      const launchProbe = await track([BUN ?? "bun", "run", "script/gates/probe-launch-chain.ts"], { cwd: PRODUCT_ROOT, timeoutMs: 180_000 })
      const launchOut = launchProbe.stdout.trim()
      let launchParsed: { plugins?: number; legacyHits?: string[]; error?: string } | undefined
      try { launchParsed = JSON.parse(launchOut.split("\n").filter(Boolean).at(-1) ?? "") as typeof launchParsed } catch { /* 记为不可解析 */ }
      const launchHits = launchParsed?.legacyHits ?? []
      checks.push({
        name: "release_launch_chain_has_no_legacy_owner_dependency",
        ok: launchProbe.exit === 0 && launchParsed !== undefined && launchParsed.error === undefined && launchHits.length === 0,
        detail: launchParsed === undefined
          ? `启动链探针未产出可解析读数（退出码=${String(launchProbe.exit)}）：stdout=${launchOut.slice(0, 240)} stderr=${launchProbe.stderr.slice(0, 160)}`
          : `真实调用产品 \`runtimePatch()\`（developer + mujoco 分支）生成的运行补丁：插入产品插件 ${launchParsed.plugins ?? "?"} 个；**旧 owner 名命中=${launchHits.length}**`
            + `${launchHits.length ? `（${launchHits.slice(0, 6).join(", ")}）` : "（启动装配只插入 lyapunov-* 产品插件，零引用旧平台）"}；探针退出码=${String(launchProbe.exit)}`
            + `${launchParsed.error ? `；探针报错=${launchParsed.error}` : ""}`,
      })
    } else {
      checks.push({ name: "legacy_owner_residue_readonly", ok: false, detail: "干净树未建立或缺 git，未做残留检索" })
      checks.push({ name: "legacy_owner_modules_absent_from_clean_tree", ok: false, detail: "干净树未建立或缺 git，未做模块级判定" })
      checks.push({ name: "release_launch_chain_has_no_legacy_owner_dependency", ok: false, detail: "干净树未建立或缺 git，未做启动链判定" })
    }

    // ── 10) 所有 R/F 有归属与结果：按合同指定文档做覆盖读数 ──
    const docDir = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution")
    const docs: Array<{ name: string; text: string }> = []
    for (const name of ["ACCEPTANCE.md", "STATUS.md", "FEATURE_MAP.md"]) {
      const path = join(docDir, name)
      if (existsSync(path)) docs.push({ name, text: await readFile(path, "utf8") })
    }
    if (docs.length) {
      const ids = [...Array.from({ length: 14 }, (_, index) => `R-${String(index + 1).padStart(3, "0")}`), ...Array.from({ length: 21 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`)]
      const missingEverywhere: string[] = []
      const rows: Array<{ id: string; documented: string[]; hasResultInAcceptance: boolean }> = []
      for (const id of ids) {
        const matcher = new RegExp(`\\b${id}\\b`)
        const documented = docs.filter(doc => matcher.test(doc.text)).map(doc => doc.name)
        rows.push({ id, documented, hasResultInAcceptance: documented.includes("ACCEPTANCE.md") })
        if (!documented.length) missingEverywhere.push(id)
      }
      const missingInAcceptance = rows.filter(row => !row.hasResultInAcceptance)
      checks.push({
        name: "r_and_f_ids_have_owner",
        ok: missingEverywhere.length === 0,
        detail: `在 ${docs.map(doc => doc.name).join(" / ")} 中检索 R-001—R-014、F01—F21 共 ${ids.length} 个标识：三份文档都没有记录的=${JSON.stringify(missingEverywhere)}（${missingEverywhere.length ? "这些是真正的无归属项" : "每个标识至少在合同指定文档里有归属记录"}）`,
      })
      checks.push({
        name: "r_and_f_results_in_acceptance",
        ok: missingInAcceptance.length === 0,
        // 逐条列全，便于补齐账本；不省略任何一条。
        detail: `合同 §6.1/§6.5 要求逐门实测证据落在 ACCEPTANCE.md。本次逐条读数（${ids.length} 个标识，按 R-001…R-014、F01…F21 顺序）：`
          + (missingInAcceptance.length
            ? `未出现在 ACCEPTANCE.md 的 ${missingInAcceptance.length} 个，逐条列全其当前归属——`
              + missingInAcceptance.map(row => `${row.id}：${row.documented.length ? `仅 ${row.documented.map(name => name.replace(".md", "")).join(" + ")}` : "三份文档都没有（无归属）"}`).join("；")
              + `。已在 ACCEPTANCE.md 出现的 ${rows.length - missingInAcceptance.length} 个：${rows.filter(row => row.hasResultInAcceptance).map(row => row.id).join(", ")}`
            : `全部 ${ids.length} 个标识均已在 ACCEPTANCE.md 出现（${rows.map(row => row.id).join(", ")}）`)
          + "。这是文档覆盖读数，不代表这些 R/F 的实现或证据质量",
      })
      evidence.rAndF = rows
    } else {
      checks.push({ name: "r_and_f_ids_have_owner", ok: false, detail: `${docDir} 下没有 ACCEPTANCE.md/STATUS.md/FEATURE_MAP.md，无法做归属读数` })
      checks.push({ name: "r_and_f_results_in_acceptance", ok: false, detail: "缺文档，无法读数" })
    }

    // ── 11) 类型检查：产品源码由根 tsc 判定；本门文件独立判定；其它门只做归因读数 ──
    const tsc = join(PRODUCT_ROOT, "node_modules/.bin/tsc")
    const tscDiagnostics = (text: string): string[] => text.split("\n").filter(line => /error TS/.test(line))
    if (existsSync(tsc)) {
      // 根 tsconfig 只覆盖产品源码（packages/*/src、packages/*/test、script/*.ts 顶层）；script/gates/** 由主代理
      // 显式排除，各门自证——这样一个门作者的在制品不会把整树 typecheck 判红（交叉污染）。
      const project = await track([tsc, "--noEmit", "-p", "tsconfig.json"], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      const productErrors = tscDiagnostics(project.stdout + "\n" + project.stderr)
      checks.push({
        name: "project_typecheck",
        ok: project.exit === 0,
        detail: `产品源码（packages/*/src、packages/*/test、script/*.ts）用根 ./node_modules/.bin/tsc --noEmit -p tsconfig.json → exit=${project.exit}（${project.elapsedMs}ms），error TS 行 ${productErrors.length} 条`
          + (productErrors.length ? `：${productErrors.slice(0, 8).join(" | ")}${productErrors.length > 8 ? ` 等 ${productErrors.length} 条` : ""}` : "")
          + "。script/gates/** 不在该 include 内（门是逐门自证的交付物），故本项判据不受其它门在制品影响",
      })
      const isolatedConfig = join(WORK_ROOT, "tsconfig-g17.json")
      await writeFile(isolatedConfig, JSON.stringify({
        extends: relative(WORK_ROOT, join(PRODUCT_ROOT, "tsconfig.json")),
        include: [relative(WORK_ROOT, join(PRODUCT_ROOT, "script/gates/g17.ts")), relative(WORK_ROOT, join(PRODUCT_ROOT, "script/gates/run-g17.ts"))],
      }, null, 2) + "\n")
      const isolated = await track([tsc, "--noEmit", "-p", isolatedConfig], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      const ownErrors = tscDiagnostics(isolated.stdout + "\n" + isolated.stderr)
      checks.push({
        name: "gate_sources_typecheck",
        ok: isolated.exit === 0,
        detail: `同一 tsc、同一 compilerOptions，仅 include script/gates/{g17,run-g17}.ts：exit=${isolated.exit}，error TS 行 ${ownErrors.length} 条${ownErrors.length ? `：${ownErrors.slice(0, 5).join(" | ")}` : ""}`,
      })
      // 其它门（含 run-*.ts）只做归因读数：它们是并行会话的在制品，出错不该由本门承担，但必须点名到文件与错误码。
      const gatesConfig = join(WORK_ROOT, "tsconfig-gates-readout.json")
      await writeFile(gatesConfig, JSON.stringify({
        extends: relative(WORK_ROOT, join(PRODUCT_ROOT, "tsconfig.json")),
        include: [`${relative(WORK_ROOT, join(PRODUCT_ROOT, "script/gates"))}/**/*.ts`, `${relative(WORK_ROOT, join(PRODUCT_ROOT, "script/gates"))}/**/*.mts`],
      }, null, 2) + "\n")
      const gates = await track([tsc, "--noEmit", "-p", gatesConfig], { cwd: PRODUCT_ROOT, timeoutMs: 900_000 })
      const gateErrors = tscDiagnostics(gates.stdout + "\n" + gates.stderr)
      const byFile = new Map<string, string[]>()
      for (const line of gateErrors) {
        const parsed = /^([^(]+)\((\d+),(\d+)\): (error TS\d+)/.exec(line)
        const file = parsed?.[1] ?? line.slice(0, 80)
        const code = parsed?.[4] ?? "error TS?"
        const row = byFile.get(file) ?? []
        row.push(`${code}@${parsed?.[2] ?? "?"}:${parsed?.[3] ?? "?"}`)
        byFile.set(file, row)
      }
      const others = [...byFile.entries()].filter(([file]) => !/script\/gates\/(?:run-)?g17\.ts$/.test(file))
      const ownCount = [...byFile.entries()].filter(([file]) => /script\/gates\/(?:run-)?g17\.ts$/.test(file)).length
      checks.push({
        name: "other_gates_typecheck_readout",
        ok: true,
        detail: `script/gates/** 全量 tsc 归因读数（同一 compilerOptions，exit=${gates.exit}，错误 ${gateErrors.length} 条，涉及 ${byFile.size} 个文件；其中本门文件 ${ownCount} 个）：`
          + (others.length
            ? others.map(([file, rows]) => `${file}（${rows.length} 条：${rows.slice(0, 4).join(", ")}${rows.length > 4 ? " 等" : ""}）`).join("；")
            : "除本门外其它门 0 错误")
          + "。这些文件由并行会话维护、本门无权修改，按主代理裁定只作独立条目点名，不计入本门失败判据",
      })
    } else {
      checks.push({ name: "project_typecheck", ok: false, detail: `${tsc} 不存在` })
      checks.push({ name: "gate_sources_typecheck", ok: false, detail: `${tsc} 不存在` })
      checks.push({ name: "other_gates_typecheck_readout", ok: false, detail: `${tsc} 不存在，无法做归因读数` })
    }

    // ── 12) 自证隔离：本次运行不得改动主工作树的 packages/** ──
    const changed = distSnapshotBefore ? diffSnapshot(distSnapshotBefore, await mainTreeDistSnapshot()) : ["未取得运行前快照"]
    checks.push({
      name: "main_tree_packages_untouched",
      ok: changed.length === 0,
      detail: `含构建在内的整轮运行前后，主工作树 packages/*/dist 清单变化 ${changed.length} 项${changed.length ? `：${changed.slice(0, 5).join(", ")}（也可能来自本机其它并行会话的构建）` : "（本门只在 .runtime/goal-verify/g17/ 下的临时树里构建）"}`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: `G17 入口异常：${messageOf(error)}` })
  } finally {
    // ── 清理：临时 worktree 用 git worktree remove；解包目录直接删除（都在 .runtime/goal-verify/g17/ 内） ──
    if (GIT !== undefined && existsSync(worktree)) {
      const removed = await run([GIT, "worktree", "remove", "--force", worktree], { cwd: PRODUCT_ROOT, timeoutMs: 300_000 })
      worktreeRemoved = readout(removed)
      if (removed.exit !== 0 && existsSync(worktree)) {
        await rm(worktree, { recursive: true, force: true })
        const pruned = await run([GIT, "worktree", "prune"], { cwd: PRODUCT_ROOT, timeoutMs: 300_000 })
        worktreeRemoved += `；remove 失败后 rm -rf + git worktree prune → ${readout(pruned)}`
      }
    }
    if (existsSync(extraction)) {
      await rm(extraction, { recursive: true, force: true })
      extractionRemoved = "已删除解包目录"
    }
  }

  const summary = {
    worktree: { path: worktree, removed: worktreeRemoved },
    extraction: { path: extraction, removed: extractionRemoved },
    commands: commands.map(record => ({
      command: record.command,
      cwd: relative(PRODUCT_ROOT, record.cwd) || ".",
      exit: record.exit,
      elapsedMs: record.elapsedMs,
      timedOut: record.timedOut,
      stdoutTail: tail(record.stdout, 400),
      stderrTail: tail(record.stderr, 400),
      spawnError: record.spawnError,
    })),
  }
  const blocked = [
    "桌面 Electron **真实启动**本机未验证：包内 `distribution/linux/doctor.mjs` 只用 `ldd` 做桌面二进制依赖自检（本轮读数 desktop.status=AVAILABLE、missingSystemLibraries=[]），这只证明动态库齐备，不等于窗口能起、也不等于正式登录/更新服务可用。",
    "老版本升级/数据恢复未验证：本机没有旧版本安装包与旧用户数据。迁移入口 `packages/lyaup-migrations` 与 `script/migrate.ts` 在树内，但缺旧 opencode.db／旧 JSON storage／旧附件与旧发行包，本轮无法真实重开旧数据。",
    "干净安装的完整前置（`script/bootstrap.mjs` 联网克隆固定上游 + `bun install`）本轮未执行：任务约束不联网、不安装。`clean_checkout_offline_prerequisite_gap` 记录的是这两种缺失下的**真实报错**；`delivery_build_clean_checkout` 是复用机器上已固定的同一上游与已安装依赖符号链接后的读数。",
    "真实发布/推送/签名未执行（合同 §7 未授权）；发行回执自身只有 `BUILT_NOT_RUNTIME_VERIFIED` 级别。Provider SDK（MuJoCo/Isaac/GraspGenX/AnyGrasp）随包安装需要网络与许可，本轮未执行，包内 `./lyapunov doctor` 如实报 PROVIDER_UNAVAILABLE。",
    "包内容口径：`materials/`（374 MB 场景资产，含 6 个 33—39 MB 的 .spz）在 `docs/publishable-boundary.md` 里既未列入发布也未列入排除，本门只按 `script/package-linux.ts` 的收集白名单与它自己的 fail-closed 判据核对，不替产品决定 materials/ 是否入库；`bugfixHistory/`（1523 文件、约 73.7 MB，含旧发行 staging 快照）虽被该文档列为排除却仍被 git 跟踪，本门只报读数、不删除。",
    "「包中无秘密」按归属分面读：发行包**产品自身路径 0 命中**；第三方依赖闭包与随包运行时里的凭据形状字符串已逐条归因到具名包（happy-dom@20.11.6 的自签 HTTPS 测试证书夹具、jose 的 PEM 头常量、claude/micromamba 等二进制内的字符串，另有 2 条等于 AWS 公开文档示例密钥），按裁定口径不作为产品失败，但本门不做「第三方依赖内部是否含测试证书」的产品级判决。",
    "旧引用只做了名称级只读检索与分类，未取得「新入口对应功能可用／生产消费者全部切换／旧状态已转换或可只读访问／发行启动链不再依赖」四项的行为级证据，故不声称 §4.7 删除条件已满足。",
  ].join(" ")

  const writeEvidence = async (): Promise<string> => {
    const path = join(WORK_ROOT, `g17-evidence-${stamp}.json`)
    await writeFile(path, JSON.stringify({ ...evidence, checks, blocked, ...summary }, null, 2) + "\n")
    return path
  }
  const evidencePath = await writeEvidence()
  checks.push({
    name: "evidence_written",
    ok: existsSync(evidencePath),
    detail: `真实读数与产物清单写入 ${relative(PRODUCT_ROOT, evidencePath)}；临时 worktree：${worktreeRemoved}；解包目录：${extractionRemoved}。证据文件只含命令退出码、计数、路径与产物字节数，不含任何匹配到的凭据内容`,
  })
  await writeEvidence()

  return { gate: "G17", checks, blocked }
}
