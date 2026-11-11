"""S5 官方 IRA 行为薄适配：同一 stage、同一物理 owner。

职责边界：
- 读取 Scene 快照里的 `components.human.ira`（seed/region/dwellS）与既有显式循环 walk route。
- 在**启动阶段**校验 motion library 的 USD 依赖闭包，避免已实测的缺件 SIGSEGV；不在实时循环下载/补件。
- 用官方 `CreatePayloadCommand`/`ApplyBehaviorAgentAPICommand`/`ApplyNavMeshAPICommand`/
  `USDSchemaUtil.create_ira_character` 装配角色；行为、导航和动画归 SDK。
- worker 的 tick 只提交 Timeline；本模块不调用 `SimulationManager.step`，不另建物理时钟或调度器。
- 区域进入由上一原生位置与本帧原生位置比较，按角色唯一事件触发官方 `CharacterEventTrigger`。
"""

from __future__ import annotations

import asyncio
import copy
import math
import os
import time
from pathlib import Path

IRA_ROOT = "/World/IRA"
IRA_GROUP_PREFIX = "IRA_"
IRA_EVENT_PREFIX = "lyapunov.ira.region."
_LOOP = None


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(name + " is empty")
    return value


def _error(error, code: str, message: str):
    return error(code, code + ": " + message)


def _finite(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _vec3(value, label: str, error):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(not _finite(v) for v in value):
        raise _error(error, "HUMAN_IRA_CONFIG_INVALID", label + " 必须是 3 个有限数值")
    return [float(v) for v in value]


def validate_config(cfg: dict, error):
    """只接受已真实实现的配置；不支持的可选能力具名拒绝，不静默忽略。"""
    ira = cfg.get("ira")
    if ira is None:
        return
    if not isinstance(ira, dict):
        raise _error(error, "HUMAN_IRA_CONFIG_INVALID", "ira 必须是对象")
    seed = ira.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise _error(error, "HUMAN_IRA_SEED_INVALID", "ira.seed 必须是 0–2147483647 的整数")
    region = ira.get("region")
    if not isinstance(region, dict):
        raise _error(error, "HUMAN_IRA_REGION_INVALID", "ira.region 必须是 min/max 对象")
    lo = _vec3(region.get("min"), "ira.region.min", error)
    hi = _vec3(region.get("max"), "ira.region.max", error)
    if any(a > b for a, b in zip(lo, hi)):
        raise _error(error, "HUMAN_IRA_REGION_INVALID", "ira.region.min 不得大于 max")
    if not (hi[0] > lo[0] and hi[1] > lo[1]):
        raise _error(error, "HUMAN_IRA_REGION_INVALID", "ira.region 的 X/Y 必须是正范围")
    dwell = ira.get("dwellS")
    if not _finite(dwell) or dwell <= 0 or dwell > 300:
        raise _error(error, "HUMAN_IRA_DWELL_INVALID", "ira.dwellS 必须 >0 且 ≤300 秒")
    route = cfg.get("route") or {}
    if route.get("behavior") != "walk":
        raise _error(error, "HUMAN_IRA_ROUTE_UNSUPPORTED", "IRA 只执行 walk 路线")
    if route.get("loop") is not True:
        raise _error(error, "HUMAN_IRA_ROUTE_UNSUPPORTED", "IRA 需要 loop:true 的循环路线")
    points = route.get("pointsM") or []
    if not isinstance(points, list) or not 2 <= len(points) <= 256:
        raise _error(error, "HUMAN_IRA_ROUTE_UNSUPPORTED", "IRA 需要 2–256 个米制 pointsM")
    for index, point in enumerate(points):
        _vec3(point, "route.pointsM[" + str(index) + "]", error)
    speed = route.get("speedMps")
    if not _finite(speed) or speed <= 0 or speed > 6:
        raise _error(error, "HUMAN_IRA_ROUTE_UNSUPPORTED", "IRA speedMps 必须 >0 且 ≤6")
    for key in ("navigation", "dwellS", "yieldToHumans", "avoidanceRadiusM", "avoidObstacles", "turnRateRadps", "clip"):
        if route.get(key) is not None:
            raise _error(error, "HUMAN_IRA_ROUTE_UNSUPPORTED", "IRA 不消费 route." + key + "；未接通前不静默忽略")


def _ira_entities(scene: dict) -> list[dict]:
    return [entity for entity in scene.get("entities", []) if (entity.get("components", {}).get("human") or {}).get("ira") is not None]


def preflight(scene: dict, error):
    """同步前校验；没有 ira 声明时不触碰任何 SDK/资产。"""
    entities = _ira_entities(scene)
    if not entities:
        return {"enabled": False, "entities": 0}
    if os.environ.get("LYAPUNOV_ISAAC_IRA") != "1":
        raise _error(error, "HUMAN_IRA_REOPEN_REQUIRED", "当前 Kit 不是 IRA 启动；带 ira 的 Scene 只能通过 sim_close 后按新快照重新 open 生效，已有普通 world 不热切换")
    for entity in entities:
        validate_config(entity.get("components", {}).get("human") or {}, error)
    return {"enabled": True, "entities": len(entities)}


def prepare_native_library_path() -> list[str]:
    """精简 CPU 经验在 dlopen 前需要 schema / usd 库搜索路径；只加已安装目录。"""
    isaac_root = Path(os.environ["ISAAC_PATH"])
    parts: list[str] = []
    for pattern in ("extscache/omni.usd.libs-*/bin", "extscache/*schema-*/lib", "extscache/*schema-*/plugins/*/lib"):
        for path in sorted(isaac_root.glob(pattern)):
            if path.is_dir() and str(path) not in parts:
                parts.append(str(path))
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    os.environ["LD_LIBRARY_PATH"] = ":".join(parts + ([existing] if existing else ""))
    return parts


def _pump(updates: int = 1, seconds: float = 0.0):
    """只用于 SDK bootstrap：App.update 让官方异步加载完成；Timeline auto-update 已关，不推进物理。"""
    global _LOOP
    import omni.kit.app

    app = omni.kit.app.get_app()
    if _LOOP is None:
        try:
            _LOOP = asyncio.get_event_loop()
            if _LOOP.is_closed():
                _LOOP = asyncio.new_event_loop()
        except RuntimeError:
            _LOOP = asyncio.new_event_loop()
        asyncio.set_event_loop(_LOOP)
    for _ in range(max(1, updates)):
        app.update()
        if not _LOOP.is_running():
            _LOOP.run_until_complete(asyncio.sleep(max(seconds, 0.001)))


def initialize_runtime() -> dict:
    """Kit 经验文件在 USD 首次打开前加载官方 IRA 扩展。"""
    import BehaviorSchema
    import NavSchema
    import isaacsim.replicator.agent.core
    from omni.metropolis.pipeline.agent import AgentsManager

    _pump(2)
    return {"enabled": True}


def _closure(path: str, label: str, error):
    from pxr import UsdUtils

    try:
        layers, assets, unresolved = UsdUtils.ComputeAllDependencies(path)
    except Exception as exc:  # noqa: BLE001
        raise _error(error, "HUMAN_IRA_ASSET_UNREADABLE", label + " USD 无法解析依赖: " + type(exc).__name__ + ": " + str(exc))
    unresolved = [str(item) for item in unresolved]
    if unresolved:
        raise _error(error, "HUMAN_IRA_DEPENDENCY_MISSING", label + " 有未解析依赖（" + str(len(unresolved)) + "），拒绝在缺件 stage 上启动行为: " + ", ".join(unresolved[:8]))
    return {"layers": len(layers), "assets": len(assets), "unresolved": 0}


def validate_assets(error):
    motion = _env("LYAPUNOV_ISAAC_IRA_MOTION_LIBRARY")
    character = _env("LYAPUNOV_ISAAC_IRA_CHARACTER")
    if not Path(motion).is_file():
        raise _error(error, "HUMAN_IRA_ASSET_UNAVAILABLE", "motion library 不存在: " + motion)
    if not Path(character).is_file():
        raise _error(error, "HUMAN_IRA_ASSET_UNAVAILABLE", "IRA 角色资产不存在: " + character)
    return {
        "motionLibrary": {"path": motion, "bytes": Path(motion).stat().st_size, **_closure(motion, "motion library", error)},
        "character": {"path": character, "bytes": Path(character).stat().st_size, **_closure(character, "IRA 角色", error)},
    }


def _create_navmesh_volume(world, entities, error):
    import omni.kit.commands
    import omni.usd
    import omni.anim.navigation.core as nav
    from pxr import Gf, Sdf

    stage = world.stage
    volume_path = Sdf.Path(omni.usd.get_stage_next_free_path(stage, "/World/NavMeshVolume", True))
    points = [point for entity in entities
              for point in [entity["transform"]["position"], *entity["components"]["human"]["route"]["pointsM"]]]
    center = Gf.Vec3d(*[(min(p[i] for p in points) + max(p[i] for p in points)) / 2 for i in range(3)])
    omni.kit.commands.execute(
        "CreateNavMeshVolumeCommand",
        parent_prim_path=Sdf.Path("/World"),
        volume_type=nav.NAVMESH_VOLUME_INCLUDE,
        position=center,
    )
    prim = stage.GetPrimAtPath(volume_path)
    if not prim or not prim.IsValid():
        raise _error(error, "HUMAN_IRA_NAVMESH_UNAVAILABLE", "官方 NavMeshVolume 未创建: " + str(volume_path))
    _pump(2)
    interface = nav.acquire_interface()
    interface.start_navmesh_baking_and_wait()
    navmesh = interface.get_navmesh()
    if navmesh is None:
        raise _error(error, "HUMAN_IRA_NAVMESH_UNAVAILABLE", "官方 NavMesh 同步烘焙没有返回 navmesh")
    return {"volumePath": str(volume_path)}


def _patrol_group(index: int, entity: dict, error):
    from isaacsim.replicator.agent.core.configuration.models.character import IRACharacterGroup
    from isaacsim.replicator.agent.core.configuration.models.defs.behaviors import AnyCharacterBehavior
    from isaacsim.replicator.agent.core.configuration.models.defs.triggers import AnyCharacterTrigger

    human = entity["components"]["human"]
    ira = human["ira"]
    route = human["route"]
    group_name = IRA_GROUP_PREFIX + str(index)
    event_name = IRA_EVENT_PREFIX + str(index)
    patrol = AnyCharacterBehavior.model_validate({
        "patrol": {
            "repeat": 1000000,
            "speed_range": [float(route["speedMps"]), float(route["speedMps"])],
            "path_points": [[float(p[0]), float(p[1]), float(p[2])] for p in route["pointsM"]],
        }
    })
    trigger = AnyCharacterTrigger.model_validate({
        "event_trigger": {
            "event": event_name,
            "behavior": [{"stop": {"time_range": [float(ira["dwellS"]), float(ira["dwellS"])]}}],
        }
    })
    group = IRACharacterGroup.model_validate({
        "name": group_name,
        "num": 1,
        "asset_path": str(Path(os.environ["LYAPUNOV_ISAAC_IRA_CHARACTER"]).parent),
        "routines": [patrol],
        "triggers": [trigger],
    })
    return group, group_name, event_name


def _find_skelroot(prim):
    from pxr import Usd, UsdSkel

    for candidate in Usd.PrimRange(prim):
        if candidate.IsA(UsdSkel.Root):
            return candidate
    return None


def prepare_scene(world, scene: dict, error):
    """在 stage populate 之后、物理初始化之前装配官方角色与 NavMesh。"""
    entities = _ira_entities(scene)
    if not entities:
        world.ira = None
        return {"enabled": False, "entities": 0}
    if os.environ.get("LYAPUNOV_ISAAC_IRA") != "1":
        raise _error(error, "HUMAN_IRA_REOPEN_REQUIRED", "当前 Kit 未加载 IRA；带 ira 的 Scene 需要重新 open")
    assets = validate_assets(error)
    import omni.kit.commands
    import omni.usd
    from pxr import Gf, Sdf, UsdGeom, UsdSkel
    from isaacsim.replicator.agent.core.scene_assembly.character_loader import USDSchemaUtil

    stage = world.stage
    if stage.GetPrimAtPath(IRA_ROOT).IsValid():
        stage.RemovePrim(IRA_ROOT)
    UsdGeom.Xform.Define(stage, IRA_ROOT)
    motion_path = IRA_ROOT + "/HumanMotionLibrary"
    omni.kit.commands.execute(
        "CreatePayloadCommand",
        usd_context=omni.usd.get_context(),
        path_to=motion_path,
        asset_path=assets["motionLibrary"]["path"],
        prim_path=None,
        instanceable=False,
        select_prim=False,
    )
    _pump(2)
    navmesh = _create_navmesh_volume(world, entities, error)
    mapping: dict[str, dict] = {}
    for index, entity in enumerate(entities):
        human = entity["components"]["human"]
        group, group_name, event_name = _patrol_group(index, entity, error)
        group_root = IRA_ROOT + "/" + group_name
        UsdGeom.Xform.Define(stage, group_root)
        char_path = group_root + "/human"
        omni.kit.commands.execute(
            "CreatePayloadCommand",
            usd_context=omni.usd.get_context(),
            path_to=char_path,
            asset_path=assets["character"]["path"],
            prim_path=None,
            instanceable=False,
            select_prim=False,
        )
        _pump(2)
        char_prim = stage.GetPrimAtPath(char_path)
        if not char_prim or not char_prim.IsValid():
            raise _error(error, "HUMAN_IRA_CHARACTER_LOAD_FAILED", "官方角色 payload 未创建: " + char_path)
        skelroot = _find_skelroot(char_prim)
        if skelroot is None:
            raise _error(error, "HUMAN_IRA_CHARACTER_UNSUPPORTED", "IRA 角色资产没有 SkelRoot: " + char_path)
        omni.kit.commands.execute(
            "ApplyBehaviorAgentAPICommand",
            skelroot_prim_paths=[skelroot.GetPath()],
            motion_library_prim_path=motion_path,
            motion_library_skeleton_rig="Human",
        )
        _pump(1)
        import NavSchema
        omni.kit.commands.execute("ApplyNavMeshAPICommand", prim_path=skelroot.GetPath(), api=NavSchema.NavMeshExcludeAPI)
        if not USDSchemaUtil.create_ira_character(stage, skelroot, int(human["ira"]["seed"]), entity["entityId"], group):
            raise _error(error, "HUMAN_IRA_CHARACTER_SCHEMA_FAILED", "官方 create_ira_character 失败: " + entity["entityId"])
        from omni.metropolis.pipeline.usd_util import set_prim_pos
        p = entity["transform"]["position"]
        set_prim_pos(char_prim, Gf.Vec3f(float(p[0]), float(p[1]), float(p[2])))
        _pump(1)
        mapping[entity["entityId"]] = {
            "entityId": entity["entityId"],
            "characterPath": str(skelroot.GetPath()),
            "event": event_name,
            "region": copy.deepcopy(human["ira"]["region"]),
            "dwellS": float(human["ira"]["dwellS"]),
            "enabled": False,
            "lastPosition": None,
            "lastInside": None,
            "regionEntered": False,
            "eventCount": 0,
            "lastTask": None,
            "lastSpeed": None,
            "distanceM": 0.0,
        }
    world.ira = {
        "enabled": True,
        "assets": assets,
        "navmesh": navmesh,
        "entities": mapping,
        "agents": {},
        "ready": False,
        "physicsSteps": 0,
        "timelineTicks": 0,
    }
    return {"enabled": True, "entities": len(mapping), "assets": assets, "navmesh": navmesh}


def wait_ready(world, error, timeout_s: float = 120.0):
    if not getattr(world, "ira", None):
        return {"enabled": False}
    from omni.metropolis.pipeline.agent import AgentsManager

    manager = AgentsManager.get_instance()
    expected = {row["characterPath"] for row in world.ira["entities"].values()}
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        _pump(1, 0.002)
        agents = manager.get_runtime_agent_instances()
        if manager.is_runtime_agents_collect_done():
            by_path = {str(agent.prim.GetPath()): agent for agent in agents}
            if expected.issubset(by_path) and all(by_path[path].get_bh_agent() is not None for path in expected):
                world.ira["agents"] = {path: by_path[path] for path in expected}
                for agent in world.ira["agents"].values():
                    agent.get_bh_agent().set_enabled(False)
                world.ira["ready"] = True
                return {"enabled": True, "agents": sorted(expected), "collected": True}
        if world.timeline is not None and world.timeline.is_auto_updating():
            raise _error(error, "CLOCK_CONFLICT", "IRA 初始化后 Timeline auto-update 未关闭")
    raise _error(error, "HUMAN_IRA_AGENT_MISSING", "官方 AgentsManager 在 " + str(timeout_s) + " 秒内未收集到全部 IRA 角色: " + ", ".join(sorted(expected)))


def _agent(world, entity_id: str, error):
    state = getattr(world, "ira", None)
    if not state or not state.get("ready"):
        raise _error(error, "HUMAN_IRA_NOT_READY", "IRA world 尚未就绪")
    mapping = state["entities"].get(entity_id)
    if mapping is None:
        raise _error(error, "HUMAN_IRA_ENTITY_MISSING", "实体没有 IRA 映射: " + entity_id)
    agent = state["agents"].get(mapping["characterPath"])
    if agent is None:
        raise _error(error, "HUMAN_IRA_AGENT_MISSING", "SDK agent 不存在: " + mapping["characterPath"])
    return mapping, agent


def prepare(world, entry, motion: dict, error):
    """把现有 human action 绑定到官方 agent；不写代理路线，不预推进物理。"""
    entity_id = motion["entityId"]
    _, agent = _agent(world, entity_id, error)
    duration = motion.get("durationS")
    if not _finite(duration) or duration <= 0 or duration > 300:
        raise _error(error, "HUMAN_DURATION_INVALID", "动作时长须为 0–300 秒")
    if motion.get("forceN") is not None:
        raise _error(error, "HUMAN_IRA_FORCE_UNSUPPORTED", "IRA 巡逻不接受外力动作")
    if motion.get("route") is not None and motion["route"] != entry["human"]["route"]:
        raise _error(error, "HUMAN_IRA_ROUTE_UNSYNCED", "IRA 路线变更须先保存到 Scene，再同步世界")
    motion["_duration"] = float(duration)
    motion["_end"] = float(duration)
    position = agent.get_world_position()
    if position is None:
        raise _error(error, "HUMAN_IRA_AGENT_NOT_READY", "SDK 角色尚无位置读数")
    motion["_initialPosition"] = [float(position[i]) for i in range(3)]
    motion["_ira"] = True
    return motion


def set_enabled(world, entity_id: str, enabled: bool, error):
    mapping, agent = _agent(world, entity_id, error)
    bh = agent.get_bh_agent()
    if bh is None:
        raise _error(error, "HUMAN_IRA_AGENT_NOT_READY", "SDK behavior agent 尚未就绪: " + mapping["characterPath"])
    bh.set_enabled(bool(enabled))
    mapping["enabled"] = bool(enabled)
    return {"entityId": entity_id, "characterPath": mapping["characterPath"], "enabled": mapping["enabled"]}


def stop_entity(world, entity_id: str, error):
    mapping, _ = _agent(world, entity_id, error)
    was_enabled = mapping["enabled"]
    set_enabled(world, entity_id, False, error)
    if was_enabled:
        # 覆盖上一帧尚未被 PhysX 消费的目标，保留停止瞬间的真实碰撞位置。
        _write_proxy_target(world, mapping, None)


def _write_proxy_target(world, mapping, position):
    import numpy as np
    from human_adapter import set_kinematic_targets
    from scene_adapter import use_backend

    entry = world.entities[mapping["entityId"]]
    with use_backend("tensor", raise_on_fallback=True):
        positions, quaternions = entry["humanView"].get_world_poses()
    positions = np.asarray(positions).reshape(-1, 3)
    quaternions = np.asarray(quaternions).reshape(-1, 4)
    if position is not None:
        if "proxyOffsets" not in mapping:
            root_index = entry["humanIndices"][entry["humanRootPath"]]
            mapping["proxyOffsets"] = positions - positions[root_index]
        positions = mapping["proxyOffsets"] + np.asarray(position)
    values = np.concatenate((positions, quaternions[:, [1, 2, 3, 0]]), axis=1)
    set_kinematic_targets(world, entry, values)


def _inside(position, region) -> bool:
    lo = region["min"]
    hi = region["max"]
    return all(float(lo[i]) - 1e-6 <= float(position[i]) <= float(hi[i]) + 1e-6 for i in range(3))


def after_step(world, error):
    """Timeline commit 之后：读原生状态、检查区域进入、按唯一事件触发官方 StopBehavior。"""
    state = getattr(world, "ira", None)
    if not state or not state.get("ready"):
        return
    from omni.metropolis.utils import carb_util

    for mapping in state["entities"].values():
        agent = state["agents"][mapping["characterPath"]]
        data = agent.get_agent_data()
        position = data.get("world_position")
        mapping["lastTask"] = data.get("current_task_name")
        mapping["lastSpeed"] = data.get("speed")
        if position is None:
            continue
        inside = _inside(position, mapping["region"])
        previous_inside = mapping.get("lastInside")
        previous_position = mapping.get("lastPosition")
        if previous_position is not None and mapping["enabled"]:
            mapping["distanceM"] += math.dist(previous_position, (float(position[i]) for i in range(3)))
        if mapping["enabled"] and previous_position is not None and previous_inside is False and inside:
            try:
                carb_util.dispatch_event(mapping["event"])
            except Exception as exc:  # noqa: BLE001
                raise _error(error, "HUMAN_IRA_EVENT_FAILED", "官方事件派发失败 " + mapping["event"] + ": " + type(exc).__name__ + ": " + str(exc))
            mapping["regionEntered"] = True
            mapping["eventCount"] = int(mapping.get("eventCount", 0)) + 1
        mapping["lastInside"] = bool(inside)
        mapping["lastPosition"] = [float(position[0]), float(position[1]), float(position[2])]
        if mapping["enabled"]:
            _write_proxy_target(world, mapping, position)
    state["timelineTicks"] = int(state.get("timelineTicks", 0)) + 1


def observe(world, entry):
    import human_adapter

    pose = human_adapter.observe(world, entry)
    mapping = (getattr(world, "ira", None) or {}).get("entities", {}).get(entry["entity"]["entityId"])
    if mapping is None:
        return pose
    agent = (getattr(world, "ira", None) or {}).get("agents", {}).get(mapping["characterPath"])
    data = agent.get_agent_data() if agent is not None else {}
    position = data.get("world_position")
    rotation = data.get("world_rotation")
    if position is not None:
        pose["target"] = {"rootPositionM": position, "rootYawRad": math.atan2(2 * (rotation[3] * rotation[2] + rotation[0] * rotation[1]), 1 - 2 * (rotation[1] ** 2 + rotation[2] ** 2)) if rotation else 0.0}
    pose["motion"] = {
        "behavior": "ira-patrol",
        "distanceM": mapping["distanceM"],
        "yielded": False,
        "ira": {
            "enabled": bool(mapping.get("enabled")),
            "task": mapping.get("lastTask"),
            "speedMps": mapping.get("lastSpeed"),
            "regionEntered": bool(mapping.get("regionEntered")),
            "event": mapping["event"],
            "eventCount": int(mapping.get("eventCount", 0)),
        },
    }
    return pose


def state(world) -> dict:
    state = world.ira
    return {
        "ready": state["ready"],
        "timelineTicks": state["timelineTicks"],
        "physicsSteps": state["physicsSteps"],
        "actors": len(state["entities"]),
    }
