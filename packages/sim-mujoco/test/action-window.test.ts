/**
 * 定时动作窗口的终态语义（141，真实 MuJoCo worker，无模型替身）。
 *
 * 背景（139 MUJOCO-E4 实测）：小惯量 `<motor>` 夹具上用缺省增益做位置动作时，worker 把位置目标折成的
 * 显式 PD 力矩数值发散（dt·kd/M ≫ 2），MuJoCo 打印 `Nan, Inf or huge value in QACC ...` 并**自动重置
 * 整份 mjData**（time 归零、qpos/qvel 清空）。旧实现把动作窗口记在 `data.time` 之差上，重置后的时钟
 * 永远回不到窗口终点 → 动作永久 active、manual 时钟被永久持有（robot_move >300s 不返回、后续动作
 * WORLD_BUSY，j2 读数在两次采样间从 -1.605 跳到 4990.889）。
 *
 * 夹具 `arm-2joint.xml` 与 139 现场逐字节相同（sha256 9bc80c5ad04775bcb66ff197a7674355e12dac38da836d02f05e67ed3d0ef5ad，
 * 原件在 135 运行目录里未改动）；<motor> 是引擎侧固定增益力律，响应单位就是力矩，不是位置。
 *
 * 本文件锁四件事，全部按**外部可观测的回执**判定，不读 worker 内部字段：
 *   ① 发散窗口内动作必须给出明确终态（failed + SIMULATION_UNSTABLE + engineReset 实测事实），不无限等 targetReached；
 *   ② 终态后时钟必须释放：紧随其后的动作被接受（不再 WORLD_BUSY），世界 status 回到 ready；
 *   ③ position 执行器的合法位置动作仍真实收敛并有终态（不因这次修复被牵连）；
 *   ④ 力矩执行器在**可积分增益**下仍能正确按位置语义控制并真实收敛（能力没被屏蔽，也不是靠放宽容差）。
 *
 * 运行（产品 Host 是 Node；`@deepseek-ai/dsh-subprocess-local` 在 Bun 下加载即失败）：
 *   LYAPUNOV_MUJOCO_PYTHON=<含 mujoco 的解释器> \
 *     node --experimental-transform-types --test packages/sim-mujoco/test/action-window.test.ts
 * 可用 `LYAPUNOV_MUJOCO_TEST_WORKER=<worker.py>` 指向另一份 worker（例如修复前的版本）确认本文件的
 * ①②确实会因旧行为失败。未提供解释器（且仓内默认路径不存在）时整组 skip，不静默当成通过。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuJoCoProvider } from '../src/provider.ts'

const here = dirname(fileURLToPath(import.meta.url))
const defaultPython = resolve(here, '../../../.runtime/sim-python/bin/python')
const pythonPath = process.env.LYAPUNOV_MUJOCO_PYTHON ?? (existsSync(defaultPython) ? defaultPython : undefined)
const workerPath = process.env.LYAPUNOV_MUJOCO_TEST_WORKER ?? resolve(here, '../python/worker.py')
/** 139 现场同参：manual 时钟 + 0.002 步长；窗口 0.2s + 0.3s settle = 250 步。 */
const TORQUE_ARM = resolve(here, '../fixtures/arm-2joint.xml')
const POSITION_ARM = resolve(here, '../fixtures/arm.xml')
const FREE_BODY = resolve(here, '../fixtures/mounted-base-free-body.xml')
const TIMESTEP = 0.002
const WINDOW_STEPS = 250

const suite = pythonPath ? describe : describe.skip

function scene(sceneId: string, xmlPath: string, controller?: Record<string, unknown>) {
  return {
    sceneId, revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities: [{
      entityId: 'arm', name: 'arm',
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      resources: [{ resourceId: `${sceneId}-arm`, version: 1, original: { uri: `file://${xmlPath}`, mimeType: 'application/x-mjcf+xml' } }],
      components: { mujoco: {}, ...(controller ? { controller } : {}) },
    }],
  } as never
}

const jointMove = (actionId: string, names: string[], positions: number[], durationS = 0.2) =>
  ({ actionId, expectedGeneration: 1, kind: 'joint', entityId: 'arm', jointNames: names, positions, durationS }) as never

const observed = (frame: unknown) => (frame as { entities: Array<{ joints: { names: string[], positions: number[] } }> }).entities[0]!.joints
const positionOf = (joints: { names: string[], positions: number[] }, name: string) => {
  const index = joints.names.indexOf(name)
  assert.ok(index >= 0, `世界应报告关节 ${name}，实测 ${joints.names.join('/')}`)
  return joints.positions[index]!
}
/** 实测值与目标逐个关节对照：用世界自己的读数，不拿请求值当结果。 */
const assertReached = (joints: { names: string[], positions: number[] }, names: string[], targets: number[], tolerance: number) => {
  for (const [i, name] of names.entries()) {
    const measured = positionOf(joints, name)
    assert.ok(Math.abs(measured - targets[i]!) <= tolerance, `关节 ${name} 实测 ${measured} 未到 ${targets[i]}（容差 ${tolerance}）`)
  }
}

const create = () => new MuJoCoProvider({ pythonPath: pythonPath!, workerPath })

suite(pythonPath ? `定时动作窗口终态（真实 MuJoCo：${pythonPath}）` : '定时动作窗口终态（跳过：未提供 LYAPUNOV_MUJOCO_PYTHON，且仓内默认解释器不存在）', () => {
  test('自由根准备真实保留重力：第0步不自由落体，明确继续后实际下降，reset仍暂停', {timeout:15_000},async()=>{
    const mujoco=create(),snapshot:any=scene('prepared-free-body',FREE_BODY)
    snapshot.entities[0].components.mujoco={rootBody:'cube'}
    try {
      const w=await mujoco.open(snapshot,{worldId:'free-prepared',clock:'realtime',timestepS:TIMESTEP,ground:false,startPaused:true}),initial=await mujoco.observe(w.worldId)
      assert.equal(w.status,'paused');assert.equal(initial.stepIndex,0);assert.equal(initial.simTime,0)
      assert.equal(initial.worldPhysics?.gravityEnabled,true);assert.deepEqual(initial.worldPhysics?.gravityWorldMps2,[0,0,-9.81])
      const initialZ=initial.entities[0]!.transform.position[2]
      await new Promise(resolve=>setTimeout(resolve,100));const held=await mujoco.observe(w.worldId)
      assert.equal(held.stepIndex,0);assert.deepEqual(held.entities,initial.entities)
      const resumed=await mujoco.setPaused(w.worldId,false,w.worldGeneration)
      assert.equal(resumed.worldGeneration,w.worldGeneration);assert.equal(resumed.clock,'realtime')
      await new Promise(resolve=>setTimeout(resolve,100));const passive=await mujoco.observe(w.worldId)
      assert.ok(passive.stepIndex>0);assert.ok(passive.entities[0]!.transform.position[2]<initialZ-.005,'自由根在真实重力下下降，未锁根或关闭重力')
      await mujoco.setPaused(w.worldId,true,w.worldGeneration);const reset=await mujoco.sync(w.worldId,snapshot,{forceRebuild:true})
      await new Promise(resolve=>setTimeout(resolve,50));const fresh=await mujoco.observe(w.worldId)
      assert.equal(reset.status,'paused');assert.equal(fresh.generation,reset.worldGeneration);assert.equal(fresh.stepIndex,0);assert.equal(fresh.simTime,0)
      assert.deepEqual(fresh.entities[0]!.transform,initial.entities[0]!.transform)
      await mujoco.close(w.worldId)
      const normal=await mujoco.open(snapshot,{worldId:'free-normal',ground:false})
      assert.equal(normal.clock,'realtime');assert.notEqual(normal.status,'paused')
      await new Promise(resolve=>setTimeout(resolve,50));const normalFrame=await mujoco.observe(normal.worldId)
      assert.ok(normalFrame.stepIndex>0);assert.ok(normalFrame.entities[0]!.transform.position[2]<initialZ)
    } finally {await mujoco.dispose()}
  })
  test('首步前原子暂停：初始化与reset不推进，明确继续同世界后实际推进', { timeout: 15_000 }, async () => {
    const mujoco = create()
    try {
      const opened = await mujoco.open(scene('prepared-world', POSITION_ARM), {worldId:'prepared',clock:'realtime',timestepS:TIMESTEP,startPaused:true})
      assert.equal(opened.status,'paused');assert.equal(opened.clock,'realtime');assert.equal(opened.supportsPause,true)
      const initial = await mujoco.observe(opened.worldId,{sensors:true,contacts:true})
      await new Promise(resolve=>setTimeout(resolve,100))
      const held = await mujoco.observe(opened.worldId,{sensors:true,contacts:true})
      assert.equal(initial.stepIndex,0);assert.equal(held.stepIndex,0);assert.equal(held.simTime,0)
      assert.deepEqual(held.entities,initial.entities)
      const resumed = await mujoco.setPaused(opened.worldId,false,opened.worldGeneration)
      assert.equal(resumed.worldId,opened.worldId);assert.equal(resumed.worldGeneration,opened.worldGeneration);assert.equal(resumed.clock,'realtime')
      await new Promise(resolve=>setTimeout(resolve,100))
      const progressed = await mujoco.observe(opened.worldId)
      assert.ok(progressed.stepIndex>0);assert.ok(progressed.simTime>0)
      await mujoco.setPaused(opened.worldId,true,opened.worldGeneration)
      const reset = await mujoco.sync(opened.worldId,scene('prepared-world',POSITION_ARM),{forceRebuild:true})
      assert.equal(reset.status,'paused');assert.equal(reset.worldGeneration,opened.worldGeneration+1)
      await new Promise(resolve=>setTimeout(resolve,50))
      const fresh=await mujoco.observe(opened.worldId)
      assert.equal(fresh.generation,reset.worldGeneration);assert.equal(fresh.stepIndex,0);assert.equal(fresh.simTime,0)
      assert.deepEqual(observed(fresh).positions,observed(initial).positions)
    } finally {await mujoco.dispose()}
  })
  test('发散窗口：动作如实 failed（带自动重置事实），不无限等 targetReached', { timeout: 60_000 }, async () => {
    const mujoco = create()
    try {
      await mujoco.open(scene('window-unstable', TORQUE_ARM), { worldId: 'unstable', timestepS: TIMESTEP, clock: 'manual' })
      const before = observed(await mujoco.observe('unstable', { entityIds: ['arm'] }))
      const targets = ['j1', 'j2'].map(name => positionOf(before, name) + 0.05)
      const started = Date.now()
      const receipt = await mujoco.execute('unstable', jointMove('unstable-1', ['j1', 'j2'], targets)) as Record<string, any>
      const elapsedMs = Date.now() - started
      // 139 现场是 >300s 不返回；这里必须是有界终态（留足裕量，但仍远低于旧行为的量级）。
      assert.ok(elapsedMs < 10_000, `有界动作必须在窗口内给出终态，实测 ${elapsedMs}ms`)
      assert.equal(receipt.status, 'failed')
      assert.match(String(receipt.reason), /^SIMULATION_UNSTABLE/)
      const reset = receipt.engineReset
      assert.ok(reset, '失败回执必须带自动重置的实测事实')
      assert.equal(reset.timestepS, TIMESTEP)
      assert.ok(reset.simTimeAfterS < reset.simTimeBeforeS, `重置后物理钟必须退步：${reset.simTimeBeforeS} → ${reset.simTimeAfterS}`)
      assert.ok(reset.stepIndex > 0 && reset.stepIndex < WINDOW_STEPS, `重置应发生在窗口内：stepIndex=${reset.stepIndex}`)
      // maxAbsQacc 按名字就是非负幅值：直接断言正值，不再用 Math.abs 掩盖符号语义。
      assert.ok(typeof reset.maxAbsQacc === 'number' && reset.maxAbsQacc > 1e6,
        `重置前应有发散的加速度幅值（非负）：${reset.maxAbsQacc}`)
      assert.equal(reset.jointName, 'arm/j2')
      // 有效增益是实测解析出来的（缺省 120/4），不是照抄请求原文。
      assert.deepEqual(reset.torqueControllerGains.arm.j1, { kp: 120, kd: 4 })
      assert.deepEqual(reset.torqueControllerGains.arm.j2, { kp: 120, kd: 4 })
      // 未完成就不是完成：不得把没到的目标报成到了。
      assert.equal(receipt.effect.motions[0].targetReached, false)
      assert.equal(receipt.effect.motions[0].kind, 'joint')
      assert.equal(receipt.endStep, reset.stepIndex)
      assert.equal(receipt.taskAchieved, false)
    } finally { await mujoco.dispose() }
  })

  test('终态后时钟释放：紧随其后的动作被接受，不再 WORLD_BUSY', { timeout: 60_000 }, async () => {
    const mujoco = create()
    try {
      await mujoco.open(scene('window-release', TORQUE_ARM), { worldId: 'release', timestepS: TIMESTEP, clock: 'manual' })
      const before = observed(await mujoco.observe('release', { entityIds: ['arm'] }))
      const targets = ['j1', 'j2'].map(name => positionOf(before, name) + 0.05)
      const first = await mujoco.execute('release', jointMove('release-1', ['j1', 'j2'], targets)) as Record<string, any>
      assert.equal(first.status, 'failed')
      // 第一个动作已经终态：同一手动世界必须能继续接命令（旧行为在这里抛 WORLD_BUSY）。
      const second = await mujoco.execute('release', jointMove('release-2', ['j1', 'j2'], targets)) as Record<string, any>
      assert.equal(second.status, 'failed')
      assert.match(String(second.reason), /^SIMULATION_UNSTABLE/)
      // 时钟归世界自己：两个动作都结束后世界 status 回到 ready，不是被上一动作占着 running。
      const worlds = await mujoco.listWorlds()
      assert.equal(worlds.find(handle => handle.worldId === 'release')?.status, 'ready')
    } finally { await mujoco.dispose() }
  })

  test('position 执行器：合法位置动作真实收敛并结束', { timeout: 60_000 }, async () => {
    const mujoco = create()
    try {
      await mujoco.open(scene('window-position', POSITION_ARM), { worldId: 'position', timestepS: TIMESTEP, clock: 'manual' })
      const joints = observed(await mujoco.observe('position', { entityIds: ['arm'] }))
      const names = [...joints.names]
      const targets = names.map(name => positionOf(joints, name) + 0.08)
      const receipt = await mujoco.execute('position', jointMove('position-1', names, targets, 0.5)) as Record<string, any>
      assert.equal(receipt.status, 'completed')
      const motion = receipt.effect.motions[0]
      assert.equal(motion.targetReached, true, `位置执行器必须真实到目标：${JSON.stringify(motion.jointErrors)}`)
      assert.ok(receipt.endStep > 0)
      assertReached(observed(await mujoco.observe('position', { entityIds: ['arm'] })), names, targets, motion.tolerance)
    } finally { await mujoco.dispose() }
  })

  test('力矩执行器 + 可积分增益：位置语义仍正确控制并真实收敛', { timeout: 60_000 }, async () => {
    const mujoco = create()
    try {
      // 与 ① 同一份夹具、同一 kind、同一目标口径，只把标量 kd 换成本模型可积分的 0.2（不改夹具、不放宽容差）。
      await mujoco.open(scene('window-stable', TORQUE_ARM, { kd: 0.2 }), { worldId: 'stable', timestepS: TIMESTEP, clock: 'manual' })
      const joints = observed(await mujoco.observe('stable', { entityIds: ['arm'] }))
      // 只动 j2：这份夹具的 j1 与 base 圆柱在复位后有自接触摩擦（实测），位置语义在该自由度上不是自由运动。
      const target = positionOf(joints, 'j2') + 0.05
      const receipt = await mujoco.execute('stable', jointMove('stable-1', ['j2'], [target], 0.4)) as Record<string, any>
      assert.equal(receipt.status, 'completed')
      const motion = receipt.effect.motions[0]
      assert.equal(motion.targetReached, true, `可积分增益下必须收敛：${JSON.stringify(motion.jointErrors)}`)
      assertReached(observed(await mujoco.observe('stable', { entityIds: ['arm'] })), ['j2'], [target], motion.tolerance)
    } finally { await mujoco.dispose() }
  })
})
