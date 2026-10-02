/**
 * BASE-SERVED-ROOT-MISMATCH 回归（F1／F2／F3，2026-09-26）。
 *
 * 病（`bugfixHistory/DEV032-UI-LEVEL-CU-20260926.md` §4 F1，界面级真机读数）：页面写
 * `<base href="http://127.0.0.1:44139/product/">`，而素材在**服务实际根**那一棵树里、
 * 页面在**另一棵树**里。于是同一块计划里同时出现：
 *   ① `素材服务：ready` + 复核命令 `curl … → HTTP/1.1 206`（**探的就是这张图**）；
 *   ② `缺件：media/libero-after.png`（来自 `existsSync(页面目录 + /product/…)`）；
 *   ③ `影响：…（服务再好也补不上）`。
 * 而浏览器**真的把图加载了**（帧内 `img.naturalWidth=128`、服务端 `GET … 206/200`）。
 *
 * 根因：**存在性问的树 ≠ 浏览器问的树**。`planHtmlOpen` 在 `auto` 模式下把服务根回退成
 * `pageDir`，`<base>` 指向的服务跟这个目录没有任何关系 ⇒ 本地找不到只能说明"映射错了树"，
 * 不能说明"素材不存在"。
 *
 * 本文件守三件事（都是"读数不许说反"）：
 *  1. **问对根**：服务根未知时，存在性只由**服务端实测**回答（GET 的 URL 与浏览器逐个相同）；
 *     本地文件系统只在"服务根已被声明或已实测证明"时才作数。
 *  2. **结构性不变式**：同一块计划里 `assetService.state === "ready"` ⇒ `missing` 与 `outsideRoot`
 *     都为空（"服务就绪"与"缺件"不许同时出现）。
 *  3. 两个方向的负对照：**真缺件仍必须报缺件**（含"本机有诱饵、服务端没有"这一侧）；
 *     **真存在不许报缺件**。
 *
 * 诚实边界：这里跑的是**真回环 HTTP**（`Bun.serve` + 真 fetch）与注入替身两种；**没有**跑
 * DEV032 那套界面级串（真 Chrome + 真宿主 + 真 `Demo/tools/media-server.py`）——那一份证据在
 * `bugfixHistory/BASE-SERVED-ROOT-MISMATCH-20260926.md` 的复核段里。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planHtmlOpen, planHtmlPreview, probeAssetServer, probeHtmlPreviewFacts, type HtmlAssetServerState } from "../src/html-preview-entry.ts"

const cleanups: string[] = []
afterEach(() => { for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true }) })

function site(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(root)
  return root
}

function file(root: string, relative: string, bytes: string | Uint8Array): string {
  const path = join(root, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/** F1 的形态：页面在自己的树里，`<base>` 指向**另一棵树**上的服务根；两张图一有一无。 */
const BASE_PAGE = (origin: string) => `<!doctype html><html><head><meta charset="utf-8">
<base href="${origin}/product/"></head><body>
<img src="media/on-server.png"><img src="media/not-on-server.png"></body></html>`

/** 真回环静态服务（不是替身）：根 = 传入的那个目录，只服务 `/product/**`。 */
function serveRoot(root: string): { origin: string; stop: () => void; log: string[] } {
  const log: string[] = []
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async request => {
      const path = new URL(request.url).pathname
      log.push(path)
      const target = join(root, path.replace(/^\//, ""))
      const bunFile = Bun.file(target)
      if (!path.startsWith("/product/") || !(await bunFile.exists())) return new Response("not found", { status: 404 })
      return new Response(bunFile, { status: request.headers.get("range") === null ? 200 : 206, headers: { "accept-ranges": "bytes" } })
    },
  })
  return { origin: `http://127.0.0.1:${String(server.port)}`, stop: () => { server.stop(true) }, log }
}

describe("F1 · <base> 指向的服务根与页面目录是两棵树（存在性必须问对根）", () => {
  test("真回环 HTTP：素材在服务根里 ⇒ 不许报缺件，判定为就绪", async () => {
    const pageTree = site("w10-root-page-")      // 页面所在的树（工作区）
    const serverTree = site("w10-root-server-")  // 服务实际根（另一棵树）
    file(serverTree, "product/media/on-server.png", "png-bytes")
    const server = serveRoot(serverTree)
    try {
      const page = file(pageTree, "fixture/base.html", '<!doctype html><html><head><meta charset="utf-8">\n<base href="' + server.origin + '/product/"></head><body><img src="media/on-server.png"></body></html>')
      const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto" })

      // ① 浏览器真的能取到（服务端 200/206）——这是"图会显示"的那一棵树。
      expect(server.log).toContain("/product/media/on-server.png")
      // ② 计划块里不许出现"缺件"（旧的错读数：existsSync(页面目录 + /product/media/on-server.png) = false）
      expect(plan.assetService.missing).toEqual([])
      expect(plan.summary).not.toContain("缺件")
      expect(plan.wording.join("\n")).not.toContain("在本机不存在")
      // ③ 服务行在、预览就绪、不是"服务再好也补不上"那种反向话术
      expect(plan.assetService.state).toBe("ready")
      expect(plan.preview.row.status).toBe("ready")
      expect(plan.preview.row.state).toBe("with-assets")
      // ④ 服务根未知这件事**要显式报出来**，而不是悄悄拿页面目录顶替
      expect(plan.assetService.rootKnown).toBe(false)
      expect(plan.assetService.root).toBeNull()
      expect(plan.assetService.checks.join("\n")).toContain("服务根**未确定**")
      // 旧写法是**断言**一棵没量过的树："根 = 页面所在目录（当前：<pageDir>）"。
      expect(plan.assetService.checks.join("\n")).not.toContain("根 = 页面所在目录（当前：")
      expect(plan.wording.join("\n")).toContain("不拿页面目录顶替")
    } finally { server.stop() }
  })

  test("存在性的依据是**服务端实测**（不是本机文件系统）——依据看得见", async () => {
    const pageTree = site("w10-root-page-")
    const serverTree = site("w10-root-server-")
    file(serverTree, "product/media/on-server.png", "x")
    const server = serveRoot(serverTree)
    try {
      const page = file(pageTree, "fixture/base.html", '<!doctype html><html><head><base href="' + server.origin + '/product/"></head><body><img src="media/on-server.png"></body></html>')
      const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto" })
      expect(plan.preview.row.evidence.join("\n")).toContain("服务端实测")
      expect(plan.preview.row.evidence.join("\n")).toContain("URL = 浏览器要取的那一个")
      // 页面目录那棵树上**没有**这张图（这就是旧代码会答成"缺件"的原因）。
      expect(plan.assetService.missing).toEqual([])
    } finally { server.stop() }
  })

  test("注入替身（离线）：同一形态下 206 ⇒ 就绪、404 ⇒ 缺件，且 URL 逐个都是浏览器要取的那个", async () => {
    const pageTree = site("w10-root-page-")
    const page = file(pageTree, "fixture/base.html", BASE_PAGE("http://127.0.0.1:44139"))
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      return new Response(null, { status: url.endsWith("/product/media/on-server.png") ? 206 : 404 })
    }) as unknown as typeof fetch
    const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto", probe: { fetchImpl } })
    expect(seen.every(url => url.startsWith("http://127.0.0.1:44139/product/"))).toBe(true)
    expect(plan.assetService.missing).toEqual(["media/not-on-server.png"])
    expect(plan.assetService.state).toBe("degraded")          // 缺件 ⇒ 服务行不许再说"就绪"
    expect(plan.preview.row.state).toBe("assets-missing")
  })
})

describe("负对照① · 真缺件仍必须报缺件（两个方向都不许说反）", () => {
  test("服务端 404 ⇒ 报缺件，且依据写明是**服务端**回的 404", async () => {
    const pageTree = site("w10-root-page-")
    const serverTree = site("w10-root-server-")   // 故意什么也不放
    const server = serveRoot(serverTree)
    try {
      const page = file(pageTree, "fixture/base.html", '<!doctype html><html><head><base href="' + server.origin + '/product/"></head><body><img src="media/gone.png"></body></html>')
      const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto" })
      expect(plan.assetService.missing).toEqual(["media/gone.png"])
      expect(plan.preview.row.state).toBe("assets-missing")
      expect(plan.preview.row.reading).toContain("在素材服务上**取不到**")
      expect(plan.preview.row.evidence.join("\n")).toContain("服务端 HTTP 404")
      expect(plan.preview.row.impact).toContain("服务端已经在回答")
      // 这一条**不是**"本机不存在"：文件可能在别的地方，只是这个服务给不出来。
      expect(plan.preview.row.reading).not.toContain("在本机不存在")
    } finally { server.stop() }
  })

  test("本机在**页面目录那棵树**上有一份诱饵文件，服务端却没有 ⇒ 仍然报缺件（旧代码会答成“素材在”）", async () => {
    const pageTree = site("w10-root-page-")
    const serverTree = site("w10-root-server-")
    // 诱饵：正是旧代码会去 existsSync 的那个落点（页面目录 + /product/media/…）。
    file(pageTree, "fixture/product/media/decoy.png", "this file exists locally but the browser will never get it")
    const server = serveRoot(serverTree)
    try {
      const page = file(pageTree, "fixture/base.html", '<!doctype html><html><head><base href="' + server.origin + '/product/"></head><body><img src="media/decoy.png"></body></html>')
      const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto" })
      expect(plan.assetService.missing).toEqual(["media/decoy.png"])
      expect(plan.preview.row.state).toBe("assets-missing")
      expect(plan.preview.row.evidence.join("\n")).toContain("404")
      // 页面目录里那份诱饵不许被当成"素材在"。
      expect(plan.summary).not.toContain("素材在，素材在")
      expect(plan.preview.row.status).not.toBe("ready")
    } finally { server.stop() }
  })

  test("复核命令不许挂在一个刚判过 404 的素材上（`→ 期望 206` 与 404 是自相矛盾的一对）", async () => {
    const pageTree = site("w10-root-page-")
    const serverTree = site("w10-root-server-")
    file(serverTree, "product/media/good.png", "x")
    const server = serveRoot(serverTree)
    try {
      const page = file(pageTree, "fixture/base.html", '<!doctype html><html><head><base href="' + server.origin + '/product/"></head><body><img src="media/gone.png"><img src="media/good.png"></body></html>')
      const plan = await planHtmlOpen({ filePath: page, displayPath: "fixture/base.html", assetServer: "auto" })
      expect(plan.assetService.missing).toEqual(["media/gone.png"])
      expect(plan.assetService.recheck.how).not.toContain("gone.png")
      expect(plan.assetService.recheck.how).toContain("good.png")
    } finally { server.stop() }
  })

  test("服务根**已知**时仍走本地文件系统：本机缺文件 ⇒ 缺件（原行为不许被这次改动改掉）", async () => {
    const root = site("w10-root-known-")
    file(root, "media/present.png", "x")
    const page = file(root, "index.html", '<!doctype html><html><body><img src="media/present.png"><img src="media/absent.png"></body></html>')
    const server: HtmlAssetServerState = { kind: "static-service", origin: "http://127.0.0.1:44139", root, reachable: true, rangeSupported: true, probedAt: 1, detail: "可达且支持 Range（206）" }
    const plan = await planHtmlOpen({
      filePath: page, serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => new Response(null, { status: 206 })) as unknown as typeof fetch },
    })
    expect(plan.assetService.rootKnown).toBe(true)
    expect(plan.assetService.missing).toEqual(["media/absent.png"])
    expect(plan.preview.row.evidence.join("\n")).toContain("（不存在）")   // 依据仍是本机文件系统
    expect(server.reachable).toBe(true)
  })
})

describe("负对照② · 真存在不许报缺件", () => {
  test("同树布局（页面在服务根内、经 <base> 提供素材）⇒ 无缺件、就绪", async () => {
    const root = site("w10-root-same-")
    file(root, "product/media/a.png", "x")
    const page = file(root, "产品介绍.html", '<!doctype html><html><head><base href="http://127.0.0.1:44139/product/"></head><body><img src="media/a.png"></body></html>')
    const plan = await planHtmlOpen({
      filePath: page, serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => new Response(null, { status: 206 })) as unknown as typeof fetch },
    })
    expect(plan.assetService.missing).toEqual([])
    expect(plan.preview.row.status).toBe("ready")
    expect(plan.assetService.state).toBe("ready")
  })

  test("没探过（调用方关掉探测）⇒ 存在性如实留“未判”，**不许**写成缺件", async () => {
    const pageTree = site("w10-root-page-")
    const page = file(pageTree, "fixture/base.html", BASE_PAGE("http://127.0.0.1:44139"))
    let calls = 0
    const plan = await planHtmlOpen({
      filePath: page, displayPath: "fixture/base.html", assetServer: "auto",
      probe: { enabled: false, fetchImpl: (async () => { calls++; return new Response(null, { status: 404 }) }) as unknown as typeof fetch },
    })
    expect(calls).toBe(0)
    expect(plan.assetService.missing).toEqual([])        // 没探过 ⇒ 不判"缺件"，也不判"在"
    expect(plan.preview.row.status).toBe("unknown")
    expect(plan.assetService.state).toBe("unknown")
  })
})

describe("结构性不变式 · 同一块计划里「素材服务就绪」与「缺件／服务不到」不许同时出现", () => {
  test("四种形态逐一体检：state=ready ⇒ missing 与 outsideRoot 都为空", async () => {
    const pageTree = site("w10-root-page-")
    const serverTree = site("w10-root-server-")
    const outside = site("w10-root-outside-")
    const outsideName = outside.split("/").pop() ?? "outside"
    file(serverTree, "product/media/ok.png", "x")
    file(outside, "shared/out.png", "x")
    const server = serveRoot(serverTree)
    try {
      // 服务根**未知**的形态：不传 serviceRoot（产品路径就是这样：宿主只给 origin）。
      const unknownRoot = [
        { name: "两棵树、服务端有", html: '<base href="' + server.origin + '/product/"><img src="media/ok.png">' },
        { name: "两棵树、服务端没有", html: '<base href="' + server.origin + '/product/"><img src="media/nope.png">' },
      ]
      // 服务根**声明**的形态：`serviceRoot = pageTree`（此时"落在根之外"才有意义）。
      const declaredRoot = [
        { name: "落在服务根之外", html: '<img src="../' + outsideName + '/shared/out.png">' },
        { name: "单文件", html: '<img src="data:image/png;base64,AAAA">' },
      ]
      const seen: string[] = []
      for (const [index, item] of [...unknownRoot, ...declaredRoot].entries()) {
        const path = join(pageTree, `case-${String(index)}.html`)
        file(pageTree, `case-${String(index)}.html`, '<!doctype html><html><head>' + item.html + '</head><body></body></html>')
        const declared = item.name === "落在服务根之外" || item.name === "单文件"
        const plan = await planHtmlOpen(declared
          ? { filePath: path, displayPath: `case-${String(index)}.html`, serviceRoot: pageTree, assetServer: { kind: "static-service", origin: server.origin, root: pageTree } }
          : { filePath: path, displayPath: `case-${String(index)}.html`, assetServer: "auto" })
        seen.push(`${item.name}=${plan.assetService.state}:missing${String(plan.assetService.missing.length)}/outside${String(plan.assetService.outsideRoot.length)}`)
        // **不变式**：就绪 ⇒ 这一页要的东西服务都给得出来。
        if (plan.assetService.state === "ready") {
          expect(plan.assetService.missing).toEqual([])
          expect(plan.assetService.outsideRoot).toEqual([])
        }
      }
      // 四种形态真的走到了不同状态（不是"全都 degraded"这种假绿，也不是"全都 ready"）。
      expect(seen.join("｜")).toContain("两棵树、服务端有=ready:missing0/outside0")
      expect(seen.join("｜")).toContain("两棵树、服务端没有=degraded:missing1/outside0")
      expect(seen.join("｜")).toContain("落在服务根之外=degraded:missing0/outside1")
      expect(seen.join("｜")).toContain("单文件=ready:missing0/outside0")
    } finally { server.stop() }
  })

  test("缺件时服务行必须跟着降级（旧行为是 ready 与缺件同时出现在一块计划里）", async () => {
    const root = site("w10-invariant-")
    file(root, "media/present.png", "x")
    const page = file(root, "index.html", '<!doctype html><html><body><img src="media/present.png"><img src="media/absent.png"></body></html>')
    const plan = await planHtmlOpen({
      filePath: page, serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => new Response(null, { status: 206 })) as unknown as typeof fetch },
    })
    expect(plan.assetService.missing).toEqual(["media/absent.png"])
    expect(plan.assetService.state).toBe("degraded")            // 回退成 ready 就不再是"服务就绪 + 缺件"并列
    expect(plan.summary).toContain("素材服务：degraded")
    expect(plan.wording.join("\n")).toContain("在本机不存在")     // 缺件照列，不靠删读数消矛盾
  })
})

describe("F2 · “未知”行的话术与本计划的入口处置必须对得上（话术 vs 行为）", () => {
  test("service-unprobed ⇒ choices.preview.enabled=false，计划里必须**自己说出**「先不放行」", async () => {
    const root = site("w10-f2-")
    file(root, "media/a.png", "x")   // 素材在（存在性不是这一条要测的），服务**没探过**
    const plan = await planHtmlOpen({ filePath: file(root, "index.html", '<!doctype html><html><body><img src="media/a.png"></body></html>'), displayPath: "index.html", assetServer: "auto" })
    expect(plan.preview.row.status).toBe("unknown")
    expect(plan.choices.find(choice => choice.target === "preview")?.enabled).toBe(false)
    const wording = plan.wording.join("\n")
    expect(wording).toContain("既不放行、也不阻断")        // 环境契约的通用句（不改它）
    expect(wording).toContain("本计划对这个入口先不放行")   // 本计划自己的行为，必须自己说
    expect(wording).toContain("choices.preview.enabled=false")
  })
})

describe("F3 · 超限预览的降级话术要与界面实测的行为一致", () => {
  test("超过 32MiB：说“点开会以失败态结束”，不许再说“不完整载入地看页面”", () => {
    const root = site("w10-f3-")
    const page = file(root, "index.html", '<!doctype html><html><body><h1>big</h1></body></html>')
    const facts = { ...probeHtmlPreviewFacts({ filePath: page, displayPath: "index.html", serviceRoot: root }), sizeBytes: 33 * 1024 * 1024 }
    const plan = planHtmlPreview(facts)
    expect(plan.preview.row.state).toBe("exceeds-native-limit")
    expect(plan.preview.row.status).toBe("missing")
    expect(plan.preview.disposition).toBe("degraded")                       // 有替代路径 ⇒ 入口照开（本单不改 enabled）
    expect(plan.choices.find(choice => choice.target === "preview")?.enabled).toBe(true)
    const wording = plan.wording.join("\n")
    expect(wording).toContain("点开会以失败态结束")                          // 与界面实测（无内容 + 失败原因）对齐
    expect(wording).not.toContain("不完整载入地看页面")                       // 旧句读起来像"部分载入出内容"
    expect(wording).toContain("这与编辑器 4MB 上限是两回事")                   // 原有口径不许丢
  })
})
