/**
 * DEV-009 剩下的 2/5：`camera_project_annotation` 与 `camera_dataset_export` 在 Isaac 侧的接线与落地。
 *
 * 本用例**自身不启动 Kit/RTX**（不依赖 GPU/驱动是否可见），所以 **RTX 渲染本身**这一层取不到读数；
 * 它不假装取到了，钉的是另外三层，全部是可复算的真实读数：
 *  1. **provider 转发**：`projectAnnotation`／`exportCameraDataset` 发出的请求名就是
 *     `camera_project_annotation`／`camera_dataset_export`，入参原样透传（不被客户端改写/补默认值），
 *     worker 的结构化拒绝原样带出（错误码保留）——与已实现的三个相机接口同一形状。
 *  2. **真实算术**（不是替身）：标注的"像素+米制深度 → camera/world 坐标"用的是
 *     `packages/sim-isaac/python/camera_math.py` **真文件**（worker.project_annotation 调用的就是它），
 *     在真实 numpy 上做 unproject→reproject 往返核对、背景/远平面与无效深度的判定。
 *  3. **真实实现 + 真实文件层**：数据集导出跑的是 `packages/sim-isaac/python/camera_dataset.py` 的
 *     `export_dataset`（worker.export_camera_dataset 直接调它），fixture 是**真落盘**的真 PNG/真 npy；
 *     核对 samples.jsonl/calibration.json/annotations.json/dataset.json 的内容与真实副本字节，
 *     并对"不存在的 captureId／标注 ephemeral 记录／旧代次／文件缺失"逐条验证明确拒绝。
 *
 * 未覆盖（如实登记，见回执 §"未覆盖"）：Kit/RTX 真机上的 RGB+深度成像与 `_rtx_frame` 渲染通路、
 * provider→真 worker 的端到端（本机起不了 Isaac）。这些需要一次**设备可见的 rtx 会话**。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsaacProvider } from '../src/provider.ts'
import { SimError, type CameraAnnotationOptions, type CameraDatasetExportOptions } from '../../sim-contract/src/index.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = resolve(HERE, '../python/worker.py')
const CAMERA_MATH = resolve(HERE, '../python/camera_math.py')
const CAMERA_DATASET = resolve(HERE, '../python/camera_dataset.py')

/**
 * 能跑真实 numpy/PIL 的解释器：CI 的唯一解释器契约 `TESTCI_PYTHON` 优先
 * （`.github/workflows/ci.yml` 只在那一个 venv 里装 numpy/Pillow），其次才是
 * 本机会话解释器与系统 python3。这里不能拿 `/usr/bin/python3` 顶掉 CI venv，
 * 否则真实探针会以 `ModuleNotFoundError` 失败——那是选错解释器，不是用例的语义。
 */
function analysisPython(): string | undefined {
  const candidates = [
    process.env.TESTCI_PYTHON,
    process.env.LYAPUNOV_SIM_PYTHON,
    resolve(HERE, '../../../../.runtime/sim-python/bin/python'),
    '/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3',
  ].map(value => value?.trim()).filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find(candidate => existsSync(candidate))
}
/** 起假 worker 用的解释器：只需要 json/sys，任何 python3 都行。 */
function systemPython(): string | undefined {
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}
const PYTHON = systemPython()
const ANALYSIS_PYTHON = analysisPython()

let base: string | undefined
const providers: IsaacProvider[] = []
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose().catch(() => undefined)
  if (base) rmSync(base, { recursive: true, force: true })
  base = undefined
})

/** 假 worker：只实现行协议（不启动 Kit/RTX），按 env 回结构化拒绝或原样回显收到的 options。 */
function workerSource(): string {
  return [
    'import json, os, sys',
    'def emit(value): print(json.dumps(value), flush=True)',
    "emit({'event': 'ready', 'engine': 'fake-isaac', 'version': '0.0.0', 'pid': 1})",
    'for line in sys.stdin:',
    '    request = json.loads(line)',
    "    method = request.get('method'); args = request.get('args', {})",
    "    if method == 'open':",
    "        world = args.get('options', {}).get('worldId') or 'w1'",
    "        emit({'id': request['id'], 'result': {'worldId': world, 'sceneId': args.get('snapshot', {}).get('sceneId', 's'), 'engineId': 'isaac', 'engineVersion': '0.0.0', 'worldGeneration': 1, 'appliedSceneRevision': 0, 'status': 'ready', 'clock': 'realtime', 'timestepS': 0.002}})",
    "    elif method in ('camera_project_annotation', 'camera_dataset_export'):",
    "        options = args.get('options', {})",
    "        failure = os.environ.get('ANALYSIS_ERROR')",
    "        if failure == 'CAPTURE_NOT_FOUND':",
    "            emit({'id': request['id'], 'error': {'code': 'CAPTURE_NOT_FOUND', 'message': 'captureId 不存在于当前 world（标注只能引用真实采集）: nope'}})",
    "        elif failure == 'SENSOR_UNAVAILABLE':",
    "            emit({'id': request['id'], 'error': {'code': 'SENSOR_UNAVAILABLE', 'message': '当前Profile未启动RTX；像素+真实深度的标注需要 rendering:rtx（未给 captureId 时标注要用本步真实渲染的深度）'}})",
    "        elif failure == 'STALE_GENERATION':",
    "            emit({'id': request['id'], 'error': {'code': 'STALE_GENERATION', 'message': 'captureId capture-old 属于旧世界代次（采集时 generation=1，当前 2）：拒绝导出可能已过期的采集'}})",
    '        else:',
    "            emit({'id': request['id'], 'result': {'worldId': args.get('worldId'), 'receivedMethod': method, 'receivedOptions': options, 'cameraName': options.get('cameraName'), 'captureIds': options.get('captureIds')}})",
    "    elif method == 'shutdown':",
    "        emit({'id': request['id'], 'result': None}); break",
    '    else:',
    "        emit({'id': request['id'], 'error': {'code': 'UNKNOWN_METHOD', 'message': str(method)}})",
  ].join('\n') + '\n'
}
const scene = (sceneId = 'isaac-analysis-scene'): SceneSnapshot => ({ sceneId, revision: 0, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [] })
type ForwardResult = { receivedMethod?: string; receivedOptions?: Record<string, unknown>; cameraName?: string; captureIds?: string[] }
function provider(): IsaacProvider {
  base = mkdtempSync(join(tmpdir(), 'isaac-camera-analysis-'))
  const cache = join(base, 'cache'); mkdirSync(cache, { recursive: true })
  const worker = join(base, 'fake-worker.py'); writeFileSync(worker, workerSource())
  const instance = new IsaacProvider({ pythonPath: PYTHON!, workerPath: worker, cacheRoot: cache })
  providers.push(instance)
  return instance
}
async function rejection(run: () => Promise<unknown>): Promise<SimError> {
  try { await run() } catch (error) { if (error instanceof SimError) return error; throw error }
  throw new Error('期望结构化拒绝，实际调用成功')
}

describe('provider 转发：两个入口与已实现的三个同一条形状', () => {
  test('projectAnnotation 发的是 camera_project_annotation，且 options 原样透传（含可选的 depthM/captureId/width/height）', async () => {
    const instance = provider()
    const world = await instance.open(scene())
    const options: CameraAnnotationOptions = { cameraName: 'wrist', pixel: [12, 34], depthM: 1.5, captureId: 'capture-1', width: 320, height: 240 }
    const result = await instance.projectAnnotation(world.worldId, options) as ForwardResult
    expect(result.receivedMethod).toBe('camera_project_annotation')
    expect(result.receivedOptions).toEqual({ ...options })
  })
  test('exportCameraDataset 发的是 camera_dataset_export，captureIds 顺序原样保留（数组顺序＝数据集帧顺序）', async () => {
    const instance = provider()
    const world = await instance.open(scene())
    const options: CameraDatasetExportOptions = { outputDir: join(base!, 'data'), captureIds: ['capture-b', 'capture-a'] }
    const result = await instance.exportCameraDataset(world.worldId, options) as ForwardResult
    expect(result.receivedMethod).toBe('camera_dataset_export')
    expect(result.captureIds).toEqual(['capture-b', 'capture-a'])
  })
  test('worker 的结构化拒绝原样带出（码不变、消息不被改写）', async () => {
    // 假 worker 在**启动时**读 env（与真 worker 一样只随进程生效）：必须在 spawn 之前设好。
    process.env.ANALYSIS_ERROR = 'CAPTURE_NOT_FOUND'
    try {
      const instance = provider()
      const world = await instance.open(scene())
      const error = await rejection(() => instance.projectAnnotation(world.worldId, { cameraName: 'wrist', pixel: [0, 0], captureId: 'nope' }))
      expect(error.code).toBe('CAPTURE_NOT_FOUND')
      expect(error.message).toContain('captureId 不存在于当前 world')
    } finally { delete process.env.ANALYSIS_ERROR }
  })
  test('未给 captureId 且没有 RTX 时是阶段化拒绝（SENSOR_UNAVAILABLE），不是"能力缺失"', async () => {
    process.env.ANALYSIS_ERROR = 'SENSOR_UNAVAILABLE'
    try {
      const instance = provider()
      const world = await instance.open(scene())
      const error = await rejection(() => instance.projectAnnotation(world.worldId, { cameraName: 'wrist', pixel: [0, 0] }))
      expect(error.code).toBe('SENSOR_UNAVAILABLE')
      expect(error.message).toContain('rendering:rtx')
    } finally { delete process.env.ANALYSIS_ERROR }
  })
  test('旧代次采集在导出时被明确拒绝（STALE_GENERATION）', async () => {
    process.env.ANALYSIS_ERROR = 'STALE_GENERATION'
    try {
      const instance = provider()
      const world = await instance.open(scene())
      const error = await rejection(() => instance.exportCameraDataset(world.worldId, { outputDir: join(base!, 'data'), captureIds: ['capture-old'] }))
      expect(error.code).toBe('STALE_GENERATION')
      expect(error.message).toContain('旧世界代次')
    } finally { delete process.env.ANALYSIS_ERROR }
  })
})

/** 把一段 python 探针跑在真实解释器上；失败时把 stderr 一起抛出来（不然"退出码非 0"没有信息量）。 */
function runPython(script: string): { exitCode: number; stdout: string; stderr: string } {
  // 没有真实 numpy/Pillow 解释器就是**用例失败**：不 skip、不 return 冒充通过。
  if (!ANALYSIS_PYTHON) throw new Error('真实 numpy/Pillow 解释器不可用：请设置 TESTCI_PYTHON（CI 唯一 venv）或本机会话解释器')
  const run = Bun.spawnSync([ANALYSIS_PYTHON, '-c', script])
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}
function pythonJson<T>(script: string): T {
  const run = runPython(script)
  if (run.exitCode !== 0) throw new Error(`python 探针失败（exit ${run.exitCode}）：${run.stderr || run.stdout}`)
  return JSON.parse(run.stdout) as T
}

describe('标注的真实算术（用真 camera_math.py + 真 numpy，不是替身）', () => {
  test('unproject→reproject 往返残差为 0；K 与 capture 回执同一口径', () => {
    const parsed = pythonJson<{
      K: { fx: number; fy: number; cx: number; cy: number; intrinsicsSource: string }
      rows: Array<{ pixel: number[]; depth: number; residual: number[]; cameraPointM: number[]; worldPointM: number[] }>
      depthGeometry: [boolean, string]; depthFarPlane: [boolean, string]; depthNaN: [boolean, string]; depthZero: [boolean, string]
    }>(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('camera_math', ${JSON.stringify(CAMERA_MATH)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
K = module.intrinsics_from_fovy(45.0, 640, 480, 18.75)
worldFromCamera = {'positionM': [1.0, 2.0, 3.0], 'rotationMatrix': [[0, -1, 0], [0, 0, 1], [-1, 0, 0]]}
rows = []
for pixel, depth in [([0, 0], 4.0), ([320, 240], 4.0), ([639, 479], 2.5), ([123, 77], 7.25)]:
    camera = module.unproject_camera_point(pixel[0], pixel[1], depth, K)
    world = module.camera_point_to_world(camera, worldFromCamera)
    back = module.world_point_to_pixel(world, K, worldFromCamera)
    rows.append({'pixel': pixel, 'depth': depth, 'cameraPointM': camera, 'worldPointM': world,
                 'residual': [back[0] - pixel[0], back[1] - pixel[1]]})
print(json.dumps({'K': K, 'rows': rows,
                  'depthGeometry': module.depth_is_valid(1.0, None),
                  'depthFarPlane': module.depth_is_valid(100.0, 100.0),
                  'depthNaN': module.depth_is_valid(float('nan'), 100.0),
                  'depthZero': module.depth_is_valid(0.0, 100.0)}, allow_nan=False))
`)
    // K 与 worker.capture 的口径同源：fx=fy=H/(2tan(fovy/2))，主点 (W-1)/2 / (H-1)/2。
    expect(parsed.K.fx).toBeCloseTo(480 / (2 * Math.tan((45 * Math.PI / 180) / 2)), 9)
    expect(parsed.K.fy).toBeCloseTo(parsed.K.fx, 9)
    expect(parsed.K.cx).toBeCloseTo(319.5, 9)
    expect(parsed.K.cy).toBeCloseTo(239.5, 9)
    expect(parsed.K.intrinsicsSource).toBe('usd-camera-focalLength-aperture')
    for (const row of parsed.rows) {
      // 反投影可重投影核对：精确回到原像素（完成条件里"可重投影核对"的读数）。
      expect(Math.abs(row.residual[0])).toBeLessThan(1e-9)
      expect(Math.abs(row.residual[1])).toBeLessThan(1e-9)
      // 相机系约定：深度沿 −Z（USD 相机朝 −Z 看），世界点按 worldFromCamera 变换得到。
      expect(row.cameraPointM[2]).toBeCloseTo(-row.depth, 9)
      expect(row.worldPointM.length).toBe(3)
    }
    expect(parsed.depthGeometry).toEqual([true, 'GEOMETRY'])
    expect(parsed.depthFarPlane).toEqual([false, 'AT_OR_BEYOND_FAR_CLIP'])
    expect(parsed.depthNaN).toEqual([false, 'NON_POSITIVE_OR_NON_FINITE'])
    expect(parsed.depthZero).toEqual([false, 'NON_POSITIVE_OR_NON_FINITE'])
  })

  test('负对照：深度换成远平面/NaN/0 ⇒ 判"无有效深度"，pixel 越界的界也钉住', () => {
    const parsed = pythonJson<{ far: [boolean, string]; above: [boolean, string]; inf: [boolean, string]; justInside: [boolean, string]; required: string }>(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('camera_math', ${JSON.stringify(CAMERA_MATH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
far = 100.0
try:
    m.unproject_camera_point(1, 1, 1.0, {'fx': 0.0, 'fy': 0.0, 'cx': 0, 'cy': 0})
    required = 'NO_ERROR'
except ValueError as error:
    required = str(error)
print(json.dumps({'far': m.depth_is_valid(far, far), 'above': m.depth_is_valid(far * 2, far),
                  'inf': m.depth_is_valid(float('inf'), far), 'justInside': m.depth_is_valid(far * 0.999, far),
                  'required': required}))
`)
    expect(parsed.far[0]).toBe(false)
    expect(parsed.above[0]).toBe(false)
    expect(parsed.inf[0]).toBe(false)
    expect(parsed.justInside[0]).toBe(true)
    // 缺内参时明确拒绝，而不是拿 0 除出一个"看起来差不多"的点。
    expect(parsed.required).toBe('CALIBRATION_REQUIRED')
  })

  test('worker 的标注路径调用的就是这份算术（静态同源：不是第二套公式）', () => {
    const source = readFileSync(WORKER, 'utf8')
    expect(source).toContain('from camera_math import intrinsics_from_fovy,unproject_camera_point,camera_point_to_world,world_point_to_pixel,depth_is_valid')
    expect(source).toContain('camera_point=unproject_camera_point(u,v,actual,intrinsics)')
    expect(source).toContain('world_point=camera_point_to_world(camera_point,world_from_camera)')
    // 采集引用校验也走同一份纯函数（不是 worker 里第二份 if 链）。
    expect(source).toContain('from camera_math import select_capture as camera_math_select_capture')
    expect(source).toContain('camera_math_select_capture(self.captures,capture_id,name,resolved,width,height,self.generation)')
    for (const code of ['PIXEL_OUT_OF_BOUNDS', 'ANNOTATION_NO_DEPTH', 'ANNOTATION_DEPTH_MISMATCH']) {
      expect(source).toContain(code)
    }
    expect(source).toContain("elif method=='camera_project_annotation':result=world.project_annotation(args['options'])")
    expect(source).toContain("elif method=='camera_dataset_export':result=world.export_camera_dataset(args['options'])")
  })

  test('引用校验的真读数：capture 不存在/ephemeral/旧代次/相机不在其中/缺标定/分辨率不一致，逐条精确拒绝', () => {
    const parsed = pythonJson<{ codes: Record<string, string>; messages: Record<string, string> }>(`
import importlib.util, json
spec = importlib.util.spec_from_file_location('camera_math', ${JSON.stringify(CAMERA_MATH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
calibration = {'intrinsics': m.intrinsics_from_fovy(45.0, 4, 4, 18.75),
               'worldFromCamera': {'positionM': [0.0, 0.0, 0.0], 'rotationMatrix': [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}}
cameras = [{'cameraName': 'wrist', 'resolvedCameraName': '/World/wrist', 'calibration': calibration}]
captures = {'c1': {'captureId': 'c1', 'generation': 2, 'width': 4, 'height': 4, 'ephemeral': False, 'cameras': cameras},
            'annotation-x': {'captureId': 'annotation-x', 'generation': 2, 'width': 4, 'height': 4, 'ephemeral': True, 'cameras': []},
            'old': {'captureId': 'old', 'generation': 1, 'width': 4, 'height': 4, 'ephemeral': False, 'cameras': cameras},
            'nocamera': {'captureId': 'nocamera', 'generation': 2, 'width': 4, 'height': 4, 'ephemeral': False, 'cameras': []},
            'nocalib': {'captureId': 'nocalib', 'generation': 2, 'width': 4, 'height': 4, 'ephemeral': False,
                        'cameras': [{'cameraName': 'wrist', 'resolvedCameraName': '/World/wrist'}]}}
cases = {'ok': ('c1', 'wrist', 4, 4), 'missing': ('nope', 'wrist', 4, 4), 'ephemeral': ('annotation-x', 'wrist', 4, 4),
         'stale': ('old', 'wrist', 4, 4), 'noCamera': ('nocamera', 'wrist', 4, 4), 'noCalibration': ('nocalib', 'wrist', 4, 4),
         'resolutionMismatch': ('c1', 'wrist', 640, 480)}
codes, messages = {}, {}
for name, (capture_id, camera, width, height) in cases.items():
    try:
        m.select_capture(captures, capture_id, camera, '/World/' + camera, width, height, 2)
        codes[name] = 'OK'
    except ValueError as error:
        codes[name], _, messages[name] = str(error).partition(':')
print(json.dumps({'codes': codes, 'messages': messages}))
`)
    expect(parsed.codes).toEqual({
      ok: 'OK',
      missing: 'CAPTURE_NOT_FOUND',
      ephemeral: 'CAPTURE_NOT_REUSABLE',
      stale: 'STALE_GENERATION',
      noCamera: 'CAMERA_NOT_IN_CAPTURE',
      noCalibration: 'CALIBRATION_REQUIRED',
      resolutionMismatch: 'INVALID_ARGUMENT',
    })
    // 消息里要有可核对的事实（代次/分辨率），不是一句"失败了"。
    expect(parsed.messages.stale).toContain('generation=1')
    expect(parsed.messages.stale).toContain('当前 2')
    expect(parsed.messages.resolutionMismatch).toContain('4x4')
    expect(parsed.messages.resolutionMismatch).toContain('640x480')
  })

  test('真实 worker 方法：depth 取自 select_capture 命中的那台相机条目；正/负越界都在读 depth[v,u] 前判 PIXEL_OUT_OF_BOUNDS', () => {
    // 这里执行的是 worker.py 里真实的 `_remember_capture`/`_camera_resolution`/`project_annotation`
    // （AST 抽取后按真实实现 exec），引用**真落盘**的 .npy；fresh-render 的数组是明确单元夹具，
    // 不是 RTX 证据。第二台相机的深度与标定都不同，专门挡住"读第一台/读 record['depth']/凭 depthM"。
    const parsed = pythonJson<{
      singleDepth: number
      multi: Array<{ name: string; depthM: number; fx: number }>
      referencedBounds: Array<{ pixel: number[]; ok: boolean; errorType?: string; code?: string | null }>
      freshBounds: Array<{ pixel: number[]; ok: boolean; errorType?: string; code?: string | null }>
    }>(`
import ast, importlib.util, json, pathlib, tempfile, uuid
import numpy as np
WORKER = ${JSON.stringify(WORKER)}
CAMERA_MATH = ${JSON.stringify(CAMERA_MATH)}
spec = importlib.util.spec_from_file_location('camera_math', CAMERA_MATH)
cm = importlib.util.module_from_spec(spec); spec.loader.exec_module(cm)
class SceneError(Exception):
    def __init__(self, code, message):
        super().__init__(message); self.code = code
module = ast.parse(pathlib.Path(WORKER).read_text())
world = next(x for x in module.body if isinstance(x, ast.ClassDef) and x.name == 'World')
methods = [x for x in world.body if isinstance(x, ast.FunctionDef) and x.name in ['_remember_capture', '_camera_resolution', '_camera_entity', 'project_annotation']]
subset = ast.Module(body=[ast.ClassDef(name='WorldMethods', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
ns = dict(np=np, uuid=uuid, SceneError=SceneError, finite=lambda x, label: float(x),
          path_from_uri=lambda x: x.removeprefix('file://'),
          camera_math_select_capture=cm.select_capture, depth_is_valid=cm.depth_is_valid,
          unproject_camera_point=cm.unproject_camera_point, camera_point_to_world=cm.camera_point_to_world,
          world_point_to_pixel=cm.world_point_to_pixel, rendering=False)
exec(compile(ast.fix_missing_locations(subset), WORKER, 'exec'), ns)
def make_world():
    w = ns['WorldMethods']()
    w.id = 'probe'; w.generation = 1; w.revision = 1; w.index = 0; w.sim_time = 0.0
    w.captures = {}; w.camera_overrides = {}; w.entities = {}
    w.ready = lambda: None; w.resolve_camera_name = lambda n: n; w._camera_far_depth = lambda p: 100.0
    return w
def calibration(fx):
    return {'intrinsics': {'width': 16, 'height': 16, 'fx': fx, 'fy': fx, 'cx': 7.5, 'cy': 7.5, 'fovyDeg': 77.3196165, 'intrinsicsSource': 'fovy'},
            'worldFromCamera': {'positionM': [0.0, 0.0, 0.0], 'rotationMatrix': [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]}}
def outcome(call):
    try:
        return {'ok': True, 'value': call()}
    except Exception as error:
        return {'ok': False, 'errorType': type(error).__name__, 'code': getattr(error, 'code', None)}
with tempfile.TemporaryDirectory(prefix='isaac-annotation-regression-') as td:
    root = pathlib.Path(td)
    result = {'generation': 1, 'sceneRevision': 1, 'stepIndex': 0, 'simTime': 0.0, 'frameId': 'probe:1:0', 'width': 16, 'height': 16}
    single_npy = root / 'single.npy'; np.save(single_npy, np.full((16, 16), 2.0, dtype=np.float32))
    single_entry = {'cameraName': 'overview', 'resolvedCameraName': 'overview', 'depth': {'uri': single_npy.as_uri()}, 'calibration': calibration(10.0)}
    single_world = make_world(); single_world._remember_capture('single', result, [single_entry])
    single = single_world.project_annotation({'cameraName': 'overview', 'pixel': [8, 8], 'width': 16, 'height': 16, 'captureId': 'single'})
    overview_npy = root / 'overview.npy'; np.save(overview_npy, np.full((16, 16), 2.0, dtype=np.float32))
    wrist_npy = root / 'wrist.npy'; np.save(wrist_npy, np.full((16, 16), 5.0, dtype=np.float32))
    entries = [
        {'cameraName': 'overview', 'resolvedCameraName': 'overview', 'depth': {'uri': overview_npy.as_uri()}, 'calibration': calibration(10.0)},
        {'cameraName': 'wrist', 'resolvedCameraName': 'wrist', 'depth': {'uri': wrist_npy.as_uri()}, 'calibration': calibration(20.0)},
    ]
    multi_world = make_world(); multi_world._remember_capture('multi', result, entries)
    multi = []
    for name in ['overview', 'wrist']:
        annotation = multi_world.project_annotation({'cameraName': name, 'pixel': [8, 8], 'width': 16, 'height': 16, 'captureId': 'multi'})
        multi.append({'name': name, 'depthM': annotation['depthM'], 'fx': annotation['fov']['fx']})
    referenced = []
    for pixel in [[16, 0], [-1, 0]]:
        row = outcome(lambda pixel=pixel: multi_world.project_annotation({'cameraName': 'overview', 'pixel': pixel, 'width': 16, 'height': 16, 'captureId': 'multi'})['depthM'])
        referenced.append({'pixel': pixel, **row})
    ns['rendering'] = True
    fresh_world = make_world()
    fresh_world._camera_prim = lambda p: None
    fresh_world._capture_root = lambda opts: root
    fresh_world._rtx_frame = lambda p, width, height: (np.zeros((16, 16, 3), dtype=np.uint8), np.full((16, 16), 2.0, dtype=np.float32), calibration(10.0))
    fresh = []
    for pixel in [[16, 0], [-1, 0]]:
        row = outcome(lambda pixel=pixel: fresh_world.project_annotation({'cameraName': 'overview', 'pixel': pixel, 'width': 16, 'height': 16})['depthM'])
        fresh.append({'pixel': pixel, **row})
    print(json.dumps({'singleDepth': single['depthM'], 'multi': multi, 'referencedBounds': referenced, 'freshBounds': fresh}, ensure_ascii=False))
`)
    expect(parsed.singleDepth).toBe(2.0)
    // 命中第二台相机：深度 5 且标定 fx=20，不是第一台的 2/10。
    expect(parsed.multi).toEqual([
      { name: 'overview', depthM: 2.0, fx: 10.0 },
      { name: 'wrist', depthM: 5.0, fx: 20.0 },
    ])
    for (const row of [...parsed.referencedBounds, ...parsed.freshBounds]) {
      expect(row.ok).toBe(false)
      expect(row.errorType).toBe('SceneError')
      expect(row.code).toBe('PIXEL_OUT_OF_BOUNDS')
    }
  })
})

describe('数据集导出：真实现 + 真 PNG/真 npy', () => {
  test('导出真副本并写下四份索引；副本字节与原文件相同、目录/索引路径真实存在', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'isaac-dataset-'))
    try {
      const parsed = pythonJson<{
        receipt: { status: string; sampleCount: number; frameCount: number; multiView: boolean; annotationCount: number; files: string[]; missing: unknown[]; datasetPath: string; directory: string; cameraNames: string[] }
        outputDir: string
        sources: Array<{ rgb: string; depth: string }>
        samples: Array<Record<string, unknown>>
        calibration: { cameras: Record<string, { sources: unknown[] }> }
        errors: Record<string, string>
        copies: Record<string, boolean>
        missingFileRun: { status: string; missing: Array<{ reason: string }> }
      }>(`
import importlib.util, json
from pathlib import Path
import numpy as np
from PIL import Image

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

math_module = load('camera_math', ${JSON.stringify(CAMERA_MATH)})
dataset = load('camera_dataset', ${JSON.stringify(CAMERA_DATASET)})
workspace = Path(${JSON.stringify(workspace)})
root = workspace / 'captures'; root.mkdir(parents=True, exist_ok=True)
calibration = {'intrinsics': math_module.intrinsics_from_fovy(45.0, 4, 4, 18.75),
               'worldFromCamera': {'positionM': [1.0, 2.0, 3.0], 'rotationMatrix': [[0, -1, 0], [0, 0, 1], [-1, 0, 0]]}}

# 两帧真实采集，每帧两台相机（同 stepIndex/frameId 的多视角）与两个真文件
captures, sources = {}, []
for frame in range(2):
    entries = []
    for camera in ('wrist', 'overview'):
        rgb = (np.arange(4 * 4 * 3, dtype=np.uint8) + frame * 7 + len(camera)).reshape(4, 4, 3)
        depth = np.full((4, 4), 1.5 + frame, dtype=np.float32)
        rgb_path = root / ('%d-%s.png' % (frame, camera)); depth_path = root / ('%d-%s-depth.npy' % (frame, camera))
        Image.fromarray(rgb).save(rgb_path); np.save(depth_path, depth)
        sources.append({'rgb': str(rgb_path), 'depth': str(depth_path)})
        entries.append({'cameraName': camera, 'resolvedCameraName': '/World/%s' % camera, 'override': False,
                        'worldGeneration': 1, 'depthRangeM': [float(depth.min()), float(depth.max())],
                        'rgb': {'uri': rgb_path.as_uri(), 'mimeType': 'image/png'},
                        'depth': {'uri': depth_path.as_uri(), 'mimeType': 'application/x-npy', 'units': 'm'},
                        'calibration': calibration, 'annotationIds': []})
    cid = 'capture-%d' % frame
    captures[cid] = {'captureId': cid, 'worldId': 'w1', 'generation': 1, 'sceneRevision': 0, 'stepIndex': frame,
                     'simTime': 0.002 * frame, 'frameId': 'w1:1:%d' % frame, 'width': 4, 'height': 4,
                     'multi': True, 'ephemeral': False, 'cameras': entries,
                     'annotations': [{'annotationId': 'a-%d' % frame, 'cameraName': 'wrist', 'resolvedCameraName': '/World/wrist',
                                      'pixel': [1, 1], 'depthM': 1.5 + frame}]}

output = workspace / 'dataset'
receipt = dataset.export_dataset(captures, ['capture-0', 'capture-1'], output, 1, 'w1', 'scene-1', engine='isaac',
                                 path_from_uri=lambda uri: Path(uri.replace('file://', '')))
# 副本字节核对在**删除源文件之前**做（下面的文件缺失负对照会删掉 0-wrist.png）。
# 副本名由实现按 "kind/序号-相机名" 生成、相机名里的 '/' 被替换成 '_'，所以源文件按 (帧, 相机, 通道) 查表。
source_files = {}
for frame in range(2):
    for camera in ('wrist', 'overview'):
        source_files['%d-%s-rgb' % (frame, camera)] = root / ('%d-%s.png' % (frame, camera))
        source_files['%d-%s-depth' % (frame, camera)] = root / ('%d-%s-depth.npy' % (frame, camera))
copies = {}
for relative in receipt['files']:
    kind, _, name = relative.partition('/')
    index, _, sanitized = name.rsplit('.', 1)[0].partition('-')
    hits = [path for key, path in source_files.items() if key.startswith(index + '-') and key.endswith('-depth' if kind == 'depth' else '-rgb') and sanitized.endswith(key.split('-', 1)[1].rsplit('-', 1)[0])]
    assert len(hits) == 1, (relative, hits)
    copies[relative] = (output / relative).read_bytes() == hits[0].read_bytes()
samples = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines() if line]
calibration_index = json.loads((output / 'calibration.json').read_text())
errors = {}
for name, call in [('missing', lambda: dataset.export_dataset(captures, ['capture-404'], workspace / 'x', 1, 'w1', 'scene-1', engine='isaac', path_from_uri=lambda uri: Path(uri))),
                   ('ephemeral', lambda: dataset.export_dataset({**captures, 'annotation-x': {'captureId': 'annotation-x', 'generation': 1, 'ephemeral': True, 'frameId': 'f', 'width': 4, 'height': 4, 'stepIndex': 0, 'simTime': 0.0, 'sceneRevision': 0, 'worldId': 'w1', 'cameras': []}}, ['annotation-x'], workspace / 'x', 1, 'w1', 'scene-1', engine='isaac', path_from_uri=lambda uri: Path(uri))),
                   ('stale', lambda: dataset.export_dataset(captures, ['capture-0'], workspace / 'x', 2, 'w1', 'scene-1', engine='isaac', path_from_uri=lambda uri: Path(uri))),
                   ('duplicate', lambda: dataset.export_dataset(captures, ['capture-0', 'capture-0'], workspace / 'x', 1, 'w1', 'scene-1', engine='isaac', path_from_uri=lambda uri: Path(uri)))]:
    try:
        call(); errors[name] = 'NO_ERROR'
    except dataset.DatasetError as error:
        errors[name] = error.code

# 文件缺失：登记了 uri 但文件被删 ⇒ 如实进 missing、status=PARTIAL（不冒充完成）
(root / '0-wrist.png').unlink()
partial = dataset.export_dataset(captures, ['capture-0'], workspace / 'partial', 1, 'w1', 'scene-1', engine='isaac',
                                 path_from_uri=lambda uri: Path(uri.replace('file://', '')))
print(json.dumps({'receipt': receipt, 'outputDir': str(output), 'sources': sources, 'samples': samples,
                  'calibration': calibration_index, 'errors': errors, 'copies': copies,
                  'missingFileRun': {'status': partial['status'], 'missing': partial['missing']}}))
`)
      // —— 四份索引都在盘上，副本是真拷（字节与原文件相同）
      expect(parsed.receipt.status).toBe('completed')
      expect(parsed.receipt.sampleCount).toBe(4)
      expect(parsed.receipt.frameCount).toBe(2)
      expect(parsed.receipt.multiView).toBe(true)
      expect(parsed.receipt.annotationCount).toBe(2)
      expect(parsed.receipt.missing).toEqual([])
      expect(parsed.receipt.cameraNames).toEqual(['/World/overview', '/World/wrist'])
      for (const name of ['samples.jsonl', 'calibration.json', 'annotations.json', 'dataset.json']) {
        expect(existsSync(join(parsed.outputDir, name))).toBe(true)
      }
      expect(existsSync(parsed.receipt.datasetPath)).toBe(true)
      expect(parsed.receipt.files.length).toBe(8)
      for (const relative of parsed.receipt.files) {
        const target = join(parsed.outputDir, relative)
        expect(existsSync(target)).toBe(true)
      }
      // —— 副本是**真拷**：每份副本与它的源文件逐字节相同（在探针里、删源文件之前比的）
      expect(Object.values(parsed.copies).every(Boolean)).toBe(true)
      expect(Object.keys(parsed.copies).length).toBe(8)
      // —— samples.jsonl 逐帧逐相机：同帧两台相机共享 frameId/stepIndex/captureId，帧序＝captureIds 顺序
      const rows = parsed.samples as Array<{ captureId: string; frameId: string; stepIndex: number; cameraName: string; rgb: string; depth: string; resolution: { width: number; height: number } }>
      expect(rows.length).toBe(4)
      expect(rows.slice(0, 2).map(row => row.captureId)).toEqual(['capture-0', 'capture-0'])
      expect(new Set(rows.slice(0, 2).map(row => row.frameId)).size).toBe(1)
      expect(new Set(rows.slice(0, 2).map(row => row.stepIndex)).size).toBe(1)
      expect(rows.map(row => row.cameraName)).toEqual(['wrist', 'overview', 'wrist', 'overview'])
      for (const row of rows) {
        expect(row.resolution).toEqual({ width: 4, height: 4 })
        expect(row.rgb).not.toBeNull()
        expect(row.depth).not.toBeNull()
      }
      // —— calibration.json 逐相机（两台）+ 溯源 sources 两条
      expect(Object.keys(parsed.calibration.cameras).sort()).toEqual(['/World/overview', '/World/wrist'])
      expect(parsed.calibration.cameras['/World/wrist'].sources.length).toBe(2)
      // —— 负对照：四条拒绝各自精确
      expect(parsed.errors).toEqual({ missing: 'CAPTURE_NOT_FOUND', ephemeral: 'CAPTURE_NOT_REUSABLE', stale: 'STALE_GENERATION', duplicate: 'INVALID_ARGUMENT' })
      // —— 文件缺失如实降级为 PARTIAL
      expect(parsed.missingFileRun.status).toBe('PARTIAL')
      expect(parsed.missingFileRun.missing[0].reason).toBe('FILE_MISSING')
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })

  test('worker.export_camera_dataset 调的就是这份纯实现（不是第二份导出逻辑），且拒绝码原样转出', () => {
    const source = readFileSync(WORKER, 'utf8')
    expect(source).toContain('from camera_dataset import export_dataset,DatasetError')
    const exportStart = source.indexOf('def export_camera_dataset')
    expect(exportStart).toBeGreaterThan(0)
    const body = source.slice(exportStart, source.indexOf('\n    def close(self)', exportStart))
    expect(body).toContain('return export_dataset(self.captures,options.get(\'captureIds\'),options[\'outputDir\'],self.generation,')
    expect(body).toContain('except DatasetError as error:')
    expect(body).toContain('raise SceneError(error.code,error.message)')
    // 导出逻辑不再在 worker 里第二份（文件拷贝/索引写法只在 camera_dataset.py）
    expect(body).not.toContain('shutil.copyfile')
    expect(body).not.toContain("'lyapunov-camera-dataset-v1'")
  })
})


test('真实采集落盘方法保留无返回深度，并产生严格JSON可读的范围',()=>{
 const worker=resolve(HERE,'../python/worker.py')
 const result=runPython(`
import ast,json,pathlib,tempfile,uuid
import numpy as np
from urllib.parse import urlparse,unquote
source=pathlib.Path(${JSON.stringify(worker)})
tree=ast.parse(source.read_text())
world=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='World')
methods=[node for node in world.body if isinstance(node,ast.FunctionDef) and node.name in ('_rtx_camera_entry','_camera_frame_identity')]
subset=ast.Module(body=[ast.ClassDef(name='CaptureMethod',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[])
ns={'np':np,'uuid':uuid};exec(compile(ast.fix_missing_locations(subset),str(source),'exec'),ns)
w=ns['CaptureMethod']();w.id='capture-probe';w.revision=4;w.generation=1;w.index=3;w.sim_time=.006
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);rgb=np.zeros((2,2,3),dtype=np.uint8)
 depth=np.array([[1,np.inf],[np.nan,2]],dtype=np.float32)
 entry=w._rtx_camera_entry({'cameraName':'mixed','path':'/World/camera'},rgb,depth,2,2,root,False,{'intrinsics':{'fx':2.0},'worldFromCamera':{'positionM':[1,2,3]}})
 sky=w._rtx_camera_entry({'cameraName':'sky','path':'/World/sky'},rgb,np.full((2,2),np.inf,dtype=np.float32),2,2,root,False,{'intrinsics':{'fx':2.0},'worldFromCamera':{'positionM':[1,2,3]}})
 loaded=np.load(unquote(urlparse(entry['depth']['uri']).path))
 print(json.dumps({'range':entry['depthRangeM'],'skyRange':sky['depthRangeM'],'infPreserved':bool(np.isinf(loaded[0,1])),'nanPreserved':bool(np.isnan(loaded[1,0])),'calibration':entry['calibration'], 'frame':[entry['frameId'],entry['generation'],entry['appliedSceneRevision']], 'source':entry['source']},allow_nan=False))
`)
 expect(result.exitCode).toBe(0)
 expect(JSON.parse(result.stdout)).toEqual({range:[1,2],skyRange:null,infPreserved:true,nanPreserved:true,calibration:{intrinsics:{fx:2},worldFromCamera:{positionM:[1,2,3]}},frame:['capture-probe:1:3',1,4],source:'isaac-rtx-camera'})
})
