import {describe,expect,test} from "bun:test"
import {accountIdentity,availablePaymentMethods,commerceErrorMessage,commerceResultIsCurrent,stablePaymentProvider} from "../src/account-view-helpers.ts"

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
