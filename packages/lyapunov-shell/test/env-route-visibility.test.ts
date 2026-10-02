/**
 * ENV-58/53/54：Host 只读路由投影保留，日常工作台移除内部诊断的离线契约。
 *
 * 2026-09-30 用户明确要求日常工作台不再显示“环境路由/局部计划”等内部诊断。
 * 客户端两行 footer、专用状态与 4 秒投影轮询因此移除；Host 的会话级快照、判定和
 * 模型上下文注入仍保持。这里分别守住 Host 原语义、客户端诊断不显示/不轮询、
 * 场景清单带外刷新仍可用。源码契约不替代发行窗口的实际 UI 验收。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {SceneCreationActions,createSceneFromTemplate,type SceneCreationTemplate} from '../src/scene-creation.tsx'
import {SceneWorldLifecycle,type SceneWorldPort} from '../src/scene-world-lifecycle.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

const shell = join(import.meta.dirname, '../src')
const plugin = readFileSync(join(shell, 'plugin.ts'), 'utf8')
const workbench = readFileSync(join(shell, 'workbench.tsx'), 'utf8')
const routing = readFileSync(join(shell, 'environment-routing.ts'), 'utf8')

test('host 侧：只读 GET 路由 + 会话级快照，且不改判定语义', () => {
  expect(plugin).toContain('const routeDecisions=new Map<string,')
  expect(plugin).toContain('register("route-decision",["GET"]')
  expect(plugin).toContain('routeDecisions.get(sessionKey)??null')
  // 快照只从判定结果里取既有字段，不新增判定
  expect(plugin).toContain('stage:plan.decision.stage')
  expect(plugin).toContain('word:plan.decision.intent.word??null')
  expect(plugin).toContain('evidence:plan.decision.evidence')
  expect(plugin).toContain('injected:plan.injected')
  expect(plugin).toContain('why:plan.decision.hints.map(hint=>hint.why)')
  // 当前建议仍来自同一plan；原生消费者验证替换/clear，源码面守同owner和未变不追加。
  expect(plugin).toContain('const pointerText=plan?.text??')
  expect(plugin).toContain('pointerText!==previous')
  expect(plugin).toContain('text:pointerText')
  expect(plugin).toContain('kind:"lyapunov-domain-pointer",form:"snapshot"')
  expect(plugin).toContain('messages.some(isUserIntent)&&previous!==undefined?cleared:undefined')
  // 授权状态独立为notice，不能随下一份能力建议替换掉。
  expect(plugin).toContain('plugin:"lyapunov-engine-install",form:"notice"')
  // 判定文件本身没有被改动过的痕迹（本轮只读它的输出）
  expect(routing).toContain('export function routeEnvironment(')
})

test('客户端：两内部诊断footer及专用状态/投影轮询已移除', () => {
  expect(workbench).not.toContain('data-testid="lyapunov-route-decision"')
  expect(workbench).not.toContain('data-testid="lyapunov-route-local-why"')
  expect(workbench).not.toContain('"环境路由："')
  expect(workbench).not.toContain('"局部计划："')
  expect(workbench).not.toContain('setRouteDecision')
  expect(workbench).not.toContain('"route-decision"')
  expect(workbench).not.toContain('setInterval(()=>void read(),4000)')
})

test('场景清单刷新：双template和初次空CTA共用实际create→refresh→load，blank不请求物理', async() => {
  expect(workbench).toContain('const timer=setInterval(read,3000)')
  expect(workbench).toContain('data-testid="lyapunov-scene-select"')
  expect(workbench).toContain("createSceneFromTemplate({create:chosen=>api.command<SceneSnapshot>('scene_create',{template:chosen}),refresh:refreshScenes,load:loadScene},template)")
  for(const template of ['physics-workspace','blank']as const){
   const calls:string[]=[],snapshot:SceneSnapshot={sceneId:template,revision:0,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:template==='blank'?[]:[{entityId:'ground',name:'ground',resources:[],components:{collision:{shape:'box',halfExtents:[1,1,.05]}},transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]}}],physics:{gravityWorldMps2:[0,0,-9.81],template:template==='blank'?'blank':'physics-workspace-v1'}}
   const lifecycle=new SceneWorldLifecycle(()=>{}),sim:SceneWorldPort={list:async()=>{calls.push('list');return []},reconcile:async scene=>{calls.push('reconcile');return {snapshot:scene,pending:false,issues:[]}},open:async()=>{calls.push('open');return {worldId:'owned',sceneId:template,worldGeneration:1,appliedSceneRevision:0,engineId:'isaac',engineVersion:'test',status:'ready'}},observe:async()=>({worldId:'owned',generation:1,sceneRevision:0,frameId:'owned:1:0',stepIndex:0,simTime:0,entities:[],worldStatus:'ready'}),close:async()=>calls.push('close')}
   const created=await createSceneFromTemplate({create:async choice=>{calls.push('create:'+choice);return snapshot},refresh:async()=>calls.push('refresh'),load:async id=>{calls.push('load:'+id);await lifecycle.ensure('owned-session','host',snapshot,sim)}},template)
   expect(created).toBe(snapshot);expect(calls.slice(0,3)).toEqual(['create:'+template,'refresh','load:'+template]);expect(calls.filter(c=>c==='reconcile')).toHaveLength(template==='blank'?0:1);expect(calls.filter(c=>c==='open')).toHaveLength(template==='blank'?0:1)
  }
  const clicks:SceneCreationTemplate[]=[],props={create:(value:SceneCreationTemplate)=>clicks.push(value),disabled:false,tr:(cn:string)=>cn,initial:true}
  const html=renderToStaticMarkup(createElement(SceneCreationActions,props));expect(html).toContain('创建物理工作区');expect(html).toContain('空白制作');expect(clicks).toEqual([])
  const buttons=SceneCreationActions(props).props.children;buttons[0].props.onClick();buttons[1].props.onClick();expect(clicks).toEqual(['physics-workspace','blank'])
  // 既有「刷新」按钮仍在
  expect(workbench).toContain('onClick={()=>perform(refreshScenes)}')
})
