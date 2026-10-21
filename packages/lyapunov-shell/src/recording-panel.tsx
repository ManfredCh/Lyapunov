import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createViewer, type SceneViewer } from '@lyapunov/viewer/client'
import type { Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RecordingManifest, RecordingReplay } from '../../robot-workflows/src/recording-files.ts'
import { workbenchAPI } from './workbench-api.ts'
import { RecordingFrameReadout } from './recording-frame-readout.tsx'
import { RecordingChannels } from './recording-channels.tsx'
import { RECORDING_CHANNELS, recordingChannelFaces, recordingFixedScope, recordingScopeLabel, recordingSourceOptions, recordingSourceReady, recordingSourceReasonText, recordingStartInput, type RecordingChannelId } from './recording-source.ts'
import type { Translate } from './entity-editor.tsx'
import { EmptyState } from './panel-chrome.tsx'
// `missing`/`missingCount`：服务端 `recordingSummary()`（`robot-workflows/src/recording-files.ts:33`）**一直在算**、
// `register("recordings")`（`plugin.ts:2053`）**一直在发**，而这里此前**没接** ⇒ 录制缺件（资源读不回来的那些
// uri 与原因）对用户不可见（`ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D2）。行类型带上这两个键才谈得上渲染。
// ⚠️ `missingCount` **不是** `RecordingManifest` 的字段 —— 它是 `recordingSummary()` 现算的（`m.missing.length`；
// 落在清单上的只有被截到前 20 条的 `missing`）⇒ 只能在行类型里显式声明 `number`。
// 把它塞进 `Pick<RecordingManifest, …>` 会是一条 **tsc 错误**（TS2344：`'missingCount'` 不满足
// `keyof RecordingManifest` 约束）⇒ 拿一句 grep 把仓库的门弄红，方向反了（2026-09-27 实测：这个形状红过 3 条）。
type Summary = Pick<RecordingManifest, 'recordingId' | 'sceneId' | 'status' | 'stopReason' | 'frameCount' | 'maxDurationS' | 'elapsedS' | 'firstFrame' | 'lastFrame' | 'createdAt' | 'missing' | 'source' | 'channels'> & { missingCount: number; generations: Array<{ generation: number; sceneRevision: number }> }
/** RecordingPanel 的座位身份：同一 Session 内切 Scene 必须重建并丢弃旧回放/在途 open。 */
export function recordingPanelSeatKey(sessionId?: string, sceneId?: string) { return `${sessionId ?? 'no-session'}:${sceneId ?? 'no-scene'}` }
/** 已录时长读回：只显示服务端累计 `elapsedS`；旧清单缺字段如实写“未记录”，不拿绝对 simTime 冒充。 */
export function recordingElapsedLabel(row: Pick<Summary, 'elapsedS' | 'maxDurationS'>, tr: Translate) {
 const limit = Number.isFinite(row.maxDurationS) ? `${row.maxDurationS.toFixed(2)} s sim` : tr('上限未知', 'limit unknown')
 const elapsed = typeof row.elapsedS === 'number' && Number.isFinite(row.elapsedS) ? row.elapsedS.toFixed(2) : undefined
 return elapsed === undefined ? tr(`未记录 / 上限 ${limit}`, `not recorded / limit ${limit}`) : `${elapsed} / ${limit}`
}
/** 后端 completed 表示作业已保存；是否达到目标必须结合真实停止原因与累计时长表达。 */
export function recordingOutcome(row: Pick<Summary, 'status' | 'stopReason' | 'elapsedS' | 'maxDurationS'>, tr: Translate): { label: string; reason?: string; warning?: boolean } {
 if (row.status !== 'completed') return { label: row.status === 'recording' ? tr('录制中', 'Recording') : row.status }
 const elapsedKnown = typeof row.elapsedS === 'number' && Number.isFinite(row.elapsedS) && row.elapsedS >= 0
 const limitKnown = Number.isFinite(row.maxDurationS) && row.maxDurationS > 0
 const short = elapsedKnown && limitKnown && row.elapsedS! < row.maxDurationS
 const reached = elapsedKnown && limitKnown && row.elapsedS! >= row.maxDurationS
 const reasons: Record<string, string> = {
  'wall-time-limit': tr('已达到墙钟安全时限', 'Wall-clock safety limit reached'),
  'frame-limit': tr('已达到帧数上限', 'Frame limit reached'),
 }
 if (row.stopReason === 'recording-stop') return { label: tr('已停止', 'Stopped') }
 if (row.stopReason === 'wall-time-limit' || row.stopReason === 'frame-limit' || short) return {
  label: short ? tr('提前结束', 'Ended early') : tr('已结束', 'Ended'),
  reason: reasons[row.stopReason ?? ''] ?? (row.stopReason || tr('已录时长未达到目标', 'Recorded duration is below the target')),
  warning: true,
 }
 if (reached && (!row.stopReason || row.stopReason === 'duration-limit')) return { label: tr('已完成', 'Completed') }
 return {
  label: tr('已结束', 'Ended'), warning: true,
  reason: row.stopReason && row.stopReason !== 'duration-limit' ? row.stopReason : !elapsedKnown
   ? tr('未记录有效的已录时长', 'Recorded duration is not available')
   : tr('未记录有效的时长目标', 'Recording duration target is not available'),
 }
}
/**
 * 录制**缺件**的可见出口（D2）：`missingCount > 0` 时出一条告警，条数是**真总数**（服务端 `missing` 只截前 20 条，
 * 所以悬停详情里把"显示了几条／共几条"写清楚 —— 不许让 20 条看起来像全部）。
 * 渲染与判据共用**这一个**组件：面板上到底写了什么，由真渲染钉住，而不是靠读源码。
 */
export function RecordingMissingFiles({ row, tr }: { row: Pick<Summary, 'missing' | 'missingCount'>; tr: Translate }) {
 if (!(row.missingCount > 0)) return null
 const shown = row.missing ?? []
 const detail = shown.map(item => `${item.uri}：${item.reason}`).join('\n') + (row.missingCount > shown.length ? `\n（只列前 ${shown.length} 条，共 ${row.missingCount} 条）` : '')
 return <span className="lya-badge lya-warning" role="status" data-testid="recording-missing" title={`${tr('录制缺件', 'Missing recording files')}\n${detail}`}>{tr(`缺件 ${row.missingCount} 项`, `${row.missingCount} missing`)}</span>
}
/** 运行时来源摘要：只显示真实存在的字段，不把 undefined 摆给用户看。 */
function scopeText(scope: ReturnType<typeof recordingFixedScope>, tr: Translate) {
 if (!scope) return tr('来源未记录', 'Source not recorded')
 return [scope.robotName ?? scope.robotEntityId, scope.bodyName, scope.cameraName].filter(Boolean).join(' · ')
}
/** 通道状态行：失败保留已采到的帧数与原因；requested 只说明还没采到。 */
function channelFacesText(faces: ReturnType<typeof recordingChannelFaces>, tr: Translate) {
 return faces.map(face => {
  const spec = RECORDING_CHANNELS.find(channel => channel.id === face.id)
  const label = face.id === 'camera-depth' ? tr('Z 深度', 'Z-depth') : face.id === 'lidar-range' ? 'LiDAR range' : spec ? tr(spec.zh, spec.en) : face.id
  if (face.status === 'completed') return `${label} ✓ ${face.frames}`
  if (face.status === 'unavailable') return `${label} ✕ ${tr('不可用', 'unavailable')}${face.frames > 0 ? ` · ${face.frames} ${tr('帧', 'frames')}` : ''}${face.reason ? ` (${face.reason})` : ''}`
  return `${label} · ${tr('尚未采到', 'not captured yet')}`
 }).join(' · ')
}
/** 面板层级：空态不渲染表单；有机位未选只给来源；选定可用来源才给通道与开始；运行中先给固定作业。 */
export function recordingPanelStage(input:{rows:Array<{status:string}>;sources:number;selected:boolean;ready:boolean}):'running'|'empty'|'choose-source'|'unavailable-source'|'setup'{
 if(input.rows.some(row=>row.status==='recording'))return 'running'
 if(input.sources===0)return 'empty'
 if(!input.selected)return 'choose-source'
 if(!input.ready)return 'unavailable-source'
 return 'setup'
}
export function RecordingPanel({ api, sceneId, scene, world, nativeReceipt, nativeError, openCamera, openRobotLibrary, hasRobot = true, preferredCameraName, tr, perform, onReplayChange, close, visible = true, embedded = false, replayHost }: { api: ReturnType<typeof workbenchAPI>; sceneId?: string; scene?: SceneSnapshot; world?: WorldHandle; nativeReceipt?: any; nativeError?: string; openCamera?: () => void; openRobotLibrary?: () => void; /** Scene 是否已有机器人：无 Robot 时下一步是 Add robot，而不是进入 Camera 的空态。 */ hasRobot?: boolean; preferredCameraName?: string; tr: Translate; perform: (fn: () => Promise<unknown>) => void; onReplayChange: (value: boolean) => void; close: () => void; visible?: boolean; /** 由 PanelColumn 提供唯一关闭入口时不再画自身 ×；Outputs 抽屉仍保留旧关闭行为。 */ embedded?: boolean; /** V10：主画布上的回放宿主；回放 Viewer 只在这里挂载，右栏保留清单/来源。 */ replayHost?: HTMLElement|null }) {
 const [rows, setRows] = useState<Summary[]>([]), [replay, setReplay] = useState<RecordingReplay>(), [segment, setSegment] = useState(0), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [limit, setLimit] = useState(30), [note, setNote] = useState(''), [loaded, setLoaded] = useState(false)
 // R-006：Pause/Seek/切代次/重开/返回实时都走**同一个同步暂停入口**。只同步关 playingRef 不够：
 // timeout 在 Pause 前已把一条低优先级 `setIndex(+1)` 排进队列时，Pause 只改 playing 这个另一个 hook，
 // 旧 advance 仍会在 flush 时 rebase 上来（真实传感器回放 7→8 的同一形状）。所以关闸的同一事件里
 // 还要把本次选择的 index 显式排进同一个队列；它晚于旧 advance，rebase 后落在最后。Play 只开闸。
 const playingRef = useRef(false)
 // 开始前**唯一**的选择状态：机器人/机位/通道/时长/分辨率。开始后当前作业的来源从服务端清单（row.source）读，
 // 这里的改选只准备下一次录制，不替换正在进行的作业。
 const [sourceKey, setSourceKey] = useState(''), [channels, setChannels] = useState<RecordingChannelId[]>(['rgb', 'camera-depth']), [sizes, setSizes] = useState<Record<string, { width?: number; height?: number }>>({}), [showSize, setShowSize] = useState(false)
 const container = useRef<HTMLDivElement>(null), viewer = useRef<SceneViewer>(), instanceVersion = useRef(0)
 const translateRef = useRef(tr); translateRef.current = tr
 const sourceOptions = useMemo(() => recordingSourceOptions(scene, nativeReceipt), [scene, nativeReceipt])
 // Camera 面板的“Record this camera”只传真实相机名；这里按 native 清单投影到完整来源键，不另存机位。
 // 只在该 preferred 首次到达时覆盖一次，之后轮询/清单刷新不抢用户手选的来源。
 const sourceSeat = JSON.stringify([sceneId, world?.worldId, world?.worldGeneration])
 const appliedPreferred = useRef<string>()
 useEffect(() => {
  const preference = JSON.stringify([sourceSeat, preferredCameraName])
  if (!preferredCameraName || appliedPreferred.current === preference) return
  const match = sourceOptions.find(option => option.cameraName === preferredCameraName || option.resolvedCameraName === preferredCameraName)
  if (match) { setSourceKey(match.key); appliedPreferred.current = preference }
 }, [preferredCameraName, sourceOptions, sourceSeat])
 const selected = sourceOptions.find(option => option.key === sourceKey)
 // 只有用户编辑才保存录制尺寸；未编辑值直接继承同一真实来源，不由轮询 effect 写回草稿。
 // 完整来源 + Scene/world/代次隔离，切机位不会继承另一机位的手改值。
 const sizeKey = JSON.stringify([sourceSeat, sourceKey])
 const { width, height } = sizes[sizeKey] ?? { width: selected?.width, height: selected?.height }
 const editSize = (change: Partial<{ width: number; height: number }>) => setSizes(old => ({ ...old, [sizeKey]: { ...(old[sizeKey] ?? { width, height }), ...change } }))
 const ready = recordingSourceReady(selected)
 const startInput = recordingStartInput(selected, channels, limit, width, height)
 const currentSegment = replay?.segments[segment], frames = currentSegment?.frames ?? [], frame = frames[index]
 const maxIndex = Math.max(0, frames.length - 1)
 const running = rows.find(row => row.status === 'recording')
 const stage = recordingPanelStage({ rows, sources: sourceOptions.length, selected: Boolean(selected), ready: ready.ok })
 const recentRows = running ? rows.filter(row => row.recordingId !== running.recordingId) : rows
 const pauseAt = (value: number) => {
  playingRef.current = false
  setPlaying(false)
  setIndex(Math.max(0, Math.min(value, maxIndex)))
 }
 const playNow = () => { playingRef.current = true; setPlaying(true) }
 const sourceSummary = currentSegment && frame
  ? `scene ${currentSegment.scene.sceneId} · world ${currentSegment.world.worldId} · g${frame.generation} · scene rev ${currentSegment.world.appliedSceneRevision} · frame rev ${frame.sceneRevision}`
  : undefined
 const refresh = async () => { const records = await api.request<Summary[]>('recordings' + (sceneId ? '?sceneId=' + encodeURIComponent(sceneId) : '')); setRows(records); return records }
 useEffect(() => { if (!visible) return; let active = true; const poll = async () => { try { const records = await api.request<Summary[]>('recordings' + (sceneId ? '?sceneId=' + encodeURIComponent(sceneId) : '')); if (active) setRows(records) } catch (error) { if (active) setNote(String(error)) } }; void poll(); const timer = setInterval(() => void poll(), 1500); return () => { active = false; clearInterval(timer) } }, [sceneId, api, visible])
 useEffect(() => { onReplayChange(visible && Boolean(replay)); if (!visible) pauseAt(index); return () => onReplayChange(false) }, [Boolean(replay), visible])
 useEffect(() => {
  if (!replay || !container.current) return
  // 录制媒体也按会话寻址：录制品在 <recordingRoot>/sessions/<本窗口会话> 下，不手拼前缀。
  const instance = createViewer({ container: container.current, translate: (zh, en) => translateRef.current(zh, en), resolveResource: uri => api.mediaURL('recording-resource', { recordingId: replay.manifest.recordingId, uri }), onError: error => setNote(String(error)) })
  viewer.current = instance; setLoaded(false)
  return () => { ++instanceVersion.current; instance.dispose(); viewer.current = undefined }
 }, [replay?.manifest.recordingId, segment])
 useEffect(() => {
  const instance = viewer.current, revision = ++instanceVersion.current
  if (!instance || !currentSegment) return
  setLoaded(false)
  void instance.setScene(currentSegment.scene).then(() => { if (instanceVersion.current !== revision) return; if (currentSegment.frames[0]) instance.presentRecordedFrame(currentSegment.frames[0]); instance.frameAll(); setLoaded(true) }).catch(error => setNote(String(error)))
 }, [replay?.manifest.recordingId, segment])
 useEffect(() => { if (loaded && frame) viewer.current?.presentRecordedFrame(frame) }, [loaded, frame?.frameId])
 useEffect(() => {
  if (!playing || !loaded || !frames.length) return
  const next = frames[index + 1]
  if (!next) { pauseAt(index); return }
  const delay = Math.max(10, Math.min(1000, (next.simTime - frames[index]!.simTime) * 1000))
  const timer = setTimeout(() => { if (!playingRef.current) return; setIndex(value => value + 1) }, delay)
  return () => clearTimeout(timer)
 }, [playing, loaded, index, frames])
 const open = async (id: string) => { const value = await api.request<RecordingReplay>('recording?recordingId=' + encodeURIComponent(id)); pauseAt(0); setSegment(0); setReplay(value); return value.manifest }
 const returnToLive = () => { pauseAt(0); setReplay(undefined); setNote('') }
 const toggleChannel = (id: RecordingChannelId) => setChannels(old => old.includes(id) ? old.filter(value => value !== id) : RECORDING_CHANNEL_IDS_FOR_UI.filter(value => old.includes(value) || value === id))
 const start = async () => {
  if (!startInput || !world || !sceneId) return
  const result = await api.command<any>('recording_start', { sceneId, worldId: world.worldId, expectedGeneration: world.worldGeneration, ...startInput })
  setNote('')
  await refresh(); return result
 }
 /** 一个作业的**实际范围**：开始后从服务端清单读，和当前选择无关（改选只影响下一次）。 */
 const runningScope = (row: Summary) => { const scope = recordingFixedScope(row.source); return scope ? <div className="lya-help" data-testid="recording-running-scope" title={scopeText(scope, tr)}><div>{recordingScopeLabel(scope)}</div><div>{channelFacesText(recordingChannelFaces(scope.channels, row.channels), tr)}</div></div> : <p className="lya-help" data-testid="recording-running-scope">{tr('本次录制未固定机器人机位来源。', 'This recording did not fix a robot-camera source.')}</p> }
 const panelHead=<div className="lya-page-head"><div className="lya-page-heading"><h2 className="lya-page-title">{tr('录制','Recording')}</h2>{stage!=='empty'&&<span className="lya-eyebrow">{tr('固定机器人机位','Fixed robot camera')}</span>}</div>{!embedded&&<button type="button" className="lya-chip" aria-label={tr('关闭录制面板','Close recording panel')} onClick={close}>×</button>}</div>
 const sourceForm=<>
  {sourceOptions.length>0&&<>
   <div className="lya-field-row" data-testid="recording-source-choice"><span className="lya-field-label">{tr('机位','Camera source')}</span><select aria-label={tr('机器人机位','Robot camera')} value={sourceKey} onChange={event => setSourceKey(event.target.value)}><option value="">{tr('选择真实机位','Choose a real camera')}</option>{sourceOptions.map(option => <option key={option.key} value={option.key} title={option.label}>{option.label}{option.available ? '' : ` · ${tr('不可用', 'unavailable')}`}</option>)}</select></div>
   {!selected&&<p className="lya-help" data-testid="recording-source-hint">{tr('选择一个已挂载机位后，再显示通道与录制参数。','Choose a mounted camera to show channels and recording settings.')}</p>}
   {selected&&!ready.ok&&<p className="lya-help" role="alert" data-testid="recording-source-unavailable">{tr(`该机位暂不可用：${recordingSourceReasonText(ready.reason, tr)}`, `Camera unavailable: ${recordingSourceReasonText(ready.reason, tr)}`)}</p>}
   {selected&&ready.ok&&<div data-testid="recording-ready-form">
    <div className="lya-section"><span>{tr('通道','Channels')}</span><span className="lya-section-side">{channels.length}/3</span></div>
    <div className="lya-row lya-channel-row">{RECORDING_CHANNELS.map(channel => <label key={channel.id} title={channel.unit}><input type="checkbox" checked={channels.includes(channel.id)} onChange={() => toggleChannel(channel.id)}/>{channel.id==="rgb"?"RGB":channel.id==="camera-depth"?tr("深度","Depth"):"LiDAR"}</label>)}</div>
    <div className="lya-field-row"><span className="lya-field-label">{tr('时长','Duration')}</span><input type="number" aria-label={tr('录制秒数', 'Recording duration')} min={.1} max={300} value={limit} onChange={event => setLimit(Number(event.target.value))} style={{ width: 64 }}/><span className="lya-field-value">s</span></div>
    <div className="lya-field-row"><span className="lya-field-label">{tr('分辨率','Resolution')}</span><span className="lya-field-value">{width === undefined && height === undefined ? tr('未声明', 'Not declared') : `${width ?? tr('未声明', 'Not declared')} × ${height ?? tr('未声明', 'Not declared')}`}</span><button type="button" className="lya-chip" onClick={() => setShowSize(!showSize)}>{tr('设置','Edit')}</button></div>
    {showSize && <div className="lya-row"><input type="number" aria-label={tr('宽度', 'Width')} min={16} max={4096} step={1} value={width ?? ''} onChange={event => editSize({ width: event.target.value === '' ? undefined : Number(event.target.value) })} style={{ width: 70 }}/><span>×</span><input type="number" aria-label={tr('高度', 'Height')} min={16} max={4096} step={1} value={height ?? ''} onChange={event => editSize({ height: event.target.value === '' ? undefined : Number(event.target.value) })} style={{ width: 70 }}/></div>}
    <div className="lya-row"><button className="lya-primary" data-testid="recording-start" disabled={!startInput || !world || !sceneId || rows.some(row => row.status === 'recording')} title={tr('来源在本次录制中固定；停止只结束录制，不停止模拟。','The source is fixed for this job; stopping only ends the recording, not the simulation.')} onClick={() => perform(start)}>{tr('开始录制', 'Start recording')}</button></div>
   </div>}
   {selected&&!ready.ok&&openCamera&&<div className="lya-row"><button onClick={openCamera}>{tr('打开 Camera 修正机位','Open Camera to fix the camera')}</button></div>}
  </>}
 </>
 // V10：下一步按真实前提分流；标题只给缺失前提，说明只给一句可执行动作，不复述同一事实。不在 Recording 里改 Camera 空态。
 const emptyState = hasRobot
  ? <div data-testid="recording-empty" data-empty-reason={nativeError?'camera-error':'no-camera'}><EmptyState icon="recording" title={tr('这台机器人还没有可用机位','This robot has no usable camera')} detail={nativeError?tr('相机清单读取失败；打开 Camera 检查原因后重试。','The camera list could not be read; open Camera, check the cause, then retry.'):tr('添加或修正一个真实挂载机位后即可录制。','Add or fix a real mounted camera to start recording.')}><button className="lya-primary" onClick={openCamera} disabled={!openCamera}>{tr('配置机位','Configure camera')}</button></EmptyState>{nativeError&&<details className="lya-advanced"><summary>{tr('读取详情','Read error details')}</summary><p className="lya-help">{nativeError}</p></details>}</div>
  : <div data-testid="recording-empty" data-empty-reason="no-robot"><EmptyState icon="robot" title={tr('先添加一台机器人','Add a robot first')} detail={tr('录制需要机器人上的真实挂载机位。','Recording needs a real mounted camera on a robot.')}><button className="lya-primary" data-testid="recording-add-robot" onClick={openRobotLibrary} disabled={!openRobotLibrary}>{tr('添加机器人','Add robot')}</button></EmptyState></div>
 const runningCard=running?<div className="lya-detail-box" data-testid="recording-running" data-recording-id={running.recordingId}>
  <div className="lya-row"><strong>{tr('录制中','Recording')}</strong><span className="lya-spacer"/><span className="lya-row-side" data-testid="recording-running-elapsed" title={tr('累计仿真秒 / 配置上限','Accumulated simulated seconds / configured limit')}>{recordingElapsedLabel(running, tr)}</span></div>
  {runningScope(running)}
  <div className="lya-row"><span className="lya-help" title={running.lastFrame?`g${running.lastFrame.generation} / step ${running.lastFrame.stepIndex}`:undefined}>{running.frameCount} {tr('帧','frames')}</span><span className="lya-spacer"/><button className="lya-stop" data-testid="recording-stop-running" onClick={() => perform(async () => { const result = await api.command('recording_stop', { recordingId: running.recordingId }); await refresh(); return result })}>{tr('停止录制', 'Stop recording')}</button></div>
  <RecordingMissingFiles row={running} tr={tr}/>
 </div>:null
 const replayView=replay?<div className="lya-recording-view" data-testid="recording-replay-view">
  <div className="lya-recording-header">
   <div className="lya-recording-heading"><strong>{tr('录制回放', 'Recorded replay')}</strong></div>
   <button data-testid="recording-return-live" onClick={returnToLive}>{tr('返回实时视图', 'Return to live view')}</button>
  </div>
  <div ref={container} className="lya-recording-canvas" aria-label={tr('录制回放3D', 'Recorded 3D replay')} />
  <div className="lya-recording-controls">
   <button disabled={!loaded || !frames.length} onClick={() => { if (playingRef.current) { pauseAt(index); return } pauseAt(index === frames.length - 1 ? 0 : index); playNow() }}>{playing ? tr('暂停回放', 'Pause replay') : tr('播放录制', 'Play recording')}</button>
   <input type="range" aria-label={tr('录制回放时间线', 'Recorded replay timeline')} min={0} max={maxIndex} value={index} onChange={event => pauseAt(Number(event.target.value))} />
   <RecordingFrameReadout frame={frame} index={index} count={frames.length} tr={tr} firstTime={frames[0]?.simTime} lastTime={frames.at(-1)?.simTime}/>
   {replay.segments.length > 1 && <select aria-label={tr('录制代次', 'Recorded generation')} value={segment} onChange={event => { pauseAt(0); setSegment(Number(event.target.value)) }}>{replay.segments.map((s, i) => <option key={`${s.world.worldId}:${s.world.worldGeneration}:${s.world.appliedSceneRevision}`} value={i}>g{s.world.worldGeneration} · rev {s.world.appliedSceneRevision}</option>)}</select>}
  </div>
  {sourceSummary&&<details className="lya-recording-source"><summary>{tr('帧来源','Frame provenance')}</summary><div data-testid="recording-source" title={sourceSummary}>{sourceSummary}</div></details>}
 </div>:null
 const sideRows=<div className="lya-list" data-testid="recording-recent-list">
  {recentRows.map(row => <div className="lya-receipt" key={row.recordingId} {...row.status === 'recording' ? { 'data-testid': 'recording-active' } : {}}>
   <div className="lya-row"><strong>{row.status === 'recording' ? tr('录制中', 'Recording') : new Date(row.createdAt).toLocaleTimeString()}</strong><span className="lya-spacer"/><span className="lya-row-side">{row.frameCount} {tr('帧', 'frames')}</span></div>
   <span className={recordingOutcome(row, tr).warning ? 'lya-warning' : 'lya-help'} data-testid="recording-outcome">{recordingOutcome(row, tr).label}{` · ${recordingElapsedLabel(row, tr)}`}</span>
   {recordingOutcome(row, tr).reason&&<p className="lya-warning" role="status" data-testid="recording-end-reason">{recordingOutcome(row, tr).reason}</p>}
   {['failed','interrupted','killed'].includes(row.status)&&row.stopReason&&<p className="lya-warning" role="alert">{row.stopReason}</p>}
   {runningScope(row)}
   <RecordingMissingFiles row={row} tr={tr}/>
   <RecordingChannels channels={row.channels as never} source={recordingFixedScope(row.source)} mediaURL={uri => api.mediaURL('recording-resource', { recordingId: row.recordingId, uri })} tr={tr}/>
   <div className="lya-row">{row.status === 'recording'
    ? <button className="lya-stop" onClick={() => perform(async () => { const result = await api.command('recording_stop', { recordingId: row.recordingId }); await refresh(); return result })}>{tr('停止录制', 'Stop recording')}</button>
    : <><button onClick={() => perform(() => open(row.recordingId))}>{tr('观看回放', 'Watch replay')}</button><button onClick={() => perform(async () => { const result = await api.command<any>('recording_export', { recordingId: row.recordingId }); setNote(tr('导出已开始', 'Export started')); return result })}>{tr('导出', 'Export')}</button></>}</div>
   <details className="lya-advanced" data-testid="recording-technical-details"><summary>{tr('录制详情','Recording details')}</summary><div className="lya-help">{row.recordingId}</div><div className="lya-help">{row.status}{row.stopReason?` · ${row.stopReason}`:''}{row.lastFrame?` · g${row.lastFrame.generation} / step ${row.lastFrame.stepIndex}`:''}</div></details>
  </div>)}
  {recentRows.length===0&&rows.length>0&&<p className="lya-help">{tr('当前没有其它录制。','No other recordings.')}</p>}
 </div>
 const side=<div className="lya-recording-side">
  {panelHead}
  {replay&&<div className="lya-row" data-testid="recording-replay-summary"><strong>{tr('正在回放','Playing back')}</strong></div>}
  {!replay&&stage==='running'&&runningCard}
  {!replay&&stage==='empty'&&emptyState}
  {!replay&&stage==='choose-source'&&sourceForm}
  {!replay&&stage==='unavailable-source'&&sourceForm}
  {!replay&&stage==='setup'&&sourceForm}
  {!replay&&stage==='running'&&sourceOptions.length>0&&<details className="lya-advanced" data-testid="recording-next-settings"><summary>{tr('下一次录制参数','Next recording settings')}</summary><p className="lya-help">{tr('改动只准备下一次录制，不替换正在进行的作业。','Changes prepare the next recording and do not replace the running job.')}</p>{sourceForm}</details>}
  {recentRows.length>0&&<><div className="lya-section"><span>{tr('最近录制','Recent')}</span><span className="lya-section-side">{recentRows.length}</span></div>{sideRows}</>}
  {note&&<p className="lya-help" role="status">{note}</p>}
 </div>
 return <div className="lya-recordings">
  {replayView&&(replayHost?createPortal(replayView,replayHost):replayView)}
  {side}
 </div>
}
/** 通道顺序固定为真实量声明顺序（不做用户排序，避免通道身份被顺序误导）。 */
const RECORDING_CHANNEL_IDS_FOR_UI: readonly RecordingChannelId[] = RECORDING_CHANNELS.map(channel => channel.id)
