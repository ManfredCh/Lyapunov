/**
 * 派生碰撞在**镜像/负缩放实体**下的编译与落点（真实 MuJoCo Python worker，无模型替身）。
 *
 * 背景（70 任务实测失败，原文见该任务 REPORT §6.4）：ENV-35 庭院门楼里 `石狮_西` 的实体变换是
 * 镜像帧 `scale=[-1,-1,-1]`，Agent 给它派生了与 `石狮_东` 同样的盒；`sim_open` 直接失败：
 *   `Error: size 0 must be positive in geom / Element name 'entity---_--f795d6ce/geom', id 30`
 * 原因是 worker 把实体累计 scale 同时乘进了**尺寸**，镜像把尺寸乘成了负数。
 *
 * 语义（本文件按此独立算期望，不调用 worker 的任何实现）：
 *   `M = M_parent · T(p) · R(q) · S(s)`，盒 `(c, h)` 的世界像 = 中心 `M·c`、边矢量 `M·(h_i e_i)`；
 *   故对轴对齐形状：**位置用带符号的 `s⊙c`、尺寸用逐轴正量 `|s|⊙h`**。
 *   只把位置取绝对值、或只把尺寸取绝对值都是错的：前者把偏心盒摆到镜像反侧，后者让引擎拒绝。
 *   `mesh/sdf` 分支相反——MuJoCo 的 mesh scale 接受负分量（顶点真的被反射），必须保留符号。
 *
 * 运行（产品 Host 是 Node；`@deepseek-ai/dsh-subprocess-local` 在 Bun 下加载即失败）：
 *   LYAPUNOV_MUJOCO_PYTHON=<含 mujoco 的解释器> \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/mirrored-collision.test.ts
 * `--experimental-transform-types` 是必需的：依赖链上的 `sim-contract/src/python-transport.ts`
 * 用了构造函数参数属性，Node 的 strip-only 模式（默认）会以 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 拒绝加载。
 * 未提供解释器（且仓内默认路径不存在）时整组 skip，不静默当成通过。
 * 可用 `LYAPUNOV_MUJOCO_TEST_WORKER=<worker.py>` 指向另一份 worker（例如修复前的版本），
 * 用来确认本文件的编译用例确实会因该缺陷失败。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { MuJoCoProvider } from '../src/provider.ts'

const here = dirname(fileURLToPath(import.meta.url))
const defaultPython = resolve(here, '../../../.runtime/sim-python/bin/python')
const pythonPath = process.env.LYAPUNOV_MUJOCO_PYTHON ?? (existsSync(defaultPython) ? defaultPython : undefined)
const workerPath = process.env.LYAPUNOV_MUJOCO_TEST_WORKER ?? resolve(here, '../python/worker.py')

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
const matVec = (m: number[][], v: readonly number[]): Vec3 => [0, 1, 2].map(i => m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!) as Vec3

/** 父链 TRS 组合：M = M_parent·T(p)·R(q)·S(s)；位置按父**累计** scale 缩放后随父旋转。 */
function worldPose(entity: any, byId: Map<string, any>): { linear: number[][]; position: Vec3; scale: Vec3 } {
  const s = (entity.transform.scale ?? [1, 1, 1]) as Vec3
  const rotated = quatToMatrix(entity.transform.quaternion).map(row => row.map((v, j) => v * s[j]!))
  const local = entity.transform.position as Vec3
  if (!entity.parentId) return { linear: rotated, position: [...local] as Vec3, scale: [...s] as Vec3 }
  const parent = worldPose(byId.get(entity.parentId), byId)
  const offset = matVec(parent.linear, local)
  return {
    linear: parent.linear.map(row => [0, 1, 2].map(j => row[0]! * rotated[0]![j]! + row[1]! * rotated[1]![j]! + row[2]! * rotated[2]![j]!)),
    position: [parent.position[0] + offset[0], parent.position[1] + offset[1], parent.position[2] + offset[2]],
    scale: [parent.scale[0] * s[0], parent.scale[1] * s[1], parent.scale[2] * s[2]] as Vec3,
  }
}

/** 局部盒（实体局部帧）的世界像：中心 M·c、半长 Σ_j |M_ij|·h_j（对含反射的 M 也成立）。 */
function worldBox(entity: any, byId: Map<string, any>, center: Vec3, half: Vec3) {
  const m = worldPose(entity, byId)
  return {
    center: [0, 1, 2].map(i => m.position[i]! + matVec(m.linear, center)[i]!) as Vec3,
    half: [0, 1, 2].map(i => Math.abs(m.linear[i]![0]!) * half[0]! + Math.abs(m.linear[i]![1]!) * half[1]! + Math.abs(m.linear[i]![2]!) * half[2]!) as Vec3,
  }
}

const scene = (sceneId: string, entities: any[]) => ({
  sceneId, revision: 1,
  coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
  entities,
}) as any
const probe = (entityId: string, position: Vec3, half = 0.05) => ({
  entityId, name: entityId, transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  components: { collision: { shape: 'box', halfExtents: [half, half, half], center: [0, 0, 0] }, rigidBody: { type: 'dynamic', massKg: 1 } },
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const suite = pythonPath ? describe : describe.skip
suite(pythonPath ? `派生碰撞·镜像/负缩放（真实 MuJoCo：${pythonPath}）` : '派生碰撞·镜像/负缩放（跳过：未提供 LYAPUNOV_MUJOCO_PYTHON，且仓内默认解释器不存在）', () => {
  const create = () => new MuJoCoProvider({ pythonPath: pythonPath!, workerPath })
  /** 轮询到探针速度收敛（或超时），返回末帧。 */
  const settle = async (mujoco: MuJoCoProvider, worldId: string, ids: string[], timeoutMs = 5000) => {
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

  // 镜像盒 + 偏心 centre：探针必须停在**镜像后**的盒顶面。abs(center) 的改法会把盒摆到反侧
  // （甚至原点下方），探针只能停在铺地，落点断言会失败。
  const mirroredCenter = 0.9
  for (const [name, scale, position, want] of [
    ['单轴负 -x', [-1, 1, 1], [0, 0, 0], [-mirroredCenter, 0]],
    ['三轴负（石狮形式）', [-1, -1, -1], [0, 0, 0.7], [-mirroredCenter, 0]],
  ] as Array<[string, Vec3, Vec3, [number, number]]>) {
    test(`镜像盒（${name}）编译并落在镜像后的顶面`, async () => {
      const mujoco = create()
      try {
        const target = {
          entityId: 'target', name: 'target', transform: { position, quaternion: [0, 0, 0, 1], scale },
          components: { collision: { shape: 'box', halfExtents: [0.5, 0.3, 0.2], center: [mirroredCenter, 0, 0.25] } },
        }
        const byId = new Map([[target.entityId, target]])
        const box = worldBox(target, byId, [mirroredCenter, 0, 0.25], [0.5, 0.3, 0.2])
        const handle = await mujoco.open(scene(`mirror-${name}`, [target, probe('probe', [want[0], want[1], 1.6])]), { timestepS: 0.002, clock: 'realtime' })
        try {
          const frame = await settle(mujoco, handle.worldId, ['probe'])
          const pos = frame.entities.find((e: any) => e.entityId === 'probe').transform.position as number[]
          assert.ok(Math.hypot(pos[0]! - want[0]!, pos[1]! - want[1]!, pos[2]! - (box.center[2]! + box.half[2]! + 0.05)) < 0.01,
            `落点 ${JSON.stringify(pos.map((v: number) => +v.toFixed(4)))} 不在镜像盒顶面（盒心 ${JSON.stringify(box.center.map(v => +v.toFixed(4)))} 半长 ${JSON.stringify(box.half.map(v => +v.toFixed(4)))}）`)
          assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('target/geom')), '探针没有接触 target 的碰撞 geom')
        } finally { await mujoco.close(handle.worldId) }
      } finally { await mujoco.dispose() }
    })
  }

  test('父链上的负缩放（180° 旋转的镜像父 + 子偏心盒）按实际几何对应', async () => {
    const mujoco = create()
    try {
      const entities = [
        { entityId: 'parent', name: 'parent', transform: { position: [1, 0, 0.6], quaternion: [0, 0, 1, 0], scale: [-1, -1, -1] }, components: {} },
        { entityId: 'target', name: 'child', parentId: 'parent', transform: { position: [0.4, 0, 0.1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, components: { collision: { shape: 'box', halfExtents: [0.15, 0.2, 0.15], center: [0.1, 0.2, 0.15] } } },
      ]
      const byId = new Map(entities.map(e => [e.entityId, e]))
      const box = worldBox(entities[1], byId, [0.1, 0.2, 0.15], [0.15, 0.2, 0.15])
      const handle = await mujoco.open(scene('mirror-parent', [...entities, probe('probe', [box.center[0], box.center[1], box.center[2] + box.half[2] + 0.3])]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['probe'])
        const pos = frame.entities.find((e: any) => e.entityId === 'probe').transform.position as number[]
        assert.ok(Math.abs(pos[2]! - (box.center[2]! + box.half[2]! + 0.05)) < 0.01, `探针停在 z=${pos[2]!.toFixed(4)}，期望 ${(box.center[2]! + box.half[2]! + 0.05).toFixed(4)}`)
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('compound 盒组（shapes[]）+ 单轴负缩放：逐盒落在镜像位置', async () => {
    const mujoco = create()
    try {
      const shapes = [{ center: [mirroredCenter, 0, 0.15], halfExtents: [0.2, 0.15, 0.15] }, { center: [mirroredCenter, 0.35, 0.15], halfExtents: [0.2, 0.15, 0.15] }]
      const target = { entityId: 'target', name: 'target', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] as Vec3 }, components: { collision: { shape: 'box', shapes } } }
      const handle = await mujoco.open(scene('mirror-compound', [target, probe('probe', [-mirroredCenter, 0, 1.6])]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['probe'])
        const pos = frame.entities.find((e: any) => e.entityId === 'probe').transform.position as number[]
        assert.ok(Math.hypot(pos[0]! + mirroredCenter, pos[1]!, pos[2]! - 0.35) < 0.01, `落点 ${JSON.stringify(pos.map((v: number) => +v.toFixed(4)))}，期望 [-0.9, 0, 0.35]`)
        assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('target/geom0')), '探针没有接触 compound 的第一个盒')
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('mesh 碰撞保留负 scale（顶点真的被反射，不取绝对值）', { timeout: 30_000 }, async () => {
    // 非对称盒网格 x∈[0,0.4]：镜像后应占 x∈[-0.4,0]，探针在 x=-0.2 落到网格顶面；
    // 若 mesh scale 被取绝对值，网格留在 x∈[0,0.4]，探针会掉到地面。
    const dir = mkdtempSync(resolve(tmpdir(), 'mirror-mesh-'))
    const obj = resolve(dir, 'asym-box.obj')
    const [x0, x1, y0, y1, z0, z1] = [0, 0.4, -0.2, 0.2, 0, 0.4]
    const vertex = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
    const faces = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]]
    writeFileSync(obj, vertex.map(v => `v ${v.join(' ')}`).join('\n') + '\n' + faces.map(f => `f ${f.map(i => i + 1).join(' ')}`).join('\n') + '\n')
    const mujoco = create()
    try {
      const target = {
        entityId: 'target', name: 'target', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] as Vec3 },
        components: { collision: { shape: 'mesh', parts: [pathToFileURL(obj).href] } },
      }
      const handle = await mujoco.open(scene('mirror-mesh', [target, probe('probe', [-0.2, 0, 0.5])]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['probe'])
        const pos = frame.entities.find((e: any) => e.entityId === 'probe').transform.position as number[]
        assert.ok(Math.abs(pos[2]! - 0.45) < 0.01, `探针停在 z=${pos[2]!.toFixed(4)}（0.45=网格顶面+探针半高），镜像被吞掉时它会落到地面 z≈0.05`)
        assert.ok((frame.contacts ?? []).some((c: any) => `${c.geom1}|${c.geom2}`.includes('target/geom0')), '探针没有接触网格 geom')
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })

  test('累计缩放含 0 分量：按实体归因拒绝，而不是引擎的无归因编译失败', async () => {
    const mujoco = create()
    try {
      await assert.rejects(
        () => mujoco.open(scene('mirror-zero', [{
          entityId: 'zeroed', name: 'zeroed', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [0, 1, 1] as Vec3 },
          components: { collision: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], center: [0, 0, 0] } },
        }]), { timestepS: 0.002, clock: 'realtime' }),
        (error: any) => error?.code === 'INVALID_ARGUMENT' && String(error.message).includes('zeroed'),
        '0 分量缩放必须报带实体 id 的 INVALID_ARGUMENT')
    } finally { await mujoco.dispose() }
  })

  test('正缩放回归：同一盒在 scale=[1,1,1] 下的落点与旧口径一致', async () => {
    const mujoco = create()
    try {
      const handle = await mujoco.open(scene('mirror-positive', [{
        entityId: 'target', name: 'target', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1.5, 1, 2] as Vec3 },
        components: { collision: { shape: 'box', halfExtents: [0.5, 0.3, 0.2], center: [mirroredCenter, 0, 0.25] } },
      }, probe('probe', [mirroredCenter * 1.5, 0, 1.6])]), { timestepS: 0.002, clock: 'realtime' })
      try {
        const frame = await settle(mujoco, handle.worldId, ['probe'])
        const pos = frame.entities.find((e: any) => e.entityId === 'probe').transform.position as number[]
        assert.ok(Math.hypot(pos[0]! - mirroredCenter * 1.5, pos[1]!, pos[2]! - 0.95) < 0.01, `落点 ${JSON.stringify(pos.map((v: number) => +v.toFixed(4)))}，期望 [1.35, 0, 0.95]`)
      } finally { await mujoco.close(handle.worldId) }
    } finally { await mujoco.dispose() }
  })
})
