/**
 * 便携副本的版本身份：**字节变了就是新版本**。
 *
 * 版本身份的唯一依据仍是真实字节（`sameVersionAtAnotherLocation` 的逐依赖 sha256+size 判据一步没放松）。
 * 便携打包会把副本里指向包外的绝对引用改写成随包相对路径——副本的字节与原件不同，因此它**是另一个
 * 版本**：版本号由库按 `1 + max(已登记版本)` 分配，旧版本记录与它的字节一步不动；"来自哪个版本、打包
 * 器改写了哪几个文件"只作 `derivedFrom` 说明保留，**不参与身份判定**。随包文档里的引用与**当前场景**
 * 一起切到新版本：场景走一次原生 CAS 提交（`SceneStore.commit`，`expectedRevision` 是保存前读到的
 * revision），revision 如实前进。
 *
 * 所以这里没有任何"同一版本换一份字节"的通道，也没有拿调用方声明的内容戳去改写旧版本依赖的路径：
 * 调用方只能提供实测事实，库逐条按磁盘上的真实字节核对（source/target 的 before/after 都要对得上、
 * 必须真的改了字节、from 必须是已登记版本）。真正的几何/纹理改动拿不到旧版本号，只能成为新版本；
 * 副本与某个已登记版本逐字节一致时直接复用那个版本（`reused=true`），重复保存因此不涨版本。
 *
 * 全部用真的 SceneStore / ResourceLibrary（真文件、真 CAS）；涉及 .blend 的用例起配置的 Blender
 * 现场做工程（没有 Blender 时该组跳过），超时按 Blender 的真实耗时给足。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { ResourceRef } from "../../lyapunov-contracts/src/types.ts"
import { blenderEnvironment, blenderExecutable, inspectBlend } from "../src/blend-deps.ts"
import { localPath, parseAsset } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"
import type { ResourceRecord, ResourceVersionDerivation } from "../src/resources.ts"

let base: string, fixtures: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-identity-"))
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  operations = new SceneOperations(join(base, "data"))
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const rejection = (action: () => Promise<unknown>): Promise<Error> => action().then(() => { throw new Error("EXPECTED_REJECTION") }, error => error as Error)
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const stampOf = async (path: string) => ({ sha256: digest(await readFile(path)), size: (await readFile(path)).length })
const fileUri = (path: string): string => pathToFileURL(path).href
/** 目录清单（路径、大小、内容戳）：重复保存不该让它变。 */
async function treeInventory(root: string): Promise<{ files: number; bytes: number; digest: string }> {
  const rows: string[] = []
  const walk = async (directory: string) => {
    for (const row of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, row.name)
      if (row.isDirectory()) { await walk(path); continue }
      const bytes = await readFile(path)
      rows.push(`${relative(root, path)}\t${bytes.length}\t${digest(bytes)}`)
    }
  }
  await walk(root)
  return { files: rows.length, bytes: rows.reduce((sum, row) => sum + Number(row.split("\t")[1]), 0), digest: digest(Buffer.from(rows.join("\n"))) }
}
/** 库里该资源 id 的全部已登记版本，按版本号排序：验证"该涨的涨、重复保存不涨"。 */
async function versionRecords(resourceId: string): Promise<ResourceRecord[]> {
  const rows = await operations.resources.list({ allVersions: true })
  return rows.filter(row => row.ref.resourceId === resourceId).sort((left, right) => left.ref.version - right.ref.version)
}
async function versionNumbers(resourceId: string): Promise<number[]> {
  return (await versionRecords(resourceId)).map(row => row.ref.version)
}

/** 最小合法 GLB；`buffer` 给出时按 glTF 规范挂一个外部 .bin（闭包因此不止一个文件），`vertex` 是顶点 x。 */
function glbBytes(generator: string, buffer?: string, vertex = 1): Buffer {
  const json: any = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator, translation: [vertex, 0, 0] }], meshes: [{ primitives: [] }] }
  if (buffer) json.buffers = [{ uri: buffer, byteLength: 4 }]
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}
function glbRef(resourceId: string, path: string, version = 1): ResourceRef {
  const uri = fileUri(path)
  return { resourceId, version, original: { uri, mimeType: "model/gltf-binary" }, representations: [{ uri, mimeType: "model/gltf-binary", role: "visual" }], source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 } }
}

/* ────────── 库级派生版本登记：不用 Blender 的正反例 ────────── */

/**
 * 两文件闭包的资源（GLB + 外部 .bin）＋可以直接造出来的各种"另一个位置"：GLB 里 buffer 默认是绝对路径
 * （与 .blend 的外部绝对引用同形），`pathOnlyCopy` 只把这条引用改成随目录相对路径（打包器对 .blend/XML
 * 做的正是这件事：只改外部引用路径，字节也就变了），`changedCopy` 真把顶点从 x=1 挪到 x=8。
 */
async function projectFixture(name: string, bufferUri: "absolute" | "relative" = "absolute") {
  const source = join(base, name, "原件")
  await mkdir(source, { recursive: true })
  await writeFile(join(source, "buffer.bin"), "AAAA")
  const originalGlb = join(source, "model.glb")
  await writeFile(originalGlb, glbBytes(name, bufferUri === "absolute" ? join(source, "buffer.bin") : "buffer.bin"))
  const resourceId = `res_${name}`
  await operations.resources.registerReferences([{ ref: glbRef(resourceId, originalGlb), name }])
  const write = async (directory: string, glb: Buffer) => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "buffer.bin"), await readFile(join(source, "buffer.bin")))
    const target = join(directory, "model.glb")
    await writeFile(target, glb)
    return target
  }
  return {
    name, source, originalGlb, resourceId,
    ref: (path: string, version = 1) => glbRef(resourceId, path, version),
    /** 只改外部引用路径的副本：buffer 从绝对路径改成随目录相对路径，几何一个字节没动。 */
    pathOnlyCopy: (directory: string) => write(directory, glbBytes(name, "buffer.bin")),
    /** 真改了内容的副本（root 探针的形态：顶点 x 从 1 到 8）。 */
    changedCopy: (directory: string) => write(directory, glbBytes(name, "buffer.bin", 8)),
    /** 逐字节一模一样的副本（buffer 用相对引用的资源才有真正意义上的同一份闭包）。 */
    identicalCopy: async (directory: string) => {
      await mkdir(directory, { recursive: true })
      const target = join(directory, "model.glb")
      await writeFile(target, await readFile(originalGlb))
      await writeFile(join(directory, "buffer.bin"), await readFile(join(source, "buffer.bin")))
      return target
    },
    /** 派生声明：before/after 都是磁盘上的真实内容戳（调用方只能给实测事实）。 */
    declaration: async (from: number, files: Array<{ source: string; target: string }>): Promise<ResourceVersionDerivation> => ({
      kind: "external-path-rewrite", from, at: new Date().toISOString(),
      files: await Promise.all(files.map(async file => ({ ...file, before: await stampOf(file.source), after: await stampOf(file.target) }))),
    }),
  }
}

describe("派生版本登记：字节变了就是新版本，冒充不了旧版本", () => {
  test("只改外部引用路径的副本：登记为新版本（v2），旧版本与它的字节一步没动", async () => {
    const fixture = await projectFixture("path_only")
    const target = await fixture.pathOnlyCopy(join(base, "path_only", "副本"))
    expect(digest(await readFile(target))).not.toBe(digest(await readFile(fixture.originalGlb)))

    const registered = await operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target }]) })
    expect(registered.reused).toBe(false)
    expect(registered.ref.version).toBe(2)
    expect(await versionNumbers(fixture.resourceId)).toEqual([1, 2])

    // 新版本登记的是那份真实字节，来历只作说明。
    const second = await operations.resources.get(fixture.resourceId)
    expect(second.ref.version).toBe(2)
    expect(localPath(second.ref.original.uri)).toBe(target)
    expect(second.derivedFrom!.from).toBe(1)
    expect(second.derivedFrom!.files[0]!.source).toBe(fixture.originalGlb)
    expect(second.derivedFrom!.files[0]!.target).toBe(target)
    expect(second.derivedFrom!.files[0]!.after.sha256).toBe(digest(await readFile(target)))
    expect((await operations.resources.verify(fixture.resourceId)).valid).toBe(true)

    // 旧版本原样：位置、依赖戳、可校验性都没变（新版本不是"改写了旧版本的依赖"）。
    const first = await operations.resources.get(fixture.resourceId, 1)
    expect(localPath(first.ref.original.uri)).toBe(fixture.originalGlb)
    expect(first.derivedFrom).toBeUndefined()
    expect(first.parsed.dependencies.map(stamp => stamp.sha256).sort()).toEqual([digest(await readFile(fixture.originalGlb)), digest(await readFile(join(fixture.source, "buffer.bin")))].sort())
    expect((await operations.resources.verify(fixture.resourceId, 1)).valid).toBe(true)

    // 同一份副本再按 v2 登记一次（第二次便携保存把同一份改写副本登记到另一个包里就是这个形态）：
    // 逐字节与已登记的 v2 一致 ⇒ 复用，不立 v3。
    const again = await operations.resources.registerDerivedVersion({ ref: fixture.ref(target, 2), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target }]) })
    expect(again.reused).toBe(true)
    expect(again.ref.version).toBe(2)
    expect(await versionNumbers(fixture.resourceId)).toEqual([1, 2])
  })

  test("root 探针那一步：几何真改过的字节在旧版本号下进不来，只能成为新版本", async () => {
    const fixture = await projectFixture("probe")
    const target = await fixture.changedCopy(join(base, "probe", "改过的副本"))

    // 1) 换一个位置、字节变了，却仍按 v1 进来：判据一步没放松，冲突。
    expect((await rejection(() => operations.resources.registerReferences([{ ref: fixture.ref(target) }]))).message).toContain("RESOURCE_VERSION_SOURCE_CONFLICT")
    expect(await versionNumbers(fixture.resourceId)).toEqual([1])

    // 2) 走新版本通道：得到 v2，版本号由库分配，引用指向那份真实改过的字节。
    const registered = await operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target }]) })
    expect(registered.reused).toBe(false)
    expect(registered.ref.version).toBe(2)
    expect(digest(await readFile(localPath(registered.ref.original.uri)))).toBe(digest(await readFile(target)))
    // 旧版本的登记内容没被这次登记改写：它引用的仍是原件、依赖戳仍是原件那份字节。
    const first = await operations.resources.get(fixture.resourceId, 1)
    expect(localPath(first.ref.original.uri)).toBe(fixture.originalGlb)
    expect(first.parsed.dependencies.map(stamp => stamp.sha256).sort()).toEqual([digest(await readFile(fixture.originalGlb)), digest(await readFile(join(fixture.source, "buffer.bin")))].sort())

    // 3) 新版本号下这份字节是正当引用（重开场景文档走的就是这条路），而 v1 依旧只认原件那份字节。
    await operations.resources.registerReferences([{ ref: fixture.ref(target, 2) }])
    expect((await operations.resources.verify(fixture.resourceId)).valid).toBe(true)
    expect((await rejection(() => operations.resources.registerReferences([{ ref: fixture.ref(target, 1) }]))).message).toContain("RESOURCE_VERSION_SOURCE_CONFLICT")
  })

  test("就在原件位置上把字节改掉（root 探针的形态）：v1 立刻不可用，派生声明也只能立成新版本", async () => {
    const fixture = await projectFixture("in_place")
    const first = await operations.resources.get(fixture.resourceId, 1)
    const before = first.parsed.dependencies.find(stamp => localPath(stamp.path) === fixture.originalGlb)!
    // 顶点 x 1→8，路径没变、表示结构没变：老方案只凭调用方声明就能把它当成同一版本。
    await writeFile(fixture.originalGlb, glbBytes("in_place", join(fixture.source, "buffer.bin"), 8))
    const after = await stampOf(fixture.originalGlb)
    expect(after.sha256).not.toBe(before.sha256)

    // 1) 旧版本号下进来：立刻不可用（"已知位置但字节变了"如实报，不静默接受）。
    expect((await rejection(() => operations.resources.registerReferences([{ ref: fixture.ref(fixture.originalGlb) }]))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")

    // 2) 想把它写成"v1 的派生"：v1 那侧的源文件已被就地覆盖，声明对不上磁盘事实，拒绝。
    const forged = { kind: "external-path-rewrite" as const, from: 1, at: new Date().toISOString(), files: [{ source: fixture.originalGlb, target: fixture.originalGlb, before: { sha256: before.sha256!, size: before.size }, after }] }
    expect((await rejection(() => operations.resources.registerDerivedVersion({ ref: fixture.ref(fixture.originalGlb), derivation: forged }))).message).toContain("RESOURCE_VERSION_MISMATCH")
    expect(await versionNumbers(fixture.resourceId)).toEqual([1])

    // 3) 改过的字节走原生导入通道拿到明确的新版本号；旧版本的字节被就地覆盖，库如实报 changed，不谎称可用。
    const imported = await operations.resources.import({ path: fixture.originalGlb, resourceId: fixture.resourceId })
    expect(imported.ref.version).toBe(2)
    expect(digest(await readFile(localPath(imported.ref.original.uri)))).toBe(after.sha256)
    const firstNow = await operations.resources.verify(fixture.resourceId, 1)
    expect(firstNow.valid).toBe(false)
    expect(firstNow.changed.map(path => localPath(path))).toContain(fixture.originalGlb)
  })

  test("逐字节一致的副本：同一版本的另一处位置（内容同一性判据没放松，也不涨版本）", async () => {
    const fixture = await projectFixture("identical", "relative")
    const target = await fixture.identicalCopy(join(base, "identical", "副本"))
    expect(digest(await readFile(target))).toBe(digest(await readFile(fixture.originalGlb)))

    // 字节一模一样 = 同一个版本：换到副本上，原件保留为另一个位置，版本号不变。
    await operations.resources.registerReferences([{ ref: fixture.ref(target) }])
    expect(await versionNumbers(fixture.resourceId)).toEqual([1])
    const record = await operations.resources.get(fixture.resourceId)
    expect(localPath(record.ref.original.uri)).toBe(target)
    expect((record.alternateLocations ?? []).map(location => localPath(location.ref.original.uri))).toEqual([fixture.originalGlb])
    expect(record.derivedFrom).toBeUndefined()
    expect((await operations.resources.verify(fixture.resourceId)).valid).toBe(true)

    // 逐字节一致的副本不需要（也拿不到）派生声明：派生登记只收"字节真的变了"的副本。
    const another = await fixture.identicalCopy(join(base, "identical", "又一份"))
    const noChange = await fixture.declaration(1, [{ source: fixture.originalGlb, target: another }])
    expect((await rejection(() => operations.resources.registerDerivedVersion({ ref: fixture.ref(another), derivation: noChange }))).message).toContain("RESOURCE_DERIVATION_REQUIRED")
  })

  test("声明与磁盘/库里的真实事实不符：before 不是源文件那份、after 谎报、from 未登记、没改字节、空清单，各自被拒", async () => {
    const fixture = await projectFixture("bad_claims")
    const target = await fixture.pathOnlyCopy(join(base, "bad_claims", "副本"))
    const honest = await fixture.declaration(1, [{ source: fixture.originalGlb, target }])
    const attempt = (mutate: (declaration: ResourceVersionDerivation) => ResourceVersionDerivation) => operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: mutate(structuredClone(honest)) })

    // 声明的 before 不是源文件磁盘上的那份字节（凭空写的内容戳）。
    expect((await rejection(() => attempt(declaration => { declaration.files[0]!.before = { sha256: "0".repeat(64), size: 3 }; return declaration }))).message).toContain("RESOURCE_VERSION_MISMATCH")
    // 声明的 after 与副本磁盘上的真实字节不一致。
    expect((await rejection(() => attempt(declaration => { declaration.files[0]!.after = { sha256: "0".repeat(64), size: 3 }; return declaration }))).message).toContain("RESOURCE_VERSION_MISMATCH")
    // 声明的 source/target 根本不是磁盘上的文件。
    expect((await rejection(() => attempt(declaration => { declaration.files[0]!.target = join(base, "bad_claims", "并不存在.glb"); return declaration }))).message).toContain("RESOURCE_VERSION_MISMATCH")
    // from 不是该资源 id 的已登记版本。
    expect((await rejection(() => attempt(declaration => { declaration.from = 7; return declaration }))).message).toContain("RESOURCE_DERIVATION_SOURCE_UNKNOWN")
    // 声明的改写其实没改字节（逐字节一致的副本走复用，不另立版本）。
    const identical = await fixture.identicalCopy(join(base, "bad_claims", "一样的副本"))
    const noChange = await fixture.declaration(1, [{ source: fixture.originalGlb, target: identical }])
    expect((await rejection(() => operations.resources.registerDerivedVersion({ ref: fixture.ref(identical), derivation: noChange }))).message).toContain("RESOURCE_DERIVATION_REQUIRED")
    // 空清单 / 非改写类声明。
    expect((await rejection(() => operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: { ...structuredClone(honest), files: [] } }))).message).toContain("RESOURCE_DERIVATION_REQUIRED")
    expect((await rejection(() => operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: { ...structuredClone(honest), kind: "别的说法" as unknown as ResourceVersionDerivation["kind"] } }))).message).toContain("RESOURCE_DERIVATION_REQUIRED")

    // 全部被拒之后：库里只有 v1，副本没有被登记进来，旧版本的位置没被改。
    expect(await versionNumbers(fixture.resourceId)).toEqual([1])
    const record = await operations.resources.get(fixture.resourceId)
    expect(localPath(record.ref.original.uri)).toBe(fixture.originalGlb)
    expect((await operations.resources.verify(fixture.resourceId)).valid).toBe(true)
  })
})

/* ────────── 派生复用的跨版本匹配（root 74 探针的返修）────────── */

describe("派生复用：同一份真实字节只登记一个版本", () => {
  test("同源同目标重复登记 / 同字节另一位置都复用已有版本；真正不同字节才是新版本", async () => {
    const fixture = await projectFixture("reuse")
    const target = await fixture.pathOnlyCopy(join(base, "reuse", "副本"))

    // 1) 第一次：只改外部引用路径 ⇒ 新版本 v2。
    const first = await operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target }]) })
    expect({ version: first.ref.version, reused: first.reused }).toEqual({ version: 2, reused: false })

    // 2) 同源同目标再来一次（调用方的 ref 里仍是它声明的 v1，root 探针的形态）：命中 v2 的真实字节 ⇒ 复用。
    const repeat = await operations.resources.registerDerivedVersion({ ref: fixture.ref(target), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target }]) })
    expect({ version: repeat.ref.version, reused: repeat.reused }).toEqual({ version: 2, reused: true })
    expect(await versionNumbers(fixture.resourceId)).toEqual([1, 2])
    expect((await operations.resources.verify(fixture.resourceId, 2)).valid).toBe(true)

    // 3) 同一份字节落到另一个位置（第二个包）：仍是 v2 的另一处位置，不立新版本；返回的 ref 指向这次带来的位置。
    const copy = await fixture.pathOnlyCopy(join(base, "reuse", "另一个包"))
    expect(digest(await readFile(copy))).toBe(digest(await readFile(target)))
    const elsewhere = await operations.resources.registerDerivedVersion({ ref: fixture.ref(copy), derivation: await fixture.declaration(1, [{ source: fixture.originalGlb, target: copy }]) })
    expect({ version: elsewhere.ref.version, reused: elsewhere.reused }).toEqual({ version: 2, reused: true })
    expect(localPath(elsewhere.ref.original.uri)).toBe(copy)
    expect(await versionNumbers(fixture.resourceId)).toEqual([1, 2])
    const record = await operations.resources.get(fixture.resourceId, 2)
    expect((record.alternateLocations ?? []).map(location => localPath(location.ref.original.uri))).toContain(target)
    expect((await operations.resources.verify(fixture.resourceId, 2)).valid).toBe(true)

    // 4) 真正不同的字节：两条判据都不命中 ⇒ 新版本 v3；已登记的 v1/v2 一个都没被覆盖，判据也没放松。
    const changed = await fixture.changedCopy(join(base, "reuse", "改过几何"))
    const grown = await operations.resources.registerDerivedVersion({ ref: fixture.ref(changed), derivation: await fixture.declaration(2, [{ source: copy, target: changed }]) })
    expect({ version: grown.ref.version, reused: grown.reused }).toEqual({ version: 3, reused: false })
    expect(await versionNumbers(fixture.resourceId)).toEqual([1, 2, 3])
    expect((await operations.resources.verify(fixture.resourceId, 1)).valid).toBe(true)
    expect((await operations.resources.verify(fixture.resourceId, 2)).valid).toBe(true)
    expect((await rejection(() => operations.resources.registerReferences([{ ref: fixture.ref(changed, 2) }]))).message).toContain("RESOURCE_VERSION_SOURCE_CONFLICT")
  })
})

/* ────────── .blend 源工程：需要真实 Blender ────────── */

const blenderAvailable = (() => { try { execFileSync(blenderExecutable(), ["--version"], { stdio: "ignore", timeout: 60_000 }); return true } catch { return false } })()
const blender = (name: string, fn: () => Promise<void>): void => { (blenderAvailable ? test : test.skip)(name, fn, 600_000) }

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAH0lEQVR4nGP8z8DA8P8/AyMjOvn/////DFhIxkGpAwDJY2O5VAtmegAAAABJRU5ErkJggg==", "base64")
async function runBlender(args: string[]): Promise<void> {
  await new Promise<void>((settle, fail) => execFile(blenderExecutable(), args, { env: blenderEnvironment(), timeout: 300_000 }, error => error ? fail(error) : settle()))
}
/** 图片用绝对路径的源工程：便携保存必须改写副本里的外部引用（relative_remap=False，别把要测的绝对路径改掉）。 */
async function blendFixture(target: string, image: string): Promise<void> {
  await mkdir(dirname(image), { recursive: true })
  await writeFile(image, PNG)
  const script = `import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)\nimage = bpy.data.images.load(${JSON.stringify(image)})\nmaterial = bpy.data.materials.new("贴图材质")\nmaterial.use_nodes = True\nnode = material.node_tree.nodes.new("ShaderNodeTexImage")\nnode.image = image\nmaterial.node_tree.links.new(node.outputs["Color"], material.node_tree.nodes["Principled BSDF"].inputs["Base Color"])\nbpy.context.object.data.materials.append(material)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(target)}, relative_remap=False)\n`
  await runBlender(["--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", script])
}
/** 在既有 .blend 上做一次真实编辑（几何或纹理），只写这个文件。 */
async function editBlend(target: string, script: string): Promise<void> {
  const file = `${target}.edit.py`
  await writeFile(file, script)
  await runBlender(["--background", target, "--python-exit-code", "1", "--python", file])
}
/** 改几何：细分+缩放，结构指纹会变。 */
const GEOMETRY_EDIT = `import bpy\nbpy.ops.object.select_all(action="SELECT")\nbpy.ops.object.mode_set(mode="EDIT")\nbpy.ops.mesh.select_all(action="SELECT")\nbpy.ops.mesh.subdivide(number_cuts=2)\nbpy.ops.object.mode_set(mode="OBJECT")\nbpy.ops.wm.save_mainfile()\nprint("EDIT_GEOMETRY_OK")\n`
/** 改纹理内容：换一张图并打包进工程——纹理由此不再是原来那份。 */
const textureEdit = (swap: string) => `import bpy, base64\nopen(${JSON.stringify(swap)}, "wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAH0lEQVR4nGP8z8DA8P8/AyMjOvn/////DFhIxkGpAwDJY2O5VAtmegAAAABJRU5ErkJggg=="))\nimage = bpy.data.images.load(${JSON.stringify(swap)})\nimage.name = "换过的贴图"\nbpy.data.materials["贴图材质"].node_tree.nodes["Image Texture"].image = image\nbpy.ops.file.pack_all()\nbpy.ops.wm.save_mainfile()\nprint("EDIT_TEXTURE_OK")\n`

/** 就地工程（`scene_open` 登记、不进 CAS）：引用是文档相对路径，源工程就在工程目录里。 */
async function authoredProject(name: string, resourceId: string, sceneId: string) {  const authored = join(base, name)
  await mkdir(authored, { recursive: true })
  const blend = join(authored, "source.blend")
  await blendFixture(blend, join(authored, "textures", "贴图.png"))
  const ref: ResourceRef = { resourceId, version: 1, original: { uri: "source.blend", mimeType: "application/x-blender" }, representations: [{ uri: "source.blend", mimeType: "application/x-blender", role: "visual" }], source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } }
  await writeFile(join(authored, "scene.json"), JSON.stringify({ sceneId, revision: 0, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [{ entityId: "studio", name: "工作室", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [ref], components: { visual: { kind: "source" } } }] }))
  return { authored, blend, resourceId, sceneId, document: join(authored, "scene.json"), open: () => operations.open(join(authored, "scene.json")) }
}
/** 就地工程文档里写的是相对路径；核对"已知位置"时用绝对形态的引用。 */
function authoredRef(resourceId: string, path: string): ResourceRef {
  return { resourceId, version: 1, original: { uri: fileUri(path), mimeType: "application/x-blender" }, representations: [{ uri: fileUri(path), mimeType: "application/x-blender", role: "visual" }], source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } }
}

describe("便携副本的版本身份：保存→同一 Host 重开", () => {
  blender("import（原件进 CAS）→ portable：副本成为新版本 v2、场景 revision 前进，同一 catalog 重开可用", async () => {
    const sceneId = "scene_same_host", bundle = join(base, "便携", "scene.json")
    await operations.create({ sceneId })
    const blend = join(fixtures, "工作室.blend")
    await blendFixture(blend, join(fixtures, "贴图.png"))
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_studio", physicalize: false })
    const before = await operations.inspect(sceneId)

    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.derivedFiles?.length).toBe(1)
    // 回执给的是真实的派生事实：哪个版本派生出了哪个新版本、哪些文件的字节被改写（fromVersion → version）。
    const derived = saved.derivedSources!
    expect(derived.length).toBe(1)
    expect(derived[0]!.resourceId).toBe("res_studio")
    expect(derived[0]!.fromVersion).toBe(1)
    expect(derived[0]!.version).toBe(2)
    expect(derived[0]!.reused).toBe(false)
    expect(derived[0]!.files[0]!.path).toBe(saved.derivedFiles![0]!)
    expect(derived[0]!.files[0]!.before).toBe(digest(await readFile(blend)))
    expect(derived[0]!.files[0]!.after).toBe(digest(await readFile(join(dirname(bundle), derived[0]!.files[0]!.path))))

    // 当前场景按原生 CAS 提交切到新版本：revision 前进，引用指向包内副本（场景文档用绝对路径）。
    const live = await operations.inspect(sceneId)
    expect(live.revision).toBe(before.revision + 1)
    expect(live.entities[0]!.resources[0]!.version).toBe(2)
    expect(localPath(live.entities[0]!.resources[0]!.original.uri).startsWith(dirname(bundle))).toBe(true)

    const reopened = await operations.open(bundle)
    expect(reopened.sceneId).toBe(sceneId)
    expect(reopened.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    // 随包文档写下的就是 CAS 提交后的 revision：文档与当前场景是同一个 revision。
    expect(reopened.revision).toBe(live.revision)
    await operations.open(bundle)
    const record: ResourceRecord = await operations.resources.get("res_studio")
    expect(record.ref.version).toBe(2)
    expect(localPath(record.ref.original.uri).startsWith(dirname(bundle))).toBe(true)
    expect(record.derivedFrom!.from).toBe(1)
    expect((await operations.resources.verify("res_studio")).valid).toBe(true)

    // 旧版本与它的字节一步没动：v1 仍在库里、仍是 CAS 里那份原件、仍然校验通过。
    const first: ResourceRecord = await operations.resources.get("res_studio", 1)
    expect(first.ref.version).toBe(1)
    expect(digest(await readFile(localPath(first.ref.original.uri)))).toBe(derived[0]!.files[0]!.before)
    expect((await operations.resources.verify("res_studio", 1)).valid).toBe(true)
    expect(digest(await readFile(blend))).toBe(derived[0]!.files[0]!.before)
    // 改过路径的副本冒充不了 v1：拿包内副本按旧版本号进来仍然冲突。
    expect((await rejection(() => operations.resources.registerReferences([{ ref: { ...reopened.entities[0]!.resources[0]!, version: 1 } }]))).message).toContain("RESOURCE_VERSION_SOURCE_CONFLICT")
  })

  blender("就地工程（scene_open 登记、不入 CAS）→ portable：同 Host / 搬家 / 全新 catalog 都能开", async () => {
    const project = await authoredProject("就地工程", "res_local", "scene_local")
    const opened = await project.open()
    expect(localPath(opened.entities[0]!.resources[0]!.original.uri)).toBe(project.blend)
    const bundle = join(base, "搬走", "scene.json")
    const saved = await operations.save("scene_local", bundle, { portable: true })
    expect(saved.derivedSources!.length).toBe(1)
    expect(saved.derivedSources![0]!.fromVersion).toBe(1)
    expect(saved.derivedSources![0]!.version).toBe(2)
    // 就地工程的原件在包外：副本被改写 ⇒ 新版本；旧版本引用仍是工程里那份 source.blend。
    expect(localPath((await operations.resources.get("res_local", 1)).ref.original.uri)).toBe(project.blend)

    expect((await operations.open(bundle)).entities.map(entity => entity.entityId)).toEqual(["studio"])
    await operations.open(bundle)
    const record: ResourceRecord = await operations.resources.get("res_local")
    expect(record.ref.version).toBe(2)
    expect(localPath(record.ref.original.uri).startsWith(dirname(bundle))).toBe(true)
    expect((await versionNumbers("res_local"))).toEqual([1, 2])

    const moved = join(base, "搬到别处")
    await rename(dirname(bundle), moved)
    expect((await operations.open(join(moved, "scene.json"))).entities[0]!.entityId).toBe("studio")

    const fresh = new SceneOperations(join(base, "另一台机器", "catalog"))
    const onFresh = await fresh.open(join(moved, "scene.json"))
    expect(onFresh.sceneId).toBe("scene_local")
    for (const entity of onFresh.entities) for (const ref of entity.resources) for (const rep of [ref.original, ...ref.representations]) {
      expect(localPath(rep.uri).startsWith(moved)).toBe(true)
      expect(existsSync(localPath(rep.uri))).toBe(true)
    }
    // 包内源工程按产品口径仍可读：外部纹理在包里且已是相对引用。
    const inspection = await inspectBlend(localPath(onFresh.entities[0]!.resources[0]!.original.uri))
    expect(inspection.externals.map(row => row.raw.startsWith("//"))).toEqual([true])
    expect(inspection.externals[0]!.resolved.startsWith(moved)).toBe(true)
    expect(inspection.externals[0]!.exists).toBe(true)
  })

  blender("重复保存同一便携目录：不再改写 ⇒ 不立新版本，包体与包内字节都不变", async () => {
    const sceneId = "scene_repeat_identity", bundle = join(base, "重复保存", "scene.json")
    await operations.create({ sceneId })
    const blend = join(fixtures, "重复.blend")
    await blendFixture(blend, join(fixtures, "重复贴图.png"))
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_repeat", physicalize: false })

    const first = await operations.save(sceneId, bundle, { portable: true })
    const copied = join(dirname(bundle), first.derivedFiles![0]!)
    expect(first.derivedSources![0]!.fromVersion).toBe(1)
    expect(first.derivedSources![0]!.version).toBe(2)
    // 副本仍是"只改过外部引用"的同一工程：结构指纹与原件一致。
    expect(JSON.stringify((await inspectBlend(copied)).fingerprint)).toBe(JSON.stringify((await inspectBlend(blend)).fingerprint))

    // 第二次保存：引用已经指向包内副本，副本里没有可改写的绝对引用 ⇒ 不产生新的派生事实、不涨版本。
    const second = await operations.save(sceneId, bundle, { portable: true })
    expect(second.derivedSources ?? []).toEqual([])
    expect(second.derivedFiles ?? []).toEqual([])
    await operations.open(bundle)
    expect(await versionNumbers("res_repeat")).toEqual([1, 2])
    expect(localPath((await operations.resources.get("res_repeat")).ref.original.uri)).toBe(copied)

    // 重开过便携包（引用已指向包内副本）之后再保存回**同一个包**：包体不得增长、不得另立一份。
    const beforeRepack = await treeInventory(dirname(bundle))
    const third = await operations.save(sceneId, bundle, { portable: true })
    expect(third.derivedSources ?? []).toEqual([])
    expect(third.derivedFiles ?? []).toEqual([])
    expect(third.packagedFileCount).toBe(first.packagedFileCount)
    expect(await treeInventory(dirname(bundle))).toEqual(beforeRepack)
    expect(await versionNumbers("res_repeat")).toEqual([1, 2])
    expect((await operations.resources.verify("res_repeat")).valid).toBe(true)
  })

  blender("就地工程的源文件被改过几何：便携保存当场拒绝（不立新版本、不留半个包）", async () => {
    // 对照：这类就地工程本来就能便携保存（失败不是别的原因造成的）。
    const clean = await authoredProject("干净工程", "res_clean", "scene_clean")
    await clean.open()
    expect((await operations.save("scene_clean", join(base, "干净包", "scene.json"), { portable: true })).derivedSources!.length).toBe(1)

    const dirty = await authoredProject("改过的工程", "res_edited", "scene_edited")
    await dirty.open()
    expect(await versionNumbers("res_edited")).toEqual([1])
    await editBlend(dirty.blend, GEOMETRY_EDIT)
    const bundle = join(base, "改过的包", "scene.json")
    expect((await rejection(() => operations.save("scene_edited", bundle, { portable: true }))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")
    expect(existsSync(join(base, "改过的包", "sources"))).toBe(false)
    // 被拒的那次保存没有登记任何东西：这个资源只有 v1，没有新版本。
    expect(await versionNumbers("res_edited")).toEqual([1])
    // 旧版本不可变检查没有放松：改过的字节按 v1 进来仍然进不来（位置就是这个已知位置）。
    expect((await rejection(() => operations.resources.registerReferences([{ ref: { ...authoredRef("res_edited", dirty.blend), version: 1 } }]))).message).toMatch(/RESOURCE_VERSION_(UNAVAILABLE|SOURCE_CONFLICT)/)
  })

  blender("包内副本的几何被换过：同 Host 重开与再保存都拒绝（改过的字节不能被当成旧版本写一遍）", async () => {
    const sceneId = "scene_edited_bundle", bundle = join(base, "被改过的包", "scene.json")
    await operations.create({ sceneId })
    const blend = join(fixtures, "包.blend")
    await blendFixture(blend, join(fixtures, "包贴图.png"))
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_bundle", physicalize: false })
    const saved = await operations.save(sceneId, bundle, { portable: true })
    const copied = join(dirname(bundle), saved.derivedFiles![0]!)
    expect((await operations.open(bundle)).sceneId).toBe(sceneId)
    expect((await operations.resources.get("res_bundle")).ref.version).toBe(2)

    await editBlend(copied, GEOMETRY_EDIT)
    expect((await rejection(() => operations.open(bundle))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")
    // 编辑过的副本已经不等于已登记的 v2 字节：再保存同样拒绝，不会被当成"旧版本又写了一遍"。
    expect((await rejection(() => operations.save(sceneId, bundle, { portable: true }))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")
    // 也没有悄悄多出一个版本来吸收改过的字节。
    expect(await versionNumbers("res_bundle")).toEqual([1, 2])
  })

  blender("包内副本的纹理被换过（打包进工程）：同 Host 重开拒绝", async () => {
    const sceneId = "scene_edited_texture", bundle = join(base, "被换过贴图的包", "scene.json")
    await operations.create({ sceneId })
    const blend = join(fixtures, "贴图包.blend")
    await blendFixture(blend, join(fixtures, "贴图包.png"))
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_texture", physicalize: false })
    const saved = await operations.save(sceneId, bundle, { portable: true })
    const copied = join(dirname(bundle), saved.derivedFiles![0]!)
    expect((await operations.open(bundle)).sceneId).toBe(sceneId)

    await editBlend(copied, textureEdit(join(fixtures, "换过的贴图.png")))
    expect((await rejection(() => operations.open(bundle))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")
  })

  blender("包内那张**松散外部纹理**被改过（.blend 本身没动）：同 Host 重开与再保存都拒绝（74 负例 C1 的返修）", async () => {
    const project = await authoredProject("松散纹理", "res_loose", "scene_loose")
    const texture = join(project.authored, "textures", "贴图.png")
    await project.open()
    // 1) 登记时就按真实字节读出了外部纹理：依赖集里是磁盘上的那份内容，不是只写在报告里的元数据。
    const first = await operations.resources.get("res_loose", 1)
    const declared = first.parsed.dependencies.find(stamp => localPath(stamp.path) === texture)
    expect(declared).toBeDefined()
    expect(declared!.sha256).toBe(digest(await readFile(texture)))
    const metadata = first.parsed.metadata.externals as { source: string; files: string[] }
    expect(metadata.source).toBe("blender")
    expect(metadata.files).toContain(texture)

    const bundle = join(base, "松散纹理", "包", "scene.json")
    const saved = await operations.save("scene_loose", bundle, { portable: true })
    expect(saved.derivedSources![0]!.version).toBe(2)
    const packagedBlend = join(dirname(bundle), saved.derivedFiles![0]!)
    // 2) 新版本的依赖集指向包内的那份纹理；干净重开先通过（下面拒绝不是因为别的原因）。
    const second = await operations.resources.get("res_loose", 2)
    const packaged = second.parsed.dependencies.map(stamp => localPath(stamp.path)).filter(path => path.endsWith(".png"))
    expect(packaged.length).toBe(1)
    expect(packaged[0]!.startsWith(dirname(bundle))).toBe(true)
    expect((await operations.resources.verify("res_loose", 2)).valid).toBe(true)
    expect((await operations.open(bundle)).sceneId).toBe("scene_loose")

    // 3) 只改包内那张松散纹理（.blend 一个字节没动）：旧版本号重开必须被拒，verify 如实指出是哪一份。
    const blendBytesBefore = digest(await readFile(packagedBlend))
    await writeFile(packaged[0]!, Buffer.concat([await readFile(packaged[0]!), Buffer.from("改过的纹理字节")]))
    expect(digest(await readFile(packagedBlend))).toBe(blendBytesBefore)
    const broken = await operations.resources.verify("res_loose", 2)
    expect(broken.valid).toBe(false)
    expect(broken.changed.map(path => localPath(path))).toContain(packaged[0]!)
    expect((await rejection(() => operations.open(bundle))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")
    expect((await rejection(() => operations.save("scene_loose", bundle, { portable: true }))).message).toContain("RESOURCE_VERSION_UNAVAILABLE")

    // 4) 原件与 v1 的那份纹理都没被动过；也没有悄悄多出版本来吸收改过的字节。
    expect(digest(await readFile(texture))).toBe(declared!.sha256!)
    expect((await operations.resources.verify("res_loose", 1)).valid).toBe(true)
    expect(await versionNumbers("res_loose")).toEqual([1, 2])
  })

  test("本机没有 Blender 时依赖未知：如实标注，不假装闭合、也不当成没有依赖", async () => {
    const blend = join(fixtures, "没有blender.blend")
    await writeFile(blend, "并不是真的 .blend：本机没有 Blender 时连读都不该去读")
    const configured = process.env.BLENDER_EXECUTABLE
    process.env.BLENDER_EXECUTABLE = join(fixtures, "并不存在的-blender")
    try {
      const parsed = await parseAsset(blend)
      expect(parsed.dependencies.length).toBe(1)
      expect(parsed.metadata.externals).toBe("unknown")
      expect(parsed.metadata.externalsReason).toBe("BLENDER_UNAVAILABLE")
    } finally {
      if (configured === undefined) delete process.env.BLENDER_EXECUTABLE
      else process.env.BLENDER_EXECUTABLE = configured
    }
  })
})
