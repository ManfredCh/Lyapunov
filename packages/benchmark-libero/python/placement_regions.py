"""从官方目标 site 提取可选区域元数据；不复制套件几何常数或成功判定。"""


def placement_regions(env, world_id, generation, step_index):
    import numpy as np
    from robosuite.utils.transform_utils import mat2quat

    result = []
    seen = set()
    # 官方 parser 将 And 目标展平为谓词列表。当前只暴露 In 的 box site。
    for goal in getattr(env, "parsed_problem", {}).get("goal_state", []):
        if len(goal) != 3 or str(goal[0]).lower() != "in":
            continue
        region_id = goal[2]
        site = getattr(env, "object_sites_dict", {}).get(region_id)
        parent = getattr(site, "parent_name", None)
        if region_id in seen or site is None or getattr(site, "site_type", None) != "box" or parent not in env.obj_body_id:
            continue
        half_extents = np.asarray(site.size, dtype=float).reshape(-1)
        if half_extents.size != 3 or not np.isfinite(half_extents).all() or not (half_extents > 0).all():
            continue
        body_id = env.obj_body_id[parent]
        parent_position = np.asarray(env.sim.data.body_xpos[body_id], dtype=float)
        parent_rotation = np.asarray(env.sim.data.body_xmat[body_id], dtype=float).reshape(3, 3)
        position = np.asarray(env.sim.data.get_site_xpos(region_id), dtype=float)
        rotation = np.asarray(env.sim.data.get_site_xmat(region_id), dtype=float).reshape(3, 3)
        local_center = parent_rotation.T @ (position - parent_position)
        local_rotation = parent_rotation.T @ rotation
        if not all(np.isfinite(value).all() for value in [local_center, local_rotation, position, rotation]):
            continue
        result.append({
            "regionId": region_id, "parentEntityId": parent, "kind": "containment",
            "source": {"provider": "official-env", "reference": "object_sites_dict." + region_id},
            "geometry": {
                "shape": "box", "coordinateFrame": "parent-local",
                "centerM": local_center.tolist(), "halfExtentsM": half_extents.tolist(),
                "quaternionXyzw": mat2quat(local_rotation).tolist(),
            },
            "worldPose": {
                "positionM": position.tolist(), "quaternionXyzw": mat2quat(rotation).tolist(),
                "worldId": world_id, "generation": generation, "stepIndex": step_index,
            },
        })
        seen.add(region_id)
    return result
