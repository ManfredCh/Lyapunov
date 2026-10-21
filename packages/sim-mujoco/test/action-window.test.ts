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
// R-015 走真实产品实现 robot_set_base（setRobotBase）+ 真实 MuJoCo worker；SceneReader 用遵守
// 真实 Scene CAS 合同的最小内存适配器，不替身引擎、不替身物理。
import { setRobotBase } from '../../robot-tools/src/authoring.ts'
import { undoRobotAssembly } from '../../robot-tools/src/assembly-history.ts'

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
      // 显式声明一份不可积分的 PD（kp=120/kd=4）：纯力矩执行器没有默认增益，发散必须来自请求的显式事实。
      await mujoco.open(scene('window-unstable', TORQUE_ARM, { kp: 120, kd: 4 }), { worldId: 'unstable', timestepS: TIMESTEP, clock: 'manual' })
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
      // 有效增益是显式声明的请求值（不再有 worker 编造的 120/4 默认）。
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
      await mujoco.open(scene('window-release', TORQUE_ARM, { kp: 120, kd: 4 }), { worldId: 'release', timestepS: TIMESTEP, clock: 'manual' })
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
      // 与 ① 同一份夹具、同一 kind、同一目标口径，只把显式增益换成本模型可积分的 kp=120/kd=0.2（不改夹具、不放宽容差）。
      await mujoco.open(scene('window-stable', TORQUE_ARM, { kp: 120, kd: 0.2 }), { worldId: 'stable', timestepS: TIMESTEP, clock: 'manual' })
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

  /**
   * G1 23DOF 类事实：源模型只有纯 `<motor>`，且 controller 没声明任何 PD 增益。位置闭环需要控制器
   * 事实，worker 不得凭经验补默认值。这里锁两件事：① describe 不伪造 driveStiffness/driveDamping；
   * ② 位置动作在受理前就被明确拒绝（错误码 TORQUE_ACTUATOR_POSITION_GAINS_REQUIRED），且拒绝不占时钟。
   */
  test('纯力矩执行器无显式增益：位置通道明确拒绝，不伪造 drive 读数', { timeout: 30_000 }, async () => {
    const mujoco = create()
    try {
      await mujoco.open(scene('window-nogain', TORQUE_ARM), { worldId: 'nogain', timestepS: TIMESTEP, clock: 'manual' })
      const described = await mujoco.describe('nogain', 'arm') as Record<string, any>
      const j1 = (described.joints as Array<Record<string, any>>).find(joint => joint.name === 'j1')!
      assert.equal(j1.controlMode, 'torque')
      assert.equal('driveStiffness' in j1, false, '无显式增益时不得报出编造的 driveStiffness')
      assert.equal('driveDamping' in j1, false, '无显式增益时不得报出编造的 driveDamping')
      const before = observed(await mujoco.observe('nogain', { entityIds: ['arm'] }))
      const target = positionOf(before, 'j2') + 0.05
      await assert.rejects(
        () => mujoco.execute('nogain', jointMove('nogain-1', ['j2'], [target])),
        (error: any) => error?.code === 'TORQUE_ACTUATOR_POSITION_GAINS_REQUIRED',
      )
      // 拒绝不得把世界留在 running：时钟未被占用，下一次动作仍可受理。
      const worlds = await mujoco.listWorlds()
      assert.notEqual(worlds.find(handle => handle.worldId === 'nogain')?.status, 'running')
    } finally { await mujoco.dispose() }
  })

  // ---- 基座绑定装配边界（problem 3/4 修复回归；真实 MuJoCo worker，无模型替身）----
  const inlineBody = (name: string) => `<mujoco><worldbody><body name="${name}"><geom type="box" size=".08 .08 .08" mass="1"/></body></worldbody></mujoco>`
  const bindingEntity = (entityId: string, body: string, components: Record<string, unknown> = {}) => ({
    entityId, name: entityId,
    transform: { position: [0, 0, entityId === 'parent' ? 1 : 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [], components: { mujoco: { rootBody: body, xml: inlineBody(body) }, ...components },
  })
  const bindingSnapshot = (sceneId: string, entities: unknown[]) => ({
    sceneId, revision: 1,
    coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
    entities,
  }) as never
  const fixedBinding = (body: string, target: Record<string, unknown>) => ({ mode: 'fixed', bodyName: body, target })
  const rigidTarget = { entityId: 'parent', bodyName: 'base', positionM: [0, 0, 0.25], quaternionXyzw: [0, 0, 0, 1] }

  test('fixed+实体body：正序/反序导入都是原生刚性父子（无 weld，相对位姿正确）', { timeout: 30_000 }, async () => {
    const mujoco = create()
    try {
      const cases: Array<{ worldId: string; entities: unknown[] }> = [
        { worldId: 'binding-forward', entities: [bindingEntity('parent', 'base'), bindingEntity('child', 'mount', { baseBinding: fixedBinding('mount', { ...rigidTarget }) })] },
        { worldId: 'binding-reverse', entities: [bindingEntity('child', 'mount', { baseBinding: fixedBinding('mount', { ...rigidTarget }) }), bindingEntity('parent', 'base')] },
      ]
      for (const { worldId, entities } of cases) {
        await mujoco.open(bindingSnapshot(worldId, entities), { worldId, clock: 'manual', startPaused: true, ground: false })
        const desc = await mujoco.describe(worldId, 'child') as Record<string, any>
        assert.equal(desc.base.mode, 'fixed')
        assert.equal(desc.base.target.entityId, 'parent')
        assert.deepEqual(desc.base.constraints, [], '刚性父子不得再挂 equality weld 软约束')
        assert.ok(Math.abs(desc.base.worldFromBody.positionM[2] - 1.25) < 1e-9,
          `child 世界高度应为 parent(z=1)+0.25，实测 ${JSON.stringify(desc.base.worldFromBody.positionM)}`)
        await mujoco.close(worldId)
      }
    } finally { await mujoco.dispose() }
  })

  test('自指/缺目标实体/缺目标 body/target 环：按原错误码明确拒绝', { timeout: 30_000 }, async () => {
    const mujoco = create()
    try {
      const anchor = { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] }
      const cases: Array<{ worldId: string; code: string; entities: unknown[] }> = [
        { worldId: 'binding-self', code: 'ROBOT_BASE_TARGET_MISSING', entities: [bindingEntity('solo', 'base', { baseBinding: fixedBinding('base', { entityId: 'solo', bodyName: 'base', ...anchor }) })] },
        { worldId: 'binding-ghost', code: 'ROBOT_BASE_TARGET_MISSING', entities: [bindingEntity('child', 'mount', { baseBinding: fixedBinding('mount', { entityId: 'ghost', bodyName: 'base', ...anchor }) })] },
        { worldId: 'binding-nobody', code: 'ROBOT_BASE_TARGET_MISSING', entities: [bindingEntity('parent', 'base'), bindingEntity('child', 'mount', { baseBinding: fixedBinding('mount', { entityId: 'parent', bodyName: 'nope', ...anchor }) })] },
        { worldId: 'binding-cycle', code: 'ROBOT_BASE_BINDING_CYCLE', entities: [bindingEntity('a', 'base', { baseBinding: fixedBinding('base', { entityId: 'b', bodyName: 'base', ...anchor }) }), bindingEntity('b', 'base', { baseBinding: fixedBinding('base', { entityId: 'a', bodyName: 'base', ...anchor }) })] },
      ]
      for (const { worldId, code, entities } of cases) {
        await assert.rejects(
          () => mujoco.open(bindingSnapshot(worldId, entities), { worldId, clock: 'manual', startPaused: true, ground: false }),
          (error: any) => error?.code === code,
          `${worldId} 必须以 ${code} 拒绝`,
        )
      }
    } finally { await mujoco.dispose() }
  })

  test('free+实体目标：保留真实 equality weld，描述不冒充刚性', { timeout: 30_000 }, async () => {
    const mujoco = create()
    try {
      const worldId = 'binding-free-weld'
      await mujoco.open(bindingSnapshot(worldId, [
        bindingEntity('parent', 'base'),
        bindingEntity('child', 'mount', { baseBinding: { mode: 'free', bodyName: 'mount', initialWorldPose: { entityId: 'parent', bodyName: 'base', positionM: [0, 0, 0.25], quaternionXyzw: [0, 0, 0, 1] } } }),
      ]), { worldId, clock: 'manual', startPaused: true, ground: false })
      const desc = await mujoco.describe(worldId, 'child') as Record<string, any>
      assert.ok(desc.base.constraints.some((c: any) => c.kind === 'weld' && c.targetEntityId === 'parent'), 'free+目标必须有真实 equality weld')
      assert.match(String(desc.base.reason), /weld/i)
      assert.doesNotMatch(String(desc.base.reason), /Rigid/i)
    } finally { await mujoco.dispose() }
  })

  /**
   * R-015：独立子实体根以 fixed 原生刚性挂到另一实体 body 后，它仍是**该实体自己的可编辑根**
   * （不是 world 树根，但仍是该实体的源根），内部 body 仍不是根。这里经真实 `setRobotBase`
   * （robot_set_base 的实现）依次执行 free→source→换目标：每次按当前 Scene 版本 CAS 提交、
   * 真实 worker 重建世界，再按**当前版本**回读实体根标记、真实基座模式与目标 body / 相对位姿。
   * 同时保留负回归：内部 body 仍被 ROBOT_BASE_ROOT_REQUIRED 明确拒绝。
   */
  const childRootXml = '<mujoco><worldbody><body name="mount"><geom type="box" size=".08 .08 .08" mass="1"/>'
    + '<body name="finger" pos="0 0 .2"><joint name="fj" type="hinge"/><geom type="box" size=".03 .03 .03" mass=".2"/></body>'
    + '</body></worldbody></mujoco>'
  const parentRootXml = '<mujoco><worldbody><body name="base"><geom type="box" size=".1 .1 .1" mass="2"/>'
    + '<body name="tool" pos=".3 0 .1"><geom type="box" size=".05 .05 .05" mass=".5"/></body>'
    + '</body></worldbody></mujoco>'
  const namedEntity = (entityId: string, z: number, rootBody: string, xml: string, components: Record<string, unknown> = {}) => ({
    entityId, name: entityId,
    transform: { position: [0, 0, z], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [], components: { mujoco: { rootBody, xml }, ...components },
  })

  test('已装配独立根再次编辑：free/source/换目标读回真实根，内部 body 仍非根', { timeout: 60_000 }, async () => {
    const mujoco = create()
    const sceneId = 'r015-rebind'
    const initial = bindingSnapshot(sceneId, [
      namedEntity('parent', 1, 'base', parentRootXml),
      namedEntity('child', 0, 'mount', childRootXml, { baseBinding: fixedBinding('mount', { ...rigidTarget }) }),
    ])
    let snapshot: any = initial
    // 最小 SceneReader：实现真实 Scene CAS 语义（提交必须基于当前 revision，成功后 revision+1），
    // 不伪造冲突放行；setRobotBase 会在 CAS/世界代次/帧版本不一致时明确失败。
    const store = {
      snapshot: (id: string) => { assert.equal(id, sceneId); return structuredClone(snapshot) },
      commit: (input: any) => {
        assert.equal(input.sceneId, sceneId)
        assert.equal(input.expectedRevision, snapshot.revision, 'CAS：提交必须基于当前场景版本')
        const next = structuredClone(snapshot)
        for (const op of input.patch) {
          assert.equal(op.op, 'update')
          const index = next.entities.findIndex((entity: any) => entity.entityId === op.entityId)
          assert.ok(index >= 0, `patch 目标实体必须存在：${op.entityId}`)
          next.entities[index] = { ...next.entities[index], ...structuredClone(op.changes) }
        }
        next.revision = snapshot.revision + 1
        snapshot = next
        return structuredClone(snapshot)
      },
    }
    const baseInput = (expectedRevision: number, expectedGeneration: number, base: unknown) =>
      ({ worldId: sceneId, sceneId, entityId: 'child', expectedRevision, expectedGeneration, base } as never)
    const bodyWith = (description: Record<string, any>, name: string) => description.nativeBodies.find((body: any) => body.name === name)
    try {
      const opened = await mujoco.open(snapshot, { worldId: sceneId, clock: 'manual', startPaused: true, ground: false })
      // 装配事实 + 复现点：已挂接后实体源根必须仍标记 root，内部 body 不得冒充根。
      const assembled = await mujoco.describe(sceneId, 'child') as Record<string, any>
      assert.equal(assembled.base.mode, 'fixed')
      assert.equal(assembled.base.target.entityId, 'parent')
      assert.equal(assembled.base.target.bodyName, 'base')
      assert.deepEqual(assembled.base.constraints, [], '刚性父子不得挂 equality weld 软约束')
      assert.equal(bodyWith(assembled, 'mount').root, true, '已装配实体源根必须仍是该实体的可编辑根')
      assert.equal(bodyWith(assembled, 'finger').root, false, '内部 body 不得被当成根')
      assert.deepEqual(bodyWith(assembled, 'finger').jointTypes, ['hinge'], '装配不得删除实体内部关节')

      // ① 再次 free：经真实 robot_set_base 解除固定。
      const freed = await setRobotBase(mujoco, store as never, baseInput(1, opened.worldGeneration, { mode: 'free', bodyName: 'mount' }))
      assert.equal(freed.snapshot.revision, 2)
      const freeDesc = freed.robot as Record<string, any>
      assert.equal(freeDesc.base.mode, 'free')
      assert.deepEqual(bodyWith(freeDesc, 'mount').jointTypes, ['free'], 'free 后根必须有真实自由关节')
      assert.equal(bodyWith(freeDesc, 'mount').root, true)
      assert.equal(bodyWith(freeDesc, 'finger').root, false)

      // ② 再次 source：恢复源声明（本夹具源模型无关节 ⇒ 世界安装 fixed），删除场景基座声明。
      const sourced = await setRobotBase(mujoco, store as never, baseInput(2, freed.world!.worldGeneration, { mode: 'source', bodyName: 'mount' }))
      assert.equal(sourced.snapshot.revision, 3)
      const childAfterSource = sourced.snapshot.entities.find((entity: any) => entity.entityId === 'child')!
      assert.equal('baseBinding' in childAfterSource.components, false, 'source 必须删除场景基座声明')
      assert.equal(bodyWith(sourced.robot as Record<string, any>, 'mount').root, true)

      // ③ 换挂：fixed 到同一父实体的另一个真实 body（tool），按当前版本读回目标与相对位姿。
      const target = { entityId: 'parent', bodyName: 'tool', positionM: [0.1, 0, 0.2], quaternionXyzw: [0, 0, 0, 1] }
      const rebased = await setRobotBase(mujoco, store as never, baseInput(3, sourced.world!.worldGeneration, { mode: 'fixed', bodyName: 'mount', target }))
      assert.equal(rebased.snapshot.revision, 4)
      const rebasedDesc = rebased.robot as Record<string, any>
      assert.equal(rebasedDesc.base.mode, 'fixed')
      assert.equal(rebasedDesc.base.target.entityId, 'parent')
      assert.equal(rebasedDesc.base.target.bodyName, 'tool')
      assert.deepEqual(rebasedDesc.base.constraints, [])
      assert.equal(bodyWith(rebasedDesc, 'mount').root, true)
      assert.equal(bodyWith(rebasedDesc, 'finger').root, false)
      assert.deepEqual(bodyWith(rebasedDesc, 'finger').jointTypes, ['hinge'], '再次编辑不得删除实体内部关节')
      // parent(z=1) ∘ tool 局部(.3,0,.1) ∘ 安装(.1,0,.2) ⇒ 世界 (.4,0,1.3)。
      const readback = rebasedDesc.base.worldFromBody.positionM
      assert.ok(Math.abs(readback[0] - 0.4) < 1e-9 && Math.abs(readback[1]) < 1e-9 && Math.abs(readback[2] - 1.3) < 1e-9,
        `换挂后应读回真实目标位姿，实测 ${JSON.stringify(readback)}`)

      // 负回归：内部 body 仍被明确拒绝（修复不得放宽成任意 body 都可当根）。
      await assert.rejects(
        () => setRobotBase(mujoco, store as never, baseInput(4, rebased.world!.worldGeneration, { mode: 'free', bodyName: 'finger' })),
        (error: any) => /ROBOT_BASE_ROOT_REQUIRED/.test(String(error?.message)),
        '内部 body 必须仍以 ROBOT_BASE_ROOT_REQUIRED 拒绝',
      )
    } finally { await mujoco.dispose() }
  })

  /**
   * R-014：已固定挂接的独立根在真实 MuJoCo 上直接走 robot_set_base → 局部 Undo，而不是只在 free
   * 状态下测试。局部 Undo 复用既有 SceneStore 历史的 before/after 定位（本测试的内存 store 与真实
   * SceneStore 同 CAS/历史语义），按当前 revision 只回填 baseBinding，再经同一 provider 链同步回读；
   * source 是删除源声明的**不同语义**；换目标后再撤销旧事件必须报 ROBOT_ASSEMBLY_CONFLICT。
   */
  test('已装配后局部 Undo：真实回读 fixed/source/换目标，冲突拒绝且不删内部关节', { timeout: 90_000 }, async () => {
    const mujoco = create()
    const sceneId = 'r014-undo'
    const initial = bindingSnapshot(sceneId, [
      namedEntity('parent', 1, 'base', parentRootXml),
      namedEntity('child', 0, 'mount', childRootXml, { baseBinding: fixedBinding('mount', { ...rigidTarget }) }),
    ])
    let snapshot: any = initial
    const history = new Map<number, any>()
    // 与真实 SceneStore 同口径：提交前把当前完整快照记入不可变历史，再写新 revision。
    const store = {
      snapshot: (id: string) => { assert.equal(id, sceneId); return structuredClone(snapshot) },
      commit: (input: any) => {
        assert.equal(input.sceneId, sceneId)
        assert.equal(input.expectedRevision, snapshot.revision, 'CAS：提交必须基于当前场景版本')
        history.set(snapshot.revision, structuredClone(snapshot))
        const next = structuredClone(snapshot)
        for (const op of input.patch) {
          assert.equal(op.op, 'update')
          const index = next.entities.findIndex((entity: any) => entity.entityId === op.entityId)
          assert.ok(index >= 0, `patch 目标实体必须存在：${op.entityId}`)
          next.entities[index] = { ...next.entities[index], ...structuredClone(op.changes) }
        }
        next.revision = snapshot.revision + 1
        snapshot = next
        return structuredClone(snapshot)
      },
      versions: (id: string) => [...new Set([...history.keys(), snapshot.revision])].sort((left, right) => left - right).map(revision => ({ sceneId: id, revision, current: revision === snapshot.revision })),
      version: (id: string, revision: number) => {
        if (revision === snapshot.revision) return structuredClone(snapshot)
        const found = history.get(revision)
        if (!found) throw new Error(`SCENE_VERSION_NOT_FOUND: ${id}@${revision}`)
        return structuredClone(found)
      },
    }
    const baseInput = (expectedRevision: number, expectedGeneration: number, base: unknown) =>
      ({ worldId: sceneId, sceneId, entityId: 'child', expectedRevision, expectedGeneration, base } as never)
    const bodyWith = (description: Record<string, any>, name: string) => description.nativeBodies.find((body: any) => body.name === name)
    try {
      const opened = await mujoco.open(snapshot, { worldId: sceneId, clock: 'manual', startPaused: true, ground: false })
      // 固定挂接后直接 free：走真实 robot_set_base，回执带既有历史的 before/after 定位。
      const freed = await setRobotBase(mujoco, store as never, baseInput(1, opened.worldGeneration, { mode: 'free', bodyName: 'mount' }))
      assert.equal(freed.status, 'UPDATED')
      assert.equal(freed.syncRequired, false)
      assert.equal(freed.assembly?.field, 'baseBinding')
      assert.equal(freed.assembly?.beforeRevision, 1)
      assert.equal(freed.assembly?.afterRevision, 2)
      assert.equal((freed.assembly?.before as Record<string, unknown>).mode, 'fixed')
      assert.equal((freed.assembly?.after as Record<string, unknown>).mode, 'free')
      assert.equal(bodyWith(freed.robot as Record<string, any>, 'mount').root, true)

      // 局部 Undo：恢复 fixed 声明并按新 revision 真实同步回读。
      const undone = await undoRobotAssembly(mujoco, store as never, { sceneId, entityId: 'child', expectedRevision: 2, field: 'baseBinding', beforeRevision: 1, afterRevision: 2, worldId: sceneId })
      assert.equal(undone.snapshot.revision, 3)
      assert.equal(undone.syncRequired, false, `Undo 后应真实同步：${undone.reason}`)
      const undoneDesc = undone.robot as Record<string, any>
      assert.equal(undoneDesc.base.mode, 'fixed')
      assert.equal(undoneDesc.base.target.entityId, 'parent')
      assert.equal(undoneDesc.base.target.bodyName, 'base')
      assert.deepEqual(undoneDesc.base.constraints, [])
      assert.equal(bodyWith(undoneDesc, 'mount').root, true)
      assert.equal(bodyWith(undoneDesc, 'finger').root, false)
      assert.deepEqual(bodyWith(undoneDesc, 'finger').jointTypes, ['hinge'], 'Undo 不得删除内部关节')

      // source 是不同语义：删除场景基座声明，不是"恢复上一次"。
      const sourced = await setRobotBase(mujoco, store as never, baseInput(3, undone.world!.worldGeneration, { mode: 'source', bodyName: 'mount' }))
      const sourcedChild = sourced.snapshot.entities.find((entity: any) => entity.entityId === 'child')!
      assert.equal('baseBinding' in sourcedChild.components, false)
      assert.equal(sourced.assembly?.after, undefined)

      // 再 fixed 到 tool，然后局部 Undo 应回到 source（无声明）并按新 revision 同步。
      const rebased = await setRobotBase(mujoco, store as never, baseInput(4, sourced.world!.worldGeneration, { mode: 'fixed', bodyName: 'mount', target: { entityId: 'parent', bodyName: 'tool', positionM: [.1, 0, .2], quaternionXyzw: [0, 0, 0, 1] } }))
      assert.equal(bodyWith(rebased.robot as Record<string, any>, 'mount').root, true)
      const undone2 = await undoRobotAssembly(mujoco, store as never, { sceneId, entityId: 'child', expectedRevision: 5, field: 'baseBinding', beforeRevision: 4, afterRevision: 5, worldId: sceneId })
      assert.equal(undone2.snapshot.revision, 6)
      assert.equal(undone2.syncRequired, false, `回到 source 声明也应真实同步：${undone2.reason}`)
      const backChild = undone2.snapshot.entities.find((entity: any) => entity.entityId === 'child')!
      assert.equal('baseBinding' in backChild.components, false)

      // 冲突：绑定后来又改了，撤销 free 那条必须拒绝，且不覆盖当前版本。
      const refixed = await setRobotBase(mujoco, store as never, baseInput(6, undone2.world!.worldGeneration, { mode: 'fixed', bodyName: 'mount', target: { ...rigidTarget } }))
      await setRobotBase(mujoco, store as never, baseInput(7, refixed.world!.worldGeneration, { mode: 'fixed', bodyName: 'mount', target: { entityId: 'parent', bodyName: 'tool', positionM: [.1, 0, .2], quaternionXyzw: [0, 0, 0, 1] } }))
      await assert.rejects(
        () => undoRobotAssembly(mujoco, store as never, { sceneId, entityId: 'child', expectedRevision: 8, field: 'baseBinding', beforeRevision: 1, afterRevision: 2, worldId: sceneId }),
        (error: any) => /ROBOT_ASSEMBLY_CONFLICT/.test(String(error?.message)),
        '目标绑定已被后来编辑，必须拒绝覆盖',
      )
      assert.equal((await store.snapshot(sceneId)).revision, 8)
    } finally { await mujoco.dispose() }
  })
  // 部分 batch Stop 的原生作用域回归（真实 MuJoCo 物理，非替身）：同 batch 停止 a 只撤销 a，
  // b 留在原 batch 继续按物理钟运动；a 释放控制所有权后可重新启动；最后只停止 b。
  test('部分停止作用域：scheduled/running 同 batch 停止 a 不取消 b，a 可重启而 b 继续真实运动', { timeout: 60_000 }, async () => {
    const mujoco = create()
    const twoArmScene = (sceneId: string) => ({
      sceneId, revision: 1,
      coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
      entities: ['a', 'b'].map((entityId, index) => ({
        entityId, name: entityId,
        transform: { position: [index * 3, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        resources: [{ resourceId: entityId, version: 1, original: { uri: `file://${POSITION_ARM}`, mimeType: 'application/x-mjcf+xml' } }],
        components: { mujoco: {} },
      })),
    }) as never
    const bPosition = async (worldId: string) => positionOf(observed(await mujoco.observe(worldId, { entityIds: ['b'] })), 'j1')
    try {
      for (const phase of ['scheduled', 'running'] as const) {
        const sceneId = `partial-stop-${phase}`
        const opened = await mujoco.open(twoArmScene(sceneId), { worldId: sceneId, clock: 'realtime', ground: false, timestepS: TIMESTEP })
        const first = await mujoco.observe(opened.worldId)
        const actionId = `${phase}-both`
        const completion = mujoco.execute(opened.worldId, {
          actionId, kind: 'batch', expectedGeneration: opened.worldGeneration,
          ...(phase === 'scheduled' ? { startStep: first.stepIndex + 1000 } : {}),
          motions: ['a', 'b'].map(entityId => ({ kind: 'joint', entityId, jointNames: ['j1'], positions: [1], durationS: 4 })),
        } as never).catch(error => ({ status: 'failed', reason: String(error) }))
        const receipt = () => mujoco.receipt(opened.worldId, actionId)
        const deadline = Date.now() + 25_000
        let active = await receipt()
        while (!['accepted', 'running', 'failed'].includes(active.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); active = await receipt() }
        assert.ok(['accepted', 'running'].includes(active.status), `batch 应处于活动态，实测 ${active.status}`)
        if (phase === 'running') await new Promise(resolve => setTimeout(resolve, 150))
        const stoppedA = await mujoco.stop(opened.worldId, { expectedGeneration: opened.worldGeneration, ...(phase === 'scheduled' ? { actionId } : {}), entityIds: ['a'] })
        assert.deepEqual(stoppedA.affectedEntityIds, ['a'], '只应撤销 a')
        assert.equal((await receipt()).status, phase === 'scheduled' ? 'accepted' : 'running', '父 batch 应仍为其余成员活动')
        const restarted = await mujoco.execute(opened.worldId, { actionId: `${phase}-restart-a`, kind: 'batch', expectedGeneration: opened.worldGeneration, motions: [{ kind: 'joint', entityId: 'a', jointNames: ['j1'], positions: [-.2], durationS: .15 }] } as never)
        assert.equal(restarted.status, 'completed', `a 释放所有权后应能重新启动：${(restarted as unknown as Record<string, unknown>).reason ?? ''}`)
        while ((await receipt()).status === 'accepted' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        const beforeB = await bPosition(opened.worldId)
        await new Promise(resolve => setTimeout(resolve, 250))
        const afterB = await bPosition(opened.worldId)
        assert.ok(afterB - beforeB > 0.0002, `未停止的 b 应继续运动，实测 Δ=${afterB - beforeB}`)
        const stoppedB = await mujoco.stop(opened.worldId, { expectedGeneration: opened.worldGeneration, actionId, entityIds: ['b'] })
        assert.deepEqual(stoppedB.affectedEntityIds, ['b'], '最后只应撤销 b')
        const final = await receipt()
        assert.equal(final.status, 'cancelled', '含被撤销成员的父 batch 终态不得报成功')
        assert.equal((final as unknown as Record<string, unknown>).taskAchieved, false)
        assert.ok(((final.effect as { motions: Array<{ entityId: string, memberStatus?: string }> }).motions).some(motion => motion.entityId === 'a' && motion.memberStatus === 'cancelled'), '终态须含 a 的取消事实')
        await completion
        await mujoco.close(opened.worldId)
      }
    } finally { await mujoco.dispose() }
  })
  // 原生 Freeze/Restore：free 根按当前 pose 用预分配 inactive weld 保持，无关实体继续运动；
  // Restore 只关 eq_active，不自动恢复旧动作，冻结期间新执行明确 ROBOT_FROZEN。
  test('原生 Freeze/Restore：free 根保持当前 pose，无关实体继续运动，Restore 释放后重新下落', { timeout: 30_000 }, async () => {
    const mujoco = create()
    const freeScene = (sceneId: string) => ({
      sceneId, revision: 1,
      coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' },
      entities: ['cubeA', 'cubeB'].map((entityId, index) => ({
        entityId, name: entityId,
        transform: { position: [index * 2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        resources: [{ resourceId: entityId, version: 1, original: { uri: `file://${FREE_BODY}`, mimeType: 'application/x-mjcf+xml' } }],
        components: { mujoco: { rootBody: 'cube' } },
      })),
    }) as never
    const z = async (entityId: string) => (await mujoco.observe('freeze-native', { entityIds: [entityId] })).entities[0]!.transform.position[2]
    try {
      const opened = await mujoco.open(freeScene('freeze-native'), { worldId: 'freeze-native', clock: 'realtime', ground: false, timestepS: TIMESTEP })
      const generation = opened.worldGeneration
      await new Promise(resolve => setTimeout(resolve, 40))
      const frozen = await mujoco.freeze('freeze-native', { entityIds: ['cubeA'], expectedGeneration: generation })
      assert.equal(frozen.status, 'frozen')
      assert.deepEqual(frozen.scope, ['cubeA'])
      assert.equal(frozen.rootHeld?.cubeA, true)
      assert.equal(frozen.controlConfigPreserved, true)
      const holdZ = await z('cubeA')
      const frozenBase = (await mujoco.describe('freeze-native', 'cubeA')).base as Record<string, any>
      assert.equal(frozenBase.freeze?.frozen, true, '读回应确认 frozen')
      assert.equal(frozenBase.mode, 'free', 'Freeze 不得把普通 free 基座误报为永久 fixed')
      await assert.rejects(
        () => mujoco.execute('freeze-native', { actionId: 'frozen-move', kind: 'joint', expectedGeneration: generation, entityId: 'cubeA', jointNames: ['body_free'], positions: [0], durationS: .1 } as never),
        (error: any) => /ROBOT_FROZEN/.test(String(error?.code ?? error?.message)),
        '冻结期间的新执行必须明确 ROBOT_FROZEN',
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.ok(Math.abs(await z('cubeA') - holdZ) < 2e-3, '冻结实体必须保持当前 pose')
      assert.ok(await z('cubeB') < holdZ - .02, '无关实体必须继续在物理钟下落')
      const restored = await mujoco.restore('freeze-native', { entityIds: ['cubeA'], expectedGeneration: generation, freezeId: frozen.freezeId })
      assert.equal(restored.status, 'restored')
      assert.ok(restored.restoredEntityIds?.includes('cubeA'))
      assert.equal(((await mujoco.describe('freeze-native', 'cubeA')).base as Record<string, any>).freeze?.frozen, false)
      const releasedZ = await z('cubeA')
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.ok(await z('cubeA') < releasedZ - .01, 'Restore 解除原生保持后应恢复真实下落')
      await mujoco.close('freeze-native')
    } finally { await mujoco.dispose() }
  })
  // 已挂接附属件 Freeze 的范围边界：baseBinding 到父实体后，子件根由真实 weld 随父运动，
  // 不得再启用世界根锚（否则等于把无关父机器人锁到 world）。冻结只作用所选子件自身的 DOF。
  test('已挂接附属件 Freeze 不锁根到 world：父机器人继续原生运动，子件随父移动', { timeout: 60_000 }, async () => {
    const mujoco = create()
    const sceneId = 'freeze-accessory'
    const parentXml = '<mujoco><worldbody><body name="base"><geom type="box" size=".1 .1 .1" mass="2"/>'
      + '<body name="tool" pos=".3 0 .1"><joint name="pj" type="hinge" axis="0 0 1" damping=".2"/><geom type="box" size=".05 .05 .05" mass=".5"/></body></body></worldbody>'
      + '<actuator><position name="pj_act" joint="pj" kp="50"/></actuator></mujoco>'
    const childXml = '<mujoco><worldbody><body name="mount"><geom type="box" size=".05 .05 .05" mass=".3"/></body></worldbody></mujoco>'
    const snapshot = bindingSnapshot(sceneId, [
      { entityId: 'parent', name: 'parent', transform: { position: [0, 0, 1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { mujoco: { rootBody: 'base', xml: parentXml } } },
      { entityId: 'tool', name: 'tool', transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: { mujoco: { rootBody: 'mount', xml: childXml }, baseBinding: { mode: 'free', bodyName: 'mount', initialWorldPose: { entityId: 'parent', bodyName: 'tool', positionM: [.12, 0, 0], quaternionXyzw: [0, 0, 0, 1] } } } },
    ]) as never
    try {
      const opened = await mujoco.open(snapshot, { worldId: sceneId, clock: 'realtime', ground: false, timestepS: TIMESTEP })
      const generation = opened.worldGeneration
      const childPos = async () => (await mujoco.observe(sceneId, { entityIds: ['tool'] })).entities[0]!.transform.position
      const parentJoint = async () => positionOf(observed(await mujoco.observe(sceneId, { entityIds: ['parent'] })), 'pj')
      const childBefore = await childPos()
      const frozen = await mujoco.freeze(sceneId, { entityIds: ['tool'], expectedGeneration: generation })
      assert.equal(frozen.status, 'frozen')
      assert.equal(frozen.rootHeld?.tool, false, '已挂接子件不得被锁根到 world（会把无关父机器人一起锁死）')
      assert.deepEqual(frozen.jointLocks?.tool, [])
      const described = (await mujoco.describe(sceneId, 'tool')).base as Record<string, any>
      assert.equal(described.freeze?.frozen, true)
      assert.equal(described.freeze?.rootHeld, false)
      const parentStart = await parentJoint()
      await mujoco.execute(sceneId, { actionId: 'parent-move', kind: 'joint', expectedGeneration: generation, entityId: 'parent', jointNames: ['pj'], positions: [1], durationS: .6 } as never)
      await new Promise(resolve => setTimeout(resolve, 250))
      const parentNow = await parentJoint()
      assert.ok(Math.abs(parentNow - parentStart) > .05, `父机器人应继续原生运动，实测 Δ=${parentNow - parentStart}`)
      const childNow = await childPos()
      assert.ok(Math.hypot(childNow[0]! - childBefore[0]!, childNow[1]! - childBefore[1]!, childNow[2]! - childBefore[2]!) > .01, '已挂接子件应随父运动')
      await mujoco.restore(sceneId, { entityIds: ['tool'], expectedGeneration: generation, freezeId: frozen.freezeId })
      await mujoco.close(sceneId)
    } finally { await mujoco.dispose() }
  })
})
