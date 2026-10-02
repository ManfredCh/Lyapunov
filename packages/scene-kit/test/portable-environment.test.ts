/**
 * 便携工程（portable）的真实行为测试：真的 SceneStore + 真的 ResourceLibrary（真文件、真 CAS、真依赖发现），
 * 不 mock。GLB 夹具是测试自己写的最小 glTF；.blend 夹具由配置的 Blender 现场生成（没有 Blender 时该组跳过）。
 *
 * 这里验的是**文件依赖闭合**：包内每个引用都落在包里并且真的存在，而不是"复制过一些文件"。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, relative } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { ResourceRef } from "../../lyapunov-contracts/src/types.ts"
import { blenderEnvironment, blenderExecutable, inspectBlend } from "../src/blend-deps.ts"
import { localPath, parseAsset } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"
import { copyPortableResource } from "../src/portable.ts"

let base: string, dataRoot: string, fixtures: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-portable-"))
  dataRoot = join(base, "data")
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  operations = new SceneOperations(dataRoot)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(generator: string): Buffer {
  const json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: generator }],
    meshes: [{ primitives: [] }],
  }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

async function fixture(name: string, content: Buffer | string): Promise<string> {
  const path = join(fixtures, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}
async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(root, join(prefix, entry.name)) : [join(prefix, entry.name)]))).flat()
}
async function rejection(action: () => Promise<unknown>): Promise<Error> {
  return action().then(() => { throw new Error("EXPECTED_REJECTION") }, error => error as Error)
}
const state = async (path: string) => stat(path).then(value => `${value.size}:${value.mtimeMs}`, () => "missing")

describe("便携保存：资源闭包与复用", () => {
  test("同一资源被两个实体引用时只落一份副本，两条引用改写成同一个包内相对路径", async () => {
    const sceneId = "scene_portable"
    await operations.create({ sceneId })
    const glb = await fixture("tree.glb", glbBytes("tree-v1"))
    const imported = await operations.import({ path: glb, sceneId, entityId: "tree-1", resourceId: "res_tree", name: "树", physicalize: false })
    await operations.mount({ sceneId, resourceId: "res_tree", entityId: "tree-2" })

    const bundle = join(base, "便携", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })

    // 一份依赖 = 一次复制：packagedFileCount 不按实体数膨胀，两个实体共用同一份包内副本。
    expect(saved.packagedFileCount).toBe(1)
    const packaged = (await walk(dirname(bundle))).filter(name => name !== "scene.json")
    expect(packaged.length).toBe(1)
    const copied = join(dirname(bundle), packaged[0]!)
    expect(copied.startsWith(join(dirname(bundle), "resources", "res_tree-v1"))).toBe(true)
    expect(await readFile(copied)).toEqual(await readFile(glb))
    // 两次挂载各展开成一个实例树：每个引用同一资源的实体都指向同一份包内副本。
    expect(saved.snapshot.entities.filter(entity => entity.entityId === "tree-1" || entity.entityId === "tree-2").length).toBe(2)
    const referencing = saved.snapshot.entities.filter(entity => entity.resources.some(ref => ref.resourceId === "res_tree"))
    expect(referencing.length).toBeGreaterThanOrEqual(2)
    for (const entity of referencing) for (const ref of entity.resources) expect(ref.original.uri).toBe(packaged[0]!)
    // 包内副本自己也要能按产品口径解析（不是复制完就算闭合）。
    const parsed = await parseAsset(copied)
    for (const stamp of parsed.dependencies) expect(stamp.path.startsWith(dirname(bundle))).toBe(true)
    // 原件仍在原处、字节未动。
    expect(await readFile(glb)).toEqual(await readFile(copied))
    expect(imported.resource.ref.version).toBe(1)
  })

  test("重复保存到同一路径不重写已就位的副本；非便携保存不复制任何文件（默认路径不变）", async () => {
    const sceneId = "scene_repeat"
    await operations.create({ sceneId })
    await operations.import({ path: await fixture("box.glb", glbBytes("box")), sceneId, entityId: "box", resourceId: "res_box", physicalize: false })
    const bundle = join(base, "repeat", "scene.json")
    await operations.save(sceneId, bundle, { portable: true })
    const copied = join(dirname(bundle), (await walk(dirname(bundle))).find(name => name.endsWith(".glb"))!)
    const first = await state(copied)
    const second = await operations.save(sceneId, bundle, { portable: true })
    expect(second.packagedFileCount).toBe(1)
    expect(await state(copied)).toBe(first)

    const plain = join(base, "plain", "scene.json")
    const saved = await operations.save(sceneId, plain)
    expect(saved.missing).toEqual([])
    expect(await walk(dirname(plain))).toEqual(["scene.json"])
  })

  test("搬到新目录、换一个全新 catalog 重开：sceneId/实体集不变，每条引用都落在包内且存在", async () => {
    const sceneId = "scene_move"
    await operations.create({ sceneId })
    await operations.import({ path: await fixture("lamp.glb", glbBytes("lamp")), sceneId, entityId: "lamp", resourceId: "res_lamp", physicalize: false })
    const authored = join(base, "authored", "scene.json")
    const before = await operations.inspect(sceneId)
    await operations.save(sceneId, authored, { portable: true })
    await rm(fixtures, { recursive: true, force: true })
    const moved = join(base, "moved")
    await rename(dirname(authored), moved)

    const fresh = new SceneOperations(join(base, "catalog", "fresh"))
    const reopened = await fresh.open(join(moved, "scene.json"))
    expect(reopened.sceneId).toBe(sceneId)
    expect(reopened.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    for (const entity of reopened.entities) for (const ref of entity.resources) for (const rep of [ref.original, ...ref.representations]) {
      const path = localPath(rep.uri)
      expect(path.startsWith(moved)).toBe(true)
      expect(existsSync(path)).toBe(true)
    }
  })

  test("XML 里的绝对路径引用与绝对 meshdir 在副本上被改写成包内相对引用，并被登记为 derived", async () => {
    const sceneId = "scene_robot"
    await operations.create({ sceneId })
    const assets = join(base, "robot-assets")
    await mkdir(join(assets, "meshes"), { recursive: true })
    await writeFile(join(assets, "meshes", "part.stl"), "solid part\nendsolid part\n")
    const xml = await fixture("robot.xml", `<mujoco model="m"><compiler angle="radian" meshdir="${join(assets, "meshes")}"/><asset><mesh name="part" file="part.stl"/></asset><worldbody><body name="b"><geom type="mesh" mesh="part"/></body></worldbody></mujoco>`)

    await operations.import({ path: xml, sceneId, entityId: "robot", resourceId: "res_robot", physicalize: false })
    const bundle = join(base, "robot", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })

    expect(saved.derivedFiles?.some(name => name.endsWith("robot.xml"))).toBe(true)
    const copiedXml = (await walk(dirname(bundle))).find(name => name.endsWith("robot.xml"))!
    const text = await readFile(join(dirname(bundle), copiedXml), "utf8")
    expect(text).not.toContain(assets)
    expect(text).not.toContain(`meshdir="${join(assets, "meshes")}"`)
    const parsed = await parseAsset(join(dirname(bundle), copiedXml))
    expect(parsed.dependencies.length).toBeGreaterThan(1)
    for (const stamp of parsed.dependencies) {
      expect(stamp.path.startsWith(dirname(bundle))).toBe(true)
      expect(existsSync(stamp.path)).toBe(true)
    }
    // 原件一个字节都没动。
    expect(await readFile(xml, "utf8")).toContain(assets)
  })
})

describe("便携保存：用户点名的项目文件", () => {
  test("相对路径按 scene.json 目标目录解析，镜像到 project/ 并保留彼此相对层级", async () => {
    const sceneId = "scene_files"
    await operations.create({ sceneId })
    await operations.import({ path: await fixture("cube.glb", glbBytes("cube")), sceneId, entityId: "cube", resourceId: "res_cube", physicalize: false })
    const script = await fixture("scripts/build.py", "print('build')\n")
    const notes = await fixture("scripts/notes.md", "# 笔记\n")
    const reference = await fixture("reference.png", Buffer.from("89504e470d0a1a0a", "hex"))
    const bundle = join(base, "files", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true, projectFiles: [relative(dirname(bundle), script), relative(dirname(bundle), notes), relative(dirname(bundle), reference)] })

    expect(saved.projectFiles).toEqual(["project/reference.png", "project/scripts/build.py", "project/scripts/notes.md"])
    for (const name of saved.projectFiles!) expect(existsSync(join(dirname(bundle), name))).toBe(true)
    expect(await readFile(join(dirname(bundle), "project", "scripts", "build.py"), "utf8")).toBe("print('build')\n")
    expect(await readFile(join(dirname(bundle), "project", "reference.png"))).toEqual(await readFile(reference))
    // 项目文件不是第二份权威状态：场景文档里没有它们的登记。
    expect(JSON.stringify(saved.snapshot)).not.toContain("project/scripts")
  })

  test("非便携保存不接受 projectFiles；指向目录或不存在路径的项目文件当场拒绝", async () => {
    const sceneId = "scene_files_reject"
    await operations.create({ sceneId })
    await operations.import({ path: await fixture("block.glb", glbBytes("block")), sceneId, entityId: "block", resourceId: "res_block", physicalize: false })
    const file = await fixture("scripts/keep.py", "print('keep')\n")
    expect((await rejection(() => operations.save(sceneId, join(base, "reject", "scene.json"), { projectFiles: [file] }))).message).toContain("PORTABLE_REQUIRED_FOR_PROJECT_FILES")
    expect((await rejection(() => operations.save(sceneId, join(base, "reject", "scene.json"), { portable: true, projectFiles: [fixtures] }))).message).toContain("PORTABLE_PROJECT_FILE_NOT_FILE")
    expect((await rejection(() => operations.save(sceneId, join(base, "reject", "scene.json"), { portable: true, projectFiles: [join(fixtures, "missing.py")] }))).message).toContain("PORTABLE_PROJECT_FILE_NOT_FILE")
    expect(existsSync(join(base, "reject"))).toBe(false)
  })
})

/* ────────── .blend 外部依赖：需要真实 Blender（口径见 docs/PORTABLE_ENVIRONMENT.md）────────── */
const blenderAvailable = (() => { try { execFileSync(blenderExecutable(), ["--version"], { stdio: "ignore", timeout: 60_000 }); return true } catch { return false } })()
/** 真的起 Blender 生成/改写工程，远超 bun 默认的 5s 上限，必须显式给足超时。 */
const blender = (name: string, fn: () => Promise<void>): void => { (blenderAvailable ? test : test.skip)(name, fn, 600_000) }

/** 用配置的 Blender 现场做一个"图片用绝对路径"的源工程（relative_remap=False：别把要测的绝对路径悄悄改掉）。 */
async function blendFixture(target: string, image: string): Promise<void> {
  await writeFile(image, PNG)
  const script = `import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)\nimage = bpy.data.images.load(${JSON.stringify(image)})\nmaterial = bpy.data.materials.new("贴图材质")\nmaterial.use_nodes = True\nnode = material.node_tree.nodes.new("ShaderNodeTexImage")\nnode.image = image\nmaterial.node_tree.links.new(node.outputs["Color"], material.node_tree.nodes["Principled BSDF"].inputs["Base Color"])\nbpy.context.object.data.materials.append(material)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(target)}, relative_remap=False)\n`
  await new Promise<void>((settle, fail) => execFile(blenderExecutable(), ["--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", script], { env: blenderEnvironment(), timeout: 300_000 }, error => error ? fail(error) : settle()))
}
/** 8×8 红白棋盘 PNG：贴图真的被采样时渲染里会出现红色像素（全黑图分不出"贴图没进去"和"材质本来就黑"）。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAH0lEQVR4nGP8z8DA8P8/AyMjOvn/////DFhIxkGpAwDJY2O5VAtmegAAAABJRU5ErkJggg==", "base64")

describe("便携保存：.blend 源工程的外部依赖", () => {
  blender("绝对路径外部纹理：只在副本上改成相对引用，原件字节不变；换全新 catalog 重开仍可解", async () => {
    const sceneId = "scene_blend"
    await operations.create({ sceneId })
    const blend = join(fixtures, "工作室.blend"), image = join(fixtures, "贴图.png")
    await blendFixture(blend, image)
    const original = await readFile(blend)
    const before = await inspectBlend(blend)
    expect(before.externals.map(row => row.raw)).toEqual([image])
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_studio", physicalize: false })

    const bundle = join(base, "blend", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.derivedFiles?.length).toBe(1)
    const copied = (await walk(dirname(bundle))).find(name => name.endsWith(".blend"))!
    // 原件字节不变：改写只发生在副本上。
    expect(await readFile(blend)).toEqual(original)
    const originalAfter = await inspectBlend(blend)
    expect(JSON.stringify(originalAfter.fingerprint)).toBe(JSON.stringify(before.fingerprint))
    const after = await inspectBlend(join(dirname(bundle), copied))
    expect(after.externals.length).toBe(1)
    expect(after.externals[0]!.raw.startsWith("//")).toBe(true)
    expect(after.externals[0]!.exists).toBe(true)
    expect(after.externals[0]!.resolved.startsWith(dirname(bundle))).toBe(true)
    expect(JSON.stringify(after.fingerprint)).toBe(JSON.stringify(before.fingerprint))
    // 依赖闭合：副本引用的每个文件都在包里，凭据是"再读一次"而不是"复制过文件"。
    const parsed = await parseAsset(join(dirname(bundle), copied))
    for (const stamp of parsed.dependencies) expect(stamp.path.startsWith(dirname(bundle))).toBe(true)
  })

  blender("源工程的外部依赖不在场时便携保存当场失败，不留半个包", async () => {
    const sceneId = "scene_blend_missing"
    await operations.create({ sceneId })
    const blend = join(fixtures, "缺纹理.blend"), image = join(fixtures, "会消失.png")
    await blendFixture(blend, image)
    await operations.import({ path: blend, sceneId, entityId: "studio", resourceId: "res_studio", physicalize: false })
    await rm(image, { force: true })

    const bundle = join(base, "missing", "scene.json")
    const error = await rejection(() => operations.save(sceneId, bundle, { portable: true }))
    expect(error.message).toContain("PORTABLE_DEPENDENCY_MISSING")
    expect(existsSync(join(base, "missing", "sources"))).toBe(false)
  })
})

/* ────────── DEV-021：已入库的绝对路径依赖（绝对 meshdir / 内容重复的网格）────────── */

/** 最小 MJCF：`meshdir` 绝对或相对 + 若干个 `<mesh file>`；网格件由调用方写成真实字节。 */
async function mjcfFixture(name: string, meshdir: string, meshes: string[]): Promise<string> {
  const asset = meshes.map(mesh => `<mesh name="${mesh}" file="${mesh}.STL"/>`).join("")
  return fixture(name, `<mujoco model="${name}"><compiler angle="radian" meshdir="${meshdir}"/><asset>${asset}</asset><worldbody><body name="b"><geom type="mesh" mesh="${meshes[0]}"/></body></worldbody></mujoco>`)
}
/** 网格目录：不同名字写同一份字节就是"多个网格内容相同"，这是 G1 咖啡模型的真实形态。 */
async function meshDirectory(directory: string, meshes: Record<string, string>): Promise<string> {
  await mkdir(directory, { recursive: true })
  for (const [name, content] of Object.entries(meshes)) await writeFile(join(directory, `${name}.STL`), content)
  return directory
}
/**
 * 包内副本的依赖闭合：按产品口径（parseAsset）重解副本——引用一条不少、每条都落在包里、文件真实在场
 * （缺件在这里就是 ENOENT，不是"复制过文件"的推断），网格字节必须等于某个声明的原件：
 * 内容去重复用只允许换落点，不允许换字节。
 */
async function expectClosedCopy(copiedXml: string, root: string, authored: Record<string, string>): Promise<void> {
  const text = await readFile(copiedXml, "utf8")
  expect([...text.matchAll(/file="([^"]+)"/g)].length).toBe(Object.keys(authored).length)
  const parsed = await parseAsset(copiedXml)
  const expected = new Set(Object.values(authored).map(content => Buffer.from(content).toString("base64")))
  for (const stamp of parsed.dependencies) {
    expect(stamp.path.startsWith(root)).toBe(true)
    const bytes = await readFile(stamp.path)
    if (stamp.path.endsWith(".STL")) expect(expected.has(bytes.toString("base64"))).toBe(true)
  }
}

describe("便携保存：已被引擎读过的绝对路径依赖（DEV-021）", () => {
  test("绝对 meshdir + 多个网格内容相同：不再误报缺失，副本逐条闭合且能搬走重开", async () => {
    const sceneId = "scene_abs_meshdir"
    await operations.create({ sceneId })
    // G1 咖啡模型的真实形态：手心 4 个指节网格两两同字节、文件名不同；meshdir 指向 XML 之外的绝对目录。
    const meshes = { pelvis: "solid pelvis\nendsolid pelvis\n", left_hand_index_0_link: "solid finger\nendsolid finger\n", left_hand_middle_0_link: "solid finger\nendsolid finger\n" }
    const assets = await meshDirectory(join(base, "g1-assets", "meshes"), meshes)
    const xml = await mjcfFixture("robot-abs.xml", assets, Object.keys(meshes))
    await operations.import({ path: xml, sceneId, entityId: "g1", resourceId: "res_g1", physicalize: false })

    // 改前：PORTABLE_DEPENDENCY_MISSING: …/meshes/left_hand_index_0_link.STL（文件在场、引擎已加载）。
    const bundle = join(base, "abs", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.derivedFiles?.some(name => name.endsWith("robot-abs.xml"))).toBe(true)
    // 同一份真实字节只落一份（去重复用仍生效）：两份 XML 之外的三个网格件落成两个落点。
    expect(saved.packagedFileCount).toBe(3)
    const copiedXml = join(dirname(bundle), (await walk(dirname(bundle))).find(name => name.endsWith("robot-abs.xml"))!)
    const text = await readFile(copiedXml, "utf8")
    expect(text).not.toContain(assets)
    expect(text).not.toContain(`meshdir="${assets}"`)
    await expectClosedCopy(copiedXml, dirname(bundle), meshes)

    // 搬走 + 全新 catalog 重开：副本解析出来的每条依赖都落在包里且真实存在。
    const moved = join(base, "abs-moved")
    await rename(dirname(bundle), moved)
    const fresh = new SceneOperations(join(base, "catalog", "abs"))
    const reopened = await fresh.open(join(moved, "scene.json"))
    expect(reopened.sceneId).toBe(sceneId)
    for (const entity of reopened.entities) for (const ref of entity.resources) for (const rep of [ref.original, ...ref.representations]) {
      const parsed = await parseAsset(localPath(rep.uri))
      for (const stamp of parsed.dependencies) { expect(stamp.path.startsWith(moved)).toBe(true); expect(existsSync(stamp.path)).toBe(true) }
    }
  })

  test("两个资源引用同一批网格字节：副本被复用到别处时，两条 XML 的引用仍然解析得到", async () => {
    const sceneId = "scene_abs_shared"
    await operations.create({ sceneId })
    const meshes = { part: "solid part\nendsolid part\n" }
    const assets = await meshDirectory(join(base, "shared-assets", "meshes"), meshes)
    for (const name of ["alpha", "beta"]) await operations.import({ path: await mjcfFixture(`${name}.xml`, assets, Object.keys(meshes)), sceneId, entityId: name, resourceId: `res_${name}`, physicalize: false })

    // 改前：第二个资源的副本被复用到第一个资源的分组里，落点不在本资源分组内 ⇒ 报 PORTABLE_DEPENDENCY_MISSING: …/meshes/part.STL。
    const bundle = join(base, "shared", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.packagedFileCount).toBe(3)
    for (const name of ["alpha", "beta"]) {
      const copiedXml = join(dirname(bundle), (await walk(dirname(bundle))).find(entry => entry.endsWith(`${name}.xml`))!)
      await expectClosedCopy(copiedXml, dirname(bundle), meshes)
    }
  })

  test("负对照：依赖真的不在闭包里，绝对引用仍然当场报 PORTABLE_DEPENDENCY_MISSING", async () => {
    const sceneId = "scene_abs_missing"
    await operations.create({ sceneId })
    const meshes = { pelvis: "solid pelvis\nendsolid pelvis\n", gone: "solid gone\nendsolid gone\n" }
    const assets = await meshDirectory(join(base, "missing-assets", "meshes"), meshes)
    const xml = await mjcfFixture("robot-gone.xml", assets, Object.keys(meshes))
    const imported = await operations.import({ path: xml, sceneId, entityId: "g1", resourceId: "res_gone", physicalize: false })
    await rm(join(assets, "gone.STL"), { force: true })
    // 闭包里没有这份依赖（记录未覆盖该引用）：缺件必须真的报出来，不能靠"能重写"掩盖。
    const record = { ...imported.resource, parsed: { ...imported.resource.parsed, dependencies: imported.resource.parsed.dependencies.filter(stamp => !stamp.path.endsWith("gone.STL")) } }
    const error = await rejection(() => copyPortableResource(imported.resource.ref, record, join(base, "negative")))
    expect(error.message).toContain("PORTABLE_DEPENDENCY_MISSING")
    expect(error.message).toContain("gone.STL")
  })

  test("相对 meshdir 且依赖都在场：副本逐字节等于原件，不触发改写（相对路径行为不回归）", async () => {
    const sceneId = "scene_rel_closed"
    await operations.create({ sceneId })
    const meshes = { part: "solid part\nendsolid part\n", other: "solid other\nendsolid other\n" }
    await meshDirectory(join(fixtures, "meshes"), meshes)
    const xml = await mjcfFixture("robot-rel.xml", "meshes", Object.keys(meshes))
    await operations.import({ path: xml, sceneId, entityId: "robot", resourceId: "res_rel", physicalize: false })

    const bundle = join(base, "rel", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.derivedFiles ?? []).toEqual([])
    const copiedXml = join(dirname(bundle), (await walk(dirname(bundle))).find(name => name.endsWith("robot-rel.xml"))!)
    expect(await readFile(copiedXml)).toEqual(await readFile(xml))
    await expectClosedCopy(copiedXml, dirname(bundle), meshes)
  })

  test("相对 meshdir + 内容重复的网格：副本被复用到别的落点时改写成实际落点，包仍然自洽", async () => {
    const sceneId = "scene_rel_dup"
    await operations.create({ sceneId })
    const meshes = { first: "solid same\nendsolid same\n", second: "solid same\nendsolid same\n" }
    await meshDirectory(join(fixtures, "dup-meshes"), meshes)
    const xml = await mjcfFixture("robot-rel-dup.xml", "dup-meshes", Object.keys(meshes))
    await operations.import({ path: xml, sceneId, entityId: "robot", resourceId: "res_rel_dup", physicalize: false })

    // 改前：副本里的相对引用指向被去重掉的文件名，副本自身解不开 ⇒ ENOENT（包不闭合）。
    const bundle = join(base, "rel-dup", "scene.json")
    const saved = await operations.save(sceneId, bundle, { portable: true })
    expect(saved.derivedFiles?.some(name => name.endsWith("robot-rel-dup.xml"))).toBe(true)
    const copiedXml = join(dirname(bundle), (await walk(dirname(bundle))).find(name => name.endsWith("robot-rel-dup.xml"))!)
    await expectClosedCopy(copiedXml, dirname(bundle), meshes)
  })
})


test("MJCF 内容去重后保留隐式网格名及 geom 引用", async () => {
  const sceneId="implicit_mesh_names"
  await operations.create({sceneId})
  await meshDirectory(join(fixtures,"meshes"),{left:"solid same\nendsolid same\n",right:"solid same\nendsolid same\n"})
  const xml=await fixture("implicit.xml",'<mujoco><compiler meshdir="meshes"/><asset><mesh file="left.STL"/><mesh file="right.STL"/></asset><worldbody><geom type="mesh" mesh="left"/><geom type="mesh" mesh="right"/></worldbody></mujoco>')
  const original=await readFile(xml)
  await operations.import({path:xml,sceneId,entityId:"robot",resourceId:"implicit",physicalize:false})
  const bundle=join(base,"implicit-bundle","scene.json")
  await operations.save(sceneId,bundle,{portable:true})
  const copied=join(dirname(bundle),(await walk(dirname(bundle))).find(file=>file.endsWith("implicit.xml"))!)
  const doc=new XMLParser({ignoreAttributes:false}).parse(await readFile(copied,"utf8")).mujoco
  const names=doc.asset.mesh.map((mesh:any)=>mesh["@_name"]??basename(mesh["@_file"],extname(mesh["@_file"])))
  expect(names.sort()).toEqual(["left","right"])
  expect(new Set(doc.asset.mesh.map((mesh:any)=>mesh["@_file"])).size).toBe(1)
  for(const geom of doc.worldbody.geom)expect(names).toContain(geom["@_mesh"])
  expect(await readFile(xml)).toEqual(original)
  const moved=join(base,"implicit-moved")
  await rename(dirname(bundle),moved)
  expect((await new SceneOperations(join(base,"implicit-new-root")).open(join(moved,"scene.json"))).entities.length).toBeGreaterThan(0)
})
