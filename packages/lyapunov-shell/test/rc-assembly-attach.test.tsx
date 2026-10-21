/**
 * P5 R-012：Attach to 二级面板的行为回归（真 React 组件 + 真 DOM，jsdom）。
 *
 * 边界：preview/apply 是测试替身，验证的是**面板把四项身份收对、走同一条预览→应用→取消路径**。
 * 真实只读预览的数学与拒绝面在 packages/robot-tools/test/assembly-preview.test.ts；真实浏览器布局
 * 与 Viewer ghost 由主控独立核验，本文件不冒充浏览器验收。
 */
import {test, expect} from 'bun:test'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {createElement, act, useState} from 'react'
import {createRoot} from 'react-dom/client'

const {AssemblyAttachPanel} = await import('../src/assembly-attach-panel.tsx')
import type {AssemblyAttachSelection, AssemblyParkingPickController, AssemblyReplaceRequest, AssemblyReplaceSubmit, AssemblyTargetDescription} from '../src/assembly-attach-panel.tsx'
import type {RobotAnchorPose, RobotAssemblyCheckResult, RobotAssemblyPreviewResult, RobotSetBaseInput} from '../../lyapunov-contracts/src/robot-authoring.ts'
import {assemblyReadbackIdentity} from '../src/workbench-state-order.ts'

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

const describeTarget = async (entityId: string): Promise<AssemblyTargetDescription> => entityId === 'panda'
  ? {bodies: [{name: 'base', root: true}, {name: 'attachment', root: false}, {name: 'wrist_3_link', root: false}], sites: [{name: 'attachment_site', bodyName: 'attachment'}, {name: 'wrist_site', bodyName: 'wrist_3_link'}]}
  : {bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}
const applyInput: RobotSetBaseInput = {worldId: 'w', sceneId: 's', entityId: 'hand', expectedRevision: 5, expectedGeneration: 2, base: {mode: 'fixed', bodyName: 'palm', target: {entityId: 'panda', bodyName: 'attachment', positionM: [0.1, 0.2, 0.3], quaternionXyzw: [0, 0, 0, 1]}}}
const previewResult: RobotAssemblyPreviewResult = {
  status: 'PREVIEW', applied: false, sceneId: 's', worldId: 'w', revision: 5, generation: 2,
  source: {entityId: 'hand', name: 'Allegro Hand', rootBodyName: 'palm'},
  target: {entityId: 'panda', name: 'Panda One', bodyName: 'attachment'},
  sourceMount: {kind: 'site', label: 'palm/palm_mount', bodyName: 'palm', positionM: [-0.0093, 0, -0.095], quaternionXyzw: [0, 0, 0, 1]},
  targetMount: {kind: 'site', label: 'attachment/attachment_site', bodyName: 'attachment', positionM: [0, 0, 0.05], quaternionXyzw: [0, 0, 0, 1]},
  pair: {positionM: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1]},
  targetBodyFromSourceRoot: {positionM: [0.1, 0.2, 0.3], quaternionXyzw: [0, 0, 0, 1]},
  frame: {worldId: 'w', generation: 2, sceneRevision: 5, frameId: 'f-5', stepIndex: 7},
  applyInput, notes: ['Read-only preview.'],
}
const selectValue = async (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => { setter.call(select, value); select.dispatchEvent(new window.Event('change', {bubbles: true})) })
}
/** 折叠内的元素按真实交互先展开，再选择/读回；不靠“jsdom 里看不见也能点”绕过折叠。 */
const openDetails = async (id: string) => {
  const node = document.querySelector<HTMLDetailsElement>(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing <details data-testid="${id}">`)
  await act(async () => { node.open = true; node.dispatchEvent(new window.Event('toggle', {bubbles: true})) })
}
const openAlignment = () => openDetails('assembly-attach-alignment')

test('Attach 面板：源/目标身份收口 → Preview → Apply 用同一 applyInput → Cancel 清 ghost', withDom(async (root, flush) => {
  const selections: AssemblyAttachSelection[] = [], applied: RobotSetBaseInput[] = [], ghosts: Array<RobotAssemblyPreviewResult | null> = [], backs: number[] = [], frames: number[] = []
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    tr,
    source: {entityId: 'hand', name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}, {entityId: 'ur10e', name: 'UR10e'}],
    describeTarget,
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}),
    preview: async (selection: AssemblyAttachSelection) => { selections.push(selection); return previewResult },
    apply: async (input: RobotSetBaseInput) => { applied.push(input); return {status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, sceneId: 's', revision: 6, entityId: 'hand', snapshot: {}} },
    onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value),
    onFramePreview: () => frames.push(1),
    onBack: () => backs.push(1),
  } as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  expect(byTestId('assembly-attach-source-name')!.textContent).toContain('Allegro Hand')
  expect((byTestId('assembly-attach-target') as HTMLSelectElement).value).toBe('panda')
  // 源 body/site 折叠在 Alignment：先展开再选真实事实。
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  expect(byTestId('assembly-attach-target-site')).not.toBeNull()
  // 非根 body 有 site：不显示"先提取"提示（它本身是可挂接的固定接口）。
  expect(byTestId('assembly-attach-extract-hint')).toBeNull()
  // Preview：面板把四项身份原样交给宿主，不自己编 identity。
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  expect(selections).toHaveLength(1)
  expect(selections[0]).toMatchObject({sourceEntityId: 'hand', targetEntityId: 'panda', targetBodyName: 'attachment', targetMount: {kind: 'body-origin'}})
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Preview · not applied')
  await openDetails('assembly-attach-details')
  expect(byTestId('assembly-attach-result')).not.toBeNull()
  expect(byTestId('assembly-attach-result-source')!.textContent).toContain('palm/palm_mount')
  expect(byTestId('assembly-attach-result-target')!.textContent).toContain('attachment/attachment_site')
  expect(ghosts.at(-1)).not.toBeNull()
  // V10：Preview 后可显式框选目标与 ghost；只移动查看相机，不提交绑定。
  await act(async () => (byTestId('assembly-attach-frame-preview') as HTMLButtonElement).click())
  expect(frames).toEqual([1])
  expect(ghosts.at(-1)).not.toBeNull()
  // Apply：入参就是预览返回的 applyInput，原样走同一 robot_set_base 路径。
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(applied).toEqual([applyInput])
  // 已保存后进入独占结果页；显式 Back 清预览与 ghost，返回原来源上下文。
  expect(byTestId('assembly-attach-result-page')).not.toBeNull()
  expect(byTestId('assembly-attach-primary')).toBeNull()
  expect(byTestId('assembly-attach-preview')).toBeNull()
  expect(byTestId('assembly-attach-apply')).toBeNull()
  await act(async () => (byTestId('assembly-attach-back') as HTMLButtonElement).click())
  expect(ghosts.at(-1)).toBeNull()
  expect(backs).toHaveLength(1)
  expect(byTestId('assembly-attach-result')).toBeNull()
}))

test('Attach 面板：目标非根连杆是正常安装目标（不要求提取），源内部部件才要求先提取', withDom(async (root, flush) => {
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    tr,
    source: {entityId: 'hand', name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'base', root: true}, {name: 'inner_wrist', root: false}], sites: []}),
    preview: async () => previewResult,
    apply: async () => ({}),
  } as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'inner_wrist')
  // 目标非根 body 是正常安装目标：不显示“先提取”，只显示正常说明。
  expect(byTestId('assembly-attach-extract-hint')).toBeNull()
  expect(byTestId('assembly-attach-target-note')).not.toBeNull()
  // Apply 在预览前保持禁用，不给假成功入口。
  expect((byTestId('assembly-attach-apply') as HTMLButtonElement).disabled).toBe(true)

  // 源选中内部部件（非根）：明确要求先提取，不把整机当源，Preview 不可执行。
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    key: 'source-part-test',
    tr,
    source: {entityId: 'hand', name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'base', root: true}, {name: 'attachment', root: false}], sites: []}),
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}, {name: 'finger', root: false}], sites: []}),
    sourcePart: {name: 'finger', root: false},
    preview: async () => previewResult,
    apply: async () => ({}),
  } as never)))
  await flush()
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  expect(byTestId('assembly-attach-extract-hint')!.textContent).toContain('finger')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(true)
}))

test('V8 首屏：短资源名、无首屏 UUID/长矩阵、不自动生成源；Alignment 显式选真实 body 后 Preview，Details 读回', withDom(async (root, flush) => {
  const longId = 'Allegro-Hand#9f3c2b71-2e04-4c7a-a6f0-51d0f3f3d2ab'
  const result: RobotAssemblyPreviewResult = {...previewResult, source: {...previewResult.source, entityId: longId}, applyInput: {...previewResult.applyInput, entityId: longId}}
  const props = {
    tr,
    source: {entityId: longId, name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget,
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}),
    preview: async () => result,
    apply: async () => ({}),
  }
  await act(async () => root.render(createElement(AssemblyAttachPanel, props as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const primary = byTestId('assembly-attach-primary')!
  // 首屏只用短名；UUID 只在 title/Technical details，长 pose/矩阵不进首屏。
  expect(byTestId('assembly-attach-source-name')!.textContent).toContain('Allegro Hand')
  expect(byTestId('assembly-attach-source-name')!.getAttribute('title')).toBe(longId)
  expect(primary.textContent).not.toContain(longId)
  expect(primary.textContent).not.toContain('] m · [')
  expect(byTestId('assembly-attach-source-status')!.textContent).toContain('not set')
  expect(byTestId('assembly-attach-alignment-hint')!.textContent).toContain('required')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(true)
  // 不自动猜根 site/body：未选时源安装面保持未设置，用户可一键展开 Alignment 显式选择。
  expect((byTestId('assembly-attach-source-body') as HTMLSelectElement).value).toBe('')
  await act(async () => (byTestId('assembly-attach-source-choose') as HTMLButtonElement).click())
  expect((byTestId('assembly-attach-alignment') as HTMLDetailsElement).open).toBe(true)
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, `${longId}|palm`)
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(false)
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Preview · not applied')
  expect(primary.textContent).not.toContain('] m · [')
  await openDetails('assembly-attach-details')
  expect(byTestId('assembly-attach-result-source')!.textContent).toContain('palm/palm_mount')
  expect(byTestId('assembly-attach-result-target')!.textContent).toContain('attachment/attachment_site')
  expect(byTestId('assembly-attach-result-frame')!.textContent).toContain('f-5')
  expect(byTestId('assembly-attach-technical')!.textContent).toContain(longId)
  // 同代守卫：world 代次前进后旧预览不再允许 Apply。
  expect((byTestId('assembly-attach-apply') as HTMLButtonElement).disabled).toBe(false)
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...props, world: {ready: true, phase: 'running', generation: 3, sceneRevision: 5}} as never)))
  await flush()
  expect((byTestId('assembly-attach-apply') as HTMLButtonElement).disabled).toBe(true)
}))

const replaceRequest: AssemblyReplaceRequest = {
  oldEntityId: 'old-hand', oldName: 'Old Hand',
  targetEntityId: 'panda', targetBodyName: 'attachment',
  targetMountPose: {positionM: [-0.0093, 0, -0.095], quaternionXyzw: [0, 0, 0, 1]},
  defaultParkingPose: {positionM: [0.4, 0.1, 0.2], quaternionXyzw: [0, 0, 0, 1]},
}

test('Replace 模式：目标=旧件安装位、新件 sourceMount 参与预览、旧件停放 ghost 与一次提交', withDom(async (root, flush) => {
  const selections: AssemblyAttachSelection[] = [], submits: AssemblyReplaceSubmit[] = [], parking: Array<{positionM: number[]; quaternionXyzw: number[]} | null> = []
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    tr,
    source: {entityId: 'hand', name: 'New Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget,
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}),
    preview: async (selection: AssemblyAttachSelection) => { selections.push(selection); return previewResult },
    apply: async () => ({}),
    replace: replaceRequest,
    onReplace: async (submit: AssemblyReplaceSubmit) => { submits.push(submit); return {} },
    onParkingGhost: (pose: {positionM: number[]; quaternionXyzw: number[]} | null) => parking.push(pose),
    onBack: () => {},
  } as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  // 目标由旧件决定：不在下拉里自由改，也没有 target site（安装位是旧件记录的 body-local pose）。
  expect((byTestId('assembly-attach-target') as HTMLSelectElement).disabled).toBe(true)
  expect((byTestId('assembly-attach-target-body') as HTMLSelectElement).value).toBe('attachment')
  expect(byTestId('assembly-attach-target-site')).toBeNull()
  // 旧件去向区可见，默认停放位已通知宿主（临时停放几何）。
  expect(byTestId('assembly-attach-parking')).not.toBeNull()
  expect(parking.at(-1)).toMatchObject({positionM: [0.4, 0.1, 0.2]})
  // 新件自己的源安装面（保存点/body）进入预览；targetMount 是旧件记录的安装位 pose。
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  expect(selections).toHaveLength(1)
  expect(selections[0]).toMatchObject({sourceEntityId: 'hand', targetEntityId: 'panda', targetBodyName: 'attachment', targetMount: {kind: 'pose'}})
  expect(selections[0]!.targetMount).toEqual({kind: 'pose', pose: replaceRequest.targetMountPose})
  await openDetails('assembly-attach-details')
  expect(byTestId('assembly-attach-result-parking')!.textContent).toContain('0.400')
  // 用户改停放位（离开安装位），确认时提交的就是新件预览 base + 该停放位。
  const parkingX = byTestId('assembly-attach-parking')!.querySelector('input[aria-label="parking X"]') as HTMLInputElement
  await act(async () => { const {Simulate} = await import('react-dom/test-utils'); Simulate.change(parkingX, {target: {value: '0.7'}} as never) })
  await flush()
  expect(parkingX.value).toBe('0.7')
  expect(parking.at(-1)).toMatchObject({positionM: [0.7, 0.1, 0.2]})
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(submits).toHaveLength(1)
  expect(submits[0]!.newEntityId).toBe('hand')
  expect(submits[0]!.newBase).toEqual(applyInput.base)
  expect(submits[0]!.oldEntityId).toBe('old-hand')
  expect(submits[0]!.oldParkingPose.positionM[0]).toBeCloseTo(0.7)
  expect(submits[0]!.oldFree).toBe(false)
  // submitted 未知也收为结果；再次替换必须显式回编辑并做新 Preview，不能重复消费旧 applyInput。
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Submitted')
  expect(byTestId('assembly-attach-parking')).toBeNull()
  expect(parking.at(-1)).toBeNull()
  await act(async () => (byTestId('assembly-attach-again') as HTMLButtonElement).click())
  // 勾选 free：停放位姿作为初始世界位姿提交，不自动跌落。
  await act(async () => (byTestId('assembly-attach-old-free') as HTMLInputElement).click())
  expect((byTestId('assembly-attach-apply') as HTMLButtonElement).disabled).toBe(true)
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(submits).toHaveLength(2)
  expect(submits[1]!.oldFree).toBe(true)
  expect(submits[1]!.oldParkingPose.positionM[0]).toBeCloseTo(0.7)
}))

test('Attach 独立页面：世界未就绪时给出 Prepare/Sync 下一步；准备后按新世界身份重读源与目标', withDom(async (root, flush) => {
  let prepared = 0
  const reads: Array<'source' | 'target'> = []
  const render = (world: {ready: boolean; phase: string; detail?: string}) => act(async () => root.render(createElement(AssemblyAttachPanel, {
    key: 'prepare-world',
    tr,
    source: {entityId: 'hand', name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget: async (): Promise<AssemblyTargetDescription> => { reads.push('target'); return {bodies: [{name: 'base', root: true}, {name: 'attachment', root: false}], sites: []} },
    describeSource: async (): Promise<AssemblyTargetDescription> => { reads.push('source'); return {bodies: [{name: 'palm', root: true}], sites: []} },
    preview: async () => previewResult,
    apply: async () => ({}),
    world,
    prepareWorld: async () => { prepared += 1 },
  } as never)))
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await render({ready: false, phase: 'idle', detail: 'No physics world yet.'})
  await flush()
  // 独立页面自己给出下一步，不依赖被隐藏概览里的 Prepare physics。
  expect(byTestId('assembly-attach-world-required')).not.toBeNull()
  expect(byTestId('assembly-attach-world-detail')!.textContent).toContain('No physics world yet.')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(true)
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(true)
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(true)
  const readsBefore = reads.length
  await act(async () => (byTestId('assembly-attach-prepare') as HTMLButtonElement).click())
  await flush()
  expect(prepared).toBe(1)
  // 准备后清掉旧选择上下文并重读两侧（新的 scene/world/generation/revision 由宿主闭包补齐）。
  expect(reads.length).toBeGreaterThan(readsBefore)
  expect((byTestId('assembly-attach-source-body') as HTMLSelectElement).value).toBe('')
  // 宿主准备成功后以新的 world 身份重渲染：提示消失，选择真实 body/site 后 Preview 恢复可用。
  await render({ready: true, phase: 'ready'})
  await flush()
  expect(byTestId('assembly-attach-world-required')).toBeNull()
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  expect((byTestId('assembly-attach-preview') as HTMLButtonElement).disabled).toBe(false)
}))

test('Replace 停放拾取：画布点选进入同一份停放草稿，确认写回、取消恢复，ghost 同步', withDom(async (root, flush) => {
  const parking: Array<{positionM: number[]; quaternionXyzw: number[]} | null> = []
  let requested = 0, ended = 0
  let controller: AssemblyParkingPickController | undefined
  const onParkingPickController = (value: AssemblyParkingPickController | undefined) => { controller = value }
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    key: 'parking-pick',
    tr,
    source: {entityId: 'hand', name: 'New Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget,
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}),
    preview: async () => previewResult,
    apply: async () => ({}),
    replace: replaceRequest,
    onReplace: async () => ({}),
    onParkingGhost: (pose: RobotAnchorPose | null) => parking.push(pose),
    onRequestParkingPick: () => { requested += 1 },
    onParkingPickEnd: () => { ended += 1 },
    onParkingPickController,
    onBack: () => {},
  } as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  expect(controller).toBeDefined()
  await act(async () => (byTestId('assembly-attach-parking-pick') as HTMLButtonElement).click())
  expect(requested).toBe(1)
  // 画布点选：只改位置，方向沿用当前停放四元数；ghost 立即跟随。
  await act(async () => controller!.setPoint([1.25, 0.5, 0.75]))
  expect(parking.at(-1)).toMatchObject({positionM: [1.25, 0.5, 0.75], quaternionXyzw: [0, 0, 0, 1]})
  // 确认：写进同一份停放草稿（数值输入同步），并通知宿主收起浮条。
  await act(async () => controller!.confirm())
  expect(ended).toBe(1)
  const parkingX = () => byTestId('assembly-attach-parking')!.querySelector('input[aria-label="parking X"]') as HTMLInputElement
  expect(parkingX().value).toBe('1.25')
  expect(parking.at(-1)).toMatchObject({positionM: [1.25, 0.5, 0.75]})
  // 再次进入后取消：恢复进入前的停放草稿与 ghost，不触真实绑定。
  await act(async () => (byTestId('assembly-attach-parking-pick') as HTMLButtonElement).click())
  await act(async () => controller!.setPoint([9, 9, 9]))
  await act(async () => controller!.cancel())
  expect(ended).toBe(2)
  expect(parking.at(-1)).toMatchObject({positionM: [1.25, 0.5, 0.75]})
  expect(parkingX().value).toBe('1.25')
}))

const sourceDescription = async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]})
const attachPanelProps = (overrides: Record<string, unknown> = {}) => ({
  tr,
  source: {entityId: 'hand', name: 'Allegro Hand'},
  targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
  describeTarget,
  describeSource: sourceDescription,
  preview: async () => previewResult,
  onGhost: () => {},
  ...overrides,
} as never)
const selectAttachBodies = async (flush: (ms?: number) => Promise<void>) => {
  await openAlignment()
  await selectValue(document.querySelector<HTMLSelectElement>('[data-testid="assembly-attach-source-body"]')!, 'hand|palm')
  await selectValue(document.querySelector<HTMLSelectElement>('[data-testid="assembly-attach-target-body"]')!, 'attachment')
}

/** 交接身份判据：自动读回只能吃**同一次命令回执**自己的 world 代次；syncRequired/缺代次不得冒充原生通过。 */
test('assemblyReadbackIdentity：只接纳同 Scene、已保存、非 syncRequired 且代次齐全的回执', () => {
  expect(assemblyReadbackIdentity({saved: true, sceneId: 's', syncRequired: false, worldId: 'w', worldGeneration: 5}, 's')).toEqual({worldId: 'w', generation: 5})
  expect(assemblyReadbackIdentity({saved: true, sceneId: 's', syncRequired: true, worldId: 'w', worldGeneration: 5}, 's')).toBeUndefined()
  expect(assemblyReadbackIdentity({saved: true, sceneId: 'other', syncRequired: false, worldId: 'w', worldGeneration: 5}, 's')).toBeUndefined()
  expect(assemblyReadbackIdentity({saved: false, sceneId: 's', syncRequired: false, worldId: 'w', worldGeneration: 5}, 's')).toBeUndefined()
  expect(assemblyReadbackIdentity({saved: true, sceneId: 's', syncRequired: false, worldId: 'w'}, 's')).toBeUndefined()
  expect(assemblyReadbackIdentity({saved: true, sceneId: 's', syncRequired: false, worldId: 'w', worldGeneration: 0}, 's')).toBeUndefined()
})

test('Attach 面板：Apply 用真实已同步回执消费预览——显示 Saved·rev，不再显示未应用，ghost 清空', withDom(async (root, flush) => {
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  await act(async () => root.render(createElement(AssemblyAttachPanel, attachPanelProps({
    apply: async () => ({status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, sceneId: 's', revision: 6}),
    onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value),
  }))))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await selectAttachBodies(flush)
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Preview · not applied')
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  // 预览被消费：首屏只留短 Applied；完整回执/修订在 Details 里可读回。
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Applied')
  expect(byTestId('assembly-attach-result-status')!.textContent).not.toContain('not applied')
  await openDetails('assembly-attach-details')
  expect(byTestId('assembly-attach-result-detail-status')!.textContent).toContain('Assembly saved and synced')
  expect(byTestId('assembly-attach-result-detail-status')!.textContent).toContain('rev 6')
  expect(byTestId('assembly-attach-sync-required')).toBeNull()
  expect(ghosts.at(-1)).toBeNull()
}))

test('Attach 面板：实际 syncRequired 显示 Saved·Sync required 与内联同步；待同步时隐藏过期 STALE 读回', withDom(async (root, flush) => {
  let prepared = 0
  const staleCheck: RobotAssemblyCheckResult = {sceneId: 's', entityId: 'hand', revision: 6, attachments: [], checked: {binding: true, relativePose: false, joints: false, contacts: false, actionReceipt: false, attachments: true}, notes: [], reason: 'STALE_GENERATION: 世界代次已变化，未做原生检查。'}
  await act(async () => root.render(createElement(AssemblyAttachPanel, attachPanelProps({
    apply: async () => ({status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, sceneId: 's', revision: 6, reason: 'ROBOT_CONFIGURATION_FRAME_STALE: 尚无对应版本的原生帧。'}),
    check: staleCheck,
    onCheck: async () => ({}),
    prepareWorld: async () => { prepared += 1; return {sceneId: 's', worldId: 'w', status: 'paused', appliedSceneRevision: 6, worldGeneration: 3} },
  }))))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await selectAttachBodies(flush)
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  await openDetails('assembly-attach-details')
  expect(byTestId('assembly-attach-check-result')).not.toBeNull()
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-sync-required')!.getAttribute('aria-label')).toContain('Assembly saved · Physics sync required')
  expect(byTestId('assembly-attach-sync-detail')!.textContent).toContain('ROBOT_CONFIGURATION_FRAME_STALE')
  // 首屏短状态只报需要同步；完整回执仍在 Details 里，不被隐藏。
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Physics sync required')
  // 物理未同步：不把一份过期 STALE 读回和"待同步"同时摆在用户面前。
  expect(byTestId('assembly-attach-check-result')).toBeNull()
  // 内联下一步走同一 world 生命周期；成功后待同步块消失，状态回到短 Applied。
  await act(async () => (byTestId('assembly-attach-sync-world') as HTMLButtonElement).click())
  await flush()
  expect(prepared).toBe(1)
  expect(byTestId('assembly-attach-sync-required')).toBeNull()
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Applied')
  expect(byTestId('assembly-attach-result-detail-status')!.textContent).toContain('Assembly saved and synced')
}))

test('Replace 模式：一次 CAS 回执 syncRequired 时同样显示 Saved·Sync required，预览不再标未应用', withDom(async (root, flush) => {
  await act(async () => root.render(createElement(AssemblyAttachPanel, attachPanelProps({
    replace: replaceRequest,
    onReplace: async () => ({status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, sceneId: 's', revision: 7, reason: 'ROBOT_CONFIGURATION_WORLD_NOT_OPEN: 声明已恢复，物理待同步。'}),
    prepareWorld: async () => {},
  }))))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-sync-required')).not.toBeNull()
  expect(byTestId('assembly-attach-result-status')!.textContent).toContain('Physics sync required')
  expect(byTestId('assembly-attach-result-status')!.textContent).not.toContain('not applied')
}))

test('Attach 面板：换源重挂后已提交结果与待同步状态不落到新面板', withDom(async (root, flush) => {
  const render = (entityId: string, name: string) => act(async () => root.render(createElement(AssemblyAttachPanel, attachPanelProps({
    key: entityId,
    source: {entityId, name},
    apply: async () => ({status: 'UPDATED', saved: true, sync: 'REQUIRED', syncRequired: true, sceneId: 's', revision: 6, reason: 'ROBOT_CONFIGURATION_FRAME_STALE: 尚无原生帧。'}),
    prepareWorld: async () => {},
  }))))
  await render('hand', 'Allegro Hand')
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await selectAttachBodies(flush)
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-sync-required')).not.toBeNull()
  // 换源 = 面板以新实体重挂：旧件的已提交结果与待同步状态不得带进新面板。
  await render('hand-2', 'Other Hand')
  await flush()
  expect(byTestId('assembly-attach-sync-required')).toBeNull()
  expect(byTestId('assembly-attach-result')).toBeNull()
}))

/**
 * A0 回归：用主控探针同一提取方式执行真实 `workbench.tsx::attachRunCheck` 回调体，核对迟到读回的
 * 落地上下文。Scene 版本前进、world 关闭/换 world、API 会话变化、面板换源都不得把旧 frame 落回当前
 * 面板；而"回执自身代次领先尚未采纳的轮询句柄"是必须保留的合法正例。
 */
test('attachRunCheck：迟到读回只落回同 API/Scene 版本/源实体/同 world，回执代次领先轮询仍合法', async () => {
  const source = await readFile(new URL('../src/workbench.tsx', import.meta.url), 'utf8')
  const start = source.indexOf(' const attachRunCheck=')
  const end = source.indexOf(' const attachDetach=', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const actual = source.slice(start, end)
  const factory = `export function bind(scope:any){const {sceneRef,worldRef,api,apiRef,attachSourceIdRef,selectedRef,setAttachCheck}=scope;${actual};return attachRunCheck}`
  const js = new Bun.Transpiler({loader: 'ts'}).transformSync(factory)
  const {bind} = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  const run = async (mode: string, identity?: {worldId?: string; generation?: number}) => {
    let finish!: (value: unknown) => void
    const landed: unknown[] = []
    const api = {command: () => new Promise(resolve => { finish = resolve })}
    const scope: Record<string, unknown> = {
      sceneRef: {current: {sceneId: 's', revision: 1}},
      worldRef: {current: {worldId: 'w', sceneId: 's', worldGeneration: 1, appliedSceneRevision: 1}},
      api, apiRef: {current: api}, attachSourceIdRef: {current: 'a'}, selectedRef: {current: 'a'},
      setAttachCheck: (value: unknown) => landed.push(value),
    }
    const callback = bind(scope)
    // 面板在调用前已经切到 B，但入口仍带着旧实体 A：这类"发起时就已换源"的读回也不得落 B。
    if (mode === 'wrong-source-at-start') (scope.attachSourceIdRef as {current?: string}).current = 'b'
    const task = callback('a', identity)
    await Promise.resolve()
    if (mode === 'source-changed') (scope.attachSourceIdRef as {current?: string}).current = 'b'
    if (mode === 'generation-advanced') (scope.worldRef as {current: unknown}).current = {worldId: 'w', sceneId: 's', worldGeneration: 2, appliedSceneRevision: 1}
    if (mode === 'world-closed') (scope.worldRef as {current: unknown}).current = undefined
    if (mode === 'api-changed') (scope.apiRef as {current: unknown}).current = {command: () => undefined}
    if (mode === 'revision-advanced') (scope.sceneRef as {current: unknown}).current = {sceneId: 's', revision: 2}
    finish({sceneId: 's', entityId: 'a', revision: 1, frame: {worldId: 'w', generation: 1, sceneRevision: 1}, checked: {binding: true, relativePose: true, joints: true}, attachments: [], notes: []})
    await task
    return landed.length
  }
  expect(await run('same-context', {worldId: 'w', generation: 1})).toBe(1)
  expect(await run('receipt-ahead', {worldId: 'w', generation: 5})).toBe(1)
  expect(await run('source-changed', {worldId: 'w', generation: 1})).toBe(0)
  expect(await run('wrong-source-at-start', {worldId: 'w', generation: 1})).toBe(0)
  expect(await run('generation-advanced', {worldId: 'w', generation: 1})).toBe(0)
  expect(await run('world-closed', {worldId: 'w', generation: 1})).toBe(0)
  expect(await run('api-changed', {worldId: 'w', generation: 1})).toBe(0)
  expect(await run('revision-advanced', {worldId: 'w', generation: 1})).toBe(0)
})

test('V8-34：挂接结果页直接给当前保存态与一个 Undo 入口（复用真实回调）', withDom(async (root, flush) => {
  const undos: number[] = []
  await act(async () => root.render(createElement(AssemblyAttachPanel, {
    tr,
    source: {entityId: 'hand', name: 'Allegro Hand'},
    targetCandidates: [{entityId: 'panda', name: 'Panda One'}],
    describeTarget,
    describeSource: async (): Promise<AssemblyTargetDescription> => ({bodies: [{name: 'palm', root: true}], sites: [{name: 'palm_mount', bodyName: 'palm'}]}),
    savedSourceMount: previewResult.sourceMount,
    preview: async () => previewResult,
    apply: async (input: RobotSetBaseInput) => ({status: 'UPDATED', saved: true, sync: 'SYNCED', syncRequired: false, sceneId: 's', revision: 6, entityId: 'hand', snapshot: {}}),
    onUndoLast: async () => { undos.push(1); return {} },
  } as never)))
  await flush()
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  await openAlignment()
  await selectValue(byTestId('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await selectValue(byTestId('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  await act(async () => (byTestId('assembly-attach-preview') as HTMLButtonElement).click())
  await flush()
  await act(async () => (byTestId('assembly-attach-apply') as HTMLButtonElement).click())
  await flush()
  expect(byTestId('assembly-attach-result-relation')!.textContent).toContain('Allegro Hand → Panda One / attachment')
  expect(byTestId('assembly-attach-primary')).toBeNull()
  expect(byTestId('assembly-attach-apply')).toBeNull()
  const undo = byTestId('assembly-attach-undo-last') as HTMLButtonElement
  expect(undo).not.toBeNull()
  await act(async () => undo.click())
  await flush()
  expect(undos).toHaveLength(1)
  expect(byTestId('assembly-attach-undo-note')).not.toBeNull()
  expect(byTestId('assembly-attach-result-status')!.textContent).toBe('Undo completed')
  expect(byTestId('assembly-attach-primary')).toBeNull()
  expect(byTestId('assembly-attach-undo-last')).toBeNull()
}))

const attachNode = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const attachButton = (id: string) => attachNode(id) as HTMLButtonElement
const attachClick = (id: string) => act(async () => attachButton(id).click())
const appliedReceipt = {saved: true, sync: 'SYNCED', syncRequired: false, sceneId: 's', revision: 6}
const waitingReceipt = {saved: true, syncRequired: true, sync: 'REQUIRED', sceneId: 's', revision: 6, reason: 'NATIVE_SYNC_PENDING'}
async function previewAttach(root: ReturnType<typeof createRoot>, props: any, flush: (ms?: number) => Promise<void>) {
  await act(async () => root.render(createElement(AssemblyAttachPanel, props)))
  await flush()
  await selectAttachBodies(flush)
  await attachClick('assembly-attach-preview')
}

test('V11-34：结果页只留真实关系、一个状态、Undo与显式再次安装；新Preview才恢复Apply', withDom(async (root, flush) => {
  const applied: unknown[] = [], ghosts: Array<RobotAssemblyPreviewResult | null> = []
  await previewAttach(root, attachPanelProps({apply: async (input: RobotSetBaseInput) => {applied.push(input); return appliedReceipt}, onUndoLast: async () => ({}), onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)}), flush)
  expect(attachNode('assembly-attach-primary')).not.toBeNull()
  expect(attachButton('assembly-attach-apply').disabled).toBe(false)
  await attachClick('assembly-attach-apply')
  expect(attachNode('assembly-attach-result-page')).not.toBeNull()
  expect(attachNode('assembly-attach-primary')).toBeNull()
  expect(attachNode('assembly-attach-target')).toBeNull()
  expect(attachNode('assembly-attach-alignment')).toBeNull()
  expect(attachNode('assembly-attach-preview')).toBeNull()
  expect(attachNode('assembly-attach-frame-preview')).toBeNull()
  expect(attachNode('assembly-attach-apply')).toBeNull()
  expect(attachNode('assembly-attach-result-relation')!.textContent).toContain('Allegro Hand → Panda One / attachment')
  expect(attachNode('assembly-attach-result-page')!.textContent).not.toContain('rev 6')
  expect(attachNode('assembly-attach-result-page')!.textContent).not.toContain('hand|palm')
  expect(attachNode('assembly-attach-result-page')!.querySelectorAll('[data-testid="assembly-attach-undo-last"]')).toHaveLength(1)
  expect(ghosts.at(-1)).toBeNull()
  await attachClick('assembly-attach-again')
  expect(attachNode('assembly-attach-result-page')).toBeNull()
  expect(attachNode('assembly-attach-primary')).not.toBeNull()
  expect(attachButton('assembly-attach-apply').disabled).toBe(true)
  expect(attachNode('assembly-attach-result-status')).toBeNull()
  expect(applied).toHaveLength(1)
  expect(ghosts.at(-1)).toBeNull()
  await attachClick('assembly-attach-preview')
  expect(attachButton('assembly-attach-apply').disabled).toBe(false)
  expect(attachNode('assembly-attach-result-status')!.textContent).toContain('Preview')
}))

test('V11-34：待同步结果不铺Prepare或编辑表，Sync失败可重试，无回执不能谎称同步', withDom(async (root, flush) => {
  let syncCalls = 0
  const props: any = attachPanelProps({apply: async () => waitingReceipt, onUndoLast: async () => ({}), prepareWorld: async () => {syncCalls++; if (syncCalls === 1) throw Error('SYNC_FAILED'); return undefined}})
  await previewAttach(root, props, flush)
  await attachClick('assembly-attach-apply')
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...props, world: {ready: false, phase: 'unsynced', sceneRevision: 6, appliedRevision: 5, generation: 2}})))
  expect(attachNode('assembly-attach-result-page')).not.toBeNull()
  expect(attachNode('assembly-attach-world-required')).toBeNull()
  expect(attachNode('assembly-attach-prepare')).toBeNull()
  expect(attachNode('assembly-attach-primary')).toBeNull()
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Physics sync required')
  expect(attachNode('assembly-attach-saved-result')!.textContent).not.toContain('Applied')
  await attachClick('assembly-attach-sync-world')
  expect(attachNode('assembly-attach-error')!.textContent).toContain('SYNC_FAILED')
  expect(attachButton('assembly-attach-sync-world').disabled).toBe(false)
  await attachClick('assembly-attach-sync-world')
  expect(attachNode('assembly-attach-sync-required')).not.toBeNull()
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Physics sync required')
  expect(attachNode('assembly-attach-error')!.textContent).toContain('not confirmed')
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...props, prepareWorld: async () => ({sceneId: 'other-scene', status: 'paused', appliedSceneRevision: 6})})))
  await attachClick('assembly-attach-sync-world')
  expect(attachNode('assembly-attach-sync-required')).not.toBeNull()
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...props, prepareWorld: async () => ({sceneId: 's', status: 'paused', appliedSceneRevision: 6, worldGeneration: 3})})))
  await attachClick('assembly-attach-sync-world')
  expect(attachNode('assembly-attach-sync-required')).toBeNull()
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Applied')
  expect(attachNode('assembly-attach-primary')).toBeNull()
  expect(attachNode('assembly-attach-apply')).toBeNull()
}))

test('V11-34：保存但同步未知与submitted缺回执都不得标已同步或渲染可重复Apply', withDom(async (root, flush) => {
  for (const [label, receipt] of [['saved', {saved: true, sceneId: 's', revision: 6}], ['submitted', undefined]] as const) {
    await previewAttach(root, {...attachPanelProps({apply: async () => receipt, onUndoLast: async () => ({})}) as any, key: label}, flush)
    await attachClick('assembly-attach-apply')
    expect(attachNode('assembly-attach-result-page')).not.toBeNull()
    expect(attachNode('assembly-attach-primary')).toBeNull()
    expect(attachNode('assembly-attach-apply')).toBeNull()
    expect(attachNode('assembly-attach-result-status')!.textContent).toBe(label === 'saved' ? 'Saved · sync not reported' : 'Submitted · save state not reported')
    expect(attachNode('assembly-attach-result-page')!.textContent).not.toContain('Applied')
    if (label === 'submitted') expect(attachNode('assembly-attach-undo-last')).toBeNull()
    await openDetails('assembly-attach-details')
    expect(attachNode('assembly-attach-result-detail-status')!.textContent).toContain(label === 'saved' ? 'did not report' : 'no recognizable')
  }
}))

test('V11-34：同组件换源后旧Apply成功或失败不落新来源，旧finally不结束新Preview', withDom(async (root, flush) => {
  let finish!: (value: any) => void, fail!: (reason: unknown) => void, nextPreview!: (value: any) => void
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  const base: any = attachPanelProps({apply: () => new Promise((resolve, reject) => {finish = resolve; fail = reject}), onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)})
  await previewAttach(root, base, flush)
  await attachClick('assembly-attach-apply')
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, source: {entityId: 'hand-2', name: 'Other Hand'}, preview: () => new Promise(resolve => {nextPreview = resolve})})))
  await flush()
  await openAlignment()
  await selectValue(attachNode('assembly-attach-source-body') as HTMLSelectElement, 'hand-2|palm')
  await selectValue(attachNode('assembly-attach-target-body') as HTMLSelectElement, 'attachment')
  await attachClick('assembly-attach-preview')
  expect(attachButton('assembly-attach-preview').disabled).toBe(true)
  await act(async () => finish(appliedReceipt))
  expect(attachNode('assembly-attach-result-page')).toBeNull()
  expect(attachButton('assembly-attach-preview').disabled).toBe(true)
  expect(ghosts.at(-1)).toBeNull()
  await act(async () => nextPreview({...previewResult, source: {...previewResult.source, entityId: 'hand-2'}, applyInput: {...applyInput, entityId: 'hand-2'}}))
  expect(attachButton('assembly-attach-preview').disabled).toBe(false)
  await attachClick('assembly-attach-apply')
  await act(async () => root.render(createElement(AssemblyAttachPanel, base)))
  await act(async () => fail(Error('OLD_APPLY_FAILURE')))
  expect(attachNode('assembly-attach-error')).toBeNull()
  expect(attachNode('assembly-attach-result-page')).toBeNull()
}))

test('V11-34：Sync和Undo迟到回执与错误均不串换源，旧结果也不影响新忙态', withDom(async (root, flush) => {
  let finishSync!: (value: any) => void, rejectUndo!: (reason: unknown) => void
  const base: any = attachPanelProps({apply: async () => waitingReceipt, prepareWorld: () => new Promise(resolve => {finishSync = resolve}), onUndoLast: () => new Promise((_resolve, reject) => {rejectUndo = reject})})
  await previewAttach(root, base, flush)
  await attachClick('assembly-attach-apply'); await attachClick('assembly-attach-sync-world')
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, source: {entityId: 'hand-2', name: 'Other Hand'}})))
  await act(async () => finishSync({sceneId: 's', appliedSceneRevision: 6, status: 'paused'}))
  expect(attachNode('assembly-attach-result-page')).toBeNull()
  await act(async () => root.render(createElement(AssemblyAttachPanel, base)))
  await flush(); await selectAttachBodies(flush); await attachClick('assembly-attach-preview'); await attachClick('assembly-attach-apply')
  await attachClick('assembly-attach-undo-last')
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, source: {entityId: 'hand-2', name: 'Other Hand'}})))
  await act(async () => rejectUndo(Error('OLD_UNDO_FAILURE')))
  expect(attachNode('assembly-attach-error')).toBeNull()
  expect(attachNode('assembly-attach-undo-note')).toBeNull()
  expect(attachNode('assembly-attach-result-page')).toBeNull()
}))

test('V11-34：Undo真实失败保留结果与重试，成功收为Undo完成且Back清ghost', withDom(async (root, flush) => {
  let calls = 0, backs = 0
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  await previewAttach(root, attachPanelProps({apply: async () => appliedReceipt, onUndoLast: async () => {calls++; if (calls === 1) throw Error('UNDO_REFUSED'); return waitingReceipt}, onBack: () => {backs++}, onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)}), flush)
  await attachClick('assembly-attach-apply'); await attachClick('assembly-attach-undo-last')
  expect(attachNode('assembly-attach-error')!.textContent).toContain('UNDO_REFUSED')
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Applied')
  expect(attachButton('assembly-attach-undo-last').disabled).toBe(false)
  await attachClick('assembly-attach-undo-last')
  expect(calls).toBe(2)
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Undo completed')
  expect(attachNode('assembly-attach-undo-note')!.textContent).toContain('Physics sync required')
  expect(attachNode('assembly-attach-undo-last')).toBeNull()
  expect(attachNode('assembly-attach-primary')).toBeNull()
  await attachClick('assembly-attach-back')
  expect(backs).toBe(1)
  expect(ghosts.at(-1)).toBeNull()
  expect(attachNode('assembly-attach-result-page')).toBeNull()
}))

test('V11-34：Replace宿主先清prop再返回回执，结果关系与停放事实仍固定本次提交', withDom(async (root, flush) => {
  let finish!: () => void
  function Host() {
    const [replacement, setReplacement] = useState<AssemblyReplaceRequest | undefined>(replaceRequest)
    return createElement(AssemblyAttachPanel, attachPanelProps({
      replace: replacement,
      onReplace: async () => {setReplacement(undefined); await new Promise<void>(resolve => {finish = resolve}); return appliedReceipt},
      apply: async () => appliedReceipt,
    }))
  }
  await act(async () => root.render(createElement(Host)))
  await flush(); await openAlignment()
  await selectValue(attachNode('assembly-attach-source-body') as HTMLSelectElement, 'hand|palm')
  await attachClick('assembly-attach-preview'); await attachClick('assembly-attach-apply')
  await act(async () => finish())
  expect(Boolean(attachNode('assembly-attach-result-page'))).toBe(true)
  expect(attachNode('assembly-attach-title')!.textContent).toBe('Replacement result')
  expect(attachNode('assembly-attach-result-relation')!.textContent).toContain('Panda One / attachment')
  expect(Boolean(attachNode('assembly-attach-primary'))).toBe(false)
  await openDetails('assembly-attach-details')
  expect(attachNode('assembly-attach-result-parking')!.textContent).toContain('Old Hand')
  expect(attachNode('assembly-attach-result-parking')!.textContent).toContain('0.4000')
}))

test('V11-33：Preview Cancel仍清ghost并返回；卸载后迟到Apply不回写ghost或状态', withDom(async (root, flush) => {
  let finish!: (value: any) => void, backs = 0
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  const props: any = attachPanelProps({apply: () => new Promise(resolve => {finish = resolve}), onBack: () => {backs++}, onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)})
  await previewAttach(root, props, flush)
  await attachClick('assembly-attach-cancel')
  expect(backs).toBe(1)
  expect(ghosts.at(-1)).toBeNull()
  expect(Boolean(attachNode('assembly-attach-result'))).toBe(false)
  await attachClick('assembly-attach-preview'); await attachClick('assembly-attach-apply')
  await act(async () => root.render(createElement('div')))
  const count = ghosts.length
  await act(async () => finish(appliedReceipt))
  expect(ghosts.length).toBe(count)
  expect(Boolean(attachNode('assembly-attach-result-page'))).toBe(false)
}))

test('V11-A01：Preview挂起后world代次/Scene修订改变，旧成功错误不发布ghost也不解锁新请求', withDom(async (root, flush) => {
  const pending: Array<{resolve: (value: RobotAssemblyPreviewResult) => void; reject: (reason: unknown) => void}> = []
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  const initial = {ready: true, phase: 'paused', generation: 2, sceneRevision: 5, appliedRevision: 5}
  const base: any = attachPanelProps({world: initial, preview: () => new Promise((resolve, reject) => pending.push({resolve, reject})), apply: async () => appliedReceipt, onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)})
  await previewAttach(root, base, flush)
  expect(pending).toHaveLength(1)
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, world: {...initial}})))
  expect(attachButton('assembly-attach-preview').disabled).toBe(true)
  const changed = {...initial, generation: 3, sceneRevision: 6, appliedRevision: 6}
  await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, world: changed})))
  expect(attachButton('assembly-attach-preview').disabled).toBe(false)
  await attachClick('assembly-attach-preview')
  expect(pending).toHaveLength(2)
  await act(async () => pending[0]!.resolve(previewResult))
  expect(ghosts.at(-1)).toBeNull()
  expect(attachButton('assembly-attach-preview').disabled).toBe(true)
  expect(Boolean(attachNode('assembly-attach-result'))).toBe(false)
  // A→B→A 的键文字相同也不能让旧 B 错误回到当前 A。
  await act(async () => root.render(createElement(AssemblyAttachPanel, base)))
  await attachClick('assembly-attach-preview')
  expect(pending).toHaveLength(3)
  await act(async () => pending[1]!.reject(Error('STALE_WORLD_PREVIEW_FAILURE')))
  expect(Boolean(attachNode('assembly-attach-error'))).toBe(false)
  expect(attachButton('assembly-attach-preview').disabled).toBe(true)
  await act(async () => pending[2]!.resolve(previewResult))
  expect(ghosts.at(-1)).toBe(previewResult)
  expect(attachButton('assembly-attach-apply').disabled).toBe(false)
}))

test('V11-A02：已有Preview后ready/代次/修订变化撤下ghost且Apply禁用，恢复也需新Preview', withDom(async (root, flush) => {
  const ghosts: Array<RobotAssemblyPreviewResult | null> = []
  const initial = {ready: true, phase: 'paused', generation: 2, sceneRevision: 5, appliedRevision: 5}
  const base: any = attachPanelProps({world: initial, apply: async () => appliedReceipt, onGhost: (value: RobotAssemblyPreviewResult | null) => ghosts.push(value)})
  await previewAttach(root, base, flush)
  for (const world of [{...initial, ready: false}, {...initial, generation: 3}, {...initial, sceneRevision: 6, appliedRevision: 6}]) {
    await act(async () => root.render(createElement(AssemblyAttachPanel, {...base, world})))
    expect(ghosts.at(-1)).toBeNull()
    expect(attachButton('assembly-attach-apply').disabled).toBe(true)
    expect(Boolean(attachNode('assembly-attach-result'))).toBe(false)
    await act(async () => root.render(createElement(AssemblyAttachPanel, base)))
    expect(attachButton('assembly-attach-apply').disabled).toBe(true)
    await attachClick('assembly-attach-preview')
    expect(attachButton('assembly-attach-apply').disabled).toBe(false)
  }
}))

test('V11-A02：Apply自身更新world修订/代次仍接纳合法提交，保存结果不被后续同步轮询清除', withDom(async (root, flush) => {
  let finish!: () => void
  function Host() {
    const [world, setWorld] = useState({ready: true, phase: 'paused', generation: 2, sceneRevision: 5, appliedRevision: 5})
    return createElement(AssemblyAttachPanel, attachPanelProps({world, apply: async () => {
      setWorld({ready: false, phase: 'unsynced', generation: 3, sceneRevision: 6, appliedRevision: 5})
      await new Promise<void>(resolve => {finish = resolve})
      setWorld({ready: true, phase: 'paused', generation: 3, sceneRevision: 6, appliedRevision: 6})
      return appliedReceipt
    }}))
  }
  await act(async () => root.render(createElement(Host)))
  await flush(); await selectAttachBodies(flush); await attachClick('assembly-attach-preview'); await attachClick('assembly-attach-apply')
  await act(async () => finish())
  expect(Boolean(attachNode('assembly-attach-result-page'))).toBe(true)
  expect(attachNode('assembly-attach-result-status')!.textContent).toBe('Applied')
  expect(attachNode('assembly-attach-result-relation')!.textContent).toContain('Allegro Hand → Panda One / attachment')
  await openDetails('assembly-attach-details')
  expect(attachNode('assembly-attach-result-source')!.textContent).toContain('palm_mount')
}))

