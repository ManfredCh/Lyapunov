import {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-settings"
import {boot,composeEntries,loadProfileDirectory,readProfilePatches,type ProfileContext} from "@deepseek-ai/dsh-app-boot"
import type {EntryOptions} from "@deepseek-ai/cordis-plugin-loader"
import type {PatchOptions} from "@deepseek-ai/cordis-plugin-include"
import {pathToFileURL} from "node:url"
import {isDeepStrictEqual} from "node:util"
import {parseDocument} from "yaml"
import {withFileLock,writeFileAtomic} from "@deepseek-ai/dsh-atomic-write"
import {prepareLegacyPreferenceSection} from "../../lyapunov-shell/src/preferences-host.ts"
import {setApprovalPolicy} from "@deepseek-ai/dsh-user-approval"
import type {} from "@deepseek-ai/dsh-permission-presets"
import type {Session} from "@deepseek-ai/dsh-session"
import {readFile,stat,mkdir} from "node:fs/promises"
import {basename,join,resolve,relative,isAbsolute,sep} from "node:path"
import {atomicJSON,fileTransaction,safeId} from "../../scene-kit/src/persistence.ts"

export type PreferenceSourceKind="electron-settings"|"electron-global"|"web-storage-export"|"migration-metadata"
export interface PreferenceSource {kind:PreferenceSourceKind;path:string}
export interface PreferenceOptions {
 sourceLabel:string
 accountKey:string
 dshHome:string
 /** 已存在的目标Profile，显式偏好迁移不可推断默认Profile。 */
 profileDirectory?:string
 sources:PreferenceSource[]
 /** 仅检查明确属于 Lyaup 的旧 Web origin；不会打开浏览器全局数据库。 */
 webOrigins?:string[]
}
export interface PreferenceItem {source:string;field:string;value?:unknown;target?:string;status:"applied"|"already-applied"|"preserved-existing"|"unapplied"|"excluded";reason?:string}
interface Assignment {source:string;field:string;value:string|number;namespace:"locale"|"ui-theme"|"ui-conversation";targetField:string}
const protectedKey=/(?:api[-_]?key|password|token|secret|credential|authorization|cookie|license)/i
const decode=(value:unknown):any=>{if(typeof value==="string"&&/^[{[]/.test(value.trim()))try{return JSON.parse(value)}catch{}return value}
function sanitize(value:unknown):unknown {
 if(Array.isArray(value))return value.map(sanitize)
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,protectedKey.test(key)?"[敏感字段已排除]":sanitize(item)]))
 return value
}
function flatten(value:unknown,prefix:string):Array<[string,unknown]>{
 if(value&&typeof value==="object"&&!Array.isArray(value))return Object.entries(value).flatMap(([key,item])=>flatten(item,prefix?prefix+"."+key:key))
 return [[prefix,value]]
}
async function stamp(path:string){try{const value=await stat(path);return {path,size:value.size,mtimeMs:value.mtimeMs}}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {path,missing:true};throw error}}

/** 仅装配指定现有Profile的设置面；执行overlay不落盘，也不启动模型或Host业务。 */
async function preferenceProfile(home:string,profileDirectory:string|undefined):Promise<Context>{
 if(!profileDirectory)throw new Error('PREFERENCE_TARGET_PROFILE_REQUIRED')
 const dir=resolve(profileDirectory),scope=relative(join(home,'profiles'),dir)
 if(!scope||scope==='..'||scope.startsWith('..'+sep)||isAbsolute(scope))throw new Error('PREFERENCE_TARGET_PROFILE_OUTSIDE_HOME')
 for(const file of ['package.json','cordis.yml']){
  try{await stat(join(dir,file))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('PREFERENCE_TARGET_PROFILE_MISSING: '+dir);throw error}
 }
 const anchor=resolve(import.meta.dirname,'../../../package.json')
 const loaded=loadProfileDirectory('dsh',dir,anchor)
 if(loaded.skippedBundles.length)throw new Error('PREFERENCE_TARGET_PROFILE_BUNDLE_UNAVAILABLE: '+loaded.skippedBundles.map(row=>row.packageName).join(','))
 const namespaces=new Set(['locale','ui-theme','ui-conversation','lyapunov-preferences','lyapunov-workspace'])
 const services=new Set(['@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-settings'])
 const rows=composeEntries([...loaded.layers.map(layer=>layer.patches),loaded.patches])
 const overlays:PatchOptions[]=[]
 const restrict=(entries:EntryOptions[])=>{for(const row of entries){if(row.group&&Array.isArray(row.config))restrict(row.config);else if(!namespaces.has(row.id)&&!services.has(row.name))overlays.push({id:row.id,disabled:true})}}
 restrict(rows)
 overlays.push({insert:[{id:'migration-preference-import',name:'cordis:migration-preference-import'}]})
 const profile:ProfileContext={name:basename(dir),dir,patchPath:loaded.patchPath,installAnchor:anchor,cwd:home,home,startedBundles:loaded.layers.map(layer=>layer.packageName),overlays,telemetryDisabledEnv:'1'}
 return boot('dsh',join(dir,'cordis.yml'),readProfilePatches('dsh',profile,loaded),ctx=>{
  ctx.provide('profileContext',profile)
  ctx.loader.builtins['migration-preference-import']={inject:['settings','configEditor','profileContext'],apply:async(owner:Context)=>{
   const configured=new Set(owner.configEditor.configuration().map(row=>row.entry.options.id))
   for(const ns of namespaces)if(configured.has(ns))await prepareLegacyPreferenceSection(owner,ns,ns)
  }}
 },pathToFileURL(anchor).href)
}

/** 独立偏好迁移器；调用方显式传旧源和新账号 DSH_HOME，不扫描其他安装。 */
export async function migratePreferences(options:PreferenceOptions){
 safeId(options.accountKey);safeId(options.sourceLabel)
 const home=resolve(options.dshHome),directory=join(home,"migrations",options.sourceLabel,"preferences"),ledgerPath=join(directory,"ledger.json")
 const sources=options.sources.map(source=>({...source,path:resolve(source.path)}))
 const outputs=[join(home,"settings.yaml"),ledgerPath,join(directory,"result.json"),join(directory,"preserved-preferences.json")]
 if(sources.some(source=>outputs.includes(source.path)))throw new Error("PREFERENCE_SOURCE_EQUALS_TARGET")
 await mkdir(directory,{recursive:true,mode:0o700})
 return fileTransaction(ledgerPath,async()=>{
  let previous:any
  try{previous=JSON.parse(await readFile(ledgerPath,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
  if(previous&&(previous.accountKey!==options.accountKey||JSON.stringify(previous.sources)!==JSON.stringify(sources)||(previous.profileDirectory!==undefined&&previous.profileDirectory!==resolve(options.profileDirectory??""))))throw new Error("PREFERENCE_ACCOUNT_OR_SOURCE_MISMATCH")
  const before=await Promise.all(sources.map(source=>stamp(source.path))),items:PreferenceItem[]=[],missing:string[]=[],assignments:Assignment[]=[],preserved:Record<string,unknown>={}
  const add=(source:string,field:string,value:string|number,namespace:Assignment["namespace"],targetField:string)=>assignments.push({source,field,value,namespace,targetField})
  const unknown=(source:string,field:string,value:unknown,reason:string)=>items.push({source,field,value:sanitize(value),status:"unapplied",reason})
  const extractSettings=(source:string,value:unknown)=>{
   const data=decode(value)
   if(!data||typeof data!=="object"){unknown(source,"settings.v3",data,"旧设置不是对象");return}
   preserved[source+":settings.v3"]=sanitize(data)
   for(const [field,value] of flatten(data,"")){
    if(protectedKey.test(field)){items.push({source,field,status:"excluded",reason:"不迁移凭据字段"});continue}
    if(field==="appearance.fontSize"&&Number.isInteger(value)&&Number(value)>=12&&Number(value)<=17)add(source,field,Number(value),"ui-theme","fontSize")
    else if(field==="general.followup"&&(value==="queue"||value==="steer"))add(source,field,value,"ui-conversation","busyEnter")
    else if(field==="permissions.autoApprove")unknown(source,field,value,value===false?"旧值保留；新 Profile 的原生审批默认 ask。若迁移指定 Session，可调用 applyLegacyApprovalPreference 写原生 approval/policy。":"旧 autoApprove 不能等价映射 DSH 的 sandbox/approval 组合，不把它转换成 full-access。")
    else if(field.startsWith("keybinds"))unknown(source,field,value,"固定 DSH 版本未提供对应可持久快捷键自定义字段，保留原值。")
    else if(field.startsWith("notifications")||field.startsWith("sounds"))unknown(source,field,value,"固定 DSH 版本没有对应通知/声音设置消费方，保留原值，不写无消费者的假设置。")
    else unknown(source,field,value,field==="appearance.fontSize"?"超出 DSH 原生字号 12–17 范围，未静默截断。":"没有可确认等价的原生设置字段。")
   }
  }
  const extractLocale=(source:string,value:unknown)=>{
   const data=decode(value),locale=typeof data==="string"?data:data?.locale
   const known:Record<string,string>={zh:"zh","zh-CN":"zh","zh-SG":"zh","zh-Hans":"zh",en:"en","en-US":"en","en-GB":"en"}
   if(typeof locale==="string"&&known[locale])add(source,"language.locale",known[locale]!,"locale","preference")
   else unknown(source,"language.locale",locale??data,"目标只安装 zh/en 语言包；其他语言需真实语言包，不静默回退后声称已应用。")
  }
  for(const source of sources){
   let data:any;try{data=JSON.parse(await readFile(source.path,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){missing.push(source.path);continue}throw error}
   if(source.kind==="electron-settings"){
    if(data["settings.v3"]!==undefined)extractSettings(source.path,data["settings.v3"])
    else unknown(source.path,"settings.v3",undefined,"文件没有旧 settings.v3 字段。")
    for(const key of Object.keys(data).filter(key=>key!=="settings.v3"))items.push({source:source.path,field:key,status:"excluded",reason:"不属于设置白名单；未复制其值。"})
   }else if(source.kind==="electron-global"){
    if(data.language!==undefined)extractLocale(source.path,data.language)
    else unknown(source.path,"language",undefined,"文件没有旧 language 字段。")
    for(const key of Object.keys(data).filter(key=>key!=="language"))items.push({source:source.path,field:key,status:"excluded",reason:"不属于全局偏好白名单；未复制其值。"})
   }else if(source.kind==="web-storage-export"){
    if(!(options.webOrigins??["http://127.0.0.1:4175","http://localhost:4175"]).includes(data.origin))throw new Error("PREFERENCE_ORIGIN_NOT_CONFIRMED")
    const entries=data.entries??data.localStorage
    if(!entries||typeof entries!=="object")throw new Error("INVALID_WEB_PREFERENCE_EXPORT")
    if(entries["settings.v3"]!==undefined)extractSettings(source.path,entries["settings.v3"])
    if(entries["opencode.global.dat:language"]!==undefined)extractLocale(source.path,entries["opencode.global.dat:language"])
    const color=entries["opencode-color-scheme"]
    if(color!==undefined){if(["light","dark","system"].includes(color))add(source.path,"opencode-color-scheme",color,"ui-theme","preference");else unknown(source.path,"opencode-color-scheme",color,"目标仅支持 light/dark/system。")}
    if(entries["opencode-theme-id"]!==undefined)unknown(source.path,"opencode-theme-id",entries["opencode-theme-id"],"旧调色板没有等价 DSH 主题；仅颜色模式可迁移，调色板 ID 保留。")
    for(const key of Object.keys(entries).filter(key=>!["settings.v3","opencode.global.dat:language","opencode-color-scheme","opencode-theme-id"].includes(key)))items.push({source:source.path,field:key,status:"excluded",reason:"不属于偏好白名单；不导入浏览器会话、账号或资源数据。"})
   }else{
    // index.ts 已生成的一致性迁移元数据；不再次连接旧数据库。
    const permissions=data.permissions??[]
    preserved[source.path+":permissions"]=sanitize(permissions)
    if(permissions.length)unknown(source.path,"permissions",permissions,"旧逐工具/路径授权规则没有等价的原生粗粒度预设，原样保留并逐项待映射。")
    for(const session of data.sessionMetadata??[]){
     const permission=decode(session.permission)
     const empty=permission===undefined||permission===null||Array.isArray(permission)&&permission.length===0||typeof permission==="object"&&!Array.isArray(permission)&&Object.keys(permission).length===0
     if(!empty)unknown(source.path,`session.${session.id}.permission`,permission,"旧 Session 逐项授权保留；不扩大成默认 full-access。")
    }
   }
  }
  await atomicJSON(join(directory,"preserved-preferences.json"),preserved)
  let ctx:Context|undefined
  const reasons:string[]=[]
  let profileBefore:string|undefined
  const changed:Array<{namespace:string;fields:Array<{field:string;value:string|number}>}>=[]
  try{
   ctx=await preferenceProfile(home,options.profileDirectory)
   try{profileBefore=await readFile(ctx.settings.documentPath,"utf8")}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
   const grouped=new Map<string,Assignment[]>()
   for(const assignment of assignments)grouped.set(assignment.namespace,[...grouped.get(assignment.namespace)??[],assignment])
   const served=new Set(ctx.settings.describe({redactSecrets:true}).map(item=>String(item.ns)))
   for(const namespace of grouped.keys())if(!served.has(namespace))throw new Error('NATIVE_PREFERENCE_NAMESPACE_MISSING: '+namespace)
   for(const [namespace,group] of grouped){
    const descriptor=ctx.settings.describe({redactSecrets:true}).find(item=>item.ns===namespace)
    if(!descriptor)throw new Error("NATIVE_PREFERENCE_NAMESPACE_MISSING: "+namespace)
    const fields:Array<{field:string;value:string|number}>=[]
    const pending:Assignment[]=[]
    for(const assignment of group){
     const target=namespace+"."+assignment.targetField,current=(descriptor.user as Record<string,unknown>|undefined)?.[assignment.targetField]
     if(current!==undefined){items.push({source:assignment.source,field:assignment.field,value:assignment.value,target,status:current===assignment.value?"already-applied":"preserved-existing",reason:current===assignment.value?"幂等重跑，无需写入。":"新 Profile 用户设置已存在，保留用户当前选择。"});continue}
     fields.push({field:assignment.targetField,value:assignment.value});pending.push(assignment)
    }
    if(!fields.length)continue
    await ctx.settings.mutate(namespace,fields.map(field=>({op:'set' as const,path:[field.field],value:field.value})),descriptor.revision)
    changed.push({namespace,fields})
    for(const assignment of pending)items.push({source:assignment.source,field:assignment.field,value:assignment.value,target:namespace+"."+assignment.targetField,status:"applied"})
   }
  }catch(error){
   const message=error instanceof Error?error.message:String(error);reasons.push(message)
   if(ctx)for(const change of changed.reverse()){
    const view=ctx.settings.describe().find(row=>row.ns===change.namespace),user=view?.user as Record<string,unknown>|undefined
    if(!view||change.fields.some(field=>user?.[field.field]!==field.value)){reasons.push('PREFERENCE_ROLLBACK_CONCURRENT_CHANGE: '+change.namespace);continue}
    try{await ctx.settings.mutate(change.namespace,change.fields.map(field=>({op:'unset' as const,path:[field.field]})),view.revision)}catch(rollback){reasons.push('PREFERENCE_ROLLBACK_FAILED: '+String(rollback))}
   }
   if(ctx&&profileBefore!==undefined&&!reasons.some(reason=>reason.startsWith('PREFERENCE_ROLLBACK_'))){
    const path=ctx.settings.documentPath
    await withFileLock(join(options.profileDirectory!,'package.json'),async()=>{
     const current=await readFile(path,'utf8')
     const json=(text:string)=>parseDocument(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]}).toJS()
     if(isDeepStrictEqual(json(current),json(profileBefore!)))await writeFileAtomic(path,profileBefore!,{mode:0o600})
    })
   }
   for(const item of items)if(item.status==='applied'){item.status='unapplied';item.reason='原生配置事务未完整提交；回滚诊断见reasons：'+message}
   for(const assignment of assignments)if(!items.some(item=>item.source===assignment.source&&item.field===assignment.field))items.push({source:assignment.source,field:assignment.field,value:assignment.value,target:assignment.namespace+'.'+assignment.targetField,status:'unapplied',reason:message})
  }
  const nativeSettings=ctx?.settings.describe({redactSecrets:true}).map(item=>({namespace:item.ns,value:item.value,user:item.user}))??[]
  await ctx?.fiber.dispose()
  const after=await Promise.all(sources.map(source=>stamp(source.path))),sourceUnchanged=JSON.stringify(before)===JSON.stringify(after)
  const unsupported=items.filter(item=>item.status==="unapplied")
  const result={status:reasons.length||missing.length||!sourceUnchanged?"BLOCKED":unsupported.length?"PARTIAL":"PASS",accountKey:options.accountKey,sourceLabel:options.sourceLabel,sources,missing,reasons,sourceUnchanged,targetDocument:options.profileDirectory?join(resolve(options.profileDirectory),'cordis.patch.yml'):undefined,applied:items.filter(item=>item.status==="applied").length,unchanged:items.filter(item=>item.status==="already-applied").length,preservedExisting:items.filter(item=>item.status==="preserved-existing").length,unapplied:unsupported.length,items,nativeSettings,exitCode:reasons.length||missing.length||!sourceUnchanged||unsupported.length?2:0}
  await atomicJSON(ledgerPath,{accountKey:options.accountKey,sources,sourceLabel:options.sourceLabel,profileDirectory:options.profileDirectory?resolve(options.profileDirectory):undefined})
  await atomicJSON(join(directory,"result.json"),result)
  return result
 })
}

/** 已由迁移器建立的原生 Session 使用官方 setter；不启动 Agent、工具或动作。 */
export function applyLegacyApprovalPreference(session:Session,autoApprove:unknown){
 if(autoApprove!==false)return {applied:false,reason:"旧 autoApprove=true 没有等价的 DSH 审批策略，保留但不扩大权限。"}
 const previous=[...session.snapshotEvents()].reverse().find(event=>event.type==="approval/policy"||event.type==="permission/preset")
 if(previous?.type==="approval/policy")return {applied:false,preservedExisting:true,eventType:previous.type,policy:previous.data.policy,eventSeq:previous.seq}
 if(previous?.type==="permission/preset")return {applied:false,preservedExisting:true,eventType:previous.type,preset:previous.data.preset,eventSeq:previous.seq}
 setApprovalPolicy(session,"ask")
 return {applied:true,eventType:"approval/policy",policy:"ask",eventSeq:session.seq-1}
}

/** 有限盘点：只检查源码明确命名的 Lyaup Electron 目录，不读取其他应用。 */
export async function inspectConfirmedPreferenceSources(workspaceRoot:string,homeDirectory:string){
 const bases=[join(homeDirectory,".config"),join(workspaceRoot,".lya/developer-runtime/config"),join(homeDirectory,".local/share")]
 const appIds=["ai.lya.desktop.merged.dev","ai.lya.desktop.beta","ai.lya.desktop"]
 const expected=appIds.flatMap(appId=>bases.flatMap(base=>[
  {appId,mode:appId.endsWith("merged.dev")?"developer":appId.endsWith("beta")?"beta":"formal",kind:"electron-settings" as const,path:join(base,appId,"lya.settings")},
  {appId,mode:appId.endsWith("merged.dev")?"developer":appId.endsWith("beta")?"beta":"formal",kind:"electron-global" as const,path:join(base,appId,"opencode.global.dat")},
 ]))
 return Promise.all(expected.map(async source=>({...source,...await stamp(source.path)})))
}
