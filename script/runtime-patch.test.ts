/** Offline overlay assertions; no Host, UI, provider connection, or secret files. */
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { Context } from "@deepseek-ai/cordis"
import Web from "@deepseek-ai/dsh-web"
import {applyEntryPatches,entryListSchema,type PatchOptions} from "@deepseek-ai/cordis-plugin-include"
import {interpolate,type EntryOptions} from "@deepseek-ai/cordis-plugin-loader"
import { Config as PiAiSchema, type Options as PiAiOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { formalModelRows } from "../packages/lyapunov-product-bundle/src/account/formal.ts"
import { runtimePaths } from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import { backendEnvironment } from "./profile.ts"
import { PRODUCT_LINK_SWITCH_AUDIT, INSTALLATION_MIRROR_AUDIT, censusModuleLinkScope, isaacRuntimeOptions, linkProductBundleSlot, migrateLegacyProfileAndReport, productLinkSwitchNotice, reconcileAndReportInstallationMirror, reconcileAndReportProductLinks, runtimePatch, runtimePluginInsert, publicChooserHome } from "./runtime-patch.ts"

const root = join(import.meta.dirname, "..")
const source = readFileSync(join(root, "script/runtime-patch.ts"), "utf8")
const modelSection = source.slice(source.indexOf("const plugins=runtimePluginInsert(input)"))
const upstream = JSON.parse(readFileSync(join(root, "UPSTREAM_LOCK.json"), "utf8")).directory as string
const webBundle = readFileSync(join(root, upstream, "packages/bundle/web-app/cordis.patch.yml"), "utf8")
const productBundle = readFileSync(join(root, "packages/lyapunov-product-bundle/cordis.patch.yml"), "utf8")

test("Isaac 产品默认 GPU 物理、显式 cpu/none 不被环境覆盖，插件配置写入真实生效值", () => {
  expect(isaacRuntimeOptions({}, {} as NodeJS.ProcessEnv)).toEqual({ physicsDevice: "cuda:0", rendering: "none" })
  expect(isaacRuntimeOptions({}, { LYAPUNOV_ISAAC_DEVICE: "cpu", LYAPUNOV_ISAAC_RENDERING: "none" })).toEqual({ physicsDevice: "cpu", rendering: "none" })
  expect(isaacRuntimeOptions({ physicsDevice: "cpu", rendering: "none" }, { LYAPUNOV_ISAAC_DEVICE: "cuda:0", LYAPUNOV_ISAAC_RENDERING: "rtx" })).toEqual({ physicsDevice: "cpu", rendering: "none" })
  const base = { mode: "developer" as const, surface: "web", sceneRoot: "/tmp/isaac-default-config-fixture", engine: "isaac" as const }
  const plugin = (sdkEnvironment: NodeJS.ProcessEnv, isaac?: { physicsDevice: "cpu"; rendering: "none" }) => runtimePluginInsert({ ...base, sdkEnvironment, isaac }).find(row => row.id === "lyapunov-sim-isaac")!.config!
  expect(plugin({ LYAPUNOV_ISAAC_PYTHON: "/fixture/isaac-python", LYAPUNOV_MUJOCO_PYTHON: "/fixture/mujoco-python" })).toMatchObject({ pythonPath: "/fixture/isaac-python", physicsDevice: "cuda:0", rendering: "none" })
  expect(plugin({ LYAPUNOV_ISAAC_DEVICE: "cpu", LYAPUNOV_ISAAC_RENDERING: "none" })).toMatchObject({ physicsDevice: "cpu", rendering: "none" })
  expect(plugin({ LYAPUNOV_ISAAC_DEVICE: "cuda:0", LYAPUNOV_ISAAC_RENDERING: "rtx" }, { physicsDevice: "cpu", rendering: "none" })).toMatchObject({ physicsDevice: "cpu", rendering: "none" })
  const standalone = plugin({ LYAPUNOV_ISAAC_PYTHON: "/fixture/isaac/python.sh" })
  expect(standalone.readOnlyRoots).toContain("/fixture/isaac")
  expect(standalone.readOnlyRoots).not.toContain("/fixture")
})

test("local 的真实运行补丁与假 DSH 子进程读同一组三条 SDK 路径；父进程密钥被隔离", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-sdk-env-wire-"))
  const savedUndo = process.env.LYAPUNOV_SESSION_UNDO
  try {
    process.env.LYAPUNOV_SESSION_UNDO = "0"
    const paths = runtimePaths({ mode: "local", root: join(box, "runtime") })
    const parent: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LYAPUNOV_MUJOCO_PYTHON: join(box, "external/mujoco/bin/python"),
      LYAPUNOV_ISAAC_PYTHON: join(box, "external/isaac/bin/python"),
      LYAPUNOV_NEWTON_PYTHON: join(box, "external/newton/bin/python"),
      DEEPSEEK_API_KEY: "parent-model-secret",
      OTHER_MODEL_SECRET: "parent-unlisted-secret",
    }
    const childEnv = await backendEnvironment("local", paths, { parent })
    const sdkModule = pathToFileURL(join(root, "packages/lyapunov-product-bundle/src/sdk-python.mjs")).href
    const childScript = `import { resolveSdkPython } from ${JSON.stringify(sdkModule)}; const names=['mujoco','isaac','newton']; console.log(JSON.stringify({ mode:process.env.LYAPUNOV_MODE, paths:Object.fromEntries(names.map(name=>[name,process.env['LYAPUNOV_'+name.toUpperCase()+'_PYTHON']??null])), resolved:Object.fromEntries(names.map(name=>[name,resolveSdkPython(${JSON.stringify(root)},name,process.env)])), device:process.env.LYAPUNOV_ISAAC_DEVICE??null, rendering:process.env.LYAPUNOV_ISAAC_RENDERING??null, secret:process.env.DEEPSEEK_API_KEY??null, extra:process.env.OTHER_MODEL_SECRET??null }))`
    const child = spawnSync("node", ["--input-type=module", "-e", childScript], { cwd: root, env: childEnv, encoding: "utf8", timeout: 10_000 })
    expect(child.status).toBe(0)
    const readback = JSON.parse(child.stdout) as { mode: string; paths: Record<string, string>; resolved: Record<string, { python: string; source: string }>; device: string | null; rendering: string | null; secret: string | null; extra: string | null }
    expect(readback.mode).toBe("local")
    expect(readback.secret).toBeNull()
    expect(readback.extra).toBeNull()
    expect(readback.device).toBeNull()
    expect(readback.rendering).toBeNull()
    for (const name of ["mujoco", "isaac", "newton"] as const) {
      const python = parent[`LYAPUNOV_${name.toUpperCase()}_PYTHON`]!
      expect(readback.paths[name]).toBe(python)
      expect(readback.resolved[name]).toEqual({ python, source: "env-override" })
    }
    const profile = async (name: string, sdkEnvironment: NodeJS.ProcessEnv) => {
      const dir = join(paths.dshHome, "profiles", name)
      await mkdir(dir, { recursive: true })
      const file = await runtimePatch({ dir, mode: "local", surface: "web", sceneRoot: paths.sceneRoot, domains: paths, accountApiUrl: "https://api.example.invalid", engine: "isaac", grasp: "none", sdkEnvironment })
      const text = await readFile(file, "utf8")
      expect(text).not.toContain(parent.DEEPSEEK_API_KEY!)
      expect(text).not.toContain(parent.OTHER_MODEL_SECRET!)
      const insertion = text.split("\n").find(line => line.startsWith("- insert: "))!
      return JSON.parse(insertion.slice("- insert: ".length)) as Array<{ id: string; config: Record<string, unknown> }>
    }
    const defaultRows = await profile("isaac-gpu-default", parent)
    expect(defaultRows.find(row => row.id === "lyapunov-sim-isaac")?.config).toMatchObject({ pythonPath: parent.LYAPUNOV_ISAAC_PYTHON, physicsDevice: "cuda:0", rendering: "none" })
    expect(defaultRows.find(row => row.id === "lyapunov-scene-kit")?.config.algorithmPython).toBe(parent.LYAPUNOV_ISAAC_PYTHON)
    expect(defaultRows.find(row => row.id === "lyapunov-asset-bake")?.config.python).toBe(parent.LYAPUNOV_ISAAC_PYTHON)
    for (const name of ["motion-mink", "motion-ompl"]) expect(defaultRows.find(row => row.id === "lyapunov-" + name)?.config.python).toBe(parent.LYAPUNOV_MUJOCO_PYTHON)
    const cpuRows = await profile("isaac-explicit-cpu", { ...parent, LYAPUNOV_ISAAC_DEVICE: "cpu", LYAPUNOV_ISAAC_RENDERING: "none" })
    expect(cpuRows.find(row => row.id === "lyapunov-sim-isaac")?.config).toMatchObject({ pythonPath: parent.LYAPUNOV_ISAAC_PYTHON, physicsDevice: "cpu", rendering: "none" })
    expect(runtimePluginInsert({ mode: "local", surface: "web", sceneRoot: paths.sceneRoot, engine: "newton", sdkEnvironment: parent }).find(row => row.id === "lyapunov-sim-newton")?.config?.pythonPath).toBe(parent.LYAPUNOV_NEWTON_PYTHON)
    const host = readFileSync(join(root, "script/host.ts"), "utf8")
    const desktop = readFileSync(join(root, "packages/desktop/src/main.ts"), "utf8")
    expect(host).toContain("sdkEnvironment:input.parentEnvironment??process.env")
    expect(desktop).toContain("startWebHost({mode:hostMode")
    expect(desktop).not.toContain("isaac:{physicsDevice:\"cpu\"")
  } finally {
    if (savedUndo === undefined) delete process.env.LYAPUNOV_SESSION_UNDO
    else process.env.LYAPUNOV_SESSION_UNDO = savedUndo
    await rm(box, { recursive: true, force: true })
  }
})

test("仅有 Isaac 安装时烘焙和场景派生复用同一默认前缀；MuJoCo模式保留自己的解释器", () => {
  const directory="/tmp/isaac-only-algorithm-fixture"
  const env:NodeJS.ProcessEnv={LYAPUNOV_ENGINE_PREFERENCE_FILE:join(directory,"missing-engine.json")}
  const defaults=runtimePluginInsert({mode:"formal",surface:"web",sceneRoot:directory,engine:"isaac",grasp:"none",sdkEnvironment:env})
  const isaacPython=join(root,".runtime/conda/envs/isaac/bin/python")
  expect(defaults.find(row=>row.id==="lyapunov-scene-kit")?.config?.algorithmPython).toBe(isaacPython)
  expect(defaults.find(row=>row.id==="lyapunov-asset-bake")?.config?.python).toBe(isaacPython)
  const mujoco=runtimePluginInsert({mode:"formal",surface:"web",sceneRoot:directory,engine:"mujoco",grasp:"none",sdkEnvironment:{...env,LYAPUNOV_MUJOCO_PYTHON:"/selected/mujoco/bin/python",LYAPUNOV_ISAAC_PYTHON:"/unused/isaac/bin/python"}})
  expect(mujoco.find(row=>row.id==="lyapunov-scene-kit")?.config?.algorithmPython).toBe("/selected/mujoco/bin/python")
  expect(mujoco.find(row=>row.id==="lyapunov-asset-bake")?.config?.python).toBe("/selected/mujoco/bin/python")
})

test("native Models plugin is enabled and product overlays do not replace it", () => {
  const row = /^    - id: ui-settings-models\n((?: {6}.*\n)*)/m.exec(webBundle)?.[1]
  expect(row).toBeDefined()
  expect(row).toContain("name: '@deepseek-ai/dsh-client-ui-settings-models'")
  expect(row).not.toMatch(/disabled:\s*true/)
  expect(source).not.toContain("ui-settings-models")
  expect(productBundle).not.toContain("ui-settings-models")
  expect(source).toContain('patch+="- id: ui-agent-preset\\n  disabled: false\\n"')
  const web = runtimePluginInsert({mode:"local",surface:"web",sceneRoot:"/tmp/single-jobs-owner",engine:"mujoco"})
  expect(web.filter(plugin=>plugin.name==="@deepseek-ai/dsh-tool-jobs")).toHaveLength(0)
  const base = readFileSync(join(root, upstream, "packages/bundle/base/cordis.patch.yml"), "utf8")
  expect(base.match(/name: '@deepseek-ai\/dsh-tool-jobs'/g)).toHaveLength(1)
})

test("formal managed rows retain the gateway and environment-only credential", () => {
  const account = { apiUrl: "https://models.example.invalid", token: "runtime-model-secret-sentinel" }
  const rows = formalModelRows(account)
  expect(source).toContain('if(input.mode==="formal"||input.mode==="local")')
  expect(source).toContain("formalModelRows({apiUrl:input.accountApiUrl})")
  expect(rows).toContainEqual({ id: "llm-deepseek", disabled: true })
  expect(rows).toContainEqual({ id: "agent-default-model", config: { provider: "lyapunov-plans", model: "peiri" } })
  const options: PiAiOptions | undefined = rows.find(row => row.id === "llm-pi-ai")?.config
  expect(() => PiAiSchema(options)).not.toThrow()
  const provider = options?.providers?.["lyapunov-plans"]
  expect(provider).toMatchObject({ displayName: "Peiri", apiKeyEnv: "LYAPUNOV_ACCOUNT_TOKEN", baseURL: account.apiUrl + "/v1", managedBaseURL: account.apiUrl + "/v1" })
  expect(provider).not.toHaveProperty("apiKey")
  expect(JSON.stringify(rows)).not.toContain(account.token)
})

test("formal/local/guest消费旧Peiri Profile后清默认搜索，模型与客户端fetch保留", async () => {
  const box=await mkdtemp(join(tmpdir(),"lyapunov-native-lookup-")),savedUndo=process.env.LYAPUNOV_SESSION_UNDO
  try{
    process.env.LYAPUNOV_SESSION_UNDO="0"
    for(const mode of ["formal","local","guest"] as const){
      const dir=join(box,mode,"profiles","web");await mkdir(dir,{recursive:true})
      await writeFile(join(dir,"lyapunov-runtime.patch.yml"),"- id: web\n  config:\n    searchProvider: peiri\n    fetchProvider: legacy-server-fetch\n")
      const file=await runtimePatch({dir,mode,surface:"web",sceneRoot:join(box,mode,"scene"),accountApiUrl:"https://central.example.invalid/lyaup-unified",accountId:"fixture-owner",engine:"none"})
      const text=await readFile(file,"utf8"),rows=JSON.parse(text.split("\n").find(row=>row.startsWith("- insert: "))!.slice("- insert: ".length)) as RuntimePluginInsertForTest[]
      expect(text).not.toContain("searchProvider: peiri");expect(text).toContain("searchProvider: !!js undefined");expect(text).toContain("- id: web-search-deepseek\n  disabled: true")
      expect(text).not.toContain("legacy-server-fetch")
      expect(text).not.toContain("- id: web-fetch-http\n  disabled: true");expect(text).not.toContain("DEEPSEEK_API_KEY")
      // 真实Include替换config语义＋Loader !!js求值；不能只看YAML文字就称清掉SDK默认选路。
      const yaml=createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml') as {load(text:string,options:{schema:unknown}):unknown}
      const patches=yaml.load(text,{schema:entryListSchema}) as PatchOptions[],relevant=patches.filter(row=>row.id==='web'||row.id==='web-search-deepseek')
      for(const legacySearch of ['deepseek-official','peiri']){
        const effective=applyEntryPatches([{id:'web',config:{searchProvider:legacySearch,fetchProvider:'legacy-server-fetch'}},{id:'web-search-deepseek'}] as EntryOptions[],relevant,()=>{throw Error('相关配置必须匹配实际row')})
        const config=interpolate({},effective.find(row=>row.id==='web')!.config)
        expect(config).toEqual({searchProvider:undefined,fetchProvider:'http'});expect(effective.find(row=>row.id==='web-search-deepseek')?.disabled).toBe(true)
        const ctx=new Context();try{await ctx.plugin(Web,config);ctx.web.registerSearchProvider({id:'explicit-own',available:()=>true,async search(){return {sources:[],truncated:false}}});expect(await ctx.web.search({query:'fixture'})).toEqual({sources:[],truncated:false})}finally{await ctx.fiber.dispose()}
      }
      const api=rows.find(row=>row.id==="lyapunov-lyapunov-api-client")
      if(mode==="formal"){expect(api?.config).toEqual({apiUrl:"https://central.example.invalid/lyaup-unified",search:false});expect(text).toContain('"provider":"lyapunov-plans","model":"peiri"')}
      else{expect(api).toBeUndefined();expect(text).toContain(mode==="guest"?'"initiallyUnconfigured":true':'"provider":"lyapunov-plans","model":"peiri"')}
    }
  }finally{if(savedUndo===undefined)delete process.env.LYAPUNOV_SESSION_UNDO;else process.env.LYAPUNOV_SESSION_UNDO=savedUndo;await rm(box,{recursive:true,force:true})}
})
type RuntimePluginInsertForTest={id:string;config?:Record<string,unknown>}

test("developer model assembly stays native and the overlay contains no credential values", () => {
  expect(source).toContain('if(input.mode==="developer")')
  expect(modelSection).toContain("const agent=developerAgentDefaultModel()")
  expect(modelSection).toContain("models: ${JSON.stringify(developerDefaultCatalog())}")
  expect(modelSection).not.toMatch(/(?:apiKey|api_key|secret|password|token)\s*:/i)
  expect(modelSection).not.toContain("process.env")
  expect(modelSection).not.toContain("providers:")
})

/* ---------------------------------------------------------------------------------------------------
 * 托管链接切换的播报回归（本单唯一行为改动）。
 *
 * 事故（`bugfixHistory/RELEASE-UPGRADE-20260926.md` §7，实测不是推测）：已退场的旧安装对同一运行根启动后，
 * 托管链接 **317 条**从候选改指回旧安装，而 `script/runtime-patch.ts` 的唯一调用点把
 * `reconcileProductPackageLinks()` 返回的 `{updated,removed}` **丢掉了** ⇒ exit 0、无冲突、无告警。
 * 伤害是真的、检测也是有的，只是"发现了没说出来"。以下用例钉住"改前静默 / 改后可播报"这一条。
 * ------------------------------------------------------------------------------------------------- */

/** 造一个"可核实的自家安装"目录：`ownedProductLink()` 只认这套身份（见 `script/product-link.ts:27-45`）。 */
async function fixtureInstallation(root: string, names: readonly string[]) {
  await mkdir(join(root, "packages"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "lyapunov-dsh", private: true }))
  await writeFile(join(root, "UPSTREAM_LOCK.json"), JSON.stringify({ commit: "fixture-commit" }))
  for (const name of names) {
    const directory = join(root, "packages", name.split("/")[1]!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify({ name }))
  }
}

/**
 * 等价夹具（**全部落在系统临时目录**，不碰任何真实运行根，也不碰本仓 `.runtime/`）：
 * `parked/`＝已退场旧安装、`current/`＝当前安装，两边的产品包同名；Profile 的托管链接先指向 `parked`。
 * 这就是事故的形状——"链接所指的安装身份"与"正在运行的安装"不是同一个。
 */
async function fixtureProfile(names: readonly string[]) {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-link-switch-"))
  await fixtureInstallation(join(box, "parked"), names)
  await fixtureInstallation(join(box, "current"), names)
  const profile = join(box, "profile")
  await mkdir(join(profile, "node_modules", "@lyapunov"), { recursive: true })
  for (const name of names) {
    const short = name.split("/")[1]!
    await symlink(join(box, "parked", "packages", short), join(profile, "node_modules", "@lyapunov", short), "dir")
  }
  return { box, profile, parked: join(box, "parked"), current: join(box, "current") }
}

const AUDIT = (profile: string) => join(profile, PRODUCT_LINK_SWITCH_AUDIT)
const PACKAGES = ["@lyapunov/alpha", "@lyapunov/beta"] as const

test("有改动时播报改指条数与包名，0 改动时一行都不打（纯函数口径）", () => {
  const quiet = productLinkSwitchNotice({ profileDirectory: "/p", productRoot: "/i", updated: [], removed: [] })
  expect(quiet.lines).toEqual([])
  expect(quiet.audit).toBeUndefined()

  const loud = productLinkSwitchNotice({ profileDirectory: "/p", productRoot: "/i", updated: ["@lyapunov/alpha", "@lyapunov/beta"], removed: ["@lyapunov/gone"] })
  expect(loud.lines[0]).toContain("本次切换改指了 2 条托管链接")
  expect(loud.lines[0]).toContain("清理了 1 条")
  expect(loud.lines[0]).toContain("/p")
  expect(loud.lines[0]).toContain("/i") // 只改指 0 条时也要能看出"运行根现在被谁拥有"
  expect(loud.lines.join("\n")).toContain("@lyapunov/alpha")
  expect(loud.lines.join("\n")).toContain("@lyapunov/gone")
  expect(JSON.parse(loud.audit!)).toMatchObject({ profileDirectory: "/p", updated: ["@lyapunov/alpha", "@lyapunov/beta"], removed: ["@lyapunov/gone"] })

  // 只有清理、没有改指，同样必须播报（0 改动的静默不能顺手把这一类也吞掉）。
  const removedOnly = productLinkSwitchNotice({ profileDirectory: "/p", productRoot: "/i", updated: [], removed: ["@lyapunov/gone"] })
  expect(removedOnly.lines[0]).toContain("本次切换改指了 0 条托管链接")
  expect(removedOnly.lines).toHaveLength(2)
})

test("有改动：切换结果被消费并播报，审计记录落盘（替身 reconciler，不动任何链接）", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-link-report-"))
  try {
    const lines: string[] = []
    const report = await reconcileAndReportProductLinks({
      profileDirectory: box,
      productRoot: "/current",
      installAnchor: "/current/package.json",
      reconcile: async () => ({ updated: [...PACKAGES], removed: ["@lyapunov/gone"] }), // 替身：一条链接都不碰
      log: line => lines.push(line),
    })
    expect(report).toEqual({ updated: [...PACKAGES], removed: ["@lyapunov/gone"] }) // 返回值原样透出，未加工
    expect(lines[0]).toContain("本次切换改指了 2 条托管链接")
    expect(lines.join("\n")).toContain("@lyapunov/beta")
    const audit = (await readFile(AUDIT(box), "utf8")).trim().split("\n")
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]!)).toMatchObject({ profileDirectory: box, updated: [...PACKAGES] })
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("0 改动：不播报、不写审计（替身 reconciler，零噪声）", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-link-quiet-"))
  try {
    const lines: string[] = []
    const report = await reconcileAndReportProductLinks({
      profileDirectory: box,
      productRoot: "/current",
      installAnchor: "/current/package.json",
      reconcile: async () => ({ updated: [], removed: [] }),
      log: line => lines.push(line),
    })
    expect(report).toEqual({ updated: [], removed: [] })
    expect(lines).toEqual([]) // 幂等启动不许出现"切换 0 条"这类噪声行
    expect(existsSync(AUDIT(box))).toBe(false) // 也不留空文件
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("等价场景（真链接夹具 + 真 reconciler）：旧安装留下的链接被改指时播报，第二次启动静默", async () => {
  const { box, profile, parked, current } = await fixtureProfile(PACKAGES)
  try {
    const first: string[] = []
    const switched = await reconcileAndReportProductLinks({ profileDirectory: profile, productRoot: current, installAnchor: join(current, "package.json"), log: line => first.push(line) })
    expect([...switched.updated].sort()).toEqual(["@lyapunov/alpha", "@lyapunov/beta"]) // 真 reconcile 确实报了改动
    expect(switched.removed).toEqual([])
    expect(first[0]).toContain("本次切换改指了 2 条托管链接")
    expect(first[0]).toContain(current) // 说清"现在指向哪个安装"
    for (const name of ["alpha", "beta"]) {
      // 切换语义未变：链接真的落到了当前安装（本单只加播报，不改行为对错）
      expect(await readFile(join(profile, "node_modules", "@lyapunov", name, "package.json"), "utf8")).toContain(`@lyapunov/${name}`)
    }
    expect((await readFile(AUDIT(profile), "utf8")).trim().split("\n")).toHaveLength(1)
    expect(await readFile(join(parked, "package.json"), "utf8")).toContain("lyapunov-dsh") // 旧安装自身未被改写

    // 第二次启动（幂等）：0 改动 ⇒ 一个字都不打，审计也不再追加
    const second: string[] = []
    const idempotent = await reconcileAndReportProductLinks({ profileDirectory: profile, productRoot: current, installAnchor: join(current, "package.json"), log: line => second.push(line) })
    expect(idempotent).toEqual({ updated: [], removed: [] })
    expect(second).toEqual([])
    expect((await readFile(AUDIT(profile), "utf8")).trim().split("\n")).toHaveLength(1)
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("唯一调用点必须消费切换结果：不得再出现丢弃返回值的裸调用", () => {
  // 判据只看**真代码**：注释里可以引用旧写法（本单的历史说明就写了它），注释不算行为。
  const code = source.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n")
  const callSite = code.slice(code.indexOf('const path=join(input.dir,"lyapunov-runtime.patch.yml")'))
  expect(callSite).toContain("await reconcileAndReportProductLinks({")
  expect(code).not.toMatch(/await\s+reconcileProductPackageLinks\s*\(/) // 本单修的就是这一行
  expect(code).toContain("PRODUCT_LINK_SWITCH_AUDIT")
})

/* ---------------------------------------------------------------------------------------------------
 * 归因准确（`VERIFY-RUNTIME-PATCH-LINKS-20260926.md` 的裁定 ①）
 *
 * 验收队实测：那次现场的 **317 条**里只有 **33 条改指 + 4 条清理（37/317 = 11.7%）**流经本产品这一行，
 * 其余 **284 条**由上游 DSH 的 profile fallback linker 改指、本产品一个字没碰。
 * ⇒ 只播报"本次改指了 33 条"，会被读成"这次一共就动了 33 条"。
 *
 * 下面钉住的是**归因**，不是"接管上游"：本函数只逐条报它自己改的；不归本函数的那部分只报**范围与
 * 当前归属**（`censusModuleLinkScope`）；它的改指由 owner 在本次启动的归并里完成，改动计数由
 * `reconcileAndReportInstallationMirror` 单独播报，本函数不自行判定它的归属。
 * ------------------------------------------------------------------------------------------------- */

/** 只取真代码行（注释不算行为），与上面那条源码守卫同一口径。 */
const realCode = (text: string) => text.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n")
/** 丢弃返回值的裸调用：整行就是 `await fn(`（前面只有空白）。 */
const bareCalls = (code: string, fn: string) => code.split("\n").filter(line => new RegExp(`^\\s*await\\s+${fn}\\s*\\(`).test(line))

const AUDIT_LINES = async (profile: string) => (await readFile(AUDIT(profile), "utf8")).trim().split("\n")

test("归因播报：首行只数本函数改的，末尾把「不归本函数」的条数与总数一起说清", () => {
  const notice = productLinkSwitchNotice({
    profileDirectory: "/run/dsh/profiles/lyapunov-developer-web",
    productRoot: "/installs/current",
    updated: ["@lyapunov/alpha"],
    removed: [],
    scope: {
      inScope: { directory: "/run/dsh/profiles/lyapunov-developer-web/node_modules", total: 33, currentInstall: 33, otherInstall: 0, otherRoots: [] },
      outOfScope: { directory: "/run/dsh/profiles/node_modules", total: 284, currentInstall: 284, otherInstall: 0, otherRoots: [] },
    },
  })
  const text = notice.lines.join("\n")
  // 首行仍然只数"本函数改的"（口径没有放宽，含清理那类不受影响）
  expect(notice.lines[0]).toContain("本次切换改指了 1 条托管链接")
  // 范围：说清这 1 条数的是哪个目录
  expect(text).toContain("本函数只管辖 Profile 自己的 node_modules")
  expect(text).toContain("该目录现有软链 33 条")
  // 不归本函数的那半：点名目录 + 点名机制 + **明说归属与改指由该 owner 决定**
  expect(text).toContain("不归本函数：同级目录 /run/dsh/profiles/node_modules 另有 284 条链接")
  expect(text).toContain("RC2 原生 RuntimeResolution")
  expect(text).toContain("只报告物理归属，不改写这些链接")
  // ⇒ 这一行就是"不许把 33 当成全部"
  const total = notice.lines.at(-1)!
  expect(total).toContain("共 317 条")
  expect(total).toContain("本函数管辖 33 条")
  expect(total).toContain("不归本函数 284 条")
  expect(total).toContain("「本次改指 1 条」不是这个数")
})

test("归因播报：不归本函数的那部分指向别处时，报归属条数，但仍不声称是谁改的", () => {
  const lines = productLinkSwitchNotice({
    profileDirectory: "/run/dsh/profiles/lyapunov-developer-web",
    productRoot: "/installs/current",
    updated: [],
    removed: [],
    scope: { outOfScope: { directory: "/run/dsh/profiles/node_modules", total: 284, currentInstall: 0, otherInstall: 284, otherRoots: ["/installs/parked（284 条）"] } },
  }).lines
  const text = lines.join("\n")
  expect(lines[0]).toContain("本次切换 0 改动") // 0 改动也有话说：看的是归属，不是改动
  expect(text).toContain("284 条当前指向的不是本次安装")
  expect(text).toContain("/installs/parked（284 条）")
  expect(text).toContain("「本次改指 0 条」不是这个数")
  // 归因边界：只报"当前归属"，一个字都不说"谁在什么时候改的"
  expect(text).not.toContain("被改指")
  expect(text).toContain("只报告物理归属，不改写这些链接")
})

test("归因播报不制造噪声：本次 0 改动且不归本函数的那部分也没指向别处 ⇒ 一行都不打", () => {
  const quiet = productLinkSwitchNotice({
    profileDirectory: "/run/dsh/profiles/lyapunov-developer-web",
    productRoot: "/installs/current",
    updated: [],
    removed: [],
    scope: { outOfScope: { directory: "/run/dsh/profiles/node_modules", total: 284, currentInstall: 284, otherInstall: 0, otherRoots: [] } },
  })
  expect(quiet.lines).toEqual([])
  expect(quiet.audit).toBeUndefined()
})

test("归属普查：只数软链、按指向归类；认不出的归属记「归属未识别」，不猜一个安装根", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-link-census-"))
  try {
    const current = join(box, "installs", "current"), parked = join(box, "installs", "parked")
    await mkdir(join(current, "packages"), { recursive: true })
    await mkdir(join(parked, "packages"), { recursive: true })
    const profiles = join(box, "dsh", "profiles"), profile = join(profiles, "lyapunov-developer-web")
    await mkdir(join(profile, "node_modules", "@lyapunov"), { recursive: true })
    await mkdir(join(profiles, "node_modules", "@deepseek-ai"), { recursive: true })
    await mkdir(join(profiles, "node_modules", "@lyapunov"), { recursive: true }) // 真实目录：不是链接 ⇒ 不计入
    // 本函数管辖的槽位：1 条指向本次安装、1 条指向别处
    await symlink(join(current, "packages", "lyapunov-shell"), join(profile, "node_modules", "@lyapunov", "lyapunov-shell"), "dir")
    await symlink(join(parked, "packages", "lyapunov-viewer"), join(profile, "node_modules", "@lyapunov", "lyapunov-viewer"), "dir")
    // 不归本函数的同级依赖镜像：2 条 `.upstream` 形状 + 1 条认不出归属
    await symlink(join(parked, ".upstream", "dsh", "apps", "cli", "node_modules", "@deepseek-ai", "a"), join(profiles, "node_modules", "@deepseek-ai", "a"), "dir")
    await symlink(join(parked, ".upstream", "dsh", "apps", "cli", "node_modules", "@deepseek-ai", "b"), join(profiles, "node_modules", "@deepseek-ai", "b"), "dir")
    await symlink(join(box, "elsewhere"), join(profiles, "node_modules", "loose"), "dir")

    expect(await censusModuleLinkScope({ directory: join(profile, "node_modules"), installRoot: current }))
      .toEqual({ directory: join(profile, "node_modules"), total: 2, currentInstall: 1, otherInstall: 1, otherRoots: [`${parked}（1 条）`] })
    const outOfScope = await censusModuleLinkScope({ directory: join(profiles, "node_modules"), installRoot: current })
    expect(outOfScope).toMatchObject({ total: 3, currentInstall: 0, otherInstall: 3, otherRoots: [`${parked}（2 条）`, "归属未识别（1 条）"] })
    // 目录不在 ⇒ 没有这一层可报（不是"0 条"，是"没有"）
    expect(await censusModuleLinkScope({ directory: join(box, "nope"), installRoot: current })).toBeUndefined()
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("B3：Profile 预切换的槽位必须在这里播报（reconcile 再跑时它已『无改动』）", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-preswitch-"))
  try {
    const seen: string[] = []
    const changed = await linkProductBundleSlot({
      profileDirectory: box,
      productRoot: "/installs/current",
      link: async () => ({ updated: true }), // 替身：一条链接都不碰
      census: async () => ({ directory: join(box, "node_modules"), total: 1, currentInstall: 1, otherInstall: 0, otherRoots: [] }),
      log: line => seen.push(line),
    })
    expect(changed).toEqual({ updated: true }) // 原样透出，未加工
    expect(seen[0]).toContain("本次切换改指了 1 条托管链接")
    expect(seen.join("\n")).toContain("@lyapunov/product-bundle")
    const audit = await AUDIT_LINES(box)
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]!)).toMatchObject({ source: "prepareProfile", updated: ["@lyapunov/product-bundle"] })

    // 0 改动 ⇒ 一个字都不打，且**根本不去普查**（幂等启动零噪声、零多余 I/O）
    seen.length = 0
    const quiet = await linkProductBundleSlot({
      profileDirectory: box,
      productRoot: "/installs/current",
      link: async () => ({ updated: false }),
      census: async () => { throw new Error("0 改动不该走到普查") },
      log: line => seen.push(line),
    })
    expect(quiet).toEqual({ updated: false })
    expect(seen).toEqual([])
    expect(await AUDIT_LINES(box)).toHaveLength(1) // 审计也不再追加
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("同形第二处：旧 Profile 迁移的报告必须播报（此前整个丢掉），已迁移过的重启不重复打印", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-legacy-migrate-"))
  const base = { sourceProfile: "lyaup-developer-web", targetProfile: "lyapunov-developer-web", patchCopied: true, manifestMerged: true }
  try {
    const migrated: string[] = []
    const result = await migrateLegacyProfileAndReport({
      dshHome: box, mode: "developer", surface: "web", targetDir: box, log: line => migrated.push(line),
      migrate: async () => ({ ...base, status: "migrated" as const, linkedDependencies: ["@deepseek-ai/dsh-old"], missingDependencies: ["@deepseek-ai/dsh-gone"] }),
    })
    expect(result.status).toBe("migrated")
    expect(migrated[0]).toContain("旧 Profile 迁移")
    expect(migrated.join("\n")).toContain("已链接 → 本次安装：@deepseek-ai/dsh-old")
    expect(migrated.join("\n")).toContain("缺失（未链接）：@deepseek-ai/dsh-gone")

    const again: string[] = []
    await migrateLegacyProfileAndReport({
      dshHome: box, mode: "developer", surface: "web", targetDir: box, log: line => again.push(line),
      migrate: async () => ({ ...base, status: "already-migrated" as const, linkedDependencies: ["@deepseek-ai/dsh-old"], missingDependencies: [] }),
    })
    expect(again).toEqual([]) // 每次启动都重放同一份旧报告 = 噪声
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test("B4 + 同形第三处：github 入口与 build:plugins 也不得再丢掉切换/链接报告", () => {
  // github 入口：不但要消费返回值，这条入口此前**根本不 reconcile**（零次）。
  const github = realCode(readFileSync(join(root, "packages/lyapunov-product-bundle/src/github-cli.ts"), "utf8"))
  expect(github).toContain("await reconcileAndReportProductLinks({")
  expect(bareCalls(github, "linkProductPackage")).toEqual([])
  // build:plugins：`linkUpstream()` 的 {linked,updated,pruned} 此前在唯一调用点被整个丢掉。
  const build = realCode(readFileSync(join(root, "script/build-plugins.ts"), "utf8"))
  expect(bareCalls(build, "linkUpstream")).toEqual([])
  expect(build).toContain("const upstreamLinks=await linkUpstream(root)")
  for (const count of ["linked", "updated", "pruned"]) expect(build).toContain(`upstreamLinks.${count}`)
})

/**
 * ⚠️ **这是源码守卫，不是行为用例**（如实登记：`prepareProfile()` 会真写运行根、真建 profile，
 * 在单测里调用它不 hermetic —— 它还会经 `ensureWorkspaceMapping` 碰 `<产品根>/workspace`）。
 * 行为侧由上面两条用例覆盖（替身注入、tmpdir、不碰真实运行根）；这里钉的只是**接线本身**：
 * B3 的预切换与同形第二处的迁移报告必须走那两个会播报的入口，不得退回裸调用。
 */
test("B3 / 同形第二处的接线：prepareProfile 必须走会播报的入口，不得退回裸调用", () => {
  const profile = realCode(readFileSync(join(root, "script/profile.ts"), "utf8"))
  const prepareProfile = profile.slice(profile.indexOf("export async function prepareProfile("))
  expect(prepareProfile).toContain("await linkProductBundleSlot({")       // B3：预切换槽位
  expect(bareCalls(prepareProfile, "linkProductPackage")).toEqual([])
  expect(prepareProfile).toContain("await migrateLegacyProfileAndReport({") // 同形第二处：迁移报告
  expect(bareCalls(prepareProfile, "migrateLegacyProfile")).toEqual([])
})


test("原生桌面 computer-use 只在显式启用时装配", () => {
  const saved = {display:process.env.DISPLAY,enabled:process.env.LYAPUNOV_COMPUTER_USE}
  const input = {mode:"developer" as const,surface:"web",sceneRoot:"/tmp/cua-scope-fixture",engine:"mujoco" as const}
  const mounted = () => runtimePluginInsert(input).some(row=>row.id==="lyapunov-computer-use-cua-native")
  try {
    process.env.DISPLAY=":fixture"
    delete process.env.LYAPUNOV_COMPUTER_USE
    expect(mounted()).toBe(false)
    process.env.LYAPUNOV_COMPUTER_USE="0"
    expect(mounted()).toBe(false)
    process.env.LYAPUNOV_COMPUTER_USE="1"
    expect(mounted()).toBe(process.platform==="linux")
  } finally {
    if(saved.display===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=saved.display
    if(saved.enabled===undefined)delete process.env.LYAPUNOV_COMPUTER_USE;else process.env.LYAPUNOV_COMPUTER_USE=saved.enabled
  }
})

test("浏览器能力的装配面保持 launch/headless:false，且不注入 --no-sandbox", () => {
  // 浏览器进程关闭/Chromium 沙箱失败不允许用 --no-sandbox 绕过（用户明令）：产品只给模式配置，
  // 启动参数由上游 provider 决定；这里钉住产品面没有偷偷放宽，也钉住浏览器的开关语义。
  expect(realCode(readFileSync(join(root, "script/runtime-patch.ts"), "utf8"))).not.toContain("--no-sandbox")
  const saved = {display:process.env.DISPLAY,browser:process.env.LYAPUNOV_BROWSER_USE}
  const input = {mode:"developer" as const,surface:"web",sceneRoot:"/tmp/browser-assembly-fixture",engine:"none" as const}
  const rows = () => runtimePluginInsert(input)
  try {
    process.env.DISPLAY=":fixture"
    delete process.env.LYAPUNOV_BROWSER_USE
    const mounted = rows()
    expect(mounted.some(row => row.id === "lyapunov-browser-use")).toBe(true)
    expect(mounted.find(row => row.id === "lyapunov-browser-use-chrome-devtools-mcp")?.config)
      .toMatchObject({ mode: "launch", headless: false })
    process.env.LYAPUNOV_BROWSER_USE="0"
    expect(rows().some(row => row.id === "lyapunov-browser-use")).toBe(false)
  } finally {
    if(saved.display===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=saved.display
    if(saved.browser===undefined)delete process.env.LYAPUNOV_BROWSER_USE;else process.env.LYAPUNOV_BROWSER_USE=saved.browser
  }
})

/* ---------------------------------------------------------------------------------------------------
 * RC2 以原生 RuntimeResolution 和 PluginPackages 选择当前安装，不维护旧共享镜像的物理fallback。
 * 真链接夹具证明解析表与 Node 元数据查找都指向当前安装，旧链接和用户目录保持不变；
 * 播报/审计只记录读取到的安装映射与旧镜像物理归属，不将读取冒称为改指。
 * ------------------------------------------------------------------------------------------------- */

/** 造一个"当前安装"的可解析依赖闭包：lyapunov-dsh → @deepseek-ai/dsh-base → left-pad。 */
async function writeCurrentInstall(current: string) {
  await mkdir(join(current, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true })
  await mkdir(join(current, "node_modules", "left-pad"), { recursive: true })
  await writeFile(join(current, "package.json"), JSON.stringify({ name: "lyapunov-dsh", version: "1", dependencies: { "@deepseek-ai/dsh-base": "1" } }))
  await writeFile(join(current, "node_modules", "@deepseek-ai", "dsh-base", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-base", version: "1", dependencies: { "left-pad": "1" } }))
  await writeFile(join(current, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1" }))
}

/** 造一个"已退场旧安装"：目标目录真实存在，形状与现场一致（`.upstream/**`）。 */
async function writeOldInstall(old: string, names: readonly string[]) {
  for (const name of names) {
    const directory = join(old, ".upstream", "dsh", "node_modules", ...name.split("/"))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify({ name }))
  }
  await writeFile(join(old, "package.json"), JSON.stringify({ name: "lyapunov-dsh" }))
}

/**
 * 现场等价夹具（全部落在系统临时目录）：`old/`＝旧安装、`current/`＝当前安装、`dsh/profiles/node_modules`＝
 * 共享镜像。镜像里的旧安装槽位先指向 `old`；`user-custom` 与真实目录 `keep-me` 代表用户自定义模块。
 */
async function mirrorFixture(options: { custom?: boolean } = {}) {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-mirror-"))
  const current = join(box, "current"), old = join(box, "old")
  await writeCurrentInstall(current)
  await writeOldInstall(old, ["@deepseek-ai/dsh-base", "left-pad"])
  const home = join(box, "dsh"), profiles = join(home, "profiles"), profile = join(profiles, "lyapunov-local-web")
  await mkdir(join(profiles, "node_modules", "@deepseek-ai"), { recursive: true })
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "package.json"), JSON.stringify({ name: "lyapunov-local-web-profile", private: true }))
  await symlink(join(old, ".upstream", "dsh", "node_modules", "@deepseek-ai", "dsh-base"), join(profiles, "node_modules", "@deepseek-ai", "dsh-base"), "dir")
  await symlink(join(old, ".upstream", "dsh", "node_modules", "left-pad"), join(profiles, "node_modules", "left-pad"), "dir")
  if (options.custom) {
    await mkdir(join(box, "user-custom-target"), { recursive: true })
    await writeFile(join(box, "user-custom-target", "index.js"), "module.exports = 1\n")
    await symlink(join(box, "user-custom-target"), join(profiles, "node_modules", "user-custom"), "dir")
    await mkdir(join(profiles, "node_modules", "keep-me"), { recursive: true })
    await writeFile(join(profiles, "node_modules", "keep-me", "package.json"), JSON.stringify({ name: "keep-me", version: "1" }))
  }
  return { box, home, profile, current, old, profiles }
}

test("RC2 原生解析：当前安装映射生效，旧镜像保留且不制造物理切换", async () => {
  const fixture = await mirrorFixture()
  try {
    const lines: string[] = []
    const report = await reconcileAndReportInstallationMirror({
      profileDirectory: fixture.profile, productRoot: fixture.current,
      installAnchor: join(fixture.current, "package.json"), log: line => lines.push(line),
    })
    expect(report?.switched).toEqual([])
    expect(report?.otherInstall).toBe(2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("RC2 原生模块解析")
    expect(lines[0]).toContain("当前安装")
    expect(report?.resolution?.entries.find(row=>row.name==='left-pad')?.packageDir).toBe(join(fixture.current,'node_modules','left-pad'))
    const nativeResolver = spawnSync('/usr/local/bin/node', ['--input-type=module', '-e', `
      const { Context } = await import(process.argv[1]);
      const { PluginPackages } = await import(process.argv[2]);
      const resolution = JSON.parse(process.argv[3]);
      const ctx = new Context();
      try {
        await ctx.plugin(PluginPackages, { resolution });
        console.log(JSON.stringify(ctx.pluginPackages.packageOf('left-pad', process.argv[4])?.dir));
      } finally { await ctx.fiber.dispose(); }
    `, import.meta.resolve('@deepseek-ai/cordis'), import.meta.resolve('@deepseek-ai/dsh-app-boot'), JSON.stringify(report?.resolution), pathToFileURL(join(fixture.profile,'cordis.yml')).href], {encoding:'utf8',timeout:5000})
    expect(nativeResolver.status).toBe(0)
    expect(nativeResolver.stderr).toBe('')
    expect(JSON.parse(nativeResolver.stdout.trim())).toBe(join(fixture.current,'node_modules','left-pad'))

    // RC2 原生解析表指向当前安装，旧共享镜像的真实链接不被改写。
    for (const name of ["@deepseek-ai/dsh-base", "left-pad"]) {
      const target = await readFile(join(fixture.profiles, "node_modules", ...name.split("/"), "package.json"), "utf8")
      expect(target).toContain(`"name":"${name}"`)
    }
    const detail = JSON.parse((await readFile(join(fixture.profiles, INSTALLATION_MIRROR_AUDIT), "utf8")).trim())
    expect(detail).toMatchObject({ productRoot: fixture.current, otherInstall: 2 })
    expect(detail.switched).toEqual([])
    expect(detail.resolution.entries.find((row:{name:string})=>row.name==='left-pad').packageDir).toBe(join(fixture.current,'node_modules','left-pad'))
    expect(await readlink(join(fixture.profiles,'node_modules','left-pad'))).toContain(fixture.old)

    // 再次读取同一原生映射，仍不改链接；物理旧镜像归属读数继续如实记录。
    const second: string[] = []
    const again = await reconcileAndReportInstallationMirror({
      profileDirectory: fixture.profile, productRoot: fixture.current,
      installAnchor: join(fixture.current, "package.json"), log: line => second.push(line),
    })
    expect(again?.switched).toEqual([])
    expect(second).toHaveLength(1)
    expect((await readFile(join(fixture.profiles, INSTALLATION_MIRROR_AUDIT), "utf8")).trim().split("\n")).toHaveLength(2)
  } finally {
    await rm(fixture.box, { recursive: true, force: true })
  }
})

test("共享依赖镜像：用户自定义软链与真实目录被保留，未归并项如实报告而不是被藏起来", async () => {
  const fixture = await mirrorFixture({ custom: true })
  try {
    const lines: string[] = []
    const report = await reconcileAndReportInstallationMirror({
      profileDirectory: fixture.profile, productRoot: fixture.current,
      installAnchor: join(fixture.current, "package.json"), log: line => lines.push(line),
    })
    expect(report?.switched).toEqual([])
    expect(report?.otherInstall).toBe(3) // 两条旧镜像与user-custom都保留，解析表不据此授予新安装身份
    expect(report?.otherRoots.join("")).toContain("归属未识别")
    // 用户自定义软链指向没变；真实目录原样保留（owner 不 prune、产品不 rm）。
    expect(await readlink(join(fixture.profiles, "node_modules", "user-custom"))).toContain("user-custom-target")
    expect(await readFile(join(fixture.profiles, "node_modules", "keep-me", "package.json"), "utf8")).toContain("keep-me")
    expect(lines[0]).toContain("RC2 原生模块解析")
    expect(lines[0]).toContain("保留 3 条")
  } finally {
    await rm(fixture.box, { recursive: true, force: true })
  }
})

test("共享依赖镜像：锚点不在时不做任何写入，也不猜一个安装闭包", async () => {
  const fixture = await mirrorFixture()
  try {
    const lines: string[] = []
    const before = await readlink(join(fixture.profiles, "node_modules", "left-pad"))
    const report = await reconcileAndReportInstallationMirror({
      profileDirectory: fixture.profile, productRoot: fixture.current,
      installAnchor: join(fixture.box, "missing", "package.json"), log: line => lines.push(line),
    })
    expect(report?.switched).toEqual([])
    expect(report?.error).toContain("当前安装锚点不存在")
    expect(await readlink(join(fixture.profiles, "node_modules", "left-pad"))).toBe(before)
    expect(lines[0]).toContain("原生模块解析未完成")
    expect(lines[0]).toContain("当前安装锚点不存在")
  } finally {
    await rm(fixture.box, { recursive: true, force: true })
  }
})

test("共享依赖镜像：镜像目录不存在时零动作零输出（不制造噪声、不碰别的目录）", async () => {
  const box = await mkdtemp(join(tmpdir(), "lyapunov-mirror-absent-"))
  try {
    const lines: string[] = []
    const report = await reconcileAndReportInstallationMirror({
      profileDirectory: join(box, "profiles", "lyapunov-local-web"), productRoot: join(box, "current"),
      installAnchor: join(box, "current", "package.json"), log: line => lines.push(line),
    })
    expect(report).toBeUndefined()
    expect(lines).toEqual([])
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})


test('public chooser起点来自隔离前真实用户位置，Windows完全限定路径与WSL Linux Home分开',()=>{
  expect(publicChooserHome({HOME:'/home/customer',USERPROFILE:'C:\\Users\\customer'},'linux','/system/home')).toBe('/home/customer')
  expect(publicChooserHome({HOME:'/home/customer',USERPROFILE:'C:\\Users\\customer'},'win32','C:\\Users\\system')).toBe('C:\\Users\\customer')
  expect(publicChooserHome({HOME:'/home/wsl-user',USERPROFILE:'C:\\Users\\windows-user'},'linux','/system/home')).toBe('/home/wsl-user')
  expect(publicChooserHome({HOME:'relative'},'linux','/system/home')).toBe('/system/home')
  expect(publicChooserHome({USERPROFILE:'\\rooted-without-drive'},'win32','C:\\Users\\system')).toBe('C:\\Users\\system')
  expect(publicChooserHome({HOME:'/home/customer'},'linux','invalid-system-fallback')).toBe('/home/customer')
  expect(()=>publicChooserHome({},'linux','relative-system-home')).toThrow('fully qualified')
  const parent={HOME:'/home/customer',PATH:'/usr/bin',DEEPSEEK_API_KEY:'never-forward'}
  const rows=runtimePluginInsert({mode:'guest',surface:'web',sceneRoot:'/owned/runtime/guest/scene',engine:'none',grasp:'none',sdkEnvironment:parent})
  expect(rows.find(row=>row.id==='lyapunov-directory-browse')?.config).toEqual({homeDirectory:'/home/customer'})
  expect(JSON.stringify(rows)).not.toContain('never-forward')
  expect(parent.HOME).toBe('/home/customer')
})

test('实际web补丁禁首用自动默认工程，只保存chooser公共起点，不改已注册用户工程与model文件策略',async()=>{
  const box=await mkdtemp(join(tmpdir(),'lyapunov-public-home-overlay-')),savedUndo=process.env.LYAPUNOV_SESSION_UNDO
  try{
    process.env.LYAPUNOV_SESSION_UNDO='0';const dir=join(box,'profile');await mkdir(dir)
    const file=await runtimePatch({dir,mode:'guest',surface:'web',sceneRoot:join(box,'scene'),engine:'none',grasp:'none',sdkEnvironment:{HOME:'/home/customer'}})
    const yaml=await import('yaml'),patches=yaml.parse(await readFile(file,'utf8')) as PatchOptions[]
    const existing:EntryOptions[]=[{id:'workspace-controller',name:'@deepseek-ai/dsh-api-workspace-controller',config:{documentsDirectory:'/declared/existing-documents'}},{id:'directory-picker',name:'original-native-picker'}]
    const effective=applyEntryPatches(existing,patches,()=>{})
    expect(effective.find(row=>row.id==='workspace-controller')?.config).toEqual({autoInitializeDefault:false})
    expect(effective.find(row=>row.id==='lyapunov-directory-browse')?.config).toEqual({homeDirectory:'/home/customer'})
    expect(patches.some(row=>typeof row.config==='object'&&row.config!==null&&('cwd'in row.config||'permissionMode'in row.config))).toBe(false)
  }finally{if(savedUndo===undefined)delete process.env.LYAPUNOV_SESSION_UNDO;else process.env.LYAPUNOV_SESSION_UNDO=savedUndo;await rm(box,{recursive:true,force:true})}
})

test('已装known MCP贡献原生owner，计算机服务捕获父桌面目录且不带模型秘密', async()=>{
 const {installedKnownMcpDefaults}=await import('./known-mcp.ts')
 const box=await mkdtemp(join(tmpdir(),'known-mcp-'))
 try{
  const launcher=join(box,'.codex/plugins/cache/computer-use-linux/computer-use-linux/0.7.13/bin/computer-use-linux')
  await mkdir(join(launcher,'..'),{recursive:true});await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755})
  const env={HOME:box,DISPLAY:':8',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',DEEPSEEK_API_KEY:'must-not-copy'}
  const rows=installedKnownMcpDefaults(env,'linux')
  expect(rows.find(row=>row.kind==='computer-use-linux')).toMatchObject({command:join(root,'.runtime/computer-use-linux/official/computer-use-linux'),args:['mcp'],env:{HOME:box,DISPLAY:':8',XDG_STATE_HOME:join(box,'.local/state')}})
  expect(JSON.stringify(rows)).not.toContain('must-not-copy')
  expect(installedKnownMcpDefaults(env,'darwin').some(row=>row.kind==='computer-use-linux')).toBe(false)
  const shell=runtimePluginInsert({mode:'developer',surface:'web',sceneRoot:box,engine:'none',sdkEnvironment:env}).find(row=>row.id==='lyapunov-shell')!
  expect(shell.config?.knownMcpDefaults).toEqual(rows)
 }finally{await rm(box,{recursive:true,force:true})}
})


test('fresh HOME没有Codex仍优先产品固定供给，持有MIT/版本/checksum且明确缺件',async()=>{
 const {installedKnownMcpDefaults}=await import('./known-mcp.ts')
 const {ensureComputerUseLinux,computerUseLinuxReady,computerUseLinuxPaths}=await import('./computer-use-linux.ts')
 const box=await mkdtemp(join(tmpdir(),'known-mcp-fresh-'))
 try{
  const env={HOME:box,DISPLAY:':11',AT_SPI_BUS_ADDRESS:'unix:path=/tmp/explicit-ats-pi',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'}
  expect(installedKnownMcpDefaults(env,'linux').find(row=>row.kind==='computer-use-linux')).toMatchObject({command:computerUseLinuxPaths(undefined,'official').command,env:{HOME:box,DISPLAY:':11',AT_SPI_BUS_ADDRESS:'unix:path=/tmp/explicit-ats-pi'}})
  expect(computerUseLinuxReady()).toBe(true)
  expect(installedKnownMcpDefaults({...env,LYAPUNOV_COMPUTER_USE_LINUX_VARIANT:'local'},'linux').find(row=>row.kind==='computer-use-linux')?.command).toBe(computerUseLinuxPaths().command)
  expect(installedKnownMcpDefaults(env,'linux').find(row=>row.kind==='computer-use-linux')?.env.COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP).toBe('1')
  expect(installedKnownMcpDefaults({...env,COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP:'0'},'linux').find(row=>row.kind==='computer-use-linux')?.env.COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP).toBe('0')
  expect(installedKnownMcpDefaults({...env,LYAPUNOV_COMPUTER_USE_LINUX_VARIANT:'official'},'linux').find(row=>row.kind==='computer-use-linux')?.command).toBe(computerUseLinuxPaths(undefined,'official').command)
  expect(()=>installedKnownMcpDefaults({...env,LYAPUNOV_COMPUTER_USE_LINUX_VARIANT:'unknown'},'linux')).toThrow('COMPUTER_USE_LINUX_VARIANT_INVALID')
  expect(JSON.parse(await readFile(computerUseLinuxPaths().provenance,'utf8'))).toMatchObject({version:'0.7.13',activeDefault:'official',license:'MIT',assets:expect.arrayContaining([expect.objectContaining({name:'computer-use-linux',sha256:'c0f90d7249dfedfdb19a49fd4460799ae0a7d8f00e6a76bfea73cb4df36c170e'})])})
  await expect(ensureComputerUseLinux({root:box,env,offline:true})).rejects.toThrow('COMPUTER_USE_LINUX_LOCAL_ARCHIVE_MISSING')
  await expect(ensureComputerUseLinux({root:box,platform:'darwin'})).rejects.toThrow('COMPUTER_USE_LINUX_PLATFORM_UNSUPPORTED')
 }finally{await rm(box,{recursive:true,force:true})}
})

test('三个known原生默认包括Unity固定stdio供给，公开registry和optional更新参数明确',async()=>{
 const {installedKnownMcpDefaults}=await import('./known-mcp.ts')
 const {unityMcpSupplyPaths,unityMcpSupplyReady,prepareUnityMcpSupply}=await import('./unity-mcp-supply.ts')
 const box=await mkdtemp(join(tmpdir(),'unity-native-default-'))
 try{
  expect(unityMcpSupplyReady()).toBe(true)
  const env={HOME:box,PATH:'/usr/bin:/bin'}
  expect(installedKnownMcpDefaults(env).find(row=>row.kind==='unity')).toEqual({kind:'unity',command:unityMcpSupplyPaths().command,args:['--transport','stdio'],env:{UNITY_MCP_STATUS_DIR:join(box,'.unity-mcp'),FASTMCP_CHECK_FOR_UPDATES:'off',FASTMCP_SHOW_SERVER_BANNER:'false'}})
  expect(installedKnownMcpDefaults({...env,LYAPUNOV_UNITY_MCP_URL:'http://localhost:8888/mcp'}).some(row=>row.kind==='unity')).toBe(false)
  expect(await prepareUnityMcpSupply()).toMatchObject({version:'10.2.0',license:'MIT',editorIncluded:false,wheelSha256:'596e2a7322d829b6cf73510bad5ad87ba7e0ba2eee7e1b19645e8caf4ebf1460'})
 }finally{await rm(box,{recursive:true,force:true})}
})


test('Unity发行缓存无需distribution，三个pins损坏明确拒绝而不回退',async()=>{
 const {prepareUnityMcpSupply,unityMcpSupplyPaths,ensureUnityMcp}=await import('./unity-mcp-supply.ts')
 const box=await mkdtemp(join(tmpdir(),'unity-packed-cache-')),paths=unityMcpSupplyPaths(box)
 const wheel=readFileSync(join(root,'distribution/native/unity-mcp/mcpforunityserver-10.2.0-py3-none-any.whl')),license=readFileSync(join(root,'distribution/licenses/unity-mcp-10.2.0.LICENSE'))
 try{
  const metadata=await prepareUnityMcpSupply()
  await mkdir(join(paths.root,'cache'),{recursive:true});await writeFile(paths.wheel,wheel);await writeFile(paths.license,license);await writeFile(paths.provenance,JSON.stringify(metadata))
  expect(existsSync(join(box,'distribution'))).toBe(false)
  expect(await prepareUnityMcpSupply(box)).toEqual(metadata)
  await expect(ensureUnityMcp({root:box,env:{HOME:join(box,'fresh-home'),PATH:'/usr/bin:/bin'},offline:true,forceProduct:true})).rejects.toThrow('UNITY_MCP_RUNTIME_MISSING')
  await writeFile(paths.wheel,'damaged');await expect(prepareUnityMcpSupply(box)).rejects.toThrow('UNITY_MCP_WHEEL_CHECKSUM_FAILED');expect(await readFile(paths.wheel,'utf8')).toBe('damaged')
  await writeFile(paths.wheel,wheel);await writeFile(paths.license,'damaged');await expect(prepareUnityMcpSupply(box)).rejects.toThrow('UNITY_MCP_LICENSE_CHECKSUM_FAILED')
  await writeFile(paths.license,license);await writeFile(paths.provenance,JSON.stringify({...metadata,version:'invalid'}));await expect(prepareUnityMcpSupply(box)).rejects.toThrow('UNITY_MCP_PROVENANCE_PIN_MISMATCH')
  await rm(paths.provenance);await expect(prepareUnityMcpSupply(box)).rejects.toThrow('UNITY_MCP_PACKED_SUPPLY_INCOMPLETE')
 }finally{await rm(box,{recursive:true,force:true})}
})
