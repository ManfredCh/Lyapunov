/**
 * Depth-Anything-V2-Small 权重获取与校验（只走 HF 镜像，绝不回退 huggingface.co）。
 *
 * 用法：
 *   node packages/depth-estimation/script/fetch-model.ts --local-dir <目录> [--verify-only]
 *
 * 行为：
 * 1) 用 `hf models info`（HF_ENDPOINT 指向镜像）解析模型身份与默认 revision；
 * 2) 用 `hf download --revision <sha>` 只取 config.json / preprocessor_config.json / model.safetensors / README.md；
 * 3) 逐个文件算 sha256 并写 `<目录>/lyapunov-model-manifest.json`：这是**唯一**的权重哈希时机
 *    （下载时写、`--verify-only` 离线重核）；worker 推理期只从清单取 revision/许可，不再重算哈希。
 *
 * 安全边界：endpoint 必须是 hf-mirror.com（或显式 --endpoint 指定的等价镜像）；
 * 任何解析到 huggingface.co 的取值直接失败，不静默切换。ALL_PROXY/all_proxy 若是 socks://
 * 形（httpx 不解析该 scheme）会在子进程中剔除并打印说明——只报变量名与原因，绝不打印变量值
 * （代理 URL 可能内嵌凭据）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir,open,readFile,stat,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL_ID='depth-anything/Depth-Anything-V2-Small-hf'
const FILES=['config.json','preprocessor_config.json','model.safetensors','README.md'] as const
const MIRROR='https://hf-mirror.com'
const MANIFEST='lyapunov-model-manifest.json'

function usage():never{
 console.error('用法: node packages/depth-estimation/script/fetch-model.ts --local-dir <目录> [--verify-only] [--endpoint https://hf-mirror.com] [--model-id <repo>]')
 process.exit(2)
}
function parseArgs(argv:string[]){
 const options={localDir:'',verifyOnly:false,endpoint:process.env.HF_ENDPOINT??MIRROR,modelId:MODEL_ID}
 for(let index=0;index<argv.length;index++){
  const arg=argv[index]
  if(arg==='--local-dir')options.localDir=argv[++index]??''
  else if(arg==='--verify-only')options.verifyOnly=true
  else if(arg==='--endpoint')options.endpoint=argv[++index]??''
  else if(arg==='--model-id')options.modelId=argv[++index]??''
  else usage()
 }
 if(!options.localDir)usage()
 return options
}
/** 只允许镜像端点：官方 hub 或未知 host 一律拒绝，避免任何静默回退。 */
export function assertMirrorEndpoint(endpoint:string){
 let url:URL
 try{url=new URL(endpoint)}catch{throw new Error('INVALID_ENDPOINT: '+endpoint)}
 const host=url.hostname.toLowerCase()
 if(host==='huggingface.co'||host.endsWith('.huggingface.co'))throw new Error('ENDPOINT_FORBIDDEN: 禁止直连官方 Hub，请使用 https://hf-mirror.com')
 if(host!=='hf-mirror.com')throw new Error('ENDPOINT_NOT_MIRROR: 只接受 hf-mirror.com（收到 '+host+'）；缺对象时应报告阻断而不是换端点')
 if(url.protocol!=='https:')throw new Error('ENDPOINT_INSECURE: 镜像必须使用 https')
 return url
}
function childEnv(endpoint:string){
 const env:{[key:string]:string|undefined}={...process.env,HF_ENDPOINT:endpoint,HF_HUB_DISABLE_TELEMETRY:'1'}
 for(const key of ['ALL_PROXY','all_proxy'] as const){
  const value=env[key]
  if(value&&value.toLowerCase().startsWith('socks')){
   console.log(`[fetch-model] 剔除代理变量 ${key}（值为 socks:// 形，httpx 不解析该 scheme；仅在本次下载子进程内剔除）——只报变量名不报变量值：代理 URL 可能内嵌凭据`)
   delete env[key]
  }
 }
 return env as NodeJS.ProcessEnv
}
async function run(command:string,args:string[],env:NodeJS.ProcessEnv){
 return await new Promise<{code:number;stdout:string;stderr:string}>((settle,reject)=>{
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',chunk=>{stdout+=chunk})
  child.stderr.on('data',chunk=>{stderr+=chunk})
  child.on('error',reject)
  child.on('close',code=>settle({code:code??-1,stdout,stderr}))
 })
}
async function sha256(path:string){
 const handle=await open(path,'r');const hash=createHash('sha256')
 try{for await (const chunk of handle.createReadStream())hash.update(chunk);return hash.digest('hex')}finally{await handle.close()}
}
export async function fetchDepthModel(options:{localDir:string;endpoint?:string;modelId?:string;verifyOnly?:boolean}){
 const endpoint=options.endpoint??MIRROR
 assertMirrorEndpoint(endpoint)
 const localDir=resolve(options.localDir)
 const modelId=options.modelId??MODEL_ID
 await mkdir(localDir,{recursive:true})
 const env=childEnv(endpoint)
 let revision:string|undefined
 if(!options.verifyOnly){
  const info=await run('hf',['models','info',modelId,'--format','json'],env)
  if(info.code!==0)throw new Error('HF_INFO_FAILED: '+info.stderr.trim().slice(0,500))
  const parsed=JSON.parse(info.stdout) as {sha?:string;tags?:string[];id?:string}
  revision=parsed.sha
  if(!revision)throw new Error('HF_INFO_INCOMPLETE: 镜像未返回 revision，阻断而不猜测')
  if(parsed.id!==modelId)throw new Error('HF_MODEL_MISMATCH: 期望 '+modelId+'，镜像返回 '+String(parsed.id))
  const download=await run('hf',['download',modelId,'--revision',revision,...FILES,'--local-dir',localDir],env)
  if(download.code!==0)throw new Error('HF_DOWNLOAD_FAILED: '+download.stderr.trim().slice(0,500))
 }
 const files:Record<string,{bytes:number;sha256:string}>={}
 for(const name of FILES){
  const path=join(localDir,name)
  const info=await stat(path).catch(()=>null)
  if(!info?.isFile()||info.size===0)throw new Error('MODEL_FILE_MISSING: '+path+'（镜像缺对象时报告阻断，不换端点）')
  files[name]={bytes:info.size,sha256:await sha256(path)}
 }
 const existing=await readFile(join(localDir,MANIFEST),'utf8').then(text=>JSON.parse(text) as {revision?:string}).catch(()=>null)
 const manifest={modelId,revision:revision??existing?.revision??null,license:'apache-2.0',source:{endpoint,fetchedAt:new Date().toISOString(),command:`hf download ${modelId} --revision <sha> ... --local-dir ${localDir}`},files}
 if(!manifest.revision)throw new Error('MODEL_REVISION_MISSING: 无 --verify-only 之外的既有清单可继承，无法记录 revision')
 await writeFile(join(localDir,MANIFEST),JSON.stringify(manifest,null,2)+'\n')
 return {localDir,manifest,verifiedOnly:Boolean(options.verifyOnly)}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options=parseArgs(process.argv.slice(2))
 const result=await fetchDepthModel({localDir:options.localDir,endpoint:options.endpoint,modelId:options.modelId,verifyOnly:options.verifyOnly})
 console.log(JSON.stringify({status:'ok',localDir:result.localDir,revision:result.manifest.revision,files:Object.keys(result.manifest.files),verifiedOnly:result.verifiedOnly},null,2))
}
