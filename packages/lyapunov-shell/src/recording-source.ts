/**
 * P7C：固定机器人机位 Recording 的**来源与通道**纯判据。放在这里（而不是 RecordingPanel 组件体内）
 * 是为了能被真实运行的单测钉住：面板列出哪些机位、哪些能勾、开始请求带什么、请求了但没采到的通道
 * 怎么显示——都由这一份判据决定，不靠读源码。
 *
 * 来源 owner 仍是既有事实：Scene 文档的 `components.camera.mount` 与 `camera_list` 原生回执
 * （`parentEntityId`/`parentBodyName`）。本模块只做投影，不新建第二份机位状态、不保存像素。
 */
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

/** 录制支持的**真实量**：RGB（PNG）、相机轴向 Z 深度（米）、LiDAR 沿射线欧氏 range（米）。 */
export type RecordingChannelId = 'rgb' | 'camera-depth' | 'lidar-range'
export interface RecordingChannelSpec { id: RecordingChannelId; unit: string; zh: string; en: string }
export const RECORDING_CHANNELS: readonly RecordingChannelSpec[] = [
 { id: 'rgb', unit: 'png-rgb-8bit', zh: 'RGB', en: 'RGB' },
 { id: 'camera-depth', unit: 'm-axial-z', zh: '相机 Z 深度（米）', en: 'Camera Z depth (m)' },
 { id: 'lidar-range', unit: 'm-euclidean-range', zh: 'LiDAR 射线 range（米）', en: 'LiDAR ray range (m)' },
]
export const RECORDING_CHANNEL_IDS: readonly RecordingChannelId[] = RECORDING_CHANNELS.map(channel => channel.id)

/** 一个可选固定机位：按**完整机位身份**（机器人实例 + body + 相机名）区分同名机器人/相机。 */
export interface RecordingSourceOption {
 /** 身份键 `<robotEntityId>/<bodyName>/<cameraName>`：换机器人/机位即换键，不串。 */
 key: string
 cameraName: string
 resolvedCameraName?: string
 /** 人类可读：机器人名 · body · 相机短名。 */
 label: string
 robotEntityId: string
 robotName?: string
 bodyName: string
 origin: 'scene' | 'native'
 available: boolean
 reason?: string
 width?: number
 height?: number
}
/** 请求体里 source 的窄形状（与 robot-workflows recording_start 的字段一致）。 */
export interface RecordingSourceRequest { robotEntityId: string; robotName?: string; bodyName: string; cameraName: string; referenceFrame?: string }

const shortName = (cameraName: string) => cameraName.includes('/') ? cameraName.slice(cameraName.lastIndexOf('/') + 1) : cameraName
/** 与既有录制尺寸输入边界一致；缺值不转换为隐式录制默认值。 */
export function recordingDimensionValid(value: unknown): value is number {
 return typeof value === 'number' && Number.isInteger(value) && value >= 16 && value <= 4096
}
/** 优先真实声明/原生配置尺寸；camera_list 的 intrinsics 可能只是 640×480 参考分辨率。 */
function sourceResolution(scene: SceneSnapshot | undefined, row: any): { width?: number; height?: number } {
 const entity = scene?.entities.find(entity => row.cameraSource === 'scene-camera' && (entity.entityId === row.entityId || row.cameraName === `${entity.entityId}/${(entity.components.camera as any)?.name ?? entity.name}`))
 const component = entity?.components.camera as { width?: number; height?: number; intrinsics?: { width?: number; height?: number } } | undefined
 const candidates = [component, component?.intrinsics, row, row.appliedIntrinsicsPx, row.declaredIntrinsicsPx, { width: row.engineIntrinsics?.resolution?.[0], height: row.engineIntrinsics?.resolution?.[1] }, row.intrinsics]
 for (const size of candidates) if (recordingDimensionValid(size?.width) && recordingDimensionValid(size?.height)) return { width: size.width, height: size.height }
 return {}
}
/**
 * 原生/Scene 的 bodyName 有时带当前实体前缀（`<entityId>/<localBody>`，与 camera-authoring 读回同形）。
 * 只精简**可见 label**；option value、source 请求与 metadata 仍保留完整 bodyName，不改 source 结构。
 */
const shortBodyName = (bodyName: string, entityId?: string) => entityId && bodyName.startsWith(entityId + '/') ? bodyName.slice(entityId.length + 1) : bodyName
/** 机器人名只用于显示；没读到就用实体 id，不编造名字。 */
const robotLabel = (scene: SceneSnapshot | undefined, entityId: string) => scene?.entities.find(entity => entity.entityId === entityId)?.name ?? entityId

/**
 * 当前 world 的**真实已挂载机位**清单，来自 `camera_list` 原生回执（Scene 挂载机位也会出现在回执里），
 * 再补上 Scene 已声明但尚未读回原生的挂载机位（标 unavailable + 原因，仍给 Camera 配置入口）。
 * 世界固定机位（没有 parent body）不在此列：Recording 录的是随机器人的固定机位，不是自由/世界相机。
 */
export function recordingSourceOptions(scene: SceneSnapshot | undefined, receipt: any): RecordingSourceOption[] {
 const options = new Map<string, RecordingSourceOption>()
 const rows: any[] = Array.isArray(receipt?.cameras) ? receipt.cameras : []
 for (const row of rows) {
  if (!row || typeof row.cameraName !== 'string' || !row.cameraName) continue
  const robotEntityId = typeof row.parentEntityId === 'string' && row.parentEntityId ? row.parentEntityId : undefined
  const bodyName = typeof row.parentBodyName === 'string' && row.parentBodyName ? row.parentBodyName : typeof row.bodyName === 'string' && row.bodyName ? row.bodyName : undefined
  if (!robotEntityId || !bodyName) continue
  const key = `${robotEntityId}/${bodyName}/${row.cameraName}`
  if (options.has(key)) continue
  const name = robotLabel(scene, robotEntityId)
  options.set(key, {
   key, cameraName: row.cameraName, ...(typeof row.resolvedCameraName === 'string' ? { resolvedCameraName: row.resolvedCameraName } : {}),
   label: `${name} · ${shortBodyName(bodyName,robotEntityId)} · ${shortName(row.cameraName)}`, robotEntityId, ...(name === robotEntityId ? {} : { robotName: name }), bodyName,
   origin: row.cameraSource === 'scene-camera' ? 'scene' : 'native', available: row.available !== false,
   ...(row.available === false ? { reason: typeof row.reason === 'string' && row.reason ? row.reason : 'CAMERA_UNAVAILABLE' } : {}),
   ...sourceResolution(scene, row),
  })
 }
 // Scene 声明了挂载、但当前 world 尚未把它读回原生清单的机位：如实标 unavailable，不静默从列表里消失。
 for (const entity of scene?.entities ?? []) {
  const component = entity.components.camera as { name?: string; mount?: { entityId?: string; bodyName?: string } } | undefined
  const mount = component?.mount
  if (!mount?.entityId || !mount.bodyName) continue
  const cameraName = `${entity.entityId}/${component?.name ?? entity.name}`
  const key = `${mount.entityId}/${mount.bodyName}/${cameraName}`
  if (options.has(key)) continue
  const name = robotLabel(scene, mount.entityId)
  options.set(key, { key, cameraName, label: `${name} · ${shortBodyName(mount.bodyName,mount.entityId)} · ${component?.name ?? entity.name}`, robotEntityId: mount.entityId, ...(name === mount.entityId ? {} : { robotName: name }), bodyName: mount.bodyName, origin: 'scene', available: false, reason: 'CAMERA_NOT_READ_BACK' })
 }
 return [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
}
/** 选中的机位能不能开始：必须真实可用（引擎读回且没被拒）；不可用就给出原因。 */
export function recordingSourceReady(option: RecordingSourceOption | undefined): { ok: boolean; reason?: string } {
 if (!option) return { ok: false, reason: 'RECORDING_SOURCE_REQUIRED' }
 if (!option.available) return { ok: false, reason: option.reason ?? 'CAMERA_UNAVAILABLE' }
 return { ok: true }
}
/**
 * 不可用原因的**可执行表述**：引擎/回执给的是稳定代码（`CAMERA_NOT_READ_BACK` 等），
 * 直接摆给用户等于没说。这里把已知代码翻成人能照做的下一步，未知代码原样保留（不编造原因）。
 * 与 `recordingSourceReady().reason` 一一对应，面板与测试共用这一份。
 */
export function recordingSourceReasonText(reason: string | undefined, tr: (zh: string, en: string) => string): string {
 switch (reason) {
  case 'RECORDING_SOURCE_REQUIRED': return tr('先选择一个已挂载机位。', 'Choose a mounted camera first.')
  case 'CAMERA_NOT_READ_BACK': return tr('物理世界还没把这个挂载机位读回引擎；先在 Camera 面板确认机位可用，再让世界重新同步。', 'The physics world has not read this mounted camera back yet; confirm it in Camera, then re-sync the world.')
  case 'CAMERA_UNAVAILABLE': return tr('引擎报告该机位当前不可用；打开 Camera 查看原因。', 'The engine reports this camera as unavailable; open Camera for the reason.')
  default: return reason ?? tr('引擎没有给出原因。', 'The engine reported no reason.')
 }
}
/** 开始请求体：固定来源 + 请求通道 + 时长/分辨率。未选机位或时长为非法值时返回 undefined（面板据此禁用）。 */
export function recordingStartInput(option: RecordingSourceOption | undefined, channels: readonly RecordingChannelId[], durationS: number, width: number | undefined, height: number | undefined): { maxDurationS: number; source: RecordingSourceRequest; channels: RecordingChannelId[]; width: number; height: number } | undefined {
 if (!recordingSourceReady(option).ok || !option) return undefined
 if (!Number.isFinite(durationS) || durationS < .1 || durationS > 300) return undefined
 if (!recordingDimensionValid(width) || !recordingDimensionValid(height)) return undefined
 if (channels.length === 0) return undefined
 const source: RecordingSourceRequest = { robotEntityId: option.robotEntityId, ...(option.robotName ? { robotName: option.robotName } : {}), bodyName: option.bodyName, cameraName: option.cameraName }
 return { maxDurationS: durationS, source, channels: [...RECORDING_CHANNEL_IDS.filter(id => channels.includes(id))], width, height }
}
/** 一次录制**运行时固定的来源**（开始后改选只影响下一次，不替换当前作业）：作业上下文里的只读投影。 */
export interface RecordingFixedScope { cameraName: string; robotName?: string; robotEntityId?: string; bodyName?: string; channels: string[] }
/** 固定清单的显示名；只缩短 label，完整身份仍由清单和请求保留。 */
export function recordingScopeLabel(scope: RecordingFixedScope): string {
 return [scope.robotName ?? scope.robotEntityId, scope.bodyName ? shortBodyName(scope.bodyName, scope.robotEntityId) : undefined, shortName(scope.cameraName)].filter(Boolean).join(' · ')
}
export function recordingFixedScope(source: any): RecordingFixedScope | undefined {
 if (!source || typeof source.cameraName !== 'string') return undefined
 return { cameraName: source.cameraName, ...(typeof source.robotName === 'string' ? { robotName: source.robotName } : {}), ...(typeof source.robotEntityId === 'string' ? { robotEntityId: source.robotEntityId } : {}), ...(typeof source.bodyName === 'string' ? { bodyName: source.bodyName } : {}), channels: Array.isArray(source.channels) ? source.channels.filter((value: unknown): value is string => typeof value === 'string') : [] }
}
/**
 * 一个请求通道的显示状态：采到帧且没有失败才 completed；没有统计的显示 requested；
 * 后续采集失败不会抹掉已采到的帧，unavailable 与真实帧数必须同时保留。
 */
export interface RecordingChannelFace { id: string; unit: string; status: 'completed' | 'unavailable' | 'requested'; frames: number; reason?: string }
export function recordingChannelFaces(requested: readonly string[], channels: any[] | undefined): RecordingChannelFace[] {
 const rows: any[] = Array.isArray(channels) ? channels : []
 return requested.map(id => {
  const spec = RECORDING_CHANNELS.find(channel => channel.id === id)
  const stat = rows.find(row => row?.channel === id)
  const frames = stat && Number.isFinite(stat.frames) ? Number(stat.frames) : 0
  if (stat && typeof stat.unavailable === 'string') return { id, unit: spec?.unit ?? '', status: 'unavailable' as const, frames, reason: stat.unavailable }
  if (frames > 0) return { id, unit: spec?.unit ?? String(stat?.unit ?? ''), status: 'completed' as const, frames }
  return { id, unit: spec?.unit ?? '', status: 'requested' as const, frames: 0 }
 })
}
