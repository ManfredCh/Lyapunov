---
name: photo-reconstruction
description: Reconstruct scenes from photos, video, or sketches. Organize objects and camera viewpoints, research missing views, grade perspective/scale estimates by evidence, model in Blender, and compare from the same camera pose. Use for build from photos or reproduce the building in this photo; photos also supplement CAD/map workflows with explicitly graded estimates.
---

# Photo Reconstruction Workflow

**Input**: photos/video/sketches, optionally supplemented by known dimensions, calibration references, maps, or CAD drawings.
**Completion**: appearance and proportions pass comparison from the same viewpoint; delivery notes distinguish known values, estimates, and unverified parts.

Photos and CAD are **complementary evidence**. CAD/drawings provide units, topology, and annotated dimensions. Photos provide appearance, perspective, material appearance, and **geometric inference/dimension estimates when scale references or camera pose are known**. Cross-check at field level through `cad-import`; estimates can guide modelling but must not be presented as measured truth. Plan new scenes/major reconstruction through `environment-planning`, with plan facts in native Todo/session state; this skill covers the photo step.

## 1. Organize Inputs First

For each image, record the object, date, camera viewpoint/orientation, crop, occlusion, and correspondence with other images (same facade/component). Research missing rear/side/detail/interior views through `environment-research`. If unavailable, grade them as estimates rather than inventing a confirmed backside.

Before combining images, confirm **the same object and period**, then match camera poses. Mixing alterations from different dates creates conflicting proportions.

## 2. Camera and Perspective

Derive camera assumptions from visible vanishing points, horizon, and known parallel lines, and record them in the plan. **Correct the camera before changing geometry**; do not stretch correct geometry to compensate for an incorrect camera. Use `scene_align` with three noncollinear source/target points in metres to align a model. With actual measured world/pixel correspondences, use `camera_fit` for pose; residual meanings and limits are below.

## 3. Grade Scale Before Using It

- Known annotated/measured dimensions rank above estimates derived from known references (standard door heights, railings, brick courses, known lens calibration), followed by single-image modelling assumptions. Explain each derivation chain, the image/reference used, conversion, and uncertainty sources.
- Multiple viewpoints/known poses can constrain each other. Single-image relative depth can aid occlusion and volume interpretation, but there is no multi-view reconstruction tool here. Manually constrain views with known correspondences (`scene_align` and per-view render comparison). Pass calibration references through `blender_run.scale_anchors` (`{"name","pixels","metres"}`); it reports px/m and **inconsistency percentages** without blocking. Decide acceptance and record it in delivery notes.
- Maps/public dimensions through `environment-research` and CAD annotations can calibrate photo estimates. Resolve conflicts by checking object, date, and version without unconditional source priority.

## 4. Depth and Multi-View Boundaries

- **Metric depth from an engine camera is measured simulation observation** (`sensor_capture`, `camera_capture_multi` depth; `camera_project_annotation` requires measured depth consistent with rendering). It is not inferred from photos. Monocular relative depth and model-predicted metric depth are **estimates** and must be graded separately from measurements.
- Use `depth_estimate` for monocular depth from the original image **when visible in the current tool surface**. It uses local weights, offline execution, and CPU by default; weights come only from the HF mirror. Output is **relative depth**, with larger values nearer, **not metric**, and no confidence estimate. Constant output on uniform/textureless input is valid. It helps interpret occlusion, rough camera constraints, and initial volumes; it is not a rangefinder or an exact photo-to-3D conversion.
- This tool is assembled only when interpreter and model directory are configured. When absent or provider-unavailable, follow the actual error: correct the camera first and use known references/multiple viewpoints for manual interpretation. Do not infer a product-wide depth limitation from one unconfigured machine, and do not ask users to install dependencies into Blender/Isaac Python; deployment supplies the isolated environment.
- With measured correspondences, use `camera_fit` **when visible**. Supply world points in metres/Z-up and pixels with a top-left origin, u right/v down, plus measured K (`fx/fy/width/height`, optionally `distortion`). `role:"check"` points are excluded from fitting and provide independent checks. The tool does not detect features, match points, or calibrate the camera; supply correspondences from image reading/manual work/other tools. `fitResidualRmsPx` is only the reprojection residual on those points. **Low residual does not establish pose accuracy**: inspect `precision.independentCheck` and `precision.spatialCheck` for independent checks and spatial extrapolation to the camera or points outside the correspondence bounds. Repeated world points with different pixels do not validate extrapolation. When `precision.measuredAccuracy` is false, do not treat pose as a calibrated measurement. Without K, only the `lens` assumption path is available; results include source/assumptions and are not measured calibration. With unknown `worldUnit`, position fields have no M suffix and must not be read as metres.
- Use `depth_geometry` **when visible** to convert relative depth into metric geometry. Input is `depth_estimate` npy/metadata, K, and camera pose; output is metric depth **along the camera axis** and a coarse mesh. **Caller-supplied anchor depths define scale**; anchors may be measured or assumed, and the tool fits/tests them without inventing scale. `calibration.verdict` is the current verdict: only `verified` passes; `train-inconsistent`/`check-failed`/`unverified` cannot support a metric conclusion (see `accepted`). Assumed anchors support only conversion under an assumed scale, **never measured metric depth**. Images with `units:"relative"` have no own scale and produce no metric output.
- When depth, drawing dimensions, and photo estimates conflict, check **object/time calibration** using known dimensions, same-view renders, and contemporary sources; do not assign absolute priority to a source type.

## 5. Model, Observe and Revise

Load `architectural-world` for the complete Blender contract. Prefer a connected tool actually present in native MCP discovery; `blender_run.python_script` also supports full `bpy` modelling. Select by the available editor, observation and export path, not by assuming that batch execution only supports simple shapes.

Keep the following loop in the same native AgentLoop and task. Use the task's existing files/Todo for concise evidence; no separate workflow engine or fixed component DAG is needed.

1. Identify the visible requirements from the references: silhouette/proportions, distinctive geometry, openings and material appearance. Choose a view that can reveal each requirement. Treat unseen parts as assumptions; this does not excuse omitting visible features.
2. Execute the model/change, then obtain actual previews. With batch jobs, `render:true` or `operation:preview` uses the tool's render path; a script with its own renders must expose/read those actual files. `render:false`, a Job ID or a successful export does not establish that an image exists or was seen. Wait on the same native Job; a quiet running job is not a reason to resubmit it.
3. Read the reference and corresponding preview images in the same session. Check framing, view and illumination before diagnosing geometry. State each decision-relevant gap and its next concrete edit; a file path or image count alone is not visual comparison.
4. When a visible requirement is missing, actually edit the geometry/material/camera and rerender the affected view. Compare the new image with the same reference and confirm what changed before propagating repeated components. Do not stop with a list of defects while reporting the model complete. Do not repeat unchanged checks once the affected requirement passes; if progress stops or a real dependency blocks it, report the specific unfinished item.
5. Export and read back the exact final artifact using the portable-material and roundtrip contract in `architectural-world`. Then import it with `physicalize:false` for visual-only work, and observe the mounted revision through Viewer from the relevant viewpoint. Keep export facts, Blender reload, Viewer loading and visual acceptance distinct. Enter physics only for a requested collision/dynamics/robot task.

Completion follows the observed requirements and actual portable artifact, not triangle count, tool success, turn completion or unsupported claims of embedded textures. State remaining visual differences and unknown parts precisely.

## 6. Update the Same Scene from Photo Evidence

Use `scene_edit` for local corrections with the same sceneId and incremented rev. State the entity, photo-based evidence, action, and viewpoint used to recheck it.

For geometry/resource replacement, follow `scene-construction`: `scene_import {path, sceneId}` adds an entity. Register the target resourceId/version first, then use `scene_replace_resource` to preserve entity identity. Keep collision, rigid-body, and control components when actual static geometry is identical. Changed geometry must use the target's registered derived defaults; resolve missing derivations from actual errors first. Native robot articulations/engine documents, unverifiable compressed/skinned/animated geometry, and rejected structural/source-coordinate changes still require rebuilding the mount within the same Scene, without preserving invalid derivations. If tools are unavailable/unsupported, record the gap; do not merely change resource references while retaining invalid derived state, or create a new sceneId to bypass an in-place update request.

## Delivery Evidence

Identify photo sources for appearance, known/derived/assumed dimensions, and unverified backsides/interiors/absolute scale. Generated, reference, and rendered images are not photographic evidence or measurements.

## File Boundary (ENV-04)

- Use bash/read/write and other file tools for task-workspace scripts, references, intermediate outputs, and exports.
- Product state must use domain tools (`scene_*`/`asset_*`/`sim_*`/`robot_*`, etc.). **Do not change product state by editing files on disk**, and do not modify product source. Capabilities come from skill contracts and actual product-tool results.
