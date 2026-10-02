---
name: asset-generation
description: Generate and acquire model/object/environment assets through Blender, Blender MCP, text/image-conditioned reconstruction, downloads/imports and collision derivation/baking. Use for requests such as generate a 3D model, make a crate, download an asset or physicalize it.
---

# Asset generation workflow

Register assets in the runtime ResourceLibrary (`asset_list`), then mount with `scene_mount`. A file path alone does not prove usable generation; receive and verify actual artifacts. Consult `environment-planning` as needed for complex whole-environment/building restructuring and follow native plan mode. Simple acquisition/import requires no full plan; this skill handles individual components/objects.

## Formal product routing and names

The formal account's human-facing 3D service is **Peiri 3D**, and image generation is the **Peiri image service**. Current unified account services own quotation, confirmation, submission and recovery. Internal product/provider identities serve protocol/audit purposes; do not ask users to select providers or enter provider keys. Missing central recovery/quotation endpoints, incomplete configuration or no positive-credit quote must report the actual blocked service/stage and stop this generation attempt. Without configuration changes, do not retry, repeatedly ask paid confirmation or reload the same skill. A generic 404 does not establish that a request never existed or justify charging again.

Choose automatically from geometry and delivery constraints: exact-dimension regular ground/tabletops, editable regular geometry and procedural scenes use Blender; semantic shapes, organic objects and realistic appearance use Peiri 3D with one actual quote confirmation. Target dimensions on organic objects still require post-generation calibration; dimensions alone do not make them regular geometry. Respect explicit Blender, Peiri 3D, generative or non-Blender requests. Do not return old hand-built geometry as a new generated artifact when new/non-Blender generation is required. Internal `generate_tripo`/`generate_hunyuan`/`generate_marble` names identify different protocol executors for actual calls/audit; product explanations, questions and task labels use Peiri.

## Routes: compare user constraints and combine when appropriate

> Respect the selected generator/source/quality/editability/cost. When unspecified and constraints suffice, select Blender or Peiri 3D yourself. Ask paid confirmation only for the actual quote. Existing/free public assets are candidates only when they satisfy source/new-generation constraints; disclose any selected replacement source and licence.

| Form | Route | Verify this request |
|---|---|---|
| Regular boxes/tooling/racks/sheets/pipes/cylinders | Blender code (`blender_run` / `mcp__blender__*`) -> export -> `scene_import` | Actual export, editable original and collision derivation |
| New semantic/organic/realistic assets | Peiri 3D using the current visible text/image-to-3D protocol; no provider-selection question. Requests needing real materials explicitly set `texture:true` and `pbr:true` | Service configuration and actual quote first; download/register/observe results and complete `scene_import` if needed |
| Multi-part assets | Blender for regular parts, Peiri 3D for semantic appearance parts, then assemble new artifacts spatially | Verify acquisition and assembly separately; quote-confirm Peiri parts first |
| Existing environments/modules/props | `scene_environment_search` (PolyHaven CC0 catalog includes environments and props) or `asset_list` -> `scene_environment_import` / `scene_mount` | Actual import records licence/file hashes. Props are not rejected by shape/category alone; observation/assembly determines environmental use (`environment-assets`) |
| Existing local files | `scene_import {path}`; ZIP or glTF with relative bin/textures uses `scene_asset_acquire {path}`, with `entry` for multiple candidates | Actual dependency verification and registration |
| Other public sources outside PolyHaven | Use `scene_asset_acquire` for public HTTPS direct URLs or local `.glb/.gltf/.zip`. GLB/3DGS budgets below; forbid redirects, file://, private networks and credential-bearing addresses. Legacy `scene_import_url` accepts self-contained GLB only | Read actual `license`/`author`/`sourcePage`; the tool infers none. Use this request's verification/registration |

### Acquisition formats and budgets

- **GLB/glTF/ZIP**: `scene_asset_acquire.maxBytes` defaults to and cannot exceed **64 MiB**, covering this acquisition/assembly. Self-contained GLB through `scene_import_url` also has a 64 MiB cap. Reuse a registered URL when local hashes still match; `refresh` forces redownload. Do not apply this cap to other entries.
- **3DGS single direct files and public SSOG**: `scene_asset_acquire.splatMaxBytes` defaults to **8 GiB**, hard maximum **32 GiB**. SSOG pages/manifests/blocks and bytes received on failed attempts share the request's network budget. Direct `.spz/.ply/.splat/.sog` retains actual byte/ZIP validation and permission limits.
- **Supported SuperSplat pages**: read public metadata with `scene_asset_resolve`, then acquire the complete selected layer with `scene_asset_acquire`. Default highest-detail **LOD0**; explicit `selectedLod` changes layers without silent budget-based degradation. Multiple blocks return `resources[]`; sceneId mounts the group root and all children once. Public SSOG is a **derived representation, not the author's original PLY**; protected originals require authorization. Resolving a page is not downloading/registering; HTML/manifests are not models, and visual points alone imply no collision.

**Actual image-to-3D input**: `generate_tripo` image-to-3d requires publicly accessible image URLs, with 1-4 views ordered front/left/back/right and an allowed host. Local files cannot be submitted directly. Image-conditioned scale is estimated: calibrate from known dimension marks/calibration objects before mounting and label estimates in delivery (`photo-reconstruction`). Text-to-image uses `generate_image`; formal mode uses the central Peiri image-account entry. Missing image configuration does not produce a reference image and must not trigger repeated image-to-3D attempts. Obtain actual usable images first or explicitly switch to a user-allowed text route.

**Artifact/material closure**: immediately materialize mesh/texture URLs into workspace/CAS; temporary remote URLs are not durable refs. `artifactsFetched:false` still means complete bytes were not received. New `generate_tripo` top-level `texture`/`pbr` booleans enter actual parameters and request identity. Changed material requirements are new parameters; an old requestId's untextured result is not a new artifact. Request success still requires actual material/UV/texture-dependency checks, registration, mounting and observation.

Blender colours/materials must use real nodes: find `node.type == 'BSDF_PRINCIPLED'` and write RGBA to `socket.identifier == 'Base Color'`. `material.diffuse_color` alone does not guarantee exported GLB colour. With no connected colour texture, `blender_run.material_colors` may explicitly map material names to RGBA JSON. Do not infer colours from names; retain existing colour-texture connections. Texture requests need actual images/UV/PBR channels; plain colour is not a texture, and missing images/UV must be listed.

## Storage semantics (since 2026-09-16)

- Reimporting identical entry-sha256 content returns already-present without a version increase or duplicate storage.
- External files outside product/Scene roots copy once into CAS; built-in materials and in-library files are referenced without copying.
- Source markers builtin/download/generated/import remain queryable.
- Splat-to-collision-GLB bindings register on import. Hash-verified built-ins retain machine-verified binding, mount collision automatically and enter the world via `sim.sync`. A same-name `.glb` is only a candidate until axes/alignment are verified and confirmed. Paired GLB is a surface-collision proxy, not semantic mesh understanding.

## Collision derivation and verification

- GLB/mesh collision derives by default during `scene_import` registration. `physicalize:false` skips; `physicalizeStrategy` selects `auto/convex_hull/voxel_boxes/coacd/triangle_mesh`. Read `asset_list.physicalization.status`; derived defaults make later resourceId mounting collision-bearing. **There is no `asset_physicalize` tool.** Rework/customization uses `asset_bake.request_json` with sourcePath/outputDirectory/method/strategy/usage. `asset_verify` checks refs; `asset_edit` changes names/tags/folders.
- Generation quotation/confirmation happens **in conversation**; the old generation panel is retired. With `allowPaidSubmission=false`, new submissions require native user-question confirmation. Never submit without authorization.
- **One authorization covers the current request**: confirmation binds requestId, parameters and quote fingerprint. Repeating the same request does not repeat confirmation; changed request/quote requires a new one. operationId recovery resumes an existing remote task rather than creating a submission and needs no repeated confirmation. Do not reuse old authorization for changed requests.

## Boundaries

- Missing suitable assets or unavailable services must report the actual blocker. Offer Blender/free public alternatives only when user constraints permit them; do not silently convert an explicit generative request to hand-built geometry.
- Judge quality after actual artifact observation and Scene checks, not DONE alone. Treat image-conditioned outputs initially as appearance candidates; calibrate dimensions from known references and mark estimates rather than measured truth.

## File boundary (ENV-04)

- Task-workspace scripts, references, intermediate artifacts and exports may use bash/read/write file tools.
- Product state uses `scene_*`/`asset_*`/`sim_*`/`robot_*` domain tools. **Do not change on-disk files to alter product state or edit product source.** Capabilities come from skill contracts and actual product receipts.
