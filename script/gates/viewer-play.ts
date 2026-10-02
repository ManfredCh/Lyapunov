/**
 * G19 的第 10 条判据：**烘焙动画在真实浏览器 Viewer 里真的播放**。
 *
 * 为什么不塞进 `g19.ts` 本体：本条需要「起一个真实产品 host + 真 Chrome + WebGL」，
 * 与 G19 其余只读产物的判据运行条件完全不同；且 `anim-glb.mjs`（node 读 GLB）、
 * 导入探针（bun 跑 scene-kit）已有先例——重条件子探针独立成驱动，由 `g19.ts` 调用并解析。
 *
 * 链路（每一环都是产品真实路径，没有 mock）：
 *   1. `startWebHost` 起真产品 host（developer 模式），拿到带 token 的真实 URL；
 *   2. 真 Chrome（headless + SwiftShader WebGL）打开该 URL —— 产品自带鉴权，不是伪造页面；
 *   3. 从产品**自己的** `/plugins/...` 路由取 `@lyapunov/viewer` 客户端包（发行字节）；
 *   4. `createViewer` + **单次** `setScene` 载入真 GLB；
 *   5. 在真实 rAF 渲染循环里采样：被 clip 绑定的 glTF 节点转角、`renderer.info` 帧号/三角形、
 *      画布 `readPixels` 直方指纹。
 *
 * 退出码：`0` 探针给出了判定（判定结果在 JSON 的 `ok`）；`2` **环境缺失**（无 Chrome / 无 WebGL /
 * host 起不来）——这类只算"本环境没覆盖到"，绝不当成产品失败，也绝不当成通过；`1` 探针自身出错。
 *
 * 用法：`PATH="$HOME/.bun/bin:$PATH" bun run script/gates/viewer-play.ts <animated.glb>`
 * 输出末行：`VIEWER_PLAY=<json>`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startWebHost } from "../host.ts"

const GLB = process.argv[2] ?? ""
const CHROME = process.env.CHROME_EXECUTABLE ?? process.env.CHROME_BIN ?? "google-chrome"
const RUNNER_PORT = Number(process.env.G19_VIEWER_CDP_PORT ?? 0)

interface Verdict {
  ok: boolean
  environment?: string
  detail: string
  facts?: unknown
  error?: string
}

/** 找一个当前空闲的端口：绑 0 拿系统分配值再释放，避免与 4180/4182/4280 这些常驻实例撞车。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.on("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => { port ? resolvePort(port) : rejectPort(new Error("FREE_PORT_UNAVAILABLE")) })
    })
  })
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => { setTimeout(resolve, ms) }) }

/** 只跑一次的 CDP 调用：每次新建 WS，取到结果即关。 */
async function cdp(port: number, method: string, params: unknown, timeoutMs = 180_000): Promise<Record<string, unknown>> {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
  const page = list.find(target => target.type === "page")
  if (!page) throw new Error("CDP_NO_PAGE_TARGET")
  return await new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { /* 已关 */ } rejectCall(new Error("CDP_TIMEOUT_" + method)) }, timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data)) as {
        id?: number; error?: unknown
        result?: { exceptionDetails?: { exception?: { description?: string } }; result?: { value?: unknown } }
      }
      if (message.id !== 1) return
      clearTimeout(timer); ws.close()
      if (message.error) { rejectCall(new Error("CDP_ERROR: " + JSON.stringify(message.error))); return }
      if (message.result?.exceptionDetails) {
        rejectCall(new Error("PAGE_EXCEPTION: " + String(message.result.exceptionDetails.exception?.description ?? "")))
        return
      }
      resolveCall(message.result ?? {})
    }
    ws.onerror = () => { clearTimeout(timer); rejectCall(new Error("CDP_WS_ERROR")) }
  })
}

async function evaluate(port: number, expression: string): Promise<unknown> {
  const result = await cdp(port, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  return (result as { result?: { value?: unknown } }).result?.value
}

async function chromeReady(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return true } catch { await sleep(250) }
  }
  return false
}

async function main(): Promise<Verdict> {
  if (!GLB || !existsSync(GLB)) return { ok: false, environment: "探针缺少存在的 GLB 参数", detail: `GLB=${GLB}` }
  if (typeof WebSocket !== "function") return { ok: false, environment: "运行器没有 WebSocket（需 bun）", detail: "WebSocket 不可用" }

  const temp = await mkdtemp(join(tmpdir(), "lyaup-g19-browser-"))
  const hostPort = await freePort()
  const cdpPort = await freePort()
  let host: Awaited<ReturnType<typeof startWebHost>> | undefined
  let chrome: ReturnType<typeof Bun.spawn> | undefined
  try {
    try {
      host = await startWebHost({ mode: "developer", runtimeRoot: join(temp, "runtime"), port: hostPort })
    } catch (error) {
      return { ok: false, environment: "真实产品 host 未能在本机启动", detail: String((error as Error)?.message ?? error).slice(-1200) }
    }

    try {
      chrome = Bun.spawn([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu-sandbox",
        "--use-gl=angle", "--use-angle=swiftshader",
        "--remote-debugging-port=" + String(cdpPort), "--user-data-dir=" + join(temp, "chrome"),
        "--no-first-run", "--no-default-browser-check", "--window-size=900,700", "about:blank",
      ], { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env, HOME: temp } })
    } catch (error) {
      return { ok: false, environment: `找不到可执行的 Chrome：${CHROME}`, detail: String((error as Error)?.message ?? error) }
    }
    if (!await chromeReady(cdpPort)) {
      chrome.kill()
      return { ok: false, environment: `Chrome 启动了但调试端口未就绪：${CHROME}`, detail: "CDP 端口未就绪" }
    }

    const webgl = await evaluate(cdpPort, `(()=>{const c=document.createElement("canvas");const gl=c.getContext("webgl2")||c.getContext("webgl");if(!gl)return null;const d=gl.getExtension("WEBGL_debug_renderer_info");return d?String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER))})()`)
    if (typeof webgl !== "string") {
      chrome.kill()
      return { ok: false, environment: "Chrome 没有可用的 WebGL 上下文", detail: "WebGL 不可用" }
    }

    await cdp(cdpPort, "Page.enable", {})
    await cdp(cdpPort, "Page.navigate", { url: host.url })
    await sleep(6000)
    const page = await evaluate(cdpPort, `location.origin`)
    if (page !== host.origin) return { ok: false, detail: `页面没落在产品 origin：${String(page)} != ${host.origin}` }

    const glbBase64 = (await readFile(GLB)).toString("base64")
    const raw = await evaluate(cdpPort, probeSource(glbBase64)) as ProbeFacts
    return verdict(raw, webgl)
  } catch (error) {
    return { ok: false, detail: "探针自身出错", error: String((error as Error)?.stack ?? error).slice(-2000) }
  } finally {
    try { chrome?.kill() } catch { /* 已退出 */ }
    try { await host?.stop() } catch { /* 已退出 */ }
    if (process.env.G19_KEEP !== "1") await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface ProbeSample { t: number; degY: number; frame: number; pixels: number; tris: number }
interface ProbeFacts {
  bundleBytes?: number
  summary?: { entities: number; clips: number; names: string[] }
  trackRoot?: string
  targetType?: string | null
  targetInRenderedScene?: boolean
  samples?: ProbeSample[]
  pausedFrozen?: { angleMoved: boolean; pixelsMoved: boolean }
  error?: string
}

/** 判定全在驱动里（不在页面里），这样"什么算通过"是门的一部分、可被审查。 */
function verdict(raw: ProbeFacts | undefined, webgl: string): Verdict {
  const facts = raw ?? {}
  if (!raw || raw.error) return { ok: false, detail: "页面探针未返回读数", error: raw?.error, facts }
  const samples = raw.samples ?? []
  const summary = raw.summary ?? { entities: 0, clips: 0, names: [] }
  const angles = samples.map(sample => sample.degY)
  const spread = angles.length ? Math.max(...angles) - Math.min(...angles) : 0
  const distinctPixels = new Set(samples.map(sample => sample.pixels)).size
  const frames = samples.length >= 2 ? samples[samples.length - 1]!.frame - samples[0]!.frame : 0
  const tris = Math.max(0, ...samples.map(sample => sample.tris))
  const frozen = raw.pausedFrozen

  const failures: string[] = []
  if (summary.entities < 1 || summary.clips < 1) failures.push(`单次 setScene 后播放表为空（entities=${summary.entities} clips=${summary.clips}）`)
  if (raw.targetInRenderedScene !== true) failures.push("clip 绑定的 glTF 节点不在被渲染的场景图里")
  if (!(spread >= 10)) failures.push(`被驱动节点转角摆幅只有 ${spread.toFixed(3)}°（要求 ≥10°）`)
  if (!(distinctPixels >= 3)) failures.push(`画布像素只出现 ${distinctPixels} 种（要求 ≥3，说明画面真的在变）`)
  if (!(frames >= 5)) failures.push(`采样期间只推进了 ${frames} 帧（要求 ≥5，说明是真实 rAF 循环）`)
  if (!(tris > 0)) failures.push("渲染的三角形数为 0（被驱动的网格没有被光栅化）")
  if (frozen === undefined) failures.push("缺少暂停负对照读数")
  else if (frozen.angleMoved || frozen.pixelsMoved) failures.push(`暂停后仍在变化（angleMoved=${frozen.angleMoved} pixelsMoved=${frozen.pixelsMoved}）`)

  const detail = [
    `真实浏览器（${webgl}）里从产品自身的 /plugins 路由取到 viewer 发行包 ${String(raw.bundleBytes)} 字节`,
    `**单次 setScene 后播放表就有 ${summary.entities} 个实体 / ${summary.clips} 个 clip**（${JSON.stringify(summary.names)}）`,
    `被 clip（track 根=${String(raw.trackRoot)}）绑定的 ${String(raw.targetType)} 节点在被渲染的场景图里=${String(raw.targetInRenderedScene)}`,
    `真实 rAF 采样 ${samples.length} 次：转角 ${angles.map(angle => angle.toFixed(2) + "°").join(" → ")}（摆幅 ${spread.toFixed(2)}°）`,
    `帧号推进 ${frames}、渲染三角形峰值 ${tris}、画布指纹 ${distinctPixels} 种`,
    `暂停负对照：角度复原=${String(frozen?.angleMoved === false)}、像素复原=${String(frozen?.pixelsMoved === false)}`,
  ].join("；")

  return failures.length
    ? { ok: false, detail: `在真实浏览器里播放失败：${failures.join(" / ")}——${detail}`, facts }
    : { ok: true, detail: `${detail}——烘焙动画在真浏览器的渲染循环里真的在动，且暂停后真的停住`, facts }
}

/** 页面侧探针：只做"取包、建 Viewer、载 GLB、采样"，判定不写在页面里。 */
function probeSource(glbBase64: string): string {
  return `(async()=>{
  const out={}
  try{
    const boot=window.__DSH_BOOT__
    if(!boot||!Array.isArray(boot.entries))throw new Error("NO_BOOT_GRAPH")
    const entry=boot.entries.find(e=>e.id==="@lyapunov/viewer")
    if(!entry)throw new Error("VIEWER_ENTRY_MISSING")
    // 取产品自己发出的发行字节。模块已注册过会重复注册抛错，故临时接管 load 只为拿到 factory。
    const source=await (await fetch(entry.url,{credentials:"include"})).text()
    out.bundleBytes=source.length
    const grab=[]
    const loader=window.__ModuleLoader__
    const saved=loader.load
    loader.load=registration=>grab.push(registration)
    try{ (0,eval)(source) } finally { loader.load=saved }
    const registration=grab.find(item=>item.id==="@lyapunov/viewer")
    if(!registration)throw new Error("VIEWER_REGISTRATION_MISSING")
    const viewer=registration.factory(()=>{throw new Error("EXTERNAL_NOT_AVAILABLE")})
    const THREE=viewer.THREE
    const container=document.createElement("div")
    container.style.cssText="position:fixed;left:0;top:0;width:640px;height:480px"
    document.body.appendChild(container)
    const v=viewer.createViewer({container,resolveResource:uri=>uri})
    const dataUrl="data:model/gltf-binary;base64,${glbBase64}"
    const snapshot={sceneId:"g19-viewer-play",revision:1,
      coordinates:{units:"m",upAxis:"Z",handedness:"right",quaternion:"xyzw"},
      entities:[{entityId:"animated",name:"g19_animated_leaf",
        transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},
        resources:[{id:"g19-res",source:{upAxis:"Z",handedness:"right",metersPerUnit:1},
          representations:[{role:"visual",mimeType:"model/gltf-binary",uri:dataUrl}]}],
        components:{visual:{kind:"mesh"}}}]}
    // 关键：**只 setScene 一次**。首次载入就该进播放表，否则产品里新开场景永远不动。
    await v.setScene(snapshot)
    out.summary=v.animationSummary()
    const entryM=v.mixers.get("animated")
    if(!entryM){out.samples=[];return out}
    const trackRoot=entryM.clips[0].tracks[0].name.split(".")[0]
    out.trackRoot=trackRoot
    let target=null
    entryM.mixer.getRoot().traverse(node=>{if(target===null&&node.name===trackRoot&&node!==v.scene)target=node})
    out.targetType=target?target.type:null
    out.targetInRenderedScene=(()=>{for(let node=target;node;node=node.parent)if(node===v.scene)return true;return false})()
    const degY=q=>{const e=new THREE.Euler().setFromQuaternion(q,"XYZ");return +(e.y*180/Math.PI).toFixed(3)}
    const pixelPrint=()=>{const gl=v.renderer.getContext();const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight
      const px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px)
      let hash=2166136261;for(let i=0;i<px.length;i+=53){hash^=px[i];hash=Math.imul(hash,16777619)}return hash>>>0}
    v.setAnimationsPlaying(true)
    out.samples=[]
    for(let i=0;i<5;i++){
      await new Promise(r=>setTimeout(r,420))
      out.samples.push({t:+entryM.mixer.time.toFixed(3),degY:degY(target.quaternion),
        frame:v.renderer.info.render.frame,pixels:pixelPrint(),tris:v.renderer.info.render.triangles})
    }
    v.setAnimationsPlaying(false)
    const frozenAngle=degY(target.quaternion), frozenPixels=pixelPrint()
    await new Promise(r=>setTimeout(r,700))
    out.pausedFrozen={angleMoved:degY(target.quaternion)!==frozenAngle,pixelsMoved:pixelPrint()!==frozenPixels}
    return out
  }catch(error){out.error=String(error&&error.stack||error);return out}
})()`
}

const result = await main()
console.log("VIEWER_PLAY=" + JSON.stringify(result))
process.exit(result.environment !== undefined ? 2 : result.error !== undefined ? 1 : 0)
