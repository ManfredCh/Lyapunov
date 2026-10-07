#!/usr/bin/env node
/**
 * 安装收尾：managed doctor 成功后，把**本次已验证**的产品托管 SDK 路径登记进 engine.json。
 *
 * 为什么需要它：`install-provider` 始终把新 SDK 装到**本版本前缀**
 * （`<root>/.runtime/...`），而升级到下一个版本后该前缀是空的。若不在安装成功时记住这条
 * 已验收路径，且用户又没有显式 ENV 覆盖，升级后的解析就只能落到新版本的空前缀，曾装好的
 * SDK 会被当成"没装过"。本helper 在 doctor 成功后写 `sdkPython[engine]`，后续版本即可沿
 * saved-preference 读回同一 SDK。
 *
 * 纪律（与 `sdk-python.mjs`、`engine.json` 合同一致）：
 *  · 只登记**本次 managed doctor 已通过**的包内路径；doctor 失败/partial 时 install-provider
 *    根本不会调用本文件，调用方也不会。
 *  · 已有显式 ENV 覆盖（`LYAPUNOV_MUJOCO_PYTHON` / `LYAPUNOV_ISAAC_PYTHON` /
 *    `LYAPUNOV_NEWTON_PYTHON`）或用户已保存的外置/旧 SDK 时，保留用户选择，一个字节都不写。
 *  · 只动 `sdkPython[engine]` 一个键；不改 `engine`/`licenses`，不复制/改写/替换任何 SDK 目录。
 *  · 登记失败由安装入口单独报告；已装环境与原配置保留，不能冒充完整登记成功。
 */
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {SDK_PYTHON_ENV,readSdkPythonPreference,resolveSdkPython,writeSdkPythonPreference} from '../../packages/lyapunov-product-bundle/src/sdk-python.mjs'

const root = resolve(import.meta.dirname, '../..')
const engine = process.argv[2]
if (engine !== 'isaac') process.exit(0)

const env = process.env
const override = env?.[SDK_PYTHON_ENV[engine]]?.trim()
if (override) {
  process.stdout.write(`已保留显式 ${SDK_PYTHON_ENV[engine]} 覆盖，未登记产品托管 SDK 路径。\n`)
  process.exit(0)
}
const saved = readSdkPythonPreference(engine, env)
if (saved) {
  process.stdout.write(`已有保存的 SDK 选择（${saved}），未覆盖；本次产品托管安装在 ${resolveSdkPython(root, engine, env, {managed: true}).python}。\n`)
  process.exit(0)
}

const managed = resolveSdkPython(root, engine, env, {managed: true}).python
if (!existsSync(managed)) {
  process.stderr.write(`产品托管 SDK 路径不存在，未登记：${managed}\n`)
  process.exit(1)
}
writeSdkPythonPreference(engine, managed, env)
process.stdout.write(`已登记产品托管 SDK 路径（后续版本可读回）：${managed}\n`)
