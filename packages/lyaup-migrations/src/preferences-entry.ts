import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {atomicJSON,fileTransaction} from '../../scene-kit/src/persistence.ts'
import {migratePreferences,applyLegacyApprovalPreference,type PreferenceSource,type PreferenceItem} from './preferences.ts'
export type MigrationMode='formal'|'developer'
export interface ScopedPreferenceSources {mode:MigrationMode;accountKey:string;sources:PreferenceSource[];webOrigins?:string[]}
interface PreferenceEntryOptions {mode?:MigrationMode;accountKey:string;sourceLabel:string;dshHome:string;preferences?:ScopedPreferenceSources}
export interface ApprovalMigrationItem {sessionId:string;applied:boolean;preservedExisting?:boolean;policy?:string;eventType?:string;eventSeq?:number;eventCount?:number;reason?:string}
export interface IntegratedPreferences {
 requested:boolean;status:'NOT_REQUESTED'|'BLOCKED'|'PARTIAL'|'PASS';exitCode:number;mode?:MigrationMode;accountKey:string;
 sourceStatus:'NOT_REQUESTED'|'MISSING'|'METADATA_ONLY'|'EXPLICIT';reasons:string[];items:PreferenceItem[];
 sources:PreferenceSource[];missing:string[];sourceUnchanged:boolean;applied:number;unchanged:number;preservedExisting:number;unapplied:number;
 approval:ApprovalMigrationItem[];nativeSettings?:unknown;settingsPhaseReport?:string;
}
/** 显式来源声明和目标Profile绑定；不从账号名、文件内容或浏览器目录猜模式。 */
export function validatePreferenceScope(options:PreferenceEntryOptions){
 const source=options.preferences;if(source===undefined)return
 if(!source||typeof source!=='object')throw new Error('PREFERENCE_SOURCE_INVALID')
 if(!['formal','developer'].includes(options.mode??''))throw new Error('PREFERENCE_TARGET_MODE_REQUIRED')
 if(source.mode!==options.mode||source.accountKey!==options.accountKey)throw new Error('PREFERENCE_SOURCE_SCOPE_MISMATCH')
 if(!Array.isArray(source.sources)||source.sources.some(s=>!s||!['electron-settings','electron-global','web-storage-export','migration-metadata'].includes(s.kind)||typeof s.path!=='string'||!s.path.trim()))throw new Error('PREFERENCE_SOURCE_INVALID')
 if(source.sources.some(s=>s.kind==='web-storage-export')&&(!Array.isArray(source.webOrigins)||!source.webOrigins.length||source.webOrigins.some(origin=>typeof origin!=='string'||!/^https?:\/\//.test(origin))))throw new Error('PREFERENCE_WEB_ORIGIN_REQUIRED')
}
export async function preparePreferenceMigration(options:PreferenceEntryOptions):Promise<IntegratedPreferences>{
 const requested=options.preferences!==undefined
 const result:IntegratedPreferences={requested,status:requested?'BLOCKED':'NOT_REQUESTED',exitCode:requested?2:0,mode:options.mode,accountKey:options.accountKey,sourceStatus:requested?'MISSING':'NOT_REQUESTED',reasons:requested?['NO_CONFIRMED_PREFERENCE_SOURCE']:[],items:[],sources:options.preferences?.sources.map(s=>({...s,path:resolve(s.path)}))??[],missing:[],sourceUnchanged:true,applied:0,unchanged:0,preservedExisting:0,unapplied:0,approval:[]}
 if(!requested)return result
 validatePreferenceScope(options)
 const ownerPath=join(resolve(options.dshHome),'migrations','preferences-owner.json')
 await fileTransaction(ownerPath,async()=>{
  let existing:any
  try{existing=JSON.parse(await readFile(ownerPath,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(existing&&(existing.accountKey!==options.accountKey||existing.mode!==options.mode))throw new Error('PREFERENCE_TARGET_SCOPE_MISMATCH')
  if(!existing)await atomicJSON(ownerPath,{accountKey:options.accountKey,mode:options.mode})
 })
 if(!result.sources.length)return result
 result.sourceStatus=result.sources.some(s=>s.kind!=='migration-metadata')?'EXPLICIT':'METADATA_ONLY'
 result.reasons=result.sourceStatus==='METADATA_ONLY'?['NO_UI_PREFERENCE_SOURCE']:[]
 try{
  const native=await migratePreferences({sourceLabel:options.sourceLabel,accountKey:options.accountKey,dshHome:options.dshHome,sources:result.sources,webOrigins:options.preferences?.webOrigins})
  Object.assign(result,{items:native.items,sources:native.sources,missing:native.missing,sourceUnchanged:native.sourceUnchanged,applied:native.applied,unchanged:native.unchanged,preservedExisting:native.preservedExisting,unapplied:native.unapplied,nativeSettings:native.nativeSettings,settingsPhaseReport:join(options.dshHome,'migrations',options.sourceLabel,'preferences','result.json')})
  if(native.missing.length)result.reasons.push('PREFERENCE_SOURCE_MISSING')
  if(!native.sourceUnchanged)result.reasons.push('PREFERENCE_SOURCE_CHANGED')
 }catch(error){result.reasons.push(error instanceof Error?error.message:String(error))}
 return result
}
/** 在已迁入Session上追加唯一原生ask策略；不会覆盖用户现有policy或preset。 */
export async function finishPreferenceMigration(ctx:Context,options:PreferenceEntryOptions,result:IntegratedPreferences,sessionIds:string[]){
 if(!result.requested)return result
 const approvalItems=result.items.filter(item=>item.field==='permissions.autoApprove'),values=[...new Set(approvalItems.map(item=>item.value))]
 if(values.length===1&&values[0]===false&&!result.missing.length&&result.sourceUnchanged&&!result.reasons.length){
  for(const id of sessionIds){
   try{
    const handle=await ctx.sessionPersistence.open(SessionId(id),'write')
    try{
     const {events,eventState}=await handle.read(),session=Session.fromRestore(handle.id,events,handle.header,handle.inheritedEventCount,eventState)
     const disposition=applyLegacyApprovalPreference(session,false)
     if(disposition.applied){await handle.append(session.snapshotEvents().slice(events.length));await handle.flush()}
     result.approval.push({sessionId:id,...disposition,eventCount:disposition.applied?session.seq:events.length})
    }finally{await handle.close()}
   }catch(error){result.approval.push({sessionId:id,applied:false,reason:error instanceof Error?error.message:String(error)});result.reasons.push('NATIVE_APPROVAL_NOT_APPLIED: '+id)}
  }
  if(!sessionIds.length)result.reasons.push('NO_MIGRATED_SESSION_FOR_APPROVAL')
  else if(!result.reasons.length){
   const status=result.approval.some(item=>item.applied)?'applied':'preserved-existing'
   result.items=result.items.map(item=>item.field==='permissions.autoApprove'?{...item,status,target:'migrated-sessions.approval/policy',reason:status==='applied'?'已通过原生setter对迁入会话应用ask；逐Session回执见approval。':'保留迁入会话中已有的原生policy/preset，未重复写入。'}:item)
  }
 }else if(values.length>1)result.reasons.push('CONFLICTING_LEGACY_AUTO_APPROVE')
 result.applied=result.items.filter(item=>item.status==='applied').length
 result.unchanged=result.items.filter(item=>item.status==='already-applied').length
 result.preservedExisting=result.items.filter(item=>item.status==='preserved-existing').length
 result.unapplied=result.items.filter(item=>item.status==='unapplied').length
 result.status=result.reasons.length||result.missing.length||!result.sourceUnchanged?'BLOCKED':result.unapplied?'PARTIAL':'PASS'
 result.exitCode=result.status==='PASS'?0:2
 await atomicJSON(join(options.dshHome,'migrations',options.sourceLabel,'preferences','entry-result.json'),result)
 return result
}
