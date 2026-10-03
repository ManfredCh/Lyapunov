/**
 * 模型路由条目服务（`policyModels`）：把**服务器发现面**的模型元数据与**本机缓存事实**合成一份
 * `PackModelRoute[]`，供包面板与取件命令共读。
 *
 * 为什么需要它：面板/决策都跑在 Host 进程里，而它们与 policy-registry 的运行根**不是同一个**
 * （shell 拿的是运行根的 catalog/，policy-registry 拿的是 cacheRoot/）——面板自己拼不出权重缓存目录，
 * 也不该为了看一眼"这模型下过没有"去重算哈希。由**持有端点配置与 dataDirectory 的一方**
 * （policy-registry）出这一个只读服务，消费方不重复实现来源选择与缓存判定。
 *
 * 纪律：
 *  - 只出**元数据**：不发字节、不代发权重、不回落公开源；发现面匿名可查，所以这里也不带任何令牌。
 *  - 网络部分（discovery）按 TTL 记忆化：每步决策都发一次 HTTP 是纯浪费；本机缓存事实**每次现读**
 *    （读 manifest.json，不重算哈希、不访问来源），下载完成后无需失效通知也能立刻如实反映。
 *  - 端点不可达时**不编造**：有旧快照就给旧快照并标 `STALE`，没有就 `UNREACHABLE` 且 routes 为空
 *    （面板显示"读不到"，不是"没有模型"）。
 */
import { packDiscovery, type PackFetcher } from './pack-source.ts'
import { readPolicyCache, type PolicySource } from './source.ts'
import { FETCHABLE_PROVIDERS, type PackModelFace, type PackModelRoute } from './pack-contract.ts'
import { MODEL_FACE_UNDECLARED, packModelFace } from './model-face.ts'

export interface PackModelRoutesConfig {
  /** 权重缓存的运行根（policy-registry 的 dataDirectory）；缺省时缓存事实留 null（不猜目录）。 */
  dataDirectory?: string
  packEndpoint?: string
  fetcher?: PackFetcher
  /** discovery 快照有效期（默认 60s）。 */
  ttlMs?: number
  now?: () => number
}
export interface PackModelRoutesReceipt {
  status: 'OK' | 'STALE' | 'UNREACHABLE'
  /** 发现面不可达时的如实代码（不回显上游原文）；可达时为 null。 */
  code: string | null
  checkedAt: string
  routes: PackModelRoute[]
}
export interface PackModelRoutes {
  list(signal: AbortSignal): Promise<PackModelRoutesReceipt>
  /** 丢弃 discovery 快照（来源/内容改动后由调用方显式调用；缓存事实本来就不走快照）。 */
  invalidate(): void
}

// 服务以 `ctx.reflect.provide('policyModels', …)` 注册；消费方用 `ctx.get('policyModels')` 取。
declare module '@deepseek-ai/cordis' { interface Context { policyModels: PackModelRoutes } }

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
/**
 * 本机缓存事实：读的是**来源侧**坐标（`weights.resolution` 的上游 provider/modelId/revision）——
 * 模型字节落在 `policies/<provider>/<modelId>/<revision>/`，与包件缓存（`policies/packs/…`）不是一处，
 * 不混用。来源协议没有客户端取件通道（不在已实现来源内）时**不猜目录**，cache 留 null。
 */
async function cacheOf(dataDirectory: string | undefined, face: PackModelFace) {
  const source = face.source
  if (!dataDirectory || !source || !FETCHABLE_PROVIDERS.includes(source.provider)) return null
  const status = await readPolicyCache(dataDirectory, source.provider as PolicySource, source.modelId, source.revision)
  return { status: status.status, files: status.files, bytes: status.bytes, updatedAt: status.updatedAt }
}

export function createModelRoutes(config: PackModelRoutesConfig): PackModelRoutes {
  const ttlMs = config.ttlMs ?? 60_000, nowMs = config.now ?? (() => Date.now())
  /** 记忆化的只有**发现面**（网络）；缓存事实每次现读。 */
  let snapshot: { at: number; routes: Array<Omit<PackModelRoute, 'cache'>> } | null = null
  const load = async (signal: AbortSignal) => {
    const at = nowMs()
    if (snapshot && at - snapshot.at < ttlMs) return snapshot
    const discovery = await packDiscovery({ endpoint: config.packEndpoint, fetcher: config.fetcher, signal })
    const routes = (Array.isArray(discovery.packs) ? discovery.packs : []).map(row => ({ row: isObject(row) ? row : {} }))
      .filter(entry => typeof entry.row.packId === 'string' && /^[A-Za-z0-9_.-]+$/.test(entry.row.packId))
      .map(entry => ({
        packId: String(entry.row.packId),
        modelId: 'packs/' + String(entry.row.packId),
        aliases: (Array.isArray(entry.row.aliases) ? entry.row.aliases : []).map(item => isObject(item) ? String(item.alias ?? '') : '').filter(alias => alias.length > 0),
        // 端点没给模型面（旧服务端/形状不认识）⇒ 派生态 MODEL_FACE_UNDECLARED，不猜来源。
        model: packModelFace(isObject(entry.row.policy) ? entry.row.policy.model : null) ?? MODEL_FACE_UNDECLARED,
      }))
      .sort((a, b) => a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0)
    snapshot = { at, routes }
    return snapshot
  }
  const unreachable = (error: unknown, at: number): PackModelRoutesReceipt => {
    const code = (error as { code?: unknown })?.code
    return { status: snapshot ? 'STALE' : 'UNREACHABLE', code: typeof code === 'string' && code ? code : 'PACK_DISCOVERY_UNREACHABLE', checkedAt: new Date(at).toISOString(), routes: [] }
  }
  return {
    invalidate: () => { snapshot = null },
    async list(signal: AbortSignal): Promise<PackModelRoutesReceipt> {
      const at = nowMs()
      let loaded
      try { loaded = await load(signal) } catch (error) {
        if (signal.aborted) throw signal.reason ?? new Error('POLICY_CANCELLED')
        const stale = unreachable(error, at)
        // 有旧快照：如实给旧快照 + STALE（"读不到新的"），不把它当成"没有模型"。
        return snapshot ? { ...stale, routes: await Promise.all(snapshot.routes.map(async route => ({ ...route, cache: await cacheOf(config.dataDirectory, route.model) }))) } : stale
      }
      return {
        status: 'OK', code: null, checkedAt: new Date(at).toISOString(),
        routes: await Promise.all(loaded.routes.map(async route => ({ ...route, cache: await cacheOf(config.dataDirectory, route.model) }))),
      }
    },
  }
}
