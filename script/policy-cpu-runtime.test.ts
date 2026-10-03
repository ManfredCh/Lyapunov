import {describe,expect,test}from "bun:test"
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,chmodSync,readFileSync,rmSync}from "node:fs"
import {tmpdir}from "node:os"
import {join,dirname}from "node:path"
import {spawnSync}from "node:child_process"
import {resolvePolicyPython,checkPolicyCpu,policyRuntimeCandidates}from "../packages/lyapunov-product-bundle/src/policy-runtime.mjs"
import {backendEnvironment}from "./profile.ts"
import {runtimePaths}from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import {runtimePluginInsert}from "./runtime-patch.ts"

describe("独立CPU策略前缀与Host解释器",()=>{
 test("明确policy override与managed默认优先，不能借MuJoCo/Isaac",()=>{
  const env={LYAPUNOV_POLICY_PYTHON:"/selected/policy/python",LYAPUNOV_MUJOCO_PYTHON:"/other/physics/python",LYAPUNOV_ISAAC_PYTHON:"/other/isaac/python"}
  expect(resolvePolicyPython("/product",env)).toEqual({python:"/selected/policy/python",source:"env-override"})
  expect(resolvePolicyPython("/product",env,{managed:true})).toEqual({python:"/product/.runtime/policy-python/bin/python",source:"package-default"})
  expect(checkPolicyCpu("/not-existing-product",env,{managed:true})).toMatchObject({status:"BLOCKED",code:"POLICY_CPU_RUNTIME_MISSING"})
 })
 test("实际Host插件表显式下发policy路径，物理解释器保持自己的选择",()=>{
  const rows=runtimePluginInsert({mode:"local",surface:"web",sceneRoot:"/fixture/scene",engine:"mujoco",grasp:"none",sdkEnvironment:{LYAPUNOV_POLICY_PYTHON:"/selected/cpu-policy/python",LYAPUNOV_MUJOCO_PYTHON:"/selected/mujoco/python"}})
  expect(rows.find(row=>row.id==="lyapunov-policy-registry")?.config?.pythonPath).toBe("/selected/cpu-policy/python")
  expect(rows.find(row=>row.id==="lyapunov-sim-mujoco")?.config?.pythonPath).toBe("/selected/mujoco/python")
 })
 test("无policy override的实际Host只登记有限正式候选，由来源模块决定CPU解释器",()=>{
  const root=mkdtempSync(join(tmpdir(),'policy-candidate-'))
  try{const preference=join(root,'engine.json');writeFileSync(preference,JSON.stringify({sdkPython:{mujoco:'/saved/mujoco/python',isaac:'/saved/isaac/python'}}))
   const env={LYAPUNOV_ENGINE_PREFERENCE_FILE:preference},candidates=policyRuntimeCandidates(root,env)
   expect(candidates).toEqual([{python:join(root,'.runtime/policy-python/bin/python'),source:'package-default',provider:'policy-cpu'},{python:'/saved/mujoco/python',source:'saved-preference',provider:'mujoco'},{python:'/saved/isaac/python',source:'saved-preference',provider:'isaac'}])
   const config=runtimePluginInsert({mode:'local',surface:'native-fixture',sceneRoot:'/fixture/scene',engine:'mujoco',sdkEnvironment:env}).find(row=>row.id==='lyapunov-policy-registry')!.config!
   expect(config).not.toHaveProperty('pythonPath');expect(config.pythonRuntimes).toHaveLength(3);expect(config.pythonRuntimes).not.toContain('/E/test-python')
   expect(policyRuntimeCandidates(root,{...env,LYAPUNOV_POLICY_PYTHON:'/explicit/policy/python'})).toEqual([{python:'/explicit/policy/python',source:'env-override',provider:'policy-configured'}])
  }finally{rmSync(root,{recursive:true,force:true})}
 })
 test("隔离Host仅保留policy路径配置，不透传其他父秘密",async()=>{
  const root=mkdtempSync(join(tmpdir(),"policy-host-env-"))
  try{const paths=runtimePaths({root,mode:"local"}),env=await backendEnvironment("local",paths,{isolated:true,parent:{PATH:"/usr/bin",LYAPUNOV_POLICY_PYTHON:"/selected/policy/python",OTHER_SECRET:"must-not-cross"}})
   expect(env.LYAPUNOV_POLICY_PYTHON).toBe("/selected/policy/python");expect(env.OTHER_SECRET).toBeUndefined()
  }finally{rmSync(root,{recursive:true,force:true})}
 })
 test("真实安装脚本仅调用新前缀，收尾managed不能借外部解释器；pip/下载为明确离线替身",()=>{
  const fixture=mkdtempSync(join(tmpdir(),"policy-install-routing-")),product=join(fixture,"product"),source=join(import.meta.dir,"..")
  const put=(path:string,content:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content)}
  const executable=(path:string,content:string)=>{put(path,content);chmodSync(path,0o755)}
  try{
   for(const file of ["distribution/linux/install-provider","packages/policy-registry/requirements-cpu.txt"]){mkdirSync(dirname(join(product,file)),{recursive:true});copyFileSync(join(source,file),join(product,file))}
   put(join(product,"script/package-linux.ts"),"// source fixture")
   put(join(product,"packages/lyapunov-product-bundle/src/policy-runtime.mjs"),"// payload existence fixture")
   put(join(product,"distribution/linux/policy-cpu.mjs"),`import{writeFileSync}from'node:fs';if(process.argv[2]==='wheel')console.log(${JSON.stringify(join(fixture,"torch-cpu.whl"))});else{writeFileSync(${JSON.stringify(join(fixture,"doctor.json"))},JSON.stringify({action:process.argv[2],managed:process.argv[3],envPolicy:process.env.LYAPUNOV_POLICY_PYTHON}));console.log(JSON.stringify({status:'AVAILABLE',scope:'offline routing fixture'}))}`)
   const prefix=join(product,".runtime/policy-python"),log=join(fixture,"pip.log")
   executable(join(prefix,"bin/python"),`#!/bin/sh\nif [ "$1" = -c ];then printf '%s\\n' '${prefix}';exit 0;fi\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`)
   executable(join(fixture,"micromamba"),"#!/bin/sh\nexit 9\n")
   const result=spawnSync("/bin/sh",[join(product,"distribution/linux/install-provider"),"policy-cpu"],{encoding:"utf8",env:{...process.env,LYAPUNOV_NODE_BIN:process.execPath,LYAPUNOV_MICROMAMBA:join(fixture,"micromamba"),LYAPUNOV_POLICY_PYTHON:"/outside/python"},timeout:5000})
   expect(result.status,result.stderr).toBe(0)
   expect(readFileSync(log,"utf8")).toContain("--isolated install --cache-dir")
   expect(readFileSync(log,"utf8")).toContain("torch-cpu.whl")
   expect(JSON.parse(readFileSync(join(fixture,"doctor.json"),"utf8"))).toMatchObject({action:"doctor",managed:"--managed-sdk"})
  }finally{rmSync(fixture,{recursive:true,force:true})}
 })
})
