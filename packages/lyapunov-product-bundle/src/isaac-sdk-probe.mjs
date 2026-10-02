/** Isaac 本地 SDK 的轻量事实；只用标准库 find_spec/metadata，不 import Isaac/Kit、不接受许可。 */
import {execFile, execFileSync} from 'node:child_process'
import {accessSync, constants, statSync} from 'node:fs'
import {basename, isAbsolute, join, normalize, resolve} from 'node:path'

export const ISAAC_SDK_VERSION = '6.0.1.0'
const cache = new Map()
// 环境提示的纯函数也由浏览器引用；宿主默认路径只在 Node/Bun 文件模块中求值。
const SOURCE_ROOT = typeof window === 'undefined' && import.meta.url.startsWith('file:')
  ? resolve(decodeURIComponent(new URL('../../..', import.meta.url).pathname)) : ''

function probeArgs(python, options) {
  return [join(options.productRoot ?? SOURCE_ROOT, 'packages/sim-isaac/python/check.py'), '--discover', python]
}

export function clearIsaacSdkProbeCache() { cache.clear() }

/** 目录输入只解析已知入口；不经过 shell、不解析命令字符串，不追着 PATH 找其它解释器。 */
export function resolveIsaacLocalEntry(input) {
  if (typeof input !== 'string' || !input.trim() || !isAbsolute(input.trim()) || input.includes('\0')) return undefined
  const path = normalize(input.trim())
  try {
    if (statSync(path).isDirectory()) {
      return [join(path, 'python.sh'), join(path, 'bin/python'), join(path, 'bin/python3')].find(file => validExecutable(file))
    }
  } catch { return undefined }
  return validExecutable(path) ? path : undefined
}

function validExecutable(path) {
  if (!/^(?:python(?:3(?:\.\d+)?)?|python\.sh)$/.test(basename(path))) return false
  try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
}

function probeEnv(env) {
  // 解释器探测不继承模型密钥、用户注入的 PYTHONPATH 或许可接受变量。
  const kept = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'SystemRoot', 'WINDIR'].filter(key => env[key] !== undefined).map(key => [key, env[key]]))
  return {...kept, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', HF_ENDPOINT: 'https://hf-mirror.com'}
}

function failure(python, state, detail) {
  return {python, kind: basename(python) === 'python.sh' ? 'standalone' : 'python', state, moduleFound: false, sdkVersion: null, pythonVersion: null, sdkRoot: null, compatible: false, detail}
}

function finishProbe(python, output) {
  try {
    // python.sh 可打印启动信息；只接收最后一行 JSON 的已登记字段，不回传原始输出。
    const value = JSON.parse(String(output).trim().split('\n').pop() || '')
    if (typeof value.moduleFound !== 'boolean' || !/^\d+\.\d+\.\d+$/.test(value.pythonVersion ?? '')) throw new Error('INVALID_PROBE')
    const sdkRoot = typeof value.sdkRoot === 'string' && value.sdkRoot.length < 4096 && isAbsolute(value.sdkRoot) ? value.sdkRoot : null
    const sdkVersion = typeof value.sdkVersion === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.sdkVersion) ? value.sdkVersion : null
    const compatibleVersion = sdkVersion === ISAAC_SDK_VERSION || sdkVersion === '6.0.1'
    const compatiblePython = /^3\.12\./.test(value.pythonVersion)
    const compatible = value.moduleFound && sdkRoot !== null && compatibleVersion && compatiblePython
    const state = !value.moduleFound ? 'missing' : compatible ? 'candidate' : 'incompatible'
    const detail = !value.moduleFound ? '当前解释器未发现 isaacsim。'
      : !compatibleVersion || sdkRoot === null ? `发现 isaacsim，但版本 ${sdkVersion ?? '未读到'} 或 SDK 安装布局与本版要求的 6.0.1 不匹配。`
      : !compatiblePython ? `Isaac Sim 6.0.1 需要 Python 3.12，当前为 ${value.pythonVersion}。`
      : `发现兼容的 Isaac Sim ${sdkVersion} / Python ${value.pythonVersion}；物理世界、许可与 RTX 仍按实际运行检查。`
    return {python, kind: basename(python) === 'python.sh' ? 'standalone' : 'python', state, moduleFound: value.moduleFound, sdkVersion, pythonVersion: value.pythonVersion, sdkRoot, compatible, detail}
  } catch { return failure(python, 'unavailable', '解释器未返回有效的 SDK 发现结果。') }
}

function fromError(python, error) {
  const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true
  return failure(python, timedOut ? 'timeout' : 'unavailable', timedOut ? 'SDK 发现检查超时，未启动物理引擎。' : `无法运行所选解释器（${error?.code ?? error?.signal ?? '进程失败'}）。`)
}

function cached(python, options) {
  const previous = cache.get(python)
  return options.fresh !== true && previous && Date.now() - previous.at < 30_000 ? previous.value : undefined
}
function remember(python, value) { cache.set(python, {at: Date.now(), value}); return value }

/** Host 的已保存选择检查；不扫描目录，结果只缓存三十秒。 */
export function inspectIsaacPythonSync(input, options = {}) {
  const python = resolveIsaacLocalEntry(input)
  if (!python) return failure(typeof input === 'string' ? input : '', 'missing', '路径无效：请选择已有的 Python、python.sh 或安装目录。')
  const hit = cached(python, options)
  if (hit) return hit
  try {
    return remember(python, finishProbe(python, execFileSync(python, probeArgs(python, options), {encoding: 'utf8', env: probeEnv(options.env ?? process.env), timeout: options.timeoutMs ?? 5000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe']})))
  } catch (error) { return remember(python, fromError(python, error)) }
}

/** 设置按钮使用异步、有时限的检查，不阻塞 Host 的事件循环。 */
export async function inspectIsaacPython(input, options = {}) {
  const python = resolveIsaacLocalEntry(input)
  if (!python) return failure(typeof input === 'string' ? input : '', 'missing', '路径无效：请选择已有的 Python、python.sh 或安装目录。')
  const hit = cached(python, options)
  if (hit) return hit
  return await new Promise(resolve => {
    execFile(python, probeArgs(python, options), {encoding: 'utf8', env: probeEnv(options.env ?? process.env), timeout: options.timeoutMs ?? 2500, killSignal: 'SIGKILL', maxBuffer: 65536}, (error, stdout) => resolve(remember(python, error ? fromError(python, error) : finishProbe(python, stdout))))
  })
}
