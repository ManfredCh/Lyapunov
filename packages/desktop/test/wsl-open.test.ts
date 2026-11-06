import {expect,test} from "bun:test"
import {isWsl,needsWslGpuBlocklistBypass,shouldOpenOnWslHost,wslOpenCommand} from "../src/wsl-open.ts"

test("WSL 由环境变量或内核版本识别，普通 Linux 不受影响",()=>{
  expect(isWsl({WSL_DISTRO_NAME:"Ubuntu-24.04"},()=>{throw new Error("unused")})).toBe(true)
  expect(isWsl({},()=>"Linux version 6.6.87.2-microsoft-standard-WSL2")).toBe(true)
  expect(isWsl({},()=>"Linux version 6.8.0-generic")).toBe(false)
  expect(isWsl({},()=>{throw new Error("no /proc")})).toBe(false)
})

test("仅在 Linux 的 WSL 且用户未指定 BROWSER 时交给 Windows 宿主打开",()=>{
  expect(shouldOpenOnWslHost("linux",{WSL_DISTRO_NAME:"Ubuntu"})).toBe(true)
  expect(shouldOpenOnWslHost("linux",{WSL_DISTRO_NAME:"Ubuntu",BROWSER:"/usr/bin/firefox"})).toBe(false)
  expect(shouldOpenOnWslHost("win32",{WSL_DISTRO_NAME:"Ubuntu"})).toBe(false)
  expect(shouldOpenOnWslHost("darwin",{})).toBe(false)
})

test("仅 Linux WSL 忽略 Chromium GPU 黑名单，非 WSL Linux 与 macOS 不受影响",()=>{
  expect(needsWslGpuBlocklistBypass("linux",{WSL_DISTRO_NAME:"Ubuntu-24.04"},()=>{throw new Error("unused")})).toBe(true)
  expect(needsWslGpuBlocklistBypass("linux",{},()=>"Linux version 6.8.0-generic")).toBe(false)
  expect(needsWslGpuBlocklistBypass("darwin",{WSL_DISTRO_NAME:"Ubuntu-24.04"},()=>{throw new Error("unused")})).toBe(false)
})

test("授权地址通过环境变量传给 PowerShell，含 & 的查询串不经命令行解析",()=>{
  const url="https://vorynel.com/api/lyaup/authorize?client_id=a&state=b&code_challenge=c"
  const command=wslOpenCommand(url,{WSLENV:"FOO/p"})
  expect(command.file).toBe("powershell.exe")
  expect(command.args.join(" ")).not.toContain("&")
  expect(command.args.join(" ")).not.toContain(url)
  expect(command.env.LYAPUNOV_OPEN_URL).toBe(url)
  expect(command.env.WSLENV).toBe("FOO/p:LYAPUNOV_OPEN_URL")
  expect(wslOpenCommand(url,{}).env.WSLENV).toBe("LYAPUNOV_OPEN_URL")
})
