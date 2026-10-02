/**
 * Blender 可执行文件解析的回归测试（ENV 链路阻断点 A；回执 `bugfixHistory/ENV04-06-BLOCKERS-20260922.md`）。
 *
 * 真实事实（2026-09-22 本机）：
 *   `command -v blender` → `/snap/bin/blender`（符号链接 → `/usr/bin/snap`，snap 启动器）；
 *   直接跑它退出码 **46**：`cannot create transient scope: DBus error ...`；
 *   `/snap/blender/current/blender --version` → `Blender 5.2.2 LTS`（退出 0）。
 *
 * 这里钉住解析口径（`script/runtime-patch.ts` 的 `resolveBlenderExecutable`）：
 *  · 显式 `BLENDER_EXECUTABLE` 永远原样使用——不探测、不替换（跑不起来由插件按真实报错明确失败）；
 *  · 只有"PATH 上第一个 `blender` 确实是 snap 启动器、且同一份安装的载荷二进制在场"才改用载荷；
 *  · 其余情况保持 `blender` 不变：不猜路径、不改非 snap 安装的行为、不在载荷缺失时静默换成别的可用路径。
 * 文件系统探测用注入的 `probe`（默认读真实文件系统），因此每个分支都可确定性复算。
 */
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"

import { resolveBlenderExecutable, runtimePluginInsert } from "./runtime-patch.ts"

const PAYLOAD = "/snap/blender/current/blender"

test("显式 BLENDER_EXECUTABLE 原样使用：不探测、不替换", () => {
  const probed: string[] = []
  const value = resolveBlenderExecutable(
    { BLENDER_EXECUTABLE: "/opt/custom/blender", PATH: "/snap/bin" },
    { exists: path => { probed.push(path); return true }, isSnapLauncher: () => true },
  )
  expect(value).toBe("/opt/custom/blender")
  expect(probed).toEqual([]) // 显式值连探测都不做
})

test("PATH 上没有 blender：保持 'blender'（不猜一个绝对路径）", () => {
  expect(resolveBlenderExecutable({ PATH: "/nonexistent-a:/nonexistent-b" }, { exists: () => false })).toBe("blender")
  expect(resolveBlenderExecutable({}, { exists: () => false })).toBe("blender") // PATH 缺失同理
})

test("PATH 上是普通（非 snap）blender：行为不变", () => {
  const value = resolveBlenderExecutable(
    { PATH: "/usr/local/bin:/usr/bin" },
    { exists: path => path === "/usr/local/bin/blender", isSnapLauncher: () => false },
  )
  expect(value).toBe("blender")
})

test("PATH 上第一个是 snap 启动器且载荷在场：改用载荷二进制", () => {
  const value = resolveBlenderExecutable(
    { PATH: "/snap/bin:/usr/bin" },
    { exists: path => path === "/snap/bin/blender" || path === PAYLOAD, isSnapLauncher: path => path === "/snap/bin/blender" },
  )
  expect(value).toBe(PAYLOAD)
})

test("PATH 上是 snap 启动器但载荷不在：回退 'blender'（由插件按真实报错失败，不静默换路径）", () => {
  const value = resolveBlenderExecutable(
    { PATH: "/snap/bin" },
    { exists: path => path === "/snap/bin/blender", isSnapLauncher: () => true },
  )
  expect(value).toBe("blender")
})

test("装配表把解析结果交给 blender 插件（产品路径真的用上）", () => {
  const rows = runtimePluginInsert({ mode: "developer", surface: "web", sceneRoot: "/tmp/envfix-blockers-never-written", engine: "none" })
  const blender = rows.find(row => row.id === "lyapunov-blender")
  expect(blender).toBeDefined()
  expect(blender?.config?.executable).toBe(resolveBlenderExecutable())
})

test("本机真实事实：snap 机器上显式可见启动器时解析到载荷二进制（非 snap 机器无此断言）", () => {
  const launcher = process.env.PATH?.split(":").map(dir => `${dir}/blender`).find(path => path === "/snap/bin/blender")
  if (!launcher || !existsSync(PAYLOAD)) return // 当前测试进程未暴露 snap 启动器：不臆测宿主 PATH
  expect(resolveBlenderExecutable({ PATH: process.env.PATH })).toBe(PAYLOAD)
})
