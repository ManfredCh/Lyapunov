/**
 * DEV-032：HTML「编辑源码／预览页面」两条通路的注册契约（无浏览器，跑真实注册代码）。
 *
 * 钉住的事实：
 *  1. 文本编辑器（`lyapunov.editor`）的自动认领对 `.html` **保持否决** —— 默认点击 HTML 仍归原生页面预览，
 *     不回到“扩展编辑器抢走 HTML”的旧缺陷；
 *  2. `lyapunov.editor.html`（HTML 源码）存在、只接受 session 里的 `.html`，且它的 `patterns` **不匹配任何文件地址**，
 *     因此永不参与自动排名，只能被 `openResource(address,{kind:'lyapunov.editor.html'})` 点名打开；
 *  3. 两条通路各自有 `sidebar.right.pane.tab` 本体与 `.title` 注册（点名打开才有东西可渲染）。
 */
import { expect, mock, test } from 'bun:test'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'

// 模块下的组件本体把浏览器包（packages/viewer/dist/client.js）拖进求值；本用例只核对**注册契约**，
// 所以把两个 UI 依赖换成最小替身，不改产品代码：真实被测物仍是 `registerWorkspaceTabs`。
mock.module('../src/model-preview.tsx', () => ({ ModelPreviewBody: () => null, modelKindOf: () => undefined }))
mock.module('../src/workspace-session.tsx', () => ({
  FileSurfaceBody: () => null,
  useWorkspaceSessionState: () => ({ setters: {}, actions: {}, refs: {}, entries: [] }),
}))
const { registerWorkspaceTabs } = await import('../src/native-workspace-tabs.tsx')

type Definition = { id: string; kind: string; patterns?: string[]; priority?: string; canOpen?: (address: string) => boolean }
type Row = { seat: string; key: string }

function fakeContext() {
  const definitions: Definition[] = [], slots: Row[] = [], guides: Row[] = [], effects: (() => void)[] = []
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
    effect: (fn: () => unknown) => { effects.push(fn as () => void); return () => {} },
    inject: (_deps: string[], fn: (owner: unknown) => void) => { fn({ effect: (run: () => unknown) => { effects.push(run as () => void) } , remote: { workspaceFiles: { readAll: async () => ({ ok: true, value: { data: '' } }) } } }) },
    sidebarRightTabs: { register: (definition: Definition) => { definitions.push(definition); return definition } },
    slots: { inject: (_seat: string, fn: () => unknown) => { fn() }, register: (row: { name: string; key: string }) => { const entry = { seat: row.name, key: row.key }; slots.push(entry); return entry } },
  }
  registerWorkspaceTabs(ctx as never, {} as never)
  for (const run of effects) run()
  for (const definition of definitions) for (const entry of (definition as { guide?: Row[] }).guide ?? []) guides.push(entry)
  return { definitions, slots }
}

const address = (path: string) => fileAddressFor('session-1', '/w', path)

test('自动认领：`.html` 仍归原生预览，编辑器不抢；其他文本仍归编辑器', () => {
  const { definitions } = fakeContext()
  const editor = definitions.find(definition => definition.kind === 'lyapunov.editor')
  expect(editor).toBeDefined()
  expect(editor!.canOpen!(address('page.html'))).toBe(false)
  expect(editor!.canOpen!(address('page.htm'))).toBe(false)
  expect(editor!.canOpen!(address('src/main.ts'))).toBe(true)
  expect(editor!.canOpen!(address('shot.png'))).toBe(false)
})

test('显式源码编辑通路：只认 .html，且 patterns 不匹配任何文件地址（永不自动胜出）', () => {
  const { definitions } = fakeContext()
  const html = definitions.find(definition => definition.kind === 'lyapunov.editor.html')
  expect(html).toBeDefined()
  expect(html!.id).toBe('@lyapunov/workspace/html-source')
  expect(html!.canOpen!(address('page.html'))).toBe(true)
  expect(html!.canOpen!(address('dir/Page.HTML'))).toBe(true)
  expect(html!.canOpen!(address('src/main.ts'))).toBe(false)
  expect(html!.canOpen!(address('render.png'))).toBe(false)
  // 自动排名只看 patterns：它必须一个文件地址都匹配不上（否则会重新抢走默认打开）。
  const fileAddress = address('page.html')
  expect((html!.patterns ?? []).some(pattern => fileAddress.startsWith(pattern.replace('**', '')))).toBe(false)
  expect(html!.patterns).toEqual(['dsh-resource://html-source/**'])
})

test('两条通路都有本体与标题注册（点名打开才有可渲染的面）', () => {
  const { slots } = fakeContext()
  const keys = (seat: string) => slots.filter(row => row.seat === seat).map(row => row.key)
  expect(keys('sidebar.right.pane.tab')).toContain('@lyapunov/workspace/editor')
  expect(keys('sidebar.right.pane.tab')).toContain('@lyapunov/workspace/html-source')
  expect(keys('sidebar.right.pane.tab.title')).toContain('@lyapunov/workspace/editor')
  expect(keys('sidebar.right.pane.tab.title')).toContain('@lyapunov/workspace/html-source')
})

test('原生 files 不被产品 extension 替代，HTML 增量填 actions 槽',()=>{
 const {definitions,slots}=fakeContext()
 expect(definitions.some(row=>row.kind==='files')).toBe(false)
 expect(slots.some(row=>row.seat==='sidebar.right.tab.files.actions')).toBe(true)
 expect(slots.some(row=>row.key==='@lyapunov/workspace/model')).toBe(true)
})
