/**
 * 系统 PROJ 命令行的薄适配层：本工具的**全部**投影、基准与大地线计算都交给 PROJ 标准实现——
 *   · `cct` ：执行 `projinfo` 给出的那条坐标运算管线本身（反向用同一条管线的 `-I`，正反严格互逆），
 *             以及 `cart`→`topocentric` 的局部 ENU 管线；
 *   · `geod`：WGS84 椭球上的大地线距离（Karney 算法），用作畸变实测的独立口径；
 *   · `projinfo`：这对 CRS 之间 PROJ 实际会用哪条运算（候选、精度、适用范围、缺不缺格网）。
 *
 * 为什么数值不再走 `cs2cs +init=epsg:N +to +init=epsg:4326`（任务 92 收口的那条）：
 * cs2cs 会**自己**在候选里挑一条运算，而报告层另跑一次 projinfo 就把"报告的操作"与"算出数值的操作"
 * 分成了两条路线。实测（本机 PROJ 8.2.1，EPSG:27700→4326）：projinfo 默认参数列出的候选里，
 * 第一个可用的是 ballpark/noop、精度 unknown；而 cs2cs 实际执行的是 `PROJ_DEBUG=3` 自报的
 * "Inverse of British National Grid + OSGB36 to WGS 84 (6)"（2 m 的七参数）——两者不是一回事，
 * 报告把候选当实际执行就是错的。现在：
 *   projinfo -s <来源> -t EPSG:4326 --spatial-test intersects --grid-check discard_missing
 * 取 PROJ 排序里的第一条（`--spatial-test intersects` 是运行时的空间筛选口径；`--grid-check discard_missing`
 * 与运行时"格网缺失的候选实例化失败就跳过"是同一套可用性判断，实测与 cs2cs 自报的运算名一致），
 * 把它自报的 PROJ 字符串**原文**交给 cct 执行——数值因此可证明来自所报告的那条运算。
 *
 * 轴序与单位不由本层自定：PROJ 把"这一端是 EPSG 权威轴序"写成管线里的 `+proj=axisswap +order=2,1` 步骤，
 * 本工具对外始终是传统序（经度/东距在前），执行时按管线自报的轴序换列；角度/弧度由 cct 按 PROJ 口径换算，
 * 本层不写任何单位或轴序的数值规则。
 *
 * 本层**不做**数值实现：没有级数展开、没有基准变换规则、没有大地线迭代——那些都是 PROJ 的事实。
 *
 * 缺 PROJ（或调用失败）时**明确抛错**（`MAP_PROJ_UNAVAILABLE` / `MAP_PROJ_FAILED` + 可执行动作），
 * 绝不静默退回自造算法或换一套精度口径。
 * 子进程一律走异步执行器（见 `ProjProcessRunner`）：等待期间事件循环不被占住（同进程其它会话照常响应），
 * 调用方取消时真的杀掉本次子进程（不是只在调用前后各查一次信号）。
 * 宿主若把 PROJ 装在非 PATH 位置：设 `MAP_CONSTRAINTS_PROJ_BIN_DIR` 指向其 bin 目录即可。
 */
import { spawn } from "node:child_process"
import { join } from "node:path"

/** WGS84 经纬度的 PROJ 记号（本工具的基准 CRS；对外恒为 经度,纬度 传统顺序）。 */
export const WGS84_PROJ = "+init=epsg:4326"

/** 一次批调用允许的 stdout 上限（200k 顶点 × 每行约 40 字节，留足余量）。 */
const MAX_STDOUT_BYTES = 256 * 1024 * 1024
/** stderr 只用来取失败原因，留尾部若干字节即可。 */
const MAX_STDERR_BYTES = 64 * 1024
/** 取消时先 SIGTERM，超过这个宽限还没退出就 SIGKILL。 */
const KILL_GRACE_MS = 2000

/** 本工具用到的 PROJ 命令（projinfo 只用于核对"这段换算由 PROJ 决定"这类事实）。 */
export type ProjCommand = "cs2cs" | "cct" | "geod" | "proj" | "projinfo"

/** WGS84 大地坐标（度、度、米）。 */
export interface ProjPoint { lon: number; lat: number; h: number }
/** 来源 CRS / 目标 CRS 的二维坐标（米或度，按 CRS 定义）。 */
export type ProjPair = [number, number]
/** 局部 ENU 米制坐标（东、北、上）。 */
export type ProjEnu = [number, number, number]

const PROJ_INSTALL_ACTION = "可采取的动作：安装 PROJ 命令行（Debian/Ubuntu: apt install proj-bin；macOS: brew install proj），或设 MAP_CONSTRAINTS_PROJ_BIN_DIR 指向已有 PROJ 的 bin 目录；也可以用 pyproj/QGIS/来源站点自带的转换先把坐标转成 EPSG:4326 再传入（本工具不会自己实现投影算法）。"

function binaryPath(name: ProjCommand): string {
  const dir = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
  return dir ? join(dir, name) : name
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** 一次 PROJ 命令的请求：完整 argv（不经 shell）+ stdin 内容 + 取消信号。 */
export interface ProjProcessRequest { argv: string[]; input: string; signal?: AbortSignal }
/** 执行结果：退出事实（退出码或终止信号）与有界输出；spawn 本身失败时给 spawnError。 */
export interface ProjProcessOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  /** spawn 失败（如 ENOENT）时的错误码；正常启动为 null。 */
  spawnError: string | null
}

/**
 * PROJ 命令的执行器。默认实现 `spawnProjProcess` 用 Node 原生子进程（spawn + Promise，
 * 与仓内其它异步子进程调用同一口径）：等待期间事件循环是自由的，abort 时真的 kill 掉本次子进程。
 * 装配方若要换成宿主自己的子进程服务（如原生 `ctx.subprocess`），传一个同签名的 runner 即可，
 * 本层其余代码不感知实现——但**必须**保持异步与可取消这两条语义。
 */
export type ProjProcessRunner = (request: ProjProcessRequest) => Promise<ProjProcessOutcome>

/** 执行一次 PROJ 命令的公共选项：取消信号 + 子进程执行器（省略则用默认实现）。 */
export interface ProjRunOptions { signal?: AbortSignal; runner?: ProjProcessRunner }

/** 默认执行器：异步子进程，stdout/stderr 有界收集，abort → SIGTERM（宽限后 SIGKILL）。 */
export function spawnProjProcess(request: ProjProcessRequest): Promise<ProjProcessOutcome> {
  return new Promise(resolve => {
    const [binary, ...args] = request.argv
    const child = spawn(binary!, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    let stdoutBytes = 0
    let spawnError: string | null = null
    let killTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      child.kill("SIGTERM")
      // 宽限后还没停就 SIGKILL：取消不能让调用方无限等下去（PROJ 是单个可执行文件，没有子进程树）。
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    if (request.signal?.aborted) onAbort()
    else request.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES) })
    // 子进程先退出（或已被取消）时往 stdin 写会得到 EPIPE：那是预期的收尾，不是本层要报的错误。
    child.stdin?.on("error", () => undefined)
    child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? error.message })
    child.on("close", (exitCode, signal) => {
      request.signal?.removeEventListener("abort", onAbort)
      if (killTimer) clearTimeout(killTimer)
      resolve({ stdout, stderr, exitCode, signal, spawnError })
    })
    child.stdin?.end(request.input)
  })
}

/**
 * 执行一条 PROJ 命令（批量：全部输入走 stdin，结果从 stdout 读）。
 * 异步：等待期间事件循环不被占住；取消会杀掉本次子进程并把取消原因原样抛出（不写成 PROJ 失败）。
 */
export async function runProjCommand(name: ProjCommand, args: string[], input: string, options: ProjRunOptions = {}): Promise<string> {
  options.signal?.throwIfAborted()
  const binary = binaryPath(name)
  const runner = options.runner ?? spawnProjProcess
  const outcome = await runner({ argv: [binary, ...args], input, signal: options.signal })
  // 取消是本层的第一判据：被取消时子进程多半是被我们杀掉的，不能报成"PROJ 失败"。
  options.signal?.throwIfAborted()
  if (outcome.spawnError) {
    if (outcome.spawnError === "ENOENT") throw new Error(`MAP_PROJ_UNAVAILABLE: 找不到 PROJ 命令「${binary}」（本工具的投影与大地线计算全部由 PROJ 完成，不做自造算法）。${PROJ_INSTALL_ACTION}`)
    throw new Error(`MAP_PROJ_FAILED: 执行「${binary}」失败（${outcome.spawnError}）。${PROJ_INSTALL_ACTION}`)
  }
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim().split("\n").slice(0, 3).join(" / ").slice(0, 300)
    // exitCode 为 null 表示子进程被信号终止（例如调用方的取消/超时把它杀了），如实说明，不写成"退出码 null"。
    const how = outcome.exitCode === null ? `被信号 ${outcome.signal ?? "未知"} 终止` : `退出码 ${outcome.exitCode}`
    // 缺格网与"坐标越界/CRS 不对"是两类失败，可执行动作完全不同：按 PROJ 的原话分开给。
    const action = /File not found or invalid/.test(outcome.stderr) && /grid/i.test(outcome.stderr)
      ? "可采取的动作：这条运算要的格网没装在本机（PROJ 报 File not found or invalid）——把格网装进 PROJ 的数据目录后重试（路径见 projinfo --searchpaths），或设 PROJ_NETWORK=ON 让 PROJ 按自己的清单下载；也可以用 pyproj/QGIS 完成这段带格网的换算再把结果传进来。本工具不会静默改用别的运算。"
      : "可采取的动作：核对声明的 CRS 与坐标范围（越界的 UTM 东距/北距、非法的带号、超出 Web 墨卡托有效纬度的 y 值都会让 PROJ 直接失败）；确实属于本工具不支持的 CRS 时，先用 pyproj/QGIS 转到 EPSG:4326。"
    const shown = args.join(" ")
    throw new Error(`MAP_PROJ_FAILED: 「${binary} ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}」${how}${detail ? `，PROJ 报：${detail}` : ""}。${action}`)
  }
  return outcome.stdout
}

/**
 * 逐行解析 PROJ 的表格输出：行数必须与输入点数一致（PROJ 对非法输入会照常输出、甚至回显原文，
 * 所以这里按行数 + 数值格式双重校验，宁可报错也不把读歪的坐标当结果）。
 */
export function parseProjRows(stdout: string, expected: number, columns: number, what: string): number[][] {
  const lines = stdout.split("\n").filter(line => line.trim().length > 0)
  if (lines.length !== expected) {
    throw new Error(`MAP_PROJ_FAILED: ${what} 返回 ${lines.length} 行，期望 ${expected} 行，输出无法逐点对应。可采取的动作：把数据裁剪/分块后重试，并把这条不一致报告出来（不要用行数对不上的结果继续建模）。`)
  }
  return lines.map((line, index) => {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < columns || tokens.slice(0, columns).some(token => !NUMERIC.test(token))) {
      throw new Error(`MAP_PROJ_FAILED: ${what} 第 ${index + 1} 行不是可解析的坐标（「${line.trim().slice(0, 80)}」）。可采取的动作：核对这条来源坐标是否落在所声明 CRS 的有效范围内（PROJ 对越界点会输出 * / inf）。`)
    }
    return tokens.slice(0, columns).map(Number)
  })
}

/** 固定小数位（避免指数记号进 stdin；12 位对度≈0.1 µm、对米≈1 pm，都远超需要）。 */
function fixed(value: number): string {
  return value.toFixed(12)
}

/**
 * 拼批量输入。**必须带结尾换行**：实测 cct 会静默丢掉没有换行结尾的最后一行
 * （cs2cs/geod 不会，但统一带上，免得这类"少一行"变成错位的坐标）。
 */
function toStdin(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : ""
}

/** cart→topocentric 管线：输入 经度 纬度 高程（度/度/米），输出 ENU 米。 */
function enuPipeline(anchor: ProjPoint): string {
  return `+proj=pipeline +step +proj=cart +ellps=WGS84 +step +proj=topocentric +ellps=WGS84 +lat_0=${anchor.lat} +lon_0=${anchor.lon} +h_0=${anchor.h}`
}

/** 反向管线：输入 ENU 米，输出 经度 纬度 高程。 */
function enuInversePipeline(anchor: ProjPoint): string {
  return `+proj=pipeline +step +proj=topocentric +ellps=WGS84 +lat_0=${anchor.lat} +lon_0=${anchor.lon} +h_0=${anchor.h} +inv +step +proj=cart +ellps=WGS84 +inv`
}

/** 批量 大地坐标 → 以 anchor 为原点的局部 ENU 米制坐标（跨 ±180 由三维几何自然处理）。 */
export async function wgs84ToEnu(anchor: ProjPoint, points: ProjPoint[], options: ProjRunOptions = {}): Promise<ProjEnu[]> {
  if (points.length === 0) return []
  const input = toStdin(points.map(point => `${fixed(point.lon)}\t${fixed(point.lat)}\t${fixed(point.h)}`))
  // -d 10：输出量化到 0.1 nm。cct 的默认/低精度会在短距离上盖过切平面项（实测 -d 6 时约 0.4 µm），
  // 让"ENU 与大地线×方位角之差"这类二阶量检查失去意义。
  const stdout = await runProjCommand("cct", ["-d", "10", ...enuPipeline(anchor).split(" ")], input, options)
  return parseProjRows(stdout, points.length, 3, "cct cart→topocentric（局部 ENU）").map(row => [row[0]!, row[1]!, row[2]!] as ProjEnu)
}

/** 批量 局部 ENU 米制 → 大地坐标（wgs84ToEnu 的严格逆运算）。 */
export async function enuToWgs84(anchor: ProjPoint, points: ProjEnu[], options: ProjRunOptions = {}): Promise<ProjPoint[]> {
  if (points.length === 0) return []
  const input = toStdin(points.map(point => `${fixed(point[0])}\t${fixed(point[1])}\t${fixed(point[2])}`))
  const stdout = await runProjCommand("cct", ["-d", "12", ...enuInversePipeline(anchor).split(" ")], input, options)
  return parseProjRows(stdout, points.length, 3, "cct topocentric→cart（反算大地坐标）").map(row => ({ lon: row[0]!, lat: row[1]!, h: row[2]! }))
}

/**
 * 批量 WGS84 椭球大地线距离（geod 的 inverse 解，Karney 算法；近对跖点同样收敛）。
 * 入参第二组为"从 a 出发的各个终点"，返回与 points 同序的米数。
 */
export async function geodesicDistancesM(a: ProjPoint, points: ProjPoint[], options: ProjRunOptions = {}): Promise<number[]> {
  if (points.length === 0) return []
  const input = toStdin(points.map(point => `${fixed(a.lat)}\t${fixed(a.lon)}\t${fixed(point.lat)}\t${fixed(point.lon)}`))
  const stdout = await runProjCommand("geod", ["+ellps=WGS84", "-I", "-f", "%.6f"], input, options)
  return parseProjRows(stdout, points.length, 3, "geod -I（WGS84 大地线距离）").map(row => row[2]!)
}

/**
 * `projinfo` 给出的"这对 CRS 之间 PROJ 会用哪条运算"的事实记录。
 *
 * 为什么必须问 PROJ 而不是自己判断：投影、基准（datum）、历元（epoch）、垂直基准是四件事。
 * 同一对 EPSG 代码之间可能根本没有基准归算（ballpark）、可能缺格网、可能是 7 参数、也可能
 * 是随时间变化的动态框架——只有 `projinfo` 知道本机 PROJ 现在会怎么做。
 */
export interface DatumOperationGrid { name: string; url: string | null }
/** PROJ 列出的一个候选运算（按优先级排列；`usable=false` 表示它需要的格网本机没有）。 */
export interface DatumOperationCandidate {
  description: string
  accuracy: string
  ballpark: boolean
  usable: boolean
  missingGrids: DatumOperationGrid[]
}
export interface DatumOperation {
  /** 探测的 CRS 对（EPSG 记号）。 */
  from: string
  to: string
  /**
   * 被选中运算的种类（按它的 PROJ 管线判定）：
   * `noop`=声明上无变化；`projection`=纯投影正反算（同一基准）；`datum`=三/七参数或椭球转换；
   * `grid`=格网（grid shift）基准变换；`unknown`=管线里有本层不认识的步骤（照实标 unknown，不猜）。
   */
  kind: "noop" | "projection" | "datum" | "grid" | "unknown"
  /** PROJ 对该运算的完整描述行（名字 + 精度 + 适用范围 + 标志）。 */
  description: string
  /** PROJ 自报精度（"0 m" / "1 m" / "2.01 m" / "unknown accuracy"）。 */
  accuracy: string
  /** PROJ 自报适用范围（候选行里的区域文本，原样转述）。 */
  area: string
  /**
   * **选中这条运算自己**缺的格网（没有则为空）。逐候选的事实见 candidates——
   * 别的候选缺不缺格网不该左右这条已经选定、且本机可用的运算（任务 92 的判据）。
   */
  missingGrids: DatumOperationGrid[]
  /** PROJ 是否把这条运算标成 ballpark（即没有真实的基准归算）。 */
  ballpark: boolean
  /** 这条运算在本机是否可用（格网齐全）。false 时 cct 执行会直接失败——不退回 cs2cs 的隐式回退。 */
  usable: boolean
  /** 选中的是列表里的第几条（1 起；PROJ 的排序即优先级）。 */
  selectedCandidate: number
  /** 选中运算的 PROJ 管线原文（数值由它执行得出，可原样复核）。 */
  projString: string
  /** PROJ 一共列出几条候选。 */
  candidateCount: number
  /** 全部候选（逐个给出描述、精度、是否 ballpark、是否可用、缺哪些格网）。 */
  candidates: DatumOperationCandidate[]
  /**
   * 数值执行口径：管线原文交给标准 `cct` 执行（反向用 `-I`，与正向严格互逆）。
   * 两端轴序由管线自带的 axisswap 步骤判定（PROJ 写的就是这个意思），本层不另立规则。
   */
  execution: {
    engine: "cct"
    /** 管线两端相对"经度/东距在前"的传统序是否需要换列。 */
    axisSwap: { input: boolean; output: boolean; unsupported: boolean }
    note: string
  }
  /** 来源/目标里有带 FRAMEEPOCH 的动态参考框架：基准随历元变化。 */
  dynamicFrame: boolean
  /** 管线含时间相关参数（+t_epoch / +rate_* / +proj=deformation）。 */
  timeDependent: boolean
}

/** 不含基准变化的步骤（管线脚手架）。 */
const NEUTRAL_STEPS = new Set(["pipeline", "unitconvert", "axisswap", "pop", "affine", "set", "noop", "longlat", "latlong", "push", "pull"])
const GRID_STEPS = new Set(["hgridshift", "vgridshift", "gridshift"])
const DATUM_STEPS = new Set(["helmert", "molodensky", "molodensky_badekas", "geocent", "deformation", "geogoffset", "cart", "xyz"])
const PROJECTION_STEPS = new Set([
  "tmerc", "utm", "webmerc", "merc", "omerc", "somerc", "lcc", "laea", "aea", "aeqd", "stere", "sterea", "cass",
  "gstmerc", "eqc", "eqearth", "mill", "gall", "robin", "sinu", "vandg", "loxim", "krovak", "poly", "gnom", "ortho",
  "nsper", "tcc", "geos", "cea", "tgauss", "qsc", "bonne", "nzmg", "wink1", "wink2", "aitoff", "moll", "hammer",
])

/** 从候选的 PROJ 管线判定种类：只认管线里真实出现的步骤，不靠 CRS 名字猜。 */
function classifySteps(projString: string): DatumOperation["kind"] {
  const steps = [...projString.matchAll(/\+proj=([a-z0-9_]+)/g)].map(match => match[1]!)
  if (steps.length === 0) return "unknown"
  if (steps.some(step => GRID_STEPS.has(step))) return "grid"
  if (steps.some(step => DATUM_STEPS.has(step))) return "datum"
  if (steps.every(step => step === "noop" || NEUTRAL_STEPS.has(step))) return "noop"
  if (steps.every(step => PROJECTION_STEPS.has(step) || NEUTRAL_STEPS.has(step))) return "projection"
  return "unknown"
}

/** 切分管线的步骤（`+step` 起新的一步；首步可以省略 `+step`）。 */
function pipelineSteps(pipeline: string): string[][] {
  const steps: string[][] = []
  for (const token of pipeline.split(/\s+/).filter(Boolean)) {
    if (token === "+step") { steps.push([]); continue }
    if (steps.length === 0) steps.push([])
    steps[steps.length - 1]!.push(token)
  }
  return steps
}

/**
 * 这一步是不是"把前两列换个位置"（PROJ 用它把经纬度对到该 CRS 的权威轴序，如 EPSG:4326 的 纬度,经度）。
 * `+order=2,1` 与不带 `+order`（PROJ 默认即 2,1）都算；别的前后/三轴置换本层不认识 → 不猜。
 */
function isAxisSwap(step: string[] | undefined): boolean {
  if (!step || !step.includes("+proj=axisswap")) return false
  const order = step.find(token => token.startsWith("+order="))
  return order === undefined || order === "+order=2,1"
}

/** 认不出的轴置换（非 2,1、或出现在管线中间）：宁可明确报错，也不要按错的列序算出一堆看着正常的坐标。 */
function hasUnknownAxisSwap(steps: string[][]): boolean {
  return steps.some((step, index) => step.includes("+proj=axisswap")
    && (!isAxisSwap(step) || (index !== 0 && index !== steps.length - 1)))
}

/**
 * 从管线原文读出两端轴序——不是本层自己定的规则，而是 PROJ 自己写进管线的结构：
 * PROJ 的管线两端都按各自 CRS 的权威轴序（EPSG:4326 是 纬度,经度），所以
 * 首步 axisswap 说明"输入是权威轴序（纬度在前）"、末步 axisswap 说明"输出是权威轴序"；
 * 本工具对外恒为经度/东距在前（传统序），执行时据此换列。
 * 整条管线只有一步且就是 axisswap（如 EPSG:4490→OGC:CRS84）时，它只换入、不换出。
 * 实测（本机 PROJ 8.2.1）：EPSG:32632→EPSG:4326 的管线是
 *   +proj=pipeline +step +inv +proj=utm +zone=32 … +step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=axisswap +order=2,1
 * （输出 纬度,经度）；目标换成 OGC:CRS84 时这条尾步消失（输出 经度,纬度）——两种都按管线自报的结构处理。
 */
function pipelineAxisSwap(pipeline: string): { input: boolean; output: boolean; unsupported: boolean } {
  const steps = pipelineSteps(pipeline)
  const single = steps.length === 1 && isAxisSwap(steps[0])
  return {
    input: isAxisSwap(steps[0]),
    output: single ? false : isAxisSwap(steps[steps.length - 1]),
    unsupported: hasUnknownAxisSwap(steps),
  }
}

const ACCURACY = /(unknown accuracy|unknown|[0-9]+(?:\.[0-9]+)?\s*(?:mm|m)),\s/

/** 描述行里"精度"之后、"标志"之前的那段是适用范围；标志由 PROJ 固定写在末尾。 */
function areaOf(description: string, accuracyMatch: RegExpExecArray | null): string {
  if (!accuracyMatch) return ""
  const tail = description.slice(accuracyMatch.index + accuracyMatch[0].length)
  return tail.replace(/,\s*(has ballpark transformation|at least one grid missing)\s*$/i, "").trim()
}

/**
 * 解析 `projinfo` 的输出（**逐候选**）。
 * 候选之间用横线分隔；每个候选块里有描述行、PROJ 管线，缺格网时还有 PROJ 自己的
 * "Grid X needed but not found on the system. Can be obtained at <url>"。
 * 选中规则：取列表第一条——`--grid-check discard_missing` 已经把本机不可用的候选去掉，
 * 剩下的排序就是 PROJ 的优先级，运行时用的就是这条（实测与 cs2cs 自报的运算名一致）。
 * 万一一条可用候选都没有（全部缺格网），PROJ 运行时会退回 ballpark，这里同样挑第一条 ballpark。
 */
export function parseDatumOperations(stdout: string, from: string, to: string): DatumOperation {
  const lines = stdout.split("\n").map(line => line.trimEnd())
  const countMatch = /Candidate operations found:\s*(\d+)/.exec(stdout)
  const candidateCount = countMatch ? Number(countMatch[1]) : 0
  const blocks: string[][] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (/^-{5,}$/.test(line.trim())) { current = []; blocks.push(current); continue }
    current?.push(line)
  }
  const textOf = (block: string[]): { description: string; projString: string; grids: DatumOperationGrid[] } => {
    const description: string[] = []
    const start = block.findIndex(line => /^Operation No\./.test(line))
    for (let index = start + 1; index < block.length; index++) {
      const line = block[index]!.trim()
      if (!line) { if (description.length) break; else continue }
      if (/^(PROJ string|WKT2|WKT|Grid |Note)/.test(line)) break
      description.push(line)
    }
    const projString: string[] = []
    const projStart = block.findIndex(line => /^PROJ string:/.test(line.trim()))
    for (let index = projStart + 1; projStart >= 0 && index < block.length; index++) {
      const line = block[index]!.trim()
      if (!line) { if (projString.length) break; else continue }
      if (/^(WKT2|WKT|Grid |Note)/.test(line)) break
      projString.push(line)
    }
    const grids: DatumOperationGrid[] = []
    for (const line of block) {
      const grid = /^Grid (\S+) needed but not found\b.*?(?:Can be obtained at (\S+))?\s*$/.exec(line.trim())
      if (grid) grids.push({ name: grid[1]!, url: grid[2] ? grid[2].replace(/\.$/, "") : null })
    }
    return { description: description.join(" ").trim(), projString: projString.join(" ").trim(), grids }
  }
  const parsed = blocks.map(block => textOf(block))
    .filter(entry => entry.description.length > 0)
    .map(entry => {
      const accuracyMatch = ACCURACY.exec(entry.description)
      const accuracy = accuracyMatch ? accuracyMatch[1]!.trim() : "unknown"
      return {
        ...entry, accuracy,
        ballpark: /ballpark/i.test(entry.description),
        area: areaOf(entry.description, accuracyMatch),
        // PROJ 在描述行末尾标 "at least one grid missing"；格网名在 "Grid … not found" 行里。
        usable: entry.grids.length === 0 && !/at least one grid missing/i.test(entry.description),
      }
    })
  const chosenIndex = parsed.findIndex(entry => entry.usable) >= 0
    ? parsed.findIndex(entry => entry.usable)
    : parsed.findIndex(entry => entry.ballpark)   // 全缺格网时运行时退回 ballpark
  const chosen = parsed[chosenIndex >= 0 ? chosenIndex : 0]
  const projString = chosen?.projString ?? ""
  const candidates: DatumOperationCandidate[] = parsed.map(entry => ({
    description: entry.description, accuracy: entry.accuracy, ballpark: entry.ballpark, usable: entry.usable, missingGrids: entry.grids,
  }))
  return {
    from, to,
    kind: classifySteps(projString),
    description: chosen?.description ?? "（projinfo 没有给出任何候选运算）",
    accuracy: chosen?.accuracy ?? "unknown",
    area: chosen?.area ?? "",
    // 只报**选中这条**缺的格网：别的候选缺格网不等于这条运算不可用（逐候选事实在 candidates 里）。
    missingGrids: chosen?.grids ?? [],
    ballpark: chosen?.ballpark ?? false,
    usable: Boolean(chosen?.usable),
    selectedCandidate: chosenIndex >= 0 ? chosenIndex + 1 : 0,
    projString,
    candidateCount,
    candidates,
    execution: {
      engine: "cct",
      axisSwap: pipelineAxisSwap(projString),
      note: "数值由 cct 执行上面这条管线得出（反向用同一条管线的 cct -I，正反严格互逆）；管线两端若带 +proj=axisswap 步骤，说明该端是 CRS 的权威轴序，本工具按管线自报的轴序换列后进出，对外仍是经度/东距在前。",
    },
    dynamicFrame: /FRAMEEPOCH|DYNAMIC\[/.test(stdout),
    timeDependent: /\+t_epoch|\+rate_[a-z]+|\+proj=deformation/.test(projString),
  }
}

/**
 * 问 PROJ：从 `from` 到 `to` 会用哪条运算、精度多少、适用范围多大、缺不缺格网。
 * 查询口径对齐运行时：`--spatial-test intersects` + `--grid-check discard_missing`
 * （本机缺格网的候选直接不列，等价于运行时"实例化失败就跳过"），取排序第一条。
 */
export async function datumOperation(from: string, to: string, options: ProjRunOptions = {}): Promise<DatumOperation> {
  const base = ["-s", from, "-t", to, "--spatial-test", "intersects"]
  const stdout = await runProjCommand("projinfo", [...base, "--grid-check", "discard_missing"], "", options)
  const operation = parseDatumOperations(stdout, from, to)
  if (operation.candidates.length > 0) return operation
  // 一条可用候选都没有：运行时这时会退回 ballpark，所以按同样的顺序再问一次（不拿缺格网的管线去算）。
  const fallbackOut = await runProjCommand("projinfo", base, "", options)
  const fallback = parseDatumOperations(fallbackOut, from, to)
  if (fallback.candidates.length === 0) {
    const first = stdout.trim().split("\n").slice(0, 2).join(" / ").slice(0, 200)
    throw new Error(`MAP_PROJ_FAILED: projinfo -s ${from} -t ${to} 没有给出任何候选运算（输出：「${first}」）。可采取的动作：核对这两个 EPSG 代码；本工具不猜"大概能换算"，也不会退回自造算法。`)
  }
  return fallback
}

/**
 * 批量换算：**执行所报告的那条运算管线本身**（不是另跑一条等价命令）。
 * 方向只有两个：正向 = 来源 CRS → EPSG:4326；`inverse` = 用同一条管线的 `cct -I` 反算回来源 CRS。
 * 输入输出都是传统序（经度/东距在前，与 GeoJSON 及本仓其它经纬度数据一致），
 * 管线两端的权威轴序按 `operation.execution.axisSwap` 换列。
 * 输入固定给 4 列（x y 0 0）：实测 cct 对只给 2 列的投影管线会报 TRANSFORMATION ERROR，
 * 给全 x/y/z/t 四列才稳定；高程与时间不参与本工具的二维换算（z 恒 0，不是椭球高）。
 */
export async function transformCoordinates(operation: DatumOperation, points: ProjPair[], options: ProjRunOptions & { inverse?: boolean } = {}): Promise<ProjPair[]> {
  if (points.length === 0) return []
  const inverse = options.inverse === true
  const swap = operation.execution.axisSwap
  if (swap.unsupported) {
    throw new Error(`MAP_PROJ_FAILED: ${operation.from}→${operation.to} 的管线含本层不认识的轴置换步骤（${operation.projString.slice(0, 120)}），按错的列序换算会得到看着正常其实错位的坐标。可采取的动作：先用 pyproj/GDAL 完成这对 CRS 的换算，并把这条管线原文报告出来。`)
  }
  // 反向用同一条管线的 -I：两端角色对调，换列规则也跟着对调，因此正反严格互逆。
  const inputSwap = inverse ? swap.output : swap.input
  const outputSwap = inverse ? swap.input : swap.output
  const input = toStdin(points.map(point => {
    const [first, second] = inputSwap ? [point[1], point[0]] : [point[0], point[1]]
    return `${fixed(first)}\t${fixed(second)}\t0\t0`
  }))
  const stdout = await runProjCommand("cct", ["-d", "12", ...(inverse ? ["-I"] : []), ...operation.projString.split(" ")], input, options)
  const what = `cct ${inverse ? "-I " : ""}执行 ${operation.from}→${operation.to} 的管线（${operation.description.slice(0, 60)}）`
  return parseProjRows(stdout, points.length, 2, what).map(row => (outputSwap ? [row[1]!, row[0]!] : [row[0]!, row[1]!]) as ProjPair)
}

/** PROJ 命令行依赖状态（插件装配时记一条日志用；不是常驻健康检查，也不建库）。 */
export interface ProjStatus { available: boolean; version: string | null; binDir: string | null; error: string | null }

/** 探测五个实际依赖命令及 CRS 数据；只有 proj 版本可读不足以判定可用。 */
export async function projStatus(options: ProjRunOptions = {}): Promise<ProjStatus> {
  const binDir = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR ?? null
  try {
    const version = await projVersion(options)
    const probes: Array<{ name: ProjCommand; args: string[]; input: string }> = [
      { name: "proj", args: ["+proj=utm", "+zone=31", "+ellps=WGS84"], input: "3 0\n" },
      { name: "cct", args: ["+proj=pipeline", "+step", "+proj=unitconvert", "+xy_in=deg", "+xy_out=rad", "+step", "+proj=cart", "+ellps=WGS84"], input: "0 0 0 0\n" },
      { name: "geod", args: ["+ellps=WGS84", "-I"], input: "0 0 0 1\n" },
      { name: "projinfo", args: ["EPSG:4326", "-o", "PROJJSON"], input: "" },
      { name: "cs2cs", args: ["+proj=longlat", "+datum=WGS84", "+to", "+proj=utm", "+zone=31", "+datum=WGS84"], input: "3 0\n" },
    ]
    for (const probe of probes) {
      const stdout = await runProjCommand(probe.name, probe.args, probe.input, options)
      if (!stdout.trim()) throw new Error(`MAP_PROJ_FAILED: PROJ 依赖探测「${binaryPath(probe.name)}」未返回结果。${PROJ_INSTALL_ACTION}`)
    }
    return { available: true, version, binDir, error: null }
  }
  catch (error) { return { available: false, version: null, binDir, error: error instanceof Error ? error.message : String(error) } }
}

let versionCache: { binary: string; version: Promise<string> } | undefined

/** PROJ 版本（如 "PROJ 8.2.1"）：结果里如实带上引擎版本，便于回溯数值口径。 */
export async function projVersion(options: ProjRunOptions = {}): Promise<string> {
  const binary = binaryPath("proj")
  if (versionCache?.binary === binary) return await versionCache.version
  const probe = (async (): Promise<string> => {
    // 无参调用会打印版本到 stderr 并以 0 退出；这里不走 runProjCommand 的 stdout-only 口径。
    const outcome = await (options.runner ?? spawnProjProcess)({ argv: [binary], input: "", signal: options.signal })
    if (outcome.spawnError) {
      if (outcome.spawnError === "ENOENT") throw new Error(`MAP_PROJ_UNAVAILABLE: 找不到 PROJ 命令「${binary}」。${PROJ_INSTALL_ACTION}`)
      throw new Error(`MAP_PROJ_FAILED: 执行「${binary}」失败（${outcome.spawnError}）。${PROJ_INSTALL_ACTION}`)
    }
    const text = `${outcome.stdout}\n${outcome.stderr}`
    const matched = /Rel\.\s*([0-9][0-9.]*)/.exec(text)
    const version = matched ? `PROJ ${matched[1]}` : (text.trim().split("\n")[0] ?? "").trim()
    if (!version) throw new Error(`MAP_PROJ_FAILED: 无法识别 PROJ 版本（「${binary}」没有任何版本输出）。${PROJ_INSTALL_ACTION}`)
    return version
  })()
  versionCache = { binary, version: probe }
  try { return await probe }
  catch (error) { versionCache = undefined; throw error }   // 探测失败不缓存：换回正确的 bin 目录后要能重试
}
