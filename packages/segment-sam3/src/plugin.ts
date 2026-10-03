import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join,resolve } from 'node:path'
import { access,mkdir,writeFile } from 'node:fs/promises'
import type { Sam3Request,Sam3Result } from './types.ts'
export const name='lyapunov-segment-sam3'
export const inject=['tools','jobs','subprocess','commands']
export interface Config { pythonPath?:string;checkpointPath?:string;dataDirectory?:string;device?:'cuda'|'cpu' }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { sam3:'sam3' } }
export function apply(ctx:Context,config:Config={}){
 const definition=defineTool({
  name:'segment_sam3',description:"Use real SAM3 inference with text or box prompts to segment an image. Return 2D mask PNGs, boxes, scores, an overlay, and the original frame/scene/world provenance. This does not perform 3D segmentation.",
  parameters:{request_json:{type:'string',required:true,description:"JSON: requestId, imagePath, textPrompt or boxPrompts[{boxXYXY:[x0,y0,x1,y1],positive:true}], and source{sceneId,sceneRevision,frameId,worldId?,worldGeneration?,stepIndex?}. Box coordinates are original-image pixels."},background:{type:'boolean',description:"Run through DSH Jobs. Read results with job_output and stop the current inference with job_kill."}},
  output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,result)=>[{type:'text',text:result.result}]},
  async execute(args,exec){
   const request=JSON.parse(args.request_json) as Sam3Request
   if(!/^[A-Za-z0-9_-]+$/.test(request.requestId))throw new Error('INVALID_REQUEST_ID')
   if(!request.source?.sceneId||!request.source.frameId||!Number.isInteger(request.source.sceneRevision))throw new Error('INVALID_SOURCE: 必须指定sceneId/sceneRevision/frameId')
   if(request.source.worldId&&!Number.isInteger(request.source.worldGeneration))throw new Error('INVALID_SOURCE: worldId必须对应worldGeneration')
   if(!request.textPrompt&&!request.boxPrompts?.length)throw new Error('INVALID_PROMPT: 需要文本或框选提示')
   const python=config.pythonPath??process.env.LYAPUNOV_SAM3_PYTHON
   const checkpoint=config.checkpointPath??process.env.LYAPUNOV_SAM3_CHECKPOINT
   if(!python||!checkpoint)throw new Error('PROVIDER_UNAVAILABLE: SAM3需要独立Conda Python及已授权的facebook/sam3/sam3.pt本地权重')
   for(const [kind,path] of [['Python',python],['checkpoint',checkpoint]] as const)try{await access(path)}catch{throw new Error(`PROVIDER_UNAVAILABLE: SAM3 ${kind}不存在: ${path}`)}
   if(!config.dataDirectory)throw new Error('PROVIDER_UNAVAILABLE: 缺少当前账号的SAM3产物目录')
   const outputDirectory=join(resolve(config.dataDirectory),request.requestId+'-'+randomUUID())
   await mkdir(outputDirectory,{recursive:true});await writeFile(join(outputDirectory,'request.json'),JSON.stringify(request,null,2),{mode:0o600})
   const run=(signal:AbortSignal)=>{
    const child=ctx.subprocess.spawn({argv:[python,fileURLToPath(new URL('./predict.py',import.meta.url))],cwd:outputDirectory,stdio:{stdin:{data:JSON.stringify({...request,imagePath:resolve(request.imagePath),outputDirectory})},stdout:{maxBytes:4000000},stderr:{maxBytes:200000}},graceMs:3000,signal,env:{HF_ENDPOINT:'https://hf-mirror.com',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_XET:'1',LYAPUNOV_SAM3_CHECKPOINT:resolve(checkpoint),LYAPUNOV_SAM3_DEVICE:config.device??'cuda'}})
    const done=child.done.then(async outcome=>{
     const stdout=child.collected.stdout?.readFrom(0).text??'';const stderr=child.collected.stderr?.readFrom(0).text??''
     await writeFile(join(outputDirectory,'runtime.log'),stdout+'\n'+stderr,{mode:0o600})
     const line=stdout.trim().split('\n').reverse().find(line=>line.startsWith('LYAPUNOV_RESULT='))?.slice(13)
     if(outcome.exitCode!==0)return {status:outcome.signal?'killed' as const:'failed' as const,output:line??JSON.stringify({error:'SAM3_RUNTIME_FAILED',exitCode:outcome.exitCode,detail:stderr})}
     if(!line)return {status:'failed' as const,output:'SAM3_OUTPUT_MISSING'}
     const result=JSON.parse(line) as Sam3Result
     if(result.provider!=='sam3'||result.source.frameId!==request.source.frameId||result.source.sceneRevision!==request.source.sceneRevision)return {status:'failed' as const,output:'SAM3_OUTPUT_SOURCE_MISMATCH'}
     return {status:'completed' as const,output:JSON.stringify(result)}
    })
    return {cancel:()=>child.terminate(),done}
   }
   if(!args.background){const result=await run(exec.signal).done;if(result.status!=='completed')throw new Error(result.output);return {result:result.output}}
   const jobId=ctx.jobs.start({kind:'sam3',label:'SAM3 '+request.requestId,owner:exec.agent,run:()=>run(exec.signal)})
   return {result:JSON.stringify({jobId,provider:'sam3',requestId:request.requestId,source:request.source})}
  },
 })
 ctx.tools.register(definition)
 ctx.commands.register({name:'segment_sam3',description:"Segment the current image with the same SAM3 operation; return 2D masks and actual provenance.",input:{hint:"JSON containing request_json and background arguments."},async handler(invocation){
  const args=JSON.parse(invocation.rawInput||'{}')
  try{const result=await definition.execute(args,{signal:invocation.signal,agent:invocation.agent} as any);return {kind:'success',text:(result as {result:string}).result}}catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}
 }})
}
