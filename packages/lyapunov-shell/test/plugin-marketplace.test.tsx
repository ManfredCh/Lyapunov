import {describe,expect,test} from 'bun:test'
import React from 'react'
import {createRequire} from 'node:module'
import {spawnSync,spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {integrationAssociations,classifyMcpIntegration,marketplaceEntries,filterMarketplace} from '../src/plugin-marketplace.ts'
import {validExistingExecutable} from '../src/integration-discovery.ts'
import {ExternalToolsSettings,applyExternalToolsSettings} from '../src/external-tools-settings.tsx'
import type {ExternalToolsState,ExternalMcpRow} from '../src/external-tools-state.ts'
import {Context} from '@deepseek-ai/cordis'

const mcp=(name:string,over:Partial<ExternalMcpRow>={}):ExternalMcpRow=>({id:'native-'+name,serverName:name,transport:'stdio',command:'mcp-for-blender',url:null,argsCount:0,envNames:['PRIVATE_TOKEN'],headerNames:[],status:'configured',tools:[],revision:123,detail:'Await native connection',enabled:true,currentScope:false,owner:'Native profile',configLocation:'/owned/profile/cordis.patch.yml',commandLocation:'/tools/mcp-for-blender',integration:'blender',...over})
const state=():ExternalToolsState=>({capturedAt:1791430000000,writable:true,scopeSessionId:'current',software:[{id:'blender',installed:true,detail:'Installed software only',location:'/tools/blender',adapter:'blender_run'},{id:'unity',installed:null,detail:'Editor not selected; Hub discovered',location:'/tools/unityhub',adapter:'MCP'}],mcp:[mcp('customBlender',{status:'connected',currentScope:true,tools:['mcp__customBlender__get_scene_info']})],skills:[{name:'robot-provisioning',description:'Acquire a robot',provider:'filesystem',source:'bundled',path:'/product/skills/robot-provisioning/SKILL.md',modelInvocable:true,userInvocable:true,toolVisible:true,currentScope:true}],skillsComplete:true,candidates:[{id:'blender:/tools/mcp-for-blender',kind:'blender',path:'/tools/mcp-for-blender',source:'PATH',modifiedAt:0,executable:true,addonPath:'/product/addon.py',addonExists:false}],associations:integrationAssociations([mcp('customBlender')]),blenderSupply:{ready:false,command:'/product/bin/mcp-for-blender',existingCommand:'/tools/mcp-for-blender',addon:'/product/addon.py',detail:'Addon not installed'},installJobs:[]})

describe('插件市场原生读数的薄投影',()=>{
 test('已有软件不能变成MCP连接；config没有scope tools不表示可用',()=>{
  const s=state();s.mcp=[mcp('blender')]
  const rows=marketplaceEntries(s)
  expect(rows.find(v=>v.id==='software:blender')).toMatchObject({installed:true,connected:null,available:null})
  expect(rows.find(v=>v.kind==='mcp')).toMatchObject({connected:false,available:false,enabled:true})
  s.mcp=[mcp('blender',{status:'connected',currentScope:false,tools:['mcp__blender__read']})]
  expect(marketplaceEntries(s).find(v=>v.kind==='mcp')?.available).toBe(false)
  for(const over of [{status:'unavailable' as const,currentScope:true,enabled:true},{status:'connected' as const,currentScope:true,enabled:false},{status:'connected' as const,currentScope:undefined,enabled:true}]){
   s.mcp=[mcp('blender',{tools:['mcp__blender__old_cached_tool'],...over})]
   expect(marketplaceEntries(s).find(v=>v.kind==='mcp')).toMatchObject({installed:null,available:false})
  }
  s.mcp=[mcp('blender',{status:'connected',currentScope:true,enabled:true,tools:['mcp__blender__read']})]
  expect(marketplaceEntries(s).find(v=>v.kind==='mcp')?.available).toBe(true)
 })
 test('唯一已有server自动关联保持原namespace，重复读取幂等，两候选不猜',()=>{
  const a=mcp('my-existing-blender'),one=integrationAssociations([a])
  expect(one[0]).toMatchObject({status:'associated',serverName:'my-existing-blender',serverIds:[a.id]})
  expect(integrationAssociations([a])).toEqual(one)
  expect(integrationAssociations([a,mcp('second')])[0]).toMatchObject({status:'ambiguous',serverName:null,serverIds:[a.id,'native-second']})
  expect(classifyMcpIntegration({serverName:'arbitrary',command:'python'})).toBeUndefined()
  expect(classifyMcpIntegration({serverName:'named-custom',command:'/tools/mcp-for-blender'})).toBe('blender')
 })
 test('搜索源/位置/名称，MCP和Skills过滤使用同只读列表',()=>{
  const rows=marketplaceEntries(state())
  expect(filterMarketplace(rows,'customblend','mcp')).toHaveLength(1)
  expect(filterMarketplace(rows,'filesystem bundled','skill')[0]?.name).toBe('robot-provisioning')
  expect(filterMarketplace(rows,'/tools/unityhub','all')[0]?.id).toBe('software:unity')
  expect(filterMarketplace(rows,'','all','available').map(v=>v.kind)).toEqual(['mcp','skill'])
  expect(filterMarketplace(rows,'','software','available')).toEqual([])
 })
 test('技能策略与原skill工具各自约束可用性，加载正文不当安装',()=>{
  const s=state();s.skills![0]!.userInvocable=false;s.skills![0]!.toolVisible=false
  expect(marketplaceEntries(s).find(v=>v.kind==='skill')).toMatchObject({installed:true,enabled:true,available:false})
  s.skills![0]!.modelInvocable=false;s.skills![0]!.userInvocable=false
  expect(marketplaceEntries(s).find(v=>v.kind==='skill')).toMatchObject({installed:true,enabled:false,available:false})
 })
 test('合法程序路径只读canonical与可执行检查，不执行脚本；空路径/目录/不可执行拒绝',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lyapunov-plugin-discovery-'));try{
   const file=join(dir,'existing-tool');await writeFile(file,'this is not executed');await chmod(file,0o600)
   expect(await validExistingExecutable(file)).toBeNull();await chmod(file,0o700)
   expect(await validExistingExecutable(file)).toMatchObject({path:file})
   expect(await validExistingExecutable(dir)).toBeNull();expect(await validExistingExecutable('mcp-for-blender')).toBeNull();expect(await validExistingExecutable(file+'\n--execute')).toBeNull()
  }finally{await rm(dir,{recursive:true,force:true})}
 })
 test('隔离HOME共用原picker公共目录：已有产品供给优先，缺失时回用户Addon，Unity仍发现公共安装根',async()=>{
  const box=await mkdtemp(join(tmpdir(),'lyapunov-installed-public-home-')),before=process.env.HOME
  const publicHome=join(box,'user-home'),privateHome=join(box,'account-private'),bridge=join(box,'bridge','mcp-for-blender'),productRoot=join(box,'product')
  const suppliedAddon=join(productRoot,'.runtime','blender-mcp','addon.py'),userAddon=join(publicHome,'.config','blender','5.2','scripts','addons','blender_mcp.py')
  try{
   await mkdir(dirname(bridge),{recursive:true});await writeFile(bridge,'fixture must not execute');await chmod(bridge,0o700)
   await mkdir(productRoot);await writeFile(join(productRoot,'UPSTREAM_LOCK.json'),await readFile(new URL('../../../UPSTREAM_LOCK.json',import.meta.url)))
   for(const home of [publicHome,privateHome]){
    const addon=join(home,'.config','blender','5.2','scripts','addons','blender_mcp.py'),editor=join(home,'Unity','Hub','Editor','6000.0.1f1','Editor','Unity')
    await mkdir(dirname(addon),{recursive:true});await writeFile(addon,'fixture must not execute')
    await mkdir(dirname(editor),{recursive:true});await writeFile(editor,'fixture must not execute');await chmod(editor,0o700)
   }
   // PRODUCT_ROOT is sampled when its module loads; each real child binds the public root before importing it.
   const program=`
    const {Context}=await import(${JSON.stringify(import.meta.resolve('@deepseek-ai/cordis'))});
    const {default:BrowseDirectoryPicker}=await import(${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-host-directory-picker-browse'))});
    const {discoverIntegrations}=await import(${JSON.stringify(new URL('../src/integration-discovery.ts',import.meta.url).href)});
    const {blenderMcpPaths,blenderMcpStatus}=await import(${JSON.stringify(new URL('../../../script/blender-mcp.ts',import.meta.url).href)});
    const {publicHome,bridge}=JSON.parse(process.env.LYAPUNOV_DISCOVERY_FIXTURE);
    const ctx=new Context();
    try{
     await ctx.plugin(BrowseDirectoryPicker,{maxEntries:1000,homeDirectory:publicHome});
     const rows=await discoverIntegrations(ctx,{BLENDER_EXECUTABLE:bridge});
     console.log(JSON.stringify({rows,home:ctx.directoryPicker.capability().homeDirectory,supply:blenderMcpStatus(),supplyRoot:blenderMcpPaths().root}));
    }finally{await ctx.fiber.dispose()}
   `
   const inspect=()=>{
    const result=spawnSync(process.execPath,['--no-env-file','--no-install','-e',program],{
     cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',timeout:10000,maxBuffer:256*1024,
     env:{PATH:process.env.PATH,HOME:privateHome,LYAPUNOV_PRODUCT_ROOT:productRoot,LYAPUNOV_DISCOVERY_FIXTURE:JSON.stringify({publicHome,bridge})},
    })
    expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(result.stderr).toBe('')
    const value=JSON.parse(result.stdout) as {rows:Array<{path:string;addonPath?:string;addonExists?:boolean;source:string}>;home:string;supply:{ready:boolean;readings:{addonExists:boolean}};supplyRoot:string}
    expect(value.home).toBe(publicHome);expect(value.supplyRoot).toBe(join(productRoot,'.runtime','blender-mcp'));expect(value.supply.ready).toBe(false)
    expect(value.rows.some(row=>row.path===join(publicHome,'Unity','Hub','Editor','6000.0.1f1','Editor','Unity')&&row.source==='unity-hub')).toBe(true)
    expect(value.rows.some(row=>row.path.startsWith(privateHome)||row.addonPath?.startsWith(privateHome))).toBe(false)
    return value
   }
   await mkdir(dirname(suppliedAddon),{recursive:true});await writeFile(suppliedAddon,'isolated supplied addon; never execute')
   const supplied=inspect();expect(supplied.supply.readings.addonExists).toBe(true)
   expect(supplied.rows.find(row=>row.path===bridge)).toMatchObject({addonPath:suppliedAddon,addonExists:true})
   await rm(suppliedAddon)
   const fallback=inspect();expect(fallback.supply.readings.addonExists).toBe(false)
   expect(fallback.rows.find(row=>row.path===bridge)).toMatchObject({addonPath:userAddon,addonExists:true})
   expect(process.env.HOME).toBe(before)
  }finally{await rm(box,{recursive:true,force:true})}
 })
 test('软件集成复用原生Settings根入口，不替换SDK插件列表或建立registry',()=>{
  const rows:any[]=[];const ctx={locale:{bind:()=>()=> 'Scene workbench'},slots:{inject:(name:string,cb:()=>unknown)=>{rows.push({inject:name});return cb()},register:(spec:unknown)=>{rows.push(spec);return ()=>{}}}} as unknown as Context
  applyExternalToolsSettings(ctx)
  expect(rows[0]).toEqual({inject:'settings.section'})
  expect(rows[1]).toMatchObject({name:'settings.section',id:'lyapunov-integrations',order:19})
 })
})

test('真实React DOM搜索／筛选／详情／唯一关联与歧义选择；不显示secret值、不调用模型',async()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=req('jsdom')
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'}),saved=new Map<string,PropertyDescriptor|undefined>()
 const names=['window','document','navigator','HTMLElement','Event','MouseEvent','Node','Element','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','localStorage','IS_REACT_ACT_ENVIRONMENT','fetch']
 for(const name of names){saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value:name==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[name],configurable:true,writable:true})}
 let current=state();const calls:any[]=[]
 globalThis.fetch=(async(input:any,init?:RequestInit)=>{calls.push({path:String(input),method:init?.method??'GET',body:init?.body});return Response.json(String(input).includes('/mcp')?{saved:true}:current)}) as typeof fetch
 const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root')!),{act}=React
 const render=async()=>{await act(async()=>{root.render(<ExternalToolsSettings tr={(_zh,en)=>en} start={async()=>{throw Error('Model must not be called')}} close={()=>{}} sessionId={()=> 'current'} openDocument={async()=>{}}/>);await new Promise(r=>setTimeout(r,0))})}
 const change=async(input:HTMLInputElement|HTMLSelectElement,value:string)=>{await act(async()=>{const setter=Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!;setter.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));input.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})}
 const button=(text:string)=>[...document.querySelectorAll('button')].find(v=>v.textContent===text)!
 try{
  await render();expect(document.body.textContent).toContain('customBlender');expect(document.body.textContent).toContain('robot-provisioning');expect(document.body.textContent).not.toContain('PRIVATE_TOKEN=')
  const search=document.querySelector<HTMLInputElement>('input[type="search"]')!
  await change(search,'robot');expect(document.body.textContent).toContain('robot-provisioning')
  await change(search,'');const selects=document.querySelectorAll('select');await change(selects[0]!,'skill')
  const inventory=document.querySelector('[aria-label="Discovered plugins and skills"]')!;expect(inventory.textContent).toContain('robot-provisioning');expect(inventory.textContent).not.toContain('customBlender')
  await act(async()=>button('Details and source').click());expect(inventory.textContent).toContain('/product/skills/robot-provisioning/SKILL.md');expect(inventory.textContent).toContain('/robot-provisioning')
  await act(async()=>button('Open associated server configuration').click());expect([...document.querySelectorAll('input')].some(v=>v.value==='customBlender')).toBe(true)
  await act(async()=>button('Save and connect').click());expect(calls.filter(v=>v.method==='POST')).toHaveLength(1);expect(JSON.parse(calls.find(v=>v.method==='POST').body)).toMatchObject({serverName:'customBlender',expectedRevision:123});expect(document.body.textContent).toContain('Saved to the native MCP client')
  current={...current,mcp:[mcp('first'),mcp('second')],associations:integrationAssociations([mcp('first'),mcp('second')])}
  await act(async()=>button('Inspect existing / refresh').click());expect(document.body.textContent).toContain('Multiple native servers match')
  const choice=[...document.querySelectorAll('select')].find(v=>v.textContent?.includes('Choose; no automatic replacement'))!
  await change(choice,'second');expect([...document.querySelectorAll('input')].some(v=>v.value==='second')).toBe(true)
  expect(calls.filter(v=>v.method==='POST')).toHaveLength(1)
  current={...current,mcp:[],associations:integrationAssociations([]),blenderSupply:{...current.blenderSupply,ready:true}}
  await act(async()=>button('Inspect existing / refresh').click())
  const bridge=[...document.querySelectorAll('select')].find(v=>v.textContent?.includes('Choose a verified source'))!
  await change(bridge,'product')
  const port=[...document.querySelectorAll('input')].find(v=>v.type==='number'&&v.value==='')!
  await change(port,'9876');await act(async()=>button('Reuse and connect').click())
  expect(calls.filter(v=>v.method==='POST')).toHaveLength(2)
  expect(JSON.parse(calls.filter(v=>v.method==='POST')[1].body)).toMatchObject({serverName:'blender',transport:'stdio',command:'/product/bin/mcp-for-blender',blenderPort:9876,expectedRevision:null})
  current={...current,mcp:[mcp('unity',{integration:'unity',command:'mcp-for-unity',unityStatusDirectory:'/public/unity-registry',unityDisableUpdateCheck:true})],associations:integrationAssociations([mcp('unity',{integration:'unity'})])}
  await act(async()=>button('Inspect existing / refresh').click())
  await act(async()=>button('MCP plugins').click())
  const unityCard=document.querySelector('[data-tool-id="unity-mcp"]')!;await act(async()=>{[...unityCard.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Connect / configure MCP')!.click()})
  const directory=[...document.querySelectorAll('label')].find(row=>row.textContent?.startsWith('Unity addon registry directory (absolute path)'))!.querySelector('input')!
  expect(directory.value).toBe('');expect(directory.placeholder).toBe('/public/unity-registry')
  await change(directory,'/public/selected-unity-registry');await act(async()=>{[...document.querySelectorAll('label')].find(row=>row.textContent?.includes('Disable additional update checks at startup'))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()})
  await act(async()=>button('Save and connect').click())
  const savedUnity=JSON.parse(calls.filter(v=>v.method==='POST').at(-1).body);expect(savedUnity).toMatchObject({serverName:'unity',transport:'stdio',unityStatusDirectory:'/public/selected-unity-registry',unityDisableUpdateCheck:false,expectedRevision:123});expect(savedUnity).not.toHaveProperty('env');expect(savedUnity).not.toHaveProperty('headers')
  await act(async()=>{root.render(<ExternalToolsSettings tr={zh=>zh} start={async()=>{throw Error('Model must not be called')}} close={()=>{}} sessionId={()=> 'current'} openDocument={async()=>{}}/>);await new Promise(r=>setTimeout(r,0))})
  await act(async()=>button('软件下载与安装').click())
  expect(document.body.textContent).toContain('软件下载与安装');expect(document.body.textContent).toContain('Unity addon 登记目录（绝对路径）');expect(document.body.textContent).toContain('关闭启动时的额外更新检查')
  const transport=[...document.querySelectorAll('select')].find(row=>row.value==='stdio')!;await change(transport,'streamable-http');expect(document.body.textContent).not.toContain('Unity addon 登记目录（绝对路径）')
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name)}}
})


// 原SDK外壳和原inventory组件参加交互，不由产品重写官方列表。
test('原插件列表仍默认且可打开集成；软件下载不藏details，正常按钮提交原acquire而非模型会话',async()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=req('jsdom'),dom=new JSDOM('<!DOCTYPE html><div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true}),saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','Element','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','localStorage','IS_REACT_ACT_ENVIRONMENT','fetch']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})}
 // SDK与产品独立安装React；以既有Bun编译原组件并固定本测试同一React，不改SDK/共享依赖。
 const nativeDir=await mkdtemp(join(tmpdir(),'native-plugin-settings-ui-')),productRoot=fileURLToPath(new URL('../../../',import.meta.url)),sdkRoot=fileURLToPath(new URL('../../../.upstream/deepseek-harness-20260911-candidate/',import.meta.url))
 await writeFile(join(nativeDir,'entry.ts'),`export {SettingsRoot} from ${JSON.stringify(join(sdkRoot,'packages/client/ui-settings-general/src/client/SettingsRoot.tsx'))};\nexport {PluginInventorySettingsTab} from ${JSON.stringify(join(sdkRoot,'packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx'))};\n`)
 await symlink(join(productRoot,'node_modules'),join(nativeDir,'node_modules'),'dir')
 const built=await Bun.build({entrypoints:[join(nativeDir,'entry.ts')],target:'bun',format:'esm',plugins:[{name:'test-single-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:Bun.resolveSync(args.path,productRoot),external:true}))}}]})
 if(!built.success)throw new AggregateError(built.logs,'原SDK插件设置组件测试编译失败')
 const javascript=built.outputs.find(row=>row.path.endsWith('.js'))!;await writeFile(join(nativeDir,'native-ui.mjs'),await javascript.text())
 const {SettingsRoot,PluginInventorySettingsTab}=await import(join(nativeDir,'native-ui.mjs')),{en:sectionEn}=await import('../../../.upstream/deepseek-harness-20260911-candidate/packages/client/ui-settings-plugins/src/client/locales.ts'),{en:inventoryEn}=await import('../../../.upstream/deepseek-harness-20260911-candidate/packages/client/ui-settings-plugin-inventory/src/client/locales.ts')
 const entries:any[]=[{id:'plugins',order:15,label:'Plugin list'}],ctx={locale:{bind:()=>()=> 'Scene workbench'},get:()=>({list:{getSnapshot:()=>({byId:{}})}}),slots:{inject:(_name:string,fn:()=>unknown)=>fn(),register:(entry:any,component:any)=>{entries.push({...entry,label:entry.label(),component});return()=>{}}}} as unknown as Context
 applyExternalToolsSettings(ctx);const rows=entries.sort((a,b)=>a.order-b.order),calls:any[]=[];let modelCalls=0,openerExit=0
 const {default:NativeJobs}=await import('@deepseek-ai/dsh-jobs-local'),{applyExternalToolsHost}=await import('../src/external-tools-host.ts'),hostCtx=new Context(),routes=new Map<string,(r:Request)=>Promise<Response>>()
 hostCtx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0} as never);await hostCtx.plugin((await import('@deepseek-ai/dsh-tools')).default)
 await hostCtx.plugin(NativeJobs);const removeController=hostCtx.jobs.attachController('plugin-download-ui-fixture');const waitForJob=async(count:number)=>{for(let i=0;i<300&&hostCtx.jobs.list().length<count;i++)await new Promise(r=>setTimeout(r,10));if(hostCtx.jobs.list().length<count)throw Error('Native acquisition Job was not created')}
 hostCtx.provide('connection',{fetch:{register:(entry:{path:string;fetch:(r:Request)=>Promise<Response>})=>{routes.set(entry.path,entry.fetch);return()=>routes.delete(entry.path)}}} as never)
 // 系统URL opener替身实际启动本测试自有短进程，不打开浏览器；registered路由和原native Jobs是真实现。
 hostCtx.provide('subprocess',{resolveExecutable:async()=>process.execPath,spawn:(spec:any)=>{
  const child=spawn(process.execPath,['--no-env-file','-e',`console.log('Fixture official page request accepted');setTimeout(()=>process.exit(${openerExit}),${openerExit===0?1800:0})`],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});spec.signal.addEventListener('abort',()=>child.kill('SIGTERM'),{once:true})
  return {done:new Promise(resolve=>child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}))),collected:{stdout:{readFrom:(offset:number)=>({text:stdout.slice(offset),nextOffset:stdout.length})},stderr:{readFrom:(offset:number)=>({text:stderr.slice(offset),nextOffset:stderr.length})}}}
 }} as never)
 applyExternalToolsHost(hostCtx)
 globalThis.fetch=(async(input:any,init?:RequestInit)=>{const path=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});if(path.includes('/state'))return Response.json({...state(),installJobs:hostCtx.jobs.list().map(row=>({jobId:String(row.id),registryId:row.registryId??null,status:row.status,label:row.label,progress:row.progress??null,detail:row.detail??null}))});const handler=routes.get(path.split('?')[0]!);if(!handler)throw Error('REGISTERED_ROUTE_MISSING');return await handler(new Request('http://fixture.invalid'+path,init))}) as typeof fetch
 const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root')!),{act}=React
 const native=()=>React.createElement(PluginInventorySettingsTab,{t:(key:string)=>inventoryEn[key as keyof typeof inventoryEn]??key,list:async()=>({entries:[{entryId:'native-fixture',moduleName:'@fixture/native-existing',enabled:true,fiberPhase:'active',meta:{title:{en:'Native existing plugin',zh:'原有原生插件'}}}],agentPresets:[]}),presetName:(row:any)=>row.name??row.id,resolveText:(text:any)=>typeof text==='string'?text:text.en,useClientSync:(select:any)=>select({syncing:false,failures:[]}),retryClient:()=>{}} as any)
 try{
  function NativeSettingsHarness(){
   const [activeId,setActiveId]=React.useState('plugins')
   return React.createElement(SettingsRoot,{wide:true,t:(key:string)=>key,useStore:(select:any)=>select({open:true,activeId}),actions:{open:()=>{},close:()=>{},select:setActiveId,openSection:setActiveId},useSections:(select:any)=>select(rows),useShortcuts:(select:any)=>select([]),useDesktopUpdate:(select:any)=>select({}),useConnectionState:(select:any)=>select('connected'),useOnboardingSteps:(select:any)=>select([]),useSessions:(select:any)=>select({phase:'ready',byId:{fixture:{retainedBy:{mainView:1},blank:false}}}),openDesktopUpdate:()=>{},reconnect:()=>{},renderSlot:(name:string,_owner:unknown,options?:{only:string;fallback?:unknown})=>{if(name==='settings.section'){if(options?.only==='plugins')return native();const entry=entries.find(row=>row.id===options?.only);return entry?React.createElement(entry.component,entry.inject()):null}if(name==='settings.header')return 'Settings';if(name==='settings.close')return 'Close';return options?.fallback??null}} as any)
  }
  await act(async()=>{root.render(React.createElement(NativeSettingsHarness));await new Promise(r=>setTimeout(r,0))})
  const nav=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('nav button')].find(row=>row.textContent===text)!
  expect(nav('Plugin list').getAttribute('aria-current')).toBe('true')
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent?.startsWith('Global plugins'))!.click()})
  expect(document.body.textContent).toContain('Native existing plugin')
  await act(async()=>{nav('Software and integrations').click();await new Promise(r=>setTimeout(r,0))})
  const software=document.querySelector<HTMLElement>('[aria-label="Software downloads and installation"]');expect(software).not.toBeNull();expect(software!.closest('details:not([open])')).toBeNull();expect(software!.textContent).toContain('Blender');expect(software!.textContent).toContain('Unity');expect(software!.textContent).toContain('SAM 3D Objects');expect(software!.textContent).toContain('FastGS')
  const blender=software!.querySelector<HTMLElement>('[data-tool-id="blender"]')!;expect(blender).not.toBeNull()
  await act(async()=>{[...blender.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Download / install from official source')!.click();await waitForJob(1)})
  expect(calls.find(row=>row.path.endsWith('/acquire'))?.body).toMatchObject({id:'blender'});expect(modelCalls).toBe(0);const job=hostCtx.jobs.list()[0]!,stateReads=calls.filter(row=>row.path.includes('/state')).length;await act(async()=>{await hostCtx.jobs.wait(job.id,3000)});expect(calls.some(row=>row.path.includes('/job?'))).toBe(true);expect(calls.filter(row=>row.path.includes('/state'))).toHaveLength(stateReads);await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Inspect existing / refresh')!.click();await new Promise(r=>setTimeout(r,0))});expect(document.body.textContent).toContain(String(job.id));expect(document.body.textContent).toContain('not installed automatically')
  await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Read actual output')!.click();await new Promise(r=>setTimeout(r,0))});expect(document.body.textContent).toContain('Fixture official page request accepted')
  openerExit=17;const unity=software!.querySelector<HTMLElement>('[data-tool-id="unity"]')!;await act(async()=>{[...unity.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Download / install from official source')!.click();await waitForJob(2)});const failed=hostCtx.jobs.list().find(row=>row.id!==job.id)!;await hostCtx.jobs.wait(failed.id,3000);await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Inspect existing / refresh')!.click();await new Promise(r=>setTimeout(r,0))});expect(document.body.textContent).toContain('Official download page could not be opened (exit 17)');expect(document.body.textContent).not.toContain('官方下载页面未能打开');expect(modelCalls).toBe(0)
  await act(async()=>{nav('Plugin list').click();await new Promise(r=>setTimeout(r,0))});expect(nav('Plugin list').getAttribute('aria-current')).toBe('true');await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent?.startsWith('Global plugins'))!.click();await new Promise(r=>setTimeout(r,0))});expect(document.body.textContent).toContain('Native existing plugin')
 }finally{await act(async()=>root.unmount());removeController();await hostCtx.fiber.dispose();dom.window.close();await rm(nativeDir,{recursive:true,force:true});for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}}
})
