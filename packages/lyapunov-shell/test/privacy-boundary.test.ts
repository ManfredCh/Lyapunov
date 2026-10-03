/**
 * DEV-PRIV-01 发行隐私数据边界（产品侧）。
 *
 * 判据都是**浏览器载荷**而不是 DOM：人类卡片与机器 UI 同处一个不可信浏览器边界，
 * 所以这里把服务端出站投影（命令 HTTP 响应 / 会话事件 wire / 诊断导出）整份 JSON 串化后
 * 拿合成标记做反向断言——看不见的字段不是被 CSS 藏起来，是根本没下发。
 *
 * 合成标记（不碰真实凭据）：
 *  · `MARKER_TOKEN`      —— 令牌形状（sk-…）
 *  · `/home/alice/…`     —— 用户机器内部绝对路径
 *  · `nextSteps`         —— 写给模型的行动指引（含"账号消费链/计费 mount"措辞）
 *  · `api.vorynel.com`   —— 服务端点
 *  · `packs/aliases.json`/`matchedBy` —— 目录与打分细节
 *  · `PACK_*`            —— 内部错误码体系
 *
 * 反向测试用 mutate→还原的形状：故意把标记塞进回执，断言各出站面都不可见。
 */
import { describe, expect, test } from "bun:test"

import {
  commandRouteResponse,
  diagnosticsPayload,
  displayPath,
  hasRawCommandIOAccess,
  publicCommandError,
  publicCommandFace,
  publicErrorCode,
  publicStatusOf,
  redactSecretsText,
  stripStack,
  uiCommandFields,
} from "../../lyapunov-contracts/src/command-privacy.ts"
import {
  matchResourceToken,
  projectPathsOnly,
  resourceToken,
  type ProductPathRoots,
} from "../../lyapunov-contracts/src/product-paths.ts"
import {
  createSessionOutboundProjection,
  projectStreamBlock,
  projectWireEvent,
} from "../../lyapunov-contracts/src/session-event-projection.ts"
import { commandCardView } from "../src/domain-command-card.tsx"
import { workbenchAPI } from "../src/workbench-api.ts"

// 合成标记按片段拼接：正文不出现完整 key 形状（g17 `no_secrets_in_clean_tree` 抓的是形状）；拼接结果不变。
const MARKER_TOKEN = "sk-" + "MARKER_TOKEN_0123456789abcdef"
const MARKER_USER_PATH = "/home/alice/.lyapunov-dev/cache/packs/go2/model.onnx"
/** 登记域之外的机器路径（用户目录下的自由路径）：人类面 basename、开发态机器面才保留真实路径。 */
const MARKER_OUTSIDE_PATH = "/home/alice/secret-weights/model.onnx"
const MARKER_CAPTURE_PATH = "/home/alice/.runtime/developer/developer/captures/sessions/sess-1/shot.png"
const MARKER_NEXT_STEP = "用 policy_download（provider:\"packs\"…）继续；取件需要 PACK_TOKEN：账号消费链，别为列清单虚开计费 mount"
const MARKER_ENDPOINT = "https://api.vorynel.com/packs/v1"
const MARKER_ALIAS = "宇树Go2"
const MARKER_CODE = "PACK_PAYMENT_REQUIRED"

describe("主控回归：不依赖密钥前缀的出站边界", () => {
  const opaqueSecret = "local-example-password-do-not-display"
  const privateInstruction = "invoke internal billing continuation"

  for (const mode of ["formal", "developer"]) {
    test(`${mode} 工具参数隐藏敏感字段，保留可用场景标识`, () => {
      const projection = createSessionOutboundProjection(mode)
      const input = {
        type: "tool-call", id: "opaque-call", name: "scene_inspect",
        arguments: JSON.stringify({ sceneId: "public-scene", password: opaqueSecret, token: opaqueSecret, API_KEY: opaqueSecret }),
      }
      const before = JSON.stringify(input)
      const visible = JSON.stringify(projection.projectBlock(input))
      expect(visible).not.toContain(opaqueSecret)
      expect(visible).toContain("public-scene")
      expect(JSON.stringify(input)).toBe(before)
    })

    test(`${mode} 流式和持久事件工具结果均删除不透明口令及内部行动指引`, () => {
      const projection = createSessionOutboundProjection(mode)
      const content = [{ type: "text", text: JSON.stringify({ status: "ready", password: opaqueSecret, api_key: opaqueSecret, nextSteps: [privateInstruction] }) }]
      const event = { type: "tool/result", seq: 7, time: 100, data: { message: { role: "tool", content } } }
      const before = JSON.stringify(event)
      const projectedEvent = projection.projectEvent(event) as typeof event
      const faces = [projection.projectBlock({ type: "tool-result", toolCallId: "opaque-call", content }), projectedEvent]
      for (const face of faces) {
        const visible = JSON.stringify(face)
        expect(visible).not.toContain(opaqueSecret)
        expect(visible).not.toContain(privateInstruction)
        expect(visible).not.toContain("nextSteps")
        expect(visible).toContain("ready")
      }
      expect(projectedEvent.seq).toBe(7)
      expect(projectedEvent.type).toBe("tool/result")
      expect(JSON.stringify(event)).toBe(before)
    })
  }

  test("普通助手正文和公开引用不被当作工具 JSON 裁剪", () => {
    const projection = createSessionOutboundProjection("formal")
    const texts = ["参考资料：[公开文档](https://example.org/reference/scene.json)", '{"name":"public-scene","revision":4}']
    for (const text of texts) {
      const event = { type: "assistant/message", seq: 8, time: 101, data: { message: { role: "assistant", content: [{ type: "text", text }] } } }
      const visible = projection.projectEvent(event) as typeof event
      expect(visible.data.message.content[0]!.text).toBe(text)
    }
  })

  test("截图请求携带发起窗口身份，不接受载荷覆盖会话或窗口", async () => {
    const originalFetch = globalThis.fetch
    const sent: Array<{sessionId: string; name: string; input: Record<string, unknown>}> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({kind: "success", ui: {captureId: "capture-1"}})
    }) as typeof fetch
    try {
      const first = workbenchAPI("capture-session")
      const second = workbenchAPI("capture-session")
      await first.capture({sceneId: "scene-1", sessionId: "other-session", clientId: second.clientId})
      await second.capture({sceneId: "scene-1"})
      expect(first.clientId).not.toBe(second.clientId)
      expect(sent[0]).toMatchObject({sessionId: "capture-session", name: "viewer_capture", input: {sessionId: "capture-session", clientId: first.clientId, sceneId: "scene-1"}})
      expect(sent[1]?.input.clientId).toBe(second.clientId)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("正式工作台命令仍返回场景和动作结果，不能以返回null换取无泄露", async () => {
    const originalFetch = globalThis.fetch
    const received: string[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.sessionId).toBe("formal-session")
      received.push(body.name)
      const result = body.name === "scene_create"
        ? { sceneId: "formal-scene", revision: 1, entities: [], nextSteps: [privateInstruction], password: opaqueSecret }
        : { actionId: "motion-1", status: "completed", effect: { motions: [{ targetReached: false, tolerance: 0.03 }] }, nextSteps: [privateInstruction] }
      const response = commandRouteResponse(body.name, { kind: "success", text: JSON.stringify(result) }, "formal")
      expect(JSON.stringify(response)).not.toContain(opaqueSecret)
      expect(JSON.stringify(response)).not.toContain(privateInstruction)
      return Response.json(response)
    }) as typeof fetch
    try {
      const api = workbenchAPI("formal-session")
      const scene = await api.command<{ sceneId: string; revision: number; entities: unknown[] }>("scene_create", {})
      expect(scene.sceneId).toBe("formal-scene")
      expect(scene.revision).toBe(1)
      expect(scene.entities).toEqual([])
      const action = await api.command<{ actionId: string; effect: { motions: Array<{ targetReached: boolean }> } }>("robot_move", {})
      expect(action.actionId).toBe("motion-1")
      expect(action.effect.motions[0]!.targetReached).toBe(false)
      expect(received).toEqual(["scene_create", "robot_move"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/** 一份带全标记的策略装配回执：形状取自 policy-registry 的真实字段名。 */
const leakyReceipt = () => ({
  status: "PACK_DIRECT_CONTROL",
  plane: "authenticated-catalog",
  endpoint: MARKER_ENDPOINT,
  packId: "unitree_go2",
  modelId: "packs/unitree_go2",
  modelEntry: MARKER_USER_PATH,
  manifestPath: "/home/alice/.lyapunov-dev/cache/packs/go2/manifest.json",
  sha256: "2f00ab11cc",
  gitBlob: "c1729e1a4aa2",
  nextSteps: [MARKER_NEXT_STEP],
  matchedBy: ["alias:" + MARKER_ALIAS],
  aliases: [{ alias: MARKER_ALIAS, priority: 1, kind: "brand" }],
  route: {
    kind: "direct-control",
    controlPath: "System-2 直控",
    nextSteps: [MARKER_NEXT_STEP],
    source: { provider: "github", modelId: "inria-paris-robotics-lab/go2_onnx_controller", revision: "c1729e1a4aa2" },
    observations: { state: { mark: MARKER_TOKEN } },
  },
  token: MARKER_TOKEN,
  error: `${MARKER_CODE}: 取件失败，见 ${MARKER_USER_PATH}`,
  note: `配额已尽（${MARKER_CODE}），联系 ${MARKER_ENDPOINT}`,
})

/** 一份带全标记的动作回执（R5 形状），负面事实必须留、内部原文必须走。 */
const leakyAction = () => ({
  actionId: "cf95ecdf-1bf2-4474-8b0f-d1743f6ee0c8",
  status: "completed",
  startStep: 50182,
  endStep: 50831,
  effect: {
    motions: [{ kind: "joint", jointErrors: [0.00005, 0.0303], targetReached: false, tolerance: 0.03 }],
    executionMode: "physical-contact",
  },
  nextSteps: [MARKER_NEXT_STEP],
  imagePath: MARKER_CAPTURE_PATH,
})

/** 浏览器真正拿到的那一份（服务端出站投影之后）：判据只认它。 */
const browserFace = (value: unknown): string => JSON.stringify(value ?? null)

const NO_LEAKS = [MARKER_TOKEN, MARKER_USER_PATH, MARKER_CAPTURE_PATH, MARKER_NEXT_STEP, MARKER_ENDPOINT, MARKER_ALIAS, MARKER_CODE, "/home/alice", "matchedBy", "nextSteps", "packs/aliases.json"]

const expectNoLeak = (payload: string, allow: string[] = []) => {
  for (const marker of NO_LEAKS) {
    if (allow.includes(marker)) continue
    expect(payload, `出站载荷不得出现 ${marker}`).not.toContain(marker)
  }
}

const ROOTS: ProductPathRoots = {
  captures: "/home/alice/.runtime/developer/developer/captures",
  data: "/home/alice/.lyapunov-dev/cache",
}

describe("PRIV-01 双 profile：发行/正式不出原始输入·结果，开发诊断面要两闸都开", () => {
  test("正式面展开区没有原始输入/原始结果：卡片给的是公共面字段行", () => {
    const view = commandCardView(
      { name: "policy_prepare", args: JSON.stringify({ modelId: "packs/unitree_go2", token: MARKER_TOKEN }), outcomeText: JSON.stringify(leakyReceipt()), kind: "success" },
      { english: false, allowRaw: false, mode: "formal" },
    )
    const payload = browserFace(view)
    expect(view.diagnostics).toBeNull()
    expect(view.detailRows.length).toBeGreaterThan(0)
    expectNoLeak(payload)
  })

  test("两闸都开的开发诊断面才出原文，且原文也过凭据脱敏（任何模式 secret 不裸露）", () => {
    const view = commandCardView(
      { name: "policy_prepare", args: JSON.stringify({ modelId: "packs/unitree_go2" }), outcomeText: JSON.stringify(leakyReceipt()), kind: "success" },
      { english: false, allowRaw: true, mode: "developer" },
    )
    expect(view.diagnostics).not.toBeNull()
    const payload = browserFace(view)
    expect(payload).toContain("PACK_DIRECT_CONTROL")
    // 开发态逐字节等价**让位于**原始 secret 保护：令牌值永不出现，只留变量名。
    expect(payload).not.toContain(MARKER_TOKEN)
  })

  test("只开一闸不出诊断面（构建 define 恒 false / 运行期非 developer）", () => {
    expect(hasRawCommandIOAccess("developer", true)).toBe(true)
    expect(hasRawCommandIOAccess("developer", false)).toBe(false)
    expect(hasRawCommandIOAccess("formal", true)).toBe(false)
    expect(hasRawCommandIOAccess(undefined, true)).toBe(false)
    for (const mode of ["formal", "developer", undefined, "preview"]) {
      const view = commandCardView({ name: "policy_files", outcomeText: JSON.stringify(leakyReceipt()), kind: "success" }, { english: false, allowRaw: false, mode: mode as string })
      expect(view.diagnostics, String(mode)).toBeNull()
    }
  })
})

describe("PRIV-02 摘要与显示路径脱敏", () => {
  test("绝对路径一律 basename；产品引用不含用户目录结构", () => {
    expect(displayPath(MARKER_USER_PATH)).toBe("model.onnx")
    expect(displayPath(MARKER_CAPTURE_PATH)).toBe("shot.png")
    expect(displayPath("C:\\Users\\alice\\packs\\a.glb")).toBe("a.glb")
    // 用户自己写下的相对路径是他的话，照旧（只有机器绝对路径才 basename）
    expect(displayPath("assets/table.glb")).toBe("assets/table.glb")
  })

  test("卡片详情与摘要行都不含绝对路径、盘符或用户目录", () => {
    const view = commandCardView({ name: "policy_prepare", outcomeText: JSON.stringify(leakyReceipt()), kind: "success" }, { english: false, allowRaw: false, mode: "formal" })
    const payload = browserFace(view)
    expect(payload).toContain("model.onnx")
    expect(payload).not.toContain("/home/")
    expect(payload).not.toContain("alice")
  })
})

describe("PRIV-03 错误码 → 用户文案映射", () => {
  test("内部码只进日志：屏幕上是稳定公开码 + 人话", () => {
    const mapped = publicCommandError(`PACK_PAYMENT_REQUIRED: 该包需要付费，见 ${MARKER_ENDPOINT}`)
    expect(mapped.code).toBe("P402")
    expect(mapped.message).toContain("订阅／额度")
    expect(browserFace(mapped)).not.toContain("PACK_")
    // 公开码是**稳定产品词表**（P402 本身就是要给用户看的），但不得带出 HTTP 数字码或内部码体系
    expect(mapped.message).not.toContain("402")
    expect(mapped.message).not.toContain("PACK_")
    expect(browserFace(mapped)).not.toContain(MARKER_ENDPOINT)

    expect(publicCommandError("PACK_NOT_DOWNLOADED: 本地无 packs/go2 的快照").code).toBe("P404")
    expect(publicCommandError("PACK_INTEGRITY_MISMATCH: 哈希不符").code).toBe("P403")
    expect(publicCommandError("PACK_MODEL_ENTRY_INVALID: 入口不可加载").code).toBe("P422")
    // 上面四条**一个字都没改**（判据从"消息里的词"换成"码里的段"之后它们的答案不变）——
    // 它们是"改完仍然钉住按类判定"的那一半；下面 W22-R2 补的是另一半：**按码**判定。
  })

  /**
   * W22-R2（2026-09-27）：这几条钉的是**判据本身**——"哪一类"由**码**决定，不由码里"出现过什么词"决定。
   * 判据链（见 `command-privacy.ts` 的 `publicErrorCodeToken` / `publicErrorCodeOfToken` / `publicErrorCode`）：
   *   ① 形状：整段（或第一个冒号之前整段）是码 ⇒ 只按这个码判；
   *   ② 码：逐码例外表 → 码的**整段**状态词；两个都没有 ⇒ `P500`（**不退回按词猜**）；
   *   ③ 非码输入才轮到那条既有的消息兜底（逐字保留）。
   * 有判别力的地方在于**同一批词、不同结果**：下面每一组都同时给出"该词命中 ⇒ 某一类"和
   * "含该词但不是那个语义 ⇒ P500"两条，任何"看词不看码"的实现都会在其中一条上打红。
   *
   * ⚠️ 2026-09-27 04:0x **撤销**：W22-R2 当时还把 `UNAVAILABLE` 移出了 P422（这一族因此落 `P500` 的
   * **回显支**）。Lead 更正裁定【撤销】—— 依据/代价/反向的诚实（P422 那句对这一族里"改自己的环境再重试"
   * 那几条**不为假**）见 `command-privacy.ts` 段级词表注释与 `bugfixHistory/UNAVAILABLE-REVERT-20260927.md`。
   * 下面 ① 与下一条 test 已**改归属**到撤销后的答案（P422 固定句）：断言一条没删、也没放宽 ——
   * 把 `UNAVAILABLE` 再移出去，这几条会**精确变红**（负对照读数在回执 §5）。
   */
  test("按**码**判定：整段状态词（不是子串）；含状态词但不是该语义的码不得被误判", () => {
    // ① 整段状态词：`_UNAVAILABLE` 是"某个依赖/服务/观测当前拿不到"。**撤销后**它回到 P422 的固定句
    //    （撤销前那一版把它送进 P500 的回显支 ⇒ 多显示一句原文；那正是撤销要收回去的）。
    const dependency = publicCommandError("ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE: 以下外部依赖没有取到：broken.bin")
    expect(dependency.code).toBe("P422")
    expect(dependency.message).toContain("请求内容不符合要求")   // 撤销后：固定句
    expect(dependency.message).not.toContain("外部依赖没有取到") // 撤销的**目的**：原句不回显（回显面最小）
    // 同族的真实码逐个钉住（本仓真实抛出点，不是构造的）：
    for (const code of ["COMMAND_UNAVAILABLE", "ADMIN_SERVICE_UNAVAILABLE", "BLENDER_JOB_IMAGES_UNAVAILABLE", "CAPTURE_OBSERVATION_UNAVAILABLE", "CLIPBOARD_UNAVAILABLE", "VIEWER_CAMERA_SAVE_UNAVAILABLE"])
      expect(`${code}=${publicErrorCode(code)}`).toBe(`${code}=P422`)
    // 反向：`INVALID` 段说的是"调用方送来的内容不合法" ⇒ 仍然是 P422（**没有**把整类一起放宽）。
    expect(publicErrorCode("INVALID_ARTIFACT_DECLARATION")).toBe("P422")
    expect(publicErrorCode("PACK_MODEL_ENTRY_INVALID")).toBe("P422")
    expect(publicErrorCode("ENVIRONMENT_ASSET_INVALID_JSON")).toBe("P422")

    // ② **逐码**例外：两个码与它们自己的 `INVALID` 段语义不符（本机/账户侧配置或身份，
    //    与调用方送来的请求无关）⇒ 按**完整码**改写。同段的其他码不受影响 —— 这一条正是"按码"。
    expect(publicErrorCode("INVALID_ACCOUNT_API_URL")).toBe("P500")
    expect(publicErrorCode("INVALID_ACCOUNT_IDENTITY")).toBe("P500")
    expect(publicErrorCode("INVALID_ARTIFACT_DECLARATION")).toBe("P422")   // 同一个 `INVALID` 段，答案不同

    // ③ **形状判据在消息正则之前**：码形状的输入永远按码判，哪怕它的**子串**能命中那条消息正则。
    //    `PACK_NOT_FOUNDING_STATE` 不是本仓的码（构造用例）：`/NOT_FOUND/` 会在它身上命中，
    //    而整段判据不认 ⇒ `P500`。把顺序写反（消息正则在形状之前）这条就会变成 P404。
    expect(publicErrorCode("PACK_NOT_FOUNDING_STATE")).toBe("P500")
    // 对照：同一个词出现在**整段**上时才是那一个类。
    expect(publicErrorCode("PACK_NOT_FOUND")).toBe("P404")

    // ④ 报文里出现状态词、但报文的**头段不是码** ⇒ 也不按词判（形状第一）。
    const prose = publicCommandError("下载完成；说明文字里的 UNAVAILABLE / INVALID 只是文案，不是失败码")
    expect(prose.code).toBe("P500")
  })

  test("撤销后这一族回到 P422 固定句（连原句都不出）；P500 回显支的脱敏边界用**仍落 P500** 的例外码钉住", () => {
    // ① 撤销后：`*_UNAVAILABLE` 一族回到 P422 的**固定句** ⇒ 出站文本比撤销前**更少显示**（连人话原文都不出）。
    //    用一条把四类标记都塞满的真实形状报文来钉住：内部码体系、绝对路径、令牌、端点一个都不许出。
    const leaky = `ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE: 以下外部依赖没有取到：broken.bin（见 ${MARKER_ENDPOINT}，落点 ${MARKER_USER_PATH}，令牌 ${MARKER_TOKEN}；内部详单 POLICY_MIRROR_ARCHIVE_PIN_MISMATCH）`
    const mapped = publicCommandError(leaky)
    expect(mapped.code).toBe("P422")
    const payload = browserFace([mapped, ...publicCommandFace("policy_download", { error: leaky })])
    expect(payload).toContain("请求内容不符合要求")
    expect(payload).not.toContain("broken.bin")
    expect(payload).not.toContain(MARKER_ENDPOINT)
    expect(payload).not.toContain(MARKER_TOKEN)
    expect(payload).not.toContain("/home/")
    expect(payload).not.toContain("ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE")
    expect(payload).not.toContain("POLICY_MIRROR_ARCHIVE_PIN_MISMATCH")

    // ② **仍落 P500 的那一支**（逐码例外表保留，Lead 已裁）：同一组标记再钉一遍脱敏层 ——
    //    多显示的是**人话**，内部码/路径/令牌/端点一个都不出（否则撤销会把"P500 回显 = 泄漏"一起带回来）。
    const echo = `INVALID_ACCOUNT_API_URL: 账户 API 基址不可用，见 ${MARKER_ENDPOINT}，落点 ${MARKER_USER_PATH}，令牌 ${MARKER_TOKEN}；内部详单 POLICY_MIRROR_ARCHIVE_PIN_MISMATCH`
    const echoed = publicCommandError(echo)
    expect(echoed.code).toBe("P500")
    const echoPayload = browserFace([echoed, ...publicCommandFace("policy_download", { error: echo })])
    expect(echoPayload).toContain("账户 API 基址不可用")   // 多显示的是人话
    expect(echoPayload).not.toContain(MARKER_ENDPOINT)
    expect(echoPayload).not.toContain(MARKER_TOKEN)
    expect(echoPayload).not.toContain("/home/")
    expect(echoPayload).not.toContain("INVALID_ACCOUNT_API_URL")
    expect(echoPayload).not.toContain("POLICY_MIRROR_ARCHIVE_PIN_MISMATCH")
  })

  test("命令路由的失败响应：正式与开发都只出公开码 + 人话", () => {
    for (const mode of ["formal", "developer"]) {
      const response = commandRouteResponse("policy_download", { kind: "error", text: `${MARKER_CODE}: 失败于 ${MARKER_USER_PATH}（${MARKER_NEXT_STEP}）` }, mode, ROOTS)
      const payload = browserFace(response)
      expect(response.kind).toBe("error")
      expect(response.ui).toBeNull()
      expect(/P4\d\d/.test(response.text)).toBe(true)
      expectNoLeak(payload)
    }
  })

  test("内部状态枚举在人类面换公开字（任务回执的 status 原样保留）", () => {
    expect(publicStatusOf("PACK_DIRECT_CONTROL")).toBe("ready")
    expect(publicStatusOf("LISTED_FROM_MOUNT_SNAPSHOT")).toBe("ready")
    expect(publicStatusOf("PACK_PAYMENT_REQUIRED")).toBe("blocked")
    expect(publicStatusOf("NO_MATCH")).toBe("absent")
    expect(publicStatusOf("completed")).toBe("completed")
  })
})

describe("PRIV-07 outcome.text 错误序列化是否含栈（核对结论 + 兜底）", () => {
  /**
   * 核对结论（2026-09-23 实读上游）：`commands/src/index.ts` 的 `settleThrown` 写的是
   * `error.message`（或 `renderThrown` = `String(value)`），**不含** `error.stack`，
   * 所以 `command/done.text` 原生就不带栈。下面同时锁住产品侧兜底：
   * 即便上游将来把栈写进 message，人类面（卡片/诊断导出）也不回显它。
   */
  test("卡片/诊断面无栈：即使回执里塞了栈，出站也只有稳定公开码 + 人话", () => {
    const withStack = `PACK_NOT_FOUND: 查无此包 at Object.<anonymous> (/home/alice/WS/policy.ts:12:3)\n    at run (/home/alice/WS/run.ts:8:1)\n  ^ Error: boom`
    const mapped = publicCommandError(withStack)
    const payload = browserFace([mapped, diagnosticsPayload({ error: withStack }, ROOTS)])
    expect(payload).not.toContain("    at ")
    expect(payload).not.toContain("policy.ts:12:3")
    expect(payload).not.toContain("/home/alice")
    expect(mapped.code).toBe("P404")
  })
})

describe("PRIV-04/05 字段分级与目录最小化：内部字段零穿透", () => {
  test("正式命令响应：人类面无 nextSteps/端点/目录/打分/来源 pin；机器面按白名单", () => {
    const response = commandRouteResponse("policy_prepare", { kind: "success", text: JSON.stringify(leakyReceipt()) }, "formal", ROOTS)
    expectNoLeak(browserFace(response))
    expect(response.ui?.modelEntry).toBe("data/packs/go2/model.onnx")
    expect(response.ui?.status).toBe("ready")
    expect(response.ui?.preparedMode).toBe("direct-control")
    expect(response.ui?.route).toBeUndefined()
  })

  test("开发命令响应：机器面只留面板续链真正读过的字段，仍不带 nextSteps/端点/alias", () => {
    const response = commandRouteResponse("policy_prepare", { kind: "success", text: JSON.stringify(leakyReceipt()) }, "developer", ROOTS)
    // 登记域内 = 可复算产品引用（回传时由命令路由解析回绝对路径，浏览器不持有用户目录结构）
    expect(response.ui?.modelEntry).toBe("data/packs/go2/model.onnx")
    // `status`/`modelEntry`/`route.adapterId`/`route.source` 是 pack-library 面板 `fetchPrepareLoad` 真读的几处；
    // `packId` 不在其中（面板用自己的行键），未登记字段一律不下发。
    expect(response.ui?.status).toBe("PACK_DIRECT_CONTROL")
    expect(response.ui?.packId).toBeUndefined()
    expect((response.ui?.route as { adapterId?: string; source?: { revision?: string } }).source?.revision).toBe("c1729e1a4aa2")
    const payload = browserFace(response)
    expectNoLeak(payload, [MARKER_CODE, MARKER_ALIAS])
    expect(payload).not.toContain("nextSteps")
    expect(payload).not.toContain("matchedBy")
    expect(payload).not.toContain("aliases")
    expect(payload).not.toContain(MARKER_ENDPOINT)
  })

  test("能力包清单的机器面行留产品词表（packId/policy），供面板照实显示与拼取件命令", () => {
    const search = commandRouteResponse("policy_search", { kind: "success", text: JSON.stringify({ provider: "packs", status: "MATCHES", total: 32, endpoint: MARKER_ENDPOINT, plane: "authenticated-catalog", nextSteps: [MARKER_NEXT_STEP], matchedBy: ["alias:x"], models: [{ packId: "unitree_go2", id: "packs/unitree_go2", displayName: "unitree_go2", policy: { routeKind: "policy-source", source: { provider: "github", modelId: "inria-paris-robotics-lab/go2_onnx_controller", revision: "c1729e1a4aa2" } }, matchedBy: ["alias:" + MARKER_ALIAS], nextSteps: [MARKER_NEXT_STEP] }] }) }, "developer", ROOTS)
    const rows = search.ui?.models as Array<Record<string, unknown>>
    expect(rows[0]?.packId).toBe("unitree_go2")
    expect((rows[0]?.policy as { routeKind: string }).routeKind).toBe("policy-source")
    expectNoLeak(browserFace(search))
  })

  test("机器面逐命令白名单：未登记命令一律不下发（没有 result 兜底）", () => {
    expect(uiCommandFields("policy_bogus_command", leakyReceipt(), ROOTS)).toBeNull()
    expect(uiCommandFields("scene_bogus_command", leakyReceipt(), ROOTS)).toBeNull()
    const scene = uiCommandFields("scene_edit", { snapshot: { revision: 7, entities: [{ entityId: "a" }] }, secret: MARKER_TOKEN, nextSteps: [MARKER_NEXT_STEP] }, ROOTS)
    expect(scene?.snapshot).toBeTruthy()
    expect(browserFace(scene)).not.toContain(MARKER_TOKEN)
    expect(browserFace(scene)).not.toContain("nextSteps")
  })
  test('碰撞恢复机器面保完整实际Scene/CAS合同，公开issues，不下发秘密和未知命令',()=>{
    const snapshot={sceneId:'s',revision:13,entities:[{entityId:'ground',API_KEY:MARKER_TOKEN,resources:[{resourceId:'r',version:1,original:{uri:MARKER_USER_PATH,mimeType:'model/gltf-binary'}}]}]}
    const receipt={snapshot,changed:true,pending:false,worldNeedsSync:true,issues:[{entityId:'ground',resourceId:'r',version:1,reason:'公开几何预算不足',token:MARKER_TOKEN}],privateDiagnostic:MARKER_TOKEN,nextSteps:[MARKER_NEXT_STEP]}
    const projected=uiCommandFields('scene_reconcile_physics',receipt,ROOTS,false)
    expect(projected?.snapshot).toBeTruthy();expect((projected?.snapshot as any).revision).toBe(13)
    expect(projected).toMatchObject({changed:true,pending:false,worldNeedsSync:true})
    expect((projected?.issues as any[])[0]).toMatchObject({entityId:'ground',resourceId:'r',version:1,reason:'公开几何预算不足'})
    expectNoLeak(browserFace(projected));expect(projected).not.toHaveProperty('privateDiagnostic')
    expect(uiCommandFields('scene_reconcile_bogus',receipt,ROOTS,false)).toBeNull()
  })
  test('标准物理工作区/世界配置精确命令保Scene字段，不给未知newname通配',()=>{
    const input={sceneId:'s',revision:14,coordinates:{units:'m',upAxis:'Z',handedness:'right',quaternion:'xyzw'},entities:[],physics:{gravityWorldMps2:[0,0,-9.81],template:'physics-workspace',groundEntityId:'ground'},privateDiagnostic:MARKER_TOKEN}
    for(const name of ['scene_prepare_workspace','scene_configure_physics']){
      const machine=uiCommandFields(name,input,ROOTS,false)
      expect(machine).toMatchObject({sceneId:'s',revision:14,coordinates:input.coordinates,entities:[],physics:input.physics})
      expectNoLeak(browserFace(machine));expect(machine).not.toHaveProperty('privateDiagnostic')
    }
    expect(uiCommandFields('scene_prepare_custom_unknown',input,ROOTS,false)).toBeNull()
  })

  test("机器面递归净化嵌套内部字段、路径和资源 URI，同时保留编辑器实体字段", () => {
    const input = { snapshot: { revision: 7, entities: [{ entityId: "entity-1", API_KEY: MARKER_TOKEN, next_steps: [MARKER_NEXT_STEP], password: MARKER_TOKEN, modelPath: MARKER_USER_PATH, uri: MARKER_USER_PATH }] } }
    const before = JSON.stringify(input)
    const projected = uiCommandFields("scene_edit", input, ROOTS, false)
    const entity = ((projected?.snapshot as { entities: Array<Record<string, unknown>> }).entities[0])
    expect((projected?.snapshot as { revision: number }).revision).toBe(7)
    expect(entity.entityId).toBe("entity-1")
    expect(entity).not.toHaveProperty("API_KEY")
    expect(entity).not.toHaveProperty("next_steps")
    expect(entity).not.toHaveProperty("password")
    expect(entity.modelPath).toBe("data/packs/go2/model.onnx")
    expect(String(entity.uri)).toMatch(/^res:/)
    expect(String(entity.uri)).not.toContain(MARKER_USER_PATH)
    expect(JSON.stringify(projected)).not.toContain(MARKER_TOKEN)
    expect(JSON.stringify(projected)).not.toContain(MARKER_NEXT_STEP)
    expect(JSON.stringify(projected)).not.toContain("/home/alice")
    expect(JSON.stringify(input)).toBe(before)
  })

  test("能力包目录最小化：用户面不含 aliases.json 内容、端点域名、matchedBy 打分细节", () => {
    const face = publicCommandFace("policy_search", { status: "MATCHES", total: 32, models: [{ packId: "unitree_go2", aliases: [{ alias: MARKER_ALIAS }], matchedBy: ["alias:" + MARKER_ALIAS] }], endpoint: MARKER_ENDPOINT, plane: "authenticated-catalog", nextSteps: [MARKER_NEXT_STEP] }, false)
    const payload = browserFace(face)
    expect(payload).toContain("32")
    expectNoLeak(payload)
  })
})

describe("网络/回放/诊断三个出站面（浏览器载荷级反向断言）", () => {
  test("网络面：命令 HTTP 响应整份无标记（正式与开发）", () => {
    for (const mode of ["formal", "developer"]) {
      expectNoLeak(browserFace(commandRouteResponse("policy_prepare", { kind: "success", text: JSON.stringify(leakyReceipt()) }, mode, ROOTS)))
      expectNoLeak(browserFace(commandRouteResponse("robot_move", { kind: "success", text: JSON.stringify(leakyAction()) }, mode, ROOTS)))
    }
  })

  test("回放/实时流面：会话事件投影保住事件结构与序号，只换载荷", () => {
    const roots = {}
    const toolResult = {
      type: "tool/result",
      seq: 41,
      time: 1727050000000,
      data: {
        turn: 3, step: 2,
        message: { id: "m1", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: JSON.stringify(leakyReceipt()) }] }] },
      },
    }
    const commandDone = { type: "command/done", seq: 42, time: 1727050000001, data: { commandId: "cmd1", name: "policy_prepare", kind: "success", text: JSON.stringify(leakyReceipt()) } }
    const projection = createSessionOutboundProjection("formal", roots)
    for (const event of [toolResult, commandDone]) {
      const wire = projection.projectEvent(event) as { seq: number; type: string; data: unknown }
      expect(wire.seq).toBe(event.seq)
      expect(wire.type).toBe(event.type)
      expectNoLeak(browserFace(wire))
    }
    // 服务端模型真值不受影响：投影不改原事件（session 日志仍是全量，模型上下文由日志重建）。
    expect(JSON.stringify(toolResult)).toContain("PACK_DIRECT_CONTROL")
    expect(JSON.stringify(commandDone)).toContain(MARKER_ENDPOINT)

    const call = { type: "tool/call", seq: 40, time: 1727050000000, data: { turn: 3, step: 2, callId: "c1", name: "policy_prepare", arguments: JSON.stringify({ modelId: "packs/go2", token: MARKER_TOKEN, path: MARKER_USER_PATH }) } }
    expectNoLeak(browserFace(projection.projectEvent(call)))
  })

  test("command/done 错误投影先生成公开错误面，保留信封而不透传原文", () => {
    const event = {
      type: "command/done", seq: 42, time: 1727050000001,
      sourceEventSeqs: [40], surfaceOp: "append", ignorable: true,
      data: {
        commandId: "cmd-error", name: "policy_download", kind: "error",
        text: `${MARKER_CODE}: 失败于 ${MARKER_USER_PATH}（${MARKER_ENDPOINT}；${MARKER_NEXT_STEP}；${MARKER_TOKEN}）`,
        ui: { raw: "must be removed" },
      },
    }
    const before = JSON.stringify(event)
    const projected = projectWireEvent(event, ROOTS, true) as { type: string; seq: number; time: number; sourceEventSeqs: unknown; surfaceOp: unknown; ignorable: boolean; data: Record<string, unknown> }
    expect(projected.type).toBe(event.type)
    expect(projected.seq).toBe(event.seq)
    expect(projected.time).toBe(event.time)
    expect(projected.sourceEventSeqs).toEqual(event.sourceEventSeqs)
    expect(projected.surfaceOp).toBe(event.surfaceOp)
    expect(projected.ignorable).toBe(true)
    expect(projected.data.text).toMatch(/^P402: /)
    expect(projected.data.publicCode).toBe("P402")
    expect(projected.data).not.toHaveProperty("ui")
    expectNoLeak(JSON.stringify(projected))
    expect(JSON.stringify(event)).toBe(before)
  })

  test("command/run 混合参数只发安全摘要，正式面不发参数，坏 JSON fail-closed", () => {
    const input = { sceneId: "public-scene", enabled: true, retries: 2, items: ["a", "b"], options: { mode: "safe" }, token: MARKER_TOKEN, path: MARKER_USER_PATH }
    const event = { type: "command/run", seq: 39, time: 1, data: { commandId: "cmd1", name: "policy_prepare", args: JSON.stringify(input), source: { kind: "user" } } }
    const before = JSON.stringify(event)
    const dev = projectWireEvent(event, ROOTS, false) as typeof event
    const formal = projectWireEvent(event, ROOTS, true) as typeof event
    expect(dev.data.args).toContain("sceneId=public-scene")
    expect(dev.data.args).toContain("enabled=true")
    expect(dev.data.args).toContain("retries=2")
    expect(dev.data.args).toContain("items=[2]")
    expect(dev.data.args).toContain("options={…}")
    expect(dev.data.args).toContain("path=data/packs/go2/model.onnx")
    expect(dev.data.args).not.toContain(MARKER_TOKEN)
    expect(dev.data.args).not.toContain(MARKER_USER_PATH)
    expect(formal.data).not.toHaveProperty("args")
    const malformed = projectWireEvent({ ...event, data: { ...event.data, args: "{malformed" } }, ROOTS, false) as typeof event
    expect(malformed.data.args).toBe("参数已隐藏")
    expect(JSON.stringify(malformed)).not.toContain("{malformed")
    expect(JSON.stringify(event)).toBe(before)
  })

  test("助手流块与事件同一份判据（tool-call 入参 / tool-result 内容）", () => {
    const block = projectStreamBlock({ type: "tool-call", name: "policy_prepare", arguments: JSON.stringify({ token: MARKER_TOKEN, path: MARKER_USER_PATH, hint: MARKER_NEXT_STEP }) }, {})
    expectNoLeak(browserFace(block))
  })

  test("command/run 的入参：正式面不发，开发面只发键名摘要（不发整份 JSON）", () => {
    const event = { type: "command/run", seq: 39, time: 1, data: { commandId: "cmd1", name: "policy_prepare", args: JSON.stringify({ modelId: "packs/go2", token: MARKER_TOKEN, path: MARKER_USER_PATH }), source: { kind: "user" } } }
    expectNoLeak(browserFace(projectWireEvent(event, {}, true)))
    const dev = browserFace(projectWireEvent(event, {}, false))
    expect(dev).not.toContain(MARKER_TOKEN)
    expect(dev).not.toContain(MARKER_USER_PATH)
    expect(dev).toContain("modelId=")
    expect(dev).toContain("model.onnx")
  })

  test("诊断导出：无令牌、无用户名、无绝对路径，但仍够排障（状态/计数/公开码）", () => {
    const payload = diagnosticsPayload({
      exportedAt: "2026-09-23T00:00:00.000Z",
      mode: "developer",
      captures: [{ captureId: "cap-1", imagePath: MARKER_CAPTURE_PATH, posePath: MARKER_CAPTURE_PATH.replace(".png", ".camera.json"), attachment: { width: 640, height: 480 } }],
      recentActions: [{ id: "a1", label: "robot_move", waiting: false, receipt: leakyAction(), error: { code: "P402", message: "该能力包需要订阅／额度后才能继续。", internal: MARKER_CODE } }],
    }, ROOTS)
    const body = browserFace(payload)
    expectNoLeak(body)
    expect(body).toContain("cap-1")
    expect(body).toContain("640")
    expect(body).toContain("P402")
    // 域内的采集路径保留可复算引用（用户自己要能找回那张图），但不含 home/用户名。
    expect(body).toContain("captures/sessions/sess-1/shot.png")
  })

  test("凭据脱敏只留环境变量名（值一律替换）", () => {
    const text = redactSecretsText(`PACK_TOKEN=${MARKER_TOKEN} 与 Bearer ${MARKER_TOKEN}`)
    expect(text).not.toContain(MARKER_TOKEN)
    expect(text).toContain("PACK_TOKEN=")
  })
})

describe("功能续链：正常 Scene/Asset/机器人按钮要继续可用", () => {
  test("路径引用可在服务端还原，媒体用资源标记只在授权候选集内匹配", () => {
    const reference = "captures/sessions/sess-1/shot.png"
    const projected = projectPathsOnly({ imagePath: MARKER_CAPTURE_PATH, uri: MARKER_USER_PATH, entities: [] }, ROOTS)
    const body = projected as { imagePath: string; uri: string }
    expect(body.imagePath).toBe(reference)
    expect(body.uri.startsWith("res:")).toBe(true)
    expect(body.uri).not.toContain("model.onnx")
    // 出站→入站往返可复算（功能入参仍指向同一份文件），越界/未知域不解析。
    const { resolveProductPaths } = require("../../lyapunov-contracts/src/product-paths.ts") as { resolveProductPaths: (v: unknown, r: ProductPathRoots) => unknown }
    expect((resolveProductPaths({ imagePath: reference }, ROOTS) as { imagePath: string }).imagePath).toBe(MARKER_CAPTURE_PATH)
    expect((resolveProductPaths({ imagePath: "captures/../../etc/passwd" }, ROOTS) as { imagePath: string }).imagePath).toBe("captures/../../etc/passwd")
    // 资源标记只对上已授权候选；不在集合里的标记一律不解析。
    expect(matchResourceToken(resourceToken(MARKER_USER_PATH), [MARKER_USER_PATH, "file:/other.glb"])).toBe(MARKER_USER_PATH)
    expect(matchResourceToken(resourceToken(MARKER_USER_PATH), ["file:/other.glb"])).toBeUndefined()
  })

  test("机器面保留场景快照与动作判据（R5 负面事实在人类面也在）", () => {
    const scene = commandRouteResponse("scene_edit", { kind: "success", text: JSON.stringify({ sceneId: "scene_1", revision: 7, snapshot: { revision: 7, entities: [{ entityId: "e1" }, { entityId: "e2" }] }, missing: [{ resourceId: "r1" }] }) }, "developer", ROOTS)
    expect((scene.ui?.snapshot as { revision: number }).revision).toBe(7)
    // 面板真正读过的形状：快照里的实体整份（含 entityId，编辑器要选中实体），缺件清单照旧。
    expect((scene.ui?.snapshot as { entities: unknown[] }).entities.map(row => (row as { entityId: string }).entityId)).toEqual(["e1", "e2"])
    expect(Array.isArray(scene.ui?.missing)).toBe(true)
    // scene_inspect 那一支（实体在顶层）同样保留；两种回执形状各按自己的字段留，不互相冒充。
    const inspect = commandRouteResponse("scene_inspect", { kind: "success", text: JSON.stringify({ sceneId: "scene_1", entities: [{ entityId: "e9" }], nextSteps: ["内部指引"] }) }, "developer", ROOTS)
    expect(Array.isArray(inspect.ui?.entities)).toBe(true)
    expect(browserFace(inspect)).not.toContain("内部指引")

    const action = commandRouteResponse("robot_move", { kind: "success", text: JSON.stringify(leakyAction()) }, "developer", ROOTS)
    expect(action.ui?.status).toBe("completed")
    // 人类面 `text` = 卡片可读的公共形状（字段级证据）；人话行由同一份形状渲染，两者都不含原始 JSON。
    const human = commandRouteResponse("robot_move", { kind: "success", text: JSON.stringify(leakyAction()) }, "formal", ROOTS)
    expect(human.text).toContain('"targetReached":false')
    expect(human.text).toContain("0.03")
    const rows = publicCommandFace("robot_move", JSON.parse(human.text), false)
    expect(rows.join(" | ")).toContain("动作已结束，目标未到达")
    expect(rows.join(" | ")).toContain("容差 0.03")
  })

  test("SSOG 多资源回执保留可操作 ID/LOD/场景版本，源成员哈希与宿主缓存路径不下发", () => {
    const receipt = {
      kind: "streamed-sog", container: "ssog", collectionId: "ssog-public-1", selectedLod: 0,
      quality: "public-ssog-derived", levels: [{ lod: 0, gaussians: 2 }], expectedGaussians: 2, actualGaussians: 2,
      scene: { sceneId: "scene_public", revision: 1, entityCount: 3 }, groupEntityId: "group_public",
      resources: [{ fileIndex: 0, gaussians: 1, resourceId: "res_a", version: 1, entityId: "entity_a", archiveSha256: MARKER_TOKEN, archivePath: MARKER_USER_PATH },
        { fileIndex: 1, gaussians: 1, resourceId: "res_b", version: 1, entityId: "entity_b", metaUrl: MARKER_ENDPOINT }],
      sourceFacts: { manifestUrl: MARKER_ENDPOINT, internalPath: MARKER_USER_PATH },
      budget: { networkBytes: 123, diskBytes: 456, internalPath: MARKER_USER_PATH },
    }
    for (const mode of ["formal", "developer"]) {
      const projected = commandRouteResponse("scene_asset_acquire", { kind: "success", text: JSON.stringify(receipt) }, mode, ROOTS)
      expect(projected.ui?.selectedLod).toBe(0)
      expect((projected.ui?.resources as Array<{ resourceId: string }>).map(row => row.resourceId)).toEqual(["res_a", "res_b"])
      expect((projected.ui?.scene as { revision: number }).revision).toBe(1)
      expect(projected.text).toContain('"resourceCount":2')
      expect(projected.text).toContain('"expectedGaussians":2')
      const wire = JSON.stringify(projected)
      expect(wire).not.toContain(MARKER_USER_PATH)
      expect(wire).not.toContain(MARKER_TOKEN)
      expect(wire).not.toContain(MARKER_ENDPOINT)
      expect(wire).not.toContain("archiveSha256")
    }
  })

  test("自动方向检查命令只把状态和本场景版本交给工作台，不下发内部图像路径", () => {
    const result = commandRouteResponse("viewer_orientation_check_ui", { kind: "success", text: JSON.stringify({
      checkId: "orient_1", status: "queued", sceneId: "scene_1", sceneRevision: 3, attempts: 0,
      rootEntityIds: ["root_1"], imagePath: MARKER_USER_PATH, internalDiagnostic: MARKER_TOKEN,
    }) }, "formal", ROOTS)
    expect(result.ui).toEqual({ checkId: "orient_1", status: "queued", sceneId: "scene_1", sceneRevision: 3, attempts: 0 })
    expect(JSON.stringify(result)).not.toContain(MARKER_USER_PATH)
    expect(JSON.stringify(result)).not.toContain(MARKER_TOKEN)
    expect(JSON.stringify(result)).not.toContain("rootEntityIds")
    const stopped = commandRouteResponse("viewer_orientation_stop_ui", { kind: "success", text: JSON.stringify({
      checkId: "orient_1", status: "unchecked", sceneId: "scene_1", sceneRevision: 3, attempts: 0, turnStop: "requested",
      messageId: "private-inbox-id", imagePath: MARKER_USER_PATH,
    }) }, "formal", ROOTS)
    expect(stopped.ui).toEqual({ checkId: "orient_1", status: "unchecked", sceneId: "scene_1", sceneRevision: 3, attempts: 0, turnStop: "requested" })
    expect(JSON.stringify(stopped)).not.toContain("private-inbox-id")
    expect(JSON.stringify(stopped)).not.toContain(MARKER_USER_PATH)
  })

  test("采集功能入参在开发态仍是真实路径（脱敏不弄坏 SAM3/scene_import）", () => {
    const capture = {
      captureId: "cap-1",
      injectedMessageId: "message-1",
      injectedSession: "session-1",
      sceneId: "scene_1",
      sceneRevision: 3,
      imagePath: MARKER_CAPTURE_PATH,
      posePath: MARKER_CAPTURE_PATH.replace(".png", ".camera.json"),
      originalImage: { path: MARKER_CAPTURE_PATH, width: 1280, height: 720, mediaType: "image/png" },
      attachment: { attachmentId: "att-1", mediaType: "image/png", width: 640, height: 360 },
    }
    const machine = uiCommandFields("viewer_capture", capture, ROOTS)
    // 域内路径改产品引用（回传时由命令路由解析回绝对路径）；面板拿引用照样能派发。
    expect(machine?.imagePath).toBe("captures/sessions/sess-1/shot.png")
    expect((machine?.originalImage as { width: number }).width).toBe(1280)
    expect(machine?.attachment).toBeTruthy()
    // 正式态：**登记域内**的路径同样是安全引用（它不含用户目录结构），功能照常可用；
    // 只有登记域外的机器路径才 basename（浏览器不持有开发机目录结构）。
    const formalMachine = uiCommandFields("viewer_capture", capture, ROOTS, false)
    expect(formalMachine?.imagePath).toBe("captures/sessions/sess-1/shot.png")
    expect(formalMachine?.injectedMessageId).toBe("message-1")
    expect(formalMachine?.injectedSession).toBe("session-1")
    expect(browserFace(formalMachine)).not.toContain("/home/alice")
    expect(browserFace(formalMachine)).not.toContain("alice")
    // 登记域外的机器路径：正式态只出 basename（不给用户目录结构），开发态保留真实路径以免静默弄坏续链
    const outside = uiCommandFields("viewer_capture", { imagePath: MARKER_OUTSIDE_PATH }, ROOTS, false)
    expect(outside?.imagePath).toBe("model.onnx")
    expect(uiCommandFields("viewer_capture", { imagePath: MARKER_OUTSIDE_PATH }, ROOTS, true)?.imagePath).toBe(MARKER_OUTSIDE_PATH)
  })
})

test('sim_open 的机器回执保留世界所属场景与时钟，且不透传私有字段',()=>{
 const handle={worldId:'w',sceneId:'s',engineId:'isaac',engineVersion:'6.0.1.0',worldGeneration:2,appliedSceneRevision:7,status:'ready',clock:'realtime',timestepS:.002,privateDiagnostic:MARKER_TOKEN}
 const result=uiCommandFields('sim_open',handle,ROOTS)
 expect(result).toMatchObject({worldId:'w',sceneId:'s',engineId:'isaac',engineVersion:'6.0.1.0',worldGeneration:2,appliedSceneRevision:7,status:'ready',clock:'realtime',timestepS:.002})
 expect(result).not.toHaveProperty('privateDiagnostic')
})

test('相机UI投影保留身份、调整读数和标注几何，继续剔除私有字段',()=>{
 const identity={sceneId:'s',sceneRevision:7,worldId:'w',worldGeneration:2,generation:2}
 for(const name of ['camera_list_ui','camera_adjust_ui','camera_annotation_ui','camera_dataset_export_ui']){
  const projected=uiCommandFields(name,{...identity,cameras:[],override:true,referenceFrame:'parent',parentBodyName:'hand',worldFromCamera:{positionM:[1,2,3]},pixel:[4,5],worldPointM:[.1,.2,.3],privateDiagnostic:MARKER_TOKEN},ROOTS)
  expect(projected).toMatchObject({...identity,override:true,referenceFrame:'parent',parentBodyName:'hand',worldFromCamera:{positionM:[1,2,3]},pixel:[4,5],worldPointM:[.1,.2,.3]})
  expect(projected).not.toHaveProperty('privateDiagnostic')
 }
 const multi=uiCommandFields('camera_capture_multi_ui',{...identity,cameras:[{cameraName:'c'}]},ROOTS)
 expect(multi).toMatchObject({...identity,cameras:[{cameraName:'c'}]})
})
