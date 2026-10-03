import {readFile,stat} from 'node:fs/promises'
import {dirname,join,relative,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import type {Entity,ResourceRef,SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import type {ResourceLibrary,ResourceRecord} from './resources.ts'
import {localPath} from './formats.ts'
import {physicalizationBudgets,type PhysicalizationBudgetOptions} from './physicalization-parameters.ts'

const MAX_MANIFEST_BYTES=16*1024*1024
const key=(ref:{resourceId:string;version:number})=>`${ref.resourceId}@${ref.version}`
const partsOf=(entity:Entity):string[]=>{
  const parts=entity.components.collision?.parts
  if(parts===undefined)return []
  if(!Array.isArray(parts)||!parts.length||parts.some(part=>typeof part!=='string'||!part.trim()))throw Error('COLLISION_PARTS_INVALID: parts 必须是非空本地引用数组')
  return parts
}
const isDerived=(entity:Entity)=>String(entity.components.collision?.source??'').startsWith('asset-bake-')
const samePath=(a:string,b:string)=>localPath(a)===localPath(b)

/** 当前变体与历史变体都从发布引用中定位；不从最新默认组件替换已挂载历史变体。 */
export function activeCollisionUris(library:ResourceLibrary,record:ResourceRecord):string[]{
  if(record.physicalization?.artifactUris)return [...record.physicalization.artifactUris]
  const p=record.physicalization
  if(p?.status!=='ok')return []
  const variant=`${p.strategy??'auto'}${p.voxelSizeM!==undefined?`-voxel${p.voxelSizeM}`:''}@${p.policy??'cavity-safe-1'}`
  const directory=join(library.derivedRoot,record.ref.resourceId,`v${record.ref.version}`,'collision',p.usage??'dynamic',variant)
  const manifest=record.ref.representations.find(rep=>rep.role==='collision'&&localPath(rep.uri)===join(directory,'physicalization.json'))
  const parts=Array.isArray(record.componentDefaults?.collision?.parts)?record.componentDefaults!.collision!.parts as string[]:[]
  return [...new Set([...parts,...manifest?[manifest.uri]:[]])]
}

/** 给旧产物补证据前核清单和真实来源；只回当前字节事实，不伪造旧时间点的历史SHA。 */
async function legacyClosure(library:ResourceLibrary,record:ResourceRecord,uris:readonly string[]):Promise<string[]>{
  const registered=record.ref.representations.filter(rep=>rep.role==='collision')
  const manifests=new Set<string>()
  for(const uri of uris){
    if(!registered.some(rep=>samePath(rep.uri,uri)))throw Error('COLLISION_RESOURCE_MISMATCH: 碰撞件不属于所选资源版本')
    const path=localPath(uri),manifest=path.endsWith('/physicalization.json')?path:join(dirname(path),'physicalization.json')
    if(!registered.some(rep=>samePath(rep.uri,manifest)))throw Error('COLLISION_MANIFEST_REQUIRED: 旧派生缺少同版本发布清单，需显式重新派生')
    manifests.add(manifest)
  }
  if(!(await library.verify(record.ref.resourceId,record.ref.version)).valid)throw Error('PHYSICS_BIND_ORIGINAL_UNVERIFIED: 核旧派生前先恢复同版本原件')
  const closure=new Set(uris)
  for(const manifest of manifests){
    const info=await stat(manifest)
    if(!info.isFile()||info.size>MAX_MANIFEST_BYTES)throw Error('COLLISION_MANIFEST_INVALID: 清单缺失或超过读取预算')
    const value=JSON.parse(await readFile(manifest,'utf8')) as {sourcePath?:string;sourcePreserved?:boolean;units?:string;upAxis?:string;objects?:Array<{node?:unknown;parts?:string[]}>}
    const locations=[record.ref,...(record.alternateLocations??[]).map(location=>location.ref)]
    if(typeof value.sourcePath!=='string'||!locations.some(ref=>samePath(ref.original.uri,value.sourcePath!))||value.sourcePreserved!==true||value.units!=='m'||value.upAxis!=='Z'||!Array.isArray(value.objects)||!value.objects.length)throw Error('COLLISION_MANIFEST_SOURCE_MISMATCH: 清单必须对应同版本原件和米制Z-up派生')
    const listed=value.objects.flatMap(object=>object.parts??[])
    for(const part of listed){
      if(typeof part!=='string'||!registered.some(rep=>samePath(rep.uri,part)))throw Error('COLLISION_RESOURCE_MISMATCH: 清单声明了未登记碰撞件')
      if(dirname(localPath(part))!==dirname(manifest))throw Error('COLLISION_MANIFEST_SCOPE_MISMATCH: 派生件不在所登记变体中')
      closure.add(pathToFileURL(localPath(part)).href)
    }
    for(const uri of uris.filter(uri=>dirname(localPath(uri))===dirname(manifest)&&!localPath(uri).endsWith('/physicalization.json')))
      if(!listed.some(part=>samePath(part,uri)))throw Error('COLLISION_MANIFEST_INCOMPLETE: 请求件不在同变体清单中')
    closure.add(pathToFileURL(manifest).href)
  }
  return [...closure]
}

export async function ensureCollisionArtifacts(library:ResourceLibrary,record:ResourceRecord,uris:readonly string[],options:{full?:boolean}={full:true}):Promise<void>{
  if(!uris.length)return
  const selected=[...new Set([...uris,...uris.flatMap(uri=>{
    const manifest=join(dirname(localPath(uri)),'physicalization.json')
    const rep=record.ref.representations.find(rep=>rep.role==='collision'&&samePath(rep.uri,manifest))
    return rep?[rep.uri]:[]
  })])]
  let check=await library.verifyCollisionArtifacts(record.ref.resourceId,record.ref.version,selected,options)
  if(check.unverified.length){
    const closure=await legacyClosure(library,record,selected)
    await library.adoptCollisionArtifacts(record.ref.resourceId,record.ref.version,closure)
    check=await library.verifyCollisionArtifacts(record.ref.resourceId,record.ref.version,closure)
  }
  if(!check.valid)throw Error(`COLLISION_ARTIFACT_UNAVAILABLE: ${check.changed.length?'派生字节改变':check.missing.length?'派生缓存缺件':'派生未核验'}；请恢复同版本碰撞`)
}

/** 用途来自同版本已发布变体的结构化位置，不能用资源的最新默认覆盖历史挂载。 */
export function collisionVariant(record:ResourceRecord,uris:readonly string[]):PhysicalizationBudgetOptions&{usage:'dynamic'|'static'|'environment';strategy:'auto'|'convex_hull'|'voxel_boxes'|'coacd'|'triangle_mesh'|'sdf';policy:string}|undefined{
  let result:ReturnType<typeof collisionVariant>
  for(const uri of uris){
    if(!record.ref.representations.some(rep=>rep.role==='collision'&&samePath(rep.uri,uri)))return
    const marker=`/derived/${record.ref.resourceId}/v${record.ref.version}/collision/`,path=localPath(uri),at=path.lastIndexOf(marker)
    if(at<0)return
    const match=path.slice(at+marker.length).match(/^(dynamic|static|environment)\/(auto|convex_hull|voxel_boxes|coacd|triangle_mesh|sdf)(?:-voxel([0-9.eE+-]+))?@([^/]+)\//)
    if(!match)return
    const recipe=record.physicalizationVariants?.find(variant=>variant.artifactUris.some(candidate=>samePath(candidate,uri)))
    if(match[4]!.includes('-limits-')&&!recipe)return
    const item={usage:match[1] as 'dynamic'|'static'|'environment',strategy:match[2] as 'auto'|'convex_hull'|'voxel_boxes'|'coacd'|'triangle_mesh'|'sdf',policy:recipe?.parameters.policy??match[4]!,...match[3]!==undefined?{voxelSizeM:Number(match[3])}:{},...physicalizationBudgets(recipe?.parameters)}
    if(item.voxelSizeM!==undefined&&(!Number.isFinite(item.voxelSizeM)||item.voxelSizeM<=0))return
    if(result&&!isDeepStrictEqual(result,item))return
    result=item
  }
  return result
}

/** 缺失旧URI仅按该资源版本发布的完整 derived 尾部匹配，不按文件名或删前缀猜文件。 */
export async function resolveLegacyCollisionUri(library:ResourceLibrary,record:ResourceRecord,uri:string):Promise<string>{
  const known=record.ref.representations.filter(rep=>rep.role==='collision')
  const direct=known.find(rep=>samePath(rep.uri,uri))
  if(direct)return direct.uri
  const marker=`/derived/${record.ref.resourceId}/v${record.ref.version}/collision/`,path=localPath(uri),index=path.lastIndexOf(marker)
  if(index<0||await stat(path).then(()=>true,()=>false))throw Error('COLLISION_RESOURCE_MISMATCH: 不从现存未知文件或别的资源版本恢复')
  const tail=path.slice(index)
  const matches=known.filter(rep=>{const candidate=localPath(rep.uri);return candidate.endsWith(tail)&&relative(resolve(library.derivedRoot,record.ref.resourceId,`v${record.ref.version}`),candidate).split(/[\\/]/)[0]!=='..'})
  if(matches.length!==1)throw Error('COLLISION_RECOVERY_AMBIGUOUS: 旧路径没有唯一同版本已发布变体')
  await ensureCollisionArtifacts(library,record,[matches[0]!.uri])
  return matches[0]!.uri
}

/** 所有 Scene 写入共用闸口；自定义原生形状不改，网格件不允许缺失或串资源。 */
export async function validateSceneCollisionReferences(library:ResourceLibrary,snapshot:SceneSnapshot,previous?:SceneSnapshot):Promise<void>{
  const seen=new Set<string>(),records=new Map<string,ResourceRecord>()
  for(const entity of snapshot.entities){
    const parts=partsOf(entity);if(!parts.length)continue
    if(!isDerived(entity)){
      for(const uri of parts){const path=localPath(uri);if(!await stat(path).then(s=>s.isFile(),()=>false))throw Error('COLLISION_MESH_NOT_FOUND: 自定义碰撞文件缺失')}
      continue
    }
    const before=previous?.entities.find(e=>e.entityId===entity.entityId)
    const unchanged=before&&isDeepStrictEqual(before.components.collision,entity.components.collision)
    const sameReference=before&&isDeepStrictEqual(before.resources,entity.resources)&&isDeepStrictEqual(before.components.physicsBinding,entity.components.physicsBinding)
    const binding=entity.components.physicsBinding as {resourceId?:string;version?:number}|undefined
    const candidates=[...entity.resources]
    // 几何已由replaceResource证明相同的旧派生保留：只能沿用上一版本已经存在的相同组件/绑定。
    if(unchanged&&binding?.resourceId&&binding.version!==undefined&&isDeepStrictEqual(before.components.physicsBinding,entity.components.physicsBinding)&&!candidates.some(ref=>key(ref)===key(binding as ResourceRef)))
      candidates.push({resourceId:binding.resourceId,version:binding.version} as ResourceRef)
    let owned:ResourceRecord|undefined
    for(const ref of candidates){
      const id=key(ref);let record=records.get(id)
      if(!record){record=await library.get(ref.resourceId,ref.version);records.set(id,record)}
      if(parts.every(uri=>record!.ref.representations.some(rep=>rep.role==='collision'&&samePath(rep.uri,uri)))){owned=record;break}
    }
    if(!owned)throw Error('COLLISION_RESOURCE_MISMATCH: 碰撞件必须登记在当前资源版本，不能手拼路径')
    const fingerprint=key(owned.ref)+'|'+parts.join('|')
    if(!seen.has(fingerprint)){await ensureCollisionArtifacts(library,owned,parts,{full:!(unchanged&&sameReference)});seen.add(fingerprint)}
  }
}
