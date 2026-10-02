/**
 * camera_fit 的真实行为测试：**从 ToolRegistry 调用** → 共用 operation → 隔离解释器里的 OpenCV → 结构化读数。
 *
 * 证据链不是合成数字：夹具由真实 Blender 渲染而来
 * （packages/blender/test/camera-fit-blender-fixture.py，自发光标记球 + 真实成像测量），
 * 本文件把夹具里**量出来的像素**喂给工具，再用夹具里**没参与拟合的 check 点**核对结果，
 * 最后一条用例还把拟合出来的相机装回真实 Blender 重渲染一遍做闭环（camera-fit-apply-check.py）。
 * 所有"位姿对不对"的判断都由本文件自己算（产品约定投影/四元数与矩阵互校/three.js 复投影），
 * 不拿工具自报的残差当结论。
 *
 * 为什么用 node:test：与 cad.test.ts 同一套理由（`@deepseek-ai/dsh-subprocess-local` 用了 Node 24 的
 * `util.getSystemErrorMessage`，Bun 下加载即失败），产品 Host 本来就跑在 Node 上。
 *
 * 运行：
 *   LYAPUNOV_CAMERA_FIT_PYTHON=<装了 opencv-python-headless + numpy 的隔离 venv 解释器> \
 *     node --test packages/blender/test/camera-fit.test.ts
 * 未设置/解释器不存在时，依赖解释器的用例整组 skip（不静默当成通过）；Blender 回灌用例另外要求 PATH 里有 blender。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as THREE from 'three'
import {
  CAMERA_FIT_SCRIPT_URL, CAMERA_FIT_SUMMARY_POINTS, CameraFitError, assertCameraFitResult, cameraFitArgv,
  cameraFitPosition, cameraFitTaskCwd, preflightCameraFitRequest, registerCameraFitTools, resolveCameraFitPath,
  type CameraFitPose,
  resolveCameraFitPython, summarizeCameraFit, type CameraCorrespondence, type CameraFitResult,
} from '../src/camera-fit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'python', 'camera_fit.py')
const APPLY_SCRIPT = join(HERE, 'camera-fit-apply-check.py')
const FIXTURES = join(HERE, 'fixtures', 'camera-fit')
const PYTHON = process.env.LYAPUNOV_CAMERA_FIT_PYTHON?.trim() ?? ''
const hasInterpreter = PYTHON !== '' && existsSync(PYTHON)
const BLENDER = process.env.LYAPUNOV_BLENDER?.trim() ?? 'blender'
const hasBlender = spawnSync(BLENDER, ['--version'], { encoding: 'utf8' }).status === 0
/** 缺依赖时整组显式 skip 并写明原因——不静默当成通过（与 cad.test.ts 同一套做法）。 */
const NEED_PYTHON = hasInterpreter ? false : '未设置 LYAPUNOV_CAMERA_FIT_PYTHON（指向装好 opencv-python-headless + numpy 的隔离 venv）'
const NEED_BLENDER = hasInterpreter && hasBlender ? false : '需要 LYAPUNOV_CAMERA_FIT_PYTHON 与可执行的 blender'

/** 一般机位（fit 点秩 3）与共面机位（fit 点只有那面墙，秩 2）。 */
const GENERAL_VIEWS = ['oblique', 'low-left', 'high-down'] as const
const PLANAR_VIEW = 'wall-front'
/** 竖幅 + 非居中主点 + fx≠fy + 机身带 roll：相机由目标 K 反解出的 Blender 参数搭出来（裁剪竖幅照片那种 K）。 */
const PORTRAIT_VIEW = 'portrait-crop'

interface FixtureIntrinsics {
  fx: number; fy: number; cx: number; cy: number; width: number; height: number; distortion: number[]
}
interface FixturePoint {
  id: string; group: string; world: number[]; role: 'fit' | 'check'
  pixelMeasured: number[]; pixelProjected: number[]; projectionDeltaPx: number
}
/** 夹具机位由相机参数直接搭出来（portrait-crop 是"目标 K → 求解器反解的参数 → 真装"）。 */
interface FixtureBlenderParameters {
  sensorFit: string; lensMm: number; sensorWidthMm: number; sensorHeightMm: number
  shiftX: number; shiftY: number; pixelAspect: { x: number; y: number }
  resolutionPx: { width: number; height: number }
}
interface Fixture {
  kind: string
  blender: { version: string; engine: string; samples: number; renderSeconds: number }
  view: { name: string; resolution: { width: number; height: number }; png: string; planarFitGroup: string | null
    rollDeg: number; blenderParameters: FixtureBlenderParameters
    targetIntrinsics: FixtureIntrinsics | null }
  groundTruth: {
    positionM: number[]; rotationMatrix: number[][]; quaternionXyzw: number[]
    lensMm: number; sensorWidthMm: number; fovXDeg: number; fovYDeg: number
    /** Blender 自己的 camera.angle_x/angle_y：AUTO 且横构图时 angle_y 是虚构角度，别当垂直视场用。 */
    blenderAngleXDeg: number; blenderAngleYDeg: number
    sensorFit: string; shiftX: number; shiftY: number
    pixelAspect: { x: number; y: number }
    blenderParameters: FixtureBlenderParameters
    /** 求解器按这组 Blender 参数反推的 K − 真实 Blender view_frame 的 K（像素）。 */
    modelDeltaPx: { fx: number; fy: number; cx: number; cy: number }
    intrinsics: FixtureIntrinsics
  }
  points: FixturePoint[]
  excluded: Array<{ id: string; group: string; reason: string }>
  selfCheck: { visibleMarkers: number; fitPoints: number; checkPoints: number
    maxProjectionDeltaPx: number; maxModelDeltaPx: number }
}

const fixtures = new Map<string, Fixture>()
function fixture(name: string): Fixture {
  const cached = fixtures.get(name)
  if (cached) return cached
  const loaded = JSON.parse(readFileSyncUtf8(join(FIXTURES, `${name}.json`))) as Fixture
  fixtures.set(name, loaded)
  return loaded
}
function readFileSyncUtf8(path: string): string {
  // 夹具是仓库里的静态产物：读不到就是环境问题，直接抛出比静默 skip 诚实。
  const read = spawnSync('cat', [path], { encoding: 'utf8' })
  if (read.status !== 0) throw new Error(`读不到夹具 ${path}：${read.stderr}`)
  return read.stdout
}

/** 一条对应点：像素用**渲染图里量出来的质心**（不是解析投影），role 沿用夹具。 */
function correspondences(view: Fixture, transform: (point: FixturePoint) => number[] = point => point.world) {
  return view.points.map(point => ({ id: point.id, world: transform(point), pixel: point.pixelMeasured, role: point.role }))
}

/** 用最小但真实的 Cordis 树（systemPrompt + tools + subprocess-local）装工具。 */
async function bootContext(config: Parameters<typeof registerCameraFitTools>[1] = {}) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
  ]
  const disposeTools = registerCameraFitTools(ctx, config)
  return {
    ctx,
    async close() {
      await disposeTools()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

let booted: Awaited<ReturnType<typeof bootContext>>
before(async () => { booted = await bootContext({ python: PYTHON, script: SCRIPT }) })
after(async () => { await booted.close() })

async function callTool(args: Record<string, unknown>, cwd?: string): Promise<ToolExecutionResult> {
  return await booted.ctx.tools.execute({
    callId: ToolCallId(`camera-fit-test:${String(args.worldUnit ?? 'm')}:${String((args.options as never as { ransac?: unknown } | undefined)?.ransac ?? 'auto')}:${Math.random().toString(36).slice(2, 8)}`),
    name: 'camera_fit',
    arguments: args,
    signal: new AbortController().signal,
    ...(cwd ? { agent: { session: { header: { cwd } } } as never } : {}),
  })
}

function valueOf(result: ToolExecutionResult): { result: string; report: CameraFitResult } {
  if (result.isError) throw new Error(`工具失败：${JSON.stringify(result.content ?? null).slice(0, 600)}`)
  return result.value as unknown as { result: string; report: CameraFitResult }
}

/** 成功读数 + "摘要与 report 是同一份事实"的核对（模型读文本、程序读结构化值，不能各说各话）。 */
function reportOf(result: ToolExecutionResult): CameraFitResult {
  const value = valueOf(result)
  const summary = JSON.parse(value.result) as Record<string, unknown>
  assert.deepEqual(summary.warnings, value.report.warnings, '摘要里的 warnings 必须与 report 一致')
  assert.deepEqual(summary.camera, value.report.camera, '摘要里的 camera 必须与 report 一致')
  assert.deepEqual(summary.precision, value.report.precision, '摘要里的 precision 必须与 report 一致')
  assert.deepEqual(summary.identifiability, value.report.identifiability, '摘要里的 identifiability 必须与 report 一致')
  return value.report
}

function errorTextOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error(`期望失败但成功了：${JSON.stringify(result.value ?? null).slice(0, 400)}`)
  return JSON.stringify(result.content ?? null)
}

// ---------------------------------------------------------------------------
// 独立复算：本文件自己的数学，不 import 被测代码的任何投影/四元数例程
// ---------------------------------------------------------------------------
type Matrix3 = number[][]

function matVec(matrix: Matrix3, vector: number[]): number[] {
  return matrix.map(row => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2])
}
function transpose(matrix: Matrix3): Matrix3 {
  return matrix[0].map((_, column) => matrix.map(row => row[column]))
}
/** 产品约定投影：world = R·p_cam + t，相机 x 右 y 上看 -z，像素原点左上 v 向下。 */
function projectProduct(rotation: Matrix3, position: number[], intrinsics: FixtureIntrinsics, world: number[]) {
  const relative = world.map((value, axis) => value - position[axis])
  const camera = matVec(transpose(rotation), relative)
  const depth = -camera[2]
  if (depth <= 0) return null
  return { u: intrinsics.cx + intrinsics.fx * camera[0] / depth, v: intrinsics.cy - intrinsics.fy * camera[1] / depth, depth }
}
function rotationAngleDeg(a: Matrix3, b: Matrix3): number {
  const relative = transpose(a).map((row, i) => row.map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)))
  const trace = relative[0][0] + relative[1][1] + relative[2][2]
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI
}
function quaternionToMatrix([x, y, z, w]: number[]): Matrix3 {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
function rms(values: number[]): number { return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) }
/** 递归收集读数里所有对象键名：用于核对"字段名本身"这类合同（不能只看某一处）。 */
function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, found); return found }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { found.push(key); collectKeys(item, found) }
  }
  return found
}
function maxOf(values: number[]): number { return values.reduce((worst, value) => Math.max(worst, value), 0) }

/** 用产品约定独立复算一组点在某个位姿下的重投影误差（默认对照夹具里量出来的像素）。 */
function reprojectionErrors(pose: CameraFitPose, intrinsics: FixtureIntrinsics,
                            view: Fixture, role: 'fit' | 'check',
                            observed: (point: FixturePoint) => number[] = point => point.pixelMeasured): number[] {
  // 位置统一经 cameraFitPosition 取：尺度未定时它不会把输入单位当米交出来。
  const position = cameraFitPosition(pose, true).values
  return view.points.filter(point => point.role === role).map(point => {
    const projected = projectProduct(pose.rotationMatrix, position, intrinsics, point.world)
    assert.ok(projected, `${point.id} 应该落在相机前方`)
    const [u, v] = observed(point)
    return Math.hypot(projected.u - u, projected.v - v)
  })
}

/** Viewer 适配的位置：尺度确定才是 positionM，未定是 positionInputUnits（名字必须跟着尺度走）。 */
function viewerPosition(viewer: CameraFitResult['camera']['viewer']): number[] {
  const values = viewerPositionField(viewer)
  assert.ok(values, 'viewer 必须给出位置（positionM 或 positionInputUnits）')
  assert.equal(viewer.units.metric, Array.isArray(viewer.positionM), 'viewer 位置字段名与 units.metric 必须一致')
  return values!
}
function viewerPositionField(viewer: CameraFitResult['camera']['viewer']): number[] | undefined {
  const metric = viewer.positionM
  const inputUnits = viewer.positionInputUnits
  assert.ok(!(Array.isArray(metric) && Array.isArray(inputUnits)), 'viewer 不能同时给 positionM 与 positionInputUnits')
  return Array.isArray(metric) ? metric : inputUnits
}

/**
 * three.js（原生 Viewer 用的就是它）复投影：只吃结果里的 viewer 字段，看能不能重建出同一批像素。
 * `applyViewOffset=false` 用来量"只用一条 fov（主点留在画面正中）会错多少像素"——
 * 这正是"一条 fov 复现不了非中心 K"的实测证据。
 */
function viewerProject(viewer: CameraFitResult['camera']['viewer'], resolution: { width: number; height: number },
                       world: number[], options: { applyViewOffset?: boolean; fovYDeg?: number } = {}): [number, number] {
  const camera = new THREE.PerspectiveCamera(options.fovYDeg ?? viewer.fov_y_deg, viewer.aspect, 0.05, 10000)
  camera.up.set(viewer.up[0], viewer.up[1], viewer.up[2])
  const position = viewerPosition(viewer)
  camera.position.set(position[0], position[1], position[2])
  camera.quaternion.set(viewer.quaternion[0], viewer.quaternion[1], viewer.quaternion[2], viewer.quaternion[3])
  if (options.applyViewOffset !== false) {
    const offset = viewer.squarePixelModel.viewOffsetPx
    camera.setViewOffset(resolution.width, resolution.height, offset.x, offset.y, resolution.width, resolution.height)
  }
  camera.updateMatrixWorld(true)
  const projected = new THREE.Vector3(world[0], world[1], world[2]).project(camera)
  // three.js 的 NDC 边界是**视口边缘**（-0.5 / W-0.5 像素），换算到像素索引口径才和合同 (width-1)/2 对齐。
  return [(projected.x + 1) / 2 * resolution.width - 0.5, (1 - projected.y) / 2 * resolution.height - 0.5]
}

// ---------------------------------------------------------------------------
// 不需要解释器的部分
// ---------------------------------------------------------------------------
describe('camera_fit 参数与解释器解析（不启进程）', () => {
  test('解释器解析：显式配置 > 环境变量 > 无（不静默猜默认解释器）', () => {
    assert.equal(resolveCameraFitPython({}, {}), undefined)
    assert.equal(resolveCameraFitPython({ python: '/opt/venv/bin/python' }, {}), '/opt/venv/bin/python')
    assert.equal(resolveCameraFitPython({}, { LYAPUNOV_CAMERA_FIT_PYTHON: '/env/venv/bin/python' } as never),
      '/env/venv/bin/python')
    assert.equal(resolveCameraFitPython({ python: '  ' }, { LYAPUNOV_CAMERA_FIT_PYTHON: '/env/py' } as never), '/env/py')
  })

  test('任务工作区：会话 cwd 优先，config.workspace 只作兜底；相对路径没有基准就报错', () => {
    assert.equal(cameraFitTaskCwd({ agent: { session: { header: { cwd: '/session/dir' } } } }, { workspace: '/w' }), '/session/dir')
    assert.equal(cameraFitTaskCwd(undefined, { workspace: '/w' }), '/w')
    assert.equal(cameraFitTaskCwd(undefined, {}), undefined)
    assert.throws(() => resolveCameraFitPath('python/camera_fit.py', 'script'), (error: unknown) =>
      error instanceof CameraFitError && error.code === 'CAMERA_FIT_CWD_UNRESOLVED')
    assert.equal(resolveCameraFitPath('python/camera_fit.py', 'script', '/base'), '/base/python/camera_fit.py')
  })

  test('子进程 argv 与脚本路径：请求走 stdin，不落临时文件', () => {
    assert.deepEqual(cameraFitArgv({ python: '/venv/bin/python', script: '/pkg/python/camera_fit.py' }),
      ['/venv/bin/python', '/pkg/python/camera_fit.py', '--input', '-'])
    assert.ok(CAMERA_FIT_SCRIPT_URL.pathname.endsWith('/packages/blender/python/camera_fit.py'),
      `脚本 URL 应指向包内 camera_fit.py，实际 ${CAMERA_FIT_SCRIPT_URL.pathname}`)
  })

  test('形状预检：坏世界点/坏像素/坏 role/缺内参/同时给 intrinsics 与 lens 都被拒', () => {
    const ok: CameraCorrespondence[] = [{ world: [0, 0, 0], pixel: [1, 2] }, { world: [1, 0, 0], pixel: [2, 2] }]
    const intrinsics = { fx: 1000, fy: 1000, width: 100, height: 80 }
    assert.throws(() => preflightCameraFitRequest({ correspondences: [], intrinsics } as never),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_INPUT_INVALID')
    assert.throws(() => preflightCameraFitRequest({ correspondences: [{ world: [0, 0], pixel: [1, 2] }], intrinsics } as never),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_INPUT_INVALID')
    assert.throws(() => preflightCameraFitRequest({
      correspondences: [{ world: [0, 0, 0], pixel: [1, 2], role: 'maybe' } as never], intrinsics } as never),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_INPUT_INVALID')
    assert.throws(() => preflightCameraFitRequest({ correspondences: ok } as never),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_INTRINSICS_REQUIRED')
    assert.throws(() => preflightCameraFitRequest({
      correspondences: ok, intrinsics, lens: { kind: 'sensor', focalLengthMm: 35, sensorWidthMm: 36, width: 100, height: 80 } } as never),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_INPUT_INVALID')
    preflightCameraFitRequest({ correspondences: ok, intrinsics })   // 正例不抛
  })

  test('读数契约校验：缺位姿/缺内参/缺重投影读数、以及"位置字段名与尺度不一致"的半份结果都判失败', () => {
    const pose = { positionM: [0, 0, 0], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], quaternionXyzw: [0, 0, 0, 1] }
    const blender = {
      sensorFit: 'HORIZONTAL', lensMm: 35, sensorWidthMm: 36, resolutionPx: { width: 100, height: 80 },
      shiftX: 0, shiftY: 0, pixelAspect: { x: 1, y: 1 }, locationM: [0, 0, 0], metric: true,
      rotationQuaternionXyzw: [0, 0, 0, 1],
      resolvesIntrinsics: { fx: 1000, fy: 1000, cx: 49.5, cy: 39.5 },
      intrinsicsReproductionErrorPx: { max: 0 },
    }
    const viewer = {
      positionM: [0, 0, 0], quaternion: [0, 0, 0, 1], up: [0, 1, 0], forward: [0, 0, -1], rollDeg: 0,
      units: { metric: true, name: 'positionM' }, intrinsics: { reproducibleByFovAlone: false },
    }
    const full = {
      ok: true,
      camera: { metric: true, worldFromCamera: pose, blender, viewer },
      intrinsics: { fx: 1000, calibrated: true },
      reprojection: { fit: { stats: { rmsPx: 0.1 }, perPoint: [] } }, warnings: [],
      precision: { independentCheck: false, spatialCheck: false },
    }
    assert.equal(assertCameraFitResult(full).intrinsics.fx, 1000)
    assert.throws(() => assertCameraFitResult({ ...full, camera: {} }),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID')
    assert.throws(() => assertCameraFitResult({ ...full, intrinsics: { fx: 1000 } }),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID')
    assert.throws(() => assertCameraFitResult({ ...full, reprojection: {} }),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID')
    // 尺度与字段名："位置是米"这件事只能由字段名承载，所以换成未定尺度时三个适配器都要一起换名。
    const unknownScale = {
      ...full,
      camera: {
        ...full.camera, metric: false,
        worldFromCamera: { ...pose, positionM: undefined, positionInputUnits: [0, 0, 0] },
        blender: { ...blender, locationM: undefined, locationInputUnits: [0, 0, 0], metric: false },
        viewer: { ...viewer, positionM: undefined, positionInputUnits: [0, 0, 0], units: { metric: false, name: 'positionInputUnits' } },
      },
    }
    assert.equal(assertCameraFitResult(unknownScale).camera.metric, false, '三个适配器一起换成 InputUnits 名字就该通过')
    for (const [patch, hint] of [
      [{ worldFromCamera: pose }, /worldFromCamera/],                                  // 只换了 metric，位姿还是 positionM
      [{ blender: { ...blender, locationInputUnits: [0, 0, 0] } }, /locationM/],       // Blender 位置还带 M
      [{ blender: { ...blender, locationM: undefined, locationInputUnits: [0, 0, 0] } }, /metric/],   // 名字换了但 blender.metric 还说米
      [{ viewer: { ...viewer, positionInputUnits: [0, 0, 0] } }, /positionM|viewer/],  // viewer 位置还带 M
    ] as const) {
      assert.throws(() => assertCameraFitResult({ ...unknownScale, camera: { ...unknownScale.camera, ...patch } }),
        (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID',
        `尺度未定却仍给 ${hint.source} 名字必须判失败`)
    }
    assert.throws(() => assertCameraFitResult({ ...full, camera: { ...full.camera, metric: false } }),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID',
      'camera.metric=false 而位置仍叫 positionM 必须判失败')
    // 复现内参必需的整套 Blender 参数、以及"一条 fov 复现不了内参"的声明，都属于合同。
    for (const [patch, hint] of [
      [{ blender: { ...blender, sensorFit: 'AUTO' } }, /sensorFit/],
      [{ blender: { ...blender, shiftX: undefined } }, /shiftX/],
      [{ blender: { ...blender, pixelAspect: undefined } }, /pixelAspect/],
      [{ blender: { ...blender, resolutionPx: undefined } }, /resolutionPx/],
      [{ blender: { ...blender, resolvesIntrinsics: undefined } }, /resolvesIntrinsics/],
      [{ blender: { ...blender, intrinsicsReproductionErrorPx: undefined } }, /intrinsicsReproductionErrorPx/],
    ] as const) {
      assert.throws(() => assertCameraFitResult({ ...full, camera: { ...full.camera, ...patch } }),
        (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID',
        `缺 ${hint.source} 时必须判失败`)
    }
    for (const [patch, hint] of [
      [{ intrinsics: { reproducibleByFovAlone: true } }, /fov/],
      [{ up: undefined }, /up/],
      [{ forward: undefined }, /forward/],
      [{ rollDeg: undefined }, /rollDeg/],
      [{ units: undefined }, /units/],
    ] as const) {
      assert.throws(() => assertCameraFitResult({ ...full, camera: { ...full.camera, viewer: { ...viewer, ...patch } } }),
        (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID',
        `viewer 缺 ${hint.source} 时必须判失败`)
    }
  })

  test('cameraFitPosition：尺度与字段名错配直接抛，不做"猜一个"', () => {
    assert.deepEqual(cameraFitPosition({ positionM: [1, 2, 3], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], quaternionXyzw: [0, 0, 0, 1] }, true).values, [1, 2, 3])
    assert.deepEqual(cameraFitPosition({ positionInputUnits: [1, 2, 3], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], quaternionXyzw: [0, 0, 0, 1] }, false).values, [1, 2, 3])
    const both = { positionM: [1, 2, 3], positionInputUnits: [1, 2, 3], rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Matrix3, quaternionXyzw: [0, 0, 0, 1] }
    assert.throws(() => cameraFitPosition(both, true),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID')
    assert.throws(() => cameraFitPosition({ ...both, positionM: undefined }, true),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID')
  })

  test('坏 options 必须是失败并指出字段（schema 挡的与求解器挡的都不许静默取默认）', { skip: NEED_PYTHON }, async () => {
    const view = fixture('oblique')
    const base = { correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics }
    for (const [options, hint] of [
      [{ ransac: 'maybe' }, /ransac/], [{ seed: 1.5 }, /seed/], [{ refine: true }, /refine/],
      [{ nonsense: 1 }, /nonsense|additional/], [{ reprojectionThresholdPx: -1 }, /reprojectionThresholdPx/],
    ] as const) {
      const text = errorTextOf(await callTool({ ...base, options }))
      assert.match(text, hint, `options=${JSON.stringify(options)} 必须失败且指出是哪个字段（实际 ${text.slice(0, 300)}）`)
    }
  })

  test('合法 options 逐项到位：求解器读数里回显的就是传下去的值（字符串布尔不被吞掉）', { skip: NEED_PYTHON }, async () => {
    const view = fixture('oblique')
    const report = reportOf(await callTool({
      correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics,
      options: { ransac: 'true', refine: 'false', seed: 7, iterations: 250, confidence: 0.95, reprojectionThresholdPx: 4 },
    }))
    assert.deepEqual(report.solver.options,
      { ransac: true, seed: 7, iterations: 250, confidence: 0.95, reprojectionThresholdPx: 4, refine: false, planarGapTolerancePx: 1 })
    assert.equal(report.solver.refined, false, 'refine=false 必须真的关掉 LM 精化')
    assert.ok(report.solver.ransac?.ok === true)
  })
})

// ---------------------------------------------------------------------------
// 已知 K：真实 Blender 夹具
// ---------------------------------------------------------------------------
describe('camera_fit 已知 K 位姿拟合（真实 Blender 渲染夹具）', { skip: NEED_PYTHON }, () => {
  test('夹具自检差在测量噪声量级（这是后面所有"像素级"判定的前提）', () => {
    for (const name of [...GENERAL_VIEWS, PLANAR_VIEW]) {
      const view = fixture(name)
      assert.equal(view.kind, 'camera-fit-blender-fixture')
      assert.ok(view.points.length >= 10, `${name} 可见点应有两位数，实际 ${view.points.length}`)
      assert.ok(view.selfCheck.maxProjectionDeltaPx <= 0.3,
        `${name} 的解析投影与渲染量测差 ${view.selfCheck.maxProjectionDeltaPx} px 超过 0.3：测量本身不干净`)
      for (const point of view.points) {
        assert.ok(point.role === 'fit' || point.role === 'check', `${point.id} 的 role 只能是 fit/check`)
      }
      assert.ok(view.points.some(point => point.role === 'check'), `${name} 必须有独立 check 点`)
    }
  })

  for (const name of GENERAL_VIEWS) {
    test(`${name}：位姿贴真值、独立 check 点自算重投影一致、适配字段口径正确`, async () => {
      const view = fixture(name)
      const truth = view.groundTruth
      const report = reportOf(await callTool({ correspondences: correspondences(view), intrinsics: truth.intrinsics }))
      const resolution = view.view.resolution

      // —— 读数本身：内参来自已知 K、有独立检查点、没宣称实测精度
      assert.equal(report.input.counts.fit, view.points.filter(point => point.role === 'fit').length)
      assert.equal(report.input.counts.check, view.points.filter(point => point.role === 'check').length)
      assert.equal(report.input.counts.checkHeldOut, true)
      assert.equal(report.input.counts.checkRepeatedWorldPoints, 0, '夹具里没有重复世界点')
      assert.equal(report.precision.independentCheck, true)
      assert.equal(report.precision.spatialCheck, true, '夹具的 check 点世界点都没参与拟合，应算空间外推验证')
      assert.equal(report.camera.metric, true, 'worldUnit=m：位置是米制')
      assert.equal(report.intrinsics.calibrated, true, '已知 K 必须标成标定过的内参')
      assert.equal(report.precision.measuredAccuracy, false, '重投影残差不是实测精度，不许这样宣称')
      assert.deepEqual(report.identifiability.fit3dRank, 3, `${name} 的 fit 点应是一般位置（秩 3）`)
      assert.equal(report.identifiability.planar, false)
      assert.equal(report.planarAmbiguity, null)
      assert.deepEqual(report.warnings, [], `一般机位不该有警告，实际 ${JSON.stringify(report.warnings)}`)

      // —— 位姿：与夹具真值比（夹具真值来自 Blender 相机矩阵，不是拟合产物）
      const fitted = report.camera.worldFromCamera
      const fittedPosition = cameraFitPosition(fitted, report.camera.metric)
      assert.equal(fittedPosition.metric, true, 'worldUnit=m 时位置必须是 positionM 这一族')
      const positionError = Math.hypot(...fittedPosition.values.map((value, axis) => value - truth.positionM[axis]))
      assert.ok(positionError < 0.02, `${name} 位置误差 ${positionError} m 应 < 2 cm`)
      const angleError = rotationAngleDeg(fitted.rotationMatrix as Matrix3, truth.rotationMatrix as Matrix3)
      assert.ok(angleError < 0.05, `${name} 旋转误差 ${angleError}° 应 < 0.05°`)
      const quaternionMatrix = quaternionToMatrix(fitted.quaternionXyzw)
      const quaternionGap = maxOf(quaternionMatrix.flatMap((row, i) => row.map((value, j) => Math.abs(value - (fitted.rotationMatrix as Matrix3)[i][j]))))
      assert.ok(quaternionGap < 1e-6, `四元数与旋转矩阵必须描述同一个旋转（最大差 ${quaternionGap}）`)

      // —— 独立复算：本文件自己按产品约定投影 check 点，跟渲染量到的像素比
      const fitErrors = reprojectionErrors(fitted, report.intrinsics, view, 'fit')
      const checkErrors = reprojectionErrors(fitted, report.intrinsics, view, 'check')
      assert.ok(rms(fitErrors) <= 0.3, `${name} fit 重投影 rms ${rms(fitErrors)} px 过大（测量噪声约 0.1 px）`)
      assert.ok(rms(checkErrors) <= 0.5, `${name} check 重投影 rms ${rms(checkErrors)} px 过大`)
      // 与工具自报的统计对齐（同一批像素，两条实现不能各说各话）
      assert.ok(Math.abs(report.reprojection.fit.stats.rmsPx! - rms(fitErrors)) < 1e-6)
      assert.ok(Math.abs(report.reprojection.check!.stats.rmsPx! - rms(checkErrors)) < 1e-6)

      // —— 相机是否真的在点前方（漏掉 OpenCV↔产品相机系换算时，这一条会立刻炸）
      assert.equal(report.reprojection.fit.stats.behindCamera, 0)
      assert.equal(report.reprojection.check!.stats.behindCamera, 0)

      // —— Blender 适配：整套参数一起自洽（不是"给个 lens 就说完事"）
      const blender = report.camera.blender
      assert.equal(blender.rotationMode, 'QUATERNION')
      // 夹具的 K 是 Blender 用 float32 量出来的（相对误差 ~6e-8），所以反推镜头只能核到 1e-4 mm
    // （≈0.003 px）——比这更紧就是在核 float32，不是在核适配。
    assert.ok(Math.abs(blender.lensMm - truth.lensMm) < 1e-4, `反推镜头 ${blender.lensMm} mm 应等于真值 ${truth.lensMm}`)
      assert.ok(Math.abs(blender.sensorWidthMm * report.intrinsics.fx / resolution.width - blender.lensMm) < 1e-9,
        'lens = sensorWidth·fx/width 必须自洽')
      assert.equal(blender.sensorFit, 'HORIZONTAL', 'sensorFit 必须显式给（AUTO 在竖幅会换传感器轴）')
      assert.deepEqual(blender.resolutionPx, { width: resolution.width, height: resolution.height })
      assert.ok(Math.abs(blender.shiftX - truth.shiftX) < 1e-9 && Math.abs(blender.shiftY - truth.shiftY) < 1e-9,
        `居中主点且方形像素时 shift 应为 0（真值 ${truth.shiftX}/${truth.shiftY}）`)
      assert.ok(Math.abs(blender.pixelAspect.x - truth.pixelAspect.x) < 1e-9
        && Math.abs(blender.pixelAspect.y - truth.pixelAspect.y) < 1e-9)
      assert.equal(blender.pixelAspectClamped, false)
      // 自报的"这组参数复现出的 K"必须就是请求的 K；复现误差要真的报出来，而不是嘴上说支持。
      for (const key of ['fx', 'fy', 'cx', 'cy'] as const) {
        assert.ok(Math.abs(blender.resolvesIntrinsics[key] - report.intrinsics[key]) < 1e-6,
          `${key}：resolvesIntrinsics=${blender.resolvesIntrinsics[key]} 应等于请求的 ${report.intrinsics[key]}`)
      }
      assert.ok(blender.intrinsicsReproductionErrorPx.max < 1e-3,
        `复现误差 ${blender.intrinsicsReproductionErrorPx.max} px 应远小于半像素`)
      // 相机是横构图 + sensor_fit=AUTO：Blender 的 camera.angle 走水平视场，读数里的 angleDeg 必须跟它对上。
      // （别拿 camera.angle_y 当垂直视场：AUTO 下它是"把 24mm 传感器高竖过来"的虚构角度，跟画幅无关。）
      assert.ok(Math.abs(blender.fovXDeg - report.intrinsics.fovxDeg) < 1e-9)
      assert.ok(Math.abs(blender.fovYDeg - report.intrinsics.fovyDeg) < 1e-9)
      assert.ok(Math.abs(blender.angleDeg - truth.fovXDeg) < 1e-6, `angleDeg ${blender.angleDeg} 应是水平视场 ${truth.fovXDeg}`)
      assert.ok(Math.abs(blender.angleDeg - truth.blenderAngleYDeg) > 3.0,
        '夹具特意记了 Blender 的 angle_y：它与画幅垂直视场差好几度，拿它反推焦距就会解出另一台相机')

      // —— Viewer 适配：用真的 three.js 相机复投影（原生 Viewer 就是这套约定）
      const viewer = report.camera.viewer
      assert.ok(Math.abs(viewer.aspect - resolution.width / resolution.height) < 1e-8)
      assert.deepEqual(viewer.sceneUp, [0, 0, 1], '场景 up 是世界 up；相机 up 是另一回事')
      // up/forward 必须由 R 得出（R 的列 = 相机三轴在世界系里的方向），不是恒等 [0,0,1]
      const rotation = fitted.rotationMatrix as Matrix3
      for (const [label, expected, column, sign] of [['up', viewer.up, 1, 1], ['forward', viewer.forward, 2, -1]] as const) {
        const fromRotation = rotation.map(row => sign * row[column])
        const gap = maxOf(expected.map((value, axis) => Math.abs(value - fromRotation[axis])))
        assert.ok(gap < 1e-9, `viewer.${label} 必须是 R 的第 ${column + 1} 列（带符号 ${sign}）：最大差 ${gap}`)
      }
      assert.ok(Math.abs(viewer.up.reduce((sum, value, axis) => sum + value * viewer.forward[axis], 0)) < 1e-9,
        '相机 up 与 forward 必须正交')
      assert.ok(Math.abs(viewer.rollDeg! - fixture(name).view.rollDeg) < 0.2,
        `rollDeg ${viewer.rollDeg}° 应等于夹具机位的 roll ${fixture(name).view.rollDeg}°`)
      assert.ok(viewer.target && viewer.focusDistance! > 0, 'OrbitControls 的 target 必须给出来')
      const targetGap = Math.abs(Math.hypot(...viewer.target!.map((value, axis) => value - fittedPosition.values[axis]))
        - viewer.focusDistance!)
      assert.ok(targetGap < 1e-6, `target 到相机的距离应等于 focusDistance（差 ${targetGap}）`)
      const targetAlongForward = viewer.target!.map((value, axis) => (value - fittedPosition.values[axis]) / viewer.focusDistance!)
      const targetDirectionGap = maxOf(targetAlongForward.map((value, axis) => Math.abs(value - viewer.forward[axis])))
      assert.ok(targetDirectionGap < 1e-9, `target 必须在 forward 方向上（最大差 ${targetDirectionGap}）`)
      assert.equal(viewer.units.metric, true)
      assert.equal(viewer.intrinsics.reproducibleByFovAlone, false, '不许声称一条 fov 就能复现内参')
      assert.equal(viewer.intrinsics.principalPointCentred, true, '这两个机位主点确实居中')
      assert.equal(viewer.squarePixelModel.exact, true, '方形像素 + 居中主点在 three.js 模型里能精确表达')
      assert.deepEqual(viewer.squarePixelModel.viewOffsetPx.x, 0, '居中主点不需要 viewOffset')
      const viewerErrors = view.points.map(point => {
        const [u, v] = viewerProject(viewer, resolution, point.world)
        return Math.hypot(u - point.pixelMeasured[0], v - point.pixelMeasured[1])
      })
      assert.ok(rms(viewerErrors) <= 0.5, `three.js 复投影 rms ${rms(viewerErrors)} px 过大`)
      assert.ok(maxOf(viewerErrors) <= 1.0, `three.js 复投影最大 ${maxOf(viewerErrors)} px 过大`)
    })
  }

  test('竖幅+非居中主点+fx≠fy：camera.blender 的整套参数真的复现这个 K（只装 lens/sensor 会错几十像素）', async () => {
    const view = fixture(PORTRAIT_VIEW)
    const truth = view.groundTruth
    const resolution = view.view.resolution
    const report = reportOf(await callTool({ correspondences: correspondences(view), intrinsics: truth.intrinsics }))
    const fitted = report.camera.worldFromCamera
    const fittedPosition = cameraFitPosition(fitted, report.camera.metric).values

    // 这个机位本身就是用目标 K 反解出的 Blender 参数搭出来的：先确认夹具那一步是准的
    assert.equal(view.view.targetIntrinsics!.fx !== view.view.targetIntrinsics!.fy, true, 'fx≠fy')
    assert.ok(Math.abs(resolution.width / resolution.height - 0.5625) < 1e-12, '竖幅 540×960')
    assert.ok(truth.intrinsics.cx - (resolution.width - 1) / 2 > 20, '主点明显不在画面正中')
    assert.ok(truth.intrinsics.cy - (resolution.height - 1) / 2 < -50, '主点明显不在画面正中')
    assert.ok(view.selfCheck.maxModelDeltaPx < 5e-3,
      `"求解器按参数反推的 K" 与真实 Blender view_frame 的差 ${view.selfCheck.maxModelDeltaPx} px 应可忽略`)

    // 拟合本身：位姿贴真值、留出的 check 点（不参与拟合、世界点没出现过）也对得上
    const positionError = Math.hypot(...cameraFitPosition(fitted, report.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(positionError < 0.02, `位置误差 ${positionError} m 应 < 2 cm`)
    assert.ok(rotationAngleDeg(fitted.rotationMatrix as Matrix3, truth.rotationMatrix as Matrix3) < 0.1)
    assert.equal(report.reprojection.fit.stats.behindCamera, 0)
    assert.equal(report.reprojection.check!.stats.behindCamera, 0)
    assert.ok(rms(reprojectionErrors(fitted, report.intrinsics, view, 'check')) <= 0.5,
      'check 点重投影应落在测量噪声量级')
    assert.deepEqual(report.warnings, [], `这个机位不该有警告，实际 ${JSON.stringify(report.warnings)}`)
    assert.equal(report.precision.spatialCheck, true)

    // Blender 参数：sensorFit 显式、非方形像素用 pixel_aspect 真表达、主点用 shift 真表达
    const blender = report.camera.blender
    assert.equal(blender.sensorFit, 'HORIZONTAL')
    // shift 的读数误差同样被 float32 的 K 卡住：1e-6（fit 轴全长=1 的单位）≈ 1e-3 px。
    assert.ok(Math.abs(blender.shiftX - truth.shiftX) < 1e-6, `shiftX ${blender.shiftX} 应等于 Blender 真值 ${truth.shiftX}`)
    assert.ok(Math.abs(blender.shiftY - truth.shiftY) < 1e-6, `shiftY ${blender.shiftY} 应等于 Blender 真值 ${truth.shiftY}`)
    assert.ok(Math.abs(blender.pixelAspect.x / blender.pixelAspect.y - report.intrinsics.fy / report.intrinsics.fx) < 1e-9,
      'pixel_aspect 比必须等于 fy/fx（非方形像素真的进了参数）')
    assert.equal(blender.squarePixels, false)
    for (const key of ['fx', 'fy', 'cx', 'cy'] as const) {
      assert.ok(Math.abs(blender.resolvesIntrinsics[key] - report.intrinsics[key]) < 1e-6,
        `${key}：resolvesIntrinsics=${blender.resolvesIntrinsics[key]} 应等于请求的 ${report.intrinsics[key]}`)
    }
    assert.ok(blender.intrinsicsReproductionErrorPx.max < 1e-3, '复现误差应远小于半像素')

    // 反面对照：#1 那种"只给 lens/sensor（方形像素 + 主点居中）"会错多少像素 —— 本文件自己算
    const naive = { ...report.intrinsics, fy: report.intrinsics.fx,
      cx: (resolution.width - 1) / 2, cy: (resolution.height - 1) / 2 }
    const naiveErrors = view.points.map(point => {
      const projected = projectProduct(fitted.rotationMatrix as Matrix3, fittedPosition, naive, point.world)!
      return Math.hypot(projected.u - point.pixelMeasured[0], projected.v - point.pixelMeasured[1])
    })
    assert.ok(maxOf(naiveErrors) > 20,
      `只装 lens/sensor 应明显错位，实际最大 ${maxOf(naiveErrors)} px（这正是原实现"完全复现内参"的说法错的地方）`)

    // Viewer：真实相机 up（含 roll）+ K 一起给；只给一条 fov 复现不了
    const viewer = report.camera.viewer
    assert.ok(Math.abs(viewer.rollDeg! + view.view.rollDeg) < 0.2,
      `rollDeg ${viewer.rollDeg}° 应等于夹具机位的 roll（夹具绕局部 +Z 转，读数绕 forward 量，故反号）`)
    const rotation = fitted.rotationMatrix as Matrix3
    for (const [label, expected, column, sign] of [['up', viewer.up, 1, 1], ['forward', viewer.forward, 2, -1]] as const) {
      const fromRotation = rotation.map(row => sign * row[column])
      assert.ok(maxOf(expected.map((value, axis) => Math.abs(value - fromRotation[axis]))) < 1e-9,
        `viewer.${label} 必须由 R 得出`)
    }
    assert.equal(viewer.intrinsics.principalPointCentred, false)
    assert.equal(viewer.squarePixelModel.exact, false, 'fx≠fy 在 three.js 的方形像素模型里表达不了，必须如实标出来')
    assert.ok(Math.abs(viewer.squarePixelModel.viewOffsetPx.x + viewer.intrinsics.principalPointOffsetPx.x) < 1e-9,
      'viewOffset 必须是主点偏移的反号（three.js 的 offsetX 与 cx 反向）')
    const withOffset = view.points.map(point => {
      const [u, v] = viewerProject(viewer, resolution, point.world)
      return Math.hypot(u - point.pixelMeasured[0], v - point.pixelMeasured[1])
    })
    // 主点被 setViewOffset 精确补上之后，剩下的就是"fx≠fy 在这套模型里表达不了"的残余：
    // three.js 的 PerspectiveCamera 恒有 fx=fy，这里守 fy（fov_y_deg 就是按 fy 给的），横向尺度差 fx/fy−1，
    // 残余随离主点的距离增长——**不该是 0**，读数自报的 options[0] 就是它的上界。
    assert.ok(maxOf(withOffset) > 1,
      `fx≠fy 在 three.js 的方形像素模型里表达不了，残余不该接近 0（实际最大 ${maxOf(withOffset)} px，这条用例没在测 fx≠fy）`)
    assert.ok(maxOf(withOffset) <= viewer.squarePixelModel.options[0].maxPixelErrorPx + 0.5,
      `残余 ${maxOf(withOffset)} px 不应超过自报上界 ${viewer.squarePixelModel.options[0].maxPixelErrorPx} px`)
    // 另一种守法（守 fx）：竖向尺度差 fy/fx−1，这里是更大的一次——两种上界都得是真的。
    const keepingFx = view.points.map(point => {
      const [u, v] = viewerProject(viewer, resolution, point.world, { fovYDeg: viewer.squarePixelModel.options[1].fovYDeg })
      return Math.hypot(u - point.pixelMeasured[0], v - point.pixelMeasured[1])
    })
    assert.ok(maxOf(keepingFx) <= viewer.squarePixelModel.options[1].maxPixelErrorPx + 0.5,
      `守 fx 的残余 ${maxOf(keepingFx)} px 不应超过自报上界 ${viewer.squarePixelModel.options[1].maxPixelErrorPx} px`)
    // 两种守法各自守一条轴、在另一条轴上按 |fy/fx−1| 或 |fx/fy−1| 线性放大，所以：
    // 哪条更大取决于点落在画面的哪一侧（这里守 fy 的横向残余就比守 fx 的竖向残余大），
    // 但两条上界必须是两个不同的数——照抄同一个数就说明其中一条没算。
    assert.notEqual(viewer.squarePixelModel.options[0].maxPixelErrorPx, viewer.squarePixelModel.options[1].maxPixelErrorPx)
    assert.match(viewer.squarePixelModel.options[0].pays, /横向|竖向/)
    assert.match(viewer.squarePixelModel.options[1].pays, /横向|竖向/)
    assert.notEqual(viewer.squarePixelModel.options[0].pays, viewer.squarePixelModel.options[1].pays)
    const withoutOffset = view.points.map(point => {
      const [u, v] = viewerProject(viewer, resolution, point.world, { applyViewOffset: false })
      return Math.hypot(u - point.pixelMeasured[0], v - point.pixelMeasured[1])
    })
    assert.ok(maxOf(withoutOffset) > maxOf(withOffset) + 10,
      `只用一条 fov（主点留正中）应把主点误差叠上来：${maxOf(withoutOffset)} px vs 补了 viewOffset 的 ${maxOf(withOffset)} px`)
    assert.ok(maxOf(withoutOffset) > 20,
      `只用一条 fov 应明显错位，实际最大 ${maxOf(withoutOffset)} px —— "一条 fov 复现内参"是错的`)
  })

  test('detail=full 返回完整读数：与 report 同一份事实，逐点明细不被截断', async () => {
    const view = fixture('oblique')
    const result = await callTool({ correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics, detail: 'full' })
    const value = valueOf(result)
    assert.deepEqual(JSON.parse(value.result), value.report, 'full 粒度就是读数原文')
    assert.equal(value.report.reprojection.fit.perPoint.length, value.report.input.counts.fit)
  })

  test('带畸变系数：系数真的进了求解；拿它当无畸变（全 0）位姿立刻跑偏', async () => {
    // 像素来自真实渲染量测；畸变是**本文件按标准 Brown–Conrady 模型自己加上的**
    // （真实镜头畸变夹具没做，别把这条读成"验证过真实镜头"）：
    //   x'=(u-cx)/fx, r²=x'²+y'², x''=x'(1+k1r²+k2r⁴+k3r⁶)+2p1x'y'+p2(r²+2x'²)
    const view = fixture('oblique')
    const truth = view.groundTruth
    const intrinsics = truth.intrinsics
    const [k1, k2, p1, p2, k3] = [0.15, -0.03, 0.001, -0.0007, 0.004]
    const distort = ([u, v]: number[]): number[] => {
      const x = (u - intrinsics.cx) / intrinsics.fx
      const y = (v - intrinsics.cy) / intrinsics.fy
      const r2 = x * x + y * y
      const radial = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
      return [intrinsics.cx + intrinsics.fx * (x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)),
        intrinsics.cy + intrinsics.fy * (y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y)]
    }
    const clean = view.points.map(point => point.pixelMeasured)
    const distorted = correspondences(view).map((entry, index) => ({ ...entry, pixel: distort(clean[index]) }))
    const shifts = distorted.map((entry, index) => Math.hypot(entry.pixel[0] - clean[index][0], entry.pixel[1] - clean[index][1]))
    assert.ok(maxOf(shifts) > 5, `畸变应该把像素挪开几像素（实际最大 ${maxOf(shifts)} px），否则这条用例什么也没测`)

    const report = reportOf(await callTool({ correspondences: distorted, intrinsics: { ...intrinsics, distortion: [k1, k2, p1, p2, k3] } }))
    assert.equal(report.intrinsics.distortionModel, 'opencv-k1k2p1p2k3')
    assert.deepEqual(report.intrinsics.distortion, [k1, k2, p1, p2, k3])
    const positionError = Math.hypot(...cameraFitPosition(report.camera.worldFromCamera, report.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(positionError < 0.02, `带畸变系数时位置误差 ${positionError} m 应 < 2 cm`)
    // 独立复算：本文件自己按产品约定投影、再套一次上面那套畸变，跟**畸变后**的观测像素比
    const observed = new Map(distorted.map((entry, index) => [view.points[index].id, entry.pixel]))
    const checkErrors = view.points.filter(point => point.role === 'check').map(point => {
      const pinhole = projectProduct(report.camera.worldFromCamera.rotationMatrix,
        cameraFitPosition(report.camera.worldFromCamera, report.camera.metric).values,
        report.intrinsics, point.world)!
      const [u, v] = distort([pinhole.u, pinhole.v])
      const [ou, ov] = observed.get(point.id)!
      return Math.hypot(u - ou, v - ov)
    })
    assert.ok(rms(checkErrors) < 0.5, `独立 check 点（本文件按同一畸变模型反投）rms ${rms(checkErrors)} px 过大`)

    // 对照组：同一批像素、系数当全 0 → 位姿必须明显跑偏（否则说明系数根本没被用上）
    const ignored = reportOf(await callTool({ correspondences: distorted, intrinsics }))
    const ignoredError = Math.hypot(...cameraFitPosition(ignored.camera.worldFromCamera, ignored.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(ignoredError > 0.1, `忽略畸变应把位姿拖偏（实际只差 ${ignoredError} m）`)
    assert.ok(ignored.reprojection.fit.stats.rmsPx! > 10 * report.reprojection.fit.stats.rmsPx!,
      '忽略畸变时拟合残差应明显变大')
  })

  test('有界摘要：计数是全量、逐点明细压到上限（模型默认只看到摘要）', async () => {
    const view = fixture('high-down')
    const report = reportOf(await callTool({ correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics }))
    const summary = summarizeCameraFit(report)
    const fit = summary.reprojection as { fit: { stats: { count: number }; worstPoints: unknown[]; perPointReported: number } }
    assert.equal(fit.fit.stats.count, report.reprojection.fit.stats.count)
    assert.equal(fit.fit.perPointReported, report.reprojection.fit.perPointReported)
    assert.equal(fit.fit.worstPoints.length, Math.min(CAMERA_FIT_SUMMARY_POINTS, report.reprojection.fit.perPoint.length))
  })
})

// ---------------------------------------------------------------------------
// 共面两解
// ---------------------------------------------------------------------------
describe('camera_fit 共面点集（一堵墙上的阵列）', { skip: NEED_PYTHON }, () => {
  test('给两解与误差间隔；歧义判定随容差走；墙外 check 点能分辨两解', async () => {
    const view = fixture(PLANAR_VIEW)
    assert.equal(view.view.planarFitGroup, 'wall')
    const truth = view.groundTruth
    const report = reportOf(await callTool({ correspondences: correspondences(view), intrinsics: truth.intrinsics }))

    assert.equal(report.identifiability.planar, true, '墙上阵列必须被判成共面')
    const ambiguity = report.planarAmbiguity
    assert.ok(ambiguity, '共面拟合必须给出两解与歧义判定')
    assert.equal(ambiguity.kind, 'planar-twofold')
    assert.equal(ambiguity.solutions?.length, 2)
    assert.ok(ambiguity.reprojectionGapPx !== null && ambiguity.reprojectionGapPx! > 0, '两解的误差间隔应能算出来')
    assert.ok(ambiguity.rotationDeltaDeg! > 1 && ambiguity.positionDeltaM! > 0.01, '两解必须是真的两个位姿')
    assert.equal(ambiguity.ambiguous, false, '这两解差了 2 px 以上，默认容差下不算歧义')
    assert.ok(report.warnings.some(warning => warning.startsWith('PLANAR_POINTS')), '必须明说共面、低残差不代表唯一')

    // 本文件自己复算：两解在**没参与拟合的墙外点**上差多少 → 独立证据能分辨它们
    const [first, second] = ambiguity.solutions!
    const firstCheck = rms(reprojectionErrors(first.worldFromCamera, report.intrinsics, view, 'check'))
    const secondCheck = rms(reprojectionErrors(second.worldFromCamera, report.intrinsics, view, 'check'))
    assert.ok(firstCheck < secondCheck / 5, `check 点应能分辨两解（${firstCheck} px vs ${secondCheck} px）`)
    assert.equal(first.reprojectionRmsPx! <= second.reprojectionRmsPx!, true, '解按误差排序')

    // 共面拟合的诚实结论：check 点上的误差明显大于一般机位，单独报出来
    const mainCheck = rms(reprojectionErrors(report.camera.worldFromCamera, report.intrinsics, view, 'check'))
    assert.ok(report.precision.fitResidualRmsPx! < 0.2 && mainCheck > 0.5,
      `共面拟合应是"拟合残差小、独立检查明显更大"（${report.precision.fitResidualRmsPx} vs ${mainCheck}）`)
    assert.ok(report.warnings.some(warning => warning.startsWith('CHECK_WORSE_THAN_FIT')))

    // 容差是调用方的旋钮：放宽到 5 px 后同一份读数必须改口说"歧义"
    const loose = reportOf(await callTool({
      correspondences: correspondences(view), intrinsics: truth.intrinsics, options: { planarGapTolerancePx: 5 },
    }))
    assert.equal(loose.planarAmbiguity!.ambiguous, true)
    assert.ok(loose.warnings.some(warning => warning.startsWith('PLANAR_AMBIGUOUS')), '判为歧义时必须给警告')
  })
})

// ---------------------------------------------------------------------------
// 错点与尺度
// ---------------------------------------------------------------------------
describe('camera_fit 错点与尺度', { skip: NEED_PYTHON }, () => {
  test('两个错像素：RANSAC 剔掉后位姿仍贴真值；关掉 RANSAC 位姿被拖走', async () => {
    const view = fixture('oblique')
    const truth = view.groundTruth
    let corrupted = 0
    const withWrong = view.points.map(point => {
      if (point.role === 'fit' && corrupted < 2) {
        corrupted += 1
        return { id: `${point.id}#错点`, world: point.world, pixel: [point.pixelMeasured[0] + 40, point.pixelMeasured[1] + 35], role: point.role }
      }
      return { id: point.id, world: point.world, pixel: point.pixelMeasured, role: point.role }
    })
    assert.equal(corrupted, 2)

    const guarded = reportOf(await callTool({ correspondences: withWrong, intrinsics: truth.intrinsics }))
    assert.equal(guarded.reprojection.fit.stats.outliers, 2, 'RANSAC（auto，fit 点 ≥6）应剔掉两个错点')
    assert.ok(guarded.warnings.some(warning => warning.startsWith('OUTLIERS_REJECTED')))
    assert.ok(guarded.solver.ransac?.ok === true)
    const guardedError = Math.hypot(...cameraFitPosition(guarded.camera.worldFromCamera, guarded.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(guardedError < 0.02, `剔掉错点后位置误差 ${guardedError} m 应 < 2 cm`)

    const unguarded = reportOf(await callTool({ correspondences: withWrong, intrinsics: truth.intrinsics, options: { ransac: 'false' } }))
    const unguardedError = Math.hypot(...cameraFitPosition(unguarded.camera.worldFromCamera, unguarded.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.equal(unguarded.solver.ransac, null)
    assert.equal(unguarded.solver.options.ransac, false, '工具层的 "false" 必须落到求解器的 false')
    assert.equal(unguarded.reprojection.fit.stats.outliers, 0)
    assert.ok(unguardedError > 0.05, `关掉 RANSAC 后错点应把位姿拖走（实际只差 ${unguardedError} m）`)
    assert.ok(unguarded.reprojection.fit.stats.rmsPx! > 5, '两个 50 px 级错点应把拟合残差顶起来')
  })

  test('厘米输入：位置仍解回米制真值，metresPerInputUnit=0.01', async () => {
    const view = fixture('low-left')
    const truth = view.groundTruth
    const report = reportOf(await callTool({
      correspondences: correspondences(view, point => point.world.map(value => value * 100)),
      worldUnit: 'cm', intrinsics: truth.intrinsics,
    }))
    assert.equal(report.input.worldUnit, 'cm')
    assert.equal(report.scale.metresPerInputUnit, 0.01)
    const error = Math.hypot(...cameraFitPosition(report.camera.worldFromCamera, report.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(error < 0.02, `厘米输入下的位置误差 ${error} m 应 < 2 cm`)
    assert.equal(report.camera.positionUnits, 'm')
  })

  test('尺度未知：位姿朝向可用，但不得声称米制位置；warnings 明说 SCALE_UNKNOWN', async () => {
    const view = fixture('oblique')
    const truth = view.groundTruth
    const report = reportOf(await callTool({
      correspondences: correspondences(view), worldUnit: 'unknown', intrinsics: truth.intrinsics,
    }))
    assert.equal(report.scale.determined, false)
    assert.equal(report.input.metresPerInputUnit, null)
    assert.ok(report.warnings.some(warning => warning.startsWith('SCALE_UNKNOWN')))
    assert.match(report.camera.positionUnits, /unknown-scale/, '尺度未定时位置单位必须明说不是米')
    // 归一化后角度不变：旋转仍应与真值一致（尺度只影响平移）
    const angleError = rotationAngleDeg(report.camera.worldFromCamera.rotationMatrix as Matrix3, truth.rotationMatrix as Matrix3)
    assert.ok(angleError < 0.05, `尺度未知时旋转误差 ${angleError}° 仍应 < 0.05°`)
    // warning 会被过滤、会被摘要吃掉，所以**字段名本身**必须承载"这不是米"：整份读数里不许出现 M 名字。
    assert.equal(report.camera.metric, false)
    const metreKeys = collectKeys(report).filter(key => /^(position|location|world|positionDelta)M$/.test(key))
    assert.deepEqual(metreKeys, [], `worldUnit=unknown 时读数里不允许出现任何米制位置字段，实际出现 ${metreKeys.join(', ')}`)
    assert.deepEqual(cameraFitPosition(report.camera.worldFromCamera, false).metric, false)
    assert.throws(() => cameraFitPosition(report.camera.worldFromCamera, true),
      (error: unknown) => error instanceof CameraFitError && error.code === 'CAMERA_FIT_OUTPUT_INVALID',
      '尺度未定的位置不能被当成米制读出来')
    assert.ok(Array.isArray(report.camera.blender.locationInputUnits), 'Blender 适配的位置也要用 InputUnits 名字')
    assert.equal((report.camera.blender as { locationM?: unknown }).locationM, undefined)
    assert.equal(report.camera.viewer.units.metric, false)
    assert.match(report.camera.viewer.units.note, /不是米/)
    assert.ok(Array.isArray(report.camera.viewer.positionInputUnits))
    const residualWorld = report.reprojection.fit.perPoint[0] as unknown as Record<string, unknown>
    assert.ok(Array.isArray(residualWorld.worldInputUnits) && residualWorld.worldM === undefined,
      '逐点残差里的世界点同样要换名字（别只换位姿那一处）')
  })
})

// ---------------------------------------------------------------------------
// 对应点卫生：重复对应点与"世界点复用的 check 点"到底算什么证据
// ---------------------------------------------------------------------------
describe('camera_fit 对应点重复与独立证据的边界', { skip: NEED_PYTHON }, () => {
  const view = () => fixture('oblique')
  const base = () => {
    const fixtureView = view()
    return { corresponding: correspondences(fixtureView), intrinsics: fixtureView.groundTruth.intrinsics }
  }

  test('完全相同的对应点跨 role 出现（同一世界点+同一像素）→ 拒绝，不当成独立检查点', async () => {
    const { corresponding, intrinsics } = base()
    const fitPoint = corresponding.find(item => item.role === 'fit')!
    const result = await callTool({
      intrinsics,
      correspondences: [...corresponding, { id: `${fitPoint.id}-copy`, world: fitPoint.world, pixel: fitPoint.pixel, role: 'check' }],
    })
    const text = errorTextOf(result)
    assert.match(text, /CAMERA_FIT_DUPLICATE_CORRESPONDENCE/)
    assert.match(text, /独立检查点|复读/, `拒绝理由要说清为什么不能既 fit 又 check，实际 ${text.slice(0, 400)}`)
  })

  test('同一 id 出现两次 → 拒绝（数据被贴了两遍不该静默合并）', async () => {
    const { corresponding, intrinsics } = base()
    const first = corresponding[0]
    const result = await callTool({ intrinsics, correspondences: [...corresponding, { ...first, role: 'check' }] })
    assert.match(errorTextOf(result), /CAMERA_FIT_DUPLICATE_CORRESPONDENCE/)
  })

  test('同 role 的完全重复项 → 拒绝（重复计数会让该点在拟合里权重翻倍）', async () => {
    const { corresponding, intrinsics } = base()
    const first = corresponding[0]
    const result = await callTool({ intrinsics, correspondences: [...corresponding, { id: `${first.id}-dup`, world: first.world, pixel: first.pixel, role: 'fit' }] })
    assert.match(errorTextOf(result), /CAMERA_FIT_DUPLICATE_CORRESPONDENCE/)
  })

  test('世界点复用但像素不同：允许，且必须标明它不做空间外推验证', async () => {
    const fixtureView = view()
    const { corresponding, intrinsics } = base()
    const fitPoint = fixtureView.points.find(point => point.role === 'fit')!
    // 同一个 3D 点的第二次观测（换个观测像素，0.3 px 的测量差）：像素/内参一致性核对，但空间上"见过"。
    const repeated = { id: `${fitPoint.id}-again`, world: fitPoint.world, pixel: [fitPoint.pixelMeasured[0] + 0.3, fitPoint.pixelMeasured[1]], role: 'check' as const }
    const report = reportOf(await callTool({ intrinsics, correspondences: [...corresponding, repeated] }))
    assert.equal(report.input.counts.checkRepeatedWorldPoints, 1)
    assert.deepEqual(report.input.counts.checkRepeatedWorldPointIds, [`${fitPoint.id}-again`])
    assert.equal(report.input.counts.checkHeldOut, true, '还有别的空间独立 check 点，不能整体判成没有独立证据')
    assert.equal(report.precision.spatialCheck, true)
    assert.match(report.input.counts.note, /空间外推/)
    const warning = report.warnings.find(item => item.startsWith('REPEATED_WORLD_POINT_CHECK'))
    assert.ok(warning, `必须明说复用世界点不做空间外推验证，实际 warnings=${JSON.stringify(report.warnings)}`)
    assert.match(warning!, /不提供空间外推验证|不做空间外推验证/)
  })

  test('check 点全部复用 fit 的世界点 → NO_SPATIAL_CHECK 且 spatialCheck=false（有 check 也不算独立证据）', async () => {
    const fixtureView = view()
    const fitPoints = fixtureView.points.filter(point => point.role === 'fit')
    const checkPoints = fixtureView.points.filter(point => point.role === 'check')
    assert.ok(checkPoints.length > 0)
    const correspondencesAll = [
      ...fitPoints.map(point => ({ id: point.id, world: point.world, pixel: point.pixelMeasured, role: 'fit' as const })),
      // 每个 check 点都复用某个 fit 世界点（像素换一点，模拟"同一 3D 点的另一次观测"）。
      ...checkPoints.map((point, index) => ({
        id: point.id, role: 'check' as const,
        world: fitPoints[index % fitPoints.length].world,
        pixel: [point.pixelMeasured[0], point.pixelMeasured[1] + 0.25],
      })),
    ]
    const report = reportOf(await callTool({ intrinsics: fixtureView.groundTruth.intrinsics, correspondences: correspondencesAll }))
    assert.equal(report.input.counts.checkRepeatedWorldPoints, checkPoints.length)
    assert.equal(report.input.counts.checkHeldOut, false)
    assert.equal(report.precision.independentCheck, true, 'check 点确实存在，只是不提供空间外推')
    assert.equal(report.precision.spatialCheck, false)
    assert.equal(report.precision.spatialCheckRmsPx, null)
    assert.ok(report.warnings.some(item => item.startsWith('NO_SPATIAL_CHECK')),
      `复用的 check 点不能被当成空间验证，实际 warnings=${JSON.stringify(report.warnings)}`)
    assert.match(report.input.counts.note, /不能验证位姿|只能核对/)
  })
})

// ---------------------------------------------------------------------------
// 退化与拒绝
// ---------------------------------------------------------------------------
describe('camera_fit 不可辨识时按拒绝处理', { skip: NEED_PYTHON }, () => {
  test('共线点集：直接拒绝（低残差也不能当结果）', async () => {
    const view = fixture('oblique')
    const line = view.points.filter(point => point.group === 'line')
    assert.ok(line.length >= 4, `共线用例需要 ≥4 个点，实际 ${line.length}`)
    const result = await callTool({ correspondences: line.map(point => ({ world: point.world, pixel: point.pixelMeasured })), intrinsics: view.groundTruth.intrinsics })
    assert.match(errorTextOf(result), /CAMERA_FIT_POINTS_COLLINEAR/)
  })

  test('fit 点太少：直接拒绝（点数不足不做 PnP）', async () => {
    const view = fixture('oblique')
    const three = view.points.filter(point => point.role === 'fit').slice(0, 3)
    const result = await callTool({ correspondences: three.map(point => ({ world: point.world, pixel: point.pixelMeasured })), intrinsics: view.groundTruth.intrinsics })
    assert.match(errorTextOf(result), /CAMERA_FIT_POINTS_INSUFFICIENT/)
  })

  test('没有检查点：明说没有独立证据（不把拟合残差当精度）', async () => {
    const view = fixture('oblique')
    const report = reportOf(await callTool({
      correspondences: view.points.filter(point => point.role === 'fit').map(point => ({ world: point.world, pixel: point.pixelMeasured })),
      intrinsics: view.groundTruth.intrinsics,
    }))
    assert.equal(report.precision.independentCheck, false)
    assert.equal(report.reprojection.check, null)
    assert.ok(report.warnings.some(warning => warning.startsWith('NO_INDEPENDENT_CHECK')))
    assert.equal(report.precision.measuredAccuracy, false)
  })
})

// ---------------------------------------------------------------------------
// 无 K：镜头与消失点
// ---------------------------------------------------------------------------
describe('camera_fit 无 K 路径（标明来源的估计，不算标定）', { skip: NEED_PYTHON }, () => {
  test('已知镜头规格：fx 与真值一致，标 calibrated=false 且列全假设', async () => {
    const view = fixture('oblique')
    const truth = view.groundTruth
    const report = reportOf(await callTool({
      correspondences: correspondences(view),
      lens: { kind: 'sensor', focalLengthMm: truth.lensMm, sensorWidthMm: truth.sensorWidthMm,
        width: truth.intrinsics.width, height: truth.intrinsics.height },
    }))
    assert.equal(report.intrinsics.calibrated, false)
    assert.equal(report.intrinsics.estimated, true)
    assert.equal(report.intrinsics.source, 'lens-sensor')
    // 求解器这条路径是精确的（lens/sensor×宽），被核的是夹具那个 float32 的 K。
    assert.ok(Math.abs(report.intrinsics.fx - truth.intrinsics.fx) < 1e-3, '焦距×传感器宽度换算应精确到远小于 1 px')
    assert.ok(report.intrinsics.assumptions.length >= 3, '镜头假设必须写清楚')
    assert.ok(report.warnings.some(warning => warning.startsWith('INTRINSICS_NOT_CALIBRATED')))
    const error = Math.hypot(...cameraFitPosition(report.camera.worldFromCamera, report.camera.metric).values.map((value, axis) => value - truth.positionM[axis]))
    assert.ok(error < 0.02, `镜头规格路径的位置误差 ${error} m 应 < 2 cm`)
  })

  test('FOV 路径：垂直视场与真值一致（同一台相机的另一种说法）', async () => {
    const view = fixture('low-left')
    const truth = view.groundTruth
    const report = reportOf(await callTool({
      correspondences: correspondences(view),
      lens: { kind: 'fov', fovDegVertical: truth.fovYDeg, width: truth.intrinsics.width, height: truth.intrinsics.height },
    }))
    assert.equal(report.intrinsics.source, 'lens-fov')
    // 传进去的是夹具里记的**画幅**垂直视场：换算是确定的，本文件自己按 fy = h / (2·tan(fovY/2)) 复算
    const expected = truth.intrinsics.height / (2 * Math.tan(truth.fovYDeg * Math.PI / 360))
    assert.ok(Math.abs(report.intrinsics.fy - expected) / expected < 1e-9, `fy ${report.intrinsics.fy} 应为 ${expected}`)
    assert.ok(Math.abs(report.intrinsics.fy - truth.intrinsics.fy) / truth.intrinsics.fy < 1e-9,
      '同一台相机的另一种说法：反推焦距应与真值一致')
    assert.equal(report.intrinsics.fx, report.intrinsics.fy, 'FOV 路径假设方形像素')
  })

  test('带理由的焦距假设：没有 rationale 直接拒；给了就照假设解，并标成假设', async () => {
    const view = fixture('high-down')
    const truth = view.groundTruth
    const base = { correspondences: correspondences(view) }
    const rejected = await callTool({ ...base, lens: { kind: 'assumed-focal-px', focalPx: truth.intrinsics.fx, width: 960, height: 540 } })
    assert.match(errorTextOf(rejected), /rationale/, '没有理由的固定焦距不是估计，必须拒')
    const report = reportOf(await callTool({
      ...base, lens: { kind: 'assumed-focal-px', focalPx: truth.intrinsics.fx, rationale: '测试假设：按已知镜头规格推得',
        width: truth.intrinsics.width, height: truth.intrinsics.height },
    }))
    assert.equal(report.intrinsics.source, 'lens-assumed-focal-px')
    assert.equal(report.intrinsics.estimated, true)
    assert.equal(report.intrinsics.calibrated, false)
    assert.ok(Math.abs(report.intrinsics.fx - truth.intrinsics.fx) / truth.intrinsics.fx < 1e-9,
      '假设的焦距原样用，不被"优化"成好看的值')
    assert.ok(report.intrinsics.assumptions.some(text => text.includes('假设')), '必须说明这是假设')
    assert.ok(report.warnings.some(warning => warning.startsWith('INTRINSICS_NOT_CALIBRATED')))
  })

  test('消失点：用夹具里量到的像素自己求三个正交方向的消失点 → 焦距粗估', async () => {
    const view = fixture('oblique')
    const truth = view.groundTruth
    const pixel = new Map(view.points.map(point => [point.id, point.pixelMeasured]))
    const lineOf = (ids: string[]) => {
      // 用两个以上点拟合图像直线（总体最小二乘）：ax+by+c=0
      const points = ids.map(id => pixel.get(id)!)
      assert.ok(points.every(point => point), `消失点用例缺标记：${ids.join(',')}`)
      const mean = [0, 1].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length)
      const centred = points.map(point => [point[0] - mean[0], point[1] - mean[1]])
      // 2×2 协方差的最小奇异向量用解析式取（两个正交方向里方差小的那个）
      const sxx = centred.reduce((sum, [x]) => sum + x * x, 0)
      const syy = centred.reduce((sum, [, y]) => sum + y * y, 0)
      const sxy = centred.reduce((sum, [x, y]) => sum + x * y, 0)
      // 主方向 = 直线方向；直线的法向是次方向（转 90°）
      const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy) + Math.PI / 2
      const normal = [Math.cos(angle), Math.sin(angle)]
      return [normal[0], normal[1], -(normal[0] * mean[0] + normal[1] * mean[1])]
    }
    const intersect = (first: number[], second: number[]) => {
      const cross = [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0]]
      return [cross[0] / cross[2], cross[1] / cross[2]]
    }
    const vanishingX = intersect(lineOf(['wall-00', 'wall-10', 'wall-20']), lineOf(['line-1', 'line-2', 'line-3', 'line-4']))
    const vanishingY = intersect(lineOf(['box-c1', 'box-c2']), lineOf(['box-c5', 'box-c6']))
    const vanishingZ = intersect(lineOf(['wall-00', 'wall-01', 'wall-02']), lineOf(['wall-10', 'wall-11', 'wall-12']))
    const report = reportOf(await callTool({
      correspondences: correspondences(view),
      lens: { kind: 'vanishing-points', width: truth.intrinsics.width, height: truth.intrinsics.height,
        directions: [{ world: [1, 0, 0], pixel: vanishingX }, { world: [0, 1, 0], pixel: vanishingY }, { world: [0, 0, 1], pixel: vanishingZ }] },
    }))
    assert.equal(report.intrinsics.source, 'lens-vanishing-points')
    assert.equal(report.intrinsics.calibrated, false)
    // 消失点法是粗估：这里只要求"量级对得上"（本夹具上实测偏差 ~0.3%），别当成标定值用
    const relative = Math.abs(report.intrinsics.fx - truth.intrinsics.fx) / truth.intrinsics.fx
    assert.ok(relative < 0.05, `消失点估计的焦距相对偏差 ${(relative * 100).toFixed(2)}% 应 < 5%`)
    assert.ok(report.intrinsics.assumptions.some(text => text.includes('消失点')), '必须说明这是消失点估计')
    assert.ok(report.warnings.some(warning => warning.startsWith('INTRINSICS_NOT_CALIBRATED')))
  })
})

// ---------------------------------------------------------------------------
// 隔离解释器与私有 HOME
// ---------------------------------------------------------------------------
describe('camera_fit 解释器隔离', { skip: NEED_PYTHON }, () => {
  test('私有 HOME 下不依赖 user site：venv 前缀里的解释器能独立跑完整拟合', async () => {
    const home = await mkdtemp(join(tmpdir(), 'camera-fit-home-'))
    const venv = dirname(dirname(PYTHON))
    const config = spawnSync('cat', [join(venv, 'pyvenv.cfg')], { encoding: 'utf8' })
    assert.equal(config.status, 0, `${PYTHON} 看起来不是 venv（没有 pyvenv.cfg）——本工具的部署纪律就是隔离 venv`)
    assert.match(config.stdout, /include-system-site-packages\s*=\s*false/,
      'venv 不能带系统 site-packages：开发机上"能跑"、私有 HOME 下缺依赖就是从这里来的')
    const probe = spawnSync(PYTHON, ['-c',
      'import json,sys,numpy,cv2;print(json.dumps({"prefix":sys.prefix,"numpy":numpy.__file__,"cv2":cv2.__file__,'
      + '"path":[p for p in sys.path if p]}))'], { encoding: 'utf8', env: { ...process.env, HOME: home, PYTHONNOUSERSITE: '1' } })
    assert.equal(probe.status, 0, `私有 HOME 下解释器起不来：${probe.stderr}`)
    const info = JSON.parse(probe.stdout) as { prefix: string; numpy: string; cv2: string; path: string[] }
    assert.equal(info.prefix, venv, '解释器前缀应是这个 venv')
    for (const [name, file] of [['numpy', info.numpy], ['cv2', info.cv2]] as const) {
      assert.ok(file.startsWith(info.prefix), `${name} 应从 venv 里加载，实际 ${file}`)
    }
    assert.ok(!info.path.some(entry => entry.includes('/.local/')), `sys.path 里不许有 user site：${info.path.join(':')}`)

    // 端到端：私有 HOME + PYTHONNOUSERSITE=1 下，用产品同一套 argv 跑一次完整拟合
    const view = fixture('oblique')
    const request = JSON.stringify({ correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics })
    const run = spawnSync(PYTHON, cameraFitArgv({ python: PYTHON, script: SCRIPT }).slice(1),
      { input: request, encoding: 'utf8', env: { ...process.env, HOME: home, PYTHONNOUSERSITE: '1', HF_ENDPOINT: 'https://hf-mirror.com' } })
    assert.equal(run.status, 0, `私有 HOME 下拟合失败：${run.stderr.slice(-400)}`)
    const line = run.stdout.split('\n').find(text => text.startsWith('LYAPUNOV_CAMERA_FIT_RESULT='))
    assert.ok(line, '应打印结果行')
    const report = JSON.parse(line!.slice('LYAPUNOV_CAMERA_FIT_RESULT='.length)) as CameraFitResult
    const error = Math.hypot(...cameraFitPosition(report.camera.worldFromCamera, report.camera.metric).values.map((value, axis) => value - view.groundTruth.positionM[axis]))
    assert.ok(error < 0.02, `私有 HOME 下的位置误差 ${error} m 应 < 2 cm`)
  })
})

// ---------------------------------------------------------------------------
// 回灌真实 Blender
// ---------------------------------------------------------------------------
describe('camera_fit 回灌真实 Blender 渲染核对', { skip: NEED_BLENDER }, () => {
  async function applyCheck(name: string) {
    const view = fixture(name)
    const dir = await mkdtemp(join(tmpdir(), `camera-fit-apply-${name}-`))
    const request = join(dir, 'request.json')
    await writeFile(request, JSON.stringify({ correspondences: correspondences(view), intrinsics: view.groundTruth.intrinsics }))
    const run = spawnSync(PYTHON, [SCRIPT, '--input', request], { encoding: 'utf8', env: { ...process.env, PYTHONNOUSERSITE: '1' } })
    assert.equal(run.status, 0, `求解器失败：${run.stderr.slice(-300)}`)
    const resultLine = run.stdout.split('\n').find(text => text.startsWith('LYAPUNOV_CAMERA_FIT_RESULT='))!
    const resultPath = join(dir, 'result.json')
    await writeFile(resultPath, resultLine.slice('LYAPUNOV_CAMERA_FIT_RESULT='.length))
    const blender = spawnSync(BLENDER, ['--background', '--factory-startup', '--python', APPLY_SCRIPT, '--',
      '--fixture', join(FIXTURES, `${name}.json`), '--result', resultPath, '--outdir', dir], { encoding: 'utf8' })
    assert.equal(blender.status, 0, `回灌渲染失败：${blender.stderr.slice(-400)}`)
    const applyLine = blender.stdout.split('\n').find(text => text.startsWith('CAMERA_FIT_APPLY='))
    assert.ok(applyLine, '回灌脚本应打印 JSON 摘要')
    const summary = JSON.parse(applyLine!.slice('CAMERA_FIT_APPLY='.length)) as {
      points: number; fitPoints: number; checkPoints: number
      maxApplyDeltaPx: number; meanApplyDeltaPx: number; maxFixtureDeltaPx: number
      maxIntrinsicsErrorPx: number; maxResolvesIntrinsicsErrorPx: number
    }
    const detailed = JSON.parse(await readFile(join(dir, `${name}-apply.json`), 'utf8')) as {
      deltas: Array<{ id: string; role: string; deltaApplyPx: number; deltaFixturePx: number }>
      intrinsicsCheck: { requested: Record<string, number>; inBlender: Record<string, number>
        parameters: { sensorFit: string; lensMm: number; shiftX: number; shiftY: number
          pixelAspect: { x: number; y: number } }
        maxRequestedErrorPx: number; maxResolvesIntrinsicsErrorPx: number }
      cameraInstalled: { sensorFit: string }
    }
    return { summary, detailed }
  }

  test('一般机位：拟合出的相机重渲染后，预测像素与量到的质心一致，且与真值相机成像一致', async () => {
    const { summary, detailed } = await applyCheck('oblique')
    assert.equal(summary.points, fixture('oblique').points.length)
    assert.ok(summary.checkPoints > 0, '回灌核对里必须有独立 check 点')
    // deltaApply = 拟合预测像素 vs 回灌渲染量到的质心：位姿/内参→像素这条链路的数值正确性 + 测量噪声
    assert.ok(summary.maxApplyDeltaPx < 0.5, `回灌后预测与实拍差 ${summary.maxApplyDeltaPx} px 过大`)
    // deltaFixture = 回灌渲染 vs 真值相机夹具：直接用像素量"拟合相机离真值相机多远"
    assert.ok(summary.maxFixtureDeltaPx < 0.5, `拟合相机与真值相机的成像差 ${summary.maxFixtureDeltaPx} px 过大`)
    assert.ok(detailed.deltas.every(item => typeof item.deltaApplyPx === 'number'))
  })

  test('共面机位：回灌渲染照样自洽，但相机本身确实离真值更远（低残差 ≠ 位姿对）', async () => {
    const planar = await applyCheck(PLANAR_VIEW)
    const general = await applyCheck('oblique')
    assert.ok(planar.summary.maxApplyDeltaPx < 0.5, '共面拟合在自己预测的像素上也应自洽（残差小是真的）')
    assert.ok(planar.summary.maxFixtureDeltaPx > 5 * general.summary.maxFixtureDeltaPx,
      `共面拟合应明显偏得更多：共面 ${planar.summary.maxFixtureDeltaPx} px vs 一般机位 ${general.summary.maxFixtureDeltaPx} px`)
  })

  test('竖幅+非居中主点+fx≠fy：整套 Blender 参数回灌后，装出来的相机 K 就是拟合的 K，holdout 点也在测量噪声内', async () => {
    const { summary, detailed } = await applyCheck(PORTRAIT_VIEW)
    const view = fixture(PORTRAIT_VIEW)
    assert.equal(summary.points, view.points.length)
    assert.equal(summary.checkPoints, view.points.filter(point => point.role === 'check').length)
    assert.ok(summary.checkPoints > 0, '竖幅用例必须有 holdout 点')
    // 装完之后用 Blender 自己的 view_frame 求出的 K：必须等于拟合时请求的 K（不是"差不多"，是同一台相机）。
    assert.ok(summary.maxIntrinsicsErrorPx < 0.01,
      `回灌后真实 Blender 的 K 与请求 K 差 ${summary.maxIntrinsicsErrorPx} px：只装 lens/sensor 会错几十像素`)
    assert.ok(summary.maxResolvesIntrinsicsErrorPx < 0.01,
      `读数自报的 resolvesIntrinsics 不实：与真实 Blender 差 ${summary.maxResolvesIntrinsicsErrorPx} px`)
    // 非居中主点与方形像素确实是被"整套参数"复现出来的，不是正好落在中心/正方形上。
    const requested = detailed.intrinsicsCheck.requested
    assert.ok(Math.abs(requested.cx - (requested.width - 1) / 2) > 20, `竖幅用例的主点应明显偏离中心，实际 cx=${requested.cx}`)
    assert.ok(Math.abs(requested.fy - requested.fx) > 50, `竖幅用例应 fx≠fy，实际 fx=${requested.fx} fy=${requested.fy}`)
    assert.notEqual(detailed.intrinsicsCheck.parameters.sensorFit, 'AUTO', '回灌进 Blender 的 sensorFit 必须是显式的')
    assert.ok(detailed.intrinsicsCheck.parameters.pixelAspect.x / detailed.intrinsicsCheck.parameters.pixelAspect.y > 1.05,
      `非方形像素要真的装进去，实际 pixelAspect=${JSON.stringify(detailed.intrinsicsCheck.parameters.pixelAspect)}`)
    // 真渲染量出来的像素：fit 与 check 都要核，check 点不参与拟合。
    assert.ok(summary.maxApplyDeltaPx < 0.5, `回灌后预测与实拍差 ${summary.maxApplyDeltaPx} px 过大`)
    assert.ok(summary.maxFixtureDeltaPx < 0.5, `拟合相机与真值相机的成像差 ${summary.maxFixtureDeltaPx} px 过大`)
    const heldOut = detailed.deltas.filter(item => item.role === 'check')
    assert.equal(heldOut.length, summary.checkPoints)
    assert.ok(maxOf(heldOut.map(item => item.deltaFixturePx)) < 0.5,
      `holdout 点在回灌渲染里的成像应与真值相机一致，最坏 ${maxOf(heldOut.map(item => item.deltaFixturePx))} px`)
  })
})
