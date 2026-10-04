import {expect,test} from "bun:test"
import {ExitCoordinator,ExitParticipants,type ExitOrigin,type ExitParticipant} from "../src/exit-coordinator.ts"
import {apply as applyDesktopLifecycle} from "../src/client.tsx"
import {SessionId} from "@deepseek-ai/dsh-session/types"
import type {JobView} from "@deepseek-ai/dsh-api-job-controller/client"

test("桌面退出消费原生Job roster，保留运行动作告警并释放目录订阅",async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window"),watched:string[]=[],released:string[]=[],listeners=new Set<()=>void>(),cleanups:Array<()=>void>=[]
  let participant:ExitParticipant|undefined,unregistered=0
  const main=SessionId("main"),background=SessionId("background")
  const snapshot={ids:[main,background],byId:{main:{id:main,running:false,retainedBy:{mainView:1}},background:{id:background,running:false,retainedBy:{mainView:0,sidebarView:1}}}}
  let rows:Readonly<Record<string,readonly Pick<JobView,"status">[]>>={main:[{status:"running"},{status:"stopping"},{status:"completed"}]}
  Object.defineProperty(globalThis,"window",{value:{lyapunovDesktop:{registerExitParticipant:(id:string,value:ExitParticipant)=>{expect(id).toBe("native-sessions");participant=value;return()=>{unregistered++}}}},configurable:true})
  try{
    const ctx={sessions:{list:{getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener)}},scope:()=>undefined,binding:()=>undefined},conversation:{input:{for:()=>{throw Error("没有主会话scope，不应取得后台composer")}}},jobs:{state:{getSnapshot:()=>({rows})},watchRows:(id:string)=>{watched.push(id);return()=>{released.push(id)}}},effect:(setup:()=>()=>void)=>{cleanups.push(setup())}}
    applyDesktopLifecycle(ctx)
    expect(watched).toEqual(["main","background"])
    expect(await participant!.summary()).toEqual({dirtyDrafts:0,runningActions:2})
    snapshot.byId.main.running=true
    expect(await participant!.summary()).toEqual({dirtyDrafts:0,runningActions:3})
    rows={main:[]};snapshot.byId.main.running=false;snapshot.ids=[main]
    for(const listener of listeners)listener()
    expect(released).toEqual(["background"])
    expect(await participant!.summary()).toEqual({dirtyDrafts:0,runningActions:0})
  }finally{for(const cleanup of cleanups)cleanup();if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window")}
  expect(released).toEqual(["background","main"]);expect(listeners.size).toBe(0);expect(unregistered).toBe(1)
})

function bench(approve=true){
  const calls:string[]=[]
  const options={summary:async()=>{calls.push("summary");return {dirtyDrafts:2,runningActions:1}},confirm:async()=>{calls.push("confirm");return approve},flush:async()=>{calls.push("flush")},stop:async()=>{calls.push("stop")},close:async()=>{calls.push("close")},exit:(origin:ExitOrigin)=>{calls.push("exit:"+origin)},failed:async()=>{calls.push("failed")},shutdownTimeoutMs:5}
  return {calls,options}
}
test("确认无未保存草稿时只停止关闭，不执行保存；运行动作不是草稿",async()=>{
  for(const runningActions of [0,2]){
    const b=bench();b.options.summary=async()=>{b.calls.push("summary");return {dirtyDrafts:0,runningActions}}
    const exit=new ExitCoordinator(b.options)
    expect(await exit.request("window")).toMatchObject({decision:"closed",cleanup:"confirmed"})
    expect(b.calls).toEqual(["summary","confirm","summary","stop","close","exit:window"])
  }
})
test("冻结后新增草稿仍保存；未知和无效摘要不能跳过保存",async()=>{
  for(const mode of ["became-dirty","unknown","invalid"]){
    const b=bench();let reads=0
    const summary=async()=>{b.calls.push("summary");reads++;return mode==="unknown"?undefined:mode==="invalid"?{dirtyDrafts:0,runningActions:-1}:reads===1?{dirtyDrafts:0,runningActions:0}:{dirtyDrafts:1,runningActions:0}}
    expect(await new ExitCoordinator({...b.options,summary}).request("window")).toMatchObject({decision:"closed",cleanup:"confirmed"})
    expect(b.calls).toContain("flush")
    expect(b.calls.slice(-3)).toEqual(["stop","close","exit:window"])
  }
})
test("普通四入口取消保原Host和草稿，不执行清理",async()=>{
  for(const origin of ["window","shortcut","menu","app"] as const){
    const b=bench(false),exit=new ExitCoordinator(b.options)
    expect((await exit.request(origin)).decision).toBe("cancelled")
    expect(b.calls).toEqual(["summary","confirm"])
    expect(exit.approved).toBe(false)
  }
})
test("并发普通退出共用一确认，flush stop close 顺序各一次",async()=>{
  const b=bench();let approve!:(value:boolean)=>void
  b.options.confirm=()=>new Promise(resolve=>{b.calls.push("confirm");approve=resolve})
  const exit=new ExitCoordinator(b.options),a=exit.request("window"),c=exit.request("shortcut")
  expect(a).toBe(c)
  await Promise.resolve();approve(true)
  expect((await a).cleanup).toBe("confirmed")
  expect(b.calls).toEqual(["summary","confirm","flush","stop","close","exit:window"])
  await exit.request("app")
  expect(b.calls.filter(x=>x==="close")).toHaveLength(1)
})
test("保存冲突保持未退出，不停止动作或关闭Host",async()=>{
  const b=bench();b.options.flush=async()=>{b.calls.push("flush");throw new Error("文件版本冲突")}
  const exit=new ExitCoordinator(b.options)
  expect(await exit.request("app")).toMatchObject({decision:"failed",message:"文件版本冲突"})
  expect(b.calls).toEqual(["summary","confirm","flush","failed"])
  expect(exit.approved).toBe(false)
})
test("失败回调异常公开返回，不引起退出重入",async()=>{
  const b=bench();b.options.flush=async()=>{throw new Error("save failed")};b.options.failed=async()=>{throw new Error("receipt failed")}
  expect(await new ExitCoordinator(b.options).request("window")).toMatchObject({decision:"failed",message:expect.stringContaining("receipt failed")})
  expect(b.calls).toEqual(["summary","confirm"])
})
test("update 不再确认，成功只清理一次；保存失败取消安装退出",async()=>{
  const b=bench(),exit=new ExitCoordinator(b.options)
  expect((await exit.request("update")).decision).toBe("closed")
  expect(b.calls).toEqual(["flush","stop","close","exit:update"])
  const fail=bench();fail.options.flush=async()=>{throw new Error("renderer dead")}
  expect((await new ExitCoordinator(fail.options).request("update")).decision).toBe("failed")
  expect(fail.calls).toEqual(["failed"])
})
test("系统与启动错误在renderer拒绝后仍结束，但明确清理未完整确认",async()=>{
  for(const origin of ["system","startup-error"] as const){
    const b=bench();b.options.flush=async()=>{b.calls.push("flush");throw new Error("renderer dead")}
    expect(await new ExitCoordinator(b.options).request(origin)).toMatchObject({decision:"closed",cleanup:"incomplete"})
    expect(b.calls).toEqual(["flush","failed","stop","close","exit:"+origin])
  }
})
test("系统结束的挂起阶段有界，未确认停止不冒充confirmed",async()=>{
  const b=bench();b.options.flush=()=>new Promise(()=>{});b.options.stop=()=>new Promise(()=>{})
  expect(await new ExitCoordinator(b.options).request("system")).toMatchObject({decision:"closed",cleanup:"incomplete"})
  expect(b.calls).toEqual(["failed","failed","close","exit:system"])
})
test("退出参与者只计数、按原owner flush/stop，注销不删除其它owner",async()=>{
  const registry=new ExitParticipants(),calls:string[]=[]
  const remove=registry.register("file",{summary:()=>({dirtyDrafts:1,runningActions:0}),flush:async()=>{calls.push("save")}})
  registry.register("manual",{summary:()=>({dirtyDrafts:0,runningActions:2}),flush:async()=>{calls.push("flush")},stop:async()=>{calls.push("stop")}})
  expect(await registry.summary()).toEqual({dirtyDrafts:1,runningActions:2,participants:2})
  await registry.flush();await registry.stop();expect(calls).toEqual(["save","flush","stop"])
  remove();remove();expect((await registry.summary()).participants).toBe(1)
})
test("系统结束错误回执也有界，坏回调不能卡住结束",async()=>{
  const b=bench();b.options.flush=async()=>{throw new Error("renderer dead")};b.options.failed=()=>new Promise(()=>{})
  expect(await new ExitCoordinator(b.options).request("system")).toMatchObject({decision:"closed",cleanup:"incomplete"})
  expect(b.calls).toEqual(["stop","close","exit:system"])
})
test("系统结束升级挂起的普通确认，迟到取消不重新清理",async()=>{
  const b=bench();let cancel!:(approved:boolean)=>void
  b.options.confirm=()=>new Promise(resolve=>{b.calls.push("confirm");cancel=resolve})
  const exit=new ExitCoordinator(b.options),ordinary=exit.request("window")
  await Promise.resolve()
  expect(exit.request("system")).toBe(ordinary)
  expect(await ordinary).toMatchObject({origin:"system",decision:"closed"})
  cancel(false);await Promise.resolve()
  expect(b.calls).toEqual(["summary","confirm","flush","stop","close","exit:system"])
})
test("系统结束升级在途 flush，但不重发原 flush 或 Host close",async()=>{
  const b=bench();b.options.flush=()=>{b.calls.push("flush");return new Promise(()=>{})}
  const exit=new ExitCoordinator(b.options),pending=exit.request("update")
  await Promise.resolve();await Promise.resolve();await Promise.resolve()
  expect(exit.request("system")).toBe(pending)
  expect(await pending).toMatchObject({origin:"system",decision:"closed",cleanup:"incomplete"})
  expect(b.calls.filter(call=>call==="flush")).toHaveLength(1)
  expect(b.calls.filter(call=>call==="close")).toHaveLength(1)
  expect(b.calls.at(-1)).toBe("exit:system")
})
test("更新的挂起 flush 有界且取消安装；保存失败解除新输入冻结",async()=>{
  const b=bench();b.options.flush=()=>new Promise(()=>{})
  const states:boolean[]=[],exit=new ExitCoordinator({...b.options,stateChanged:value=>states.push(value)})
  expect(await exit.request("update")).toMatchObject({decision:"failed",message:expect.stringContaining("预算")})
  expect(states).toEqual([true,false]);expect(exit.committing).toBe(false)
  expect(b.calls).toEqual(["failed"])
})
test("普通保存失败的回执期间收到系统结束，未重放flush并继续一次stop-close",async()=>{
  const b=bench();let ready!:()=>void
  const reporting=new Promise<void>(resolve=>{ready=resolve})
  b.options.flush=async()=>{b.calls.push("flush");throw new Error("save conflict")}
  b.options.failed=async()=>{b.calls.push("failed");ready();await new Promise(()=>{})}
  const exit=new ExitCoordinator(b.options),pending=exit.request("window")
  await reporting;expect(exit.request("system")).toBe(pending)
  expect(await pending).toMatchObject({origin:"system",decision:"closed",cleanup:"incomplete"})
  expect(b.calls).toEqual(["summary","confirm","flush","failed","stop","close","exit:system"])
})
