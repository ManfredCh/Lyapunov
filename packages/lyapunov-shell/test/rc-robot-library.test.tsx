/**
 * RC P4（R-004）：Robots 目录先行、实例二级详情与 Policy 主路径的行为回归。
 *
 * 真 React 组件 + 真 DOM（上游 jsdom 夹具），不触网、不触引擎：
 *  · Robot Library 首屏区分「库资源」与「场景实例」；状态只用真实字段（已登记/可用/模型未随包提供）；
 *  · 库条目动作只走调用方的登记/加入回调；已导入分类显示真实资源；
 *  · 实例清单点行进入二级详情回调；空场景给出真实空态；
 *  · 原子动作 Start/Stop 接线，Freeze/Restore 在缺目标级后端时明确不可用并说明原因；
 *  · Policy 主路径显示当前策略/兼容状态/目标，并按状态给一个明确的下一步（check→prepare→apply），
 *    切实例后旧状态不串用、已登记条目仍在。
 *
 * 边界：这不是真实浏览器布局验收；轨标签真实宽度与不省略由独立浏览器脚本核验。
 */
import {test, expect, mock} from 'bun:test'
import {createRequire} from 'node:module'
import {createElement, act, Fragment} from 'react'
import {createRoot} from 'react-dom/client'
import {projectSceneCameraRigs} from '../../viewer/src/scene-camera-rigs.ts'

let viewerFactory: (...args: unknown[]) => any = () => ({})
mock.module('@lyapunov/viewer/client', () => ({
  projectSceneCameraRigs,
  createViewer: (...args: unknown[]) => viewerFactory(...args),
  WebGLUnavailableError: class extends Error {},
}))

const {RobotAtomicActions, RobotInstanceList, RobotLibrarySection} = await import('../src/robot-library-panel.tsx')
const {robotPreviewResourcePath} = await import('../src/robot-resource-preview.tsx')
const {PolicyLibraryPanel} = await import('../src/policy-library-panel.tsx')
import type {Entity} from '../../lyapunov-contracts/src/types.ts'
import type {AssetRecord} from '../src/workbench-api.ts'

const tr = (_zh: string, en: string) => en

function withDom(run: (root: ReturnType<typeof createRoot>, flush: (ms?: number) => Promise<void>) => Promise<void>) {
  return async () => {
    const {JSDOM} = createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json', import.meta.url))('jsdom') as {JSDOM: new (html: string, options?: {url?: string; pretendToBeVisual?: boolean}) => {window: Window & typeof globalThis}}
    const dom = new JSDOM('<div id="root"></div>', {url: 'http://fixture.invalid', pretendToBeVisual: true})
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'navigator', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      const raw = (dom.window as unknown as Record<string, unknown>)[key]
      const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : typeof raw === 'function' && key.includes('AnimationFrame') ? (raw as (...args: unknown[]) => unknown).bind(dom.window) : raw
      Object.defineProperty(globalThis, key, {configurable: true, value})
    }
    saved.set('ResizeObserver', Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'))
    Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: class {observe() {} disconnect() {}}})
    // jsdom 没有 IE 式 attachEvent/detachEvent；React 对 text input 的旧式 value 侦听会调用它们。
    ;(dom.window as unknown as {HTMLElement: {prototype: Record<string, unknown>}}).HTMLElement.prototype.attachEvent = () => {}
    ;(dom.window as unknown as {HTMLElement: {prototype: Record<string, unknown>}}).HTMLElement.prototype.detachEvent = () => {}
    const root = createRoot(document.getElementById('root')!)
    const flush = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
    try { await run(root, flush) }
    finally {
      await act(async () => root.unmount())
      viewerFactory = () => ({})
      dom.window.close()
      for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
    }
  }
}

const libraryRow = (overrides: Record<string, unknown>) => ({
  packId: 'franka_panda', version: '2026.09', family: 'arm', tier: 'T0', source: 'mujoco_menagerie', license: 'Apache-2.0', policyLicense: 'Apache-2.0',
  modelPath: '/packs/franka_panda/asset/panda.xml', modelBytes: 1048576, modelSha256: 'a'.repeat(64), installed: true, resourceId: 'res-franka',
  previewPath: null,
  policyStatus: 'none', policyVariant: null, policyDetail: null, sourceDof: 7, policyDof: null, channels: ['joint'], control: 'suitable', mode: null, adapterReady: true, behaviorVerified: false, gaps: [],
  ...overrides,
}) as never

const asset = (name: string, resourceId: string): AssetRecord => ({ref: {resourceId, version: 1, original: {uri: 'file:///x', mimeType: 'model/mjcf'}}, name, tags: [], folder: 'T0 机器人示例', parsed: {kind: 'robot'}}) as AssetRecord
const robotInstance = (entityId: string, name: string): Entity => ({entityId, name, parentId: undefined, transform: {position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]}, resources: [{resourceId: 'res-franka', version: 2, uri: 'res:x'}], components: {articulation: {}}}) as unknown as Entity

test('Robot Library 首屏：库条目状态与真实动作，分类切换保留身份', withDom(async (root) => {
  const rows = [
    libraryRow({packId: 'franka_panda', installed: true, resourceId: 'res-franka'}),
    libraryRow({packId: 'ur10e', installed: false, resourceId: null, modelPath: '/packs/ur10e/asset/ur10e.xml'}),
    libraryRow({packId: 'generic_quadrotor', installed: false, resourceId: null, modelPath: null, gaps: ['MODEL_NOT_BUNDLED']}),
  ]
  const selected: Array<string|undefined> = [], added: string[] = [], mounted: string[] = [], imports: number[] = []
  const render = (tab: 'builtin' | 'imported' = 'builtin', selectedPackId?: string) => act(async () => root.render(createElement(RobotLibrarySection, {
    tr, rows, rowsBusy: false, rowsError: '', query: '', setQuery: () => {}, tab, setTab: () => {}, imported: [asset('my_arm', 'res-my')], canMount: true, available: true,
    selectedPackId, onSelectPack: (id?: string) => selected.push(id), onAdd: (row: any) => added.push(row.packId), onMount: (a: AssetRecord) => mounted.push(a.name), onImport: () => imports.push(1), onRefresh: () => {},
  } as never)))
  await render()
  // 状态是真实字段投影：已登记 / 可用 / 模型未随包提供，三者可区分。
  expect(document.querySelector('[data-testid="robot-library-row-franka_panda"]')!.textContent).toContain('Registered')
  expect(document.querySelector('[data-testid="robot-library-row-ur10e"]')!.textContent).toContain('Available')
  expect(document.querySelector('[data-testid="robot-library-row-generic_quadrotor"]')!.textContent).toContain('Model not bundled')
  // 搜索 + 刷新是专用一行（不靠 lya-wide 100%），刷新按钮不被挤到下一行。
  const searchRow=document.querySelector('[data-testid="robot-library-search-row"]')!
  expect(searchRow.className).toContain('lya-library-search')
  expect((searchRow.querySelector('input[type="search"]') as HTMLInputElement).className).not.toContain('lya-wide')
  expect((searchRow.querySelector('button') as HTMLButtonElement).getAttribute('aria-label')).toBe('Refresh robot library')
  // 首屏是可浏览列表：不自动进入某个模型详情，主动作不会被排到长列表之后。
  expect(document.querySelector('[data-testid="robot-library-list"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="robot-library-detail-card"]')).toBeNull()
  // 点条目只回调；父层回填 selectedPackId 后进入同栏二级详情。
  await act(async () => (document.querySelector('[data-testid="robot-library-row-franka_panda"]') as HTMLButtonElement).click())
  expect(selected).toEqual(['franka_panda'])
  await render('builtin', 'franka_panda')
  // V5 EN-25：列表保持可见，选中行高亮；详情/Add to scene 在列表下方的具名卡里。
  expect(document.querySelector('[data-testid="robot-library-list"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="robot-library-row-franka_panda"]')!.getAttribute('aria-pressed')).toBe('true')
  const detailCard = document.querySelector('[data-testid="robot-library-detail-card"]')!
  expect(detailCard.textContent).toContain('franka_panda')
  const primaryAction = document.querySelector('[data-testid="robot-library-primary-action"]')!
  expect(primaryAction).not.toBeNull()
  // V8-13：完整字段/来源在具名 Details 二级页，不压在 11 行列表后面。
  expect(document.querySelector('[data-testid="robot-library-fields"]')).toBeNull()
  await act(async () => (document.querySelector('[data-testid="robot-library-details"]') as HTMLButtonElement).click())
  // V8-13：资源详情先给短摘要；技术字段/来源许可默认折叠（不默认大展开）。
  expect(document.querySelector('[data-testid="robot-library-resource-summary"]')!.textContent).toContain('7 DOF')
  expect(document.querySelector('[data-testid="robot-library-fields"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="robot-library-fields"]')!.hasAttribute('open')).toBe(false)
  expect(document.querySelector('[data-testid="robot-library-source-license"]')!.hasAttribute('open')).toBe(false)
  await act(async () => (document.querySelector('[data-testid="robot-library-add"]') as HTMLButtonElement).click())
  expect(added).toEqual(['franka_panda'])
  // 资源详情的返回：回调 undefined，父层回填后回到列表视图。
  await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '‹ Robot Library')!).click())
  expect(selected).toEqual(['franka_panda', undefined])
  await render('builtin')
  expect(document.querySelector('[data-testid="robot-library-list"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="robot-library-detail-card"]')).toBeNull()
  // 选 ur10e：未登记但有模型 => 登记动作；点它只回调，不伪造已登记。
  await render('builtin', 'ur10e')
  const registerButton = document.querySelector('[data-testid="robot-library-register"]') as HTMLButtonElement
  expect(registerButton).not.toBeNull()
  await act(async () => registerButton.click())
  expect(added).toEqual(['franka_panda', 'ur10e'])
  // generic_quadrotor 无模型原件：详情卡不给假登记按钮。
  await render('builtin', 'generic_quadrotor')
  expect(document.querySelector('[data-testid="robot-library-register"]')).toBeNull()
  expect(document.querySelector('[data-testid="robot-library-add"]')).toBeNull()
  // 已导入分类显示真实资源并可加入场景。
  await render('imported')
  expect(document.body.textContent).toContain('my_arm')
  await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add to scene')!.click()))
  expect(mounted).toEqual(['my_arm'])
  // 导入入口只在用户点按时回调。
  await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Import local file')!.click()))
  expect(imports.length).toBe(1)
}))

test('V8-13 预览：机器人文档引用映射到真实本地 mesh/材质路径，拒绝网络引用',()=>{
  expect(robotPreviewResourcePath('file:///packs/franka_panda/asset/meshes/link.stl','/packs/franka_panda/asset/panda.xml')).toBe('/packs/franka_panda/asset/meshes/link.stl')
  expect(robotPreviewResourcePath('meshes/link.stl','/packs/franka_panda/asset/panda.xml','file:///packs/franka_panda/asset/')).toBe('/packs/franka_panda/asset/meshes/link.stl')
  expect(robotPreviewResourcePath('/packs/franka_panda/asset/meshes/link.stl','/packs/franka_panda/asset/panda.xml')).toBe('/packs/franka_panda/asset/meshes/link.stl')
  expect(()=>robotPreviewResourcePath('https://example.invalid/link.stl','/packs/franka_panda/asset/panda.xml')).toThrow()
})

test('V8-13 资源详情：真实 model-preview 读取 + 只读预览，不改 Scene，换机型清理旧 Viewer', withDom(async (root, flush) => {
  const rows = [
    libraryRow({packId: 'franka_panda', installed: true, resourceId: 'res-franka', modelPath: '/packs/franka_panda/asset/panda.xml', modelSha256: 'a'.repeat(64)}),
    libraryRow({packId: 'ur10e', installed: true, resourceId: 'res-ur10e', modelPath: '/packs/ur10e/asset/ur10e.xml', modelSha256: 'b'.repeat(64)}),
  ]
  const loaded: Array<{path: string; aborted: boolean}> = []
  const load = async (path: string, signal: AbortSignal) => {
    loaded.push({path, aborted: signal.aborted})
    return {kind: 'robot', robot: {format: 'mjcf', document: {mujoco: {}}, baseUri: 'file:///packs/'}}
  }
  const bytesURL = (path: string) => `/api/lyapunov/model-preview?path=${encodeURIComponent(path)}`
  const viewers: any[] = []
  viewerFactory = (options: any) => {
    const canvas=document.createElement('canvas');options.container.appendChild(canvas)
    const viewer: any = {
      canvas,
      setScene: async (snapshot: any) => { viewer.snapshot = snapshot },
      setDisplaySettings: () => {},
      setNavigationMode: (mode:string,remember:boolean) => { viewer.navigation={mode,remember} },
      focus: (id: string) => { viewer.focused = id; viewer.framed = true },
      openDefaultView: () => { viewer.framed = true },
      dispose: () => { viewer.disposed = true },
    }
    viewers.push(viewer)
    return viewer
  }
  const added: string[] = []
  const previewHost=document.createElement('div');previewHost.id='main-preview-host';document.body.appendChild(previewHost)
  const render = (selectedPackId: string, translate=tr, previewScope='s1:scene-a') => act(async () => root.render(createElement(RobotLibrarySection, {
    tr:translate, rows, rowsBusy: false, rowsError: '', query: '', setQuery: () => {}, tab: 'builtin', setTab: () => {}, imported: [], canMount: true, available: true,
    selectedPackId, onSelectPack: () => {}, onAdd: (row: any) => added.push(row.packId), onMount: () => {}, onImport: () => {}, onRefresh: () => {},
    sessionId: 's1', previewRequest: load, previewBytesURL: bytesURL, previewHost, previewScope,
  } as never)))
  await render('franka_panda')
  await act(async () => (document.querySelector('[data-testid="robot-library-details"]') as HTMLButtonElement).click())
  await flush()
  // 资源尚未加入场景也能看原件：只读快照是预览专用身份，不是工作台当前 Scene。
  expect(loaded.map(row => row.path)).toEqual(['/packs/franka_panda/asset/panda.xml'])
  expect(viewers).toHaveLength(1)
  expect(viewers[0].snapshot.sceneId).toBe('lyapunov-model-preview')
  expect(viewers[0].snapshot.entities).toHaveLength(1)
  expect(viewers[0].snapshot.entities[0].components.visual.robot.format).toBe('mjcf')
  expect(viewers[0].framed).toBe(true)
  expect(viewers[0].focused).toBe('lyapunov-model-preview')
  expect(viewers[0].navigation).toEqual({mode:'orbit',remember:false})
  // V10：真实 Native 资源详情把只读 Viewer portal 到 Lyapunov 主画布宿主；右栏不再只是 220px 小图。
  expect(previewHost.querySelector('[data-testid="robot-resource-preview"]')).not.toBeNull()
  expect(previewHost.querySelector('[data-testid="robot-resource-preview"]')!.getAttribute('data-main-canvas-preview')).toBe('true')
  expect(document.getElementById('root')!.querySelector('[data-testid="robot-resource-preview"]')).toBeNull()
  // 输入归属：焦点在预览 canvas（可 Tab），隐藏的主 Viewer canvas 仍是 tabIndex=-1。
  expect(viewers[0].canvas.tabIndex).toBe(0)
  expect(document.activeElement).toBe(viewers[0].canvas)
  // V10：资源预览可显式框选，预览阶段只动预览 Viewer。
  await act(async () => (document.querySelector('[data-testid="robot-resource-preview-frame"]') as HTMLButtonElement).click())
  expect(viewers[0].focused).toBe('lyapunov-model-preview')
  expect(document.querySelector('[data-testid="robot-resource-preview"]')!.getAttribute('data-status')).toBe('ready')
  expect(document.querySelector('[data-testid="robot-resource-preview-detail"]')!.textContent).toContain('MJCF')
  expect(added).toEqual([])
  // 技术字段/来源默认折叠。
  expect(document.querySelector('[data-testid="robot-library-fields"]')!.hasAttribute('open')).toBe(false)
  expect(document.querySelector('[data-testid="robot-library-source-license"]')!.hasAttribute('open')).toBe(false)
  // 工作台轮询会重建同一语言的翻译函数；这不能销毁已加载的只读模型。
  await render('franka_panda',(_cn,en)=>en)
  await flush()
  expect(loaded).toHaveLength(1)
  expect(viewers).toHaveLength(1)
  expect(viewers[0].disposed).not.toBe(true)
  // 切 Scene/会话座位：旧只读 Viewer 与在途请求清理，新座位重建；不把预览挂到别人的画布。
  await render('franka_panda',tr,'s1:scene-b')
  await flush()
  expect(loaded).toHaveLength(2)
  expect(viewers[0].disposed).toBe(true)
  expect(viewers).toHaveLength(2)
  expect(viewers[1].snapshot.sceneId).toBe('lyapunov-model-preview')
  // 换机型：旧预览必须 dispose，新预览读取新行的真实入口，不串旧 mesh。
  await render('ur10e')
  await flush()
  await act(async () => (document.querySelector('[data-testid="robot-library-details"]') as HTMLButtonElement).click())
  await flush()
  expect(loaded.map(row => row.path)).toEqual(['/packs/franka_panda/asset/panda.xml', '/packs/franka_panda/asset/panda.xml', '/packs/ur10e/asset/ur10e.xml'])
  expect(viewers[0].disposed).toBe(true)
  expect(viewers[1].disposed).toBe(true)
  expect(viewers).toHaveLength(3)
  expect(viewers[2].snapshot.entities[0].name).toBe('ur10e.xml')
  expect(previewHost.querySelector('[data-testid="robot-resource-preview"]')).not.toBeNull()
  // Back：卸载 portal，旧 Viewer dispose，主画布宿主恢复为空（Main Viewer 本身从未被替换）。
  await act(async () => (document.querySelector('.lya-back') as HTMLButtonElement).click())
  await flush()
  expect(previewHost.childElementCount).toBe(0)
  expect(viewers[2].disposed).toBe(true)
  expect(added).toEqual([])
}))

test('V8-13 资源详情：真实加载失败给短状态并可重试，不拿假图冒充', withDom(async (root, flush) => {
  let attempts = 0
  const load = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('MODEL_PREVIEW_RPC_DOWN')
    return {kind: 'robot', robot: {format: 'mjcf', document: {mujoco: {}}, baseUri: 'file:///packs/'}}
  }
  viewerFactory = () => ({setScene: async () => {}, setNavigationMode: () => {}, setDisplaySettings: () => {}, openDefaultView: () => {}, dispose: () => {}})
  await act(async () => root.render(createElement(RobotLibrarySection, {
    tr, rows: [libraryRow({packId: 'franka_panda', modelPath: '/packs/franka_panda/asset/panda.xml'})], rowsBusy: false, rowsError: '', query: '', setQuery: () => {}, tab: 'builtin', setTab: () => {}, imported: [], canMount: true, available: true,
    selectedPackId: 'franka_panda', onSelectPack: () => {}, onAdd: () => {}, onMount: () => {}, onImport: () => {}, onRefresh: () => {},
    sessionId: 's1', previewRequest: load, previewBytesURL: (path: string) => `/api/lyapunov/model-preview?path=${encodeURIComponent(path)}`,
  } as never)))
  await act(async () => (document.querySelector('[data-testid="robot-library-details"]') as HTMLButtonElement).click())
  await flush()
  expect(document.querySelector('[data-testid="robot-resource-preview"]')!.getAttribute('data-status')).toBe('failed')
  expect(document.querySelector('[data-testid="robot-resource-preview"]')!.textContent).toContain('MODEL_PREVIEW_RPC_DOWN')
  expect(document.querySelector('[data-testid="robot-resource-preview-retry"]')).not.toBeNull()
  await act(async () => (document.querySelector('[data-testid="robot-resource-preview-retry"]') as HTMLButtonElement).click())
  await flush()
  expect(attempts).toBe(2)
  expect(document.querySelector('[data-testid="robot-resource-preview"]')!.getAttribute('data-status')).toBe('ready')
}))

test('实例清单：空态与点行进入详情回调', withDom(async (root) => {
  const opened: string[] = []
  const render = (instances: Entity[]) => act(async () => root.render(createElement(RobotInstanceList, {tr, instances, selectedId: undefined, worldBoundFor: () => false, onOpen: (id: string) => opened.push(id)} as never)))
  await render([])
  expect(document.querySelector('[data-testid="robot-instance-empty"]')).not.toBeNull()
  await render([robotInstance('r1', 'Panda One'), robotInstance('r2', 'UR10e Two')])
  await act(async () => (document.querySelector('[data-testid="robot-instance-r2"]') as HTMLButtonElement).click())
  expect(opened).toEqual(['r2'])
}))

test('原子动作：Start/Stop/Freeze/Restore 真实接线，Freeze/Restore 不再永久禁用', withDom(async (root) => {
  const calls: string[] = []
  await act(async () => root.render(createElement(RobotAtomicActions, {tr, entityName: 'Panda One', canStart: true, canStop: true, canFreeze: true, canRestore: true, freezeDetail: 'Frozen: native constraints hold the current pose', onStart: () => calls.push('start'), onStop: () => calls.push('stop'), onFreeze: () => calls.push('freeze'), onRestore: () => calls.push('restore')} as never)))
  expect((document.querySelector('[data-testid="robot-start"]') as HTMLButtonElement).disabled).toBe(false)
  expect((document.querySelector('[data-testid="robot-stop"]') as HTMLButtonElement).disabled).toBe(false)
  expect((document.querySelector('[data-testid="robot-freeze"]') as HTMLButtonElement).disabled).toBe(false)
  expect((document.querySelector('[data-testid="robot-restore"]') as HTMLButtonElement).disabled).toBe(false)
  // 旧的“目标级后端尚未实现”长文已移除；只在真实冻结时显示保持事实。
  expect(document.querySelector('[data-testid="robot-freeze-note"]')).toBeNull()
  expect(document.querySelector('[data-testid="robot-freeze-detail"]')!.textContent).toContain('Frozen: native constraints')
  await act(async () => (document.querySelector('[data-testid="robot-start"]') as HTMLButtonElement).click())
  await act(async () => (document.querySelector('[data-testid="robot-stop"]') as HTMLButtonElement).click())
  await act(async () => (document.querySelector('[data-testid="robot-freeze"]') as HTMLButtonElement).click())
  await act(async () => (document.querySelector('[data-testid="robot-restore"]') as HTMLButtonElement).click())
  expect(calls).toEqual(['start', 'stop', 'freeze', 'restore'])
}))

test('原子动作：未冻结/未配置时 Freeze/Restore 与 Start 按真实条件禁用并给短原因', withDom(async (root) => {
  const calls: string[] = []
  await act(async () => root.render(createElement(RobotAtomicActions, {tr, entityName: 'Panda One', canStart: false, startUnavailableReason: 'No configured action: set a full joint target first.', canStop: true, canFreeze: false, canRestore: false, onStart: () => calls.push('start'), onStop: () => calls.push('stop'), onFreeze: () => calls.push('freeze'), onRestore: () => calls.push('restore')} as never)))
  expect((document.querySelector('[data-testid="robot-start"]') as HTMLButtonElement).disabled).toBe(true)
  expect((document.querySelector('[data-testid="robot-freeze"]') as HTMLButtonElement).disabled).toBe(true)
  expect((document.querySelector('[data-testid="robot-restore"]') as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('[data-testid="robot-start-unavailable"]')!.textContent).toContain('No configured action')
  await act(async () => (document.querySelector('[data-testid="robot-stop"]') as HTMLButtonElement).click())
  expect(calls).toEqual(['stop'])
}))

test('Policy 主路径：状态语义、下一步、实例切换不串状态', withDom(async (root, flush) => {
  const entry = {id: 'local-1', label: 'panda_policy.pt', filePath: '/cache/panda_policy.pt', registeredAt: '2026-10-15', available: true, sourceBytesVerified: false}
  const identity = {provider: 'github', modelId: 'local/verified', revision: 'abcdef123456'}
  const calls: Array<{name: string; input: any}> = []
  const command = async (name: string, input: any) => {
    calls.push({name, input})
    if (name === 'policy_download_sources') return {models: [], localEntries: [entry]}
    if (name === 'policy_prepare') return {status: 'PREPARED'}
    if (name === 'policy_activate') return {status: 'ACTIVE_MATCHED', identity, world: {worldId: 'new', worldGeneration: 2}, snapshot: {sceneId: 'scene', revision: 5}}
    return {category: 'weights_need_adapter', ready: false, dimensions: {}, missing: [], nextActions: [], policyPrepared: false, localEntry: entry}
  }
  // 兼容回执必须带登记时的真实目标上下文；未知/不匹配的旧回执不授予兼容。
  const context = (entityId: string) => ({kind: 'policy' as const, sceneId: 'scene', entityId, worldId: 'world', expectedGeneration: 1, expectedRevision: 5, identity})
  const receiptBase = {filePath: '', entry, face: {state: {category: 'weights_need_adapter', ready: false, dimensions: {}, missing: [], nextActions: [], policyPrepared: false, localEntry: entry}, identity}, context: context('r1')}
  const receiptPrepared = {filePath: '', entry, face: {state: {category: 'direct_execution', ready: true, worldBound: true, applyEligible: true, dimensions: {}, missing: [], nextActions: [], policyPrepared: true, localEntry: entry}, identity}, context: context('r1')}
  const render = (entityId: string, importReceipt: any) => act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, sceneId: 'scene', entityId, worldId: 'world', worldStatus: 'ready', expectedRevision: 5, expectedGeneration: 1, command, targetLabel: 'Panda One', tr, importReceipt,
  } as never)))
  await render('r1', receiptBase)
  await flush()
  expect(document.querySelector('[data-testid="policy-target"]')!.textContent).toBe('Panda One')
  // V8-14：选择器 label 短（Policy），输入占满内容宽度；长 placeholder 不再把标签挤成两列。
  const policyLabel=document.querySelector('[data-testid="policy-choose"]')!.closest('label')!
  expect(policyLabel.textContent).toContain('Policy')
  expect(policyLabel.querySelector('select')!.className).toContain('lya-wide')
  // 英文兼容结论用tr对应语言，不用中文目录标签，也不把「已登记路线」当实例兼容。
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Weights present; adapter or instance preparation missing')
  expect(document.querySelector('[data-testid="policy-apply-impact"]')!.textContent).toContain('stops and rebuilds the selected world')
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  // 一个明确下一步：未准备 => 为本实例准备；点它走 policy_prepare。
  const next = () => document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(next().textContent).toContain('Prepare for this instance')
  await act(async () => next().click())
  await flush()
  expect(calls.some(call => call.name === 'policy_prepare' && call.input.entityId === 'r1')).toBe(true)
  // 已准备且本实例真实就绪 => 应用到所选实例；应用回执建立新 world 后按新 generation 再读状态。
  await render('r1', receiptPrepared)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Compatible with this instance')
  expect(next().textContent).toContain('Apply to instance')
  await act(async () => next().click())
  await flush()
  const activate = calls.find(call => call.name === 'policy_activate')!
  expect(activate.input.entityId).toBe('r1')
  expect(activate.input.expectedRevision).toBe(5)
  // 切到另一个实例：同一份已登记回执不变，但旧兼容状态清零为 Not checked，不把 r1 的回执串到 r2。
  await render('r2', receiptPrepared)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Not checked')
  expect(document.querySelector('[data-testid="policy-target"]')!.textContent).toBe('Panda One')
}))

test('Policy：prepared不等于兼容，明确不兼容时不可Apply并给准确英文下一步', withDom(async (root, flush) => {
  const identity = {provider: 'github', modelId: 'local/verified', revision: 'abcdef123456'}
  const command = async () => ({models: [], localEntries: []})
  const blocked = {category: 'model_incompatible', ready: false, worldBound: false, dimensions: {}, policyPrepared: true, nextActions: [], missing: [{code: 'JOINT_COUNT_MISMATCH', field: 'action', detail: 'wrong robot', nextAction: 'match'}]}
  const context = {kind: 'policy' as const, sceneId: 'scene', entityId: 'r1', worldId: 'world', expectedGeneration: 1, expectedRevision: 5, identity}
  const render = (importReceipt: any, worldId?: string) => act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, sceneId: 'scene', entityId: 'r1', worldId, worldStatus: 'ready', expectedRevision: 5, expectedGeneration: 1, command, targetLabel: 'Panda One', tr, importReceipt,
  } as never)))
  await render({filePath: '/fixture/policy.onnx', face: {state: blocked, identity}, context}, 'world')
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Incompatible with this instance')
  const next = document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(next.disabled).toBe(true)
  expect(next.textContent).not.toContain('Apply')
  // 缺 world：给出准备物理的不可点下一步，而不是对无 world 反复点必然失败的准备/应用。
  const noWorld = {...blocked, category: 'missing_files_or_runtime', missing: [{code: 'WORLD_REQUIRED', field: 'worldId', detail: 'no world', nextAction: 'match'}]}
  await render({filePath: '/fixture/policy.onnx', face: {state: noWorld, identity}, context: {...context, worldId: undefined}}, undefined)
  await flush()
  const worldNext = document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(worldNext.disabled).toBe(true)
  expect(worldNext.textContent).toBe('Prepare a physics world first')
}))

test('R-004：已准备但当前世界未重建 ⇒ Apply 可用并说明会重建世界；真不兼容仍禁用', withDom(async (root, flush) => {
  const identity = {provider: 'github', modelId: 'local/verified', revision: 'abcdef123456'}
  const command = async () => ({models: [], localEntries: []})
  const context = {kind: 'policy' as const, sceneId: 'scene', entityId: 'r1', worldId: 'world', expectedGeneration: 1, expectedRevision: 5, identity}
  // 服务端只返回“应用后会重建”的差异：ready=false 但 applyEligible=true ⇒ 必须能点 Apply。
  const applyReady = {category: 'direct_execution', ready: false, worldBound: true, applyEligible: true, policyPrepared: true, dimensions: {}, missing: [], nextActions: [], preApplyDifferences: [{path: 'controller.robot', reason: 'ROBOT_MODEL_MISMATCH', detail: 'Apply 会覆盖'}, {path: 'world.timestepS', reason: 'PHYSICS_FREQUENCY_MISMATCH', detail: 'Apply 会覆盖'}]}
  const render = (state: any) => act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, sceneId: 'scene', entityId: 'r1', worldId: 'world', worldStatus: 'ready', expectedRevision: 5, expectedGeneration: 1, command, targetLabel: 'Panda One', tr, importReceipt: {filePath: '/fixture/policy.onnx', face: {state, identity}, context},
  } as never)))
  await render(applyReady)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Ready to apply')
  // V10首屏使用短状态；世界重建影响仍须在主操作旁明确显示，不能只藏在技术详情。
  const impact = document.querySelector('[data-testid="policy-apply-impact"]')!
  expect(impact.textContent).toBe('Apply stops and rebuilds the selected world.')
  expect(impact.closest('details')).toBeNull()
  const next = document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(next.disabled).toBe(false)
  expect(next.textContent).toContain('Apply to instance')
  // 应用前差异如实列出，而不是伪装成缺项或谎称兼容。
  expect(document.querySelector('[data-testid="policy-pre-apply"]')!.textContent).toContain('controller.robot')
  // 真不兼容（fatal 缺项 + model_incompatible）仍不可 Apply。
  const fatal = {...applyReady, category: 'model_incompatible', applyEligible: false, missing: [{code: 'ROBOT_MODEL_MISMATCH', field: 'action.jointNames', detail: 'wrong body', nextAction: 'match'}]}
  await render(fatal)
  await flush()
  expect((document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement).disabled).toBe(true)
  expect((document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement).textContent).not.toContain('Apply')
}))


test('Policy：同一实例但世界代次/场景版本变化时旧回执不授予兼容', withDom(async (root, flush) => {
  const identity = {provider: 'github', modelId: 'local/verified', revision: 'abcdef123456'}
  const command = async () => ({models: [], localEntries: []})
  const ready = {category: 'direct_execution', ready: true, worldBound: true, applyEligible: true, dimensions: {}, missing: [], nextActions: [], policyPrepared: true}
  const context = {kind: 'policy' as const, sceneId: 'scene', entityId: 'r1', worldId: 'world', expectedGeneration: 1, expectedRevision: 5, identity}
  const receipt = {filePath: '/fixture/policy.onnx', face: {state: ready, identity}, context}
  const render = (expectedGeneration: number, expectedRevision: number) => act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, sceneId: 'scene', entityId: 'r1', worldId: 'world', worldStatus: 'ready', expectedRevision, expectedGeneration, command, targetLabel: 'Panda One', tr, importReceipt: receipt,
  } as never)))
  await render(1, 5)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Compatible with this instance')
  expect((document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement).textContent).toContain('Apply to instance')
  await render(2, 5)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Not checked')
  await render(1, 6)
  await flush()
  expect(document.querySelector('[data-testid="policy-compatibility"]')!.textContent).toBe('Not checked')
}))

test('Policy：无桌面选择器时首屏即可用本地路径导入，不必先开高级注册表单', withDom(async (root, flush) => {
  const calls: Array<{name: string; input: any}> = []
  const command = async (name: string, input: any) => { calls.push({name, input}); return name === 'policy_download_sources' ? {models: [], localEntries: []} : {category: 'weights_need_adapter', ready: false, dimensions: {}, missing: [], nextActions: [], policyPrepared: false} }
  await act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, canRegister: true, sceneId: 'scene', entityId: 'r1', worldId: 'world', worldStatus: 'ready', expectedRevision: 5, expectedGeneration: 1, command, targetLabel: 'Panda One', tr,
  } as never)))
  await flush()
  const main = document.querySelector('[data-testid="policy-main-path"]')!
  const input = main.querySelector('[data-testid="policy-main-path-input"]') as HTMLInputElement
  expect(input).not.toBeNull()
  // 输入在主路径首屏，不在折叠的 details 里。
  expect(input.closest('details')).toBeNull()
  const next = () => document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(next().disabled).toBe(true)
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { input.focus(); setValue.call(input, '/tmp/policy.onnx'); input.dispatchEvent(new window.Event('input', {bubbles: true})); input.dispatchEvent(new window.Event('change', {bubbles: true})); input.dispatchEvent(new window.KeyboardEvent('keyup', {key: '1', bubbles: true})) })
  await act(async () => input.blur())
  await flush()
  expect(next().disabled).toBe(false)
  expect(next().textContent).toBe('Register and check this path')
  await act(async () => next().click())
  await flush()
  // 走同一 importLocalPolicy → policy_load_local 链，不新建注册库。
  expect(calls.some(call => call.name === 'policy_load_local' && call.input.filePath === '/tmp/policy.onnx')).toBe(true)
}))

test('Policy：切换所选策略使在途旧检查回执作废，不把旧兼容结果套到新策略', withDom(async (root, flush) => {
  const identity = {provider: 'github', modelId: 'local/verified', revision: 'abcdef123456'}
  const entry = {id: 'local-1', label: 'panda.pt', registeredAt: '2026-10-15', available: true, sourceBytesVerified: false, identity}
  const second = {...entry, id: 'local-2', label: 'second.pt', identity: {...identity, modelId: 'local/second'}}
  const checked: string[] = []
  let finish: ((state: any) => void) | undefined
  const command = async (name: string, input: any) => {
    if (name === 'policy_download_sources') return {models: [], localEntries: [entry, second]}
    if (name === 'policy_load_state') { checked.push(input.entryId); return new Promise(resolve => { finish = resolve }) }
    return {}
  }
  const base = {category: 'weights_need_adapter', ready: false, dimensions: {}, missing: [], nextActions: [], policyPrepared: false}
  // 无上下文的旧回执：只复用登记条目/身份，初始状态仍为未检查。
  const receipt = {filePath: '/fixture/policy.onnx', entry, face: {state: base, identity}}
  await act(async () => root.render(createElement(PolicyLibraryPanel, {
    available: true, canLoad: true, sceneId: 'scene', entityId: 'r1', worldId: 'world', worldStatus: 'ready', expectedRevision: 5, expectedGeneration: 1, command, targetLabel: 'Panda One', tr, importReceipt: receipt,
  } as never)))
  await flush()
  const next = () => document.querySelector('[data-testid="policy-next"]') as HTMLButtonElement
  expect(next().textContent).toBe('Check compatibility')
  await act(async () => next().click())
  // 旧检查挂起期间改选另一策略：旧回执不得再落入状态。
  const chooser = document.querySelector('[data-testid="policy-choose"]') as HTMLSelectElement
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!; setter.call(chooser, 'entry:' + second.id); chooser.dispatchEvent(new window.Event('change', {bubbles: true})) })
  await act(async () => { finish?.({category: 'direct_execution', ready: true, worldBound: true, dimensions: {}, missing: [], nextActions: [], policyPrepared: true}) })
  await flush()
  expect(checked).toEqual(['local-1'])
  expect(next().textContent).not.toContain('Apply')
}))

test('原子动作：Start不冒充全world准备，Prepare physics是独立动作', withDom(async (root) => {
  const calls: string[] = []
  await act(async () => root.render(createElement(RobotAtomicActions, {
    tr, entityName: 'Panda One', canStart: false, startUnavailableReason: 'Target-level Start backend missing', canPrepare: true,
    onStart: () => calls.push('start'), onStop: () => calls.push('stop'), onPrepare: () => calls.push('prepare'),
  } as never)))
  const start = document.querySelector('[data-testid="robot-start"]') as HTMLButtonElement
  const prepare = document.querySelector('[data-testid="robot-prepare-physics"]') as HTMLButtonElement
  expect(start.disabled).toBe(true)
  expect(start.title).toContain('Target-level Start backend missing')
  expect(prepare.disabled).toBe(false)
  expect(document.querySelector('[data-testid="robot-start-unavailable"]')!.textContent).toContain('Target-level Start backend missing')
  await act(async () => prepare.click())
  expect(calls).toEqual(['prepare'])
}))

/**
 * 真实 Workbench 集成：Robots 首屏先目录/实例，点实例进二级详情并可返回；
 * 无物理世界时原生控制给出可发现入口（等待启动），不显示策略大表单。
 */
function workbenchFetch(scene: any) {
  const robotLibrary = {models: [libraryRow({packId: 'franka_panda', installed: true, resourceId: 'res-franka'})], blocked: [], registered: []}
  return (async (input: any, init?: RequestInit) => {
    const url = String(input)
    const data = url.includes('/state?') ? {hostInstanceId: 'host-rc', scene, worlds: [], providerAvailable: false}
      : url.includes('/robot-library') ? (init?.method === 'POST' ? robotLibrary : {models: robotLibrary.models})
      : url.includes('/scenes') ? [{sceneId: scene.sceneId}]
      : url.includes('/engine-preference') ? {engine: 'mujoco'}
      : url.includes('/selection') ? {updated: true}
      : url.includes('builtin-assets') ? {resources: []}
      : url.includes('/assets') || url.includes('missing-assets') ? []
      : []
    return Response.json(data)
  }) as typeof fetch
}

function installWorkbenchViewer() {
  viewerFactory = (options: any) => {
    const view = {position: [5, -6, 4], quaternion: [0, 0, 0, 1], target: [0, 0, .7], up: [0, 0, 1], fov: 50, near: .1, far: 1000, zoom: 1, navigation: 'orbit'}
    const observer = {mode: 'free', navigation: 'orbit', dirty: false, saving: false, scope: {}}
    const target: any = {options, renderer: {domElement: document.createElement('canvas')}, getViewState: () => view, setScene: () => Promise.resolve(), subscribeObserverState: () => () => {}, observerState: () => observer, environmentStatus: () => ({hdriMimeTypes: [], warnings: [], ignored: []}), collisionStatus: () => ({status: 'disabled'}), animationStatus: () => ({playing: false, clips: []}), dispose: () => {}}
    return new Proxy(target, {get(t, key) { if (key in t) return (t as any)[key]; return () => {} }})
  }
  ;(HTMLCanvasElement.prototype as any).getContext = () => null
}

test('真实 Workbench：Robots 首屏 → 实例详情 → 返回，无策略时原生控制入口可达', withDom(async (root, flush) => {
  const scene = {sceneId: 'rc-robot-scene', revision: 3, coordinates: {units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw'}, entities: [robotInstance('robot-1', 'Panda One')]}
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  globalThis.fetch = workbenchFetch(scene)
  installWorkbenchViewer()
  try {
    const {Workbench} = await import('../src/workbench.tsx')
    const {ToolRail} = await import('../src/tool-rail.tsx')
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Workbench, {sessionId: 'rc-p4', nativeTab: true, t: (key: string) => key === 'open' ? 'Scene workbench' : '场景工作台', renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
      createElement(ToolRail, {tr, engine: 'mujoco'}),
    )))
    await flush(320); await flush(320)
    const rail = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.lya-rail-item')].find(button => button.getAttribute('aria-label') === label)
    const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const pageVisible = (id: string) => { let node:HTMLElement|null=byTestId(id); while(node){ if(node.hasAttribute('hidden')||node.getAttribute('aria-hidden')==='true'||node.style.display==='none') return false; node=node.parentElement } return Boolean(byTestId(id)) }
    // 轨：可见标签是完整词（Recording/Terminal），完整名称在 aria-label/title。
    const recording = rail('Recording')!
    expect(recording.querySelector('.lya-rail-label')!.textContent).toBe('Recording')
    expect(rail('Terminal')!.querySelector('.lya-rail-label')!.textContent).toBe('Terminal')
    expect(rail('Camera')!.querySelector('.lya-rail-label')!.textContent).toBe('Camera')
    await act(async () => rail('Scene')!.click())
    await act(async () => rail('Robots')!.click())
    await flush()
    // V5 EN-25：默认先 Robot Library；场景实例在清楚的 In scene 页签里。
    expect(byTestId('robot-library')).not.toBeNull()
    expect(byTestId('robot-instance-robot-1')).toBeNull()
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.includes('In scene'))!.click() })
    await flush()
    expect(byTestId('robot-instance-robot-1')).not.toBeNull()
    expect(byTestId('policy-main-path')).toBeNull()
    // 点实例进入二级详情。
    await act(async () => (byTestId('robot-instance-robot-1') as HTMLButtonElement).click())
    await flush()
    expect(byTestId('robot-detail-header')).not.toBeNull()
    expect(byTestId('robot-name')!.textContent).toContain('Panda One')
    // V10：根页只有层级清单与原子控制；Policy/Joints/Configuration 是同栏独占二级页。
    const rootRows=byTestId('robot-detail-rows')!.querySelectorAll('.lya-list-row')
    expect(rootRows).toHaveLength(5)
    // V10：根页不再铺 5 行通用教程副标题；只留短任务名与真实当前值/计数。
    for(const row of rootRows)expect(row.querySelector('.lya-row-subtitle')).toBeNull()
    const rootText=byTestId('robot-detail-rows')!.textContent??''
    for(const tutorial of ['Open to select','Native joints','Inspect parts','Configure and preview real mounted cameras'])expect(rootText).not.toContain(tutorial)
    // 设计稿 robot-policy：Joint controls 在首行，Policy 紧随；Components/Mounted cameras 在后。
    expect(rootRows[0]!.textContent).toContain('Joint controls')
    expect(rootRows[1]!.textContent).toContain('Not configured')
    expect(rootRows[2]!.textContent).toContain('0')
    // 还未读取实例机位清单时不拿 Scene 自由机位总数冒充挂载数量。
    expect(rootRows[3]!.textContent).toContain('Mounted cameras')
    expect(rootRows[3]!.querySelector('.lya-row-side')).toBeNull()
    expect(pageVisible('robot-detail-root')).toBe(true)
    expect(pageVisible('robot-policy-page')).toBe(false)
    expect(pageVisible('robot-joints-page')).toBe(false)
    expect(pageVisible('robot-configuration-page')).toBe(false)
    expect(byTestId('policy-main-path')).not.toBeNull()
    // 身份只在顶部名称+状态一处；standalone/vN 版本行收进 Configuration 的 Instance details。
    expect(byTestId('robot-technical-details')!.querySelector('[data-testid="robot-identity"]')).not.toBeNull()
    expect(byTestId('robot-identity')!.closest('details')===byTestId('robot-technical-details')).toBe(true)
    expect(byTestId('robot-identity')!.textContent).not.toContain('Panda One')
    // Policy 二级页：从可见入口进入，父级根页不再同时可见。
    await act(async () => (byTestId('open-robot-policy') as HTMLButtonElement).click())
    await flush()
    expect(pageVisible('robot-detail-root')).toBe(false)
    expect(pageVisible('robot-policy-page')).toBe(true)
    expect(byTestId('policy-current')!.textContent).toBe('No policy configured')
    expect(byTestId('policy-compatibility')!.textContent).toBe('Not checked')
    expect(byTestId('policy-target')!.textContent).toBe('Panda One')
    const policyOwner=byTestId('policy-main-path')
    await act(async () => (byTestId('robot-policy-page')!.querySelector('.lya-back') as HTMLButtonElement).click())
    await flush()
    expect(pageVisible('robot-detail-root')).toBe(true)
    // Joint controls 二级页：无 world 时给等待启动提示。
    await act(async () => (byTestId('open-robot-joints') as HTMLButtonElement).click())
    await flush()
    expect(pageVisible('robot-joints-page')).toBe(true)
    expect(byTestId('robot-native-control-wait')).not.toBeNull()
    await act(async () => (byTestId('robot-joints-page')!.querySelector('.lya-back') as HTMLButtonElement).click())
    // Configuration 二级页：TCP/Base/History 具名分组默认收起，世界复位独立于 Stop。
    await act(async () => (byTestId('open-robot-configuration') as HTMLButtonElement).click())
    await flush()
    expect(pageVisible('robot-configuration-page')).toBe(true)
    for (const id of ['robot-base-tcp','robot-assembly-history','robot-tcp-advanced','robot-world-reset']) {
      const details=byTestId(id) as HTMLDetailsElement
      expect(details.tagName).toBe('DETAILS')
      expect(details.open).toBe(false)
    }
    expect(byTestId('robot-world-reset')!.contains(byTestId('robot-stop'))).toBe(false)
    await act(async () => (byTestId('robot-configuration-page')!.querySelector('.lya-back') as HTMLButtonElement).click())
    // 切回 Policy 仍是同一 owner 节点，不因切页重挂丢失草稿/在途回执。
    await act(async () => (byTestId('open-robot-policy') as HTMLButtonElement).click())
    expect(byTestId('policy-main-path')).toBe(policyOwner)
    await act(async () => (byTestId('robot-policy-page')!.querySelector('.lya-back') as HTMLButtonElement).click())
    // 根页：原子动作仍是 2x2，Freeze/Restore 按真实条件禁用。
    expect((byTestId('robot-freeze') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('robot-stop') as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId('robot-atomic-actions')!.querySelectorAll('.lya-robot-atomic-grid > button')).toHaveLength(4)
    // Start 只在有完整已配置目标或最后有效 recipe 时可用；无 world 时给短原因。
    const start = byTestId('robot-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.title).toContain('Prepare a physics world')
    expect(byTestId('robot-start-unavailable')!.textContent).toContain('Prepare a physics world')
    // 返回库清单，策略表单不再出现。
    await act(async () => byTestId('robot-back')!.click())
    await flush()
    expect(byTestId('robot-library')).not.toBeNull()
    expect(pageVisible('robot-detail-root')).toBe(false)
  } finally {
    if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch); else Reflect.deleteProperty(globalThis, 'fetch')
  }
}))

test('真实 Workbench：无机器人实例时先显示目录与真实空态，不铺策略表单', withDom(async (root, flush) => {
  const scene = {sceneId: 'rc-empty-scene', revision: 1, coordinates: {units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw'}, entities: []}
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  globalThis.fetch = workbenchFetch(scene)
  installWorkbenchViewer()
  try {
    const {Workbench} = await import('../src/workbench.tsx')
    const {ToolRail} = await import('../src/tool-rail.tsx')
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Workbench, {sessionId: 'rc-p4-empty', nativeTab: true, t: (key: string) => key === 'open' ? 'Scene workbench' : '场景工作台', renderSlot: (_n: any, _p: any, options: any) => options?.fallback ?? null} as any),
      createElement(ToolRail, {tr, engine: 'mujoco'}),
    )))
    await flush(320); await flush(320)
    const rail = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.lya-rail-item')].find(button => button.getAttribute('aria-label') === label)
    // 工具 store 是模块单例：先切到 Scene 再点 Robots，避免与上一个用例的打开态相消。
    await act(async () => rail('Scene')!.click())
    await act(async () => rail('Robots')!.click())
    await flush()
    expect(document.querySelector('[data-testid="robot-library"]')).not.toBeNull()
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.includes('In scene'))!.click() })
    await flush()
    expect(document.querySelector('[data-testid="robot-instance-empty"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="policy-main-path"]')).toBeNull()
  } finally {
    if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch); else Reflect.deleteProperty(globalThis, 'fetch')
  }
}))

// R-004 回执归属正负回归：迟到/旧代次回执不落地；Restore 的 mismatched/not-frozen 不是“已恢复”。
test('原子 Freeze/Restore 回执归属：旧代次不落地，Restore mismatch/not-frozen 不算已恢复', async () => {
  const {freezeReceiptMatchesWorld, freezeReceiptIsFrozen, restoreReceiptCleared} = await import('../src/atomic-freeze-state.ts')
  const bound = {worldId: 'w1', worldGeneration: 3}
  expect(freezeReceiptMatchesWorld({worldId: 'w1', generation: 3}, bound, bound)).toBe(true)
  expect(freezeReceiptMatchesWorld({worldId: 'w1', generation: 2}, bound, bound), '旧代次回执不得落地').toBe(false)
  expect(freezeReceiptMatchesWorld({worldId: 'w1', generation: 3}, bound, {worldId: 'w2', worldGeneration: 3}), 'world 已切换不得落地').toBe(false)
  expect(freezeReceiptMatchesWorld({worldId: 'w1', generation: 3}, bound, undefined), 'world 已关闭不得落地').toBe(false)
  expect(freezeReceiptIsFrozen({status: 'frozen'})).toBe(true)
  expect(freezeReceiptIsFrozen({status: 'already-frozen'})).toBe(true)
  expect(freezeReceiptIsFrozen({status: 'not-found'}), '未找到不是已冻结').toBe(false)
  expect(restoreReceiptCleared({status: 'restored'})).toBe(true)
  expect(restoreReceiptCleared({status: 'mismatched'}), 'freezeId 不匹配仍是冻结').toBe(false)
  expect(restoreReceiptCleared({status: 'not-frozen'}), '后端未冻结不能清本地冻结态').toBe(false)
})

// T7 / P12-P13：库行缩略图与资源详情海报图都来自 pack 显式登记且经供给 inventory/SHA 复核的
// 官方位图（row.previewPath → 既有 model-preview 字节路由 URL）。未登记的行保持几何占位图标；
// 位图加载失败如实回落占位，不残留破图；详情页实时预览不可用时海报图仍是真实资产。
test('P12/P13：库行真缩略图与详情海报图，无图/加载失败如实回落占位', withDom(async (root, flush) => {
  const bytesURL = (path: string) => `/api/lyapunov/model-preview?path=${encodeURIComponent(path)}`
  const rows = [
    libraryRow({packId: 'franka_panda', previewPath: '/packs/franka_panda/asset/franka_emika_panda/panda.png'}),
    libraryRow({packId: 'unitree_go1', resourceId: 'res-go1'}),
  ]
  const render = (selectedPackId?: string) => act(async () => root.render(createElement(RobotLibrarySection, {
    tr, rows, rowsBusy: false, rowsError: '', query: '', setQuery: () => {}, tab: 'builtin', setTab: () => {}, imported: [], canMount: true, available: true,
    selectedPackId, onSelectPack: () => {}, onAdd: () => {}, onMount: () => {}, onImport: () => {}, onRefresh: () => {},
    sessionId: 's1', previewBytesURL: bytesURL,
  } as never)))
  await render()
  // 有登记预览图的行显示真位图（经原生字节路由寻址）；没有登记的行保持几何占位图标。
  const pandaImg = document.querySelector('[data-testid="robot-library-row-franka_panda"] .lya-row-thumb img') as HTMLImageElement | null
  expect(pandaImg).not.toBeNull()
  expect(pandaImg!.src).toContain('/api/lyapunov/model-preview?path=')
  expect(decodeURIComponent(pandaImg!.src)).toContain('panda.png')
  const go1Row = document.querySelector('[data-testid="robot-library-row-unitree_go1"]')!
  expect(go1Row.querySelector('.lya-row-thumb')).toBeNull()
  expect(go1Row.querySelector('.lya-row-icon')).not.toBeNull()
  // 位图加载失败：回到占位图标，不残留破图。
  const WinEvent = (globalThis as unknown as {window?: {Event?: typeof Event}}).window?.Event
  const errorEvent = WinEvent ? new WinEvent('error') : (() => { const event = document.createEvent('Event'); event.initEvent('error', true, true); return event })()
  await act(async () => { pandaImg!.dispatchEvent(errorEvent) })
  expect(document.querySelector('[data-testid="robot-library-row-franka_panda"] .lya-row-thumb')).toBeNull()
  expect(document.querySelector('[data-testid="robot-library-row-franka_panda"] .lya-row-icon')).not.toBeNull()
  // 详情页：实时预览 RPC 缺席时，舞台底衬是该 pack 的官方预览位图（真实资产），错误如实提示不拿图冒充渲染。
  await render('franka_panda')
  await act(async () => (document.querySelector('[data-testid="robot-library-details"]') as HTMLButtonElement).click())
  await flush()
  const preview = document.querySelector('[data-testid="robot-resource-preview"]')!
  expect(preview.getAttribute('data-poster')).toBe('true')
  const poster = preview.querySelector('[data-testid="robot-resource-preview-poster"]') as HTMLImageElement | null
  expect(poster).not.toBeNull()
  expect(decodeURIComponent(poster!.src)).toContain('panda.png')
  expect(preview.getAttribute('data-status')).toBe('failed')
  expect(preview.textContent).toContain('Preview API is unavailable')
}))

// 主控复核：控制器类型不是策略/VLA已配置的证据。
test('策略摘要不把drone类型当作VLA，也不输出空适配器',async()=>{
 const {robotPolicyCaption}=await import('../src/robot-library-panel.tsx')
 const tr=(_zh:string,en:string)=>en
 expect(robotPolicyCaption({type:'drone'},tr)).toBe('Not configured')
 expect(robotPolicyCaption({policyAdapter:' '},tr)).toBe('Not configured')
 expect(robotPolicyCaption({policyAdapter:'actual-adapter'},tr)).toBe('actual-adapter')
})
