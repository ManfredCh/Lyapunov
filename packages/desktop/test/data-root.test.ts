import {describe,expect,test} from "bun:test"
import {resolveDesktopDataRoot} from "../src/data-root.ts"

describe("desktop data-root isolation",()=>{
  test("distinct configured roots stay distinct and derive independently",()=>{
    const base={packaged:true,defaultUserData:"/home/test/.config/Lyapunov",productRoot:"/opt/lyapunov",mode:"formal" as const}
    const a=resolveDesktopDataRoot({...base,configured:"/tmp/lyapunov-a"})
    const b=resolveDesktopDataRoot({...base,configured:"/tmp/lyapunov-b"})
    expect(a).toBe("/tmp/lyapunov-a")
    expect(b).toBe("/tmp/lyapunov-b")
    expect(a).not.toBe(b)
    expect(`${a}/runtime`).not.toBe(`${b}/runtime`)
  })
  test("blank configuration never falls back to current working directory",()=>{
    expect(resolveDesktopDataRoot({configured:"   ",packaged:true,defaultUserData:"/home/test/.config/Lyapunov",productRoot:"/opt/lyapunov",mode:"formal"})).toBe("/home/test/.config/Lyapunov")
    expect(resolveDesktopDataRoot({configured:null,packaged:false,defaultUserData:"/home/test/.config/Lyapunov",productRoot:"/opt/lyapunov",mode:"developer"})).toBe("/opt/lyapunov/.runtime/desktop/developer")
  })
})
