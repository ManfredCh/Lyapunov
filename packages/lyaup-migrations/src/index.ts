import { Context } from "@deepseek-ai/cordis"
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session"
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session"
import { freezeMessage, MessageId, ToolCallId } from "@deepseek-ai/dsh-llm"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local"
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment"
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath,pathToFileURL } from "node:url"
import { SceneOperations, type MissingResourceRecord } from "../../scene-kit/src/index.ts"
import { atomicJSON, fileTransaction, safeId } from "../../scene-kit/src/persistence.ts"
import {jsonSourceStamps,snapshotJsonSource} from './json-source.ts'
import {validatePreferenceScope,preparePreferenceMigration,finishPreferenceMigration,type MigrationMode,type ScopedPreferenceSources} from './preferences-entry.ts'
import {legacyResourceDefaults} from './resource-calibration.ts'
export type {MigrationMode,ScopedPreferenceSources} from './preferences-entry.ts'

export interface MigrationOptions {
  sourceDatabase?: string
  sourceJsonDirectory?: string
  sourceLabel: string
  accountKey: string
  /** 仅显式请求偏好迁移时必填；既有会话迁移调用不推断模式。 */
  mode?: MigrationMode
  /** 显式偏好迁移须提供已有 profileDirectory；会话移植本身不创建 Profile。 */
  preferences?: ScopedPreferenceSources
  dshHome: string
  sceneRoot: string
  /** 仅访问显式传入的本应用资源索引；不扫描其他项目或旧系统安装。 */
  resourceLibraries?: Array<{ path: string; workspaceRoot: string }>
  sceneFiles?: string[]
}
interface Ledger {
  accountKey: string
  sourceDatabase: string
  sourceLabel: string
  sceneRoot?:string
  sessions: Record<string, { id: string; sourceMessageIds: string[]; sourceRowsStamp: string; eventCount: number }>
  messages: Record<string, string>
  parts: Record<string, { sessionId: string; messageId: string; type: string }>
  attachments: Record<string, { type: "image" | "file"; attachment: any }>
  attachmentRepairs?: Record<string, { sessionId: string; fromSeq: number; replacementSeq?: number; repairedAt: string }>
  resources: Record<string, { resourceId: string; version: number }>
  scenes: Record<string, string>
  missing?: Missing[]
}
interface Missing { kind: string; id: string; path?: string; reason: string }
const asJSON = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const stableId = (account: string, kind: string, old: string) => `legacy-${account}-${kind}-${Buffer.from(old).toString("base64url")}`

/** 旧资源索引常来自只读备份（0444）。copyFile 会把源的 0444 权限留给目标，
 * 于是第一次迁移成功、第二次迁移打开目标即 EACCES，恢复 BLOCKED 资源后重跑迁移的路径直接崩溃。
 * 改为先清掉旧副本再显式写入 0600 内容，并回读校验字节一致，让「原件已完整保留」可证且可重跑。 */
async function preserveLibraryOriginal(source: string, destination: string) {
  const bytes = await readFile(source)
  await rm(destination, { force: true })
  await writeFile(destination, bytes, { mode: 0o600 })
  if (!(await readFile(destination)).equals(bytes)) throw new Error(`RESOURCE_LIBRARY_ORIGINAL_COPY_MISMATCH: ${source}`)
}

export async function migrateLegacy(options: MigrationOptions) {
  safeId(options.accountKey); safeId(options.sourceLabel)
  validatePreferenceScope(options)
  if(Boolean(options.sourceDatabase)===Boolean(options.sourceJsonDirectory))throw new Error("必须且只能指定sourceDatabase或sourceJsonDirectory")
  const sourceKind=options.sourceJsonDirectory?"json":"sqlite"
  const sourceDatabase = resolve(options.sourceDatabase??options.sourceJsonDirectory!)
  const home = resolve(options.dshHome)
  if (home === dirname(sourceDatabase) || sourceDatabase===home || sourceDatabase.startsWith(home + sep) || (sourceKind==='json'&&home.startsWith(sourceDatabase+sep))) throw new Error("MIGRATION_SOURCE_MUST_BE_OUTSIDE_TARGET")
  const directory = join(home, "migrations", options.sourceLabel)
  const ledgerPath = join(directory, "ledger.json")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return fileTransaction(ledgerPath, async () => {
    let ledger: Ledger
    try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      ledger = { accountKey: options.accountKey, sourceDatabase, sourceLabel: options.sourceLabel, sessions: {}, messages: {}, parts: {}, attachments: {}, attachmentRepairs: {}, resources: {}, scenes: {} }
    }
    if (ledger.accountKey !== options.accountKey || ledger.sourceDatabase !== sourceDatabase) throw new Error("MIGRATION_ACCOUNT_OR_SOURCE_MISMATCH")
    ledger.attachmentRepairs ??= {}
    const targetSceneRoot=resolve(options.sceneRoot)
    if(ledger.sceneRoot&&ledger.sceneRoot!==targetSceneRoot)throw new Error('MIGRATION_SCENE_ROOT_MISMATCH: 已有迁移账本绑定另一Scene目录')
    if(!ledger.sceneRoot&&Object.keys(ledger.resources).length){
      const records=await new SceneOperations(targetSceneRoot).resources.list({allVersions:true,includeDeleted:true})
      const present=new Set(records.map(record=>`${record.ref.resourceId}@${record.ref.version}`))
      if(Object.values(ledger.resources).some(ref=>!present.has(`${ref.resourceId}@${ref.version}`)))throw new Error('MIGRATION_SCENE_ROOT_MISMATCH: 指定Scene目录不含已有账本的迁入资源，账本未修改')
    }
    ledger.sceneRoot=targetSceneRoot
    const preferences=await preparePreferenceMigration(options)
    const stamps=()=>sourceKind==='json'?jsonSourceStamps(sourceDatabase):sourceStamps(sourceDatabase)
    const before = await stamps()
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const snapshotPath = join(directory, `source-${stamp}.${sourceKind==='sqlite'?'sqlite':'original.json'}`)
    const exportPath = join(directory, `source-${stamp}.json`)
    let source:Record<string,any[]>,summary:{tables:Record<string,number>;unmigrated?:Record<string,number>},sourceIssues:Missing[]=[]
    if(sourceKind==='json'){
      const snapshot=await snapshotJsonSource(sourceDatabase,exportPath,before as Awaited<ReturnType<typeof jsonSourceStamps>>)
      source=snapshot.source;summary=snapshot.summary;sourceIssues=snapshot.issues
    }else{
    const child = spawn("python3", [resolve(import.meta.dirname, "../python/snapshot.py"), sourceDatabase, snapshotPath, exportPath], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", value => { stdout += value }); child.stderr.on("data", value => { stderr += value })
    const code = await new Promise<number>(resolve => child.once("exit", code => resolve(code ?? 1)))
    if (code !== 0) throw new Error(`SQLITE_SNAPSHOT_FAILED: ${stderr}`)
    source = JSON.parse(await readFile(exportPath, "utf8"))
    summary = JSON.parse(stdout.trim())
    }
    // 已导入会话中的缺失附件需要显式修复；资源/场景则在本轮重新核对。
    const resourcesRequested = Boolean(options.resourceLibraries?.length)
    const scenesRequested = Boolean(options.sceneFiles?.length)
    // 只丢弃**本轮会重新推导**的两类旧条目：逐条重试的资源、逐个重开的场景。
    // 其余历史条目必须原样保留：它们只在首次导入时被推导出来（例如 UNSUPPORTED_ROLE 的 message），
    // 已导入会话在重跑时走 repair 分支、不再重新检查角色。此前只保留 attachment/session/resource/scene
    // 四类，`message` 一类在第二次运行就被丢掉，于是"重跑"会把一次真实 BLOCKED 洗成 PASS。
    const missing: Missing[] = [...(ledger.missing ?? []).filter(item =>
      !(item.kind === "resource" && resourcesRequested) && !(item.kind === "scene" && scenesRequested)),...sourceIssues]
    const ctx = new Context()
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(home, "sessions"), compression: "zstd" })
    const attachmentFiber = await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    const result = { status: "PASS", sourceKind, requestedScope:preferences.requested?"sessions-resources-preferences":"sessions-resources", preferences, created: 0, unchanged: 0, updated: 0, repairedSessions: 0, repairedAttachments: 0, interruptedTools: 0, metadataOnlyParts: 0, attachments: 0, resources: 0, resourceMetadataUpdated:0, scenes: 0, missing, sourceCounts: summary.tables, sourceUnmigrated: summary.unmigrated ?? {}, sourceUnchanged: true, sourceDatabase, snapshotPath, exportPath, ledgerPath, nativeSessions: [] as string[], exitCode: 0 }
    try {
      for (const old of [...source.session!].sort((a, b) => a.time_created - b.time_created)) {
        const oldId = String(old.id), id = ledger.sessions[oldId]?.id ?? stableId(options.accountKey, options.sourceLabel, oldId)
        const rows = source.message!.filter(row => row.session_id === oldId).sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
        const oldMessageIds = rows.map(row => row.id)
        const sourceRowsStamp = [...rows, ...source.part!.filter(part => part.session_id === oldId)].map(row => `${row.id}:${row.time_updated}`).join("|")
        const previous = ledger.sessions[oldId]
        const project = source.project?.find(candidate => String(candidate.id) === String(old.project_id))
        const legacyCwd = resolve(old.directory || project?.worktree || process.cwd())
        if (previous && previous.sourceRowsStamp === sourceRowsStamp) {
          const repair = await repairExistingSession(ctx, id, rows, source.part!, legacyCwd, ledger)
          result.repairedAttachments += repair.repairedAttachmentIds.length
          result.repairedSessions += repair.changed ? 1 : 0
          result.updated += repair.changed ? 1 : 0
          missing.push(...repair.failures)
          for (const attachmentId of repair.repairedAttachmentIds) {
            for (let index = missing.length - 1; index >= 0; index--) {
              if (missing[index]?.kind === "attachment" && missing[index]?.id === attachmentId) missing.splice(index, 1)
            }
          }
          // surface 修补会往原生会话追加事件，账本必须同步：否则"恢复原件后重跑"这条
          // DEV-021 恢复路径走完，台账里的 eventCount 仍停在首次导入值，
          // 与真实日志长度不符（按账本核对"可重开"的证据自此对不上）。
          const countChanged = previous.eventCount !== repair.eventCount
          previous.eventCount = repair.eventCount
          if (repair.changed || repair.repairedAttachmentIds.length || countChanged) await atomicJSON(ledgerPath, ledger)
          result.unchanged++; result.nativeSessions.push(id); continue
        }
        if (previous) {
          // 用户可能已经在新会话继续工作。旧源新增记录进入显式阻断，绝不覆写新原生会话。
          missing.push({ kind: "session", id: oldId, reason: "SOURCE_SESSION_CHANGED_AFTER_MIGRATION；需要显式增量合并，原生会话未覆盖" })
          continue
        }
        // SQLite 旧源的 session.directory 可能为空，而 project.worktree
        // 才是旧 Workspace 的权威路径。优先保留 Session 自己的目录，
        // 缺失时回退 Project，令 DSH WorkspaceRegistry 能在重开时按 cwd
        // 自动重建同一工作区；两者都没有才使用当前目录作为最后的历史兼容值。
        const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Number(old.time_created ?? Date.now()), isSeeded: false, delegationDepth: 0, cwd: legacyCwd, ...(old.parent_id ? { parentSession: SessionId(ledger.sessions[old.parent_id]?.id ?? stableId(options.accountKey, options.sourceLabel, old.parent_id)) } : {}) }
        const session = Session.create(SessionId(id), undefined, header)
        const times: number[] = []
        const append = (type: any, data: any, time: number, surface = false) => {
          ;(session.append as any)(type, clean(data), ...(surface ? [{ surfaceOp: "append" }] : []))
          times.push(Math.max(0, Math.floor(time)))
        }
        if (typeof old.title === "string" && old.title.trim()) append("session/title", { title: old.title, messageSeqs: [], source: { kind: "user" } }, old.time_created)
        let turn = 0, step = 0, opened = false, interrupted = false
        const closeTurn = (time: number) => { if (opened) { append("turn/end", { turn, reason: { kind: interrupted ? "interrupted" : "completed" } }, time); opened = false } }
        for (const row of rows) {
          const info = asJSON(row.data)
          const parts = source.part!.filter(part => part.message_id === row.id).sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
          const messageId = stableId(options.accountKey, "message", row.id)
          ledger.messages[row.id] = messageId
          const content: ContentBlock[] = [], calls: Array<{ part: any; data: any; callId: string }> = []
          for (const part of parts) {
            const data = asJSON(part.data)
            ledger.parts[part.id] = { sessionId: id, messageId, type: data.type }
            if (data.type === "text" && typeof data.text === "string") content.push({ type: "text", text: data.text })
            else if (data.type === "reasoning" && typeof data.text === "string") content.push({ type: "reasoning", text: data.text })
            else if (data.type === "file") {
              const block = await migrateAttachment(ctx.attachments, data, part.id, legacyCwd, ledger, missing)
              content.push(block)
            } else if (data.type === "tool") {
              const callId = stableId(options.accountKey, "call", String(data.callID ?? part.id))
              content.push({ type: "tool-call", id: ToolCallId(callId), name: data.tool, arguments: JSON.stringify(data.state?.input ?? {}) })
              calls.push({ part, data, callId })
            } else result.metadataOnlyParts++
          }
          if (info.role === "user") {
            closeTurn(row.time_created)
            turn++; step = 0; interrupted = false; opened = true
            append("turn/start", { turn }, row.time_created)
            append("user/message", freezeMessage({ id: MessageId(messageId), role: "user", source: { kind: "user" }, content }), row.time_created, true)
          } else if (info.role === "assistant") {
            if (!opened) { turn++; opened = true; step = 0; append("turn/start", { turn }, row.time_created) }
            step++
            append("step/start", { turn, step }, row.time_created)
            append("assistant/message", { turn, step, message: freezeMessage({ id: MessageId(messageId), role: "assistant", source: { kind: "model", provider: info.providerID || "legacy-unknown", model: info.modelID || "legacy-unknown" }, content }), stream: [] }, row.time_created, true)
            for (const { part, data, callId } of calls) {
              append("tool/call", { turn, step, callId, name: data.tool, arguments: JSON.stringify(data.state?.input ?? {}) }, part.time_created)
              const completed = data.state?.status === "completed", failed = data.state?.status === "error"
              if (!completed && !failed) { interrupted = true; result.interruptedTools++ }
              const toolContent: ContentBlock[] = [{ type: "text", text: completed ? String(data.state.output ?? "") : failed ? String(data.state.error ?? "旧工具返回错误") : "迁移前动作结果未知，已标记 interrupted；需重新观察，不会自动重发动作。" }]
              for (const attachment of data.state?.attachments ?? []) toolContent.push(await migrateAttachment(ctx.attachments, attachment, `${part.id}:${attachment.id ?? toolContent.length}`, legacyCwd, ledger, missing))
              append("tool/result", { turn, step, message: freezeMessage({ id: MessageId(stableId(options.accountKey, "result", part.id)), role: "tool", source: { kind: "tool", callId: ToolCallId(callId) }, toolCallId: ToolCallId(callId), content: toolContent, isError: !completed }), meta: { migration: { partId: part.id, originalStatus: data.state?.status ?? "unknown", interrupted: !completed && !failed }, ...(data.state?.metadata ? { originalMetadata: data.state.metadata } : {}) } }, part.time_updated ?? part.time_created, true)
            }
            append("step/end", { turn, step }, row.time_updated ?? row.time_created)
            if (info.error) interrupted = true
          } else missing.push({ kind: "message", id: row.id, reason: `UNSUPPORTED_ROLE: ${info.role}` })
        }
        closeTurn(Number(old.time_updated ?? Date.now()))
        const events = session.snapshotEvents().map((event, i) => ({ ...structuredClone(event), time: times[i]! })) as SessionEvent[]
        Session.fromRestore(SessionId(id), events, header, SessionLogOffset(0), "detached")
        let handle
        try { handle = await ctx.sessionPersistence.create(header) } catch (error) {
          // 中途崩溃可能已落盘但还没写ledger；读取并核对完整导入前缀，不重复创建。
          if ((error as Error).name !== "SessionAlreadyExistsError") throw error
          const existing = await ctx.sessionPersistence.open(SessionId(id), "read")
          try { if (JSON.stringify((await existing.read()).events) !== JSON.stringify(events)) throw new Error(`NATIVE_SESSION_EXISTS_WITH_DIFFERENT_CONTENT: ${id}`) } finally { await existing.close() }
        }
        if (handle) try { await handle.append(events); await handle.flush() } finally { await handle.close() }
        ledger.sessions[oldId] = { id, sourceMessageIds: oldMessageIds, sourceRowsStamp, eventCount: events.length }
        await atomicJSON(ledgerPath, ledger)
        result.created++; result.nativeSessions.push(id)
      }
      await finishPreferenceMigration(ctx,options,preferences,result.nativeSessions)
      for(const approval of preferences.approval){if(approval.eventCount!==undefined){const entry=Object.values(ledger.sessions).find(entry=>entry.id===approval.sessionId);if(entry)entry.eventCount=approval.eventCount}}
      if(preferences.requested&&preferences.exitCode){result.status=preferences.status;result.exitCode=2}
      const scene = new SceneOperations(options.sceneRoot)
      const missingResources: MissingResourceRecord[] = []
      for (const library of options.resourceLibraries ?? []) {
        const data = JSON.parse(await readFile(library.path, "utf8"))
        for (const old of [...data.resources ?? [], ...data.tombstones ?? []]) {
          const oldId = String(old.resource_id ?? old.id)
          const path = resolve(library.workspaceRoot, old.path)
          try {
            const defaults=legacyResourceDefaults(old),existing=ledger.resources[oldId]
            if(existing){const retained=await scene.resources.retainImportDefaults(existing.resourceId,existing.version,pathToFileURL(path).href,defaults);if(retained.changed)result.resourceMetadataUpdated++;continue}
            const record = await scene.resources.import({ path, resourceId: stableId(options.accountKey, "resource", oldId), name: old.displayName ?? old.name ?? basename(path), folder: old.category ?? "", tags: old.aliases ?? [],...defaults })
            if (old.deletedAt || old.deleted_at) await scene.resources.update(record.ref.resourceId, { deleted: true })
            ledger.resources[oldId] = { resourceId: record.ref.resourceId, version: record.ref.version }
            result.resources++
          } catch (error) {
            const reason=String(error)
            missing.push({ kind: "resource", id: oldId, path, reason })
            // 不创建伪造 ResourceRecord：旧引用仍需在资源库一级界面可见，
            // 但必须明确 BLOCKED，且只能通过找回同一原件后重跑迁移恢复。
            missingResources.push({
              resourceId: oldId,
              legacyPath: path,
              ...(old.displayName ?? old.name ? { displayName: old.displayName ?? old.name } : {}),
              ...(old.source ? { source: String(old.source) } : {}),
              ...(old.sourceRef ? { sourceRef: String(old.sourceRef) } : {}),
              ...(old.assetRevision ? { assetRevision: String(old.assetRevision) } : {}),
              status: "BLOCKED",
              reason,
              recovery: { action: "restore-original-at-source-path-and-rerun-migration", replacementAllowed: false },
            })
          }
        }
        await preserveLibraryOriginal(library.path, join(directory, `resource-original-${basename(library.path)}`))
      }
      // 同一 resourceId 可能同时出现在 resources/tombstones 或多个显式库中。
      // 按首个来源稳定去重，报告可以逐条审计且重复迁移不会膨胀。
      const uniqueMissingResources=[...new Map(missingResources.map(item=>[item.resourceId,item])).values()]
      if (resourcesRequested) await scene.resources.replaceMissing(uniqueMissingResources)
      for (const path of options.sceneFiles ?? []) {
        if (ledger.scenes[path]) continue
        try { const snapshot = await scene.open(path); ledger.scenes[path] = snapshot.sceneId; result.scenes++ }
        catch (error) { missing.push({ kind: "scene", id: path, path, reason: String(error) }) }
      }
      await atomicJSON(join(directory, "projects-and-preferences.json"), { project: source.project ?? [], workspace: source.workspace ?? [], permissions: source.permission ?? [], todos: source.todo ?? [], sessionMetadata: source.session ?? [],sessionDiffs:source.session_diff??[],legacyShareReferences:source.session_share??[] })
      // 历史条目与本轮重新推导出的条目会指向同一条缺失（例如未知布局目录每轮都会重新上报）。
      // 去重后**同时**写进账本与返回值：只去重账本会让 result.missing 在重跑时翻倍，
      // 缺失清单不再可复算（条数与首次运行不一致）。
      const uniqueMissing = missing.filter((item, index) => missing.findIndex(other => other.kind === item.kind && other.id === item.id && other.reason === item.reason) === index)
      ledger.missing = uniqueMissing
      result.missing = uniqueMissing
      await atomicJSON(ledgerPath, ledger)
      result.attachments = Object.keys(ledger.attachments).length
      result.sourceUnchanged = JSON.stringify(before) === JSON.stringify(await stamps())
      if (!result.sourceUnchanged) { result.status = "BLOCKED"; uniqueMissing.push({ kind: "database", id: sourceDatabase, reason: "SOURCE_CHANGED_DURING_MIGRATION；已导入一致性快照，需要核对源DB或WAL的后续变化" }); result.exitCode = 2 }
      if (uniqueMissing.length) { result.status = "BLOCKED"; result.exitCode = 2 }
      await atomicJSON(join(directory, "result.json"), result)
      return result
    } finally { await attachmentFiber.dispose(); await persistenceFiber.dispose() }
  })
}

interface AttachmentRepairResult {
  changed: boolean
  repairedAttachmentIds: string[]
  failures: Missing[]
  /** 修补后原生日志的完整事件数；调用方用它同步账本 eventCount。 */
  eventCount: number
}

type SourcePart = { id: string; data: any; time_created?: number; time_updated?: number }

/**
 * 补回同一原生 Session 中第一次迁移时缺失的附件。
 *
 * Session 日志是追加式的，因此不能原地改写旧 event；DSH 的 surface replace
 * 是它提供的原生“原位”语义：追加一个带来源 seq 的替换 event，旧消息仍在
 * 审计日志中，但 deriveMessages() 只暴露新的完整内容。这样既不重建 Session，
 * 也不会再创建重复会话。
 */
async function repairExistingSession(
  ctx: Context,
  sessionId: string,
  rows: Array<Record<string, any>>,
  sourceParts: Array<Record<string, any>>,
  legacyCwd: string,
  ledger: Ledger,
): Promise<AttachmentRepairResult> {
  const handle = await ctx.sessionPersistence.open(SessionId(sessionId), "write")
  try {
    const { events, eventState } = await handle.read()
    let workingEvents = [...events]
    let session = Session.fromRestore(handle.id, workingEvents, handle.header, handle.inheritedEventCount, eventState)
    const failures: Missing[] = []
    const repairedAttachmentIds = new Set<string>()
    const partsByMessage = new Map<string, SourcePart[]>()
    for (const part of sourceParts) {
      const messageId = String(part.message_id)
      const list = partsByMessage.get(messageId) ?? []
      list.push(part as SourcePart)
      partsByMessage.set(messageId, list)
    }

    const visibleEvent = (predicate: (event: SessionEvent) => boolean): SessionEvent | undefined => {
      const current = session.snapshotEvents()
      for (const seq of [...session.surface.nodes].reverse()) {
        const event = current[seq]
        if (event && predicate(event)) return event
      }
      return undefined
    }

    const appendReplacement = (current: SessionEvent, content: ContentBlock[]): SessionEvent => {
      const surface = { surfaceOp: { op: "replace", startSeq: current.seq, endSeq: current.seq }, sourceEventSeqs: [current.seq] } as const
      const seq = workingEvents.length
      const time = Date.now()
      let candidate: SessionEvent
      if (current.type === "user/message") {
        const data = { ...current.data, content }
        candidate = { type: "user/message", seq, time, data, ...surface } as any
      } else if (current.type === "tool/result") {
        const data = { ...current.data, message: { ...current.data.message, content } }
        candidate = { type: "tool/result", seq, time, data, ...surface } as any
      } else {
        throw new Error(`ATTACHMENT_REPAIR_UNSUPPORTED_EVENT: ${current.type}`)
      }
      // Session.fromRestore performs the same surface and JSON validation as
      // Session.append, while letting this repair omit its synthetic
      // session/end-seed marker from the durable append batch.
      const validated = Session.fromRestore(handle.id, [...workingEvents, candidate], handle.header, handle.inheritedEventCount, eventState)
      const replacement = validated.snapshotEvents()[seq]!
      workingEvents = [...workingEvents, replacement]
      session = validated
      return replacement
    }

    const appendRepairLedger = (attachmentIds: string[], fromSeq: number, replacementSeq: number) => {
      ledger.attachmentRepairs ??= {}
      const repairedAt = new Date().toISOString()
      for (const attachmentId of attachmentIds) {
        const repairKey = `${sessionId}:${attachmentId}`
        const wasBlocked = ledger.missing?.some(item => item.kind === "attachment" && item.id === attachmentId) ?? false
        if (wasBlocked || !ledger.attachmentRepairs[repairKey]) {
          ledger.attachmentRepairs[repairKey] = { sessionId, fromSeq, replacementSeq, repairedAt }
        }
        if (wasBlocked) repairedAttachmentIds.add(attachmentId)
      }
    }

    const buildUserContent = async (parts: SourcePart[], current: Extract<SessionEvent, { type: "user/message" }>): Promise<{ content: ContentBlock[]; attachmentIds: string[] }> => {
      const content: ContentBlock[] = []
      const available: string[] = []
      for (const part of parts) {
        const data = asJSON(part.data)
        if (data.type === "text" && typeof data.text === "string") content.push({ type: "text", text: data.text })
        else if (data.type === "reasoning" && typeof data.text === "string") content.push({ type: "reasoning", text: data.text })
        else if (data.type === "file") {
          const before = ledger.attachments[part.id]
          const block = await migrateAttachment(ctx.attachments, data, part.id, legacyCwd, ledger, failures)
          content.push(block)
          if (before || ledger.attachments[part.id]) available.push(part.id)
        }
      }
      void current
      return { content, attachmentIds: available }
    }

    const buildToolContent = async (part: SourcePart, current: Extract<SessionEvent, { type: "tool/result" }>): Promise<{ content: ContentBlock[]; attachmentIds: string[] }> => {
      const data = asJSON(part.data)
      const completed = data.state?.status === "completed"
      const failed = data.state?.status === "error"
      const toolContent: ContentBlock[] = [{ type: "text", text: completed ? String(data.state.output ?? "") : failed ? String(data.state.error ?? "旧工具返回错误") : "迁移前动作结果未知，已标记 interrupted；需重新观察，不会自动重发动作。" }]
      const available: string[] = []
      for (const attachment of data.state?.attachments ?? []) {
        const attachmentId = `${part.id}:${attachment.id ?? toolContent.length}`
        const before = ledger.attachments[attachmentId]
        toolContent.push(await migrateAttachment(ctx.attachments, attachment, attachmentId, legacyCwd, ledger, failures))
        if (before || ledger.attachments[attachmentId]) available.push(attachmentId)
      }
      // V4 工具结果是顶层 tool 消息；附件修补只重建原 content，身份、toolCallId 与 isError 保留。
      void current
      return { content: toolContent, attachmentIds: available }
    }

    for (const row of rows) {
      const info = asJSON(row.data)
      const parts = [...(partsByMessage.get(String(row.id)) ?? [])].sort((a, b) => Number(a.time_created ?? 0) - Number(b.time_created ?? 0) || a.id.localeCompare(b.id))
      const messageId = ledger.messages[String(row.id)]
      if (info.role === "user") {
        if (!parts.some(part => asJSON(part.data).type === "file")) continue
        const current = visibleEvent(event => event.type === "user/message" && String(event.data.id) === String(messageId)) as Extract<SessionEvent, { type: "user/message" }> | undefined
        if (!current) {
          failures.push({ kind: "attachment", id: String(row.id), reason: "ATTACHMENT_REPAIR_TARGET_NOT_VISIBLE: 原用户消息已被当前Session的surface替换，未改写会话" })
          continue
        }
        const rebuilt = await buildUserContent(parts, current)
        if (!rebuilt.attachmentIds.length) continue
        if (JSON.stringify(current.data.content) === JSON.stringify(rebuilt.content)) {
          appendRepairLedger(rebuilt.attachmentIds, current.seq, current.seq)
          continue
        }
        const replacement = appendReplacement(current, rebuilt.content)
        appendRepairLedger(rebuilt.attachmentIds, current.seq, replacement.seq)
      } else if (info.role === "assistant") {
        for (const part of parts) {
          const data = asJSON(part.data)
          if (data.type !== "tool" || !Array.isArray(data.state?.attachments) || !data.state.attachments.length) continue
          const current = visibleEvent(event => event.type === "tool/result" && (event.data as any).meta?.migration?.partId === part.id) as Extract<SessionEvent, { type: "tool/result" }> | undefined
          if (!current) {
            failures.push({ kind: "attachment", id: part.id, reason: "ATTACHMENT_REPAIR_TARGET_NOT_VISIBLE: 原工具结果已被当前Session的surface替换，未改写会话" })
            continue
          }
          const rebuilt = await buildToolContent(part, current)
          if (!rebuilt.attachmentIds.length) continue
          if (JSON.stringify(current.data.message.content) === JSON.stringify(rebuilt.content)) {
            appendRepairLedger(rebuilt.attachmentIds, current.seq, current.seq)
            continue
          }
          const replacement = appendReplacement(current, rebuilt.content)
          appendRepairLedger(rebuilt.attachmentIds, current.seq, replacement.seq)
        }
      }
    }

    const appended = workingEvents.slice(events.length)
    if (appended.length) {
      await handle.append(appended)
      await handle.flush()
    }
    return { changed: appended.length > 0, repairedAttachmentIds: [...repairedAttachmentIds], failures, eventCount: workingEvents.length }
  } finally {
    await handle.close()
  }
}

async function migrateAttachment(store: AttachmentStore, input: any, id: string, cwd: string, ledger: Ledger, missing: Missing[]): Promise<ContentBlock> {
  if (ledger.attachments[id]) return ledger.attachments[id]!
  const uri = input.url ?? input.uri ?? input.path
  try {
    let data: Buffer, mime = input.mime ?? input.mimeType
    if (typeof uri !== "string") throw new Error("ATTACHMENT_PATH_MISSING")
    if (uri.startsWith("data:")) {
      const match = uri.match(/^data:([^;,]+);base64,([\s\S]+)$/)
      if (!match) throw new Error("UNSUPPORTED_DATA_URI")
      mime ??= match[1]; data = Buffer.from(match[2]!, "base64")
    } else {
      if (/^https?:/i.test(uri)) throw new Error("REMOTE_ATTACHMENT_NOT_DOWNLOADED；需显式授权目标后导入")
      data = await readFile(uri.startsWith("file:") ? fileURLToPath(uri) : resolve(cwd, uri))
    }
    const name = input.filename ?? input.name ?? (uri.startsWith("data:") ? "旧图像" : basename(uri))
    const block = mime?.startsWith("image/") ? { type: "image" as const, attachment: await store.saveImage({ data, mediaType: mime, name }) } : { type: "file" as const, attachment: await store.saveFile({ data, name }) }
    ledger.attachments[id] = block
    return block
  } catch (error) {
    missing.push({ kind: "attachment", id, ...typeof uri === "string" && !uri.startsWith("data:") ? { path: uri } : {}, reason: String(error) })
    const originalReference = typeof uri === "string" ? uri : "<missing-uri>"
    return { type: "text", text: `附件 ${input.filename ?? input.name ?? id} 暂不可读取；原引用 ${originalReference} 已保留在迁移报告，恢复原件后可重跑迁移。` }
  }
}

async function sourceStamps(path: string) {
  // SQLite 的只读连接仍会更新 SHM 读锁/索引；持久内容来自 DB 和 WAL。
  return Promise.all([path, `${path}-wal`].map(async file => {
    try { const value = await stat(file); return { file, size: value.size, mtimeMs: value.mtimeMs } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, missing: true }; throw error }
  }))
}
