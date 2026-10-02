import {test,expect} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {importLocalPolicy} from '../src/local-policy-import.ts'
import {PolicyLibraryPanel} from '../src/policy-library-panel.tsx'
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
test('选择真实实例是导入前置；不支持JSON和缺实例都不派发',async()=>{
 const calls:string[]=[],ports={command:async(name:string)=>{calls.push(name);throw Error('不应派发')}}
 await expect(importLocalPolicy(ports,'/local/bundle.json',{})).rejects.toThrow('POLICY_ROBOT_SELECTION_REQUIRED')
 await expect(importLocalPolicy(ports,'/local/config.json',context)).rejects.toThrow('POLICY_FILE_FORMAT_UNSUPPORTED')
 expect(calls).toHaveLength(0)
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
