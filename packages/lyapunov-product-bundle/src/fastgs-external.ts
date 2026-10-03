/**
 * 官方 FastGS（`fastgs/FastGS`）**外部可选工具**桥接。
 *
 * 用户决定：FastGS 不再作为随包算法插件/点击分割协议，而改为像 Isaac 一样**按需下载**的外部工具；
 * 算法源码、CUDA 环境、权重、数据、构建产物都**不进 Git/发行包**，只落在产品根下的本地运行目录
 * （默认 `<产品根>/.runtime/fastgs-external`，可用 `LYAPUNOV_FASTGS_HOME` 指向其它目录；`.runtime/**`
 * 已被发行脚本显式拒绝进包）。本模块只保留客户端必要的**来源元数据 + 下载/安装/检查/训练转发**。
 *
 * 边界（不要越界）：
 *  · 不实现任何 3DGS 训练算法；`fastgsTrain` 只把用户**显式**给的 `dataset`/`output`
 *    原样转发给官方 `train.py -s <dataset> -m <output>`，绝不在下载后自动训练。
 *  · 不自动下载权重/数据集；HF 相关环境一律只指向 `https://hf-mirror.com`。
 *  · 「下载完成」「SDK 导入成功」「GPU 训练成功」是三种不同的结论，`fastgsStatus` 分别如实报告。
 *  · 安装器不修改系统 Python；遇到不是本工具的未知已有目录时**失败关闭**，绝不先删或替换。
 *  · 下载/安装的每一步（git init/fetch/checkout、micromamba create）都传播真实非 0：不把失败吞成
 *    resolve、也不让后置残留的 torch 把失败掩盖成 OK。
 */
import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync,readdirSync,realpathSync} from 'node:fs'
import {mkdir,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {FASTGS_REPOSITORY,FASTGS_PROJECT,FASTGS_COMMIT,FASTGS_TRAIN_ENTRY,FASTGS_ENVIRONMENT_FILE,FASTGS_HF_MIRROR} from './fastgs-metadata.ts'
export {FASTGS_REPOSITORY,FASTGS_PROJECT,FASTGS_COMMIT,FASTGS_TRAIN_ENTRY,FASTGS_ENVIRONMENT_FILE,FASTGS_HF_MIRROR} from './fastgs-metadata.ts'
/** 固定 commit 的 tree 没有 `.gitmodules`：三个 CUDA 扩展是仓内目录，不是 submodule。 */
export const FASTGS_SUBMODULE_DIRS = [
  'submodules/diff-gaussian-rasterization_fastgs',
  'submodules/simple-knn',
  'submodules/fused-ssim',
] as const

/**
 * 官方源码在**运行期真正 import** 的三个必需 CUDA 扩展（按固定 commit 的 import 语句，不是目录名猜测）：
 *   · `gaussian_renderer/__init__.py`：`from diff_gaussian_rasterization_fastgs import GaussianRasterizationSettings, GaussianRasterizer`
 *   · `scene/gaussian_model.py`：`from simple_knn._C import distCUDA2`
 *   · `train.py`：`from fused_ssim import fused_ssim`
 * `diff_gaussian_rasterization`（无 `_fastgs`）只是 `gaussian_model.py` 里 `try/except` 的可选导入，不算必需项。
 */
export const FASTGS_REQUIRED_EXTENSIONS = [
  {module: 'diff_gaussian_rasterization_fastgs', attribute: 'GaussianRasterizer', importedBy: 'gaussian_renderer/__init__.py'},
  {module: 'simple_knn._C', attribute: 'distCUDA2', importedBy: 'scene/gaussian_model.py'},
  {module: 'fused_ssim', attribute: 'fused_ssim', importedBy: 'train.py'},
] as const

export interface FastGSConfig {
  /** 产品根（缺省读 `LYAPUNOV_PRODUCT_ROOT`，再缺省 `process.cwd()`），用于解析本地运行目录与解释器。 */
  productRoot?: string
  /** 本地工具根覆盖；缺省读 `LYAPUNOV_FASTGS_HOME`，再缺省 `<productRoot>/.runtime/fastgs-external`。 */
  home?: string
  /** 显式复用已有隔离解释器（`LYAPUNOV_FASTGS_PYTHON`）；给了就不建 Conda 环境，也不改它。 */
  python?: string
  /** micromamba 可执行文件覆盖。 */
  micromamba?: string
  /** 权重/数据目录（本模块从不写入，只如实报告配置值）。 */
  dataDirectory?: string
  env?: NodeJS.ProcessEnv
}

export interface FastGSHooks {
  signal?: AbortSignal
  log?: (line: string) => void
}

export interface FastGSSourceState {
  downloaded: boolean
  head: string | null
  pinned: boolean
  trainEntry: boolean
  environmentFile: boolean
  submodules: Array<{name: string; present: boolean}>
}

export interface FastGSExtensionState {module: string; present: boolean; error: string | null}

export interface FastGSEnvironmentState {
  mode: 'isolated' | 'provided' | 'missing'
  python: string | null
  exists: boolean
  torch: string | null
  cuda: boolean | null
  /** 官方三个必需 CUDA 扩展逐个的 import 结果（缺哪个报哪个）。 */
  extensions: FastGSExtensionState[]
  detail: string
}

export interface FastGSStatus {
  repository: string
  project: string
  commit: string
  home: string
  sourceDir: string
  environmentDir: string
  logDir: string
  source: FastGSSourceState
  environment: FastGSEnvironmentState
  weights: {dataDirectory: string | null; autoDownloaded: false}
  ready: {source: boolean; environment: boolean; trainable: boolean}
  notes: string[]
}

export interface FastGSReceipt {
  status: 'OK' | 'BLOCKED' | 'FAILED'
  action: 'download' | 'install' | 'train'
  detail: string
  [key: string]: unknown
}

const GIT_TIMEOUT_MS = 30 * 60 * 1000
const PYTHON_TIMEOUT_MS = 60 * 1000

function envOf(config: FastGSConfig): NodeJS.ProcessEnv {
  return config.env ?? process.env
}

/** CLI 与设置界面同源的产品根：wrapper 通常已设 `LYAPUNOV_PRODUCT_ROOT`；否则从本模块位置回推（不依赖 cwd）。 */
export function fastgsProductRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LYAPUNOV_PRODUCT_ROOT?.trim()
  if (configured) return resolve(configured)
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)))
}

/** 本地工具根：显式 > 环境变量 > `<产品根>/.runtime/fastgs-external`。**默认不落任何跟踪代码目录**。 */
export function fastgsHome(config: FastGSConfig = {}): string {
  const env = envOf(config)
  const explicit = (config.home ?? env.LYAPUNOV_FASTGS_HOME ?? '').trim()
  if (explicit.length > 0) return resolve(explicit)
  const productRoot = (config.productRoot ?? env.LYAPUNOV_PRODUCT_ROOT ?? '').trim() || process.cwd()
  return resolve(join(productRoot, '.runtime', 'fastgs-external'))
}

export function fastgsPaths(config: FastGSConfig = {}) {
  const home = fastgsHome(config)
  return {home, sourceDir: join(home, 'FastGS'), environmentDir: join(home, 'env'), logDir: join(home, 'logs')}
}

function displayArgv(argv: readonly string[]): string {
  return argv.map(token => (/[\s"'\\$`]/.test(token) ? JSON.stringify(token) : token)).join(' ')
}

interface RunResult {code: number | null; stdout: string; stderr: string}

/** 取消/超时都按**本任务进程组**结束子树（POSIX 独立进程组；与 script/host.ts 同一纪律），不波及其它进程。 */
function terminateTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // 取消路径不因目标已退出而中断：ESRCH 等一律吞掉。
  }
}

async function run(argv: readonly string[], options: {cwd?: string; env?: NodeJS.ProcessEnv; hooks?: FastGSHooks; timeoutMs?: number} = {}): Promise<RunResult> {
  const hooks = options.hooks
  hooks?.log?.(`$ ${displayArgv(argv)}`)
  const signal = hooks?.signal
  // pre-aborted signal 不再 spawn：没有子进程可取消，直接以取消错误结束。
  if (signal?.aborted) throw new Error(`FASTGS_ABORTED: ${displayArgv(argv)}`)
  return await new Promise<RunResult>((settle, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下独立进程组：取消时整棵子树一起停，不牵连父进程组里的其它任务。
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let abortKill: NodeJS.Timeout | undefined
    const removeAbort = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      terminateTree(child, 'SIGTERM')
      abortKill = setTimeout(() => terminateTree(child, 'SIGKILL'), 5000)
      abortKill.unref?.()
    }
    const timer = setTimeout(() => {
      terminateTree(child, 'SIGKILL')
      if (!settled) { settled = true; removeAbort(); reject(new Error(`FASTGS_TIMEOUT: ${displayArgv(argv)}`)) }
    }, options.timeoutMs ?? GIT_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, {once: true})
    const finish = (action: () => void) => { clearTimeout(timer); if (abortKill) clearTimeout(abortKill); removeAbort(); if (!settled) { settled = true; action() } }
    child.stdout?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; hooks?.log?.(text) })
    child.stderr?.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderr += text; hooks?.log?.(text) })
    child.once('error', error => finish(() => reject(error)))
    child.once('close', code => finish(() => {
      if (signal?.aborted) { reject(new Error(`FASTGS_ABORTED: ${displayArgv(argv)}`)); return }
      settle({code, stdout, stderr})
    }))
  })
}

/** 真实的非 0 一律抛出：下载/安装的每一步都必须逐步传播，不能 resolve 后被 catch 漏掉。 */
async function runChecked(argv: readonly string[], options: {cwd?: string; env?: NodeJS.ProcessEnv; hooks?: FastGSHooks; timeoutMs?: number} = {}): Promise<RunResult> {
  const result = await run(argv, options)
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit=${String(result.code)}`).slice(-800)
    throw new Error(`FASTGS_COMMAND_FAILED: ${displayArgv(argv)} (exit=${String(result.code)}) ${detail}`)
  }
  return result
}

async function gitHead(sourceDir: string, hooks?: FastGSHooks): Promise<string | null> {
  try {
    const result = await run(['git', '-C', sourceDir, 'rev-parse', 'HEAD'], {hooks, timeoutMs: PYTHON_TIMEOUT_MS})
    return result.code === 0 ? result.stdout.trim() || null : null
  } catch { return null }
}

/** git remote 地址的等价比较：忽略结尾 `.git`、结尾斜杠与大小写。 */
function normalizeRepository(url: string): string {
  return url.trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
}

interface PythonProbe {torch: string | null; cuda: boolean | null; extensions: FastGSExtensionState[]; error: string | null}

const PYTHON_PROBE = [
  'import json',
  "report = {'torch': None, 'cuda': None, 'extensions': [], 'error': None}",
  'try:',
  '    import torch',
  "    report['torch'] = torch.__version__",
  "    report['cuda'] = bool(torch.cuda.is_available())",
  'except Exception as error:',
  "    report['error'] = type(error).__name__ + ': ' + str(error)",
  'for module, attribute in ' + JSON.stringify(FASTGS_REQUIRED_EXTENSIONS.map(({module, attribute}) => [module, attribute])) + ':',
  '    entry = {"module": module, "present": False, "error": None}',
  '    try:',
  '        imported = __import__(module, fromlist=[attribute])',
  '        getattr(imported, attribute)',
  '        entry["present"] = True',
  '    except Exception as error:',
  '        entry["error"] = type(error).__name__ + ": " + str(error)',
  '    report["extensions"].append(entry)',
  'print(json.dumps(report))',
].join('\n')

function missingExtensions(probe: PythonProbe): FastGSExtensionState[] {
  return probe.extensions.filter(entry => !entry.present)
}

function extensionSummary(probe: PythonProbe): string {
  const missing = missingExtensions(probe)
  return missing.length === 0 ? '三个 CUDA 扩展均可导入' : '缺少 CUDA 扩展：' + missing.map(entry => entry.module).join('、')
}

/** doctor 的判据：真的去跑一次解释器，逐个 import torch 与官方三个必需 CUDA 扩展（不是看目录）。 */
async function probePython(python: string, hooks?: FastGSHooks): Promise<PythonProbe> {
  const empty = () => FASTGS_REQUIRED_EXTENSIONS.map(({module}) => ({module, present: false, error: null}))
  try {
    const result = await run([python, '-c', PYTHON_PROBE], {hooks, timeoutMs: PYTHON_TIMEOUT_MS})
    if (result.code !== 0) return {torch: null, cuda: null, extensions: empty(), error: (result.stderr.trim() || `exit=${String(result.code)}`).slice(-400)}
    const line = result.stdout.trim().split('\n').filter(entry => entry.trim().length > 0).at(-1) ?? ''
    if (!line) return {torch: null, cuda: null, extensions: empty(), error: (result.stderr.trim() || `exit=${String(result.code)}`).slice(-400)}
    const parsed = JSON.parse(line) as {torch?: string | null; cuda?: boolean | null; extensions?: FastGSExtensionState[]; error?: string}
    const byModule = new Map((parsed.extensions ?? []).map(entry => [entry.module, entry] as const))
    return {
      torch: parsed.torch ?? null, cuda: parsed.cuda ?? null, error: parsed.error ?? null,
      extensions: FASTGS_REQUIRED_EXTENSIONS.map(({module}) => byModule.get(module) ?? {module, present: false, error: '探测未返回该扩展'}),
    }
  } catch (error) {
    return {torch: null, cuda: null, extensions: empty(), error: error instanceof Error ? error.message : String(error)}
  }
}

function providedPython(config: FastGSConfig): string {
  return (config.python ?? envOf(config).LYAPUNOV_FASTGS_PYTHON ?? '').trim()
}

/** 读取真实来源/环境/依赖状态；下载、SDK 导入、GPU 训练三种结论分开。 */
export async function fastgsStatus(config: FastGSConfig = {}, hooks: FastGSHooks = {}): Promise<FastGSStatus> {
  const {home, sourceDir, environmentDir, logDir} = fastgsPaths(config)
  const hasCheckout = existsSync(join(sourceDir, '.git'))
  const head = hasCheckout ? await gitHead(sourceDir, hooks) : null
  const trainEntry = existsSync(join(sourceDir, FASTGS_TRAIN_ENTRY))
  const environmentFile = existsSync(join(sourceDir, FASTGS_ENVIRONMENT_FILE))
  const submodules = FASTGS_SUBMODULE_DIRS.map(name => ({name, present: existsSync(join(sourceDir, name))}))
  const explicit = providedPython(config)
  const isolatedPython = join(environmentDir, 'bin', 'python')
  const python = explicit.length > 0 ? explicit : existsSync(isolatedPython) ? isolatedPython : null
  let environment: FastGSEnvironmentState
  if (!python) {
    environment = {mode: 'missing', python: null, exists: false, torch: null, cuda: null, extensions: [], detail: '未找到隔离环境解释器（先 install，或用 LYAPUNOV_FASTGS_PYTHON 显式提供）'}
  } else {
    const probe = await probePython(python, hooks)
    environment = {
      mode: explicit.length > 0 ? 'provided' : 'isolated', python, exists: true, torch: probe.torch, cuda: probe.cuda,
      extensions: probe.extensions,
      detail: probe.error ? `python 探测失败：${probe.error}` : probe.torch ? `torch ${probe.torch} · cuda=${String(probe.cuda)} · ${extensionSummary(probe)}` : '解释器在，但 import torch 失败',
    }
  }
  const dataDirectory = (config.dataDirectory ?? envOf(config).LYAPUNOV_FASTGS_DATA_DIR ?? '').trim() || null
  const sourceReady = hasCheckout && head === FASTGS_COMMIT && trainEntry && environmentFile && submodules.every(item => item.present)
  // 环境就绪 = torch 可导入且官方三个必需 CUDA 扩展逐个可导入；torch 存在不等于 SDK 完整。
  const environmentReady = environment.exists && environment.torch !== null && missingExtensions({torch: environment.torch, cuda: environment.cuda, extensions: environment.extensions, error: null}).length === 0
  // CUDA 不可用不得写 trainable：训练必须真的能在 GPU 上跑。
  const trainable = sourceReady && environmentReady && environment.cuda === true
  return {
    repository: FASTGS_REPOSITORY, project: FASTGS_PROJECT, commit: FASTGS_COMMIT,
    home, sourceDir, environmentDir, logDir,
    source: {downloaded: sourceReady, head, pinned: head === FASTGS_COMMIT, trainEntry, environmentFile, submodules},
    environment,
    weights: {dataDirectory, autoDownloaded: false},
    ready: {source: sourceReady, environment: environmentReady, trainable},
    notes: [
      '官方算法源码/CUDA 环境/权重/数据只落产品根下的本地运行目录（默认 `.runtime/fastgs-external`），不随本包或仓库分发。',
      '环境就绪要求解释器可 import torch 且官方三个必需 CUDA 扩展（diff_gaussian_rasterization_fastgs、simple_knn._C、fused_ssim）逐项可导入；CUDA 不可用不会标 trainable。',
      '下载完成、SDK 导入成功、GPU 训练成功是三种不同结论；本面板分别报告，不互相代替。',
      '模型与数据集不会自动下载；训练只能由用户显式给出 dataset 与 output 后转发官方 train.py。',
      `HF 访问一律走 ${FASTGS_HF_MIRROR}。`,
    ],
  }
}

/** `download`：真的获取官方源码并核实际 checkout/必需 entry。不会自动训练。 */
export async function fastgsDownload(config: FastGSConfig = {}, hooks: FastGSHooks = {}): Promise<FastGSReceipt> {
  const {home, sourceDir} = fastgsPaths(config)
  await mkdir(home, {recursive: true})
  const gitDir = join(sourceDir, '.git')
  if (existsSync(sourceDir) && !existsSync(gitDir)) {
    // 不删未知已有目录：只有空目录可被本工具接管。
    if (readdirSync(sourceDir).length > 0) throw new Error(`FASTGS_SOURCE_DIR_CONFLICT: ${sourceDir} 已存在且不是本工具的 Git 检出；为不删除现有文件已停止`)
    await rm(sourceDir, {recursive: true, force: true})
  }
  if (!existsSync(gitDir)) {
    await mkdir(sourceDir, {recursive: true})
    await runChecked(['git', 'init', sourceDir], {hooks})
    await runChecked(['git', '-C', sourceDir, 'remote', 'add', 'origin', FASTGS_REPOSITORY], {hooks})
  } else {
    // 已有 `.git` 不直接 set-url：先核实际 origin 是否就是固定官方仓库。未知项目明确冲突并原样保留，
    // 不改用户远端、不做 force checkout。
    const origin = await run(['git', '-C', sourceDir, 'remote', 'get-url', 'origin'], {hooks, timeoutMs: PYTHON_TIMEOUT_MS})
    const originUrl = origin.code === 0 ? origin.stdout.trim() : ''
    if (!originUrl || normalizeRepository(originUrl) !== normalizeRepository(FASTGS_REPOSITORY)) {
      throw new Error(`FASTGS_SOURCE_DIR_CONFLICT: ${sourceDir} 是已有 Git 检出，但 origin=${originUrl || '缺失'} 不是固定官方仓库 ${FASTGS_REPOSITORY}；已保留该目录，未改其远端、未切换 checkout`)
    }
  }
  let shallow = true
  const shallowFetch = await run(['git', '-C', sourceDir, 'fetch', '--depth', '1', 'origin', FASTGS_COMMIT], {hooks})
  if (shallowFetch.code !== 0) {
    // 只有真实非 0 才回落全量 fetch（不再被"run 对非 0 resolve"吞掉）。
    shallow = false
    await runChecked(['git', '-C', sourceDir, 'fetch', 'origin'], {hooks})
  }
  await runChecked(['git', '-C', sourceDir, 'checkout', '--detach', FASTGS_COMMIT], {hooks})
  const head = await gitHead(sourceDir, hooks)
  if (head !== FASTGS_COMMIT) throw new Error(`FASTGS_CHECKOUT_MISMATCH: 期望 ${FASTGS_COMMIT}，实际 ${head ?? 'unknown'}`)
  const trainEntry = existsSync(join(sourceDir, FASTGS_TRAIN_ENTRY))
  const environmentFile = existsSync(join(sourceDir, FASTGS_ENVIRONMENT_FILE))
  if (!trainEntry || !environmentFile) throw new Error(`FASTGS_ENTRY_MISSING: train.py=${trainEntry} environment.yml=${environmentFile}`)
  return {
    status: 'OK', action: 'download',
    detail: `已检出官方源码 ${FASTGS_REPOSITORY} @ ${FASTGS_COMMIT}（${shallow ? 'shallow' : 'full'} fetch）`,
    repository: FASTGS_REPOSITORY, commit: FASTGS_COMMIT, sourceDir, head, trainEntry, environmentFile,
    submodules: FASTGS_SUBMODULE_DIRS.map(name => ({name, present: existsSync(join(sourceDir, name))})),
  }
}

function resolveMicromamba(config: FastGSConfig): string {
  const env = envOf(config)
  const productRoot = (config.productRoot ?? env.LYAPUNOV_PRODUCT_ROOT ?? '').trim() || process.cwd()
  const candidates = [config.micromamba, env.LYAPUNOV_MICROMAMBA, join(productRoot, '.runtime/bin/micromamba'), join(productRoot, 'runtime/micromamba/micromamba')]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0] ?? 'micromamba'
}

/** 复用判定：解释器真实自报的 `sys.prefix` 必须就是本前缀；否则 fail-closed，绝不删/替换。 */
async function prefixState(environmentDir: string, hooks?: FastGSHooks): Promise<{exists: boolean; empty: boolean; reusable: boolean}> {
  if (!existsSync(environmentDir)) return {exists: false, empty: true, reusable: false}
  const empty = readdirSync(environmentDir).length === 0
  const python = join(environmentDir, 'bin', 'python')
  if (!existsSync(python)) return {exists: true, empty, reusable: false}
  let actual: string | null = null
  try {
    const result = await run([python, '-c', 'import os,sys;print(os.path.realpath(sys.prefix))'], {hooks, timeoutMs: PYTHON_TIMEOUT_MS})
    actual = result.code === 0 ? result.stdout.trim() || null : null
  } catch { actual = null }
  let expected: string | null = null
  try { expected = realpathSync(environmentDir) } catch { expected = null }
  return {exists: true, empty, reusable: actual !== null && expected !== null && actual === expected}
}

/** `install`：按官方 `environment.yml` 建隔离环境，或显式复用提供的解释器；不修改系统 Python。 */
export async function fastgsInstall(config: FastGSConfig = {}, hooks: FastGSHooks = {}): Promise<FastGSReceipt> {
  const {home, sourceDir, environmentDir} = fastgsPaths(config)
  const environmentFile = join(sourceDir, FASTGS_ENVIRONMENT_FILE)
  if (!existsSync(environmentFile)) throw new Error(`FASTGS_SOURCE_MISSING: 先运行 fastgs download（缺少 ${environmentFile}）`)
  const explicit = providedPython(config)
  if (explicit.length > 0) {
    // 复用解释器**只校验、不修改**：torch 存在但缺任一必需 CUDA 扩展都不算 SDK 完整。
    const probe = await probePython(explicit, hooks)
    const missing = missingExtensions(probe)
    if (probe.torch === null || missing.length > 0) {
      const reason = probe.torch === null ? `import torch 失败：${probe.error ?? 'unknown'}` : extensionSummary(probe)
      return {status: 'BLOCKED', action: 'install', mode: 'provided', python: explicit, torch: probe.torch, cuda: probe.cuda, extensions: probe.extensions, detail: `显式解释器依赖不完整（已停止；未修改该解释器）：${reason}`}
    }
    return {status: 'OK', action: 'install', mode: 'provided', python: explicit, torch: probe.torch, cuda: probe.cuda, extensions: probe.extensions, detail: `复用显式解释器 torch ${probe.torch} · cuda=${String(probe.cuda)} · ${extensionSummary(probe)}`}
  }
  const micromamba = resolveMicromamba(config)
  if (!existsSync(micromamba)) throw new Error(`FASTGS_MICROMAMBA_MISSING: 找不到 micromamba（${micromamba}）；可用 LYAPUNOV_MICROMAMBA 显式指定`)
  const state = await prefixState(environmentDir, hooks)
  if (state.exists && !state.empty && !state.reusable) {
    throw new Error(`FASTGS_PREFIX_CONFLICT: ${environmentDir} 已存在但不是本工具的隔离前缀；为不删除/替换现有环境已停止，未改动任何文件`)
  }
  {
    await mkdir(home, {recursive: true})
    // 新前缀按官方配方创建；本工具已有前缀再次安装同一配方，允许重试补齐中断的依赖。
    const created = await run([micromamba, '--no-rc', state.reusable ? 'install' : 'create', '--yes', '--prefix', environmentDir, '--file', environmentFile], {
      cwd: sourceDir,
      env: {...process.env, HF_ENDPOINT: FASTGS_HF_MIRROR, MAMBA_ROOT_PREFIX: join(home, 'mamba'), PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1'},
      hooks,
    })
    // 真实非 0 不得被后置残留的 torch 掩盖：创建命令失败即 FAILED，不再继续探测/报 OK。
    if (created.code !== 0) {
      const tail = (created.stderr.trim() || created.stdout.trim() || `exit=${String(created.code)}`).slice(-800)
      return {status: 'FAILED', action: 'install', mode: 'isolated', python: join(environmentDir, 'bin', 'python'), detail: `按官方 environment.yml 创建环境失败（micromamba exit=${String(created.code)}）：${tail}`}
    }
  }
  const python = join(environmentDir, 'bin', 'python')
  if (!existsSync(python)) return {status: 'FAILED', action: 'install', mode: 'isolated', python, detail: '环境创建结束但解释器不存在'}
  const probe = await probePython(python, hooks)
  const missing = missingExtensions(probe)
  if (probe.torch === null || missing.length > 0) {
    const reason = probe.torch === null ? `import torch 失败：${probe.error ?? 'unknown'}` : extensionSummary(probe)
    return {status: 'FAILED', action: 'install', mode: 'isolated', python, torch: probe.torch, cuda: probe.cuda, extensions: probe.extensions, detail: `环境已建立但依赖不完整：${reason}`}
  }
  return {status: 'OK', action: 'install', mode: 'isolated', python, torch: probe.torch, cuda: probe.cuda, extensions: probe.extensions, detail: `${state.reusable ? '复用' : '按官方 environment.yml 建立'}隔离环境 torch ${probe.torch} · cuda=${String(probe.cuda)} · ${extensionSummary(probe)}`}
}

export interface FastGSTrainRequest {dataset?: string; output?: string}

/** `train`：只在用户显式给出 dataset/output 时，转发官方 `train.py -s … -m …`；本模块不做任何训练实现。 */
export async function fastgsTrain(config: FastGSConfig = {}, request: FastGSTrainRequest = {}, hooks: FastGSHooks = {}): Promise<FastGSReceipt> {
  const dataset = (request.dataset ?? '').trim()
  const output = (request.output ?? '').trim()
  if (!dataset || !output) throw new Error('FASTGS_TRAIN_ARGS_REQUIRED: 训练必须显式给出 dataset(-s) 与 output(-m)，不会自动训练')
  const {sourceDir, environmentDir} = fastgsPaths(config)
  if (!existsSync(join(sourceDir, FASTGS_TRAIN_ENTRY))) throw new Error('FASTGS_SOURCE_MISSING: 先运行 fastgs download')
  const explicit = providedPython(config)
  const python = explicit.length > 0 ? explicit : existsSync(join(environmentDir, 'bin', 'python')) ? join(environmentDir, 'bin', 'python') : null
  if (!python) throw new Error('FASTGS_ENVIRONMENT_MISSING: 先运行 fastgs install，或用 LYAPUNOV_FASTGS_PYTHON 显式提供解释器')
  const probe = await probePython(python, hooks)
  const missing = missingExtensions(probe)
  if (probe.torch === null || missing.length > 0) {
    const reason = probe.torch === null ? `import torch 失败（${probe.error ?? 'unknown'}）` : extensionSummary(probe)
    throw new Error(`FASTGS_ENVIRONMENT_UNUSABLE: ${reason}`)
  }
  const argv = [python, join(sourceDir, FASTGS_TRAIN_ENTRY), '-s', dataset, '-m', output]
  const result = await run(argv, {cwd: sourceDir, env: {...process.env, HF_ENDPOINT: FASTGS_HF_MIRROR}, hooks})
  return {status: result.code === 0 ? 'OK' : 'FAILED', action: 'train', detail: `转发官方 train.py（exit=${String(result.code)}）`, dataset, output, python, exitCode: result.code}
}
