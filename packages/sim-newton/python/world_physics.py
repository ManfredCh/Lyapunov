"""复用共享Scene地面/重力合同，不复制独立状态或创建隐式地面。"""
from pathlib import Path
import importlib.util
_path=Path(__file__).resolve().parents[2]/'sim-contract/python/world_physics.py'
_spec=importlib.util.spec_from_file_location('lyapunov_shared_world_physics',_path)
_module=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
scene_gravity=_module.scene_gravity
declared_ground_ids=_module.declared_ground_ids
explicit_ground_requested=_module.explicit_ground_requested
coverage=_module.coverage
replaceable_standard_ground=_module.replaceable_standard_ground
standard_support_plane=_module.standard_support_plane
