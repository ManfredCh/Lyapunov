/** 固定策略原件进入发行包；只取原 cache manifest 精确件，不打包构建机 derived 或Python前缀。 */
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {verifyPolicy} from '../packages/policy-registry/src/adapter.ts'
import {verifyRegisteredPolicyFiles} from '../packages/policy-registry/src/local-policy-source.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from '../packages/policy-registry/src/pack-contract.ts'
import {hashFile,policyDirectory,policyFile,type PolicyManifest} from '../packages/policy-registry/src/source.ts'
export const DEFAULT_ROBOT_POLICY_IDS=['wtw-go1-torchscript-v1','unitree-g1-12dof-v1','inria-go2-onnx-v1']
export async function stageDefaultRobotPolicies(root:string,stage:string,sourceDirectory:string){
 const entries:any[]=[],allowedFiles:string[]=[],blocked:Array<Record<string,string>>=[]
 for(const id of DEFAULT_ROBOT_POLICY_IDS){
  const pin=IMPLEMENTED_POLICY_ADAPTERS.find(row=>row.id===id)!,identity={provider:'github' as const,modelId:pin.modelId,revision:pin.revision},verified=await verifyPolicy(sourceDirectory,identity)
  if(!verified.valid||!verified.manifest)throw Error('DEFAULT_POLICY_SOURCE_MISSING: '+id)
  if((await verifyRegisteredPolicyFiles(verified.root,identity)).some(row=>!row.valid))throw Error('DEFAULT_POLICY_PIN_MISMATCH: '+id)
  const license=verified.manifest.files.find(file=>file.path==='LICENSE')
  if(!license){blocked.push({adapterId:id,packId:pin.packs[0],provider:'github',modelId:pin.modelId,revision:pin.revision,modelVariant:'menagerie-go2',code:'DEFAULT_POLICY_LICENSE_MISSING'});continue}
  const text=await readFile(join(verified.root,'LICENSE'),'utf8'),spdx=text.startsWith('MIT License')?'MIT':text.includes('BSD 3-Clause License')?'BSD-3-Clause':null
  if(!spdx)throw Error('DEFAULT_POLICY_LICENSE_UNVERIFIED: '+id)
  const destination=policyDirectory(join(stage,'packs/default-policies'),identity.provider,identity.modelId,identity.revision),files=[]
  for(const file of verified.manifest.files){const path=policyFile(file.path);await mkdir(join(destination,path,'..'),{recursive:true});await cp(join(verified.root,path),join(destination,path));const actual=await hashFile(join(destination,path),file.gitBlob?file.bytes:undefined);if(actual.bytes!==file.bytes||actual.sha256!==file.sha256||file.gitBlob&&actual.gitBlob!==file.gitBlob)throw Error('DEFAULT_POLICY_COPY_CHANGED: '+id+'/'+path);files.push(file);allowedFiles.push(relative(stage,join(destination,path)))}
  const manifest:PolicyManifest={status:'DOWNLOADED',...identity,resolvedRevision:identity.revision,metadata:{robot:pin.packs[0],license:spdx,defaultProductSupply:true},sourceFiles:verified.manifest.sourceFiles,files,transfers:[],execution:{status:'BLOCKED',reason:'需在目标机器按原prepare核对运行时与正确模型后显式执行'},updatedAt:new Date().toISOString()}
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  entries.push({adapterId:id,packId:pin.packs[0],...identity,license:spdx,licenseSha256:license.sha256,files,bytes:files.reduce((sum,file)=>sum+file.bytes,0),robotModel:id==='unitree-g1-12dof-v1'?null:join('packs',pin.packs[0],JSON.parse(await readFile(join(root,'packs',pin.packs[0],'pack.json'),'utf8')).asset.modelEntry),modelVariant:id==='unitree-g1-12dof-v1'?'official-g1-12dof':id==='wtw-go1-torchscript-v1'?'menagerie-go1':'menagerie-go2'})
 }
 await writeFile(join(stage,'packs/default-policy-supply.json'),JSON.stringify({schemaVersion:1,entries,blocked},null,2)+'\n')
 return {entries,allowedFiles,blocked}
}
