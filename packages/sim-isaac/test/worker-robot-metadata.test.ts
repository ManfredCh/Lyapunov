/**
 * T4 / ISAAC-12 + ISAAC-16：worker.py 的机器人可控性与 describe↔prepare 一致性（离线验证）。
 *
 * worker.py 在模块顶层就 import isaacsim 并启动 Kit，无法在无 SDK 的环境里 import。这里用系统 python3
 * 读取 worker.py 源码，按 AST 抽出**真实函数**（controlled_joints / joint_control_mode / configure_robots /
 * capabilities / describe / prepare / resolve_actuator / free_bases 及它们依赖的小工具），配假 articulation
 * 与源元数据执行；断言对象是主仓源码本体，不是 TS 侧重写的镜像。抽不到函数时探针直接失败，不会静默空跑。
 *
 * 边界：本机未启动 Isaac/Kit —— 这里证明的是决策函数在给定输入下的结论与两端口径一致，
 * **不是引擎实测**；真实 USD articulation/drive 的字段映射仍需在真实 Isaac 中复核（见回执未覆盖项）。
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const WORKER = join(import.meta.dir, '..', 'python', 'worker.py')

function systemPython(): string | undefined {
  const configured = process.env.TESTCI_PYTHON?.trim()
  if (configured) return configured
  for (const candidate of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (existsSync(candidate)) return candidate
  return undefined
}
const PYTHON = systemPython()

type Outcome = { status: 'OK' | 'ERROR'; code?: string; message?: string }
type Capability = { kind: string; available: boolean; reason?: string; joints?: number; jointNames?: string[]; controlledJointNames?: string[]; controlledSource?: string; wheels?: number; steering?: boolean; joint?: string; maxWidthM?: number }
type JointRow = { name: string; actuator?: string | null; controlMode?: string | null; type: string }
type Description = { controlledJointNames: string[]; controlMetadataPresent: boolean; controlMetadata?: { status: string; reason: string } | null; capabilities: Capability[]; joints: JointRow[] }
type Case = {
  controlled?: string[]
  controlledSource?: string
  jointModes?: Record<string, string | null>
  capabilities?: Capability[]
  describe?: Description
  prepare?: Outcome
  prepareControl?: Outcome
  prepareJoint?: Outcome
  prepareTrajectoryAllDofs?: Outcome
  prepareTrajectorySubset?: Outcome
  prepareTrajectoryComplete?: Outcome
  prepareControlJ0?: Outcome
  prepareControlPassiveJ1?: Outcome
  prepareControlVelocityJ2?: Outcome
}
type Pair = { name: string; kind: string; available: boolean; reason?: string; prepare: 'OK' | 'ERROR'; prepareCode?: string }
type SyntheticCase = { jointMode: string | null; describe: Description; prepareControl: Outcome }
type Report = { pairs: Pair[]; thrust: Capability; synthetic: SyntheticCase; [name: string]: unknown }

/** 从 worker.py 抽真实函数执行的探针；输出一份 JSON 事实表。 */
const PROBE = `
"""离线探针：从 worker.py 抽出真实决策函数，用假 articulation/元数据执行。"""
import ast, contextlib, copy, json, math, sys
import numpy as np

worker = sys.argv[1]
tree = ast.parse(open(worker, encoding='utf-8').read())
MODULE = {'controlled_joints', 'joint_control_mode', 'array', 'scalar_list', 'finite', 'positive', 'joint_limits', 'joint_gain'}
METHODS = {'configure_robots', 'capabilities', 'describe', 'prepare', 'resolve_actuator', 'free_bases'}
body = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in MODULE:
        body.append(node)
    elif isinstance(node, ast.ClassDef) and node.name == 'World':
        body.extend(item for item in node.body if isinstance(item, ast.FunctionDef) and item.name in METHODS)
picked = {node.name for node in body}
if picked != MODULE | METHODS:
    raise SystemExit('worker.py 缺少被验证的函数: ' + ', '.join(sorted((MODULE | METHODS) - picked)))
module = ast.Module(body=body, type_ignores=[])
ast.fix_missing_locations(module)


class SceneError(Exception):
    def __init__(self, code, message=''):
        super().__init__(message)
        self.code = code


ns = {'SceneError': SceneError, 'np': np, 'json': json, 'math': math, 'copy': copy,
      'use_backend': lambda *a, **k: contextlib.nullcontext()}
exec(compile(module, worker, 'exec'), ns)


class FakeRobot:
    def __init__(self, names):
        n = len(names)
        # 夹具必须与**真实实体形状**同形（scene_adapter.py:689-691：articulation=Articulation(...)、
        # entity/metadata/config/rigidPaths）：experimental prims 的机构对象有 .paths（prim 路径表），
        # worker.py 的 physx_sleeping():301 与本用例探针的 describe() modelVersion 退化分支都读它。
        # 夹具不实现它 ⇒ 探针在 describe() 上抛 AttributeError，11 条会**一起**红（同一个根因）。
        self.paths = ['/World/e1']
        self.dof_names = list(names)
        self.dof_types = ['PhysicsRevoluteJoint'] * n
        self._positions = np.zeros(n)
        self._velocities = np.zeros(n)
        self._stiffness = np.full(n, 100.)
        self._damping = np.full(n, 1.)
        self._efforts = np.full(n, np.inf)
        self._frictions = np.zeros(n)
        self._limits = (np.full(n, -1.5), np.full(n, 1.5))

    def is_physics_tensor_entity_valid(self): return True
    def get_dof_positions(self): return self._positions.copy()
    def set_dof_positions(self, values): self._positions = np.asarray(values, dtype=float)
    def set_dof_position_targets(self, values, dof_indices=None): return None
    def set_dof_velocities(self, values): self._velocities = np.asarray(values, dtype=float)
    def set_dof_velocity_targets(self, values, dof_indices=None): return None
    def get_dof_gains(self): return self._stiffness.copy(), self._damping.copy()
    def set_dof_gains(self, stiffness, damping):
        self._stiffness = np.asarray(stiffness, dtype=float); self._damping = np.asarray(damping, dtype=float)
    def get_dof_max_efforts(self): return self._efforts.copy()
    def set_dof_max_efforts(self, efforts): self._efforts = np.asarray(efforts, dtype=float)
    def get_dof_friction_properties(self): return self._stiffness.copy(), self._damping.copy(), self._frictions.copy()
    def set_dof_friction_properties(self, viscous_frictions=None, dof_indices=None):
        if viscous_frictions is not None:
            for index, value in zip(dof_indices, viscous_frictions): self._frictions[index] = value
    def get_dof_limits(self): return self._limits
    def set_solver_iteration_counts(self, **kwargs): return None


class FakeWorld:
    def __init__(self, entities, clock='manual', generation=1):
        self.entities = entities; self.clock = clock; self.generation = generation; self.dt = 0.002

    def entry(self, eid):
        if eid not in self.entities: raise SceneError('ENTITY_NOT_FOUND', eid)
        return self.entities[eid]

    def robot(self, eid):
        e = self.entry(eid)
        if e['articulation'] is None: raise SceneError('ENTITY_NOT_ARTICULATED', eid)
        return e['articulation']

    def ready(self): return None

    def observe(self, selection=None):
        selection = selection or {}; ids = selection.get('entityIds')
        return {'entities': [{'entityId': eid, 'transform': {'position': [0., 0., 0.]}} for eid in self.entities if not ids or eid in ids]}

    def thrust_mapping(self, e):
        raise SceneError('UNSUPPORTED_CAPABILITY', '源元数据没有可核验的执行器映射')


for name in ['configure_robots', 'capabilities', 'describe', 'prepare', 'resolve_actuator', 'free_bases']:
    setattr(FakeWorld, name, ns[name])


def entity(metadata, controller=None, names=('j0', 'j1', 'j2'), articulation=True):
    return {'entity': {'entityId': 'e1', 'resources': []}, 'metadata': metadata, 'controller': controller or {},
            'articulation': FakeRobot(names) if articulation else None, 'rigidPaths': []}


def world_for(e, clock='manual', configure=True):
    w = FakeWorld({'e1': e}, clock=clock)
    if configure: w.configure_robots()
    return w


def outcome(run):
    try:
        run(); return {'status': 'OK'}
    except SceneError as error:
        return {'status': 'ERROR', 'code': error.code, 'message': str(error)}
    except Exception as error:
        return {'status': 'ERROR', 'code': type(error).__name__, 'message': str(error)}


def describe_summary(description):
    return {'controlledJointNames': description['controlledJointNames'],
            'controlMetadataPresent': 'controlMetadata' in description,
            'controlMetadata': description.get('controlMetadata'),
            'capabilities': description['capabilities'],
            'joints': [{'name': j['name'], 'actuator': j.get('actuator'), 'controlMode': j.get('controlMode'), 'type': j['type']} for j in description['joints']]}


def control(entity_id, joint):
    return {'entityId': entity_id, 'kind': 'control', 'jointNames': [joint], 'positions': [0.1], 'stepCount': 5}


def mjcf_metadata(actuators=True):
    metadata = {'joints': {
                    'j0': {'type': 'hinge', 'home': 0.0, 'range': [-1.5, 1.5], 'damping': 0.0, 'actuator': 'a0'},
                    'j1': {'type': 'hinge', 'home': 0.0, 'range': [-1.5, 1.5], 'damping': 0.0},
                    'j2': {'type': 'hinge', 'home': 0.0, 'range': [-1.5, 1.5], 'damping': 0.0, 'actuator': 'a2'}},
                'actuators': {
                    'a0': {'mode': 'torque', 'stiffness': 0., 'damping': 0., 'joint': 'j0', 'controlRange': None},
                    'a2': {'mode': 'velocity', 'stiffness': 0., 'damping': 0., 'joint': 'j2', 'controlRange': None}},
                'freeBase': {'present': False}, 'geoms': {}, 'bodies': {}, 'sites': {}, 'cameras': {}}
    if not actuators: metadata['actuators'] = {}
    return metadata


report = {}
pairs = []


def pair(name, kind, caps, prep):
    item = next(candidate for candidate in caps if candidate['kind'] == kind)
    pairs.append({'name': name, 'kind': kind, 'available': item['available'], 'reason': item.get('reason'),
                  'prepare': prep['status'], 'prepareCode': prep.get('code')})


# 1) URDF/原生 USD：convert() 返回 metadata={} —— 不得把全部 DOF 推断为可控。
urdf_entity = entity({}, {})
urdf_world = world_for(urdf_entity)
urdf_caps = urdf_world.capabilities(urdf_entity)
urdf_control = outcome(lambda: urdf_world.prepare(control('e1', 'j0')))
report['urdf'] = {'controlled': urdf_entity['controlled'], 'controlledSource': urdf_entity['controlledSource'],
                  'describe': describe_summary(urdf_world.describe('e1')), 'capabilities': urdf_caps,
                  'prepareControl': urdf_control,
                  'prepareJoint': outcome(lambda: urdf_world.prepare({'entityId': 'e1', 'kind': 'joint', 'jointNames': ['j0'], 'positions': [0.1], 'durationS': 0.5})),
                  'prepareTrajectoryAllDofs': outcome(lambda: urdf_world.prepare({'entityId': 'e1', 'kind': 'trajectory', 'jointNames': ['j0', 'j1', 'j2'], 'points': [{'timeS': 0.1, 'positions': [0.1, 0.0, 0.0]}]}))}
pair('urdf 空元数据', 'control', urdf_caps, urdf_control)
pair('urdf 空元数据', 'joint', urdf_caps, report['urdf']['prepareJoint'])

# 2) MJCF：只有源声明了 actuator 的关节受控；controlMode 取源执行器模式。
mjcf_entity = entity(mjcf_metadata(), {})
mjcf_world = world_for(mjcf_entity)
mjcf_caps = mjcf_world.capabilities(mjcf_entity)
mjcf_control = outcome(lambda: mjcf_world.prepare(control('e1', 'j0')))
report['mjcf'] = {'controlled': mjcf_entity['controlled'], 'controlledSource': mjcf_entity['controlledSource'],
                  'jointModes': {name: ns['joint_control_mode'](mjcf_entity['metadata'], name) for name in ('j0', 'j1', 'j2')},
                  'describe': describe_summary(mjcf_world.describe('e1')), 'capabilities': mjcf_caps,
                  'prepareControlJ0': mjcf_control,
                  'prepareControlPassiveJ1': outcome(lambda: mjcf_world.prepare(control('e1', 'j1'))),
                  'prepareControlVelocityJ2': outcome(lambda: mjcf_world.prepare(control('e1', 'j2'))),
                  'prepareTrajectorySubset': outcome(lambda: mjcf_world.prepare({'entityId': 'e1', 'kind': 'trajectory', 'jointNames': ['j0'], 'points': [{'timeS': 0.1, 'positions': [0.1]}]})),
                  'prepareTrajectoryComplete': outcome(lambda: mjcf_world.prepare({'entityId': 'e1', 'kind': 'trajectory', 'jointNames': ['j0', 'j2'], 'points': [{'timeS': 0.1, 'positions': [0.1, 0.0]}]}))}
pair('mjcf 声明了 actuator', 'control', mjcf_caps, mjcf_control)

# 3) realtime 世界：control 的 manual 时钟拒绝必须同时出现在两端口径里。
realtime_entity = entity(mjcf_metadata(), {})
realtime_world = world_for(realtime_entity, clock='realtime')
realtime_caps = realtime_world.capabilities(realtime_entity)
realtime_control = outcome(lambda: realtime_world.prepare(control('e1', 'j0')))
report['realtime'] = {'capabilities': realtime_caps, 'prepareControl': realtime_control}
pair('realtime 世界', 'control', realtime_caps, realtime_control)

# 4) gripper：配置齐备可用；缺配置 / 源声明为被动关节时与 prepare 同码拒绝。
gripper_entity = entity({}, {'gripper': {'jointNames': ['j0'], 'maxWidthM': 0.08}})
gripper_world = world_for(gripper_entity)
gripper_caps = gripper_world.capabilities(gripper_entity)
gripper_prepare = outcome(lambda: gripper_world.prepare({'entityId': 'e1', 'kind': 'gripper', 'widthM': 0.04, 'durationS': 0.5}))
report['gripper'] = {'capabilities': gripper_caps, 'prepare': gripper_prepare}
pair('gripper 配置齐备', 'gripper', gripper_caps, gripper_prepare)
gripper_missing = entity({}, {})
gripper_missing_world = world_for(gripper_missing)
gripper_missing_caps = gripper_missing_world.capabilities(gripper_missing)
gripper_missing_prepare = outcome(lambda: gripper_missing_world.prepare({'entityId': 'e1', 'kind': 'gripper', 'widthM': 0.04, 'durationS': 0.5}))
report['gripperMissing'] = {'capabilities': gripper_missing_caps, 'prepare': gripper_missing_prepare}
pair('gripper 缺 controller.gripper', 'gripper', gripper_missing_caps, gripper_missing_prepare)
gripper_passive = entity(mjcf_metadata(), {'gripper': {'jointNames': ['j1'], 'maxWidthM': 0.08}})
gripper_passive_world = world_for(gripper_passive)
gripper_passive_caps = gripper_passive_world.capabilities(gripper_passive)
gripper_passive_prepare = outcome(lambda: gripper_passive_world.prepare({'entityId': 'e1', 'kind': 'gripper', 'widthM': 0.04, 'durationS': 0.5}))
report['gripperPassive'] = {'capabilities': gripper_passive_caps, 'prepare': gripper_passive_prepare}
pair('gripper 指向被动关节 j1', 'gripper', gripper_passive_caps, gripper_passive_prepare)

# 5) lift：同一套同源判定。
lift_entity = entity(mjcf_metadata(), {'lift': {'joint': 'j0'}})
lift_world = world_for(lift_entity)
lift_caps = lift_world.capabilities(lift_entity)
lift_prepare = outcome(lambda: lift_world.prepare({'entityId': 'e1', 'kind': 'lift', 'positionM': 0.1, 'durationS': 0.5}))
report['lift'] = {'capabilities': lift_caps, 'prepare': lift_prepare}
pair('lift 配置齐备', 'lift', lift_caps, lift_prepare)
lift_missing = entity({}, {})
lift_missing_world = world_for(lift_missing)
lift_missing_caps = lift_missing_world.capabilities(lift_missing)
lift_missing_prepare = outcome(lambda: lift_missing_world.prepare({'entityId': 'e1', 'kind': 'lift', 'positionM': 0.1, 'durationS': 0.5}))
report['liftMissing'] = {'capabilities': lift_missing_caps, 'prepare': lift_missing_prepare}
pair('lift 缺 controller.lift', 'lift', lift_missing_caps, lift_missing_prepare)
lift_passive = entity(mjcf_metadata(), {'lift': {'joint': 'j1'}})
lift_passive_world = world_for(lift_passive)
lift_passive_caps = lift_passive_world.capabilities(lift_passive)
lift_passive_prepare = outcome(lambda: lift_passive_world.prepare({'entityId': 'e1', 'kind': 'lift', 'positionM': 0.1, 'durationS': 0.5}))
report['liftPassive'] = {'capabilities': lift_passive_caps, 'prepare': lift_passive_prepare}
pair('lift 指向被动关节 j1', 'lift', lift_passive_caps, lift_passive_prepare)

# 6) vehicle：articulation + SI 配置 + 执行器可寻址 + 轮径/车身尺寸为正。
vehicle_cfg = {'type': 'vehicle', 'wheels': [{'joint': 'j0', 'radiusM': 0.05, 'side': 'left', 'actuator': 'a0'}], 'trackWidthM': 0.3}
vehicle_run = {'entityId': 'e1', 'kind': 'vehicle', 'speedMps': 0.2, 'durationS': 0.5}
vehicle_entity = entity(mjcf_metadata(), vehicle_cfg)
vehicle_world = world_for(vehicle_entity)
vehicle_caps = vehicle_world.capabilities(vehicle_entity)
vehicle_prepare = outcome(lambda: vehicle_world.prepare(vehicle_run))
report['vehicle'] = {'capabilities': vehicle_caps, 'prepare': vehicle_prepare}
pair('vehicle 配置齐备', 'vehicle', vehicle_caps, vehicle_prepare)
vehicle_bad = entity(mjcf_metadata(), dict(vehicle_cfg, wheels=[{'joint': 'j9', 'radiusM': 0.05, 'side': 'left', 'actuator': 'a0'}]))
vehicle_bad_world = world_for(vehicle_bad)
vehicle_bad_caps = vehicle_bad_world.capabilities(vehicle_bad)
vehicle_bad_prepare = outcome(lambda: vehicle_bad_world.prepare(vehicle_run))
report['vehicleBadActuator'] = {'capabilities': vehicle_bad_caps, 'prepare': vehicle_bad_prepare}
pair('vehicle 轮执行器无法寻址', 'vehicle', vehicle_bad_caps, vehicle_bad_prepare)
vehicle_radius = entity(mjcf_metadata(), dict(vehicle_cfg, wheels=[{'joint': 'j0', 'radiusM': 0.0, 'side': 'left', 'actuator': 'a0'}]))
vehicle_radius_world = world_for(vehicle_radius)
vehicle_radius_caps = vehicle_radius_world.capabilities(vehicle_radius)
vehicle_radius_prepare = outcome(lambda: vehicle_radius_world.prepare(vehicle_run))
report['vehicleBadRadius'] = {'capabilities': vehicle_radius_caps, 'prepare': vehicle_radius_prepare}
pair('vehicle 轮径非正', 'vehicle', vehicle_radius_caps, vehicle_radius_prepare)
vehicle_rigid = entity(mjcf_metadata(), vehicle_cfg, articulation=False)
vehicle_rigid_world = world_for(vehicle_rigid, configure=False)
vehicle_rigid_caps = vehicle_rigid_world.capabilities(vehicle_rigid)
vehicle_rigid_prepare = outcome(lambda: vehicle_rigid_world.prepare(vehicle_run))
report['vehicleNonArticulated'] = {'capabilities': vehicle_rigid_caps, 'prepare': vehicle_rigid_prepare}
pair('vehicle 无关节实体', 'vehicle', vehicle_rigid_caps, vehicle_rigid_prepare)

# 7) thrust：本次未改动的既有能力面（无真实映射时如实 available=false）。
report['thrust'] = next(item for item in mjcf_caps if item['kind'] == 'thrust')

# 8) 合成负对照：源声明了 actuator 名但 actuators 表里没有该条目——
#    describe 不得因此默认 position；prepare 必须拒绝（当前为 KeyError→ENGINE_ERROR，见回执未覆盖项）。
synthetic_entity = entity(mjcf_metadata(actuators=False), {})
synthetic_world = world_for(synthetic_entity)
report['synthetic'] = {'jointMode': ns['joint_control_mode'](synthetic_entity['metadata'], 'j0'),
                       'describe': describe_summary(synthetic_world.describe('e1')),
                       'prepareControl': outcome(lambda: synthetic_world.prepare(control('e1', 'j0')))}
report['pairs'] = pairs
print(json.dumps(report, ensure_ascii=False, default=str))
`

/** 探针结果只算一次；python3 缺失时由 skipIf 拦住，不会走到这里。 */
let cached: Report | undefined
function probe(): Report {
  if (cached) return cached
  const run = spawnSync(PYTHON!, ['-', WORKER], { input: PROBE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`探针退出码 ${run.status}：${run.stderr}`)
  cached = JSON.parse(run.stdout) as Report
  return cached
}

const asCase = (name: string): Case => probe()[name] as Case
const pick = (items: Capability[], kind: string): Capability => {
  const found = items.find(item => item.kind === kind)
  if (!found) throw new Error(`capabilities 缺 ${kind} 项`)
  return found
}
const isReasonCode = (reason?: string): boolean => /^[A-Z_]+: /.test(reason ?? '')

describe.skipIf(PYTHON === undefined)('worker.py 机器人可控性与 describe↔prepare 一致性（离线；未在真实 Isaac 中运行）', () => {
  test('URDF/原生 USD（metadata={}）不再把全部 DOF 推断为可控，并显式标注来源不可用', () => {
    const urdf = asCase('urdf')
    expect(urdf.controlled).toEqual([])
    expect(urdf.controlledSource).toBe('unavailable')
    expect(urdf.describe!.controlledJointNames).toEqual([])
    expect(urdf.describe!.controlMetadataPresent).toBe(true)
    expect(urdf.describe!.controlMetadata!.status).toBe('UNAVAILABLE')
    expect(urdf.describe!.controlMetadata!.reason).toContain('metadata={}')
  })

  test('空元数据时 describe 不报任何 controlMode（不默认 position）', () => {
    const joints = asCase('urdf').describe!.joints
    expect(joints.map(joint => joint.name)).toEqual(['j0', 'j1', 'j2'])
    for (const joint of joints) {
      expect(joint.controlMode ?? null).toBeNull()
      expect(joint.actuator ?? null).toBeNull()
    }
  })

  test('空元数据时 control 通道在 describe 与 prepare 两侧一致地不可用；joint 通道仍可用', () => {
    const urdf = asCase('urdf')
    expect(pick(urdf.capabilities!, 'control').available).toBe(false)
    expect(pick(urdf.capabilities!, 'control').reason).toContain('UNSUPPORTED_CAPABILITY')
    expect(urdf.prepareControl!.status).toBe('ERROR')
    expect(urdf.prepareControl!.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(urdf.prepareControl!.message).toContain('关节无执行器')
    expect(urdf.prepareJoint!.status).toBe('OK')
  })

  test('MJCF：controlled 只含源声明了执行器的关节，controlMode 来自源执行器模式', () => {
    const mjcf = asCase('mjcf')
    expect(mjcf.controlled).toEqual(['j0', 'j2'])
    expect(mjcf.controlledSource).toBe('source-metadata')
    expect(mjcf.jointModes).toEqual({ j0: 'torque', j1: null, j2: 'velocity' })
    expect(mjcf.describe!.controlledJointNames).toEqual(['j0', 'j2'])
    expect(mjcf.describe!.controlMetadataPresent).toBe(false)
    const rows = Object.fromEntries(mjcf.describe!.joints.map(joint => [joint.name, joint]))
    expect(rows.j0).toEqual({ name: 'j0', actuator: 'a0', controlMode: 'torque', type: 'hinge' })
    expect(rows.j1).toEqual({ name: 'j1', actuator: null, controlMode: null, type: 'hinge' })
    expect(rows.j2).toEqual({ name: 'j2', actuator: 'a2', controlMode: 'velocity', type: 'hinge' })
    expect(pick(mjcf.describe!.capabilities, 'joint').controlledSource).toBe('source-metadata')
  })

  test('被动关节与 velocity 执行器的 control 拒绝保留，且只把可寻址关节列为可用', () => {
    const mjcf = asCase('mjcf')
    expect(mjcf.prepareControlPassiveJ1!.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(mjcf.prepareControlVelocityJ2!.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(pick(mjcf.capabilities!, 'control').available).toBe(true)
    expect(pick(mjcf.capabilities!, 'control').jointNames).toEqual(['j0'])
  })

  test('trajectory 完整受控关节向量拒绝保留：空元数据与 MJCF 子集都拒绝，完整向量通过', () => {
    expect(asCase('urdf').prepareTrajectoryAllDofs!.code).toBe('INCOMPLETE_JOINT_VECTOR')
    expect(asCase('mjcf').prepareTrajectorySubset!.code).toBe('INCOMPLETE_JOINT_VECTOR')
    expect(asCase('mjcf').prepareTrajectoryComplete!.status).toBe('OK')
  })

  test('realtime 世界：control 的 manual 时钟拒绝在 capabilities 与 prepare 两侧一致', () => {
    const realtime = asCase('realtime')
    expect(pick(realtime.capabilities!, 'control').available).toBe(false)
    expect(pick(realtime.capabilities!, 'control').reason).toContain('manual world')
    expect(realtime.prepareControl!.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(realtime.prepareControl!.message).toContain('manual world')
  })

  test('capabilities 覆盖 gripper/lift/vehicle/control 与显式登记的 gait/tendon 并给出结构化可用性', () => {
    // N40：gait/tendon 在本适配层没有动作通道，必须显式登记 available:false（不能留空让调用方试错），
    // 因此顺序固定为 joint 之后紧跟这两条。
    const kinds = ['thrust', 'vehicle', 'joint', 'gait', 'tendon', 'gripper', 'lift', 'control']
    for (const name of ['urdf', 'mjcf', 'realtime', 'gripper', 'lift', 'vehicle']) {
      const items = asCase(name).capabilities ?? asCase(name).describe!.capabilities
      expect(items.map(item => item.kind)).toEqual(kinds)
      // 两条登记项必须是结构化拒绝：available:false 且 reason 带错误码前缀（与其它族同口径）。
      for (const kind of ['gait', 'tendon']) {
        expect(pick(items, kind)).toMatchObject({ kind, available: false })
        expect(isReasonCode(pick(items, kind)!.reason)).toBe(true)
      }
    }
    expect(pick(asCase('gripper').capabilities!, 'gripper')).toEqual({ kind: 'gripper', available: true, jointNames: ['j0'], maxWidthM: 0.08 })
    expect(pick(asCase('lift').capabilities!, 'lift')).toEqual({ kind: 'lift', available: true, joint: 'j0' })
    expect(pick(asCase('vehicle').capabilities!, 'vehicle')).toEqual({ kind: 'vehicle', available: true, wheels: 1, steering: false })
  })

  test('每个不可用能力都带错误码前缀 reason（不静默留空）', () => {
    for (const name of ['urdf', 'mjcf', 'realtime', 'gripperMissing', 'gripperPassive', 'liftMissing', 'liftPassive', 'vehicleBadActuator', 'vehicleBadRadius', 'vehicleNonArticulated']) {
      const caseRow = asCase(name)
      for (const item of caseRow.capabilities ?? caseRow.describe!.capabilities) {
        if (item.available) continue
        expect(isReasonCode(item.reason)).toBe(true)
      }
    }
    expect(isReasonCode(probe().thrust.reason)).toBe(true)
  })

  test('合成负对照：源声明 actuator 名但 actuators 表缺该条目时，describe 仍不默认 position', () => {
    const synthetic = probe().synthetic
    expect(synthetic.jointMode).toBeNull()
    expect(synthetic.describe.joints.find(joint => joint.name === 'j0')!.controlMode ?? null).toBeNull()
    expect(synthetic.describe.capabilities.find(item => item.kind === 'control')!.available).toBe(false)
    expect(synthetic.prepareControl.status).toBe('ERROR')
  })

  test('逐案例：capabilities 的 available 与同实体同动作的 prepare 结论一致，拒绝原因同错误码', () => {
    const pairs = probe().pairs
    expect(pairs.map(item => `${item.name}/${item.kind}`)).toEqual([
      'urdf 空元数据/control', 'urdf 空元数据/joint', 'mjcf 声明了 actuator/control', 'realtime 世界/control',
      'gripper 配置齐备/gripper', 'gripper 缺 controller.gripper/gripper', 'gripper 指向被动关节 j1/gripper',
      'lift 配置齐备/lift', 'lift 缺 controller.lift/lift', 'lift 指向被动关节 j1/lift',
      'vehicle 配置齐备/vehicle', 'vehicle 轮执行器无法寻址/vehicle', 'vehicle 轮径非正/vehicle', 'vehicle 无关节实体/vehicle'])
    for (const row of pairs) {
      expect({ case: `${row.name}/${row.kind}`, available: row.available }).toEqual({ case: `${row.name}/${row.kind}`, available: row.prepare === 'OK' })
      if (!row.available) expect(row.reason!.split(':')[0]).toBe(row.prepareCode!)
    }
  })
})

if (PYTHON === undefined) test('缺少系统 python3', () => { throw new Error('本机没有可用的 python3，能力断言未运行') })
