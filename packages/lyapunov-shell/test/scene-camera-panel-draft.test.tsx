/**
 * R-005 回归：显式选择 body 与手动位姿必须是用户草稿 owner。
 *
 * 真实缺陷：`chooseBody` 曾把 draftMode 置为 `current-view`，随后任一字段编辑会重新采样当前画面，
 * 轮询/推荐效应也可能把 wrist_3_link 覆盖回推荐连杆；主保存再走 `current-view` 重采样，
 * 结果 Scene/Recording 源是 wrist_1_link 和原位姿。这里用真 React + 真 DOM 走完整 UI 流程，
 * 锁住“UI 保存前值 = RPC 输入 = 草稿”，并在世界读回刷新后仍不覆写。
 */
import {test, expect} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement, act, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {commandRouteResponse} from '../../lyapunov-contracts/src/command-privacy.ts'

const {SceneCameraPanel,useNativeCameraList} = await import('../src/scene-camera-panel.tsx')
const {LidarScanPanel} = await import('../src/lidar-scan-panel.tsx')

const tr = (_zh: string, en: string) => en
const K = {fx: 600, fy: 600, cx: 80, cy: 60, width: 160, height: 120}
const body = (bodyName: string) => ({entityId: 'robot', bodyName, worldFromBody: {positionM: [0, 0, 1], quaternionXyzw: [0, 0, 0, 1]}, frameId: 'f1', stepIndex: 5})
const bodies = [body('wrist_1_link'), body('wrist_3_link')]
const sample = () => ({
  sceneId: 's', sceneRevision: 7, worldId: 'w', generation: 3, frameId: 'f1', stepIndex: 5,
  view: {position: [1, 2, 3], quaternion: [0, 0, 0, 1], target: [0, 0, 1], navigation: 'orbit'} as never,
  camera: {projection: 'perspective', position: [1, 2, 3], quaternion: [0, 0, 0, 1], intrinsics: K, imageWidth: 160, imageHeight: 120, near: 0.01, far: 100} as never,
  bodies,
})

function withDom(run: (root: ReturnType<typeof createRoot>, flush: (ms?: number) => Promise<void>) => Promise<void>) {
  return async () => {
    const {JSDOM} = createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json', import.meta.url))('jsdom') as {JSDOM: new (html: string, options?: {url?: string; pretendToBeVisual?: boolean}) => {window: Window & typeof globalThis}}
    const dom = new JSDOM('<div id="root"></div>', {url: 'http://fixture.invalid', pretendToBeVisual: true})
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'HTMLSelectElement', 'HTMLInputElement', 'Node', 'navigator', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'KeyboardEvent']) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      const raw = (dom.window as unknown as Record<string, unknown>)[key]
      const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : typeof raw === 'function' && key.includes('AnimationFrame') ? (raw as (...args: unknown[]) => unknown).bind(dom.window) : raw
      Object.defineProperty(globalThis, key, {configurable: true, value})
    }
    saved.set('ResizeObserver', Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'))
    Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: class {observe() {} disconnect() {}}})
    ;(dom.window as unknown as {HTMLElement: {prototype: Record<string, unknown>}}).HTMLElement.prototype.attachEvent = () => {}
    ;(dom.window as unknown as {HTMLElement: {prototype: Record<string, unknown>}}).HTMLElement.prototype.detachEvent = () => {}
    const root = createRoot(document.getElementById('root')!)
    const flush = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
    try { await run(root, flush) }
    finally {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
    }
  }
}

const setValue = (element: Element, value: string) => {
  // 直接调用 React 挂在节点上的真实 onChange（仍走产品 handler），避免同进程其它 jsdom 测试留下的
  // React IE value-change 兜底状态干扰原生 input 事件；判据是产品行为，不是事件派发细节。
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  const props = key ? (element as unknown as Record<string, {onChange?: (event: {target: Element}) => void}>)[key] : undefined
  if (!props?.onChange) throw new Error('no React onChange handler on element')
  const proto = Object.getPrototypeOf(element) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto) as object, 'value')!.set!
  setter.call(element, value)
  props.onChange({target: element})
}

function renderPanel(root: ReturnType<typeof createRoot>, receipt: any, saves: any[], overrides: {scene?: any; saveInstallation?: (input: any) => Promise<{snapshot: any; entityId: string}>} = {}) {
  const scene = overrides.scene ?? {sceneId: 's', revision: 7, coordinates: {units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw'}, entities: [{entityId: 'robot', name: 'ur10e', transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {articulation: {}}}]}
  const world = {worldId: 'w', sceneId: 's', worldGeneration: 3, appliedSceneRevision: 7, status: 'running', engineId: 'mujoco', timestepS: 0.005, clock: 'manual'}
  const api = {clientId: 'c', request: async () => ({cameras: []}), command: async () => ({}), mediaURL: () => 'about:blank'} as never
  const perform = (fn: () => Promise<unknown>) => void fn().catch(() => undefined)
  return act(async () => root.render(createElement(SceneCameraPanel, {
    api, scene, world, receipt, error: undefined, readOnly: false, tr, perform,
    commit: async () => scene, sampleCurrent: sample,
    saveInstallation: overrides.saveInstallation ?? (async (input: any) => { saves.push(input); return {snapshot: scene, entityId: 'cam-1'} }),
    pilot: () => {}, aim: () => {}, returnView: () => {}, piloted: undefined, selectCamera: () => {},
    selectedRobotEntityId: 'robot', prepareWorld: async () => world, worldState: undefined, sceneSpecs: [], refresh: async () => undefined, scope: 'mounted',
  } as never)))
}

test('新建相机的 Lens 取 Scene 默认 640×480，不继承采样画布 160×120', withDom(async (root, flush) => {
 const saves: any[] = []
 await renderPanel(root, {worldId: 'w', sceneId: 's', sceneRevision: 7, generation: 3, frameId: 'f1', stepIndex: 5, bodies: bodies.map(row => ({...row, worldId: 'w', generation: 3, sceneRevision: 7})), cameras: []}, saves)
 await flush()
 const panel = document.querySelector('[data-testid="robot-camera-panel"]')!
 await act(async () => [...panel.querySelectorAll('button')].find(button => button.textContent === 'Add camera to this robot')!.click())
 await flush()
 const lens = panel.querySelector('[data-testid="camera-lens"]') as HTMLDetailsElement
 expect(lens).not.toBeNull()
 expect(lens.querySelector('summary')!.textContent).toContain('640 × 480')
 lens.open = true
 expect((panel.querySelector('input[aria-label="Camera width px"]') as HTMLInputElement).value).toBe('640')
 expect((panel.querySelector('input[aria-label="Camera height px"]') as HTMLInputElement).value).toBe('480')
}))

test('R-005：显式选 wrist_3_link 后手填位姿，主保存用 draft 原值且不被推荐连杆覆写', withDom(async (root, flush) => {
  const saves: any[] = []
  await renderPanel(root, {worldId: 'w', sceneId: 's', sceneRevision: 7, generation: 3, frameId: 'f1', stepIndex: 5, bodies: bodies.map(row => ({...row, worldId: 'w', generation: 3, sceneRevision: 7})), cameras: []}, saves)
  await flush()
  const panel = document.querySelector('[data-testid="robot-camera-panel"]')!
  // 先给机器人添加挂载相机：自动推荐连杆随后由用户显式改为 wrist_3_link。
  await act(async () => (panel.querySelector('button[aria-label],button') && [...panel.querySelectorAll('button')].find(button => button.textContent === 'Add camera to this robot')!.click()))
  await flush()
  // V8-19：局部姿态与镜头是具名折叠；真实用户先展开再编辑。
  await act(async () => { (panel.querySelector('[data-testid="camera-local-pose"]') as HTMLDetailsElement).open = true; (panel.querySelector('[data-testid="camera-lens"]') as HTMLDetailsElement).open = true })
  const select = panel.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement
  await act(async () => setValue(select, 'wrist_3_link'))
  await flush()
  // 手动填写完整表单（模拟 Playwright 的真实流程）。
  const name = panel.querySelector('input[aria-label="Scene camera name"]') as HTMLInputElement
  const position = panel.querySelector('input[aria-label="Camera position XYZ m"]') as HTMLInputElement
  const quaternion = panel.querySelector('input[aria-label="Camera rotation xyzw"]') as HTMLInputElement
  const width = panel.querySelector('input[aria-label="Camera width px"]') as HTMLInputElement
  const height = panel.querySelector('input[aria-label="Camera height px"]') as HTMLInputElement
  await act(async () => setValue(name, 'qa-wrist-camera'))
  await act(async () => setValue(position, '0 0 0.2'))
  await act(async () => setValue(quaternion, '0 0 0 1'))
  await act(async () => setValue(width, '160'))
  await act(async () => setValue(height, '120'))
  await flush()
  // 世界读回刷新（轮询）不得把草稿覆写回推荐连杆。
  await flush(20)
  expect(name.value).toBe('qa-wrist-camera')
  expect(position.value).toBe('0 0 0.2')
  expect(quaternion.value).toBe('0 0 0 1')
  expect(width.value).toBe('160')
  expect(height.value).toBe('120')
  const save = panel.querySelector('[data-testid="camera-save"]') as HTMLButtonElement
  expect(save).toBeDefined()
  await act(async () => save.click())
  await flush()
  expect(saves).toHaveLength(1)
  expect(saves[0].mode).toBe('draft')
  expect(saves[0].draft.parentEntityId).toBe('robot')
  expect(saves[0].draft.bodyName).toBe('wrist_3_link')
  expect(saves[0].draft.position).toBe('0 0 0.2')
  expect(saves[0].draft.quaternion).toBe('0 0 0 1')
  expect(saves[0].draft.width).toBe('160')
  expect(saves[0].draft.height).toBe('120')
}))

test('R-005：显式“Save current-view installation”仍按当前画面采样（语义不被主保存改动影响）', withDom(async (root, flush) => {
  const saves: any[] = []
  await renderPanel(root, {worldId: 'w', sceneId: 's', sceneRevision: 7, generation: 3, frameId: 'f1', stepIndex: 5, bodies: bodies.map(row => ({...row, worldId: 'w', generation: 3, sceneRevision: 7})), cameras: []}, saves)
  await flush()
  const panel = document.querySelector('[data-testid="robot-camera-panel"]')!
  await act(async () => [...panel.querySelectorAll('button')].find(button => button.textContent === 'Add camera to this robot')!.click())
  await flush()
  const select = panel.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement
  await act(async () => setValue(select, 'wrist_3_link'))
  await flush()
  // V8-19：当前画面安装收在 More / Installation details；先展开，再点真实保存入口。
  const more = panel.querySelector('[data-testid="camera-installation-more"]') as HTMLDetailsElement
  await act(async () => { more.open = true })
  const save = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Save current-view installation') as HTMLButtonElement
  await act(async () => save.click())
  await flush()
  expect(saves).toHaveLength(1)
  expect(saves[0].mode).toBe('current-view')
  expect(saves[0].mount).toEqual({entityId: 'robot', bodyName: 'wrist_3_link'})
}))

/**
 * P19 R-005：保存回执先走**产品实际 UI 投影**（`commandRouteResponse`/`uiCommandFields`），
 * 再喂给真 React Panel。断点现场（receipts/p13-live/R-005-R-006-1792165007593）里投影把
 * `camera.mount` 清掉，Panel 保存后就显示成 "Save world camera"/Mount entity=World camera。
 * 本用例锁住：投影保住的 mount 让 Panel 再次选择与恢复都仍是同一条机器人连杆。
 */
const projectedWristSaveScene = () => {
  const mount = {entityId: 'robot', bodyName: 'wrist_3_link', positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1]}
  const camera = {name: 'qa-wrist-camera', fovYDeg: 50, width: 160, height: 120, near: 0.001, far: 100, intrinsics: K, isActive: true, mount, installation: {source: 'manual', baseline: {positionM: [0, 0, 0.2], quaternionXyzw: [0, 0, 0, 1], mount, fovYDeg: 50, width: 160, height: 120, near: 0.001, far: 100, intrinsics: K}}}
  const snapshot = {sceneId: 's', revision: 7, coordinates: {units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw'}, entities: [
    {entityId: 'robot', name: 'ur10e', transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {articulation: {}}},
    {entityId: 'cam-1', name: 'qa-wrist-camera', transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [], components: {camera}},
  ]}
  const receipt = {status: 'SAVED', snapshot, entityId: 'cam-1', source: 'manual', worldNeedsSync: true, note: 'Installation saved in Scene.'}
  return commandRouteResponse('camera_scene_save', {kind: 'success', text: JSON.stringify(receipt)}, 'formal').ui!.snapshot as any
}

test('V10 Camera Back 同时清除 Viewer 相机选择，返回清单后不被旧视锥选择重新打开', withDom(async(root,flush)=>{
 const scene=projectedWristSaveScene(),before=JSON.stringify(scene),events:Array<string|undefined>=[]
 const world={worldId:'w',sceneId:'s',worldGeneration:3,appliedSceneRevision:7,status:'running',engineId:'mujoco'}
 const api={clientId:'c',request:async()=>({cameras:[]}),command:async()=>({}),mediaURL:()=> 'about:blank'}
 function Host(){
  const [selected,setSelected]=useState<string>()
  return createElement(SceneCameraPanel,{api,scene,world,receipt:{cameras:[],bodies},readOnly:false,tr,perform:(fn:()=>Promise<unknown>)=>void fn(),commit:async()=>scene,sampleCurrent:sample,saveInstallation:async()=>({snapshot:scene,entityId:'cam-1'}),pilot:()=>{},returnView:()=>{},selectCamera:(key:string|undefined)=>{events.push(key);setSelected(key?.split('/')[0])},selectedCameraEntityId:selected,selectedRobotEntityId:'robot',prepareWorld:async()=>world,sceneSpecs:[],refresh:async()=>undefined,scope:'mounted'} as never)
 }
 await act(async()=>root.render(createElement(Host)))
 await flush()
 await act(async()=>{(document.querySelector('[data-testid="camera-mounted-scene-cam-1"]') as HTMLButtonElement).click()})
 await flush()
 expect(document.querySelector('[data-testid="camera-detail-header"]')).not.toBeNull()
 await act(async()=>{(document.querySelector('[data-testid="camera-back-to-list"]') as HTMLButtonElement).click()})
 await flush(30)
 expect(events.at(-1)).toBeUndefined()
 expect(document.querySelector('[data-testid="camera-mounted-list"]')).not.toBeNull()
 expect(document.querySelector('[data-testid="camera-detail-header"]')).toBeNull()
 expect(JSON.stringify(scene)).toBe(before)
}))

test('P19 R-005：保存回执经真实UI投影后，Panel 仍显示所选机器人/wrist_3_link 与局部位姿/分辨率', withDom(async (root, flush) => {
  const projected = projectedWristSaveScene()
  // 投影层保住了真实安装，后面测的才是"Panel 不再把它误认成世界相机"。
  expect((projected.entities[1].components as any).camera.mount).toBeTruthy()
  expect((projected.entities[1].components as any).camera.installation.baseline.mount).toBeTruthy()
  const saves: any[] = []
  const saveInstallation = async (input: any) => { saves.push(input); return {snapshot: projected, entityId: 'cam-1'} }
  await renderPanel(root, {worldId: 'w', sceneId: 's', sceneRevision: 7, generation: 3, frameId: 'f1', stepIndex: 5, bodies: bodies.map(row => ({...row, worldId: 'w', generation: 3, sceneRevision: 7})), cameras: []}, saves, {scene: projected, saveInstallation})
  await flush()
  const panel = document.querySelector('[data-testid="robot-camera-panel"]')!
  expect(panel.textContent).toContain('real mounted cameras 1')
  // 再次选择这份已保存的挂载相机：draft 从文档里的 mount 恢复（不是世界相机）。
  // V9-19：默认清单只给机位行；选中后先看摘要，编辑才铺外参/镜头表单。
  const cameraButton = panel.querySelector('[data-testid="camera-mounted-scene-cam-1"]') as HTMLButtonElement
  expect(cameraButton).not.toBeNull()
  await act(async () => cameraButton.click())
  await flush()
  // V8-20：已保存机位是同栏详情；清单/计数/Add 不在详情里同时展开。
  expect(panel.querySelector('[data-testid="camera-detail-header"]')).not.toBeNull()
  expect(panel.querySelector('.lya-camera-subhead-title')!.textContent).toBe('qa-wrist-camera')
  expect(panel.querySelector('[data-testid="camera-mounted-list"]')).toBeNull()
  expect(panel.querySelector('[data-testid="camera-robot-picker"]')).toBeNull()
  expect([...panel.querySelectorAll('button')].some(button => button.textContent === 'Add camera to this robot')).toBe(false)
  // V9 返修：主摘要与“录制该机位”在折叠外；表单与诊断收起。
  const summary = panel.querySelector('[data-testid="camera-summary"]')!
  expect(summary.closest('details')).toBeNull()
  expect([...panel.querySelectorAll('button')].some(button => button.textContent === 'Record this camera')).toBe(true)
  expect(panel.querySelector('[data-testid="camera-save"]')).toBeNull()
  await act(async () => (panel.querySelector('[data-testid="camera-edit-entry"]') as HTMLButtonElement).click())
  await flush()
  await act(async () => { (panel.querySelector('[data-testid="camera-local-pose"]') as HTMLDetailsElement).open = true; (panel.querySelector('[data-testid="camera-lens"]') as HTMLDetailsElement).open = true })
  const mountLocation = panel.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement
  expect(mountLocation.value).toBe('wrist_3_link')
  // mounted scope 的机器人是当前实例（固定展示），不再出现 World/Infinite ground 的下拉。
  expect(panel.querySelector('[data-testid="camera-mounted-robot"]')!.textContent).toContain('ur10e')
  expect(panel.querySelector('select[aria-label="Mount entity"]')).toBeNull()
  expect(panel.querySelector('[data-testid="camera-save"]')).not.toBeNull()
  expect((panel.querySelector('input[aria-label="Camera position XYZ m"]') as HTMLInputElement).value).toBe('0 0 0.2')
  expect((panel.querySelector('input[aria-label="Camera rotation xyzw"]') as HTMLInputElement).value).toBe('0 0 0 1')
  expect((panel.querySelector('input[aria-label="Camera width px"]') as HTMLInputElement).value).toBe('160')
  expect((panel.querySelector('input[aria-label="Camera height px"]') as HTMLInputElement).value).toBe('120')
  // 同版本轮询刷新不得把挂载覆写成世界相机。
  await flush(20)
  expect((panel.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement).value).toBe('wrist_3_link')
  expect(panel.querySelector('[data-testid="camera-save"]')).not.toBeNull()
  // 恢复安装基线：读同一份 installation.baseline.mount，恢复后仍是同一条 body。
  const restore = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Restore installation baseline') as HTMLButtonElement
  expect(restore.disabled).toBe(false)
  await act(async () => restore.click())
  await flush()
  expect(saves.at(-1)?.mode).toBe('restore')
  expect(saves.at(-1)?.entityId).toBe('cam-1')
  // 保存/恢复回执后回到摘要，仍显示同一条机器人连杆（不是 World camera）。
  expect(panel.querySelector('[data-testid="camera-summary"]')!.textContent).toContain('wrist_3_link')
  // Back 回机器人机位清单后才重新出现 Add；详情内不常驻清单/添加。
  expect(panel.querySelector('[data-testid="camera-back-to-list"]')).not.toBeNull()
  await act(async () => (panel.querySelector('[data-testid="camera-back-to-list"]') as HTMLButtonElement).click())
  await flush()
  expect(panel.querySelector('[data-testid="camera-mounted-list"]')).not.toBeNull()
  expect([...panel.querySelectorAll('button')].some(button => button.textContent === 'Add camera to this robot')).toBe(true)
}))

type CameraPending = {path: string; input: any; signal: AbortSignal; resolve: (value: any) => void; reject: (reason: unknown) => void}
const cameraButton = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
const liveCheckbox = () => document.querySelector('[aria-label="Selected camera live preview"]') as HTMLInputElement
const nativeImage = () => document.querySelector('img[alt="Selected camera native image"]') as HTMLImageElement | null
const cameraBusy = () => document.body.textContent!.includes('Capturing camera image')

function previewHarness(root: ReturnType<typeof createRoot>) {
  const scene = projectedWristSaveScene()
  const second = structuredClone(scene.entities[1]); second.entityId = 'cam-2'; second.name = 'Second camera'; second.components.camera.name = 'Second camera'
  scene.entities.push(second)
  const world = {worldId: 'w', sceneId: 's', worldGeneration: 3, appliedSceneRevision: 7, status: 'running', engineId: 'mujoco'}
  const identity = {sceneId: 's', sceneRevision: 7, worldId: 'w', worldGeneration: 3}
  const receipt = {...identity, bodies, cameras: scene.entities.slice(1).map((entity: any) => ({entityId: entity.entityId, cameraName: `${entity.entityId}/${entity.components.camera.name}`, available: true, intrinsics: K, worldFromCamera: {positionM: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1]}}))}
  const pending: CameraPending[] = [], errors: string[] = [], tasks: Promise<unknown>[] = []
  const api = {clientId: 'preview-window', sessionId: 'session', request: (path: string, options: any) => new Promise((resolve, reject) => pending.push({path, input: JSON.parse(options.body), signal: options.signal, resolve, reject})), mediaURL: (path: string, query: any) => `/media/${path}/${query.captureId}/${query.sensor ?? ''}`}
  let props: any = {api, scene, world, receipt, readOnly: false, tr, perform: (fn: () => Promise<unknown>) => {const task = fn(); tasks.push(task); void task.catch(error => errors.push(String(error)))}, commit: async () => scene, sampleCurrent: sample, saveInstallation: async () => ({snapshot: scene, entityId: 'cam-1'}), pilot: () => {}, returnView: () => {}, selectCamera: () => {}, selectedRobotEntityId: 'robot', prepareWorld: async () => world, sceneSpecs: [], refresh: async () => undefined, scope: 'mounted'}
  const render = async (patch: any = {}) => {props = {...props, ...patch}; await act(async () => root.render(createElement(SceneCameraPanel, props)))}
  const choose = async (id = 'cam-1') => {await act(async () => cameraButton(`camera-mounted-scene-${id}`).click())}
  const imageReceipt = (request: CameraPending, id: string) => ({...identity, sceneId: request.input.sceneId, sceneRevision: request.input.sceneRevision, worldId: request.input.worldId, worldGeneration: request.input.expectedGeneration, captureId: id, frameId: id, stepIndex: 5, cameras: [{cameraName: request.input.cameraNames[0], rgb: {}, depth: null}]})
  return {scene, world, receipt, identity, api, pending, errors, tasks, render, choose, imageReceipt}
}

async function nativePreviewHarness(root: ReturnType<typeof createRoot>) {
  const h = previewHarness(root)
  const native = {...h.receipt.cameras[0], entityId: 'robot', cameraName: 'robot/native-eye', localName: 'Native eye', parentBodyName: 'wrist_3_link', cameraSource: 'mjcf'}
  const {usableCameraSpec} = await import('../src/capture-panel.tsx')
  const originalSpec = usableCameraSpec(native)!
  const setNative = async (patch: any = {}, staleProjection = false) => {
    const row = {...native, ...patch}, spec = usableCameraSpec(row)
    await h.render({receipt: {...h.receipt, cameras: [...h.receipt.cameras, row]}, sceneSpecs: staleProjection ? [originalSpec] : spec ? [spec] : []})
  }
  await setNative()
  await act(async () => cameraButton('camera-mounted-native-robot/native-eye').click())
  await act(async () => cameraButton('camera-compare-open').click())
  return {...h, native, setNative}
}

test('task10：原生尺寸往返立即释放Refresh，旧失败不清新busy，轮询不换owner', withDom(async root => {
  const h = await nativePreviewHarness(root)
  await act(async () => cameraButton('compare-refresh').click())
  await h.setNative({intrinsics: {...K, width: 320, height: 240}})
  expect(h.pending[0]!.signal.aborted).toBe(true)
  expect(cameraButton('compare-refresh').disabled).toBe(false)
  await act(async () => cameraButton('compare-refresh').click())
  expect(h.pending[1]!.input.width).toBe(320)
  expect(h.pending[1]!.input.height).toBe(240)
  await h.setNative()
  expect(h.pending[1]!.signal.aborted).toBe(true)
  await act(async () => cameraButton('compare-refresh').click())
  await h.setNative({intrinsics: {...K}, worldFromCamera: {positionM: [2, 3, 4], quaternionXyzw: [0, 0, 0, 1]}})
  expect(h.pending).toHaveLength(3)
  expect(h.pending[2]!.signal.aborted).toBe(false)
  await act(async () => h.pending[0]!.reject(Error('OLD_SIZE_FAILURE')))
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'old-large')))
  expect(h.errors).toEqual([])
  expect(cameraButton('compare-refresh').disabled).toBe(true)
  expect(nativeImage()).toBeNull()
  await act(async () => h.pending[2]!.resolve(h.imageReceipt(h.pending[2]!, 'new-small')))
  expect(cameraButton('compare-refresh').disabled).toBe(false)
  expect(document.body.textContent).toContain('new-small')
}))

test('task10：尺寸变更作废等待相机的Scan，迟到成功不再发LiDAR', withDom(async root => {
  const h = await nativePreviewHarness(root)
  await act(async () => cameraButton('compare-scan').click())
  await h.setNative({intrinsics: {...K, width: 320, height: 240}})
  expect(cameraButton('compare-scan').disabled).toBe(false)
  await act(async () => cameraButton('compare-scan').click())
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'old-small')))
  expect(h.pending.map(row => row.path)).toEqual(['camera-preview', 'camera-preview'])
  expect(cameraButton('compare-scan').disabled).toBe(true)
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'new-large')))
  expect(h.pending.map(row => row.path)).toEqual(['camera-preview', 'camera-preview', 'camera-lidar'])
  await act(async () => h.pending[2]!.resolve({...h.identity, cameraName: h.native.cameraName, captureId: 'new-scan', frameId: 'new-large', stepIndex: 5}))
  expect(cameraButton('compare-scan').disabled).toBe(false)
  expect(document.querySelector('[data-testid="frame-verdict"]')?.getAttribute('data-status')).toBe('same-frame')
  expect(document.body.textContent).not.toContain('old-small')
  expect(document.querySelector('[data-testid="compare-sensor-details"]')).not.toBeNull()
  await h.setNative()
  expect(document.querySelector('[data-testid="compare-sensor-details"]')).toBeNull()
  expect(document.querySelector('[data-testid="compare-capture-identity"]')).toBeNull()
  expect(nativeImage()).toBeNull()
}))

test('task10：尺寸变化清除已钉住图与当前错误，也中止已发出的LiDAR', withDom(async root => {
  const h = await nativePreviewHarness(root)
  await act(async () => cameraButton('compare-refresh').click())
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'pinned-small')))
  await act(async () => cameraButton('compare-refresh').click())
  await act(async () => h.pending[1]!.reject(Error('CURRENT_SIZE_FAILURE')))
  expect(document.body.textContent).toContain('CURRENT_SIZE_FAILURE')
  await h.setNative({intrinsics: {...K, width: 320, height: 240}})
  expect(nativeImage()).toBeNull()
  expect(document.body.textContent).not.toContain('pinned-small')
  expect(document.body.textContent).not.toContain('CURRENT_SIZE_FAILURE')
  await act(async () => cameraButton('compare-scan').click())
  await act(async () => h.pending[2]!.resolve(h.imageReceipt(h.pending[2]!, 'scan-camera')))
  expect(h.pending[3]!.path).toBe('camera-lidar')
  await h.setNative()
  expect(h.pending[3]!.signal.aborted).toBe(true)
  expect(cameraButton('compare-scan').disabled).toBe(false)
  await act(async () => h.pending[3]!.reject(Error('OLD_LIDAR_FAILURE')))
  expect(h.errors).toEqual(['Error: CURRENT_SIZE_FAILURE'])
  expect(document.body.textContent).not.toContain('scan-camera')
}))

for (const [reason, patch] of [['引擎拒绝', {available: false}], ['缺K', {intrinsics: undefined}], ['缺位姿', {worldFromCamera: undefined}]] as const) {
  test(`task10：${reason}不借旧投影采集，清pin并作废等待Scan，恢复后可重试`, withDom(async root => {
    const h = await nativePreviewHarness(root)
    await act(async () => cameraButton('compare-refresh').click())
    await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'pinned-before-unavailable')))
    await act(async () => cameraButton('compare-scan').click())
    await h.setNative(patch, true)
    expect(h.pending[1]!.signal.aborted).toBe(true)
    expect(nativeImage()).toBeNull()
    expect(document.body.textContent).not.toContain('pinned-before-unavailable')
    expect(cameraButton('compare-refresh').disabled).toBe(true)
    expect(cameraButton('compare-scan').disabled).toBe(true)
    expect(cameraBusy()).toBe(false)
    await h.setNative()
    expect(cameraButton('compare-scan').disabled).toBe(false)
    await act(async () => cameraButton('compare-scan').click())
    await act(async () => h.pending[1]!.reject(Error('OLD_AVAILABILITY_FAILURE')))
    expect(h.pending.map(row => row.path)).toEqual(['camera-preview', 'camera-preview', 'camera-preview'])
    expect(cameraButton('compare-scan').disabled).toBe(true)
    expect(h.errors).toEqual([])
    await act(async () => h.pending[2]!.resolve(h.imageReceipt(h.pending[2]!, 'available-again')))
    expect(h.pending[3]!.path).toBe('camera-lidar')
    await act(async () => h.pending[3]!.resolve({...h.identity, cameraName: h.native.cameraName, captureId: 'available-scan'}))
    expect(cameraButton('compare-scan').disabled).toBe(false)
  }))
}

test('task10：缺图回执显式失败不发LiDAR，重试成功且不吞当前错误', withDom(async root => {
  const h = await nativePreviewHarness(root)
  await act(async () => cameraButton('compare-scan').click())
  await act(async () => h.pending[0]!.resolve({...h.imageReceipt(h.pending[0]!, 'missing-image'), cameras: []}))
  expect(h.errors[0]).toContain('CAMERA_PREVIEW_IMAGE_MISSING')
  expect(document.body.textContent).toContain('CAMERA_PREVIEW_IMAGE_MISSING')
  expect(cameraButton('compare-scan').disabled).toBe(false)
  expect(h.pending).toHaveLength(1)
  await act(async () => cameraButton('compare-scan').click())
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'retried-image')))
  expect(h.pending[2]!.path).toBe('camera-lidar')
  await act(async () => h.pending[2]!.resolve({...h.identity, cameraName: h.native.cameraName, captureId: 'retried-scan'}))
  expect(document.body.textContent).not.toContain('CAMERA_PREVIEW_IMAGE_MISSING')
}))

test('task10：相机入口返回undefined结束本次Scan，无相机入口的LiDAR-only仍独立成功', withDom(async root => {
  const h = previewHarness(root)
  const base: any = {api: h.api, scene: h.scene, world: h.world, identity: h.identity, ready: true, cameraName: 'robot/lidar-only', tr, perform: (fn: () => Promise<unknown>) => void fn().catch(error => h.errors.push(String(error)))}
  await act(async () => root.render(createElement(LidarScanPanel, {...base, captureCamera: async () => undefined})))
  await act(async () => cameraButton('compare-scan').click())
  expect(h.pending).toHaveLength(0)
  expect(cameraButton('compare-scan').disabled).toBe(false)
  expect(h.errors).toEqual([])
  await act(async () => root.render(createElement(LidarScanPanel, base)))
  expect(cameraButton('compare-refresh').disabled).toBe(true)
  await act(async () => cameraButton('compare-scan').click())
  expect(h.pending.map(row => row.path)).toEqual(['camera-lidar'])
  await act(async () => h.pending[0]!.resolve({...h.identity, cameraName: base.cameraName, captureId: 'lidar-only-scan'}))
  expect(cameraButton('compare-scan').disabled).toBe(false)
  expect(document.querySelector('[data-testid="compare-rgb"]')?.getAttribute('data-available')).toBe('false')
  expect(document.querySelector('[data-testid="frame-verdict"]')?.getAttribute('data-status')).toBe('incomplete')
}))

test('V11：相同身份的Scene/world/清单轮询与running→paused不打断Live，完成后继续采集，真实错误结束忙态', withDom(async (root, flush) => {
  const h = previewHarness(root)
  await h.render(); await h.choose()
  expect(h.pending).toHaveLength(1)
  for (let i = 0; i < 3; i++) await h.render({scene: structuredClone(h.scene), world: {...h.world, status: 'paused'}, receipt: structuredClone(h.receipt), sampleCurrent: () => sample(), refresh: async () => undefined})
  expect(h.pending[0]!.signal.aborted).toBe(false)
  expect(h.pending).toHaveLength(1)
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'live-1')))
  expect(nativeImage()?.src).toContain('live-1')
  expect(cameraBusy()).toBe(false)
  await flush(1050)
  expect(h.pending).toHaveLength(2)
  await act(async () => h.pending[1]!.reject(new Error('CAMERA_NATIVE_FAILURE')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Camera capture failed')
  expect(document.body.textContent).toContain('CAMERA_NATIVE_FAILURE')
  expect(cameraBusy()).toBe(false)
  expect(liveCheckbox().checked).toBe(false)
}))

test('V11：Scan等待在途Live同一帧；关闭Live只停后续调度，不abort共享采集或伪用旧帧', withDom(async (root, flush) => {
  const h = previewHarness(root)
  await h.render(); await h.choose()
  await act(async () => cameraButton('camera-compare-open').click())
  await act(async () => cameraButton('compare-scan').click())
  expect(h.pending.map(row => row.path)).toEqual(['camera-preview'])
  await act(async () => liveCheckbox().click())
  expect(h.pending[0]!.signal.aborted).toBe(false)
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'shared-frame')))
  expect(h.pending.map(row => row.path)).toEqual(['camera-preview', 'camera-lidar'])
  await act(async () => h.pending[1]!.resolve({...h.identity, captureId: 'scan-1', cameraName: h.pending[1]!.input.cameraName, frameId: 'shared-frame', stepIndex: 5}))
  expect(document.querySelector('[data-testid="compare-capture-identity"]')?.textContent).toContain('shared-frame')
  expect(cameraButton('compare-scan').disabled).toBe(false)
  expect(cameraBusy()).toBe(false)
  await flush(1050)
  expect(h.pending).toHaveLength(2)
  expect(h.errors).toEqual([])
}))

test('V11：显式Refresh与Live共用single-flight，Live开关不取消Refresh，Scan不越过刷新中的采集', withDom(async (root) => {
  const h = previewHarness(root)
  await h.render(); await h.choose()
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'initial')))
  await act(async () => liveCheckbox().click())
  await act(async () => cameraButton('camera-compare-open').click())
  await act(async () => cameraButton('compare-refresh').click())
  expect(h.pending).toHaveLength(2)
  expect(cameraButton('compare-scan').disabled).toBe(true)
  await act(async () => liveCheckbox().click())
  expect(h.pending).toHaveLength(2)
  await act(async () => liveCheckbox().click())
  expect(h.pending[1]!.signal.aborted).toBe(false)
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'manual-2')))
  expect(cameraButton('compare-refresh').disabled).toBe(false)
  expect(document.querySelector('[data-testid="compare-capture-identity"]')?.textContent).toContain('manual-2')
  expect(nativeImage()?.src).toContain('manual-2')
  expect(cameraBusy()).toBe(false)
}))

test('V11：Refresh image与下一次Live tick共用采集，关闭Live保留图像，失败后可重试', withDom(async (root, flush) => {
  const h = previewHarness(root), before = JSON.stringify(h.scene)
  await h.render(); await h.choose()
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'first-live')))
  const refreshImage = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh image') as HTMLButtonElement
  await act(async () => {(document.querySelector('[data-testid="camera-preview-controls"]') as HTMLDetailsElement).open = true; refreshImage().click()})
  expect(h.pending).toHaveLength(2)
  expect(refreshImage().disabled).toBe(true)
  await flush(1050)
  expect(h.pending).toHaveLength(2)
  expect(h.pending[1]!.signal.aborted).toBe(false)
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'manual-live')))
  expect(cameraBusy()).toBe(false)
  expect(refreshImage().disabled).toBe(false)
  await act(async () => liveCheckbox().click())
  expect(nativeImage()?.src).toContain('manual-live')
  await act(async () => refreshImage().click())
  await act(async () => h.pending[2]!.reject(new Error('MANUAL_FAILURE')))
  expect(h.errors).toEqual(['Error: MANUAL_FAILURE'])
  expect(document.body.textContent).toContain('MANUAL_FAILURE')
  expect(cameraBusy()).toBe(false)
  await act(async () => refreshImage().click())
  await act(async () => h.pending[3]!.resolve(h.imageReceipt(h.pending[3]!, 'manual-retry')))
  expect(nativeImage()?.src).toContain('manual-retry')
  expect(document.body.textContent).not.toContain('MANUAL_FAILURE')
  expect(JSON.stringify(h.scene)).toBe(before)
}))

test('V11：A→B→A换机位作废旧采集；旧finally不解锁新busy，取消及卸载均abort', withDom(async (root) => {
  const h = previewHarness(root)
  await h.render(); await h.choose()
  await act(async () => cameraButton('camera-back-to-list').click()); await h.choose('cam-2')
  expect(h.pending[0]!.signal.aborted).toBe(true)
  expect(h.pending).toHaveLength(2)
  await act(async () => cameraButton('camera-back-to-list').click()); await h.choose()
  expect(h.pending[1]!.signal.aborted).toBe(true)
  expect(h.pending).toHaveLength(3)
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'old-a')))
  expect(cameraBusy()).toBe(true)
  expect(nativeImage()).toBeNull()
  await act(async () => h.pending[1]!.reject(new Error('OLD_B_FAILURE')))
  expect(h.errors).toEqual([])
  expect(document.body.textContent).not.toContain('OLD_B_FAILURE')
  expect(cameraBusy()).toBe(true)
  await act(async () => h.pending[2]!.resolve(h.imageReceipt(h.pending[2]!, 'new-a')))
  expect(nativeImage()?.src).toContain('new-a')
  expect(cameraBusy()).toBe(false)
  await act(async () => cameraButton('camera-compare-open').click())
  await act(async () => cameraButton('compare-refresh').click())
  await act(async () => root.render(createElement('div')))
  expect(h.pending[3]!.signal.aborted).toBe(true)
  await act(async () => h.pending[3]!.reject(new Error('UNMOUNTED_FAILURE')))
  expect(h.errors).toEqual([])
}))

test('V11：API换源/Scene/代次/只读切换取消旧preview且新来源可操作', withDom(async (root) => {
  const h = previewHarness(root)
  await h.render(); await h.choose()
  await h.render({api: {...h.api, clientId: 'other-client'}})
  expect(h.pending[0]!.signal.aborted).toBe(true)
  expect(cameraBusy()).toBe(false)
  expect(nativeImage()).toBeNull()
  await h.choose()
  expect(h.pending).toHaveLength(2)
  await h.render({world: {...h.world, worldGeneration: 4}, receipt: {...h.receipt, worldGeneration: 4}})
  expect(h.pending[1]!.signal.aborted).toBe(true)
  expect(h.pending).toHaveLength(3)
  await act(async () => h.pending[1]!.resolve(h.imageReceipt(h.pending[1]!, 'old-generation')))
  expect(cameraBusy()).toBe(true)
  await h.render({readOnly: true})
  expect(h.pending[2]!.signal.aborted).toBe(true)
  expect(cameraBusy()).toBe(false)
  await h.render({scene: {...h.scene, sceneId: 'new-scene'}, world: undefined, receipt: undefined})
  await act(async () => h.pending[2]!.resolve(h.imageReceipt(h.pending[2]!, 'old-scene')))
  expect(nativeImage()).toBeNull()
  expect(h.errors).toEqual([])
}))

test('V11：原生机位明确选择不被Scene相机抢占，并可用真实K采RGB-D', withDom(async (root) => {
  const h = previewHarness(root)
  const native = {...h.receipt.cameras[0], entityId: 'robot', cameraName: 'robot/native-eye', localName: 'Native eye', parentBodyName: 'wrist_3_link', cameraSource: 'mjcf'}
  const {usableCameraSpec} = await import('../src/capture-panel.tsx')
  const nativeSpec = usableCameraSpec(native)!
  await h.render({receipt: {...h.receipt, cameras: [...h.receipt.cameras, native]}, sceneSpecs: [nativeSpec]})
  await act(async () => cameraButton('camera-mounted-native-robot/native-eye').click())
  await h.render({selectedCameraEntityId: 'robot'})
  await act(async () => cameraButton('camera-compare-open').click())
  await act(async () => cameraButton('compare-refresh').click())
  expect(h.errors).toEqual([])
  expect(h.pending).toHaveLength(1)
  expect(h.pending[0]!.input.cameraNames).toEqual(['robot/native-eye'])
  expect(h.pending[0]!.input.width).toBe(160)
  expect(h.pending[0]!.input.height).toBe(120)
  await act(async () => h.pending[0]!.resolve(h.imageReceipt(h.pending[0]!, 'native-eye')))
  expect(document.querySelector('[data-testid="compare-capture-identity"]')?.textContent).toContain('native-eye')
}))

test('V11：比较Refresh的旧错误与finally不污染API新来源；当前采集失败不被Scan吞掉', withDom(async (root) => {
  const pending: Array<{resolve: (value: any) => void; reject: (reason: unknown) => void}> = [], errors: string[] = []
  const api = {request: async () => {throw new Error('unexpected lidar request')}, mediaURL: () => '/media'}
  const base: any = {api, scene: {sceneId: 's', revision: 7}, world: {worldId: 'w', worldGeneration: 3}, identity: {sceneId: 's', sceneRevision: 7, worldId: 'w', worldGeneration: 3}, ready: true, cameraName: 'robot/eye', tr, captureCamera: () => new Promise((resolve, reject) => pending.push({resolve, reject})), perform: (fn: () => Promise<unknown>) => void fn().catch(error => errors.push(String(error)))}
  const render = async (props = base) => {await act(async () => root.render(createElement(LidarScanPanel, props))); await act(async () => cameraButton('camera-compare-open').click())}
  await render(); await act(async () => cameraButton('compare-refresh').click())
  await render({...base, api: {...api}})
  await act(async () => cameraButton('compare-refresh').click())
  await act(async () => pending[0]!.reject(new Error('OLD_REFRESH_FAILURE')))
  expect(errors).toEqual([])
  expect(cameraButton('compare-refresh').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('OLD_REFRESH_FAILURE')
  await act(async () => pending[1]!.resolve(undefined))
  expect(cameraButton('compare-refresh').disabled).toBe(false)
  await act(async () => cameraButton('compare-scan').click())
  await act(async () => pending[2]!.reject(new Error('CURRENT_CAPTURE_FAILURE')))
  expect(errors).toEqual(['Error: CURRENT_CAPTURE_FAILURE'])
  expect(document.body.textContent).toContain('CURRENT_CAPTURE_FAILURE')
  expect(cameraButton('compare-scan').disabled).toBe(false)
}))

test('V11：原生清单稳定props轮询不中断，真实API换源才取消旧scope', withDom(async (root, flush) => {
  const pending: Array<{signal: AbortSignal; resolve: (value: any) => void}> = []
  const api: any = {request: (_path: string, options: any) => new Promise(resolve => pending.push({signal: options.signal, resolve}))}
  const scene: any = {sceneId: 's', revision: 7}, world: any = {worldId: 'w', sceneId: 's', appliedSceneRevision: 7, worldGeneration: 3, status: 'running'}
  function Host(props: any) {const value = useNativeCameraList(props); return createElement('div', null, value.receipt?.marker ?? '')}
  await act(async () => root.render(createElement(Host, {api, scene, world, active: true})))
  await act(async () => root.render(createElement(Host, {api, scene: {...scene}, world: {...world, status: 'paused'}, active: true})))
  expect(pending).toHaveLength(1)
  expect(pending[0]!.signal.aborted).toBe(false)
  await act(async () => pending[0]!.resolve({sceneId: 's', sceneRevision: 7, worldId: 'w', generation: 3, marker: 'current'}))
  expect(document.body.textContent).toBe('current')
  await flush(800)
  expect(pending).toHaveLength(2)
  await act(async () => root.render(createElement(Host, {api: {...api}, scene, world, active: true})))
  expect(pending[1]!.signal.aborted).toBe(true)
  expect(pending).toHaveLength(3)
  await act(async () => pending[1]!.resolve({sceneId: 's', sceneRevision: 7, worldId: 'w', generation: 3, marker: 'stale'}))
  expect(document.body.textContent).not.toContain('stale')
}))

test('V11 UX：新建机位首屏按 Robot → Mount location → Position & direction 排列，三条动作可见且 Save/Cancel 在底部', withDom(async (root, flush) => {
  const saves: any[] = []
  await renderPanel(root, {worldId: 'w', sceneId: 's', sceneRevision: 7, generation: 3, frameId: 'f1', stepIndex: 5, bodies: bodies.map(row => ({...row, worldId: 'w', generation: 3, sceneRevision: 7})), cameras: []}, saves)
  await flush()
  const panel = document.querySelector('[data-testid="robot-camera-panel"]')!
  await act(async () => [...panel.querySelectorAll('button')].find(button => button.textContent === 'Add camera to this robot')!.click())
  await flush()
  const robotRow = panel.querySelector('[data-testid="camera-mounted-robot"]') as HTMLElement
  const mount = panel.querySelector('select[aria-label="Mount location"]') as HTMLSelectElement
  const pose = panel.querySelector('[data-testid="camera-position-direction"]') as HTMLElement
  expect(robotRow).not.toBeNull()
  expect(mount).not.toBeNull()
  expect(pose).not.toBeNull()
  // 三段顺序按真实 DOM：Robot（只读当前实例）→ Mount location（真实连杆）→ 位置与方向。
  expect([...panel.querySelectorAll('[data-testid="camera-mounted-robot"], select[aria-label="Mount location"], [data-testid="camera-position-direction"]')]).toEqual([robotRow, mount, pose])
  expect(robotRow.textContent).toContain('Robot')
  expect(robotRow.textContent).toContain('ur10e')
  expect(robotRow.querySelector('select,input')).toBeNull()
  // 连杆名可读，不只暴露 ID；真实 bodyName 仍在 option 值里。
  const options = [...mount.options].filter(option => option.value)
  expect(options.length).toBeGreaterThan(0)
  expect(options.map(option => option.textContent)).toContain('wrist · wrist_1_link')
  expect(options.every(option => option.textContent!.includes(option.value))).toBe(true)
  // 位置与方向区在折叠外，先选真实连杆再把草稿作为用户输入。
  expect(pose.closest('details')).toBeNull()
  await act(async () => setValue(mount, 'wrist_3_link'))
  await flush()
  const followNote = panel.querySelector('[data-testid="camera-mount-follow-note"]')!
  expect(followNote.textContent).toContain('follows that link')
  expect(followNote.textContent).toContain('not world-fixed')
  const useCurrent = panel.querySelector('[data-testid="camera-use-current-view"]') as HTMLButtonElement
  const move = panel.querySelector('[data-testid="camera-move-position"]') as HTMLButtonElement
  const rotate = panel.querySelector('[data-testid="camera-rotate-direction"]') as HTMLButtonElement
  expect([useCurrent, move, rotate].map(button => button.textContent)).toEqual(['Use current view', 'Move position', 'Rotate direction'])
  // 设计稿 camera-install 首屏无三动作：它们收进“位置与方向怎么填”折叠，点击仍可用。
  for (const button of [useCurrent, move, rotate]) expect(button.closest('details')).not.toBeNull()
  expect(panel.querySelector('[data-testid="camera-position-help"]')!.textContent).toContain('Local pose')
  expect(panel.querySelector('[data-testid="camera-position-help"]')!.textContent).toContain('no drag handle')
  expect(panel.querySelector('[data-testid="camera-direction-help"]')!.textContent).toContain('normal/up')
  // Move position 真正展开 Local pose 的既有字段；Use current view 真正重采当前画面。
  const localPose = panel.querySelector('[data-testid="camera-local-pose"]') as HTMLDetailsElement
  await act(async () => move.click())
  await flush()
  expect(localPose.open).toBe(true)
  const position = panel.querySelector('[data-testid="camera-position-input"]') as HTMLInputElement
  const initial = position.value
  await act(async () => setValue(position, '9 9 9'))
  await act(async () => useCurrent.click())
  await flush()
  expect(position.value).not.toBe('9 9 9')
  expect(position.value).toBe(initial)
  await act(async () => rotate.click())
  await flush()
  expect(localPose.open).toBe(true)
  expect(panel.querySelector('[data-testid="camera-normal-input"]')).not.toBeNull()
  // 底部唯一主按钮 Save camera + Cancel；唯一 camera-save 属于这个底栏。
  const foot = panel.querySelector('.lya-panel-foot') as HTMLElement
  expect(foot).not.toBeNull()
  expect(panel.lastElementChild).toBe(foot)
  expect([...foot.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel', 'Save camera'])
  expect(panel.querySelectorAll('[data-testid="camera-save"]')).toHaveLength(1)
}))

test('V11 UX：已保存机位详情直接给出 Edit/Preview/Aim direction 与位置方向入口，Record this camera 在底部', withDom(async (root) => {
  const h = previewHarness(root)
  const pilotKeys: string[] = [], aimKeys: string[] = [], recordKeys: string[] = []
  await h.render({
    aim: (key: string) => aimKeys.push(key),
    pilot: (key: string) => pilotKeys.push(key),
    recordCamera: (key: string) => recordKeys.push(key),
  })
  await h.choose()
  const actions = document.querySelector('[data-testid="camera-detail-actions"]') as HTMLElement
  expect(actions).not.toBeNull()
  expect(actions.closest('details')).toBeNull()
  const edit = document.querySelector('[data-testid="camera-edit-entry"]') as HTMLButtonElement
  const preview = document.querySelector('[data-testid="camera-preview-entry"]') as HTMLButtonElement
  const aim = document.querySelector('[data-testid="camera-aim-entry"]') as HTMLButtonElement
  expect(edit.textContent).toBe('Edit')
  expect(preview.textContent).toBe('Preview')
  expect(aim.textContent).toBe('Aim direction')
  expect(edit.disabled).toBe(false)
  expect(preview.disabled).toBe(false)
  expect(aim.disabled).toBe(false)
  await act(async () => preview.click())
  expect(pilotKeys).toHaveLength(1)
  await act(async () => aim.click())
  expect(aimKeys).toHaveLength(1)
  // 设计稿 camera-compare 首屏只有字段与预览：Edit/Preview/Aim、跟随说明、位置方向入口都收进一个具名折叠（仍一键可达）。
  const poseEntry = document.querySelector('[data-testid="camera-detail-pose"]') as HTMLElement
  expect(poseEntry).not.toBeNull()
  expect(poseEntry.closest('details')?.getAttribute('data-testid')).toBe('camera-detail-pose-explainer')
  expect(poseEntry.textContent).toContain('Position & direction')
  const poseNote = document.querySelector('[data-testid="camera-detail-pose-note"]')!
  expect(poseNote.textContent).toContain('wrist_3_link')
  expect(poseNote.textContent).toContain('not world-fixed')
  // V11-P20：首屏只留一句“跟随该连杆”；实现说明（画布无拖柄 / Aim 右键）收进具名折叠。
  expect(poseNote.textContent).not.toContain('no canvas drag handle')
  const poseExplainer = document.querySelector('[data-testid="camera-detail-pose-explainer"]') as HTMLDetailsElement
  expect(poseExplainer.tagName).toBe('DETAILS')
  expect(poseExplainer.open).toBe(false)
  expect(poseExplainer.textContent).toContain('no canvas drag handle')
  // Record this camera 是详情底栏的唯一主按钮，且不在折叠里。
  const record = document.querySelector('[data-testid="camera-record-this"]') as HTMLButtonElement
  expect(record).not.toBeNull()
  expect(record.closest('details')).toBeNull()
  expect(record.textContent).toBe('Record this camera')
  expect(record.disabled).toBe(false)
  await act(async () => record.click())
  expect(recordKeys).toHaveLength(1)
  // 位置方向入口打开同一编辑草稿并展开 Local pose；返回后 Edit 仍可进入。
  await act(async () => (document.querySelector('[data-testid="camera-edit-pose"]') as HTMLButtonElement).click())
  expect(document.querySelector('[data-testid="camera-position-direction"]')).not.toBeNull()
  expect((document.querySelector('[data-testid="camera-local-pose"]') as HTMLDetailsElement).open).toBe(true)
  await act(async () => (document.querySelector('[data-testid="camera-back-to-list"]') as HTMLButtonElement).click())
  expect(document.querySelector('[data-testid="camera-detail-actions"]')).not.toBeNull()
  await act(async () => (document.querySelector('[data-testid="camera-edit-entry"]') as HTMLButtonElement).click())
  expect(document.querySelector('[data-testid="camera-position-direction"]')).not.toBeNull()
  expect(document.querySelectorAll('[data-testid="camera-save"]')).toHaveLength(1)
}))


// 设计规则 7：首屏不得出现 `entity_<uuid>` 这类长 ID；展示层必须给可读短名。
test('原生相机身份展示不暴露长 UUID', async () => {
  const {readableIdentity} = await import('../src/scene-camera-panel.tsx')
  const entityId = 'entity_b26a65b8-bc5d-4c86-963d-46a33deadbeef12'
  expect(readableIdentity(`${entityId}/trunk`)).toBe('trunk')
  expect(readableIdentity(entityId)).toBe('本机相机')
  expect(readableIdentity('tracking')).toBe('tracking')
  const long = 'abc1234512345123xyz'
  expect(readableIdentity(long)).not.toContain('12451234xyz')
})
