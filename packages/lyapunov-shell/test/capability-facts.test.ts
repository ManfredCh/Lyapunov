/**
 * ENV-03（能力事实与呈现一致）的行为测试：路由提示里**点名的工具必须真的可见**。
 *
 * 背景（本机真实核对，见 `bugfixHistory/ENV03-CAPABILITY-FACTS-20260921.md`）：
 * 产品侧对模型说的"能力"集中在环境路由的提示文本里，而提示过去无条件点名
 * `web_search`/`web_fetch`/`blender_run`/`scene_edit`。本机 Host 的装配事实是：深度估计与
 * Unity 通道未配置（工具不存在）、生成类工具存在但真实提交被授权拦住——
 * "知道工具名"不等于"后端可用"。
 *
 * 这里只钉**呈现**这一层：`hasTool` 说不可见时，提示必须如实说明缺口；可见时不误报缺口。
 * `hasTool` 由调用方注入（生产里是 `ctx.tools.get(name, agent)`），所以用例是确定的、可复算的。
 * 边界：本文件不证明任何后端真的可用，也不启动 Blender/生成服务——那是回执里逐条命令核对的事。
 */
import { describe, expect, test } from "bun:test"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import type { UserMessage } from "@deepseek-ai/dsh-llm"
import { planDomainPointers, type SkillCatalogFact } from "../src/environment-routing.ts"

const userMessage = (text: string): UserMessage => createUserMessage({ content: [{ type: "text", text }] as never, source: { kind: "user" } })
const annotationMessage = (text: string): UserMessage => createUserMessage({ content: [{ type: "text", text }] as never, source: { kind: "lyapunov-annotation" } as never })

/** 随包装配的技能目录事实（本仓 skills/ 真实存在；目录可读时以目录为准）。 */
const catalog: SkillCatalogFact = {
  names: ["environment-planning", "environment-research", "photo-reconstruction", "unity-environment", "cad-import", "scene-construction", "asset-generation"],
  complete: true,
}

const planOnly = (hasTool: (name: string) => boolean) =>
  planDomainPointers({ pointers: [], messages: [userMessage("只给方案：按照这张平面图生成房间")], hasTool, skillCatalog: catalog })

describe("ENV-03：规划档提示里的工具能力必须与可见性一致", () => {
  test("工具都可见：提示照旧点名 web_search/web_fetch，不出现缺口句", () => {
    const plan = planOnly(() => true)!
    expect(plan.decision.stage).toBe("plan-only")
    expect(plan.text).toContain("Authorized read-only research is allowed when evidence is missing")
    expect(plan.text).not.toContain("The current instance has no visible")
  })

  test("调研工具不可见：提示如实说明缺口，不再把 web_search/web_fetch 说成可以做", () => {
    const plan = planOnly(() => false)!
    expect(plan.decision.stage).toBe("plan-only")
    // 缺口句必须点名真实缺失的工具，并给出"如实说明、不要假装已具备"的动作（沿用既有 note 口径）。
    expect(plan.text).toContain("The current instance has no visible web_search/web_fetch/blender_run/scene_edit tools")
    expect(plan.text).toContain("Report these capability gaps when needed rather than claiming availability")
  })

  test("只缺一个工具时只点名缺的那一个（不误报可见工具）", () => {
    const plan = planOnly(name => name !== "web_fetch")!
    // 只看缺口句本身：正文里的"不调用制作工具（blender_run/…）"是既有的禁止清单，不是能力声明。
    const gapStart = plan.text.indexOf("The current instance has no visible")
    expect(gapStart).toBeGreaterThanOrEqual(0)
    const gapSentence = plan.text.slice(gapStart)
    expect(gapSentence).toContain("no visible web_fetch tools")
    expect(gapSentence).not.toContain("web_search")
    expect(gapSentence).not.toContain("blender_run")
  })

  test("可见与不可见混合：可见的调研工具仍保留在正常路径描述里", () => {
    const plan = planOnly(name => name === "web_search" || name === "blender_run" || name === "scene_edit")!
    expect(plan.text).toContain("Authorized read-only research is allowed when evidence is missing")
    expect(plan.text).toContain("The current instance has no visible web_fetch tools")
  })
})

describe("ENV-03：批注就地修改的入口也要与可见性一致", () => {
  test("scene_edit 不可见：批注档给 note 缺口，而不是给一个加载不出来的技能指针", () => {
    const plan = planDomainPointers({ pointers: [], messages: [annotationMessage("把这段墙加高 0.5 米")], hasTool: () => false, skillCatalog: catalog })!
    expect(plan.decision.stage).toBe("local")
    const notes = plan.decision.hints.filter(hint => hint.kind === "note").map(hint => hint.why)
    expect(notes.some(why => why.includes("scene_edit"))).toBe(true)
    expect(plan.decision.hints.some(hint => hint.kind === "skill" && hint.name === "scene-construction")).toBe(false)
  })

  test("scene_edit 可见：仍然走原有的场景构造技能指针", () => {
    const plan = planDomainPointers({ pointers: [], messages: [annotationMessage("把这段墙加高 0.5 米")], hasTool: () => true, skillCatalog: catalog })!
    expect(plan.decision.hints.some(hint => hint.kind === "skill" && hint.name === "scene-construction")).toBe(true)
    expect(plan.decision.hints.some(hint => hint.kind === "note" && hint.why.includes("scene_edit"))).toBe(false)
  })
})
