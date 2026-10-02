/**
 * DEV-032 接线回归（W10）+ 开发信息清理：
 * 界面**只消费**宿主给的 plan，不再自己抄上限、不再自己判能不能开。
 *
 * 覆盖三层：
 *  1. **默认文件面板**（`renderToStaticMarkup`，真实组件）：正常导航里不再常驻开发信息——
 *     重启说明与上限口径都收进**折叠**的按需入口（`<details>` 不展开＝截图里看不到），
 *     未选文件时一个上限数字都不渲染；
 *  2. **条件触发的上限读数**（`HtmlOpenPlanBody` 直接渲染）：只有当前文件真的超过上限时，
 *     才显示宿主算好的 `limits[].reading`；未超过时不渲染任何上限口径；
 *  3. **静态契约**：点击路径走 `action:'html-plan'`，开不开由 `plan.choices` 决定，
 *     话术/复核命令原样来自 plan，文件里**不许再有第二份上限数字**。
 *
 * 诚实边界：本用例**没有**浏览器 DOM（本仓未装 happy-dom/jsdom），所以"点按钮 → 取计划 → 真打开标签"
 * 这一步在浏览器里没有跑过；那一步的证据见回执 §端到端（服务级真机复核 + 界面级 partial 的说明）。
 */
import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 与既有 DEV-032 用例同样的替身：只换 UI 依赖，不改产品代码。
mock.module('../src/model-preview.tsx', () => ({ ModelPreviewBody: () => null, modelKindOf: () => undefined }))
mock.module('../src/workspace-session.tsx', () => ({
  FileSurfaceBody: () => null,
  useWorkspaceSessionState: () => ({ setters: {}, actions: {}, refs: {}, entries: [] }),
}))
const { registerWorkspaceTabs, HtmlOpenPlanBody } = await import('../src/native-workspace-tabs.tsx')
const { EXTENSION_EDITOR_LIMIT, NATIVE_FULL_READ_LIMIT } = await import('../../lyapunov-shell/src/html-preview-entry.ts')
import type { HtmlLimitCheck, HtmlPreviewPlan } from '../../lyapunov-shell/src/html-preview-entry.ts'

const source = readFileSync(join(import.meta.dirname, '../src/native-workspace-tabs.tsx'), 'utf8')

function captureFilePaneBody() {
  let body: unknown
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
    inject: (_deps: string[], fn: (owner: unknown) => void) => { fn({ effect: (run: () => unknown) => { run() }, remote: { workspaceFiles: { readAll: async () => ({ ok: true, value: { data: '' } }) } } }) },
    sidebarRightTabs: { register: (definition: unknown) => definition },
    slots: {
      inject: (_seat: string, fn: () => unknown) => { fn() },
      register: (row: { name: string; key?: string }, component: unknown) => { if (row.name === 'sidebar.right.tab.files.actions') body = component; return row },
    },
  }
  registerWorkspaceTabs(ctx as never, {} as never)
  if (body === undefined) throw new Error('NATIVE_FILES_ACTIONS_NOT_REGISTERED')
  return body as (props: Record<string, unknown>) => unknown
}

function renderFilePane() {
  const Body = captureFilePaneBody()
  const tab = {
    signal: new AbortController().signal, visible: true, navigation: { params: undefined, revision: 0, address: 'dsh-resource://file/session-1//w' },
    actions: { openResource: () => {} },
  }
  return renderToStaticMarkup(createElement(Body as never, {
    sessionId: 'session-1', t: (key: string) => key, openHtmlAs: () => {}, signal: tab.signal, openResource: () => {}, absolutePath:'/w', rootPath:'/w',
  }) as never)
}

const check = (limit: typeof NATIVE_FULL_READ_LIMIT, bytes: number): HtmlLimitCheck => ({
  limit, bytes, exceeded: bytes > limit.bytes,
  reading: bytes > limit.bytes ? `${limit.label}：${bytes} > ${limit.bytes} ⇒ 超过` : `${limit.label}：${bytes} ≤ ${limit.bytes} ⇒ 未超过`,
})

function planWith(previewBytes: number, sourceBytes: number): HtmlPreviewPlan {
  const path = (target: 'preview' | 'source', limits: HtmlLimitCheck[]) => ({
    target, label: target === 'preview' ? '预览页面' : '编辑源码', disposition: 'ready' as const, limits,
    row: {
      id: `html.${target}`, kind: 'tool' as const, label: target === 'preview' ? '预览页面' : '编辑源码', status: 'ready' as const, state: 'ok',
      reading: '', impact: '', uncertain: false, uncertaintyNote: null, evidence: [], degradation: null,
      remedy: { summary: '', steps: [] }, scope: 'optional' as const, contractTest: 'test',
    },
    wording: [], action: { kind: target === 'preview' ? ('open-preview' as const) : ('open-source' as const), label: '', detail: '', enabled: true },
  })
  return {
    path: '/w/page.html',
    facts: { sizeBytes: previewBytes, scanTruncated: false, contentType: 'html', assetCounts: { inline: 0, relative: 0, remote: 0, fragment: 0, other: 0 }, selfContained: true },
    preview: path('preview', [check(NATIVE_FULL_READ_LIMIT, previewBytes)]),
    source: path('source', [check(EXTENSION_EDITOR_LIMIT, sourceBytes)]),
    assetService: {
      required: false, kind: 'none', origin: null, root: null, rangeRequired: false, state: 'ready',
      row: { id: 'html.asset', kind: 'tool' as const, label: '素材服务', status: 'ready' as const, state: 'ok', reading: '', impact: '', uncertain: false, uncertaintyNote: null, evidence: [], degradation: null, remedy: { summary: '', steps: [] }, scope: 'optional' as const, contractTest: 'test' },
      wording: [], checks: [], recheck: { what: '', how: '复核命令', expect: '期望' }, rootKnown: true, outsideRoot: [], missing: [], brokenLinks: [],
    },
    choices: [{ target: 'preview' as const, label: '预览页面', disposition: 'ready' as const, enabled: true }, { target: 'source' as const, label: '编辑源码', disposition: 'ready' as const, enabled: true }],
    recommended: 'preview' as const, summary: '摘要', wording: [], fingerprint: 'f',
  }
}

test('默认文件面板：开发信息收进折叠入口，未选文件不渲染任何上限数字', () => {
  const markup = renderFilePane()
  // 按需入口在，且默认**折叠**（没有 open 属性＝截图里看不到里面的开发信息）。
  expect(markup).toContain('data-testid="html-open-panel"')
  expect(markup).toMatch(/<details class="lya-open-panel" data-testid="html-open-panel">/)
  expect(markup).not.toMatch(/<details[^>]*\sopen/)
  expect(markup).toContain('data-testid="restart-tab-notice"')
  expect(markup).toContain('预览页面')
  expect(markup).toContain('编辑源码')
  expect(markup).toContain('HTML 打开方式')
  // 正常流程里不再出现两个上限的数字/标签（它们只在当前文件触发时才由 plan 给出）。
  expect(markup).not.toContain(EXTENSION_EDITOR_LIMIT.bytes.toLocaleString('en-US'))
  expect(markup).not.toContain('32.00MiB')
  expect(markup).not.toContain(EXTENSION_EDITOR_LIMIT.label)
  expect(markup).not.toContain(NATIVE_FULL_READ_LIMIT.label)
  // 没有计划时不该渲染计划块（它是"取回来才显示"的，不是占位空座）。
  expect(markup).not.toContain('data-testid="html-open-plan"')
})

test('上限读数条件触发：超过才显示，未超过不渲染任何上限口径', () => {
  const render = (plan: HtmlPreviewPlan) => renderToStaticMarkup(createElement(HtmlOpenPlanBody as never, { plan, tr: (_zh: string, en: string) => en }) as never)
  const exceeded = render(planWith(40 * 1024 * 1024, 5_000_000))
  expect(exceeded).toContain('data-testid="html-open-limit-preview"')
  expect(exceeded).toContain('data-testid="html-open-limit-source"')
  expect(exceeded).toContain(NATIVE_FULL_READ_LIMIT.label)
  expect(exceeded).toContain(EXTENSION_EDITOR_LIMIT.label)
  const fine = render(planWith(1024, 2048))
  expect(fine).not.toContain('data-testid="html-open-limit-preview"')
  expect(fine).not.toContain('data-testid="html-open-limit-source"')
  expect(fine).not.toContain(NATIVE_FULL_READ_LIMIT.label)
  expect(fine).not.toContain(EXTENSION_EDITOR_LIMIT.label)
  expect(fine).toContain('data-testid="html-open-plan"')
})

test('静态契约：点击路径走宿主 action，开不开由 plan.choices 决定（界面不重算判据）', () => {
  expect(source).toContain("action:'html-plan'")
  expect(source).toContain('choices.find')
  expect(source).toContain("?.enabled!==true")
  // 两条话术与复核命令原样来自 plan。
  expect(source).toContain('.wording.join')
  expect(source).toContain('assetService.recheck.how')
  expect(source).toContain('assetService.recheck.expect')
  expect(source).toContain('assetService.missing')
  expect(source).toContain('assetService.brokenLinks')
  // 上限读数只从 plan 的 limits 取，且只在 exceeded 时才渲染。
  expect(source).toContain('limits.filter')
  expect(source).toContain('html-open-limit')
})

test('静态契约：文件里不许再有第二份上限（抄一份就会在改上限时对用户说假话）', () => {
  expect(source).not.toContain('4_000_000')
  expect(source).not.toContain('32*1024*1024')
  expect(source).not.toContain('NATIVE_READ_LIMIT_BYTES')
  expect(source).not.toContain('TEXT_READ_LIMIT_BYTES')
  // 静态上限常量不再被界面 import/直接渲染（改由宿主 plan 给读数；注释里的指针不算）。
  expect(source).not.toMatch(/import[^\n]*(?:EXTENSION_EDITOR_LIMIT|NATIVE_FULL_READ_LIMIT)/)
  expect(source).not.toContain('humanBytes(')
})

test('宿主 action 复用既有路径校验并调用同一份判据（不新写第二套）', () => {
  const plugin = readFileSync(join(import.meta.dirname, '../src/plugin.ts'), 'utf8')
  expect(plugin).toContain('action==="html-plan"')
  expect(plugin).toContain('await target(input.path)')          // 复用既有越界校验
  expect(plugin).toContain('planHtmlOpen(')
  expect(plugin).toContain('assetServer:"auto"')                // 探哪个 origin 由模块判，宿主不重复实现
  // 宿主不自己拼计划字段（它只转发 plan）。
  expect(plugin).not.toContain('choices:')
})
