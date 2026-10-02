/**
 * G13 驱动（薄 CLI，合同 §6.4 退出码语义）：
 *   0 全部通过 / 1 实际失败 / 2 必需依赖未完成（BLOCKED）
 *
 * 只调 `g13.ts` 里已经接线的产品实现与真实读数，不做测试框架/编排。
 *
 * ## 为什么在 node 下跑（与 `script/gates/run-g10b.mts` 同因）
 * `packages/generate-hunyuan/src/provider.ts` 的依赖链会拉进 `dsh-subprocess-local`，该包静态
 * `import { getSystemErrorMessage } from 'node:util'`，而 bun 1.3.13 的 `node:util` 没有这个导出
 * （bun 在解析模块图阶段就求值静态 import）。产品真实路径本身用 node 启动 DSH 主机
 * （`script/launch.ts` 里的 `spawn("node", …)`），所以按产品同一运行器执行。
 *
 * 用法：`node script/gates/run-g13.ts`（若用 bun 启动，本脚本会自动改用 node 重新进入）。
 *
 * ## 两处运行器适配（都不改产品源码）
 * 1. **无扩展名相对 import**：本仓是 Bun 工作区，`provider.ts` → `./url-safety` 这类写法 Node 的 ESM
 *    解析会 ERR_MODULE_NOT_FOUND（这些文件不在本任务允许改动的范围内）。这里注册一个
 *    "无扩展名相对 import → 同目录同名 .ts" 的解析兜底，不改写源码、不改变模块语义。
 *    Bun 下没有 `module.registerHooks`，相应的兜底也不需要（bun 自己解析无扩展名）。
 * 2. **构造函数参数属性**：Node 的 strip-only 模式不支持（`recording.ts` 用了参数属性），需要
 *    `--experimental-transform-types`；本脚本按需带该 flag 重新进入一次（幂等、不递归）。
 */
import { spawnSync } from "node:child_process"

/** 只取本脚本需要的那一个能力：bun 的 node:module 没有它，类型也不同，所以按最小结构判断。 */
interface HookRegistrar { registerHooks?: (hooks: unknown) => void }

async function moduleHooks(): Promise<HookRegistrar | undefined> {
  try { return await import("node:module") as HookRegistrar } catch { return undefined }
}

const moduleApi = await moduleHooks()
const registerHooks = moduleApi?.registerHooks

// bun 没有 registerHooks：改成 node 重新进入（幂等，由 G13_RUNNER 防止递归）。
if (typeof registerHooks !== "function" && process.env.G13_RUNNER !== "node") {
  console.error("G13: 当前运行器缺少 module.registerHooks（bun），改用 node 重新进入。")
  const child = spawnSync("node", ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, G13_RUNNER: "node" },
  })
  if (child.error) { console.error("G13: 改用 node 失败: " + String(child.error)); process.exit(2) }
  process.exit(child.status ?? 1)
}

// Node 的 strip-only 模式不支持构造函数参数属性（recording.ts 用了），需要 --experimental-transform-types。
// 判定只看自己的私有标记（不看 G13_RUNNER：bun 分支设过它，否则这里会被误跳过，实测会 ERR_MODULE_NOT_FOUND）。
if (process.env.G13_TRANSFORM_TYPES !== "1") {
  const child = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, G13_TRANSFORM_TYPES: "1" },
  })
  if (child.error) {
    console.error("G13: 无法用 node 重新进入: " + String(child.error))
    process.exit(2)
  }
  process.exit(child.status ?? 1)
}

if (typeof registerHooks === "function") {
  const { existsSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  registerHooks({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) {
      if (specifier.startsWith(".") && context.parentURL !== undefined && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        for (const candidate of [specifier + ".ts", specifier + "/index.ts"]) {
          if (existsSync(fileURLToPath(new URL(candidate, context.parentURL)))) return nextResolve(candidate, context)
        }
      }
      return nextResolve(specifier, context)
    },
  })
}

/** 显式总超时：任何真实等待（网络/文件/子进程）都不允许把门挂死；超时按"实际失败"退出 1。 */
const TIMEOUT_MS = Number(process.env.G13_TIMEOUT_MS ?? 240000)
const timeout = new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`G13_TIMEOUT: 门在 ${TIMEOUT_MS}ms 内未完成`)), TIMEOUT_MS)
  timer.unref?.()
})
/**
 * 兜底：面板/CI 绝不能拿到"没有结论的退出码"。若事件循环意外排空而门还没给出结果
 * （本轮联调中遇到过一次静默退出 13），显式报 FAIL 并以 1（实际失败）退出。
 */
let completed = false
process.on("beforeExit", () => { if (!completed) { console.log("FAIL  G13/门执行  Error: GATE_EXITED_WITHOUT_RESULT（事件循环排空但门未给出结论）"); process.exit(1) } })
try {
  const { gateG13 } = await import("./g13.ts")
  const result = await Promise.race([gateG13(), timeout])
  completed = true
  for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${result.gate}/${check.name}  ${check.detail}`)
  const failed = result.checks.filter(check => !check.ok)
  // 退出码优先级：真实失败(1) 高于 BLOCKED/未覆盖(2)。此前 blocked 判在失败之前，
  // 会让 1 条真实 FAIL 退成 2（§6.4 要求区分"实测失败"与"缺依赖"）。
  if (failed.length) { console.log(`${result.gate}: ${result.checks.length - failed.length}/${result.checks.length} 通过，${failed.length} 失败`); process.exit(1) }
  if (result.blocked) { console.log(`BLOCKED  ${result.gate}  ${result.blocked}`); process.exit(2) }
  if (!result.checks.length) { console.log(`BLOCKED  ${result.gate}  没有已接线的真实入口`); process.exit(2) }
  console.log(`${result.gate}: ${result.checks.length}/${result.checks.length} 通过`)
  process.exit(0)
} catch (error) {
  completed = true
  console.log(`FAIL  G13/门执行  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  process.exit(1)
}
