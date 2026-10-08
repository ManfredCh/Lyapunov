/** 有限只读发现；不扫描代理密钥目录，不执行未知 MCP 或编辑器脚本。 */
import {access,realpath,stat,readdir,readFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {homedir} from 'node:os'
import {join,isAbsolute,basename,dirname} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {IntegrationCandidate} from './plugin-marketplace.ts'
import {blenderMcpPaths,blenderMcpStatus,blenderMcpLock} from '../../../script/blender-mcp.ts'

export async function validExistingExecutable(path:string):Promise<{path:string;modifiedAt:number}|null>{
 if(!isAbsolute(path)||/[\r\n\0]/.test(path))return null
 try{const canonical=await realpath(path),info=await stat(canonical);if(!info.isFile())return null;await access(canonical,constants.X_OK);return {path:canonical,modifiedAt:info.mtimeMs}}catch{return null}
}
/** PATH 与显式编辑器路径只用于发现；版本检查仍由原外部工具检测执行。 */
export async function discoverIntegrations(ctx:Context,env:NodeJS.ProcessEnv=process.env):Promise<IntegrationCandidate[]>{
 const rows:IntegrationCandidate[]=[],seen=new Set<string>()
 const add=async(kind:'blender'|'unity',path:string|undefined,source:IntegrationCandidate['source'])=>{
  if(!path)return
  const actual=await validExistingExecutable(path);if(!actual||seen.has(kind+':'+actual.path))return
  seen.add(kind+':'+actual.path);rows.push({id:kind+':'+actual.path,kind,path:actual.path,requestedPath:path,source,modifiedAt:actual.modifiedAt,executable:true})
 }
 await add('blender',env.BLENDER_EXECUTABLE?.trim(),'explicit');await add('unity',env.LYAPUNOV_UNITY_EXECUTABLE?.trim(),'explicit')
 const subprocess=ctx.get('subprocess')
 for(const [kind,name]of [['blender','blender'],['blender','mcp-for-blender'],['unity','Unity'],['unity','unity'],['unity','unityhub'],['unity','mcp-for-unity']]as const){
  const path=await subprocess?.resolveExecutable(name).catch(()=>null);if(path)await add(kind,path,'PATH')
 }
 // UV 工具的固定公开 dist-info 只读名称/版本/项目URL，不读取安装脚本或其它应用的配置。
 for(const row of rows){
  const executable=basename(row.path),isBlender=executable==='mcp-for-blender',isUnity=executable==='mcp-for-unity'
  if(!isBlender&&!isUnity)continue
  const root=dirname(dirname(row.path)),expected=isBlender?'mcp-for-blender':'mcpforunityserver';let pythonDirs:string[]
  try{pythonDirs=await readdir(join(root,'lib'))}catch{continue}
  for(const python of pythonDirs.slice(0,8))if(/^python\d+\.\d+$/.test(python)){
   const site=join(root,'lib',python,'site-packages');let entries:string[];try{entries=await readdir(site)}catch{continue}
   for(const entry of entries.filter(v=>v.toLowerCase().replaceAll('_','-').startsWith(expected.replaceAll('_','-')+'-')&&v.endsWith('.dist-info')).slice(0,4)){
    let info:string;try{const file=join(site,entry,'METADATA');if((await stat(file)).size>1024*1024)continue;info=await readFile(file,'utf8')}catch{continue}
    const name=/^Name: (.+)$/m.exec(info)?.[1],version=/^Version: (.+)$/m.exec(info)?.[1]
    if(name!==expected||!version)continue
    row.packageName=name;row.version=version;row.owner=isBlender?'ahujasid (community / 社区)':'CoplayDev (third party / 第三方)';row.repository=isBlender?'https://github.com/ahujasid/mcp-for-blender':'https://github.com/CoplayDev/unity-mcp'
    // Exact package metadata identifies an installed bridge; compatibility and addon handshake remain separate.
    if(isBlender&&version===blenderMcpLock().version)row.knownPackage=true
   }
  }
 }
 const supply=blenderMcpStatus(),paths=blenderMcpPaths()
 if(supply.readings.commandExists)await add('blender',paths.command,'product-supply')
 const picker=ctx.get('directoryPicker')?.capability(),userHome=picker?.kind==='browse'?picker.homeDirectory??homedir():homedir()
 const existingAddons:string[]=[];const blenderConfig=join(userHome,'.config','blender');let configs:string[]=[]
 try{configs=(await readdir(blenderConfig)).filter(v=>/^\d+\.\d+$/.test(v)).slice(0,16)}catch{}
 for(const version of configs){const file=join(blenderConfig,version,'scripts','addons','blender_mcp.py');try{if((await stat(file)).isFile()){existingAddons.push(file)}}catch{}}
 for(const row of rows)if(row.kind==='blender'&&['mcp-for-blender','blender-mcp'].includes(basename(row.path))){row.addonPath=supply.readings.addonExists?paths.addon:existingAddons.length===1?existingAddons[0]:undefined;row.addonExists=supply.readings.addonExists||existingAddons.length>0}

 // Unity Hub 的公开标准安装根只枚举直接版本目录；不解析EditorPrefs/代理配置或登录数据。
 const roots=[join(userHome,'Unity','Hub','Editor'),'/opt/unityhub/Editor']
 for(const root of roots){let entries:string[];try{entries=await readdir(root)}catch{continue}
  for(const version of entries.slice(0,32))if(/^\d{4}\.\d+\.\d+[abfp]\d+$/.test(version))await add('unity',join(root,version,'Editor','Unity'),'unity-hub')
 }
 return rows
}
