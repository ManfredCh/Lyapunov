/**
 * ENV-20 Round 4：HDRI「头合法但零像素」必须**明确拒绝**（`INVALID_HDR_PAYLOAD`），合法件照旧通过。
 *
 * 真机缺陷（N167/Round 3）：112 B 的截断件（头 + 分辨率行、没有任何扫描线数据）被登记成功，
 * 挂到 `components.environment.hdri` 后 Viewer 报 `loaded:true` 且无 error/warning，画面只是一片黑。
 * 判据加在 `formats.ts` 的 `hdriMetadata()`（`.hdr` 分支）：分辨率行之后必须还有 ≥1 字节数据。
 *
 * 这三个用例都走**产品解析入口** `parseAsset()`（不是内部函数），与真机导入同一条路径。
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAsset } from "../src/formats.ts"

const HEADER = (format: string | null) => `${["#?RADIANCE", "# ENV-20 fixture", ...(format ? [`FORMAT=${format}`] : [])].join("\n")}\n\n-Y 8 +X 16\n`

/** 真实可解码的最小 RGBE 平铺数据（16×8×4 字节）：上半天色、下半天灰，与 lane 里那份同构。 */
function rgbePayload(): Buffer {
  const bytes: number[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const [r, g, b] = y < 4 ? [0.35 + 0.45 * (x / 16), 0.55 + 0.35 * (y / 4), 0.9] : [0.42, 0.40, 0.38]
      const max = Math.max(r, g, b)
      // frexp 的 JS 版（Bun/Node 的 Math 没有 frexp）：max = m·2^e, m∈[0.5,1)
      const e = Math.floor(Math.log2(max)) + 1
      const s = 2 ** (8 - e) / max
      bytes.push(Math.min(255, Math.trunc(r * s)), Math.min(255, Math.trunc(g * s)), Math.min(255, Math.trunc(b * s)), (e + 128) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

async function fixture(name: string, content: Buffer | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "env20-hdr-"))
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe("HDRI 载荷判据（ENV-20 Round 4）", () => {
  test("① 合法最小 HDRI（头 + 真像素）⇒ 解析通过并给出尺寸", async () => {
    const path = await fixture("ok.hdr", Buffer.concat([Buffer.from(HEADER("32-bit_rle_rgbe"), "latin1"), rgbePayload()]))
    const parsed = await parseAsset(path)
    expect(parsed.kind).toBe("source")
    expect(parsed.mimeType).toBe("image/vnd.radiance")
    expect(parsed.metadata).toMatchObject({ format: "hdr", width: 16, height: 8, encoding: "32-bit_rle_rgbe", encodingKind: "rgbe" })
  })

  test("② 头合法但零像素数据 ⇒ INVALID_HDR_PAYLOAD（真机那个 112 B 的形状）", async () => {
    const path = await fixture("truncated.hdr", HEADER("32-bit_rle_rgbe"))
    await expect(parseAsset(path)).rejects.toThrow("INVALID_HDR_PAYLOAD")
  })

  test("③ 无 FORMAT 行的旧式平铺件同样受判据约束（编码无关）", async () => {
    const ok = await fixture("flat-ok.hdr", Buffer.concat([Buffer.from(HEADER(null), "latin1"), rgbePayload()]))
    expect((await parseAsset(ok)).metadata).toMatchObject({ width: 16, height: 8 })
    const empty = await fixture("flat-empty.hdr", HEADER(null))
    await expect(parseAsset(empty)).rejects.toThrow("INVALID_HDR_PAYLOAD")
  })

  test("④ 分辨率行缺失仍报 INVALID_HDR_RESOLUTION（原有判据不回归）", async () => {
    const path = await fixture("no-res.hdr", "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
    await expect(parseAsset(path)).rejects.toThrow("INVALID_HDR_RESOLUTION")
  })

  test("⑤ 真件复核：lane 里那份 622 B v2（sha 608eee4cb59e90f5…）在真机上仍解析通过", async () => {
    const real = "/home/s18/WS/Lyapunov/Dev/.runtime/lane-env20b/env20-minimal-v2.hdr"
    if (!existsSync(real)) { console.log("跳过：lane 真件不在盘上", real); return }
    const bytes = await readFile(real)
    expect(createHash("sha256").update(bytes).digest("hex").slice(0, 16)).toBe("608eee4cb59e90f5")
    expect((await parseAsset(real)).metadata).toMatchObject({ format: "hdr", width: 16, height: 8 })
  })
})
