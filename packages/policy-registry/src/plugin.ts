import type { Context } from '@deepseek-ai/cordis'
import {compatibleToolInput} from '../../lyapunov-contracts/src/tool-input.ts'
import {requireWritableScene} from '../../scene-kit/src/plugin.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-commands'
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {fileURLToPath} from 'node:url'
import { randomUUID } from 'node:crypto'
import { asObject, hashFile, downloadPolicy, githubCredential, githubHeaders, githubSearchStatusError, huggingfaceEndpoint, policyDirectory, policyId, policyRevision, policySource, readPolicyCache, sourceSnapshot, type PolicySource } from './source.ts'
import { identityStrength, mirrorDiscoveryRequest, type DeclaredIdentity, type MirrorCoordinates, type SourceFileIdentity } from './mirror-search.ts'
import { downloadPack, packBearer, packCatalog, packDiscovery, packEndpoint, packError, packModelId, packPiece, readPackListing, type PackFetcher, type PackPiece } from './pack-source.ts'
import { preparePolicy, verifyPolicy, readAdapter, isPreparedAdapter } from './adapter.ts'
import type {PolicyRuntimeConfig} from './runtime.ts'
import { resolveModelFace, type PackModelRoute } from './pack-contract.ts'
import { createModelRoutes } from './model-routes.ts'
import { packTerm, packTerms } from './term.ts'
import { requireSessionId } from '../../lyapunov-contracts/src/session-scope.ts'
import { simWorldsFor } from '../../sim-contract/src/index.ts'
import { matchPolicy, resolvePolicyWorldBinding } from './match.ts'
import {policyLoadState} from './load-state.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'
import {resolveLocalPolicySource,verifyRegisteredPolicyFiles,type LocalPolicySource} from './local-policy-source.ts'
import {listLocalPolicyEntries,recordLocalPolicyEntry,registerLocalPolicyWeights,resolveLocalPolicyPath,resolveLocalPolicyEntry,readLocalPolicyBundle,verifyLocalPolicyBundle} from './local-policy-library.ts'
import {localPolicyFileKind} from './local-policy-file-contract.ts'
import {G1_23_75_ID} from './g1-23-75.ts'
import {adoptLocalG1Policy} from './g1-local-policy.ts'
import {installRobotDownload,robotDownloadManifest,registeredRobotDownloads,RobotDownloadFailure,type RobotDownloadFetcher} from './robot-download.ts'
import { executePolicy } from './execution.ts'
export { matchPolicy } from './match.ts'
export type { PolicyMatchInput, PolicyMatchDifference, PolicyMatchResult } from './match.ts'
export const name='lyapunov-policy-registry'
export const inject=['tools','commands','jobs']
export interface Config extends PolicyRuntimeConfig {guest?:boolean;dataDirectory?:string;endpoint?:string;
 /** packs 源端点（默认 $PACK_ENDPOINT / https://api.vorynel.com/packs/v1）；鉴权只经 $PACK_TOKEN，任何配置与文件不落 token。 */
 packEndpoint?:string
 /** 正式机器人下载服务地址仅由可信Host配置选择；模型工具不能覆盖携带账号Bearer的目的端点。 */
 robotDownloadEndpoint?:string
 /** 测试或可信Host装配注入；工具参数不得替换。 */
 robotDownloadFetcher?:RobotDownloadFetcher
 /** 可注入 fetcher（仅测试 mock 用，沿用 pack-source 的注入风格）；产品默认走全局 fetch。 */
 packFetcher?:PackFetcher}
declare module '@deepseek-ai/dsh-jobs' {interface JobKindMap {policy_download:'policy_download';policy_execution:'policy_execution'}}
const endpointOf=(configured?:string)=>{const value=(configured??process.env.MODELSCOPE_ENDPOINT??'https://modelscope.cn').replace(/\/$/,''),url=new URL(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('POLICY_ENDPOINT_MUST_BE_HTTPS');return value}
const headers={'user-agent':'LyapunovDSH-policy/0.1'}
/** 会话参数形状错误的错误码（工具入口与命令入口共用同一份归一化，见 `toolInput`）。 */
export const POLICY_INPUT_INVALID_JSON='POLICY_INPUT_INVALID_JSON',POLICY_INPUT_MUST_BE_OBJECT='POLICY_INPUT_MUST_BE_OBJECT'
/**
 * 工具入参归一化：`parameters:{input:{type:'json'}}` 下**对象与 JSON 字符串都是合法形状**，而执行体此前直传
 * `args.input`（命令路径 `:144` 才 `JSON.parse`）——模型把参数写成字符串时 `input.provider` 为 `undefined`，
 * 于是静默回落 ModelScope、`policyId(undefined)` 抛 INVALID_POLICY_MODEL_ID（回执 §6.1/§7.1）。这里把两条
 * 入口归到同一份对象上：合法 JSON 字符串解析成对象后走**原路径**，坏 JSON 或解析出的标量/数组明确报错
 * （绝不悄悄使用默认来源）。缺省（undefined/null）沿用既有的 `args.input ?? {}` 语义。
 */
export function toolInput(value:unknown):Record<string,any>{
  if(value===undefined||value===null)return {}
  let parsed:unknown=value
  if(typeof value==='string'){try{parsed=JSON.parse(value)}catch{throw new Error(POLICY_INPUT_INVALID_JSON)}}
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed as Record<string,any>
  // 不回显原文（入参可能很长且含用户内容），只说收到的**形状**。
  throw new Error(POLICY_INPUT_MUST_BE_OBJECT+'：input 需为对象或对象形状的 JSON 字符串，收到 '+(Array.isArray(parsed)?'array':typeof parsed))
}
export async function searchPolicies(endpoint:string,input:any,signal:AbortSignal){
  const query=input?.query??'policy',pageSize=input?.pageSize??10,provider=policySource(input.provider)
  if(typeof query!=='string'||!query.trim())throw new Error('POLICY_QUERY_MUST_BE_STRING')
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new Error('POLICY_PAGE_SIZE_INVALID')
  const url=provider==='github'?'https://api.github.com/search/repositories?'+new URLSearchParams({q:query,per_page:String(pageSize)}):provider==='huggingface'?huggingfaceEndpoint()+'/api/models?'+new URLSearchParams({search:query,limit:String(pageSize)}):endpoint+'/openapi/v1/models?'+new URLSearchParams({search:query,page_number:'1',page_size:String(pageSize)})
  const response=await fetch(url,{signal,headers:{...headers,...githubHeaders(url)}})
  // github 的 401/403/429 按同一套语义分类（配额限流 vs 权限）；其余状态码保持既有 `POLICY_SEARCH_<status>` 不变。
  // F1（2026-09-27）：这里此前调 `githubStatusError(..., githubCredential())` —— **漏传 `retryLayer`**，
  // 而它的默认值是取件链的 `'fetch'` ⇒ 检索链在真产品路径上一直发出取件链的措辞
  // （「立刻重试只会再烧配额」——**这条路根本没有重试层**；以及「本次成本 3 个请求 commit／repo／tree」
  // ——**这条路只打 1 个 `search/repositories`**）。改用**具名的检索链入口**，层写在函数名里，
  // 不再是"默认参数悄悄替你选"。`retryLayer` 只影响限流报文的措辞，**分类判定一个字没改**。
  if(!response.ok)throw provider==='github'&&[401,403,429].includes(response.status)?githubSearchStatusError(response.status,response.headers,url,githubCredential()):new Error('POLICY_SEARCH_'+response.status)
  const raw=await response.json(),body=asObject(raw)
  if(provider==='modelscope'&&(body.success!==true||!body.data))throw new Error('POLICY_REMOTE_INVALID_RESPONSE')
  const data=provider==='github'?body:asObject(body.data),rows=provider==='huggingface'?raw:provider==='github'?data.items:data.models
  const models=(Array.isArray(rows)?rows:[]).map((row:any)=>({...row,id:provider==='github'?row.full_name:row.id,displayName:row.display_name??row.name})).filter((row:any)=>typeof row.id==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.id))
  return {provider,endpoint:provider==='github'?'https://api.github.com':provider==='huggingface'?huggingfaceEndpoint():endpoint,query,models,total:data.total_count??models.length,status:models.length?'MATCHES':'NO_MATCH',nextSteps:models.length?[]:['调整关键词，或用 policy_metadata/policy_files 检查明确来源']}
}
/** 说法归一化在 term.ts（纯函数模块，浏览器侧的面板也读同一份）；这里原样再导出，检索工具口径不变。 */
export { packTerm } from './term.ts'

/** 单条 catalog 条目 ↔ 一条说法的匹配打分：数值小者优先，null＝不匹配。字段顺序＝确定性归类顺序。 */
function packMatchScore(row:Record<string,any>,term:string):{score:number;field:string}|null{
  const aliases=(Array.isArray(row.aliases)?row.aliases:[]).map(asObject).map(a=>({alias:packTerm(String(a.alias??'')),priority:Number.isInteger(a.priority)?a.priority:100,kind:String(a.kind??'')})).filter(a=>a.alias)
  const id=String(row.packId??'')
  if(packTerm(id)===term)return{score:0,field:'packId'}
  const exact=aliases.filter(a=>a.alias===term).sort((a,b)=>a.priority-b.priority||(a.alias<b.alias?-1:a.alias>b.alias?1:0))[0]
  if(exact)return{score:1,field:`alias:${exact.alias}`}
  const partial=aliases.filter(a=>a.alias.includes(term)||term.includes(a.alias)).sort((a,b)=>a.priority-b.priority||(a.alias<b.alias?-1:a.alias>b.alias?1:0))[0]
  if(partial)return{score:2,field:`alias:${partial.alias}`}
  if(packTerm(id).includes(term))return{score:3,field:'packId'}
  const rest=[String(row.family??''),String(row.status??''),JSON.stringify(row.capabilities??{}),JSON.stringify(row.policy??{})].map(packTerm).join('|')
  return rest.includes(term)?{score:4,field:'metadata'}:null
}

/** packs 源检索：只打我们服务器的**发现面**（有 PACK_TOKEN 时走鉴权 catalog，没有时走公开 discovery）——
 *  两处都只出元数据（无字节、无资产 URL、无任何凭据透传），**绝不回落公开源搜索**。
 *  匹配走**归一化 + 别名表**（旧实现是 `JSON.stringify(row).includes(term)`，中文说法如「宇树Go2」必然 NO_MATCH）。
 *  模型 id 按约定投影成 `packs/<packId>`；空 query = 列出全部条目（按别名 priority/模型名确定性排序）。 */
export async function searchPacks(config:{packEndpoint?:string;packFetcher?:PackFetcher},input:any,signal:AbortSignal){
  const query=input?.query??''
  if(typeof query!=='string')throw new Error('POLICY_QUERY_MUST_BE_STRING')
  const pageSize=input?.pageSize??10
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>50)throw new Error('POLICY_PAGE_SIZE_INVALID')
  // 三面分离：发现不需要密钥。有账号令牌时走鉴权 catalog（可校验账号并落 open/stream 计量），
  // 没有时走公开 discovery —— 两处都不把令牌交给发现面，也不因缺令牌而拒绝"能有什么包"这类只读查询。
  const token=packBearer()
  const catalog=token?await packCatalog({endpoint:config.packEndpoint,fetcher:config.packFetcher,signal}):await packDiscovery({endpoint:config.packEndpoint,fetcher:config.packFetcher,signal})
  const terms=packTerms(query)
  const models=(Array.isArray(catalog.packs)?catalog.packs:[]).map(asObject)
    .filter((row:any)=>typeof row.packId==='string'&&/^[A-Za-z0-9_.-]+$/.test(row.packId))
    .map((row:any)=>{const hits=terms.map((term:string)=>packMatchScore(row,term));return{row,hits}})
    .filter((entry:any)=>entry.hits.every((hit:any)=>hit!==null))
    .map((entry:any)=>({...entry,score:entry.hits.length?Math.min(...entry.hits.map((hit:any)=>hit.score)):0,matchedBy:[...new Set(entry.hits.map((hit:any)=>hit.field))]}))
    .sort((a:any,b:any)=>a.score-b.score||(a.row.packId<b.row.packId?-1:a.row.packId>b.row.packId?1:0))
    .slice(0,pageSize)
    .map((entry:any)=>({...entry.row,id:'packs/'+entry.row.packId,displayName:entry.row.packId,matchedBy:entry.matchedBy}))
  return {provider:'packs',endpoint:packEndpoint(config.packEndpoint),plane:token?'authenticated-catalog':'public-discovery',query,terms,models,total:models.length,status:models.length?'MATCHES':'NO_MATCH',
    nextSteps:models.length?['Directory matches are declared metadata only. Use the body\'s official website or official repository for source research; no regional, proxy, or adapted endpoint is required. Resolve source, interface, or error uncertainty with Browser Use keyword search and official pages, WebFetch for a known URL, and Bash for necessary acquisition. Report actual source revisions and actual missing requirements. Do not inject remote capability context from a pack name, tier, or catalog match or recommend a full bundle automatically. Authenticated retrieval retains catalog/open/stream authorization. Server metadata does not report robot behavior; standing, gait, or getting up require client simulation readback. Downloaded/PREPARED/MATCHED or short inference does not prove those behaviors.']:['The discovery surface returns metadata only. Refine the query or explicitly inspect a selected entry with policy_metadata; aliases are in packs/aliases.json. For uncertain source facts, use Browser Use keyword search and official pages or WebFetch for a known official URL. Do not infer an executable policy or inject remote capability context from a missing result.']}
}
/** catalog 条目（元数据 only）；无该 packId ⇒ PACK_NOT_FOUND。 */
async function packEntry(config:{packEndpoint?:string;packFetcher?:PackFetcher},signal:AbortSignal,modelId:string){
  const {packId}=packModelId(modelId)
  const catalog=await packCatalog({endpoint:config.packEndpoint,fetcher:config.packFetcher,signal})
  const entry=(Array.isArray(catalog.packs)?catalog.packs:[]).map(asObject).find((row:any)=>row.packId===packId)
  if(!entry)throw packError('PACK_NOT_FOUND',`catalog 无 packId=${packId}`)
  return entry
}
/** 可选 pieces 参数：缺省=四件套全量（downloadPack 默认）；逐项按 packPiece 校验，错误码原样上抛。 */
const packPiecesOf=(input:any):PackPiece[]|undefined=>input?.pieces===undefined?undefined:Array.isArray(input.pieces)?input.pieces.map(packPiece):(()=>{throw packError('INVALID_PACK_PIECE',String(input.pieces))})()
/**
 * D4（`bugfixHistory/VISIBILITY-HOLES-20260926.md`）：**「什么一律不要」的明文通道**。
 *
 * `mirror-search.ts` 的 `mirrorDiscoveryRequest()` 一直是第 3 级（产品自己不搜、把发现请求交给模型的
 * `web_search`／`web_fetch`）的产出，文件注释里也自称"refuses 把这条写成了**给模型看的明文**"——
 * 但产品 src **零调用**，唯一调用方是它自己的单测 ⇒ 端点全不通时，模型永远看不到
 * "搜到一个同名文件就用"在协议层面是被明文拒绝的。
 *
 * 这里把它接到**失败报文**上：有强身份声明（sha256／gitBlob）与固定坐标时附 `.refuses` 原文（逐条）；
 * 出不了发现请求时（身份不够强、或 packs 源）**把 `mirrorDiscoveryRequest` 自己的拒绝原话给出来**，
 * 并如实说明拿不到明文——**不编一份没有指纹的拒绝清单**（"看起来像"正是这份明文要挡的东西）。
 */
export function mirrorRefusalNote(input:{reason:string;declared:DeclaredIdentity|null;coordinates:MirrorCoordinates|null}):string{
 // 来源限流、错误文件选择和能力包端点错误没有进入字节传输回退，不附加镜像发现上下文。
 if(/\b(?:POLICY_GITHUB_RATE_LIMITED|POLICY_FILE_NOT_IN_SOURCE|PACK_[A-Z_]+)\b/.test(input.reason))return ''
 const header=['── 第 3 级发现请求（`mirror-search.ts` 的 `mirrorDiscoveryRequest()`）：搜之前先看「什么一律不要」──',`  为什么走到这一步：${input.reason}`].join('\n')
 if(input.declared&&input.coordinates){
  try{
   const request=mirrorDiscoveryRequest({declared:input.declared,coordinates:input.coordinates,reason:input.reason,admittedBy:'policy_download:level3'})
   return [
    header,
    `  身份的出处（provenance=${input.declared.provenance}）：${input.declared.note}`,
    `  判据（verification）：${request.verification.kind} = ${request.verification.value}，声明 ${String(request.verification.bytes)} 字节；${request.verification.rule}`,
    `  什么一律不要（refuses 原文，共 ${String(request.refuses.length)} 条）：`,
    ...request.refuses.map((line,index)=>`   ${String(index+1)}. ${line}`),
    '  照此搜：候选只能提供 URL，判据只来自上面的 verification；核对不过就继续搜，不放宽判据。',
   ].join('\n')
  }catch(error){
   return [header,`  本次没有发现请求可给（mirrorDiscoveryRequest 自己拒发）：${String(error)}`,'  这条拒绝本身就是判据：拿不到逐字相同的字节之前，别用任何「看起来像」的候选代替。'].join('\n')
  }
 }
 return [header,'  本次出不了发现请求：没有可核实的文件身份（sha256／gitBlob）与固定来源坐标。','  判据只有一条：字节与来源声明的 sha256／gitBlob **逐字相同**——文件名相同、字节数相同都不是同一份；候选自己声明的哈希同样不算判据。','  先取到固定 revision 上某个文件的身份（policy_files／policy_metadata），再重试取件。'].join('\n')
}
/**
 * D4 的**身份来源**：本机 `manifest.json` 里逐文件落下的 `sha256`／`gitBlob`
 * （`downloadPolicy` 来源解析成功后写 `sourceFiles`，`downloadPack` 在 open 快照后写）。
 *
 * 失败报文能给出 refuses 原文的前提就是"有一个强身份"：取件失败前若已解析出来源清单，本机就有指纹。
 * 读不到／不够强（`identityStrength` 只认 64 位 sha256／40 位 gitBlob）⇒ 返回 null，
 * 由 `mirrorRefusalNote()` 如实说"出不了发现请求"。
 */
export async function declaredIdentityFromManifest(root:string,provider:PolicySource,modelId:string,revision:string,files:string[]):Promise<DeclaredIdentity|null>{
 try{
  const manifest=asObject(JSON.parse(await readFile(join(policyDirectory(root,provider,modelId,revision),'manifest.json'),'utf8')))
  const rows=[...(Array.isArray(manifest.sourceFiles)?manifest.sourceFiles:[]),...(Array.isArray(manifest.files)?manifest.files:[])].map(asObject)
  const strong=(row:Record<string,any>)=>typeof row.sha256==='string'||typeof row.gitBlob==='string'
  const row=files.map(path=>rows.find(item=>item.path===path&&strong(item))).find(Boolean)??rows.find(strong)
  if(!row)return null
  const sha256=typeof row.sha256==='string'?row.sha256:undefined,gitBlob=typeof row.gitBlob==='string'?row.gitBlob:undefined
  const identity:SourceFileIdentity={path:String(row.path),bytes:Number(row.bytes),...(sha256?{sha256}:{}),...(gitBlob?{gitBlob}:{})}
  if(identityStrength(identity)==='none')return null
  return {identity,provenance:'local-manifest',
   note:`本机 manifest.json 里 ${identity.path} 的声明（${sha256?`sha256 ${sha256.slice(0,12)}…`:`gitBlob ${String(gitBlob).slice(0,12)}…`}）；这是本机已落盘的来源声明，本次没有重新访问来源核对`}
 }catch{return null}
}
/** 失败报文里"为什么走到第 3 级"的一行读数：只取首行（五要素诊断正文照旧在错误里，不在这里重复）。 */
const failureHead=(error:unknown):string=>String((error as Error)?.message??error).split('\n')[0]??''
/**
 * D4 附注：把明文**接在原错误对象上**再抛——`PACK_*` 错误码原样上抛是本包的既有合同
 * （`pack-plugin.test.ts` 按 `error.code` 断言），换一个新的 `Error` 会把 `code` 丢掉。
 */
const withMirrorNote=(error:unknown,note:string):unknown=>{
 if(!note)return error
 if(error&&typeof error==='object'&&typeof (error as {message?:unknown}).message==='string'){
  const target=error as {message:string}
  target.message=`${target.message}\n${note}`
  return error
 }
 return new Error(`${String(error)}\n${note}`)
}
/**
 * 策略匹配与执行只作用于**调用它的会话**的场景与世界：会话身份来自 exec.agent（工具/命令的既有上下文），
 * 与 scene/sim 两侧同一份规则；没有可核实的会话就明确失败，不落回共享库。
 */
function policyScene(ctx:Context,exec:any){const scene=ctx.get('scene') as {forSession?:(key:string)=>unknown}|undefined;if(!scene?.forSession)throw new Error('SCENE_SERVICE_UNAVAILABLE: 当前Profile未启用场景服务');return scene.forSession(requireSessionId(exec?.agent,'策略场景'))}
function policySim(ctx:Context,exec:any){return simWorldsFor(ctx,exec?.agent)}
export function apply(ctx:Context,config:Config={}){
 const productServices=()=>{if(config.guest)throw Object.assign(new Error("GUEST_PRODUCT_SERVICE_FORBIDDEN: guest cannot access Lyapunov packs or robot-download services"),{code:"GUEST_PRODUCT_SERVICE_FORBIDDEN"})}
 const endpoint=endpointOf(config.endpoint),directory=config.dataDirectory?resolve(config.dataDirectory):undefined
 const root=()=>{if(!directory)throw new Error('POLICY_DATA_DIRECTORY_REQUIRED');return directory}
 const identity=(input:any)=>{
  const selected=input?.identity!==undefined?toolInput(input.identity):input
  if(input?.identity!==undefined)for(const key of ['provider','modelId','revision'])if(input[key]!==undefined&&selected[key]!==undefined&&input[key]!==selected[key])throw new Error('POLICY_IDENTITY_CONFLICT: '+key)
  return {provider:policySource(selected.provider),modelId:policyId(selected.modelId),revision:policyRevision(selected.revision)}
 }
 const running=new Map<string,{runId:string;jobId:string;controller:AbortController}>()
 const localPath=(value:unknown,exec:any)=>{if(typeof value!=="string"||!value.trim())throw new Error("POLICY_LOCAL_PATH_REQUIRED");if(value.startsWith("file:"))return fileURLToPath(value);if(isAbsolute(value))return value;const cwd=exec?.agent?.session?.header?.cwd??exec?.agent?.session?.header?.meta?.cwd;if(typeof cwd!=="string")throw new Error("POLICY_WORKSPACE_REQUIRED: 相对路径需要当前会话工作区");return resolve(cwd,value)}
 const blocked=(error:unknown)=>{if(error instanceof RobotDownloadFailure)return {status:"BLOCKED",ready:false,...error.toJSON()};const message=error instanceof Error?error.message:String(error),code=message.match(/^(POLICY_[A-Z0-9_]+|ROBOT_[A-Z0-9_]+|GUEST_PRODUCT_SERVICE_FORBIDDEN)(?=:)/)?.[1]??'POLICY_LOCAL_LOAD_FAILED';return {status:"BLOCKED",ready:false,code,message,retryable:false}}
 const registeredInput=async(input:any,preparation=false)=>{
  if(input.entryId===undefined)return {input,entry:undefined}
  if(['filePath','manifestPath','directoryPath','weightsPath'].some(key=>input[key]!==undefined))throw Error('POLICY_LOCAL_ENTRY_INPUT_CONFLICT: Use entryId without another local file path')
  const entry=await resolveLocalPolicyEntry(root(),input.entryId)
  if(preparation&&(!entry.identity||!entry.sourceBytesVerified))throw Error('POLICY_LOCAL_ENTRY_UNVERIFIED: This entry has no verified source and observation/action adapter; register a matching bundle before preparing or applying it')
  if(entry.identity&&(input.identity!==undefined||input.modelId)){const declared=identity(input);if(declared.provider!==entry.identity.provider||declared.modelId!==entry.identity.modelId||declared.revision!==entry.identity.revision)throw Error('POLICY_LOCAL_ENTRY_IDENTITY_MISMATCH: The requested source does not match this registered entry')}
  const {entryId:_,identity:_identity,provider:_provider,modelId:_modelId,revision:_revision,...context}=input
  return {input:{...context,...entry.identity?{identity:entry.identity}:{}},entry}
 }
 const prepareInput=async(input:any,exec:any)=>{
  input=(await registeredInput(input,true)).input
  if(input.kind==='vla'&&(input.sceneId!==undefined||input.entityId!==undefined||input.worldId!==undefined))throw new Error('POLICY_VLA_PREPARATION_UNSUPPORTED: 当前机器人侧栏没有通用VLA观测/动作适配')
  const prepared:any={...identity(input)}
  if(input.weightsPath!==undefined)prepared.weightsPath=localPath(input.weightsPath,exec)
  const explicit=input.robotModelPath===undefined?undefined:localPath(input.robotModelPath,exec)
  if(input.sceneId===undefined&&input.entityId===undefined&&input.worldId===undefined){if(explicit)prepared.robotModelPath=explicit;return prepared}
  if(typeof input.sceneId!=='string'||typeof input.entityId!=='string')throw new Error('POLICY_SCENE_ENTITY_REQUIRED: 准备当前实例需sceneId和entityId')
  const operations=policyScene(ctx,exec) as any,snapshot=await operations.inspect(input.sceneId)
  const entity=snapshot.entities.find((e:any)=>e.entityId===input.entityId)
  if(!entity)throw new Error('POLICY_ENTITY_NOT_FOUND: 当前Scene中未找到选中机器人')
  if(input.worldId!==undefined){
   if(!Number.isInteger(input.expectedGeneration))throw new Error('POLICY_EXPECTED_GENERATION_REQUIRED')
   const sim=policySim(ctx,exec),world=(await sim.listWorlds()).find(w=>w.worldId===input.worldId)
   if(!world||world.sceneId!==snapshot.sceneId)throw new Error('POLICY_WORLD_BINDING_MISMATCH: world必须属于当前Scene')
   if(world.worldGeneration!==input.expectedGeneration)throw new Error('POLICY_STALE_GENERATION: 世界代次已变化，请重新观察')
   if(world.appliedSceneRevision!==snapshot.revision)throw new Error('POLICY_SCENE_NOT_SYNCED: 当前Scene版本尚未同步到所选世界')
   await sim.describe(input.worldId,input.entityId)
  }
  const authorized=new Set<string>()
  for(const ref of entity.resources){
   const record=await operations.resources.recordFor(ref)
   if(!record)continue
   const native=[record.ref.original,...record.ref.representations].filter((rep:any)=>rep.mimeType==='application/x-mjcf+xml')
   if(!native.length)continue
   const verified=await operations.resources.verifyReference(ref)
   if(!verified.valid)throw new Error('POLICY_ROBOT_RESOURCE_INVALID: 选中实体原件/依赖缺失或字节改变，请先重新登记正确版本')
   for(const rep of native){const p=rep.uri.startsWith('file:')?fileURLToPath(rep.uri):rep.uri;if(!isAbsolute(p))throw new Error('POLICY_ROBOT_SOURCE_PATH_UNRESOLVED');authorized.add(await realpath(p))}
  }
  if(!authorized.size)throw new Error('POLICY_ROBOT_SOURCE_MISSING: 选中实体缺少本会话已登记MJCF原件')
  const declared=entity.components?.mujoco?.sourcePath
  let source:string|undefined
  if(typeof declared==='string'&&declared){
   const p=declared.startsWith('file:')?fileURLToPath(declared):declared
   if(!isAbsolute(p))throw new Error('POLICY_ROBOT_SOURCE_PATH_UNRESOLVED')
   try{source=await realpath(p)}catch{throw new Error('POLICY_ROBOT_SOURCE_MISSING: 选中实体mujoco原件缺失')}
   if(!authorized.has(source)){
    // 已应用策略的场景保存派生模型；重新准备沿同一缓存适配器回到其已登记本体原件。
    const cached=await readAdapter(policyDirectory(root(),prepared.provider,prepared.modelId,prepared.revision))
    if(isPreparedAdapter(cached)&&entity.components?.controller?.policyAdapter===cached.adapter&&cached.sourceProvider===prepared.provider&&cached.sourceModelId===prepared.modelId&&cached.sourceRevision===prepared.revision&&await realpath(cached.modelPath)===source&&(await hashFile(source)).sha256===cached.modelSha256){
     const original=await realpath(cached.modelSourcePath)
     if(authorized.has(original))source=original
    }
    if(!authorized.has(source))throw new Error('POLICY_ROBOT_SOURCE_NOT_AUTHORIZED: sourcePath不属于选中实体的已登记原件')
   }
  }
  if(explicit){const selected=await realpath(explicit);if(!authorized.has(selected)||source&&selected!==source)throw new Error('POLICY_ROBOT_SOURCE_MISMATCH: 显式模型路径不能替换当前选中本体');source=selected}
  source??=authorized.size===1?[...authorized][0]:undefined
  if(!source)throw new Error('POLICY_ROBOT_SOURCE_AMBIGUOUS: 多个已登记MJCF原件，需显式选择其中一个')
  prepared.robotModelPath=source
  return prepared
 }
 const operations:Record<string,{description:string;execute:(input:any,exec:any)=>Promise<any>}>= {
  policy_download_sources:{description:"Read registered fixed sources and this account cache's localEntries. Each local entry id can be passed as entryId to policy_load_local or policy_load_state. Read manifest metadata only; do not access the network or search user directories. Registration does not establish adaptation/runtime success.",execute:async()=>({status:"REGISTERED_SOURCES",models:registeredRobotDownloads(),localEntries:await listLocalPolicyEntries(root())})},
  policy_load_local:{description:"Register an explicitly selected local file or root bundle, or reopen an existing account-cache entry by entryId without a file path. Unknown weights remain unverified. Registration never prepares, applies or executes a policy and does not authorize product-server requests.",execute:async(input,exec)=>{try{
   if(input.entryId!==undefined){const registered=await registeredInput(input),state=await operations.policy_load_state!.execute({...registered.input,filePath:registered.entry!.filePath},exec);return {...state,...state.localSource?{localSource:{...state.localSource,missingLicense:registered.entry!.missingLicense}}:{},localEntry:registered.entry,...registered.entry!.identity?{identity:registered.entry!.identity}:{}}}
   const path=await resolveLocalPolicyPath(localPath(input.manifestPath??input.directoryPath??input.filePath,exec)),isBundle=localPolicyFileKind(path)==='bundle'
   const declared=input.identity!==undefined||input.modelId?identity(input):undefined
   let manifest,localSource:LocalPolicySource|undefined,bundlePath=isBundle?path:undefined
   if(!isBundle){const selected=await resolveLocalPolicySource(path,declared);localSource=selected.source;manifest=selected.manifest
    if(localSource.identity?.provider==='github'&&localSource.prepareFrom==='weights'&&input.kind!=='vla'){await adoptLocalG1Policy(root(),path);const cached=policyDirectory(root(),'github',localSource.identity.modelId,localSource.identity.revision!),localEntry=await recordLocalPolicyEntry(cached,localSource.selectedRelativePath!,path,localSource);return {status:'LOCAL_WEIGHTS_ADOPTED',identity:localSource.identity,localSource:{...localSource,missingLicense:localEntry.missingLicense},localEntry,filePath:localEntry.filePath}}
    if(localSource.prepareFrom!=='bundle'||!manifest){const localEntry=await registerLocalPolicyWeights(root(),path,exec.signal,localSource),{identity:_,provider:_provider,modelId:_modelId,revision:_revision,...context}=input;return {...await operations.policy_load_state!.execute({...context,...localSource.identity?{identity:localSource.identity}:{},filePath:localEntry.filePath,manifestPath:undefined},exec),localEntry,filePath:localEntry.filePath}}
    bundlePath=localSource.bundlePath
   }
   manifest=robotDownloadManifest(manifest??await readLocalPolicyBundle(bundlePath!),{localRegistration:true})
   const selected={provider:manifest.source.provider,modelId:manifest.source.modelId,revision:manifest.source.resolvedRevision}
   if(declared&&(declared.provider!==selected.provider||declared.modelId!==selected.modelId||declared.revision!==selected.revision))throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: bundle与所选来源不一致')
   await verifyLocalPolicyBundle(dirname(bundlePath!),manifest)
   const registered=IMPLEMENTED_POLICY_ADAPTERS.find(pin=>pin.id===manifest.adapter?.id),entryPath=registered?.requires.files.find(path=>localPolicyFileKind(path)==='weights')??manifest.files.find(f=>localPolicyFileKind(f.path)==='weights')?.path
   if(!entryPath)throw Error('POLICY_DEPENDENCY_MISSING: bundle 没有支持的策略权重入口')
   const checks=await verifyRegisteredPolicyFiles(dirname(bundlePath!),selected)
   if(checks.some(c=>!c.valid))throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: 固定来源必需件缺失或字节不符 '+checks.filter(c=>!c.valid).map(c=>c.path).join('、'))
   if(manifest.adapter?.id===G1_23_75_ID&&input.kind!=='vla'){
    const weights=manifest.files.find(f=>f.path==='deployment/policy.pt')
    if(!weights)throw Error('POLICY_DEPENDENCY_MISSING: bundle 缺 deployment/policy.pt')
    const weightsPath=join(dirname(bundlePath!),'deployment/policy.pt'),resolved=await resolveLocalPolicySource(weightsPath,selected)
    await adoptLocalG1Policy(root(),weightsPath)
    localSource=resolved.source
    const localEntry=await recordLocalPolicyEntry(policyDirectory(root(),'github',selected.modelId,selected.revision),'deployment/policy.pt',bundlePath!,localSource)
    return {status:'LOCAL_WEIGHTS_ADOPTED',identity:selected,localSource,localEntry,filePath:localEntry.filePath}
   }
   const result=await installRobotDownload({manifest,endpoint:"http://127.0.0.1/local-only",modelId:manifest.packId,dataDirectory:root(),signal:exec.signal,localFiles:new Map(manifest.files.map(f=>[f.path,join(dirname(bundlePath!),f.path)]))})
   localSource??={status:'registered-package',identity:selected,adapterId:manifest.adapter?.id,packageRoot:dirname(bundlePath!),bundlePath,sourceBytesVerified:checks.length>0&&checks.every(c=>c.valid),prepareFrom:'cache',bundleDownloadReady:manifest.downloadReady,missingLicense:manifest.missingLicense??[]}
   // 完整包已安装后，准备读既有缓存，不再把原始裸filePath送成weightsPath。
   const cacheSource={...localSource,prepareFrom:'cache' as const}
   const localEntry=await recordLocalPolicyEntry(result.root,entryPath,bundlePath!,cacheSource)
   return {...result,identity:selected,localSource:cacheSource,localEntry,filePath:localEntry.filePath}
  }catch(error){return blocked(error)}}},
  policy_download_bundle:{description:"Fetch a specific model from the Host-configured unified robot-downloads endpoint. The default is a complete bundle; explicit pieces:[\"asset\"] fetches only the body dependency closure whose license was verified, returning modelPath for Scene/Resource registration. Policy licensing/runtime dependencies remain separate. The model cannot change authenticated endpoints. Return BLOCKED/original code and an exact web_fetch at the first error; do not retry the entire repository. Installing bytes is not adaptation or motion success.",execute:async(input,exec)=>{try{productServices();return await installRobotDownload({endpoint:config.robotDownloadEndpoint??"https://vorynel.com/lyaup-unified/v1/robot-downloads",fetcher:config.robotDownloadFetcher,modelId:input.modelId,token:packBearer(),dataDirectory:root(),signal:exec.signal,...input.pieces!==undefined?{pieces:input.pieces}:{}})}catch(error){return blocked(error)}}},
  policy_load_state:{description:"Read the four policy/VLA state categories and all missing requirements. entryId selects an already registered entry in this account cache without a file path. Distinguish the current Scene body, complete bundle bytes, weights, implemented code/prepared cache, instance matching, ready/running/paused world, and behavior not established by those states. Native joints require no policy. Check only explicit paths/caches and the actual current world; do not search or download automatically.",execute:async(input,exec)=>{
   const registered=await registeredInput(input);if(registered.entry)input={...registered.input,filePath:registered.entry.filePath}
   let scene:any,sim:any;try{scene=policyScene(ctx,exec)}catch{};try{sim=policySim(ctx,exec)}catch{}
   let manifest,filePath=input.filePath?localPath(input.filePath,exec):undefined
   try{if(input.manifest)manifest=robotDownloadManifest(input.manifest);if(input.manifestPath){const path=localPath(input.manifestPath,exec);if(!/^(?:bundle|[^/]+\.bundle)\.json$/i.test(basename(path)))throw new Error("ROBOT_BUNDLE_FILE_REQUIRED: 请选择正规bundle.json");manifest=robotDownloadManifest(JSON.parse(await readFile(path,"utf8")))}}
   catch(error){const refusal=blocked(error);return {category:"missing_files_or_runtime",executionKind:"unsupported_vla",ready:false,runtimeChecked:false,dimensions:{},missing:[{code:refusal.code,field:input.manifestPath?'manifestPath':'manifest',detail:refusal.message,nextAction:"local_load"}],nextActions:[{kind:'local_load',label:'一次补齐已列出的完整闭包或许可；不要重复搜索已选本体'}],worldBound:false,policyPrepared:false,robotWalkingVerified:false}}
   let selected=input.identity!==undefined||input.modelId?identity(input):undefined,localSource:LocalPolicySource|undefined
   if(filePath){try{const resolved=await resolveLocalPolicySource(filePath,selected);localSource=resolved.source;if(localSource.status==='unidentified')selected=undefined;else if(!selected&&localSource.identity)selected=identity({identity:localSource.identity})}catch(error){return {category:'model_incompatible',executionKind:'unsupported_vla',ready:false,runtimeChecked:false,dimensions:{},missing:[{code:'POLICY_LOCAL_SOURCE_MISMATCH',field:'filePath',detail:error instanceof Error?error.message:String(error),nextAction:'local_load'}],nextActions:[],worldBound:false,policyPrepared:false,robotWalkingVerified:false}}}
   const binding=input.binding??(input.sceneId&&input.entityId?{sceneId:input.sceneId,entityId:input.entityId,worldId:input.worldId,expectedGeneration:input.expectedGeneration,...selected??{provider:"github",modelId:"native/control"}}:undefined)
   let currentJointNames:string[]|undefined
   if(binding){const bound=sim?await resolvePolicyWorldBinding(binding,sim):binding;if(bound.worldId&&sim)try{const w=(await sim.listWorlds()).find((w:any)=>w.worldId===bound.worldId&&w.sceneId===binding.sceneId);if(w)currentJointNames=(await sim.describe(bound.worldId,bound.entityId)).controlledJointNames}catch{};if(!currentJointNames&&scene)try{const e=(await scene.inspect(binding.sceneId)).entities.find((e:any)=>e.entityId===binding.entityId);currentJointNames=e?.components?.articulation?.jointNames??e?.components?.mujoco?.jointNames}catch{}}
   const adapterId=selected&&IMPLEMENTED_POLICY_ADAPTERS.find(a=>selected.provider==='github'&&a.modelId===selected.modelId&&a.revision===selected.revision)?.id
   if(registered.entry&&localSource)localSource={...localSource,missingLicense:registered.entry.missingLicense}
   return {...await policyLoadState({dataDirectory:root(),pythonPath:config.pythonPath,pythonRuntimes:config.pythonRuntimes},{identity:selected,...filePath?{filePath}:{},...manifest?{manifest}:{},nativeControl:input.nativeControl===true,kind:input.kind,currentJointNames,binding,localSource},{scene,sim}),...registered.entry?{localEntry:registered.entry}:{}}
  }},
  policy_search:{description:"Search actual public policy sources on ModelScope or GitHub and return original source metadata. provider:\"packs\" queries only our server's capability-pack catalog (metadata only), never falling back to public sources.",execute:async(input,exec)=>{
   const provider=policySource(input?.provider)
   try{if(provider==='packs')productServices();return provider==='packs'?await searchPacks(config,input,exec.signal):await searchPolicies(endpoint,input,exec.signal)}
   catch(error){
    // D4：检索面失败也要先把"搜到一个同名文件就用"挡在协议层面（refuses 明文；没有文件身份时如实说"出不了"）。
    throw withMirrorNote(error,mirrorRefusalNote({reason:`policy_search 失败（provider=${provider}，query=${String(input?.query??'')}）：${failureHead(error)}`,declared:null,coordinates:null}))
   }
  }},
  policy_metadata:{description:"Preserve complete policy-source metadata and the resolved pinned revision, including source fields such as robot and simulator. provider:\"packs\" returns a catalog entry only: metadata without bytes or a URL.",execute:async(input,exec)=>{const id=identity(input);if(id.provider!=='packs'){const source=await sourceSnapshot(id.provider,id.modelId,id.revision,endpoint,exec.signal);return source.metadata}productServices();const entry=await packEntry(config,exec.signal,id.modelId);return {...entry,provider:'packs',id:id.modelId,requestedRevision:id.revision}}},
  policy_files:{description:"Read files, sizes, and source verification identities at the specified pinned revision. provider:\"packs\" reads the open-mount snapshot in manifest.sourceFiles persisted to CAS by policy_download; never open a billable mount merely to list files. cache=true reads local cache state only, without rehashing or source access, to report whether and how much of the model is already downloaded.",execute:async(input,exec)=>{const id=identity(input);if(input?.cache===true)return readPolicyCache(root(),id.provider,id.modelId,id.revision);if(id.provider!=='packs'){const source=await sourceSnapshot(id.provider,id.modelId,id.revision,endpoint,exec.signal);return {...id,resolvedRevision:source.resolvedRevision,files:source.files}}return readPackListing(root(),id.modelId,id.revision)}},
  policy_verify:{description:"Verify downloaded file bytes, SHA-256, and available source Git blob identities.",execute:input=>verifyPolicy(root(),identity(input))},
  policy_prepare:{description:"Prepare an adapter from a verified local entryId, verified policy cache, or explicit local weightsPath with a pinned source. Unknown entryIds cannot borrow a declared model identity. Resolve local paths against this session's cwd. When binding sceneId/entityId, obtain robotModelPath from the selected entity's actual registered original MJCF; reject world/generation/revision mismatches without scanning directories or replacing the body. Return only PREPARED and components/worldOptions; do not execute or claim motion success.",execute:async(input,exec)=>preparePolicy(root(),await prepareInput(input,exec),config)},
  policy_activate:{description:"Explicitly apply a prepared policy to the selected instance of the same body and create a matching world. Check original hashes, Scene CAS, and world generation first; reject an unsupported Host engine before Stop. Stop/close the old selected world, apply the registered controller/observation mapping, and use the current Host provider with policy manual/timestep options without changing the saved preference. Return matching state only; walking has not been executed.",execute:async(input,exec)=>{
   input=(await registeredInput(input,true)).input
   requireWritableScene(ctx,exec.agent,'策略实例应用 policy_activate')
   if(input.kind==='vla')throw Error('POLICY_VLA_BINDING_UNSUPPORTED')
   if(typeof input.sceneId!=='string'||typeof input.entityId!=='string'||typeof input.worldId!=='string'||!Number.isInteger(input.expectedRevision)||!Number.isInteger(input.expectedGeneration))throw Error('POLICY_ACTIVATION_BINDING_REQUIRED: 需要当前Scene/entity/world/revision/generation')
   const id=identity(input),ops=policyScene(ctx,exec) as any,sim=policySim(ctx,exec),before=await ops.scene.snapshot(input.sceneId),entity=before.entities.find((e:any)=>e.entityId===input.entityId),w=(await sim.listWorlds()).find(w=>w.worldId===input.worldId)
   if(!entity||before.revision!==input.expectedRevision||!w||w.sceneId!==input.sceneId||w.worldGeneration!==input.expectedGeneration||w.appliedSceneRevision!==before.revision)throw Error('POLICY_ACTIVATION_STALE_BINDING')
   const prepared=await preparePolicy(root(),await prepareInput({...input,...id},exec),config)
   if(prepared.status!=='PREPARED'||!prepared.components||!prepared.worldOptions)throw Error('POLICY_ACTIVATION_ADAPTER_REQUIRED')
   const adapter=prepared.adapter as any
   if(!(adapter.supportedEngines??[adapter.engine]).includes(w.engineId))throw Error('POLICY_ENGINE_UNSUPPORTED: 此适配器支持 '+(adapter.supportedEngines??[adapter.engine]).join('/')+'，当前Host为 '+w.engineId+'；未更改偏好、Scene或停止世界')
   const components={...entity.components};for(const [key,value]of Object.entries(prepared.components))components[key]={...(entity.components[key]??{}),...value as any}
   components.policyBinding={identity:id,modelSha256:adapter.modelSha256,adapterId:adapter.adapter,worldOptions:prepared.worldOptions}
   exec.signal?.throwIfAborted();await sim.stop(w.worldId,{expectedGeneration:w.worldGeneration});await sim.close(w.worldId);exec.signal?.throwIfAborted()
   const snapshot=await ops.scene.commit({sceneId:before.sceneId,expectedRevision:before.revision,patch:[{op:'update',entityId:entity.entityId,changes:{components}}]})
   const world=await sim.open(snapshot,prepared.worldOptions,exec.signal),match=await matchPolicy({dataDirectory:root()},{...id,sceneId:snapshot.sceneId,entityId:entity.entityId,worldId:world.worldId,expectedGeneration:world.worldGeneration},ops,sim)
   return {status:match.status==='MATCHED'?'ACTIVE_MATCHED':'ACTIVE_BLOCKED',identity:id,snapshot,world,match,behaviorVerified:false,executionStarted:false}
  }},
  policy_match:{description:"Compare the policy with the actual Scene/world/generation, joint order, units, control mode, frequency, and observation semantics. input contains sceneId, entityId, worldId, expectedGeneration. Without world arguments, bind only the session's unique actual handle for that Scene; never guess among worlds. Use sim_open when no world exists; missing arguments do not trigger redownloads. STATE-only input does not require vision.",execute:async(input,exec)=>{const sim=policySim(ctx,exec) as any;const bound=await resolvePolicyWorldBinding({...input,...identity(input)},sim);return matchPolicy({dataDirectory:root()},bound,policyScene(ctx,exec) as any,sim)}},
  policy_download:{description:"Stream downloads from a pinned source into the current account directory. files accepts only exact paths from the source listing or directory prefixes ending in /; * and ** wildcards are unsupported. Preserve .part on a real interruption and verify range responses and source-file identity when resuming. background=true uses native Jobs. provider:\"packs\" fetches only through capability-pack catalog/open/stream endpoints, optionally selecting pieces:asset|context|policy|vla, with no public-source fallback; propagate PACK_* codes unchanged.",execute:async(input,exec)=>{
   const id=identity(input);if(id.provider==='packs')productServices();const files=Array.isArray(input.files)&&input.files.length?input.files:['README.md','config.json'],pieces=packPiecesOf(input)
   const coordinates:MirrorCoordinates={provider:id.provider,modelId:id.modelId,revision:id.revision}
   // D4：`downloadPolicy`／`downloadPack` 一开跑就把 manifest 改写成 DOWNLOADING（并清掉上一次的 sourceFiles）
   // ⇒ "上一次留下的身份声明"必须在**跑之前**读；跑失败后再读一次（本次来源解析成功的话，指纹就在这里）。
   const prior=await declaredIdentityFromManifest(root(),id.provider,id.modelId,id.revision,files)
   const run=async(signal:AbortSignal)=>{
    try{
     return id.provider==='packs'
      ?await downloadPack({dataDirectory:root(),modelId:id.modelId,revision:id.revision,...(pieces?{pieces}:{}),endpoint:config.packEndpoint,fetcher:config.packFetcher,signal})
      :await downloadPolicy({dataDirectory:root(),endpoint,...id,files,signal,resume:input.resume!==false})
    }catch(error){
     // D4：失败报文里补上"什么一律不要"的明文（能形成强身份时即 refuses 原文；形不成时如实说出不了）。
     const declared=await declaredIdentityFromManifest(root(),id.provider,id.modelId,id.revision,files)
     throw withMirrorNote(error,mirrorRefusalNote({reason:`policy_download 取件失败（${id.provider} ${id.modelId}@${id.revision}）：${failureHead(error)}`,declared:declared??prior,coordinates}))
    }
   }
   if(!input.background)return run(exec.signal)
   const controller=new AbortController()
   const jobId=ctx.jobs.start({kind:'policy_download',label:'Policy 下载 '+id.modelId,owner:exec.agent?.id,run:()=>({cancel:()=>controller.abort(),done:run(controller.signal).then(result=>({status:'completed' as const,result:JSON.stringify(result)}),error=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:String(error)}))})})
   return {status:'RUNNING',jobId}
  }},
  policy_execute:{description:"Execute an adapted policy through existing ctx.sim in a matching world/entity/generation. Synchronize CPU inference with physics steps. Long-running tasks use native Jobs and support policy_stop or job_kill.",execute:async(input,exec)=>{
   requireWritableScene(ctx,exec.agent,'本地策略执行 policy_execute')
   const id=identity(input),sim=policySim(ctx,exec),scene=policyScene(ctx,exec) as any
   if(!Number.isInteger(input.expectedGeneration))throw new Error('POLICY_EXPECTED_GENERATION_REQUIRED')
   const matched=await matchPolicy({dataDirectory:root()},{...input,...id},scene,sim)
   if(matched.status!=='MATCHED')return matched
   const key=input.worldId+'/'+input.entityId
   if(running.has(key))throw new Error('POLICY_ENTITY_ALREADY_RUNNING')
   const runId='policy-'+randomUUID(),controller=new AbortController()
   const jobId=ctx.jobs.start({kind:'policy_execution',label:'Policy 执行 '+id.modelId,owner:exec.agent?.id,outputLimitBytes:8000,run:()=>({cancel:()=>controller.abort(),done:executePolicy({dataDirectory:root(),pythonPath:config.pythonPath,pythonRuntimes:config.pythonRuntimes},{...input,...id,runId},scene,sim,controller.signal).then(result=>({status:result.status==='COMPLETED'?'completed' as const:result.status==='CANCELLED'?'killed' as const:'failed' as const,result:JSON.stringify(result)}),error=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:String(error)})).finally(()=>running.delete(key))})})
   running.set(key,{runId,jobId,controller})
   return {status:'RUNNING',runId,jobId,worldId:input.worldId,entityId:input.entityId,expectedGeneration:input.expectedGeneration,resultPath:join(root(),'policy-runs',runId,'result.json')}
  }},
  policy_stop:{description:"Stop policy Jobs for the specified world/entity and wait for physical stop confirmation and execution receipts.",execute:async(input,exec)=>{
   const key=input.worldId+'/'+input.entityId,run=running.get(key)
   if(!run)return {status:'NOT_RUNNING',worldId:input.worldId,entityId:input.entityId}
   ctx.jobs.kill(JobId(run.jobId),exec.agent?.id,'policy-stop');await ctx.jobs.wait(JobId(run.jobId),10000,exec.agent?.id)
   try{return JSON.parse(await readFile(join(root(),'policy-runs',run.runId,'result.json'),'utf8'))}catch{return {status:'STOPPING',runId:run.runId,jobId:run.jobId}}
  }},
 }
 for(const [name,definition] of Object.entries(operations)){
  const tool=defineTool({name,description:definition.description,parameters:{input:{type:'json',required:true,description:"JSON arguments; source provider may be modelscope|github|huggingface|packs."}},output:{schema:{type:'json'},render:(_args:any,value:any)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args:any,exec:any)=>definition.execute(toolInput(args?.input),exec)})
  ctx.tools.register(['policy_load_state','policy_load_local','policy_download_bundle','policy_prepare','policy_activate','policy_match','policy_execute','policy_stop'].includes(name)?compatibleToolInput(tool):tool)
  ctx.commands.register({name,description:definition.description,input:{hint:"Policy arguments as JSON."},async handler(invocation){try{
   const value=await definition.execute(JSON.parse(invocation.rawInput||'{}'),invocation)
   // 人工命令的后台任务由原生 Jobs 面板呈现；原生 waiter 认领完成通知，
   // 不因一次按钮/命令操作自动唤醒模型。模型 Tool 发起的 Job 仍照常通知。
   if(value?.jobId)void ctx.jobs.wait(JobId(value.jobId),600_000,invocation.agent?.id).catch(()=>{})
   return {kind:'success',text:JSON.stringify(value)}
  }catch(error){return {kind:'error',text:String(error)}}}})
 }
 // 模型路由条目服务（模型面 + 本机缓存事实）：持有端点配置与 dataDirectory 的一方出这一份只读事实，
 // 包面板与取件命令共读——消费方（shell）的运行根不含权重缓存目录，自己拼不出这条路。
 ctx.reflect.provide('policyModels',config.guest?{invalidate(){},async list(){return {status:'UNREACHABLE' as const,code:'GUEST_PRODUCT_SERVICE_FORBIDDEN',checkedAt:new Date().toISOString(),routes:[]}}}:createModelRoutes({dataDirectory:directory,packEndpoint:config.packEndpoint,fetcher:config.packFetcher}))
 ctx.effect(()=>()=>{for(const run of running.values())run.controller.abort()})
}
