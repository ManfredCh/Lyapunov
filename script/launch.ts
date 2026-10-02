import { spawn } from "node:child_process"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { backendEnvironment, hostRuntimeRoot, prepareProfile, DSH_BIN, PRODUCT_ROOT } from "./profile.ts"
import { resolveEngine, pinEnginePreferenceFile } from "./engine-preference.ts"
import { runtimePatch, isaacRuntimeOptions } from "./runtime-patch.ts"
import {verifyFormalAccount} from "../packages/lyapunov-product-bundle/src/account/formal.ts"
import {resolveAccountApiUrl} from '../packages/lyapunov-product-bundle/src/account/url.ts'
import {readRuntimeEnv} from '../packages/lyapunov-product-bundle/src/runtime-paths.ts'

const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{mode:{type:"string",default:"formal"},surface:{type:"string",default:"web"},port:{type:"string",default:"4180"},engine:{type:"string"},grasp:{type:"string",default:"analytic"},"runtime-root":{type:"string"},"host-id":{type:"string"},"isaac-device":{type:"string"},"isaac-rendering":{type:"string"},"isaac-startup-budget":{type:"string"}}})
if(values.mode!=="developer"&&values.mode!=="formal"&&values.mode!=="guest")throw new Error("模式必须是 formal、developer 或 guest")
if(values.mode==="guest"&&values.surface!=="web")throw new Error("游客入口只用于本地手动 Web 工作台")
if(!["web","sdk","headless","acp"].includes(values.surface!))throw new Error("未知运行入口")
// 引擎选择只有一份规则：`resolveEngine`（`script/engine-preference.ts`）。
// 非显式来源打印一行原因（含 Isaac 未就绪的回退理由），不静默换引擎。
const selection=resolveEngine({explicit:values.engine,productRoot:PRODUCT_ROOT})
const engine=selection.engine
if(selection.source!=="explicit")console.log(`物理引擎：${engine}（${selection.reason}）`)
if(engine!=='isaac'&&(values['isaac-device']!==undefined||values['isaac-rendering']!==undefined||values['isaac-startup-budget']!==undefined))throw new Error('Isaac选项需要--engine isaac')
// 启动预算只在**显式给 flag** 时带出：入口只把字符串转成数字，不设默认值、不重复校验
// （合法性由 ProcessSimProvider 构造函数唯一一处 RangeError 判定）。
const isaacBudget=values['isaac-startup-budget']
const isaac=engine==='isaac'?isaacRuntimeOptions({physicsDevice:values['isaac-device'],rendering:values['isaac-rendering'],...(isaacBudget===undefined?{}:{startupBudgetMs:Number(isaacBudget)})}):undefined
const account=values.mode==="formal"?await verifyFormalAccount({apiUrl:resolveAccountApiUrl({configured:readRuntimeEnv(process.env,"apiUrl"),dev:false}),token:readRuntimeEnv(process.env,"accountToken")??""}):undefined
const runtimeRoot=hostRuntimeRoot({engine,runtimeRoot:values["runtime-root"],hostId:values["host-id"]})
const runtime=await prepareProfile({mode:values.mode,surface:values.surface as "web"|"sdk"|"headless"|"acp",runtimeRoot,accountId:account?.me.user.id})
if(!["none","analytic","graspgenx","anygrasp"].includes(values.grasp!))throw new Error("未知 Provider")
const patch=await runtimePatch({dir:runtime.dir,mode:values.mode,surface:values.surface!,sceneRoot:runtime.paths.sceneRoot,domains:runtime.paths,benchmarkOutputRoot:engine==="benchmark"?join(runtime.paths.root,"bench-runs"):undefined,engine:engine as "none"|"mujoco"|"isaac"|"newton"|"benchmark",isaac,grasp:values.grasp as "none"|"analytic"|"graspgenx"|"anygrasp",accountApiUrl:account?.apiUrl,accountId:account?.me.user.id})
const args=[DSH_BIN,"--profile",runtime.profile,"--patch",patch,...(values.surface==="web"?["--no-open","--port",values.port!]:positionals)]
const env=await backendEnvironment(values.mode,runtime.paths,{account})
// 能力包端点：正式模式由**既有账号会话**派生（policy-registry 的 packBearer 读 LYAPUNOV_ACCOUNT_TOKEN，
// backendEnvironment 已按账户验证结果注入），不需要新白名单键；开发/隔离启动按插件声明过的两个键逐个搬运
// （与 IMAGE/TRIPO/… 供应商键同纪律：只搬明确列出的键，不透传父进程环境）。
for(const key of ["PACK_ENDPOINT","PACK_TOKEN"] as const)if(values.mode!=="guest"&&process.env[key]!==undefined)env[key]=process.env[key]
if(engine==="benchmark")env.LYAPUNOV_BENCH_OUTPUT=join(runtime.paths.root,"bench-runs")
// 把**解析后的**引擎回写给 Host：界面要显示"当前跑的是哪个引擎"，而它只能从运行环境读回。
// 不回写的话 UI 只能猜（或显示偏好值），就会出现"界面写 Isaac、实际跑 MuJoCo"的谎报。
env.LYAPUNOV_SIM_ENGINE=engine
// 偏好文件也要钉成**本入口刚读过的那个绝对路径**：正式/隔离 Host 的 HOME 会被换成
// `<运行根>/private`，不钉就会读写另一个文件——界面里存的偏好下次启动不生效（真机复现见回执）。
pinEnginePreferenceFile(env)
const child=spawn("node",args,{cwd:values.mode==="guest"?runtime.paths.workspaceRoot:PRODUCT_ROOT,env,stdio:"inherit"})
process.once("SIGINT",()=>child.kill("SIGINT"));process.once("SIGTERM",()=>child.kill("SIGTERM"))
const exitCode=await new Promise<number>(resolveExit=>{
  child.once("error",error=>{
    console.error("DSH 启动失败：",error.message)
    resolveExit(1)
  })
  child.once("exit",code=>resolveExit(code??1))
})
process.exitCode=exitCode
