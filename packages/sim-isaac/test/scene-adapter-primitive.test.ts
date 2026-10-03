/**
 * ISAAC-07／ISAAC-10（T2）离线核对：`SceneAdapter.primitive` 的组合 `shapes[]`、子形状 `center`、
 * 摩擦/恢复系数与质量消费。
 *
 * 做法：用 AST 从 `packages/sim-isaac/python/scene_adapter.py` 抽出**真源码**的 `primitive()` 与两个
 * 声明校验函数（不复制、不重写逻辑），在本文件内置的假 pxr stage 上执行，断言调用序列与属性值。
 * 本机若有 Isaac 环境的 python（自带真 pxr），同一份 harness 会再用**真 USD stage** 跑一遍同样断言
 * （PhysxSchema 仍是记录型替身：本地 pxr 26.08 不带该插件，要 Kit 才加载）。
 *
 * 边界（不夸大）：这不是引擎实测——没有启动 Kit、没有 PhysX 步进、没有接触结果；
 * “Isaac 里真能这样碰”仍未验证。缺解释器时本文件直接失败，不静默跳过。
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 负对照入口：LYAPUNOV_SCENE_ADAPTER 指向旧版本 scene_adapter.py 复跑本文件，断言必须失败；
// 默认永远是被测的真实源码路径。
const SOURCE = process.env.LYAPUNOV_SCENE_ADAPTER ?? resolve(HERE, '..', 'python', 'scene_adapter.py')
const REPO = resolve(HERE, '..', '..', '..')

const HARNESS = `
"""Offline stage probe for SceneAdapter.primitive (T2 ISAAC-07/10).

Runs the REAL primitive() source (AST-extracted from scene_adapter.py -- not a copy)
against either real pxr USD (when the interpreter has it, e.g. the Isaac env python)
or a recording stub of the pxr surface primitive() uses. Prints one JSON document.

This is NOT an engine run: no Kit, no PhysX stepping. In the stub mode no USD
library is loaded at all; in the real-USD mode PhysxSchema is still a recording
stub (the local USD 26.08 ships without the PhysX schema plugin).
"""
import ast
import json
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse,unquote
from types import SimpleNamespace

SOURCE = sys.argv[1]


def make_stub_pxr():
    class _Op(object):
        def __init__(self, name):
            self.name = name
            self.value = None

        def Set(self, value):
            self.value = value
            return self

    class _Attr(object):
        def __init__(self, prim, name, value):
            self.prim = prim
            self.name = name
            prim.attrs[name] = value

        def Set(self, value):
            self.prim.attrs[self.name] = value
            return self

    class _Prim(object):
        def __init__(self, path, type_name):
            self.path = path
            self.type_name = type_name
            self.attrs = {}
            self.rels = {}
            self.schemas = []
            self.ops = []

        def IsA(self, schema):return self.type_name==schema.type_name

    class _Stage(object):
        def __init__(self):
            self.prims = {}

        def define(self, path, type_name):
            if path not in self.prims:
                self.prims[path] = _Prim(path, type_name)
            return self.prims[path]

    class _Geom(object):
        def __init__(self, prim):
            self.prim = prim

        def GetPrim(self):
            return self.prim

        def GetPath(self):
            return self.prim.path

        def CreateSizeAttr(self, value):
            return _Attr(self.prim, 'size', float(value))

        def CreateRadiusAttr(self, value):
            return _Attr(self.prim, 'radius', float(value))

        def CreateHeightAttr(self, value):
            return _Attr(self.prim, 'height', float(value))

        def CreateAxisAttr(self, value):
            return _Attr(self.prim, 'axis', str(value))
        def CreatePointsAttr(self,value):return _Attr(self.prim,'points',value)
        def CreateFaceVertexCountsAttr(self,value):return _Attr(self.prim,'faceVertexCounts',value)
        def CreateFaceVertexIndicesAttr(self,value):return _Attr(self.prim,'faceVertexIndices',value)
        def CreateSubdivisionSchemeAttr(self,value):return _Attr(self.prim,'subdivisionScheme',value)
        def GetPointsAttr(self):return SimpleNamespace(Get=lambda:self.prim.attrs['points'])
        def GetFaceVertexCountsAttr(self):return SimpleNamespace(Get=lambda:self.prim.attrs['faceVertexCounts'])

        def _op(self, name):
            op = _Op(name)
            self.prim.ops.append(op)
            return op

        def AddTranslateOp(self, **kwargs):
            return self._op('xformOp:translate')

        def AddScaleOp(self, **kwargs):
            return self._op('xformOp:scale')

        def AddTransformOp(self, **kwargs):
            return self._op('xformOp:transform')

        def ClearXformOpOrder(self):
            self.prim.ops = []

    class _Define(object):
        def __init__(self, type_name):
            self.type_name = type_name

        def Define(self, stage, path):
            return _Geom(stage.define(path, self.type_name))

    class _Api(object):
        def __init__(self, schema, attrs):
            self.schema = schema
            self.attrs = attrs

        def __call__(self,prim):
            return SimpleNamespace(GetApproximationAttr=lambda:SimpleNamespace(Get=lambda:prim.attrs['physics:approximation']))

        def Apply(self, prim):
            if self.schema not in prim.schemas:
                prim.schemas.append(self.schema)
            api = self

            class _Applied(object):
                def __getattr__(self, name):
                    attr = api.attrs.get(name)
                    if attr is None:
                        raise AttributeError(name)

                    def create(value):
                        return _Attr(prim, attr, value)
                    return create
            return _Applied()

    class _Matrix(object):
        def __init__(self, rows):
            self.rows = rows
        def GetDeterminant(self):return self.rows[0][0]*self.rows[1][1]*self.rows[2][2]

    class _Gf(object):
        @staticmethod
        def Vec3f(*values):
            return [float(v) for v in values]

        @staticmethod
        def Vec3d(*values):
            return [float(v) for v in values]

    class _Material(object):
        def __init__(self, stage, path):
            self.prim = stage.define(path, 'Material')

        def GetPrim(self):
            return self.prim

    class _Binding(object):
        def __init__(self, prim):
            self.prim = prim

        def Bind(self, material, strength, purpose):
            self.prim.rels['material:binding:' + purpose] = [material.prim.path]
            if 'MaterialBindingAPI' not in self.prim.schemas:
                self.prim.schemas.append('MaterialBindingAPI')

    pxr = {
        'Gf': _Gf,
        'UsdGeom': SimpleNamespace(Xform=_Define('Xform'), Mesh=_Define('Mesh'), Cube=_Define('Cube'), Sphere=_Define('Sphere'),
                                   Cylinder=_Define('Cylinder'), Capsule=_Define('Capsule')),
        'UsdPhysics': SimpleNamespace(
            CollisionAPI=_Api('PhysicsCollisionAPI', {'CreateCollisionEnabledAttr':'physics:collisionEnabled'}),
            MeshCollisionAPI=_Api('PhysicsMeshCollisionAPI', {'CreateApproximationAttr':'physics:approximation'}),
            RigidBodyAPI=_Api('PhysicsRigidBodyAPI', {}),
            MaterialAPI=_Api('PhysicsMaterialAPI', {
                'CreateStaticFrictionAttr': 'physics:staticFriction',
                'CreateDynamicFrictionAttr': 'physics:dynamicFriction',
                'CreateRestitutionAttr': 'physics:restitution',
            }),
            MassAPI=_Api('PhysicsMassAPI', {'CreateMassAttr': 'physics:mass'})),
        'PhysxSchema': SimpleNamespace(
            PhysxCollisionAPI=_Api('PhysxCollisionAPI', {
                'CreateContactOffsetAttr': 'physxCollision:contactOffset',
                'CreateRestOffsetAttr': 'physxCollision:restOffset',
            }),
            PhysxRigidBodyAPI=_Api('PhysxRigidBodyAPI', {
                'CreateDisableGravityAttr':'physxRigidBody:disableGravity',
                'CreateEnableCCDAttr': 'physxRigidBody:enableCCD',
                'CreateSolverPositionIterationCountAttr': 'physxRigidBody:solverPositionIterationCount',
                'CreateSolverVelocityIterationCountAttr': 'physxRigidBody:solverVelocityIterationCount',
            })),
        'UsdShade': SimpleNamespace(
            Material=type('Material', (), {'Define': staticmethod(lambda stage, path: _Material(stage, path))}),
            MaterialBindingAPI=type('MaterialBindingAPI', (), {'Apply': staticmethod(lambda prim: _Binding(prim))}),
            Tokens=SimpleNamespace(weakerThanDescendants='weakerThanDescendants')),
    }

    def root_matrix(translation, scale):
        rows = [[scale[0], 0.0, 0.0, 0.0],
                [0.0, scale[1], 0.0, 0.0],
                [0.0, 0.0, scale[2], 0.0],
                [translation[0], translation[1], translation[2], 1.0]]
        return _Matrix(rows)

    def dump(stage):
        prims = []
        for path in stage.prims:
            prim = stage.prims[path]
            prims.append({'path': path, 'type': prim.type_name, 'schemas': list(prim.schemas),
                          'attrs': {k: dump_value(v) for k, v in prim.attrs.items()},
                          'rels': {k: list(v) for k, v in prim.rels.items()},
                          'ops': [{'name': op.name, 'value': dump_value(op.value)} for op in prim.ops],
                          'world': None})
        return {'mode': 'stub-stage', 'prims': prims}

    return pxr, _Stage, root_matrix, dump


def make_real_pxr():
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, UsdShade

    class _Api(object):
        def __init__(self, schema, attrs):
            self.schema = schema
            self.attrs = attrs

        def Apply(self, prim):
            api = self

            class _Applied(object):
                def __getattr__(self, name):
                    attr_name = api.attrs.get(name)
                    if attr_name is None:
                        raise AttributeError(name)

                    def create(value):
                        kind = Sdf.ValueTypeNames.Bool if isinstance(value, bool) else Sdf.ValueTypeNames.Float
                        return prim.CreateAttribute(attr_name, kind).Set(value)
                    return create
            return _Applied()

    # 本地 pxr 26.08 不带 PhysX schema 插件（要 Kit 才加载）：PhysxSchema 一律记录型替身，
    # 几何/材质/质量走真 USD schema，属性值从真 stage 读回。
    physx = SimpleNamespace(
        PhysxCollisionAPI=_Api('PhysxCollisionAPI', {
            'CreateContactOffsetAttr': 'physxCollision:contactOffset',
            'CreateRestOffsetAttr': 'physxCollision:restOffset',
        }),
        PhysxRigidBodyAPI=_Api('PhysxRigidBodyAPI', {
            'CreateDisableGravityAttr':'physxRigidBody:disableGravity',
            'CreateEnableCCDAttr': 'physxRigidBody:enableCCD',
            'CreateSolverPositionIterationCountAttr': 'physxRigidBody:solverPositionIterationCount',
            'CreateSolverVelocityIterationCountAttr': 'physxRigidBody:solverVelocityIterationCount',
        }))

    def root_matrix(translation, scale):
        matrix = Gf.Matrix4d(1)
        matrix.SetScale(Gf.Vec3d(scale[0], scale[1], scale[2]))
        matrix.SetTranslateOnly(Gf.Vec3d(translation[0], translation[1], translation[2]))
        return matrix

    def dump(stage):
        prims = []
        for prim in stage.Traverse():
            ops = []
            world = None
            try:
                xformable = UsdGeom.Xformable(prim)
                for op in xformable.GetOrderedXformOps():
                    ops.append({'name': op.GetName(), 'value': dump_value(op.Get())})
                # 用 USD 自己的父链复合独立复核落点（stub 模式没有真 stage，这一层不可用）。
                world = [float(v) for v in xformable.ComputeLocalToWorldTransform(Usd.TimeCode.Default()).ExtractTranslation()]
            except Exception:
                pass
            prims.append({'path': str(prim.GetPath()), 'type': str(prim.GetTypeName()),
                          'schemas': list(prim.GetAppliedSchemas()),
                          'attrs': {a.GetName(): dump_value(a.Get()) for a in prim.GetAttributes() if a.Get() is not None},
                          'rels': {r.GetName(): [str(t) for t in r.GetTargets()] for r in prim.GetRelationships()},
                          'ops': ops, 'world': world})
        return {'mode': 'real-usd', 'prims': prims}

    return {'Gf': Gf, 'UsdGeom': UsdGeom, 'UsdPhysics': UsdPhysics, 'UsdShade': UsdShade, 'Usd': Usd,
            'PhysxSchema': physx}, None, root_matrix, dump


def dump_value(value):
    # 真 USD 会带出 -inf（如 physics:centerOfMass 未设时的默认值）：JSON 只允许有限数，
    # 非有限量记成 null，不让解析层看到 Infinity 这种非标准记号。
    def number(raw):
        raw = float(raw)
        return raw if raw == raw and raw not in (float('inf'), float('-inf')) else None

    if value is None:
        return {'kind': 'none'}
    if hasattr(value, 'rows'):
        return {'kind': 'matrix', 'rows': value.rows}
    if hasattr(value, 'ExtractTranslation'):
        return {'kind': 'matrix', 'rows': [[float(value[i][j]) for j in range(4)] for i in range(4)]}
    if isinstance(value, bool):
        return {'kind': 'scalar', 'value': value}
    if isinstance(value, (int, float)):
        return {'kind': 'scalar', 'value': number(value)}
    if isinstance(value, str):
        return {'kind': 'text', 'value': value}
    try:
        return {'kind': 'vector', 'value': [number(v) for v in value]}
    except (TypeError, ValueError):
        return {'kind': 'other', 'repr': repr(value)}


def load_primitive(source_path):
    """只搬真源码的声明校验函数与 primitive()（其余函数不执行，也不复制它们的行为）。"""
    tree = ast.parse(open(source_path, encoding='utf-8').read())
    body = [node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name in ('collision_vector', 'collision_scalar','collision_mesh','local_path','scene_mesh_approximation')]
    body.append([node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'SceneError'][0])
    adapter = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'SceneAdapter'][0]
    body.append(ast.ClassDef(name='ExtractedPrimitive', bases=[], keywords=[], decorator_list=[],
                             body=[node for node in adapter.body
                                   if isinstance(node, ast.FunctionDef) and node.name == 'primitive']))
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    return module


def main():
    try:
        namespace, make_stage, root_matrix, dump = make_real_pxr()
    except Exception:
        namespace, make_stage, root_matrix, dump = make_stub_pxr()
    namespace['math'] = __import__('math')
    namespace.update({'Path':Path,'urlparse':urlparse,'unquote':unquote})
    module = load_primitive(SOURCE)
    exec(compile(module, SOURCE, 'exec'), namespace)
    adapter = namespace['ExtractedPrimitive']()

    def run(name, collision, rigid, translation, scale, binding=None):
        stage = make_stage() if make_stage else namespace['Usd'].Stage.CreateInMemory()
        matrix = root_matrix(translation, scale)
        entry = {'scenario': name}
        try:
            entry['result'] = adapter.primitive(stage, '/World/entities/e0', collision, rigid, matrix, binding)
        except namespace['SceneError'] as error:
            entry['error'] = {'code': error.code, 'message': str(error)}
        except Exception as error:
            # 非 SceneError 的异常照样记账（负对照跑旧代码时会在这里出现），不让一个场景炸掉整份
            # 探针；正向断言里 error 必须未定义，所以这类异常一定会让测试失败，不会被吞掉。
            entry['error'] = {'code': 'UNEXPECTED_' + type(error).__name__, 'message': str(error)}
        entry['dump'] = dump(stage)
        return entry

    scenarios = [
        # 组合盒：顶层 halfExtents 是干扰项，两个子盒各自的 center/halfExtents 才是声明事实。
        run('multi-box-offset', {'shape': 'box', 'halfExtents': [9, 9, 9],
                                 'shapes': [{'center': [.4, 0, .1], 'halfExtents': [.15, .2, .15]},
                                            {'center': [-.1, .35, .2], 'halfExtents': [.2, .15, .15]}],
                                 'friction': [.7, .02, .005], 'material': 'plastic'},
            {'type': 'dynamic', 'massKg': 2.5}, [1, -2, .5], [2, 1, 1]),
        # 单盒带 center：旧代码整段忽略 center。
        run('single-box-center', {'shape': 'box', 'halfExtents': [.5, .3, .2], 'center': [.5, 0, .25], 'friction': 1.0},
            {'type': 'static'}, [1, 2, 3], [2, 1, .5]),
        # 材质三份量 + 恢复系数 + 默认质量。
        run('sphere-material', {'shape': 'sphere', 'radiusM': .25, 'friction': [.6, .03, .008], 'restitution': .12},
            {'type': 'dynamic'}, [0, 0, 0], [1, 1, 1]),
        run('cylinder-size', {'shape': 'cylinder', 'halfExtents': [.2, .3, .01]}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
        # 负对照：必须报错，且报错前不落任何 prim。
        run('missing-size', {'type': 'box'}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
        run('missing-shape-entry-size', {'shape': 'box', 'shapes': [{'center': [1, 0, 0]}]}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
        run('unsupported-shape', {'shape': 'sdf', 'parts': ['file:///tmp/x.obj']}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
        run('material-without-friction', {'shape': 'box', 'halfExtents': [.1, .1, .1], 'material': 'rubber'}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
        run('shapes-not-box', {'shape': 'sphere', 'shapes': [{'center': [0, 0, 0], 'halfExtents': [.1, .1, .1]}]}, {'type': 'static'}, [0, 0, 0], [1, 1, 1]),
    ]
    with tempfile.TemporaryDirectory(prefix='isaac-real-mesh-') as directory:
        mesh=Path(directory)/'tetra.obj'
        mesh.write_text(chr(10).join(['v 0 0 0','v 0.2 0 0','v 0 0.2 0','v 0 0 0.2','f 1 3 2','f 1 2 4','f 1 4 3','f 2 3 4'])+chr(10))
        scenarios.append(run('mesh-box-disabled-density',{'shape':'mesh','parts':[mesh.as_uri()],'shapes':[{'center':[.8,0,0],'halfExtents':[.1,.1,.1]}],'enabled':False,'friction':[.7,.02,.005]},
                             {'type':'dynamic','massKg':2,'massScalePolicy':'density','gravityEnabled':False},[0,0,1],[2,1,1]))
        triangle=Path(directory)/'surface.obj';triangle.write_text(chr(10).join(['v 0 0 0','v 1 0 0','v 0 1 0','f 1 2 3'])+chr(10))
        scenarios.append(run('explicit-static-triangle',{'shape':'mesh','parts':[triangle.as_uri()]},{'type':'static'},[0,0,0],[1,1,1],{'usage':'environment','strategy':'triangle_mesh'}))
        scenarios.append(run('dynamic-triangle-rejected',{'shape':'mesh','parts':[mesh.as_uri()]},{'type':'dynamic','massKg':1},[0,0,0],[1,1,1],{'usage':'environment','strategy':'triangle_mesh'}))
    print(json.dumps({'mode': scenarios[0]['dump']['mode'], 'scenarios': scenarios}, sort_keys=True))


main()
`

interface DumpValue {
  kind: string
  value?: number | number[] | string | boolean
  rows?: number[][]
}

interface DumpPrim {
  path: string
  type: string
  schemas: string[]
  attrs: Record<string, DumpValue>
  rels: Record<string, string[]>
  ops: Array<{ name: string; value: DumpValue }>
  /** 真 USD 模式：USD 自己算出的父链世界平移；stub 模式为 null。 */
  world?: number[] | null
}

interface Scenario {
  scenario: string
  result?: Record<string, any>
  error?: { code: string; message: string }
  dump: { mode: string; prims: DumpPrim[] }
}

function interpreters(): Array<{ label: string; command: string }> {
  const found: Array<{ label: string; command: string }> = []
  const isaac = process.env.LYAPUNOV_ISAAC_PY ?? resolve(REPO, '.runtime', 'conda', 'envs', 'isaac', 'bin', 'python')
  if (existsSync(isaac)) found.push({ label: 'real-usd', command: isaac })
  found.push({ label: 'stub-stage', command: process.env.LYAPUNOV_PYTHON ?? 'python3' })
  return found
}

function runHarness(command: string): { mode: string; scenarios: Scenario[] } {
  const run = spawnSync(command, ['-c', HARNESS, SOURCE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) throw new Error('离线核对无法执行 ' + command + '：' + String(run.error))
  if (run.status !== 0) throw new Error('离线核对失败 (' + command + ', exit ' + String(run.status) + ')：' + (run.stderr || run.stdout))
  return JSON.parse(run.stdout)
}

const probes = interpreters().map(entry => ({ ...entry, data: runHarness(entry.command) }))

function expectVector(actual: unknown, expected: number[], digits = 4): void {
  expect(Array.isArray(actual)).toBe(true)
  expect((actual as number[]).length).toBe(expected.length)
  expected.forEach((value, index) => expect((actual as number[])[index]!).toBeCloseTo(value, digits))
}

for (const probe of probes) {
  const scenario = (name: string): Scenario => {
    const found = probe.data.scenarios.find(entry => entry.scenario === name)
    if (!found) throw new Error('场景缺失: ' + name)
    return found
  }
  const prim = (entry: Scenario, path: string): DumpPrim => {
    const found = entry.dump.prims.find(item => item.path === path)
    if (!found) throw new Error('prim 缺失: ' + path + ' @ ' + entry.scenario)
    return found
  }
  const opValue = (entry: Scenario, path: string, opName: string): number[] => {
    const op = prim(entry, path).ops.find(item => item.name === opName)
    return (op?.value.value as number[]) ?? []
  }
  const scalar = (value: DumpValue | undefined): number => Number(value?.value)
  const rootRows = (entry: Scenario): number[][] =>
    prim(entry, '/World/entities/e0').ops.find(op => op.name === 'xformOp:transform')!.value.rows!
  // 从**记录下来的子 collider 平移**（不是输入声明）与 root 世界矩阵复算落点：USD 行向量约定下
  // 局部原点先被 translate 移动，再乘父矩阵（与 ComputeLocalToWorldTransform 的父链复合一致）。
  const worldCenter = (entry: Scenario, path: string): number[] => {
    const rows = rootRows(entry)
    const center = opValue(entry, path, 'xformOp:translate')
    return center.map((value, axis) => rows[3]![axis]! + rows[axis]![axis]! * value)
  }

  describe('SceneAdapter.primitive via ' + probe.label + ' (' + probe.command + ', ' + probe.data.mode + ')', () => {
    test('组合 shapes[] 逐盒消费，顶层单盒尺寸被忽略', () => {
      const multi = scenario('multi-box-offset')
      expect(multi.error).toBeUndefined()
      expect(multi.result!.colliderPaths).toEqual(['/World/entities/e0/geometry0', '/World/entities/e0/geometry1'])
      expect(prim(multi, '/World/entities/e0/geometry0').type).toBe('Cube')
      expect(prim(multi, '/World/entities/e0/geometry1').type).toBe('Cube')
      for (const path of ['/World/entities/e0/geometry0', '/World/entities/e0/geometry1']) {
        expect(prim(multi, path).schemas).toContain('PhysicsCollisionAPI')
        expect(prim(multi, path).schemas).toContain('MaterialBindingAPI')
        expect(prim(multi, path).rels['material:binding:physics']).toEqual(['/World/entities/e0/material'])
      }
      expectVector(opValue(multi, '/World/entities/e0/geometry0', 'xformOp:translate'), [.4, 0, .1])
      expectVector(opValue(multi, '/World/entities/e0/geometry0', 'xformOp:scale'), [.15, .2, .15])
      expectVector(opValue(multi, '/World/entities/e0/geometry1', 'xformOp:translate'), [-.1, .35, .2])
      expectVector(opValue(multi, '/World/entities/e0/geometry1', 'xformOp:scale'), [.2, .15, .15])
      // 顶层 halfExtents [9,9,9] 不得以任何形式落进 collider 尺寸，也不再有单盒退化落点。
      for (const path of ['/World/entities/e0/geometry0', '/World/entities/e0/geometry1']) {
        for (const size of opValue(multi, path, 'xformOp:scale')) expect(size).toBeLessThan(1)
      }
      expect(multi.dump.prims.some(item => item.path === '/World/entities/e0/geometry')).toBe(false)
    })

    test('子形状 center 与实体世界变换叠加成世界落点', () => {
      const multi = scenario('multi-box-offset')
      const rows = rootRows(multi)
      expectVector([rows[3]![0], rows[3]![1], rows[3]![2]], [1, -2, .5])
      expectVector([rows[0]![0], rows[1]![1], rows[2]![2]], [2, 1, 1])
      // 世界落点 = root 平移 + root 逐轴 scale ⊙ 子形状 center（与 poses() 的父链复合同口径）。
      expectVector(worldCenter(multi, '/World/entities/e0/geometry0'), [1 + .4 * 2, -2, .5 + .1])
      expectVector(worldCenter(multi, '/World/entities/e0/geometry1'), [1 - .1 * 2, -2 + .35, .5 + .2])
      // 真 USD 模式再由 USD 自己的父链复合独立复核同一落点（stub 模式没有真 stage，这层不适用）。
      if (probe.data.mode === 'real-usd') {
        expectVector(prim(multi, '/World/entities/e0/geometry0').world, [1.8, -2, .6])
        expectVector(prim(multi, '/World/entities/e0/geometry1').world, [.8, -1.65, .7])
      }
    })

    test('单个形状的 center 与尺寸也落位（旧代码忽略 center）', () => {
      const single = scenario('single-box-center')
      expect(single.error).toBeUndefined()
      expect(single.result!.colliderPaths).toEqual(['/World/entities/e0/geometry'])
      expectVector(opValue(single, '/World/entities/e0/geometry', 'xformOp:translate'), [.5, 0, .25])
      expectVector(opValue(single, '/World/entities/e0/geometry', 'xformOp:scale'), [.5, .3, .2])
      expectVector(worldCenter(single, '/World/entities/e0/geometry'), [1 + .5 * 2, 2, 3 + .25 * .5])
      if (probe.data.mode === 'real-usd') expectVector(prim(single, '/World/entities/e0/geometry').world, [2, 2, 3.125])
      expect(scalar(prim(single, '/World/entities/e0/geometry').attrs.size)).toBeCloseTo(2, 5)
    })

    test('球/柱尺寸按声明落位，未知形状与缺尺寸在造 prim 前明确报错', () => {
      const cylinder = scenario('cylinder-size')
      expect(cylinder.error).toBeUndefined()
      const geom = prim(cylinder, '/World/entities/e0/geometry')
      expect(geom.type).toBe('Cylinder')
      expect(scalar(geom.attrs.radius)).toBeCloseTo(.2, 5)
      expect(scalar(geom.attrs.height)).toBeCloseTo(.6, 5)
      expect(geom.attrs.axis!.value).toBe('Z')

      const missing = scenario('missing-size')
      expect(missing.error!.code).toBe('INVALID_ARGUMENT')
      expect(missing.error!.message).toContain('必须是 3 个有限正数值')
      expect(missing.dump.prims.length).toBe(0)

      const entryMissing = scenario('missing-shape-entry-size')
      expect(entryMissing.error!.code).toBe('INVALID_ARGUMENT')
      expect(entryMissing.error!.message).toContain('collision.shapes[0].halfExtents')
      expect(entryMissing.dump.prims.length).toBe(0)

      const unsupported = scenario('unsupported-shape')
      expect(unsupported.error!.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(unsupported.error!.message).toContain('sdf')
      expect(unsupported.dump.prims.length).toBe(0)

      const notBox = scenario('shapes-not-box')
      expect(notBox.error!.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(notBox.dump.prims.length).toBe(0)
    })

    test('friction 三份量分别落位，恢复系数来源可读回', () => {
      const material = scenario('multi-box-offset')
      const mat = prim(material, '/World/entities/e0/material')
      expect(mat.type).toBe('Material')
      expect(scalar(mat.attrs['physics:staticFriction'])).toBeCloseTo(.7, 5)
      expect(scalar(mat.attrs['physics:dynamicFriction'])).toBeCloseTo(.7, 5)
      expect(scalar(mat.attrs['physics:restitution'])).toBeCloseTo(0, 5)
      expect(material.result!.material.frictionTriple).toEqual([.7, .02, .005])
      expect(material.result!.material.frictionSource).toBe('declared')
      expect(material.result!.material.declaredMaterial).toBe('plastic')
      // 静/动两条来源分别记账（不是把 friction[0] 无差别写两处、无出处）。
      expect(material.result!.material.staticFriction.source).toContain('friction[0]')
      expect(material.result!.material.dynamicFriction.source).toContain('friction[0]')
      expect(material.result!.material.staticFriction.source).not.toBe(material.result!.material.dynamicFriction.source)
      // 源三元组的扭转/滚动分量没有 PhysX 等价通道：如实记录，不塞进恢复系数也不丢弃。
      expect(material.result!.material.notExpressed.torsional).toBeCloseTo(.02, 6)
      expect(material.result!.material.notExpressed.rolling).toBeCloseTo(.005, 6)
      expect(material.result!.material.restitution).toEqual({ value: 0, source: 'default' })

      const sphere = scenario('sphere-material')
      const sphereMaterial = prim(sphere, '/World/entities/e0/material')
      expect(scalar(sphereMaterial.attrs['physics:staticFriction'])).toBeCloseTo(.6, 5)
      expect(scalar(sphereMaterial.attrs['physics:dynamicFriction'])).toBeCloseTo(.6, 5)
      expect(scalar(sphereMaterial.attrs['physics:restitution'])).toBeCloseTo(.12, 5)
      expect(sphere.result!.material.restitution.source).toBe('declared')
      expect(sphere.result!.material.notExpressed.torsional).toBeCloseTo(.03, 6)
      expect(sphere.result!.material.notExpressed.rolling).toBeCloseTo(.008, 6)

      // 标量 friction 按 asset-bake frictionTripleFromSliding 的比例展开（与 MuJoCo 侧逐值一致）。
      const scalarFriction = scenario('single-box-center')
      expect(scalarFriction.result!.material.frictionSource).toBe('declared-scalar')
      expectVector(scalarFriction.result!.material.frictionTriple, [1, .05, .005])
      expect(scalar(prim(scalarFriction, '/World/entities/e0/material').attrs['physics:dynamicFriction'])).toBeCloseTo(1, 5)

      const undeclared = scenario('cylinder-size')
      expect(undeclared.result!.material.frictionSource).toBe('default')
      expectVector(undeclared.result!.material.frictionTriple, [1, .005, .0001])
      expect(undeclared.result!.material.restitution.source).toBe('default')

      const materialOnly = scenario('material-without-friction')
      expect(materialOnly.error!.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(materialOnly.error!.message).toContain('rubber')
      expect(materialOnly.dump.prims.length).toBe(0)
    })

    test('质量区分默认与源声明，并可从结果读回来源', () => {
      const declared = scenario('multi-box-offset')
      expect(scalar(prim(declared, '/World/entities/e0').attrs['physics:mass'])).toBeCloseTo(2.5, 5)
      expect(declared.result!.mass).toEqual({ type: 'dynamic', massKg: 2.5, source: 'declared' })

      const fallback = scenario('sphere-material')
      expect(scalar(prim(fallback, '/World/entities/e0').attrs['physics:mass'])).toBeCloseTo(1, 5)
      expect(fallback.result!.mass).toEqual({ type: 'dynamic', massKg: 1, source: 'default' })

      const staticBody = scenario('single-box-center')
      expect(staticBody.result!.mass.massKg).toBeNull()
      expect(staticBody.result!.mass.source).toContain('not-applicable')
      expect(prim(staticBody, '/World/entities/e0').schemas).not.toContain('PhysicsRigidBodyAPI')
    })
    test('真实OBJ凸件与额外盒组成多collider，gravity/enabled和密度质量进入实际USD属性',()=>{
      const compound=scenario('mesh-box-disabled-density')
      expect(compound.error).toBeUndefined()
      expect(compound.result!.colliderPaths).toHaveLength(2)
      expect(prim(compound,'/World/entities/e0/geometry0').type).toBe('Mesh')
      expect(prim(compound,'/World/entities/e0/geometry0').attrs['physics:approximation']?.value).toBe('convexHull')
      expectVector(prim(compound,'/World/entities/e0/geometry0').attrs['faceVertexCounts']?.value,[3,3,3,3])
      expect(prim(compound,'/World/entities/e0/geometry0').attrs['physics:collisionEnabled']?.value).toBe(false)
      expect(prim(compound,'/World/entities/e0/geometry1').attrs['physics:collisionEnabled']?.value).toBe(false)
      expect(prim(compound,'/World/entities/e0').attrs['physxRigidBody:disableGravity']?.value).toBe(true)
      expect(scalar(prim(compound,'/World/entities/e0').attrs['physics:mass'])).toBeCloseTo(4,6)
    })
    test('明确静态原三角面真实USD approximation=none且不挂动态API；动态同请求在写prim前拒绝',()=>{
      const native=scenario('explicit-static-triangle'),rejected=scenario('dynamic-triangle-rejected')
      expect(native.error).toBeUndefined()
      expect(prim(native,'/World/entities/e0/geometry').attrs['physics:approximation']?.value).toBe('none')
      expectVector(prim(native,'/World/entities/e0/geometry').attrs['faceVertexCounts']?.value,[3])
      expect(prim(native,'/World/entities/e0').schemas).not.toContain('PhysicsRigidBodyAPI')
      expect(rejected.error?.code).toBe('UNSUPPORTED_CAPABILITY');expect(rejected.error?.message).toContain('ISAAC_STATIC_TRIANGLE_MESH_REQUIRED')
      expect(rejected.dump.prims).toHaveLength(0)
    })

    test('声明源码不再用沉默的 0.1 米默认盒', () => {
      const source = readFileSync(SOURCE, 'utf8')
      // 用 boolean 断言：失败时只报事实，不把整份源码打进日志。
      expect(source.includes('[.1,.1,.1]')).toBe(false)
      expect(source.includes("collision.get('shape'")).toBe(true)
    })
  })
}
