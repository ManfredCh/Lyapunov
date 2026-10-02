import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProcessSimProvider, type SimWorkerLaunchHook } from '../../sim-contract/src/python-transport.ts'
import type { WorldOptions } from '../../sim-contract/src/index.ts'
import { resolveMuJoCoGlBackend, type MuJoCoGlBackend } from '../../sim-contract/src/mujoco-gl.ts'
import type { SceneSnapshot, WorldHandle, WorldWarning } from '../../lyapunov-contracts/src/types.ts'
import { SceneCollisionBuilder, type SceneCollisionBuildResult, type SceneCollisionCompilation } from './scene-collision/index.ts'
export interface MuJoCoConfig {
  pythonPath?: string; workerPath?: string; renderBackend?: MuJoCoGlBackend
  /**
   * 按会话的执行接线（装配方造）：worker 收到的会话身份、会话运行根与原生有效权限策略都由此而来。
   * 不注入 = 保持历史直连 spawn（没有会话沙箱接线，调用方不得据此声称沙箱已生效）。
   */
  launch?: SimWorkerLaunchHook
}
export class MuJoCoProvider extends ProcessSimProvider {
  /**
   * 场景碰撞：绑定实体（可信 splat/mesh 几何绑定）→ 分层碰撞补丁编译器。
   * 编译结果按世界缓存，键 = sourceKey + 绑定实体所在 Scene revision；
   * 构建器内部另有 canonical 源 LRU 与按内容键的编译缓存兜底。
   */
  private readonly collisionBuilder = new SceneCollisionBuilder()
  private readonly collisionWorlds = new Map<string, { key: string; result: SceneCollisionBuildResult }>()
  constructor(config: MuJoCoConfig = {}) {
    const here = dirname(fileURLToPath(import.meta.url))
    super({ pythonPath: config.pythonPath ?? process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(here, '../../../.runtime/sim-python/bin/python'), workerPath: config.workerPath ?? resolve(here, '../python/worker.py'), engineName: 'MuJoCo', env: { MUJOCO_GL: resolveMuJoCoGlBackend(config.renderBackend) }, ...(config.launch === undefined ? {} : { launch: config.launch }) })
  }
  /**
   * open 期碰撞缓存以占位键登记（此时 worldId 未定），open 返回后迁到真实 worldId。
   * `signal` 直接交给传输层：取消只结束本次尚未交付的 open（worker 与已交付的世界不动）。
   * 未交付的 open 写下的缓存条目由 `revertOwnWrites` 按**本次自己的写入清单**回滚——不是
   * 「进 open 前的那个对象变了就删」：同一 worldId 上并行的 sync 会在本 open 之后写一个新对象，
   * 按身份比较删除就会把别人写的条目一起清掉（实测可复现，见 test/open-cancel.test.ts）。
   */
  override async open(snapshot: SceneSnapshot, options: WorldOptions = {}, signal?: AbortSignal): Promise<WorldHandle> {
    const handle = await super.open(snapshot, options, signal)
    const pending = this.collisionWorlds.get('')
    if (pending) {
      this.collisionWorlds.delete('')
      this.collisionWorlds.set(handle.worldId, pending)
    }
    return handle
  }
  /** 只有**本次 open 自己写下**且仍未被别人改写的条目才回滚；`before` 为空即这次写之前不存在。 */
  protected override revertOwnWrites(writes: { key: string; after: unknown; before: unknown }[]): void {
    for (const write of [...writes].reverse()) {
      if (this.collisionWorlds.get(write.key) !== write.after) continue
      if (write.before === undefined) this.collisionWorlds.delete(write.key)
      else this.collisionWorlds.set(write.key, write.before as { key: string; result: SceneCollisionBuildResult })
    }
  }
  /** 缓存写入一律经这里：顺手把「改了什么、改之前是什么」报给本次 open 的写入清单。 */
  private writeCollisionEntry(key: string, entry: { key: string; result: SceneCollisionBuildResult } | undefined,
    written?: (key: string, after: unknown, before: unknown) => void): void {
    const before = this.collisionWorlds.get(key)
    if (entry === undefined) this.collisionWorlds.delete(key)
    else this.collisionWorlds.set(key, entry)
    if (entry !== before) written?.(key, entry, before)
  }
  /** 为 sync/open 追加 collisionPatches（无可信绑定或编译失败时无该键，worker 行为不变）。 */
  protected override async syncArgsExtras(worldId: string, snapshot: SceneSnapshot, _options: { forceRebuild?: boolean } = {}, signal?: AbortSignal,
    written?: (key: string, after: unknown, before: unknown) => void): Promise<Record<string, unknown> | undefined> {
    // 已取消的 open 不发请求：不编译，也不写任何缓存（晚到的 extras 不许污染下一次 open）。
    if (signal?.aborted) return undefined
    const { plan, warnings } = this.collisionBuilder.plan(snapshot)
    if (!plan) {
      // 无绑定实体不告警；有绑定但门禁/解析失败的告警在此收集。
      if (warnings.length) this.writeCollisionEntry(worldId, { key: '', result: { compilation: null, warnings } }, written)
      else this.writeCollisionEntry(worldId, undefined, written)
      return undefined
    }
    const key = `${plan.sourceKey}#${plan.revision}`
    const cached = this.collisionWorlds.get(worldId)
    const result = cached && cached.key === key ? cached.result : await this.collisionBuilder.build(snapshot)
    // 编译期间被取消：这次 open 不会发出，编译结果不进缓存（否则会迁给下一个 world）。
    if (signal?.aborted) return undefined
    this.writeCollisionEntry(worldId, { key, result }, written)
    if (!result.compilation) return undefined
    const patch: SceneCollisionCompilation = result.compilation
    return { collisionPatches: patch }
  }
  /** 把碰撞编译告警并入 sync 句柄的 warnings（SCENE_COLLISION_* 前缀，纯加法）。 */
  protected override syncHandleExtras(handle: WorldHandle, worldId: string): WorldHandle {
    const entry = this.collisionWorlds.get(worldId)
    if (!entry || entry.result.warnings.length === 0) return handle
    const existing = handle.warnings ?? []
    const seen = new Set(existing.map(item => `${item.code}${item.entityId ?? ''}${item.message}`))
    const merged: WorldWarning[] = [...existing]
    for (const item of entry.result.warnings) {
      const next: WorldWarning = item.entityId === undefined ? { code: item.code, message: item.message } : { code: item.code, entityId: item.entityId, message: item.message }
      const key = `${next.code}${next.entityId ?? ''}${next.message}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(next)
    }
    return { ...handle, warnings: merged }
  }
  override async close(worldId: string): Promise<void> {
    try { await super.close(worldId) } finally { this.collisionWorlds.delete(worldId) }
  }
  override async dispose(): Promise<void> {
    this.collisionWorlds.clear()
    await super.dispose()
  }
}
