import {basename} from 'node:path'

/** 下载前的 POSIX 安装器消费 TSV；网站同时公开同一对象的 JSON。 */
export interface DownloadArtifact {path:string;sha256:string;bytes:number}
export interface MuJoCoRuntimeManifest {
  schema:1
  format:'conda-pack'
  platform:'linux-x64'
  minimumGlibc:string
  archive:DownloadArtifact
  pythonVersion:string
  packages:Record<string,string>
  licenses:ReadonlyArray<{path:string;sha256:string}>
}
export interface LinuxReleaseManifest {
  schema:1
  releaseId:string
  version:string
  platform:'linux-x64'
  minimumGlibc:string
  sourceCommit:string
  archiveRoot:string
  archive:DownloadArtifact
  mujoco:{mode:'install-provider'}|{mode:'conda-pack';runtime:MuJoCoRuntimeManifest}
}
/** macOS 复用同一下载／激活合同；SDK 在目标机器用原 install-provider 准备。 */
export interface MacOSReleaseManifest {
  schema:1
  releaseId:string
  version:string
  platform:'darwin-arm64'
  minimumMacOS:string
  sourceCommit:string
  archiveRoot:string
  archive:DownloadArtifact
  mujoco:{mode:'install-provider'}
  signing?:string
  notarized?:boolean
}
export type ReleaseManifest=LinuxReleaseManifest|MacOSReleaseManifest

export function checkedRuntimeManifest(value:unknown):MuJoCoRuntimeManifest{
  const row=value as MuJoCoRuntimeManifest
  if(!row||row.schema!==1||row.format!=='conda-pack'||row.platform!=='linux-x64')throw Error('MuJoCo runtime manifest 必须为 schema1/linux-x64/conda-pack')
  if(!/^\d+\.\d+$/.test(row.minimumGlibc)||!/^3\.12\./.test(row.pythonVersion))throw Error('MuJoCo runtime 的 glibc/Python 身份无效')
  checkedArtifact(row.archive)
  for(const [name,version] of Object.entries({mujoco:'3.13.0',mink:'1.3.0',ompl:'2.0.1',daqp:'0.9.1',coacd:'1.0.7',trimesh:'5.1.0',pyzmq:'27.2.0',msgpack:'1.2.2','msgpack-numpy':'0.4.8'})){
    if(row.packages?.[name]!==version)throw Error(`MuJoCo runtime 缺少产品固定依赖 ${name}==${version}`)
  }
  for(const name of ['numpy','scipy','pyzmq','msgpack','msgpack-numpy'])if(!row.packages?.[name])throw Error(`MuJoCo runtime 缺少闭包 ${name}`)
  if(!Array.isArray(row.licenses)||row.licenses.length===0||row.licenses.some(license=>!license.path||!/^([0-9a-f]{64})$/.test(license.sha256)))throw Error('MuJoCo runtime 缺少许可证文件身份')
  return row
}
function checkedArtifact(artifact:DownloadArtifact){
  if(!artifact||basename(artifact.path)!==artifact.path||!/^[-A-Za-z0-9_.]+\.tar\.gz$/.test(artifact.path)||!/^[0-9a-f]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<=0)throw Error('下载产物必须有安全文件名、完整SHA256和真实正数字节数')
}
export function checkedReleaseManifest<T extends ReleaseManifest>(row:T):T{
  const token=(text:string)=>/^[-A-Za-z0-9_.]+$/.test(text)&&text!=='.'&&text!=='..'
  if(row.schema!==1||!token(row.releaseId)||!token(row.version)||!token(row.archiveRoot)||!/^[0-9a-f]{40}$/.test(row.sourceCommit))throw Error('发布清单身份无效')
  if(row.platform==='linux-x64'){
    if(!/^\d+\.\d+$/.test(row.minimumGlibc))throw Error('Linux 发布清单身份无效')
  }else if(row.platform==='darwin-arm64'){
    if(!/^\d+\.\d+$/.test(row.minimumMacOS)||row.mujoco.mode!=='install-provider')throw Error('macOS 发布清单身份或 SDK 模式无效')
  }else throw Error('发布清单平台无效')
  checkedArtifact(row.archive)
  const runtime=row.mujoco.mode==='conda-pack'?checkedRuntimeManifest(row.mujoco.runtime):null
  if(row.mujoco.mode!=='conda-pack'&&row.mujoco.mode!=='install-provider')throw Error('未知 MuJoCo 准备模式')
  if(row.archive.bytes+(runtime?.archive.bytes??0)>2*1024**3)throw Error('Linux 主包与默认MuJoCo压缩总大小超过2GiB')
  return row
}
export function releaseManifestTsv(input:ReleaseManifest):string{
  const row=checkedReleaseManifest(input),runtime=row.mujoco.mode==='conda-pack'?row.mujoco.runtime:null
  const base=`releases/${row.releaseId}/`
  return Object.entries({schema:'1',release_id:row.releaseId,version:row.version,platform:row.platform,...row.platform==='linux-x64'?{minimum_glibc:row.minimumGlibc}:{minimum_macos:row.minimumMacOS},source_commit:row.sourceCommit,
    archive_path:base+row.archive.path,archive_root:row.archiveRoot,archive_sha256:row.archive.sha256,archive_bytes:String(row.archive.bytes),
    mujoco_mode:row.mujoco.mode,mujoco_path:runtime?base+runtime.archive.path:'none',mujoco_sha256:runtime?.archive.sha256??'none',mujoco_bytes:String(runtime?.archive.bytes??0),...row.platform==='linux-x64'?{mujoco_minimum_glibc:runtime?.minimumGlibc??row.minimumGlibc}:{},
  }).map(([key,value])=>`${key}\t${value}\n`).join('')
}
