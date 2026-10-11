/**
 * ENV-32「增量导出」的真实行为测试：真 SceneStore（真 revision 历史、真文件）+ 真 ResourceLibrary。
 *
 * 判定：磁盘上每一版都是**完整、不可变**的快照（`store.ts` 的契约：同一 revision 换字节直接
 * `SCENE_HISTORY_CONFLICT`），导出物必须能被 `scene_open` 直接读回，所以 `scene_save` 仍然写全量文档；
 * 增量以**变更集**（changeset）提供：给 `sinceRevision` 得到 added/updated/removed 与计数，
 * 给 `diffPath` 另写一份**只含变更实体**的 JSON。这里断言的就是这三件事与四条拒绝边界。
 *
 * 夹具是测试自己写的最小 GLB，只用于证明"引用替换/变更集口径"，不代表真实模型几何。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SceneOperations } from "../src/operations.ts"
import { sceneSaveParameters } from "../src/tool-schema.ts"
import { nativePhysicsCommit, nativePhysicsTargets } from "../../lyapunov-shell/src/native-physics-panel.tsx"

let base: string, dataRoot: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-save-changeset-"))
  dataRoot = join(base, "data")
  operations = new SceneOperations(dataRoot)
  await mkdir(join(base, "fixtures"), { recursive: true })
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(generator: string): Buffer {
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator }], meshes: [{ primitives: [] }] }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

async function fixture(name: string, generator: string): Promise<string> {
  const path = join(base, "fixtures", name)
  await writeFile(path, glbBytes(generator))
  return path
}

describe("scene_save 的增量导出（变更集）", () => {
  test("单实体改名：changeset 只列该实体，diffPath 字节数远小于完整文档；导出文档仍是完整可读快照", async () => {
    const sceneId = "changeset-room"
    await operations.create({ sceneId })
    const glb = await fixture("塔.glb", "changeset-tower-v1")
    const first = await operations.import({ sceneId, path: glb, entityId: "tower-a", resourceId: "res_tower", physicalize: false })
    const second = await operations.import({ sceneId, path: glb, entityId: "tower-b", resourceId: "res_tower", physicalize: false })
    const beforeRename = second.snapshot!.revision
    const renamed = await operations.scene.commit({ sceneId, expectedRevision: beforeRename, patch: [{ op: "update", entityId: "tower-a", changes: { name: "塔 A（改名）" } }] })

    const fullPath = join(base, "full.json"), diffPath = join(base, "changeset.json")
    const full = await operations.save(sceneId, fullPath)
    const incremental = await operations.save(sceneId, fullPath, { sinceRevision: beforeRename, diffPath })

    expect(incremental.diff).toBeDefined()
    expect(incremental.diff!.kind).toBe("scene-changeset")
    expect(incremental.diff!.fromRevision).toBe(beforeRename)
    expect(incremental.diff!.toRevision).toBe(renamed.revision)
    expect(incremental.diff!.updated).toEqual(["tower-a"])
    expect(incremental.diff!.added).toEqual([])
    expect(incremental.diff!.removed).toEqual([])
    expect(incremental.diff!.entityCount).toBe(full.snapshot.entities.length)
    expect(incremental.diff!.unchanged).toBe(full.snapshot.entities.length - 1)

    const fullBytes = (await stat(fullPath)).size
    const diffBytes = (await stat(diffPath)).size
    expect(incremental.diffPath).toBe(diffPath)
    expect(incremental.diffBytes).toBe(diffBytes)
    expect(diffBytes).toBeLessThan(fullBytes / 2)

    // 文档本身：还是完整快照（scene_open 读得回），不是"只有变更实体"的残篇。
    const document = JSON.parse(await readFile(fullPath, "utf8"))
    expect(document.sceneId).toBe(sceneId)
    expect(document.revision).toBe(renamed.revision)
    expect(document.entities.length).toBe(full.snapshot.entities.length)
    // 变更集文件：只有被改的那一个实体，且带完整实体对象（消费方可以不读全量文档就应用）。
    const changeset = JSON.parse(await readFile(diffPath, "utf8"))
    expect(changeset.kind).toBe("scene-changeset")
    expect(changeset.entities.updated.map((entity: { entityId: string }) => entity.entityId)).toEqual(["tower-a"])
    expect(changeset.entities.added).toEqual([])
    expect(changeset.entities.updated[0].name).toBe("塔 A（改名）")
    console.log(`[N62] 完整文档 ${fullBytes} B → 变更集 ${diffBytes} B（同一改动；实体 ${full.snapshot.entities.length} 个，变更 1 个）`)
  })

  test("新增/删除都进变更集：added/removed 按实体 id 给出，unchanged 是其余部分", async () => {
    const sceneId = "changeset-addremove"
    await operations.create({ sceneId })
    const glb = await fixture("箱.glb", "changeset-box-v1")
    const imported = await operations.import({ sceneId, path: glb, entityId: "keep", resourceId: "res_box", physicalize: false })
    const baseRevision = imported.snapshot!.revision
    const added = await operations.scene.commit({ sceneId, expectedRevision: baseRevision, patch: [{ op: "add", entity: { entityId: "new", name: "新件", transform: { position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components: {} } }] })
    const afterAdd = await operations.save(sceneId, join(base, "doc-add.json"), { sinceRevision: baseRevision })
    expect(afterAdd.diff!.added).toEqual(["new"])
    expect(afterAdd.diff!.updated).toEqual([])
    expect(afterAdd.diff!.removed).toEqual([])
    const removed = await operations.scene.commit({ sceneId, expectedRevision: added.revision, patch: [{ op: "remove", entityId: "new" }] })
    const afterRemove = await operations.save(sceneId, join(base, "doc-rm.json"), { sinceRevision: added.revision })
    expect(afterRemove.diff!.removed).toEqual(["new"])
    expect(afterRemove.diff!.added).toEqual([])
    expect(afterRemove.diff!.updated).toEqual([])
    expect(afterRemove.diff!.entityCount).toBe(removed.entities.length)
    expect(afterRemove.diff!.unchanged).toBe(removed.entities.length)
  })

  test("负对照：没有 sinceRevision 就没有 diff；diffPath 单独给、非整数 revision、不存在的 revision 都明确拒绝", async () => {
    const sceneId = "changeset-negative"
    await operations.create({ sceneId })
    const glb = await fixture("杆.glb", "changeset-rod-v1")
    const imported = await operations.import({ sceneId, path: glb, entityId: "rod", resourceId: "res_rod", physicalize: false })
    const revision = imported.snapshot!.revision

    const plain = await operations.save(sceneId, join(base, "plain.json"))
    expect(plain.diff).toBeUndefined()
    expect(plain.diffPath).toBeUndefined()

    await expect(operations.save(sceneId, join(base, "x.json"), { diffPath: join(base, "x-diff.json") }))
      .rejects.toThrow("DIFF_REQUIRES_SINCE_REVISION")
    await expect(operations.save(sceneId, join(base, "x.json"), { sinceRevision: 1.5 }))
      .rejects.toThrow("INVALID_REVISION: sinceRevision=1.5")
    await expect(operations.save(sceneId, join(base, "x.json"), { sinceRevision: revision + 5 }))
      .rejects.toThrow(/SCENE_VERSION_NOT_FOUND/)
    // 自己比自己：合法但空（不装作"有变更"）。
    const same = await operations.save(sceneId, join(base, "same.json"), { sinceRevision: revision })
    expect(same.diff!.added).toEqual([])
    expect(same.diff!.updated).toEqual([])
    expect(same.diff!.removed).toEqual([])
    expect(same.diff!.unchanged).toBe(imported.snapshot!.entities.length)
  })

  test("工具参数 schema 真的收下 sinceRevision/diffPath（additionalProperties 仍为 false）", () => {
    const properties = (sceneSaveParameters.input as { properties: Record<string, unknown>; additionalProperties: boolean }).properties
    expect(Object.keys(properties).sort()).toEqual(["diffPath", "path", "portable", "projectFiles", "sceneId", "sinceRevision"])
    expect((sceneSaveParameters.input as { additionalProperties: boolean }).additionalProperties).toBe(false)
  })
})

describe("原生源与材料经同一scene_edit保存重开", () => {
  test("flex、cable、独立USD与MPM声明随便携工程搬家，原件字节不变且不保存瞬态帧", async () => {
    // 这里只验证真实文件/SceneStore/ResourceLibrary闭环；原生求解由各引擎的硬件测试独立验收。
    const sceneId = "native-roundtrip"
    await operations.create({ sceneId })
    const xml = '<mujoco model="native"><worldbody><body name="base"><geom type="sphere" size=".02"/></body></worldbody></mujoco>'
    const usd = '#usda 1.0\n(defaultPrim = "Root")\ndef Xform "Root" { def Points "Fluid" { point3f[] points = [(0,0,1),(.1,0,1)] } }\n'
    const examples = [
      { entityId: "soft", filename: "flex.xml", bytes: xml, components: { mujoco: { flexMaterials: { soft: { youngPa: 20000, poisson: .3, rayleighDamping: .02 } } } } },
      { entityId: "cable", filename: "cable.xml", bytes: xml.replace('model="native"', 'model="cable"'), components: { mujoco: { cableMaterials: { compositewire: { bendPa: 1000, twistPa: 500 } } } } },
      { entityId: "fluid", filename: "fluid.usda", bytes: usd, components: { isaac: { materialOverrides: { "Materials/Water": { densityKgM3: 1000, viscosity: .01 } } } } },
    ]
    for (const example of examples) {
      const path = join(base, "fixtures", example.filename); await writeFile(path, example.bytes)
      const components = example.entityId === "fluid" ? { ...example.components, isaac: { ...example.components.isaac, sourcePath: path } } : example.components
      const mounted = await operations.import({ sceneId, entityId: example.entityId, resourceId: `res_${example.entityId}`, path, components, alignBottomToSurface: false })
      const entity = mounted.snapshot!.entities.find(row => row.entityId === example.entityId)!
      if (example.entityId === "soft") {
        // 修复前 mount 用 {sourcePath} 覆盖整个mujoco键，这里真实复现材料声明丢失。
        expect(entity.components.mujoco).toMatchObject(example.components.mujoco!)
        const target = nativePhysicsTargets(entity)[0]!
        await operations.scene.commit(nativePhysicsCommit(sceneId, mounted.snapshot!.revision, entity, target, { youngPa: 40000, poisson: .35, rayleighDamping: .03 }))
      }
      expect(await readFile(path, "utf8")).toBe(example.bytes)
    }
    const before = await operations.scene.snapshot(sceneId)
    await operations.scene.commit({ sceneId, expectedRevision: before.revision, patch: [{ op: "add", entity: {
      entityId: "mpm", name: "Water", resources: [], transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { newton: { mpm: { kind: "water", gridType: "dense", dimensions: [4, 4, 4], spacingM: .02, densityKgM3: 1000, viscosityPaS: .001, youngModulusPa: 1e5, poissonRatio: .3, voxelSizeM: .04 } } },
    } }] })
    const pkg = join(base, "package"), moved = join(base, "moved-package")
    await operations.save(sceneId, join(pkg, "scene.json"), { portable: true })
    const saved = JSON.parse(await readFile(join(pkg, "scene.json"), "utf8"))
    expect(JSON.stringify(saved)).not.toContain("dynamicGeometry")
    expect(JSON.stringify(saved)).not.toContain("nativePhysics")
    await rename(pkg, moved)
    await rm(dataRoot, { recursive: true, force: true }); await rm(join(base, "fixtures"), { recursive: true, force: true })
    const reopened = await new SceneOperations(join(base, "reopened-data")).open(join(moved, "scene.json"), { sceneId: "native-reopened" })
    const byId = new Map(reopened.entities.map(entity => [entity.entityId, entity]))
    expect(byId.get("soft")!.components.mujoco).toMatchObject({ flexMaterials: { soft: { youngPa: 40000, poisson: .35, rayleighDamping: .03 } } })
    expect(byId.get("cable")!.components.mujoco).toMatchObject(examples[1]!.components.mujoco!)
    expect(byId.get("fluid")!.components.isaac).toMatchObject(examples[2]!.components.isaac!)
    expect(byId.get("mpm")!.components.newton).toEqual(saved.entities.find((row: {entityId: string}) => row.entityId === "mpm").components.newton)
    for (const entity of reopened.entities) for (const ref of entity.resources) {
      const path = fileURLToPath(ref.original.uri)
      expect(path.startsWith(moved + "/")).toBe(true)
      expect(await stat(path)).toBeDefined()
      const expected = examples.find(row => row.entityId === entity.entityId)!.bytes
      expect(await readFile(path, "utf8")).toBe(expected)
      const native = (entity.components.mujoco ?? entity.components.isaac) as {sourcePath?: string} | undefined
      if (native?.sourcePath) expect(resolve(dirname(join(moved, "scene.json")), native.sourcePath)).toBe(path)
    }
  })
})
