import {existsSync,createReadStream,realpathSync} from 'node:fs'
import {mkdir,writeFile,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {spawn,spawnSync} from 'node:child_process'
import {resolveSdkPython} from './sdk-python.mjs'

export const POLICY_CPU_PACKAGE_PATH='.runtime/policy-python/bin/python'
export const POLICY_CPU_WHEEL={name:'torch-2.11.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl',url:'https://download.pytorch.org/whl/cpu/torch-2.11.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl',bytes:190312281,sha256:'f82e2ae20c1545bb03997d1cc3143d94e14b800038669ee1aca45808a9acc338'}
// PyPI 的同版 macOS arm64 轮子没有 +cpu 后缀；设备仍由策略运行器显式选择 CPU。
export const POLICY_CPU_MACOS_WHEEL={name:'torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl',url:'https://files.pythonhosted.org/packages/6f/8b/69e3008d78e5cee2b30183340cc425081b78afc5eff3d080daab0adda9aa/torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl',bytes:80606338,sha256:'4b5866312ee6e52ea625cd211dcb97d6a2cdc1131a5f15cc0d87eec948f6dd34'}
export function policyCpuWheel(platform=process.platform,arch=process.arch){
 if(platform==='linux'&&arch==='x64')return POLICY_CPU_WHEEL
 if(platform==='darwin'&&arch==='arm64')return POLICY_CPU_MACOS_WHEEL
 throw new Error(`POLICY_CPU_PLATFORM_UNSUPPORTED: 尚无固定CPU轮子：${platform}/${arch}`)
}

/** policy解释器独立于物理SDK；不读取账号/Conda配置，不借MuJoCo/Isaac环境判成功。 */
export function resolvePolicyPython(root,env=process.env,options={}){
 const override=!options.managed&&env.LYAPUNOV_POLICY_PYTHON?.trim()
 return {python:override||join(root,POLICY_CPU_PACKAGE_PATH),source:override?'env-override':'package-default'}
}
/** Host只描述有限的已登记落点；实际依赖由策略来源选择器核验，不扫描目录或起Kit。 */
export function policyRuntimeCandidates(root,env=process.env){
 const policy=resolvePolicyPython(root,env)
 if(policy.source==='env-override')return [{...policy,provider:'policy-configured'}]
 const rows=[{...policy,provider:'policy-cpu'},...['mujoco','isaac'].map(provider=>({...resolveSdkPython(root,provider,env),provider}))]
 return rows.filter((row,i)=>rows.findIndex(other=>other.python===row.python)===i)
}
async function hash(path){const digest=createHash('sha256');let bytes=0;for await(const data of createReadStream(path)){bytes+=data.length;digest.update(data)}return {bytes,sha256:digest.digest('hex')}}
export async function ensurePolicyCpuWheel(root){
 const wheel=policyCpuWheel()
 const directory=join(root,'.runtime/provider-download-cache/policy-cpu-wheels'),target=join(directory,wheel.name)
 await mkdir(directory,{recursive:true})
 if(existsSync(target)){const actual=await hash(target);if(actual.bytes!==wheel.bytes||actual.sha256!==wheel.sha256)throw new Error('POLICY_CPU_WHEEL_CACHE_INVALID: 已有CPU wheel校验不符，未覆盖文件');return target}
 // 复用发行已有的固定 pin 分段续传工具；CPU 不维护第二套 HTTP／partial／发布实现。
 const helper=join(root,'distribution/linux/fetch-extscache-kit.mjs')
 if(!existsSync(helper))throw new Error('RELEASE_PAYLOAD_MISSING: '+helper)
 const pin=join(directory,'.policy-wheel-'+randomUUID()+'.json')
 try{
  await writeFile(pin,JSON.stringify({filename:wheel.name,url:wheel.url,bytes:wheel.bytes,sha256:wheel.sha256}),{mode:0o600,flag:'wx'})
  await new Promise((done,reject)=>{
   const child=spawn(process.execPath,[helper,'--pin',pin,'--wheels-dir',directory,'--segment-bytes','262144'],{env:process.env,stdio:['ignore','ignore','inherit']})
   child.once('error',reject)
   child.once('close',(code,signal)=>code===0?done():reject(new Error(`POLICY_CPU_WHEEL_DOWNLOAD_FAILED: exit=${code??signal}; partial bytes retained for retry; complete hash verification is still required`)))
  })
  const actual=await hash(target)
  if(actual.bytes!==wheel.bytes||actual.sha256!==wheel.sha256)throw new Error('POLICY_CPU_WHEEL_CHECKSUM_MISMATCH')
  return target
 }finally{await unlink(pin).catch(()=>{})}
}

const probe=`import json,os,sys,torch,mujoco,numpy,yaml
torch.set_num_threads(1)
x=torch.zeros((1,75),device='cpu');y=x+1
versions={'torch':torch.__version__,'mujoco':mujoco.__version__,'numpy':numpy.__version__,'yaml':yaml.__version__}
valid=versions=={'torch':sys.argv[1],'mujoco':'3.13.0','numpy':'2.4.6','yaml':'6.0.3'} and torch.version.cuda is None and str(y.device)=='cpu' and bool(torch.isfinite(y).all())
print(json.dumps({'provider':'policy-cpu','status':'AVAILABLE' if valid else 'BLOCKED','versions':versions,'device':str(y.device),'cudaBuild':torch.version.cuda,'pythonPrefix':os.path.realpath(sys.prefix),'physicalExecution':False,'policyWalkingVerified':False}))
sys.exit(0 if valid else 2)`
export function checkPolicyCpu(root,env=process.env,options={}){
 const resolved=resolvePolicyPython(root,env,options),python=resolved.python
 if(!existsSync(python))return {provider:'policy-cpu',status:'BLOCKED',code:'POLICY_CPU_RUNTIME_MISSING',...resolved,install:'./lyapunov install-provider policy-cpu'}
 let expectedTorch
 try{expectedTorch=policyCpuWheel().name.split('-')[1]}catch(error){return {provider:'policy-cpu',status:'BLOCKED',code:'POLICY_CPU_PLATFORM_UNSUPPORTED',...resolved,message:String(error)}}
 const result=spawnSync(python,['-c',probe,expectedTorch],{encoding:'utf8',timeout:30000,env:{...env,PYTHONNOUSERSITE:'1',CUDA_VISIBLE_DEVICES:'',HF_ENDPOINT:'https://hf-mirror.com'}})
 try{
  const report=JSON.parse(String(result.stdout).trim().split('\n').pop())
  if(result.status!==0||report.status!=='AVAILABLE')throw new Error('CPU模块/版本检查不符')
  if(options.managed&&report.pythonPrefix!==realpathSync(join(root,'.runtime/policy-python')))throw new Error('包内前缀身份不符')
  return {...report,...resolved}
 }catch(error){return {provider:'policy-cpu',status:'BLOCKED',code:'POLICY_CPU_RUNTIME_INVALID',...resolved,message:result.error?.message||String(result.stderr).trim()||String(error),install:'./lyapunov install-provider policy-cpu'}}
}
