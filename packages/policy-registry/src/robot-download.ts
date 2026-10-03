/** 统一机器人下载候选：一次预检、同身份本地复用、快速失败；不执行动作或远程推理。 */
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import { policyDirectory, policyFile, type PolicyManifest } from './source.ts'
import { IMPLEMENTED_POLICY_ADAPTERS } from './pack-contract.ts'
import { G1_23_75_ID } from './g1-23-75.ts'
export function registeredRobotDownloads() {
  return IMPLEMENTED_POLICY_ADAPTERS.map(a => ({ adapterId: a.id, packId:a.packs[0], label: `${a.packs.join('/')} · ${a.id === G1_23_75_ID ? '23DOF / 75 维观测 · ' : a.id === 'unitree-g1-12dof-v1' ? '12DOF · ' : ''}${a.adapter}`, identity: { provider: 'github' as const, modelId: a.modelId, revision: a.revision }, files: [...a.requires.files, ...(a.requires.prefixes ?? []).map(p => p + '/')], downloadModelId: a.id === 'unitree-g1-12dof-v1' ? 'unitree_g1_12dof_motion' : a.id === G1_23_75_ID ? 'unitree_g1_23dof_75obs' : a.id==='wtw-go1-torchscript-v1'?'unitree_go1_wtw_control':a.id==='inria-go2-onnx-v1'?'unitree_go2_onnx_control':null, fallback: { action: 'web_fetch', retryable: false, urls: a.requires.files.map(path => ({ path, url: `${a.id===G1_23_75_ID?'https://media.githubusercontent.com/media/':'https://raw.githubusercontent.com/'}${a.modelId}/${a.revision}/${path}` })), directories: (a.requires.prefixes ?? []).map(path => ({ path, url: `https://github.com/${a.modelId}/tree/${a.revision}/${path}` })) } }))
}

export type RobotDownloadFetcher=(url:string,init?:RequestInit)=>Promise<Response>
export interface RobotDownloadFile { path:string; bytes:number; sha256:string; gitBlob?:string|null; piece?:string; sourceRepository?:string;sourceRevision?:string;sourcePath?:string;url?:string;sourceKind?:string;sourceGitBlob?:string;sourceContentIdentity?:unknown }
export interface RobotDownloadManifest {
  schema:string; packId:string; version:string; downloadReady:boolean; serverSideInference:boolean
  missingFiles?:string[];missingLicense?:string[]
  source:{provider:'github';modelId:string;resolvedRevision:string}
  pieceReadiness?:Record<string,{downloadReady:boolean;missingFiles?:string[];missingLicense?:string[]}>
  assetModel?:{entry:string;sha256:string;controlledJointNames:string[];source:{repository:string;revision:string;path:string;url:string}}
  files:RobotDownloadFile[]
  adapter?:{id:string;controlledJointCount:number;jointNames:string[];registeredAdapterRequires:string[];deploymentClosure:string[];modelEntry?:string;observationDim?:number;actionDim?:number}
  fallback?:{action?:string;retryable?:boolean;rawBase?:string;blobBase?:string;urls?:Array<{path:string;url:string}>;directories?:Array<{path:string;url:string}>}
}
export class RobotDownloadFailure extends Error {
  readonly retryable=false
  readonly fallbackAction='web_fetch'
  constructor(readonly code:string, readonly detail:string, readonly fallback?:RobotDownloadManifest['fallback'], readonly missing?:{missingFiles:string[];missingLicense:string[]}) {super(`${code}: ${detail}`)}
  toJSON(){return {code:this.code,message:this.detail,retryable:false,fallbackAction:this.fallbackAction,...this.fallback?{fallback:this.fallback}:{},...this.missing}}
}
const fail=(code:string,detail:string,fallback?:RobotDownloadManifest['fallback']):never=>{throw new RobotDownloadFailure(code,detail,fallback)}
// 已登记模型原件的伴随来源；只限定身份，不把源清单/缓存或XML存在解释成native执行已验。
const menagerie={repository:'google-deepmind/mujoco_menagerie',revision:'822c2d8f877dd166c5b7d3c9f7e3c3b6589473b7'}
const assetSource=(adapterId:string|undefined)=>{
 const old=IMPLEMENTED_POLICY_ADAPTERS.find(a=>a.id==='unitree-g1-12dof-v1')!
 if(adapterId==='wtw-go1-torchscript-v1')return {...menagerie,path:'unitree_go1/go1.xml',sha256:'d5a7466784c8e72fd174cc7fa5a92754a1a0a6d458a1dec79e7ca0abc9525c4a'}
 if(adapterId==='inria-go2-onnx-v1')return {...menagerie,path:'unitree_go2/go2.xml',sha256:'50adb09a4365293e2acdaf2010ae35a82b0f09fea18ae51806fef91e310ed04a'}
 if(adapterId===G1_23_75_ID)return {repository:old.modelId,revision:old.revision,path:'resources/robots/g1_description/g1_23dof_rev_1_0.xml',sha256:'8ca62fcccdca91a431ca04f1a42f9c2fda241fdd5e13411168dc82de00f978de'}
 if(adapterId===old.id)return {repository:old.modelId,revision:old.revision,path:'resources/robots/g1_description/g1_12dof.xml',sha256:'747ede40aa726b7352bae8353e95d0d0f908cec2257a27cbd78bc6e5a2d5a314'}
 return undefined
}
const sameAssetModel=(a:RobotDownloadManifest['assetModel'],b:RobotDownloadManifest['assetModel'])=>Boolean(a&&b&&a.source&&b.source&&Array.isArray(a.controlledJointNames)&&Array.isArray(b.controlledJointNames)&&a.entry===b.entry&&a.sha256===b.sha256&&a.controlledJointNames.length===b.controlledJointNames.length&&a.controlledJointNames.every((n,i)=>n===b.controlledJointNames[i])&&['repository','revision','path','url'].every(key=>a.source[key as keyof typeof a.source]===b.source[key as keyof typeof b.source]))
/** 混合闭包逐件保留来源；G1 23 本体只允许已登记的 Unitree 固定模型来源，不能被权重仓身份覆盖。 */
function fileSource(f:RobotDownloadFile,m:RobotDownloadManifest):{revision:string;url:string}|undefined {
  const explicit=f.sourceRepository!==undefined||f.sourceRevision!==undefined||f.sourcePath!==undefined
  if(!explicit&&!f.gitBlob)return undefined
  const repository=f.sourceRepository??m.source.modelId,revision=f.sourceRevision??m.source.resolvedRevision,path=f.sourcePath??f.path
  const robot=IMPLEMENTED_POLICY_ADAPTERS.find(a=>a.id==='unitree-g1-12dof-v1')!
  const samePolicy=repository===m.source.modelId&&revision===m.source.resolvedRevision
  const sameRobot=m.adapter?.id===G1_23_75_ID&&repository===robot.modelId&&revision===robot.revision
  const companion=assetSource(m.adapter?.id),sameCompanion=f.piece==='asset'&&companion&&repository===companion.repository&&revision===companion.revision&&path.startsWith(posix.dirname(companion.path)+'/')
  if(explicit&&(!f.sourceRepository||!f.sourceRevision||!f.sourcePath)||(!samePolicy&&!sameRobot&&!sameCompanion)||policyFile(path)!==path)fail('ROBOT_DOWNLOAD_FILE_SOURCE_INVALID',`文件固定来源不符：${f.path}`,m.fallback)
  const raw=`https://raw.githubusercontent.com/${repository}/${revision}/${path}`,media=`https://media.githubusercontent.com/media/${repository}/${revision}/${path}`
  if(f.url!==undefined&&f.url!==raw&&f.url!==media)fail('ROBOT_DOWNLOAD_FILE_SOURCE_INVALID',`文件 URL 与固定来源不符：${f.path}`,m.fallback)
  return {revision,url:f.url??raw}
}

export function robotDownloadManifest(value:unknown,options:{assetOnly?:boolean}={}):RobotDownloadManifest {
  let m=value as RobotDownloadManifest
  if(!m||!['g1-policy-download/v1','robot-download/v1'].includes(m.schema))fail('ROBOT_DOWNLOAD_PROTOCOL_UNSUPPORTED','下载清单协议未登记')
  const ready=options.assetOnly?m.pieceReadiness?.asset:m
  if(ready?.downloadReady!==true||options.assetOnly&&(ready.missingFiles?.length||ready.missingLicense?.length)){const missing={missingFiles:Array.isArray(ready?.missingFiles)?ready.missingFiles.filter(p=>typeof p==='string'):[],missingLicense:Array.isArray(ready?.missingLicense)?ready.missingLicense.filter(p=>typeof p==='string'):[]};throw new RobotDownloadFailure('ROBOT_DOWNLOAD_NOT_READY',`该具体型号${options.assetOnly?'本体资产':'完整包'}尚无已核下载闭包${missing.missingFiles.length?'；缺文件：'+missing.missingFiles.join('、'):''}${missing.missingLicense.length?'；许可未核：'+missing.missingLicense.join('、')+'，补齐许可前不取件':''}`,m.fallback,missing)}
  if(m.serverSideInference!==false)fail('ROBOT_DOWNLOAD_LOCAL_INFERENCE_REQUIRED','此接口只分发文件，本地推理')
  if(m.source?.provider!=='github'||!/^[\w.-]+\/[\w.-]+$/.test(m.source.modelId)||!/^[a-f0-9]{40}$/.test(m.source.resolvedRevision))fail('ROBOT_DOWNLOAD_SOURCE_INVALID','需要固定公开来源与完整 revision')
  const expected=registeredRobotDownloads().find(row=>row.downloadModelId===m.packId)
  if(options.assetOnly&&!expected)fail('ROBOT_DOWNLOAD_MODEL_MISMATCH','本体下载型号未登记；不能用基础T0别名替代具体SKU',m.fallback)
  if(expected&&m.adapter?.id!==expected.adapterId)fail('ROBOT_DOWNLOAD_MODEL_MISMATCH','下载型号与适配器身份不一致',m.fallback)
  if(expected&&(m.source.modelId!==expected.identity.modelId||m.source.resolvedRevision!==expected.identity.revision))fail('ROBOT_DOWNLOAD_PREFLIGHT_BLOCKED','下载型号与固定来源身份不一致',m.fallback)
  if(m.adapter){const a=m.adapter
    if(!Number.isSafeInteger(a.controlledJointCount)||a.controlledJointCount<1||!Array.isArray(a.jointNames)||a.jointNames.length!==a.controlledJointCount||new Set(a.jointNames).size!==a.jointNames.length||a.jointNames.some(n=>typeof n!=='string'||!n)||!Array.isArray(a.registeredAdapterRequires)||!Array.isArray(a.deploymentClosure))fail('ROBOT_DOWNLOAD_ADAPTER_INVALID','适配器关节与依赖闭包声明无效',m.fallback)
    if(a.id===G1_23_75_ID&&(a.controlledJointCount!==23||a.observationDim!==undefined&&a.observationDim!==75||a.actionDim!==undefined&&a.actionDim!==23)||a.id==='unitree-g1-12dof-v1'&&a.controlledJointCount!==12)fail('ROBOT_DOWNLOAD_MODEL_MISMATCH','G1 12/23DOF 与 75 维契约不能混用',m.fallback)
  }
  if(options.assetOnly){
    const model=m.assetModel,expectedAsset=assetSource(m.adapter?.id)
    if(!model||!expectedAsset||model.source?.repository!==expectedAsset.repository||model.source.revision!==expectedAsset.revision||model.source.path!==expectedAsset.path||model.sha256!==expectedAsset.sha256||model.source.url!==`https://raw.githubusercontent.com/${expectedAsset.repository}/${expectedAsset.revision}/${expectedAsset.path}`||policyFile(model.entry)!==model.entry||!Array.isArray(model.controlledJointNames)||model.controlledJointNames.length!==m.adapter?.controlledJointCount||new Set(model.controlledJointNames).size!==model.controlledJointNames.length||model.controlledJointNames.some(n=>!m.adapter!.jointNames.includes(n)))fail('ROBOT_DOWNLOAD_ASSET_MODEL_INVALID','本体入口、固定原件身份或关节合同不符',m.fallback)
    m={...m,files:Array.isArray(m.files)?m.files.filter(f=>f.piece==='asset'):[]}
  }
  if(!Array.isArray(m.files)||!m.files.length)fail('ROBOT_DOWNLOAD_FILES_EMPTY','清单缺少文件')
  const names=new Set<string>()
  for(const f of m.files){
    if(policyFile(f.path)!==f.path||names.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256))fail('ROBOT_DOWNLOAD_FILE_INVALID','文件清单路径、大小或校验身份无效')
    if(f.gitBlob!=null&&!/^[a-f0-9]{40}$/.test(f.gitBlob))fail('ROBOT_DOWNLOAD_FILE_INVALID','Git blob 身份无效')
    if(f.sourceGitBlob!==undefined&&!/^[a-f0-9]{40}$/.test(f.sourceGitBlob))fail('ROBOT_DOWNLOAD_FILE_INVALID','来源 pointer Git blob 身份无效')
    if(options.assetOnly){const companion=assetSource(m.adapter?.id)!;if(f.sourceRepository!==companion.repository||f.sourceRevision!==companion.revision||typeof f.sourcePath!=='string'||!(f.sourcePath.startsWith(posix.dirname(companion.path)+'/')||f.sourcePath==='LICENSE')||/\.(?:pt|pth|jit|onnx|safetensors|pkl)$/i.test(f.sourcePath))fail('ROBOT_DOWNLOAD_ASSET_FILE_INVALID',`asset件不是登记本体来源：${f.path}；不能把策略重标成asset绕过许可`,m.fallback)}
    fileSource(f,m)
    names.add(f.path)
  }
  if(m.files.reduce((n,f)=>n+f.bytes,0)>128*1024*1024)fail('ROBOT_DOWNLOAD_PACKAGE_TOO_LARGE','此入口仅处理小型机器人资源包，不下载大型 SDK')
  if(options.assetOnly&&!m.files.some(f=>f.path===m.assetModel!.entry&&f.sha256===m.assetModel!.sha256&&f.sourceRepository===m.assetModel!.source.repository&&f.sourceRevision===m.assetModel!.source.revision&&f.sourcePath===m.assetModel!.source.path))fail('ROBOT_DOWNLOAD_ASSET_MODEL_INVALID','本体原件不在asset文件清单内',m.fallback)
  return m
}

export function robotDownloadPreflight(m:RobotDownloadManifest,input:{runtimeModules?:ReadonlySet<string>;currentJointNames?:readonly string[];availableFiles?:ReadonlySet<string>}={}) {
  const pin=m.adapter&&IMPLEMENTED_POLICY_ADAPTERS.find(p=>p.id===m.adapter!.id)
  const missing:string[]=[]
  const listed=new Set(m.files.map(f=>f.path))
  const required=[...new Set([...(pin?.requires.files??[]),...(m.adapter?.registeredAdapterRequires??[]),...(m.adapter?.deploymentClosure??[])])]
  for(const path of required)if(!listed.has(path))missing.push(path)
  for(const prefix of pin?.requires.prefixes??[])if(!m.files.some(f=>f.path.startsWith(prefix+'/')))missing.push(prefix+'/')
  const runtime=pin?.requires.runtimeModules??(pin?.adapter==='onnx'?['mujoco','numpy','onnxruntime']:pin?['mujoco','numpy','torch','yaml']:['mujoco','numpy'])
  const missingRuntime=input.runtimeModules?runtime.filter(n=>!input.runtimeModules!.has(n)):runtime
  const modelMismatch=Boolean(input.currentJointNames&&m.adapter&&(input.currentJointNames.length!==m.adapter.controlledJointCount||m.adapter.jointNames.some(n=>!input.currentJointNames!.includes(n))))
  const unknownAdapter=Boolean(m.adapter&&!pin)
  const wrongSource=Boolean(pin&&(pin.modelId!==m.source.modelId||pin.revision!==m.source.resolvedRevision))
  const missingLocal=required.filter(path=>!input.availableFiles?.has(path))
  return {status:missing.length||missingRuntime.length||modelMismatch||unknownAdapter||wrongSource?'BLOCKED':'READY_TO_INSTALL',modelId:m.packId,missingFiles:missing,missingLocalFiles:missingLocal,missingRuntime,modelMismatch,unknownAdapter,wrongSource,runtimeChecked:input.runtimeModules!==undefined,requiresSeparateResource:modelMismatch,policyPrepared:false,robotWalkingVerified:false,serverSideInference:false,nextSteps:missingRuntime.length?[`本地安装或显式选择包含 ${missingRuntime.join('/')} 的 Python；缺运行时不继续检索机器人`]:[]}
}

export async function installRobotDownload(input:{endpoint:string;modelId:string;token?:string;dataDirectory:string;signal:AbortSignal;fetcher?:RobotDownloadFetcher;localFiles?:ReadonlyMap<string,string>;timeoutMs?:number;manifest?:RobotDownloadManifest;pieces?:['asset']}) {
  const assetOnly=input.pieces?.length===1&&input.pieces[0]==='asset'
  if(input.pieces&&!assetOnly)fail('ROBOT_DOWNLOAD_PIECES_INVALID','仅允许明确asset单件；完整包沿既有asset+policy入口')
  const endpoint=new URL(input.endpoint)
  if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['localhost','127.0.0.1'].includes(endpoint.hostname)))fail('ROBOT_DOWNLOAD_ENDPOINT_INVALID','下载端点需 HTTPS 或本机测试地址')
  const base=input.endpoint.replace(/\/$/,'')
  if(!/^[a-z0-9_.-]+$/i.test(input.modelId))fail('ROBOT_DOWNLOAD_MODEL_ID_INVALID','必须明确选择具体型号')
  const registeredModel=registeredRobotDownloads().find(row=>row.downloadModelId===input.modelId),bodySource=assetOnly?assetSource(registeredModel?.adapterId):undefined
  let fallback=input.manifest?.fallback??(bodySource?{action:'web_fetch',retryable:false,urls:[{path:bodySource.path,url:`https://raw.githubusercontent.com/${bodySource.repository}/${bodySource.revision}/${bodySource.path}`}],directories:[{path:posix.dirname(bodySource.path),url:`https://github.com/${bodySource.repository}/tree/${bodySource.revision}/${posix.dirname(bodySource.path)}`}]}:registeredModel?.fallback)
  if(!input.token&&!input.manifest)fail('ROBOT_DOWNLOAD_AUTH_REQUIRED','联网取件需要既有产品账号鉴权',fallback)
  const fetcher=input.fetcher??fetch
  const responseBody=async(r:Response,kind:'json'|'bytes'):Promise<any>=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([kind==='json'?r.json():r.arrayBuffer(),new Promise((_,reject)=>{timer=setTimeout(()=>{void r.body?.cancel().catch(()=>{});reject(new RobotDownloadFailure('ROBOT_DOWNLOAD_BODY_TIMEOUT','读取下载响应超时；不重试，转准确来源 web_fetch',fallback))},input.timeoutMs??10000)})])}
    catch(e){if(e instanceof RobotDownloadFailure)throw e;fail('ROBOT_DOWNLOAD_RESPONSE_INVALID','下载响应不是有效清单或完整字节',fallback)}finally{if(timer)clearTimeout(timer)}
  }
  const request=async(path:string,init:RequestInit={}):Promise<Response>=>{
    input.signal.throwIfAborted()
    if(!input.token)fail('ROBOT_DOWNLOAD_AUTH_REQUIRED','联网取件需要既有产品账号鉴权',fallback)
    const signal=AbortSignal.any([input.signal,AbortSignal.timeout(input.timeoutMs??10000)])
    try{
      const r=await fetcher(`${base}${path}`,{...init,signal,headers:{...init.headers,Authorization:`Bearer ${input.token}`}})
      if(!r.ok){
        let body:any;try{body=await responseBody(r,'json')}catch{}
        const error=body?.error&&typeof body.error==='object'?body.error:body
        const code=typeof error?.code==='string'&&/^ROBOT_[A-Z0-9_]+$/.test(error.code)?error.code:'ROBOT_DOWNLOAD_ENDPOINT_FAILED'
        const missing={missingFiles:Array.isArray(error?.missingFiles)?error.missingFiles.filter((p:unknown)=>typeof p==='string'):[],missingLicense:Array.isArray(error?.missingLicense)?error.missingLicense.filter((p:unknown)=>typeof p==='string'):[]}
        const detail=`端点 ${path.split('?')[0]} 返回 HTTP ${r.status}${missing.missingFiles.length?'；缺文件：'+missing.missingFiles.join('、'):''}${missing.missingLicense.length?'；许可未核：'+missing.missingLicense.join('、')+'，补齐许可前不取件':'；不重试，转固定来源 web_fetch'}`
        throw new RobotDownloadFailure(code,detail,error?.fallback??body?.fallback??fallback,missing)
      }
      return r
    }catch(e){if(e instanceof RobotDownloadFailure)throw e;if(input.signal.aborted)throw input.signal.reason;return fail('ROBOT_DOWNLOAD_TRANSPORT_FAILED','取件连接失败或超时；不重试，转准确来源 web_fetch',fallback)}
  }
  const m=robotDownloadManifest(input.manifest??await responseBody(await request(`/models/${encodeURIComponent(input.modelId)}/manifest`),'json'),{assetOnly})
  fallback=m.fallback
  if(m.packId!==input.modelId)fail('ROBOT_DOWNLOAD_MODEL_MISMATCH','清单型号与请求不同',m.fallback)
  const checked=assetOnly?undefined:robotDownloadPreflight(m)
  if(checked&&(checked.missingFiles.length||checked.unknownAdapter||checked.wrongSource))fail('ROBOT_DOWNLOAD_PREFLIGHT_BLOCKED',JSON.stringify(checked),m.fallback)
  // 来源/型号已经核对后才补UI精确链接。不能把服务端rawBase对象覆盖登记链接后留下空列表，
  // 也不能借用另一个来源的fallback；derived adapter.json没有Git blob，不冒充仓库原件。
  const registered=m.adapter&&IMPLEMENTED_POLICY_ADAPTERS.find(p=>p.id===m.adapter!.id)
  fallback={...m.fallback,action:'web_fetch',retryable:false,
    urls:m.files.flatMap(f=>{const source=fileSource(f,m);return source?[{path:f.path,url:source.url}]:[]}),
    directories:m.fallback?.directories??(registered?.requires.prefixes??[]).map(path=>({path,url:`https://github.com/${m.source.modelId}/tree/${m.source.resolvedRevision}/${path}`}))}
  m.fallback=fallback
  const root=assetOnly?join(input.dataDirectory,'robot-assets',policyFile(m.packId),m.source.resolvedRevision):policyDirectory(input.dataDirectory,'github',m.source.modelId,m.source.resolvedRevision)
  const verified=(data:Buffer,f:RobotDownloadFile)=>data.length===f.bytes&&createHash('sha256').update(data).digest('hex')===f.sha256&&(!f.gitBlob||createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')===f.gitBlob)
  const pending:RobotDownloadFile[]=[];const staged=new Map<string,Buffer>();const reused:string[]=[]
  for(const f of m.files){
    input.signal.throwIfAborted()
    for(const source of [join(root,f.path),input.localFiles?.get(f.path)].filter((s):s is string=>Boolean(s))){
      try{const data=await readFile(source);if(verified(data,f)){staged.set(f.path,data);reused.push(f.path);break}}catch{}
    }
    if(!staged.has(f.path))pending.push(f)
  }
  if(pending.length){
    if(!input.token)fail('ROBOT_DOWNLOAD_LOCAL_BYTES_MISSING',JSON.stringify({missingFiles:pending.map(f=>f.path)}),m.fallback)
    const opened=await responseBody(await request('/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packId:m.packId,pieces:assetOnly?['asset']:['asset','policy']})}),'json') as {mountId:string;files:RobotDownloadFile[];assetModel?:RobotDownloadManifest['assetModel']}
    if(!opened.mountId||!Array.isArray(opened.files))fail('ROBOT_DOWNLOAD_OPEN_INVALID','open 缺固定快照文件清单',m.fallback)
    if(assetOnly&&!sameAssetModel(opened.assetModel,m.assetModel))fail('ROBOT_DOWNLOAD_OPEN_MISMATCH','open与manifest本体来源/关节身份不符',m.fallback)
    for(const f of pending){
      const listed=opened.files.find(x=>x.path===f.path)
      if(!listed||listed.bytes!==f.bytes||listed.sha256!==f.sha256)fail('ROBOT_DOWNLOAD_OPEN_MISMATCH',`快照身份与 manifest 不符：${f.path}`,m.fallback)
      const snapshotFile=listed!
      if(assetOnly&&['piece','gitBlob','sourceRepository','sourceRevision','sourcePath','url','sourceGitBlob'].some(key=>snapshotFile[key as keyof RobotDownloadFile]!==f[key as keyof RobotDownloadFile]))fail('ROBOT_DOWNLOAD_OPEN_MISMATCH',`asset固定来源与 manifest 不符：${f.path}`,m.fallback)
      const response=await request(`/stream?${new URLSearchParams({mount:opened.mountId,path:f.path})}`)
      const data=Buffer.from(await responseBody(response,'bytes'))
      if(!verified(data,f))fail('ROBOT_DOWNLOAD_INTEGRITY_FAILED',`文件字节与固定身份不符：${f.path}`,m.fallback)
      staged.set(f.path,data)
    }
  }
  const pin=m.adapter&&IMPLEMENTED_POLICY_ADAPTERS.find(p=>p.id===m.adapter!.id)
  const xmlPath=assetOnly?m.assetModel!.entry:m.adapter?.modelEntry??pin?.requires.files.find(p=>p.endsWith('.xml'))
  const xmlData=xmlPath?staged.get(xmlPath):undefined
  if(xmlPath&&!xmlData)fail('ROBOT_DOWNLOAD_MODEL_DEPENDENCY_MISSING',`本体入口缺失：${xmlPath}`,m.fallback)
  if(assetOnly){const actuator=xmlData!.toString('utf8').match(/<actuator>([\s\S]*?)<\/actuator>/)?.[1]??'',joints=[...actuator.matchAll(/\bjoint=["']([^"']+)["']/g)].map(x=>x[1]);if(joints.length!==m.assetModel!.controlledJointNames.length||joints.some((n,i)=>n!==m.assetModel!.controlledJointNames[i]))fail('ROBOT_DOWNLOAD_ASSET_MODEL_INVALID','assetModel受控关节与真实XML顺序不符',m.fallback)}
  const meshdir=xmlData?.toString('utf8').match(/<compiler[^>]*meshdir=["']([^"']+)["']/)?.[1]
  // 源 XML 可声明 meshes/；只去目录尾分隔符，原始相对段仍先过准入，不能让 join 吞掉 ..。
  const meshPrefix=xmlPath&&meshdir?posix.join(posix.dirname(policyFile(xmlPath)),policyFile(meshdir.replace(/\/+$/,''))):pin?.requires.prefixes?.[0]
  if(xmlPath&&meshPrefix){
    const xml=xmlData!.toString('utf8')
    const prefix=policyFile(meshPrefix.replace(/\/+$/,''))
    const dependencies=[...xml.matchAll(/<mesh[^>]*file=["']([^"']+)["']/g)].map(x=>{
      const path=policyFile(posix.join(prefix,policyFile(x[1])))
      if(!path.startsWith(prefix+'/'))fail('ROBOT_DOWNLOAD_MODEL_DEPENDENCY_INVALID','网格依赖超出声明目录',m.fallback)
      return path
    })
    const missing=[...new Set(dependencies)].filter(p=>!staged.has(p))
    if(missing.length)fail('ROBOT_DOWNLOAD_MODEL_DEPENDENCY_MISSING',JSON.stringify({missingFiles:missing}),m.fallback)
  }
  // 全部字节通过后才落本次固定来源清单；不会写其它 session/世界/实体状态。
  let prior:PolicyManifest|undefined
  try{const value=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) as PolicyManifest;if(value.provider==='github'&&value.modelId===m.source.modelId&&value.resolvedRevision===m.source.resolvedRevision)prior=value}catch{}
  for(const [path,data]of staged){input.signal.throwIfAborted();const target=join(root,path),partial=target+'.partial-'+crypto.randomUUID();await mkdir(dirname(target),{recursive:true});await writeFile(partial,data,{mode:0o600});await rename(partial,target)}
  if(assetOnly){await writeFile(join(root,'asset-manifest.json'),JSON.stringify({...m,installedPieces:['asset'],assetBytesVerified:true,fullBundleReady:m.downloadReady,policyPrepared:false},null,2)+'\n',{mode:0o600});return {status:'ASSET_DOWNLOADED',root,modelPath:join(root,m.assetModel!.entry),assetModel:m.assetModel,source:m.source,reusedFiles:reused,downloadedFiles:pending.map(f=>f.path),assetBytesVerified:true,fullBundleReady:m.downloadReady,policyPrepared:false,robotWalkingVerified:false,serverSideInference:false}}
  // 完整包校验包括本体、mesh 与派生合同；只有真实 Git 原件进入 sourceFiles，非原件不冒充公开 URL。
  const installedFiles=m.files.map(f=>{const source=fileSource(f,m);return {...f,gitBlob:f.gitBlob??undefined,revision:source?.revision??m.source.resolvedRevision,url:source?.url??''}})
  const sourceFiles=installedFiles.filter(f=>Boolean(f.url))
  const manifest:PolicyManifest={...prior,status:'DOWNLOADED',provider:'github',modelId:m.source.modelId,revision:m.source.resolvedRevision,resolvedRevision:m.source.resolvedRevision,metadata:{...prior?.metadata,downloadProtocol:m.schema,downloadModelId:m.packId,downloadBundle:{packId:m.packId,fileCount:installedFiles.length,totalBytes:installedFiles.reduce((n,f)=>n+f.bytes,0)},localInference:true},sourceFiles,files:installedFiles,transfers:prior?.transfers??[],execution:prior?.execution??{status:'BLOCKED',reason:'字节已安装；需本地prepare、匹配真实world和实体后才执行'},updatedAt:new Date().toISOString()}
  await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600})
  return {status:'DOWNLOADED',root,source:m.source,reusedFiles:reused,downloadedFiles:pending.map(f=>f.path),policyPrepared:false,robotWalkingVerified:false,serverSideInference:false}
}
