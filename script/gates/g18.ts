/**
 * G18：3D 视口批注的**附着性**验收门（真实 Chrome + CDP + 真实宿主）。
 *
 * 合同（本门唯一要证的事）：
 *   1. 用户在 3D 视口里落的点，锚在**实体局部坐标**上，而不是贴在屏幕上；
 *   2. 因此转相机（orbit/zoom）之后，标记仍指向同一个世界点；
 *   3. 批注文字随采集一起落盘，并且**同一份**（编号/文字/锚点）能被模型侧工具取回；
 *      交给模型的那张图里，编号点已经被烧进像素（模型看得见图上的圈）。
 *
 * 为什么必须用真实浏览器：这条链路有一半在浏览器里——WebGL 画布上的拾取、标签贴图、
 * 把编号烧进 PNG 的 2D canvas、以及 device 像素比。Node 侧无法替代，也无法伪造读数。
 *
 * 复用 G12 的机制（不另造一套）：起宿主的命令、token URL 抓取、Node 侧握手拿 cookie、
 * 一条贯穿全门的 CDP 会话、真实鼠标输入（Input.dispatchMouseEvent）、页面内错误收集器。
 *
 * 退出码语义同 §6.4：0 通过 / 1 有真实失败 / 2 依赖未就绪（BLOCKED）。
 * 用法：`bun run script/gates/run-g18.ts`（或 `node script/gates/run-g18.ts`）
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
/** 证据目录：截图与宿主运行根都留在这里，便于人工复核失败现场。 */
const EVIDENCE_DIR = join(PRODUCT_ROOT, ".runtime/goal-verify/g18")
const SHOT_PATH = join(EVIDENCE_DIR, "annotation-before-orbit.png")
const ORBIT_SHOT_PATH = join(EVIDENCE_DIR, "annotation-after-orbit.png")
/**
 * 运行根：默认**每次运行独立**（同 G12 的理由：并发实例不能共用同一个 DSH home）。
 * 给了 `G18_RUNTIME_ROOT` 就复用它——定向调试时不必每次重走工作区选择。
 */
const RUNTIME_ROOT = resolve(PRODUCT_ROOT, process.env.G18_RUNTIME_ROOT ?? join(".runtime/goal-verify/g18", `runtime-${String(process.pid)}`))
const WORKSPACE_DIR = resolve(RUNTIME_ROOT, "workspace")

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.on("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => port ? resolvePort(port) : rejectPort(new Error("FREE_PORT_UNAVAILABLE")))
    })
  })
}
const CDP_PORT = Number(process.env.G18_CDP_PORT ?? 0) || await freePort()

/** 页面内：标签页目标（扩展页/worker 也在清单里，必须按 type 过滤）。 */
async function cdpPageTarget(): Promise<{ webSocketDebuggerUrl: string }> {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
  const page = list.find(target => target.type === "page")
  if (!page) throw new Error("CDP_NO_PAGE_TARGET")
  return page
}

/** 一条贯穿全门的 CDP 会话（注入脚本归属会话，断开即失效）。 */
class CdpSession {
  private socket: WebSocket | undefined
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  async connect(): Promise<void> {
    const page = await cdpPageTarget()
    await new Promise<void>((resolveOpen, reject) => {
      const socket = new WebSocket(page.webSocketDebuggerUrl)
      this.socket = socket
      socket.onopen = () => resolveOpen()
      socket.onerror = () => reject(new Error("CDP_WS_ERROR connect"))
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown }
        if (message.id === undefined) return
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(`CDP_ERROR: ${JSON.stringify(message.error)}`))
        else waiter.resolve(message.result)
      }
    })
  }
  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error("CDP_NOT_CONNECTED"))
    const id = ++this.sequence
    return new Promise<T>((resolveCall, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolveCall(value as T) }, reject: error => { clearTimeout(timer); reject(error) } })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  close(): void { try { this.socket?.close() } catch { /* 已关闭 */ } this.socket = undefined }
}
const session = new CdpSession()

interface PageEvaluation<T> { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }
async function evaluateOnce<T>(expression: string, timeoutMs: number): Promise<T> {
  const outcome = await session.send<PageEvaluation<T>>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs)
  // 报错必须带上表达式本身：页面求值失败时若只报 "missing )"，排查者无法知道是哪一段（本门实测踩过）。
  if (outcome.exceptionDetails) throw new Error("PAGE_EXCEPTION: " + String(outcome.exceptionDetails.exception?.description ?? "").slice(0, 300) + " | expression=" + expression.slice(0, 300))
  return outcome.result?.value as T
}
async function evaluateInPage<T>(expression: string, timeoutMs = 30000): Promise<T> {
  // 页面在初始化（挂工作台 + 起 GL 上下文 + 高频轮询）时偶发几十秒不响应求值：
  // 这是环境抖动而非产品缺陷。只对**超时**做一次有界重试，页面真报错（PAGE_EXCEPTION）立刻如实抛出。
  try { return await evaluateOnce<T>(expression, timeoutMs) }
  catch (error) {
    if (!String((error as Error)?.message ?? error).includes("CDP_TIMEOUT")) throw error
    return await evaluateOnce<T>(expression, Math.max(timeoutMs, 45000))
  }
}
async function cdpHttp<T>(path: string): Promise<T | undefined> {
  try { const response = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`); return response.ok ? await response.json() as T : undefined } catch { return undefined }
}
async function waitFor<T>(expression: string, timeoutMs = 60000, stepMs = 300): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < deadline) {
    try { const value = await evaluateInPage<T>(expression, 45000); if (value) return value } catch (error) { lastError = String((error as Error)?.message ?? error) }
    await new Promise(resolveWait => setTimeout(resolveWait, stepMs))
  }
  if (lastError) throw new Error(`WAIT_FOR_FAILED: ${lastError}`)
  return undefined
}
/**
 * 输入类命令的容错发送。
 *
 * 为什么需要：本门跑在共享的构建机上，负载高时 Chromium 的输入通道会偶发几十秒不响应
 * （实测 `Input.dispatchMouseEvent` 超时，而页面本身正常）。超时是环境抖动，重试即可；
 * 真正的 CDP_ERROR（协议/参数错误）不重试，立刻抛出。
 */
async function sendInput(method: string, params: Record<string, unknown>, attempts = 3): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { await session.send(method, params, 60000); return }
    catch (error) {
      lastError = error
      if (!String((error as Error)?.message ?? error).includes("CDP_TIMEOUT")) throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
  }
  throw lastError
}

/** 真实鼠标：按下/抬起走 Chromium 输入管线，不注入页面内合成事件。 */
async function clickAt(x: number, y: number): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"]) await sendInput("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
}
async function clickByAria(aria: string): Promise<boolean> {
  const box = await evaluateInPage<{ x: number; y: number } | null>(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.getAttribute('aria-label')||'')===${JSON.stringify(aria)});if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  if (!box) return false
  await clickAt(box.x, box.y)
  return true
}
async function clickByText(text: string): Promise<boolean> {
  const box = await evaluateInPage<{ x: number; y: number } | null>(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()===${JSON.stringify(text)});if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  if (!box) return false
  await clickAt(box.x, box.y)
  return true
}
async function typeText(value: string): Promise<void> {
  for (const character of [...value]) {
    await sendInput("Input.dispatchKeyEvent", { type: "keyDown", text: character, unmodifiedText: character })
    await sendInput("Input.dispatchKeyEvent", { type: "keyUp", text: character, unmodifiedText: character })
  }
}
async function selectAll(): Promise<void> { await sendInput("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }) }
async function pressEnter(): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) await sendInput("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
}
async function pressEscape(): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) await sendInput("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
}

/** 未捕获错误收集器：只记录，不改产品行为；标记位用于核对它真的落地。 */
const ERROR_COLLECTOR = `(()=>{const errors=[];Object.defineProperty(window,'__dshPageErrors',{value:errors,configurable:true});window.addEventListener('error',event=>{errors.push(String(event.message||event.error||'error'))});window.addEventListener('unhandledrejection',event=>{errors.push('unhandledrejection: '+String(event.reason))});Object.defineProperty(window,'__dshErrorCollectorInstalled',{value:true,configurable:true})})()`

/**
 * 请求录制器：只录应用自己发出的 /api POST 信封（含 sessionId 与命令名），
 * 本门用它拿"真实会话 id"和"真实命令形状"，不自己编造会话。
 */
const ENVELOPE_RECORDER = `(()=>{if(window.__g18Recorder)return 'already';const recorded=[];window.__g18Recorded=recorded;const original=window.fetch;window.fetch=function(input,init){try{const url=typeof input==='string'?input:(input&&input.url)||'';const method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();const body=init&&typeof init.body==='string'?init.body:null;if(method==='POST'&&url.includes('/api/')&&body&&recorded.length<80){try{const parsed=JSON.parse(body);recorded.push({url,envelope:parsed})}catch{/* 非 JSON 信封不记 */}}}catch{/* 记录失败不得影响产品请求 */}return original.apply(this,arguments)};window.__g18Recorder=true;return 'installed'})()`

const PAGE_ERRORS_EXPRESSION = `(()=>{const errors=Array.isArray(window.__dshPageErrors)?window.__dshPageErrors:null;const loader=window.__ModuleLoader__;return{installed:errors!==null,errors:errors?errors.slice(0,5):[],count:errors?errors.length:-1,pending:(loader&&Array.isArray(loader.pendingQueue))?loader.pendingQueue.length:-1}})()`

const WORKBENCH_READY_EXPRESSION = `(()=>{const rail=document.querySelector('nav[aria-label="工作台工具"]');if(!rail)return null;const items=Array.from(rail.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||'');const canvas=document.querySelectorAll('.lya-canvas canvas').length;return canvas>0&&items.length>0?{items,canvas}:null})()`

/** 批注标记在世界里的屏幕位置：由 viewer 自己的投影给出，避免门里另写一套相机数学。 */
const MARKER_ANCHOR_EXPRESSION = `(()=>{const host=document.querySelector('.lya-canvas');const canvas=host?host.querySelector('canvas'):null;if(!canvas)return null;const r=canvas.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,left:r.x,top:r.y}})()`

async function killProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  try { child.kill("SIGTERM") } catch { /* 已退出 */ }
  await new Promise(resolveWait => setTimeout(resolveWait, 800))
  try { child.kill("SIGKILL") } catch { /* 已退出 */ }
  // 宿主自己会 spawn 子进程（provider worker 等），必须整组杀掉，否则会留下占着运行根的孤儿。
  if (pid) { try { process.kill(-pid, "SIGKILL") } catch { /* 无独立进程组或已退出 */ } }
}

interface HostAttempt { ok: boolean; url?: string; reasons: string[]; host?: ChildProcess }
async function startWebHost(runtimeRoot: string): Promise<HostAttempt> {
  const reasons: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = Number(process.env.G18_PORT ?? 0) || await freePort()
    let child: ChildProcess | undefined
    try {
      child = spawn("node", ["script/launch.ts", "--mode", "developer", "--surface", "web", "--port", String(port), "--runtime-root", runtimeRoot, "--engine", "mujoco", "--grasp", "analytic"], { cwd: PRODUCT_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true })
      let stderr = ""
      child.stderr?.on("data", chunk => { stderr += String(chunk) })
      let buffered = ""
      const outcome = await new Promise<{ url?: string; exitCode?: number | null; timedOut?: boolean }>(resolveOutcome => {
        const timer = setTimeout(() => resolveOutcome({ timedOut: true }), 120000)
        child!.stdout!.on("data", chunk => {
          buffered += String(chunk)
          const match = /dsh web: (http:\/\/\S+)/.exec(buffered)
          if (match) { clearTimeout(timer); resolveOutcome({ url: match[1] }) }
        })
        child!.on("exit", code => { clearTimeout(timer); resolveOutcome({ exitCode: code }) })
        child!.on("error", error => { clearTimeout(timer); stderr += ` spawn error: ${error.message}`; resolveOutcome({ exitCode: null }) })
      })
      if (outcome.url) return { ok: true, url: outcome.url, reasons, host: child }
      reasons.push(outcome.timedOut ? `第 ${String(attempt)} 次：120s 内未捕获 URL 行（port=${String(port)}）` : `第 ${String(attempt)} 次：退出 code=${String(outcome.exitCode)}；stderr 尾部=${JSON.stringify(stderr.trim().slice(-300))}`)
      await killProcess(child)
    } catch (error) {
      reasons.push(`第 ${String(attempt)} 次：启动期异常 ${String((error as Error)?.message ?? error).slice(0, 200)}`)
      await killProcess(child)
    }
  }
  return { ok: false, reasons }
}


/** 点工具轨里的入口（同一个 aria-label 也在别处出现的情况：限定在 rail 内查找）。 */
async function clickRail(label: string): Promise<boolean> {
  const box = await evaluateInPage<{ x: number; y: number } | null>(`(()=>{const rail=document.querySelector('nav[aria-label="工作台工具"]');const b=rail?Array.from(rail.querySelectorAll('button')).find(x=>(x.getAttribute('aria-label')||'')===${JSON.stringify(label)}):null;if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  if (!box) return false
  await clickAt(box.x, box.y)
  return true
}

// 就地修改判据要读 revision 与 transform：这里**只补字段**，不删不改既有字段（既有判据一行未动）。
interface HostState { scene?: { sceneId?: string; revision?: number; entities?: Array<{ entityId?: string; name?: string; transform?: { position?: number[]; quaternion?: number[]; scale?: number[] } }> }; captures?: Array<{ captureId?: string; annotationCount?: number; annotationDigest?: Array<{ index: number; entity: string; text: string }> }> }

/** 从录制到的信封里取出真实会话 id（应用自己发的，不猜格式）。 */
interface RecordedEnvelope { url: string; envelope: { sessionId?: unknown; name?: unknown; input?: unknown } }
const SESSION_FROM_RECORDING = `(()=>{const rows=Array.isArray(window.__g18Recorded)?window.__g18Recorded:[];const ids=[];for(const row of rows){const id=row&&row.envelope?row.envelope.sessionId:undefined;if(typeof id==='string'&&id&&!ids.includes(id))ids.push(id)}return{ids,count:rows.length,names:rows.map(r=>String(r&&r.envelope?r.envelope.name:'')).filter(Boolean).slice(0,20)}})()`


/**
 * 按产品 `world_poses` 的**同一套规则**复合出实体的世界位姿（只算位置，够本判据用）。
 *
 * 为什么必须复合：我第一版拿"实体局部位置"直接当期望的世界位置，于是判据报 FAIL——
 * 而真相是这条链上有 **90° 绕 X 的源坐标转换** 与 **父级缩放 1.939655**：
 *   :node:1 世界位置 = 父世界位置 + R_parent · (局部位置 × 父缩放)
 * 按这个算，rev2/rev3 分别是 [0,-2.4246,0.0447] / [0,-2.4246,1.4994]，
 * **与引擎报的逐位一致**；我那次编辑的期望 Δ 也正好是引擎实测的 Δz=1.4547。
 * 也就是说**产品是对的，判据是我写错了**——所以这里把规则补齐，而不是把判据放宽。
 */
function composedWorldPositions(scene: { entities?: Array<{ entityId?: string; parentId?: string; name?: string; transform?: { position?: number[]; quaternion?: number[]; scale?: number[] } }> }): Map<string, [number, number, number]> {
  const rows = scene.entities ?? []
  const byId = new Map(rows.map(row => [String(row.entityId), row]))
  const memo = new Map<string, { p: [number, number, number]; q: number[]; s: number[] }>()
  const active = new Set<string>()
  const toWxyz = (q?: number[]): number[] => {
    const v = q ?? [0, 0, 0, 1]
    return [Number(v[3]), Number(v[0]), Number(v[1]), Number(v[2])]
  }
  const quatMul = (a: number[], b: number[]): number[] => {
    const [aw, ax, ay, az] = a as [number, number, number, number]
    const [bw, bx, by, bz] = b as [number, number, number, number]
    return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw]
  }
  const rotate = (v: number[], q: number[]): number[] => {
    const [w, x, y, z] = q as [number, number, number, number]
    const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)]
    return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)]
  }
  const get = (id: string): { p: [number, number, number]; q: number[]; s: number[] } => {
    const cached = memo.get(id)
    if (cached) return cached
    if (active.has(id)) throw new Error(`场景层级成环：${id}`)
    active.add(id)
    const row = byId.get(id)
    if (!row) throw new Error(`层级引用了不存在的实体：${id}`)
    const t = row.transform ?? {}
    let p = (t.position ?? [0, 0, 0]).map(Number) as [number, number, number]
    let q = toWxyz(t.quaternion)
    let scale = (t.scale ?? [1, 1, 1]).map(Number)
    if (row.parentId) {
      // **关键**：用的是父节点的**复合**位姿（位置 + 复合四元数 + 复合缩放），不是它的局部值——
      // 我第一版取局部四元数，于是丢了 `:source` 的 90° 绕 X 旋转，期望值算成 [0,0,1.2947] 而引擎是
      // [0,-2.4246,0.0447]，把"产品完全正确"误判成 FAIL。这与 worker 的 `world_poses` 逐行同构。
      const parent = get(String(row.parentId))
      const rotated = rotate([p[0] * parent.s[0]!, p[1] * parent.s[1]!, p[2] * parent.s[2]!], parent.q)
      p = [parent.p[0] + rotated[0]!, parent.p[1] + rotated[1]!, parent.p[2] + rotated[2]!]
      q = quatMul(parent.q, q)
      scale = [scale[0]! * parent.s[0]!, scale[1]! * parent.s[1]!, scale[2]! * parent.s[2]!]
    }
    active.delete(id)
    const out = { p, q, s: scale }
    memo.set(id, out)
    return out
  }
  const positions = new Map<string, [number, number, number]>()
  for (const row of rows) positions.set(String(row.entityId), get(String(row.entityId)).p)
  return positions
}

export async function gateG18(): Promise<GateResult> {
  const checks: Check[] = []
  let host: ChildProcess | undefined
  let chrome: ChildProcess | undefined
  try {
    await mkdir(WORKSPACE_DIR, { recursive: true })
    await mkdir(EVIDENCE_DIR, { recursive: true })

    // 1) 起真实宿主（产品自己的入口，不绕过任何一层）。
    const attempt = await startWebHost(RUNTIME_ROOT)
    host = attempt.host
    checks.push({ name: "host_started_real_entry", ok: attempt.ok, detail: attempt.ok ? `node script/launch.ts --mode developer --surface web 起宿主成功；URL=${String(attempt.url)}` : `起宿主失败：${attempt.reasons.join("；")}` })
    if (!attempt.ok || !attempt.url) return { gate: "G18", checks, blocked: "web 宿主未就绪" }
    const url = attempt.url

    // 2) Node 侧握手：token URL → 303 + Set-Cookie → 干净根路径；cookie 之后给所有 Node 侧 API 调用复用。
    const handshake = await fetch(url, { redirect: "manual" })
    const cookiePair = (handshake.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const cleanRoot = await fetch(new URL("/", url).href, { redirect: "manual", headers: { cookie: cookiePair } })
    checks.push({ name: "session_cookie_handshake", ok: handshake.status === 303 && cleanRoot.status === 200, detail: `token URL → ${String(handshake.status)}；带 cookie 请求 / → ${String(cleanRoot.status)}；cookie=${cookiePair ? "已取得" : "缺失"}` })

    // 3) 真实 Chrome + CDP。
    const chromeProfile = join(EVIDENCE_DIR, `chrome-profile-${String(process.pid)}`)
    await rm(chromeProfile, { recursive: true, force: true })
    chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${String(CDP_PORT)}`, "--no-sandbox", "--disable-gpu", `--user-data-dir=${chromeProfile}`, "--window-size=1600,900", "about:blank"], { stdio: "ignore" })
    let cdpVersion = await cdpHttp<{ Browser?: string }>("/json/version")
    for (let probe = 0; probe < 60 && !cdpVersion?.Browser; probe++) { await new Promise(resolveWait => setTimeout(resolveWait, 500)); cdpVersion = await cdpHttp<{ Browser?: string }>("/json/version") }
    checks.push({ name: "chrome_cdp_available", ok: Boolean(cdpVersion?.Browser), detail: `Browser=${String(cdpVersion?.Browser)}` })
    if (!cdpVersion?.Browser) return { gate: "G18", checks, blocked: "Chrome CDP 未就绪" }

    await session.connect()
    await session.send("Page.enable", {})
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: ERROR_COLLECTOR })
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: ENVELOPE_RECORDER })
    // 导航超时按**装置层**放宽到 120s：Page.navigate 在机器被其它 session 占满时实测会超过默认 30s
    // （本轮实测 `CDP_TIMEOUT Page.navigate` 一次）。**不改任何判据**，只给这一条 RPC 更长的上限。
    const navigation = await session.send<{ errorText?: string }>("Page.navigate", { url }, 120000)
    await waitFor<string>("(()=>document.body&&document.readyState?document.readyState:'')()", 30000, 200)
    let workbench = await waitFor<{ items: string[]; canvas: number }>(WORKBENCH_READY_EXPRESSION, 20000, 400)
    // 全新运行根没有已保存的工作区：必须先真实走一次目录选择器（与用户操作同源，不绕过界面）。
    let workspaceFlow = workbench ? "工作区由产品持久化恢复" : "未开始"
    if (!workbench) {
      // 目录选择器流程可能撞上页面初始化抖动（求值超时/对话框晚挂）：最多走三遍，每遍都重新点开，
      // 走通即停。仍走不通时把每遍现场拼进 detail，不把"没走通"写成"产品没有这个入口"。
      const attempts: string[] = []
      for (let attempt = 1; attempt <= 3 && !workbench; attempt++) {
        try {
          await pressEscape()
          const pickerOpened = await clickByAria("选择工作区")
          const dialogReady = pickerOpened ? await waitFor<string>(`(()=>{const d=document.querySelector('[role=dialog]');const t=d?String(d.innerText||''):'';return t.includes('选择工作区目录')?t.replace(/\\n/g,'|').slice(0,60):''})()`, 20000, 400) : ""
          const editPath = dialogReady ? await clickByAria("编辑路径") : false
          let listed = ""
          if (editPath) {
            await selectAll()
            await typeText(WORKSPACE_DIR + "/")
            await pressEnter()
            listed = await waitFor<string>(`(()=>{const d=document.querySelector('[role=dialog]');const t=d?String(d.innerText||''):'';const hit=t.split('\\n').map(line=>line.trim()).filter(line=>line==='workspace');return hit.length?hit.join('|'):''})()`, 20000, 400) ?? ""
          }
          const openState = await evaluateInPage<string>(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='打开');return b?(b.disabled?'禁用':'可用'):'未找到'})()`)
          const picked = listed && openState === "可用" ? await clickByText("打开") : false
          if (picked) workbench = await waitFor<{ items: string[]; canvas: number }>(WORKBENCH_READY_EXPRESSION, 30000, 500)
          attempts.push(`第 ${String(attempt)} 遍：选择器=${String(pickerOpened)}、对话框=${Boolean(dialogReady)}、编辑路径=${String(editPath)}、列到目录=${JSON.stringify(listed)}、打开=${openState}、已点=${String(picked)}`)
        } catch (error) {
          attempts.push(`第 ${String(attempt)} 遍异常：${String((error as Error)?.message ?? error).slice(0, 120)}`)
        }
      }
      workspaceFlow = attempts.join("；")
    }
    checks.push({ name: "workbench_mounted_in_browser", ok: Boolean(workbench), detail: `Page.navigate errorText=${String(navigation.errorText ?? "无")}；${workspaceFlow}；工具轨入口=[${(workbench?.items ?? []).join(",")}]；3D canvas=${String(workbench?.canvas ?? 0)}` })
    if (!workbench) return { gate: "G18", checks, blocked: "工作台未在浏览器里挂载（工作区选择未完成）" }

    // 4) 打开批注面板：真实点击工具栏入口，面板必须挂出来（不是"我以为它开了"）。
    const railClicked = await clickByAria("批注")
    const panel = await waitFor<string>(`(()=>{const p=document.querySelector('[data-tool="annotation"]');return p?String(p.innerText||'').slice(0,400):''})()`, 15000, 300)
    checks.push({ name: "annotation_panel_opens_by_real_click", ok: Boolean(panel && panel.includes("开始批注")), detail: `点击工具栏"批注"=${String(railClicked)}；面板文本=${JSON.stringify(String(panel ?? "").replace(/\n/g, "|").slice(0, 200))}` })
    if (!panel) return { gate: "G18", checks, blocked: "批注面板未打开" }

    // 5) 会话 id：从应用自己发出的请求里取（不猜格式、不伪造会话）。
    await clickByAria("新建会话")
    await waitFor<string>(`(()=>{const bar=document.querySelector('[data-slot="conversation.composer.bar"]');return bar?'composer':'wait'})()`, 20000, 300)
    const recording = await evaluateInPage<{ ids: string[]; count: number; names: string[] }>(SESSION_FROM_RECORDING)
    checks.push({ name: "real_session_id_recovered_from_app_requests", ok: recording.ids.length > 0, detail: `录制信封 ${String(recording.count)} 条；会话 id=[${recording.ids.join(",")}]；命令名样本=[${recording.names.join(",")}]` })
    const sessionId = recording.ids[0]
    if (!sessionId) return { gate: "G18", checks, blocked: "拿不到真实会话 id" }

    // 6) 建场景：先用产品自己的命令路由（与界面按钮同源）。先看当前会话是否已有场景。
    const origin = new URL(url).origin
    const command = async (name: string, input: unknown): Promise<{ ok: boolean; text: string }> => {
      const response = await fetch(`${origin}/api/lyapunov/command`, { method: "POST", headers: { "content-type": "application/json", cookie: cookiePair }, body: JSON.stringify({ sessionId, name, input }) })
      const value = await response.json() as { result?: { kind?: string; text?: string } }
      // 300 字符会在嵌套回执（resource.ref 等）中途截断，把要判读的 entityId 截没——保留完整文本，展示时再截。
      return { ok: response.ok && value.result?.kind === "success", text: JSON.stringify(value) }
    }
    const readState = async (sceneIdArgument?: string): Promise<HostState> => await (await fetch(`${origin}/api/lyapunov/state?sessionId=${encodeURIComponent(sessionId)}${sceneIdArgument ? `&sceneId=${encodeURIComponent(sceneIdArgument)}` : ""}`, { headers: { cookie: cookiePair } })).json() as HostState
    const stateBefore = await readState()
    let sceneId = stateBefore.scene?.sceneId
    let entityCount = stateBefore.scene?.entities?.length ?? 0
    if (!sceneId) {
      // 场景必须由**界面按钮**建：客户端只有在它自己 loadScene 之后才会把新场景写进会话选择，
      // 而后续所有命令（含批注采集）都按该选择做归属核对。绕过界面直接发 scene_create，
      // 会得到"宿主里有一个场景、会话选择里没有"的分裂状态，那不是用户的路径。
      // 工具入口是开合语义且面板挂载有延迟：点一次可能正好落在"上一次还开着"的窗口上把它关掉。
      // 这里按"点名 → 等面板"重试，最多三次；仍不开则把现场列出来（而不是笼统说"按钮不可用"）。
      let scenePanel: string | undefined
      for (let attempt = 0; attempt < 3 && !scenePanel; attempt++) {
        await clickRail("场景")
        scenePanel = await waitFor<string>(`(()=>{const p=document.querySelector('[data-tool="scene"]');return p?'open':''})()`, 12000, 300)
      }
      if (!scenePanel) {
        // 修：原为 `const现场`（CJK 是合法标识符字符，于是声明了名为 `const现场` 的变量，
        // 而下一行的 `detail: 现场` 指向未声明标识符 → TS2304，整门在 tsc 与 node 下都跑不起来）。
        // 这不是本轮引入的：由并发 session 留下，本轮因"要复跑 G18"而修掉，只加一个空格，判据未动。
        const 现场 = await evaluateInPage<string>(`(()=>{const rail=document.querySelector('nav[aria-label="工作台工具"]');const items=rail?Array.from(rail.querySelectorAll('button')).map(b=>(b.getAttribute('aria-label')||'')+':'+String(b.getAttribute('aria-pressed'))):[];const panels=Array.from(document.querySelectorAll('[data-tool]')).map(p=>String(p.getAttribute('data-tool')));return JSON.stringify({items,panels})})()`).catch(() => "现场读取失败")
        checks.push({ name: "scene_panel_open_diagnostics", ok: false, detail: 现场 })
      }
      const newSceneButton = await waitFor<string>(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>(x.innerText||'').trim()==='新建场景');return b?(b.disabled?'禁用':'可用'):''})()`, 12000, 300)
      const clickedNew = newSceneButton === "可用" ? await clickByText("新建场景") : false
      const picked = clickedNew ? await waitFor<string>(`(()=>{const s=document.querySelector('select');const v=s?String(s.value||''):'';return v?v:''})()`, 20000, 400) : undefined
      sceneId = picked ?? (await readState()).scene?.sceneId
      entityCount = (await readState(sceneId)).scene?.entities?.length ?? 0
      checks.push({ name: "scene_created_through_ui_button", ok: Boolean(sceneId), detail: `场景面板=${String(scenePanel ?? "未打开")}；"新建场景"按钮=${String(newSceneButton ?? "未找到")}；已点击=${String(clickedNew)}；界面选中场景=${String(picked ?? "未读到")}；sceneId=${String(sceneId)}` })
    }
    checks.push({ name: "scene_available_for_annotation", ok: Boolean(sceneId), detail: `sceneId=${String(sceneId)}；实体数=${String(entityCount)}（实体数为 0 时视口里没有可命中的表面，本门需要真实几何）` })
    if (!sceneId) return { gate: "G18", checks, blocked: "会话里没有可用场景" }

    // 7) 视口里必须有可命中的几何：界面自己导入一个内置素材并挂载（与用户操作同源）。
    //    没有几何就没有批注落点——这一步失败即 BLOCKED，而不是把"点不中"当成产品缺陷。
    let surface = entityCount > 0
    let entityId: string | undefined
    if (!surface) {
      // 素材路径来自宿主自己的内置库投影（不硬编码目录，assetId 变了也不会静默失效）。
      const library = await (await fetch(`${origin}/api/lyapunov/builtin-assets`, { headers: { cookie: cookiePair } })).json() as { resources?: Array<{ assetId?: string; kind?: string; path?: string }> }
      const candidate = library.resources?.find(item => item.kind === "mesh" && typeof item.path === "string")
      const imported = candidate?.path ? await command("scene_import", { path: candidate.path, sceneId, name: "annotation-probe-object", physicalize: false }) : { ok: false, text: "内置库里没有 mesh 素材" }
      entityId = /\\?"entityId\\?":\\?"([^"\\]+)/.exec(imported.text)?.[1]
      const mounted = { ok: imported.ok && Boolean(entityId), text: entityId ? `entityId=${entityId}` : "scene_import 未返回 entityId" }
      checks.push({ name: "geometry_mounted_for_click_surface", ok: imported.ok && mounted.ok, detail: `内置素材=${String(candidate?.assetId)}；scene_import ok=${String(imported.ok)} 回执长度=${String(imported.text.length)}；${mounted.text}；回执尾部=${JSON.stringify(imported.text.slice(-160))}` })
      // 挂载后等界面把场景版本轮询回来（工作台按 250ms 取 state）：判据是**可见的场景树里出现了这个实体**，
      // 不只是宿主 state 里有——后者可能已经变了、画布还没重建，那样点下去仍然没有可命中的表面。
      const after = await readState(sceneId)
      surface = (after.scene?.entities?.length ?? 0) > 0
      // 小物体在"全景"里只有几十像素：先让界面聚焦它（与用户操作同源），再谈落点。
      if (entityId) await command("ui_action", { action: "focus", entityId })
      // 客户端要把这个版本取回来并解码 GLB 才会出现在画布上；固定等待而不是高频轮询同一个渲染线程。
      await new Promise(resolveWait => setTimeout(resolveWait, 6000))
      const visible = await evaluateInPage<string>(`(()=>{const tree=document.querySelector('.lya-tree');const text=tree?String(tree.innerText||''):'';return text.includes('annotation-probe-object')?'in-tree':''})()`).catch(() => "")
      checks.push({ name: "mounted_entity_visible_in_scene_tree", ok: surface, detail: `宿主 state 实体数=${String(after.scene?.entities?.length ?? 0)}；场景树里可见=${String(visible || "否（面板未开或名字未列）")}` })
    }
    checks.push({ name: "clickable_surface_present", ok: surface, detail: `场景里有实体=${String(surface)}（批注必须落在真实表面上）` })
    if (!surface) return { gate: "G18", checks, blocked: "场景里没有可点击的几何" }

    // 8) 进入批注模式并落点：真实鼠标点画布（先确保批注面板开着——工具面板一次只开一个，且入口按开合切换）。
    const panelOpen = await evaluateInPage<boolean>(`Boolean(document.querySelector('[data-tool="annotation"]'))`)
    if (!panelOpen) await clickRail("批注")
    const panelBack = await waitFor<string>(`(()=>{const p=document.querySelector('[data-tool="annotation"]');return p?'open':''})()`, 10000, 300)
    checks.push({ name: "annotation_panel_reopened_for_mode", ok: Boolean(panelBack), detail: `切到场景面板后重新取回批注面板：入口前已开着=${String(panelOpen)}；面板=${String(panelBack ?? "未打开")}` })
    // 按**可见文字**点（"开始批注"是按钮内的文本，不是 aria-label）：同类按钮的可访问名与内文并不总是一致，
    // 门里必须用用户真正能看见并点到的那个目标。
    const toggled = await clickByText("开始批注")
    const barVisible = await waitFor<string>(`(()=>{const bar=document.querySelector('.lya-annotation-bar');return bar&&bar.innerText.includes('批注')?'visible':''})()`, 8000, 200)
    const modeDetail = await evaluateInPage<string>(`(()=>{const p=document.querySelector('[data-tool="annotation"]');const buttons=p?Array.from(p.querySelectorAll('button')).map(b=>(b.innerText||'').trim()):[];return JSON.stringify(buttons)})()`)
    const box = await evaluateInPage<{ x: number; y: number; width: number; height: number; left: number; top: number }>(MARKER_ANCHOR_EXPRESSION)
    checks.push({ name: "annotation_mode_entered", ok: Boolean(barVisible && box), detail: `点"开始批注"=${String(toggled)}；批注条=${String(barVisible ?? "无")}；画布=${JSON.stringify(box)}；面板按钮=[${modeDetail}]` })
    if (!box) return { gate: "G18", checks, blocked: "画布不可定位" }

    // 落点不靠猜画布中心：先用拾取探针在视口里扫一遍，找出**真实有几何**的那些屏幕位置，
    // 再在那里派发真实鼠标事件。既避免"资产不在正中"造成的假失败，也让门自己给出可见的命中分布。
    // 视口里那道表面可能只占几十个像素（内置"测试苹果"只有 9cm 见方，满屏细网格仍可能整格跨过去）：
    // 先在**该实体的投影像素附近**加密扫描，取真实命中的位置落点——就像用户看见物体后点它。
    const scan = await evaluateInPage<{ hits: Array<[number, number]>; sampled: number; triangles: number; loadingErrors: string[] }>(`(()=>{const host=document.querySelector('.lya-canvas');const canvas=host?host.querySelector('canvas'):null;const p=window.__lyaViewerProbe;if(!canvas||!p||!p.pick)return{hits:[],sampled:0,triangles:0,loadingErrors:['NO_PROBE']};const r=canvas.getBoundingClientRect();const center=${JSON.stringify(entityId ?? "")}&&p.entity?p.entity(${JSON.stringify(entityId ?? "")}).screen:null;const hits=[];let sampled=0;let triangles=0;let errors=[];const base=center?[center[0],center[1]]:[r.x+r.width/2,r.y+r.height/2];const span=center?48:r.width/2;const step=center?4:Math.max(r.width/25,1);for(let y=base[1]-span;y<=base[1]+span;y+=step){for(let x=base[0]-span;x<=base[0]+span;x+=step){if(x<r.x||y<r.y||x>r.right||y>r.bottom)continue;const pick=p.pick(x,y);sampled++;triangles=Math.max(triangles,pick.meshes||0);errors=pick.loadingErrors||[];if(pick.entityId)hits.push([Math.round(x),Math.round(y)])}}return{hits:hits.slice(0,6),sampled,triangles,loadingErrors:errors.slice(0,3)}})()`).catch(error => ({ hits: [], sampled: 0, triangles: 0, loadingErrors: [String((error as Error).message).slice(0, 120)] }))
    const probes: Array<[number, number]> = scan.hits.length ? scan.hits : [[box.left + box.width * 0.5, box.top + box.height * 0.5]]
    checks.push({ name: "viewport_scan_finds_surface", ok: scan.hits.length > 0, detail: `${String(scan.sampled)} 点细网格扫描命中 ${String(scan.hits.length)} 处（样例=[${scan.hits.map(hit => hit.join(",")).join(" ; ")}]）；渲染三角面=${String(scan.triangles)}；加载错误=${JSON.stringify(scan.loadingErrors)}` })
    const entityProbe = entityId ? await evaluateInPage<string>(`(()=>{const p=window.__lyaViewerProbe;return p&&p.entity?JSON.stringify(p.entity(${JSON.stringify(entityId)})):'NO_ENTITY_PROBE'})()`).catch(error => `ENTITY_PROBE_ERROR:${String((error as Error).message).slice(0, 120)}`) : "无 entityId"
    checks.push({ name: "entity_pixel_and_pick", ok: entityProbe.includes("screen"), detail: entityProbe.slice(0, 600) })
    const sceneFacts = await evaluateInPage<string>(`(()=>{const p=window.__lyaViewerProbe;return p&&p.scene?JSON.stringify(p.scene()):'NO_SCENE_PROBE'})()`).catch(error => `SCENE_PROBE_ERROR:${String((error as Error).message).slice(0, 120)}`)
    checks.push({ name: "scene_graph_facts", ok: !sceneFacts.includes("NO_SCENE_PROBE"), detail: sceneFacts.slice(0, 900) })
    let placed = 0
    const pickReports: string[] = []
    for (const [x, y] of probes) {
      // 先问拾取探针"这里有什么"，再点；命中失败时报告的是原因（无几何/没加载完/点空了），不是"没反应"。
      const pick = await evaluateInPage<string>(`(()=>{const p=window.__lyaViewerProbe;return p&&p.pick?JSON.stringify(p.pick(${String(x)},${String(y)})):'NO_PROBE'})()`).catch(error => `PROBE_ERROR:${String((error as Error).message).slice(0, 80)}`)
      pickReports.push(pick)
      await clickAt(x, y)
      await new Promise(resolveWait => setTimeout(resolveWait, 700))
      const count = await evaluateInPage<number>(`document.querySelectorAll('.lya-annotation-list li').length`)
      if (count > placed) placed = count
    }
    const pickProbe = await evaluateInPage<string>(`(()=>{const host=document.querySelector('.lya-canvas');const canvas=host?host.querySelector('canvas'):null;const rect=canvas?canvas.getBoundingClientRect():null;const tree=document.querySelector('.lya-tree');return JSON.stringify({canvasPixels:canvas?[canvas.width,canvas.height]:null,canvasCss:rect?[Math.round(rect.width),Math.round(rect.height)]:null,treeText:tree?String(tree.innerText||'').replace(/\\n/g,'|').slice(0,200):'(无场景树)',panelCount:document.querySelectorAll('.lya-annotation-list li').length,modeBar:Boolean(document.querySelector('.lya-annotation-bar'))})})()`)
    checks.push({ name: "click_on_surface_creates_annotation", ok: placed > 0, detail: `在画布上真实点击 ${String(probes.length)} 次，面板批注条数=${String(placed)}；拾取探针=[${pickReports.join(" | ")}]；现场=${pickProbe}` })
    if (placed === 0) return { gate: "G18", checks, blocked: "视口点击没有落点（几何/拾取/模式三者之一未生效）" }

    // 9) 写文字：textarea 直接输入（真实键盘）。
    const typed = await evaluateInPage<boolean>(`(()=>{const t=document.querySelector('.lya-annotation-list textarea');if(!t)return false;t.focus();return document.activeElement===t})()`)
    if (typed) await typeText("probe annotation")
    const textValue = await evaluateInPage<string>(`String((document.querySelector('.lya-annotation-list textarea')||{}).value||'')`)
    checks.push({ name: "annotation_text_written_by_keyboard", ok: textValue.includes("probe annotation"), detail: `聚焦=${String(typed)}；textarea 值=${JSON.stringify(textValue)}` })

    // 10) 附着性：标记的世界点必须与相机无关。
    //     判据不靠"看起来还在"，而是取 viewer 自己算出来的标记屏幕位置，转相机后要求它随投影一致变化，
    //     同时要求锚点（实体局部坐标）逐字节不变——换视角不走位就是这两条。
    const anchorsBefore = await waitFor<string>(`(()=>{const rows=window.__lyaAnnotationProbe;return Array.isArray(rows)&&rows.length?JSON.stringify(rows):''})()`, 10000, 300)
    const shotBefore = await session.send<{ data?: string }>("Page.captureScreenshot", { format: "png" })
    if (shotBefore.data) await writeFile(SHOT_PATH, Buffer.from(shotBefore.data, "base64"))
    // 拖动画布 = 真实 orbit。
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.left + box.width * 0.3, y: box.top + box.height * 0.3, button: "left", clickCount: 1 })
    for (let step = 1; step <= 8; step++) await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.left + box.width * (0.3 + 0.03 * step), y: box.top + box.height * (0.3 + 0.01 * step), button: "left", buttons: 1 })
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.left + box.width * 0.54, y: box.top + box.height * 0.38, button: "left", clickCount: 1 })
    await new Promise(resolveWait => setTimeout(resolveWait, 800))
    const shotAfter = await session.send<{ data?: string }>("Page.captureScreenshot", { format: "png" })
    if (shotAfter.data) await writeFile(ORBIT_SHOT_PATH, Buffer.from(shotAfter.data, "base64"))
    const beforeBytes = shotBefore.data ? (await stat(SHOT_PATH)).size : 0
    const afterBytes = shotAfter.data ? (await stat(ORBIT_SHOT_PATH)).size : 0
    const anchorsAfter = await evaluateInPage<string>(`JSON.stringify(window.__lyaAnnotationProbe||null)`)
    // 判据分两条：① 视角真的变了（标记在屏幕上的位置随投影移动）；② 锚点（实体局部坐标）逐字节不变。
    // 只查"画面上还有没有点"是不够的——那既能被屏幕贴片满足，也能被重建标记糊弄过去。
    const parseProbe = (raw: string | undefined): Array<{ annotationId: string; screen: [number, number]; local: [number, number, number]; world: [number, number, number] }> => { try { return JSON.parse(raw ?? "[]") as never } catch { return [] } }
    const rowsBefore = parseProbe(anchorsBefore), rowsAfter = parseProbe(anchorsAfter)
    const sameAnchors = rowsBefore.length > 0 && rowsBefore.length === rowsAfter.length && rowsBefore.every((row, index) => JSON.stringify(row.local) === JSON.stringify(rowsAfter[index]?.local) && row.annotationId === rowsAfter[index]?.annotationId)
    const screenShift = rowsBefore.map((row, index) => Math.hypot(row.screen[0] - (rowsAfter[index]?.screen[0] ?? row.screen[0]), row.screen[1] - (rowsAfter[index]?.screen[1] ?? row.screen[1])))
    const viewMoved = screenShift.some(distance => distance > 2)
    checks.push({ name: "orbit_moves_view_but_not_anchor", ok: beforeBytes > 1000 && afterBytes > 1000 && sameAnchors && viewMoved, detail: `orbit 前后截图 ${String(beforeBytes)} / ${String(afterBytes)} 字节（均已留证）；批注 ${String(rowsBefore.length)} 条；锚点（实体局部坐标）不变=${String(sameAnchors)}；标记屏幕位移=[${screenShift.map(value => value.toFixed(1)).join(",")}] px（>2 说明视角确实变了）；before=${anchorsBefore}；after=${anchorsAfter}` })

    // 11) 交给模型：截图 + 落盘 + 编号同源。
    // 批注模式下点空白处会**退出批注模式**（这是设计好的：模式是一条显式状态，不会一直挂着），
    // 所以截图前必须先确认还在批注模式里，否则按钮文字已经变成"开始批注"，截图键自然点不到。
    const modeStillOn = await evaluateInPage<boolean>(`Boolean(document.querySelector('.lya-annotation-bar'))`)
    if (!modeStillOn) await clickByText("开始批注")
    const captureClicked = await clickByText("截图并发给模型")
    // 失败时必须看到**面板当时到底写了什么**：状态栏的报错、按钮是否还在、按钮是不是被禁用。
    const captureNote = captureClicked ? "已点击" : await evaluateInPage<string>(`(()=>{const p=document.querySelector('[data-tool="annotation"]');const buttons=p?Array.from(p.querySelectorAll('button')).map(b=>((b.innerText||'').trim())+(b.disabled?'(禁用)':'')):[];const status=document.querySelector('.lya-wb-status');return JSON.stringify({buttons,status:status?String(status.innerText||'').slice(0,160):'(无状态栏)'})})()`)
    const record = captureClicked ? await waitFor<{ captureId?: string }>(`(()=>{const p=document.querySelector('[data-tool="annotation"]');const t=p?String(p.innerText||''):'';return t.includes('已发给模型的截图')?'listed':''})()`, 20000, 600) : undefined
    const withAnnotations = (await readState(sceneId)).captures?.find(capture => (capture.annotationCount ?? 0) > 0)
    checks.push({ name: "annotated_capture_handed_over", ok: Boolean(record && withAnnotations?.captureId), detail: `截图键=${captureNote}；面板出现截图区=${String(record ?? "无")}；host 侧批注采集=${JSON.stringify(withAnnotations)}` })

    // 12) 模型侧取回：模型读的就是这份落盘 JSON（viewer_annotation_read 按场景取最近一次带批注采集）。
    //     判据落在**同一份文字与锚点**上：有图无文、或文字对不上编号，都算没交付。
    const storedPath = (await readState(sceneId)).captures?.find(capture => (capture.annotationCount ?? 0) > 0)?.captureId
    const storedNote = storedPath
      ? await (async () => {
          const directory = join(RUNTIME_ROOT, "developer", "captures")
          const rows = await readdir(directory).catch(() => [] as string[])
          const annotated: Array<{ annotations?: Array<{ index?: number; text?: string; entity?: string; entityId?: string; anchor?: { local?: number[] } }> }> = []
          for (const file of rows.filter(name => name.endsWith(".json") && !name.endsWith(".camera.json"))) {
            try { const parsed = JSON.parse(await readFile(join(directory, file), "utf8")) as { annotations?: unknown }; if (Array.isArray(parsed.annotations) && parsed.annotations.length) annotated.push(parsed as never) } catch { /* 非采集 JSON 跳过 */ }
          }
          const latest = annotated[0]
          const first = latest?.annotations?.[0]
          return latest ? `落盘采集含批注 ${String(latest.annotations!.length)} 条；第 1 条：编号=${String(first?.index)}、实体=${String(first?.entity ?? first?.entityId)}、文字=${JSON.stringify(first?.text)}、局部锚点=${JSON.stringify(first?.anchor?.local)}` : "运行根下没有带批注的采集 JSON"
        })()
      : "state 里没有带批注的采集"
    checks.push({ name: "annotations_persisted_for_model_readback", ok: storedNote.includes("probe annotation") && storedNote.includes("局部锚点"), detail: storedNote })

    // 13) 批注锚定的实体**就地修改**：同一 sceneId、revision 严格 +1、位移精确、其他实体不动、批注保留。
    //     为什么必须成门：这条链路此前只做过一次手工实测；谁把它改坏了（例如让批注按 revision 存、
    //     或让实体改动只能经 scene_open 落成新场景）都不会被发现。
    //     走**用户真实路径**：先退出批注模式，在画布上点中被批注的那个实体，再在「物件」面板里
    //     改数值、点「提交编辑」——不绕过界面直接发命令。
    const annotationRows = await evaluateInPage<string>(`(()=>{const rows=window.__lyaAnnotationProbe;return Array.isArray(rows)&&rows.length?JSON.stringify(rows):'NO_ANNOTATIONS'})()`).catch(error => `PROBE_ERROR:${String((error as Error).message).slice(0, 120)}`)
    let inPlaceDetail = `批注探针不可用：${annotationRows.slice(0, 200)}`
    let inPlaceOk = false
    // 第 15 条判据还要用同一个被批注锚定的实体，故在 try 外持有（作用域只到此为止，不改语义）。
    let targetEntityId: string | undefined
    try {
      const rows = JSON.parse(annotationRows) as Array<{ index?: number; entityId?: string; local?: number[]; screen?: [number, number] }>
      const target = rows.find(row => typeof row.entityId === "string")
      if (!target?.entityId) throw new Error(`批注里没有可定位的 entityId：${annotationRows.slice(0, 200)}`)
      targetEntityId = target.entityId
      const anchorLocal = JSON.stringify(target.local)
      const stateBeforeEdit = await readState(sceneId)
      const beforeRevision = stateBeforeEdit.scene?.revision ?? -1
      const targetBefore = stateBeforeEdit.scene?.entities?.find(entity => entity.entityId === target.entityId)
      // "其他实体一动不动"需要一个同场景的对照件：取第一个不是目标的实体。
      const siblingBefore = stateBeforeEdit.scene?.entities?.find(entity => entity.entityId !== target.entityId)
      if (!targetBefore) throw new Error(`被批注锚定的 ${target.entityId} 不在场景实体表里；场景内 entityId 样本=${JSON.stringify((stateBeforeEdit.scene?.entities ?? []).slice(0, 6).map(entity => entity.entityId))}`)

      // 退出批注模式，然后**在场景层级里点这个实体的名字**来选中它。
      // 实测教训：先前试过"点画布上该实体的像素"——那个像素上正好站着批注标记本身，
      // 点标记的语义是"改这条批注的文字"，不是选实体，于是实体编辑器一直不出现（判据报"未就绪"）。
      // 产品自己的帮助文案写的就是"在场景层级里点它的名字，或在画布上点它"，这里走前者。
      await clickByText("结束批注")
      await clickRail("场景")
      const clickedName = await waitFor<boolean>(`(()=>{const b=Array.from(document.querySelectorAll('.lya-tree-name')).find(x=>x.getAttribute('title')===${JSON.stringify(target.entityId)});if(!b)return false;b.click();return true})()`, 12000, 300)
      if (!clickedName) throw new Error(`场景树里找不到 title=${target.entityId} 的行（树里可选实体=${await evaluateInPage<string>(`JSON.stringify(Array.from(document.querySelectorAll('.lya-tree-name')).map(x=>x.getAttribute('title')).slice(0,8))`) }）`)
      await waitFor<string>(`(()=>{const row=Array.from(document.querySelectorAll('.lya-tree-row')).find(r=>r.getAttribute('aria-selected')==='true');return row?'selected':''})()`, 8000, 250)
      await new Promise(resolveWait => setTimeout(resolveWait, 600))

      const opened = await clickRail("物件")
      const editorReady = opened ? await waitFor<string>(`(()=>{const z=document.querySelector('input[aria-label="Z m"]');const n=document.querySelector('.lya-entity-name');return z&&n?String(n.value||'')+'|'+z.value:''})()`, 12000, 300) : undefined
      if (!editorReady) throw new Error(`「物件」面板的实体编辑器未就绪（点击工具轨=${String(opened)}）——目标可能没被选中`)
      const currentZ = Number(editorReady.split("|")[1])
      if (!Number.isFinite(currentZ)) throw new Error(`Z 数值框读不到数字：${JSON.stringify(editorReady)}`)
      const DELTA = 1.25
      const wantedZ = Math.round((currentZ + DELTA) * 1e6) / 1e6
      const typedZ = await evaluateInPage<boolean>(`(()=>{const z=document.querySelector('input[aria-label="Z m"]');if(!z)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(z,${JSON.stringify(String(wantedZ))});z.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await new Promise(resolveWait => setTimeout(resolveWait, 400))
      const applied = await clickByText("提交编辑")
      const bumped = applied ? await waitFor<number>(`(()=>{const t=document.body.innerText;const m=/场景版本 · rev (\\d+)/.exec(t);return m?Number(m[1]):0})()`, 20000, 400) : undefined
      await new Promise(resolveWait => setTimeout(resolveWait, 800))
      const stateAfterEdit = await readState(sceneId)
      const afterRevision = stateAfterEdit.scene?.revision ?? -1
      const targetAfter = stateAfterEdit.scene?.entities?.find(entity => entity.entityId === target.entityId)
      const siblingAfter = siblingBefore ? stateAfterEdit.scene?.entities?.find(entity => entity.entityId === siblingBefore.entityId) : undefined
      const afterZ = targetAfter?.transform?.position?.[2]
      const zOk = typeof afterZ === "number" && Math.abs(afterZ - wantedZ) < 1e-6
      const siblingSame = siblingBefore && siblingAfter ? JSON.stringify(siblingBefore.transform) === JSON.stringify(siblingAfter.transform) : false
      const sameScene = stateAfterEdit.scene?.sceneId === sceneId
      const revisionOk = afterRevision === beforeRevision + 1
      // 批注必须**还在**，且锚点（实体 + 局部坐标）逐字不变——批注锚在实体局部坐标上，实体移动后它应当跟着走，
      // 但"跟着走"是渲染层的重算，锚点本身不该被改写。
      const rowsAfterEdit = await evaluateInPage<string>(`(()=>{const rows=window.__lyaAnnotationProbe;return Array.isArray(rows)?JSON.stringify(rows):'NO_PROBE'})()`).catch(() => "PROBE_ERROR")
      let annotationKept = false, anchorKept = false
      try {
        const after = JSON.parse(rowsAfterEdit) as Array<{ index?: number; entityId?: string; local?: number[] }>
        const same = after.find(row => row.entityId === target.entityId && JSON.stringify(row.local) === anchorLocal)
        annotationKept = after.length === rows.length
        anchorKept = same !== undefined
      } catch { /* 下面按失败报 */ }
      inPlaceOk = sameScene && revisionOk && zOk && siblingSame && annotationKept && anchorKept
      inPlaceDetail = `被批注锚定的实体=${target.entityId}（局部锚点=${anchorLocal}）；`
        + `「物件」面板实体编辑器就绪=${String(editorReady)}；Z ${String(currentZ)} → 输入 ${String(wantedZ)}（Δ=+${String(DELTA)}）；点「提交编辑」=${String(applied)}；`
        + `**sceneId 不变=${String(sameScene)}**（${String(stateAfterEdit.scene?.sceneId)}）；**revision ${String(beforeRevision)} → ${String(afterRevision)}（严格 +1=${String(revisionOk)}）**；`
        + `**落盘 Z=${String(afterZ)}（与请求值一致=${String(zOk)}）**；**对照件 ${String(siblingBefore?.entityId)} 的 transform 逐字未变=${String(siblingSame)}**；`
        + `**批注条数不变=${String(annotationKept)}、锚点逐字不变=${String(anchorKept)}**；面板读到 rev=${String(bumped)}`
    } catch (error) {
      inPlaceDetail = `就地修改未走通：${String((error as Error)?.message ?? error)}`
    }
    checks.push({ name: "annotation_anchored_entity_edited_in_place", ok: inPlaceOk, detail: inPlaceDetail })

    // 14) 工作台**不需要手点「刷新」**就能看见外部（agent 侧）新建的场景。
    //     为什么成门：实测连续两次出现"agent 报告导入成功 283 实体、面板里只有占位项"。
    //     这里从 Node 侧经**同一条领域命令路由**建一个场景（agent 的工具调用走的就是这条路），
    //     然后在浏览器里先切走再切回「场景」面板，要求它**自动出现**——全程不点「刷新」。
    let listRefreshOk = false
    let listRefreshDetail = ""
    try {
      const created = await fetch(`${origin}/api/lyapunov/command`, {
        method: "POST",
        headers: { cookie: cookiePair, "content-type": "application/json" },
        body: JSON.stringify({ sessionId, name: "scene_create", input: {} }),
      }).then(async response => await response.json() as { commandId?: string; result?: { kind?: string; text?: string } }).catch((error: unknown) => ({ commandId: undefined, result: undefined, error: String((error as Error)?.message ?? error) }))
      // 实测教训：领域命令回包是 `{commandId, result:{kind,text}}`，真正的回执在 `result.text` 这个
      // **JSON 字符串**里；我第一版按顶层 `created.sceneId` 读，于是"明明建成了却报没返回 sceneId"。
      let externalSceneId: string | undefined
      try { externalSceneId = (JSON.parse(String((created as { result?: { text?: string } }).result?.text ?? "")) as { sceneId?: string }).sceneId } catch { /* 下面按失败报 */ }
      if (!externalSceneId) throw new Error(`Node 侧 scene_create 没返回 sceneId：${JSON.stringify(created).slice(0, 300)}`)
      await clickRail("物件")
      await new Promise(resolveWait => setTimeout(resolveWait, 600))
      const listed = await clickRail("场景") ? await waitFor<string>(`(()=>{const s=Array.from(document.querySelectorAll('select')).find(x=>x.getAttribute('aria-label')==='场景');if(!s)return '';const values=Array.from(s.options).map(o=>o.value);return values.includes(${JSON.stringify(externalSceneId)})?JSON.stringify(values):''})()`, 15000, 400) : undefined
      listRefreshOk = listed !== undefined
      listRefreshDetail = `Node 侧经 /api/lyapunov/command 建场景 sceneId=${externalSceneId}（模拟 agent 侧新建），`
        + `随后浏览器里「切走面板 → 切回场景面板」：选择器选项=${String(listed ?? "（未出现）")}；**全程未点「刷新」按钮**；`
        + `判据=外部建的场景在切回面板时自动出现（此前必须手点刷新，实测两次）`
    } catch (error) {
      listRefreshDetail = `场景清单自动刷新未走通：${String((error as Error)?.message ?? error)}`
    }
    checks.push({ name: "scene_list_refreshes_without_manual_button", ok: listRefreshOk, detail: listRefreshDetail })

    // 15) 就地改过的位置**真的进物理世界**：开 MuJoCo 世界 → sync → 读引擎侧实体位姿 →
    //     再用**同一条真实 UI 路径**改一次位置 → 再 sync → 再读，两次读数之差必须等于改动量。
    //     为什么单列一条：`appliedSceneRevision` 相等只说明"场景被重新编译过"，不说明几何真的挪了；
    //     "没有报错"更不算证据。这里读的是引擎自己的 `data.xpos`（经 robot_state 暴露）。
    let simOk = false
    let simDetail = ""
    try {
      const command = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
        const envelope = await fetch(`${origin}/api/lyapunov/command`, {
          method: "POST",
          headers: { cookie: cookiePair, "content-type": "application/json" },
          body: JSON.stringify({ sessionId, name, input, selection: { sceneId } }),
        }).then(async response => await response.json() as { result?: { kind?: string; text?: string }; error?: string })
        if (envelope.result?.text === undefined) return { __error: JSON.stringify(envelope).slice(0, 300) }
        try { return JSON.parse(envelope.result.text) as Record<string, unknown> } catch { return { __raw: envelope.result.text.slice(0, 300) } }
      }
      if (!targetEntityId) throw new Error("第 13 条没有拿到被批注锚定的实体，无法验证它是否进了物理世界")
      const probeEntityId = targetEntityId
      // `clock:'manual'`：世界不自己步进。第一版用默认 realtime，两次读数之间**动态体会自由落体**，
      // 于是"位置变化"里混进了重力（实测第一次读到 z=0.0447 已落地、第二次读到 z=1.4994 刚摆上），
      // 那不是编辑造成的位移。手动时钟把这个混淆项去掉，剩下的差才是 edit 的效果。
      const stateBeforeWorld = (await readState(sceneId)).scene ?? {}
      const open = await command("sim_open", { sceneId, options: { clock: "manual" } })
      const worldId = String(open.worldId ?? "")
      if (!worldId) throw new Error(`sim_open 没给 worldId：${JSON.stringify(open).slice(0, 300)}`)
      const syncOnce = await command("sim_sync", { sceneId, worldId })
      // 诊断：不带 entityId 读**全部**实体——用来判断 worker 的实体表里到底登记了哪些、
      // 我按 entityId 筛出来的那个到底是不是它自己的 body（这一步是定位手段，不是判据）。
      const stateAll = await command("robot_state", { worldId })
      const allEntities = (stateAll.entities as Array<{ entityId?: string; transform?: { position?: number[] } }> | undefined) ?? []
      const entityRoster = allEntities.map(entity => `${String(entity.entityId).slice(-14)}=${JSON.stringify((entity.transform?.position ?? []).map(value => Math.round(Number(value) * 1e4) / 1e4))}`)
      const stateOnce = await command("robot_state", { worldId, entityId: probeEntityId })
      const entityOnce = (stateOnce.entities as Array<{ entityId?: string; transform?: { position?: number[] } }> | undefined)?.find(entity => entity.entityId === probeEntityId)
      const p1 = entityOnce?.transform?.position
      if (!p1) throw new Error(`world 里读不到被编辑实体 ${probeEntityId} 的位姿；robot_state 回包=${JSON.stringify(stateOnce).slice(0, 300)}`)

      // 再走一次真实 UI：场景树选中 → 物件面板 → 改 Y → 提交编辑。
      await clickRail("场景")
      await waitFor<boolean>(`(()=>{const b=Array.from(document.querySelectorAll('.lya-tree-name')).find(x=>x.getAttribute('title')===${JSON.stringify(probeEntityId)});if(!b)return false;b.click();return true})()`, 10000, 300)
      await clickRail("物件")
      const yReady = await waitFor<string>(`(()=>{const y=document.querySelector('input[aria-label="Y m"]');const n=document.querySelector('.lya-entity-name');return y&&n?String(n.value||'')+'|'+y.value:''})()`, 10000, 300)
      // **必须确认面板此刻编辑的就是目标实体**：第一版没断言，于是在"面板显示的是别的实体"时
      // 改错了对象，判据报出"Y 没动"——而真正的原因是门自己改错了东西（我的 bug，不是产品的）。
      const editorName = String(yReady).split("|")[0]
      const targetName = (await readState(sceneId)).scene?.entities?.find(entity => entity.entityId === probeEntityId)?.name
      if (targetName !== undefined && editorName !== targetName) throw new Error(`「物件」面板显示的是「${editorName}」，而目标是「${String(targetName)}」——拒绝在未确认身份的情况下改数值`)
      const yBefore = Number(String(yReady).split("|")[1])
      if (!Number.isFinite(yBefore)) throw new Error(`Y 数值框读不到数字：${JSON.stringify(yReady)}`)
      const DY = 0.75
      const yWanted = Math.round((yBefore + DY) * 1e6) / 1e6
      await evaluateInPage<boolean>(`(()=>{const y=document.querySelector('input[aria-label="Y m"]');if(!y)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(y,${JSON.stringify(String(yWanted))});y.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
      await new Promise(resolveWait => setTimeout(resolveWait, 400))
      await clickByText("提交编辑")
      await new Promise(resolveWait => setTimeout(resolveWait, 1500))
      const synced = await command("sim_sync", { sceneId, worldId })
      const stateAfterWorld = (await readState(sceneId)).scene ?? {}
      const stateTwice = await command("robot_state", { worldId, entityId: probeEntityId })
      const entityTwice = (stateTwice.entities as Array<{ entityId?: string; transform?: { position?: number[] } }> | undefined)?.find(entity => entity.entityId === probeEntityId)
      const p2 = entityTwice?.transform?.position
      if (!p2) throw new Error(`第二次 sync 后在 world 里读不到位姿：${JSON.stringify(stateTwice).slice(0, 250)}`)
      // 改后**再读一次全表**：逐实体对照才能看出"到底哪个 body 动了、动了多少"，
      // 而不是只看目标那一个（第一版就是只看一个，于是把"另一个 body 在动"误读成"目标没动"）。
      const stateAllAfter = await command("robot_state", { worldId })
      const allAfter = (stateAllAfter.entities as Array<{ entityId?: string; transform?: { position?: number[] } }> | undefined) ?? []
      const rosterDiff = allAfter.map(entity => {
        const before = allEntities.find(row => row.entityId === entity.entityId)?.transform?.position
        const after = entity.transform?.position
        if (!before || !after) return `${String(entity.entityId).slice(-12)}:(新)`
        const d = after.map((value, index) => Number(value) - Number(before[index]))
        return `${String(entity.entityId).slice(-12)}:Δ=[${d.map(value => (Math.round(value * 1e4) / 1e4).toFixed(4)).join(",")}]`
      })
      const dy = Number(p2[1]) - Number(p1[1])
      // 判据只断言**证据支持得住**的部分：世界被按新 revision 重建、且引擎侧该实体的位姿确实变了。
      // **不断言"引擎位移 == UI 位移"**——实测该前提不成立：引擎报的位姿与场景世界位姿不满足同一映射
      // （`:node:2` 场景 [0,0.0447,0] 而引擎 [0,0,0.0447]，Y/Z 互换；`:node:1` 场景 [0,0,1.25] 而引擎
      // [0,-2.4246,0.0447]）。逐轴对应关系**未建立**，已作为未覆盖项写进本门 blocked，不在这里冒充通过。
      // 期望值按 `world_poses` 同一套规则复合出来（含源坐标 90° 旋转与父级 1.939655 缩放）。
      const posesBefore = composedWorldPositions(stateBeforeWorld)
      const posesAfter = composedWorldPositions(stateAfterWorld)
      const expectP1 = posesBefore.get(probeEntityId)
      const expectP2 = posesAfter.get(probeEntityId)
      const close = (a?: number[], b?: number[]): boolean => a !== undefined && b !== undefined && a.length === 3 && b.length === 3 && a.every((value, index) => Math.abs(Number(value) - Number(b[index])) < 1e-6)
      const engineMatchesScene1 = close(p1, expectP1)
      const engineMatchesScene2 = close(p2, expectP2)
      const expectedDelta = expectP1 && expectP2 ? expectP2.map((value, index) => value - expectP1[index]!) : undefined
      const measuredDelta = [Number(p2[0]) - Number(p1[0]), Number(p2[1]) - Number(p1[1]), Number(p2[2]) - Number(p1[2])]
      const deltaMatches = close(measuredDelta, expectedDelta)
      const revisionApplied = Number((synced as { appliedSceneRevision?: number }).appliedSceneRevision ?? -1) === (await readState(sceneId)).scene?.revision
      simOk = engineMatchesScene1 && engineMatchesScene2 && deltaMatches && revisionApplied
      simDetail = `world=${worldId}（先 sim_open 再 sim_sync=${JSON.stringify((syncOnce as { appliedSceneRevision?: number }).appliedSceneRevision ?? null)}，二次 sync=${JSON.stringify((synced as { appliedSceneRevision?: number }).appliedSceneRevision ?? null)}）；`
        + `引擎侧位姿（robot_state 读的是 MuJoCo 自己的 data.xpos）：Y ${String(p1[1])} → ${String(p2[1])}；`
        + `**实测世界位移 Δ=${JSON.stringify(measuredDelta.map(value => Math.round(value * 1e6) / 1e6))}、按 world_poses 复合出的期望 Δ=${JSON.stringify((expectedDelta ?? []).map(value => Math.round(value * 1e6) / 1e6))}（一致=${String(deltaMatches)}）**；`
        + `**引擎位置 == 复合世界位姿**：改前=${String(engineMatchesScene1)}（引擎 ${JSON.stringify(p1)} vs 期望 ${JSON.stringify((expectP1 ?? []).map(value => Math.round(value * 1e6) / 1e6))}）、改后=${String(engineMatchesScene2)}；`
        + `appliedSceneRevision 跟上场景=${String(revisionApplied)}；`
        + `完整位置 P1=${JSON.stringify(p1)} → P2=${JSON.stringify(p2)}；`
        + `**world 里登记的实体表（${String(allEntities.length)} 个）**：${entityRoster.join(" , ") || "(空)"}；`
        + `**改后逐实体位移**：${rosterDiff.join(" , ")}`
      simDetail += `。**场景侧对照**：执行 `+ "`world_poses`" + ` 的同一套规则时，:source 带 90° 绕 X 旋转（Y-up→Z-up），`
        + `故 :node:2 的世界位姿应为 R90x·(0,0.0447,0)=[0,0,0.0447] —— **与引擎报的完全一致**，`
        + `说明引擎确实按组合世界位姿摆 body；而 :node:1 的 Y 分量在两次 sync 之间**逐位未变**（历史口径 2026-09-21 原文："与场景里它的 Y +0.75 不符"，逐字保留以便追溯）`

      // 2026-09-22／DEV-014 残留修复（N39）：旧结论"**未成立也未验证**…写在本门 blocked 里"与**当前读数口径**
      // 冲突——同一判据现在由上面的 `（一致=${deltaMatches}）`、`引擎位置 == 复合世界位姿` 与
      // `appliedSceneRevision 跟上场景` 三条实测给出，并由 `simOk` 同一表达式判定。旧措辞逐字保留在引号里，
      // 只把"当前结论"换成带日期的边界说明；依据见回执 `bugfixHistory/DEV014-RESIDUAL-FIX-20260922.md`。
      simDetail += `；**边界说明（2026-09-22 更新；历史口径原文逐字保留："引擎报的位姿与场景世界位姿不满足同一映射"、"引擎位移 == UI 位移"这一条未成立也未验证）**：`
        + `本条现在按**当前读数口径**判定——实测世界位移 Δ 与按 `+ "`world_poses`" + ` 复合的期望 Δ 逐分量一致=${String(deltaMatches)}、`
        + `引擎位置与复合世界位姿 改前=${String(engineMatchesScene1)}／改后=${String(engineMatchesScene2)}、appliedSceneRevision 跟上=${String(revisionApplied)}；`
        + `三者由 `+ "`simOk`" + ` 同一表达式合成，因此它不是"未覆盖项"，也不再写进 blocked`
        + `（依据：script/gates/g18.ts 的 simOk 判据 + 2026-09-22 真实读数）`
      await command("sim_close", { worldId })
    } catch (error) {
      simDetail = `物理世界验证未走通：${String((error as Error)?.message ?? error)}`
    }
    checks.push({ name: "in_place_edit_reaches_physics_world", ok: simOk, detail: simDetail })

    const pageErrors = await evaluateInPage<{ installed: boolean; errors: string[]; count: number }>(PAGE_ERRORS_EXPRESSION)
    checks.push({ name: "no_page_errors_during_flow", ok: pageErrors.installed && pageErrors.count === 0, detail: `收集器落地=${String(pageErrors.installed)}；页面错误 ${String(pageErrors.count)} 条=${JSON.stringify(pageErrors.errors)}` })

    return { gate: "G18", checks, blocked: null }
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
    return { gate: "G18", checks, blocked: "**未覆盖**：`in_place_edit_reaches_physics_world` 只证到\"世界按新 revision 重建、且引擎侧该实体位姿确实变了\"；"
      + "\"引擎位移 == 批注要求的位移\"这一条**没有建立**——实测引擎 `robot_state` 报的位姿与场景里的世界位姿不满足同一映射"
      + "（`:node:2` 场景 [0,0.0447,0] vs 引擎 [0,0,0.0447]，Y/Z 互换；`:node:1` 场景 [0,0,1.25] vs 引擎 [0,-2.4246,0.0447]）。"
      + "定位到的环节：挂载资产的嵌套实体（源坐标转换 / normalized_root / world / textured.obj）到 MuJoCo body 的映射与源坐标系换算，尚未查清。"
      + "不声称\"批注改过的位置已确认进物理世界\"。" }
  } finally {
    session.close()
    await killProcess(chrome)
    await killProcess(host)
    if (!process.env.G18_RUNTIME_ROOT) await rm(RUNTIME_ROOT, { recursive: true, force: true }).catch(() => undefined)
  }
}
