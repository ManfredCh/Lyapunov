/**
 * DEV-005 展示请求归属规则的局部测试：`bun test packages/lyapunov-shell/test/workbench-surface-scope.test.ts`。
 *
 * 测的是**判定规则本身**，不是复述源码：
 *  · 改页面级工作面的动作（共享布局偏好 store 与右侧栏标签）在后台窗口一律 `defer`——
 *    调用方不确认出队，请求留在队列里等窗口被切到前台（既不改前台工作面，也不丢请求）；
 *  · 只落在本会话自己场景/选中/窗口上的动作（selectScene、三条观察/相机动作）照常在后台可用，
 *    修复不能把会话私有的活也一起停掉（过度拒绝也是一种错）；
 *  · 宿主 `ui_action` 的动作枚举（`plugin.ts:189` 的 `uiActionNames`）逐个有明确归属：
 *    新加一个动作时这条用例会把它暴露出来，而不是让它默默按"可落地"处理。
 *
 * 边界：这是纯判定层的证据，**没有**起真实浏览器、没有真实 Agent 回合；真实前后台行为
 * （隐藏标签仍挂载、共享偏好不被后台改写）见回执 `bugfixHistory/DEV005-BACKGROUND-SURFACE-20260921.md`
 * 里 computer-use 的 URL + eval 原文 + 截图。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { surfaceDisposition } from "../src/workbench-ui.ts"
import {applyCameraNavigation,type CameraNavigationPorts} from '../src/camera-navigation-actions.ts'
import type {CameraAuthoringViewer} from '../src/camera-authoring.ts'
import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

/** 会改页面级工作面的动作（与 `workbench-ui.ts` 的 SURFACE_ACTIONS 同一份口径）。 */
const SURFACE = ["openTool", "showCanvas", "selectEntity", "focus", "enterSceneCenter", "openFiles", "openTerminal", "openResource", "exitCameraView", "aimCameraView", "locateTcp", "locateBase"]
/** 只落在本会话自己的场景/选中/窗口上的动作。 */
const SESSION_PRIVATE = ["selectScene", "captureViewer", "applyCameraViewer", "renderCameraViewer", "sampleCameraViewer"]

describe("后台窗口不得改页面级工作面（DEV-005）", () => {
  test("改共享布局偏好/右侧栏标签的动作：不可见窗口一律 defer，可见窗口 apply", () => {
    for (const action of SURFACE) {
      expect(`${action}:${surfaceDisposition(action, false)}`).toBe(`${action}:defer`)
      expect(`${action}:${surfaceDisposition(action, true)}`).toBe(`${action}:apply`)
    }
  })

  test("会话私有的动作照常落地：修复不能把后台会话自己的场景/选中/窗口一起停掉", () => {
    for (const action of SESSION_PRIVATE) {
      expect(`${action}:${surfaceDisposition(action, false)}`).toBe(`${action}:apply`)
      expect(`${action}:${surfaceDisposition(action, true)}`).toBe(`${action}:apply`)
    }
  })

  test("宿主 ui_action 的动作枚举逐个有明确归属（新动作不会默默按可落地处理）", () => {
    // 只读源码里的枚举字面量：它是宿主真正会排进队列的动作集合，前端规则必须覆盖到它。
    const plugin = readFileSync(join(import.meta.dirname, "..", "src", "plugin.ts"), "utf8")
    const literal = /const uiActionNames=\[([^\]]+)\]/.exec(plugin)?.[1] ?? ""
    const names = [...literal.matchAll(/"([A-Za-z]+)"/g)].map(match => match[1]!)
    expect(names.length).toBeGreaterThanOrEqual(SURFACE.length)
    // 枚举里的每个动作都必须落在"改页面级工作面"或"会话私有"两类的并集里：
    // 出现新动作时这里会红，逼着作者显式决定它的归属（而不是默认 apply）。
    const known = new Set([...SURFACE, ...SESSION_PRIVATE])
    expect(names.filter(name => !known.has(name))).toEqual([])
    // 枚举里属于页面级工作面的动作，后台窗口必须 defer。
    expect(names.filter(name => surfaceDisposition(name, false) === "defer").sort()).toEqual([...SURFACE].sort())
  })
})

/** 运行实际共享handler；只替换真实画布/共享UI端口，不能代GUI/原生marker签收。 */
describe('相机导航人工/NL同入口与前台归属',()=>{
 const scene:SceneSnapshot={sceneId:'scene',revision:1,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[{entityId:'arm',name:'arm',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},resources:[],components:{articulation:{}}}]}
 function fixture(){
  const calls:any[]=[],state={front:true,visible:true,viewer:undefined as Partial<CameraAuthoringViewer>|undefined,current:scene}
  state.viewer={exitCameraMode:options=>calls.push(['exit',options]),focusRobotAnchor:(entityId,kind)=>calls.push(['anchor',entityId,kind])}
  const ports:CameraNavigationPorts={clientId:'window-a',ownsSurface:()=>state.front,viewerVisible:()=>state.visible,viewer:()=>state.viewer,scene:()=>state.current,ui:{showCentre:value=>calls.push(['centre',value]),openTool:value=>calls.push(['tool',value])},selectEntity:value=>calls.push(['select',value])}
  return {calls,state,ports}
 }
 test('三个动作在后台不恢复/定位/抢焦点或改共享UI，前台之后仍能消费',()=>{
  for(const action of ['exitCameraView','locateTcp','locateBase']as const){
   const {calls,state,ports}=fixture();state.front=false
   expect(applyCameraNavigation({action,clientId:'window-a',sceneId:'scene',entityId:'arm'},ports)).toEqual({applied:false,disposition:'defer'});expect(calls).toEqual([])
   state.front=true;expect(applyCameraNavigation({action,clientId:'window-a',sceneId:'scene',entityId:'arm'},ports).applied).toBe(true);expect(calls.length).toBeGreaterThan(0)
  }
 })
 test('人工按钮与同目标NL动作通过同handler，退出恢复和聚焦参数明确',()=>{
  for(const action of ['exitCameraView','locateTcp','locateBase']as const){
   const manual=fixture(),natural=fixture()
   applyCameraNavigation({action,sceneId:'scene',entityId:'arm'},manual.ports)
   applyCameraNavigation({action,clientId:'window-a',sceneId:'scene',entityId:'arm'},natural.ports)
   expect(natural.calls).toEqual(manual.calls)
   if(action==='exitCameraView')expect(manual.calls).toEqual([['centre','canvas'],['exit',{restoreView:true,focus:true}]])
   else expect(manual.calls).toEqual([['centre','canvas'],['tool','robot'],['select','arm'],['anchor','arm',action==='locateTcp'?'tcp':'base']])
  }
 })
 test('前台也不能替另一个client消费，Scene错/未知实例/缺Viewer均拒绝',()=>{
  const {calls,state,ports}=fixture()
  expect(applyCameraNavigation({action:'locateTcp',clientId:'window-b',sceneId:'scene',entityId:'arm'},ports)).toEqual({applied:false,disposition:'foreign'});expect(calls).toEqual([])
  expect(()=>applyCameraNavigation({action:'locateTcp',sceneId:'other',entityId:'arm'},ports)).toThrow('SCENE_STALE');expect(calls).toEqual([])
  expect(()=>applyCameraNavigation({action:'locateTcp',sceneId:'scene',entityId:'missing'},ports)).toThrow('ENTITY_MISSING');expect(calls).toEqual([])
  state.viewer=undefined;expect(()=>applyCameraNavigation({action:'exitCameraView'},ports)).toThrow('VIEWER_UNAVAILABLE');expect(calls).toEqual([])
 })
 test('隐藏画布/缺统一API不假称退出，缺原生标记把失败保留到前台修复面板',()=>{
  const {calls,state,ports}=fixture();state.visible=false
  expect(()=>applyCameraNavigation({action:'exitCameraView'},ports)).toThrow('VIEWER_UNAVAILABLE');expect(calls).toEqual([])
  state.visible=true;state.viewer={};expect(()=>applyCameraNavigation({action:'exitCameraView'},ports)).toThrow('EXIT_UNSUPPORTED');expect(calls).toEqual([])
  state.viewer={focusRobotAnchor:()=>{throw Error('VIEWER_ROBOT_ANCHOR_UNAVAILABLE')}}
  expect(()=>applyCameraNavigation({action:'locateBase',entityId:'arm'},ports)).toThrow('ROBOT_ANCHOR_UNAVAILABLE')
  expect(calls).toEqual([['centre','canvas'],['tool','robot'],['select','arm']])
 })
})
