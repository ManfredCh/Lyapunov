import {readFileSync,lstatSync,chownSync,chmodSync,realpathSync,accessSync,readdirSync,constants} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const read=(path)=>{try{return readFileSync(path,'utf8').trim()}catch{return null}}
const quote=(value)=>"'"+String(value).replaceAll("'","'\\''")+"'"

/** Parse the kernel's exact NoNewPrivs field without treating unknown as false. */
export function parseNoNewPrivileges(status){
  if(typeof status!=="string")return {value:null,diagnostic:"status-unreadable"}
  const line=status.split(/\r?\n/).find(row=>row.startsWith("NoNewPrivs:"))
  if(!line)return {value:null,diagnostic:"field-missing"}
  const value=line.slice("NoNewPrivs:".length).trim()
  if(value==="0")return {value:false,diagnostic:null}
  if(value==="1")return {value:true,diagnostic:null}
  return {value:null,diagnostic:"field-malformed"}
}

function readNoNewPrivileges(){
  const attempts=[]
  for(const path of ["/proc/thread-self/status","/proc/self/status"]){
    const result=parseNoNewPrivileges(read(path))
    if(result.value!==null)return {value:result.value,source:path,diagnostic:null}
    attempts.push(`${path}:${result.diagnostic}`)
  }
  return {value:null,source:null,diagnostic:attempts.join(";")}
}

/** 同时供启动前检查和 doctor 使用；不会关闭 sandbox 或修改系统策略。 */
export function assessSandbox(facts){
  const configured=facts.helper.exists&&facts.helper.uid===0&&(facts.helper.mode&0o7777)===0o4755&&facts.nosuid===false
  const canLaunch=configured||facts.userNamespaceAvailable
  const contextOnly=!configured&&facts.userNamespaceAvailable&&facts.restrictUnprivilegedUserns===1
  const setupBlockedByNoNewPrivileges=facts.noNewPrivileges===true?true:facts.noNewPrivileges===false?false:null
  const message=!canLaunch?'当前终端无法建立 Chromium sandbox，请完成本安装的沙箱设置。':contextOnly
    ? setupBlockedByNoNewPrivileges
      ? '当前进程的 AppArmor 权限允许启动，但进程受 no_new_privs 限制，不能在此处通过 sudo 配置 setuid helper；这不证明普通终端也能启动。请从普通授权终端完成本安装的沙箱设置后再验收。'
      : '当前进程的 AppArmor 权限允许启动；这不证明普通终端也能启动。为普通终端完成本安装的沙箱设置后再验收。'
    : 'Chromium sandbox 已具备启动条件。'
  return {...facts,configuredHelper:configured,canLaunch,setupBlockedByNoNewPrivileges,status:!canLaunch?'BLOCKED':contextOnly?'CONTEXT_ONLY':'AVAILABLE',method:configured?'setuid-helper':facts.userNamespaceAvailable?'user-namespace':null,
    ...(canLaunch&&!contextOnly?{}:{code:contextOnly?'SANDBOX_CONTEXT_ONLY':'SANDBOX_SETUP_REQUIRED'}),message}
}
export function inspectSandbox(root){
  const path=join(root,'runtime/electron/chrome-sandbox')
  let helper={path,exists:false,uid:null,mode:0}
  try{const st=lstatSync(path);helper={path,exists:st.isFile(),uid:st.uid,mode:st.mode&0o7777}}catch{}
  const mount=spawnSync('findmnt',['-n','-o','OPTIONS','--target',path],{encoding:'utf8',timeout:2000})
  const mountOptions=mount.status===0?mount.stdout.trim():null
  const nosuid=mountOptions===null?null:mountOptions.split(',').includes('nosuid')
  const probe=spawnSync('unshare',['--user','--map-root-user','true'],{encoding:'utf8',timeout:2000})
  const restricted=read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
  const noNewPrivileges=readNoNewPrivileges()
  return assessSandbox({helper,mountOptions,nosuid,noNewPrivileges:noNewPrivileges.value,noNewPrivilegesSource:noNewPrivileges.source,noNewPrivilegesDiagnostic:noNewPrivileges.diagnostic,userNamespaceAvailable:probe.status===0,restrictUnprivilegedUserns:restricted===null?null:Number(restricted),apparmorProfile:read('/proc/self/attr/current'),setupCommand:`sudo ${quote(join(root,'lyapunov'))} setup-sandbox`})
}
/** 会话沙箱执行器（bwrap→landlock 链）探测：只读检查，不安装、不改策略。
 * bwrap 可用 = PATH 可解析且一次真实 `bwrap --unshare-all --ro-bind / / true` 通过；
 * landlock-run 可用 = 固定路径存在且可执行。两者皆缺 → 受限执行必然 fail-closed（P422）。 */
export function assessSandboxRunner(facts){
  const bwrapReady=facts.bwrapAvailable===true
  const landlockReady=facts.landlockRunExecutable===true
  const status=bwrapReady||landlockReady?'AVAILABLE':'BLOCKED'
  return {...facts,status,canLaunch:status==='AVAILABLE',runner:bwrapReady?'bwrap':landlockReady?'landlock':null,
    ...(status==='AVAILABLE'?{}:{code:'SANDBOX_RUNNER_UNAVAILABLE',message:'会话沙箱执行器不可用：bwrap 未安装或探测失败，且 landlock-run 二进制缺失；仿真 worker 将按 fail-closed 拒绝启动（公开错误 P422）。 / Session confinement runner unavailable: install bubblewrap (e.g. `sudo apt install bubblewrap`) or restore the landlock-run binary.',install:'sudo apt install bubblewrap'})}
}
export function inspectSandboxRunner(root){
  const which=spawnSync('which',['bwrap'],{encoding:'utf8',timeout:5000})
  const bwrapOnPath=!which.error&&which.status===0&&(which.stdout??'').trim().length>0
  let bwrapAvailable=false,bwrapProbe=null
  if(bwrapOnPath){
    const probe=spawnSync('bwrap',['--unshare-all','--ro-bind','/','/','true'],{encoding:'utf8',timeout:5000})
    bwrapAvailable=!probe.error&&probe.status===0
    bwrapProbe={status:probe.status,error:probe.error?String(probe.error.message):null}
  }
  // 随包 SDK 目录名随版本变化（发行包与开发树不同），不写死版本号。
  let upstream=[];try{upstream=readdirSync(join(root,'.upstream'))}catch{}
  const landlockPath=upstream.map(name=>join(root,'.upstream',name,'native/system/packages/linux-x64/bin/landlock-run')).find(path=>{try{return lstatSync(path).isFile()&&accessSyncOk(path)}catch{return false}})??join(root,'.upstream/<sdk>/native/system/packages/linux-x64/bin/landlock-run')
  const landlockRunExecutable=upstream.length>0&&accessSyncOk(landlockPath)
  return assessSandboxRunner({bwrapOnPath,bwrapAvailable,bwrapProbe,landlockRunPath:landlockPath,landlockRunExecutable})
}
function accessSyncOk(path){try{accessSync(path,constants.X_OK);return true}catch{return false}}
export function setupSandbox(root){
  const path=join(root,'runtime/electron/chrome-sandbox')
  let st
  try{st=lstatSync(path)}catch{throw Error(`沙箱 helper 缺失或不可读：${path}；请重新完整解包。`)}
  if(!st.isFile()||st.isSymbolicLink())throw Error(`沙箱 helper 不是普通文件：${path}；请重新完整解包。`)
  if(process.getuid?.()!==0)throw Error(`需要管理员权限，请运行：sudo ${quote(join(root,'lyapunov'))} setup-sandbox`)
  chownSync(path,0,0);chmodSync(path,0o4755)
  const result=inspectSandbox(root)
  if(!result.configuredHelper)throw Error(result.nosuid===true?'安装目录位于 nosuid 文件系统，请安装到允许 sandbox helper 的本地目录。':result.nosuid===null?'无法确认安装目录的挂载安全选项，请在可读取 mount 信息的普通终端重试。':'沙箱权限设置未生效。')
  return result
}
const own=fileURLToPath(import.meta.url)
let invokedAsMain=false
if(process.argv[1]){try{invokedAsMain=realpathSync(process.argv[1])===own}catch{}}
if(invokedAsMain){
  const root=resolve(dirname(own),'../..'),action=process.argv[2]??'check'
  try{
    if(process.argv.length>3)throw Error('用法：sandbox.mjs check|setup')
    if(action==='setup'){console.log(JSON.stringify(setupSandbox(root),null,2))}
    else if(action==='check'){
      const result=inspectSandbox(root)
      if(result.status!=='AVAILABLE')console.error(result.message+'\n'+result.setupCommand)
      if(!result.canLaunch)process.exitCode=2
    }else{console.error('用法：sandbox.mjs check|setup');process.exitCode=2}
  }catch(error){console.error(error.message);process.exitCode=2}
}
