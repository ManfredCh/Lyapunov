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
import { createRobotOperations, type SceneReader } from './operations.ts'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import { executePolicy } from '../../policy-registry/src/execution.ts'
import { resolveCallerOutputDir } from './output-path.ts'
import { cameraAnalysisScope, cameraFamilyScope, robotToolParameters, singleCaptureScope } from './tool-schema.ts'

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
  robot_describe: "Read all robot joints, actuators, units, SI control configuration, and current generation. tendonActuators exposes source tendon-actuator channels, preserving coordinate=Σ coef·q and gear/gain/bias/force/ctrlrange. Tendon-driven joints identify that source in joints[].tendonActuators; do not fabricate controlledJointNames. capabilities lists availability and reasons for joint/vehicle/gripper/lift/control/thrust, with error codes and explanations derived from the same rejection logic as execution-side prepare. Joint entries include controlledSource. When source joint/actuator metadata cannot be verified (URDF or native USD), conservatively leave controlledJointNames empty and omit per-joint controlMode; top-level controlMetadata explains why. Do not infer control from all DOFs or default to position. gripper/lift require articulation, the corresponding controller mapping, resolvable non-passive joints. control additionally requires a manual clock and joint-level actuators whose mode is not velocity. An entity without joints has no joint channel. Read thrust availability, the four mapped source actuators, the site's free-root body, source mass, and ctrlrange/forcerange only here. Without real actuator metadata, available=false; do not substitute constants. freeBases lists free roots observed in robot_state.sensors.freeBase, including source-declared massKg; these are not controlled joints. Provider boundaries: Isaac supplies the most complete capabilities, joints[].controlledSource, and top-level controlMetadata. MuJoCo does not provide those three fields. Newton returns all six contract kinds (joint/thrust/vehicle/gripper/lift/control) with available=false and reason prefixes matching the actual execution rejection ACTION_UNSUPPORTED. Its top-level controlMetadata explains why controlledJointNames is always empty (no action/control channel); it still omits joints[].controlledSource because there are no controlled joints. Missing fields do not imply availability. Completing them belongs to each Provider's implementation scope.",
  robot_set_tcp: "Select a real end-effector TCP from robot_describe nativeBodies/nativeSites, save it in the current Scene.controller.tcp, then synchronize the same world and return a Frame for that revision. Choose either a site or a custom body-local offset. For an ordinary Panda model without a site, explicitly select the hand origin/offset instead of fabricating an official site. clear:true removes the configuration. A missing mapping can also be configured in the manual sidebar; do not download a policy.",
  robot_presets: "Read this revision's actual body/site data, configured TCP, source base, uncovered native MJCF/USD cameras, and Scene installation baseline. Without a preset, return body/site candidates and manual-calibration reasons. Do not guess a wrist offset or claim an official TCP for a Panda model without a site. Apply through robot_set_tcp or camera_scene_save using the same Scene contract.",
  robot_set_base: "Edit the actual root base. free removes this instance's fixed constraint while preserving internal joints; fixed anchors it to the world or a real body-local anchor on another entity; source restores the original model declaration. First read base.editable/nativeBodies through robot_describe and verify source/importer/actual constraint provenance. No freejoint means fixed to the world, not welded to the floor; parentId is not a physics binding. Use the same Scene CAS, sim_sync, and native Frame flow as the manual sidebar. Reject unsupported layouts/engines explicitly.",
  robot_state: "Read actual entity/joint/sensor/contact state. Tendon-driven entities also return top-level measured tendons.lengths/velocities (public EntityObservation.tendons/TendonObservation types); do not merge tendon data into joints.",
  robot_move: "Execute a complete joint trajectory or explicit action. actionId prevents duplicate submission and expectedGeneration rejects late actions from an old generation. Tendon actions drive joint chains without joint-level actuators through source fixed-tendon coordinates, accepting only position channels with verified fixed gain/bias relationships. Distinguish requested targetLengths, the last actual ctrlApplied (null when cancelled before starting), and the stop holdReference. Closing does not demonstrate successful grasping.",
  robot_walk: "Run an asset-supported planar quadruped gait. forward/turn are in [-1,1]. Return measured displacement without claiming that arbitrary robots can walk.",
  robot_gripper: "Specify gripper width in meters and drive the actual coupled actuator. Return measured width and contact; closing alone is not grasp success.",
  vehicle_drive: "Velocity uses m/s. Steering is the virtual front-axle angle in radians, with positive values turning left while moving forward. At zero speed, move only the steering mechanism.",
  joint_move: "Execute a subset of joints or an absolute fork position. For lift motion, use positionM or velocityMps together with durationS.",
  sim_execute_batch: "Acquire multiple robots atomically and write every complete joint target at a shared start step.",
  robot_stop: "Cancel the target action immediately and confirm that control targets were withdrawn, without waiting for an LLM.",
  sim_stop: "Cancel actions in the whole world or selected entities immediately, without waiting for an LLM.",
  sim_assist: "Explicit simulated attach/release assistance (teleport), excluded from physical contact-grasp success. Select mode explicitly.",
  sensor_capture: "Capture real engine RGB and depth in meters, with world/generation/step/sceneRevision provenance. Resolve relative outputDir paths against the current session's task workspace, as bash does; absolute paths are also accepted. Report the absolute directory actually written in the receipt's outputDir."+singleCaptureScope,
  camera_list: "Read final actual poses and vertical fields of view for all named cameras in the current world, including wrist/head and other views. Return cameraName; worldFromCamera, the final world pose actually used to render this frame (FOV-only does not freeze pose; mounted cameras follow parent-body FK); sourceWorldFromCamera, the source camera FK before overrides; fovyDeg/sourceFovyDeg; the actual effective K (intrinsics.fx/fy/cx/cy/width/height at this resolution); intrinsicsSource=fovy|mjcf|engine-intrinsics, with appliedIntrinsicsPx echoing declared values for engine-intrinsics; owning parentBodyName; override referenceFrame; and which fields were explicitly overridden. Do not modify models. Use these results to select capture and annotation targets."+cameraFamilyScope,
  camera_capture_multi: "Capture real RGB and depth in meters from multiple named cameras in one call. All cameras share stepIndex/simTime/frameId/sceneRevision; never combine unsynchronized captures. Return complete per-camera pinhole calibration (fx/fy/cx/cy/fovy/worldFromCamera/resolution, with intrinsicsSource identifying K) and captureId. A camera with declared K returns the K actually used to render; preserve nonsquare pixels and an off-center principal point. Reject the entire request for empty/duplicate/nonexistent cameraNames or invalid resolution. Resolve relative outputDir against the current session's task workspace, as bash does, or accept an absolute path. Report the absolute directory actually written in outputDir, without writing into the product root."+cameraFamilyScope,
  camera_adjust: "Create, partially update, or clear a temporary named-camera override. positionM, quaternionXyzw, and fovyDeg may be supplied separately or together; a non-clear request needs at least one. Omitted pose fields inherit only explicit values in the same referenceFrame or that frame's current source values. referenceFrame defaults to world: positionM/quaternionXyzw are world poses and explicitly fixed poses do not follow joint motion. For installation-offset adjustments on mounted wrist/head cameras, use parent, local to parentBodyName; each frame converts it through the parent's current FK. FOV-only does not freeze pose. Changing reference frames performs an explicit safe conversion at current FK and reports frameConverted/convertedFromFrame, never silently mixing coordinates. Only later captures/calibration receipts change, never source MJCF/Scene. K semantics: translation alone or width/height alone does not alter K; intrinsicsAtReferenceResolution reports effective K at this call's resolution (640×480 if omitted). For a camera with K, fovyDeg rescales only focal lengths (fovyApplied=intrinsic-focal-rescale; fy'=H_c/(2tan(fovy/2)), fx' scales proportionally), preserving the principal point and never forcing fx=fy. A pure-fovy camera retains whole-image vertical field-of-view semantics. Return complete position/quaternion/fovy/intrinsics, final actual worldFromCamera, parentBodyName/referenceFrame, override=true/worldGeneration. clear=true is mutually exclusive with override fields, returning cleared/calibration. Clear overrides automatically on sim_close/sim_sync or explicit clear."+cameraFamilyScope,
  camera_project_annotation: "Project pixels and real depth in meters into world-coordinate annotations. By default, use measured depth from the referenced capture or this step's actual render. Explicit depthM must match the real render or be rejected; fabricated depth is forbidden. Return worldPointM/cameraPointM, frameId, captureId, and calibration provenance so the point can be projected back to the original pixel. Reject boundary pixels and background/invalid depth explicitly. The depth ray mapping and RGB pixel convention have a measured subpixel difference of about ≤0.5 px; integer-pixel depth lookup corresponds to world-point errors of roughly ≤5 mm at 3 m."+cameraAnalysisScope,
  camera_dataset_export: "Export existing multi-view captures as a self-contained training dataset: samples.jsonl (per frame/per camera, with synchronized views sharing step/frameId/captureId), per-camera calibration.json, annotations.json, and actual PNG/NPY copies. Supply captureIds in frame order and never combine unsynchronized cameras as synchronized data. Resolve relative outputDir against the current session's task workspace, as bash does, or accept an absolute path. Report the absolute directory actually written in outputDir and directory."+cameraAnalysisScope,
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
  const opsFor = (agent: unknown) => {
    const key = requireSessionId(agent, '机器人工具')
    const existing = sessionOperations.get(key)
    if (existing) return existing
    const sceneOps = sceneOperationsFor(ctx, agent, `机器人工具 ${key}`)
    const created = createRobotOperations(simWorldsFor(ctx, agent), sceneOps.scene as SceneReader, {...walkHooks(ctx, agent, sceneOps.scene as SceneReader),prepareWorld:async(snapshot,options,signal)=>{
      signal?.throwIfAborted()
      if(['physics-workspace-v1','physics-workspace-v2'].includes(snapshot.physics?.template??'')||['removed','disabled'].includes(snapshot.physics?.groundState??''))return snapshot
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
      if (name === 'robot_set_tcp' || name === 'robot_set_base') requireWritableScene(ctx, agent, name)
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
