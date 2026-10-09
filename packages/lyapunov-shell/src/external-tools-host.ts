/** 外部工具设置的薄层：读原生 MCP/Tools，写原生 profile；不另建连接或作业注册表。 */
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import {pluginEntryId} from '@deepseek-ai/dsh-host-plugin-inventory'
import {SessionId} from '@deepseek-ai/dsh-session'
import {JobId,type JobOutcome} from '@deepseek-ai/dsh-jobs'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {writableRoots} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {scopeOf,scopeChainOf,scopeTarget,type ScopeKey} from '@deepseek-ai/dsh-scope'
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
import {createHash} from 'node:crypto'
import {ensureUnityMcp,unityMcpSupplyPaths} from '../../../script/unity-mcp-supply.ts'
import {blenderMcpPaths,blenderMcpStatus,ensureBlenderMcp} from '../../../script/blender-mcp.ts'
import {resolveBlenderExecutable} from '../../../script/runtime-patch.ts'
import {CREATIVE_TOOLS_CATALOG,downloadPlan,HF_DEFAULT_MIRROR,type CreativeToolId} from '../../../script/creative-tools-catalog.ts'

import {redactSecretsText} from '../../lyapunov-contracts/src/command-privacy.ts'
import {canonicalTargetPath,pathWithin,isForeignSessionTarget} from '../../lyapunov-contracts/src/writable-boundary.ts'
import type {ExternalToolsState,ExternalMcpInput,ExternalMcpRow,ExternalToolReading} from './external-tools-state.ts'
import {integrationAssociations,classifyMcpIntegration,type ExternalSkillRow} from './plugin-marketplace.ts'
import {discoverIntegrations} from './integration-discovery.ts'

declare module '@deepseek-ai/dsh-jobs' {interface JobKindMap {'external-install':'external-install'}}
const MCP_PLUGIN='@deepseek-ai/dsh-mcp-client'
/** 静态 MCP 配置的语义版本；绑定原生profile/id，不取缺失的volatile表单，也不输出秘密值。 */
export function externalMcpRevision(profilePath:string,id:string,config:unknown):number{
 const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,stable(value)])):v
 return createHash('sha256').update(JSON.stringify([profilePath,id,stable(config)])).digest().readUIntBE(0,6)
}
const hasMcpExpression=(v:unknown):boolean=>Array.isArray(v)?v.some(hasMcpExpression):v!==null&&typeof v==='object'?Object.hasOwn(v,'__jsExpr')||Object.values(v).some(hasMcpExpression):typeof v==='function'||typeof v==='symbol'
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
 if((input.unityStatusDirectory!==undefined||input.unityDisableUpdateCheck!==undefined)&&(input.serverName!=='unity'||input.transport!=='stdio'))throw Error('UNITY_MCP_STDIO_REQUIRED: Unity 本地发现设置仅用于 stdio 服务。 / Unity discovery settings require its stdio server.')
 let config:Record<string,unknown>
 if(input.transport==='stdio'){
  if(typeof input.command!=='string'||!input.command.trim()||/[\r\n\0]/.test(input.command))throw Error('MCP_COMMAND_REQUIRED: 请填写可执行文件；参数单独填写。 / Supply the executable separately from arguments.')
  if(input.args!==undefined&&(!Array.isArray(input.args)||input.args.some(v=>typeof v!=='string'||v.includes('\0'))))throw Error('MCP_ARGS_INVALID: 参数必须是 JSON 字符串数组。 / Arguments must be a JSON string array.')
  config={...base,command:input.command.trim(),...input.args===undefined?{}:{args:input.args},cwd:input.cwd?resolve(root,input.cwd):root}
  if(input.blenderPort!==undefined){
   if(input.serverName!=='blender'||!Number.isInteger(input.blenderPort)||input.blenderPort<1||input.blenderPort>65535)throw Error('BLENDER_PORT_INVALID: Blender addon 端口应为 1–65535。 / Supply a valid Blender addon port.')
   config.env={BLENDER_HOST:'127.0.0.1',BLENDER_PORT:String(input.blenderPort),DISABLE_TELEMETRY:'1'}
  }
  if(input.unityStatusDirectory!==undefined||input.unityDisableUpdateCheck!==undefined){
   if(input.unityStatusDirectory!==undefined&&(!isAbsolute(input.unityStatusDirectory)||/[\r\n\0]/.test(input.unityStatusDirectory)))throw Error('UNITY_MCP_STATUS_DIRECTORY_REQUIRED: 请填写 Unity addon 登记目录的绝对路径。 / Supply the absolute Unity addon registry directory.')
   if(input.unityDisableUpdateCheck!==undefined&&typeof input.unityDisableUpdateCheck!=='boolean')throw Error('UNITY_MCP_UPDATE_CHECK_INVALID: 更新检查设置需为布尔值。 / Update check setting must be boolean.')
   config.env={...input.unityStatusDirectory===undefined?{}:{UNITY_MCP_STATUS_DIR:input.unityStatusDirectory},...input.unityDisableUpdateCheck===undefined?{}:{FASTMCP_CHECK_FOR_UPDATES:input.unityDisableUpdateCheck?'off':'stable'}}
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
export async function saveExternalMcp(ctx:Context,input:ExternalMcpInput,ownedEnv?:Record<string,string>):Promise<void>{
 const editor=ctx.get('configEditor'),settings=ctx.get('settings'),profile=ctx.get('profileContext')
 if(!editor||!settings||!profile||!settings.writable)throw Error('MCP_CONFIG_READ_ONLY: 当前 Host 不允许写原生配置。 / The native profile is read-only.')
 const matches=editor.entries().filter(row=>row.options.name===MCP_PLUGIN&&object(row.options.config).serverName===input.serverName)
 if(matches.length>1)throw Error('MCP_NAMESPACE_AMBIGUOUS: 有多个同名配置，请在原生文档中处理。 / Resolve duplicate entries in the native document.')
 const entry=matches[0]
 if(entry){
  const conflict=()=>Error('MCP_CONFIG_CONFLICT: 配置已变化，请先刷新。 / Refresh before saving changed configuration.')
  if(!profile.patchPath||typeof editor.edit!=='function')throw Error('MCP_CONFIG_READ_ONLY: 缺少原生静态配置事务。 / Native static configuration editing is unavailable.')
  const revision=(config:unknown)=>externalMcpRevision(profile.patchPath,entry.options.id,config)
  if(input.expectedRevision!==revision(entry.options.config))throw conflict()
  const plain=(config:unknown)=>{if(hasMcpExpression(config))throw Error('MCP_COMPLEX_CONFIG_EDIT_NATIVE: 当前配置含原生表达式，请在原生配置文档中编辑。 / Edit native expressions in the native configuration document.')}
  plain(entry.options.config)
  const current=object(entry.options.config)
  const next=externalMcpConfig({...input,command:input.command??current.command as string|undefined,url:input.url??publicUrl(current.url)??undefined},profile.cwd)
  // 表单没有编辑的字段不写回；保留继承值、用户参数、端点中的秘密与原有超时设置。
  for(const key of ['command','args','cwd','url'] as const)if(input[key]===undefined)delete next[key]
  delete next.failOnStartupError;delete next.toolCallTimeoutMs
  if(current.transport!==input.transport)throw Error('MCP_TRANSPORT_CHANGE: 更换 transport 请在原生配置文档中操作，避免丢失既有秘密字段。 / Change transport in the native document.')
  // command/args/env 是上游静态 Config：原生 ConfigEditor 在自己的文件锁中校验、落盘、重载并回退。
  await editor.edit(entry,(raw,inherited)=>{
   if(input.expectedRevision!==revision(raw))throw conflict()
   plain(raw);plain(inherited)
   return {...raw,...next,...next.env===undefined?{}:{env:{...object(raw.env),...object(next.env)}}}
  })
  return
 }
 const next=externalMcpConfig(input,profile.cwd)
 if(ownedEnv)next.env={...object(next.env),...ownedEnv}
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
/** 防止任意可执行文件的 --version 成功被当作指定软件。 */
async function softwareVersion(command:string,id:'blender'|'unity'):Promise<string|null>{
 const result=await version(command,id==='blender'?['--version']:['-version'])
 return result&&(id==='blender'?/^Blender\s/i.test(result):/^(?:Unity\b|\d{4}\.\d)/i.test(result))?result:null
}
/** 只查看已经指定的模型路径，不扫描客户目录、不下载、不调用模型。 */
export async function externalToolsState(ctx:Context,sessionId?:string,signal:AbortSignal=new AbortController().signal):Promise<ExternalToolsState>{
 const agent=sessionId?ctx.get('agents')?.get(SessionId(sessionId)):undefined
 if(sessionId&&!agent)throw Error('SESSION_NOT_LIVE: 只读取已经打开的会话。 / Only an already-open session can be inspected.')
 const target=agent?.ctx??ctx,tools=ctx.tools.schemas(agent as unknown as ScopeKey|undefined).map(v=>v.name)
 // Preserve the exact nearest native owner so a same-name child server cannot
 // make a profile-global configuration look callable in that child's scope.
 const scope=scopeOf(target),visible=new Map<string,{serverName:string;status:string;ownerScope:object|undefined}>()
 for(const ownerScope of [...scopeChainOf(scope),undefined]){
  const rows=await target.waterfall(scopeTarget({},scope),'mcp/content-request',{serverName:'',ownerScope,method:'listServers',params:{},signal},()=>Promise.resolve([])) as {serverName:string;status:string}[]
  for(const row of rows)if(!visible.has(row.serverName))visible.set(row.serverName,{...row,ownerScope})
 }
 const servers=[...visible.values()]
 const settings=ctx.get('settings'),entries=ctx.get('configEditor')?.entries()??[]
 const profile=ctx.get('profileContext'),configLocation=profile?.patchPath??null
 const configModifiedAt=configLocation?await stat(configLocation).then(v=>v.mtimeMs).catch(()=>null):null
 const nativeManaged=await ctx.get('pluginManager')?.listPlugins().catch(()=>[])??[]
 const mcp:ExternalMcpRow[]=await Promise.all(entries.filter(e=>e.options.name===MCP_PLUGIN).map(async e=>{
  const c=object(e.options.config),serverName=String(c.serverName??''),live=servers.find(v=>v.serverName===serverName&&v.ownerScope===scopeOf(e.fiber?.ctx??ctx))
  const connection=e.fiber?connectionHandleOf(e.fiber.ctx):undefined
  // ready是原生首次启动结果，读它不会重试或创建另一连接；与当前掉线状态明确区分。
  const initial=live?.status!=='connected'&&connection?await Promise.race([connection.ready,new Promise<undefined>(r=>{const timer=setTimeout(()=>r(undefined),100);timer.unref?.()})]):undefined
  const detail=live?.status==='connected'?null:initial?.error!==undefined?'首次启动失败 / Initial startup failed: '+errorText(initial.error):live?'当前连接不可用；原生客户端管理重连。 / Connection unavailable; inspect native reconnection diagnostics.':'该配置尚无活动连接实例。 / No active native connection instance.'
  const command=typeof c.command==='string'?basename(c.command):null,integration=classifyMcpIntegration({serverName,command}),managed=nativeManaged.find(v=>String(v.entryId)===e.id)
  const portValue=object(c.env).BLENDER_PORT,port=integration==='blender'&&typeof portValue==='string'&&/^\d+$/.test(portValue)&&Number(portValue)>0&&Number(portValue)<=65535?Number(portValue):null
  const unityEnv=object(c.env),unityStatusDirectory=serverName==='unity'&&c.transport==='stdio'&&typeof unityEnv.UNITY_MCP_STATUS_DIR==='string'&&isAbsolute(unityEnv.UNITY_MCP_STATUS_DIR)?redactSecretsText(unityEnv.UNITY_MCP_STATUS_DIR):undefined,unityDisableUpdateCheck=serverName==='unity'&&c.transport==='stdio'&&['off','stable','prerelease'].includes(String(unityEnv.FASTMCP_CHECK_FOR_UPDATES))?unityEnv.FASTMCP_CHECK_FOR_UPDATES==='off':undefined
  return {id:e.options.id,serverName,transport:String(c.transport??''),command,url:publicUrl(c.url),argsCount:Array.isArray(c.args)?c.args.length:0,envNames:Object.keys(object(c.env)),headerNames:Object.keys(object(c.headers)),status:live?.status==='connected'?'connected' as const:live?'unavailable' as const:'configured' as const,tools:live?tools.filter(t=>t.startsWith('mcp__'+serverName+'__')):[],revision:externalMcpRevision(profile?.patchPath??'',e.options.id,e.options.config),detail,enabled:!e.disabled,currentScope:live!==undefined,owner:'Native profile / 原生 profile',configLocation,commandLocation:typeof c.command==='string'&&isAbsolute(c.command)?redactSecretsText(c.command):null,port,...integration?{integration}:{},modifiedAt:configModifiedAt,nativeEntryId:managed?String(managed.entryId):undefined,canToggle:managed!==undefined&&managed.readOnlyReason===undefined,...unityStatusDirectory===undefined?{}:{unityStatusDirectory},...unityDisableUpdateCheck===undefined?{}:{unityDisableUpdateCheck}}
 }))
 for(const live of servers)if(!mcp.some(v=>v.serverName===live.serverName&&v.currentScope===true))mcp.push({id:'',serverName:live.serverName,transport:'scope-owned',command:null,url:null,argsCount:0,envNames:[],headerNames:[],status:live.status==='connected'?'connected':'unavailable',tools:tools.filter(t=>t.startsWith('mcp__'+live.serverName+'__')),revision:null,detail:null,enabled:true,currentScope:true,owner:'Current native scope / 当前原生作用域',configLocation:null,...classifyMcpIntegration({serverName:live.serverName,command:null})?{integration:classifyMcpIntegration({serverName:live.serverName,command:null})}:{}})
 const candidates=await discoverIntegrations(ctx)
 const blenderPath=resolveBlenderExecutable(),blender=await softwareVersion(blenderPath,'blender'),unity=process.env.LYAPUNOV_UNITY_EXECUTABLE?.trim()??candidates.find(v=>v.kind==='unity'&&basename(v.path)==='Unity')?.path
 const unityVersion=unity?await softwareVersion(unity,'unity'):null
 const samEntry=entries.find(e=>String(e.options.name).includes('segment-sam3')),sam=object(samEntry?.options.config)
 const samPath=typeof sam.checkpointPath==='string'?sam.checkpointPath:process.env.LYAPUNOV_SAM3_CHECKPOINT
 const samPython=typeof sam.pythonPath==='string'?sam.pythonPath:process.env.LYAPUNOV_SAM3_PYTHON
 const software:ExternalToolReading[]=[
  {id:'blender',installed:blender!==null,version:blender??undefined,detail:blender?'软件版本检查通过；addon 与 MCP 连接需另行检查。 / Software checked; addon and MCP are separate.':'未找到可用 Blender 命令。 / No usable Blender executable.',adapter:'blender_run',location:candidates.find(v=>v.kind==='blender'&&basename(v.path)==='blender')?.path??blenderPath},
  {id:'unity',installed:unityVersion?true:null,version:unityVersion??undefined,detail:unityVersion?'编辑器版本检查通过，MCP 连接另行检查。 / Editor checked; inspect MCP separately.':'未指定编辑器命令；可连接已运行的 Unity MCP，或从 Unity Hub 选择编辑器。 / No editor command supplied; existing MCP may still be connected.',adapter:'MCP',location:unity??candidates.find(v=>v.kind==='unity')?.path},
  {id:'sam3',installed:!!samPath&&existsSync(samPath)&&!!samPython&&existsSync(samPython),location:samPath,detail:'本地 checkpoint 与 Python 仅检查文件存在；推理、授权与模型兼容性尚需实际调用验证。 / File checks only; inference remains unverified.',adapter:'segment_sam3'},
  {id:'sam3d',installed:null,detail:'可下载目录锁定权重；当前没有 SAM 3D Objects 运行适配器。 / Downloadable; no runtime adapter.',adapter:'none'},
  {id:'da3',installed:null,detail:'可下载 DA3 BASE；当前 depth-estimation 使用 DA-V2，不会因下载而切换模型。 / DA3 acquisition does not replace DA-V2.',adapter:'DA-V2'},
 ]
 const supply=blenderMcpStatus(),paths=blenderMcpPaths()
 const existingCommand=await ctx.get('subprocess')?.resolveExecutable('mcp-for-blender').catch(()=>null)??null
 const installJobs=ctx.get('jobs')?.list(agent?.id).filter(j=>j.kind==='external-install'||j.kind==='fastgs-external').map(j=>({jobId:String(j.id),registryId:j.registryId??null,status:j.status,label:j.label,progress:j.progress??null,detail:j.detail??null}))??[]
 const skillOwner=ctx.get('skills'),skills:ExternalSkillRow[]=[];let skillsComplete=false,skillsDetail:string|null=null
 if(skillOwner){try{const snapshot=await skillOwner.snapshot({scope:agent as unknown as ScopeKey|undefined,cwd:agent?.session.header.cwd??profile?.cwd,signal});skillsComplete=snapshot.complete;for(const row of snapshot.skills)skills.push({name:row.name,description:row.description,provider:row.provider,source:row.source,path:row.path??null,modelInvocable:row.invocation.modelInvocable,userInvocable:row.invocation.userInvocable,toolVisible:tools.includes('skill'),currentScope:agent!==undefined});if(!snapshot.complete)skillsDetail='技能来源探测未完整；保留原生不完整读数。 / Native skill discovery is incomplete.'}catch(error){skillsDetail=errorText(error)}}else skillsDetail='原生技能目录未装配。 / Native skill catalog is unavailable.'
 return {capturedAt:Date.now(),writable:!!settings?.writable,software,mcp,skills,skillsComplete,skillsDetail,scopeSessionId:sessionId??null,candidates,associations:integrationAssociations(mcp),blenderSupply:{ready:supply.ready,command:paths.command,existingCommand,addon:paths.addon,detail:supply.detail},installJobs}
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
 if(input.id==='unity-mcp'){
  requireExternalWrite(ctx,agent,unityMcpSupplyPaths().root)
  return jobs.start({kind:'external-install',label:'Unity MCP pinned supply',owner:agent?.id,run:()=>{
   const controller=new AbortController()
   const done=ensureUnityMcp({signal:controller.signal}).then(async v=>{const picker=ctx.get('directoryPicker')?.capability(),home=picker?.kind==='browse'?picker.homeDirectory:undefined;await associateInstalledKnownMcp(ctx,[{kind:'unity',command:v.command,args:['--transport','stdio'],env:{...home?{UNITY_MCP_STATUS_DIR:join(home,'.unity-mcp')}:{},FASTMCP_CHECK_FOR_UPDATES:'off',FASTMCP_SHOW_SERVER_BANNER:'false'}}]);return {status:'completed' as const,result:JSON.stringify(v),detail:'Unity stdio bridge supplied; editor addon and live instance are separate.'}},e=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:errorText(e),detail:'Unity bridge supply did not complete; existing editor and settings retained.'}))
   return {cancel:()=>controller.abort(),done}
  }})
 }
 const entry=CREATIVE_TOOLS_CATALOG.find(v=>v.id===input.id)
 if(entry?.kind==='software'){
  const subprocess=ctx.get('subprocess');if(!subprocess)throw Error('SUBPROCESS_UNAVAILABLE')
  // 设置页也先复用现有软件；原 subprocess 负责命令解析，探测不安装、不起编辑器。
  const resolved=await subprocess.resolveExecutable(entry.id==='unity'?'Unity':'blender').catch(()=>null)
  const executable=entry.id==='blender'?(process.env.BLENDER_EXECUTABLE?.trim()??(resolved?.startsWith('/snap/bin/')?resolveBlenderExecutable():resolved)):process.env.LYAPUNOV_UNITY_EXECUTABLE?.trim()??resolved??(await discoverIntegrations(ctx)).find(v=>v.kind==='unity'&&basename(v.path)==='Unity')?.path
  const installedVersion=executable?await softwareVersion(executable,entry.id as 'blender'|'unity'):null
  if(installedVersion)return jobs.start({kind:'external-install',label:entry.name+' existing software check',owner:agent?.id,run:job=>{job.append(JSON.stringify({action:'reuse-existing-software',installationComplete:true,location:executable,version:installedVersion})+'\n',{channel:'stdout'});return {cancel:()=>{},done:Promise.resolve({status:'completed' as const,detail:'已有软件版本检查通过，已复用；MCP 与实际操作需另行验证。 / Existing software version checked and reused; verify MCP and the requested operation separately.'})}}})
  const plan=downloadPlan(entry.id)
  const opener=await subprocess.resolveExecutable(plan.argv[0]!).catch(()=>null)
  if(!opener)throw Error('OFFICIAL_INSTALLER_OPENER_MISSING: 无法打开官方下载页面，请使用条目中的官方链接。 / The system URL opener is unavailable; use the official link in this entry.')
  return jobs.start({kind:'external-install',label:entry.name+' official installer page',owner:agent?.id,run:job=>{
   const controller=new AbortController();job.append('Official download page: '+entry.source.url+'\n',{channel:'stdout'})
   job.updateProgress('Opening the official download / installation page')
   const child=subprocess.spawn({argv:[opener,...plan.argv.slice(1)],cwd:ctx.profileContext?.cwd??process.cwd(),env:plan.env,signal:controller.signal,graceMs:3000,stdio:{stdin:'ignore',stdout:{maxBytes:120000},stderr:{maxBytes:120000}}})
   const done=(async():Promise<JobOutcome>=>{try{
    const result=await child.done
    for(const channel of ['stdout','stderr'] as const){const output=child.collected[channel]?.readFrom(0);if(output?.text)job.append(redactSecretsText(output.text),{channel,...output.lossy?{gapBefore:true as const}:{}})}
    if(controller.signal.aborted)return {status:'killed',detail:'Opening cancelled; an already opened browser page is not closed.'}
    if(result.exitCode!==0)return {status:'failed',detail:'官方下载页面未能打开（exit '+String(result.exitCode)+'）；请使用官方链接。 / Official download page could not be opened (exit '+String(result.exitCode)+'); use the official link.'}
    return {status:'completed',result:JSON.stringify({sourceUrl:entry.source.url,action:'open-official-download',accepted:true}),detail:'官方安装页面已交给系统打开；完成安装后检查已有软件。 / Official installer page accepted by the system; software is not installed automatically. Inspect it after installation.'}
   }catch(error){return {status:controller.signal.aborted?'killed':'failed',detail:errorText(error)}}})()
   return {cancel:()=>controller.abort(),done}
  }})
 }
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

/** 只自动消费已明确的非秘密端口与可靠既有供给；未知/歧义保持未关联，不猜默认端口。 */
export async function associateKnownBlender(ctx:Context,env:NodeJS.ProcessEnv=process.env):Promise<'existing'|'associated'|'unknown'|'ambiguous'>{
 const entries=ctx.get('configEditor')?.entries()??[]
 const matches=entries.filter(e=>e.options.name===MCP_PLUGIN&&classifyMcpIntegration({serverName:String(object(e.options.config).serverName??''),command:typeof object(e.options.config).command==='string'?object(e.options.config).command as string:null})==='blender')
 if(matches.length>1)return 'ambiguous'
 if(matches.length===1)return 'existing'
 const port=env.LYAPUNOV_BLENDER_MCP_PORT?.trim()
 if(!port||!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||ctx.get('settings')?.writable!==true)return 'unknown'
 const candidates=(await discoverIntegrations(ctx,env)).filter(v=>v.kind==='blender'&&v.knownPackage)
 const supply=blenderMcpStatus(),paths=blenderMcpPaths()
 if(candidates.length>1)return 'ambiguous'
 const command=candidates.length===1?candidates[0]!.path:supply.ready?paths.command:undefined
 if(!command)return 'unknown'
 await saveExternalMcp(ctx,{serverName:'blender',transport:'stdio',command,args:[],blenderPort:Number(port),expectedRevision:null})
 return 'associated'
}

/** 显式用户切换沿原生 PluginManager，不自建 enablement 或绕过只读/依赖门。 */
export async function setExternalMcpEnabled(ctx:Context,input:{id:string;enabled:boolean}):Promise<unknown>{
 if(typeof input.id!=='string'||typeof input.enabled!=='boolean')throw Error('MCP_ENABLE_INPUT_INVALID')
 const manager=ctx.get('pluginManager');if(!manager)throw Error('MCP_ENABLE_OWNER_UNAVAILABLE: 原生插件管理器未装配。 / Native plugin manager is unavailable.')
 const row=(await manager.listPlugins()).find(v=>String(v.entryId)===input.id)
 if(!row||row.moduleName!==MCP_PLUGIN)throw Error('MCP_ENABLE_TARGET_INVALID: 仅允许切换已登记 MCP 服务。 / Select a registered MCP service.')
 const result=await manager.setPluginEnabled(pluginEntryId(input.id),input.enabled)
 if(result.error||result.application==='failed'||result.application==='cancelled')throw Error('MCP_ENABLE_FAILED: '+JSON.stringify(result.error??result.warnings))
 return result
}

/** 自然语言与设置页共用原生读数/Jobs；返回已有可用软件或明确的人工安装阶段。 */
export async function externalToolManagement(ctx:Context,input:{action:string;id?:string;localDir?:string;jobId?:string},sessionId:string,signal?:AbortSignal):Promise<unknown>{
 const agent=ctx.get('agents')?.get(SessionId(sessionId));if(!agent)throw Error('SESSION_NOT_LIVE')
 if(input.action==='status'){
  if(!input.jobId)throw Error('EXTERNAL_JOB_ID_REQUIRED')
  const view=ctx.jobs.get(JobId(input.jobId),agent.id)
  if(view.kind!=='external-install'&&view.kind!=='fastgs-external')throw Error('EXTERNAL_JOB_KIND_REQUIRED')
  const read=ctx.jobs.readAt(JobId(input.jobId),0,agent.id)
  return {job:view,output:read.chunks.map(c=>({channel:c.channel,text:redactSecretsText(c.text)})),nextOffset:read.next,installationComplete:false,instruction:'Read the outcome and inspect the software again. A completed acquisition job alone does not prove installation or runtime readiness.'}
 }
 const state=await externalToolsState(ctx,sessionId,signal)
 if(input.action==='inspect')return state
 if(input.action!=='acquire')throw Error('EXTERNAL_ACTION_INVALID')
 const entry=CREATIVE_TOOLS_CATALOG.find(v=>v.id===input.id)
 if(!entry&&!['blender-mcp','unity-mcp'].includes(input.id??''))throw Error('EXTERNAL_ACQUISITION_UNSUPPORTED')
 const existing=entry?.kind==='software'?state.software.find(v=>v.id===entry.id&&v.installed===true):undefined
 if(existing)return {status:'existing-software',software:existing,installationComplete:true,mcpComplete:false,instruction:'Reuse this existing executable. Its version probe passed. MCP/addon and the requested operation require their own native checks.'}
 const jobId=await startExternalAcquisition(ctx,{id:input.id!,localDir:input.localDir,sessionId})
 return {jobId,status:'acquisition-started',installationComplete:false,requiresManualInstaller:entry?.kind==='software',instruction:entry?.kind==='software'?'The native job opens the official platform installer. Continue normal installer/license interaction using the available native computer-use tools, then inspect the executable and verify the requested operation. Do not claim installation from opening a URL.':'Read the native Job outcome, then verify the package/runtime; downloaded files do not prove inference readiness.'}
}

/** 已有条目（含停用、自定义 namespace）始终优先；未知服务不自动加入。 */
export async function associateInstalledKnownMcp(ctx:Context,defaults:readonly import('../../../script/known-mcp.ts').KnownMcpDefault[]):Promise<void>{
 if(ctx.get('settings')?.writable!==true)return
 for(const candidate of defaults){
  const matches=(ctx.get('configEditor')?.entries()??[]).filter(e=>e.options.name===MCP_PLUGIN&&classifyMcpIntegration({serverName:String(object(e.options.config).serverName??''),command:typeof object(e.options.config).command==='string'?object(e.options.config).command as string:null})===candidate.kind)
  if(matches.length)continue
  await saveExternalMcp(ctx,{serverName:candidate.kind,transport:'stdio',command:candidate.command,args:candidate.args,expectedRevision:null,...candidate.kind==='blender'?{blenderPort:candidate.port}:{}},candidate.env)
 }
}
export function applyExternalToolsHost(ctx:Context,defaults:readonly import('../../../script/known-mcp.ts').KnownMcpDefault[]=[]):void{
 let association:Promise<void>|undefined
 ctx.on('agent/created',async()=>{association??=associateInstalledKnownMcp(ctx,defaults).catch(error=>ctx.logger.warn('Known MCP association failed: '+errorText(error))).finally(()=>{association=undefined});await association})
 ctx.tools.register(defineTool({name:'external_tool_management',description:'Inspect, acquire, and read native Jobs for the existing software/model catalog (Blender, Unity, SAM3, SAM3D, DA3) and pinned Blender/Unity MCP bridges. For user requests to download/install Blender or Unity, inspect first and reuse an existing installed executable; acquire missing software through its official installer and continue normal installer/license interaction using available native tools. Report manual steps or missing tools explicitly. Never infer installation from an opened URL, Job completion, checkpoint files, or MCP configuration. All Hub acquisition uses hf-mirror.com with no official-endpoint fallback. FastGS has its existing fastgs_external tool.',parameters:{action:{type:'string',required:true,enum:['inspect','acquire','status']},id:{type:'string',enum:[...CREATIVE_TOOLS_CATALOG.map(v=>v.id),'blender-mcp','unity-mcp']},localDir:{type:'string',description:'Absolute writable model directory, required for model acquisition.'},jobId:{type:'string',description:'Existing native acquisition Job identity for status.'}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>JSON.parse(JSON.stringify(await externalToolManagement(ctx,args as {action:string;id?:string;localDir?:string;jobId?:string},String(exec.agent!.id),exec.signal))) as never}))

 ctx.on('agent/created',async()=>{await associateKnownBlender(ctx).catch(error=>ctx.logger.warn('Existing Blender association failed: '+errorText(error)))})
 const register=(path:string,methods:readonly ('GET'|'POST')[],handler:(r:Request)=>Promise<Response>)=>ctx.effect(()=>ctx.connection.fetch.register({path:'/api/lyapunov/external-tools/'+path,methods,requestBody:'buffered',fetch:async r=>{try{return await handler(r)}catch(e){return Response.json({error:errorText(e)},{status:400})}}}))
 register('state',['GET'],async r=>Response.json(await externalToolsState(ctx,new URL(r.url).searchParams.get('sessionId')??undefined,r.signal),{headers:{'cache-control':'private, no-store'}}))
 register('mcp',['POST'],async r=>{await saveExternalMcp(ctx,await r.json() as ExternalMcpInput);return Response.json({saved:true,handshake:'Read the native server state and tool list separately.'})})
 register('enable',['POST'],async r=>Response.json(await setExternalMcpEnabled(ctx,await r.json() as {id:string;enabled:boolean})))
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
