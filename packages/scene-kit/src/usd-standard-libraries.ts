/** 独立标准MDL资源：与HF原件身份分开，使用同一ResourceLibrary和有界本地闭包。 */
import {createHash} from 'node:crypto'
import {copyFile,mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import type {ResourceLibrary,ResourceRecord} from './resources.ts'
import type {UsdStandardLibraryDependency} from '../../lyapunov-contracts/src/usd.ts'

export const USD_STANDARD_LIBRARY_MIME='application/vnd.lyapunov.usd-standard-library+json'
const BUILTIN=new Set(['anno','base','df','debug','limits','math','scene','state','tex'])
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const safe=(path:string)=>{if(!path||isAbsolute(path)||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('USD_STANDARD_LIBRARY_PATH_INVALID');return path}
const code=(text:string)=>text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,value=>value.startsWith('"')?value:' ')
export interface UsdMdlDeclaration {assetIdentifier:string;subIdentifier:string;parameters:Array<{name:string;typeName:string}>}
export interface UsdStandardLibraryManifest {
 schema:'lyapunov.usd-standard-library.v1';libraryId:string;version:string
 origin:{kind:'installed-sdk';distribution:string;distributionVersion:string;metadataSha256:string;package:string}
 license:{id:'BSD-3-Clause';file:string;attribution:string}
 resolverRoots:string[];runtimeModules:string[];requiredMdlVersion:string
 modules:Array<{assetIdentifier:string;subIdentifier:string;file:string;parameters:Record<string,string>}>
 files:Array<{path:string;size:number;sha256:string}>
}
function materialParameters(text:string,symbol:string):Record<string,string>{
 const source=code(text),start=source.indexOf('export material '+symbol+'(')
 if(start<0)throw Error('USD_STANDARD_LIBRARY_EXPORT_MISSING: '+symbol)
 const open=source.indexOf('(',start),parameters:string[]=[];let depth=0,quoted=false,from=open+1,end=-1
 for(let i=open+1;i<source.length;i++){const c=source[i]!
  if(c==='"'&&source[i-1]!=='\\')quoted=!quoted
  if(quoted)continue
  if('([{'.includes(c))depth++
  if(')]}'.includes(c)){if(c===')'&&depth===0){parameters.push(source.slice(from,i));end=i;break}depth--}
  if(c===','&&depth===0){parameters.push(source.slice(from,i));from=i+1}
 }
 if(end<0)throw Error('USD_STANDARD_LIBRARY_EXPORT_INVALID')
 const result:Record<string,string>={}
 for(const parameter of parameters){if(!parameter.trim())continue;const match=parameter.trim().match(/^(?:uniform\s+)?((?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\[\d*\])?)\s+([A-Za-z_]\w*)\s*=/);if(!match)throw Error('USD_STANDARD_LIBRARY_PARAMETER_INVALID: '+symbol+' / '+parameter.trim().slice(0,100));result[match[2]!]=match[1]!}
 return result
}
function imports(text:string):string[]{
 const result:string[]=[],source=code(text)
 for(const match of source.matchAll(/^\s*import\s+([^;]+);/gm))result.push(match[1]!.trim())
 for(const match of source.matchAll(/^\s*(?:export\s+)?using\s+([^\s;]+)\s+import\s+[^;]+;/gm))result.push(match[1]!.trim())
 return result
}
export async function readUsdStandardLibrary(path:string):Promise<{manifest:UsdStandardLibraryManifest;files:string[];sha256:string}>{
 if((await stat(path)).size>2*1024*1024)throw Error('USD_STANDARD_LIBRARY_BUDGET')
 const bytes=await readFile(path),manifest=JSON.parse(bytes.toString())as UsdStandardLibraryManifest,root=dirname(path)
 if(manifest.schema!=='lyapunov.usd-standard-library.v1'||!manifest.libraryId||!manifest.version||manifest.origin?.kind!=='installed-sdk'||!manifest.origin.distribution||!manifest.origin.distributionVersion||!/^[a-f0-9]{64}$/.test(manifest.origin.metadataSha256)||!manifest.origin.package||manifest.license?.id!=='BSD-3-Clause'||!manifest.license.attribution||!/^\d+\.\d+$/.test(manifest.requiredMdlVersion)||!Array.isArray(manifest.runtimeModules)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>128||!Array.isArray(manifest.modules)||!manifest.modules.length||!Array.isArray(manifest.resolverRoots)||!manifest.resolverRoots.length)throw Error('USD_STANDARD_LIBRARY_MANIFEST_INVALID')
 const files:string[]=[resolve(path)];let total=bytes.length
 for(const file of manifest.files){safe(file.path);if(!Number.isSafeInteger(file.size)||file.size<1||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('USD_STANDARD_LIBRARY_FILE_INVALID');total+=file.size;if(total>8*1024*1024)throw Error('USD_STANDARD_LIBRARY_BUDGET');const target=resolve(root,file.path),data=await readFile(target);if(data.length!==file.size||sha(data)!==file.sha256)throw Error('USD_STANDARD_LIBRARY_HASH_MISMATCH: '+file.path);if(file.path.endsWith('.mdl')&&!data.toString().includes('SPDX-License-Identifier: BSD-3-Clause'))throw Error('USD_STANDARD_LIBRARY_LICENSE_UNVERIFIED: '+file.path);files.push(target)}
 for(const directory of manifest.resolverRoots){safe(directory);if(!(await stat(resolve(root,directory))).isDirectory())throw Error('USD_STANDARD_LIBRARY_ROOT_MISSING')}
 if(!manifest.files.some(file=>file.path===safe(manifest.license.file)))throw Error('USD_STANDARD_LIBRARY_LICENSE_MISSING')
 for(const module of manifest.modules){safe(module.file);if(!manifest.files.some(file=>file.path===module.file)||!isDeepStrictEqual(materialParameters(await readFile(resolve(root,module.file),'utf8'),module.subIdentifier),module.parameters))throw Error('USD_STANDARD_LIBRARY_EXPORT_MISMATCH')}
 return {manifest,files,sha256:sha(bytes)}
}

/** 创建明确来源的SDK标准模块包；不把它当作HF原始依赖，也不写SDK。 */
export async function createNvidiaUsdStandardLibraryBundle(coreRoot:string,bundleRoot:string):Promise<{path:string;manifest:UsdStandardLibraryManifest;digest:string}>{
 coreRoot=resolve(coreRoot);const version=(await readFile(join(coreRoot,'VERSION.md'),'utf8')).trim(),site=resolve(coreRoot,'../../../..')
 const distributions=(await readdir(site)).filter(name=>/^isaacsim_kernel-.*\.dist-info$/.test(name));if(distributions.length!==1)throw Error('USD_STANDARD_LIBRARY_SDK_IDENTITY_AMBIGUOUS')
 const metadata=await readFile(join(site,distributions[0]!,'METADATA')),distributionVersion=metadata.toString().match(/^Version:\s*(\S+)/m)?.[1];if(!distributionVersion||metadata.toString().match(/^Name:\s*(\S+)/m)?.[1]!=='isaacsim-kernel')throw Error('USD_STANDARD_LIBRARY_SDK_IDENTITY_MISSING')
 const roots=['Base','mdl'],queue=[join(coreRoot,'Base/OmniPBR.mdl')],seen=new Set<string>(),runtime=new Set<string>(),languages:string[]=[]
 const inside=(file:string)=>{const rel=relative(coreRoot,file);if(rel.startsWith('../')||isAbsolute(rel))throw Error('USD_STANDARD_LIBRARY_EXTERNAL_IMPORT');return rel.split('\\').join('/')}
 while(queue.length){
  const file=queue.shift()!;if(seen.has(file))continue;if(seen.size>=64)throw Error('USD_STANDARD_LIBRARY_IMPORT_BUDGET');seen.add(file)
  const text=await readFile(file,'utf8');if(!text.includes('SPDX-License-Identifier: BSD-3-Clause'))throw Error('USD_STANDARD_LIBRARY_LICENSE_UNVERIFIED: '+inside(file));languages.push(text.match(/\bmdl\s+(\d+\.\d+)\s*;/)?.[1]??'')
  for(const value of imports(text)){
   const global=value.startsWith('::'),parts=value.replace(/^::/,'').replace(/^\.::/,'').split('::').filter(value=>value&&value!=='*')
   if(global&&BUILTIN.has(parts[0]!)){runtime.add(parts[0]!);continue}
   let found:string|undefined
   for(let count=parts.length;count>0&&!found;count--){const name=parts.slice(0,count).join('/')+'.mdl';for(const directory of global?roots.map(dir=>join(coreRoot,dir)):[dirname(file),...roots.map(dir=>join(coreRoot,dir))]){const candidate=resolve(directory,name);if(await stat(candidate).then(row=>row.isFile(),()=>false)){inside(candidate);found=candidate;break}}}
   if(!found)throw Error('USD_STANDARD_LIBRARY_IMPORT_MISSING: '+value)
   queue.push(found)
  }
 }
 const selected=[...seen].map(inside).sort(),licenseSource='PACKAGE-LICENSES/omni-core-materials-LICENSE.md',sourceFiles=[...selected,licenseSource,'VERSION.md']
 const files=await Promise.all(sourceFiles.map(async path=>{const bytes=await readFile(join(coreRoot,path));return {path,size:bytes.length,sha256:sha(bytes)}}))
 const manifest:UsdStandardLibraryManifest={schema:'lyapunov.usd-standard-library.v1',libraryId:'nvidia-core-materials-omnipbr',version,origin:{kind:'installed-sdk',distribution:'isaacsim-kernel',distributionVersion,metadataSha256:sha(metadata),package:'NVIDIA Omniverse Core Materials'},license:{id:'BSD-3-Clause',file:licenseSource,attribution:'NVIDIA CORPORATION & AFFILIATES'},resolverRoots:roots.filter(dir=>selected.some(path=>path.startsWith(dir+'/'))),runtimeModules:[...runtime].sort(),requiredMdlVersion:languages.sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]!-y[0]!||x[1]!-y[1]!}).at(-1)!,modules:[{assetIdentifier:'OmniPBR.mdl',subIdentifier:'OmniPBR',file:'Base/OmniPBR.mdl',parameters:materialParameters(await readFile(join(coreRoot,'Base/OmniPBR.mdl'),'utf8'),'OmniPBR')}],files}
 const raw=JSON.stringify(manifest,null,2)+'\n',digest=sha(Buffer.from(raw)),directory=join(resolve(bundleRoot),digest),path=join(directory,'library.usd-library.json')
 await mkdir(directory,{recursive:true});for(const file of files){await mkdir(dirname(join(directory,file.path)),{recursive:true});await copyFile(join(coreRoot,file.path),join(directory,file.path))}await writeFile(path,raw);await readUsdStandardLibrary(path)
 return {path,manifest,digest}
}

export async function registerNvidiaUsdStandardLibrary(resources:ResourceLibrary,coreRoot:string):Promise<ResourceRecord>{
 const {path,manifest,digest}=await createNvidiaUsdStandardLibraryBundle(coreRoot,join(resources.downloadRoot,'usd-standard-libraries'))
 return resources.import({path,category:'scene',name:'NVIDIA OmniPBR 标准库 '+manifest.version,resourceId:'usd_std_'+digest.slice(0,24),storage:'reference',license:{...manifest.license,source:'file'},tags:['usd-standard-library','NVIDIA','OmniPBR',manifest.version]})
}

const TYPES:Record<string,string>={asset:'texture_2d',bool:'bool',float:'float',float2:'float2',float3:'float3',float4:'float4',color3f:'color',int:'int',string:'string'}
export async function resolveUsdStandardLibrary(resources:ResourceLibrary,declaration:UsdMdlDeclaration):Promise<UsdStandardLibraryDependency>{
 const candidates:Array<{record:ResourceRecord;library:Awaited<ReturnType<typeof readUsdStandardLibrary>>}>=[]
 for(const record of await resources.list()){
  if(record.parsed.metadata.format!=='usd-standard-library')continue
  if(record.license&&record.license.id!=='BSD-3-Clause')throw Error('USD_STANDARD_LIBRARY_LICENSE_CONFLICT')
  const library=await readUsdStandardLibrary(fileURLToPath(record.ref.original.uri)),module=library.manifest.modules.find(module=>module.assetIdentifier===declaration.assetIdentifier&&module.subIdentifier===declaration.subIdentifier)
  if(!module||!declaration.parameters.every(parameter=>TYPES[parameter.typeName]!==undefined&&module.parameters[parameter.name]===TYPES[parameter.typeName]))continue
  if(!(await resources.verify(record.ref.resourceId,record.ref.version)).valid)throw Error('USD_STANDARD_LIBRARY_VERSION_UNAVAILABLE')
  candidates.push({record,library})
 }
 if(candidates.length!==1)throw Error(candidates.length?'USD_STANDARD_LIBRARY_SELECTION_REQUIRED: '+declaration.assetIdentifier:'USD_STANDARD_LIBRARY_REQUIRED: '+declaration.assetIdentifier+' / '+declaration.subIdentifier+'；先登记有兼容导出定义、版本及许可的独立标准模块资源')
 const selected=candidates[0]!
 return {resourceId:selected.record.ref.resourceId,version:selected.record.ref.version,manifestPath:fileURLToPath(selected.record.ref.original.uri),manifestSha256:selected.library.sha256,assetIdentifier:declaration.assetIdentifier,subIdentifier:declaration.subIdentifier}
}
