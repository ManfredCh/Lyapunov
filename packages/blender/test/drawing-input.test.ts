/**
 * drawing_inspect / cad_convert 的真实行为测试：从 ToolRegistry 调用 → 共用 operation → 真实子进程。
 *
 * 三条通道都是真跑：
 *  · DXF  → ezdxf（隔离解释器）
 *  · DWG  → **真实转换器**（LibreDWG dwg2dxf，真 DWG 夹具）→ ezdxf 检验产物
 *  · PDF  → pypdf（矢量路径/文字/页面单位）+ 扫描页原生图像导出 → 附件
 *
 * 需要两个外部件，缺哪个就整组 skip（不静默当通过）：
 *  · 解释器：`LYAPUNOV_CAD_PYTHON` 指向装好 `ezdxf`、`pypdf`、`pillow` 的隔离 venv
 *  · 转换器：`LYAPUNOV_TEST_DWG2DXF` 指向真实的 dwg2dxf（或 PATH 里有 dwg2dxf）
 *
 * 运行：
 *   LYAPUNOV_CAD_PYTHON=<venv>/bin/python LYAPUNOV_TEST_DWG2DXF=<libredwg>/bin/dwg2dxf \
 *     node --test packages/blender/test/drawing-input.test.ts
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, mkdir, writeFile, chmod, link, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CadError, dwgSignature, pdfHeader, preflightCadFile, type CadReport } from '../src/cad.ts'
import {
  DRAWING_CONNECTIONS_UNAVAILABLE_WHY, DRAWING_ERROR_PREFIX, DRAWING_RESULT_PREFIX, assertDrawingReport,
  compareConstraints, compareFacts, constraintsDigest, convertDwgToDxf, factsCompleteOf, factsDigest, inspectDrawing,
  openingsDigest, parseConverterLosses, registerDrawingTools, resolveDwgConverter, sniffDrawingFile,
  type DrawingReport, type DwgConversion, type PdfReport,
} from '../src/drawing-input.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'drawing-fixtures')
const DWG_FIXTURES = join(FIXTURES, 'dwg')
const CAD_FIXTURES = join(HERE, 'cad-fixtures')
const SCRIPT = join(HERE, '..', 'python', 'drawing_inspect.py')
const PYTHON = process.env.LYAPUNOV_CAD_PYTHON?.trim() ?? ''
const hasPython = PYTHON !== '' && existsSync(PYTHON)
const DWG2DXF = process.env.LYAPUNOV_TEST_DWG2DXF?.trim() ?? ''
const hasConverter = DWG2DXF !== '' && existsSync(DWG2DXF)
const VECTOR_PDF = join(FIXTURES, 'plan-vector.pdf')
const SCANNED_PDF = join(FIXTURES, 'plan-scanned.pdf')
const MIXED_PDF = join(FIXTURES, 'plan-mixed.pdf')
const ENCRYPTED_PDF = join(FIXTURES, 'plan-encrypted.pdf')
const INLINE_PDF = join(FIXTURES, 'plan-inline-scan.pdf')
const NESTED_FORM_PDF = join(FIXTURES, 'plan-nested-form.pdf')
const ROTATED_SCAN_PDF = join(FIXTURES, 'plan-rotated-scan.pdf')
const CROPPED_SCAN_PDF = join(FIXTURES, 'plan-cropped-scan.pdf')
const TWO_PAGE_PDF = join(FIXTURES, 'plan-two-page.pdf')
const LINE_DWG = join(DWG_FIXTURES, 'tmp-line-r10.dwg')
const ENTITIES_DWG = join(DWG_FIXTURES, 'entities-r10.dwg')
const DIM_DWG = join(DWG_FIXTURES, 'dim-r26.dwg')
const REAL_DWG = join(DWG_FIXTURES, 'example_2004.dwg')

async function bootContext(config: Parameters<typeof registerDrawingTools>[1] = {}) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
  ]
  const dispose = registerDrawingTools(ctx, config)
  return {
    ctx,
    dispose,
    async close() {
      await dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

async function callTool(
  ctx: Context,
  name: 'drawing_inspect' | 'cad_convert' | 'drawing_constraints_check',
  args: Record<string, unknown>,
  scope?: { cwd: string },
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    callId: ToolCallId(`drawing-test:${name}:${String(args.path)}:${scope?.cwd ?? ''}`),
    name,
    arguments: args,
    signal: signal ?? new AbortController().signal,
    ...(scope ? { agent: { session: { header: { cwd: scope.cwd } } } as never } : {}),
  })
}

function valueOf<T>(result: ToolExecutionResult): { result: string; report: T } {
  if (result.isError) throw new Error(`工具失败：${JSON.stringify(result.content ?? null).slice(0, 800)}`)
  return result.value as unknown as { result: string; report: T }
}

function drawingOf(result: ToolExecutionResult): DrawingReport {
  const { result: text, report } = valueOf<DrawingReport>(result)
  assertDrawingReport(report, report.file?.path ?? '')
  const summary = JSON.parse(text) as Record<string, unknown>
  assert.deepEqual(summary.file, report.file, '摘要里的 file 必须与 report 一致')
  assert.deepEqual(summary.format, { kind: report.format.kind, evidence: report.format.evidence, dwgVersion: report.format.dwgVersion })
  return report
}

function conversionOf(result: ToolExecutionResult): DwgConversion {
  const { result: text, report } = valueOf<DwgConversion>(result)
  const summary = JSON.parse(text) as Record<string, unknown>
  assert.deepEqual(summary.source, report.source, '摘要里的 source 必须与 report 一致')
  assert.deepEqual(summary.output, report.output)
  return report
}

function errorTextOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error(`期望失败但成功了：${JSON.stringify(result.value ?? null).slice(0, 400)}`)
  return JSON.stringify(result.content ?? null)
}

/**
 * 假附件库：只记下 saveImage 的入参并返回可辨识的 ref。
 * 真附件库（AttachmentLocal）要 sharp，本工作树没装（见 memory: local-attachment-store-needs-sharp）；
 * 这里测的是**本工具与附件服务之间的契约**（何时调、喂什么字节、失败怎么回执），不是 sharp 本身。
 */
function fakeAttachments(duringSave?: () => void) {
  const saved: Array<{ name: string; mediaType: string; bytes: number; pngMagic: boolean }> = []
  return {
    saved,
    store: {
      async saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name: string }) {
        saved.push({
          name: input.name, mediaType: input.mediaType, bytes: input.data.length,
          pngMagic: input.data[0] === 0x89 && input.data[1] === 0x50,
        })
        duringSave?.()   // 让测试能把"取消"精确地插在附件化中间
        return { id: `attachment-${saved.length}`, name: input.name }
      },
    },
  }
}

async function bootWithAttachments(config: Parameters<typeof registerDrawingTools>[1], duringSave?: () => void) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
  ]
  const fake = fakeAttachments(duringSave)
  ctx.provide('attachments', fake.store as never)
  registerDrawingTools(ctx, config)
  return { ctx, fake, async close() { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

/** 目标目录里有没有留下本次的暂存残渣（原子发布的临时名是 .<名字>.<hex>.tmp）。 */
async function scratchLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.includes('.tmp'))
}

async function sha256(path: string): Promise<string> {
  const data = await readFile(path)
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(data).digest('hex')
}

describe('图纸分流与转换器解析（不需要解释器/转换器）', () => {
  test('registerDrawingTools 注册出 drawing_inspect 与 cad_convert，注销后都消失', async () => {
    const { ctx, dispose, close } = await bootContext()
    try {
      assert.ok(ctx.tools.get('drawing_inspect'), 'drawing_inspect 应该在 ToolRegistry 里')
      assert.ok(ctx.tools.get('cad_convert'), 'cad_convert 应该在 ToolRegistry 里')
      await dispose()
      assert.equal(ctx.tools.get('drawing_inspect'), undefined)
      assert.equal(ctx.tools.get('cad_convert'), undefined)
    } finally {
      await close()
    }
  })

  test('文件头分流：DWG/DXF/PDF/位图/未知各按字节判定，改名骗不过去', async () => {
    // DWG：真文件（不是改名的 DXF），签名后 5 字节为 0
    const lineDwg = await sniffDrawingFile(LINE_DWG)
    assert.equal(lineDwg.kind, 'dwg')
    assert.equal(lineDwg.dwgVersion?.code, 'AC1006')
    assert.equal(lineDwg.dwgVersion?.release, 'AutoCAD Release 10')
    const r26 = await sniffDrawingFile(DIM_DWG)
    assert.equal(r26.dwgVersion?.code, 'AC1003')
    // DXF：ASCII 组码
    const dxf = await sniffDrawingFile(join(CAD_FIXTURES, 'plan-mm.dxf'))
    assert.equal(dxf.kind, 'dxf')
    assert.equal(dxf.binaryDxf, false)
    // 二进制 DXF：头是 Binary DXF，不能被当成 DWG
    const binary = await sniffDrawingFile(join(CAD_FIXTURES, 'plan-mm-binary.dxf'))
    assert.equal(binary.kind, 'dxf')
    assert.equal(binary.binaryDxf, true)
    // PDF
    assert.equal((await sniffDrawingFile(VECTOR_PDF)).kind, 'pdf')
    assert.equal((await sniffDrawingFile(VECTOR_PDF)).pdfHeader, '%PDF-1.3')
    assert.equal((await sniffDrawingFile(SCANNED_PDF)).kind, 'pdf')
    assert.match((await sniffDrawingFile(SCANNED_PDF)).pdfHeader ?? '', /^%PDF-1\.[3-7]$/)
    // 位图：把 PNG 伪装成 .pdf 也仍然是位图（分流只看字节）
    const disguised = join(await mkdtemp(join(tmpdir(), 'drawing-kind-')), 'scan.pdf')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    await writeFile(disguised, png)
    const image = await sniffDrawingFile(disguised)
    assert.equal(image.kind, 'image')
    assert.equal(image.imageFormat, 'png')
    // 位图签名不是"看到 RIFF 就算图"：真 webp 认，同容器的 wav 不认
    const riffDir = await mkdtemp(join(tmpdir(), 'drawing-kind-'))
    const webp = join(riffDir, 'plan.webp')
    await writeFile(webp, Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]))
    assert.equal((await sniffDrawingFile(webp)).imageFormat, 'webp')
    const wav = join(riffDir, 'noise.wav')
    await writeFile(wav, Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(8)]))
    assert.equal((await sniffDrawingFile(wav)).kind, 'unknown', 'RIFF 容器不等于位图图纸')
    // 未知
    const junk = join(await mkdtemp(join(tmpdir(), 'drawing-kind-')), 'x.dwg')
    await writeFile(junk, 'hello world, definitely not a drawing')
    const unknown = await sniffDrawingFile(junk)
    assert.equal(unknown.kind, 'unknown')
    assert.match(unknown.headHex, /^[0-9a-f]+$/)
    // 缺文件是稳定错误码
    await assert.rejects(() => sniffDrawingFile(join(FIXTURES, 'nope.dwg')), (error: unknown) =>
      error instanceof CadError && error.code === 'DRAWING_FILE_MISSING')
  })

  test('转换器解析：显式配置 > 环境变量 > PATH；三者都没有就是 undefined（不猜）', () => {
    const probe = (name: string) => (name === 'dwg2dxf' ? '/opt/libredwg/bin/dwg2dxf' : undefined)
    assert.equal(resolveDwgConverter({}, {}, probe)?.bin, '/opt/libredwg/bin/dwg2dxf')
    assert.equal(resolveDwgConverter({}, {}, probe)?.kind, 'libredwg')
    assert.equal(resolveDwgConverter({}, {}, probe)?.source, 'path')
    // 环境变量优先于 PATH
    assert.equal(resolveDwgConverter({}, { LYAPUNOV_DWG_CONVERTER: '/env/bin/dwg2dxf' }, probe)?.source, 'env')
    // 显式配置优先于环境变量；参数模板/种类都带上
    const configured = resolveDwgConverter(
      { dwgConverter: { path: '/custom/convert', kind: 'command', args: ['-o', '{out}', '{in}'] } },
      { LYAPUNOV_DWG_CONVERTER: '/env/bin/dwg2dxf' }, probe)
    assert.equal(configured?.source, 'config')
    assert.equal(configured?.kind, 'command')
    assert.deepEqual(configured?.args, ['-o', '{out}', '{in}'])
    // 种类可以推断出来
    assert.equal(resolveDwgConverter({ dwgConverter: { path: '/x/dwg2dxf' } }, {}, probe)?.kind, 'libredwg')
    // 都没有 → undefined（调用方报 DWG_CONVERTER_UNCONFIGURED）
    assert.equal(resolveDwgConverter({}, {}, () => undefined), undefined)
    // ODA File Converter 是目录语义、本实现没有实测过这条路径：显式配它或把它放进环境变量都明确拒绝，
    // 不静默当成"不支持的命令行转换器"跑出一堆无意义参数（PATH 上探到也不会被选中）
    const odaOnly = (name: string) => (name === 'ODAFileConverter' ? '/opt/oda/ODAFileConverter' : undefined)
    assert.equal(resolveDwgConverter({}, {}, odaOnly), undefined, 'PATH 上只有 ODA 时等于没有可用转换器')
    for (const config of [{ dwgConverter: { path: '/x/ODAFileConverter' } },
                          { dwgConverter: { path: '/opt/oda/ODAFileConverter', kind: 'command' as const } }]) {
      assert.throws(() => resolveDwgConverter(config, {}, probe), (error: unknown) =>
        error instanceof CadError && error.code === 'DWG_CONVERTER_UNSUPPORTED')
    }
    assert.throws(() => resolveDwgConverter({}, { LYAPUNOV_DWG_CONVERTER: '/opt/oda/ODAFileConverter' }, probe),
      (error: unknown) => error instanceof CadError && error.code === 'DWG_CONVERTER_UNSUPPORTED')
  })

  test('转换器告警解析：libredwg 的 Warning/Unhandled/Unstable 分类计数并去重', () => {
    const stderr = [
      'Warning: Skip HATCH common handles due to short handle stream',
      'Warning: Skip HATCH common handles due to short handle stream',
      'Warning: Unstable Class object 506 MATERIAL (0x481) 114/0',
      'Unhandled Class object 513 ACDBASSOCPERSSUBENTMANAGER (0x400) 211/0',
      'Unstable Class entity 525 ARC_DIMENSION (0x401) 245/0',
      'just a log line without a known prefix',
    ].join('\n')
    const { losses, categories } = parseConverterLosses(stderr)
    assert.equal(categories.warning, 3, '重复的 Warning 计数累计（明细才去重）')
    assert.equal(categories.unhandled, 1)
    assert.equal(categories.unstable, 1, '按行首关键字分类：Warning: Unstable… 归 warning，裸 Unstable… 才归 unstable')
    assert.equal(losses.length, 4, '明细去重后 4 条（重复那条不重复列）')
    assert.equal(losses.some(line => line.includes('log line without')), false, '不带告警前缀的普通日志不算损失')
    assert.ok(losses.every(line => line.length <= 240))
  })

  test('分流拒绝：位图与未知格式各有稳定错误码，不落到解析器里去猜', async () => {
    const { ctx, close } = await bootContext({ python: PYTHON || '/nonexistent/python' })
    const dir = await mkdtemp(join(tmpdir(), 'drawing-route-'))
    try {
      const png = join(dir, 'scan.png')
      await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
      const imageText = errorTextOf(await callTool(ctx, 'drawing_inspect', { path: png }))
      assert.match(imageText, /DRAWING_KIND_IMAGE/)
      assert.match(imageText, /读图/)
      const junk = join(dir, 'junk.dwg')
      await writeFile(junk, 'not a drawing at all')
      const unknownText = errorTextOf(await callTool(ctx, 'drawing_inspect', { path: junk }))
      assert.match(unknownText, /DRAWING_FORMAT_UNKNOWN/)
      // 相对路径没有会话 cwd/workspace 时明确报错
      const cwdText = errorTextOf(await callTool(ctx, 'drawing_inspect', { path: 'plan.pdf' }))
      assert.match(cwdText, /CAD_CWD_UNRESOLVED/)
    } finally {
      await close()
    }
  })

  test('格式路由：DWG/PDF 的文件头判定共用一份规则，cad_inspect 遇到 PDF 直接把调用方指到 drawing_inspect', async () => {
    // 共用判定本身（dwgSignature/pdfHeader 就是 cad.ts 前置检查用的那两个）
    const lineDwg = await sniffDrawingFile(LINE_DWG)
    assert.equal(lineDwg.signature, 'AC1006')
    assert.equal(dwgSignature(await readFile(LINE_DWG)), 'AC1006')
    // DXF 的 $ACADVER 也是 AC1015 这样的串：没有"签名后 5 字节为 0"就会被误判成 DWG
    const dxfHead = await readFile(join(CAD_FIXTURES, 'plan-mm.dxf'))
    assert.equal(dxfHead.subarray(0, 6).toString('latin1'), '  0\nSE')
    assert.equal(dwgSignature(dxfHead), null)
    // 假造一个"长得像 DWG 签名但后面不是 0"的头：必须不认
    const fake = Buffer.from('AC1015garbage-after-signature')
    assert.equal(dwgSignature(fake), null)
    assert.equal(dwgSignature(Buffer.from('AC1032' + '\0'.repeat(5) + 'rest')), 'AC1032')
    // 上古签名只有 5 字节（LibreDWG 的 dwg_versions 表里 AC1.40 就是 r1.4 的真签名）：
    // 本机那份 r1.4/entities.dwg 的头正是 "AC1.40" + 5 个 0，只认 AC1\d{3} 的旧规则会漏判
    assert.equal(dwgSignature(Buffer.from('AC1.40' + '\0'.repeat(5) + 'rest')), 'AC1.40')
    assert.equal(dwgSignature(Buffer.from('MC0.0' + '\0'.repeat(5) + 'rest')), 'MC0.0')
    assert.equal(dwgSignature(Buffer.from('AC1.40rest-without-zeros')), null, '缺 5 个 0 就不认')
    assert.equal(pdfHeader('%PDF-1.7\n'), '%PDF-1.7')
    assert.equal(pdfHeader('not a pdf'), null)
    // cad_inspect 的前置检查（工具一进来就走这里）给的是路由指引，不是一句晦涩的解析失败
    await assert.rejects(() => preflightCadFile(VECTOR_PDF), (error: unknown) => {
      assert.ok(error instanceof CadError)
      assert.equal(error.code, 'PDF_REQUIRES_DRAWING_INSPECT')
      assert.match(error.message, /drawing_inspect/)
      return true
    })
    // R2.6 的老 DWG（AC1003）也要被前置检查认出来：以前只认 AC1\d{3}，AC1003 也会漏
    await assert.rejects(() => preflightCadFile(DIM_DWG), (error: unknown) =>
      error instanceof CadError && error.code === 'DWG_REQUIRES_CONVERTER'
      && (error.detail as { signature?: string }).signature === 'AC1003')
    // 前置检查只做文件级判定：真 DXF 照旧放行
    assert.equal((await preflightCadFile(join(CAD_FIXTURES, 'plan-mm.dxf'))).binary, false)
  })

  test('cad_convert 不是 DWG 时报 DWG_INPUT_NOT_DWG（转换只对 DWG 有意义）', async () => {
    const { ctx, close } = await bootContext({
      python: PYTHON || '/nonexistent/python',
      dwgConverter: { path: '/nonexistent/dwg2dxf' },
    })
    try {
      const text = errorTextOf(await callTool(ctx, 'cad_convert', { path: join(CAD_FIXTURES, 'plan-mm.dxf') }))
      assert.match(text, /DWG_INPUT_NOT_DWG/)
      assert.match(text, /按文件头|识别为 dxf/)
    } finally {
      await close()
    }
  })

  test('没配转换器时 DWG 明确报 DWG_CONVERTER_UNCONFIGURED，只给实测过的两条可用路线', async () => {
    const { ctx, close } = await bootContext({ python: PYTHON || '/nonexistent/python' })
    const saved = process.env.LYAPUNOV_DWG_CONVERTER
    delete process.env.LYAPUNOV_DWG_CONVERTER
    try {
      const text = errorTextOf(await callTool(ctx, 'drawing_inspect', { path: LINE_DWG }))
      assert.match(text, /DWG_CONVERTER_UNCONFIGURED/)
      assert.match(text, /LibreDWG|dwg2dxf/)
      assert.match(text, /command/, '自定义命令模板这条真实可走的路要写出来')
      // 不广告没实测过的转换器（ODA 是目录语义，本实现没有这条分支）
      assert.doesNotMatch(text, /ODA/)
    } finally {
      if (saved !== undefined) process.env.LYAPUNOV_DWG_CONVERTER = saved
      await close()
    }
  })
})

describe('PDF 分流（需要 LYAPUNOV_CAD_PYTHON 的 pypdf/pillow）', { skip: hasPython ? false : '未设置 LYAPUNOV_CAD_PYTHON' }, () => {
  let booted: Awaited<ReturnType<typeof bootContext>>
  before(async () => { booted = await bootContext({ python: PYTHON }) })
  after(async () => { await booted.close() })

  test('矢量 PDF：真实路径算子与文字都读出来，页面单位是 point 不是米', async () => {
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: VECTOR_PDF, images: false }))
    assert.equal(report.kind, 'pdf')
    const pdf = report.pdf as PdfReport
    assert.equal(pdf.classification, 'vector')
    assert.equal(pdf.format.pageCount, 1)
    // 页面实际尺寸：A3 = 1190.551 x 841.89 pt = 420 x 297 mm（纸面尺寸，不是建筑尺寸）
    assert.ok(Math.abs(pdf.units.mmPerPoint - 0.35277777778) < 1e-9)
    assert.ok(Math.abs(pdf.pages[0]!.size!.widthMm! - 420) < 1e-3, `A3 宽 420mm，实际 ${pdf.pages[0]!.size!.widthMm}`)
    assert.ok(Math.abs(pdf.pages[0]!.size!.heightMm! - 297) < 1e-3)
    // 路径：真实算子计数（re/c/l/m），矩形是闭合路径
    const content = pdf.pages[0]!.content as { pathConstructOps: number; pathOpsByType: Record<string, number>; textShowOps: number; imagesDrawn: number }
    assert.ok(content.pathConstructOps >= 18, `路径算子应 >= 18，实际 ${content.pathConstructOps}`)
    assert.ok(content.pathOpsByType.re! >= 3, '有三个矩形（图框/外墙/内隔墙）')
    assert.ok(content.pathOpsByType.c! >= 4, '门弧与柱用贝塞尔曲线')
    assert.equal(content.textShowOps, 4)
    assert.equal(content.imagesDrawn, 0)
    assert.equal(pdf.vector.pathCount, pdf.counts.vectorPaths)
    assert.ok(pdf.vector.closedPathCount >= 3, 're 构造的矩形必须算闭合')
    // 坐标是页面坐标：图框从 10mm 处开始（10mm = 28.35pt）
    const bbox = pdf.vector.bboxPagePoints!
    assert.ok(Math.abs(bbox[0]! - 28.34646) < 0.01, `图框左边界应是 10mm=28.35pt，实际 ${bbox[0]}`)
    assert.ok(pdf.vector.bboxPageMm![0]! > 9.99 && pdf.vector.bboxPageMm![0]! < 10.01)
    // 文字
    assert.ok(pdf.text.charCount > 60)
    assert.ok(pdf.text.items.some(item => String(item.text).includes('ROOM A')))
    // **单位纪律**：没给比例尺就没有任何米制换算，文字里的 1:100 只作为文字证据列出
    assert.equal(pdf.units.metresKnown, false)
    assert.equal(pdf.units.metresPerPagePoint, null)
    assert.equal(pdf.vector.bboxMetresByCallerScale, null)
    assert.equal(pdf.units.scaleStatements.length, 1)
    const statement = pdf.units.scaleStatements[0] as { scale: string; evidence: string; metresPerPagePoint: number }
    assert.equal(statement.scale, '1:100')
    assert.equal(statement.evidence, 'label', '带 SCALE 标签的证据要标出来')
    assert.ok(Math.abs(statement.metresPerPagePoint - 0.0352777778) < 1e-9)
    assert.match(pdf.units.note, /不是建筑|纸面/)
  })

  test('矢量 PDF + 显式比例尺：米制换算只在调用方给了比例尺时出现，并标注来源', async () => {
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: VECTOR_PDF, scale: '1:100', images: false }))
    const pdf = report.pdf as PdfReport
    assert.equal(pdf.units.metresKnown, true)
    assert.equal(pdf.units.metresSource, 'caller-scale')
    assert.equal(pdf.units.callerScale, '1:100')
    assert.ok(Math.abs((pdf.units.metresPerPagePoint ?? 0) - 0.035277777778) < 1e-9)
    // 图纸内容从 10mm 到 410mm（图框内缩 10mm）@1:100 = 40 m 实际宽度（按调用方给的比例尺推算）
    const metres = pdf.vector.bboxMetresByCallerScale!
    assert.ok(metres, '给了比例尺才给米制边界')
    assert.ok(Math.abs(metres[2]! - metres[0]! - 40) < 0.01, `按 1:100 推算宽 40 m，实际 ${metres[2]! - metres[0]!}`)
    assert.ok(Math.abs(metres[3]! - metres[1]! - 27.7) < 0.01, `按 1:100 推算高 27.7 m，实际 ${metres[3]! - metres[1]!}`)
    // 不合法比例尺明确报错
    const text = errorTextOf(await callTool(booted.ctx, 'drawing_inspect', { path: VECTOR_PDF, scale: 'abc', images: false }))
    assert.match(text, /DRAWING_SCALE_INVALID/)
  })

  test('扫描 PDF：分类为 scanned、原生图像导出成 PNG 并作为附件进上下文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const attached = await bootWithAttachments({ python: PYTHON })
    try {
      const result = await callTool(attached.ctx, 'drawing_inspect', { path: SCANNED_PDF, image_directory: dir })
      const report = drawingOf(result)
      const pdf = report.pdf as PdfReport
      assert.equal(pdf.classification, 'scanned')
      assert.equal(pdf.pages[0]!.classification, 'scanned')
      assert.equal(pdf.counts.vectorPaths, 0, '扫描页没有矢量路径')
      assert.equal(pdf.text.charCount, 0, '扫描页没有文字')
      assert.ok(pdf.pages[0]!.content.imageCoverage as number >= 0.99, '整页覆盖')
      // 图像是**原生嵌入像素**（150dpi A3 ≈ 2480×1754），不是重新栅格化的
      const exported = pdf.images.exported
      assert.equal(exported.length, 1)
      assert.equal(exported[0]!.source, 'embedded')
      assert.equal(exported[0]!.width, 2480)
      assert.equal(exported[0]!.height, 1754)
      assert.equal(exported[0]!.path, join(dir, 'page-1-image-1.png'))
      const png = await readFile(exported[0]!.path)
      assert.equal(png[0], 0x89, '导出的必须是真 PNG 文件')
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG')
      assert.ok(png.length > 5000, '图像不能是空图')
      // 图进了附件库：喂进去的就是**刚导出的那份 PNG 字节**（名字用文件名，不是源 PDF 里的 image.jpg）
      assert.equal(attached.fake.saved.length, 1)
      assert.equal(attached.fake.saved[0]!.name, 'page-1-image-1.png')
      assert.equal(attached.fake.saved[0]!.mediaType, 'image/png')
      assert.equal(attached.fake.saved[0]!.pngMagic, true)
      assert.equal(attached.fake.saved[0]!.bytes, png.length, '附件字节数必须等于落盘 PNG 的字节数')
      // render 会把附件作为图像块带进上下文（模型据此读图，不必自己找路径）
      const content = (result.content ?? []) as Array<{ type: string }>
      assert.equal(content.filter(block => block.type === 'image').length, 1, '应有一张图像块')
      const { result: text } = valueOf<DrawingReport>(result)
      assert.match(text, /"attached":\[\{"page":1/)
      assert.equal(report.warnings.includes('PDF_HAS_SCANNED_PAGES'), true)
    } finally {
      await attached.close()
    }
  })

  test('扫描 PDF：不给 image_directory 时落在会话工作区派生的默认目录（不落进程 cwd）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-cwd-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: SCANNED_PDF }, { cwd: dir }))
    const exported = (report.pdf as PdfReport).images.exported
    assert.equal(exported.length, 1)
    assert.equal(exported[0]!.path, join(dir, 'drawing-images', 'plan-scanned', 'page-1-image-1.png'))
    assert.ok(existsSync(exported[0]!.path!), '默认落点必须真的写出文件')
  })

  test('扫描 PDF：装配没有附件服务时如实说明"按路径自行读取"，不假装图进了上下文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const result = await callTool(booted.ctx, 'drawing_inspect', { path: SCANNED_PDF, image_directory: dir })
    const { report } = valueOf<DrawingReport>(result)
    assert.equal((report.pdf as PdfReport).images.exported.length, 1)
    const summary = JSON.parse(valueOf<DrawingReport>(result).result) as { attachments: { attached: unknown[]; note: string } }
    assert.equal(summary.attachments.attached.length, 0)
    assert.match(summary.attachments.note, /附件服务|路径/)
  })

  test('混合 PDF：图像覆盖率与矢量路径同时存在 → mixed，且路径与文字仍全部给出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: MIXED_PDF, image_directory: dir }))
    const pdf = report.pdf as PdfReport
    assert.equal(pdf.classification, 'mixed')
    assert.equal(pdf.pages[0]!.classification, 'mixed')
    assert.ok(pdf.vector.pathCount > 0 && pdf.text.charCount > 0)
    assert.equal(pdf.images.exported.length, 1)
  })

  test('加密 PDF：明确报 PDF_ENCRYPTED，不猜口令、不拿空报告冒充（且 images:false 不落任何目录）', async () => {
    const text = errorTextOf(await callTool(booted.ctx, 'drawing_inspect', { path: ENCRYPTED_PDF, images: false }))
    assert.match(text, /PDF_ENCRYPTED/)
    assert.match(text, /解密|口令/)
    // images:false 就是"别导图"：不建默认目录、不落盘（曾经这里会在图纸旁边建一个空目录）
    assert.equal(existsSync(join(FIXTURES, 'drawing-images')), false, 'images:false 不该建默认图像目录')
  })

  test('整页 inline image（没有 Image XObject）也要算覆盖率、判成扫描页并导出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: INLINE_PDF, image_directory: dir }))
    const pdf = report.pdf as PdfReport
    const content = pdf.pages[0]!.content as {
      inlineImages: number; imagesDrawn: number; imageCoverage: number; uncountedOps: Record<string, number>
    }
    // inline 图（BI…ID…EI）以前落进 uncountedOps、覆盖率为 0 → 整页扫描件会被判成 empty
    assert.equal(content.inlineImages, 1)
    assert.deepEqual(content.uncountedOps, {})
    assert.equal(content.imageCoverage, 1)
    assert.equal(pdf.classification, 'scanned')
    assert.equal(pdf.pages[0]!.errors!.length, 0)
    const placed = pdf.pages[0]!.images[0] as { inline: boolean; width: number; height: number; filter: string }
    assert.equal(placed.inline, true)
    assert.equal(placed.width, 16)
    assert.equal(placed.height, 12)
    assert.equal(placed.filter, '/AHx', 'inline 图的过滤器缩写按内容流原样给')
    assert.equal(pdf.images.exported.length, 1)
    assert.equal(pdf.images.exported[0]!.source, 'embedded')
    assert.equal(pdf.images.exported[0]!.width, 16)
    assert.ok(existsSync(pdf.images.exported[0]!.path!), '导出的 PNG 必须真落盘')
  })

  test('扫描图藏在两层 Form XObject 里：进内层 /Resources 才看得到图，覆盖率与分类都成立', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: NESTED_FORM_PDF, image_directory: dir }))
    const pdf = report.pdf as PdfReport
    const content = pdf.pages[0]!.content as { imagesDrawn: number; imageCoverage: number; uncountedOps: Record<string, number> }
    assert.equal(content.imagesDrawn, 1, 'Form 里的 Form 里画的图必须被数到')
    assert.equal(content.imageCoverage, 1)
    assert.deepEqual(content.uncountedOps, {})
    assert.equal(pdf.pages[0]!.errors!.length, 0, '内容流解析不该报错')
    assert.equal(pdf.classification, 'scanned')
    assert.equal(pdf.pages[0]!.images[0]!.name, '/Im0')
    assert.equal(pdf.images.exported.length, 1)
    assert.equal(pdf.images.exported[0]!.width, 24)
    // 覆盖整页：放置尺寸 = 页面尺寸（119.055×84.189 pt 的小图幅），说明 CTM 一路带进了内层 Form
    const placed = pdf.pages[0]!.images[0] as { placedWidth: number; placedHeight: number }
    assert.ok(Math.abs(placed.placedWidth - 119.055) < 0.01, `放置宽应等于页宽，实际 ${placed.placedWidth}`)
    assert.ok(Math.abs(placed.placedHeight - 84.189) < 0.01)
  })

  test('旋转扫描件：/Rotate 90 的页给的是**按显示效果整页渲染**的预览，不是躺倒的嵌入像素', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-rot-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: ROTATED_SCAN_PDF, image_directory: dir }))
    const pdf = report.pdf as PdfReport
    assert.equal(pdf.pages[0]!.rotation, 90)
    assert.equal(pdf.classification, 'scanned')
    const image = pdf.images.exported[0]!
    // 嵌入像素是横的（32×24）；用户看到的整页是竖的（MediaBox 119.055×84.189 转过 90°）
    assert.equal(image.source, 'rasterized', '带 /Rotate 的页不能只给嵌入像素')
    assert.equal(image.asDisplayed, true)
    assert.deepEqual(image.reason, ['page-rotation'])
    assert.ok(image.width! < image.height!, `旋转后应是竖版，实际 ${image.width}×${image.height}`)
    assert.ok(Math.abs(image.width! / image.height! - 84.189 / 119.055) < 0.02, '预览宽高比 = 页面转过 90° 的显示比例')
    assert.equal(image.rotateDegrees, 90)
    assert.ok(existsSync(image.path), '预览 PNG 必须真落盘')
    assert.equal(report.warnings.includes('PDF_IMAGE_RASTERIZED'), true)
    assert.equal(report.warnings.includes('PDF_IMAGE_NOT_AS_DISPLAYED'), false)
  })

  test('裁切扫描件：CropBox 小于 MediaBox → 预览按**裁切窗口**出图（不是整幅 MediaBox）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-crop-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: CROPPED_SCAN_PDF, image_directory: dir }))
    const pdf = report.pdf as PdfReport
    const page = pdf.pages[0]!
    assert.deepEqual(page.cropBox, [11.9055, 8.4189, 107.15, 75.7701])
    assert.notDeepEqual(page.cropBox, page.mediaBox, '这份夹具的 CropBox 必须与 MediaBox 不同')
    const image = pdf.images.exported[0]!
    assert.equal(image.source, 'rasterized')
    assert.equal(image.asDisplayed, true)
    assert.deepEqual(image.reason, ['crop-box'])
    // 150 dpi 下：裁切窗口 95.244×67.351 pt = 1.3228×0.9354 in → 198×140 px（整幅会是 248×175）
    assert.ok(Math.abs(image.width! - 198) <= 2, `预览宽应≈198（裁切后），实际 ${image.width}`)
    assert.ok(Math.abs(image.height! - 140) <= 2, `预览高应≈140（裁切后），实际 ${image.height}`)
  })

  test('栅格化不可用时的带旋转扫描页：给嵌入像素 + 显式变换 + PDF_IMAGE_NOT_AS_DISPLAYED（不冒充整页）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-nofb-'))
    const attached = await bootWithAttachments({ python: PYTHON, rasterizer: 'none' })
    try {
      const result = await callTool(attached.ctx, 'drawing_inspect', { path: ROTATED_SCAN_PDF, image_directory: dir })
      const report = drawingOf(result)
      const pdf = report.pdf as PdfReport
      const image = pdf.images.exported[0]!
      assert.equal(image.source, 'embedded', '没有栅格化工具时只能给嵌入像素')
      assert.equal(image.asDisplayed, false, '嵌入像素不许说成整页显示效果')
      assert.equal(image.rotateDegrees, 90, '必须给出显式变换所需的角度')
      assert.deepEqual(image.cropBox, pdf.pages[0]!.cropBox)
      assert.match(String(image.note), /嵌入像素|整页/)
      assert.equal(report.warnings.includes('PDF_IMAGE_NOT_AS_DISPLAYED'), true)
      // 附件说明也要带上"这些像素可能不含旋转/裁切/叠加"这层意思，不能只说"图来自扫描页"
      const summary = JSON.parse(valueOf<DrawingReport>(result).result) as { attachments: { note: string } }
      assert.match(summary.attachments.note, /嵌入原样像素|旋转|裁切/)
      assert.equal(attached.fake.saved.length, 1, '图确实进了附件，只是附的是嵌入像素')
    } finally {
      await attached.close()
    }
  })

  test('只分析了前若干页：scope 说清范围，不把没读过的页推断成同一种', async () => {
    const partial = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: TWO_PAGE_PDF, images: false, max_pages: 1 }))
    const pdf = partial.pdf as PdfReport
    // 第 1 页是矢量、第 2 页是扫描：只读第 1 页时不许说"整本都是矢量"
    assert.equal(pdf.format.pageCount, 2, '总页数照实保留')
    assert.equal(pdf.format.pagesAnalyzed, 1)
    assert.equal(pdf.classification, 'vector')
    assert.deepEqual(pdf.scope, {
      pagesTotal: 2, pagesAnalyzed: 1, unanalyzedPageCount: 1,
      classificationCovers: 'analyzed-pages-only', note: pdf.scope!.note,
    })
    assert.match(pdf.scope!.note, /不能推断|没有被读过/)
    assert.equal(partial.warnings.includes('PDF_CLASSIFICATION_PARTIAL'), true)
    assert.equal(partial.warnings.includes('PDF_PAGES_TRUNCATED'), true)
    // 对照：同样的文件整本读完就是 mixed → 证明上面那个 'vector' 确实只是第 1 页的结论
    const full = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: TWO_PAGE_PDF, images: false }))
    const fullPdf = full.pdf as PdfReport
    assert.equal(fullPdf.classification, 'mixed')
    assert.equal(fullPdf.scope!.classificationCovers, 'whole-document')
    assert.equal(fullPdf.scope!.unanalyzedPageCount, 0)
    assert.equal(full.warnings.includes('PDF_CLASSIFICATION_PARTIAL'), false)
    // 摘要里也带 scope（模型看 result 就知道结论覆盖到哪）
    const summary = JSON.parse(valueOf<DrawingReport>(await callTool(booted.ctx, 'drawing_inspect', { path: TWO_PAGE_PDF, images: false, max_pages: 1 })).result) as
      { pdf: { scope: { pagesTotal: number; pagesAnalyzed: number; classificationCovers: string } } }
    assert.deepEqual(summary.pdf.scope, {
      pagesTotal: 2, pagesAnalyzed: 1, unanalyzedPageCount: 1,
      classificationCovers: 'analyzed-pages-only', note: pdf.scope!.note,
    })
  })

  test('附件化过程中被取消：一张图都不交，也不留结果载体（DRAWING_CANCELLED）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drawing-cancel-'))
    const controller = new AbortController()
    // 取消精确地插在"图已经读出来、saveImage 已经进了"之后
    const attached = await bootWithAttachments({ python: PYTHON }, () => controller.abort())
    try {
      const result = await callTool(attached.ctx, 'drawing_inspect',
        { path: SCANNED_PDF, image_directory: dir }, undefined, controller.signal)
      const text = errorTextOf(result)
      assert.match(text, /DRAWING_CANCELLED/)
      assert.match(text, /附件化/)
      assert.equal(attached.fake.saved.length, 1, '取消发生在附件化之后（图确实被读过）')
      // 取消的结果：没有图像块交付，也没有可被 render 取回的结果载体
      const blocks = (result.content ?? []) as Array<{ type: string }>
      assert.equal(blocks.filter(block => block.type === 'image').length, 0)
      assert.equal(result.isError, true)
    } finally {
      await attached.close()
    }
  })

  test('DXF 走同一条分流：事实与 cad_inspect 完全一致（复用同一份解析）', async () => {
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: join(CAD_FIXTURES, 'plan-mm.dxf') }))
    assert.equal(report.kind, 'dxf')
    const dxf = report.dxf as CadReport
    assert.equal(dxf.units.insunits, 4)
    assert.equal(dxf.units.metresPerUnit, 0.001)
    assert.equal(dxf.counts.modelspaceEntities, 10)
    assert.equal(report.conversion, null)
    assert.equal(report.pdf, null)
    // 摘要里也带着同样的 units/counts（与 cad_inspect 的摘要同源）
    const summary = JSON.parse(valueOf<DrawingReport>(await callTool(booted.ctx, 'drawing_inspect', { path: join(CAD_FIXTURES, 'plan-mm.dxf') })).result) as
      { dxf: { units: unknown; counts: unknown } }
    assert.deepEqual(summary.dxf.units, dxf.units)
    assert.deepEqual(summary.dxf.counts, dxf.counts)
  })

  test('drawing_inspect.py 直接跨进程：矢量/扫描两个夹具的退出码与结果行都成立', () => {
    for (const [file, expected] of [[VECTOR_PDF, 'vector'], [SCANNED_PDF, 'scanned']] as const) {
      const run = spawnSync(PYTHON, ['-B', SCRIPT, '--input', file], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(run.status, 0, run.stderr)
      const line = (run.stdout ?? '').split('\n').find(item => item.startsWith(DRAWING_RESULT_PREFIX))!
      assert.ok(line, `应有结果行：${file}`)
      const report = JSON.parse(line.slice(DRAWING_RESULT_PREFIX.length)) as PdfReport
      assert.equal(report.classification, expected)
      assert.equal(report.units.metresKnown, false)
    }
    // 不是 PDF 时脚本自己也会拒绝（不依赖 TS 侧分流）
    const dxfRun = spawnSync(PYTHON, ['-B', SCRIPT, '--input', join(CAD_FIXTURES, 'plan-mm.dxf')], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(dxfRun.status, 3)
    const errorLine = (dxfRun.stdout ?? '').split('\n').find(item => item.startsWith(DRAWING_ERROR_PREFIX))!
    const payload = JSON.parse(errorLine.slice(DRAWING_ERROR_PREFIX.length)) as { error: { code: string; detected: string } }
    assert.equal(payload.error.code, 'PDF_HEADER_MISSING')
    assert.equal(payload.error.detected, 'dxf')
  })

  test('扫描页导出请求但栅格化被禁且嵌入图取不出时，如实报 PDF_IMAGE_EXPORT_FAILED（不交空图）', async () => {
    // 用一张"只有矢量、没有图像"的页面冒充扫描件是造不出来的（分类来自真实证据），
    // 所以这条只验证：请求 --image-dir 时矢量页不会被硬塞图像，而是逐页给出失败原因。
    const dir = await mkdtemp(join(tmpdir(), 'drawing-img-'))
    const run = spawnSync(PYTHON, ['-B', SCRIPT, '--input', VECTOR_PDF, '--image-dir', dir], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(run.status, 0, run.stderr)
    const line = (run.stdout ?? '').split('\n').find(item => item.startsWith(DRAWING_RESULT_PREFIX))!
    const report = JSON.parse(line.slice(DRAWING_RESULT_PREFIX.length)) as PdfReport
    assert.equal(report.images.exported.length, 0, '矢量页没有扫描图像可导')
    assert.deepEqual(report.images.requestedPages, [], '矢量页根本不在导图候选里')
  })
})

describe('DWG 转换与读图（需要 LYAPUNOV_TEST_DWG2DXF 的真 dwg2dxf）', { skip: hasConverter ? false : '未设置 LYAPUNOV_TEST_DWG2DXF' }, () => {
  let booted: Awaited<ReturnType<typeof bootContext>>
  before(async () => {
    booted = await bootContext({
      python: PYTHON || undefined,
      dwgConverter: { path: DWG2DXF, kind: 'libredwg', label: 'dwg2dxf (test)' },
    } as Parameters<typeof registerDrawingTools>[1])
  })
  after(async () => { await booted.close() })

  test('cad_convert：真 DWG 转出新 DXF，源文件一个字节没变，ezdxf 检验通过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-convert-'))
    const out = join(dir, 'converted.dxf')
    const before = await sha256(LINE_DWG)
    const conversion = conversionOf(await callTool(booted.ctx, 'cad_convert', { path: LINE_DWG, out }))
    assert.equal(conversion.sourceUnchanged, true)
    assert.equal(await sha256(LINE_DWG), before, '源 DWG 必须一个字节都没变')
    assert.equal(conversion.source.kind, 'dwg')
    assert.equal(conversion.source.dwgVersion?.code, 'AC1006')
    assert.equal(conversion.output.path, out)
    assert.ok(conversion.output.bytes > 100)
    assert.equal(conversion.output.format.binary, false)
    assert.ok(existsSync(out), '产物必须真的写出来')
    assert.match(conversion.converter.argv.join(' '), /dwg2dxf/)
    assert.equal(conversion.verification?.ok, true, JSON.stringify(conversion.verification))
    assert.ok((conversion.verification?.entityCount ?? 0) > 0)
    assert.equal(conversion.dxf?.units.presentInFile, false, 'R10 转出的 DXF 没有 $INSUNITS，单位必须报未知')
    assert.equal(conversion.dxf?.units.known, false)
  })

  test('真实工程图验收（example_2004.dwg，AC1018）：转出可读 DXF、事实齐全、转换损失可数', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-real-'))
    const out = join(dir, 'example-2004.dxf')
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: REAL_DWG, out }))
    assert.equal(report.kind, 'dwg')
    assert.equal(report.format.dwgVersion?.code, 'AC1018')
    assert.equal(report.format.dwgVersion?.release, 'AutoCAD Release 2004')
    // 转换：真产物、源文件不变、ezdxf 检验通过
    const conversion = report.conversion!
    assert.equal(conversion.verification?.ok, true, JSON.stringify(conversion.verification))
    assert.equal(conversion.sourceUnchanged, true)
    assert.equal(conversion.output.path, out)
    assert.ok(conversion.output.bytes > 100_000, `转出的 DXF 应远大于源（实际 ${conversion.output.bytes} 字节）`)
    // 图纸事实：2004 版样例图有真实规模（不是只有一条线的空壳）
    const dxf = report.dxf!
    assert.equal(dxf.units.insunits, 4, '图里写的就是毫米')
    assert.equal(dxf.units.metresPerUnit, 0.001)
    assert.ok(dxf.counts.modelspaceEntities! >= 50, `模型空间实体 ${dxf.counts.modelspaceEntities}`)
    assert.ok(dxf.counts.layers! >= 3)
    assert.ok(dxf.counts.blockDefinitions! >= 5)
    assert.ok(dxf.counts.curves! >= 10)
    assert.ok(dxf.counts.dimensions! >= 5)
    // **转换损失如实回执**：LibreDWG 对 MATERIAL/TABLESTYLE/ACAD_TABLE/DIMASSOC 这类对象
    // 是 Unstable/Unhandled——这就是"转成功≠转全"的证据，必须出现在报告里
    assert.ok(conversion.losses.length >= 10, `转换告警应有若干条，实际 ${conversion.losses.length}`)
    assert.ok(conversion.lossCategories.warning! >= 10)
    assert.ok(conversion.warnings.includes('DWG_CONVERTER_LOSSES'))
    assert.ok(conversion.losses.some(line => /Unhandled|Unstable|Ignore|Unknown/.test(line)),
      `告警里应含真实的 Unhandled/Unstable 条目，实际前几条：${conversion.losses.slice(0, 3).join(' | ')}`)
    // 摘要里也带着损失与检验结论（模型不必翻全文才知道丢没丢东西）
    const summary = JSON.parse(valueOf<DrawingReport>(await callTool(booted.ctx, 'drawing_inspect', { path: REAL_DWG, out: join(dir, 'again.dxf') })).result) as
      { conversion: { verification: { ok: boolean }; losses: unknown[] } }
    assert.equal(summary.conversion.verification.ok, true)
    assert.ok(summary.conversion.losses.length >= 10)
    // 再转一次（另一个落点，走 cad_convert 这条独立入口）：产物长度稳定，源文件仍然没动
    const third = join(dir, 'third.dxf')
    const again = conversionOf(await callTool(booted.ctx, 'cad_convert', { path: REAL_DWG, out: third }))
    assert.equal(again.verification?.ok, true)
    assert.equal(again.sourceUnchanged, true)
    const [first, second] = [await readFile(out), await readFile(third)]
    assert.equal(second.length, first.length, '同一源文件转两次，产物长度稳定')
    assert.equal(conversion.dxf!.counts.modelspaceEntities, again.dxf!.counts.modelspaceEntities)
  })

  test('cad_convert：输出已存在就拒绝覆盖（不悄悄盖掉别人的文件），overwrite=true 才原子替换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-convert-'))
    const out = join(dir, 'taken.dxf')
    await writeFile(out, 'someone else file')
    const text = errorTextOf(await callTool(booted.ctx, 'cad_convert', { path: LINE_DWG, out }))
    assert.match(text, /DWG_OUTPUT_EXISTS/)
    assert.equal(await readFile(out, 'utf8'), 'someone else file', '被拒绝时不能动那个文件')
    const conversion = conversionOf(await callTool(booted.ctx, 'cad_convert', { path: LINE_DWG, out, overwrite: true }))
    assert.equal(conversion.verification?.ok, true)
    const written = await readFile(out)
    assert.ok(written.length > 100, '这次真的写了转换产物')
    assert.notEqual(written.toString('utf8'), 'someone else file', 'overwrite=true 是替换，不是并存')
    assert.deepEqual(await scratchLeftovers(dir), [], '原子发布的临时名不能留在目标目录里')
  })

  test('发布不覆盖：硬链接不可用的文件系统改用独占创建（半路冒出来的 out 一个字节不变，也不留半成品）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-nolink-'))
    const out = join(dir, 'raced.dxf')
    const sentinel = 'caller 既有产物：不支持硬链接也不许被顶掉'
    const converter = { kind: 'libredwg' as const, bin: DWG2DXF, label: 'dwg2dxf (test)', args: null, source: 'config' as const }
    // 只在文件系统边界注入失败：link 报 EPERM——某些网络/FUSE/FAT 文件系统就是没有硬链接
    const noHardlink = async () => {
      const error = new Error('EPERM: operation not permitted, link') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    // 竞争场景（前置检查管不到的那一段）：out 在"检查之后、发布之前"被别的进程建出来——
    // 转换器顺手把调用方的 out 写上内容，再照常产出 DXF。发布时目标已经存在了。
    const racer = join(dir, 'racer.sh')
    await writeFile(racer, `#!/bin/sh\nprintf '%s' '${sentinel}' > '${out}'\nexec '${DWG2DXF}' -o "$2" "$3"\n`)
    await chmod(racer, 0o755)
    await assert.rejects(() => convertDwgToDxf({
      subprocess: booted.ctx.subprocess, file: LINE_DWG, output: out, python: PYTHON, publishLink: noHardlink,
      converter: { kind: 'command', bin: racer, label: 'racer', args: ['-o', '{out}', '{in}'], source: 'config' },
    }), (error: unknown) => error instanceof CadError && error.code === 'DWG_OUTPUT_EXISTS')
    assert.equal(await readFile(out, 'utf8'), sentinel, '硬链接不可用时也不许覆盖别人的文件（绝不能退到 rename）')
    assert.deepEqual(await scratchLeftovers(dir), [], '失败路径只许删自己这次的临时名')
    // 同一注入、目标始终没被别人建出来：用独占创建发布成功，产物是真的，并如实打告警
    const free = join(dir, 'free.dxf')
    const conversion = await convertDwgToDxf({
      subprocess: booted.ctx.subprocess, file: LINE_DWG, output: free, python: PYTHON, converter,
      publishLink: noHardlink,
    })
    assert.equal(conversion.verification?.ok, true, JSON.stringify(conversion.verification))
    assert.ok(conversion.warnings.includes('DWG_PUBLISH_EXCLUSIVE_CREATE'), '走了独占创建必须如实说出来')
    assert.ok((await readFile(free)).length > 100, '独占创建发布的是本次真产物')
    assert.deepEqual(await scratchLeftovers(dir), [], '独占创建成功也要清掉自己的临时名')
    // 对照：不注入（真实硬链接可用）时没有这条告警
    const plain = await convertDwgToDxf({
      subprocess: booted.ctx.subprocess, file: LINE_DWG, output: join(dir, 'normal.dxf'), python: PYTHON, converter,
    })
    assert.equal(plain.warnings.includes('DWG_PUBLISH_EXCLUSIVE_CREATE'), false, '硬链接可用时不该报独占创建')
  })

  test('cad_convert：out 与源是同一个文件（同路径 / symlink / 硬链接）→ 转换前就拒绝，原件一个字节不动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-alias-'))
    const source = join(dir, 'plan.dwg')
    const original = await readFile(LINE_DWG)
    await writeFile(source, original)
    const aliasCases: Array<[string, string]> = [['same-path', source]]
    const symlinkPath = join(dir, 'symlink.dxf')
    await symlink(source, symlinkPath)
    aliasCases.push(['symlink', symlinkPath])
    const hardlinkPath = join(dir, 'hardlink.dxf')
    await link(source, hardlinkPath)
    aliasCases.push(['hardlink', hardlinkPath])
    for (const [label, out] of aliasCases) {
      // 即便显式 overwrite=true 也必须拒绝：源文件不是"可以覆盖的输出"
      const text = errorTextOf(await callTool(booted.ctx, 'cad_convert', { path: source, out, overwrite: true }))
      assert.match(text, /DWG_OUTPUT_IS_SOURCE/, `${label} 必须被识别成"输出就是源文件"`)
      assert.deepEqual(await readFile(source), original, `${label}：源文件必须原样`)
    }
    // 源文件仍是可用的真 DWG（不是被转换器写过、也不是被清空）
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect',
      { path: source, out: join(dir, 'ok.dxf') }, { cwd: dir }))
    assert.equal(report.format.dwgVersion?.code, 'AC1006')
    assert.deepEqual(await readFile(source), original)
  })

  test('cad_convert：转换失败时调用方原有的 out 原样保留（不改已有文件、不留半成品）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-fail-keep-'))
    const out = join(dir, 'keep.dxf')
    const sentinel = 'caller 既有产物：不许被失败的一次转换动到'
    await writeFile(out, sentinel)
    const failing = join(dir, 'failing.sh')
    await writeFile(failing, '#!/bin/sh\necho "converter boom" >&2\nexit 3\n')
    await chmod(failing, 0o755)
    const failingCtx = await bootContext({
      python: PYTHON,
      dwgConverter: { path: failing, kind: 'command', args: ['-o', '{out}', '{in}'] },
    })
    try {
      const text = errorTextOf(await callTool(failingCtx.ctx, 'cad_convert', { path: LINE_DWG, out, overwrite: true }))
      assert.match(text, /DWG_CONVERT_FAILED/)
      assert.match(text, /converter boom/)
      assert.equal(await readFile(out, 'utf8'), sentinel, '失败一次不能删掉调用方原来的产物')
      assert.deepEqual(await scratchLeftovers(dir), [], '目标目录里不许留下本次的半成品')
    } finally {
      await failingCtx.close()
    }
  })

  test('cad_convert：转换进行中被取消 → 不改已有 out，本次产物也不发布', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-cancel-'))
    const out = join(dir, 'keep.dxf')
    const sentinel = 'caller 既有产物：取消也不许动'
    await writeFile(out, sentinel)
    const marker = join(dir, 'started.marker')
    const slow = join(dir, 'slow.sh')
    // 先留下"进程真的起来了"的标记再睡：取消点不靠猜时间
    await writeFile(slow, `#!/bin/sh\ntouch "${marker}"\nsleep 30\nexit 0\n`)
    await chmod(slow, 0o755)
    const slowCtx = await bootContext({
      python: PYTHON,
      dwgConverter: { path: slow, kind: 'command', args: ['-o', '{out}', '{in}'] },
    })
    const controller = new AbortController()
    try {
      const running = callTool(slowCtx.ctx, 'cad_convert', { path: LINE_DWG, out, overwrite: true }, undefined, controller.signal)
      for (let waited = 0; waited < 10_000 && !existsSync(marker); waited += 50)
        await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(existsSync(marker), '转换器进程必须真的起来了')
      controller.abort()
      const text = errorTextOf(await running)
      assert.match(text, /DWG_CONVERT_CANCELLED|DWG_CONVERT_FAILED/)
      assert.equal(await readFile(out, 'utf8'), sentinel, '取消不能动调用方原来的产物')
      assert.deepEqual(await scratchLeftovers(dir), [], '取消后目标目录里不许留残渣')
    } finally {
      await slowCtx.close()
    }
  })

  test('drawing_inspect：DWG 自动转成新 DXF 再读，报告里转换事实与 DXF 事实都在', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-inspect-'))
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: LINE_DWG, out: join(dir, 'auto.dxf') }, { cwd: dir }))
    assert.equal(report.kind, 'dwg')
    assert.equal(report.format.dwgVersion?.release, 'AutoCAD Release 10')
    assert.ok(report.conversion, 'DWG 分流必须带转换事实')
    assert.equal(report.conversion!.sourceUnchanged, true)
    assert.equal(report.conversion!.verification?.ok, true)
    assert.ok(report.dxf, '转出的 DXF 事实必须一起给出')
    assert.equal(report.dxf!.counts.modelspaceEntities > 0, true)
    assert.equal(report.conversion!.output.path, join(dir, 'auto.dxf'))
    // 产物落在调用方指定的位置；源文件仍在原处
    assert.ok(existsSync(join(dir, 'auto.dxf')))
  })

  test('drawing_inspect：默认落点按源文件 sha 派生（可复用、不踩别人），源文件仍不变', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dwg-ws-'))
    const before = await sha256(DIM_DWG)
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: DIM_DWG }, { cwd }))
    assert.equal(report.kind, 'dwg')
    const out = report.conversion!.output.path
    assert.equal(dirname(out), join(cwd, 'cad-converted'))
    assert.match(out, /dim-r26-[0-9a-f]{8}\.dxf$/, `默认落点应按源 sha 派生：${out}`)
    assert.equal(await sha256(DIM_DWG), before)
    // R2.6 的图有 9 个实体（圆/标注/弧/线），转出来要能读
    assert.equal(report.conversion!.verification?.ok, true, JSON.stringify(report.conversion!.verification))
    assert.ok((report.dxf!.counts.modelspaceEntities ?? 0) > 0)
  })

  test('转换损失：转出的 DXF 读不出来时不发布（DWG_CONVERTED_UNREADABLE + 暂存产物点名），目标不受影响', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-lossy-'))
    const out = join(dir, 'entities.dxf')
    const sentinel = 'caller 既有产物：检验不过就不许替换'
    await writeFile(out, sentinel)
    // 单独走 cad_convert：转换器退出码 0，但 ezdxf 读不出来 → 检验不过 → 不发布
    const text = errorTextOf(await callTool(booted.ctx, 'cad_convert', { path: ENTITIES_DWG, out, overwrite: true }))
    assert.match(text, /DWG_CONVERTED_UNREADABLE/)
    assert.match(text, /CAD_PARSE_FAILED|无法读取/, '要带 ezdxf 的真实错因，不拿退出码 0 当读懂')
    assert.equal(await readFile(out, 'utf8'), sentinel, '检验没过就不能用掉 overwrite 授权')
    // 转换确实产出了东西，只是没发布：暂存路径被点名，产物还在（便于排查、也证明不是"没转"）
    const staged = /\S*lyapunov-dwg-[^\s"\\]*\.dxf/.exec(text)?.[0]
    assert.ok(staged, `错误回执里应点名暂存产物路径：${text.slice(0, 400)}`)
    assert.ok(existsSync(staged), `暂存产物应保留：${staged}`)
    assert.ok((await readFile(staged)).length > 0)
    assert.deepEqual(await scratchLeftovers(dir), [], '目标目录里不留残渣')
    // 分流入口：读不出来就是读不出来，不返回空的"成功"
    const inspectText = errorTextOf(await callTool(booted.ctx, 'drawing_inspect', { path: ENTITIES_DWG, out: join(dir, 'again.dxf') }))
    assert.match(inspectText, /DWG_CONVERTED_UNREADABLE/)
    assert.equal(existsSync(join(dir, 'again.dxf')), false, '分流入口也不许把读不出来的产物落到目标')
  })

  test('command 模板转换器：同一条真实 dwg2dxf 用 {in}/{out} 模板跑通（转换器只看得到暂存路径）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-template-'))
    const out = join(dir, 'template.dxf')
    const conversion = await convertDwgToDxf({
      subprocess: booted.ctx.subprocess,
      file: LINE_DWG, output: out, python: PYTHON,
      converter: { kind: 'command', bin: DWG2DXF, label: 'dwg2dxf via template', args: ['-y', '-o', '{out}', '{in}'], source: 'config' },
    })
    assert.equal(conversion.verification?.ok, true)
    // 转换器的 -o 拿到的是**本次自己的暂存路径**（不是调用方的 out），源文件是最后一个参数
    const argv = conversion.converter.argv
    assert.deepEqual(argv.slice(0, 3), [DWG2DXF, '-y', '-o'])
    assert.equal(argv[argv.length - 1], LINE_DWG)
    assert.notEqual(argv[3], out, '转换器不该拿到调用方的目标路径')
    assert.match(argv[3]!, /template\.dxf$/)
    assert.equal(conversion.output.path, out, '发布之后报告的产物就是调用方要的路径')
    assert.ok(existsSync(out))
    // 成功的这一趟：自己的暂存目录清干净了（成功不留临时目录）
    assert.equal(existsSync(dirname(argv[3]!)), false, '成功发布后暂存目录应被清掉')
    // 模板缺占位符必须明确报错，不能拼出一个乱命令
    await assert.rejects(() => convertDwgToDxf({
      subprocess: booted.ctx.subprocess, file: LINE_DWG, output: join(dir, 'x.dxf'), python: PYTHON,
      converter: { kind: 'command', bin: DWG2DXF, label: 'bad', args: ['--oops'], source: 'config' },
    }), (error: unknown) => error instanceof CadError && error.code === 'DWG_CONVERTER_TEMPLATE_INVALID')
  })

  test('转换损耗明细：libredwg 的告警进入 losses 分类（有告警时必带 DWG_CONVERTER_LOSSES）', async () => {
    const { spawnSync: run } = await import('node:child_process')
    const probe = run(DWG2DXF, ['-o', join(await mkdtemp(join(tmpdir(), 'dwg-warn-')), 'x.dxf'),
      join(HERE, '..', '..', '..', '.upstream', 'nonexistent.dwg')], { encoding: 'utf8' })
    assert.notEqual(probe.status, 0, '不存在的输入必须失败（这里只为确认工具本身在跑）')
    const dir = await mkdtemp(join(tmpdir(), 'dwg-dim-'))
    const conversion = conversionOf(await callTool(booted.ctx, 'cad_convert', { path: DIM_DWG, out: join(dir, 'dim.dxf') }))
    // R2.6 的文件告警很少甚至没有：没有告警就不许谎报有；有告警则必须分类计数
    if (conversion.losses.length > 0) {
      assert.ok(Object.keys(conversion.lossCategories).length > 0)
      assert.match(conversion.warnings.join(','), /DWG_CONVERTER_LOSSES/)
    } else {
      assert.deepEqual(conversion.losses, [])
      assert.equal(conversion.warnings.includes('DWG_CONVERTER_LOSSES'), false)
    }
  })

  test('转换中途的源文件保护：源被改动就撤下本次产物并报 DWG_SOURCE_MODIFIED（已有 out 也不动）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dwg-protect-'))
    const source = join(dir, 'fake.dwg')
    const out = join(dir, 'out.dxf')
    const sentinel = 'caller 既有产物'
    await writeFile(out, sentinel)
    // 真实 DWG 的头 + 会被"转换器"改写的源：用命令行模板跑一个会写源文件的脚本
    const script = join(dir, 'sneaky.sh')
    await writeFile(script, `#!/bin/sh\nout="$2"\nsrc="$3"\necho "writing"\necho "tampered" >> "$src"\nprintf '0\\nSECTION\\n2\\nENTITIES\\n0\\nENDSEC\\n0\\nEOF\\n' > "$out"\n`)
    await chmod(script, 0o755)
    const sourceBytes = await readFile(LINE_DWG)
    await writeFile(source, sourceBytes)
    await assert.rejects(() => convertDwgToDxf({
      subprocess: booted.ctx.subprocess, file: source, output: out, python: PYTHON, overwrite: true,
      converter: { kind: 'command', bin: script, label: 'sneaky', args: ['-o', '{out}', '{in}'], source: 'config' },
    }), (error: unknown) => error instanceof CadError && error.code === 'DWG_SOURCE_MODIFIED')
    assert.equal(await readFile(out, 'utf8'), sentinel, '源被改动也不许动调用方既有的 out')
    assert.deepEqual(await scratchLeftovers(dir), [], '本次的半成品撤下后不留残渣')
  })
})

/**
 * ENV-13：几何约束（constraints）与缺项假设（assumptions）。
 * 三条负例都是真跑：① 单位未声明 → 一条米制约束都没有，且 UNIT_UNDECLARED 假设给出 why；
 * ② 同一个文件补上单位声明 → 那条假设消失、米制条目出现且能按 source 回查；
 * ③ 没有解释器 → 仍然是 CAD_PYTHON_UNCONFIGURED，不给半份报告。
 */
describe('几何约束与缺项假设（需要 LYAPUNOV_CAD_PYTHON）', { skip: hasPython ? false : '未设置 LYAPUNOV_CAD_PYTHON' }, () => {
  let booted: Awaited<ReturnType<typeof bootContext>>
  before(async () => { booted = await bootContext({ python: PYTHON }) })
  after(async () => { await booted.close() })

  const UNITLESS_DXF = join(CAD_FIXTURES, 'plan-unitless.dxf')
  const MM_DXF = join(CAD_FIXTURES, 'plan-mm.dxf')

  function assumptionOf(report: DrawingReport, code: string) {
    return report.assumptions.find(item => item.code === code)
  }

  function approx(actual: number, expected: number, epsilon: number, label: string): void {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${label} 期望 ${expected}±${epsilon}，实际 ${actual}`)
  }

  test('负例①：单位未声明 → 没有任何米制约束，UNIT_UNDECLARED 假设说明缺的是哪一个事实', async () => {
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: UNITLESS_DXF }))
    assert.equal(report.kind, 'dxf')
    assert.equal(report.dxf!.units.known, false, '这个夹具本身就是"文件里没声明单位"')
    assert.deepEqual(report.constraints, [], '单位未知时不许产出任何约束条目（更不许把图纸单位当米）')
    const undeclared = assumptionOf(report, 'UNIT_UNDECLARED')
    assert.ok(undeclared, '必须给出 UNIT_UNDECLARED 假设')
    assert.match(undeclared.why, /units\.known=false/, 'why 要指出报告里缺的是哪个字段')
    assert.match(undeclared.why, /单位声明/)
    for (const code of ['NO_ELEVATION', 'NO_STOREY_HEIGHT', 'NO_THICKNESS'])
      assert.ok(assumptionOf(report, code), `缺项 ${code} 也要逐条声明（不拿范围长度/纸高顶替）`)
    // 摘要文本里真的带着这两组事实（模型读到的就是这段文本）
    const summary = JSON.parse(valueOf<DrawingReport>(await callTool(booted.ctx, 'drawing_inspect', { path: UNITLESS_DXF })).result) as
      { constraints: unknown[]; assumptions: Array<{ code: string }> }
    assert.deepEqual(summary.constraints, [])
    assert.equal(summary.assumptions.some(item => item.code === 'UNIT_UNDECLARED'), true)
  })

  test('负例②：同一个文件补上单位声明 → 假设消失、米制约束出现且按 source 可回查', async () => {
    const report = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: UNITLESS_DXF, unit: 'mm' }))
    const units = report.dxf!.units
    assert.equal(units.known, true)
    assert.equal(units.source, 'caller', '这条走的是"调用方显式声明"')
    assert.equal(assumptionOf(report, 'UNIT_UNDECLARED'), undefined, '单位声明补上后这条假设不许再出现')
    const sizeMetres = report.dxf!.bounds.sizeMetres!
    const sizeDrawing = report.dxf!.bounds.sizeDrawingUnits!
    assert.equal(report.constraints.length, sizeMetres.length, '每个真实轴范围各一条')
    report.constraints.forEach((item, index) => {
      assert.equal(item.axis, ['x', 'y', 'z'][index])
      assert.equal(item.unit, 'm')
      assert.equal(item.source, `dxf.bounds.sizeMetres[${index}]`)
      assert.equal(item.pageRef, 0, 'DXF 没有页概念，用 0 表示唯一图纸')
      approx(item.value, sizeMetres[index]!, 1e-12, `constraints[${index}].value`)
      // 与"图纸单位读数 × m/单位"独立对一次：证明不是照抄别的字段
      approx(item.value, sizeDrawing[index]! * units.metresPerUnit!, 1e-9, `constraints[${index}] 与图纸单位换算`)
    })
    assert.ok(report.constraints[0]!.value > 0 && report.constraints[1]!.value > 0, '平面两轴范围是正数')
    // 文件头自己声明单位的夹具同样不该出现那条假设
    const declared = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: MM_DXF }))
    assert.equal(declared.dxf!.units.source, 'header')
    assert.equal(assumptionOf(declared, 'UNIT_UNDECLARED'), undefined)
    assert.equal(declared.constraints.length, declared.dxf!.bounds.sizeMetres!.length)
    assert.ok(declared.constraints.every(item => item.unit === 'm'))
  })

  test('真实矢量 PDF：纸面毫米/点约束照给，没比例尺不给建筑米制；给了比例尺就补上米制条目', async () => {
    const plain = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: VECTOR_PDF, images: false }))
    const page = plain.pdf!.pages[0]!
    assert.equal(plain.pdf!.units.metresKnown, false)
    const mm = plain.constraints.filter(item => item.unit === 'mm')
    assert.deepEqual(mm.map(item => item.value), [page.size!.widthMm, page.size!.heightMm], '纸面毫米要等于真实页尺寸')
    // pageRef/source 用报告自己的页序号（pdf.pages[].index 从 1 开始），不另起一套编号
    assert.deepEqual(mm.map(item => item.source),
      [`pdf.pages[${page.index}].size.widthMm`, `pdf.pages[${page.index}].size.heightMm`])
    assert.ok(mm.every(item => item.pageRef === page.index))
    const box = page.cropBox ?? page.mediaBox!
    const pt = plain.constraints.filter(item => item.unit === 'pt')
    assert.deepEqual(pt.map(item => item.value), [box[2]! - box[0]!, box[3]! - box[1]!], '点约束来自真实页面盒')
    assert.equal(pt[0]!.source, `pdf.pages[${page.index}].${page.cropBox ? 'cropBox' : 'mediaBox'}`)
    assert.equal(plain.constraints.some(item => item.unit === 'm'), false, '没有比例尺就不许有米制条目')
    const undeclared = assumptionOf(plain, 'UNIT_UNDECLARED')
    assert.ok(undeclared, '没比例尺必须声明 UNIT_UNDECLARED')
    assert.match(undeclared.why, /metresKnown=false/)

    const scaled = drawingOf(await callTool(booted.ctx, 'drawing_inspect', { path: VECTOR_PDF, images: false, scale: '1:100' }))
    assert.equal(scaled.pdf!.units.metresKnown, true)
    assert.equal(scaled.pdf!.units.metresSource, 'caller-scale')
    assert.equal(assumptionOf(scaled, 'UNIT_UNDECLARED'), undefined, '给了比例尺这条假设就不许再出现')
    const metres = scaled.constraints.filter(item => item.unit === 'm')
    const bbox = scaled.pdf!.vector.bboxMetresByCallerScale!
    assert.deepEqual(metres.map(item => item.axis), ['x', 'y'])
    approx(metres[0]!.value, bbox[2]! - bbox[0]!, 1e-9, 'm 约束 x 来自 bbox 范围')
    approx(metres[1]!.value, bbox[3]! - bbox[1]!, 1e-9, 'm 约束 y 来自 bbox 范围')
    assert.equal(metres[0]!.source, 'pdf.vector.bboxMetresByCallerScale')
    assert.equal(metres[0]!.pageRef, page.index, 'PDF 侧 pageRef 用报告里的页序号')
  })

  test('负例③：没有解释器 → CAD_PYTHON_UNCONFIGURED（不给半份报告，也不猜解释器）', async () => {
    const saved = process.env.LYAPUNOV_CAD_PYTHON
    delete process.env.LYAPUNOV_CAD_PYTHON
    const bare = await bootContext()
    try {
      assert.match(errorTextOf(await callTool(bare.ctx, 'drawing_inspect', { path: VECTOR_PDF, images: false })),
        /CAD_PYTHON_UNCONFIGURED/)
      assert.match(errorTextOf(await callTool(bare.ctx, 'drawing_inspect', { path: MM_DXF })), /CAD_PYTHON_UNCONFIGURED/)
    } finally {
      if (saved !== undefined) process.env.LYAPUNOV_CAD_PYTHON = saved
      await bare.close()
    }
  })

  test('契约校验：缺 constraints/assumptions、或 source/why 为空的条目都要被拒（不是装饰性字段）', () => {
    const base = {
      ok: true as const, kind: 'dxf' as const,
      file: { path: 'x.dxf', name: 'x.dxf', bytes: 1, sha256: 'a'.repeat(64) },
      format: {} as never, dxf: {} as never, conversion: null, pdf: null, warnings: [] as string[],
    }
    assert.throws(() => assertDrawingReport(base, 'x.dxf'), (error: unknown) =>
      error instanceof CadError && error.code === 'DRAWING_OUTPUT_INVALID' && /constraints\/assumptions/.test(error.message))
    assert.throws(() => assertDrawingReport(
      { ...base, constraints: [{ axis: 'x', value: 1, unit: 'm', source: '', pageRef: 0 }], assumptions: [] }, 'x.dxf'),
      (error: unknown) => error instanceof CadError && error.code === 'DRAWING_OUTPUT_INVALID')
    assert.throws(() => assertDrawingReport(
      { ...base, constraints: [], assumptions: [{ code: 'NO_THICKNESS', detail: 'd', why: '' }] }, 'x.dxf'),
      (error: unknown) => error instanceof CadError && error.code === 'DRAWING_OUTPUT_INVALID')
    // 已确认尺寸没有稳定摘要 → 也拒（否则"变没变"无从判定）
    assert.throws(() => assertDrawingReport(
      { ...base, constraints: [], assumptions: [] }, 'x.dxf'),
      (error: unknown) => error instanceof CadError && error.code === 'DRAWING_OUTPUT_INVALID'
        && /constraintsDigest/.test(error.message))
    assert.equal(assertDrawingReport({
      ...base, constraints: [], constraintsDigest: constraintsDigest([]),
      assumptions: [{ code: 'UNIT_UNDECLARED', detail: 'd', why: 'w' }],
    }, 'x.dxf').ok, true)
  })
})

/**
 * ENV-14：把"已确认的尺寸"做成**可比较的稳定产物**（`constraintsDigest`）并给出**变更前后判定**
 * （`compareConstraints` / `drawing_constraints_check`）。
 *  · 正例：**风格变更**（图层颜色/线型/文字样式变了，逐顶点几何指纹一致）后，已确认尺寸逐条未变；
 *  · 负对照：**几何变更**（全部实体 ×1.5）后必须判"已变"并点名是哪一条——证明判定不是恒真；
 *  · 不给基线必须拒绝（没有"已确认"就没有"未变"）。
 */
describe('已确认尺寸的稳定产物与变更前后判定（ENV-14）', { skip: hasPython ? false : '未设置 LYAPUNOV_CAD_PYTHON' }, () => {
  let booted: Awaited<ReturnType<typeof bootContext>>
  before(async () => { booted = await bootContext({ python: PYTHON }) })
  after(async () => { await booted.close() })

  const L_SHAPE = join(CAD_FIXTURES, 'plan-l-shape.dxf')
  // 两个变体由本 lane 用真实 ezdxf 从同一张图生成（脚本 .runtime/lane-env14/make-variants.py）：
  //  · restyled：只改图层颜色/线型/文字样式，逐顶点几何指纹与原件**一致**；
  //  · scaled150：全部实体 ×1.5，几何指纹**已变**。
  const RESTYLED = join(FIXTURES, 'env14-l-shape-restyled.dxf')
  const SCALED = join(FIXTURES, 'env14-l-shape-scaled150.dxf')

  const constraint = (axis: 'x' | 'y' | 'z', value: number, source: string, pageRef = 0, unit: 'm' | 'mm' = 'm') =>
    ({ axis, value, unit, source, pageRef })

  /** detail='full' 的调用给的是整份 report（不是摘要），所以走契约校验而不是摘要一致性断言。 */
  const fullReportOf = (result: ToolExecutionResult): DrawingReport => {
    const { report } = valueOf<DrawingReport>(result)
    return assertDrawingReport(report, report.file?.path ?? '')
  }

  test('纯函数：摘要对值/单位/来源/页/轴任一处变化都敏感，条目顺序不影响', () => {
    const a = [constraint('x', 6.75, 'dxf.bounds.sizeMetres[0]'), constraint('y', 6, 'dxf.bounds.sizeMetres[1]')]
    const reordered = [a[1]!, a[0]!]
    assert.equal(constraintsDigest(a), constraintsDigest(reordered), '条目顺序不该影响摘要')
    assert.equal(constraintsDigest(a).length, 64)
    const variants = [
      [constraint('x', 6.76, 'dxf.bounds.sizeMetres[0]'), a[1]!],
      [constraint('x', 6.75, 'dxf.bounds.sizeMetres[0]', 0, 'mm'), a[1]!],
      [constraint('x', 6.75, 'dxf.bounds.sizeMetres[0].other'), a[1]!],
      [constraint('x', 6.75, 'dxf.bounds.sizeMetres[0]', 1), a[1]!],
      [constraint('z', 6.75, 'dxf.bounds.sizeMetres[0]'), a[1]!],
    ]
    for (const [index, variant] of variants.entries())
      assert.notEqual(constraintsDigest(variant), constraintsDigest(a), `第 ${index} 种变化必须让摘要变`)
  })

  test('纯函数：数量一样但值变了、或丢了一条/多了一条，都不算"未变"', () => {
    const before = [constraint('x', 6.75, 'dxf.bounds.sizeMetres[0]'), constraint('y', 6, 'dxf.bounds.sizeMetres[1]')]
    const sameValues = compareConstraints(before, [...before])
    assert.equal(sameValues.unchanged, true)
    assert.equal(sameValues.equal.length, 2)
    const valueChanged = compareConstraints(before, [constraint('x', 10.125, 'dxf.bounds.sizeMetres[0]'), before[1]!])
    assert.equal(valueChanged.unchanged, false, '数量一样但值变了 → 必须判已变')
    assert.deepEqual(valueChanged.changed.map(item => [item.before.value, item.after.value]), [[6.75, 10.125]])
    const removed = compareConstraints(before, [before[0]!])
    assert.equal(removed.unchanged, false)
    assert.deepEqual(removed.removed.map(item => item.axis), ['y'])
    const added = compareConstraints(before, [...before, constraint('z', 0, 'dxf.bounds.sizeMetres[2]')])
    assert.equal(added.unchanged, false)
    assert.deepEqual(added.added.map(item => item.axis), ['z'])
  })

  test('真实链正例：风格变更（图层颜色/线型/文字样式）后已确认尺寸逐条未变', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const restyled = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: RESTYLED, detail: 'full' }))
    // 风格确实变了（图层颜色/线型），几何事实没变（同一份逐顶点范围）
    assert.notDeepEqual(
      restyled.dxf!.layers.map(layer => [layer.name, layer.color, layer.linetype]),
      baseline.dxf!.layers.map(layer => [layer.name, layer.color, layer.linetype]),
      '这个夹具必须是"风格真的变了"')
    assert.deepEqual(restyled.dxf!.bounds.sizeDrawingUnits, baseline.dxf!.bounds.sizeDrawingUnits,
      '风格变体的几何范围必须与原图一致')
    assert.equal(restyled.constraintsDigest, baseline.constraintsDigest, '风格变更不该改变已确认尺寸的摘要')
    const checked = valueOf<{ unchanged: boolean; equalCount: number; digestBefore: string; digestAfter: string; verdict: string }>(
      await callTool(booted.ctx, 'drawing_constraints_check', { path: RESTYLED, expect_constraints: baseline.constraints }))
    const report = JSON.parse(checked.result) as {
      unchanged: boolean; equalCount: number; digestBefore: string; digestAfter: string; verdict: string }
    assert.equal(report.unchanged, true)
    assert.equal(report.equalCount, baseline.constraints.length, '逐条一致数 = 基线条目数')
    assert.equal(report.digestBefore, report.digestAfter)
    assert.match(report.verdict, /尺寸约束未变/)
  })

  test('真实链负对照：几何变更（×1.5）后判定"已变"并点名 x/y（判定不是恒真）', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const scaled = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: SCALED, detail: 'full' }))
    assert.notEqual(scaled.constraintsDigest, baseline.constraintsDigest)
    const checked = valueOf<{ unchanged: boolean; changed: Array<{ before: { value: number }; after: { value: number } }> }>(
      await callTool(booted.ctx, 'drawing_constraints_check', { path: SCALED, expect_constraints: baseline.constraints }))
    const report = JSON.parse(checked.result) as {
      unchanged: boolean; verdict: string
      changed: Array<{ before: { axis: string; value: number }; after: { axis: string; value: number } }>
    }
    assert.equal(report.unchanged, false, '几何真变了就必须判已变')
    assert.deepEqual(report.changed.map(item => [item.before.axis, item.before.value, item.after.value]),
      [['x', 6.75, 10.125], ['y', 6, 9]])
    assert.match(report.verdict, /尺寸约束已变/)
    assert.match(report.verdict, /10\.125/)
    // 只给摘要也能判"变没变"（同一张图未变 / 缩放图已变）
    const digestOnlySame = JSON.parse(valueOf<{ unchanged: boolean; baseline: string }>(
      await callTool(booted.ctx, 'drawing_constraints_check',
        { path: L_SHAPE, expect_digest: baseline.constraintsDigest })).result) as { unchanged: boolean; baseline: string }
    assert.equal(digestOnlySame.unchanged, true)
    assert.equal(digestOnlySame.baseline, 'expect_digest')
    const digestOnlyScaled = JSON.parse(valueOf<{ unchanged: boolean }>(
      await callTool(booted.ctx, 'drawing_constraints_check',
        { path: SCALED, expect_digest: baseline.constraintsDigest })).result) as { unchanged: boolean }
    assert.equal(digestOnlyScaled.unchanged, false)
  })

  test('不给基线：drawing_constraints_check 报 CONSTRAINTS_BASELINE_REQUIRED（不默认"没变"）', async () => {
    const text = errorTextOf(await callTool(booted.ctx, 'drawing_constraints_check', { path: L_SHAPE }))
    assert.match(text, /CONSTRAINTS_BASELINE_REQUIRED/)
    assert.match(text, /expect_digest|expect_constraints/)
  })

  /**
   * ENV-14 Round 3：`openings[]` + `factsDigest(dimensions, openings)` 的**双桶**四态。
   * 变体由 `.runtime/lane-env14b/analysis/make-door-variant.py` 用真实 ezdxf 生成：
   * 只对 `DOORS` 图层 ×2（整体包围盒不变）⇒ 开口桶必须点名，尺寸桶不该跟着变。
   */
  const DOOR_WIDER = join(FIXTURES, 'env14-l-shape-door-wider.dxf')

  test('真实链正例（双桶）：开口被折算出来，且风格变更后两桶都未变、factsDigest 逐字相同', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const restyled = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: RESTYLED, detail: 'full' }))
    // 开口由真实图层几何折算：真实夹具有 DOORS 图层（0.9 m 跨度）
    assert.equal(baseline.openings.length, 1, '基线必须折算出一处开口')
    assert.deepEqual(baseline.openings[0], {
      kind: 'door', layerName: 'DOORS', axis: 'x', spanM: 0.9, count: 1, sourceRef: 'dxf.layerBounds[3].sizes[0]',
      originM: [3, 3],
    })
    const facts = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: restyled.constraints, openings: restyled.openings, openingSkips: restyled.openingSkips })
    assert.equal(facts.dimensions.unchanged, true)
    assert.equal(facts.openings.unchanged, true, '风格变更不该动开口')
    assert.equal(facts.unchanged, true)
    assert.equal(facts.factsDigestBefore, facts.factsDigestAfter, '合并摘要必须逐字相同')
    assert.equal(facts.factsDigestBefore, baseline.factsDigest)
    // 三个摘要都可重算（不是随手存的字符串）
    assert.equal(constraintsDigest(baseline.constraints), baseline.constraintsDigest)
    assert.equal(openingsDigest(baseline.openings), baseline.openingsDigest)
    assert.equal(factsDigest(baseline.constraints, baseline.openings), baseline.factsDigest)
    // 连接：明文不承载（null + why），不填 0
    assert.equal(facts.connections, null)
    assert.equal(facts.connectionsWhy, DRAWING_CONNECTIONS_UNAVAILABLE_WHY)
  })

  test('真实链负对照（开口桶）：只改开口（DOORS ×2）⇒ 点名该 opening，尺寸桶不动', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const wider = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: DOOR_WIDER, detail: 'full' }))
    assert.deepEqual(wider.dxf!.bounds.sizeDrawingUnits, baseline.dxf!.bounds.sizeDrawingUnits,
      '这个夹具的整体范围必须与原件一致（只改开口）')
    const checked = valueOf<unknown>(await callTool(booted.ctx, 'drawing_constraints_check',
      { path: DOOR_WIDER, expect_constraints: baseline.constraints, expect_openings: baseline.openings }))
    const report = JSON.parse(checked.result) as {
      unchanged: boolean; verdict: string; factsDigestBefore: string; factsDigestAfter: string
      openingsChanged: Array<{ before: { kind: string; layerName: string; spanM: number }; after: { spanM: number } }>
      changed: unknown[]; connections: null; connectionsWhy: string
    }
    assert.equal(report.unchanged, false, '改开口必须判"已变"')
    assert.deepEqual(report.changed, [], '尺寸桶不该跟着变')
    assert.deepEqual(report.openingsChanged.map(item => [item.before.kind, item.before.layerName, item.before.spanM, item.after.spanM]),
      [['door', 'DOORS', 0.9, 1.8]], '必须点名是哪个开口、从多少变到多少')
    assert.match(report.verdict, /开口变了/)
    assert.match(report.verdict, /1\.8/)
    assert.notEqual(report.factsDigestBefore, report.factsDigestAfter)
    assert.equal(report.connections, null)
    assert.match(report.connectionsWhy, /没有构件拓扑/)
    // 只给合并摘要也能判"变没变"，但不能点名
    const digestOnly = JSON.parse(valueOf<{ unchanged: boolean; baseline: string }>(
      await callTool(booted.ctx, 'drawing_constraints_check',
        { path: DOOR_WIDER, expect_facts_digest: baseline.factsDigest })).result) as { unchanged: boolean; baseline: string }
    assert.equal(digestOnly.unchanged, false)
    assert.equal(digestOnly.baseline, 'expect_facts_digest')
    const digestOnlySame = JSON.parse(valueOf<{ unchanged: boolean }>(
      await callTool(booted.ctx, 'drawing_constraints_check',
        { path: L_SHAPE, expect_facts_digest: baseline.factsDigest })).result) as { unchanged: boolean }
    assert.equal(digestOnlySame.unchanged, true, '同一张图同一份摘要必须判"未变"')
  })

  test('真实链负对照（尺寸桶，双桶口径）：×1.5 既有名尺寸也有名开口', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: L_SHAPE, detail: 'full' }))
    const checked = valueOf<unknown>(await callTool(booted.ctx, 'drawing_constraints_check',
      { path: SCALED, expect_constraints: baseline.constraints, expect_openings: baseline.openings }))
    const report = JSON.parse(checked.result) as {
      unchanged: boolean; changed: Array<{ before: { axis: string; value: number }; after: { value: number } }>
      openingsChanged: Array<{ before: { spanM: number }; after: { spanM: number } }>
    }
    assert.equal(report.unchanged, false)
    assert.deepEqual(report.changed.map(item => [item.before.axis, item.before.value, item.after.value]),
      [['x', 6.75, 10.125], ['y', 6, 9]])
    assert.deepEqual(report.openingsChanged.map(item => [item.before.spanM, item.after.spanM]), [[0.9, 1.35]],
      '整体缩放同样会改开口跨度——两桶都如实报，不藏')
  })

  /**
   * N310-R5（task-343 reopen）：复核方（task-350 / Round 233）三条反例形态的回归。
   * 夹具由 `packages/blender/test/drawing-fixtures/SOURCE.md` 记的生成脚本从**真实图**
   * `cad-fixtures/plan-l-shape.dxf` 派生（自建三图层，见该文件）：
   *  · `MY-DOORS-EMPTY` 空图层：必须在 `openingSkips` 里给 `OPENING_LAYER_EMPTY_IGNORED`
   *    （旧行为：整层从报告里消失，连"被忽略"都没有）；
   *  · `MY-DOORS-ZERO` 零长度线段层：必须给 `OPENING_LAYER_DEGENERATE`，且**不得**出现 `spanM:0` 的开口
   *    （旧行为：报成 `{spanM:0,count:1}` 且改动 factsDigest）；
   *  · `MY-DOORS` 同层两处开口：必须各成一条（旧行为：合并成 `{spanM:2.7,count:2}`）；
   *  · **层内加宽**（1.1 m → 1.7 m，该层包围盒与全局包围盒都不变）：必须点名该开口
   *    （旧行为：`unchanged:true`、`changed:[]` —— 层包围盒没变就查不出来）。
   */
  const REVIEW_BASE = join(FIXTURES, 'env14-review-doors-base.dxf')
  const REVIEW_WIDER = join(FIXTURES, 'env14-review-doors-wider.dxf')
  const REVIEW_MOVED = join(FIXTURES, 'env14-review-doors-moved.dxf')
  const myDoorLayerBounds = (report: DrawingReport) =>
    ((report.dxf as unknown as { layerBounds?: Array<{ layer: string; bounds: { min: number[]; max: number[] } | null }> })
      .layerBounds ?? []).find(row => row.layer === 'MY-DOORS')?.bounds ?? null

  test('反例（空层/零跨度层/同层两处）：不静默省略、不写成 0 m 开口、不合并', async () => {
    const report = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: REVIEW_BASE, detail: 'full' }))
    assert.deepEqual(report.openings.filter(item => item.layerName === 'MY-DOORS').map(item => [item.spanM, item.count]),
      [[1.1, 1], [2.7, 1]], '同层两处开口必须各成一条（不合并成 count:2）')
    assert.equal(report.openings.some(item => item.layerName === 'MY-DOORS-ZERO'), false, '零跨度层不得写成 spanM:0 的开口')
    assert.deepEqual(report.openingSkips.map(item => [item.layerName, item.reason, item.entityCount]),
      [['MY-DOORS-EMPTY', 'OPENING_LAYER_EMPTY_IGNORED', 0], ['MY-DOORS-ZERO', 'OPENING_LAYER_DEGENERATE', 1]],
      '空层与退化层必须在报告里给出忽略理由')
    // 退化层不进摘要素材：拿掉它不该改变开口桶
    const withoutZero = report.openings.filter(item => item.layerName !== 'MY-DOORS-ZERO')
    assert.equal(openingsDigest(withoutZero), report.openingsDigest)
  })

  test('反例（层内加宽）：层包围盒不变也必须点名该开口（旧行为 unchanged:true）', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: REVIEW_BASE, detail: 'full' }))
    const wider = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: REVIEW_WIDER, detail: 'full' }))
    assert.deepEqual(wider.dxf!.bounds.sizeDrawingUnits, baseline.dxf!.bounds.sizeDrawingUnits,
      '这个反例的整体范围必须与原件一致（只改开口）')
    assert.deepEqual(myDoorLayerBounds(wider), myDoorLayerBounds(baseline),
      '这个反例的 MY-DOORS 图层包围盒必须不变——旧实现正是靠它才漏报')
    const facts = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: wider.constraints, openings: wider.openings, openingSkips: wider.openingSkips })
    assert.equal(facts.dimensions.unchanged, true, '只改开口，尺寸桶不该动')
    assert.equal(facts.openings.unchanged, false, '层内加宽必须判"开口已变"')
    assert.equal(facts.unchanged, false)
    assert.deepEqual(facts.openings.changed.map(item => [item.before.layerName, item.before.spanM, item.after.spanM]),
      [['MY-DOORS', 1.1, 1.7]], '必须点名是哪个开口、从多少变到多少')
    assert.notEqual(facts.factsDigestBefore, facts.factsDigestAfter)
    // 工具回执同样点名，并把"没折算的层"理由一起给出
    const checked = valueOf<unknown>(await callTool(booted.ctx, 'drawing_constraints_check',
      { path: REVIEW_WIDER, expect_constraints: baseline.constraints, expect_openings: baseline.openings }))
    const verdict = JSON.parse(checked.result) as { unchanged: boolean; verdict: string; changed: unknown[] }
    assert.equal(verdict.unchanged, false)
    assert.deepEqual(verdict.changed, [], '尺寸桶不该跟着变')
    assert.match(verdict.verdict, /开口变了/)
    assert.match(verdict.verdict, /MY-DOORS/)
    assert.match(verdict.verdict, /1\.7/)
    assert.match(verdict.verdict, /OPENING_LAYER_EMPTY_IGNORED/)
  })

  test('反例（层内平移）：尺寸不变、只在层内挪位置也必须点名（靠 originM）', async () => {
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: REVIEW_BASE, detail: 'full' }))
    const moved = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: REVIEW_MOVED, detail: 'full' }))
    assert.deepEqual(moved.dxf!.bounds.sizeDrawingUnits, baseline.dxf!.bounds.sizeDrawingUnits,
      '这个反例的整体范围必须与原件一致（只平移开口）')
    assert.deepEqual(myDoorLayerBounds(moved), myDoorLayerBounds(baseline), '层包围盒也必须不变')
    const before = baseline.openings.find(item => item.layerName === 'MY-DOORS' && item.spanM === 1.1)
    const after = moved.openings.find(item => item.layerName === 'MY-DOORS' && item.spanM === 1.1)
    assert.ok(before, '基线里必须有那条 1.1 m 的开口')
    assert.ok(after, '平移后仍必须有那条 1.1 m 的开口')
    assert.ok(before.originM, '基线条目必须带 originM（否则平移根本不可比）')
    assert.ok(after.originM, '平移后条目必须带 originM')
    assert.equal(before.spanM, after.spanM, '跨度必须相同——这个反例考的是位置')
    assert.notDeepEqual(before.originM, after.originM, '位置必须真的变了')
    const facts = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: moved.constraints, openings: moved.openings, openingSkips: moved.openingSkips })
    assert.equal(facts.dimensions.unchanged, true, '只平移开口，尺寸桶不该动')
    assert.equal(facts.openings.unchanged, false, '层内平移必须判"开口已变"')
    assert.equal(facts.unchanged, false)
    assert.deepEqual(facts.openings.changed.map(item => [item.before.layerName, item.before.originM, item.after.originM]),
      [['MY-DOORS', before.originM, after.originM]], '必须点名该开口并给出前后原点')
    assert.notEqual(facts.factsDigestBefore, facts.factsDigestAfter)
  })

  /**
   * N310-R6（task-343 reopen 第 3 次）：**截断盲区** —— 开口层的逐实体明细上限是 512 条，
   * 第 513 条起的实体不进 `sizes`/`openings`/`factsDigest`；旧实现因此把"窗口外改动"报成
   * `unchanged:true`、digest 逐字相同（独立复核 Round 7 的读数）。
   * 夹具（本 lane 自建，来源与 sha 见 `drawing-fixtures/SOURCE.md`）：512 条（不截断）/ 513 条（截断）/
   * 513 条里把**第 513 条**加宽（窗口外）/ 把**第 512 条**加宽（窗口内，边界对照）。
   */
  const TRUNC_512 = join(FIXTURES, 'env14-trunc-doors512-declared.dxf')
  const TRUNC_513 = join(FIXTURES, 'env14-trunc-doors513-declared.dxf')
  const TRUNC_513_LAST = join(FIXTURES, 'env14-trunc-doors513-lastwide.dxf')
  const TRUNC_513_IDX512 = join(FIXTURES, 'env14-trunc-doors513-idx512wide.dxf')
  const doorRowOf = (report: DrawingReport) =>
    ((report.dxf as unknown as { layerBounds?: Array<{ layer: string; entityCount: number; sizes?: number[][]; sizesTruncated?: boolean }> })
      .layerBounds ?? []).find(item => /door/i.test(item.layer))

  test('截断盲区（512/513 边界）：不判"未变"，给出 OPENING_LAYER_SIZES_TRUNCATED 与 factsComplete:false', async () => {
    const floor = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: TRUNC_512, detail: 'full' }))
    const baseline = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: TRUNC_513, detail: 'full' }))
    const lastWide = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: TRUNC_513_LAST, detail: 'full' }))
    const idx512Wide = fullReportOf(await callTool(booted.ctx, 'drawing_inspect', { path: TRUNC_513_IDX512, detail: 'full' }))
    // 边界：512 条不截断、513 条截断（明细只到 512 条）
    assert.equal(doorRowOf(floor)?.entityCount, 512)
    assert.equal(doorRowOf(floor)?.sizes?.length, 512)
    assert.equal(doorRowOf(floor)?.sizesTruncated, false)
    assert.equal(doorRowOf(baseline)?.entityCount, 513)
    assert.equal(doorRowOf(baseline)?.sizes?.length, 512)
    assert.equal(doorRowOf(baseline)?.sizesTruncated, true)
    assert.equal(factsCompleteOf(floor), true)
    assert.equal(factsCompleteOf(baseline), false)
    assert.deepEqual(
      baseline.openingSkips.filter(item => item.reason === 'OPENING_LAYER_SIZES_TRUNCATED').map(item => [item.layerName, item.entityCount]),
      [[doorRowOf(baseline)!.layer, 513]], '截断层必须留下明确理由（不静默省略）')
    // 窗口外（第 513 条）改动：摘要本来就看不见差异——这正是盲区，必须靠 factsComplete 拦住
    const outside = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: lastWide.constraints, openings: lastWide.openings, openingSkips: lastWide.openingSkips })
    assert.equal(outside.factsDigestBefore, outside.factsDigestAfter, '窗口外改动在摘要里逐字相同（盲区的本体）')
    assert.equal(outside.factsComplete, false)
    assert.equal(outside.unchanged, false, '事实不完整时不得判"未变"')
    // 结构性保证：**两参数**（不传 openingSkips）的调用同样保守 —— "没给完整性信息"绝不当成"完整"，
    // 否则旧盲区仍能从这个入口绕过（独立复核的两参数探针正是这么复现的）。
    const looseOutside = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings },
      { constraints: lastWide.constraints, openings: lastWide.openings })
    assert.equal(looseOutside.factsComplete, false)
    assert.equal(looseOutside.unchanged, false, '不传完整性信息时不得默认"完整"')
    // 窗口内（第 512 条）改动：仍要被点名（边界正好在 512）
    const inside = compareFacts(
      { constraints: baseline.constraints, openings: baseline.openings, openingSkips: baseline.openingSkips },
      { constraints: idx512Wide.constraints, openings: idx512Wide.openings, openingSkips: idx512Wide.openingSkips })
    assert.equal(inside.openings.unchanged, false)
    assert.deepEqual(inside.openings.changed.map(item => [item.before.spanM, item.after.spanM]), [[0.6, 3]])
    // 工具回执必须把"证不了没变"和"变了"分开说，并给出 factsComplete:false
    const checked = valueOf<unknown>(await callTool(booted.ctx, 'drawing_constraints_check',
      { path: TRUNC_513_LAST, expect_constraints: baseline.constraints, expect_openings: baseline.openings }))
    const verdict = JSON.parse(checked.result) as { unchanged: boolean; factsComplete: boolean; verdict: string }
    assert.equal(verdict.unchanged, false)
    assert.equal(verdict.factsComplete, false)
    assert.match(verdict.verdict, /事实不完整/)
    assert.match(verdict.verdict, /OPENING_LAYER_SIZES_TRUNCATED/)
    assert.doesNotMatch(verdict.verdict, /已确认事实（尺寸\+开口）已变/, '没读到变化就不能说"已变"')
  })
})
