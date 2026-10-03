import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {policyRuntimeCandidates} from '../../lyapunov-product-bundle/src/policy-runtime.mjs'
import {IMPLEMENTED_POLICY_ADAPTERS} from './pack-contract.ts'

export interface PolicyRuntimeCandidate {python:string;provider:string;source:string}
export interface PolicyRuntimeConfig {pythonPath?:string;pythonRuntimes?:readonly PolicyRuntimeCandidate[]}
export interface PolicyRuntimeResolution {
 status:'AVAILABLE'|'BLOCKED';adapterId?:string;python?:string;provider?:string;source?:string;requiredModules:string[]
 modules:string[];versions:Record<string,string>;pythonPrefix?:string;moduleFiles?:Record<string,string>;device:'cpu'
 physicalEngineStarted:false;policyInferenceVerified:false;observedAt:string
 checked:Array<{python:string;provider:string;source:string;missingModules:string[];error?:string}>
 prepare?:{provider:'policy-cpu'|'mujoco';command:string;detail:string}
}
const productRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const cached=new Map<string,{at:number;value:Promise<any>}>()
async function probe(candidate:PolicyRuntimeCandidate,requiredModules:string[]){
 if(!existsSync(candidate.python))return {modules:[],versions:{},missingModules:requiredModules,error:'解释器落点不存在'}
 const key=candidate.python+'\0'+requiredModules.join('/'),previous=cached.get(key)
 if(previous&&Date.now()-previous.at<10000)return previous.value
 const value=(async()=>{
  const script=`import importlib,json,os,sys\nrequired=json.loads(sys.argv[1]);out={'modules':[],'versions':{},'moduleFiles':{},'missingModules':[],'pythonPrefix':os.path.realpath(sys.prefix)}\nfor name in required:\n try:\n  module=importlib.import_module(name)\n  if name=='torch':\n   module.set_num_threads(1);t=module.ones((1,75),device='cpu')\n   if str(t.device)!='cpu' or not bool(module.isfinite(t).all()):raise RuntimeError('Torch CPU张量检查失败')\n  if name=='onnxruntime' and 'CPUExecutionProvider' not in module.get_available_providers():raise RuntimeError('ONNX CPUExecutionProvider缺失')\n  out['modules'].append(name);out['versions'][name]=str(getattr(module,'__version__','unknown'));out['moduleFiles'][name]=os.path.realpath(getattr(module,'__file__',''))\n except Exception:out['missingModules'].append(name)\nprint(json.dumps(out))`
  try{const {stdout}=await promisify(execFile)(candidate.python,['-I','-c',script,JSON.stringify(requiredModules)],{timeout:15000,maxBuffer:16384,env:{...process.env,CUDA_VISIBLE_DEVICES:'',PYTHONNOUSERSITE:'1',HF_ENDPOINT:'https://hf-mirror.com',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});const result=JSON.parse(stdout.trim());if(!Array.isArray(result.modules)||!Array.isArray(result.missingModules)||!result.versions||typeof result.pythonPrefix!=='string')throw Error('模块预检JSON不完整');return result}
  catch(error){return {modules:[],versions:{},missingModules:requiredModules,error:error instanceof Error?error.message:String(error)}}
 })()
 cached.set(key,{at:Date.now(),value});return value
}
/** 唯一固定来源的runtimeModules决定解释器；model/tool参数不能提供Python或候选列表。 */
export async function selectPolicyRuntime(config:PolicyRuntimeConfig={},adapterId?:string):Promise<PolicyRuntimeResolution>{
 const pin=IMPLEMENTED_POLICY_ADAPTERS.find(row=>row.id===adapterId)
 const requiredModules=pin?.requires.runtimeModules??(adapterId==='libero-smolvla-v1'?['mujoco','numpy','torch','transformers','PIL','safetensors']:['mujoco','numpy'])
 const explicit=config.pythonPath?.trim()||process.env.LYAPUNOV_POLICY_PYTHON?.trim()
 const candidates:readonly PolicyRuntimeCandidate[]=explicit?[{python:explicit,provider:'policy-configured',source:config.pythonPath?'host-config':'env-override'}]:config.pythonRuntimes??policyRuntimeCandidates(productRoot)
 const rank=(c:PolicyRuntimeCandidate)=>c.provider==='policy-configured'?-1:c.provider==='policy-cpu'?0:c.provider===(requiredModules.includes('torch')?'isaac':'mujoco')?1:2
 const ordered=[...candidates].sort((a,b)=>rank(a)-rank(b)),out:PolicyRuntimeResolution={status:'BLOCKED',adapterId,requiredModules:[...requiredModules],modules:[],versions:{},device:'cpu',physicalEngineStarted:false,policyInferenceVerified:false,observedAt:new Date().toISOString(),checked:[]}
 for(const candidate of ordered){
  if(!candidate||typeof candidate.python!=='string'||!candidate.python.trim())continue
  const report=await probe(candidate,[...requiredModules]);out.checked.push({...candidate,missingModules:report.missingModules,error:report.error})
  if(report.missingModules.length)continue
  return {...out,status:'AVAILABLE',...candidate,modules:report.modules,versions:report.versions,moduleFiles:report.moduleFiles,pythonPrefix:report.pythonPrefix,observedAt:new Date().toISOString()}
 }
 const provider=requiredModules.includes('onnxruntime')?'mujoco':'policy-cpu'
 out.prepare={provider,command:'./lyapunov install-provider '+provider,detail:explicit?'明确选择的策略解释器缺依赖；修复该路径或在Host设置恢复默认。安装器仅管理产品前缀，不修改此外置路径。':'没有已登记解释器满足当前来源依赖；准备对应产品前缀后重新检查，不重新搜索已选本体。'}
 return out
}
export async function requirePolicyRuntime(config:PolicyRuntimeConfig={},adapterId?:string){
 const runtime=await selectPolicyRuntime(config,adapterId)
 if(runtime.status!=='AVAILABLE'||!runtime.python)throw Error('POLICY_RUNTIME_UNAVAILABLE: '+JSON.stringify(runtime))
 return runtime as PolicyRuntimeResolution&{python:string}
}
