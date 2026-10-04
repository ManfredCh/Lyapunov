/**
 * 单目相对深度适配的真实行为测试：真实 venv 解释器 + 真实 Depth-Anything-V2-Small 权重 +
 * 真实照片，走完整插件装配（cordis Context + 原生 tools/jobs/commands/subprocess/attachments）。
 * 夹具只用于“缺权重应当阻断 / 常量产物必须被接受 / 非零退出必须失败 / 取消落在附件化期间 /
 * Command 不附件化”这类负例与边界例；正向用例（含同步与后台的图像交付）没有任何模型替身。
 *
 * 前置（缺任一项直接退出 2，不伪装通过）：
 *   LYAPUNOV_DEPTH_TEST_PYTHON    本包 venv 的 python（含 torch/transformers/Pillow）
 *   LYAPUNOV_DEPTH_TEST_MODEL_DIR 经 hf-mirror 下载、带 lyapunov-model-manifest.json 的权重目录
 *   LYAPUNOV_DEPTH_TEST_IMAGE     真实输入照片（只读）
 *   LYAPUNOV_DEPTH_TEST_DATA_DIR  产物目录（可选，默认 mkdtemp）
 * 用法：node packages/depth-estimation/test/depth-estimate.test.ts
 * 退出码：0=全部通过；1=有失败；2=缺前置条件。
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { spawn } from 'node:child_process'
import { mkdir,mkdtemp,open,readFile,stat,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,join } from 'node:path'
import { apply,name as pluginName,type Config } from '../src/plugin.ts'
import { collectArtifacts,dependencyState,depthProviderStatus,prepareRequest,startDepthEstimation } from '../src/operations.ts'
import type { DepthEstimationResult } from '../src/types.ts'

const python=process.env.LYAPUNOV_DEPTH_TEST_PYTHON
const modelDirectory=process.env.LYAPUNOV_DEPTH_TEST_MODEL_DIR
const image=process.env.LYAPUNOV_DEPTH_TEST_IMAGE
const dataDirectory=process.env.LYAPUNOV_DEPTH_TEST_DATA_DIR
const EXPECTED_REVISION='5426e4f0f36572d16453bbda7a8389317b1bef99'
const failures:string[]=[]
let passed=0
async function check(name:string,body:()=>Promise<void>|void){
 try{await body();passed++;console.log('  ok  '+name)}
 catch(error){failures.push(name+': '+(error instanceof Error?error.message:String(error)));console.log('  FAIL '+name+' → '+(error instanceof Error?error.message:String(error)))}
}
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message)}
/** 独立读 npy 头：形状/dtype 由文件本身给出，不采信 metadata 自述。 */
async function readNpyHeader(path:string){
 const handle=await open(path,'r')
 try{
  const buffer=Buffer.alloc(256);const {bytesRead}=await handle.read(buffer,0,buffer.length,0)
  assert(buffer.subarray(0,6).toString('latin1')==='\x93NUMPY','npy magic 不对: '+path)
  const headerLength=buffer.readUInt16LE(8);const header=buffer.subarray(10,10+headerLength).toString('latin1')
  const shape=/\(([^)]*)\)/.exec(header.replace(/'shape':\s*/,''))?.[1]??''
  const dimensions=shape.split(',').map(part=>part.trim()).filter(Boolean).map(Number)
  const dtype=/'descr':\s*'([^']+)'/.exec(header)?.[1]??''
  const info=await stat(path)
  return {dimensions,dtype,bytes:info.size,headerLength,bytesRead}
 }finally{await handle.close()}
}
/**
 * 采样统计（整段读入后每 97 个像素取 1 个，跨全图均匀分布），用于独立复核“数值确实有变化”。
 * 不能只取文件开头：起始区是天空，ReLU 后恒为 0，那会得出“全零”的错误结论。
 */
async function sampleNpyStatistics(path:string,shape:number[]){
 const handle=await open(path,'r')
 try{
  const headerLength=(await readNpyHeader(path)).headerLength;const offset=10+headerLength
  const total=shape[0]*shape[1]
  const buffer=Buffer.alloc(total*4)
  const {bytesRead}=await handle.read(buffer,0,buffer.length,offset)
  assert(bytesRead===total*4,'npy 数据区读取不完整: '+bytesRead+'/'+(total*4))
  let min=Infinity,max=-Infinity,sum=0,sumSquares=0,count=0
  for(let position=0;position<total;position+=97){
   const value=buffer.readFloatLE(position*4)
   min=Math.min(min,value);max=Math.max(max,value);sum+=value;sumSquares+=value*value;count++
  }
  const mean=sum/count
  return {min,max,mean,std:Math.sqrt(Math.max(0,sumSquares/count-mean*mean)),samples:count}
 }finally{await handle.close()}
}
async function readPngSize(path:string){
 const handle=await open(path,'r')
 try{
  const buffer=Buffer.alloc(24);await handle.read(buffer,0,24,0)
  assert(buffer.subarray(1,4).toString('latin1')==='PNG','PNG magic 不对: '+path)
  return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}
 }finally{await handle.close()}
}
async function jsonFromToolResult(result:{content?:unknown[]}){
 const block=(result.content??[]).find(item=>typeof (item as {text?:string}).text==='string') as {text:string}|undefined
 assert(block,'tool 结果缺少文本块')
 return {blocks:result.content??[],text:block.text,value:JSON.parse(block.text) as Record<string,unknown>}
}
/** 写一个最小合法 float32 npy（测试夹具用：验证常量产物必须被接受）。 */
function npyBuffer(values:number[][],width:number,height:number){
 const header=`{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}), }`
 const padding=(64-(10+header.length+1)%64)%64
 const headerText=header+' '.repeat(padding)+'\n'
 const prefix=Buffer.alloc(10+headerText.length)
 prefix.write('\x93NUMPY','latin1');prefix.writeUInt8(1,6);prefix.writeUInt8(0,7);prefix.writeUInt16LE(headerText.length,8);prefix.write(headerText,10,'latin1')
 const body=Buffer.alloc(width*height*4)
 let index=0
 for(const row of values)for(const value of row)body.writeFloatLE(value,index++*4)
 return Buffer.concat([prefix,body])
}
const TINY_PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')
interface AttachmentService {saveImage(input:{data:Buffer;mediaType:'image/png';name?:string}):Promise<{mediaType?:string;width?:number;height?:number;bytes?:number}>}
let realAttachments:AttachmentService|undefined
/**
 * 附件闸门（只存在于测试里）：拦下一次 saveImage，进入时触发 entered，等 release() 才继续。
 * 这样“取消发生在附件化期间”是确定性窗口——先等到 entered，再取消，再放行，
 * 顺序固定，不需要造 2GiB 产物，也不靠计时赌博。
 */
let pendingHold:{enter:()=>void;gate:Promise<void>}|undefined
let pendingFailure:string|undefined
let saveImageCalls=0
const gatedAttachments:AttachmentService={
 async saveImage(input){
  saveImageCalls++
  if(pendingFailure){const message=pendingFailure;pendingFailure=undefined;throw new Error(message)}
  const hold=pendingHold
  if(hold){pendingHold=undefined;hold.enter();await hold.gate}
  return realAttachments!.saveImage(input)
 },
}
/** 只给“附件化失败”用例用：让下一次 saveImage 抛错（模拟存储不可用）。 */
function failNextSaveImage(message:string){pendingFailure=message}
function holdNextSaveImage(){
 let enter:()=>void=()=>{}
 let release:()=>void=()=>{}
 const entered=new Promise<void>(resolve=>{enter=resolve})
 const gate=new Promise<void>(resolve=>{release=resolve})
 pendingHold={enter,gate}
 return {entered,release:()=>{pendingHold=undefined;release()}}
}

const missing=['LYAPUNOV_DEPTH_TEST_PYTHON','LYAPUNOV_DEPTH_TEST_MODEL_DIR','LYAPUNOV_DEPTH_TEST_IMAGE'].filter(name=>!process.env[name])
if(missing.length){
 console.error('缺少真实前置环境变量，未运行任何用例（不伪装通过）: '+missing.join(', '))
 process.exit(2)
}
const scratch=dataDirectory??await mkdtemp(join(tmpdir(),'lyapunov-depth-test-'))
await mkdir(scratch,{recursive:true})
const outputRoot=join(scratch,'outputs')
const config:Config={pythonPath:python,modelDirectory,dataDirectory:outputRoot}

const ctx=new Context()
// 装配的是原生服务本体（subprocess/jobs/systemPrompt/tools/commands/attachments），不是替身：
// 缺 tools 就注册不了工具，缺 jobs 后台路径无从验证，缺 attachments 图像附件无从验证。
await ctx.plugin(LocalSubprocess)
await ctx.plugin(JobsLocal)
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(Commands)
// 原生后台作业控制器：真实装配里由 script/runtime-patch.ts 的 lyapunov-tool-jobs 提供，
// 没有它 ctx.jobs.start 会明确拒绝（"no job controller serves this agent"）。
await ctx.plugin(ToolJobs as never,undefined as never)
// 作业 owner 权限校验要活的 agent 注册表（jobs-local 会核对 agents.get(owner.id)===owner）。
await ctx.plugin(AgentRegistry)
// 附件存储本体依赖 sharp（本仓 node_modules 没装）。缺它时图像根本存不进去：
// 用一张最小 PNG 先探测，环境缺依赖就退 2，绝不让“没有图像块”变成含糊的假失败。
// 真实装配里由 dsh-base 的 cordis.patch.yml 挂载 attachment-local；这里挂同一个实现（放在独立
// Context 里只为取它的实现——主装配里的 attachments 是它外面套了一层测试闸门，见下）。
const storeHost=new Context()
await storeHost.plugin(LocalAttachmentStore as never,{dshHome:join(scratch,'dsh-home')} as never)
realAttachments=storeHost.get('attachments') as AttachmentService|undefined
if(!realAttachments){console.error('附件服务未装配，未运行任何用例');process.exit(2)}
const probe=await realAttachments.saveImage({data:TINY_PNG,mediaType:'image/png',name:'probe.png'}).then(()=>null).catch((error:unknown)=>String(error))
if(probe){console.error('附件存储不可用（多为缺 sharp 原生依赖，可用 NODE_PATH 指向本机已有安装），未运行任何用例: '+probe.slice(0,300));process.exit(2)}
// 主装配里的 attachments：同一个实现 + 一层**测试闸门**（默认直通）。只有取消用例会拦下一次
// saveImage，把“取消落在附件化期间”变成确定性窗口（不靠大文件，也不靠计时赌博）。
await ctx.plugin((scope:Context)=>{scope.provide('attachments',gatedAttachments as never)})
apply(ctx,config)
/**
 * 只给“后台作业完成通知”用：注册一个带独立 scope 的假 owner（照上游 tool-jobs.spec.ts 的 fakeAgent 写法），
 * 捕获它收到的 inject 消息。会话 header 带 cwd，用来验证相对输入图路径按会话 cwd 解析。
 */
async function registerFakeOwner(sessionId:string,cwd:string,inbox:unknown[]){
 const scopeFiber=await ctx.plugin(()=>{})
 const id=SessionId(sessionId)
 const agent={id,ctx:scopeFiber.ctx,inject:(message:unknown)=>inbox.push(message),followup:()=>{},status:'running',session:{id,header:{version:0,id,createdAt:0,isSeeded:false,cwd}}} as unknown as Agent
 const release=await ctx.agents.register(agent)
 return {agent,dispose:async()=>{await release();await scopeFiber.dispose()}}
}
console.log('驱动: '+python+'\n权重: '+modelDirectory+'\n照片: '+image+'\n产物: '+scratch+'\n')

console.log('[1] 依赖与权重身份')
// 这个路径全程只读、从不创建：用来验证“读前置”与“写前置”是分开的，
// 每次运行都拿它当“尚未创建的输出根”，所以判定与上一次运行残留无关。
const untouchedRoot=join(scratch,'outputs-untouched')
await check('dependencyState 读取前置齐备、revision 正确，输出根缺失不算阻断',async()=>{
 const state=await dependencyState({...config,dataDirectory:untouchedRoot})
 assert(state.available,'依赖不齐: '+JSON.stringify(state.missing))
 assert(state.manifest?.revision===EXPECTED_REVISION,'revision 不符: '+String(state.manifest?.revision))
 const weights=state.modelFiles.find(file=>file.file==='model.safetensors')
 assert(weights&&weights.bytes>90_000_000,'model.safetensors 字节数不合理: '+JSON.stringify(weights))
 assert(state.outputRoot.path===untouchedRoot,'输出根路径不符: '+JSON.stringify(state.outputRoot))
 assert(state.outputRoot.exists===false,'尚未创建的输出根被报告成已存在: '+JSON.stringify(state.outputRoot))
 assert(!await stat(untouchedRoot).catch(()=>null),'只读核查创建了输出根: '+untouchedRoot)
})
await check('深度权重目录缺失时列出具体缺失项（不静默降级）',async()=>{
 const state=await dependencyState({...config,modelDirectory:join(scratch,'not-a-model')})
 assert(!state.available,'缺权重目录却报告可用')
 assert(state.missing.some(item=>String(item.dependency).startsWith('model')),'未列出 model 缺失项')
})
await check('depthProviderStatus 只读返回身份且不创建输出根',async()=>{
 const status=await depthProviderStatus({...config,dataDirectory:untouchedRoot})
 assert(status.identity?.revision===EXPECTED_REVISION,'identity revision 不符: '+String(status.identity?.revision))
 assert(status.identity?.license==='apache-2.0','license 应为 apache-2.0，实际 '+String(status.identity?.license))
 const info=await stat(untouchedRoot).catch(()=>null)
 assert(info===null,'只读 status 不该创建输出根: '+untouchedRoot)
})

console.log('[2] 请求校验（无需加载模型）')
await check('非法 modelInputSize 被拒',async()=>{
 let code=''
 try{await prepareRequest({requestId:'bad-size',image:{path:image!},params:{modelInputSize:520}},config)}catch(error){code=String(error)}
 assert(code.includes('INVALID_PARAMS'),'未按 INVALID_PARAMS 拒绝: '+code)
})
await check('未实现参数被拒',async()=>{
 let code=''
 try{await prepareRequest({requestId:'bad-param',image:{path:image!},params:{depth_output:'input'} as never},config)}catch(error){code=String(error)}
 assert(code.includes('UNSUPPORTED_CAPABILITY'),'未按 UNSUPPORTED_CAPABILITY 拒绝: '+code)
})
await check('缺权重时同步入口在 spawn 前明确阻断',async()=>{
 let code=''
 try{await startDepthEstimation(ctx.subprocess,{...config,modelDirectory:join(scratch,'not-a-model')},{requestId:'no-model',image:{path:image!}},new AbortController().signal)}catch(error){code=String(error)}
 assert(code.includes('PROVIDER_UNAVAILABLE'),'未按 PROVIDER_UNAVAILABLE 阻断: '+code)
})
await check('相对输入图路径按会话 cwd 解析',async()=>{
 const cwd=join(image!,'..','..')
 const prepared=await prepareRequest({requestId:'rel-path',image:{path:'refs/'+image!.split('/').pop()}},config,cwd)
 assert(prepared.image.path===image,'相对路径未按会话 cwd 解析: '+prepared.image.path)
 let code=''
 try{await prepareRequest({requestId:'rel-path',image:{path:'refs/'+image!.split('/').pop()}},config,'/nonexistent-cwd')}catch(error){code=String(error)}
 assert(code.includes('INVALID_INPUT_FILE'),'错误 cwd 下应报输入不存在: '+code)
})
await check('source 可整体省略（网络照片没有 scene/frame）',async()=>{
 const prepared=await prepareRequest({requestId:'no-source',image:{path:image!}},config)
 assert(prepared.source===undefined,'省略 source 不该被补默认值')
 let code=''
 try{await prepareRequest({requestId:'bad-source',image:{path:image!},source:{worldId:'w1'} as never},config)}catch(error){code=String(error)}
 assert(code.includes('INVALID_SOURCE'),'worldId 缺 worldGeneration 应被拒: '+code)
})

console.log('[3] 真实同步运行（Tool 全链路 + 图像附件）')
let result:DepthEstimationResult|undefined
await check('depth_estimate 同步返回真实 npy/PNG/尺寸/统计，并带一张预览图像',async()=>{
 const started=Date.now()
 const called=await ctx.tools.execute({callId:'test-depth-sync' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-sync',image:{path:image},source:{sceneId:'scene-test',sceneRevision:1,frameId:'frame-test'}})},signal:new AbortController().signal})
 const seconds=((Date.now()-started)/1000).toFixed(1)
 const payload=await jsonFromToolResult(called as {content?:unknown[]})
 const value=payload.value as unknown as DepthEstimationResult
 result=value
 console.log('      运行耗时 '+seconds+'s；'+payload.text.length+' 字节结果；'+payload.blocks.length+' 个内容块')
 assert(value.provider==='depth-anything-v2','provider 字段不符')
 assert(value.output.depth.relative===true&&value.output.depth.metric===false,'相对/米制标记不对')
 assert(value.output.model.revision===EXPECTED_REVISION,'revision 不符: '+String(value.output.model.revision))
 assert(value.output.model.maxDepthConfig!==null,'缺 max_depth 记录')
 const sizes=value.output.sizes
 assert(sizes.modelInput.height===518&&sizes.modelInput.width%14===0,'模型输入尺寸异常: '+JSON.stringify(sizes.modelInput))
 assert(sizes.input.width===3840&&sizes.input.height===2880,'输入尺寸异常: '+JSON.stringify(sizes.input))
 assert(sizes.preview.width===1024,'预览尺寸异常: '+JSON.stringify(sizes.preview))
 assert(value.output.image.path===image,'结果未记录来源原图: '+String(value.output.image.path))
 const types=value.output.artifacts.map(artifact=>artifact.type).sort()
 assert(types.join(',')==='depth.image.npy,depth.metadata.json,depth.model.npy,depth.preview.color.png,depth.preview.png','产物类型不齐: '+types.join(','))
 for(const artifact of value.output.artifacts)assert(artifact.size_bytes>0,'空产物: '+artifact.type)
 // 交付读数必须如实：本次确实附件化成功，且走的是一次性 tool-result 载体。
 assert(value.imageDelivery?.mode==='tool-result'&&value.imageDelivery.attached===1,'同步交付读数不对: '+JSON.stringify(value.imageDelivery))
 assert(!value.imageDelivery.error,'交付读数为成功却带 error: '+String(value.imageDelivery.error))
 const imageBlock=payload.blocks.find(block=>(block as {type?:string}).type==='image') as {attachment?:{mediaType?:string;width?:number;height?:number;bytes?:number;name?:string}}|undefined
 assert(imageBlock,'同步结果没有图像内容块（模型看不到预览）')
 // 附件存储会把预览归一化再落盘（本机实现按内容重新编码为 jpeg），所以只验“确实是图像”，并核对尺寸。
 assert(String(imageBlock.attachment?.mediaType).startsWith('image/'),'附件不是图像: '+String(imageBlock.attachment?.mediaType))
 assert((imageBlock.attachment?.bytes??0)>0,'附件字节数为 0')
 assert(imageBlock.attachment?.width===value.output.sizes.preview.width&&imageBlock.attachment?.height===value.output.sizes.preview.height,'附件尺寸与预览不一致: '+JSON.stringify(imageBlock.attachment))
})
await check('原图尺寸 npy 的形状/数值经独立读取复核',async()=>{
 assert(result,'上一用例未产出结果')
 const artifact=result.output.artifacts.find(item=>item.type==='depth.image.npy')!
 const header=await readNpyHeader(artifact.path)
 assert(header.dtype.includes('f4'),'dtype 不是 float32: '+header.dtype)
 assert(header.dimensions[0]===2880&&header.dimensions[1]===3840,'npy 形状与输入尺寸不一致: '+JSON.stringify(header.dimensions))
 assert(header.bytes===10+header.headerLength+2880*3840*4,'npy 字节数与形状不符: '+header.bytes)
 const statistics=await sampleNpyStatistics(artifact.path,header.dimensions)
 console.log('      采样 '+statistics.samples+' 点: min='+statistics.min.toFixed(3)+' max='+statistics.max.toFixed(3)+' mean='+statistics.mean.toFixed(3)+' std='+statistics.std.toFixed(3))
 assert(statistics.std>0.5,'深度图变化过小（可能不是真实推理）: std='+statistics.std)
 assert(statistics.max>1,'深度最大值异常: '+statistics.max)
 assert(statistics.min<0.5,'深度最小值异常: '+statistics.min)
 const modelArtifact=result.output.artifacts.find(item=>item.type==='depth.model.npy')!
 const modelHeader=await readNpyHeader(modelArtifact.path)
 assert(modelHeader.dimensions[0]===518&&modelHeader.dimensions[1]===686,'模型尺寸 npy 形状异常: '+JSON.stringify(modelHeader.dimensions))
})
await check('PNG 实际尺寸与 metadata 一致且带说明文本',async()=>{
 assert(result,'上一用例未产出结果')
 const preview=result.output.artifacts.find(item=>item.type==='depth.preview.png')!
 const size=await readPngSize(preview.path)
 assert(size.width===result.output.sizes.preview.width&&size.height===result.output.sizes.preview.height,'PNG 与 metadata 尺寸不一致: '+JSON.stringify(size))
 // PNG 的 iTXt 文本块按 UTF-8 编码，用 utf8 解码才能匹配中文说明。
 const text=(await readFile(preview.path)).toString('utf8')
 assert(text.includes('Depth-Anything-V2-Small'),'PNG 未内嵌模型说明文本')
 assert(text.includes('非米制'),'PNG 说明文本缺失“非米制”限定')
})
await check('缺口清单如实反映权重清单状态',async()=>{
 assert(result,'上一用例未产出结果')
 assert(!result.output.gaps.some(gap=>gap.startsWith('MODEL_REVISION_UNKNOWN')),'有清单却报 revision 未知: '+JSON.stringify(result.output.gaps))
})

console.log('[4] 常量预测与失败分类')
await check('常量深度产物通过运行层校验（std=0 不再当失败）',async()=>{
 const directory=join(scratch,'constant-fixture');await mkdir(directory,{recursive:true})
 const rows=(height:number,width:number)=>Array.from({length:height},()=>Array.from({length:width},()=>2.5))
 await writeFile(join(directory,'c-depth.npy'),npyBuffer(rows(4,6),6,4))
 await writeFile(join(directory,'c-model.npy'),npyBuffer(rows(2,3),3,2))
 await writeFile(join(directory,'c-gray.png'),TINY_PNG)
 await writeFile(join(directory,'c-color.png'),TINY_PNG)
 await writeFile(join(directory,'c-metadata.json'),JSON.stringify({
  schema:'lyapunov.depth-estimation/1',provider:'depth-anything-v2',
  sizes:{input:{width:6,height:4},modelInput:{width:6,height:4},modelOutput:{width:3,height:2},fullDepth:{width:6,height:4},preview:{width:1,height:1}},
  depth:{relative:true,metric:false,statistics:{min:2.5,max:2.5,mean:2.5,std:0,nonFiniteCount:0,validPixels:24,constant:true}},
 }))
 const collected=await collectArtifacts({artifacts:[
  {type:'depth.image.npy',path:join(directory,'c-depth.npy'),bytes:0},
  {type:'depth.model.npy',path:join(directory,'c-model.npy'),bytes:0},
  {type:'depth.preview.png',path:join(directory,'c-gray.png'),bytes:0},
  {type:'depth.preview.color.png',path:join(directory,'c-color.png'),bytes:0},
  {type:'depth.metadata.json',path:join(directory,'c-metadata.json'),bytes:0},
 ],metadata:{}},directory)
 assert(collected.metadata.depth.statistics.std===0,'夹具读数不符')
 assert(collected.artifacts.length===5,'产物收集数量不对: '+collected.artifacts.length)
 assert(collected.artifacts.every(artifact=>artifact.size_bytes>0&&artifact.uri.startsWith('file:')),'产物引用不完整: '+JSON.stringify(collected.artifacts))
})
await check('产物文件真的不存在时报缺失（运行层只认真实文件，不采信声明）',async()=>{
 const directory=join(scratch,'missing-fixture');await mkdir(directory,{recursive:true})
 await writeFile(join(directory,'m-metadata.json'),JSON.stringify({schema:'lyapunov.depth-estimation/1',depth:{relative:true,metric:false},sizes:{input:{width:6,height:4},modelInput:{width:6,height:4},modelOutput:{width:3,height:2},fullDepth:{width:6,height:4},preview:{width:1,height:1}}}))
 let code=''
 try{
  await collectArtifacts({artifacts:[
   {type:'depth.image.npy',path:join(directory,'gone-depth.npy'),bytes:1},
   {type:'depth.model.npy',path:join(directory,'m-model.npy'),bytes:1},
   {type:'depth.preview.png',path:join(directory,'m-gray.png'),bytes:1},
   {type:'depth.preview.color.png',path:join(directory,'m-color.png'),bytes:1},
   {type:'depth.metadata.json',path:join(directory,'m-metadata.json'),bytes:1},
  ],metadata:{}},directory)
 }catch(error){code=String(error)}
 assert(code.includes('DEPTH_ARTIFACT_MISSING'),'文件不存在应报缺失: '+code)
 // 逃逸产物目录同样被拒（路径归属是运行层事实，与数值无关）。
 await writeFile(join(scratch,'escape.json'),'{}')
 let escape=''
 try{
  await collectArtifacts({artifacts:[
   {type:'depth.image.npy',path:join(scratch,'escape.json'),bytes:2},
   {type:'depth.model.npy',path:join(scratch,'escape.json'),bytes:2},
   {type:'depth.preview.png',path:join(scratch,'escape.json'),bytes:2},
   {type:'depth.preview.color.png',path:join(scratch,'escape.json'),bytes:2},
   {type:'depth.metadata.json',path:join(scratch,'escape.json'),bytes:2},
  ],metadata:{}},directory)
 }catch(error){escape=String(error)}
 assert(escape.includes('ARTIFACT_OUTSIDE_OUTPUT'),'逃逸产物目录应被拒: '+escape)
})
await check('真实无纹理（纯色）输入返回有效结果与有限读数，不因方差小阻断',async()=>{
 const flat=join(scratch,'flat-input.png')
 const made=await new Promise<number|null>((settle,reject)=>{
  const child=spawn(python!,[ '-c',`from PIL import Image; Image.new('RGB',(640,480),(128,128,128)).save('${flat}')`],{stdio:['ignore','pipe','pipe']})
  child.on('error',reject);child.on('close',settle)
 })
 assert(made===0,'生成纯色输入图失败，退出码 '+String(made))
 const hooks=await startDepthEstimation(ctx.subprocess,{...config,dataDirectory:join(scratch,'outputs-flat')},{requestId:'ts-flat',image:{path:flat}},new AbortController().signal)
 const outcome=await hooks.done
 assert(outcome.status==='completed','纯色输入应返回有效结果，实际 '+outcome.status+': '+outcome.output.slice(0,300))
 const value=JSON.parse(outcome.output) as DepthEstimationResult
 const stats=value.output.depth.statistics
 console.log('      纯色输入读数: min='+stats.min.toFixed(4)+' max='+stats.max.toFixed(4)+' std='+stats.std.toFixed(4)+' constant='+String(stats.constant))
 assert(typeof stats.constant==='boolean','缺 constant 读数')
 assert(Number.isFinite(stats.std)&&Number.isFinite(stats.min)&&Number.isFinite(stats.max),'读数不是有限数值')
 assert(value.output.sizes.input.width===640&&value.output.sizes.input.height===480,'纯色输入尺寸记录不对: '+JSON.stringify(value.output.sizes.input))
})
await check('worker 非零退出即便打印结果行也判失败（不交 completed）',async()=>{
 const fake=join(scratch,'fake-worker.py')
 await writeFile(fake,"import sys,json\nprint('LYAPUNOV_RESULT='+json.dumps({'artifacts':[],'metadata':{}}))\nsys.exit(3)\n")
 const hooks=await startDepthEstimation(ctx.subprocess,{...config,workerPath:fake,dataDirectory:join(scratch,'outputs-fake')},{requestId:'ts-exit3',image:{path:image!}},new AbortController().signal)
 const outcome=await hooks.done
 assert(outcome.status==='failed','非零退出应判失败，实际 '+outcome.status)
 assert(outcome.output.includes('WORKER_EXIT_NONZERO'),'失败原因不是退出码: '+outcome.output.slice(0,200))
})

console.log('[5] 后台 Jobs 与取消')
await check('background=true 走 DSH Jobs 并能读到真实结果字符串',async()=>{
 const started=await ctx.tools.execute({callId:'test-depth-job' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-job',image:{path:image},params:{previewMaxSide:512}}),background:true},signal:new AbortController().signal})
 const payload=await jsonFromToolResult(started as {content?:unknown[]})
 const jobId=String((payload.value as {jobId?:string}).jobId)
 assert(/^depth_estimate-\d+$/.test(jobId),'jobId 形状异常: '+jobId)
 const deadline=Date.now()+300_000
 let read=ctx.jobs.read(jobId as never)
 while(!['completed','failed','killed'].includes(String(read.job.status))){
  assert(Date.now()<deadline,'后台作业超时未收敛: '+JSON.stringify(read.job))
  await new Promise(resolve=>setTimeout(resolve,1000))
  read=ctx.jobs.read(jobId as never)
 }
 assert(String(read.job.status)==='completed','后台作业状态不是 completed: '+JSON.stringify(read.job))
 assert((read.result ?? '').includes('depth.image.npy'),'Jobs 输出不是含产物的 JSON 字符串: '+(read.result ?? '').slice(0,200))
 const parsed=JSON.parse((read.result ?? '')) as DepthEstimationResult
 assert(parsed.output.sizes.preview.width===512,'后台作业未按参数生成预览: '+JSON.stringify(parsed.output.sizes.preview))
})
await check('取消真实进程后作业状态为 killed 且没有 completed 结果',async()=>{
 const controller=new AbortController()
 const hooks=await startDepthEstimation(ctx.subprocess,config,{requestId:'ts-cancel',image:{path:image}},controller.signal)
 setTimeout(()=>hooks.cancel(),1500)
 const outcome=await hooks.done
 const detail=outcome.output
 assert(outcome.status==='killed','取消后状态应为 killed，实际 '+outcome.status+': '+detail.slice(0,200))
 assert(!detail.includes('depth.image.npy'),'取消的运行不应声明已完成产物')
})
await check('后台作业完成后 owner 收到带真实图像的通知，且相对路径按会话 cwd 解析',async()=>{
 const inbox:unknown[]=[]
 const sessionCwd='/home/s18/WS/Lyapunov/SceneGene/assets'
 const {agent,dispose}=await registerFakeOwner('sess-depth-owner',sessionCwd,inbox)
 try{
  const relativePath='refs/'+basename(image!)
  const started=await ctx.tools.execute({callId:'test-depth-owner-job' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-owner-job',image:{path:relativePath},params:{previewMaxSide:384}}),background:true},agent,signal:new AbortController().signal})
  const payload=await jsonFromToolResult(started as {content?:unknown[]})
  const jobId=String((payload.value as {jobId?:string}).jobId)
  const deadline=Date.now()+300_000
  // 轮询用 get（只读快照，不标记 reported）；settle 后原生通知与我们的投递都不会被“已读”掐掉。
  let snapshot=ctx.jobs.get(jobId as never,agent?.id)
  while(!['completed','failed','killed'].includes(String(snapshot.status))){
   assert(Date.now()<deadline,'后台作业超时未收敛: '+JSON.stringify(snapshot))
   await new Promise(resolve=>setTimeout(resolve,1000))
   snapshot=ctx.jobs.get(jobId as never,agent?.id)
  }
  assert(String(snapshot.status)==='completed','后台作业未完成: '+JSON.stringify(snapshot))
  // 原生 job 通知（tool-jobs 的“finished…Read its output with job_output”）也会进 inbox，
  // 这里找的是本插件投递的那条：source.kind 必须是本插件名。
  type Notice={role?:string;source?:{kind?:string;plugin?:string;form?:string};content?:Array<{type?:string;text?:string;attachment?:{mediaType?:string;width?:number;height?:number}}>}
  const ours=()=>inbox.find(item=>(item as Notice).source?.kind===pluginName) as Notice|undefined
  const deliveryDeadline=Date.now()+30_000
  while(!ours()&&Date.now()<deliveryDeadline)await new Promise(resolve=>setTimeout(resolve,100))
  const message=ours()
  assert(message,'后台作业完成后 owner 没有收到本插件投递的预览通知（收到的：'+JSON.stringify(inbox.map(item=>(item as Notice).source))+'）')
  assert(message.role==='user','通知消息角色不对: '+String(message.role))
  assert(message.source?.kind===pluginName&&message.source?.form==='notice','通知消息来源不对: '+JSON.stringify(message.source))
  const captionText=message.content?.find(block=>block.type==='text')?.text??''
  const attached=message.content?.find(block=>block.type==='image')?.attachment
  assert(captionText.includes(image!),'通知文本未注明来源原图: '+captionText)
  assert(captionText.includes('相对深度')&&captionText.includes('不是米制'),'通知文本未写明相对语义: '+captionText)
  assert(attached&&String(attached.mediaType).startsWith('image/'),'通知没有携带真实图像: '+JSON.stringify(attached))
  assert(attached.width===384&&attached.height===288,'通知里的预览尺寸不对: '+JSON.stringify(attached))
  const read=ctx.jobs.read(jobId as never,agent?.id)
  const parsed=JSON.parse((read.result ?? '')) as DepthEstimationResult
  assert(parsed.output.image.path===image,'相对路径未按会话 cwd 解析成真实原图: '+parsed.output.image.path)
  assert(parsed.imageDelivery?.mode==='job-notice'&&parsed.imageDelivery.attached===1,'后台交付读数不对: '+JSON.stringify(parsed.imageDelivery))
 }finally{await dispose()}
})
/**
 * 附件化阶段的取消（同步 + 后台）与 Command 路径不附件化，都用同一个夹具 worker：
 * 它只负责快速产出**结构合法**的五类产物（真实模型推理由 [3] 的用例负责），
 * 把窗口留给附件闸门——取消打在 saveImage 正在进行时。
 */
const fixtureWorker=join(scratch,'fixture-worker.py')
await writeFile(fixtureWorker,`import base64,json,os,sys
import numpy as np
request=json.loads(sys.stdin.read() or "{}")
out=request["outputDirectory"]
png=base64.b64decode(${JSON.stringify(TINY_PNG.toString('base64'))})
def save(name,data):
    path=os.path.join(out,name)
    with open(path,"wb") as handle: handle.write(data)
    return path,len(data)
# npy 由真 numpy 写出：产物本身是合法文件，本次夹具只是不加载模型。
np.save(os.path.join(out,"fx-depth.npy"),np.full((4,6),2.5,dtype=np.float32))
np.save(os.path.join(out,"fx-model.npy"),np.full((2,3),2.5,dtype=np.float32))
gray_path,gray_bytes=save("fx-gray.png",png)
color_path,color_bytes=save("fx-color.png",png)
metadata={"schema":"lyapunov.depth-estimation/1","provider":"depth-anything-v2","requestId":request["requestId"],
 "image":{"path":request["image"]["path"],"bytes":0,"width":6,"height":4,"mode":"RGB"},
 "sizes":{"input":{"width":6,"height":4},"modelInput":{"width":6,"height":4},"modelOutput":{"width":3,"height":2},"fullDepth":{"width":6,"height":4},"preview":{"width":1,"height":1}},
 "depth":{"relative":True,"metric":False,"largerMeans":"closer","scale":"fixture","dtype":"float32",
  "statistics":{"min":2.5,"max":2.5,"mean":2.5,"std":0.0,"nonFiniteCount":0,"validPixels":24,"constant":True}},
 "preprocessing":{},"model":{"modelId":"fixture"}}
metadata_path,metadata_bytes=save("fx-metadata.json",json.dumps(metadata).encode("utf8"))
print('LYAPUNOV_RESULT='+json.dumps({"artifacts":[
 {"type":"depth.image.npy","path":os.path.join(out,"fx-depth.npy"),"bytes":os.path.getsize(os.path.join(out,"fx-depth.npy"))},
 {"type":"depth.model.npy","path":os.path.join(out,"fx-model.npy"),"bytes":os.path.getsize(os.path.join(out,"fx-model.npy"))},
 {"type":"depth.preview.png","path":gray_path,"bytes":gray_bytes},
 {"type":"depth.preview.color.png","path":color_path,"bytes":color_bytes},
 {"type":"depth.metadata.json","path":metadata_path,"bytes":metadata_bytes}],"metadata":metadata}),flush=True)
`)
/**
 * 夹具用例专用：把 worker 换成上面的假 worker（走本包**文档化**的环境变量回落
 * `LYAPUNOV_DEPTH_ESTIMATION_WORKER`，不改主装配配置）。真实模型推理仍由 [3] 的用例负责。
 */
async function withFixtureWorker<T>(body:()=>Promise<T>):Promise<T>{
 const previous=process.env.LYAPUNOV_DEPTH_ESTIMATION_WORKER
 process.env.LYAPUNOV_DEPTH_ESTIMATION_WORKER=fixtureWorker
 try{return await body()}finally{
  if(previous===undefined)delete process.env.LYAPUNOV_DEPTH_ESTIMATION_WORKER
  else process.env.LYAPUNOV_DEPTH_ESTIMATION_WORKER=previous
 }
}
/** 等闸门进入或超时；超时返回 false（由调用方断言）。 */
async function waitForHold(hold:{entered:Promise<void>},timeoutMs:number){
 return Promise.race([hold.entered.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),timeoutMs))])
}
const FIXTURE_WAIT_MS=120_000

await check('同步路径在附件化期间被取消：不返回结果、不投图、不报 completed',async()=>{
 await withFixtureWorker(async()=>{
  const hold=holdNextSaveImage()
  const controller=new AbortController()
  const call=ctx.tools.execute({callId:'test-depth-abort-attach' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-abort-attach',image:{path:image}})},signal:controller.signal})
  // 等到真的进了附件化（saveImage 已被调用、正被闸门挡住）再取消——确定性的窗口，不是计时赌博。
  assert(await waitForHold(hold,FIXTURE_WAIT_MS),'同步路径没有走到附件化（等闸门超时）')
  controller.abort()
  hold.release()
  const called=await call as {content?:unknown[];isError?:boolean}
  const text=(called.content??[]).map(block=>String((block as {text?:string}).text??'')).join('\n')
  assert(called.isError===true,'附件化期间取消应判失败，实际拿到结果: '+text.slice(0,200))
  assert(text.includes('CANCELLED'),'取消没有落在附件化阶段: '+text.slice(0,300))
  assert(!(called.content??[]).some(block=>(block as {type?:string}).type==='image'),'被取消的调用不该带图像')
 })
})
await check('后台作业在附件化期间被取消：作业 killed、owner 不收到图',async()=>{
 const inbox:unknown[]=[]
 const {agent,dispose}=await registerFakeOwner('sess-depth-abort-job','/home/s18/WS/Lyapunov/SceneGene/assets',inbox)
 try{
  await withFixtureWorker(async()=>{
   const started=await ctx.tools.execute({callId:'test-depth-abort-job' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-abort-job',image:{path:image}}),background:true},agent,signal:new AbortController().signal})
   const payload=await jsonFromToolResult(started as {content?:unknown[]})
   const jobId=String((payload.value as {jobId?:string}).jobId)
   const hold=holdNextSaveImage()
   // 作业自己会跑起来；等它进入附件化，再 job_kill，再放行。
   assert(await waitForHold(hold,FIXTURE_WAIT_MS),'后台路径没有走到附件化（等闸门超时）')
   assert(ctx.jobs.kill(jobId as never,agent?.id)==='requested','job_kill 未被受理: '+jobId)
   hold.release()
   const deadline=Date.now()+60_000
   let snapshot=ctx.jobs.get(jobId as never,agent?.id)
   while(!['completed','failed','killed'].includes(String(snapshot.status))){
    assert(Date.now()<deadline,'被取消的作业没有收敛: '+JSON.stringify(snapshot))
    await new Promise(resolve=>setTimeout(resolve,50))
    snapshot=ctx.jobs.get(jobId as never,agent?.id)
   }
   assert(String(snapshot.status)==='killed','附件化期间取消应判 killed，实际 '+String(snapshot.status))
   const read=ctx.jobs.read(jobId as never,agent?.id)
   assert((read.result ?? '').includes('CANCELLED'),'取消没有落在附件化阶段: '+(read.result ?? '').slice(0,300))
   assert(!inbox.some(item=>(item as {source?:{kind?:string}}).source?.kind===pluginName),'被取消的作业不该向 owner 投图（收到 '+inbox.length+' 条）')
  })
 }finally{await dispose()}
})
await check('附件化失败时如实报交付状态：不吞异常、不假装有图，产物照常交付',async()=>{
 await withFixtureWorker(async()=>{
  failNextSaveImage('存储不可用（测试注入）')
  const called=await ctx.tools.execute({callId:'test-depth-attach-fail' as never,name:'depth_estimate',arguments:{request_json:JSON.stringify({requestId:'ts-attach-fail',image:{path:image}})},signal:new AbortController().signal})
  const payload=await jsonFromToolResult(called as {content?:unknown[]})
  const value=payload.value as unknown as DepthEstimationResult
  assert(payload.blocks.length===1&&(payload.blocks[0] as {type?:string}).type==='text','附件化失败不该出现图像块: '+JSON.stringify(payload.blocks.map(block=>(block as {type?:string}).type)))
  assert(value.imageDelivery?.mode==='none'&&value.imageDelivery.attached===0,'交付读数应为 none/0: '+JSON.stringify(value.imageDelivery))
  assert(String(value.imageDelivery?.error).includes('存储不可用'),'交付状态没有写明原因: '+String(value.imageDelivery?.error))
  assert(value.output.artifacts.length===5,'附件化失败不影响产物与读数交付: '+value.output.artifacts.length)
 })
})
await check('Command 路径不附件化：结果明说未入上下文，且完全不调用 saveImage',async()=>{
 const inbox:unknown[]=[]
 const {agent,dispose}=await registerFakeOwner('sess-depth-command','/home/s18/WS/Lyapunov/SceneGene/assets',inbox)
 try{
  await withFixtureWorker(async()=>{
   const handler=ctx.commands.find(agent,'depth_estimate')?.handler
   assert(handler,'/depth_estimate 未注册')
   const before=saveImageCalls
   const hold=holdNextSaveImage()
   const result=await Promise.race([
    Promise.resolve(handler!({commandId:'cmd-test',agent,rawInput:JSON.stringify({request_json:JSON.stringify({requestId:'ts-command',image:{path:image}})}),attachments:[],signal:new AbortController().signal} as never)),
    new Promise<'timeout'>(resolve=>setTimeout(()=>resolve('timeout'),FIXTURE_WAIT_MS)),
   ])
   hold.release()
   assert(result!=='timeout','Command 路径卡在附件化上（说明它其实在附件化）')
   assert(result.kind==='success','Command 失败: '+JSON.stringify(result).slice(0,300))
   const value=JSON.parse(result.text??'{}') as DepthEstimationResult
   assert(value.imageDelivery?.mode==='none'&&value.imageDelivery.attached===0,'Command 交付读数应为 none/0: '+JSON.stringify(value.imageDelivery))
   assert(String(value.imageDelivery?.error).includes('不附件化'),'Command 未写明图没有进入上下文: '+String(value.imageDelivery?.error))
   assert(saveImageCalls===before,'Command 路径不该调用附件存储（会留下不消费的缓存）')
  })
 }finally{await dispose()}
})

await writeFile(join(scratch,'test-summary.json'),JSON.stringify({passed,failures,scratch},null,2))
console.log('\n通过 '+passed+' 项，失败 '+failures.length+' 项')
if(failures.length){for(const failure of failures)console.log(' - '+failure);process.exit(1)}
console.log('全部真实用例通过（模型 '+modelDirectory+' revision '+EXPECTED_REVISION+'）')
process.exit(0)
