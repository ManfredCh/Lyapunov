import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUMAN_GLB_MAX_BYTES } from './glb.ts'
import { HUMAN_AVATAR_ROOT_ENV } from './env.ts'
import { ROCKETBOX_AVATAR_IDS, ROCKETBOX_LICENSE_SHA256, ROCKETBOX_SOURCE, type RocketboxAvatarId } from './rocketbox-sample.ts'
export interface RocketboxSourceFile {path:string;bytes:number;sha256:string;gitBlob?:string}
export interface RocketboxPreview {path:string;bytes:number;sha256:string;gitBlob:string;sourcePath:string;kind:'upstream-official'}
export interface RocketboxAvatar {
 avatarId:RocketboxAvatarId; label:string; glb:string; bytes:number; sha256:string; repository:string; revision:string
 license:'MIT'; licenseFile:string; licenseSha256:string; attribution:string; sourceUpAxis:'Y'|'Z'; metersPerUnit:number
 headingOffsetRad:number; walkClip:string; walkSpeedMps:number; boneMapping:Record<string,string>; sourceFiles:RocketboxSourceFile[];preview?:RocketboxPreview
}
export interface RocketboxCatalog {schema:1;avatars:RocketboxAvatar[]}
export { HUMAN_AVATAR_ROOT_ENV }
export const rocketboxCatalogRoot=()=>process.env[HUMAN_AVATAR_ROOT_ENV]??resolve(dirname(fileURLToPath(import.meta.url)),'../assets/rocketbox')
export function safeAvatarRelative(path:unknown):asserts path is string {if(typeof path!=='string'||!path||isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('HUMAN_CATALOG_PATH_INVALID: '+String(path))}
export function validateRocketboxAvatar(value:unknown):RocketboxAvatar {
 const row=value as RocketboxAvatar
 if(!row||!ROCKETBOX_AVATAR_IDS.includes(row.avatarId)||row.repository!==ROCKETBOX_SOURCE.repository||row.revision!==ROCKETBOX_SOURCE.revision||row.license!=='MIT'||row.licenseSha256!==ROCKETBOX_LICENSE_SHA256)throw Error('HUMAN_CATALOG_SOURCE_INVALID: '+String(row?.avatarId))
 safeAvatarRelative(row.glb);safeAvatarRelative(row.licenseFile)
 if(row.preview){safeAvatarRelative(row.preview.path);safeAvatarRelative(row.preview.sourcePath);if(row.preview.kind!=='upstream-official'||!Number.isInteger(row.preview.bytes)||row.preview.bytes<=0||row.preview.bytes>2*1024*1024||!/^[a-f0-9]{64}$/.test(row.preview.sha256)||!/^[a-f0-9]{40}$/.test(row.preview.gitBlob)||row.preview.sourcePath!==`Assets/Avatars/Adults/${row.avatarId}/${row.avatarId}.png`)throw Error('HUMAN_CATALOG_PREVIEW_INVALID: '+row.avatarId)}
 if(!Number.isInteger(row.bytes)||row.bytes<=0||row.bytes>HUMAN_GLB_MAX_BYTES||! /^[a-f0-9]{64}$/.test(row.sha256)||!['Y','Z'].includes(row.sourceUpAxis)||!Number.isFinite(row.metersPerUnit)||row.metersPerUnit<=0||!Number.isFinite(row.headingOffsetRad)||!row.walkClip||!Number.isFinite(row.walkSpeedMps)||row.walkSpeedMps<=0||row.walkSpeedMps>6||!row.boneMapping||typeof row.boneMapping!=='object')throw Error('HUMAN_CATALOG_METADATA_INVALID: '+row.avatarId)
 if(!Array.isArray(row.sourceFiles)||!row.sourceFiles.length)throw Error('HUMAN_CATALOG_SOURCE_FILES_MISSING: '+row.avatarId)
 for(const source of row.sourceFiles){safeAvatarRelative(source.path);if(!Number.isInteger(source.bytes)||source.bytes<=0||! /^[a-f0-9]{64}$/.test(source.sha256)||source.gitBlob!==undefined&&!/^[a-f0-9]{40}$/.test(source.gitBlob))throw Error('HUMAN_CATALOG_SOURCE_FILE_INVALID: '+row.avatarId+'/'+source.path)}
 return row
}
export async function catalogFile(root:string,path:string):Promise<string>{safeAvatarRelative(path);const base=await realpath(root),file=await realpath(join(base,path)),inside=relative(base,file);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw Error('HUMAN_CATALOG_PATH_ESCAPE: '+path);return file}
export async function loadRocketboxCatalog(root=rocketboxCatalogRoot()):Promise<RocketboxCatalog>{
 let raw:unknown;try{raw=JSON.parse(await readFile(join(root,'catalog.json'),'utf8'))}catch(error){throw Error('HUMAN_CATALOG_UNAVAILABLE: 内置12角色资源未完整安装；'+String(error))}
 const catalog=raw as RocketboxCatalog
 if(catalog.schema!==1||!Array.isArray(catalog.avatars))throw Error('HUMAN_CATALOG_INVALID')
 const avatars=catalog.avatars.map(validateRocketboxAvatar)
 if(avatars.length!==ROCKETBOX_AVATAR_IDS.length||new Set(avatars.map(row=>row.avatarId)).size!==ROCKETBOX_AVATAR_IDS.length||ROCKETBOX_AVATAR_IDS.some(id=>!avatars.some(row=>row.avatarId===id)))throw Error('HUMAN_CATALOG_INCOMPLETE: 必须包含用户确认的全部12角色')
 return{schema:1,avatars}
}
export async function verifiedRocketboxAvatar(avatar:RocketboxAvatar,root=rocketboxCatalogRoot()):Promise<string>{
 const path=await catalogFile(root,avatar.glb),size=(await stat(path)).size
 if(size!==avatar.bytes)throw Error('HUMAN_CATALOG_SIZE_MISMATCH: '+avatar.avatarId)
 const bytes=await readFile(path)
 if(createHash('sha256').update(bytes).digest('hex')!==avatar.sha256)throw Error('HUMAN_CATALOG_HASH_MISMATCH: '+avatar.avatarId)
 const license=await readFile(await catalogFile(root,avatar.licenseFile))
 if(createHash('sha256').update(license).digest('hex')!==avatar.licenseSha256)throw Error('HUMAN_CATALOG_LICENSE_MISMATCH: '+avatar.avatarId)
 return path
}
