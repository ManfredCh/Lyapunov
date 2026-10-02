import { copyFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAsset, robotVisual, localPath } from '../../scene-kit/src/formats.ts'
import type { Frame, SceneSnapshot, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { replayRecording, recordingFrameIdentity } from './recording.ts'
import { recordingActions, recordingEventResult, type RecordingCapture, type RecordingCaptureSource } from './recording-events.ts'
/** 多视角采集里单台相机的真实产物引用（路径已折算到录制目录内的副本）。 */
export interface RecordedCamera {
 cameraName: string; resolvedCameraName?: string; override?: boolean; width?: number; height?: number; rgb?: string; depth?: string; depthRangeM?: [number, number]
}
export interface RecordedCapture extends RecordingCaptureSource {
 worldId: string; generation?: number; stepIndex?: number; sceneRevision?: number; frameId?: string; receiptPath: string; cameraName?: string; observationFrameId?: string
 /** 原生回执自己的 captureId：标注/数据集只按它把像素、深度与标定对回同一次真实采集。 */
 captureId?: string
 /** 这次采集挂到的订阅帧身份；stepDrift 是同一步之外的步差，synchronized 只在步号完全相同时为 true。 */
 targetFrameId?: string; targetStepIndex?: number; stepDrift?: number; synchronized?: boolean
 /** 同一次 camera_capture_multi 采到的全部命名相机：共享同一 stepIndex/frameId，绝不把不同步的相机拼在一起。 */
 multiView?: boolean; cameraNames?: string[]; cameras?: RecordedCamera[]
}
export interface RecordingManifest {
 recordingId: string; sessionRef: string; sceneId: string; status: 'recording' | 'completed' | 'killed' | 'failed' | 'interrupted'; createdAt: string; stoppedAt?: string; stopReason?: string; jobId?: string; runId: string
 maxDurationS: number; frameCount: number; eventCount: number; observationCount?: number; firstFrame?: { frameId: string; generation: number; sceneRevision?: number; stepIndex: number; simTime: number }; lastFrame?: { frameId: string; generation: number; sceneRevision?: number; stepIndex: number; simTime: number }
 segments: Array<{ generation: number; world: WorldHandle; sceneFile: string; sourceSceneFile: string }>
 resources: Array<{ uri: string; path: string; bytes: number; mimeType: string }>; missing: Array<{ uri: string; reason: string }>
 captures?: RecordedCapture[]
 /** 录制期多视角采集的真实统计：synchronizedFrames 只统计采集步号与订阅帧步号完全相同的次数，driftedFrames/maxStepDrift 如实登记偏差。 */
 cameraCapture?: { cameraNames: string[]; width: number; height: number; everyNFrames: number; frames?: number; captures: number; synchronizedFrames: number; driftedFrames: number; maxStepDrift: number; stopped?: string }
}
export interface RecordingReplay { manifest: RecordingManifest; segments: Array<{ world: WorldHandle; scene: SceneSnapshot; frames: Frame[] }> }
/** `sessionId` 是这份录制所属的会话（manifest 的 sessionRef）：带上它 `replayURL` 才是能按会话取回的地址
 *  ——录制读取路由与写入端一样只按会话取，没有会话即明确失败，不落回全局共享目录。 */
export function recordingSummary(m: RecordingManifest, sessionId?: string) { return { recordingId: m.recordingId, ...(m.jobId === undefined ? {} : { jobId: m.jobId }), sessionRef: m.sessionRef, sceneId: m.sceneId, status: m.status, createdAt: m.createdAt, ...(m.stopReason === undefined ? {} : { stopReason: m.stopReason }), frameCount: m.frameCount, eventCount: m.eventCount, observationCount: m.observationCount ?? 0, ...(m.firstFrame === undefined ? {} : { firstFrame: m.firstFrame }), ...(m.lastFrame === undefined ? {} : { lastFrame: m.lastFrame }), generations: m.segments.map(s => ({ generation: s.generation, sceneRevision: s.world.appliedSceneRevision })), ...(m.cameraCapture === undefined ? {} : { cameraCapture: m.cameraCapture, cameraCaptureCount: m.captures?.filter(capture => capture.multiView).length ?? 0 }), missing: m.missing.slice(0, 20), missingCount: m.missing.length, replayURL: '/api/lyapunov/recording?recordingId=' + encodeURIComponent(m.recordingId) + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : '') } }
export function recordingSegmentMatches(segment: RecordingManifest['segments'][number], frame: Pick<Frame, 'worldId' | 'generation' | 'sceneRevision'>): boolean { return segment.world.worldId === frame.worldId && segment.generation === frame.generation && (frame.sceneRevision === undefined || segment.world.appliedSceneRevision === frame.sceneRevision) }
export function recordingDirectory(root: string, id: string) { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('INVALID_RECORDING_ID'); return join(resolve(root), id) }
export async function writeRecordingManifest(root: string, value: RecordingManifest) {
 const directory = recordingDirectory(root, value.recordingId); await mkdir(directory, { recursive: true, mode: 0o700 })
 const path = join(directory, 'recording.json'); await writeFile(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(path + '.tmp', path)
}
export async function readRecordingManifest(root: string, id: string): Promise<RecordingManifest> { return JSON.parse(await readFile(join(recordingDirectory(root, id), 'recording.json'), 'utf8')) }
export async function listRecordings(root: string, sceneId?: string) {
 let names: string[]; try { names = await readdir(root) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
 const records: RecordingManifest[] = []
 for (const name of names.filter(n => n.startsWith('recording-'))) try { const r = await readRecordingManifest(root, name); if (!sceneId || r.sceneId === sceneId) records.push(r) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
 return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
const mime = (path: string) => ({ '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.npy': 'application/x-npy', '.xml': 'application/x-mjcf+xml', '.urdf': 'application/x-urdf+xml', '.ply': 'application/x-ply', '.obj': 'text/plain' }[extname(path).toLowerCase()] ?? 'application/octet-stream')
/** recording: 资源键的规范形式：逐段按 URL 规则编码。Viewer 的 new URL(file, baseUri).href、
 *  原样拼接的 'recording:/' + path 与 HTTP 查询三条路径都落到同一条 manifest 授权；
 *  空格/中文/字面 % 各有不同的编码结果，不会互相冒领（a b.obj → a%20b.obj，a%20b.obj → a%2520b.obj）。 */
export function recordingResourceKey(path: string) { return 'recording:/' + path.split('/').map(segment => encodeURIComponent(segment)).join('/') }
/** 请求侧规范化：只在 recording: 键内逐段解码后重编码成同一规范形式。不做磁盘路径回退，
 *  也不猜非法转义（解码失败就按字面文本编码）；授权判断仍然只看 manifest 登记键。 */
export function normalizeRecordingResourceKey(uri: string) {
 if (!uri.startsWith('recording:/')) return uri
 return 'recording:/' + uri.slice('recording:/'.length).split('/').map(segment => { try { return encodeURIComponent(decodeURIComponent(segment)) } catch { return encodeURIComponent(segment) } }).join('/')
}
/** 把相对路径写成副本 XML 里的 URL 引用：逐段编码，保证 new URL(引用, 副本 baseUri).href 正好落在规范键上
 *  （# 与 ? 在 URL 里是分隔符，字面 % 也不能原样透传，否则会把 a%20b.obj 读成 a b.obj）。
 *  只用于浏览器消费的引用（meshdir/texturedir/assetdir、mesh/texture 的 file、URDF filename）；
 *  include 是 Node 端 scene-kit robotVisual 的文件系统引用（resolve(dirname(path), include.file) + readFile，
 *  不做 URL 解码），保持字面相对路径，否则文件名含空格/中文/字面 % 时回放读不到被包含文件。 */
function referenceText(path: string) { return path.split('/').map(segment => encodeURIComponent(segment)).join('/') }
/** include 元素（MJCF `<include file>` 与 xacro `<xacro:include filename>`）的引用由文件系统而非 URL 消费。 */
const filesystemReferenceTag = (tag: string) => tag === 'include' || tag.endsWith(':include')
/** 复制的原生模型里如果还有指向原源的绝对引用（绝对 meshdir/绝对 file/绝对 include），
 *  回放时 Viewer 会请求 recording:/<绝对路径> 这样的键，而 manifest 只登记副本落点，
 *  于是资源读不出来（11 号复现）；Node 端 robotVisual 也会直接去读原源。这里只改写副本
 *  文本：把引用折算成副本内部的相对路径，源文件与旧记录不动，读取仍只经 manifest 授权的副本。 */
const referenceFileExtensions = new Set(['.xml', '.mjcf', '.urdf'])
const referenceAttributes = /\b(meshdir|texturedir|assetdir|file|filename)\s*=\s*("[^"]*"|'[^']*')/g
const xmlTag = /<([a-zA-Z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const compilerTag = /<compiler\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i
function tagAttributes(body: string) { const found = new Map<string, string>(); for (const match of body.matchAll(referenceAttributes)) found.set(match[1]!, match[2]!.slice(1, -1)); return found }
/** 与 scene-kit robotDependencies 相同的目录规则，保证改写命中的正是被复制过的文件。 */
function referenceDirectory(tag: string, compiler: Map<string, string>) { return tag === 'mesh' ? compiler.get('meshdir') ?? compiler.get('assetdir') ?? '' : tag === 'texture' ? compiler.get('texturedir') ?? compiler.get('assetdir') ?? '' : '' }
async function rewriteCopiedReferences(directory: string, copies: Map<string, string>) {
 const changed = new Map<string, number>()
 for (const [original, path] of copies) {
  if (changed.has(path) || !referenceFileExtensions.has(extname(original).toLowerCase())) continue
  const target = join(directory, path), bytes = await readFile(target), text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) continue // 非 UTF-8 原生文件不做文本改写
  const base = dirname(original), compiler = tagAttributes(compilerTag.exec(text)?.[1] ?? '')
  // 先收集“原目录 → 副本目录”锚点：mesh 的 file 值相对 meshdir 解释，
  // 改写后必须继续保持这个相对基准，否则 Viewer 的 prefix/file 拼接会翻倍。
  const anchors = new Map<string, string>()
  for (const tag of text.matchAll(xmlTag)) for (const [attribute, value] of tagAttributes(tag[2]!)) {
   if (attribute !== 'file' && attribute !== 'filename') continue
   const reference = referenceDirectory(tag[1]!, compiler)
   if (!reference) continue // 无目录基准（file 相对 XML 自身解释）：不需要目录锚点
   const from = resolve(base, reference, value), mapped = copies.get(from)
   // 这里全程用相对路径拼接（join/normalize），不能用 resolve：resolve 会把副本相对路径
   // 锚到进程 cwd 上，让下面的 resources/ 前缀判定失效，绝对 meshdir 就永远改不掉。
   const copiedDir = mapped && normalize(join(dirname(mapped), relative(dirname(from), resolve(base, reference))))
   if (copiedDir && copiedDir.startsWith('resources/') && !anchors.has(resolve(base, reference))) anchors.set(resolve(base, reference), copiedDir)
  }
  const rewritten = text.replace(xmlTag, (all, tag: string, body: string) => '<' + tag + body.replace(referenceAttributes, (attribute, name: string, quoted: string) => {
   const value = quoted.slice(1, -1), quote = quoted[0]!
   const reference = referenceDirectory(tag, compiler), root = resolve(base, reference)
   if (name !== 'file' && name !== 'filename') {
    const copiedDir = anchors.get(resolve(base, value))
    return copiedDir ? name + '=' + quote + referenceText(relative(dirname(path), copiedDir)) + quote : attribute
   }
   const mapped = copies.get(resolve(root, value))
   const copiedDir = reference ? anchors.get(root) : dirname(path)
   if (!mapped || !copiedDir) return attribute
   const referencePath = relative(copiedDir, mapped)
   return name + '=' + quote + (filesystemReferenceTag(tag) ? referencePath : referenceText(referencePath)) + quote
  }) + '>')
  if (rewritten === text) continue
  await writeFile(target, rewritten, { mode: (await stat(target)).mode & 0o777 })
  changed.set(path, Buffer.byteLength(rewritten))
 }
 return changed
}
/** 复制实际引用与原生模型依赖；源快照保留原引用，独立场景写相对引用。 */
export async function captureRecordingScene(root: string, manifest: RecordingManifest, world: WorldHandle, source: SceneSnapshot) {
 if (source.sceneId !== world.sceneId || source.revision !== world.appliedSceneRevision) throw new Error('RECORDING_SCENE_REVISION_MISMATCH')
 if (manifest.segments.some(segment => recordingSegmentMatches(segment, { worldId: world.worldId, generation: world.worldGeneration, sceneRevision: world.appliedSceneRevision }))) return
 const directory = recordingDirectory(root, manifest.recordingId), snapshot = structuredClone(source), mapped = new Map<string, string>(), originals = new Map<string, string>()
 // 无可复制资源的Scene（空场景/只有primitive碰撞）也必须能录制：目录不能只在资源复制分支里顺手创建。
 await mkdir(directory, { recursive: true, mode: 0o700 })
 const sources = new Set<string>()
 for (const e of source.entities) {
  for (const ref of e.resources) for (const rep of [ref.original, ...ref.representations]) sources.add(rep.uri)
  for (const kind of ['mujoco', 'isaac']) { const native = (e.components[kind] as any)?.sourcePath; if (typeof native === 'string') sources.add(native) }
 }
 for (const uri of sources) {
  if (mapped.has(uri)) continue
  try {
   const original = localPath(uri)
   let dependencies: string[]
   try { dependencies = (await parseAsset(original)).dependencies.map(d => d.path) } catch (error) {
    if (String(error).includes('UNSUPPORTED_RESOURCE_FORMAT')) dependencies = [original]
    else throw error
   }
   let common = dirname(original)
   while (dependencies.some(p => relative(common, p).startsWith('..'))) common = dirname(common)
   const group = String(manifest.resources.length)
   for (const file of dependencies) {
    const url = pathToFileURL(file).href
    if (mapped.has(url)) { mapped.set(file, mapped.get(url)!); originals.set(file, mapped.get(url)!); continue }
    const path = join('resources', group, relative(common, file)), target = join(directory, path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(file, target)
    const bytes = (await stat(target)).size
    for (const key of [file, url, recordingResourceKey(path)]) { mapped.set(key, path); manifest.resources.push({ uri: key, path, bytes, mimeType: mime(file) }) }
    originals.set(file, path)
   }
   if (mapped.has(original)) mapped.set(uri, mapped.get(original)!)
  } catch (error) { manifest.missing.push({ uri, reason: String(error) }) }
 }
 // 副本内的原生模型引用改写成副本相对引用；改写后按实际字节数更新 manifest 登记。
 for (const [path, bytes] of await rewriteCopiedReferences(directory, originals)) for (const resource of manifest.resources) if (resource.path === path) resource.bytes = bytes
 for (const e of snapshot.entities) {
  for (const ref of e.resources) for (const rep of [ref.original, ...ref.representations]) if (mapped.has(rep.uri)) rep.uri = mapped.get(rep.uri)!
  for (const kind of ['mujoco', 'isaac']) { const native = (e.components[kind] as any)?.sourcePath; if (typeof native === 'string' && mapped.has(native)) (e.components[kind] as any).sourcePath = mapped.get(native)! }
  const articulation = e.components.articulation?.source as { uri?: string } | undefined
  if (articulation?.uri && mapped.has(articulation.uri)) articulation.uri = mapped.get(articulation.uri)!
  if (e.components.visual?.robot && typeof (e.components.mujoco as any)?.sourcePath === 'string') delete e.components.visual.robot
 }
 const sceneFile = `scene-g${world.worldGeneration}-r${source.revision}.json`, sourceSceneFile = `source-scene-g${world.worldGeneration}-r${source.revision}.json`
 await writeFile(join(directory, sourceSceneFile), JSON.stringify(source, null, 2), { mode: 0o600 }); await writeFile(join(directory, sceneFile), JSON.stringify(snapshot, null, 2), { mode: 0o600 })
 manifest.segments.push({ generation: world.worldGeneration, world: structuredClone(world), sceneFile, sourceSceneFile })
}
export async function captureRecordingFiles(root: string, manifest: RecordingManifest, files: string[]) {
 const directory = recordingDirectory(root, manifest.recordingId)
 for (const uri of files) {
  if (manifest.resources.some(r => r.uri === uri)) continue
  try {
   const original = localPath(uri), path = join('resources', 'capture-' + manifest.resources.length, basename(original)), target = join(directory, path)
   await mkdir(dirname(target), { recursive: true }); await copyFile(original, target); const bytes = (await stat(target)).size
   // 同时登记录制目录内的相对路径本身：manifest 里的逐相机引用（multiView.cameras[].rgb/depth）
   // 就是这个形式，消费者不需要知道源目录，也不需要重新拼绝对路径。
   for (const key of new Set([uri, original, pathToFileURL(original).href, path, recordingResourceKey(path)])) manifest.resources.push({ uri: key, path, bytes, mimeType: mime(original) })
  } catch (error) { manifest.missing.push({ uri, reason: String(error) }) }
 }
}
/** 标定与来源来自真实回执；仅派生相对媒体引用，原始绝对引用仍在原生事件中。
 *  多视角回执（camera_capture_multi）的逐相机 RGB/深度一并登记为资源，并逐相机记进 manifest：
 *  同一次采集的全部相机共享同一 stepIndex/frameId —— 录制侧永不把不同步的相机拼成"同步多视角"。 */
export async function captureRecordingResult(root: string, manifest: RecordingManifest, capture: RecordingCapture) {
 const { result, source } = capture
 const observation = recordingCaptureObservation(result)
 // 只有 Provider 单次调用才会返回 cameras[]：出现多相机却没有 multi 标记的回执一律拒绝，不猜。
 if (Array.isArray(result.cameras) && result.cameras.length > 1 && result.multi !== true) throw new Error('CAPTURE_MULTI_FLAG_MISMATCH')
 const cameraEntries: Record<string, any>[] = Array.isArray(result.cameras) ? result.cameras.filter((entry: any) => entry && typeof entry === 'object') : []
 const files = [result.rgb?.uri, result.depth?.uri, result.imagePath, result.posePath,
  ...cameraEntries.flatMap(entry => [entry.rgb?.uri, entry.depth?.uri])].filter((uri): uri is string => typeof uri === 'string')
 await captureRecordingFiles(root, manifest, files)
 const receipt = structuredClone(result)
 const rewrite = (owner: any, field: string) => {
  const uri = owner?.[field]?.uri
  if (typeof uri !== 'string') return
  const resource = manifest.resources.find(item => item.uri === uri)
  if (resource) owner[field].uri = resource.path
 }
 rewrite(receipt, 'rgb'); rewrite(receipt, 'depth')
 for (const entry of Array.isArray(receipt.cameras) ? receipt.cameras : []) { rewrite(entry, 'rgb'); rewrite(entry, 'depth') }
 for (const field of ['imagePath', 'posePath']) if (typeof receipt[field] === 'string') {
  const resource = manifest.resources.find(item => item.uri === receipt[field])
  if (resource) receipt[field] = resource.path
 }
 delete receipt.outputDir
 const captures = manifest.captures ??= [], receiptPath = join('resources', `capture-receipt-${captures.length}.json`)
 const directory = recordingDirectory(root, manifest.recordingId), content = JSON.stringify(receipt, null, 2)
 await mkdir(join(directory, 'resources'), { recursive: true })
 await writeFile(join(directory, receiptPath), content, { mode: 0o600 })
 manifest.resources.push({ uri: recordingResourceKey(receiptPath), path: receiptPath, bytes: Buffer.byteLength(content), mimeType: 'application/json' })
 // 逐相机条目引用**重写后**的 receipt 条目：manifest/数据集里的路径与原件解耦，隔离源目录后仍可读回。
 const cameras: RecordedCamera[] | undefined = cameraEntries.length === 0 ? undefined : (Array.isArray(receipt.cameras) ? receipt.cameras : []).map((entry: any) => ({
  cameraName: String(entry.cameraName),
  ...entry.resolvedCameraName === undefined ? {} : { resolvedCameraName: String(entry.resolvedCameraName) },
  ...entry.override === undefined ? {} : { override: Boolean(entry.override) },
  ...entry.width === undefined ? {} : { width: Number(entry.width) },
  ...entry.height === undefined ? {} : { height: Number(entry.height) },
  ...typeof entry.rgb?.uri === 'string' ? { rgb: entry.rgb.uri } : {},
  ...typeof entry.depth?.uri === 'string' ? { depth: entry.depth.uri } : {},
  ...Array.isArray(entry.depthRangeM) ? { depthRangeM: entry.depthRangeM as [number, number] } : {},
 }))
 captures.push({ ...source, worldId: result.worldId, generation: result.generation, stepIndex: result.stepIndex, sceneRevision: result.sceneRevision, frameId: result.frameId, cameraName: result.cameraName, ...typeof result.captureId === 'string' ? { captureId: result.captureId } : {}, ...(observation ? { observationFrameId: observation.frameId } : {}), receiptPath,
  ...cameras === undefined ? {} : { multiView: cameras.length > 1, cameraNames: cameras.map(camera => camera.cameraName), cameras } })
}
/** 相机时刻的关节/接触只能来自Provider同次capture，不用邻近订阅帧补造。 */
export function recordingCaptureObservation(receipt: Record<string, any>, capture?: RecordedCapture): Frame | undefined {
 const observation = receipt.observation as Frame | undefined
 if (!observation) return undefined
 for (const key of ['worldId', 'generation', 'sceneRevision', 'stepIndex', 'simTime', 'frameId'] as const) {
  if (observation[key] === undefined || observation[key] !== receipt[key]) throw new Error(`CAPTURE_OBSERVATION_SOURCE_MISMATCH: ${key}`)
  if (capture && key !== 'simTime' && capture[key] !== observation[key]) throw new Error(`CAPTURE_INDEX_SOURCE_MISMATCH: ${key}`)
 }
 if (!Array.isArray(observation.entities)) throw new Error('CAPTURE_OBSERVATION_ENTITIES_REQUIRED')
 return observation
}
export async function readRecording(root: string, id: string): Promise<RecordingReplay> {
 const directory = recordingDirectory(root, id), manifest = await readRecordingManifest(root, id)
 if (manifest.status === 'recording') throw new Error('RECORDING_NOT_FINISHED: 先停止录制，再打开固定快照')
 const all: Frame[] = []
 await replayRecording(join(directory, 'events.jsonl'), frame => all.push(frame))
 const segments = await Promise.all(manifest.segments.map(async segment => {
  const scene = JSON.parse(await readFile(join(directory, segment.sceneFile), 'utf8')) as SceneSnapshot
  for (const e of scene.entities) {
   for (const ref of e.resources) for (const rep of [ref.original, ...ref.representations]) if (!/^[a-z]+:/i.test(rep.uri)) rep.uri = recordingResourceKey(rep.uri)
   const source = (e.components.mujoco as any)?.sourcePath
   if (typeof source === 'string' && !source.includes(':')) {
    const visual = await robotVisual(join(directory, source)); visual.baseUri = recordingResourceKey(dirname(source) + '/')
    e.components.visual = { ...e.components.visual, kind: 'robot', robot: visual }
   }
  }
  if (scene.sceneId !== manifest.sceneId || scene.sceneId !== segment.world.sceneId || scene.revision !== segment.world.appliedSceneRevision) throw new Error('RECORDING_SCENE_REVISION_MISMATCH')
  return { world: segment.world, scene, frames: all.filter(frame => recordingSegmentMatches(segment, frame)) }
 }))
 if (segments.reduce((n, s) => n + s.frames.length, 0) !== all.length) throw new Error('RECORDING_FRAME_WITHOUT_SCENE')
 return { manifest, segments }
}
export async function readRecordingResource(root: string, id: string, uri: string): Promise<{ data: Uint8Array; mimeType: string }> {
 const manifest = await readRecordingManifest(root, id)
 // 先精确键，再按规范形式比较：只做编码规范化（空格/中文/字面 % 的写法差异），
 // 不把 URI 解析成文件系统路径，也不返回 manifest 未授权的任何资源。
 const wanted = normalizeRecordingResourceKey(uri)
 const resource = manifest.resources.find(r => r.uri === uri) ?? manifest.resources.find(r => normalizeRecordingResourceKey(r.uri) === wanted)
 if (!resource) throw new Error('RESOURCE_NOT_REFERENCED_BY_RECORDING')
 const directory = recordingDirectory(root, id), path = resolve(directory, resource.path)
 if (!path.startsWith(directory + '/')) throw new Error('INVALID_RECORDING_RESOURCE_PATH')
 return { data: await readFile(path), mimeType: resource.mimeType }
}
/** 数据集包含真实帧、原生事件、Scene版本和资源字节；中断/辅助数据不会标为成功训练episode。 */
export async function exportRecording(root: string, id: string) {
 const replay = await readRecording(root, id), directory = recordingDirectory(root, id), target = join(resolve(root), 'datasets', id + '-' + Date.now())
 await mkdir(target, { recursive: true, mode: 0o700 })
 for (const file of ['recording.json', 'events.jsonl', ...replay.manifest.segments.flatMap(s => [s.sceneFile, s.sourceSceneFile])]) await copyFile(join(directory, file), join(target, file))
 if (replay.manifest.resources.length) await cp(join(directory, 'resources'), join(target, 'resources'), { recursive: true })
 // Keep the raw event log as the audit source, and also emit a small, stable
 // trajectory stream for training/data consumers.  This is derived only from
 // the frames that replay accepted; it does not invent samples or replace the
 // original events.  One JSON object per line keeps the export streamable.
 const frames = new Map(replay.segments.flatMap(segment => segment.frames).map(frame => [recordingFrameIdentity(frame), frame]))
 const capturedFrames = new Set<string>()
 const multiViewCaptures: Record<string, any>[] = [], calibrationRefs: Record<string, any>[] = []
 for (const capture of replay.manifest.captures ?? []) {
  const receipt = JSON.parse(await readFile(join(directory, capture.receiptPath), 'utf8'))
  // 多视角：逐相机产物引用 + 逐相机真实标定；同一 capture 的相机共享同一 stepIndex/frameId（Provider 单次调用保证）。
  if (Array.isArray(capture.cameras) && capture.cameras.length > 0) {
   const receiptCameras: Record<string, any>[] = Array.isArray(receipt.cameras) ? receipt.cameras : []
   const captureId = typeof receipt.captureId === 'string' ? receipt.captureId : null
   multiViewCaptures.push({
    captureId, worldId: capture.worldId, generation: capture.generation, stepIndex: capture.stepIndex, sceneRevision: capture.sceneRevision, frameId: capture.frameId,
    multiView: capture.multiView === true, cameraCount: capture.cameras.length, cameraNames: capture.cameras.map(camera => camera.cameraName),
    // 单步标志只按回执自己的帧身份核对：同一次 Provider 调用内相机必然同帧，对不上就如实为 false。
    singleStep: receipt.frameId === undefined || receipt.frameId === capture.frameId, receipt: capture.receiptPath,
    cameras: capture.cameras.map(camera => ({ cameraName: camera.cameraName, ...camera.resolvedCameraName === undefined ? {} : { resolvedCameraName: camera.resolvedCameraName }, override: camera.override === true, resolution: [camera.width, camera.height], rgb: camera.rgb ?? null, depth: camera.depth ?? null, depthRangeM: camera.depthRangeM ?? null })),
   })
   for (const entry of receiptCameras) {
    if (!entry?.calibration) continue
    calibrationRefs.push({
     captureId, cameraName: entry.cameraName, receipt: capture.receiptPath, override: entry.override === true,
     intrinsics: entry.calibration.intrinsics, worldFromCamera: entry.calibration.worldFromCamera,
     depthSemantics: entry.calibration.depthSemantics, backgroundDepthM: entry.calibration.backgroundDepthM,
    })
   }
  }
  const observation = recordingCaptureObservation(receipt, capture)
  if (!observation) continue
  if (!replay.manifest.segments.some(segment => recordingSegmentMatches(segment, observation))) throw new Error('CAPTURE_SCENE_REVISION_NOT_RECORDED')
  frames.set(recordingFrameIdentity(observation), observation); capturedFrames.add(recordingFrameIdentity(observation))
 }
 const trajectory = [...frames.values()].sort((a, b) => a.generation - b.generation || (a.sceneRevision ?? -1) - (b.sceneRevision ?? -1) || a.stepIndex - b.stepIndex).map(frame => ({
  frameId: frame.frameId,
  worldId: frame.worldId,
  generation: frame.generation,
  stepIndex: frame.stepIndex,
  simTime: frame.simTime,
  sceneRevision: frame.sceneRevision,
  entities: frame.entities,
  contacts: frame.contacts,
 }))
 await writeFile(join(target, 'trajectory.jsonl'), trajectory.map(frame => JSON.stringify(frame)).join('\n') + (trajectory.length ? '\n' : ''), { mode: 0o600 })
 // 计数一律按 events.jsonl 与 replay 接受的实际帧独立核算（不抄录制清单）：清单写盘与
 // 采集落盘是两个异步路径，清单字段可能落后；数据集自己给出实测值，并保留 manifestFrameCount
 // 供核对（两者不一致时能被发现，而不是由构造保证相等——02 报告指出的自证问题）。
 const recordedFrames = replay.segments.reduce((count, segment) => count + segment.frames.length, 0)
 // 逐帧逐相机样本流：每行是一个真实 (capture, camera)，共享该 capture 的 stepIndex/frameId/captureId；
 // 同一 capture 的多个相机只出现在同一 captureId 下，绝不跨步拼接。
 const cameraSamples = multiViewCaptures.flatMap(capture => capture.cameras.map((camera: Record<string, any>) => ({
  captureId: capture.captureId, worldId: capture.worldId, generation: capture.generation, stepIndex: capture.stepIndex, sceneRevision: capture.sceneRevision, frameId: capture.frameId,
  cameraName: camera.cameraName, override: camera.override === true, width: camera.resolution?.[0] ?? null, height: camera.resolution?.[1] ?? null,
  rgb: camera.rgb, depth: camera.depth, depthRangeM: camera.depthRangeM ?? null, calibration: capture.receipt, cameraCount: capture.cameraCount,
 })))
 await writeFile(join(target, 'camera-samples.jsonl'), cameraSamples.map(sample => JSON.stringify(sample)).join('\n') + (cameraSamples.length ? '\n' : ''), { mode: 0o600 })
 const assistedFrames = replay.segments.flatMap(s => s.frames).filter(f => (f as any).executionMode === 'assisted-teleport').length
 const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
 const observationEvents = events.filter(event => event.kind === 'observation').length
 const sessionEvents = events.filter(event => event.kind === 'session-event').length
 const actions = recordingActions(events).map(({ receipt, source }) => ({ actionId: receipt.actionId, worldId: receipt.worldId, generation: receipt.generation, status: receipt.status, startStep: receipt.startStep, endStep: receipt.endStep, source }))
 // 标注引用：只从真实会话事件里已发生的相机标注回执提取，且必须指向本次录制登记过的真实 capture；
 // 对不上的一律如实列进 untraceableAnnotations，不伪造可追溯性，也不把标注当成新的帧。
 const recordedCaptureIds = new Set(replay.manifest.captures?.map(capture => capture.captureId).filter((value): value is string => typeof value === 'string') ?? [])
 const annotations: Record<string, any>[] = []
 for (const entry of events) {
  // 事件日志里裹着原生 Session envelope：解析用里面的原事件，与 recordingActions 同一路径。
  const result = recordingEventResult(entry.kind === 'session-event' ? entry.event : entry)
  if (!result || typeof result.annotationId !== 'string' || typeof result.captureId !== 'string' || !Array.isArray(result.worldPointM)) continue
  annotations.push({
   annotationId: result.annotationId, captureId: result.captureId, cameraName: result.cameraName, worldId: result.worldId,
   frameId: result.frameId, stepIndex: result.stepIndex, generation: result.generation, sceneRevision: result.sceneRevision,
   pixel: result.pixel, depthM: result.depthM, depthSource: result.depthSource, calibrationSource: result.calibrationSource,
   worldPointM: result.worldPointM, cameraPointM: result.cameraPointM, resolution: result.resolution, override: result.override === true,
   traceable: recordedCaptureIds.has(result.captureId),
  })
 }
 const dataset = { format: 'lyapunov-simulation-jsonl-v1', recordingId: id, sessionRef: replay.manifest.sessionRef, recordingStatus: replay.manifest.status, taskAchieved: null, frames: recordedFrames, manifestFrameCount: replay.manifest.frameCount, trajectoryFrames: trajectory.length, captureObservationFrames: capturedFrames.size, actions, sessionEvents, contactSensorObservations: observationEvents, generations: replay.manifest.segments.map(s => ({ generation: s.generation, sceneRevision: s.world.appliedSceneRevision, scene: s.sceneFile })), assistedFrames, physicalOnly: replay.segments.every(s => s.frames.every(f => (f as any).executionMode === 'physical-contact')), resources: [...new Set(replay.manifest.resources.map(r => r.path))], captures: replay.manifest.captures ?? [], multiView: multiViewCaptures.length > 0, multiViewCameras: multiViewCaptures, calibrations: calibrationRefs, annotations, annotationCount: annotations.length, untraceableAnnotations: annotations.filter(annotation => !annotation.traceable).map(annotation => annotation.annotationId), missing: replay.manifest.missing, events: 'events.jsonl', trajectory: 'trajectory.jsonl', cameraSamples: 'camera-samples.jsonl', cameraSampleCount: cameraSamples.length, source: '实际模拟订阅帧与原生DSH会话事件；录制完成不等于任务成功；trajectory.jsonl按frameId去重合并订阅实帧与Provider同次采集(capture回执)的observation，不插值补帧；frames/contactSensorObservations/sessionEvents按events.jsonl实际记录独立计数，manifestFrameCount保留清单原值供核对；周期contact/sensor observation只保存在events.jsonl，不并入trajectory；multiViewCameras逐条来自同一次camera_capture_multi（同stepIndex/frameId），calibrations/annotations只引用本次录制登记过的真实capture' }
 await writeFile(join(target, 'dataset.json'), JSON.stringify(dataset, null, 2), { mode: 0o600 })
 return { recordingId: id, directory: target, manifestPath: join(target, 'dataset.json'), frameCount: dataset.frames, eventCount: dataset.sessionEvents, resourceCount: dataset.resources.length, missing: dataset.missing, status: dataset.missing.length ? 'PARTIAL' : 'completed', taskAchieved: null }
}
