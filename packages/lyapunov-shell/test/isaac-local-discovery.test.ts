import {afterEach, describe, expect, test} from "bun:test"
import {spawnSync} from "node:child_process"
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join, resolve} from "node:path"
import {createIsaacLocalDiscovery, isaacCandidatePaths, registerIsaacLocalRoutes} from "../src/isaac-local-discovery.ts"
import {probeEngineRuntimes} from "../src/environment-readiness.ts"
import {createProviderInstaller} from "../src/provider-installer.ts"
import {sdkRuntimeFacts, writeEnginePreference, writeSdkPythonPreference} from "../../../script/engine-preference.ts"
import {runtimePluginInsert} from "../../../script/runtime-patch.ts"
import {readSdkPythonPreference, resolveSdkPython} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {clearIsaacSdkProbeCache, inspectIsaacPython} from "../../lyapunov-product-bundle/src/isaac-sdk-probe.mjs"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../../..")
const roots: string[] = []
afterEach(() => {clearIsaacSdkProbeCache();for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})})
function scratch() {const root=mkdtempSync(join(tmpdir(),"lyapunov-isaac-local-"));roots.push(root);return root}
const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
function executable(file: string, text: string) {mkdirSync(dirname(file), {recursive: true});writeFileSync(file, text);chmodSync(file, 0o755)}
/** SDK fixture 的模块体主动抛错；若发现检查 import Isaac 而不是 find_spec，测试会失败。 */
function pipSdk(root: string, version="6.0.1.0") {
  const site=join(root,"lib/python3.12/site-packages")
  mkdirSync(join(site,"isaacsim/kit"),{recursive:true})
  writeFileSync(join(site,"isaacsim/__init__.py"),'raise RuntimeError("must never import Isaac during discovery")\n')
  mkdirSync(join(site,`isaacsim-${version}.dist-info`),{recursive:true})
  writeFileSync(join(site,`isaacsim-${version}.dist-info/METADATA`),`Metadata-Version: 2.1\nName: isaacsim\nVersion: ${version}\n`)
  const python=join(root,"bin/python")
  executable(python,`#!/bin/sh\nexport PYTHONPATH=${shQuote(site)}\nexec /usr/bin/python3 "$@"\n`)
  return {python,site}
}
function standaloneSdk(root: string, options: {version?: string; module?: boolean; outside?: string}={}) {
  mkdirSync(join(root,"kit"),{recursive:true});mkdirSync(join(root,"exts"),{recursive:true})
  writeFileSync(join(root,"VERSION"),`${options.version??"6.0.1"}\n`)
  const site=options.outside??join(root,"exts/isaacsim.simulation_app")
  if(options.module!==false){mkdirSync(join(site,"isaacsim"),{recursive:true});writeFileSync(join(site,"isaacsim/__init__.py"),'raise RuntimeError("must never import Isaac during discovery")\n')}
  const python=join(root,"python.sh")
  executable(python,`#!/bin/sh\nexport ISAAC_PATH=${shQuote(root)}\nexport PYTHONPATH=${shQuote(site)}\nexec /usr/bin/python3 "$@"\n`)
  return {python,site}
}
// installer会合并父进程env；显式清空两套SDK覆盖，才能测试“此临时偏好”的选择而非真人配置。
const envFor = (root: string): NodeJS.ProcessEnv => ({LYAPUNOV_ENGINE_PREFERENCE_FILE:join(root,"engine.json"),LYAPUNOV_ISAAC_PYTHON:"",LYAUP_ISAAC_PYTHON:""})

describe("本地 Isaac SDK 发现与同一配置持久选择",()=>{
  test("发现多个真实模块/元数据候选，只检查而不自动选择或接受许可",async()=>{
    const root=scratch(), installations=join(root,"installations")
    const pip=pipSdk(join(installations,"pip")), standalone=standaloneSdk(join(installations,"standalone"))
    const env=envFor(root),local=createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env,scanRoots:[installations]})
    expect(local.selection().savedPython).toBeNull()
    expect(existsSync(env.LYAPUNOV_ENGINE_PREFERENCE_FILE!)).toBe(false)
    const result=await local.discover()
    expect(result.candidates.filter(row=>row.compatible).map(row=>row.python).sort()).toEqual([pip.python,standalone.python].sort())
    expect(result.selection.savedPython).toBeNull()
    expect(existsSync(env.LYAPUNOV_ENGINE_PREFERENCE_FILE!)).toBe(false)
    expect(existsSync(join(installations,"standalone/kit/EULA_ACCEPTED"))).toBe(false)
    const check=spawnSync(standalone.python,[join(PRODUCT_ROOT,"packages/sim-isaac/python/check.py")],{encoding:"utf8",env:{PYTHONDONTWRITEBYTECODE:"1",PYTHONNOUSERSITE:"1"}})
    expect(check.status).toBe(2)
    expect(JSON.parse(check.stdout).code).toBe("LICENSE_CONFIRMATION_REQUIRED")
  })

  test("保存选择保留引擎/许可，重新创建读取后 resolver、Host 装配和环境面板一致",async()=>{
    const root=scratch(),{python}=pipSdk(join(root,"SDK with spaces")),env=envFor(root)
    writeFileSync(env.LYAPUNOV_ENGINE_PREFERENCE_FILE!,JSON.stringify({engine:"mujoco",licenses:{isaac:{acceptedAt:"2026-09-30T01:00:00Z",eulaUrl:"https://example.invalid/test"}}}))
    let changes=0
    const local=createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env,onChanged:()=>{changes++}})
    const selected=await local.select(dirname(dirname(python)))
    expect(selected.savedPython).toBe(python);expect(selected.restartRequired).toBe(true);expect(changes).toBe(1)
    expect(createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env}).selection()).toEqual(selected)
    const stored=JSON.parse(readFileSync(env.LYAPUNOV_ENGINE_PREFERENCE_FILE!,"utf8"))
    expect(stored.engine).toBe("mujoco");expect(stored.licenses.isaac.eulaUrl).toBe("https://example.invalid/test")
    expect(resolveSdkPython(PRODUCT_ROOT,"isaac",env)).toEqual({python,source:"saved-preference"})
    expect(sdkRuntimeFacts(PRODUCT_ROOT,"isaac",env).available).toBe(true)
    expect(probeEngineRuntimes(PRODUCT_ROOT,env).find(row=>row.engine==="isaac")).toMatchObject({python,source:"saved-preference",sdk:true})
    const plugins=runtimePluginInsert({mode:"local",surface:"web",sceneRoot:join(root,"scene"),engine:"isaac",grasp:"none",sdkEnvironment:env})
    expect(plugins.find(row=>row.id==="lyapunov-sim-isaac")!.config!.pythonPath).toBe(python)
    expect(plugins.find(row=>row.id==="lyapunov-scene-kit")!.config!.algorithmPython).toBe(python)
    expect(plugins.find(row=>row.id==="lyapunov-asset-bake")!.config!.python).toBe(python)
    writeEnginePreference("auto",env)
    expect(readSdkPythonPreference("isaac",env)).toBe(python)
    expect((await local.select(null)).nextSource).toBe("package-default")
    expect(readSdkPythonPreference("isaac",env)).toBeUndefined()
    expect(JSON.parse(readFileSync(env.LYAPUNOV_ENGINE_PREFERENCE_FILE!,"utf8")).licenses.isaac).toBeDefined()
  })

  test("环境变量显式覆盖优先，安装器 managed 解析不借环境或保存的外置 SDK",async()=>{
    const root=scratch(),{python}=pipSdk(join(root,"pip")),env=envFor(root)
    await createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env}).select(python)
    const override=join(root,"different/bin/python")
    expect(resolveSdkPython(root,"isaac",{...env,LYAPUNOV_ISAAC_PYTHON:override})).toEqual({python:override,source:"env-override"})
    expect(resolveSdkPython(root,"isaac",{...env,LYAPUNOV_ISAAC_PYTHON:override},{managed:true})).toEqual({python:join(root,".runtime/conda/envs/isaac/bin/python"),source:"package-default"})
    expect(sdkRuntimeFacts(root,"isaac",env,{managed:true}).available).toBe(false)
  })

  test("standalone 需要同根模块、Kit/扩展、版本；裸 VERSION、旧版本、外来模块都拒绝",async()=>{
    const root=scratch()
    for(const [name,options] of [["valid",{}],["no-module",{module:false}],["old-version",{version:"5.1.0"}],["foreign-module",{outside:join(root,"outside")}]] as const){
      const {python}=standaloneSdk(join(root,name),options)
      const candidate=await inspectIsaacPython(python,{productRoot:PRODUCT_ROOT,fresh:true})
      expect(candidate.compatible).toBe(name==="valid")
      if(name!=="valid")await expect(createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env:envFor(root)}).select(python)).rejects.toThrow("ISAAC_LOCAL_SDK_INVALID")
    }
    const {python}=standaloneSdk(join(root,"no-kit"));rmSync(join(root,"no-kit/kit"),{recursive:true})
    expect((await inspectIsaacPython(python,{productRoot:PRODUCT_ROOT,fresh:true})).compatible).toBe(false)
    expect(existsSync(envFor(root).LYAPUNOV_ENGINE_PREFERENCE_FILE!)).toBe(false)
  })

  test("错误路径、空扫描、Python 版本不匹配与超时有明确结果，不执行命令文本",async()=>{
    const root=scratch(),env=envFor(root),local=createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env,scanRoots:[root]})
    expect((await local.discover()).candidates).toEqual([])
    const marker=join(root,"should-not-exist")
    expect((await local.discover(`/bin/sh -c touch ${marker}`)).candidates[0].compatible).toBe(false)
    expect(existsSync(marker)).toBe(false)
    const wrong=join(root,"wrong/bin/python")
    executable(wrong,`#!/bin/sh\nprintf '%s\\n' '{"moduleFound":true,"sdkVersion":"6.0.1.0","sdkRoot":"/fixture","pythonVersion":"3.10.1"}'\n`)
    expect((await inspectIsaacPython(wrong,{fresh:true})).detail).toContain("Python 3.12")
    const slow=join(root,"slow/bin/python")
    executable(slow,"#!/bin/sh\nexec /usr/bin/python3 -c 'import time;time.sleep(10)'\n")
    const started=Date.now(), result=await inspectIsaacPython(slow,{timeoutMs:50,fresh:true})
    expect(result.state).toBe("timeout");expect(Date.now()-started).toBeLessThan(1500)
  })

  test("有限目录扫描不会递归孙目录，超过候选上限会提示手动路径",()=>{
    const root=scratch(),base=join(root,"installations")
    for(let n=0;n<5;n++)pipSdk(join(base,`env-${n}`))
    const nested=pipSdk(join(base,"hidden/deeper"))
    const result=isaacCandidatePaths({productRoot:PRODUCT_ROOT,env:envFor(root),scanRoots:[base],maxCandidates:2})
    expect(result.paths.length).toBe(2);expect(result.limited).toBe(true);expect(result.paths).not.toContain(nested.python)
  })

  test("注册真实发现/选择路由，选择写同一文件且返回下次启动状态",async()=>{
    const root=scratch(),{python}=pipSdk(join(root,"pip")),env=envFor(root)
    const routes=new Map<string,(request:Request)=>Promise<Response>>()
    registerIsaacLocalRoutes((path,_methods,handler)=>{routes.set(path,handler)},{productRoot:PRODUCT_ROOT,env,scanRoots:[join(root,"pip")]})
    const response=await routes.get("isaac-local/select")!(new Request("http://fixture",{method:"POST",body:JSON.stringify({python})}))
    expect((await response.json() as {savedPython:string}).savedPython).toBe(python)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const readback=await routes.get("isaac-local/selection")!(new Request("http://fixture"))
    expect((await readback.json() as {nextSource:string}).nextSource).toBe("saved-preference")
    await expect(routes.get("isaac-local/select")!(new Request("http://fixture",{method:"POST",body:JSON.stringify({python:4})}))).rejects.toThrow("ISAAC_LOCAL_PYTHON_REQUIRED")
  })

  test("已选兼容本地 SDK 的安装请求不会起任务或更改外置环境",async()=>{
    const root=scratch(),{python}=pipSdk(join(root,"pip")),env=envFor(root)
    await createIsaacLocalDiscovery({productRoot:PRODUCT_ROOT,env}).select(python)
    let jobs=0,spawns=0
    const installer=createProviderInstaller({root:join(root,"attempts"),cwd:PRODUCT_ROOT,scriptPath:join(root,"missing-installer"),env,
      jobs:{start:()=>{jobs++;throw new Error("must not start")},kill:()=>{throw new Error("must not kill")}},
      subprocess:{spawn:()=>{spawns++;throw new Error("must not spawn")}},readLicense:()=>undefined,
      readiness:()=>({version:1,rows:[],status:"ready",mode:"advisory",at:0} as never)})
    const result=installer.start("isaac",false)
    expect(result.running).toBe(false);expect(result.result?.code).toBe("LOCAL_SDK_SELECTED")
    expect(jobs).toBe(0);expect(spawns).toBe(0);expect(installer.receipts()).toEqual([])
    expect(installer.dryRun("isaac",false)).toMatchObject({wouldStart:false,code:"LOCAL_SDK_SELECTED"})
    await installer.dispose()
  })

  test("真实 install-provider 收尾 doctor 强制检查包内，不能借外部 SDK 成功回执",()=>{
    const root=scratch(),product=join(root,"product"),env=envFor(root),outside=pipSdk(join(root,"outside"))
    // 本测试的许可标记只位于临时的离线 SDK fixture，不操作任何用户安装。
    writeFileSync(join(outside.site,"isaacsim/kit/EULA_ACCEPTED"),"yes\n")
    writeSdkPythonPreference("isaac",outside.python,env)
    for(const file of ["distribution/linux/install-provider","distribution/linux/doctor.mjs","distribution/linux/sandbox.mjs","packages/lyapunov-product-bundle/src/sdk-python.mjs","packages/sim-isaac/python/check.py"]){mkdirSync(dirname(join(product,file)),{recursive:true});copyFileSync(join(PRODUCT_ROOT,file),join(product,file))}
    mkdirSync(join(product,"script"),{recursive:true});writeFileSync(join(product,"script/package-linux.ts"),"// source fixture\n")
    mkdirSync(join(product,"packages/asset-bake"),{recursive:true});for(const file of ["requirements.txt","requirements-common.txt","requirements-isaac.txt"])copyFileSync(join(PRODUCT_ROOT,"packages/asset-bake",file),join(product,"packages/asset-bake",file))
    const prefix=join(product,".runtime/conda/envs/isaac"),python=join(prefix,"bin/python"),pipArgs=join(root,"pip-install.args")
    executable(python,`#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "pip" ]; then if [ "$3" = "--isolated" ] && [ "$4" = "install" ]; then printf '%s\\n' "$@" > ${shQuote(pipArgs)};fi;printf 'offline pip fixture\\n';exit 0;fi\nif [ "$1" = "-c" ];then case "$2" in *sys.prefix*) printf '%s\\n' ${shQuote(prefix)};exit 0;;*EULA_ACCEPTED*|*coacd*) exit 0;;esac;fi\nexec /usr/bin/python3 "$@"\n`)
    const micromamba=join(root,"micromamba");executable(micromamba,"#!/bin/sh\nexit 0\n")
    const ordinary=spawnSync("/usr/local/bin/node",[join(product,"distribution/linux/doctor.mjs"),"isaac"],{encoding:"utf8",timeout:5000,env:{...env,PYTHONDONTWRITEBYTECODE:"1"}})
    expect(ordinary.status).toBe(0)
    const ordinaryReport=JSON.parse(ordinary.stdout)
    expect(ordinaryReport.providers.isaac).toMatchObject({python:outside.python,pythonSource:"saved-preference",status:"AVAILABLE"})
    const run=spawnSync("/bin/sh",[join(product,"distribution/linux/install-provider"),"isaac","--accept-omniverse-eula"],{encoding:"utf8",timeout:5000,env:{...env,LYAPUNOV_NODE_BIN:"/usr/local/bin/node",LYAPUNOV_MICROMAMBA:micromamba,PYTHONDONTWRITEBYTECODE:"1"}})
    expect(run.error).toBeUndefined();expect(run.status).toBe(2)
    const text=run.stdout.slice(run.stdout.indexOf('{'))
    const report=JSON.parse(text)
    expect(report.providers.isaac.python).toBe(python)
    expect(report.providers.isaac.pythonSource).toBe("package-default")
    expect(report.providers.isaac.status).toBe("BLOCKED")
    expect(report.providers.isaac.code).toBe("PROVIDER_UNAVAILABLE")
    const actualArgs=readFileSync(pipArgs,"utf8").trim().split("\n")
    expect(actualArgs).toContain("isaacsim[extscache]==6.0.1.0")
    for(const component of ["app","core","asset","sensor"])expect(actualArgs).toContain(`isaacsim-${component}==6.0.1.0`)
    expect(actualArgs.some(argument=>argument.includes("[all"))).toBe(false)
    expect(actualArgs).not.toContain("--no-deps")
    expect(actualArgs).not.toContain("mujoco==3.13.0")
    expect(actualArgs).toContain("https://pypi.nvidia.com")
  })
})
