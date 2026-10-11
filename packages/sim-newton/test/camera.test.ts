/** 原生 Newton CPU 相机：真实 XPBD 状态、原生射线像素、K/挂载/同物理步；不使用 GUI/GPU。 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { NewtonProvider } from '../src/provider.ts'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const python = process.env.LYAPUNOV_NEWTON_PYTHON ?? join(root, '.runtime/newton-env/bin/python')
const output = process.env.LYAPUNOV_NEWTON_CAMERA_TEST_OUTPUT ?? mkdtempSync(join(tmpdir(), 'newton-camera-'))

function depthValues(uri: string): number[] {
  const bytes = readFileSync(fileURLToPath(uri))
  expect(bytes.subarray(1, 6).toString()).toBe('NUMPY')
  const header = bytes[6] === 1 ? 10 + bytes.readUInt16LE(8) : 12 + bytes.readUInt32LE(8)
  const values: number[] = []
  for (let offset = header; offset < bytes.length; offset += 4) values.push(bytes.readFloatLE(offset))
  return values
}

describe.skipIf(!existsSync(python))('Newton 原生相机 CPU 运行回归', () => {
  let report: any
  beforeAll(() => {
    const run = spawnSync(python, ['-B', join(here, 'camera_fixture.py'), root, output], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', NVIDIA_VISIBLE_DEVICES: '',
        LYAPUNOV_NEWTON_DEVICE: 'cpu', LYAPUNOV_NEWTON_CACHE_ROOT: join(output, 'warp-cache') },
    })
    if (run.status !== 0) throw new Error(`Newton camera fixture exit=${run.status}: ${run.stderr}`)
    report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
  }, 120_000)

  test('源 MJCF 相机按实体范围绑定；tracking 明确不可用且无虚假位姿或 K', () => {
    const cameras = report.beforeList.cameras
    const first = cameras.find((c: any) => c.cameraName === 'first/mounted')
    const second = cameras.find((c: any) => c.cameraName === 'second/mounted')
    expect(first.available).toBe(true)
    expect(first.cameraSource).toBe('mjcf')
    expect(first.worldFromCamera.positionM[0]).toBe(1)
    expect(first.worldFromCamera.positionM[1]).toBe(0)
    expect(first.worldFromCamera.positionM[2]).toBeCloseTo(2.8, 6)
    expect(second.worldFromCamera.positionM[0]).toBe(4)
    const tracking = cameras.find((c: any) => c.cameraName === 'first/tracking')
    expect(tracking.available).toBe(false)
    expect(tracking.reason).toContain('fixed')
    expect(tracking.worldFromCamera).toBeUndefined()
    expect(tracking.intrinsics).toBeUndefined()
    const nested = cameras.find((c: any) => c.cameraName === 'included/nested')
    expect(nested.available).toBe(true)
    expect(nested.fovyDeg).toBeCloseTo(50, 6)
    expect(nested.worldFromCamera.positionM[0]).toBeCloseTo(-4, 6)
    expect(nested.worldFromCamera.positionM[1]).toBeCloseTo(0, 6)
    expect(nested.worldFromCamera.positionM[2]).toBeCloseTo(1.5, 6)
    const expectedRotation = [[0, 1, 0], [0, 0, -1], [-1, 0, 0]]
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      expect(nested.worldFromCamera.rotationMatrix[row][col]).toBeCloseTo(expectedRotation[row]![col]!, 5)
    }
  })

  test('RGB/轴向米制深度来自原生几何；XPBD 下落后固定相机深度真实改变', () => {
    expect(report.versions).toEqual({ newton: '1.6.0', warp: '1.17.0' })
    expect(report.device).toBe('cpu')
    const before = report.beforePixels[1], after = report.afterPixels[1]
    expect(before.shape).toEqual([48, 64])
    expect(before.dtype).toBe('float32')
    expect(before.pngSignature).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(before.pngBytes).toBeGreaterThan(100)
    expect(before.rgbUniqueCount).toBeGreaterThan(1)
    expect(before.hitCount).toBeGreaterThan(10)
    expect(before.centerM).toBeCloseTo(2.0, 4)
    expect(after.centerM).toBeGreaterThan(before.centerM + .1)
    expect(report.bodyAfterAdvance[0][2]).toBeLessThan(report.bodyBeforeAdvance[0][2] - .1)
    expect(after.centerM).toBeCloseTo(3 - (report.bodyAfterAdvance[0][2] + .2), 4)
  })

  test('挂载外参随相同 state_a 更新，多相机采集不推进物理或改变状态', () => {
    const before = report.beforeList.cameras.find((c: any) => c.cameraName === 'first/mounted')
    const after = report.afterList.cameras.find((c: any) => c.cameraName === 'first/mounted')
    expect(after.worldFromCamera.positionM[2]).toBeCloseTo(report.bodyAfterAdvance[0][2] + 2, 6)
    expect(after.worldFromCamera.positionM[2]).toBeLessThan(before.worldFromCamera.positionM[2] - .1)
    expect(report.captureStateUnchanged).toBe(true)
    expect(report.captureStepBeforeAdvance).toBe(0)
    expect(report.beforeCapture.stepIndex).toBe(0)
    expect(report.afterCapture.stepIndex).toBe(100)
    expect(report.afterCapture.simTime).toBeCloseTo(.2, 8)
    expect(report.afterCapture.observation.frameId).toBe(report.afterCapture.frameId)
    expect(Array.isArray(report.afterCapture.observation.contacts)).toBe(true)
    expect(report.afterCapture.cameras).toHaveLength(2)
    expect(report.afterCapture.cameras[0].calibration.worldFromCamera).toEqual(after.worldFromCamera)
    expect(report.afterPixels[0].centerM).toBeCloseTo(report.beforePixels[0].centerM, 5)
    const sceneMounted = report.afterList.cameras.find((c: any) => c.cameraName === 'scene-mounted/scene-mounted')
    expect(sceneMounted.cameraSource).toBe('scene-camera')
    expect(sceneMounted.parentBodyName).toBe(after.parentBodyName)
    expect(sceneMounted.worldFromCamera.positionM[2]).toBeCloseTo(after.worldFromCamera.positionM[2], 5)
  })

  test('原生非方形像素与主点、Scene 保存的 K 均实际进入射线和标定', () => {
    const optics = report.beforeList.cameras.find((c: any) => c.cameraName === 'first/optics')
    expect(optics.intrinsicsSource).toBe('engine-intrinsics')
    expect(optics.intrinsics.fx).toBeCloseTo(36, 4)
    expect(optics.intrinsics.fy).toBeCloseTo(38.4, 4)
    expect(optics.intrinsics.cx).toBeCloseTo(30.1, 4)
    expect(optics.intrinsics.cy).toBeCloseTo(24.46, 4)
    const k = report.beforeCapture.cameras[2].calibration.intrinsics
    expect(k.fx).toBe(45)
    expect(k.fy).toBe(40)
    expect(k.cx).toBe(21.25)
    expect(k.cy).toBe(19.75)
    // 导出的前表面像素位置独立核对主点与 fx/fy，不能仅回显声明的 K。
    const savedBounds = report.beforePixels[2].frontPixelBounds
    expect(savedBounds).toEqual([17, 16, 25, 23])
    const nativeBounds = report.beforePixels[3].frontPixelBounds
    expect(nativeBounds).toEqual([27, 21, 34, 28])
    expect(report.beforeCapture.cameras[2].calibration.depthSemantics).toContain('axial-meters')
    expect(report.beforeCapture.cameras[2].calibration.backgroundDepthM).toBe(0)
  })

  test('原生粒子被渲染，state 粒子位置改变后 BVH 与深度同步更新', () => {
    expect(report.particlePixels.hitCount).toBeGreaterThan(20)
    expect(report.particlePixels.centerM).toBeCloseTo(1.6513, 2)
    expect(report.particleMovedPixels.centerM).toBeGreaterThan(report.particlePixels.centerM + .9)
    expect(report.particleMovedPixels.hitCount).toBeLessThan(report.particlePixels.hitCount)
    expect(report.particleObservation.sensorsOnly).toBe(true)
    expect(report.particleObservationError.code).toBe('WORLD_UNAVAILABLE')
    expect(report.particleObservationError.message).toContain('Injected observation error')
  })

  test('相机声明 sync 与 JSON 重开保留视场，结构化拒绝准确，媒体 URI 可回写', () => {
    expect(report.cameraOnlySyncModelUnchanged).toBe(true)
    const synced = report.syncedList.cameras.find((c: any) => c.cameraName === 'fixed/overview')
    const reopened = report.reopenedList.cameras.find((c: any) => c.cameraName === 'fixed/overview')
    expect(synced.fovyDeg).toBeCloseTo(40, 8)
    expect(reopened.intrinsics).toEqual(synced.intrinsics)
    expect(report.ambiguous.code).toBe('AMBIGUOUS_CAMERA')
    expect(report.unsupportedMode.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(report.unknown.code).toBe('CAMERA_NOT_FOUND')
    expect(report.duplicate.code).toBe('INVALID_ARGUMENT')
    expect(report.geomGroups.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(report.published.files).toBe(4)
    expect(report.publishedUris[0]).toContain('/published/')
  })

  test('真实公共 Provider/RPC 接线：命名相机、同帧多视图、暂存发布与成功重建后采集', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'newton-camera-rpc-workspace-'))
    const product = process.env.LYAPUNOV_NEWTON_CAMERA_RPC_OUTPUT ?? mkdtempSync(join(root, '.runtime/newton-camera-rpc-'))
    const runtime = join(workspace, 'runtime')
    const provider = new NewtonProvider({ pythonPath: python, device: 'cpu', cacheRoot: join(output, 'warp-cache'),
      launch: async input => ({ argv: [input.pythonPath, '-u', input.workerPath], cwd: workspace,
        env: { ...input.env, CUDA_VISIBLE_DEVICES: '', NVIDIA_VISIBLE_DEVICES: '' },
        facts: { sessionId: 'newton-camera-rpc-fixture', mode: 'workspace-write', workspaceRoot: workspace,
          writableRoot: workspace, runtimeRoot: runtime, productRoots: [product], privateRootBoundary: 'none' },
        check: async () => ({ stale: false, current: { mode: 'workspace-write', workspaceRoot: workspace } }),
      }),
    })
    // 这里只验证既有媒体中转与真实worker，不声称该测试接线施加了OS沙箱。
    const scene: SceneSnapshot = { sceneId: 'camera-rpc', revision: 1,
      coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [
        { entityId: 'box', name: 'box', resources: [], transform: { position: [0, 0, .5], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
          components: { collision: { shape: 'box', halfExtents: [.4, .4, .1] }, rigidBody: { type: 'static' } } },
        ...['view-a', 'view-b'].map((name, index) => ({ entityId: name, name, resources: [],
          transform: { position: [index * .05, 0, 1.5] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
          components: { camera: { fovYDeg: 60 } } })),
      ] }
    try {
      const opened = await provider.open(scene, { worldId: 'w-camera-rpc', clock: 'manual', ground: false })
      expect(opened.device).toBe('cpu')
      const list = await provider.listCameras(opened.worldId) as any
      expect(list.cameras.filter((c: any) => c.available).map((c: any) => c.cameraName)).toEqual(['view-a/view-a', 'view-b/view-b'])
      const capture = await provider.capture(opened.worldId, { cameraName: 'view-a/view-a', width: 32, height: 24, outputDir: join(product, 'single') }) as any
      expect(capture.source).toBe('newton-sensor-tiled-camera')
      expect(capture.stepIndex).toBe(0)
      expect(capture.observation.frameId).toBe(capture.frameId)
      expect(existsSync(fileURLToPath(capture.rgb.uri))).toBe(true)
      expect(fileURLToPath(capture.depth.uri)).toStartWith(product)
      expect(existsSync(join(runtime, 'staging/media-1'))).toBe(false)
      const depths = depthValues(capture.depth.uri)
      expect(depths).toHaveLength(32 * 24)
      expect(depths[12 * 32 + 16]!).toBeCloseTo(.9, 5)
      const multi = await provider.captureMulti(opened.worldId, { cameraNames: ['view-a/view-a', 'view-b/view-b'],
        width: 32, height: 24, outputDir: join(product, 'multi') }) as any
      expect(multi.cameras).toHaveLength(2)
      expect(multi.stepIndex).toBe(capture.stepIndex)
      expect(multi.observation.frameId).toBe(multi.frameId)
      for (const camera of multi.cameras) {
        expect(existsSync(fileURLToPath(camera.rgb.uri))).toBe(true)
        expect(existsSync(fileURLToPath(camera.depth.uri))).toBe(true)
      }
      await expect(provider.capture(opened.worldId, { cameraName: 'missing', outputDir: join(product, 'missing') }))
        .rejects.toMatchObject({ code: 'CAMERA_NOT_FOUND' })
      const edited = structuredClone(scene)
      edited.revision = 2
      edited.entities[1]!.components.camera = { fovYDeg: 40 }
      expect((await provider.sync(opened.worldId, edited)).worldGeneration).toBe(1)
      expect((await provider.listCameras(opened.worldId) as any).cameras[0].fovyDeg).toBeCloseTo(40, 6)
      const rebuilt = await provider.sync(opened.worldId, { ...edited, revision: 3 }, { forceRebuild: true })
      expect(rebuilt.worldGeneration).toBe(2)
      const newCapture = await provider.capture(opened.worldId, { cameraName: 'view-a/view-a', width: 32, height: 24, outputDir: join(product, 'rebuilt') }) as any
      expect(newCapture.generation).toBe(2)
      expect(newCapture.observation.generation).toBe(2)
      expect(depthValues(newCapture.depth.uri)[12 * 32 + 16]!).toBeCloseTo(.9, 5)
      await provider.close(opened.worldId)
      await expect(provider.listCameras(opened.worldId)).rejects.toMatchObject({ code: 'WORLD_NOT_FOUND' })
    } finally {
      await provider.dispose()
      rmSync(workspace, { recursive: true, force: true })
      if (!process.env.LYAPUNOV_NEWTON_CAMERA_RPC_OUTPUT) rmSync(product, { recursive: true, force: true })
    }
  }, 180_000)
})
