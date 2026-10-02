/**
 * G15 真实入口：产品内部 LLM 修改候选过滤 → 检查 → 运行 → 回滚（合同 §2.13、§6.2 G15 行）。
 *
 * 本入口用**真实** Cordis 装配驱动**真实** `@deepseek-ai/dsh-tool-cordis` 工具，不新建注册平台：
 * 真的 vendored Cordis Context、真的 `@deepseek-ai/dsh-tools` 注册表与执行管线
 * （`ctx.tools.execute`，与 agent loop 的 `tools[TOOL_RUNTIME_SCHEDULER].prepare/dispatch/finalize`
 * 是同一条准备/派发/收尾管线）、真的 `@deepseek-ai/dsh-system-prompt`、
 * 真的 `@deepseek-ai/dsh-cordis-host-runner`（`ctx.dynamicCordisRunner` / `ctx.cordisInspect`）。
 * 动态包源码经真实 `node:vm` 沙箱求值，用真实 `harness.defineTool`/`harness.registerTool` 注册进真实工具表。
 * 每条 check 的读数（工具数量、active/current 指针、真实调用返回、失败原文）都来自实际调用，
 * 不接受硬编码成功。
 *
 * 诚实边界（依合同 §7 不伪造）：Agent 由本脚本按上游 `cordis-host-runner/tests/helpers.ts`
 * 同款替身提供（只有 `id`/`steer`/`inject`），因此**本门**只覆盖插件机制层。这与"本机没有模型凭据"
 * 无关——「由内部 Agent 用自然语言完成」那一层已由 `--gate G15LIVE` 用**本地真实模型回合**单独验证
 * （3/3 PASS；本地开源 27B 模型，不是官方模型，见下方 blocked 第 2 条）。
 * 仍留在本门之外的是：持久包安装与重启、无关 Scene 数据等条件；本门在给出全部真实机制读数后仍报 BLOCKED。
 */
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import type { Agent } from "@deepseek-ai/dsh-agent"
import CordisRunner from "@deepseek-ai/dsh-cordis-host-runner"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import type { SessionId } from "@deepseek-ai/dsh-session/types"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import * as ToolCordis from "@deepseek-ai/dsh-tool-cordis"
import ToolRegistry from "@deepseek-ai/dsh-tools"
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools"

import { runtimePaths } from "../../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import type { Check, GateResult } from "./contract.ts"
import { runtimePluginInsert } from "../runtime-patch.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")

/** 动态包注册的工具名：抓取候选过滤，正是合同 §2.13 验收句子里被改的那个行为。 */
const DYNAMIC_TOOL = "g15_grasp_candidates"
/** `@deepseek-ai/dsh-tool-cordis` 自带的七个工具（inspect_list/query/self、define、run、stop、undefine）。 */
const CORDIS_TOOL_COUNT = 7
/** vendored Cordis `vendor/cordis/src/fiber.ts:147` 的 `const enum FiberState` 顺序：ACTIVE = 2（const enum 无运行时导出）。 */
const FIBER_STATE_ACTIVE = 2

/**
 * 动态包 host 半源码：一段普通 JS 函数体（不是 TS/JSX/import），经真实沙箱求值后注册一个真实 Tool。
 * 版本差异只体现在 `maxWidthM` 与返回的 `version` 上，便于用真实调用区分"行为是否改变/恢复"。
 */
function filterPackageCode(maxWidthM: number, version: string): string {
  return `return {
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: '${DYNAMIC_TOOL}',
      description: 'G15 动态抓取候选过滤（版本切换只经 cordis_run）',
      parameters: { candidates: { type: 'json', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args) {
        const kept = args.candidates.filter((candidate) => candidate.widthM <= ${maxWidthM})
        return { version: '${version}', maxWidthM: ${maxWidthM}, widths: kept.map((candidate) => candidate.widthM) }
      }
    }))
  }
}`
}

/** 故意失败的版本：`apply` 抛出。用于验收"错误版本清理后上一版实际 active/可调用"。 */
const FAILING_PACKAGE_CODE = `return { inject: ['tools'], apply() { throw new Error('G15 故意失败版本：apply 抛出') } }`

/** 两个真实候选（宽度 0.048 / 0.068）：阈值 0.08 全留、0.05 只留第一个。 */
const CANDIDATES = [{ widthM: 0.048 }, { widthM: 0.068 }]

/** 一次 define 返回的不可变身份。 */
interface PackageIds { pluginId: string; packageId: string }

/** 一个动态插件在真实 runner 快照里的读数。 */
interface PluginRow { pluginId: string; packages: number; current: string | null; active: string | null; fiberState: number | null }

/** 把工具结果压成一行可核对读数：成功取 canonical value，失败取真实错误原文。 */
function readResult(result: ToolExecutionResult): string {
  return result.isError
    ? `isError=true message=${JSON.stringify(result.error.message)}`
    : `isError=false value=${JSON.stringify(result.value)}`
}

/** 取 define 的返回身份；失败时返回 undefined，让调用方把原文写进 detail。 */
function readIds(result: ToolExecutionResult): PackageIds | undefined {
  if (result.isError) return undefined
  const value = result.value as { pluginId?: unknown; packageId?: unknown }
  return typeof value.pluginId === "string" && typeof value.packageId === "string"
    ? { pluginId: value.pluginId, packageId: value.packageId }
    : undefined
}

/** 读一次动态工具调用的真实返回值。 */
function readToolValue(result: ToolExecutionResult): { version?: string; widths?: number[] } {
  return result.isError ? {} : result.value as { version?: string; widths?: number[] }
}

/**
 * G15：内部 LLM 修改/启用/回滚插件的真实入口。
 * @returns 每条 check 的真实读数；`blocked` 非空表示"由内部 Agent 用自然语言完成"等条件未被本机凭据覆盖。
 */
export async function gateG15(): Promise<GateResult> {
  const checks: Check[] = []

  // ── §2.13.1 Developer Profile 是否真的装配了 cordis 工具包（读产品装配代码的真实返回值） ──
  try {
    // 真实开发运行根（与 prepareProfile 同一 runtimePaths 计算，本门不落盘、不启动 Host）。
    const developerPaths = runtimePaths({ root: join(PRODUCT_ROOT, ".runtime/developer"), mode: "developer" })
    const web = runtimePluginInsert({ mode: "developer", surface: "web", sceneRoot: developerPaths.sceneRoot, engine: "none" })
    const terminal = runtimePluginInsert({ mode: "developer", surface: "terminal", sceneRoot: developerPaths.sceneRoot, engine: "none" })
    const webCordis = web.filter(row => row.name === "@deepseek-ai/dsh-tool-cordis")
    const terminalRunner = terminal.filter(row => row.name === "@deepseek-ai/dsh-cordis-host-runner")
    checks.push({
      name: "developer_profile_registers_cordis_tools",
      ok: webCordis.length === 1 && terminalRunner.length === 1,
      detail: `runtimePluginInsert(mode=developer, sceneRoot=${developerPaths.sceneRoot}) 真实返回：web 面 tool-cordis=${JSON.stringify(webCordis)}；terminal 面 host-runner=${JSON.stringify(terminalRunner)}；web 面插件行数=${web.length}`,
    })
  } catch (error) {
    checks.push({ name: "developer_profile_registers_cordis_tools", ok: false, detail: `读取产品装配返回失败：${String((error as Error)?.message ?? error)}` })
  }

  // ── 真实 Cordis 树：真 Context + 真工具注册表 + 真 system prompt + 真 runner + 真 tool-cordis ──
  const ctx = new Context()
  let callSeq = 0
  /** 模型缺席：与上游 cordis-host-runner/tests/helpers.ts 相同的 Agent 替身，只保留 Session 身份。 */
  const standIn = (id: string): Agent => ({ id: id as SessionId, steer() {}, inject() {} }) as unknown as Agent
  const agentA = standIn("g15-agent-a")
  const agentB = standIn("g15-agent-b")
  const invoke = async (name: string, args: unknown, agent: Agent): Promise<ToolExecutionResult> => {
    callSeq += 1
    return await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`g15-${callSeq}`),
      name,
      arguments: args,
      agent,
    })
  }
  const toolNames = (): string[] => ctx.tools.schemas().map(schema => schema.name)
  /** 真实 runner 快照：每个动态插件的版本指针与 active Run 的 fiber 状态。 */
  const rowsOf = (agent: Agent): PluginRow[] => ctx.dynamicCordisRunner.snapshot(agent).map(row => ({
    pluginId: String(row.pluginId),
    packages: row.packages.length,
    current: row.currentPackageId === undefined ? null : String(row.currentPackageId),
    active: row.activeRun === undefined ? null : String(row.activeRun.packageId),
    fiberState: row.activeRun?.fiber?.state ?? null,
  }))
  const rowOf = (agent: Agent, pluginId: string): PluginRow | undefined => rowsOf(agent).find(row => row.pluginId === pluginId)

  try {
    await ctx.plugin(Timer)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(CordisRunner, {})
    await ctx.plugin(ToolCordis)

    // ── §2.13.2 真实工具面：登记了哪些 cordis 工具 ──
    const registered = toolNames()
    const cordisTools = registered.filter(name => name.startsWith("cordis_"))
    checks.push({
      name: "cordis_tools_registered",
      ok: cordisTools.length === CORDIS_TOOL_COUNT,
      detail: `真实 ToolRegistry 里 cordis 工具数=${cordisTools.length}/${CORDIS_TOOL_COUNT}；names=[${cordisTools.join(",")}]；registry 总数=${registered.length}`,
    })

    // ── §2.13.2 先 Inspect 再改：真实 provider 目录与真实 host 契约查询 ──
    const inspected = await invoke("cordis_inspect_list", {}, agentA)
    const providers = inspected.isError ? [] : (inspected.value as { providers?: Array<{ platform: string; id: string; methods: unknown[] }> }).providers ?? []
    checks.push({
      name: "inspect_list_real_providers",
      ok: providers.length > 0,
      detail: `${readResult(inspected).slice(0, 100)}；providers=${JSON.stringify(providers.map(provider => `${provider.platform}:${provider.id}(${provider.methods.length})`))}`,
    })

    const queried = await invoke("cordis_inspect_query", { platform: "host", provider: "Tool", method: "listTools" }, agentA)
    const queriedTools = queried.isError ? [] : ((queried.value as { data?: { tools?: Array<{ name: string }> } }).data?.tools ?? [])
    checks.push({
      name: "inspect_query_real_host_contract",
      ok: queriedTools.some(tool => tool.name === "cordis_define"),
      detail: `cordis_inspect_query(host/Tool.listTools) 真实返回工具数=${queriedTools.length}；含 cordis_define=${queriedTools.some(tool => tool.name === "cordis_define")}`,
    })

    // ── 定义 v1（候选过滤保持 0.08）：define 只是参数/语法登记，不执行 apply、不注册 Tool ──
    const defined1 = await invoke("cordis_define", {
      plugin: { kind: "new", idPrefix: "grasp" },
      name: "抓取候选过滤 v1",
      purpose: "G15 真实验收：候选宽度过滤可切换、可回滚",
      code: { host: filterPackageCode(0.08, "v1") },
    }, agentA)
    const v1 = readIds(defined1)
    if (v1 === undefined) {
      checks.push({ name: "define_only_records_parameter_and_syntax", ok: false, detail: `define v1 未返回身份：${readResult(defined1)}` })
      return { gate: "G15", checks, blocked: null }
    }
    const afterDefineTools = toolNames()
    const callBeforeRun = await invoke(DYNAMIC_TOOL, { candidates: CANDIDATES }, agentA)
    const rowAfterDefine = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "define_only_records_parameter_and_syntax",
      ok: afterDefineTools.length === registered.length
        && !afterDefineTools.includes(DYNAMIC_TOOL)
        && callBeforeRun.isError
        && callBeforeRun.error.info?.code === "UNKNOWN_TOOL"
        && rowAfterDefine?.current === null
        && rowAfterDefine?.active === null,
      detail: `define → ${readResult(defined1)}；工具数 ${registered.length}→${afterDefineTools.length}（含 ${DYNAMIC_TOOL}=${afterDefineTools.includes(DYNAMIC_TOOL)}）；define 后立即调用该 Tool=${readResult(callBeforeRun)}；snapshot=${JSON.stringify(rowsOf(agentA))}`,
    })

    // ── 启用 v1：run 模式让插件真正 active、Tool 真实注册且可调用 ──
    const ran1 = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v1.packageId, mode: "run" }, agentA)
    const runReceipt = ran1.isError ? undefined : (ran1.value as { status?: string; host?: { status?: string; waitingFor?: string[] }; currentPackageId?: string })
    const afterRunTools = toolNames()
    const callV1 = await invoke(DYNAMIC_TOOL, { candidates: CANDIDATES }, agentA)
    const rowAfterRun = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "run_activates_plugin_and_registers_callable_tool",
      ok: runReceipt?.status === "running"
        && runReceipt.host?.status === "running"
        && (runReceipt.host?.waitingFor ?? ["?"]).length === 0
        && runReceipt.currentPackageId === v1.packageId
        && rowAfterRun?.active === v1.packageId
        && rowAfterRun?.fiberState === FIBER_STATE_ACTIVE
        && afterRunTools.includes(DYNAMIC_TOOL)
        && !callV1.isError
        && JSON.stringify(readToolValue(callV1).widths) === JSON.stringify([0.048, 0.068]),
      detail: `cordis_run(mode=run) → ${readResult(ran1).slice(0, 220)}；host.status=${runReceipt?.host?.status} waitingFor=${JSON.stringify(runReceipt?.host?.waitingFor)}（未停在等依赖）；工具数 ${registered.length}→${afterRunTools.length}（含 ${DYNAMIC_TOOL}=${afterRunTools.includes(DYNAMIC_TOOL)}）；真实调用=${readResult(callV1)}；snapshot=${JSON.stringify(rowsOf(agentA))}`,
    })

    // 无关会话读数：A 的插件定义对 B 不可见（在 A 的插件存活期间读取）。
    const selfA = await invoke("cordis_inspect_self", {}, agentA)
    const selfB = await invoke("cordis_inspect_self", {}, agentB)
    const pluginsOf = (result: ToolExecutionResult): Array<{ pluginId: string }> =>
      result.isError ? [] : ((result.value as { plugins?: Array<{ pluginId: string }> }).plugins ?? [])
    const bToolSurface = await invoke("cordis_inspect_list", {}, agentB)
    checks.push({
      name: "unrelated_session_definition_scope",
      ok: pluginsOf(selfA).length === 1 && pluginsOf(selfB).length === 0 && !bToolSurface.isError,
      detail: `agent A inspect_self.plugins=${JSON.stringify(pluginsOf(selfA).map(row => row.pluginId))}；agent B inspect_self.plugins=${JSON.stringify(pluginsOf(selfB).map(row => row.pluginId))}；B 的 inspect_list 仍可用=${!bToolSurface.isError}。注意：host 半注册的 Tool 落在进程级工具表，B 也能看到它，本薄树不据此声称 Scene 级隔离`,
    })

    // ── 修改抓取过滤并启用：kind:"existing" 追加不可变版本 + mode:"update" 切换 ──
    const defined2 = await invoke("cordis_define", {
      plugin: { kind: "existing", pluginId: v1.pluginId },
      name: "抓取候选过滤 v2（收紧到 0.05）",
      purpose: "G15 真实验收：改用 update 切换版本",
      code: { host: filterPackageCode(0.05, "v2") },
    }, agentA)
    const v2 = readIds(defined2)
    if (v2 === undefined) {
      checks.push({ name: "update_switches_version_and_behaviour", ok: false, detail: `define v2 未返回身份：${readResult(defined2)}` })
      return { gate: "G15", checks, blocked: null }
    }
    const updated = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v2.packageId, mode: "update" }, agentA)
    const callV2 = await invoke(DYNAMIC_TOOL, { candidates: CANDIDATES }, agentA)
    const rowAfterUpdate = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "update_switches_version_and_behaviour",
      ok: !updated.isError
        && rowAfterUpdate?.current === v2.packageId
        && rowAfterUpdate?.active === v2.packageId
        && rowAfterUpdate?.packages === 2
        && JSON.stringify(readToolValue(callV2).widths) === JSON.stringify([0.048]),
      detail: `define(kind=existing) → ${v2.pluginId}/${v2.packageId}；cordis_run(mode=update) → ${readResult(updated).slice(0, 220)}；切换后真实调用=${readResult(callV2)}（过滤收紧到只留 0.048，行为已改变）；snapshot=${JSON.stringify(rowsOf(agentA))}`,
    })

    // 版本纪律：换成不同于 current 的版本必须用 update，run 只用于重启当前版本。
    const wrongMode = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v1.packageId, mode: "run" }, agentA)
    checks.push({
      name: "version_switch_requires_update_mode",
      ok: wrongMode.isError && wrongMode.error.message.includes("update"),
      detail: `current=${v2.packageId} 时用 mode:"run" 切到 ${v1.packageId} → ${readResult(wrongMode)}（真实拒绝文案）`,
    })

    // ── 回滚刚才修改：仍用 mode:"update" 切回旧版本，历史定义保留 ──
    const rolledBack = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v1.packageId, mode: "update" }, agentA)
    const callRollback = await invoke(DYNAMIC_TOOL, { candidates: CANDIDATES }, agentA)
    const rowAfterRollback = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "rollback_restores_previous_behaviour",
      ok: !rolledBack.isError
        && rowAfterRollback?.current === v1.packageId
        && rowAfterRollback?.active === v1.packageId
        && rowAfterRollback?.packages === 2
        && JSON.stringify(readToolValue(callRollback).widths) === JSON.stringify([0.048, 0.068]),
      detail: `cordis_run(mode=update, packageId=${v1.packageId}) → ${readResult(rolledBack).slice(0, 220)}；回滚后真实调用=${readResult(callRollback)}（恢复 v1 的 [0.048,0.068]，历史定义仍在 packages=${rowAfterRollback?.packages}）；snapshot=${JSON.stringify(rowsOf(agentA))}`,
    })

    // ── §2.13.4 失败更新：先撤销旧 Run，指针仍指旧包不代表旧实例还活着 ──
    const defined3 = await invoke("cordis_define", {
      plugin: { kind: "existing", pluginId: v1.pluginId },
      name: "抓取候选过滤 v3（故意失败）",
      purpose: "G15 真实验收：失败更新的回滚边界",
      code: { host: FAILING_PACKAGE_CODE },
    }, agentA)
    const v3 = readIds(defined3)
    if (v3 === undefined) {
      checks.push({ name: "failed_update_revokes_old_run", ok: false, detail: `define v3 未返回身份：${readResult(defined3)}` })
      return { gate: "G15", checks, blocked: null }
    }
    const failedUpdate = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v3.packageId, mode: "update" }, agentA)
    const afterFailureTools = toolNames()
    const rowAfterFailure = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "failed_update_revokes_old_run",
      ok: failedUpdate.isError
        && failedUpdate.error.message.includes("G15 故意失败版本")
        && rowAfterFailure?.current === v1.packageId
        && rowAfterFailure?.active === null
        && !afterFailureTools.includes(DYNAMIC_TOOL),
      detail: `cordis_run(mode=update, packageId=${v3.packageId}) → ${readResult(failedUpdate)}；失败后 current 仍=${rowAfterFailure?.current}，但 active=${rowAfterFailure?.active}（旧实例已被撤销）；工具数 ${afterRunTools.length}→${afterFailureTools.length}（含 ${DYNAMIC_TOOL}=${afterFailureTools.includes(DYNAMIC_TOOL)}）`,
    })

    const restarted = await invoke("cordis_run", { pluginId: v1.pluginId, packageId: v1.packageId, mode: "run" }, agentA)
    const callRestart = await invoke(DYNAMIC_TOOL, { candidates: CANDIDATES }, agentA)
    const rowAfterRestart = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "explicit_restart_restores_last_usable_version",
      ok: !restarted.isError
        && rowAfterRestart?.active === v1.packageId
        && rowAfterRestart?.fiberState === FIBER_STATE_ACTIVE
        && JSON.stringify(readToolValue(callRestart).widths) === JSON.stringify([0.048, 0.068]),
      detail: `失败后显式 cordis_run(mode=run, packageId=${v1.packageId}) → ${readResult(restarted).slice(0, 220)}；真实调用恢复=${readResult(callRestart)}；snapshot=${JSON.stringify(rowsOf(agentA))}`,
    })

    // ── 停止与永久移除：Tool 消失，定义保留/删除的差别 ──
    const stopped = await invoke("cordis_stop", { pluginId: v1.pluginId }, agentA)
    const afterStopTools = toolNames()
    const rowAfterStop = rowOf(agentA, v1.pluginId)
    checks.push({
      name: "stop_removes_tool_keeps_definition",
      ok: !stopped.isError
        && !afterStopTools.includes(DYNAMIC_TOOL)
        && rowAfterStop?.active === null
        && rowAfterStop?.current === v1.packageId
        && rowAfterStop?.packages === 3,
      detail: `cordis_stop → ${readResult(stopped).slice(0, 120)}；工具数 ${afterRunTools.length}→${afterStopTools.length}（含 ${DYNAMIC_TOOL}=${afterStopTools.includes(DYNAMIC_TOOL)}）；snapshot=${JSON.stringify(rowsOf(agentA))}（定义与版本指针保留，可再 run/update）`,
    })

    const undefined1 = await invoke("cordis_undefine", { pluginId: v1.pluginId }, agentA)
    const inventoryAfter = ctx.dynamicCordisRunner.snapshot(agentA)
    const selfAfterUndefine = await invoke("cordis_inspect_self", { pluginId: v1.pluginId }, agentA)
    checks.push({
      name: "undefine_removes_plugin",
      ok: !undefined1.isError && inventoryAfter.length === 0 && !toolNames().includes(DYNAMIC_TOOL) && selfAfterUndefine.isError,
      detail: `cordis_undefine → ${readResult(undefined1).slice(0, 120)}；inventory=${JSON.stringify(inventoryAfter)}；工具含 ${DYNAMIC_TOOL}=${toolNames().includes(DYNAMIC_TOOL)}；再查该 pluginId → ${readResult(selfAfterUndefine)}`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    try { await ctx.fiber.dispose() } catch { /* 真实树销毁失败不影响已记录的读数 */ }
  }

  // ── 本机无法验证的部分：诚实报 BLOCKED，不伪造模型调用 ──
  const sessionSecrets = join(PRODUCT_ROOT, ".runtime/session-secrets/deepseek-auth.json")
  const developerAccount = join(process.env.HOME ?? "", ".config/lyapunov/developer-account.json")
  const missing = [
    process.env.DEEPSEEK_API_KEY ? undefined : "DEEPSEEK_API_KEY 未设置",
    existsSync(sessionSecrets) ? undefined : `${sessionSecrets} 不存在`,
    existsSync(developerAccount)
      ? `${developerAccount} 只有本地 scrypt 摘要（username/salt/digest/createdAt），不含模型 Key`
      : `${developerAccount} 不存在`,
  ].filter((item): item is string => item !== undefined)

  return {
    gate: "G15",
    checks,
    blocked: [
      "本门覆盖的是**插件机制**（真实 Cordis 装配、真实 `cordis_*` 工具、真实动态 Tool 注册/调用/版本切换/回滚/清理）；上面通过的 check 只证明这一层。",
      "「真由内部 Agent（自然语言）完成」这一层**已由 `--gate G15LIVE` 单独验证（3/3 PASS）**：本地真实模型回合驱动 DSH，会话内真实调用 `cordis_inspect_list`，模型复述出工具真实返回的 provider id。该门用的是**本地开源 27B 模型（qwen3.8-uncensored:32k），不是 DeepSeek 官方模型**——它验证产品链路，不声称官方模型行为。",
      "运行环境读数（说明本门自身为何仍不记 PASS）：" + missing.join("；") + "。",
      "仍未覆盖：§2.13 第 5 条（持久修改进入真实插件源码包 → 构建/测试 → dsh plugin/Profile 安装 → **重启后仍注册可调用**）；三种用户句子（切换现有抓取方法 / 修改抓取过滤并启用 / 回滚刚才修改）由 Agent 用自然语言连贯驱动；以及契约里「持久包重启仍注册」与「无关 Scene 可用」。",
      "另需完整产品 Host 装配才能验证的部分：真实 Developer Profile 启动后的会话作用域与工具可见性（本脚本读取产品装配函数的真实返回值并自建等价真实 Cordis 树，未启动产品 Web Host）。",
    ].join(" "),
  }
}
