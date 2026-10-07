/** CPU 兼容 API 的离线适配契约；记录型 core.prims 不启动 Kit，也不证明物理运行。 */
import { beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const PYTHON = process.env.TESTCI_PYTHON || 'python3'
const ROOT = resolve(import.meta.dir, '..', 'python')
const FIXTURE = String.raw`
import ast,contextlib,importlib.util,json,sys,tomllib,types
from pathlib import Path
import numpy as np
root=Path(sys.argv[1]);calls=[];simulation_view=object()
class CoreXform:
 def __init__(self,paths,reset_xform_properties=True):
  self.prim_paths=paths if isinstance(paths,list) else [paths];self.count=len(self.prim_paths);self.valid=True
  calls.append(['construct',reset_xform_properties])
 def get_world_poses(self,usd=True):calls.append(['pose',usd]);return np.array([[1,2,3] if usd else [4,5,6]]),np.array([[1,0,0,0]])
 def set_world_poses(self,positions=None,orientations=None,usd=True):calls.append(['set-pose',usd,positions.tolist(),orientations.tolist()])
class CoreRigid(CoreXform):
 def is_physics_handle_valid(self):return self.valid
 def initialize(self):calls.append(['initialize'])
 def get_velocities(self):return np.array([[10,20,30,40,50,60]],dtype=np.float32)
 def set_velocities(self,value):calls.append(['velocity',value.tolist()])
 def get_masses(self):return np.array([2.5])
 def apply_forces_and_torques_at_pos(self,**kwargs):calls.append(['force',{k:v.tolist() if hasattr(v,'tolist') else v for k,v in kwargs.items()}])
class CoreArt(CoreRigid):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs);self.dof_names=['a','b'];self._physics_view=self
  self.link_paths=[['/World/a/base','/World/a/link']];self.friction=np.array([[[1,2,3],[4,5,6]]],dtype=np.float32)
 def get_dof_types(self):return ['Rotation','Translation']
 def get_joint_positions(self):return np.array([[.1,.2]])
 def get_joint_velocities(self):return np.array([[.3,.4]])
 def get_dof_limits(self):return np.array([[[-1,1],[-2,2]]])
 def get_gains(self):return np.array([[11,12]]),np.array([[21,22]])
 def get_max_efforts(self):return np.array([[7,8]])
 def get_drive_types(self):return np.array([[1,2]])
 def set_joint_position_targets(self,value,**kwargs):calls.append(['target',value.tolist(),{k:v.tolist() for k,v in kwargs.items()}])
 def get_dof_friction_properties(self):return self.friction
 def set_dof_friction_properties(self,value,indices):self.friction=value.copy();calls.append(['friction',indices.tolist()])
def install(name,**values):
 m=types.ModuleType(name);m.__dict__.update(values);sys.modules[name]=m;return m
install('isaacsim');install('isaacsim.core');install('isaacsim.core.prims',XFormPrim=CoreXform,RigidPrim=CoreRigid,Articulation=CoreArt)
install('isaacsim.core.simulation_manager',SimulationManager=types.SimpleNamespace(get_physics_sim_view=lambda:simulation_view))
spec=importlib.util.spec_from_file_location('cpu_prims',root/'cpu_prims.py');cpu=importlib.util.module_from_spec(spec);spec.loader.exec_module(cpu)
rigid=cpu.RigidPrim('/World/a');initial=rigid.get_world_poses()[0].tolist()
with cpu.use_backend('tensor'):
 tensor=rigid.get_world_poses()[0].tolist()
 with cpu.use_backend('usd'):nested=rigid.get_world_poses()[0].tolist()
 restored=rigid.get_world_poses()[0].tolist()
 rigid.set_world_poses([[7,8,9]],[[1,0,0,0]])
final=rigid.get_world_poses()[0].tolist()
linear,angular=rigid.get_velocities();rigid.set_velocities(linear_velocities=[[1,2,3]])
mass=rigid.get_masses().tolist()
rigid.apply_forces_and_torques_at_pos(forces=[[1,2,3]],torques=[[4,5,6]])
robot=cpu.Articulation('/World/a');lower,upper=robot.get_dof_limits()
robot.set_dof_position_targets([.8],dof_indices=[1]);robot.set_dof_friction_properties(viscous_frictions=[9],dof_indices=[1])
readonly=robot.get_dof_friction_properties()[2];readonly[0,1]=99
errors=[]
for mode in ['invalid-handle','no-native-view','fabric']:
 try:
  if mode=='fabric':
   with cpu.use_backend('fabric'):pass
  else:
   rigid._core.valid=False
   if mode=='no-native-view':simulation_view=None
   rigid.get_velocities()
 except cpu.CpuPrimError as error:errors.append([mode,error.code])
 else:raise AssertionError('Invalid native boundary was accepted: '+mode)
# 执行真源码里的条件表达式；不重新写一份 CPU/GPU 判定。
worker=ast.parse((root/'worker.py').read_text());cpu_expr=next(n.value for n in worker.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='cpu_native' for t in n.targets))
scene=ast.parse((root/'scene_adapter.py').read_text());prims_if=next(n for n in scene.body if isinstance(n,ast.If) and any(isinstance(x,ast.ImportFrom) and x.module=='cpu_prims' for x in n.body))
rows=[]
for device,render in [('cpu','none'),('cpu','rtx'),('cuda','none'),('cuda','rtx')]:
 env={'LYAPUNOV_ISAAC_DEVICE':device,'LYAPUNOV_ISAAC_RENDERING':render};ns={'os':types.SimpleNamespace(environ=env),'rendering':render=='rtx'}
 selected=eval(compile(ast.Expression(cpu_expr),str(root/'worker.py'),'eval'),ns)
 adapter=eval(compile(ast.Expression(prims_if.test),str(root/'scene_adapter.py'),'eval'),ns)
 rows.append([device,render,selected,adapter])
profile=tomllib.loads((root/'physics-cpu.kit').read_text())
# 执行实际worker生命周期护栏；不加载SDK，不把合成is_running状态签成引擎运行。
guard=next(n for n in worker.body if isinstance(n,ast.If) and isinstance(n.test,ast.Name) and n.test.id=='cpu_native' and any(isinstance(x,ast.If) for x in n.body))
lifecycle=[]
for enabled,running in [(False,False),(True,False),(True,True)]:
 def fail(code,message,stage):raise RuntimeError(code+'|'+stage+'|'+message)
 app_state=types.SimpleNamespace(is_running=lambda:running)
 app_api=types.SimpleNamespace(get_app=lambda:app_state)
 ns={'cpu_native':enabled,'emit':lambda value:None,'omni':types.SimpleNamespace(kit=types.SimpleNamespace(app=app_api)),'fail_startup':fail}
 try:exec(compile(ast.Module(body=[guard],type_ignores=[]),str(root/'worker.py'),'exec'),ns);lifecycle.append([enabled,running,'ALLOW'])
 except RuntimeError as error:lifecycle.append([enabled,running,str(error)])
print(json.dumps({'initial':initial,'tensor':tensor,'nested':nested,'restored':restored,'final':final,
 'linear':linear.tolist(),'angular':angular.tolist(),'calls':calls,'paths':rigid.paths,'masses':mass,
 'limits':[lower.tolist(),upper.tolist()],'driveTypes':robot.get_dof_drive_types(),'jointPositions':robot.get_dof_positions().tolist(),
 'friction':robot.get_dof_friction_properties()[2].tolist(),'links':robot.link_paths,'errors':errors,'selection':rows,
 'profileDependencies':list(profile['dependencies']),'manualRunLoop':profile['settings'].get('app',{}).get('runLoops',{}).get('main',{}).get('manualModeEnabled'),'lifecycle':lifecycle,'experimentalImported':any(x.startswith('isaacsim.core.experimental.prims') for x in sys.modules)}))
`
let result: Record<string, any>
beforeAll(() => {
  const run = spawnSync(PYTHON, ['-c', FIXTURE, ROOT], { encoding: 'utf8', timeout: 20_000 })
  if (run.status !== 0) throw new Error(`CPU 适配契约失败 exit=${run.status}: ${run.stderr}`)
  result = JSON.parse(run.stdout)
})

test('CPU/none 消费兼容 API，GPU 与 RTX 保留实验 API 分支', () => {
  expect(result.selection).toEqual([['cpu', 'none', true, true], ['cpu', 'rtx', false, false], ['cuda', 'none', false, false], ['cuda', 'rtx', false, false]])
  expect(result.profileDependencies).not.toContain('isaacsim.core.experimental.prims')
  expect(result.experimentalImported).toBe(false)
  expect(result.calls.filter((row: any[]) => row[0] === 'construct').every((row: any[]) => row[1] === false)).toBe(true)
})
test('USD 与 tensor 原生读数分开，嵌套上下文恢复且保留 scalar-first quaternion', () => {
  expect(result.initial).toEqual([[1, 2, 3]])
  expect(result.tensor).toEqual([[4, 5, 6]])
  expect(result.nested).toEqual([[1, 2, 3]])
  expect(result.restored).toEqual([[4, 5, 6]])
  expect(result.final).toEqual([[1, 2, 3]])
  expect(result.calls.find((row: any[]) => row[0] === 'set-pose')).toEqual(['set-pose', false, [[7, 8, 9]], [[1, 0, 0, 0]]])
})
test('速度与外力直接进入原生 API，未指定的角速度保持原读数', () => {
  expect(result.linear).toEqual([[10, 20, 30]])
  expect(result.angular).toEqual([[40, 50, 60]])
  expect(result.masses).toEqual([2.5])
  expect(result.calls.find((row: any[]) => row[0] === 'velocity')).toEqual(['velocity', [[1, 2, 3, 40, 50, 60]]])
  expect(result.calls.find((row: any[]) => row[0] === 'force')).toEqual(['force', { forces: [[1, 2, 3]], torques: [[4, 5, 6]], positions: null, is_global: true }])
})
test('DOF 名字、索引、上下限与 PhysX 摩擦分量准确适配', () => {
  expect(result.paths).toEqual(['/World/a'])
  expect(result.limits).toEqual([[[-1, -2]], [[1, 2]]])
  expect(result.driveTypes).toEqual(['force', 'acceleration'])
  expect(result.calls.find((row: any[]) => row[0] === 'target')[2]).toEqual({ joint_indices: [1] })
  expect(result.friction).toEqual([[3, 9]])
  expect(result.links).toEqual([['/World/a/base', '/World/a/link']])
})
test('无效原生 handle 与不支持的 Fabric 都拒绝，无 USD 静默回退', () => {
  expect(result.errors).toEqual([['invalid-handle', 'PHYSICS_NOT_READY'], ['no-native-view', 'PHYSICS_NOT_READY'], ['fabric', 'UNSUPPORTED_CAPABILITY']])
})
test('CPU 配置使用官方手动 run loop，Kit 未运行时不能发虚假 ready', () => {
  expect(result.profileDependencies).toContain('omni.kit.loop-isaac')
  expect(result.manualRunLoop).toBe(true)
  expect(result.lifecycle).toEqual([[false, false, 'ALLOW'], [true, false, 'ISAAC_KIT_START_FAILED|kit-lifecycle|Kit application is not running after CPU initialization'], [true, true, 'ALLOW']])
})
