/**
 * R-014 UI：RobotAuthoringPanel 把"已保存/物理待同步"、Retry sync、局部 Undo、冲突与切实体后的
 * 旧回执隔离显示成用户可读状态。真实 React 组件 + jsdom；不接触真实 HTTP/引擎。
 */
import { test, expect } from 'bun:test'

const identity = () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
const baseState = { mode: 'fixed', bodyName: 'mount', source: 'scene-base-binding', reason: 'Scene attachment', constraints: [], editable: { fixed: true, free: true, entity: true }, worldFromBody: { positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1] } }
const fixture = (entityId: string) => ({
  entity: { entityId, name: entityId, transform: identity(), resources: [], components: {} } as never,
  scene: { sceneId: 's', revision: 1, coordinates: { units: 'm', upAxis: 'Z', handedness: 'right', quaternion: 'xyzw' }, entities: [{ entityId, name: entityId, transform: identity(), resources: [], components: {} }] } as never,
  world: { worldId: 'w', sceneId: 's', engineId: 'mujoco', engineVersion: '3', worldGeneration: 1, appliedSceneRevision: 1, status: 'ready' } as never,
  frame: { worldId: 'w', generation: 1, sceneRevision: 1, stepIndex: 0, entities: [{ entityId, joints: { names: [], positions: [] }, sensors: { robotBase: baseState, bodyWorldPoses: {} } }] } as never,
  description: { entityId, expectedGeneration: 1, nativeBodies: [{ name: 'mount', root: true, jointTypes: [] }], nativeSites: [], base: baseState } as never,
})

async function withJsdom(fn: (env: any) => Promise<void>) {
  const { createRequire } = await import('node:module')
  const req = createRequire(new URL('../../../.upstream/deepseek-harness-20260911-candidate/package.json', import.meta.url))
  const { JSDOM } = req('jsdom')
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture.invalid', pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'navigator', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
  try { await fn(dom) } finally {
    dom.window.close()
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) }
  }
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
const flush = async (act: any) => { await act(async () => { await Promise.resolve(); await new Promise(done => setTimeout(done, 0)) }) }

test('RobotAuthoringPanel：Saved·Physics sync required 显示 Retry/Undo，历史冲突不覆盖并显示原因', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    const calls: Array<{ name: string; input: any }> = []
    const change = { sceneId: 's', entityId: 'child', field: 'baseBinding', beforeRevision: 1, afterRevision: 2, before: { mode: 'fixed', bodyName: 'mount' }, after: { mode: 'free', bodyName: 'mount' }, undoable: true }
    const configure = async (name: string, input: any) => {
      calls.push({ name, input })
      return { status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, revision: 2, sceneId: 's', entityId: 'child', reason: 'ROBOT_CONFIGURATION_SYNC_FAILED: 配置已保存为场景版本 2，原生世界未就绪；请使用同步重试。', assembly: change }
    }
    const undo = async (entry: any) => { calls.push({ name: 'robot_assembly_undo', input: entry }); return { status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, revision: 3 } }
    const history = async () => ({ sceneId: 's', entityId: 'child', revision: 3, inspected: 2, entries: [change, { ...change, afterRevision: 1, undoable: false, reason: 'ROBOT_ASSEMBLY_CONFLICT: 目标绑定在之后又被编辑；拒绝覆盖后续改动。' }] })
    let retry = 0
    const retrySync = async () => { retry++; return { saved: true, sync: 'SYNCED', syncRequired: false, revision: 2 } }
    const props: any = { ...fixture('child'), ready: true, tr, configure, history, undo, retrySync, sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}) }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, props)))
      await flush(act)
      // 解除固定 → 保存成功但物理待同步。
      await act(async () => { byText('Release base')!.click() })
      await flush(act)
      expect(calls[0]!.name).toBe('robot_set_base')
      const notice = byTestId('robot-assembly-sync-required')!
      expect(notice.textContent).toContain('Assembly saved · Physics sync required')
      expect(notice.textContent).toContain('rev 2')
      expect(byTestId('robot-assembly-retry-sync')).not.toBeNull()
      // Retry sync 走同一入口；成功后物理待同步块消失。
      await act(async () => { byTestId('robot-assembly-retry-sync')!.click() })
      await flush(act)
      expect(retry).toBe(1)
      expect(byTestId('robot-assembly-sync-required')).toBeNull()
      // 再保存一次得到待同步回执：Undo assembly 用回执里的 before/after 定位。
      await act(async () => { byText('Release base')!.click() })
      await flush(act)
      await act(async () => { byTestId('robot-assembly-undo-last')!.click() })
      await flush(act)
      expect(calls.some(call => call.name === 'robot_assembly_undo' && call.input === change)).toBe(true)
      // 历史：可撤销行可点，冲突行明确显示且按钮禁用。
      await act(async () => { byTestId('robot-assembly-history-refresh')!.click() })
      await flush(act)
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="robot-assembly-history-row"]')]
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain('rev 1 → 2')
      expect(rows[0]!.querySelector('button')!.disabled).toBe(false)
      expect(rows[1]!.textContent).toContain('Conflict')
      expect(rows[1]!.querySelector('button')!.disabled).toBe(true)
    } finally { await act(async () => root.unmount()) }
  })
})

test('RobotAuthoringPanel：Undo 冲突在界面上报错；切实体后旧异步回执不串用', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    // 第一次 configure 挂起，等实体切换后再解决：旧回执不得写进新目标。
    let resolveConfigure: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { resolveConfigure = resolve })
    const configure = () => pending
    const change = { sceneId: 's', entityId: 'child', field: 'baseBinding', beforeRevision: 1, afterRevision: 2, before: { mode: 'fixed' }, after: { mode: 'free' }, undoable: true }
    const undo = async () => { throw new Error('ROBOT_ASSEMBLY_CONFLICT: 目标绑定在之后又被编辑，拒绝覆盖。') }
    const history = async () => ({ sceneId: 's', entityId: 'child', revision: 3, inspected: 1, entries: [{ ...change, undoable: true }] })
    const base: any = { ready: true, tr, configure, history, undo, retrySync: async () => ({}), sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}) }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, { ...base, ...fixture('child') })))
      await flush(act)
      await act(async () => { byText('Release base')!.click() })
      // 切实体：新目标的表单与状态必须重置，旧请求的 token 作废。
      await act(async () => root.render(createElement(RobotAuthoringPanel, { ...base, ...fixture('child-2') })))
      await flush(act)
      resolveConfigure({ status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, revision: 2, reason: 'late', assembly: change })
      await flush(act)
      expect(byTestId('robot-assembly-sync-required')).toBeNull()
      // 冲突 Undo 如实显示错误，不静默。
      await act(async () => { byTestId('robot-assembly-history-refresh')!.click() })
      await flush(act)
      await act(async () => { byTestId('robot-assembly-history-row')!.querySelector('button')!.click() })
      await flush(act)
      expect(byTestId('robot-configuration-error')!.textContent).toContain('ROBOT_ASSEMBLY_CONFLICT')
    } finally { await act(async () => root.unmount()) }
  })
})

test('RobotAuthoringPanel：保存后机器人详情读回不可用仍保留已保存阶段，原因在按需详情', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    const configure = async () => ({
      status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, revision: 4, sceneId: 's', entityId: 'child',
      robotDetail: { status: 'UNAVAILABLE', reason: 'ROBOT_DESCRIPTION_READBACK_FAILED: 装配已保存为场景版本 4；机器人详情读回不可用。' },
    })
    const props: any = {
      ...fixture('child'), ready: true, tr, configure,
      history: async () => ({ sceneId: 's', entityId: 'child', revision: 4, inspected: 0, entries: [], historyComplete: true }),
      undo: async () => ({}), retrySync: async () => ({}), sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}),
    }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, props)))
      await flush(act)
      await act(async () => { byText('Release base')!.click() })
      await flush(act)
      // 保存阶段文案来自回执，不因详情读回失败而丢失。
      expect(byTestId('robot-configuration-stage')!.textContent).toContain('Assembly saved and synced')
      expect(byTestId('robot-configuration-stage')!.textContent).toContain('rev 4')
      const detail = byTestId('robot-configuration-detail')!
      expect(detail.textContent).toContain('Saved; robot details are unavailable.')
      expect(detail.textContent).toContain('ROBOT_DESCRIPTION_READBACK_FAILED')
      expect(byTestId('robot-assembly-sync-required')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})

test('RobotAuthoringPanel：同步与冲突原因进入按需详情，主状态保持简短英文', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    const change = { sceneId: 's', entityId: 'child', field: 'baseBinding', beforeRevision: 1, afterRevision: 2, before: { mode: 'fixed', bodyName: 'mount' }, after: { mode: 'free', bodyName: 'mount' }, undoable: true }
    const conflict = { ...change, afterRevision: 1, undoable: false, reason: 'ROBOT_ASSEMBLY_RESOURCE_CHANGED: 这次变化替换了模型资源，单字段逆操作不代表完整装配撤销。' }
    const configure = async () => ({
      status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, revision: 5, sceneId: 's', entityId: 'child',
      reason: 'ROBOT_CONFIGURATION_WORLD_NOT_OPEN: 配置已保存为场景版本 5，但当前没有可同步的原生世界；声明已恢复，物理待同步。',
      assembly: change,
    })
    const props: any = {
      ...fixture('child'), ready: true, tr, configure,
      history: async () => ({ sceneId: 's', entityId: 'child', revision: 5, inspected: 2, entries: [change, conflict], historyComplete: false, reason: 'ROBOT_ASSEMBLY_HISTORY_GAP: 既有 Scene 历史缺少中间版本。' }),
      undo: async () => ({}), retrySync: async () => ({}), sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}),
    }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, props)))
      await flush(act)
      await act(async () => { byText('Release base')!.click() })
      await flush(act)
      const notice = byTestId('robot-assembly-sync-required')!
      expect(notice.textContent).toContain('Assembly saved · Physics sync required')
      const syncDetail = byTestId('robot-assembly-sync-detail')!
      expect(syncDetail.textContent).toContain('ROBOT_CONFIGURATION_WORLD_NOT_OPEN')
      // 历史：冲突行简短英文 + 原始诊断进详情，按钮禁用。
      await act(async () => { byTestId('robot-assembly-history-refresh')!.click() })
      await flush(act)
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="robot-assembly-history-row"]')]
      expect(rows[1]!.textContent).toContain('Conflict')
      expect(rows[1]!.querySelector('button')!.disabled).toBe(true)
      expect(rows[1]!.querySelector('[data-testid="robot-assembly-history-detail"]')!.textContent).toContain('ROBOT_ASSEMBLY_RESOURCE_CHANGED')
    } finally { await act(async () => root.unmount()) }
  })
})

test('RobotAuthoringPanel：history 的 Replace 成组条目给出 Undo replacement 入口，冲突整组禁用', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    const group = {
      operationId: 'replace-fixture', targetEntityId: 'panda', targetBodyName: 'attachment', beforeRevision: 1, afterRevision: 2,
      members: [
        { entityId: 'new-hand', field: 'baseBinding', role: 'new', peerEntityId: 'old-hand' },
        { entityId: 'old-hand', field: 'baseBinding', role: 'old', peerEntityId: 'new-hand' },
      ],
      undoable: true,
    }
    const conflictGroup = { ...group, operationId: 'replace-conflict', undoable: false, reason: 'ROBOT_ASSEMBLY_CONFLICT: 成员 old-hand 的绑定在之后又被编辑；整组拒绝。' }
    const calls: any[] = []
    const props: any = {
      ...fixture('child'), ready: true, tr, configure: async () => ({}),
      history: async () => ({ sceneId: 's', entityId: 'child', revision: 3, inspected: 2, entries: [], historyComplete: true, replacements: [group, conflictGroup] }),
      undo: async () => ({}),
      undoReplace: async (value: any) => { calls.push(value); return { status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, revision: 4 } },
      retrySync: async () => ({}), sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}),
    }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, props)))
      await flush(act)
      await act(async () => { byTestId('robot-assembly-history-refresh')!.click() })
      await flush(act)
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="robot-assembly-replace-row"]')]
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain('new-hand + old-hand')
      // 可撤销组：入口可点，调用整组 undo，而不是只恢复一只手。
      await act(async () => { rows[0]!.querySelector('button')!.click() })
      await flush(act)
      expect(calls).toEqual([group])
      // 冲突组：按钮禁用且原因在按需详情里。
      expect(rows[1]!.textContent).toContain('Conflict')
      expect(rows[1]!.querySelector('button')!.disabled).toBe(true)
      expect(rows[1]!.querySelector('[data-testid="robot-assembly-replace-detail"]')!.textContent).toContain('ROBOT_ASSEMBLY_CONFLICT')
    } finally { await act(async () => root.unmount()) }
  })
})

test('RobotAuthoringPanel：history 的 subtreePartitions 给出 Undo extract / Undo reassembly 入口，冲突禁用', async () => {
  await withJsdom(async () => {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { RobotAuthoringPanel } = await import('../src/robot-authoring-panel.tsx')
    const tr = (_zh: string, en: string) => en
    const extract = { operationId: 'subtree-extract-1', role: 'extract', remainingEntityId: 'panda', partEntityId: 'hand-part', beforeRevision: 1, afterRevision: 2, undoable: true }
    const reassemble = { operationId: 'subtree-reassemble-1', role: 'reassemble', remainingEntityId: 'panda', partEntityId: 'hand-part', beforeRevision: 3, afterRevision: 4, undoable: true }
    const conflict = { ...extract, operationId: 'subtree-conflict', undoable: false, reason: 'ROBOT_ASSEMBLY_CONFLICT: remaining 资源身份已变化。' }
    const calls: any[] = []
    const props: any = {
      ...fixture('child'), ready: true, tr, configure: async () => ({}),
      history: async () => ({ sceneId: 's', entityId: 'child', revision: 5, inspected: 4, entries: [], historyComplete: true, subtreePartitions: [extract, reassemble, conflict] }),
      undo: async () => ({}),
      undoSubtree: async (value: any) => { calls.push(value); return { status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, revision: 6 } },
      retrySync: async () => ({}), sync: () => {}, moveTcp: async () => ({}), stop: () => {}, reset: () => {}, editPosition: () => {}, locate: () => ({}),
    }
    const root = createRoot(document.getElementById('root')!)
    try {
      await act(async () => root.render(createElement(RobotAuthoringPanel, props)))
      await flush(act)
      await act(async () => { byTestId('robot-assembly-history-refresh')!.click() })
      await flush(act)
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="robot-assembly-subtree-row"]')]
      expect(rows).toHaveLength(3)
      expect(rows[0]!.textContent).toContain('Internal extract')
      expect(rows[0]!.textContent).toContain('panda + hand-part')
      await act(async () => { rows[0]!.querySelector('button')!.click() })
      await flush(act)
      expect(calls).toEqual([extract])
      expect(rows[1]!.textContent).toContain('Internal reassemble')
      await act(async () => { rows[1]!.querySelector('button')!.click() })
      await flush(act)
      expect(calls).toEqual([extract, reassemble])
      expect(rows[2]!.textContent).toContain('Conflict')
      expect(rows[2]!.querySelector('button')!.disabled).toBe(true)
      expect(rows[2]!.querySelector('[data-testid="robot-assembly-subtree-detail"]')!.textContent).toContain('ROBOT_ASSEMBLY_CONFLICT')
    } finally { await act(async () => root.unmount()) }
  })
})
