import {existsSync,createReadStream,createWriteStream,realpathSync} from 'node:fs'
import {mkdir,rename,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {resolveSdkPython} from './sdk-python.mjs'

export const POLICY_CPU_PACKAGE_PATH='.runtime/policy-python/bin/python'
export const POLICY_CPU_WHEEL={name:'torch-2.11.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl',url:'https://download.pytorch.org/whl/cpu/torch-2.11.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl',bytes:190312281,sha256:'f82e2ae20c1545bb03997d1cc3143d94e14b800038669ee1aca45808a9acc338'}

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
 if(process.platform!=='linux'||process.arch!=='x64')throw new Error('POLICY_CPU_PLATFORM_UNSUPPORTED: 当前安装声明只覆盖Linux x64')
 const directory=join(root,'.runtime/provider-download-cache/policy-cpu-wheels'),target=join(directory,POLICY_CPU_WHEEL.name)
 await mkdir(directory,{recursive:true})
 if(existsSync(target)){const actual=await hash(target);if(actual.bytes!==POLICY_CPU_WHEEL.bytes||actual.sha256!==POLICY_CPU_WHEEL.sha256)throw new Error('POLICY_CPU_WHEEL_CACHE_INVALID: 已有CPU wheel校验不符，未覆盖文件');return target}
 const temporary=target+'.incoming-'+randomUUID()
 try{
  const response=await fetch(POLICY_CPU_WHEEL.url,{signal:AbortSignal.timeout(180000)})
  if(!response.ok||!response.body)throw new Error('POLICY_CPU_WHEEL_HTTP_'+response.status)
  let received=0;const limit=new Transform({transform(chunk,_encoding,done){received+=chunk.length;done(received>POLICY_CPU_WHEEL.bytes?new Error('POLICY_CPU_WHEEL_SIZE_EXCEEDED'):null,chunk)}})
  await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temporary,{flags:'wx'}))
  const actual=await hash(temporary)
  if(actual.bytes!==POLICY_CPU_WHEEL.bytes||actual.sha256!==POLICY_CPU_WHEEL.sha256)throw new Error('POLICY_CPU_WHEEL_CHECKSUM_MISMATCH')
  await rename(temporary,target);return target
 }catch(error){await unlink(temporary).catch(()=>{});throw error}
}

const probe=`import json,os,sys,torch,mujoco,numpy,yaml
torch.set_num_threads(1)
x=torch.zeros((1,75),device='cpu');y=x+1
versions={'torch':torch.__version__,'mujoco':mujoco.__version__,'numpy':numpy.__version__,'yaml':yaml.__version__}
valid=versions=={'torch':'2.11.0+cpu','mujoco':'3.13.0','numpy':'2.4.6','yaml':'6.0.3'} and torch.version.cuda is None and str(y.device)=='cpu' and bool(torch.isfinite(y).all())
print(json.dumps({'provider':'policy-cpu','status':'AVAILABLE' if valid else 'BLOCKED','versions':versions,'device':str(y.device),'cudaBuild':torch.version.cuda,'pythonPrefix':os.path.realpath(sys.prefix),'physicalExecution':False,'policyWalkingVerified':False}))
sys.exit(0 if valid else 2)`
export function checkPolicyCpu(root,env=process.env,options={}){
 const resolved=resolvePolicyPython(root,env,options),python=resolved.python
 if(!existsSync(python))return {provider:'policy-cpu',status:'BLOCKED',code:'POLICY_CPU_RUNTIME_MISSING',...resolved,install:'./lyapunov install-provider policy-cpu'}
 const result=spawnSync(python,['-c',probe],{encoding:'utf8',timeout:30000,env:{...env,PYTHONNOUSERSITE:'1',CUDA_VISIBLE_DEVICES:'',HF_ENDPOINT:'https://hf-mirror.com'}})
 try{
  const report=JSON.parse(String(result.stdout).trim().split('\n').pop())
  if(result.status!==0||report.status!=='AVAILABLE')throw new Error('CPU模块/版本检查不符')
  if(options.managed&&report.pythonPrefix!==realpathSync(join(root,'.runtime/policy-python')))throw new Error('包内前缀身份不符')
  return {...report,...resolved}
 }catch(error){return {provider:'policy-cpu',status:'BLOCKED',code:'POLICY_CPU_RUNTIME_INVALID',...resolved,message:result.error?.message||String(result.stderr).trim()||String(error),install:'./lyapunov install-provider policy-cpu'}}
}
