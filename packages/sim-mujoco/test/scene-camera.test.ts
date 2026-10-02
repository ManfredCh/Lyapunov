/**
 * Scene 声明的相机（components.camera）进 MuJoCo 命名相机族的真实行为测试。
 *
 * 运行：
 *   node --experimental-transform-types --test packages/sim-mujoco/test/scene-camera.test.ts
 *   （必须开 transform-types：sim-contract/src/python-transport.ts 用了 TypeScript 参数属性，node 24
 *     的 strip-only 模式直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；这是本仓库 node 版本的既有约束。）
 *   解释器：LYAPUNOV_MUJOCO_PYTHON（未设时用仓库内 .runtime/sim-python/bin/python）；没有解释器时
 *   整份测试显式 skip 并说明原因，不假装通过。
 *
 * 覆盖面（全部走产品 MuJoCoProvider：open → listCameras → captureMulti → capture → adjustCamera →
 * projectAnnotation，不直接调 python）：
 *  - 注册与来源：Scene 相机以 `entityId/实体名` 进引擎、cameraSource/cameraSource 属主字段可核对；
 *    实体自带 MJCF 相机原样保留；同名冲突时保留原件并登记结构化告警，不覆盖不串台；
 *    跨实体的同名局部名按歧义拒绝；direction 兜底取景、逐台 fovy。
 *  - 物理推进：父实体相机随父 body 真实 FK 运动（相机 z 跟着落块下落），不是静态装在世界系。
 *  - 真实帧：RGB 是引擎输出的 PNG（本文件自己 inflate 解码逐像素看），深度是真实米制
 *    distance_to_image_plane（npy），中心像素/地面剖线/墙上沿之上/视场覆盖率都由透视几何独立算出，
 *    与相机标定（生效 K）同一步；父实体相机的安装偏移与同一回执里的 observation 实体位姿
 *    逐项闭合（1e-6），标定与帧同 generation/stepIndex。
 *  - 声明 K（fx≠fy 非方形像素 + 偏心主点）：按引擎内参口径（resolution/sensorsize/focalpixel/
 *    principalpixel）真的装进渲染，生效 K 与声明逐项一致（1e-3 px），并与声明 fovDeg 做交叉核对
 *    （不一致登记 SCENE_CAMERA_FOV_INTRINSICS_MISMATCH，不静默二选一）；fovy 相机不受影响。
 *    逐像素回归验证（标记点拟合实测 fx/fy/cx/cy、主点符号、多分辨率对应、反投影闭合）在
 *    camera-intrinsics.test.ts 里。
 *  - 相机移动：world 参考系平移后位姿/像素/世界点都变，同一个世界物体（立柱）落到不同像素，
 *    该像素的深度与反投影世界点与几何预测一致；clear 回到 Scene 声明位姿。
 *
 * 诚实边界：
 *  - 本文件自带最小合成场景（几何尺寸已知，便于逐像素核对），**不是**用户真实资产；
 *    真实 48 院落资产的相机清单/单帧核对由任务目录 tools/real_scene_camera_list.ts 另跑一次。
 *  - 不覆盖 MJCF 相机的原生语义（mode/orthographic/sensorSize）——那是既有 native 路径，本任务只保证
 *    不被 Scene 相机覆盖或同名串台（同名冲突用例在这里）。
 *  - 不覆盖 Isaac 侧的相机装配；Isaac 的相机路径在当前轮次按协调文件延后到独立验收。
 *  - 不覆盖 viewer/截图路径：本文件断言的是引擎相机帧，与 3D 视口截图无关。
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
const outDir = resolve(tmpdir(), `w81-scene-camera-${process.pid}`)
after(() => rmSync(outDir, { recursive: true, force: true }))
const width = 640, height = 480
const cx = Math.floor(width / 2), cy = Math.floor(height / 2)
/** 世界 +Y 平视时唯一确定的世界旋转（绕 +X 转 +90°：-Z → +Y），独立于 worker 的写法。 */
const LOOK_PLUS_Y = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
const LOOK_QUAT_XYZW: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const rowsClose = (a: number[][], b: number[][], tol: number) => a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= tol))
const lookDirection = (r: number[][]) => [-r[0][2], -r[1][2], -r[2][2]]

/** 合成场景：地面 z=0、北墙近面 y=5.9、+X 侧立柱 x=3，落块（动态）从 z=2 落下。 */
function buildScene() {
  const entity = (entityId: string, name: string, position: [number, number, number], quaternion: [number, number, number, number], components: any, parentId?: string) =>
    ({ entityId, name, transform: { position, quaternion, scale: [1, 1, 1] as [number, number, number] }, resources: [], components, ...(parentId ? { parentId } : {}) })
  const mjcf = (xml: string) => ({ mujoco: { xml } })
  return {
    sceneId: 'scene-81-camera-test', revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' } as const,
    entities: [
      entity('floor-t', '地面', [0, 0, -0.05], [0, 0, 0, 1], { collision: { type: 'box', halfExtents: [8, 8, 0.05], source: 'scene-camera-test' } }),
      entity('wall-t', '北墙', [0, 6, 1.5], [0, 0, 0, 1], { collision: { type: 'box', halfExtents: [8, 0.1, 1.5], source: 'scene-camera-test' } }),
      entity('pillar-t', '东柱', [3, 4, 1.5], [0, 0, 0, 1], { collision: { type: 'cylinder', halfExtents: [0.2, 1.5, 0.2], source: 'scene-camera-test' } }),
      // 落块偏到 x=1.5：仍在两台朝 +Y 的相机取景内，但不占中心列（中心列要留给"墙/背景"判据）。
      entity('faller-t', '落块', [1.5, 4, 2], [0, 0, 0, 1], { rigidBody: { type: 'dynamic', massKg: 1 }, collision: { type: 'box', halfExtents: [0.25, 0.25, 0.25], source: 'scene-camera-test' } }),
      entity('cam-free-t', 'cam_free', [0, -3, 1.2], LOOK_QUAT_XYZW, { camera: { lensMm: 35, sensorWidthMm: 36, fovYDeg: 45, direction: [0, 1, 0], isActive: true } }),
      entity('cam-narrow-t', 'cam_free_narrow', [0, -3, 1.2], LOOK_QUAT_XYZW, { camera: { fovYDeg: 20, direction: [0, 1, 0], isActive: false } }),
      entity('cam-follow-t', 'cam_on_faller', [0, 0, 0.35], LOOK_QUAT_XYZW, { camera: { fovYDeg: 60, direction: [0, 1, 0], isActive: false } }, 'faller-t'),
      // TRS 是单位旋转（没有实质朝向）→ 必须按 direction 取景，而不是把相机朝 -Z 装上去。
      entity('cam-dir-t', 'cam_direction_only', [0, -3, 1.2], [0, 0, 0, 1], { camera: { fovYDeg: 45, direction: [0, 1, 0], isActive: false } }),
      // 用户原件自带的 MJCF 相机：另一实体、另一名字，必须原样保留。
      entity('robot-t', '机械臂', [0, 0, 0], [0, 0, 0, 1], mjcf('<mujoco><worldbody><body name="mount" pos="2 2 0.2">' +
        '<geom name="base" type="box" size="0.1 0.1 0.1"/><camera name="cam_head" pos="0.2 0 0.5" fovy="30"/></body></worldbody></mujoco>')),
      // 跨实体同名局部名：另一实体的 Scene 相机也叫 cam_head → 裸名字必须按歧义拒绝，不串台。
      entity('cam-head-t', 'cam_head', [0, -3, 1.2], LOOK_QUAT_XYZW, { camera: { fovYDeg: 50, direction: [0, 1, 0], isActive: false } }),
      // 同一实体的实体名与自带 MJCF 相机同名：Scene 声明必须让位给原件并登记冲突告警。
      entity('wrist-t', 'wrist_cam', [0, 0, 0], [0, 0, 0, 1], {
        ...mjcf('<mujoco><worldbody><body name="mount" pos="-2 2 0.2"><geom name="base" type="box" size="0.1 0.1 0.1"/>' +
          '<camera name="wrist_cam" pos="0 0 0.4" fovy="30"/></body></worldbody></mujoco>'),
        camera: { fovYDeg: 70, direction: [0, 1, 0], isActive: false },
      }),
      // 66 的 Scene 命名相机：state 存的是**保存时的世界位姿**与画布 K；第 2 台没有四元数，
      // 只有 position→target，必须标成 viewer-camera-target 而不是猜朝向。
      entity('viewer-t', '命名相机', [0, 0, 0], [0, 0, 0, 1], {
        viewerCamera: { cameras: [
          { name: 'photo-A', savedAt: '2026-09-20T05:00:00.000Z', state: {
            position: [0.5, -3, 1.6], quaternion: LOOK_QUAT_XYZW, target: [0.5, 0, 1.6], up: [0, 0, 1],
            fovDeg: 40, near: 0.01, far: 5000, intrinsics: { fx: 800, fy: 900, cx: 320, cy: 240, width: 640, height: 480 } } },
          { name: 'photo-target-only', savedAt: '2026-09-20T05:01:00.000Z', state: {
            position: [0, -3, 1.2], target: [0, 3, 1.2], up: [0, 0, 1], fovDeg: 30, near: 0.1, far: 100 } },
        ] },
      }),
    ],
  }
}

describe('Scene 相机', () => {
test('Scene 相机进引擎：注册/来源/命名/共存', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const handle = await provider.open(buildScene(), { ground: false, worldId: 'w81-scene-camera-test' })
  try {
  const list = await provider.listCameras(handle.worldId) as any
  const byLocal = (local: string) => list.cameras.filter((c: any) => c.localName === local)
  const one = (local: string) => byLocal(local)[0]
  const sceneCameras = list.cameras.filter((c: any) => c.cameraSource === 'scene-camera')

  assert.equal(sceneCameras.length, 7, `Scene 声明 8 台（6 台 components.camera + 2 台命名相机）、其中 1 台（wrist-t）因与原件同名让位，实际 ${JSON.stringify(list.cameras.map((c: any) => c.cameraName))}`)
  assert.ok(sceneCameras.every((c: any) => c.cameraName === c.entityId + '/' + c.localName), '引擎名必须是 entityId/实体名')
  const free = one('cam_free')
  assert.equal(free.entityId, 'cam-free-t')
  assert.equal(free.sceneActive, true)
  assert.equal(free.declaredLensMm, 35)
  assert.equal(free.declaredSensorWidthMm, 36)
  assert.ok(rowsClose(free.worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-6))
  assert.deepEqual(free.worldFromCamera.positionM.map((v: number) => +v.toFixed(9)), [0, -3, 1.2])
  assert.equal(one('cam_direction_only').orientationSource, 'direction')
  assert.ok(rowsClose(one('cam_direction_only').worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-6))
  assert.deepEqual([free, one('cam_free_narrow'), one('cam_on_faller'), one('cam_direction_only')].map((c: any) => c.fovyDeg), [45, 20, 60, 45])

  // 用户原件：原生 MJCF 相机仍在，视场是它自己的 30°，父体是源件里的 mount。
  const native = list.cameras.find((c: any) => c.cameraName === 'robot-t/cam_head')
  assert.equal(native?.cameraSource, 'mjcf')
  assert.ok(near(native.fovyDeg, 30, 1e-9))
  assert.ok(String(native.parentBodyName).startsWith('robot-t/'))
  // 同名冲突：原件保留（fovy 30），Scene 声明未进引擎且有结构化告警。
  const conflict = (handle as any).warnings.filter((w: any) => w.code === 'SCENE_CAMERA_NAME_CONFLICT')
  assert.deepEqual(conflict.map((w: any) => w.entityId), ['wrist-t'])
  assert.equal(list.cameras.filter((c: any) => c.cameraName === 'wrist-t/wrist_cam').length, 1)
  assert.ok(near(list.cameras.find((c: any) => c.cameraName === 'wrist-t/wrist_cam').fovyDeg, 30, 1e-9))
  // 跨实体同名局部名：两台都在（各带实体前缀、来源不同），裸名字必须按歧义拒绝；带前缀的名字照常可用。
  assert.equal(byLocal('cam_head').length, 2)
  assert.equal(new Set(byLocal('cam_head').map((c: any) => c.cameraSource)).size, 2)
  await assert.rejects(provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam_head', width: 64, height: 64 }),
    (error: any) => String(error.code).includes('AMBIGUOUS'))
  const qualified = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-head-t/cam_head', width: 64, height: 64 }) as any
  assert.equal(qualified.resolvedCameraName, 'cam-head-t/cam_head')
  } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
})

test('挂载相机随父实体真实运动（物理推进后）', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
  const provider = new MuJoCoProvider({ pythonPath: python })
  const handle = await provider.open(buildScene(), { ground: false, worldId: 'w81-scene-camera-follow' })
  try {
  const before = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'cam-follow-t/cam_on_faller')
  await new Promise(r => setTimeout(r, 1600))
  const after = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'cam-follow-t/cam_on_faller')
  assert.ok(String(before.parentBodyName).startsWith('faller-t/'), `挂载点是父实体的物理体: ${before.parentBodyName}`)
  assert.ok(after.worldFromCamera.positionM[2] < before.worldFromCamera.positionM[2] - 0.5,
    `相机应随落块下落: ${before.worldFromCamera.positionM[2]} → ${after.worldFromCamera.positionM[2]}`)
  assert.ok(rowsClose(after.worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-6), '自由落体不改变朝向')
  } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
})

test('真实 RGB/米制深度帧：几何、标定与同一物理步', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const handle = await provider.open(buildScene(), { ground: false, worldId: 'w81-scene-camera-frames' })
  try {
  const multi = await provider.captureMulti(handle.worldId, { outputDir: outDir, cameraNames: ['cam_free', 'cam_free_narrow', 'cam_on_faller'], width, height }) as any
  const entry = (name: string) => multi.cameras.find((c: any) => c.cameraName === name)
  assert.equal(multi.cameras.length, 3)
  assert.ok(multi.cameras.every((c: any) => c.worldGeneration === multi.generation && c.calibration.intrinsics.width === width))
  assert.equal(multi.observation.stepIndex, multi.stepIndex, '标定、帧与 observation 必须同一步')

  const colorCounts: Record<string, number> = {}
  for (const camera of multi.cameras) {
    const path = decodeURIComponent(new URL(camera.rgb.uri).pathname)
    const decoded = decodePng(readFileSync(path))
    const cal = camera.calibration.intrinsics
    colorCounts[camera.cameraName] = decoded.distinctColors
    assert.equal(decoded.width, width)
    assert.equal(decoded.height, height)
    assert.ok(statSync(path).size > 1000, 'PNG 必须是真实编码图像')
    // 单色占位图只有 1 色；平墙面朝墙的视角颜色本来就少（实测 4 色），所以逐台只要求"确实分了区域"，
    // 场景级再要求至少一台是真正多色的画面。
    assert.ok(decoded.distinctColors >= 3, `${camera.cameraName} 不像真实渲染: ${decoded.distinctColors} 色`)
    assert.ok(near(cal.fy, height / (2 * Math.tan((cal.fovyDeg * Math.PI / 180) / 2)), 1e-9), 'fy 必须由 fovy 与高度唯一确定')
    assert.equal(cal.fx, cal.fy)
    assert.ok(near(cal.cx, (width - 1) / 2, 1e-9) && near(cal.cy, (height - 1) / 2, 1e-9))
  }
  assert.ok(Math.max(...Object.values(colorCounts)) > 20, `至少一台应是多色真实画面: ${JSON.stringify(colorCounts)}`)

  const free = entry('cam_free')
  const depth = readDepth(decodeURIComponent(new URL(free.depth.uri).pathname), width, height)
  // 平视 +Y：中心像素打在 y=5.9 的墙面上，相机 y=-3 → 轴向深度 8.9 m。
  assert.ok(near(depth.at(cx, cy), 8.9, 0.15), `中心像素深度 ${depth.at(cx, cy)} 应为墙面 8.9 m`)
  // 地面剖线：高 1.2 m 的水平视轴下，第 v 行的地面轴向深度 = 1.2·fy/(v-cy)。
  for (const v of [360, 400, 460]) {
    assert.ok(near(depth.at(cx, v), 1.2 * free.calibration.intrinsics.fy / (v - cy), 0.05), `v=${v} 地面深度`)
  }
  // 画面 v 越小越高（世界 +Z 朝上）：墙上沿之上是背景，不是翻转的截图。
  assert.ok(depth.at(cx, 100) > 20, `墙上沿之上应是背景深度，实际 ${depth.at(cx, 100)}`)
  // +X 在画面右侧：世界 x=3 的立柱落在 u>cx，该像素是立柱近表面而不是 8.9 m 的墙。
  const pillarU = 575, pillarV = 340
  const pillar = await provider.projectAnnotation(handle.worldId, { cameraName: 'cam_free', pixel: [pillarU, pillarV], depthM: depth.at(pillarU, pillarV), captureId: multi.captureId }) as any
  assert.ok(pillarU > cx && near(pillar.worldPointM[0], 3.0, 0.25) && depth.at(pillarU, pillarV) > 6.2 && depth.at(pillarU, pillarV) < 7.2,
    `立柱像素 (${pillarU},${pillarV}) 深度 ${depth.at(pillarU, pillarV)} → 世界点 ${JSON.stringify(pillar.worldPointM)}`)
  // 视场：同机位 45° 在 (cx,100) 越墙见背景，20° 同像素仍在墙上——视场真的不同，不是只改标定字段。
  const narrow = readDepth(decodeURIComponent(new URL(entry('cam_free_narrow').depth.uri).pathname), width, height)
  assert.ok(near(narrow.at(cx, cy), depth.at(cx, cy), 0.02) && near(narrow.at(cx, 100), 8.9, 0.15) && depth.at(cx, 100) > 20,
    `视场覆盖差异: wide(cx,100)=${depth.at(cx, 100)} narrow(cx,100)=${narrow.at(cx, 100)}`)

  // 挂载相机：与同一回执里的父实体位姿逐项闭合，且它真的从该位姿看到墙。
  const follow = entry('cam_on_faller')
  const followDepth = readDepth(decodeURIComponent(new URL(follow.depth.uri).pathname), width, height)
  const parent = multi.observation.entities.find((e: any) => e.entityId === 'faller-t').transform
  const rotation = quatMatrixXYZW(parent.quaternion)
  const local = [0, 0, 0.35]
  const expectedPosition = local.map((_, i) => parent.position[i] + rotation[i].reduce((sum, v, k) => sum + v * local[k], 0))
  assert.ok(follow.calibration.worldFromCamera.positionM.every((v: number, i: number) => near(v, expectedPosition[i], 1e-6)),
    `安装偏移必须与同一步父体位姿闭合: ${follow.calibration.worldFromCamera.positionM} vs ${expectedPosition}`)
  assert.ok(rowsClose(follow.calibration.worldFromCamera.rotationMatrix, matMul(rotation, LOOK_PLUS_Y), 1e-6))
  assert.ok(near(followDepth.at(cx, cy), 5.9 - follow.calibration.worldFromCamera.positionM[1], 0.15))
  const annotation = await provider.projectAnnotation(handle.worldId, { cameraName: 'cam_on_faller', pixel: [cx, cy], depthM: followDepth.at(cx, cy), captureId: multi.captureId }) as any
  assert.ok(near(annotation.worldPointM[1], 5.9, 0.15) && annotation.stepIndex === multi.stepIndex && annotation.generation === multi.generation)
  } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
})

test('相机移动：位姿/画面/世界点一起变，clear 回到 Scene 声明位姿', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const handle = await provider.open(buildScene(), { ground: false, worldId: 'w81-scene-camera-move' })
  try {
  const before = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam_free', width, height }) as any
  const beforeDepth = readDepth(decodeURIComponent(new URL(before.depth.uri).pathname), width, height)
  const adjust = await provider.adjustCamera(handle.worldId, { cameraName: 'cam_free', expectedGeneration: before.generation, referenceFrame: 'world', positionM: [0.5, -3, 1.2] }) as any
  const moved = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam_free', width, height }) as any
  const movedDepth = readDepth(decodeURIComponent(new URL(moved.depth.uri).pathname), width, height)
  assert.equal(adjust.override, true)
  assert.ok(near(moved.calibration.worldFromCamera.positionM[0], 0.5, 1e-9))
  const diff = decodePng(readFileSync(decodeURIComponent(new URL(moved.rgb.uri).pathname)))
    .pixelDiff(decodePng(readFileSync(decodeURIComponent(new URL(before.rgb.uri).pathname))))
  assert.ok(diff > 0.002, `移动后必须是新渲染: meanAbsDiff=${diff}`)
  // 同一个世界物体（x=3 的立柱）落到不同像素：相机沿 +X 挪 0.5 m 后它在原像素左侧，
  // 而原位姿在 u=526 看到的是更远的地面。
  const u = 526
  const movedPoint = await provider.projectAnnotation(handle.worldId, { cameraName: 'cam_free', pixel: [u, 340], depthM: movedDepth.at(u, 340), captureId: moved.captureId }) as any
  assert.ok(near(movedDepth.at(u, 340), 6.8, 0.15) && beforeDepth.at(u, 340) > movedDepth.at(u, 340) + 0.05 && near(movedPoint.worldPointM[0], 3.0, 0.25),
    `u=${u}: moved=${movedDepth.at(u, 340)} before=${beforeDepth.at(u, 340)} worldX=${movedPoint.worldPointM[0]}`)
  const cleared = await provider.adjustCamera(handle.worldId, { cameraName: 'cam_free', expectedGeneration: moved.generation, clear: true }) as any
  const restored = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'cam-free-t/cam_free')
  assert.equal(cleared.cleared, true)
  assert.equal(restored.override, false)
  assert.ok(near(restored.fovyDeg, 45, 1e-9) && near(restored.worldFromCamera.positionM[0], 0, 1e-9))
  } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
})

test('66 命名相机（components.viewerCamera）进引擎：世界位姿/视场/K 回显/真实帧', { skip: available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`, timeout: 60_000 }, async () => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const handle = await provider.open(buildScene(), { ground: false, worldId: 'w81-scene-viewer-camera' })
  try {
  const list = await provider.listCameras(handle.worldId) as any
  const photo = list.cameras.find((c: any) => c.cameraName === 'viewer-t/photo-A')
  const targetOnly = list.cameras.find((c: any) => c.cameraName === 'viewer-t/photo-target-only')

  // 声明 → 引擎：来源标成 viewerCamera，视场取 state.fovDeg，世界位姿取 state（不是实体 TRS）。
  assert.equal(photo.cameraSource, 'scene-camera')
  assert.equal(photo.cameraComponent, 'viewerCamera')
  assert.equal(photo.orientationSource, 'viewer-camera')
  assert.equal(photo.sceneActive, undefined, '命名相机没有 isActive 这个概念，不该编一个出来')
  // 同时声明了 K 与 fovDeg 时按 K 装配（K 更严格：还定主点与像素长宽比），fovyDeg 因此是 K 派生的
  // 2·atan(480/1800)=29.8628°，不是声明里的 40°；两份不一致必须显式告警而不是静默二选一。
  assert.equal(photo.intrinsicsSource, 'engine-intrinsics')
  // 容差 1e-4°：内参在 model.cam_intrinsic 里是 float32 米制存储，回读换算成像素有 ~1e-7 相对误差（≈5e-5 px），
  // 报的是引擎实际使用的值，不是把声明值原样回抄。
  const kFovy = 2 * Math.atan(480 / (2 * 900)) * 180 / Math.PI
  assert.ok(near(photo.fovyDeg, kFovy, 1e-4), `K 派生的竖直视场: ${photo.fovyDeg}`)
  assert.ok(near(targetOnly.fovyDeg, 30, 1e-9), '没有 K 的命名相机仍按声明的 fovDeg 装配')
  assert.deepEqual(photo.worldFromCamera.positionM.map((v: number) => +v.toFixed(9)), [0.5, -3, 1.6])
  assert.ok(rowsClose(photo.worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-9), 'state 的四元数就是相机世界朝向')
  // 源件声明原样回显（供核对）：near/far/K；真正生效的 K 另在 appliedIntrinsicsPx/intrinsics 里。
  assert.equal(photo.declaredNearM, 0.01)
  assert.equal(photo.declaredFarM, 5000)
  assert.deepEqual(photo.declaredIntrinsicsPx, { fx: 800, fy: 900, cx: 320, cy: 240, width: 640, height: 480 })
  assert.deepEqual(photo.appliedIntrinsicsPx, { fx: 800, fy: 900, cx: 320, cy: 240, width: 640, height: 480 }, '声明的 K 必须原样装进引擎')
  const mismatch = (handle as any).warnings.filter((w: any) => w.code === 'SCENE_CAMERA_FOV_INTRINSICS_MISMATCH')
  assert.deepEqual(mismatch.map((w: any) => w.entityId), ['viewer-t'])
  assert.equal((handle as any).warnings.some((w: any) => w.code === 'SCENE_CAMERA_SQUARE_PIXEL_APPROX'), false,
    'fx≠fy 不再被折成方形像素（旧告警必须消失）')
  // 没有四元数的命名相机：按 position→target 取景并标明来源，不静默落到实体 TRS。
  assert.equal(targetOnly.orientationSource, 'viewer-camera-target')
  assert.ok(rowsClose(targetOnly.worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-9))
  assert.deepEqual(targetOnly.worldFromCamera.positionM.map((v: number) => +v.toFixed(9)), [0, -3, 1.2])

  // 真实帧：命名相机走的是与原生相机同一条采集/标定路径（局部名简写即可解析）。
  const capture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'photo-A', width, height }) as any
  assert.equal(capture.resolvedCameraName, 'viewer-t/photo-A')
  const cal = capture.calibration.intrinsics
  const image = decodePng(readFileSync(decodeURIComponent(new URL(capture.rgb.uri).pathname)))
  assert.ok(image.distinctColors >= 3 && image.width === width && image.height === height, `命名相机的帧必须是真的: ${image.distinctColors} 色`)
  // 本次输出分辨率正好等于声明的 K 分辨率，所以生效 K 必须逐项等于声明的 K：
  // 非方形像素（fx≠fy）与偏心主点都必须真的传到渲染，而不是被折成 fx=fy + 画面居中。
  assert.equal(capture.calibration.intrinsicsSource, 'engine-intrinsics')
  assert.ok(near(cal.fx, 800, 1e-3) && near(cal.fy, 900, 1e-3), `非方形像素必须生效: fx=${cal.fx} fy=${cal.fy}`)
  assert.ok(near(cal.cx, 320, 1e-3) && near(cal.cy, 240, 1e-3), `偏心主点必须生效: cx=${cal.cx} cy=${cal.cy}`)
  assert.ok(Math.abs(cal.pixelAspectRatio - 800 / 900) < 1e-6, '像素长宽比要与声明一致')
  assert.equal(cal.distortionModeled, false, 'MuJoCo 没有畸变模型，必须如实标注未建模')
  assert.ok(near(cal.fovyDeg, kFovy, 1e-4))
  assert.ok(capture.calibration.worldFromCamera.positionM.every((v: number, i: number) => near(v, [0.5, -3, 1.6][i], 1e-6)),
    `帧的标定位姿必须就是声明的世界位姿: ${capture.calibration.worldFromCamera.positionM}`)
  const depth = readDepth(decodeURIComponent(new URL(capture.depth.uri).pathname), width, height)
  // 平视 +Y、相机 z=1.6：中心像素 (320,240) 就是声明的偏心主点 → 打在 y=5.9 的墙上 → 8.9 m。
  assert.ok(near(depth.at(cx, cy), 8.9, 0.15), `主点像素深度 ${depth.at(cx, cy)}`)
  // 地面剖线：轴向深度 = 相机高·fy/(v−cy)。fy=900 比旧方像素口径更窄，故取更低的 v 才落在 8.9 m 墙内。
  const floorV = 460
  assert.ok(near(depth.at(cx, floorV), 1.6 * cal.fy / (floorV - cal.cy), 0.05), `地面剖线 v=${floorV}: ${depth.at(cx, floorV)}`)
  const annotation = await provider.projectAnnotation(handle.worldId, { cameraName: 'photo-A', pixel: [cx, floorV], depthM: depth.at(cx, floorV), captureId: capture.captureId }) as any
  assert.ok(near(annotation.worldPointM[2], 0, 0.06) && near(annotation.worldPointM[0], 0.5, 0.01) && near(annotation.worldPointM[1], -3 + depth.at(cx, floorV), 0.06),
    `该像素应落在地面 (0.5, ${-3 + depth.at(cx, floorV)}, 0)：${JSON.stringify(annotation.worldPointM)}`)
  assert.equal(annotation.generation, capture.generation)
  assert.equal(annotation.stepIndex, capture.stepIndex)

  // 命名相机与原生相机同一套 override 路径：改视场→生效→clear 回声明值。
  // 内参相机上 cam_fovy 是惰性派生量（实测改了画面逐像素不变），"只改 FOV"实际落在焦距上：
  // fy' = 480/(2·tan30°) = 415.69、fx' 同比缩放保持像素长宽比，主点不动。
  const adjust = await provider.adjustCamera(handle.worldId, { cameraName: 'viewer-t/photo-A', expectedGeneration: capture.generation, fovyDeg: 60 }) as any
  assert.ok(adjust.override === true && near(adjust.fovyDeg, 60, 1e-9))
  assert.equal(adjust.fovyApplied, 'intrinsic-focal-rescale')
  assert.ok(near(adjust.intrinsicsAtReferenceResolution.fy, 480 / (2 * Math.tan(30 * Math.PI / 180)), 1e-3)
    // fx 与源 fx 同比缩放：判据是**像素长宽比不变**（fx/fy 与调整前逐位一致），不是照抄 800/900 的比值。
    && Math.abs(adjust.intrinsicsAtReferenceResolution.pixelAspectRatio - cal.pixelAspectRatio) < 1e-12
    && near(adjust.intrinsicsAtReferenceResolution.cx, 320, 1e-3), `视场调整后的生效 K: ${JSON.stringify(adjust.intrinsicsAtReferenceResolution)}`)
  const cleared = await provider.adjustCamera(handle.worldId, { cameraName: 'viewer-t/photo-A', expectedGeneration: capture.generation, clear: true }) as any
  const restored = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'viewer-t/photo-A')
  assert.equal(cleared.cleared, true)
  assert.ok(restored.override === false && near(restored.fovyDeg, kFovy, 1e-4)
    && near(restored.worldFromCamera.positionM[0], 0.5, 1e-9), 'clear 必须回到声明的 K 与位姿')
  assert.ok(near(restored.intrinsics.fx, 800, 1e-3) && near(restored.intrinsics.fy, 900, 1e-3), 'clear 后 K 回到声明值')
  } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
})
})

function quatMatrixXYZW(q: number[]): number[][] {
  const [x, y, z, w] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
const matMul = (a: number[][], b: number[][]) => a.map(row => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)))

/** 只认 8bit/colorType 2（RGB，非隔行）的真 PNG——本文件自己 inflate 解码，不靠外部图形库。 */
function decodePng(buffer: Buffer) {
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
  assert.equal(buffer.readUInt8(24), 8)
  assert.equal(buffer.readUInt8(25), 2)
  assert.equal(buffer.readUInt8(28), 0)
  const chunks: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * 3, pixels = Buffer.alloc(stride * height), colors = new Set<number>()
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, '仅支持 filter 0')
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  for (let i = 0; i < pixels.length; i += 3) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2])
  return {
    width, height, pixels, distinctColors: colors.size,
    pixelDiff(other: { pixels: Buffer }) {
      let total = 0
      for (let i = 0; i < pixels.length; i++) total += Math.abs(pixels[i] - other.pixels[i])
      return total / pixels.length / 255
    },
  }
}

/** .npy（C 序 float32 二维）读成可按 (u,v) 取值的米制深度。 */
function readDepth(path: string, width: number, height: number) {
  const buffer = readFileSync(path)
  const major = buffer.readUInt8(6)
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8)
  const dataOffset = (major === 1 ? 10 : 12) + headerLength
  assert.ok(buffer.subarray(major === 1 ? 10 : 12, dataOffset).toString('latin1').includes('f4'))
  assert.equal(buffer.length - dataOffset, width * height * 4)
  return { at: (u: number, v: number) => buffer.readFloatLE(dataOffset + (v * width + u) * 4) }
}

// R015：用户创建的 Scene 相机必须精确绑定实际连杆，与原模型 wrist 相机/site 同帧闭合。
const BODY_MOUNT_POSITION = [0.15, 0, 0.9]
const BODY_MOUNT_QUAT = [0, 0, Math.sin(0.075), Math.cos(0.075)]
const BODY_MOUNT_K = { fx: 230, fy: 270, cx: 146.5, cy: 109.5, width: 320, height: 240 }
const MOVING_CAMERA_XML = readFileSync(resolve(root, 'packages/sim-mujoco/fixtures/moving-cameras.xml'), 'utf8')

function mountedCameraScene(revision = 1): any {
  const transform = (position: number[], yaw = 0) => ({ position, quaternion: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)], scale: [1, 1, 1] })
  return {
    sceneId: 'r015-native-body-camera', revision,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities: [
      ...['a', 'b'].map((suffix, index) => ({
        entityId: `arm-${suffix}`, name: `arm-${suffix}`, transform: transform([index * 2, index * 0.3, 0], index * 0.35),
        resources: [], components: { mujoco: { xml: MOVING_CAMERA_XML } },
      })),
      ...['a', 'b'].map(suffix => ({
        entityId: `sensor-${suffix}`, name: `sensor-${suffix}`, transform: transform([99, 99, 99]), resources: [],
        components: { camera: { name: 'body-view', near: 7, far: 8, intrinsics: { ...BODY_MOUNT_K },
          mount: { entityId: `arm-${suffix}`, bodyName: 'turntable', positionM: [...BODY_MOUNT_POSITION], quaternionXyzw: [...BODY_MOUNT_QUAT] } } },
      })),
    ],
  }
}

function assertBodyMount(row: any, frame: any, suffix: 'a' | 'b') {
  const body = frame.bodies.find((item: any) => item.entityId === `arm-${suffix}` && item.bodyName === 'turntable')
  assert.ok(body, '实际 body 选择项必须来自当前已编译世界')
  assert.equal(row.parentEntityId, `arm-${suffix}`)
  assert.equal(row.parentBodyName, `arm-${suffix}/turntable`)
  assert.equal(row.entityId, `sensor-${suffix}`, '创建的相机实体身份不能变成机器人身份')
  for (const key of ['generation', 'worldGeneration', 'sceneRevision', 'appliedSceneRevision', 'stepIndex', 'frameId']) {
    assert.equal(row[key], frame[key], `相机 ${key} 必须属于当前物理帧`)
    assert.equal(body[key], frame[key], `body ${key} 必须与相机同帧`)
  }
  const parent = body.worldFromBody
  const expectedPosition = parent.positionM.map((value: number, i: number) => value + parent.rotationMatrix[i].reduce((sum: number, v: number, j: number) => sum + v * BODY_MOUNT_POSITION[j], 0))
  const expectedRotation = matMul(parent.rotationMatrix, quatMatrixXYZW(BODY_MOUNT_QUAT))
  assert.ok(row.worldFromCamera.positionM.every((value: number, i: number) => near(value, expectedPosition[i], 1e-9)))
  assert.ok(rowsClose(row.worldFromCamera.rotationMatrix, expectedRotation, 1e-9), 'world camera = 同帧真实 body × 保存的局部标定')
  assert.ok(row.parentFromCamera.positionM.every((value: number, i: number) => near(value, BODY_MOUNT_POSITION[i], 1e-9)))
  assert.ok(rowsClose(row.parentFromCamera.rotationMatrix, quatMatrixXYZW(BODY_MOUNT_QUAT), 1e-9))
}

describe('R015 Scene 相机绑定具体原生 body/link', { skip: !available }, () => {
  test('真实 travel/yaw 后相机随 turntable，两个同名 link 不串台，RGB/深度/标定同帧', { timeout: 120000 }, async t => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(mountedCameraScene(), { ground: false, worldId: 'r015-body-camera', clock: 'manual' })
    try {
      const initial = await provider.listCameras(handle.worldId) as any
      assert.equal(initial.bodies.filter((body: any) => body.bodyName === 'turntable').length, 2)
      const row = (frame: any, suffix: string) => frame.cameras.find((camera: any) => camera.cameraName === `sensor-${suffix}/body-view`)
      assertBodyMount(row(initial, 'a'), initial, 'a')
      assertBodyMount(row(initial, 'b'), initial, 'b')
      assert.equal(row(initial, 'a').declaredNearM, 7)
      assert.equal(row(initial, 'a').declaredFarM, 8)
      assert.equal(row(initial, 'a').clipPlanesSource, 'engine-global')
      assert.equal(row(initial, 'a').clipPlanesPerCameraSupported, false)
      assert.ok(row(initial, 'a').nearM < 1.16 && row(initial, 'a').farM > 8, '必须返回实际世界全局裁剪，不能把未应用的声明写成实际裁剪')
      const before = await provider.capture(handle.worldId, { cameraName: 'sensor-a/body-view', width: 320, height: 240, outputDir: outDir }) as any
      const action = await provider.execute(handle.worldId, {
        actionId: 'r015-travel-yaw', kind: 'joint', expectedGeneration: 1, entityId: 'arm-a',
        jointNames: ['travel', 'yaw'], positions: [0.3, 0.7], durationS: 0.4, settleTimeS: 0.6, tolerance: 0.01,
      }) as any
      assert.equal(action.status, 'completed')
      assert.equal(action.effect.motions[0].targetReached, true)
      const moved = await provider.listCameras(handle.worldId) as any
      assert.ok(moved.stepIndex > initial.stepIndex)
      assertBodyMount(row(moved, 'a'), moved, 'a')
      assertBodyMount(row(moved, 'b'), moved, 'b')
      assert.ok(Math.abs(row(moved, 'a').worldFromCamera.positionM[0] - row(initial, 'a').worldFromCamera.positionM[0]) > 0.1)
      assert.deepEqual(row(moved, 'b').worldFromCamera, row(initial, 'b').worldFromCamera, '另一台同名 link 的相机不能被移动')
      const capture = await provider.capture(handle.worldId, { cameraName: 'sensor-a/body-view', width: 320, height: 240, outputDir: outDir }) as any
      for (const key of ['generation', 'stepIndex', 'frameId', 'sceneRevision', 'appliedSceneRevision']) {
        assert.equal(capture[key], moved[key])
        assert.equal(capture.calibration[key], capture[key])
      }
      assert.equal(capture.observation.frameId, capture.frameId)
      const observedCamera = capture.observation.cameras.find((camera: any) => camera.cameraName === 'sensor-a/body-view')
      assert.equal(observedCamera.frameId, capture.frameId)
      assert.deepEqual(observedCamera.worldFromCamera, capture.calibration.worldFromCamera)
      const observedParent = capture.observation.entities.find((entity: any) => entity.entityId === 'arm-a').sensors.bodyWorldPoses.turntable
      assert.equal(observedParent.bodyName, 'turntable', 'Viewer 原生 body 投影必须有可寻址的局部 body 名')
      assert.deepEqual(observedParent.positionM, capture.worldFromParent.positionM)
      assert.ok(rowsClose(observedParent.rotationMatrix, capture.worldFromParent.rotationMatrix, 1e-9))
      assert.equal(capture.parentBodyName, 'arm-a/turntable')
      assert.equal(capture.parentEntityId, 'arm-a')
      assert.ok(rowsClose(capture.calibration.worldFromCamera.rotationMatrix, row(moved, 'a').worldFromCamera.rotationMatrix, 1e-9))
      const actualSite = capture.observation.entities.find((entity: any) => entity.entityId === 'arm-a').sensors.sites.wrist_mount
      assert.ok(capture.calibration.worldFromCamera.positionM.every((value: number, i: number) => near(value, actualSite.positionM[i], 1e-9)), '必须与原模型相同局部安装的原生 site 闭合')
      assert.ok(rowsClose(capture.calibration.worldFromCamera.rotationMatrix, quatMatrixXYZW(actualSite.quaternionXyzw), 1e-9))
      for (const key of ['fx', 'fy', 'cx', 'cy']) assert.ok(near(capture.calibration.intrinsics[key], (BODY_MOUNT_K as any)[key], 1e-3))
      const beforeImage = decodePng(readFileSync(decodeURIComponent(new URL(before.rgb.uri).pathname)))
      const image = decodePng(readFileSync(decodeURIComponent(new URL(capture.rgb.uri).pathname)))
      assert.ok(image.distinctColors > 10)
      assert.ok(image.pixelDiff(beforeImage) > 0.001, '真实 link 运动后图像必须发生可测变化')
      const depth = readDepth(decodeURIComponent(new URL(capture.depth.uri).pathname), 320, 240)
      assert.ok(depth.at(160, 120) > 0 && Number.isFinite(depth.at(160, 120)))
      const targetDelta = [0.45, 0.25, 0.12].map((value, i) => value - capture.calibration.worldFromCamera.positionM[i])
      const cameraPoint = [0, 1, 2].map(column => targetDelta.reduce((sum, value, i) => sum + value * capture.calibration.worldFromCamera.rotationMatrix[i][column], 0))
      const k = capture.calibration.intrinsics
      assert.equal(capture.calibration.clipPlanesSource, 'engine-global')
      assert.equal(capture.calibration.clipPlanesPerCameraSupported, false)
      assert.equal(capture.calibration.declaredNearM, 7)
      assert.equal(capture.calibration.declaredFarM, 8)
      const landmarkPixel: [number, number] = [Math.round(k.cx + k.fx * cameraPoint[0] / -cameraPoint[2]), Math.round(k.cy - k.fy * cameraPoint[1] / -cameraPoint[2])]
      assert.ok(landmarkPixel[0] >= 0 && landmarkPixel[0] < 320 && landmarkPixel[1] >= 0 && landmarkPixel[1] < 240)
      const landmarkDepth = depth.at(...landmarkPixel)
      assert.ok(near(landmarkDepth, 1.4 - 0.24, 0.02), '真实移动相机像素应命中原生 red_landmark 的顶面 z=.24m，而非背景')
      const projected = await provider.projectAnnotation(handle.worldId, { cameraName: 'sensor-a/body-view', pixel: landmarkPixel, captureId: capture.captureId }) as any
      assert.equal(projected.frameId, capture.frameId)
      assert.ok(near(projected.worldPointM[2], 0.24, 0.02), '同帧米制深度反投影必须命中真实原生几何')

      // manual 无活动动作时不会推进，重复清单/停止/采集仍处于同一已完成物理帧。
      const stopped = await provider.stop(handle.worldId, { entityIds: ['arm-a'], expectedGeneration: 1 }) as any
      assert.equal(stopped.stopped, true)
      const paused = await provider.listCameras(handle.worldId) as any
      assert.equal(paused.frameId, moved.frameId)
      assertBodyMount(row(paused, 'a'), paused, 'a')
      const reset = await provider.sync(handle.worldId, mountedCameraScene(), { forceRebuild: true })
      assert.equal(reset.worldGeneration, 2)
      const resetFrame = await provider.listCameras(handle.worldId) as any
      assert.equal(resetFrame.stepIndex, 0)
      assertBodyMount(row(resetFrame, 'a'), resetFrame, 'a')
      assert.deepEqual(row(resetFrame, 'a').worldFromCamera, row(initial, 'a').worldFromCamera, 'reset 后原生绑定与保存局部安装仍然一致')
      await assert.rejects(provider.projectAnnotation(handle.worldId, { cameraName: 'sensor-a/body-view', pixel: [160, 120], captureId: capture.captureId }), (error: any) => error.code === 'STALE_GENERATION')
      await provider.close(handle.worldId)
      const reopened = await provider.open(mountedCameraScene(), { ground: false, worldId: 'r015-body-camera-reopen', clock: 'manual' })
      const reopenedFrame = await provider.listCameras(reopened.worldId) as any
      assertBodyMount(row(reopenedFrame, 'a'), reopenedFrame, 'a')
      assertBodyMount(row(reopenedFrame, 'b'), reopenedFrame, 'b')
      t.diagnostic(JSON.stringify({ actualFrame: capture.frameId, joints: capture.observation.entities.find((entity: any) => entity.entityId === 'arm-a').joints,
        parentBodyName: capture.parentBodyName, cameraPositionM: capture.calibration.worldFromCamera.positionM,
        sitePositionM: actualSite.positionM, rgbMeanAbsoluteChange: image.pixelDiff(beforeImage), rgbDistinctColors: image.distinctColors,
        landmarkPixel, landmarkDepthM: landmarkDepth, landmarkWorldPointM: projected.worldPointM,
        intrinsics: capture.calibration.intrinsics, resetGeneration: reset.worldGeneration }))
      await provider.close(reopened.worldId)
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })

  test('在途 Stop 取消真实关节动作后，相机与原生 body 留在同一已停止物理帧', { timeout: 60000 }, async () => {
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(mountedCameraScene(), { ground: false, worldId: 'r015-body-camera-stop', clock: 'manual' })
    try {
      const running = provider.execute(handle.worldId, {
        actionId: 'r015-inflight-stop', kind: 'joint', expectedGeneration: 1, entityId: 'arm-a',
        jointNames: ['travel', 'yaw'], positions: [0.45, -0.7], durationS: 60,
      })
      let frame = await provider.listCameras(handle.worldId) as any
      for (let attempt = 0; frame.stepIndex === 0 && attempt < 10; attempt++) frame = await provider.listCameras(handle.worldId) as any
      assert.ok(frame.stepIndex > 0, '停止前必须真实施加并积分过关节动作')
      const stopped = await provider.stop(handle.worldId, { actionId: 'r015-inflight-stop', expectedGeneration: 1 }) as any
      assert.equal(stopped.receipts[0].status, 'cancelled')
      assert.equal((await running).status, 'cancelled')
      const paused = await provider.listCameras(handle.worldId) as any
      assert.equal(paused.stepIndex, stopped.stepIndex)
      const camera = paused.cameras.find((item: any) => item.cameraName === 'sensor-a/body-view')
      assertBodyMount(camera, paused, 'a')
      const readAgain = await provider.listCameras(handle.worldId) as any
      assert.equal(readAgain.frameId, paused.frameId, 'manual Stop 后只读操作不推进物理钟')
      assert.deepEqual(readAgain.cameras.find((item: any) => item.cameraName === 'sensor-a/body-view').worldFromCamera, camera.worldFromCamera)
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })

  test('缺实体/错 body/非法局部 pose 明确不可用，不回退实体 root 或 world', { timeout: 60000 }, async () => {
    const provider = new MuJoCoProvider({ pythonPath: python })
    const scene = mountedCameraScene()
    const sensor = scene.entities.find((entity: any) => entity.entityId === 'sensor-a')
    sensor.components.camera.mount.bodyName = 'missing-head'
    const sensorB = scene.entities.find((entity: any) => entity.entityId === 'sensor-b')
    sensorB.components.camera.mount.quaternionXyzw = [0, 0, 0, 0]
    scene.entities.push({ ...structuredClone(sensor), entityId: 'sensor-missing', components: { camera: { ...structuredClone(sensor.components.camera), mount: { ...sensor.components.camera.mount, entityId: 'no-such-robot' } } } })
    const handle = await provider.open(scene, { ground: false, worldId: 'r015-invalid-mount', clock: 'manual' })
    try {
      const frame = await provider.listCameras(handle.worldId) as any
      for (const id of ['sensor-a', 'sensor-b', 'sensor-missing']) {
        const camera = frame.cameras.find((row: any) => row.entityId === id)
        assert.equal(camera.available, false)
        assert.match(camera.reason, /^SCENE_CAMERA_MOUNT_(NOT_FOUND|INVALID)$/)
        assert.equal(camera.worldFromCamera, undefined, '不可用相机不能发布伪造世界矩阵或视锥')
        assert.equal(camera.intrinsics, undefined)
        await assert.rejects(provider.capture(handle.worldId, { cameraName: camera.cameraName, outputDir: outDir }), (error: any) => error.code === 'CAMERA_NOT_FOUND')
      }
      assert.equal(frame.cameras.filter((row: any) => row.available === true).length, 4, '模型自带两台机器人的原生相机仍可用')
      assert.equal(handle.warnings?.filter(warning => warning.code.startsWith('SCENE_CAMERA_MOUNT_')).length, 3)
    } finally { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() }
  })
})
