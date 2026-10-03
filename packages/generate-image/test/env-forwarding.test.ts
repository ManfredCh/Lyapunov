/**
 * 隔离启动的**环境搬运合同**（root-72 provider-env 探针那条真实路径：`script/profile.ts` 的 `backendEnvironment`）。
 *
 * 背景：终端入口（`script/terminal.ts`）与管理员 Web Host（`script/host.ts`）都以 `isolated:true` 启动，
 * 父进程环境被清成一个小白名单。图像插件的开发直连配置只能从宿主环境读（不能写进 Profile 补丁 YAML——
 * 那是普通可读文件），于是"用户明明配了 IMAGE_API_KEY，Host 里却报 missing key"。
 *
 * 这里钉住四件事，缺一条就是回到缺陷或走过头：
 *   ① 隔离 developer：声明清单里的键逐个到达子环境；
 *   ② 隔离 developer：清单外的父环境变量**一个都不进**（不是整体透传），HOME/XDG 仍然隔离；
 *   ③ 正式模式：供应商键一个都不搬（走中央账户网关），账户凭据照常注入；
 *   ④ 非隔离 developer：行为不变（本来就全量继承，本次没有扩大它）。
 * 另外用源码读取处与清单的等价性用例，挡住"清单漂移"。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendEnvironment } from "../../../script/profile.ts"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import { IMAGE_DEVELOPER_ENV_KEYS } from "../src/provider.ts"

/** 父进程里"用户配好的"那一份（占位值，不是真凭据；只为看它有没有到）。 */
const CONFIGURED = {
  IMAGE_API_KEY: "placeholder-image-key",
  DASHSCOPE_API_KEY: "placeholder-dashscope-key",
  IMAGE_API_BASE_URL: "http://127.0.0.1:9/substitute",
  IMAGE_WORKSPACE_ID: "placeholder-workspace",
  TRIPO_WORKSPACE_ID: "placeholder-tripo-workspace",
  IMAGE_MODEL: "placeholder-model",
  IMAGE_POLL_ATTEMPTS: "3",
  IMAGE_POLL_INTERVAL_MS: "500",
} as const

/** 清单外的父环境变量：用来证明没有"顺便全量透传"。 */
const OUTSIDE = {
  OTHER_PROVIDER_API_KEY: "placeholder-other-key",
  LYAPUNOV_UNRELATED_TEST_VALUE: "placeholder-unrelated",
  SSH_AUTH_SOCK: "/tmp/placeholder-agent.sock",
} as const

async function withPaths<T>(body: (paths: ReturnType<typeof runtimePaths>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "image-env-forwarding-"))
  try {
    return await body(runtimePaths({ mode: "developer", root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const presence = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(IMAGE_DEVELOPER_ENV_KEYS.map((key) => [key, env[key] !== undefined]))

test("隔离 developer（终端/管理员 Web 同路径）：声明清单里的配置逐个到达子环境", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { isolated: true, parent: { ...CONFIGURED } })
    assert.deepEqual(presence(env), Object.fromEntries(IMAGE_DEVELOPER_ENV_KEYS.map((key) => [key, true])))
    // 值确实搬的是父进程那一份（不是自造默认值）。
    for (const key of IMAGE_DEVELOPER_ENV_KEYS) assert.equal(env[key], CONFIGURED[key], key)
  })
})

test("隔离 developer：只搬清单里的键，清单外的父环境变量与凭据路径不被透传，HOME/XDG 仍隔离", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, {
      isolated: true,
      parent: { ...CONFIGURED, ...OUTSIDE, HOME: "/home/placeholder", XDG_CONFIG_HOME: "/home/placeholder/.config" },
    })
    for (const key of Object.keys(OUTSIDE)) assert.equal(env[key], undefined, `${key} 不该进隔离环境`)
    const privateRoot = join(paths.root, "private")
    assert.equal(env.HOME, privateRoot)
    assert.equal(env.XDG_CONFIG_HOME, join(privateRoot, "config"))
    assert.equal(env.XDG_DATA_HOME, join(privateRoot, "data"))
    // 原生通道仍在：DSH 自己的运行根/场景根由装配方显式给出，不靠父进程环境。
    assert.equal(env.DSH_HOME, paths.dshHome)
    assert.equal(env.LYAPUNOV_SCENE_ROOT, paths.sceneRoot)
  })
})

test("隔离 developer：父进程没配的键不会凭空出现（不造默认值、不借用别的变量）", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { isolated: true, parent: { PATH: process.env.PATH } })
    assert.deepEqual(presence(env), Object.fromEntries(IMAGE_DEVELOPER_ENV_KEYS.map((key) => [key, false])))
  })
})

test("正式模式：供应商键一个都不搬（走中央账户网关），账户凭据照常注入", async () => {
  await withPaths(async (paths) => {
    // 正式运行根按账号分域，这里给一个已验证账户替身（只用到 token/apiUrl）。
    const account = { token: "placeholder-account-token", apiUrl: "https://account.invalid", me: { user: { id: "user-1" } } }
    const formalPaths = runtimePaths({ mode: "formal", root: paths.root, accountId: "user-1" })
    const env = await backendEnvironment("formal", formalPaths, {
      account: account as never,
      isolated: true,
      parent: { ...CONFIGURED, LYAPUNOV_ACCOUNT_TOKEN: "placeholder-parent-token" },
    })
    assert.deepEqual(presence(env), Object.fromEntries(IMAGE_DEVELOPER_ENV_KEYS.map((key) => [key, false])))
    assert.equal(env.LYAPUNOV_ACCOUNT_TOKEN, "placeholder-account-token")
    assert.equal(env.LYAPUNOV_API_URL, "https://account.invalid")
    // 父进程的账号 token 不能顶掉已验证账户那一份。
    assert.notEqual(env.LYAPUNOV_ACCOUNT_TOKEN, "placeholder-parent-token")
  })
})

test("非隔离 developer：行为不变——本来就全量继承（本次改动没有扩大它）", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { parent: { ...CONFIGURED, ...OUTSIDE } })
    for (const key of IMAGE_DEVELOPER_ENV_KEYS) assert.equal(env[key], CONFIGURED[key], key)
    for (const key of Object.keys(OUTSIDE)) assert.equal(env[key], OUTSIDE[key as keyof typeof OUTSIDE], key)
  })
})

test("声明清单与 provider.ts 的读取处一一对应（防清单漂移：多一条、少一条都失败）", async () => {
  const source = await readFile(new URL("../src/provider.ts", import.meta.url), "utf8")
  const read = new Set([...source.matchAll(/\benv(?:Int)?\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]!))
  assert.deepEqual([...read].sort(), [...IMAGE_DEVELOPER_ENV_KEYS].sort())
})
