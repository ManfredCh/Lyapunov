import {afterEach,expect,test} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot} from 'react-dom/client'
import {renderToStaticMarkup} from 'react-dom/server'
import {PolicyLibraryPanel,policyPanelAction,policyPrepareArgs,policyCategoryLabels,policyProblemSummary} from '../src/policy-library-panel.tsx'
import type {PolicyLoadState} from '../../policy-registry/src/load-state.ts'
import {commandRouteResponse} from '../../lyapunov-contracts/src/command-privacy.ts'
test('端点首错误即显示阻断，不自动准备/匹配/重复下载',async()=>{
 const calls:string[]=[];const ports={command:async(name:string)=>{calls.push(name);return{status:'BLOCKED',code:'ROBOT_DOWNLOAD_ENDPOINT_FAILED',retryable:false,fallbackAction:'web_fetch'}}}
 const result=await policyPanelAction(ports,'download',{modelId:'unitree_g1_12dof_motion'})
 expect(calls).toEqual(['policy_download_bundle']);expect(result.failure.code).toBe('ROBOT_DOWNLOAD_ENDPOINT_FAILED');expect(result.state).toBeUndefined()
})
test('本地未知权重仅加载真实分类，不被按钮链自动prepare/执行',async()=>{
 const calls:string[]=[];const s={category:'weights_need_adapter',ready:false}
 const result=await policyPanelAction({command:async(name:string)=>{calls.push(name);return s}},'load',{filePath:'/user/chosen.pt'})
 expect(calls).toEqual(['policy_load_local']);expect(result.state).toEqual(s)
})
test('完整包安装后按已验来源检查实际状态，不把DOWNLOADED标READY',async()=>{
 const calls:Array<{name:string;input:any}>=[]
 const result=await policyPanelAction({command:async(name,input)=>{calls.push({name,input});return name==='policy_load_local'?{status:'DOWNLOADED',identity:{provider:'github',modelId:'x/y',revision:'pin'}}:{category:'model_incompatible',ready:false}}},'load',{filePath:'/user/bundle.json',sceneId:'s',entityId:'r'})
 expect(calls.map(c=>c.name)).toEqual(['policy_load_local','policy_load_state']);expect(calls[1]!.input.identity.modelId).toBe('x/y');expect(result.state.ready).toBe(false)
})
test('登记成功后兼容检查失败保留登记回执和真实错误，不自动准备或应用',async()=>{
 const entry={id:'local-id',label:'策略',filePath:'/cache/weights.pt',registeredAt:'2026-10-04',available:true,sourceBytesVerified:true},calls:string[]=[]
 const result=await policyPanelAction({command:async name=>{calls.push(name);if(name==='policy_load_local')return {status:'LOCAL_WEIGHTS_ADOPTED',localEntry:entry};throw Error('POLICY_WORLD_BINDING_MISMATCH: world属于另一Scene')}},'load',{filePath:'/chosen.pt',sceneId:'s',entityId:'r'})
 expect(result.entry).toEqual(entry);expect(result.failure.code).toBe('POLICY_WORLD_BINDING_MISMATCH');expect(result.failure.message).toContain('Policy registered')
 expect(calls).toEqual(['policy_load_local','policy_load_state'])
})
test('侧栏有策略/VLA文件与来源入口，原生控制不被强制下载流程',()=>{
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" command={async()=>{throw new Error('SSR不得请求模型或下载')}} tr={cn=>cn}/>)
 expect(html).toContain('robot-policy-vla-library');expect(html).toContain('登记本地文件 / 目录');expect(html).toContain('检查状态 / 兼容');expect(html).toContain('原生关节和夹爪控制无需训练策略')
 expect(Object.values(policyCategoryLabels)).toHaveLength(4)
})
test('无机器人仍可选择登记；准备与应用保留真实实例限制，登记未执行',()=>{
 const entry={id:'local-id',label:'自己的控制策略',filePath:'/cache/weights.pt',available:true,registeredAt:'2026-10-04',sourceBytesVerified:false}
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad={false} chooseFile={async()=>undefined} importReceipt={{filePath:entry.filePath,entry,face:{state:{category:'weights_need_adapter',ready:false,dimensions:{},missing:[],nextActions:[],policyPrepared:false}}}} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(html).not.toMatch(/<button data-policy-register="choose"[^>]*disabled/);expect(html).not.toMatch(/<button data-policy-register="path"[^>]*disabled/)
 expect(html).toContain('自己的控制策略');expect(html).toContain('来源与接口待验证');expect(html).toContain('机器人应用尚未执行')
 expect(html).toMatch(/<button disabled="">准备已登记适配器/);expect(html).toMatch(/<button disabled="">应用到所选实例/)
})
test('准备按钮保留选定权重与实体/世界绑定，仅把filePath转换成weightsPath',async()=>{
 const identity={provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}
 const input={kind:'policy',identity,filePath:'downloads/g1/policy.pt',sceneId:'s',entityId:'selected',worldId:'w',expectedGeneration:4}
 const calls:Array<{name:string;input:any}>=[]
 await policyPanelAction({command:async(name,args)=>{calls.push({name,input:args});return name==='policy_prepare'?{status:'PREPARED'}:{category:'weights_need_adapter',ready:false}}},'prepare',input)
 expect(calls[0]!.name).toBe('policy_prepare');expect(calls[0]!.input).toMatchObject({...identity,weightsPath:'downloads/g1/policy.pt',sceneId:'s',entityId:'selected',worldId:'w',expectedGeneration:4})
 expect(calls[0]!.input).not.toHaveProperty('filePath');expect(calls[0]!.input).not.toHaveProperty('robotModelPath')
 expect(policyPrepareArgs({...input,filePath:undefined,manifestPath:'/bundle.json'})).not.toHaveProperty('weightsPath')
 expect(calls[1]!.input.identity).toEqual(identity);expect(calls[1]!.input.worldId).toBe('w')
 calls.length=0
 await policyPanelAction({command:async(name,args)=>{calls.push({name,input:args});return name==='policy_prepare'?{status:'PREPARED'}:{category:'weights_need_adapter',ready:false}}},'prepare',{...identity,sceneId:'s',entityId:'selected',worldId:'w',expectedGeneration:4})
 expect(calls[1]!.input.identity).toEqual(identity)
})
test('明确实例应用使用新world绑定读取状态，不把绑定成功说成行走完成',async()=>{
 const calls:Array<{name:string;input:any}>=[],identity={provider:'github',modelId:'registered',revision:'pin'}
 const result=await policyPanelAction({command:async(name,input)=>{calls.push({name,input});return name==='policy_activate'?{status:'ACTIVE_MATCHED',identity,world:{worldId:'new',sceneId:'s',worldGeneration:2,appliedSceneRevision:5},snapshot:{sceneId:'s',revision:5},match:{status:'MATCHED',provider:'github',modelId:'registered',revision:'pin',sceneId:'s',entityId:'selected',worldId:'new',worldGeneration:2,sceneRevision:5},executionStarted:false}:{category:'direct_execution',executionKind:'native_control',ready:true,runtimeChecked:true,applyEligible:false,preApplyDifferences:[],dimensions:{},missing:[],nextActions:[],worldBound:false,policyPrepared:false,robotWalkingVerified:false as const,evidence:{behaviorVerified:false}}}},'activate',{identity,sceneId:'s',entityId:'selected',expectedRevision:4,worldId:'old',expectedGeneration:1})
 expect(calls[0]!.name).toBe('policy_activate');expect(calls[0]!.input.expectedRevision).toBe(4);expect(calls[1]!.input.worldId).toBe('new');expect(calls[1]!.input.expectedGeneration).toBe(2);expect(result.result.executionStarted).toBe(false);expect(result.state.evidence.behaviorVerified).toBe(false);expect(result.appliedBinding).toMatchObject({sceneId:'s',entityId:'selected',worldId:'new',revision:5,generation:2})
})
test('错策略给简短可读原因与Change policy入口，技术错误仍可在详情核读',()=>{
 const state=baseState({category:'model_incompatible',missing:[{code:'JOINT_COUNT_MISMATCH',field:'action',detail:'wrong robot',nextAction:'prepare'}]})
 expect(policyProblemSummary(state,undefined,'',((_zh:string,en:string)=>en) as never)).toBe('Policy actions do not match this robot’s joints.')
 expect(policyProblemSummary(undefined,{code:'POLICY_SOURCE_MISMATCH'},'',((_zh:string,en:string)=>en) as never)).toBe('The policy files do not match a verified registered source.')
})
test('Go1/Go2裸文件准备读完整缓存，不传G123专属weightsPath',()=>{
 for(const modelId of ['Improbable-AI/walk-these-ways','inria-paris-robotics-lab/go2_onnx_controller']){
  const args=policyPrepareArgs({identity:{provider:'github',modelId,revision:'pin'},filePath:'/chosen/model.onnx',sceneId:'s',entityId:'r',localSource:{prepareFrom:'cache'}})
  expect(args).not.toHaveProperty('weightsPath');expect(args).not.toHaveProperty('localSource');expect(args).toMatchObject({sceneId:'s',entityId:'r',modelId})
 }
})
test('ACTIVE_BLOCKED/弱身份不产生Applied，稳定成功必须与所选实例完整匹配',async()=>{
 const input={identity:{provider:'github',modelId:'x/y',revision:'pin'},sceneId:'s',entityId:'r',expectedRevision:2,worldId:'w',expectedGeneration:1}
 const weak=await policyPanelAction({command:async name=>name==='policy_activate'?{status:'ACTIVE_MATCHED',identity:input.identity,world:{worldId:'w',sceneId:'s',worldGeneration:2,appliedSceneRevision:3},snapshot:{sceneId:'s',revision:3}}:{category:'direct_execution'}},'activate',input)
 expect(weak.appliedBinding).toBeUndefined()
 expect(weak.failure?.code).toBe('POLICY_ACTIVATION_UNCONFIRMED')
 const other=await policyPanelAction({command:async name=>name==='policy_activate'?{status:'ACTIVE_MATCHED',identity:input.identity,world:{worldId:'w',sceneId:'s',worldGeneration:2,appliedSceneRevision:3},snapshot:{sceneId:'s',revision:3},match:{status:'MATCHED',provider:'github',modelId:'x/y',revision:'pin',sceneId:'s',entityId:'other',worldId:'w',worldGeneration:2,sceneRevision:3}}:{category:'direct_execution'}},'activate',input)
 expect(other.appliedBinding).toBeUndefined()
 const blocked=await policyPanelAction({command:async name=>name==='policy_activate'?{status:'ACTIVE_BLOCKED',identity:input.identity}:{category:'direct_execution'}},'activate',input)
 expect(blocked.appliedBinding).toBeUndefined()
})
test('登记条目准备只携entryId与实例绑定，不把显示路径当成Host权重路径',()=>{
 const args=policyPrepareArgs({entryId:'local-entry',filePath:'display-only.pt',directoryPath:'display-only',identity:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'},sceneId:'s',entityId:'r'})
 expect(args.entryId).toBe('local-entry');expect(args.sceneId).toBe('s');expect(args.entityId).toBe('r')
 for(const field of ['filePath','directoryPath','manifestPath','weightsPath'])expect(args).not.toHaveProperty(field)
})
test('本体按钮只取asset，不因策略runtime预检阻断本体或翻整包许可',async()=>{
 const calls:Array<{name:string;input:any}>=[]
 const result=await policyPanelAction({command:async(name,input)=>{calls.push({name,input});return name==='policy_download_bundle'?{status:'ASSET_DOWNLOADED',modelPath:'/verified/body.xml',source:{provider:'github',modelId:'fixed/source',resolvedRevision:'pin'},assetBytesVerified:true,fullBundleReady:false,policyPrepared:false}:{category:'missing_files_or_runtime',ready:false}}},'asset',{modelId:'unitree_g1_23dof_75obs'})
 expect(calls.map(c=>c.name)).toEqual(['policy_download_bundle']);expect(calls[0]!.input.pieces).toEqual(['asset']);expect(result.result.fullBundleReady).toBe(false);expect(result.result.policyPrepared).toBe(false);expect(result.state).toBeUndefined()
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad={false} canLoadAsset sceneId="s" command={async()=>{throw Error('SSR不得请求')}} onAssetLoaded={async()=>{}} tr={cn=>cn}/>);expect(html).toContain('仅下载本体并载入');expect(html).toContain('XML与依赖')
})

// ------------------------------------------------------------- P18 A / B1 / B2 -------------------------------------------------------------
const identityFixture={provider:'github',modelId:'x/y',revision:'pin'}
const baseState=(over:Record<string,unknown>={}):PolicyLoadState=>({category:'direct_execution',executionKind:'local_torch',ready:false,runtimeChecked:true,applyEligible:false,policyPrepared:true,preApplyDifferences:[],dimensions:{},missing:[],nextActions:[],worldBound:true,robotWalkingVerified:false,...over})
const receiptFixture=(state:any,over:Record<string,unknown>={})=>({filePath:'/cache/model.pt',face:{state,identity:identityFixture},context:{kind:'policy',sceneId:'s',entityId:'r',worldId:'w',expectedGeneration:2,expectedRevision:3,identity:identityFixture,...over}})
const primaryButton=(html:string)=>html.match(/data-testid="policy-next"[^>]*>([^<]*)</)?.[1]

test('A 真实产品HTTP投影保留applyEligible/preApplyDifferences并驱动Apply主按钮',()=>{
 const raw=baseState({ready:false,applyEligible:true,preApplyDifferences:[{path:'controller.robot',reason:'ROBOT_MODEL_MISMATCH',detail:'Apply rebuilds this field from the prepared adapter'}],robotWalkingVerified:false,internalSecret:'internal-do-not-send',password:'sk-'+'LEAK_TOKEN'})
 const response:any=commandRouteResponse('policy_load_state',{kind:'success',text:JSON.stringify(raw)},'formal')
 expect(response.ui.applyEligible).toBe(true)
 expect(response.ui.preApplyDifferences).toEqual([{path:'controller.robot',reason:'ROBOT_MODEL_MISMATCH',detail:'Apply rebuilds this field from the prepared adapter'}])
 const serialized=JSON.stringify(response)
 expect(serialized).not.toContain('internalSecret')
 expect(serialized).not.toContain('sk-LEAK_TOKEN')
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" worldId="w" worldStatus="running" expectedGeneration={2} expectedRevision={3} importReceipt={receiptFixture(response.ui) as never} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(primaryButton(html)).toBe('应用到所选实例')
})

test('A 负例：投影缺失applyEligible/不兼容时仍禁Apply；未知字段与敏感标记不下发',()=>{
 const raw=baseState({category:'model_incompatible',ready:false,applyEligible:false,preApplyDifferences:[],missing:[{code:'ROBOT_MODEL_MISMATCH',field:'jointNames',detail:'The current body differs',nextAction:'local_load'}],unknownField:'nope',token:'sk-'+'NEG_TOKEN'})
 const response:any=commandRouteResponse('policy_load_state',{kind:'success',text:JSON.stringify(raw)},'formal')
 expect(response.ui.applyEligible).toBe(false)
 expect(JSON.stringify(response)).not.toContain('unknownField')
 expect(JSON.stringify(response)).not.toContain('sk-NEG_TOKEN')
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" worldId="w" worldStatus="running" expectedGeneration={2} expectedRevision={3} importReceipt={receiptFixture(response.ui) as never} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(primaryButton(html)).toBe('当前实例不兼容')
})

test('B1 paused世界：缺适配器时主按钮给出准备下一步，而不是反复Re-check world binding',()=>{
 const state=baseState({category:'weights_need_adapter',applyEligible:false,policyPrepared:false,nextActions:[{kind:'prepare',label:'prepare'}],missing:[{code:'WORLD_NOT_EXECUTABLE',field:'world.status',detail:'World status is paused',nextAction:'match'},{code:'POLICY_ADAPTER_UNAVAILABLE',field:'adapter',detail:'missing',nextAction:'prepare'}]})
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" worldId="w" worldStatus="paused" expectedGeneration={2} expectedRevision={3} importReceipt={receiptFixture(state) as never} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(primaryButton(html)).toBe('为本实例准备')
})

test('B1 paused世界但适配器已就绪：主按钮是Apply（Apply会重建同一版本世界）',()=>{
 const state=baseState({applyEligible:true,policyPrepared:true,nextActions:[{kind:'match',label:'apply'}],missing:[{code:'WORLD_NOT_EXECUTABLE',field:'world.status',detail:'World status is paused',nextAction:'match'}]})
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" worldId="w" worldStatus="paused" expectedGeneration={2} expectedRevision={3} importReceipt={receiptFixture(state) as never} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(primaryButton(html)).toBe('应用到所选实例')
})

test('B3 旧路径不可证：资格只能来自本实例重准备，主按钮不再是永久Incompatible',()=>{
 const raw=baseState({category:'weights_need_adapter',applyEligible:false,policyPrepared:true,recovery:'prepare_on_instance',missing:[{code:'WORLD_NOT_EXECUTABLE',field:'world.status',detail:'World status is paused',nextAction:'match'},{code:'ROBOT_PHYSICS_MODEL_MISMATCH',field:'adapter.modelSourcePath',detail:'cached adapter cannot be tied to this registered original',nextAction:'prepare'}],nextActions:[{kind:'prepare',label:'prepare'}]})
 const response:any=commandRouteResponse('policy_load_state',{kind:'success',text:JSON.stringify(raw)},'formal')
 expect(response.ui.recovery).toBe('prepare_on_instance')
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad sceneId="s" entityId="r" worldId="w" worldStatus="paused" expectedGeneration={2} expectedRevision={3} importReceipt={receiptFixture(response.ui) as never} command={async()=>{throw Error('SSR不得请求')}} tr={cn=>cn}/>)
 expect(primaryButton(html)).toBe('为本实例准备')
 expect(html).toContain('需在本实例重新准备')
 expect(html).not.toContain('>当前实例不兼容<')
})

const savedDom=new Map<string,PropertyDescriptor|undefined>()
function installDom(){
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
 const {JSDOM}=req('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid',pretendToBeVisual:true})
 for(const key of ['window','document','HTMLElement','Node','navigator','IS_REACT_ACT_ENVIRONMENT']){
  savedDom.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  const value=key==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as never as Record<string,unknown>)[key]
  Object.defineProperty(globalThis,key,{configurable:true,value})
 }
 return dom
}
afterEach(()=>{for(const [key,value] of savedDom){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as never as Record<string,unknown>)[key]}savedDom.clear()})

test('真实HTTP投影缺state.world时仍以activate绑定显示Applied；旧回执重发不覆盖，外部world作废',async()=>{
 const dom=installDom(),root=createRoot(document.getElementById('root')!)
 const state=baseState({applyEligible:true,modelId:'x/y',ready:true,evidence:{worldMatched:true},world:{worldId:'w2',sceneId:'s',worldGeneration:3,appliedSceneRevision:4,status:'ready'}})
 const activation={status:'ACTIVE_MATCHED',identity:identityFixture,world:{worldId:'w2',sceneId:'s',worldGeneration:3,appliedSceneRevision:4,status:'ready'},snapshot:{sceneId:'s',revision:4},match:{status:'MATCHED',provider:'github',modelId:'x/y',revision:'pin',sceneId:'s',entityId:'r',worldId:'w2',worldGeneration:3,sceneRevision:4},executionStarted:false}
 const http=(name:string,value:any)=>(commandRouteResponse(name,{kind:'success',text:JSON.stringify(value)},'formal') as any).ui
 expect(http('policy_load_state',state).world).toBeUndefined()
 const command=async(name:string)=>name==='policy_activate'?http(name,activation):name==='policy_load_state'?http(name,state):{}
 const receipt=receiptFixture(baseState({applyEligible:true}))
 const props=(over:Record<string,unknown>={})=>({available:true,canLoad:true,sceneId:'s',entityId:'r',worldId:'w',worldStatus:'running',expectedGeneration:2,expectedRevision:3,importReceipt:receipt,command,tr:(_zh:string,en:string)=>en,onOpenControls:()=>{},...over})
 try{
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props() as never)))
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="policy-next"]')!.click())
  expect(document.querySelector('[data-testid="policy-applied"]')).not.toBeNull()
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({worldId:'w2',worldStatus:'ready',expectedGeneration:3,expectedRevision:4,importReceipt:{...receipt}}) as never)))
  expect(document.querySelector('[data-testid="policy-applied"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="policy-next"]')).toBeNull()
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({worldId:'external',expectedGeneration:8,expectedRevision:9}) as never)))
  expect(document.querySelector('[data-testid="policy-applied"]')).toBeNull()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Not checked')
 }finally{await act(async()=>root.unmount());dom.window.close()}
})

test('B2竞态①：Apply自己更新world/revision时成功回执不被旧props作废，并按新绑定再检查',async()=>{
 const dom=installDom(),root=createRoot(document.getElementById('root')!)
 const state=baseState({applyEligible:true,policyPrepared:true})
 const receipt=receiptFixture(state)
 let activated:any,calls:Array<{name:string;input:any}>=[],resolveActivate:(value:any)=>void=()=>{}
 const command=async(name:string,input:any)=>{calls.push({name,input});if(name==='policy_activate')return await new Promise(resolve=>{resolveActivate=(value)=>resolve(value)});if(name==='policy_load_state')return {...state,ready:true};return {}}
 const props=(over:Record<string,unknown>={})=>({available:true,canLoad:true,sceneId:'s',entityId:'r',worldId:'w',worldStatus:'running',expectedGeneration:2,expectedRevision:3,importReceipt:receipt,command,onActivated:(value:any)=>{activated=value},tr:(_zh:string,en:string)=>en,...over})
 try{
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props() as never) as never))
  const button=()=>document.querySelector<HTMLButtonElement>('[data-testid="policy-next"]')!
  expect(button().textContent).toBe('Apply to instance')
  await act(async()=>button().click())
  // Apply 提交期间轮询先读到新 Scene 版本/新 world：同一实例的合法版本更新，不得取消该动作。
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({worldId:'w2',worldStatus:'ready',expectedGeneration:3,expectedRevision:4}) as never) as never))
  await act(async()=>{resolveActivate({status:'ACTIVE_MATCHED',identity:identityFixture,world:{worldId:'w2',sceneId:'s',worldGeneration:3,appliedSceneRevision:4,status:'ready'},snapshot:{sceneId:'s',revision:4},match:{status:'MATCHED',provider:'github',modelId:'x/y',revision:'pin',sceneId:'s',entityId:'r',worldId:'w2',worldGeneration:3,sceneRevision:4},executionStarted:false})})
  const post=calls.find(call=>call.name==='policy_load_state')!
  expect(post.input.worldId).toBe('w2')
  expect(post.input.expectedRevision).toBe(4)
  expect(post.input.expectedGeneration).toBe(3)
  expect(activated?.snapshot?.revision).toBe(4)
  expect(activated?.world?.worldId).toBe('w2')
  // 父组件随后把 props 更新成同一个新绑定（worldStatus 也变）：这是同一动作的合法版本更新，刚读回的状态不得被清掉。
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({worldId:'w2',worldStatus:'running',expectedGeneration:3,expectedRevision:4}) as never) as never))
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Applied')
 }finally{await act(async()=>root.unmount());dom.window.close()}
})

test('B2竞态②：切实例后旧Apply回执不得覆盖新目标',async()=>{
 const dom=installDom(),root=createRoot(document.getElementById('root')!)
 const state=baseState({applyEligible:true,policyPrepared:true})
 const receipt=receiptFixture(state)
 let activated:any,resolveActivate:(value:any)=>void=()=>{}
 const command=async(name:string,input:any)=>{if(name==='policy_activate')return await new Promise(resolve=>{resolveActivate=(value)=>resolve(value)});if(name==='policy_load_state')return {...state,ready:true};return {}}
 const props=(over:Record<string,unknown>={})=>({available:true,canLoad:true,sceneId:'s',entityId:'r',worldId:'w',worldStatus:'running',expectedGeneration:2,expectedRevision:3,importReceipt:receipt,command,onActivated:(value:any)=>{activated=value},tr:(_zh:string,en:string)=>en,...over})
 try{
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props() as never) as never))
  const button=()=>document.querySelector<HTMLButtonElement>('[data-testid="policy-next"]')!
  await act(async()=>button().click())
  // 用户切到另一个实体：旧回执必须作废，不得把旧 Apply 的 snapshot/world 写进新目标。
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({entityId:'other'}) as never) as never))
  await act(async()=>{resolveActivate({status:'ACTIVE_MATCHED',identity:identityFixture,world:{worldId:'w2',sceneId:'s',worldGeneration:3,appliedSceneRevision:4,status:'ready'},snapshot:{sceneId:'s',revision:4},match:{status:'MATCHED',provider:'github',modelId:'x/y',revision:'pin',sceneId:'s',entityId:'r',worldId:'w2',worldGeneration:3,sceneRevision:4},executionStarted:false})})
  expect(activated).toBeUndefined()
 }finally{await act(async()=>root.unmount());dom.window.close()}
})

test('V8-17：只有当前实例/world/版本的真实匹配读回成立才显示 Applied，并引向实例控制',async()=>{
 const dom=installDom(),root=createRoot(document.getElementById('root')!)
 const matched=baseState({ready:true,applyEligible:true,modelId:identityFixture.modelId,evidence:{worldMatched:true,worldRunning:true,behaviorVerified:false},world:{worldId:'w',appliedSceneRevision:3,worldGeneration:2,status:'running'}})
  // load_state remains a compatibility readback; Applied requires a prior real ACTIVE_MATCHED binding.
  const appliedBinding={status:'ACTIVE_MATCHED',identity:identityFixture,world:{worldId:'w',sceneId:'s',appliedSceneRevision:3,worldGeneration:2,status:'running'},snapshot:{sceneId:'s',revision:3},match:{status:'MATCHED',provider:'github',modelId:'x/y',revision:'pin',sceneId:'s',entityId:'r',worldId:'w',worldGeneration:2,sceneRevision:3},executionStarted:false}
 const receipt=receiptFixture(matched)
 let opened=0
 const command=async(name:string)=>name==='policy_load_state'?matched:name==='policy_activate'?appliedBinding:{}
 const props=(over:Record<string,unknown>={})=>({available:true,canLoad:true,sceneId:'s',entityId:'r',worldId:'w',worldStatus:'running',expectedGeneration:2,expectedRevision:3,importReceipt:receipt,command,onOpenControls:()=>{opened+=1},tr:(_zh:string,en:string)=>en,...over})
 try{
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props() as never) as never))
  expect(document.querySelector('[data-testid="policy-applied"]')).toBeNull()
   const apply=document.querySelector<HTMLButtonElement>('[data-testid="policy-next"]')!
   expect(apply.textContent).toContain('Apply to instance')
   await act(async()=>apply.click())
   expect(document.querySelector('[data-testid="policy-applied"]')).not.toBeNull()
  // 不再把 Apply 当主动作。
  expect(document.querySelector('[data-testid="policy-next"]')).toBeNull()
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="policy-open-controls"]')!.click())
  expect(opened).toBe(1)
  // 代次变化：同一实例/世界但版本已变，必须重新 Check/Prepare/Apply。
  await act(async()=>root.render(createElement(PolicyLibraryPanel,props({expectedGeneration:5}) as never) as never))
  expect(document.querySelector('[data-testid="policy-applied"]')).toBeNull()
  expect(document.querySelector('[data-testid="policy-next"]')).not.toBeNull()
 }finally{await act(async()=>root.unmount());dom.window.close()}
})


// 桌面选择器既不 resolve 也不 reject 时，不能无限 Working：必须有界等待、给出原因、并露出本地路径输入。
test('文件选择器不响应时有界失败并改用本地路径输入', async () => {
  const {createElement} = await import('react')
  const {renderToStaticMarkup} = await import('react-dom/server')
  const {PolicyLibraryPanel} = await import('../src/policy-library-panel.tsx')
  const never = new Promise<string | undefined>(() => {})
  const html = renderToStaticMarkup(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, command: async () => ({}) as any,
    chooseFile: () => never, tr: (zh: string, en: string) => en,
  } as any))
  // 首屏仍然只有一条主路径入口；路径输入在卡住后才出现（chooserStalled），此处只钉住不会出现第二个主按钮。
  expect(html.includes('Import policy')).toBe(true)
})
