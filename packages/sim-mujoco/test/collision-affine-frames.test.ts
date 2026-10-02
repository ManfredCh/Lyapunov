/**
 * 层级 TRS 的**完整仿射消费**在碰撞编译里的落点（真实 MuJoCo Python worker，无模型替身）。
 *
 * 背景（93 实测，报告原文见 93_blender_bounds_lifetime/REPORT.md）：非均匀父 scale + 子 90° 时
 * Scene→MuJoCo 的尺寸差 0.223607 m、任意角剪切差 0.256511 m；旧口径把父子 scale **逐轴相乘**
 * （`h ⊙ |s_parent ⊙ s_child|`），丢掉了子层旋转与父层非均匀缩放之间的换轴/剪切信息。层级 TRS
 * 完全能表达这些位形，缺的是消费方把父链组合成完整线性映射：
 *
 *   A = A_parent · R(q) · diag(s)（数据帧 → 世界），D = R(q_world)ᵀ · A（数据帧 → body 帧）
 *   声明几何（center/halfExtents/parts）都在**数据帧**，世界像 = M·几何 = (p, R(q_world))·(D·几何)
 *
 * 非均匀父 + 子旋转时 `D = R_eᵀ·S_p·R_e` 的非对角项就是剪切（父层旋转在 D 里约掉），逐轴相乘只是
 * 它的对角特例。本文件按上式**独立**算期望（只用声明值 + 父链 TRS，不调 worker 的映射函数），
 * 用真实落体/边界点核对：
 *   · 90° 轴交换：D=diag(1,2,0.5) 恰好对角，**保持原生 box** 且两轴长短按换轴后的轴分配；
 *     真值范围内外的两个探针分别停在板顶 / 落到地面（旧口径两处都反）。
 *   · 一般剪切（35°）：盒的像是斜平行六面体，用 8 角点凸网格（最小精确表达），停在**斜顶面**
 *     的真值高度；旧口径盒角落处的探针落到地面（不放大的轴对齐包围盒、不封通道）。
 *   · 圆柱：声明三元组是 [半径, 半长, 0]、几何轴是数据帧 z，半长按 |D e_z| 缩（旧口径乘 |v_y|，
 *     90° 换轴下长度会翻倍且朝错轴）；圆截面按 D 的像走——被拉成椭圆时改派生凸网格并在
 *     handle.warnings 交出偏差界（旧口径静默把 |v_x|·r 当半径，实测差 0.2~0.3 m）。
 *   · 动态子体：父链缩放只算一次，静止高度 = 台面顶 + 盒半高。
 *   · 球：D 各向同性 → 原生 sphere；球的像椭球 → 原生 ellipsoid（精确）；柱/胶囊的圆截面被
 *     拉成椭圆 → 派生凸网格（受控近似）；sdf 剪切仍按实体归因拒绝。
 * 角点级真值（93 真实夹具、真实 Blender matrixWorld 对照、通道语义、旧口径对照量）另见同目录
 * `collision_affine_frames_check.py`：本文件末尾会调用它并核对 CHECK_RESULT。
 *
 * 运行（产品 Host 是 Node）：
 *   LYAPUNOV_MUJOCO_PYTHON=<含 mujoco 的解释器> \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/collision-affine-frames.test.ts
 * `LYAPUNOV_MUJOCO_TEST_WORKER=<worker.py>` 可指向另一份 worker（例如修复前的版本）以确认本文件
 * 的用例确实会因该缺陷失败。未提供解释器（且仓内默认路径不存在）时整组 skip，不静默当成通过。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { MuJoCoProvider } from '../src/provider.ts'

const here = dirname(fileURLToPath(import.meta.url))
const defaultPython = resolve(here, '../../../.runtime/sim-python/bin/python')
const pythonPath = process.env.LYAPUNOV_MUJOCO_PYTHON ?? (existsSync(defaultPython) ? defaultPython : undefined)
const workerPath = process.env.LYAPUNOV_MUJOCO_TEST_WORKER ?? resolve(here, '../python/worker.py')
const checkerPath = resolve(here, 'collision_affine_frames_check.py')

type Vec3 = [number, number, number]
const quatToMatrix = (q: readonly number[]): number[][] => {
  const [x, y, z, w] = q as number[]
  const n = Math.hypot(x!, y!, z!, w!) || 1
  const [X, Y, Z, W] = [x! / n, y! / n, z! / n, w! / n]
  return [
    [1 - 2 * (Y * Y + Z * Z), 2 * (X * Y - Z * W), 2 * (X * Z + Y * W)],
    [2 * (X * Y + Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z - X * W)],
    [2 * (X * Z - Y * W), 2 * (Y * Z + X * W), 1 - 2 * (X * X + Y * Y)],
  ]
}
const matVec = (m: number[][], v: readonly number[]): Vec3 =>
  [0, 1, 2].map(i => m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!) as Vec3

/** 父链 TRS 组合 M = M_parent·T(p)·R(q)·S(s)：线性部分 + 世界位置（含父层累计缩放/镜像）。 */
function localFrame(entity: any, byId: Map<string, any>): { linear: number[][]; position: Vec3 } {
  const s = (entity.transform.scale ?? [1, 1, 1]) as Vec3
  const rotated = quatToMatrix(entity.transform.quaternion).map(row => row.map((v, j) => v * s[j]!))
  const local = entity.transform.position as Vec3
  if (!entity.parentId) return { linear: rotated, position: [...local] as Vec3 }
  const parent = localFrame(byId.get(entity.parentId), byId)
  const offset = matVec(parent.linear, local)
  return {
    linear: parent.linear.map(row => [0, 1, 2].map(j => row[0]! * rotated[0]![j]! + row[1]! * rotated[1]![j]! + row[2]! * rotated[2]![j]!)),
    position: [parent.position[0] + offset[0], parent.position[1] + offset[1], parent.position[2] + offset[2]] as Vec3,
  }
}

/** 数据帧点 → 世界（M·local，精确仿射像；不是逐轴相乘、也不取包围盒）。 */
const worldPoint = (entity: any, byId: Map<string, any>, local: readonly number[]): Vec3 => {
  const frame = localFrame(entity, byId)
  const mapped = matVec(frame.linear, local)
  return [frame.position[0] + mapped[0], frame.position[1] + mapped[1], frame.position[2] + mapped[2]] as Vec3
}

/** 声明盒（数据帧 center/halfExtents）的 8 个世界角点，顺序为 sx 最快…sz 最慢（index&1 = sz）。 */
const worldCorners = (entity: any, byId: Map<string, any>, center: Vec3, half: Vec3): Vec3[] =>
  [0, 1].flatMap(sx => [0, 1].flatMap(sy => [0, 1].map(sz =>
    worldPoint(entity, byId, [center[0] + (2 * sx - 1) * half[0], center[1] + (2 * sy - 1) * half[1], center[2] + (2 * sz - 1) * half[2]]))))

/** 盒顶面（数据帧 +z 的 4 个角点）的世界高度：本文件的位形都不含 z 混合，顶面是水平的平面。 */
const topFaceHeight = (corners: Vec3[]): number => {
  const top = corners.filter((_, index) => index & 1)
  const zs = top.map(corner => corner[2])
  assert.ok(Math.max(...zs) - Math.min(...zs) < 1e-9, `本用例的顶面应当是水平面，实测 z 跨度 ${Math.max(...zs) - Math.min(...zs)}`)
  return zs.reduce((sum, z) => sum + z, 0) / zs.length
}

const scene = (sceneId: string, entities: any[]) => ({
  sceneId, revision: 1,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities,
}) as any
const probe = (entityId: string, position: Vec3, half = 0.02) => ({
  entityId, name: entityId, transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  components: { collision: { shape: 'box', halfExtents: [half, half, half], center: [0, 0, 0] }, rigidBody: { type: 'dynamic', massKg: 1 } },
})
const rotZ = (degrees: number) => [0, 0, Math.sin((degrees * Math.PI) / 360), Math.cos((degrees * Math.PI) / 360)]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const suite = pythonPath ? describe : describe.skip
suite(pythonPath ? `碰撞消费完整仿射层级 TRS（真实 MuJoCo：${pythonPath}）` : '碰撞消费完整仿射层级 TRS（跳过：未提供 LYAPUNOV_MUJOCO_PYTHON，且仓内默认解释器不存在）', () => {
  const create = () => new MuJoCoProvider({ pythonPath: pythonPath!, workerPath })
  /** 轮询到全部被观察实体速度收敛（或超时），返回末帧。 */
  const settle = async (mujoco: MuJoCoProvider, worldId: string, ids: string[], timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    let frame: any = await mujoco.observe(worldId, { contacts: true, entityIds: ids })
    let stable = 0
    while (Date.now() < deadline) {
      await sleep(100)
      frame = await mujoco.observe(worldId, { contacts: true, entityIds: ids })
      stable = frame.entities.every((item: any) => Math.hypot(...(item.sensors?.bodyLinearVelocityMps ?? [0, 0, 0])) < 5e-3) ? stable + 1 : 0
      if (stable >= 3 && frame.simTime > 0.2) break
    }
    return frame
  }
  const restPosition = (frame: any, entityId: string): Vec3 =>
    frame.entities.find((item: any) => item.entityId === entityId).transform.position as Vec3

  // 93 的夹具形状：非均匀父 scale 在 xy 上把圆压成椭圆、把方盒拉成平行四边形；子层旋转 90° 时
  // D = R_eᵀ·S_p·R_e 恰好对角（换轴），任意角（35°）时留下真剪切。
  const parent = (scale: Vec3) => ({ entityId: 'parent', name: 'parent', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale }, components: {} })

  test('90° 轴交换：板顶真值边界内外两个探针分别停在板上、落到地面', async () => {
    // 父 scale (2,1,0.5) × 子 Rz90 ⇒ D = diag(1,2,0.5)：数据帧半长 (0.2,0.1,0.05) 的像，body 帧
    // 半长 = |v|⊙h = (0.2,0.2,0.025)（世界 0.4×0.4×0.05）；旧口径逐轴相乘给 (0.4,0.1,0.025)
    // 再经子层 Rz90 摆成世界 0.2×0.8×0.05 —— 两个方向都错（93 实测角点差 0.223607 m）。
    const mujoco = create()
    try {
      const half: Vec3 = [0.2, 0.1, 0.05]
      const center: Vec3 = [0, 0, 0]
      const plate = {
        entityId: 'plate', name: 'plate', parentId: 'parent',
        transform: { position: [0, 0, 0.8], quaternion: rotZ(90), scale: [1, 1, 1] },
        components: { collision: { shape: 'box', halfExtents: half, center } },
      }
      const entities = [parent([2, 1, 0.5]), plate]
      const byId = new Map(entities.map(item => [item.entityId, item]))
      const top = topFaceHeight(worldCorners(plate, byId, center, half))
      // 板内（数据帧 0.75·h）——body 帧 (0.15,0.15) 在真值半长 (0.2,0.2) 内、在旧口径半长 (0.4,0.1) 外；
      // 板外（body 帧 0.35 沿 x）——真值半长 0.2 之外（0.35>0.2，差 0.15）、旧口径 0.4 之内。
      const inside = worldPoint(plate, byId, [0.15, 0.075, 0.05])
      const outside = worldPoint(plate, byId, [0.35, 0, 0.05])
      const handle = await mujoco.open(scene('affine-turned-90', [
        ...entities,
        probe('onPlate', [inside[0], inside[1], top + 0.25]),
        probe('offPlate', [outside[0], outside[1], top + 0.25]),
      ]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['onPlate', 'offPlate'])
        const held = restPosition(frame, 'onPlate')
        const fallen = restPosition(frame, 'offPlate')
        assert.ok(Math.abs(held[2]! - (top + 0.02)) < 0.01,
          `板内探针停在 z=${held[2]!.toFixed(4)}，真值板顶 ${top.toFixed(4)} + 探针半高 0.02 = ${(top + 0.02).toFixed(4)}（旧口径此处是 0.2×0.8 的板，探针会掉到地面）`)
        assert.ok(Math.abs(fallen[2]! - 0.02) < 0.01,
          `板外探针停在 z=${fallen[2]!.toFixed(4)}，应当穿过真值边界落到地面 z≈0.02（旧口径的 0.2×0.8 板会把它托在 ${(top + 0.02).toFixed(4)}）`)
        assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('plate/geom')), '板内探针没有接触 plate 的碰撞 geom')
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('一般剪切（父非均匀 + 子 35°）：8 角点凸网格，探针停在斜顶面真值高度', async () => {
    const mujoco = create()
    try {
      const half: Vec3 = [0.2, 0.2, 0.01]
      const center: Vec3 = [0, 0, 0]
      const plate = {
        entityId: 'plate', name: 'plate', parentId: 'parent',
        transform: { position: [0, 0, 0.3], quaternion: rotZ(35), scale: [1, 1, 1] },
        components: { collision: { shape: 'box', halfExtents: half, center } },
      }
      const entities = [parent([2, 1, 0.5]), plate]
      const byId = new Map(entities.map(item => [item.entityId, item]))
      const corners = worldCorners(plate, byId, center, half)
      const top = topFaceHeight(corners)
      // 真值顶面是斜平行四边形：数据帧 0.6·h 的点在它内部（|0.12|<0.2 两轴）；数据帧 (0.25,0.1)
      // 在真值板外（|0.25|>0.2，世界差 0.087 m），却落在旧口径盒（body 帧半长 |s|⊙h=(0.4,0.2)，
      // 该点的 body 坐标 (0.371,0.015)）之内——旧口径会把它托在板顶并封住这块开口。
      const inside = worldPoint(plate, byId, [0.12, 0.12, 0.01])
      const oldCorner = worldPoint(plate, byId, [0.25, 0.1, 0.01])
      const handle = await mujoco.open(scene('affine-sheared-35', [
        ...entities,
        probe('onPlate', [inside[0], inside[1], top + 0.25]),
        probe('oldCorner', [oldCorner[0], oldCorner[1], top + 0.25]),
      ]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['onPlate', 'oldCorner'])
        const held = restPosition(frame, 'onPlate')
        const fallen = restPosition(frame, 'oldCorner')
        assert.ok(Math.abs(held[2]! - (top + 0.02)) < 0.01,
          `板内探针停在 z=${held[2]!.toFixed(4)}，真值斜顶面 ${top.toFixed(4)} + 0.02 = ${(top + 0.02).toFixed(4)}`)
        assert.ok(Math.abs(fallen[2]! - 0.02) < 0.01,
          `旧口径盒角处的探针停在 z=${fallen[2]!.toFixed(4)}，应当落到地面 z≈0.02（那里在真值平行四边形之外；把 8 角点换成放大的轴对齐盒会把它托住并封住通道）`)
        // 顶面是斜的：真值 4 个角点的 xy 构成平行四边形（长宽不同、不正交），不是轴对齐矩形。
        const span = [0, 1].map(axis => Math.max(...corners.map(corner => corner[axis]!)) - Math.min(...corners.map(corner => corner[axis]!)))
        assert.ok(Math.abs(span[0]! - span[1]!) > 0.05, `剪切位形的真值 xy 跨度应当明显不等（实测 ${span.map(v => v!.toFixed(4))}）`)
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('圆柱：半长按几何轴 |D e_z|、截面按 D 的像（圆被拉成椭圆时改派生凸网格，不静默保错半径）', async () => {
    // 声明三元组是 [半径, 半长, 0]、几何轴是数据帧 z：D=diag(1,2,0.5) 时世界半长 = 0.3·0.5 = 0.15。
    // 旧口径逐分量乘 |v|，半长乘到 |v_y|=2 上得到 0.6（世界 1.2），探针会停在 0.9 而不是 0.45。
    // D 还把半径 0.2 的圆截面拉成半轴 0.2(x)/0.4(y) 的椭圆：原生圆柱装不下它，改用 130 顶点的规范
    // 凸网格（顶点 = D·解析采样）。两个探针都落在**水平顶面**上：轴上一个（两种口径都在面内）与
    // 世界 y=0.25（椭圆内、旧半径 0.2 外）——后者停住正是"半径没被静默保成 0.2"的真接触证据。
    const mujoco = create()
    try {
      const cylinder = {
        entityId: 'cylinder', name: 'cylinder', parentId: 'parent',
        transform: { position: [0, 0, 0.6], quaternion: rotZ(90), scale: [1, 1, 1] },
        components: { collision: { shape: 'cylinder', halfExtents: [0.2, 0.3, 0.01] } },
      }
      const entities = [parent([2, 1, 0.5]), cylinder]
      const byId = new Map(entities.map(item => [item.entityId, item]))
      const axis = worldPoint(cylinder, byId, [0, 0, 0])
      const top = worldPoint(cylinder, byId, [0, 0, 0.3])[2]
      const offAxis = worldPoint(cylinder, byId, [0, 0.125, 0])       // 数据帧 y=0.125 → 世界 y=0.25
      const handle = await mujoco.open(scene('affine-cylinder', [...entities,
        probe('onTop', [axis[0], axis[1], top + 0.3]),
        probe('offAxis', [offAxis[0], offAxis[1], top + 0.3])]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['onTop', 'offAxis'])
        const pos = restPosition(frame, 'onTop')
        assert.ok(Math.abs(pos[2]! - (top + 0.02)) < 0.01,
          `探针停在 z=${pos[2]!.toFixed(4)}，真值柱顶 ${top.toFixed(4)} + 0.02 = ${(top + 0.02).toFixed(4)}（旧口径半长乘到 |v_y| 上，柱顶在 0.9）`)
        const lateral = restPosition(frame, 'offAxis')
        assert.ok(Math.abs(lateral[2]! - (top + 0.02)) < 0.01 && Math.abs(lateral[1]! - offAxis[1]!) < 0.05,
          `世界 y=0.25 的探针停在 z=${lateral[2]!.toFixed(4)}（真值 ${(top + 0.02).toFixed(4)}）——截面该处仍在椭圆内；`
          + `旧口径半径 0.2 的圆柱在这里没有面，探针会落到地面 z≈0.02`)
        assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('cylinder/geom')), '探针没有接触圆柱的碰撞 geom')
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('轴向单独缩放（父 s=(1,1,2) ⇒ D=diag(1,1,2)）：圆柱保持原生且轴可独立缩放（探针停在 1.62）、胶囊转派生网格（真值顶端 2.0，原生 Capsule 只到 1.8）', async () => {
    // 根 113 的真实编译反例（root-113-capsule-axis-scale-probe）：capsule r=0.2、half=0.3、D=diag(1,1,2) 时
    // 旧代码判"圆截面 + 轴正交"就返回原生 capsule size=[0.2,0.6]，顶端 half·2+r=0.8，而真值 |D e_z|·(half+r)=1.0，
    // 且不给任何 warning。根因：PhysX/MuJoCo 的原生胶囊尺寸里只有**柱段**半长、端部恒按半径生成半球——轴向
    // 单独缩放会把端部半球拉成椭球。圆柱没有端部曲面，轴可以独立缩放，这条原生路径必须保留（下面用
    // "结果高度对 + 无派生告警"两条一起钉住，而不是只看高度——派生网格也能给出对的高度）。
    // 量法：圆柱顶是真平面，放盒探针静置读高度；胶囊顶是曲面，量**首次接触**的高度（球心 = 顶端 + 球半径），
    // 接触那一帧就取，避免球随后从端部滚落。两个口径差 0.2 m，远大于容差。
    const mujoco = create()
    try {
      const ballRadius = 0.06
      const rigZ = { entityId: 'rigZ', name: 'rigZ', transform: { position: [0, 0, 1.0], quaternion: [0, 0, 0, 1], scale: [1, 1, 2] }, components: {} }
      const part = (entityId: string, shape: string, x: number) => ({
        entityId, name: entityId, parentId: 'rigZ',
        transform: { position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: { collision: { shape, halfExtents: [0.2, 0.3, 0] } },
      })
      const cyl = part('cylZ', 'cylinder', -0.5)
      const cap = part('capZ', 'capsule', 0.5)
      const apex = worldPoint(cap, new Map([[cap.entityId, cap], [rigZ.entityId, rigZ]]), [0, 0, 0.3 + 0.2])[2]!
      const top = worldPoint(cyl, new Map([[cyl.entityId, cyl], [rigZ.entityId, rigZ]]), [0, 0, 0.3])[2]!
      const ball = {
        entityId: 'capZBall', name: 'capZBall',
        transform: { position: [0.5, 0, apex + ballRadius + 0.05], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: { collision: { shape: 'sphere', halfExtents: [ballRadius, 0, 0], center: [0, 0, 0] }, rigidBody: { type: 'dynamic', massKg: 1 } },
      }
      const handle = await mujoco.open(scene('affine-axial-scale', [
        rigZ, cyl, cap, ball, probe('onCyl', [-0.5, 0, top + 0.25]),
      ]), { timestepS: 0.002, clock: 'realtime' })
      try {
        let contact: any = null
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !contact) {
          await sleep(20)
          const frame = await mujoco.observe(handle.worldId, { contacts: true, entityIds: ['capZBall'] })
          if ((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('capZ/geom'))) contact = frame
        }
        assert.ok(contact, `球在 8 s 内没有接到胶囊的碰撞 geom（真值顶端世界 z=${apex.toFixed(4)}）`)
        const touched = restPosition(contact, 'capZBall')[2]!
        assert.ok(Math.abs(touched - (apex + ballRadius)) < 0.03,
          `球首次接触时球心 z=${touched.toFixed(4)}，真值 = 顶端 ${apex.toFixed(4)} + 球半径 ${ballRadius} = ${(apex + ballRadius).toFixed(4)}`
          + `（旧口径原生 Capsule 的顶端在 1.8 上，球会多掉 0.2 m 才接上：${(apex - 0.2 + ballRadius).toFixed(4)}）`)
        const frame = await settle(mujoco, handle.worldId, ['onCyl'])
        const held = restPosition(frame, 'onCyl')[2]!
        assert.ok(Math.abs(held - (top + 0.02)) < 0.01,
          `圆柱顶探针停在 z=${held.toFixed(4)}，真值柱顶 ${top.toFixed(4)} + 0.02 = ${(top + 0.02).toFixed(4)}（轴可独立缩放，|D e_z|=2）`)
        const warnings = (handle.warnings ?? []) as any[]
        // 圆柱必须**没有**派生告警（原生路径保留）；胶囊必须有，且文案点明轴向缩放把端部半球拉成椭球。
        assert.equal(warnings.filter((item: any) => item.entityId === 'cylZ').length, 0,
          `D=diag(1,1,2) 下圆柱仍是原生 Cylinder（圆截面未变形、轴正交），不该有表示法告警：${JSON.stringify(warnings)}`)
        const capRow: any = warnings.find((item: any) => item.entityId === 'capZ')
        assert.ok(capRow, `胶囊的表示法说明必须随 handle.warnings 交出（${JSON.stringify(warnings)}）`)
        assert.equal(capRow.code, 'COLLISION_SHAPE_DERIVED_MESH', `胶囊的表示法 code 不符：${JSON.stringify(capRow)}`)
        assert.ok(/椭球/.test(capRow.message) && /轴向/.test(capRow.message),
          `胶囊的说明必须点明轴向单独缩放把端部半球拉成椭球（实测：${capRow.message}）`)
        // σ_max(D)=2、r=0.2 ⇒ 2·0.2·2.40860387e-3 = 9.63441548e-4；与 Python 检查器在同一 D 上读到的真编译读数逐位一致。
        assert.ok(Math.abs(capRow.maxSurfaceDeviationM - 9.634415480152648e-04) < 1e-12,
          `胶囊派生网格的偏差界应与 σ_max·r·矢高一致（实测 ${capRow.maxSurfaceDeviationM}）`)
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('动态子体（父非均匀 + 子 90°）：父链缩放只算一次，静止高度 = 台面顶 + 盒半高', async () => {
    const mujoco = create()
    try {
      const pad = {
        entityId: 'pad', name: 'pad', parentId: 'parent',
        transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: { collision: { shape: 'box', halfExtents: [0.3, 0.3, 0.05], center: [0, 0, 0.1] } },
      }
      const child = {
        entityId: 'child', name: 'child', parentId: 'parent',
        transform: { position: [0, 0, 0.5], quaternion: rotZ(90), scale: [1, 1, 1] },
        components: { collision: { shape: 'box', halfExtents: [0.15, 0.1, 0.05], center: [0, 0, 0] }, rigidBody: { type: 'dynamic', massKg: 1 } },
      }
      const entities = [parent([2, 1, 0.5]), pad, child]
      const byId = new Map(entities.map(item => [item.entityId, item]))
      const padCorners = worldCorners(pad, byId, [0, 0, 0.1], [0.3, 0.3, 0.05])
      const childCorners = worldCorners(child, byId, [0, 0, 0], [0.15, 0.1, 0.05])
      const rest = topFaceHeight(padCorners) + (Math.max(...childCorners.map(corner => corner[2])) - Math.min(...childCorners.map(corner => corner[2]))) / 2
      const handle = await mujoco.open(scene('affine-dynamic', entities), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['child'])
        const pos = restPosition(frame, 'child')
        assert.ok(Math.abs(pos[2]! - rest) < 0.01,
          `动态子体静止在 z=${pos[2]!.toFixed(4)}，真值台面顶 ${topFaceHeight(padCorners).toFixed(4)} + 盒半高 ${((Math.max(...childCorners.map(c => c[2])) - Math.min(...childCorners.map(c => c[2]))) / 2).toFixed(4)} = ${rest.toFixed(4)}`)
        assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('pad/geom')), '动态子体没有接触台面的碰撞 geom')
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('剪切位形下的球/柱/胶囊改派生凸网格（受控近似，偏差界随 handle.warnings 交出）；sdf 仍按实体归因拒绝', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'affine-shapes-'))
    const obj = resolve(dir, 'tetra.obj')
    writeFileSync(obj, 'v 0 0 0\nv 0.2 0 0\nv 0 0.2 0\nv 0 0 0.2\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n')
    const child = (collision: any) => ({
      entityId: 'child', name: 'child', parentId: 'parent',
      transform: { position: [0, 0, 0.4], quaternion: rotZ(35), scale: [1, 1, 1] },
      components: { collision },
    })
    for (const [label, collision, shape, radius] of [
      ['球', { shape: 'sphere', halfExtents: [0.2, 0, 0] }, 'ellipsoid', 0.2],
      ['圆柱', { shape: 'cylinder', halfExtents: [0.2, 0.3, 0] }, 'mesh', 0.2],
      ['胶囊', { shape: 'capsule', halfExtents: [0.2, 0.3, 0] }, 'mesh', 0.2],
    ] as Array<[string, any, string, number]>) {
      const mujoco = create()
      try {
        const handle = await mujoco.open(scene(`affine-shapes-${label}`, [parent([2, 1, 0.5]), child(collision)]),
          { timestepS: 0.002, clock: 'realtime' })
        try {
          // 球在任意可逆映射下的像都是椭球、MuJoCo 有原生 ellipsoid，这条是**精确**表达（偏差 0）；
          // 柱/胶囊的圆截面被拉成椭圆只能用规范凸网格，偏差界必须显式交出（σ_max·r·矢高）。
          // 表示法说明由 worker 放进 warning 对象（含 maxSurfaceDeviationM），比 WorldWarning 合同更宽：
          // 这里按运行时真实读数取用，不为了类型把偏差字段从告警里拿掉。
          const row: any = (handle.warnings ?? []).find((item: any) => item.entityId === 'child')
          assert.ok(row, `${label}的表示法说明必须随 handle.warnings 交出（${JSON.stringify(handle.warnings)}）`)
          assert.equal(row.code, shape === 'ellipsoid' ? 'COLLISION_SHAPE_ELLIPSOID' : 'COLLISION_SHAPE_DERIVED_MESH',
            `${label}的表示法 code 不符：${JSON.stringify(row)}`)
          // D=Rz35ᵀ·diag(2,1,0.5)·Rz35 的 σ_max ≈ 2.059 > 1：非均匀帧下"静默保 |v_x|·r"至少差 0.05 m。
          assert.ok(shape === 'ellipsoid' ? row.maxSurfaceDeviationM === 0 : row.maxSurfaceDeviationM > 0 && row.maxSurfaceDeviationM < 0.01,
            `${label}的偏差界不在受控范围：${row.maxSurfaceDeviationM}`)
          assert.ok(row.maxSurfaceDeviationM < 0.05,
            `${label}的偏差界必须远小于旧口径的错半径差 0.05 m（实测 ${row.maxSurfaceDeviationM}）`)
        } finally { await mujoco.close(handle.worldId) }
      } finally { await mujoco.dispose() }
    }
    const mujoco = create()
    try {
      await assert.rejects(
        () => mujoco.open(scene('affine-refuse-sdf', [parent([2, 1, 0.5]), child({ shape: 'sdf', parts: [pathToFileURL(obj).href] })]),
          { timestepS: 0.002, clock: 'realtime' }),
        (error: any) => error?.code === 'UNSUPPORTED_CAPABILITY' && String(error.message).includes('child'),
        '剪切位形下的 sdf 必须报带实体 id 的 UNSUPPORTED_CAPABILITY（不放大的包围盒也不静默近似）')
    } finally { await mujoco.dispose() }
  })

  test('角点级真值核对：同目录 Python 检查器（93 真实夹具 + 不受控近似对照）全部通过', async () => {
    assert.ok(existsSync(checkerPath), `缺少角点级检查器 ${checkerPath}`)
    const result = spawnSync(pythonPath!, [checkerPath], { env: process.env, encoding: 'utf8', timeout: 600_000 })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const payload = /CHECK_RESULT=(\{.*\})/s.exec(output)
    assert.ok(payload, `检查器没有输出 CHECK_RESULT（exit=${result.status}）：\n${output.slice(-2000)}`)
    const parsed = JSON.parse(payload![1]!)
    assert.equal(parsed.failed, 0, `${parsed.failed}/${parsed.total} 项角点核对失败：\n${parsed.rows.filter((row: any) => !row.ok).map((row: any) => `${row.name} — ${row.detail}`).join('\n')}`)
    assert.ok(parsed.total >= 27, `检查器用例数异常（${parsed.total}）`)
  })
})
