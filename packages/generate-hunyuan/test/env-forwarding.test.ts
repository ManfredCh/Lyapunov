/**
 * 隔离启动的**环境搬运合同**（Hunyuan 侧）：`script/profile.ts` 的 `backendEnvironment` 在 `isolated:true`
 * （终端 `script/terminal.ts:66`、管理员 Web Host `script/host.ts:47`）时只搬运插件**声明过**的键名。
 * Hunyuan 侧此前没有清单，于是 `OBJECT_GENERATOR_*` / `HUNYUAN_3D_API_KEY` 那一大批开发直连配置在隔离宿主里
 * **读不到**（只有恰好也在图像/Tripo 清单里的 `DASHSCOPE_API_KEY`、`OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS` 顺带过去）。
 *
 * 这里钉住（照 `packages/generate-tripo/test/env-forwarding.test.ts` 的口径）：
 *   ① 声明清单 `HUNYUAN_DEVELOPER_ENV_KEYS` 与 `src/provider.ts`+`src/url-safety.ts` 的读取处一一对应
 *      （机械扫直接 `process.env.X` + `env/envInt/envBool/requiredEnv/allowedHostsFromEnv("X")` 首参字面量，
 *       再逐条登记经包装器/变量间接取名的项；多一条、少一条都失败）；
 *   ② 隔离 developer：清单里的键逐个到达子环境（值就是父进程那一份），清单外的父环境变量一个都不进；
 *   ③ `profile.ts` 四份清单（image/tripo/hunyuan/marble）并集按名字去重搬运：都到、交集只搬一份、清单外不进。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backendEnvironment } from "../../../script/profile.ts"
import { runtimePaths } from "../../lyapunov-product-bundle/src/runtime-paths.ts"
import { IMAGE_DEVELOPER_ENV_KEYS } from "../../generate-image/src/provider.ts"
import { TRIPO_DEVELOPER_ENV_KEYS } from "../../generate-tripo/src/provider.ts"
import { HUNYUAN_DEVELOPER_ENV_KEYS } from "../src/provider.ts"
import { MARBLE_DEVELOPER_ENV_KEYS } from "../../generate-marble/src/provider.ts"

/** 机械扫描：直接 `process.env.X` + `env/envInt/envBool/requiredEnv/allowedHostsFromEnv("X")` 首参字面量。 */
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
 * 经包装器/变量间接取名、机械正则扫不到、但**确实被读**的项（照 generate-tripo 的 `TRANSITIVE` 口径逐条登记）：
 *   `apiKeyPath` 的 `env(name)`（name 是 SUBMIT_PATH/QUERY_PATH 三元）；`callAPI`/preflight 的
 *   `requiredEnv(kind==="submit"?"…_SUBMIT_ACTION":"…_QUERY_ACTION")` 与 `requiredEnv(key)` 循环；
 *   `generationOptionsPayload` 的 `optionalEnvInt("OBJECT_GENERATOR_FACE_COUNT", …)`（包装器名不在机械表内）。
 */
const INDIRECT = [
  "OBJECT_GENERATOR_SUBMIT_PATH",
  "OBJECT_GENERATOR_QUERY_PATH",
  "OBJECT_GENERATOR_SUBMIT_ACTION",
  "OBJECT_GENERATOR_QUERY_ACTION",
  "OBJECT_GENERATOR_FACE_COUNT",
] as const

/** 父进程里"用户配好的"那一份（**占位值**，不是真凭据；只为看它有没有到）。 */
const CONFIGURED: Record<string, string> = Object.fromEntries(
  HUNYUAN_DEVELOPER_ENV_KEYS.map((key) => [key, `placeholder-${key.toLowerCase()}`]),
)
const OUTSIDE = "LYAPUNOV_UNRELATED_TEST_VALUE"

async function withPaths<T>(body: (paths: ReturnType<typeof runtimePaths>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hunyuan-env-forwarding-"))
  try {
    return await body(runtimePaths({ mode: "developer", root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("声明清单与 provider.ts+url-safety.ts 的读取处一一对应（防清单漂移：多一条、少一条都失败）", async () => {
  const read = await scanReadKeys([
    new URL("../src/provider.ts", import.meta.url),
    new URL("../src/url-safety.ts", import.meta.url),
  ])
  const full = new Set<string>([...read, ...INDIRECT])
  assert.deepEqual([...full].sort(), [...HUNYUAN_DEVELOPER_ENV_KEYS].sort())
  // 间接项必须真的在源码里出现过（防"清单里有、实际不读"的腐化）。
  const source = (await readFile(new URL("../src/provider.ts", import.meta.url), "utf8")) + (await readFile(new URL("../src/url-safety.ts", import.meta.url), "utf8"))
  for (const name of INDIRECT) assert.ok(source.includes(`"${name}"`), `${name} 应仍在源码中出现`)
})

test("隔离 developer：Hunyuan 声明清单里的配置逐个到达子环境（值是父进程那一份），清单外不进", async () => {
  await withPaths(async (paths) => {
    const parent: Record<string, string> = { ...CONFIGURED, [OUTSIDE]: "placeholder-unrelated" }
    const env = await backendEnvironment("developer", paths, { isolated: true, parent })
    for (const key of HUNYUAN_DEVELOPER_ENV_KEYS) assert.equal(env[key], parent[key], key)
    assert.equal(env[OUTSIDE], undefined, `${OUTSIDE} 不该进隔离环境`)
  })
})

test("profile.ts 四清单并集按名字去重搬运：四份清单的键都到、交集只搬一份、清单外不进", async () => {
  await withPaths(async (paths) => {
    const all = [
      ...IMAGE_DEVELOPER_ENV_KEYS,
      ...TRIPO_DEVELOPER_ENV_KEYS,
      ...HUNYUAN_DEVELOPER_ENV_KEYS,
      ...MARBLE_DEVELOPER_ENV_KEYS,
    ].map(String)
    const union = new Set(all)
    // 四份清单两两交集只三处：DASHSCOPE_API_KEY、TRIPO_WORKSPACE_ID（图像∩Tripo），
    // OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS（Tripo∩Hunyuan）。按名字去重后并集 = 逐份相加 − 3。
    for (const name of ["DASHSCOPE_API_KEY", "TRIPO_WORKSPACE_ID", "OBJECT_GENERATOR_ALLOW_PRIVATE_ASSET_URLS"])
      assert.equal(all.filter((key) => key === name).length, 2, name)
    assert.equal(union.size, all.length - 3)

    const parent: Record<string, string> = Object.fromEntries([...union].map((key) => [key, `placeholder-${key}`]))
    parent[OUTSIDE] = "placeholder-unrelated"
    const env = await backendEnvironment("developer", paths, { isolated: true, parent })
    for (const key of union) assert.equal(env[key], parent[key], key)
    assert.equal(env[OUTSIDE], undefined, `${OUTSIDE} 不该进隔离环境`)
  })
})
