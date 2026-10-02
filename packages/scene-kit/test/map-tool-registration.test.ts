/**
 * 地图工具的**产品入口**测试：`lyapunov-scene` 插件在 `config.mapTool` 打开时注册 `map_geojson_to_local`，
 * 关闭时不注册；依赖（系统 PROJ 命令行）不可用时装配照常成功，但工具调用会明确报 MAP_PROJ_UNAVAILABLE。
 *
 * 不 mock：真 Context + dsh-tools + dsh-session + 真 scene 插件 + 真 PROJ 子进程；文件用测试自己写在
 * 临时目录里的极小 GeoJSON（只证明"注册/不注册/路径按会话目录解析/缺依赖的报法"，不代表真实数据精度——
 * 真实公开数据在 map-constraints-real-data.test.ts）。
 * 运行：`bun test packages/scene-kit/test/map-tool-registration.test.ts`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import FsLocal from "@deepseek-ai/dsh-fs-local"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as scenePlugin from "../src/plugin.ts"

const TOOL = "map_geojson_to_local"
const CROSS = "map_cross_check_sources"
const signal = new AbortController().signal

let base: string, workspace: string, calls = 0

/** 会话工作目录里的一份极小 GeoJSON（苏黎世附近的方块）。 */
const SQUARE = {
  type: "Feature", properties: { name: "测试方块" },
  geometry: { type: "Polygon", coordinates: [[[8.5417, 47.3769], [8.5517, 47.3769], [8.5517, 47.3869], [8.5417, 47.3869], [8.5417, 47.3769]]] },
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-map-tool-"))
  workspace = join(base, "workspace")
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, "square.geojson"), JSON.stringify(SQUARE), "utf8")
  calls = 0
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 真装配：与产品里同一套插件（插件、工具、会话、命令、fs 都是真的）。 */
async function mount(config: { mapTool?: boolean }): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(Commands)
  await ctx.plugin(FsLocal, { cwd: base })
  await ctx.plugin(scenePlugin, { dataRoot: join(base, "data"), ...config })
  // 会话工作目录 = 工作区（原生 agent 的 exec.agent.session.header.cwd 就是它）
  const session = ctx.sessions.create(SessionId(`map-tool-${++calls}`), { meta: { cwd: workspace } })
  return { ctx, agent: { id: session.id, session } as Agent }
}

async function call(ctx: Context, agent: Agent, input: unknown, name = TOOL): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`map-tool-${++calls}`), name, arguments: { input }, signal, agent })
}

describe("scene 插件里的可选地图工具（config.mapTool）", () => {
  test("默认不注册：注册表里没有它，调用得到明确的未知工具错误", async () => {
    const { ctx, agent } = await mount({})
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    expect(ctx.tools.get(CROSS)).toBeUndefined()
    const result = await call(ctx, agent, { geojson: SQUARE, crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
    expect(result.isError).toBe(true)
    await ctx.fiber.dispose()
  })

  test("mapTool=true 时注册，并能按会话工作目录读相对路径、返回 PROJ 引擎与基准事实", async () => {
    const { ctx, agent } = await mount({ mapTool: true })
    expect(ctx.tools.get(TOOL)).toBeDefined()
    expect(ctx.tools.get(CROSS)).toBeDefined()
    // 交叉校对同一个注册开关下也要真的能跑（纯计算，不需要 PROJ/文件）
    const cross = await call(ctx, agent, {
      sources: [
        { id: "地图-2026", kind: "map", source: { object: "苏黎世市界", era: { label: "2026", status: "confirmed" } }, declaredValues: [{ name: "周长", value: 58650.67, unit: "m", basis: "measured" }] },
        { id: "CAD-2026", kind: "cad", source: { object: "苏黎世市界", era: { label: "2026", status: "confirmed" } }, declaredValues: [{ name: "周长", value: 58000.0, unit: "m", basis: "measured" }] },
      ],
      tolerance: { relativePpm: 1000 },
    }, CROSS)
    expect(cross.isError).toBe(false)
    expect((cross as any).value.ok).toBe(true)
    expect((cross as any).value.summary.conflicts).toEqual(["周长"])
    const result = await call(ctx, agent, { path: "square.geojson", crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 }, includeVertices: false })
    expect(result.isError).toBe(false)
    const value = (result as any).value
    expect(value.ok).toBe(true)
    expect(value.limits.totalVertices).toBe(5)
    expect(value.projection.engine).toContain("PROJ")
    expect(value.projection.version).toMatch(/^PROJ \d+\.\d+/)
    // 基准运算事实随结果一起给：4326→4326 是 noop/0 m（PROJ 的 projinfo 原话）
    expect(value.projection.datumOperation.kind).toBe("noop")
    expect(value.projection.datumOperation.accuracy).toBe("0 m")
    expect(value.projection.datumPolicy).toBe("require-exact")
    await ctx.fiber.dispose()
  })

  test("依赖不可用（PROJ 找不到）：装配照常成功，工具调用明确报 MAP_PROJ_UNAVAILABLE", async () => {
    const previous = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
    process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = "/nonexistent-proj-bin"
    try {
      // 依赖缺失不该让插件起不来，也不该静默少注册一个工具：注册发生，失败发生在调用点上
      const { ctx, agent } = await mount({ mapTool: true })
      expect(ctx.tools.get(TOOL)).toBeDefined()
      const result = await call(ctx, agent, { geojson: SQUARE, crs: "EPSG:4326", anchor: { lon: 8.5417, lat: 47.3769 } })
      expect(result.isError).toBe(true)
      const message = result.isError ? result.error.message : ""
      expect(message).toContain("MAP_PROJ_UNAVAILABLE")
      expect(message).toContain("apt install proj-bin")     // 依赖状态里带可执行动作
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
      else process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = previous
    }
  })
})
