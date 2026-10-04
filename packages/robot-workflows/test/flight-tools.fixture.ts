/** 真实 Model/Resource/Session/ToolRegistry/Command/Jobs/worker 夹具；需要已有 Python，不使用模型或收费 API。 */
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import {SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {JobId} from '@deepseek-ai/dsh-jobs'
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit'
import {SessionSimFactory} from '../../sim-contract/src/session-provider.ts'
import {MuJoCoProvider} from '../../sim-mujoco/src/provider.ts'
import * as scenePlugin from '../../scene-kit/src/plugin.ts'
import {identityTransform,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
const root=resolve(import.meta.dirname,'../../..'),output=resolve(process.argv[2]??'.runtime/flight-tools-fixture'),python=process.argv[3]
const workflowPlugin=await import(process.argv[4]??resolve(root,'packages/robot-workflows/dist/plugin.js'))
assert(python,'必须提供真实 SDK Python，不缺依赖就跳过')
await mkdir(output,{recursive:true})
const ctx=new Context();await ctx.plugin(Timer);await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Commands);await ctx.plugin(Jobs);ctx.jobs.attachController('flight-tools-fixture')
const factory=new SessionSimFactory({create:()=>new MuJoCoProvider({pythonPath:python,workerPath:resolve(root,'packages/sim-mujoco/python/worker.py')})})
ctx.reflect.provide('sim',factory as never)
await ctx.plugin(scenePlugin,{dataRoot:join(output,'scene-runtime'),productRoot:root})
await ctx.plugin(workflowPlugin,{recordingRoot:join(output,'recordings')})
const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('isolated-flight-a'),{},{cwd:output}),other=await harness.create(SessionId('isolated-flight-b'),{},{cwd:output})
let count=0
async function tool(name:string,input:any,caller=agent){const value=await ctx.tools.execute({callId:ToolCallId('flight-fixture-'+ ++count),name,arguments:{input},agent:caller,signal:new AbortController().signal});if(value.isError)throw new Error(JSON.stringify(value.content));return value.value as any}
async function command(input:any){const value=await ctx.commands.execute(agent,'/robot_flight '+JSON.stringify(input),[],new AbortController().signal);assert(value);const result=value.result as {kind:string;text:string};if(result.kind!=='success')throw new Error(result.text);return JSON.parse(result.text)}
try{
 const library=JSON.parse(await readFile(join(root,'materials/library.json'),'utf8')).resources.find((r:any)=>r.assetId==='crazyflie_2')
 assert(library&&library.components?.controller?.type==='drone')
 await tool('scene_create',{sceneId:'flight-product'})
 const imported=await tool('scene_import',{path:join(root,'materials',library.path),resourceId:library.assetId,name:library.displayName,components:library.components})
 const mounted=await tool('scene_mount',{sceneId:'flight-product',resourceId:library.assetId,entityId:'quad',transform:identityTransform(),alignBottomToSurface:false})
 const snapshot=mounted.snapshot as SceneSnapshot;assert.equal(snapshot.entities.length,1);assert.equal(snapshot.entities[0]!.components.controller!.type,'drone')
 const sim=factory.forSession(agent.id),world=await sim.open(snapshot,{clock:'manual',timestepS:.002})
 const input={worldId:world.worldId,entityId:'quad',expectedGeneration:world.worldGeneration,expectedSceneRevision:snapshot.revision}
 const state=await sim.observe(world.worldId,{sensors:true});const position=state.entities[0]!.transform.position
 const natural=await tool('robot_flight',{...input,operation:'hover',positionM:position,maxDurationS:1,background:false})
 assert.equal(natural.taskAchieved,true);assert(natural.actions>0)
 const manual=await command({...input,operation:'hover',positionM:position,maxDurationS:1})
 assert.equal(manual.status,'running');const job=await ctx.jobs.wait(JobId(manual.jobId),10000,agent?.id);assert.equal(job.status,'completed')
 const jobValue=JSON.parse((ctx.jobs.read(JobId(manual.jobId),agent?.id).result ?? ''));assert.equal(jobValue.taskAchieved,true)
 const status=await command({...input,operation:'status'});assert.equal(status.status,'completed')
 const foreign=await ctx.tools.execute({callId:ToolCallId('flight-foreign'),name:'robot_flight',arguments:{input:{...input,operation:'status'}},agent:other,signal:new AbortController().signal});assert.equal(foreign.isError,true)
 const reset=await command({...input,operation:'reset'});assert(reset.world.worldGeneration>world.worldGeneration);assert.equal(reset.after.stepIndex,0)
 const stale=await ctx.tools.execute({callId:ToolCallId('flight-stale'),name:'robot_flight',arguments:{input:{...input,operation:'hover',positionM:position,background:false}},agent,signal:new AbortController().signal});assert.equal(stale.isError,true)
 await writeFile(join(output,'tool-command.json'),JSON.stringify({status:'passed',imported,snapshot,world,before:state,description:await sim.describe(world.worldId,'quad'),natural,manual,job,jobValue,statusRead:status,foreignRejected:foreign.isError,reset,staleRejected:stale.isError},null,2))
 console.log(JSON.stringify({status:'passed',sourceTier:'真实资源/当前会话Tool+Command+Jobs+MuJoCo，非GUI或原生沙箱签收',naturalActions:natural.actions,commandActions:jobValue.actions,resetGeneration:reset.world.worldGeneration,foreignRejected:foreign.isError}))
}finally{await factory.dispose();await ctx.fiber.dispose()}
