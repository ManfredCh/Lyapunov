/**
 * P7A 模拟LiDAR量测的真实行为测试（MuJoCo 原生射线）。
 *
 * 运行：
 *   MUJOCO_GL=osmesa LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/lidar-scan.test.ts
 *   （必须开 transform-types：sim-contract/src/python-transport.ts 用了 TypeScript 参数属性。）
 *   解释器缺失时整份显式 skip 并说明原因，不假装通过。
 *
 * 覆盖面（全部走产品 MuJoCoProvider：open → listCameras → scanLidar → captureMulti）：
 *  - 真实几何：一条已知场景里逐射线与解析距离核对（前墙/侧墙/地面/无命中），单位米，量程裁剪显式生效；
 *  - 有效性：无命中写成 NaN 与 valid=false，不当作 0；统计只取有效值；JSON 严格可解析；
 *  - 几何来源：命中 geom id/名来自真实编译模型，回执标 mujoco-compiled-geoms 与自排除边界；
 *  - 原始产物：range/valid/hitGeom npy 与 preview PNG 都落盘；PNG 按 metadata 记录的固定规则可从 npy 复算；
 *  - 同一几何两来源：相机 Depth（沿光轴 Z）与 LiDAR range（沿射线欧氏）在光轴像素/射线上数值一致而语义分开；
 *  - 运动/代次：挂载相机随父 body 真实运动后 range 改变；过期 expectedGeneration 结构化拒绝。
 *
 * 诚实边界：射线打在编译模型的 geom（碰撞+可见几何）上，只排除传感器所挂 body 自身的 geom；不做自车其余
 * 连杆/材质的 LiDAR 回波建模，也不冒充任意真实 LiDAR 传感器标定。CPU OSMesa 与 RTX 成像无关。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { MuJoCoProvider } from '../src/provider.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, '.runtime/sim-python/bin/python')
const available = existsSync(python)
const outDir = resolve(tmpdir(), `w-p7a-lidar-${process.pid}`)
after(() => rmSync(outDir, { recursive: true, force: true }))
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

/** 合成场景：地面 z=0、北墙近面 y=5.9、东墙近面 x=3.9；静置扫描机位 + 一个自由落体挂载相机。 */
function buildScene() {
  const entity = (entityId: string, name: string, position: [number, number, number], quaternion: [number, number, number, number], components: any, parentId?: string) =>
    ({ entityId, name, transform: { position, quaternion, scale: [1, 1, 1] as [number, number, number] }, resources: [], components, ...(parentId ? { parentId } : {}) })
  return {
    sceneId: 'scene-p7a-lidar-test', revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' } as const,
    entities: [
      entity('floor-l', '地面', [0, 0, -0.05], [0, 0, 0, 1], { collision: { type: 'box', halfExtents: [8, 8, 0.05], source: 'lidar-test' } }),
      entity('wall-n', '北墙', [0, 6, 1.5], [0, 0, 0, 1], { collision: { type: 'box', halfExtents: [8, 0.1, 1.5], source: 'lidar-test' } }),
      entity('wall-e', '东墙', [4, 0, 1.5], [0, 0, 0, 1], { collision: { type: 'box', halfExtents: [0.1, 8, 1.5], source: 'lidar-test' } }),
      entity('scan-mount', '扫描机位', [0, -3, 1.2], [0, 0, 0, 1], { camera: { fovYDeg: 45, direction: [0, 1, 0], isActive: true } }),
      entity('faller-l', '落体', [0, -2, 2], [0, 0, 0, 1], { rigidBody: { type: 'dynamic', massKg: 1 }, collision: { type: 'box', halfExtents: [0.05, 0.05, 0.05], source: 'lidar-test' } }),
      entity('cam-fall-l', 'cam_fall', [0, 0, 0], [0, 0, 0, 1], { camera: { fovYDeg: 45, direction: [0, 1, 0], isActive: false } }, 'faller-l'),
    ],
  }
}

/** elev 0 朝 +Y：北墙近面 5.9 −(−3)=8.9；东墙近面 3.9；elev −45 地面 = 1.2/ sin45。 */
const LEVEL_WALL_M = 8.9, EAST_WALL_M = 3.9, DOWN_FLOOR_M = 1.2 / Math.SQRT1_2
const PATTERN = { channels: 3, horizontalSamples: 181, horizontalFovDeg: 180, verticalFovDeg: [-45, 45] as [number, number], rangeM: 20 }

function readNpy(path: string) {
  const buffer = readFileSync(path)
  const major = buffer.readUInt8(6)
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8)
  const dataOffset = (major === 1 ? 10 : 12) + headerLength
  const header = buffer.subarray(major === 1 ? 10 : 12, dataOffset).toString('latin1')
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? ''
  const shape = (/ 'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number)
  const count = shape.reduce((a: number, b: number) => a * b, 1)
  const value = (index: number): number | boolean => {
    if (descr.includes('b1')) return Boolean(buffer.readUInt8(dataOffset + index))
    if (descr.includes('f8')) return buffer.readDoubleLE(dataOffset + index * 8)
    if (descr.includes('f4')) return buffer.readFloatLE(dataOffset + index * 4)
    return buffer.readInt32LE(dataOffset + index * 4)
  }
  return { shape, count, descr, value, at: (row: number, col: number) => value(row * shape[1]! + col) }
}

function decodePng(buffer: Buffer) {
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 3, pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) { assert.equal(raw[y * (stride + 1)], 0, '仅支持 filter 0'); raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride) }
  return { width, height, rgb: (x: number, y: number): [number, number, number] => [pixels[(y * width + x) * 3]!, pixels[(y * width + x) * 3 + 1]!, pixels[(y * width + x) * 3 + 2]!] }
}

const cameraName = (list: any, local: string) => {
  const row = list.cameras.find((c: any) => c.localName === local)
  assert.ok(row, `相机 ${local} 必须来自真实 camera_list`)
  return row.cameraName
}

describe('P7A 模拟LiDAR', () => {
  test('已知几何逐射线核对：单位/量程/有效性/命中geom/HTML复算', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(), { ground: false, worldId: 'p7a-lidar-geometry' })
    try {
      const list = await provider.listCameras(handle.worldId) as any
      const scan = await provider.scanLidar!(handle.worldId, { outputDir: outDir, cameraName: cameraName(list, '扫描机位'), ...PATTERN }) as any

      assert.equal(scan.source, 'mujoco-mj_multiRay')
      assert.equal(scan.sensorKind, 'simulated-lidar')
      assert.equal(scan.geometrySource, 'mujoco-compiled-geoms')
      assert.equal(scan.selfExclusion, 'sensor-parent-body-only')
      assert.equal(scan.rangeSemantics, 'euclidean-range-meters-along-ray')
      assert.equal(scan.rayPattern.units, 'm')
      assert.equal(scan.rayCount, 3 * 181)
      assert.equal(scan.validCount + scan.noReturnCount, scan.rayCount)
      assert.ok(Number.isFinite(scan.rangeMinM) && Number.isFinite(scan.rangeMaxM) && Number.isFinite(scan.rangeMeanM))
      assert.deepEqual(JSON.parse(JSON.stringify(scan)), scan, '回执必须是严格 JSON（无 NaN/Infinity）')

      // 方位序列：-90..+90，列 90 = 正前(+Y)，列 180 = 正右(+X)。
      const ranges = readNpy(decodeURIComponent(new URL(scan.range.uri).pathname))
      assert.deepEqual(ranges.shape, [3, 181])
      assert.ok(near(Number(ranges.at(1, 90)), LEVEL_WALL_M, 0.05), `正前射线应为北墙 8.9m，实际 ${ranges.at(1, 90)}`)
      assert.ok(near(Number(ranges.at(1, 180)), EAST_WALL_M, 0.05), `正右射线应为东墙 3.9m，实际 ${ranges.at(1, 180)}`)
      assert.ok(near(Number(ranges.at(0, 90)), DOWN_FLOOR_M, 0.05), `-45° 射线应打到地面 ${DOWN_FLOOR_M.toFixed(3)}m，实际 ${ranges.at(0, 90)}`)
      assert.ok(Number.isNaN(Number(ranges.at(2, 90))), '+45° 朝上应无返回并写 NaN')
      assert.ok(Number.isNaN(Number(ranges.at(1, 0))), '正左(+? 西)方向无墙应无返回并写 NaN')

      const valid = readNpy(decodeURIComponent(new URL(scan.valid.uri).pathname))
      assert.equal(valid.at(1, 90), true)
      assert.equal(valid.at(2, 90), false)
      assert.equal(valid.at(1, 0), false)
      let validCount = 0
      for (let i = 0; i < valid.count; i++) if (valid.value(i) === true) validCount++
      assert.equal(validCount, scan.validCount, 'validCount 必须与 valid.npy 逐格一致')
      const hit = readNpy(decodeURIComponent(new URL(scan.hitGeom.uri).pathname))
      assert.match(String(scan.hitGeom.geomIds[String(hit.at(1, 90))]), /wall-n/, '几何来源名必须来自真实编译模型的北墙 geom')

      // 预览 PNG 必须能由 range.npy + metadata 的 colorRule 复算（t=range/rangeM）。
      const preview = decodePng(readFileSync(decodeURIComponent(new URL(scan.preview.uri).pathname)))
      assert.equal(preview.width, 181); assert.equal(preview.height, 3)
      const t = LEVEL_WALL_M / PATTERN.rangeM
      assert.deepEqual(preview.rgb(90, 1), [Math.round(255 * t), Math.round(255 * (1 - t)), 64])
      assert.deepEqual(preview.rgb(90, 2), [0, 0, 0], '无返回像素按规则为黑')
      assert.ok(statSync(decodeURIComponent(new URL(scan.range.uri).pathname)).size > 100)

      // 量程裁剪：把 rangeM 收到 2m，超量程的墙必须变成无返回，而 1.697m 的地面仍有效。
      const clipped = await provider.scanLidar!(handle.worldId, { outputDir: outDir, cameraName: cameraName(list, '扫描机位'), ...PATTERN, rangeM: 2 }) as any
      const clippedRanges = readNpy(decodeURIComponent(new URL(clipped.range.uri).pathname))
      assert.ok(Number.isNaN(Number(clippedRanges.at(1, 90))), '8.9m 墙在 2m 量程内必须无返回')
      assert.ok(Number.isNaN(Number(clippedRanges.at(1, 180))), '3.9m 墙在 2m 量程内必须无返回')
      assert.ok(near(Number(clippedRanges.at(0, 90)), DOWN_FLOOR_M, 0.05), '1.697m 地面仍在量程内')
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })

  test('相机Depth与LiDAR range同几何两来源：光轴处数值一致、语义分开', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(), { ground: false, worldId: 'p7a-lidar-compare', clock: 'manual' })
    try {
      const list = await provider.listCameras(handle.worldId) as any
      const scan = await provider.scanLidar!(handle.worldId, { outputDir: outDir, cameraName: cameraName(list, '扫描机位'), ...PATTERN }) as any
      const capture = await provider.captureMulti(handle.worldId, { outputDir: outDir, cameraNames: [cameraName(list, '扫描机位')], width: 320, height: 240 }) as any
      assert.equal(capture.stepIndex, scan.stepIndex, '同一物理步内 LiDAR 与 RGB-D 不推进物理钟')
      const intrinsics = capture.cameras[0].calibration.intrinsics
      const pixel: [number, number] = [Math.round(intrinsics.cx), Math.round(intrinsics.cy)]
      // 相机侧：主点像素 + 真实渲染深度（走产品 projectAnnotation，不手搓 npy）→ 世界点。
      const cameraPoint = await provider.projectAnnotation(handle.worldId, { cameraName: cameraName(list, '扫描机位'), pixel, captureId: capture.captureId }) as any
      // LiDAR 侧：传感器 pose + 沿光轴射线的真实 range → 同一世界点。
      const lidarLevel = Number(readNpy(decodeURIComponent(new URL(scan.range.uri).pathname)).at(1, 90))
      const position = scan.worldFromSensor.positionM, rotation = scan.worldFromSensor.rotationMatrix
      const forward = [-rotation[0][2], -rotation[1][2], -rotation[2][2]]
      const lidarPoint = forward.map((axis: number, index: number) => position[index] + axis * lidarLevel)
      assert.ok(near(lidarLevel, LEVEL_WALL_M, 0.05), `光轴射线应为北墙 8.9m，实际 ${lidarLevel}`)
      assert.ok(near(cameraPoint.worldPointM[1], 5.9, 0.2), `主点像素相机深度应落北墙面 y=5.9：${JSON.stringify(cameraPoint.worldPointM)}`)
      assert.ok(cameraPoint.worldPointM.every((value: number, index: number) => near(value, lidarPoint[index]!, 0.25)),
        `相机Depth世界点与LiDAR range世界点应同几何：${JSON.stringify(cameraPoint.worldPointM)} vs ${JSON.stringify(lidarPoint)}`)
      assert.ok(near(cameraPoint.depthM, lidarLevel, 0.25), `同像素相机轴向 depth 与 LiDAR range 数值一致：${cameraPoint.depthM} vs ${lidarLevel}`)
      assert.equal(scan.cameraDepthComparison.includes('axial Z'), true, '回执必须显式区分相机Z深度与射线range')
      assert.notEqual(scan.rangeSemantics, 'axial', '不能把 LiDAR range 改名成相机 depth')
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })

  test('挂载相机随父body真实运动、同一机位读数改变，过期代次结构化拒绝', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(), { ground: false, worldId: 'p7a-lidar-motion' })
    try {
      const list = await provider.listCameras(handle.worldId) as any
      const name = cameraName(list, 'cam_fall')
      const addr = { outputDir: outDir, cameraName: name, channels: 2, horizontalSamples: 1, horizontalFovDeg: 180, verticalFovDeg: [-90, 0] as [number, number], rangeM: 20 }
      const before = await provider.scanLidar!(handle.worldId, addr) as any
      const beforeRange = Number(readNpy(decodeURIComponent(new URL(before.range.uri).pathname)).at(0, 0))
      await new Promise(r => setTimeout(r, 1600))
      const after = await provider.scanLidar!(handle.worldId, addr) as any
      const afterRange = Number(readNpy(decodeURIComponent(new URL(after.range.uri).pathname)).at(0, 0))
      assert.ok(after.stepIndex > before.stepIndex, `物理钟应真实推进: ${before.stepIndex} → ${after.stepIndex}`)
      assert.ok(before.parentBodyName.startsWith('faller-l/'), `传感器必须挂在真实连杆: ${before.parentBodyName}`)
      assert.ok(afterRange < beforeRange - 0.3, `落体下降后地面 range 应变小: ${beforeRange} → ${afterRange}`)
      // 真换代（sync 重建）后旧 expectedGeneration 必须结构化拒绝，新代次可继续量测。
      const reset = await provider.sync(handle.worldId, buildScene(), { forceRebuild: true }) as any
      assert.ok(reset.worldGeneration > after.generation, `sync 应推进世界代次: ${after.generation} → ${reset.worldGeneration}`)
      await assert.rejects(provider.scanLidar!(handle.worldId, { ...addr, expectedGeneration: after.generation }), /STALE_GENERATION/)
      const fresh = await provider.scanLidar!(handle.worldId, { ...addr, expectedGeneration: reset.worldGeneration }) as any
      assert.equal(fresh.generation, reset.worldGeneration)
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })
})
