import { describe, expect, it } from "bun:test"
import { OrientationChecks, importedVisualTarget, orientationPrompt } from "../src/orientation-check.ts"

const target = (sessionKey = "session-a") => ({ sessionKey, sceneId: "scene-a", revision: 4, clientId: "window-a", rootEntityIds: ["group-a"], origin: "tool" as const })
const image = (captureId: string, revision = 4, clientId = "window-a") => ({ captureId, sceneId: "scene-a", sceneRevision: revision, clientId, camera: { up: [0, 0, 1] } })

describe("导入后方向检查的身份、限次与复拍合同", () => {
  it("仅真实可视导入触发：SSOG 只取组根，普通实体过滤机器人，scene_edit 不回触发", () => {
    expect(importedVisualTarget("scene_asset_acquire", { kind: "streamed-sog", scene: { sceneId: "s", revision: 2 }, groupEntityId: "g", resources: [{ resourceId: "r1" }, { resourceId: "r2" }] }))
      .toEqual({ sceneId: "s", revision: 2, rootEntityIds: ["g"] })
    const snapshot = { sceneId: "s", revision: 3, entities: [{ entityId: "mesh", components: { visual: { kind: "mesh" } } }, { entityId: "robot", components: { visual: { kind: "robot" } } }] }
    expect(importedVisualTarget("scene_import", { snapshot, entityId: "mesh" })?.rootEntityIds).toEqual(["mesh"])
    expect(importedVisualTarget("scene_mount", { snapshot: { ...snapshot, entities: [{ entityId: "glb-root", components: { visual: { kind: "group" } } }] }, entityId: "glb-root" })?.rootEntityIds).toEqual(["glb-root"])
    expect(importedVisualTarget("scene_import", { snapshot, entityId: "robot" })).toBeUndefined()
    expect(importedVisualTarget("scene_edit", { snapshot, entityId: "mesh" })).toBeUndefined()
  })

  it("同批同版本去重，另一会话不能读/结束；旧检查被新导入取代", () => {
    const checks = new OrientationChecks()
    const first = checks.begin(target())
    expect(first.created).toBe(true)
    expect(checks.begin(target())).toEqual({ face: first.face, created: false })
    expect(checks.get("session-b", first.face.checkId)).toBeUndefined()
    expect(() => checks.finish("session-b", first.face.checkId, "uncertain")).toThrow(/ORIENTATION_CHECK_NOT_IN_SESSION/)
    const newer = checks.begin({ ...target(), revision: 5 })
    expect(newer.created).toBe(true)
    expect(checks.get("session-a", first.face.checkId)?.status).toBe("uncertain")
    expect(checks.get("session-a")?.checkId).toBe(newer.face.checkId)
    checks.unchecked("session-a", newer.face.checkId, "无 Viewer")
  })

  it("图像入队但模型未领取的超时会按消息 ID 清理，并标为未检查", async () => {
    const removed: Array<[string, string]> = []
    const checks = new OrientationChecks((session, message) => removed.push([session, message]), 5)
    const row = checks.begin(target()).face
    checks.initial("session-a", row.checkId, image("first"))
    checks.queued("session-a", row.checkId, "plugin-image")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(checks.get("session-a", row.checkId)?.status).toBe("unchecked")
    expect(removed).toEqual([["session-a", "plugin-image"]])
  })

  it("正立初图可零写入结束；不确定和迟到图保持原姿态", () => {
    const checks = new OrientationChecks()
    const row = checks.begin(target()).face
    expect(() => checks.finish("session-a", row.checkId, "correct", "first")).toThrow(/ORIENTATION_CHECK_ALREADY_ENDED/)
    checks.initial("session-a", row.checkId, image("first"))
    expect(checks.get("session-a", row.checkId)?.status).toBe("queued")
    checks.queued("session-a", row.checkId, "message-first")
    expect(checks.claimed("session-a", "message-first", 1)?.status).toBe("checking")
    expect(checks.finish("session-a", row.checkId, "correct", "first").status).toBe("correct")
    expect(checks.get("session-a", row.checkId)?.attempts).toBe(0)
    const another = checks.begin({ ...target(), revision: 5 }).face
    expect(() => checks.initial("session-a", another.checkId, image("old", 4))).toThrow(/ORIENTATION_INITIAL_IMAGE_STALE/)
    checks.initial("session-a", another.checkId, image("newer", 5))
    checks.queued("session-a", another.checkId, "message-newer")
    checks.claimed("session-a", "message-newer", 2)
    expect(checks.finish("session-a", another.checkId, "uncertain").status).toBe("uncertain")
  })

  it("修正最多两次；同窗口新 revision 图像必须晚于修正，旧图/外会话图不能冒充复拍", () => {
    const checks = new OrientationChecks()
    const row = checks.begin(target()).face
    checks.initial("session-a", row.checkId, image("before"))
    checks.queued("session-a", row.checkId, "message-before")
    checks.claimed("session-a", "message-before", 1)
    checks.reserveAdjustment("session-a", row.checkId, "asset")
    checks.applied("session-a", row.checkId, "asset", 5)
    checks.observed("session-a", image("old", 4))
    checks.observed("session-b", image("foreign", 5))
    expect(() => checks.finish("session-a", row.checkId, "corrected", "before")).toThrow(/ORIENTATION_RECHECK_REQUIRED/)
    expect(() => checks.finish("session-a", row.checkId, "corrected", "foreign")).toThrow(/ORIENTATION_RECHECK_REQUIRED/)
    checks.reserveAdjustment("session-a", row.checkId, "camera")
    checks.applied("session-a", row.checkId, "camera", 5)
    expect(() => checks.reserveAdjustment("session-a", row.checkId, "asset")).toThrow(/ORIENTATION_ATTEMPT_LIMIT/)
    checks.observed("session-a", image("new", 5))
    expect(checks.finish("session-a", row.checkId, "corrected", "new").status).toBe("corrected")
    expect(checks.get("session-a", row.checkId)?.attempts).toBe(2)
  })

  it("已修改后复拍仍不确定时只报未确认和实际尝试数，不冒充原姿态未变", () => {
    const checks = new OrientationChecks(), row = checks.begin(target()).face
    checks.initial("session-a", row.checkId, image("before"))
    checks.queued("session-a", row.checkId, "message")
    checks.claimed("session-a", "message", 1)
    checks.reserveAdjustment("session-a", row.checkId, "asset")
    checks.applied("session-a", row.checkId, "asset", 5)
    const ended = checks.finish("session-a", row.checkId, "uncertain")
    expect(ended.status).toBe("uncertain")
    expect(ended.attempts).toBe(1)
    expect(ended.sceneRevision).toBe(5)
  })

  it("模型输入说明只给这次目标与相机，明确图像/不确定和复拍，不预设角度", () => {
    const row = new OrientationChecks().begin(target()).face
    const text = orientationPrompt(row, "capture-a", { up: [0, 0, 1] })
    expect(text).toContain("not a new user instruction")
    expect(text).toContain("group-a")
    expect(text).toContain("capture-a")
    expect(text).toContain("viewer_observe")
    expect(text).toContain("uncertain")
    expect(text).toContain("Do not hard-code 180 degrees")
  })

  it("已领取图像随原生 turn 存活：可控时钟推进 230 秒后仍能首次修正与新图复核", () => {
    let now=0
    const tasks=new Map<object,{at:number;callback:()=>void}>()
    const clock={setTimeout:(callback:()=>void,delay:number)=>{const timer={unref:()=>{}};tasks.set(timer,{at:now+delay,callback});return timer as ReturnType<typeof setTimeout>},clearTimeout:(timer:ReturnType<typeof setTimeout>)=>{tasks.delete(timer)}}
    const advance=(ms:number)=>{now+=ms;for(const [timer,task] of [...tasks])if(task.at<=now){tasks.delete(timer);task.callback()}}
    const checks=new OrientationChecks(undefined,120_000,clock),row=checks.begin(target()).face
    checks.initial("session-a",row.checkId,image("before"));checks.queued("session-a",row.checkId,"image-message")
    checks.claimed("session-a","image-message",7)
    advance(230_000)
    expect(checks.get("session-a",row.checkId)?.status).toBe("checking")
    checks.endTurn("session-a",6,{kind:"completed"})
    expect(checks.get("session-a",row.checkId)?.status).toBe("checking")
    checks.reserveAdjustment("session-a",row.checkId,"asset")
    checks.applied("session-a",row.checkId,"asset",5)
    checks.observed("session-a",image("after",5))
    expect(checks.finish("session-a",row.checkId,"corrected","after").status).toBe("corrected")
    checks.endTurn("session-a",7,{kind:"completed"})
    expect(checks.get("session-a",row.checkId)?.status).toBe("corrected")
  })

  it("正常回合结束才结未确认，独占自动回合被用户停止后确认回合结束", () => {
    const checks=new OrientationChecks(),signal=new AbortController().signal
    const first=checks.begin({...target(),origin:"ui"}).face
    checks.initial("session-a",first.checkId,image("before"));checks.queued("session-a",first.checkId,"plugin-image")
    checks.claimed("session-a","plugin-image",8)
    checks.preStep("session-a",8,1,[{id:"plugin-image",takesOver:false}],signal)
    expect(checks.dedicatedTurn("session-a",first.checkId,signal)).toBe(8)
    checks.endTurn("session-b",8,{kind:"completed"})
    checks.endTurn("session-a",9,{kind:"completed"})
    expect(checks.get("session-a",first.checkId)?.status).toBe("checking")
    checks.markTurnStop("session-a",first.checkId,"requested")
    checks.cancel("session-a",first.checkId)
    checks.endTurn("session-a",8,{kind:"aborted",reason:{kind:"user"}})
    expect(checks.get("session-a",first.checkId)).toMatchObject({status:"unchecked",turnStop:"confirmed"})
    const next=checks.begin({...target(),revision:5,origin:"ui"}).face
    checks.initial("session-a",next.checkId,image("next",5));checks.queued("session-a",next.checkId,"next-image")
    checks.claimed("session-a","next-image",10)
    checks.preStep("session-a",10,1,[{id:"next-image",takesOver:false},{id:"user-message",takesOver:true}],signal)
    expect(checks.dedicatedTurn("session-a",next.checkId,signal)).toBeUndefined()
    checks.endTurn("session-a",10,{kind:"completed"})
    expect(checks.get("session-a",next.checkId)?.status).toBe("uncertain")
  })

  it("同回合后来领取用户消息即撤销自动回合独占权", () => {
    const checks=new OrientationChecks(),signal=new AbortController().signal
    const row=checks.begin({...target(),origin:"ui"}).face
    checks.initial("session-a",row.checkId,image("before"));checks.queued("session-a",row.checkId,"plugin-image")
    checks.claimed("session-a","plugin-image",11)
    checks.preStep("session-a",11,1,[{id:"plugin-image",takesOver:false},{id:"internal-notice",takesOver:false}],signal)
    expect(checks.dedicatedTurn("session-a",row.checkId,signal)).toBe(11)
    checks.claimedOther("session-a",11,"later-internal-notice",false)
    expect(checks.dedicatedTurn("session-a",row.checkId,signal)).toBe(11)
    checks.claimedOther("session-a",11,"later-user",true)
    expect(checks.dedicatedTurn("session-a",row.checkId,signal)).toBeUndefined()
    const natural=checks.begin({...target(),revision:5,origin:"tool"}).face
    checks.initial("session-a",natural.checkId,image("natural",5));checks.queued("session-a",natural.checkId,"natural-image")
    checks.claimed("session-a","natural-image",12)
    checks.preStep("session-a",12,1,[{id:"natural-image",takesOver:false}],signal)
    expect(checks.dedicatedTurn("session-a",natural.checkId,signal)).toBeUndefined()
  })
})
