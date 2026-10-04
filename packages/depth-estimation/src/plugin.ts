import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage,type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '../../lyapunov-contracts/src/message-sources.ts'
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subprocess'
import { depthProviderStatus,startDepthEstimation,type DepthEstimationConfig } from './operations.ts'
import { registerDepthGeometryTools } from './geometry.ts'
import type { DepthEstimationRequest,DepthImageDelivery } from './types.ts'
export const name='lyapunov-depth-estimation'
/** `attachments` 不进 inject：它是可选增强（把深度预览带进模型上下文），不是必需服务。 */
export const inject=['tools','jobs','subprocess','commands']
export type Config=DepthEstimationConfig
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { depth_estimate:'depth_estimate' } }
/**
 * 预览图附件化：成功给 ref，失败给**明确原因**。
 * 缺附件服务、文件读不了、存储报错都不吞——调用方据此在结果里写明"这次没看到图"。
 */
async function attachPreview(ctx:Context,path:string|undefined):Promise<{ref:unknown}|{error:string}>{
 if(!path)return {error:'结果里没有彩色预览 PNG 路径'}
 const attachments=ctx.get('attachments')
 if(!attachments)return {error:'装配没有附件存储（attachments），预览图无法进入模型上下文；可按结果里的路径自行读取'}
 try{return {ref:await attachments.saveImage({data:await readFile(path),mediaType:'image/png',name:basename(path)})}}
 catch(error){return {error:'附件化失败：'+String(error instanceof Error?error.message:String(error))}}
}
/** 附件旁的说明：来源原图、相对语义、常量预测如实标注（没有置信度可报）。 */
export function previewCaption(output:string):string{
 const fallback='深度预览｜相对深度，亮度越大越近，不是米制'
 try{
  const value=JSON.parse(output) as {requestId?:string;output?:{image?:{path?:string;width?:number;height?:number};depth?:{statistics?:{constant?:boolean}}}}
  const image=value.output?.image,statistics=value.output?.depth?.statistics
  return `深度预览：${value.requestId??'?'}｜原图 ${image?.path??'?'}（${image?.width??'?'}x${image?.height??'?'}）｜相对深度，亮度越大越近，不是米制`
   +(statistics?.constant?'｜本次为常量预测（std=0），仍是有效输出':'')
 }catch{return fallback}
}
/** 把交付读数写进结果 JSON：没有图时结果文本里说清原因，不让人以为看到了图。 */
function withDelivery(output:string,delivery:DepthImageDelivery):string{
 try{return JSON.stringify({...JSON.parse(output),imageDelivery:delivery})}catch{return output}
}
/**
 * 后台作业完成时把预览图投给 owner：原生作业通知只带文本，图像只能由生产者交付。
 * `inject` 把消息排进 owner 的下一步，不唤醒驱动（不会多开一轮模型请求）；失败如实记进交付读数。
 */
function deliverToOwner(owner:Agent|undefined,ref:unknown,caption:string,jobId:string,delivery:DepthImageDelivery):void{
 const target=owner as {inject?:(message:unknown)=>void}|undefined
 if(typeof target?.inject!=='function'){delivery.error='执行上下文没有可投递的 owner agent（inject 不可用）：图只能按结果里的路径自行读取';return}
 try{
  target.inject(createUserMessage({content:[{type:'text',text:caption+'｜来源：后台作业 '+jobId},{type:'image',attachment:ref}] as ContentBlock[],source:{kind:'lyapunov-depth-estimation',form:'notice',summary:'深度预览 '+jobId}}))
  delivery.mode='job-notice';delivery.attached=1
 }catch(error){delivery.error='投递失败：'+String(error instanceof Error?error.message:String(error))}
}
/**
 * Tool/Command 共用同一 operation：同步路径等 done，后台路径交给 DSH Jobs。
 * 同步与后台的顺序都是**附件化 → 核对取消 → 交付**：附件化期间被取消时，图与结果都不交付，也绝不报 completed。
 * 同步路径的图像载体只在 `render`（同步）里一次性取用；`attach=false`（Command）完全不附件化，不留任何缓存。
 */
export function apply(ctx:Context,config:Config={}){
 const previewsByResult=new Map<string,unknown>()
 const operate=async(args:{request_json:string;background?:boolean},signal:AbortSignal,agent?:Agent,attach=true)=>{
  signal.throwIfAborted()
  const request=JSON.parse(args.request_json) as DepthEstimationRequest
  // 相对输入图路径按调用会话的 cwd 解析；没会话时由 operation 回落到配置/进程 cwd。
  const cwd=agent?.session?.header?.cwd
  const delivery:DepthImageDelivery={mode:'none',attached:0}
  const noAttach={error:'本次调用不附件化（Command 只回文本）：图没有进入模型上下文'}
  if(!args.background){
   const hooks=await startDepthEstimation(ctx.subprocess,config,request,signal,cwd)
   const result=await hooks.done
   if(result.status!=='completed')throw new Error(result.output)
   const attached=attach?await attachPreview(ctx,result.imagePath):noAttach
   // 附件化可能要等存储写盘，期间调用方仍可取消：取消就不投图、不交结果，也绝不 completed。
   if(signal.aborted)throw new Error('CANCELLED: 调用在附件化阶段被取消；本次不返回结果，也不投图')
   if('ref' in attached){delivery.mode='tool-result';delivery.attached=1}else delivery.error=attached.error
   const text=withDelivery(result.output,delivery)
   if('ref' in attached)previewsByResult.set(text,attached.ref)
   return {result:text}
  }
  if(signal.aborted)throw new Error('CANCELLED: 调用已被取消，后台作业未启动')
  // 后台作业的存活期不绑定本次调用：取消来自 job_kill / owner 释放（作业自己的 controller），不是 exec.signal。
  const controller=new AbortController()
  const jobId=ctx.jobs.start({kind:'depth_estimate',label:'单目相对深度 '+request.requestId,owner:agent?.id,run:()=>{
   let cancel:(()=>void)|undefined
   const done=startDepthEstimation(ctx.subprocess,config,request,controller.signal,cwd).then(hooks=>{
    cancel=hooks.cancel
    if(controller.signal.aborted)cancel()
    return hooks.done
   }).then(async result=>{
    if(result.status!=='completed')return {status:result.status,result:result.output}
    const attached=attach?await attachPreview(ctx,result.imagePath):noAttach
    // 顺序刻意如此：附件化 → 核对取消 → 投递 → 同步拼结果。投递之后不再有异步步骤，
    // 否则"作业已取消"与"完成通知带图发出去了"会同时成立。
    if(controller.signal.aborted)return {status:'killed' as const,result:JSON.stringify({error:{code:'CANCELLED',message:'作业在附件化阶段被取消；本次不投图，也不交付结果'}})}
    if('ref' in attached)deliverToOwner(agent,attached.ref,previewCaption(result.output),jobId,delivery)
    else delivery.error=attached.error
    return {status:'completed' as const,result:withDelivery(result.output,delivery)}
   }).catch((error:unknown)=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:String(error instanceof Error?error.message:String(error))}))
   return {cancel:()=>{controller.abort();cancel?.()},done}
  }})
  return {result:JSON.stringify({jobId,provider:'depth-anything-v2',requestId:request.requestId,source:request.source})}
 }
 ctx.tools.register(defineTool({
  name:'depth_estimate',
  description:'Monocular relative-depth estimation using Depth-Anything-V2-Small, local HF transformers weights, and offline execution. Return float32 npy at original and model dimensions, visualization PNG (colour preview returned as an image), dimensions/model revision/preprocessing/numeric statistics. Depth is relative: larger values are nearer, not metric, with no confidence estimate. Constant predictions from uniform/textureless inputs are valid. Missing interpreter or weights blocks explicitly. imageDelivery accurately records whether the preview entered model context and gives a reason if it did not.',
  parameters:{
   request_json:{type:'string',required:true,description:'JSON: requestId; image{path or uri:file:} (relative paths resolve against session cwd); params{device?,modelInputSize? (multiple of 14, default 518),previewMaxSide?,lowPercentile?,highPercentile?}; optional source{sceneId?,sceneRevision?,frameId?,worldId?,worldGeneration?}. Web photos have no scene/world/frame, so source can be omitted entirely.'},
   background:{type:'boolean',description:'Run through DSH Jobs in the background; job_output reads results and job_kill cancels. On completion, the preview is delivered with the owner message. Cancelled/failed jobs deliver no images.'},
  },
  output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>{
   const blocks:ContentBlock[]=[{type:'text',text:value.result}]
   const ref=previewsByResult.get(value.result)
   if(ref){previewsByResult.delete(value.result);blocks.push({type:'image',attachment:ref as never})}
   return blocks
  }},
  execute:(args,exec)=>operate(args,exec.signal,exec.agent),
 }))
 ctx.commands.register({
  name:'depth_estimate',
  description:'Execute the same monocular relative-depth operation synchronously without an LLM. Return text only, without image attachments; imageDelivery records that no image entered context.',
  input:{hint:'JSON for request_json/background parameters.'},
  async handler(invocation){
   try{return {kind:'success',text:(await operate(JSON.parse(invocation.rawInput||'{}'),invocation.signal,invocation.agent,false)).result}}
   catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}
  },
 })
 ctx.commands.register({
  name:'depth_status',
  description:'Read-only inspection of the depth provider\'s interpreter/worker/weights directory and manifest, without creating directories, loading models, or runtime side effects.',
  input:{hint:'No parameters.'},
  async handler(){
   try{return {kind:'success',text:JSON.stringify(await depthProviderStatus(config),null,2)}}
   catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}
  },
 })
 // 深度几何（几何标定/网格化）与深度估计共用同一份配置与同一输出根：`pythonPath` 在这里是同义字段，
 // 直接原样传 config，不写适配对象、不新建任务状态。它只注册 `depth_geometry` 工具与两个同步命令。
 registerDepthGeometryTools(ctx,config)
}
