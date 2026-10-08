import { useEffect, useRef, useState } from 'react'
import { createViewer, type SceneViewer } from '@lyapunov/viewer/client'
import type { Frame, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import type { RecordingManifest, RecordingReplay } from '../../robot-workflows/src/recording-files.ts'
import { workbenchAPI } from './workbench-api.ts'
import { RecordingFrameReadout } from './recording-frame-readout.tsx'
import type { Translate } from './entity-editor.tsx'
// `missing`/`missingCount`：服务端 `recordingSummary()`（`robot-workflows/src/recording-files.ts:33`）**一直在算**、
// `register("recordings")`（`plugin.ts:2053`）**一直在发**，而这里此前**没接** ⇒ 录制缺件（资源读不回来的那些
// uri 与原因）对用户不可见（`ZERO-CONSUMER-FIELD-AUDIT-20260926.md` D2）。行类型带上这两个键才谈得上渲染。
// ⚠️ `missingCount` **不是** `RecordingManifest` 的字段 —— 它是 `recordingSummary()` 现算的（`m.missing.length`；
// 落在清单上的只有被截到前 20 条的 `missing`）⇒ 只能在行类型里显式声明 `number`。
// 把它塞进 `Pick<RecordingManifest, …>` 会是一条 **tsc 错误**（TS2344：`'missingCount'` 不满足
// `keyof RecordingManifest` 约束）⇒ 拿一句 grep 把仓库的门弄红，方向反了（2026-09-27 实测：这个形状红过 3 条）。
type Summary = Pick<RecordingManifest, 'recordingId' | 'sceneId' | 'status' | 'frameCount' | 'firstFrame' | 'lastFrame' | 'createdAt' | 'missing'> & { missingCount: number; generations: Array<{ generation: number; sceneRevision: number }> }
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
export function RecordingPanel({ api, sceneId, world, tr, perform, onReplayChange, close, visible = true }: { api: ReturnType<typeof workbenchAPI>; sceneId?: string; world?: WorldHandle; tr: Translate; perform: (fn: () => Promise<unknown>) => void; onReplayChange: (value: boolean) => void; close: () => void; visible?: boolean }) {
 const [rows, setRows] = useState<Summary[]>([]), [replay, setReplay] = useState<RecordingReplay>(), [segment, setSegment] = useState(0), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [limit, setLimit] = useState(60), [note, setNote] = useState(''), [loaded, setLoaded] = useState(false), [listVisible, setListVisible] = useState(true)
 const container = useRef<HTMLDivElement>(null), viewer = useRef<SceneViewer>(), instanceVersion = useRef(0)
 const translateRef=useRef(tr);translateRef.current=tr
 const currentSegment = replay?.segments[segment], frames = currentSegment?.frames ?? [], frame = frames[index]
 const sourceSummary = currentSegment && frame
  ? `scene ${currentSegment.scene.sceneId} · world ${currentSegment.world.worldId} · g${frame.generation} · scene rev ${currentSegment.world.appliedSceneRevision} · frame rev ${frame.sceneRevision}`
  : undefined
 const refresh = async () => { const records = await api.request<Summary[]>('recordings' + (sceneId ? '?sceneId=' + encodeURIComponent(sceneId) : '')); setRows(records); return records }
 useEffect(() => { if (!visible) return; let active = true; const poll = async () => { try { const records = await api.request<Summary[]>('recordings' + (sceneId ? '?sceneId=' + encodeURIComponent(sceneId) : '')); if (active) setRows(records) } catch (error) { if (active) setNote(String(error)) } }; void poll(); const timer = setInterval(() => void poll(), 1500); return () => { active = false; clearInterval(timer) } }, [sceneId, api, visible])
 useEffect(() => { onReplayChange(visible && Boolean(replay)); if (!visible) setPlaying(false); return () => onReplayChange(false) }, [Boolean(replay), visible])
 useEffect(() => {
  if (!replay || !container.current) return
  // 录制媒体也按会话寻址：录制品在 <recordingRoot>/sessions/<本窗口会话> 下，不手拼前缀。
  const instance = createViewer({ container: container.current, translate:(zh,en)=>translateRef.current(zh,en), resolveResource: uri => api.mediaURL('recording-resource', { recordingId: replay.manifest.recordingId, uri }), onError: error => setNote(String(error)) })
  viewer.current = instance; setLoaded(false)
  return () => { ++instanceVersion.current; instance.dispose(); viewer.current = undefined }
 }, [replay?.manifest.recordingId, segment])
 useEffect(() => {
  const instance = viewer.current, revision = ++instanceVersion.current
  if (!instance || !currentSegment) return
  setLoaded(false)
  void instance.setScene(currentSegment.scene).then(() => { if (instanceVersion.current !== revision) return; instance.frameAll(); if (currentSegment.frames[0]) instance.presentRecordedFrame(currentSegment.frames[0]); setLoaded(true) }).catch(error => setNote(String(error)))
 }, [replay?.manifest.recordingId, segment])
 useEffect(() => { if (loaded && frame) viewer.current?.presentRecordedFrame(frame) }, [loaded, frame?.frameId])
 useEffect(() => {
  if (!playing || !loaded || !frames.length) return
  const next = frames[index + 1]
  if (!next) { setPlaying(false); return }
  const delay = Math.max(10, Math.min(1000, (next.simTime - frames[index]!.simTime) * 1000))
  const timer = setTimeout(() => setIndex(value => value + 1), delay)
  return () => clearTimeout(timer)
 }, [playing, loaded, index, frames])
 const open = async (id: string) => { const value = await api.request<RecordingReplay>('recording?recordingId=' + encodeURIComponent(id)); setPlaying(false); setSegment(0); setIndex(0); setReplay(value); setListVisible(false); return value.manifest }
 return <div className="lya-recordings">
  {replay && <div className="lya-recording-view">
   <div className="lya-recording-header">
    <div className="lya-recording-heading"><strong>{tr('录制回放', 'Recorded replay')}</strong><span title={tr('不会向实时世界发送动作', 'No actions sent to the live world')}>{tr('不会向实时世界发送动作', 'No actions sent to the live world')}</span></div>
    <button onClick={() => { setPlaying(false); setReplay(undefined); close() }}>{tr('返回实时视图', 'Return to live view')}</button>
   </div>
   <div ref={container} className="lya-recording-canvas" aria-label={tr('录制回放3D', 'Recorded 3D replay')} />
   <div className="lya-recording-controls">
    <button disabled={!loaded || !frames.length} onClick={() => { if (index === frames.length - 1) setIndex(0); setPlaying(!playing) }}>{playing ? tr('暂停回放', 'Pause replay') : tr('播放录制', 'Play recording')}</button>
    <input type="range" aria-label={tr('录制回放时间线', 'Recorded replay timeline')} min={0} max={Math.max(0, frames.length - 1)} value={index} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)) }} />
    <RecordingFrameReadout frame={frame} index={index} count={frames.length} tr={tr}/>
    {replay.segments.length > 1 && <select aria-label={tr('录制代次', 'Recorded generation')} value={segment} onChange={event => { setPlaying(false); setIndex(0); setSegment(Number(event.target.value)) }}>{replay.segments.map((s, i) => <option key={`${s.world.worldId}:${s.world.worldGeneration}:${s.world.appliedSceneRevision}`} value={i}>g{s.world.worldGeneration} · rev {s.world.appliedSceneRevision}</option>)}</select>}
    <button onClick={() => setListVisible(!listVisible)}>{tr('录制列表', 'Recordings')}</button>
   </div>
   {sourceSummary && <div className="lya-recording-source" data-testid="recording-source" title={sourceSummary}>{sourceSummary}</div>}
  </div>}
  {(!replay || listVisible) && <aside className="lya-floating-panel lya-inspector" style={{ zIndex: 6, maxHeight: replay ? '45%' : undefined }}><div className="lya-panel-title"><strong>{tr('录制与回放', 'Recordings')}</strong><button onClick={close}>×</button></div>
   {!replay && <><p className="lya-help">{tr('也可以直接在对话中说“录制接下来30秒”。录制不改变模拟；停止仅结束采集。', 'You can ask in the conversation to record the next 30 seconds. Recording does not control the simulation.')}</p><div className="lya-row"><input type="number" aria-label={tr('录制秒数', 'Recording duration')} min={.1} max={300} value={limit} onChange={event => setLimit(Number(event.target.value))} style={{ width: 65 }} /><span>s</span><button disabled={!world || !sceneId} onClick={() => perform(async () => { const result = await api.command<any>('recording_start', { sceneId, worldId: world!.worldId, expectedGeneration: world!.worldGeneration, maxDurationS: limit }); setNote(tr('已开始录制，Job ', 'Recording started, job ') + result.jobId); await refresh(); return result })}>{tr('开始录制', 'Start recording')}</button></div></>}
   {rows.length === 0 && <p className="lya-help">{tr('暂无录制。', 'No recordings yet.')}</p>}
   {rows.map(row => <div className="lya-receipt" key={row.recordingId}><strong>{new Date(row.createdAt).toLocaleTimeString()} · {row.frameCount} {tr('帧', 'frames')}</strong><span>{row.status} · {row.lastFrame ? `g${row.lastFrame.generation} / step ${row.lastFrame.stepIndex}` : '—'}</span><RecordingMissingFiles row={row} tr={tr}/><div className="lya-row">{row.status === 'recording' ? <button onClick={() => perform(async () => { const result = await api.command('recording_stop', { recordingId: row.recordingId }); await refresh(); return result })}>{tr('停止录制', 'Stop recording')}</button> : <><button onClick={() => perform(() => open(row.recordingId))}>{tr('观看回放', 'Watch replay')}</button><button onClick={() => perform(async () => { const result = await api.command<any>('recording_export', { recordingId: row.recordingId }); setNote(tr('数据集导出 Job：', 'Dataset export job: ') + result.jobId); return result })}>{tr('导出数据集', 'Export dataset')}</button></>}</div></div>)}
   {note && <p className="lya-help" role="status">{note}</p>}
  </aside>}
 </div>
}
