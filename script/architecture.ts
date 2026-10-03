/** 建筑工作台入口：持有独立 Blender addon 与既有 DSH Web Host。 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startWebHost, type HostHandle } from './host.ts'
import { PRODUCT_ROOT, hostRuntimeRoot } from './profile.ts'
import { resolveEngine } from './engine-preference.ts'
import { isaacRuntimeOptions } from './runtime-patch.ts'
import { blenderMcpPaths, blenderMcpStatus, ensureBlenderMcp, startBlenderMcpHost } from './blender-mcp.ts'

const { values } = parseArgs({ options: {
  port:{type:'string',default:'4230'}, 'blender-port':{type:'string',default:'9876'},
  engine:{type:'string'}, 'host-id':{type:'string',default:'architecture-mcp'},
  blender:{type:'string'}, addon:{type:'string'}, 'mcp-command':{type:'string'},
  'source-blend':{type:'string'}, 'software-rendering':{type:'boolean'},
  'isaac-device':{type:'string'}, 'isaac-rendering':{type:'string'}, 'isaac-startup-budget':{type:'string'},
} })
const port = Number(values.port), blenderPort = Number(values['blender-port'])
if (![port,blenderPort].every(v=>Number.isInteger(v)&&v>0&&v<=65535)) throw new Error('端口必须在1到65535之间')
// 引擎不再写死 mujoco：未给 --engine 时按共享规则解析（唯一实现 `engine-preference.ts`）。
const selection=resolveEngine({explicit:values.engine,productRoot:PRODUCT_ROOT})
const engine=selection.engine
if(selection.source!=='explicit')console.log(`物理引擎：${engine}（${selection.reason}）`)
if(engine!=='isaac'&&(values['isaac-device']!==undefined||values['isaac-rendering']!==undefined||values['isaac-startup-budget']!==undefined))throw new Error('Isaac选项需要--engine isaac')
// 启动预算只在**显式给 flag** 时带出：入口只把字符串转成数字，不设默认值、不重复校验
// （合法性由 ProcessSimProvider 构造函数唯一一处 RangeError 判定）。
const isaacBudget=values['isaac-startup-budget']
const isaac=engine==='isaac'?isaacRuntimeOptions({physicsDevice:values['isaac-device'],rendering:values['isaac-rendering'],...(isaacBudget===undefined?{}:{startupBudgetMs:Number(isaacBudget)})}):undefined
// Blender MCP 是**产品基本能力**，不是让用户手装的外挂：路径与版本都归 `script/blender-mcp.ts` 一个 owner，
// 这里只负责"没就绪就供给"，缺依赖不再直接抛错把人挡在门外。
// `--addon` / `--mcp-command` 仍可显式覆盖（保留原能力），显式给了就尊重显式值、不再供给。
const mcpPaths = blenderMcpPaths()
const before = blenderMcpStatus()
if (!before.ready && values.addon === undefined && values['mcp-command'] === undefined) {
  console.log('· Blender MCP 未就绪，开始供给：' + before.detail)
  await ensureBlenderMcp({ log: message => { console.log('· ' + message) } })
}
const addon = resolve(values.addon ?? mcpPaths.addon)
// PyPI 的 `blender-mcp` 2.0.0 现在只是兼容 shim，真正提供 stdio server 的包名是 `mcp-for-blender`
// （serverInfo 仍报 BlenderMCP）。默认指向真入口，照旧名配置会拿不到可用的 stdio 服务。
const command = resolve(values['mcp-command'] ?? mcpPaths.command)
for (const path of [addon,command,...values['source-blend']?[resolve(values['source-blend'])]:[]]) {
  if (!existsSync(path)) throw new Error('建筑依赖不存在：'+path+'；Blender MCP 由 `bun run ensure:blender-mcp` 供给（版本钉在 UPSTREAM_LOCK.json），也可用 --addon/--mcp-command 显式指定，不创建替代服务器')
}
console.log('· Blender MCP：' + blenderMcpStatus().detail)
// 只拥有新启动的 addon，不接管其他 Blender 工程。
await new Promise<void>((done,fail)=>{
  const probe=createServer(); probe.once('error',fail)
  probe.listen(blenderPort,'127.0.0.1',()=>probe.close(()=>done()))
})
process.env.LYAPUNOV_BLENDER_MCP_COMMAND=command
process.env.BLENDER_HOST='127.0.0.1'; process.env.BLENDER_PORT=String(blenderPort)
if(values['software-rendering']) {
  // 前三个是 Linux Mesa/X11 的软件渲染开关；macOS 走系统图形栈，注入这些 Linux 变量无效且会误导排障。
  if(process.platform==='linux'){
    process.env.LIBGL_ALWAYS_SOFTWARE='1'; process.env.GALLIUM_DRIVER='llvmpipe'
    process.env.__GLX_VENDOR_LIBRARY_NAME='mesa'
  }
  // glfw 在 Linux 与 macOS 都是 MuJoCo 支持的合法后端；平台默认（macOS cgl）见 sim-contract/src/mujoco-gl.ts。
  process.env.LYAPUNOV_MUJOCO_RENDER_BACKEND='glfw'
}
const runtimeRoot=hostRuntimeRoot({hostId:values['host-id']})!
await mkdir(runtimeRoot,{recursive:true})
const receiptPath=join(runtimeRoot,'architecture-launch.json')
// 启动与就绪判定归 `blender-mcp.ts` 一个 owner（产品入口与 MCP 现场验证共用同一段逻辑）。
const blenderHost = await startBlenderMcpHost({
  port: blenderPort,
  ...values['source-blend'] ? { sourceBlend: resolve(values['source-blend']) } : {},
  ...values.blender ? { blenderExecutable: values.blender } : {},
})
let host:HostHandle|undefined, stopped:Promise<void>|undefined
const abort = new AbortController()
const exited=blenderHost.exited
const stop=()=>stopped??=(async()=>{
  await host?.stop()
  await blenderHost.stop()
})()
const interrupt=()=>{abort.abort();void stop()}
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt)
try {
  const ready=blenderHost.ready
  if(stopped)throw new Error('建筑工作台启动已取消')
  host=await startWebHost({mode:'developer',hostId:values['host-id'],port,engine,isaac,grasp:'none',signal:abort.signal})
  // 回执记录实际装配的引擎与**本入口的**选择来源：Host 侧看到的是显式传入值，来源要用这里的 selection。
  await writeFile(receiptPath,JSON.stringify({status:'running',blenderPid:blenderHost.pid,hostPid:host.pid,origin:host.origin,engine:host.engine.engine,engineSource:selection.source,blender:ready,addon,command},null,2))
  console.log('dsh web: '+host.url)
  console.log('建筑工作台已就绪：DSH原生Blender MCP，默认Deepseek-flash Max。启动回执：'+receiptPath)
  await Promise.race([host.exited,exited])
} finally {
  await stop()
  // 停机回执同样带上引擎与来源：否则这份**留在盘上的**产物在正常退出后就答不出"刚才跑的是哪个引擎"，
  // 事后审计只能靠猜（真机读数见 bugfixHistory/ENGINE-ENTRY-CONSISTENCY-20260926.md）。
  await writeFile(receiptPath,JSON.stringify({status:'stopped',blenderPid:blenderHost.pid,hostPid:host?.pid,blenderExited:await exited,hostExited:host?await host.exited:undefined,engine:host?.engine.engine??engine,engineSource:selection.source},null,2))
}
