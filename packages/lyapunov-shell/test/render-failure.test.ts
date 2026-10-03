/** Viewer 失败/空场景实际展示与创建终态；DOM 使用已有私有 SDK 的 jsdom，不接用户世界。 */
import {expect,test} from 'bun:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {createRequire} from 'node:module'
import {WebGLUnavailableError} from '../../viewer/src/index.ts'
import {webglNotice} from '../src/environment-readiness.ts'
import {WEBGL_UNAVAILABLE_CODE,describeRenderFailure,isWebGLUnavailable} from '../src/render-failure.ts'
import {ViewerSurfaceState} from '../src/viewer-surface-state.tsx'
import {SceneCreationActions,createSceneFromTemplate,createSceneCreationAction,type SceneCreationPort} from '../src/scene-creation.tsx'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

const tr=(zh:string,_en:string)=>zh
const snapshot:SceneSnapshot={sceneId:'fixture-scene',revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[]}
const sdkRequire=createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json',import.meta.url))

async function inDOM(run:(host:HTMLElement,root:import('react-dom/client').Root,act:typeof import('react').act)=>Promise<void>){
 const {JSDOM}=sdkRequire('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 const old=new Map<string,PropertyDescriptor|undefined>()
 for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','Node','IS_REACT_ACT_ENVIRONMENT']){
  old.set(key,Object.getOwnPropertyDescriptor(globalThis,key))
  Object.defineProperty(globalThis,key,{value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key],configurable:true,writable:true})
 }
 const {createRoot}=await import('react-dom/client'),{act}=await import('react'),host=document.getElementById('root')!,root=createRoot(host)
 try{await run(host,root,act)}finally{
  await act(async()=>root.unmount());dom.window.close()
  for(const [key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key]}
 }
}

function creationPort(calls:string[]):SceneCreationPort{return {
 create:async template=>{calls.push('create:'+template);return snapshot},
 refresh:async()=>{calls.push('refresh')},
 load:async id=>{calls.push('load:'+id);return {scene:snapshot}},
}}

test('Viewer WebGL 类型错误保留 code、原始原因及无 cause 情况',()=>{
 const error=new WebGLUnavailableError(new Error('Error creating WebGL context'))
 expect(error).toBeInstanceOf(Error);expect(error.name).toBe('WebGLUnavailableError')
 expect(error.code).toBe(WEBGL_UNAVAILABLE_CODE);expect(error.message).toContain('Error creating WebGL context')
 expect(new WebGLUnavailableError().message).toContain(WEBGL_UNAVAILABLE_CODE)
})

test('WebGL 类型、code 与上下文报文均识别；其他失败保持通用分支',()=>{
 for(const value of [new WebGLUnavailableError(),{code:WEBGL_UNAVAILABLE_CODE},new Error('VIEWER_WEBGL_UNAVAILABLE: x'),new Error('WebGL context lost')])expect(isWebGLUnavailable(value)).toBe(true)
 for(const value of [new Error('SCENE_READ_ONLY'),new Error('resource 404'),undefined,{code:'SOMETHING_ELSE'}])expect(isWebGLUnavailable(value)).toBe(false)
})

test('WebGL 短说明与诊断原文分离，沿用环境契约错误码，不推断 GPU/驱动原因',()=>{
 const error=new WebGLUnavailableError(new Error('no adapter')),message=describeRenderFailure(error,tr)
 expect(message.title).toBe('3D 渲染不可用');expect(message.summary).toContain('WebGL')
 expect(message.summary.length).toBeLessThan(100)
 expect(message.diagnostic).toBe(error.message)
 expect(message.code).toBe(webglNotice({status:'broken',reading:'fixture'}).code)
 for(const text of [message.title,message.summary]){
  expect(text).not.toContain('no adapter');expect(text).not.toContain('浏览器设置');expect(text).not.toContain('重装驱动');expect(text).not.toContain('换机器')
 }
})

test('英文呈现不混中文，诊断保留引擎原文',()=>{
 const message=describeRenderFailure(new WebGLUnavailableError(new Error('原始原因')),(_zh,en)=>en)
 expect(message.title+' '+message.summary).not.toMatch(/[\u4e00-\u9fff]/)
 expect(message.diagnostic).toContain('原始原因');expect(message.summary).toContain('Retry')
})

test('通用初始化失败不会冒充 WebGL 或环境就绪',()=>{
 const message=describeRenderFailure(new Error('SCENE_READ_ONLY'),tr)
 expect(message.title).toBe('3D 渲染初始化失败');expect(message.code).toBe('VIEWER_INITIALIZATION_FAILED')
 expect(message.diagnostic).toBe('SCENE_READ_ONLY');expect(message.summary).not.toContain('WebGL')
})

test('真实 DOM：渲染失败排除空场景、导入浮层；详情折叠、可展开，Retry/Stop 可用',async()=>{
 await inDOM(async(host,root,act)=>{
  let retries=0,stops=0,creates=0
  const draw=(failure?:{cause:unknown})=>root.render(createElement(ViewerSurfaceState,{visible:true,failure,hasScene:false,available:true,tr,retry:()=>{retries++},stop:()=>{stops++},reopen:()=>{},create:()=>{creates++},children:createElement('div',{'data-testid':'canvas-child'},'导入控件')}))
  await act(async()=>draw({cause:new WebGLUnavailableError(new Error('<fixture diagnostic>'))}))
  expect(host.querySelector('[data-testid=viewer-render-failure]')?.getAttribute('role')).toBe('alert')
  expect(host.querySelector('[data-testid=scene-empty]')).toBeNull();expect(host.querySelector('[data-testid=canvas-child]')).toBeNull()
  expect(host.textContent).not.toContain('Start a scene');expect(host.textContent).not.toContain('创建物理工作区')
  const details=host.querySelector('details') as HTMLDetailsElement
  expect(details.open).toBe(false);expect(details.querySelector('pre')?.textContent).toContain('<fixture diagnostic>');expect(details.querySelector('fixture')).toBeNull()
  await act(async()=>{(details.querySelector('summary') as HTMLElement).click()});expect(details.open).toBe(true)
  const buttons=[...host.querySelectorAll('button')]
  await act(async()=>{buttons.find(button=>button.textContent==='重试 3D 画面')!.click();buttons.find(button=>button.textContent==='停止世界动作')!.click()})
  expect(retries).toBe(1);expect(stops).toBe(1);expect(creates).toBe(0)
  await act(async()=>draw())
  expect(host.querySelector('[data-testid=viewer-render-failure]')).toBeNull();expect(host.querySelector('[data-testid=scene-empty]')).not.toBeNull();expect(host.querySelector('[data-testid=canvas-child]')).not.toBeNull()
 })
})

test('真实 DOM：关闭 Viewer 排除错误/空场景，重开仍走已有回调',async()=>{
 await inDOM(async(host,root,act)=>{
  let opened=0
  await act(async()=>root.render(createElement(ViewerSurfaceState,{visible:false,failure:{cause:new WebGLUnavailableError()},hasScene:false,available:true,tr,retry:()=>{},reopen:()=>{opened++},create:()=>{},children:createElement('canvas')})))
  expect(host.querySelector('[data-testid=viewer-closed]')).not.toBeNull();expect(host.querySelector('[data-testid=viewer-render-failure]')).toBeNull();expect(host.querySelector('[data-testid=scene-empty]')).toBeNull();expect(host.querySelector('canvas')).toBeNull()
  await act(async()=>host.querySelector('button')!.click());expect(opened).toBe(1)
 })
})

test('已加载 Scene 不出现空引导；未选工作区禁止创建；成对入口共享忙态',()=>{
 const base={visible:true,available:true,tr,retry:()=>{},reopen:()=>{},create:()=>{},children:createElement('canvas')}
 expect(renderToStaticMarkup(createElement(ViewerSurfaceState,{...base,hasScene:true}))).not.toContain('scene-empty')
 const empty=renderToStaticMarkup(createElement(ViewerSurfaceState,{...base,hasScene:false,available:false}))
 expect(empty).toContain('先在左侧选择工作区');expect(empty.match(/disabled=""/g)).toHaveLength(2)
 const busy=renderToStaticMarkup(createElement('div',{},createElement(SceneCreationActions,{tr,disabled:false,busy:'physics-workspace',initial:true,create:()=>{}}),createElement(SceneCreationActions,{tr,disabled:false,busy:'physics-workspace',create:()=>{}})))
 expect(busy.match(/disabled=""/g)).toHaveLength(4);expect(busy.match(/aria-busy="true"/g)).toHaveLength(2);expect(busy.match(/正在创建/g)).toHaveLength(2)
})

test('真实创建回执：create → refresh → 同 Scene load 才返回终态',async()=>{
 const calls:string[]=[],port=creationPort(calls)
 expect(await createSceneFromTemplate(port,'blank')).toBe(snapshot)
 expect(calls).toEqual(['create:blank','refresh','load:fixture-scene'])
})

test('创建、刷新、载入任一失败均拒绝；不会跳过失败制造完成',async()=>{
 for(const phase of ['create','refresh','load'] as const){
  const calls:string[]=[],port=creationPort(calls)
  port[phase]=async()=>{calls.push('failed:'+phase);throw Error('fixture-'+phase)}
  await expect(createSceneFromTemplate(port,'physics-workspace')).rejects.toThrow('fixture-'+phase)
  expect(calls.at(-1)).toBe('failed:'+phase)
 }
})

test('创建后切换工作区不刷新、不载入旧会话结果',async()=>{
 const calls:string[]=[],port=creationPort(calls);let current=true
 port.isCurrent=()=>current;port.create=async()=>{calls.push('create');current=false;return snapshot}
 await expect(createSceneFromTemplate(port,'blank')).rejects.toThrow('SCENE_CREATION_SCOPE_CHANGED')
 expect(calls).toEqual(['create'])
})

test('已创建但载入未确认、载入了别的 Scene 都明确失败',async()=>{
 for(const scene of [undefined,{...snapshot,sceneId:'another-scene'}]){
  const port=creationPort([]);port.load=async()=>({scene})
  await expect(createSceneFromTemplate(port,'blank')).rejects.toThrow('SCENE_CREATION_NOT_LOADED: fixture-scene')
 }
})

test('两入口快速连续创建只发一份请求；失败后释放，并允许真正重试',async()=>{
 let calls=0,reject!:(value:Error)=>void
 const action=createSceneCreationAction(async()=>{calls++;return new Promise<SceneSnapshot>((_resolve,rejectTask)=>{reject=rejectTask})})
 const first=action('physics-workspace'),second=action('blank')
 expect(second).toBe(first);expect(calls).toBe(1)
 reject(Error('fixture create failed'));await expect(first).rejects.toThrow('fixture create failed')
 const retry=action('blank');expect(retry).not.toBe(first);expect(calls).toBe(2)
 reject(Error('fixture retry failed'));await expect(retry).rejects.toThrow('fixture retry failed')
})
