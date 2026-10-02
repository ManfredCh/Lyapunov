import {resolve} from 'node:path'
import {ensurePolicyCpuWheel,checkPolicyCpu} from '../../packages/lyapunov-product-bundle/src/policy-runtime.mjs'
const root=resolve(import.meta.dirname,'../..'),action=process.argv[2],managed=process.argv[3]==='--managed-sdk'
if(!['wheel','doctor'].includes(action)||process.argv.length>4||process.argv[3]&&!managed){console.error('用法：policy-cpu.mjs wheel|doctor [--managed-sdk]');process.exit(2)}
try{
 if(action==='wheel'){console.log(await ensurePolicyCpuWheel(root));process.exit(0)}
 const result=checkPolicyCpu(root,process.env,{managed});console.log(JSON.stringify(result,null,2));process.exit(result.status==='AVAILABLE'?0:2)
}catch(error){console.error(String(error));process.exit(2)}
