import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { readRiggedGlb } from '../packages/human-crowd/src/glb.ts'
import { ROCKETBOX_AVATAR_IDS, ROCKETBOX_SOURCE, ROCKETBOX_LICENSE_SHA256 } from '../packages/human-crowd/src/rocketbox-sample.ts'
import { catalogFile, safeAvatarRelative, validateRocketboxAvatar, type RocketboxAvatar, type RocketboxSourceFile } from '../packages/human-crowd/src/rocketbox-catalog.ts'
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const destination='packages/human-crowd/assets/rocketbox'
interface GallerySource {repository:string;revision:string;license:string;characters:Array<{id:string;preview:string;previewBytes:number;previewSha256:string;previewGitBlob:string}>}
/** 证据保留数值及原件文件名；构建机绝对路径不能成为离线运行依赖。 */
function portableEvidence(value:unknown):unknown{
 if(typeof value==='string')return isAbsolute(value)?basename(value):value
 if(Array.isArray(value))return value.map(portableEvidence)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,portableEvidence(item)]))
 return value
}
/** 对冻结资产做全量闭包校验再收集。只打包最终GLB与许可/来源，不复制原始FBX/TGA。 */
export async function stageHumanAvatarResources(_root:string,stage:string,sourceRoot:string){
 const root=await realpath(sourceRoot),manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) as {schema:number;gallery:string;avatars:Array<{avatarId:string;directory:string}>}
 const ids=manifest.avatars?.map(row=>row.avatarId)??[]
 if(manifest.schema!==1||ids.length!==12||new Set(ids).size!==12||ROCKETBOX_AVATAR_IDS.some(id=>!ids.includes(id)))throw Error('HUMAN_AVATAR_SUPPLY_INCOMPLETE: 必须提供固定12角色；实际='+ids.join(','))
 const galleryRoot=await catalogFile(root,manifest.gallery),gallery=JSON.parse(await readFile(join(galleryRoot,'candidates.json'),'utf8')) as GallerySource
 if(gallery.repository!==ROCKETBOX_SOURCE.repository||gallery.revision!==ROCKETBOX_SOURCE.revision||gallery.license!=='MIT'||!Array.isArray(gallery.characters)||gallery.characters.length!==12||new Set(gallery.characters.map(row=>row.id)).size!==12||ROCKETBOX_AVATAR_IDS.some(id=>!gallery.characters.some(row=>row.id===id)))throw Error('HUMAN_AVATAR_PREVIEW_INCOMPLETE: 必须提供固定12个官方原PNG')
 if(sha(await readFile(join(galleryRoot,'LICENSE.md')))!==ROCKETBOX_LICENSE_SHA256)throw Error('HUMAN_AVATAR_PREVIEW_LICENSE_MISMATCH')
 const validated=[]
 for(const id of ROCKETBOX_AVATAR_IDS){
  const supply=manifest.avatars.find(row=>row.avatarId===id)!
  safeAvatarRelative(supply.directory)
  const directory=await catalogFile(root,supply.directory),raw=JSON.parse(await readFile(join(directory,'source.json'),'utf8')) as RocketboxAvatar
  if(raw.avatarId!==id)throw Error('HUMAN_AVATAR_ID_MISMATCH: '+id)
  const candidate=gallery.characters.find(row=>row.id===id)!,preview=await catalogFile(galleryRoot,candidate.preview)
  if(!Number.isInteger(candidate.previewBytes)||candidate.previewBytes<=0||candidate.previewBytes>2*1024*1024||(await stat(preview)).size!==candidate.previewBytes)throw Error('HUMAN_AVATAR_PREVIEW_SIZE_MISMATCH: '+id)
  const previewBytes=await readFile(preview)
  if(previewBytes.length!==candidate.previewBytes||sha(previewBytes)!==candidate.previewSha256||createHash('sha1').update(Buffer.from('blob '+previewBytes.length+'\0')).update(previewBytes).digest('hex')!==candidate.previewGitBlob)throw Error('HUMAN_AVATAR_PREVIEW_HASH_MISMATCH: '+id)
  const row=validateRocketboxAvatar({...raw,preview:{path:id+'/preview.png',bytes:candidate.previewBytes,sha256:candidate.previewSha256,gitBlob:candidate.previewGitBlob,sourcePath:`Assets/Avatars/Adults/${id}/${id}.png`,kind:'upstream-official'},label:raw.label??id,attribution:raw.attribution??'Copyright (c) 2020 Microsoft. Microsoft Rocketbox, MIT.',sourceFiles:raw.sourceFiles?.map(({path,bytes,sha256,gitBlob}:RocketboxSourceFile)=>({path,bytes,sha256,...gitBlob?{gitBlob}:{}}))})
  const glb=await catalogFile(directory,row.glb),license=await catalogFile(directory,row.licenseFile)
  if((await stat(glb)).size!==row.bytes)throw Error('HUMAN_AVATAR_SIZE_MISMATCH: '+id)
  const bytes=await readFile(glb)
  if(sha(bytes)!==row.sha256)throw Error('HUMAN_AVATAR_HASH_MISMATCH: '+id)
  if(sha(await readFile(license))!==row.licenseSha256)throw Error('HUMAN_AVATAR_LICENSE_MISMATCH: '+id)
  const human=readRiggedGlb(bytes,row)
  if(!human.clips.some(clip=>clip.name===row.walkClip))throw Error('HUMAN_AVATAR_CLIP_MISSING: '+id)
  if(!human.footCollision?.segments['leftAnkle-leftToe']||!human.footCollision?.segments['rightAnkle-rightToe'])throw Error('HUMAN_AVATAR_FOOT_CALIBRATION_MISSING: '+id)
  const foot=JSON.parse(await readFile(await catalogFile(directory,'foot-calibration.json'),'utf8'))
  await catalogFile(directory,'verified-sources.json')
  const portable:RocketboxAvatar={avatarId:id,label:row.label,glb:id+'/character.glb',bytes:row.bytes,sha256:row.sha256,repository:row.repository,revision:row.revision,license:row.license,licenseFile:id+'/LICENSE-character.txt',licenseSha256:row.licenseSha256,attribution:row.attribution,sourceUpAxis:row.sourceUpAxis,metersPerUnit:row.metersPerUnit,headingOffsetRad:row.headingOffsetRad,walkClip:row.walkClip,walkSpeedMps:row.walkSpeedMps,boneMapping:row.boneMapping,sourceFiles:row.sourceFiles,preview:row.preview}
  validated.push({portable,glb,license,preview,foot:portableEvidence(foot),rigJoints:human.rig.length,clips:human.clips.map(clip=>clip.name)})
 }
 const target=join(stage,destination),allowedFiles:string[]=[]
 await rm(target,{recursive:true,force:true})
 for(const row of validated){
  const directory=join(target,row.portable.avatarId);await mkdir(directory,{recursive:true})
  await cp(row.glb,join(directory,'character.glb'));await cp(row.license,join(directory,'LICENSE-character.txt'));await cp(row.preview,join(directory,'preview.png'))
  await writeFile(join(directory,'source.json'),JSON.stringify({...row.portable,glb:'character.glb',licenseFile:'LICENSE-character.txt',preview:{...row.portable.preview,path:'preview.png'}},null,2)+'\n')
  await writeFile(join(directory,'verified-sources.json'),JSON.stringify({repository:row.portable.repository,revision:row.portable.revision,files:row.portable.sourceFiles},null,2)+'\n')
  await writeFile(join(directory,'foot-calibration.json'),JSON.stringify(row.foot,null,2)+'\n')
  for(const file of ['character.glb','preview.png','LICENSE-character.txt','source.json','verified-sources.json','foot-calibration.json'])allowedFiles.push(destination+'/'+row.portable.avatarId+'/'+file)
 }
 const catalog={schema:1,avatars:validated.map(row=>row.portable)},catalogBytes=Buffer.from(JSON.stringify(catalog,null,2)+'\n')
 await writeFile(join(target,'catalog.json'),catalogBytes);allowedFiles.push(destination+'/catalog.json')
 return{catalog:destination+'/catalog.json',catalogSha256:sha(catalogBytes),entries:validated.map(row=>({avatarId:row.portable.avatarId,path:destination+'/'+row.portable.glb,bytes:row.portable.bytes,sha256:row.portable.sha256,licenseFile:destination+'/'+row.portable.licenseFile,licenseSha256:row.portable.licenseSha256,sourceRevision:row.portable.revision,preview:{...row.portable.preview!,path:destination+'/'+row.portable.preview!.path},rigJoints:row.rigJoints,clips:row.clips})),allowedFiles,bytes:validated.reduce((sum,row)=>sum+row.portable.bytes,0),previewBytes:validated.reduce((sum,row)=>sum+row.portable.preview!.bytes,0),previewNotice:'上游官方原图；不是本项目World或GPU运行结果'}
}
if(import.meta.main){const [source,stage]=process.argv.slice(2);if(!source||!stage)throw Error('用法：bun script/human-avatar-resources.ts <冻结资源根> <目标发行根>');console.log(JSON.stringify(await stageHumanAvatarResources(resolve(import.meta.dirname,'..'),resolve(stage),resolve(source)),null,2))}
