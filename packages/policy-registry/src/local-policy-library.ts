import {copyFile,mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises'
import {basename,dirname,extname,join,resolve} from 'node:path'
import {hashFile,policyFile,type PolicyManifest} from './source.ts'
import {inspectLocalPolicyFile} from './local-policy-file.ts'
import {localPolicyFileKind,type LocalPolicyLibraryEntry} from './local-policy-file-contract.ts'
import type {LocalPolicySource} from './local-policy-source.ts'
import {robotDownloadPreflight,type RobotDownloadManifest} from './robot-download.ts'

/** 用户明确选中的目录只读根 bundle.json，不递归查找或从机器人原件推断策略。 */
export async function resolveLocalPolicyPath(path:string):Promise<string>{
 const selected=resolve(path)
 let info;try{info=await stat(selected)}catch{throw Error('POLICY_FILE_MISSING: 选定文件或目录不存在')}
 if(info.isDirectory()){
  const bundle=join(selected,'bundle.json')
  try{if((await stat(bundle)).isFile())return bundle}catch{}
  throw Error('POLICY_BUNDLE_REQUIRED: 该目录根缺 bundle.json；请选择明确策略权重，或补齐包含来源、观测与动作映射的 bundle.json')
 }
 if(!info.isFile()||!localPolicyFileKind(selected))throw Error('POLICY_FILE_FORMAT_UNSUPPORTED: 请选择 bundle.json、支持的权重或含 bundle.json 的完整目录')
 return selected
}

export async function readLocalPolicyBundle(path:string):Promise<unknown>{
 if((await stat(path)).size>4*1024*1024)throw Error('POLICY_LOCAL_PACKAGE_INVALID: bundle.json 超过 4 MiB')
 try{return JSON.parse(await readFile(path,'utf8'))}catch{throw Error('POLICY_LOCAL_PACKAGE_INVALID: bundle.json 不是合法 JSON')}
}
/** 先汇总本地完整闭包与字节缺项；失败前不触碰原库。分发许可另列，不伪称可运行。 */
export async function verifyLocalPolicyBundle(root:string,manifest:RobotDownloadManifest):Promise<void>{
 const preflight=robotDownloadPreflight(manifest),missing=[...preflight.missingFiles],changed:string[]=[]
 for(const file of manifest.files){
  try{const actual=await hashFile(join(root,file.path),file.gitBlob?file.bytes:undefined);if(actual.bytes!==file.bytes||actual.sha256!==file.sha256||file.gitBlob&&actual.gitBlob!==file.gitBlob)changed.push(file.path)}catch{missing.push(file.path)}
 }
 if(missing.length)throw Error('POLICY_DEPENDENCY_MISSING: 完整目录缺文件：'+[...new Set(missing)].join('、'))
 if(changed.length)throw Error('POLICY_LOCAL_PACKAGE_SOURCE_MISMATCH: 本地文件字节与清单不符：'+changed.join('、'))
 if(preflight.unknownAdapter||preflight.wrongSource)throw Error('POLICY_ADAPTER_REQUIRED: bundle 的来源与观测/动作适配器未登记或不匹配')
}

type StoredEntry=Omit<LocalPolicyLibraryEntry,'filePath'|'available'>&{entryPath:string}
const persist=async(path:string,value:unknown)=>{
 const temporary=path+'.register-'+crypto.randomUUID()
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temporary,path)}finally{await rm(temporary,{force:true})}
}
/** 登记信息与既有缓存 manifest 同存，不写场景、实例、世界或第二份库索引。 */
export async function recordLocalPolicyEntry(cacheRoot:string,entryPath:string,selectedPath:string,source:LocalPolicySource):Promise<LocalPolicyLibraryEntry>{
 policyFile(entryPath)
 const path=join(cacheRoot,'manifest.json'),manifest=JSON.parse(await readFile(path,'utf8')) as PolicyManifest
 const prior=manifest.metadata?.localImport as StoredEntry|undefined
 const missingLicense=source.missingLicense??prior?.missingLicense
 const fixed=source.identity?.provider&&source.identity.revision?{provider:source.identity.provider,modelId:source.identity.modelId,revision:source.identity.revision}:undefined
 const id=fixed&&basename(dirname(cacheRoot))!=='local'?`${fixed.provider}/${fixed.modelId}@${fixed.revision}`:'local/'+basename(cacheRoot)
 const stored:StoredEntry={id,label:prior?.label??(localPolicyFileKind(selectedPath)==='bundle'?basename(dirname(selectedPath)):basename(selectedPath)),entryPath,registeredAt:prior?.registeredAt??new Date().toISOString(),sourceBytesVerified:source.sourceBytesVerified,...fixed?{identity:fixed}:{},...source.adapterId?{adapterId:source.adapterId}:{},...missingLicense?.length?{missingLicense}:{}}
 await persist(path,{...manifest,metadata:{...manifest.metadata,localImport:stored}})
 return {...stored,filePath:join(cacheRoot,entryPath),available:true}
}

/** 未识别权重只保原件与格式事实；本地内容指纹不是模型或适配器身份。 */
export async function registerLocalPolicyWeights(dataDirectory:string,path:string,signal:AbortSignal,source:LocalPolicySource={status:'unidentified',sourceBytesVerified:false,prepareFrom:'unsupported'}):Promise<LocalPolicyLibraryEntry>{
 const fact=await inspectLocalPolicyFile(path)
 if(!fact.valid)throw Error(`${fact.code}: ${fact.detail}`)
 signal.throwIfAborted()
 const actual=await hashFile(path),cacheRoot=join(resolve(dataDirectory),'policies','local',actual.sha256),entryPath='weights'+extname(path).toLowerCase()
 await mkdir(cacheRoot,{recursive:true,mode:0o700})
 const target=join(cacheRoot,entryPath),temporary=target+'.register-'+crypto.randomUUID()
 try{
  await copyFile(path,temporary);const copied=await hashFile(temporary)
  if(copied.bytes!==actual.bytes||copied.sha256!==actual.sha256)throw Error('POLICY_LOCAL_FILE_CHANGED: 所选权重在登记期间改变，请重新选择')
  signal.throwIfAborted();await rename(temporary,target)
 }finally{await rm(temporary,{force:true})}
 const manifestPath=join(cacheRoot,'manifest.json')
 let previous:{metadata?:Record<string,unknown>};try{previous=JSON.parse(await readFile(manifestPath,'utf8'))}catch{previous={}}
 // provider=local 只标缓存原件来源，不赋公共 modelId；既有 prepare/activate 仍无可用 identity。
 const file={path:entryPath,bytes:actual.bytes,sha256:actual.sha256,revision:'local',url:''}
 await persist(manifestPath,{status:'DOWNLOADED',provider:'local',metadata:{...previous.metadata,localFormat:fact.format},sourceFiles:[],files:[file],transfers:[],execution:{status:'BLOCKED',reason:'本地权重已登记；来源、观测、动作与本体适配未验证'},updatedAt:new Date().toISOString()})
 return recordLocalPolicyEntry(cacheRoot,entryPath,path,source)
}

/** 仅枚举本 owner 的既有缓存层级和登记元数据，不扫描用户策略目录、不联网。 */
export async function listLocalPolicyEntries(dataDirectory:string):Promise<LocalPolicyLibraryEntry[]>{
 const entries:LocalPolicyLibraryEntry[]=[],base=join(resolve(dataDirectory),'policies')
 const visit=async(directory:string,depth:number):Promise<void>=>{
  let children;try{children=await readdir(directory,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  if(children.some(child=>child.isFile()&&child.name==='manifest.json')){
   const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as {metadata?:{localImport?:StoredEntry}}
   const stored=manifest.metadata?.localImport
   if(stored){
    if(typeof stored.id!=='string'||typeof stored.label!=='string'||typeof stored.registeredAt!=='string')throw Error('POLICY_LOCAL_REGISTRY_INVALID: 本地登记元数据不完整')
    const filePath=join(directory,policyFile(stored.entryPath))
    let available=false;try{available=(await stat(filePath)).isFile()}catch{}
    entries.push({...stored,filePath,available})
   }
   return
  }
  if(depth<3)for(const child of children)if(child.isDirectory())await visit(join(directory,child.name),depth+1)
 }
 await visit(base,0)
 return entries.sort((a,b)=>b.registeredAt.localeCompare(a.registeredAt)||a.id.localeCompare(b.id))
}
