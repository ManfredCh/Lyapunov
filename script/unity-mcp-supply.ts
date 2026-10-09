/** 固定的Unity stdio桥供给；编辑器及其addon仍由原Unity Package Manager管理。 */
import {existsSync,readFileSync,realpathSync,accessSync,constants,readdirSync} from 'node:fs'
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises'
import {join,dirname,delimiter} from 'node:path'
import {createHash} from 'node:crypto'
import {PRODUCT_ROOT} from './profile.ts'
import {runBlenderMcpSupplyCommand} from './blender-mcp.ts'
export const UNITY_MCP_VERSION='10.2.0'
export const UNITY_MCP_SOURCE='https://github.com/CoplayDev/unity-mcp'
export const UNITY_MCP_WHEEL_URL='https://files.pythonhosted.org/packages/1f/e0/9c3a6bcf46cf43b5021a5c9a7e33cd14b232918b1e7a0403e82bae41d557/mcpforunityserver-10.2.0-py3-none-any.whl'
export const UNITY_MCP_WHEEL='mcpforunityserver-10.2.0-py3-none-any.whl'
export const UNITY_MCP_LICENSE_SHA256='6efe650c965012ac418238dcd6b9116e4130a5220717ef0dfb539dd159c4245c'
export const UNITY_MCP_WHEEL_SHA256='596e2a7322d829b6cf73510bad5ad87ba7e0ba2eee7e1b19645e8caf4ebf1460'
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
export function unityMcpSupplyPaths(root=PRODUCT_ROOT){const directory=join(root,'.runtime/unity-mcp');return {root:directory,venv:join(directory,'venv'),command:join(directory,'bin/mcp-for-unity'),wheel:join(directory,'cache',UNITY_MCP_WHEEL),license:join(directory,'LICENSE'),provenance:join(directory,'provenance.json')}}
function exactPackage(command:string):boolean{
 try{accessSync(command,constants.X_OK);const root=dirname(dirname(realpathSync(command)));return readdirSync(join(root,'lib')).filter(p=>/^python\d+\.\d+$/.test(p)).some(p=>{const file=join(root,'lib',p,'site-packages','mcpforunityserver-'+UNITY_MCP_VERSION+'.dist-info/METADATA');if(!existsSync(file))return false;const text=readFileSync(file,'utf8');return /^Name: mcpforunityserver$/m.test(text)&&/^Version: 10\.2\.0$/m.test(text)})}catch{return false}
}
export function unityMcpSupplyReady(root=PRODUCT_ROOT):boolean{const paths=unityMcpSupplyPaths(root);return existsSync(paths.command)&&readFileSync(paths.command,'utf8').includes(' -I -m main ' )&&exactPackage(join(paths.venv,'bin/mcp-for-unity'))}
/** 只读公开CLI/dist-info；无需用户代理配置、登录数据或私有registry。 */
export function installedUnityMcpCommand(env:NodeJS.ProcessEnv=process.env,root=PRODUCT_ROOT):string|undefined{
 if(unityMcpSupplyReady(root))return unityMcpSupplyPaths(root).command
 const candidates=[...(env.PATH??'').split(delimiter).filter(Boolean).map(dir=>join(dir,'mcp-for-unity')),...env.HOME?[join(env.HOME,'.local/bin/mcp-for-unity')]:[]]
 return candidates.find(exactPackage)
}
/** 正常发行缓存包含固定wheel/MIT；venv在目标机器用本机Python正常重建，不打包构建机shebang。 */
export async function prepareUnityMcpSupply(root=PRODUCT_ROOT){
 const paths=unityMcpSupplyPaths(root)
 const metadata={version:UNITY_MCP_VERSION,source:UNITY_MCP_SOURCE,sourceCommit:'d8504c16a72f8d4b8195720f0b266debb1054427',package:'mcpforunityserver',license:'MIT',licenseSha256:UNITY_MCP_LICENSE_SHA256,wheelSource:UNITY_MCP_WHEEL_URL,wheelSha256:UNITY_MCP_WHEEL_SHA256,requiresPython:'>=3.10',transport:'stdio',editorAddonSource:UNITY_MCP_SOURCE+'/tree/v10.2.0/MCPForUnity',editorAddonInstall:'Unity Package Manager: https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.2.0',editorIncluded:false,entry:'bin/mcp-for-unity'}
 // 发行只带这三项固定供给，不依赖distribution源码；存在但损坏的件必须拒绝。
 for(const [file,pin,code] of [[paths.wheel,UNITY_MCP_WHEEL_SHA256,'UNITY_MCP_WHEEL_CHECKSUM_FAILED'],[paths.license,UNITY_MCP_LICENSE_SHA256,'UNITY_MCP_LICENSE_CHECKSUM_FAILED']] as const){
  if(existsSync(file)&&digest(await readFile(file))!==pin)throw Error(code+': '+file)
 }
 if(existsSync(paths.provenance)){
  let recorded:unknown;try{recorded=JSON.parse(await readFile(paths.provenance,'utf8'))}catch{throw Error('UNITY_MCP_PROVENANCE_INVALID')}
  if(recorded===null||typeof recorded!=='object'||Array.isArray(recorded)||Object.entries(metadata).some(([key,value])=>(recorded as Record<string,unknown>)[key]!==value))throw Error('UNITY_MCP_PROVENANCE_PIN_MISMATCH')
 }
 if(existsSync(paths.wheel)&&existsSync(paths.license)&&existsSync(paths.provenance))return metadata
 const source=join(root,'distribution/native/unity-mcp',UNITY_MCP_WHEEL),licenseSource=join(root,'distribution/licenses/unity-mcp-10.2.0.LICENSE')
 if(!existsSync(source)||!existsSync(licenseSource))throw Error('UNITY_MCP_PACKED_SUPPLY_INCOMPLETE: 发行缓存、MIT或来源回执缺失；不能从不存在的源码目录安装。 / The packaged wheel, MIT license or provenance is missing; a source distribution is unavailable.')
 const bytes=await readFile(source);if(digest(bytes)!==UNITY_MCP_WHEEL_SHA256)throw Error('UNITY_MCP_WHEEL_CHECKSUM_FAILED')
 const license=await readFile(licenseSource);if(digest(license)!==UNITY_MCP_LICENSE_SHA256)throw Error('UNITY_MCP_LICENSE_CHECKSUM_FAILED')
 if(!existsSync(paths.wheel)){await mkdir(dirname(paths.wheel),{recursive:true});await copyFile(source,paths.wheel)}
 if(!existsSync(paths.license))await writeFile(paths.license,license)
 if(!existsSync(paths.provenance))await writeFile(paths.provenance,JSON.stringify(metadata,null,2)+'\n')
 return metadata
}
export async function ensureUnityMcp(options:{root?:string;env?:NodeJS.ProcessEnv;offline?:boolean;forceProduct?:boolean;signal?:AbortSignal}={}){
 if(process.platform!=='linux')throw Error('UNITY_MCP_SUPPLY_PLATFORM_UNSUPPORTED: 此产品供给入口仅Linux；其它平台保留显式原生配置。')
 const root=options.root??PRODUCT_ROOT,env=options.env??process.env,paths=unityMcpSupplyPaths(root),metadata=await prepareUnityMcpSupply(root),existing=options.forceProduct?(unityMcpSupplyReady(root)?paths.command:undefined):installedUnityMcpCommand(env,root)
 if(existing)return {...metadata,ready:true,command:existing,owner:existing===paths.command?'product':'existing'}
 if(options.offline)throw Error('UNITY_MCP_RUNTIME_MISSING: '+paths.venv+'；固定wheel已准备，尚需本机Python与依赖正常安装。')
 const bundledPython=join(root,'.runtime/sim-python/bin/python'),python=existsSync(bundledPython)?bundledPython:'python3'
 const made=await runBlenderMcpSupplyCommand(python,['-m','venv',paths.venv],{signal:options.signal});if(made.code!==0)throw Error('UNITY_MCP_PYTHON_VENV_FAILED: '+made.stderr.slice(-800))
 const installed=await runBlenderMcpSupplyCommand(join(paths.venv,'bin/python'),['-m','pip','install','--disable-pip-version-check','--no-input','--timeout','30','--retries','0',paths.wheel],{signal:options.signal});if(installed.code!==0)throw Error('UNITY_MCP_INSTALL_FAILED: '+installed.stderr.slice(-1000))
 await mkdir(dirname(paths.command),{recursive:true})
 await writeFile(paths.command,'#!/bin/sh\nset -eu\nbridge_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$bridge_root/venv/bin/python" -I -m main "$@"\n',{mode:0o755})
 if(!unityMcpSupplyReady(root))throw Error('UNITY_MCP_SUPPLY_NOT_READY')
 return {...metadata,ready:true,command:paths.command,owner:'product',pythonSource:python===bundledPython?'bundled-sim-python':'system-python3'}
}
if(import.meta.main)console.log(JSON.stringify(await ensureUnityMcp({offline:process.argv.includes('--offline'),forceProduct:process.argv.includes('--product')})))
