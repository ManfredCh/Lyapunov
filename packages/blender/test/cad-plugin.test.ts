/**
 * 产品 blender **完整插件**（`packages/blender/src/plugin.ts` 的 apply）的装载测试。
 *
 * cad.test.ts 走的是"直接调 registerCadTools"，证明不了**接线**：plugin.ts 里漏一行 import、
 * apply 里没调用注册函数、或者插件因为缺 inject 服务根本没激活，那里的测试都会照样全绿。
 * 这里反着来——把产品插件当插件装进一棵真实 Cordis 树（systemPrompt + tools + subprocess-local
 * + jobs，与产品 Host 的 inject 契约一致），再从 ToolRegistry 调 `cad_inspect`，证明：
 *   1. 插件真的 apply 了（同插件注册的 blender_run / blender_texture_search / blender_job_images 同时在册）；
 *   2. `cad_inspect` 真的解析 L 形 DXF：真实点列（6 个顶点、27 m²，不是外接矩形 36 m²），
 *      并核对读取的文件 sha256 就是那份夹具本身（不是同名诱饵）；
 *   3. 相对路径基准是**会话任务 cwd**：config.workspace 里放一个同名诱饵 DXF 也抢不走；
 *      没有会话 cwd 时才回落 config.workspace（此时读到的就是诱饵，说明回落真的生效）；
 *   4. 解释器**显式配置优先**（环境变量被污染成不存在的路径也不受影响），
 *      两者都没有时明确报 CAD_PYTHON_UNCONFIGURED——不猜解释器，也不把"源码在"说成"可用"。
 *
 * 运行（同 cad.test.ts：Bun 1.3.13 加载不了 dsh-subprocess-local，产品 Host 本来就是 Node）：
 *   LYAPUNOV_CAD_PYTHON=<装了 ezdxf 的隔离解释器> node --test packages/blender/test/cad-plugin.test.ts
 * 未设置 LYAPUNOV_CAD_PYTHON 时，依赖解释器的用例整组 skip（不静默当成通过）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CadReport } from '../src/cad.ts'
import * as blenderPlugin from '../src/plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT_ROOT = resolve(HERE, '..', '..', '..')
const FIXTURES = join(HERE, 'cad-fixtures')
const L_SHAPE_DXF = join(FIXTURES, 'plan-l-shape.dxf')
const MM_DXF = join(FIXTURES, 'plan-mm.dxf')
const PYTHON = process.env.LYAPUNOV_CAD_PYTHON?.trim() ?? ''
const hasInterpreter = PYTHON !== '' && existsSync(PYTHON)

/** 本产品插件声明的必需服务；少一个都证明不了"完整插件能装起来"。 */
const INJECTED_SERVICES = ['tools', 'subprocess', 'jobs'] as const

type BlenderConfig = Parameters<typeof blenderPlugin.apply>[1]

/**
 * 装**真正的产品插件**：inject 的服务全部就位（与 runtime-patch 给 Host 的装配同一契约），
 * 插件配置按测试需要给（cadPython 走的就是 runtime-patch 显式传的那一项）。
 */
async function bootProductPlugin(config: BlenderConfig = {}) {
  const ctx = new Context()
  const services = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(LocalJobRegistry),
  ]
  const missing = INJECTED_SERVICES.filter(name => ctx.get(name) === undefined)
  assert.deepEqual(missing, [], `测试装配自己就缺服务：${missing.join(', ')}`)
  const pluginFiber = await ctx.plugin(blenderPlugin, config)
  let pluginClosed = false
  let closed = false
  return {
    ctx,
    /** 只卸插件、留下服务：用来验证"工具确实是插件注册的"，而不是测试自己塞进注册表的。 */
    async closePlugin() {
      if (pluginClosed) return
      pluginClosed = true
      await pluginFiber.dispose()
    },
    async close() {
      if (closed) return
      closed = true
      await this.closePlugin()
      for (const fiber of services) await fiber.dispose()
    },
  }
}

/** 调工具；scope.cwd 就是原生会话的 header.cwd（相对路径的基准事实）。 */
async function callTool(ctx: Context, name: string, args: Record<string, unknown>, scope?: { cwd: string }): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    callId: ToolCallId(`cad-plugin-test:${name}:${String(args.path ?? '')}:${scope?.cwd ?? ''}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(scope ? { agent: { session: { header: { cwd: scope.cwd } } } as never } : {}),
  })
}

function valueOf(result: ToolExecutionResult): { result: string; report: CadReport } {
  if (result.isError) throw new Error(`工具失败：${JSON.stringify(result.content ?? null).slice(0, 400)}`)
  return result.value as unknown as { result: string; report: CadReport }
}

function errorTextOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error(`期望失败但成功了：${JSON.stringify(result.value ?? null).slice(0, 300)}`)
  return JSON.stringify(result.content ?? null)
}

/** 文件真实摘要：用来证明"读到的就是这份夹具"，而不是同名同长度的另一个文件。 */
async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** 临时改一个环境变量，跑完必定还原（测试自己不许留下全局状态）。 */
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

describe('产品 blender 插件装载（cad_inspect 随插件注册）', () => {
  test('ctx.plugin(blender plugin) 之后 cad_inspect 与同插件的其他工具都在 ToolRegistry 里', async () => {
    // workspace 取产品根，与 runtime-patch 给 Host 的 blender 配置同一形状。
    const booted = await bootProductPlugin({ workspace: PRODUCT_ROOT })
    const names = ['blender_run', 'blender_texture_search', 'blender_job_images', 'cad_inspect']
    try {
      for (const name of names)
        assert.ok(booted.ctx.tools.get(name), `${name} 应该随插件注册（插件没激活或 apply 没走到注册）`)
      // 工具是插件注册的，不是测试自己塞的：只卸插件（服务还在）后整批消失。
      await booted.closePlugin()
      for (const name of names)
        assert.equal(booted.ctx.tools.get(name), undefined, `${name} 应该在插件卸载后注册表里消失`)
    } finally {
      await booted.close()
    }
  })

  test('没有解释器配置（插件 config 与环境变量都没有）时明确报 CAD_PYTHON_UNCONFIGURED，不说"可用"', async () => {
    const booted = await bootProductPlugin()
    try {
      const text = await withEnv('LYAPUNOV_CAD_PYTHON', undefined, async () =>
        errorTextOf(await callTool(booted.ctx, 'cad_inspect', { path: L_SHAPE_DXF })))
      assert.match(text, /CAD_PYTHON_UNCONFIGURED/, '缺配置要用稳定错误码点名')
      assert.match(text, /LYAPUNOV_CAD_PYTHON/, '错误里要给出配置入口，不能只说"失败"')
      assert.match(text, /ezdxf/, '错误里要说清依赖是什么')
      // 源码在、包也装了，但解释器没配就是没配：错误里不许出现"可用/已可用"这类结论。
      assert.doesNotMatch(text, /可用/, '配置缺失时不许把源码存在说成可用')
    } finally {
      await booted.close()
    }
  })
})

describe('产品插件里的 cad_inspect 真的解析 L 形 DXF（需要 CAD 解释器）', () => {
  test('显式 cadPython（runtime-patch 传的那一项）优先于被污染的环境变量，并读到真实点列', { skip: !hasInterpreter }, async () => {
    // 环境变量故意指向不存在的解释器：后台/隔离环境里它可能缺失或指向别处，
    // runtime-patch 显式传的 cadPython 必须是生效的那一个。
    const booted = await bootProductPlugin({ cadPython: PYTHON })
    try {
      const { report } = await withEnv('LYAPUNOV_CAD_PYTHON', '/nonexistent/cad/python', async () =>
        valueOf(await callTool(booted.ctx, 'cad_inspect', { path: L_SHAPE_DXF })))
      assert.equal(report.file.path, resolve(L_SHAPE_DXF), '读的是传入的绝对路径')
      assert.equal(report.file.sha256, await sha256(L_SHAPE_DXF), 'sha256 必须是这份夹具本身')
      assert.equal(report.units.metresPerUnit, 0.001)
      const outline = report.geometry.curves.find(curve => curve.type === 'LWPOLYLINE' && curve.closed === true)
      assert.ok(outline, 'L 形外轮廓应是闭合 LWPOLYLINE')
      // 真实点列：外接矩形会退化成 4 个角点，这里必须是 6 个（缺口两个角都在）
      assert.deepEqual(outline.vertices, [
        { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 },
        { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 },
      ])
      assert.equal(outline.vertices!.length, 6)
      const scale = report.units.metresPerUnit!
      const points = outline.vertices!.map(vertex => [vertex.x * scale, vertex.y * scale] as [number, number])
      const area = Math.abs(points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length]
        return sum + (point[0] * next[1] - next[0] * point[1])
      }, 0)) / 2
      assert.ok(Math.abs(area - 27) < 1e-9, `L 形底面积应为 27 m²（外接矩形会是 36），实际 ${area}`)
    } finally {
      await booted.close()
    }
  })

  test('插件 config 没给 cadPython 时回落到 LYAPUNOV_CAD_PYTHON（隔离环境里只有环境变量也照样可用）', { skip: !hasInterpreter }, async () => {
    const booted = await bootProductPlugin({ workspace: PRODUCT_ROOT })
    try {
      const { report } = await withEnv('LYAPUNOV_CAD_PYTHON', PYTHON, async () =>
        valueOf(await callTool(booted.ctx, 'cad_inspect', { path: L_SHAPE_DXF })))
      assert.equal(report.units.metresPerUnit, 0.001)
      assert.equal(report.file.sha256, await sha256(L_SHAPE_DXF))
    } finally {
      await booted.close()
    }
  })

  test('相对路径以会话任务 cwd 为准：config.workspace 里放同名诱饵 DXF 也抢不走；无会话 cwd 时才回落', { skip: !hasInterpreter }, async () => {
    // 诱饵：config.workspace 下同样叫 plan-l-shape.dxf，但内容是另一份图。
    const workspace = await mkdtemp(join(tmpdir(), 'cad-plugin-workspace-'))
    await copyFile(MM_DXF, join(workspace, 'plan-l-shape.dxf'))
    const decoy = await sha256(MM_DXF)
    assert.notEqual(decoy, await sha256(L_SHAPE_DXF), '诱饵与真夹具必须不是同一份文件，否则这条测试证明不了任何事')
    const booted = await bootProductPlugin({ cadPython: PYTHON, workspace })
    try {
      // 有会话 cwd：按会话 cwd 解析（fixtures 目录），必须读到真 L 形
      const viaSession = valueOf(await callTool(booted.ctx, 'cad_inspect', { path: 'plan-l-shape.dxf' }, { cwd: FIXTURES })).report
      assert.equal(viaSession.file.path, resolve(L_SHAPE_DXF), '会话 cwd 必须压过 config.workspace')
      assert.equal(viaSession.file.sha256, await sha256(L_SHAPE_DXF))
      const outline = viaSession.geometry.curves.find(curve => curve.type === 'LWPOLYLINE' && curve.closed === true)!
      assert.equal(outline.vertices!.length, 6, '会话 cwd 下读到的是 L 形的 6 个真实顶点')
      // 没有会话 cwd：才回落到 config.workspace（这时读到的就是诱饵，证明回落真的生效、不是碰巧）
      const viaWorkspace = valueOf(await callTool(booted.ctx, 'cad_inspect', { path: 'plan-l-shape.dxf' })).report
      assert.equal(viaWorkspace.file.path, join(workspace, 'plan-l-shape.dxf'), '无会话 cwd 时按 config.workspace 解析')
      assert.equal(viaWorkspace.file.sha256, decoy, '回落路径读到的确实是 workspace 里的那份（诱饵）')
      // 会话 cwd 也没有、workspace 也没配：明确报未解析，不许拿进程 cwd 顶替
      const bare = await bootProductPlugin({ cadPython: PYTHON })
      try {
        const text = errorTextOf(await callTool(bare.ctx, 'cad_inspect', { path: 'plan-l-shape.dxf' }))
        assert.match(text, /CAD_CWD_UNRESOLVED/)
      } finally {
        await bare.close()
      }
    } finally {
      await booted.close()
    }
  })

  test('L 形结果里带 bulge 的弧墙真实可读（柱/门弧参数逐条给出，不是只有直线段）', { skip: !hasInterpreter }, async () => {
    // 供本任务目录里的真实 Blender 脚本使用同一条结果：这里先钉住它读得出弧与圆的真实参数，
    // 不然"用真实点列建墙"就退化成只能建直线。
    const booted = await bootProductPlugin({ cadPython: PYTHON })
    try {
      const { report } = valueOf(await callTool(booted.ctx, 'cad_inspect', { path: L_SHAPE_DXF }))
      const column = report.geometry.curves.find(curve => curve.type === 'CIRCLE')!
      assert.deepEqual(column.center, [1000, 1000, 0])
      assert.equal(column.radius, 300)
      const door = report.geometry.curves.find(curve => curve.type === 'ARC')!
      assert.deepEqual([door.center, door.radius, door.startAngle, door.endAngle], [[3000, 3000, 0], 900, 0, 90])
      const curved = report.geometry.curves.filter(curve => curve.type === 'LWPOLYLINE')
        .find(curve => curve.vertices?.some(vertex => vertex.bulge !== undefined))!
      assert.equal(curved.vertices!.find(vertex => vertex.bulge !== undefined)!.bulge, 1)
      // 边界含半圆外凸（半径 750 绘图单位）：外接矩形得不到这个数
      assert.equal(report.bounds.sizeDrawingUnits![0], 6750)
    } finally {
      await booted.close()
    }
  })
})
