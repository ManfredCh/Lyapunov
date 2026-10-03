---
name: robot-provisioning
description: Use for an explicit request to acquire/import a robot body or prepare a policy bundle. Reuse the body, complete cache, and Jobs; check required files and instance compatibility. Use action-execution for actions with an existing robot.
---

# Acquire and prepare a robot

Use this flow only for acquisition, import, or policy preparation. Use `action-execution` to lower, grasp, or drive an existing robot. Verify visible geometry, complete bytes, preparation, compatibility, and achieved motion separately.

1. Check for the same body with `asset_list` / `scene_inspect`; a human may import it from the robot library. Register original URDF/MJCF files and their include/mesh dependency closure with `scene_import`, verify files with `asset_verify`, and reuse resourceId/version and articulation/controller through `scene_mount`; do not duplicate the body.
2. When a policy is needed, first read `policy_load_state`, `policy_files cache:true`, and related `job_list` / `job_output`. Reuse complete files. Read back an active download with the same identity, and acquire only missing files. Visible geometry does not prove that weights, adapters, or observation mappings are complete.
3. External directories provide source metadata. Start from the body's official website or official project repository below; public source research does not require a regional service, proxy endpoint, or an existing runtime adaptation. When source, interface, or error facts are uncertain, use Browser Use for keyword search and official pages, WebFetch for a known URL, and Bash for necessary acquisition. Resolve new evidence before retrying the same failure. `policy_download_sources` lists registered pins/adapters/files only. For explicit authorized acquisition, report the actual source URL, retrieved revision, and missing files or requirements; retain authenticated-source permissions and complete-file verification. Manual `policy_download_bundle`/`policy_download` remain available with exact paths or directory prefixes ending in `/`, never wildcards or a copied historical matrix. Match Go1/Go2/G1, G1 12DOF, and 23DOF/75-dimensional joint/control/observation contracts from actual facts. Use only `https://hf-mirror.com` for HF; missing objects remain blocked without official-endpoint fallback.
4. After complete acquisition, run `policy_verify` then `policy_prepare`; preparation returns derived artifacts and components/worldOptions. To apply them to the current instance, run `policy_activate` then `policy_match`, and enter action execution only after MATCHED. A download, PREPARED, or MATCHED does not prove standing or walking. Report exact missing runtime, original files, fixed source, or mapping and an executable way to resolve them.

## Official source metadata, read on demand

These addresses cover the 12 documented T0 bodies in `packs/t0-roster.json`. T0 is body priority only. Select the exact model/version from the official source when needed; these roots do not assert a downloadable file, policy adapter, or supported behavior.

| Body IDs | Official source |
| --- | --- |
| `allegro_hand` | [Wonik Allegro Hand](https://www.allegrohand.com/) |
| `crazyflie_2` | [Bitcraze Crazyflie firmware project](https://github.com/bitcraze/crazyflie-firmware) |
| `forklift_c` | [NVIDIA wheeled robot asset documentation](https://docs.isaacsim.omniverse.nvidia.com/latest/assets/usd_assets_robots_wheeled.html) |
| `franka_panda` | [Franka Robotics ROS descriptions](https://github.com/frankarobotics/franka_ros) |
| `generic_quadrotor` | [gym-pybullet-drones upstream project](https://github.com/learnsyslab/gym-pybullet-drones) |
| `leap_hand` | [LEAP Hand project](https://leaphand.com/) |
| `shadow_hand` | [Shadow Robot descriptions](https://github.com/shadow-robot/sr_common) |
| `unitree_a1`, `unitree_g1`, `unitree_go1`, `unitree_go2` | [Unitree Robotics descriptions](https://github.com/unitreerobotics/unitree_ros) |
| `ur10e` | [Universal Robots descriptions](https://github.com/UniversalRobots/Universal_Robots_ROS2_Description) |

`ur5e` uses the same official Universal Robots repository for source research; its T0/T1 documentation conflict remains unresolved. `generic_quadrotor` names a generic upstream model, and `forklift_c` names an NVIDIA asset family; inspect the actual selected body instead of inventing a manufacturer or matching variant.

Server directories supply official addresses and necessary context; they do not report actual robot behavior. Evaluate standing, gait, and getting up from the client's current simulation readback. A source match, download, PREPARED, MATCHED, or short inference does not verify these behaviors. Do not automatically inject remote capability/provisioning context for a target whose body/runtime/behavior adaptation has not been established. Peiri supplies the model; resolve public sources through the available Browser Use, WebFetch, and Bash tools.

Manual joint, gripper, and TCP control does not require a policy. Read real body/site/TCP/base data with `robot_describe`. Configure TCP with `robot_set_tcp`, and fixation/release/anchors with `robot_set_base`, including Scene revision/world generation. The human entry is the robot manual controls panel; read real presets with `robot_presets` when visible. A standard Panda has no site: explicitly choose a body origin/local offset rather than guessing a default TCP or using parentId as a weld.

Use `scene_physics_update` for properties and `scene_bind_physics` for derived bindings; use `scene_reconcile_physics` for pending or incorrect references. Handle robot bodies through their dedicated interfaces without overwriting internal joints. Read compiled physics after synchronization. Dependencies follow current tool configuration and isolated executor receipts; do not assume a system Python path, SDK version, or engine prerequisite.

Scene/Resource/Sim changes use domain interfaces, and workspace scripts follow existing permissions. Do not edit product source, state databases, or resource directories directly to bypass an interface. Save a portable project with `scene_save portable`. Deliver the acquired/missing/prepared/matched state for this task; verify motion separately.
