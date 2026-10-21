/**
 * P7C：录制产物的**真实回放**——按实际来源显示 RGB / 相机Z深度 / LiDAR range 帧，并给出原始文件下载。
 *
 * 回放单位是**一次真实测量样本**，不是文件：LiDAR 的 range 是主图，valid/hitGeom/preview 是同一次量测的
 * 辅助文件/下载，不增加帧数；RGB 与相机Z深度共享同一 captureId，保持配对。旧 flat files 格式继续可读。
 * 深度与 range 的像素解码复用 `npy-preview.ts` 的真实小端 float32/64 解码与**两种颜色规则**
 * （相机轴向 Z 用灰度、LiDAR 欧氏 range 用红绿比例 + 无返回洋红），与 P7A 相机面板同一份判据；
 * LiDAR 的归一化量程取**该次量测自己的** rayPattern.rangeM，不拿最新一次的值替代旧帧配置。
 * 播放/暂停与逐帧选择按真实采样时间（simTime）前进；这是**固定传感器回放**，与面板里的 Scene/world 3D replay 分开。
 * 二进制 valid/hitGeom 明确不画成 RGB，只给下载。媒体一律经会话授权的 recording-resource 取回。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RecordingFixedScope } from './recording-source.ts'
import { CAMERA_DEPTH_COLOR_RULE, LIDAR_RANGE_COLOR_RULE, colorizeNpy, decodeNpy, type NpyImage } from './npy-preview.ts'
import type { Translate } from './entity-editor.tsx'

export interface RecordingChannelFile { role: string; uri: string; mimeType?: string; unit?: string; shape?: number[]; dtype?: string; bytes?: number; sampleIndex?: number }
/** 一次真实测量样本的回放身份（与 manifest 的 `RecordedChannelSample` 同形）。 */
export interface RecordingChannelSample {
 captureId?: string; frameId?: string; stepIndex?: number; generation?: number; sceneRevision?: number; worldId?: string; simTime?: number
 cameraName?: string; parentEntityId?: string; parentBodyName?: string; referenceFrame?: string; receiptPath?: string; rangeM?: number
 targetStepIndex?: number; stepDrift?: number; synchronized?: boolean
 worldFromSensor?: { positionM?: number[]; quaternionXyzw?: number[] }
 files: RecordingChannelFile[]
}
export interface RecordingChannelRow { channel: string; cameraName: string; unit: string; frames: number; files: RecordingChannelFile[]; samples?: RecordingChannelSample[]; validCount?: number; noReturnCount?: number; rangeMinM?: number; rangeMaxM?: number; rangeMeanM?: number; unavailable?: string }

const IMAGE_ROLE = new Set(['rgb', 'preview'])
const NPY_ROLE = new Set(['depth', 'range'])
const MAIN_ROLE: Record<string, string> = { rgb: 'rgb', 'camera-depth': 'depth', 'lidar-range': 'range' }
const isImageFile = (file: RecordingChannelFile) => Boolean(file.mimeType?.startsWith('image/')) || IMAGE_ROLE.has(file.role)
const isDisplayableNpy = (file: RecordingChannelFile) => NPY_ROLE.has(file.role) || file.dtype === 'f4' || file.dtype === 'f8'

/**
 * 把通道文件分成**真实测量样本**：优先用 manifest 的 `samples`；旧 flat files 回退按 role 分组。
 * 样本数取 manifest 声明的 `frames`（真实测量数），所以滑条 max=frames-1，辅助文件不冒充帧。
 * 旧记录缺身份时只保证"回放单位是次"，不编造 captureId/时间。
 */
export function recordingChannelSamples(channel: RecordingChannelRow): RecordingChannelSample[] {
 if (Array.isArray(channel.samples) && channel.samples.length > 0) return channel.samples
 const files = channel.files ?? []
 const declared = Number.isFinite(channel.frames) && channel.frames > 0 ? Math.floor(channel.frames) : 0
 const count = declared > 0 ? declared : files.length > 0 ? 1 : 0
 if (count === 0 || files.length === 0) return []
 const groups: RecordingChannelFile[][] = []
 if (files.every(file => Number.isInteger(file.sampleIndex))) {
  for (const file of files) { const index = file.sampleIndex as number; (groups[index] ??= []).push(file) }
 } else if (channel.channel === 'lidar-range') {
  // 旧 LiDAR：每次量测以 range 开头；同一次量测的 valid/hitGeom/preview 跟在同一组。
  for (const file of files) { if (file.role === 'range' || groups.length === 0) groups.push([]); groups[groups.length - 1]!.push(file) }
 } else {
  for (const file of files) groups.push([file])
 }
 if (groups.length === count) return groups.map(group => ({ files: group }))
 if (groups.length < count) return [...groups, ...Array.from({ length: count - groups.length }, () => [] as RecordingChannelFile[])].map(group => ({ files: group }))
 // 分组数与声明帧数不一致：按声明帧数归并（只保证单位是"次"，不编造身份），最后一组吸收多出的辅助文件。
 const merged: RecordingChannelFile[][] = Array.from({ length: count }, () => [])
 groups.forEach((group, index) => merged[Math.min(index, count - 1)]!.push(...group))
 return merged.map(group => ({ files: group }))
}
/** 一次样本的可读身份：只列真实存在的字段；一个都没有就如实说缺身份，不编造时间。 */
export function recordingSampleIdentity(sample: RecordingChannelSample | undefined, tr: Translate): string {
 if (!sample) return ''
 const parts: string[] = []
 if (sample.cameraName) parts.push(sample.cameraName)
 if (sample.generation !== undefined) parts.push(`g${sample.generation}`)
 if (sample.sceneRevision !== undefined) parts.push(`rev ${sample.sceneRevision}`)
 if (sample.stepIndex !== undefined) parts.push(`step ${sample.stepIndex}`)
 if (Number.isFinite(sample.simTime)) parts.push(`${Number(sample.simTime).toFixed(3)} s`)
 if (sample.captureId) parts.push(`capture ${sample.captureId}`)
 if (sample.frameId) parts.push(`frame ${sample.frameId}`)
 if (sample.worldId) parts.push(`world ${sample.worldId}`)
 if (sample.referenceFrame) parts.push(`reference ${sample.referenceFrame}`)
 if (sample.targetStepIndex !== undefined) parts.push(`target step ${sample.targetStepIndex}`)
 if (Number.isFinite(sample.rangeM)) parts.push(`${tr('本次量程', 'range')} ${Number(sample.rangeM).toFixed(3)} m`)
 // 同步差：采集真实步号相对订阅帧步号的差；synchronized 只在完全同帧时为 true。
 if (sample.stepDrift !== undefined) parts.push(sample.synchronized ? tr('与订阅帧同帧', 'same step as subscription') : tr(`同步差 ${sample.stepDrift} 步`, `sync drift ${sample.stepDrift} steps`))
 if (sample.parentEntityId || sample.parentBodyName) parts.push([sample.parentEntityId, sample.parentBodyName].filter(Boolean).join('/'))
 return parts.length ? parts.join(' · ') : tr('旧记录：该样本没有逐样本身份/时间（不编造）。', 'Legacy record: this sample has no per-sample identity/time (not invented).')
}
/**
 * 传感器回放时间线：合并各通道真实样本，按**真实采样时间** simTime 排序（缺时间退到步号/原顺序）。
 * 播放光标沿这条时间线走；每个通道显示自己"当前时间"对应的那次量测（不按通道各自下标硬对齐）。
 */
export interface RecordingSensorEntry { channel: RecordingChannelRow; sample: RecordingChannelSample; index: number; order: number }
export function recordingSensorTimeline(channels: RecordingChannelRow[] | undefined): RecordingSensorEntry[] {
 const entries: RecordingSensorEntry[] = []
 for (const [channelIndex, channel] of (channels ?? []).entries()) recordingChannelSamples(channel).forEach((sample, index) => entries.push({ channel, sample, index, order: channelIndex * 1_000_000 + index }))
 return entries.sort((a, b) => {
  const at = Number.isFinite(a.sample.simTime) ? Number(a.sample.simTime) : undefined, bt = Number.isFinite(b.sample.simTime) ? Number(b.sample.simTime) : undefined
  if (at !== undefined && bt !== undefined && at !== bt) return at - bt
  if (a.sample.stepIndex !== undefined && b.sample.stepIndex !== undefined && a.sample.stepIndex !== b.sample.stepIndex) return a.sample.stepIndex - b.sample.stepIndex
  return a.order - b.order
 })
}
/** 时间线上第 index 项到下一项的真实间隔（毫秒）：1 倍速，不夹取——这就是"按实际采样时间前进"。 */
export function recordingSensorDelay(channels: RecordingChannelRow[] | undefined, index: number): number {
 const timeline = recordingSensorTimeline(channels)
 const at = Number(timeline[index]?.sample.simTime), bt = Number(timeline[index + 1]?.sample.simTime)
 return Number.isFinite(at) && Number.isFinite(bt) ? (bt - at) * 1000 : 500
}
/** 某通道在当前时间的光标：取 simTime <= time 的最后一次量测；没有任何更早样本时给第一次。 */
export function recordingChannelIndexAt(samples: RecordingChannelSample[], time: number | undefined): number {
 if (samples.length === 0 || time === undefined || !Number.isFinite(time)) return 0
 let chosen = 0
 for (let index = 0; index < samples.length; index++) {
  const sampleTime = Number(samples[index]?.simTime)
  if (!Number.isFinite(sampleTime)) continue
  if (sampleTime <= time + 1e-9) chosen = index
  else break
 }
 return chosen
}

/** 真 NPY→Canvas：解码后按通道语义着色；失败如实显示，不留上一张图。 */
function NpyChannelCanvas({ url, channel, spanM, tr }: { url: string; channel: RecordingChannelRow; spanM?: number; tr: Translate }) {
 const canvas = useRef<HTMLCanvasElement | null>(null)
 const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; error?: string; image?: NpyImage }>({ status: 'loading' })
 useEffect(() => {
  let live = true
  const controller = new AbortController()
  setState({ status: 'loading' })
  void (async () => {
   try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const array = decodeNpy(await response.arrayBuffer())
    const rule = channel.channel === 'lidar-range' ? LIDAR_RANGE_COLOR_RULE : CAMERA_DEPTH_COLOR_RULE
    // LiDAR 用**该次量测自己的**真实量程上界做归一化（与 worker preview 的 t=range/量程 同义）；深度用有限值区间。
    const image = colorizeNpy(array, rule, spanM === undefined ? {} : { spanM })
    if (live) setState({ status: 'ready', image })
   } catch (error) { if (live) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) }) }
  })()
  return () => { live = false; controller.abort() }
 }, [url, channel.channel, spanM])
 useEffect(() => {
  const image = state.image, target = canvas.current
  if (!image || !target) return
  const context = target.getContext('2d')
  if (!context) return
  target.width = image.width; target.height = image.height
  context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0)
 }, [state.image])
 if (state.status === 'error') return <p className="lya-help" role="alert">{tr(`NPY 解码失败：${state.error}`, `NPY decode failed: ${state.error}`)}</p>
 const spanNote = spanM === undefined ? tr('无逐帧量程配置，按本帧有限值区间着色', 'no per-frame range config; colored by this frame') : ''
 return <>
  <canvas ref={canvas} style={{ width: '100%', height: 'auto', imageRendering: 'pixelated' }} aria-label={tr(`${channel.channel} 帧`, `${channel.channel} frame`)}/>
  {state.status === 'ready' && state.image && <details className="lya-advanced"><summary>{tr('图像详情', 'Image details')}</summary><p className="lya-help">{state.image.ruleId} · {state.image.width}×{state.image.height} · {tr('区间', 'span')} [{state.image.spanMin?.toFixed(3) ?? '—'}, {state.image.spanMax?.toFixed(3) ?? '—'}] m · {tr('无效/无返回', 'invalid/no-return')} {state.image.invalid}{spanNote ? ` · ${spanNote}` : ''}</p></details>}
 </>
}

/** 一个通道里选中样本的产物：主图 + 同次辅助文件下载；辅助文件不占帧。 */
function SampleArtifacts({ channel, sample, mediaURL, tr, details }: { channel: RecordingChannelRow; sample: RecordingChannelSample; mediaURL: (uri: string) => string; tr: Translate; details: ReactNode }) {
 const mainRole = MAIN_ROLE[channel.channel]
 const main = sample.files.find(file => file.role === mainRole) ?? (sample.files.length === 1 ? sample.files[0] : undefined)
 const aux = sample.files.filter(file => file !== main)
 const spanM = channel.channel === 'lidar-range' && Number.isFinite(sample.rangeM) ? Number(sample.rangeM) : undefined
 const label = (file: RecordingChannelFile) => `${file.role}${file.shape ? ` · ${file.shape.join('×')}` : ''}${file.dtype ? ` ${file.dtype}` : ''}`
 return <>
  {main && (isImageFile(main) ? <img style={{ width: '100%', height: 'auto' }} src={mediaURL(main.uri)} alt={tr(`${channel.channel} 产物`, `${channel.channel} artifact`)}/> : isDisplayableNpy(main) ? <NpyChannelCanvas url={mediaURL(main.uri)} channel={channel} spanM={spanM} tr={tr}/> : <p className="lya-help">{tr('该通道文件是二进制掩码/几何索引，不在页面改画成图像；请下载原始文件核读。', 'This channel file is a binary mask / geometry index; it is not redrawn as an image. Download the raw file to inspect.')}</p>)}
  {!main && <p className="lya-help">{tr('该次量测没有落盘可显示文件。', 'This measurement has no saved displayable file.')}</p>}
  <details className="lya-advanced" data-testid={`recording-channel-${channel.channel}-details`}><summary>{tr('样本详情与下载', 'Sample details and downloads')}</summary>
   {details}
   {main && <div className="lya-row"><a href={mediaURL(main.uri)} download>{tr('下载主文件', 'Download main file')}（{label(main)}）</a></div>}
   {aux.length > 0 && <div className="lya-row" data-testid={`recording-channel-${channel.channel}-aux`} style={{ flexWrap: 'wrap' }}>{aux.map(file => <a key={`${file.role}:${file.uri}`} href={mediaURL(file.uri)} download>{tr('下载', 'Download')} {file.role}（{label(file)}）</a>)}</div>}
  </details>
 </>
}

function ChannelRow({ channel, source, cursorTime, timeline, onCursor, mediaURL, tr }: { channel: RecordingChannelRow; source?: RecordingFixedScope; cursorTime?: number; timeline: RecordingSensorEntry[]; onCursor: (value: number) => void; mediaURL: (uri: string) => string; tr: Translate }) {
 const samples = recordingChannelSamples(channel)
 const index = recordingChannelIndexAt(samples, cursorTime), sample = samples[index]
 const select = (value: number) => { const at = timeline.findIndex(entry => entry.channel === channel && entry.index === value); if (at >= 0) onCursor(at) }
 const cameraName = sample?.cameraName ?? channel.cameraName
 const label = channel.channel === 'rgb' ? 'RGB' : channel.channel === 'camera-depth' ? tr('相机 Z 深度 (m)', 'Camera Z depth (m)') : channel.channel === 'lidar-range' ? tr('LiDAR 射线距离 (m)', 'LiDAR ray range (m)') : `${channel.channel} · ${channel.unit}`
 const details = <>
  <p className="lya-help" data-testid={`recording-channel-${channel.channel}-identity`}>{recordingSampleIdentity(sample, tr)}</p>
  <p className="lya-help">{channel.unit} · {channel.frames} {tr('次量测', 'measurements')} · {channel.files.length} {tr('个文件', 'files')}</p>
  {channel.channel === 'lidar-range' && channel.validCount !== undefined && <p className="lya-help">{tr('有效', 'valid')} {channel.validCount} · {tr('无返回', 'no-return')} {channel.noReturnCount} · {tr('通道统计量程', 'channel-stat range')} {channel.rangeMinM?.toFixed(3)}–{channel.rangeMaxM?.toFixed(3)} m（{tr('均值', 'mean')} {channel.rangeMeanM?.toFixed(3)}）</p>}
 </>
 return <div data-testid={`recording-channel-${channel.channel}`}>
  <div className="lya-row"><strong>{label}</strong></div>
  <p className="lya-help" data-testid={`recording-channel-${channel.channel}-source`}>{[source?.robotName, cameraName.split('/').at(-1)].filter(Boolean).join(' · ')}</p>
  {channel.unavailable && <p className="lya-warning" role="alert">{tr('通道不可用', 'Channel unavailable')}: {channel.unavailable}</p>}
  {samples.length > 0 && <div className="lya-row"><input type="range" min={0} max={Math.max(0, samples.length - 1)} value={index} onChange={event => select(Number(event.target.value))} aria-label={tr(`${channel.channel} 帧选择`, `${channel.channel} frame`)}/><span>{index + 1}/{samples.length}</span></div>}
  {sample ? <SampleArtifacts channel={channel} sample={sample} mediaURL={mediaURL} tr={tr} details={details}/> : <p className="lya-help" role="status">{tr('该通道没有可回放的测量样本。', 'This channel has no playable measurement sample.')}</p>}
 </div>
}

/**
 * 一个录制的逐通道产物：只在**有真实通道统计**时出现；RGB/深度/range 各自具名，未采到不占位。
 * 顶部是**固定传感器回放**（播放/暂停 + 逐帧选择按真实采样时间），下面是逐通道样本；
 * 与主画布的 Scene/world 3D replay 分开具名，不互相冒充。
 */
export function RecordingChannels({ channels, source, mediaURL, tr }: { channels: RecordingChannelRow[] | undefined; source?: RecordingFixedScope; mediaURL: (uri: string) => string; tr: Translate }) {
 const timeline = useMemo(() => recordingSensorTimeline(channels), [channels])
 const [cursor, setCursor] = useState(0), [playing, setPlaying] = useState(false)
 // R-006：Pause/Seek 必须是**同一个入口**。只同步关闸还不够：若 timeout 在 Pause 前已把一条
 // 低优先级 `setCursor(+1)` 排进队列，Pause 只改 playing（另一个 hook）时，这条旧 advance 仍会在
 // flush 时 rebase 上来（真实桌面 7→8）。所以关闸的同一事件里还要把**本次选择的游标**显式排进
 // 同一个 cursor 队列：它晚于旧 advance，rebase 后落在最后，旧 advance 不能越过 Pause 再动。
 // Play 只开闸，不重置游标，于是从保持点继续。
 const playingRef = useRef(false)
 const maxCursor = Math.max(0, timeline.length - 1)
 const pauseAt = (value: number) => {
  playingRef.current = false
  setPlaying(false)
  setCursor(Math.max(0, Math.min(value, maxCursor)))
 }
 const playNow = () => { playingRef.current = true; setPlaying(true) }
 useEffect(() => {
  if (!playing || timeline.length < 2) return
  const timer = setTimeout(() => { if (!playingRef.current) return; setCursor(value => Math.min(value + 1, timeline.length - 1)) }, recordingSensorDelay(channels, cursor))
  return () => clearTimeout(timer)
 }, [playing, cursor, timeline, channels])
 if (!channels || channels.length === 0) return null
 const safe = Math.min(cursor, timeline.length - 1)
 const cursorTime = Number.isFinite(timeline[safe]?.sample.simTime) ? Number(timeline[safe]!.sample.simTime) : undefined
 const sync = channels.map(channel => { const samples = recordingChannelSamples(channel), sample = samples[recordingChannelIndexAt(samples, cursorTime)]; return sample ? `${channel.channel} step ${sample.stepIndex ?? '—'}${Number.isFinite(sample.simTime) ? ` @${Number(sample.simTime).toFixed(3)}s` : ''}` : undefined }).filter((value): value is string => Boolean(value))
 return <details className="lya-advanced" data-testid="recording-channels"><summary>{tr('固定传感器回放', 'Fixed sensor playback')}</summary>
  {timeline.length > 0 && <div className="lya-row" data-testid="recording-sensor-playback" style={{ flexWrap: 'wrap' }}>
   <button onClick={() => { if (playingRef.current) pauseAt(safe); else playNow() }}>{playing ? tr('暂停传感器回放', 'Pause sensor playback') : tr('播放传感器回放', 'Play sensor playback')}</button>
   <button onClick={() => pauseAt(safe - 1)}>{tr('上一帧', 'Previous frame')}</button>
   <button onClick={() => pauseAt(safe + 1)}>{tr('下一帧', 'Next frame')}</button>
   <input type="range" min={0} max={maxCursor} value={safe} onChange={event => pauseAt(Number(event.target.value))} aria-label={tr('传感器采样时间线', 'Sensor sample timeline')}/>
   <span>{safe + 1}/{timeline.length} · {tr('按真实采样时间', 'by real sample time')}</span>
  </div>}
  {sync.length > 0 && <details className="lya-advanced" data-testid="recording-sensor-details"><summary>{tr('同步详情', 'Synchronization details')}</summary><p className="lya-help" data-testid="recording-sensor-sync">{tr('当前各通道样本：', 'Current per-channel sample: ')}{sync.join(' · ')}</p></details>}
  {channels.map(channel => <ChannelRow key={`${channel.channel}:${channel.cameraName}`} channel={channel} source={source} cursorTime={cursorTime} timeline={timeline} onCursor={pauseAt} mediaURL={mediaURL} tr={tr}/>)}
 </details>
}
