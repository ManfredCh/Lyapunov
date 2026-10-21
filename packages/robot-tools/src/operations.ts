import type { Entity, ResourceRef, SceneSnapshot, SceneCommit, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { SimWorlds, SimAction, EntityMotion, WorldOptions, StopSelection, FreezeSelection, MultiCaptureOptions, CameraAdjustOptions, CameraAnnotationOptions, CameraDatasetExportOptions, LidarScanOptions } from '../../sim-contract/src/index.ts'
import { setRobotBase, setRobotTcp } from './authoring.ts'
import { previewRobotAssembly } from './assembly-preview.ts'
import { checkRobotAssembly, replaceRobotAssembly, saveRobotAssemblyMount } from './assembly-actions.ts'
import { extractRobotAssemblySubtree, precheckRobotAssemblySubtree, reassembleRobotAssemblySubtree } from './assembly-extract.ts'
import { readRobotAssemblyHistory, undoRobotAssembly } from './assembly-history.ts'
import { readRobotPresets } from './presets.ts'
import type { RobotAnchorPose, RobotAssemblyCheckInput, RobotAssemblyHistoryInput, RobotAssemblyMountInput, RobotAssemblyPreviewInput, RobotAssemblyReplaceInput, RobotAssemblyUndoInput, RobotSetBaseInput, RobotSetTcpInput, RobotSubtreeDerivationRecord, RobotSubtreeExtractInput, RobotSubtreePrecheckInput, RobotSubtreePrecheckResult, RobotSubtreeReassembleInput } from '../../lyapunov-contracts/src/robot-authoring.ts'
/**
 * 只读/写入 Scene 的窄面。`version`/`versions` 是既有 SceneStore 历史在机器人 Undo 侧的**可选**读口：
 * 缺省表示该 owner 没有可核历史，局部 Undo 会明确报 SCENE_HISTORY_UNAVAILABLE，而不是新建一套历史。
 */
export interface SceneReader {
  snapshot(sceneId: string): Promise<SceneSnapshot> | SceneSnapshot
  commit(input: SceneCommit): Promise<SceneSnapshot> | SceneSnapshot
  version?(sceneId: string, revision: number): Promise<SceneSnapshot> | SceneSnapshot
  versions?(sceneId: string): Promise<Array<{ revision: number }>> | Array<{ revision: number }>
}
/**
 * 接线缝（ISAAC-14(b)）：`robot_walk` 的策略执行路径**由注入提供**，本文件不 import `policy-registry`。
 *
 * 为什么做成注入而不是直接 import：`robot_walk` 自己拿不到策略执行需要的两样东西 ——
 * 运行根（`dataDirectory`）与策略身份（`provider/modelId/revision`）——它们由策略插件按运行根解析。
 * 硬在本文件里猜一个运行根，就是"同一份事实存两处"的老毛病（W2 偏好文件、W5 字面量都是这个形态）。
 * 所以这里只定义**缝**：给了 `walk` 就按产品策略链路走，没给就保持既有透传 ——
 * 既有调用方（含全部既有测试）行为逐字不变。
 *
 * `sceneId` 由本文件从 `sim.listWorlds()` 的句柄解析后一并交给接线，接线方不必再猜 world→scene 归属。
 */
export interface RobotOperationHooks {
  walk?: (input: { worldId: string; sceneId: string; action: SimAction }, signal?: AbortSignal) => Promise<unknown>
  prepareWorld?: (snapshot:SceneSnapshot,options?:WorldOptions,signal?:AbortSignal)=>Promise<SceneSnapshot>
  /** R-013：源格式派生接线（scene-kit owner）。未接线时真实拆分明确拒绝，不按名称/扩展名猜能力。 */
  subtree?: RobotSubtreeHooks
}
/** helper 返回的预检事实（只读），由接线方原样透传。 */
export interface RobotSubtreeFacts {
  source: string
  sourceSha256: string
  selectedBody: string
  selectedBodyParent: string
  supported: boolean
  subtree: RobotSubtreePrecheckResult['subtree']
  remaining: RobotSubtreePrecheckResult['remaining']
  closure: { meshFiles: string[]; textureFiles: string[]; copiedBytes: number }
  crossEdges: RobotSubtreePrecheckResult['crossEdges']
  warnings: Array<Record<string, unknown>>
  reason: string | null
}
/** 资源库只读预检结果；`supported=false` 带具名 unsupported（零 Scene/资源写入）。 */
export interface RobotSubtreeInspection {
  resourceId: string
  version: number
  path: string
  sha256: string
  format: string
  supported: boolean
  facts?: RobotSubtreeFacts
  unsupported?: { code: string; message: string }
}
export interface RobotSubtreeDeriveRequest {
  sceneId: string
  entityId: string
  sourceResourceId: string
  sourceVersion: number
  bodyName: string
  operationId: string
  partEntityId: string
  partName: string
  cutPoseInSourceRoot?: RobotAnchorPose
}
export interface RobotSubtreeDeriveOutcome {
  derivation: RobotSubtreeDerivationRecord
  remainingRef: ResourceRef
  partRef: ResourceRef
}
export interface RobotSubtreeHooks {
  precheck: (input: { resourceId: string; version: number; bodyName: string }) => Promise<RobotSubtreeInspection>
  derive: (input: RobotSubtreeDeriveRequest) => Promise<RobotSubtreeDeriveOutcome>
  /** 按已登记资源合成引擎/可视组件与**完整 ResourceRef**（与 scene_mount 同一口径；重组恢复原引用时两者都要）。 */
  resourceComponents: (input: { resourceId: string; version: number }) => Promise<{ ref: ResourceRef; components: Partial<Entity['components']> }>
}
export function createRobotOperations(sim: SimWorlds, scene: SceneReader, hooks: RobotOperationHooks = {}) {
  return {
    // 取消信号必须传进 open：worker 启动（Isaac Kit 冷启动可达数十秒、偶发挂住）与建世界
    // 都在这一条调用里，只有把调用方的 signal 交下去，取消才能真正结束本次尚未交付的操作。
    sim_open: async (input: { sceneId: string; options?: WorldOptions }, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      let snapshot=await scene.snapshot(input.sceneId)
      if(hooks.prepareWorld){
        // 已交付世界由 Provider owner 自己记账；后台轮询必须继续报告旧启动终态，
        // 不能让这次轮询挡住显式 open 的既有恢复入口，也不能替它自动重启。
        const existing=sim.hasSceneWorld?sim.hasSceneWorld(input.sceneId):(await sim.listWorlds()).some(world=>world.sceneId===input.sceneId&&world.status!=='closed')
        if(!existing)snapshot=await hooks.prepareWorld(snapshot,input.options,signal)
      }
      signal?.throwIfAborted()
      return sim.open(snapshot,input.options,signal)
    },
    sim_world_list: () => sim.listWorlds(),
    sim_set_paused: async(input:{worldId:string;paused:boolean;expectedGeneration:number})=>{
      if(!sim.setPaused)throw new SimError('CLOCK_CONTROL_UNSUPPORTED','当前Provider未提供暂停/继续接口')
      return sim.setPaused(input.worldId,input.paused,input.expectedGeneration)
    },
    sim_sync: async (input: { sceneId: string; worldId: string }) => sim.sync(input.worldId, await scene.snapshot(input.sceneId)),
    sim_reset: async (input: { sceneId: string; worldId: string; expectedRevision: number; expectedGeneration: number }) => {
      const world = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
      const snapshot = await scene.snapshot(input.sceneId)
      if (!world || world.sceneId !== input.sceneId || world.worldGeneration !== input.expectedGeneration || world.appliedSceneRevision !== input.expectedRevision || snapshot.revision !== input.expectedRevision) throw new SimError('STALE_GENERATION', '复位目标世界/场景已变化，请先同步')
      await sim.stop(input.worldId, { expectedGeneration: input.expectedGeneration })
      const current = (await sim.listWorlds()).find(world => world.worldId === input.worldId)
      if (current?.worldGeneration !== input.expectedGeneration || (await scene.snapshot(input.sceneId)).revision !== input.expectedRevision) throw new SimError('STALE_GENERATION', '停止期间世界/场景已变化，未执行复位')
      const reset = await sim.sync(input.worldId, snapshot, { forceRebuild: true })
      const frame = await sim.observe(input.worldId, { sensors: true, contacts: true })
      if (frame.generation !== reset.worldGeneration || frame.sceneRevision !== snapshot.revision) throw new SimError('STALE_GENERATION', '复位后尚无对应版本原生帧')
      return { status: 'RESET', snapshot, world: reset, frame, affectedEntityIds: snapshot.entities.map(entity => entity.entityId) }
    },
    sim_close: async (input: { worldId: string }) => { await sim.close(input.worldId); return { closed: true } },
    robot_load: async (input: { worldId: string; sceneId: string; entityId?: string; entity?: Entity }) => {
      let snapshot = await scene.snapshot(input.sceneId)
      if (input.entity) {
        // 新建实体前先核对目标 world 已绑定的 Scene：world 不存在或跨 Scene 时先失败，
        // 避免实体已提交进 Scene 文档、sync 却不可能成功（跨 Scene 由 Provider 拒绝：SCENE_MISMATCH）。
        const bound = (await sim.listWorlds()).find(handle => handle.worldId === input.worldId)
        if (!bound) throw new SimError('WORLD_NOT_FOUND', 'worldId 不存在')
        if (bound.sceneId !== input.sceneId) throw new SimError('SCENE_MISMATCH', 'world 不能绑定另一个 scene')
        if (snapshot.entities.some(e => e.entityId === input.entity!.entityId)) throw new Error('实体已存在；编辑请使用 scene_edit')
        snapshot = await scene.commit({ sceneId: input.sceneId, expectedRevision: snapshot.revision, patch: [{ op: 'add', entity: input.entity }] })
      }
      const entityId = input.entity?.entityId ?? input.entityId
      if (!entityId || !snapshot.entities.some(e => e.entityId === entityId)) throw new Error('找不到要加载的实体')
      const world = await sim.sync(input.worldId, snapshot)
      return { world, robot: await sim.describe(input.worldId, entityId) }
    },
    robot_describe: (input: { worldId: string; entityId: string }) => sim.describe(input.worldId, input.entityId),
    robot_presets: (input: import('../../lyapunov-contracts/src/robot-authoring.ts').RobotConfigurationIdentity) => readRobotPresets(sim, scene, input),
    robot_set_tcp: (input: RobotSetTcpInput) => setRobotTcp(sim, scene, input),
    robot_set_base: (input: RobotSetBaseInput) => setRobotBase(sim, scene, input),
    // R-012／§2.9 只读预览：算源根→目标 body 的安装变换并给出 `robot_set_base.applyInput`；
    // 本方法不 commit/sync/start/step，也不读取任何 presentation/explode 偏移。
    robot_assembly_preview: (input: RobotAssemblyPreviewInput) => previewRobotAssembly(sim, scene, input),
    // R-012：保存/复用源安装点的窄元数据（`components.assemblyMount`，绑定资源版本），只读检查，
    // 以及一次 CAS 的旧末端置换。都不新开历史/点数据库。
    robot_assembly_mount: (input: RobotAssemblyMountInput) => saveRobotAssemblyMount(sim, scene, input),
    robot_assembly_check: (input: RobotAssemblyCheckInput) => checkRobotAssembly(sim, scene, input),
    robot_assembly_replace: (input: RobotAssemblyReplaceInput) => replaceRobotAssembly(sim, scene, input),
    // R-013：只读预检 + 真实内部拆分 + 重组。派生/登记由 scene-kit owner 经 `hooks.subtree` 执行，
    // 本层只做一次 Scene CAS、一次 sync，以及成对标记与受保护局部 Undo 的核对。
    robot_assembly_extract_precheck: (input: RobotSubtreePrecheckInput) => precheckRobotAssemblySubtree(scene, hooks.subtree, input),
    robot_assembly_extract: (input: RobotSubtreeExtractInput) => extractRobotAssemblySubtree(sim, scene, hooks.subtree, input),
    robot_assembly_reassemble: (input: RobotSubtreeReassembleInput) => reassembleRobotAssemblySubtree(sim, scene, hooks.subtree, input),
    robot_assembly_history: (input: RobotAssemblyHistoryInput) => readRobotAssemblyHistory(scene, input),
    robot_assembly_undo: (input: RobotAssemblyUndoInput) => undoRobotAssembly(sim, scene, input),
    robot_state: (input: { worldId: string; entityId?: string; contacts?: boolean }) => sim.observe(input.worldId, { entityIds: input.entityId ? [input.entityId] : undefined, contacts: input.contacts }),
    robot_move: (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => sim.execute(input.worldId, input.action, signal),
    robot_walk: async (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => {
      if (input.action.kind !== 'gait') throw new Error('robot_walk需要明确gait动作和资产策略')
      // ISAAC-14(b)：**只有调用方声明了策略身份**（policy 或 packId）且接线已注入，才走策略链路。
      // 两者任一不满足 ⇒ 保持既有透传（`kind:'gait'` 原样到达 worker）。身份来源不明时不猜、不按机型名映射。
      const declared = input.action as { policy?: unknown; packId?: unknown }
      if (!hooks.walk || (declared.policy === undefined && declared.packId === undefined)) return sim.execute(input.worldId, input.action, signal)
      // 走策略链路：world→scene 归属从 world 句柄读回（不猜、不由调用方另传）。
      const handle = (await sim.listWorlds()).find(candidate => candidate.worldId === input.worldId)
      if (!handle) throw new SimError('WORLD_NOT_FOUND', `robot_walk：worldId 不存在: ${input.worldId}`)
      return hooks.walk({ worldId: input.worldId, sceneId: handle.sceneId, action: input.action }, signal)
    },
    robot_gripper: (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => {
      if (input.action.kind !== 'gripper') throw new Error('robot_gripper 需要 widthM/durationS')
      return sim.execute(input.worldId, input.action, signal)
    },
    vehicle_drive: (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => {
      if (input.action.kind !== 'vehicle') throw new Error('vehicle_drive 需要 SI vehicle 动作')
      return sim.execute(input.worldId, input.action, signal)
    },
    joint_move: (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => {
      if (!['joint', 'lift'].includes(input.action.kind)) throw new Error('joint_move 需要 joint 或 lift 动作')
      return sim.execute(input.worldId, input.action, signal)
    },
    sim_execute_batch: (input: { worldId: string; action: SimAction }, signal?: AbortSignal) => {
      if (input.action.kind !== 'batch') throw new Error('sim_execute_batch 需要 batch 动作')
      return sim.execute(input.worldId, input.action, signal)
    },
    robot_stop: (input: { worldId: string } & StopSelection) => sim.stop(input.worldId, { entityIds: input.entityIds, actionId: input.actionId, expectedGeneration: input.expectedGeneration }),
    sim_stop: (input: { worldId: string } & StopSelection) => sim.stop(input.worldId, { entityIds: input.entityIds, actionId: input.actionId, expectedGeneration: input.expectedGeneration }),
    // 目标级原生 Freeze/Restore：只走同一个 SimWorlds 保持接口，不新开 world、不写 Scene、不暂停整 world。
    robot_freeze: (input: { worldId: string } & FreezeSelection) => {
      if (!sim.freeze) throw new SimError('FREEZE_UNSUPPORTED', '当前 Provider 未提供原生 Freeze 接口')
      return sim.freeze(input.worldId, { entityIds: input.entityIds, expectedGeneration: input.expectedGeneration, freezeId: input.freezeId })
    },
    robot_restore: (input: { worldId: string } & FreezeSelection) => {
      if (!sim.restore) throw new SimError('FREEZE_UNSUPPORTED', '当前 Provider 未提供原生 Freeze/Restore 接口')
      return sim.restore(input.worldId, { entityIds: input.entityIds, expectedGeneration: input.expectedGeneration, freezeId: input.freezeId })
    },
    sim_assist: (input: { worldId: string; mode: 'attach' | 'release'; expectedGeneration: number; objectId: string; robotId?: string; anchorBody?: string }) => sim.assist(input.worldId, input),
    // 落盘类工具的 outputDir 由 Tool/Command 边界解析成绝对路径后才到这里（见 plugin.ts/output-path.ts）：
    // Provider/worker 侧按宿主进程 cwd 解析相对路径，会把产物写到产品根；这里不再补一层 Agent 依赖。
    sensor_capture: (input: { worldId: string; outputDir: string; cameraName?: string; width?: number; height?: number; geomGroups?: number[] }) => sim.capture(input.worldId, input),
    // 多视角相机工具族：只转发到同一 SimWorlds 视图（Provider 拥有真实渲染与标定），
    // 这里不重新实现任何相机物理、也不缓存标定；worldId 显式给出，不使用隐式 Viewer 世界。
    camera_list: (input: { worldId: string }) => sim.listCameras(input.worldId),
    camera_capture_multi: (input: { worldId: string } & MultiCaptureOptions) => sim.captureMulti(input.worldId, input),
    camera_adjust: (input: { worldId: string } & CameraAdjustOptions) => sim.adjustCamera(input.worldId, input),
    camera_project_annotation: (input: { worldId: string } & CameraAnnotationOptions) => sim.projectAnnotation(input.worldId, input),
    camera_dataset_export: (input: { worldId: string } & CameraDatasetExportOptions) => sim.exportCameraDataset(input.worldId, input),
    // 模拟LiDAR量测：真实原生物理射线，与相机RGB-D分源。Provider 未提供通道时结构化拒绝，不返回占位图。
    camera_lidar_scan: (input: { worldId: string } & LidarScanOptions) => {
      if (!sim.scanLidar) throw new SimError('SENSOR_UNAVAILABLE', '当前 Provider 未提供模拟LiDAR量测接口（scanLidar）')
      return sim.scanLidar(input.worldId, input)
    },
    sim_action_receipt: (input: { worldId: string; actionId: string }) => sim.receipt(input.worldId, input.actionId),
  }
}
export type RobotOperations = ReturnType<typeof createRobotOperations>
