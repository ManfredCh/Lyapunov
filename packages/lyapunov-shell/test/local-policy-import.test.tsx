import {test,expect} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {importLocalPolicy} from '../src/local-policy-import.ts'
import {PolicyLibraryPanel} from '../src/policy-library-panel.tsx'
import {policyPanelAction} from '../src/policy-panel-action.ts'
import {workbenchAPI} from '../src/workbench-api.ts'
import {commandRouteResponse} from '../../lyapunov-contracts/src/command-privacy.ts'
import {resolveProductPaths} from '../../lyapunov-contracts/src/product-paths.ts'
import {apply as applyPolicyRegistry} from '../../policy-registry/src/plugin.ts'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const context={sceneId:'real-scene',entityId:'selected-robot',expectedRevision:7,worldId:'same-world',expectedGeneration:3}
test('完整bundle调用原load/state，保留身份与实例维数，不自动准备或运动',async()=>{
 const calls:Array<{name:string;input:any}>=[],identity={provider:'github',modelId:'fixed/source',revision:'pin'}
 const state={category:'model_incompatible',ready:false,dimensions:{action:12,currentJointCount:23},missing:[{code:'ROBOT_MODEL_MISMATCH',field:'jointNames',detail:'12/23型号不同'}]}
 const result=await importLocalPolicy({command:async(name,input)=>{calls.push({name,input});return name==='policy_load_local'?{status:'DOWNLOADED',identity}:state}},'/local/bundle.json',context)
 expect(calls.map(c=>c.name)).toEqual(['policy_load_local','policy_load_state']);expect(calls[0]!.input).toMatchObject({...context,manifestPath:'/local/bundle.json'})
 expect(calls[1]!.input.identity).toEqual(identity);expect(result.face.state).toBe(state);expect(result.face.state.ready).toBe(false)
})
test('裸权重未知来源不猜附近bundle，明确已登记包根才给实际路径',async()=>{
 const calls:string[]=[],state={category:'weights_need_adapter',ready:false,dimensions:{},missing:[],nextActions:[],policyPrepared:false}
 const result=await importLocalPolicy({command:async name=>{calls.push(name);return state}},'/user/go1/body_latest.jit',context)
 expect(calls).toEqual(['policy_load_local']);expect(result.requestedBundlePath).toBeUndefined();expect(result.face.state).toBe(state)
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad {...context} command={async()=>{throw Error('SSR禁止请求')}} importReceipt={result} tr={cn=>cn}/>)
 expect(html).toContain('policy-bundle-required');expect(html).not.toContain('/user/go1/bundle.json');expect(html).toContain('未扫描目录')
 const known=await importLocalPolicy({command:async()=>({...state,localSource:{bundlePath:'/registered/go1/bundle.json',status:'registered-package',prepareFrom:'bundle'}})},'/registered/go1/runs/checkpoints/body_latest.jit',context)
 expect(known.requestedBundlePath).toBe('/registered/go1/bundle.json')
})
test('登记不要求机器人；兼容绑定只在scene/entity完整时传入，普通JSON不派发',async()=>{
 const calls:string[]=[],ports={command:async(name:string)=>{calls.push(name);throw Error('不应派发')}}
 await expect(importLocalPolicy(ports,'/local/config.json',context)).rejects.toThrow('POLICY_FILE_FORMAT_UNSUPPORTED')
 expect(calls).toHaveLength(0)
 const seen:Array<{name:string;input:any}>=[],state={category:'weights_need_adapter',ready:false}
 await importLocalPolicy({command:async(name,input)=>{seen.push({name,input});return state}},'/local/weights.pt',{sceneId:'s',worldId:'w',expectedGeneration:2})
 expect(seen.map(call=>call.name)).toEqual(['policy_load_local']);expect(seen[0]!.input).toEqual({kind:'policy',filePath:'/local/weights.pt'})
 expect(seen[0]!.input).not.toHaveProperty('sceneId');expect(seen[0]!.input).not.toHaveProperty('worldId')
})
test('明确目录交由Host核根bundle，真实登记回执指向可重开的本地缓存',async()=>{
 const calls:Array<{name:string;input:any}>=[],entry={id:'local-id',label:'自有策略',filePath:'/cache/weights.pt',available:true,registeredAt:'2026-10-04',sourceBytesVerified:false}
 const result=await importLocalPolicy({command:async(name,input)=>{calls.push({name,input});return {category:'weights_need_adapter',ready:false,localEntry:entry}}},'/local/完整目录',{})
 expect(calls[0]!.input.directoryPath).toBe('/local/完整目录');expect(result.entry).toEqual(entry);expect(result.filePath).toBe('/local/完整目录')
 expect(calls.map(call=>call.name)).toEqual(['policy_load_local'])
})
test('切scope后load迟到，不把下一次state请求派给旧身份',async()=>{
 let current=true;const calls:string[]=[]
 const result=await importLocalPolicy({current:()=>current,command:async name=>{calls.push(name);current=false;return {status:'DOWNLOADED',identity:{provider:'github',modelId:'x/y',revision:'pin'}}}},'/local/bundle.json',context)
 expect(calls).toEqual(['policy_load_local']);expect(result.face.cancelled).toBe(true)
})
test('许可false或格式失败保持原拒绝，不继续state/prepare/activate',async()=>{
 const calls:string[]=[],failure={status:'BLOCKED',code:'ROBOT_DOWNLOAD_NOT_READY',message:'许可未核',missingLicense:['fixed/policy.pt']}
 const result=await importLocalPolicy({command:async name=>{calls.push(name);return failure}},'/local/g123.bundle.json',context)
 expect(calls).toEqual(['policy_load_local']);expect(result.face.failure).toBe(failure)
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad {...context} command={async()=>{throw Error('SSR禁止请求')}} importReceipt={result} tr={cn=>cn}/>)
 expect(html).toContain('ROBOT_DOWNLOAD_NOT_READY');expect(html).toContain('许可未核')
})
test('正式命令handler到public DTO再到API/面板：未知策略登记、重开、检查和拒应用均按entryId续链',async()=>{
 const root=await mkdtemp(join(tmpdir(),'formal-policy-dto-')),originalFetch=globalThis.fetch
 let commands=new Map<string,any>(),serverCalls=0,jobs=0
 const sent:Array<{name:string;input:any}>=[],outbound:any[]=[]
 const start=()=>{commands=new Map();const ctx={tools:{register:()=>{}},commands:{register:(command:any)=>commands.set(command.name,command)},jobs:{start:()=>{jobs++;throw Error('不得执行job')}},reflect:{provide:()=>{}},effect:()=>()=>{},get:()=>undefined};applyPolicyRegistry(ctx as any,{guest:true,dataDirectory:root,pythonPath:join(root,'unavailable-python'),robotDownloadFetcher:async()=>{serverCalls++;throw Error('不得联网')}})}
 try{
  const file=join(root,'自有策略.safetensors'),header=Buffer.from(JSON.stringify({value:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));await writeFile(file,Buffer.concat([size,header,Buffer.alloc(4)]))
  start()
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));sent.push({name:body.name,input:body.input});const outcome=await commands.get(body.name).handler({rawInput:JSON.stringify(resolveProductPaths(body.input,{data:root})),agent:'formal-policy-session',signal:new AbortController().signal});const response=commandRouteResponse(body.name,outcome,'formal',{data:root});outbound.push(response);expect(JSON.stringify(response)).not.toContain(root);return Response.json(response)}) as typeof fetch
  const api=workbenchAPI('formal-policy-session'),receipt=await importLocalPolicy({command:(name,input)=>api.command(name,input)},file,{})
  expect(receipt.entry).toBeDefined();expect(receipt.entry).not.toHaveProperty('filePath');expect(receipt.entry!.identity).toBeUndefined();expect(receipt.face.state.ready).toBe(false)
  const listing=await api.command<any>('policy_download_sources',{});expect(listing.localEntries).toEqual([receipt.entry])
  start();const reopenedAPI=workbenchAPI('formal-policy-session'),entryId=listing.localEntries[0].id
  const reopened=await policyPanelAction({command:(name,input)=>reopenedAPI.command(name,input)},'load',{entryId,identity:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}})
  expect(reopened.entry).toEqual(receipt.entry);expect(reopened.identity).toBeUndefined();expect(reopened.state.evidence.adapterImplemented).toBe(false)
  const checked=await policyPanelAction({command:(name,input)=>reopenedAPI.command(name,input)},'check',{entryId});expect(checked.entry?.id).toBe(entryId);expect(checked.state.missing.map((row:any)=>row.field)).toEqual(['adapter','source','observations','actions'])
  const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="scene" entityId="robot" worldId="world" importReceipt={{filePath:'',entry:reopened.entry,face:reopened}} command={(name,input)=>reopenedAPI.command(name,input)} tr={cn=>cn}/>)
  expect(html).toContain('自有策略.safetensors');expect(html).toContain(`value="${entryId}"`);expect(html).toContain('读取已登记策略');expect(html).toContain('来源与接口待验证');expect(html).not.toContain(root)
  expect(html).toMatch(/<button disabled="">准备已登记适配器/);expect(html).toMatch(/<button disabled="">应用到所选实例/)
  const fake={entryId,identity:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'},sceneId:'scene',entityId:'robot',worldId:'world',expectedRevision:1,expectedGeneration:1}
  await expect(reopenedAPI.command('policy_prepare',fake)).rejects.toThrow('no verified source')
  await expect(reopenedAPI.command('policy_activate',fake)).rejects.toThrow('no verified source')
  expect(await reopenedAPI.command<any>('policy_load_local',{entryId,filePath:file})).toMatchObject({status:'BLOCKED',code:'POLICY_LOCAL_ENTRY_INPUT_CONFLICT'})
  expect(await reopenedAPI.command<any>('policy_load_local',{entryId:'../../outside.pt'})).toMatchObject({status:'BLOCKED',code:'POLICY_LOCAL_ENTRY_NOT_FOUND'})
  expect((await reopenedAPI.command<any>('policy_download_sources',{})).localEntries).toEqual([receipt.entry]);expect(serverCalls).toBe(0);expect(jobs).toBe(0)
  expect(sent.filter(row=>['policy_load_state','policy_prepare','policy_activate'].includes(row.name)).every(row=>row.input.entryId===entryId&&!row.input.filePath&&!row.input.weightsPath)).toBe(true)
  expect(outbound.every(row=>!JSON.stringify(row).includes('filePath'))).toBe(true)
 }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true})}
})
