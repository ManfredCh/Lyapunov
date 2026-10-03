/**
 * SSOG（Streamed SOG v1）选层闭包的公共行为测试。
 *
 * 只用**内联合成清单**（不读用户 PLY/缓存/大素材，不联网）检验 `planSsogLod()` /
 * `safeSsogPath()` / `requireWholeSsogChunk()` 的外部契约：
 *  - 默认选 LOD0 最高细节，显式 LOD 选对资源；选择只依 `tree.file` 索引，不靠文件名猜。
 *  - 同一 chunk 可被多个叶区间引用；`requireWholeSsogChunk` 接受乱序但连续的完整覆盖，拒绝重叠/间隙/metaCount 不符。
 *  - 可选 `environment` 单列，不混入每层 counts；未指定时不造环境。
 *  - selectedLod 越界、counts 与引用不符、无效 file 索引、非法相对路径都会明确拒绝且不回退。
 *
 * 期望值均为手算的小常量，不在断言里重写遍历算法。
 */
import { describe, expect, test } from "bun:test"
import { planSsogLod, requireWholeSsogChunk, safeSsogPath, type SsogChunkPlan } from "../src/ssog-manifest.ts"

type Vec3 = [number, number, number]
const BOUND = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 }
type LodRow = { file: number; offset: number; count: number }
const leaf = (lods: Record<string, LodRow>) => ({ bound: BOUND, lods })

/** 打乱且无 LOD 数字前缀的真实相对 meta.json 路径：索引 2 才是 LOD0 用的路径。 */
const FILENAMES = [
  "tiles/zed/meta.json",
  "a/b/meta.json",
  "nested/deep/cache/meta.json",
  "q/meta.json",
]

/**
 * counts=[7,3]，count=10。三片叶：
 *   leafA: LOD0→file2[0,2)  LOD1→file1[0,1)
 *   leafB: LOD0→file0[0,4)  LOD1→file3[0,2)
 *   leafC: LOD0→file2[2,3)  无 LOD1（此层无点）
 * LOD0 合计 2+4+1=7；LOD1 合计 1+2=3。file2 被 leafA/leafC 两处引用。
 */
const baseManifest = () => ({
  version: 1,
  lodLevels: 2,
  counts: [7, 3],
  count: 10,
  filenames: [...FILENAMES],
  tree: {
    bound: BOUND,
    children: [
      leaf({ "0": { file: 2, offset: 0, count: 2 }, "1": { file: 1, offset: 0, count: 1 } }),
      {
        bound: BOUND,
        children: [
          leaf({ "0": { file: 0, offset: 0, count: 4 }, "1": { file: 3, offset: 0, count: 2 } }),
          leaf({ "0": { file: 2, offset: 2, count: 1 } }),
        ],
      },
    ],
  },
})

/** ranges 的推入顺序是遍历细节，语义上与顺序无关：比较前按 offset 归一。 */
const normChunks = (chunks: SsogChunkPlan[]) =>
  chunks.map(chunk => ({
    fileIndex: chunk.fileIndex,
    metaPath: chunk.metaPath,
    referencedCount: chunk.referencedCount,
    ranges: [...chunk.ranges].sort((a, b) => a.offset - b.offset),
  }))

describe("SSOG v1 选层：默认 LOD0 与显式其它层", () => {
  test("① 默认选 LOD0 最高细节，chunks/合计/资源路径正确", () => {
    const plan = planSsogLod(baseManifest())
    expect(plan.selectedLod).toBe(0)
    expect(plan.expectedGaussians).toBe(7)
    expect(plan.sourceBounds).toEqual(BOUND)
    expect(plan.chunks.map(c => c.fileIndex)).toEqual([0, 2])
    expect(normChunks(plan.chunks)).toEqual([
      { fileIndex: 0, metaPath: "tiles/zed/meta.json", referencedCount: 4, ranges: [{ offset: 0, count: 4 }] },
      { fileIndex: 2, metaPath: "nested/deep/cache/meta.json", referencedCount: 3, ranges: [{ offset: 0, count: 2 }, { offset: 2, count: 1 }] },
    ])
  })

  test("② 显式选 LOD1 得到该层资源，且缺该层的叶不被造点", () => {
    const plan = planSsogLod(baseManifest(), 1)
    expect(plan.selectedLod).toBe(1)
    expect(plan.expectedGaussians).toBe(3)
    expect(plan.chunks.map(c => c.fileIndex)).toEqual([1, 3])
    expect(normChunks(plan.chunks)).toEqual([
      { fileIndex: 1, metaPath: "a/b/meta.json", referencedCount: 1, ranges: [{ offset: 0, count: 1 }] },
      { fileIndex: 3, metaPath: "q/meta.json", referencedCount: 2, ranges: [{ offset: 0, count: 2 }] },
    ])
  })

  test("③ 选择只依 tree.file 索引：LOD0 命中索引 2 的无数字前缀路径", () => {
    const plan = planSsogLod(baseManifest())
    const chunk = plan.chunks.find(c => c.fileIndex === 2)!
    expect(chunk.metaPath).toBe(FILENAMES[2])
    expect(chunk.metaPath).toBe("nested/deep/cache/meta.json")
    expect(FILENAMES.some(name => /(^|\/)0[_-]/.test(name))).toBe(false)
  })
})

describe("同一 chunk 多叶区间引用 & 整块封装前置条件", () => {
  test("④ 同一 chunk 被两叶引用：ranges 合计正确，乱序但连续完整 ⇒ 接受", () => {
    const plan = planSsogLod(baseManifest())
    const chunk = plan.chunks.find(c => c.fileIndex === 2)!
    expect(chunk.referencedCount).toBe(3)
    expect([...chunk.ranges].sort((a, b) => a.offset - b.offset)).toEqual([{ offset: 0, count: 2 }, { offset: 2, count: 1 }])
    expect(() => requireWholeSsogChunk(chunk, 3)).not.toThrow()
  })

  test("⑤ 重叠区间 ⇒ SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE", () => {
    const overlap = {
      version: 1, lodLevels: 1, counts: [3], count: 3, filenames: ["c/meta.json"],
      tree: { bound: BOUND, children: [leaf({ "0": { file: 0, offset: 0, count: 2 } }), leaf({ "0": { file: 0, offset: 1, count: 1 } })] },
    }
    const chunk = planSsogLod(overlap).chunks[0]!
    expect(() => requireWholeSsogChunk(chunk, 3)).toThrow("SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE")
  })

  test("⑥ 区间有间隙 ⇒ SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE", () => {
    const gap = {
      version: 1, lodLevels: 1, counts: [3], count: 3, filenames: ["c/meta.json"],
      tree: { bound: BOUND, children: [leaf({ "0": { file: 0, offset: 0, count: 2 } }), leaf({ "0": { file: 0, offset: 3, count: 1 } })] },
    }
    const chunk = planSsogLod(gap).chunks[0]!
    expect(() => requireWholeSsogChunk(chunk, 3)).toThrow("SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE")
  })

  test("⑦ metadata count 与引用覆盖不符 ⇒ 拒绝", () => {
    const chunk = planSsogLod(baseManifest()).chunks.find(c => c.fileIndex === 2)!
    expect(() => requireWholeSsogChunk(chunk, 5)).toThrow("SSOG_CHUNK_PARTIAL_METHOD_UNAVAILABLE")
  })
})

describe("environment 与每层 counts 分离", () => {
  test("⑧ environment 单列，不混入每层 counts / 合计", () => {
    const plan = planSsogLod({ ...baseManifest(), environment: "env/meta.json" })
    expect(plan.environment).toBe("env/meta.json")
    expect(plan.levels).toEqual([{ lod: 0, gaussians: 7 }, { lod: 1, gaussians: 3 }])
    expect(plan.expectedGaussians).toBe(7)
    expect(plan.levels.reduce((sum, level) => sum + level.gaussians, 0)).toBe(10)
    expect(plan.levels[plan.selectedLod]!.gaussians).toBe(plan.expectedGaussians)
  })

  test("⑨ 未指定 environment 时不造环境字段", () => {
    const plan = planSsogLod(baseManifest())
    expect(plan.environment).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(plan, "environment")).toBe(false)
  })
})

describe("非法输入明确拒绝且不回退", () => {
  test("⑩ selectedLod 越界直接拒绝", () => {
    expect(() => planSsogLod(baseManifest(), 2)).toThrow("SSOG_MANIFEST_INVALID")
    expect(() => planSsogLod(baseManifest(), 2)).toThrow(/selectedLod/)
    expect(() => planSsogLod(baseManifest(), -1)).toThrow(/selectedLod/)
  })

  test("⑪ 总 count 与各层之和不符直接拒绝", () => {
    expect(() => planSsogLod({ ...baseManifest(), count: 9 })).toThrow(/count 不是各 LOD 层合计/)
  })

  test("⑫ 某层 tree 行数与 counts 不符：该层报错，不回退到别的层", () => {
    const mismatch = { ...baseManifest(), counts: [6, 3], count: 9 }
    expect(() => planSsogLod(mismatch, 0)).toThrow(/LOD0 tree 行数 7 与 counts 6 不符/)
    // 不回退：请求 LOD0 必须失败，而不是悄悄返回一致的 LOD1。
    const lod1 = planSsogLod(mismatch, 1)
    expect(lod1.selectedLod).toBe(1)
    expect(lod1.expectedGaussians).toBe(3)
  })

  test("⑬ file 索引越界 ⇒ 拒绝", () => {
    const manifest = baseManifest()
    manifest.tree.children[0] = leaf({ "0": { file: 9, offset: 0, count: 2 }, "1": { file: 1, offset: 0, count: 1 } })
    expect(() => planSsogLod(manifest, 0)).toThrow(/lod file\/offset\/count 无效/)
  })

  test("⑭ filenames 中基本非法相对路径 ⇒ 拒绝", () => {
    for (const badName of ["../escape/meta.json", "/abs/meta.json", "a/../b/meta.json", "a\\b/meta.json", "http://host/meta.json", "a//b/meta.json"]) {
      const manifest = baseManifest()
      manifest.filenames[2] = badName
      expect(() => planSsogLod(manifest)).toThrow("SSOG_MANIFEST_INVALID")
    }
  })

  test("⑮ safeSsogPath：合法子目录路径原样通过，越界/绝对/协议/反斜杠拒绝", () => {
    expect(safeSsogPath("nested/deep/cache/meta.json")).toBe("nested/deep/cache/meta.json")
    for (const badPath of ["", "/etc/meta.json", "../x/meta.json", "a/./b/meta.json", "a\\b/meta.json", "https://x/y/meta.json", "a?b/meta.json", "a#b/meta.json"]) {
      expect(() => safeSsogPath(badPath)).toThrow("SSOG_MANIFEST_INVALID")
    }
  })
})
