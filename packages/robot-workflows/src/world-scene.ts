import type { Context } from '@deepseek-ai/cordis'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import type { SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import type {} from '../../scene-kit/src/plugin.ts'
export interface WorldScene { snapshot: SceneSnapshot; owner: 'scene-store' | 'world-projection' }
/**
 * 读取活动世界的 Scene 快照。Provider 拥有该世界的原生 Scene 文档时（例如官方编译模型的
 * sim-contract 只读投影 sim.scene(worldId)），消费者只能读这份现存投影；其余世界仍由
 * SceneStore 拥有。这里不把投影写入 SceneStore，也不替换 world 的 sceneId。
 */
export async function worldScene(ctx: Context, sim: SimWorlds, world: WorldHandle, owner?: unknown): Promise<WorldScene> {
 if (typeof sim.scene === 'function') {
  const snapshot = await sim.scene(world.worldId)
  // 投影必须确实属于这个活动世界，否则宁可失败也不拿别的 Scene 顶替。
  if (snapshot.sceneId !== world.sceneId) throw new Error(`SCENE_WORLD_MISMATCH: 投影 ${snapshot.sceneId} 与 world ${world.worldId} 的 ${world.sceneId} 不一致`)
  return { snapshot, owner: 'world-projection' }
 }
 // 普通 Scene 由**本会话**的场景存储拥有：会话键来自发起这次调用的 agent，没有它就明确失败。
 return { snapshot: await ctx.scene.forSession(requireSessionId(owner, '工作流场景')).scene.snapshot(world.sceneId), owner: 'scene-store' }
}
