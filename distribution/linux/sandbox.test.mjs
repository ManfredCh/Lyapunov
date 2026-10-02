import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {assessSandbox,parseNoNewPrivileges,setupSandbox} from './sandbox.mjs'
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
test('普通用户setup明确要求sudo，不修改文件后谎报成功',(t)=>{if(process.getuid?.()===0){t.skip('该用例验证普通用户权限');return}const root=mkdtempSync(join(tmpdir(),'lyapunov-sandbox-'));try{mkdirSync(join(root,'runtime/electron'),{recursive:true});writeFileSync(join(root,'runtime/electron/chrome-sandbox'),'fixture');assert.throws(()=>setupSandbox(root),/sudo/)}finally{rmSync(root,{recursive:true,force:true})}})
test('通过固定目录软链调用沙箱入口仍执行校验，不静默返回成功',()=>{
  const root=mkdtempSync(join(tmpdir(),'lyapunov-sandbox-link-'))
  try{
    const alias=join(root,'current-client')
    symlinkSync(dirname(fileURLToPath(import.meta.url)),alias,'dir')
    const result=spawnSync(process.execPath,[join(alias,'sandbox.mjs'),'invalid-action-probe'],{encoding:'utf8'})
    assert.equal(result.status,2)
    assert.match(result.stderr,/sandbox\.mjs check\|setup/)
  }finally{rmSync(root,{recursive:true,force:true})}
})
