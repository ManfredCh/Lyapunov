import {describe,expect,test} from "bun:test"
import {renderToStaticMarkup} from "react-dom/server"
import {BalanceSection} from "../src/balance-section.tsx"

describe("balance section render",()=>{
  test("renders an explicit loading state before account state resolves",()=>{
    const translate=((key:string)=>({open:"Scene workbench",credits:"Available credits",refresh:"Refresh",openAccount:"Open account",devHint:"Developer mode",signinHint:"Sign in"}[key]??key)) as never
    const markup=renderToStaticMarkup(<BalanceSection t={translate}/>)
    expect(markup).toContain("Loading account…")
    expect(markup).not.toContain("Sign in with a formal account")
  })
})
