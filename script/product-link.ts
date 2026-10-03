import {mkdir,readFile,readlink,lstat,symlink,rename,rm,readdir,unlink,realpath,appendFile} from 'node:fs/promises'
import {dirname,basename,resolve,join,isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {composeEntries,loadOptionalPatches,loadOverlayPatches,resolveBundleDir} from '@deepseek-ai/dsh-app-boot'
import {applyEntryPatches,entryListSchema,type PatchOptions} from '@deepseek-ai/cordis-plugin-include'
import type {EntryOptions} from '@deepseek-ai/cordis-plugin-loader'

const {load}=createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml') as {load:(text:string,options:{schema:unknown})=>unknown}
type Manifest=Record<string,unknown>
type ProductLink={name:string;path:string;previous:string;target:string;realTarget:string;installation:string}
/**
 * 目标已不存在、但文本形态仍是自家 packages/<目录> 的悬空链接。
 * 只用于同名槽位的恢复：安装清单无法核实，因此不进入缺失包清理识别。
 */
type DanglingProductLink={name:string;path:string;previous:string;target:string;dangling:true}
type OwnedLink=ProductLink|DanglingProductLink
const dependencySections=['dependencies','optionalDependencies','peerDependencies'] as const
function object(value:unknown):Manifest|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Manifest:undefined}
async function manifest(path:string):Promise<Manifest|undefined>{
 try{const result=object(JSON.parse(await readFile(path,'utf8')));if(!result)throw new Error('PRODUCT_PACKAGE_INVALID_MANIFEST: '+path);return result}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
}

/** 托管槽位必须直接指向可核实产品安装的 packages/<目录>，不把用户目录当作产品目录。 */
async function ownedProductLink(path:string,name:string):Promise<OwnedLink|undefined>{
 try{
  if(!(await lstat(path)).isSymbolicLink())return
  const previous=await readlink(path),target=resolve(dirname(path),previous),installation=resolve(target,'../..')
  if(basename(dirname(target))!=='packages')return
  let info
  try{info=await lstat(target)}
  catch(error){
   // 目标不存在：便携包被移动/改名后自家链接会这样悬空；只保留文本形态线索，
   // 是否接管由调用方按“同名槽位 + 新目标有效”判定，不在这里放宽归属识别。
   if((error as NodeJS.ErrnoException).code==='ENOENT')return{name,path,previous,target,dangling:true}
   return
  }
  if(!info.isDirectory())return
  const product=await manifest(join(installation,'package.json')),upstream=await manifest(join(installation,'UPSTREAM_LOCK.json')),pkg=await manifest(join(target,'package.json'))
  if(product?.name!=='lyapunov-dsh'||typeof upstream?.commit!=='string'||pkg?.name!==name)return
  return{name,path,previous,target,realTarget:await realpath(target),installation}
 }catch{return}
}
/** 恢复槽位前核实新安装：必须是同名产品包实体目录，不接受符号链接或无清单目标。 */
async function verifiablePackageTarget(target:string,name:string){
 try{
  const info=await lstat(target)
  if(info.isSymbolicLink()||!info.isDirectory())return false
  return (await manifest(join(target,'package.json')))?.name===name
 }catch{return false}
}
/** 记录被替换的悬空链接原文，便于审计与手工回退；只是一行日志，不新建包管理数据库。
 * 记录失败即抛错、不替换：宁可保留悬空链接现状，也不让旧链接原文先丢失。 */
async function recordLinkRecovery(profileDirectory:string,packageName:string,previous:string,target:string){
 try{await appendFile(join(profileDirectory,'lyapunov-link-recovery.jsonl'),JSON.stringify({time:new Date().toISOString(),package:packageName,replacedDanglingLink:previous,target})+'\n')}
 catch(error){throw new Error('PRODUCT_PACKAGE_RECOVERY_LOG_FAILED: '+packageName+' 恢复记录写入失败，未替换悬空链接（原链接：'+previous+'；原因：'+String((error as Error)?.message??error)+'）')}
}

async function assertLocalDirectory(path:string){
 try{const info=await lstat(path);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('PRODUCT_PACKAGE_CONFLICT: '+path+' 是用户自定义父路径，原件已保留')}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
async function assertLinkParents(profileDirectory:string,packageName?:string){
 const modules=join(profileDirectory,'node_modules');await assertLocalDirectory(modules)
 if(packageName?.startsWith('@'))await assertLocalDirectory(join(modules,packageName.split('/')[0]!))
}
async function createLocalDirectory(path:string){
 try{await mkdir(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
 await assertLocalDirectory(path)
}

/** 迁移自身生成的产品包链接；用户自定义包/实体目录出现冲突时保留并报错。 */
export async function linkProductPackage(profileDirectory:string,packageName:string,target:string){
 const link=join(profileDirectory,'node_modules',packageName)
 await assertLinkParents(profileDirectory,packageName)
 await mkdir(profileDirectory,{recursive:true})
 await createLocalDirectory(join(profileDirectory,'node_modules'))
 if(packageName.startsWith('@'))await createLocalDirectory(dirname(link))
 try{await symlink(target,link,'dir');return {updated:false}}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
 if(!(await lstat(link)).isSymbolicLink())throw new Error('PRODUCT_PACKAGE_CONFLICT: '+packageName+' 不是产品符号链接')
 const previous=await readlink(link),oldTarget=resolve(dirname(link),previous)
 if(oldTarget===resolve(target))return {updated:false}
 const owned=await ownedProductLink(link,packageName),dangling=owned!==undefined&&'dangling' in owned
 const sameName=owned!==undefined&&basename(owned.target)===basename(target)
 // 悬空自家链接（如便携包移动/改名后）：目标已不存在，无可保留内容；仅当槽位同名且新目标是
 // 有效产品包才恢复，用户自定义目录/scope 符号链接/可核实外部安装仍然拒绝。
 if(!owned||!sameName||(dangling&&!await verifiablePackageTarget(target,packageName)))
  throw new Error('PRODUCT_PACKAGE_CONFLICT: '+packageName+' 指向自定义或已不可确认的安装（原链接：'+previous+'），原链接已保留')
 if(dangling)await recordLinkRecovery(profileDirectory,packageName,previous,resolve(target))
 const temporary=link+'.lyapunov-next-'+randomUUID()
 try{
  await symlink(target,temporary,'dir')
  if(await readlink(link)!==previous)throw new Error('PRODUCT_PACKAGE_CONFLICT: '+packageName+' 在启动期间被修改')
  await rename(temporary,link)
 }finally{await rm(temporary,{force:true})}
 return {updated:true}
}

async function productPackages(productRoot:string){
 const packages=new Map<string,string>()
 for(const name of await readdir(join(productRoot,'packages'))){
  const target=join(productRoot,'packages',name),pkg=await manifest(join(target,'package.json'))
  if(typeof pkg?.name==='string')packages.set(pkg.name,target)
 }
 return packages
}

/** 仅枚举当前 Profile 的直接槽位；不沿用户自定义 scope 符号链接递归。 */
async function profileLinks(profileDirectory:string){
 await assertLinkParents(profileDirectory)
 const root=join(profileDirectory,'node_modules'),names:string[]=[]
 let entries:string[]
 try{entries=await readdir(root)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
 for(const name of entries){
  if(name.startsWith('@')){
   const scope=join(root,name),info=await lstat(scope)
   if(!info.isDirectory()||info.isSymbolicLink())continue
   for(const child of await readdir(scope))names.push(name+'/'+child)
  }else if(!name.startsWith('.'))names.push(name)
 }
 const links:ProductLink[]=[]
 // 悬空链接不进入缺失包识别：缺失清理只处理可核实安装，恢复由 linkProductPackage 的同名槽位负责。
 for(const name of names){const owned=await ownedProductLink(join(root,name),name);if(owned&&!('dangling' in owned))links.push(owned)}
 return links
}
function packageName(specifier:string){
 if(specifier.startsWith('.')||isAbsolute(specifier)||specifier.includes(':'))return
 const parts=specifier.split('/');return specifier.startsWith('@')?parts.slice(0,2).join('/'):parts[0]
}
function localPath(specifier:string,base:string){
 if(specifier.startsWith('file:'))return fileURLToPath(specifier)
 if(isAbsolute(specifier))return specifier
 if(specifier.startsWith('.'))return resolve(base,specifier)
}

/** 使用原生 patch 组合语义检查最终启用树；不执行插件、动态 JS 或远端 Include。 */
async function assertUnusedMissingLinks(input:{profileDirectory:string;installAnchor:string;overlayPaths:readonly string[]},packages:Map<string,string>,missing:ProductLink[]){
 const names=new Set(missing.map(link=>link.name)),home=resolve(input.profileDirectory,'../..'),profileManifest=await manifest(join(input.profileDirectory,'package.json'))
 if(!profileManifest)throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 缺少 Profile manifest，保留旧产品链接')
 const unavailable=(name:string,owner:string):never=>{throw new Error('PRODUCT_PACKAGE_UNAVAILABLE: 当前安装缺少 '+name+'，但 '+owner+' 仍启用或声明依赖；原链接已保留')}
 const referenced=(specifier:string,owner:string,base=input.profileDirectory)=>{
  const bare=packageName(specifier);if(bare&&names.has(bare))unavailable(bare,owner)
  const path=localPath(specifier,base)
  if(path)for(const link of missing)if([link.target,link.realTarget].some(target=>path===target||path.startsWith(target+'/')))unavailable(link.name,owner)
 }
 const dependencyVisited=new Set<string>()
 async function dependencies(pkg:Manifest,anchor:string,owner:string,profile=false):Promise<void>{
  anchor=await realpath(anchor)
  if(typeof pkg.name==='string'&&names.has(pkg.name))unavailable(pkg.name,owner)
  if(dependencyVisited.has(anchor))return;dependencyVisited.add(anchor)
  for(const section of [...dependencySections,...profile?['devDependencies' as const]:[]])for(const name of Object.keys(object(pkg[section])??{})){
   referenced(name,owner+' 的 '+section)
   let directory=packages.get(name)
   if(!directory){try{directory=resolveBundleDir('lyapunov',name,anchor,input.profileDirectory)}catch{continue}}
   directory=await realpath(directory)
   const child=await manifest(join(directory,'package.json'))
   if(child)await dependencies(child,join(directory,'package.json'),name)
  }
 }
 await dependencies(profileManifest,join(input.profileDirectory,'package.json'),'Profile',true)
 const profile=object(object(profileManifest.dsh)?.profile),bundleNames=profile?.bundles??[]
 if(!Array.isArray(bundleNames)||bundleNames.some(name=>typeof name!=='string'))throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: Profile bundles 不是字符串数组')
 const layers:PatchOptions[][]=[]
 for(const name of bundleNames as string[]){
  referenced(name,'Profile bundle')
  const directory=packages.get(name)??resolveBundleDir('lyapunov',name,input.installAnchor,input.profileDirectory),pkg=await manifest(join(directory,'package.json'))
  if(!pkg)throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 缺少 bundle manifest '+name)
  await dependencies(pkg,join(directory,'package.json'),name)
  const patch=object(object(pkg.dsh)?.bundle)?.patch
  if(typeof patch!=='string')throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: bundle 未声明 patch '+name)
  layers.push(loadOverlayPatches('lyapunov',join(directory,patch)))
 }
 layers.push(loadOptionalPatches('lyapunov',join(input.profileDirectory,'cordis.patch.yml'))??[],loadOptionalPatches('lyapunov',join(home,'cordis.patch.yml'))??[])
 for(const path of input.overlayPaths)layers.push(loadOverlayPatches('lyapunov',path))
 const includeVisited=new Set<string>()
 async function entries(rows:EntryOptions[],base:string):Promise<void>{
  for(const row of rows){
   if(row.disabled===true)continue
   if(typeof row.name!=='string')throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 动态插件名无法确认，保留旧产品链接')
   referenced(row.name,'启用插件 '+(row.id??row.name),base)
   const bare=packageName(row.name)
   if(bare){let directory=packages.get(bare);if(!directory){try{directory=resolveBundleDir('lyapunov',bare,input.installAnchor,input.profileDirectory)}catch{}}
    if(directory){const pkg=await manifest(join(directory,'package.json'));if(pkg)await dependencies(pkg,join(directory,'package.json'),row.name)}}
   let local=localPath(row.name,base)
   if(local){
    try{local=await realpath(local)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    referenced(local,'启用插件真实路径 '+(row.id??row.name),base)
    let directory=dirname(local)
    while(true){const pkg=await manifest(join(directory,'package.json'));if(pkg){await dependencies(pkg,join(directory,'package.json'),row.name);break}const parent=dirname(directory);if(parent===directory)break;directory=parent}
   }
   if(row.group||row.name==='cordis:group'||row.name==='@deepseek-ai/cordis-plugin-group'){
    if(Array.isArray(row.config))await entries(row.config as EntryOptions[],base)
    else if(row.config!==undefined)throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 动态group子树无法确认，保留旧产品链接')
   }
   if(row.name==='cordis:include'||row.name==='@deepseek-ai/cordis-plugin-include'){
    const config=object(row.config)
    if(typeof config?.path!=='string')throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 动态 Include 路径无法确认，保留旧产品链接')
    const url=new URL(config.path,pathToFileURL(base+'/'))
    if(url.protocol!=='file:')throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: 非本地 Include 无法确认，保留旧产品链接')
    const declaredPath=fileURLToPath(url)
    let path=declaredPath
    referenced(path,'启用 Include',base)
    try{path=await realpath(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    referenced(path,'启用 Include 真实路径',base)
    // 同一个配置文件可以用不同patch装配；循环Include本身不能确认为未使用。
    const identity=JSON.stringify([path,dirname(declaredPath),config.patches??[]]);if(includeVisited.has(identity))throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: Include 循环，保留旧产品链接')
    includeVisited.add(identity)
    let data:unknown
    try{data=load(await readFile(path,'utf8'),{schema:entryListSchema})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&Array.isArray(config.initial))data=config.initial;else throw error}
    if(!Array.isArray(data))throw new Error('PRODUCT_PACKAGE_USAGE_UNRESOLVED: Include 不是插件数组 '+path)
    await entries(applyEntryPatches(data as EntryOptions[],config.patches as PatchOptions[]|undefined,()=>{}),dirname(declaredPath));includeVisited.delete(identity)
   }
  }
 }
 await entries(composeEntries(layers),input.profileDirectory)
}

/** 完整切换本产品托管链接；缺失但仍启用的包在任何清理前明确拒绝。 */
export async function reconcileProductPackageLinks(input:{profileDirectory:string;productRoot:string;installAnchor:string;overlayPaths?:readonly string[]}){
 const packages=await productPackages(input.productRoot)
 for(const name of packages.keys())await assertLinkParents(input.profileDirectory,name)
 const missing=(await profileLinks(input.profileDirectory)).filter(link=>!packages.has(link.name))
 if(missing.length)await assertUnusedMissingLinks({...input,overlayPaths:input.overlayPaths??[]},packages,missing)
 const updated:string[]=[],removed:string[]=[]
 for(const[name,target]of packages)if((await linkProductPackage(input.profileDirectory,name,target)).updated)updated.push(name)
 for(const link of missing){
  if(!(await lstat(link.path)).isSymbolicLink()||await readlink(link.path)!==link.previous)throw new Error('PRODUCT_PACKAGE_CONFLICT: '+link.name+' 在切换期间被修改，拒绝清理')
  await unlink(link.path);removed.push(link.name)
 }
 return{updated,removed}
}
