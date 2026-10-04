import {readFile,stat} from 'node:fs/promises'
import {join,resolve,sep} from 'node:path'
import {hashFile,policyFile} from './source.ts'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'
import {G1_23_75_ID} from './g1-23-75.ts'
import type {PolicyIdentity} from './adapter.ts'
import type {RobotDownloadManifest} from './robot-download.ts'

export interface LocalPolicySource {
 status:'registered-package'|'registered-weights'|'unidentified'
 identity?:PolicyIdentity;adapterId?:string;packageRoot?:string;bundlePath?:string;selectedRelativePath?:string
 sourceBytesVerified:boolean;prepareFrom:'bundle'|'cache'|'weights'|'unsupported'
 bundleDownloadReady?:boolean;missingLicense?:string[];supportedEngines?:string[]
 licenseUnchecked?:boolean
}
const identityOf=(pin:typeof IMPLEMENTED_POLICY_ADAPTERS[number]):PolicyIdentity=>({provider:'github',modelId:pin.modelId,revision:pin.revision})
const same=(a:PolicyIdentity,b:PolicyIdentity)=>a.provider===b.provider&&a.modelId===b.modelId&&a.revision===b.revision
export async function verifyRegisteredPolicyFiles(root:string,identity:PolicyIdentity):Promise<Array<{path:string;valid:boolean}>>{
 const pin=identity.provider==='github'?IMPLEMENTED_POLICY_ADAPTERS.find(p=>p.modelId===identity.modelId&&p.revision===identity.revision):undefined
 const checks=[]
 for(const [path,expected]of Object.entries(pin?.requires.integrity??{})){
  try{const actual=await hashFile(join(root,path),expected.gitBlob?expected.bytes:undefined);checks.push({path,valid:actual.bytes===expected.bytes&&actual.sha256===expected.sha256&&(!expected.gitBlob||actual.gitBlob===expected.gitBlob)})}catch{checks.push({path,valid:false})}
 }
 return checks
}
/** 仅用登记的完整相对路径派生根，并读取该一个bundle；不glob/readdir/上溯搜索目录。 */
export async function resolveLocalPolicySource(filePath:string,declared?:PolicyIdentity):Promise<{source:LocalPolicySource;manifest?:RobotDownloadManifest}>{
 const absolute=resolve(filePath),unknown:LocalPolicySource={status:'unidentified',sourceBytesVerified:false,prepareFrom:'unsupported'}
 let info
 try{info=await stat(absolute);if(!info.isFile())return {source:unknown}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {source:unknown};throw error}
 const pins=IMPLEMENTED_POLICY_ADAPTERS
 for(const pin of pins)for(const relative of pin.requires.files){
  const suffix=sep+relative.split('/').join(sep)
  if(!absolute.endsWith(suffix))continue
  const packageRoot=absolute.slice(0,-suffix.length)||sep,bundlePath=join(packageRoot,'bundle.json')
  let manifest:RobotDownloadManifest|undefined
  try{const s=await stat(bundlePath);if(!s.isFile()||s.size>4*1024*1024)throw Error('POLICY_LOCAL_PACKAGE_INVALID');manifest=JSON.parse(await readFile(bundlePath,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(!manifest)continue
  if(!['robot-download/v1','g1-policy-download/v1'].includes(manifest.schema)||manifest.serverSideInference!==false||manifest.source?.provider!=='github'||manifest.source.modelId!==pin.modelId||manifest.source.resolvedRevision!==pin.revision||manifest.adapter?.id!==pin.id||!Array.isArray(manifest.files))throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: 所选文件的登记包身份不一致')
  const selected=manifest.files.find(f=>f.path===relative)
  if(!selected)throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: bundle未登记所选文件')
  const actual=await hashFile(absolute,selected.gitBlob?selected.bytes:undefined),expected=pin.requires.integrity?.[relative]
  if(actual.bytes!==selected.bytes||actual.sha256!==selected.sha256||selected.gitBlob&&actual.gitBlob!==selected.gitBlob||expected&&(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256))throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: 所选文件字节与固定来源不符')
  const source:LocalPolicySource={status:'registered-package',identity:identityOf(pin),adapterId:pin.id,packageRoot,bundlePath,selectedRelativePath:relative,sourceBytesVerified:Boolean(expected),prepareFrom:pin.id===G1_23_75_ID?'weights':'bundle',bundleDownloadReady:manifest.downloadReady,missingLicense:manifest.missingLicense??[],supportedEngines:pin.id===G1_23_75_ID?['mujoco']:['mujoco','isaac']}
  if(declared&&!same(source.identity!,declared))throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: 所选来源与文件固定身份不同')
  return {source,manifest}
 }
 // 原件可被用户明确重命名；只对登记的小文件大小算指纹，不按名字猜来源或扫附近目录。
 for(const pin of pins)for(const [path,expected]of Object.entries(pin.requires.integrity??{})){
  if(expected.bytes!==info.size)continue
  const actual=await hashFile(absolute)
  if(actual.sha256!==expected.sha256)continue
  if(declared&&!same(identityOf(pin),declared))throw Error('POLICY_LOCAL_SOURCE_MISMATCH: 所选来源与文件固定身份不同')
  return {source:{status:'registered-weights',identity:identityOf(pin),adapterId:pin.id,selectedRelativePath:policyFile(path),sourceBytesVerified:true,prepareFrom:pin.id===G1_23_75_ID?'weights':'cache',supportedEngines:pin.id===G1_23_75_ID?['mujoco']:['mujoco','isaac']}}
 }
 return {source:unknown}
}
