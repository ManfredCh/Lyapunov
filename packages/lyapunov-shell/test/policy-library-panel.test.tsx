import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {PolicyLibraryPanel,policyPanelAction,policyPrepareArgs,policyCategoryLabels} from '../src/policy-library-panel.tsx'
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
 expect(result.entry).toEqual(entry);expect(result.failure.code).toBe('POLICY_WORLD_BINDING_MISMATCH');expect(result.failure.message).toContain('策略已登记')
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
 const result=await policyPanelAction({command:async(name,input)=>{calls.push({name,input});return name==='policy_activate'?{status:'ACTIVE_MATCHED',identity,world:{worldId:'new',worldGeneration:2},snapshot:{sceneId:'s',revision:5},executionStarted:false}:{category:'direct_execution',ready:true,evidence:{behaviorVerified:false}}}},'activate',{identity,sceneId:'s',entityId:'selected',expectedRevision:4,worldId:'old',expectedGeneration:1})
 expect(calls[0]!.name).toBe('policy_activate');expect(calls[0]!.input.expectedRevision).toBe(4);expect(calls[1]!.input.worldId).toBe('new');expect(calls[1]!.input.expectedGeneration).toBe(2);expect(result.result.executionStarted).toBe(false);expect(result.state.evidence.behaviorVerified).toBe(false)
})
test('Go1/Go2裸文件准备读完整缓存，不传G123专属weightsPath',()=>{
 for(const modelId of ['Improbable-AI/walk-these-ways','inria-paris-robotics-lab/go2_onnx_controller']){
  const args=policyPrepareArgs({identity:{provider:'github',modelId,revision:'pin'},filePath:'/chosen/model.onnx',sceneId:'s',entityId:'r',localSource:{prepareFrom:'cache'}})
  expect(args).not.toHaveProperty('weightsPath');expect(args).not.toHaveProperty('localSource');expect(args).toMatchObject({sceneId:'s',entityId:'r',modelId})
 }
})
test('本体按钮只取asset，不因策略runtime预检阻断本体或翻整包许可',async()=>{
 const calls:Array<{name:string;input:any}>=[]
 const result=await policyPanelAction({command:async(name,input)=>{calls.push({name,input});return name==='policy_download_bundle'?{status:'ASSET_DOWNLOADED',modelPath:'/verified/body.xml',source:{provider:'github',modelId:'fixed/source',resolvedRevision:'pin'},assetBytesVerified:true,fullBundleReady:false,policyPrepared:false}:{category:'missing_files_or_runtime',ready:false}}},'asset',{modelId:'unitree_g1_23dof_75obs'})
 expect(calls.map(c=>c.name)).toEqual(['policy_download_bundle']);expect(calls[0]!.input.pieces).toEqual(['asset']);expect(result.result.fullBundleReady).toBe(false);expect(result.result.policyPrepared).toBe(false);expect(result.state).toBeUndefined()
 const html=renderToStaticMarkup(<PolicyLibraryPanel available canLoad={false} canLoadAsset sceneId="s" command={async()=>{throw Error('SSR不得请求')}} onAssetLoaded={async()=>{}} tr={cn=>cn}/>);expect(html).toContain('仅下载本体并载入');expect(html).toContain('XML与依赖')
})
