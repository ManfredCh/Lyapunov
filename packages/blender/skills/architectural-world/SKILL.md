---
name: architectural-world
description: Build or edit editable buildings/scenes with Blender, export a Scene and optionally import it into MuJoCo or Isaac for robot tasks inside the architecture. Use for natural-language modelling, architectural walkthroughs, scene physicalization and cross-engine robot workflows.
---

# Architecture-to-robot workflow

Prefer an applicable connected Blender MCP tool from the current native discovery and tool registry for modelling, scene inspection and screenshots. Inspect its actual schema and editor/project state; do not guess a tool name or namespace. If MCP is unavailable, report the concrete missing configuration, addon, handshake, discovery or scope, then use the authorized product `blender_run` batch fallback when applicable. Reuse native DSH files/Jobs/images/Scene/robot tools for everything else.

**Stages**: modelling/export and acquisition/viewing do not need physics. **Enter physics only when collision, dynamics or robot execution inside the building is required.** Do not make `sim_open`, robot loading or engine import prerequisites for architecture, or open worlds merely to prove modelling is complete. Inspect appearance first; physics follows task requirements.

## Stage 1: model and edit without physics

Write Blender Python (`bpy`) from the requested architecture and references. Establish layout, proportions, entrances and appearance. Retain public scale references where available; label other dimensions as modelling assumptions. Verify traversable ground and starting locations **only for robot placement/passage acceptance**, not visual-only delivery.

Iterate each version: execute modelling -> `get_viewport_screenshot`/render observation -> compare every requirement -> list specific differences -> edit again, until layout/proportions/entrances/appearance match. Check traversability when robots are needed. Differences identify the wall, opening or furniture item.

With MCP, use `get_scene_info` to identify the target Scene, then `execute_blender_code` for `bpy`. `get_viewport_screenshot` captures the current viewport; set render output in Blender when rendering. Reuse `packages/blender/src/world.py` and `export_world(<output-directory>)`, loading via `runpy.run_path` under a non-`__main__` name. Do not write another Scene/physics exporter.

Without MCP, use `blender_run.python_script` and `output_directory`; supply `source_blend` when editing an existing project. `render:true` returns a preview as an image attachment the model can inspect. `texture_query`/`material_textures` obtains CC0 PBR textures and connects actual material nodes. `background=true` uses native Jobs for receipts; observation timeout never justifies duplicate submission. `architecture=true` is a built-in courtyard test that rebuilds the scene and must not be mixed with user architecture.

Pause/resume long jobs with `blender_job_control{job_id, action:"pause"|"resume"|"status"}`. pause writes a pause marker and stops the current Blender process **without settling the job**, so **jobId is unchanged**. resume **reruns the same job with the same jobId** and recomputes completed stages; it is **not checkpoint continuation**, so do not describe it as continuing computation. Open this job's written `output/source.blend` first, preserving its resource namespace and resourceId instead of reopening an empty project. During pause, native `job_output`/`job_list` still reports `running` because upstream JobStatus has no paused value; actual state comes from `blender_job_control{action:"status"}.state`. Pauses **do not survive Host restart/session disposal**; released records report `BLENDER_JOB_RESUME_ALREADY_FINISHED` on resume. `job_kill` still terminates and settles a job, including a paused one.

Custom architecture scripts use metres, right-handed Z-up, and set:

```python
bpy.context.scene['lyapunov_world_kind'] = 'architecture'
bpy.context.scene['lyapunov_scene_id'] = 'stable-user-building-id'
bpy.context.scene['lyapunov_root_entity'] = 'actual-root-empty-object-name'
```

Retain separate objects, hierarchy and modelling details. `lyapunov_shape='box'` exports per-object box collision; decorations may use `lyapunov_collision=False`. Ground/walls/columns get individual colliders while building interiors remain empty. A whole-building bbox is not one collider. Separate curved visuals from simplified collision and disclose approximation.

Collision-box **centre and dimensions come from the object's evaluated local geometry**, stored in `components.collision.center`/`halfExtents`, so an offset origin does not move the collider off geometry; `boxSource` states the measurement source. Geometry baked into vertices commonly has an off-centre origin. `lyapunov_size` is only a fallback when geometry is unmeasurable; differing declarations appear in `declaredSizeM` without changing the user's project.

For **shape-key meshes**, export does not bake modifiers, which would destroy morph targets. Collision boxes and visual GLB therefore measure the **same unmodified geometry**. Unrepresented modifiers appear in `unbakedModifiers` and `components.collision.losses`, with `collisionUnbakedModifiers` in the result. These boxes lack modifier effects; to apply them to both visual and physics, first remove shape keys or make a non-shape-key replacement before applying modifiers.

**Nonuniform parent scale combined with child rotation** cannot be expressed exactly by the current box contract: physics/world.xml and scene.json use different frames. Structured `components.collision.losses` reports code, both outputs' measured corner deviations and next interfaces. physics/world.xml uses a tight body-frame envelope, exact for child axis swaps by multiples of 90 degrees; scene.json uses the best same-frame contract value. Results include `collisionApproximations`. **Loss-bearing boxes are not exact colliders.** Exactness in both outputs needs body-frame/oriented-quaternion box support or multiple part boxes. The current exporter emits one box per `lyapunov_shape='box'` object; change hierarchy to keep nonuniform scale on an unrotated layer or decide acceptability from losses. Lights/cameras export as first-class Scene entities, with Viewer consuming `components.light`. **Entity colour/material overrides have no consumer**; edit source materials and export appearance changes.

Outputs include `source.blend`, `scene.json`, `visuals/*.glb`, `physics/world.xml`, `isaac/architecture.usda` and `isaac/import.json`. Check actual `blender_run` USD status and preview; paths alone do not prove engine execution.

## Portable materials and artifact readback

Blender procedural shaders are editable source effects; GLB does not carry arbitrary Noise/Bump/node graphs. If the task requires portable textures, bake the needed channels to image textures or connect exportable PBR image nodes with usable UVs. Preserve the editable `.blend`. Read the actual export's material losses; a successful export does not establish that procedural appearance survived.

Use the helper at `../../python/artifact_inspect.py` relative to this skill directory, resolved against the skill's supplied base directory. It is packaged with this Blender package and uses Python's standard library for a read-only inspection:

```text
python <resolved-artifact_inspect.py> <actual-final.glb> --require-textures
```

Omit `--require-textures` when image textures are not required. The result reports the exact byte/hash, geometry/UV counts and embedded/external image references. It does not rate visual similarity or prove decoding/reloading. For actual reload, use an available Blender executable in a separate temporary factory-startup background process; do not clear the user's live editor or MCP project:

```text
<blender> --background --factory-startup --python-exit-code 1 --python <resolved-artifact_inspect.py> -- <actual-final.glb> --require-textures --roundtrip
```

Check the returned imported mesh/UV/loaded-image facts. Reopen the editable project only in its owned editor, and compare the delivered GLB in Viewer with the final preview. If textures, UVs or appearance are lost, correct the source/export and rerun only the affected check. These facts support artifact delivery; native Job/Graph success still describes execution, while the observed task requirements determine modelling completion.

## Stage 2: acquire and view without physics

1. Open generated `scene.json` with `scene_open`. Repeated same-scene identical content is idempotent; only resource-location changes may overwrite, while structural changes report `SCENE_ALREADY_EXISTS`. **Repeated exports update the same Scene.** Replace mounted resources through the actual visible `scene_replace_resource` schema/receipt. Identity/pose/parentage remain. Collision/rigidBody/controller handling compares both originals' **actual geometry**: local-metre vertex positions and triangle multisets including node/ancestor transforms and source-coordinate conversion, matching what is displayed. Identical geometry retains derivations; changes, including internal pose/scale, require the target's registered derived defaults or `REPLACE_RESOURCE_PHYSICS_NOT_DERIVED`. Compression/skinning/animation preventing static verification produces `REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE`. Derive or rebuild as directed. If replacement is unavailable, report that entry gap; never change refs while keeping unknown derivations. `scene_import {path, sceneId}` **registers and adds an entity**, not replaces. **Do not create another sceneId just to receive artifacts** (`scene-construction`).
2. Inspect hierarchy/originals/collision with `scene_inspect`; check geometry/materials in the 3D view/render before deciding delivery. Preserve `.blend` for further modelling.
3. For robots or static observation cameras, import an actual dynamics/controller-bearing resource into the same Scene, retaining its controller declaration. Start on supporting ground. Wheeled robots cannot teleport over steps; starting on the platform's level is valid when its verification scope is explicit.

## Stage 3, when needed: physics and robots

1. The current Host uses one sim Provider. Read actual world/generation/joints/control semantics through `sim_open`, `robot_load`, `robot_describe`; do not copy another engine's worldId. Scene edits require `sim_sync`. Mount static observation cameras through Scene edits and synchronization. `robot_load` also reads robot control descriptions and is not the import entry for every static entity.
2. Use observed control semantics with `vehicle_drive`, `joint_move` or the appropriate stable action tool; query `sim_action_receipt` / `robot_state`. Record real displacement, collision/support, post-stop velocity and drift. `sensor_capture` records actual engine images. If unavailable, retain the specific error; Blender rendering is not engine observation.
3. Use `sim_stop`, then `sim_close`. For another engine, use an independent Host or close the old world and rebuild through that Provider. Verify each engine separately on the same Scene.

## Resource identity and versions

Exporter namespaces live in `.blend` Scene properties: same-source save-as retains them; unrelated projects with same-named objects get independent identities. **This is why `blender_job_control` resume opens its own source.blend**; an empty project creates a new namespace and changes every resourceId.

**Versions follow derived content, not a whole-Scene counter**. Mesh datablocks define MESH resources so linked copies/instances share them; other resources follow objects. A changed content fingerprint creates a version whose number is the Scene revision introducing it, at `visuals/<resourceId>-v<rev>.glb`. **Never overwrite or delete old version files.** Every scene.json version contains actual `sha256`/`byteSize`, recomputed before writing.

Re-exporting into the same output directory makes **no export call for unchanged visuals** and preserves bytes/mtime/version. Fixed-name `scene.json` / `physics/*.xml` / `isaac/*` outputs are written only when bytes change. Camera/light/instance-pose changes update scene.json, with body movement also updating physics/world.xml. Material/shared-mesh changes or in-place external-texture byte changes re-export only affected resources, keeping other versions.

`source.blend` is the **live editing project**, rewritten only when the project changes. Each version's original points to frozen `sources/<ns>-r<rev>.blend`. Read that snapshot to reproduce a prior derivation; the live project can change. Continue edits from the corresponding revision snapshot into a new output directory before receiving. Never overwrite GLB/USD/originals still referenced by another Scene or hand-edit the ResourceLibrary to resolve conflicts.

## Delivery

Deliver editable originals, previews, Scene and independent receipts for required engines. Distinguish exported, loaded, actually executed and task-goal reached. Missing Isaac runtime dependencies remain a blocker while usable MuJoCo work may continue. Robot motion must come from actual controllers/physics stepping. **If physics was not performed, state that only geometry and appearance were delivered.**

`LYAPUNOV_BLENDER_MCP_COMMAND` may select an installed upstream Blender MCP executable; `BLENDER_HOST/BLENDER_PORT` identify the active addon. MCP is an existing connection method using the same artifact contract. No new MCP server, Agent or task platform is required.
