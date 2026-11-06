/**
 * 下载设置的人工请求仍走原原生 Jobs；完成通知应由人工等待者接收。
 * 原 Cordis/AgentLoop/Tools/Jobs/通知插件均实装。只有 HTTP 传输、版本探测可执行文件
 * 和模型响应是明确夹具；不下载模型、不安装软件、不执行真实机器人。
 */
import {describe,expect,test} from 'bun:test'
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import {JobId} from '@deepseek-ai/dsh-jobs'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import {mountAgentLoopTestDependencies,mountAgentLoopTestHarness} from '@deepseek-ai/dsh-agent-loop-testkit'
import {MockAdapter,textResponse} from '../../../.upstream/deepseek-harness-0.2.0-rc.2/packages/core/agent-loop/tests/mock-adapter.ts'
import {applyExternalToolsHost,startExternalAcquisition} from '../src/external-tools-host.ts'

async function boot(){
 const root=await mkdtemp(join(tmpdir(),'external-acquisition-notification-'))
 const executable=join(root,'blender-probe')
 await writeFile(executable,'#!/bin/sh\nprintf "Blender 5.2.3\\n"\n');await chmod(executable,0o700)
 const previous=process.env.BLENDER_EXECUTABLE;process.env.BLENDER_EXECUTABLE=executable
 const ctx=new Context(),routes=new Map<string,(request:Request)=>Promise<Response>>()
 try{
  await mountAgentLoopTestDependencies(ctx);await ctx.plugin(JobsLocal);await ctx.plugin(ToolJobs,{})
  const adapter=new MockAdapter([textResponse('模型调用路径收到了原作业通知')]);ctx.llm.registerAdapter(['mock'],adapter)
  const harness=await mountAgentLoopTestHarness(ctx)
  const agent=await harness.create(SessionId('external-acquisition-fixture'),{provider:'mock',model:'mock'},{cwd:root})
  ctx.reflect.provide('subprocess',{resolveExecutable:async(command:string)=>command==='blender'?executable:null} as never)
  // 仅捕获原路由的传输边界；执行真实产品 handler，不替换其业务逻辑。
  ctx.reflect.provide('connection',{fetch:{register:(spec:{path:string;fetch:(request:Request)=>Promise<Response>})=>{routes.set(spec.path,spec.fetch);return()=>routes.delete(spec.path)}}} as never)
  applyExternalToolsHost(ctx)
  const settlements:Array<{awaited:boolean;id:string}>=[],turnEnd=Promise.withResolvers<void>()
  let turns=0
  ctx.jobs.events.subscribe({owners:'scope'},event=>{if(event.type==='settled')settlements.push({awaited:event.awaited,id:String(event.job.id)})})
  ctx.on('session/event',(session,event)=>{if(session.header.id!==agent.id)return;if(event.type==='turn/start')turns++;if(event.type==='turn/end')turnEnd.resolve()})
  return {ctx,agent,adapter,settlements,turnEnd,turns:()=>turns,
   acquire:async(sessionId:string)=>routes.get('/api/lyapunov/external-tools/acquire')!(new Request('http://localhost/api/lyapunov/external-tools/acquire',{method:'POST',body:JSON.stringify({id:'blender',sessionId})})),
   close:async()=>{await ctx.fiber.dispose();if(previous===undefined)delete process.env.BLENDER_EXECUTABLE;else process.env.BLENDER_EXECUTABLE=previous;await rm(root,{recursive:true,force:true})}}
 }catch(error){await ctx.fiber.dispose();if(previous===undefined)delete process.env.BLENDER_EXECUTABLE;else process.env.BLENDER_EXECUTABLE=previous;await rm(root,{recursive:true,force:true});throw error}
}

describe('原外部供给入口的人工作业完成归属',()=>{
 test('人工HTTP请求的立即完成由原等待者接收，不唤醒模型',async()=>{
  const h=await boot()
  try{
   const response=await h.acquire(String(h.agent.id));expect(response.status).toBe(200)
   const {jobId}=await response.json() as {jobId:string}
   expect(h.ctx.jobs.get(JobId(jobId),h.agent.id).status).toBe('completed')
   expect(h.settlements).toEqual([{awaited:true,id:jobId}])
   expect(h.turns()).toBe(0);expect(h.adapter.requests).toHaveLength(0)
   expect(h.ctx.jobs.readAt(JobId(jobId),0,h.agent.id).chunks.map(c=>c.text).join('')).toContain('reuse-existing-software')
  }finally{await h.close()}
 })
 test('模型调用共享入口仍保留原完成通知',async()=>{
  const h=await boot()
  try{
   const jobId=await startExternalAcquisition(h.ctx,{id:'blender',sessionId:String(h.agent.id)})
   await h.turnEnd.promise
   expect(h.ctx.jobs.get(JobId(jobId),h.agent.id).status).toBe('completed')
   expect(h.settlements).toEqual([{awaited:false,id:jobId}])
   expect(h.turns()).toBe(1);expect(h.adapter.requests).toHaveLength(1)
  }finally{await h.close()}
 })
 test('不存在的会话仍拒绝，不能退回无owner供给',async()=>{
  const h=await boot()
  try{
   const response=await h.acquire('missing-session');expect(response.status).toBe(400)
   expect((await response.json() as {error:string}).error).toContain('SESSION_NOT_LIVE')
   expect(h.ctx.jobs.list()).toHaveLength(0)
  }finally{await h.close()}
 })
})
