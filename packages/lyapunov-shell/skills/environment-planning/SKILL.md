---
name: environment-planning
description: Planning-stage contract for environment tasks. Turn photo reconstruction, CAD rebuilding, text-driven creation, existing-scene edits, and mixed inputs into a plan proportionate to complexity, covering goals and unknowns, methods, dependencies, budget, and acceptance. Use native plan mode and implementation Todo; simple operations do not require a complete plan. Continuations retain the current plan and jobId, plan-only requests do not execute production, and stopping does not wait for planning. Use for photo reconstruction, creating or substantially rebuilding an environment, continuing an environment task, proposal-only requests, or instructions to hold off on execution.
---

# Environment task planning

Choose planning detail from the user's goal, unknowns, and task complexity. A routing match alone does not require a complete plan. **In native plan mode, use the existing planning entry point and approval rules; do not call `todo_write`.** For multi-step implementation, use native Todo to track progress. Simple opening, importing, or local adjustments can be executed and checked directly without a separate planning repository.

The router provides **conservative suggestions** based on message text, attachment facts, native todo, and workbench selection. It does not replace intent judgment or authorization. Follow the user's actual intent when it misclassifies a request, and explain scope where needed. Correct these common cases:

- **Negation:** "Do not stop" means continue. "Do not build the scene yet" inside a proposal-only request prohibits execution; it does not cancel an existing task.
- **Questions about content:** A photo with "Who/what is this?" is not an environment-modeling request. An image attachment does not authorize construction; the user must request **building or editing**.
- **Not searched is not absent:** A miss in one catalog does not establish that an asset is unavailable everywhere.
- **Context:** A routing hint sees only this step's input. Your session history, native todo, and job state remain facts. Do not treat omitted context as nonexistent or invent earlier conversation. If uncertain, check `scene_inspect`, todo, and `job_list`, or clarify.

## 1. Task scope

| Mode | Trigger | Planning detail | Allowed execution |
| --- | --- | --- | --- |
| Create/substantially rebuild | First environment request, whole-scene rebuilding, or broad reconstruction | Key goals, unknowns, dependencies, and acceptance proportionate to complexity | Execute phases within authorization |
| Local edit | Modify, move, replace, or raise a component; an annotation identifies an entity | Entity, action, and inspection viewpoint where needed; no full environment plan | Edit locally and verify without rebuilding everything |
| Continue | A continuation request with an existing environment task | **Do not replan:** retain the plan and jobId | Check status and resume |
| Proposal only | The user requests a proposal or prohibits execution for now | Provide the proposal, **without production** | Read-only research; no production/paid generation |
| Stop | An affirmative stop/cancel request, not a negated one | No plan | **Do not wait for planning:** immediately use the existing stop entry point |

- Proposal-only work may use `web_search`/`web_fetch`, `scene_list`/`scene_inspect`/`asset_list`, `scene_environment_search`/`detail`, and fetching reference originals for **read-only research**. Do not call `blender_run`, `generate_*`, `scene_import`/`scene_edit`, library download operations (`scene_environment_import`/`scene_import_url`), `sim_*`, Tripo, image generation, or other state-changing/paid actions. A proposal does not require producing or downloading the deliverable: research enough to choose a route, then stop until the user requests continuation.
- Stop world/entity actions with `sim_stop` (`robot_stop` uses the same source), and long jobs with `job_kill`. Report **the step where execution stopped**; do not write a plan first.

## 2. Select planning elements for the task

Consider the goal and audience; scope and historical period; scale and units; gaps and necessary searches; component/asset breakdown; methods and unresolved route choices; dependencies and parallelism; budget and stopping conditions; acceptance viewpoints and native Viewer inspection; saving/reopening; and missing references. Include only elements affecting the current decision, rather than completing a mandatory checklist for simple operations.

- **Choose methods by component and constraints (ENV-55):** Regular geometry can use Blender (`blender_run`/`mcp__blender__*`) or task scripts. Reuse or search for assets. Compare currently reachable Hunyuan/Tripo/Marble text/image-to-3D routes by the user's specified source, quality, editability, availability, and cost; provider suggestions are not hard rules. Use image generation for appearance exploration only after verifying the actual service, without pretending it ran or inventing tools from names. Consider Unity for engine-side editing. Do not add unnecessary generation to fill a nominal workflow.
- **A catalog miss proves only that catalog missed:** Record checked libraries, queries, and results without extrapolating to global absence or infeasibility. Select sources for the current gap; proceed once evidence supports a feasible route without exhausting every source.
- **Choose sculpture/plant routes by quality and cost:** Stone lions, gate piers, ornamental pedestals, plaques, and trees may use assets, searches across sources, or authorized generation. Exhaustive searching is not required first. Generated drafts need refinement and inspection before delivery. Blender can make regular parts and organize, assemble, or correct proportions; a few simple shapes do not complete a complex component.
- **Load contracts for the current gap:** `environment-research` supports search/source checks, `asset-generation` asset acquisition/generation, and `cad-import` drawing interpretation. Real-world or mixed input does not automatically require several full contracts.
- **Dependencies and parallelism (ENV-56):** Identify what waits for what. Writes to the same project/Scene **must be ordered**, with one writer at a time and increasing revisions. Reads and searches may run in parallel.
- **Validate a representative fragment first:** Complete one component or small area and **actually see its image in the native Viewer** before expanding assembly. Do not construct the whole scene from imagined output without viewing it.
- **Acceptance occurs in the native Viewer:** After importing into Scene, inspect the 3D view from the same viewpoint through the image/annotation flow. Specify **how to save and reopen** the same sceneId/project. Blender renders are modeling comparisons; looking only in Blender is not acceptance, and delivery is incomplete before content enters Scene.
- **Budget and stopping conditions:** Invest according to user budget, complexity, cost, and new information. Agree numeric limits for the task when needed instead of imposing universal search counts. Define success and when to change methods. Stop when requirements are met; adjust methods or explain continuation requirements when progress stalls. Paid authorization and tool limits still apply.
- The plan is **live**; explicitly state any revision.

## 3. Input and evidence tiers (ENV-01)

| Input | First actions | Prohibited assumptions |
| --- | --- | --- |
| Single photo | Search the object and additional views; estimate perspective/scale. `depth_estimate` can help with occlusion/viewpoint, but relative depth is only an estimate. Mark unknown backsides. | Do not present inferred backsides as known. |
| Multiple images/video | Verify object/period, then align viewpoints before fusion. | Do not directly combine independently predicted depths. |
| CAD/drawings | Separate vectors from scans; read units, layers, topology, dimensions, elevations, and references. | Do not invent dimensions. Use visible `cad_inspect` for actual DXF units/coordinates; handle absent configuration through the real error and alternatives instead of declaring the product cannot read DXF. Convert DWG first. |
| Mixed inputs | Verify CAD/maps/photos/public references at field level. | Resolve conflicts explicitly by object, period, and calibration, not source-category ranking. Generated images are not measurements. |
| Text/sketch | Search references first; generate concepts where appearance exploration is needed. | Generated images do not replace physical evidence in real-world reconstruction. |

Report dimension provenance as **explicit drawing dimensions > scale-derived estimates > modeling assumptions**. This grades each dimension's confidence. Resolve conflicting sources by object, period, and calibration; drawings do not always win. Without scale, do not claim absolute accuracy.

## 4. Research and revisions (ENV-54)

After drafting a plan, identify the **most important gaps** in viewpoints, dimensions, layout, or components. Search around those gaps, using English/Chinese aliases where useful. **Revise the plan from findings:** change dimensions, layout, or production routes where evidence warrants it, explaining which finding changed which decision from A to B. Keep research bounded and start production when key evidence is sufficient.

Distinguish **what was checked** (source/catalog/query/time), **what was found**, and **remaining gaps affecting the decision**. Known format, dependency, authorization, or budget constraints can establish that a method is infeasible under current conditions without exhausting all sources. An asset not found is not proven absent. A page/API failure establishes that attempt's failure, not failure of all methods or the goal.

## 5. File boundaries (ENV-04)

- Allowed: Blender/CAD-processing scripts, references (photos/drawings/retrieved images), intermediate artifacts, and exports in the task workspace, using bash/read/write and other file tools. Production naturally requires scripts; domain tools do not prohibit task scripts.
- Product state must use domain tools: `scene_*` for scenes/entities/projects, `asset_*` for the asset library, `sim_*` for worlds/actions, and `robot_*`. Do not change product state by editing stored files.
- Do not modify product source, scene libraries, or resource directories to perform product operations. Do not inspect source implementation merely to discover capability; rely on skill contracts and product-tool results.

## 6. Native task continuation (ENV-57)

- Native plan mode follows its existing planning entry point and approval rules. Multi-step implementation uses `todo_write` with whole-table replacement; simple operations require no mandatory Todo. Reuse native plan/Todo/session state instead of duplicating it in product files. Continue within existing authorization without demanding step-by-step approval. Proposal-only instructions, plan approval, additional permissions, and new costs retain their respective boundaries.
- On pause/resume, reuse the original Todo, source project, sceneId, reference index, and jobId; do not create another Scene or planning repository.
- **The hint's single-step view does not limit your context:** Session history, native todo, and Jobs remain facts. Resolve references such as "continue that task" against todo/Scene/entity facts before acting. Clarify real ambiguity; do not feign missing context because a hint omitted it or invent earlier dialogue.
- Long tasks use native Jobs: inspect with `job_list`, obtain actual output with `job_output`, and cancel with `job_kill`. After an observation timeout, check job state before resubmitting the same paid/long task.
- Deliver through paths visible in the native session/workbench, such as `scene_import` and image attachments. A prose completion claim alone is insufficient.

## 7. Load stage skills as needed (ENV-59)

This card governs planning and its level of detail. Load deeper contracts for the current stage; **load what you use, not everything at once**:

- Drawing/floorplan input: `cad-import`; editable architecture/Blender detail: `architectural-world`.
- Real-world search/source checks: `environment-research`; photo/video/sketch reconstruction: `photo-reconstruction`.
- Existing environment/asset downloads: `environment-assets`; Scene documents/entity edits: `scene-construction`.
- Generated assets/provider selection: `asset-generation`; robots/actions: `robot-provisioning` and `action-execution`; Unity delivery: `unity-environment`.

**Load only skills that actually exist and are currently needed.** These are related pointers; current availability comes from the catalog and `skill` results. When absent, identify the missing knowledge entry point and inspect alternatives within authorized tools. Skill absence does not establish total capability absence, and an unavailable skill has not been loaded.

## 8. Boundaries

- Do not create a second planning repository or router. Native session todo/Jobs remain planning facts; existing domain pointers own routing.
- Report unavailable tools/backends honestly and give alternatives. Do not create empty implementations or fabricate success. Submit paid generation only after user authorization.
