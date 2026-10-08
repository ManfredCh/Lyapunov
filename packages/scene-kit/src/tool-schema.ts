import type {ParameterSchemaSpec,ValueSchemaSpec} from '@deepseek-ai/dsh-tools'
import {PHYSICALIZATION_WORK_LIMITS,POINT_CLOUD_FULL_LIMITS} from './physicalization-parameters.ts'
const pointCloudTilingSchema:ValueSchemaSpec={type:'object',additionalProperties:false,description:"Explicit full-source environmental point-cloud sampling only. voxel_boxes retains its global box limit; triangle_mesh emits occupied-sample voxel boundaries, supported only by Isaac explicit static none. Mu rejects without engine switching. This is not reconstruction of the original point-cloud triangle surface.",properties:{coverage:{type:'string',const:'full',required:true},tileSizeCells:{type:'integer',required:true,description:"Fixed spatial tiles of 64 cells per side."},...Object.fromEntries(Object.entries(POINT_CLOUD_FULL_LIMITS).map(([key,limit])=>[key,{type:'integer',required:true,description:`Explicit full-domain aggregate budget 1..${limit}; not a per-tile allowance. The old whole-source limit is never automatically expanded.`}]))}}
export const physicalizationBudgetSchema:Record<string,ValueSchemaSpec>={voxelSizeM:{type:'number',description:"Explicit metre-scale sampling approximation. Full-domain tiling requires this value; .1m is not the .03m default and is not triangle reconstruction."},...Object.fromEntries(Object.entries(PHYSICALIZATION_WORK_LIMITS).map(([key,limit])=>[key,{type:'integer',description:`Bounded working budget 1..${limit}. For full-domain tiling, maxBoxes/maxOccupiedVoxels bound each tile's working set; the whole resource still has aggregate limits.`} as ValueSchemaSpec])),pointCloudTiling:pointCloudTilingSchema}
const physicalizationRequestSchema:ValueSchemaSpec={oneOf:[{type:'boolean',const:false},{type:'object',additionalProperties:false,properties:{usage:{type:'string',enum:['dynamic','static','environment']},strategy:{type:'string',enum:['auto','convex_hull','voxel_boxes','coacd','triangle_mesh','sdf']},...physicalizationBudgetSchema}}]}
export const sceneBindPhysicsParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,properties:{sceneId:{type:'string',required:true},entityId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},type:{type:'string',enum:['static','dynamic'],description:"Explicit instance motion type. type:static atomically commits fixing and geometry binding in one Scene CAS while retaining mass/gravity/other settings. Omitted type preserves the old type; environment usage never implicitly authorizes changing it. Isaac none requires an actually static body."},usage:{type:'string',enum:['dynamic','static','environment']},strategy:{type:'string',enum:['auto','convex_hull','voxel_boxes','coacd','triangle_mesh','sdf']},massKg:{type:'number'},...physicalizationBudgetSchema}}}
export const scenePhysicsUpdateParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,properties:{sceneId:{type:'string',required:true},entityId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},type:{type:'string',enum:['static','dynamic']},massKg:{type:'number'},gravityEnabled:{type:'boolean'},collisionEnabled:{type:'boolean'}}}}
export const sceneReconcilePhysicsParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer'},retryFailed:{type:'boolean',description:"Explicitly retry failed derivation. Default false only reconciles terminal state without rebaking large assets."},waitForPending:{type:'boolean',description:"Wait for existing work or cold-cache recovery; default false reports actual pending state."}}}}
const entityId={type:'string',required:true,description:"Stable entityId of an existing entity from scene_inspect or the current 3D selection."} as const
const edits:ValueSchemaSpec={type:'array',description:"Atomic edit array; use an array even when changing only one field.",items:{oneOf:[
  {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'update',required:true},entityId,changes:{type:'object',required:true,additionalProperties:false,properties:{name:{type:'string'},locked:{type:'boolean',description:"Lock or unlock transform editing. Submit unlocking separately before transform/reparent edits. Visibility and explicit deletion remain available."},transform:{type:'json',description:"Complete position[3], quaternion[4] and scale[3]; metres, Z-up, xyzw."},resources:{type:'array',items:{type:'json'}},components:{type:'json'}}}}},
  {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'add',required:true},entity:{type:'json',required:true,description:"Complete Entity: entityId, name, transform(position/quaternion/scale), resources array and components object, with optional parentId."}}},
  {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'remove',required:true},entityId,cascade:{type:'boolean'}}},
  {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'reparent',required:true},entityId,parentId:{type:'string',description:"Omit to move to the Scene root."}}},
]}}
export const sceneEditParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Submit a ScenePatch array using the observed revision. After a conflict, observe again before deciding; never silently substitute the latest revision.",
  examples:[{sceneId:'room',expectedRevision:3,patch:[{op:'update',entityId:'box',changes:{name:"New name"}}]}],
  properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},patch:{...edits,required:true}},
}}

export const sceneCreateParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Create a Scene. The default physics-workspace includes a locked zero-thickness infinite ground plane and gravity. blank is editing only; starting its first physics world prepares ground through Scene CAS.",
  properties:{sceneId:{type:'string',description:"Optional stable Scene ID."},name:{type:'string',description:"Optional display name."},template:{type:'string',enum:['blank','physics-workspace'],description:"Explicitly choose blank or a standard physics workspace; do not automatically append it to old scenes."}},
}}
export const scenePrepareWorkspaceParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,
 properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer',required:true}}}}
export const scenePrepareWorldParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,
 properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},ground:{type:'boolean',description:"Default true prepares ground once. Explicit false records disabled ground on an unprepared Scene."}}}}
export const sceneConfigurePhysicsParameters:ParameterSchemaSpec={input:{type:'object',required:true,additionalProperties:false,
 properties:{sceneId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},gravityWorldMps2:{type:'array',required:true,items:{type:'number'},description:"Three finite world-gravity components in m/s²; a zero vector is valid."}}}}

export const sceneInspectParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Read the Scene document and entity summaries.",
  properties:{sceneId:{type:'string',required:true,description:"Scene ID returned by scene_list."}},
}}

export const sceneOpenParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Read a Scene document. Pass the input object directly, not as a JSON-encoded string.",
  properties:{path:{type:'string',required:true,description:"Local scene.json path, either absolute or relative to the session task workspace, consistently with bash."},sceneId:{type:'string',description:"Optional Scene ID under which to import."}},
}}

/** Import can mount an entity in one operation while preserving provider-owned components. */
export const sceneImportParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Import a local asset and mount it directly when sceneId is provided. components preserves the robot/vehicle's actual control, sensor and engine mappings. With explicit transform.position, align the bounding-box bottom to that height by default; alignBottomToSurface:false disables this. GLB meshes derive collision after registration according to physicalizeUsage; environments/ground/walls use environment. Native MJCF/URDF robots use verified original geometry at the source reference pose for bottom alignment; this does not establish a policy standing pose. Pass alignBottomToSurface:false for exact model-origin placement.",
  properties:{
    path:{type:'string',required:true,description:"Local GLB/splat/MJCF/URDF path in the workspace, either absolute or relative to the session task workspace, consistently with bash."},
    sourceTexturePolicy:{type:'string',enum:['strict','available'],description:"Optional texture policy for OBJ/FBX sources. strict is default and rejects missing external dependencies. available explicitly chooses geometry and existing materials: preserve originals and available-dependency snapshots, list missing images/empty declarations, retain packed images and original colours, and do not guess geometry/material changes. Partial input never claims complete textures. Adding images and reimporting creates a new version."},
    sceneId:{type:'string',description:"Optional target Scene; mounting needs no subsequent scene_edit call."},
    name:{type:'string'},resourceId:{type:'string'},entityId:{type:'string'},parentId:{type:'string'},
    // ENV-20 最小承载：许可由调用方**显式声明**（可选）。不给就是 unknown——本工具不会替资产猜许可。
    license:{type:'object',additionalProperties:false,description:"Optional licence declaration: {id:\"CC0-1.0\",url?,attribution?}. Supply only with actual caller/manifest evidence. Missing declaration or id appears as unknown in asset_list.",
      properties:{id:{type:'string',required:true},url:{type:'string'},attribution:{type:'string'}}},
    source:{type:'object',additionalProperties:false,description:"Explicit known original units/source-coordinate declaration; never infer orientation from collision results.",properties:{units:{type:'string',required:true},upAxis:{type:'string',required:true,enum:['X','Y','Z']},handedness:{type:'string',required:true,enum:['left','right']},metersPerUnit:{type:'number'}}},
    transform:{type:'object',additionalProperties:false,properties:{position:{type:'array',items:{type:'number'}},quaternion:{type:'array',items:{type:'number'}},scale:{type:'array',items:{type:'number'}}}},
    alignBottomToSurface:{type:'boolean',description:"Optional, default true. With transform.position, align the entity bounding-box bottom to that height. false places the entity origin exactly there. Without usable prototype bounds, default copying fails with PROTOTYPE_BOUNDS_UNAVAILABLE instead of assuming form/bottom/scale; verify the original or explicitly pass false and take responsibility for placement."},
    physicalizationRequest:{...physicalizationRequestSchema,description:"Structured derivation intent with working/full-domain budgets. Use either this or the legacy physicalize/physicalizeUsage/Strategy/Voxel fields, not both. Every explicit parameter participates in cache identity."},
    physicalize:{type:'boolean',description:"Optional; GLB meshes default true, while PLY/splat does not automatically bake. Explicit true/physicalizeUsage/physicalizeStrategy lets XYZ PLY use the same queue to derive actual occupied-sample voxel boxes, default environment/static body; SPZ/SOG without a coordinate-decoding path fails explicitly. GLB derivation updates collision/rigidBody resource defaults used by later resourceId mounting. Read asset_list physicalization status/usage/strategy/derivedStrategy/nodes/parts/boxes/primitives/interiorPreserved/passageVerified/passageNote/selection/routed/voxelResolutionM/volumeRatios/cavityLostNodes/attempts. interiorPreserved follows actual per-node representation; reroutes/convexification appear in routed/cavityLostNodes. passageVerified is always false because this tool does not measure clearance/connectivity; cavity preservation does not prove passage, and voxelResolutionM/volumeRatios report approximation. Derivation is asynchronous; mounting with sceneId may initially lack collision. Wait for status=ok, then scene_mount to include it. false skips."},
    physicalizeUsage:{oneOf:[{type:'string',const:'dynamic'},{type:'string',const:'static'},{type:'string',const:'environment'}],description:"Optional derivation usage; default dynamic for props, using measured cavities to select hull/CoACD/voxels and assembling a dynamic body. static derives a fixed body and uses the same unfilled surface default as environment. environment represents ground/walls/openings/buildings without filling interiors or sealing rooms/passages, assembling static bodies. The default does not fix representation: choose measured hull-equivalent source surfaces or unfilled surface voxel boxes for every other triangle surface, including concave, reversed and touching closed shells. All source triangles participate at the reported voxel precision; fixed precision and hard budgets are preserved. Record reroutes/reasons in routed. Explicit strategy exports as requested and reports consumer losses through cavityLostNodes/interiorPreserved=false; convex_hull/sdf are explicitly rejected as failed."},
    physicalizeStrategy:{oneOf:[{type:'string',const:'auto'},{type:'string',const:'voxel_boxes'},{type:'string',const:'coacd'},{type:'string',const:'triangle_mesh'},{type:'string',const:'convex_hull'}],description:"Optional forwarded physicalization strategy; default auto means no fixed representation. dynamic chooses hull/decomposition/voxels from measured cavities; static/environment selects measured hull-equivalent source surfaces or unfilled surface voxel boxes per node. Explicit strategy exports as requested and receipts disclose consumer losses, such as concave triangle_mesh convexification by MuJoCo sealing doorways, with cavityLostNodes/interiorPreserved=false. environment rejects convex_hull/sdf. Manual rework/customization still uses asset_bake."},
    physicalizeVoxelSizeM:{type:'number',description:"Optional metres: fixed surface-voxel edge length, meaningful only for voxel_boxes. For environments this prevents passage precision across openings/multiple surfaces from drifting with model scale."},
    components:{type:'object',additionalProperties:true,description:"Provider capability mappings, such as controller, sensor, mujoco and isaac."},
    sceneGeometryBinding:{type:'object',additionalProperties:true,description:"Optional splat-to-collision-mesh binding under the scene-geometry contract: splat/mesh paths+sha256, column-major meshToSplat, alignmentStatus, method and revision. Import owns authoritative parsing; hash disagreement with actual originals downgrades to candidate and excludes physics."},
  },
}}

/**
 * scene_mount 是把资源库里已有资源放进场景的唯一入口；字段按 operations.mount 的实际读取面
 * 写全（sceneId/resourceId/version/entityId/parentId/transform/components），多于实现读取的
 * 字段一律不写，避免 schema 说谎。
 */
export const sceneMountParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Mount a registered resourceId, obtained from asset_list, as a Scene entity. Omitted components use registered componentDefaults such as robot controller. Explicit components replaces defaults by whole component key for this instance only, without changing resource defaults. Explicit transform.position aligns the bounding-box bottom to that height unless alignBottomToSurface:false. Native robots use verified original reference-pose geometry for bottom alignment; pose-specific standing or feet support requires separate physical evidence. Pass alignBottomToSurface:false for exact model-origin placement.",
  examples:[{sceneId:'room',resourceId:'res_arm',version:3,entityId:'arm-1',transform:{position:[1,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}}],
  properties:{
    sceneId:{type:'string',required:true,description:"Target Scene ID."},
    resourceId:{type:'string',required:true,description:"Stable resource ID returned by asset_list."},
    version:{type:'integer',description:"Optional resource version; omitted uses the current version."},
    entityId:{type:'string',description:"Optional new entity ID; generate one when omitted."},
    parentId:{type:'string',description:"Optional existing parent entity; omitted mounts at the Scene root."},
    transform:{type:'object',additionalProperties:false,properties:{position:{type:'array',items:{type:'number'}},quaternion:{type:'array',items:{type:'number'}},scale:{type:'array',items:{type:'number'}}}},
    alignBottomToSurface:{type:'boolean',description:"Optional, default true. With transform.position, align the entity bounding-box bottom to that height. false places the origin exactly there. Without usable prototype bounds, default copying fails with PROTOTYPE_BOUNDS_UNAVAILABLE instead of assuming form/bottom/scale; verify the original or explicitly pass false and take responsibility for placement."},
    components:{type:'object',additionalProperties:true,description:"Provider capability mappings, such as controller, sensor, mujoco and isaac."},
  },
}}

/**
 * scene_replace_resource 是局部替换（ENV-29）的唯一入口，字段按 operations.replaceResource 的实际读取面
 * 写全：sceneId/entityId/expectedRevision/resourceId/version/fromResourceId/fromVersion。
 * fromResourceId/fromVersion 只用于"实体上有多条不同引用时指定要换掉哪一条"，不是通用来源版本查询；
 * 描述里写清派生组件（collision/rigidBody/controller）按几何事实保留或重派生、机器人原生派生的那些
 * 仍然不支持，避免模型在物理/机器人实体上反复试错，也避免它以为"带碰撞就只能重建挂载"。
 */
export const sceneReplaceResourceParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Replace one ResourceRef on an existing entity with another registered resource version. Preserve entityId/name/pose/parentage/user components; do not add/remove entities or change other instances/independent references. Read scene_inspect revision and asset_list resourceId/version first; select fromResourceId/fromVersion when multiple references exist. For material/texture visual updates on collision/rigidBody/controller entities, preserve derivations only when both originals have identical per-node static geometry: local metre vertex positions and triangle multisets including node/ancestor transforms and source-coordinate conversion, matching the actual display. Geometry changes, including internal pose/scale, require the target resource's registered derived defaults; missing derivation reports REPLACE_RESOURCE_PHYSICS_NOT_DERIVED rather than reusing stale collision. Unverifiable static geometry such as compression/skinning/driving animation reports REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE without writes. Native robot articulation/mujoco/isaac/visual.robot is rejected: rebuild with scene_mount. Operate on an expanded GLB group root; unsupported structure/node-local-transform/source-coordinate changes also require rebuilding mounting.",
  examples:[{sceneId:'room',entityId:'tree-1',expectedRevision:7,resourceId:'res_tree',version:2}],
  properties:{
    sceneId:{type:'string',required:true,description:"Target Scene ID."},
    entityId:{type:'string',required:true,description:"Existing entity whose reference is replaced. Expanded GLB groups must use the group root, not derived :node:N or :source nodes."},
    expectedRevision:{type:'integer',required:true,description:"Revision observed through scene_inspect before dispatch. Stale values conflict immediately; never automatically use the latest version."},
    resourceId:{type:'string',required:true,description:"Target resource ID, the stable ID returned by asset_list."},
    version:{type:'integer',description:"Optional target resource version; omitted uses the current version."},
    fromResourceId:{type:'string',description:"Optional resourceId of the specific reference to replace when the entity has multiple references."},
    fromVersion:{type:'integer',description:"Optional version paired with fromResourceId to select the reference being replaced."},
  },
}}

/** scene_save 读 sceneId/path 与可选 portable/projectFiles（operations.save）；portable 复制资源依赖、原件保持不变。 */
export const sceneSaveParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Atomically save the Scene. portable:true copies dependencies to the destination while retaining originals, yielding portable scene.json. Include external textures/linked libraries of .blend originals; rewrite absolute paths only in copies without changing original bytes.",
  properties:{
    sceneId:{type:'string',required:true,description:"Scene ID returned by scene_list."},
    path:{type:'string',required:true,description:"Local destination path for scene.json."},
    portable:{type:'boolean',description:"Optional; true copies resource dependencies."},
    projectFiles:{type:'array',items:{type:'string'},description:"Optional, portable only: explicit user project files such as modelling scripts/reference images/textures. Resolve relative paths against the scene.json destination directory; mirror under bundled project/ while preserving their relative hierarchy."},
    sinceRevision:{type:'integer',description:"Optional existing earlier revision. Include a changeset of added/updated/removed entity IDs/counts between sinceRevision and current, comparing fields per entity rather than timestamps. The main export remains complete and each on-disk revision is immutable: the store rejects changing bytes for an existing revision. scene_open must read it directly."},
    diffPath:{type:'string',description:"Optional with sinceRevision: write changeset JSON containing only changed entities to this local path, relative to the scene.json destination directory, for incremental consumer application. It is much smaller than a full document for the same change. Without sinceRevision, report DIFF_REQUIRES_SINCE_REVISION rather than guessing a baseline."},
  },
}}

/**
 * scene_align 的字段按 `operations.align` 的真实读取面写全（`operations.ts:727`）：
 * sceneId/entityId/expectedRevision 与各三个 sourcePoints/targetPoints（点集是米制 [x,y,z]）。
 * 修前它落在定义表末尾的 `{input:{type:'json'}}` 兜底上：那种 schema 只能声明"input 必须存在"，
 * 属性级必填在派发时无从强制，于是 `scene_align({input:{}})` 直接把
 * `undefined is not an object (evaluating 'input.sourcePoints.length')` 漏进模型回执（L381 实测）。
 * 「三个点」与「非共线」是**值语义**（`ALIGN_REQUIRES_THREE_POINTS` / `ALIGN_COLLINEAR_POINTS`），
 * 仍由 operation 自己判——schema 只表达"哪些字段必须给、是什么类型"，不说谎也不越权。
 */
export const sceneAlignParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Align an entity pose with three noncollinear points in each frame. sourcePoints are measured in the entity's current pose; targetPoints are the corresponding destinations. Coordinates are metres, Z-up. The operation validates count/noncollinearity; fewer/more than three or degenerate points are rejected.",
  examples:[{sceneId:'room',entityId:'box-1',expectedRevision:3,sourcePoints:[[0,0,0],[1,0,0],[0,1,0]],targetPoints:[[0,0,0],[0,1,0],[-1,0,0]]}],
  properties:{
    sceneId:{type:'string',required:true,description:"Scene ID returned by scene_list."},
    entityId:{type:'string',required:true,description:"Entity to reposition, from scene_inspect or the current 3D selection."},
    expectedRevision:{type:'integer',required:true,description:"Revision observed through scene_inspect before dispatch. Stale values conflict immediately; never automatically use the latest version."},
    sourcePoints:{type:'array',items:{type:'array',items:{type:'number'}},required:true,description:"Three noncollinear reference [x,y,z] points in metres, measured in the entity's current pose."},
    targetPoints:{type:'array',items:{type:'array',items:{type:'number'}},required:true,description:"Three noncollinear target [x,y,z] points in metres, corresponding one-to-one with sourcePoints."},
  },
}}

/**
 * asset_list is called by the language agent as a normal structured tool. Keep
 * its filter fields explicit so a generated object cannot accidentally reach
 * ResourceLibrary.list and fail while normalising query text.
 */
export const assetListParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  properties:{
    query:{type:'string',description:"Optional resource-name/tag search keyword."},
    folder:{type:'string',description:"Optional resource folder."},
    includeDeleted:{type:'boolean',description:"Whether to include trashed resources."},
    allVersions:{type:'boolean',description:"Whether to return every version of each resource."},
  },
}}

/** asset_verify 读 resourceId/version 两个字段（operations.resources.verify）。 */
export const assetVerifyParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Check whether a resource's current original and dependencies are missing or changed.",
  properties:{
    resourceId:{type:'string',required:true,description:"Stable resource ID returned by asset_list."},
    version:{type:'integer',description:"Optional resource version; omitted checks the current version."},
  },
}}

/** 公开环境资产：检索 → 核对尺度 → 下载导入；三步都由自然语言需求驱动。 */
export const sceneEnvironmentSearchParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Search the public PolyHaven CC0-1.0 environment-asset catalog by natural-language requirements without credentials. Return candidate metadata only; do not download.",
  examples:[{query:'indoor courtyard architecture environment',limit:6}],
  properties:{
    query:{type:'string',description:"Natural-language requirements, such as indoor warehouse / courtyard / forest terrain."},
    categories:{oneOf:[{type:'array',items:{type:'string'}},{type:'string'}],description:"Optional category filters, such as buildings, structures or nature."},
    limit:{type:'integer',description:"Candidate count, 1-20; default 8."},
  },
}}

export const sceneEnvironmentDetailParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Inspect a candidate's original download manifest (url/size/md5), total bytes, triangles, meshes, materials/textures, actual category such as Facades & Modules, source tags/author and visual sizeM bounds in metres. These are source-file/catalog facts: sizeM/categories/tags do not establish a complete or directly usable environment. Actual downloaded observation and assembly determine usability.",
  properties:{
    assetId:{type:'string',required:true,description:"assetId returned by scene_environment_search."},
    resolution:{oneOf:[{type:'string',const:'1k'},{type:'string',const:'2k'},{type:'string',const:'4k'},{type:'string',const:'8k'}],description:"Texture resolution; default 1k."},
  },
}}

export const sceneEnvironmentImportParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  description:"Download the public environment asset: transfer .gltf and dependencies through the same safe transport, enforcing aggregate actual bytes and per-file md5/byte verification, then assemble a self-contained GLB into the Scene ResourceLibrary. sceneId mounts directly. Retain originals and a manifest with source-page/licence/author/category/file-hash facts in an isolated dataRoot; tags record facts only. Observation and assembly determine whether it becomes an environment; modules need assembly, collision and a Sim self-check before delivery.",
  properties:{
    assetId:{type:'string',required:true},
    resolution:{oneOf:[{type:'string',const:'1k'},{type:'string',const:'2k'},{type:'string',const:'4k'},{type:'string',const:'8k'}]},
    sceneId:{type:'string',description:"Optional target Scene; mounting needs no subsequent scene_edit call."},
    name:{type:'string'},resourceId:{type:'string'},entityId:{type:'string'},parentId:{type:'string'},
    transform:{type:'object',additionalProperties:false,properties:{position:{type:'array',items:{type:'number'}},quaternion:{type:'array',items:{type:'number'}},scale:{type:'array',items:{type:'number'}}}},
    maxBytes:{type:'integer',description:"Optional download limit; default and maximum 64MiB."},
    folder:{type:'string',description:"Resource folder; defaults to the product's downloaded-environment folder for PolyHaven."},
    physicalize:{type:'boolean',description:"Optional, default false. This entry does not automatically derive collision because dynamic derivation fills cavities. true without physicalizeUsage uses dynamic, appropriate only for acquired individual props/furniture."},
    physicalizeUsage:{oneOf:[{type:'string',const:'dynamic'},{type:'string',const:'static'},{type:'string',const:'environment'}],description:"Optional derivation usage; supplying it enables automatic derivation. Acquired environments/buildings/ground use environment without interior filling or hull-sealed passages. The default selects per-node hull-equivalent surfaces, unfilled surface voxel boxes for all other triangle surfaces, including concave, reversed and touching closed shells; record reroutes/reasons in physicalization.routed. Derivation is asynchronous and is usually pending on return. Wait for asset_list status=ok, then scene_mount to include collision."},
    physicalizeStrategy:{oneOf:[{type:'string',const:'auto'},{type:'string',const:'voxel_boxes'},{type:'string',const:'coacd'},{type:'string',const:'triangle_mesh'},{type:'string',const:'convex_hull'}],description:"Optional forwarded physicalization strategy. Explicit strategies export as requested and receipts report consumer limitations. environment rejects convex_hull/sdf."},
    physicalizeVoxelSizeM:{type:'number',description:"Optional metres: fixed surface-voxel edge length, meaningful only for voxel_boxes."},
  },
}}

/** Resource Authority 管理命令的最小身份/CAS 合同。 */
export const resourceAuthorityParameters:ParameterSchemaSpec={input:{
  type:'object',required:true,additionalProperties:false,
  properties:{
    resourceId:{type:'string',required:true}, category:{description:"Authority category: background, scene, robot or object.",oneOf:[{type:'string',const:'background'},{type:'string',const:'scene'},{type:'string',const:'robot'},{type:'string',const:'object'}]}, operationID:{type:'string',description:"Operation ID for retry/audit."},
    idempotencyKey:{type:'string',description:"Replaying the same command returns the original result."},
    expectedRegistryRevision:{type:'string',description:"sha256:<64> CAS revision obtained from reading the authority snapshot."},
    targetPath:{type:'string',description:"New local destination path for asset_move."}, path:{type:'string',description:"Compatibility alias for targetPath."},
    name:{type:'string'}, tags:{type:'array',items:{type:'string'}}, folder:{type:'string'}, deleted:{type:'boolean'},
  },
}}
