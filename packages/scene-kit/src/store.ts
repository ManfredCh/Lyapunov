import { join } from "node:path"
import { mkdirSync, watch } from "node:fs"
import { readdir } from "node:fs/promises"
import {isDeepStrictEqual} from 'node:util'
import type { Entity, SceneCommit, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { SCENE_COORDINATES } from "../../lyapunov-contracts/src/types.ts"
import {validateScenePhysics} from '../../lyapunov-contracts/src/world-physics.ts'
import { atomicJSON, fileTransaction, readJSON, safeId } from "./persistence.ts"

export class SceneConflict extends Error {
  readonly code = "SCENE_REVISION_CONFLICT"
  constructor(readonly sceneId: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super(`场景 ${sceneId} 已是版本 ${currentRevision}，请求基于 ${expectedRevision}`)
  }
}

/** A persisted, immutable scene revision. The full snapshot is kept on disk;
 * callers may use the metadata list first and request a specific revision only
 * when they need to inspect or restore it. */
export interface SceneVersion {
  sceneId: string
  revision: number
  entityCount: number
  current: boolean
}

function jsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach((item, i) => jsonValue(item, `${path}.${i}`)); return }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) jsonValue(item, `${path}.${key}`)
    return
  }
  throw new Error(`INVALID_DOCUMENT_VALUE: ${path}`)
}

export function validateSnapshot(snapshot: SceneSnapshot): void {
  jsonValue(snapshot, "scene")
  safeId(snapshot.sceneId)
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("INVALID_REVISION")
  for (const [key, value] of Object.entries(SCENE_COORDINATES)) {
    if (snapshot.coordinates?.[key as keyof typeof SCENE_COORDINATES] !== value) throw new Error(`INVALID_COORDINATES: ${key}`)
  }
  if (!Array.isArray(snapshot.entities)) throw new Error("INVALID_ENTITIES")
  if(snapshot.physics!==undefined)validateScenePhysics(snapshot.physics)
  const ids = new Map<string, Entity>()
  for (const entity of snapshot.entities) {
    safeId(entity.entityId)
    if (ids.has(entity.entityId)) throw new Error(`DUPLICATE_ENTITY: ${entity.entityId}`)
    if (typeof entity.name !== "string" || !entity.name.trim()) throw new Error(`INVALID_ENTITY_NAME: ${entity.entityId}`)
    if(entity.locked!==undefined&&typeof entity.locked!=='boolean')throw new Error(`INVALID_ENTITY_LOCK: ${entity.entityId}`)
    for (const [key, count] of [["position", 3], ["quaternion", 4], ["scale", 3]] as const) {
      const values = entity.transform?.[key]
      if (!Array.isArray(values) || values.length !== count || values.some(x => !Number.isFinite(x))) throw new Error(`INVALID_TRANSFORM: ${entity.entityId}.${key}`)
    }
    const norm = Math.hypot(...entity.transform.quaternion)
    if (Math.abs(norm - 1) > 1e-5 || entity.transform.scale.some(x => x === 0)) throw new Error(`INVALID_TRANSFORM: ${entity.entityId}`)
    if (!Array.isArray(entity.resources) || !entity.components) throw new Error(`INVALID_ENTITY: ${entity.entityId}`)
    for (const ref of entity.resources) {
      safeId(ref.resourceId)
      if (!Number.isInteger(ref.version) || ref.version < 1 || !ref.original?.uri || !ref.original?.mimeType || !Array.isArray(ref.representations)) throw new Error(`INVALID_RESOURCE: ${ref.resourceId}`)
    }
    ids.set(entity.entityId, entity)
  }
  for (const entity of snapshot.entities) {
    const visited = new Set([entity.entityId])
    let parent = entity.parentId
    while (parent !== undefined) {
      if (visited.has(parent)) throw new Error(`HIERARCHY_CYCLE: ${entity.entityId}`)
      if (!ids.has(parent)) throw new Error(`PARENT_NOT_FOUND: ${parent}`)
      visited.add(parent)
      parent = ids.get(parent)!.parentId
    }
  }
}

/** 未知/跨会话 sceneId 的定点报错：裸 ENOENT 原文带着
 * `ENOENT: no such file or directory, open '/…/scenes/<sceneId>.json'`——读别人的或未知的
 * sceneId 会把内部目录布局漏到模型面（DEV-003 完成条件④）。码形态沿用本包既有约定
 * （network-assets.ts 的 `SCENE_NOT_FOUND: ${sceneId}`），只写 sceneId、不含任何文件系统路径。
 * **code 保持 ENOENT**：`operations.create/open` 用「文件不存在」判定场景是否已存在
 * （`code !== "ENOENT"` 即重抛），换码会连带改掉那些控制流，本项只修错误的可判性与路径外泄。 */
function sceneNotFound(sceneId: string): Error {
  return Object.assign(new Error(`SCENE_NOT_FOUND: ${sceneId}`), { code: "ENOENT" })
}

/** ctx.scene 仅暴露 snapshot/commit/subscribe；创建和文件传输在 operations。 */
export class SceneStore {
  constructor(readonly directory: string,private readonly beforeCommit?: (draft:SceneSnapshot,current:SceneSnapshot,kind:'commit'|'restore')=>Promise<void>) {}
  path(sceneId: string): string { return join(this.directory, "scenes", `${safeId(sceneId)}.json`) }

  private historyDirectory(sceneId: string): string { return join(this.directory, "scenes", ".history", safeId(sceneId)) }
  private historyPath(sceneId: string, revision: number): string {
    if (!Number.isInteger(revision) || revision < 0) throw new Error("INVALID_REVISION")
    return join(this.historyDirectory(sceneId), `revision-${revision}.json`)
  }

  /** Keep the previous complete document before replacing the live document.
   * Existing history is immutable: a differing duplicate revision is treated
   * as corruption instead of being silently overwritten. */
  async recordVersion(snapshot: SceneSnapshot): Promise<void> {
    const path = this.historyPath(snapshot.sceneId, snapshot.revision)
    try {
      const existing = await readJSON<SceneSnapshot>(path)
      validateSnapshot(existing)
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error(`SCENE_HISTORY_CONFLICT: ${snapshot.sceneId}@${snapshot.revision}`)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await atomicJSON(path, snapshot)
  }

  /** 文件名只是定位；正文 sceneId 必须与请求 ID 一致，否则明确报绑定损坏而不是静默读错场景
   * （CR-003；history/version 侧已有同类绑定检查）。缺失场景报 SCENE_NOT_FOUND（见 sceneNotFound）。 */
  async snapshot(sceneId: string): Promise<SceneSnapshot> {
    let result: SceneSnapshot
    try { result = await readJSON<SceneSnapshot>(this.path(sceneId)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      throw sceneNotFound(sceneId)
    }
    validateSnapshot(result)
    if (result.sceneId !== sceneId) throw new Error(`SCENE_BINDING_INVALID: ${sceneId} != ${result.sceneId}`)
    return result
  }

  /** Return revision metadata while retaining complete snapshots on disk. */
  async versions(sceneId: string): Promise<SceneVersion[]> {
    const current = await this.snapshot(sceneId)
    const result = new Map<number, SceneVersion>()
    let names: string[] = []
    try { names = await readdir(this.historyDirectory(sceneId)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    for (const name of names.filter(item => /^revision-\d+\.json$/.test(item))) {
      const revision = Number(name.slice("revision-".length, -".json".length))
      const snapshot = await readJSON<SceneSnapshot>(join(this.historyDirectory(sceneId), name))
      validateSnapshot(snapshot)
      if (snapshot.sceneId !== sceneId || snapshot.revision !== revision) throw new Error(`SCENE_HISTORY_BINDING_INVALID: ${sceneId}@${revision}`)
      result.set(revision, { sceneId, revision, entityCount: snapshot.entities.length, current: revision === current.revision })
    }
    // Legacy scenes may predate the history directory. Expose their current
    // snapshot without pretending an earlier revision exists.
    result.set(current.revision, { sceneId, revision: current.revision, entityCount: current.entities.length, current: true })
    return [...result.values()].sort((a, b) => a.revision - b.revision)
  }

  async version(sceneId: string, revision: number): Promise<SceneSnapshot> {
    let snapshot: SceneSnapshot
    try { snapshot = await readJSON<SceneSnapshot>(this.historyPath(sceneId, revision)) }
    catch (error) {
      // Scenes created before revision history still have a valid current
      // document. Materialize that one revision lazily; no earlier version is
      // inferred from missing files.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const current = await this.snapshot(sceneId)
      if (current.revision !== revision) throw new Error(`SCENE_VERSION_NOT_FOUND: ${sceneId}@${revision}`)
      await this.recordVersion(current)
      snapshot = current
    }
    validateSnapshot(snapshot)
    if (snapshot.sceneId !== sceneId || snapshot.revision !== revision) throw new Error(`SCENE_HISTORY_BINDING_INVALID: ${sceneId}@${revision}`)
    return snapshot
  }

  async commit(input: SceneCommit): Promise<SceneSnapshot> {
    return fileTransaction(this.path(input.sceneId), async () => {
      const current = await this.snapshot(input.sceneId)
      if (current.revision !== input.expectedRevision) throw new SceneConflict(input.sceneId, input.expectedRevision, current.revision)
      if (!Array.isArray(input.patch)) throw new Error("INVALID_PATCH")
      const draft = structuredClone(current)
      if(input.physics!==undefined)draft.physics=structuredClone(input.physics)
      for (const op of input.patch) {
        if (op.op === "add") { draft.entities.push(structuredClone(op.entity)); continue }
        const index = draft.entities.findIndex(entity => entity.entityId === op.entityId)
        if (index < 0) throw new Error(`ENTITY_NOT_FOUND: ${op.entityId}`)
        const target=draft.entities[index]!
        // 解锁必须是单独的明确编辑；不能在同一个update里夹带变换绕过锁。
        if(target.locked&&(op.op==='reparent'||op.op==='update'&&op.changes.transform!==undefined&&!isDeepStrictEqual(op.changes.transform,target.transform)))throw new Error(`ENTITY_LOCKED: ${op.entityId}`)
        if (op.op === "update") {
          if ("entityId" in op.changes || "parentId" in op.changes) throw new Error("INVALID_UPDATE: 使用 reparent 修改父节点")
          draft.entities[index] = { ...draft.entities[index]!, ...structuredClone(op.changes) }
        } else if (op.op === "reparent") {
          if (op.parentId === undefined) delete draft.entities[index]!.parentId
          else draft.entities[index]!.parentId = op.parentId
        } else if (op.op === "remove") {
          const remove = new Set([op.entityId])
          if (op.cascade) {
            let previous = -1
            while (previous !== remove.size) {
              previous = remove.size
              for (const entity of draft.entities) if (entity.parentId && remove.has(entity.parentId)) remove.add(entity.entityId)
            }
          }
          draft.entities = draft.entities.filter(entity => !remove.has(entity.entityId))
        } else throw new Error("INVALID_PATCH_OPERATION")
      }
      if(draft.physics?.groundEntityId&&draft.physics.groundState!==undefined){
        const ground=draft.entities.find(entity=>entity.entityId===draft.physics!.groundEntityId)
        if(ground)draft.physics.groundState=ground.components.collision?.enabled===false?'disabled':'present'
        else if(draft.physics.groundState==='present'||current.entities.some(entity=>entity.entityId===draft.physics!.groundEntityId))draft.physics.groundState='removed'
      }
      draft.revision++
      validateSnapshot(draft)
      await this.beforeCommit?.(draft,current,'commit')
      await this.recordVersion(current)
      await atomicJSON(this.path(input.sceneId), draft)
      return draft
    })
  }

  /** Restore a complete historical document as a new revision. The live
   * document is still protected by the same CAS expectedRevision used by
   * normal edits, so a stale restore can never overwrite a newer scene. */
  async restore(input: { sceneId: string; revision: number; expectedRevision: number }): Promise<SceneSnapshot> {
    return fileTransaction(this.path(input.sceneId), async () => {
      const current = await this.snapshot(input.sceneId)
      if (current.revision !== input.expectedRevision) throw new SceneConflict(input.sceneId, input.expectedRevision, current.revision)
      if (input.revision >= current.revision) throw new Error(`SCENE_VERSION_NOT_HISTORICAL: ${input.sceneId}@${input.revision}`)
      const historical = await this.version(input.sceneId, input.revision)
      const restored = structuredClone(historical)
      restored.sceneId = input.sceneId
      restored.revision = current.revision + 1
      validateSnapshot(restored)
      await this.beforeCommit?.(restored,current,'restore')
      await this.recordVersion(current)
      await atomicJSON(this.path(input.sceneId), restored)
      return restored
    })
  }

  subscribe(sceneId: string, listener: (snapshot: SceneSnapshot) => void): () => void {
    let disposed = false
    let watcher: ReturnType<typeof watch> | undefined
    let pending = false
    let dirty = false
    let lastRevision = -1
    const deliver = async () => {
      if (disposed) return
      if (pending) { dirty = true; return }
      pending = true
      try {
        do {
          dirty = false
          const snapshot = await this.snapshot(sceneId)
          if (!disposed && snapshot.revision > lastRevision) {
            lastRevision = snapshot.revision
            listener(snapshot)
          }
        } while (dirty && !disposed)
      } finally { pending = false }
    }
    const path = this.path(sceneId)
    const scenesDirectory = join(this.directory, "scenes")
    // Install the watcher before returning.  The previous async mkdir().then()
    // left a race: a second SceneOperations instance could commit through its
    // atomic rename before this subscription had a watcher, so G02's real
    // cross-instance update notification timed out.  mkdirSync is only the
    // directory bootstrap; no scene data is written and the JSON commit still
    // owns the durable transaction.
    mkdirSync(scenesDirectory, { recursive: true })
    if (!disposed) {
      watcher = watch(scenesDirectory, () => {
        // Atomic JSON commits emit rename events and platform watchers may
        // omit the filename.  Delivering for any event is safe because
        // deliver() filters by sceneId/revision and coalesces bursts.
        void deliver().catch(error => console.error("场景订阅失败", path, error))
      })
      void deliver().catch(error => console.error("场景订阅失败", path, error))
    }
    return () => { disposed = true; watcher?.close() }
  }
}
