/**
 * 「发出时身份 → 异步返回后落地」的归属核对。CR025 同类问题的共同形态：
 * 命令返回后无条件 setScene/setWorld，而命令在途期间用户可能已经切到别的 Scene/世界，
 * 于是迟到结果被写进用户的新视图与新选择。
 *
 * 这里把三条链抽成具名函数，便于单独审查与测试：
 *  · runImportFollowthrough —— 文件面板「导入资产」链（scene_import → 资产列表刷新 → sim_sync）；
 *  · runEditFollowthrough  —— 查看器拖拽提交（scene_edit）；
 *  · runRestoreFollowthrough —— 版本历史「恢复」（scene_restore）。
 *
 * 规则一致：每个 await 边界返回后都重新读取视图身份（ref 值，调用即最新），
 * 只有与发出时逐字相同才把结果写回视图；身份已变只提示、不写视图。
 * 命令本身是否成功、是否已提交（导入落地、编辑提交、恢复提交、同步结果）完全按真实结果保留，
 * 不撤销、不重试、不回滚；也不创建/关闭任何世界，不新增 owner/全局 epoch。
 * 身份随既有 selection 元数据通道携带（见 workbench-api.ts 的 command 第三个参数
 * 与插件命令路由的归属核对）。
 */
export type ImportIdentity = { sceneId?: string; worldId?: string; revision?: number }
/** 随内部命令请求发出的“发出时”身份；无运行中世界时不带 worldId。 */
export type ImportSelection = { sceneId: string; worldId?: string }

export interface SceneWritePort {
  /** 当前视图身份（ref 读取：调用即最新，不依赖渲染快照）。 */
  identity: () => ImportIdentity
  /** 落地场景快照（仅在归属核对通过时才会被调用）。 */
  applyScene: (snapshot: unknown) => void
}

export interface ImportFollowthroughPort {
  /** 当前视图身份（ref 读取：调用即最新，不依赖渲染快照）。 */
  identity: () => ImportIdentity
  /**
   * 内部命令通道；selection 是“命令发出时”的身份元数据，不进入命令自身 input。
   * input 是本链实际发出的请求体（scene_import 带 path，sim_sync 带 worldId）；
   * 返回值按 unknown 透传，形状由消费点按实际结果声明（不虚构泛型 T）。
   */
  command: (name: string, input: { sceneId: string; path?: string; worldId?: string }, selection?: ImportSelection) => Promise<unknown>
  /** 落地导入结果（仅在身份未变时才会被调用）。 */
  applyImported: (result: { snapshot: unknown; entityId: string }) => void
  refreshAssets: () => Promise<unknown>
  /** 落地跟随同步的 world 句柄（仅在身份未变时才会被调用）。 */
  applyWorld: (world: unknown) => void
  notify: (text: string) => void
}

export interface ImportFollowthroughRequest {
  path: string
  /** 发出时的场景身份（点击那一刻视图里的场景）。 */
  sceneId: string
  /** 发出时的世界身份；没有运行中的世界时缺省。 */
  worldId?: string
  /** 身份已变时的用户可见说明（由调用方按语言组装，本函数只决定何时说）。 */
  movedNotice: (sceneId: string) => string
}

export interface ImportFollowthroughOutcome {
  imported: unknown
  /** 导入结果是否写进了视图。 */
  adopted: boolean
  /** sim_sync 是否真的发出并成功返回（是真实提交，不代表结果写回了视图）。 */
  synced: boolean
  /** 同步结果是否写回视图（synced 为真但边界核对失败时是 false）。 */
  appliedWorld: boolean
  /** 该链上是否出现过身份变化而被拦下的落地（如实反映“结果没进当前视图”）。 */
  stale: boolean
}

const sameIdentity = (value: ImportIdentity, dispatched: ImportSelection): boolean =>
  value.sceneId === dispatched.sceneId && value.worldId === dispatched.worldId

const identitySelection = (sceneId: string, worldId: string | undefined): ImportSelection =>
  worldId ? { sceneId, worldId } : { sceneId }

/**
 * 迟到结果的视图归属核对：视图仍停在发出时的 Scene 才写回，返回写回结果。
 * 同 Scene 时再按版本单调收口：后台轮询可能已经采用了更高版本（或在途的更高版本提交先落地），
 * 更低版本的迟到快照不得把视图拉回旧版本（查看器 setScene 持有同一条判据）。
 * 已完成的提交/恢复/编辑结果由调用方原样返回，不因这里没写视图而回滚。
 */
export type SceneWriteOutcome = "applied" | "scene-changed" | "superseded"

export function applySceneIfCurrent(port: SceneWritePort, dispatchedSceneId: string, snapshot: unknown): SceneWriteOutcome {
  const identity = port.identity()
  if (identity.sceneId !== dispatchedSceneId) return "scene-changed"
  const arrived = Number((snapshot as { revision?: unknown } | null | undefined)?.revision)
  const view = Number(identity.revision)
  if (Number.isFinite(arrived) && Number.isFinite(view) && arrived < view) return "superseded"
  port.applyScene(snapshot)
  return "applied"
}

export async function runImportFollowthrough(
  port: ImportFollowthroughPort,
  request: ImportFollowthroughRequest,
): Promise<ImportFollowthroughOutcome> {
  // 判据锚在发出时：命令体与 selection 元数据都用点击那一刻的身份。
  const dispatched = identitySelection(request.sceneId, request.worldId)
  const imported = await port.command("scene_import", { sceneId: dispatched.sceneId, path: request.path }, dispatched)
  // 每个 await 边界后都要重新核对：完成时身份必须与发出时逐字相同（无 world 也是一种身份），
  // 任一不同都说明视图已被改动，迟到结果只提示、不写视图——导入已提交的 Scene 结果本身不受影响。
  if (!sameIdentity(port.identity(), dispatched)) {
    port.notify(request.movedNotice(dispatched.sceneId))
    return { imported, adopted: false, synced: false, appliedWorld: false, stale: true }
  }
  const result = imported as { snapshot: unknown; entityId: string }
  port.applyImported({ snapshot: result.snapshot, entityId: result.entityId })
  await port.refreshAssets()
  // 资产列表刷新期间用户改选：导入已落地（adopted 如实为 true），但不发这次过期的同步。
  if (!sameIdentity(port.identity(), dispatched)) {
    port.notify(request.movedNotice(dispatched.sceneId))
    return { imported, adopted: true, synced: false, appliedWorld: false, stale: true }
  }
  if (!dispatched.worldId) return { imported, adopted: true, synced: false, appliedWorld: false, stale: false }
  // 同步目标只用发出时的 worldId（当前身份与其一致才走到这里），不取完成时刻的 worldRef。
  const world = await port.command("sim_sync", { worldId: dispatched.worldId, sceneId: dispatched.sceneId }, dispatched)
  // 同步在途期间用户改选：这次同步是真实提交（synced 如实为 true），但结果不再写进新视图。
  if (!sameIdentity(port.identity(), dispatched)) {
    port.notify(request.movedNotice(dispatched.sceneId))
    return { imported, adopted: true, synced: true, appliedWorld: false, stale: true }
  }
  port.applyWorld(world)
  return { imported, adopted: true, synced: true, appliedWorld: true, stale: false }
}

export interface EditFollowthroughPort extends SceneWritePort {
  /** input 是 scene_edit 的实际请求体；返回值按 unknown 透传（快照原样交回查看器）。 */
  command: (name: string, input: { sceneId: string; expectedRevision: number; patch: Array<{ op: "update"; entityId: string; changes: { transform: unknown } }> }) => Promise<unknown>
  notify: (text: string) => void
}

export interface EditFollowthroughRequest {
  /** 发出时的场景身份（查看器提交那一刻的场景）。 */
  sceneId: string
  expectedRevision: number
  entityId: string
  transform: unknown
  movedNotice: (sceneId: string) => string
  /** 同 Scene 更新版本已落地、快照被版本单调拦下的说明；缺省沿用 movedNotice。 */
  supersededNotice?: (sceneId: string) => string
}

export interface EditFollowthroughOutcome {
  /** scene_edit 的真实返回（已成提交，调用方按原样返回给查看器）。 */
  snapshot: unknown
  adopted: boolean
  stale: boolean
}

/** 查看器拖拽提交（scene_edit）：返回快照仍照常交给查看器，只决定是否写工作台视图。 */
export async function runEditFollowthrough(
  port: EditFollowthroughPort,
  request: EditFollowthroughRequest,
): Promise<EditFollowthroughOutcome> {
  const snapshot = await port.command("scene_edit", {
    sceneId: request.sceneId,
    expectedRevision: request.expectedRevision,
    patch: [{ op: "update", entityId: request.entityId, changes: { transform: request.transform } }],
  })
  const outcome = applySceneIfCurrent(port, request.sceneId, snapshot)
  if (outcome !== "applied") {
    port.notify(outcome === "superseded" ? (request.supersededNotice ?? request.movedNotice)(request.sceneId) : request.movedNotice(request.sceneId))
    return { snapshot, adopted: false, stale: true }
  }
  return { snapshot, adopted: true, stale: false }
}

export interface RestoreFollowthroughPort extends SceneWritePort {
  /** input 是 scene_restore 的实际请求体；返回值按 unknown 透传，版本号在消费点声明。 */
  command: (name: string, input: { sceneId: string; revision: number; expectedRevision: number }) => Promise<unknown>
  refreshHistory: (sceneId: string) => Promise<unknown>
  notify: (text: string) => void
}

export interface RestoreFollowthroughRequest {
  /** 发出时的场景身份（点「恢复」那一刻的场景）。 */
  sceneId: string
  revision: number
  expectedRevision: number
  movedNotice: (sceneId: string) => string
  supersededNotice?: (sceneId: string) => string
  /** 恢复成功且视图仍属于该 Scene 时的说明（恢复出的真实版本号）。 */
  restoredNotice: (restoredRevision: number | undefined) => string
}

export interface RestoreFollowthroughOutcome {
  /** scene_restore 的真实返回（已成提交，调用方按原样返回）。 */
  snapshot: unknown
  adopted: boolean
  stale: boolean
}

/** 版本历史「恢复」（scene_restore）：恢复本身已提交；只按发出时 Scene 决定写不写视图。 */
export async function runRestoreFollowthrough(
  port: RestoreFollowthroughPort,
  request: RestoreFollowthroughRequest,
): Promise<RestoreFollowthroughOutcome> {
  const snapshot = await port.command("scene_restore", {
    sceneId: request.sceneId,
    revision: request.revision,
    expectedRevision: request.expectedRevision,
  })
  const outcome = applySceneIfCurrent(port, request.sceneId, snapshot)
  if (outcome !== "applied") {
    port.notify(outcome === "superseded" ? (request.supersededNotice ?? request.movedNotice)(request.sceneId) : request.movedNotice(request.sceneId))
    return { snapshot, adopted: false, stale: true }
  }
  // 结果形状在消费点声明：这条链只用版本号做提示，快照本体原样交回调用方。
  const restored = snapshot as { revision?: number }
  // 历史列表本来就按 sceneId 自查（refreshHistory 内部核对），这里保持原有的“先刷新再提示”顺序。
  await port.refreshHistory(request.sceneId)
  port.notify(request.restoredNotice(restored.revision))
  return { snapshot, adopted: true, stale: false }
}
