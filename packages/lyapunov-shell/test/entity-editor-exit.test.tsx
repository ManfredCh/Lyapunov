/** 使用现成SDK jsdom、真实React组件和临时SceneStore/CAS；不接触产品窗口或物理引擎。 */
import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {SceneStore} from '../../scene-kit/src/store.ts'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {SCENE_COORDINATES,identityTransform,type SceneSnapshot,type SceneCommit} from '../../lyapunov-contracts/src/types.ts'
import {ExitCoordinator,ExitParticipants,type ExitFailureAction} from '../../desktop/src/exit-coordinator.ts'

const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))
async function fixture(surface=false){
 const {JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<div id="root"></div><div id="app-side-panel"></div>',{url:'http://fixture.invalid'})
 const previous=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){
  previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})
 }
 const React=await import('react'),{createRoot}=await import('react-dom/client'),{Simulate}=await import('react-dom/test-utils'),{EntityEditor}=await import('../src/entity-editor.tsx'),{WorkSurface}=await import('../src/work-surface.tsx'),{useWorkbenchUI}=await import('../src/workbench-ui.ts'),{appSidePanelHost}=await import('../src/app-side.ts')
 const directory=await mkdtemp(join(tmpdir(),'entity-exit-')),store=new SceneStore(directory),participants=new ExitParticipants(),rootHost=document.getElementById('root')!,root=createRoot(rootHost),host=surface?document.body:rootHost
 const previousPanelHost=appSidePanelHost.current;if(surface)appSidePanelHost.current=document.getElementById('app-side-panel')
 let snapshot:SceneSnapshot={sceneId:'s',revision:0,coordinates:SCENE_COORDINATES,entities:[{entityId:'a',name:'original-a',transform:identityTransform(),resources:[],components:{}},{entityId:'b',name:'original-b',transform:identityTransform(),resources:[],components:{}}]}
 const operations=new SceneOperations(directory);await operations.create({sceneId:'s'});snapshot=await operations.scene.commit({sceneId:'s',expectedRevision:0,patch:snapshot.entities.map(entity=>({op:'add' as const,entity}))})
 const writes:SceneCommit[]=[],bridge={registerExitParticipant:(id:string,p:Parameters<ExitParticipants['register']>[1])=>participants.register(id,p)}
 let selected='a',commitGate:(input:SceneCommit)=>Promise<void>=async()=>{}
 const commit=async(input:SceneCommit)=>{writes.push(structuredClone(input));await commitGate(input);snapshot=await store.commit(input);draw();return snapshot}
 const editor=(revision:number)=>React.createElement(EntityEditor,{sceneId:snapshot.sceneId,revision,entity:snapshot.entities.find(row=>row.entityId===selected)!,entities:snapshot.entities,tr:(_zh:string,en:string)=>en,commit,exitBridge:bridge,exitId:'entity-editor:test'})
 let selectedAvailable=true
 function SurfaceHarness({revision}:{revision:number}){
  const ui=useWorkbenchUI(),state=ui.getSnapshot()
  return React.createElement(React.Fragment,null,
   React.createElement('button',{onClick:()=>ui.openTool('object')},'Object'),
   React.createElement('button',{onClick:()=>ui.openTool('scene')},'Scene'),
   React.createElement('button',{onClick:()=>ui.closeTool()},'Close panel'),
   React.createElement(WorkSurface,{sessionId:'fixture',tr:(_zh:string,en:string)=>en,renderSlot:((name:string,props:any)=>name==='lyapunov.workbench.session'?props.children:null) as any,centre:null,panel:state.tool==='object'?React.createElement('div',{'data-testid':'physics-transient'},'normal physics controls'):React.createElement('div',null,'Scene content'),retainedPanel:selectedAvailable?{tool:'object',children:editor(revision)}:undefined,deliverables:null}),
  )
 }
 const draw=(revision=snapshot.revision)=>root.render(surface?React.createElement(SurfaceHarness,{revision}):editor(revision))
 await React.act(async()=>draw())
 const name=()=>host.querySelector('input[aria-label="Entity name"]') as HTMLInputElement
 const edit=async(value:string)=>{await React.act(async()=>{Simulate.change(name(),{target:{value}} as any)})}
 const close=async()=>{await React.act(async()=>root.unmount());await rm(directory,{recursive:true,force:true});appSidePanelHost.current=previousPanelHost;dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}}
 return {React,Simulate,host,root,store,participants,writes,name,edit,close,draw,select:(id:string)=>{selected=id},snapshot:()=>snapshot,external:async(input:SceneCommit)=>{snapshot=await store.commit(input);await React.act(async()=>draw())},gate:(run:typeof commitGate)=>{commitGate=run},selectionAvailable:(available:boolean)=>{selectedAvailable=available}}
}
function exits(f:Awaited<ReturnType<typeof fixture>>,failed:()=>Promise<ExitFailureAction|void>=async()=>undefined){
 const states:boolean[]=[],summaries:Array<unknown>=[],calls:string[]=[]
 const coordinator=new ExitCoordinator({summary:()=>f.participants.summary(),confirm:async value=>{summaries.push(value);return true},flush:async()=>{calls.push('flush');await f.participants.flush()},stop:async()=>{calls.push('stop');await f.participants.stop()},close:async()=>{calls.push('close')},exit:(_origin,force)=>{calls.push(force?'force-exit':'exit')},failed,stateChanged:state=>states.push(state),shutdownTimeoutMs:100})
 return {coordinator,states,summaries,calls}
}

test('未点提交的真实属性稿进入退出汇总，保存沿原Scene CAS且重开磁盘事实',async()=>{
 const f=await fixture()
 try{
  expect(await f.participants.summary()).toEqual({dirtyDrafts:0,runningActions:0,participants:1})
  await f.edit('draft-saved-a');expect(f.host.textContent).toContain('Unsaved draft');expect(f.writes).toHaveLength(0)
  expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  const e=exits(f);let result:Awaited<ReturnType<ExitCoordinator['request']>>|undefined
  await f.React.act(async()=>{result=await e.coordinator.request('window')})
  expect(result).toMatchObject({decision:'closed',cleanup:'confirmed'});expect(e.summaries[0]).toMatchObject({dirtyDrafts:1})
  expect(f.writes).toEqual([{sceneId:'s',expectedRevision:1,patch:[{op:'update',entityId:'a',changes:{name:'draft-saved-a'}}]}])
  const reopened=await new SceneStore(f.store.directory).snapshot('s')
  expect(reopened.revision).toBe(2);expect(reopened.entities[0]!.name).toBe('draft-saved-a');expect((await f.store.version('s',1)).entities[0]!.name).toBe('original-a')
  expect(JSON.parse(await readFile(f.store.path('s'),'utf8'))).toEqual(reopened)
  expect((await f.participants.summary()).dirtyDrafts).toBe(0);expect(e.calls).toEqual(['flush','stop','close','exit'])
 }finally{await f.close()}
})
test('真实外部CAS冲突保留属性稿，返回可编辑，重试后显式强退不覆盖新版本',async()=>{
 const f=await fixture()
 try{
  await f.edit('unsaved-local')
  await f.external({sceneId:'s',expectedRevision:1,patch:[{op:'update',entityId:'a',changes:{name:'external-owner'}}]})
  expect(f.name().value).toBe('unsaved-local');expect(f.host.textContent).toContain('based on rev 1')
  let choice:ExitFailureAction='return',failures=0
  const e=exits(f,async()=>{failures++;return choice});let result:Awaited<ReturnType<ExitCoordinator['request']>>|undefined
  await f.React.act(async()=>{result=await e.coordinator.request('window')})
  expect(result).toMatchObject({decision:'failed'});expect(e.states).toEqual([true,false]);expect(e.calls).toEqual(['flush']);expect(e.coordinator.approved).toBe(false)
  expect(f.name().disabled).toBe(false);expect(f.name().value).toBe('unsaved-local');expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  await f.edit('unsaved-after-return');expect(f.name().value).toBe('unsaved-after-return')
  choice='retry';const report=async()=>{failures++;return failures===2?'retry' as const:'force' as const}
  const retry=exits(f,report)
  await f.React.act(async()=>{result=await retry.coordinator.request('window')})
  expect(result).toMatchObject({decision:'closed',cleanup:'incomplete'});expect(retry.calls).toEqual(['flush','flush','stop','close','force-exit'])
  expect(f.writes.map(input=>input.expectedRevision)).toEqual([1,1,1])
  const persisted=await f.store.snapshot('s');expect(persisted.revision).toBe(2);expect(persisted.entities[0]!.name).toBe('external-owner');expect((await f.participants.summary()).dirtyDrafts).toBe(1)
 }finally{await f.close()}
})
test('已有提交在途时退出等待同一Promise，原CAS和关闭各一次',async()=>{
 const f=await fixture()
 try{
  await f.edit('one-in-flight');let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve});f.gate(()=>gate)
  await f.React.act(async()=>{f.Simulate.click([...f.host.querySelectorAll('button')].find(row=>row.textContent==='Apply edit')!);await Promise.resolve()})
  expect(f.writes).toHaveLength(1);expect(f.name().disabled).toBe(true)
  const e=exits(f);let pending!:Promise<Awaited<ReturnType<ExitCoordinator['request']>>>
  await f.React.act(async()=>{pending=e.coordinator.request('window');await Promise.resolve();await Promise.resolve()})
  expect(f.writes).toHaveLength(1)
  let result:Awaited<typeof pending>|undefined
  await f.React.act(async()=>{release();result=await pending})
  expect(result).toMatchObject({decision:'closed',cleanup:'confirmed'});expect(f.writes).toHaveLength(1);expect(e.calls.filter(value=>value==='close')).toHaveLength(1)
  expect((await f.store.snapshot('s')).entities[0]!.name).toBe('one-in-flight')
 }finally{await f.close()}
})
test('切换实体保留原DraftMap归属，迟到保存不覆盖新选择；卸载只注销自身',async()=>{
 const f=await fixture()
 try{
  const other=f.participants.register('other',{summary:()=>({dirtyDrafts:0,runningActions:0}),flush:async()=>{}})
  await f.edit('saved-a-after-switch');let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve});f.gate(()=>gate)
  await f.React.act(async()=>{f.Simulate.click([...f.host.querySelectorAll('button')].find(row=>row.textContent==='Apply edit')!);await Promise.resolve()})
  await f.React.act(async()=>{f.select('b');f.draw()})
  expect(f.name().value).toBe('original-b');expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  await f.React.act(async()=>{release();await f.participants.flush()})
  expect(f.name().value).toBe('original-b');expect((await f.store.snapshot('s')).entities[0]!.name).toBe('saved-a-after-switch')
  expect((await f.participants.summary()).dirtyDrafts).toBe(0)
  await f.React.act(async()=>f.root.unmount());expect((await f.participants.summary()).participants).toBe(1);other()
 }finally{await f.close()}
})
test('干净属性不触发保存，无效版本不伪装零草稿',async()=>{
 const f=await fixture()
 try{
  const e=exits(f);let result:Awaited<ReturnType<ExitCoordinator['request']>>|undefined
  await f.React.act(async()=>{result=await e.coordinator.request('window')})
  expect(result).toMatchObject({decision:'closed',cleanup:'confirmed'});expect(f.writes).toHaveLength(0);expect(e.calls).toEqual(['stop','close','exit'])
  await f.React.act(async()=>f.draw(-1))
  await expect(f.participants.summary()).rejects.toThrow('ENTITY_DRAFT_STATUS_UNKNOWN')
 }finally{await f.close()}
})

test('切换选择未提交的缓存稿仍在原owner汇总，退出保存原实体而非当前选择',async()=>{
 const f=await fixture()
 try{
  await f.edit('cached-a-not-submitted')
  await f.React.act(async()=>{f.select('b');f.draw()})
  expect(f.name().value).toBe('original-b');expect(f.writes).toHaveLength(0);expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  const e=exits(f);let result:Awaited<ReturnType<ExitCoordinator['request']>>|undefined
  await f.React.act(async()=>{result=await e.coordinator.request('window')})
  expect(result).toMatchObject({decision:'closed',cleanup:'confirmed'});expect(f.writes).toHaveLength(1);expect(f.writes[0]!.patch).toEqual([{op:'update',entityId:'a',changes:{name:'cached-a-not-submitted'}}])
  expect(f.name().value).toBe('original-b');expect((await f.store.snapshot('s')).entities[0]!.name).toBe('cached-a-not-submitted');expect((await f.participants.summary()).dirtyDrafts).toBe(0)
 }finally{await f.close()}
})


test('真实WorkSurface切Object到Scene或关闭只隐藏唯一editor，退出仍保存原CAS稿',async()=>{
 const f=await fixture(true)
 try{
  const click=async(text:string)=>{await f.React.act(async()=>{f.Simulate.click([...f.host.querySelectorAll('button')].find(row=>row.textContent===text)!)})}
  await click('Object');await f.edit('dirty-across-tools')
  const originalNode=f.name();expect((await f.participants.summary()).participants).toBe(1)
  await click('Scene')
  expect(f.name()).toBe(originalNode);expect(f.name().closest('[hidden]')).not.toBeNull();expect(f.name().closest('[inert]')).not.toBeNull()
  expect((f.name().closest('[hidden]') as HTMLElement).style.display).toBe('none');expect(f.host.querySelectorAll('.lya-property-editor')).toHaveLength(1)
  expect(f.host.querySelector('[data-testid="physics-transient"]')).toBeNull();expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  await click('Close panel');expect(f.name()).toBe(originalNode);expect(f.host.querySelectorAll('.lya-wb-panel')).toHaveLength(1)
  expect((f.host.querySelector('.lya-wb-panel') as HTMLElement).hidden).toBe(true);expect((await f.participants.summary()).dirtyDrafts).toBe(1)
  // 真实场景刷新短暂取消选择时仍保留同一个原编辑器owner，不能清零未提交稿。
  await f.React.act(async()=>{f.selectionAvailable(false);f.draw()})
  expect((await f.participants.summary()).dirtyDrafts).toBe(1);expect(f.name()).toBe(originalNode)
  const e=exits(f);let result:Awaited<ReturnType<ExitCoordinator['request']>>|undefined
  await f.React.act(async()=>{result=await e.coordinator.request('window')})
  expect(result).toMatchObject({decision:'closed',cleanup:'confirmed'});expect(f.writes).toHaveLength(1)
  const reopened=await new SceneStore(f.store.directory).snapshot('s');expect(reopened.entities[0]!.name).toBe('dirty-across-tools')
  await f.React.act(async()=>{f.selectionAvailable(true);f.draw()});await click('Object')
  expect(f.name()).toBe(originalNode);expect(f.name().value).toBe('dirty-across-tools');expect(f.name().closest('[hidden]')).toBeNull();expect((await f.participants.summary()).dirtyDrafts).toBe(0)
 }finally{await f.close()}
})
