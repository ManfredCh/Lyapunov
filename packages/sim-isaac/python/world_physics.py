"""独立worker/纯AST测试的共享Scene物理合同入口。"""
import importlib.util
from pathlib import Path
_spec=importlib.util.spec_from_file_location('lyapunov_scene_physics',Path(__file__).resolve().parents[2]/'sim-contract/python/world_physics.py')
_module=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_module)
scene_gravity=_module.scene_gravity
declared_ground_ids=_module.declared_ground_ids
explicit_ground_requested=_module.explicit_ground_requested
coverage=_module.coverage
replaceable_standard_ground=_module.replaceable_standard_ground
standard_support_plane=_module.standard_support_plane
