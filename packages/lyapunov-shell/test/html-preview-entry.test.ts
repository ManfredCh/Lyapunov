/**
 * DEV-032 · HTML 编辑与预览通用入口 回归测试（W10 / D1–D4）。
 *
 * 覆盖 `docs/DEVELOPMENT_TODO.md#dev-032` 的完成条件：
 *  ① 小 HTML、大 HTML、带相对素材、单文件四种情况**分别验证**；
 *  ② **页面预览成功不能代替源码编辑成功**（两个入口各自独立）；
 *  ③ 原生 32MiB 完整读取上限与扩展编辑器 4MB 上限**分别检查**（不许混为一谈）；
 *  ④ 软件重开后媒体仍可读 ⇒ 素材服务必须**重新探测**，旧读数不算数。
 * 另加一条本单的点名要求：**判定必须稳定**（同一份事实两次判定、素材顺序打乱，结论与指纹都必须一致）。
 *
 * 全部离线：文件落在临时目录里，素材服务用注入的 fetch 替身（不起真实端口、不联网）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  EXTENSION_EDITOR_LIMIT, HTML_PREVIEW_CONTRACT_TEST, HTML_SCAN_WINDOW_BYTES, NATIVE_FULL_READ_LIMIT, UNPROBED_ASSET_SERVER,
  classifyHtmlHead, countAssets, htmlDispositionOf, htmlPreviewFingerprint, humanBytes, isLoadTimeAsset,
  normalizeHtmlPreviewFacts, parseHtmlAssetRefs, parseHtmlBaseHref, planHtmlOpen, planHtmlPreview,
  probeAssetServer, probeHtmlPreviewFacts, resolveAssetRefs,
  type HtmlAssetServerState, type HtmlPreviewFacts,
} from "../src/html-preview-entry.ts"
import { environmentPanel, type EnvironmentReport, type GpuFacts } from "../src/environment-readiness.ts"

const cleanups: string[] = []
afterEach(() => { for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true }) })

function site(): string {
  const root = mkdtempSync(join(tmpdir(), "w10-html-"))
  cleanups.push(root)
  return root
}

function page(root: string, relative: string, html: string): string {
  const file = join(root, relative)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, html)
  return file
}

function asset(root: string, relative: string, bytes = "x"): void {
  const file = join(root, relative)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, bytes)
}

const SMALL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
<body><h1>hello</h1><img src="pic.png" alt="p"><a href="#top">top</a></body></html>`

const WITH_ASSETS = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<img src="media/a.png"><video controls poster="media/poster.png"><source src="media/clip.mp4" type="video/mp4"></video>
<a href="source/notes.md">notes</a></body></html>`

const SINGLE_FILE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<img src="data:image/jpeg;base64,AAAA"><video controls><source src="data:video/mp4;base64,BBBB" type="video/mp4"></video>
<a href="https://example.invalid/">外部链接（导航链接，不影响离线可看）</a></body></html>`

const server = (overrides: Partial<HtmlAssetServerState> = {}): HtmlAssetServerState => ({
  kind: "static-service", origin: "http://127.0.0.1:44139", root: null,
  reachable: true, rangeSupported: true, probedAt: 1, detail: "可达且支持 Range（206）", ...overrides,
})

function probe(file: string, options: { serviceRoot?: string | null; server?: HtmlAssetServerState; displayPath?: string } = {}): HtmlPreviewFacts {
  return probeHtmlPreviewFacts({
    filePath: file,
    displayPath: options.displayPath ?? basename(file),
    serviceRoot: options.serviceRoot === undefined ? null : options.serviceRoot,
    assetServer: options.server ?? server(),
  })
}

// ───────────────────────── 上限口径：两个限制必须分开（完成条件 ③） ─────────────────────────

describe("三个上限口径（DEV-032 完成条件③：分别检查）", () => {
  test("4MB 是编辑器上限，且就是 4,000,000 B —— 不是 4MiB，也不是预览上限", () => {
    expect(EXTENSION_EDITOR_LIMIT.bytes).toBe(4_000_000)
    expect(EXTENSION_EDITOR_LIMIT.bytes).not.toBe(4 * 1024 * 1024)
    expect(EXTENSION_EDITOR_LIMIT.source).toContain("lyapunov-workspace")
    expect(NATIVE_FULL_READ_LIMIT.bytes).toBe(32 * 1024 * 1024)
    expect(NATIVE_FULL_READ_LIMIT.bytes).toBeGreaterThan(EXTENSION_EDITOR_LIMIT.bytes)
    expect(HTML_SCAN_WINDOW_BYTES).toBe(EXTENSION_EDITOR_LIMIT.bytes)
    expect(HTML_SCAN_WINDOW_BYTES).not.toBe(NATIVE_FULL_READ_LIMIT.bytes)
  })

  test("字节口径不四舍五入成假话：4,000,000 B 与 32MiB 分别打印成什么", () => {
    expect(humanBytes(4_000_000)).toBe("3.81MiB")
    expect(humanBytes(32 * 1024 * 1024)).toBe("32.00MiB")
    expect(humanBytes(21_645)).toBe("21KB")
  })

  test("两个上限在计划里是两条独立读数，谁也不掩盖谁", () => {
    const root = site()
    const file = page(root, "big/index.html", SINGLE_FILE)
    const facts = { ...probe(file, { serviceRoot: root }), sizeBytes: 6_533_581 }
    const plan = planHtmlPreview(facts)
    expect(plan.preview.limits.map(check => check.limit.id)).toEqual(["native-full-read"])
    expect(plan.source.limits.map(check => check.limit.id)).toEqual(["extension-editor"])
    expect(plan.source.limits[0]!.reading).toContain("超过")
    expect(plan.preview.limits[0]!.reading).toContain("未超过")
  })
})

// ───────────────────────── 头部解析（纯函数） ─────────────────────────

describe("头部解析（不整文件读入也能预检）", () => {
  test("类型与编码：html / fragment / other / binary（含 NUL）", () => {
    expect(classifyHtmlHead("<!DOCTYPE html><html><body>x</body></html>").contentType).toBe("html")
    expect(classifyHtmlHead("<div>片段</div>").contentType).toBe("fragment")
    expect(classifyHtmlHead("just plain text").contentType).toBe("other")
    expect(classifyHtmlHead("<html>\u0000\u0001binary</html>").contentType).toBe("binary")
  })

  test("BOM 与声明的 charset 都只是读数（声明≠实际）", () => {
    const bom = classifyHtmlHead("\uFEFF<!doctype html><html></html>")
    expect(bom.encoding.bom).toBe("utf-8")
    expect(classifyHtmlHead('<html><head><meta charset="GBK"></head>').encoding.declared).toBe("gbk")
    expect(classifyHtmlHead("<html></html>").encoding.bom).toBeNull()
  })

  test("引用解析：封面图是图片、<source type=video/mp4> 才是视频（本机实测的错判）", () => {
    const refs = parseHtmlAssetRefs(WITH_ASSETS)
    const poster = refs.find(ref => ref.raw === "media/poster.png")!
    const clip = refs.find(ref => ref.raw === "media/clip.mp4")!
    expect(poster.kind).toBe("image")
    expect(poster.attribute).toBe("poster")
    expect(clip.kind).toBe("video")
    expect(refs.filter(ref => ref.kind === "video")).toHaveLength(1)
    expect(isLoadTimeAsset(clip)).toBe(true)
  })

  test("引用形态：inline / fragment / remote / relative；<a href> 是导航链接不算加载期素材", () => {
    const refs = parseHtmlAssetRefs(SINGLE_FILE)
    expect(refs.find(ref => ref.raw.startsWith("data:image"))!.form).toBe("inline")
    expect(refs.find(ref => ref.raw === "https://example.invalid/")!.form).toBe("remote")
    expect(refs.find(ref => ref.raw === "https://example.invalid/")!.kind).toBe("document")
    expect(isLoadTimeAsset(refs.find(ref => ref.raw === "https://example.invalid/")!)).toBe(false)
    expect(parseHtmlAssetRefs('<p><a href="#sec">x</a></p>')[0]!.form).toBe("fragment")
  })

  test("srcset 多个候选都算引用；<base>/<meta> 是元数据不算引用", () => {
    const refs = parseHtmlAssetRefs('<img srcset="a.png 1x, b.png 2x"><base href="http://127.0.0.1:1/x/"><meta name="x" content="y">')
    expect(refs.map(ref => ref.raw).sort()).toEqual(["a.png", "b.png"])
  })

  test("<base href> 会被解析出来（本机 Demo 的真实写法）", () => {
    expect(parseHtmlBaseHref('<head><base href="http://127.0.0.1:44139/product/"></head>')).toBe("http://127.0.0.1:44139/product/")
    expect(parseHtmlBaseHref("<head></head>")).toBeNull()
  })

  test("经 <base> 的相对引用按 base 解析（不是按页面目录）—— 忘了这条会造假警报", () => {
    const root = site()
    asset(root, "product/media/a.png")
    const refs = parseHtmlAssetRefs('<img src="media/a.png">')
    const resolved = resolveAssetRefs(refs, { pageDir: root, serviceRoot: root, baseHref: "http://127.0.0.1:44139/product/", assetOrigin: "http://127.0.0.1:44139" })
    expect(resolved[0]!.baseResolved).toBe(true)
    expect(resolved[0]!.servedUrl).toBe("http://127.0.0.1:44139/product/media/a.png")
    expect(resolved[0]!.resolvedPath).toBe(join(root, "product/media/a.png"))
    expect(resolved[0]!.withinServiceRoot).toBe(true)
  })
})

// ───────────────────────── 完成条件 ①：四种情况分别验证 ─────────────────────────

describe("四种情况：小文件 / 大文件 / 带素材 / 单文件", () => {
  test("小文件：预览与源码编辑都就绪，推荐预览", () => {
    const root = site()
    asset(root, "pic.png")
    const plan = planHtmlPreview(probe(page(root, "index.html", SMALL_PAGE), { serviceRoot: root }))
    expect(plan.preview.row.status).toBe("ready")
    expect(plan.source.row.status).toBe("ready")
    expect(plan.recommended).toBe("preview")
    expect(plan.facts.selfContained).toBe(false)   // pic.png 是相对素材
    expect(plan.choices.every(choice => choice.enabled)).toBe(true)
    expect(plan.preview.row.reading).toContain("加载期素材")
  })

  test("大文件（单文件 6.23MiB）：预览就绪但源码编辑不可用 —— 页面预览成功≠源码编辑成功（条件②）", () => {
    const root = site()
    const file = page(root, "gallery.html", SINGLE_FILE)
    const plan = planHtmlPreview({ ...probe(file, { serviceRoot: root }), sizeBytes: 6_533_581 })
    expect(plan.preview.row.status).toBe("ready")
    expect(plan.preview.disposition).toBe("ready")
    expect(plan.source.row.status).toBe("missing")
    expect(plan.source.row.state).toBe("exceeds-editor-limit")
    expect(plan.source.disposition).toBe("degraded")   // 有分段读取这条替代路径
    expect(plan.source.row.degradation?.path).toContain("分段读取")
    expect(plan.source.wording.join("\n")).toContain("页面预览能用，不等于源码编辑能用")
    expect(plan.recommended).toBe("preview")
  })

  test("带素材：服务不可达 → 预览降级并说清缺什么；源码编辑不受影响", () => {
    const root = site()
    asset(root, "media/a.png")
    asset(root, "media/clip.mp4")
    asset(root, "media/poster.png")
    const file = page(root, "index.html", WITH_ASSETS)
    const plan = planHtmlPreview(probe(file, { serviceRoot: root, server: server({ reachable: false, rangeSupported: null, detail: "不可达：fetch failed" }) }))
    expect(plan.preview.row.state).toBe("service-down")
    expect(plan.preview.disposition).toBe("degraded")
    expect(plan.assetService.state).toBe("missing")
    expect(plan.source.row.status).toBe("ready")
    const wording = plan.preview.wording.join("\n")
    expect(wording).toContain("现在：")
    expect(wording).toContain("怎么改回：")
    expect(wording).toContain("206")
  })

  test("带素材：服务可达且支持 Range → 预览就绪（素材由服务提供）", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = planHtmlPreview(probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root, server: server() }))
    expect(plan.preview.row.status).toBe("ready")
    expect(plan.preview.row.state).toBe("with-assets")
    expect(plan.assetService.state).toBe("ready")
    expect(plan.assetService.rangeRequired).toBe(true)
  })

  test("带素材：服务不支持 Range 且页面有视频 → 降级（不实测就报“预览成功”是不诚实的）", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = planHtmlPreview(probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root, server: server({ rangeSupported: false, detail: "可达但不支持 Range（HTTP 200）" }) }))
    expect(plan.preview.row.state).toBe("no-range")
    expect(plan.preview.wording.join("\n")).toContain("视频")
  })

  test("单文件：素材全内嵌 → 就绪且不需要外部服务，断网/重启后仍可读", () => {
    const root = site()
    const plan = planHtmlPreview(probe(page(root, "one.html", SINGLE_FILE), { serviceRoot: root, server: UNPROBED_ASSET_SERVER }))
    expect(plan.preview.row.state).toBe("self-contained")
    expect(plan.preview.row.status).toBe("ready")
    expect(plan.facts.selfContained).toBe(true)
    expect(plan.assetService.required).toBe(false)
    expect(plan.preview.row.impact).toContain("断网与重启后都能读")
  })

  test("单文件但超过 32MiB 原生上限 → 明确降级并给替代路径（不假装能预览）", () => {
    const root = site()
    const plan = planHtmlPreview({ ...probe(page(root, "huge.html", SINGLE_FILE), { serviceRoot: root }), sizeBytes: 33 * 1024 * 1024 })
    expect(plan.preview.row.state).toBe("exceeds-native-limit")
    expect(plan.preview.row.degradation).not.toBeNull()
    expect(plan.preview.action.enabled).toBe(false)
    expect(plan.preview.wording.join("\n")).toContain("这与编辑器 4MB 上限是两回事")
  })
})

// ───────────────────────── 缺件、越界、base 不一致（不静默留空） ─────────────────────────

describe("素材缺陷必须逐条说清", () => {
  test("素材文件不存在 → 列出清单（服务再好也补不上）", () => {
    const root = site()
    asset(root, "media/a.png")            // clip.mp4 与 poster.png 故意不建
    const plan = planHtmlPreview(probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root }))
    expect(plan.preview.row.state).toBe("assets-missing")
    expect(plan.assetService.missing.sort()).toEqual(["media/clip.mp4", "media/poster.png"])
    expect(plan.preview.row.evidence.join("\n")).toContain("（不存在）")
  })

  test("素材落在服务根之外 → 明确说“服务不到”，并给服务根处置", () => {
    const root = site()
    const outside = site()
    asset(outside, "shared/a.png")
    const file = page(root, "index.html", '<img src="../' + outside.split("/").pop() + '/shared/a.png">')
    const plan = planHtmlPreview(probe(file, { serviceRoot: root }))
    expect(plan.preview.row.state).toBe("assets-unserved")
    expect(plan.assetService.outsideRoot).toHaveLength(1)
    expect(plan.preview.row.remedy.summary).toContain("静态素材服务")
  })

  test("回归：<base href> 指向素材服务时**不报假缺失**，经 base 解析后素材是存在的", () => {
    const root = site()
    asset(root, "product/media/a.png")
    const file = page(root, "产品介绍.html", '<!doctype html><html><head><base href="http://127.0.0.1:44139/product/"></head><body><img src="media/a.png"></body></html>')
    const facts = probe(file, { serviceRoot: root, server: server({ reachable: true, rangeSupported: true }) })
    expect(facts.baseHref).toBe("http://127.0.0.1:44139/product/")
    const plan = planHtmlPreview(facts)
    expect(plan.assetService.missing).toEqual([])
    expect(plan.assetService.required).toBe(true)          // 经 <base> 提供的素材同样"需要服务"
    expect(plan.assetService.state).toBe("ready")
    expect(plan.preview.row.status).toBe("ready")
  })

  test("回归：<base> 指向本机服务但配置的服务是别的 origin → 预览降级 + 服务行如实说“不是同一个”", () => {
    const root = site()
    asset(root, "product/media/a.png")
    const file = page(root, "index.html", '<!doctype html><html><head><base href="http://127.0.0.1:44139/product/"></head><body><img src="media/a.png"></body></html>')
    // 配置成另一个本机端口：页面照样会去 44139，请求打不到配置的服务上。
    const plan = planHtmlPreview(probe(file, { serviceRoot: root, server: server({ origin: "http://127.0.0.1:59998" }) }))
    expect(plan.preview.row.state).toBe("base-origin-mismatch")
    expect(plan.assetService.required).toBe(true)
    expect(plan.assetService.state).toBe("degraded")
    expect(plan.assetService.row.state).toBe("base-origin-mismatch")
    expect(plan.assetService.missing).toEqual([])          // 不同源 ⇒ 不拿别人的根断言"不存在"
  })

  test("回归：<base href> 的 origin 与素材服务不一致 → 明确说清（服务配得再对也没用）", () => {
    const root = site()
    asset(root, "media/a.png")
    const file = page(root, "index.html", '<!doctype html><html><head><base href="http://127.0.0.1:59999/"></head><body><img src="media/a.png"></body></html>')
    const plan = planHtmlPreview(probe(file, { serviceRoot: root, server: server() }))
    expect(plan.preview.row.state).toBe("base-origin-mismatch")
    expect(plan.preview.disposition).toBe("degraded")
    expect(plan.preview.wording.join("\n")).toContain("请求根本没打到它那里")
  })

  test("失效的导航链接如实列出（页面照常预览，点开才 404）—— 不夸大也不隐瞒", () => {
    const root = site()
    asset(root, "pic.png")
    const file = page(root, "index.html", '<!doctype html><html><body><img src="pic.png"><a href="downloads/gallery.glb">下载模型</a><a href="notes.md">说明</a></body></html>')
    const plan = planHtmlPreview(probe(file, { serviceRoot: root }))
    expect(plan.preview.row.status).toBe("ready")            // 渲染不受影响
    expect(plan.assetService.missing).toEqual([])            // 加载期素材没有缺件
    expect(plan.assetService.brokenLinks.sort()).toEqual(["downloads/gallery.glb", "notes.md"])
    expect(plan.preview.row.impact).toContain("点开才会 404")
    expect(plan.summary).toContain("失效链接 2 个")
    expect(plan.preview.row.remedy.steps.join("\n")).toContain("gallery.glb")
  })

  test("非 HTML / 二进制：两个入口都明确拒绝，不会给出空页面", () => {
    const root = site()
    const binary = page(root, "x.html", "<html>\u0000\u0001not really html</html>")
    const plan = planHtmlPreview(probe(binary, { serviceRoot: root }))
    expect(plan.preview.disposition).toBe("unusable")
    expect(plan.source.disposition).toBe("unusable")
    expect(plan.recommended).toBeNull()
    expect(plan.preview.wording.join("\n")).toContain("静默留空")
  })

  test("头部不像 HTML：预览明确拒绝并给处置，源码入口照常", () => {
    const root = site()
    const plan = planHtmlPreview(probe(page(root, "log.html", "2026-09-26 INFO something happened"), { serviceRoot: root }))
    expect(plan.preview.row.state).toBe("not-html")
    expect(plan.preview.disposition).toBe("unusable")
    expect(plan.source.row.status).toBe("ready")
    expect(plan.recommended).toBe("source")
  })

  test("本模块的不确定读数用自己的说明（不借用 GPU 那句），且通用兜底仍在", () => {
    const root = site()
    // 截断扫描：就绪但"没有外部引用"只是窗口内读数。
    asset(root, "pic.png")
    const big = page(root, "big.html", SMALL_PAGE + "<!--" + "x".repeat(HTML_SCAN_WINDOW_BYTES) + "-->")
    const truncated = planHtmlPreview(probe(big, { serviceRoot: root }))
    expect(truncated.preview.row.uncertain).toBe(true)
    expect(truncated.preview.row.uncertaintyNote).toContain("只扫了前")
    const truncatedText = truncated.preview.wording.join("\n")
    expect(truncatedText).toContain("只扫了前")
    expect(truncatedText).not.toContain("可能是沙箱/容器误报")

    // 启发式判定（头部不像 HTML）：也带自己的说明。
    const odd = planHtmlPreview(probe(page(root, "log.html", "2026-09-26 INFO something happened"), { serviceRoot: root }))
    expect(odd.preview.row.uncertain).toBe(true)
    const oddText = odd.preview.wording.join("\n")
    expect(oddText).toContain("启发式")
    expect(oddText).not.toContain("可能是沙箱/容器误报")
  })

  test("HTML 片段仍可预览（片段是合法形态，不误判成 not-html）", () => {
    const root = site()
    const plan = planHtmlPreview(probe(page(root, "frag.html", "<div><p>片段</p></div>"), { serviceRoot: root }))
    expect(plan.facts.contentType).toBe("fragment")
    expect(plan.preview.row.status).toBe("ready")
  })

  test("未探测过素材服务 ≠ 可用：报 unknown 并给“怎么测清楚”（复用环境契约的话术格式）", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = planHtmlPreview(probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root, server: UNPROBED_ASSET_SERVER }))
    expect(plan.preview.row.status).toBe("unknown")
    expect(plan.preview.disposition).toBe("unknown")
    const wording = plan.preview.wording.join("\n")
    expect(wording).toContain("未知不等于可用")
    expect(wording).toContain("怎么测清楚")
  })
})

// ───────────────────────── 复用 W14 环境契约（远端素材 / 话术格式） ─────────────────────────

describe("复用环境契约的判据与话术（不另造一套）", () => {
  const remotePage = '<!doctype html><html><head></head><body><img src="https://cdn.invalid/a.png"></body></html>'

  test("远端素材 + 注入出网读数（broken）→ 降级 + 处置", () => {
    const root = site()
    const facts: HtmlPreviewFacts = {
      ...probe(page(root, "remote.html", remotePage), { serviceRoot: root }),
      network: { status: "broken", reading: "hf-mirror.com 不可达（GET 超时）" } satisfies EnvironmentReport,
    }
    const plan = planHtmlPreview(facts)
    expect(plan.preview.row.status).toBe("missing")
    expect(plan.preview.disposition).toBe("degraded")
    expect(plan.preview.row.reading).toContain("hf-mirror.com 不可达")
    expect(plan.preview.wording.join("\n")).toContain("内嵌")
  })

  test("远端素材 + 出网未知 → unknown（既不放行也不阻断）", () => {
    const root = site()
    const facts: HtmlPreviewFacts = { ...probe(page(root, "remote.html", remotePage), { serviceRoot: root }), network: { status: "unknown", reading: "尚未探测" } }
    const plan = planHtmlPreview(facts)
    expect(plan.preview.row.status).toBe("unknown")
    expect(plan.preview.wording.join("\n")).toContain("怎么测清楚")
  })

  test("给了环境整屏时，直接吃 asset.download 的判定（码与话术都来自那份契约）", () => {
    const root = site()
    const gpu: GpuFacts = {
      probeError: null, driverVersion: null, driverGpuEntries: [], deviceNodes: [], deviceExtras: [], pciDevices: [], pciIds: [], driverGpuModels: [],
      smi: { present: false, ok: false, output: "", error: "" }, capacity: null, requiredVramMiB: null, minDriverMajor: null,
    }
    const panel = environmentPanel({
      gpu, runtimes: [],
      graphics: { display: null, x11Socket: false, glxRenderer: null, glxAccelerated: null, probeError: null },
      serialDevices: [], micromamba: null,
    })
    const facts: HtmlPreviewFacts = { ...probe(page(root, "remote.html", remotePage), { serviceRoot: root }), environment: panel }
    const plan = planHtmlPreview(facts)
    expect(plan.preview.row.state).toBe("contract:degraded")
    // 话术格式同一份：四句话的固定前缀都出现（environmentRowWording 的产物）。
    const wording = plan.preview.wording.join("\n")
    expect(wording).toContain("影响：")
    expect(wording).toContain("现在：")
    expect(wording.startsWith("[页面预览]")).toBe(true)
  })

  test("素材服务计划给出 Range 复核命令与“重开后必须重探”的明确步骤", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = planHtmlPreview(probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root, server: server({ reachable: false }) }))
    expect(plan.assetService.recheck.how).toContain("Range: bytes=0-0")
    expect(plan.assetService.recheck.expect).toContain("206")
    expect(plan.assetService.checks.join("\n")).toContain("只监听回环")
    expect(plan.assetService.checks.join("\n")).toContain("只读")
  })
})

// ───────────────────────── 判定稳定性（本单点名：不许自己抖） ─────────────────────────

describe("判定稳定性", () => {
  test("同一份事实连续判定两次：结论与指纹都相同", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const facts = probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root })
    const first = planHtmlPreview(facts)
    const second = planHtmlPreview(facts)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  test("素材顺序打乱：指纹不变、结论不变（指纹里是排序后的规范化事实）", () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const facts = probe(page(root, "index.html", WITH_ASSETS), { serviceRoot: root })
    const shuffled = { ...facts, assets: [...facts.assets].reverse() }
    expect(htmlPreviewFingerprint(shuffled)).toBe(htmlPreviewFingerprint(facts))
    expect(planHtmlPreview(shuffled).summary).toBe(planHtmlPreview(facts).summary)
    expect(planHtmlPreview(shuffled).preview.row.status).toBe(planHtmlPreview(facts).preview.row.status)
  })

  test("同一文件连探两次：事实与指纹一致（真实 fs，不是替身）", () => {
    const root = site()
    asset(root, "media/a.png")
    const file = page(root, "index.html", WITH_ASSETS)
    const a = probe(file, { serviceRoot: root })
    const b = probe(file, { serviceRoot: root })
    expect(htmlPreviewFingerprint(a)).toBe(htmlPreviewFingerprint(b))
    expect(JSON.stringify(a.assets)).toBe(JSON.stringify(b.assets))
  })

  test("探测时刻不参与判定：probedAt 不同不影响指纹与结论", () => {
    const root = site()
    asset(root, "media/a.png")
    const file = page(root, "index.html", WITH_ASSETS)
    const early = probe(file, { serviceRoot: root, server: server({ probedAt: 1 }) })
    const late = probe(file, { serviceRoot: root, server: server({ probedAt: 999_999_999 }) })
    expect(htmlPreviewFingerprint(early)).toBe(htmlPreviewFingerprint(late))
    expect(planHtmlPreview(early).preview.row.status).toBe(planHtmlPreview(late).preview.row.status)
  })

  test("规范化事实里不含时刻，只含与判定有关的字段", () => {
    const root = site()
    const facts = probe(page(root, "index.html", SMALL_PAGE), { serviceRoot: root, server: server({ probedAt: 123 }) })
    const normalized = JSON.stringify(normalizeHtmlPreviewFacts(facts))
    expect(normalized).not.toContain("probedAt")
    expect(normalized).not.toContain("123")
    expect(normalized).toContain("absolutePath")
  })

  test("扫描窗口截断时说清“只是窗口内的读数”，不冒充全文结论", () => {
    const root = site()
    asset(root, "pic.png")
    const big = page(root, "big.html", SMALL_PAGE + "<!--" + "x".repeat(HTML_SCAN_WINDOW_BYTES) + "-->")
    const facts = probe(big, { serviceRoot: root })
    expect(facts.scanTruncated).toBe(true)
    const plan = planHtmlPreview(facts)
    expect(plan.wording.join("\n")).toContain("未扫全文")
    expect(plan.preview.row.reading).toContain("只扫了前")
  })

  test("指纹是纯函数：不同文件得到不同指纹，同内容不同路径也不同（路径在事实里）", () => {
    const root = site()
    const one = probe(page(root, "a.html", SMALL_PAGE), { serviceRoot: root })
    const two = probe(page(root, "b.html", SMALL_PAGE), { serviceRoot: root })
    expect(htmlPreviewFingerprint(one)).not.toBe(htmlPreviewFingerprint(two))
    expect(htmlPreviewFingerprint(one)).toStartWith("html-preview:")
  })
})

// ───────────────────────── 通用入口 planHtmlOpen（含真实探测替身） ─────────────────────────

describe("通用入口 planHtmlOpen", () => {
  test("注入 fetch 返回 206 → 素材服务就绪，预览就绪", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const file = page(root, "index.html", WITH_ASSETS)
    const plan = await planHtmlOpen({
      filePath: file, serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => new Response(null, { status: 206 })) as unknown as typeof fetch },
    })
    expect(plan.assetService.state).toBe("ready")
    expect(plan.preview.row.status).toBe("ready")
  })

  test("注入 fetch 返回 200（无 Range）→ 页面有视频时降级为 no-range", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = await planHtmlOpen({
      filePath: page(root, "index.html", WITH_ASSETS), serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch },
    })
    expect(plan.preview.row.state).toBe("no-range")
  })

  test("注入 fetch 抛错 → 服务不可达，预览降级并给出 Range 复核命令", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = await planHtmlOpen({
      filePath: page(root, "index.html", WITH_ASSETS), serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl: (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch },
    })
    expect(plan.assetService.state).toBe("missing")
    expect(plan.preview.row.state).toBe("service-down")
    expect(plan.assetService.recheck.how).toContain("Range")
  })

  test("回归（真机实测的假读数）：Range 必须探**真实素材**，不能拿服务根去判", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const file = page(root, "index.html", WITH_ASSETS)
    const seen: string[] = []
    // 真服务对"根路径"回落 200（目录），对素材回 206 —— 探根就会把支持 Range 的服务判成不支持。
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input); seen.push(url)
      return new Response(null, { status: url.endsWith("/index.html") || url.endsWith("/") ? 200 : 206 })
    }) as unknown as typeof fetch
    const plan = await planHtmlOpen({
      filePath: file, serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { fetchImpl },
    })
    expect(seen.some(url => /\/media\/(a\.png|clip\.mp4|poster\.png)$/.test(url))).toBe(true)   // 探的是素材
    expect(plan.assetService.state).toBe("ready")
    expect(plan.preview.row.status).toBe("ready")
    // 只给 origin（不给具体素材）时不许把"未知"写成"不支持"。
    const rootOnly = await probeAssetServer("http://127.0.0.1:44139", { fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch })
    expect(rootOnly.reachable).toBe(true)
    expect(rootOnly.rangeSupported).toBeNull()
    expect(rootOnly.detail).toContain("Range 只能在真实素材上判")
    const onFile = await probeAssetServer("http://127.0.0.1:44139", { probePath: "/media/clip.mp4", fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch })
    expect(onFile.rangeSupported).toBe(false)
  })

  test("只探测本机回环：非回环 origin 直接拒绝（预览不做成出网请求）", async () => {
    const state = await probeAssetServer("https://example.invalid/", { fetchImpl: (async () => { throw new Error("must not be called") }) as unknown as typeof fetch })
    expect(state.reachable).toBeNull()
    expect(state.detail).toContain("只探测本机回环")
  })

  test("关闭探测时不发请求：结果如实标“未探测”（不等于可用）", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    let called = 0
    const plan = await planHtmlOpen({
      filePath: page(root, "index.html", WITH_ASSETS), serviceRoot: root,
      assetServer: { kind: "static-service", origin: "http://127.0.0.1:44139", root },
      probe: { enabled: false, fetchImpl: (async () => { called++; return new Response(null, { status: 206 }) }) as unknown as typeof fetch },
    })
    expect(called).toBe(0)
    expect(plan.preview.row.status).toBe("unknown")
  })

  test("没有配置素材服务时不探测、不虚构 origin（相对素材仍按页面目录核对）", async () => {
    const root = site()
    asset(root, "media/a.png"); asset(root, "media/clip.mp4"); asset(root, "media/poster.png")
    const plan = await planHtmlOpen({ filePath: page(root, "index.html", WITH_ASSETS), serviceRoot: root })
    expect(plan.assetService.origin).toBeNull()
    expect(plan.assetService.missing).toEqual([])
    expect(plan.assetService.required).toBe(true)
  })
})

// ───────────────────────── 契约与行形状 ─────────────────────────

describe("契约形状", () => {
  test("处置语义与环境契约一致：有降级路径就不算不可用", () => {
    const root = site()
    const plan = planHtmlPreview({ ...probe(page(root, "big.html", SINGLE_FILE), { serviceRoot: root }), sizeBytes: 6_000_000 })
    expect(htmlDispositionOf(plan.source.row)).toBe("degraded")
    expect(plan.source.row.degradation).not.toBeNull()
  })

  test("引用计数把加载期素材与导航链接分开（DEV-032 的“带素材”口径）", () => {
    const counts = countAssets(parseHtmlAssetRefs(WITH_ASSETS))
    expect(counts.load).toBe(3)          // a.png + poster + clip.mp4
    expect(counts.navigation).toBe(1)    // source/notes.md
    expect(counts.byKind).toContain("video 1")
  })

  test("测试锚点指向本文件（判定↔测试可追溯）", () => {
    const root = site()
    const plan = planHtmlPreview(probe(page(root, "index.html", SMALL_PAGE), { serviceRoot: root }))
    expect(plan.preview.row.contractTest).toContain(HTML_PREVIEW_CONTRACT_TEST)
    expect(plan.source.row.contractTest).toContain(HTML_PREVIEW_CONTRACT_TEST)
  })

  test("总述与话术可直接渲染：summary 一行 + wording 分段包含两条路", () => {
    const root = site()
    const plan = planHtmlPreview(probe(page(root, "index.html", SMALL_PAGE), { serviceRoot: root }))
    expect(plan.summary).toContain("预览：")
    expect(plan.summary).toContain("源码：")
    expect(plan.wording[0]).toContain("[index.html]")
    expect(plan.wording.length).toBeGreaterThan(8)
  })
})
