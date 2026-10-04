import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
export const name='lyapunov-motion-ompl'
/** 算法解释器结果行的稳定前缀；长度只在这里定义，解析方不得硬编码数字。 */
const RESULT_PREFIX='LYAPUNOV_RESULT='
export const inject=['tools','jobs','subprocess']
export interface Config { python?: string }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { lyapunov_provider:'lyapunov-provider' } }
export function apply(ctx:Context, config:Config={}) {
  ctx.tools.register(defineTool({
    name:'motion_path', description:"Generate a collision-avoiding path with OMPL RRTConnect and an independent collision model.",
    parameters:{request_json:{type:'string',required:true,description:"Supply independent provider input JSON. Reference geometry and models by file. TCP quaternions use xyzw order, lengths use meters, and times use seconds."},background:{type:'boolean',description:"Run in the background through DSH Jobs; inspect with job_output and cancel with job_kill."}},
    output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.result}]},
    async execute(args,exec) {
      const python=config.python??process.env.LYAPUNOV_ALGORITHM_PYTHON
      if(!python) throw new Error('PROVIDER_UNAVAILABLE: 缺少 LYAPUNOV_ALGORITHM_PYTHON')
      const request=JSON.parse(args.request_json)
      const run=(signal=exec.signal)=>ctx.subprocess.spawn({argv:[python,fileURLToPath(new URL('./plan.py',import.meta.url))],cwd:process.cwd(),stdio:{stdin:{data:JSON.stringify(request)},stdout:{maxBytes:4000000},stderr:{maxBytes:200000}},graceMs:2000,signal,env:{HF_ENDPOINT:'https://hf-mirror.com'}})
      if(args.background){
        if(exec.signal.aborted)throw exec.signal.reason??new Error('Cancelled before background Job registration')
        const controller=new AbortController()
        const id=ctx.jobs.start({kind:'lyapunov-provider',label:'motion_path',owner:exec.agent?.id,run:()=>{
          const child=run(controller.signal);return {cancel:()=>{controller.abort();child.terminate()},done:child.done.then(outcome=>({status:outcome.exitCode===0?'completed' as const:outcome.signal?'killed' as const:'failed' as const,detail:`exitCode=${outcome.exitCode}`,result:child.collected.stdout?.readFrom(0).text??''}))}
        }})
        return {result:JSON.stringify({jobId:id,status:'running'})}
      }
      const child=run(); const outcome=await child.done; const out=child.collected.stdout?.readFrom(0).text??''
      if(outcome.exitCode!==0) throw new Error(`${outcome.exitCode===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${out || child.collected.stderr?.readFrom(0).text}`)
      // 前缀长度必须由常量推导：plan.py 打印 LYAPUNOV_RESULT= 前缀，硬编码 13（旧前缀长度）
      // 会把结果截成非法 JSON，使 motion_path 完全不可用。
      const lines=out.trim().split('\n'),prefixed=lines.slice().reverse().find(v=>v.startsWith(RESULT_PREFIX))
      return {result:(prefixed?prefixed.slice(RESULT_PREFIX.length):lines.at(-1))!}
    },
  }))
}
