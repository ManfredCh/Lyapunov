---
name: crowd-control
description: Use for creating or controlling crowds of people (pedestrians) — spawn bundled characters, set per-person walk presets or explicit routes, start/stop their motion, and inspect their physical state. Manual panel buttons and these tool calls share the same crowd_* operations.
---

# Create and control a crowd of people

The flow is create → synchronize → configure behavior → start/stop. A saved crowd that is not synchronized will not move; do not claim it is walking until the world is synced and a frame shows motion.

1. List bundled characters with `human_catalog` (12 MIT Rocketbox adults, each with its own `walkClip`/`walkSpeedMps`). Spawn with `human_catalog_spawn`: `{sceneId, expectedRevision, count, seed, region}`; omit `avatarIds` for the default four-appearance mix, or pass explicit `avatarIds` and `count`. 20 people need a flat region of at least 20×8 m (`rocketboxLaneRegion` semantics); too small fails by name. Reuse the snapshot revision it returns.
2. Synchronize with `sim_sync` (`{sceneId, worldId}`) so the saved revision reaches the physics world. Without this step the people stay static. Do not set `timestepS` yourself on `sim_open`/`sim_sync` — keep the product default (0.002 s) unless the user explicitly asks; changing the step changes physics accuracy and any measured performance figures.
3. Set behavior with `crowd_configure` on `entityIds` or `groupId`. `preset` and an explicit `route` are mutually exclusive (`HUMAN_ROUTE_PRESET_CONFLICT`):
   - `preset:{kind:'back-and-forth', distanceM?, speedMps?}` — each person walks `distanceM` meters (default 2, range 0.5–20) along their own heading and returns to their own start, looping.
   - `preset:{kind:'square-loop', distanceM?, speedMps?}` — each person walks a `distanceM`-edge square starting at their own position, heading then left.
   - `preset:{kind:'idle', speedMps?}` — stand in place; uses the `Idle` clip when the definition has one.
   - `speedMps`/`clip` default to the person's existing route, else the bundled character's `walkSpeedMps`/`walkClip`; unresolvable defaults fail by name instead of guessing. There is **no run preset**: the Run clip is not ground/stride-calibrated and cannot be guaranteed slip-free. An explicit `route` object keeps full path semantics.
4. Start with `crowd_start`: `{sceneId, entityIds|groupId, worldId, expectedGeneration, durationS}` — read `worldId`/`expectedGeneration` from the current world (`/api/lyapunov/state` or the world listing); it throws `HUMAN_WORLD_UNSYNCED`/`STALE_GENERATION` on stale identity, so read fresh values after each sync. `durationS` is bounded (≤300 s); re-issue to extend. Stop with `crowd_stop` (same scope); it only revokes control of the selected people — the world, other people, and recordings keep running, and the last real pose is preserved. Inspect declarations, licenses, and native poses with `crowd_inspect`.

## Boundaries

- Grouped people act through `groupId`; ungrouped people act through explicit `entityIds`. Scope is required and named — do not guess targets.
- `sceneId` must come from `scene_list` or the currently open workbench scene — never write a placeholder value such as `CURRENT`. If no scene exists, ask the user before creating one.
- When the user says "one of the groups" / "其中一组", first `crowd_inspect` on the existing `groupId`s. If the scene has only one group, ask the user whether they mean the whole group or a split-off subset — do not pick a subset yourself.
- Kinematic people do not fall over on their own; `mode:'ragdoll'` has real free dynamics and force/fall but **no balance or recovery controller** — do not promise stable ragdoll walking.
- Isaac supports basic kinematic paths and native obstacle stopping only; planar A* navigation and ragdoll fail by name there.
- Verify motion from real frames (`crowd_inspect` world frame or viewer readback): motion started ≠ motion observed.
