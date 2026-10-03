import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
export const name='lyapunov-grasp-anygrasp'
export const inject=['tools','jobs','subprocess']
export interface Config { python?: string }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { lyapunov_provider:'lyapunov-provider' } }
export function apply(ctx:Context, config:Config={}) {
  ctx.tools.register(defineTool({
    name:'grasp_propose', description:"Return unified grasp candidates through the real AnyGrasp SDK; report a missing license explicitly.",
    parameters:{request_json:{type:'string',required:true,description:"Supply independent provider input JSON. Reference geometry and models by file. TCP quaternions use xyzw order, lengths use meters, and times use seconds."},background:{type:'boolean',description:"Run in the background through DSH Jobs; inspect with job_output and cancel with job_kill."}},
    output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.result}]},
    async execute(args,exec) {
      const python=config.python??process.env.LYAPUNOV_ALGORITHM_PYTHON
      if(!python) throw new Error('PROVIDER_UNAVAILABLE: 缺少 LYAPUNOV_ALGORITHM_PYTHON')
      const request=JSON.parse(args.request_json)
      const run=()=>ctx.subprocess.spawn({argv:[python,fileURLToPath(new URL('./propose.py',import.meta.url))],cwd:process.cwd(),stdio:{stdin:{data:JSON.stringify(request)},stdout:{maxBytes:4000000},stderr:{maxBytes:200000}},graceMs:2000,signal:exec.signal,env:{HF_ENDPOINT:'https://hf-mirror.com'}})
      if(args.background){
        const id=ctx.jobs.start({kind:'lyapunov-provider',label:'grasp_propose',owner:exec.agent,run:()=>{
          const child=run();return {cancel:()=>child.terminate(),done:child.done.then(outcome=>({status:outcome.exitCode===0?'completed' as const:outcome.signal?'killed' as const:'failed' as const,detail:`exitCode=${outcome.exitCode}`,output:child.collected.stdout?.readFrom(0).text??''}))}
        }})
        return {result:JSON.stringify({jobId:id,status:'running'})}
      }
      const child=run(); const outcome=await child.done; const out=child.collected.stdout?.readFrom(0).text??''
      if(outcome.exitCode!==0) throw new Error(`${outcome.exitCode===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${out || child.collected.stderr?.readFrom(0).text}`)
      const lines=out.trim().split('\n');return {result:lines.slice().reverse().find(v=>v.startsWith('LYAPUNOV_RESULT='))?.slice(13)??lines.at(-1)!}
    },
  }))
}
