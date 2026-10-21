/**
 * envgate：R-013 内部子树拆分的**真实原生动作闭环**（真实 MuJoCo 3.13 worker，无模型替身）。
 *
 * 背景：提取后 part 的真实关节名带 MJCF `part_` 前缀，若 Scene part.controller 仍以源名声明
 * PD 增益，纯力矩 `<motor>` 会因“缺显式 jointKp/jointKd”拒绝受理。本文件钉住修复后的真实链路：
 *   · 派生的 source→part 名映射来自原生 helper 重载核对，控制器按 `part_*` 真实名迁移；
 *   · 独立 part 内部被驱动关节通过正常 `robot_move`（sim.execute）实际运动并读回；
 *   · 保留的切口关节（part_j2）在派生件里真实可驱动；
 *   · part 以 fixed 原生刚性挂到另一个真实机器人 body 后，父运动跟随且内部关节仍可驱动；
 *   · 重组恢复源资源真实 4 关节语义（不用 fixed weld 冒充）。
 *
 * 运行：`LYAPUNOV_MUJOCO_PYTHON=<含 mujoco 的解释器> bun --no-env-file test <file>`；缺解释器整组 skip。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuJoCoProvider } from '../../sim-mujoco/src/provider.ts'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { deriveRobotSubtree, inspectRobotSubtreeResource } from '../../scene-kit/src/subtree-extract.ts'
import { robotVisual } from '../../scene-kit/src/formats.ts'
import { createRobotOperations } from '../src/operations.ts'
import type { RobotSubtreeHooks } from '../src/operations.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const defaultPython = resolve(repoRoot, '.runtime/sim-python/bin/python')
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? (existsSync(defaultPython) ? defaultPython : undefined)
const suite = python ? describe : describe.skip
/**
 * 两条原生动作各自要走真实 MuJoCo 世界重建、显式 PD 积分与多次 `sim.observe` 读回，实际耗时超过
 * Bun 默认的 5000ms **单例**上限（`describe`/`suite` 上的 timeout 被 Bun 忽略，必须在每条 `test` 上声明）。
 * 这里只提高等待上限，动作时长、收敛容差与功能断言保持原样；缺解释器仍整组 skip。
 */
const NATIVE_CASE_TIMEOUT_MS = 180_000
const localPath = (uri: string) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri)

/** 切口关节保留在 part（j2）且带真实内部 slide（j3/j4）的稳定夹具：armature 保证显式 PD 可积分。 */
const MOVABLE_CUT = `<mujoco model="p9-movable-cut">
  <compiler angle="radian"/>
  <option integrator="implicitfast"/>
  <default><joint damping="0.5" armature="0.05"/><geom friction="1 .005 .0001"/></default>
  <worldbody>
    <body name="base"><geom type="box" size=".1 .1 .1" mass="2"/>
      <body name="arm" pos="0 0 .3"><joint name="j1" type="hinge" axis="0 0 1" range="-2 2"/><geom type="capsule" fromto="0 0 0 .3 0 0" size=".04" mass=".8"/>
        <body name="hand" pos=".3 0 0"><joint name="j2" type="hinge" axis="0 1 0" range="-1.5 1.5"/><geom type="capsule" fromto="0 0 0 .18 0 0" size=".035" mass=".5"/>
          <body name="left" pos="0 .1 0"><joint name="j3" type="slide" axis="0 1 0" range="0 .05"/><geom type="box" size=".02 .02 .02" mass=".1"/></body>
          <body name="right" pos="0 -.1 0"><joint name="j4" type="slide" axis="0 -1 0" range="0 .05"/><geom type="box" size=".02 .02 .02" mass=".1"/></body>
        </body>
      </body>
    </body>
  </worldbody>
  <actuator><motor name="a1" joint="j1"/><motor name="a2" joint="j2"/><motor name="a3" joint="j3"/><motor name="a4" joint="j4"/></actuator>
</mujoco>`

/** 固定切口（hand 无自身关节）+ 深内部 slide：用于把 part 挂到另一个真实 body 后验证父运动跟随。 */
const FIXED_CUT = `<mujoco model="p9-fixed-cut">
  <compiler angle="radian"/>
  <option integrator="implicitfast"/>
  <default><joint damping="0.5" armature="0.05"/><geom friction="1 .005 .0001"/></default>
  <worldbody>
    <body name="base"><geom type="box" size=".1 .1 .1" mass="2"/>
      <body name="arm" pos="0 0 .3"><joint name="j1" type="hinge" axis="0 0 1" range="-2 2"/><geom type="capsule" fromto="0 0 0 .3 0 0" size=".04" mass=".8"/>
        <body name="hand" pos=".3 0 0"><geom type="capsule" fromto="0 0 0 .15 0 0" size=".035" mass=".5"/>
          <body name="finger" pos="0 0 .15"><joint name="j3" type="slide" axis="0 0 1" range="0 .05"/><geom type="box" size=".02 .02 .02" mass=".1"/></body>
        </body>
      </body>
    </body>
  </worldbody>
  <actuator><motor name="a1" joint="j1"/><motor name="a3" joint="j3"/></actuator>
</mujoco>`

const CARRIER = `<mujoco model="p9-carrier">
  <compiler angle="radian"/>
  <option integrator="implicitfast"/>
  <default><joint damping="0.5" armature="0.05"/></default>
  <worldbody>
    <body name="cbase" pos="-.7 0 0"><joint name="c1" type="hinge" axis="0 0 1" range="-3 3"/><geom type="box" size=".08 .08 .08" mass="2"/>
      <body name="ctool" pos=".25 0 0"><geom type="box" size=".04 .04 .04" mass="1"/></body>
    </body>
  </worldbody>
  <actuator><motor name="ca1" joint="c1"/></actuator>
</mujoco>`

function hooksFor(ops: SceneOperations, root: string): RobotSubtreeHooks {
  return {
    precheck: async ({ resourceId, version, bodyName }) =>
      inspectRobotSubtreeResource({ resources: ops.resources, sourceResourceId: resourceId, sourceVersion: version, bodyName, pythonPath: python }),
    derive: async (input) => {
      const derived = await deriveRobotSubtree({
        resources: ops.resources,
        stagingRoot: join(root, 'derived', 'subtree'),
        sourceResourceId: input.sourceResourceId,
        sourceVersion: input.sourceVersion,
        bodyName: input.bodyName,
        operationId: input.operationId,
        sceneId: input.sceneId,
        entityId: input.entityId,
        partEntityId: input.partEntityId,
        ...(input.cutPoseInSourceRoot ? { cutPoseInSourceRoot: input.cutPoseInSourceRoot } : {}),
        pythonPath: python,
      })
      return { derivation: derived.derivation, remainingRef: derived.remaining.ref, partRef: derived.part.ref }
    },
    resourceComponents: async ({ resourceId, version }) => {
      const record = await ops.resources.get(resourceId, version)
      const path = localPath(record.ref.original.uri)
      const format = String(record.parsed.metadata.format ?? record.parsed.kind)
      const visual = { kind: 'robot', robot: await robotVisual(path) }
      const components = format === 'mjcf'
        ? { visual, mujoco: { sourcePath: path }, articulation: { source: record.ref.original, format } }
        : { visual, articulation: { source: record.ref.original, format } }
      return { ref: record.ref, components }
    },
  }
}

function createSim() {
  return new MuJoCoProvider({ pythonPath: python!, renderBackend: 'osmesa' })
}

function observedJoints(frame: any, entityId: string): { names: string[]; positions: number[] } {
  const entity = frame.entities.find((candidate: any) => candidate.entityId === entityId)
  return entity.joints as { names: string[]; positions: number[] }
}

function positionOf(joints: { names: string[]; positions: number[] }, name: string): number {
  const index = joints.names.indexOf(name)
  assert.ok(index >= 0, `world 应报告关节 ${name}，实测 ${joints.names.join('/')}`)
  return joints.positions[index]!
}

suite('R-013 原生内部子树动作闭环（真实 MuJoCo worker）', () => {
  test('保留切口关节：part_* 名映射、part_j2/part_j3 真实驱动、重组恢复 j1..j4', { timeout: NATIVE_CASE_TIMEOUT_MS }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-motion-'))
    const sim = createSim()
    try {
      const ops = new SceneOperations(root)
      const sourcePath = join(root, 'movable-cut.xml')
      await writeFile(sourcePath, MOVABLE_CUT)
      const imported = await ops.resources.import({ path: sourcePath, category: 'robot', name: 'movable-cut' })
      await ops.create({ sceneId: 'motion', template: 'blank' })
      const mounted = await ops.mount({
        sceneId: 'motion', resourceId: imported.ref.resourceId, version: imported.ref.version, entityId: 'arm', alignBottomToSurface: false,
        components: { controller: { type: 'joint', jointKp: { j1: 100, j2: 100, j3: 100, j4: 100 }, jointKd: { j1: 5, j2: 5, j3: 5, j4: 5 } } },
      })
      const configured = await ops.configurePhysics({ sceneId: 'motion', expectedRevision: mounted.snapshot.revision, gravityWorldMps2: [0, 0, 0] })
      const tools = createRobotOperations(sim, ops.scene, { subtree: hooksFor(ops, root) })
      const world = await sim.open(configured, { worldId: 'motion', clock: 'realtime', startPaused: false, ground: false })
      assert.ok((await sim.observe(world.worldId)).stepIndex > 0, '源机必须真实推进')
      await sim.setPaused!(world.worldId, true, world.worldGeneration)
      const split = await tools.robot_assembly_extract({ sceneId: 'motion', entityId: 'arm', bodyName: 'hand', worldId: world.worldId, expectedGeneration: world.worldGeneration, expectedRevision: configured.revision, partEntityId: 'part' })
      assert.equal(split.sync, 'SYNCED')
      // 结构 sync 会重建世界并递增代次：后续暂停/动作必须用**当前**代次。
      let live = (await sim.listWorlds()).find(candidate => candidate.worldId === world.worldId)!
      assert.equal(live.status, 'paused', '结构 sync 必须保持用户暂停状态')
      const part = await sim.describe(world.worldId, 'part') as Record<string, any>
      // 控制器按真实派生名迁移（不是源名 j2/j3/j4）。
      assert.deepEqual(part.controller.jointKp, { part_j2: 100, part_j3: 100, part_j4: 100 })
      assert.deepEqual(part.controller.jointKd, { part_j2: 5, part_j3: 5, part_j4: 5 })
      assert.ok(part.controlledJointNames.includes('part_j2'), '保留的切口关节 part_j2 必须受控')
      assert.ok(part.controlledJointNames.includes('part_j3'))
      assert.deepEqual(split.derivation.nameMap?.part.joints, { j2: 'part_j2', j3: 'part_j3', j4: 'part_j4' })
      // 切口关节在派生件里保留：part_j2 真实可驱动。
      await sim.setPaused!(world.worldId, false, live.worldGeneration)
      const before2 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j2')
      const receipt2 = await sim.execute(world.worldId, { actionId: 'drive-part-j2', expectedGeneration: live.worldGeneration, kind: 'joint', entityId: 'part', jointNames: ['part_j2'], positions: [before2 + 0.4], durationS: 0.6, settleTimeS: 0.4, tolerance: 0.02 }) as Record<string, any>
      const after2 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j2')
      assert.equal(receipt2.status, 'completed')
      assert.ok(Math.abs(after2 - (before2 + 0.4)) < 0.02, `part_j2 必须真实到目标：实测 ${after2}`)
      // 内部关节 part_j3 真实可驱动。
      const before3 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j3')
      const receipt3 = await sim.execute(world.worldId, { actionId: 'drive-part-j3', expectedGeneration: live.worldGeneration, kind: 'joint', entityId: 'part', jointNames: ['part_j3'], positions: [before3 + 0.02], durationS: 0.6, settleTimeS: 0.4, tolerance: 0.002 }) as Record<string, any>
      const after3 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j3')
      assert.equal(receipt3.status, 'completed')
      assert.ok(Math.abs(after3 - (before3 + 0.02)) < 0.002, `part_j3 必须真实到目标：实测 ${after3}`)
      // 重组恢复源资源真实可动关节语义（不是 fixed weld）。
      await sim.setPaused!(world.worldId, true, live.worldGeneration)
      const snapshot = await ops.scene.snapshot('motion')
      const rebuilt = await tools.robot_assembly_reassemble({ sceneId: 'motion', entityId: 'arm', worldId: world.worldId, expectedGeneration: live.worldGeneration, expectedRevision: snapshot.revision })
      assert.equal(rebuilt.sync, 'SYNCED')
      const arm = await sim.describe(world.worldId, 'arm') as Record<string, any>
      assert.deepEqual((arm.joints as any[]).map(joint => joint.name), ['j1', 'j2', 'j3', 'j4'])
      assert.equal(arm.controller.jointKp.j2, 100, '重组后恢复源控制器映射')
      assert.ok((await ops.scene.snapshot('motion')).entities.every(entity => entity.entityId !== 'part'), '独立件必须被移除')
      await sim.close(world.worldId)
    } finally {
      await sim.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  test('父运动跟随：part fixed 挂到另一真实 body，carrier 运动带动 part，内部关节仍可驱动', { timeout: NATIVE_CASE_TIMEOUT_MS }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-follow-'))
    const sim = createSim()
    try {
      const ops = new SceneOperations(root)
      const sourcePath = join(root, 'fixed-cut.xml')
      const carrierPath = join(root, 'carrier.xml')
      await writeFile(sourcePath, FIXED_CUT)
      await writeFile(carrierPath, CARRIER)
      const imported = await ops.resources.import({ path: sourcePath, category: 'robot', name: 'fixed-cut' })
      const carrier = await ops.resources.import({ path: carrierPath, category: 'robot', name: 'carrier' })
      await ops.create({ sceneId: 'follow', template: 'blank' })
      const mounted = await ops.mount({
        sceneId: 'follow', resourceId: imported.ref.resourceId, version: imported.ref.version, entityId: 'arm', alignBottomToSurface: false,
        components: { controller: { type: 'joint', jointKp: { j1: 100, j3: 100 }, jointKd: { j1: 5, j3: 5 } } },
      })
      const mountedCarrier = await ops.mount({
        sceneId: 'follow', resourceId: carrier.ref.resourceId, version: carrier.ref.version, entityId: 'carrier', alignBottomToSurface: false,
        components: { controller: { type: 'joint', jointKp: { c1: 100 }, jointKd: { c1: 5 } } },
      })
      const configured = await ops.configurePhysics({ sceneId: 'follow', expectedRevision: mountedCarrier.snapshot.revision, gravityWorldMps2: [0, 0, 0] })
      const tools = createRobotOperations(sim, ops.scene, { subtree: hooksFor(ops, root) })
      const world = await sim.open(configured, { worldId: 'follow', clock: 'realtime', startPaused: false, ground: false })
      await sim.setPaused!(world.worldId, true, world.worldGeneration)
      await tools.robot_assembly_extract({ sceneId: 'follow', entityId: 'arm', bodyName: 'hand', worldId: world.worldId, expectedGeneration: world.worldGeneration, expectedRevision: configured.revision, partEntityId: 'part' })
      const part = await sim.describe(world.worldId, 'part') as Record<string, any>
      assert.deepEqual(part.controller.jointKp, { part_j3: 100 })
      assert.equal(part.base.editable.fixed, true, '固定切口的 part 根必须可编辑基座')
      const partRoot = (part.nativeBodies as any[]).find(body => body.root)!.name as string
      // 经真实 robot_set_base 把 part 以 fixed 原生刚性挂到 carrier 的真实 body ctool。
      const revisionAfterExtract = (await ops.scene.snapshot('follow')).revision
      const current = (await sim.listWorlds()).find(candidate => candidate.worldId === world.worldId)!
      const attached = await tools.robot_set_base({
        worldId: world.worldId, sceneId: 'follow', entityId: 'part', expectedRevision: revisionAfterExtract, expectedGeneration: current.worldGeneration,
        base: { mode: 'fixed', bodyName: partRoot, target: { entityId: 'carrier', bodyName: 'ctool', positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } },
      })
      assert.equal(attached.sync, 'SYNCED')
      const attachedDesc = await sim.describe(world.worldId, 'part') as Record<string, any>
      assert.equal(attachedDesc.base.mode, 'fixed')
      assert.equal(attachedDesc.base.target.entityId, 'carrier')
      assert.ok(attachedDesc.base.constraints.every((constraint: any) => constraint.kind !== 'weld'), 'fixed 必须是原生刚性父子，不是 weld')
      const poseAt = async () => (await sim.describe(world.worldId, 'part') as Record<string, any>).base.worldFromBody
      const heldBefore = await poseAt()
      // robot_set_base 同样重建世界：用返回/回读的当前代次驱动。
      const attachedWorld = (await sim.listWorlds()).find(candidate => candidate.worldId === world.worldId)!
      await sim.setPaused!(world.worldId, false, attachedWorld.worldGeneration)
      // 驱动 carrier 的 c1：part 作为其子 body 必须跟随（父运动跟随）。
      const carrierBefore = positionOf(observedJoints(await sim.observe(world.worldId), 'carrier'), 'c1')
      await sim.execute(world.worldId, { actionId: 'drive-carrier', expectedGeneration: attachedWorld.worldGeneration, kind: 'joint', entityId: 'carrier', jointNames: ['c1'], positions: [carrierBefore + 0.5], durationS: 0.6, settleTimeS: 0.4, tolerance: 0.02 })
      const heldAfter = await poseAt()
      const moved = Math.hypot(heldAfter.positionM[0] - heldBefore.positionM[0], heldAfter.positionM[1] - heldBefore.positionM[1], heldAfter.positionM[2] - heldBefore.positionM[2])
      assert.ok(moved > 0.05, `carrier 父运动必须带动 part：位移 ${moved}`)
      // 挂接后内部关节仍可驱动。
      const before3 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j3')
      const receipt3 = await sim.execute(world.worldId, { actionId: 'drive-attached-j3', expectedGeneration: attachedWorld.worldGeneration, kind: 'joint', entityId: 'part', jointNames: ['part_j3'], positions: [before3 + 0.02], durationS: 0.6, settleTimeS: 0.4, tolerance: 0.002 }) as Record<string, any>
      const after3 = positionOf(observedJoints(await sim.observe(world.worldId), 'part'), 'part_j3')
      assert.equal(receipt3.status, 'completed')
      assert.ok(Math.abs(after3 - (before3 + 0.02)) < 0.002, `挂接后 part_j3 必须真实到目标：实测 ${after3}`)
      await sim.close(world.worldId)
    } finally {
      await sim.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
