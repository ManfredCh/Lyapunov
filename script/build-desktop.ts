import {resolve,join} from "node:path"
import {mkdir} from "node:fs/promises"
const root=resolve(import.meta.dirname,".."),desktop=join(root,"packages/desktop")
await mkdir(join(desktop,"dist"),{recursive:true})
for(const input of [
  {entry:"main.ts",target:"node" as const,format:"esm" as const,output:join(desktop,"dist/main.js"),external:["electron","electron-store","electron-window-state","electron-updater","@deepseek-ai/*"]},
  {entry:"preload.ts",target:"node" as const,format:"cjs" as const,output:join(desktop,"dist/preload.cjs"),external:["electron"]},
  {entry:"account-view.tsx",target:"browser" as const,format:"iife" as const,output:join(desktop,"renderer/account.js"),external:[]},
]){
  // node 目标保留 process.env.NODE_ENV 的运行时读取（Bun.build 默认会把构建机取值内联进产物）；
  // 浏览器目标仍固定内联 production（React 生产分支）。
  const built=await Bun.build({entrypoints:[join(desktop,"src",input.entry)],target:input.target,format:input.format,external:input.external,minify:false,define:{"process.env.NODE_ENV":input.target==="browser"?JSON.stringify("production"):"process.env.NODE_ENV"}})
  if(!built.success)throw new AggregateError(built.logs,"桌面构建失败")
  await Bun.write(input.output,built.outputs[0]!);console.log("已构建",input.output)
}
