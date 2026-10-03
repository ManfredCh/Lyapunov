# Lyapunov quickstart

[English](QUICKSTART.md) | [简体中文](QUICKSTART.zh-CN.md)

Produced by 杭州奇异宇宙人工智能有限公司. These Linux x64 Alpha exercises specify inputs, bounded operations and readback. They do not claim completed final-package demonstrations. Natural-language examples need sign-in or an explicitly configured Guest provider; use native tools and workbench controls.

## 1. Ground and box with controlled MuJoCo

**Input:** an empty Scene, static ground, a dynamic box and a ready managed MuJoCo runtime.

1. Create dimensioned ground/box geometry through the existing Scene or Blender tools.
2. Select MuJoCo; inspect gravity, usage and collision, and initialize a paused world.
3. Explicitly advance 20 steps or an agreed short action, read before/after state, then stop.
4. Save the Scene; check rendering separately if capturing images.

**Example request:**

```text
Create static ground and a dynamic box with 0.2 m sides. Initialize a paused MuJoCo world and report its identity and box state. Advance only 20 steps, report the actual pose, stepIndex and simTime, then stop.
```

**Check:** the real engine/world/Scene revision; actual step/time and position changes. For a landing test, agree on enough bounded steps and read contact. Viewer animation alone is not physics evidence. Missing SDK/rendering/physical components remain blocked.

## 2. Panda joints and TCP

**Input:** a native Panda model from an official root, complete includes/meshes/textures/actuators and supported engine controls.

1. Import the model and inspect base placement, dependency closure, joints and limits.
2. Initialize paused; choose a genuinely controllable joint and execute a small bounded action, then stop.
3. Read measured joint state and actual TCP pose/definition.
4. For an end-effector goal, check planning/IK support first. Setting TCP metadata is not executing a trajectory.

**Example request:**

```text
List this Panda's controllable joints and limits and show its TCP pose. Move only the first controllable arm joint by a small amount within its limit. Stop and report measured error. Do not automatically run a grasp or full policy.
```

**Check:** matching control/limits/state, stop confirmation and TCP information. A plan and its executed outcome are separate. Other robot files/engines are not covered automatically; policies need their own prepare/match.

## 3. Camera, RGB-D and editable annotations

**Input:** a Scene with visible objects, a camera-capable ready world and a working renderer.

1. Choose a real body/preset for parent mounting instead of guessing wrist offsets; or save a world-fixed/current-view installation.
2. Apply the Scene change, wait for synchronization and native readback, and select a listed camera.
3. Capture RGB-D and calibration; annotate a valid pixel using real depth and edit its note.
4. Save/reopen the annotation and export captures/annotations or a dataset to the actual reported path.

**Example request:**

```text
Save the current view as a scene-camera installation, sync it into the ready world and capture RGB-D with calibration. Use a valid box pixel and real depth for an annotation, edit and save its note, then export the capture and annotation.
```

**Check:** captureId, K/extrinsics, resolution, meter depth and consistent frame identity; reopened annotation content/anchor; export references. Viewer screenshots and native calibrated captures remain distinct. Invalid depth cannot be invented. An annotated observation can request a native Scene edit; verify entity/revision after that explicit change.

## 4. Indoor visual/physical alignment

**Input:** an indoor GLB/Gaussian asset you may use and aligned static collision geometry.

1. Check axes/scale/orientation; preserve separate visual and static/environment sources.
2. Wait for physical derivation status=ok; inspect fillInterior:false, actual voxel pitch and budget.
3. Sync a paused world and perform a bounded wall-contact/empty-space control with a small probe or supported robot, then stop.
4. Save the Scene and geometry parameters. Report budget limits and unresolved narrow openings.

**Example request:**

```text
Check this room's visual/collision alignment. Preserve its empty interior and door opening instead of baking a solid room box. Run only a bounded wall-contact and doorway-clearance check, report actual motion/contact and budget, then stop.
```

**Check:** the same transform/unit/revision, an actual empty-point negative control and wall-contact positive control, plus real scene clearance. An interiorPreserved label does not prove every passage, whole-room navigation or full B1 acceptance.

A separate native falling-body check can be run from the installed package root:

```sh
./lyapunov physics-check --managed-sdk
```

It checks MuJoCo alone. See the [installation guide](https://vorynel.com/lyapunov/guide.html) and [README](../README.md) for prerequisites and input routes.
