/**
 * R-012／§2.9：只读装配预览（`robot_assembly_preview`）。
 *
 * 这是**读**路径，不是新的执行器：复用既有 SceneReader / SimWorlds 与 authoring 身份校验，
 * 只读当前 Scene、真实 `robot_describe` 与同身份原生 Frame，计算源根到目标 body 的安装变换并
 * 返回可直接交给既有 `robot_set_base` 的 `applyInput`；不 commit/sync/start/step，也不改模型。
 *
 * 位姿约定（权威合同 §2.9）：
 *   `T_A_B` 表示"把 B 坐标系表示到 A 坐标系"的 4×4 齐次变换（B 到 A）。
 *   `T_targetBody_sourceRoot = T_targetBody_targetMount · T_pair · inverse(T_sourceRoot_sourceMount)`
 * 位置单位为米，旋转为归一化四元数 xyzw；UI 若用欧拉/轴角必须先转成同一 xyzw 再提交。
 * 源处于炸开态时必须先显式合拢——本模块只消费物理安装面，不读取任何 presentation/explode 偏移。
 */
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Frame, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import {
  nativePoseInFrame,
  validRobotPose,
  type NativeRobotBody,
  type RobotAnchorPose,
  type RobotAssemblyPreviewInput,
  type RobotAssemblyPreviewResult,
  type RobotMountFact,
  type RobotSetBaseInput,
  type RobotSourceMount,
  type RobotTargetMount,
} from '../../lyapunov-contracts/src/robot-authoring.ts'
import type { RobotDescription, SimWorlds } from '../../sim-contract/src/index.ts'
import { assertSourceInstallable, mountBodyFixedToRoot } from './install-eligibility.ts'
import type { SceneReader } from './operations.ts'

// 窄资格判据只在 install-eligibility 维护一份；这里保留同名再导出以兼容既有导入路径。
export { mountBodyFixedToRoot, targetBodyStaticToWorld } from './install-eligibility.ts'

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const IDENTITY: RobotAnchorPose = { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] }

/** 位姿 → 4×4 刚体齐次矩阵。零四元数明确拒绝，不静默归一化未知输入。 */
export function poseToMatrix(pose: RobotAnchorPose): Matrix4 {
  const quaternion = new Quaternion(...pose.quaternionXyzw)
  if (quaternion.lengthSq() === 0) throw new Error('ASSEMBLY_PREVIEW_POSE_INVALID: 四元数不能为零向量')
  quaternion.normalize()
  return new Matrix4().compose(new Vector3(...pose.positionM), quaternion, new Vector3(1, 1, 1))
}
/** 4×4 刚体矩阵 → 米/归一化 xyzw 位姿。 */
export function matrixToPose(matrix: Matrix4): RobotAnchorPose {
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  quaternion.normalize()
  return { positionM: [position.x, position.y, position.z], quaternionXyzw: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] }
}
/** T_A_C = T_A_B · T_B_C：参数顺序即矩阵相乘顺序（左侧是更外层的坐标帧）。 */
export function multiplyPoses(...poses: RobotAnchorPose[]): RobotAnchorPose {
  const matrix = new Matrix4()
  for (const pose of poses) matrix.multiply(poseToMatrix(pose))
  return matrixToPose(matrix)
}
/** B 到 A 的逆：把 A 到 B 的变换翻回 B 到 A。 */
export function invertPose(pose: RobotAnchorPose): RobotAnchorPose { return matrixToPose(poseToMatrix(pose).invert()) }
/** 权威公式：`T_targetBody_sourceRoot = T_targetBody_targetMount · T_pair · inverse(T_sourceRoot_sourceMount)`。 */
export function sourceRootPoseFromMounts(targetMount: RobotAnchorPose, pair: RobotAnchorPose, sourceMount: RobotAnchorPose): RobotAnchorPose {
  return multiplyPoses(targetMount, pair, invertPose(sourceMount))
}

/** 与 `robot_set_base` 相同的身份校验：world/scene/revision/generation 必须完全一致且已同步。 */
async function previewContext(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyPreviewInput) {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new Error('ROBOT_ASSEMBLY_PREVIEW_IDENTITY_REQUIRED: 先读取当前场景版本与物理代次')
  const world = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
  if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 当前物理世界不属于指定场景')
  if (world.worldGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 物理世界已重建，请重新读取机器人')
  const snapshot = await scene.snapshot(input.sceneId)
  if (snapshot.revision !== input.expectedRevision || world.appliedSceneRevision !== snapshot.revision) throw new Error('SCENE_REVISION_MISMATCH: 请先同步当前场景，再预览装配')
  return { world, snapshot }
}

/** 实体当前资源身份（resourceId@version 序列）；只用于判断"读帧期间资源有没有变"。 */
import { entityResourceIdentity as resourceIdentity } from './authoring.ts'

/**
 * `observe` 是异步只读：拿到真实帧后必须**再次**核对当前 Scene revision、world generation/appliedRevision
 * 与源/目标资源身份。期间任何变化都让这份预览作废——否则会把旧身份算出的 applyInput 交给 `robot_set_base`。
 * 全程只读，不做 commit/sync/start/step。
 */
async function recheckContext(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyPreviewInput, before: SceneSnapshot, frame: Frame, worldBefore: { worldGeneration: number }): Promise<void> {
  const world = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
  if (!world || world.sceneId !== input.sceneId) throw new Error('WORLD_SCENE_MISMATCH: 预览异步读取期间世界身份已变化')
  if (world.worldGeneration !== input.expectedGeneration || world.worldGeneration !== worldBefore.worldGeneration) throw new Error('STALE_GENERATION: 预览异步读取期间物理世界已重建，请重新读取机器人')
  const snapshot = await scene.snapshot(input.sceneId)
  if (snapshot.revision !== input.expectedRevision) throw new Error('SCENE_REVISION_MISMATCH: 预览异步读取期间场景已更新，旧预览作废')
  if (world.appliedSceneRevision !== snapshot.revision) throw new Error('SCENE_REVISION_MISMATCH: 物理世界尚未应用当前场景版本')
  if (frame.worldId !== input.worldId || frame.generation !== input.expectedGeneration || frame.sceneRevision !== input.expectedRevision) throw new Error('ROBOT_ASSEMBLY_PREVIEW_FRAME_STALE: 原生帧不属于当前 scene/revision/generation，拒绝据旧帧预览')
  for (const entityId of [input.sourceEntityId, input.targetEntityId]) {
    const entityBefore = before.entities.find(entity => entity.entityId === entityId)
    const entityAfter = snapshot.entities.find(entity => entity.entityId === entityId)
    if (!entityBefore || !entityAfter) throw new Error(`ROBOT_ASSEMBLY_PREVIEW_ENTITY_CHANGED: 预览异步读取期间实体 ${entityId} 已变化`)
    if (resourceIdentity(entityBefore) !== resourceIdentity(entityAfter)) throw new Error(`ROBOT_ASSEMBLY_PREVIEW_RESOURCE_CHANGED: 预览异步读取期间实体 ${entityId} 的资源身份已变化`)
  }
}

/**
 * 该 body 是否等于根，或沿 parent 链到根**只经过固定/无关节**的连接。
 * 移动内链（如与根之间的铰链/滑动关节）不能冒充"相对根固定的安装接口"。
 * 判据实现见 `install-eligibility.ts`（写入口共用同一份）。
 */

/** 自绑定/环：目标已有的 baseBinding 链若回到源实体即拒绝。 */function assertNoCycle(snapshot: SceneSnapshot, sourceEntityId: string, targetEntityId: string): void {
  if (sourceEntityId === targetEntityId) throw new Error('ROBOT_ASSEMBLY_PREVIEW_SELF_BINDING: 源与目标不能是同一实体')
  const seen = new Set([sourceEntityId])
  let next: string | undefined = targetEntityId
  while (next) {
    if (seen.has(next)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_CYCLE: 目标已有的 baseBinding 链会与本次装配成环')
    seen.add(next)
    next = (snapshot.entities.find(entity => entity.entityId === next)?.components.baseBinding as { target?: { entityId?: string } } | undefined)?.target?.entityId
  }
}

/**
 * 真实原生帧里必须存在该 body 的合法 pose。缺了就明确失败——**不**拿 Scene transform、
 * 旧 `robot_describe` 里的 `worldFromBody` 或单位阵补齐（那些都不是同一身份的原生事实）。
 */
function requireFrameBodyPose(frame: Frame, entityId: string, bodyName: string, purpose: string): RobotAnchorPose {
  const pose = nativePoseInFrame(frame, entityId, bodyName)
  if (!pose) throw new Error(`ROBOT_ASSEMBLY_PREVIEW_FRAME_BODY_MISSING: 当前原生帧里没有${purpose} ${entityId}/${bodyName} 的合法 body pose，拒绝用 Scene transform/旧 description/单位阵补齐`)
  return pose
}

/** 解析结果同时保留 **body-local 事实**（给用户看）与 **root-local 计算量**（代公式）。 */
interface ResolvedSourceMount { fact: RobotMountFact; rootFromMount: RobotAnchorPose }

/**
 * 解析源安装面。关键：site/body-origin 的位姿是**该 body 局部**的，代入统一公式前必须先乘
 * `T_sourceRoot_sourceBody`；该换算只用**同一原生 Frame**里的 root/body world pose，绝不用 display 矩阵。
 */
function resolveSourceMount(description: RobotDescription, root: NativeRobotBody, sourceMount: RobotSourceMount, frame: Frame, sourceEntityId: string): ResolvedSourceMount {
  if (sourceMount.kind === 'pose') {
    if (!validRobotPose(sourceMount.pose)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_POSE_INVALID: 源安装点位移必须为 XYZ 米，四元数必须归一化')
    // kind:'pose' 契约上已经在**源根帧**中表达，不再叠加任何 body 变换。
    return {
      fact: { kind: 'pose', label: `explicit root-frame pose (${root.name})`, bodyName: root.name, positionM: [...sourceMount.pose.positionM], quaternionXyzw: [...sourceMount.pose.quaternionXyzw] },
      rootFromMount: { positionM: [...sourceMount.pose.positionM], quaternionXyzw: [...sourceMount.pose.quaternionXyzw] },
    }
  }
  const body = description.nativeBodies?.find(body => body.name === sourceMount.bodyName)
  if (!body) throw new Error('ROBOT_ASSEMBLY_PREVIEW_SOURCE_BODY_MISSING: 源模型没有该真实 body')
  if (!mountBodyFixedToRoot(description.nativeBodies ?? [], body.name, root.name)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_MOUNT_NOT_ROOT_FIXED: 源安装点必须位于真实根 body 或已证实相对根只经固定关节相连的 body 上；移动内链的 site 不能冒充固定接口')
  let local: RobotAnchorPose
  let fact: RobotMountFact
  if (sourceMount.kind === 'body-origin') {
    local = { ...IDENTITY, positionM: [...IDENTITY.positionM], quaternionXyzw: [...IDENTITY.quaternionXyzw] }
    fact = { kind: 'body-origin', label: `${body.name} origin`, bodyName: body.name, positionM: [...local.positionM], quaternionXyzw: [...local.quaternionXyzw] }
  } else {
    const site = description.nativeSites?.find(site => site.name === sourceMount.site && site.bodyName === body.name)
    if (!site) throw new Error('ROBOT_ASSEMBLY_PREVIEW_SOURCE_SITE_MISSING: 源模型该 body 上没有这个真实 site')
    local = { positionM: [...site.positionM], quaternionXyzw: [...site.quaternionXyzw] }
    fact = { kind: 'site', label: `${body.name}/${site.name}`, bodyName: body.name, positionM: [...local.positionM], quaternionXyzw: [...local.quaternionXyzw] }
  }
  // 同一原生帧中的 root/该 body world pose → T_sourceRoot_sourceBody；再乘 body-local 安装面得到 root 帧位姿。
  const rootWorld = requireFrameBodyPose(frame, sourceEntityId, root.name, '源根')
  const bodyWorld = body.name === root.name ? rootWorld : requireFrameBodyPose(frame, sourceEntityId, body.name, '源安装 body')
  const rootFromBody = multiplyPoses(invertPose(rootWorld), bodyWorld)
  const rootFromMount = multiplyPoses(rootFromBody, local)
  return { fact, rootFromMount }
}

function resolveTargetMount(description: RobotDescription, targetBodyName: string, targetMount: RobotTargetMount): RobotMountFact {
  const body = description.nativeBodies?.find(body => body.name === targetBodyName)
  if (!body) throw new Error('ROBOT_ASSEMBLY_PREVIEW_TARGET_BODY_MISSING: 目标机器人没有该真实 body')
  if (targetMount.kind === 'pose') {
    if (!validRobotPose(targetMount.pose)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_TARGET_POSE_INVALID: 目标安装位姿必须是该 body 局部的合法位姿')
    return { kind: 'pose', label: `${targetBodyName} local pose`, bodyName: targetBodyName, positionM: [...targetMount.pose.positionM], quaternionXyzw: [...targetMount.pose.quaternionXyzw] }
  }
  if (targetMount.kind === 'body-origin') return { kind: 'body-origin', label: `${targetBodyName} origin`, bodyName: targetBodyName, ...IDENTITY }
  const site = description.nativeSites?.find(site => site.name === targetMount.site && site.bodyName === targetBodyName)
  if (!site) throw new Error('ROBOT_ASSEMBLY_PREVIEW_TARGET_SITE_MISSING: 目标 body 上没有这个真实 site')
  return { kind: 'site', label: `${targetBodyName}/${site.name}`, bodyName: targetBodyName, positionM: [...site.positionM], quaternionXyzw: [...site.quaternionXyzw] }
}

/**
 * 只读装配预览。任何校验失败都在**没有 Scene 与原生写入**的前提下抛出结构化错误；
 * 成功返回 `applied:false` 的预览与可交给 `robot_set_base` 的 `applyInput`。
 */
export async function previewRobotAssembly(sim: SimWorlds, scene: SceneReader, input: RobotAssemblyPreviewInput): Promise<RobotAssemblyPreviewResult> {
  const { world, snapshot } = await previewContext(sim, scene, input)
  if (!input.sourceMount || !input.targetMount || typeof input.targetBodyName !== 'string' || !input.targetBodyName.trim()) throw new Error('ROBOT_ASSEMBLY_PREVIEW_MOUNT_REQUIRED: 必须明确源安装面与目标 body/安装位，不能默认根原点就是安装面')
  assertNoCycle(snapshot, input.sourceEntityId, input.targetEntityId)
  const sourceEntity = snapshot.entities.find(entity => entity.entityId === input.sourceEntityId)
  if (!sourceEntity) throw new Error('ROBOT_ASSEMBLY_PREVIEW_SOURCE_MISSING: 源实体不存在')
  const targetEntity = snapshot.entities.find(entity => entity.entityId === input.targetEntityId)
  if (!targetEntity) throw new Error('ROBOT_ASSEMBLY_PREVIEW_TARGET_MISSING: 目标实体不存在')
  const source = await sim.describe(input.worldId, input.sourceEntityId)
  const target = await sim.describe(input.worldId, input.targetEntityId)
  if (source.expectedGeneration !== input.expectedGeneration || target.expectedGeneration !== input.expectedGeneration) throw new Error('STALE_GENERATION: 等待期间世界已变化，请重新读取机器人')
  const root = source.nativeBodies?.find(body => body.root)
  if (!root) throw new Error('ROBOT_ASSEMBLY_PREVIEW_SOURCE_ROOT_MISSING: 源实体没有可识别的真实根 body')
  const editable = source.base?.editable
  if (!editable?.entity) throw new Error(`ROBOT_ASSEMBLY_PREVIEW_SOURCE_NOT_EDITABLE: ${editable?.reason ?? '当前引擎不支持把该实体根绑定到另一个实体'}`)
  // 只读安装资格：与 robot_set_base／Replace 共用同一份窄判据。源含静态 plane 时只有目标 body
  // 世界静态才允许挂接，commit 前拒绝且零 Scene 写入（free/source 恢复不走本条）。
  assertSourceInstallable(source, input.targetBodyName, target)
  // 只读：必须能读到与当前 scene/revision/generation 同一身份的真实帧；读不到就不产生可 Apply 预览。
  let frame: Frame
  try { frame = await sim.observe(input.worldId, { entityIds: [input.sourceEntityId, input.targetEntityId], sensors: true }) }
  catch (error) { throw new Error(`ROBOT_ASSEMBLY_PREVIEW_FRAME_UNAVAILABLE: 预览需要当前版本的真实原生帧。${errorText(error)}`) }
  if (frame.worldId !== input.worldId || frame.generation !== input.expectedGeneration || frame.sceneRevision !== input.expectedRevision) throw new Error('ROBOT_ASSEMBLY_PREVIEW_FRAME_STALE: 原生帧不属于当前 scene/revision/generation，拒绝据旧帧预览')
  // A2：先按真实 description 解析目标 body（缺 body/site 给准确的 TARGET_BODY_MISSING/TARGET_SITE_MISSING），
  // 再核验真实帧确实带源根与目标 body 的合法 native pose；缺任一项都拒绝给 Apply 输入。
  const targetMount = resolveTargetMount(target, input.targetBodyName, input.targetMount)
  requireFrameBodyPose(frame, input.sourceEntityId, root.name, '源根')
  const resolvedSourceMount = resolveSourceMount(source, root, input.sourceMount, frame, input.sourceEntityId)
  requireFrameBodyPose(frame, input.targetEntityId, input.targetBodyName, '目标 body')
  // A3：observe 是异步的，读完再核对一次当前 Scene/world/资源身份，旧身份作废。
  await recheckContext(sim, scene, input, snapshot, frame, world)
  const sourceMount = resolvedSourceMount.fact
  const pair = input.pair ?? IDENTITY
  if (!validRobotPose(pair)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_PAIR_INVALID: T_pair 必须是米/归一化 xyzw 的 4×4 刚体变换')
  const targetBodyFromSourceRoot = sourceRootPoseFromMounts(targetMount, pair, resolvedSourceMount.rootFromMount)
  if (!validRobotPose(targetBodyFromSourceRoot)) throw new Error('ROBOT_ASSEMBLY_PREVIEW_RESULT_INVALID: 计算出的安装变换不是合法位姿，拒绝输出')
  const notes: string[] = []
  if (input.sourceMount.kind === 'pose') notes.push('Source mount is an explicit user root-frame pose, not a native site.')
  if (sourceMount.bodyName !== root.name) notes.push(`Source mount is on body ${sourceMount.bodyName}; its body-local pose was multiplied by T_sourceRoot_sourceBody from the same native Frame, proven fixed relative to root ${root.name}.`)
  if (input.targetMount.kind !== 'site') notes.push('Target mount is not a native site; the pose is a body-local explicit choice.')
  notes.push('Read-only preview: no Scene write, no world commit/sync/start/step; the physical binding is applied only by robot_set_base with this applyInput.')
  const applyInput: RobotSetBaseInput = {
    worldId: input.worldId,
    sceneId: input.sceneId,
    entityId: input.sourceEntityId,
    expectedRevision: input.expectedRevision,
    expectedGeneration: input.expectedGeneration,
    base: { mode: 'fixed', bodyName: root.name, target: { entityId: input.targetEntityId, bodyName: input.targetBodyName, positionM: [...targetBodyFromSourceRoot.positionM], quaternionXyzw: [...targetBodyFromSourceRoot.quaternionXyzw] } },
  }
  return {
    status: 'PREVIEW', applied: false, sceneId: input.sceneId, worldId: input.worldId, revision: snapshot.revision, generation: world.worldGeneration,
    source: { entityId: sourceEntity.entityId, name: sourceEntity.name, rootBodyName: root.name },
    target: { entityId: targetEntity.entityId, name: targetEntity.name, bodyName: input.targetBodyName },
    sourceMount, sourceMountInSourceRoot: resolvedSourceMount.rootFromMount, targetMount, pair, targetBodyFromSourceRoot,
    frame: { worldId: frame.worldId, generation: frame.generation, sceneRevision: frame.sceneRevision, ...(frame.frameId ? { frameId: frame.frameId } : {}), ...(frame.stepIndex !== undefined ? { stepIndex: frame.stepIndex } : {}) },
    applyInput, notes,
  }
}
