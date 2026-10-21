import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simWorldsFor, type SimAction } from '../../sim-contract/src/index.ts'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import { requireWritableScene, sceneOperationsFor } from '../../scene-kit/src/plugin.ts'
import { entityWorldMatrix } from '../../scene-kit/src/physics-binding.ts'
import { localPath, robotVisual } from '../../scene-kit/src/formats.ts'
import { deriveRobotSubtree, inspectRobotSubtreeResource } from '../../scene-kit/src/subtree-extract.ts'
import { Matrix3, Vector3 } from 'three'
import { createRobotOperations, type SceneReader } from './operations.ts'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import { executePolicy } from '../../policy-registry/src/execution.ts'
import { resolveCallerOutputDir } from './output-path.ts'
import { cameraAnalysisScope, cameraFamilyScope, lidarScope, robotToolParameters, singleCaptureScope } from './tool-schema.ts'

/**
 * 单张真实 PNG → Host 附件服务。返回可见回执字段 `rgbAttachment` 与（成功时的）附件引用。
 * - 只读真实 file:// PNG 且媒体类型必须是 image/png；
 * - 只有附件服务完整解码通过（attachments.saveImage）才算成功；
 * - 任何失败都返回 `{ attached: false, reason }`，不伪造图片。
 */
async function attachOneRgbPng(ctx: Context, rgb: unknown, hint: string): Promise<{ rgbAttachment: Record<string, any>; ref?: any }> {
  const failed = (reason: string) => ({ rgbAttachment: { attached: false, reason } })
  if (rgb === null || typeof rgb !== 'object' || typeof (rgb as any).uri !== 'string' || (rgb as any).mimeType !== 'image/png') {
    return failed(`${hint} 没有可附件化的真实 RGB PNG（rgb.uri / rgb.mimeType 缺失或不符）`)
  }
  const attachments = ctx.get('attachments')
  if (!attachments) return failed('当前 Host 未挂载附件服务，RGB 只保留磁盘产物')
  let path: string
  try { path = fileURLToPath((rgb as any).uri) }
  catch { return failed(`${hint} 的 rgb.uri 不是可解析的 file:// 路径：${(rgb as any).uri}`) }
  if (!existsSync(path)) return failed(`${hint} 的 RGB 文件不存在：${path}`)
  let data: Buffer
  try { data = await readFile(path) }
  catch (error) { return failed(`${hint} 的 RGB 文件不可读：${error instanceof Error ? error.message : String(error)}`) }
  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(path) })
    return {
      rgbAttachment: {
        attached: true, attachmentId: ref.attachmentId, mediaType: ref.mediaType,
        bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name ?? basename(path),
      },
      ref,
    }
  } catch (error) {
    return failed(`${hint} 的附件提交被拒绝：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 把 sensor_capture 的 RGB 产物作为真实图片附件提交给模型工具结果。
 * - 只读 `rgb.uri` 指向的真实 PNG（媒体类型必须是 image/png），深度 .npy 永不附件化；
 * - 只有附件服务完整解码通过才算附件化成功（attachments.saveImage 会校验图像）；
 * - 任何失败都如实写在可见字段 `rgbAttachment` 上，不伪造图片、不改原有元数据。
 */
async function attachSensorRgb(ctx: Context, value: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value
  const result = value as Record<string, any>
  const { rgbAttachment, ref } = await attachOneRgbPng(ctx, result.rgb, '结果')
  return ref === undefined ? { ...result, rgbAttachment } : { ...result, rgbAttachment, __rgbAttachment: ref }
}

/**
 * 单次工具结果最多附件化的相机图片数：多视角采集允许最多 16 台相机，全量附图会挤占模型上下文。
 * 超出上限的相机不静默丢弃——磁盘产物照常保留，可见字段里逐条给出未附图原因。
 */
const MAX_TOOL_RESULT_IMAGES = 8

/**
 * 把 camera_capture_multi 的逐相机 RGB 产物作为真实图片附件提交给模型工具结果。
 * - 每个相机条目独立附件化（同一 `attachOneRgbPng`：真实 PNG + 附件服务完整解码）；
 * - 逐相机 `rgbAttachment` 如实记录成功/失败原因，顶层 `rgbAttachments` 给出汇总与上限；
 * - 深度 .npy 永不附件化；同一帧的标定/时间戳字段原样保留。
 */
async function attachMultiCameraRgb(ctx: Context, value: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value
  const result = value as Record<string, any>
  const cameras = Array.isArray(result.cameras) ? result.cameras : null
  if (cameras === null) {
    return { ...result, rgbAttachments: { attached: false, count: 0, requested: 0, limit: MAX_TOOL_RESULT_IMAGES, reason: '结果里没有多相机数组 cameras[]（该工具应返回 camera_capture_multi 的逐相机结果）' } }
  }
  const annotated: any[] = []
  const refs: any[] = []
  for (const [index, entry] of cameras.entries()) {
    if (entry === null || typeof entry !== 'object') {
      annotated.push({ cameraName: null, rgbAttachment: { attached: false, reason: `cameras[${index}] 不是对象` } })
      continue
    }
    const camera = entry as Record<string, any>
    if (refs.length >= MAX_TOOL_RESULT_IMAGES) {
      annotated.push({ ...camera, rgbAttachment: { attached: false, reason: `单次工具结果最多附图 ${MAX_TOOL_RESULT_IMAGES} 张，该相机只保留磁盘产物（RGB/深度/标定照常返回）` } })
      continue
    }
    const { rgbAttachment, ref } = await attachOneRgbPng(ctx, camera.rgb, `cameras[${index}]（${camera.cameraName ?? '未命名'}）`)
    if (ref !== undefined) refs.push(ref)
    annotated.push({ ...camera, rgbAttachment })
  }
  const summary = {
    attached: refs.length > 0,
    complete: refs.length === cameras.length,
    count: refs.length,
    requested: cameras.length,
    limit: MAX_TOOL_RESULT_IMAGES,
    depthAttached: false,
  }
  return refs.length === 0
    ? { ...result, cameras: annotated, rgbAttachments: summary }
    : { ...result, cameras: annotated, rgbAttachments: summary, __cameraAttachments: refs }
}

/** 附件化出口：只有相机工具族的返回值需要经过附件服务，其余工具原样返回。 */
function attachToolResult(name: string, ctx: Context, value: unknown): Promise<unknown> {
  if (name === 'sensor_capture') return attachSensorRgb(ctx, value)
  if (name === 'camera_capture_multi') return attachMultiCameraRgb(ctx, value)
  return Promise.resolve(value)
}

/** 工具结果的模型可见内容：默认是原样文本 JSON；相机工具附件化成功时追加 image 内容块。 */
function renderRobotToolValue(toolName: string, value: unknown): ContentBlock[] {
  if ((toolName !== 'sensor_capture' && toolName !== 'camera_capture_multi') || value === null || typeof value !== 'object') {
    return [{ type: 'text', text: JSON.stringify(value) }]
  }
  const { __rgbAttachment: attachment, __cameraAttachments: attachments, ...visible } = value as Record<string, any>
  const blocks: ContentBlock[] = [{ type: 'text', text: JSON.stringify(visible) }]
  if (Array.isArray(attachments)) {
    for (const ref of attachments) blocks.push({ type: 'image', attachment: ref })
  } else if (attachment) {
    blocks.push({ type: 'image', attachment })
  }
  return blocks
}

export const name = 'lyapunov-robot-tools'
export const inject = ['tools', 'commands', 'scene', 'sim']
const descriptions: Record<string, string> = {
  sim_set_paused:"Pause or resume the current world's actual physics clock without closing the world, editing the Scene, or rebuilding generation. paused=true pauses and false resumes; supply the exact expectedGeneration. Use sim_stop to stop actions.",
  sim_open: "Create a real simulation world from the Scene document and return worldId and model generation. Before the first world, persist manageable infinite ground through Scene CAS, preserving removed/disabled choices and existing workspaces. Verified native ground avoids duplicate template colliders. ground=false records explicit disabled ground only on an unprepared Scene.",
  sim_world_list: "Read all currently open simulation worlds. Each entry includes worldId, engineId/engineVersion, worldGeneration, sceneId/appliedSceneRevision, status/clock/timestepS. Other already-open worlds, including UI-created worlds, are discoverable. Do not implicitly select a Viewer world. Return an empty list when none exist; a world disappears after sim_close.",
  sim_sync: "Synchronize the specified Scene revision into a world and return the revision actually loaded.",
  sim_reset: "Stop all actions in the current world, then rebuild that same world from the current Scene declarations and initial source joint state, updating generation. Do not edit the Scene. Reset all instances and free bases together. Require the exact current revision/generation, preserve existing world options, and return the corresponding native Frame.",
  sim_close: "Close the simulation world and release all model handles.",
  robot_load: "Create or load an ordinary robot entity and synchronize it. Registration, Chinese-language memory, or LLM permission is not a prerequisite.",
  robot_describe: "Read all robot joints, actuators, units, SI control configuration, and current generation. tendonActuators exposes source tendon-actuator channels, preserving coordinate=Σ coef·q and gear/gain/bias/force/ctrlrange. Tendon-driven joints identify that source in joints[].tendonActuators; do not fabricate controlledJointNames. capabilities lists availability and reasons for joint/vehicle/gripper/lift/control/thrust/gait/tendon, with error codes and explanations derived from the same rejection logic as execution-side prepare. Joint entries include controlledSource. When source joint/actuator metadata cannot be verified (URDF or native USD), conservatively leave controlledJointNames empty and omit per-joint controlMode; top-level controlMetadata explains why. Do not infer control from all DOFs or default to position. gripper/lift require articulation, the corresponding controller mapping, resolvable non-passive joints. control additionally requires a manual clock and joint-level actuators whose mode is not velocity. An entity without joints has no joint channel. Read thrust availability, the four mapped source actuators, the site's free-root body, source mass, and ctrlrange/forcerange only here. Without real actuator metadata, available=false; do not substitute constants. freeBases lists free roots observed in robot_state.sensors.freeBase, including source-declared massKg; these are not controlled joints. Provider boundaries: Isaac supplies the most complete capabilities, joints[].controlledSource, and top-level controlMetadata. MuJoCo does not provide those three fields. Newton reports all eight contract capability kinds. XPBD supports joint/trajectory/control only for verified single-DOF source position PD drives with gear=1 and no unsupported activation/plugin/actuator mixing or source force limits; control additionally requires a manual clock. Read per-world availability and rejection reasons here and in WorldHandle.capabilities; worlds without supported drives have no action/manual-advance channel. MPM water uses realtime with fixed/static colliders and has no robot actions, rigid-body Contacts or manual advancement. Newton omits joints[].controlledSource; controlledJointNames comes only from verified drives, and controlMetadata explains unavailable drives. / Newton 按真实世界返回八种能力；XPBD 仅支持已核验单自由度源位置 PD 的 joint/trajectory/control，gear=1，activation/plugin/多执行器混合/源力限等不支持，control 还要求 manual。无已支持驱动的世界没有动作或手动推进通道。MPM 水例使用 realtime 和固定/静态 collider，没有机器人动作、刚体 Contacts 或手动推进；以实际能力读回和拒绝原因为准。 Missing fields do not imply availability. Completing them belongs to each Provider's implementation scope.",
  robot_set_tcp: "Select a real end-effector TCP from robot_describe nativeBodies/nativeSites, save it in the current Scene.controller.tcp, then synchronize the same world and return a Frame for that revision. Choose either a site or a custom body-local offset. For an ordinary Panda model without a site, explicitly select the hand origin/offset instead of fabricating an official site. clear:true removes the configuration. A missing mapping can also be configured in the manual sidebar; do not download a policy.",
  robot_presets: "Read this revision's actual body/site data, configured TCP, source base, uncovered native MJCF/USD cameras, and Scene installation baseline. Without a preset, return body/site candidates and manual-calibration reasons. Do not guess a wrist offset or claim an official TCP for a Panda model without a site. Apply through robot_set_tcp or camera_scene_save using the same Scene contract.",
  robot_set_base: "Edit the actual root base. free removes this instance's fixed constraint while preserving internal joints; fixed anchors it to the world or a real body-local anchor on another entity; source restores the original model declaration. First read base.editable/nativeBodies through robot_describe and verify source/importer/actual constraint provenance. No freejoint means fixed to the world, not welded to the floor; parentId is not a physics binding. Use the same Scene CAS, sim_sync, and native Frame flow as the manual sidebar. Reject unsupported layouts/engines explicitly. On success returns status/snapshot/world/frame and, when the binding changed, assembly{field,beforeRevision,afterRevision,before?,after?} where a side that did not exist is omitted from the result (never undefined, never null, so the whole result stays lossless JSON). If the Scene commit succeeds but sync/readback fails, it returns saved:true with syncRequired:true, the exact revision/world/generation, and reason; it never reports a rollback or a synced result.",
  robot_assembly_preview: "Read-only assembly preview for attaching a source part/tool (for example an independent hand) to a target robot body. Resolve the source real-root body and the target real body/site through robot_describe and the same-identity native Frame, then compute T_targetBody_sourceRoot = T_targetBody_targetMount · T_pair · inverse(T_sourceRoot_sourceMount) in metres and normalized xyzw. Returns the two resolved mounts, the frame identity (scene/revision/world/generation), and applyInput that can be passed unchanged to robot_set_base; status is PREVIEW / not applied. It never commits the Scene, syncs, starts or steps the world and never uses exploded-view offsets. Rejects missing targets, self-binding/cycles, a source mount that is not root-fixed, and invalid poses with zero Scene writes. Example: preview attaching hand-1 (palm-back pose) to panda-1 attachment_site, then apply the returned applyInput via robot_set_base.",
  robot_assembly_history: "Read the existing Scene history and list assembly binding changes (baseBinding / controller.tcp) for one entity, newest first. Each entry gives beforeRevision/afterRevision of full immutable snapshots, the touched field, its before/after value (a side that did not exist is omitted, never undefined and never null), undoable, any Replace membership marker, and a reason when not undoable. Replacements groups both sides of one Replace by shared operationId, so the same multi-entity undo is discoverable after reopening from disk. Reuses the current SceneStore history; it does not create a second history. Missing versions are explicit, never guessed.",
  robot_assembly_mount: "Save, read, or clear one source installation face for an entity as narrow Scene metadata (components.assemblyMount), bound to the entity's current resourceId/resourceVersion and source root body. site/body-origin require a real source body proven fixed relative to the root (verified through robot_describe when worldId is supplied); an explicit pose must be a valid metres/normalized-xyzw transform and names its source root body. Omitting save and clear is a pure read query: it keeps session ownership and expectedRevision checks and stays available in read-only sessions; only save/clear is a persistent write. Reading returns the recorded mount and marks it stale when the current resource version no longer matches. It does not create a point database or write localStorage; the same metadata is discoverable by the LLM and reused by robot_assembly_preview.",
  robot_assembly_check: "Read-only assembly check/readback. Reports the saved baseBinding declaration separately from the current native facts: the source root body world pose, the target-body-local relative pose, current joints (names/positions), the exact frame identity, and any contact/action receipt only when actually read. Missing world/sync or stale frames leave the corresponding checked.* flag false with an explicit reason; it never reports compatibility or motion success without evidence. It also derives the target-body external attachment list from baseBinding (Scene.parentId is not a physics binding).",
  robot_assembly_replace: "Replace an already independent external end-effector: fix the new entity's root to a real target body and move the old entity to an explicit parking pose that leaves the mount (explicit free uses the same pose as its initial world pose), all in one narrow multi-entity Scene CAS and one sync. The old entity must currently be fixed to the requested target entity/body; oldBodyName must equal the current native real root; the newBase target and parking pose must be valid metres/normalized-xyzw transforms (zero quaternions, non-finite numbers and invalid vectors are rejected before any write); new/old/target description generations, scene/world/appliedRevision, Frame and resource identity are all rechecked after every await and before commit; a parking pose that still coincides with the mount is rejected so the old and new part never overlap. Both fields are returned as changes carrying the same operationId, and the marker is persisted in components.assemblyReplace so robot_assembly_history discovers both sides and robot_assembly_undo restores the group protected against later edits. It never claims an internal non-root part was extracted; R-013 internal extraction remains separate.",
  robot_assembly_extract_precheck: "Read-only internal-subtree extraction precheck (R-013). Given one entity and a real internal body name from robot_describe.nativeBodies, list both sides' bodies/joints/actuators/tendons/equalities/sensors and the asset closure, and every cross-cut reference (tendon/equality/actuator/sensor/contact-exclude/mimic/transmission). It does not trust file extensions or mesh names: USD (registered as kind=source) and other formats without a structural body/link projection return a named unsupported result. Zero Scene writes and zero resource registration; a cross-cut dependency is reported with the concrete objects and refuses extraction.",
  robot_assembly_extract: "Really split one internal body subtree into two new resources in one Scene CAS: the remaining instance switches to a new version of the same resourceId (subtree removed) and a new independent part entity is added with its own resource. The cut pose is read only from the current same-identity native Frame; root/model coordinates are never mixed. Both derived resources are produced by the installed MuJoCo 3.13 MjSpec with the full asset closure copied and reloaded outside the original directory; the original file and every old resource version stay unchanged. The pair is recorded in components.subtreeExtract with one operationId plus source resourceId/version/SHA, cut body/parent, cut joint and joint/control maps, so robot_assembly_history and robot_assembly_undo find and protect it after reopening. Controller/sensor mappings addressed by joint name move to the side owning those joints; a mapping spanning the cut is rejected instead of silently split. Requires a synced world.",
  robot_assembly_reassemble: "Restore an explicitly paired extraction (R-013) to the original resource version and remove the independent part entity in one Scene CAS and one sync. Because the original model is restored, the cut joint, control and sensor semantics are preserved verbatim; a fixed weld is never substituted for a movable cut joint. Refused when either side's resource or pairing marker was materially changed later; unrelated edits and other entities are preserved.",
  robot_assembly_undo: "Local undo of one recorded assembly binding change: verify the current value still equals that entry's after value and the entity/resource identity is unchanged, then CAS the current Scene revision to restore only that touched field (preserving later unrelated edits and other entities). Refuses with ROBOT_ASSEMBLY_CONFLICT when the binding was edited later; never copies a whole Scene version over current. When worldId names an open world, sync/readback the new revision; when the world is unavailable, restore the declaration and return saved:true with syncRequired:true instead of fabricating native facts or starting a world.",
  robot_state: "Read the actual Frame for an explicit world and optional entity. Supported native materials are in entities[].sensors.nativePhysics and native geometry in entities[].dynamicGeometry, under the same worldId/generation/sceneRevision/stepIndex. For material edits read names/values here, call scene_physics_update.native using the Scene revision, then sim_sync and robot_state again; a saved declaration alone does not prove native application. Tendon-driven entities also return top-level measured tendons.lengths/velocities (public EntityObservation.tendons/TendonObservation types); do not merge tendon data into joints. / 读取显式世界及可选实体的真实同帧状态；已支持的原生材料和动态几何在 sensors.nativePhysics/dynamicGeometry，保留同一世界、代次、场景版本和步数。修改材料先读实际名称和值，经 scene_physics_update.native 保存后用 sim_sync 同步，再用 robot_state 回读验证，不能以声明保存代替应用。",
  robot_move: "Execute a complete joint trajectory or explicit action. actionId prevents duplicate submission and expectedGeneration rejects late actions from an old generation. Tendon actions drive joint chains without joint-level actuators through source fixed-tendon coordinates, accepting only position channels with verified fixed gain/bias relationships. Distinguish requested targetLengths, the last actual ctrlApplied (null when cancelled before starting), and the stop holdReference. Closing does not demonstrate successful grasping.",
  robot_walk: "Run an asset-supported planar quadruped gait. forward/turn are in [-1,1]. Return measured displacement without claiming that arbitrary robots can walk.",
  robot_gripper: "Specify gripper width in meters and drive the actual coupled actuator. Return measured width and contact; closing alone is not grasp success.",
  vehicle_drive: "Velocity uses m/s. Steering is the virtual front-axle angle in radians, with positive values turning left while moving forward. At zero speed, move only the steering mechanism.",
  joint_move: "Execute a subset of joints or an absolute fork position. For lift motion, use positionM or velocityMps together with durationS.",
  sim_execute_batch: "Acquire multiple robots atomically and write every complete joint target at a shared start step.",
  robot_stop: "Cancel the target action immediately and confirm that control targets were withdrawn, without waiting for an LLM.",
  sim_stop: "Cancel actions in the whole world or selected entities immediately, without waiting for an LLM.",
  robot_freeze: "Hold the selected robot instances at their current pose with real native constraints/joint locks (MuJoCo preallocated inactive equalities; root weld only when the entity root is a real free root; scalar joints locked relative to qpos0). It first stops only those entities' actions, leaves unrelated robots and active actions untouched, does not pause the whole world and never uses a Scene checkpoint. The receipt reports the exact scope, rootHeld/jointLocks, the hold pose, and that source kp/kv/gear/force/ctrl limits were preserved. A stale expectedGeneration does not touch a newer world.",
  robot_restore: "Release exactly this Freeze's native hold (disable the constraints it enabled), keeping source gains/limits unchanged. It does not resume old actions or old velocities; start again explicitly to move. A repeated/unknown restore is reported truthfully, and a freezeId mismatch is refused rather than releasing another freeze.",
  sim_assist: "Explicit simulated attach/release assistance (teleport), excluded from physical contact-grasp success. Select mode explicitly.",
  sensor_capture: "Capture real engine RGB and depth in meters, with world/generation/step/sceneRevision provenance. Resolve relative outputDir paths against the current session's task workspace, as bash does; absolute paths are also accepted. Report the absolute directory actually written in the receipt's outputDir."+singleCaptureScope,
  camera_list: "Read final actual poses and vertical fields of view for all named cameras in the current world, including wrist/head and other views. Return cameraName; worldFromCamera, the final world pose actually used to render this frame (FOV-only does not freeze pose; mounted cameras follow parent-body FK); sourceWorldFromCamera, the source camera FK before overrides; fovyDeg/sourceFovyDeg; the actual effective K (intrinsics.fx/fy/cx/cy/width/height at this resolution); intrinsicsSource=fovy|mjcf|engine-intrinsics, with appliedIntrinsicsPx echoing declared values for engine-intrinsics; owning parentBodyName; override referenceFrame; and which fields were explicitly overridden. Do not modify models. Use these results to select capture and annotation targets."+cameraFamilyScope,
  camera_capture_multi: "Capture real RGB and depth in meters from multiple named cameras in one call. All cameras share stepIndex/simTime/frameId/sceneRevision; never combine unsynchronized captures. Return complete per-camera pinhole calibration (fx/fy/cx/cy/fovy/worldFromCamera/resolution, with intrinsicsSource identifying K) and captureId. A camera with declared K returns the K actually used to render; preserve nonsquare pixels and an off-center principal point. Reject the entire request for empty/duplicate/nonexistent cameraNames or invalid resolution. Resolve relative outputDir against the current session's task workspace, as bash does, or accept an absolute path. Report the absolute directory actually written in outputDir, without writing into the product root."+cameraFamilyScope,
  camera_adjust: "Create, partially update, or clear a temporary named-camera override. positionM, quaternionXyzw, and fovyDeg may be supplied separately or together; a non-clear request needs at least one. Omitted pose fields inherit only explicit values in the same referenceFrame or that frame's current source values. referenceFrame defaults to world: positionM/quaternionXyzw are world poses and explicitly fixed poses do not follow joint motion. For installation-offset adjustments on mounted wrist/head cameras, use parent, local to parentBodyName; each frame converts it through the parent's current FK. FOV-only does not freeze pose. Changing reference frames performs an explicit safe conversion at current FK and reports frameConverted/convertedFromFrame, never silently mixing coordinates. Only later captures/calibration receipts change, never source MJCF/Scene. K semantics: translation alone or width/height alone does not alter K; intrinsicsAtReferenceResolution reports effective K at this call's resolution (640×480 if omitted). For a camera with K, fovyDeg rescales only focal lengths (fovyApplied=intrinsic-focal-rescale; fy'=H_c/(2tan(fovy/2)), fx' scales proportionally), preserving the principal point and never forcing fx=fy. A pure-fovy camera retains whole-image vertical field-of-view semantics. Return complete position/quaternion/fovy/intrinsics, final actual worldFromCamera, parentBodyName/referenceFrame, override=true/worldGeneration. clear=true is mutually exclusive with override fields, returning cleared/calibration. Clear overrides automatically on sim_close/sim_sync or explicit clear."+cameraFamilyScope,
  camera_project_annotation: "Project pixels and real depth in meters into world-coordinate annotations. By default, use measured depth from the referenced capture or this step's actual render. Explicit depthM must match the real render or be rejected; fabricated depth is forbidden. Return worldPointM/cameraPointM, frameId, captureId, and calibration provenance so the point can be projected back to the original pixel. Reject boundary pixels and background/invalid depth explicitly. The depth ray mapping and RGB pixel convention have a measured subpixel difference of about ≤0.5 px; integer-pixel depth lookup corresponds to world-point errors of roughly ≤5 mm at 3 m."+cameraAnalysisScope,
  camera_dataset_export: "Export existing multi-view captures as a self-contained training dataset: samples.jsonl (per frame/per camera, with synchronized views sharing step/frameId/captureId), per-camera calibration.json, annotations.json, and actual PNG/NPY copies. Supply captureIds in frame order and never combine unsynchronized cameras as synchronized data. Resolve relative outputDir against the current session's task workspace, as bash does, or accept an absolute path. Report the absolute directory actually written in outputDir and directory."+cameraAnalysisScope,
  camera_lidar_scan: "Measure a simulated LiDAR scan from an existing named camera's real world pose using the engine's native ray geometry. Return raw Euclidean range in meters (NaN/valid=false for no-return), hit geom ids/names, the sensor pose, world/generation/revision/frame/step identity, and the geometry source. Range is along-ray Euclidean distance and must never be renamed into the camera's axial Z depth; no-return is never zero, and statistics use valid values only. Resolve relative outputDir against the current session's task workspace, or accept an absolute path, and report the absolute directory actually written."+lidarScope,
  sim_action_receipt: "Read actual completion/failure/cancellation and physics observations by the original actionId; do not submit motion again.",
}
/**
 * ISAAC-14(b)／W23：把 `robot_walk` 接到产品策略链路（`executePolicy` → `sim.execute(kind:'control')`）。
 *
 * **运行根与 Python 解释器由配置显式给出**（与 `policy-registry` 的 `policyDataDirectory` 同口径），
 * 理由：`robot-tools` 自己不知道运行根，`robot_walk` 也拿不到 —— 在 `operations.ts` 里猜一个运行根
 * 就是"同一份事实存两处"（W2 偏好文件 / W5 三处字面量 / W14 GPU 话术硬编码都是这个形态）。
 * **未配置 ⇒ 不注入接线** ⇒ `robot_walk` 保持既有透传，行为逐字不变。
 */
export interface Config {
  /** 策略运行根：与 policy-registry 的 dataDirectory 同一个根（`<root>/policies/<provider>/…`）。 */
  policyDataDirectory?: string
  /** 策略推理解释器；不给则由 policy-registry 的 pythonPath() 按既有次序解析。 */
  policyPythonPath?: string
  /** 能力包根目录；不给则按本仓根下的 `packs`。用于 `packId` 形态读取 pack **自己声明的**身份。 */
  packsDirectory?: string
}
export function apply(ctx: Context, config: Config = {}) {
  /**
   * 机器人操作按会话取：每个会话拿到的是绑定**自己那套**世界服务与自己场景存储的 operations。
   * 同一个本地 worldId 在两个会话里各自成立；一个会话的动作/取消/关闭不会寻址到别人的世界。
   * 惰性建：第一次为该会话调用工具时才建（与 sim/scene 两侧的会话映射同一套键）。
   */
  /**
   * ISAAC-14(b)：`robot_walk` 的策略接线。**身份来源可追溯** —— 只有两条，都是"声明"不是"猜"：
   *   ① `action.policy = {provider,modelId,revision}`（与 `policy_execute` 同口径，调用方显式给）；
   *   ② `action.packId = "<packId>"`（读 `packs/<packId>/policy/manifest.json` 的 `weights.resolution`，
   *      即 **pack 自己声明的**身份）。
   * 两条都不给 ⇒ 不调用本接线（`operations.ts` 直接透传）。
   * 未配置 `policyDataDirectory` ⇒ 不返回接线 ⇒ 既有透传行为逐字不变（不猜运行根）。
   */
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const POLICY_SOURCES = ['modelscope', 'github', 'huggingface', 'packs'] as const
  type PolicySource = (typeof POLICY_SOURCES)[number]
  const packsRoot = config.packsDirectory ? resolve(config.packsDirectory) : join(repoRoot, 'packs')
  const policyDataRoot = config.policyDataDirectory ? resolve(config.policyDataDirectory) : undefined
  const identityFromPack = async (packId: string): Promise<{ provider: PolicySource; modelId: string; revision: string; declaredIn: string }> => {
    const manifestPath = join(packsRoot, packId, 'policy', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { weights?: { resolution?: { provider?: string; modelId?: string; revision?: string } } }
    const resolution = manifest.weights?.resolution
    if (!resolution?.provider || !resolution.modelId || !resolution.revision) throw new Error(`POLICY_IDENTITY_NOT_DECLARED: ${packId} 的 policy/manifest.json 没有 weights.resolution（provider/modelId/revision），拒绝按机型名猜策略身份`)
    // 来源必须落在产品既有取值内：未知取值明确拒绝（不静默当成 github/modelscope 之一）。
    if (!POLICY_SOURCES.includes(resolution.provider as PolicySource)) throw new Error(`POLICY_IDENTITY_INVALID: ${packId} 声明的策略来源 ${resolution.provider} 不在 ${POLICY_SOURCES.join('|')}`)
    return { provider: resolution.provider as PolicySource, modelId: resolution.modelId, revision: resolution.revision, declaredIn: manifestPath }
  }
  const walkHooks = (ctx: Context, agent: unknown, scene: SceneReader) => {
    if (!policyDataRoot) return {}
    return {
      walk: async (input: { worldId: string; sceneId: string; action: SimAction }, signal?: AbortSignal) => {
        const action = input.action as unknown as { entityId: string; forward?: number; turn?: number; durationS?: number; policy?: { provider: PolicySource; modelId: string; revision: string }; packId?: string }
        const identity = action.policy ?? (action.packId ? await identityFromPack(action.packId) : undefined)
        if (!identity) throw new Error('POLICY_IDENTITY_REQUIRED: robot_walk 走策略链路需要 policy 或 packId')
        const sim = simWorldsFor(ctx, agent)
        const handle = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
        if (!handle) throw new Error(`WORLD_NOT_FOUND: robot_walk：worldId 不存在: ${input.worldId}`)
        return await executePolicy(
          { dataDirectory: policyDataRoot, ...(config.policyPythonPath === undefined ? {} : { pythonPath: config.policyPythonPath }) },
          { provider: identity.provider, modelId: identity.modelId, revision: identity.revision,
            sceneId: input.sceneId, entityId: action.entityId, worldId: input.worldId,
            expectedGeneration: handle.worldGeneration, runId: `walk-${Date.now()}`,
            ...(action.durationS === undefined ? {} : { durationS: action.durationS }),
            command: [action.forward ?? 0, 0, action.turn ?? 0] },
          { inspect: async (id: string) => await scene.snapshot(id) },
          sim, signal ?? new AbortController().signal,
        )
      },
    }
  }
  const sessionOperations = new Map<string, ReturnType<typeof createRobotOperations>>()
  /**
   * R-013：内部子树真实拆分的源格式派生接线。派生与资源登记沿用该会话自己的 `SceneOperations.resources`
   * 与它的暂存目录；本层不猜格式、不按扩展名开放能力，也不另建资源数据库。
   */
  const subtreeHooks = (sceneOps: ReturnType<typeof sceneOperationsFor>) => ({
    precheck: async ({ resourceId, version, bodyName }: { resourceId: string; version: number; bodyName: string }) =>
      inspectRobotSubtreeResource({ resources: sceneOps.resources, sourceResourceId: resourceId, sourceVersion: version, bodyName }),
    derive: async (input: { sceneId: string; entityId: string; sourceResourceId: string; sourceVersion: number; bodyName: string; operationId: string; partEntityId: string; partName: string; cutPoseInSourceRoot?: import('../../lyapunov-contracts/src/robot-authoring.ts').RobotAnchorPose }) => {
      const result = await deriveRobotSubtree({
        resources: sceneOps.resources,
        stagingRoot: join(sceneOps.directory, 'derived', 'subtree'),
        sourceResourceId: input.sourceResourceId,
        sourceVersion: input.sourceVersion,
        bodyName: input.bodyName,
        operationId: input.operationId,
        partResourceId: undefined,
        sceneId: input.sceneId,
        entityId: input.entityId,
        partEntityId: input.partEntityId,
        ...(input.cutPoseInSourceRoot ? { cutPoseInSourceRoot: input.cutPoseInSourceRoot } : {}),
      })
      return { derivation: result.derivation, remainingRef: result.remaining.ref, partRef: result.part.ref }
    },
    resourceComponents: async ({ resourceId, version }: { resourceId: string; version: number }) => {
      const record = await sceneOps.resources.get(resourceId, version)
      const path = localPath(record.ref.original.uri)
      const format = String(record.parsed.metadata.format ?? record.parsed.kind)
      const visual = { kind: 'robot', robot: await robotVisual(path) }
      const components = format === 'mjcf' ? { visual, mujoco: { sourcePath: path }, articulation: { source: record.ref.original, format } } : { visual, articulation: { source: record.ref.original, format } }
      return { ref: record.ref, components }
    },
  })
  const opsFor = (agent: unknown) => {
    const key = requireSessionId(agent, '机器人工具')
    const existing = sessionOperations.get(key)
    if (existing) return existing
    const sceneOps = sceneOperationsFor(ctx, agent, `机器人工具 ${key}`)
    const created = createRobotOperations(simWorldsFor(ctx, agent), sceneOps.scene as SceneReader, {...walkHooks(ctx, agent, sceneOps.scene as SceneReader),subtree:subtreeHooks(sceneOps),prepareWorld:async(snapshot,options,signal)=>{
      signal?.throwIfAborted()
      if(['physics-workspace-v1','physics-workspace-v2'].includes(snapshot.physics?.template??'')||['removed','disabled'].includes(snapshot.physics?.groundState??''))return snapshot
      // 导入 Scene 已有唯一显式无限地面时，打开物理世界不需要额外持久标记模板。
      // ground=false 是明确请求写入 disabled 选择，仍交给原 Scene CAS 写边界。
      const ground=snapshot.entities.filter(entity=>(entity.components.supportSurface as {kind?:string}|undefined)?.kind==='ground'&&entity.components.collision?.shape==='plane'&&entity.components.collision?.infinite===true)
      if(options?.ground!==false&&ground.length===1&&ground[0]!.components.collision?.enabled!==false&&ground[0]!.components.rigidBody?.type==='static'){
        // 复用 Scene 的世界变换；免持久准备只能依据实际 +Z 支持面，不按实体名称或视觉大小猜。
        const world=entityWorldMatrix(ground[0]!,new Map(snapshot.entities.map(entity=>[entity.entityId,entity])))
        const normal=new Vector3(0,0,1).applyMatrix3(new Matrix3().getNormalMatrix(world)).normalize()
        if(world.elements.every(Number.isFinite)&&Math.abs(normal.x)<=1e-6&&Math.abs(normal.y)<=1e-6&&Math.abs(normal.z-1)<=1e-6)return snapshot
      }
      requireWritableScene(ctx,agent,'sim_open ground preparation')
      return sceneOps.prepareWorld({sceneId:snapshot.sceneId,expectedRevision:snapshot.revision,ground:options?.ground})
    }})
    sessionOperations.set(key, created)
    return created
  }
  /**
   * 采集/导出工具的 `outputDir` 在 Tool/Command 边界解析成绝对路径（相对路径基准 = 会话工作区）：
   * Provider 侧按宿主进程 cwd 落盘，只有这里能把"模型说的相对目录"落到用户任务目录（见 output-path.ts）。
   * 回执里补的 `outputDir` 是解析后的真实绝对目录，且仅在确实发生解析时出现。
   */
  const withResolvedOutputDir = (value: unknown, outputDir: string | undefined) =>
    outputDir === undefined || value === null || typeof value !== 'object' ? value : { ...(value as Record<string, unknown>), outputDir }
  // 工具名清单来自参数表（与 operations 的键逐条一致），注册期不需要任何会话实例。
  for (const name of Object.keys(robotToolParameters) as Array<keyof typeof robotToolParameters & string>) {
    const run = (input: unknown, signal: AbortSignal | undefined, agent: unknown) => {
      // `robot_assembly_mount` 既是写（save/clear）也是读（只读查询）：只有真正落盘的形态才过写门禁；
      // 纯读查询保持会话归属与 expectedRevision 检查，在 read-only 会话里照常可用。
      if (name === 'robot_assembly_mount') {
        const args = input as { save?: unknown; clear?: boolean } | undefined
        if (args?.save !== undefined || args?.clear === true) requireWritableScene(ctx, agent, name)
      } else if (name === 'robot_set_tcp' || name === 'robot_set_base' || name === 'robot_assembly_undo' || name === 'robot_assembly_replace' || name === 'robot_assembly_extract' || name === 'robot_assembly_reassemble') requireWritableScene(ctx, agent, name)
      return (opsFor(agent)[name] as (input: any, signal?: AbortSignal) => Promise<unknown>)(input, signal)
    }
    ctx.tools.register(compatibleToolInput(defineTool({
      name, description: descriptions[name]!,
      parameters: robotToolParameters[name as keyof typeof robotToolParameters],
      output: { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => renderRobotToolValue(name, value) },
      execute: async (args: any, exec: any) => {
        const { value: input, outputDir } = resolveCallerOutputDir(name, args.input, exec)
        const value = await run(input, exec.signal, exec.agent)
        return (await attachToolResult(name, ctx, withResolvedOutputDir(value, outputDir))) as any
      },
    })))
    ctx.commands.register({ name, description: descriptions[name]!, ...(Object.keys(robotToolParameters[name as keyof typeof robotToolParameters]).length ? { input: { hint: "Operation arguments as JSON." } } : {}), handler: async (invocation: any) => {
      try {
        const { value: input, outputDir } = resolveCallerOutputDir(name, JSON.parse(invocation.rawInput || '{}'), invocation)
        return { kind: 'success' as const, text: JSON.stringify(withResolvedOutputDir(await run(input, invocation.signal, invocation.agent), outputDir)) }
      } catch (error) {
        const text = error instanceof Error
          ? ('code' in error && typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message)
          : String(error)
        return { kind: 'error' as const, text }
      }
    } })
  }
}
