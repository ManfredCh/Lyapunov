/** 机器人库是 pack / T0 / ResourceLibrary 的薄投影，不保存第二份索引。 */
import {readFile,stat} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {declaredAssetEntries,declaredAssetPreview,inspectPack,sha256File} from '../../policy-registry/src/pack-contract.ts'
import {lookupPackTier,type T0Roster} from '../../policy-registry/src/tier-roster.ts'
import {robotVisual} from './formats.ts'
import type {DefaultRobotPolicy} from '../../policy-registry/src/default-robot-policies.ts'
import type {SceneOperations} from './operations.ts'

export interface RobotLibraryRow {
 packId:string;version:string;family:string;tier:'T0';source:string;license:string;policyLicense:string
 modelPath:string|null;modelBytes:number|null;modelSha256:string|null;installed:boolean;resourceId:string|null
 /** 包内官方预览图绝对路径（asset.preview 显式登记 + 供给 inventory SHA 复核通过）；没有就是 null，UI 回落占位图标。 */
 previewPath:string|null
 policyStatus:'PREPARED'|'BLOCKED'|'none';policyVariant:string|null;policyDetail:string|null;sourceDof:number|null;policyDof:number|null;channels:string[];control:string;mode:string|null;adapterReady:boolean;behaviorVerified:boolean;gaps:string[]
}
/**
 * 供给 inventory 的 `files[].path` 相对包的 `asset/` 根；把 `pack.json` 的包相对入口换算成同一口径。
 * 不在 `asset/` 下的入口没有 inventory 可核，返回 null（调用方如实报 MODEL_NOT_BUNDLED，不猜）。
 */
const assetInventoryPath=(entry:string):string|null=>{
 const normalized=entry.replace(/\\/g,'/').replace(/^\.\//,'')
 return normalized.startsWith('asset/')?normalized.slice('asset/'.length):null
}
/** 已登记资源的入口字节 SHA（parseAsset 的依赖闭包第一项恒为入口）。 */
const resourceEntrySha=(record:any):string|undefined=>record?.parsed?.dependencies?.[0]?.sha256
/**
 * prepared 资源的精确身份：同一 adapter **且**入口字节 SHA 完全一致；缺任一都不算已登记。
 * pack 标签或 adapter 同名不足以识别模型——旧 demo/错字节资源不得冒充本体。
 */
const matchesPreparedIdentity=(record:any,prepared:NonNullable<DefaultRobotPolicy['prepared']>):boolean=>
 record?.componentDefaults?.controller?.policyAdapter===prepared.adapter.adapter
 &&typeof prepared.adapter.modelSha256==='string'&&prepared.adapter.modelSha256.length>0
 &&resourceEntrySha(record)===prepared.adapter.modelSha256
/**
 * 机器人本体 = `pack.json` 显式声明的 `asset.model`（未登记时 `declaredAssetEntries` 回落 `modelEntry`，
 * 仅对 cf2/go1 这类入口本身就是本体的包成立）。本函数只信这一处声明，并逐项核对：
 * 入口在包内、文件在场、确实列在当前 pack 的供给 inventory（许可闭包）、实际 SHA 与 inventory 一致。
 * 任一不符返回 null（如实报 MODEL_NOT_BUNDLED）——**不扫描目录附近文件、不把 demo 入口当本体**。
 */
async function resolveBundledRobotModel(packRoot:string,declaredModel:string|null|undefined,supplyItem:any):Promise<{path:string;sha256:string}|null>{
 if(!declaredModel)return null
 const path=resolve(packRoot,declaredModel),inside=relative(packRoot,path)
 if(inside.startsWith('..')||inside.startsWith('/'))return null
 try{if(!(await stat(path)).isFile())return null}catch{return null}
 const inventoryPath=assetInventoryPath(declaredModel)
 const inventory=inventoryPath?supplyItem?.files?.find((file:any)=>file?.path===inventoryPath):undefined
 if(!inventory||typeof inventory.sha256!=='string')return null
 let actual:string
 try{actual=await sha256File(path)}catch{return null}
 return actual===inventory.sha256?{path,sha256:actual}:null
}
/**
 * 官方预览图与本体同一套纪律：只认 `pack.json` 的 `asset.preview` 显式登记（包相对路径，必须在 asset/ 下、
 * 是已知位图扩展名），且该件必须列在当前供给 inventory、实际 SHA 与登记一致——不扫描 asset/ 目录猜图。
 * 任一不符返回 null：库行如实回落占位图标，详情页如实回落实时预览/提示，不拿错字节冒充官方图。
 */
async function resolveBundledPreview(packRoot:string,declaredPreview:string|null,supplyItem:any):Promise<string|null>{
 if(!declaredPreview)return null
 const path=resolve(packRoot,declaredPreview),inside=relative(packRoot,path)
 if(inside.startsWith('..')||inside.startsWith('/'))return null
 if(!/\.(?:png|jpe?g|webp)$/i.test(inside))return null
 const inventoryPath=assetInventoryPath(declaredPreview)
 const inventory=inventoryPath?supplyItem?.files?.find((file:any)=>file?.path===inventoryPath):undefined
 if(!inventory||typeof inventory.sha256!=='string')return null
 try{if(!(await stat(path)).isFile())return null}catch{return null}
 try{return (await sha256File(path))===inventory.sha256?path:null}catch{return null}
}
export async function robotLibraryRows(productRoot:string,scene?:SceneOperations,policies:DefaultRobotPolicy[]=[]):Promise<RobotLibraryRow[]>{
 const packs=join(productRoot,'packs'),roster=JSON.parse(await readFile(join(packs,'t0-roster.json'),'utf8')) as T0Roster
 const registry=JSON.parse(await readFile(join(packs,'registry.json'),'utf8'))
 const supply=await readFile(join(packs,'default-t0-supply.json'),'utf8').then(JSON.parse,()=>({models:[]}))
 const resources=scene?await scene.resources.list():[]
 return Promise.all(roster.packs.map(async entry=>{
  lookupPackTier(roster,registry,entry.packId)
  const root=join(packs,entry.packId),pack=JSON.parse(await readFile(join(root,'pack.json'),'utf8')),contract=await inspectPack(root)
  const item=supply.models.find((row:any)=>row.packId===entry.packId)
  const defaultPolicy=policies.find(row=>row.packId===entry.packId),prepared=defaultPolicy?.prepared
  // 本体来源唯一：已准备 policy 用它已核验的 adapter 模型（保留精确模型/策略身份与 SHA）；
  // 否则用 pack 显式声明的 asset.model 并过供给 inventory/SHA 复核。modelBytes 是整包供给体积，
  // 不是该 XML 自身的字节数（UI 明示为“依赖包体积”，不把 XML 大小伪称全模型大小）。
  let modelPath:string|null=null,modelSha256:string|null=null
  if(prepared){modelPath=prepared.adapter.modelPath;modelSha256=prepared.adapter.modelSha256??null}
  else{
   // 优先 `asset.model`；pack 完全未声明 asset 时只退回供给已登记入口（不做目录扫描/文件名猜测），
   // 两种来源都仍要过 inventory/SHA 复核，所以 demo 入口（如 scene_left.xml）不会被当成本体。
   const declared=declaredAssetEntries(pack)
   const resolved=await resolveBundledRobotModel(root,declared?.model??item?.modelEntry??null,item)
   modelPath=resolved?.path??null;modelSha256=resolved?.sha256??null
  }
  // 官方预览图与本体同口径：显式登记 + 供给 inventory/SHA 复核；没有登记或复核不过就是 null。
  const previewPath=await resolveBundledPreview(root,declaredAssetPreview(pack),item)
  // 已有 T0 资源按**本体/适配器来源与原始字节身份**选取，绝不凭 pack tag 取错误 demo 第一条：
  // prepared 同时认 adapter 与精确入口 SHA，其余认入口 SHA；选不中就是未登记（旧 demo 资源保留但不冒充本体）。
  const matching=resources.filter(row=>row.folder==='T0 机器人示例'&&row.tags?.includes('pack:'+entry.packId))
  const resource=prepared
   ? matching.find(row=>matchesPreparedIdentity(row,prepared))
   : modelSha256?matching.find(row=>resourceEntrySha(row)===modelSha256):undefined
  let sourceDof:number|null=null
  if(modelPath)try{
   const visual=await robotVisual(modelPath),document=visual.document as any
   const list=(value:any)=>value===undefined?[]:Array.isArray(value)?value:[value]
   const count=(body:any):number=>list(body?.joint).reduce((n:number,j:any)=>n+(j.type==='ball'?3:j.type==='free'?6:1),0)+list(body?.freejoint).length*6+list(body?.body).reduce((n:number,b:any)=>n+count(b),0)
   sourceDof=visual.format==='mjcf'?list(document.worldbody?.body).reduce((n:number,b:any)=>n+count(b),0):list(document.joint).reduce((n:number,j:any)=>n+(j.type==='fixed'?0:j.type==='floating'?6:j.type==='planar'?3:1),0)
  }catch{}
  const policy=await readFile(join(root,'policy/manifest.json'),'utf8').then(JSON.parse,()=>null)
  return {packId:entry.packId,version:pack.version,family:pack.family,tier:'T0',source:pack.provenance?.source??'',license:item?.license??pack.license?.model??'LICENSE_UNVERIFIED',policyLicense:String(pack.license?.policy??'LICENSE_UNVERIFIED'),modelPath,modelBytes:item?.bytes??null,modelSha256,installed:!!resource,resourceId:resource?.ref.resourceId??null,previewPath,policyStatus:defaultPolicy?.status??(['requiresPolicy','requiresExternalController'].includes(pack.capabilities?.directControl)?'BLOCKED':'none'),policyVariant:defaultPolicy?.variant??null,policyDetail:defaultPolicy?.detail??(pack.capabilities?.directControl==='requiresExternalController'?'EXTERNAL_CONTROLLER_NOT_INTEGRATED':pack.capabilities?.directControl==='requiresPolicy'&&!defaultPolicy?'DEFAULT_POLICY_NOT_SUPPLIED':null),sourceDof,policyDof:typeof policy?.action?.dim==='number'?policy.action.dim:null,channels:pack.capabilities?.channels??[],control:pack.capabilities?.directControl??'CONTROL_UNDECLARED',mode:contract.mode,adapterReady:contract.adapterReady,behaviorVerified:contract.behaviorVerified,gaps:[...modelPath?[]:['MODEL_NOT_BUNDLED'],...contract.issues.map(row=>row.code)]}
 }))
}
/** 只登记许可已核对的发行示例；去重/版本/原件闭包均由原 ResourceLibrary 拥有。 */
export async function ensureDefaultRobotLibrary(productRoot:string,scene:SceneOperations,policies:DefaultRobotPolicy[]=[]){
 const rows=await robotLibraryRows(productRoot,scene,policies),registered:string[]=[],blocked:Array<{packId:string;detail:string}>=[]
 for(const row of rows){
  const policy=policies.find(policy=>policy.packId===row.packId),prepared=policy?.prepared
  if(!row.modelPath)continue
  if(row.installed&&!prepared)continue
  if(prepared&&(await scene.resources.list()).some(resource=>resource.folder==='T0 机器人示例'&&resource.tags?.includes('pack:'+row.packId)&&matchesPreparedIdentity(resource,prepared)))continue
  try{await scene.resources.import({path:row.modelPath,name:row.packId+(prepared?' · '+policy!.variant:''),...prepared?{components:prepared.components}:{},folder:'T0 机器人示例',tags:['T0','pack:'+row.packId,'产品示例'],license:{id:row.license,source:'file',attribution:row.source},physicalizationRequest:false});registered.push(row.packId)}
  catch(error){blocked.push({packId:row.packId,detail:error instanceof Error?error.message:String(error)})}
 }
 return {registered,blocked,models:await robotLibraryRows(productRoot,scene,policies)}
}

export type DefaultRobotLibraryInitialization=Awaited<ReturnType<typeof ensureDefaultRobotLibrary>>&{
 status:'READY'|'BLOCKED'|'SKIPPED';code?:'DEFAULT_ROBOT_LIBRARY_BLOCKED'
}
/** 可选示例不能拒绝普通Scene入口；失败回执缓存到用户刷新，刷新复用同一在途任务。 */
export function createDefaultRobotLibraryInitializer(
 initialize:(key:string,operations:SceneOperations)=>Promise<Awaited<ReturnType<typeof ensureDefaultRobotLibrary>>|undefined>,
 warn:(detail:string)=>void,
){
 const entries=new Map<string,{pending:boolean;promise:Promise<DefaultRobotLibraryInitialization>}>()
 return (key:string,operations:SceneOperations,retry=false):Promise<DefaultRobotLibraryInitialization>=>{
  const previous=entries.get(key)
  if(previous&&(!retry||previous.pending))return previous.promise
  const entry={pending:true,promise:undefined as unknown as Promise<DefaultRobotLibraryInitialization>}
  entry.promise=Promise.resolve().then(()=>initialize(key,operations)).then((value):DefaultRobotLibraryInitialization=>value
   ?{...value,status:value.blocked.length?'BLOCKED':'READY',...value.blocked.length?{code:'DEFAULT_ROBOT_LIBRARY_BLOCKED' as const}:{}}
   :{status:'SKIPPED',registered:[],blocked:[],models:[]}
  ).catch((error):DefaultRobotLibraryInitialization=>{
   const detail=error instanceof Error?error.message:String(error)
   try{warn('DEFAULT_ROBOT_LIBRARY_BLOCKED: '+detail)}catch{}
   return {status:'BLOCKED',code:'DEFAULT_ROBOT_LIBRARY_BLOCKED',registered:[],blocked:[{packId:'default-library',detail}],models:[]}
  }).finally(()=>{entry.pending=false})
  entries.set(key,entry)
  return entry.promise
 }
}
