/**
 * cad_inspect 的真实行为测试：**从 ToolRegistry 调用** → 共用 operation → 真实子进程
 * （隔离解释器里的 ezdxf）→ 结构化报告；另有一条直接跑 cad_inspect.py 的跨进程通道，
 * 用来证明"拒绝 DWG / 缺文件 / 解析失败"这些负例在 Python 侧同样成立，而不只是 TS 前置检查。
 *
 * 为什么用 node:test 而不是 bun test：`@deepseek-ai/dsh-subprocess-local` 在模块级使用
 * `util.getSystemErrorMessage`（Node 24 API），Bun 1.3.13 的 node:util 没有这个导出，
 * 整个 provider 在 Bun 下加载即失败。产品 Host 本来就跑在 Node 上，这里用同一套语义。
 *
 * 运行：
 *   LYAPUNOV_CAD_PYTHON=<装了 ezdxf 的隔离解释器> node --test packages/blender/test/cad.test.ts
 * 未设置 LYAPUNOV_CAD_PYTHON 时，依赖解释器的用例整组 skip（不静默当成通过）：
 *   "cad_inspect → 隔离 Python" 与本文件末的脚本直跑组会显示为 skipped。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import {
  CAD_ERROR_PREFIX, CAD_RESULT_PREFIX, CAD_SUMMARY_ITEMS, CAD_SUMMARY_POINTS, CadError,
  cadTaskCwd, inspectDxf, preflightCadFile, registerCadTools, resolveCadPath, resolveCadPython,
  summarizeCadReport, type CadCurve, type CadReport,
} from '../src/cad.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'cad-fixtures')
const SCRIPT = join(HERE, '..', 'python', 'cad_inspect.py')
const PYTHON = process.env.LYAPUNOV_CAD_PYTHON?.trim() ?? ''
const hasInterpreter = PYTHON !== '' && existsSync(PYTHON)
const MM_DXF = join(FIXTURES, 'plan-mm.dxf')
const UNITLESS_DXF = join(FIXTURES, 'plan-unitless.dxf')
const R12_DXF = join(FIXTURES, 'plan-r12.dxf')
const L_SHAPE_DXF = join(FIXTURES, 'plan-l-shape.dxf')
const NESTED_DXF = join(FIXTURES, 'nested-blocks.dxf')
const DIMS_DXF = join(FIXTURES, 'plan-dims.dxf')
const DENSE_DXF = join(FIXTURES, 'plan-dense.dxf')
const CURVE_TYPES_DXF = join(FIXTURES, 'plan-curve-types.dxf')
const BINARY_DXF = join(FIXTURES, 'plan-mm-binary.dxf')
const BINARY_BROKEN = join(FIXTURES, 'binary-truncated.dxf')
const DWG = join(FIXTURES, 'not-a-dxf.dwg')
const TRUNCATED_DXF = join(FIXTURES, 'truncated.dxf')
const MISSING = join(FIXTURES, 'does-not-exist.dxf')

/** 用最小但真实的 Cordis 树（systemPrompt + tools + subprocess-local）装工具。 */
async function bootContext(config: Parameters<typeof registerCadTools>[1] = {}) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
  ]
  const disposeTools = registerCadTools(ctx, config)
  return {
    ctx,
    disposeTools,
    async close() {
      await disposeTools()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/**
 * 调工具。scope.cwd 模拟原生会话的 header.cwd（与终端/工作台同一事实）：
 * 相对路径必须以它为准，而不是插件配置或进程 cwd。
 */
async function callTool(
  ctx: Context,
  args: Record<string, unknown>,
  scope?: { cwd: string },
): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    callId: ToolCallId(`cad-test:${String(args.path)}:${scope?.cwd ?? ''}`),
    name: 'cad_inspect',
    arguments: args,
    signal: new AbortController().signal,
    ...(scope ? { agent: { session: { header: { cwd: scope.cwd } } } as never } : {}),
  })
}

function valueOf(result: ToolExecutionResult): { result: string; report: CadReport } {
  if (result.isError) throw new Error(`工具失败：${JSON.stringify(result.content ?? null).slice(0, 500)}`)
  return result.value as unknown as { result: string; report: CadReport }
}

/** 成功结果 → 报告，并校验"摘要与 report 是同一份事实"（模型读文本，程序读结构化值）。 */
function reportOf(result: ToolExecutionResult): CadReport {
  const value = valueOf(result)
  const parsed = JSON.parse(value.result) as Record<string, unknown>
  assert.deepEqual(parsed.units, value.report.units, '摘要里的 units 必须与 report 一致')
  assert.deepEqual(parsed.counts, value.report.counts, '摘要里的 counts 必须与 report 一致')
  assert.deepEqual(parsed.file, value.report.file, '摘要里的 file 必须与 report 一致')
  assert.deepEqual(parsed.warnings, value.report.warnings, '摘要里的 warnings 必须与 report 一致')
  return value.report
}

function errorTextOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error(`期望失败但成功了：${JSON.stringify(result.value ?? null).slice(0, 300)}`)
  return JSON.stringify(result.content ?? null)
}

/** 数值数组近似比较：米制换算是浮点运算，不拿最后一位当契约。 */
function approx(actual: number, expected: number, epsilon = 1e-9, label = ''): void {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${label} 期望 ${expected}±${epsilon}，实际 ${actual}`)
}

function closedOutline(curves: CadCurve[]): CadCurve {
  const outline = curves.find(curve => curve.type === 'LWPOLYLINE' && curve.closed === true)
  assert.ok(outline, '应有闭合的 LWPOLYLINE 外轮廓')
  return outline
}

/**
 * 测试内即时生成一份 DXF：**用配置的隔离解释器里的 ezdxf 真写出**（不是手写文本），
 * 只为钉住仓库夹具里没有的形状（三轴不等的块引用、带 knots/weights 的有理样条、超长样条）。
 * 这样已审夹具一个字节都不动（sha256 不变），测的仍是同一条真实解析链。
 */
async function generateDxf(name: string, code: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'cad-generated-')), name)
  const result = spawnSync(PYTHON, ['-c', code, path], { encoding: 'utf8' })
  assert.equal(result.status, 0, `生成夹具失败（${name}）：${(result.stderr ?? '').slice(-600)}`)
  assert.ok(existsSync(path), `生成夹具失败：没有写出 ${path}`)
  return path
}

/** 行主序 4x4（平移在最后一行）按 v' = v·M 变换一个点——与报告 transformOrder 的说明同一约定。 */
function applyRowMajor(point: number[], matrix: number[][]): number[] {
  return [0, 1, 2, 3].map(col => point.reduce((sum, value, row) => sum + value * matrix[row]![col]!, 0))
}

describe('cad 工具注册、前置检查与路径作用域（不需要 CAD 解释器）', () => {
  test('registerCadTools 注册出可直接调用的 cad_inspect，注销后注册表里消失', async () => {
    const { ctx, disposeTools, close } = await bootContext()
    try {
      assert.ok(ctx.tools.get('cad_inspect'), 'cad_inspect 应该在 ToolRegistry 里')
      await disposeTools()
      assert.equal(ctx.tools.get('cad_inspect'), undefined)
    } finally {
      await close()
    }
  })

  test('解释器解析：显式配置优先，其次环境变量，都没有就是未配置（不猜默认解释器）', () => {
    assert.equal(resolveCadPython({ python: ' /opt/cad/bin/python ' }, {}), '/opt/cad/bin/python')
    assert.equal(resolveCadPython({}, { LYAPUNOV_CAD_PYTHON: '/env/bin/python' }), '/env/bin/python')
    assert.equal(resolveCadPython({ python: '   ' }, { LYAPUNOV_CAD_PYTHON: '/env/bin/python' }), '/env/bin/python')
    assert.equal(resolveCadPython({}, {}), undefined)
  })

  test('任务工作区：会话 cwd 优先、config.workspace 兜底、都没有就是 undefined（不落进程 cwd）', () => {
    const session = { agent: { session: { header: { cwd: '/task/ws' } } } }
    assert.equal(cadTaskCwd(session, { workspace: '/plugin/ws' }), '/task/ws', '会话 cwd 必须优先')
    assert.equal(cadTaskCwd({ agent: { session: { header: {} } } }, { workspace: '/plugin/ws' }), '/plugin/ws')
    assert.equal(cadTaskCwd(undefined, { workspace: '/plugin/ws' }), '/plugin/ws')
    assert.equal(cadTaskCwd(undefined, {}), undefined, '没有基准就是 undefined，不拿 process.cwd() 顶上')
    // 路径解析：绝对路径直通；相对路径按会话 cwd；没有基准明确报错
    assert.equal(resolveCadPath(session, {}, '/abs/plan.dxf'), '/abs/plan.dxf')
    assert.equal(resolveCadPath(session, {}, 'plan.dxf'), '/task/ws/plan.dxf')
    assert.equal(resolveCadPath(undefined, { workspace: '/plugin/ws' }, 'plan.dxf'), '/plugin/ws/plan.dxf')
    assert.throws(() => resolveCadPath(undefined, {}, 'plan.dxf'), (error: unknown) =>
      error instanceof CadError && error.code === 'CAD_CWD_UNRESOLVED')
  })

  test('前置检查：缺文件 / DWG / 空文件各有稳定错误码；ASCII 与 Binary DXF 都放行', async () => {
    await assert.rejects(() => preflightCadFile(MISSING), (error: unknown) =>
      error instanceof CadError && error.code === 'CAD_FILE_MISSING')
    await assert.rejects(() => preflightCadFile(DWG), (error: unknown) =>
      error instanceof CadError && error.code === 'DWG_REQUIRES_CONVERTER'
      && /转换器|dwg2dxf|ODA/.test(error.message))
    const empty = join(await mkdtemp(join(tmpdir(), 'cad-empty-')), 'empty.dxf')
    await writeFile(empty, '')
    await assert.rejects(() => preflightCadFile(empty), (error: unknown) =>
      error instanceof CadError && error.code === 'CAD_FILE_EMPTY')
    // 二进制 DXF 不再被当成"不支持"：ezdxf 能读，前置检查只把它标记出来
    const binary = await preflightCadFile(BINARY_DXF)
    assert.equal(binary.binary, true)
    assert.ok(Buffer.from(binary.head).toString('latin1').startsWith('AutoCAD Binary DXF'))
    const ascii = await preflightCadFile(MM_DXF)
    assert.equal(ascii.binary, false)
    assert.ok(ascii.bytes > 1000)
    assert.ok(Buffer.from(ascii.head).toString('latin1').includes('SECTION'))
  })

  test('DWG 负例在注册表调用里就被拒绝，且不把它当 DXF 解析', async () => {
    const { ctx, close } = await bootContext({ python: PYTHON || '/nonexistent/python' })
    try {
      const text = errorTextOf(await callTool(ctx, { path: DWG }))
      assert.match(text, /DWG_REQUIRES_CONVERTER/)
      assert.match(text, /转换器/)
    } finally {
      await close()
    }
  })

  test('未配置解释器时报 CAD_PYTHON_UNCONFIGURED 而不是静默换一个解释器', async () => {
    const saved = process.env.LYAPUNOV_CAD_PYTHON
    delete process.env.LYAPUNOV_CAD_PYTHON
    const { ctx, close } = await bootContext()
    try {
      const text = errorTextOf(await callTool(ctx, { path: MM_DXF }))
      assert.match(text, /CAD_PYTHON_UNCONFIGURED/)
      assert.match(text, /LYAPUNOV_CAD_PYTHON|config/)
    } finally {
      if (saved !== undefined) process.env.LYAPUNOV_CAD_PYTHON = saved
      await close()
    }
  })

  test('相对路径没有会话 cwd 也没有 workspace 时报 CAD_CWD_UNRESOLVED（不落产品根）', async () => {
    const { ctx, close } = await bootContext({ python: PYTHON || '/nonexistent/python' })
    try {
      const text = errorTextOf(await callTool(ctx, { path: 'plan.dxf' }))
      assert.match(text, /CAD_CWD_UNRESOLVED/)
      assert.match(text, /绝对路径|工作目录/)
    } finally {
      await close()
    }
    // operation 层同样不隐式拿进程 cwd 当基准
    await assert.rejects(
      () => inspectDxf({
        subprocess: { spawn: () => { throw new Error('不应起进程') } } as never,
        python: '/nonexistent/python', script: SCRIPT, file: 'plan.dxf',
      }),
      (error: unknown) => error instanceof CadError && error.code === 'CAD_CWD_UNRESOLVED',
    )
  })
})

describe('cad_inspect → 隔离 Python（ezdxf）真实读取', { skip: hasInterpreter ? false : '未设置 LYAPUNOV_CAD_PYTHON' }, () => {
  let booted: Awaited<ReturnType<typeof bootContext>>
  before(async () => { booted = await bootContext({ python: PYTHON }) })
  after(async () => { await booted.close() })

  test('有单位/闭合轮廓/块旋转缩放/尺寸标注的 DXF：单位、曲线、块变换、寸标都真实读出', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: MM_DXF }))
    // 单位：原值 + 已知 + 换算因子，来源标注为文件头
    assert.equal(report.units.insunits, 4)
    assert.equal(report.units.presentInFile, true)
    assert.equal(report.units.known, true)
    assert.equal(report.units.name, 'Millimeters')
    assert.equal(report.units.metresPerUnit, 0.001)
    assert.equal(report.units.source, 'header')
    // 曲线：闭合矩形给出真实顶点（不是只有 bbox），圆给出圆心半径
    const rect = closedOutline(report.geometry.curves)
    assert.equal(rect.vertexCount, 4)
    assert.deepEqual(rect.vertices, [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }])
    assert.equal(rect.coordinates, 'ocs')
    assert.equal(rect.units, 'drawing-unit')
    const circle = report.geometry.curves.find(curve => curve.type === 'CIRCLE')!
    assert.deepEqual(circle.center, [2000, 1500, 0])
    assert.equal(circle.radius, 500)
    assert.equal(circle.closed, true)
    const arc = report.geometry.curves.find(curve => curve.type === 'ARC')!
    assert.deepEqual([arc.startAngle, arc.endAngle, arc.radius], [0, 45, 800])
    assert.equal(arc.closed, false)
    // 曲线条数：curveCount 是**模型空间**的全量；块内曲线也在 curves 里，用 block 区分
    assert.equal(report.geometry.curveCount, 3)
    assert.equal(report.geometry.openCurveCount, 1, '模型空间只有那段圆弧是开口的')
    assert.equal(report.geometry.curves.length, 5, '模型空间 3 条 + DOOR 块内 2 条')
    assert.equal(report.geometry.curvesBySpace['modelspace'], 3)
    assert.equal(report.geometry.curvesBySpace['block:DOOR'], 2)
    assert.equal(report.counts.curves, 3)
    // 块引用：旋转 30°、缩放 2/3、平移在矩阵最后一行
    assert.equal(report.blocks.modelspaceReferenceCount, 2)
    assert.ok(report.blocks.references.length >= 2)
    const rotated = report.blocks.references.find(ref => ref.rotationDeg === 30)!
    assert.ok(rotated, '应有旋转 30° 的块引用')
    assert.equal(rotated.block, 'DOOR')
    assert.deepEqual(rotated.scale, [2, 3, 1])
    assert.equal(rotated.uniformScale, false)
    assert.deepEqual(rotated.transform?.[3], [1000, 500, 0, 1])
    // 块定义的几何在块坐标系里也读得出来（引用靠 transform 放置）
    const doorCurves = report.geometry.curves.filter(curve => curve.block === 'DOOR')
    assert.equal(doorCurves.length, 2)
    assert.deepEqual(doorCurves.map(curve => curve.type).sort(), ['ARC', 'LINE'])
    // 尺寸：水平 4000 / 竖直 3000（覆盖文字原样保留，测量值仍然给出）
    assert.equal(report.dimensions.length, 2)
    assert.deepEqual(report.dimensions.map(dim => dim.measurement).sort(), [3000, 4000])
    assert.equal(report.dimensions.every(dim => dim.measurementUnit === 'drawing-unit'), true)
    assert.equal(report.dimensions.find(dim => dim.measurement === 3000)?.textOverride, 'H=3000')
    assert.equal(report.dimensions.every(dim => dim.flags.ordinateAxis === null), true)
    // 未知/不支持实体：无限构造线 + 代理实体，明确列出且声明未参与 bounds
    assert.equal(report.unsupportedEntityCount, 2)
    assert.deepEqual(report.unsupported.map(item => item.type).sort(), ['ACAD_PROXY_ENTITY', 'XLINE'])
    assert.equal(report.unsupported.every(item => item.spaces.includes('modelspace')), true)
    assert.match(report.warnings.join('\n'), /CAD_UNSUPPORTED_ENTITIES/)
    // bounds 真的按建模子集过滤：排除的类型与个数在报告里写清楚
    assert.deepEqual(report.bounds.excludedEntityTypes, { ACAD_PROXY_ENTITY: 1, XLINE: 1 })
    assert.equal(report.bounds.entityTypes.includes('XLINE'), false)
    assert.equal(report.bounds.entityTypes.includes('LWPOLYLINE'), true)
    // 文件身份与边界（毫米 → 米：整图 5700 x 6330.66 mm）
    assert.equal(report.file.sha256.length, 64)
    assert.equal(report.format.binary, false)
    assert.ok(report.bounds.sizeMetres, '单位已知时必须有米制边界')
    approx(report.bounds.sizeMetres![0], 5.7, 1e-9, 'bounds.sizeMetres[0]')
    approx(report.bounds.sizeMetres![1], 6.330659764728, 1e-6, 'bounds.sizeMetres[1]')
    assert.equal(report.source.engine, 'ezdxf')
  })

  test('L 形闭合轮廓：给出 6 个真实顶点（不是外接矩形），可直接切出墙面', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: L_SHAPE_DXF }))
    const scale = report.units.metresPerUnit!
    assert.equal(scale, 0.001)
    const outline = closedOutline(report.geometry.curves)
    // 真实顶点顺序就是墙线顺序；外接矩形会丢掉 L 的缺口（6000x6000 而不是 6000x6000-3000x3000）
    assert.deepEqual(outline.vertices, [
      { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 },
      { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 },
    ])
    const points = outline.vertices!.map(vertex => [vertex.x * scale, vertex.y * scale] as [number, number])
    // 墙面 = 相邻顶点连成的线段（闭合轮廓要接回起点）
    const walls = points.map((point, index) => {
      const next = points[(index + 1) % points.length]
      return Math.hypot(next[0] - point[0], next[1] - point[1])
    })
    assert.deepEqual(walls, [6, 3, 3, 3, 3, 6], '每条墙段的米制长度')
    approx(walls.reduce((sum, length) => sum + length, 0), 24, 1e-9, '外墙周长')
    // 面积（shoelace）= 6×6 − 3×3 = 27 m²；按外接矩形建墙会得到 36 m²，那是错的
    const area = Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]
      return sum + (point[0] * next[1] - next[0] * point[1])
    }, 0)) / 2
    approx(area, 27, 1e-9, 'L 形底面积')
    // 柱与门弧：圆心/半径/角度都是真实参数，可以直接放柱子和门扇
    const column = report.geometry.curves.find(curve => curve.type === 'CIRCLE')!
    assert.deepEqual(column.center, [1000, 1000, 0])
    approx((column.radius ?? 0) * scale, 0.3, 1e-12, '柱半径（米）')
    const door = report.geometry.curves.find(curve => curve.type === 'ARC')!
    assert.deepEqual([door.center, door.radius, door.startAngle, door.endAngle],
      [[3000, 3000, 0], 900, 0, 90])
    // 带 bulge 的弧墙：顶点给到 bulge，长度不是直线距离（读的时候必须原样带出来）
    const curved = report.geometry.curves.filter(curve => curve.type === 'LWPOLYLINE')
      .find(curve => curve.vertices?.some(vertex => vertex.bulge !== undefined))!
    assert.ok(curved, '应有带 bulge 的墙线')
    assert.equal(curved.vertices!.find(vertex => vertex.bulge !== undefined)!.bulge, 1)
    // 边界含弧墙外凸（半径 750 的半圆）：6000 之外还有 750
    approx(report.bounds.sizeDrawingUnits![0], 6750, 1e-9, 'bounds.sizeDrawingUnits[0]')
  })

  test('曲线类型与坐标空间逐条如实：3D POLYLINE/ELLIPSE/LINE/SPLINE 是 wcs，2D POLYLINE 是 ocs', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: CURVE_TYPES_DXF }))
    const byType = (type: string, polylineType?: string) => report.geometry.curves.find(curve =>
      curve.type === type && (polylineType === undefined || curve.polylineType === polylineType))!
    // 3D POLYLINE：顶点是 WCS，z 分量真实存在
    const poly3d = byType('POLYLINE', '3d')
    assert.equal(poly3d.coordinates, 'wcs')
    assert.deepEqual(poly3d.vertices, [{ x: 0, y: 0 }, { x: 1000, y: 0, z: 500 }, { x: 1000, y: 1000, z: 1000 }])
    // 2D POLYLINE：顶点是 OCS（z 分量不是高程），elevation 另存，bulge 照给
    const poly2d = byType('POLYLINE', '2d')
    assert.equal(poly2d.coordinates, 'ocs')
    assert.equal(poly2d.elevation, 200)
    assert.equal(poly2d.vertices![0]!.bulge, 1)
    assert.equal(poly2d.vertices!.some(vertex => vertex.z !== undefined), false, 'OCS 顶点不带 z')
    // ELLIPSE：wcs、参数区间（弧度）、长短轴比，整椭圆算闭合
    const ellipse = byType('ELLIPSE')
    assert.equal(ellipse.coordinates, 'wcs')
    assert.equal(ellipse.closed, true)
    assert.equal(ellipse.paramsInRadians, true)
    assert.equal(ellipse.ratio, 0.5)
    assert.equal(ellipse.majorAxisLength, 1000)
    assert.deepEqual(ellipse.center, [3000, 3000, 0])
    approx(ellipse.endParam ?? 0, Math.PI * 2, 1e-9, '椭圆终参')
    // LINE / SPLINE：wcs；SPLINE 给次数与拟合点
    const line = byType('LINE')
    assert.equal(line.coordinates, 'wcs')
    assert.deepEqual([line.start, line.end], [[0, 5000, 0], [2000, 5000, 0]])
    assert.equal(line.closed, null, 'LINE 没有闭合概念，报 null 而不是假装开口')
    const spline = byType('SPLINE')
    assert.equal(spline.coordinates, 'wcs')
    assert.equal(spline.degree, 3)
    assert.equal(spline.fitPoints!.length, 4)
    // 计数语义：curveCount 只数模型空间；openCurveCount 只数 closed=false（LINE 的 null 不计入）
    assert.equal(report.geometry.curveCount, 5)
    assert.equal(report.geometry.openCurveCount, 3)
    assert.match(report.geometry.note, /openCurveCount/)
  })

  test('未知单位（$INSUNITS=0 与 R12 缺头变量）：保留原值、报未知、不给米制换算', async () => {
    const unitless = reportOf(await callTool(booted.ctx, { path: UNITLESS_DXF }))
    assert.equal(unitless.units.insunits, 0)
    assert.equal(unitless.units.presentInFile, true)
    assert.equal(unitless.units.known, false)
    assert.equal(unitless.units.name, null)
    assert.equal(unitless.units.metresPerUnit, null)
    assert.equal(unitless.units.source, 'unknown')
    assert.equal(unitless.bounds.metres, null)
    assert.equal(unitless.bounds.sizeMetres, null)
    assert.match(unitless.warnings.join('\n'), /CAD_UNIT_UNKNOWN/)
    // 几何本身照读：闭合轮廓与真实顶点仍在（只是不能换算成米）
    assert.equal(closedOutline(unitless.geometry.curves).vertices!.length, 4)
    const r12 = reportOf(await callTool(booted.ctx, { path: R12_DXF }))
    assert.equal(r12.units.insunits, null)
    assert.equal(r12.units.presentInFile, false)
    assert.equal(r12.units.known, false)
    assert.equal(r12.units.metresPerUnit, null)
    assert.equal(r12.format.aciVersion, 'AC1009')
    assert.equal(r12.blocks.references[0]?.rotationDeg, 30)
  })

  test('调用方显式给单位：换算按调用方并标注来源；与文件冲突时同样记下来', async () => {
    const caller = reportOf(await callTool(booted.ctx, { path: UNITLESS_DXF, unit: 'm' }))
    assert.equal(caller.units.source, 'caller')
    assert.equal(caller.units.known, true)
    assert.equal(caller.units.metresPerUnit, 1)
    assert.equal(caller.units.insunits, 0, '原值必须保留')
    assert.deepEqual(caller.units.callerSupplied, { requested: 'm', name: 'Meters', metresPerUnit: 1 })
    assert.ok(caller.bounds.metres, '给了单位才给米制边界')
    assert.ok(caller.bounds.sizeMetres!.every(value => Number.isFinite(value)))
    const conflict = reportOf(await callTool(booted.ctx, { path: MM_DXF, unit: 'm' }))
    assert.equal(conflict.units.source, 'caller')
    assert.equal(conflict.units.conflict, true)
    assert.equal(conflict.units.metresPerUnit, 1)
    assert.equal(conflict.units.insunits, 4, '冲突时原值仍要保留')
    assert.match(conflict.units.note, /冲突/)
  })

  test('尺寸标注的类型与位标志：ordinate 的 X/Y 轴、文字用户位置、点测量值都不混淆', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: DIMS_DXF }))
    assert.equal(report.dimensions.length, 4)
    const linear = report.dimensions.find(dim => dim.dimTypeName === 'linear/rotated' && dim.measurement === 4000)!
    assert.deepEqual(linear.flags, { blockReference: true, ordinateAxis: null, textUserPositioned: false })
    assert.equal(linear.measurementUnit, 'drawing-unit')
    assert.equal(linear.measurementPoint, null)
    const ordinates = report.dimensions.filter(dim => dim.dimTypeName === 'ordinate')
    assert.equal(ordinates.length, 2)
    // 位 64 = X 型，未置位 = Y 型（DXF 组码 70；ezdxf 的 add_ordinate_dim dtype 同义）
    assert.deepEqual(ordinates.map(dim => dim.flags.ordinateAxis).sort(), ['x', 'y'])
    for (const ordinate of ordinates) {
      assert.equal(ordinate.measurement, null, 'ordinate 的测量值不是长度')
      assert.deepEqual(ordinate.measurementPoint, [1000, 500, 0], 'ordinate 的测量值是特征位置点')
      assert.equal(ordinate.measurementUnit, null)
    }
    // 位 128 = 文字被放到用户位置（不是"用了自定义文字"，与 textOverride 是两件事）
    const moved = report.dimensions.find(dim => dim.flags.textUserPositioned)!
    assert.ok(moved, '应有文字在用户位置的标注')
    assert.equal(moved.textOverride, null, '文字位置与文字内容互不冒充')
    assert.equal(report.dimensions.filter(dim => dim.flags.textUserPositioned).length, 1)
  })

  test('嵌套块与定义顺序：引用计数先数完再投影；definitionCount 不受 max_items 截断', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: NESTED_DXF }))
    const byName = new Map(report.blocks.definitions.map(item => [item.name, item]))
    // CHAIR 先定义、被后定义的 ROOM 引用：引用计数必须**算上**那条嵌套引用（一趟写会漏掉）
    assert.equal(byName.get('CHAIR')!.referenceCount, 2, 'CHAIR = 模型空间 1 + ROOM 里的嵌套 1')
    assert.equal(byName.get('ROOM')!.referenceCount, 1, 'ROOM 被 FLOOR 里的嵌套引用 1 次')
    assert.equal(byName.get('FLOOR')!.referenceCount, 1, 'FLOOR 被模型空间引用 1 次')
    assert.equal(byName.get('ROOM')!.nestedReferenceCount, 1)
    assert.equal(byName.get('FLOOR')!.nestedReferenceCount, 1)
    assert.equal(byName.get('CHAIR')!.nestedReferenceCount, 0)
    assert.equal(report.blocks.definitionCount, 3)
    assert.equal(report.blocks.definitionsListed, 3)
    assert.equal(report.blocks.referenceCount, 4)
    assert.equal(report.blocks.modelspaceReferenceCount, 2)
    assert.equal(report.blocks.nestedReferenceCount, 2)
    // 块内几何带 block 名，可与引用/变换对应
    assert.deepEqual(report.geometry.curvesBySpace, { modelspace: 0, 'block:CHAIR': 2, 'block:ROOM': 1, 'block:FLOOR': 1 })
    const truncated = reportOf(await callTool(booted.ctx, { path: NESTED_DXF, max_items: 1 }))
    assert.equal(truncated.blocks.definitions.length, 1, '明细被截断')
    assert.equal(truncated.blocks.definitionCount, 3, '计数不受截断影响')
    assert.equal(truncated.blocks.definitionsListed, 1)
    assert.equal(truncated.blocks.referenceCount, 4, '引用总数也不受截断影响')
    assert.equal(truncated.truncated.lists.definitions, true)
    assert.equal(truncated.truncated.maxItems, 1)
    assert.deepEqual(truncated.geometry.curvesBySpace, report.geometry.curvesBySpace, '每个空间的曲线计数是全量')
    assert.match(truncated.warnings.join('\n'), /CAD_LIST_TRUNCATED/)
    assert.equal(truncated.counts.blockDefinitions, 3)
  })

  test('块内嵌套引用也进 references：space/parentBlock 给出父链，计数与截断都保持', async () => {
    const report = reportOf(await callTool(booted.ctx, { path: NESTED_DXF }))
    const refs = report.blocks.references
    // 只列模型空间的引用，nestedReferenceCount(2) 就在 references 里找不到对应条目，
    // 下游也没法知道"块内几何该乘哪条变换"。
    assert.equal(refs.length, report.blocks.referenceCount, '未截断时列出条数 = 引用总数')
    assert.equal(refs.length, 4)
    assert.deepEqual(refs.map(ref => [ref.space, ref.parentBlock, ref.block]), [
      ['modelspace', null, 'CHAIR'], ['modelspace', null, 'FLOOR'],
      ['block', 'ROOM', 'CHAIR'], ['block', 'FLOOR', 'ROOM'],
    ])
    assert.equal(refs.filter(ref => ref.space === 'block').length, report.blocks.nestedReferenceCount,
      '块内引用条数要与 nestedReferenceCount 对得上')
    // 沿父链把这些矩阵依次右乘（行主序、平移在最后一行：v' = v·M）：
    // CHAIR 块内点 (0,0) 经"CHAIR@ROOM → ROOM@FLOOR → FLOOR@msp"应落到
    // (1000,1000) + R15°·(500,500)——这正是报告说明里让下游走的同一条链。
    const chain = [
      refs.find(ref => ref.parentBlock === 'ROOM')!,
      refs.find(ref => ref.parentBlock === 'FLOOR' && ref.block === 'ROOM')!,
      refs.find(ref => ref.block === 'FLOOR' && ref.parentBlock === null)!,
    ]
    const world = chain.reduce((point, ref) => applyRowMajor(point, ref.transform!), [0, 0, 0, 1])
    const rad = (15 * Math.PI) / 180
    approx(world[0]!, 1000 + 500 * Math.cos(rad) - 500 * Math.sin(rad), 1e-6, '嵌套 CHAIR 的世界 X')
    approx(world[1]!, 1000 + 500 * Math.sin(rad) + 500 * Math.cos(rad), 1e-6, '嵌套 CHAIR 的世界 Y')
    // 反向乘会得到另一个点（1500,1500）：说明上面的期望值真的在区分链的顺序，不是碰巧相等
    const reversed = [...chain].reverse()
      .reduce((point, ref) => applyRowMajor(point, ref.transform!), [0, 0, 0, 1])
    assert.ok(Math.abs(reversed[0]! - world[0]!) > 100 && Math.abs(reversed[1]! - world[1]!) > 100,
      `反向链应给出明显不同的点（实际 ${reversed.slice(0, 2)}）`)
    // 截断只影响列出条数：总数、模型空间条数、嵌套条数都不变
    const capped = reportOf(await callTool(booted.ctx, { path: NESTED_DXF, max_items: 1 }))
    assert.equal(capped.blocks.references.length, 1)
    assert.equal(capped.truncated.lists.references, true)
    assert.equal(capped.blocks.referenceCount, 4)
    assert.equal(capped.blocks.modelspaceReferenceCount, 2)
    assert.equal(capped.blocks.nestedReferenceCount, 2)
    // 匿名块（标注用的 *D1/*D2）内部的引用同样在列（与 referenceCount 同批），
    // 但曲线明细只列用户块——这类引用是"知道存在、本切片不给它的几何"，不能当成有曲线可读。
    const mm = reportOf(await callTool(booted.ctx, { path: MM_DXF }))
    assert.equal(mm.blocks.references.length, mm.blocks.referenceCount)
    assert.deepEqual(mm.blocks.references.map(ref => ref.parentBlock), [null, null, '*D1', '*D1', '*D2', '*D2'])
    assert.deepEqual(Object.keys(mm.geometry.curvesBySpace), ['modelspace', 'block:DOOR', 'block:_CLOSEDFILLED'])
  })

  test('二进制 DXF：真实解析，事实与同源 ASCII 文件逐项一致', async () => {
    const [ascii, binary] = [reportOf(await callTool(booted.ctx, { path: MM_DXF })),
      reportOf(await callTool(booted.ctx, { path: BINARY_DXF }))]
    assert.equal(binary.format.binary, true, '二进制事实要报出来')
    assert.equal(ascii.format.binary, false)
    assert.equal(binary.format.aciVersion, 'AC1015')
    assert.equal(binary.units.insunits, 4)
    assert.deepEqual(binary.geometry.curves, ascii.geometry.curves, '曲线参数应与 ASCII 原件一致')
    assert.deepEqual(binary.blocks.references.map(ref => ref.transform), ascii.blocks.references.map(ref => ref.transform))
    assert.deepEqual(binary.dimensions.map(dim => dim.measurement), ascii.dimensions.map(dim => dim.measurement))
    assert.deepEqual(binary.bounds.sizeDrawingUnits, ascii.bounds.sizeDrawingUnits)
    assert.notEqual(binary.file.sha256, ascii.file.sha256, '两个文件各有身份（不是同一个文件）')
  })

  test('作用域：两个工作区里的同名 DXF 各读各的（会话 cwd 优先，config.workspace 兜底）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cad-scope-'))
    const [workspaceA, workspaceB] = [join(root, 'a'), join(root, 'b')]
    await mkdir(workspaceA)
    await mkdir(workspaceB)
    // 同名不同内容：A 是毫米图（known），B 是无单位图（unknown）
    await copyFile(MM_DXF, join(workspaceA, 'same-name.dxf'))
    await copyFile(UNITLESS_DXF, join(workspaceB, 'same-name.dxf'))
    const scoped = await bootContext({ python: PYTHON, workspace: workspaceA })
    try {
      // 会话 cwd = B：必须读 B 的文件，config.workspace(A) 只是兜底
      const fromSession = reportOf(await callTool(scoped.ctx, { path: 'same-name.dxf' }, { cwd: workspaceB }))
      assert.equal(fromSession.units.insunits, 0, '应按会话 cwd 读 B（无单位图）')
      assert.equal(fromSession.file.path, join(workspaceB, 'same-name.dxf'))
      // 没有会话 cwd 时才用 workspace
      const fromConfig = reportOf(await callTool(scoped.ctx, { path: 'same-name.dxf' }))
      assert.equal(fromConfig.units.insunits, 4, '应按 config.workspace 读 A（毫米图）')
      assert.equal(fromConfig.file.path, join(workspaceA, 'same-name.dxf'))
      // 会话 cwd 覆盖 config.workspace：同一份 config 下两次调用的文件不同
      assert.notEqual(fromSession.file.sha256, fromConfig.file.sha256)
      // 绝对路径不受作用域影响
      const absolute = reportOf(await callTool(scoped.ctx, { path: join(workspaceA, 'same-name.dxf') }, { cwd: workspaceB }))
      assert.equal(absolute.units.insunits, 4)
    } finally {
      await scoped.close()
    }
  })

  test('缺文件在注册表调用里报 CAD_FILE_MISSING', async () => {
    const text = errorTextOf(await callTool(booted.ctx, { path: MISSING }))
    assert.match(text, /CAD_FILE_MISSING/)
  })

  test('超时/取消：给一个必然超时的预算，报 CAD_INSPECT_TIMEOUT 而不是挂住', async () => {
    const bootedFast = await bootContext({ python: PYTHON })
    try {
      await assert.rejects(
        () => inspectDxf({
          subprocess: bootedFast.ctx.subprocess,
          python: PYTHON,
          script: SCRIPT,
          file: MM_DXF,
          timeoutMs: 1,
        }),
        (error: unknown) => error instanceof CadError && error.code === 'CAD_INSPECT_TIMEOUT',
      )
    } finally {
      await bootedFast.close()
    }
  })

  test('默认 result 是有界摘要（不把整张图复制两份），detail="full" 才给全文', async () => {
    const summaryResult = await callTool(booted.ctx, { path: MM_DXF })
    const { result: summaryText, report } = valueOf(summaryResult)
    const summary = JSON.parse(summaryText) as Record<string, unknown>
    assert.deepEqual(summary.units, report.units)
    assert.deepEqual(summary.counts, report.counts)
    assert.equal((summary.summary as { itemsPerList: number }).itemsPerList, CAD_SUMMARY_ITEMS)
    assert.ok((summary.curves as unknown[]).length <= CAD_SUMMARY_ITEMS)
    assert.match((summary.summary as { note: string }).note, /report/)
    // 摘要里的曲线是"选定明细"：带 index，可回到 report.geometry.curves 对号入座
    const firstCurve = (summary.curves as Array<{ index: number; type: string }>)[0]
    assert.equal(firstCurve.index, 0)
    assert.equal(firstCurve.type, report.geometry.curves[0]!.type)
    // 默认 result 就是共用摘要函数的输出（两条消费面不会各写一份摘要）
    assert.deepEqual(summary, JSON.parse(JSON.stringify(summarizeCadReport(report))))
    // 摘要必须比全文短，且全文与 report 完全一致
    const fullResult = await callTool(booted.ctx, { path: MM_DXF, detail: 'full' })
    const full = valueOf(fullResult)
    assert.deepEqual(JSON.parse(full.result), full.report)
    assert.ok(summaryText.length < full.result.length, '摘要必须比全文短')
  })

  test('摘要里的总数取 counts 的全量：max_items 截断明细后 *Total 不许跟着变小', async () => {
    const { result: text, report } = valueOf(await callTool(booted.ctx, { path: DIMS_DXF, max_items: 1 }))
    const summary = JSON.parse(text) as {
      layers: string[]; layersTotal: number; dimensions: unknown[]; dimensionsTotal: number
    }
    // 这份图本来就有多条图层与多个标注；明细被 max_items 截到 1 条，总数必须是真总数
    assert.equal(report.layers.length, 1, '明细确实被截断了（否则这条测试证明不了任何事）')
    assert.equal(report.dimensions.length, 1)
    assert.ok(report.counts.layers! > 1 && report.counts.dimensions! > 1, '夹具应有多层/多标注')
    assert.equal(summary.layersTotal, report.counts.layers, '总数要取 counts（全量），不是截断后的明细长度')
    assert.equal(summary.dimensionsTotal, report.counts.dimensions)
    assert.ok(summary.layersTotal > summary.layers.length, `层总数 ${summary.layersTotal} 应大于列出的 ${summary.layers.length}`)
    assert.ok(summary.dimensionsTotal > summary.dimensions.length)
  })

  test('块引用三轴缩放与 SPLINE 的 knots/weights：给的是实际参数，没有就报 0 不编', async () => {
    // 仓库夹具里没有这些形状：三轴不等的块引用、有理样条、超长样条。用 ezdxf 真写一份出来。
    const generated = await generateDxf('scale-spline.dxf', `
import sys, math, ezdxf
doc = ezdxf.new("R2000")
msp = doc.modelspace()
chair = doc.blocks.new("CHAIR")
chair.add_circle((0, 0), 10)
msp.add_blockref("CHAIR", (0, 0), dxfattribs={"xscale": 1, "yscale": 1, "zscale": 2})
msp.add_blockref("CHAIR", (100, 0), dxfattribs={"xscale": 2, "yscale": 2, "zscale": 2})
msp.add_rational_spline([(0, 0), (10, 0), (10, 10), (20, 10)], weights=[1, 0.5, 0.5, 1], degree=3)
msp.add_open_spline([(0, 0), (1, 1), (2, 0)], degree=2)
msp.add_open_spline([(i * 0.1, math.sin(i * 0.1)) for i in range(200)], degree=3)
doc.saveas(sys.argv[1])
`)
    const result = await callTool(booted.ctx, { path: generated })
    const report = reportOf(result)
    const stretched = report.blocks.references.find(ref => ref.insert![0] === 0)!
    const uniform = report.blocks.references.find(ref => ref.insert![0] === 100)!
    assert.deepEqual(stretched.scale, [1, 1, 2])
    assert.equal(stretched.uniformScale, false, 'x=y≠z 的 z 轴拉伸不是等比（只比 x/y 会误判成等比）')
    assert.equal(uniform.uniformScale, true, '三轴同值才是等比')
    const splines = report.geometry.curves.filter(curve => curve.type === 'SPLINE')
    const rational = splines[0]!
    assert.equal(rational.degree, 3)
    assert.equal(rational.controlPointCount, 4, '有理样条按控制点存储')
    assert.deepEqual(rational.controlPoints, [[0, 0, 0], [10, 0, 0], [10, 10, 0], [20, 10, 0]])
    assert.equal(rational.knotCount, 8, '节点向量是重建原样条的必要参数，不能只给计数')
    assert.deepEqual(rational.knots, [0, 0, 0, 0, 1, 1, 1, 1], '夹紧节点向量（4 控制点 + 3 次）')
    assert.equal(rational.weightCount, 4)
    assert.deepEqual(rational.weights, [1, 0.5, 0.5, 1])
    const plain = splines[1]!
    assert.equal(plain.degree, 2)
    assert.deepEqual(plain.knots, [0, 0, 0, 1, 1, 1], '非有理样条同样给节点向量')
    assert.equal(plain.weightCount, 0, '文件里没有权重就报 0')
    assert.deepEqual(plain.weights, [], '没有权重就是空表，不编一串 1 冒充')
    // 超长样条：节点数与点列同一套上限（128），全量计数与截断声明都在
    const big = splines[2]!
    assert.equal(big.controlPointCount, 200)
    assert.equal(big.knotCount, 204)
    assert.equal(big.knots!.length, 128, '节点向量与顶点/控制点同一套限额')
    assert.match(report.warnings.join('\n'), /CAD_CURVE_POINTS_TRUNCATED/, '截断事实要声明，不能悄悄少给')
    // 摘要侧同样按 32 个点截断 knots（与顶点/控制点一视同仁），计数仍在
    const summary = JSON.parse(valueOf(result).result) as {
      curves: Array<{ type: string; knotCount?: number; knots?: number[]; pointsCapped?: boolean }>
    }
    const summaryBig = summary.curves.find(curve => curve.knotCount === 204)!
    assert.equal(summaryBig.knots!.length, CAD_SUMMARY_POINTS)
    assert.equal(summaryBig.pointsCapped, true)
  })

  test('密集顶点图：解析侧与摘要侧各自有上限，vertexCount 与"被截断"的事实都保留', async () => {
    // 同一次调用同时给出摘要（模型看到的文本）与完整 report：两者必须来自同一份事实
    const denseResult = await callTool(booted.ctx, { path: DENSE_DXF })
    const { result } = valueOf(denseResult)
    const report = reportOf(denseResult)
    const wave = report.geometry.curves.find(curve => curve.closed === false)!
    const ring = report.geometry.curves.find(curve => curve.closed === true)!
    // 解析侧：顶点数报全量（200），点列截到 128，并把截断事实写进 warning 与 truncated
    assert.equal(wave.vertexCount, 200)
    assert.equal(wave.vertices!.length, 128)
    assert.equal(wave.verticesListed, 128)
    assert.equal(report.truncated.maxPointsPerCurve, 128)
    assert.match(report.warnings.join('\n'), /CAD_CURVE_POINTS_TRUNCATED/)
    assert.equal(ring.vertexCount, 60, '60 个顶点还没到解析侧上限，不截断')
    // 摘要侧：上限更小，点列被截但 vertexCount 与截断标记都在
    const summary = JSON.parse(result) as {
      curves: Array<{ index: number; type: string; vertexCount?: number; vertices?: unknown[]; pointsCapped?: boolean }>
    }
    const summaryWave = summary.curves.find(curve => curve.vertexCount === 200)!
    assert.equal(summaryWave.vertices!.length, CAD_SUMMARY_POINTS)
    assert.equal(summaryWave.pointsCapped, true)
    const summaryRing = summary.curves.find(curve => curve.vertexCount === 60)!
    assert.equal(summaryRing.vertices!.length, CAD_SUMMARY_POINTS, '60 > 32 也要截')
    assert.equal(summaryRing.pointsCapped, true)
    // 计数不受任何截断影响
    assert.equal(report.geometry.curveCount, 2)
    assert.equal(report.counts.curves, 2)
    // 两种消费面都不含"整图的第二份拷贝"：摘要文本显著小于全文
    const full = valueOf(await callTool(booted.ctx, { path: DENSE_DXF, detail: 'full' }))
    assert.ok(result.length * 2 < full.result.length,
      `摘要显著小于全文（摘要 ${result.length} / 全文 ${full.result.length}）`)
    assert.deepEqual(JSON.parse(full.result), full.report)
    // max_items 只截明细：曲线列表被截，curveCount 仍是 2
    const capped = reportOf(await callTool(booted.ctx, { path: DENSE_DXF, max_items: 1 }))
    assert.equal(capped.geometry.curves.length, 1)
    assert.equal(capped.geometry.curveCount, 2, '计数不受 max_items 影响')
    assert.equal(capped.truncated.lists.curves, true)
  })
})

describe('cad_inspect.py 直接跨进程（同一契约的另一入口）', { skip: hasInterpreter ? false : '未设置 LYAPUNOV_CAD_PYTHON' }, () => {
  function runScript(args: string[], python = PYTHON) {
    const result = spawnSync(python, ['-B', SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })
    return { ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  test('直接运行：退出码 0 + 结果行可解析（ASCII 与二进制各一次）', () => {
    for (const [file, binary] of [[MM_DXF, false], [BINARY_DXF, true]] as Array<[string, boolean]>) {
      const run = runScript(['--input', file])
      assert.equal(run.status, 0, run.stderr)
      const line = run.stdout.split('\n').find(item => item.startsWith(CAD_RESULT_PREFIX))!
      assert.ok(line, `应有结果行：${file}`)
      const report = JSON.parse(line.slice(CAD_RESULT_PREFIX.length)) as CadReport
      assert.equal(report.units.metresPerUnit, 0.001)
      assert.equal(report.format.binary, binary)
    }
  })

  test('Python 侧同样拒绝 DWG（不依赖 TS 前置检查）', () => {
    const run = runScript(['--input', DWG])
    assert.equal(run.status, 3)
    assert.equal(run.stdout.includes(CAD_RESULT_PREFIX), false)
    const line = run.stdout.split('\n').find(item => item.startsWith(CAD_ERROR_PREFIX))!
    const payload = JSON.parse(line.slice(CAD_ERROR_PREFIX.length)) as { error: { code: string } }
    assert.equal(payload.error.code, 'DWG_REQUIRES_CONVERTER')
  })

  test('Python 侧缺文件 / 截断 DXF / 损坏的二进制 DXF 各有稳定错误码', () => {
    const cases: Array<[string, string]> = [
      [MISSING, 'CAD_FILE_MISSING'],
      [TRUNCATED_DXF, 'CAD_PARSE_FAILED'],
      [BINARY_BROKEN, 'CAD_PARSE_FAILED'],
    ]
    for (const [file, code] of cases) {
      const run = runScript(['--input', file])
      assert.equal(run.status, 3, `${file}: ${run.stderr}`)
      const line = run.stdout.split('\n').find(item => item.startsWith(CAD_ERROR_PREFIX))!
      const payload = JSON.parse(line.slice(CAD_ERROR_PREFIX.length)) as { error: { code: string; message: string } }
      assert.equal(payload.error.code, code, file)
      assert.ok(payload.error.message.length > 0)
    }
  })

  test('解释器没装 ezdxf 时报 CAD_EZDXF_MISSING 并指出解释器路径', () => {
    const system = '/usr/bin/python3'
    if (!existsSync(system)) return
    const probe = spawnSync(system, ['-c', 'import ezdxf'], { encoding: 'utf8' })
    if (probe.status === 0) return // 该解释器已有 ezdxf，本用例不适用（不制造假失败）
    const run = runScript(['--input', MM_DXF], system)
    assert.equal(run.status, 3)
    const line = run.stdout.split('\n').find(item => item.startsWith(CAD_ERROR_PREFIX))!
    const payload = JSON.parse(line.slice(CAD_ERROR_PREFIX.length)) as { error: { code: string; message: string } }
    assert.equal(payload.error.code, 'CAD_EZDXF_MISSING')
    assert.match(payload.error.message, /ezdxf/)
  })
})
