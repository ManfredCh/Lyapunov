import { access,mkdir,readFile,realpath,stat,writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname,extname,isAbsolute,join,relative,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import type { DepthArtifact,DepthEstimationRequest,DepthEstimationResult,DepthModelIdentity,DepthOutputSummary,DepthSizes,DepthSource,DepthWorkerResult } from './types.ts'

/** 插件配置。路径都可以由装配方显式给出；env 只是同名兜底。workspace 只用于相对路径兜底。 */
export interface DepthEstimationConfig { pythonPath?:string;workerPath?:string;modelDirectory?:string;dataDirectory?:string;device?:'cpu'|'cuda';workspace?:string }
/** 权重来源清单：由 packages/depth-estimation/script/fetch-model.ts 经 hf-mirror 下载后写入，人工目录可以没有。 */
export interface DepthModelManifest { modelId:string;revision:string;license:string|null;source:{endpoint:string;fetchedAt:string};files:Record<string,{bytes:number;sha256:string}> }
/** 依赖状态：`missing` 只列**读取前置**（读不到就没法跑）；输出根缺失不算，执行时会创建。 */
export interface DepthDependencyState { paths:{python?:string;worker?:string;model?:string;data:string};missing:Array<{dependency:string;path?:string}>;modelFiles:Array<{file:string;bytes:number}>;manifest:DepthModelManifest|null;available:boolean;outputRoot:{path:string;exists:boolean} }
const REQUIRED_MODEL_FILES=['config.json','preprocessor_config.json','model.safetensors'] as const
const IMAGE_EXTENSIONS=['.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff'] as const
const ARTIFACT_REQUIRED=['depth.image.npy','depth.model.npy','depth.preview.png','depth.preview.color.png','depth.metadata.json'] as const
const MANIFEST_FILE='lyapunov-model-manifest.json'
const RESULT_PREFIX='LYAPUNOV_RESULT='
const here=dirname(fileURLToPath(import.meta.url))
/** 默认 worker 落在 package 的 python/ 目录；装配方可用 workerPath 配置覆盖。 */
export const defaultWorkerPath=resolve(here,'../python/worker.py')
/** 输出根：config → env → 系统临时目录下的本插件目录（父目录不存在会在执行时创建）。 */
export function resolveOutputRoot(config:DepthEstimationConfig={}){
 const configured=config.dataDirectory??process.env.LYAPUNOV_DEPTH_ESTIMATION_DATA_DIR
 return configured?resolve(configured):join(tmpdir(),'lyapunov-depth-estimation')
}
export function resolveDepthPaths(config:DepthEstimationConfig={}){
 return {
  python:config.pythonPath??process.env.LYAPUNOV_DEPTH_ESTIMATION_PYTHON,
  worker:config.workerPath??process.env.LYAPUNOV_DEPTH_ESTIMATION_WORKER??defaultWorkerPath,
  model:config.modelDirectory??process.env.LYAPUNOV_DEPTH_ESTIMATION_MODEL_DIR,
  data:resolveOutputRoot(config),
 }
}
async function readable(path:string){try{await access(path);return true}catch{return false}}
/** 读取人工/脚本写入的权重清单；缺失返回 null，不猜来源，也不联网补全。 */
export async function readModelManifest(modelDirectory:string):Promise<DepthModelManifest|null>{
 try{
  const value=JSON.parse(await readFile(join(modelDirectory,MANIFEST_FILE),'utf8')) as DepthModelManifest
  if(typeof value?.modelId!=='string'||typeof value?.revision!=='string'||typeof value?.files!=='object'||!value.files)throw new Error('INVALID_MANIFEST')
  return value
 }catch(error:any){if(error?.code==='ENOENT')return null;if(String(error?.message)==='INVALID_MANIFEST')return null;throw new Error('INVALID_MANIFEST: '+MANIFEST_FILE+' '+String(error))}
}
/**
 * 依赖核查（只读）：解释器、worker、权重目录与必需文件。
 * **输出根不参与 available 判定**——它是可创建的写前置；这里只报告它当前是否存在。
 */
export async function dependencyState(config:DepthEstimationConfig={}):Promise<DepthDependencyState>{
 const paths=resolveDepthPaths(config)
 const missing:Array<{dependency:string;path?:string}>=[];const modelFiles:Array<{file:string;bytes:number}>=[]
 for(const [dependency,path] of [['python',paths.python],['worker',paths.worker],['model',paths.model]] as const){
  if(!path)missing.push({dependency});else if(!await readable(path))missing.push({dependency,path})
 }
 if(paths.model&&!missing.some(item=>item.dependency==='model')){
  for(const file of REQUIRED_MODEL_FILES){
   const target=join(paths.model,file)
   try{const info=await stat(target);if(!info.isFile()||info.size===0)missing.push({dependency:'model:'+file,path:target});else modelFiles.push({file,bytes:info.size})}
   catch{missing.push({dependency:'model:'+file,path:target})}
  }
 }
 let manifest:DepthModelManifest|null=null
 if(paths.model&&!missing.some(item=>item.dependency==='model'))manifest=await readModelManifest(paths.model)
 return {paths,missing,modelFiles,manifest,available:missing.length===0,outputRoot:{path:paths.data,exists:await readable(paths.data)}}
}
/** 权重身份：清单存在时以清单为准（含 revision），否则 revision=null 且 revisionSource='unavailable'。 */
export function modelIdentity(modelDirectory:string,manifest:DepthModelManifest|null):DepthModelIdentity{
 const weights=manifest?.files?.['model.safetensors']
 return {modelId:manifest?.modelId??'unknown-local-checkpoint',revision:manifest?.revision??null,revisionSource:manifest?'manifest':'unavailable',license:manifest?.license??null,architecture:null,weightsSha256:weights?.sha256??null,weightsBytes:weights?.bytes??null,directory:resolve(modelDirectory),maxDepthConfig:null,depthEstimationType:null}
}
/** 相对路径按调用方给的 cwd（会话 header.cwd）解析；file: URI 与绝对路径原样使用。 */
async function resolveImage(ref:DepthEstimationRequest['image'],cwd:string){
 if(!ref||typeof ref!=='object')throw new Error('INVALID_INPUT: image 必须是 {path} 或 {uri:file:...}')
 const text=ref.path??ref.uri
 if(!text)throw new Error('INVALID_INPUT: image 必须给出文件路径')
 const path=text.startsWith('file:')?fileURLToPath(text):resolve(cwd,text)
 const info=await stat(path).catch(()=>null)
 if(!info?.isFile()||info.size===0)throw new Error('INVALID_INPUT_FILE: 输入图像不存在或为空: '+text+'（相对路径按 '+cwd+' 解析）')
 const extension=extname(path).toLowerCase()
 if(!IMAGE_EXTENSIONS.includes(extension as typeof IMAGE_EXTENSIONS[number]))throw new Error('UNSUPPORTED_CAPABILITY: 只接受 '+IMAGE_EXTENSIONS.join('/')+'，收到 '+extension)
 return {path,bytes:info.size}
}
/** 参数校验：只接受已实现的字段，模型输入尺寸必须是 14 的倍数（patch_size=14）。 */
export function normalizeParams(request:DepthEstimationRequest,config:DepthEstimationConfig={}){
 const params=request.params??{}
 const allowed=new Set(['device','modelInputSize','previewMaxSide','lowPercentile','highPercentile'])
 const unknown=Object.keys(params).filter(key=>!allowed.has(key))
 if(unknown.length)throw new Error('UNSUPPORTED_CAPABILITY: 未实现的 params 字段 '+unknown.join(','))
 const requested=params.device??config.device??process.env.LYAPUNOV_DEPTH_ESTIMATION_DEVICE??'cpu'
 if(requested!=='cpu'&&requested!=='cuda')throw new Error('INVALID_PARAMS: device 只能是 cpu 或 cuda')
 const device:'cpu'|'cuda'=requested
 const modelInputSize=params.modelInputSize??518
 if(!Number.isInteger(modelInputSize)||modelInputSize<28||modelInputSize>2048||modelInputSize%14!==0)throw new Error('INVALID_PARAMS: modelInputSize 必须是 28..2048 之间的 14 的倍数')
 const previewMaxSide=params.previewMaxSide??1024
 if(!Number.isInteger(previewMaxSide)||previewMaxSide<64||previewMaxSide>8192)throw new Error('INVALID_PARAMS: previewMaxSide 必须在 64..8192')
 const lowPercentile=params.lowPercentile??2,highPercentile=params.highPercentile??98
 if(!Number.isFinite(lowPercentile)||!Number.isFinite(highPercentile)||lowPercentile<0||highPercentile>100||lowPercentile>=highPercentile)throw new Error('INVALID_PARAMS: 分位点必须满足 0<=low<high<=100')
 return {device,modelInputSize,previewMaxSide,lowPercentile,highPercentile}
}
export interface PreparedDepthRequest { requestId:string;image:{path:string;bytes:number};params:ReturnType<typeof normalizeParams>;source?:DepthSource }
/** source 整体可选；给了就逐字段校验类型，scene/frame/world 都不要求同时出现。 */
function normalizeSource(source:unknown):DepthSource|undefined{
 if(source===undefined||source===null)return undefined
 if(typeof source!=='object')throw new Error('INVALID_SOURCE: source 必须是对象或不给')
 const value=source as DepthSource
 for(const key of ['sceneId','frameId','worldId'] as const)if(value[key]!==undefined&&typeof value[key]!=='string')throw new Error('INVALID_SOURCE: '+key+' 必须是字符串')
 for(const key of ['sceneRevision','worldGeneration','stepIndex'] as const)if(value[key]!==undefined&&!Number.isInteger(value[key]))throw new Error('INVALID_SOURCE: '+key+' 必须是整数')
 if(value.worldId&&!Number.isInteger(value.worldGeneration))throw new Error('INVALID_SOURCE: worldId 必须带 worldGeneration')
 return value
}
export async function prepareRequest(request:DepthEstimationRequest,config:DepthEstimationConfig={},cwd?:string):Promise<PreparedDepthRequest>{
 if(!request||typeof request!=='object')throw new Error('INVALID_INPUT: 请求必须是 JSON 对象')
 if(!/^[A-Za-z0-9_-]+$/.test(request.requestId??''))throw new Error('INVALID_REQUEST_ID: 只接受 [A-Za-z0-9_-]+')
 const base=cwd??config.workspace??process.cwd()
 return {requestId:request.requestId,image:await resolveImage(request.image,resolve(base)),params:normalizeParams(request,config),source:normalizeSource(request.source)}
}
/**
 * 产物校验（TS 只核对运行层能真正确认的事实）：五类产物齐全、文件**真的存在**且非空、
 * 落在本次产物目录内（不逃逸）、metadata 自述相对深度且尺寸齐备。
 *
 * 数值本身（npy 的 dtype/形状/字节数/NaN/Inf）由**本包 Python worker** 负责——它写的就是它算的，
 * 在 TS 里再解析一遍 npy 只是重复实现；同理不在推理期重算产物或权重哈希（下载期与
 * `fetch-model.ts --verify-only` 已经核对过清单哈希）。也不设"必须有方差"的门槛：常量预测是有效输出。
 */
export async function collectArtifacts(worker:DepthWorkerResult,artifactDirectory:string):Promise<{artifacts:DepthArtifact[];metadata:Record<string,any>}>{
 const declared=new Map<string,any>()
 for(const item of worker?.artifacts??[]){
  if(!item||typeof item.path!=='string'||typeof item.type!=='string')throw new Error('INVALID_ARTIFACT_DECLARATION')
  declared.set(item.type,item)
 }
 for(const required of ARTIFACT_REQUIRED)if(!declared.has(required))throw new Error('DEPTH_ARTIFACT_MISSING: '+required)
 const base=await realpath(artifactDirectory);const artifacts:DepthArtifact[]=[]
 for(const item of declared.values()){
  const file=await realpath(isAbsolute(item.path)?item.path:join(base,item.path)).catch(()=>null)
  if(!file)throw new Error('DEPTH_ARTIFACT_MISSING: '+item.type+' 声明的文件不存在: '+item.path)
  const rel=relative(base,file)
  if(rel.startsWith('..')||isAbsolute(rel))throw new Error('ARTIFACT_OUTSIDE_OUTPUT: '+item.path)
  const info=await stat(file)
  if(!info.isFile()||info.size===0)throw new Error('EMPTY_ARTIFACT: '+item.path)
  artifacts.push({type:item.type,path:file,uri:pathToFileURL(file).href,size_bytes:info.size,metadata:item.note?{note:item.note}:{}})
 }
 const metadataArtifact=artifacts.find(item=>item.type==='depth.metadata.json')!
 const metadata=JSON.parse(await readFile(metadataArtifact.path,'utf8')) as Record<string,any>
 if(metadata?.schema!=='lyapunov.depth-estimation/1')throw new Error('INVALID_DEPTH_METADATA: schema')
 if(metadata?.depth?.relative!==true)throw new Error('INVALID_DEPTH_METADATA: 结果必须自述为相对深度')
 if(metadata?.depth?.metric!==false)throw new Error('INVALID_DEPTH_METADATA: 本 provider 不产生米制深度，metric 必须为 false')
 for(const key of ['input','modelInput','modelOutput','fullDepth','preview'] as const){
  const size=metadata?.sizes?.[key] as DepthSizes|undefined
  if(!size||!Number.isInteger(size.width)||!Number.isInteger(size.height)||size.width<=0||size.height<=0)throw new Error('INVALID_DEPTH_METADATA: sizes.'+key)
 }
 return {artifacts,metadata}
}
export function summarizeOutput(metadata:Record<string,any>,model:DepthModelIdentity,artifacts:DepthArtifact[],outputDirectory:string):DepthOutputSummary{
 const gaps:string[]=[]
 const runtimeModel=metadata.model??{}
 const identity:DepthModelIdentity={...model,
  modelId:typeof runtimeModel.modelId==='string'?runtimeModel.modelId:model.modelId,
  revision:typeof runtimeModel.revision==='string'?runtimeModel.revision:model.revision,
  revisionSource:runtimeModel.revisionSource??model.revisionSource,
  license:typeof runtimeModel.license==='string'?runtimeModel.license:model.license,
  architecture:typeof runtimeModel.architecture==='string'?runtimeModel.architecture:model.architecture,
  weightsSha256:typeof runtimeModel.weightsSha256==='string'?runtimeModel.weightsSha256:model.weightsSha256,
  weightsBytes:typeof runtimeModel.weightsBytes==='number'?runtimeModel.weightsBytes:model.weightsBytes,
  maxDepthConfig:typeof runtimeModel.maxDepthConfig==='number'?runtimeModel.maxDepthConfig:null,
  depthEstimationType:typeof runtimeModel.depthEstimationType==='string'?runtimeModel.depthEstimationType:null,
 }
 if((identity.revisionSource??'unavailable')!=='manifest')gaps.push('MODEL_REVISION_UNKNOWN: 权重目录缺 '+MANIFEST_FILE+'，revision 未知')
 if(!identity.weightsSha256)gaps.push('WEIGHTS_SHA256_MISSING: 权重目录没有清单哈希（推理期不重算；可用 fetch-model.ts --verify-only 离线核对）')
 return {
  artifacts,
  image:metadata.image,
  sizes:metadata.sizes as DepthOutputSummary['sizes'],
  depth:{relative:true,metric:false,largerMeans:'closer',scale:String(metadata.depth.scale),dtype:'float32',statistics:metadata.depth.statistics},
  preprocessing:metadata.preprocessing??{},
  model:identity,
  gaps,
  outputDirectory,
 }
}
export interface DepthRunHooks { cancel:()=>void;done:Promise<{status:'completed'|'killed'|'failed';output:string;imagePath?:string}> }
/**
 * 真实运行：spawn python worker（stdin 一个 JSON 请求 → stdout 一条 LYAPUNOV_RESULT= 结果行）。
 * 缺解释器/worker/权重在任何写操作之前阻断（PROVIDER_UNAVAILABLE）；
 * 退出码/终止信号/取消信号三者共同决定终态，非零退出或取消绝不交 completed。
 */
export async function startDepthEstimation(subprocess:SubprocessRuntime,config:DepthEstimationConfig,request:DepthEstimationRequest,signal:AbortSignal,cwd?:string):Promise<DepthRunHooks>{
 signal.throwIfAborted()
 const state=await dependencyState(config)
 if(!state.available)throw new Error('PROVIDER_UNAVAILABLE: 深度估计 '+JSON.stringify(state.missing))
 const prepared=await prepareRequest(request,config,cwd)
 const paths=state.paths
 const runDirectory=join(resolveOutputRoot(config),prepared.requestId+'-'+randomUUID()),artifactsDirectory=join(runDirectory,'artifacts')
 await mkdir(artifactsDirectory,{recursive:true})
 signal.throwIfAborted()
 const payload={requestId:prepared.requestId,image:{path:prepared.image.path,bytes:prepared.image.bytes},params:prepared.params,model:{directory:resolve(paths.model!)},outputDirectory:artifactsDirectory,source:prepared.source??null}
 const child=subprocess.spawn({argv:[paths.python!,paths.worker!],cwd:runDirectory,stdio:{stdin:{data:JSON.stringify(payload)},stdout:{maxBytes:8_000_000},stderr:{maxBytes:200_000}},graceMs:5000,signal,env:{HF_ENDPOINT:'https://hf-mirror.com',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_XET:'1',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1',LYAPUNOV_DEPTH_MODEL_DIR:resolve(paths.model!),LYAPUNOV_DEPTH_DEVICE:prepared.params.device}})
 const done=child.done.then(async outcome=>{
  const stdout=child.collected.stdout?.readFrom(0).text??''
  const stderr=child.collected.stderr?.readFrom(0).text??''
  if(stderr.trim())await writeFile(join(runDirectory,'worker-stderr.log'),stderr,{mode:0o600})
  const lines=stdout.trim().split('\n'),prefixed=lines.slice().reverse().find(line=>line.startsWith(RESULT_PREFIX))
  let payloadResult:any
  let parseError:string|undefined
  if(prefixed){try{payloadResult=JSON.parse(prefixed.slice(RESULT_PREFIX.length)) }catch(error){parseError='INVALID_WORKER_RESULT: 结果行不是合法 JSON: '+String(error)}}
  else parseError='WORKER_RESULT_MISSING: worker 没有输出结果行'
  // 取消优先：外层信号已取消或进程被信号终止时，即便有 completed 形状的结果也不交付。
  const cancelled=signal.aborted||outcome.signal!==null
  if(parseError)return {status:cancelled?'killed' as const:'failed' as const,output:JSON.stringify({error:{code:parseError.split(':')[0],message:parseError,exitCode:outcome.exitCode,signal:outcome.signal,stderr:stderr.slice(-500)}})}
  if(payloadResult?.error)return {status:cancelled?'killed' as const:'failed' as const,output:JSON.stringify({error:payloadResult.error,exitCode:outcome.exitCode,signal:outcome.signal})}
  if(outcome.exitCode!==0)return {status:cancelled?'killed' as const:'failed' as const,output:JSON.stringify({error:{code:'WORKER_EXIT_NONZERO',message:'worker 退出码为非零',exitCode:outcome.exitCode,signal:outcome.signal,stderr:stderr.slice(-500)}})}
  if(cancelled)return {status:'killed' as const,output:JSON.stringify({error:{code:'CANCELLED',message:'运行被取消；产物不交付'}})}
  try{
   const {artifacts,metadata}=await collectArtifacts(payloadResult as DepthWorkerResult,artifactsDirectory)
   // 后处理阶段也可能被取消：交付前再确认一次，绝不投递旧结果。
   if(signal.aborted)return {status:'killed' as const,output:JSON.stringify({error:{code:'CANCELLED',message:'产物校验期间被取消；产物不交付'}})}
   const identity=modelIdentity(paths.model!,state.manifest)
   const output=summarizeOutput(metadata,identity,artifacts,runDirectory)
   const value:DepthEstimationResult={provider:'depth-anything-v2',requestId:prepared.requestId,source:prepared.source,output,runtime:{worker:paths.worker!,python:paths.python!,device:prepared.params.device,packages:(metadata.runtime?.packages??{}) as Record<string,string>}}
   const preview=artifacts.find(item=>item.type==='depth.preview.color.png')
   return {status:'completed' as const,output:JSON.stringify(value),imagePath:preview?.path}
  }catch(error){return {status:'failed' as const,output:String(error instanceof Error?error.message:String(error))}}
 })
 return {cancel:()=>child.terminate(),done}
}
/** 只读状态查询：供 root 与诊断使用，不加载模型、不创建任何目录。 */
export async function depthProviderStatus(config:DepthEstimationConfig={}){
 const state=await dependencyState(config)
 return {available:state.available,missing:state.missing,paths:resolveDepthPaths(config),outputRoot:state.outputRoot,modelFiles:state.modelFiles,manifest:state.manifest,identity:state.paths.model?modelIdentity(state.paths.model,state.manifest):null}
}
