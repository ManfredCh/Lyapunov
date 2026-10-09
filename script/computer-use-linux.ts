/** 产品固定版本供给；不启用全局驱动、不改变桌面权限，原生 MCP owner 负责连接。 */
import {createHash} from 'node:crypto'
import {existsSync,readFileSync,accessSync,constants} from 'node:fs'
import {mkdir,writeFile,rename,chmod,readFile,copyFile} from 'node:fs/promises'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {PRODUCT_ROOT} from './profile.ts'
export const COMPUTER_USE_LINUX_VERSION='0.7.13+local.atsbus.1'
export const COMPUTER_USE_LINUX_UPSTREAM_VERSION='0.7.13'
export const COMPUTER_USE_LINUX_LOCAL_SHA256='9628d62a8290542b8c03bd77e9d2748ce7d71113d5b85f9c2b1a26dbf0ace53a'
const LOCAL_ARCHIVE_SHA256='246dedb98e59b49b262df2cdf4c845222f2da3dc12adb0277ba9b80e9736c6f9'
const PATCH_SHA256='35b7e3cb116558587f6b80eebc287904e8798bfd493fcb6672de06a2e6697439'
export const COMPUTER_USE_LINUX_SOURCE='https://github.com/agent-sh/computer-use-linux'
export const COMPUTER_USE_LINUX_LICENSE_SHA256='865367984df228c2bbf9df7e790b26c3b083376b705375db36a8a032daa03a25'
export const computerUseLinuxAssets=[
 {name:'computer-use-linux',sha256:'c0f90d7249dfedfdb19a49fd4460799ae0a7d8f00e6a76bfea73cb4df36c170e'},
 {name:'computer-use-linux-cosmic',sha256:'f5ba192cffd19d1cecc811a51cb3baf02fb41989d3ec8c6fee3bd1a1c5de53bc'},
 {name:'computer-use-linux-indicator',sha256:'88cd866600419ff193d9808582a32f9ef8989848586f506542badc6789f6167f'},
] as const
const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex')
export function computerUseLinuxPaths(root=PRODUCT_ROOT,variant:'local'|'official'='local'){const directory=join(root,'.runtime/computer-use-linux');return {root:directory,bin:join(directory,'bin'),command:join(directory,variant==='official'?'official/computer-use-linux':'bin/computer-use-linux'),license:join(directory,'LICENSE'),provenance:join(directory,'provenance.json')}}
/** 官方回退仅显式选择，不因修复件失败自动降级。 */
export function computerUseLinuxVariant(env:NodeJS.ProcessEnv=process.env):'local'|'official'{const value=env.LYAPUNOV_COMPUTER_USE_LINUX_VARIANT??'local';if(value!=='local'&&value!=='official')throw Error('COMPUTER_USE_LINUX_VARIANT_INVALID: '+value);return value}
export function computerUseLinuxReady(root=PRODUCT_ROOT):boolean{
 const paths=computerUseLinuxPaths(root)
 try{const provenance=JSON.parse(readFileSync(paths.provenance,'utf8'));if(provenance.version!==COMPUTER_USE_LINUX_VERSION||provenance.source!==COMPUTER_USE_LINUX_SOURCE||provenance.license!=='MIT'||provenance.licenseSha256!==COMPUTER_USE_LINUX_LICENSE_SHA256||provenance.minimumGlibc!=='2.39')return false
  if(sha(readFileSync(paths.license))!==COMPUTER_USE_LINUX_LICENSE_SHA256)return false
  accessSync(paths.command,constants.X_OK);if(sha(readFileSync(paths.command))!==COMPUTER_USE_LINUX_LOCAL_SHA256)return false
  if(sha(readFileSync(join(paths.root,'atspi-bus.patch')))!==PATCH_SHA256)return false
  return computerUseLinuxAssets.every(asset=>{const file=asset.name==='computer-use-linux'?join(paths.root,'official/computer-use-linux'):join(paths.bin,asset.name);accessSync(file,constants.X_OK);return sha(readFileSync(file))===asset.sha256})
 }catch{return false}
}
/** x64发行固定资产；其它平台明确限制，不把CLI存在当作桌面可用。 */
export async function ensureComputerUseLinux(options:{root?:string;env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;arch?:string;offline?:boolean;signal?:AbortSignal}={}){
 const root=options.root??PRODUCT_ROOT,platform=options.platform??process.platform,arch=options.arch??process.arch,env=options.env??process.env
 if(platform!=='linux'||arch!=='x64')throw Error(`COMPUTER_USE_LINUX_PLATFORM_UNSUPPORTED: ${platform}/${arch}；本发行供给仅Linux x64。 / This product supplies only Linux x64.`)
 const paths=computerUseLinuxPaths(root)
 if(computerUseLinuxReady(root))return {...JSON.parse(readFileSync(paths.provenance,'utf8')),ready:true,command:paths.command}
 await mkdir(paths.bin,{recursive:true});await mkdir(join(paths.root,'official'),{recursive:true})
 const archivePath=join(root,'distribution/native/computer-use-linux/computer-use-linux-0.7.13+local.atsbus.1-linux-x64.gz');if(!existsSync(archivePath))throw Error('COMPUTER_USE_LINUX_LOCAL_ARCHIVE_MISSING: '+archivePath)
 const localArchive=await readFile(archivePath)
 if(sha(localArchive)!==LOCAL_ARCHIVE_SHA256)throw Error('COMPUTER_USE_LINUX_LOCAL_ARCHIVE_CHECKSUM_FAILED')
 const localBinary=gunzipSync(localArchive);if(sha(localBinary)!==COMPUTER_USE_LINUX_LOCAL_SHA256)throw Error('COMPUTER_USE_LINUX_LOCAL_BINARY_CHECKSUM_FAILED')
 await writeFile(paths.command+'.tmp-'+process.pid,localBinary,{mode:0o755});await rename(paths.command+'.tmp-'+process.pid,paths.command)
 const patch=gunzipSync(await readFile(join(root,'distribution/native/computer-use-linux/atspi-bus.patch.gz')));if(sha(patch)!==PATCH_SHA256)throw Error('COMPUTER_USE_LINUX_PATCH_CHECKSUM_FAILED')
 await writeFile(join(paths.root,'atspi-bus.patch'),patch)
 for(const asset of computerUseLinuxAssets){
  const target=asset.name==='computer-use-linux'?join(paths.root,'official/computer-use-linux'):join(paths.bin,asset.name)
  if(existsSync(target)){const bytes=await readFile(target);if(sha(bytes)===asset.sha256){await chmod(target,0o755);continue}}
  const cached=env.HOME?join(env.XDG_CACHE_HOME??join(env.HOME,'.cache'),'computer-use-linux/plugin/v'+COMPUTER_USE_LINUX_UPSTREAM_VERSION,asset.name):undefined
  let bytes:Uint8Array|undefined
  if(cached&&existsSync(cached)){const content=await readFile(cached);if(sha(content)===asset.sha256)bytes=content}
  const url=`${COMPUTER_USE_LINUX_SOURCE}/releases/download/v${COMPUTER_USE_LINUX_UPSTREAM_VERSION}/${asset.name}-x86_64-unknown-linux-gnu`
  if(!bytes){if(options.offline)throw Error('COMPUTER_USE_LINUX_ASSET_MISSING: '+url)
   const response=await fetch(url,{signal:options.signal??AbortSignal.timeout(60000)});if(!response.ok)throw Error(`COMPUTER_USE_LINUX_DOWNLOAD_FAILED: ${url} HTTP ${response.status}`)
   bytes=new Uint8Array(await response.arrayBuffer())
  }
  if(sha(bytes)!==asset.sha256)throw Error('COMPUTER_USE_LINUX_CHECKSUM_FAILED: '+url)
  const temp=target+'.tmp-'+process.pid;await writeFile(temp,bytes,{mode:0o755});await rename(temp,target)
 }
 const license=join(root,'distribution/licenses/computer-use-linux-0.7.13.LICENSE'),text=await readFile(license)
 if(sha(text)!==COMPUTER_USE_LINUX_LICENSE_SHA256)throw Error('COMPUTER_USE_LINUX_LICENSE_CHECKSUM_FAILED: '+license)
 await copyFile(license,paths.license)
 await writeFile(paths.provenance,JSON.stringify({version:COMPUTER_USE_LINUX_VERSION,upstreamVersion:COMPUTER_USE_LINUX_UPSTREAM_VERSION,upstreamCommit:'4e567e6a7b866154353e571206dbfe323a7a9bbe',minimumGlibc:'2.39',variants:{local:{version:COMPUTER_USE_LINUX_VERSION,binarySha256:COMPUTER_USE_LINUX_LOCAL_SHA256},official:{version:COMPUTER_USE_LINUX_UPSTREAM_VERSION,binarySha256:computerUseLinuxAssets[0].sha256,selection:'LYAPUNOV_COMPUTER_USE_LINUX_VARIANT=official'}},activeDefault:'local',officialFallback:'显式LYAPUNOV_COMPUTER_USE_LINUX_VARIANT=official，不自动降级',localBinarySha256:COMPUTER_USE_LINUX_LOCAL_SHA256,localArchiveSha256:LOCAL_ARCHIVE_SHA256,patchSha256:PATCH_SHA256,sourceChanges:['src/atspi_tree.rs','src/x11_display.rs'],source:COMPUTER_USE_LINUX_SOURCE,license:'MIT',licenseSha256:COMPUTER_USE_LINUX_LICENSE_SHA256,target:'x86_64-unknown-linux-gnu',assets:computerUseLinuxAssets.map(asset=>({...asset,url:`${COMPUTER_USE_LINUX_SOURCE}/releases/download/v${COMPUTER_USE_LINUX_UPSTREAM_VERSION}/${asset.name}-x86_64-unknown-linux-gnu`,checksumSource:`${COMPUTER_USE_LINUX_SOURCE}/releases/download/v${COMPUTER_USE_LINUX_UPSTREAM_VERSION}/${asset.name}-x86_64-unknown-linux-gnu.sha256`}))},null,2)+'\n')
 if(!computerUseLinuxReady(root))throw Error('COMPUTER_USE_LINUX_SUPPLY_NOT_READY')
 return {...JSON.parse(readFileSync(paths.provenance,'utf8')),ready:true,command:paths.command}
}
if(import.meta.main)console.log(JSON.stringify(await ensureComputerUseLinux({offline:process.argv.includes('--offline')})))
