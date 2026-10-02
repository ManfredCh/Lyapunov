/** 导入后的单次视觉方向检查：只关联本会话/窗口/场景版本，不保存 Scene 或图像真值。 */
import { randomUUID } from "node:crypto"

export type OrientationStatus = "queued" | "checking" | "correct" | "corrected" | "uncertain" | "unchecked"
export type OrientationAdjustment = "asset" | "camera"
export type OrientationTurnStop = "requested" | "confirmed" | "ended" | "shared"
export interface OrientationTarget {
  sessionKey: string
  sceneId: string
  revision: number
  clientId?: string
  rootEntityIds: string[]
  origin: "tool" | "ui"
}
export interface OrientationObservation {
  sceneId: string
  sceneRevision: number
  clientId: string
  captureId: string
  camera?: unknown
}
export interface OrientationFace {
  checkId: string
  status: OrientationStatus
  sceneId: string
  sceneRevision: number
  clientId?: string
  rootEntityIds: string[]
  attempts: number
  turnStop?: OrientationTurnStop
  reason?: string
}
export interface ImportedVisualTarget { sceneId: string; revision: number; rootEntityIds: string[] }

/** 只识别真实导入/挂载回执；scene_edit 与后续重绘绝不成为新检查的触发器。 */
export function importedVisualTarget(tool: string, value: unknown): ImportedVisualTarget | undefined {
  if (!["scene_import", "scene_mount", "scene_asset_acquire", "scene_import_url", "scene_environment_import"].includes(tool) || !value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  if (tool === "scene_asset_acquire" && row.kind === "streamed-sog") {
    const scene = row.scene as { sceneId?: unknown; revision?: unknown } | undefined
    if (typeof scene?.sceneId === "string" && Number.isInteger(scene.revision) && typeof row.groupEntityId === "string") return { sceneId: scene.sceneId, revision: scene.revision as number, rootEntityIds: [row.groupEntityId] }
    return undefined
  }
  const snapshot = row.snapshot as { sceneId?: unknown; revision?: unknown; entities?: unknown } | undefined
  if (typeof snapshot?.sceneId !== "string" || !Number.isInteger(snapshot.revision) || !Array.isArray(snapshot.entities) || typeof row.entityId !== "string") return undefined
  const entity = snapshot.entities.find(item => item && typeof item === "object" && (item as { entityId?: unknown }).entityId === row.entityId) as { components?: { visual?: { kind?: unknown } } } | undefined
  if (entity?.components?.visual?.kind !== "mesh" && entity?.components?.visual?.kind !== "splat" && entity?.components?.visual?.kind !== "group") return undefined
  return { sceneId: snapshot.sceneId, revision: snapshot.revision as number, rootEntityIds: [row.entityId] }
}
interface Check extends OrientationFace {
  sessionKey: string
  key: string
  origin: OrientationTarget["origin"]
  initialCaptureId?: string
  messageId?: string
  claimedTurn?: number
  dedicatedTurn?: boolean
  turnSignal?: AbortSignal
  lastAppliedSequence?: number
  observations: Array<OrientationObservation & { sequence: number }>
  timer?: ReturnType<typeof setTimeout>
}

const MAX_ATTEMPTS = 2
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000
interface OrientationClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}
const systemClock: OrientationClock = { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer) }
const publicFace = (row: Check): OrientationFace => ({
  checkId: row.checkId, status: row.status, sceneId: row.sceneId, sceneRevision: row.sceneRevision,
  ...(row.clientId ? { clientId: row.clientId } : {}), rootEntityIds: [...row.rootEntityIds], attempts: row.attempts,
  ...(row.turnStop ? { turnStop: row.turnStop } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
})
const keyOf = (target: OrientationTarget): string => `${target.sessionKey}:${target.sceneId}:${target.revision}:${[...target.rootEntityIds].sort().join(",")}`

export class OrientationChecks {
  private rows = new Map<string, Check>()
  private byKey = new Map<string, string>()
  private latest = new Map<string, string>()
  private sequence = 0

  constructor(private readonly onQueuedExpired?: (sessionKey: string, messageId: string) => void, private readonly queueTimeoutMs = QUEUE_TIMEOUT_MS, private readonly clock: OrientationClock = systemClock) {}

  existing(target: OrientationTarget): OrientationFace | undefined {
    const id = this.byKey.get(keyOf(target))
    const row = id ? this.rows.get(id) : undefined
    return row?.sessionKey === target.sessionKey ? publicFace(row) : undefined
  }

  begin(target: OrientationTarget): { face: OrientationFace; created: boolean } {
    if (!target.sessionKey || !target.sceneId || !Number.isInteger(target.revision) || target.revision < 0 || !target.rootEntityIds.length || new Set(target.rootEntityIds).size !== target.rootEntityIds.length) throw new Error("ORIENTATION_TARGET_INVALID")
    const key = keyOf(target), duplicate = this.byKey.get(key)
    if (duplicate) return { face: publicFace(this.rows.get(duplicate)!), created: false }
    const previous = this.latest.get(target.sessionKey)
    if (previous) {
      const prior = this.rows.get(previous)
      if (prior && (prior.status === "queued" || prior.status === "checking")) this.settle(prior, "uncertain", "较新的导入已替代这次方向检查")
    }
    const checkId = `orient_${randomUUID()}`
    const row: Check = {
      checkId, key, sessionKey: target.sessionKey, origin: target.origin, sceneId: target.sceneId, sceneRevision: target.revision,
      ...(target.clientId ? { clientId: target.clientId } : {}), rootEntityIds: [...target.rootEntityIds], status: "queued", attempts: 0, observations: [],
    }
    this.rows.set(checkId, row); this.byKey.set(key, checkId); this.latest.set(target.sessionKey, checkId)
    return { face: publicFace(row), created: true }
  }

  get(sessionKey: string, checkId?: string): OrientationFace | undefined {
    const row = this.rows.get(checkId ?? this.latest.get(sessionKey) ?? "")
    return row?.sessionKey === sessionKey ? publicFace(row) : undefined
  }

  pendingMessageId(sessionKey: string, checkId: string): string | undefined {
    const row = this.require(sessionKey, checkId)
    return row.status === "queued" ? row.messageId : undefined
  }

  private require(sessionKey: string, checkId: string): Check {
    const row = this.rows.get(checkId)
    if (!row || row.sessionKey !== sessionKey) throw new Error("ORIENTATION_CHECK_NOT_IN_SESSION")
    return row
  }

  private settle(row: Check, status: OrientationStatus, reason?: string): OrientationFace {
    row.status = status
    if (reason) row.reason = reason
    if (row.timer) { this.clock.clearTimeout(row.timer); row.timer = undefined }
    return publicFace(row)
  }

  unchecked(sessionKey: string, checkId: string, reason: string): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "queued" && row.status !== "checking") return publicFace(row)
    return this.settle(row, "unchecked", reason)
  }

  /** Stop 只撤本插件自己的 Inbox 消息；已提交过姿态时保留实际 Scene，状态记未确认。 */
  cancel(sessionKey: string, checkId: string, reason = "用户停止了方向检查"): { face: OrientationFace; messageId?: string } {
    const row = this.require(sessionKey, checkId)
    const messageId = row.messageId
    if (row.status !== "queued" && row.status !== "checking") return { face: publicFace(row), ...(messageId ? { messageId } : {}) }
    return { face: this.settle(row, row.attempts > 0 ? "uncertain" : "unchecked", reason), ...(messageId ? { messageId } : {}) }
  }

  initial(sessionKey: string, checkId: string, observation: OrientationObservation): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "queued" || observation.sceneId !== row.sceneId || observation.sceneRevision !== row.sceneRevision || row.clientId && row.clientId !== observation.clientId) throw new Error("ORIENTATION_INITIAL_IMAGE_STALE")
    row.clientId = observation.clientId
    row.initialCaptureId = observation.captureId
    row.observations.push({ ...observation, sequence: ++this.sequence })
    return publicFace(row)
  }

  queued(sessionKey: string, checkId: string, messageId: string): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "queued" || !row.initialCaptureId || !messageId) throw new Error("ORIENTATION_MESSAGE_NOT_READY")
    row.messageId = messageId
    row.timer = this.clock.setTimeout(() => { if (row.status === "queued") { this.settle(row, "unchecked", "图像消息未进入模型步骤，方向未检查"); this.onQueuedExpired?.(row.sessionKey, messageId) } }, this.queueTimeoutMs)
    row.timer.unref?.()
    return publicFace(row)
  }

  /** 图像被原生 Inbox 领取后归属该 turn，寿命由真实 turn/end 决定。 */
  claimed(sessionKey: string, messageId: string, turn: number): OrientationFace | undefined {
    const row = this.rows.get(this.latest.get(sessionKey) ?? "")
    if (!row || row.status !== "queued" || row.messageId !== messageId || !Number.isInteger(turn) || turn < 1) return undefined
    if (row.timer) { this.clock.clearTimeout(row.timer); row.timer = undefined }
    row.status = "checking"
    row.claimedTurn = turn
    return publicFace(row)
  }

  /** 同一步或后续真正收到用户输入时撤独占；内部插件提示继续属于自动回合。 */
  claimedOther(sessionKey: string, turn: number, messageId: string, takesOver: boolean): void {
    const row = this.rows.get(this.latest.get(sessionKey) ?? "")
    if (takesOver && row?.status === "checking" && row.claimedTurn === turn && row.messageId !== messageId) row.dedicatedTurn = false
  }

  preStep(sessionKey: string, turn: number, step: number, messages: readonly { id: string; takesOver: boolean }[], signal: AbortSignal): void {
    const row = this.rows.get(this.latest.get(sessionKey) ?? "")
    if (!row || row.status !== "checking" || row.claimedTurn !== turn) return
    if (step === 1) {
      row.dedicatedTurn = row.origin === "ui" && messages.some(message => message.id === row.messageId) && !messages.some(message => message.id !== row.messageId && message.takesOver)
      if (row.dedicatedTurn) row.turnSignal = signal
    } else if (messages.some(message => message.id !== row.messageId && message.takesOver)) row.dedicatedTurn = false
  }

  dedicatedTurn(sessionKey: string, checkId: string, signal?: AbortSignal): number | undefined {
    const row = this.require(sessionKey, checkId)
    return row.status === "checking" && row.dedicatedTurn === true && row.turnSignal === signal && !signal?.aborted ? row.claimedTurn : undefined
  }

  markTurnStop(sessionKey: string, checkId: string, state: OrientationTurnStop): OrientationFace {
    const row = this.require(sessionKey, checkId)
    row.turnStop = state
    return publicFace(row)
  }

  /** 原生 Session 的持久 turn/end 是最终边界；已结束检查只更新停止回执。 */
  endTurn(sessionKey: string, turn: number, reason: { kind: string; reason?: { kind?: string } }): void {
    for (const row of this.rows.values()) {
      if (row.sessionKey !== sessionKey || row.claimedTurn !== turn) continue
      if (row.turnStop === "requested") row.turnStop = reason.kind === "aborted" && reason.reason?.kind === "user" ? "confirmed" : "ended"
      if (row.status === "checking") this.settle(row, reason.kind === "aborted" && row.attempts === 0 ? "unchecked" : "uncertain", "原生模型回合结束，方向未确认")
    }
  }

  /** 只有 turn/end 未到达的异常 idle 才走兜底，不以墙钟猜测活跃回合。 */
  idle(sessionKey: string): void {
    const row = this.rows.get(this.latest.get(sessionKey) ?? "")
    if (!row || row.status !== "checking") return
    if (row.turnStop === "requested") row.turnStop = "ended"
    this.settle(row, "uncertain", "原生模型回合已空闲，方向未确认")
  }

  /** 从真实 viewer_observe 成功 Tool 结果回收，不接受路径或调用参数冒充图像。 */
  observed(sessionKey: string, observation: OrientationObservation): void {
    const row = this.rows.get(this.latest.get(sessionKey) ?? "")
    if (!row || row.status !== "checking" || !row.initialCaptureId || row.sceneId !== observation.sceneId || row.sceneRevision !== observation.sceneRevision || row.clientId !== observation.clientId) return
    if (row.observations.some(item => item.captureId === observation.captureId)) return
    row.observations.push({ ...observation, sequence: ++this.sequence })
  }

  reserveAdjustment(sessionKey: string, checkId: string, kind: OrientationAdjustment): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "checking" || !row.initialCaptureId) throw new Error("ORIENTATION_IMAGE_REQUIRED")
    if (row.attempts >= MAX_ATTEMPTS) throw new Error("ORIENTATION_ATTEMPT_LIMIT: 最多两次修正与复拍；方向未确认时保留当前姿态")
    if (kind !== "asset" && kind !== "camera") throw new Error("ORIENTATION_ADJUSTMENT_INVALID")
    row.attempts++
    return publicFace(row)
  }

  applied(sessionKey: string, checkId: string, kind: OrientationAdjustment, revision: number): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "checking" || row.attempts < 1 || !Number.isInteger(revision) || kind === "asset" && revision <= row.sceneRevision || kind === "camera" && revision !== row.sceneRevision) throw new Error("ORIENTATION_APPLY_REVISION_INVALID")
    row.sceneRevision = revision
    row.lastAppliedSequence = ++this.sequence
    return publicFace(row)
  }

  finish(sessionKey: string, checkId: string, decision: "correct" | "corrected" | "uncertain", captureId?: string): OrientationFace {
    const row = this.require(sessionKey, checkId)
    if (row.status !== "checking") throw new Error("ORIENTATION_CHECK_ALREADY_ENDED")
    if (decision === "uncertain") return this.settle(row, "uncertain", "画面不足以确定方向，未继续改动")
    if (decision === "correct") {
      if (row.attempts !== 0 || !row.initialCaptureId || captureId !== row.initialCaptureId) throw new Error("ORIENTATION_CORRECT_IMAGE_REQUIRED")
      return this.settle(row, "correct")
    }
    const appliedSequence = row.lastAppliedSequence
    if (decision !== "corrected" || !appliedSequence) throw new Error("ORIENTATION_RECHECK_REQUIRED")
    const image = row.observations.find(item => item.captureId === captureId && item.sequence > appliedSequence && item.sceneRevision === row.sceneRevision)
    if (!image) throw new Error("ORIENTATION_RECHECK_REQUIRED: 修正后须由同窗口新 revision 的 viewer_observe 图像复核")
    return this.settle(row, "corrected")
  }
}

/** 与真实图像附件同一条消息发送；文本只给任务/身份，不替模型下视觉结论。 */
export function orientationPrompt(face: OrientationFace, captureId: string, camera: unknown): string {
  return `[Automatic product orientation check; not a new user instruction] The imported visual environment was captured by this session's native Viewer in the attached real image. `+
    `Scene ${face.sceneId} rev ${face.sceneRevision}, window ${face.clientId ?? "Unspecified"}, imported roots ${face.rootEntityIds.join(", ")}, `+
    `check ${face.checkId}, initial captureId ${captureId}, camera readback ${JSON.stringify(camera ?? null)}. `+
    `Inspect the image and distinguish camera roll/viewing pose from an inverted or sideways resource. If it is already upright, report correct through viewer_orientation_finish with the initial captureId; do not edit the Scene. `+
    `If the image is blank, occluded, fragmentary, or insufficient, report uncertain and preserve the pose. If the image clearly shows an incorrect resource orientation, read the root's current transform with scene_inspect, then use viewer_orientation_adjust(kind=asset) to submit a new absolute xyzw quaternion only for these imported roots. `+
    `For a camera problem use viewer_orientation_adjust(kind=camera), which reuses the existing camera application. At most two corrections are allowed; after each, use viewer_observe with the same window and new revision to inspect a new real image. `+
    `Report corrected through viewer_orientation_finish with the new captureId only after the new image is upright. Preserve originals, other entities, units, collisions, and robots. `+
    `Prior user constraints such as preserving the pose or read-only work take priority. Do not hard-code 180 degrees or treat a successful capture as evidence of correct orientation.`
}
