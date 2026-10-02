---
name: scene-construction
description: Build and modify scenes in the Lyapunov 3D workbench: create/open/save Scenes, obtain environments through Blender, generative reconstruction, environment downloads or the asset library, and place/adjust objects. Use for requests such as build a scene, build a room, download an environment or place a table. Consult environment-planning as needed for complex creation or whole-environment restructuring; simple operations do not require a complete plan.
---

# Scene construction workflow

**Input**: the requested scene/change plus the existing Scene, if any, with sceneId and current rev.
**Completion**: verify the target entities in the 3D view or rendered image; keep changes in the same Scene with monotonically increasing rev; explain which layer changed and what it changed.

A Scene is a revisioned snapshot operated through product domain tools (`scene_*`), with results visible in the 3D view. **Use domain tools for product state.** File tools may read/write task-workspace scripts, reference indexes and artifact files (`blender_run.python_script` is itself a script file). Do not inspect or modify product state or product source through file tools.

## Entry: plan by complexity, load by stage

1. For **complex new environments or whole-environment restructuring**, load `environment-planning` when useful and identify decision-relevant goals, unknowns, methods, dependencies, budget and acceptance. **Native plan mode uses its native planning entry and approval rules, without `todo_write`; implementation-stage multi-step tasks may then use Todo for progress.** Do not create a separate product-plan store. Simple open/import/local edits need no full plan. Continuing work reuses the current plan, sceneId and jobId.
2. **Load the relevant skill only when its stage is needed**:
   - `environment-research`: reference/source search, gap-driven iteration, source-page/licence checks, and a short task-local index of adopted references.
   - `photo-reconstruction`: photo/video/sketch inputs as appearance/perspective evidence, calibrated dimensional estimates and CAD cross-checks.
   - `cad-import`: drawings/CAD inputs as dimension/topology evidence.
   - `architectural-world`: the complete Blender modelling/editing/export contract.
   - `asset-generation`: individual assets/objects through procedural Blender, generation or downloads.
   - `environment-assets`: public-environment search/download/assembly.
   - `unity-environment`: current Unity delivery capabilities and boundaries.
   This skill assembles stage outputs into one Scene and verifies them in the 3D view.

## Routes: choose by requirements and combine when appropriate

1. **Blender generation**, for editable collision-bearing buildings/rooms: prefer connected Blender MCP (`mcp__blender__*`), otherwise `blender_run`. Load `architectural-world` for its detailed contract.
2. **Generative world reconstruction**, when a complete area must be generated: compare currently available entries such as `generate_hunyuan` and `generate_marble` using the user's selected provider, supported input, quality, editability, representation and cost. Do not fix a provider solely from the shape; existing assets and task scripts may be combined. Paid work needs authorization. Accept actual receipts, artifacts and observation before registering/mounting them.
3. **Environment downloads**, for existing real environments: `scene_environment_search {query}` (PolyHaven CC0) -> `scene_environment_detail` for actual category/triangles/volume -> `scene_environment_import`. Load `environment-assets`. The environment-library panel also offers built-in splats: machine-verified geometry bindings register collision representations, and `sim_open`/`sim_sync` gives the world the ground heightfield/wall boxes. With `transform.position`, ground placement follows point-cloud bounds (`alignBottomToSurface`).
4. **Existing library asset**: an `asset_list` match mounts directly through `scene_mount`.

## Scene operations

- Lifecycle: `scene_create` / `scene_open {path}` / `scene_save {sceneId, path, portable:true}`; portable copies dependencies for portability. Read with `scene_list` / `scene_inspect`.
- Editing: `scene_edit` with add/remove/update/reparent commits rev+1 through `expectedRevision` CAS. `update.changes` **replaces entire top-level entity fields**: supply full position/quaternion/scale for `transform`, and full objects/arrays for `components`/`resources`. Read complete current values with `scene_inspect` first. Empty entities organize hierarchy; visible models must come from assets.
- Placement: `scene_mount {sceneId, resourceId, version, transform}` uses metres, right-handed Z-up. Omitted transform uses the registered mount pose or identity at the origin. Explicit `transform.position` aligns the bounds bottom to its height unless `alignBottomToSurface:false`. The UI's add-to-current-scene action uses the same click-placement source.
- History: `scene_history` / `scene_restore`, validating current rev with CAS.
- Save the current observation camera: when `camera_scene_save` is visible, use `mode:current-view` to take the complete camera from the specified Viewer's displayed Frame without first starting a world or piloting it. Native presets/mount edits follow the actual schema. Body mounting requires body/world/generation from the same Frame. Permanent saving uses Scene CAS; preserve a failed draft rather than claiming it was saved.

## Many instances of one asset, with distance-based LOD

Repeated plants/trees/statues/rails **share one resource version**. Viewer caches GLTF by resolved URL and shares geometry/materials/textures across instances instead of duplicating VRAM. Add `lod` declarations only where needed; Viewer switches by **camera-to-entity distance**. Do not build another Scene for distant objects or duplicate resource files.

Four steps, using existing tools rather than an import-implies-derivation pipeline:

1. **Create derivations in Blender; originals remain read-only.** Import with `blender_run`, apply `Decimate` or equivalent simplification, and export a separate GLB with `export_yup=True` and source coordinates matching the original.
2. **Register as a resource first**: `scene_import {path: <derived.glb>, name, physicalize:false}` **without sceneId**. It returns `resource.ref`; sceneId would also mount an extra entity. Register the base similarly or with `scene_environment_import`.
3. **Mount instances**: `scene_import {path:<base.glb>, sceneId, transform}` or `scene_mount {sceneId, resourceId, version, transform}`. Repetition means mounting the same version repeatedly.
4. **Declare levels** through a `scene_edit` update. Add derived refs to the entity's **resources** and write levels under `components.visual.lod`. `components`/`resources` are whole-field replacements: inspect current values first and use `expectedRevision` CAS.

```jsonc
{ "op": "update", "entityId": "plant-3", "expectedRevision": 7, "changes": {
  "resources": [ /* existing refs + derived ref returned by scene_import, with its resourceId/version/representations */ ],
  "components": { "visual": { "kind": "mesh", "gltfNode": 1, "sourceTransformApplied": true,
    "lod": [ { "role": "visual", "minDistanceM": 25, "resourceId": "pebbles_lod1", "version": 1 },
             { "role": "visual", "minDistanceM": 60, "resourceId": "pebbles_lod2", "version": 1 } ] } } } }
```

The contract rejects mistakes explicitly rather than silently selecting the wrong artifact:

- `minDistanceM` is the entry threshold in metres, measured from the camera to the entity's world-bounds centre. Sort levels ascending; the nearest range uses the base. Choose thresholds from observation distance and simplification ratio; there is no universal default.
- `role` matches a registered representation. Mesh resources normally use `"visual"`, so derived levels use `role:"visual"`. The level's `resourceId`/`version` must already be registered and present in the entity's `resources`.
- A level pointing to the base URI is rejected with `LOD_LEVEL_NOT_DERIVED`. Derived `source` axes/handedness/units must match the base, especially for source-coordinate-baked entities.
- **Derived node indices are a different namespace from original indices.** A single-object export often has one node; copying the base `gltfNode` can select the wrong node or cause `GLTF_NODE_NOT_FOUND`. Use `gltfNodeName`, or omit it for base-name/unique-mesh resolution. Ambiguous multi-mesh addressing reports `LOD_LEVEL_NODE_AMBIGUOUS` and retains the current display rather than guessing.
- Matching position does not depend on equal node numbers. Exporting retained transforms or baking transforms into vertices both use the same world-position conversion.
- Verify `lod` and `resources` with `scene_inspect`, then take `viewer_observe` images at **near and far camera poses**, checked against sceneId+expectedRevision. Near should use the detailed base and far the simplification. Counts alone do not prove LOD.
- Entities with baked-animation mixers do not exchange LOD. Failed base loading falls back to the coarsest available level with missing-asset warnings instead of disappearing.

## 3D annotations: edit the current Scene in place by default

Annotations carry **entity identity, entity-local coordinates and world coordinates at submission**. `viewer_annotation_send_ui` delivers a user message; `viewer_annotation_read` retrieves the same image/text. Interpret it as a request to change the indicated location. **Apply expressible `scene_edit` changes immediately to the current Scene**:

1. **In-place changes first**, retaining sceneId and annotations with rev+1: entity movement/rotation/scale, visibility, parentage, deletion/duplication and replacement below. Check whether a real consumer exists. `components.light` has a Viewer consumer for kind/color/energy/direction. **Entity colour/material fields have no consumer**: changing components does not change appearance. Edit source Blender materials/textures and export instead of claiming annotation-driven recolouring.
2. **Escalate to Blender only when new geometry/source material is required**: opening/arch shapes, roof profiles, whole structures or source textures. Use `mcp__blender__*` or `blender_run` on the source project, then export.
3. **Continue in the same Scene after escalation**:
   - Receive with `scene_open` if it aligns with the document. Identical same-scene content is an idempotent reopen; only same-identity resource-location changes may overwrite. Changed entity structure/resource identity reports `SCENE_ALREADY_EXISTS`.
   - Use `scene_replace_resource` for mounted-entity replacement; `scene_import {sceneId}` adds entities. Preserve identity, pose, parentage and user components. Multiple refs require `fromResourceId`/`fromVersion`; expanded GLB groups use their root.
   - Collision/rigidBody/controller preservation uses actual per-node static geometry equality. Geometry changes, including internal pose/scale, require registered target derivations or report `REPLACE_RESOURCE_PHYSICS_NOT_DERIVED`. Native robot articulation/mujoco/isaac/visual.robot, unverifiable compression/skinning/driving animation, or unsupported structure/source-coordinate changes require rebuilding mounting within the same Scene, explaining identity/annotation effects. Never change refs while retaining invalid derivations. If the tool is unavailable, record the concrete gap.
   - **Never evade in-place updates by inventing a new sceneId**, which would discard annotations, cameras and the user's working context.

Explain which layer changed and why each round: an in-place Scene edit or source geometry reconstruction in Blender. Do not replace that explanation with a generic fixed claim.

## Boundaries

- Read-only official-suite projections cannot be edited or saved as projects.
- Separately read this request's download/import, mount, collision-activation and robot-passage receipts; unknown states never inherit historical verification.
- Physics is not a modelling/receiving/viewing prerequisite. Open worlds only when collision/dynamics/robots are required. After `sim_open`, Scene edits require `sim_sync` to reach the world.
