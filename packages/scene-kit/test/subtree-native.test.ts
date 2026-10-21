/**
 * envgate：R-013 内部子树的**真实原生拆分**（已安装 MuJoCo 3.13 MjSpec，经 python/mjcf_subtree.py）。
 * 设置 LYAPUNOV_MUJOCO_PYTHON；缺环境显式跳过，不把跳过计为原生通过。pack 资产件不随
 * 源仓分发（packs/<id>/asset 是本地供给链接），缺件同样显式跳过。
 *
 * 夹具：真实 Panda（packs/franka_panda/asset/franka_emika_panda/panda.xml）内手 + 任务私有闭合小样。
 * 不下载厂商资源；原件与全部旧依赖 SHA 必须逐字不变。本用例只证明源格式/资源/CAS/独立重载这一层；
 * Scene CAS/动作/重组/Undo 由 robot-tools 用例与主控真实世界覆盖。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SceneOperations } from '../../scene-kit/src/operations.ts'
import { deriveRobotSubtree, inspectRobotSubtreeResource } from '../../scene-kit/src/subtree-extract.ts'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(repoRoot, '.runtime/sim-python/bin/python')
const panda = resolve(repoRoot, 'packs/franka_panda/asset/franka_emika_panda/panda.xml')
const available = existsSync(python)
const skipReason = !available ? `原生 MuJoCo 解释器不存在：${python}` : !existsSync(panda) ? `pack 资产件不随源仓分发：${panda}` : false
// Bun 的 node:test 兼容层忽略 describe/test 选项参数里的 skip（同 timeout 一样要显式 API），
// 缺前置条件时必须走 describe.skip，否则会用例真跑然后 ENOENT。
const describeNative = skipReason === false ? describe : describe.skip
/**
 * Panda 内手与 part 落位两条用例都要走真实资源打包 + 原生重载/编译，实际耗时超过 Bun 默认的 5000ms
 * **单例**上限（`describe` 上的 timeout 被 Bun 忽略，必须在每条 `test` 上声明）。这里只提高等待上限，
 * 数值容差与功能断言保持原样；缺解释器仍整组 skip。
 */
const NATIVE_CASE_TIMEOUT_MS = 120_000
const fixture = (name: string) => resolve(here, 'fixtures/p9-subtree', name)
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
const load = async (modelPath: string) => {
  const { stdout } = await run(python, ['-c', 'import mujoco,sys;m=mujoco.MjModel.from_xml_path(sys.argv[1]);print(m.nq,m.nv,m.nu,m.ntendon,m.neq,m.nbody,int(m.opt.integrator))', modelPath])
  return stdout.trim().split(/\s+/).map(Number)
}
const localOf = (uri: string) => uri.startsWith('file:') ? fileURLToPath(uri) : uri

describeNative('R-013 真实 MJCF/URDF 内部子树拆分', () => {
  test('Panda 内手：两份新资源独立重载、DOF/驱动精确、原件与旧依赖 SHA 不变', { timeout: NATIVE_CASE_TIMEOUT_MS }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-native-'))
    try {
      const ops = new SceneOperations(root)
      const source = await ops.resources.import({ path: panda, category: 'robot', name: 'panda' })
      const sourceSha = await sha(panda)
      const inspection = await inspectRobotSubtreeResource({ resources: ops.resources, sourceResourceId: source.ref.resourceId, sourceVersion: source.ref.version, bodyName: 'hand', pythonPath: python })
      assert.equal(inspection.supported, true, 'Panda 内手应是可严格保全的闭合子树')
      assert.equal(inspection.facts?.subtree.cutJoints.length, 0)
      assert.deepEqual([...inspection.facts!.subtree.joints].sort(), ['finger_joint1', 'finger_joint2'])
      const derived = await deriveRobotSubtree({
        resources: ops.resources, stagingRoot: join(root, 'derived'), sourceResourceId: source.ref.resourceId, sourceVersion: source.ref.version,
        bodyName: 'hand', operationId: 'op-test', partEntityId: 'part-1', sceneId: 's', entityId: 'e', pythonPath: python,
      })
      // 两份都是新资源/版本；旧版本仍指向原件。
      assert.equal(derived.remaining.ref.resourceId, source.ref.resourceId)
      assert.equal(derived.remaining.ref.version, 2)
      assert.notEqual(derived.part.ref.resourceId, source.ref.resourceId)
      assert.equal((derived.remaining.record.derivedFrom as { kind: string }).kind, 'subtree-extract')
      assert.equal((derived.part.record.derivedFrom as { kind: string }).kind, 'subtree-extract')
      // 真实派生命名映射：来自原生重载核对，不是按前缀猜。
      assert.deepEqual(derived.derivation.nameMap?.part.joints, { finger_joint1: 'part_finger_joint1', finger_joint2: 'part_finger_joint2' })
      assert.deepEqual(derived.derivation.nameMap?.part.actuators, { actuator8: 'part_actuator8' })
      assert.equal(derived.derivation.nameMap?.part.bodies.hand, 'part_hand')
      assert.equal(derived.derivation.nameMap?.remaining.joints.joint1, 'joint1')
      assert.equal(derived.derivation.nameMap?.remaining.joints.joint7, 'joint7')
      // 真实 DOF/驱动/肌腱/等式数：remaining 7q/7actuator，part 2q/1actuator/1tendon/1equality。
      assert.deepEqual([derived.derivation.remaining.nq, derived.derivation.remaining.nu, derived.derivation.remaining.ntendon, derived.derivation.remaining.neq], [7, 7, 0, 0])
      assert.deepEqual([derived.derivation.part.nq, derived.derivation.part.nu, derived.derivation.part.ntendon, derived.derivation.part.neq], [2, 1, 1, 1])
      // 离开原模型目录、从 CAS 入口独立重载（真实原生，不是内存 compile）。
      const remainingModel = localOf(derived.remaining.record.ref.original.uri)
      const partModel = localOf(derived.part.record.ref.original.uri)
      const remaining = await load(remainingModel)
      const part = await load(partModel)
      assert.deepEqual(remaining.slice(0, 5), [7, 7, 7, 0, 0])
      assert.deepEqual(part.slice(0, 5), [2, 2, 1, 1, 1])
      assert.equal(remaining[6], 3, 'integrator 必须显式保全为源 implicitfast(3)')
      assert.equal(part[6], 3, 'integrator 必须显式保全为源 implicitfast(3)')
      // 原件逐字不变、旧版本仍可验证。
      assert.equal(await sha(panda), sourceSha)
      assert.equal((await ops.resources.verify(source.ref.resourceId, 1)).valid, true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('跨切口 fixed tendon/actuator：具名拒绝、零派生版本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-native-cross-'))
    try {
      const ops = new SceneOperations(root)
      const source = await ops.resources.import({ path: fixture('cross-tendon.xml'), category: 'robot', name: 'cross' })
      const before = (await ops.resources.list({ allVersions: true })).filter(record => record.ref.resourceId === source.ref.resourceId).length
      await assert.rejects(
        deriveRobotSubtree({ resources: ops.resources, stagingRoot: join(root, 'derived'), sourceResourceId: source.ref.resourceId, sourceVersion: source.ref.version, bodyName: 'hand', partEntityId: 'p', pythonPath: python }),
        (error: Error & { details?: { crossEdges?: Array<{ kind: string; name: string }> } }) => /SUBTREE_CROSS_EDGE_DEPENDENCY/.test(error.message) && (error.details?.crossEdges ?? []).some(edge => edge.kind === 'tendon'),
      )
      const after = (await ops.resources.list({ allVersions: true })).filter(record => record.ref.resourceId === source.ref.resourceId).length
      assert.equal(after, before, '拒绝时不得登记任何派生版本')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('URDF 闭合子树：原格式两份派生、切口关节记录、两侧独立重载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-native-urdf-'))
    try {
      const ops = new SceneOperations(root)
      const source = await ops.resources.import({ path: fixture('simple-urdf.urdf'), category: 'robot', name: 'simple_urdf' })
      const derived = await deriveRobotSubtree({ resources: ops.resources, stagingRoot: join(root, 'derived'), sourceResourceId: source.ref.resourceId, sourceVersion: source.ref.version, bodyName: 'hand_link', partEntityId: 'p', pythonPath: python })
      assert.equal(derived.derivation.format, 'urdf')
      assert.equal(derived.derivation.cutJoint?.name, 'j2')
      // URDF 原名不变；被移出 part 的切口关节 j2 在映射中不存在（消费侧据此清理，不猜名字）。
      assert.equal(derived.derivation.nameMap?.part.joints.j2, undefined)
      assert.equal(derived.derivation.nameMap?.part.joints.j3, 'j3')
      assert.equal(derived.derivation.nameMap?.remaining.joints.j1, 'j1')
      const remaining = await load(localOf(derived.remaining.record.ref.original.uri))
      const part = await load(localOf(derived.part.record.ref.original.uri))
      assert.equal(remaining[0], 1, 'remaining 只保留 j1')
      assert.equal(part[0], 1, 'part 保留 finger 关节 j3')
      // 派生件仍是 URDF 文本（原格式），不是 MJCF 转换件的改名。
      const partText = await readFile(localOf(derived.part.record.ref.original.uri), 'utf8')
      assert.match(partText, /<robot\b/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('part 落位：实体 transform=切口根帧、不写世界锚 baseBinding，part_hand 世界位姿与原件逐值一致', { timeout: NATIVE_CASE_TIMEOUT_MS }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-subtree-native-place-'))
    try {
      const ops = new SceneOperations(root)
      const source = await ops.resources.import({ path: panda, category: 'robot', name: 'panda' })
      const derived = await deriveRobotSubtree({ resources: ops.resources, stagingRoot: join(root, 'derived'), sourceResourceId: source.ref.resourceId, sourceVersion: source.ref.version, bodyName: 'hand', partEntityId: 'p', pythonPath: python })
      // 复算：原 hand/link7 世界位姿 → 把 part 挂到 link7 世界位姿的 frame（实体 transform）→ 读 part_hand 世界位姿。
      // 另复现失败候选的世界锚 baseBinding（根归零）以证明差异。
      const script = [
        'import mujoco,numpy as np,json,sys',
        'src,panda_part=sys.argv[1],sys.argv[2]',
        's=mujoco.MjSpec.from_file(src);m=s.compile();d=mujoco.MjData(m);mujoco.mj_forward(m,d)',
        'def pose(model,data,name):',
        ' b=mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_BODY,name);q=data.xquat[b];return np.array(data.xpos[b]),np.array([q[1],q[2],q[3],q[0]])',
        'hp,hq=pose(m,d,"hand");lp,lq=pose(m,d,"link7")',
        'w=mujoco.MjSpec();w.option.integrator=s.option.integrator;f=w.worldbody.add_frame(pos=lp,quat=lq[[3,0,1,2]])',
        'part=mujoco.MjSpec.from_file(panda_part);w.attach(part,prefix="",frame=f);mw=w.compile();dw=mujoco.MjData(mw);mujoco.mj_forward(mw,dw)',
        'np_,nq_=pose(mw,dw,"part_hand")',
        'w2=mujoco.MjSpec();f2=w2.worldbody.add_frame(pos=lp,quat=lq[[3,0,1,2]]);part2=mujoco.MjSpec.from_file(panda_part);w2.attach(part2,prefix="",frame=f2)',
        'rb=w2.body("part_hand");rb.pos=np.zeros(3);rb.quat=np.array([1.,0,0,0]);mw2=w2.compile();dw2=mujoco.MjData(mw2);mujoco.mj_forward(mw2,dw2)',
        'pb,qb=pose(mw2,dw2,"part_hand")',
        'print(json.dumps({"caseA":{"posErr":float(np.linalg.norm(np_-hp)),"quatDot":float(abs(np.dot(nq_,hq)))},"caseB":{"posErr":float(np.linalg.norm(pb-hp)),"quatDot":float(abs(np.dot(qb,hq)))}}))',
      ].join('\n')
      const { stdout } = await run(python, ['-c', script, panda, localOf(derived.part.record.ref.original.uri)], { maxBuffer: 16 * 1024 * 1024 })
      const proof = JSON.parse(stdout.trim().split('\n').pop()!) as { caseA: { posErr: number; quatDot: number }; caseB: { posErr: number; quatDot: number } }
      assert.ok(proof.caseA.posErr < 1e-9, `当前实现不得有落位误差：${proof.caseA.posErr}`)
      assert.ok(proof.caseA.quatDot > 1 - 1e-9)
      // 失败候选的世界锚分支确实产生 ~0.107m 误差；本用例把它钉成反例。
      assert.ok(proof.caseB.posErr > 0.1 && proof.caseB.quatDot < 0.93)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
