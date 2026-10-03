/**
 * G17 子探针：**发行启动链是否还依赖旧 owner**（合同 §4.7 条件④）。
 *
 * 为什么单独一个探针：G17 主门跑在 node 下（含 Electron/打包读数组件），而 `runtimePatch()`
 * 属于产品启动装配、只能在 bun 下 import 产品源码。两者运行器不同，硬塞在一起会让主门跑不起来。
 *
 * 做法：真实调用产品的 `runtimePatch()` 生成运行补丁文件，然后**只读**扫描该产物，
 * 统计其中出现的旧 owner 名。产出的补丁是启动装配的真实结果，不是源码 grep。
 *
 * 输出一行 JSON：`{"plugins":n,"legacyHits":[...],"patchBytes":n}`。失败时输出 `{"error":"…"}` 且退出 1。
 * 只写 `.runtime/goal-verify/g17-launch-chain/`，结束即删。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")

const LEGACY = /scenecore|scene-core|scene-bridge|SceneBridge|sceneBridge|ScenePage|scene-page|planning-service|robot-bridge|robotBridge|tool-forge|ToolForge|robot-loops|robotLoops|background-intent|backgroundIntent|opencode/i

try {
  const { runtimePatch } = await import("../../script/runtime-patch.ts")
  const dir = await mkdtemp(join(tmpdir(), "g17-launch-"))
  // 最小但真实的入参：开发者档 + mujoco 引擎（启动链上分支最多的组合）。
  const patchPath = await runtimePatch({
    dir,
    mode: "developer",
    surface: "web",
    sceneRoot: join(dir, "scenes"),
    engine: "mujoco",
    grasp: "analytic",
  })
  const text = await readFile(patchPath, "utf8")
  const legacyHits = [...new Set((text.match(new RegExp(LEGACY.source, "gi")) ?? []).map(hit => hit.toLowerCase()))]
  const plugins = (text.match(/"id":"lyapunov-/g) ?? []).length
  console.log(JSON.stringify({ plugins, legacyHits, patchBytes: text.length }))
  await rm(dir, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  console.log(JSON.stringify({ error: String((error as Error)?.message ?? error) }))
  process.exit(1)
}
