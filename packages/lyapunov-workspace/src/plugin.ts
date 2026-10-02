import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-connection"
import type {} from "@deepseek-ai/dsh-fs"
import type {} from "@deepseek-ai/dsh-subprocess"
import type {} from "@deepseek-ai/dsh-sandbox-policy"
import type {} from "@deepseek-ai/dsh-workspace"
import type {} from "@deepseek-ai/dsh-api-session-controller"
import {SessionId} from "@deepseek-ai/dsh-session"
import {TerminalSessionId} from "@deepseek-ai/dsh-terminal"
import {FsVersion,type FsTarget} from "@deepseek-ai/dsh-fs"
import type {Agent} from "@deepseek-ai/dsh-agent"
import {join,basename,relative,resolve} from "node:path"
import {mkdir,readFile,writeFile} from "node:fs/promises"
import {randomUUID} from "node:crypto"
import {createRequire} from "node:module"
import {defineTool} from '@deepseek-ai/dsh-tools'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import type {} from '@deepseek-ai/dsh-commands'
import {applyWorkspacePreferences} from './preferences-host.ts'
import {CONVERT_CACHE_VERSION,DECODER_ASSET_KINDS,DEFAULT_MAX_OUTPUT_BYTES,ModelPreviewUnavailable,ModelPreviewUnsupported,convertCacheIdentity,convertRegisteredSource,convertSourceOf,convertToGlb,decoderAssetFiles,decoderAssetResponse,fileByteResponse,isRobotPath,productRoot,resolveCacheRoot,robotPreview,verifyDependencies} from './model-convert.ts'
// 拖拽转换只接受本会话 `scene_import` 已登记的源资源：路径从 scene service owner 解析，客户端给不了路径。
import {requireSessionId} from "../../lyapunov-contracts/src/session-scope.ts"
import type {SceneService} from "../../scene-kit/src/plugin.ts"
import type {SceneOperations} from "../../scene-kit/src/operations.ts"
import {localPath} from "../../scene-kit/src/formats.ts"
// DEV-032：HTML「预览页面／编辑源码」的通用入口（判据、话术、上限口径都在那一个模块里）。
import {planHtmlOpen} from '../../lyapunov-shell/src/html-preview-entry.ts'
export const name="lyapunov-workspace"

/** 交互终端（xterm）用的真实 PTY：node-pty 由上游 subprocess-local 提供，产品不另装原生依赖。
 * 只做运行时 require，不写类型侧包名解析——node-pty 只存在于上游 pnpm 依赖树内，
 * 从产品根静态解析不到；这里按实际使用的 IPty 面收窄，不复制上游类型。 */
type PtyProcess={onData(listener:(data:string)=>void):void;onExit(listener:(event:{exitCode:number})=>void):void;write(data:string):void;resize(columns:number,rows:number):void;kill(signal?:string):void}
type NodePty={spawn(file:string,args:string[],options:{name:string;cwd:string;cols:number;rows:number;env:Record<string,string>}):PtyProcess}
const localRequire=createRequire(import.meta.url)
const nodePty=createRequire(localRequire.resolve("@deepseek-ai/dsh-subprocess-local/package.json"))("node-pty") as NodePty
type XtermSession={pty:PtyProcess;clients:Set<(chunk:Uint8Array)=>void>;backlog:Uint8Array[];backlogBytes:number}
const xtermSessions=new Map<string,XtermSession>()
const XTERM_BACKLOG_LIMIT=65536
function xtermPush(session:XtermSession,chunk:Uint8Array){
  session.backlog.push(chunk);session.backlogBytes+=chunk.byteLength
  while(session.backlogBytes>XTERM_BACKLOG_LIMIT&&session.backlog.length>1){const dropped=session.backlog.shift()!;session.backlogBytes-=dropped.byteLength}
  for(const send of session.clients)send(chunk)
}
function xtermSpawnPty(cwd:string,input:{cols?:number;rows?:number}){
  const cols=Number.isInteger(input.cols)&&input.cols!>=20&&input.cols!<=400?input.cols!:120
  const rows=Number.isInteger(input.rows)&&input.rows!>=5&&input.rows!<=200?input.rows!:32
  const pty=nodePty.spawn(process.env.SHELL||"/bin/bash",["-l"],{name:"xterm-256color",cwd,cols,rows,env:{...process.env,TERM:"xterm-256color"} as Record<string,string>})
  const session:XtermSession={pty,clients:new Set(),backlog:[],backlogBytes:0}
  const id=randomUUID()
  pty.onData(data=>xtermPush(session,new TextEncoder().encode(data)))
  pty.onExit(({exitCode})=>{
    xtermPush(session,new TextEncoder().encode(`\r\n\x1b[90m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`))
    for(const send of session.clients)send(new Uint8Array(0))
    xtermSessions.delete(id)
  })
  xtermSessions.set(id,session)
  return {id}
}
export const inject=["connection","agents","fs","subprocess","terminals","sandboxPolicy","workspaceRegistry","sessionController"]
export interface Config{dataDirectory:string;/** 可选的 cache 域覆盖；未给时按 dataDirectory 与产品根的磁盘形状推断（见 resolveCacheRoot）。 */cacheRoot?:string;/** 可选的 Blender 可执行文件覆盖；未给时用 BLENDER_EXECUTABLE 或 PATH 上的 blender。 */blenderExecutable?:string}
export interface ReviewComment {id:string;path:string;line:number;side:"old"|"new";body:string;createdAt:string}

/**
 * 模型预览的路径校验（POST 的 `model-preview` action 与 GET 字节路由**共用**这一份）：
 * 会话 cwd ∪ 产品根，`target()` 同款（先 resolve 成规范路径再判 contains，软链指向根外必被拒）。
 * `cwd` 未给时只允许产品根内路径——GET 路由在会话 id 解析不出 agent 时就走这条。
 */
const modelPathTarget=async(ctx:Context,cwd:string|undefined,path:unknown,signal:AbortSignal):Promise<FsTarget>=>{
  if(typeof path!=="string")throw new Error("INVALID_PATH")
  const base=cwd||productRoot()
  const root=await ctx.fs.resolve(base,{signal})
  const productRootTarget=await ctx.fs.resolve(productRoot(),{signal})
  const value=await ctx.fs.resolve(path,{cwd:base,signal})
  if(!ctx.fs.contains(root,value)&&!ctx.fs.contains(productRootTarget,value))throw new Error(`OUTSIDE_WORKSPACE：${path} 既不在会话工作区 ${base} 内，也不在产品根 ${productRoot()} 内`)
  return value
}
/** 会话 id → 会话 cwd（与 POST 路由同一个 `resolveAgent`）；缺失/无效/无 cwd 一律返回 undefined。 */
const sessionCwd=async(ctx:Context,sessionId:string):Promise<string|undefined>=>{
  if(!sessionId)return undefined
  try{
    const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId))
    return 'error' in resolved?undefined:resolved.agent.session.header.cwd||undefined
  }catch{return undefined}
}

/** 手动工作区入口直接消费原生FS/PTY/Workspace；不复制执行器或会话。 */
export async function apply(ctx:Context,config:Config){
  await applyWorkspacePreferences(ctx)
  const commentWrites=new Map<string,Promise<unknown>>()
  const run=async(agent:Agent,argv:string[],signal:AbortSignal)=>{
    const cwd=agent.session.header.cwd;if(!cwd)throw new Error("WORKSPACE_REQUIRED")
    const policy=ctx.sandboxPolicy.resolve({session:agent.session})
    const sandbox=ctx.get("sandbox")
    if(policy.mode!=="danger-full-access"&&!sandbox)throw new Error("SANDBOX_UNAVAILABLE")
    const confined=policy.mode==="danger-full-access"?argv:(await sandbox!.confine(argv,{...policy,mode:policy.mode})).argv
    const child=ctx.subprocess.spawn({argv:confined,cwd,signal,stdio:{stdin:"ignore",stdout:{maxBytes:4000000},stderr:{maxBytes:1000000}},graceMs:2000,env:{GIT_PAGER:"cat",PAGER:"cat",GIT_TERMINAL_PROMPT:"0"}})
    const result=await child.done
    return {exitCode:result.exitCode,stdout:child.collected.stdout?.readFrom(0).text??"",stderr:child.collected.stderr?.readFrom(0).text??""}
  }
  // 模型预览的转换缓存落在运行根的 cache 域（可整删可重建）；推断不出来时回落 os.tmpdir()。
  const modelCache=resolveCacheRoot([config.cacheRoot,config.dataDirectory,process.env.LYAPUNOV_MODEL_CACHE])
  const operation=async(agent:Agent,action:string,input:any,signal:AbortSignal):Promise<unknown>=>{
    const cwd=agent.session.header.cwd;if(!cwd)throw new Error("WORKSPACE_REQUIRED")
    const root=await ctx.fs.resolve(cwd,{signal})
    const target=async(path=".")=>{if(typeof path!=="string")throw new Error("INVALID_PATH");const value=await ctx.fs.resolve(path,{cwd,signal});if(!ctx.fs.contains(root,value))throw new Error("OUTSIDE_WORKSPACE");return value}
    // 模型预览读的是"工作区模型文件 + 产品自带 materials"，因此范围按需求写成会话 cwd **或**产品根，
    // 仍然是 target() 同款校验（先 resolve 成规范 target 再判包含，软链指向根外必被拒）；与 GET 字节路由共用 modelPathTarget()。
    const modelTarget=async(path=".")=>modelPathTarget(ctx,cwd,path,signal)
    /**
     * 转换服务的**唯一 Blender 接线点**：`model-preview`（工作区内预览）与拖拽导入的 `convert-source`
     * （本会话已登记源资源）共用同一份子进程缝/缓存/导出实现；完整import和轻量preview有各自有界额度。
     * 两者只差入口：预览先过工作区边界（`convertToGlb`），拖拽只接受资源 owner 解析出的路径
     * （`convertRegisteredSource`），客户端路径在 `convert-source` 里根本不被读取。
     */
    const convertOptions=(signal:AbortSignal)=>({cacheRoot:modelCache.cacheRoot,base:cwd,spawn:(argv:string[],options:{cwd:string;signal:AbortSignal})=>ctx.subprocess.spawn({argv,cwd:options.cwd,signal:options.signal,stdio:{stdin:"ignore",stdout:{maxBytes:200000},stderr:{maxBytes:200000}},graceMs:3000}),blenderExecutable:config.blenderExecutable,signal})
    /** 本会话的场景/资源 owner（`scene_import`/`scene_mount` 背后的同一份实现）；取不到就明确失败。 */
    const sceneFor=(sessionKey:string):SceneOperations=>{
      const scene=ctx.get("scene") as SceneService|undefined
      if(!scene?.forSession)throw new Error("SCENE_SERVICE_UNAVAILABLE: 当前 Profile 未启用场景服务")
      return scene.forSession(sessionKey)
    }
    const sourceDisplayName=(path:string)=>basename(path).replace(/\.(?:blend|usd|usda|usdc|obj|fbx)$/i,"")
    const messageOf=(error:unknown)=>error instanceof Error?error.message:String(error)
    if(action==="info")return {cwd,terminals:ctx.terminals.list(agent)}
    if(action==="list"){const dir=await target(input.path);return {path:ctx.fs.processPath(dir),entries:(await ctx.fs.listDir(dir,signal)).map(item=>({name:item.name,path:relative(cwd,ctx.fs.processPath(item.target)),type:item.type,size:item.size}))}}
    if(action==="read"){
      const file=await target(input.path),before=await ctx.fs.stat(file,signal)
      if(!before||before.type!=="file")throw new Error("TEXT_FILE_REQUIRED")
      if((before.size??0)>4000000)throw new Error("文件超过4MB，请使用终端或模型的分段读取")
      const content=await ctx.fs.readText(file,signal),after=await ctx.fs.stat(file,signal)
      if(before.version!==after?.version)throw new Error("FILE_CHANGED_DURING_READ")
      return {path:input.path,content,version:after.version}
    }
    if(action==="write"){
      if(typeof input.content!=="string")throw new Error("TEXT_REQUIRED")
      const file=await target(input.path)
      const result=await ctx.fs.writeText(file,input.content,input.version?{kind:"replaceIfVersion",version:FsVersion(input.version)}:{kind:"createIfAbsent"},signal,ctx.sandboxPolicy.resolve({session:agent.session}))
      return {path:input.path,version:result.version,operation:result.operation}
    }
    if(action==="search"){
      if(typeof input.query!=="string"||!input.query)throw new Error("QUERY_REQUIRED")
      const result=await run(agent,["rg","--json","--fixed-strings","--",input.query,"."],signal)
      if(result.exitCode!==0&&result.exitCode!==1)throw new Error(result.stderr)
      const lines=result.stdout.split("\n");if(lines.at(-1))lines.pop()
      let truncated=result.stdout.length>=4000000
      const matches=lines.filter(Boolean).flatMap(line=>{
        try{
          const row=JSON.parse(line)
          return row.type==="match"?[{path:row.data.path.text,line:row.data.line_number,text:row.data.lines.text}]:[]
        }catch{
          // maxBytes can cut the final JSON record halfway through. Keep the
          // complete matches and let the client show its existing truncation hint.
          truncated=true
          return []
        }
      })
      return {matches,truncated}
    }
    if(action==="file-find"){
      if(typeof input.query!=="string")throw new Error("QUERY_REQUIRED")
      const result=await run(agent,["rg","--files","--hidden","--glob","!.git","--","."],signal)
      if(result.exitCode!==0&&result.exitCode!==1)throw new Error(result.stderr)
      const query=input.query.toLocaleLowerCase(),paths=result.stdout.split("\n").filter(Boolean).map(path=>path.replace(/^\.\//,"")),matches=paths.filter(path=>path.toLocaleLowerCase().includes(query))
      return {paths:matches.slice(0,100),truncated:matches.length>100||result.stdout.length>=4000000}
    }
    if(action==="html-plan"){
      // DEV-032 的**宿主侧**入口：判据与事实都只有一份（`html-preview-entry.ts`），界面只渲染返回的
      // choices/wording/recheck，不许自己再推导一遍。为什么必须在这里算：客户端模块拿不到 fs，而
      // `action:"read"` 在 4,000,000 B 处就拒绝——>4MB 的页面连头部都读不到，正是台账点名的"大文件"验收格。
      // 路径校验复用上面的 `target()`（先 resolve 再判 contains，软链逃逸同样被拒），不新写一份。
      const file=await target(input.path)
      const source=ctx.fs.processPath(file)
      const plan=await planHtmlOpen({
        filePath:source,
        displayPath:typeof input.path==="string"?input.path:source,
        // 素材服务：显式 env 优先，否则用页面 `<base href>` 里的回环 origin（"auto" 由模块自己判，
        // 宿主不重复实现这条判据）；页面没写 base 且没配 env 时如实报"未配置/不需要"。
        assetServer:"auto",
        previewOrigin:process.env.LYAPUNOV_HTML_PREVIEW_ORIGIN??null,
      })
      return plan
    }
    if(action==="convert-source"){
      // 拖拽导入专用，但**只接受本会话已登记的源资源身份**（前端先 `scene_import` 原件拿到 resourceId/version）：
      // 服务端从该会话资源 owner 解析源路径；`input.path` 一律不读，客户端既给不了路径也给不了边界开关。
      // 转换后复用既有 `scene_import` 的同一 operation 登记派生 GLB，只回可挂载 resourceId/version——
      // 不把宿主缓存/源件的绝对路径交给浏览器。原始源资源保留，派生件与它并列登记在同一会话资源库。
      const sessionKey=requireSessionId(agent,"拖拽源工程转换")
      const resourceId=typeof input.resourceId==="string"?input.resourceId.trim():""
      const version=typeof input.version==="number"&&Number.isInteger(input.version)?input.version:undefined
      if(!resourceId)throw new Error("CONVERT_SOURCE_RESOURCE_REQUIRED: convert-source 只接受本会话 scene_import 已登记的源资源 resourceId/version，不接受客户端路径")
      let record
      try{record=await sceneFor(sessionKey).resources.get(resourceId,version)}
      catch(error){return {kind:"unsupported",reason:`源资源不在本会话资源库：${messageOf(error)}`}}
      const sourcePath=localPath(record.ref.original.uri)
      const sourceKind=convertSourceOf(sourcePath)
      if(!sourceKind)return {kind:"unsupported",reason:`该资源不是可转换的源工程（.blend/.usd/.usda/.usdc/.obj/.fbx）：${sourcePath}`}
      // 本 action 会写会话资源库（登记派生 GLB），与 `scene_import` 同类：read-only 会话里拒绝，
      // 与 scene owner 的 `requireWritableScene` 读**同一个** `sandboxPolicy`，不另立权限规则。
      const policy=ctx.sandboxPolicy.resolve({session:agent.session})
      if(policy.mode==="read-only")throw new Error("SCENE_POLICY_READ_ONLY: 本会话的有效策略是 read-only，拖拽源工程转换属于用户请求的持久修改，已拒绝且没有写入任何文件；要修改请先把该会话切回可写模式")
      // 缓存身份由**资源版本 + 已核验依赖**生成：主文件没变不代表外部纹理/引用没变。
      // `metadata.externals` 只说明登记时 Blender 确认过外部文件清单；转换前还要按当前磁盘字节
      // 逐依赖重算 sha256 与记录核对（`verifyDependencies`）——任何缺失/大小/内容变化都判为不可核验，
      // 本次不复用旧缓存。不使用任何第二套格式解析器。
      const metadata=(record.parsed?.metadata??{}) as Record<string,unknown>
      const dependencies=(record.parsed?.dependencies??[]) as Array<{path:string;size:number;sha256:string}>
      const declaredVerified=['blend','obj','fbx'].includes(sourceKind)&&typeof metadata.externals==="object"&&metadata.externals!==null
      const dependencyCheck=declaredVerified?await verifyDependencies(dependencies):{verified:false,reason:sourceKind==="blend"?`Blender 依赖核验状态=${String(metadata.externals??"未知")}（外部纹理/链接库未知）`:"USD 的外部引用未由资源解析器枚举（不新增 USD 依赖解析器）"}
      const texturePolicy=metadata.sourceTexturePolicy==='available'?'available' as const:'strict' as const
      const losses=Array.isArray(metadata.missingTextureSnapshot)?metadata.missingTextureSnapshot:[]
      if(texturePolicy==='available'&&(!declaredVerified||!dependencyCheck.verified))return {kind:'unsupported',reason:'PARTIAL_SOURCE_SNAPSHOT_CHANGED: 已登记的可用依赖快照缺失或改变；请重导入新版本，不能读取原位置补图或复用旧缓存'}
      const dependenciesVerified=declaredVerified&&dependencyCheck.verified&&losses.length===0
      const cacheIdentity=convertCacheIdentity({
        resourceId:record.ref.resourceId,
        version:record.ref.version,
        dependencies,
        dependenciesVerified,
        converterVersion:CONVERT_CACHE_VERSION,
        unverifiedReason:dependencyCheck.reason??(declaredVerified?"依赖核验未通过":"依赖无法核验"),
        ...(['obj','fbx'].includes(sourceKind)?{textureSnapshot:{mode:texturePolicy,losses,subsetVerified:declaredVerified&&dependencyCheck.verified}}:{}),
      })
      try{
        const originals=(metadata.externals as {files?:unknown[]}|undefined)?.files
        const assetRemap=(sourceKind==='obj'||sourceKind==='fbx')&&Array.isArray(originals)?Object.fromEntries(originals.flatMap((path,index)=>typeof path==='string'&&dependencies[index]?.path?[[path,dependencies[index]!.path]]:[])):undefined
        const result=await convertRegisteredSource({path:sourcePath,cacheIdentity,texturePolicy,...assetRemap?{assetRemap}:{}},convertOptions(signal))
        const components=structuredClone(record.componentDefaults??{})
        // 源工程的视觉/原生文档由GLB重新装配；显式rigidBody/collision/controller继续属于同一资源生命周期。
        for(const key of ['visual','mujoco','isaac','articulation'])delete components[key]
        const intent=record.physicalizationRequest
        const physicalizeUsage=intent&&intent.usage!==undefined?intent.usage:components.rigidBody?.type==='static'?'static':'dynamic'
        const physicalize=intent===false?false:intent!==undefined?true:!components.collision
        const textureFacts=metadata.importFacts as {packedImageCount?:number;missingImages?:unknown[];emptyTextureDeclarations?:unknown[]}|undefined
        const textureLoss={policy:texturePolicy,partial:texturePolicy==='available',missingDependencies:losses.filter((loss:any)=>loss?.kind==='image'||loss?.kind==='material-library').map((loss:any)=>({kind:loss.kind,declared:basename(String(loss.raw??loss.path))})),emptyDeclarations:textureFacts?.emptyTextureDeclarations??[],packedImageCount:textureFacts?.packedImageCount??0,availableDependencySnapshot:dependencies.map(file=>({name:basename(file.path),size:file.size,sha256:file.sha256}))}
        const tags=texturePolicy==='available'?['保留几何与现有材质',`缺失依赖 ${textureLoss.missingDependencies.length}`,`空纹理声明 ${textureLoss.emptyDeclarations.length}`]:undefined
        const registered=await sceneFor(sessionKey).import({path:result.cachedPath,name:sourceDisplayName(sourcePath),...tags?{tags}:{},...Object.keys(components).length?{components}:{},...intent!==undefined?{physicalizationRequest:intent}:{physicalize,physicalizeUsage}})
        return {
          kind:"converted-glb",
          source:{resourceId:record.ref.resourceId,version:record.ref.version},
          glb:{resourceId:registered.resource.ref.resourceId,version:registered.resource.ref.version,name:registered.resource.name},
          sourceKind,cached:result.cached,convertMs:result.convertMs,
          cache:{reused:result.cached,basis:result.cacheBasis??cacheIdentity.basis,dependenciesVerified,snapshotVerified:dependencyCheck.verified},
          ...(['obj','fbx'].includes(sourceKind)?{textureLoss}:{}),
        }
      }catch(error){
        // 文件级问题（缺 Blender / 不支持的内容 / 超时 / 产物不是合法 GLB）一律进 unsupported，
        // 让拖拽面板能把"为什么没有显示"显示成一条可执行的原因，而不是只留一个 HTTP 错误。
        if(error instanceof ModelPreviewUnsupported||error instanceof ModelPreviewUnavailable)return {kind:"unsupported",reason:error.message}
        throw error
      }
    }
    if(action==="model-preview"){
      // 与 read 同款校验：任何输入路径先过 modelTarget()，越界/软链逃逸在喂给 Blender 之前就拒绝。
      // 越界是 RPC 级拒绝（OUTSIDE_WORKSPACE）；文件级问题（不存在/不是文件/超限/格式不支持）
      // 一律进 unsupported，让预览面板能把原因显示出来，而不是只留一个 HTTP 错误。
      const file=await modelTarget(input.path)
      const source=ctx.fs.processPath(file)
      try{
        const info=await ctx.fs.stat(file,signal)
        if(!info)throw new ModelPreviewUnsupported(`文件不存在：${source}`)
        if(info.type!=="file")throw new ModelPreviewUnsupported(`不是一个文件（${info.type}）：${source}`)
        const bytes=info.size??0
        // 先挡超限：无论走 Blender 还是机器人解析，都不可能为一个超限原件产出可用预览。
        if(bytes>DEFAULT_MAX_OUTPUT_BYTES)throw new ModelPreviewUnsupported(`模型原件 ${bytes} 字节超过预览上限 ${DEFAULT_MAX_OUTPUT_BYTES} 字节（24 MiB）`)
        if(isRobotPath(source)){
          const result=await robotPreview(source,cwd)
          return {kind:"robot",robot:result.robot,sourcePath:result.sourcePath}
        }
        if(convertSourceOf(source)){
          const result=await convertToGlb(source,convertOptions(signal))
          return {kind:"converted-glb",bytesBase64:result.bytes.toString("base64"),bytesLength:result.bytes.length,cachedPath:result.cachedPath,source:result.source,convertMs:result.convertMs,cached:result.cached}
        }
        throw new ModelPreviewUnsupported(`模型预览的宿主端不支持这个格式（只支持 .blend/.usd/.usda/.usdc 转换与 .xml/.mjcf/.urdf 机器人）：${source}`)
      }catch(error){
        if(error instanceof ModelPreviewUnsupported)return {kind:"unsupported",reason:error.message}
        throw error
      }
    }
    if(action==="terminal-open")return ctx.terminals.spawn(agent,{type:"shell",cwd,name:typeof input.name==="string"&&input.name?input.name:undefined},signal)
    if(action==="terminal-list")return ctx.terminals.list(agent)
    if(action==="terminal-send")return ctx.terminals.startSend(agent,TerminalSessionId(input.id),{text:input.text,submit:input.submit!==false,signal}).done
    if(action==="terminal-read")return ctx.terminals.read(agent,TerminalSessionId(input.id),{count:1000})
    if(action==="terminal-interrupt")return ctx.terminals.signal(agent,TerminalSessionId(input.id),"SIGINT")
    if(action==="terminal-close")return {closed:await ctx.terminals.kill(agent,TerminalSessionId(input.id),"用户关闭工作区终端")}
    if(action==="xterm-spawn")return xtermSpawnPty(cwd,input)
    if(action==="xterm-write"){
      const session=xtermSessions.get(input.id);if(!session)throw new Error("XTERM_NOT_FOUND")
      session.pty.write(String(input.data??""));return {ok:true}
    }
    if(action==="xterm-resize"){
      const session=xtermSessions.get(input.id);if(!session)throw new Error("XTERM_NOT_FOUND")
      if(Number.isInteger(input.cols)&&Number.isInteger(input.rows))session.pty.resize(Math.min(400,Math.max(20,input.cols)),Math.min(200,Math.max(5,input.rows)))
      return {ok:true}
    }
    if(action==="xterm-kill"){
      const session=xtermSessions.get(input.id);if(session){session.pty.kill();xtermSessions.delete(input.id)}
      return {closed:session!==undefined}
    }
    if(action==="git-status"){
      const status=await run(agent,["git","status","--porcelain=v1","-z","--untracked-files=all"],signal)
      if(status.exitCode!==0)return {...status,isRepository:false}
      const names=status.stdout.split("\0"),files:Array<{status:string;path:string;originalPath?:string}>=[]
      for(let i=0;i<names.length;i++){const value=names[i];if(!value)continue;const row:{status:string;path:string;originalPath?:string}={status:value.slice(0,2),path:value.slice(3)};if(/[RC]/.test(row.status))row.originalPath=names[++i];files.push(row)}
      return {isRepository:true,files,worktrees:await run(agent,["git","worktree","list","--porcelain"],signal),branches:await run(agent,["git","branch","--format=%(refname:short)"],signal)}
    }
    if(action==="git-diff"){
      const file=await target(input.path),path=relative(cwd,ctx.fs.processPath(file))
      if(!input.staged){
        const status=await run(agent,["git","status","--porcelain=v1","-z","--untracked-files=all","--",path],signal)
        if(status.exitCode!==0)return status
        if(status.stdout.startsWith("?? ")){
          const stat=await ctx.fs.stat(file,signal)
          if(!stat||stat.type!=="file")throw new Error("REVIEW_FILE_REQUIRED")
          const result=await run(agent,["git","diff","--no-index","--no-ext-diff","--no-color","--","/dev/null",path],signal)
          // no-index 的退出码 1 表示存在差异；原始 Git patch 保留新增文件的真实行号。
          return {...result,exitCode:result.exitCode===1?0:result.exitCode,comparison:"untracked"}
        }
      }
      return run(agent,["git","diff","--no-ext-diff","--no-color",...(input.staged?["--cached"]:[]),"--",path],signal)
    }
    if(action==="git-stage"||action==="git-unstage"){
      const file=await target(input.path),path=relative(cwd,ctx.fs.processPath(file))
      return run(agent,["git",...(action==="git-stage"?["add"]:["restore","--staged"]),"--",path],signal)
    }
    if(action==="git-commit"){
      if(typeof input.message!=="string"||!input.message.trim())throw new Error("COMMIT_MESSAGE_REQUIRED")
      return run(agent,["git","commit","-m",input.message],signal)
    }
    if(action==="git-worktree"){
      if(typeof input.path!=="string"||typeof input.branch!=="string"||!input.path||!input.branch||input.branch.startsWith("-"))throw new Error("WORKTREE_PATH_AND_BRANCH_REQUIRED")
      const path=resolve(cwd,input.path)
      const result=await run(agent,["git","worktree","add",...(input.create?["-b",input.branch]:[]),"--",path,...(!input.create?[input.branch]:[])],signal)
      if(result.exitCode!==0)return result
      const workspace=await ctx.workspaceRegistry.create(path,input.branch)
      return {...result,workspaceId:workspace.id,path:workspace.path}
    }
    if(action==="comments"||action==="comment-add"||action==="comment-remove"){
      if(!config.dataDirectory)throw new Error("PRIVATE_DATA_DIRECTORY_REQUIRED")
      const path=join(config.dataDirectory,encodeURIComponent(agent.id)+".json")
      let comments:ReviewComment[]=[];try{comments=JSON.parse(await readFile(path,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
      if(action==="comments")return comments
      if(action==="comment-add"){
        await target(input.path)
        if(!Number.isSafeInteger(input.line)||input.line<1||typeof input.body!=="string"||!input.body.trim()||!["old","new"].includes(input.side))throw new Error("INVALID_REVIEW_COMMENT")
        comments.push({id:randomUUID(),path:input.path,line:input.line,side:input.side,body:input.body,createdAt:new Date().toISOString()})
      }else comments=comments.filter(comment=>comment.id!==input.id)
      await mkdir(config.dataDirectory,{recursive:true});await writeFile(path,JSON.stringify(comments,null,2),{mode:0o600})
      return comments
    }
    throw new Error("UNKNOWN_WORKSPACE_OPERATION")
  }
  // 人工命令与模型工具复用同一已登记转换operation，不暴露客户端路径或另造转换owner。
  ctx.inject(['tools'],owner=>{
    owner.tools.register(compatibleToolInput(defineTool({name:'model_source_convert',description:'Convert this session\'s OBJ/FBX/Blender/USD source resource already registered through scene_import to a complete GLB using the same resource-version cache. When textures are missing, first explicitly select sourceTexturePolicy:available in scene_import to preserve geometry and existing materials. Retain the loss list without fabricating textures. After receiving glb.resourceId/version, use scene_mount to add it to the scene. Accept resourceId/version only, never paths.',parameters:{input:{type:'object',required:true,additionalProperties:false,properties:{resourceId:{type:'string',required:true},version:{type:'integer'}}}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){if(!exec.agent)throw new Error('SESSION_SCOPE_UNAVAILABLE: 源模型转换必须属于当前会话');return JSON.parse(JSON.stringify(await operation(exec.agent,'convert-source',args.input,exec.signal)))}})))
  })
  ctx.inject(['commands'],owner=>{
    owner.commands.register({name:'model_source_convert',description:'Convert this session\'s registered source resource while preserving its explicit texture policy.',input:{hint:'{resourceId,version?}'},async handler(invocation){const result=await operation(invocation.agent,'convert-source',JSON.parse(invocation.rawInput.trim()||'{}'),invocation.signal);return{kind:'success',text:JSON.stringify(result)}}})
  })
  ctx.effect(()=>ctx.connection.fetch.register({path:"/api/lyapunov/workspace",methods:["POST"],requestBody:"buffered",fetch:async request=>{
    try{
      const {sessionId,action,input}=await request.json() as {sessionId:string;action:string;input:unknown}
      const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId))
      if('error' in resolved)throw resolved.error
      const agent=resolved.agent
      if(action==="comment-add"||action==="comment-remove"){
        const result=(commentWrites.get(agent.id)??Promise.resolve()).catch(()=>{}).then(()=>operation(agent,action,input??{},request.signal))
        commentWrites.set(agent.id,result)
        try{return Response.json(await result)}finally{if(commentWrites.get(agent.id)===result)commentWrites.delete(agent.id)}
      }
      return Response.json(await operation(agent,action,input??{},request.signal))
    }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
  }}))
  // 交互终端输出流：base64 分块的 chunked 响应（SSE 帧，帧内无换行问题）；`__exit__` 标记进程退出。
  ctx.effect(()=>ctx.connection.fetch.register({path:"/api/lyapunov/workspace/xterm-output",methods:["GET"],requestBody:"buffered",fetch:async request=>{
    try{
      const url=new URL(request.url,"http://localhost"),sessionId=url.searchParams.get("sessionId")??"",id=url.searchParams.get("id")??""
      const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId))
      if('error' in resolved)throw resolved.error
      const session=xtermSessions.get(id)
      if(!session)return Response.json({error:"XTERM_NOT_FOUND"},{status:404})
      const encoder=new TextEncoder()
      let active=true
      const stream=new ReadableStream<Uint8Array>({
        start(controller){
          const send=(chunk:Uint8Array)=>{
            if(!active)return
            if(chunk.byteLength===0){try{controller.enqueue(encoder.encode("data: __exit__\n\n"))}catch{};try{controller.close()}catch{};active=false;return}
            try{controller.enqueue(encoder.encode("data: "+btoa(String.fromCharCode(...chunk))+"\n\n"))}catch{}
          }
          for(const chunk of session.backlog)send(chunk)
          if(active)session.clients.add(send)
          request.signal.addEventListener("abort",()=>{active=false;session.clients.delete(send);try{controller.close()}catch{}},{once:true})
        },
        cancel(){active=false},
      })
      return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store","x-accel-buffering":"no"}})
    }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
  }}))
  // 模型预览的字节直取路由：原件与转换产物都从这里出字节（大文件走 Range，不必整份过 POST 的 base64）。
  // `path` 与 POST 的 model-preview 共用 modelPathTarget()；会话 id 也共用 resolveAgent，
  // 解析不出 agent（缺 id/无效 id/会话无 cwd）时退化为"只允许产品根内路径"，此时 path 相对产品根解析。
  ctx.effect(()=>ctx.connection.fetch.register({path:"/api/lyapunov/model-preview",methods:["GET"],requestBody:"buffered",fetch:async request=>{
    try{
      const url=new URL(request.url,"http://localhost"),path=url.searchParams.get("path")??""
      if(!path)throw new Error("INVALID_PATH")
      const cwd=await sessionCwd(ctx,url.searchParams.get("sessionId")??"")
      const file=await modelPathTarget(ctx,cwd,path,request.signal)
      return await fileByteResponse(ctx.fs.processPath(file),request.headers.get("range"))
    }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
  }}))
  // 解码器静态资源（客户端 DRACO/KTX2 loader 用）：只出 three 自带 libs/{draco,basis} 下的真实文件。
  // 连接的 fetch 路由是**精确匹配**、没有通配（dsh-client-connection/src/rpc-host.ts:122 用 pathname 查 Map），
  // 所以按目录里的文件名逐个注册；文件名先过 `^[A-Za-z0-9._-]+$`，可寻址集合因此钉死在这两个目录内。
  // 目录不存在（没装 three）时一个都不注册，等价于客户端拿到 404。
  for(const kind of DECODER_ASSET_KINDS)for(const file of await decoderAssetFiles(kind)){
    ctx.effect(()=>ctx.connection.fetch.register({path:`/api/lyapunov/model-preview/asset/${kind}/${file}`,methods:["GET"],requestBody:"buffered",fetch:async request=>{
      try{return await decoderAssetResponse(kind,file,request.headers.get("range"))}
      catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
    }}))
  }
}
