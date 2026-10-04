import {expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {watchWorkspaceBoot,mountWorkspaceBootFailure,safeWorkspaceBootDetail} from '../src/workspace-boot-recovery.ts'

const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
const {JSDOM}=sdkRequire('jsdom')
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))

async function inDocument(run:(document:Document,window:any)=>Promise<void>){
 const dom=new JSDOM('<body><div data-dsh-boot><span data-dsh-boot-spinner></span></div></body>',{url:'http://127.0.0.1:12345'})
 const previous=Object.getOwnPropertyDescriptor(globalThis,'MutationObserver')
 Object.defineProperty(globalThis,'MutationObserver',{value:dom.window.MutationObserver,configurable:true})
 try{await run(dom.window.document,dom.window)}finally{dom.window.close();if(previous)Object.defineProperty(globalThis,'MutationObserver',previous);else Reflect.deleteProperty(globalThis,'MutationObserver')}
}

test('shell失败时独立于shell呈现返回登录；详情折叠，原生按钮调用有效',()=>inDocument(async document=>{
 let failed=0,returned=0,retried=0,ready=0
 const stop=watchWorkspaceBoot(document,{locale:async()=>'en',failed:()=>{failed++},ready:()=>{ready++},retry:async()=>{retried++},returnToLogin:async()=>{returned++}})
 expect(document.querySelector('[data-lyapunov-workspace-failure]')).toBeNull()
 document.querySelector('[data-dsh-boot]')!.textContent='HARNESS Failed to load plugins @lyapunov/shell web boot: 1 entry did not activate'
 await tick()
 expect(failed).toBe(1);expect(ready).toBe(0)
 expect(document.querySelector('[data-lyapunov-workspace-failure]')).not.toBeNull()
 expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(false)
 ;(document.querySelector('[data-lyapunov-return-to-login]') as HTMLButtonElement).click();await tick()
 expect(returned).toBe(1);expect(retried).toBe(0)
 document.body.append(document.createElement('span'));await tick();expect(failed).toBe(1)
 stop()
}))

test('只有见过boot正常dispose才回报ready；pagehide清理且后续DOM不再观察',()=>inDocument(async(document,window)=>{
 let ready=0,failed=0
 const stop=watchWorkspaceBoot(document,{locale:async()=>'zh',failed:()=>{failed++},ready:()=>{ready++},retry:async()=>{},returnToLogin:async()=>{}})
 document.querySelector('[data-dsh-boot]')!.remove();await tick();expect(ready).toBe(1);expect(failed).toBe(0)
 const other=document.createElement('div');other.dataset.dshBoot='';other.textContent='web boot: failure';document.body.append(other);await tick();expect(ready).toBe(1);expect(failed).toBe(0)
 window.dispatchEvent(new window.Event('pagehide'));stop()
}))

test('失败重试走原生入口；拒绝后保可操作返回，诊断令牌脱敏',()=>inDocument(async document=>{
 let retries=0
 const remove=mountWorkspaceBootFailure(document,'web boot: failed https://fixture.invalid/?token=private-fixture',{locale:async()=>'zh',failed:()=>{},retry:async()=>{retries++;throw Error('重试未完成')},returnToLogin:async()=>{}})
 await tick();expect(document.body.textContent).toContain('返回登录');expect(document.body.textContent).not.toContain('private-fixture')
 ;(document.querySelector('[data-lyapunov-workspace-retry]') as HTMLButtonElement).click();await tick()
 expect(retries).toBe(1);expect((document.querySelector('[data-lyapunov-return-to-login]') as HTMLButtonElement).disabled).toBe(false)
 expect(safeWorkspaceBootDetail('Bearer test-credential')).toBe('Bearer [redacted]');remove()
}))
