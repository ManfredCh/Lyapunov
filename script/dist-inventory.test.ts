/**
 * dist-inventory 用例 —— 钉住四件事：
 *  1. "盘点看得见 `packages/` 之外的输入"，并给出**负对照**：把输入面还原成旧口径（只看
 *     `packages/<pkg>/src/**`）时，同一个产物必须重新变成"看不见"；
 *  2. **第 9 类**：构建期读取的 `packages/<pkg>/package.json`（`name` → `client.js` 的 ModuleLoader
 *     wrapper id，也决定 `node_modules/<name>` 软链目标 = 解析面）—— 旧口径看不见，"只走模块解析"的
 *     resolved 原本也看不见（它不是 import）；本工具把它显式并进输入面（kind = `package-meta`）；
 *  3. **mtime 判据只看 mtime、不看字节**（结构性抖）：注入 mtime 就能把它翻红，而产物一个字节没动；
 *  4. 构建计划与磁盘产物必须互相解释（DRIFT / MISSING / UNEXPLAINED）—— 其中 **UNEXPLAINED 判据本体由
 *     `unexplainedAgainstPlan` 纯函数承载**，并用**合成列表 + 合成树**做负对照：磁盘上多一个计划外的
 *     产物就必须被报出来（判据不许退化成"跟着现状走"，也不许给某条已知路径开白名单）。
 *
 * 判据不依赖工作树的当前 mtime（树上有并行 lane 在写）：用注入的 mtime 让"输入比产物新"这件事确定发生。
 *
 * 时间预算（2026-09-27 修）：全量 `scan` 要走 53 个产物的输入闭包（忙碌时单次 2–3s，两条重活曾到
 * 4802ms / 5336ms 而 bun:test 默认 5s 超时 ⇒ 出过 `this test timed out after 5000ms` 的假红）。
 * 两条处置，**都不动判据、都不 skip**：
 *  - `sharedScan`：同一 (口径, 注入方式) 在同一次测试进程里只扫一次（= 验收建议的"合并 scan"）；
 *  - 重活用例显式 `timeout`（`HEAVY`），免得把"别的 lane 在忙"计成失败。
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { derivePlan, diskArtifacts, extractSpecifiers, inputClosure, maskComments, scan, unexplainedAgainstPlan, exactRebuild, type ScanResult, type Scope } from "./dist-inventory.ts"

const root = resolve(import.meta.dirname, "..")
const desktopArtifact = "packages/desktop/dist/main.js"
/** 重活用例的显式超时：不是"改判据"，是不让 bun:test 的 5s 默认值把负载当成失败 */
const HEAVY = 30_000

/** 完全受控的输入时间线：产物保留真实mtime/字节，普通输入统一早于产物、script输入晚于全部产物。 */
const scriptPushed = (days: number) => {
  const outputs = new Set(derivePlan(root).targets.map(target=>target.output).filter(existsSync))
  const times = [...outputs].map(path=>statSync(path).mtimeMs)
  const before = Math.min(...times)-1, after = Math.max(...times)+days*86400_000
  return (path:string):number=>outputs.has(path)?statSync(path).mtimeMs:path.startsWith(join(root,"script")+"/")?after:before
}

/** 注入 mtime：只把 `packages/<pkg>/package.json`（第 9 类：构建期读取的元数据）推到**所有产物之后**。
 *  不能只推"一天"：`packages/viewer/package.json` 的真实 mtime 是 09-18，而产物是 09-26 ⇒ 推一天仍在产物之前。 */
const PUSH_DAYS = 30
const packageJsonPushed = (days: number) => (path: string): number =>
  statSync(path).mtimeMs + (path.startsWith(join(root, "packages") + "/") && basename(path) === "package.json" ? days * 86400_000 : 0)

/**
 * 共享 scan（= "合并 scan"）：同一 `(口径, 注入方式)` 在一次测试进程里只走一次全量闭包。
 * 用例只读结果、不改结果；共享不改变任何判据，只是不再对同一棵树的同一读数重复计算。
 */
type Inject = "real" | "script-pushed" | "pkgjson-pushed"
const scanCache = new Map<string, Promise<ScanResult>>()
const sharedScan = (scope: Scope, inject: Inject = "real"): Promise<ScanResult> => {
  const key = `${scope}:${inject}`
  let hit = scanCache.get(key)
  if (!hit) {
    const mtime = inject === "script-pushed" ? scriptPushed(PUSH_DAYS) : inject === "pkgjson-pushed" ? packageJsonPushed(PUSH_DAYS) : undefined
    hit = scan(root, scope, mtime)
    scanCache.set(key, hit)
  }
  return hit
}

const sha256 = (p: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex")

describe("模块解析：盘点看得见 packages/ 之外的输入", () => {
  test("desktop/dist/main.js 的闭包里有 script/** 与跨包输入", () => {
    const target = derivePlan(root).targets.find(t => t.output.endsWith(desktopArtifact))
    expect(target).toBeDefined()
    const { inputs } = inputClosure(target!, { root, scope: "resolved" })
    const rel = inputs.map(i => i.path.slice(root.length + 1))
    // 入口 `packages/desktop/src/main.ts:9` import ../../../script/host.ts，host.ts 再内联 runtime-patch/engine-preference
    expect(rel).toContain("script/host.ts")
    expect(rel).toContain("script/runtime-patch.ts")
    expect(rel).toContain("script/engine-preference.ts")
    expect(rel.filter(p => p.startsWith("script/")).length).toBeGreaterThanOrEqual(6)
    // 跨包内联：script/engine-preference.ts 引 lyapunov-shell/src/environment-readiness.ts
    expect(rel).toContain("packages/lyapunov-shell/src/environment-readiness.ts")
    // external 是叶：electron / three 不该进闭包
    expect(rel.some(p => p.includes("node_modules/electron/"))).toBe(false)
    expect(rel.some(p => p.includes("node_modules/three/"))).toBe(false)
  }, HEAVY)

  test("旧口径（legacy）看不见任何 script/** 输入 —— 这就是盲区本身", () => {
    const target = derivePlan(root).targets.find(t => t.output.endsWith(desktopArtifact))!
    const { inputs } = inputClosure(target, { root, scope: "legacy" })
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every(i => i.kind === "package-src" && i.pkg === "desktop")).toBe(true)
    expect(inputs.some(i => i.path.includes("/script/"))).toBe(false)
  }, HEAVY)

  test("脚本入口不会被当成文字里的假依赖：注释与 import type 都不算", () => {
    const src = [
      '// import { fake } from "./in-comment.ts"',
      '/* export { alsoFake } from "./in-block-comment.ts" */',
      'import type { T } from "./types-only.ts"',
      'import { real } from "./real.ts"',
      'const lazy = await import("./lazy.ts")',
      'const worker = new URL("./worker.py", import.meta.url)',
    ].join("\n")
    const specs = extractSpecifiers(src, "x.ts").value
    expect(specs).toContain("./real.ts")
    expect(specs).toContain("./lazy.ts")
    expect(specs).toContain("./worker.py")
    expect(specs).not.toContain("./types-only.ts")
    expect(specs).not.toContain("./in-comment.ts")
    expect(specs).not.toContain("./in-block-comment.ts")
    expect(maskComments('const a = 1 // import {x} from "./c.ts"')).not.toContain("./c.ts")
  })
})

describe("⭐ 负对照：还原口径 ⇒ 盲区重现", () => {
  test("注入'输入比产物新'后：resolved 报 STALE，legacy 报 ok（同一个产物、同一份 mtime）", async () => {
    const [resolved, legacy] = await Promise.all([sharedScan("resolved", "script-pushed"), sharedScan("legacy", "script-pushed")])
    const a = resolved.artifacts.find(x => x.rel === desktopArtifact)!
    const b = legacy.artifacts.find(x => x.rel === desktopArtifact)!
    // 修正后的口径：看得见 script/** ⇒ 该产物陈旧，且成因是一条 script/** 输入
    expect(a.verdict).toBe("STALE")
    expect(a.contributors.some(c => c.path.startsWith(join(root, "script") + "/"))).toBe(true)
    expect(a.invisibleContributors.length).toBeGreaterThan(0)
    // 还原旧口径：同样的产物被判"不陈旧" ⇒ 盲区精确重现
    expect(b.verdict).toBe("ok")
  }, HEAVY)

  test("两个口径下产物清单相同 —— 差别只在输入面，不在产物面", async () => {
    const [resolved, legacy] = await Promise.all([sharedScan("resolved"), sharedScan("legacy")])
    expect(resolved.artifacts.map(x => x.rel)).toEqual(legacy.artifacts.map(x => x.rel))
    expect(resolved.planSize).toBe(legacy.planSize)
  }, HEAVY)

  test("mtime 判据只看 mtime、不看字节：注入 mtime 就翻红，而产物 mtime/sha256 都没动", async () => {
    const out = join(root, desktopArtifact)
    const [real, pushed] = await Promise.all([sharedScan("resolved"), sharedScan("resolved", "script-pushed")])
    const shaBefore = sha256(out)
    const mtimeBefore = statSync(out).mtimeMs
    const a = real.artifacts.find(x => x.rel === desktopArtifact)!
    const b = pushed.artifacts.find(x => x.rel === desktopArtifact)!
    expect(b.verdict).toBe("STALE")                  // 只把输入的 mtime 推后 ⇒ 红
    expect(a.outputMtimeMs).toBe(mtimeBefore)        // 产物自己没被写过
    expect(b.outputMtimeMs).toBe(mtimeBefore)
    expect(sha256(out)).toBe(shaBefore)              // 零字节变化
    // ⇒ "mtime 红" 与 "产物落后" 不是同一件事：`--exact`（只读字节、签名里没有 mtime）才是可持续的判据。
  }, HEAVY)
})

describe("第 9 类：构建期读取的元数据（package.json 的 name）", () => {
  const clientArtifact = "packages/viewer/dist/client.js"

  test("client 产物的输入面含 package.json（构建期读；旧口径结构性看不见）", () => {
    const target = derivePlan(root).targets.find(t => t.output.endsWith(clientArtifact))
    expect(target).toBeDefined()
    const resolved = inputClosure(target!, { root, scope: "resolved" })
    const meta = resolved.inputs.filter(i => basename(i.path) === "package.json")
    expect(meta.map(i => i.path.slice(root.length + 1))).toEqual(["packages/viewer/package.json"])
    expect(meta[0]!.kind).toBe("package-meta")
    // 旧口径：`packages/<pkg>/package.json` 不在 `src/**` 下 ⇒ 结构性看不见（这就是第 9 类的盲区）
    const legacy = inputClosure(target!, { root, scope: "legacy" })
    expect(legacy.inputs.some(i => basename(i.path) === "package.json")).toBe(false)
  }, HEAVY)

  test("wrapper id 逐字等于 package.json 的 name ⇒ 改 name 就改产物字节（只有 --exact 看得见）", () => {
    const names = ["viewer", "lyapunov-shell", "lyapunov-workspace", "lyapunov-session-undo"]
    for (const name of names) {
      const pkg = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as { name: string }
      const id = /__ModuleLoader__\.load\(\{id:("(?:[^"\\]|\\.)*")/.exec(
        readFileSync(join(root, "packages", name, "dist/client.js"), "utf8"),
      )?.[1]
      expect(id, `packages/${name}/dist/client.js 缺少 ModuleLoader id`).toBeTruthy()
      expect(JSON.parse(id!)).toBe(pkg.name)
    }
  })

  test("⭐ 负对照：只推后 package.json 的 mtime（+30 天）⇒ resolved 报 STALE（成因是第 9 类），旧口径判定逐项不变", async () => {
    const pushed = await sharedScan("resolved", "pkgjson-pushed")
    const a = pushed.artifacts.find(x => x.rel === clientArtifact)!
    expect(a.verdict).toBe("STALE")
    expect(a.contributors.filter(c => c.kind === "package-meta").map(c => c.path.slice(root.length + 1)))
      .toEqual(["packages/viewer/package.json"])
    // 旧口径对这类注入**完全无感**（package.json 不在它的输入面里）⇒ 与"真实 mtime"的旧口径读数逐项相同
    const [legacyReal, legacyPushed] = await Promise.all([sharedScan("legacy"), sharedScan("legacy", "pkgjson-pushed")])
    const shape = (r: ScanResult) => r.artifacts.map(x => [x.rel, x.verdict, x.inputCount])
    expect(shape(legacyPushed)).toEqual(shape(legacyReal))
  }, HEAVY)
})

describe("构建计划与磁盘产物必须互相解释（覆盖校验）", () => {
  test("计划条目来自构建脚本，且没有解析不出来的入口（DRIFT=0）", () => {
    const plan = derivePlan(root)
    expect(plan.drift).toEqual([])
    expect(plan.targets.length).toBeGreaterThanOrEqual(50)
    // desktop主屏三个入口由build-desktop表导出；plugin/client等由真实plugin builder另行声明。
    const desktopOutputs = plan.targets.filter(t => t.output.includes("/packages/desktop/") && t.origin === "script/build-desktop.ts").map(t => t.output.slice(root.length + 1)).sort()
    expect(desktopOutputs).toEqual([
      "packages/desktop/dist/main.js",
      "packages/desktop/dist/preload.cjs",
      "packages/desktop/renderer/account.js",
    ])
  }, HEAVY)

  test("磁盘上的产物都被计划解释（历史孤儿已清零；谁把它搬回来，这条就红）", async () => {
    const result = await sharedScan("resolved")
    expect(result.missingTargets).toEqual([])
    // 2026-09-17「本机没有可用 bun、改用 tsc」那次**手工同步进 `dist/`** 的旧布局残留
    // （`packages/sim-mujoco/dist/worker.py`，与 git `8f6efa0` 的 `python/worker.py` 逐字节相同）
    // 已于 2026-09-27 00:38–00:44 被删除 ⇒ 真实树上的 `unexplained` 必须**为空**。
    //
    // 这里**不**给那条路径开白名单（`filter(u => u !== KNOWN_LEGACY_ORPHAN)` 那种写法等于把
    // "同一成因复发"放行：本 bug 的成因正是"再手工同步一份进 dist/"，而构建计划永远不会产出它）。
    // 判据的强度由下面两组**负对照**守着：`unexplainedAgainstPlan` 的合成列表，以及合成树里的真盘遍历。
    // 见 `bugfixHistory/UNEXPLAINED-GUARD-AND-DEADWEIGHT-20260926.md`。
    expect(result.unexplained).toEqual([])
    // 接线守卫：`scan` 的 `unexplained` 必须逐字等于"磁盘产物 − 计划条目"这一条纯函数的结果
    // （谁把 scan 改成"过滤掉某条已知路径"或另写一套判据，这一格立刻红）
    const planned = derivePlan(root).targets.map(t => t.output)
    expect(result.unexplained).toEqual(unexplainedAgainstPlan(diskArtifacts(root), planned).map(p => p.slice(root.length + 1)))
    // 单向钉子：那条孤儿一旦重新出现在磁盘上，这里立刻红（不依赖它"是否被计划解释"）
    expect(diskArtifacts(root).some(p => p.endsWith("/packages/sim-mujoco/dist/worker.py"))).toBe(false)
  }, HEAVY)
})

describe("⭐ UNEXPLAINED 判据的负对照：磁盘上多一个计划外的产物，必须被报出来", () => {
  test("纯函数：计划外产物逐条报出，计划内产物一个不报", () => {
    const planned = ["/r/packages/a/dist/planned.js"]
    const disk = ["/r/packages/a/dist/planned.js", "/r/packages/a/dist/orphan-old.py", "/r/packages/a/dist/sub/deep.bin"]
    expect(unexplainedAgainstPlan(disk, planned)).toEqual([
      "/r/packages/a/dist/orphan-old.py",
      "/r/packages/a/dist/sub/deep.bin",
    ])
  })

  test("纯函数：磁盘 ⊆ 计划 ⇒ 空（这是真实树现在的状态，不是判据的退化）", () => {
    expect(unexplainedAgainstPlan(["/r/a", "/r/b"], ["/r/b", "/r/a", "/r/c"])).toEqual([])
    expect(unexplainedAgainstPlan([], ["/r/a"])).toEqual([])
  })

  test("纯函数：同名不同目录不算互相解释（比的是全路径，不是 basename）", () => {
    // 这正是那条孤儿的两侧：`dist/worker.py`（死）与 `python/worker.py`（活）同名
    expect(unexplainedAgainstPlan(["/r/packages/a/dist/worker.py"], ["/r/packages/a/python/worker.py"]))
      .toEqual(["/r/packages/a/dist/worker.py"])
  })

  test("纯函数：重复项去重、顺序稳定（判据与遍历顺序无关）", () => {
    expect(unexplainedAgainstPlan(["/r/z", "/r/a", "/r/z"], [])).toEqual(["/r/a", "/r/z"])
  })

  test("真盘这一侧：合成根里多放的产物必须被抓到（`.pyc` / `__pycache__` 按既有口径排除）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "dist-inventory-unexplained-"))
    try {
      mkdirSync(join(tmp, "packages/ghost/dist/__pycache__"), { recursive: true })
      mkdirSync(join(tmp, "packages/ghost/dist/sub"), { recursive: true })
      mkdirSync(join(tmp, "packages/other"), { recursive: true })          // 没有 dist/ ⇒ 不参与
      writeFileSync(join(tmp, "packages/ghost/dist/keep.js"), "")
      writeFileSync(join(tmp, "packages/ghost/dist/orphan.py"), "")
      writeFileSync(join(tmp, "packages/ghost/dist/sub/deep.bin"), "")
      writeFileSync(join(tmp, "packages/ghost/dist/__pycache__/x.pyc"), "")
      const disk = diskArtifacts(tmp)
      // ① 磁盘侧真的把三个文件读进来了，且 .pyc / __pycache__ 不进清单
      expect(disk.map(p => p.slice(tmp.length + 1))).toEqual([
        "packages/ghost/dist/keep.js",
        "packages/ghost/dist/orphan.py",
        "packages/ghost/dist/sub/deep.bin",
      ])
      // ② 相减：计划解释不了的那两个被报出来（磁盘侧 + 纯函数，端到端）
      expect(unexplainedAgainstPlan(disk, [join(tmp, "packages/ghost/dist/keep.js")])).toEqual([
        join(tmp, "packages/ghost/dist/orphan.py"),
        join(tmp, "packages/ghost/dist/sub/deep.bin"),
      ])
      // ③ 负对照的另一半（防"恒真"）：把两个计划外补进计划 ⇒ 立刻归零
      expect(unexplainedAgainstPlan(disk, disk)).toEqual([])
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  /**
   * 端到端负对照：**合成一棵最小根**（含一个与真脚本同形的 `script/build-plugins.ts`），
   * 让真 `scan` 去推计划、读磁盘、做相减。
   *
   * 为什么值得单独做：`scan`/`derivePlan` 都从 root 现推计划，所以"在真树上放一个假产物"这条
   * 走近路走不通（真树不在本用例的写入域），而只在纯函数上断言又漏掉两件事 ——
   * ① `scan` 是否真的用这条判据（而不是自己另写一套、或给某条已知路径开白名单）；
   * ② `diskArtifacts` 是否真的把计划外的文件读进来。合成根补上这两件事：计划侧两条
   * （`Bun.build` 的 `plugin.js`、`src/*.py → dist` 的 `tool.py` 副本）必须被解释，
   * 磁盘上多出来的 `orphan.py` 必须被报出来。
   */
  const syntheticRoot = (): string => {
    const tmp = mkdtempSync(join(tmpdir(), "dist-inventory-plan-"))
    const w = (rel: string, body = "") => { mkdirSync(join(tmp, join(rel, "..")), { recursive: true }); writeFileSync(join(tmp, rel), body) }
    w("script/build-plugins.ts", [
      'import { readdir, copyFile } from "node:fs/promises"',
      'import { join } from "node:path"',
      "export async function buildPlugins(root: string, packages: string[]) {",
      "  for (const name of packages) {",
      '    const dir = join(root, "packages", name)',
      '    await Bun.build({ entrypoints: [join(dir, "src/plugin.ts")], outdir: join(dir, "dist"), target: "node" })',
      '    for (const file of await readdir(join(dir, "src"))) if (file.endsWith(".py")) await copyFile(join(dir, "src", file), join(dir, "dist", file))',
      "  }",
      "}",
    ].join("\n") + "\n")
    w("script/build-desktop.ts", "// 合成根：没有 desktop 目标（drift 与本判据无关）\n")
    // ① 普通包：一条 Bun.build 产物 + 一条 `src/*.py` 复制产物（都被计划解释）
    w("packages/ghost/package.json", '{"name":"ghost"}\n')
    w("packages/ghost/src/plugin.ts", "export function apply() {}\n")
    w("packages/ghost/src/tool.py", "print(1)\n")
    w("packages/ghost/dist/plugin.js", "// built\n")
    w("packages/ghost/dist/tool.py", "print(1)\n")                        // 计划内：`src/*.py → dist` 副本
    w("packages/ghost/dist/orphan.py", 'print("no plan produces me")\n')  // ⭐ 计划外
    w("packages/ghost/dist/__pycache__/tool.cpython-313.pyc", "")         // 运行期缓存：按既有口径排除
    // ② 复刻历史孤儿的形状：`sim-mujoco/dist/worker.py`（计划外，`src/worker.py` 从来不存在）
    //    与活的 `sim-mujoco/python/worker.py`（不在 dist 下 ⇒ 本来就不是产物）**同名并列**。
    //    这一条专门用来抓"给某条已知路径开白名单"这种退化：`filter(u => u !== "packages/sim-mujoco/dist/worker.py")`
    //    在本用例下会把该条从 unexplained 里抹掉 ⇒ 立刻红。
    w("packages/sim-mujoco/package.json", '{"name":"sim-mujoco"}\n')
    w("packages/sim-mujoco/src/plugin.ts", "export function apply() {}\n")
    w("packages/sim-mujoco/dist/plugin.js", "// built\n")                 // 计划内
    w("packages/sim-mujoco/dist/worker.py", "print('stale copy')\n")      // ⭐ 计划外（历史孤儿同形）
    w("packages/sim-mujoco/python/worker.py", "print('live')\n")          // 活的：不在 dist 下
    return tmp
  }

  test("端到端：合成根 + 真 scan ⇒ 计划外产物必须出现在 unexplained，计划内的不出现", async () => {
    const tmp = syntheticRoot()
    try {
      const result = await scan(tmp, "resolved")
      // 计划侧：三条产物都被推出来（两个 `Bun.build` + 一条 `src/*.py` 复制），没有缺件
      expect(result.planSize).toBe(3)
      expect(result.artifacts.map(a => a.rel)).toEqual([
        "packages/ghost/dist/plugin.js",
        "packages/ghost/dist/tool.py",
        "packages/sim-mujoco/dist/plugin.js",
      ])
      expect(result.missingTargets).toEqual([])
      // ⭐ 判据的负对照：磁盘上多出来的那两个必须被报出来，且**只报它们**
      // （计划内的 `plugin.js` / `tool.py`、`.pyc`、以及不在 dist 下的 `python/worker.py` 都不许混进来）
      expect(result.unexplained).toEqual([
        "packages/ghost/dist/orphan.py",
        "packages/sim-mujoco/dist/worker.py",
      ])
      // 磁盘侧旁证：四个文件真的在（三个计划内 + 一个同形的孤儿），`.pyc` 不在
      expect(diskArtifacts(tmp).map(p => p.slice(tmp.length + 1))).toEqual([
        "packages/ghost/dist/orphan.py",
        "packages/ghost/dist/plugin.js",
        "packages/ghost/dist/tool.py",
        "packages/sim-mujoco/dist/plugin.js",
        "packages/sim-mujoco/dist/worker.py",
      ])
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  }, HEAVY)

  test("合成夹具与真构建脚本同形（真脚本换了形状时先红这一格，免得夹具自说自话）", () => {
    const real = readFileSync(join(root, "script/build-plugins.ts"), "utf8")
    expect(real).toMatch(/Bun\.build\(\{[\s\S]{0,300}?entrypoints/)
    expect(real).toMatch(/outdir/)
    expect(real).toContain('endsWith(".py")')   // `src/*.py → dist` 的复制循环
    expect(real).toContain("copyFile(")
  })
})

/** Root102失败后已合geometry线程的冻结真实builder原文：fixture只在临时目录执行，不改central builder。 */
const frozenPluginBuilder = "import { mkdir,readdir,readFile,writeFile,copyFile,symlink } from \"node:fs/promises\"\nimport { join,resolve } from \"node:path\"\nimport { linkUpstream } from \"./link-upstream.ts\"\nimport { remoteScopePlugin } from './terminal-build.ts'\nconst root=resolve(import.meta.dirname,\"..\")\n// 链接归属变化必须**播报**：`linkUpstream()` 明确统计了新建/改指/清理三条计数，以前在唯一调用点被\n// 整个丢掉 —— 与 `script/runtime-patch.ts` 那次\"返回值在唯一调用点被扔掉\"同形（见\n// `bugfixHistory/VERIFY-RUNTIME-PATCH-LINKS-20260926.md` §5.2 第 3 条）。同一文件里其它步骤都打\n// \"已构建 …\"，唯独 `node_modules/@deepseek-ai/*` 的归属变化无声。\nconst upstreamLinks=await linkUpstream(root)\nif(upstreamLinks.linked||upstreamLinks.updated||upstreamLinks.pruned)\n  console.log(`上游链接（${upstreamLinks.upstream}）：新建 ${upstreamLinks.linked}、改指 ${upstreamLinks.updated}、清理 ${upstreamLinks.pruned}`)\nconst only=process.argv.slice(2)\nconst packages=(await readdir(join(root,\"packages\"))).filter(n=>!only.length||only.includes(n))\n// 内联消费包需要独立计算线程闭包；统一构建入口生成，不依赖手工临时bundle。\nconst geometryWorker=await Bun.build({entrypoints:[join(root,'packages/asset-bake/src/geometry-worker.ts')],outdir:join(root,'packages/asset-bake/dist'),naming:'[name].js',target:'node',format:'esm',minify:false})\nif(!geometryWorker.success)throw new AggregateError(geometryWorker.logs,'几何计算worker构建失败')\nif(!only.length||only.includes(\"lyaup-migrations\")){\n  const result=await Bun.build({entrypoints:[join(root,\"packages/lyaup-migrations/src/index.ts\")],outdir:join(root,\"packages/lyaup-migrations/dist\"),naming:\"[name].js\",target:\"node\",format:\"esm\",packages:\"external\"})\n  if(!result.success)throw new AggregateError(result.logs,\"迁移器构建失败\")\n}\nif(!only.length||only.includes(\"lyapunov-product-bundle\")){\n  // cli.ts 经 github-cli.ts 引入 script/profile.ts：保留 process.env.NODE_ENV 的运行时读取，\n  // 避免 Bun.build 把 production 判据在构建期内联为构建机取值。\n  const result=await Bun.build({entrypoints:[join(root,\"packages/lyapunov-product-bundle/src/cli.ts\")],outdir:join(root,\"packages/lyapunov-product-bundle/dist\"),target:\"node\",format:\"esm\",external:[\"@deepseek-ai/*\"],define:{\"process.env.NODE_ENV\":\"process.env.NODE_ENV\"}})\n  if(!result.success)throw new AggregateError(result.logs,\"CLI构建失败\")\n}\nfor(const name of packages){\n  const dir=join(root,\"packages\",name)\n  // contracts等纯接口包没有plugin入口，但仍是现有工作区公开依赖，须在同一构建入口建立链接。\n  if(!await Bun.file(join(dir,\"package.json\")).exists())continue\n  const pkg=JSON.parse(await readFile(join(dir,\"package.json\"),\"utf8\"))\n  const link=join(root,\"node_modules\",pkg.name);await mkdir(resolve(link,\"..\"),{recursive:true})\n  try{await symlink(dir,link,\"dir\")}catch(e){if((e as NodeJS.ErrnoException).code!==\"EEXIST\")throw e}\n  const entry=join(dir,\"src/plugin.ts\")\n  if(!await Bun.file(entry).exists())continue\n  await mkdir(join(dir,\"dist\"),{recursive:true})\n  const build=await Bun.build({entrypoints:[entry],outdir:join(dir,\"dist\"),target:\"node\",format:\"esm\",external:[\"@deepseek-ai/*\",\"three\",\"fast-xml-parser\"],minify:false})\n  if(!build.success)throw new AggregateError(build.logs,\"插件构建失败：\"+name)\n  if(name===\"desktop\"){\n    const credentials=await Bun.build({entrypoints:[join(dir,\"src/guest-credentials.ts\")],outdir:join(dir,\"dist\"),target:\"node\",format:\"esm\",external:[\"@deepseek-ai/*\"]})\n    if(!credentials.success)throw new AggregateError(credentials.logs,\"游客传输凭据provider构建失败\")\n  }\n  if (name === 'lyapunov-terminal') {\n    const remote = await Bun.build({ entrypoints: [join(dir, 'src/remote-terminal.ts')], outdir: join(dir, 'dist'), target: 'node', format: 'esm', external: ['@deepseek-ai/*'], plugins: [remoteScopePlugin()] })\n    if (!remote.success) throw new AggregateError(remote.logs, '远端终端构建失败')\n  }\n  if (name === 'motion-mink') {\n    // request.ts 是纯入参规范化模块（无 DSH 依赖），plugin.ts 的 bundle 已把它内联；\n    // 产品外的验收脚本按路径直接 import dist/request.js，故另出一份具名产物，\n    // 让 dist/ 全部由本构建产出，避免手工 tsc 残留成为隐式依赖。\n    const request = await Bun.build({ entrypoints: [join(dir, 'src/request.ts')], outdir: join(dir, 'dist'), target: 'node', format: 'esm', naming: '[name].js', minify: false })\n    if (!request.success) throw new AggregateError(request.logs, 'motion-mink 入参模块构建失败')\n  }\n  for(const file of await readdir(join(dir,\"src\")))if(file.endsWith(\".py\"))await copyFile(join(dir,\"src\",file),join(dir,\"dist\",file))\n  // 算法 worker 随包复制：消费方（scene-kit）把 asset-bake 的 physicalize/operations 整个内联进自己的\n  // bundle 后，`new URL('./bake.py', import.meta.url)` 会解析到**消费方的 dist**——所以谁的产品里出现了\n  // 这个 worker 的引用，就把同一份 worker 复制到谁的 dist 旁边（来源与目标都打印出来）。这样 built 产物\n  // 自带 worker，运行期按相对位置解析，移动项目目录后仍可调用，不依赖任何人手工放副本。\n  if(name!==\"asset-bake\"){\n    const texts=await Promise.all(build.outputs.filter(output=>output.path.endsWith(\".js\")).map(output=>output.text()))\n    if(texts.some(text=>text.includes(\"bake.py\"))){\n      for(const file of [\"bake.py\",\"geometry_stream.py\"]){\n        const worker=join(root,\"packages/asset-bake/src\",file),target=join(dir,\"dist\",file)\n        await copyFile(worker,target)\n        console.log(\"已随包复制算法 worker\",worker,\"->\",target)\n      }\n    }\n    if(texts.some(text=>text.includes('geometry-worker.js')))await copyFile(join(root,'packages/asset-bake/dist/geometry-worker.js'),join(dir,'dist/geometry-worker.js'))\n  }\n  console.log(\"已构建\",pkg.name)\n}\nfor(const name of [\"viewer\",\"lyapunov-shell\",\"lyapunov-workspace\",\"lyapunov-session-undo\",\"desktop\"].filter(name=>!only.length||only.includes(name))){\n  const dir=join(root,\"packages\",name),pkg=JSON.parse(await readFile(join(dir,\"package.json\"),\"utf8\"))\n  const build=await Bun.build({entrypoints:[join(dir,\"src/client.tsx\")],target:\"browser\",format:\"cjs\",plugins:[{name:\"native-workspace-path\",setup(builder){builder.onResolve({filter:/^@deepseek-ai\\/dsh-util-workspace-path(?:\\/.*)?$/},args=>({path:Bun.resolveSync(args.path,root),external:false}))}}],external:[\"@deepseek-ai/*\",\"@lyapunov/viewer/client\",\"react\",\"react/jsx-runtime\",\"react-dom\"],minify:false,define:{\"process.env.NODE_ENV\":JSON.stringify(\"production\")}})\n  if(!build.success)throw new AggregateError(build.logs,\"客户端构建失败\")\n  const js=await build.outputs[0]!.text()\n  await writeFile(join(dir,\"dist/client.js\"),`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\\n${js}\\nreturn module.exports;}});\\n`)\n  console.log(\"已构建 DSH 客户端模块\",pkg.name)\n}\n"
const frozenDesktopBuilder = "import {resolve,join} from \"node:path\"\nimport {mkdir} from \"node:fs/promises\"\nconst root=resolve(import.meta.dirname,\"..\"),desktop=join(root,\"packages/desktop\")\nawait mkdir(join(desktop,\"dist\"),{recursive:true})\nfor(const input of [\n  {entry:\"main.ts\",target:\"node\" as const,format:\"esm\" as const,output:join(desktop,\"dist/main.js\"),external:[\"electron\",\"electron-store\",\"electron-window-state\",\"electron-updater\",\"@deepseek-ai/*\"]},\n  {entry:\"preload.ts\",target:\"node\" as const,format:\"cjs\" as const,output:join(desktop,\"dist/preload.cjs\"),external:[\"electron\"]},\n  {entry:\"account-view.tsx\",target:\"browser\" as const,format:\"iife\" as const,output:join(desktop,\"renderer/account.js\"),external:[]},\n]){\n  // node 目标保留 process.env.NODE_ENV 的运行时读取（Bun.build 默认会把构建机取值内联进产物）；\n  // 浏览器目标仍固定内联 production（React 生产分支）。\n  const built=await Bun.build({entrypoints:[join(desktop,\"src\",input.entry)],target:input.target,format:input.format,external:input.external,minify:false,define:{\"process.env.NODE_ENV\":input.target===\"browser\"?JSON.stringify(\"production\"):\"process.env.NODE_ENV\"}})\n  if(!built.success)throw new AggregateError(built.logs,\"桌面构建失败\")\n  await Bun.write(input.output,built.outputs[0]!);console.log(\"已构建\",input.output)\n}\n"

const frozenDesktopOutputs=[
  "packages/desktop/dist/client.js","packages/desktop/dist/guest-credentials.js",
  "packages/desktop/dist/main.js","packages/desktop/dist/plugin.js",
  "packages/desktop/dist/preload.cjs","packages/desktop/renderer/account.js",
]
async function frozenBuilderFixture(extraHelpers:readonly string[]=[],extraBuilder="",extraSources:Readonly<Record<string,string>>={}):Promise<string>{
  const tmp=mkdtempSync(join(tmpdir(),"inventory-real-builders-"))
  const write=(rel:string,body:string)=>{mkdirSync(join(tmp,dirname(rel)),{recursive:true});writeFileSync(join(tmp,rel),body)}
  const helpers=["bake.py","geometry_stream.py",...extraHelpers]
  let plugin=frozenPluginBuilder
  if(extraHelpers.length)plugin=plugin.replace('["bake.py","geometry_stream.py"]',JSON.stringify(helpers))
  write("script/build-plugins.ts",plugin+extraBuilder)
  write("script/build-desktop.ts",frozenDesktopBuilder)
  write("script/link-upstream.ts",'export async function linkUpstream(){return {linked:0,updated:0,pruned:0,upstream:"fixture"}}')
  write("script/terminal-build.ts",'export function remoteScopePlugin(){return {name:"fixture",setup(){}}}')
  const sources:Record<string,readonly string[]>={
    "lyaup-migrations":["index.ts"],"lyapunov-product-bundle":["cli.ts"],"asset-bake":["plugin.ts","geometry-worker.ts"],
    "scene-kit":["plugin.ts"],"desktop":["plugin.ts","guest-credentials.ts","client.tsx","main.ts","preload.ts","account-view.tsx"],
    "lyapunov-terminal":["plugin.ts","remote-terminal.ts"],"motion-mink":["plugin.ts","request.ts"],
    "viewer":["plugin.ts","client.tsx"],"lyapunov-shell":["plugin.ts","client.tsx"],
    "lyapunov-workspace":["plugin.ts","client.tsx"],"lyapunov-session-undo":["plugin.ts","client.tsx"],
  }
  for(const [pkg,files]of Object.entries(sources)){
    write(`packages/${pkg}/package.json`,JSON.stringify({name:`@fixture/${pkg}`,type:"module"}))
    for(const file of files)write(`packages/${pkg}/src/${file}`,pkg==='scene-kit'&&file==='plugin.ts'?'export const marker="bake.py";':'export const answer=1;')
  }
  for(const helper of helpers)write(`packages/asset-bake/src/${helper}`,`# ${helper}\nfixture=1\n`)
  for(const [path,body]of Object.entries(extraSources))write(path,body)
  try{
    for(const builder of ["build-plugins.ts","build-desktop.ts"]){
      const run=Bun.spawn([process.execPath,"--no-env-file",join(tmp,"script",builder)],{cwd:tmp,stdout:"pipe",stderr:"pipe",env:{...process.env}})
      const [exit,out,err]=await Promise.all([run.exited,new Response(run.stdout).text(),new Response(run.stderr).text()])
      if(exit!==0)throw new Error(`冻结真实builder失败：${builder} exit=${exit}\n${out}\n${err}`)
    }
    return tmp
  }catch(error){rmSync(tmp,{recursive:true,force:true});throw error}
}

describe("真实builder foreach与desktop全产物合同",()=>{
  test("冻结geometry+guest builder实际执行，desktop六产物、worker列表逐项解释，未知仍报",async()=>{
    const tmp=await frozenBuilderFixture()
    try{
      const plan=derivePlan(tmp)
      expect(plan.drift).toEqual([])
      expect(plan.targets.filter(t=>t.packageDir===join(tmp,"packages/desktop")).map(t=>t.output.slice(tmp.length+1)).sort()).toEqual(frozenDesktopOutputs)
      const copies=plan.targets.filter(t=>t.copy&&t.packageDir===join(tmp,"packages/scene-kit"))
      expect(copies.map(t=>basename(t.output)).sort()).toEqual(["bake.py","geometry_stream.py"])
      expect(copies.map(t=>t.entry)).toEqual([join(tmp,"packages/asset-bake/src/bake.py"),join(tmp,"packages/asset-bake/src/geometry_stream.py")])
      const scanBefore=await scan(tmp,"resolved",undefined,true)
      expect(scanBefore.unexplained).toEqual([])
      expect(scanBefore.missingTargets).toEqual([])
      for(const target of plan.targets.filter(t=>t.packageDir===join(tmp,"packages/desktop")))expect((await exactRebuild(target,tmp)).verdict,target.output).toBe("same")
      writeFileSync(join(tmp,"packages/scene-kit/dist/unknown.py"),"# 没有copy声明")
      expect((await scan(tmp,"resolved")).unexplained).toEqual(["packages/scene-kit/dist/unknown.py"])
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)

  test("同结构新Python helper与任意扩展复制泛展开，未声明同名文件不放行",async()=>{
    const tmp=await frozenBuilderFixture(["new_helper.py","opaque_payload.bin"])
    try{
      const plan=derivePlan(tmp),owner=join(tmp,"packages/scene-kit")
      expect(plan.drift).toEqual([])
      expect(plan.targets.filter(t=>t.copy&&t.packageDir===owner).map(t=>basename(t.output)).sort()).toEqual(["bake.py","geometry_stream.py","new_helper.py","opaque_payload.bin"])
      expect((await scan(tmp,"resolved")).unexplained).toEqual([])
      mkdirSync(join(tmp,"packages/desktop/dist"),{recursive:true})
      writeFileSync(join(tmp,"packages/desktop/dist/new_helper.py"),"# 同名但这里没有copy语句/marker")
      expect((await scan(tmp,"resolved")).unexplained).toEqual(["packages/desktop/dist/new_helper.py"])
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)

  test("计划内复制缺副本仍MISSING；源或副本变一字 exact必须differs",async()=>{
    const tmp=await frozenBuilderFixture(["new_helper.py"])
    try{
      const target=derivePlan(tmp).targets.find(t=>t.output===join(tmp,"packages/scene-kit/dist/new_helper.py"))!
      expect((await exactRebuild(target,tmp)).verdict).toBe("same")
      writeFileSync(target.entry,"# 新真实源字节\nfixture=2\n")
      expect((await exactRebuild(target,tmp)).verdict).toBe("differs")
      writeFileSync(target.output,readFileSync(target.entry))
      expect((await exactRebuild(target,tmp)).verdict).toBe("same")
      rmSync(target.output)
      const result=await scan(tmp,"resolved")
      expect(result.missingTargets).toContain("packages/scene-kit/dist/new_helper.py")
      expect(result.workerWithoutCopy).toContain("packages/scene-kit/dist/new_helper.py（构建明确复制，磁盘无副本）")
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)

  test("复制Bun产物沿真实producer递归输入，传递源改变而旧dist未动仍exact differs",async()=>{
    const tmp=await frozenBuilderFixture([],`
const derived=await Bun.build({entrypoints:[join(root,"packages/asset-bake/src/custom-worker.ts")],outdir:join(root,"packages/asset-bake/dist"),target:"node",format:"esm"})
if(!derived.success)throw new AggregateError(derived.logs,"夹具producer失败")
await copyFile(join(root,"packages/asset-bake/dist/custom-worker.js"),join(root,"packages/scene-kit/dist/derived-worker.js"))
`,{
      "packages/asset-bake/src/custom-worker.ts":'import {value} from "./custom-input.ts"; export const result=value;',
      "packages/asset-bake/src/custom-input.ts":'export const value=1;',
    })
    try{
      const plan=derivePlan(tmp)
      expect(plan.drift).toEqual([])
      const copy=plan.targets.find(t=>t.output===join(tmp,"packages/scene-kit/dist/derived-worker.js"))!
      expect(copy.copyProducer?.entry).toBe(join(tmp,"packages/asset-bake/src/custom-worker.ts"))
      const closure=inputClosure(copy,{root:tmp,scope:"resolved"})
      expect(closure.unresolved).toEqual([])
      expect(closure.inputs.map(i=>i.path).sort()).toEqual([
        join(tmp,"packages/asset-bake/dist/custom-worker.js"),
        join(tmp,"packages/asset-bake/src/custom-input.ts"),
        join(tmp,"packages/asset-bake/src/custom-worker.ts"),
      ])
      expect((await exactRebuild(copy,tmp)).verdict).toBe("same")
      const oldProducer=readFileSync(copy.entry),oldCopy=readFileSync(copy.output)
      writeFileSync(join(tmp,"packages/asset-bake/src/custom-input.ts"),'export const value=2;')
      expect(readFileSync(copy.entry)).toEqual(oldProducer)
      expect(readFileSync(copy.output)).toEqual(oldCopy)
      expect((await exactRebuild(copy,tmp)).verdict).toBe("differs")
      writeFileSync(join(tmp,"packages/asset-bake/src/custom-input.ts"),'export const value=1;')
      expect((await exactRebuild(copy,tmp)).verdict).toBe("same")
      writeFileSync(copy.output,'// 计划内副本字节损坏')
      expect((await exactRebuild(copy,tmp)).verdict).toBe("differs")
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)

  test("unknown动态文件列表不猜，drift与unexplained保留；源里提marker却未进bundle不复制",async()=>{
    const tmp=await frozenBuilderFixture()
    try{
      const path=join(tmp,"script/build-plugins.ts")
      const original=readFileSync(path,"utf8")
      writeFileSync(path,original.replace('["bake.py","geometry_stream.py"]','runtimeHelperNames'))
      const plan=derivePlan(tmp)
      expect(plan.drift.some(d=>d.includes("copyFile循环集合未解析")&&d.includes("runtimeHelperNames"))).toBe(true)
      expect((await scan(tmp,"resolved")).unexplained).toContain("packages/scene-kit/dist/geometry_stream.py")
      writeFileSync(path,original)
      writeFileSync(join(tmp,"packages/desktop/src/plugin.ts"),'const unused="bake.py"; export const answer=1;')
      expect(derivePlan(tmp).targets.some(t=>t.copy&&t.output===join(tmp,"packages/desktop/dist/bake.py"))).toBe(false)
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)

  test("前置continue按进入的循环求值，未知guard保drift/孤儿，明确false/true不猜",async()=>{
    const tmp=await frozenBuilderFixture()
    try{
      const path=join(tmp,"script/build-plugins.ts"),original=readFileSync(path,"utf8")
      const loop='for(const file of ["bake.py","geometry_stream.py"]){'
      expect(original).toContain(loop)
      const setGuard=(expression:string)=>writeFileSync(path,original.replace(loop,loop+'\n      if('+expression+')continue'))
      setGuard('runtimeCopySkip')
      const unknown=derivePlan(tmp)
      expect(unknown.drift.some(d=>d.includes('前置continue条件未解析')&&d.includes('runtimeCopySkip'))).toBe(true)
      expect((await scan(tmp,"resolved")).unexplained).toEqual(["packages/scene-kit/dist/bake.py","packages/scene-kit/dist/geometry_stream.py"])
      setGuard('false')
      expect(derivePlan(tmp).drift).toEqual([])
      expect((await scan(tmp,"resolved")).unexplained).toEqual([])
      setGuard('true')
      expect(derivePlan(tmp).drift).toEqual([])
      expect((await scan(tmp,"resolved")).unexplained).toEqual(["packages/scene-kit/dist/bake.py","packages/scene-kit/dist/geometry_stream.py"])
    }finally{rmSync(tmp,{recursive:true,force:true})}
  },HEAVY)
})
