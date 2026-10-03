import { describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ensureWorkspaceMapping, runtimePaths } from "../src/runtime-paths.ts"

/**
 * `ensureWorkspaceMapping()` 的**行为**用例（`RUNTIME-PATHS-AND-FROZEN-VALUES` 单）。
 *
 * 为什么现在才写：这条函数此前**一条用例都没有**——`script/verify-asset-layout.test.ts` 只经
 * `createCiLayoutFixture()` 覆盖了"产品根 workspace 映射软链"这一个 happy path，而那个夹具
 * **不传 `claimProductEntry`**（⇒ 走 `undefined` ⇒ 认领），所以
 * `claimProductEntry:false` 这一支**从未被执行过**。本单被审的正是那一支。
 *
 * 纪律：**全程只在 `mkdtemp` 出来的替身树里跑**，替身树自带 `product/` 与 `.runtime/...`，
 * 与真产品根、真运行根没有一条路径重叠 —— 本文件不读也不写 `Dev/workspace` 与 `Dev/.runtime/**`。
 */

const SRC = resolve(import.meta.dirname, "../src/runtime-paths.ts")

/** 替身树：`<tmp>/product` + `<tmp>/.runtime/**`。用完连根删。 */
async function withTree(run: (tree: { root: string; productRoot: string }) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "lyapunov-runtime-paths-"))
  try {
    const productRoot = join(root, "product")
    mkdirSync(productRoot, { recursive: true })
    await run({ root, productRoot })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 规范运行根：`<tmp>/.runtime/developer/developer`（父目录名 = 运行模式）。 */
const canonical = (root: string) => runtimePaths({ mode: "developer", root: join(root, ".runtime/developer") })
/** 临时/验证运行根：`<tmp>/.runtime/verify-xxx/developer`（事故现场那一类，`docs/asset-layout.md:49`）。 */
const verification = (root: string) => runtimePaths({ mode: "developer", root: join(root, ".runtime/verify-xxx") })

/** 软链是否指向 `target`（按 `ensureWorkspaceMapping` 自己的相对写法解析）。 */
function pointsAt(path: string, target: string): boolean {
  return resolve(dirname(path), readlinkSync(path)) === resolve(target)
}

describe("ensureWorkspaceMapping · 人类入口 <产品根>/workspace", () => {
  test("授权修正：`claimProductEntry:false` 且入口不存在 ⇒ 不创建全局入口，仍建内部域映射", async () => {
    await withTree(async ({ root, productRoot }) => {
      const paths = verification(root)
      const entry = join(productRoot, "workspace")
      expect(lstatSync(entry, { throwIfNoEntry: false })).toBeUndefined() // 前提：入口真的不存在

      const changed = await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths, claimProductEntry: false })

      // 旧版在这里照建并留下粘性 QA 入口；本次授权明确改为不认领就不创建。
      expect(lstatSync(entry, { throwIfNoEntry: false })).toBeUndefined()
      expect(changed).not.toContain(entry)
      expect(changed).toHaveLength(4)
      for (const name of ["worlds", "assets", "robots", "cache"]) expect(lstatSync(join(paths.workspaceRoot, name)).isSymbolicLink()).toBe(true)
    })
  })

  test("`claimProductEntry:false` 且入口**已指向别处** ⇒ 一个字不动（**不重指**，事故那一半确实被挡住了）", async () => {
    await withTree(async ({ root, productRoot }) => {
      const live = canonical(root)
      const verify = verification(root)
      const entry = join(productRoot, "workspace")
      mkdirSync(live.workspaceRoot, { recursive: true })
      mkdirSync(verify.workspaceRoot, { recursive: true })
      symlinkSync(resolve(live.workspaceRoot), entry)

      const changed = await ensureWorkspaceMapping({ productRoot, workspaceRoot: verify.workspaceRoot, paths: verify, claimProductEntry: false })

      expect(pointsAt(entry, live.workspaceRoot)).toBe(true) // 仍指规范根
      expect(changed).not.toContain(entry)
    })
  })

  test("`claimProductEntry:false` 且入口是**同名真实目录** ⇒ 不接管用户内容", async () => {
    await withTree(async ({ root, productRoot }) => {
      const paths = verification(root)
      const entry = join(productRoot, "workspace")
      mkdirSync(entry, { recursive: true })

      const changed = await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths, claimProductEntry: false })

      expect(lstatSync(entry).isSymbolicLink()).toBe(false) // 还是那个真目录
      expect(lstatSync(entry).isDirectory()).toBe(true)
      expect(changed).not.toContain(entry)
    })
  })

  test("true/省略也不接管用户同名真实目录或其中内容", async () => {
    await withTree(async ({ root, productRoot }) => {
      const paths=canonical(root),entry=join(productRoot,"workspace"),file=join(entry,"keep.txt")
      mkdirSync(entry,{recursive:true});writeFileSync(file,"fixture-owned content")
      for(const claimProductEntry of [true,undefined]){
        const changed=await ensureWorkspaceMapping({productRoot,workspaceRoot:paths.workspaceRoot,paths,claimProductEntry})
        expect(lstatSync(entry).isDirectory()).toBe(true);expect(readFileSync(file,"utf8")).toBe("fixture-owned content")
        expect(changed).not.toContain(entry)
      }
    })
  })

  test("非认领保留已有悬空入口原文，不擅自修复当前导航",async()=>{
    await withTree(async({root,productRoot})=>{
      const paths=verification(root),entry=join(productRoot,"workspace"),old="../gone-qa-root/workspace"
      symlinkSync(old,entry)
      const changed=await ensureWorkspaceMapping({productRoot,workspaceRoot:paths.workspaceRoot,paths,claimProductEntry:false})
      expect(readlinkSync(entry)).toBe(old);expect(changed).not.toContain(entry)
    })
  })

  test("`claimProductEntry` 为 `true` 或省略（默认 true）⇒ 规范根**改指**已有入口", async () => {
    await withTree(async ({ root, productRoot }) => {
      const stale = verification(root)
      const live = canonical(root)
      mkdirSync(stale.workspaceRoot, { recursive: true })
      for (const claimProductEntry of [true, undefined]) {
        const entry = join(productRoot, "workspace")
        rmSync(entry, { force: true })
        symlinkSync(resolve(stale.workspaceRoot), entry)
        const changed = await ensureWorkspaceMapping({ productRoot, workspaceRoot: live.workspaceRoot, paths: live, claimProductEntry })
        expect(pointsAt(entry, live.workspaceRoot)).toBe(true)
        expect(changed).toContain(entry)
      }
    })
  })

  test('域内四条软链与本标志无关：`false` 下照常建立（注释里那句"照常建立"是准的）', async () => {
    await withTree(async ({ root, productRoot }) => {
      const paths = verification(root)
      await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths, claimProductEntry: false })
      for (const [name, target] of [["worlds", paths.worldsRoot], ["assets", paths.assetsRoot], ["robots", paths.robotsRoot], ["cache", paths.cacheRoot]] as const) {
        expect(pointsAt(join(paths.workspaceRoot, name), target)).toBe(true)
      }
    })
  })

  test("幂等：同一根跑两次，第二次 `changed` 为空（软链已经指对，不重复创建）", async () => {
    await withTree(async ({ root, productRoot }) => {
      const paths = canonical(root)
      await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths, claimProductEntry: true })
      const again = await ensureWorkspaceMapping({ productRoot, workspaceRoot: paths.workspaceRoot, paths, claimProductEntry: true })
      expect(again).toEqual([])
    })
  })
})

describe("调用方的『规范运行根』判定（script/profile.ts:258 的口径，此处只复算谓词）", () => {
  const isCanonical = (root: string, mode: string) => basename(dirname(root)) === mode

  test("`.runtime/<mode>/…` ⇒ true；`.runtime/verify-xxx/developer` ⇒ false（事故现场被正确挡住）", async () => {
    await withTree(({ root }) => {
      expect(isCanonical(canonical(root).root, "developer")).toBe(true)
      expect(isCanonical(verification(root).root, "developer")).toBe(false)
    })
  })

  test("⚠️ 已知反向开口（本单只登记、未改）：临时根只要自己叫 `<tmp>/developer` ⇒ 判成规范根，**连已有入口都会被改指**", async () => {
    await withTree(async ({ root, productRoot }) => {
      const tempish = runtimePaths({ mode: "developer", root: join(root, "verify-tmp/developer") }) // 名字里有 developer ⇒ 谓词被骗
      expect(isCanonical(tempish.root, "developer")).toBe(true)

      const live = canonical(root)
      mkdirSync(live.workspaceRoot, { recursive: true })
      mkdirSync(tempish.workspaceRoot, { recursive: true })
      const entry = join(productRoot, "workspace")
      symlinkSync(resolve(live.workspaceRoot), entry)

      // 谓词说它是规范根 ⇒ 调用方会传 claimProductEntry:true ⇒ 已有入口被抢走
      await ensureWorkspaceMapping({ productRoot, workspaceRoot: tempish.workspaceRoot, paths: tempish, claimProductEntry: isCanonical(tempish.root, "developer") })
      expect(pointsAt(entry, tempish.workspaceRoot)).toBe(true) // 这就是"把 Dev/workspace 指到验证目录"的复现
    })
  })

  test("持久但目录名不匹配的根仍为 false，本窄修不会冒称其自动认领全局入口", async () => {
    await withTree(({ root }) => {
      for (const relativeRoot of [".runtime/product", ".runtime/terminal", ".runtime/github", ".runtime/desktop/developer/runtime"]) {
        expect(isCanonical(runtimePaths({ mode: "developer", root: join(root, relativeRoot) }).root, "developer")).toBe(false)
      }
    })
  })
  test("正式账户即使runtimeRoot名为formal仍因accounts父目录为false；桌面guest也是false",async()=>{
    await withTree(async({root,productRoot})=>{
      const formal=runtimePaths({mode:"formal",root:join(root,".runtime/formal"),accountId:"synthetic-directory-fixture"})
      const guest=runtimePaths({mode:"guest",root:join(root,"desktop-data/runtime")})
      for(const [paths,mode] of [[formal,"formal"],[guest,"guest"]] as const){
        expect(isCanonical(paths.root,mode)).toBe(false)
        await ensureWorkspaceMapping({productRoot,workspaceRoot:paths.workspaceRoot,paths,claimProductEntry:isCanonical(paths.root,mode)})
        expect(lstatSync(join(productRoot,"workspace"),{throwIfNoEntry:false})).toBeUndefined()
        for(const name of ["worlds","assets","robots","cache"] as const)expect(pointsAt(join(paths.workspaceRoot,name),paths[`${name}Root`])).toBe(true)
      }
    })
  })
})

describe("源码守卫：授权变更后注释必须准确，不掩盖调用方谓词仍未决", () => {
  const source = readFileSync(SRC, "utf8")
  const paramDoc = source.slice(source.indexOf("是否认领 <产品根>/workspace"), source.indexOf("claimProductEntry?: boolean"))
  const entryComment = source.slice(source.indexOf("非认领调用不创建"), source.indexOf("const entry = join(input.productRoot"))
  const flat = (text: string) => text.replace(/\s|\*/g, "")
  test("false 同时不创建/不重指，内部映射继续保留", () => {
    expect(flat(paramDoc)).toContain(flat("不创建也不重指"))
    expect(flat(paramDoc)).toContain(flat("四条域映射仍照常建立"))
    expect(flat(entryComment)).toContain(flat("不创建也不重指"))
  })
  test("入口处注释同样明确不创建/不重指，不能只承诺已有入口", () => {
    expect(flat(entryComment)).toContain(flat("不创建也不重指"))
  })
  test("不再把 false 的旧照建行为写成仍有效", () => {
    expect(flat(paramDoc)).not.toContain(flat("不存在时照建"))
  })
  test("保留目录名谓词的已知开口与正式账户false事实，不假称全部已修", () => {
    expect(flat(paramDoc)).toContain(flat("已知开口"))
    expect(flat(paramDoc)).toContain(flat("Lead"))
    expect(flat(paramDoc)).toContain(flat("正式账户根的父目录是accounts"))
  })
})


describe("未登录本地工作台",()=>{
 test("本地运行根独立于账户与开发者，正式认证仍必需",async()=>{
  await withTree(async({root})=>{
   const local=runtimePaths({mode:"local",root,production:true})
   expect(local.root).toBe(join(root,"local"))
   expect(local.root).not.toBe(runtimePaths({mode:"developer",root}).root)
   expect(local.root).not.toBe(runtimePaths({mode:"formal",root,accountId:"fixture-account"}).root)
   expect(()=>runtimePaths({mode:"formal",root,production:true})).toThrow("AUTH_REQUIRED")
   const {backendEnvironment}=await import("../../../script/profile.ts")
   const sdk={LYAPUNOV_MUJOCO_PYTHON:join(root,"sdk/mujoco/bin/python"),LYAPUNOV_ISAAC_PYTHON:join(root,"sdk/isaac/bin/python"),LYAPUNOV_NEWTON_PYTHON:join(root,"sdk/newton/bin/python")}
   const env=await backendEnvironment("local",local,{parent:{PATH:process.env.PATH,HOME:root,...sdk,DEEPSEEK_API_KEY:"fixture-own-key",LYAPUNOV_ACCOUNT_TOKEN:"fixture-account-token",LYAPUNOV_DEVELOPER_AUTH_FILE:join(root,"must-not-read.json"),OTHER_MODEL_SECRET:"must-not-forward"}})
   for(const [key,path] of Object.entries(sdk))expect(env[key]).toBe(path)
   expect(env.DEEPSEEK_API_KEY).toBeUndefined()
   expect(env.LYAPUNOV_ACCOUNT_TOKEN).toBeUndefined()
   expect(env.LYAPUNOV_DEVELOPER_AUTH_FILE).toBeUndefined()
   expect(env.OTHER_MODEL_SECRET).toBeUndefined()
   expect(env.HOME).toBe(join(local.root,"private"))
   expect(env.LYAPUNOV_MODE).toBe("local")
  })
 })

 test("正式 Host 也只转发三条 SDK 路径，账户令牌仅取已验证账户",async()=>{
  await withTree(async({root})=>{
   const formal=runtimePaths({mode:"formal",root,accountId:"fixture-account",production:true})
   const sdk={LYAPUNOV_MUJOCO_PYTHON:join(root,"sdk/mujoco/bin/python"),LYAPUNOV_ISAAC_PYTHON:join(root,"sdk/isaac/bin/python"),LYAPUNOV_NEWTON_PYTHON:join(root,"sdk/newton/bin/python")}
   const account={token:"verified-account-token",apiUrl:"https://api.example.invalid"}
   const env=await (await import("../../../script/profile.ts")).backendEnvironment("formal",formal,{account:account as never,parent:{PATH:process.env.PATH,...sdk,DEEPSEEK_API_KEY:"parent-secret",LYAPUNOV_ACCOUNT_TOKEN:"unverified-parent-token",OTHER_MODEL_SECRET:"must-not-forward"}})
   for(const [key,path] of Object.entries(sdk))expect(env[key]).toBe(path)
   expect(env.DEEPSEEK_API_KEY).toBeUndefined()
   expect(env.OTHER_MODEL_SECRET).toBeUndefined()
   expect(env.LYAPUNOV_ACCOUNT_TOKEN).toBe(account.token)
   expect(env.HOME).toBe(join(formal.root,"private"))
  })
 })
})
