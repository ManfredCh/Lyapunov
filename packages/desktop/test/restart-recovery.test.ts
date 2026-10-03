/**
 * DEV-036 重启恢复规则的单测：规则确定、可解释、失效项显式降级，且**绝不重发机器人动作**。
 *
 * 只测纯决策与只读记录解析（不启动 Host、不见 Electron）：`readWorkspaceRecords` 读的是
 * DSH 原生会话记录的真实文件格式（见 `.runtime/dev-verify/developer/dsh/storages/workspace.json`）。
 */
import {afterEach, describe, expect, test} from "bun:test"
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {classifyStartupFailure,planRestartRecovery,readWorkspaceRecords,resolveWorkspaceHostMode} from "../src/restart-recovery.ts"

const workspace=(id:string,sessionIds:string[],extra:Record<string,unknown>={})=>({id,path:`/ws/${id}`,title:id,sessionIds,...extra})

let roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function recordsFile(content:string,mode="developer"):string{
  const root=mkdtempSync(join(tmpdir(),"dev036-records-"));roots.push(root)
  mkdirSync(join(root,mode,"dsh","storages"),{recursive:true})
  writeFileSync(join(root,mode,"dsh","storages","workspace.json"),content)
  return root
}

describe("planRestartRecovery：恢复顺序确定、可解释", () => {
  test("记录在案的当前会话仍有效 → 直接恢复它（不被别的规则抢走）", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1","s2"]),workspace("w2",["s3"])],currentSessionId:"s3"})
    expect(plan).toMatchObject({action:"open-session",workspaceId:"w2",sessionId:"s3"})
    expect(plan.reason).toContain("记录在案")
    expect(plan.replaysRobotActions).toBe(false)
  })

  test("没有当前会话时：全局唯一未归档会话被恢复（DEV-036 的“唯一会话”）", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1"]),workspace("w2",[])]})
    expect(plan).toMatchObject({action:"open-session",workspaceId:"w1",sessionId:"s1"})
    expect(plan.reason).toContain("唯一")
  })

  test("唯一工作区、多个未归档会话：取记录次序最后的那个，并说明依据", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1","s2","s3"])]})
    expect(plan).toMatchObject({action:"open-session",sessionId:"s3"})
    expect(plan.reason).toContain("原生记录次序最后")
    expect(plan.reason).toContain("不代表最近使用时间")
  })

  test("12+ 条目且末尾归档：按原生顺序取最后未归档会话，不排序或改写源数组", () => {
    const sourceOrder=Array.from({length:14},(_,index)=>`s${index+1}`)
    const record=workspace("w1",Object.freeze([...sourceOrder]) as unknown as string[])
    const plan=planRestartRecovery({workspaces:[record],archivedSessionIds:["s13","s14"]})
    expect(plan).toMatchObject({action:"open-session",workspaceId:"w1",sessionId:"s12"})
    expect(record.sessionIds).toEqual(sourceOrder)
    expect(plan.downgrades.join()).toContain("归档会话 s13 不恢复")
    expect(plan.downgrades.join()).toContain("归档会话 s14 不恢复")
  })

  test("负对照：多个工作区且没有唯一目标 → 进入选择，不拿“最近一个”猜", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1"]),workspace("w2",["s2"])]})
    expect(plan.action).toBe("none")
    expect(plan.sessionId).toBeUndefined()
    expect(plan.reason).toContain("不猜测")
    expect(plan.replaysRobotActions).toBe(false)
  })

  test("归档会话永不恢复，且逐条记入降级（不静默丢弃）", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1","s2"])],archivedSessionIds:["s2"]})
    expect(plan).toMatchObject({action:"open-session",sessionId:"s1"})
    expect(plan.downgrades.join()).toContain("归档会话 s2 不恢复")
  })

  test("当前会话已失效：降级并落到唯一会话规则，降级原因可读", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1"])],currentSessionId:"gone"})
    expect(plan).toMatchObject({action:"open-session",sessionId:"s1"})
    expect(plan.downgrades.join()).toContain("当前会话 gone")
  })

  test("失效 world 只记降级、不触发任何动作重发", () => {
    const plan=planRestartRecovery({workspaces:[workspace("w1",["s1"])],liveWorldIds:["old-world"]})
    expect(plan.downgrades.join()).toContain("不自动恢复运行世界")
    expect(plan.replaysRobotActions).toBe(false)
  })

  test("没有可读工作区 / 唯一工作区但无会话：分别给出可解释的 none 与 open-workspace", () => {
    expect(planRestartRecovery({workspaces:[]}).action).toBe("none")
    expect(planRestartRecovery({workspaces:[workspace("w1",[])]}).action).toBe("open-workspace")
    const noPath=planRestartRecovery({workspaces:[{id:"w1",path:"",title:"坏记录",sessionIds:["s1"]}]})
    expect(noPath.action).toBe("none")
    expect(noPath.downgrades.join()).toContain("没有可读路径")
  })
})

describe("readWorkspaceRecords：只读原生会话记录，缺失/损坏不猜", () => {
  test("读真实格式（workspaces 表 + 归档列表）", () => {
    const root=recordsFile(JSON.stringify({unit:{name:"workspace",version:2},global:{initialized:true,workspaceIds:["w1"],archivedSessionIds:["s9"]},tables:{workspaces:{w1:{path:"/home/s18/WS",title:"WS",sessionIds:["s1","s9"],createdAt:"x",updatedAt:"y"}}}}))
    const records=readWorkspaceRecords(root,"developer")
    expect(records.archivedSessionIds).toEqual(["s9"])
    expect(records.workspaces).toEqual([{id:"w1",path:"/home/s18/WS",title:"WS",sessionIds:["s1","s9"],updatedAt:"y"}])
    expect(planRestartRecovery(records)).toMatchObject({action:"open-session",sessionId:"s1"})
  })

  test("负对照：文件不存在或不是合法 JSON → 空记录（交给“没有目标”分支，不伪造）", () => {
    const missing=mkdtempSync(join(tmpdir(),"dev036-missing-"));roots.push(missing)
    expect(readWorkspaceRecords(missing,"developer")).toEqual({workspaces:[],archivedSessionIds:[]})
    const broken=recordsFile("{ 这不是 JSON")
    expect(readWorkspaceRecords(broken,"developer")).toEqual({workspaces:[],archivedSessionIds:[]})
  })
})

describe("resolveWorkspaceHostMode：登录先行的启动协调", () => {
  test("正式模式没有已验证账户：拒绝启动，绝不回落到匿名本地工作台", () => {
    expect(() => resolveWorkspaceHostMode("formal", undefined)).toThrow("AUTH_REQUIRED")
    expect(() => resolveWorkspaceHostMode("formal", null)).toThrow("AUTH_REQUIRED")
  })

  test("正式模式持已验证账户：解析为 formal", () => {
    expect(resolveWorkspaceHostMode("formal", { me: { user: { id: "alice" } } })).toBe("formal")
  })

  test("开发源码模式显式入口：没有账户仍按原行为解析为 developer", () => {
    expect(resolveWorkspaceHostMode("developer", undefined)).toBe("developer")
  })
})

describe("classifyStartupFailure：区分渲染 / 资源 / 物理，认不出就 unknown", () => {
  test("渲染失败（EGL/framebuffer/WebGL/ANGLE/GPU 进程）", () => {
    for(const message of["Failed to create EGL context","framebuffer incomplete","WebGL2 context lost","ANGLE error","gpu process crashed"])
      expect(classifyStartupFailure(message).kind).toBe("render")
  })

  test("资源缺失与句柄耗尽（后者按资源归因，不改系统限额）", () => {
    for(const message of["ENOENT: no such file or directory","EACCES: permission denied","EMFILE: too many open files","ENFILE: file table overflow"])
      expect(classifyStartupFailure(message).kind).toBe("resource-missing")
    expect(classifyStartupFailure("EMFILE: too many open files").reason).toContain("不改系统限额")
  })

  test("文件监控耗尽按资源单独归因（真实 Chromium inotify 原文，本地化 strerror + 数字 errno）", () => {
    // 原文逐字取自本 lane 真实 Electron 运行日志 .runtime/lane-dev036/desktop-default.log
    const real = "[59:0922/053641.278040:ERROR:base/files/file_path_watcher_inotify.cc:338] inotify_init() failed: 打开的文件过多 (24)"
    expect(classifyStartupFailure(real).kind).toBe("resource-missing")
    expect(classifyStartupFailure(real).reason).toContain("不改系统限额")
  })

  test("物理失败与未识别", () => {
    expect(classifyStartupFailure("PhysX articulation solver diverged to NaN").kind).toBe("physics")
    expect(classifyStartupFailure("some totally unrelated failure").kind).toBe("unknown")
    expect(classifyStartupFailure("").kind).toBe("unknown")
  })
})

describe("文件预览标签（含 HTML）的重启口径", () => {
  test("标签没有独立持久记录：计划逐条记降级，不猜也不伪造恢复", () => {
    // 真机对照（.runtime/lane-dev036/dev036-before-tabs.png / dev036-after-tabs.png）：重启后会话与场景回来、
    // 两个 HTML 预览标签没有回来。规则必须把这件事写进 downgrades，而不是静默丢失。
    const plan = planRestartRecovery({workspaces:[workspace("w1",["s1"])]})
    expect(plan.downgrades.join()).toContain("不自动恢复文件预览标签")
    expect(plan.downgrades.join()).toContain("没有独立持久记录")
  })
})
