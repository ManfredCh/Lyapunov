import {spawnSync} from 'node:child_process'
import {readFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {inspectSandbox} from './sandbox.mjs'
// SDK 解释器解析与 Host runtime-patch、physics-check 共用同一实现，避免诊断与运行不一致。
import {resolveSdkPython} from '../../packages/lyapunov-product-bundle/src/sdk-python.mjs'
const root=resolve(import.meta.dirname,'../..'),selection=process.argv[2],managed=process.argv[3]==='--managed-sdk'
if(process.argv.length>4||process.argv[3]&&!managed||selection&&!['version','desktop','mujoco','isaac','newton'].includes(selection)||managed&&!['mujoco','isaac','newton'].includes(selection)){console.error('用法：./lyapunov doctor [desktop|mujoco|isaac|newton] [--managed-sdk]');process.exit(2)}
const manifestPath=join(root,'RELEASE.json')
// 只有带源码打包器的检出可以跳过桌面检查，缺清单的发行目录必须明确阻断。
const devCheckout=!existsSync(manifestPath)&&existsSync(join(root,'script/package-linux.ts'))
let manifest
try{
  manifest=devCheckout?{product:'Lyapunov(开发检出)',version:null,platform:process.platform,electron:null,upstreamCommit:null}:JSON.parse(readFileSync(manifestPath,'utf8'))
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||typeof manifest.product!=='string'||!devCheckout&&typeof manifest.version!=='string')throw Error('发行清单缺少 product/version')
}catch(error){console.log(JSON.stringify({status:'BLOCKED',code:existsSync(manifestPath)?'RELEASE_MANIFEST_INVALID':'RELEASE_MANIFEST_MISSING',manifest:manifestPath,message:'无法读取发行清单，请重新完整解包：'+error.message}));process.exit(2)}
if(selection==='version'){
  console.log(JSON.stringify({product:manifest.product,version:manifest.version,platform:manifest.platform,node:process.version,electron:manifest.electron,sourceCommit:manifest.sourceCommit??null,sourceCommitMatchesPayload:manifest.sourceCommitMatchesPayload??null,upstreamCommit:manifest.upstreamCommit}));process.exit(0)
}
const providers={},installHint=name=>'./lyapunov install-provider '+name+(name==='isaac'?' --accept-omniverse-eula':'')
for(const name of selection==='desktop'?[]:selection?[selection]:['mujoco','isaac','newton']){
  const resolved=resolveSdkPython(root,name,process.env,{managed}),python=resolved.python
  if(!existsSync(python)){providers[name]={status:'BLOCKED',code:'PROVIDER_UNAVAILABLE',missing:[name+' 的独立 Python/SDK'],python,pythonSource:resolved.source,install:installHint(name)};continue}
  // newton：解释器是独立环境（Newton 的 pin 与产品 mujoco 冲突），探测要报告版本与 Warp 设备，
  // 因为"没有 NVIDIA GPU"是它的主要边界（provider 会退回 CPU，该降级必须是可解释的）。
  const newtonProbe='import json;\nimport newton, warp as wp;\nfrom importlib.metadata import version as v\ntry:\n    devices=[str(d) for d in wp.get_cuda_devices()]\nexcept Exception:\n    devices=[]\nprint(json.dumps({"provider":"newton","status":"AVAILABLE","version":v("newton"),"warpVersion":wp.config.version,"cudaDevices":devices,"gpuAvailable":bool(devices),"physicalExecution":False}))'
  const args=name==='isaac'?[join(root,'packages/sim-isaac/python/check.py')]
    :name==='newton'?['-c',newtonProbe]
    :['-c','import mujoco,json; print(json.dumps({"provider":"mujoco","status":"AVAILABLE","version":mujoco.__version__,"physicalExecution":False}))']
  const result=spawnSync(python,args,{encoding:'utf8',env:{...process.env,PYTHONNOUSERSITE:'1',HF_ENDPOINT:'https://hf-mirror.com'},timeout:30000})
  // 取**最后一行 JSON**：Warp（newton）等运行时会在 stdout 打初始化横幅，整段 parse 会失败。
  const lastLine=String(result.stdout??'').trim().split('\n').filter(Boolean).pop()??''
  try{
    const report=JSON.parse(lastLine)
    if(!report||typeof report!=='object'||Array.isArray(report)||!['AVAILABLE','BLOCKED'].includes(report.status))throw Error('依赖检查未返回有效状态')
    if(result.error||result.status!==0&&report.status==='AVAILABLE')throw Error(result.error?.message??`依赖检查退出 ${result.status}${result.signal?' ('+result.signal+')':''}`)
    providers[name]=report
  }catch(error){providers[name]={status:'BLOCKED',code:'PROVIDER_UNAVAILABLE',message:result.error?.message??(String(result.stderr??'').trim()||error.message),install:installHint(name)}}
  if(providers[name].status!=='AVAILABLE'){
    providers[name].install??=installHint(name)
    providers[name].hint=resolved.source!=='package-default'?'当前检查的是外部 SDK；install-provider 只安装包内环境，不会修复此路径。请修复该 SDK，或在物理引擎设置恢复产品默认并取消对应 LYAPUNOV_*_PYTHON 覆盖后重试。':'重跑安装命令会复用已有 Python 前缀并补齐缺失依赖；非空且不可复用的前缀会失败并保留原目录。'
  }
  providers[name].exitCode=result.status
  providers[name].python=python
  providers[name].pythonSource=resolved.source
}
// 桌面检查必须区分“桌面二进制缺失 / ldd 不可用或失败 / 缺共享库”与确认可用；只有 ldd 确认成功才可能是 AVAILABLE。
const desktopBinary=join(root,'runtime/electron/lyapunov-desktop')
let desktop
if(devCheckout)desktop={status:'SKIPPED',code:'RELEASE_MANIFEST_MISSING',binary:desktopBinary,message:'开发检出没有发行打包产物 RELEASE.json 与桌面二进制，跳过桌面检查（只判 provider）。'}
else if(!existsSync(desktopBinary))desktop={status:'BLOCKED',code:'DESKTOP_BINARY_MISSING',electron:manifest.electron,binary:desktopBinary,message:'缺少桌面二进制，安装包可能不完整；请重新解包并保留完整目录结构',missingSystemLibraries:[]}
else{
  const desktopLibraries=spawnSync('ldd',[desktopBinary],{encoding:'utf8'})
  if(desktopLibraries.error||desktopLibraries.status!==0)desktop={status:'BLOCKED',code:'DESKTOP_LIBRARY_CHECK_UNAVAILABLE',electron:manifest.electron,binary:desktopBinary,message:String(desktopLibraries.error?.message??desktopLibraries.stderr?.trim()??('ldd 退出 '+desktopLibraries.status)),missingSystemLibraries:[]}
  else{
    const missingLibraries=desktopLibraries.stdout.split('\n').filter(line=>line.includes('not found')).map(line=>line.trim())
    desktop={status:missingLibraries.length?'BLOCKED':'AVAILABLE',...(missingLibraries.length?{code:'DESKTOP_LIBRARIES_MISSING'}:{}),electron:manifest.electron,binary:desktopBinary,missingSystemLibraries:missingLibraries}
  }
}
if(!devCheckout&&desktop.status==='AVAILABLE'){const sandbox=inspectSandbox(root);desktop.sandbox=sandbox;if(sandbox.status!=='AVAILABLE'){desktop.status='BLOCKED';desktop.code=sandbox.code;desktop.message=sandbox.message;desktop.install=sandbox.setupCommand}}
const providersOk=Object.values(providers).every(value=>value.status==='AVAILABLE')
const result={status:providersOk&&(devCheckout||desktop.status==='AVAILABLE')?'AVAILABLE':'BLOCKED',node:{version:process.version,executable:process.execPath},desktop,providers,scope:'依赖检查；不代表引擎真实运动、模型推理或正式账户登录成功。'}
console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='AVAILABLE'?0:2
