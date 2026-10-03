/**
 * 隔离启动的**环境搬运合同**（Marble 侧）：`script/profile.ts` 的 `backendEnvironment` 在 `isolated:true`
 * （终端 `script/terminal.ts:66`、管理员 Web Host `script/host.ts:47`）时只搬运插件**声明过**的键名。
 * Marble 侧此前没有清单，于是 `WORLDLABS_*` 那几个开发直连配置在隔离宿主里**读不到**（一个都不在图像/Tripo
 * 清单里，连顺带过去的都没有）。
 *
 * 这里钉住（照 `packages/generate-tripo/test/env-forwarding.test.ts` 的口径）：
 *   ① 声明清单 `MARBLE_DEVELOPER_ENV_KEYS` 与 `src/provider.ts` 的读取处一一对应（机械扫直接 `process.env.X` +
 *      `envInt("X")` 首参字面量，再逐条登记经 `requestTimeout` 包装器间接取名的超时项；多一条、少一条都失败）；
 *   ② 隔离 developer：清单里的键逐个到达子环境（值就是父进程那一份），清单外的父环境变量一个都不进。
 *
 * 注：本包**不经共享助手读任何 `OBJECT_GENERATOR_*`**（`generate-hunyuan/src/url-safety.ts` 只被 generate-hunyuan
 * 与 generate-tripo 复用），故清单只含 `WORLDLABS_*`。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendEnvironment } from "../../../script/profile.ts"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import { MARBLE_DEVELOPER_ENV_KEYS } from "../src/provider.ts"

/** 机械扫描：直接从 `process.env` 取名 + `envInt` 首参字面量（marble 只用这两个形态取配置）。 */
async function scanReadKeys(urls: (URL | string)[]): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const url of urls) {
    const source = await readFile(url, "utf8")
    // 每次现场构造（带 /g 的正则对象复用会串 lastIndex，Bun/V8 表现不一致）。
    for (const match of source.matchAll(/\b(?:env|envInt|envBool|requiredEnv|allowedHostsFromEnv)\(\s*"([A-Z][A-Z0-9_]*)"/g))
      keys.add(match[1]!)
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(match[1]!)
  }
  return keys
}

/**
 * 经 `requestTimeout(value, envKey, fallback)` → `envInt(envKey)` 间接取名、机械正则扫不到、但**确实被读**的
 * 超时项（照 generate-tripo 的 `TRANSITIVE` 口径逐条登记）。
 */
const INDIRECT = [
  "WORLDLABS_SUBMIT_TIMEOUT_MS",
  "WORLDLABS_POLL_REQUEST_TIMEOUT_MS",
  "WORLDLABS_MEDIA_REQUEST_TIMEOUT_MS",
] as const

/** 父进程里"用户配好的"那一份（**占位值**，不是真凭据；只为看它有没有到）。 */
const CONFIGURED: Record<string, string> = Object.fromEntries(
  MARBLE_DEVELOPER_ENV_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`]),
)
const OUTSIDE = "LYAPUNOV_UNRELATED_TEST_VALUE"

async function withPaths<T>(body: (paths: ReturnType<typeof runtimePaths>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "marble-env-forwarding-"))
  try {
    return await body(runtimePaths({ mode: "developer", root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("声明清单与 provider.ts 的读取处一一对应（防清单漂移：多一条、少一条都失败）", async () => {
  const read = await scanReadKeys([new URL("../src/provider.ts", import.meta.url)])
  const full = new Set<string>([...read, ...INDIRECT])
  assert.deepEqual([...full].sort(), [...MARBLE_DEVELOPER_ENV_KEYS].sort())
  // 间接项必须真的在源码里出现过（防"清单里有、实际不读"的腐化）。
  const source = await readFile(new URL("../src/provider.ts", import.meta.url), "utf8")
  for (const name of INDIRECT) assert.ok(source.includes(`"${name}"`), `${name} 应仍在源码中出现`)
  // 本包确实不读 OBJECT_GENERATOR_*（防把别的插件的键错并进来）。
  assert.ok(!/OBJECT_GENERATOR_[A-Z0-9_]+/.test(source), "generate-marble 不应读 OBJECT_GENERATOR_*")
})

test("隔离 developer：Marble 声明清单里的配置逐个到达子环境（值是父进程那一份），清单外不进", async () => {
  await withPaths(async (paths) => {
    const parent: Record<string, string> = { ...CONFIGURED, [OUTSIDE]: "placeholder-unrelated" }
    const env = await backendEnvironment("developer", paths, { isolated: true, parent })
    for (const key of MARBLE_DEVELOPER_ENV_KEYS) assert.equal(env[key], parent[key], key)
    assert.equal(env[OUTSIDE], undefined, `${OUTSIDE} 不该进隔离环境`)
  })
})
