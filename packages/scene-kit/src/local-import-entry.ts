import {readFile,readdir,stat} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {XMLParser,XMLValidator} from 'fast-xml-parser'
import {localPolicyFileKind} from '../../policy-registry/src/local-policy-file-contract.ts'

export interface LocalImportPathResolution {path:string;kind:'file'|'robot-directory'|'policy-directory';entryName?:string}
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',parseAttributeValue:false})
function includedFiles(document:unknown,directory:string):string[]{
 if(Array.isArray(document))return document.flatMap(item=>includedFiles(item,directory))
 if(!document||typeof document!=='object')return []
 return Object.entries(document).flatMap(([key,value])=>{
  const includes=key==='include'?(Array.isArray(value)?value:[value]).flatMap(item=>typeof item?.file==='string'?[resolve(directory,item.file)]:[]):[]
  return [...includes,...includedFiles(value,directory)]
 })
}

/** 只解析用户明确拖入的目录根；原生登记仍由 scene_import / policy_load_local 各自负责。 */
export async function resolveLocalImportPath(path:string,signal?:AbortSignal):Promise<LocalImportPathResolution>{
 signal?.throwIfAborted()
 const local=path.startsWith('file:')?fileURLToPath(path):path
 const info=await stat(local)
 if(info.isFile())return {path,kind:'file'}
 if(!info.isDirectory())throw Error('LOCAL_IMPORT_FILE_OR_DIRECTORY_REQUIRED: 请拖入本地文件或目录')
 const entries=await readdir(local,{withFileTypes:true})
 if(entries.length>1024)throw Error('LOCAL_IMPORT_DIRECTORY_TOO_LARGE: 请直接选择机器人 URDF/MJCF/XML 入口文件')
 const bundle=entries.find(entry=>entry.isFile()&&entry.name.toLowerCase()==='bundle.json')
 if(bundle)return {path:join(local,bundle.name),kind:'policy-directory',entryName:bundle.name}
 const candidates:string[]=[],included=new Set<string>()
 for(const entry of entries){
  signal?.throwIfAborted()
  if(!entry.isFile()||!/\.(?:urdf|mjcf|xml)$/i.test(entry.name))continue
  const file=join(local,entry.name)
  if((await stat(file)).size>4*1024*1024)throw Error(`ROBOT_ENTRY_TOO_LARGE: ${entry.name}；请直接选择入口文件`)
  const source=await readFile(file,{encoding:'utf8',signal})
  if(XMLValidator.validate(source)!==true)throw Error(`ROBOT_ENTRY_XML_INVALID: ${entry.name}；请修正原生文档或直接选择另一个入口`)
  const document=parser.parse(source)
  for(const dependency of includedFiles(document,dirname(file)))included.add(dependency)
  if(document.mujoco!==undefined||document.robot!==undefined)candidates.push(file)
 }
 const roots=candidates.filter(file=>!included.has(resolve(file)))
 if(roots.length===1)return {path:roots[0]!,kind:'robot-directory',entryName:basename(roots[0]!)}
 if(candidates.length>0)throw Error(`ROBOT_ENTRY_SELECTION_REQUIRED: ${basename(path)} 含多个原生入口或循环 include（${(roots.length?roots:candidates).map(file=>basename(file)).join('、')}）；请拖入要使用的 URDF/MJCF/XML 文件`)
 if(entries.some(entry=>entry.isFile()&&localPolicyFileKind(entry.name)==='weights'))throw Error('POLICY_BUNDLE_REQUIRED: 策略目录缺少 bundle.json；请选择正规 bundle 或具体权重文件')
 throw Error(`ROBOT_ENTRY_REQUIRED: ${basename(path)} 的目录根没有原生 URDF/MJCF/XML 入口；请直接拖入机器人入口文件。STL/meshes 仅是依赖，不能登记为机器人`)
}

/** 目录选择缺项是只读解析结果；正式UI只拿文件名和原因，完整原路径仍留在Host。 */
export async function resolveLocalImportCommand(path:string,signal?:AbortSignal):Promise<LocalImportPathResolution|{kind:'blocked';reason:string}>{
 try{return await resolveLocalImportPath(path,signal)}
 catch(error){
  const message=error instanceof Error?error.message:String(error)
  if(/^(?:ROBOT_ENTRY_|POLICY_BUNDLE_REQUIRED:|LOCAL_IMPORT_DIRECTORY_TOO_LARGE:|LOCAL_IMPORT_FILE_OR_DIRECTORY_REQUIRED:)/.test(message))return {kind:'blocked',reason:message}
  throw error
 }
}
