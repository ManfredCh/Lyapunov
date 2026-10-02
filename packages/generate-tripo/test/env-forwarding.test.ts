/**
 * 隔离启动的**环境搬运合同**（Tripo 侧，N328）：`script/profile.ts` 的 `backendEnvironment` 在
 * `isolated:true`（终端 `script/terminal.ts:66`、管理员 Web Host `script/host.ts:47`）时只搬运
 * 插件**声明过**的键名。图像侧早有 `IMAGE_DEVELOPER_ENV_KEYS`，Tripo 侧此前没有清单，于是
 * `TRIPO_API_BASE_URL` / `TRIPO_API_KEY` / 各档位与轮询键在隔离宿主里**读不到**——只有恰好也在图像
 * 清单里的 `DASHSCOPE_API_KEY` 与 `TRIPO_WORKSPACE_ID` 顺带过去。
 *
 * 这里钉住五件事，缺一条就是回到缺陷或走过头：
 *   ① 隔离 developer：`TRIPO_DEVELOPER_ENV_KEYS` 逐个到达子环境（值就是父进程那一份）；
 *   ② 隔离 developer：清单外的父环境变量一个都不进（不是整体透传），HOME 仍隔离；
 *   ③ 父进程没配的键不会凭空出现（不造默认值、不借用别的变量）；
 *   ④ 正式模式：供应商键一个都不搬（走中央账户网关）；
 *   ⑤ 清单与 `src/provider.ts` 的读取处一一对应（多一条、少一条都失败）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendEnvironment } from "../../../script/profile.ts"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import { IMAGE_DEVELOPER_ENV_KEYS } from "../../generate-image/src/provider.ts"
import { TRIPO_DEVELOPER_ENV_KEYS } from "../src/provider.ts"

/** 父进程里"用户配好的"那一份（**占位值**，不是真凭据；只为看它有没有到）。 */
const CONFIGURED = {
  TRIPO_API_KEY: "placeholder-tripo-key",
  DASHSCOPE_API_KEY: "placeholder-dashscope-key",
  TRIPO_API_BASE_URL: "http://127.0.0.1:9/substitute",
  TRIPO_WORKSPACE_ID: "placeholder-workspace",
  TRIPO_SUBMIT_PATH: "/placeholder/submit",
  TRIPO_QUERY_PATH: "/placeholder/query",
  TRIPO_TEXTURE_QUALITY: "detailed",
  TRIPO_GEOMETRY_QUALITY: "ultra",
  TRIPO_PBR: "1",
  TRIPO_TEXTURE: "1",
  TRIPO_MODEL: "Tripo/placeholder-model",
  TRIPO_POLL_ATTEMPTS: "3",
  TRIPO_POLL_INTERVAL_MS: "1500",
  TRIPO_REFERENCE_IMAGE_HOSTS: ".placeholder.invalid",
  OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS: "1",
} as const

/** 清单外的父环境变量：用来证明没有"顺便全量透传"。 */
const OUTSIDE = {
  OTHER_PROVIDER_API_KEY: "placeholder-other-key",
  LYAPUNOV_UNRELATED_TEST_VALUE: "placeholder-unrelated",
  SSH_AUTH_SOCK: "/tmp/placeholder-agent.sock",
} as const

async function withPaths<T>(body: (paths: ReturnType<typeof runtimePaths>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tripo-env-forwarding-"))
  try {
    return await body(runtimePaths({ mode: "developer", root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const presence = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(TRIPO_DEVELOPER_ENV_KEYS.map((key) => [key, env[key] !== undefined]))

test("隔离 developer（终端/管理员 Web 同路径）：Tripo 声明清单里的配置逐个到达子环境", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { isolated: true, parent: { ...CONFIGURED } })
    assert.deepEqual(presence(env), Object.fromEntries(TRIPO_DEVELOPER_ENV_KEYS.map((key) => [key, true])))
    // 值确实搬的是父进程那一份（不是自造默认值）。
    for (const key of TRIPO_DEVELOPER_ENV_KEYS) assert.equal(env[key], CONFIGURED[key], key)
  })
})

test("隔离 developer：图像清单也一起搬（两份清单取并集，交集按名字去重）", async () => {
  await withPaths(async (paths) => {
    const parent = {
      ...CONFIGURED,
      IMAGE_API_KEY: "placeholder-image-key",
      IMAGE_API_BASE_URL: "http://127.0.0.1:9/image-substitute",
      IMAGE_WORKSPACE_ID: "placeholder-image-workspace",
      IMAGE_MODEL: "placeholder-image-model",
      IMAGE_POLL_ATTEMPTS: "3",
      IMAGE_POLL_INTERVAL_MS: "500",
    }
    const env = await backendEnvironment("developer", paths, { isolated: true, parent })
    for (const key of IMAGE_DEVELOPER_ENV_KEYS) assert.equal(env[key], parent[key as keyof typeof parent], key)
    for (const key of TRIPO_DEVELOPER_ENV_KEYS) assert.equal(env[key], parent[key as keyof typeof parent], key)
    // 两份清单的交集只有两个名字：DASHSCOPE_API_KEY（凭据回落）与 TRIPO_WORKSPACE_ID（图像侧业务空间回落）。
    const union = new Set([...IMAGE_DEVELOPER_ENV_KEYS, ...TRIPO_DEVELOPER_ENV_KEYS])
    assert.equal(union.size, IMAGE_DEVELOPER_ENV_KEYS.length + TRIPO_DEVELOPER_ENV_KEYS.length - 2)
    assert.equal(env.DASHSCOPE_API_KEY, CONFIGURED.DASHSCOPE_API_KEY)
  })
})

test("隔离 developer：清单外的父环境变量与凭据路径不被透传，HOME/XDG 仍隔离", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, {
      isolated: true,
      parent: { ...CONFIGURED, ...OUTSIDE, HOME: "/home/placeholder", XDG_CONFIG_HOME: "/home/placeholder/.config" },
    })
    for (const key of Object.keys(OUTSIDE)) assert.equal(env[key], undefined, `${key} 不该进隔离环境`)
    const privateRoot = join(paths.root, "private")
    assert.equal(env.HOME, privateRoot)
    assert.equal(env.XDG_CONFIG_HOME, join(privateRoot, "config"))
    assert.equal(env.LYAPUNOV_SCENE_ROOT, paths.sceneRoot)
  })
})

test("隔离 developer：父进程没配的键不会凭空出现（不造默认值、不借用别的变量）", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { isolated: true, parent: { PATH: process.env.PATH } })
    assert.deepEqual(presence(env), Object.fromEntries(TRIPO_DEVELOPER_ENV_KEYS.map((key) => [key, false])))
  })
})

test("正式模式：供应商键一个都不搬（走中央账户网关）", async () => {
  await withPaths(async (paths) => {
    const account = { token: "placeholder-account-token", apiUrl: "https://account.invalid", me: { user: { id: "user-1" } } }
    const formalPaths = runtimePaths({ mode: "formal", root: paths.root, accountId: "user-1" })
    const env = await backendEnvironment("formal", formalPaths, { account: account as never, isolated: true, parent: { ...CONFIGURED } })
    assert.deepEqual(presence(env), Object.fromEntries(TRIPO_DEVELOPER_ENV_KEYS.map((key) => [key, false])))
  })
})

test("非隔离 developer：行为不变——本来就全量继承（本次改动没有扩大它）", async () => {
  await withPaths(async (paths) => {
    const env = await backendEnvironment("developer", paths, { parent: { ...CONFIGURED, ...OUTSIDE } })
    for (const key of TRIPO_DEVELOPER_ENV_KEYS) assert.equal(env[key], CONFIGURED[key], key)
    for (const key of Object.keys(OUTSIDE)) assert.equal(env[key], OUTSIDE[key as keyof typeof OUTSIDE], key)
  })
})

test("声明清单与 provider.ts 的读取处一一对应（防清单漂移：多一条、少一条都失败）", async () => {
  const source = await readFile(new URL("../src/provider.ts", import.meta.url), "utf8")
  const read = new Set(
    [...source.matchAll(/\b(?:env|envInt|envBool|requiredEnv|allowedHostsFromEnv)\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]!),
  )
  // 经共享助手读到的传递名不在本文件的字面量里：`allowPrivateAssetURLs()` →
  // `packages/generate-hunyuan/src/url-safety.ts:14-23` 读 `OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS`。
  const TRANSITIVE = ["OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS"]
  assert.deepEqual([...read, ...TRANSITIVE].sort(), [...TRIPO_DEVELOPER_ENV_KEYS].sort())
})
