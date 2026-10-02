/**
 * N190／DEV-034：把官方 world 的既校验投影落成**会话场景命名空间内的 scene 文档**，使既有 `scene_open`
 * 与 3D 面板能打开它（此前投影只活在内存里，Viewer 侧对照不可达）。
 *
 * 2026-09-26（W24／DEV-027）：本模块原先的名字与 §4.7 旧 owner 的一个裸词探针撞名（探针分组见
 * `script/gates/g17.ts:58` 的 `legacy.opencode-bridge`），G17 的 `legacy_owner_residue_readonly` /
 * `legacy_owner_modules_absent_from_clean_tree` 会把**产品自己的这个模块**判成旧平台残留。
 * 处置是**不改门、改产品侧命名**：文件与符号统一为 `scene-projection` / `SceneProjection*`
 * （裸词正是门该拦的东西；为了消一个假阳性去削弱真守卫是不可接受的）。
 *
 * 口径：
 *  · **只复用既有实现**——`SceneStore`（路径/版本/校验）与 `atomicJSON`（原子写）都来自 `@lyapunov/scene-kit`，
 *    本模块**不自己 writeFile、不自己做 tmp+rename**，也不新增错误类；
 *  · `sceneDataRoot` 缺失 ⇒ **不猜路径**，明确返回未配置原因（保持既有行为，不落盘）；
 *  · 落盘失败 ⇒ 原样带出既有错误原文（如 `SCENE_HISTORY_CONFLICT`／`SCENE_BINDING_INVALID`／fs 错误），
 *    由调用方决定是否中断；返回值让失败**不可能静默**。
 */
import { join } from 'node:path'
import { atomicJSON, SceneStore, validateSnapshot } from '@lyapunov/scene-kit'
import type { SceneSnapshot } from '@lyapunov/contracts'
import { validateSceneSnapshot } from './projection.ts'

export interface SceneProjectionConfig { sceneDataRoot?: string; sessionId?: string }

export type SceneProjectionResult =
  | { ok: true; path: string; revision: number; entityCount: number; sceneId: string }
  | { ok: false; error: string; code: 'BENCHMARK_SCENE_DATA_ROOT_UNSET' | 'BENCHMARK_SCENE_SESSION_UNSET' | 'BENCHMARK_SCENE_PROJECTION_INVALID' | 'BENCHMARK_SCENE_WRITE_FAILED' }

/** 官方 scene id → **会话场景命名空间**的 id：官方 id 形如 `libero_object/pick_up_the_alphabet_soup…`（`/` 是官方
 * 命名空间分隔符），而命名空间自己的 id 契约是 scene-kit `safeId`（`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`，`/` 非法）。
 * 映射是**确定性的**：对已合法的 id 恒等（只做替换/去头/截断），非法字符折叠成 `-`，空结果由调用方按投影非法处理。
 * 内存投影里的**官方 sceneId 不变**；落盘 id 通过回执 `sceneId` 如实带出。 */
export function namespaceSceneId(sceneId: string): string {
  return sceneId.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 160)
}

/** 校验 → 写活文档 → 记版本历史。任何失败都带原文返回，绝不静默。 */
export async function persistProjectedScene(config: SceneProjectionConfig, scene: unknown): Promise<SceneProjectionResult> {
  const root = config.sceneDataRoot?.trim()
  if (!root) return { ok: false, code: 'BENCHMARK_SCENE_DATA_ROOT_UNSET', error: 'BENCHMARK_SCENE_DATA_ROOT_UNSET: 未注入 sceneDataRoot（worlds 根）；不猜路径、不落盘（投影仍留在内存，既有行为不变）' }
  // N204：场景文档落在**会话**命名空间 `<worldsRoot>/sessions/<sessionId>/scenes/`（scene-kit 的 SceneStore 会在
  // 其 directory 下拼 `scenes/`，见 scene-kit/src/operations.ts:202 `new SceneStore(this.layout.worlds)` 的会话 layout）。
  // sessionId 取不到 ⇒ **不猜目录**、明确报未配置。
  const sessionId = config.sessionId?.trim()
  if (!sessionId) return { ok: false, code: 'BENCHMARK_SCENE_SESSION_UNSET', error: 'BENCHMARK_SCENE_SESSION_UNSET: 投影层拿不到 sessionId（会话场景命名空间按会话分目录）；不猜路径、不落盘' }
  const directory = join(root, 'sessions', sessionId)
  let snapshot: SceneSnapshot
  try {
    snapshot = validateSceneSnapshot(scene)
  } catch (error) {
    return { ok: false, code: 'BENCHMARK_SCENE_PROJECTION_INVALID', error: String((error as Error)?.message ?? error) }
  }
  // N221：官方 id 带 `/` ⇒ 落盘前映射成命名空间合法 id（见 namespaceSceneId）；映射为空 ⇒ 不猜、不落盘，按投影非法报。
  const landedSceneId = namespaceSceneId(snapshot.sceneId)
  if (!landedSceneId) return { ok: false, code: 'BENCHMARK_SCENE_PROJECTION_INVALID', error: `INVALID_ID: ${snapshot.sceneId}` }
  const landed: SceneSnapshot = { ...snapshot, sceneId: landedSceneId }
  try {
    validateSnapshot(landed)
  } catch (error) {
    return { ok: false, code: 'BENCHMARK_SCENE_PROJECTION_INVALID', error: String((error as Error)?.message ?? error) }
  }
  const store = new SceneStore(directory)
  try {
    await atomicJSON(store.path(landed.sceneId), landed)
    await store.recordVersion(landed)
  } catch (error) {
    return { ok: false, code: 'BENCHMARK_SCENE_WRITE_FAILED', error: String((error as Error)?.message ?? error) }
  }
  return { ok: true, path: store.path(landed.sceneId), revision: landed.revision, entityCount: landed.entities.length, sceneId: landed.sceneId }
}
