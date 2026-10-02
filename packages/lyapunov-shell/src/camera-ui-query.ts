import type { workbenchAPI } from "./workbench-api.ts"
import type { CameraWorldIdentity } from "./capture-panel.tsx"

/** UI 清单缓存只保存原生查询结果；同作用域并发共用一次读取，不进入 Commands/AgentLoop。 */
export class CameraUIReadCache<T> {
  private entries = new Map<string, { at: number; value?: T; pending?: Promise<T> }>()
  private disposed = false
  constructor(private ttlMs = 300, private limit = 12) {}
  read(key: string, load: () => Promise<T>, force = false): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("CAMERA_QUERY_DISPOSED"))
    const previous = this.entries.get(key)
    if (previous?.pending) return previous.pending
    if (!force && previous?.value !== undefined && Date.now() - previous.at < this.ttlMs) return Promise.resolve(previous.value)
    const entry: { at: number; value?: T; pending?: Promise<T> } = { at: Date.now() }
    this.entries.set(key, entry)
    entry.pending = Promise.resolve().then(() => {
      if (this.disposed) throw new Error("CAMERA_QUERY_DISPOSED")
      return load()
    }).then(value => {
      if (this.disposed) throw new Error("CAMERA_QUERY_DISPOSED")
      if (!this.disposed && this.entries.get(key) === entry) {
        entry.value = value; entry.at = Date.now(); entry.pending = undefined
        for (const [oldKey, old] of this.entries) {
          if (this.entries.size <= this.limit) break
          if (oldKey !== key && !old.pending) this.entries.delete(oldKey)
        }
      }
      return value
    }, error => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error })
    return entry.pending
  }
  dispose(): void { this.disposed = true; this.entries.clear() }
}
/** 步号变化但真实位姿/镜头/可用性未变时不重复刷新 UI；原回执时刻保持真实。 */
export function cameraListFingerprint(value: unknown): string {
  return JSON.stringify(value, (key, row) => ["frameId", "stepIndex", "simTime"].includes(key) ? undefined : row)
}
export function queryNativeCameraList(api: ReturnType<typeof workbenchAPI>, identity: CameraWorldIdentity, signal: AbortSignal, force = false): Promise<any> {
  const query = new URLSearchParams({ sceneId: identity.sceneId ?? "", sceneRevision: String(identity.sceneRevision), worldId: identity.worldId ?? "", expectedGeneration: String(identity.worldGeneration) })
  if (force) query.set("force", "1")
  return api.request("camera-list?" + query.toString(), { signal })
}
