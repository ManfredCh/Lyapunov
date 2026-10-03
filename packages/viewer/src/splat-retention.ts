import { PackedSplats, type SplatMesh } from "@sparkjsdev/spark"

/** 正式 Host 创建时绑定账户；账户切换会创建新 Host。会话与资源版本再各自分键。 */
export interface SplatRetentionScope { hostInstanceId: string; sessionId: string }
interface PackedData {
  numSplats: number
  packedArray: Uint32Array
  extra: Record<string, unknown>
  splatEncoding: PackedSplats["splatEncoding"]
}
export interface RetainedSplatData { base?: PackedData; lod?: PackedData }

export function splatRetentionBudget(deviceMemory?: number): number {
  const defaultBytes = 1024 ** 3
  return typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0
    ? Math.min(4 * defaultBytes, Math.floor(deviceMemory * 128 * 1024 ** 2)) : defaultBytes
}

/** 仅保留解码数组与编码参数。GPU纹理、Dyno、Scene、相机和物理对象不进入缓存。 */
function packedData(source: PackedSplats | undefined): PackedData | undefined {
  if (!source?.packedArray || source.numSplats <= 0) return
  const arrays = (value: unknown): unknown => ArrayBuffer.isView(value) ? value
    : Array.isArray(value) && value.every(ArrayBuffer.isView) ? [...value] : undefined
  const extra: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(source.extra)) {
    const retained = arrays(value)
    if (retained !== undefined) extra[name] = retained
  }
  return { numSplats: source.numSplats, packedArray: source.packedArray, extra, splatEncoding: source.splatEncoding ? { ...source.splatEncoding } : undefined }
}

export function retainSplatData(mesh: Pick<SplatMesh, "packedSplats">): RetainedSplatData | undefined {
  const base = packedData(mesh.packedSplats), lod = packedData(mesh.packedSplats?.lodSplats)
  return base || lod ? { base, lod } : undefined
}

export function restoreSplatData(data: RetainedSplatData): PackedSplats {
  return new PackedSplats({ ...data.base, lod: "quality", ...(data.lod ? { lodSplats: new PackedSplats(data.lod) } : {}) })
}

/** 按实际底层 ArrayBuffer 去重计费，不能把压缩文件大小或动态选择点数当占用。 */
export function retainedSplatFootprint(data: RetainedSplatData): {bufferBytes:number;payloadBytes:number;buffers:number;views:number} {
  const buffers = new Set<ArrayBufferLike>()
  const views=new Set<ArrayBufferView>()
  const add = (value: unknown) => {
    if (ArrayBuffer.isView(value)){buffers.add(value.buffer);views.add(value)}
    else if (Array.isArray(value)) for (const item of value) if (ArrayBuffer.isView(item)){buffers.add(item.buffer);views.add(item)}
  }
  for (const source of [data.base, data.lod]) if (source) {
    add(source.packedArray)
    for (const value of Object.values(source.extra)) add(value)
  }
  return {bufferBytes:[...buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0),payloadBytes:[...views].reduce((sum,view)=>sum+view.byteLength,0),buffers:buffers.size,views:views.size}
}
export function retainedSplatBytes(data:RetainedSplatData):number{return retainedSplatFootprint(data).bufferBytes}

/** 最多两份冷解码数据；取出即移交唯一所有权。GPU生命周期仍归每个Viewer。 */
export class SplatRetentionCache {
  private entries = new Map<string, { data: RetainedSplatData; bytes: number; expires: number }>()
  private transfers = new Map<string, Promise<void>>()
  private host?: string
  private timer?: ReturnType<typeof setTimeout>
  private hits = 0
  private misses = 0
  private oversized = 0
  private evictions = 0
  private waits = 0
  private lastRejected:{bufferBytes:number;payloadBytes:number;overBudgetBytes:number}|null=null
  constructor(readonly budgetBytes = splatRetentionBudget(), readonly ttlMs = 3_600_000, readonly maxEntries = 2, private readonly now = () => Date.now()) {}
  activateHost(host: string): void {
    if (this.host !== host) { this.clear(); this.host = host; this.hits = 0; this.misses = 0; this.oversized = 0; this.evictions = 0;this.waits=0;this.lastRejected=null }
  }
  private key(scope: SplatRetentionScope, resource: string): string { return JSON.stringify([scope.hostInstanceId, scope.sessionId, resource]) }
  private expire(): void {
    for (const [key, value] of this.entries) if (value.expires <= this.now()) this.entries.delete(key)
  }
  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.entries.size) return
    const expiry = Math.min(...[...this.entries.values()].map(value => value.expires))
    this.timer = setTimeout(() => { this.expire(); this.schedule() }, Math.max(0, expiry - this.now()))
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }
  put(scope: SplatRetentionScope, resource: string, data: RetainedSplatData): boolean {
    if (this.host !== scope.hostInstanceId) return false
    this.expire()
    const footprint=retainedSplatFootprint(data),bytes=footprint.bufferBytes,key=this.key(scope,resource)
    if (!bytes || bytes > this.budgetBytes) { this.oversized++;this.lastRejected={bufferBytes:bytes,payloadBytes:footprint.payloadBytes,overBudgetBytes:Math.max(0,bytes-this.budgetBytes)};return false }
    this.entries.delete(key)
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.report.retainedBytes + bytes > this.budgetBytes)) {
      this.entries.delete(this.entries.keys().next().value!); this.evictions++
    }
    this.entries.set(key, { data, bytes, expires: this.now() + this.ttlMs }); this.schedule()
    return true
  }
  take(scope: SplatRetentionScope, resource: string): RetainedSplatData | undefined {
    this.expire()
    if (this.host !== scope.hostInstanceId) { this.misses++; return }
    const key = this.key(scope, resource), value = this.entries.get(key)
    if (!value) { this.misses++; return }
    this.entries.delete(key); this.hits++; this.schedule()
    return value.data
  }
  /** 已让出归属的初始化仍由旧 Viewer 收尾；这里只登记它何时可取，不能共享活跃数组或 GPU。 */
  defer(scope: SplatRetentionScope, resource: string, completion: Promise<void>): void {
    if (this.host !== scope.hostInstanceId) return
    const key=this.key(scope,resource)
    if(this.transfers.has(key))return
    const pending=completion.then(()=>undefined,()=>undefined)
    this.transfers.set(key,pending)
    void pending.then(()=>{if(this.transfers.get(key)===pending)this.transfers.delete(key)})
  }
  /** 同身份快速返回先等旧初始化移交；取消只撤销等待，不能假称固定 SDK Worker 已停止。 */
  wait(scope:SplatRetentionScope,resource:string,signal:AbortSignal):Promise<void>|undefined {
    if(this.host!==scope.hostInstanceId)return
    const pending=this.transfers.get(this.key(scope,resource))
    if(!pending)return
    this.waits++
    return new Promise<void>((resolve,reject)=>{
      const cancelled=()=>{signal.removeEventListener('abort',cancelled);reject(signal.reason??new DOMException('泼溅缓存等待已取消','AbortError'))}
      if(signal.aborted){cancelled();return}
      signal.addEventListener('abort',cancelled,{once:true})
      void pending.then(()=>{signal.removeEventListener('abort',cancelled);resolve()})
    })
  }
  clear(): void { this.entries.clear(); this.transfers.clear(); if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  get report() {
    this.expire()
    return { entries: this.entries.size, pendingTransfers:this.transfers.size, retainedBytes: [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0), budgetBytes: this.budgetBytes, ttlMs: this.ttlMs, maxEntries: this.maxEntries, hits: this.hits, misses: this.misses, waits:this.waits, oversized: this.oversized, evictions: this.evictions,lastRejected:this.lastRejected }
  }
}

const deviceMemory = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory
export const retainedSplats = new SplatRetentionCache(splatRetentionBudget(deviceMemory))
if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("pagehide", () => retainedSplats.clear())
