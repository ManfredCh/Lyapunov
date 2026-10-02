/** 离线探针报文替身验证选择/失败合同；不签真实SDK、推理或物理。 */
import {test,expect} from 'bun:test'
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {selectPolicyRuntime} from '../src/runtime.ts'

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'policy-runtime-selection-'))
 const python=async(name:string,modules:string[],missingModules:string[]=[])=>{const path=join(root,name),json=JSON.stringify({modules,missingModules,versions:Object.fromEntries(modules.map(m=>[m,'fixture'])),moduleFiles:Object.fromEntries(modules.map(m=>[m,'/fixture/'+m+'/__init__.py'])),pythonPrefix:'/fixture'});await writeFile(path,"#!/bin/sh\nprintf '%s\\n' '"+json+"'\n");await chmod(path,0o755);return path}
 return {root,python,dispose:()=>rm(root,{recursive:true,force:true})}
}
test('按唯一来源模块选择已登记SDK：Go2只需Mu/ONNX，Go1/G123复用Isaac纯CPU依赖',async()=>{
 const f=await fixture();try{
  const mu=await f.python('mujoco-python',['mujoco','numpy','onnxruntime']),isaac=await f.python('isaac-python',['mujoco','numpy','torch','yaml'])
  const pythonRuntimes=[{python:join(f.root,'policy-not-installed'),provider:'policy-cpu',source:'package-default'},{python:mu,provider:'mujoco',source:'saved-preference'},{python:isaac,provider:'isaac',source:'saved-preference'}]
  const go2=await selectPolicyRuntime({pythonRuntimes},'inria-go2-onnx-v1');expect(go2.status).toBe('AVAILABLE');expect(go2.python).toBe(mu);expect(go2.requiredModules).toEqual(['mujoco','numpy','onnxruntime']);expect(go2.physicalEngineStarted).toBe(false);expect(go2.policyInferenceVerified).toBe(false)
  for(const id of ['wtw-go1-torchscript-v1','jlog-g1-23-75-torchscript-v1']){const rt=await selectPolicyRuntime({pythonRuntimes},id);expect(rt.python).toBe(isaac);expect(rt.provider).toBe('isaac');expect(rt.source).toBe('saved-preference');expect(rt.requiredModules).toEqual(['mujoco','numpy','torch']);expect(rt.device).toBe('cpu')}
 }finally{await f.dispose()}
})
test('明确policy解释器失效只阻断这条选择，不静默借其它已登记SDK成功',async()=>{
 const f=await fixture();try{
  const selected=await f.python('explicit-incomplete',['mujoco','numpy'],['torch']),other=await f.python('good-managed',['mujoco','numpy','torch'])
  const rt=await selectPolicyRuntime({pythonPath:selected,pythonRuntimes:[{python:other,provider:'isaac',source:'package-default'}]},'jlog-g1-23-75-torchscript-v1')
  expect(rt.status).toBe('BLOCKED');expect(rt.checked).toHaveLength(1);expect(rt.checked[0]!.python).toBe(selected);expect(rt.checked[0]!.missingModules).toEqual(['torch']);expect(rt.prepare?.command).toBe('./lyapunov install-provider policy-cpu');expect(rt.python).toBeUndefined()
 }finally{await f.dispose()}
})
test('未安装有限候选给实际依赖与已有准备入口，不搜索未知目录或下载',async()=>{
 const f=await fixture();try{await mkdir(join(f.root,'nearby'))
  const rt=await selectPolicyRuntime({pythonRuntimes:[{python:join(f.root,'missing-python'),provider:'mujoco',source:'package-default'}]},'inria-go2-onnx-v1')
  expect(rt.status).toBe('BLOCKED');expect(rt.checked).toHaveLength(1);expect(rt.checked[0]!.missingModules).toEqual(['mujoco','numpy','onnxruntime']);expect(rt.prepare?.command).toBe('./lyapunov install-provider mujoco');expect(rt.modules).toEqual([])
 }finally{await f.dispose()}
})
