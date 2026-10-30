import { describe, expect, test } from "bun:test"
import { softwareGlSwitches } from "../src/software-rendering-switches.ts"

describe("Linux software renderer fallback", () => {
  test("uses X11 ANGLE/SwiftShader without disabling sandbox or vendor hardware paths", () => {
    expect(softwareGlSwitches).toEqual([
      ["ozone-platform", "x11"],
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
    ])
    expect(softwareGlSwitches.some(([name]) => name === "no-sandbox")).toBe(false)
    expect(softwareGlSwitches.some(([name]) => name === "disable-gpu-sandbox")).toBe(false)
    expect(softwareGlSwitches.some(([name]) => name === "ignore-gpu-blocklist")).toBe(false)
  })
})

import {applyNvidiaGlSwitches,assertNvidiaRendering,nvidiaGlSwitches,nvidiaRenderingEnvironment} from "../src/nvidia-rendering.ts"

describe("显式 NVIDIA 产品渲染",()=>{
  test("只向当前进程传 NVIDIA offload，保留用户环境并拒绝不支持的平台",()=>{
    const parent={DISPLAY:":1",CUSTOM:"kept"},result=nvidiaRenderingEnvironment(parent,"linux")
    expect(result).toMatchObject({...parent,__NV_PRIME_RENDER_OFFLOAD:"1",__GLX_VENDOR_LIBRARY_NAME:"nvidia",__VK_LAYER_NV_optimus:"NVIDIA_only"})
    expect(parent).toEqual({DISPLAY:":1",CUSTOM:"kept"})
    expect(()=>nvidiaRenderingEnvironment(parent,"darwin")).toThrow("NVIDIA_RENDERING_UNSUPPORTED")
  })
  test("合并既有 Chromium features，不关闭沙箱或忽略 blocklist",()=>{
    const values=new Map<string,string>([["enable-features","ExistingFeature,Vulkan"]])
    applyNvidiaGlSwitches({getSwitchValue:name=>values.get(name)??"",appendSwitch:(name,value)=>{values.set(name,value??"")}})
    expect(values.get("enable-features")).toBe("ExistingFeature,Vulkan,VulkanFromANGLE")
    expect(values.get("use-angle")).toBe("vulkan")
    for(const [name] of nvidiaGlSwitches)expect(["no-sandbox","disable-gpu-sandbox","ignore-gpu-blocklist","disable-software-rasterizer"]).not.toContain(name)
  })
  test("枚举到 NVIDIA 或实际是软件/Intel 时拒绝显式渲染，不暗 fallback",()=>{
    expect(()=>assertNvidiaRendering({gpuDevice:[{vendorId:4318}]},{webgl:"enabled"})).toThrow("NVIDIA_RENDERING_UNAVAILABLE")
    for(const renderer of ["ANGLE (Intel)","ANGLE (NVIDIA SwiftShader)","llvmpipe"]){
      expect(()=>assertNvidiaRendering(renderer,{webgl:"enabled"})).toThrow("NVIDIA_RENDERING_UNAVAILABLE")
    }
    expect(()=>assertNvidiaRendering("ANGLE (NVIDIA, RTX 5090 Laptop GPU)",{webgl:"disabled_off"})).toThrow("NVIDIA_RENDERING_UNAVAILABLE")
    expect(()=>assertNvidiaRendering("ANGLE (NVIDIA, RTX 5090 Laptop GPU)",{webgl:"enabled"})).not.toThrow()
  })
})
