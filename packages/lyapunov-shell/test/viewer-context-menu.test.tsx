import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement,act} from 'react'
import {createRoot} from 'react-dom/client'
import {ViewerContextMenu,writeViewerReference} from '../src/viewer-context-menu.tsx'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
const scene:SceneSnapshot={sceneId:'scene/a',revision:4,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'entity-a',name:'同名资产',transform:{position:[1,2,3],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[{resourceId:'resource-exact',version:8,original:{uri:'lyapunov://registered/original.glb',mimeType:'model/gltf-binary'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}],components:{}}]}
test('真实文件引用保完整实体、资源版本与来源，写后读回失败拒绝，不退成名称文本',async()=>{
 let stored:any;const ref=await writeViewerReference('session-a',scene,'entity-a',async(action,input:any)=>{if(action==='write'){stored=input;return {path:input.path,version:'v1'}}return {...stored,version:'v1'}})
 expect(ref.source).toBe('reference');expect(ref.ref).toMatch(/^@lyapunov-selection-.*\.json$/);expect(ref.clipboardText).toBe(ref.ref)
 const doc=JSON.parse(stored.content);expect(doc.sceneRevision).toBe(4);expect(doc.entity).toEqual(scene.entities[0]);expect(doc.entity.resources[0].version).toBe(8)
 await expect(writeViewerReference('session-a',scene,'missing',async()=>{})).rejects.toThrow('ENTITY_MISSING')
 await expect(writeViewerReference('session-a',scene,'entity-a',async(action,input:any)=>action==='write'?{path:input.path,version:'v1'}:{path:input.path,version:'v2',content:stored.content})).rejects.toThrow('READBACK_MISMATCH')
})
test('真实菜单DOM中英两个动作、键盘导航与Escape关闭，点击只交原回调',async()=>{
 const req=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url)),{JSDOM}=req('jsdom'),dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true})
 const saved=new Map<string,PropertyDescriptor|undefined>();for(const key of ['window','document','HTMLElement','Node','navigator']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]})}
 const root=createRoot(document.getElementById('root')!),request={clientX:120,clientY:100,sceneId:'scene/a',sceneRevision:4,entityId:'entity-a',annotate:()=>{}}
 let adds=0,annotations=0,closes=0
 try{
  for(const english of [false,true]){await act(async()=>root.render(createElement(ViewerContextMenu,{request,tr:(zh,en)=>english?en:zh,addToChat:()=>adds++,annotate:()=>annotations++,close:()=>closes++})));const buttons=[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];expect(buttons.map(b=>b.textContent)).toEqual(english?['Add to chat','Annotate']:['添加到聊天','批注']);expect(document.activeElement).toBe(buttons[0]);document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));expect(document.activeElement).toBe(buttons[1]);buttons[0]!.click();buttons[1]!.click();document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}))}
  expect(adds).toBe(2);expect(annotations).toBe(2);expect(closes).toBe(2)
  const {SessionInputShell}=await import(new URL('../../../.upstream/deepseek-harness-20260911-candidate/packages/client/ui-conversation/src/client/input/facade.ts',import.meta.url).href)
  const {Context}=await import('@deepseek-ai/cordis')
  const shell=new SessionInputShell({actx:new Context(),defaultSink:async()=>({kind:'sent'} as never),commandAttachments:{serialize:async()=>[],release:()=>{},unsupportedNotice:()=>''}})
  try{
   const reference={source:'reference',ref:'@lyapunov-selection-native.json',label:'同名资产',appearance:'file' as const,clipboardText:'@lyapunov-selection-native.json'}
   expect(shell.insertReference(reference,shell.actions.captureInsertion())).toBe(true)
   const state=shell.state.getSnapshot();expect(state.occurrences.length).toBe(1);expect(state.occurrences[0]?.ref).toBe(reference.ref);expect(state.draft).toContain(reference.ref)
   const stale=shell.actions.captureInsertion();shell.setDraft('后续用户编辑');expect(shell.insertReference(reference,stale)).toBe(false);expect(shell.state.getSnapshot().draft).toBe('后续用户编辑')
  }finally{shell.dispose()}

 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else delete (globalThis as any)[key]}}
})


test('发行客户端纯grammar叶经真实ClientModuleSystem加载，不依赖不存在的grammar模块表',async()=>{
 const {nativeClientLeafPlugin}=await import('../../../script/terminal-build.ts')
 const {ClientModuleSystem}=await import(new URL('../../../.upstream/deepseek-harness-20260911-candidate/packages/client/modules/src/client/system.ts',import.meta.url).href)
 const react=await import('react'),jsx=await import('react/jsx-runtime')
 const entry=new URL('../src/viewer-context-menu.tsx',import.meta.url).pathname
 const load=async(inline:boolean)=>{
  const result=await Bun.build({entrypoints:[entry],target:'browser',format:'cjs',external:['@deepseek-ai/*','react','react/jsx-runtime'],plugins:inline?[nativeClientLeafPlugin()]:[],define:{'process.env.NODE_ENV':JSON.stringify('production')}})
  if(!result.success)throw new AggregateError(result.logs,'真实Viewer引用客户端构建失败')
  const text=await result.outputs[0]!.text(),target:any={mode:'queue',pendingQueue:[],load(registration:any){this.pendingQueue.push(registration)}}
  const loader=new ClientModuleSystem({manifest:{rev:'fixture',modules:[],plugins:[]},staticModules:{react,'react/jsx-runtime':jsx},bootstrapModule:{id:'@deepseek-ai/dsh-client-modules',exports:{}},registrationTarget:target})
  target.load({id:'@lyapunov/viewer-reference',factory:new Function('require','var module={exports:{}};var exports=module.exports;'+text+';return module.exports;')})
  return {loader,mod:await loader.import('@lyapunov/viewer-reference')}
 }
 await expect(load(false)).rejects.toThrow('dsh-file-reference/grammar')
 const {loader,mod}=await load(true);let stored:any
 const reference=await mod.writeViewerReference('session-a',scene,'entity-a',async(action:string,input:any)=>action==='write'?(stored=input,{path:input.path,version:'v1'}):{...stored,version:'v1'})
 expect(reference.ref).toMatch(/^@lyapunov-selection-.*\.json$/)
 expect(loader.loadCache.get('@lyapunov/viewer-reference')!.edges.has('@deepseek-ai/dsh-file-reference/grammar')).toBe(false)
 // 检查正常build-plugins产物；不能只让此局部fixture使用正确resolver而遗漏真正发行入口。
 const {readFile}=await import('node:fs/promises'),built=await readFile(new URL('../dist/client.js',import.meta.url),'utf8')
 expect(built).not.toMatch(/require\(["']@deepseek-ai\/dsh-file-reference\/grammar["']\)/)
})
