import {describe,expect,test} from "bun:test"
import {accountIdentity,availablePaymentMethods,commerceErrorMessage,commerceResultIsCurrent,stablePaymentProvider} from "../src/account-view-helpers.ts"
import {accountLocale,DesktopLocaleMirror} from "../src/account-locales.ts"
import {desktopExitDialog,desktopWindowTitle} from "../src/window-chrome.ts"

describe("account view helpers",()=>{
  test("uses the authenticated user as the async result identity",()=>{
    expect(accountIdentity({status:"ready",user:{id:"alice"}})).toBe("alice")
    expect(accountIdentity({status:"signed-out",user:{id:"alice"}})).toBeUndefined()
  })

  test("keeps a selected method only while it remains available",()=>{
    const methods=[{id:"alipay" as const,available:false},{id:"wechat" as const,available:true}]
    expect(availablePaymentMethods(methods)).toEqual([{id:"wechat",available:true}])
    expect(stablePaymentProvider("alipay",methods)).toBe("wechat")
    expect(stablePaymentProvider("wechat",methods)).toBe("wechat")
    expect(stablePaymentProvider("alipay",methods.map(method=>({...method,available:false})))).toBeUndefined()
  })

  test("rejects stale commerce responses after an account switch",()=>{
    expect(commerceResultIsCurrent({requestIdentity:"alice",currentIdentity:"alice",requestEpoch:2,currentEpoch:2})).toBe(true)
    expect(commerceResultIsCurrent({requestIdentity:"alice",currentIdentity:"bob",requestEpoch:2,currentEpoch:2})).toBe(false)
    expect(commerceResultIsCurrent({requestIdentity:"alice",currentIdentity:"alice",requestEpoch:2,currentEpoch:3})).toBe(false)
  })

  test("normalizes commerce failures for explicit error state",()=>{
    expect(commerceErrorMessage(new Error("offline"),"fallback")).toBe("offline")
    expect(commerceErrorMessage("", "fallback")).toBe("fallback")
  })
})

describe("桌面语言投影",()=>{
  test("消费原生接受值；隐藏账户页旧值不覆盖，显式选择交回原生确认",()=>{
    expect(accountLocale("zh-CN")).toBe("zh");expect(accountLocale("EN_us")).toBe("en");expect(accountLocale("ja")).toBeUndefined()
    const mirror=new DesktopLocaleMirror("zh")
    expect(mirror.report("en","account")).toMatchObject({active:"en",revision:1})
    expect(mirror.report("zh","workspace")).toMatchObject({active:"zh",revision:2})
    const native=mirror.getSnapshot();expect(mirror.report("en","account")).toBe(native)
    expect(mirror.report("en","account",true)).toMatchObject({active:"en",requested:"en",revision:3})
    expect(mirror.report("zh","account")).toMatchObject({active:"en",requested:"en"})
    expect(mirror.report("zh","workspace")).toMatchObject({active:"en",requested:"en",revision:3})
    expect(mirror.report("en","workspace")).toEqual({active:"en",revision:4})
    expect(mirror.report("en","workspace")).toBe(mirror.getSnapshot())
  })
  test("窗口游客前缀随语言改变；用户会话标题原样保留",()=>{
    expect(desktopWindowTitle(" — DeepSeek Harness","en",true)).toBe("Guest · Lyapunov")
    expect(desktopWindowTitle("用户自定标题 — DSH 本地构建","en",true)).toBe("Guest · 用户自定标题 — Lyapunov")
    expect(desktopWindowTitle("My session — DeepSeek Harness","zh",true)).toBe("游客 · My session — Lyapunov")
    expect(desktopWindowTitle("My session — Lyapunov","en")).toBe("My session — Lyapunov")
    expect(desktopWindowTitle("Arbitrary page","en")).toBe("Lyapunov")
  })
  test("已读和无法读取状态的退出确认均为选择语言，草稿动作计数不变",()=>{
    const known=desktopExitDialog("en",{dirtyDrafts:2,runningActions:3}),unknown=desktopExitDialog("en")
    expect(known).toMatchObject({title:"Quit Lyapunov",message:"Save drafts and quit?",buttons:["Cancel","Save and quit"],defaultId:0,cancelId:0})
    expect(known.detail).toContain("2 drafts and 3 running tasks or actions")
    expect(JSON.stringify([known,unknown])).not.toMatch(/[\u3400-\u9fff]/)
    expect(desktopExitDialog("zh",{dirtyDrafts:2,runningActions:3}).detail).toContain("2 份草稿、3 项")
  })
  test("无未保存草稿只显示退出；运行数不触发保存措辞，未知不冒充干净",()=>{
    for(const runningActions of [0,3]){
      const english=desktopExitDialog("en",{dirtyDrafts:0,runningActions}),chinese=desktopExitDialog("zh",{dirtyDrafts:0,runningActions})
      expect(english.buttons).toEqual(["Cancel","Exit"]);expect(chinese.buttons).toEqual(["取消","退出"])
      expect(english.message+english.detail).not.toMatch(/save|draft/i);expect(chinese.message+chinese.detail).not.toContain("保存")
    }
    expect(desktopExitDialog("en").buttons).toEqual(["Cancel","Save and quit"])
    expect(desktopExitDialog("en",{dirtyDrafts:0,runningActions:-1}).buttons).toEqual(["Cancel","Save and quit"])
  })
})
