/**
 * 环境路由（规划与 router 第一层）行为测试：ENV-01 / ENV-04 / ENV-53–59。
 *
 * 这里测的是**真实判定与真实注入文本**：消息用原生 `createUserMessage` 构造，附件用真实的
 * `ImageAttachmentRef` / `FileAttachmentRef` 字段（mediaType/width/height/name、name/bytes），
 * 会话任务用真实的 `TodoItem`，最后一段直接跑 `plugin.ts` 的 `apply()` 抓真实 pre-step 监听器，
 * 验证它确实注入了带 `lyapunov-domain-pointer` 来源的用户消息。
 *
 * 2026-09-20 按主代理的反例检查收敛后，本文件额外钉住：否定式不算停止、"只给方案"优先于停止、
 * 图像附件本身不授权环境建模、"继续"必须有带领域名的原生 todo 依据、用户点名的图纸词压过
 * 未知附件名、技能必须真实存在（目录可读时以目录为准）。这些用例来自
 * `.runtime/ccds-environment-20260919T164516Z/root-routing-probe.ts` 的 5 条反例，
 * 全部在下面的测试里逐条复现。
 *
 * 边界（不冒充已完成）：这些是进程内判定与接线的行为测试，**没有**运行真实 Agent 会话、
 * 没有真实模型看图、没有真实 Blender/生成服务；"模型是否照提示加载技能""pre-step 之后
 * 模型是否真的按档执行"要在产品会话里另验。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import { fileURLToPath } from "node:url"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import type { UserMessage } from "@deepseek-ai/dsh-llm"
import type { ImageAttachmentRef, AttachmentId } from "@deepseek-ai/dsh-attachment"
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo"
import { planDomainPointers, renderEnvironmentPointer, routeEnvironment, POINTER_FOOTER, SCENE_SPEC_FIELDS } from "../src/environment-routing.ts"
import type { EnvironmentInputSource, EnvironmentStage } from "../src/environment-routing.ts"
import { apply } from "../src/plugin.ts"
import { runDomainPointerGate } from "../../../script/gates/domain-pointers.ts"
import { isolateProviderInstaller } from "./fixtures/isolated-provider-installer.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_SOURCE = readFileSync(join(HERE, "../src/plugin.ts"), "utf8")

/** 真实的 image 内容块：ImageAttachmentRef 只给真实字段。 */
const imageBlock = (name: string, width = 1280, height = 960, mediaType: "image/jpeg" | "image/png" = "image/jpeg") => ({
  type: "image" as const,
  attachment: { attachmentId: `att-${name}` as AttachmentId, mediaType, bytes: 240_000, width, height, name } as ImageAttachmentRef,
})
/** 真实的 file 内容块：FileAttachmentRef 只有 attachmentId/name/bytes（没有 mediaType）。 */
const fileBlock = (name: string, bytes = 1_234_567) => ({ type: "file" as const, attachment: { attachmentId: `att-${name}` as AttachmentId, name, bytes } })

const userMessage = (...content: unknown[]): UserMessage => createUserMessage({ content: content as never, source: { kind: "user" } })
const annotationMessage = (text: string): UserMessage => createUserMessage({ content: [{ type: "text", text }] as never, source: { kind: "lyapunov-annotation" } as never })

const environmentTodo = (content: string, status: TodoItem["status"] = "in_progress"): TodoItem => ({ content, status })

/** 主代理反例驱动（`.runtime/.../root-routing-probe.ts`）里的 5 条：这里用同一批文字逐条钉住。 */
const ROOT_COUNTEREXAMPLES: readonly { label: string; text: string; image?: string; todo?: string; stage: EnvironmentStage; source: EnvironmentInputSource }[] = [
  { label: "否定式停止 + 继续", text: "不要停止，继续搭建这个庭院", todo: "搭建庭院", stage: "continue", source: "text" },
  { label: "图像附件不授权建模", text: "这张照片拍的是谁", image: "photo.png", stage: "none", source: "none" },
  { label: "只给方案优先于停止", text: "只给方案，先不要做场景", stage: "plan-only", source: "text" },
  { label: "软件待办不算环境任务", text: "继续", todo: "build web server", stage: "none", source: "none" },
  { label: "用户点名的图纸词压过附件名", text: "按照这张平面图生成房间", image: "photo.png", stage: "new", source: "cad" },
]

describe("主代理反例（2026-09-20）：逐条钉住", () => {
  for (const item of ROOT_COUNTEREXAMPLES)
    test(`「${item.text}」${item.todo ? ` + todo「${item.todo}」` : ""}${item.image ? ` + ${item.image}` : ""} → ${item.stage}/${item.source}`, () => {
      const decision = routeEnvironment({
        messages: [userMessage({ type: "text", text: item.text }, ...(item.image ? [imageBlock(item.image)] : []))],
        todos: item.todo ? [environmentTodo(item.todo)] : [],
        hasTool: () => true,
      })
      expect(decision.stage).toBe(item.stage)
      expect(decision.inputSource).toBe(item.source)
    })

  test("否定式停止被登记为被拒意图（negated），不给停止入口", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "不要停止这个场景的生成" })] })
    expect(decision.stage).not.toBe("stop")
    expect(decision.matched).not.toBe("停止")
    expect(decision.intent.rejected).toContainEqual({ stage: "stop", word: "停止", reason: "negated" })
    expect(renderEnvironmentPointer(decision) ?? "").not.toContain("Stop the action immediately")
  })

  test("「继续」但会话里没有环境任务 → 记为被拒意图（no-evidence），不是继续档", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "继续" })], todos: [environmentTodo("build web server")] })
    expect(decision.stage).toBe("none")
    expect(decision.intent.rejected).toContainEqual({ stage: "continue", word: "继续", reason: "no-evidence" })
  })

  test("真正的停止（无否定词）仍然成立，并给出可见的停止入口", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "停止" })], todos: [environmentTodo("重建仓库几何")], hasTool: name => name === "sim_stop" || name === "job_kill" })
    expect(decision.stage).toBe("stop")
    expect(decision.intent.rejected).toEqual([])
    expect(decision.hints.map(hint => hint.name)).toEqual(["sim_stop", "job_kill"])
    expect(renderEnvironmentPointer(decision)).not.toContain("environment-planning")
  })
})

describe("ENV-01 同一句话因附件不同走不同路径", () => {
  const text = "把这张图做成场景"

  test("照片附件（名字无线索）→ 照片路径，且计划档同时给出检索契约", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, imageBlock("site.jpg"))] })
    expect(decision.stage).toBe("new")
    expect(decision.inputSource).toBe("photo")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "photo-reconstruction", "environment-research"])
    expect(decision.evidence[0]).toContain("Photos: 1 (site.jpg image/jpeg 1280×960)")
  })

  test("图纸图附件（名字带图纸词）→ CAD 路径，多给一张读图契约", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, imageBlock("一层平面图.png", 2400, 1600, "image/png"))] })
    expect(decision.stage).toBe("new")
    expect(decision.inputSource).toBe("cad")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import"])
  })

  test("dxf 文件附件 → CAD 路径，附件依据带真实字节数", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, fileBlock("场地总平.dxf", 2_500_000))] })
    expect(decision.inputSource).toBe("cad")
    expect(decision.evidence[0]).toContain("Drawing files: 1 (场地总平.dxf 2.4MB)")
  })

  test("照片 + 图纸混合 → 混合输入，计划档给读图 + 检索 + 资产路线", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, imageBlock("site.jpg"), fileBlock("plan.dwg"))] })
    expect(decision.inputSource).toBe("mixed")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import", "environment-research", "asset-generation"])
  })

  test("没有附件 → 纯文字创作", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text })] })
    expect(decision.stage).toBe("new")
    expect(decision.inputSource).toBe("text")
  })

  // N193 / ENV-01 定向返修：非照片非图纸的附件既不是"混合输入"，也不该拿到图纸契约。
  // 修前 `otherFiles` 会往 `distinct` 里塞 "mixed"，空集合再兜底成 "mixed"，
  // 于是 `source==="cad"||"mixed"` 的注入分支把 `cad-import` 给了一个没有图纸的回合（真实回合已复现）。
  test("① 非照片非图纸的附件（notes.txt）→ 不判 mixed、不注入 cad-import", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, fileBlock("notes.txt", 57))] })
    expect(decision.inputSource).toBe("text")
    expect(decision.inputSource).not.toBe("mixed")
    expect(decision.hints.map(hint => hint.name)).not.toContain("cad-import")
    expect(decision.hints.map(hint => hint.name)).not.toContain("asset-generation")
    // 附件本身仍如实登记（没有假装"没附件"）
    expect(decision.evidence[0]).toContain("Other files: 1 (notes.txt)")
  })

  test("② 照片附件仍走 photo（未回归）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, imageBlock("site.jpg"))] })
    expect(decision.inputSource).toBe("photo")
    expect(decision.hints.map(hint => hint.name)).toContain("photo-reconstruction")
    expect(decision.hints.map(hint => hint.name)).not.toContain("cad-import")
  })

  test("③ 图纸附件仍走 cad（未回归）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, fileBlock("场地总平.dxf", 2_500_000))] })
    expect(decision.inputSource).toBe("cad")
    expect(decision.hints.map(hint => hint.name)).toContain("cad-import")
  })

  test("④ 照片 + 图纸仍判 mixed（保留合法混合语义）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text }, imageBlock("site.jpg"), fileBlock("plan.dwg"))] })
    expect(decision.inputSource).toBe("mixed")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import", "environment-research", "asset-generation"])
  })

  test("文字里点名图纸（没附件）→ CAD 输入", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "按这张户型图把墙建出来" })] })
    expect(decision.inputSource).toBe("cad")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import"])
  })

  test("照片附件 + 文字点名平面图 → 按图纸理解（未知图片不硬说成照片）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "按照这张平面图生成房间" }, imageBlock("photo.png", 1024, 768, "image/png"))] })
    expect(decision.inputSource).toBe("cad")
    expect(decision.facts.namedDrawing).toBe("平面图")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import"])
  })

  test("CAD 与照片混合（文字与附件都指向）→ 混合输入，且给读图契约", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "按平面图重建，照片只作参考" }, imageBlock("现场照片.jpg"), fileBlock("总平面图.dxf"))] })
    expect(decision.inputSource).toBe("cad") // 用户文字点名了图纸，压过附件形态
    expect(decision.facts.attachmentKind).toBe("mixed")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import", "environment-research", "asset-generation"])
  })
})

describe("ENV-53 阶段区分：新建 / 继续 / 局部 / 只方案 / 停止", () => {
  test("新建：文字请求先规划", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "新建一个仓库场景" })] })
    expect(decision.stage).toBe("new")
    expect(decision.hints[0]?.name).toBe("environment-planning")
    expect(decision.hints[0]?.why).toContain("plan as needed for complexity")
  })

  test("继续：沿用原生会话任务（todo 未完成项）不重新规划", () => {
    const todos = [environmentTodo("按照片重建仓库几何"), environmentTodo("导出 GLB", "pending")]
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "继续" })], todos })
    expect(decision.stage).toBe("continue")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning"])
    expect(decision.hints[0]?.why).toContain("Reuse the current plan and jobId")
    expect(decision.evidence.join("｜")).toContain("unfinished=2")
  })

  test("继续：会话里根本没有环境任务时不冒认（无关聊天不注入）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "继续" })], todos: null })
    expect(decision.stage).toBe("none")
    expect(renderEnvironmentPointer(decision)).toBeUndefined()
  })

  test("继续：软件待办（build web server / generate report）不算环境任务", () => {
    for (const todo of ["build web server", "generate report", "create the checkout page"]) {
      const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "继续" })], todos: [environmentTodo(todo)] })
      expect(decision.stage).toBe("none")
      expect(decision.facts.sessionEnvironmentTodos).toEqual([])
    }
  })

  test("继续 + 新到的图纸附件 → 继续档并入读图契约", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "继续" }, fileBlock("补充平面图.dxf"))], todos: [environmentTodo("重建仓库几何")] })
    expect(decision.stage).toBe("continue")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "cad-import"])
  })

  test("局部：已选场景 + 构件改动 → 短计划，不重做全场", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "把右边那面墙加高一点" })], selection: { sceneId: "scene_a", worldId: "world_1" } })
    expect(decision.stage).toBe("local")
    expect(decision.inputSource).toBe("existing-scene")
    expect(decision.hints[0]?.why).toContain("do not require a full environment plan")
    expect(decision.evidence).toContain("A scene and running world are selected in the workbench.")
  })

  test("只方案：只输出计划，不调用制作工具", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "先给我方案，不要动手" }, imageBlock("厂房照片.jpg"))] })
    expect(decision.stage).toBe("plan-only")
    const rendered = renderEnvironmentPointer(decision)!
    expect(rendered).toContain("Plan only")
    expect(rendered).toContain("do not call fabrication tools")
    expect(rendered).toContain("environment-planning")
  })

  test("只方案但没有任何环境证据（报错截图）→ 不抢：不把通用「别动手」当成环境只方案", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "先给我方案，不要动手" }, imageBlock("error.png"))] })
    expect(decision.stage).toBe("none")
  })

  test("只方案优先于停止：「只给方案，先不要做场景」不是停止", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "只给我方案，先不要做场景" })] })
    expect(decision.stage).toBe("plan-only")
    expect(decision.matched).toBe("只给我方案")
  })

  test("停止：不等待规划，直接给现有停止入口（不提示规划技能）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "停止" })], todos: [environmentTodo("重建仓库几何")], hasTool: name => name === "sim_stop" || name === "job_kill" })
    expect(decision.stage).toBe("stop")
    expect(decision.hints.map(hint => hint.name)).toEqual(["sim_stop", "job_kill"])
    const rendered = renderEnvironmentPointer(decision)!
    expect(rendered).toContain("without waiting for planning")
    expect(rendered).not.toContain("environment-planning")
  })

  test("停止：没有停止入口时如实说明，不假装有", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "取消这个场景的生成" })], hasTool: () => false })
    expect(decision.stage).toBe("stop")
    expect(decision.hints[0]?.kind).toBe("note")
    expect(decision.hints[0]?.why).toContain("No stop interface")
  })

  test("批注来源：视口批注按局部修改走，并提示就地改场景", () => {
    const decision = routeEnvironment({ messages: [annotationMessage("把这面墙加高 0.5 米")], selection: { sceneId: "scene_a" } })
    expect(decision.stage).toBe("local")
    expect(decision.inputSource).toBe("annotation")
    expect(decision.hints.map(hint => hint.name)).toEqual([undefined, "scene-construction"])
    // ENV-54：局部档的计划要点名「补什么参考」与「影响哪个构件」
    expect(decision.hints[0]!.why).toContain("Resolve reference gaps as needed")
    expect(decision.hints[0]!.why).toContain("identify the affected component")
  })
})

describe("ENV-58 无关消息不注入（保守：没有领域证据就不判）", () => {
  for (const text of ["今天天气不错", "帮我看看这段 Python 代码", "让机器人把方块抓起来放到桌上", "生成一个箱子", "让机器人把箱子搬到桌子上", "这张照片拍的是谁"])
    test(`「${text}」→ none`, () => {
      const decision = routeEnvironment({ messages: [userMessage({ type: "text", text })] })
      expect(decision.stage).toBe("none")
      expect(renderEnvironmentPointer(decision)).toBeUndefined()
    })

  test("机器人任务即使已选场景也不冒认环境任务", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "让它走过去" })], selection: { sceneId: "scene_a" } })
    expect(decision.stage).toBe("none")
  })

  test("裸附件不给动词、也没有环境名词 → 不抢（截图/报错图不会被当成环境任务）", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "这个怎么处理" }, imageBlock("error.png"))] })
    expect(decision.stage).toBe("none")
  })

  test("非用户来源的消息不参与判定（plugin/model/tool 与未知自定义来源）", () => {
    for (const kind of ["plugin", "model", "tool", "some-other-plugin"]) {
      const message = createUserMessage({ content: [{ type: "text", text: "新建一个仓库场景" }] as never, source: { kind } as never })
      expect(routeEnvironment({ messages: [message] }).stage).toBe("none")
    }
  })

  test("事实与意图分开：none 的消息仍登记可核对的事实（附件/选择），但不产生意图", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "这个怎么处理" }, imageBlock("error.png"))], selection: { sceneId: "scene_a" } })
    expect(decision.stage).toBe("none")
    expect(decision.facts.attachmentKind).toBe("photo")
    expect(decision.facts.sceneId).toBe("scene_a")
    expect(decision.intent.stage).toBe("none")
    expect(decision.intent.word).toBeUndefined()
  })
})

describe("技能必须真实存在（不虚构能力）", () => {
  const shippedOnly = { names: ["environment-planning", "cad-import", "scene-construction"], complete: true }

  test("目录完整但没有该技能 → 给缺口说明而不是加载提示", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "按这张平面图建个场景" })], skillCatalog: { names: ["environment-planning"], complete: true } })
    expect(decision.hints[0]?.name).toBe("environment-planning")
    expect(decision.hints[1]?.kind).toBe("note")
    expect(decision.hints[1]?.why).toContain("cad-import")
    expect(renderEnvironmentPointer(decision)).toContain("Report the missing capability")
  })

  test("目录不可读 → 只认随包装配的技能名，不猜别的", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "按照片重建这个厂房" }, imageBlock("厂房.jpg"))] })
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "photo-reconstruction", "environment-research"])
    expect(decision.facts.skillCatalogReadable).toBe(false)
  })

  test("目录可读且已有 photo-reconstruction → 照片路径才多给这张卡", () => {
    const withSkill = routeEnvironment({
      messages: [userMessage({ type: "text", text: "按照片重建这个厂房" }, imageBlock("厂房.jpg"))],
      skillCatalog: { names: ["environment-planning", "photo-reconstruction"], complete: true },
    })
    expect(withSkill.hints.map(hint => hint.name)).toEqual(["environment-planning", "photo-reconstruction", undefined])
    expect(withSkill.hints[2]?.why).toContain("environment-research") // 目录里没有 → 写缺口，不给加载提示
    const without = routeEnvironment({
      messages: [userMessage({ type: "text", text: "按照片重建这个厂房" }, imageBlock("厂房.jpg"))],
      skillCatalog: { ...shippedOnly, names: ["environment-planning"] },
    })
    // 目录完整但没有这两张卡 → 给的是缺口说明（name 为空），不是加载不出来的技能名
    expect(without.hints.map(hint => hint.name)).toEqual(["environment-planning", undefined, undefined])
    expect(without.hints.slice(1).every(hint => hint.kind === "note")).toBe(true)
  })

  test("停止档只点名可见工具，技能目录不参与", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "停掉这个仓库的生成" })], todos: null, hasTool: () => false, skillCatalog: { names: ["environment-planning"], complete: true } })
    expect(decision.stage).toBe("stop")
    expect(decision.hints.map(hint => hint.name)).toEqual([undefined])
    expect(decision.hints[0]?.kind).toBe("note")
  })

  test("工具类条目按工具可见性判断：ui_action 不可见时不注入（它是工具不是技能）", () => {
    const pointers = [{ skill: "ui_action", label: "界面自我控制", pattern: /打开.*面板|面板/i, tool: true }]
    const visible = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "打开素材面板" })], hasTool: () => true })!
    expect(visible.injected).toEqual(["ui_action"])
    const hidden = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "打开素材面板" })], hasTool: () => false })
    expect(hidden).toBeUndefined()
    const unknown = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "打开素材面板" })] })!
    expect(unknown.injected).toEqual(["ui_action"]) // 没给可见性回调时保持既有行为
  })
})

describe("规划档的检索与资产路线（2026-09-20 真实回合复盘）", () => {
  // 主代理真实回合原句（`.runtime/.../root-agent-plan.log`）。实测缺陷：模型只查了一个目录
  // （PolyHaven）没命中中式石狮，就写下"石狮不可下载 → Blender 分件雕刻为主"，全程没读过
  // environment-research / asset-generation——而这两张卡当时根本没被注入。
  const REAL_TURN = "我要按照片复现一个带树木和石狮的庭院。现在只给前期计划，不要开始制作。说明应先查哪些照片和位置资料、怎样选择下载资源和建模生成的路线，以及如何在工作台检查结果。"
  const catalog = { names: ["environment-planning", "environment-research", "photo-reconstruction", "asset-generation", "scene-construction"], complete: true }
  const realTurn = () => routeEnvironment({ messages: [userMessage({ type: "text", text: REAL_TURN })], todos: [], skillCatalog: catalog })

  test("现实复现 + 多资产混合的计划档：检索与资产路线两张卡必须给到", () => {
    const decision = realTurn()
    expect(decision.stage).toBe("plan-only")
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", "photo-reconstruction", "environment-research", "asset-generation"])
  })

  test("检索结论有证据边界；路线尊重用户来源与预算，不固定先搜后做", () => {
    const text = renderEnvironmentPointer(realTurn())!
    expect(text).toContain("A miss in one catalog establishes only that catalog miss")
    expect(text).toContain("not that the asset is unavailable everywhere")
    expect(text).toContain("the user's source/provider requirements")
    expect(text).toContain("do not require a universal search count")
    expect(text).not.toContain("first reuse the library, then scan other sources")
    expect(text).not.toContain("only consider afterwards")
  })

  test("只方案：说清只读调研可做、没搜过的别说没有资源、制作路径保留待选择", () => {
    const why = realTurn().hints[0]?.why ?? ""
    expect(why).toContain("Return only a plan")
    expect(why).toContain("native plan mode")
    expect(why).toContain("do not claim resources are unavailable without searching")
    expect(why).toContain("without requiring todo_write")
  })

  test("泛 scene 关键词挤不掉伴随契约：阶段提示有独立预算，补充只在占不满时补位", () => {
    const pointers = [
      { skill: "scene-construction", label: "场景构造", pattern: /庭院|场景|房间/ },
      { skill: "environment-assets", label: "环境资产", pattern: /下载|资源/ },
      { skill: "asset-generation", label: "资产生成", pattern: /生成|建模/ },
    ]
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: REAL_TURN })], todos: [], skillCatalog: catalog })!
    expect(plan.injected).toEqual(["environment-planning", "photo-reconstruction", "environment-research", "asset-generation"])
    expect(plan.injected).not.toContain("scene-construction")
    const lines = plan.text.split("\n")
    expect(lines.length).toBeLessThanOrEqual(7) // 表头 + 4 行阶段提示 + ENV-02 场景规格 1 行 + 收尾句
    expect(lines.at(-1)).toBe(POINTER_FOOTER)
  })

  test("路由提示不让模型假装失忆（pre-step 的输入边界是对钩子说的，不是对模型说的）", () => {
    const text = renderEnvironmentPointer(realTurn())!
    expect(text).not.toContain("you only have this step input")
    expect(text).not.toContain("do not assume you have seen the full conversation")
    expect(text).not.toContain("only this step input and native todo")
  })

  test("技能目录里没有这两张卡 → 写缺口，不虚构能力", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: REAL_TURN })], todos: [], skillCatalog: { names: ["environment-planning"], complete: true } })
    expect(decision.hints.map(hint => hint.name)).toEqual(["environment-planning", undefined, undefined, undefined])
    expect(decision.hints.slice(1).every(hint => hint.kind === "note")).toBe(true)
  })
})

describe("planDomainPointers：环境提示在前，关键词表补充不超上限", () => {
  test('仅把位置放到机器人旁边、已有机械臂下降不注入本体下载；明确下载仍保留',()=>{
    const pointers=[{skill:'robot-provisioning',label:'机器人准备',pattern:/机器人|机械臂/}]
    const local=planDomainPointers({pointers,messages:[userMessage({type:'text',text:'位置显示到机器人旁边'})],selection:{sceneId:'current'}})
    expect(local?.injected??[]).not.toContain('robot-provisioning')
    const move=planDomainPointers({pointers,messages:[userMessage({type:'text',text:'机械臂下降'})],selection:{sceneId:'current',worldId:'world'}})
    expect(move?.injected??[]).not.toContain('robot-provisioning')
    expect(planDomainPointers({pointers,messages:[userMessage({type:'text',text:'下载G1机器人'})]})?.injected).toContain('robot-provisioning')
  })
  const pointers = [
    { skill: "cad-import", label: "CAD 输入", pattern: /cad|图纸|平面图|floor[\s-]?plan/i },
    { skill: "scene-construction", label: "场景构造", pattern: /场景|房间|build a/i },
    { skill: "asset-generation", label: "资产生成", pattern: /生成|建模/i },
    { skill: "action-execution", label: "动作执行", pattern: /抓|搬|放到/i },
  ]

  test("输入源不会被截掉：施工图请求同时给出阶段技能与读图技能", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "按这张施工图建个场景" }, imageBlock("施工图.png", 2000, 1400, "image/png"))] })!
    expect(plan.injected[0]).toBe("environment-planning")
    expect(plan.injected).toContain("cad-import")
    expect(plan.injected.length).toBeLessThanOrEqual(3)
    // 表头 + 阶段提示 + 关键词补充 + ENV-02 场景规格 1 行 + 收尾句：规格行不占关键词补充额度。
    expect(plan.text.split("\n").length).toBeLessThanOrEqual(6)
  })

  test("环境消息：阶段技能在前，关键词命中填满剩余额度", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "建个房间，再生成一张桌子" })] })!
    expect(plan.injected).toEqual(["environment-planning", "scene-construction", "asset-generation"])
    expect(plan.decision.stage).toBe("new")
  })

  test("非环境消息保持既有行为（关键词前两条）", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "把箱子抓起来放到桌上" })] })!
    expect(plan.injected).toEqual(["action-execution"])
    expect(plan.decision.stage).toBe("none")
  })

  test("收尾句永远是最后一行：关键词补充排在环境提示之后、收尾句之前", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "搭一个仓库场景，再生成几个货架" })] })!
    const lines = plan.text.split("\n")
    expect(lines.at(-1)).toBe(POINTER_FOOTER)
    expect(lines.filter(line => line === POINTER_FOOTER).length).toBe(1)
    expect(plan.injected).toEqual(["environment-planning", "scene-construction", "asset-generation"])
    expect(lines.findIndex(line => line.includes("asset-generation"))).toBe(lines.length - 2)
  })

  test("停止档不给关键词补充：这一轮只该停，不推荐技能", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "取消这个场景的生成" })] })!
    expect(plan.decision.stage).toBe("stop")
    expect(plan.injected).toEqual([])
    expect(plan.text).not.toContain("scene-construction")
    expect(plan.text.split("\n").at(-1)).toBe(POINTER_FOOTER)
  })

  test("否定式停止不改变注入：仍走环境规划路径", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "不要停止，继续搭建这个庭院" })], todos: [environmentTodo("搭建庭院")] })!
    expect(plan.decision.stage).toBe("continue")
    expect(plan.injected[0]).toBe("environment-planning")
    expect(plan.text).toContain("Continue existing work")
    expect(plan.text).toContain("Continuing does not require reloading a known contract")
  })

  test("无命中且非环境 → 不注入", () => {
    expect(planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "今天天气不错" })] })).toBeUndefined()
  })
})

describe("已有机器人动作不重新路由为本体准备", () => {
  const pointers = [
    { skill: "action-execution", label: "动作执行", pattern: /抓|走两步|walk|move/i },
    { skill: "robot-provisioning", label: "机器人准备", pattern: /机器人|urdf|robot/i },
  ]

  for (const text of ["机器人左转向前走", "让 G1 左转，再往前走", "让机器人在这个场景里移动到前面", "不要下载新的机器人，G1 向前走", "Turn the robot left and walk forward", "让机械臂末端下降5厘米", "机械臂推箱子", "Lower the robot arm"])
    test(`动作「${text}」只提示动作契约，选择场景不变成 scene_edit`, () => {
      const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text })], selection: { sceneId: "current-scene" } })!
      expect(plan.decision.stage).toBe("none")
      expect(plan.injected).toEqual(["action-execution"])
      expect(plan.text).not.toContain("robot-provisioning")
      expect(plan.text).not.toContain("scene_edit")
      expect(plan.text).toContain("prepared policy")
      expect(plan.text).toContain("Do not download another body for an action")
    })

  for (const text of ["下载 G1 机器人用于行走", "导入机器人 URDF 模型用于移动"])
    test(`明确准备「${text}」保留原机器人准备提示`, () => {
      const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text })] })!
      expect(plan.injected).toContain("robot-provisioning")
    })

  test("动作技能确认缺失时说明缺口，不回落到重新下载", () => {
    const plan = planDomainPointers({ pointers, messages: [userMessage({ type: "text", text: "机器人左转向前走" })], skillCatalog: { names: ["robot-provisioning"], complete: true } })!
    expect(plan.injected).toEqual([])
    expect(plan.text).toContain("not visible in the current catalog")
    expect(plan.text).not.toContain("Robot preparation")
  })
})

describe("ENV-04/59 plugin.ts 的真实接线", () => {
  test("正式模式不暴露聊天安装工具或泛安装提醒，设置安装/许可证入口保留且原用户消息不变", async () => {
    const {tools,routes,listeners,dispose}=await applyOnStub()
    try{
      expect(tools.has('engine_install')).toBe(false)
      expect(routes.has('/api/lyapunov/provider-install')).toBe(true)
      expect(routes.has('/api/lyapunov/engine-license')).toBe(true)
      const message=userMessage({type:'text',text:'给已有机器人安装末端TCP，不安装新物理引擎。'})
      const result=await listeners.get('agent/pre-step')!({messages:[message],agent:stubAgent()},async()=>({kind:'enter',messages:[message]}))
      const input=enterMessages(result)
      expect(input.find(m=>m.id===message.id)).toEqual(message)
      expect(input.some(m=>(m.source as {plugin?:string}).plugin==='lyapunov-engine-install')).toBe(false)
    }finally{await dispose()}
  })

  test("开发安装仍拒绝未经一次consume授权的真实执行，不绕过设置许可证路径", async () => {
    const {tools,routes,dispose}=await applyOnStub(undefined,'developer')
    try{
      const tool=tools.get('engine_install') as {execute:(args:unknown,exec:unknown)=>Promise<unknown>}
      expect(tool).toBeDefined()
      await expect(tool.execute({input:{provider:'mujoco'}},{agent:stubAgent()})).rejects.toThrow('ENGINE_INSTALL_CONFIRMATION_REQUIRED')
      expect(routes.has('/api/lyapunov/provider-install')).toBe(true)
      expect(routes.has('/api/lyapunov/engine-license')).toBe(true)
    }finally{await dispose()}
  })

  test("短核心沿当前工作区权限，阶段技能仍允许任务脚本且禁止改源码/场景库绕接口", async () => {
    const { prompts, dispose } = await applyOnStub()
    try {
      const prompt = prompts[0]
      const text = String(prompt ? typeof prompt.text === "function" ? prompt.text() : prompt.text : "")
      expect(text).toContain("follow the current permissions for workspace files")
      expect(text).toContain("Modify scene and physics state through their product interfaces")
      const contract=readFileSync(new URL('../skills/asset-generation/SKILL.md',import.meta.url),'utf8')
      // 分组翻译异步合入，两个已签版本必须保留同四项合同；不删除或降低断言。
      const englishContract=contract.includes('Task-workspace scripts')
      expect(contract).toContain(englishContract ? 'Task-workspace scripts' : "任务工作区里的脚本")
      expect(contract).toContain(englishContract ? 'domain tools' : "产品状态一律走领域工具")
      expect(contract).toContain(englishContract ? 'Do not change on-disk files to alter product state' : "不要靠改盘上的文件改产品状态")
      expect(contract).toContain(englishContract ? 'or edit product source' : "也不要改产品源码")
    } finally { await dispose() }
  })

  test("pre-step 用真实消息+会话任务判定并注入 lyapunov-domain-pointer 消息", async () => {
    const { listeners, projection, dispose } = await applyOnStub()
    try {
      projection.todos = [environmentTodo("按照片重建仓库几何")]
      const handler = listeners.get("agent/pre-step")!
      const decision = await handler({ messages: [userMessage({ type: "text", text: "继续" }), userMessage({ type: "text", text: "把剩下的做完" })], agent: stubAgent() }, async () => ({ kind: "enter", messages: [] }))
      expect(decision.kind).toBe("enter")
      const injected = enterMessages(decision).at(-1)!
      expect((injected.source as { kind: string }).kind).toBe("lyapunov-domain-pointer")
      expect(injected.content[0]).toMatchObject({ type: "text" })
      expect((injected.content[0] as { text: string }).text).toContain("Continue existing work")
    } finally { await dispose() }
  })

  test("pre-step 用附件判定：照片消息按照片路径注入", async () => {
    const { listeners, dispose } = await applyOnStub()
    try {
      const handler = listeners.get("agent/pre-step")!
      const decision = await handler({ messages: [userMessage({ type: "text", text: "帮我复现这个" }, imageBlock("street.jpg"))], agent: stubAgent() }, async () => ({ kind: "enter", messages: [] }))
      const text = (enterMessages(decision).at(-1)!.content[0] as { text: string }).text
      expect(text).toContain("input source=[Photo]")
      expect(text).toContain("environment-planning")
    } finally { await dispose() }
  })

  test("pre-step 读原生技能目录：目录完整但缺 cad-import → 写成缺口说明（不虚构能力）", async () => {
    const { listeners, dispose } = await applyOnStub()
    try {
      const handler = listeners.get("agent/pre-step")!
      const decision = await handler({ messages: [userMessage({ type: "text", text: "按这张平面图建个场景" })], agent: stubAgent() }, async () => ({ kind: "enter", messages: [] }))
      const text = (enterMessages(decision).at(-1)!.content[0] as { text: string }).text
      expect(text).toContain("Environment task route")
      expect(text).toContain("Report the missing capability")
      expect(text).not.toContain("Read skill `cad-import`")
    } finally { await dispose() }
  })

  test("pre-step 真实回合复盘：只方案的现实复现会把检索与资产路线一起注入", async () => {
    const { listeners, dispose } = await applyOnStub(["environment-planning", "environment-research", "photo-reconstruction", "asset-generation"])
    try {
      const handler = listeners.get("agent/pre-step")!
      const decision = await handler(
        { messages: [userMessage({ type: "text", text: "我要按照片复现一个带树木和石狮的庭院。现在只给前期计划，不要开始制作。" })], agent: stubAgent() },
        async () => ({ kind: "enter", messages: [] }),
      )
      const text = (enterMessages(decision).at(-1)!.content[0] as { text: string }).text
      expect(text).toContain("Plan only")
      expect(text).toContain("environment-research")
      expect(text).toContain("asset-generation")
      expect(text).toContain("A miss in one catalog establishes only that catalog miss")
      expect(text).toContain("Existing-library reuse")
    } finally { await dispose() }
  })

  test("pre-step 不注入自己：域指针来源的消息不参与判定", async () => {
    const { listeners, dispose } = await applyOnStub()
    try {
      const handler = listeners.get("agent/pre-step")!
      const pointer = createUserMessage({ content: [{ type: "text", text: "该消息疑似涉及场景构造：可用 skill 工具加载 `scene-construction`" }] as never, source: { kind: "lyapunov-domain-pointer" } as never })
      const decision = await handler({ messages: [pointer], agent: stubAgent() }, async () => ({ kind: "enter", messages: [] }))
      expect(enterMessages(decision).length).toBe(0)
    } finally { await dispose() }
  })

  test("next() 拒绝时原样返回，不注入", async () => {
    const { listeners, dispose } = await applyOnStub()
    try {
      const handler = listeners.get("agent/pre-step")!
      const decision = await handler({ messages: [userMessage({ type: "text", text: "新建一个场景" })], agent: stubAgent() }, async () => ({ kind: "reject" }))
      expect(decision.kind).toBe("reject")
    } finally { await dispose() }
  })

  test("稳定核心注册为 system section，动态提示仍单独走域指针", async () => {
    const { prompts, dispose } = await applyOnStub()
    try {
      const product = prompts.find(prompt => prompt.name === "lyapunov-product-agent")
      expect(product?.name).toBe("lyapunov-product-agent")
      expect(product?.text).toContain("assistant for the Lyapunov workbench")
      expect(product?.text).not.toContain("computer-use")
      expect(product?.text).not.toContain("viewer_camera_apply")
    } finally { await dispose() }
  })

  test("关键词表仍受门禁约束（相对 plugin.ts 真实源码跑门禁）", () => {
    const result = runDomainPointerGate(PLUGIN_SOURCE)
    const failed = result.checks.filter(check => !check.ok)
    expect(failed.map(check => check.name)).toEqual([])
    expect(result.blocked).toBeNull()
  })
})

/** pre-step 监听器的真实形状（只取本测试用得到的字段）。 */
type PreStepPayload = { messages: UserMessage[]; agent: unknown }
type PreStepDecision = { kind: "enter"; messages: UserMessage[] } | { kind: "reject" }
type PreStepListener = (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
const enterMessages = (decision: PreStepDecision): UserMessage[] => {
  if (decision.kind !== "enter") throw new Error(`期望 enter，实际 ${decision.kind}`)
  return decision.messages
}

/** 只装配插件真正会碰到的服务面：捕获 systemPrompt 段与 pre-step 监听器；原生 Context 持有 Jobs 和 effect 清理。 */
async function applyOnStub(skillNames?: readonly string[],mode:'formal'|'developer'='formal') {
  const root = await mkdtemp(join(tmpdir(), "lyapunov-environment-routing-"))
  const lifecycle = new Context()
  const dispose = async () => { try { await lifecycle.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  let installerIsolation: ReturnType<typeof isolateProviderInstaller> | undefined
  try {
    await lifecycle.plugin(JobsLocal)
    const prompts: { name: string; text: string | (() => string) }[] = []
    const listeners = new Map<string, PreStepListener>()
    const projection = { todos: null as TodoItem[] | null }
    const tools = new Map<string, unknown>()
    const routes=new Set<string>()
    // 原生技能目录的替身：默认故意不含 cad-import，用来验证"目录完整但缺该技能 → 写成缺口"。
    const skills = { snapshot: async () => ({ skills: (skillNames ?? ["environment-planning", "scene-construction", "architectural-world"]).map(name => ({ name })), complete: true }) }
    const ctx = {
      jobs: lifecycle.jobs,
      inject: async () => {},
      effect: lifecycle.effect.bind(lifecycle),
      // 会话出站投影与 installer 清理都由原生 Context 持有，不丢弃返回的 disposer。
      provide: lifecycle.provide.bind(lifecycle),
      on: (event: string, handler: unknown) => lifecycle.effect(() => {
        listeners.set(event, handler as PreStepListener)
        return () => { listeners.delete(event) }
      }),
      systemPrompt: {
        section: (section: { name: string; text: string | (() => string) }) => { prompts.push(section); return () => {} },
        context: (section: { name: string; text: string | (() => string) }) => { prompts.push(section); return () => {} },
      },
      tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition); return () => { tools.delete(definition.name) } }, get: (name: string) => tools.get(name) },
      commands: { register: () => () => {}, execute: async () => undefined },
      connection: { fetch: { register: (route:{path:string}) => {routes.add(route.path);return()=>routes.delete(route.path)} } },
      get: (service: string) => (service === "sessionProjections" ? { stateOf: () => projection.todos } : service === "skills" ? skills : undefined),
    }
    // 客户端只剩这一条规则路径：Jev 每步 LLM 路由与 `LYAPUNOV_CONTEXT_ROUTER` 开关于 2026-09-26 退役，
    // 没有"环境模型路由"可再打开，所以这里不需要设置（也不该设置）任何路由开关。
    installerIsolation = isolateProviderInstaller(root)
    const previousMode=process.env.LYAPUNOV_MODE
    try{process.env.LYAPUNOV_MODE=mode;await apply(ctx as never, { captureRoot: join(root, "captures"), recordingRoot: join(root, "recordings") })}
    finally{if(previousMode===undefined)delete process.env.LYAPUNOV_MODE;else process.env.LYAPUNOV_MODE=previousMode}
    installerIsolation.assertCalled()
    return { prompts, listeners, projection, tools, routes, dispose }
  } catch (error) {
    await dispose()
    throw error
  } finally {
    installerIsolation?.restore()
  }
}

/** 最小 agent 形状：session 供 todo 投影读取，ctx 供 scopeOf 判作用域（替身为无作用域）。 */
const stubAgent = () => ({ session: { header: { id: "session-test" } }, ctx: {} })

describe("ENV-01 同一句请求 + 不同附件 → 不同路径（矩阵）", () => {
  const SAME_TEXT = "把这张图做成场景"
  const matrix: readonly { label: string; blocks: unknown[]; source: EnvironmentInputSource; hints: string[]; scale: string }[] = [
    { label: "无附件（文字创作）", blocks: [], source: "text", hints: ["environment-planning"], scale: "Pending confirmation" },
    { label: "照片（现实复现）", blocks: [imageBlock("site.jpg")], source: "photo", hints: ["environment-planning", "photo-reconstruction", "environment-research"], scale: "Estimate" },
    { label: "图纸图（CAD 重建）", blocks: [imageBlock("一层平面图.png", 2400, 1600, "image/png")], source: "cad", hints: ["environment-planning", "cad-import"], scale: "drawing dimensions" },
    { label: "照片+dxf（混合输入）", blocks: [imageBlock("site.jpg"), fileBlock("总平.dxf")], source: "mixed", hints: ["environment-planning", "cad-import", "environment-research", "asset-generation"], scale: "Estimate" },
  ]
  for (const row of matrix) {
    test(`${row.label} → ${row.source}，规格尺度=${row.scale}`, () => {
      const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: SAME_TEXT }, ...row.blocks)] })
      expect(decision.stage).toBe("new")
      expect(decision.inputSource).toBe(row.source)
      expect(decision.hints.map(hint => hint.name)).toEqual(row.hints)
      expect(decision.spec!.scale).toContain(row.scale)
      expect(decision.spec!.unknowns).toContain("Budget")
    })
  }
  test("已有场景修改（第五条路径）：已选场景 + 修改动词 → 就地改，保留目标", () => {
    const decision = routeEnvironment({ messages: [userMessage({ type: "text", text: "把院墙加高一点" })], selection: { sceneId: "courtyard-1" } })
    expect(decision.stage).toBe("local")
    expect(decision.inputSource).toBe("existing-scene")
    expect(decision.hints.map(hint => hint.name)).toEqual([undefined, "scene-construction"])
    expect(decision.hints[0]!.why).toContain("Resolve reference gaps as needed")
    expect(decision.hints[0]!.why).toContain("identify the affected component")
    expect(decision.spec!.deliverables).toContain("preserve courtyard-1 the existing target")
  })
})

describe("ENV-02 简短场景规格：字段齐全、未知项显式、局部修改保留目标", () => {
  test("简短短语也产出全部字段；取不到的进未知项，不编造", () => {
    const spec = routeEnvironment({ messages: [userMessage({ type: "text", text: "做一个庭院场景" })] }).spec!
    expect(Object.keys(spec)).toEqual(["purpose", "scope", "era", "scale", "objects", "style", "camera", "deliverables", "budget", "unknowns"])
    expect(spec.scope).toBe("庭院")
    expect(spec.objects).toBe("庭院")
    expect(spec.purpose).toBe("Pending confirmation")
    expect(spec.era).toBe("Pending confirmation")
    expect(spec.scale).toBe("Pending confirmation")
    expect(spec.style).toBe("Pending confirmation")
    expect(spec.camera).toBe("Pending confirmation")
    expect(spec.budget).toContain("Pending confirmation")
    expect(spec.deliverables).toContain("native Viewer")
    expect(spec.unknowns).toEqual(["Purpose", "Era", "Scale", "Style", "Camera", "Budget"])
  })

  test("用户话里点名的用途/年代/风格/机位写进规格（只取原话，不猜）", () => {
    const spec = routeEnvironment({ messages: [userMessage({ type: "text", text: "做一个民国的中式庭院，用于展览，要俯瞰机位" })] }).spec!
    expect(spec.purpose).toBe("展览")
    expect(spec.era).toBe("民国")
    expect(spec.style).toBe("中式")
    expect(spec.camera).toBe("俯瞰")
    expect(spec.unknowns).toEqual(["Scale", "Budget"])
  })

  test("只方案档交付只写计划；停止与非环境档不产出规格", () => {
    const planOnly = routeEnvironment({ messages: [userMessage({ type: "text", text: "只给方案，先不要做庭院" })] })
    expect(planOnly.stage).toBe("plan-only")
    expect(planOnly.spec!.deliverables).toContain("Plan only")
    const stop = routeEnvironment({ messages: [userMessage({ type: "text", text: "停止庭院搭建" })], todos: [environmentTodo("搭建庭院")] })
    expect(stop.stage).toBe("stop")
    expect(stop.spec).toBeUndefined()
    expect(routeEnvironment({ messages: [userMessage({ type: "text", text: "你好" })] }).spec).toBeUndefined()
  })

  test("规格行进注入文本、在收尾句之前，十个字段名都在", () => {
    const plan = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "建个厂房" })] })!
    const lines = plan.text.split("\n")
    expect(lines.at(-1)).toBe(POINTER_FOOTER)
    const specLine = lines.at(-2)!
    expect(specLine).toContain("Scene specification (ENV-02)")
    for (const field of SCENE_SPEC_FIELDS) expect(specLine).toContain(`${field}=`)
  })
})

// N124 / ENV-53 收口：整体重构的**口语写法**也必须进"先规划"档。
// 真实回合（N124 R1）：「把整个院子推倒重来」原先 stage=none —— 没有一个建造词命中，
// 于是连 environment-planning 的先规划契约都不注入；补 重来|重做 后按 new 档走。
describe("ENV-53 收口：整体重构的另一种说法也要先规划", () => {
  test("「把整个院子推倒重来」→ 新建/整体重构档，注入先规划契约", () => {
    const plan = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "把整个院子推倒重来" })] })!
    expect(plan.decision.stage).toBe("new")
    expect(plan.decision.matched).toBe("重来")
    expect(plan.text.split("\n")[0]).toContain("[Create/rebuild] (matched \"重来\")")
    expect(plan.text).toContain("plan as needed for complexity")
    expect(plan.text).not.toContain("do not model without planning")
  })

  test("补词不放宽边界：没有环境名词时「推倒重来」照旧不判定", () => {
    expect(routeEnvironment({ messages: [userMessage({ type: "text", text: "这个方案推倒重来" })] }).stage).toBe("none")
    expect(renderEnvironmentPointer(routeEnvironment({ messages: [userMessage({ type: "text", text: "这个方案推倒重来" })] }))).toBeUndefined()
  })
})

// N206：缺件提示补齐到 local / new 两档（真实回合 N199：同一禁用宿主里 local 档原本静默）。
describe("N206 缺件提示：local / new 两档也要如实点名缺失能力", () => {
  const withoutBlender = (name: string): boolean => name !== "blender_run"
  const GAP = "The current instance has no visible blender_run tools"

  test("局部修改不假定需要 Blender；new/plan-only 的可用性缺口仍按事实提示", () => {
    const local = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "把院墙加高 0.3 m" })], hasTool: withoutBlender })!
    expect(local.decision.stage).toBe("local")
    expect(local.text).not.toContain(GAP)

    const fresh = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "建个厂房" })], hasTool: withoutBlender })!
    expect(fresh.decision.stage).toBe("new")
    expect(fresh.text).toContain(GAP)

    const planOnly = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "只给方案：在北侧院墙加一道影壁" })], hasTool: withoutBlender })!
    expect(planOnly.decision.stage).toBe("plan-only")
    expect(planOnly.text.split("The current instance has no visible").length - 1).toBe(1)
    expect(planOnly.text).toContain(GAP)
  })

  test("负对照：工具都在时 local / new 不得出现缺口提示", () => {
    const allVisible = (): boolean => true
    const local = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "把院墙加高 0.3 m" })], hasTool: allVisible })!
    const fresh = planDomainPointers({ pointers: [], messages: [userMessage({ type: "text", text: "建个厂房" })], hasTool: allVisible })!
    expect(local.text).not.toContain("The current instance has no visible")
    expect(fresh.text).not.toContain("The current instance has no visible")
  })
})
