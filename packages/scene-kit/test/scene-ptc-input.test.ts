import {test,expect} from 'bun:test'
import {Context} from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Commands from '@deepseek-ai/dsh-commands'
import {PtcRuntime,type PtcRunRequest} from '@deepseek-ai/dsh-ptc-runtime'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as ScenePlugin from '../src/plugin.ts'
/** 只替换程序执行器；run_code/调度/ToolRegistry/会话/Command都是原生SDK。真实Node进程另验。 */
class FixturePtc extends PtcRuntime {
 readonly language='typescript';readonly isolation='fixture'
 resolve(request:PtcRunRequest){return {...request,cwd:request.cwd??process.cwd(),timeoutMs:30000}}
 async run(request:PtcRunRequest){return {logs:[],value:await request.bindings[0]!.functions.scene_inspect!(JSON.parse(request.program))}}
}
test('原生PTC桥→ToolRegistry及Command三入口传同一sceneId，混合/缺参fail closed（程序执行器夹具）',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lyapunov-input-ptc-')),workspace=join(root,'workspace'),ctx=new Context()
 await mkdir(workspace)
 try{
  await ctx.plugin(Timer);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools,{mode:'both'});await ctx.plugin(Projections);await ctx.plugin(Sessions);await ctx.plugin(Commands);await ctx.plugin(FixturePtc);await ctx.plugin(ScenePlugin,{dataRoot:join(root,'data')})
  const session=ctx.sessions.create(SessionId('shape-ptc'),{meta:{cwd:workspace}}),agent={id:session.id,session} as any,signal=new AbortController().signal
  const command=await ctx.commands.execute(agent,'/scene_create '+JSON.stringify({sceneId:'s'}),[],signal);expect(command?.result.kind).toBe('success')
  const call=(code:string)=>ctx.tools.execute({callId:ToolCallId('ptc-shape-'+Date.now()),name:'run_code',arguments:{code,description:'隔离场景参数合同测试'},agent,signal})
  const flat=await call(JSON.stringify({sceneId:'s'}))
  const nested=await call(JSON.stringify({input:{sceneId:'s'}}))
  if(flat.isError||nested.isError)throw new Error(JSON.stringify({flat,nested}))
  expect(flat.isError).toBe(false);expect(nested.isError).toBe(false)
  const cmd=await ctx.commands.execute(agent,'/scene_inspect '+JSON.stringify({sceneId:'s'}),[],signal);expect(cmd?.result.kind).toBe('success')
  for(const input of [{},{sceneId:'other',input:{sceneId:'s'}}]){const result=await call(JSON.stringify(input));expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('invalid arguments')}
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
},30000)
