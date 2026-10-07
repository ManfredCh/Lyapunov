/**
 * SDK 解释器解析契约（唯一实现）。
 *
 * 解析规则按顺序：
 *   1. 显式覆盖：LYAPUNOV_MUJOCO_PYTHON / LYAPUNOV_ISAAC_PYTHON / LYAPUNOV_NEWTON_PYTHON 非空时，直接作为解释器路径，
 *      用于复用本机已装好的 SDK 环境（不复制、不安装、不改系统 Python）；
 *   2. 用户保存的本地安装：同一份 engine.json 的 sdkPython 键，由物理引擎设置显式写入；
 *   3. 包内默认：<PRODUCT_ROOT>/.runtime/... 的独立安装落点，由 ./lyapunov install-provider 建立。
 *
 * 不自动搜索目录、不读取 PATH/注册表、不为新增键提供 LYAUP_* 旧名兼容。
 * doctor、Host runtime-patch 装配与 physics-check 都从这里取同一结果，避免
 * “doctor 报 AVAILABLE、运行侧却 BLOCKED”。
 */
import {mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {dirname,isAbsolute,join,resolve} from 'node:path'

/** 各引擎解释器的正式覆盖变量（同时登记进 runtime-paths.ts 的 RUNTIME_ENV）。 */
export const SDK_PYTHON_ENV = {
  mujoco: 'LYAPUNOV_MUJOCO_PYTHON',
  isaac: 'LYAPUNOV_ISAAC_PYTHON',
  newton: 'LYAPUNOV_NEWTON_PYTHON',
}

/** 与 install-provider 一致的包内独立安装落点（相对 PRODUCT_ROOT）。 */
export const SDK_PYTHON_PACKAGE_PATH = {
  mujoco: '.runtime/sim-python/bin/python',
  isaac: '.runtime/conda/envs/isaac/bin/python',
  // Newton 必须独立环境：它自带 mujoco~=3.12.0 / mujoco-warp~=3.12.0 的 pin，与产品 mujoco 3.13.0 冲突。
  newton: '.runtime/newton-env/bin/python',
}

/** 仍是 engine-preference 的同一份配置；路径计算在此共享，避免 Node doctor 与 Host 读成两份。 */
export function sdkPreferenceFile(env = process.env) {
  const configured = env.LYAPUNOV_ENGINE_PREFERENCE_FILE?.trim()
  return resolve((configured || '~/.config/lyapunov/engine.json').replace(/^~(?=\/|$)/, homedir()))
}

/** 只读取用户显式保存的绝对路径；失效路径仍作为选择返回，由检查报告错误，不静默换环境。 */
export function readSdkPythonPreference(engine, env = process.env) {
  if (!SDK_PYTHON_PACKAGE_PATH[engine]) throw new Error(`未知 SDK 引擎：${String(engine)}`)
  try {
    const parsed = JSON.parse(readFileSync(sdkPreferenceFile(env), 'utf8'))
    const value = parsed?.sdkPython?.[engine]
    return typeof value === 'string' && isAbsolute(value.trim()) ? value.trim() : undefined
  } catch { return undefined }
}

/**
 * 写入用户显式保存的 SDK 解释器路径，落**同一份** engine.json（`sdkPreferenceFile`）。
 *
 * 只动 `sdkPython[engine]` 一个键：`engine`、`licenses` 等其它字段与写入前完全一致
 * （最终以 `{...existing, sdkPython, updatedAt}` 落盘）。`python === null` 表示清除该引擎的保存选择。
 *
 * 为什么读写放在同一文件：设置页保存（`script/engine-preference.ts` 转调本函数）与安装收尾
 * （`distribution/linux/register-managed-sdk.mjs`）必须共用一份读写口径，否则"保存的路径"与
 * "能不能读回"会漂移成两套。这里**不复制、不改写、不替换任何 SDK 目录**，只登记一个绝对路径。
 */
export function writeSdkPythonPreference(engine, python, env = process.env) {
  if (!SDK_PYTHON_PACKAGE_PATH[engine]) throw new Error("SDK_ENGINE_INVALID")
  if (python !== null && (typeof python !== "string" || !python.trim() || !isAbsolute(python.trim()))) {
    throw new Error("SDK_PYTHON_PATH_INVALID: 需要绝对路径")
  }
  const file = sdkPreferenceFile(env)
  let existing = {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed
  } catch (error) {
    // 安装收尾也调用此写入口：损坏/不可读的配置必须保留，不能把它当作首次安装覆盖。
    if (error?.code !== 'ENOENT') throw new Error('SDK_PREFERENCE_UNREADABLE: Existing SDK settings could not be read and were preserved.', {cause: error})
  }
  const previous = existing.sdkPython && typeof existing.sdkPython === "object" && !Array.isArray(existing.sdkPython) ? existing.sdkPython : {}
  const sdkPython = {...previous}
  if (python === null) delete sdkPython[engine]
  else sdkPython[engine] = python.trim()
  mkdirSync(dirname(file), {recursive: true})
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({...existing, sdkPython, updatedAt: new Date().toISOString()}, null, 2) + "\n", {mode: 0o600, flag: 'wx'})
    renameSync(temporary, file)
  } finally { rmSync(temporary, {force: true}) }
  return file
}

/**
 * 解析某个 SDK 引擎应当使用的 Python 解释器。
 * @param {string} root 产品根（打包后即包根，对应 LYAPUNOV_PRODUCT_ROOT）
 * @param {'mujoco'|'isaac'|'newton'} engine
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{managed?:boolean}} [options] 安装器收尾验收只认包内落点，不借外部 SDK。
 * @returns {{python:string,source:'env-override'|'saved-preference'|'package-default'}}
 */
export function resolveSdkPython(root, engine, env = process.env, options = {}) {
  const relative = SDK_PYTHON_PACKAGE_PATH[engine]
  if (!relative) throw new Error(`未知 SDK 引擎：${String(engine)}`)
  if (!options.managed) {
    const override = env?.[SDK_PYTHON_ENV[engine]]?.trim()
    if (override) return {python: override, source: 'env-override'}
    const saved = readSdkPythonPreference(engine, env)
    if (saved) return {python: saved, source: 'saved-preference'}
  }
  return {python: join(root, relative), source: 'package-default'}
}
