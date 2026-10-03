/**
 * HDRI 资源登记（`.hdr`/`.exr`）的真实行为测试。
 *
 * 这里证明的是：**判据来自文件头而不是扩展名**——改名的 JPEG 不会因为叫 `.hdr` 就被登记成环境贴图，
 * 头里没有分辨率行也不会被放行；能登记时，mimeType 正好是 Viewer 的 `HDRI_MIME_TYPES` 认得的那两个，
 * 尺寸元数据来自文件头本身。夹具是测试自己按 Radiance/OpenEXR 头格式拼的字节，不代表真实天空像素；
 * 真实 4K 天空的加载与渲染由 `packages/lyapunov-shell/test/environment-lighting-live.ts` 用真文件证明。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseAsset } from "../src/formats.ts"

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "lyapunov-formats-hdri-")) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const fixture = async (name: string, content: Buffer | string): Promise<string> => {
  const path = join(base, name)
  await writeFile(path, content)
  return path
}

/**
 * 真实格式的 Radiance RGBE 头 **+ 真实扫描线数据**。
 *
 * 为什么必须带像素体：ENV-20 Round 4 起 `hdriMetadata()` 要求"分辨率行之后还有 ≥1 字节数据"
 * （`INVALID_HDR_PAYLOAD`）——真机上 112 B 的"头合法、零像素"截断件曾被静默登记成环境贴图，
 * 挂上去还报 `loaded:true`。所以合法夹具也必须是一个**有数据**的文件（每像素 4 字节）。
 */
const radiance = (options: { width: number; height: number; format?: string | null }): Buffer => {
  const lines = ["#?RADIANCE", "# 测试用天空", ...(options.format === null ? [] : [`FORMAT=${options.format ?? "32-bit_rle_rgbe"}`]), "", `-Y ${options.height} +X ${options.width}`, ""]
  // 像素体按"每像素 4 字节"给足（不按 RLE 压缩，判据只看有没有数据；这里也顺带是合法体量）。
  const pixels = Buffer.alloc(Math.max(4, options.width * options.height * 4))
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 128; pixels[index + 1] = 160; pixels[index + 2] = 200; pixels[index + 3] = 129
  }
  return Buffer.concat([Buffer.from(lines.join("\n"), "latin1"), pixels])
}
/** 头合法但**一个字节像素都没有**的截断件（真机那个 112 B 形状）；登记必须明确拒绝。 */
const radianceHeaderOnly = (options: { width: number; height: number; format?: string | null }): Buffer => {
  const lines = ["#?RADIANCE", "# 测试用天空", ...(options.format === null ? [] : [`FORMAT=${options.format ?? "32-bit_rle_rgbe"}`]), "", `-Y ${options.height} +X ${options.width}`, ""]
  return Buffer.from(lines.join("\n"), "latin1")
}
/** 真实格式的 OpenEXR 头（魔数 + 版本字段；后续内容登记不读）。 */
const exr = (version = 2): Buffer => {
  const head = Buffer.alloc(16)
  head.writeUInt32LE(0x01312f76, 0)
  head.writeUInt32LE(version, 4)
  return head
}

describe("HDRI 资源登记", () => {
  test("Radiance .hdr：mimeType 是 Viewer 认的那一个，宽高来自头里的分辨率行", async () => {
    const parsed = await parseAsset(await fixture("sky.hdr", radiance({ width: 4096, height: 2048 })))
    expect(parsed.kind).toBe("source")
    expect(parsed.mimeType).toBe("image/vnd.radiance")
    expect(parsed.metadata?.format).toBe("hdr")
    expect(parsed.metadata?.width).toBe(4096)
    expect(parsed.metadata?.height).toBe(2048)
    expect(parsed.metadata?.encoding).toBe("32-bit_rle_rgbe")
    expect(parsed.metadata?.encodingKind).toBe("rgbe")
  })

  test("xyze 编码记成 xyze；没有 FORMAT 行的旧式平铺文件仍可登记（Radiance 规范允许）", async () => {
    const xyze = await parseAsset(await fixture("xyze.hdr", radiance({ width: 8, height: 4, format: "32-bit_rle_xyze" })))
    expect(xyze.metadata?.encodingKind).toBe("xyze")
    const bare = await parseAsset(await fixture("bare.hdr", radiance({ width: 8, height: 4, format: null })))
    expect(bare.metadata?.width).toBe(8)
    expect(bare.metadata?.encoding).toBeUndefined()
  })

  test("扩展名是 .hdr 但内容不是 Radiance：拒绝，不静默当环境贴图", async () => {
    // JPEG 头改名成 .hdr —— 判据必须是文件头。
    await expect(parseAsset(await fixture("renamed.hdr", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])))).rejects.toThrow(/INVALID_HDR_HEADER/)
  })

  test("缺分辨率行、FORMAT 不认识：都拒绝（登记不了尺寸的贴图不能当环境用）", async () => {
    await expect(parseAsset(await fixture("nores.hdr", "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n"))).rejects.toThrow(/INVALID_HDR_RESOLUTION/)
    await expect(parseAsset(await fixture("badformat.hdr", radiance({ width: 4, height: 2, format: "16-bit_rle_rgbe" })))).rejects.toThrow(/UNSUPPORTED_HDR_FORMAT/)
  })

  test("OpenEXR .exr：mimeType 是 image/x-exr，版本号读自版本字段低字节；魔数不对就拒绝", async () => {
    const parsed = await parseAsset(await fixture("sky.exr", exr(2)))
    expect(parsed.kind).toBe("source")
    expect(parsed.mimeType).toBe("image/x-exr")
    expect(parsed.metadata?.format).toBe("exr")
    expect(parsed.metadata?.version).toBe(2)
    await expect(parseAsset(await fixture("renamed.exr", Buffer.from("#?RADIANCE\n")))).rejects.toThrow(/INVALID_EXR_HEADER/)
  })

  test("头合法但零像素数据：必须明确拒绝（INVALID_HDR_PAYLOAD），不得登记成环境贴图", async () => {
    // ENV-20 Round 4：真机 112 B 的截断件（头 + 分辨率行、没有扫描线）曾被登记成功并让 Viewer 报 loaded:true。
    await expect(parseAsset(await fixture("truncated.hdr", radianceHeaderOnly({ width: 16, height: 8 })))).rejects.toThrow(/INVALID_HDR_PAYLOAD/)
    await expect(parseAsset(await fixture("truncated-bare.hdr", radianceHeaderOnly({ width: 8, height: 4, format: null })))).rejects.toThrow(/INVALID_HDR_PAYLOAD/)
  })

  test("其它扩展名仍走原有拒绝路径（HDRI 支持没有放开别的格式）", async () => {
    await expect(parseAsset(await fixture("note.txt", "hello"))).rejects.toThrow(/UNSUPPORTED_RESOURCE_FORMAT/)
  })
})
