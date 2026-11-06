/**
 * 「人群」工具入口与面板：rail 新入口、Tabler walk 图标来源、ToolId 白名单、
 * crowd-panel SSR（世界状态/分组/计数/禁用原因/空态），以及 crowd-control 技能指针接线。
 */
import { test, expect, describe } from 'bun:test'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAIL_ENTRIES } from '../src/tool-rail.tsx'
import { WorkbenchIcon } from '../src/vendor/tabler/icons.tsx'
import { migrateToolId } from '../src/workbench-ui.ts'
import { CrowdPanel } from '../src/crowd-panel.tsx'
import { skillAvailable, planDomainPointers } from '../src/environment-routing.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SceneSnapshot } from '../../lyapunov-contracts/src/types.ts'

test('rail 在机器人之后有「人群」入口，ToolId/迁移白名单接受 crowd',()=>{
 const ids=RAIL_ENTRIES.map(e=>e.id)
 expect(ids.indexOf('crowd')).toBe(ids.indexOf('robot')+1)
 const entry=RAIL_ENTRIES.find(e=>e.id==='crowd')!
 expect(entry.zh).toBe('人群');expect(entry.en).toBe('Crowd');expect(entry.group).toBe('tool');expect(entry.behavior).toBe('tool')
 expect(migrateToolId('crowd')).toBe('crowd');expect(migrateToolId('not-a-tool')).toBe(null)
})

test('crowd 图标是 Tabler walk 原图：路径与 SOURCE.json 登记一致',()=>{
 const markup=renderToStaticMarkup(createElement(WorkbenchIcon,{id:'crowd',size:16}))
 const source=JSON.parse(readFileSync(join(import.meta.dirname,'../src/vendor/tabler/SOURCE.json'),'utf8'))
 expect(source.icons.crowd).toBe('walk')
 const paths=(markup.match(/d="([^"]+)"/g)??[]).map(m=>m.slice(3,-1))
 expect(paths).toEqual(source.iconSources.crowd.paths)
 expect(markup).toContain('data-icon="crowd"');expect(markup).toContain('data-icon-library="tabler"')
})

const T=(position:[number,number,number])=>({position,quaternion:[0,0,0,1]as[number,number,number,number],scale:[1,1,1]as[number,number,number]})
const person=(entityId:string,groupId?:string)=>({entityId,name:entityId,transform:T([0,0,0]),resources:[],components:{visual:{kind:'mesh'},human:{schema:1 as const,mode:'kinematic' as const,collision:'detailed' as const,source:{kind:'rigged-glb' as const,license:'MIT',sourceUpAxis:'Z' as const},heightM:1.75,phase:0,definition:{entityId:'def',resourceId:'r',version:1}},...(groupId?{humanGroup:{groupId}}:{})}})
const baseScene=(entities:SceneSnapshot['entities']):SceneSnapshot=>({sceneId:'s',revision:3,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities})as SceneSnapshot
const worldSynced={worldId:'w',sceneId:'s',engineId:'mujoco',engineVersion:'3.13',worldGeneration:2,appliedSceneRevision:3,status:'running' as const}
const frameOf=(motions:Record<string,object>)=>({worldId:'w',generation:2,sceneRevision:3,stepIndex:9,simTime:1,frameId:'f',entities:Object.entries(motions).map(([entityId,motion])=>({entityId,humanPose:{source:'mujoco-site',mode:'kinematic',simTime:1,stepIndex:9,joints:[],segments:[],motion}}))})as never
const noop={command:async()=>({}),onSaved:()=>{},sync:async()=>({}),tr:(zh:string,en:string)=>zh}
const props={...noop,disabled:false,chooseFile:undefined}

test('crowd 面板：分组行/状态计数/预设下拉/全部控制；未同步给出原因与同步按钮',()=>{
 const scene=baseScene([
  {entityId:'def',name:'角色',transform:T([0,0,0]),resources:[],components:{humanDefinition:{source:{kind:'rigged-glb'}}}},
  {entityId:'grp',name:'晨跑组',transform:T([0,0,0]),resources:[],components:{visual:{kind:'group'},humanGroup:{groupId:'g1'}}},
  person('p1','g1'),person('p2','g1'),person('solo'),
 ])
 const frame=frameOf({p1:{behavior:'walk',distanceM:1,yielded:false},p2:{behavior:'walk',distanceM:1,yielded:false,blockedByGeom:'wall',blockedS:.5},solo:{behavior:'stand',distanceM:0,yielded:false}})
 const html=renderToStaticMarkup(createElement(CrowdPanel,{...props,scene,world:worldSynced as never,frame}))
 expect(html).toContain('data-testid="crowd-panel"')
 expect(html).toContain('晨跑组');expect(html).toContain('其他人物')
 expect(html).toContain('行走 1');expect(html).toContain('停障 1')
 expect(html).toContain('行走 0');expect(html).toContain('停止 1')
 expect(html).toContain('全部开始');expect(html).toContain('全部停止')
 expect(html).toContain('来回走');expect(html).toContain('绕圈');expect(html).toContain('原地站立')
 expect(html).toContain('物理世界已同步')
 // 未同步：开始禁用并给原因，同步按钮可见
 const stale=renderToStaticMarkup(createElement(CrowdPanel,{...props,scene,world:{...worldSynced,appliedSceneRevision:1} as never,frame:undefined}))
 expect(stale).toContain('场景尚未同步到物理世界');expect(stale).toContain('同步物理世界');expect(stale).toContain('场景未同步到物理世界')
 // 无世界：禁用原因，空态/原因如实
 const none=renderToStaticMarkup(createElement(CrowdPanel,{...props,scene,world:undefined,frame:undefined}))
 expect(none).toContain('没有物理世界')
 // 无人场景空态
 const empty=renderToStaticMarkup(createElement(CrowdPanel,{...props,scene:baseScene([]),world:undefined,frame:undefined}))
 expect(empty).toContain('场景里还没有人物')
})

test('crowd-control 技能随包登记，行人/人群/绕圈请求注入该技能指针',()=>{
 expect(skillAvailable('crowd-control')).toBe(true)
 const skill=readFileSync(join(import.meta.dirname,'../skills/crowd-control/SKILL.md'),'utf8')
 expect(skill).toContain('name: crowd-control');expect(skill).toContain('crowd_start');expect(skill).toContain('HUMAN_ROUTE_PRESET_CONFLICT')
 expect(skill).toContain('timestepS');expect(skill).toContain('CURRENT');expect(skill).toContain('其中一组')
 const plugin=readFileSync(join(import.meta.dirname,'../src/plugin.ts'),'utf8')
 const crowdRow=plugin.indexOf('"crowd-control"'),actionRow=plugin.indexOf('"action-execution"',crowdRow)
 expect(crowdRow).toBeGreaterThan(-1);expect(actionRow).toBeGreaterThan(crowdRow)
 const pointer={skill:'crowd-control',label:'Crowd control',pattern:/行人|人群|绕圈|crowd|pedestrian/i}
 for(const text of['在当前场景创建 20 个行人，让他们各自来回走','让这组人群绕着自己起点走小方块','spawn a crowd of pedestrians']){
  const plan=planDomainPointers({pointers:[pointer],messages:[createUserMessage({content:[{type:'text',text}],source:{kind:'user'}} as never)]})
  expect(plan?.injected).toContain('crowd-control')
 }
})

test('运行中只禁用同范围「开始」：另一组开始/本组停止照常可用，返回后显示回执并解除',async()=>{
 const {JSDOM}=createRequire(new URL('../../../.upstream/deepseek-harness-0.2.0-rc.2/package.json',import.meta.url))('jsdom') as {JSDOM:new(h:string,o?:{url?:string})=>{window:Window&typeof globalThis}}
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid'})
 const saved=new Map<string,PropertyDescriptor|undefined>()
 for(const key of['window','document','HTMLElement','Node','navigator','localStorage','IS_REACT_ACT_ENVIRONMENT']){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:(dom.window as unknown as Record<string,unknown>)[key]})}
 const {createRoot}=await import('react-dom/client');const {act}=await import('react')
 const scene=baseScene([
  {entityId:'g1e',name:'甲组',transform:T([0,0,0]),resources:[],components:{visual:{kind:'group'},humanGroup:{groupId:'g1'}}},
  {entityId:'g2e',name:'乙组',transform:T([0,0,0]),resources:[],components:{visual:{kind:'group'},humanGroup:{groupId:'g2'}}},
  person('p1','g1'),person('p2','g2'),
 ])
 const resolvers:Array<()=>void>=[];const calls:string[]=[]
 const command=async(name:string,input:unknown)=>{calls.push(name);if(name==='crowd_start')await new Promise<void>(r=>resolvers.push(r));return{status:'completed'}}
 const root=createRoot(document.getElementById('root')!)
 const btn=(row:Element|null,t:string)=>[...((row??document).querySelectorAll('button'))].find(b=>(b.textContent||'').trim()===t)
 try{
  await act(async()=>root.render(createElement(CrowdPanel,{scene,world:worldSynced as never,frame:undefined,disabled:false,command:command as never,onSaved:()=>{},sync:async()=>({}),tr:(zh:string)=>zh} as never)))
  const r1=document.querySelector('[data-testid="crowd-group-g1"]'),r2=document.querySelector('[data-testid="crowd-group-g2"]')
  await act(async()=>btn(r1,'开始')!.click())
  // 同一范围：开始变「运行中…」且禁用；停止不被运行中阻塞
  expect(btn(r1,'运行中…')).toBeTruthy();expect(btn(r1,'运行中…')!.disabled).toBe(true)
  expect(btn(r1,'停止')!.disabled).toBe(false)
  // 另一组的开始照常可用并真实发出 crowd_start
  expect(btn(r2,'开始')!.disabled).toBe(false)
  await act(async()=>btn(r2,'开始')!.click())
  expect(calls.filter(n=>n==='crowd_start').length).toBe(2)
  // 全局开始也不受行 pending 阻塞
  expect(btn(null,'全部开始')!.disabled).toBe(false)
  await act(async()=>{for(const r of resolvers.splice(0))r();await new Promise(r=>setTimeout(r,10))})
  expect(btn(r1,'开始')).toBeTruthy();expect(btn(r1,'开始')!.disabled).toBe(false)
  expect(document.body.textContent).toContain('动作已结束')
 }finally{
  await act(async()=>root.unmount());dom.window.close()
  for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key)}
 }
})

test('countCrowdStarts 只计在途 crowd_start，resolve/reject 均归零且原样透传',async()=>{
 const {countCrowdStarts}=await import('../src/crowd-panel.tsx')
 const running={current:0},seen:string[]=[],deferred:Array<(e?:Error)=>void>=[]
 const command=(name:string,input:unknown)=>{seen.push(name);return name==='crowd_start'?new Promise((res,rej)=>deferred.push(e=>e?rej(e):res(name))):Promise.resolve(name)}
 const wrapped=countCrowdStarts(command,running)
 const a=wrapped('crowd_start',{a:1}),b=wrapped('crowd_start',{a:2}),c=wrapped('crowd_stop',{x:1})
 expect(running.current).toBe(2)
 deferred[0]!();await a
 expect(running.current).toBe(1)
 deferred[1]!(new Error('STOP_CONFIRMED'))
 await expect(b).rejects.toThrow('STOP_CONFIRMED')
 expect(running.current).toBe(0)
 await expect(c).resolves.toBe('crowd_stop')
 expect(seen).toEqual(['crowd_start','crowd_start','crowd_stop'])
})
