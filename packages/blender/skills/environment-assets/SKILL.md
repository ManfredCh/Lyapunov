---
name: environment-assets
description: Search/download free public environments, module kits and props into one Scene ResourceLibrary from natural-language requests. Assemble modules when necessary, derive part collision and perform minimal Sim/observation checks. Use for finding/downloading a usable environment or model alongside Hunyuan/Marble generation.
---

# Download world-environment assets

Use this workflow for finding/downloading a world environment or an interior/building/courtyard/terrain that can be entered. Downloads and generation are parallel routes: `generate_*` requires explicit paid authorization; this workflow uses free public credential-free sources, currently PolyHaven's CC0-1.0 model catalog. All routes use the same Scene ResourceLibrary without a new asset table.

**Search is not restricted to complete environments.** The same catalog includes whole scenes, module kits and individual props/furniture. Category affinity only breaks score ties, prioritizing environmental categories; it **does not change the candidate set**. The user determines whether a chair, building or courtyard is needed. Ordinary props use `scene_environment_import` or `asset_list` plus `scene_mount`; lacking a complete-environment label is not failure.

Sky/lighting/textures: **HDRI is outside the scene_environment_* model catalog**. Native HDRI environment import remains pending; do not claim it imported an environment. Verify the source-page licence, fetch an authorized public HDRI with existing workspace HTTP tools, and assign Blender world lighting through the actual `mcp__blender__*` PolyHaven channel or `blender_run.python_script`. PBR textures use native `blender_run.texture_query`/`material_textures`, which connect actual CC0 images to material nodes.

## Three tools

1. `scene_environment_search`: query with optional categories/limit returns candidate names/categories/tags/authors/licences/source pages/thumbnails. Metadata only; no large download.
   - **Matching facts**: catalog English id/name/category/tag/author metadata uses substring matching. **Chinese keywords do not match**; there is no Chinese-English alias map. Use English such as `chinese courtyard`, `modular wall`, `wooden door`. If unknown, establish aliases through `environment-research` web search/common knowledge before catalog search.
   - **Iterate by gap**: search one missing item at a time: layout/site plan, dimensions/massing, sides/back, openings/roof/rails, components/furniture, materials/colours. Observe each import before deciding the next query. Search continues throughout work.
2. `scene_environment_detail`: inspect actual manifest url/size/md5, total bytes, triangles, meshes, materials/textures, **actual category/author** such as Facades & Modules, and visual sizeM bounds in metres. Increase resolution incrementally from 1k to 8k when needed.
3. `scene_environment_import`: safely transfer .gltf/dependencies under cumulative actual-byte limits with per-file md5/byte verification, assemble self-contained GLB and register; sceneId mounts directly. Tags record source/licence/source-page/manifest/category facts.

**Other public sources outside PolyHaven**: prefer `scene_asset_acquire` with a public HTTPS `.glb/.gltf/.zip` direct URL or local files. It assembles relative glTF bin/textures and ZIP members into **self-contained GLB**, using the same registration as scene_import. Per-request maximum 64 MiB; no redirects, file://, private/loopback or credential-bearing addresses. Registered matching URL/byte hashes reuse artifacts; `refresh` forces redownload. Legacy `scene_import_url` remains. **Licences are not inferred**: verify author/licence/redistribution/attribution from actual pages, then supply `license`/`author`/`sourcePage`; omission returns a reminder. Record conclusions in tags, optionally with `asset_edit`. Ask users only for new payment or unclear rights. A fixed PolyHaven catalog must not limit otherwise usable sources.

## Delivery criteria

- **Metadata supplies facts, not conclusions.** Categories/tags/mesh count/triangles/bytes/sizeM support filtering and cost estimates. Large bounds or few meshes do not establish a complete environment. One mesh can be a prop or merged kit; many can be a kit or finished building.
- **Observation/assembly alone determines environmental usefulness**: inspect enclosure, ground and disconnected pieces in Viewer/render after import.
- **Kits and props are normal assets**: assemble modules purposefully, such as wall/corner/gatehouse pieces into a courtyard; mount props normally. Do not call source material a completed environment without that assembly. HDRI/plain background images use the lighting route above, not an asserted native environment import.
- Photos/renders found by search are appearance references. Dimension-evidence tiers and adoption criteria follow `environment-research` / `photo-reconstruction`.
- For excessive size, first choose a lower texture level, increasing 1k -> 2k -> 4k -> 8k as needed, then decide import. Download maximum remains 64MiB of actual received bytes.

## Before duplication: inspect one prototype

The first downloaded/imported item is a **prototype**, not a duplication-ready finished asset. Before placing 2-3 or more copies of the same component, record one **measured** conclusion for each item below. Without measurement, label it an assumption with its basis. Existing tools/scripts suffice; no new service or gate is needed.

| Check | Existing method | Record |
|---|---|---|
| **Form** | `scene_inspect` hierarchy/entity count plus actual `viewer_observe`/`viewer_capture`, not thumbnail alone | One component, disconnected modules or a complete scene? Catalog categories/tags remain facts, not conclusions |
| **Ground contact** | `blender_run` world AABB, or local scene_inspect bounds plus current transform, compared with ground/target surface | Lowest-point height in metres: grounded, suspended or penetrating (negative); identify the reference surface on slopes/steps |
| **Normals** | Blender face-normal averages or one-sided lighting/render inspection, especially walls/roofs | Which side faces outward and whether flipped; explicitly correct a flip using scene_edit quaternion |
| **Materials** | Inspect actual material texture connections through material_textures or rendered textures | Texture count/source (original/procedural), missing dependencies or plain-colour placeholders |
| **Scale/units** | Compare measured bounds with scene_environment_detail.sizeM source-coordinate AABB in metres; source.units declares m, Y-up, right-handed | Actual dimensions against source declarations; use measured values and disclose differences |

Record **assembly order** before copying: place one instance to establish position/orientation/scale, measure its relation to ground/walls/openings, then place copies 2/3. Verify spacing/alignment/orientation per copy. Do not move visuals while leaving their collision at the old pose.

**Recoverable failures**: transient connection resets, truncated bodies, idle/total timeouts, 5xx and 408/429 get **bounded transport retries**, default two additional attempts, with exponential cancellable backoff. Incomplete bytes are not finished assets. Fully received bin/texture dependencies are reused within the import, not redownloaded because another file failed. **Permanent failures do not retry**: 404/403 and comparable 4xx, invalid format/size/address, redirects and missing dependencies fail immediately with reasons. Return to the source page rather than attempting to bypass the error. Received bytes from failed attempts still count toward the same budget.

## After import

1. Inspect hierarchy/originals/components with `scene_inspect`; the root name is the source asset name. Observe actual Viewer appearance before choosing another action.
2. **Assemble the requested form** through scene_edit transforms. Keep visual modules and derived collision aligned and jointly transformed. Confirm actual enclosure/form with observation or geometric measurement and explain which N modules from X were assembled; do not attribute the completed environment to the unassembled original.
3. Preserve factual product-generated source/licence/source-page/manifest/category tags and the PolyHaven downloaded-environment folder. Materialization retains original .gltf/.bin/textures under source/ plus manifest.json with source page/licence/author/categories/per-file md5/sha256. These delivery/audit artifacts must not be removed or altered.
4. **Collision derivation**: GLB objects imported through scene_import derive by default with usage=dynamic/strategy=auto; physicalizeStrategy accepts auto/convex_hull/voxel_boxes/coacd/triangle_mesh and physicalize:false skips. Update resource-default collision/rigidBody and include them on later resourceId mounting; inspect asset_list.physicalization.status. **World environments/buildings/ground/walls/openings use physicalizeUsage:'environment'** on scene_import/scene_import_url/scene_environment_import/scene_asset_acquire: do not fill interiors or hull-seal rooms/passages; assemble static bodies. Default representation is not fixed: measured hull-equivalent surfaces use exact geometry, watertight concave solids use convex decomposition and open shells use unfilled surface voxels. routed records decisions/reasons. voxel_boxes plus physicalizeVoxelSizeM fixes opening precision. convex_hull fails explicitly with status=failed instead of silently sealing cavities. scene_environment_import remains non-deriving by default; explicitly provide usage to derive. **Edit actual physics-instance roots so visuals/derived collision transform together.** Rework/customization uses asset_bake.request_json with method/strategy/material/usage/voxelSizeM; strategy="sdf" is available only through request_json and not the tool schema. method=triangle_mesh with usage=environment produces surface geometry; strategy=voxel_boxes produces real part boxes. Bind verified same-resourceId/version results through scene_bind_physics; never hand-copy collision.parts or paths. usage=environment alone, without method/strategy, follows strategy=auto and returns measured per-node cavity-preserving decisions/receipts. strategy takes precedence when method is also supplied. Ground/walls/columns have individual collision, never one closed whole-room hull.
   Receipts in asset_list/scene_inspect.physicalization include usage/strategy/derivedStrategy/nodes/parts/boxes/primitives/interiorPreserved/passageVerified/passageNote/selection/routed/voxelResolutionM/volumeRatios/cavityLostNodes/policy/voxelSizeM/attempts/supersedes. Changed usage/parameters publish new receipts with supersedes in separate `<usage>/<parameter-variant>/` directories; old Scene/ref bytes remain unchanged. Consumer convexification, such as concave triangle_mesh in MuJoCo, records cavityLostNodes and interiorPreserved:false. passageVerified:false and passageNote distinguish **inferred non-filling** from real passage tests: 0.25m voxels can quantize a 0.7m opening to 0.5m clearance, blocking a 0.5m body despite interiorPreserved=true. Choose margin from voxelResolutionM.
5. **Verify geometry and passage separately.** Images/geometric measurements check enclosure/layout; box grids/connectivity are proxy analyses. Doorway clearance, traversable area and robot passage require real same-generation engine/clearance/contact receipts. Unknown, convexified or overcoarse representations cannot pass from pictures/bounds alone. interiorPreserved is not passageVerified.
6. Reconcile pending/old-invalid refs with scene_reconcile_physics using the same-version published manifest. Failed derivations do not rebake by default; retryFailed:true requires explicit retry. scene_mount may join same-parameter in-flight derivation; read actual activation state rather than copying parts. After portable scene_save, confirm resolvable refs with asset_verify and no missing/changed entries; perform a minimal actual sim_open ground/collision check when needed, without claiming all-format validation.

## Required delivery information

Identify source asset/name/page/licence/actual category, whether assembled, which modules were used, measured geometry or actual observation (traversable area/enclosure/collision count), and **unverified items**. Do not describe a module display as an enclosed courtyard or substitute bbox size for measured geometry/observation.

Include the five prototype-check readings: form/ground contact/normals/materials/scale+units. Mark measured versus assumed and state assumption evidence. Record copied-instance count and relative-layout checks. A checked claim without readings is not a check.

## Boundaries

- Anonymous credential-free sources only. packages/blender/scripts/start_mcp.py enables blendermcp_use_polyhaven; Hyper3D/Hunyuan3D paid generation and credential/OAuth-based Poly Pizza/Sketchfab remain disabled. Do not use sources requiring credentials, payment or unclear authorization or purchase for the user.
- Connected Blender MCP, identified by LYAPUNOV_BLENDER_MCP_COMMAND and BLENDER_HOST/BLENDER_PORT, may use actually visible mcp__blender__* PolyHaven tools for the same assets. The normal path uses the three native tools above.
- Reuse existing DSH Agent/Session/LLM/Tools/Jobs/permissions and resource-authority. Do not create another agent loop, download-state owner, tool router or global asset registry.
