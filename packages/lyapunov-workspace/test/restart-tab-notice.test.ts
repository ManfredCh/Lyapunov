/**
 * N76/DEV-036 回归守卫（静态契约）：宿主重启后**普通 HTML 预览/编辑标签没有持久方**，
 * 因此必须按"明确降级"给出可见说明（不是静默消失）。**但**这份说明属于开发信息，
 * 按 2026-09 的清理要求收进**折叠的按需入口**：正常文件导航（截图）里不再常驻，
 * 展开后才可见。真机证据：重启后的页面上 `[data-testid=restart-tab-notice]` 在按需面板里，
 * 写明文件没丢、可按路径重开（回执 `bugfixHistory/SHELL-DEFECTS-RESTART-PANEL-20260922.md` §8）。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tabs = readFileSync(join(import.meta.dirname, '../src/native-workspace-tabs.tsx'), 'utf8')

test('重启降级说明仍在，但收进折叠的按需入口（正常导航不再常驻开发信息）', () => {
  expect(tabs).toContain("data-testid='restart-tab-notice'")
  expect(tabs).toContain('宿主重启后不会自动重开 HTML 预览/编辑标签')
  expect(tabs).toContain('文件仍在会话工作区里')
  expect(tabs).toContain('面板与场景选择会按会话恢复')
  // 说明必须被一个 `<details>`（按需入口）包住，且里面和 HTML 打开方式同处一块：
  // 折叠时不进截图；展开后规则（先看说明）在入口旁边。
  expect(tabs).toMatch(/<details[^>]*data-testid='html-open-panel'[\s\S]*restart-tab-notice[\s\S]*?<\/details>/)
  expect(tabs).toMatch(/<details[^>]*data-testid='html-open-panel'[\s\S]*html-open-choice[\s\S]*?<\/details>/)
  // 这一块必须是**默认折叠**的（details 上没有 open 属性）。
  expect(tabs).not.toMatch(/<details[^>]*data-testid='html-open-panel'[^>]*\sopen/)
})
