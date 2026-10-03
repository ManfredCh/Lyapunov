/**
 * 真实 MuJoCo 引擎下的 `outputDir` 落盘验证（任务86；70 REPORT §6.5 的真实缺陷面）。
 *
 * 与同目录 `output-path.test.ts` 的分工：那份用探针 SimService 钉 Tool/Command 边界的解析口径，跑得快、
 * 不需要引擎；这份把**真引擎**接上（真 MuJoCoProvider → 真 python worker → 真渲染），走**真 ToolRegistry
 * 与真 Command 服务**，判据全部落在真实磁盘与真实图像上：
 *   1. 会话 cwd 与"宿主进程 cwd"是两个不同目录，两边都预置同名相对路径的诱饵文件；
 *   2. 只用**相对** outputDir 调 camera_capture_multi / sensor_capture / camera_dataset_export（含 Command 路径）；
 *   3. 断言 PNG/深度/数据集全部落在会话 cwd 下的目标目录，宿主机 cwd 的诱饵目录一个字节没多；
 *   4. 真解码 PNG（inflate + 反过滤）与 .npy 头：分辨率、真实像素、真实米制深度；
 *   5. 用图像里真实的红色地标像素 + `camera_project_annotation` 反投影回世界坐标，核对它落在真实地标上
 *      —— 证明这些帧确实是这个 world、这个位姿渲染出来的，而不是只回显了一串正确字符串；
 *   6. 没有会话 cwd 的相对路径必须明确失败且**不落任何文件**；
 *   7. 世界用 sim_close 关掉，关闭后 sim_world_list 为空。
 *
 * 运行：LYAPUNOV_MUJOCO_PYTHON=<sdk python> bun test packages/robot-tools/test/output-path-mujoco.test.ts
 * 没有可用的 MuJoCo SDK 解释器时整组跳过（判据与产品一致：LYAPUNOV_MUJOCO_PYTHON，否则包内默认落点）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chdir, cwd as processCwd } from 'node:process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as MuJoCoPlugin from '../../sim-mujoco/src/plugin.ts'
import { apply } from '../src/plugin.ts'
import { outputDirTools } from '../src/output-path.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
/** 与产品同一条解析：显式覆盖优先，否则包内安装落点（install-provider mujoco）。 */
const MUJOCO_PYTHON = process.env.LYAPUNOV_MUJOCO_PYTHON?.trim() || join(REPO_ROOT, '.runtime/sim-python/bin/python')
const FIXTURE_XML = join(REPO_ROOT, 'packages/sim-mujoco/fixtures/moving-cameras.xml')
const EVIDENCE_DIR = process.env.LYAPUNOV_EVIDENCE_DIR?.trim()
/** 场景里的真实地标（坐标取自 fixtures/moving-cameras.xml，不另造一套读数）。 */
const LANDMARKS = {
  red_landmark: { center: [0.45, 0.25, 0.12], half: [0.12, 0.09, 0.12] },
  green_landmark: { center: [-0.2, -0.35, 0.08], half: [0.08, 0.08, 0.08] },
}

// ---------------------------------------------------------------- 真实图像/深度读取（不引第三方解码器）

/** 最小 PNG 解码：8 位、非隔行、颜色类型 2/6，按 PNG 规范做反过滤。 */
function decodePng(data: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  assert.equal(data.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'PNG 魔数不符')
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('latin1')
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      bitDepth = body[8]!; colorType = body[9]!; assert.equal(body[12], 0, 'PNG 不能是隔行扫描')
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  assert.equal(bitDepth, 8, `PNG 位深必须是 8，实测 ${bitDepth}`)
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
  assert.ok(channels > 0, `PNG 颜色类型必须是 2/6，实测 ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++]!
    const line = raw.subarray(cursor, cursor + stride); cursor += stride
    const prev = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0
      const b = prev[x]!
      const c = x >= channels ? prev[x - channels]! : 0
      const value = line[x]!
      out[x] = (filter === 0 ? value
        : filter === 1 ? value + a
        : filter === 2 ? value + b
        : filter === 3 ? value + ((a + b) >> 1)
        : filter === 4 ? value + paeth(a, b, c)
        : (() => { throw new Error(`未知 PNG 行过滤类型 ${filter}`) })()) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** 最小 .npy 读取：只支持真实渲染产物的 '<f4' 小端、C 顺序。 */
function decodeNpy(data: Buffer): { shape: number[]; floats: Float32Array } {
  assert.equal(data.subarray(0, 6).toString('latin1'), '\x93NUMPY', 'NPY 魔数不符')
  const major = data[6]!
  const headerLength = major === 1 ? data.readUInt16LE(8) : data.readUInt32LE(8)
  const headerStart = major === 1 ? 10 : 12
  const header = data.subarray(headerStart, headerStart + headerLength).toString('latin1')
  assert.match(header, /'descr':\s*'<f4'/, `NPY 数据类型必须是 <f4：${header}`)
  assert.match(header, /'fortran_order':\s*False/, `NPY 必须是 C 顺序：${header}`)
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean).map(Number)
  const start = headerStart + headerLength
  const floats = new Float32Array(data.buffer.slice(data.byteOffset + start, data.byteOffset + start + (data.length - start)))
  return { shape, floats }
}

// ---------------------------------------------------------------- 图像判据

/** 地标颜色在渲染里会被光照/阴影改变，只按"通道排序 + 明显间隔"判色，不按固定 RGB 相等。 */
function classify(r: number, g: number, b: number): 'red_landmark' | 'green_landmark' | undefined {
  if (r > 110 && r - g > 60 && r - b > 60) return 'red_landmark'
  if (g > 110 && g - r > 45 && g - b > 45) return 'green_landmark'
  return undefined
}

function colorAt(image: { width: number; channels: number; pixels: Buffer }, u: number, v: number) {
  const base = (v * image.width + u) * image.channels
  return { r: image.pixels[base]!, g: image.pixels[base + 1]!, b: image.pixels[base + 2]! }
}

/** 图像里某种地标颜色的像素质心（取最大的一块，避免把别处的同类像素混进来）。 */
function blobCentroid(image: { width: number; height: number; channels: number; pixels: Buffer }, kind: 'red_landmark' | 'green_landmark') {
  const hits: Array<[number, number]> = []
  for (let v = 0; v < image.height; v++) for (let u = 0; u < image.width; u++) {
    const { r, g, b } = colorAt(image, u, v)
    if (classify(r, g, b) === kind) hits.push([u, v])
  }
  if (hits.length < 12) return undefined
  const sum = hits.reduce((acc, [u, v]) => [acc[0]! + u, acc[1]! + v], [0, 0] as [number, number])
  return { count: hits.length, u: Math.round(sum[0]! / hits.length), v: Math.round(sum[1]! / hits.length) }
}

function depthAt(depth: { shape: number[]; floats: Float32Array }, u: number, v: number): number {
  const width = depth.shape[1]!
  return depth.floats[v * width + u]!
}

/** world = R·p_cam + t（相机看 -z，深度是轴向米制距离，见回执 calibration.depthSemantics）。 */
function axialDepthOf(calibration: any, point: number[]): number {
  const r = calibration.worldFromCamera.rotationMatrix as number[][]
  const t = calibration.worldFromCamera.positionM as number[]
  const d = [point[0]! - t[0]!, point[1]! - t[1]!, point[2]! - t[2]!]
  return -(r[2]![0]! * d[0]! + r[2]![1]! * d[1]! + r[2]![2]! * d[2]!)
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
}

// ---------------------------------------------------------------- 测试夹具

interface Harness {
  ctx: Context
  agent: Agent
  bareAgent: Agent
  call(name: string, input: unknown, caller?: Agent): Promise<{ isError: boolean; value: any; text: string }>
  command(line: string, caller?: Agent): Promise<{ kind: string; text: string }>
  close(): Promise<void>
}

async function createHarness(pythonPath: string, sessionCwd: string): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Commands)
  // 执行边界也按产品同一层装配：会话**有效策略**（真 dsh-sandbox-policy）与原生沙箱（真
  // dsh-sandbox-local，本机走 bwrap）。少了它们 MuJoCo 会按失败关闭拒绝启动 worker —— 这是
  // 接线本身的设计，不是测试可以绕过的分支，所以这里用真服务而不是替身。
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: sessionCwd })
  await ctx.plugin(SandboxLocal)
  // 真 Provider（真 python worker、真 MuJoCo 渲染），按产品同一入口装配。
  await ctx.plugin(MuJoCoPlugin as never, { pythonPath } as never)
  const xml = await readFile(FIXTURE_XML, 'utf8')
  const snapshot = {
    sceneId: 'probe-camera-scene',
    revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities: [{
      entityId: 'probe_rig', name: 'probe_rig',
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources: [],
      components: { mujoco: { xml } },
    }],
  }
  // Scene 只负责把这一份 fixture 快照喂给真实 Provider；物理与渲染全部来自真引擎。
  // 场景服务按会话取（产品 `ctx.scene.forSession` 那一份规则）：探针按会话各给一份，不吃全局单例。
  const sceneProbe = () => ({ scene: { snapshot: async (sceneId: string) => ({ ...snapshot, sceneId }), commit: async () => snapshot } })
  ctx.reflect.provide('scene', { forSession: () => sceneProbe() } as never)
  await ctx.plugin({ name: 'test-robot-tools', inject: ['tools', 'commands', 'scene', 'sim'], apply: (scoped: Context) => { apply(scoped) } } as never, undefined as never)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('robot-tools-mujoco'), {}, { cwd: sessionCwd })
  const bareAgent = await loop.create(SessionId('robot-tools-mujoco-bare'), {})
  return {
    ctx, agent, bareAgent,
    async call(name, input, caller = agent) {
      const executed = await ctx.tools.execute({ callId: ToolCallId(`robot-tools-mujoco:${name}`), name, arguments: { input }, agent: caller, signal: new AbortController().signal })
      return { isError: executed.isError === true, value: executed.value, text: (executed.content ?? []).map((block: any) => block.text ?? '').join('\n') }
    },
    async command(line, caller = agent) {
      const execution = await ctx.commands.execute(caller, line, [], new AbortController().signal)
      if (!execution) throw new Error('命令没有解析成功：' + line)
      return execution.result as { kind: string; text: string }
    },
    async close() { await ctx.fiber.dispose().catch(() => undefined) },
  }
}

async function listing(directory: string): Promise<string[]> {
  return existsSync(directory) ? (await readdir(directory)).sort() : []
}

async function copyEvidence(from: string, to: string) {
  if (!EVIDENCE_DIR) return
  await mkdir(to, { recursive: true })
  await cp(from, to, { recursive: true })
}

describe('真实 MuJoCo 引擎 + 真实 ToolRegistry/Command 的 outputDir 落盘', { skip: existsSync(MUJOCO_PYTHON) ? false : `没有可用的 MuJoCo SDK 解释器：${MUJOCO_PYTHON}（可用 LYAPUNOV_MUJOCO_PYTHON 覆盖）` }, () => {
  // 真引擎用例：整段要走真 MuJoCo worker + 真渲染，并发验收轮会贴着默认 5s 上限（单跑实测约 2.3–3.7s）；
  // 用 node:test 的 options 显式声明 60s，不让负载型偶发超时被读成产品回归。
  test('相对 outputDir 全部落到会话 cwd：宿主机 cwd 诱饵未动，主仓目录未新增', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'robot-tools-mujoco-'))
    const hostCwd = join(root, 'host-cwd')
    const sessionCwd = join(root, 'session-workspace')
    // 诱饵：两边同名的相对路径，只有会话 cwd 那份应该被写到。
    const decoyRelative = 'derived/frames/probe_frame'
    for (const [base, name] of [[hostCwd, 'decoy-host-cwd.txt'], [sessionCwd, 'decoy-session-workspace.txt']] as const) {
      await mkdir(join(base, decoyRelative), { recursive: true })
      await writeFile(join(base, decoyRelative, name), `诱饵 ${name}\n`, 'utf8')
    }
    const originalCwd = processCwd()
    const report: any = { engine: {}, receipts: {}, files: {}, images: {}, annotations: {}, commands: {}, dataset: {} }
    let harness: Harness | undefined
    try {
      // 让本进程（也就是 python worker 的父进程）站在"宿主 cwd"上：worker 的 cwd 就是这里。
      chdir(hostCwd)
      harness = await createHarness(MUJOCO_PYTHON, sessionCwd)
      // 声明：这份文件里的相对路径都以会话工作区为基准（与 bash 一致）。
      assert.deepEqual([...outputDirTools], ['sensor_capture', 'camera_capture_multi', 'camera_dataset_export'])

      const opened = await harness.call('sim_open', { sceneId: 'probe-camera-scene', options: { timestepS: 0.002, clock: 'manual', realtimeFactor: 1 } })
      assert.equal(opened.isError, false, opened.text)
      const worldId: string = opened.value.worldId
      report.engine.open = { worldId, engineId: opened.value.engineId, engineVersion: opened.value.engineVersion, status: opened.value.status, groundGeomNames: opened.value.groundGeomNames }
      assert.equal(opened.value.engineId, 'mujoco')

      const cameras = await harness.call('camera_list', { worldId })
      assert.equal(cameras.isError, false, cameras.text)
      const names: string[] = cameras.value.cameras.map((camera: any) => camera.cameraName)
      report.engine.cameras = cameras.value.cameras.map((camera: any) => ({ cameraName: camera.cameraName, fovyDeg: camera.fovyDeg, parentBodyName: camera.parentBodyName, positionM: camera.worldFromCamera.positionM }))
      assert.deepEqual(names.slice().sort(), ['probe_rig/overview', 'probe_rig/wrist'])

      // ---- 1) camera_capture_multi：相对 outputDir（多视角同帧）
      const multi = await harness.call('camera_capture_multi', { worldId, cameraNames: names, outputDir: decoyRelative, width: 320, height: 240 })
      assert.equal(multi.isError, false, multi.text)
      const target = join(sessionCwd, decoyRelative)
      assert.equal(multi.value.outputDir, target, '回执必须回报会话 cwd 下的绝对目录')
      assert.equal(multi.value.cameras.length, 2)
      report.receipts.camera_capture_multi = {
        requestedOutputDir: decoyRelative, reportedOutputDir: multi.value.outputDir, captureId: multi.value.captureId,
        frameId: multi.value.frameId, stepIndex: multi.value.stepIndex, sceneRevision: multi.value.sceneRevision,
        cameras: multi.value.cameras.map((camera: any) => ({ cameraName: camera.cameraName, resolvedCameraName: camera.resolvedCameraName, rgb: camera.rgb.uri, depth: camera.depth.uri, depthRangeM: camera.depthRangeM, intrinsics: camera.calibration?.intrinsics })),
      }

      const multiFiles = (await listing(target)).filter((name) => name !== 'decoy-session-workspace.txt')
      assert.equal(multiFiles.length, 4, `两个相机各一张 PNG + 一份深度，实测 ${multiFiles.join(',')}`)

      // ---- 2) 真解码：分辨率、真实像素、真实米制深度、标注反投影回真实地标
      for (const camera of multi.value.cameras) {
        const pngPath = new URL(camera.rgb.uri).pathname
        const npyPath = new URL(camera.depth.uri).pathname
        assert.equal(pngPath.startsWith(target + '/'), true, `RGB 必须落在会话 cwd 的目标目录：${pngPath}`)
        assert.equal(npyPath.startsWith(target + '/'), true, `深度必须落在会话 cwd 的目标目录：${npyPath}`)
        const image = decodePng(await readFile(pngPath))
        const depth = decodeNpy(await readFile(npyPath))
        assert.equal(image.width, 320); assert.equal(image.height, 240)
        assert.deepEqual(depth.shape, [240, 320], '深度图分辨率必须与请求一致')
        const finite = Array.from(depth.floats).filter((value) => Number.isFinite(value) && value > 0)
        assert.equal(finite.length, 320 * 240, '深度图必须是有限的正米制深度')
        const entry: any = { rgbBytes: (await readFile(pngPath)).length, depthBytes: (await readFile(npyPath)).length, channels: image.channels, depthMinM: Math.min(...finite), depthMaxM: Math.max(...finite) }
        // 图像里必须真有 fixture 的地标颜色像素——不是一张空图/纯背景图。
        for (const kind of ['red_landmark', 'green_landmark'] as const) {
          const blob = blobCentroid(image, kind)
          if (!blob) { entry[kind] = { visible: false }; continue }
          entry[kind] = { visible: true, pixels: blob.count, pixel: [blob.u, blob.v], color: colorAt(image, blob.u, blob.v), depthM: depthAt(depth, blob.u, blob.v), axialDepthToCenterM: axialDepthOf(camera.calibration, LANDMARKS[kind].center) }
        }
        report.images[camera.cameraName] = entry
      }

      // ---- 3) 红色地标像素 → camera_project_annotation 反投影回世界坐标，必须落在真实地标上
      for (const camera of multi.value.cameras) {
        const image = decodePng(await readFile(new URL(camera.rgb.uri).pathname))
        const depth = decodeNpy(await readFile(new URL(camera.depth.uri).pathname))
        const blob = blobCentroid(image, 'red_landmark')
        if (!blob) { report.annotations[camera.cameraName] = { redVisible: false }; continue }
        const annotation = await harness.call('camera_project_annotation', { worldId, cameraName: camera.cameraName, pixel: [blob.u, blob.v], captureId: multi.value.captureId })
        assert.equal(annotation.isError, false, annotation.text)
        const worldPoint: number[] = annotation.value.worldPointM
        const error = distance(worldPoint, LANDMARKS.red_landmark.center)
        const depthFromImage = depthAt(depth, blob.u, blob.v)
        report.annotations[camera.cameraName] = {
          redVisible: true, pixel: [blob.u, blob.v], depthM: depthFromImage,
          annotatedDepthM: annotation.value.cameraPointM?.[2] === undefined ? undefined : Math.abs(annotation.value.cameraPointM[2]),
          worldPointM: worldPoint, distanceToRedLandmarkCenterM: error, distanceToRedLandmarkSurfaceM: Math.max(0, error - Math.hypot(...LANDMARKS.red_landmark.half)),
        }
        // 表面距离容差 0.05 m：真渲染像素 → 真深度 → 真标定反投影，必须落在真实红地标盒面上。
        assert.ok(Math.max(0, error - Math.hypot(...LANDMARKS.red_landmark.half)) < 0.05,
          `${camera.cameraName} 的红色像素反投影没有落在真实地标上：${JSON.stringify(report.annotations[camera.cameraName])}`)
        // 同一像素的深度图读数必须与反投影点的轴向深度一致（深度图与图像同帧同源）。
        assert.ok(Math.abs(Math.abs(annotation.value.cameraPointM[2]) - depthFromImage) < 0.02,
          `像素深度与图像不一致：图 ${depthFromImage} 标注 ${annotation.value.cameraPointM[2]}`)
      }

      // ---- 4) sensor_capture（自由相机）相对 outputDir 走同一条解析
      const sensor = await harness.call('sensor_capture', { worldId, outputDir: 'derived/sensor/probe_frame', width: 320, height: 240 })
      assert.equal(sensor.isError, false, sensor.text)
      const sensorTarget = join(sessionCwd, 'derived/sensor/probe_frame')
      assert.equal(sensor.value.outputDir, sensorTarget)
      assert.equal(new URL(sensor.value.rgb.uri).pathname.startsWith(sensorTarget + '/'), true)
      assert.equal(new URL(sensor.value.depth.uri).pathname.startsWith(sensorTarget + '/'), true)
      const sensorPng = decodePng(await readFile(new URL(sensor.value.rgb.uri).pathname))
      const sensorDepth = decodeNpy(await readFile(new URL(sensor.value.depth.uri).pathname))
      report.receipts.sensor_capture = { requestedOutputDir: 'derived/sensor/probe_frame', reportedOutputDir: sensor.value.outputDir, rgb: sensor.value.rgb.uri, depth: sensor.value.depth.uri, rgbSize: [sensorPng.width, sensorPng.height], depthShape: sensorDepth.shape, depthRangeM: sensor.value.depthRangeM }
      assert.equal(sensorPng.width, 320); assert.deepEqual(sensorDepth.shape, [240, 320])

      // ---- 5) Command 路径（同一条解析）也只用相对 outputDir
      const command = await harness.command(`/camera_capture_multi {"worldId":"${worldId}","cameraNames":["probe_rig/overview"],"outputDir":"derived/frames/from_command","width":160,"height":120}`)
      assert.equal(command.kind, 'success', command.text)
      const commandValue = JSON.parse(command.text)
      assert.equal(commandValue.outputDir, join(sessionCwd, 'derived/frames/from_command'))
      assert.equal(new URL(commandValue.cameras[0].rgb.uri).pathname.startsWith(join(sessionCwd, 'derived/frames/from_command') + '/'), true)
      report.commands.camera_capture_multi = { requestedOutputDir: 'derived/frames/from_command', reportedOutputDir: commandValue.outputDir, rgb: commandValue.cameras[0].rgb.uri }

      // ---- 6) camera_dataset_export 相对 outputDir：真 PNG/NPY 副本 + 逐帧标定
      const dataset = await harness.call('camera_dataset_export', { worldId, captureIds: [multi.value.captureId, commandValue.captureId], outputDir: 'derived/dataset/probe' })
      assert.equal(dataset.isError, false, dataset.text)
      const datasetTarget = join(sessionCwd, 'derived/dataset/probe')
      assert.equal(dataset.value.outputDir, datasetTarget)
      assert.equal(dataset.value.directory, datasetTarget)
      const datasetFiles = await listing(datasetTarget)
      const rgbCopies = await listing(join(datasetTarget, 'rgb'))
      const depthCopies = await listing(join(datasetTarget, 'depth'))
      assert.equal(dataset.value.status, 'completed', JSON.stringify(dataset.value.missing))
      assert.equal(rgbCopies.length, 3, '两帧多视角 + 一帧单相机 = 3 张 RGB 副本')
      assert.equal(depthCopies.length, 3)
      const samples = (await readFile(join(datasetTarget, 'samples.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      report.dataset = { files: datasetFiles, rgb: rgbCopies, depth: depthCopies, samples: samples.map((row) => ({ cameraName: row.cameraName, frameId: row.frameId, stepIndex: row.stepIndex, rgb: row.rgb, depth: row.depth, fx: row.calibration?.intrinsics?.fx })) }
      for (const row of samples) {
        assert.ok(existsSync(join(datasetTarget, row.rgb)), 'samples.jsonl 引用的 RGB 副本必须真实存在')
        assert.ok(existsSync(join(datasetTarget, row.depth)), 'samples.jsonl 引用的深度副本必须真实存在')
      }
      // 副本与源帧必须逐字节相同（不是重新渲染的另一帧）。
      const firstRow = samples.find((row) => row.captureId === multi.value.captureId)!
      const sourceCamera = multi.value.cameras.find((camera: any) => camera.cameraName === firstRow.cameraName)!
      assert.deepEqual(await readFile(join(datasetTarget, firstRow.rgb)), await readFile(new URL(sourceCamera.rgb.uri).pathname), '数据集 RGB 副本必须与源帧逐字节相同')
      assert.equal(dataset.value.annotationCount >= 2, true, '反投影标注必须被数据集带出')

      // ---- 7) 缺会话 cwd 的相对路径：明确失败且不落任何文件
      const bareFilesBefore = await listing(datasetTarget)
      const bare = await harness.call('camera_capture_multi', { worldId, cameraNames: ['probe_rig/overview'], outputDir: 'derived/frames/no-cwd', width: 160, height: 120 }, harness.bareAgent)
      assert.equal(bare.isError, true, '没有会话 cwd 的相对路径必须失败')
      assert.match(bare.text, /ROBOT_CWD_UNRESOLVED/)
      assert.equal(existsSync(join(hostCwd, 'derived/frames/no-cwd')), false, '失败路径不得在宿主 cwd 落任何文件')
      assert.deepEqual(await listing(datasetTarget), bareFilesBefore)
      report.bareAgent = { error: bare.text.split('\n')[0], hostCwdCreated: existsSync(join(hostCwd, 'derived/frames/no-cwd')) }

      // ---- 8) 关掉自己的 world
      const closed = await harness.call('sim_close', { worldId })
      assert.equal(closed.isError, false, closed.text)
      const remaining = await harness.call('sim_world_list', {})
      assert.equal(remaining.isError, false, remaining.text)
      assert.deepEqual(remaining.value.worlds ?? remaining.value, [])
      report.engine.close = { closed: closed.value, worldsAfterClose: remaining.value.worlds ?? remaining.value }

      // ---- 9) 磁盘判据：宿主机 cwd 的诱饵目录一个字节没多，主仓/工作树根未新增
      const hostDecoyDir = join(hostCwd, decoyRelative)
      report.files.hostCwdDecoyDir = await listing(hostDecoyDir)
      report.files.sessionTargetDir = await listing(target)
      assert.deepEqual(await listing(hostDecoyDir), ['decoy-host-cwd.txt'], '宿主进程 cwd 的诱饵目录必须原样')
      assert.equal((await readFile(join(hostDecoyDir, 'decoy-host-cwd.txt'), 'utf8')), '诱饵 decoy-host-cwd.txt\n')
      assert.equal((await readFile(join(target, 'decoy-session-workspace.txt'), 'utf8')), '诱饵 decoy-session-workspace.txt\n')
      assert.equal(existsSync(join(hostCwd, 'derived/dataset')), false, '数据集不得落到宿主 cwd')
      assert.equal(existsSync(join(hostCwd, 'derived/sensor')), false, '单相机采集不得落到宿主 cwd')
      assert.equal(existsSync(join(REPO_ROOT, 'derived')), false, '仓库根目录不得新增 derived/')
      report.files.repoRootDerivedExists = existsSync(join(REPO_ROOT, 'derived'))
      report.files.hostCwd = hostCwd
      report.files.sessionCwd = sessionCwd
      report.files.relativeOutputDir = decoyRelative

      // 没给 LYAPUNOV_EVIDENCE_DIR（普通跑法）就不留证据，判据本身不受影响。
      if (EVIDENCE_DIR) {
        await copyEvidence(root, join(EVIDENCE_DIR, 'part-c-frames'))
        await writeFile(join(EVIDENCE_DIR, 'part-c-raw.json'), JSON.stringify(report, null, 1) + '\n')
      }
    } finally {
      await harness?.close()
      chdir(originalCwd)
      if (!EVIDENCE_DIR) await rm(root, { recursive: true, force: true })
    }
  })
})
