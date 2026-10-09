/** 首启供给复用 policyDirectory/verifyPolicy/preparePolicy；没有第二份cache或执行器。 */
import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {preparePolicy,verifyPolicy,type PreparedAdapter} from './adapter.ts'
import {hashFile,policyDirectory,policyFile,type PolicyManifest} from './source.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'
import type {PolicyRuntimeConfig} from './runtime.ts'
export interface DefaultRobotPolicy {packId:string;adapterId:string;provider:'github';modelId:string;revision:string;variant:string;status:'PREPARED'|'BLOCKED';detail?:string;prepared?:{adapter:PreparedAdapter;components:Record<string,any>;worldOptions:Record<string,any>}}
export interface PolicyDefaults {prepare(refresh?:boolean):Promise<DefaultRobotPolicy[]>}
declare module '@deepseek-ai/cordis' {interface Context {policyDefaults:PolicyDefaults}}
export async function prepareDefaultRobotPolicies(productRoot:string,dataDirectory:string,runtime:PolicyRuntimeConfig={}):Promise<DefaultRobotPolicy[]>{
 const supply=await readFile(join(productRoot,'packs/default-policy-supply.json'),'utf8').then(JSON.parse,()=>null)
 if(!supply)return []
 const result:DefaultRobotPolicy[]=(supply.blocked??[]).map((entry:any)=>({packId:entry.packId,adapterId:entry.adapterId,provider:entry.provider,modelId:entry.modelId,revision:entry.revision,variant:entry.modelVariant,status:'BLOCKED',detail:entry.code}))
 for(const entry of supply.entries){
  const row:DefaultRobotPolicy={packId:entry.packId,adapterId:entry.adapterId,provider:'github',modelId:entry.modelId,revision:entry.revision,variant:entry.modelVariant,status:'BLOCKED'}
  try{
   const pin=IMPLEMENTED_POLICY_ADAPTERS.find(pin=>pin.id===entry.adapterId&&pin.modelId===entry.modelId&&pin.revision===entry.revision&&pin.packs.includes(entry.packId))
   if(!pin)throw Error('DEFAULT_POLICY_IDENTITY_INVALID')
   const target=policyDirectory(dataDirectory,'github',entry.modelId,entry.revision),source=policyDirectory(join(productRoot,'packs/default-policies'),'github',entry.modelId,entry.revision)
   const existing=await verifyPolicy(dataDirectory,row)
   if(!existing.valid){
    // 只补缺少的固定原件；已有同名不符文件保留并阻断，不覆盖用户缓存。
    for(const file of entry.files){const path=policyFile(file.path),destination=join(target,path);let actual;try{actual=await hashFile(destination,file.gitBlob?file.bytes:undefined)}catch{}
     if(actual){if(actual.bytes!==file.bytes||actual.sha256!==file.sha256||file.gitBlob&&actual.gitBlob!==file.gitBlob)throw Error('DEFAULT_POLICY_CACHE_CONFLICT: '+path);continue}
     const original=await hashFile(join(source,path),file.gitBlob?file.bytes:undefined);if(original.bytes!==file.bytes||original.sha256!==file.sha256||file.gitBlob&&original.gitBlob!==file.gitBlob)throw Error('DEFAULT_POLICY_SUPPLY_CHANGED: '+path)
     await mkdir(join(destination,'..'),{recursive:true});await cp(join(source,path),destination,{errorOnExist:true,force:false})
    }
    try{if((await stat(join(target,'manifest.json'))).isFile())throw Error('DEFAULT_POLICY_MANIFEST_CONFLICT')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8')) as PolicyManifest;await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
   }
   const prepared=await preparePolicy(dataDirectory,{provider:'github',modelId:entry.modelId,revision:entry.revision,...entry.robotModel?{robotModelPath:join(productRoot,entry.robotModel)}:{}},runtime)
   row.status='PREPARED';row.prepared={adapter:prepared.adapter,components:prepared.components,worldOptions:prepared.worldOptions}
  }catch(error){row.detail=error instanceof Error?error.message:String(error)}
  result.push(row)
 }
 return result
}
