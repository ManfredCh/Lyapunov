import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,copyFileSync,chmodSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'
import {assessSandbox,assessSandboxRunner,parseNoNewPrivileges,setupSandbox} from './sandbox.mjs'
const facts={helper:{path:'/app/chrome-sandbox',exists:true,uid:1000,mode:0o755},nosuid:false,userNamespaceAvailable:false,restrictUnprivilegedUserns:1,apparmorProfile:'unconfined'}
test('用户普通终端的0755 helper不能被ldd通过误报为可用',()=>{const r=assessSandbox(facts);assert.equal(r.status,'BLOCKED');assert.equal(r.canLaunch,false)})
test('root4755 helper提供可用路径，nosuid或挂载未知不能冒充成功',()=>{const good={...facts,helper:{...facts.helper,uid:0,mode:0o4755},nosuid:false};assert.equal(assessSandbox(good).status,'AVAILABLE');assert.equal(assessSandbox({...good,nosuid:true}).canLaunch,false);assert.equal(assessSandbox({...good,nosuid:null}).configuredHelper,false);assert.equal(assessSandbox({...good,nosuid:null}).canLaunch,false)})
test('受限系统下，特殊AppArmor进程中的userns成功只证明当前上下文',()=>{const r=assessSandbox({...facts,userNamespaceAvailable:true,apparmorProfile:'chatgpt-codex (unconfined)'});assert.equal(r.canLaunch,true);assert.equal(r.status,'CONTEXT_ONLY')})
test('NoNewPrivs严格解析且未知不冒充false',()=>{assert.deepEqual(parseNoNewPrivileges(`Name: x
NoNewPrivs: 0
`),{value:false,diagnostic:null});assert.deepEqual(parseNoNewPrivileges(`NoNewPrivs: 1
`),{value:true,diagnostic:null});assert.equal(parseNoNewPrivileges(`NoNewPrivs: 2
`).value,null);assert.equal(parseNoNewPrivileges(`Name: x
`).value,null);assert.equal(parseNoNewPrivileges(null).value,null)})
test('no_new_privs只补充setup阻断原因，不改变CONTEXT_ONLY判定',()=>{const r=assessSandbox({...facts,userNamespaceAvailable:true,noNewPrivileges:true,restrictUnprivilegedUserns:1});assert.equal(r.canLaunch,true);assert.equal(r.status,'CONTEXT_ONLY');assert.equal(r.setupBlockedByNoNewPrivileges,true);assert.match(r.message,/no_new_privs/);assert.equal(r.code,'SANDBOX_CONTEXT_ONLY')})
test('未知no_new_privs不改变可启动判定且保留unknown',()=>{const r=assessSandbox({...facts,userNamespaceAvailable:true,noNewPrivileges:null,restrictUnprivilegedUserns:1});assert.equal(r.canLaunch,true);assert.equal(r.status,'CONTEXT_ONLY');assert.equal(r.setupBlockedByNoNewPrivileges,null)})
test('mountOptions保留nosuid证据且不让setuid helper冒充可用',()=>{const good={...facts,helper:{...facts.helper,uid:0,mode:0o4755},mountOptions:'rw,nosuid,nodev'};const r=assessSandbox({...good,nosuid:true});assert.equal(r.mountOptions,'rw,nosuid,nodev');assert.equal(r.canLaunch,false);assert.equal(r.status,'BLOCKED')})
test('不限制userns的系统无需setuid helper也能启动',()=>{assert.equal(assessSandbox({...facts,restrictUnprivilegedUserns:0,userNamespaceAvailable:true}).status,'AVAILABLE')})
test('普通用户setup明确要求sudo，不修改文件后谎报成功',(t)=>{if(process.getuid?.()===0){t.skip('该用例验证普通用户权限');return}const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov-sandbox-')));try{mkdirSync(join(root,'runtime/electron'),{recursive:true});writeFileSync(join(root,'runtime/electron/chrome-sandbox'),'fixture');assert.throws(()=>setupSandbox(root),/sudo/)}finally{rmSync(root,{recursive:true,force:true})}})
test('通过固定目录软链调用沙箱入口仍执行校验，不静默返回成功',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov-sandbox-link-')))
  try{
    const alias=join(root,'current-client')
    symlinkSync(dirname(fileURLToPath(import.meta.url)),alias,'dir')
    const result=spawnSync(process.execPath,[join(alias,'sandbox.mjs'),'invalid-action-probe'],{encoding:'utf8'})
    assert.equal(result.status,2)
    assert.match(result.stderr,/sandbox\.mjs check\|setup/)
  }finally{rmSync(root,{recursive:true,force:true})}
})
test('字体配置仅对desktop进程生效，搬移布局和用户显式配置均保留',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov font-launch ')))
 try{
  const put=(file,text,executable=false)=>{const path=join(root,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);if(executable)chmodSync(path,0o755)}
  // 便携入口现在经 desktop-launcher.mjs 启动 Electron，夹具的 node 必须真跑脚本（不能是空 stub）。
  put('package.json','{}');put('runtime/node/bin/node',`#!/bin/sh\nexec ${process.execPath} "$@"\n`,true)
  // 本用例验证 Linux fontconfig 分支，平台读数显式隔离，不能借运行测试的宿主平台。
  put('runtime/node/bin/uname',"#!/bin/sh\nprintf 'Linux\\n'\n",true)
  put('runtime/electron/lyapunov-desktop','#!/bin/sh\nprintf \'%s\\n\' "file=${FONTCONFIG_FILE-}" "path=${FONTCONFIG_PATH-}" "cache=${XDG_CACHE_HOME-}" "args=$*"\n',true)
  put('distribution/linux/sandbox.mjs','// fixture only\n')
  put('distribution/linux/desktop-launcher.mjs',"import {execFileSync} from 'node:child_process'\nexecFileSync(process.argv[2],process.argv.slice(3),{stdio:'inherit'})\n")
  put('packages/desktop/renderer/fonts/fonts.conf','fixture config');put('packages/desktop/renderer/fonts/NotoSansSC-Regular.otf','fixture font')
  for(const entry of ['lyapunov','distribution/linux/lyapunov']){
   const launcher=join(root,entry);mkdirSync(dirname(launcher),{recursive:true});copyFileSync(new URL('./lyapunov',import.meta.url),launcher);chmodSync(launcher,0o755)
   const env={...process.env,FONTCONFIG_FILE:'',FONTCONFIG_PATH:'',XDG_CACHE_HOME:join(root,'private cache')}
   const run=(extra={})=>spawnSync(launcher,['desktop','--guest'],{encoding:'utf8',env:{...env,...extra}})
   const own=run();assert.equal(own.status,0);assert.match(own.stdout,/args=--guest/);assert.ok(own.stdout.includes(`file=${join(root,'packages/desktop/renderer/fonts/fonts.conf')}`));assert.ok(own.stdout.includes(`cache=${env.XDG_CACHE_HOME}`))
   const explicit=run({FONTCONFIG_FILE:'/custom/user fonts.conf'});assert.equal(explicit.status,0);assert.match(explicit.stdout,/file=\/custom\/user fonts.conf/)
   const searchRoot=run({FONTCONFIG_PATH:'/custom/user fonts'});assert.equal(searchRoot.status,0);assert.match(searchRoot.stdout,/file=\npath=\/custom\/user fonts/)
  }
  rmSync(join(root,'packages/desktop/renderer/fonts/fonts.conf'))
  const missing=spawnSync(join(root,'lyapunov'),['desktop'],{encoding:'utf8',env:{...process.env,FONTCONFIG_FILE:'',FONTCONFIG_PATH:''}})
  assert.equal(missing.status,2);assert.match(missing.stderr,/RELEASE_PAYLOAD_MISSING.*fonts.conf/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('macOS便携入口复用同一launcher，启动app且不调用Linux沙箱或字体配置',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov mac-launch ')))
 try{
  const put=(file,text)=>{const path=join(root,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);chmodSync(path,0o755)}
  put('package.json','{}')
  put('runtime/node/bin/node',`#!/bin/sh\nexec ${process.execPath} "$@"\n`)
  put('runtime/node/bin/uname',"#!/bin/sh\nprintf 'Darwin\\n'\n")
  put('distribution/linux/desktop-launcher.mjs',readFileSync(new URL('./desktop-launcher.mjs',import.meta.url)))
  put('runtime/electron/Lyapunov.app/Contents/MacOS/Electron','#!/bin/sh\nprintf \'%s\\n\' "args=$*" "node_env=$NODE_ENV" "file=${FONTCONFIG_FILE-}"\n')
  copyFileSync(new URL('./lyapunov',import.meta.url),join(root,'lyapunov'));chmodSync(join(root,'lyapunov'),0o755)
  const run=spawnSync(join(root,'lyapunov'),['desktop','--guest'],{encoding:'utf8',env:{...process.env,FONTCONFIG_FILE:''}})
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/args=--guest/);assert.match(run.stdout,/node_env=production/);assert.match(run.stdout,/file=\n/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('Linux便携入口同样经desktop-launcher启动，沙箱检查在前且不直接exec lyapunov-desktop',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov linux-launch ')))
 try{
  const put=(file,text)=>{const path=join(root,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);chmodSync(path,0o755)}
  put('package.json','{}')
  put('runtime/node/bin/node',`#!/bin/sh\nexec ${process.execPath} "$@"\n`)
  put('runtime/node/bin/uname',"#!/bin/sh\nprintf 'Linux\\n'\n")
  put('distribution/linux/sandbox.mjs',"console.log('sandbox-check')\n")
  put('distribution/linux/desktop-launcher.mjs',"console.log('launcher-args='+process.argv.slice(2).join(' '))\n")
  put('runtime/electron/lyapunov-desktop',"#!/bin/sh\nprintf 'DIRECT-ELECTRON-EXEC\\n'\n")
  put('packages/desktop/renderer/fonts/fonts.conf','fixture config');put('packages/desktop/renderer/fonts/NotoSansSC-Regular.otf','fixture font')
  copyFileSync(new URL('./lyapunov',import.meta.url),join(root,'lyapunov'));chmodSync(join(root,'lyapunov'),0o755)
  const run=spawnSync(join(root,'lyapunov'),['desktop','--guest'],{encoding:'utf8',env:{...process.env,FONTCONFIG_FILE:''}})
  assert.equal(run.status,0,run.stderr)
  const checkAt=run.stdout.indexOf('sandbox-check'),launchAt=run.stdout.indexOf('launcher-args=')
  assert.ok(checkAt>=0&&launchAt>checkAt,'沙箱检查必须在 launcher 之前')
  assert.match(run.stdout,/launcher-args=.*runtime\/electron\/lyapunov-desktop --guest/)
  assert.doesNotMatch(run.stdout,/DIRECT-ELECTRON-EXEC/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('desktop-launcher把SIGTERM转成IPC终止并以子进程退出码结束',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov-launcher-')))
 try{
  const launcher=join(root,'desktop-launcher.mjs')
  copyFileSync(new URL('./desktop-launcher.mjs',import.meta.url),launcher)
  const electron=join(root,'fake-electron.mjs')
  writeFileSync(electron,`process.on('message',m=>{if(m&&m.type==='lyapunov:terminate'&&m.signal==='SIGTERM'){console.log('ipc-terminate',m.signal);process.exit(0)}})\nconsole.log('ready')\nsetInterval(()=>{},1000)\n`)
  const child=spawn(process.execPath,[launcher,process.execPath,electron,'--guest'],{stdio:['ignore','pipe','pipe']})
  let out='';child.stdout.on('data',d=>out+=d)
  await new Promise(r=>child.stdout.on('data',()=>{if(out.includes('ready'))r()}))
  child.kill('SIGTERM')
  const code=await new Promise(r=>child.once('exit',r))
  assert.equal(code,0);assert.match(out,/ipc-terminate SIGTERM/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('desktop-launcher原样传出子进程非0退出码',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'lyapunov-launcher-')))
 try{
  const launcher=join(root,'desktop-launcher.mjs')
  copyFileSync(new URL('./desktop-launcher.mjs',import.meta.url),launcher)
  const electron=join(root,'fake-electron.mjs')
  writeFileSync(electron,'process.exit(7)\n')
  const child=spawn(process.execPath,[launcher,process.execPath,electron],{stdio:['ignore','pipe','pipe']})
  const code=await new Promise(r=>child.once('exit',r))
  assert.equal(code,7)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('bwrap可用路径：执行器判为AVAILABLE',()=>{const r=assessSandboxRunner({bwrapOnPath:true,bwrapAvailable:true,landlockRunExecutable:false});assert.equal(r.status,'AVAILABLE');assert.equal(r.runner,'bwrap')})
test('bwrap存在但userns探测失败，且无landlock回退：判BLOCKED',()=>{const r=assessSandboxRunner({bwrapOnPath:true,bwrapAvailable:false,landlockRunExecutable:false});assert.equal(r.status,'BLOCKED');assert.equal(r.code,'SANDBOX_RUNNER_UNAVAILABLE')})
test('bwrap缺席但landlock-run可执行：仍可用并标明landlock',()=>{const r=assessSandboxRunner({bwrapOnPath:false,bwrapAvailable:false,landlockRunExecutable:true});assert.equal(r.status,'AVAILABLE');assert.equal(r.runner,'landlock')})
test('两执行器皆缺：BLOCKED带安装提示',()=>{const r=assessSandboxRunner({bwrapOnPath:false,bwrapAvailable:false,landlockRunExecutable:false});assert.equal(r.status,'BLOCKED');assert.equal(r.code,'SANDBOX_RUNNER_UNAVAILABLE');assert.match(r.install,/bubblewrap/);assert.match(r.message,/P422/)})
