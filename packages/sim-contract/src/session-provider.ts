import type { SimService, SimWorlds } from './index.ts'
import { createSessionWorldProjection, type SessionWorldProjectionCache, type SessionWorldProjectionIdentity } from '../../lyapunov-contracts/src/session-world-projection.ts'

/**
 * 每会话一套世界服务的工厂：**一个会话 = 一个 Provider 实例 = 一个 worker 进程**。
 *
 * 这是"会话对应隔离的虚拟环境/进程映射"的落点：本地同名 worldId 在不同会话里各自成立，
 * 某会话的取消/关闭/进程失败只影响它自己的 worker，别的会话的世界、帧与后续采集不受影响
 * （修前只有一个 Host 级 Provider 与一张 world 表，任何会话都能寻址到别人的世界）。
 *
 * 惰性启动：第一次为该会话取世界服务时才建实例（MuJoCo 首次 open 才起 python worker；
 * Isaac 冷启动更贵，同样只在真的要用时起）。引擎安装、解释器路径、缓存等**不可变**依赖
 * 仍由装配方共享传入，不按会话复制。
 *
 * 释放边界：`release(key)` 只释放一个会话（会话真正结束时由知道这件事的装配方调用）；
 * `dispose()` 是 Host 级卸载，释放全部实例。DSH 的 agent 会因为空闲/断连被 dispose 再 resume，
 * 所以这里**不**自动挂 `session/disposed`：否则用户切走标签页就会杀掉正在跑的仿真。
 *
 * 释放的真实结论不被吞掉：`instance.dispose()` 失败时错误原样抛给调用方，实例留在本工厂的
 * 归属表里等下一次收尾；**释放中或释放失败的会话不得重建实例**——旧 worker 还没收干净就新建一个，
 * 等于同一会话同时有两个进程，正是本类要排除的那种共享。只有真的收干净且工厂尚未开始 Host 级
 * `dispose()`，同一个会话键才回到"可以重建"的状态；Host 级释放一开始就永久关闭新建入口，失败仅允许重试收尾。
 */
export interface SessionSimFactoryOptions {
  /** 为一个会话建一套世界服务。同一个会话只会被调用一次（实例由本类缓存）。 */
  create(sessionKey: string): SimWorlds
  /** 可选稳定元数据缓存；不保存 worker、帧或实时就绪状态。 */
  projectionCache?: SessionWorldProjectionCache
  /** 返回当前 session header identity，用于拒绝跨运行根/继承历史的旧记录。 */
  projectionIdentity?(sessionKey: string): SessionWorldProjectionIdentity
  /** 释放该会话实例后的额外收尾（可选）。 */
  onRelease?(sessionKey: string): void | Promise<void>
}

const messageOf = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)

function projectableWorlds(
  sessionKey: string,
  worlds: SimWorlds,
  cache: SessionWorldProjectionCache,
  identity: SessionWorldProjectionIdentity,
): SimWorlds {
  return new Proxy(worlds, {
    get(target, property, receiver) {
      if (property === 'open') {
        return async (...args: Parameters<SimWorlds['open']>) => {
          const result = await target.open(...args)
          cache.set(createSessionWorldProjection(identity, result))
          return result
        }
      }
      if (property === 'sync') {
        return async (...args: Parameters<SimWorlds['sync']>) => {
          const result = await target.sync(...args)
          cache.set(createSessionWorldProjection(identity, result))
          return result
        }
      }
      if (property === 'close') {
        return async (worldId: string) => {
          const result = await target.close(worldId)
          cache.delete(sessionKey, worldId)
          return result
        }
      }
      if (property === 'dispose') {
        return async () => {
          const result = await target.dispose()
          cache.release(sessionKey)
          return result
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

export class SessionSimFactory implements SimService {
  private readonly instances = new Map<string, SimWorlds>()
  /** 正在释放的会话（结论未定）：这期间同一会话不得重建实例。 */
  private readonly retiring = new Map<string, Promise<void>>()
  /** 释放失败、仍归本工厂收尾的实例：会话键保留到真的收干净（失败不静默丢弃）。 */
  private readonly unfinished = new Map<string, { instance: SimWorlds; failure: unknown }>()
  /** Host 级 dispose 一旦开始就永久关闭新实例入口，即使旧实例收尾失败。 */
  private disposed = false
  constructor(private readonly options: SessionSimFactoryOptions) {}

  forSession(sessionKey: string): SimWorlds {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : ''
    if (!key) throw new Error('SESSION_SCOPE_UNAVAILABLE: 世界服务必须按会话取用（拒绝落到共享实例）')
    const existing = this.instances.get(key)
    if (existing) return existing
    if (this.retiring.has(key)) throw new Error(`SESSION_RELEASING: 会话 ${key} 正在释放，收尾完成前不得重建实例`)
    const unfinished = this.unfinished.get(key)
    if (unfinished) throw new Error(`SESSION_RELEASE_FAILED: 会话 ${key} 的实例释放失败（${messageOf(unfinished.failure)}），收尾完成前不得重建实例`)
    if (this.disposed) throw new Error('SIM_FACTORY_DISPOSED: SessionSimFactory 已开始 Host 级释放，不再创建新的会话实例')
    const created = this.options.create(key)
    const owned = this.options.projectionCache && this.options.projectionIdentity
      ? projectableWorlds(key, created, this.options.projectionCache, this.options.projectionIdentity(key))
      : created
    this.instances.set(key, owned)
    return owned
  }

  /** 只读事实：该会话是否已经起了可用实例（不隐式创建）。 */
  has(sessionKey: string): boolean { return this.instances.has(sessionKey) }

  /** 当前已有实例的会话键（供诊断/管理读，不产生副作用）。 */
  sessions(): string[] { return [...this.instances.keys()] }

  /** 只释放一个会话的实例与其 worker；其它会话的实例一步不动。失败原样抛出，不冒充成功。 */
  async release(sessionKey: string): Promise<void> {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : ''
    const instance = this.instances.get(key)
    if (instance) { await this.retire(key, instance); return }
    const retiring = this.retiring.get(key)
    // 释放已经开始：把那次释放的真实结论（可能是失败）还给调用方，而不是当作空操作。
    if (retiring) { await retiring; return }
    const unfinished = this.unfinished.get(key)
    if (unfinished) await this.retire(key, unfinished.instance)
  }

  /** Host 级释放：先永久禁止新建，再释放全部实例；任何一个没收干净都如实报错，可重复调用重试收尾。 */
  async dispose(): Promise<void> {
    this.disposed = true
    const owned = [...this.instances.entries()], unfinished = [...this.unfinished.entries()]
    const inFlight = [...this.retiring.entries()]
    this.instances.clear()
    const jobs: Array<[string, Promise<void>]> = [
      ...owned.map(([key, instance]): [string, Promise<void>] => [key, this.retire(key, instance)]),
      ...unfinished.map(([key, entry]): [string, Promise<void>] => [key, this.retire(key, entry.instance)]),
      // 正在释放中的实例不重入 `instance.dispose()`（同一实例不可能被释放两次），只等它自己的结论。
      ...inFlight.map(([key, settling]): [string, Promise<void>] => [key, settling]),
    ]
    const results = await Promise.allSettled(jobs.map(([, job]) => job))
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${jobs[index]![0]}: ${messageOf(result.reason)}`] : [])
    if (failures.length > 0) throw new Error(`SIM_SESSION_RELEASE_FAILED: ${failures.length} 个会话的实例未收干净（仍归本工厂收尾）：${failures.join('；')}`)
  }

  /**
   * 释放一个实例并收尾。真实失败原样抛出，同时把实例留在 `unfinished` 里等下一次收尾：
   * 摘掉会话键的前提只有一个——`instance.dispose()` 真的成功了。
   */
  private retire(key: string, instance: SimWorlds): Promise<void> {
    this.instances.delete(key)
    this.unfinished.delete(key)
    const settling = (async () => {
      let failure: unknown
      try { await instance.dispose() } catch (error) { failure = error }
      if (failure === undefined) {
        try { await this.options.onRelease?.(key) } catch (error) { failure = error }
      }
      this.retiring.delete(key)
      if (failure !== undefined) {
        this.unfinished.set(key, { instance, failure })
        throw failure
      }
    })()
    // 调用方可能不 await（例如 Host 卸载路径）：失败已由本工厂的归属表保留，这里不产生未处理的拒绝。
    settling.catch(() => undefined)
    this.retiring.set(key, settling)
    return settling
  }
}
