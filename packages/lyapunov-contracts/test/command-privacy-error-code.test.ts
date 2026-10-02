/**
 * `publicErrorCode()` 的**判据形状**：**形状在前、按码分类**，不是"在消息里搜词"。
 *
 * 来源（`bugfixHistory/SHARE-STATUS-SHAPE-20260926.md` §1.2 ③ + §9-3(a)）：本仓"消息正则决定状态"
 * 只有一处同机制残留 —— `command-privacy.ts` 的 `publicErrorCode()`。同一份回执 §1.3 给出了同形误判的
 * **实测现场**：诊断消息第二行就是上游 URL（`…/ACCOUNT/v1/me`），于是「上游 503」被 `/AUTH|ACCOUNT/`
 * 抢成 401「请重新登录」，用户的下一步动作与真实故障完全相反。
 *
 * 本文件钉住四件事（每件都对着 321 个真实源文件 / 2,400+ 个真实码形状 token 取的读数，见 §⑤）：
 *  ① **形状判据在前**：`<码>` / `<码>: 人话` / `<码>：人话` 才认码；URL、上游报文、人话不参与（`publicErrorCodeToken`）。
 *  ② **按码分类**：段级词表（整段相等，`REQUIREDX` 不算 `REQUIRED`）+ 码里**整段**出现的状态数字。
 *  ③ **误判被纠正**（4 个真实码）：改前 `/…|402/` 是唯一按数字判的规则，`_403`/`_404` 那四个码
 *     全部落 `P500`「操作失败，请查看诊断导出」——而 `P500` 那一支的文案是**回显原始消息**，既更不准也更漏。
 *  ④ **不许放宽**：段级词表把 `DECLARED` 与 `UNDECLARED` **两段都**登记成 P422 —— 漏掉后者会让那 9 个
 *     真实码掉进 `P500` 的回显支（那是放宽，不是"更准"）。这一条是负对照方向之一。
 *
 * 运行：`bun test packages/lyapunov-contracts/test/command-privacy-error-code.test.ts`
 */
import { describe, expect, test } from "bun:test"

import { publicCommandError, publicErrorCode, publicErrorCodeOfToken, publicErrorCodeToken } from "../src/command-privacy.ts"

describe("A07 Isaac 与几何运行环境故障",()=>{
  test("Isaac 专属故障使用既有 P500 固定说明，不提示调整模型请求或回显内部路径",()=>{
    for(const code of ['ISAAC_SDK_UNAVAILABLE','ISAAC_SDK_VERSION_INCOMPATIBLE','ISAAC_LICENSE_CONFIRMATION_REQUIRED',
      'ISAAC_ENGINE_CONFIG_UNSUPPORTED','ISAAC_GPU_DEVICE_UNAVAILABLE','ISAAC_KIT_START_FAILED','ISAAC_EXTENSION_UNAVAILABLE','ISAAC_PHYSX_UNAVAILABLE']){
      const result=publicCommandError(`${code}: private_marker /home/alice/sdk/python: internal metadata`)
      expect(result.code,code).toBe('P500')
      expect(result.message).not.toContain('请求内容')
      expect(result.message).not.toContain('private_marker')
      expect(result.message).not.toContain('/home/alice')
    }
  })
  test("几何依赖故障与派生失败保留固定提示；其它 UNAVAILABLE 家族的原映射不变",()=>{
    expect(publicCommandError('ASSET_BAKE_DEPENDENCY_UNAVAILABLE: private_marker').message).toContain('几何依赖')
    expect(publicCommandError('PHYSICS_DERIVATION_FAILED: private_marker').message).toContain('碰撞生成失败')
    expect(publicCommandError('PHYSICS_DERIVATION_FAILED: private_marker').message).not.toContain('private_marker')
    expect(publicErrorCode('PROVIDER_UNAVAILABLE')).toBe('P422')
    expect(publicErrorCode('ADMIN_SERVICE_UNAVAILABLE')).toBe('P422')
  })
})

/** 公开码的**完整值域**（人类面只出这五个；不是 HTTP 状态码）。 */
const PUBLIC_CODES = ["P402", "P404", "P422", "P403", "P500"] as const

/** 改前（HEAD）那四条消息正则，逐字照抄 —— 只作**参照物**，产品判据里已经没有它们的位置（见 §① 的引理）。 */
const legacyPublicErrorCode = (internal: string): string => {
  if (/PAYMENT_REQUIRED|402/.test(internal)) return "P402"
  if (/NOT_FOUND|NOT_DOWNLOADED|NO_MATCH|MISSING/.test(internal)) return "P404"
  if (/INVALID|UNAVAILABLE|UNSUPPORTED|DECLARED/.test(internal)) return "P422"
  if (/BLOCKED|DENIED|UNAUTHORIZED|FORBIDDEN|EXPIRED|INTEGRITY/.test(internal)) return "P403"
  return "P500"
}

describe("① 形状判据在前：只认 `<码>` / `<码>: 人话` / `<码>：人话`", () => {
  test("三种结构化形状取到码；URL / 上游报文 / 人话开头一律取不到（不猜）", () => {
    expect(publicErrorCodeToken("PACK_PAYMENT_REQUIRED")).toBe("PACK_PAYMENT_REQUIRED")
    expect(publicErrorCodeToken("PACK_PAYMENT_REQUIRED: 该包需要付费，见 https://api.vorynel.com/packs/v1"))
      .toBe("PACK_PAYMENT_REQUIRED")
    expect(publicErrorCodeToken("PACK_PAYMENT_REQUIRED：该包需要付费")).toBe("PACK_PAYMENT_REQUIRED")
    // 冒号在码之前出现 ⇒ 第一个冒号之前那一段不是码 ⇒ 取不到（这正是"上游 URL 抢判据"那条现场的形状）。
    expect(publicErrorCodeToken("取件失败，见 https://api.vorynel.com/ACCOUNT/v1/me")).toBeUndefined()
    expect(publicErrorCodeToken("https://api.vorynel.com/x")).toBeUndefined()
    expect(publicErrorCodeToken("上游 503：PACK_NOT_FOUND")).toBeUndefined()
    // 单段词不是码（`MISSING` / `P500` 都不是"内部码"的形状）：判据不接受"最像的那个词"。
    expect(publicErrorCodeToken("MISSING")).toBeUndefined()
    expect(publicErrorCodeToken("P500")).toBeUndefined()
    expect(publicErrorCodeToken("")).toBeUndefined()
  })

  test("引理：取到码时，改前那条消息正则的首个命中**必然就是这个码**（⇒ 取码结果不变，只换了分类依据）", () => {
    const head = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/
    for (const sample of [
      "PACK_PAYMENT_REQUIRED: 该包需要付费，见 https://api.vorynel.com/packs/v1",
      "PACK_PAYMENT_REQUIRED：付费",
      "POLICY_REMOTE_403: 上游拒绝",
      "CUA_CLIPBOARD_READ_REFUSED: 读侧一律不读",
      "NETWORK_ASSET_HTTP_404",
    ]) {
      const structured = publicErrorCodeToken(sample)
      expect(structured).toBeDefined()
      expect(head.exec(sample)?.[1], sample).toBe(structured!)
    }
  })

  test("取不到码时保留**改前那四条**消息正则的答案（原样，不新增第二条消息正则）", () => {
    // 产品路径上这一步不会发生（`publicCommandError` 传进来的就是取出来的码或 "P500" 兜底）；
    // 这些断言钉的是"外部调用者传非码入参时答案一个字不改"。
    for (const prose of ["MISSING", "取件失败：MISSING 索引项", "上游 402", "P500", "操作失败"])
      expect(publicErrorCode(prose), prose).toBe(legacyPublicErrorCode(prose))
  })
})

describe("② 按码分类：段级词表（整段相等，不是子串）", () => {
  test("段级：`REQUIREDX` 不算 `REQUIRED`（改前子串判据会吞掉它）", () => {
    expect(publicErrorCodeOfToken("PACK_PAYMENT_REQUIREDX")).toBe("P500")
    // 改前：/PAYMENT_REQUIRED/ 命中 "PAYMENT_REQUIREDX" ⇒ P402。这是"在码里搜词"的另一面。
    expect(legacyPublicErrorCode("PACK_PAYMENT_REQUIREDX")).toBe("P402")
    expect(publicErrorCode("PACK_PAYMENT_REQUIREDX")).toBe("P500")
    expect(publicErrorCode("PACK_PAYMENT_REQUIRED")).toBe("P402")
  })

  test("短语要求相邻且逐段相等（`NOT`+`FOUND` / `NO`+`MATCH` / `PAYMENT`+`REQUIRED`）", () => {
    expect(publicErrorCodeOfToken("ASSET_NOT_FOUND")).toBe("P404")
    expect(publicErrorCodeOfToken("POLICY_NO_MATCH")).toBe("P404")
    expect(publicErrorCodeOfToken("POLICY_NOT_MATCH")).toBe("P500")   // 段相邻但不是那条短语
    expect(publicErrorCodeOfToken("PACK_PAYMENT_DECLINED")).toBe("P500")
  })

  test("段级判据的优先级与改前四条正则**逐条一致**（P402 → P404 → P422 → P403）", () => {
    // 同时命中两类时先命中先返回：改前 `/MISSING/` 也在 `/INVALID/` 之前。
    expect(legacyPublicErrorCode("WEIGHTS_MISSING_INVALID")).toBe("P404")
    expect(publicErrorCode("WEIGHTS_MISSING_INVALID")).toBe("P404")
    expect(legacyPublicErrorCode("QUEUE_BLOCKED_INVALID")).toBe("P422")
    expect(publicErrorCode("QUEUE_BLOCKED_INVALID")).toBe("P422")
  })
})

describe("③ 误判被纠正：码里整段的状态数字（改前 4 个真实码全部落在 P500 的回显支）", () => {
  test("`_403` / `_404` 的真实码按**码**归类，不再落 P500", () => {
    const corrected: ReadonlyArray<readonly [string, string, string]> = [
      // 码                              改前      改后     出处
      ["POLICY_REMOTE_403", "P500", "P403"],              // packages/policy-registry/src/source.ts
      ["NETWORK_ASSET_HTTP_403", "P500", "P403"],         // packages/scene-kit/src/reference-tools.ts
      ["NETWORK_ASSET_HTTP_404", "P500", "P404"],         // packages/scene-kit/src/reference-tools.ts
      ["ENVIRONMENT_ASSET_HTTP_404", "P500", "P404"],     // packages/scene-kit/src/environment-assets.ts
    ]
    for (const [code, before, after] of corrected) {
      expect(legacyPublicErrorCode(code), `${code} 改前`).toBe(before)
      expect(publicErrorCode(code), `${code} 改后`).toBe(after)
    }
  })

  test("P500 那一支会**回显原始消息**，所以「更准」同时是「更不漏」（这就是要修的理由）", () => {
    const leaky = "POLICY_REMOTE_403: 上游拒绝，见 https://api.vorynel.com/internal/policy/index.json"
    expect(publicCommandError(leaky).code).toBe("P403")
    // P403 的文案是固定句；改前落 P500 时这一支会把首行人话（含上游 URL）拼出来。
    expect(publicCommandError(leaky).message).not.toContain("vorynel")
  })

  test("`410` 不登记：没有任何产品侧判据要求它归到哪一类 ⇒ 按改前原样 P500（不发明映射）", () => {
    expect(legacyPublicErrorCode("NETWORK_ASSET_HTTP_410")).toBe("P500")
    expect(publicErrorCode("NETWORK_ASSET_HTTP_410")).toBe("P500")
  })
})

describe("④ 不许放宽：`*_UNDECLARED` 九个真实码必须仍是 P422（段级词表两段都登记）", () => {
  const undeclared = [
    "PACK_MODEL_ENTRY_UNDECLARED", "MODEL_SOURCE_UNDECLARED", "MODEL_FILES_UNDECLARED", "MODEL_ENTRY_UNDECLARED",
    "NORM_DIMS_UNDECLARED", "POLICY_WEIGHTS_UNDECLARED", "MODEL_FACE_UNDECLARED", "POLICY_MIRROR_IDENTITY_UNDECLARED",
    "UNIT_UNDECLARED",
  ] as const

  test("九个码改前改后都是 P422（若只登记 `DECLARED`，它们会掉进 P500 的回显支 = 放宽）", () => {
    for (const code of undeclared) {
      expect(legacyPublicErrorCode(code), code).toBe("P422")
      expect(publicErrorCode(code), code).toBe("P422")
    }
  })

  test("不许变少：真实码 corpus 里落在 P402/P403/P404/P422 的答案，与**本判据**逐字相同", () => {
    // 表是**从全仓真实码枚举出来的**（`packages/<pkg>/src` 里形如错误码的 token），每类取前 14 个。
    // 除 §③ 那 4 个状态码外，我这一处改动**不该**改变任何答案 —— 这一条就是那个断言的载体。
    //
    // ✅ `*_UNAVAILABLE` 一族**已回到 P422**（2026-09-27 04:0x，Lead 更正裁定【撤销】）：
    //    另一条 lane（W22-R2）曾在 03:38-03:42 把它移出 P422 ⇒ 这一族落 `P500` 的**回显支**。
    //    撤销的依据与代价（+80/+66、约 20 个码回显插入的内部值、5 个公开码的值域是契约）见
    //    `command-privacy.ts` 段级词表注释与回执 `bugfixHistory/UNAVAILABLE-REVERT-20260927.md`。
    //    ⇒ 这 3 个码回到本表的 P422 行，与**冻结的 15 条判据**那一版逐字一致。
    const corpus: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["P402", ["PACK_PAYMENT_REQUIRED", "PAYMENT_REQUIRED"]],
      ["P403", ["GENERATION_BLOCKED", "MCP_OAUTH_VERIFIER_EXPIRED", "MOUNT_EXPIRED", "NETWORK_ASSET_HTTP_403", "PACK_FORBIDDEN",
        "PACK_INTEGRITY_MISMATCH", "PACK_MOUNT_EXPIRED", "PACK_PUBLIC_FALLBACK_FORBIDDEN", "PACK_UNAUTHORIZED", "PATH_BLOCKED",
        "POLICY_HF_ENDPOINT_FORBIDDEN", "POLICY_HF_REDIRECT_FORBIDDEN", "POLICY_MATCH_BLOCKED", "POLICY_MIRROR_OFFICIAL_HF_FORBIDDEN"]],
      ["P404", ["ACTION_NOT_FOUND", "ACTION_UNITS_MISSING", "ASSET_ACQUISITION_ARCHIVE_MEMBER_MISSING",
        "ASSET_ACQUISITION_ENTRY_NOT_FOUND", "ASSET_ACQUISITION_FILE_NOT_FOUND", "ASSET_ACQUISITION_GLB_BIN_MISSING",
        "ATTACHMENT_PATH_MISSING", "BEHAVIOR_EVIDENCE_MISSING", "BEHAVIOR_EVIDENCE_RECEIPT_FIELD_MISSING",
        "BENCHMARK_SCENE_PARENT_MISSING", "BENCHMARK_SUITE_NOT_FOUND", "BENCHMARK_TASK_NOT_FOUND", "BLENDER_OUTPUT_MISSING",
        "BLEND_PROBE_MISSING"]],
      ["P422", ["ACTION_UNSUPPORTED", "ADMIN_IDENTITY_INVALID", "ADMIN_SERVICE_UNAVAILABLE", "ADMIN_SESSION_INVALID",
        "ANNOTATION_ANCHOR_INVALID", "ANNOTATION_OVERLAY_CONTEXT_UNAVAILABLE", "ANNOTATION_ROWS_INVALID", "ANNOTATION_TEXT_INVALID",
        "ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE", "ASSET_ACQUISITION_GLTF_VERSION_UNSUPPORTED",
        "ASSET_ACQUISITION_MAX_BYTES_INVALID", "ASSET_ACQUISITION_NESTED_ARCHIVE_UNSUPPORTED",
        "ASSET_ACQUISITION_SOURCE_FACT_INVALID", "ASSET_ACQUISITION_TAGS_INVALID",
        "MODEL_ENTRY_UNDECLARED", "UNIT_UNDECLARED", "MODEL_SOURCE_UNDECLARED"]],
    ]
    for (const [expected, codes] of corpus) {
      for (const code of codes) {
        // 我这一处改动**有意**改判的只有那 4 个"码里自带状态数字"的码；其余必须与改前逐字相同。
        const intentionallyChanged = ["POLICY_REMOTE_403", "NETWORK_ASSET_HTTP_403", "NETWORK_ASSET_HTTP_404", "ENVIRONMENT_ASSET_HTTP_404"]
        expect(publicErrorCode(code), code).toBe(expected)
        if (!intentionallyChanged.includes(code)) expect(publicErrorCode(code), `${code}（不许变）`).toBe(legacyPublicErrorCode(code))
      }
    }
  })

  test("撤销登记：`*_UNAVAILABLE` 一族回到 P422 —— 并发 lane 的 P500 改判已由 Lead 裁定【撤销】", () => {
    // 改判者：2026-09-27 03:38-03:42 另一条 lane（注释里写 W22-R2），叠在本判据之上；它的依据（逐字见
    // 撤销前 `PUBLIC_CODE_BY_SEGMENTS` 上方的注释）是：`X_UNAVAILABLE` 的语义是"某个**依赖/服务/观测**
    // 当前拿不到"，归 P422 会让用户读到「请求内容不符合要求，请调整后重试」——**对用户自己的动作说了一句假话**。
    //
    // Lead 更正后的裁定【撤销】，四条：
    //   ① **方向**：本单目的是"更少落 P500 = 更少回显"，而这一条把净方向从 −4 翻成 **+80/+66**
    //      （全码形状 token 宇宙 HEAD 1841 → 1921）；② 冻结的 15 条判据（本用例就是其中一条）在它之下
    //      **永远不可能 15/0**（唯一红点是 `ADMIN_SERVICE_UNAVAILABLE`）；
    //   ③ **代价实测**：这一族落 P500 后，62 个真实抛出码里 35 个会回显一句人话，其中约 20 条含**插入的
    //      内部值**（作业结果 JSON 片段 / PROJ 版本与运算名 / 宿主引擎配置 / 上游档位错误串 / **环境变量名**）；
    //   ④ 本仓公开码值域只有 5 个（P402/P404/P422/P403/P500），那是判据钉住的**契约**，不该由并发 lane 顺手改。
    // **反向的诚实（保留）**：P422 那句**不是处处为假** —— `CLIPBOARD_UNAVAILABLE: Wayland需要wl-paste…`、
    // `PROVIDER_UNAVAILABLE: 设置 LYAPUNOV_ALGORITHM_PYTHON…` 这类"改自己的环境再重试"是**正确动作**
    // ⇒ 撤销是"恢复到**回显面最小**"，不是"恢复到完美"；"P422 对 `X_UNAVAILABLE` 说假话"若确实值得修，
    // 正解是**新增第 6 个公开码（P503）的独立立项**（契约变更），本单不做（已登记为待办）。
    for (const code of ["ADMIN_SERVICE_UNAVAILABLE", "ANNOTATION_OVERLAY_CONTEXT_UNAVAILABLE",
      "ASSET_ACQUISITION_DEPENDENCY_UNAVAILABLE", "VIEWER_WEBGL_UNAVAILABLE"])
      expect(publicErrorCode(code), code).toBe("P422")
    // 撤销的是"移除 `UNAVAILABLE` **这一个段**"，不是"段级判据整体失效" —— 同族的 INVALID/UNSUPPORTED 仍在。
    expect(publicErrorCode("ADMIN_SESSION_INVALID")).toBe("P422")
    expect(publicErrorCode("MODEL_ENTRY_UNDECLARED")).toBe("P422")
    // 这一族**不再**落 P500 回显支（这正是撤销的目的：少显示一句原文）。
    expect(publicErrorCode("ADMIN_SERVICE_UNAVAILABLE")).not.toBe("P500")
  })
})

describe("⑤ 负对照：消息含敏感词但**非**敏感内容 ⇒ 分类跟着**码**走，不跟着人话走", () => {
  test("码说 P500，人话里塞满 402 / MISSING / BLOCKED 也不改判", () => {
    const text = "POLICY_MIRROR_ARCHIVE_OK: 上游回 402，MISSING 的是临时文件，BLOCKED 的是这个提示词"
    // 人话里的词只许影响"P500 那一支的回显内容"，绝不参与分类。
    expect(publicCommandError(text).code).toBe("P500")
    expect(legacyPublicErrorCode("POLICY_MIRROR_ARCHIVE_OK")).toBe("P500")
  })

  test("码说 P404，人话里写着 402 也不改判（改前靠首个码 token 侥幸正确；现在按码，结构上不可能错）", () => {
    const text = "PACK_NOT_FOUND: 上游返回 402，需要订阅；这不是本地缺失"
    expect(publicCommandError(text).code).toBe("P404")
  })

  test("形状判据在消息正则之前：上游 URL 里的 `/ACCOUNT/` 不能把上游故障抢成别的类", () => {
    // 同形现场的复刻（`SHARE-STATUS-SHAPE-20260926.md` §1.3 (c)）：诊断消息里带上游 URL。
    const text = "PACK_NOT_DOWNLOADED: 取件失败，见 https://api.vorynel.com/ACCOUNT/v1/me（HTTP 503）"
    expect(publicErrorCodeToken(text)).toBe("PACK_NOT_DOWNLOADED")
    expect(publicCommandError(text).code).toBe("P404")
  })

  test("公开码值域只有五个（不是 HTTP 状态码）；且同一个码是纯函数", () => {
    for (const code of ["PACK_PAYMENT_REQUIRED", "PACK_NOT_DOWNLOADED", "PACK_INTEGRITY_MISMATCH",
      "PACK_MODEL_ENTRY_INVALID", "POLICY_REMOTE_403", "NOTHING_LIKE_THIS"]) {
      expect(PUBLIC_CODES as readonly string[]).toContain(publicErrorCode(code))
      expect(publicErrorCode(code)).toBe(publicErrorCode(code))
    }
  })
})
