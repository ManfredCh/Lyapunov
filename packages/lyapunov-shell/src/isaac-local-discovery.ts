import {opendirSync} from "node:fs"
import {homedir, userInfo} from "node:os"
import {join} from "node:path"
import {writeSdkPythonPreference} from "../../../script/engine-preference.ts"
import {readSdkPythonPreference, resolveSdkPython} from "../../lyapunov-product-bundle/src/sdk-python.mjs"
import {clearIsaacSdkProbeCache, inspectIsaacPython, resolveIsaacLocalEntry} from "../../lyapunov-product-bundle/src/isaac-sdk-probe.mjs"
import type {IsaacLocalDiscovery, IsaacLocalSelection} from "./engine-provider-contract.ts"
import {invalidateHostReadiness} from "./provider-installer.ts"

type Register = (suffix: string, methods: readonly ("GET" | "POST")[], handler: (request: Request) => Promise<Response>) => unknown
export interface IsaacLocalOptions {
  productRoot: string
  env?: NodeJS.ProcessEnv
  onChanged?: () => void
  /** 离线测试可以限定扫描根；正式按钮只看下面列出的用户安装目录。 */
  home?: string
  scanRoots?: readonly string[]
  timeoutMs?: number
  maxCandidates?: number
}

function loginHome(): string {
  // 正式 Host HOME 位于隔离运行根；用户安装根来自 OS 用户记录，不读取账号或环境配置文件。
  try { return userInfo().homedir } catch { return homedir() }
}

/** 每目录最多读取 128 项，最多探测 16 个入口；只在用户点击时执行，不递归全盘。 */
export function isaacCandidatePaths(options: IsaacLocalOptions): {paths: string[]; limited: boolean} {
  const env = options.env ?? process.env
  const max = Math.min(16, Math.max(1, options.maxCandidates ?? 16))
  const paths = new Set<string>()
  let limited = false
  const add = (input: string | undefined) => {
    if (!input) return
    const entry = resolveIsaacLocalEntry(input)
    if (!entry || paths.has(entry)) return
    if (paths.size >= max) { limited = true; return }
    paths.add(entry)
  }
  add(env.LYAPUNOV_ISAAC_PYTHON)
  add(readSdkPythonPreference("isaac", env))
  add(resolveSdkPython(options.productRoot, "isaac", env, {managed: true}).python)
  const home = options.home ?? loginHome()
  const direct = options.scanRoots ?? [join(home, "isaacsim"), join(home, "isaac-sim"), "/opt/isaacsim", "/opt/isaac-sim"]
  for (const directory of direct) add(directory)
  const children = (directory: string, matches: (name: string) => boolean) => {
    let handle: ReturnType<typeof opendirSync> | undefined
    try {
      handle = opendirSync(directory)
      let count = 0
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++count > 128) { limited = true; break }
        if ((entry.isDirectory() || entry.isSymbolicLink()) && matches(entry.name)) add(join(directory, entry.name))
      }
    } catch { /* 常见根不存在属于正常情况 */ }
    finally { handle?.closeSync() }
  }
  if (options.scanRoots) {
    for (const directory of options.scanRoots) children(directory, () => true)
  } else {
    for (const directory of [home, join(home, "Downloads"), join(home, ".local/share/ov/pkg"), "/opt"]) children(directory, name => /isaac[-_]?sim/i.test(name))
    for (const directory of [join(options.productRoot, ".runtime/conda/envs"), ...["miniconda3", "miniforge3", "anaconda3", "mambaforge", ".conda"].map(name => join(home, name, "envs"))]) children(directory, () => true)
  }
  return {paths: [...paths], limited}
}

export function createIsaacLocalDiscovery(options: IsaacLocalOptions) {
  const env = options.env ?? process.env
  const selection = (): IsaacLocalSelection => {
    const next = resolveSdkPython(options.productRoot, "isaac", env)
    return {savedPython: readSdkPythonPreference("isaac", env) ?? null, nextPython: next.python, nextSource: next.source, restartRequired: true,
      detail: next.source === "env-override" ? "显式 LYAPUNOV_ISAAC_PYTHON 优先于保存选择；保存路径将在取消该覆盖并重启后使用。"
        : "这是下次启动使用的 SDK 路径。选择 SDK 不切换当前物理引擎、不重启正在运行的会话。"}
  }
  const discover = async (path?: string): Promise<IsaacLocalDiscovery> => {
    const scan = path === undefined ? isaacCandidatePaths(options) : {paths: [path], limited: false}
    const candidates: IsaacLocalDiscovery["candidates"] = new Array(scan.paths.length)
    let index = 0
    const worker = async () => {
      while (index < scan.paths.length) {
        const own = index++
        candidates[own] = await inspectIsaacPython(scan.paths[own], {productRoot: options.productRoot, env, timeoutMs: options.timeoutMs ?? 2500, fresh: true})
      }
    }
    await Promise.all(Array.from({length: Math.min(3, scan.paths.length)}, worker))
    return {candidates, selection: selection(), scanned: candidates.length, limited: scan.limited,
      detail: candidates.length ? "只检查本地 SDK 模块、版本与 Python。许可、物理世界和 RTX 能力仍需分别检查。" : "常见目录未发现可检查的安装入口。可以输入已有 Python、python.sh 或安装目录的绝对路径。"}
  }
  const select = async (input: string | null) => {
    if (input !== null) {
      const candidate = await inspectIsaacPython(input, {productRoot: options.productRoot, env, timeoutMs: options.timeoutMs ?? 2500, fresh: true})
      if (!candidate.compatible) throw new Error(`ISAAC_LOCAL_SDK_INVALID: ${candidate.detail}`)
      writeSdkPythonPreference("isaac", candidate.python, env)
    } else writeSdkPythonPreference("isaac", null, env)
    clearIsaacSdkProbeCache()
    invalidateHostReadiness()
    options.onChanged?.()
    return selection()
  }
  return {selection, discover, select}
}

/** 主控在 plugin.ts 复用既有 register 接线；本文件不注册第二套服务。 */
export function registerIsaacLocalRoutes(register: Register, options: IsaacLocalOptions): void {
  const local = createIsaacLocalDiscovery(options)
  const headers = {"cache-control": "private, no-store"}
  register("isaac-local/selection", ["GET"], async () => Response.json(local.selection(), {headers}))
  register("isaac-local/discover", ["POST"], async request => {
    const body = await request.json() as {path?: unknown}
    if (body.path !== undefined && typeof body.path !== "string") throw new Error("ISAAC_LOCAL_PATH_REQUIRED")
    return Response.json(await local.discover(body.path as string | undefined), {headers})
  })
  register("isaac-local/select", ["POST"], async request => {
    const body = await request.json() as {python?: unknown}
    if (body.python !== null && typeof body.python !== "string") throw new Error("ISAAC_LOCAL_PYTHON_REQUIRED")
    return Response.json(await local.select(body.python as string | null), {headers})
  })
}
