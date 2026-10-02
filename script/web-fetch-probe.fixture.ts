/** 已授权公开小文件探针：使用实际SDK HTTP provider/代理库，零认证，零大文件。 */
import { writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { HttpFetchProvider } from "../.upstream/deepseek-harness-20260911-candidate/packages/web/web-fetch-http/src/provider.ts"
import { installProxyFromEnvironment, proxyRouteFor } from "../.upstream/deepseek-harness-20260911-candidate/packages/util/http-proxy/src/index.ts"

const out = resolve(process.argv[2] ?? ".runtime/web-fetch-probe.json")
const provider = new HttpFetchProvider({ maxResponseBytes: 4096, maxBodyChars: 4096, timeoutMs: 5000, maxRedirects: 1, userAgent: "Lyapunov-public-small-file-probe" })
const urls = ["https://www.blender.org/robots.txt", "https://raw.githubusercontent.com/unitreerobotics/unitree_rl_gym/276801e46c5d433564f24658bac64f254b7d2d4b/LICENSE"]
const results: unknown[] = []
let diagnostics = 0
for (const mode of ["without-launcher-proxy", "actual-launcher-proxy"]) {
  const dispose = mode === "actual-launcher-proxy" ? await installProxyFromEnvironment({ get: (name: string) => {
    const value = process.env[name]
    return value === undefined ? undefined : { value, source: "process" }
  } } as never, () => { diagnostics++ }) : undefined
  try {
    for (const url of urls) {
      const start = performance.now()
      const proxied = proxyRouteFor(new URL(url)).proxied
      try {
        const result = await provider.fetch({ url })
        results.push({ mode, url, proxied, durationMs: Math.round(performance.now() - start), statusCode: result.statusCode, bodyKind: result.body.kind, truncated: result.truncated })
      } catch (error) {
        const e = error as { name?: string; code?: string; cause?: { code?: string } }
        results.push({ mode, url, proxied, durationMs: Math.round(performance.now() - start), errorType: e.name, code: e.code, causeCode: e.cause?.code, fallbackAction: "web_fetch_same_public_source", retryableRepeatedSameCall: false })
      }
    }
  } finally { await dispose?.() }
}
await mkdir(resolve(out, ".."), { recursive: true })
const evidence = { node: process.versions.node, maxResponseBytes: 4096, perCallTimeoutMs: 5000, proxyValuesOrCredentialsLogged: false, diagnosticsCount: diagnostics, paidAPIOrModelsCalled: false, results }
await writeFile(out, JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence))
