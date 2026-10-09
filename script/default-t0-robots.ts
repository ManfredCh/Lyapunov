/** 发行内置示例：只从显式本地 staging 收取件；不联网、不保存用户场景。 */
import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {hashFile} from '../packages/policy-registry/src/source.ts'
import {lookupPackTier,type T0Roster} from '../packages/policy-registry/src/tier-roster.ts'
const allowed=new Set(['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause'])
export async function stageDefaultT0Robots(root:string,stage:string,sourceRoot:string){
 const roster=JSON.parse(await readFile(join(root,'packs/t0-roster.json'),'utf8')) as T0Roster,registry=JSON.parse(await readFile(join(root,'packs/registry.json'),'utf8'))
 await mkdir(join(stage,'packs'),{recursive:true})
 for(const file of ['registry.json','t0-roster.json'])await cp(join(root,'packs',file),join(stage,'packs',file))
 const models:any[]=[],blocked:any[]=[]
 for(const entry of roster.packs){
  lookupPackTier(roster,registry,entry.packId)
  const current=JSON.parse(await readFile(join(root,'packs',entry.packId,'pack.json'),'utf8')),ref=current.pieces.asset.ref?.split('#'),sourcePack=join(sourceRoot,'packs',entry.packId),destination=join(stage,'packs',entry.packId)
  await mkdir(destination,{recursive:true});await cp(join(root,'packs',entry.packId,'pack.json'),join(destination,'pack.json'))
  for(const piece of ['context','policy','vla','tests'])try{await cp(join(sourcePack,piece),join(destination,piece),{recursive:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  // 这些模型只作按需入口：当前没有对应基础运动，不伪装默认可控示例。
  if(['unitree_a1','generic_quadrotor'].includes(entry.packId)){blocked.push({packId:entry.packId,code:'BASIC_CONTROL_NOT_ADAPTED'});continue}
  try{
   if(!ref||ref[1]!==entry.packId||!/^ASSET_STAGING_MANIFEST[^/]*\.json$/.test(ref[0]))throw Error('ASSET_SOURCE_MANIFEST_REQUIRED')
   let manifest=JSON.parse(await readFile(join(sourceRoot,'packs',ref[0]),'utf8'))[entry.packId]
   let assetRoot=join(sourcePack,'asset')
   if(entry.packId==='unitree_go1'){
    // 整包旧台账 UNVERIFIED，使用既有固定 Menagerie XML 闭包及 LICENSE 精确件；不带 URDF。
    const fixed=JSON.parse(await readFile(join(root,'script/prepare-viewer-test-assets.manifest.json'),'utf8'))
    assetRoot=join(sourceRoot,fixed.destination)
    manifest={origin:fixed.repository+'@'+fixed.commit+'#'+fixed.upstreamPath,license:fixed.license.spdx,files:[...fixed.files.map((file:any)=>({path:file.destinationPath,bytes:file.bytes,sha256:file.sha256})),{path:fixed.license.destinationPath,bytes:fixed.license.bytes,sha256:fixed.license.sha256}]}
   }
   if(!manifest||!allowed.has(manifest.license))throw Error('MODEL_REDISTRIBUTION_LICENSE_UNVERIFIED')
   let bytes=0
   for(const file of manifest.files){const path=resolve(assetRoot,file.path),inside=relative(assetRoot,path);if(inside.startsWith('..')||inside.startsWith('/'))throw Error('MODEL_MANIFEST_PATH_INVALID');const actual=await hashFile(path);if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw Error('MODEL_SOURCE_MISMATCH: '+file.path);bytes+=actual.bytes}
   if(!(await stat(join(assetRoot,current.asset.modelEntry.replace(/^asset\//,'')))).isFile())throw Error('MODEL_ENTRY_MISSING')
   await mkdir(join(destination,'asset'),{recursive:true})
   // 仅复制台账精确件，不把 staging 的额外用户文件带进包。
   for(const file of manifest.files){await mkdir(join(destination,'asset',file.path,'..'),{recursive:true});await cp(join(assetRoot,file.path),join(destination,'asset',file.path))}
   const identity=await hashFile(join(destination,current.asset.modelEntry))
   models.push({packId:entry.packId,version:current.version,modelEntry:current.asset.modelEntry,bytes,entrySha256:identity.sha256,license:manifest.license,origin:manifest.origin,sourceManifest:ref[0]+'#'+ref[1],files:manifest.files})
  }catch(error){blocked.push({packId:entry.packId,code:error instanceof Error?error.message:String(error)})}
 }
 const supply={schemaVersion:1,scope:'default-t0-model-examples',models,blocked,weightsBundled:false,note:'模型和策略独立；权重不在未核实许可及闭包时随包。原 ResourceLibrary 负责登记。'}
 await writeFile(join(stage,'packs/default-t0-supply.json'),JSON.stringify(supply,null,2)+'\n')
 return supply
}
