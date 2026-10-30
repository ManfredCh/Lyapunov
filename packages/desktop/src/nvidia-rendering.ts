import {existsSync} from "node:fs"
/** 显式 Linux NVIDIA 路径；只改当前 Electron 子进程，不修改系统 PRIME 或驱动。 */
export const nvidiaGlSwitches:ReadonlyArray<readonly [string,string?]>=[
  ["ozone-platform","x11"],["use-gl","angle"],["use-angle","vulkan"],
  ["enable-features","Vulkan,VulkanFromANGLE"],["disable-vulkan-surface"],
]

export function nvidiaRenderingEnvironment(parent:NodeJS.ProcessEnv,platform:string):NodeJS.ProcessEnv{
  if(platform!=="linux")throw new Error("NVIDIA_RENDERING_UNSUPPORTED: --nvidia-rendering 当前仅支持 Linux")
  const nvidiaIcd=["/usr/share/vulkan/icd.d/nvidia_icd.json","/etc/vulkan/icd.d/nvidia_icd.json"].find(existsSync)
  return {...parent,...!parent.VK_DRIVER_FILES&&nvidiaIcd?{VK_DRIVER_FILES:nvidiaIcd}:{},__NV_PRIME_RENDER_OFFLOAD:"1",__GLX_VENDOR_LIBRARY_NAME:"nvidia",__VK_LAYER_NV_optimus:"NVIDIA_only"}
}

export function applyNvidiaGlSwitches(commandLine:{appendSwitch:(name:string,value?:string)=>void;getSwitchValue:(name:string)=>string}):void{
  for(const [name,value] of nvidiaGlSwitches){
    if(name==="enable-features"){
      const features=new Set([...commandLine.getSwitchValue(name).split(","),...value!.split(",")].filter(Boolean))
      commandLine.appendSwitch(name,[...features].join(","))
    }else if(value===undefined)commandLine.appendSwitch(name)
    else commandLine.appendSwitch(name,value)
  }
}

/** 设备枚举或 high-performance 偏好不等于真实渲染；显式选择必须核对已创建上下文。 */
export function assertNvidiaRendering(renderer:unknown,features:{webgl?:string}):void{
  if(typeof renderer!=="string"||!/nvidia/i.test(renderer)||/swiftshader|llvmpipe|softpipe|software/i.test(renderer)||features.webgl!=="enabled"){
    throw new Error(`NVIDIA_RENDERING_UNAVAILABLE: 实际 WebGL=${features.webgl??"unknown"}，renderer=${typeof renderer==="string"?renderer:"unknown"}；保留显式选择，未切换软件渲染`)
  }
}
