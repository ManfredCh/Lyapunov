/**
 * R5：动作回执的摘要不得把「指令结束」说成「到达目标」。
 *
 * 真实回执（独立验收 `codex-cu/motion-receipt.json`，UI 下发目标 [base_yaw=.45, shoulder_pitch=.25, 其余 0]）：
 * `status="completed"`，base_yaw 0.45005（进容差），shoulder_pitch 0.28031 → 误差 0.0303 > tolerance 0.03，
 * 因此引擎明确给出 `effect.motions[0].targetReached=false`。旧摘要只写"执行完成"，把"目标未到达"这层
 * 事实藏在展开的原回执里（上一轮回执也正是据此误写成"与目标一致"，本轮纠正）。原回照旧整份保留在展开区。
 *
 * 正向对照：同样形状但 `targetReached=true` 的回执仍读作"执行完成"，不是把成功也标成未达成。
 */
import { describe, expect, test } from "bun:test"

import { domainCommandSummary, commandCardView, isPassiveSuccessRead } from "../src/domain-command-card.tsx"
import { ActionCards } from "../src/robot-control-panel.tsx"
import {commandRouteResponse} from '../../lyapunov-contracts/src/command-privacy.ts'
import {createSessionOutboundProjection} from '../../lyapunov-contracts/src/session-event-projection.ts'

/** 真实回执的字段形状（仅去掉与摘要无关的 finalState 大块）。 */
const receipt = (targetReached: boolean) => ({
  actionId: "cf95ecdf-1bf2-4474-8b0f-d1743f6ee0c8",
  status: "completed",
  startStep: 50182,
  endStep: 50831,
  effect: {
    motions: [{
      kind: "joint",
      jointErrors: [0.00005018496299619146, 0.030312900751154115, 0.0035007196872758693, 0.000006478319326862552, 0.000025724550142984468, 0.00003831240260346892],
      targetReached,
      tolerance: 0.03,
    }],
    executionMode: "physical-contact",
  },
})

const summarize = (value: unknown, name = "robot_move", english = false) =>
  domainCommandSummary(name, JSON.stringify(value), "success", english)

describe('Scene revision survives the actual human response and event projection', () => {
  for (const revision of [0, 4]) {
    test(`scene_create rev ${revision} remains visible without exposing full entities or internal fields`, () => {
      const value = {sceneId:'scene-vm076',revision,entities:[{entityId:'lyapunov-default-ground'}],
        password:'fixture-private-value',nextSteps:['fixture internal instruction']}
      const before = JSON.stringify(value)
      const response = commandRouteResponse('scene_create',{kind:'success',text:JSON.stringify(value)},'formal')
      expect(response.ui?.revision).toBe(revision)
      expect(JSON.parse(response.text)).toMatchObject({sceneId:'scene-vm076',revision,entities:1})
      expect(response.text).not.toContain('fixture-private-value')
      expect(response.text).not.toContain('fixture internal instruction')
      expect(response.text).not.toContain('lyapunov-default-ground')
      const event = {type:'command/done',seq:1,time:100,data:{name:'scene_create',kind:'success',text:before}}
      const wire = createSessionOutboundProjection('formal').projectEvent(event) as typeof event
      expect(JSON.parse(wire.data.text).revision).toBe(revision)
      for (const text of [response.text,wire.data.text]) {
        expect(domainCommandSummary('scene_create',text,'success',false).summary).toBe(`rev ${revision} · 1 个实体`)
        expect(domainCommandSummary('scene_create',text,'success',true).summary).toBe(`rev ${revision} · 1 entities`)
      }
      expect(JSON.stringify(value)).toBe(before)
    })
  }
})

describe("R5：动作回执摘要", () => {
  test("completed 但 targetReached=false ⇒ 写「动作已结束，目标未到达」并点出未进容差的动作数与容差", () => {
    const info = summarize(receipt(false))
    expect(info.summary).toContain("动作已结束，目标未到达")
    expect(info.summary).not.toContain("执行完成")
    expect(info.summary).toContain("1/1 个动作未进入容差")
    expect(info.summary).toContain("容差 0.03")
    // 默认 headline 不再常驻技术 step；完整回执仍在机器结果/展开详情里。
    expect(info.summary).not.toContain("step 50182")
    expect(info.summary).not.toMatch(/\bstep\b|\brev\b|\bg\d/)
    expect(info.tone).toBe("warning")
  })

  test("同样的回执 targetReached=true ⇒ 仍是「执行完成」（不把成功标成未达成）", () => {
    const info = summarize(receipt(true))
    expect(info.summary).toContain("执行完成")
    expect(info.summary).not.toContain("目标未到达")
    expect(info.summary).not.toContain("未进入容差")
    expect(info.tone).toBe("ok")
  })

  test("英文摘要同样区分（界面语言切换不改变判据）", () => {
    expect(summarize(receipt(false), "robot_move", true).summary).toContain("Action finished; target not reached")
    expect(summarize(receipt(true), "robot_move", true).summary).toContain("Completed")
  })

  test("停止回执照旧按 stopped 读数（停止＝取消确认，不是精确保持的证明）", () => {
    const info = domainCommandSummary("sim_stop", JSON.stringify({ stopped: true, stepIndex: 23979 }), "success", false)
    expect(info.summary).toBe("已停止")
    expect(info.summary).not.toContain("step")
    expect(info.tone).toBe("ok")
  })

  test("任务级回执的 taskAchieved 判据不受影响", () => {
    expect(domainCommandSummary("robot_fleet_run", JSON.stringify({ assignments: [], actions: [], taskAchieved: false }), "success", false).tone).toBe("warning")
  })
})

describe("R5：机器人面板「动作结果」卡片（紧挨提交动作的按钮，过去只写 status）", () => {
  /** 面板卡片是纯函数组件：返回值就是元素树，直接走一遍取文本，不需要渲染器（本仓没有 jsdom）。 */
  const texts = (node: any, out: string[] = []): string[] => {
    if (node === null || node === undefined || typeof node === "boolean") return out
    if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out }
    if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
    if (typeof node === "object") texts(node.props?.children, out)
    return out
  }
  const cardText = (receipt: unknown, opts?: { allowRaw?: boolean; mode?: string }) => texts(ActionCards({
    actions: [{ id: "a1", label: "robot_move", waiting: false, receipt: receipt as any }],
    tr: (cn: string) => cn,
    ...opts ?? {},
  } as never)).join(" | ")

  /**
   * DEV-PRIV-01 改判（不是回退 R5）：R5 的**失败摘要语义**原样保留（"动作已结束，目标未到达"
   * + 未进容差计数 + 容差值，三者都在人类面）。原先"原回执整份保留在展开区"的断言正是要关掉的泄露面——
   * 人类卡片与机器 UI 同处一个不可信浏览器边界，逐字 JSON 不得随回执下发。原回执改为：
   * ① 人类面保留其中的**负面事实字段**（`targetReached`/`tolerance`，见下面第二断言）；
   * ② 整份 JSON 只在"构建允许 + 可信 profile 为 developer"两闸都开的诊断面出现。
   */
  test("completed 但目标未到达：面板卡片写「动作已结束，目标未到达」，不再只写 completed", () => {
    const text = cardText(receipt(false))
    expect(text).toContain("动作已结束，目标未到达")
    expect(text).toContain("1/1 个动作未进入容差")
    expect(text).toContain("容差 0.03")
    // 发行/正式面：负面上屏的是事实行，不是原始 JSON
    expect(text).not.toContain('"targetReached": false')
    expect(text).toContain("targetReached: false")
    expect(text).toContain("tolerance: 0.03")
  })

  test("原回执整份只在两闸都开的诊断面出现（构建允许 + 可信 profile=developer）", () => {
    const raw = cardText(receipt(false), { allowRaw: true, mode: "developer" })
    expect(raw).toContain('"targetReached": false')
    // 只开一闸都不出原始面：发布构建的 define 恒为 false，运行期不是 developer 也一样
    expect(cardText(receipt(false), { allowRaw: true, mode: "formal" })).not.toContain('"targetReached": false')
    expect(cardText(receipt(false), { allowRaw: false, mode: "developer" })).not.toContain('"targetReached": false')
  })

  test("目标到达的回执照旧读作执行完成，且卡片外形不变（标题 + 文本 + 原回执）", () => {
    const text = cardText(receipt(true))
    expect(text).toContain("完整关节运动")
    expect(text).toContain("执行完成")
    expect(text).not.toContain("目标未到达")
  })

  test("未完成时不伪造结果：等待中的卡片写明请求已提交", () => {
    const text = texts(ActionCards({ actions: [{ id: "a2", label: "robot_move", waiting: true }], tr: (cn: string) => cn })).join(" | ")
    expect(text).toContain("请求已提交，等待引擎结果…")
  })
})

describe("P17：产品命令的显示投影不再掉回 SDK 原始长命令行", () => {
  const en = (name: string, value: unknown) => domainCommandSummary(name, JSON.stringify(value), "success", true)

  test("ui_engine_switch / ui_action_ack / policy_download_sources / scene_import_resolve / scene_reconcile_physics 给短语义摘要", () => {
    const engine = en("ui_engine_switch", { runningEngine: "mujoco", preference: "isaac", restartRequired: true })
    expect(engine.summary).toContain("Isaac")
    expect(engine.summary).toContain("next start")
    expect(engine.tone).toBe("ok")
    expect(en("ui_action_ack", { acked: 3 }).summary).toContain("3 UI actions acknowledged")
    const sources = en("policy_download_sources", { models: [{}, {}], localEntries: [{}] })
    expect(sources.summary).toContain("2 sources")
    expect(sources.summary).toContain("1 local")
    const blocked = en("scene_import_resolve", { kind: "blocked", reason: "ENTRY_REQUIRED: choose a specific file" })
    expect(blocked.tone).toBe("warning")
    expect(blocked.summary).toContain("ENTRY_REQUIRED")
    expect(en("scene_import_resolve", { kind: "file" }).summary).toContain("File entry")
    const reconcile = en("scene_reconcile_physics", { snapshot: { revision: 4, entities: 2 }, pending: false, issues: [{ entityId: "e" }] })
    expect(reconcile.summary).toContain("Physics reconcile")
    expect(reconcile.tone).toBe("warning")
    // 对账干净且非等待 ⇒ ok；不把成功标成 warning。
    expect(en("scene_reconcile_physics", { snapshot: { revision: 4, entities: 2 }, pending: false, issues: [] }).tone).toBe("ok")
  })

  test("7 个此前缺失的命令都有产品短名与语义摘要，不再显示裸命令名", () => {
    for (const name of ["scene_import_resolve", "scene_reconcile_physics", "scene_prepare_world", "policy_download_sources", "ui_action_ack", "ui_engine_switch", "policy_activate"]) {
      const view = commandCardView({ name, args: "{}", outcomeText: JSON.stringify({ kind: "file" }), kind: "success" }, { english: true, allowRaw: false, mode: "formal" })
      expect(view.title).not.toBe(name)
      expect(view.title.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("P21：UI 常用动作/相机 UI 命令不再掉回 SDK 原始命令行", () => {
  const en = (name: string, value: unknown) => domainCommandSummary(name, JSON.stringify(value), "success", true)
  const title = (name: string) => commandCardView({ name, args: "{}", outcomeText: "{}", kind: "success" }, { english: true, allowRaw: false, mode: "formal" }).title

  test("sim_set_paused / robot_freeze / robot_restore：短语义状态，失败（not-frozen/mismatched）按 warning 上屏", () => {
    expect(title("sim_set_paused")).toBe("Pause / resume simulation")
    expect(en("sim_set_paused", { worldId: "w", engineId: "mujoco", worldGeneration: 3, appliedSceneRevision: 5, status: "paused" }).summary).toBe("Paused")
    expect(en("sim_set_paused", { status: "running", worldGeneration: 4 }).summary).toBe("Resumed")
    expect(title("robot_freeze")).toBe("Freeze robot")
    expect(en("robot_freeze", { status: "frozen", frozenEntityIds: ["a"] }).tone).toBe("ok")
    expect(en("robot_freeze", { status: "already-frozen", frozenEntityIds: ["a", "b"] }).summary).toContain("2 entities")
    expect(en("robot_freeze", { status: "mismatched", freezeId: "f", reason: "freezeId mismatch" }).tone).toBe("warning")
    expect(en("robot_freeze", { status: "mismatched", reason: "freezeId mismatch" }).summary).toContain("freezeId mismatch")
    expect(en("robot_restore", { status: "restored", restoredEntityIds: ["a"] }).tone).toBe("ok")
    // “没到目标”不得被绿化：not-frozen 是 restore 的失败态。
    expect(en("robot_restore", { status: "not-frozen", reason: "not frozen" }).tone).toBe("warning")
  })

  test("policy_load_local / policy_load_state：就绪/未就绪与缺失项数都上屏；未就绪不是 ok", () => {
    expect(title("policy_load_state")).toBe("Policy load state")
    const ready = en("policy_load_state", { category: "direct_execution", ready: true, applyEligible: true, missing: [], modelId: "resnet-policy" })
    expect(ready.summary).toContain("Ready")
    expect(ready.summary).toContain("Direct execution")
    expect(ready.summary).toContain("appliable")
    expect(ready.tone).toBe("ok")
    const blocked = en("policy_load_state", { category: "missing_files_or_runtime", ready: false, applyEligible: false, missing: [{ code: "RUNTIME_MISSING" }, { code: "POLICY_FILE_NOT_VERIFIED" }] })
    expect(blocked.summary).toContain("Not ready")
    expect(blocked.summary).toContain("Missing files or runtime")
    expect(blocked.summary).toContain("2 missing")
    expect(blocked.tone).toBe("warning")
    const incompatible = en("policy_load_state", { category: "model_incompatible", ready: false, missing: [] })
    expect(incompatible.summary).toContain("Model incompatible")
    expect(incompatible.tone).toBe("warning")
  })

  test("camera_scene_save / list / adjust / multi / annotation / dataset / lidar：短标题与真实读数", () => {
    expect(title("camera_scene_save")).toBe("Save scene camera")
    expect(title("camera_list_ui")).toBe("List named cameras")
    expect(title("camera_capture_multi_ui")).toBe("Multi-view capture")
    expect(title("camera_annotation_ui")).toBe("Annotate pixel")
    expect(title("camera_dataset_export_ui")).toBe("Export multi-view dataset")
    expect(title("camera_lidar_scan_ui")).toBe("LiDAR scan")
    expect(en("camera_scene_save", { snapshot: { revision: 7 }, entityId: "cam-1", worldNeedsSync: false }).summary).toBe("cam-1")
    expect(en("camera_scene_save", { snapshot: { revision: 7 }, entityId: "cam-1", worldNeedsSync: true }).tone).toBe("warning")
    expect(en("camera_list_ui", { cameras: [{}, {}, {}], sceneRevision: 4, generation: 9 }).summary).toBe("3 named cameras")
    expect(en("camera_adjust_ui", { override: true, referenceFrame: "parent", parentBodyName: "wrist", fovyDeg: 42.5 }).summary).toContain("Override applied")
    expect(en("camera_adjust_ui", { override: true, fovyDeg: 42.5 }).summary).toContain("fovy 42.5°")
    expect(en("camera_adjust_ui", { override: false, referenceFrame: "world" }).summary).toContain("Override cleared")
    const multi = en("camera_capture_multi_ui", { cameras: [{ width: 320, height: 240 }, {}], width: 320, height: 240, stepIndex: 88 })
    expect(multi.summary).toBe("2 cameras · 320×240")
    expect(multi.tone).toBe("ok")
    const annotation = en("camera_annotation_ui", { pixel: [12, 34], worldPointM: [1, 2, 3], depthM: 2.5 })
    expect(annotation.summary).toContain("pixel [12, 34]")
    expect(annotation.summary).toContain("[1.000, 2.000, 3.000] m")
    expect(annotation.summary).toContain("depth 2.500 m")
    const dataset = en("camera_dataset_export_ui", { shellCaptureIds: ["a", "b"], outputDir: "/captures/datasets/d1" })
    expect(dataset.summary).toContain("2 multi-view captures")
    const lidar = en("camera_lidar_scan_ui", { cameraName: "e1/wrist", rayCount: 100, validCount: 97, rangeMinM: 0.5, rangeMaxM: 4.25 })
    expect(lidar.summary).toBe("e1/wrist · 97/100 valid rays · 0.50–4.25 m")
  })

  test("失败仍按原判据上屏：error 分支不被新映射掩盖", () => {
    const failed = domainCommandSummary("sim_set_paused", "WORLD_NOT_FOUND: no such world", "error", true)
    expect(failed.tone).toBe("error")
    expect(failed.summary).toContain("WORLD_NOT_FOUND")
  })
})

describe("V10：装配/底座命令映射与被动读取折叠", () => {
  const view=(name:string,value:unknown,english=false)=>commandCardView({name,args:"{}",outcomeText:JSON.stringify(value),kind:"success"},{english,allowRaw:false,mode:"formal"})
  const summary=(name:string,value:unknown,english=false)=>domainCommandSummary(name,JSON.stringify(value),"success",english)

  test("robot_assembly_preview / check / history / undo / set_base 有产品短名和简短结果",()=>{
    expect(view("robot_assembly_preview",{}).title).toBe("预览装配")
    expect(summary("robot_assembly_preview",{status:"PREVIEW",applied:false,revision:8,generation:3,source:{name:"Hand"},target:{name:"Panda",bodyName:"attachment"}}).summary).toContain("Hand → Panda/attachment")
    expect(summary("robot_assembly_preview",{status:"PREVIEW",applied:false,revision:8,generation:3,source:{name:"Hand"},target:{name:"Panda",bodyName:"attachment"}}).summary).not.toContain("applyInput")
    expect(view("robot_assembly_check",{}).title).toBe("检查装配读回")
    expect(summary("robot_assembly_check",{checked:{binding:true,relativePose:true,joints:false,contacts:false,actionReceipt:false},attachments:[{},{}]}).summary).toContain("2/5")
    expect(summary("robot_assembly_history",{entries:[{},{}],revision:9,historyComplete:false,reason:"gap"}).tone).toBe("warning")
    expect(view("robot_assembly_undo",{}).title).toBe("撤销装配变化")
    expect(summary("robot_assembly_undo",{saved:true,revision:10,syncRequired:true}).summary).toContain("物理待同步")
    expect(view("robot_set_base",{}).title).toBe("固定 / 恢复机器人底座")
    expect(summary("robot_set_base",{saved:true,revision:10,sync:"SYNCED",status:"UPDATED"}).summary).toContain("底座已保存")
    expect(summary("robot_set_tcp",{saved:true,revision:11,status:"UNCHANGED",syncRequired:false,sync:"SYNCED"}).summary).toContain("无变化")
  })

  test("被动成功读取不逐行铺 Chat；失败仍显示",()=>{
    expect(isPassiveSuccessRead("policy_download_sources","success")).toBe(true)
    expect(isPassiveSuccessRead("policy_metadata",null)).toBe(true)
    expect(isPassiveSuccessRead("robot_description","success")).toBe(true)
    expect(isPassiveSuccessRead("robot_assembly_history","success")).toBe(true)
    expect(isPassiveSuccessRead("policy_download_sources","error")).toBe(false)
    expect(isPassiveSuccessRead("robot_assembly_history","error")).toBe(false)
    expect(isPassiveSuccessRead("asset_placement_preview","success")).toBe(true)
    expect(isPassiveSuccessRead("asset_placement_preview","error")).toBe(false)
    expect(isPassiveSuccessRead("robot_assembly_check","success")).toBe(false)
  })
  test("V10 默认 headline 无 rev/generation/step/UUID；失败原因仍可见",()=>{
    const success=domainCommandSummary("scene_inspect",JSON.stringify({name:"room",snapshot:{revision:7,entities:[{},{}]}}),"success",true)
    expect(success.summary).toBe("room · 2 entities")
    expect(success.summary).not.toMatch(/\brev\b|\bgeneration\b|\bstep\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    const uuid=domainCommandSummary("camera_scene_save",JSON.stringify({entityId:"123e4567-e89b-12d3-a456-426614174000",snapshot:{revision:4}}),"success",true)
    expect(uuid.summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    const failed=domainCommandSummary("policy_load_state","POLICY_RUNTIME_UNAVAILABLE: torch missing","error",true)
    expect(failed.tone).toBe("error")
    expect(failed.summary).toContain("POLICY_RUNTIME_UNAVAILABLE")
  })
})
