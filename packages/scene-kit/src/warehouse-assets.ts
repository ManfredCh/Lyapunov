import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises'
import {join,posix,resolve} from 'node:path'
import type {SceneOperations} from './operations.ts'
import type {SimreadyFetch,SimreadySelection} from './simready-assets.ts'
import type {Transform} from '../../lyapunov-contracts/src/types.ts'
import {inspectUsd,usdLayerDependencies,usdMdlDeclarations} from './usd-assets.ts'
import {readUsdStandardLibrary,resolveUsdStandardLibrary} from './usd-standard-libraries.ts'
import type {UsdStandardLibraryDependency} from '../../lyapunov-contracts/src/usd.ts'
import {loadWarehouseCatalog,warehouseEntry,warehouseMirror,warehousePath,verifyWarehouseFile,sha256,WAREHOUSE_REPO,WAREHOUSE_REVISION,WAREHOUSE_CSV,type WarehouseCatalog} from './warehouse-catalog.ts'

export interface WarehouseOptions {fetchBytes:SimreadyFetch;signal?:AbortSignal;refresh?:boolean;catalog?:WarehouseCatalog}
export async function warehouseDetail(input:SimreadySelection,options:WarehouseOptions){
 if(input.repoId!==WAREHOUSE_REPO||input.revision!==WAREHOUSE_REVISION)throw Error('WAREHOUSE_REGISTERED_REVISION_REQUIRED')
 const catalog=options.catalog??await loadWarehouseCatalog(options),{row,file}=warehouseEntry(catalog,input.packagePath)
 return {sourceProtocol:'warehouse-csv-v1' as const,selection:input,name:row.name,catalog:row,rootUsd:file.path,rootFile:file,license:{id:'CC-BY-4.0',source:'file' as const,url:warehouseMirror('README.md'),attribution:catalog.pins.attribution},minimumBytes:file.size,dependencyBytes:'UNKNOWN_UNTIL_LAYER_INSPECTION',catalogState:catalog.catalogState,...catalog.refreshFailure?{refreshFailure:catalog.refreshFailure}:{},sourceIndex:warehouseMirror(WAREHOUSE_CSV),catalogSha256:catalog.pins.catalogSha256,metadataBasis:'固定revision的HF files_metadata返回项快照；不把返回数量当资产总量',thumbnail:{status:'NOT_FETCHED',path:row.thumbnailPath??null,note:'不向浏览器提供自动请求URL；需由受控镜像获取成功后显示'},validation:'旧源没有新版packaging BOM/验证记录；未执行本地引擎验证'}
}
export async function warehouseImport(operations:SceneOperations,input:SimreadySelection&{maxBytes?:number;category?:'object'|'robot'|'scene';sceneId?:string;name?:string;resourceId?:string;entityId?:string;parentId?:string;transform?:Transform},options:WarehouseOptions){
 const budget=input.maxBytes??128*1024*1024
 if(!Number.isSafeInteger(budget)||budget<1||budget>512*1024*1024)throw Error('WAREHOUSE_BUDGET_INVALID')
 const catalog=options.catalog??await loadWarehouseCatalog(options),detail=await warehouseDetail(input,{...options,catalog})
 const cacheDirectory=join(operations.resources.downloadRoot,'simready-warehouse',WAREHOUSE_REVISION,sha256(Buffer.from(detail.catalog.catalogPath)).slice(0,24))
 let directory=cacheDirectory
 await mkdir(directory,{recursive:true})
 let received=0,packageBytes=0
 const queue=[detail.rootUsd],verified=new Map<string,{relative_path:string;size:number;sha256:string;expectedIdentity:{kind:string;digest:string};gitBlob:string}>()
 const standardLibraries=new Map<string,UsdStandardLibraryDependency>()
 while(queue.length){
  options.signal?.throwIfAborted()
  const path=warehousePath(queue.shift()!);if(verified.has(path))continue
  if(verified.size>=1024)throw Error('WAREHOUSE_FILE_BUDGET_EXCEEDED')
  const file=catalog.files.get(path);if(!file)throw Error('WAREHOUSE_DEPENDENCY_IDENTITY_UNAVAILABLE: '+path)
  packageBytes+=file.size;if(packageBytes>budget)throw Error('WAREHOUSE_BYTE_BUDGET_EXCEEDED: '+path)
  const target=resolve(directory,path);if(!target.startsWith(resolve(directory)+'/'))throw Error('WAREHOUSE_PATH_UNSAFE')
  let bytes=await readFile(target).catch(()=>undefined)
  if(bytes)try{verifyWarehouseFile(bytes,file)}catch{bytes=undefined}
  if(!bytes){let streamed=0;const fetched=await options.fetchBytes(warehouseMirror(path),{signal:options.signal,maxBytes:Math.min(file.size*2+1,budget-received),onBytes:count=>{streamed+=count;received+=count;if(received>budget)throw Error('WAREHOUSE_BYTE_BUDGET_EXCEEDED')}});if(!streamed)received+=fetched.length;if(received>budget)throw Error('WAREHOUSE_BYTE_BUDGET_EXCEEDED');verifyWarehouseFile(fetched,file);bytes=Buffer.from(fetched);await mkdir(posix.dirname(target),{recursive:true});await writeFile(target,bytes)}
  verified.set(path,{relative_path:path,size:bytes.length,sha256:sha256(bytes),expectedIdentity:{kind:file.lfsSha256?'lfs-sha256':'git-blob-sha1',digest:file.lfsSha256??file.gitBlob},gitBlob:file.gitBlob})
  if(/\.(usd|usda|usdc|usdz)$/i.test(path))for(const raw of await usdLayerDependencies(target,options.signal)){
   if(/^[a-z][a-z\d+.-]*:/i.test(raw)||raw.startsWith('/')||raw.includes('\\'))throw Error('WAREHOUSE_EXTERNAL_DEPENDENCY_UNSUPPORTED: '+raw)
   if(/[<>*?]/.test(raw))throw Error('WAREHOUSE_DEPENDENCY_PATTERN_UNSUPPORTED: '+raw)
   const container=raw.split('[')[0]!,dependency=warehousePath(posix.normalize(posix.join(posix.dirname(path),container)))
   if(!catalog.files.has(dependency)&&/\.mdl$/i.test(raw)){
    const declarations=(await usdMdlDeclarations(target,options.signal)).filter(value=>value.assetIdentifier===raw)
    if(!declarations.length)throw Error('WAREHOUSE_DEPENDENCY_IDENTITY_UNAVAILABLE: '+dependency)
    for(const declaration of declarations){const library=await resolveUsdStandardLibrary(operations.resources,declaration);standardLibraries.set(library.resourceId+'@'+library.version,library)}
   }else if(!verified.has(dependency))queue.push(dependency)
  }
 }
 const files=[...verified.values()].sort((a,b)=>a.relative_path<b.relative_path?-1:a.relative_path>b.relative_path?1:0)
 const libraries=[...standardLibraries.values()].sort((a,b)=>a.resourceId.localeCompare(b.resourceId)),libraryFiles=new Set<string>()
 for(const library of libraries){const checked=await readUsdStandardLibrary(library.manifestPath);if(checked.sha256!==library.manifestSha256)throw Error('USD_STANDARD_LIBRARY_HASH_MISMATCH');for(const file of checked.files)libraryFiles.add(file)}
 if(libraries.length){
  // 不覆写旧组合位置；不同标准库版本/身份形成独立复合来源，HF缓存原字节保持。
  directory=join(cacheDirectory,'with-standard',sha256(Buffer.from(JSON.stringify(libraries))).slice(0,24));await mkdir(directory,{recursive:true})
  for(const file of files){const target=join(directory,file.relative_path);await mkdir(posix.dirname(target),{recursive:true});await copyFile(join(cacheDirectory,file.relative_path),target)}
 }
 const rowFile='warehouse-catalog-row.json',readmeFile='README.warehouse-source.md'
 const provenance={schema:'lyapunov.simready-source.v1',sourceProtocol:'warehouse-csv-v1',repoId:WAREHOUSE_REPO,revision:WAREHOUSE_REVISION,catalogPath:WAREHOUSE_CSV,catalogSha256:catalog.pins.catalogSha256,catalogGitBlob:catalog.pins.catalogGitBlob,licenseSource:{path:'README.md',gitBlob:catalog.pins.readmeGitBlob,sha256:catalog.pins.readmeSha256},fileMetadataSha256:catalog.pins.filesSha256,catalogEntry:detail.catalog,rootUsd:detail.rootUsd,license:detail.license,packageFiles:[rowFile,readmeFile,...files.map(file=>file.relative_path)],files,...libraries.length?{standardLibraries:libraries.map(library=>({...library,manifestPath:posix.relative(directory,library.manifestPath)}))}:{},mirror:'https://hf-mirror.com',sourceValidation:'NOT_PROVIDED_BY_LEGACY_CSV'}
 // 固定来源身份不写当前时间/缓存状态，重复导入不能改变已登记版本的源字节。
 await writeFile(join(directory,rowFile),JSON.stringify({sourceProtocol:provenance.sourceProtocol,revision:WAREHOUSE_REVISION,catalog:detail.catalog,rootFile:detail.rootFile,catalogSha256:provenance.catalogSha256},null,2))
 await writeFile(join(directory,readmeFile),catalog.readme);await writeFile(join(directory,'lyapunov-source.json'),JSON.stringify(provenance,null,2))
 const source=join(directory,detail.rootUsd),inspection=await inspectUsd(source,{}, {signal:options.signal})
 for(const file of inspection.files){const relative=posix.relative(directory,file);if(!libraryFiles.has(file)&&(relative.startsWith('../')||!verified.has(relative)))throw Error('WAREHOUSE_DEPENDENCY_CLOSURE_NOT_VERIFIED: '+relative)}
 options.signal?.throwIfAborted()
 const imported=await operations.import({...input,path:source,name:input.name??detail.name,category:input.category??'object',license:detail.license,physicalize:false,storage:'reference',tags:['SimReady','Warehouse CSV',`revision:${WAREHOUSE_REVISION}`,'source-validation:not-provided']})
 return {status:'IMPORTED',...imported,source:provenance,catalogState:catalog.catalogState,...catalog.refreshFailure?{refreshFailure:catalog.refreshFailure}:{},packageDirectory:directory,receivedBytes:received,packageBytes,verification:await operations.resources.verify(imported.resource.ref.resourceId,imported.resource.ref.version),note:'旧CSV没有新版BOM/验证记录；当前仅完成固定源文件LFS/Git身份、完整USD依赖闭包与资源登记，物理/外观另验'}
}
