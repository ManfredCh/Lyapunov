"""S7 笛卡尔夹具任务。只在固定 Isaac Lab 工作区注册。"""

import os
from pathlib import Path

import gymnasium as gym
import torch

import isaaclab.sim as sim
from isaaclab.actuators import ImplicitActuatorCfg
from isaaclab.assets import ArticulationCfg, AssetBaseCfg, RigidObjectCfg
from isaaclab.envs import ManagerBasedRLEnvCfg, ManagerBasedRLMimicEnv, mdp
from isaaclab.envs.mimic_env_cfg import MimicEnvCfg, SubTaskConfig
from isaaclab.managers import EventTermCfg, ObservationGroupCfg, ObservationTermCfg, SceneEntityCfg, TerminationTermCfg
from isaaclab.scene import InteractiveSceneCfg
from isaaclab.sim.spawners.materials.physics_materials_cfg import RigidBodyMaterialBaseCfg
from isaaclab.utils import configclass
from isaaclab.utils.math import make_pose, matrix_from_quat
from isaaclab_newton.physics import MJWarpSolverCfg, NewtonCfg


TASK_ID = "Lyapunov-Cart-GraspPlace-Mimic-v0"
JOINTS = ["x", "y", "z", "left", "right"]
TCP_OFFSET = (0.0, 0.0, 0.03)
MATERIAL = RigidBodyMaterialBaseCfg(static_friction=2.0, dynamic_friction=2.0)


@configclass
class CartSceneCfg(InteractiveSceneCfg):
    ground = AssetBaseCfg(
        prim_path="/World/Ground",
        init_state=AssetBaseCfg.InitialStateCfg(pos=(0.0, 0.0, -0.025)),
        spawn=sim.CuboidCfg(size=(3.0, 3.0, 0.05), collision_props=sim.CollisionPropertiesCfg(),
                            physics_material=MATERIAL),
    )
    cart = ArticulationCfg(
        prim_path="{ENV_REGEX_NS}/Cart",
        spawn=sim.UsdFileCfg(usd_path=""),
        actuators={"position": ImplicitActuatorCfg(
            joint_names_expr=JOINTS,
            stiffness={"x": 1200.0, "y": 1200.0, "z": 1600.0, "left": 300.0, "right": 300.0},
            damping={"x": 26.0, "y": 26.0, "z": 28.0, "left": 5.0, "right": 5.0},
        )},
    )
    box = RigidObjectCfg(
        prim_path="{ENV_REGEX_NS}/Box",
        init_state=RigidObjectCfg.InitialStateCfg(pos=(0.0, 0.0, 0.017)),
        spawn=sim.CuboidCfg(
            size=(0.032, 0.032, 0.032), rigid_props=sim.RigidBodyPropertiesCfg(),
            mass_props=sim.MassPropertiesCfg(mass=0.035), collision_props=sim.CollisionPropertiesCfg(),
            physics_material=MATERIAL,
        ),
    )


@configclass
class ActionsCfg:
    position = mdp.JointPositionActionCfg(asset_name="cart", joint_names=JOINTS,
                                         use_default_offset=False, preserve_order=True)


@configclass
class ObservationsCfg:
    @configclass
    class PolicyCfg(ObservationGroupCfg):
        cart_joints = ObservationTermCfg(func=mdp.joint_pos, params={"asset_cfg": SceneEntityCfg("cart")})
        box_position = ObservationTermCfg(func=mdp.root_pos_w, params={"asset_cfg": SceneEntityCfg("box")})

    policy: PolicyCfg = PolicyCfg()


@configclass
class ResetCfg:
    box = EventTermCfg(
        func=mdp.reset_root_state_uniform, mode="reset",
        params={"asset_cfg": SceneEntityCfg("box"), "pose_range": {"x": (-0.006, 0.006)}, "velocity_range": {}},
    )


def placed(env):
    box = env.scene["box"].data
    box_pose = box.root_pose_w.torch
    position = box_pose[:, :3] - env.scene.env_origins
    speed = box.root_lin_vel_w.torch.norm(dim=-1)
    pad_y = env.scene["cart"].data.body_link_pose_w.torch[:, env.pad_ids, 1]
    # S4 两片夹爪的半厚为 5 mm。用箱体实际朝向计算沿夹持轴的投影宽度。
    box_half_y = 0.016 * matrix_from_quat(box_pose[:, 3:])[:, 1, :].abs().sum(dim=-1)
    clearance = box_half_y + 0.005 + 0.001
    released = (pad_y[:, 0] - box_pose[:, 1] > clearance) & (box_pose[:, 1] - pad_y[:, 1] > clearance)
    env.lifted |= position[:, 2] > 0.04
    return (env.lifted & (position[:, 0] > 0.02) & (position[:, 2] < 0.025)
            & (position[:, 2] > 0.01) & (speed < 0.06) & released)


@configclass
class TerminationsCfg:
    success = TerminationTermCfg(func=placed)


@configclass
class CartMimicCfg(ManagerBasedRLEnvCfg, MimicEnvCfg):
    scene: CartSceneCfg = CartSceneCfg(num_envs=1, env_spacing=3.0)
    actions: ActionsCfg = ActionsCfg()
    observations: ObservationsCfg = ObservationsCfg()
    events: ResetCfg = ResetCfg()
    terminations: TerminationsCfg = TerminationsCfg()
    rewards: dict = {}

    def __post_init__(self):
        self.scene.cart.spawn.usd_path = str(Path(os.environ["LYAPUNOV_LAB_CART_ASSET"]).resolve(strict=True))
        self.seed = 7
        self.decimation = 150
        self.episode_length_s = 15.0
        self.sim.dt = 0.002
        self.sim.render_interval = self.decimation
        self.sim.physics = NewtonCfg(solver_cfg=MJWarpSolverCfg(njmax=128, nconmax=64, integrator="implicitfast"),
                                     use_cuda_graph=False)
        self.datagen_config.name = TASK_ID
        self.datagen_config.seed = 7
        self.datagen_config.generation_num_trials = 10
        self.datagen_config.generation_guarantee = False
        self.datagen_config.generation_keep_failed = True
        self.datagen_config.generation_relative = True
        self.subtask_configs["cart"] = [
            SubTaskConfig(object_ref="box", subtask_term_signal="grasp_1",
                          selection_strategy="nearest_neighbor_object", selection_strategy_kwargs={"nn_k": 1},
                          action_noise=0.0, num_interpolation_steps=0),
            SubTaskConfig(object_ref="box", subtask_term_signal=None,
                          selection_strategy="nearest_neighbor_object", selection_strategy_kwargs={"nn_k": 1},
                          action_noise=0.0, num_interpolation_steps=0),
        ]


class CartMimicEnv(ManagerBasedRLMimicEnv):
    def __init__(self, cfg, **kwargs):
        super().__init__(cfg, **kwargs)
        self._joint_ids = self.scene["cart"].find_joints(JOINTS, preserve_order=True)[0]
        self.pad_ids = self.scene["cart"].find_bodies(["left", "right"], preserve_order=True)[0]
        self.lifted = torch.zeros(self.num_envs, dtype=torch.bool, device=self.device)

    def _reset_idx(self, env_ids):
        super()._reset_idx(env_ids)
        if hasattr(self, "lifted"):
            self.lifted[env_ids] = False

    def joint_positions(self):
        return self.scene["cart"].data.joint_pos.torch[:, self._joint_ids]

    def get_robot_eef_pose(self, eef_name, env_ids=None):
        cart = self.scene["cart"]
        carriage, = cart.find_bodies("carriage")[0]
        pose = cart.data.body_link_pose_w.torch[:, carriage]
        transform = make_pose(pose[:, :3] - self.scene.env_origins, matrix_from_quat(pose[:, 3:]))
        return transform[slice(None) if env_ids is None else env_ids]

    def action_to_target_eef_pose(self, action):
        position = action[..., :3] + action.new_tensor(TCP_OFFSET)
        rotation = torch.eye(3, device=action.device, dtype=action.dtype).expand(*position.shape[:-1], 3, 3)
        return {"cart": make_pose(position, rotation)}

    def target_eef_pose_to_action(self, target_eef_pose_dict, gripper_action_dict, action_noise_dict=None, env_id=0):
        position = target_eef_pose_dict["cart"][..., :3, 3]
        return torch.cat((position - position.new_tensor(TCP_OFFSET), gripper_action_dict["cart"]), dim=-1)

    def actions_to_gripper_actions(self, actions):
        return {"cart": actions[..., 3:]}

    def get_subtask_term_signals(self, env_ids=None):
        position = self.scene["box"].data.root_pos_w.torch - self.scene.env_origins
        grasped = (position[:, 2] > 0.022) & (self.joint_positions()[:, 3:] < -0.01).all(dim=-1)
        return {"grasp_1": grasped[slice(None) if env_ids is None else env_ids]}


def register():
    gym.register(TASK_ID, entry_point=f"{__name__}:CartMimicEnv",
                 kwargs={"env_cfg_entry_point": f"{__name__}:CartMimicCfg"}, disable_env_checker=True)
