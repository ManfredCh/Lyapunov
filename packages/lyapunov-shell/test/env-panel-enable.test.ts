/**
 * N76 缺陷 1 回归守卫（静态契约）：没有 `environment` 组件的场景，**启用入口必须可达**。
 *
 * 修前分支链：`const locked=!status?"none":component?"edit":"create"`，而下一行
 * `if(!viewerVisible||!status)return …` 已经把 `!status` 提前返回 ⇒ `locked` 永远不可能是 `"none"`，
 * 于是门在 `locked==="none"` 上的「启用环境光照」按钮与「未启用环境组件」徽标**永不可达**：
 * 真实页面读数是 `{"enableButtonCount":0,"enableVisible":false,"sliders":0,"badge":"内置环境光"}`。
 * 修法：门改成组件事实（`!component`）。真机修前/修后证据见回执
 * `bugfixHistory/SHELL-DEFECTS-RESTART-PANEL-20260922.md`。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const panel = readFileSync(join(import.meta.dirname, '../src/environment-panel.tsx'), 'utf8')

test('启用分支的门是"组件事实"，不再挂在不可达的 locked==="none" 上', () => {
  expect(panel).not.toContain('locked==="none"')
  // 无组件时的徽标 + 启用按钮块都以 !component 为门（两处）
  expect(panel.match(/!component&&/g)?.length).toBe(2)
  expect(panel).toContain('启用环境光照')
  expect(panel).toContain('未启用环境组件')
})

test('无场景（status 缺失）时仍走"先打开一个场景"的说明，不是隐藏入口；有组件时不给重复入口', () => {
  expect(panel).toContain('if(!viewerVisible||!status)return')
  expect(panel).toContain('打开一个场景后这里显示并控制环境光照')
  // 有组件的那一支仍由 component 门控：滑块/移除/HDRI 都在里面
  expect(panel).toContain('{component&&<>')
  expect(panel).toContain('移除环境组件')
  expect(panel).toContain('启用环境光照')
  expect(panel).toContain('回到内置光照')
})
