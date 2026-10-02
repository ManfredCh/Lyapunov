/**
 * Blender MCP 的**单一 owner**：路径定义 + 锁定的幂等供给 + 只读状态。
 *
 * 为什么要有这个文件：上游 Blender MCP 此前是"外挂"——`script/architecture.ts` 里把 venv 路径和
 * addon 路径**各硬编码了两遍**，缺任一文件就直接抛「建筑依赖不存在，请自行 pip install」。
 * 那是让用户替产品装依赖，不是基本能力。这里把三件事收成一处：
 *   1. **路径只有一个 owner**（`blenderMcpPaths()`）——启动方与体检方读同一份定义，不再各写一遍；
 *   2. **版本钉死在 `UPSTREAM_LOCK.json`**（包版本 + wheel sha256 + addon 提交 + addon sha256），
 *      与上游 DSH 用同一套锁机制，不靠 `main` 分支漂移；
 *   3. **幂等供给**（`ensureBlenderMcp()`）——已就绪不重复下载/安装；能验的都验（sha256、控制台脚本、
 *      包可导入），验不过就报出来，不假装就绪。
 *
 * 就绪判据**不看解释器是否存在**：产品里已有实测教训——`uv venv` 建出的空壳目录也带 `bin/python`，
 * 只看解释器会在"装了一半"时报就绪（见 `engine-preference.ts` 的 `isaacRuntimeAvailable`）。
 * 这里同理，要求**控制台脚本存在 + 包真的在 site-packages 里 + addon 的 sha256 对得上**。
 *
 * 边界（合同 §2.5）：产品**不自建替代 MCP Server**。本模块只供给上游产物，协议与实现都归上游。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { PRODUCT_ROOT } from './profile.ts'

const LOCK_FILE = join(PRODUCT_ROOT, 'UPSTREAM_LOCK.json')

export interface BlenderMcpAddonLock {
  repository: string
  commit: string
  path: string
  url: string
  bytes: number
  sha256: string
  blInfoVersion: string
}

export interface BlenderMcpWheelLock {
  filename: string
  url: string
  bytes: number
  sha256: string
}

export interface BlenderMcpLock {
  status: string
  package: string
  version: string
  requiresPython: string
  wheel: BlenderMcpWheelLock
  consoleScript: string
  importPackage: string
  importPackageNote?: string
  /** wheel 里自带的 addon（首选来源）。 */
  bundledAddon: { pathInWheel: string; note: string }
  /** addon 的期望字节与出处；两条来源都用这里的 sha256 校验。 */
  addon: BlenderMcpAddonLock
}

/** 上游锁条目。缺条目时**明确报错**，不悄悄回退到"随便装个最新版"。 */
export function blenderMcpLock(): BlenderMcpLock {
  const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { blenderMcp?: BlenderMcpLock }
  if (!lock.blenderMcp) throw new Error('BLENDER_MCP_LOCK_MISSING: UPSTREAM_LOCK.json 没有 blenderMcp 条目')
  return lock.blenderMcp
}

export interface BlenderMcpPaths {
  /** 供给根：`.runtime/blender-mcp`，只放本能力自己的产物。 */
  root: string
  /** 独立 venv；不污染宿主 Python（合同：不为扩展修改宿主 Python 包）。 */
  venv: string
  /** 上游 stdio 服务可执行文件。 */
  command: string
  /** 上游 Blender addon。 */
  addon: string
  /** 下载缓存（wheel / addon），校验通过后才落位。 */
  cache: string
}

/**
 * **路径定义的唯一出处**。`architecture.ts`、体检面、门都从这里取，不再各写一遍。
 * `LYAPUNOV_BLENDER_MCP_COMMAND` 存在时只覆盖**可执行文件**（保留用户显式指定的能力），
 * venv/addon 仍走本模块——这样"显式指定"与"产品供给"不会各自解析出两套布局。
 */
export function blenderMcpPaths(env: NodeJS.ProcessEnv = process.env): BlenderMcpPaths {
  const root = join(PRODUCT_ROOT, '.runtime/blender-mcp')
  const venv = join(root, 'venv')
  const override = env.LYAPUNOV_BLENDER_MCP_COMMAND?.trim()
  return {
    root,
    venv,
    command: override && override.length > 0 ? override : join(venv, 'bin', blenderMcpLock().consoleScript),
    addon: join(root, 'addon.py'),
    cache: join(root, 'cache'),
  }
}

export interface BlenderMcpStatus {
  ready: boolean
  /** 逐项真实读数；`ready=false` 时这里是"差在哪"，不是笼统的"缺失"。 */
  readings: {
    commandPath: string
    commandExists: boolean
    installedPackage: string | null
    addonPath: string
    addonExists: boolean
    addonSha256: string | null
    addonMatchesLock: boolean
  }
  detail: string
}

function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

/** venv 的 site-packages 里**真的**装了目标包才算装好；返回真实目录名（含版本）供读数展示。 */
function installedPackage(venv: string, importPackage: string): string | null {
  const lib = join(venv, 'lib')
  if (!existsSync(lib)) return null
  for (const python of readdirSync(lib)) {
    const sitePackages = join(lib, python, 'site-packages')
    if (!existsSync(sitePackages)) continue
    const wanted = importPackage.replaceAll('-', '_')
    for (const entry of readdirSync(sitePackages)) {
      const normalized = entry.toLowerCase().replaceAll('-', '_')
      // 先认可导入包目录本身（最强信号），再退一步认 dist-info。
      if (normalized === wanted && !entry.includes('.')) return entry
      if (normalized.startsWith(wanted) && entry.endsWith('.dist-info')) return entry
    }
  }
  return null
}

/** 已装 wheel 里自带 addon 的真实路径（首选来源）；包没装时返回 undefined。 */
function bundledAddonPath(venv: string, lock: BlenderMcpLock): string | undefined {
  const lib = join(venv, 'lib')
  if (!existsSync(lib)) return undefined
  for (const python of readdirSync(lib)) {
    const candidate = join(lib, python, 'site-packages', lock.bundledAddon.pathInWheel)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 只读状态：**没有任何副作用**，供 doctor / 启动日志 / 门读真实情况。 */
export function blenderMcpStatus(env: NodeJS.ProcessEnv = process.env): BlenderMcpStatus {
  const lock = blenderMcpLock()
  const paths = blenderMcpPaths(env)
  // 用户显式指定的可执行文件不走 venv，此时不要求 venv 里的包——但仍要求 addon 对得上锁。
  const overridden = paths.command !== join(paths.venv, 'bin', lock.consoleScript)
  const commandExists = existsSync(paths.command)
  const pkg = overridden ? null : installedPackage(paths.venv, lock.importPackage)
  const addonSha = sha256File(paths.addon)
  const addonMatchesLock = addonSha === lock.addon.sha256
  const ready = commandExists && (overridden || pkg !== null) && addonMatchesLock
  const missing: string[] = []
  if (!commandExists) missing.push(`MCP 可执行文件不存在（${paths.command}）`)
  if (!overridden && pkg === null) missing.push(`${lock.package}==${lock.version} 未装进 ${paths.venv} 的 site-packages`)
  if (!addonMatchesLock) missing.push(`addon sha256 ${addonSha === null ? '缺失' : addonSha.slice(0, 16) + '…'} ≠ 锁定的 ${lock.addon.sha256.slice(0, 16)}…`)
  return {
    ready,
    readings: {
      commandPath: paths.command,
      commandExists,
      installedPackage: pkg,
      addonPath: paths.addon,
      addonExists: addonSha !== null,
      addonSha256: addonSha,
      addonMatchesLock,
    },
    detail: ready
      ? `Blender MCP 就绪（上游 ${lock.package}==${lock.version}${pkg ? `，已装 ${pkg}` : '，可执行文件由 LYAPUNOV_BLENDER_MCP_COMMAND 指定'}；addon v${lock.addon.blInfoVersion} @ ${lock.addon.commit.slice(0, 12)} sha256 与锁一致）`
      : `Blender MCP 未就绪：${missing.join('；')}`,
  }
}

async function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise(resolveRun => {
    const child = spawn(command, args, { cwd: options.cwd ?? PRODUCT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => resolveRun({ code: 127, stdout, stderr: stderr + String(error) }))
    child.on('exit', code => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`BLENDER_MCP_DOWNLOAD_FAILED: ${url} → HTTP ${response.status}`)
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

export interface EnsureOptions {
  /** 打印每一步；默认安静，让调用方决定是否复述。 */
  log?: (message: string) => void
  /** 网络不可用时只验不装（离线校验既有产物）。 */
  offline?: boolean
}

/**
 * **幂等供给**：已就绪则只做校验直接返回；缺什么补什么。
 *
 * 顺序刻意如此：先判就绪（零副作用）→ 再校验/落位 addon → 再建 venv 装包。
 * 任一环节失败都抛出**带真实读数**的错误，不返回"看起来成功"的状态。
 */
export async function ensureBlenderMcp(options: EnsureOptions = {}): Promise<BlenderMcpStatus> {
  const log = options.log ?? (() => undefined)
  const lock = blenderMcpLock()
  const paths = blenderMcpPaths()
  const before = blenderMcpStatus()
  if (before.ready) { log(`已就绪，无需改动：${before.detail}`); return before }

  mkdirSync(paths.cache, { recursive: true })

  // ── addon：首选从**已装的锁定 wheel** 里取（单一上游来源，不额外联网）──────────
  // 实测：锁定的 wheel 自带 `blender_mcp/bundled/addon.py`，与上游仓同提交的文件逐字节相同。
  // 只有用户用 LYAPUNOV_BLENDER_MCP_COMMAND 指向自己的 MCP 安装时（没有我们的 wheel）才回退 GitHub。
  const overriddenCommand = !paths.command.startsWith(paths.venv)
  const addonPlacement = (sourcePath: string, provenance: string): void => {
    const sha = sha256File(sourcePath)
    if (sha !== lock.addon.sha256) {
      throw new Error(`BLENDER_MCP_ADDON_HASH_MISMATCH: ${provenance} 的 addon sha256=${sha} ≠ 锁定 ${lock.addon.sha256}（拒绝落位）`)
    }
    const bytes = statSync(sourcePath).size
    if (bytes !== lock.addon.bytes) {
      throw new Error(`BLENDER_MCP_ADDON_SIZE_MISMATCH: ${provenance} 的 addon 字节数 ${bytes} ≠ 锁定 ${lock.addon.bytes}`)
    }
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.addon, readFileSync(sourcePath))
    log(`addon 校验通过并落位（来源：${provenance}）：sha256=${lock.addon.sha256.slice(0, 16)}… v${lock.addon.blInfoVersion}`)
  }

  const ensureVenvAndPackage = async (): Promise<void> => {
    const wheel = join(paths.cache, lock.wheel.filename)
    if (sha256File(wheel) !== lock.wheel.sha256) {
      if (options.offline) throw new Error(`BLENDER_MCP_OFFLINE_INCOMPLETE: ${lock.package} 未安装且指定了离线`)
      log(`下载 ${lock.wheel.filename} …`)
      await download(lock.wheel.url, wheel)
      const wheelSha = sha256File(wheel)
      if (wheelSha !== lock.wheel.sha256) {
        rmSync(wheel, { force: true })
        throw new Error(`BLENDER_MCP_WHEEL_HASH_MISMATCH: 下载到的 wheel sha256=${wheelSha} ≠ 锁定 ${lock.wheel.sha256}（拒绝安装）`)
      }
    } else {
      log(`复用缓存 wheel（sha256 与锁一致）：${lock.wheel.filename}`)
    }
    if (!existsSync(paths.venv)) {
      log(`建 venv：${paths.venv}`)
      const made = await run('python3', ['-m', 'venv', paths.venv])
      if (made.code !== 0) throw new Error(`BLENDER_MCP_VENV_FAILED: ${made.stderr.slice(-800)}`)
    }
    log(`安装 ${lock.package}==${lock.version} …`)
    const installed = await run(join(paths.venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', '--no-input', wheel])
    if (installed.code !== 0) throw new Error(`BLENDER_MCP_PIP_FAILED: ${installed.stderr.slice(-1200)}`)
    log(`安装完成：${installed.stdout.trim().split('\n').slice(-1)[0] ?? ''}`)
  }

  if (!before.readings.addonMatchesLock) {
    const fromWheel = overriddenCommand ? undefined : bundledAddonPath(paths.venv, lock)
    if (fromWheel !== undefined) {
      addonPlacement(fromWheel, `已装 wheel 的 ${lock.bundledAddon.pathInWheel}`)
    } else {
      // 没有我们的 wheel（换成用户自己的 MCP 安装，或包还没装）：先装包，再从包里取。
      if (!overriddenCommand) {
        await ensureVenvAndPackage()
        const afterInstall = bundledAddonPath(paths.venv, lock)
        if (afterInstall !== undefined) addonPlacement(afterInstall, `已装 wheel 的 ${lock.bundledAddon.pathInWheel}`)
      }
      if (!existsSync(paths.addon) || sha256File(paths.addon) !== lock.addon.sha256) {
        if (options.offline) throw new Error(`BLENDER_MCP_OFFLINE_INCOMPLETE: addon 校验不过且指定了离线：${before.detail}`)
        const staged = join(paths.cache, `addon-${lock.addon.commit.slice(0, 12)}.py`)
        log(`回退到上游仓原始 addon @ ${lock.addon.commit.slice(0, 12)} …`)
        await download(lock.addon.url, staged)
        addonPlacement(staged, `上游仓 ${lock.addon.repository}@${lock.addon.commit.slice(0, 12)}`)
      }
    }
  }

  // ── venv + 钉死的 wheel（若上面还没装）─────────────────────────────────────
  if (!overriddenCommand && !blenderMcpStatus().readings.installedPackage) await ensureVenvAndPackage()

  const after = blenderMcpStatus()
  if (!after.ready) throw new Error(`BLENDER_MCP_NOT_READY_AFTER_ENSURE: ${after.detail}`)
  return after
}

export interface BlenderMcpHostHandle {
  /** 真实监听的端口（产品把端口探测后写进 BLENDER_PORT，避免连上别人的 Blender）。 */
  port: number
  blenderVersion: string
  pid: number
  /** 就绪行的完整读数，原样保留供回执/证据使用。 */
  ready: Record<string, unknown>
  diagnostics: () => string
  /** 阻塞到 Blender 退出；返回值即退出码。 */
  exited: Promise<number>
  stop: () => Promise<void>
}

export interface StartBlenderMcpHostOptions {
  port: number
  /** 继续已有工程时给 .blend 路径；默认 `--factory-startup`（不加载用户偏好与启动工程）。 */
  sourceBlend?: string
  blenderExecutable?: string
  readyTimeoutMs?: number
}

/**
 * 起一个**真实 Blender GUI** 并让它托管上游 addon —— 这是"持有 Blender MCP 会话"这件事的**唯一 owner**。
 * `architecture.ts`（产品入口）与现场验证驱动都走这里，不再各写一遍启动/就绪/超时逻辑。
 *
 * 为什么必须是 GUI：`packages/blender/scripts/start_mcp.py` 显式拒绝 `--background`
 * （MCP 需要 GUI 主事件循环，后台模式下 addon 的 socket 线程起不来）。
 * 就绪判据是 Blender 自己打印的 `LYAPUNOV_BLENDER_MCP={status:READY,...}` 行——
 * 不是"进程还在"，也不是"端口能连"。
 */
export async function startBlenderMcpHost(options: StartBlenderMcpHostOptions): Promise<BlenderMcpHostHandle> {
  const paths = blenderMcpPaths()
  const starter = join(PRODUCT_ROOT, 'packages/blender/scripts/start_mcp.py')
  if (!existsSync(starter)) throw new Error(`BLENDER_MCP_STARTER_MISSING: ${starter}`)
  if (!existsSync(paths.addon)) throw new Error(`BLENDER_MCP_ADDON_MISSING: ${paths.addon}（先跑 ensure:blender-mcp）`)
  const executable = options.blenderExecutable ?? process.env.BLENDER_EXECUTABLE ?? 'blender'
  const child = spawn(executable, [
    ...options.sourceBlend ? [resolve(options.sourceBlend)] : ['--factory-startup'],
    '--python', starter, '--', '--addon', paths.addon, '--port', String(options.port),
  ], { cwd: PRODUCT_ROOT, env: { ...process.env, DISABLE_TELEMETRY: '1', HF_ENDPOINT: 'https://hf-mirror.com' }, stdio: ['ignore', 'pipe', 'pipe'] })

  let diagnostics = ''
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  let done = false
  const exited = new Promise<number>(resolveExit => {
    child.once('close', code => { done = true; resolveExit(code ?? 1) })
    child.once('error', () => { done = true; resolveExit(1) })
  })
  const ready = await new Promise<Record<string, unknown>>((resolveReady, rejectReady) => {
    let pending = ''
    const timer = setTimeout(() => rejectReady(new Error(`Blender MCP 未就绪（${String(options.readyTimeoutMs ?? 90_000)}ms 内没有 READY 行）：${diagnostics}`)), options.readyTimeoutMs ?? 90_000)
    child.once('error', error => { clearTimeout(timer); rejectReady(error as Error) })
    void exited.then(code => { clearTimeout(timer); rejectReady(new Error(`Blender 退出 ${String(code)}：${diagnostics}`)) })
    child.stdout!.on('data', chunk => {
      pending += String(chunk)
      const lines = pending.split('\n'); pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('LYAPUNOV_BLENDER_MCP=')) continue
        clearTimeout(timer)
        resolveReady(JSON.parse(line.slice('LYAPUNOV_BLENDER_MCP='.length)) as Record<string, unknown>)
      }
    })
  })
  if (ready.status !== 'READY') throw new Error(`BLENDER_MCP_START_FAILED: ${JSON.stringify(ready)}`)
  const stop = async (): Promise<void> => {
    if (done) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (!done) child.kill('SIGKILL') }, 5000)
    await exited
    clearTimeout(timer)
  }
  return {
    port: Number(ready.port), blenderVersion: String(ready.blenderVersion ?? ''), pid: child.pid ?? -1,
    ready, diagnostics: () => diagnostics, exited, stop,
  }
}

if (import.meta.main) {
  const offline = process.argv.includes('--offline')
  const checkOnly = process.argv.includes('--check')
  if (checkOnly) {
    const status = blenderMcpStatus()
    console.log(status.detail)
    console.log(JSON.stringify(status.readings, null, 2))
    process.exit(status.ready ? 0 : 2)
  }
  const status = await ensureBlenderMcp({ offline, log: message => { console.log('· ' + message) } })
  console.log(status.detail)
  console.log(JSON.stringify(status.readings, null, 2))
}
