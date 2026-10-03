import type { Entity, SceneSnapshot, SceneCommit, WorldHandle } from '../../lyapunov-contracts/src/types.ts'
import { SimError } from '../../sim-contract/src/index.ts'
import type { SimWorlds, SimAction, EntityMotion, WorldOptions, StopSelection, MultiCaptureOptions, CameraAdjustOptions, CameraAnnotationOptions, CameraDatasetExportOptions } from '../../sim-contract/src/index.ts'
import { setRobotBase, setRobotTcp } from './authoring.ts'
import { readRobotPresets } from './presets.ts'
import type { RobotSetBaseInput, RobotSetTcpInput } from '../../lyapunov-contracts/src/robot-authoring.ts'
export interface SceneReader { snapshot(sceneId: string): Promise<SceneSnapshot> | SceneSnapshot; commit(input: SceneCommit): Promise<SceneSnapshot> | SceneSnapshot }
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
}
export function createRobotOperations(sim: SimWorlds, scene: SceneReader, hooks: RobotOperationHooks = {}) {
  return {
    // 取消信号必须传进 open：worker 启动（Isaac Kit 冷启动可达数十秒、偶发挂住）与建世界
    // 都在这一条调用里，只有把调用方的 signal 交下去，取消才能真正结束本次尚未交付的操作。
    sim_open: async (input: { sceneId: string; options?: WorldOptions }, signal?: AbortSignal) => sim.open(await scene.snapshot(input.sceneId), input.options, signal),
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
    sim_action_receipt: (input: { worldId: string; actionId: string }) => sim.receipt(input.worldId, input.actionId),
  }
}
export type RobotOperations = ReturnType<typeof createRobotOperations>
