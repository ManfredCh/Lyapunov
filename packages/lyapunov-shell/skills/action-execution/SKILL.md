---
name: action-execution
description: Control an existing robot to lower, grasp, drive, walk, fly, or stop. Reuse its body, world, policy, and Jobs; execute through real control interfaces and read back the result. Do not download another robot for a simple action.
---

# Execute an action with an existing robot

Reuse the current scene and robot when the user requests an action. Stop directly with `robot_stop`/`sim_stop`; use `policy_stop` for policy Jobs and `job_kill` for long Jobs, then read their real terminal states. Do not wait for skill loading or planning before stopping.

1. Identify the instance from the current selection and `scene_inspect`. Use `sim_world_list` to find a real world in the same session and Scene. Call `sim_open` only if none exists, and `sim_sync` only if its version is behind. Retain the current worldId, generation, and appliedSceneRevision; do not guess between multiple candidates. A successful Scene edit does not establish that physics is synchronized.
2. Read real joints, actuators, units, TCP, base, and availability with `robot_describe`. Resolve only the current missing information. When a tool is unavailable or rejects the action, report the specific reason and next step.
3. Use the interface for this action, with the Scene revision/world generation and actionId required by its schema. Read the returned receipt, `sim_action_receipt`, or `robot_state` after execution. If the result is unknown, query the same action/Job before resubmitting motion that may already have executed.

| Current target | Real interface and required limits |
|---|---|
| Move an arm TCP up/down or by a small offset | `robot_move_tcp` uses meters for deltaM; a 5 cm descent is `[0,0,-0.05]`. A real IK joint trajectory may also be used. Moving the robot root is not TCP control. |
| Joints, gripper, forks, or tendons | Use `joint_move`, `robot_gripper`, or `robot_move`. Units and controlled channels come from describe. A closed gripper does not prove that the object is held. |
| Pick/place | Use `robot_pick` / `robot_place`; verify actual object displacement, contact, and support. An attach/teleport from `sim_assist` is not a real grasp. |
| Vehicle or fleet | Use `vehicle_drive` / `robot_fleet_run`. A route algorithm's output has not executed; separately read back actual displacement, stopping, and contact. |
| Legged or learned policy | Run `policy_match` for a prepared policy, then `policy_execute` only after MATCHED. Use `robot_walk` only for its actually supported gait. Read `robot-provisioning` only when policy preparation is missing. |
| Drone | Use `robot_flight`; aircraft type, control mapping, and operations follow current capabilities. Provide the real ground height explicitly for landing. Scene translation or constant values for four motors do not establish flight. |

Manual arm control does not require a trained policy. If TCP information is missing, choose a real end effector from `robot_describe.nativeBodies/nativeSites`, then save either a site or a body-local offset with `robot_set_tcp`. A standard Panda has no site; do not assume an official TCP. Use `robot_set_base` modes source/free/fixed and real world or entity-body anchors; parentId does not establish a weld. Small-step IK currently requires a fixed base. If free/entity-bound bases are unsupported, use the actually controlled joints for manual adjustment. The human entry is the robot manual controls panel, using the same Scene CAS, synchronization, and Frame path. Read real presets and missing information with `robot_presets` when it is visible.

Use `motion_plan` / `motion_path` when obstacle avoidance or a full trajectory is needed. Joint, TCP, and grasp descriptions do not extend policy compatibility. Match G1 12DOF and 23DOF/75-dimensional contracts only against the real robot and observation mapping. `sim_reset` stops and rebuilds all instances in the current world without changing the Scene.

Perform bounded readback for the current goal. Judge visual changes through a real observation from the same window and Scene version. Judge distance, standing, collision, support, and drift through engine readbacks from the same generation. Submitted actions, prepared files, and historical test results do not prove that this goal was reached. Workspace scripts follow existing permissions; product state is modified through its corresponding interfaces.

Do not edit product source, state databases, or resource directories directly to bypass an interface.
