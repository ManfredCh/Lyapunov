/**
 * 相机内参的**逐像素**真实回归验收（task 99；scene-camera.test.ts 的字段级断言在这里升级成像素级证据）。
 *
 * 运行：
 *   MUJOCO_GL=egl LYAPUNOV_MUJOCO_PYTHON=<root>/.runtime/sim-python/bin/python \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/camera-intrinsics.test.ts
 *   （必须开 transform-types：sim-contract/src/python-transport.ts 用了 TypeScript 参数属性。）
 *   没有解释器时整份测试显式 skip 并说明原因，不假装通过。
 *
 * 测量方法（不是"同公式断言"）：场景里放 8 个等深（相机前方 3 m 平面）标记球，四横四竖、两排互不相交，
 * 全部走产品路径（MuJoCoProvider.open → listCameras/capture/adjustCamera/projectAnnotation），在引擎真实输出的
 * PNG + 米制深度里逐像素分离标记、取质心，再与**回执里报出的生效 K / 世界位姿**做独立预测比对：
 *  - 分离判据 = 深度落在标记平面 ±0.6 m（墙 8.9 m、远平面、地面整片被排除）且色度（归一化 RGB）离某个
 *    声明标记色最近、最大通道差 < 0.05。为什么用色度而不是确切 RGB：worker 路径关不掉场景头灯
 *    （MJCF 的 <visual> 不随实体 attach 合并，实测），球面朗伯项让同一标记内部亮度沿法线变化；但头灯是白光、
 *    材质镜面为 0、标记等深（3 m 处雾未启用），亮度只是各通道共同的缩放因子，色度与亮度无关。
 *  - 判据 1：每个标记的实测质心与"回执 K + 回执位姿"的预测差 ≤ 0.5 px（球面透视轮廓相对球心的偏移
 *    ~f·(r/d)² ≈ 0.08 px、质心量化 ~0.2 px；任务目录 probe11 用同一手法实测残差 ≤ 0.3 px）。
 *  - 判据 2：用两排的极值两点**独立复原** (fx, cx) 与 (fy, cy)（中间点验线性），复原值对焦距 ≤ 1%、
 *    对主点 ≤ 0.5 px。复原只用标记世界真值 + 回执相机位姿，不引用回执 K；fx 被折成 fy、主点被硬算成
 *    画面中心都会在这里暴露（几十~上百 px 的偏差）。
 *  - 判据 3：同一标记在两种输出分辨率下的像素满足 u₂ = 2·u₁ + 0.5（引擎按输出分辨率缩放 K 的对应关系，
 *    见 worker 的 _camera_effective_intrinsics），且深度不变。
 *  - 判据 4：标记质心像素 + 真实 capture 深度反投影回的世界点落在标记真值 0.05 m 内（球半径 0.03 m），
 *    并且（更严）落在"相机→球心射线与球面的第一个交点"5 mm 内：深度图给的是可见球面，不是球心，
 *    所以这条严判据用真实射线-球面求交算期望点，能真正压住 K/深度的合计误差。
 *  像素→世界的方向约定不靠猜：v 越大在世界里越低（地面剖线）由 scene-camera.test.ts 的真实深度断言钉死，
 *  本文件的竖直排标记再把主点 cy 的符号钉在同一侧。
 *
 * 覆盖面：
 *  - 非方形 K（fx≠fy）+ 偏心主点（cx≠(W−1)/2）：`components.camera.intrinsics` 真的进渲染，主点符号按
 *    **实测像素**判（引擎的 principalpixel 是"图像中心 − 光轴像素"，与 CV 口径反号）。
 *  - 竖幅 K（480×640）+ 同相机 960×1280 输出的像素对应关系。
 *  - 原生 MJCF 相机的 focalpixel/principalpixel：如实认成 engine-intrinsics、**不被改写**（配置值回读仍是
 *    原件值，生效 K 按引擎约定换算），并用像素回归核对。
 *  - 声明了畸形变仍如实标注未建模，且画面确实没被畸变改写（仍在纯针孔残差内）。
 *  - 没有 K 的老相机（lensMm/sensorWidthMm/fovYDeg）：仍走 fovy 路径、报告如实写 'fovy'，像素实测确实是
 *    方形像素 + 画面中心主点（不把未知像素尺度伪装成已知 K）。
 *  - camera_adjust：仅移位（K 不变，实测像素与移位后位姿的预测一致）、只改 FOV（落在焦距上，像素实测焦距
 *    真的变了）、clear（像素回到声明 K 的预测位）；跟随父体：静态旋转父 body 的挂载 + 动态父 body 的 FK。
 *
 * 诚实边界：
 *  - 只测 MuJoCo 侧；Isaac 的相机路径不在本文件（GPU 槽有序，按协调延后）。
 *  - 标记是合成球（半径 0.03 m），不是用户真实资产；真实资产的相机清单核对由任务目录
 *    tools/real_scene_camera_list.ts 另跑。
 *  - 不覆盖径向/切向畸变模型（MuJoCo 3.13 没有畸变模型，本文件只验证"声明了也不会假装生效"）。
 *  - 不覆盖 orthographic 投影相机（mjtProjection 的另一支，既有原生路径，本任务不改）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { MuJoCoProvider } from '../src/provider.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, '.runtime/sim-python/bin/python')
const available = existsSync(python)
const skip = available ? false : `MuJoCo 解释器不存在: ${python}（设 LYAPUNOV_MUJOCO_PYTHON）`
const outDir = resolve(tmpdir(), `w99-camera-intrinsics-${process.pid}`)
/** 设 LYAPUNOV_CAMERA_EVIDENCE=<dir> 时把每个测量用的真实帧拷到该目录（回执留证用；不设就只留在临时目录）。 */
const evidenceDir = process.env.LYAPUNOV_CAMERA_EVIDENCE
after(() => rmSync(outDir, { recursive: true, force: true }))

type Vec3 = [number, number, number]
interface K { fx: number; fy: number; cx: number; cy: number; width: number; height: number }
interface Pose { positionM: number[]; rotationMatrix: number[][] }
interface Mark { color: Vec3; world: Vec3 }
interface Blob { u: number; v: number; count: number; spanU: number; spanV: number }

/** 世界 +Y 平视（绕 +X 转 +90°：-Z→+Y、+X→+X、+Y→+Z），与 scene-camera.test.ts 同一约定。 */
const LOOK_QUAT_XYZW: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]
const LOOK_PLUS_Y: number[][] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
const CAMERA_HOME: Vec3 = [0, -3, 1.2]
const MARK_PLANE_DEPTH_M = 3
const MARK_RADIUS_M = 0.03
/** 实测容差：见文件头判据 1/判据 2 的依据。 */
const PIXEL_TOLERANCE = 0.5
const FOCAL_RELATIVE_TOLERANCE = 0.01
const PRINCIPAL_TOLERANCE = 0.5
const CHROMA_DISTANCE_MAX = 0.05

/** 8 个标记色：发射为主 + 镜面 0（别让高光把色度拉向白光）。色度两两最大通道差 ≥0.146（前置断言会检查），
 *  与灰/蓝灰/深色背景的色度差 ≥0.18；亮度上限 0.975 <1 所以不会在头灯下被截断（截断才会破坏色度不变性）。 */
const MARK_COLORS: Vec3[] = [
  [0.60, 0.12, 0.12], [0.12, 0.60, 0.12], [0.12, 0.12, 0.65], [0.62, 0.58, 0.08],
  [0.08, 0.55, 0.55], [0.55, 0.08, 0.55], [0.65, 0.30, 0.05], [0.33, 0.08, 0.62],
]
/** 标记在**相机坐标**里的位置（x 右、y 上、前方 −z = 3 m）：前 4 个横排定 fx/cx，后 4 个竖排定 fy/cy。
 *  两排在画面里互不相交、两两间距 ≥ 2.5 倍标记直径（前置断言会检查）→ 谁也不会挡住谁。 */
const MARK_OFFSETS: Array<[number, number]> = [
  [-0.68, 0.35], [-0.20, 0.35], [0.28, 0.35], [0.76, 0.35],
  [-0.78, 0.15], [-0.78, -0.09], [-0.78, -0.33], [-0.78, -0.57],
]

/** 相机坐标 (右 x、上 y、前 −z) → 世界点；R 是 world←camera 旋转（与标定回执同一口径）。 */
function cameraPointToWorld(pose: Pose, local: Vec3): Vec3 {
  const r = pose.rotationMatrix
  return [0, 1, 2].map(i => pose.positionM[i] + r[i][0] * local[0] + r[i][1] * local[1] + r[i][2] * local[2]) as Vec3
}

/** 世界点 → 该相机位姿与 K 下的像素。这一支是 worker.project_annotation 反投影的**逆**：
 *  p_cam = Rᵀ(world−t)（相机前向是 −z，轴向深度 d = −p_cam[2] > 0），u = cx + fx·p_cam[0]/d、
 *  v = cy − fy·p_cam[1]/d（+y 向上 → 行号更小；竖直极性由 scene-camera.test.ts 的地面剖线真实深度钉死）。 */
function projectPoint(k: K, pose: Pose, world: Vec3): [number, number] {
  const d = [world[0] - pose.positionM[0], world[1] - pose.positionM[1], world[2] - pose.positionM[2]]
  const r = pose.rotationMatrix
  const p = [0, 1, 2].map(i => r[0][i] * d[0] + r[1][i] * d[1] + r[2][i] * d[2])
  const depth = -p[2]
  return [k.cx + k.fx * p[0] / depth, k.cy - k.fy * p[1] / depth]
}

/** 相机光心 → 球心的射线与球面的第一个交点（真实射线-球面求交，不是"球心减半径"的近似）。
 *  标记质心像素经深度图反投影应落在这一点上：深度图给的是可见球面而不是球心。 */
function sphereEntryPoint(cameraPosition: Vec3, centre: Vec3, radius: number): Vec3 {
  const to = [0, 1, 2].map(i => centre[i] - cameraPosition[i])
  const distance = Math.hypot(...to)
  const direction = to.map(v => v / distance)
  const along = to.reduce((sum, v, i) => sum + v * direction[i], 0)          // (centre−camera)·direction = distance
  const perpendicular2 = Math.max(0, distance * distance - along * along)
  const half = Math.sqrt(Math.max(0, radius * radius - perpendicular2))
  const t = along - half
  return [0, 1, 2].map(i => cameraPosition[i] + t * direction[i]) as Vec3
}

/** 8 个标记的世界位置：相对给定相机位姿的前方 3 m 等深平面（等深 → 标记之间不可能互相遮挡）。 */
function markerMarks(pose: Pose, depth = MARK_PLANE_DEPTH_M): Mark[] {
  return MARK_OFFSETS.map((offset, index) => ({
    color: MARK_COLORS[index], world: cameraPointToWorld(pose, [offset[0], offset[1], -depth]),
  }))
}

/** 标记实体：一个纯视觉 MJCF 实体（无碰撞），球心就在上面的世界坐标上。 */
function markerEntity(marks: Mark[]) {
  const assets = marks.map((mark, i) => `<material name="mk${i}" rgba="${mark.color.join(' ')} 1" emission="1" specular="0"/>`).join('')
  const bodies = marks.map((mark, i) =>
    `<body name="mark${i}" pos="${mark.world.join(' ')}">` +
    `<geom name="gm${i}" type="sphere" size="${MARK_RADIUS_M}" material="mk${i}" contype="0" conaffinity="0"/></body>`).join('')
  return { mujoco: { xml: `<mujoco><asset>${assets}</asset><worldbody>${bodies}</worldbody></mujoco>` } }
}

function entity(entityId: string, name: string, position: Vec3, quaternion: [number, number, number, number], components: any, parentId?: string) {
  return { entityId, name, transform: { position, quaternion, scale: [1, 1, 1] as Vec3 }, resources: [], components, ...(parentId ? { parentId } : {}) }
}
function mjcf(xml: string) { return { mujoco: { xml } } }
function collision(halfExtents: Vec3) { return { collision: { type: 'box', halfExtents, source: 'camera-intrinsics-test' } } }
/** 声明 K 的 Scene 相机（components.camera，世界位姿 = 实体世界 TRS）。 */
function cameraEntity(entityId: string, position: Vec3, quaternion: [number, number, number, number], camera: any, parentId?: string) {
  return entity(entityId, entityId, position, quaternion, { camera }, parentId)
}
/** 合成场景：地面 z=0、北墙近面 y=5.9（在标记平面 3 m 之后，深度门限只留标记那一层）。 */
function buildScene(entities: any[], sceneId: string) {
  return {
    sceneId, revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' } as const,
    entities: [
      entity('floor-t', '地面', [0, 0, -0.05], [0, 0, 0, 1], collision([8, 8, 0.05])),
      entity('wall-t', '北墙', [0, 6, 1.5], [0, 0, 0, 1], collision([8, 0.1, 1.5])),
      ...entities,
    ],
  }
}

/** 一次真实采集 → 逐标记实测质心、回执 K/位姿下的预测像素、残差。 */
function measureCapture(capture: any, marks: Mark[], planeDepth = MARK_PLANE_DEPTH_M) {
  const rgb = decodePng(readFileSync(decodeURIComponent(new URL(capture.rgb.uri).pathname)))
  const depth = readDepth(decodeURIComponent(new URL(capture.depth.uri).pathname), rgb.width, rgb.height)
  const k = capture.calibration.intrinsics as K
  const pose = capture.calibration.worldFromCamera as Pose
  const predicted = marks.map(mark => projectPoint(k, pose, mark.world))
  const blobs = measureMarkers(rgb, depth, marks, planeDepth)
  return {
    rgb, depth, k, pose, blobs, predicted, marks,
    residuals: blobs.map((blob, i) => blob === null ? null : Math.hypot(blob.u - predicted[i][0], blob.v - predicted[i][1])),
  }
}
type Measured = ReturnType<typeof measureCapture>

/** 逐标记断言：找得到、形态是单个紧凑团、与回执 K/位姿的预测 ≤0.5 px，质心像素深度落在标记球面上。 */
function assertMarkers(capture: any, marks: Mark[], label: string, planeDepth = MARK_PLANE_DEPTH_M): Measured {
  const measured = measureCapture(capture, marks, planeDepth)
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    for (const [kind, file] of [['rgb', capture.rgb], ['depth', capture.depth]] as const) {
      copyFileSync(decodeURIComponent(new URL(file.uri).pathname), resolve(evidenceDir, `${label}-${kind}${kind === 'rgb' ? '.png' : '.npy'}`))
    }
  }
  const radiusPx = measured.k.fx * MARK_RADIUS_M / planeDepth
  measured.blobs.forEach((blob, i) => {
    assert.ok(blob !== null, `${label}: 标记 ${i} 在真实画面里没找到（深度门限 ${planeDepth}±0.6 m + 色度匹配）`)
    const found = blob as Blob
    assert.ok(found.count >= Math.max(20, 0.4 * Math.PI * radiusPx * radiusPx),
      `${label}: 标记 ${i} 只有 ${found.count} 像素，不像真实球面投影（半径 ${radiusPx.toFixed(1)} px）`)
    // 单个紧凑团：色度误分会在别处再凑出一片，这里用包围盒挡掉。
    assert.ok(found.spanU <= 2 * radiusPx + 5 && found.spanV <= 2 * radiusPx + 5,
      `${label}: 标记 ${i} 的包围盒 ${found.spanU}×${found.spanV} 超出球面投影尺寸（半径 ${radiusPx.toFixed(1)} px）`)
    assert.ok((measured.residuals[i] as number) <= PIXEL_TOLERANCE,
      `${label}: 标记 ${i} 实测 (${found.u.toFixed(2)}, ${found.v.toFixed(2)}) 与回执 K/位姿预测 ` +
      `(${measured.predicted[i][0].toFixed(2)}, ${measured.predicted[i][1].toFixed(2)}) 差 ${(measured.residuals[i] as number).toFixed(3)} px`)
    // 球面上离相机最近的点就在质心像素上：轴向深度 = 平面深度 − 球半径。
    const surface = measured.depth.at(Math.round(found.u), Math.round(found.v))
    assert.ok(Math.abs(surface - (planeDepth - MARK_RADIUS_M)) <= 0.05,
      `${label}: 标记 ${i} 质心像素的米制深度 ${surface} 应为球面 ${planeDepth - MARK_RADIUS_M}`)
  })
  return measured
}

/** 极值两点独立复原焦距与主点 + 中间点线性残差。
 *  用**标记世界真值 + 回执相机位姿**算每个标记的相机局部坐标（x 右、y 上、前向深度 depth = −p_cam[2]），
 *  u = cx + fx·(x/depth)、v = cy − fy·(y/depth)：两支都是对 x/depth、y/depth 的直线，
 *  斜率就是 ±焦距、截距就是主点像素。不引用回执 K；相机任意朝向都成立（挂载相机那组就是绕 Z 转了 25°）。 */
function fitAxis(measured: Measured, indexes: number[], axis: 'x' | 'y') {
  const column = axis === 'x' ? 0 : 1
  const pairs = indexes.map(i => {
    const d = [0, 1, 2].map(c => measured.marks[i].world[c] - measured.pose.positionM[c])
    const local = d.reduce((sum, v, c) => sum + measured.pose.rotationMatrix[c][column] * v, 0)
    const depth = -(d.reduce((sum, v, c) => sum + measured.pose.rotationMatrix[c][2] * v, 0))
    return { value: local / depth, pixel: axis === 'x' ? (measured.blobs[i] as Blob).u : (measured.blobs[i] as Blob).v }
  }).sort((a, b) => a.value - b.value)
  const slope = (pairs[pairs.length - 1].pixel - pairs[0].pixel) / (pairs[pairs.length - 1].value - pairs[0].value)
  const intercept = pairs[0].pixel - slope * pairs[0].value
  return {
    focal: (axis === 'x' ? 1 : -1) * slope,
    principal: intercept,
    residual: Math.max(...pairs.map(p => Math.abs(p.pixel - (slope * p.value + intercept)))),
  }
}

function assertFit(measured: Measured, k: K, label: string) {
  const u = fitAxis(measured, [0, 1, 2, 3], 'x')
  const v = fitAxis(measured, [4, 5, 6, 7], 'y')
  assert.ok(near(u.focal, k.fx, k.fx * FOCAL_RELATIVE_TOLERANCE),
    `${label}: 实测 fx=${u.focal.toFixed(2)} 应≈${k.fx}（±${(k.fx * FOCAL_RELATIVE_TOLERANCE).toFixed(1)}）`)
  assert.ok(near(v.focal, k.fy, k.fy * FOCAL_RELATIVE_TOLERANCE),
    `${label}: 实测 fy=${v.focal.toFixed(2)} 应≈${k.fy}（±${(k.fy * FOCAL_RELATIVE_TOLERANCE).toFixed(1)}）`)
  assert.ok(near(u.principal, k.cx, PRINCIPAL_TOLERANCE) && near(v.principal, k.cy, PRINCIPAL_TOLERANCE),
    `${label}: 实测主点 (${u.principal.toFixed(2)}, ${v.principal.toFixed(2)}) 应≈(${k.cx}, ${k.cy})，画面中心是 (${(k.width - 1) / 2}, ${(k.height - 1) / 2})`)
  assert.ok(u.residual < PIXEL_TOLERANCE && v.residual < PIXEL_TOLERANCE,
    `${label}: 极值两点连线的中间点残差 u=${u.residual.toFixed(3)} v=${v.residual.toFixed(3)} px（真实渲染应是线性针孔）`)
  return { u, v }
}

/** 回执用摘要：逐标记残差 + 独立复原的 (fx, cx, fy, cy) + 回执 K（判据 1/2 的实测数字，写进测试日志）。 */
function summary(measured: Measured, label: string) {
  const u = fitAxis(measured, [0, 1, 2, 3], 'x')
  const v = fitAxis(measured, [4, 5, 6, 7], 'y')
  return `${label}: 逐标记残差 ${measured.residuals.map(r => (r as number).toFixed(3)).join('/')} px；` +
    `像素复原 fx=${u.focal.toFixed(2)} cx=${u.principal.toFixed(2)} fy=${v.focal.toFixed(2)} cy=${v.principal.toFixed(2)}` +
    `（中间点线性残差 ${u.residual.toFixed(3)}/${v.residual.toFixed(3)} px）；` +
    `回执 K fx=${measured.k.fx.toFixed(4)} fy=${measured.k.fy.toFixed(4)} cx=${measured.k.cx.toFixed(4)} cy=${measured.k.cy.toFixed(4)} @${measured.k.width}×${measured.k.height}`
}

/** 多分辨率对应的最大偏差（判据 3 的实测数字）。 */
function correspondence(base: Measured, high: Measured) {
  const deviations = base.blobs.map((blob, i) => {
    const other = high.blobs[i] as Blob, low = blob as Blob
    return Math.max(Math.abs(other.u - (2 * low.u + 0.5)), Math.abs(other.v - (2 * low.v + 0.5)))
  })
  return `分辨率对应最大偏差 ${Math.max(...deviations).toFixed(3)} px（逐标记 ${deviations.map(d => d.toFixed(3)).join('/')}）`
}

/** 前置检查：标记色度两两可分、投影在画面里有足够余量、两两间距 ≥2.5 倍直径（否则测量会互相污染）。 */
function assertLayout(k: K, pose: Pose, marks: Mark[], label: string) {
  const chromas = marks.map(mark => chroma(mark.color))
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const distance = Math.max(...chromas[i].map((v, c) => Math.abs(v - chromas[j][c])))
      assert.ok(distance > 2.4 * CHROMA_DISTANCE_MAX, `${label}: 标记 ${i}/${j} 色度距离 ${distance.toFixed(3)} 太小，会互相误分`)
    }
  }
  const pixels = marks.map(mark => projectPoint(k, pose, mark.world))
  const radius = k.fx * MARK_RADIUS_M / MARK_PLANE_DEPTH_M
  pixels.forEach(([u, v], i) => assert.ok(u > radius + 4 && u < k.width - radius - 4 && v > radius + 4 && v < k.height - radius - 4,
    `${label}: 标记 ${i} 投影 (${u.toFixed(1)}, ${v.toFixed(1)}) 离画面边界太近（半径 ${radius.toFixed(1)} px）`))
  for (let i = 0; i < pixels.length; i++) {
    for (let j = i + 1; j < pixels.length; j++) {
      const separation = Math.hypot(pixels[i][0] - pixels[j][0], pixels[i][1] - pixels[j][1])
      assert.ok(separation > 2.5 * 2 * radius, `${label}: 标记 ${i}/${j} 投影间距 ${separation.toFixed(1)} px 不足以分开（半径 ${radius.toFixed(1)} px）`)
    }
  }
  return pixels
}

/** 归一化 RGB（色度）。 */
function chroma(rgb: number[]): number[] {
  const sum = rgb[0] + rgb[1] + rgb[2]
  return sum > 1e-6 ? rgb.map(v => v / sum) : [0, 0, 0]
}

/** 真实 RGB + 米制深度 → 逐标记质心：深度落在标记平面、且色度离某个声明标记色最近（<0.05）。 */
function measureMarkers(
  image: { width: number; height: number; pixels: Buffer },
  depth: { at(u: number, v: number): number }, marks: Mark[], planeDepth: number,
): Array<Blob | null> {
  const targets = marks.map(mark => chroma(mark.color))
  const sums = marks.map(() => ({ u: 0, v: 0, count: 0, u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity }))
  for (let v = 0; v < image.height; v++) {
    for (let u = 0; u < image.width; u++) {
      const axial = depth.at(u, v)
      if (!(axial > planeDepth - 0.6 && axial < planeDepth + 0.6)) continue
      const index = (v * image.width + u) * 3
      const c = chroma([image.pixels[index] / 255, image.pixels[index + 1] / 255, image.pixels[index + 2] / 255])
      let best = -1, bestDistance = CHROMA_DISTANCE_MAX
      for (let k = 0; k < targets.length; k++) {
        let distance = 0
        for (let j = 0; j < 3; j++) distance = Math.max(distance, Math.abs(targets[k][j] - c[j]))
        if (distance < bestDistance) { bestDistance = distance; best = k }
      }
      if (best < 0) continue
      const sum = sums[best]
      sum.u += u; sum.v += v; sum.count += 1
      sum.u0 = Math.min(sum.u0, u); sum.u1 = Math.max(sum.u1, u)
      sum.v0 = Math.min(sum.v0, v); sum.v1 = Math.max(sum.v1, v)
    }
  }
  return sums.map(sum => sum.count === 0 ? null
    : { u: sum.u / sum.count, v: sum.v / sum.count, count: sum.count, spanU: sum.u1 - sum.u0 + 1, spanV: sum.v1 - sum.v0 + 1 })
}

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
  const stride = width * 3, pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, '仅支持 filter 0')
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  }
  return { width, height, pixels }
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

function quatMatrixXYZW(q: number[]): number[][] {
  const [x, y, z, w] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
const quatZ = (degrees: number): [number, number, number, number] => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)]
const rotationZ = (degrees: number) => quatMatrixXYZW(quatZ(degrees))
const matMul = (a: number[][], b: number[][]) => a.map(row => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)))
const rowsClose = (a: number[][], b: number[][], tol: number) => a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= tol))
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

test('非方形 K + 偏心主点：真实像素回归、多分辨率对应、反投影，畸形变如实标注未建模', { skip }, async t => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const k: K = { fx: 800, fy: 900, cx: 310, cy: 250, width: 640, height: 480 }
  const pose: Pose = { positionM: CAMERA_HOME, rotationMatrix: LOOK_PLUS_Y }
  const marks = markerMarks(pose)
  const expectedPixels = assertLayout(k, pose, marks, 'landscape-K')
  const handle = await provider.open(buildScene([
    cameraEntity('cam-k-t', CAMERA_HOME, LOOK_QUAT_XYZW, {
      direction: [0, 1, 0], isActive: true, sensorWidthMm: 36,
      intrinsics: { ...k, distortion: [0.12, -0.03] },
    }),
    cameraEntity('cam-fov-t', CAMERA_HOME, LOOK_QUAT_XYZW, {
      direction: [0, 1, 0], isActive: false, lensMm: 35, sensorWidthMm: 36, fovYDeg: 45,
    }),
    entity('marks-t', '标记', [0, 0, 0], [0, 0, 0, 1], markerEntity(marks)),
  ], 'scene-99-intrinsics-k'), { ground: false, worldId: 'w99-intrinsics-k' })
  t.after(async () => { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() })

  const list = await provider.listCameras(handle.worldId) as any
  const declared = list.cameras.find((c: any) => c.cameraName === 'cam-k-t/cam-k-t')
  assert.equal(declared.cameraSource, 'scene-camera')
  assert.equal(declared.cameraComponent, 'camera')
  assert.equal(declared.intrinsicsSource, 'engine-intrinsics')
  assert.deepEqual(declared.appliedIntrinsicsPx, { ...k }, '声明的 K 必须原样装进引擎')
  assert.deepEqual(declared.declaredIntrinsicsPx, { ...k })
  // 引擎主点配置 = 图像中心 − 光轴像素 = (639/2 − 310, 479/2 − 250) = (9.5, −10.5)（与 CV 口径反号）。
  assert.ok(near(declared.engineIntrinsics.principalPixelConfigured[0], 9.5, 1e-3)
    && near(declared.engineIntrinsics.principalPixelConfigured[1], -10.5, 1e-3),
    `引擎主点配置值应是"中心−光轴": ${JSON.stringify(declared.engineIntrinsics.principalPixelConfigured)}`)
  assert.deepEqual(declared.engineIntrinsics.resolution, [640, 480])
  // 容差 1e-6：传感器尺寸在 mjModel 里是 float32（0.036 m 存成 0.035999998…）。
  assert.ok(near(declared.engineIntrinsics.sensorSizeM[0], 0.036, 1e-6) && near(declared.engineIntrinsics.sensorSizeM[1], 0.027, 1e-6),
    `传感器尺寸: ${JSON.stringify(declared.engineIntrinsics.sensorSizeM)}`)
  assert.ok(String(declared.engineIntrinsics.principalPixelConvention).includes('principal-point'))
  assert.ok(near(declared.intrinsics.fx, 800, 1e-3) && near(declared.intrinsics.fy, 900, 1e-3)
    && near(declared.intrinsics.cx, 310, 1e-3) && near(declared.intrinsics.cy, 250, 1e-3),
    `生效 K 必须逐项等于声明: ${JSON.stringify(declared.intrinsics)}`)
  const warnings = (handle as any).warnings.map((w: any) => w.code)
  assert.ok(warnings.includes('SCENE_CAMERA_DISTORTION_UNMODELED'), `畸形变必须如实登记未建模: ${JSON.stringify(warnings)}`)
  assert.equal(warnings.includes('SCENE_CAMERA_SQUARE_PIXEL_APPROX'), false, 'fx≠fy 不再被折成方形像素')

  const capture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: k.width, height: k.height }) as any
  const intrinsics = capture.calibration.intrinsics
  assert.equal(capture.calibration.intrinsicsSource, 'engine-intrinsics')
  assert.ok(near(intrinsics.fx, 800, 1e-3) && near(intrinsics.fy, 900, 1e-3)
    && near(intrinsics.cx, 310, 1e-3) && near(intrinsics.cy, 250, 1e-3), `帧标定 K: ${JSON.stringify(intrinsics)}`)
  assert.ok(Math.abs(intrinsics.pixelAspectRatio - 800 / 900) < 1e-6)
  assert.equal(intrinsics.distortionModeled, false, 'MuJoCo 3.13 没有畸变模型，必须如实标注未建模')
  assert.deepEqual(intrinsics.distortionDeclared, [0.12, -0.03])
  assert.ok(capture.calibration.worldFromCamera.positionM.every((v: number, i: number) => near(v, CAMERA_HOME[i], 1e-9))
    && rowsClose(capture.calibration.worldFromCamera.rotationMatrix, LOOK_PLUS_Y, 1e-9))

  const measured = assertMarkers(capture, marks, 'landscape-K')
  // 前置：预测像素确实散布在画面里（防止整排挤在一角的伪回归）。
  assert.ok(Math.max(...expectedPixels.map(p => p[0])) - Math.min(...expectedPixels.map(p => p[0])) > 0.5 * k.width)
  assert.ok(Math.max(...expectedPixels.map(p => p[1])) - Math.min(...expectedPixels.map(p => p[1])) > 0.5 * k.height)
  assertFit(measured, k, 'landscape-K')
  t.diagnostic(summary(measured, 'landscape-K 800/900/310/250'))

  // 主点符号的像素证据：画面中心像素 (320,240) 不是光轴 → 反投影的世界 X 应明显偏离相机光轴 x=0
  // （若主点被硬算成画面中心 (319.5,239.5)，这里的 X 会落到 0.006 m 以内）。
  const centrePixel: [number, number] = [Math.floor(k.width / 2), Math.floor(k.height / 2)]
  const centrePoint = await provider.projectAnnotation(handle.worldId, { cameraName: 'cam-k-t/cam-k-t', pixel: centrePixel, captureId: capture.captureId }) as any
  const centreExpected = (centrePixel[0] - k.cx) * centrePoint.depthM / k.fx
  assert.ok(near(centrePoint.worldPointM[0], centreExpected, 0.005) && centrePoint.worldPointM[0] > CAMERA_HOME[0] + 0.02,
    `画面中心像素应落在光轴右侧（cx=${k.cx} < ${centrePixel[0]}）：${JSON.stringify(centrePoint.worldPointM)}（期望 X=${centreExpected.toFixed(4)}）`)

  // 判据 4：标记质心像素 + 真实 capture 深度 → 世界点必须落在标记真值 0.05 m 内；
  // 更严的一条：深度图给的是**球面**深度（比球心近一个半径），所以反投影该落在"相机到球心的射线与球面的
  // 第一个交点"上（球心 ∈ 该射线上，像素取整只让它偏不到 1 px），这条按真实射线-球面求交算期望点，容差 5 mm。
  for (const index of [2, 5, 7]) {
    const blob = measured.blobs[index] as Blob
    const annotation = await provider.projectAnnotation(handle.worldId, {
      cameraName: 'cam-k-t/cam-k-t', pixel: [Math.round(blob.u), Math.round(blob.v)], captureId: capture.captureId,
    }) as any
    const truth = marks[index].world
    const error = Math.hypot(...annotation.worldPointM.map((value: number, i: number) => value - truth[i]))
    assert.ok(error <= 0.05, `标记 ${index} 反投影世界点 ${JSON.stringify(annotation.worldPointM.map((v: number) => +v.toFixed(4)))} ` +
      `离真值 ${JSON.stringify(truth.map(v => +v.toFixed(4)))} 差 ${error.toFixed(4)} m`)
    const entry = sphereEntryPoint(CAMERA_HOME, truth, MARK_RADIUS_M)
    const surfaceError = Math.hypot(...annotation.worldPointM.map((value: number, i: number) => value - entry[i]))
    assert.ok(surfaceError <= 0.005, `标记 ${index} 反投影应落在球面前表面 ${JSON.stringify(entry.map(v => +v.toFixed(4)))}：` +
      `实测 ${JSON.stringify(annotation.worldPointM.map((v: number) => +v.toFixed(4)))} 差 ${surfaceError.toFixed(4)} m`)
    assert.ok(annotation.stepIndex === capture.stepIndex && annotation.generation === capture.generation)
    t.diagnostic(`标记 ${index} 反投影：到球心 ${(error * 1000).toFixed(1)} mm、到球面前表面 ${(surfaceError * 1000).toFixed(2)} mm`
      + `（世界点 ${JSON.stringify(annotation.worldPointM.map((v: number) => +v.toFixed(4)))}，`
      + `球心 ${JSON.stringify(truth.map((v: number) => +v.toFixed(4)))}，深度 ${annotation.depthM.toFixed(5)} m）`)
  }

  // 判据 3：换输出分辨率后 K 按引擎规则缩放，且同一标记像素满足 u₂ = 2·u₁ + 0.5、深度不变。
  const hiRes = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: 2 * k.width, height: 2 * k.height }) as any
  assert.ok(near(hiRes.calibration.intrinsics.fx, 1600, 1e-3) && near(hiRes.calibration.intrinsics.fy, 1800, 1e-3)
    && near(hiRes.calibration.intrinsics.cx, 620.5, 1e-3) && near(hiRes.calibration.intrinsics.cy, 500.5, 1e-3),
    `1280×960 生效 K: ${JSON.stringify(hiRes.calibration.intrinsics)}`)
  const zoomed = measureCapture(hiRes, marks)
  measured.blobs.forEach((blob, i) => {
    const other = zoomed.blobs[i]
    assert.ok(other !== null && (blob as Blob) !== null, `高清输出里标记 ${i} 没找到`)
    const low = blob as Blob, high = other as Blob
    assert.ok(near(high.u, 2 * low.u + 0.5, PIXEL_TOLERANCE) && near(high.v, 2 * low.v + 0.5, PIXEL_TOLERANCE),
      `标记 ${i} 分辨率对应关系: 640×480 (${low.u.toFixed(2)}, ${low.v.toFixed(2)}) → 1280×960 ` +
      `(${high.u.toFixed(2)}, ${high.v.toFixed(2)})，应为 (${(2 * low.u + 0.5).toFixed(2)}, ${(2 * low.v + 0.5).toFixed(2)})`)
    assert.ok(Math.abs(zoomed.depth.at(Math.round(high.u), Math.round(high.v)) - measured.depth.at(Math.round(low.u), Math.round(low.v))) <= 0.05,
      `标记 ${i} 两种分辨率下同一物理点的深度必须一致`)
  })
  t.diagnostic(correspondence(measured, zoomed))

  // 没有 K 的老相机：走 fovy 路径，回执如实标 'fovy'，不把未知像素尺度伪装成已知 K；
  // 像素实测确实是方形像素 + 画面中心主点。
  const free = list.cameras.find((c: any) => c.cameraName === 'cam-fov-t/cam-fov-t')
  const fovyFocal = 480 / (2 * Math.tan(22.5 * Math.PI / 180))
  assert.equal(free.intrinsicsSource, 'fovy', '没有 K 的相机不能被当成有声明 K')
  assert.equal(free.appliedIntrinsicsPx, undefined, '没有 K 就不该有 appliedIntrinsicsPx')
  assert.equal(free.declaredIntrinsicsPx, undefined)
  assert.equal(free.declaredLensMm, 35)
  assert.equal(free.declaredSensorWidthMm, 36)
  assert.ok(near(free.fovyDeg, 45, 1e-6) && near(free.intrinsics.fx, fovyFocal, 1e-6) && near(free.intrinsics.fy, fovyFocal, 1e-6)
    && near(free.intrinsics.cx, 319.5, 1e-9) && near(free.intrinsics.cy, 239.5, 1e-9),
    `fovy 相机的生效 K 应是方形像素 + 画面中心主点: ${JSON.stringify(free.intrinsics)}`)
  const fovCapture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-fov-t/cam-fov-t', width: k.width, height: k.height }) as any
  assert.equal(fovCapture.calibration.intrinsicsSource, 'fovy')
  const fovMeasured = assertMarkers(fovCapture, marks, 'fovy-45')
  assertFit(fovMeasured, free.intrinsics as K, 'fovy-45')
  t.diagnostic(summary(fovMeasured, 'fovy-45（无 K 老相机）'))
})

test('竖幅 K（480×640）与 960×1280 输出：像素回归与对应关系', { skip }, async t => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const k: K = { fx: 500, fy: 520, cx: 200, cy: 340, width: 480, height: 640 }
  const pose: Pose = { positionM: CAMERA_HOME, rotationMatrix: LOOK_PLUS_Y }
  const marks = markerMarks(pose)
  assertLayout(k, pose, marks, 'portrait-K')
  const handle = await provider.open(buildScene([
    cameraEntity('cam-portrait-t', CAMERA_HOME, LOOK_QUAT_XYZW, { direction: [0, 1, 0], isActive: true, intrinsics: k }),
    entity('marks-t', '标记', [0, 0, 0], [0, 0, 0, 1], markerEntity(marks)),
  ], 'scene-99-intrinsics-portrait'), { ground: false, worldId: 'w99-intrinsics-portrait' })
  t.after(async () => { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() })

  const capture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-portrait-t', width: k.width, height: k.height }) as any
  const intrinsics = capture.calibration.intrinsics
  assert.equal(capture.calibration.intrinsicsSource, 'engine-intrinsics')
  assert.ok(near(intrinsics.fx, 500, 1e-3) && near(intrinsics.fy, 520, 1e-3)
    && near(intrinsics.cx, 200, 1e-3) && near(intrinsics.cy, 340, 1e-3), `竖幅生效 K: ${JSON.stringify(intrinsics)}`)
  assert.ok(intrinsics.height > intrinsics.width && intrinsics.cx < (intrinsics.width - 1) / 2 && intrinsics.cy > (intrinsics.height - 1) / 2,
    `竖幅 + 光轴偏左下才是这一组: ${JSON.stringify(intrinsics)}`)
  const measured = assertMarkers(capture, marks, 'portrait-K')
  assertFit(measured, k, 'portrait-K')
  t.diagnostic(summary(measured, 'portrait-K 500/520/200/340'))

  const hiRes = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-portrait-t', width: 2 * k.width, height: 2 * k.height }) as any
  assert.ok(near(hiRes.calibration.intrinsics.fx, 1000, 1e-3) && near(hiRes.calibration.intrinsics.fy, 1040, 1e-3)
    && near(hiRes.calibration.intrinsics.cx, 400.5, 1e-3) && near(hiRes.calibration.intrinsics.cy, 680.5, 1e-3),
    `960×1280 生效 K: ${JSON.stringify(hiRes.calibration.intrinsics)}`)
  const zoomed = measureCapture(hiRes, marks)
  measured.blobs.forEach((blob, i) => {
    const other = zoomed.blobs[i]
    assert.ok(other !== null && (blob as Blob) !== null, `960×1280 里标记 ${i} 没找到`)
    const low = blob as Blob, high = other as Blob
    assert.ok(near(high.u, 2 * low.u + 0.5, PIXEL_TOLERANCE) && near(high.v, 2 * low.v + 0.5, PIXEL_TOLERANCE),
      `标记 ${i} 竖幅分辨率对应: (${low.u.toFixed(2)}, ${low.v.toFixed(2)}) → (${high.u.toFixed(2)}, ${high.v.toFixed(2)})`)
  })
  t.diagnostic(correspondence(measured, zoomed))
})

test('原生 MJCF 内参相机：focalpixel/principalpixel 不被改写、生效 K 按引擎约定、像素回归核对', { skip }, async t => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  // 引擎约定：fx_cfg=700、fy_cfg=720、principalpixel=(20, −15) → 光轴像素 = (319.5−20, 239.5+15) = (299.5, 254.5)。
  const k: K = { fx: 700, fy: 720, cx: 299.5, cy: 254.5, width: 640, height: 480 }
  const pose: Pose = { positionM: CAMERA_HOME, rotationMatrix: LOOK_PLUS_Y }
  const marks = markerMarks(pose)
  assertLayout(k, pose, marks, 'native-mjcf')
  const handle = await provider.open(buildScene([
    entity('robot-t', '机械臂', [0, 0, 0], [0, 0, 0, 1], mjcf('<mujoco><worldbody>' +
      '<body name="mount" pos="0 -3 1.2" quat="0.70710678 0.70710678 0 0">' +
      '<geom name="base" type="box" size="0.02 0.02 0.02" pos="0 -0.5 0"/>' +
      '<camera name="cam_native" resolution="640 480" sensorsize="0.036 0.027" focalpixel="700 720" principalpixel="20 -15"/>' +
      '</body></worldbody></mujoco>')),
    entity('marks-t', '标记', [0, 0, 0], [0, 0, 0, 1], markerEntity(marks)),
  ], 'scene-99-intrinsics-native'), { ground: false, worldId: 'w99-intrinsics-native' })
  t.after(async () => { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() })

  const native = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'robot-t/cam_native')
  assert.equal(native.cameraSource, 'mjcf', '原件来源不能被 Scene 装配路径改写')
  assert.equal(native.intrinsicsSource, 'engine-intrinsics', '自带 focalpixel/principalpixel 的原件就是内参相机')
  assert.equal(native.appliedIntrinsicsPx, undefined, '原件不是 Scene 声明 K，不该有 appliedIntrinsicsPx')
  assert.deepEqual(native.engineIntrinsics.resolution, [640, 480])
  assert.ok(near(native.engineIntrinsics.sensorSizeM[0], 0.036, 1e-6) && near(native.engineIntrinsics.sensorSizeM[1], 0.027, 1e-6))
  // 关键：配置值回读仍是原件的 700/720 与 principalpixel=(20, −15)——没有被改写成 fovy 或别的口径。
  assert.ok(near(native.engineIntrinsics.focalPixelConfigured[0], 700, 1e-3) && near(native.engineIntrinsics.focalPixelConfigured[1], 720, 1e-3),
    `原件焦距必须原样保留: ${JSON.stringify(native.engineIntrinsics.focalPixelConfigured)}`)
  assert.ok(near(native.engineIntrinsics.principalPixelConfigured[0], 20, 1e-3) && near(native.engineIntrinsics.principalPixelConfigured[1], -15, 1e-3),
    `原件 principalpixel 必须原样保留: ${JSON.stringify(native.engineIntrinsics.principalPixelConfigured)}`)
  assert.ok(near(native.intrinsics.fx, 700, 1e-3) && near(native.intrinsics.fy, 720, 1e-3)
    && near(native.intrinsics.cx, 299.5, 1e-3) && near(native.intrinsics.cy, 254.5, 1e-3),
    `生效 K 应是把原件配置换算成 CV 口径: ${JSON.stringify(native.intrinsics)}`)

  const capture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'robot-t/cam_native', width: 640, height: 480 }) as any
  assert.equal(capture.calibration.intrinsicsSource, 'engine-intrinsics')
  const measured = assertMarkers(capture, marks, 'native-mjcf')
  assertFit(measured, k, 'native-mjcf')
  t.diagnostic(summary(measured, 'native MJCF focalpixel 700/720 principalpixel 20/−15'))
})

test('camera_adjust：仅移位不改 K、只改 FOV 落在焦距上、clear 像素回原位（同一台 K 相机）', { skip }, async t => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const k: K = { fx: 800, fy: 900, cx: 310, cy: 250, width: 640, height: 480 }
  const pose: Pose = { positionM: CAMERA_HOME, rotationMatrix: LOOK_PLUS_Y }
  const marks = markerMarks(pose)
  assertLayout(k, pose, marks, 'adjust')
  const handle = await provider.open(buildScene([
    cameraEntity('cam-k-t', CAMERA_HOME, LOOK_QUAT_XYZW, { direction: [0, 1, 0], isActive: true, intrinsics: k }),
    entity('marks-t', '标记', [0, 0, 0], [0, 0, 0, 1], markerEntity(marks)),
  ], 'scene-99-intrinsics-adjust'), { ground: false, worldId: 'w99-intrinsics-adjust' })
  t.after(async () => { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() })

  const before = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: 640, height: 480 }) as any
  const start = assertMarkers(before, marks, 'adjust-before')
  assertFit(start, k, 'adjust-before')
  t.diagnostic(summary(start, 'adjust-before'))

  // (1) 仅移位：K 不变，实测像素与"移位后位姿 + 同一 K"的预测一致（世界参考系，明确固定世界位姿）。
  const shifted = await provider.adjustCamera(handle.worldId, {
    cameraName: 'cam-k-t/cam-k-t', expectedGeneration: before.generation, referenceFrame: 'world', positionM: [0.25, -3, 1.2],
  }) as any
  assert.equal(shifted.override, true)
  assert.equal(shifted.intrinsicsSource, 'engine-intrinsics')
  assert.equal(shifted.fovyApplied, undefined, '仅移位不该报 fovyApplied')
  assert.ok(near(shifted.intrinsicsAtReferenceResolution.fx, 800, 1e-3) && near(shifted.intrinsicsAtReferenceResolution.cx, 310, 1e-3)
    && near(shifted.worldFromCamera.positionM[0], 0.25, 1e-6),
    `仅移位后的回执: ${JSON.stringify(shifted.intrinsicsAtReferenceResolution)} @ ${JSON.stringify(shifted.worldFromCamera.positionM)}`)
  const shiftedCapture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: 640, height: 480 }) as any
  const shiftedMeasured = assertMarkers(shiftedCapture, marks, 'adjust-shifted')
  // 移位 0.25 m 在 3 m 深度上是 800·0.25/3 = 66.7 px 的真实位移；极值两点复原的主点仍是 310（不是 310+66.7）。
  assertFit(shiftedMeasured, k, 'adjust-shifted')
  start.blobs.forEach((blob, i) => {
    assert.ok(near((shiftedMeasured.blobs[i] as Blob).u, (blob as Blob).u - 800 * 0.25 / 3, 1.0),
      `标记 ${i} 移位后像素应整体左移 ${(800 * 0.25 / 3).toFixed(1)} px`)
  })

  // (2) 只改 FOV：内参相机上落在焦距上（fy' = 480/(2tan30°)、fx' 同比、主点不动），画面真实变窄。
  const zoomed = await provider.adjustCamera(handle.worldId, {
    cameraName: 'cam-k-t/cam-k-t', expectedGeneration: shifted.generation, fovyDeg: 60,
  }) as any
  assert.equal(zoomed.fovyApplied, 'intrinsic-focal-rescale')
  const expectedFy = 480 / (2 * Math.tan(30 * Math.PI / 180))
  assert.ok(near(zoomed.intrinsicsAtReferenceResolution.fy, expectedFy, 1e-3)
    && near(zoomed.intrinsicsAtReferenceResolution.cx, 310, 1e-3)
    // 像素长宽比不变：与调整前**逐位一致**（fx/fy 的浮点表达式相同），不是照抄 800/900 的比值。
    && Math.abs(zoomed.intrinsicsAtReferenceResolution.pixelAspectRatio - shifted.intrinsicsAtReferenceResolution.pixelAspectRatio) < 1e-12,
    `只改 FOV 后的生效 K: ${JSON.stringify(zoomed.intrinsicsAtReferenceResolution)}`)
  const fovCapture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: 640, height: 480 }) as any
  const fovMeasured = assertMarkers(fovCapture, marks, 'adjust-fov60')
  assert.ok(near(fovMeasured.k.fy, expectedFy, 1e-2), `帧标定 fy 应是 ${expectedFy.toFixed(3)}: ${fovMeasured.k.fy}`)
  // 像素实测的新焦距/主点（不是照抄回执）：极值两点复原应给出 (800·415.69/900, 310) = (369.5, 310)。
  const expectedFx = 800 * expectedFy / 900
  const fovFitX = fitAxis(fovMeasured, [0, 1, 2, 3], 'x')
  assert.ok(near(fovFitX.focal, expectedFx, expectedFx * FOCAL_RELATIVE_TOLERANCE) && near(fovFitX.principal, 310, PRINCIPAL_TOLERANCE),
    `只改 FOV 后像素实测 (fx, cx) = (${fovFitX.focal.toFixed(2)}, ${fovFitX.principal.toFixed(2)}) 应≈(${expectedFx.toFixed(2)}, 310)`)
  assert.ok(near(fitAxis(fovMeasured, [4, 5, 6, 7], 'y').focal, expectedFy, expectedFy * FOCAL_RELATIVE_TOLERANCE), '竖直方向同样落在新焦距上')
  t.diagnostic(summary(shiftedMeasured, 'adjust-after-0.25m-shift'))
  t.diagnostic(summary(fovMeasured, `adjust-fovy60（期望 fx=${expectedFx.toFixed(2)} fy=${expectedFy.toFixed(2)} cx=310 cy=250）`))

  // (3) clear：像素回到声明 K 的预测位（≤0.5 px 与 before 相同），K 逐项回到 800/900/310/250。
  const cleared = await provider.adjustCamera(handle.worldId, { cameraName: 'cam-k-t/cam-k-t', expectedGeneration: fovCapture.generation, clear: true }) as any
  assert.equal(cleared.cleared, true)
  assert.ok(near(cleared.calibration.intrinsics.fx, 800, 1e-3) && near(cleared.calibration.intrinsics.fy, 900, 1e-3)
    && near(cleared.calibration.intrinsics.cx, 310, 1e-3) && near(cleared.calibration.intrinsics.cy, 250, 1e-3))
  const restored = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-k-t/cam-k-t', width: 640, height: 480 }) as any
  const restoredMeasured = assertMarkers(restored, marks, 'adjust-cleared')
  start.blobs.forEach((blob, i) => {
    assert.ok(near((restoredMeasured.blobs[i] as Blob).u, (blob as Blob).u, PIXEL_TOLERANCE)
      && near((restoredMeasured.blobs[i] as Blob).v, (blob as Blob).v, PIXEL_TOLERANCE),
      `clear 后标记 ${i} 必须回到声明 K 下的原位：(${(blob as Blob).u.toFixed(2)}, ${(blob as Blob).v.toFixed(2)}) → ` +
      `(${(restoredMeasured.blobs[i] as Blob).u.toFixed(2)}, ${(restoredMeasured.blobs[i] as Blob).v.toFixed(2)})`)
  })
  assertFit(restoredMeasured, k, 'adjust-cleared')
  t.diagnostic(summary(restoredMeasured, 'adjust-cleared'))
})

test('K 相机跟随父体：静态旋转父 body 的挂载按真实像素核对，动态父 body 的 FK 与 K 都保持', { skip }, async t => {
  mkdirSync(outDir, { recursive: true })
  const provider = new MuJoCoProvider({ pythonPath: python })
  const k: K = { fx: 800, fy: 900, cx: 310, cy: 250, width: 640, height: 480 }
  // 静态父 body：位置 + 绕 Z 转 25°（挂载数学必须把父体旋转真正反解掉，否则像素会整体偏掉）。
  const pivotPosition: Vec3 = [0.6, -2.4, 0.9]
  const pivotRotation = rotationZ(25)
  const localMount: Vec3 = [0.25, 0.15, 0.35]
  const expectedPosition = pivotPosition.map((value, i) => value + pivotRotation[i].reduce((sum, v, j) => sum + v * localMount[j], 0)) as Vec3
  const expectedRotation = matMul(pivotRotation, LOOK_PLUS_Y)
  const expectedPose: Pose = { positionM: expectedPosition, rotationMatrix: expectedRotation }
  const marks = markerMarks(expectedPose)
  assertLayout(k, expectedPose, marks, 'mounted')
  const handle = await provider.open(buildScene([
    entity('pivot-t', '支架', pivotPosition, quatZ(25), collision([0.1, 0.1, 0.1])),
    cameraEntity('cam-mount-t', localMount, LOOK_QUAT_XYZW, { direction: [0, 1, 0], isActive: true, intrinsics: k }, 'pivot-t'),
    entity('marks-t', '标记', [0, 0, 0], [0, 0, 0, 1], markerEntity(marks)),
  ], 'scene-99-intrinsics-mount'), { ground: false, worldId: 'w99-intrinsics-mount' })
  t.after(async () => { await provider.close(handle.worldId).catch(() => {}); await provider.dispose() })

  const mounted = (await provider.listCameras(handle.worldId) as any).cameras.find((c: any) => c.cameraName === 'cam-mount-t/cam-mount-t')
  assert.equal(mounted.intrinsicsSource, 'engine-intrinsics')
  assert.ok(String(mounted.parentBodyName).startsWith('pivot-t/'), `挂载点是父实体的物理体: ${mounted.parentBodyName}`)
  assert.ok(mounted.worldFromCamera.positionM.every((value: number, i: number) => near(value, expectedPosition[i], 1e-6)),
    `挂载世界位置必须等于父体 TRS ∘ 局部安装位姿: ${JSON.stringify(mounted.worldFromCamera.positionM)} vs ${JSON.stringify(expectedPosition)}`)
  assert.ok(rowsClose(mounted.worldFromCamera.rotationMatrix, expectedRotation, 1e-6),
    `挂载世界朝向必须等于父体旋转 ∘ 局部朝向: ${JSON.stringify(mounted.worldFromCamera.rotationMatrix)}`)
  const capture = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: 'cam-mount-t/cam-mount-t', width: 640, height: 480 }) as any
  const measured = assertMarkers(capture, marks, 'mounted')
  assert.ok(near(measured.k.fx, 800, 1e-3) && near(measured.k.cx, 310, 1e-3), '挂载不改变 K')
  assertFit(measured, k, 'mounted')
  t.diagnostic(summary(measured, 'mounted（父体绕 Z 25°）'))

  // 动态父 body：自由落块的 FK。K 保持不变；位姿与同一步 observation 的父体位姿逐项闭合；
  // 真实帧确实换了画面；光轴像素的深度与回执位姿给出的墙面距离一致（渲染真的从新位姿出发）。
  const provider2 = new MuJoCoProvider({ pythonPath: python })
  const handle2 = await provider2.open(buildScene([
    entity('faller-t', '落块', [0, 4, 2], [0, 0, 0, 1], { rigidBody: { type: 'dynamic', massKg: 1 }, ...collision([0.25, 0.25, 0.25]) }),
    cameraEntity('cam-fall-t', [0, 0, 0.35], LOOK_QUAT_XYZW, { direction: [0, 1, 0], isActive: true, intrinsics: k }, 'faller-t'),
  ], 'scene-99-intrinsics-fall'), { ground: false, worldId: 'w99-intrinsics-fall' })
  t.after(async () => { await provider2.close(handle2.worldId).catch(() => {}); await provider2.dispose() })
  const falling = (await provider2.listCameras(handle2.worldId) as any).cameras.find((c: any) => c.cameraName === 'cam-fall-t/cam-fall-t')
  assert.equal(falling.intrinsicsSource, 'engine-intrinsics')
  const fallBefore = await provider2.capture(handle2.worldId, { outputDir: outDir, cameraName: 'cam-fall-t', width: 640, height: 480 }) as any
  await new Promise(resolve => setTimeout(resolve, 1600))
  const fallAfter = await provider2.capture(handle2.worldId, { outputDir: outDir, cameraName: 'cam-fall-t', width: 640, height: 480 }) as any
  const parent = fallAfter.observation.entities.find((e: any) => e.entityId === 'faller-t').transform
  const parentRotation = quatMatrixXYZW(parent.quaternion)
  const mountOffset: Vec3 = [0, 0, 0.35]
  const mountedPosition = mountOffset.map((value, i) => parent.position[i] + parentRotation[i].reduce((sum, v, j) => sum + v * mountOffset[j], 0))
  assert.ok(fallAfter.calibration.worldFromCamera.positionM[2] < fallBefore.calibration.worldFromCamera.positionM[2] - 0.5,
    `父体落下后相机必须跟着落: ${fallBefore.calibration.worldFromCamera.positionM[2]} → ${fallAfter.calibration.worldFromCamera.positionM[2]}`)
  assert.ok(fallAfter.calibration.worldFromCamera.positionM.every((value: number, i: number) => near(value, mountedPosition[i], 1e-6)),
    `下一帧位姿必须与同一步 observation 的父体位姿闭合: ${JSON.stringify(fallAfter.calibration.worldFromCamera.positionM)} vs ${JSON.stringify(mountedPosition)}`)
  assert.ok(rowsClose(fallAfter.calibration.worldFromCamera.rotationMatrix, matMul(parentRotation, LOOK_PLUS_Y), 1e-6))
  assert.ok(near(fallAfter.calibration.intrinsics.fx, 800, 1e-3) && near(fallAfter.calibration.intrinsics.fy, 900, 1e-3)
    && near(fallAfter.calibration.intrinsics.cx, 310, 1e-3) && near(fallAfter.calibration.intrinsics.cy, 250, 1e-3),
    `跟随父体不改变 K: ${JSON.stringify(fallAfter.calibration.intrinsics)}`)
  const after = decodePng(readFileSync(decodeURIComponent(new URL(fallAfter.rgb.uri).pathname)))
  const beforeImage = decodePng(readFileSync(decodeURIComponent(new URL(fallBefore.rgb.uri).pathname)))
  let total = 0
  for (let i = 0; i < after.pixels.length; i++) total += Math.abs(after.pixels[i] - beforeImage.pixels[i])
  assert.ok(total / after.pixels.length / 255 > 0.002, `落下后必须是新渲染: meanAbsDiff=${total / after.pixels.length / 255}`)
  const fallDepth = readDepth(decodeURIComponent(new URL(fallAfter.depth.uri).pathname), 640, 480)
  const own = fallAfter.calibration.worldFromCamera.positionM
  const wallDepth = 5.9 - own[1]
  assert.ok(Math.abs(fallDepth.at(310, 250) - wallDepth) <= 0.15,
    `光轴像素 (310,250) 的水平视线深度应为墙面 ${wallDepth.toFixed(2)} m，实际 ${fallDepth.at(310, 250)}`)
})
