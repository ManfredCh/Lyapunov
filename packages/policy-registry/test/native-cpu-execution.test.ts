/** 复用随包策略、原工具和真实 CPU 物理；缺发行供给或解释器时明确跳过。 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {MuJoCoProvider} from '../../sim-mujoco/src/provider.ts'
import {prepareDefaultRobotPolicies} from '../src/default-robot-policies.ts'
import * as policy from '../src/plugin.ts'

const product=resolve(process.env.LYAPUNOV_POLICY_TEST_PRODUCT_ROOT||resolve(import.meta.dirname,'../../..'))
const policyPython=process.env.LYAPUNOV_POLICY_TEST_PYTHON||join(product,'.runtime/policy-python/bin/python')
const simPython=process.env.LYAPUNOV_MUJOCO_PYTHON||join(product,'.runtime/sim-python/bin/python')
const missing=[join(product,'packs/default-policy-supply.json'),policyPython,simPython].filter(path=>!existsSync(path))
test('随包 Go1/G1 经原工具执行，运行中停止后可在同一世界重新执行', {skip:missing.length?`缺少真实策略供给或解释器：${missing.join(', ')}`:false,timeout:180_000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'policy-native-cpu-'))),data=join(root,'data')
 const ctx=new Context(),sim=new MuJoCoProvider({pythonPath:simPython,workerPath:join(product,'packages/sim-mujoco/python/worker.py')}),scene=new SceneOperations(join(root,'scene'),{productRoot:product})
 try{
  const defaults=await prepareDefaultRobotPolicies(product,data,{pythonPath:policyPython})
  const selected=['unitree_go1','unitree_g1'].map(id=>{const row=defaults.find(item=>item.packId===id);assert.equal(row?.status,'PREPARED',JSON.stringify(row));return row!})
  await ctx.plugin(Timer);await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Commands);await ctx.plugin(Jobs);await ctx.plugin(ToolJobs)
  const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('native-policy-cpu-test'),{},{cwd:root})
  const owned=(id:unknown,value:unknown)=>{assert.equal(String(id),String(agent.id));return value}
  ctx.reflect.provide('sim',{forSession:(id:unknown)=>owned(id,sim)} as never);ctx.reflect.provide('scene',{forSession:(id:unknown)=>owned(id,scene)} as never)
  // 原 Guest 配置不自行供给内置策略；此处使用已由原供给器校验的独立数据目录。
  await ctx.plugin(policy,{guest:true,dataDirectory:data,pythonPath:policyPython})
  let seq=0
  const call=async(name:string,args:any)=>{const response:any=await ctx.tools.execute({name,arguments:args,callId:ToolCallId('native-policy-'+(++seq)),signal:AbortSignal.timeout(60_000),agent});assert.equal(response.isError,false,JSON.stringify(response));return response.value}
  for(const row of selected){
   const sceneId='policy-'+row.packId,entityId=row.packId,base=await scene.create({sceneId,template:'physics-workspace'})
   const snapshot=await scene.scene.commit({sceneId,expectedRevision:base.revision,patch:[{op:'add',entity:{entityId,name:entityId,resources:[],transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:row.prepared!.components}}]})
   const world=await sim.open(snapshot,row.prepared!.worldOptions)
   try{
    const common={provider:row.provider,modelId:row.modelId,revision:row.revision,sceneId,entityId,worldId:world.worldId,expectedGeneration:world.worldGeneration,command:[.1,0,0]}
    const started=await call('policy_execute',{input:{...common,durationS:4}});assert.equal(started.status,'RUNNING')
    const completed=await call('job_output',{job_id:started.jobId,wait:true,timeout_ms:60_000});assert.equal(completed.job.status,'completed')
    const result=JSON.parse(await readFile(started.resultPath,'utf8'));assert.equal(result.status,'COMPLETED');assert.equal(result.controls,200);assert.equal(result.inferences,200);assert.ok(Math.abs(result.simulatedDurationS-4)<1e-6);assert.equal(result.stop.stopped,true)
    if(row.packId==='unitree_g1'){
     const long=await call('policy_execute',{input:{...common,durationS:60}});assert.equal(long.status,'RUNNING')
     const before=await sim.observe(world.worldId,{entityIds:[entityId]});const deadline=Date.now()+20_000;let frame=before
     while(Date.now()<deadline&&frame.stepIndex<before.stepIndex+20){await new Promise(resolve=>setTimeout(resolve,50));frame=await sim.observe(world.worldId,{entityIds:[entityId]})}
     assert.ok(frame.stepIndex>=before.stepIndex+20,'取消前必须实际推进物理')
     await call('policy_stop',{input:{worldId:world.worldId,entityId}});assert.equal(ctx.jobs.get(long.jobId,agent.id).status,'killed')
     const stopped=JSON.parse(await readFile(long.resultPath,'utf8'));assert.equal(stopped.status,'CANCELLED');assert.ok(stopped.controls>0&&stopped.controls<3000);assert.equal(stopped.stop.stopped,true)
     const again=await call('policy_execute',{input:{...common,durationS:.2}});assert.equal(again.status,'RUNNING')
     const read=await call('job_output',{job_id:again.jobId,wait:true,timeout_ms:30_000});assert.equal(read.job.status,'completed')
     const final=JSON.parse(await readFile(again.resultPath,'utf8'));assert.equal(final.status,'COMPLETED');assert.equal(final.controls,10)
    }
   }finally{await sim.close(world.worldId)}
  }
 }finally{await sim.dispose();await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
})
