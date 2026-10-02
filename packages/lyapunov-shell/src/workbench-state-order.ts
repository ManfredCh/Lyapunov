/**
 * 工作台后台 state 读取的「请求顺序 / 目标选择」判据（CR056）。
 *
 * refreshState 是后台读取：await 之后无条件 setScene 与重选 world。响应一旦迟到，
 * 它携带的就是「按更早事实生成的旧视图」，落地即把用户更新的显式选择、或更新的
 * Scene 版本 / world 代际拉回旧值。这里把判据抽成纯函数，只回答两个问题：
 *
 *  · isStaleStateResponse —— 这一次响应还能不能落地场景/world/缓存；
 *  · adoptWorldHandle     —— 同一个 world 的句柄该用新值还是保留已知的新代际。
 *
 * 判据只依赖「调用时的目标」与「落地时刻的视图身份」，不建全局 epoch / registry，
 * 也不与 Viewer 的 loadVersion 混为一个领域版本：后者只保护 Viewer.setScene 的
 * 回调顺序，与这里的 state 读取归属是两件事。
 */
export type SceneIdentity = { sceneId?: string; revision?: number }
export type WorldHandleIdentity = { worldId: string; worldGeneration: number; appliedSceneRevision: number }

export interface StateResponseArrival {
  /** 这次请求发出时的目标 Scene（显式目标优先，否则是调用时的当前视图）。 */
  target?: string
  /** 落地时刻仍在途的显式目标（loadScene / 官方投影自动采用 / 初始化选择）。 */
  pendingTarget?: string
  /** 落地时刻的当前视图 Scene（sceneRef 读取，即最新）。 */
  viewSceneId?: string
  /** 落地时刻的当前视图快照（用于同 Scene 的版本比较）。 */
  view?: SceneIdentity
  /** 这次响应携带的场景身份。 */
  payload?: SceneIdentity
}

/**
 * 这次后台响应是否已过时（过时则不得写场景、world、缓存与官方投影）。
 *
 * 三种过时形态：
 *  1. 有更新的显式目标在途，而这次响应打的是别的目标；
 *  2. 没有在途目标，但视图已经换到别的 Scene（用户的显式选择/官方退回已经落地）；
 *  3. 同一个 Scene 的更低 revision（Scene 版本单调递增，恢复也会产生新版本）。
 */
export function isStaleStateResponse(arrival: StateResponseArrival): boolean {
  const { target, pendingTarget, viewSceneId, view, payload } = arrival
  if (pendingTarget !== undefined && pendingTarget !== target) return true
  if (pendingTarget === undefined && viewSceneId !== undefined && target !== undefined && viewSceneId !== target) return true
  if (
    view?.sceneId !== undefined && payload?.sceneId !== undefined &&
    payload.sceneId === view.sceneId && payload.revision !== undefined && view.revision !== undefined &&
    payload.revision < view.revision
  ) return true
  return false
}

/**
 * 同一个 world 的句柄只按 (appliedSceneRevision, worldGeneration) 前进：旧 state 里的旧句柄
 * 不得把已采用的已应用版本 / 代际拉回旧值。与 sim-contract 的 adoptHandle 同一判据。
 * 换了 worldId（用户改选、world 重建）则照常采用新句柄，不在这里挡。
 */
export function adoptWorldHandle<T extends WorldHandleIdentity>(found: T | undefined, known: T | undefined): T | undefined {
  if (!found || !known || found.worldId !== known.worldId) return found
  if (found.appliedSceneRevision < known.appliedSceneRevision) return known
  if (found.appliedSceneRevision === known.appliedSceneRevision && found.worldGeneration < known.worldGeneration) return known
  return found
}

/**
 * 官方投影分支最后一次 await 之后的落地核对：这次取到的投影是否仍属于发起请求时的那个 world 身份。
 *
 * `baseline` 是请求发出时那份 state 里的官方 world 句柄，`live` 是落地时刻仍在列的同一个 world。
 * 只认三种事实：
 *  · 仍在列（调用方用 status !== "closed" 过滤，这里只需 worldId 对得上）；
 *  · 代际没有前进（worldGeneration 一致）——代际变了说明句柄身份已换，不能把旧代际的投影挂上去；
 *  · 已应用版本正是这次取到的投影版本（appliedSceneRevision === projectionRevision）——
 *    不相等说明在途期间世界已经前进，这次投影已过时：宁可丢弃，让下一轮按新事实重新取值，
 *    也不在这里抢写一个半旧的视图。
 *
 * 服务端在 /scene 的官方投影路径上强制 snapshot.revision === world.appliedSceneRevision
 * （否则 OFFICIAL_SCENE_REVISION_MISMATCH 直接失败），所以这个等式在请求发出时成立；
 * 落地时刻不再成立只可能是在途期间世界前进——正是要拦的那种迟到投影。
 */
export function projectionWorldLanded(
  live: WorldHandleIdentity | undefined,
  baseline: WorldHandleIdentity | undefined,
  projectionRevision: number | undefined,
): boolean {
  if (!live || !baseline || live.worldId !== baseline.worldId) return false
  if (live.worldGeneration !== baseline.worldGeneration) return false
  if (projectionRevision !== undefined && live.appliedSceneRevision !== projectionRevision) return false
  return true
}
