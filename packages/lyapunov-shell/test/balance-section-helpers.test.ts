import {describe,expect,test} from "bun:test"
import {balancePresentation,bridgeUnavailableText} from "../src/balance-section-helpers.ts"

describe("balance presentation",()=>{
  test("keeps initial account reads truthful instead of showing signed out",()=>{
    expect(balancePresentation({loading:true,locale:"en"})).toEqual({kind:"loading",text:"Loading account…"})
  })

  test("surfaces returned account messages as sync errors",()=>{
    expect(balancePresentation({loading:false,locale:"en",state:{status:"ready",message:"Balance sync failed"}})).toEqual({kind:"error",text:"Balance sync failed"})
  })

  test("distinguishes a confirmed signed-out state",()=>{
    expect(balancePresentation({loading:false,locale:"zh",state:{status:"signed-out"}})).toEqual({kind:"signed-out",text:"登录正式账户后在此显示余额。"})
  })

  test("explains that missing bridge capability is not a remote billing flow",()=>{
    expect(bridgeUnavailableText("en")).toContain("native injected transport")
    expect(bridgeUnavailableText("zh")).toContain("原生注入传输能力")
  })
})
