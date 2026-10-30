import {parseArgs} from "node:util"
import {resolve,join,dirname} from "node:path"
import {readFile,writeFile} from "node:fs/promises"
import {existsSync,statSync} from "node:fs"
import {spawn} from "node:child_process"
if(process.versions.bun){
  const child=spawn("node",[process.argv[1]!,...process.argv.slice(2)],{stdio:"inherit",env:process.env})
  const code=await new Promise<number>(resolve=>child.once("exit",code=>resolve(code??1)))
  process.exit(code)
}
const modulePath="../packages/lyaup-migrations/dist/index.js"
const {migrateLegacy}=await import(modulePath) as typeof import("../packages/lyaup-migrations/src/index.ts")
const root=resolve(import.meta.dirname,"..")
const {values}=parseArgs({args:process.argv.slice(2),options:{source:{type:"string"},"source-json":{type:"string"},home:{type:"string"},"scene-root":{type:"string"},"account-key":{type:"string"},label:{type:"string",default:"lyapunov-old"},report:{type:"string"},resources:{type:"string",multiple:true},"resource-root":{type:"string"},mode:{type:"string"},preferences:{type:"string"},"profile-dir":{type:"string"},"include-preferences":{type:"boolean",default:false}}})
if(!values.home||!values["scene-root"]||!values["account-key"])throw new Error("必须显式指定 --home、--scene-root 和 --account-key，迁移不会写旧源")
if(values.source&&values["source-json"])throw new Error("--source与--source-json不能同时指定")
/** 旧 0.1.0 数据根只能由用户显式给出（--source / --source-json / LYAPUNOV_LEGACY_ROOT）；不猜开发机路径，也不自动搜索旧数据。 */
const legacyRoot=process.env.LYAPUNOV_LEGACY_ROOT
if(!values.source&&!values["source-json"]&&!legacyRoot)throw new Error("LEGACY_SOURCE_REQUIRED: 需要显式指定 --source 或 --source-json（也可用 LYAPUNOV_LEGACY_ROOT 显式给出旧 0.1.0 数据根）；迁移不会自动搜索或伪造旧数据")
const defaultSource=legacyRoot?join(resolve(legacyRoot),".lya/developer-runtime/data/opencode/opencode-local.db"):undefined
const sourcePath=resolve(values["source-json"]??values.source??defaultSource!)
const sourceDescription=values["source-json"]?"--source-json 指向的旧 JSON 存储":values.source?"--source 指定的旧 SQLite 数据":"LYAPUNOV_LEGACY_ROOT 推导出的旧 SQLite 数据"
if(!existsSync(sourcePath))throw new Error(`LEGACY_SOURCE_MISSING: ${sourcePath}（${sourceDescription}不存在；迁移不会伪造旧数据，也不会在检查前写新目录）`)
if(values["source-json"]&&!statSync(sourcePath).isDirectory())throw new Error(`LEGACY_SOURCE_INVALID: ${sourcePath}（--source-json 需要旧 JSON 存储目录）`)
if(!values["source-json"]&&!statSync(sourcePath).isFile())throw new Error(`LEGACY_SOURCE_INVALID: ${sourcePath}（--source 需要旧 SQLite 数据库文件）`)
const source=values["source-json"]?{sourceJsonDirectory:sourcePath}:{sourceDatabase:sourcePath}
let preferences:import("../packages/lyaup-migrations/src/index.ts").ScopedPreferenceSources|undefined
if(values.mode&&!['formal','developer'].includes(values.mode))throw new Error('--mode 必须为formal或developer')
if(values.preferences||values['include-preferences']){
 if(!values.mode)throw new Error('偏好迁移必须显式指定 --mode，与来源manifest的mode/accountKey一致')
 if(values.preferences){
  const manifest=resolve(values.preferences),data=JSON.parse(await readFile(manifest,'utf8'))
  if(!data||typeof data!=='object'||!Array.isArray(data.sources))throw new Error('PREFERENCE_MANIFEST_INVALID')
  preferences={...data,profileDirectory:values['profile-dir']?resolve(values['profile-dir']):typeof data.profileDirectory==='string'?resolve(dirname(manifest),data.profileDirectory):undefined,sources:data.sources.map((item:any)=>({...item,path:typeof item.path==='string'?resolve(dirname(manifest),item.path):item.path}))}
 }else preferences={mode:values.mode as 'formal'|'developer',accountKey:values['account-key'],sources:[],profileDirectory:values['profile-dir']?resolve(values['profile-dir']):undefined}
 if(!preferences?.profileDirectory)throw new Error('偏好迁移必须显式提供已存在的 --profile-dir 或manifest.profileDirectory')
}
const result=await migrateLegacy({...source,sourceLabel:values.label!,accountKey:values["account-key"],mode:values.mode as "formal"|"developer"|undefined,preferences,dshHome:values.home,sceneRoot:values["scene-root"],resourceLibraries:values.resources?.map(path=>({path:resolve(path),workspaceRoot:resolve(values["resource-root"]??join(root,".."))}))})
const summary={status:result.status,requestedScope:result.requestedScope,preferences:result.preferences,sourceKind:result.sourceKind,sourceDatabase:result.sourceDatabase,sourceCounts:result.sourceCounts,created:result.created,unchanged:result.unchanged,interruptedTools:result.interruptedTools,attachments:result.attachments,resources:result.resources,resourceMetadataUpdated:result.resourceMetadataUpdated,scenes:result.scenes,sourceUnchanged:result.sourceUnchanged,missing:result.missing,ledgerPath:result.ledgerPath,exitCode:result.exitCode}
if(values.report)await writeFile(resolve(values.report),JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary));process.exitCode=result.exitCode
