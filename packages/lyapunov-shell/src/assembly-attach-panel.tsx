/**
 * R-012／§2.9／§2.10：Attach to 二级面板——源部件/工具 → 目标机器人腕部/安装位。
 *
 * 边界：
 *  · 首屏四项身份由当前选择 + 真实 `robot_describe`（按需读取目标/源 body、site）补全，**绝不**静默猜根原点；
 *  · 用户显式选择的 body origin / site / 表面拾取点优先；唯一真实有效 site 才自动带出；
 *  · Preview 只调只读 `robot_assembly_preview`；Apply 只把预览返回的 `applyInput` 原样交给
 *    既有 `robot_set_base`（手动与 LLM 同一条提交路径）；
 *  · 旧 preview Promise 由请求序号 + 存活标记 + 选择上下文防串，卸载/换源后绝不回写 ghost；
 *  · 源 describe 失败**照实显示**并给可操作重试；
 *  · 提取门禁只针对**源内部部件**，不限制目标连杆；内部部件不冒充整机源。
 */
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import type {ReactNode} from "react"
import type {RobotAnchorPose, RobotAssemblyCheckResult, RobotAssemblyPreviewResult, RobotSetBaseInput, RobotSourceMount, RobotTargetMount} from "../../lyapunov-contracts/src/robot-authoring.ts"
import {validRobotPose} from "../../lyapunov-contracts/src/robot-authoring.ts"
import type {Translate} from "./entity-editor.tsx"

export interface AssemblyAttachSource { entityId: string; name: string }
export interface AssemblyAttachTarget { entityId: string; name: string }
/** 真实 body/site 事实，来自 `robot_describe`；面板不缓存第二份目录。 */
export interface AssemblyTargetDescription { bodies: Array<{ name: string; root: boolean }>; sites: Array<{ name: string; bodyName: string }> }
/** 源选择落在某个内部部件（Components 选中）时，明确它需要先提取，不把整机当源。 */
export interface AssemblySourcePart { name: string; root: boolean }
/**
 * Replace 模式：源部件是**新件**，目标是旧件所在真实 body/安装位；旧件必须停放到一个明确的世界位姿。
 * 目标安装面 = 旧件已记录的安装位（目标 body 局部 pose）；新件自己的源安装面由本面板的
 * saved/native/picked sourceMount 参与预览公式，**绝不**复制旧件根绑定当新件绑定。
 */
export interface AssemblyReplaceRequest {
  oldEntityId: string
  oldName: string
  targetEntityId: string
  targetBodyName: string
  /** 旧件安装位的目标 body 局部 pose（来自旧 baseBinding.target）。 */
  targetMountPose: RobotAnchorPose
  /** 默认停放世界位姿（离开安装位）；用户可改。 */
  defaultParkingPose: RobotAnchorPose
}
export interface AssemblyReplaceSubmit {
  newEntityId: string
  newBase: RobotSetBaseInput['base']
  oldEntityId: string
  oldParkingPose: RobotAnchorPose
  oldFree: boolean
}
/**
 * Apply/Replace 的真实保存/同步回执（宿主投影的窄业务字段）。`saved` 恒为 true；`syncRequired`
 * 与 `sync` 分开，缺 `sync` 时不冒称已同步；`revision` 是已落盘的 Scene 版本。
 */
export interface AssemblyApplyOutcome {
  status?: string
  saved?: boolean
  sync?: string
  syncRequired?: boolean
  sceneId?: string
  revision?: number
  reason?: string
}
/**
 * 面板只产出**装配选择**；world/scene/revision/generation 由宿主从当前真实身份补齐，
 * 面板绝不自己编一个 identity（避免把旧版本/旧世界当成可 Apply 依据）。
 */
export interface AssemblyAttachSelection {
  sourceEntityId: string
  sourceMount: RobotSourceMount
  targetEntityId: string
  targetBodyName: string
  targetMount: RobotTargetMount
  pair?: RobotAnchorPose
}
/**
 * 独立二级页面自己要能看见的**世界就绪事实**（由宿主从真实 world/scene 状态算出）。
 * `ready` 为 false 时页面必须自己给"准备/同步并预览"下一步，不能依赖被隐藏概览里的旧入口。
 */
export interface AssemblyWorldReadiness {
  ready: boolean
  phase: string
  code?: string
  detail?: string
  /** 当前文档版本与 world 已应用版本；用于如实说明差异。 */
  sceneRevision?: number
  appliedRevision?: number
  generation?: number
}
/**
 * 停放拾取的窄控制器：宿主画布上的点选/确认/取消都经它进入**同一份**停放草稿，
 * 于是 Preview/Apply 消费的数据与 ghost 显示的数据始终一致。
 */
export interface AssemblyParkingPickController {
  setPoint(point: [number, number, number]): void
  confirm(): void
  cancel(): void
}
export interface AssemblyAttachPanelProps {
  tr: Translate
  source: AssemblyAttachSource
  targetCandidates: AssemblyAttachTarget[]
  /** 按需读取目标实体真实 body/site；缺 world/未同步时由调用方明确失败，面板照实显示。 */
  describeTarget(entityId: string): Promise<AssemblyTargetDescription>
  /** 只读预览；宿主补 current scene/world/revision/generation 后调 `robot_assembly_preview`。 */
  preview(selection: AssemblyAttachSelection): Promise<RobotAssemblyPreviewResult>
  /** 同一 `robot_set_base` 提交路径；入参就是预览返回的 applyInput；返回真实保存/同步回执。 */
  apply(applyInput: RobotSetBaseInput): Promise<AssemblyApplyOutcome | undefined>
  /** 预览变化通知宿主（null 表示取消/清理）：宿主据此驱动 Viewer 临时 ghost。 */
  onGhost?(result: RobotAssemblyPreviewResult | null): void
  /** 显式框选目标机器人与安装 ghost；只移动查看相机，取消仍恢复原视角。 */
  onFramePreview?(): void
  describeSource?(): Promise<AssemblyTargetDescription>
  savedSourceMount?: RobotSourceMount
  /** 表面拾取得到的、已在源根帧中表达的安装点（由宿主从 Viewer 真实几何换算）。 */
  pickedSourceMount?: RobotSourceMount
  /** 用户点击“在模型表面拾取安装点”时请求宿主进入拾取模式。 */
  onRequestPick?(): void
  /** Components 当前选中的源内部部件；非根时明确要求先提取。 */
  sourcePart?: AssemblySourcePart
  /** 显式保存当前源安装点为可复用点（窄 Scene 元数据，绑定资源版本）。 */
  onSaveMount?(mount: RobotSourceMount): Promise<unknown>
  /** 清除已保存点。 */
  onClearMount?(): Promise<unknown>
  /** 真实检查读回（native 绑定/相对位姿/关节/接触/动作回执）。 */
  onCheck?(): Promise<unknown>
  /** V8-34：刚完成的挂接直接复用真实 history/undo，不让用户滚进长 Configuration 历史。 */
  onUndoLast?(): Promise<unknown>
  check?: RobotAssemblyCheckResult
  /** 提供了 replace 时进入“替换”交互：Apply 改为一次 CAS 替换 + 旧件停放。 */
  replace?: AssemblyReplaceRequest
  onReplace?(submit: AssemblyReplaceSubmit): Promise<AssemblyApplyOutcome | undefined>
  /** 停放 ghost 通知宿主（null 清理）；只展示临时几何，真实停放只由 onReplace 提交。 */
  onParkingGhost?(pose: RobotAnchorPose | null): void
  /**
   * 当前真实世界/应用版本事实；独立页面据此给"准备/同步并预览"下一步，不依赖被隐藏概览里的旧入口。
   * 缺省（undefined）＝调用方未提供，页面不断言世界就绪。
   */
  world?: AssemblyWorldReadiness
  /** 复用既有 world 生命周期：缺 world 时准备/启动，未同步时同步；失败照实抛出由页面显示。 */
  prepareWorld?(): Promise<unknown>
  /** 用户点击"在画布上选择停放位置"时，请求宿主进入画布停放拾取模式。 */
  onRequestParkingPick?(): void
  /** 停放拾取结束（确认或取消）通知宿主收起画布浮条并恢复面板。 */
  onParkingPickEnd?(): void
  /** 把停放拾取控制器交给宿主；宿主画布上的点选/确认/取消都经它进入本面板的同一份停放草稿。 */
  onParkingPickController?(controller: AssemblyParkingPickController | undefined): void
  onBack?(): void
}

const bodyFromKey = (key: string) => key.slice(key.indexOf("|") + 1)
const poseText = (positionM: number[], quaternionXyzw: number[]) => `[${positionM.map(value => value.toFixed(4)).join(", ")}] m · [${quaternionXyzw.map(value => value.toFixed(4)).join(", ")}]`
const IDENTITY_PAIR: RobotAnchorPose = {positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1]}
const samePair = (a: RobotAnchorPose, b: RobotAnchorPose) => a.positionM.every((value, index) => value === b.positionM[index]) && a.quaternionXyzw.every((value, index) => value === b.quaternionXyzw[index])
const messageOf = (value: unknown) => value instanceof Error ? value.message : String(value)
/** 保存/同步回执 → 本轮用户可见结果；syncRequired、已同步、回执缺 sync 三种情况分开，不用恒定 "submitted" 代替。 */
const applyStage = (value: AssemblyApplyOutcome | undefined, tr: Translate): {text: string; saved: boolean; status: 'applied' | 'sync-required' | 'sync-unknown'; revision?: number; sceneId?: string; reason?: string} | undefined => {
  const receipt = value
  if (!receipt || typeof receipt !== 'object' || receipt.saved !== true) return undefined
  const revision = typeof receipt.revision === 'number' ? receipt.revision : undefined
  const suffix = revision !== undefined ? ` · rev ${revision}` : ''
  const sceneId = typeof receipt.sceneId === 'string' ? receipt.sceneId : undefined
  if (receipt.syncRequired === true) return {text: tr(`装配声明已保存 · 物理待同步${suffix}`, `Assembly saved · Physics sync required${suffix}`), saved: true, status: 'sync-required', revision, sceneId, reason: typeof receipt.reason === 'string' ? receipt.reason : undefined}
  if (receipt.sync === 'SYNCED' || receipt.syncRequired === false) return {text: tr(`装配声明已保存并已同步${suffix}`, `Assembly saved and synced${suffix}`), saved: true, status: 'applied', revision, sceneId}
  return {text: tr(`装配声明已保存${suffix}；物理同步状态未在回执中给出。`, `Assembly saved${suffix}; the receipt did not report the physics sync state.`), saved: true, status: 'sync-unknown', revision, sceneId, reason: typeof receipt.reason === 'string' ? receipt.reason : undefined}
}

export function AssemblyAttachPanel({tr, source, targetCandidates, describeTarget, preview, apply, onGhost, onFramePreview, describeSource, savedSourceMount, pickedSourceMount, onRequestPick, sourcePart, onSaveMount, onClearMount, onCheck, onUndoLast, check, replace, onReplace, onParkingGhost, world, prepareWorld, onRequestParkingPick, onParkingPickEnd, onParkingPickController, onBack}: AssemblyAttachPanelProps): ReactNode {
  const [targetId, setTargetId] = useState(targetCandidates[0]?.entityId ?? "")
  const [targetDescription, setTargetDescription] = useState<AssemblyTargetDescription | undefined>(undefined)
  const [sourceDescription, setSourceDescription] = useState<AssemblyTargetDescription | undefined>(undefined)
  const [targetBodyName, setTargetBodyName] = useState("")
  const [targetSite, setTargetSite] = useState("")
  const [sourceBodyKey, setSourceBodyKey] = useState("")
  const [sourceSite, setSourceSite] = useState("")
  const [pair, setPair] = useState<RobotAnchorPose>(IDENTITY_PAIR)
  const [result, setResult] = useState<RobotAssemblyPreviewResult | undefined>(undefined)
  const [stage, setStage] = useState("")
  // 本轮 Apply 的真实保存/同步结果：与预览 "未应用" 状态互斥；syncRequired 时给内联同步入口。
  const [syncRequired, setSyncRequired] = useState<{revision?: number; sceneId?: string; reason?: string} | undefined>(undefined)
  /** 本轮已提交的真实结果文案：非空即表示这份预览已被消费，不再显示"未应用"。 */
  const [applied, setApplied] = useState<string | undefined>(undefined)
  const [applyWasSaved, setApplyWasSaved] = useState(false)
  const [resultContext, setResultContext] = useState<{replace?: {oldName: string; parking: RobotAnchorPose; oldFree: boolean}}>()
  const [undoBusy,setUndoBusy]=useState(false),[undoNote,setUndoNote]=useState('')
  /** 首屏只报回执能证明的那一档；详情保留在按需区域。 */
  const [applyOutcome, setApplyOutcome] = useState<"applied" | "sync-required" | "sync-unknown" | "submitted" | "undone" | undefined>(undefined)
  const [error, setError] = useState("")
  const [sourceError, setSourceError] = useState("")
  const [targetError, setTargetError] = useState("")
  const [sourceAttempt, setSourceAttempt] = useState(0)
  const [targetAttempt, setTargetAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [mountBusy, setMountBusy] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  // Replace：旧件去向草稿（明确世界停放 pose + 可选 free）。缺省用宿主给出的、已离开安装位的默认值。
  const [parking, setParking] = useState<RobotAnchorPose>(replace?.defaultParkingPose ?? IDENTITY_PAIR)
  const [oldFree, setOldFree] = useState(false)
  const [parkingError, setParkingError] = useState("")
  // describe 回调可能每次渲染都是新函数：用 ref 固定，避免把它放进依赖造成循环。
  const describeTargetRef = useRef(describeTarget); describeTargetRef.current = describeTarget
  const describeSourceRef = useRef(describeSource); describeSourceRef.current = describeSource
  const onGhostRef = useRef(onGhost); onGhostRef.current = onGhost
  const onParkingGhostRef = useRef(onParkingGhost); onParkingGhostRef.current = onParkingGhost
  // 旧 preview Promise 的防串：存活标记 + 请求序号。卸载/任一选择变化都让在途结果作废。
  const aliveRef = useRef(true)
  const requestRef = useRef(0)
  const busyRequestRef = useRef(0)
  const selectionTokenRef = useRef("")
  const currentSourceRef = useRef(source.entityId); currentSourceRef.current = source.entityId
  // 停放拾取：进入前的草稿快照、最近一次画布点、以及给宿主的稳定控制器。所有方法只读 ref，避免闭包过期。
  const parkingRef = useRef<RobotAnchorPose>(parking); parkingRef.current = parking
  const pickBeforeRef = useRef<RobotAnchorPose>()
  const pickPointRef = useRef<[number, number, number]>()
  const pickEndRef = useRef(onParkingPickEnd); pickEndRef.current = onParkingPickEnd
  const trRef = useRef(tr); trRef.current = tr
  /** Alignment 折叠的 DOM 句柄：首屏短状态可一键展开，不把源选择藏到找不着。 */
  const alignmentRef = useRef<HTMLDetailsElement>(null)
  const parkingControllerRef = useRef<AssemblyParkingPickController>({
    setPoint: point => {
      pickPointRef.current = point
      onParkingGhostRef.current?.({...parkingRef.current, positionM: [point[0], point[1], point[2]]})
    },
    confirm: () => {
      const point = pickPointRef.current
      if (point) {
        const next: RobotAnchorPose = {...parkingRef.current, positionM: [point[0], point[1], point[2]]}
        setParking(next)
        setParkingError(validRobotPose(next) ? "" : trRef.current("停放位姿非法", "invalid parking pose"))
        onParkingGhostRef.current?.(next)
      }
      pickPointRef.current = undefined
      pickEndRef.current?.()
    },
    cancel: () => {
      const before = pickBeforeRef.current
      if (before) { setParking(before); onParkingGhostRef.current?.(before) }
      pickPointRef.current = undefined
      pickEndRef.current?.()
    },
  })
  // Replace 模式下目标由旧件决定（真实 entity/body + 旧件记录的安装位），不在下拉里自由改。
  // Replace 完成后宿主会先撤下 replace prop；保持同一个真实目标，避免把合法提交误判成换目标。
  useEffect(()=>{if(replace)setTargetId(replace.targetEntityId)},[replace?.targetEntityId])
  const effectiveTargetId = replace ? replace.targetEntityId : targetId
  const effectiveTargetBodyName = replace ? replace.targetBodyName : targetBodyName
  // 宿主没提供世界事实时页面不断言；提供了就只认 `ready`。
  const worldReady = world ? world.ready : true
  // 只读 Preview 的落地身份与提交结果分开：world 轮询重建对象不失效，代次/修订/就绪资格变化才换 owner。
  const previewWorldKey = JSON.stringify([world?.ready, world?.generation, world?.sceneRevision, world?.appliedRevision])
  const previewWorldRef = useRef({key: previewWorldKey})
  if (previewWorldRef.current.key !== previewWorldKey) previewWorldRef.current = {key: previewWorldKey}
  const previewWorld = previewWorldRef.current
  const previewPendingRef = useRef<{world: typeof previewWorld; sequence: number}>()
  const applyPendingRef = useRef<number>()
  useEffect(() => {
    // 已展示的未提交预览也不能跨世界继续挂 ghost；提交中的 result 留作本次回执的关系详情。
    if (!applied) {
      onGhostRef.current?.(null); onParkingGhostRef.current?.(null)
      if (applyPendingRef.current !== busyRequestRef.current) setResult(undefined)
    }
    if (previewPendingRef.current && previewPendingRef.current.world !== previewWorld) {
      previewPendingRef.current = undefined
      setBusy(false)
    }
  }, [previewWorld])

  const invalidatePreview = useCallback(() => {
    requestRef.current += 1
    busyRequestRef.current += 1
    setBusy(false)
    setResult(undefined)
    onGhostRef.current?.(null)
    setStage("")
    setApplied(undefined)
    setApplyOutcome(undefined)
    setApplyWasSaved(false)
    setResultContext(undefined)
    setUndoNote("")
    setSyncRequired(undefined)
  }, [])

  // 工具退出/面板卸载也必须清理 ghost（不能把临时 clone 留在 Viewer 里），并让在途 Promise 作废。
  useEffect(() => () => { aliveRef.current = false; requestRef.current += 1; busyRequestRef.current += 1; onGhostRef.current?.(null); onParkingGhostRef.current?.(null) }, [])

  // 把停放拾取控制器交给宿主（仅当宿主接线时）；卸载或宿主撤销接线时回收。
  const pickControllerHostRef = useRef(onParkingPickController); pickControllerHostRef.current = onParkingPickController
  useEffect(() => {
    const host = pickControllerHostRef.current
    if (!host) return
    host(parkingControllerRef.current)
    return () => host(undefined)
  }, [Boolean(onParkingPickController)])

  // Replace 的旧件停放默认值由宿主按真实帧算好；换旧件/换默认即重置草稿与停放 ghost。
  const replaceKey = replace ? `${replace.oldEntityId}:${replace.targetEntityId}/${replace.targetBodyName}:${replace.defaultParkingPose.positionM.join(',')}` : ''
  useEffect(() => {
    if (!replace) { setParking(IDENTITY_PAIR); setOldFree(false); setParkingError(""); onParkingGhostRef.current?.(null); return }
    setParking(replace.defaultParkingPose); setOldFree(false); setParkingError("")
    onParkingGhostRef.current?.(replace.defaultParkingPose)
  }, [replaceKey])

  // 换目标/换源即清掉上一份预览与真实读数；不把旧 body/site 留给新目标（不套用其它机器人的固定偏移）。
  useEffect(() => {
    requestRef.current += 1
    busyRequestRef.current += 1
    setBusy(false); setUndoBusy(false)
    setResult(undefined); onGhostRef.current?.(null); setStage(""); setError(""); setSyncRequired(undefined); setApplied(undefined); setApplyOutcome(undefined); setApplyWasSaved(false); setResultContext(undefined); setUndoNote("")
    setTargetError(""); setSourceError(""); setTargetDescription(undefined); setTargetBodyName(replace?.targetBodyName ?? ""); setTargetSite("")
    setSourceDescription(undefined); setSourceBodyKey(""); setSourceSite("")
    selectionTokenRef.current = ""
  }, [effectiveTargetId, source.entityId])

  useEffect(() => {
    let cancelled = false
    setTargetError("")
    setTargetDescription(undefined)
    if (!effectiveTargetId) return () => { cancelled = true }
    describeTargetRef.current(effectiveTargetId).then(value => { if (!cancelled) setTargetDescription(value) }, value => { if (!cancelled) setTargetError(messageOf(value)) })
    return () => { cancelled = true }
  }, [effectiveTargetId, source.entityId, targetAttempt])

  useEffect(() => {
    let cancelled = false
    if (!describeSourceRef.current) return () => { cancelled = true }
    setSourceError("")
    describeSourceRef.current().then(value => {
      if (cancelled) return
      // 不自动带出唯一 site/根 body：源安装面必须由用户显式选择、表面拾取或已保存点决定。
      setSourceDescription(value)
    }, value => { if (!cancelled) setSourceError(messageOf(value)) })
    return () => { cancelled = true }
  }, [source.entityId, sourceAttempt])

  const targetBodies = targetDescription?.bodies ?? []
  const targetSites = useMemo(() => (targetDescription?.sites ?? []).filter(site => site.bodyName === effectiveTargetBodyName), [targetDescription, effectiveTargetBodyName])
  const sourceBodies = sourceDescription?.bodies ?? []
  const sourceSites = useMemo(() => {
    const body = sourceBodyKey ? bodyFromKey(sourceBodyKey) : ""
    return (sourceDescription?.sites ?? []).filter(site => site.bodyName === body)
  }, [sourceDescription, sourceBodyKey])
  const targetBody = targetBodies.find(body => body.name === effectiveTargetBodyName)
  const sourcePartBlocked = Boolean(sourcePart && !sourcePart.root)

  const effectiveSourceMount: RobotSourceMount | undefined = useMemo(() => {
    if (sourcePartBlocked) return undefined
    if (sourceSite) return {kind: "site", bodyName: bodyFromKey(sourceBodyKey), site: sourceSite}
    if (sourceBodyKey) return {kind: "body-origin", bodyName: bodyFromKey(sourceBodyKey)}
    if (pickedSourceMount) return pickedSourceMount
    if (savedSourceMount) return savedSourceMount
    return undefined
  }, [sourcePartBlocked, sourceSite, sourceBodyKey, pickedSourceMount, savedSourceMount])

  const clearPreview = () => invalidatePreview()
  const buildSelection = (): AssemblyAttachSelection => {
    if (!effectiveTargetId) throw new Error(tr("先选择目标机器人。", "Select a target robot first."))
    if (!effectiveTargetBodyName) throw new Error(tr("先选择目标真实 body。", "Select a real target body first."))
    if (!effectiveSourceMount) throw new Error(tr("先明确源安装面：选择真实 body/site、拾取表面点或使用保存点。", "Resolve a real source mount first: pick a body/site, pick on the surface, or use a saved mount."))
    // Replace：目标安装位是**旧件已记录的安装位**（目标 body 局部 pose），新件自己的 sourceMount 由预览公式消费。
    const targetMount: RobotTargetMount = replace ? {kind: "pose", pose: replace.targetMountPose} : targetSite ? {kind: "site", site: targetSite} : {kind: "body-origin"}
    const token = JSON.stringify({source: source.entityId, mount: effectiveSourceMount, target: effectiveTargetId, body: effectiveTargetBodyName, targetMount, pair, parking})
    selectionTokenRef.current = token
    return {sourceEntityId: source.entityId, sourceMount: effectiveSourceMount, targetEntityId: effectiveTargetId, targetBodyName: effectiveTargetBodyName, targetMount, ...(samePair(pair, IDENTITY_PAIR) ? {} : {pair})}
  }
  const doPreview = async () => {
    const selection = buildSelection()
    const seq = ++requestRef.current
    const token = selectionTokenRef.current, requestWorld = previewWorldRef.current
    const pending = {world: requestWorld, sequence: seq}; previewPendingRef.current = pending
    const ownsPreview = () => aliveRef.current && seq === requestRef.current && token === selectionTokenRef.current && currentSourceRef.current === source.entityId && previewWorldRef.current === requestWorld
    setBusy(true); setError(""); setStage(""); setResult(undefined); onGhostRef.current?.(null); setSyncRequired(undefined); setApplied(undefined); setApplyOutcome(undefined)
    try {
      const value = await preview(selection)
      // 成功、错误、finally 同守请求 owner；同 key 的 A→B→A 也不能复活旧世界的 ghost。
      if (!ownsPreview() || value.source.entityId !== source.entityId || (world?.generation !== undefined && value.frame.generation !== world.generation) || (world?.sceneRevision !== undefined && value.frame.sceneRevision !== world.sceneRevision)) return
      setResult(value); onGhostRef.current?.(value)
      if (replace) onParkingGhostRef.current?.(parking)
    } catch (value) {
      if (!ownsPreview()) return
      setError(messageOf(value))
    } finally {
      if (previewPendingRef.current === pending) {
        previewPendingRef.current = undefined
        if (ownsPreview()) setBusy(false)
      }
    }
  }
  const doApply = async () => {
    if (!result) return
    const applySeq = ++busyRequestRef.current
    applyPendingRef.current = applySeq
    const applySelection = selectionTokenRef.current
    const applySourceId = source.entityId
    setBusy(true); setError(""); setParkingError("")
    try {
      let outcome: AssemblyApplyOutcome | undefined
      if (replace) {
        if (!onReplace) throw new Error(tr("当前没有替换提交入口。", "No replacement submission entry point is wired."))
        if (!validRobotPose(parking)) throw new Error(tr("停放位姿必须是米/归一化 xyzw 的有效位姿。", "The parking pose must be a valid metres/normalized-xyzw transform."))
        outcome = await onReplace({newEntityId: source.entityId, newBase: result.applyInput.base, oldEntityId: replace.oldEntityId, oldParkingPose: parking, oldFree})
      } else {
        outcome = await apply(result.applyInput)
      }
      // 回执消费这份预览。Replace 宿主可在该 Promise 中清除 replace prop；source/预览owner不变时仍接纳本次真实结果。
      if (!aliveRef.current || busyRequestRef.current !== applySeq || currentSourceRef.current !== applySourceId || selectionTokenRef.current !== applySelection) return
      onGhostRef.current?.(null)
      onParkingGhostRef.current?.(null)
      const stageValue = applyStage(outcome, tr)
      const text = stageValue?.text ?? tr("装配已提交；回执没有给出可识别的保存/同步状态。", "Assembly submitted; the receipt reported no recognizable save/sync state.")
      setApplied(text)
      setApplyWasSaved(Boolean(stageValue?.saved))
      setApplyOutcome(stageValue?.status === "sync-required" ? "sync-required" : stageValue?.status === "applied" ? "applied" : stageValue?.status === "sync-unknown" ? "sync-unknown" : "submitted")
      setSyncRequired(stageValue?.status === "sync-required" ? {revision: stageValue.revision, sceneId: stageValue.sceneId, reason: stageValue.reason} : undefined)
      setResultContext(replace ? {replace: {oldName: replace.oldName, parking, oldFree}} : {})
      setStage("")
    } catch (value) { if (busyRequestRef.current === applySeq && currentSourceRef.current === applySourceId) setError(messageOf(value)) }
    finally { if (applyPendingRef.current === applySeq) applyPendingRef.current = undefined; if (busyRequestRef.current === applySeq) setBusy(false) }
  }
  /** 保存已落盘但物理待同步时的内联下一步：复用宿主既有 world 生命周期同步，不清掉已提交的选择草稿。 */
  const doSyncApplied = async () => {
    if (!prepareWorld || !syncRequired) return
    const seq = ++busyRequestRef.current, sourceId = source.entityId, token = selectionTokenRef.current
    const expectedSceneId = syncRequired.sceneId, expectedRevision = syncRequired.revision
    setBusy(true); setError("")
    try {
      const value = await prepareWorld()
      if (!aliveRef.current || busyRequestRef.current !== seq || currentSourceRef.current !== sourceId || selectionTokenRef.current !== token) return
      const receipt = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
      const synchronized = Boolean(receipt && expectedSceneId && expectedRevision !== undefined && receipt.sceneId === expectedSceneId && receipt.appliedSceneRevision === expectedRevision && ['ready', 'running', 'paused'].includes(String(receipt.status)))
      if (!synchronized) { setError(tr('同步请求已返回，但目标场景修订尚未确认已应用。', 'Sync returned, but the target scene revision is not confirmed as applied.')); return }
      setSyncRequired(undefined)
      setApplyOutcome("applied")
      setApplied(tr(`装配声明已保存并已同步 · rev ${expectedRevision}；原生绑定读回仍独立待检查。`, `Assembly saved and synced · rev ${expectedRevision}; native binding readback remains a separate check.`))
      setStage("")
    } catch (value) { if (aliveRef.current && busyRequestRef.current === seq && currentSourceRef.current === sourceId) setError(messageOf(value)) }
    finally { if (aliveRef.current && busyRequestRef.current === seq) setBusy(false) }
  }
  const doCancel = () => { clearPreview(); setError(""); onGhostRef.current?.(null); onParkingGhostRef.current?.(null); onBack?.() }
  /**
   * 独立页面的"准备/同步并预览"下一步：复用宿主既有 world 生命周期。成功后按**新的**
   * scene/world/generation/revision 上下文重读源与目标、清掉旧预览与旧结果；保存点仍按
   * 当前资源身份保留（是否可用由宿主的 savedSourceMount 决定）。失败照实显示并允许重试。
   */
  const doPrepare = async () => {
    if (!prepareWorld) return
    setBusy(true); setError(""); setStage("")
    requestRef.current += 1
    setResult(undefined); onGhostRef.current?.(null); onParkingGhostRef.current?.(null)
    setSyncRequired(undefined); setApplied(undefined); setApplyOutcome(undefined)
    try {
      await prepareWorld()
      if (!aliveRef.current) return
      requestRef.current += 1
      setTargetDescription(undefined); setSourceDescription(undefined)
      setTargetBodyName(replace?.targetBodyName ?? ""); setTargetSite("")
      setSourceBodyKey(""); setSourceSite("")
      selectionTokenRef.current = ""
      setSourceAttempt(value => value + 1)
      setTargetAttempt(value => value + 1)
      if (replace) onParkingGhostRef.current?.(parkingRef.current)
      setStage(tr("物理世界已准备/同步；已按新的世界身份重读源与目标。", "Physics world prepared/synced; source and target were re-read under the new world identity."))
    } catch (value) { if (aliveRef.current) setError(messageOf(value)) }
    finally { if (aliveRef.current) setBusy(false) }
  }
  /** 进入画布停放位置拾取：先快照当前停放草稿，取消时可无损恢复。 */
  const beginParkingPick = () => {
    pickBeforeRef.current = parking
    pickPointRef.current = undefined
    setParkingError("")
    onRequestParkingPick?.()
  }
  const doSaveMount = async () => {
    if (!onSaveMount || !effectiveSourceMount) return
    setMountBusy(true); setError("")
    try { await onSaveMount(effectiveSourceMount); setStage(tr("已保存源安装点（绑定当前资源版本）。", "Source mount saved and bound to the current resource version.")) }
    catch (value) { setError(messageOf(value)) }
    finally { setMountBusy(false) }
  }
  const doClearMount = async () => {
    if (!onClearMount) return
    setMountBusy(true); setError("")
    try { await onClearMount(); setStage(tr("已清除保存的源安装点。", "Saved source mount cleared.")) }
    catch (value) { setError(messageOf(value)) }
    finally { setMountBusy(false) }
  }
  const doCheck = async () => {
    if (!onCheck) return
    setCheckBusy(true); setError("")
    try { await onCheck() }
    catch (value) { setError(messageOf(value)) }
    finally { setCheckBusy(false) }
  }

  const previewReady = Boolean(worldReady && effectiveTargetId && effectiveTargetBodyName && effectiveSourceMount && !sourcePartBlocked && (!replace || validRobotPose(parking)))
  // Apply 只吃**本轮真实 Preview**；世界代次（以及场景版本）已经前进时，旧预览不得再被提交。
  const previewSameFrame = Boolean(result
    && (world?.generation === undefined || result.frame.generation === world.generation)
    && (world?.sceneRevision === undefined || result.frame.sceneRevision === world.sceneRevision))
  const applyReady = Boolean(worldReady && result && previewSameFrame && (!replace || validRobotPose(parking)))
  const sourceMountText = effectiveSourceMount
    ? effectiveSourceMount.kind === "site"
      ? `${effectiveSourceMount.bodyName}/${effectiveSourceMount.site}`
      : effectiveSourceMount.kind === "body-origin"
        ? `${effectiveSourceMount.bodyName} · ${tr("body origin", "body origin")}`
        : pickedSourceMount
          ? tr("picked surface point", "picked surface point")
          : tr("saved mount", "saved mount")
    : tr("required", "required")
  const alignmentHint = sourcePartBlocked
    ? tr("Extract required", "Extract required")
    : `${tr("Source mount", "Source mount")} · ${sourceMountText}`
  const mainStatus = result ? tr('预览 · 未应用', 'Preview · not applied') : stage
  const mainStatusState = result ? 'preview' : 'info'
  const detailStatus = applyOutcome === "undone" ? tr("Undo completed; no re-read was performed.", "Undo completed; no re-read was performed.") : applied ?? tr("Preview · not applied", "Preview · not applied")
  const frameText = result ? `${result.frame.worldId} · gen ${result.frame.generation} · rev ${result.frame.sceneRevision}${result.frame.frameId ? ` · ${result.frame.frameId}` : ""}` : ""
  const targetDisplayName = targetCandidates.find(target => target.entityId === effectiveTargetId)?.name ?? tr("未选目标", "no target")
  const applyBase = result?.applyInput.base
  const applyTarget = applyBase?.target
  const detailPanel=(
    <details className="lya-advanced lya-attach-details" data-testid="assembly-attach-details">
      <summary>{tr("详情", "Details")}</summary>
      {result && <div className="lya-detail-box" data-testid="assembly-attach-result">
        <dl className="lya-kv">
          <dt>{tr("源安装面", "Source mount")}</dt><dd data-testid="assembly-attach-result-source">{result.sourceMount.label} · {poseText(result.sourceMount.positionM, result.sourceMount.quaternionXyzw)}</dd>
          <dt>{tr("目标安装位", "Target mount")}</dt><dd data-testid="assembly-attach-result-target">{result.targetMount.label} · {poseText(result.targetMount.positionM, result.targetMount.quaternionXyzw)}</dd>
          <dt>{tr("目标 body 中的源根", "Source root in target body")}</dt><dd>{poseText(result.targetBodyFromSourceRoot.positionM, result.targetBodyFromSourceRoot.quaternionXyzw)}</dd>
          {(resultContext?.replace||replace) && <><dt>{tr("旧件停放位", "Old part parking")}</dt><dd data-testid="assembly-attach-result-parking">{resultContext?.replace?.oldName??replace?.oldName} · {poseText((resultContext?.replace?.parking??parking).positionM, (resultContext?.replace?.parking??parking).quaternionXyzw)} · {(resultContext?.replace?.oldFree??oldFree) ? tr("free", "free") : tr("fixed", "fixed")}</dd></>}
          <dt>{tr("真实帧身份", "Real frame identity")}</dt><dd data-testid="assembly-attach-result-frame">{frameText}</dd>
          <dt>{tr("状态", "Status")}</dt><dd data-testid="assembly-attach-result-detail-status">{detailStatus}</dd>
        </dl>
        {result.notes.length > 0 && <details className="lya-advanced"><summary>{tr("说明", "Notes")}</summary><ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
      </div>}
      <dl className="lya-kv" data-testid="assembly-attach-technical">
        <dt>{tr("源模型", "Source model")}</dt><dd>{result ? `${result.source.name}${result.source.rootBodyName ? ` · ${result.source.rootBodyName}` : ""}` : source.name}</dd>
        <dt>{tr("目标模型", "Target model")}</dt><dd>{result ? `${result.target.name} · ${result.target.bodyName}` : targetDisplayName}</dd>
        <dt>{tr("源实体 ID", "Source entity ID")}</dt><dd><code>{source.entityId}</code></dd>
        <dt>{tr("目标实体 ID", "Target entity ID")}</dt><dd><code>{effectiveTargetId || "—"}</code></dd>
        {result && <><dt>{tr("应用基座", "Apply base")}</dt><dd data-testid="assembly-attach-result-base">{applyBase?.mode ?? "—"}{applyBase?.bodyName ? ` · ${applyBase.bodyName}` : ""}{applyTarget ? ` · ${poseText(applyTarget.positionM, applyTarget.quaternionXyzw)}` : ""}</dd></>}
      </dl>
      {onCheck && <div className="lya-row"><button type="button" className="lya-chip" data-testid="assembly-attach-check" disabled={checkBusy || busy} onClick={() => void doCheck()}>{checkBusy ? tr("检查中…", "Checking…") : tr("真实检查读回", "Check real readback")}</button></div>}
      {check && !syncRequired && <div className="lya-detail-box" data-testid="assembly-attach-check-result">
        <dl className="lya-kv">
          <dt>{tr("当前 native 绑定", "Current native binding")}</dt><dd>{check.nativeBase ? `${check.nativeBase.bodyName ?? ""} · ${poseText(check.nativeBase.worldFromBody?.positionM ?? [0, 0, 0], check.nativeBase.worldFromBody?.quaternionXyzw ?? [0, 0, 0, 1])}` : tr("未读到", "not read")}</dd>
          <dt>{tr("相对位姿", "Relative pose")}</dt><dd>{check.relativePose ? poseText(check.relativePose.positionM, check.relativePose.quaternionXyzw) : tr("未检查", "not checked")}</dd>
          <dt>{tr("关节保留", "Joints retained")}</dt><dd>{check.joints ? tr(`${check.joints.count} 个`, `${check.joints.count}`) : tr("未检查", "not checked")}</dd>
          <dt>{tr("接触", "Contacts")}</dt><dd>{check.checked.contacts ? tr("已读到真实接触", "real contacts read") : tr("未检查（缺运动/接触证据）", "not checked (no motion/contact evidence)")}</dd>
          <dt>{tr("动作回执", "Action receipt")}</dt><dd>{check.checked.actionReceipt ? tr("已读到", "read") : tr("未检查", "not checked")}</dd>
          <dt>{tr("已保存声明", "Saved declaration")}</dt><dd>{check.checked.binding ? tr("有", "yes") : tr("无", "none")}</dd>
        </dl>
        {check.attachments.length > 0 && <details className="lya-advanced" data-testid="assembly-attach-check-attachments"><summary>{tr(`外部挂接 ${check.attachments.length}`, `External attachments ${check.attachments.length}`)}</summary><ul>{check.attachments.map(entry => <li key={entry.entityId}>{entry.name} · {entry.saved.bodyName} → {entry.saved.target?.bodyName}</li>)}</ul></details>}
        {check.reason && <p className="lya-help">{check.reason}</p>}
        {check.notes.length > 0 && <ul className="lya-help">{check.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      </div>}
    </details>
  )
  const doUndoLast=async()=>{
    if(!onUndoLast||undoBusy||!applyWasSaved)return
    const seq=++busyRequestRef.current, sourceId=source.entityId
    setUndoBusy(true);setBusy(true);setUndoNote('');setError('')
    try{
      const value=await onUndoLast()
      if(!aliveRef.current||busyRequestRef.current!==seq||currentSourceRef.current!==sourceId)return
      setApplyOutcome('undone')
      const undoReceipt=value&&typeof value==='object'?value as AssemblyApplyOutcome:undefined
      setUndoNote(undoReceipt?.syncRequired===true?tr('已通过真实装配历史撤销；物理待同步。','Undo completed through the real assembly history · Physics sync required.'):tr('已通过真实装配历史撤销；原生绑定状态未重新读取。','Undo completed through the real assembly history; native binding state was not re-read.'))
      return value
    }catch(failure){if(aliveRef.current&&busyRequestRef.current===seq&&currentSourceRef.current===sourceId){setError(messageOf(failure));throw failure}}
    finally{if(aliveRef.current&&busyRequestRef.current===seq){setUndoBusy(false);setBusy(false)}}
  }
  const leaveResult=()=>{invalidatePreview();setError('');setUndoNote('');onParkingGhostRef.current?.(null);onBack?.()}
  const againFromResult=()=>{busyRequestRef.current+=1;setBusy(false);setResult(undefined);setApplied(undefined);setApplyOutcome(undefined);setApplyWasSaved(false);setResultContext(undefined);setSyncRequired(undefined);setUndoNote('');setError('');setStage('');selectionTokenRef.current='';onGhostRef.current?.(null);onParkingGhostRef.current?.(replace?.defaultParkingPose??null)}
  if(applied){
    const resultSource=result?.source.name??source.name
    const resultTarget=result?`${result.target.name} / ${result.target.bodyName}`:targetDisplayName
    const statusText=applyOutcome==='sync-required'?tr('Physics sync required','Physics sync required'):applyOutcome==='applied'?tr('Applied','Applied'):applyOutcome==='sync-unknown'?tr('Saved · sync not reported','Saved · sync not reported'):applyOutcome==='undone'?tr('Undo completed','Undo completed'):tr('Submitted · save state not reported','Submitted · save state not reported')
    const statusState=applyOutcome==='applied'||applyOutcome==='undone'?'applied':'warn'
    return <div className="lya-attach" data-testid="assembly-attach-panel"><div data-testid="assembly-attach-header"><button type="button" className="lya-back" data-testid="assembly-attach-back" onClick={leaveResult}>{tr('‹ 返回','‹ Back')}</button><h2 className="lya-page-title" data-testid="assembly-attach-title">{resultContext?.replace?tr('替换结果','Replacement result'):tr('装配结果','Assembly result')}</h2></div>
      <section className="lya-attach-result-page" data-testid="assembly-attach-result-page"><p className="lya-attach-status" role="status" data-state={statusState} data-testid="assembly-attach-result-status">{statusText}</p>
        {/* 设计稿 assembly-result：SOURCE / TARGET / MOUNT 三行 + 保存勾选行。 */}
        <div className="lya-field-row" data-testid="assembly-attach-result-row-source"><span className="lya-field-label">{tr('来源','Source')}</span><span className="lya-field-value">{resultSource}</span></div>
        <div className="lya-field-row" data-testid="assembly-attach-result-row-target"><span className="lya-field-label">{tr('目标','Target')}</span><span className="lya-field-value">{resultTarget.split(' / ')[0]}</span></div>
        <div className="lya-field-row" data-testid="assembly-attach-result-row-mount"><span className="lya-field-label">{tr('挂接点','Mount')}</span><span className="lya-field-value">{resultTarget.includes(' / ')?resultTarget.split(' / ').slice(1).join(' / '):effectiveTargetBodyName||'—'}</span></div>
        <div className="lya-field-row" data-testid="assembly-attach-result-relation" hidden><span className="lya-field-label">{tr('安装关系','Attachment')}</span><span className="lya-field-value">{resultSource} → {resultTarget}</span></div>
        {applyWasSaved&&applyOutcome!=='undone'&&<p className="lya-attach-saved" data-testid="assembly-attach-saved-row" role="status">✓ {tr('装配已保存','Attachment saved')}</p>}
        <details className="lya-advanced" data-testid="assembly-attach-result-alignment"><summary>{tr('对齐','Alignment')} · {tr('源挂接','Source mount')}</summary><p className="lya-help">{tr('挂接按源模型自身安装点对齐到目标连杆；方向可随后在装配预览中调整。','The source model mounts at its own installation point on the target link; orientation can be adjusted in the assembly preview.')}</p></details>
        <details className="lya-advanced" data-testid="assembly-attach-result-orientation"><summary>{tr('方向','Orientation')}</summary><p className="lya-help">{tr('当前装配不使用额外方向偏移；方向显示来自源模型安装点。','This assembly uses no extra orientation offset; orientation comes from the source installation point.')}</p></details>
        {applyOutcome==='sync-required'&&<div className="lya-warning" data-testid="assembly-attach-sync-required" aria-label={tr('装配声明已保存 · 物理待同步','Assembly saved · Physics sync required')}>{prepareWorld&&<button type="button" className="lya-primary" data-testid="assembly-attach-sync-world" disabled={busy} onClick={()=>void doSyncApplied()}>{tr('同步物理世界并读回','Sync physics & read back')}</button>}{syncRequired?.reason&&<details data-testid="assembly-attach-sync-detail"><summary>{tr('技术原因','Technical details')}</summary><code>{syncRequired.reason}</code></details>}</div>}
        {error&&<p role="alert" className="lya-error" data-testid="assembly-attach-error">{error}</p>}
        {undoNote&&<p role="status" data-testid="assembly-attach-undo-note">{undoNote}</p>}
        {applyWasSaved&&onUndoLast&&applyOutcome!=='undone'&&<><div className="lya-row" data-testid="assembly-attach-saved-result"><button type="button" className="lya-chip" data-testid="assembly-attach-undo-last" disabled={busy||undoBusy} onClick={()=>void doUndoLast().catch(()=>undefined)}>{undoBusy?tr('正在撤销…','Undoing…'):tr('撤销挂接','Undo attachment')}</button></div><p className="lya-help" data-testid="assembly-attach-mounted-caption">{tr('已挂接到 ','Mounted to ')}{resultTarget}</p></>}
        {busy&&<p role="status" className="lya-foot-note">{tr('等待装配历史/物理同步回执…','Awaiting assembly history/physics sync receipt…')}</p>}
        <div className="lya-row"><button type="button" data-testid="assembly-attach-again" disabled={busy} onClick={againFromResult}>{tr('再次安装','Attach another')}</button></div>
      </section>{detailPanel}</div>
  }
  return <div className="lya-attach" data-testid="assembly-attach-panel">
    <div data-testid="assembly-attach-header">
      {onBack && <button type="button" className="lya-back" data-testid="assembly-attach-back" onClick={onBack}>{tr("‹ 返回", "‹ Back")}</button>}
      <h2 className="lya-page-title" data-testid="assembly-attach-title">{replace ? tr("替换末端", "Replace end-effector") : tr("装配", "Attach hand")}</h2>
    </div>
    {!worldReady && <div className="lya-error lya-attach-world" data-testid="assembly-attach-world-required">
      <div className="lya-row"><strong>{tr("物理世界尚未就绪", "Physics world not ready")}</strong><span className="lya-badge" data-world-phase={world?.phase ?? "unknown"}>{world?.phase ?? "unknown"}</span>{world?.appliedRevision !== undefined && world?.sceneRevision !== undefined && <span className="lya-badge" data-testid="assembly-attach-world-revisions">applied rev {world.appliedRevision} · scene rev {world.sceneRevision}</span>}</div>
      <p className="lya-help" data-testid="assembly-attach-world-detail">{world?.detail ?? tr("当前场景还没有可用的物理世界；先准备/同步，再按新世界身份预览装配。", "This scene has no usable physics world yet; prepare/sync first, then preview the assembly under the new world identity.")}</p>
      {world?.code && <details className="lya-advanced"><summary>{tr("技术原因", "Technical reason")}</summary><code data-testid="assembly-attach-world-code">{world.code}</code></details>}
      {prepareWorld && <div className="lya-row"><button type="button" className="lya-primary" data-testid="assembly-attach-prepare" disabled={busy} onClick={() => void doPrepare()}>{world?.phase === "unsynced" ? tr("同步并预览", "Sync & preview") : tr("准备物理世界并预览", "Prepare physics & preview")}</button></div>}
    </div>}
    <div data-testid="assembly-attach-primary">
      <div className="lya-attach-block" data-testid="assembly-attach-source-block">
        <div className="lya-attach-label">{tr("源", "Source")}</div>
        <div className="lya-attach-source">
          <span className="lya-attach-source-icon" aria-hidden="true">◇</span>
          <strong data-testid="assembly-attach-source-name" title={source.entityId}>{source.name}</strong>
        </div>
        {sourcePartBlocked
          ? <p className="lya-attach-source-status" data-state="blocked" data-testid="assembly-attach-extract-hint">{tr(`选中的是内部部件“${sourcePart!.name}”；它不是可直接挂接的独立根。请先把它提取为独立部件，再装配，别把整机当成源。`, `The selected part "${sourcePart!.name}" is inside the source model; it is not a directly attachable independent root. Extract it as an independent part before attaching, instead of treating the whole model as the source.`)}</p>
          : sourceError
            ? <div className="lya-error" data-testid="assembly-attach-source-error">
                <span>{tr("源真实 body/site 读取失败。", "Could not read source real bodies/sites.")}</span>
                <details className="lya-advanced"><summary>{tr("技术原因", "Technical reason")}</summary><code>{sourceError}</code></details>
                <button type="button" className="lya-chip" data-testid="assembly-attach-source-retry" disabled={busy} onClick={() => setSourceAttempt(value => value + 1)}>{tr("重试", "Retry")}</button>
              </div>
            : <p className="lya-attach-source-status" data-testid="assembly-attach-source-status" data-state={effectiveSourceMount ? "set" : "required"}>
                {effectiveSourceMount
                  ? `${tr("Source mount", "Source mount")} · ${sourceMountText}`
                  : <>
                      {tr("Source mount not set.", "Source mount not set.")}{" "}
                      <button type="button" className="lya-attach-inline-link" data-testid="assembly-attach-source-choose" disabled={busy} onClick={() => { if (alignmentRef.current) alignmentRef.current.open = true }}>{tr("Choose source mount", "Choose source mount")}</button>
                    </>}
              </p>}
      </div>
      <div className="lya-attach-block" data-testid="assembly-attach-target-block">
        <label className="lya-attach-label" htmlFor="assembly-attach-target-select">{tr("目标", "Target")}</label>
        <select id="assembly-attach-target-select" className="lya-wide" aria-label={tr("目标机器人", "Target robot")} data-testid="assembly-attach-target" value={effectiveTargetId} disabled={busy || Boolean(replace)} onChange={event => { requestRef.current += 1; setTargetId(event.target.value) }}>
          {targetCandidates.map(target => <option key={target.entityId} value={target.entityId}>{target.name}</option>)}
        </select>
      </div>
      <div className="lya-attach-block" data-testid="assembly-attach-mount-block">
        <label className="lya-attach-label" htmlFor="assembly-attach-target-body-select">{tr("安装位", "Mount")}</label>
        <select id="assembly-attach-target-body-select" className="lya-wide" aria-label={tr("目标真实 body", "Target real body")} data-testid="assembly-attach-target-body" value={effectiveTargetBodyName} disabled={busy || !targetDescription || Boolean(replace)} onChange={event => { setTargetBodyName(event.target.value); setTargetSite(""); clearPreview() }}>
          <option value="">{tr("选择目标真实 body", "Select target real body")}</option>
          {targetBodies.map(body => <option key={body.name} value={body.name}>{body.name}{body.root ? tr("（根）", " (root)") : ""}</option>)}
        </select>
        {targetBody && !targetBody.root && <p className="lya-help" data-testid="assembly-attach-target-note" title={tr("安装使用所选真实连杆的局部坐标系。", "The mount uses the selected native link's local frame.")}>{tr("连杆局部坐标系", "Body-local mount")}</p>}
        {targetError && <div className="lya-error" data-testid="assembly-attach-target-error"><span>{tr("目标真实 body/site 读取失败。", "Could not read target real bodies/sites.")}</span><details className="lya-advanced"><summary>{tr("技术原因", "Technical reason")}</summary><code>{targetError}</code></details></div>}
      </div>
      <details ref={alignmentRef} className="lya-attach-fold" data-testid="assembly-attach-alignment">
        <summary><span>{tr("对齐", "Alignment")}</span><span className="lya-attach-fold-hint" data-testid="assembly-attach-alignment-hint" data-state={sourcePartBlocked ? "blocked" : effectiveSourceMount ? "set" : "required"}>{alignmentHint}</span></summary>
        <div className="lya-attach-fold-body">
          {sourcePartBlocked
            ? <p className="lya-help">{tr("提取为独立部件后才可选择源安装面。", "Source mount selection becomes available after the internal part is extracted as an independent part.")}</p>
            : <>
              <select className="lya-wide" aria-label={tr("源真实 body", "Source real body")} data-testid="assembly-attach-source-body" value={sourceBodyKey} disabled={busy} onChange={event => { requestRef.current += 1; setSourceBodyKey(event.target.value); setSourceSite(""); clearPreview() }}>
                <option value="">{savedSourceMount ? tr("使用已保存的源安装点", "Use the saved source mount") : tr("选择源真实 body", "Select source real body")}</option>
                {sourceBodies.map(body => <option key={`${source.entityId}|${body.name}`} value={`${source.entityId}|${body.name}`}>{body.name}{body.root ? tr("（根）", " (root)") : ""}</option>)}
              </select>
              {sourceSites.length > 0 && <select className="lya-wide" aria-label={tr("源安装 site", "Source mount site")} data-testid="assembly-attach-source-site" value={sourceSite} disabled={busy} onChange={event => { setSourceSite(event.target.value); clearPreview() }}>
                <option value="">{tr("body 原点", "Body origin")}</option>
                {sourceSites.map(site => <option key={site.name} value={site.name}>{site.name}</option>)}
              </select>}
              {onRequestPick && <div className="lya-row"><button type="button" className="lya-chip" data-testid="assembly-attach-pick" disabled={busy} onClick={onRequestPick}>{tr("在模型表面拾取安装点…", "Pick a mount on the model surface…")}</button>{pickedSourceMount && <span className="lya-badge" data-testid="assembly-attach-picked">{tr("已拾取表面点", "Surface point picked")}</span>}</div>}
              {!sourceDescription && !savedSourceMount && !pickedSourceMount && <p className="lya-help" data-testid="assembly-attach-source-reading">{tr("读取源实体真实 body/site…", "Reading source real bodies/sites…")}</p>}
              {!effectiveSourceMount && <p className="lya-help" data-testid="assembly-attach-source-required">{tr("未明确有效源安装面：Preview 不可执行。请选择真实 body/site、拾取表面点或使用保存点。", "No valid source mount: Preview is disabled. Choose a real body/site, pick on the surface, or use a saved mount.")}</p>}
              {(onSaveMount || onClearMount) && <div className="lya-row">
                {onSaveMount && <button type="button" className="lya-chip" data-testid="assembly-attach-save-mount" disabled={busy || mountBusy || !effectiveSourceMount} onClick={() => void doSaveMount()}>{tr("保存源安装点", "Save source mount")}</button>}
                {onClearMount && savedSourceMount && <button type="button" className="lya-chip" data-testid="assembly-attach-clear-mount" disabled={busy || mountBusy} onClick={() => void doClearMount()}>{tr("清除保存点", "Clear saved mount")}</button>}
              </div>}
            </>}
          {replace
            ? <p className="lya-help" data-testid="assembly-attach-target-recorded">{tr("目标安装位来自旧件已记录的安装位；新件自己的源安装面参与预览计算，不复用旧件根偏移。", "The target mount is the old part's recorded installation face; the new part's own source mount enters the preview maths, so the old root offset is never copied.")}</p>
            : <label className="lya-field-label">{tr("目标 site", "Target site")}<select className="lya-wide" aria-label={tr("目标安装 site", "Target mount site")} data-testid="assembly-attach-target-site" value={targetSite} disabled={busy || targetSites.length === 0} onChange={event => { setTargetSite(event.target.value); clearPreview() }}>
                <option value="">{tr("body 原点", "Body origin")}</option>
                {targetSites.map(site => <option key={site.name} value={site.name}>{site.name}</option>)}
              </select></label>}
          {!targetDescription && !targetError && <p className="lya-help">{tr("读取目标真实 body/site…", "Reading target real bodies/sites…")}</p>}
        </div>
      </details>
      {!replace && <details className="lya-attach-fold" data-testid="assembly-attach-advanced" data-fold="orientation">
        <summary><span>{tr("朝向", "Orientation")}</span><span className="lya-attach-fold-hint">{samePair(pair, IDENTITY_PAIR) ? tr("无偏移", "No offset") : tr("自定义偏移", "Custom offset")}</span></summary>
        <div className="lya-attach-fold-body">
          <p className="lya-help">{tr("位移单位米、旋转归一化 xyzw；省略即单位阵。", "Translation is metres and rotation is normalized xyzw; omitted means identity.")}</p>
          <div className="lya-row">{(['X', 'Y', 'Z'] as const).map((label, index) => <label key={label} className="lya-field-label">{label} m<input aria-label={`T_pair ${label}`} type="number" step={0.001} value={pair.positionM[index]} disabled={busy} onChange={event => { const next = [...pair.positionM] as [number, number, number]; next[index] = Number(event.target.value); setPair({...pair, positionM: next}); clearPreview() }}/></label>)}</div>
          <div className="lya-row">{(['x', 'y', 'z', 'w'] as const).map((label, index) => <label key={label} className="lya-field-label">q{label}<input aria-label={`T_pair q${label}`} type="number" step={0.001} value={pair.quaternionXyzw[index]} disabled={busy} onChange={event => { const next = [...pair.quaternionXyzw] as [number, number, number, number]; next[index] = Number(event.target.value); setPair({...pair, quaternionXyzw: next}); clearPreview() }}/></label>)}</div>
        </div>
      </details>}
      {replace && <div className="lya-attach-block lya-attach-parking" data-testid="assembly-attach-parking">
        <div className="lya-attach-label">{tr("旧件去向（离开安装位的停放位姿）", "Old part destination (parking pose away from the mount)")}</div>
        <p className="lya-help" data-testid="assembly-attach-parking-summary">{tr(`旧件 ${replace.oldName}：预览显示其在停放位的临时几何；确认后停放到 [${parking.positionM.map(value => value.toFixed(3)).join(", ")}] m。不默认留在当前安装位。`, `Old part ${replace.oldName}: the preview shows its temporary geometry at the parking pose; on confirm it is parked at [${parking.positionM.map(value => value.toFixed(3)).join(", ")}] m. It never defaults to the current mount.`)}</p>
        {onRequestParkingPick && <div className="lya-row" data-testid="assembly-attach-parking-pick-row"><button type="button" className="lya-chip lya-chip-accent" data-testid="assembly-attach-parking-pick" disabled={busy} onClick={beginParkingPick}>{tr("在画布上选择停放位置…", "Choose parking position on canvas…")}</button><span className="lya-help">{tr("只选位置；方向沿用上面的停放四元数，可用数值微调。", "Chooses position only; orientation keeps the parking quaternion above and can be tuned numerically.")}</span></div>}
        <div className="lya-row">{(['X', 'Y', 'Z'] as const).map((label, index) => <label key={label} className="lya-field-label">{label} m<input aria-label={`parking ${label}`} type="number" step={0.01} value={parking.positionM[index]} disabled={busy} onChange={event => { const next = [...parking.positionM] as [number, number, number]; next[index] = Number(event.target.value); setParking({...parking, positionM: next}); setParkingError(validRobotPose({...parking, positionM: next}) ? "" : tr("停放位姿非法", "invalid parking pose")); onParkingGhostRef.current?.({...parking, positionM: next}) }}/></label>)}</div>
        <div className="lya-row">{(['x', 'y', 'z', 'w'] as const).map((label, index) => <label key={label} className="lya-field-label">q{label}<input aria-label={`parking q${label}`} type="number" step={0.01} value={parking.quaternionXyzw[index]} disabled={busy} onChange={event => { const next = [...parking.quaternionXyzw] as [number, number, number, number]; next[index] = Number(event.target.value); setParking({...parking, quaternionXyzw: next}); setParkingError(validRobotPose({...parking, quaternionXyzw: next}) ? "" : tr("停放位姿非法", "invalid parking pose")); onParkingGhostRef.current?.({...parking, quaternionXyzw: next}) }}/></label>)}</div>
        <label className="lya-field-label"><input type="checkbox" data-testid="assembly-attach-old-free" checked={oldFree} disabled={busy} onChange={event => setOldFree(event.target.checked)}/>{tr("解除固定（free）：停放位姿作为其初始世界位姿，不自动跌落或瞬移。", "Release to free: the parking pose becomes its initial world pose; it never auto-falls or teleports.")}</label>
        {parkingError && <p className="lya-error" data-testid="assembly-attach-parking-error">{parkingError}</p>}
      </div>}
      {mainStatus && <p className="lya-attach-status" data-state={mainStatusState} role="status" data-testid={result || applied || syncRequired ? "assembly-attach-result-status" : "assembly-attach-stage"}>{mainStatus}</p>}
    </div>
    {error && <div role="alert" className="lya-error" data-testid="assembly-attach-error"><span>{error}</span></div>}
    {detailPanel}
    <div className="lya-row" style={{flexWrap:'wrap'}}>
        <button className="lya-chip" data-testid="assembly-attach-frame-preview" disabled={busy || !result || !onFramePreview} title={tr("把目标机器人与安装 ghost 一起框进视图；只移动查看相机。","Frame the target robot together with the installation ghost; only the viewing camera moves.")} onClick={onFramePreview}>{tr("框选预览", "Frame preview")}</button>
        <button className="lya-chip" data-testid="assembly-attach-preview" disabled={busy || !previewReady} onClick={() => void doPreview()}>{tr("预览", "Preview")}</button>
    </div>
    <div className="lya-attach-foot" data-testid="assembly-attach-actions">
      <div className="lya-attach-foot-actions">
        <button className="lya-chip" data-testid="assembly-attach-cancel" disabled={busy} onClick={doCancel}>{tr("取消", "Cancel")}</button>
        <button className="lya-primary" data-testid="assembly-attach-apply" disabled={busy || !applyReady} onClick={() => void doApply()}>{replace ? tr("确认替换", "Confirm replacement") : tr("应用装配", "Apply attachment")}</button>
      </div>
      {busy && <p className="lya-foot-note" role="status">{tr("等待预览/引擎回执…", "Awaiting preview/engine receipt…")}</p>}
    </div>
  </div>
}
