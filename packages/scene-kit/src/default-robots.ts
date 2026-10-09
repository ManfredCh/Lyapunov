/** 机器人库是 pack / T0 / ResourceLibrary 的薄投影，不保存第二份索引。 */
import {readFile,stat} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {inspectPack} from '../../policy-registry/src/pack-contract.ts'
import {lookupPackTier,type T0Roster} from '../../policy-registry/src/tier-roster.ts'
import {robotVisual} from './formats.ts'
import type {DefaultRobotPolicy} from '../../policy-registry/src/default-robot-policies.ts'
import type {SceneOperations} from './operations.ts'

export interface RobotLibraryRow {
 packId:string;version:string;family:string;tier:'T0';source:string;license:string;policyLicense:string
 modelPath:string|null;modelBytes:number|null;modelSha256:string|null;installed:boolean;resourceId:string|null
 policyStatus:'PREPARED'|'BLOCKED'|'none';policyVariant:string|null;policyDetail:string|null;sourceDof:number|null;policyDof:number|null;channels:string[];control:string;mode:string|null;adapterReady:boolean;behaviorVerified:boolean;gaps:string[]
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
  let modelPath:string|null=null
  if(item?.modelEntry){const path=resolve(root,item.modelEntry),inside=relative(root,path);if(!inside.startsWith('..')&&!inside.startsWith('/'))try{if((await stat(path)).isFile())modelPath=path}catch{}}
  const defaultPolicy=policies.find(row=>row.packId===entry.packId)
  const matching=resources.filter(row=>row.folder==='T0 机器人示例'&&row.tags?.includes('pack:'+entry.packId))
  const resource=matching.find(row=>row.componentDefaults?.controller?.policyAdapter===defaultPolicy?.prepared?.adapter.adapter)??matching[0]
  if(defaultPolicy?.prepared)modelPath=defaultPolicy.prepared.adapter.modelPath
  let sourceDof:number|null=null
  if(modelPath)try{
   const visual=await robotVisual(modelPath),document=visual.document as any
   const list=(value:any)=>value===undefined?[]:Array.isArray(value)?value:[value]
   const count=(body:any):number=>list(body?.joint).reduce((n:number,j:any)=>n+(j.type==='ball'?3:j.type==='free'?6:1),0)+list(body?.freejoint).length*6+list(body?.body).reduce((n:number,b:any)=>n+count(b),0)
   sourceDof=visual.format==='mjcf'?list(document.worldbody?.body).reduce((n:number,b:any)=>n+count(b),0):list(document.joint).reduce((n:number,j:any)=>n+(j.type==='fixed'?0:j.type==='floating'?6:j.type==='planar'?3:1),0)
  }catch{}
  const policy=await readFile(join(root,'policy/manifest.json'),'utf8').then(JSON.parse,()=>null)
  return {packId:entry.packId,version:pack.version,family:pack.family,tier:'T0',source:pack.provenance?.source??'',license:item?.license??pack.license?.model??'LICENSE_UNVERIFIED',policyLicense:String(pack.license?.policy??'LICENSE_UNVERIFIED'),modelPath,modelBytes:item?.bytes??null,modelSha256:defaultPolicy?.prepared?.adapter.modelSha256??item?.entrySha256??null,installed:!!resource,resourceId:resource?.ref.resourceId??null,policyStatus:defaultPolicy?.status??(['requiresPolicy','requiresExternalController'].includes(pack.capabilities?.directControl)?'BLOCKED':'none'),policyVariant:defaultPolicy?.variant??null,policyDetail:defaultPolicy?.detail??(pack.capabilities?.directControl==='requiresExternalController'?'EXTERNAL_CONTROLLER_NOT_INTEGRATED':pack.capabilities?.directControl==='requiresPolicy'&&!defaultPolicy?'DEFAULT_POLICY_NOT_SUPPLIED':null),sourceDof,policyDof:typeof policy?.action?.dim==='number'?policy.action.dim:null,channels:pack.capabilities?.channels??[],control:pack.capabilities?.directControl??'CONTROL_UNDECLARED',mode:contract.mode,adapterReady:contract.adapterReady,behaviorVerified:contract.behaviorVerified,gaps:[...modelPath?[]:['MODEL_NOT_BUNDLED'],...contract.issues.map(row=>row.code)]}
 }))
}
/** 只登记许可已核对的发行示例；去重/版本/原件闭包均由原 ResourceLibrary 拥有。 */
export async function ensureDefaultRobotLibrary(productRoot:string,scene:SceneOperations,policies:DefaultRobotPolicy[]=[]){
 const rows=await robotLibraryRows(productRoot,scene,policies),registered:string[]=[],blocked:Array<{packId:string;detail:string}>=[]
 for(const row of rows){
  const policy=policies.find(policy=>policy.packId===row.packId),prepared=policy?.prepared
  if(!row.modelPath)continue
  if(row.installed&&!prepared)continue
  if(prepared&&(await scene.resources.list()).some(resource=>resource.folder==='T0 机器人示例'&&resource.tags?.includes('pack:'+row.packId)&&resource.componentDefaults?.controller?.policyAdapter===prepared.adapter.adapter))continue
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
