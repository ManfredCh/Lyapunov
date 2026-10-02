import {spawn,type ChildProcess} from "node:child_process"
import {join} from "node:path"
import {backendEnvironment,hostRuntimeRoot,prepareProfile,DSH_BIN,PRODUCT_ROOT} from "./profile.ts"
import {runtimePatch,type RuntimeSimEngine,type IsaacRuntimeOptions} from "./runtime-patch.ts"
import {resolveEngine,pinEnginePreferenceFile,type EngineSelection} from "./engine-preference.ts"
import type {VerifiedAccount} from "../packages/lyapunov-product-bundle/src/account/formal.ts"
import type {VerifiedAdministrator} from "../packages/lyapunov-product-bundle/src/account/administrator.ts"
export interface HostInput {
  mode:"developer"|"formal"|"local"|"guest"
  runtimeRoot?:string
  hostId?:string
  account?:VerifiedAccount
  /** 本地未登录工作台的公开网关地址，不代表已验证账户。 */
  accountApiUrl?:string
  port?:number
  engine?:RuntimeSimEngine
  isaac?:IsaacRuntimeOptions
  grasp?:"none"|"analytic"|"graspgenx"|"anygrasp"
  nodeExecutable?:string
  signal?:AbortSignal
  parentEnvironment?:NodeJS.ProcessEnv
  administrator?:VerifiedAdministrator['admin']
  modelBilling?:'own-key'
}
export interface HostHandle {
  pid:number
  url:string
  origin:string
  dshHome:string
  identity:string
  /** 实际装配进这个 Host 的引擎与选择来源（读回值就是这一份，不是用户偏好）。 */
  engine:EngineSelection
  exited:Promise<number>
  diagnostics():{exitCode:number|null;signal:NodeJS.Signals|null;stderr:string}
  stop():Promise<void>
}

/** 由桌面持有一个真实DSH子进程；返回前等待上游Web就绪消息。 */
export async function startWebHost(input:HostInput):Promise<HostHandle>{
  input.signal?.throwIfAborted()
  if(input.mode==="guest"&&(input.account||input.accountApiUrl||input.administrator||input.modelBilling))throw new Error("GUEST_ACCOUNT_FORBIDDEN")
  if(input.mode==="formal"&&!input.account)throw new Error("AUTH_REQUIRED")
  // 解析与实际装配同源：这一次结果决定组装哪个 Provider、运行根、回写环境与返回值。
  const selection=resolveEngine({explicit:input.engine,env:input.parentEnvironment??process.env,productRoot:PRODUCT_ROOT})
  const engine=selection.engine
  if(selection.source!=="explicit")console.log(`物理引擎：${engine}（${selection.reason}）`)
  const runtimeRoot=hostRuntimeRoot({engine,runtimeRoot:input.runtimeRoot,hostId:input.hostId})
  const runtime=await prepareProfile({mode:input.mode,surface:"web",runtimeRoot,accountId:input.account?.me.user.id})
  const patch=await runtimePatch({dir:runtime.dir,mode:input.mode,surface:"web",sceneRoot:runtime.paths.sceneRoot,domains:runtime.paths,benchmarkOutputRoot:engine==="benchmark"?join(runtime.paths.root,"bench-runs"):undefined,engine,isaac:input.isaac,sdkEnvironment:input.parentEnvironment??process.env,grasp:input.grasp??"analytic",accountApiUrl:input.account?.apiUrl??input.accountApiUrl,accountId:input.account?.me.user.id,administrator:input.administrator,modelBilling:input.modelBilling})
  const env=await backendEnvironment(input.mode,runtime.paths,{account:input.account,parent:input.parentEnvironment,isolated:Boolean(input.administrator)})
  if(engine==="benchmark")env.LYAPUNOV_BENCH_OUTPUT=join(runtime.paths.root,"bench-runs")
  // 回写**实际装配的**引擎：runtime-info／engine-providers 读的就是它；不写就会读到父进程旧值。
  env.LYAPUNOV_SIM_ENGINE=engine
  // 偏好文件同样钉成**本入口刚读过的那个绝对路径**：正式/隔离 Host 的 HOME 会被 backendEnvironment
  // 换成 `<运行根>/private`，不钉的话界面里的引擎切换写进另一个文件，"保存偏好、重启生效"当场失效，
  // 且 runtime-info.enginePreference 会报一个入口没用过的值（DEV-002）。
  pinEnginePreferenceFile(env,input.parentEnvironment??process.env)
  if(input.modelBilling==='own-key'&&!env.DEEPSEEK_API_KEY)throw new Error('DIRECT_MODEL_KEY_REQUIRED: 当前直连模型凭据不可用')
  delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(input.nodeExecutable??"node",[DSH_BIN,"--profile",runtime.profile,"--patch",patch,"--no-open","--port",String(input.port??0)],{cwd:input.mode==="guest"?runtime.paths.workspaceRoot:PRODUCT_ROOT,env,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]})
  let stopped=false,stopTask:Promise<void>|undefined,stderr=""
  const secrets=[env.DEEPSEEK_API_KEY,env.OPENROUTER_API_KEY,env.LYAPUNOV_ACCOUNT_TOKEN].filter(Boolean) as string[]
  const safe=(text:string)=>secrets.reduce((out,key)=>out.replaceAll(key,"[redacted]"),text).replace(/([?&]token=)[^\s&]+/g,"$1[redacted]")
  // 保留额外边界后统一脱敏，避免秘密跨两个 stream chunk 时泄漏；对外仍只返回16k尾部。
  const retained=16000+Math.max(512,...secrets.map(value=>value.length))
  const appendStderr=(value:string)=>{stderr=(stderr+value).slice(-retained)}
  const diagnostics=()=>({exitCode:child.exitCode,signal:child.signalCode,stderr:safe(stderr).slice(-16000)})
  child.stderr!.setEncoding("utf8").on("data",appendStderr)
  const exited=new Promise<number>(resolve=>{
    let settled=false,flushTimer:ReturnType<typeof setTimeout>|undefined
    const finish=(code:number|null)=>{
      if(settled)return
      settled=true;stopped=true;clearTimeout(flushTimer)
      child.stdout?.destroy();child.stderr?.destroy()
      resolve(code??1)
    }
    child.once("exit",code=>{
      stopped=true
      // 正常等close排空末行；孙进程继承stdio时最多等100ms，不拖住stop/logout。
      flushTimer=setTimeout(()=>finish(code),100)
    })
    child.once("close",finish)
    child.once("error",error=>{appendStderr(error.message+"\n");finish(1)})
  })
  const stop=()=>stopTask??=(async()=>{
    if(stopped)return
    signalChild(child,"SIGTERM")
    let timer:ReturnType<typeof setTimeout>|undefined
    const timedOut=await Promise.race([exited.then(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(true),10000)})])
    clearTimeout(timer)
    if(timedOut&&!stopped){
      if(process.platform==="win32")spawn("taskkill",["/pid",String(child.pid),"/t","/f"],{stdio:"ignore"})
      else signalChild(child,"SIGKILL")
      await exited
    }
  })()
  const abort=()=>{void stop()}
  input.signal?.addEventListener("abort",abort,{once:true})
  void exited.then(()=>input.signal?.removeEventListener("abort",abort))
  if(input.signal?.aborted)abort()
  try{
    const url=await new Promise<string>((resolve,reject)=>{
      let pending=""
      const timer=setTimeout(()=>reject(new Error("DSH启动超时："+diagnostics().stderr)),45000)
      const fail=(error:Error)=>{clearTimeout(timer);reject(error)}
      child.once("error",fail)
      child.once("close",code=>fail(new Error(`DSH启动退出${code}：${diagnostics().stderr}`)))
      child.stdout!.on("data",value=>{
        pending+=value.toString()
        const lines=pending.split("\n");pending=lines.pop()??""
        for(const line of lines){
          const match=line.match(/^dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)\s*$/)
          if(match){clearTimeout(timer);resolve(match[1]!)}
        }
      })
    })
    return {pid:child.pid!,url,origin:new URL(url).origin,dshHome:runtime.paths.dshHome,identity:runtime.paths.identity,engine:selection,exited,diagnostics,stop}
  }catch(error){await stop();throw error}
}
function signalChild(child:ChildProcess,signal:NodeJS.Signals){
  if(child.exitCode!==null||child.signalCode!==null||!child.pid)return
  try{if(process.platform==="win32")child.kill(signal);else process.kill(-child.pid,signal)}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error}
}
