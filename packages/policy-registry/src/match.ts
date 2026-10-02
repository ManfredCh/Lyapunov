import {g1MatchDifferences75}from "./g1-23-75.ts"
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds, RobotDescription } from '../../sim-contract/src/index.ts'
import { asObject, hashFile } from './source.ts'
import { isLiberoVlaAdapter, isPreparedAdapter, readAdapter, verifyPolicy, type PolicyIdentity } from './adapter.ts'
export interface PolicyMatchInput extends PolicyIdentity { sceneId:string;entityId:string;worldId?:string;expectedGeneration?:number }
export interface PolicyMatchDifference {path:string;reason:string;expected?:unknown;actual?:unknown}
export type PolicyMatchResult = Awaited<ReturnType<typeof matchPolicy>>
/** 缺 world 参数时只使用本会话唯一、同 Scene 的真实句柄；多世界不猜，不改显式绑定。 */
export async function resolvePolicyWorldBinding<T extends PolicyMatchInput>(input:T,sim?:Pick<SimWorlds,'listWorlds'>):Promise<T & PolicyMatchInput> {
  if(input.worldId||!input.sceneId||!input.entityId||!sim)return input
  const worlds=(await sim.listWorlds()).filter(w=>w.sceneId===input.sceneId)
  if(worlds.length!==1||!Number.isSafeInteger(worlds[0]!.worldGeneration))return input
  const world=worlds[0]!
  return {...input,worldId:world.worldId,expectedGeneration:input.expectedGeneration??world.worldGeneration}
}
/** 官方 LIBERO 套件控制器契约（M1 的判据锚点）：**不 import `benchmark-libero`**（不新增包依赖），逐字段
 *  抄自 `packages/benchmark-libero/src/catalog.ts:183-190` 的 `task.action` 与 `:182` 的
 *  `task.observation.fields`——也就是 `src/operations.ts:577` 的 `describe().controller` 原样返回值。
 *  官方侧改维数/改单位/改帧约定/改观测字段 ⇒ 这里逐字段对账必然 BLOCKED（漂移即失败，不静默放行）。 */
const OFFICIAL_LIBERO_CONTROLLER = {
  engineId: 'official-suite',
  kind: 'controller',
  dimensions: 7,
  units: ['normalized world dx [-1,1] -> ±0.05 m', 'normalized world dy [-1,1] -> ±0.05 m', 'normalized world dz [-1,1] -> ±0.05 m', 'normalized world droll [-1,1] -> ±0.5 rad', 'normalized world dpitch [-1,1] -> ±0.5 rad', 'normalized world dyaw [-1,1] -> ±0.5 rad', 'gripper open_close [-1,1]'],
  controlFrequencyHz: 20,
  coordinateFrame: 'world-frame Cartesian position delta and world-frame axis-angle delta',
  axisNames: ['controller_dx', 'controller_dy', 'controller_dz', 'controller_droll', 'controller_dpitch', 'controller_dyaw', 'gripper_open_close'],
  observationFields: ['agentview_image', 'robot0_eef_pos', 'robot0_eef_quat', 'robot0_gripper_qpos', 'robot0_joint_pos', 'objects.*_pos', 'objects.*_quat', 'objects.*_to_robot0_eef_pos', 'objects.*_to_robot0_eef_quat'],
}
export async function matchPolicy(config:{dataDirectory:string},input:PolicyMatchInput,scene:{inspect(sceneId:string):Promise<SceneSnapshot>|SceneSnapshot},sim?:Pick<SimWorlds,'describe'|'observe'|'listWorlds'>) {
  const differences:PolicyMatchDifference[]=[]
  /** 键序无关的规范化：场景文档按字典序存键、适配器按语义序写键，两者内容相同却 JSON.stringify 不同 ⇒ 会报假
   *  `OBSERVATION_MAPPING_MISMATCH` 并把整条执行链永远挡在 MATCHED 之外。只比较内容，不比较键的书写顺序。 */
  const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,(item as Record<string,unknown>)[key]])):item)
  const compare=(path:string,expected:unknown,actual:unknown,reason='VALUE_MISMATCH')=>{if(expected===undefined || canonical(expected)!==canonical(actual))differences.push({path,reason,...(expected===undefined?{}:{expected}),...(actual===undefined?{}:{actual})})}
  const verified=await verifyPolicy(config.dataDirectory,input), manifest=verified.manifest
  if(!verified.valid)differences.push({path:'manifest',reason:'MANIFEST_NOT_VERIFIED',actual:verified})
  // M2（官方套件 scene 口径）：官方 bench world 的场景**权威是 world 句柄**——`bench_load` 回执的 `sceneId` 是
  // 官方 id（含 `/`）、`appliedSceneRevision=1`；会话命名空间里落盘的投影文档只服务 Viewer，id 被
  // `benchmark-libero/src/scene-projection.ts:27-29` 映射成 namespaced（`libero_goal-turn_on_the_stove`），
  // 而 `scene.inspect(官方 id)` 直接 `INVALID_ID`（scene-kit `safeId` 不接受 `/`）⇒ 拿会话 scene 文档当判据
  // 恒生三条假差异（`SCENE_UNREADABLE`/`ENTITY_NOT_FOUND`/`SCENE_REVISION_MISMATCH`；L416 §④-e 与 L419 在
  // 运行中产物实测）。真缺口在 `packages/benchmark-libero/**`（禁写区：桥不回交官方 id↔namespaced id 的映射），
  // 因此这里只对 **`engineId==='official-suite'` 的 world** 改用 world 句柄做场景判据（id 仍对账
  // `world.sceneId`、版本取 `world.appliedSceneRevision`）；其余 world（Go1/WTW 与 generic 分支）逐字不变。
  let sceneWorld:any
  if(input.worldId&&sim)try{sceneWorld=(await sim.listWorlds()).find(candidate=>candidate.worldId===input.worldId)}catch{}
  const officialSceneEngine=sceneWorld?.engineId==='official-suite'
  let snapshot:SceneSnapshot|undefined
  if(!officialSceneEngine)try{snapshot=await scene.inspect(input.sceneId)}catch(error){differences.push({path:'scene',reason:'SCENE_UNREADABLE',actual:String(error)})}
  const entity=snapshot?.entities.find(x=>x.entityId===input.entityId)
  if(!officialSceneEngine&&!entity)differences.push({path:'entity',reason:'ENTITY_NOT_FOUND',expected:input.entityId})
  let description:RobotDescription|undefined, world:any, frame:any
  if(!input.worldId || !sim)differences.push({path:'worldId',reason:'WORLD_REQUIRED_FOR_SAFE_MATCH'})
  else try {
    world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId)
    if(!world)throw new Error('WORLD_NOT_FOUND')
    compare('world.sceneId',input.sceneId,world.sceneId,'WORLD_SCENE_MISMATCH')
    // 官方套件 world 的场景版本由 **world 句柄**给（会话投影文档的 revision 与 `appliedSceneRevision` 同值但来源不同，
    // 且官方 id 读不到）：故不再拿 `snapshot?.revision` 当 expected，避免"官方 id 读不到 ⇒ 恒 mismatch"的假差异。
    if(!officialSceneEngine)compare('world.appliedSceneRevision',snapshot?.revision,world.appliedSceneRevision,'SCENE_REVISION_MISMATCH')
    if(input.expectedGeneration!==undefined)compare('world.worldGeneration',input.expectedGeneration,world.worldGeneration,'WORLD_GENERATION_MISMATCH')
    description=await sim.describe(input.worldId,input.entityId)
    compare('description.generation',world.worldGeneration,description.expectedGeneration,'WORLD_GENERATION_MISMATCH')
    frame=await sim.observe(input.worldId,{entityIds:[input.entityId],sensors:true})
    compare('frame.generation',world.worldGeneration,frame.generation,'WORLD_GENERATION_MISMATCH')
  }catch(error){differences.push({path:'provider',reason:'PROVIDER_DESCRIPTION_UNAVAILABLE',actual:String(error)})}
  // derived/adapter.json 有两种形状：PreparedAdapter（关节级执行适配）与 LiberoVlaAdapter（bench 链 7 维 OSC delta
  // 契约）。缺字段判别后不解引用对方形状（此前 Libero 派生件会在这里以 TypeError 崩掉）。
  const read=await readAdapter(verified.root)
  const adapter=isPreparedAdapter(read)?read:undefined
  const vlaAdapter=adapter?undefined:isLiberoVlaAdapter(read)?read:undefined
  let policyConfig:Record<string,any>|undefined
  if(adapter){
    compare('adapter.sourceModelId',manifest?.modelId,adapter.sourceModelId,'ADAPTER_SOURCE_MISMATCH')
    compare('adapter.sourceRevision',manifest?.resolvedRevision,adapter.sourceRevision,'ADAPTER_SOURCE_MISMATCH')
    compare('controller.robot',adapter.robot,entity?.components.controller?.robot,'ROBOT_MODEL_MISMATCH')
    compare('controller.scene.frequencyHz',adapter.frequencyHz,entity?.components.controller?.frequencyHz,'CONTROL_FREQUENCY_MISMATCH')
    compare('controller.scene.controlMode',adapter.controlMode,entity?.components.controller?.controlMode,'CONTROL_MODE_MISMATCH')
    compare('controller.frequencyHz',adapter.frequencyHz,description?.controller?.frequencyHz,'CONTROL_FREQUENCY_MISMATCH')
    compare('controller.controlMode',adapter.controlMode,description?.controller?.controlMode,'CONTROL_MODE_MISMATCH')
    compare('controller.gravityCompensation',false,description?.controller?.gravityCompensation,'CONTROL_GRAVITY_MISMATCH')
    if(!(adapter.supportedEngines??[adapter.engine]).includes(world?.engineId))differences.push({path:'world.engineId',reason:'SIMULATOR_MISMATCH',expected:adapter.supportedEngines??[adapter.engine],...(world?.engineId===undefined?{}:{actual:world.engineId})})
    // Policy execution owns a fixed-step control loop on every provider.  A
    // realtime world can advance between observation and command submission.
    if(world?.clock!=='manual')differences.push({path:'world.clock',reason:'CONTROL_CLOCK_MISMATCH',expected:'manual',...(world?.clock===undefined?{}:{actual:world.clock})})
    compare('world.timestepS',adapter.config.simulation_dt,world?.timestepS,'PHYSICS_FREQUENCY_MISMATCH')
    const expectedNames=adapter.jointNames
    const unique=(xs:unknown[])=>xs.length===new Set(xs.filter(x=>typeof x==='string')).size&&xs.every(x=>typeof x==='string')
    const sameSet=(a:unknown[],b:unknown[])=>unique(a)&&unique(b)&&a.length===b.length&&a.every(x=>b.includes(x))
    if(!unique(expectedNames)||!sameSet(expectedNames,adapter.modelJointNames??expectedNames))differences.push({path:'adapter.jointNames',reason:'JOINT_SET_INVALID'})
    if(!sameSet(expectedNames,description?.controlledJointNames??[]))differences.push({path:'action.jointNames',reason:'ACTION_JOINT_SET_MISMATCH',expected:expectedNames,...(description?.controlledJointNames===undefined?{}:{actual:description.controlledJointNames})})
    for(const name of expectedNames){ const joint=description?.joints.find(j=>j.name===name);compare('joints.'+name+'.unit',adapter.unit,joint?.unit,'JOINT_UNIT_MISMATCH');compare('joints.'+name+'.controlMode',adapter.controlMode,joint?.controlMode,'CONTROL_MODE_MISMATCH') }
    compare('observations.schema',adapter.observations,entity?.components.sensor?.policyObservations,'OBSERVATION_MAPPING_MISMATCH')
    const observed=frame?.entities.find((e:any)=>e.entityId===input.entityId)
    if(!sameSet(expectedNames,observed?.joints?.names??[]))differences.push({path:'observations.jointNames',reason:'OBSERVATION_JOINT_SET_MISMATCH',expected:expectedNames,...(observed?.joints?.names===undefined?{}:{actual:observed.joints.names})})
    const free=asObject(observed?.sensors?.freeBase)
    for(const [key,n] of [['quaternionXyzw',4],['angularVelocityLocalRadps',3]] as const)if(!Array.isArray(free[key])||free[key].length!==n||!free[key].every(Number.isFinite))differences.push({path:'observations.freeBase.'+key,reason:'OBSERVATION_SOURCE_MISSING'})
    try { const engineComponent=asObject(asObject(entity?.components)[String(world?.engineId)]); const path=engineComponent.sourcePath; const actual=await hashFile(String(path));compare('model.sha256',adapter.modelSha256,actual.sha256,'ROBOT_PHYSICS_MODEL_MISMATCH') }catch(error){differences.push({path:'model',reason:'ROBOT_PHYSICS_MODEL_UNREADABLE',actual:String(error)})}
    differences.push(...g1MatchDifferences75(adapter,frame,input.entityId,description))
  }else if(vlaAdapter){
    // VLA×LIBERO（bench 链）的**可执行判据**：world 必须是官方套件世界，且官方 `describe().controller` 必须
    // 报出与官方登记逐字段一致的 7 维 OSC delta 契约 —— 对账 controller.{kind,dimensions,units,frequencyHz,
    // coordinateFrame,axisNames,observationFields}，**不走**关节序/单位/`gravityCompensation` 那套：
    // 官方套件投影没有 `components[engineId].sourcePath`（line 66 的物理模型 sha 判据），也不报
    // `gravityCompensation`（line 49），按 PreparedAdapter 形状对账必然假不等。
    // 真正不可执行的 VLA 适配器（world 不是官方套件）**仍**以 ADAPTER_KIND_NOT_EXECUTABLE 挡下（门保留）。
    const official=OFFICIAL_LIBERO_CONTROLLER,controller=asObject(description?.controller)
    if(world?.engineId!==official.engineId)differences.push({path:'adapter',reason:'ADAPTER_KIND_NOT_EXECUTABLE',expected:'官方套件 world（engineId='+official.engineId+'，控制器实报 7 维 OSC_POSE delta）',actual:{adapter:vlaAdapter.adapter,policyType:vlaAdapter.policyType,actionDim:vlaAdapter.actionDim,controlMode:vlaAdapter.controlMode,engineId:world?.engineId===undefined?'（world 不可读）':world.engineId,executionRoute:'bench_prepare→bench_catalog→bench_load→bench_step→bench_result（VLA 只在官方套件世界上可执行）'}})
    else{
      compare('controller.kind',official.kind,controller.kind,'CONTROL_MODE_MISMATCH')
      compare('controller.dimensions',official.dimensions,controller.dimensions,'ACTION_DIMENSION_MISMATCH')
      compare('vlaAdapter.actionDim',official.dimensions,vlaAdapter.actionDim,'ACTION_DIMENSION_MISMATCH')
      compare('controller.units',official.units,controller.units,'ACTION_UNIT_MISMATCH')
      compare('controller.frequencyHz',official.controlFrequencyHz,controller.frequencyHz,'CONTROL_FREQUENCY_MISMATCH')
      compare('vlaAdapter.frequencyHz',official.controlFrequencyHz,vlaAdapter.frequencyHz,'CONTROL_FREQUENCY_MISMATCH')
      compare('controller.coordinateFrame',official.coordinateFrame,controller.coordinateFrame,'ACTION_FRAME_MISMATCH')
      compare('controller.axisNames',official.axisNames,controller.axisNames,'ACTION_AXIS_MISMATCH')
      compare('controller.observationFields',official.observationFields,controller.observationFields,'OBSERVATION_MAPPING_MISMATCH')
    }
  }else{
    const configEntry=manifest?.files.find(f=>/(^|\/)config(?:uration)?\.json$/i.test(f.path))
    if(configEntry)try{policyConfig=JSON.parse(await readFile(join(verified.root,configEntry.path),'utf8'))}catch{}
    if(!policyConfig)differences.push({path:'config',reason:'POLICY_CONFIG_MISSING'})
    const cfg=asObject(policyConfig), inputs=asObject(cfg.input_features??cfg.inputFeatures), outputs=asObject(cfg.output_features??cfg.outputFeatures)
    if(!Object.keys(inputs).length)differences.push({path:'config.input_features',reason:'OBSERVATION_SCHEMA_MISSING'})
    for(const [name,raw] of Object.entries(inputs)) {
      const feature=asObject(raw), mapping=asObject(entity?.components.sensor?.policyObservations)[name]
      compare('observations.'+name,{...(feature.type===undefined?{}:{type:feature.type}),...(feature.shape===undefined?{}:{shape:feature.shape}),...(feature.semantics===undefined?{}:{semantics:feature.semantics})},mapping,'OBSERVATION_MAPPING_MISMATCH')
      if(!feature.semantics)differences.push({path:'config.input_features.'+name+'.semantics',reason:'OBSERVATION_SEMANTICS_MISSING'})
    }
    const action=asObject(Object.values(outputs).find((x:any)=>x?.type==='ACTION'))
    compare('action.dimension',description?.controlledJointNames.length,action.shape?.[0],'ACTION_DIMENSION_MISMATCH')
    compare('action.jointNames',description?.controlledJointNames,cfg.action_joint_names??cfg.joint_names,'ACTION_JOINT_ORDER_MISMATCH')
    if(!cfg.action_units)differences.push({path:'action.units',reason:'ACTION_UNITS_MISSING'})
    else compare('action.units',description?.controlledJointNames.map(n=>description.joints.find(j=>j.name===n)?.unit),cfg.action_units,'JOINT_UNIT_MISMATCH')
    compare('action.controlMode',description?.controller?.controlMode,cfg.control_mode,'CONTROL_MODE_MISMATCH')
    compare('action.frequencyHz',description?.controller?.frequencyHz,cfg.frequency_hz,'CONTROL_FREQUENCY_MISMATCH')
    const metadata=asObject(manifest?.metadata)
    const robot=metadata.robot??metadata.robotType??metadata.robot_model??metadata.robotModel
    const engine=metadata.simulator??metadata.sim??metadata.engine
    if(!robot)differences.push({path:'metadata.robot',reason:'POLICY_ROBOT_METADATA_MISSING'})
    else compare('metadata.robot',entity?.components.controller?.robot,robot,'ROBOT_MODEL_MISMATCH')
    if(!engine)differences.push({path:'metadata.simulator',reason:'POLICY_SIMULATOR_METADATA_MISSING'})
    else compare('metadata.simulator',world?.engineId,engine,'SIMULATOR_MISMATCH')
    differences.push({path:'adapter',reason:'POLICY_ADAPTER_UNAVAILABLE',actual:'此来源尚无可执行的观测和动作适配器；不能按维度硬配机器人'})
  }
  const status=differences.length?'BLOCKED' as const:'MATCHED' as const
  // 官方套件 world 的 sceneRevision 取 world 句柄（场景权威），执行分支据此逐周期复核 world 版本。
  const sceneRevision=officialSceneEngine?sceneWorld?.appliedSceneRevision:snapshot?.revision
  // 未准备的策略没有观测契约；不能把 generic config 缺项说成缺“观察供应商”。
  const diagnosticStage=!verified.valid?'POLICY_ARTIFACTS':!adapter&&!vlaAdapter?'POLICY_ADAPTER':!world?'WORLD_BINDING':differences.some(d=>d.reason==='OBSERVATION_SOURCE_MISSING')?'PROVIDER_OBSERVATION':'MODEL_AND_CONTROL'
  const preparationBlocked=diagnosticStage==='POLICY_ARTIFACTS'||diagnosticStage==='POLICY_ADAPTER'
  const diagnostics={stage:status==='MATCHED'?'READY':diagnosticStage,providerObservationAttempted:Boolean(frame),observationContractRegistered:Boolean(adapter||vlaAdapter),missingWorldBinding:!input.worldId,
    missingMeasuredObservationFields:differences.filter(d=>d.reason==='OBSERVATION_SOURCE_MISSING').map(d=>d.path),
    explanation:preparationBlocked?'策略字节/适配器尚未准备，OBSERVATION_SCHEMA_MISSING 是配置缺项；尚不能断言真实 provider 观测器缺失':!world?'先从本会话 sim_world_list 取匹配 Scene 的实际 worldId 和代次；缺世界用 sim_open，缺参数不重新下载本体':'观测和控制以当前 provider 实测字段及适配器契约核对，不用默认零向量补齐'}
  return {status,provider:input.provider??'modelscope',modelId:input.modelId,revision:input.revision??'master',...(input.sceneId===undefined?{}:{sceneId:input.sceneId}),entityId:input.entityId,manifestPath:join(verified.root,'manifest.json'),
    ...(manifest?.resolvedRevision===undefined?{}:{resolvedRevision:manifest.resolvedRevision}),
    ...(input.worldId===undefined?{}:{worldId:input.worldId}),
    ...(world?.worldGeneration===undefined?{}:{worldGeneration:world.worldGeneration}),
    ...(sceneRevision===undefined?{}:{sceneRevision}),
    ...(manifest?.metadata===undefined?{}:{metadata:manifest.metadata}),
    ...(policyConfig===undefined?{}:{config:policyConfig}),...(adapter===undefined?{}:{adapter}),...(vlaAdapter===undefined?{}:{vlaAdapter}),...(description===undefined?{}:{description}),
    diagnostics,differences,nextSteps:status==='MATCHED'?['使用 policy_execute 在当前 world、实体和代次执行；可用 policy_stop 或原生 Jobs 停止']:['先按 diagnostics.stage 处理字节/适配或真实 world 绑定，再核具体 expected/actual；不把缺参当作重新下载的依据'],execution:{status:status==='MATCHED'?'READY' as const:'BLOCKED' as const,reason:status==='MATCHED'?'已具备固定来源、真实观测与控制映射':'动作与观测语义或世界不兼容'}}
}
