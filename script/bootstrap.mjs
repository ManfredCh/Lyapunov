import {spawnSync} from "node:child_process"
import {existsSync,readFileSync,mkdirSync} from "node:fs"
import {resolve,join} from "node:path"
import {applyUpstreamPatches} from "./upstream-patches.mjs"
const root=resolve(import.meta.dirname,"..")
const lock=JSON.parse(readFileSync(join(root,"UPSTREAM_LOCK.json"),"utf8"))
const upstream=join(root,lock.directory)
function run(command,args,cwd=root){
  const result=spawnSync(command,args,{cwd,stdio:"inherit",env:{...process.env,HF_ENDPOINT:"https://hf-mirror.com",DSH_TELEMETRY_DISABLED:"1"}})
  if(result.error)throw result.error
  if(result.status!==0)throw new Error(`${command} 退出 ${result.status}`)
}
if(!existsSync(upstream)){
  mkdirSync(resolve(upstream,".."),{recursive:true})
  run("git",["clone","--no-checkout",lock.repository,upstream])
  run("git",["checkout","--detach",lock.commit],upstream)
}
const current=spawnSync("git",["rev-parse","HEAD"],{cwd:upstream,encoding:"utf8"})
if(current.status!==0||current.stdout.trim()!==lock.commit)throw new Error("现有上游不是固定commit；保留现状，请检查UPSTREAM_LOCK.json")
applyUpstreamPatches(root,upstream)
// 0.1.5 使用根工作区构建；先应用补丁，再一起更新 Host、Client 和 Web 产物。
run("pnpm",["install","--frozen-lockfile"],upstream)
run("pnpm",["run","build"],upstream)
const localBun=process.env.BUN_EXECUTABLE??"bun"
const probe=spawnSync(localBun,["--version"],{encoding:"utf8"})
const bun=(args,cwd=root)=>probe.status===0?run(localBun,args,cwd):run("npm",["exec","--yes","--package=bun@1.3.13","--","bun",...args],cwd)
bun(["install","--frozen-lockfile"])
bun(["run","script/link-upstream.ts","--replace-owned"])
bun(["run","script/build-plugins.ts"])
// Blender MCP 是产品**基本能力**（架构工作台的建模侧走它），所以装依赖时就该把它备好，
// 而不是等用户第一次跑 dev:architecture 才被"建筑依赖不存在"挡住。
// 但**不因它失败而中止整个 bootstrap**：它需要联网与图形会话，缺了只影响建筑工作台一条线，
// 其余能力可独立工作（合同 §6.2 的「缺引擎能力→该项 BLOCKED，其他继续」）。失败必须**响亮**。
const mcp = spawnSync(localBun, ["run", "script/blender-mcp.ts"], {cwd:root,stdio:"inherit"})
if(mcp.status!==0){
  console.warn("⚠ Blender MCP 未就绪（建筑工作台的建模侧会退到批处理路径 blender_run）。")
  console.warn("  重试：bun run ensure:blender-mcp    只查状态：bun run doctor:blender-mcp")
}
console.log("DSH官方底座与产品插件构建完成。GPU、供应商和机器人验收需在独立环境执行。")
