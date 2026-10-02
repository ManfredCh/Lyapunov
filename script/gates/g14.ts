/**
 * G14（合同 §6.2 / §4.6）：两会话含 Tool 结果/图像、跨目录资源、两个账号的旧数据迁移两次。
 *
 * 通过条件：ID/附件/层级可重开并继续；重复迁移无重复；旧原件保留；缺失逐条报告。
 *
 * 本门只做一件事：拿**合同指定的真实夹具**，按 `input.json` 的原始 options 调**真实迁移器**
 * `migrateLegacy`（`packages/lyaup-migrations/src/index.ts`），每个账号跑两次，然后把真实读数
 * （迁移器返回计数、落盘产物、产品自身持久化后端重开、附件字节、资源索引、缺失条目、旧原件哈希）
 * 逐条写进 detail。不新建测试框架、不复制迁移逻辑、不伪造计数，也不改夹具原件。
 *
 * 夹具自带三处指向**已删除** `LyapunovDSH` 仓库的路径，本门按同一原则（只重定向路径，不改数据语义）
 * 显式、最小地处理，绝不回写夹具原件：
 * 1. options 的 `sourceDatabase`/`resourceLibraries` 按交付要求改指 DSH 下真实夹具；`dshHome`/`sceneRoot`
 *    改指本次运行的临时输出根（每次清空），见 `optionsFor`；
 * 2. `library.json` 内部的资源绝对路径改指夹具 `cross-directory/wood.glb`（写临时副本，资源条目其余字段原样）；
 * 3. 旧 DB **数据内部**的附件 `part.url` 指向旧部署绝对路径，而旧部署目录已删除、夹具把同一份
 *    `image.png` 保存在 `cross-directory/`。本门把 `old.db` **复制**到临时目录，只把这一个 URL 字段
 *    重写到夹具真实文件（见 `stageFixtureInputs`），夹具 `old.db` 本身只读且逐字节校验未被改动；
 *    这样"夹具自身的路径不完整"就不会冒充"迁移器不支持附件"，附件相关的真实读数才有意义。
 */
import { Context } from "@deepseek-ai/cordis"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import { logPath } from "@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts"
import { SessionId } from "@deepseek-ai/dsh-session"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { migrateLegacy, type MigrationOptions } from "../../packages/lyaup-migrations/src/index.ts"
import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
/**
 * 夹具根（只读）。DEV-027 F22：此前是**写死的开发仓绝对路径**——干净 checkout / 别的机器上必然 ENOENT，
 * 且表现成"迁移失败"而不是"夹具未配置"。现在可配置：`LYAPUNOV_G14_FIXTURE_ROOT` 优先，未设置时
 * 回落到本机开发仓的历史夹具（保持今天的行为）；**路径不存在 ⇒ 门返回 BLOCKED 并点名缺哪个绝对路径**
 * （照本仓"未设置就不造值"的惯例，不伪造夹具）。
 */
export const FIXTURE_ROOT = process.env.LYAPUNOV_G14_FIXTURE_ROOT
  ?? "/home/s18/WS/Lyapunov/DSH/bugfixHistory/refactor-execution/B-migration-evidence/fixture-2026-09-06T01-48-11-221Z"
/** 迁移的临时输出根：运行期数据，不进发布。每次运行前整个清空，确保不从旧状态继承。 */
export const RUNTIME_ROOT = join(PRODUCT_ROOT, ".runtime/goal-verify/g14")

export const ACCOUNTS = ["fixture-a", "fixture-b"] as const
export type Account = typeof ACCOUNTS[number]

/** 夹具自带的历史 Data Root（已随 `LyapunovDSH` 仓库删除）。 */
const LEGACY_ROOT = "/home/s18/WS/Lyapunov/LyapunovDSH"
/** 夹具账号的预期读数来自 `native-inspect.json` / `first.json` / `second.json`（历史回执，仅作预期值）。 */
export const EXPECTED = {
  sessions: 2, messages: 6, attachments: 2, resources: 1, sourceRows: 11, toolResults: 3, interruptedTurns: 1,
  secondCreated: 0, secondUnchanged: 2, secondResources: 0, secondAttachments: 2,
} as const

interface ArtifactSnapshot { size: number; sha256: string }
export interface MissingEntry { kind: string; id: string; path?: string; reason: string }

/**
 * DEV-027 F24：`missing_entries_reported_individually` 此前只在**空集**上成立
 * （判据要求 `missingResources.length === 0`）——非空集时它只报"有缺失"，并不检查
 * **每条是否被逐条报全**。这里把"逐条完整性"变成可判定的真判据：
 * 每条必须有非空 `kind`/`id`/`reason`，且 `resource`/`attachment` 类必须带 `path`
 * （缺字段＝报告不可复算 ⇒ 判失败）。空集**也算**通过（"没有缺失"是合法读数），
 * 但不再是唯一能通过的形态。
 */
export function missingReportCoverage(entries: readonly MissingEntry[]): { ok: boolean; incomplete: MissingEntry[] } {
  const incomplete = entries.filter(item =>
    !String(item.kind ?? "").trim()
    || !String(item.id ?? "").trim()
    || !String(item.reason ?? "").trim()
    || ((item.kind === "resource" || item.kind === "attachment") && !String(item.path ?? "").trim()))
  return { ok: incomplete.length === 0, incomplete }
}

interface ReopenedSession { id: string; path: string; eventCount: number; tools: number; images: number; lastTurnEnd: string; messages: number; surfaceReplaces: number }
interface AttachmentCheck { attachmentId: string; mediaType: string; storedSha: string; sourceSha: string; byteLength: number; declaredBytes: number }

interface MigrationRun {
  result: Awaited<ReturnType<typeof migrateLegacy>>
  options: MigrationOptions
  /** 该账号 dshHome 的产物快照（相对 dshHome 的路径 → 大小 + sha256）。 */
  artifacts: Map<string, ArtifactSnapshot>
  /** sceneRoot 下资源索引里真实存在的记录。 */
  resourceRecords: Array<{ resourceId: string; version: number; name: string; originalUri: string; category: string | undefined; deleted: boolean }>
  ledgerSessions: Record<string, { id: string }>
  ledgerMessages: Record<string, string>
  ledgerAttachments: Record<string, { type: string; attachment: { attachmentId?: string; mediaType?: string; name?: string } }>
  ledgerResources: Record<string, { resourceId: string; version: number }>
  /** 用产品自身 JSONL 持久化后端重开每个迁移会话的读数。 */
  reopened: ReopenedSession[]
  /** 事件里的 image 块 → 存储对象 → 与夹具原件比 sha256。 */
  attachmentChecks: AttachmentCheck[]
  /** 迁移器真实返回的缺失条目。 */
  missing: MissingEntry[]
  /** 迁移器自己落盘的 result.json（权威结果文件）。 */
  persisted: { status: string; exitCode: number; created: number; unchanged: number; resources: number; attachments: number }
}

interface FixtureOutcome {
  account: Account
  first: MigrationRun
  second: MigrationRun
  /** 第二个账号跑之前/之后，第一个账号产物集合的指纹，用于验证多账号不串。 */
  firstArtifactsBefore: string
  firstArtifactsAfter: string
  /** 派生输入里改写的附件 URL 条目（见 stageFixtureInputs）。 */
  rewrites: string[]
}

async function sha256File(path: string | URL): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function fileStamp(path: string): Promise<{ exists: boolean; size: number; mtimeMs: number; sha256: string | null }> {
  try {
    const value = await stat(path)
    return { exists: true, size: value.size, mtimeMs: value.mtimeMs, sha256: await sha256File(path) }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, sha256: null }
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

async function snapshotTree(root: string): Promise<Map<string, ArtifactSnapshot>> {
  const snapshot = new Map<string, ArtifactSnapshot>()
  for (const path of await walk(root)) {
    const value = await stat(path)
    snapshot.set(path.slice(root.length + 1), { size: value.size, sha256: await sha256File(path) })
  }
  return snapshot
}

/** 产物集合差异（新增 +~ 改动 -删除）；无差异返回空数组。 */
function diffSnapshot(before: Map<string, ArtifactSnapshot>, after: Map<string, ArtifactSnapshot>): string[] {
  const diffs: string[] = []
  for (const [key, value] of after) {
    const previous = before.get(key)
    if (!previous) diffs.push(`+${key}`)
    else if (previous.sha256 !== value.sha256 || previous.size !== value.size) diffs.push(`~${key}`)
  }
  for (const key of before.keys()) if (!after.has(key)) diffs.push(`-${key}`)
  return diffs
}

const fingerprint = (artifacts: Map<string, ArtifactSnapshot>) => JSON.stringify([...artifacts].map(([key, value]) => [key, value.sha256]).sort())
const count = (value: Record<string, unknown>) => Object.keys(value).length

/**
 * 派生一份**可解的迁移输入**：把夹具 `old.db` 复制到临时目录，只重写数据内部指向已删除
 * `LyapunovDSH` 部署的附件 URL（`part.data.url` → 夹具 `cross-directory/<basename>`）。
 *
 * 为什么需要：夹具的 `part.url` 是旧部署的绝对路径，旧部署目录已随仓库删除，而同一份文件名
 * 的字节就在夹具 `cross-directory/` 里。若不重写，迁移器只能如实报 2 条 attachment MISSING，
 * 本门就无法验证"附件可重开"这一合同条件。
 *
 * 边界（不越界的地方）：
 * - 夹具原件只读：写的是临时副本，且运行后用 sha256 复核夹具 `old.db` 未变；
 * - 只改 URL 字段，会话/消息/part 的 id、时间、角色、tool 状态、文本内容原样；
 * - 只改文件已不存在、且夹具内存在同名原件的 URL；其余 URL 原样保留（仍会被如实报 MISSING）。
 * 返回派生路径与逐条改写记录。
 */
async function stageFixtureInputs(runDirectory: string, account: Account): Promise<{ database: string; rewrites: string[] }> {
  const sourceDatabase = join(FIXTURE_ROOT, account, "old.db")
  const staged = join(runDirectory, `${account}-old.db`)
  await cp(sourceDatabase, staged)
  const script = [
    "import json,sqlite3,sys,os",
    "database,fixture=sys.argv[1],sys.argv[2]",
    "connection=sqlite3.connect(database)",
    "rewrites=[]",
    "for row in connection.execute('select id,data from part').fetchall():",
    "    data=json.loads(row[1])",
    "    url=data.get('url')",
    "    if not isinstance(url,str) or not url.startswith('file://'): continue",
    "    candidate=os.path.join(fixture,'cross-directory',os.path.basename(url))",
    "    if not os.path.exists(candidate): continue",
    "    data['url']='file://'+candidate",
    "    connection.execute('update part set data=? where id=?',(json.dumps(data,ensure_ascii=False),row[0]))",
    "    rewrites.append(row[0]+' -> '+candidate)",
    "connection.commit(); connection.close()",
    "print(json.dumps(rewrites,ensure_ascii=False))",
  ].join("\n")
  const rewrites = await new Promise<string[]>((resolveRewrites, reject) => {
    const child = spawn("python3", ["-c", script, staged, FIXTURE_ROOT], { stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    child.stdout.on("data", value => { out += value })
    child.stderr.on("data", value => { err += value })
    child.once("exit", code => code === 0 ? resolveRewrites(JSON.parse(out) as string[]) : reject(new Error(`FIXTURE_STAGE_FAILED: ${err}`)))
  })
  return { database: staged, rewrites }
}

/**
 * 按 `input.json`（**原始权威 options**）构造本次迁移的 options。
 *
 * 夹具的三处缺陷在此显式、最小地重定向，其余字段原样透传：
 * 1. `sourceDatabase`/`resourceLibraries[].path`/`workspaceRoot` 指向已删除的 `LyapunovDSH`
 *    仓库 → 改指 DSH 下真实夹具（`sourceDatabase` 用 `stageFixtureInputs` 派生副本，见其注释）；
 * 2. `dshHome`/`sceneRoot` 指向夹具内的历史输出 → 改指本次运行的临时输出根（每次清空）；
 * 3. `library.json` 内部的资源绝对路径同样指向已删除仓库 → 写一份临时副本把路径改指夹具
 *    真实文件；资源条目本身（resource_id/displayName/category/kind）原样不动。
 */
async function optionsFor(account: Account, runDirectory: string, sourceDatabase: string): Promise<MigrationOptions> {
  const raw = JSON.parse(await readFile(join(FIXTURE_ROOT, account, "input.json"), "utf8")) as MigrationOptions
  const library = JSON.parse(await readFile(join(FIXTURE_ROOT, account, "library.json"), "utf8")) as { resources?: Array<Record<string, unknown>> }
  library.resources = (library.resources ?? []).map(entry => ({ ...entry, path: String(entry.path ?? "").replace(/^.*\/cross-directory\//, `${FIXTURE_ROOT}/cross-directory/`) }))
  const libraryCopy = join(runDirectory, `${account}-library.json`)
  await writeFile(libraryCopy, JSON.stringify(library))
  return {
    ...raw,
    sourceDatabase,
    dshHome: join(runDirectory, `${account}-dsh`),
    sceneRoot: join(runDirectory, `${account}-scenes`),
    resourceLibraries: [{ path: libraryCopy, workspaceRoot: FIXTURE_ROOT }],
  }
}

async function readPersisted(home: string): Promise<MigrationRun["persisted"]> {
  const value = JSON.parse(await readFile(join(home, "migrations/legacy-fixture/result.json"), "utf8"))
  return { status: value.status, exitCode: value.exitCode, created: value.created, unchanged: value.unchanged, resources: value.resources, attachments: value.attachments }
}

async function readResourceRecords(sceneRoot: string): Promise<MigrationRun["resourceRecords"]> {
  const index = JSON.parse(await readFile(join(sceneRoot, "resources/index.json"), "utf8")) as { records: Array<Record<string, any>> }
  return index.records.map(record => ({
    resourceId: String(record.ref.resourceId), version: Number(record.ref.version), name: String(record.name),
    originalUri: String(record.ref.original.uri), category: record.category, deleted: Boolean(record.deletedAt),
  }))
}

/**
 * 用**产品自身的 JSONL 持久化后端**重开每个迁移会话：存储契约不满足就抛错，
 * 不是"文件在不在"这种弱检查。重开后按事件类型统计可见 Tool 结果、image 块与最终 turn 状态。
 */
async function reopenSessions(home: string, ledger: { sessions: Record<string, { id: string }> }): Promise<ReopenedSession[]> {
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root: join(home, "sessions"), compression: "zstd" })
  const out: ReopenedSession[] = []
  try {
    for (const entry of Object.values(ledger.sessions)) {
      const id = entry.id
      const handle = await ctx.sessionPersistence.open(SessionId(id), "read")
      try {
        const { events } = await handle.read()
        let tools = 0, images = 0, lastTurnEnd = "", messages = 0, surfaceReplaces = 0
        for (const event of events as readonly { type: string; surfaceOp?: unknown; data?: any }[]) {
          if (event.surfaceOp) surfaceReplaces++
          if (event.type === "tool/result") tools++
          if (event.type === "turn/end") lastTurnEnd = String(event.data?.reason?.kind ?? "")
          if (event.type === "user/message" || event.type === "assistant/message") messages++
          const content = event.type === "user/message" ? event.data?.content : event.type === "assistant/message" ? event.data?.message?.content : undefined
          if (Array.isArray(content)) images += content.filter((block: { type?: string }) => block.type === "image").length
          if (event.type === "tool/result" && Array.isArray(event.data?.message?.content)) {
            for (const wrapper of event.data.message.content) if (Array.isArray(wrapper?.content)) images += wrapper.content.filter((block: { type?: string }) => block.type === "image").length
          }
        }
        out.push({ id, path: logPath(join(home, "sessions"), handle.header.cwd, SessionId(id), "zstd"), eventCount: events.length, tools, images, lastTurnEnd, messages, surfaceReplaces })
      } finally { await handle.close() }
    }
  } finally { await fiber.dispose() }
  return out
}

/** 附件字节核对：ledger 里的附件 → 存储对象 → 与夹具 image.png 逐字节比 sha256。 */
async function checkAttachments(home: string, ledger: MigrationRun["ledgerAttachments"], sourceImage: string): Promise<AttachmentCheck[]> {
  const sourceSha = await sha256File(sourceImage).catch(() => "")
  const out: AttachmentCheck[] = []
  for (const entry of Object.values(ledger)) {
    const attachmentId = String(entry.attachment?.attachmentId ?? "")
    // 原生附件 id 形如 `sha256:<64hex>`，对象文件按裸 digest 分片存放（LocalAttachmentStore）。
    const digest = attachmentId.replace(/^sha256:/, "")
    if (!/^[a-f0-9]{64}$/.test(digest)) continue
    const stored = join(home, "attachments/v1/objects", digest.slice(0, 2), digest)
    out.push({
      attachmentId, mediaType: String(entry.attachment?.mediaType ?? ""),
      storedSha: await sha256File(stored).catch(() => ""), sourceSha,
      byteLength: (await stat(stored).catch(() => ({ size: 0 }))).size,
      declaredBytes: Number((entry.attachment as { bytes?: number })?.bytes ?? Number.NaN),
    })
  }
  return out
}

async function runOnce(options: MigrationOptions): Promise<MigrationRun> {
  const result = await migrateLegacy(options)
  const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8"))
  return {
    result, options,
    artifacts: await snapshotTree(options.dshHome),
    resourceRecords: await readResourceRecords(options.sceneRoot),
    ledgerSessions: ledger.sessions ?? {},
    ledgerMessages: ledger.messages ?? {},
    ledgerAttachments: ledger.attachments ?? {},
    ledgerResources: ledger.resources ?? {},
    reopened: await reopenSessions(options.dshHome, ledger),
    attachmentChecks: await checkAttachments(options.dshHome, ledger.attachments ?? {}, join(FIXTURE_ROOT, "cross-directory/image.png")),
    missing: result.missing as MissingEntry[],
    persisted: await readPersisted(options.dshHome),
  }
}

function renderMissing(entries: MissingEntry[]): string {
  if (!entries.length) return "无"
  return entries.map(item => `${item.kind}:${item.id}${item.path ? ` @ ${item.path}` : ""} ← ${item.reason}`).join(" || ")
}

/**
 * G14：两个账号各真实迁移两次，并对落盘产物、原生重开、附件字节、资源引用、缺失条目、
 * 旧原件哈希逐条给真实读数。
 */
export async function gateG14(): Promise<GateResult> {
  // DEV-027 F22：夹具根是**写死的开发仓绝对路径**。路径不存在时，此前会一路跑到
  // `stageFixtureInputs`/`fileStamp` 才抛 ENOENT，薄入口把它打成 `FAIL G14/exception` + exit 1
  // ——读起来像"迁移器坏了"，其实是"夹具没配"。前置成 BLOCKED 并**点名缺哪个绝对路径**：
  // ①不伪造夹具读数；②不把环境缺失记成产品缺陷；③干净 checkout / 别的机器上得到可执行的下一步。
  const missingFixturePaths = ACCOUNTS
    .map(account => join(FIXTURE_ROOT, account, "old.db"))
    .filter(path => !existsSync(path))
  if (missingFixturePaths.length) {
    return {
      gate: "G14",
      checks: [],
      blocked: `旧数据夹具不存在：${missingFixturePaths.join("、")}。夹具根=${FIXTURE_ROOT}`
        + `（来源=${process.env.LYAPUNOV_G14_FIXTURE_ROOT ? "环境变量 LYAPUNOV_G14_FIXTURE_ROOT" : "内置的开发仓默认路径"}）。`
        + "请把 LYAPUNOV_G14_FIXTURE_ROOT 指向含 <account>/old.db 的真实旧数据夹具根后重跑；"
        + "本门不在夹具缺失时伪造读数，也不把 ENOENT 报成迁移失败。",
    }
  }
  const checks: Check[] = []
  const runDirectory = join(RUNTIME_ROOT, `run-${Date.now()}`)
  await rm(RUNTIME_ROOT, { recursive: true, force: true })
  await mkdir(runDirectory, { recursive: true })

  const originals = new Map<Account, Record<"db" | "wal" | "shm", { exists: boolean; size: number; mtimeMs: number; sha256: string | null }>>()
  for (const account of ACCOUNTS) {
    const database = join(FIXTURE_ROOT, account, "old.db")
    originals.set(account, { db: await fileStamp(database), wal: await fileStamp(`${database}-wal`), shm: await fileStamp(`${database}-shm`) })
  }
  const fixtureBefore = await snapshotTree(FIXTURE_ROOT)

  try {
    const outcomes: FixtureOutcome[] = []
    for (const account of ACCOUNTS) {
      // 派生的可解输入（见 stageFixtureInputs 注释）；夹具 old.db 只读，且下面第 8 条会逐字节复核未变。
      const staged = await stageFixtureInputs(runDirectory, account)
      const options = await optionsFor(account, runDirectory, staged.database)
      const first = await runOnce(options)
      const firstArtifactsBefore = fingerprint(first.artifacts)

      const second = await runOnce(options)
      outcomes.push({ account, first, second, firstArtifactsBefore, firstArtifactsAfter: fingerprint(first.artifacts), rewrites: staged.rewrites })

      const base = { sessions: count(first.ledgerSessions), messages: count(first.ledgerMessages), attachments: count(first.ledgerAttachments), resources: count(first.ledgerResources) }
      const opened = second.reopened
      const toolResults = first.reopened.reduce((sum, row) => sum + row.tools, 0)
      const imageBlocks = first.reopened.reduce((sum, row) => sum + row.images, 0)
      const interrupted = first.reopened.filter(row => row.lastTurnEnd === "interrupted").length

      // 1) 首次迁移的真实产物读数：迁移器返回 + ledger + 落盘 result.json 三方一致。
      checks.push({
        name: `${account}_first_migration_artifacts`,
        ok: first.result.created === EXPECTED.sessions && base.sessions === EXPECTED.sessions && base.messages === EXPECTED.messages
          && base.attachments === EXPECTED.attachments && base.resources === EXPECTED.resources
          && first.result.sourceCounts.session === EXPECTED.sessions && first.result.sourceCounts.message === EXPECTED.messages && first.result.sourceCounts.part === EXPECTED.sourceRows
          && first.persisted.created === first.result.created && first.persisted.resources === first.result.resources && first.persisted.attachments === first.result.attachments,
        detail: `created=${first.result.created} unchanged=${first.result.unchanged} 会话=${base.sessions} 消息=${base.messages} 附件=${base.attachments} 资源=${base.resources} interruptedTools=${first.result.interruptedTools} status=${first.result.status} exitCode=${first.result.exitCode} sourceCounts=${JSON.stringify(first.result.sourceCounts)} sourceUnchanged=${first.result.sourceUnchanged}；落盘 result.json(created=${first.persisted.created},resources=${first.persisted.resources},attachments=${first.persisted.attachments},status=${first.persisted.status})；会话ID=[${Object.values(first.ledgerSessions).map(entry => entry.id).join(",")}]`,
      })

      // 2) ID/附件/层级可重开并继续：产品自身持久化后端真实重开 + 事件构成。
      checks.push({
        name: `${account}_sessions_reopen_with_tools_and_images`,
        ok: first.reopened.length === EXPECTED.sessions && first.reopened.every(row => row.eventCount > 0 && row.messages > 0)
          && toolResults === EXPECTED.toolResults && imageBlocks === EXPECTED.attachments && interrupted === EXPECTED.interruptedTurns,
        detail: `用产品 JSONL 后端重开=${first.reopened.length}/${EXPECTED.sessions}；逐会话 events=[${first.reopened.map(row => row.eventCount).join(",")}] 可见消息=[${first.reopened.map(row => row.messages).join(",")}] tool/result=[${first.reopened.map(row => row.tools).join(",")}] image块=[${first.reopened.map(row => row.images).join(",")}] turn/end=[${first.reopened.map(row => row.lastTurnEnd).join(",")}]；合计 tool/result=${toolResults} image=${imageBlocks} interrupted会话=${interrupted}；样例路径=${first.reopened[0]?.path ?? "n/a"}`,
      })

      // 3) 附件真实落盘且与原件逐字节相同。
      const byteIdentical = first.attachmentChecks.filter(row => row.storedSha.length === 64 && row.storedSha === row.sourceSha && row.mediaType === "image/png").length
      checks.push({
        name: `${account}_attachments_byte_identical`,
        ok: first.attachmentChecks.length === EXPECTED.attachments && byteIdentical === EXPECTED.attachments,
        detail: `附件块=${first.attachmentChecks.length} 逐字节相同=${byteIdentical}；逐条=[${first.attachmentChecks.map(row => `${row.attachmentId.slice(0, 12)}… mediaType=${row.mediaType} bytes=${row.byteLength} 存储sha=${row.storedSha.slice(0, 16)}… 原件sha=${row.sourceSha.slice(0, 16)}…`).join(" | ")}]`,
      })

      // 4) 重复迁移无重复：第二次真实读数 + 产物集合逐文件 sha256 + 会话/资源 ID 映射 + 缺失集合。
      const artifactDiff = diffSnapshot(first.artifacts, second.artifacts)
      // 排除项都属"运行产物"，不是被迁移的数据：
      //  - source-*：合同 §4.6-3 要求的一致性快照（文件名含当次时间戳），每次新增是规定行为；
      //  - ledger.json / result.json：迁移器的运行记录。result 内本就含当次 snapshotPath/exportPath，
      //    且 created/unchanged 两个计数在第二次按定义应当反转（2/0 → 0/2）。
      // 被迁移数据的稳定性由下方逐项断言保证（数量、映射逐字节、事件数、缺失集合、计数方向），
      // 故这里排除的是"运行记录"而非"数据"，不放宽任何与重复创建相关的判据。
      const unexpected = artifactDiff.filter(item => !/^\+migrations\/legacy-fixture\/source-/.test(item)
        && !/^migrations\/legacy-fixture\/(ledger|result)\.json$/.test(item.replace(/^[+~]/, "")))
      const missingStable = second.missing.length === first.missing.length
      checks.push({
        name: `${account}_second_run_creates_no_duplicates`,
        ok: second.result.created === EXPECTED.secondCreated && second.result.unchanged === EXPECTED.secondUnchanged
          && count(second.ledgerSessions) === base.sessions && count(second.ledgerResources) === base.resources && count(second.ledgerAttachments) === base.attachments
          && JSON.stringify(second.ledgerSessions) === JSON.stringify(first.ledgerSessions)
          && JSON.stringify(second.ledgerResources) === JSON.stringify(first.ledgerResources)
          && second.reopened.length === EXPECTED.sessions && second.reopened.every((row, index) => row.eventCount === first.reopened[index]?.eventCount)
          && second.persisted.created === EXPECTED.secondCreated && second.persisted.unchanged === EXPECTED.secondUnchanged
          && missingStable && unexpected.length === 0,
        detail: `第二次 created=${second.result.created} unchanged=${second.result.unchanged} updated=${second.result.updated} resources=${second.result.resources} attachments=${second.result.attachments} repairedSessions=${second.result.repairedSessions}；数量 会话=${base.sessions}→${count(second.ledgerSessions)} 消息=${base.messages}→${count(second.ledgerMessages)} 附件=${base.attachments}→${count(second.ledgerAttachments)} 资源=${base.resources}→${count(second.ledgerResources)}；会话ID映射与资源映射逐字节相同=${JSON.stringify(second.ledgerSessions) === JSON.stringify(first.ledgerSessions) && JSON.stringify(second.ledgerResources) === JSON.stringify(first.ledgerResources)}；重开 events=[${opened.map(row => row.eventCount).join(",")}] 对首次=[${first.reopened.map(row => row.eventCount).join(",")}]；缺失集合稳定=${missingStable}（首次${first.missing.length}条→二次${second.missing.length}条）；产物差异=[${artifactDiff.join(",") || "无"}]（source-* 一致性快照按合同 §4.6-3 每次新增，不计重复）非快照差异=[${unexpected.join(",") || "无"}]`,
      })
    }

    const [a, b] = outcomes as [FixtureOutcome, FixtureOutcome]

    // 5) 多账号不串：两个账号的 dshHome/sceneRoot 独立、会话ID不相交、跑 B 不改动 A 的产物。
    const idsA = Object.values(a.first.ledgerSessions).map(entry => entry.id)
    const idsB = Object.values(b.first.ledgerSessions).map(entry => entry.id)
    const overlap = idsA.filter(id => idsB.includes(id))
    checks.push({
      name: "two_accounts_do_not_cross",
      ok: overlap.length === 0 && a.first.options.dshHome !== b.first.options.dshHome && a.first.options.sceneRoot !== b.first.options.sceneRoot
        && a.firstArtifactsBefore === a.firstArtifactsAfter && count(a.first.ledgerAttachments) === count(b.first.ledgerAttachments),
      detail: `账号A dshHome=${a.first.options.dshHome} sceneRoot=${a.first.options.sceneRoot}；账号B dshHome=${b.first.options.dshHome} sceneRoot=${b.first.options.sceneRoot}；会话ID A=[${idsA.join(",")}] B=[${idsB.join(",")}] 交集=[${overlap.join(",") || "无"}]；跑完B后A的产物逐字节相同=${a.firstArtifactsBefore === a.firstArtifactsAfter}（A产物文件数=${a.first.artifacts.size}）`,
    })

    // 6) 跨目录资源被正确引用/保留：索引引用 + CAS 字节 + 夹具原件哈希三方一致。
    const woodSha = await sha256File(join(FIXTURE_ROOT, "cross-directory/wood.glb"))
    const imageSha = await sha256File(join(FIXTURE_ROOT, "cross-directory/image.png"))
    const resourceRows: string[] = []
    let resourcesOk = true
    for (const outcome of outcomes) {
      const record = outcome.first.resourceRecords[0]
      const mapped = outcome.first.ledgerResources["resource-same"]
      const storedSha = record?.originalUri.startsWith("file:") ? await sha256File(fileURLToPath(record.originalUri)).catch(() => "") : ""
      const ok = outcome.first.resourceRecords.length === EXPECTED.resources && record !== undefined && mapped !== undefined
        && mapped.resourceId === record.resourceId && record.name === "夹具木块" && record.category === "object" && record.deleted === false
        && storedSha === woodSha
      if (!ok) resourcesOk = false
      resourceRows.push(`${outcome.account}: 索引记录=${outcome.first.resourceRecords.length} resourceId=${record?.resourceId} v${record?.version} name=${record?.name} category=${record?.category} deleted=${record?.deleted} 旧ID映射=${JSON.stringify(mapped)} 存储sha=${storedSha.slice(0, 16)}… 夹具wood.glb sha=${woodSha.slice(0, 16)}… 相等=${storedSha === woodSha} 索引原件uri=${record?.originalUri}`)
    }
    checks.push({
      name: "cross_directory_resource_retained",
      ok: resourcesOk && imageSha.length === 64,
      detail: `${resourceRows.join(" || ")}；跨目录原件（只读）wood.glb sha=${woodSha.slice(0, 16)}… bytes=${(await stat(join(FIXTURE_ROOT, "cross-directory/wood.glb"))).size} image.png sha=${imageSha.slice(0, 16)}… bytes=${(await stat(join(FIXTURE_ROOT, "cross-directory/image.png"))).size}`,
    })

    // 7) 缺失逐条报告：把两次运行迁移器返回的缺失条目原样打印。
    // 「有缺失」不判失败（如实上报正是合同要求）；判失败的是①缺失集合在重复迁移中膨胀、
    // ②资源已经真实导入并保留后仍被报成 resource 缺失（不得虚构缺失条目）。
    const missingRows = outcomes.map(outcome => {
      const all = [...outcome.first.missing, ...outcome.second.missing]
      return `${outcome.account}: 合计${all.length}条（首次${outcome.first.missing.length}/二次${outcome.second.missing.length}，膨胀=${outcome.second.missing.length !== outcome.first.missing.length}）逐条=[${renderMissing(all)}]`
    })
    const missingResources = outcomes.flatMap(outcome => [...outcome.first.missing, ...outcome.second.missing]).filter(item => item.kind === "resource")
    const missingGrew = outcomes.some(outcome => outcome.second.missing.length !== outcome.first.missing.length)
    // DEV-027 F24：非空集也要**逐条报全**（kind/id/reason + resource/attachment 的 path），
    // 否则报告不可复算。判据同时保留"资源已导入却仍报缺失"与"重复迁移膨胀"两条否定条件。
    const allMissing = outcomes.flatMap(outcome => [...outcome.first.missing, ...outcome.second.missing])
    const coverage = missingReportCoverage(allMissing)
    checks.push({
      name: "missing_entries_reported_individually",
      ok: coverage.ok && missingResources.length === 0 && !missingGrew,
      detail: `${missingRows.join(" || ")}；**逐条完整性**=${coverage.ok ? "完整（每条 kind/id/reason 齐，resource/attachment 带 path）" : `缺字段 ${coverage.incomplete.length} 条：${renderMissing(coverage.incomplete)}`}；资源已导入并保留却被报 resource 缺失=${missingResources.length}；重复迁移缺失集合膨胀=${missingGrew}`,
    })

    // 8) 旧原件保留：old.db/WAL/SHM 的大小/mtime/sha256 不变；夹具树未被写入；派生输入只改 URL 字段。
    const retentionRows: string[] = []
    let retentionOk = true
    for (const account of ACCOUNTS) {
      const database = join(FIXTURE_ROOT, account, "old.db")
      const before = originals.get(account)!
      const after = { db: await fileStamp(database), wal: await fileStamp(`${database}-wal`), shm: await fileStamp(`${database}-shm`) }
      for (const key of ["db", "wal", "shm"] as const) {
        const same = before[key].exists === after[key].exists && before[key].size === after[key].size && before[key].sha256 === after[key].sha256 && before[key].mtimeMs === after[key].mtimeMs
        if (!same) retentionOk = false
        retentionRows.push(`${account}/${key}: exists=${before[key].exists}→${after[key].exists} size=${before[key].size}→${after[key].size} mtimeMs=${before[key].mtimeMs}→${after[key].mtimeMs} sha=${String(before[key].sha256).slice(0, 12)}…→${String(after[key].sha256).slice(0, 12)}… 未变=${same}`)
      }
    }
    const fixtureDiff = diffSnapshot(fixtureBefore, await snapshotTree(FIXTURE_ROOT))
    checks.push({
      name: "old_originals_untouched",
      ok: retentionOk && fixtureDiff.length === 0,
      detail: `${retentionRows.join(" | ")}；夹具树(只读)变化=[${fixtureDiff.join(",") || "无"}]；派生输入（临时副本，夹具原件 sha 见上且未变）=[${outcomes.map(outcome => `${outcome.account}: ${outcome.first.options.sourceDatabase} URL改写=${outcome.rewrites.length}条=[${outcome.rewrites.join(",") || "无"}]`).join(" || ")}]；夹具数据内部的历史 Data Root 当前不存在=${await stat(LEGACY_ROOT).then(() => false, () => true)}（${LEGACY_ROOT}），故附件 URL 只在派生副本里改指夹具 cross-directory 同名原件`,
    })

    // 9) §4.6-3「活跃库 WAL 一致性」的行为证据（DEV-027 F23）。
    //    要被证明的不是"文件没变"，而是"**提交在 WAL 里、尚未 checkpoint 的行也被迁移了**"；
    //    这要求夹具提供一个提交后未 checkpoint 的 -wal。本机夹具 `wal.exists=false` ⇒
    //    明确记 **UNCOVERED + 原因**（`contract/` 前缀由薄入口打成 UNCOVERED 行，不计入通过分子/分母/退出码），
    //    **不用空集当通过**。
    const walRows = ACCOUNTS.map(account => {
      const stamp = originals.get(account)!.wal
      return `${account}: exists=${stamp.exists} size=${stamp.size}`
    })
    const walPresent = ACCOUNTS.some(account => originals.get(account)!.wal.exists)
    checks.push({
      name: "contract/wal_consistency_behavioral_fixture",
      // `ok:true` 是既有的**未覆盖**表达（`contract/` 前缀 + detail 含 UNCOVERED ⇒ 薄入口打成 UNCOVERED 行，
      // 既不计入通过分子也不计入失败分子，只把退出码抬到 2）。这里表达的是"这一条没有行为证据"，
      // 不是"没失败"：见 detail 的原因与下一步。
      ok: true,
      detail: walPresent
        ? `UNCOVERED：夹具存在 -wal（${walRows.join("；")}），但本门尚未按 WAL 内容断言"已提交且未 checkpoint 的行被迁移"（合同 §4.6-3）。下一步：把该 -wal 接成真断言（迁移计数须包含 WAL 内行、且源 db/WAL/SHM 逐字节不变）。`
        : `UNCOVERED：夹具没有 -wal（${walRows.join("；")}），因此"WAL 里已提交但未 checkpoint 的行被迁移"这一条**没有行为证据**（合同 §4.6-3）。需要一个"真实 SQLite 提交后保留 -wal 再迁移"的最小夹具；本机夹具未提供，如实记未覆盖，不用空集当通过。`,
    })

    // BLOCKED 只反映真实依赖状态，不为了把退出码变 0 放宽判据：
    // 迁移器对真实夹具判定非 PASS 时如实上报 BLOCKED。
    const blockedRuns = outcomes.flatMap(outcome => [outcome.first, outcome.second]).filter(run => run.result.status !== "PASS")
    const blocked = blockedRuns.length
      ? `迁移器对真实夹具判定 ${blockedRuns.map(run => `${run.options.accountKey}:${run.result.status}(exitCode=${run.result.exitCode})`).join("、")}；未修改产品代码、未放宽判据，真实缺失条目见 missing_entries_reported_individually。`
      : null
    return { gate: "G14", checks, blocked }
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.stack ?? error) })
    return { gate: "G14", checks, blocked: null }
  }
}
