import {G1_23_75_ID,g1Observation75,g1Targets75} from "./g1-23-75.ts"
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Frame, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { SimWorlds } from '../../sim-contract/src/index.ts'
import { matchPolicy, type PolicyMatchInput } from './match.ts'
import { type LiberoVlaAdapter, type PreparedAdapter } from './adapter.ts'
import {requirePolicyRuntime,type PolicyRuntimeConfig} from './runtime.ts'
import { asObject, checkCancelled } from './source.ts'

class CPUInference {
  private serial=0
  private pending=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void}>()
  private child:ReturnType<typeof spawn>
  readonly exited:Promise<void>
  private error=''
  /** 单次 `request()` 的接纳预算：CPU-only VLA 一次出块实测 25–55 s（L416 run B：20 块 = 25,174–52,009 ms），
   *  既有 30 s 默认值对 VLA 必然 `POLICY_CPU_TIMEOUT`；故做成构造参数（默认 30 s，Go1/WTW 分支行为逐字不变）。
   *  超时的既有语义不变：kill 子进程（超时即 poison，不留给下一次 request 复用）＋ `POLICY_CPU_TIMEOUT`。 */
  private readonly timeoutMs:number
  constructor(python:string,script='torch_cpu.py',timeoutMs=30000){
    this.timeoutMs=timeoutMs
    this.child=spawn(python,['-u',join(dirname(fileURLToPath(import.meta.url)),'../python/',script)],{stdio:['pipe','pipe','pipe'],env:{...process.env,HF_ENDPOINT:'https://hf-mirror.com',CUDA_VISIBLE_DEVICES:''}})
    this.child.stderr!.on('data',chunk=>this.error=(this.error+String(chunk)).slice(-5000))
    createInterface({input:this.child.stdout!}).on('line',line=>{try{const m=JSON.parse(line), p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result)}}catch{}})
    const fail=(message:string)=>{for(const p of this.pending.values())p.reject(new Error(message));this.pending.clear()}
    this.child.on('error',e=>fail('POLICY_CPU_START_FAILED: '+e.message))
    this.exited=new Promise(done=>{this.child.on('exit',()=>{fail('POLICY_CPU_EXITED: '+this.error);done()});this.child.on('error',()=>done())})
  }
  request(input:Record<string,unknown>,signal:AbortSignal):Promise<any>{
    checkCancelled(signal)
    const id=++this.serial
    return new Promise((resolve,reject)=>{
      const abort=()=>{end();this.pending.delete(id);this.child.kill('SIGTERM');reject(new Error('POLICY_CANCELLED'))}
      const timer=setTimeout(()=>{this.pending.delete(id);this.child.kill('SIGTERM');reject(new Error('POLICY_CPU_TIMEOUT'))},this.timeoutMs)
      const end=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort)}
      this.pending.set(id,{resolve:x=>{end();resolve(x)},reject:e=>{end();reject(e)}})
      signal.addEventListener('abort',abort,{once:true})
      this.child.stdin!.write(JSON.stringify({id,...input})+'\n',e=>{if(e){end();this.pending.delete(id);reject(e)}})
    })
  }
  async close(){this.child.stdin?.end();if(this.child.exitCode===null)this.child.kill('SIGTERM');await this.exited}
}
export function policyObservation(adapter:PreparedAdapter,frame:Frame,entityId:string,command:number[],previous:number[],startTime:number,history:number[][]=[]){
  if(adapter.adapter===G1_23_75_ID)return g1Observation75(adapter,frame,entityId,command,previous)
  const observed=frame.entities.find(e=>e.entityId===entityId), joints=observed?.joints, free=observed?.sensors?.freeBase as any
  const expectedNames=adapter.jointNames
  if(!joints||!free||!Array.isArray(joints.names)||joints.names.length!==expectedNames.length)throw new Error('POLICY_OBSERVATION_UNAVAILABLE')
  const uniqueObserved=new Set(joints.names)
  if(uniqueObserved.size!==joints.names.length||expectedNames.length!==new Set(expectedNames).size)throw new Error('POLICY_JOINT_SET_INVALID')
  const indices=expectedNames.map(name=>joints.names.indexOf(name))
  if(indices.some(i=>i<0)||new Set(indices).size!==expectedNames.length)throw new Error('POLICY_JOINT_SET_MISMATCH')
  if(joints.positions.length!==joints.names.length||joints.velocities.length!==joints.names.length)throw new Error('POLICY_OBSERVATION_UNAVAILABLE')
  const [x,y,z,w]=free.quaternionXyzw,c=adapter.config
  if(adapter.inferenceFormat==='onnx'){
    if(indices.some(i=>i<0)||!frame.contacts)throw new Error('POLICY_OBSERVATION_UNAVAILABLE: 需要完整关节和真实接触帧')
    const contacts=(c.footGeomNames as string[]).map(name=>frame.contacts!.filter(contact=>[contact.geom1,contact.geom2].includes(entityId+'/'+name)).reduce((sum,contact)=>{if(!contact.forceN||contact.forceN.length<3||!contact.forceN.every(Number.isFinite))throw new Error('POLICY_CONTACT_FORCE_MISSING');return sum+Math.hypot(...contact.forceN)},0)>=c.contactForceThresholdN?1:0)
    const groups=[ [2*(-z*x+w*y),-2*(z*y+w*x),1-2*(w*w+z*z)],free.angularVelocityLocalRadps,command,indices.map((j,i)=>joints.positions[j]!-c.default_angles[i]),indices.map(j=>joints.velocities[j]!),previous,contacts ]
    const obs=groups.flatMap((group:number[],i)=>{const prior=history[i]??Array(group.length).fill(0);history[i]=[...group];return [...prior,...group]})
    if(obs.length!==c.num_obs||!obs.every(Number.isFinite))throw new Error('POLICY_OBSERVATION_INVALID')
    return obs
  }
  const period=adapter.observations.phasePeriodS!,phase=((frame.simTime-startTime)%period)/period
  const obs=[...free.angularVelocityLocalRadps.map((v:number)=>v*c.ang_vel_scale),2*(-z*x+w*y),-2*(z*y+w*x),1-2*(w*w+z*z),...command.map((v,i)=>v*c.cmd_scale[i]),...indices.map((j,i)=>(joints.positions[j]!-c.default_angles[i])*c.dof_pos_scale),...indices.map(j=>joints.velocities[j]!*c.dof_vel_scale),...previous,Math.sin(2*Math.PI*phase),Math.cos(2*Math.PI*phase)]
  if(obs.length!==c.num_obs||!obs.every(Number.isFinite))throw new Error('POLICY_OBSERVATION_INVALID')
  return obs
}
/**
 * history-conditioned 策略的单帧观测（WTW 70 维）：重力(3) + 命令*尺度(15) + 关节位置(12) + 关节速度(12)
 * + 上一动作(12) + 上上动作(12) + 时钟(4)，顺序与拼接取自 `legged_gym/envs/base/legged_robot.py:319-338`。
 * **只在 adapter 用 `observations.inference='torchscript-adaptation'` 显式声明自定义契约时调用**；
 * 其它策略仍走 `policyObservation`（单帧 59 维）的原有路径，行为逐字不变。
 */
export function wtwObservationFrame(adapter:PreparedAdapter,frame:Frame,entityId:string,command:number[],actions:number[][],startTime:number):number[]{
  const observed=frame.entities.find(e=>e.entityId===entityId),joints=observed?.joints,free=observed?.sensors?.freeBase as any
  const expectedNames=adapter.jointNames,c=adapter.config as any,o=adapter.observations as any,gait=o.gait
  if(!joints||!free||!Array.isArray(joints.names)||joints.names.length!==expectedNames.length)throw new Error('POLICY_OBSERVATION_UNAVAILABLE')
  const indices=expectedNames.map(name=>joints.names.indexOf(name))
  if(indices.some(i=>i<0))throw new Error('POLICY_JOINT_SET_MISMATCH')
  const [x,y,z,w]=free.quaternionXyzw
  const named=[command[0]??0,command[1]??0,command[2]??0,gait.bodyHeightOffsetM,gait.frequencyHz,gait.phase,gait.offset,gait.bound,gait.durationS,gait.footswingHeightM,gait.bodyPitchRad,gait.bodyRollRad,gait.stanceWidthM,gait.stanceLengthM,gait.auxRewardCoef]
  const scaled=named.slice(0,o.commandDimension).map((value:number,index:number)=>value*o.gaitCommandScale[index])
  // 时钟复刻 `legged_robot.py:828-861`（pacing_offset=false；duration=0.5 时 stance/swing 分段线性不改相位）
  const elapsed=((frame.simTime-startTime)*gait.frequencyHz)%1,duration=Math.min(0.999,Math.max(0.001,gait.durationS))
  const clock=[elapsed+gait.phase+gait.offset+gait.bound,elapsed+gait.offset,elapsed+gait.bound,elapsed+gait.phase].map((raw:number)=>{
    const value=((raw%1)+1)%1,warped=value<duration?value*(0.5/duration):0.5+(value-duration)*(0.5/(1-duration))
    return Math.sin(2*Math.PI*warped)
  })
  const obs=[2*(-z*x+w*y),-2*(z*y+w*x),1-2*(w*w+z*z),...scaled,...indices.map((j,i)=>(joints.positions[j]!-c.default_angles[i])*c.dof_pos_scale),...indices.map(j=>joints.velocities[j]!*c.dof_vel_scale),...(actions[0]??[]),...(actions[1]??[]),...clock]
  if(obs.length!==o.frameDimension||!obs.every(Number.isFinite))throw new Error(`POLICY_OBSERVATION_INVALID: 实得 ${obs.length} 维（期望 ${o.frameDimension}），非有限值 ${obs.filter((v:number)=>!Number.isFinite(v)).length} 个`)
  return obs
}
export interface PolicyExecutionInput extends PolicyMatchInput {worldId:string;expectedGeneration:number;durationS?:number;command?:number[];runId?:string}
export async function executePolicy(config:{dataDirectory:string}&PolicyRuntimeConfig,input:PolicyExecutionInput,scene:{inspect(id:string):SceneSnapshot|Promise<SceneSnapshot>},sim:SimWorlds,signal:AbortSignal){
  const match=await matchPolicy(config,input,scene,sim)
  if(match.status!=='MATCHED')throw new Error('POLICY_MATCH_BLOCKED: '+JSON.stringify(match.differences))
  // DEV-028 条件③：VLA（LIBERO×SmolVLA）派生件没有关节级 PreparedAdapter，走**并列**的 VLA 执行分支；
  // 其余情况（既无 adapter 也无 vlaAdapter）保持原有明确失败，Go1/WTW 分支的行为逐字不变。
  if(!match.adapter){
    const vlaAdapter=match.vlaAdapter
    if(vlaAdapter)return executeLiberoVlaPolicy(config,input,scene,sim,signal,{vlaAdapter,manifestPath:match.manifestPath,...(match.sceneRevision===undefined?{}:{sceneRevision:match.sceneRevision}),...(match.resolvedRevision===undefined?{}:{resolvedRevision:match.resolvedRevision})})
    throw new Error('POLICY_MATCH_BLOCKED: '+JSON.stringify(match.differences))
  }
  const g1Experimental=match.adapter.adapter===G1_23_75_ID,duration=input.durationS??(g1Experimental?3:4),command=input.command??[g1Experimental?.3:.5,0,0]
  if(!Number.isFinite(duration)||duration<.02||duration>300)throw new Error('POLICY_DURATION_INVALID')
  if(command.length!==3||!command.every(x=>Number.isFinite(x)&&Math.abs(x)<=1))throw new Error('POLICY_COMMAND_INVALID')
  const a=match.adapter,c=a.config,period=c.simulation_dt*c.control_decimation,cycles=Math.ceil(duration/period),runId=input.runId??'policy-'+randomUUID()
  // 自定义观测契约（当前只有 WTW 声明）：缺字段 ⇒ 保持原单帧路径逐字不变。
  const custom=a.observations as any,twoStage=custom?.inference==='torchscript-adaptation'&&Number.isInteger(custom?.historyFrames)
  const initial=await sim.observe(input.worldId,{entityIds:[input.entityId],sensors:true,contacts:true})
  if(a.adapter===G1_23_75_ID)g1Observation75(a,initial,input.entityId,command,Array(23).fill(0))
  const outputDir=join(config.dataDirectory,'policy-runs',runId);await mkdir(outputDir,{recursive:true})
  const runtime=await requirePolicyRuntime(config,a.adapter)
  const trace=await open(join(outputDir,'trace.jsonl'),'w'),cpu=new CPUInference(runtime.python)
  let frame=initial,action=Array(c.num_actions).fill(0),targets=[...c.default_angles],controls=0,inferences=0,peakJointDelta=0,peakTranslationM=0,cpuInfo:any,error:string|undefined,status='COMPLETED',stop:any
  let lastActionId:string|undefined;const history:number[][]=[]
  let prevAction=Array(c.num_actions).fill(0) as number[],wtwHistory:number[]|undefined
  const initialEntity=initial.entities.find(e=>e.entityId===input.entityId)!
  try{
    cpuInfo=await cpu.request({method:'load',weightsPath:a.weightsPath,format:twoStage?'torchscript-adaptation':(a.inferenceFormat??'torchscript'),...(twoStage?{adaptationPath:custom.adaptationWeightsPath}:{})},signal)
    for(let cycle=0;cycle<cycles;cycle++){
      checkCancelled(signal)
      if((await scene.inspect(input.sceneId)).revision!==match.sceneRevision)throw new Error('POLICY_SCENE_REVISION_CHANGED')
      if(frame.generation!==input.expectedGeneration||frame.sceneRevision!==match.sceneRevision)throw new Error('POLICY_WORLD_BINDING_CHANGED')
      let observation:number[]
      if(a.inferenceFormat==='onnx'){
        observation=policyObservation(a,frame,input.entityId,command,action,initial.simTime,history)
        action=await cpu.request({method:'infer',observation,actions:c.num_actions},signal);inferences++
        targets=action.map((v:number,i:number)=>Math.max(-1000,Math.min(1000,v))*c.action_scale+c.default_angles[i])
      }
      lastActionId=runId+'-'+cycle
      const receipt=await sim.execute(input.worldId,{kind:'control',actionId:lastActionId,expectedGeneration:input.expectedGeneration,entityId:input.entityId,jointNames:a.jointNames,positions:targets,stepCount:c.control_decimation},signal)
      if(receipt.status==='cancelled'||signal.aborted){status='CANCELLED';if(receipt.finalState)frame=receipt.finalState;break}
      if(receipt.status!=='completed'||!receipt.finalState)throw new Error('POLICY_CONTROL_FAILED: '+JSON.stringify(receipt))
      const previousFrame=frame;frame=a.adapter===G1_23_75_ID?await sim.observe(input.worldId,{entityIds:[input.entityId],sensors:true,contacts:true}):receipt.finalState;controls++
      if(frame.stepIndex-previousFrame.stepIndex!==c.control_decimation||Math.abs(frame.simTime-previousFrame.simTime-period)>1e-8)throw new Error('POLICY_CONTROL_FREQUENCY_DRIFT')
      const e=frame.entities.find(e=>e.entityId===input.entityId)!
      peakJointDelta=Math.max(peakJointDelta,...e.joints!.positions.map((q,i)=>Math.abs(q-initialEntity.joints!.positions[i]!)))
      peakTranslationM=Math.max(peakTranslationM,Math.hypot(...e.transform.position.map((p,i)=>p-initialEntity.transform.position[i]!)))
      if(twoStage){
        // 每帧 70 维 → 30 帧滚动历史 = adaptation 的 2100 维输入。历史**前端补零**（R8）：与训练
        // `history_wrapper.py:16,24`（zeros 初始化 + 每步 `cat(obs_history[:, num_obs:], obs)` 尾插一帧）
        // 和 deploy（`deployment_runner.py` reset 后 `obs_history` 全零、逐帧填充）一致；R7 的"首帧铺满"已弃用。
        const single=wtwObservationFrame(a,frame,input.entityId,command,[action,prevAction],initial.simTime)
        const inferenceInput:number[]=wtwHistory===undefined?[...Array((custom.historyFrames-1)*custom.frameDimension).fill(0),...single]:[...wtwHistory.slice(custom.frameDimension),...single]
        wtwHistory=inferenceInput;observation=single
        prevAction=action
        action=await cpu.request({method:'infer',observation:inferenceInput,actions:c.num_actions},signal);inferences++
        // ③ 动作后处理（训练 `legged_robot.py:65-67`、deploy `lcm_agent.py step()`）：策略输出先 clip 到
        // ±clip_actions，clip 后的值才写回 previousAction 槽位并参与缩放（无 deadzone；力矩限幅在派生 MJCF
        // 的执行器 forcerange 上，见 prepare_wtw.py）。
        const clipActions=c.clip_actions??Infinity
        action=action.map((v:number)=>Math.max(-clipActions,Math.min(clipActions,v)))
        // `legged_robot.py:919-920`：先乘 action_scale，再对髋关节（dof 序 [0,3,6,9]）乘 hip_scale_reduction。
        targets=action.map((v:number,i:number)=>v*c.action_scale*((c.hip_action_indices??[]).includes(i)?c.hip_scale_reduction??1:1)+c.default_angles[i])
      }else if(a.inferenceFormat!=='onnx'){
        observation=policyObservation(a,frame,input.entityId,command,action,initial.simTime)
        action=await cpu.request({method:'infer',observation,actions:c.num_actions},signal);inferences++
        targets=a.adapter===G1_23_75_ID?g1Targets75(a,action):action.map((v:number,i:number)=>v*c.action_scale+c.default_angles[i])
      }
      await trace.write(JSON.stringify({cycle,stepIndex:frame.stepIndex,simTime:frame.simTime,frame,observation:observation!,action,targets,receipt:{actionId:receipt.actionId,startStep:receipt.startStep,endStep:receipt.endStep,status:receipt.status}})+'\n')
    }
  }catch(caught){status=signal.aborted?'CANCELLED':'FAILED';error=String(caught)}
  finally{
    // 物理所有者原子检查代次与最后接纳的actionId，旧run不按实体泛停后续用户动作。
    if(lastActionId){
      try{stop=await sim.stop(input.worldId,{actionId:lastActionId,expectedGeneration:input.expectedGeneration})}
      catch(caught){
        const code=(caught as {code?:string}).code
        if(code==='STALE_GENERATION'||code==='ACTION_NOT_FOUND')stop={status:'SKIPPED',reason:code,actionId:lastActionId,expectedGeneration:input.expectedGeneration}
        else{stop={status:'FAILED',reason:String(caught)};error=error??String(caught);if(status==='COMPLETED')status='FAILED'}
      }
    }else stop={status:'NOT_REQUIRED',reason:'NO_ACTION_SUBMITTED'}
    await cpu.close();await trace.close()
  }
  const result={status,runId,outputDir,provider:input.provider,modelId:input.modelId,revision:match.resolvedRevision,adapter:a.adapter,worldId:input.worldId,sceneId:input.sceneId,entityId:input.entityId,worldGeneration:input.expectedGeneration,sceneRevision:match.sceneRevision,device:'cpu',runtime,cpu:cpuInfo,command,frequencyHz:a.frequencyHz,controls,inferences,physicsSteps:frame.stepIndex-initial.stepIndex,simulatedDurationS:frame.simTime-initial.simTime,peakJointDeltaRad:peakJointDelta,peakTranslationM,initialState:initial,finalState:frame,stop,error,completedAt:new Date().toISOString()}
  await writeFile(join(outputDir,'result.json'),JSON.stringify(result,null,2)+'\n')
  return result
}

/** VLA 执行契约读数：全部来自 `derived/adapter.json`（产品 `prepare_libero_vla.py` 产出）。缺任何一项 ⇒
 *  明确失败——不从"看起来能跑"的默认常量兜底（DEV-028 条件③ 的判据化要求：缺口存在时必然失败）。 */
export function vlaExecutionContract(adapter:LiberoVlaAdapter){
  const semantics=asObject(adapter.controlSemantics),format=asObject(adapter.inferenceFormat),state=asObject(adapter.observations?.state)
  const actionDim=adapter.actionDim,chunkSteps=Number(format.nActionSteps),frequencyHz=adapter.frequencyHz
  if(!Number.isInteger(actionDim)||actionDim<=0)throw new Error('POLICY_VLA_CONTRACT_INVALID: actionDim='+String(actionDim))
  if(!Number.isInteger(chunkSteps)||chunkSteps<=0)throw new Error('POLICY_VLA_CONTRACT_INVALID: inferenceFormat.nActionSteps='+String(format.nActionSteps))
  if(!Number.isFinite(frequencyHz)||frequencyHz<=0)throw new Error('POLICY_VLA_CONTRACT_INVALID: frequencyHz='+String(frequencyHz))
  const shape=Array.isArray(state.shape)?state.shape.map(Number):[]
  if(shape.length!==1||shape[0]!==3+3+2)throw new Error('POLICY_VLA_CONTRACT_INVALID: observations.state.shape='+JSON.stringify(state.shape))
  const axisNames=Array.isArray(semantics.axisNames)&&semantics.axisNames.length===actionDim?semantics.axisNames.map(String):Array.from({length:actionDim},(_value,index)=>'action_'+index)
  return {actionDim,chunkSteps,periodS:1/frequencyHz,axisNames}
}
/** 官方 bench Frame → VLA 观测（`benchmark-libero/python/worker.py:492-500` 的 sensors 口径）。
 *  缺任何一路（含真腕图像 path）⇒ 显式失败：不允许用别的相机冒充、也不允许静默补零。 */
export function vlaObservation(frame:Frame,entityId:string){
  const sensors=asObject(frame.entities.find(entity=>entity.entityId===entityId)?.sensors)
  const vector=(key:string,dimension:number)=>{const value=sensors[key];if(!Array.isArray(value)||value.length!==dimension||!value.every(item=>Number.isFinite(item)))throw new Error(`POLICY_VLA_OBSERVATION_UNAVAILABLE: sensors.${key} 需 ${dimension} 个有限值，实得 ${JSON.stringify(value)}`);return value.map(Number)}
  const image=(key:string)=>{const path=asObject(sensors[key]).path;if(typeof path!=='string'||!path)throw new Error(`POLICY_VLA_OBSERVATION_UNAVAILABLE: sensors.${key}.path 缺失（官方帧未给出该相机图像的落盘路径）`);return path}
  return {eef:vector('eefPositionM',3),quatXyzw:vector('eefQuaternionXyzw',4),gripper:vector('gripperQpos',2),imagePath:image('agentview_image'),wristImagePath:image('wrist_image')}
}
/** 推理回包 → **展平动作数组**（`vlaChunkQueue` 的入参），把两种既成回包形状显式归一化。
 *
 *  - 裸数组：`python/torch_cpu.py` 的既有 harness 形态（也是 L418 单测桩的形态）——原样返回；
 *  - `{values:[…],steps:n,actionDim:d}`：产品模块 `python/libero_vla_infer_server.py:280` 的回包形态
 *    （L416 交付，`python/**` 属跨 lane 只读区；L419 在真实 dev 宿主里实测到 `infer` 回的就是这个对象，
 *    而消费侧若按裸数组读会以 `POLICY_VLA_ACTION_SHAPE_INVALID: 推理回包 非数组…` 在**第一次出块**就 FAILED）。
 *
 *  对象形态只接受自洽的回包：`values` 是数组、`steps` 正整数、`actionDim` 与执行契约一致、
 *  `values.length===steps×actionDim`；任何一项不符 ⇒ 明确失败（不猜、不截断、不丢 `steps`）。
 *  维数上界与有限性仍由 `vlaChunkQueue` 按 `nActionSteps` 判（判据只有一处）。 */
export function vlaActionValues(reply:unknown,actionDim:number):unknown{
  if(!reply||typeof reply!=='object'||Array.isArray(reply))return reply
  const row=asObject(reply),values=row.values
  if(!Array.isArray(values))throw new Error('POLICY_VLA_ACTION_SHAPE_INVALID: 推理回包对象缺 values 数组：'+JSON.stringify(reply).slice(0,200))
  const steps=Number(row.steps),declared=Number(row.actionDim)
  if(!Number.isInteger(steps)||steps<=0)throw new Error('POLICY_VLA_ACTION_SHAPE_INVALID: 回包 steps 非法：'+JSON.stringify(row.steps))
  if(!Number.isInteger(declared)||declared!==actionDim)throw new Error(`POLICY_VLA_ACTION_SHAPE_INVALID: 回包 actionDim=${JSON.stringify(row.actionDim)} 与执行契约 ${actionDim} 不符`)
  if(values.length!==steps*actionDim)throw new Error(`POLICY_VLA_ACTION_SHAPE_INVALID: 回包 values=${values.length} 与 steps×actionDim=${steps}×${actionDim}=${steps*actionDim} 不符`)
  return values
}
/** 推理回包 → 控制步动作队列。检查点声明的 `nActionSteps` 是**上界**：超过即契约不符，不静默截断。 */
export function vlaChunkQueue(values:unknown,actionDim:number,chunkSteps:number):number[][]{
  if(!Array.isArray(values)||!values.length||values.length%actionDim!==0)throw new Error(`POLICY_VLA_ACTION_SHAPE_INVALID: 推理回包 ${Array.isArray(values)?values.length:'非数组'} 不是 ${actionDim} 的正整数倍`)
  const steps=values.length/actionDim
  if(steps>chunkSteps)throw new Error(`POLICY_VLA_ACTION_SHAPE_INVALID: 推理回包 ${steps} 步超过检查点声明的 nActionSteps=${chunkSteps}`)
  const queue:number[][]=[]
  for(let step=0;step<steps;step++){
    const slice=values.slice(step*actionDim,(step+1)*actionDim)
    if(!slice.every(value=>typeof value==='number'&&Number.isFinite(value)))throw new Error('POLICY_VLA_ACTION_NOT_FINITE: '+JSON.stringify(slice))
    queue.push(slice as number[])
  }
  return queue
}
/** DEV-028 条件③ 的产品侧后半段：**VLA（LIBERO×SmolVLA）执行分支**，与既有 Go1/WTW 分支并列。
 *
 *  - 观测：官方 bench Frame 的 `sensors.{eefPositionM(3),eefQuaternionXyzw(4),gripperQpos(2)}` ＋
 *    `agentview_image.path` / `wrist_image.path`（`worker.py:492-500`）；
 *  - 动作：7 维 OSC delta，**复用既有** `sim.execute({kind:'control',positions,stepCount:1})` 通路
 *    （官方 `operations.ts:617-618` 把 `positions` 当 `values`，不新造第二套执行通路）；
 *  - 推理：产品模块 `python/libero_vla_infer_server.py`（与 `torch_cpu.py` **同构**的 JSON 行协议，
 *    因此 `CPUInference` harness 只换脚本名，spawn/读写/id 关联逐字不变）；
 *  - 出块预算：`vlaInferenceTimeoutMs()`（默认 15 min，可由 `LYAPUNOV_VLA_INFER_TIMEOUT_MS` 覆盖）——
 *    实测 25–55 s/块，用 harness 的 30 s 默认值必然 `POLICY_CPU_TIMEOUT`；其它分支读不到这个预算；
 *  - 出块：按检查点声明的 `inferenceFormat.nActionSteps` 排队（本 pin 实测声明 50；以派生件为准，不写死常量）；
 *  - 周期：`sim.execute(stepCount:1)` 的步进/周期断言与 `timestepS=1/20`、`simTime=stepIndex/20`
 *    （`operations.ts:248` 与 task 的 `controlFrequencyHz=20`）天然自洽，漂移即失败；
 *  - 终态：成功/超时都**不改写**官方终态，也不额外调 `sim.stop`（`stop` 会把未终结 episode 改写成
 *    cancelled，从而抹掉官方 `terminationReason`）；取消由 `sim.execute` 的 signal 语义负责。
 */
/** VLA 单次出块的 CPU 推理预算（`CPUInference` 构造参数，非全局常量）。
 *
 *  - 默认 **15 min**：实测每块 25–55 s（L416 run B：`inferTotalMs=727.3 s` / 20 块，max 52.0 s；L405 53.9–57.3 s），
 *    30 s 默认值下**每一次**出块都会 timeout ⇒ 该分支等于不可用；
 *  - `LYAPUNOV_VLA_INFER_TIMEOUT_MS` 可覆盖（只接受正整数，非法值回落默认——不静默取 0/NaN 当"无限等"）；
 *  - **只**被 VLA 分支读取：Go1/WTW 分支仍用 `CPUInference` 的 30 s 默认值，行为逐字不变。 */
export function vlaInferenceTimeoutMs(raw=process.env.LYAPUNOV_VLA_INFER_TIMEOUT_MS){
  const value=Number(raw)
  return Number.isInteger(value)&&value>0?value:900000
}
export async function executeLiberoVlaPolicy(config:{dataDirectory:string}&PolicyRuntimeConfig,input:PolicyExecutionInput,scene:{inspect(id:string):SceneSnapshot|Promise<SceneSnapshot>},sim:SimWorlds,signal:AbortSignal,match:{vlaAdapter:LiberoVlaAdapter;manifestPath:string;sceneRevision?:number;resolvedRevision?:string}){
  const adapter=match.vlaAdapter,contract=vlaExecutionContract(adapter),period=contract.periodS
  // 默认跑满 libero_goal 的官方 horizon（1000 步 @20Hz = 50s）；显式 durationS 仍受既有 0.02..300 边界约束。
  const duration=input.durationS??50
  if(!Number.isFinite(duration)||duration<.02||duration>300)throw new Error('POLICY_DURATION_INVALID')
  const cycles=Math.ceil(duration/period),runId=input.runId??'policy-'+randomUUID(),policyDir=dirname(match.manifestPath)
  const task=asObject(adapter.task).languageInstruction,depsPath=process.env.LYAPUNOV_LIBERO_VLA_PYDEPS
  const outputDir=join(config.dataDirectory,'policy-runs',runId);await mkdir(outputDir,{recursive:true})
  const runtime=await requirePolicyRuntime(config,'libero-smolvla-v1')
  const trace=await open(join(outputDir,'trace.jsonl'),'w'),cpu=new CPUInference(runtime.python,'libero_vla_infer_server.py',vlaInferenceTimeoutMs())
  const queue:number[][]=[]
  let frame=await sim.observe(input.worldId,{entityIds:[input.entityId],sensors:true})
  const initial=frame,initialEntity=frame.entities.find(entity=>entity.entityId===input.entityId)
  if(!initialEntity)throw new Error('POLICY_VLA_OBSERVATION_UNAVAILABLE: 初始帧无实体 '+input.entityId)
  let controls=0,inferences=0,peakTranslationM=0,status='COMPLETED',error:string|undefined,lastActionId:string|undefined,termination:string|undefined,cpuInfo:any
  try{
    cpuInfo=await cpu.request({method:'load',format:'libero-vla',adapterPath:join(policyDir,'derived','adapter.json'),policyDir,...(typeof task==='string'&&task?{task}:{}),...(depsPath?{depsPath}:{})},signal)
    for(let cycle=0;cycle<cycles;cycle++){
      checkCancelled(signal)
      // M2（scene 口径，与 `match.ts` 同一判据、同一权威）：官方套件 world 的官方 sceneId 含 `/`，会话命名空间里
      // 落盘的是 namespaced 投影文档（`benchmark-libero/src/scene-projection.ts:27-29`）⇒ `scene.inspect(官方 id)`
      // 恒 `INVALID_ID`，拿它当每周期判据会让整条 VLA 路由在第一步就 FAILED。场景权威在官方路由上是 **world 句柄**
      // 的 `appliedSceneRevision`（bench_load 回执与 match.ts 的 `sceneRevision` 同源）。因此：会话文档读得到就
      // 复核它，读不到（官方 id）就复核 world 句柄 —— 两者都对不上仍然失败，不静默放行。
      let sceneRevision:number|undefined
      try{sceneRevision=(await scene.inspect(input.sceneId)).revision}catch{sceneRevision=undefined}
      if(sceneRevision===undefined)sceneRevision=(await sim.listWorlds()).find(candidate=>candidate.worldId===input.worldId)?.appliedSceneRevision
      if(sceneRevision!==match.sceneRevision)throw new Error('POLICY_SCENE_REVISION_CHANGED')
      if(frame.generation!==input.expectedGeneration||frame.sceneRevision!==match.sceneRevision)throw new Error('POLICY_WORLD_BINDING_CHANGED')
      if(!queue.length){
        const values=await cpu.request({method:'infer',actions:contract.actionDim,observation:vlaObservation(frame,input.entityId)},signal);inferences++
        // 产品模块回 `{values,steps,actionDim}`、既有 harness 回裸数组：两种形状都在这里归一化（`vlaActionValues`）。
        queue.push(...vlaChunkQueue(vlaActionValues(values,contract.actionDim),contract.actionDim,contract.chunkSteps))
      }
      const action=queue.shift()!
      lastActionId=runId+'-'+cycle
      // 既有执行通路：官方套件把 positions 当 values 转发给 worker（operations.ts:617-618），stepCount=1 ⇒ 一个控制周期一步。
      const receipt=await sim.execute(input.worldId,{kind:'control',actionId:lastActionId,expectedGeneration:input.expectedGeneration,entityId:input.entityId,jointNames:contract.axisNames,positions:action,stepCount:1},signal)
      if(receipt.status==='cancelled'||signal.aborted){status='CANCELLED';if(receipt.finalState)frame=receipt.finalState;break}
      if(receipt.status!=='completed'||!receipt.finalState)throw new Error('POLICY_VLA_CONTROL_FAILED: '+JSON.stringify(receipt))
      const previousFrame=frame;frame=receipt.finalState;controls++
      if(frame.stepIndex-previousFrame.stepIndex!==1||Math.abs(frame.simTime-previousFrame.simTime-period)>1e-8)throw new Error('POLICY_VLA_FREQUENCY_DRIFT')
      const entity=frame.entities.find(item=>item.entityId===input.entityId)
      if(!entity)throw new Error('POLICY_VLA_OBSERVATION_UNAVAILABLE: 回执帧无实体 '+input.entityId)
      peakTranslationM=Math.max(peakTranslationM,Math.hypot(...entity.transform.position.map((value,index)=>value-initialEntity.transform.position[index]!)))
      const benchmarkStatus=typeof receipt.effect?.benchmarkStatus==='string'?receipt.effect.benchmarkStatus:undefined
      await trace.write(JSON.stringify({cycle,stepIndex:frame.stepIndex,simTime:frame.simTime,action,queueRemaining:queue.length,receipt:{actionId:receipt.actionId,startStep:receipt.startStep,endStep:receipt.endStep,status:receipt.status,taskAchieved:receipt.taskAchieved??false,reason:receipt.reason,benchmarkStatus}})+'\n')
      if(receipt.taskAchieved===true||benchmarkStatus==='success'){termination=receipt.reason??'check_success';break}
      if(benchmarkStatus==='timeout'||benchmarkStatus==='cancelled'){termination=benchmarkStatus;if(benchmarkStatus==='cancelled')status='CANCELLED';break}
    }
    if(status==='COMPLETED'&&termination===undefined)termination='duration-exhausted'
  }catch(caught){status=signal.aborted?'CANCELLED':'FAILED';error=String(caught)}
  finally{await cpu.close();await trace.close()}
  const result={status,runId,outputDir,provider:input.provider,modelId:input.modelId,revision:match.resolvedRevision,adapter:adapter.adapter,executionBranch:'vla-osc-pose-delta',worldId:input.worldId,sceneId:input.sceneId,entityId:input.entityId,worldGeneration:input.expectedGeneration,sceneRevision:match.sceneRevision,device:'cpu',runtime,cpu:cpuInfo,actionDim:contract.actionDim,chunkSteps:contract.chunkSteps,frequencyHz:1/period,controls,inferences,physicsSteps:frame.stepIndex-initial.stepIndex,simulatedDurationS:frame.simTime-initial.simTime,peakTranslationM,termination,initialState:initial,finalState:frame,error,completedAt:new Date().toISOString()}
  await writeFile(join(outputDir,'result.json'),JSON.stringify(result,null,2)+'\n')
  return result
}
