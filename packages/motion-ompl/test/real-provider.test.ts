/** 原 motion_path 工具 + 真实 MuJoCo/OMPL；未提供可用 Python 时明确跳过，不代替正式场景验收。 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {Context} from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Commands from '@deepseek-ai/dsh-commands'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ompl from '../src/plugin.ts'

const root=resolve(import.meta.dirname,'../../..')
const python=process.env.LYAPUNOV_MUJOCO_PYTHON?.trim()||join(root,'.runtime/sim-python/bin/python')
test('真实工具在通路、完全阻断和可绕行障碍下输出可独立核对的规划', {skip:existsSync(python)?false:`缺少 MuJoCo/OMPL 解释器：${python}`,timeout:60_000},async()=>{
 const work=await realpath(await mkdtemp(join(tmpdir(),'motion-ompl-real-')))
 const xml=(barrier:boolean,two:boolean)=>`<mujoco model="ompl-probe"><option gravity="0 0 0"/><worldbody>${barrier?'<geom name="barrier" type="box" pos="0 0 0" size="0.08 0.2 0.2"/>':''}<body name="slider"><joint name="x" type="slide" axis="1 0 0" limited="true" range="-1 1"/>${two?'<joint name="y" type="slide" axis="0 1 0" limited="true" range="-0.8 0.8"/>':''}<geom name="moving" type="sphere" size="0.08" mass="1"/></body></worldbody></mujoco>`
 for(const [name,barrier,two] of [['free',false,false],['blocked',true,false],['detour',true,true]] as const)await writeFile(join(work,name+'.xml'),xml(barrier,two))
 const ctx=new Context()
 try{
  await ctx.plugin(Timer);await mountAgentLoopTestDependencies(ctx);await ctx.plugin(Commands);await ctx.plugin(Jobs);await ctx.plugin(Subprocess);await ctx.plugin(ToolJobs)
  const harness=await mountAgentLoopTestHarness(ctx),agent=await harness.create(SessionId('ompl-real-test'),{},{cwd:work})
  await ctx.plugin(ompl,{python})
  const request=(name:string,two=false)=>({modelPath:join(work,name+'.xml'),entityId:'slider',modelVersion:1,expectedGeneration:1,collisionContextVersion:'fixture',jointNames:two?['x','y']:['x'],startPositions:two?[-.8,0]:[-.8],goalPositions:two?[.8,0]:[.8],minPoints:two?100:30,durationS:2,timeoutS:1.5})
  const run=async(name:string,two=false)=>{const response:any=await ctx.tools.execute({name:'motion_path',arguments:{request_json:JSON.stringify(request(name,two))},callId:ToolCallId('ompl-'+name),signal:AbortSignal.timeout(30_000),agent});assert.equal(response.isError,false,JSON.stringify(response));return JSON.parse(response.value.result)}
  const free=await run('free'),blocked=await run('blocked'),detour=await run('detour',true)
  assert.equal(free.noSolution,false);assert.ok(free.plan.points.length>=30);assert.ok(Math.abs(free.plan.points[0].positions[0]+.8)<1e-5);assert.ok(Math.abs(free.plan.points.at(-1).positions[0]-.8)<1e-5)
  assert.equal(blocked.noSolution,true);assert.ok(blocked.rejectedStates>0)
  assert.equal(detour.noSolution,false);assert.ok(detour.plan.points.length>=100)
  // 另起真实 MuJoCo 复核路径点及每段十等分，不复用规划器的碰撞回执。
  const checker=`import json,sys,mujoco\nr=json.load(sys.stdin);m=mujoco.MjModel.from_xml_path(r['model']);d=mujoco.MjData(m);bad=[];p=r['points'];samples=0\nfor i in range(len(p)-1):\n for k in range(11):\n  t=k/10;d.qpos[:]=[(1-t)*a+t*b for a,b in zip(p[i]['positions'],p[i+1]['positions'])];mujoco.mj_forward(m,d);samples+=1\n  if any(c.dist < -0.0001 for c in d.contact):bad.append([i,k])\nprint(json.dumps({'bad':bad,'samples':samples,'maxY':max(abs(x['positions'][1]) for x in p)}))`
  const checked=spawnSync(python,['-c',checker],{input:JSON.stringify({model:join(work,'detour.xml'),points:detour.plan.points}),encoding:'utf8'})
  assert.equal(checked.status,0,checked.stderr);const independent=JSON.parse(checked.stdout);assert.deepEqual(independent.bad,[]);assert.ok(independent.samples>=1000);assert.ok(independent.maxY>.28)
  const background:any=await ctx.tools.execute({name:'motion_path',arguments:{request_json:JSON.stringify(request('detour',true)),background:true},callId:ToolCallId('ompl-background'),signal:AbortSignal.timeout(30_000),agent})
  assert.equal(background.isError,false,JSON.stringify(background));const started=JSON.parse(background.value.result);assert.equal(started.status,'running')
  const read:any=await ctx.tools.execute({name:'job_output',arguments:{job_id:started.jobId,wait:true,timeout_ms:30_000},callId:ToolCallId('ompl-job-output'),signal:AbortSignal.timeout(35_000),agent})
  assert.equal(read.isError,false,JSON.stringify(read));assert.equal(read.value.job.status,'completed')
  const output=read.value.text;assert.ok(output)
  const line=output.split('\n').findLast((value:string)=>value.startsWith('LYAPUNOV_RESULT='));assert.ok(line)
  const backgroundPlan=JSON.parse(line.slice('LYAPUNOV_RESULT='.length));assert.equal(backgroundPlan.noSolution,false);assert.ok(backgroundPlan.plan.points.length>=100)
  const backgroundCheck=spawnSync(python,['-c',checker],{input:JSON.stringify({model:join(work,'detour.xml'),points:backgroundPlan.plan.points}),encoding:'utf8'})
  assert.equal(backgroundCheck.status,0,backgroundCheck.stderr);const checkedBackground=JSON.parse(backgroundCheck.stdout);assert.deepEqual(checkedBackground.bad,[]);assert.ok(checkedBackground.samples>=1000)
 }finally{await ctx.fiber.dispose();await rm(work,{recursive:true,force:true})}
})
