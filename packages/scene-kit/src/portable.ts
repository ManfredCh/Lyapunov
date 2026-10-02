import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { ResourceRef } from '../../lyapunov-contracts/src/types.ts'
import { fileStamp, localPath, parseAsset, type FileStamp } from './formats.ts'
import type { ResourceRecord } from './resources.ts'
import { inspectBlend, repathBlendCopy, type BlendInspection } from './blend-deps.ts'

const xmlOptions={ignoreAttributes:false,attributeNamePrefix:'@_',preserveOrder:true,parseTagValue:false,parseAttributeValue:false}
const absolute=(value:string)=>isAbsolute(value)||value.startsWith('file:')
/** Blender 的 `//` 前缀是"相对 .blend 文件所在目录"，不是 POSIX 绝对路径；相对引用按镜像布局原样可解，绝不触发改写。 */
const blendAbsolute=(value:string)=>!value.startsWith('//')&&absolute(value)
const inside=(base:string,path:string)=>{const rel=relative(base,path);return rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel)}
function commonDirectory(files:string[]){let directory=dirname(files[0]!);while(files.some(file=>!inside(directory,file)))directory=dirname(directory);return directory}

/**
 * 组件级"路径尾部"判定：`a/b/c.stl` 以 `b/c.stl` 结尾，但不以 `c.stl.bak`/`bc.stl` 结尾。
 * 副本相对本 XML 的层级可能带着前导 `..`（XML 自己在闭包里有多深，CAS 与便携副本都照原样保留），
 * 那几层在绝对路径上没有可比对象，去掉后比对剩余层级。
 */
function tailEndsWith(full:string,tail:string):boolean{
 const segments=tail.split(sep)
 const rest=segments.slice(segments.findIndex(part=>part!=='..'))
 const left=full.split(sep)
 return rest.length>0&&rest.length<=left.length&&(rest[0]!=='..')&&rest.every((part,index)=>left[left.length-rest.length+index]===part)
}

/**
 * 只在副本真正需要改写引用时才动XML。相对依赖已闭合的原件保持逐字节一致。
 *
 * 绝对引用指向的是**原稿**位置，而登记进 CAS 后磁盘上的依赖副本已经换了位置（CAS 按入口闭包的
 * 相对层级镜像，见 resources.ts planCasStore）。包内副本保留了同一套相对层级，所以绝对引用按
 * "路径尾部 == 该依赖原件到本 XML 原件的相对层级"重新锚定；锚不定或出现多个同名候选就当场失败，
 * 不猜测、不写坏路径。
 *
 * 锚定比对的是**依赖原件**（`copied` 的键）而不是已落位目标：同一份真实字节在本次保存里只落一份
 * （place 的 byContent 复用），复用会把副本落到别的分组、甚至换成另一个文件名（多个网格内容相同、
 * 名字不同时，见 DEV-021 的 G1 咖啡模型）。按目标比对时这些副本的路径尾部已经不等于原件尾部，
 * "已在场且被引擎读过"的绝对依赖就会被误报成缺失；按原件比对后仍以闭包为准：不在 `copied` 里
 * （依赖真的不在场）才报 `PORTABLE_DEPENDENCY_MISSING`。
 *
 * 相对引用除"包内该相对路径已经不存在"（副本被复用落到别处，包自己解不开）外一律不改写，
 * 这一种情况改写成副本的实际落点，而不是报缺失。
 */
async function rewriteXML(source:string,target:string,copied:Map<string,string>){
 const text=await readFile(target,'utf8'),document=new XMLParser(xmlOptions).parse(text)
 const anchor=(resolved:string):string|undefined=>{
  const matches=[...new Set([...copied].filter(([file])=>tailEndsWith(resolved,relative(dirname(source),file))).map(([,copy])=>copy))]
  if(matches.length>1)throw new Error(`PORTABLE_REFERENCE_AMBIGUOUS: ${resolved} → ${matches.sort().join("、")}（路径尾部在包内有多份候选）`)
  return matches[0]
 }
 const mjcf=document.some((node:any)=>Array.isArray(node.mujoco))
 let compiler:Record<string,string>={},changed=false
 const visit=(nodes:any[],fn:(tag:string,attributes:Record<string,string>)=>void)=>{for(const node of nodes){for(const [tag,children] of Object.entries(node)){if(tag===':@')continue;fn(tag,node[':@']??{});if(Array.isArray(children))visit(children,fn)}}}
 visit(document,(tag,attrs)=>{if(tag==='compiler')compiler={...compiler,...attrs}})
 visit(document,(tag,attrs)=>{
  const key=attrs['@_file']!==undefined?'@_file':attrs['@_filename']!==undefined?'@_filename':undefined
  if(key){
   const ref=attrs[key]!,dir=tag==='mesh'?compiler['@_meshdir']??compiler['@_assetdir']??'':tag==='texture'?compiler['@_texturedir']??compiler['@_assetdir']??'':''
   const located=absolute(ref)||absolute(dir)
   if(!located&&existsSync(resolve(dirname(target),dir,ref)))return
   const sourceFile=ref.startsWith('file:')?localPath(ref):resolve(dirname(source),dir,ref)
   const targetFile=copied.get(sourceFile)??anchor(sourceFile)
   if(!targetFile)throw new Error(`PORTABLE_DEPENDENCY_MISSING: ${sourceFile}`)
   const targetBase=resolve(dirname(target),absolute(dir)?'':dir)
   // MJCF 未显式命名的网格以原文件名（去扩展名）为名；内容去重不能改掉 geom 引用的身份。
   if(mjcf&&tag==='mesh'&&!attrs['@_name'])attrs['@_name']=basename(sourceFile,extname(sourceFile))
   attrs[key]=relative(targetBase,targetFile);changed=true
  }
  if(tag==='compiler')for(const key of ['@_meshdir','@_texturedir','@_assetdir'])if(attrs[key]&&absolute(attrs[key]!)){attrs[key]='';changed=true}
 })
 if(changed){
  if(target===source)throw new Error(`PORTABLE_TARGET_REQUIRES_DERIVATION: ${source}`)
  await writeFile(target,new XMLBuilder(xmlOptions).build(document))
 }
 return changed
}

/**
 * 一次便携保存的归档：目标文件已存在且字节一致就直接复用，因此**同一源工程/同一资源被多个实体
 * 引用时只落一份**；内容戳与 Blender 读数按源路径缓存在本次保存内，不跨保存留状态。
 *
 * 盘上布局（相对便携目录）：
 *  · `sources/<源工程字节前16位>/…`——.blend 源工程连同它的外部纹理/链接库，按原件与依赖的
 *    相对层级镜像，相对引用原样可解；绝对引用只在**副本**上改写（原件字节不动）。
 *  · `resources/<resourceId>-v<version>/…`——该资源版本自己的闭包（GLB/派生表示/XML 等）。
 *  · `project/…`——调用方显式指定的用户项目文件（脚本/参考图/贴图）。
 */
export class PortableArchive {
  /** 本次保存落位过的目标文件（便携目录内绝对路径）。 */
  readonly targets=new Set<string>()
  /**
   * 副本字节被有意改写过的文件（XML 相对化、.blend 绝对引用改写）→ 改写前后的内容戳。
   * before 是复制时的源内容戳（即已登记版本里同一文件的内容戳），after 是改写后的真实字节；
   * 资源库据此把副本显式登记为**同一版本的另一个位置**（改的只有外部引用路径，版本仍绑定同一份内容）。
   */
  readonly rewrites=new Map<string,{before:FileStamp;after:FileStamp}>()
  /** 副本字节被改写过、不能再用原件哈希核验的文件（便携目录内绝对路径）。 */
  get derived():Set<string>{return new Set(this.rewrites.keys())}
  private readonly placed=new Map<string,FileStamp>()
  /** 本次保存已落位的字节（`sha256:size` → 目标）：同一份真实字节在包里只落一份。 */
  private readonly byContent=new Map<string,string>()
  private readonly inspections=new Map<string,Promise<BlendInspection>>()
  private readonly stamps=new Map<string,FileStamp>()
  constructor(readonly root:string){}

  /**
   * 已经在便携目录里的文件（保存回同一个包、保存到包内引用的工程）：它自己就是包内位置。
   * 重复保存时若按新算出来的 sha16 另立一份，包体会一次次翻倍，而场景文档引用的还是旧位置。
   */
  private targetFor(source:string,computed:string):string{
   return inside(this.root,source)?resolve(source):computed
  }
  /** 登记一次只改路径的副本改写；实际没改字节（如引用本来就相对）就不算派生。 */
  private async markDerived(target:string):Promise<void>{
   const before=this.placed.get(target)
   if(!before?.sha256)throw new Error(`RESOURCE_CONTENT_UNVERIFIABLE: ${target}（改写前的副本内容戳缺失，无法登记为派生）`)
   const after=await this.stampOf(target,true)
   if(after.size===before.size&&after.sha256===before.sha256)return
   this.rewrites.set(target,{before,after})
  }
  private inspectionOf(path:string):Promise<BlendInspection>{
   let pending=this.inspections.get(path)
   if(!pending){pending=inspectBlend(path);this.inspections.set(path,pending)}
   return pending
  }
  /** 内容戳缓存；expected 来自资源登记时用 content=false 取戳的路径，这里按需补真实哈希。 */
  async stampOf(path:string,content=true):Promise<FileStamp>{
   const key=`${content?'sha':'stat'}:${path}`,known=this.stamps.get(key)
   if(known)return known
   const value=await fileStamp(path,content)
   this.stamps.set(key,value)
   return value
  }
  /**
   * 复制一个文件到便携目录：原件字节不动；目标已存在且可核验就跳过（重复保存/跨资源复用）。
   * 返回实际落点——**同一份真实字节（sha256+size 相同）在本次保存里只落一份**：记录里的依赖可能同时
   * 给出同一内容的两条路径（典型是 `.blend` 的 `<锚点>_deps/` 镜像位置与源工程实际读的绝对位置，
   * 见 resources.ts planCasStore），照单再复制一次只会让同一张纹理在包里出现两次。已经在包内的源文件
   * 保持它自己的位置（重复保存不改写文档里已写好的路径）。
   */
  async place(source:string,expected:FileStamp,target:string,label:string):Promise<string>{
   if(!inside(this.root,target))throw new Error(`PORTABLE_TARGET_OUTSIDE_ROOT: ${target}`)
   const content=expected.sha256?`${expected.sha256}:${expected.size}`:undefined
   const known=content?this.byContent.get(content):undefined
   if(known&&known!==target&&!inside(this.root,source))target=known
   if(content)this.byContent.set(content,target)
   this.placed.set(target,expected)
   const rewritten=this.rewrites.get(target)
   if(target!==source){
    // 只有能按内容哈希核验时才敢跳过复制（跨资源复用）；没有 sha 的一律重写，保持旧语义。
    // 本次保存里已改写过的副本同样不能重抄：改写后的字节才是它的现状，重抄会把改写退回去。
    const kept=expected.sha256?await fileStamp(target,true).catch(()=>undefined):undefined
    const settled=kept&&(kept.size===expected.size&&kept.sha256===expected.sha256||Boolean(rewritten&&kept.size===rewritten.after.size&&kept.sha256===rewritten.after.sha256))
    if(!settled){
     await mkdir(dirname(target),{recursive:true})
     await copyFile(source,target)
    }
   }
   const actual=await fileStamp(target,Boolean(expected.sha256||rewritten)),sourceAfter=await fileStamp(source,false)
   const derived=Boolean(rewritten&&actual.size===rewritten.after.size&&actual.sha256===rewritten.after.sha256)
   if(!derived&&(actual.size!==expected.size||(expected.sha256?actual.sha256!==expected.sha256:sourceAfter.mtimeMs!==expected.mtimeMs||sourceAfter.size!==expected.size)))throw new Error(`RESOURCE_VERSION_MISMATCH: ${label} ${source}`)
   this.targets.add(target)
   return target
  }

  /** 复制一个资源版本的依赖闭包，返回该资源的 source→target 映射。 */
  async copyResource(ref:ResourceRef,record:ResourceRecord|undefined):Promise<Map<string,string>>{
   // ENV-60：文档里的**相对 URI 相对文档所在目录**解析（＝本次导出的 base＝this.root），不能按进程 CWD 解析。
   // 便携包自己写出的就是相对 URI；按 CWD 解析会把 `save()` 导出到别的目录时的 stat 打到 CWD 下（ENOENT），
   // 或者（CWD 恰好同名时）静默复制错文件。base 与 `save()` 的 `base=dirname(path)` 是同一个值。
   // 兜底：导出目录下解析不到原件时再试宿主 CWD（会话内相对 URI 的既有形态，历史上靠 CWD 撞对），
   // 两条都不成立就由下面的闭包守卫/ENOENT 明确报错，不静默出包。
   // base 选择：导出目录（＝`save()` 的 base）优先；那里读不到原件时才退回宿主 CWD（会话内相对 URI 的既有形态）。
   // 两条都不成立 ⇒ 下面的 ENOENT / 闭包守卫明确报错，不静默出包。
   const base=await fileStamp(localPath(ref.original.uri,this.root),false).then(()=>this.root,()=>process.cwd())
   const source=localPath(ref.original.uri,base),parsed=record?.parsed??await parseAsset(source,ref.source)
   const dependencies=new Map(parsed.dependencies.map(stamp=>[localPath(stamp.path),stamp]))
   for(const rep of [ref.original,...ref.representations]){const path=localPath(rep.uri,base);if(!dependencies.has(path))dependencies.set(path,await fileStamp(path))}
   const copied=new Map<string,string>(),grouped=new Set<string>()
   // 源工程先按 .blend 分组：同一文件字节（sha）落在同一个 sources/ 根下，重复引用只落一份。
   for(const path of [...dependencies.keys()])if(extname(path).toLowerCase()==='.blend'&&!grouped.has(path))await this.copySourceProject(path,dependencies,copied,grouped,ref)
   const rest=[...dependencies.keys()].filter(path=>!grouped.has(path))
   if(rest.length){
    const bundle=join(this.root,'resources',`${ref.resourceId}-v${ref.version}`),common=commonDirectory(rest)
    for(const path of rest){const target=await this.place(path,dependencies.get(path)!,this.targetFor(path,join(bundle,relative(common,path))),`${ref.resourceId}@${ref.version}`);copied.set(path,target)}
   }
   for(const [file,target] of copied)if(['.xml','.mjcf','.urdf'].includes(extname(file).toLowerCase())&&await rewriteXML(file,target,copied))await this.markDerived(target)
   // 检查副本实际引用的闭包；不能把“复制过一些文件”当作脱离原路径。
   const portable=await parseAsset(copied.get(source)!,ref.source)
   for(const stamp of portable.dependencies)if(!inside(this.root,stamp.path))throw new Error(`PORTABLE_EXTERNAL_DEPENDENCY: ${stamp.path}`)
   // ENV-60 闭包守卫：文档**自己引用到的每个表示**（original + representations）都必须真的落进了包。
   // 缺了这条，"复制过别的文件"就会被当成闭包完整；搬到另一个绝对路径后才在 `scene_open` 处炸。
   // 缺件必须在出包这一步就拒绝（负对照：包内少一个 visuals 文件 ⇒ 这里报错，不是静默出包）。
   for(const rep of [ref.original,...ref.representations]){const path=localPath(rep.uri,base);if(!copied.has(path))throw new Error(`PORTABLE_REPRESENTATION_UNPLACED: ${rep.uri}（${ref.resourceId}@${ref.version} 的引用没有被复制进便携包）`)}
   return copied
  }

  /**
   * .blend 源工程：Blender 自己读外部依赖（图片/链接库/字体），连同依赖一起按相对层级镜像到
   * `sources/<sha16>/`。相对引用原样可解、副本逐字节等于原件；绝对引用在副本上用 Blender 改成
   * `//` 相对路径（只写副本）。最后对副本**再读一次**：外部依赖必须都落在便携目录内且真实存在，
   * 结构指纹与原件一致——这是依赖闭合的证据，不是"复制过文件"的推断。
   */
  private async copySourceProject(blend:string,dependencies:Map<string,FileStamp>,copied:Map<string,string>,grouped:Set<string>,ref:ResourceRef):Promise<void>{
   const files=new Set<string>([blend]),queue=[blend],seen=new Set([blend])
   const externals:Array<{host:string;raw:string;resolved:string}>=[]
   while(queue.length){
    const host=queue.pop()!,inspection=await this.inspectionOf(host)
    for(const row of inspection.externals){
     if(!row.exists)throw new Error(`PORTABLE_DEPENDENCY_MISSING: ${row.resolved}（源工程 ${host} 的外部依赖，便携打包要求文件在场）`)
     files.add(row.resolved)
     externals.push({host,raw:row.raw,resolved:row.resolved})
     if(extname(row.resolved).toLowerCase()==='.blend'&&!seen.has(row.resolved)){seen.add(row.resolved);queue.push(row.resolved)}
    }
   }
   const sha=(dependencies.get(blend)?.sha256??(await this.stampOf(blend,true)).sha256)
   if(!sha)throw new Error(`RESOURCE_CONTENT_UNVERIFIABLE: ${blend}`)
   const list=[...files],common=commonDirectory(list),root=join(this.root,'sources',sha.slice(0,16))
   // 落点以 place 的实际返回为准（同一份字节已在本次保存里落过位时不再复制第二份）。
   for(const file of list){const expected=dependencies.get(file)??await this.stampOf(file,true);copied.set(file,await this.place(file,expected,this.targetFor(file,join(root,relative(common,file))),`${ref.resourceId}@${ref.version}`));grouped.add(file)}
   const targetOf=(file:string)=>copied.get(file)!
   const byHost=new Map<string,Map<string,string>>()
   for(const row of externals)if(blendAbsolute(row.raw)){
    const rewritten='//'+relative(dirname(targetOf(row.host)),targetOf(row.resolved))
    if(rewritten===row.raw)continue
    const mapping=byHost.get(row.host)??new Map<string,string>()
    mapping.set(row.raw,rewritten)
    byHost.set(row.host,mapping)
   }
   for(const [host,mapping] of byHost){
    const target=targetOf(host)
    if(this.rewrites.has(target))continue
    // 改写以副本自己的当前引用为准：已经写成相对引用的副本（重复保存、同源工程被多个实体引用）
    // 不用再起一次 Blender，也不会被重复登记。
    const current=await this.inspectionOf(target)
    const pending=new Map([...mapping].filter(([raw])=>current.externals.some(row=>row.raw===raw)))
    if(!pending.size)continue
    await repathBlendCopy(target,pending)
    await this.markDerived(target)
    this.inspections.delete(target)
   }
   for(const file of list.filter(path=>extname(path).toLowerCase()==='.blend')){
    const before=await this.inspectionOf(file),after=await this.inspectionOf(targetOf(file))
    const external=after.externals.filter(row=>!row.exists||!inside(this.root,row.resolved))
    if(external.length)throw new Error(`PORTABLE_EXTERNAL_DEPENDENCY: ${external.map(row=>`${row.resolved}（${row.datablock}）`).join('、')}`)
    if(JSON.stringify(before.fingerprint)!==JSON.stringify(after.fingerprint))throw new Error(`PORTABLE_SOURCE_PROJECT_DERIVED: ${targetOf(file)} 的内容指纹与原件不一致（便携副本必须是同一工程，只允许改写外部路径）`)
   }
  }
}

/**
 * 用户显式指定的项目文件（脚本/参考图/贴图等）：镜像到 `project/` 下，保留它们彼此的相对层级，
 * 之后保存回同一位置时原样跳过。这不是第二份权威状态——只是把用户点名的文件随包带走。
 */
export async function copyPortableProjectFiles(archive:PortableArchive,files:string[],root:string):Promise<Map<string,string>>{
 const unique=[...new Set(files.map(file=>resolve(file)))]
 if(!unique.length)return new Map()
 for(const file of unique)if(!(await stat(file).catch(()=>undefined))?.isFile())throw new Error(`PORTABLE_PROJECT_FILE_NOT_FILE: ${file}`)
 const common=commonDirectory(unique),copied=new Map<string,string>()
 for(const file of unique){const target=inside(root,file)?resolve(file):join(root,relative(common,file));await archive.place(file,await archive.stampOf(file,true),target,'project');copied.set(file,target)}
 return copied
}

/** 兼容入口：单资源便携复制（等价于用一次性归档复制一个版本）。 */
export async function copyPortableResource(ref:ResourceRef,record:ResourceRecord|undefined,outputDirectory:string):Promise<Map<string,string>>{
 return new PortableArchive(outputDirectory).copyResource(ref,record)
}
