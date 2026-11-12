import { readFile } from "node:fs/promises"
import { join } from "node:path"

export async function readProductVersion(productRoot: string): Promise<string> {
  const file = join(productRoot, "package.json")
  const manifest = JSON.parse(await readFile(file, "utf8")) as { version?: unknown } | null
  const version = manifest?.version
  if (typeof version !== "string" || !version.trim()) throw new Error(`产品清单缺少版本号：${file}`)
  return version
}
