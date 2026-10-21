/** V10：被动成功读取在自有卡片里不铺 Chat；同一命令失败仍渲染可见。 */
import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DomainCommandCard } from "../src/domain-command-card.tsx"

const t = (key: string) => key === "open" ? "Scene workbench" : "场景工作台"
const row = (name: string, kind: "success" | "error", text: string) => ({ name, outcome: { kind, text }, args: "{}", display: undefined } as never)

describe("V10 自有 DomainCommandCard 的被动读取与失败可见", () => {
  test("policy_download_sources / robot_description / robot_assembly_history 成功时不占 Chat", () => {
    for (const name of ["policy_download_sources", "robot_description", "robot_assembly_history"]) {
      expect(renderToStaticMarkup(createElement(DomainCommandCard, { node: row(name, "success", JSON.stringify({ models: [], localEntries: [] })), t } as never))).toBe("")
    }
  })
  test("同一被动读取失败仍渲染标题与真实公开原因", () => {
    const html = renderToStaticMarkup(createElement(DomainCommandCard, { node: row("policy_download_sources", "error", "POLICY_SOURCE_FAILED: network refused"), t } as never))
    expect(html).toContain("Policy sources")
    expect(html).toContain("POLICY_SOURCE_FAILED")
    expect(html).toContain('data-state="error"')
  })
})
