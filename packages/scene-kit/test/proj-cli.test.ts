/**
 * PROJ 适配层的真实运行测试（直接调系统 PROJ，不经过模型、不经过网络）：
 *   · 引擎版本可报出（结果里会带上它，便于回溯数值口径）；
 *   · 批量调用逐点对应——特别是 cct"缺结尾换行会吞掉最后一行"这个真实坑；
 *   · 引擎缺失/输出对不上要**明确报错**，不许静默换算法或拿错位坐标继续；
 *   · **报告的操作就是执行的运算**（任务 92）：projinfo 选出的那条管线交给 cct 执行，
 *     与 cs2cs 独立换算逐点相同，且 cs2cs 用 PROJ_DEBUG=3 自报的运算名与报告一致；
 *   · 缺格网的管线在 cct 执行时**直接失败**（require-exact 的证据来自执行路线，不是候选名）；
 *   · 子进程是异步的（等待期间事件循环不被占住），取消会真的终止本次子进程；
 *   · 另外钉住 UTM 带边比例因子 1.00098、EPSG:4490↔4326 只有 ballpark/noop（unknown accuracy）。
 */
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  datumOperation, enuToWgs84, geodesicDistancesM, parseProjRows, projStatus, projVersion, runProjCommand, spawnProjProcess, transformCoordinates, wgs84ToEnu,
} from "../src/proj-cli.ts"

const anchor = { lon: 8.5417, lat: 47.3769, h: 0 }
const signal = new AbortController().signal

/** 独立口径：直接用 cs2cs 换算（不是被测实现的一部分），并取 PROJ 自报的运算名。 */
function cs2cs(from: string, to: string, point: [number, number]): { numbers: [number, number]; used: string } {
  const args = ["-f", "%.12f", from, "+to", to]
  const plain = spawnSync("cs2cs", args, { input: `${point[0]}\t${point[1]}\n`, encoding: "utf8" })
  const debugRun = spawnSync("cs2cs", args, { input: `${point[0]}\t${point[1]}\n`, encoding: "utf8", env: { ...process.env, PROJ_DEBUG: "3" } })
  const used = (debugRun.stderr ?? "").split("\n").map(line => line.trim()).find(line => /^Using coordinate operation /.test(line))
  return { numbers: (plain.stdout ?? "").trim().split(/\s+/).slice(0, 2).map(Number) as [number, number], used: used?.replace(/^Using coordinate operation /, "") ?? "" }
}

describe("PROJ 命令行适配层", () => {
  test("引擎版本可报出（结果里的 projection.version 就是它）", async () => {
    expect(await projVersion()).toMatch(/^PROJ \d+\.\d+/)
  })

  test("批量换算逐点对应：末点不能因缺结尾换行被吞（cct 的真实坑）", async () => {
    const points = [anchor, { lon: 8.6, lat: 47.4, h: 0 }, { lon: 8.5, lat: 47.3, h: 0 }]
    const enu = await wgs84ToEnu(anchor, points, { signal })
    expect(enu.length).toBe(3)
    // 锚点自己是原点（三个点都被换算过，不是只剩前两个）
    expect(Math.hypot(enu[0]![0], enu[0]![1], enu[0]![2])).toBeLessThan(1e-3)
    const back = await enuToWgs84(anchor, enu, { signal })
    for (const [index, point] of points.entries()) {
      expect(Math.abs(back[index]!.lon - point.lon)).toBeLessThan(1e-9)
      expect(Math.abs(back[index]!.lat - point.lat)).toBeLessThan(1e-9)
    }
  })

  test("UTM→WGS84 批量换算：末点同样在（报告操作 = 执行运算这条路线）", async () => {
    const operation = await datumOperation("EPSG:32633", "EPSG:4326", { signal })
    const geodetic = await transformCoordinates(operation, [[500000, 5247049.02], [500100, 5247049.02]], { signal })
    expect(geodetic.length).toBe(2)
    expect(geodetic[0]![0]).toBeCloseTo(15, 6)
    expect(geodetic[1]![0]).toBeGreaterThan(15)
  })

  test("PROJ 缺失时明确报 MAP_PROJ_UNAVAILABLE，不退回自造算法", async () => {
    // 先把这条运算问出来（换了 bin 目录之后 projinfo 也会报 MAP_PROJ_UNAVAILABLE，那是另一条断言）
    const operation = await datumOperation("EPSG:32633", "EPSG:4326", { signal })
    const previous = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
    process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = "/nonexistent-proj-bin"
    try {
      await expect(transformCoordinates(operation, [[500000, 5247049]], { signal })).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
      await expect(wgs84ToEnu(anchor, [anchor], { signal })).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
      await expect(enuToWgs84(anchor, [[0, 0, 0]], { signal })).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
      await expect(geodesicDistancesM(anchor, [{ lon: 8.6, lat: 47.3, h: 0 }], { signal })).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
      await expect(projVersion()).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
    } finally {
      if (previous === undefined) delete process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
      else process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = previous
    }
  })

  test("输出行数与输入点数不一致就报错（不拿错位坐标继续建模）", () => {
    expect(() => parseProjRows("1 2\n", 2, 2, "测试用换算")).toThrow(/MAP_PROJ_FAILED/)
    // PROJ 对非法输入会照常输出甚至回显原文：这种行必须被识别成不可解析
    expect(() => parseProjRows("junk text\n", 1, 2, "测试用换算")).toThrow(/MAP_PROJ_FAILED/)
  })

  test("比例因子用 PROJ 自己的 -S 实测：UTM 带边 1.00098、中央经线 0.9996", async () => {
    const stdout = await runProjCommand("proj", ["-S", "+proj=utm", "+zone=32", "+ellps=WGS84"], "6 0\n9 0\n12 0\n", { signal })
    const k = stdout.trim().split("\n").map(line => Number(/<([0-9.]+)/.exec(line.trim())?.[1]))
    expect(k.length).toBe(3)
    expect(k[1]).toBeCloseTo(0.9996, 6)      // 中央经线 9°
    expect(k[0]).toBeCloseTo(1.00098, 5)     // 带西边缘 6°
    expect(k[2]).toBeCloseTo(1.00098, 5)     // 带东边缘 12°
    // 带边缘是 +0.098%，不是 0.02%：这条断言就是上一轮审查纠正的口径
    expect((k[0]! - 1) * 100).toBeCloseTo(0.098, 3)
  })

  test("EPSG:4490↔WGS84 在 PROJ 里只有 ballpark/noop（unknown accuracy）：无基准变换可依", async () => {
    const info = await runProjCommand("projinfo", ["-s", "EPSG:4490", "-t", "EPSG:4326"], "", { signal })
    expect(info).toContain("Ballpark")
    expect(info).toContain("unknown accuracy")
    expect(info).toContain("+proj=noop")
    // 因此"椭球差在毫米级所以等价"这种说法不成立：本工具只如实说明"未做基准变换"。
  })
})

/**
 * 异步子进程与取消（任务 92 的第二条）：
 * 等待期间事件循环必须能跑别的活（同进程其它会话不被挡住），abort 必须真的终止本次子进程。
 */
describe("PROJ 子进程：异步等待与取消", () => {
  test("等待期间事件循环是自由的（同一进程里的计时器照常推进）", async () => {
    // 2090 个点的批量换算（实测约 50 ms 量级）：spawnSync 时代这段时间计时器一次都跑不上
    const points: [number, number][] = Array.from({ length: 2090 }, (_item, index) => [500000 + (index % 500), 5247000 + (index % 300)] as [number, number])
    const operation = await datumOperation("EPSG:32632", "EPSG:4326")
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    const started = Date.now()
    const rows = await transformCoordinates(operation, points, { signal })
    clearInterval(timer)
    expect(rows.length).toBe(points.length)
    // 同步实现下 ticks 是 0（实测），异步实现在同一窗口里应当跑上几十次；这里只要求"确实跑过"
    expect(ticks).toBeGreaterThanOrEqual(3)
    expect(Date.now() - started).toBeLessThan(10000)
  })

  test("取消：等待中被 abort 会终止本次子进程（不是只在调用前后各查一次信号）", async () => {
    const controller = new AbortController()
    // 用 sleep 造一个"确定要跑 30 秒"的子进程，只验证执行器的取消语义
    const started = Date.now()
    const running = spawnProjProcess({ argv: ["sleep", "30"], input: "", signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const outcome = await running
    expect(Date.now() - started).toBeLessThan(5000)                       // 30 s 的进程被真的杀掉了
    expect(outcome.exitCode === null || outcome.signal !== null).toBe(true) // 由信号终止，不是自然退出
    expect(outcome.signal).toBe("SIGTERM")
  })

  test("已取消的信号：runProjCommand 抛取消原因（不写成 PROJ 失败）", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runProjCommand("proj", ["-S", "+proj=utm", "+zone=32", "+ellps=WGS84"], "6 0\n", { signal: controller.signal })).rejects.toThrow(/abort/i)
  })
})

/**
 * 基准运算事实（`projinfo`）的解析：投影 / 基准 / 历元 / 垂直基准要能分开报，
 * 尤其是"缺格网"与"ballpark"这两种不可靠状态必须被读出来（策略层据此拒绝）。
 */
describe("projinfo 事实解析：这对 CRS 之间 PROJ 实际用什么运算", () => {
  test("声明上是同一基准（4326→4326）与纯投影（UTM→4326）：noop / projection，精度 0 m", async () => {
    const identity = await datumOperation("EPSG:4326", "EPSG:4326", { signal })
    expect(identity.kind).toBe("noop")
    expect(identity.accuracy).toBe("0 m")
    expect(identity.ballpark).toBe(false)
    expect(identity.usable).toBe(true)
    expect(identity.dynamicFrame).toBe(false)
    const utm = await datumOperation("EPSG:32632", "EPSG:4326", { signal })
    expect(utm.kind).toBe("projection")
    expect(utm.accuracy).toBe("0 m")
    expect(utm.area).toContain("6°E")           // PROJ 自报的适用范围（32 带）
    expect(utm.candidateCount).toBe(1)
    expect(utm.projString).toContain("+proj=utm")
  })

  test("ballpark（4490）与动态框架（ITRF2008=EPSG:8999）都能被认出来", async () => {
    const cgcs = await datumOperation("EPSG:4490", "EPSG:4326", { signal })
    expect(cgcs.ballpark).toBe(true)
    expect(cgcs.accuracy).toBe("unknown accuracy")
    expect(cgcs.kind).toBe("noop")               // PROJ 对该对 CRS 给的管线就是 +proj=noop
    expect(cgcs.description).toContain("Ballpark geographic offset")
    const itrf = await datumOperation("EPSG:8999", "EPSG:4326", { signal })
    expect(itrf.dynamicFrame).toBe(true)         // 来源 WKT 里有 FRAMEEPOCH：基准随历元变化
  })

  /**
   * 任务 92 收口的那条：候选里有缺格网的项，但 PROJ 的首选是一条**不需要格网、本机可用**的运算，
   * 报告必须报这条、执行也必须执行这条——不能因为别的候选缺格网就把可用运算判成不可用，
   * 也不能把"缺格网的候选"当成实际执行的操作。
   */
  test("缺格网的候选不影响已选中且可用的运算：报告的操作 = cs2cs 实际执行的操作", async () => {
    const osgb = await datumOperation("EPSG:27700", "EPSG:4326", { signal })
    // 首选：OSGB36→WGS84 (6) 的 2 m 七参数（不需要 OSTN15 格网）
    expect(osgb.selectedCandidate).toBe(1)
    expect(osgb.kind).toBe("datum")
    expect(osgb.accuracy).toBe("2 m")
    expect(osgb.ballpark).toBe(false)
    expect(osgb.usable).toBe(true)
    expect(osgb.missingGrids).toEqual([])
    // 候选列表本身就是"本机可用的那些"（--grid-check discard_missing）：缺格网的候选不出现在这里，
    // 它只可能出现在不过滤的列表里（下面"缺格网的管线执行时直接失败"那条会用到）。
    expect(osgb.candidates.every(candidate => candidate.missingGrids.length === 0)).toBe(true)
    expect(osgb.candidateCount).toBeGreaterThanOrEqual(osgb.candidates.length)
    expect(osgb.candidateCount).toBeGreaterThan(1)       // 这对 CRS 候选不止一条（不是只有 ballpark 兜底）

    // 数值路线与 cs2cs 独立换算逐点相同，且 cs2cs 自报的运算名就在报告的描述里
    const independent = cs2cs("+init=epsg:27700", "+init=epsg:4326", [530000, 180000])
    const mine = (await transformCoordinates(osgb, [[530000, 180000]], { signal }))[0]!
    expect(Math.max(Math.abs(mine[0] - independent.numbers[0]), Math.abs(mine[1] - independent.numbers[1]))).toBeLessThan(1e-9)
    expect(independent.used).toContain("British National Grid")
    expect(osgb.description).toContain("OSGB36 to WGS 84 (6)")

    // 反例：瑞士 LV95（2056）的 7 参数变换同样不依赖格网，PROJ 给出带精度（1 m）的 datum 运算
    const lv95 = await datumOperation("EPSG:2056", "EPSG:4326", { signal })
    expect(lv95.kind).toBe("datum")
    expect(lv95.accuracy).toBe("1 m")
    expect(lv95.missingGrids).toEqual([])
    expect(lv95.candidates[0]!.usable).toBe(true)
  })

  /**
   * require-exact 的证据来自执行路线：缺格网的管线交给 cct 会**直接失败**（PROJ Error 1029），
   * 不会像 cs2cs 那样静默退回 ballpark 数值。管线原文取自 projinfo 自己的候选（不是手写的）。
   */
  test("缺格网的管线执行时直接失败，不会静默改用别的运算", async () => {
    // 默认调用（不过滤缺格网）里挑出第一条缺格网的候选，取它的管线原文
    const raw = await runProjCommand("projinfo", ["-s", "EPSG:27700", "-t", "EPSG:4326", "--spatial-test", "intersects", "-o", "PROJ"], "", { signal })
    const blocks = raw.split(/\n\s*-{5,}\s*\n/).filter(block => /PROJ string:/.test(block))
    const pipelineOf = (block: string): string => {
      const lines = block.split("\n").map(line => line.trim())
      const start = lines.indexOf("PROJ string:")
      const out: string[] = []
      for (let index = start + 1; start >= 0 && index < lines.length; index++) {
        const line = lines[index]!
        if (!line) { if (out.length) break; else continue }
        if (/^(WKT2|WKT|Grid|Note)/.test(line)) break
        out.push(line)
      }
      return out.join(" ").trim()
    }
    const gridOne = blocks.find(block => /Grid \S+ needed but not found/.test(block))!
    expect(gridOne).toContain("uk_os_OSTN15_NTv2_OSGBtoETRS.tif")
    const operation = {
      from: "EPSG:27700", to: "EPSG:4326", kind: "grid" as const, description: "（测试：PROJ 列出的缺格网候选）",
      accuracy: "1 m", area: "", missingGrids: [{ name: "uk_os_OSTN15_NTv2_OSGBtoETRS.tif", url: null }],
      ballpark: false, usable: false, selectedCandidate: 1, candidateCount: 1, candidates: [],
      projString: pipelineOf(gridOne), execution: { engine: "cct" as const, axisSwap: { input: false, output: true, unsupported: false }, note: "" },
      dynamicFrame: false, timeDependent: false,
    }
    const failure = await transformCoordinates(operation, [[530000, 180000]], { signal }).then(() => null, (error: Error) => error)
    expect(failure?.message).toContain("MAP_PROJ_FAILED")
    expect(failure?.message).toContain("uk_os_OSTN15_NTv2_OSGBtoETRS.tif")
    expect(failure?.message).toContain("格网")   // 失败动作指向"装格网"，不是笼统的坐标越界
  })

  /**
   * 这条钉的是"为什么必须有策略层"：格网缺失时 cs2cs **照常退出 0 并返回经纬度**，
   * 所以只看"命令成功"根本发现不了自己拿到的是回退来的数值。
   */
  test("缺格网时 cs2cs 仍然成功返回数值——所以不能拿「命令通过」当换算成立的证据", async () => {
    const stdout = await runProjCommand("cs2cs", ["-f", "%.9f", "+init=epsg:27700", "+to", "+init=epsg:4326"], "530000 180000\n", { signal })
    const row = parseProjRows(stdout, 1, 2, "27700→4326（缺格网）")
    expect(row[0]![0]).toBeCloseTo(-0.128, 2)     // 伦敦附近的经度：数值看起来完全合理
    expect(row[0]![1]).toBeCloseTo(51.504, 2)
    // cs2cs 成功 ≠ 用的是带精度的运算：PROJ 自己说它用的是哪条（PROJ_DEBUG=3）
    const independent = cs2cs("+init=epsg:27700", "+init=epsg:4326", [530000, 180000])
    expect(independent.used.length).toBeGreaterThan(0)
    // 而报告层给出的 27700 运算不需要格网（2 m 七参数）——两条路线因此必须指向同一条运算（上面已逐点钉住）
  })

  test("projStatus：可用时报出真实版本；binDir 指错时返回原因而不是抛错（装配可继续）", async () => {
    const available = await projStatus()
    expect(available.available).toBe(true)
    expect(available.version).toMatch(/^PROJ \d+\.\d+/)
    const previous = process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
    process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = "/nonexistent-proj-bin"
    try {
      const missing = await projStatus()
      expect(missing.available).toBe(false)
      expect(missing.version).toBe(null)
      expect(missing.binDir).toBe("/nonexistent-proj-bin")
      expect(missing.error).toContain("MAP_PROJ_UNAVAILABLE")
      expect(missing.error).toContain("apt install proj-bin")   // 状态里带可执行动作
      // 缺 PROJ 时 projinfo 也照样明确报错（不是返回空事实）
      await expect(datumOperation("EPSG:4326", "EPSG:4326", { signal })).rejects.toThrow(/MAP_PROJ_UNAVAILABLE/)
    } finally {
      if (previous === undefined) delete process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR
      else process.env.MAP_CONSTRAINTS_PROJ_BIN_DIR = previous
    }
  })

  test("projStatus：实际检查全部五命令，不以版本输出代替完整依赖", async () => {
    const invoked = new Set<string>()
    const status = await projStatus({ runner: async ({ argv }) => {
      const name = argv[0]!.split(/[\\/]/).at(-1)!
      invoked.add(name)
      return { stdout: argv.length === 1 ? "" : "依赖探测结果\n", stderr: "Rel. 8.2.1\n", exitCode: 0, signal: null, spawnError: null }
    } })
    expect(status.available).toBe(true)
    expect([...invoked].sort()).toEqual(["cct", "cs2cs", "geod", "proj", "projinfo"])
  })

  test("projStatus：任一辅助命令缺失或数据读取失败均不可用", async () => {
    for (const missing of ["cct", "geod", "projinfo", "cs2cs"]) {
      const status = await projStatus({ runner: async ({ argv }) => {
        const name = argv[0]!.split(/[\\/]/).at(-1)!
        return { stdout: "依赖探测结果\n", stderr: "Rel. 8.2.1\n", exitCode: name === missing ? null : 0, signal: null, spawnError: name === missing ? "ENOENT" : null }
      } })
      expect(status.available).toBe(false)
      expect(status.version).toBe(null)
      expect(status.error).toContain("MAP_PROJ_UNAVAILABLE")
      expect(status.error).toContain(missing)
    }
    const brokenData = await projStatus({ runner: async ({ argv }) => ({
      stdout: "依赖探测结果\n", stderr: "proj.db not found", exitCode: argv[0]!.endsWith("projinfo") ? 1 : 0, signal: null, spawnError: null,
    }) })
    expect(brokenData.available).toBe(false)
    expect(brokenData.error).toContain("MAP_PROJ_FAILED")
    expect(brokenData.error).toContain("proj.db not found")
  })
})
