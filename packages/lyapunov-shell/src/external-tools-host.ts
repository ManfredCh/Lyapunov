/** 外部工具设置的薄层：读原生 MCP/Tools，写原生 profile；不另建连接或作业注册表。 */
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import {SessionId} from '@deepseek-ai/dsh-session'
import {JobId,type JobOutcome} from '@deepseek-ai/dsh-jobs'
import {writableRoots} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ScopeKey} from '@deepseek-ai/dsh-scope'
import {readProfilePatches,reconcileProfilePatches,composeEntries,loadProfileDirectory} from '@deepseek-ai/dsh-app-boot'
import type {PatchOptions} from '@deepseek-ai/cordis-plugin-include'
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import {Config as NativeMcpConfig,connectionHandleOf} from '@deepseek-ai/dsh-mcp-client'
import Schema from '@deepseek-ai/schemastery'
import {parseDocument,isSeq} from 'yaml'
import {readFile,stat} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {join,resolve,basename,isAbsolute} from 'node:path'
import {execFile} from 'node:child_process'
import {blenderMcpPaths,blenderMcpStatus,ensureBlenderMcp} from '../../../script/blender-mcp.ts'
import {resolveBlenderExecutable} from '../../../script/runtime-patch.ts'
import {CREATIVE_TOOLS_CATALOG,downloadPlan,HF_DEFAULT_MIRROR,type CreativeToolId} from '../../../script/creative-tools-catalog.ts'
import {visibleServers} from '../../lyapunov-mcp-extras/src/plugin.ts'
import {redactSecretsText} from '../../lyapunov-contracts/src/command-privacy.ts'
import {canonicalTargetPath,pathWithin,isForeignSessionTarget} from '../../lyapunov-contracts/src/writable-boundary.ts'
import type {ExternalToolsState,ExternalMcpInput,ExternalMcpRow,ExternalToolReading} from './external-tools-state.ts'

declare module '@deepseek-ai/dsh-jobs' {interface JobKindMap {'external-install':'external-install'}}
const MCP_PLUGIN='@deepseek-ai/dsh-mcp-client'
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const publicUrl=(v:unknown):string|null=>{try{const u=new URL(String(v));return u.origin+u.pathname}catch{return null}}
const errorText=(e:unknown)=>redactSecretsText(e instanceof Error?e.message:String(e)).slice(0,1200)

/** 文件写入只消费原生有效策略与共用的规范路径边界，未知策略失败关闭。 */
export function requireExternalWrite(ctx:Context,agent:Agent|undefined,target:string):void{
 const service=ctx.get('sandboxPolicy');if(!service)throw Error('EXTERNAL_POLICY_UNAVAILABLE: 缺少原生文件执行策略，下载未启动。 / Native file policy is unavailable.')
 const policy=service.resolve(agent?{session:agent.session}:{})
 if(!['read-only','workspace-write','danger-full-access'].includes(policy.mode)||policy.mode==='read-only')throw Error('EXTERNAL_POLICY_READ_ONLY: 当前原生策略禁止下载落盘，请选择可写模式。 / Select a writable native file policy.')
 const canonical=canonicalTargetPath(target)
 if(isForeignSessionTarget(canonical,policy.workspaceRoot,agent?.id))throw Error('EXTERNAL_POLICY_CROSS_SESSION: 不可写入其他会话的私有目录。 / Another session owns this directory.')
 if(policy.mode!=='danger-full-access'&&!writableRoots(policy).some(root=>pathWithin(root,canonical)))throw Error('EXTERNAL_POLICY_OUTSIDE_WRITABLE: 下载目录不在原生可写范围内。 / The target is outside native writable roots.')
}

/** 输入只处理非秘密连接字段；既有 env/headers/token 由原生配置持有，局部更新不会抹掉它们。 */
export function externalMcpConfig(input:ExternalMcpInput,root:string):Record<string,unknown>{
 if(typeof input.serverName!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(input.serverName))throw Error('MCP_NAME_INVALID: 服务名需为 1–32 位字母、数字、下划线或连字符。 / Use a 1–32 character server namespace.')
 if(input.transport!=='stdio'&&input.transport!=='streamable-http'&&input.transport!=='sse')throw Error('MCP_TRANSPORT_INVALID: 请选择 stdio、streamable-http 或 sse。 / Select a supported transport.')
 const base={serverName:input.serverName,transport:input.transport,failOnStartupError:false,toolCallTimeoutMs:180000}
 let config:Record<string,unknown>
 if(input.transport==='stdio'){
  if(typeof input.command!=='string'||!input.command.trim()||/[\r\n\0]/.test(input.command))throw Error('MCP_COMMAND_REQUIRED: 请填写可执行文件；参数单独填写。 / Supply the executable separately from arguments.')
  if(input.args!==undefined&&(!Array.isArray(input.args)||input.args.some(v=>typeof v!=='string'||v.includes('\0'))))throw Error('MCP_ARGS_INVALID: 参数必须是 JSON 字符串数组。 / Arguments must be a JSON string array.')
  config={...base,command:input.command.trim(),...input.args===undefined?{}:{args:input.args},cwd:input.cwd?resolve(root,input.cwd):root}
  if(input.blenderPort!==undefined){
   if(input.serverName!=='blender'||!Number.isInteger(input.blenderPort)||input.blenderPort<1||input.blenderPort>65535)throw Error('BLENDER_PORT_INVALID: Blender addon 端口应为 1–65535。 / Supply a valid Blender addon port.')
   config.env={BLENDER_HOST:'127.0.0.1',BLENDER_PORT:String(input.blenderPort),DISABLE_TELEMETRY:'1'}
  }
 }else{
  let u:URL;try{u=new URL(input.url??'')}catch{throw Error('MCP_URL_REQUIRED: 请填写 MCP HTTP 地址。 / Supply the MCP HTTP endpoint.')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('MCP_URL_INVALID: 此表单只接受不含凭据或查询参数的 HTTP 地址；秘密请用原生配置文档。 / Use the native document for credentials.')
  config={...base,url:u.href}
 }
 Schema.resolve(config,NativeMcpConfig,{})
 return config
}

/** 新实例仍是同一个上游 mcp-client；使用官方 profile 原语原子追加、重载和失败回退。 */
export async function saveExternalMcp(ctx:Context,input:ExternalMcpInput):Promise<void>{
 const editor=ctx.get('configEditor'),settings=ctx.get('settings'),profile=ctx.get('profileContext')
 if(!editor||!settings||!profile||!settings.writable)throw Error('MCP_CONFIG_READ_ONLY: 当前 Host 不允许写原生配置。 / The native profile is read-only.')
 const matches=editor.entries().filter(row=>row.options.name===MCP_PLUGIN&&object(row.options.config).serverName===input.serverName)
 if(matches.length>1)throw Error('MCP_NAMESPACE_AMBIGUOUS: 有多个同名配置，请在原生文档中处理。 / Resolve duplicate entries in the native document.')
 const entry=matches[0]
 if(entry){
  const view=settings.describe({redactSecrets:true}).find(v=>v.ns===entry.options.id)
  if(!view||input.expectedRevision!==view.revision)throw Error('MCP_CONFIG_CONFLICT: 配置已变化，请先刷新。 / Refresh before saving changed configuration.')
  const current=object(entry.options.config)
  const next=externalMcpConfig({...input,command:input.command??current.command as string|undefined,url:input.url??publicUrl(current.url)??undefined},profile.cwd)
  // 表单没有编辑的字段不写回；保留继承值、用户参数、端点中的秘密与原有超时设置。
  for(const key of ['command','args','cwd','url'] as const)if(input[key]===undefined)delete next[key]
  delete next.failOnStartupError;delete next.toolCallTimeoutMs
  if(current.transport!==input.transport)throw Error('MCP_TRANSPORT_CHANGE: 更换 transport 请在原生配置文档中操作，避免丢失既有秘密字段。 / Change transport in the native document.')
  const ops=Object.entries(next).flatMap(([key,value])=>key==='env'?Object.entries(object(value)).map(([name,v])=>({op:'set' as const,path:['env',name],value:v})):[{op:'set' as const,path:[key],value}])
  await settings.mutate(view.ns,ops,view.revision)
  return
 }
 const next=externalMcpConfig(input,profile.cwd)
 if(input.expectedRevision!==undefined&&input.expectedRevision!==null)throw Error('MCP_CONFIG_CONFLICT: 此服务已不存在，请刷新。 / Refresh the server list.')
 const id='lyapunov-external-mcp-'+input.serverName
 const run=async()=>withFileLock(join(profile.dir,'package.json'),async()=>{
  const beforePatches=readProfilePatches('dsh',profile)
  const flatten=(rows:ReturnType<typeof composeEntries>):ReturnType<typeof composeEntries>=>rows.flatMap(row=>[row,...row.group&&Array.isArray(row.config)?flatten(row.config as ReturnType<typeof composeEntries>):[]])
  if(flatten(composeEntries([beforePatches])).some(row=>row.id===id||row.name===MCP_PLUGIN&&object(row.config).serverName===input.serverName))throw Error('MCP_CONFIG_CONFLICT: 此服务刚被配置，请刷新。 / Refresh the server list.')
  let before:string;try{before=await readFile(profile.patchPath,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;before='[]\n'}
  const doc=parseDocument(before,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(v:string)=>v}]})
  if(doc.errors[0])throw doc.errors[0]
  if(!isSeq(doc.contents))throw Error('MCP_PROFILE_INVALID: 原生 profile patch 必须为 YAML 列表。 / The native patch must be a YAML sequence.')
  const insertion:PatchOptions={insert:[{id,name:MCP_PLUGIN,config:next}]}
  doc.add(doc.createNode(insertion))
  const loaded=loadProfileDirectory('dsh',profile.dir,profile.installAnchor)
  // 既有!!js表达式由原生加载器解析；本薄层只追加JSON形状的新行，不另实现YAML方言。
  const patches=readProfilePatches('dsh',profile,{...loaded,patches:[...loaded.patches,insertion]})
  const effective=flatten(composeEntries([patches])).find(row=>row.id===id)
  if(!effective||effective.disabled||object(effective.config).serverName!==input.serverName)throw Error('MCP_CONFIG_SHADOWED: 配置被上层覆盖；请用原生文档处理。 / A higher profile layer shadows this entry.')
  await writeFileAtomic(profile.patchPath,String(doc),{mode:0o600})
  try{await reconcileProfilePatches(ctx.root,patches,'dsh',[id])}
  catch(e){await writeFileAtomic(profile.patchPath,before,{mode:0o600});await reconcileProfilePatches(ctx.root,beforePatches,'dsh');throw e}
 })
 const hmr=ctx.get('hmr');await (hmr?hmr.runExclusive(run):run())
}

async function version(command:string,args:string[]):Promise<string|null>{
 return await new Promise(resolveVersion=>execFile(command,args,{timeout:6000,maxBuffer:65536},(error,stdout)=>resolveVersion(error?null:stdout.trim().split('\n')[0]??null)))
}
/** 只查看已经指定的模型路径，不扫描客户目录、不下载、不调用模型。 */
export async function externalToolsState(ctx:Context,sessionId?:string,signal:AbortSignal=new AbortController().signal):Promise<ExternalToolsState>{
 const agent=sessionId?ctx.get('agents')?.get(SessionId(sessionId)):undefined
 if(sessionId&&!agent)throw Error('SESSION_NOT_LIVE: 只读取已经打开的会话。 / Only an already-open session can be inspected.')
 const target=agent?.ctx??ctx,tools=ctx.tools.schemas(agent as unknown as ScopeKey|undefined).map(v=>v.name)
 const servers=await visibleServers(target,signal)
 const settings=ctx.get('settings'),views=settings?.describe({redactSecrets:true})??[],entries=ctx.get('configEditor')?.entries()??[]
 const mcp:ExternalMcpRow[]=await Promise.all(entries.filter(e=>e.options.name===MCP_PLUGIN).map(async e=>{
  const c=object(e.options.config),serverName=String(c.serverName??''),live=servers.find(v=>v.serverName===serverName)
  const connection=e.fiber?connectionHandleOf(e.fiber.ctx):undefined
  // ready是原生首次启动结果，读它不会重试或创建另一连接；与当前掉线状态明确区分。
  const initial=live?.status!=='connected'&&connection?await Promise.race([connection.ready,new Promise<undefined>(r=>{const timer=setTimeout(()=>r(undefined),100);timer.unref?.()})]):undefined
  const detail=live?.status==='connected'?null:initial?.error!==undefined?'首次启动失败 / Initial startup failed: '+errorText(initial.error):live?'当前连接不可用；原生客户端管理重连。 / Connection unavailable; inspect native reconnection diagnostics.':'该配置尚无活动连接实例。 / No active native connection instance.'
  return {id:e.options.id,serverName,transport:String(c.transport??''),command:typeof c.command==='string'?basename(c.command):null,url:publicUrl(c.url),argsCount:Array.isArray(c.args)?c.args.length:0,envNames:Object.keys(object(c.env)),headerNames:Object.keys(object(c.headers)),status:live?.status==='connected'?'connected' as const:live?'unavailable' as const:'configured' as const,tools:tools.filter(t=>t.startsWith('mcp__'+serverName+'__')),revision:views.find(v=>v.ns===e.options.id)?.revision??null,detail}
 }))
 for(const live of servers)if(!mcp.some(v=>v.serverName===live.serverName))mcp.push({id:'',serverName:live.serverName,transport:'scope-owned',command:null,url:null,argsCount:0,envNames:[],headerNames:[],status:live.status==='connected'?'connected':'unavailable',tools:tools.filter(t=>t.startsWith('mcp__'+live.serverName+'__')),revision:null,detail:null})
 const blender=await version(resolveBlenderExecutable(),['--version']),unity=process.env.LYAPUNOV_UNITY_EXECUTABLE?.trim()
 const unityVersion=unity?await version(unity,['-version']):null
 const samEntry=entries.find(e=>String(e.options.name).includes('segment-sam3')),sam=object(samEntry?.options.config)
 const samPath=typeof sam.checkpointPath==='string'?sam.checkpointPath:process.env.LYAPUNOV_SAM3_CHECKPOINT
 const samPython=typeof sam.pythonPath==='string'?sam.pythonPath:process.env.LYAPUNOV_SAM3_PYTHON
 const software:ExternalToolReading[]=[
  {id:'blender',installed:blender!==null,version:blender??undefined,detail:blender?'软件版本检查通过；addon 与 MCP 连接需另行检查。 / Software checked; addon and MCP are separate.':'未找到可用 Blender 命令。 / No usable Blender executable.',adapter:'blender_run'},
  {id:'unity',installed:unityVersion?true:null,version:unityVersion??undefined,detail:unityVersion?'编辑器版本检查通过，MCP 连接另行检查。 / Editor checked; inspect MCP separately.':'未指定编辑器命令；可连接已运行的 Unity MCP，或从 Unity Hub 选择编辑器。 / No editor command supplied; existing MCP may still be connected.',adapter:'MCP'},
  {id:'sam3',installed:!!samPath&&existsSync(samPath)&&!!samPython&&existsSync(samPython),location:samPath,detail:'本地 checkpoint 与 Python 仅检查文件存在；推理、授权与模型兼容性尚需实际调用验证。 / File checks only; inference remains unverified.',adapter:'segment_sam3'},
  {id:'sam3d',installed:null,detail:'可下载目录锁定权重；当前没有 SAM 3D Objects 运行适配器。 / Downloadable; no runtime adapter.',adapter:'none'},
  {id:'da3',installed:null,detail:'可下载 DA3 BASE；当前 depth-estimation 使用 DA-V2，不会因下载而切换模型。 / DA3 acquisition does not replace DA-V2.',adapter:'DA-V2'},
 ]
 const supply=blenderMcpStatus(),paths=blenderMcpPaths()
 const existingCommand=await ctx.get('subprocess')?.resolveExecutable('mcp-for-blender').catch(()=>null)??null
 const installJobs=ctx.get('jobs')?.list(agent?.id).filter(j=>j.kind==='external-install'||j.kind==='fastgs-external').map(j=>({jobId:String(j.id),registryId:j.registryId??null,status:j.status,label:j.label,progress:j.progress??null,detail:j.detail??null}))??[]
 return {capturedAt:Date.now(),writable:!!settings?.writable,software,mcp,blenderSupply:{ready:supply.ready,command:paths.command,existingCommand,addon:paths.addon,detail:supply.detail},installJobs}
}

/** 安装仅在显式点击后起原生 Jobs；目录、版本与HF端点来自现有 owner。 */
export async function startExternalAcquisition(ctx:Context,input:{id:string;localDir?:string;sessionId?:string}):Promise<string>{
 const agent=input.sessionId?ctx.get('agents')?.get(SessionId(input.sessionId)):undefined
 if(input.sessionId&&!agent)throw Error('SESSION_NOT_LIVE: 请先打开会话。 / Open the session first.')
 const jobs=ctx.get('jobs');if(!jobs)throw Error('JOBS_UNAVAILABLE: 原生后台作业未装配。 / Native jobs are unavailable.')
 if(input.id==='blender-mcp'){
  requireExternalWrite(ctx,agent,blenderMcpPaths().root)
  return jobs.start({kind:'external-install',label:'Blender MCP locked supply',owner:agent?.id,run:job=>{
   const controller=new AbortController()
   const done=ensureBlenderMcp({signal:controller.signal,log:line=>job.append(redactSecretsText(line)+'\n',{channel:'stdout'})}).then(v=>({status:'completed' as const,result:JSON.stringify(v),detail:'Supply checked; editor addon activation and MCP handshake remain separate.'}),e=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:errorText(e),detail:controller.signal.aborted?'Owned supply cancelled; existing installation and editor were retained.':'Locked supply failed.'}))
   return {cancel:()=>controller.abort(),done}
  }})
 }
 const entry=CREATIVE_TOOLS_CATALOG.find(v=>v.id===input.id)
 if(!entry?.model)throw Error('EXTERNAL_ACQUISITION_UNSUPPORTED: 此项请使用已有官方安装入口。 / Use the existing official installer.')
 if(!input.localDir||!isAbsolute(input.localDir))throw Error('MODEL_DIRECTORY_REQUIRED: 请填写绝对下载目录。 / Supply an absolute download directory.')
 requireExternalWrite(ctx,agent,input.localDir)
 const plan=downloadPlan(input.id as CreativeToolId,{endpoint:HF_DEFAULT_MIRROR,localDir:input.localDir})
 const subprocess=ctx.get('subprocess');if(!subprocess)throw Error('SUBPROCESS_UNAVAILABLE')
 const hf=await subprocess.resolveExecutable('hf').catch(()=>null);if(!hf)throw Error('HF_CLI_MISSING: 未安装 hf CLI；请先准备隔离下载环境。 / Prepare an isolated hf CLI environment.')
 return jobs.start({kind:'external-install',label:entry.name+' pinned download',owner:agent?.id,run:job=>{
  const controller=new AbortController()
  const child=subprocess.spawn({argv:[hf,...plan.argv.slice(1)],cwd:ctx.profileContext?.cwd??process.cwd(),env:{...plan.env,HF_HUB_DISABLE_XET:'1',HF_HUB_CACHE:join(input.localDir!,'.hf-cache'),HF_XET_CACHE:join(input.localDir!,'.hf-xet')},signal:controller.signal,graceMs:3000,stdio:{stdin:'ignore',stdout:{maxBytes:120000},stderr:{maxBytes:120000}}})
  const offsets={stdout:0,stderr:0},pump=()=>{for(const channel of ['stdout','stderr'] as const){const read=child.collected[channel]?.readFrom(offsets[channel]);if(read){offsets[channel]=read.nextOffset;job.append(redactSecretsText(read.text),{channel,...read.lossy?{gapBefore:true as const}:{}})}}}
  const timer=setInterval(pump,250)
  const done=(async():Promise<JobOutcome>=>{
   try{const result=await child.done;pump();if(controller.signal.aborted)return {status:'killed',detail:'Download cancelled; partial files retained.'};if(result.exitCode!==0)return {status:'failed',detail:`HF mirror download blocked: ${entry.model!.modelId}@${entry.model!.revision}; exit=${String(result.exitCode)}. No official-endpoint fallback.`}
    for(const file of entry.model!.files){const item=await stat(join(input.localDir!,file));if(!item.isFile()||item.size===0)throw Error('MODEL_FILE_MISSING: '+file)}
    return {status:'completed',detail:'Pinned files acquired through the HF mirror; runtime inference remains unverified.'}
   }catch(e){return {status:controller.signal.aborted?'killed':'failed',detail:errorText(e)}}finally{clearInterval(timer)}
  })()
  return {cancel:()=>controller.abort(),done}
 }})
}

export function applyExternalToolsHost(ctx:Context):void{
 const register=(path:string,methods:readonly ('GET'|'POST')[],handler:(r:Request)=>Promise<Response>)=>ctx.effect(()=>ctx.connection.fetch.register({path:'/api/lyapunov/external-tools/'+path,methods,requestBody:'buffered',fetch:async r=>{try{return await handler(r)}catch(e){return Response.json({error:errorText(e)},{status:400})}}}))
 register('state',['GET'],async r=>Response.json(await externalToolsState(ctx,new URL(r.url).searchParams.get('sessionId')??undefined,r.signal),{headers:{'cache-control':'private, no-store'}}))
 register('mcp',['POST'],async r=>{await saveExternalMcp(ctx,await r.json() as ExternalMcpInput);return Response.json({saved:true,handshake:'Read the native server state and tool list separately.'})})
 register('acquire',['POST'],async r=>Response.json({jobId:await startExternalAcquisition(ctx,await r.json() as {id:string;localDir?:string;sessionId?:string})}))
 register('job',['GET'],async r=>{
  const q=new URL(r.url).searchParams,agent=q.get('sessionId')?ctx.agents.get(SessionId(q.get('sessionId')!)):undefined
  if(q.get('sessionId')&&!agent)throw Error('SESSION_NOT_LIVE')
  const id=JobId(q.get('jobId')??''),view=ctx.jobs.get(id,agent?.id)
  if(view.kind!=='external-install'&&view.kind!=='fastgs-external')throw Error('EXTERNAL_JOB_KIND_REQUIRED')
  const read=ctx.jobs.readAt(id,Math.max(0,Number(q.get('offset')??0)||0),agent?.id)
  return Response.json({job:view,output:read.chunks.map(c=>({channel:c.channel,text:redactSecretsText(c.text)})),nextOffset:read.next},{headers:{'cache-control':'private, no-store'}})
 })
}
