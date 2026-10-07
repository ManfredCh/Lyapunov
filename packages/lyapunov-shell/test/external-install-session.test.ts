import {describe,expect,test,afterEach} from 'bun:test'
import type {Context} from '@deepseek-ai/cordis'
import {startExternalInstallSession,startExternalMcpRegistrationSession} from '../src/external-install-session.ts'
import {externalMcpConfig,externalMcpRevision,saveExternalMcp,requireExternalWrite,startExternalAcquisition,externalToolsState} from '../src/external-tools-host.ts'
import {runBlenderMcpSupplyCommand,ensureBlenderMcp} from '../../../script/blender-mcp.ts'

function fixture(ok=true,wait?:Promise<void>){
 const calls:Array<{kind:string;value:unknown}>=[]
 const sessions={
  list:{getSnapshot:()=>({byId:{existing:{id:'existing',cwd:'/task',retainedBy:{mainView:1}}}})},
  create:async(opts:unknown)=>{calls.push({kind:'create',value:opts});return 'fresh-install'},
  // RC2 生命周期：binding 只在 retain 且 ready 之后存在。夹具按同一契约提供 using()，
  // 这样测试能证明产品确实等到了 ready，而不是在 retain 之前同步读 binding。
  using:async(id:string,options:{source:string},operation:(reference:unknown)=>Promise<string>|string)=>{
   calls.push({kind:'retain',value:{id,source:options.source}})
   const binding={session:{prompt:async(content:unknown,mode:unknown)=>{
    calls.push({kind:'prompt',value:{id,content,mode}})
    return ok?{ok:true}:{ok:false,error:{message:'模型未连接'}}
   }}}
   const reference={sessionId:id,binding,ready:(wait??Promise.resolve()).then(()=>binding),release:()=>calls.push({kind:'release',value:id})}
   try{return await operation(reference)}finally{reference.release()}
  },
 }

 const workspaces={list:{getSnapshot:()=>({items:[{workspaceId:'workspace',sessionIds:['existing']}]})}}
 const ctx={get:(name:string)=>name==='sessions'?sessions:name==='workspaces'?workspaces:undefined,uiWorkspace:{openSession:(id:string)=>{calls.push({kind:'open',value:id});calls.push({kind:'panel',value:null})}}} as unknown as Context
 return {ctx,calls,close:()=>calls.push({kind:'close',value:true})}
}
describe('外部工具从设置进入新会话',()=>{
 test('创建新会话、等到原生retain/ready后只向新绑定发送一次Blender英文请求，不复用已有任务',async()=>{
  const f=fixture();expect(await startExternalInstallSession(f.ctx,'blender',f.close)).toBe('fresh-install')
  expect(f.calls.map(row=>row.kind)).toEqual(['create','retain','open','panel','prompt','close','release'])
  expect(f.calls[0]!.value).toEqual({workspaceId:'workspace'})
  expect(f.calls[1]!.value).toEqual({id:'fresh-install',source:'controllerOperation'})
  expect(f.calls[4]!.value).toMatchObject({id:'fresh-install',mode:'queue',content:[{type:'text',text:expect.stringContaining('Please download and install Blender')}]})
 })
 test('Unity MCP使用配置与连接检查请求，明确第三方桥接且不把已配置当作已安装',async()=>{
  const f=fixture();await startExternalInstallSession(f.ctx,'unity-mcp',f.close)
  const prompt=JSON.stringify(f.calls.find(row=>row.kind==='prompt')!.value)
  expect(prompt).toContain('cannot by itself claim that the editor is installed or running')
  expect(prompt).toContain('third-party integration')
 })
 test('显式登记MCP把用户值带进英文请求，不硬编码服务名',async()=>{
  const f=fixture();await startExternalMcpRegistrationSession(f.ctx,'  my-server --stdio  ',f.close)
  const prompt=JSON.stringify(f.calls.find(row=>row.kind==='prompt')!.value)
  expect(prompt).toContain('my-server --stdio')
  expect(prompt).toContain('Do not invent server or tool names')
 })
 test('空MCP登记值在创建会话前拒绝',async()=>{
  const f=fixture();await expect(startExternalMcpRegistrationSession(f.ctx,'   ',f.close)).rejects.toThrow('MCP 服务名称')
  expect(f.calls).toEqual([])
 })
 test('提交失败保留设置错误处理机会，不报告完成',async()=>{
  const f=fixture(false);await expect(startExternalInstallSession(f.ctx,'blender',f.close)).rejects.toThrow('模型未连接')
  expect(f.calls.some(row=>row.kind==='close')).toBe(false)
 })
 test('未知工具不会创建会话或提交任何请求',async()=>{
  const f=fixture();await expect(startExternalInstallSession(f.ctx,'unknown-tool',f.close)).rejects.toThrow('未找到')
  expect(f.calls).toEqual([])
 })
 test('原生ready未落定前不打开或提交，落定后仅提交一次并释放临时引用',async()=>{
  let ready!:()=>void;const gate=new Promise<void>(r=>ready=r),f=fixture(true,gate)
  const operation=startExternalInstallSession(f.ctx,'blender',f.close)
  await Promise.resolve();await Promise.resolve()
  expect(f.calls.map(v=>v.kind)).toEqual(['create','retain'])
  ready();await operation
  expect(f.calls.filter(v=>v.kind==='prompt')).toHaveLength(1)
  expect(f.calls.at(-1)?.kind).toBe('release')
 })
})

describe('游客可直接配置MCP与取得权重，不依赖模型安装会话',()=>{
 test('stdio按argv配置而不拼shell，Blender端口进入原生env',()=>{
  expect(externalMcpConfig({serverName:'blender',transport:'stdio',command:'/tools/mcp-for-blender',args:['--literal','$(touch nope)'],blenderPort:9881},'/workspace')).toMatchObject({command:'/tools/mcp-for-blender',args:['--literal','$(touch nope)'],env:{BLENDER_HOST:'127.0.0.1',BLENDER_PORT:'9881'},failOnStartupError:false})
  expect(()=>externalMcpConfig({serverName:'bad.name',transport:'stdio',command:'mcp'},'/workspace')).toThrow('MCP_NAME_INVALID')
  expect(()=>externalMcpConfig({serverName:'blender',transport:'stdio',command:'mcp',blenderPort:0},'/workspace')).toThrow('BLENDER_PORT_INVALID')
 })
 test('HTTP端点秘密不进入设置表单，非法URL/transport失败关闭',()=>{
  expect(externalMcpConfig({serverName:'unity',transport:'streamable-http',url:'http://localhost:8080/mcp'},'/workspace')).toMatchObject({url:'http://localhost:8080/mcp'})
  for(const url of ['file:///tmp/mcp','https://user:secret@example.org/mcp','https://example.org/mcp?token=private'])expect(()=>externalMcpConfig({serverName:'other',transport:'sse',url},'/workspace')).toThrow('MCP_URL_INVALID')
 })
 test('静态配置事务保留参数凭据超时，语义旧revision拒绝',async()=>{
  const profile={cwd:'/workspace',patchPath:'/owned-profile/cordis.patch.yml'}
  const entry={options:{id:'native-existing',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'unity',transport:'streamable-http',url:'https://example.org/mcp?token=hidden',headers:{Authorization:'preserve-me'},toolCallTimeoutMs:999}}}
  let next:any
  const editor={entries:()=>[entry],edit:async(_entry:unknown,change:(raw:any)=>any)=>{next=change(entry.options.config)}}
  const ctx={get:(name:string)=>name==='profileContext'?profile:name==='configEditor'?editor:name==='settings'?{writable:true}:undefined} as unknown as Context
  const revision=externalMcpRevision(profile.patchPath,entry.options.id,entry.options.config)
  await saveExternalMcp(ctx,{serverName:'unity',transport:'streamable-http',expectedRevision:revision})
  expect(next).toEqual(entry.options.config)
  entry.options.config.toolCallTimeoutMs=1000
  await expect(saveExternalMcp(ctx,{serverName:'unity',transport:'streamable-http',expectedRevision:revision})).rejects.toThrow('MCP_CONFIG_CONFLICT')
  const foreign=externalMcpRevision('/other-profile/cordis.patch.yml',entry.options.id,entry.options.config)
  await expect(saveExternalMcp(ctx,{serverName:'unity',transport:'streamable-http',expectedRevision:foreign})).rejects.toThrow('MCP_CONFIG_CONFLICT')
 })
 test('静态MCP含原生jsTag或继承表达式时保守拒绝且不落盘',async()=>{
  const profile={cwd:'/workspace',patchPath:'/owned-profile/cordis.patch.yml'}
  const config:any={serverName:'blender',transport:'stdio',command:'/tools/mcp-for-blender',env:{PRIVATE:{__jsExpr:'env.FIXTURE_VALUE'}}}
  const entry={options:{id:'existing-blender',name:'@deepseek-ai/dsh-mcp-client',config}}
  let writes=0
  const editor={entries:()=>[entry],edit:async(_entry:unknown,change:(raw:any,inherited:any)=>any)=>{change(entry.options.config,{env:{BASE:{__jsExpr:'env.FIXTURE_BASE'}}});writes++}}
  const ctx={get:(name:string)=>name==='profileContext'?profile:name==='configEditor'?editor:name==='settings'?{writable:true}:undefined} as unknown as Context
  await expect(saveExternalMcp(ctx,{serverName:'blender',transport:'stdio',expectedRevision:externalMcpRevision(profile.patchPath,entry.options.id,config)})).rejects.toThrow('MCP_COMPLEX_CONFIG_EDIT_NATIVE')
  config.env={PRIVATE:'keep-literal'}
  await expect(saveExternalMcp(ctx,{serverName:'blender',transport:'stdio',expectedRevision:externalMcpRevision(profile.patchPath,entry.options.id,config)})).rejects.toThrow('MCP_COMPLEX_CONFIG_EDIT_NATIVE')
  expect(writes).toBe(0);expect(config.env.PRIVATE).toBe('keep-literal')
 })
 test('已有Blender端口空保存保留，静态编辑只改显式端口并保留私人env',async()=>{
  const profile={cwd:'/workspace',patchPath:'/owned-profile/cordis.patch.yml'}
  const entry={options:{id:'existing-blender',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'blender',transport:'stdio',command:'/tools/mcp-for-blender',env:{BLENDER_PORT:'9988',PRIVATE_TOKEN:'keep'}}}}
  let next:any
  const editor={entries:()=>[entry],edit:async(_entry:unknown,change:(raw:any)=>any)=>{next=change(entry.options.config)}}
  const ctx={get:(name:string)=>name==='profileContext'?profile:name==='configEditor'?editor:name==='settings'?{writable:true}:undefined} as unknown as Context
  const revision=externalMcpRevision(profile.patchPath,entry.options.id,entry.options.config)
  await saveExternalMcp(ctx,{serverName:'blender',transport:'stdio',expectedRevision:revision})
  expect(next.env).toEqual({BLENDER_PORT:'9988',PRIVATE_TOKEN:'keep'})
  await saveExternalMcp(ctx,{serverName:'blender',transport:'stdio',blenderPort:9989,expectedRevision:revision})
  expect(next.env).toMatchObject({BLENDER_PORT:'9989',PRIVATE_TOKEN:'keep'})
  expect(entry.options.config.env.BLENDER_PORT).toBe('9988')
 })
 test('锁定桥接供给预取消不写入；实际供给子进程组取消后真实退出，不碰既有编辑器',async()=>{
  const before=new AbortController();before.abort()
  await expect(ensureBlenderMcp({signal:before.signal})).rejects.toThrow()
  const controller=new AbortController()
  const started=Date.now(),run=runBlenderMcpSupplyCommand(process.execPath,['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('owned-child='+c.pid);setInterval(()=>{},1000)"],{signal:controller.signal})
  setTimeout(()=>controller.abort(),250)
  const outcome=await run
  expect(outcome.code).toBe(130);expect(outcome.stderr).toContain('BLENDER_MCP_CANCELLED')
  expect(Date.now()-started).toBeLessThan(5000)
  const childPid=Number(/owned-child=(\d+)/.exec(outcome.stdout)?.[1]);expect(childPid).toBeGreaterThan(0)
  if(process.platform==='linux'){
   let childState:string|undefined;try{childState=await readFile(`/proc/${childPid}/status`,'utf8')}catch{}
   expect(childState===undefined||/State:\s+Z\b/.test(childState)).toBe(true)
  }
 })
 test('写入前按原生文件策略拒绝read-only、未知策略与工作区外目录',()=>{
  const ctx=(mode:string)=>({get:(name:string)=>name==='sandboxPolicy'?{resolve:()=>({mode,workspaceRoot:'/task',networkAccess:false})}:undefined}) as unknown as Context
  expect(()=>requireExternalWrite(ctx('read-only'),undefined,'/task/model')).toThrow('EXTERNAL_POLICY_READ_ONLY')
  expect(()=>requireExternalWrite(ctx('unknown'),undefined,'/task/model')).toThrow('EXTERNAL_POLICY_READ_ONLY')
  expect(()=>requireExternalWrite(ctx('workspace-write'),undefined,'/outside/model')).toThrow('EXTERNAL_POLICY_OUTSIDE_WRITABLE')
  expect(()=>requireExternalWrite(ctx('workspace-write'),undefined,'/task/model')).not.toThrow()
  expect(()=>requireExternalWrite({get:()=>undefined} as unknown as Context,undefined,'/task/model')).toThrow('EXTERNAL_POLICY_UNAVAILABLE')
 })
 test('镜像计划锁定revision/files/argv；即使父环境HF_ENDPOINT指官方，也不会回退',async()=>{
  const calls:Record<string,unknown>[]=[],old=process.env.HF_ENDPOINT
  let done!:Promise<unknown>
  const ctx={get:(name:string)=>name==='sandboxPolicy'?{resolve:()=>({mode:'danger-full-access',workspaceRoot:'/task'})}:name==='jobs'?{start:(spec:any)=>{const hooks=spec.run({append:()=>undefined,updateProgress:()=>undefined});done=hooks.done;return 'external-install-1'}}:name==='subprocess'?{resolveExecutable:async()=>'/tools/hf',spawn:(spec:unknown)=>{calls.push(spec as Record<string,unknown>);return {done:Promise.resolve({exitCode:17,signal:null}),collected:{}}}}:undefined,profileContext:{cwd:'/task'}} as unknown as Context
  try{
   process.env.HF_ENDPOINT='https://huggingface.co'
   expect(await startExternalAcquisition(ctx,{id:'da3',localDir:'/task/models/da3'})).toBe('external-install-1')
   expect(calls[0]).toMatchObject({argv:['/tools/hf','download','depth-anything/DA3-BASE','--revision','f4a6c9b3c95e41c82048423d3493a81ec3fa810e','config.json','model.safetensors','--local-dir','/task/models/da3'],env:{HF_ENDPOINT:'https://hf-mirror.com'}})
   expect(await done).toMatchObject({status:'failed',detail:expect.stringContaining('No official-endpoint fallback')})
   expect(calls).toHaveLength(1)
  }finally{if(old===undefined)delete process.env.HF_ENDPOINT;else process.env.HF_ENDPOINT=old}
 })
})


// 本轮配置迁移走实际 RC2 built Cordis/Loader/Profile/ConfigEditor，不注册 Settings 替身。
import { Context as NativeContext } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeMcp from '@deepseek-ai/dsh-mcp-client'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ShellPreferences from '../src/preferences-host.ts'
import * as WorkspacePreferences from '../../lyapunov-workspace/src/preferences-host.ts'
import { defaultPreferences, PREFERENCES_NAMESPACE } from '../src/preferences.ts'
import { workspaceDefaults, WORKSPACE_PREFERENCES } from '../../lyapunov-workspace/src/preferences.ts'

const ownedContexts: NativeContext[] = [], ownedHomes: string[] = []
afterEach(async () => {
 for (const ctx of ownedContexts.splice(0)) await ctx.fiber.dispose()
 for (const home of ownedHomes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function preferencesFixture(input: { legacy?: string; overrides?: object[]; built?: boolean } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'lyapunov-rc2-config-'))
 ownedHomes.push(home)
 const dir = join(home, 'profile'), bundle = join(dir, 'node_modules', 'test-preferences-bundle')
 initProfile(dir, ['test-preferences-bundle'])
 await mkdir(bundle, { recursive: true })
 await writeFile(join(home, 'package.json'), '{"name":"test-preferences-installation"}\n')
 await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-preferences-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
 await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  { id: 'config-editor', name: 'cordis:test-editor' },
  { id: 'settings', name: 'cordis:test-settings' },
  { id: PREFERENCES_NAMESPACE, name: input.built ? pathToFileURL(Bun.resolveSync('@lyapunov/shell/preferences', resolve(import.meta.dirname, '../../..'))).href : 'cordis:test-shell-preferences' },
  { id: WORKSPACE_PREFERENCES, name: input.built ? pathToFileURL(Bun.resolveSync('@lyapunov/workspace/preferences', resolve(import.meta.dirname, '../../..'))).href : 'cordis:test-workspace-preferences' },
 ] }]))
 await writeFile(join(dir, 'cordis.yml'), '[]\n')
 await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(input.overrides ?? []))
 if (input.legacy !== undefined) await writeFile(join(home, 'settings.yaml'), input.legacy)
 const profile: ProfileContext = { name: 'test-preferences', startedBundles: ['test-preferences-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
 const start = async () => {
  const ctx = new NativeContext()
  ownedContexts.push(ctx)
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  const errors: string[] = []
  ctx.logger.exporter({ export: message => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) } })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'test-editor': ConfigEditor, 'test-settings': Settings, 'test-shell-preferences': ShellPreferences, 'test-workspace-preferences': WorkspacePreferences })
  ctx.provide('profileContext', profile)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('dsh', profile))
  await ctx.loader.await()
  if (input.built && errors.length) throw new Error(errors.join('\n'))
  for (const entry of ctx.configEditor.entries()) await entry.fiber?.await()
  return ctx
 }
 const view = (ctx: NativeContext, namespace: string) => {
  const row = ctx.settings.describe().find(row => row.ns === namespace)
  if (!row) throw Error(`原生 Config 表单不存在：${namespace}`)
  return row
 }
 return { ctx: await start(), start, home, profile, view }
}

test('原生静态MCP新增与已有更新真实事务，旧revision与跨profile拒绝',async()=>{
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405);response.end();return}
  let body='';for await(const chunk of request)body+=String(chunk)
  const rpc=JSON.parse(body)
  if(rpc.id===undefined){response.writeHead(202);response.end();return}
  const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-fixture',version:'1.0'}}:rpc.method==='tools/list'?{tools:[{name:'read_fixture',description:'Read the local MCP fixture, not a real editor.',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'fixture'}]}
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}))
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,h=await preferencesFixture()
 h.ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0} as never)
 await h.ctx.plugin(ToolRuntime)
 try{
  await saveExternalMcp(h.ctx,{serverName:'fixture',transport:'streamable-http',url,expectedRevision:null})
  expect(h.ctx.tools.schemas().map(v=>v.name)).toContain('mcp__fixture__read_fixture')
  const actual=await externalToolsState(h.ctx)
  expect(actual.mcp.find(v=>v.serverName==='fixture')).toMatchObject({status:'connected',tools:['mcp__fixture__read_fixture'],detail:null})
  const row=actual.mcp.find(v=>v.serverName==='fixture')!
  expect(h.ctx.settings.describe().some(v=>v.ns===row.id)).toBe(false)
  await saveExternalMcp(h.ctx,{serverName:'fixture',transport:'streamable-http',expectedRevision:row.revision??undefined})
  const stale=row.revision!
  await saveExternalMcp(h.ctx,{serverName:'fixture',transport:'streamable-http',url:url+'/changed',expectedRevision:stale})
  const changed=(await externalToolsState(h.ctx)).mcp.find(v=>v.serverName==='fixture')!
  expect(changed.url).toBe(url+'/changed')
  expect(changed.revision).not.toBe(stale)
  const saved=await readFile(h.profile.patchPath,'utf8')
  await expect(saveExternalMcp(h.ctx,{serverName:'fixture',transport:'streamable-http',url,expectedRevision:stale})).rejects.toThrow('MCP_CONFIG_CONFLICT')
  expect(await readFile(h.profile.patchPath,'utf8')).toBe(saved)
  const foreign=externalMcpRevision('/other-profile/cordis.patch.yml',changed.id,h.ctx.configEditor.entries().find(e=>e.options.id===changed.id)!.options.config)
  await expect(saveExternalMcp(h.ctx,{serverName:'fixture',transport:'streamable-http',expectedRevision:foreign})).rejects.toThrow('MCP_CONFIG_CONFLICT')
  expect(await readFile(h.profile.patchPath,'utf8')).toBe(saved)
  const persisted=await readFile(h.profile.patchPath,'utf8')
  expect(persisted).toContain('@deepseek-ai/dsh-mcp-client')
  expect(persisted).toContain('lyapunov-external-mcp-fixture')
  await h.ctx.plugin(NativeMcp,{transport:'streamable-http',serverName:'duplicate',url,toolCallTimeoutMs:1000,headers:{},failOnStartupError:false})
  await expect(saveExternalMcp(h.ctx,{serverName:'duplicate',transport:'streamable-http',url,expectedRevision:null})).rejects.toThrow()
  expect(await readFile(h.profile.patchPath,'utf8')).toBe(persisted)
  expect(h.ctx.tools.schemas().map(v=>v.name)).toContain('mcp__fixture__read_fixture')
 }finally{await h.ctx.fiber.dispose();await new Promise<void>(r=>server.close(()=>r()))}
},20000)

describe('RC2 原生偏好 Config/profile 事务', () => {
 test('产品两个真实built exports通过Loader生成可写原生表单并重开', async () => {
  const h = await preferencesFixture({ built: true })
  const shell = h.view(h.ctx, PREFERENCES_NAMESPACE)
  await h.ctx.settings.update(PREFERENCES_NAMESPACE, { backgroundOnly: false }, shell.revision)
  const workspace = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { terminalFontFamily: 'built font', terminalFontSize: 18 }, workspace.revision)
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, PREFERENCES_NAMESPACE).value).toMatchObject({ backgroundOnly: false })
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ terminalFontFamily: 'built font', terminalFontSize: 18 })
  expect(h.view(reopened, PREFERENCES_NAMESPACE).autoGenerate).toBe(false)
  expect(h.view(reopened, WORKSPACE_PREFERENCES).autoGenerate).toBe(false)
 })
 test('投影原字段与默认值，热写入保留 fibre，重开读回字体/声音/主题/快捷键', async () => {
  const h = await preferencesFixture()
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toEqual(defaultPreferences)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toEqual(workspaceDefaults)
  const shellEntry = h.ctx.configEditor.entries().find(row => row.options.id === PREFERENCES_NAMESPACE)!
  const before = shellEntry.fiber
  const shell = h.view(h.ctx, PREFERENCES_NAMESPACE)
  await h.ctx.settings.update(PREFERENCES_NAMESPACE, { agentSound: false, agentSoundId: 'nope-03', themePalette: 'native', shortcuts: { newSession: 'ctrl+alt+n' } }, shell.revision)
  const workspace = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, terminalFontFamily: 'DejaVu Sans Mono', autoSaveDelayMs: 920 }, workspace.revision)
  expect(shellEntry.fiber).toBe(before)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, autoSaveDelayMs: 920 })
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, agentSoundId: 'nope-03', shortcuts: { newSession: 'ctrl+alt+n' } })
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: 'Noto Sans Mono CJK SC', editorFontSize: 19, terminalFontFamily: 'DejaVu Sans Mono', autoSaveDelayMs: 920 })
 })
 test('旧 lyaup 值按官方 import/rename迁移；canonical与显式profile字段优先', async () => {
  const h = await preferencesFixture({ legacy: 'lyaup-preferences:\n  agentSound: false\n  agentSoundId: nope-03\n  backgroundOnly: false\nlyapunov-preferences:\n  agentSound: true\nlyaup-workspace:\n  autoSave: false\n  editorFontFamily: 旧中文字体\n  editorFontSize: 21\nlyapunov-workspace:\n  editorFontSize: 17\n', overrides: [
   { id: PREFERENCES_NAMESPACE, name: 'cordis:test-shell-preferences', config: { agentSound: false } },
   { id: WORKSPACE_PREFERENCES, name: 'cordis:test-workspace-preferences', config: { editorFontSize: 23, terminalFontFamily: '新终端字体' } },
  ] })
  for (let attempt = 0; attempt < 200 && ((h.view(h.ctx, PREFERENCES_NAMESPACE).value as typeof defaultPreferences).agentSoundId !== 'nope-03' || (h.view(h.ctx, WORKSPACE_PREFERENCES).value as typeof workspaceDefaults).editorFontFamily !== '旧中文字体'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, agentSoundId: 'nope-03', backgroundOnly: false })
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ autoSave: false, editorFontFamily: '旧中文字体', editorFontSize: 23, terminalFontFamily: '新终端字体' })
  const archived = await readFile(join(h.home, 'settings.yaml.imported'), 'utf8')
  expect(archived).toContain('lyaup-preferences:')
  expect(archived).toContain('lyaup-workspace:')
  await expect(readFile(join(h.home, 'settings.yaml'), 'utf8')).rejects.toThrow()
  await h.ctx.fiber.dispose()
  const reopened = await h.start()
  expect(h.view(reopened, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontFamily: '旧中文字体', editorFontSize: 23 })
 })
 test('仅canonical旧文档也不覆盖较新的显式profile用户字段', async () => {
  const h = await preferencesFixture({ legacy: 'lyapunov-preferences:\n  agentSound: true\n  errors: true\nlyapunov-workspace:\n  autoSave: false\n  editorFontSize: 17\n', overrides: [
   { id: PREFERENCES_NAMESPACE, name: 'cordis:test-shell-preferences', config: { agentSound: false } },
   { id: WORKSPACE_PREFERENCES, name: 'cordis:test-workspace-preferences', config: { editorFontSize: 24 } },
  ] })
  for (let attempt = 0; attempt < 200 && (!(h.view(h.ctx, PREFERENCES_NAMESPACE).value as typeof defaultPreferences).errors || (h.view(h.ctx, WORKSPACE_PREFERENCES).value as typeof workspaceDefaults).autoSave); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.view(h.ctx, PREFERENCES_NAMESPACE).value).toMatchObject({ agentSound: false, errors: true })
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontSize: 24, autoSave: false })
  expect(await readFile(join(h.home, 'settings.yaml.imported'), 'utf8')).toContain('lyapunov-preferences:')
 })
 test('拒绝旧revision和非法组合后patch与权威值不变，unset回原生默认', async () => {
  const h = await preferencesFixture()
  const original = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontSize: 20 }, original.revision)
  const before = await readFile(h.profile.patchPath, 'utf8')
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontSize: 22 }, original.revision)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  expect(await readFile(h.profile.patchPath, 'utf8')).toBe(before)
  const fresh = h.view(h.ctx, WORKSPACE_PREFERENCES)
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { editorFontFamily: 'bad\nfont' }, fresh.revision)).rejects.toThrow('字体名称')
  await expect(h.ctx.settings.update(WORKSPACE_PREFERENCES, { shortcuts: { fileOpen: 'mod+k', panelClose: 'mod+k' } }, fresh.revision)).rejects.toThrow('同一快捷键')
  expect(await readFile(h.profile.patchPath, 'utf8')).toBe(before)
  await h.ctx.settings.mutate(WORKSPACE_PREFERENCES, [{ op: 'unset', path: ['editorFontSize'] }], fresh.revision)
  expect(h.view(h.ctx, WORKSPACE_PREFERENCES).value).toMatchObject({ editorFontSize: workspaceDefaults.editorFontSize })
 })
})
