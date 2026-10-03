/**
 * ENV-20 许可最小承载的定向测试：**缺许可必须是 unknown**（不默认成任何具体许可），归一化不吃掉真实声明。
 * 真机读数见回执 Round 2 段（`asset_list` 回执里带 license，缺省为 unknown）。
 */
import { describe, expect, test } from "bun:test"
import { ResourceLibrary, normalizeResourceLicense, UNKNOWN_RESOURCE_LICENSE } from "../src/resources.ts"
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { solidGlb, box } from './glb-geometry-fixture.ts'

test('本地已登记资产按name/tags/folder查询复用，不调用Peiri或任何网络', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-resource-context-'))
  const path = join(root, 'cube.glb'), previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => { calls++; throw Error('LOCAL_ASSET_QUERY_MUST_NOT_NETWORK') }) as unknown as typeof fetch
  try {
    await writeFile(path, solidGlb({ generator: 'local-context', nodes: [{ name: 'cube', mesh: box() }] }))
    const library = new ResourceLibrary(join(root, 'library'))
    const record = await library.import({ path, name: 'Already imported cube', tags: ['local-body'], folder: 'own-assets' })
    expect((await library.list({ query: 'imported', folder: 'own-assets' }))[0]!.ref).toEqual(record.ref)
    expect((await library.list({ query: 'local-body' }))[0]!.ref).toEqual(record.ref)
    expect(await library.list({ query: 'missing' })).toEqual([])
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = previous
    await rm(root, { recursive: true, force: true })
  }
})

describe("许可归一化（缺省 unknown，不猜）", () => {
  test("没有许可事实 ⇒ 一律 unknown（undefined/null/空对象/空串 id/非对象）", () => {
    for (const value of [undefined, null, {}, { id: "" }, { id: "   " }, [], 42, "CC0-1.0", { url: "https://example.com" }]) {
      const license = normalizeResourceLicense(value)
      expect(license.id).toBe("unknown")
      expect(license.source).toBe("unknown")
      expect(license.url).toBeUndefined()
    }
    expect(UNKNOWN_RESOURCE_LICENSE.id).toBe("unknown")
  })

  test("字面写成 unknown 也收敛成 unknown（不许当具体许可）", () => {
    expect(normalizeResourceLicense({ id: "unknown" }).id).toBe("unknown")
    expect(normalizeResourceLicense({ id: "UNKNOWN" }).id).toBe("unknown")
  })

  test("显式声明原样透出（id/url/attribution/source=declared），空的可选字段不写", () => {
    const license = normalizeResourceLicense({ id: "CC0-1.0", url: " https://creativecommons.org/publicdomain/zero/1.0/ ", attribution: " Poly Haven " })
    expect(license).toEqual({ id: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: "Poly Haven", source: "declared" })
    expect(normalizeResourceLicense({ id: "MIT", url: "  ", attribution: "" })).toEqual({ id: "MIT", source: "declared" })
  })

  test("source=file 保留（从文件元数据读出的许可与调用方声明区分开）", () => {
    expect(normalizeResourceLicense({ id: "CC-BY-4.0", source: "file" }).source).toBe("file")
  })
})
