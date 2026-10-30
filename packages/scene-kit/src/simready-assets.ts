import {isDeepStrictEqual} from 'node:util'
import {loadWarehouseCatalog,warehouseMirror,WAREHOUSE_REPO,WAREHOUSE_REVISION,WAREHOUSE_CSV,type WarehouseRow} from './warehouse-catalog.ts'
import {warehouseDetail,warehouseImport} from './warehouse-assets.ts'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import type { SceneOperations } from './operations.ts'
import { assertPublicHttpsURL, defaultHostResolver, fetchPublicHttpsBytesWithRetry, type HostResolver, type NetworkAssetTransport } from './network-assets.ts'
import { inspectUsd } from './usd-assets.ts'
import type { ResourceLicense } from './resources.ts'
import type { Transform } from '../../lyapunov-contracts/src/types.ts'

const MIRROR='https://hf-mirror.com'
const CENTRAL='https://raw.githubusercontent.com/NVIDIA-Omniverse/simready-central/main/submissions/'
const REPOS=['nvidia/simready-assets','LGElectronics/simready-assets','Vertiv/simready-assets','TraneTechnologies/simready-assets','Robotiq-Official/simready-assets','onrobot/simready-grippers','frankarobotics/simready-assets','FANUC-CORPORATION/SimReady-Assets','deeproboticslab/simready-assets','standardbots/simready-core','standardbots/simready-thor','standardbots/simready-spark',WAREHOUSE_REPO]
const SHA=/^[a-f0-9]{40}$/
const HASH=/^[a-f0-9]{64}$/
const MAX_BYTES=512*1024*1024
export interface SimreadyCandidate {repoId:string;revision:string;packagePath:string;name:string;source:'simready-central'|'warehouse-csv';sourceIndex:string;catalog?:WarehouseRow;catalogState?:string;thumbnailStatus?:'NOT_FETCHED'}
export interface SimreadySelection {repoId:string;revision:string;packagePath:string}
export type SimreadyFetch=(url:string,options:{signal?:AbortSignal;maxBytes:number;onBytes?:(count:number)=>void;hostResolver?:HostResolver;networkTransport?:NetworkAssetTransport})=>Promise<Uint8Array>
export interface SimreadyOptions {signal?:AbortSignal;fetchBytes?:SimreadyFetch;cacheDirectory?:string}
/** 每次请求和跳转之前校验；只接受镜像本域，绝不将官方重定向实际发出。 */
export function assertSimreadyUrl(value:string, kind:'mirror'|'central'='mirror'):URL {
 const url=new URL(value)
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hostname!==(kind==='mirror'?'hf-mirror.com':'raw.githubusercontent.com'))throw Error(`SIMREADY_MIRROR_BLOCKED: ${url.hostname}${url.pathname}`)
 return url
}
export const fetchSimreadyBytes:SimreadyFetch=async(url,options)=>{
 const kind=url.startsWith('https://raw.githubusercontent.com/')?'central':'mirror'
 let transferred=0
 const resolver=options.hostResolver??defaultHostResolver
 for(let hop=0;hop<=5;hop++) {
  const target=assertSimreadyUrl(url,kind)
  await assertPublicHttpsURL(target.href,resolver)
  options.signal?.throwIfAborted()
  let redirect:string|undefined
  try {
   const result=await fetchPublicHttpsBytesWithRetry(target,resolver,options.maxBytes-transferred,{transport:options.networkTransport,signal:options.signal,acceptHeader:'*/*',retry:{retries:1},onBytes:count=>{transferred+=count;options.onBytes?.(count)},onRedirect:location=>{redirect=location}})
   return result.bytes
  }catch(error){
   if(!redirect)throw error
   url=new URL(redirect,target).href;assertSimreadyUrl(url,kind)
  }
 }
 throw Error('SIMREADY_REDIRECT_LIMIT')
}
function safePath(value:string):string {
 if(!value||value.includes('\\')||value.includes('\0')||value.startsWith('/')||value.split('/').some(v=>v==='..'||v==='.')||value.includes(':'))throw Error(`SIMREADY_PATH_UNSAFE: ${value}`)
 return value
}
function selection(input:SimreadySelection):SimreadySelection {
 if(!/^[\w.-]+\/[\w.-]+$/.test(input.repoId)||!SHA.test(input.revision))throw Error('SIMREADY_FIXED_REVISION_REQUIRED')
 safePath(input.packagePath)
 if(basename(input.packagePath)!=='com.nvidia.simready.packaging.json')throw Error('SIMREADY_PACKAGE_DESCRIPTOR_REQUIRED')
 return input
}
export function parseSimreadyIndex(text:string,sourceIndex:string):SimreadyCandidate[]{
 const candidates:SimreadyCandidate[]=[]
 for(const line of text.split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!v.startsWith('#'))){
  // 官方登记文本里的官方URL只解析成数据，不发请求；下载强制改用镜像。
  const url=new URL(line),match=url.pathname.match(/^\/datasets\/([^/]+\/[^/]+)\/resolve\/([a-f0-9]{40})\/(.+)$/)
  if(!['huggingface.co','hf-mirror.com'].includes(url.hostname)||!match)throw Error(`SIMREADY_INDEX_INVALID: ${line}`)
  const row=selection({repoId:match[1]!,revision:match[2]!,packagePath:decodeURIComponent(match[3]!)})
  candidates.push({...row,name:basename(dirname(row.packagePath)),source:'simready-central',sourceIndex})
 }
 return candidates
}
const bytesToJson=(bytes:Uint8Array)=>JSON.parse(new TextDecoder().decode(bytes))
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
function mirrorFile(row:SimreadySelection,path:string):string{return `${MIRROR}/datasets/${row.repoId}/resolve/${row.revision}/${safePath(path).split('/').map(encodeURIComponent).join('/')}?download=true`}
function searchText(value:string):string {
 return value.replace(/([a-z\d])([A-Z])/g,'$1 $2').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
}
function candidateTermScore(row:SimreadyCandidate,value:string):number {
 const term=searchText(value)
 if(!term)return 0
 const name=searchText(row.name),label=searchText(row.catalog?.label??''),qCode=searchText(row.catalog?.qCode??''),classification=searchText(row.catalog?.classification??'')
 // 保留pallet→Pallets等简单复数召回，但不放宽到palletknife等其它单词。
 const terms=/^[a-z]{3,}$/.test(term)?[term,term+(/(?:s|x|z|ch|sh)$/.test(term)?'es':'s')]:[term]
 const contains=(text:string)=>terms.some(word=>(' '+text+' ').includes(' '+word+' '))
 // 源标签/Q code比名称更明确；词边界避免将palletknife误当pallet。
 if(label===term||qCode===term)return 100
 if(terms.includes(label))return 90
 if(name===term)return 80
 if(contains(label))return 60
 if(contains(name))return 40
 if(contains(classification))return 20
 // 厂商仍允许LG等简称；该字段不用于放宽资产名称的子串匹配。
 return row.repoId.toLowerCase().includes(value.toLowerCase())?5:0
}
export async function simreadySearch(input:{query?:string;repoIds?:string[];limit?:number;refresh?:boolean}={},options:SimreadyOptions={}){
 const repos=input.repoIds??REPOS;if(!repos.length||repos.length>13||repos.some(repo=>!REPOS.includes(repo)))throw Error('SIMREADY_SOURCE_NOT_REGISTERED')
 const fetch=options.fetchBytes??fetchSimreadyBytes,all:SimreadyCandidate[]=[],failures:Array<{repoId:string;reason:string}>=[],sourceSnapshots:Array<Record<string,unknown>>=[]
 for(const repoId of repos){try{
  if(repoId===WAREHOUSE_REPO){
   const catalog=await loadWarehouseCatalog({fetchBytes:fetch,signal:options.signal,refresh:input.refresh})
   all.push(...catalog.rows.map(row=>({repoId,revision:WAREHOUSE_REVISION,packagePath:row.catalogPath,name:row.name,source:'warehouse-csv' as const,sourceIndex:warehouseMirror(WAREHOUSE_CSV),catalog:row,catalogState:catalog.catalogState,thumbnailStatus:'NOT_FETCHED' as const})))
   sourceSnapshots.push({repoId,revision:WAREHOUSE_REVISION,catalogState:catalog.catalogState,catalogSha256:catalog.pins.catalogSha256,rows:catalog.rows.length,networkRefresh:input.refresh?'REQUESTED':'NOT_REQUESTED',refreshScope:'catalog-csv',thumbnailStatus:'NOT_FETCHED'})
   if(catalog.refreshFailure)failures.push({repoId,reason:'固定源缓存可读，但当次镜像刷新失败：'+catalog.refreshFailure})
   continue
  }
  const sourceIndex=CENTRAL+repoId,cache=options.cacheDirectory?join(options.cacheDirectory,repoId.replace('/','--')+'.json'):undefined
  let text:string|undefined
  if(cache&&!input.refresh){const stored=await readFile(cache,'utf8').then(value=>JSON.parse(value),()=>undefined);if(stored?.sourceIndex===sourceIndex&&typeof stored.text==='string'&&Number.isFinite(stored.fetchedAt)&&Date.now()-stored.fetchedAt<3600000)text=stored.text}
  if(text===undefined){text=new TextDecoder().decode(await fetch(sourceIndex,{signal:options.signal,maxBytes:4*1024*1024}));parseSimreadyIndex(text,sourceIndex);if(cache){await mkdir(dirname(cache),{recursive:true});await writeFile(cache,JSON.stringify({sourceIndex,fetchedAt:Date.now(),text}))}}
  all.push(...parseSimreadyIndex(text,sourceIndex))
 }catch(error){options.signal?.throwIfAborted();failures.push({repoId,reason:String(error)})}}
 const aliases:Record<string,string[]>={'仓库':['warehouse'],'眼镜':['glasses','eyeglasses'],'书本':['book'],'冰箱':['refrigerator','fridge'],'空调':['air_conditioner','hvac'],'净化器':['air_purifier'],'冷却':['cooling','chiller'],'机械臂':['robot','arm'],'夹爪':['gripper','robotiq','onrobot'],'纸箱':['box_cardboard','cardbox','box'],'托盘':['pallet'],'货架':['rack','shelf'],'风机':['fan'],'冰柜':['freezer']}
 let query=(input.query??'').toLowerCase()
 for(const alias of Object.keys(aliases))query=query.replaceAll(alias,' '+alias+' ')
 const words=query.split(/[\s]+/).filter(Boolean)
 const matches=all.map((row,index)=>{const scores=words.map(word=>Math.max(...[word,...aliases[word]??[]].map(term=>candidateTermScore(row,term))));return {row,index,score:scores.reduce((sum,score)=>sum+score,0),matched:scores.every(score=>score>0)}}).filter(result=>result.matched).sort((a,b)=>b.score-a.score||a.index-b.index).map(result=>result.row)
 const candidates=matches.slice(0,Math.min(30,Math.max(1,input.limit??12)))
 return {status:failures.length?(all.length?'PARTIAL':'BLOCKED'):candidates.length?'FOUND':'NO_MATCH',candidates,failures,sourceSnapshots,matched:matches.length,registeredEntriesRead:all.length,registeredPackagesRead:all.filter(row=>row.source==='simready-central').length,screening:'名称/分类按词边界筛选，原CSV标签和Q code精确命中优先排序后取Top-k；厂商支持简称与已有中文别名。固定元数据缓存不表示当次镜像成功，详情与完整依赖另核验',note:'候选来自Central登记或旧Warehouse固定CSV；目录可读/缓存命中不代表当次资产获取或物理验收，旧CSV没有新版BOM'}
}
interface BomItem {relative_path:string;size:number;hash:{sha256:string}}
export interface SimreadyDetail {sourceProtocol:'central-bom-v1';selection:SimreadySelection;packageId:string;license:ResourceLicense;rootUsd:string;files:BomItem[];totalBytes:number;metadataFiles:Array<{path:string;sha256:string;bytes:Uint8Array}>;descriptor:Uint8Array;descriptorSha256:string;sourceUrl:string}
async function centralDetail(input:SimreadySelection,options:SimreadyOptions={}):Promise<SimreadyDetail>{
 const row=selection(input),fetch=options.fetchBytes??fetchSimreadyBytes,base=dirname(row.packagePath)
 const descriptor=await fetch(mirrorFile(row,row.packagePath),{signal:options.signal,maxBytes:2*1024*1024}),data=bytesToJson(descriptor)
 if(data.format_version!=='1.0'||typeof data.package_id!=='string'||!Array.isArray(data.metadata)||data.metadata.length>16)throw Error('SIMREADY_DESCRIPTOR_INVALID')
 const metadataFiles:SimreadyDetail['metadataFiles']=[]
 let metadataBytes=descriptor.length
 for(const metadata of data.metadata){
  if(typeof metadata.name!=='string'||!HASH.test(metadata.hash?.sha256))throw Error('SIMREADY_METADATA_HASH_REQUIRED')
  const path=posix.join(base,'.metadata',safePath(metadata.name)),bytes=await fetch(mirrorFile(row,path),{signal:options.signal,maxBytes:16*1024*1024})
  metadataBytes+=bytes.length;if(metadataBytes>32*1024*1024)throw Error('SIMREADY_METADATA_BUDGET_EXCEEDED')
  if(digest(bytes)!==metadata.hash.sha256)throw Error(`SIMREADY_HASH_MISMATCH: ${path}`)
  metadataFiles.push({path,sha256:metadata.hash.sha256,bytes})
 }
 const bomFile=metadataFiles.find(row=>basename(row.path)==='com.nvidia.simready.packaging.bom.json')
 const rootsFile=metadataFiles.find(row=>basename(row.path)==='com.nvidia.simready.root_usds.json')
 if(!bomFile)throw Error('SIMREADY_BOM_METADATA_MISSING')
 const bom=bytesToJson(bomFile.bytes),roots=rootsFile?bytesToJson(rootsFile.bytes):undefined
 if(!Array.isArray(bom.items)||!bom.items.length||bom.items.length>5000)throw Error('SIMREADY_BOM_INVALID')
 const files:BomItem[]=bom.items.map((item:any)=>{
  if(typeof item.relative_path!=='string'||!Number.isSafeInteger(item.size)||item.size<0||!HASH.test(item.hash?.sha256))throw Error('SIMREADY_BOM_ITEM_INVALID')
  return {relative_path:safePath(item.relative_path),size:item.size,hash:{sha256:item.hash.sha256}}
 })
 if(new Set(files.map(row=>row.relative_path)).size!==files.length)throw Error('SIMREADY_BOM_DUPLICATE_PATH')
 const entries=Array.isArray(roots)?roots:roots?.root_usds
 const usdFiles=files.filter(file=>/\.(usd|usda|usdc|usdz)$/i.test(file.relative_path))
 const minDepth=Math.min(...usdFiles.map(file=>file.relative_path.split('/').length))
 const entriesFromBom=usdFiles.filter(file=>file.relative_path.split('/').length===minDepth).map(file=>file.relative_path)
 const rootPaths=(Array.isArray(entries)?entries:entriesFromBom).map((entry:any)=>typeof entry==='string'?entry:entry.relative_path??entry.path).filter((path:any)=>typeof path==='string')
 if(rootPaths.length!==1)throw Error(`SIMREADY_ROOT_SELECTION_REQUIRED: ${JSON.stringify(roots)}`)
 const rootUsd=safePath(rootPaths[0]!)
 if(!files.some(item=>item.relative_path===rootUsd))throw Error('SIMREADY_ROOT_NOT_IN_BOM')
 const licenseId=typeof data.license==='string'?data.license:typeof data.license?.id==='string'?data.license.id:'unknown'
 return {sourceProtocol:'central-bom-v1',selection:row,packageId:data.package_id,license:{id:licenseId,source:licenseId==='unknown'?'unknown':'file'},rootUsd,files,totalBytes:files.reduce((n,row)=>n+row.size,0)+descriptor.length+metadataFiles.reduce((n,row)=>n+row.bytes.length,0),metadataFiles,descriptor,descriptorSha256:digest(descriptor),sourceUrl:mirrorFile(row,row.packagePath)}
}
export async function simreadyImport(operations:SceneOperations,input:SimreadySelection&{maxBytes?:number;category?:"object"|"robot"|"scene";sceneId?:string;name?:string;resourceId?:string;entityId?:string;parentId?:string;transform?:Transform},options:SimreadyOptions={}){
 if(input.repoId===WAREHOUSE_REPO)return warehouseImport(operations,input,{...options,fetchBytes:options.fetchBytes??fetchSimreadyBytes})
 const maxBytes=input.maxBytes??128*1024*1024
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES)throw Error('SIMREADY_BUDGET_INVALID')
 const fetch=options.fetchBytes??fetchSimreadyBytes;let received=0
 const bounded:SimreadyFetch=async(url,request)=>{options.signal?.throwIfAborted();let streamed=0;const data=await fetch(url,{...request,maxBytes:Math.min(request.maxBytes,maxBytes-received),onBytes:count=>{streamed+=count;received+=count;if(received>maxBytes)throw Error('SIMREADY_BYTE_BUDGET_EXCEEDED')}});if(!streamed)received+=data.length;if(received>maxBytes)throw Error('SIMREADY_BYTE_BUDGET_EXCEEDED');return data}
 const detail=await centralDetail(input,{...options,fetchBytes:bounded})
 if(detail.license.id==='unknown'||/non.?commercial|\bnc\b|other/i.test(detail.license.id))throw Error(`SIMREADY_LICENSE_REVIEW_REQUIRED: ${detail.license.id}`)
 if(detail.totalBytes>maxBytes)throw Error(`SIMREADY_BYTE_BUDGET_EXCEEDED: required=${detail.totalBytes} budget=${maxBytes}`)
 const packageDirectory=join(operations.resources.downloadRoot,'simready',input.repoId.replace('/','--'),input.revision,dirname(input.packagePath))
 await mkdir(packageDirectory,{recursive:true})
 const put=async(path:string,bytes:Uint8Array)=>{const target=resolve(packageDirectory,safePath(path));if(!target.startsWith(resolve(packageDirectory)+'/'))throw Error('SIMREADY_PATH_UNSAFE');await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);return target}
 await put('com.nvidia.simready.packaging.json',detail.descriptor)
 for(const metadata of detail.metadataFiles)await put(posix.join('.metadata',basename(metadata.path)),metadata.bytes)
 for(const file of detail.files){
  options.signal?.throwIfAborted()
  const target=resolve(packageDirectory,file.relative_path)
  const previous=await readFile(target).catch(()=>undefined)
  if(previous&&previous.length===file.size&&digest(previous)===file.hash.sha256)continue
  const bytes=await bounded(mirrorFile(input,posix.join(dirname(input.packagePath),file.relative_path)),{signal:options.signal,maxBytes:file.size+1})
  if(bytes.length!==file.size||digest(bytes)!==file.hash.sha256)throw Error(`SIMREADY_HASH_MISMATCH: ${file.relative_path}`)
  await put(file.relative_path,bytes)
 }
 const path=join(packageDirectory,detail.rootUsd),inspection=await inspectUsd(path,{}, {signal:options.signal})
 for(const dependency of inspection.files){if(!dependency.startsWith(packageDirectory+'/'))throw Error(`SIMREADY_DEPENDENCY_OUTSIDE_PACKAGE: ${dependency}`);const rel=posix.relative(packageDirectory,dependency);if(!detail.files.some(file=>file.relative_path===rel))throw Error(`SIMREADY_DEPENDENCY_NOT_IN_BOM: ${rel}`)}
 // 整包保留为源码来源，而非只存USD root；单一ResourceLibrary仍管理身份与版本。
 let provenance={schema:'lyapunov.simready-source.v1',repoId:input.repoId,revision:input.revision,packagePath:input.packagePath,packageId:detail.packageId,packageFiles:['com.nvidia.simready.packaging.json',...detail.metadataFiles.map(row=>posix.join('.metadata',basename(row.path))),...detail.files.map(row=>row.relative_path)],descriptorSha256:detail.descriptorSha256,rootUsd:detail.rootUsd,license:detail.license,files:detail.files,mirror:MIRROR}
 const previousProvenance=await readFile(join(packageDirectory,'lyapunov-source.json'),'utf8').then(value=>JSON.parse(value),()=>undefined)
 if(previousProvenance){const {fetchedAt,...identity}=previousProvenance;if(isDeepStrictEqual(identity,provenance))provenance=previousProvenance}
 // 来源身份不随重试时间变化；兼容复用旧缓存的已登记manifest字节。
 await put('lyapunov-source.json',Buffer.from(JSON.stringify(provenance,null,2)))
 options.signal?.throwIfAborted()
 const purpose=String(inspection.usd.simreadyMetadata?.asset_type??inspection.usd.simreadyMetadata?.category??'').toLowerCase()
 const category=input.category??({robot:'robot',scene:'scene',environment:'scene',prop:'object'} as const)[purpose as 'robot'|'scene'|'environment'|'prop']??'object'
 const imported=await operations.import({...input,path,category,name:input.name??basename(dirname(input.packagePath)),license:detail.license,physicalize:false,storage:'reference',tags:['SimReady',`revision:${input.revision}`,`license:${detail.license.id}`]})
 return {status:'IMPORTED',...imported,source:provenance,packageDirectory,receivedBytes:received,verification:await operations.resources.verify(imported.resource.ref.resourceId,imported.resource.ref.version),note:'整包已按BOM逐文件核验；OpenUSD闭包与原件保留。源验证报告与本地引擎物理验收分别记录。'}
}
export function simreadyToolParameters(name:string):any{
 const properties:Record<string,unknown>=name==='simready_search'?{query:{type:'string'},repoIds:{type:'array',items:{type:'string'}},limit:{type:'number'},refresh:{type:'boolean'}}:{repoId:{type:'string',required:true},revision:{type:'string',required:true},packagePath:{type:'string',required:true},...name==='simready_import'?{category:{type:'string',enum:['object','robot','scene']},maxBytes:{type:'number'},sceneId:{type:'string'},name:{type:'string'},resourceId:{type:'string'},entityId:{type:'string'},parentId:{type:'string'},transform:{type:'json'}}:{}}
 return {input:{type:'object',required:true,additionalProperties:false,properties}}
}

export async function publicSimreadyDetail(input:SimreadySelection,options:SimreadyOptions={}) {
 if(input.repoId===WAREHOUSE_REPO)return warehouseDetail(input,{...options,fetchBytes:options.fetchBytes??fetchSimreadyBytes})
 const {descriptor,metadataFiles,...detail}=await centralDetail(input,options)
 return {...detail,metadataFiles:metadataFiles.map(({path,sha256,bytes})=>({path,sha256,size:bytes.length}))}
}

export async function simreadyDetail(input:SimreadySelection,options:SimreadyOptions={}){return input.repoId===WAREHOUSE_REPO?warehouseDetail(input,{...options,fetchBytes:options.fetchBytes??fetchSimreadyBytes}):centralDetail(input,options)}
