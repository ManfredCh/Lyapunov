import { execFile } from 'node:child_process'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname, relative, sep } from 'node:path'
import type { Entity, ResourceRef, SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'
import type { UsdAssetFacts, UsdInstanceOverrides, UsdSourceFacts } from '../../lyapunov-contracts/src/usd.ts'
import type { SceneOperations } from './operations.ts'
import type { ResourceLibrary, ResourceRecord } from './resources.ts'
import type {UsdMdlDeclaration} from './usd-standard-libraries.ts'

export interface UsdInspection { files: string[]; usd: UsdAssetFacts; aabb?: { min: number[]; max: number[] }; absoluteAssetPaths: Array<{layer: string; assetPath: string}> }
function usdProductRoot():string {return process.env.LYAPUNOV_PRODUCT_ROOT?.trim() || fileURLToPath(new URL('../../../',import.meta.url))}
export function usdPython(): string {return process.env.LYAPUNOV_USD_PYTHON?.trim() || resolve(usdProductRoot(),'.runtime/usd-python/bin/python')}
/** 其它插件内联formats时仍消费scene-kit的唯一worker；不依赖调用方dist旁恰好存在副本。 */
function usdWorker():string {return resolve(usdProductRoot(),'packages/scene-kit',import.meta.url.endsWith('.ts')?'src/usd_asset.py':'dist/usd_asset.py')}
function usdExecutionError(error:Error,stderr:string,prefix:string):Error {
 if((error as NodeJS.ErrnoException).code==='ENOENT')return Error(`USD_RUNTIME_UNAVAILABLE: 找不到USD解析器Python ${usdPython()}。请检查LYAPUNOV_USD_PYTHON，或在产品目录运行 ./distribution/linux/install-usd-parser，再重启Host。`)
 if(stderr.includes('RuntimeError: USD_RUNTIME_UNAVAILABLE:'))return Error(`USD_RUNTIME_DEPENDENCY_MISSING: 指定的USD解析器环境缺少pxr/配套模块；请运行 ./distribution/linux/install-usd-parser，或修复LYAPUNOV_USD_PYTHON指定环境。${stderr.trim().slice(-1200)}`)
 return Error(prefix+': '+(stderr.trim().slice(-3000)||error.message))
}
/** 只读USD原件；错误不降格成“没有依赖”。 */
export async function inspectUsd(path: string, overrides: UsdInstanceOverrides = {}, options:{signal?:AbortSignal} = {}): Promise<UsdInspection> {
  const script = usdWorker()
  return new Promise((settle, fail) => execFile(usdPython(), [script, path, JSON.stringify(overrides)], { signal:options.signal, timeout: 120_000, maxBuffer: 96 * 1024 * 1024, env: {...process.env, HF_ENDPOINT:'https://hf-mirror.com'} }, async (error, stdout, stderr) => {
    if(error){fail(usdExecutionError(error,String(stderr),'USD_INSPECTION_FAILED'));return}
    let parsed:UsdInspection
    try { parsed=JSON.parse(stdout) } catch { fail(new Error('USD_INSPECTION_INVALID_OUTPUT'));return }
    if(Array.isArray(parsed.files)){
      const ancestors:{alias:string,real:string}[]=[]
      for(let a=dirname(resolve(path));;a=dirname(a)){
        const real=await realpath(a).catch(()=>null)
        if(real&&real!==a)ancestors.push({alias:a,real})
        if(dirname(a)===a)break
      }
      if(ancestors.length)parsed.files=parsed.files.map(file=>{
        for(const{alias,real}of ancestors){if(file===real||file.startsWith(real+sep))return join(alias,relative(real,file))}
        return file
      })
    }
    settle(parsed)
  }))
}
export async function usdVisual(resources: ResourceLibrary, source: ResourceRecord, overrides: UsdInstanceOverrides = {}): Promise<{visual:Entity['components']['visual'];ref:ResourceRef;sourceFacts:UsdSourceFacts}> {
  const { usd } = await inspectUsd(fileURLToPath(source.ref.original.uri), overrides)
  const textures=usd.preview.textures??[]
  const previewPayload={...usd.preview,textures:textures.map(({assetPath,uri,...texture})=>texture)}
  const payload={schema:'lyapunov.usd-preview.v1',sourceResourceId:source.ref.resourceId,sourceVersion:source.ref.version,sourceSha256:source.parsed.dependencies.find(row=>row.path===fileURLToPath(source.ref.original.uri))?.sha256,overrides,preview:previewPayload}
  const bytes=JSON.stringify(payload),hash=createHash('sha256').update(bytes).digest('hex')
  const directory=join(resources.derivedRoot,'usd-preview',hash);await mkdir(directory,{recursive:true})
  if(textures.length)await new Promise<void>((settle,fail)=>execFile(usdPython(),[usdWorker(),'--extract-textures',JSON.stringify(textures.map(texture=>({...texture,target:join(directory,texture.file)})))],{timeout:120000,maxBuffer:1024*1024},(error,_stdout,stderr)=>error?fail(usdExecutionError(error,String(stderr),'USD_TEXTURE_EXTRACTION_FAILED')):settle()))
  const path=join(directory,'geometry.usd-preview.json');await writeFile(path,bytes)
  const preview=await resources.import({path,name:source.name+'（USD派生预览）',resourceId:'usd_preview_'+hash.slice(0,24),storage:'reference',tags:['usd-preview'],source:source.ref.source,derivedFrom:{kind:'usd-preview',from:source.ref.version,resourceId:source.ref.resourceId,version:source.ref.version,overrides,at:new Date().toISOString()}})
  const sourceFacts:UsdSourceFacts={resourceId:source.ref.resourceId,version:source.ref.version,purpose:source.category==='robot'?'robot':source.category==='scene'?'scene':'object',physics:{rigidBodies:usd.physics.rigidBodies.length,collisions:usd.physics.collisions.length,joints:usd.physics.joints.length,articulations:usd.physics.articulations.length}}
  return {sourceFacts,ref:preview.ref,visual:{kind:'usd',usdPreviewResourceId:preview.ref.resourceId,usdPreviewSourceVersion:source.ref.version,usdPreviewStatus:usd.preview.status,usdPreviewLosses:usd.preview.losses,usdDefaultPrim:usd.defaultPrim,sourceTransformApplied:false}}
}
/** 人工Command与Agent工具共用：场景CAS覆盖，不创建资源版本，不写源layer。 */
export async function setUsdInstance(operations: SceneOperations, input: UsdInstanceOverrides & { sceneId: string; entityId: string; expectedRevision: number }): Promise<SceneSnapshot> {
  const scene = await operations.scene.snapshot(input.sceneId)
  if(scene.revision!==input.expectedRevision)throw Error(`SCENE_REVISION_CONFLICT: expected=${input.expectedRevision} actual=${scene.revision}`)
  const entity = scene.entities.find(row=>row.entityId===input.entityId)
  if (!entity) throw Error(`ENTITY_NOT_FOUND: ${input.entityId}`)
  const ref = entity.resources.find(ref=>ref.original.mimeType==='model/vnd.usd')
  if (!ref) throw Error(`USD_RESOURCE_REQUIRED: ${input.entityId}`)
  const record=await operations.resources.get(ref.resourceId,ref.version)
  const overrides: UsdInstanceOverrides = { ...(input.primPath?{primPath:input.primPath}:{}), ...(input.variants?{variants:input.variants}:{}) }
  const preview=await usdVisual(operations.resources,record,overrides)
  return operations.scene.commit({sceneId:input.sceneId,expectedRevision:input.expectedRevision,patch:[{op:'update',entityId:input.entityId,changes:{resources:[...entity.resources.filter(row=>row.original.mimeType!=='application/vnd.lyapunov.usd-preview+json'),preview.ref],components:{...entity.components,usd:{...overrides,sourceFacts:preview.sourceFacts},visual:preview.visual}}}]})
}

/** 仅对便携副本改写绝对layer资产引用，原件不进入编辑目标。 */
export async function repathUsdCopies(mapping:Map<string,string>):Promise<string[]> {
 const script=usdWorker()
 return new Promise((settle,fail)=>execFile(usdPython(),[script,'--repath',JSON.stringify(Object.fromEntries(mapping))],{timeout:120000,maxBuffer:1024*1024},(error,stdout,stderr)=>{if(error){fail(usdExecutionError(error,String(stderr),'USD_REPATH_FAILED'));return}try{settle(JSON.parse(stdout).changed)}catch{fail(Error('USD_REPATH_INVALID_OUTPUT'))}}))
}

/** 来源适配在依赖尚未取得时逐层读取真实Sdf引用，不用正则猜组合语义。 */
export async function usdLayerDependencies(path:string,signal?:AbortSignal):Promise<string[]> {
 return new Promise((settle,fail)=>execFile(usdPython(),[usdWorker(),'--layer-dependencies',path],{signal,timeout:120000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{if(error){fail(usdExecutionError(error,String(stderr),'USD_LAYER_INSPECTION_FAILED'));return}try{settle(JSON.parse(stdout).references)}catch{fail(Error('USD_LAYER_INSPECTION_INVALID_OUTPUT'))}}))
}

export async function usdMdlDeclarations(path:string,signal?:AbortSignal):Promise<UsdMdlDeclaration[]> {
 return new Promise((settle,fail)=>execFile(usdPython(),[usdWorker(),'--mdl-declarations',path],{signal,timeout:120000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{if(error){fail(usdExecutionError(error,String(stderr),'USD_MDL_INSPECTION_FAILED'));return}try{settle(JSON.parse(stdout).declarations)}catch{fail(Error('USD_MDL_INSPECTION_INVALID_OUTPUT'))}}))
}
