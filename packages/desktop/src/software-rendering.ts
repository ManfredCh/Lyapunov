import {app} from "electron"
import {softwareGlSwitches} from "./software-rendering-switches.ts"

/**
 * 软件渲染模式的 GL 后端选择。
 *
 * Chromium 官方文档 docs/gpu/swiftshader.md 把「让发行自带的 SwiftShader 充当 OpenGL ES 驱动」
 * 写成显式的驱动模式：--use-gl=angle --use-angle=swiftshader。软件模式选的就是这条路径。
 * 不关闭 sandbox、不忽略 GPU blocklist、不使用 unsafe SwiftShader。
 */
export {softwareGlSwitches}

export function applySoftwareGlSwitches(commandLine:{appendSwitch:(name:string,value?:string)=>void}=app.commandLine):void{
  for(const [name,value] of softwareGlSwitches){
    if(value===undefined)commandLine.appendSwitch(name)
    else commandLine.appendSwitch(name,value)
  }
}
