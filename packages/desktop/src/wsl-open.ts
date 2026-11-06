import {execFile} from "node:child_process"
import {readFileSync} from "node:fs"

export const isWsl=(env:NodeJS.ProcessEnv=process.env,readVersion:()=>string=()=>readFileSync("/proc/version","utf8"))=>{
  if(env.WSL_DISTRO_NAME||env.WSL_INTEROP)return true
  try{return /microsoft/i.test(readVersion())}catch{return false}
}

export const wslOpenCommand=(url:string,env:NodeJS.ProcessEnv=process.env)=>({
  file:"powershell.exe",
  args:["-NoProfile","-NonInteractive","-Command","Start-Process -FilePath $env:LYAPUNOV_OPEN_URL"],
  env:{...env,LYAPUNOV_OPEN_URL:url,WSLENV:[env.WSLENV,"LYAPUNOV_OPEN_URL"].filter(Boolean).join(":")}
})

// WSLg 的 D3D12 GL 驱动在 Chromium GPU 黑名单内，WebGL2/3D 视图被禁用；仅 Linux WSL 需要忽略黑名单。
export const needsWslGpuBlocklistBypass=(platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env,readVersion?:()=>string)=>platform==="linux"&&isWsl(env,readVersion)

export const shouldOpenOnWslHost=(platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env)=>platform==="linux"&&!env.BROWSER&&isWsl(env)

export const openOnWslHost=(url:string)=>new Promise<void>((resolve,reject)=>{
  const command=wslOpenCommand(url)
  execFile(command.file,command.args,{env:command.env,timeout:15000},error=>error?reject(error):resolve())
})
