import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync } from "fflate"
import { inspectSogZipFile, parseSogMeta, writeSogZip } from "../src/sog-zip.ts"

const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQwAIVuP+BiOh/AAA=", "base64")
const names = ["meta.json", "means_l.webp", "means_u.webp", "scales.webp", "quats.webp", "sh0.webp"]
const meta = () => ({
  version: 2, count: 1,
  means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: names.slice(1, 3) },
  scales: { codebook: Array(256).fill(0), files: [names[3]] },
  quats: { files: [names[4]] },
  sh0: { codebook: Array(256).fill(0), files: [names[5]] },
})
const roots: string[] = []

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(image = WEBP): Promise<{ root: string; zip: string }> {
  const root = await mkdtemp(join(tmpdir(), "ssog-zip-")); roots.push(root)
  await writeFile(join(root, "meta.json"), JSON.stringify(meta()))
  for (const name of names.slice(1)) await writeFile(join(root, name), image)
  return { root, zip: join(root, "chunk.sog") }
}

describe("标准 SOG ZIP 的实际字节与取消边界", () => {
  it("流式原样封装与文件级校验读取全部引用成员", async () => {
    const { root, zip } = await fixture()
    const before = await Promise.all(names.map(name => readFile(join(root, name))))
    const output = await writeSogZip(zip, root, names)
    const fact = await inspectSogZipFile(zip, 1024 * 1024)
    expect(output.bytes).toBe((await readFile(zip)).length)
    expect(fact.count).toBe(1)
    expect(fact.archiveBytes).toBe(output.bytes)
    expect(fact.members.map(row => row.name)).toEqual(names)
    for (const [index, name] of names.entries()) expect(await readFile(join(root, name))).toEqual(before[index]!)
  })

  it("公开单文件 SOG 常见的 deflate ZIP 也按流校验，不要求 store 专有封装", async () => {
    const { root } = await fixture()
    const entries = Object.fromEntries(await Promise.all(names.map(async name => [name, new Uint8Array(await readFile(join(root, name)))])))
    const zip = join(root, "deflated.sog")
    const bytes = Buffer.from(zipSync(entries, { level: 6 }))
    expect(bytes.readUInt16LE(8)).toBe(8)
    await writeFile(zip, bytes)
    const fact = await inspectSogZipFile(zip, 1024 * 1024)
    expect(fact.count).toBe(1)
    expect(fact.members).toHaveLength(names.length)
  })

  it("12 字节 RIFF 伪图和缺引用文件不能被当成真实 SOG", async () => {
    const short = Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary")
    const { root, zip } = await fixture(short)
    await writeSogZip(zip, root, names)
    await expect(inspectSogZipFile(zip, 1024 * 1024)).rejects.toThrow(/SOG_IMAGE_INVALID/)
    const missing = { ...meta(), quats: { files: ["missing.webp"] } }
    expect(parseSogMeta(missing).members).toContain("missing.webp")
    await writeFile(join(root, "meta.json"), JSON.stringify(missing))
    for (const name of names.slice(1)) await writeFile(join(root, name), WEBP)
    const second = join(root, "missing.sog")
    await writeSogZip(second, root, names)
    await expect(inspectSogZipFile(second, 1024 * 1024)).rejects.toThrow(/SOG_MEMBER_MISSING/)
  })

  it("CRC 被改写会拒绝；已存在目标与预取消不会覆盖或创建产物", async () => {
    const { root, zip } = await fixture()
    await writeSogZip(zip, root, names)
    const archive = await readFile(zip)
    const marker = archive.indexOf(WEBP)
    expect(marker).toBeGreaterThan(0)
    archive[marker + 25] ^= 1
    const altered = join(root, "altered.sog")
    await writeFile(altered, archive)
    await expect(inspectSogZipFile(altered, 1024 * 1024)).rejects.toThrow(/SOG_ZIP_CRC_MISMATCH/)
    const original = await readFile(zip)
    await expect(writeSogZip(zip, root, names)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(zip)).toEqual(original)
    const controller = new AbortController(); controller.abort()
    await expect(writeSogZip(join(root, "aborted.sog"), root, names, controller.signal)).rejects.toThrow()
    await expect(readFile(join(root, "aborted.sog"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(inspectSogZipFile(zip, 1024 * 1024, controller.signal)).rejects.toThrow()
  })
})
