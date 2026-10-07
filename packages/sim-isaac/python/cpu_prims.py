"""CPU/none 的 Isaac 6.0.1 兼容 API 薄适配。

所有状态及动作直接交给 isaacsim.core.prims / 原生 PhysX tensor；不步进、不保存位姿、
不计算物理。SimulationManager 仍是 worker 的唯一时钟所有者。保留源 xform ops，
无效 tensor 必须报错，不能把 USD 声明冒充运行读数。RTX/CUDA 不使用本模块。
"""
from contextlib import contextmanager
from contextvars import ContextVar
import numpy as np
from isaacsim.core.prims import XFormPrim as _XFormPrim,RigidPrim as _RigidPrim,Articulation as _Articulation
from isaacsim.core.simulation_manager import SimulationManager

_backend=ContextVar('lyapunov_cpu_prims_backend',default='usd')

class CpuPrimError(RuntimeError):
    def __init__(self,code,message):super().__init__(message);self.code=code

@contextmanager
def use_backend(name,raise_on_fallback=True):
    if name not in ('usd','tensor'):
        raise CpuPrimError('UNSUPPORTED_CAPABILITY','CPU prims do not support backend: '+str(name))
    token=_backend.set(name)
    try:yield
    finally:_backend.reset(token)

def _array(value):
    if value is None:raise CpuPrimError('PHYSICS_NOT_READY','Native CPU prims returned no state')
    return np.asarray(value.numpy() if hasattr(value,'numpy') else value).copy()

def _rows(value,width=None):
    if value is None:return None
    value=_array(value)
    if value.ndim==0:value=value.reshape(1,1)
    elif value.ndim==1:value=value.reshape(1,-1)
    if width is not None and value.shape[-1]!=width:raise ValueError('CPU prims data must have '+str(width)+' columns')
    return value.astype(np.float32)

class XformPrim:
    _type=_XFormPrim
    def __init__(self,paths):
        self._core=self._type(paths,reset_xform_properties=False)
    @property
    def paths(self):return list(self._core.prim_paths)
    def get_world_poses(self):
        position,quaternion=self._core.get_world_poses(usd=True)
        return _array(position),_array(quaternion)
    def set_world_poses(self,positions=None,orientations=None):
        self._core.set_world_poses(positions=_rows(positions,3),orientations=_rows(orientations,4),usd=True)

class _DynamicPrim(XformPrim):
    def _tensor(self):
        if not self._core.is_physics_handle_valid():
            if SimulationManager.get_physics_sim_view() is None:
                raise CpuPrimError('PHYSICS_NOT_READY','Native CPU PhysX simulation view is not initialized')
            self._core.initialize()
        if not self._core.is_physics_handle_valid():
            raise CpuPrimError('PHYSICS_NOT_READY','Native CPU PhysX tensor is not initialized: '+','.join(self.paths))
        return self._core
    def get_world_poses(self):
        if _backend.get()=='tensor':position,quaternion=self._tensor().get_world_poses(usd=False)
        else:position,quaternion=_XFormPrim.get_world_poses(self._core,usd=True)
        return _array(position),_array(quaternion)
    def set_world_poses(self,positions=None,orientations=None):
        kwargs={'positions':_rows(positions,3),'orientations':_rows(orientations,4)}
        if _backend.get()=='tensor':self._tensor().set_world_poses(**kwargs,usd=False)
        else:_XFormPrim.set_world_poses(self._core,**kwargs,usd=True)
    def get_velocities(self):
        value=_array(self._tensor().get_velocities())
        return value[:,:3],value[:,3:]
    def set_velocities(self,linear_velocities=None,angular_velocities=None):
        core=self._tensor()
        if linear_velocities is None or angular_velocities is None:
            value=_array(core.get_velocities())
        else:value=np.concatenate((_rows(linear_velocities,3),_rows(angular_velocities,3)),axis=-1)
        if linear_velocities is not None:value[:,:3]=_rows(linear_velocities,3)
        if angular_velocities is not None:value[:,3:]=_rows(angular_velocities,3)
        core.set_velocities(value)

class RigidPrim(_DynamicPrim):
    _type=_RigidPrim
    def get_masses(self):return _array(self._tensor().get_masses())
    def get_enabled_rigid_bodies(self):
        from pxr import UsdPhysics
        self._tensor()
        return np.array([bool(UsdPhysics.RigidBodyAPI(prim).GetRigidBodyEnabledAttr().Get()) for prim in self._core.prims])
    def get_enabled_gravities(self):
        from pxr import PhysxSchema
        self._tensor()
        return np.array([not bool(PhysxSchema.PhysxRigidBodyAPI(prim).GetDisableGravityAttr().Get()) for prim in self._core.prims])
    def apply_forces_and_torques_at_pos(self,forces=None,torques=None,positions=None,is_global=True):
        self._tensor().apply_forces_and_torques_at_pos(forces=_rows(forces,3),torques=_rows(torques,3),positions=_rows(positions,3),is_global=is_global)

class Articulation(_DynamicPrim):
    _type=_Articulation
    def is_physics_tensor_entity_valid(self):
        try:self._tensor();return True
        except CpuPrimError:return False
    @property
    def dof_names(self):return list(self._tensor().dof_names)
    @property
    def dof_types(self):return self._tensor().get_dof_types()
    @property
    def link_paths(self):
        # 官方 PhysX 有序 link 元数据；初始化前不可用时明确拒绝，不自行遍历猜根。
        return [list(row) for row in self._tensor()._physics_view.link_paths]
    def get_dof_positions(self):return _array(self._tensor().get_joint_positions())
    def get_dof_velocities(self):return _array(self._tensor().get_joint_velocities())
    def get_dof_limits(self):
        value=_array(self._tensor().get_dof_limits())
        return value[...,0],value[...,1]
    def get_dof_gains(self):
        stiffness,damping=self._tensor().get_gains()
        return _array(stiffness),_array(damping)
    def get_dof_max_efforts(self):return _array(self._tensor().get_max_efforts())
    def get_dof_drive_types(self):
        value=_array(self._tensor().get_drive_types()).reshape(-1)
        return ['force' if entry==1 else 'acceleration' if entry==2 else 'none' for entry in value]
    def _set_dofs(self,method,value,dof_indices=None):
        kwargs={'joint_indices':np.asarray(dof_indices,dtype=np.int32)} if dof_indices is not None else {}
        getattr(self._tensor(),method)(_rows(value),**kwargs)
    def set_dof_positions(self,value,dof_indices=None):self._set_dofs('set_joint_positions',value,dof_indices)
    def set_dof_velocities(self,value,dof_indices=None):self._set_dofs('set_joint_velocities',value,dof_indices)
    def set_dof_position_targets(self,value,dof_indices=None):self._set_dofs('set_joint_position_targets',value,dof_indices)
    def set_dof_velocity_targets(self,value,dof_indices=None):self._set_dofs('set_joint_velocity_targets',value,dof_indices)
    def set_dof_max_efforts(self,value,dof_indices=None):self._set_dofs('set_max_efforts',value,dof_indices)
    def set_dof_gains(self,stiffness,damping):self._tensor().set_gains(kps=_rows(stiffness),kds=_rows(damping))
    def set_solver_iteration_counts(self,position_counts=None,velocity_counts=None):
        core=self._tensor()
        if position_counts is not None:core.set_solver_position_iteration_counts(np.full(core.count,position_counts,dtype=np.int32))
        if velocity_counts is not None:core.set_solver_velocity_iteration_counts(np.full(core.count,velocity_counts,dtype=np.int32))
    def get_dof_friction_properties(self):
        value=_array(self._tensor()._physics_view.get_dof_friction_properties())
        return value[...,0],value[...,1],value[...,2]
    def set_dof_friction_properties(self,static_frictions=None,dynamic_frictions=None,viscous_frictions=None,dof_indices=None):
        core=self._tensor();view=core._physics_view;value=_array(view.get_dof_friction_properties())
        indices=np.arange(value.shape[1]) if dof_indices is None else np.asarray(dof_indices,dtype=np.int32)
        for axis,component in enumerate([static_frictions,dynamic_frictions,viscous_frictions]):
            if component is not None:value[:,indices,axis]=_rows(component)
        view.set_dof_friction_properties(value,np.arange(core.count,dtype=np.uint32))
