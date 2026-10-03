/**
 * DEV-021 / W7 「迁移合同」在**真实旧数据副本**上的实测驱动。
 *
 * 这不是 `bun test` 用例（文件名不匹配 test:ci 的发现规则，也不进清单）：它依赖本机真实旧数据，
 * 换台机器就没有夹具，硬写成用例只会把"夹具不在"伪装成"迁移坏了"。
 *
 * 纪律：真实数据目录**只读**。流程一律是「复制进临时区 → 对副本跑迁移 → 比对读数」：
 *   · 旧 SQLite 三件套（db/-wal/-shm）复制后才读，运行前后复核副本 sha256 未变；
 *   · 旧资源索引与旧 Scene 副本来自 `.runtime/lane-env33/real-old`（历史轮次的真实副本）；
 *   · 恢复原件的那条重跑路径写在派生工作区里，绝不往真实 `History/Main` 写字。
 *
 * 用法：
 *   bun run packages/lyaup-migrations/test/real-data-contract.ts \
 *     [--source <旧 opencode 数据目录>] [--scratch <临时根>] [--evidence <输出 JSON>]
 * 环境覆盖：LYAPUNOV_REAL_OLD_DIR / LYAPUNOV_REAL_OLD_COPY / LYAPUNOV_G14_FIXTURE_ROOT。
 */
import { Context } from "@deepseek-ai/cordis"
import { SessionId } from "@deepseek-ai/dsh-session"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { migrateLegacy, type MigrationOptions } from "../src/index.ts"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"

const DEV_ROOT = resolve(import.meta.dirname, "../../..")
const DEFAULTS = {
  source: process.env.LYAPUNOV_REAL_OLD_DIR ?? "/home/s18/WS/Lyapunov/.lya/developer-runtime/data/opencode",
  copy: process.env.LYAPUNOV_REAL_OLD_COPY ?? join(DEV_ROOT, ".runtime/lane-env33/real-old"),
  g14: process.env.LYAPUNOV_G14_FIXTURE_ROOT ?? "/home/s18/WS/Lyapunov/DSH/bugfixHistory/refactor-execution/B-migration-evidence/fixture-2026-09-06T01-48-11-221Z",
  /** 历史轮次在同一份真实副本上跑出的账本：用来证明同一账号+同一旧源的 ID 跨轮次稳定。 */
  previousLedger: join(DEV_ROOT, ".runtime/lane-env33/migrate-new/dsh/migrations/lyaup-old/ledger.json"),
  /** 旧资源索引里的相对路径挂在这个旧工作区根下（只读，不写）。 */
  libraryWorkspace: "/home/s18/WS/Lyapunov/History/Main",
}
/** 证据文件路径**只从本模块位置推导**（不经过 DEV_ROOT、不依赖 cwd）：多一层 `..` 就会静默写到别的目录。 */
const evidencePath = (() => {
  const index = process.argv.indexOf("--evidence")
  return index >= 0 ? resolve(process.argv[index + 1]!) : join(import.meta.dirname, "../evidence/real-data-contract-20260926.json")
})()

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")
const readJSON = async (path: string) => JSON.parse(await readFile(path, "utf8")) as any
async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}
/** 产物指纹：默认排除每次运行都会新增的时间戳快照与含时间戳路径的 result.json。 */
async function treeHashes(root: string, include: (relative: string) => boolean = () => true) {
  const out: Record<string, string> = {}
  for (const path of await walk(root)) {
    const relative = path.slice(root.length + 1)
    if (!include(relative)) continue
    out[relative] = `${(await stat(path)).size}:${await sha256(path)}`
  }
  return out
}
const isRunScoped = (relative: string) => !/^migrations\/[^/]+\/(source-|result\.json$)/.test(relative) && !/^migrations\/[^/]+\/preferences\//.test(relative)

async function reopenAll(dshHome: string, ledger: any) {
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence as any, { root: join(dshHome, "sessions"), compression: "zstd" } as any)
  const out: any[] = []
  try {
    for (const [oldId, entry] of Object.entries<any>(ledger.sessions)) {
      const handle = await (ctx as any).sessionPersistence.open(SessionId(entry.id), "read")
      try {
        const log = await handle.read()
        const events = log.events as any[]
        out.push({ oldId, id: entry.id, ledgerEvents: entry.eventCount, reopenedEvents: events.length, cwd: handle.header?.cwd ?? null, events })
      } finally { await handle.close() }
    }
  } finally { await fiber.dispose() }
  return out
}

/** 源记录 → 可见事件的对账：每条 text/reasoning/tool 的内容都要能在重开的事件里找到。 */
function accountSession(oldId: string, exported: any, ledger: any, reopened: any) {
  const rows = exported.message.filter((row: any) => row.session_id === oldId)
  const parts = exported.part.filter((part: any) => part.session_id === oldId)
  const events = reopened.events as any[]
  const blocks: any[] = []
  for (const event of events) {
    if (event.type === "user/message") blocks.push(...(event.data.content ?? []))
    else if (event.type === "assistant/message") blocks.push(...(event.data.message?.content ?? []))
    else if (event.type === "tool/result") for (const wrapper of event.data.message?.content ?? []) blocks.push(...(wrapper.content ?? []))
  }
  const sourceStrings: string[] = [], migratedStrings: string[] = []
  const sourceKinds: Record<string, number> = {}
  for (const part of parts) {
    const data = typeof part.data === "string" ? JSON.parse(part.data) : part.data
    const kind = data?.type
    sourceKinds[kind] = (sourceKinds[kind] ?? 0) + 1
    if ((kind === "text" || kind === "reasoning") && typeof data.text === "string") sourceStrings.push(data.text)
    else if (kind === "tool") {
      if (data.state?.status === "completed" && data.state.output !== undefined) sourceStrings.push(String(data.state.output))
      else if (data.state?.status === "error" && data.state.error !== undefined) sourceStrings.push(String(data.state.error))
    }
  }
  for (const block of blocks) if (block.type === "text" || block.type === "reasoning") migratedStrings.push(String(block.text))
  const toolParts = sourceKinds.tool ?? 0
  const toolCalls = blocks.filter(block => block.type === "tool-call").length
  const toolResults = events.filter(event => event.type === "tool/result").length
  return {
    oldId, id: reopened.id,
    sourceMessages: rows.length, sourceParts: parts.length, sourceKinds,
    ledgerHasAllMessages: rows.every((row: any) => Boolean(ledger.messages[row.id])),
    ledgerHasAllParts: parts.every((part: any) => Boolean(ledger.parts[part.id])),
    ledgerEvents: reopened.ledgerEvents, reopenedEvents: reopened.reopenedEvents, eventCountMatches: reopened.ledgerEvents === reopened.reopenedEvents,
    cwd: reopened.cwd,
    textBlocks: blocks.filter(block => block.type === "text").length,
    reasoningBlocks: blocks.filter(block => block.type === "reasoning").length,
    imageBlocks: blocks.filter(block => block.type === "image").length,
    fileBlocks: blocks.filter(block => block.type === "file").length,
    toolCalls, toolResults, toolCountsMatch: toolParts === toolCalls && toolParts === toolResults,
    unmatchedSourceStrings: sourceStrings.filter(value => !migratedStrings.includes(value)),
    sourceStrings: sourceStrings.length,
  }
}

const checks: Array<{ name: string; ok: boolean; reading: unknown }> = []
const check = (name: string, ok: boolean, reading: unknown) => { checks.push({ name, ok, reading }); if (!ok) console.error(`FAIL ${name}: ${JSON.stringify(reading)}`) }
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** 两个 JSON 的差异路径（只报前 20 条），用于把"账本变了"定位到具体字段。 */
function diffPaths(a: any, b: any, prefix = "", out: string[] = []): string[] {
  if (out.length >= 20) return out
  if (a === b) return out
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${prefix}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`); return out
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[key], b[key], `${prefix}/${key}`, out)
  return out
}

const { values } = parseArgs({ args: process.argv.slice(2), options: { source: { type: "string" }, scratch: { type: "string" }, evidence: { type: "string" } } })
const sourceDirectory = resolve(values.source ?? DEFAULTS.source)
const scratch = values.scratch ? resolve(values.scratch) : await mkdtemp("/dev/shm/lyaup-migration-contract-")
await mkdir(scratch, { recursive: true })
const evidence: Record<string, unknown> = { driver: "real-data-contract", sourceDirectory, scratch, startedAt: new Date().toISOString(), checks }

try {
  // ── 0. 复制真实旧数据（源目录只读） ────────────────────────────────────────
  const realOld = join(scratch, "real-old")
  await mkdir(realOld, { recursive: true })
  const sourceFiles = ["opencode-local.db", "opencode-local.db-wal", "opencode-local.db-shm"].filter(name => existsSync(join(sourceDirectory, name)))
  for (const name of sourceFiles) await cp(join(sourceDirectory, name), join(realOld, name))
  await cp(join(DEFAULTS.copy, "library.json"), join(realOld, "library.json"))
  await mkdir(join(realOld, "scenes"), { recursive: true })
  for (const name of await readdir(join(DEFAULTS.copy, "scenes"))) await cp(join(DEFAULTS.copy, "scenes", name), join(realOld, "scenes", name))
  const copyHashesBefore = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, await sha256(join(realOld, name))])))
  const liveHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, await sha256(join(sourceDirectory, name))])))
  evidence.sourceCopies = { files: sourceFiles, copiesMatchOriginals: sameJSON(copyHashesBefore, liveHashes), sha256: copyHashesBefore }

  const library = await readJSON(join(realOld, "library.json"))
  const sceneFiles = (await readdir(join(realOld, "scenes"))).map(name => join(realOld, "scenes", name))
  const sqliteOptions = (installRoot: string, accountKey = "developer", label = "lyaup-old"): MigrationOptions => ({
    sourceDatabase: join(realOld, "opencode-local.db"),
    sourceLabel: label, accountKey,
    dshHome: join(installRoot, "dsh"), sceneRoot: join(installRoot, "scenes"),
    resourceLibraries: [{ path: join(realOld, "library.json"), workspaceRoot: DEFAULTS.libraryWorkspace }],
    sceneFiles,
  })

  // ── 1. 真实旧库：三次迁移（首次 / 幂等重跑 / 再重跑） ──────────────────────
  const first = await migrateLegacy(sqliteOptions(join(scratch, "run-a")))
  const second = await migrateLegacy(sqliteOptions(join(scratch, "run-a")))
  const third = await migrateLegacy(sqliteOptions(join(scratch, "run-a")))
  const summarize = (result: Awaited<ReturnType<typeof migrateLegacy>>) => ({
    status: result.status, exitCode: result.exitCode, created: result.created, unchanged: result.unchanged, updated: result.updated,
    resources: result.resources, resourceMetadataUpdated: result.resourceMetadataUpdated, scenes: result.scenes, attachments: result.attachments,
    repairedSessions: result.repairedSessions, repairedAttachments: result.repairedAttachments,
    interruptedTools: result.interruptedTools, metadataOnlyParts: result.metadataOnlyParts,
    sourceCounts: result.sourceCounts, sourceUnmigrated: result.sourceUnmigrated, sourceUnchanged: result.sourceUnchanged,
    missing: result.missing.length, missingEntries: result.missing,
  })
  evidence.sqliteRuns = { first: summarize(first), second: summarize(second), third: summarize(third) }
  const summaries = evidence.sqliteRuns as Record<"first" | "second" | "third", ReturnType<typeof summarize>>
  check("真实旧库：首次迁移已导入 6 个旧会话", first.created === 6, { created: first.created })
  check("真实旧库：旧源 456 消息 / 1721 part 全部读到", first.sourceCounts.message === 456 && first.sourceCounts.part === 1721, first.sourceCounts)
  check("真实旧库：重跑不新建会话（幂等）", second.created === 0 && second.unchanged === 6, { created: second.created, unchanged: second.unchanged })
  check("真实旧库：重跑读数与首次一致（资源/场景/缺失）",
    second.resources === 0 && second.scenes === 0 && sameJSON(second.sourceCounts, first.sourceCounts),
    { resources: second.resources, scenes: second.scenes })
  check("真实旧库：第二次与第三次缺失清单逐条相同",
    sameJSON(summaries.second.missingEntries, summaries.third.missingEntries), { second: second.missing.length, third: third.missing.length })
  check("真实旧库：31 条缺原件逐条带路径与原因，状态 BLOCKED 且不伪装 PASS",
    first.status === "BLOCKED" && first.exitCode === 2 && first.missing.length === 31
    && first.missing.every((item: any) => item.kind === "resource" && item.path && item.reason),
    { status: first.status, missing: first.missing.length })
  check("真实旧库：缺失分类为空（31 条全是资源原件缺失，不是会话/场景）",
    first.missing.every((item: any) => item.kind === "resource"), first.missing.map((item: any) => item.kind))
  check("真实旧库：未导入的旧库表逐条留名（不是静默略过）",
    Object.keys(first.sourceUnmigrated).length > 0, first.sourceUnmigrated)

  // ── 2. 旧源副本在迁移前后逐字节未变；两次运行的快照/导出逐字节相同 ─────────
  const copyHashesAfter = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, await sha256(join(realOld, name))])))
  check("真实旧库副本：迁移前后逐字节一致（迁移只读源）", sameJSON(copyHashesBefore, copyHashesAfter), copyHashesAfter)
  const exportHashes = await Promise.all([first, second].map(result => sha256(result.exportPath)))
  const snapshotHashes = await Promise.all([first, second].map(result => sha256(result.snapshotPath)))
  check("两次运行读到同一份数据：导出 JSON 与 SQLite 快照逐字节相同",
    exportHashes[0] === exportHashes[1] && snapshotHashes[0] === snapshotHashes[1], { exportHashes, snapshotHashes })

  // ── 3. 幂等：账本逐字节、产物树（除每次运行的时间戳文件外）逐字节 ──────────
  const ledgerPath = join(scratch, "run-a", "dsh/migrations/lyaup-old/ledger.json")
  const ledgerAfterSecond = await readFile(ledgerPath)
  const artifactsAfterSecond = await treeHashes(join(scratch, "run-a", "dsh"), isRunScoped)
  const fourth = await migrateLegacy(sqliteOptions(join(scratch, "run-a")))
  const ledgerAfterFourth = await readFile(ledgerPath)
  check("重复迁移稳定：账本在第三次运行后逐字节不变", ledgerAfterSecond.equals(ledgerAfterFourth), {
    sha256Second: createHash("sha256").update(ledgerAfterSecond).digest("hex"),
    sha256Fourth: createHash("sha256").update(ledgerAfterFourth).digest("hex"),
  })
  const freshInstall = await migrateLegacy(sqliteOptions(join(scratch, "run-fresh")))
  const artifactsFresh = await treeHashes(join(scratch, "run-fresh", "dsh"), isRunScoped)
  const ledgerFresh = await readJSON(join(scratch, "run-fresh", "dsh/migrations/lyaup-old/ledger.json"))
  const ledgerSecond = JSON.parse(ledgerAfterSecond.toString("utf8"))
  // 账本里记录的 `sceneRoot` 本来就该随新装目录不同（那是迁移绑定的目标），比较前归一化它，
  // 其余字段必须逐字相同；其余产物按字节比较。
  const normalizeLedger = (value: unknown) => JSON.stringify(value, (key, item) => key === "sceneRoot" ? "<SCENE_ROOT>" : item)
  const withoutLedger = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).filter(([key]) => key !== "migrations/lyaup-old/ledger.json"))
  const artifactDiff = {
    onlySecond: Object.keys(artifactsAfterSecond).filter(key => !(key in artifactsFresh)),
    onlyFresh: Object.keys(artifactsFresh).filter(key => !(key in artifactsAfterSecond)),
    changed: Object.keys(artifactsAfterSecond).filter(key => key in artifactsFresh && artifactsAfterSecond[key] !== artifactsFresh[key] && key !== "migrations/lyaup-old/ledger.json"),
  }
  const ledgerDiff = diffPaths(ledgerSecond, ledgerFresh).filter(item => !item.startsWith("/sceneRoot:"))
  evidence.ledgerDiffSecondVsFresh = ledgerDiff
  const freshReopened = await reopenAll(join(scratch, "run-fresh", "dsh"), ledgerFresh)
  evidence.freshInstallEvents = freshReopened.map(session => ({ id: session.id, ledger: session.ledgerEvents, reopened: session.reopenedEvents }))
  check("干净新装的账本 eventCount 与持久化日志长度一致（首次导入即对得上）",
    freshReopened.every(session => session.ledgerEvents === session.reopenedEvents),
    freshReopened.map(session => ({ id: session.id, ledger: session.ledgerEvents, reopened: session.reopenedEvents })))
  check("幂等：干净新装目录的首次迁移产物与老目录的第二次运行一致（只差目标 sceneRoot 这一项）",
    freshInstall.created === 6 && sameJSON(withoutLedger(artifactsAfterSecond), withoutLedger(artifactsFresh))
    && normalizeLedger(ledgerSecond) === normalizeLedger(ledgerFresh),
    { files: Object.keys(artifactsAfterSecond).length, freshFiles: Object.keys(artifactsFresh).length, freshCreated: freshInstall.created, fourthCreated: fourth.created, artifactDiff, ledgerDiff })

  // ── 4. 真实旧库：逐会话对账（源 message/part 全部有归属，文本逐字在事件里）──
  const ledger = await readJSON(ledgerPath)
  const exported = await readJSON(first.exportPath)
  const reopened = await reopenAll(join(scratch, "run-a", "dsh"), ledger)
  const accounting = reopened.map(session => accountSession(session.oldId, exported, ledger, session))
  evidence.accounting = accounting
  check("真实旧库：6/6 会话可用产品原生持久化后端重开，事件数与账本一致",
    accounting.length === 6 && accounting.every(item => item.eventCountMatches), accounting.map(item => ({ id: item.id, ledger: item.ledgerEvents, reopened: item.reopenedEvents })))
  check("真实旧库：源 message/part 在账本里逐条有归属（不丢记录）",
    accounting.every(item => item.ledgerHasAllMessages && item.ledgerHasAllParts),
    accounting.map(item => ({ oldId: item.oldId, messages: item.sourceMessages, parts: item.sourceParts })))
  check("真实旧库：源文本/工具输出逐字出现在迁移后的事件里（不丢内容）",
    accounting.every(item => item.unmatchedSourceStrings.length === 0),
    accounting.map(item => ({ oldId: item.oldId, sourceStrings: item.sourceStrings, unmatched: item.unmatchedSourceStrings.length })))
  check("真实旧库：tool part 数与迁移后的 tool-call / tool-result 数相等",
    accounting.every(item => item.toolCountsMatch), accounting.map(item => ({ oldId: item.oldId, kinds: item.sourceKinds, calls: item.toolCalls, results: item.toolResults })))
  check("真实旧库：旧会话历史目录原样成为新会话 cwd",
    accounting.every(item => typeof item.cwd === "string" && item.cwd.length > 0), accounting.map(item => ({ oldId: item.oldId, cwd: item.cwd })))
  const previousLedger = existsSync(DEFAULTS.previousLedger) ? await readJSON(DEFAULTS.previousLedger) : undefined
  evidence.previousRoundLedger = previousLedger ? { path: DEFAULTS.previousLedger, sessions: Object.fromEntries(Object.entries<any>(previousLedger.sessions).map(([oldId, entry]) => [oldId, entry.id])) } : null
  check("账号身份稳定：与历史轮次（同一真实副本、同一 accountKey）的迁移 ID 逐字相同",
    previousLedger !== undefined && Object.entries<any>(previousLedger.sessions).every(([oldId, entry]) => ledger.sessions[oldId]?.id === entry.id),
    { previousLedger: DEFAULTS.previousLedger })

  // ── 5. 账号路径兼容：迁进产品自己解析出的账号目录，身份在正式账号哈希下稳定 ──
  const productInstall = join(scratch, "product")
  const developerPaths = runtimePaths({ mode: "developer", root: productInstall })
  const developerRun = await migrateLegacy({ ...sqliteOptions(join(scratch, "developer-install")), dshHome: developerPaths.dshHome, sceneRoot: developerPaths.sceneRoot })
  const developerLedger = await readJSON(join(developerPaths.dshHome, "migrations/lyaup-old/ledger.json"))
  const developerReopened = await reopenAll(developerPaths.dshHome, developerLedger)
  check("账号路径兼容：migration 产物落在 runtimePaths 给出的 developer 账号目录下并可重开",
    existsSync(join(developerPaths.dshHome, "migrations/lyaup-old/ledger.json")) && developerReopened.length === 6
    && developerReopened.every(session => session.ledgerEvents === session.reopenedEvents) && developerRun.created === 6,
    { dshHome: developerPaths.dshHome, created: developerRun.created, reopened: developerReopened.length })

  // 正式账号的登录名不是 ID：迁移器的 accountKey 必须落在 safeId 字母表内。
  // 产品自己的正式账号身份是 runtimePaths().identity（账号哈希前缀），既稳定又是安全 ID；
  // 直接传邮箱会被 fail-closed 拒绝（下面第 5 节的这一条）而不是写出一个奇怪目录。
  const accountId = "real-account@example.invalid"
  let rawEmailRejected = false
  try { await migrateLegacy({ ...sqliteOptions(join(scratch, "raw-email")), accountKey: accountId, dshHome: join(scratch, "raw-email", "dsh"), sceneRoot: join(scratch, "raw-email", "scenes") }) }
  catch (error) { rawEmailRejected = String(error).includes("INVALID_ID") }
  const formalPaths = runtimePaths({ mode: "formal", accountId, root: productInstall })
  const formalPathsAgain = runtimePaths({ mode: "formal", accountId, root: productInstall })
  const formalOther = runtimePaths({ mode: "formal", accountId: "other-account@example.invalid", root: productInstall })
  const formalRun = await migrateLegacy({ ...sqliteOptions(join(scratch, "formal-install")), accountKey: formalPaths.identity, dshHome: formalPaths.dshHome, sceneRoot: formalPaths.sceneRoot })
  const formalLedger = await readJSON(join(formalPaths.dshHome, "migrations/lyaup-old/ledger.json"))
  check("账号路径兼容：正式账号目录 = accounts/<账号哈希前缀>，同一账号稳定、不同账号不撞，且登录名不会被当 ID",
    rawEmailRejected && formalPaths.identity === formalPathsAgain.identity && formalPaths.identity !== formalOther.identity
    && formalPaths.identity.length === 32 && formalPaths.root === join(productInstall, "accounts", formalPaths.identity)
    && formalRun.created === 6 && existsSync(join(formalPaths.dshHome, "migrations/lyaup-old/ledger.json")),
    { rawEmailRejected, identity: formalPaths.identity, otherIdentity: formalOther.identity, root: formalPaths.root, created: formalRun.created })
  const formalSessionIds = Object.values<any>(formalLedger.sessions).map(entry => entry.id).sort()
  const developerSessionIds = Object.values<any>(developerLedger.sessions).map(entry => entry.id).sort()
  check("账号身份进入迁移 ID：同一旧源在两个账号下得到不同原生会话",
    formalSessionIds.every(id => !developerSessionIds.includes(id)), { formalSessionIds, developerSessionIds })

  // ── 6. 恢复原件后重跑：派生工作区里放回一条 BLOCKED 资源 ────────────────────
  const missingResource = first.missing.find((item: any) => item.kind === "resource")!
  const libraryEntry = (library.resources ?? []).find((entry: any) => String(entry.resource_id ?? entry.id) === missingResource.id)
  const recoveryWorkspace = join(scratch, "recovery-workspace")
  const recoveryLibrary = join(scratch, "recovery-library.json")
  await writeFile(recoveryLibrary, JSON.stringify({ resources: [libraryEntry], tombstones: [] }), { mode: 0o444 })
  const recoveryOptions = (installRoot: string): MigrationOptions => ({
    sourceDatabase: join(realOld, "opencode-local.db"), sourceLabel: "lyaup-old", accountKey: "developer",
    dshHome: join(installRoot, "dsh"), sceneRoot: join(installRoot, "scenes"),
    resourceLibraries: [{ path: recoveryLibrary, workspaceRoot: recoveryWorkspace }],
  })
  const recoveryFirst = await migrateLegacy(recoveryOptions(join(scratch, "recovery")))
  const restoredPath = join(recoveryWorkspace, String(libraryEntry.path))
  check("恢复前：派生库里那条真实旧资源按原路径报 BLOCKED（报的是那一条路径）",
    recoveryFirst.status === "BLOCKED" && recoveryFirst.missing.length === 1
    && recoveryFirst.missing[0].kind === "resource" && recoveryFirst.missing[0].path === restoredPath,
    recoveryFirst.missing)
  await mkdir(join(restoredPath, ".."), { recursive: true })
  await writeFile(restoredPath, minimalGLB())
  const recoverySecond = await migrateLegacy(recoveryOptions(join(scratch, "recovery")))
  const recoveryMissingFile = await readJSON(join(scratch, "recovery", "scenes/resources/missing.json")).catch(() => undefined)
  check("找回原件后重跑：该资源导入成功、缺失清单清空、状态转 PASS",
    recoverySecond.status === "PASS" && recoverySecond.resources === 1 && recoverySecond.missing.length === 0
    && recoverySecond.resourceMetadataUpdated === 0,
    { resources: recoverySecond.resources, missing: recoverySecond.missing.length, status: recoverySecond.status })
  check("找回原件后重跑：资源库 missing 记录同步清空（不留过期 BLOCKED）",
    sameJSON((Array.isArray(recoveryMissingFile) ? recoveryMissingFile : recoveryMissingFile?.missing ?? recoveryMissingFile?.records ?? []), []),
    recoveryMissingFile)
  const recoveryThird = await migrateLegacy(recoveryOptions(join(scratch, "recovery")))
  check("找回原件后重跑：第三次运行稳定（0 新增、1 保持不变）",
    recoveryThird.created === 0 && recoveryThird.unchanged === 6 && recoveryThird.resources === 0,
    { created: recoveryThird.created, unchanged: recoveryThird.unchanged, resources: recoveryThird.resources })

  // ── 7. 真实旧 JSON 存储副本来跑 JSON 兼容布局 ──────────────────────────────
  const jsonCopy = join(scratch, "real-json")
  await cp(join(sourceDirectory, "storage"), join(jsonCopy, "opencode", "storage"), { recursive: true })
  const jsonParentRun = await migrateLegacy({
    sourceJsonDirectory: join(jsonCopy, "opencode"), sourceLabel: "lyaup-old-json", accountKey: "developer",
    dshHome: join(scratch, "json-parent", "dsh"), sceneRoot: join(scratch, "json-parent", "scenes"),
  } as any)
  check("JSON 旧存储：父目录里的 storage/ 不在兼容布局内 ⇒ 显式留名而不是静默 0 结果",
    jsonParentRun.missing.some((item: any) => item.reason.includes("UNRECOGNIZED_LAYOUT_DIRECTORY")),
    jsonParentRun.missing)
  const jsonRun = await migrateLegacy({
    sourceJsonDirectory: join(jsonCopy, "opencode", "storage"), sourceLabel: "lyaup-old-json", accountKey: "developer",
    dshHome: join(scratch, "json-run", "dsh"), sceneRoot: join(scratch, "json-run", "scenes"),
  } as any)
  const jsonRunSecond = await migrateLegacy({
    sourceJsonDirectory: join(jsonCopy, "opencode", "storage"), sourceLabel: "lyaup-old-json", accountKey: "developer",
    dshHome: join(scratch, "json-run", "dsh"), sceneRoot: join(scratch, "json-run", "scenes"),
  } as any)
  const preservedDiffs = (await readJSON(join(scratch, "json-run", "dsh/migrations/lyaup-old-json/projects-and-preferences.json"))).sessionDiffs as any[]
  const sourceDiffFiles = (await readdir(join(jsonCopy, "opencode", "storage", "session_diff"))).filter(name => name.endsWith(".json"))
  const diffPreserved = await Promise.all(sourceDiffFiles.map(async name => {
    const source = await readJSON(join(jsonCopy, "opencode", "storage", "session_diff", name))
    const id = basename(name, ".json")
    return sameJSON(preservedDiffs.find(entry => String(entry.id) === id)?.data ?? preservedDiffs.find(entry => String(entry.id) === id), source)
  }))
  check("JSON 旧存储：真实 session_diff 逐条保留在旧元数据产物里（内容逐字相同）",
    jsonRun.status === "PASS" && sourceDiffFiles.length > 0 && diffPreserved.every(Boolean),
    { files: sourceDiffFiles.length, preserved: preservedDiffs.length, diffPreserved })
  check("JSON 旧存储：重复迁移稳定（0 新增、0 缺失、计数一致）",
    jsonRunSecond.created === 0 && sameJSON(jsonRunSecond.sourceCounts, jsonRun.sourceCounts) && jsonRunSecond.missing.length === jsonRun.missing.length,
    { first: jsonRun.sourceCounts, second: jsonRunSecond.sourceCounts })

  // ── 8. G14 真实旧库（带附件）：附件字节逐字节保留 + 幂等 ────────────────────
  const attachment = await attachmentContract()
  evidence.attachments = attachment
  check("真实旧库（G14 夹具）：附件迁移后存储对象与原件 sha256 相同，且重跑不新增不丢失",
    attachment.accounts.every(item => item.missing.length === 0 && item.storedShaMatchesSource && item.second.created === 0
      && item.second.unchanged === 2 && item.ledgerEventsMatch && item.ledgerStableAfterRepair),
    attachment.accounts)
  check("真实旧库（G14 夹具）：夹具原件 sha256 未被迁移改写", attachment.fixtureUnchanged, attachment.fixtureHashes)

  // ── 9. 产物级复跑：`script/migrate.ts` 加载的是 dist/index.js（源码层跑通不等于产物层跑通）──
  // dist 是构建产物、没有 .d.ts；用非字面量说明符让 TS 不做静态解析（运行时由 Bun 正常加载）。
  const distSpecifier = "../dist/index.js"
  const dist = await import(distSpecifier) as { migrateLegacy: (options: MigrationOptions) => Promise<any> }
  const distFirst = await dist.migrateLegacy(sqliteOptions(join(scratch, "dist-run")))
  const distSecond = await dist.migrateLegacy(sqliteOptions(join(scratch, "dist-run")))
  const distLedger = await readJSON(join(scratch, "dist-run", "dsh/migrations/lyaup-old/ledger.json"))
  const distReopened = await reopenAll(join(scratch, "dist-run", "dsh"), distLedger)
  const distIds = Object.keys(distLedger.sessions).map(oldId => distLedger.sessions[oldId].id).sort()
  const sourceIds = Object.keys(ledger.sessions).map(oldId => ledger.sessions[oldId].id).sort()
  evidence.dist = {
    sha256: await sha256(join(DEV_ROOT, "packages/lyaup-migrations/dist/index.js")),
    first: { status: distFirst.status, created: distFirst.created, resources: distFirst.resources, scenes: distFirst.scenes, missing: distFirst.missing.length },
    second: { status: distSecond.status, created: distSecond.created, unchanged: distSecond.unchanged },
    reopened: distReopened.map(session => ({ id: session.id, ledger: session.ledgerEvents, reopened: session.reopenedEvents })),
  }
  check("产物级复跑（dist/index.js = script/migrate.ts 的真实入口）：与源码层读数一致、幂等、可重开",
    distFirst.created === 6 && distFirst.resources === 17 && distFirst.scenes === 2 && distFirst.missing.length === 31
    && distSecond.created === 0 && distSecond.unchanged === 6
    && distReopened.length === 6 && distReopened.every(session => session.ledgerEvents === session.reopenedEvents)
    && sameJSON(distIds, sourceIds),
    evidence.dist)

  evidence.finishedAt = new Date().toISOString()
  evidence.passed = checks.filter(item => item.ok).length
  evidence.failed = checks.filter(item => !item.ok).length
  await mkdir(join(evidencePath, ".."), { recursive: true })
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({
    evidence: evidencePath, passed: evidence.passed, failed: evidence.failed,
    sqlite: { first: summarize(first).created, second: summarize(second).unchanged, missing: first.missing.length, sessions: accounting.length },
    failedChecks: checks.filter(item => !item.ok).map(item => item.name),
    scratchKept: scratch,
  }, null, 2))
  if (evidence.failed) process.exitCode = 1
} catch (error) {
  evidence.error = String(error instanceof Error ? error.stack ?? error.message : error)
  await mkdir(join(evidencePath, ".."), { recursive: true })
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n")
  console.error(evidence.error)
  process.exitCode = 1
}

/** 最小合法 GLB：资源导入会校验 GLB 头，恢复夹具不能用随便的字节冒充模型。 */
function minimalGLB() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.write("glTF", 0, "ascii"); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(padded.length, 0); chunk.write("JSON", 4, "ascii")
  return Buffer.concat([header, chunk, padded])
}

/**
 * G14 夹具的两个真实账号各迁移两次。夹具自带一处已删除部署的附件绝对 URL，
 * 按 g14 门的同一原则**只改派生副本里的 URL 字段**，夹具原件只读并复核 sha256。
 */
async function attachmentContract() {
  const fixture = DEFAULTS.g14
  const root = join(scratch, "g14")
  const fixtureHashesBefore = Object.fromEntries(await Promise.all((["fixture-a", "fixture-b"] as const).map(async account => [account, await sha256(join(fixture, account, "old.db"))])))
  const accounts: any[] = []
  for (const account of ["fixture-a", "fixture-b"] as const) {
    const directory = join(root, account)
    await mkdir(directory, { recursive: true })
    const staged = join(directory, "old.db")
    await cp(join(fixture, account, "old.db"), staged)
    const script = [
      "import json,sqlite3,sys,os",
      "database,fixture=sys.argv[1],sys.argv[2]",
      "connection=sqlite3.connect(database)",
      "for row in connection.execute('select id,data from part').fetchall():",
      "    data=json.loads(row[1]); url=data.get('url')",
      "    if not isinstance(url,str) or not url.startswith('file://'): continue",
      "    candidate=os.path.join(fixture,'cross-directory',os.path.basename(url))",
      "    if not os.path.exists(candidate): continue",
      "    data['url']='file://'+candidate",
      "    connection.execute('update part set data=? where id=?',(json.dumps(data,ensure_ascii=False),row[0]))",
      "connection.commit();connection.close()",
    ].join("\n")
    const python = Bun.spawnSync(["python3", "-c", script, staged, fixture])
    if (python.exitCode !== 0) throw new Error(`G14_STAGE_FAILED: ${python.stderr.toString()}`)
    const libraryCopy = join(directory, "library.json")
    // 夹具的 library.json 指向已删除的 LyapunovDSH 部署；按 g14 门的同一原则只重定向路径，
    // 资源条目其余字段（resource_id/displayName/category）原样。
    const libraryData = await readJSON(join(fixture, account, "library.json"))
    libraryData.resources = (libraryData.resources ?? []).map((entry: any) => ({
      ...entry, path: String(entry.path ?? "").replace(/^.*\/cross-directory\//, `${fixture}/cross-directory/`),
    }))
    await writeFile(libraryCopy, JSON.stringify(libraryData), { mode: 0o444 })
    const input = await readJSON(join(fixture, account, "input.json"))
    const options: MigrationOptions = {
      sourceDatabase: staged, sourceLabel: "legacy-fixture", accountKey: account,
      dshHome: join(directory, "dsh"), sceneRoot: join(directory, "scenes"),
      resourceLibraries: [{ path: libraryCopy, workspaceRoot: fixture }],
    }
    const first = await migrateLegacy(options)
    const ledgerPath = join(directory, "dsh/migrations/legacy-fixture/ledger.json")
    const second = await migrateLegacy(options)
    const ledgerAfterSecond = await readFile(ledgerPath)
    const third = await migrateLegacy(options)
    const ledgerAfterThird = await readFile(ledgerPath)
    const ledger = await readJSON(ledgerPath)
    const reopened = await reopenAll(join(directory, "dsh"), ledger)
    const sourceSha = await sha256(join(fixture, "cross-directory/image.png"))
    const stored = await Promise.all(Object.values<any>(ledger.attachments).map(async entry => {
      const digest = String(entry.attachment?.attachmentId ?? "").replace(/^sha256:/, "")
      return digest ? await sha256(join(directory, "dsh/attachments/v1/objects", digest.slice(0, 2), digest)).catch(() => "") : ""
    }))
    accounts.push({
      account, expectedImageRefs: input.accountKey === account,
      first: { status: first.status, created: first.created, resources: first.resources, attachments: first.attachments, missing: first.missing },
      second: { status: second.status, created: second.created, unchanged: second.unchanged, attachments: second.attachments, missing: second.missing },
      third: { status: third.status, created: third.created, unchanged: third.unchanged, resources: third.resources },
      ledgerAttachments: Object.keys(ledger.attachments).length,
      sourceSha, storedSha: stored,
      storedShaMatchesSource: stored.length > 0 && stored.every(value => value === sourceSha),
      events: reopened.map(session => ({ id: session.id, ledger: session.ledgerEvents, reopened: session.reopenedEvents })),
      ledgerEventsMatch: reopened.every(session => session.ledgerEvents === session.reopenedEvents),
      // 首次运行会登记附件修补台账（attachmentRepairs），因此第 1↔2 次账本必然不同；
      // 幂等要看的是第 2↔3 次：台账不再新增、时间戳不被刷新。
      ledgerStableAfterRepair: ledgerAfterSecond.equals(ledgerAfterThird),
      missing: first.missing,
    })
  }
  const fixtureHashesAfter = Object.fromEntries(await Promise.all((["fixture-a", "fixture-b"] as const).map(async account => [account, await sha256(join(fixture, account, "old.db"))])))
  return { accounts, fixtureHashes: fixtureHashesAfter, fixtureUnchanged: sameJSON(fixtureHashesBefore, fixtureHashesAfter) }
}
