/**
 * ENV-29 场景局部资源替换的真实行为测试：真的 SceneStore + 真的 ResourceLibrary（真文件、真 CAS、
 * 真 revision 历史），不 mock。夹具是测试自己写的最小 glTF 2.0 二进制 / 泼溅件 / MJCF / URDF 文件，
 * 只用于证明引用替换、拒绝条件与提交边界；不代表真实模型的几何、材质或渲染结果。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entity, ResourceRef, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
import { localPath } from "../src/formats.ts"
import { SceneOperations } from "../src/operations.ts"
import type { ResourceRecord } from "../src/resources.ts"
import { SceneConflict } from "../src/store.ts"
import { boundsOf, box, patchGlb, pocketBox, solidGlb, split } from "./glb-geometry-fixture.ts"

let base: string, dataRoot: string, fixtures: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-replace-resource-"))
  dataRoot = join(base, "data")
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  operations = new SceneOperations(dataRoot)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(options: { nodes: Array<Record<string, unknown>>; roots?: number[]; generator: string }): Buffer {
  const json = {
    asset: { version: "2.0", generator: options.generator },
    scene: 0,
    scenes: [{ nodes: options.roots ?? [0] }],
    nodes: options.nodes,
    meshes: options.nodes.map(() => ({ primitives: [] })),
  }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

/** 同一节点结构、不同字节（generator 不同）。 */
const treeV1 = () => glbBytes({ generator: "tree-v1", nodes: [{ name: "树干", children: [1] }, { name: "树冠" }] })
const treeV2 = () => glbBytes({ generator: "tree-v2", nodes: [{ name: "树干", children: [1] }, { name: "树冠" }] })
/** 多一个节点：与既有展开组不匹配。 */
const treeV3 = () => glbBytes({ generator: "tree-v3", nodes: [{ name: "树干", children: [1, 2] }, { name: "树冠" }, { name: "新枝" }] })
/** 索引相同但节点局部变换不同：无法无损映射到既有文档布局，必须拒绝。 */
const treeV4 = () => glbBytes({ generator: "tree-v4", nodes: [{ name: "树干", children: [1], translation: [1, 0, 0] }, { name: "树冠" }] })
/** 与 v1 同结构、不同字节（内容去重不会把它当成 v1）。 */
const treeV5 = () => glbBytes({ generator: "tree-v5", nodes: [{ name: "树干", children: [1] }, { name: "树冠" }] })
/** 同变换、只改节点名：不参与几何，可替换但必须如实报告分歧。 */
const treeV6 = () => glbBytes({ generator: "tree-v6", nodes: [{ name: "树干-改名", children: [1] }, { name: "树冠-改名" }] })

async function fixture(name: string, content: Buffer | string): Promise<string> {
  const path = join(fixtures, name)
  await writeFile(path, content)
  return path
}

async function importResource(path: string, options: { resourceId: string; sceneId?: string; entityId?: string; parentId?: string; name?: string; source?: ResourceRef["source"]; components?: Entity["components"] }): Promise<ResourceRecord> {
  const result = await operations.import({ ...options, path, physicalize: false })
  return result.resource
}

async function rejection(action: () => Promise<unknown>): Promise<Error> {
  return action().then(() => { throw new Error("EXPECTED_REJECTION") }, error => error as Error)
}

/** 建场景 → 放一个父实体，返回最新 revision。 */
async function sceneWithParent(sceneId: string): Promise<number> {
  await operations.create({ sceneId })
  await operations.scene.commit({
    sceneId, expectedRevision: 0,
    patch: [{ op: "add", entity: { entityId: "site", name: "场地", transform: identityTransform(), resources: [], components: { annotation: { note: "无关实体" } } } }],
  })
  return 1
}

describe("ENV-29 局部资源替换", () => {
  test("GLB 多实体组：替换新版本只改引用，身份/位姿/父子/用户组件与无关实体不变，旧原件仍可读", async () => {
    const sceneId = "scene_tree"
    const revision = await sceneWithParent(sceneId)
    const v1 = await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", parentId: "site", name: "树", components: { annotation: { note: "保留我" } } })
    expect(v1.ref.version).toBe(1)
    const before = await operations.inspect(sceneId)
    expect(before.revision).toBe(revision + 1)
    expect(before.entities.map(entity => entity.entityId)).toEqual(["site", "tree-1", "tree-1:source", "tree-1:node:0", "tree-1:node:1"])
    const v2 = await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    expect(v2.ref.version).toBe(2)

    const result = await operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })

    expect(result.changed).toBe(true)
    expect(result.revision).toBe(before.revision + 1)
    expect([...result.entityIds].sort()).toEqual(["tree-1", "tree-1:node:0", "tree-1:node:1"])
    expect(result.warnings).toEqual([])
    const after = await operations.inspect(sceneId)
    // 没有 add/remove：实体集合与顺序逐字不变（替换不是挂载）。
    expect(after.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    const rootBefore = before.entities.find(entity => entity.entityId === "tree-1")!, rootAfter = after.entities.find(entity => entity.entityId === "tree-1")!
    expect(rootAfter.resources).toEqual([v2.ref])
    expect(rootAfter.name).toBe(rootBefore.name)
    expect(rootAfter.transform).toEqual(rootBefore.transform)
    expect(rootAfter.parentId).toBe("site")
    expect(rootAfter.components).toEqual(rootBefore.components)
    for (const entityId of ["tree-1:source", "tree-1:node:0", "tree-1:node:1"]) {
      const previous = before.entities.find(entity => entity.entityId === entityId)!, current = after.entities.find(entity => entity.entityId === entityId)!
      expect(current.parentId).toBe(previous.parentId)
      expect(current.transform).toEqual(previous.transform)
      expect(current.name).toBe(previous.name)
      expect(current.components).toEqual(previous.components)
      // 派生节点一起换版本；`:source` 不持引用（只承载源坐标转换）。
      expect(current.resources.map(ref => ref.version)).toEqual(entityId === "tree-1:source" ? [] : [2])
      expect(current.resources.some(ref => ref.original.uri === v1.ref.original.uri)).toBe(false)
    }
    expect(after.entities.find(entity => entity.entityId === "site")).toEqual(before.entities.find(entity => entity.entityId === "site"))
    // 旧原件仍可读：旧版本记录仍通过字节核对，历史 revision 仍引用它。
    expect(await operations.resources.verify("res_tree", 1)).toEqual({ valid: true, missing: [], changed: [] })
    expect((await readFile(localPath(v1.ref.original.uri))).length).toBeGreaterThan(0)
    expect((await operations.scene.version(sceneId, before.revision)).entities.find(entity => entity.entityId === "tree-1")!.resources[0]!.version).toBe(1)
  })

  test("单实体视觉（泼溅件）：替换引用与版本缓存，不新增实体，用户组件与位姿保留", async () => {
    const sceneId = "scene_street"
    await operations.create({ sceneId })
    const v1 = await importResource(await fixture("street-v1.splat", Buffer.alloc(32, 1)), { resourceId: "res_street", sceneId, entityId: "street-1", name: "街道", components: { sensor: { kind: "camera" } } })
    const before = await operations.inspect(sceneId)
    expect(before.entities.length).toBe(1)
    const v2 = await importResource(await fixture("street-v2.splat", Buffer.alloc(32, 9)), { resourceId: "res_street" })

    const result = await operations.replaceResource({ sceneId, entityId: "street-1", expectedRevision: before.revision, resourceId: "res_street", version: 2 })

    expect(result.changed).toBe(true)
    expect(result.entityIds).toEqual(["street-1"])
    const after = await operations.inspect(sceneId)
    expect(after.entities.length).toBe(1)
    const entity = after.entities[0]!
    expect(entity.entityId).toBe("street-1")
    expect(entity.resources[0]!.version).toBe(2)
    expect(entity.resources[0]!.original.uri).toBe(v2.ref.original.uri)
    expect(entity.transform).toEqual(before.entities[0]!.transform)
    expect(entity.components).toEqual({ ...before.entities[0]!.components, visual: { ...before.entities[0]!.components.visual, sourceBounds: JSON.parse(JSON.stringify(v2.parsed.metadata.aabb)), sourcePointCount: 1 } })
    expect(entity.components.visual?.sourceTransform).toEqual(before.entities[0]!.components.visual?.sourceTransform)
    expect(entity.components.visual?.sourceBounds).not.toEqual(before.entities[0]!.components.visual?.sourceBounds)
    const repeated = await operations.replaceResource({ sceneId, entityId: "street-1", expectedRevision: after.revision, resourceId: "res_street", version: 2 })
    expect(repeated.changed).toBe(false)
    expect(v1.ref.original.uri).not.toBe(v2.ref.original.uri)
  })

  test("重复提交同一目标：幂等 no-op，不写新 revision", async () => {
    const sceneId = "scene_idempotent"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)
    const first = await operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })
    expect(first.changed).toBe(true)

    const second = await operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: first.revision, resourceId: "res_tree", version: 2 })

    expect(second.changed).toBe(false)
    expect(second.revision).toBe(first.revision)
    expect(second.entityIds).toEqual([])
    expect(second.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_UNCHANGED"))).toBe(true)
    expect((await operations.inspect(sceneId)).revision).toBe(first.revision)
  })

  test("过期 expectedRevision：报场景冲突且场景零写入（无半提交）", async () => {
    const sceneId = "scene_conflict"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision - 1, resourceId: "res_tree", version: 2 }))

    expect(error).toBeInstanceOf(SceneConflict)
    expect((error as SceneConflict).code).toBe("SCENE_REVISION_CONFLICT")
    const after = await operations.inspect(sceneId)
    expect(after).toEqual(before)
    // 冲突也不会先写一半：磁盘上的当前文档仍是旧引用。
    expect((await operations.scene.snapshot(sceneId)).entities.find(entity => entity.entityId === "tree-1")!.resources[0]!.version).toBe(1)
  })

  test("读取快照之后出现并发提交：提交点 CAS 拒绝，不覆盖新版本", async () => {
    const sceneId = "scene_race"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)
    // 只在两次读取之间插入一次真实的并发提交，不改替换逻辑本身。
    const readRecord = operations.resources.get.bind(operations.resources)
    operations.resources.get = async (resourceId: string, version?: number) => {
      const record = await readRecord(resourceId, version)
      await operations.scene.commit({ sceneId, expectedRevision: before.revision, patch: [{ op: "update", entityId: "site", changes: { name: "并发改名" } }] })
      return record
    }

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error).toBeInstanceOf(SceneConflict)
    const after = await operations.inspect(sceneId)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.entities.find(entity => entity.entityId === "site")!.name).toBe("并发改名")
    expect(after.entities.find(entity => entity.entityId === "tree-1")!.resources[0]!.version).toBe(1)
  })

  test("同一实体重复引用同一条资源：一次替换收拢全部重复项，其它引用不受影响", async () => {
    const sceneId = "scene_duplicate"
    await operations.create({ sceneId })
    const refA = await importResource(await fixture("street-a.splat", Buffer.alloc(32, 1)), { resourceId: "res_a" })
    const refB = await importResource(await fixture("street-b.splat", Buffer.alloc(32, 2)), { resourceId: "res_b" })
    await importResource(await fixture("street-a2.splat", Buffer.alloc(32, 3)), { resourceId: "res_a" })
    await operations.scene.commit({
      sceneId, expectedRevision: 0,
      patch: [
        { op: "add", entity: { entityId: "dup-1", name: "全重复", transform: identityTransform(), resources: [refA.ref, structuredClone(refA.ref)], components: {} } },
        { op: "add", entity: { entityId: "dup-2", name: "部分重复", transform: identityTransform(), resources: [refA.ref, refB.ref, structuredClone(refA.ref)], components: {} } },
      ],
    })

    // 只有一条不同资源引用时无需 from*，重复项一次收拢。
    const single = await operations.replaceResource({ sceneId, entityId: "dup-1", expectedRevision: 1, resourceId: "res_a", version: 2 })
    expect(single.changed).toBe(true)
    // 混有多种引用时必须显式指定，替换仍覆盖该引用的全部重复项。
    const mixed = await operations.replaceResource({ sceneId, entityId: "dup-2", expectedRevision: single.revision, resourceId: "res_a", version: 2, fromResourceId: "res_a", fromVersion: 1 })
    expect(mixed.changed).toBe(true)

    const after = await operations.inspect(sceneId)
    expect(after.entities.find(entity => entity.entityId === "dup-1")!.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_a@2", "res_a@2"])
    expect(after.entities.find(entity => entity.entityId === "dup-2")!.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_a@2", "res_b@1", "res_a@2"])
    // 两个实体互不改动对方的引用集合。
    expect(mixed.entityIds).toEqual(["dup-2"])
  })

  test("保存重开后仍可替换；省略 version 取该资源当前最新已登记版本", async () => {
    const sceneId = "scene_reopen"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const saved = join(base, "saved-scene.json")
    await operations.save(sceneId, saved)
    const reopened = await operations.open(saved, { sceneId: "scene_reopened" })

    const first = await operations.replaceResource({ sceneId: "scene_reopened", entityId: "tree-1", expectedRevision: reopened.revision, resourceId: "res_tree", version: 2 })
    expect(first.changed).toBe(true)
    // 重开后实体身份与派生节点组都还在。
    const after = await operations.inspect("scene_reopened")
    expect(after.entities.map(entity => entity.entityId)).toEqual(reopened.entities.map(entity => entity.entityId))
    expect(after.entities.find(entity => entity.entityId === "tree-1:node:1")!.resources[0]!.version).toBe(2)

    // 省略 version：换到该资源当前最新已登记版本。
    await importResource(await fixture("tree-v3b.glb", treeV5()), { resourceId: "res_tree" })
    const latest = await operations.replaceResource({ sceneId: "scene_reopened", entityId: "tree-1", expectedRevision: first.revision, resourceId: "res_tree" })
    expect(latest.changed).toBe(true)
    expect(latest.to.version).toBe(3)
    expect((await operations.inspect("scene_reopened")).entities.find(entity => entity.entityId === "tree-1")!.resources[0]!.version).toBe(3)
  })

  test("未引用指定的旧引用 / 未知实体 / 未知资源 / 未知版本 / 回收站资源 / 字节不可用：全部拒绝且不改场景", async () => {
    const sceneId = "scene_reject"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    const v2 = await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const revision = (await operations.inspect(sceneId)).revision

    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "nope", expectedRevision: revision, resourceId: "res_tree", version: 2 }))).message).toMatch(/ENTITY_NOT_FOUND/)
    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: revision, resourceId: "res_tree", version: 2, fromResourceId: "res_other" }))).message).toMatch(/ENTITY_RESOURCE_NOT_FOUND/)
    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: revision, resourceId: "res_unknown", version: 1 }))).message).toMatch(/RESOURCE_NOT_FOUND/)
    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: revision, resourceId: "res_tree", version: 99 }))).message).toMatch(/RESOURCE_NOT_FOUND/)
    await operations.resources.trash({ resourceId: "res_tree" })
    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: revision, resourceId: "res_tree", version: 2 }))).message).toMatch(/RESOURCE_IN_TRASH/)
    await operations.resources.restore({ resourceId: "res_tree" })
    // 目标版本的原件字节被删掉：登记在库但不可核对，仍然拒绝。
    await unlink(localPath(v2.ref.original.uri))
    expect((await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: revision, resourceId: "res_tree", version: 2 }))).message).toMatch(/RESOURCE_UNAVAILABLE/)

    const after = await operations.inspect(sceneId)
    expect(after.revision).toBe(revision)
    expect(after.entities.find(entity => entity.entityId === "tree-1")!.resources[0]!.version).toBe(1)
  })

  test("GLB 结构不匹配：拒绝且绝不增删子节点", async () => {
    const sceneId = "scene_structure"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v3.glb", treeV3()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_STRUCTURE_MISMATCH/)
    expect(error.message).toMatch(/tree-1:node:2/)
    const after = await operations.inspect(sceneId)
    expect(after).toEqual(before)
    expect(after.entities.filter(entity => entity.entityId.startsWith("tree-1:")).length).toBe(3)
  })

  test("视觉类型不匹配：拒绝（换类型必须重建挂载）", async () => {
    const sceneId = "scene_kind"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    const splat = await importResource(await fixture("street.splat", Buffer.alloc(32, 5)), { resourceId: "res_street" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_street", version: splat.ref.version }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_KIND_MISMATCH/)
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("派生节点不能作为替换入口：必须提交组根实体", async () => {
    const sceneId = "scene_derived_entry"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    for (const entityId of ["tree-1:node:0", "tree-1:source"]) {
      const error = await rejection(() => operations.replaceResource({ sceneId, entityId, expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))
      expect(error.message).toMatch(/^REPLACE_RESOURCE_GROUP_ROOT_REQUIRED/)
    }
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("多引用实体：未指定 from* 拒绝歧义，指定后只替换那一条，独立引用不动", async () => {
    const sceneId = "scene_selection"
    await operations.create({ sceneId })
    const refA = await importResource(await fixture("street-a.splat", Buffer.alloc(32, 1)), { resourceId: "res_a" })
    const refB = await importResource(await fixture("street-b.splat", Buffer.alloc(32, 2)), { resourceId: "res_b" })
    const refA2 = await importResource(await fixture("street-a2.splat", Buffer.alloc(32, 3)), { resourceId: "res_a" })
    expect(refA2.ref.version).toBe(2)
    const patch = (entity: Entity) => ({ op: "add" as const, entity })
    await operations.scene.commit({ sceneId, expectedRevision: 0, patch: [patch({ entityId: "multi-1", name: "多引用", transform: identityTransform(), resources: [refA.ref, refB.ref], components: { annotation: { note: "多引用实体" } } })] })
    await operations.scene.commit({ sceneId, expectedRevision: 1, patch: [patch({ entityId: "other-1", name: "独立引用", transform: identityTransform(), resources: [refA.ref], components: {} })] })

    const ambiguous = await rejection(() => operations.replaceResource({ sceneId, entityId: "multi-1", expectedRevision: 2, resourceId: "res_a", version: 2 }))
    expect(ambiguous.message).toMatch(/^REPLACE_RESOURCE_TARGET_REQUIRED/)

    const result = await operations.replaceResource({ sceneId, entityId: "multi-1", expectedRevision: 2, resourceId: "res_a", version: 2, fromResourceId: "res_a", fromVersion: 1 })

    expect(result.changed).toBe(true)
    expect(result.entityIds).toEqual(["multi-1"])
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_OTHER_REFERENCES_UNCHANGED") && warning.includes("other-1"))).toBe(true)
    const after = await operations.inspect(sceneId)
    const multi = after.entities.find(entity => entity.entityId === "multi-1")!
    expect(multi.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_a@2", "res_b@1"])
    expect(multi.resources[0]!.original.uri).toBe(refA2.ref.original.uri)
    // 独立引用保持旧版本，没有被"顺手"升级。
    expect(after.entities.find(entity => entity.entityId === "other-1")!.resources[0]!.version).toBe(1)
    expect(multi.components).toEqual({ annotation: { note: "多引用实体" } })
  })

  test("GLB 展开组里有节点被移出组：拒绝，不制造混版渲染", async () => {
    const sceneId = "scene_stray"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const revision = (await operations.inspect(sceneId)).revision
    await operations.scene.commit({ sceneId, expectedRevision: revision, patch: [{ op: "reparent", entityId: "tree-1:node:1", parentId: "site" }] })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_GROUP_INCOMPLETE/)
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("源坐标声明变化：拒绝，不悄悄换轴/单位", async () => {
    const sceneId = "scene_axis"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    // glTF 默认按 Y-up 登记；同一结构声明成 Z-up 时，既有 `:source` 节点的变换会失效。
    await importResource(await fixture("tree-v5.glb", treeV5()), { resourceId: "res_tree", source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_COORDINATE_MISMATCH/)
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("节点局部变换不一致：拒绝，不把旧布局套在新网格上", async () => {
    const sceneId = "scene_diverged"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v4.glb", treeV4()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_NODE_TRANSFORM_MISMATCH/)
    expect(error.message).toMatch(/tree-1:node:0/)
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("只改节点名的新版本：替换成功并保留文档名称，如实报告分歧", async () => {
    const sceneId = "scene_renamed"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v6.glb", treeV6()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    const result = await operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })

    expect(result.changed).toBe(true)
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_NODE_NAME_DIVERGED"))).toBe(true)
    expect(result.warnings.some(warning => warning.includes("TRANSFORM"))).toBe(false)
    const after = await operations.inspect(sceneId)
    for (const entityId of ["tree-1:node:0", "tree-1:node:1"]) {
      const previous = before.entities.find(entity => entity.entityId === entityId)!, current = after.entities.find(entity => entity.entityId === entityId)!
      expect(current.name).toBe(previous.name)
      expect(current.transform).toEqual(previous.transform)
      expect(current.resources[0]!.version).toBe(2)
    }
  })

  /**
   * 沿既有物理化机制给某个版本登记派生默认（asset_bake 的产物：`componentDefaults` 就是它写的）。
   * 夹具里带 sceneId 的 import 也会把挂载用的 components 记成该版本的资源默认（真实挂载路径），
   * 两条路径对 `replaceResource` 是同一份 `record.componentDefaults`。
   */
  async function registerDefaults(resourceId: string, version: number, componentDefaults: Entity["components"]): Promise<void> {
    await operations.resources.attachPhysicalization(resourceId, version, { status: "ok", strategy: "auto", representations: [], componentDefaults })
  }

  /** 场景侧改动实体组件（用户在场景里调过碰撞/质量之类）：只更新该实体，不动资源默认。 */
  async function editComponents(sceneId: string, entityId: string, changes: Entity["components"]): Promise<SceneSnapshot> {
    const snapshot = await operations.inspect(sceneId)
    const entity = snapshot.entities.find(item => item.entityId === entityId)!
    return await operations.scene.commit({ sceneId, expectedRevision: snapshot.revision, patch: [{ op: "update", entityId, changes: { components: { ...entity.components, ...changes } } }] })
  }

  test("几何逐节点一致（材质/贴图变化）：保留 collision/rigidBody/controller 与用户批注，原位换引用", async () => {
    const sceneId = "scene_physics_kept"
    await sceneWithParent(sceneId)
    const solid = box(1)
    // v2 与 v1 是同一份几何：只是改了材质，导出器因此把同一网格拆成两个 primitive（真实导出器就是这样）。
    const collision = { shape: "convex_hull", frame: "mujoco-z-up-meters", boundSize: [1, 1, 1] }
    const rigidBody = { mass: 2, centerOfMass: [0.5, 0.5, 0.5] }
    const controller = { type: "ground", drive: "none" }
    await importResource(await fixture("box-v1.glb", solidGlb({ generator: "box-v1", nodes: [{ name: "箱体", mesh: solid }] })), { resourceId: "res_box", sceneId, entityId: "box-1", name: "箱", components: { collision, rigidBody, controller, annotation: { note: "用户批注" } } })
    await importResource(await fixture("box-v2.glb", solidGlb({ generator: "box-v2", nodes: [{ name: "箱体", mesh: split(solid, 2) }] })), { resourceId: "res_box" })
    // v2 的物理化产物（新版本按自己几何派生出来的同名组件）。
    await registerDefaults("res_box", 2, { collision, rigidBody, controller })
    const before = await operations.inspect(sceneId)

    const result = await operations.replaceResource({ sceneId, entityId: "box-1", expectedRevision: before.revision, resourceId: "res_box", version: 2 })

    expect(result.changed).toBe(true)
    expect(result.geometry).toMatchObject({ status: "identical", nodes: 1, vertices: 8, triangles: 12 })
    // 判据是几何事实而不是字节：两版文件的 primitive 划分/顶点缓冲布局都不同，几何指纹却一致。
    expect(result.geometry!.fromDigest).toBe(result.geometry!.toDigest)
    expect(result.physics).toMatchObject({ mode: "kept", components: ["collision", "rigidBody", "controller"] })
    expect(result.physics!.basis).toContain("geometry-identical")
    // 目标版本自带一致的派生默认：不该报分歧，也不该报"保留待重派生"。
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_PHYSICS_"))).toBe(false)
    expect(result.warnings.some(warning => warning.includes("REPLACE_RESOURCE_DEFAULTS_NOT_APPLIED"))).toBe(false)

    const after = await operations.inspect(sceneId)
    const entity = after.entities.find(item => item.entityId === "box-1")!
    expect(entity.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_box@2"])
    // 派生组件与用户批注逐字保留（材质更新不该动碰撞，也不该动用户的注释），身份/位姿/父子也不变。
    expect(entity.components).toEqual(before.entities.find(item => item.entityId === "box-1")!.components)
    expect(entity.components.annotation).toEqual({ note: "用户批注" })
    expect({ ...entity, resources: [] }).toEqual({ ...before.entities.find(item => item.entityId === "box-1")!, resources: [] })
  })

  test("几何一致但目标派生默认与实体现值不同：保留实体现值并如实报分歧，不悄悄改写", async () => {
    const sceneId = "scene_physics_diverged"
    await sceneWithParent(sceneId)
    const solid = box(1)
    const registered = { shape: "convex_hull", boundSize: [1, 1, 1] }
    // 用户在场景里把质量调过（= 实体现值不同于旧版本登记的派生默认），目标版本的派生默认又是另一份。
    await importResource(await fixture("mass-v1.glb", solidGlb({ generator: "mass-v1", nodes: [{ name: "箱体", mesh: solid }] })), { resourceId: "res_mass", sceneId, entityId: "mass-1", name: "箱", components: { collision: registered, rigidBody: { mass: 2 } } })
    const edited = await editComponents(sceneId, "mass-1", { rigidBody: { mass: 7 } })
    await importResource(await fixture("mass-v2.glb", solidGlb({ generator: "mass-v2", nodes: [{ name: "箱体", mesh: split(solid, 3) }] })), { resourceId: "res_mass" })
    await registerDefaults("res_mass", 2, { collision: registered, rigidBody: { mass: 2 } })

    const result = await operations.replaceResource({ sceneId, entityId: "mass-1", expectedRevision: edited.revision, resourceId: "res_mass", version: 2 })

    expect(result.geometry!.status).toBe("identical")
    expect(result.physics).toMatchObject({ mode: "kept", components: ["collision", "rigidBody"] })
    // 目标默认的 mass（2）与实体的用户值（7）不同 → 如实报分歧；collision 一致就不报。
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_PHYSICS_DIVERGED") && warning.includes("rigidBody"))).toBe(true)
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_PHYSICS_DIVERGED") && warning.includes("collision"))).toBe(false)
    const entity = (await operations.inspect(sceneId)).entities.find(item => item.entityId === "mass-1")!
    // 几何一致 → 用户的改动不动；替换只换引用。
    expect(entity.components).toEqual({ ...edited.entities.find(item => item.entityId === "mass-1")!.components })
    expect(entity.components.rigidBody).toEqual({ mass: 7 })
    expect(entity.resources[0]!.version).toBe(2)
  })

  test("同包围盒但内部几何不同：不误保留旧碰撞，按目标资源派生默认原位重派生", async () => {
    const sceneId = "scene_physics_same_bbox"
    await sceneWithParent(sceneId)
    const solid = box(1), pocketed = pocketBox(1)
    // 夹具事实：两版包围盒逐轴相同（按 bbox 判断会把这一版误当成"几何没变"）。
    expect(boundsOf(pocketed)).toEqual(boundsOf(solid))
    const collision = { shape: "convex_hull", frame: "mujoco-z-up-meters", boundSize: [1, 1, 1] }
    await importResource(await fixture("pocket-v1.glb", solidGlb({ generator: "pocket-v1", nodes: [{ name: "凹件", mesh: solid }] })), { resourceId: "res_pocket", sceneId, entityId: "pocket-1", name: "凹件", components: { collision, annotation: { note: "保留我" } } })
    await importResource(await fixture("pocket-v2.glb", solidGlb({ generator: "pocket-v2", nodes: [{ name: "凹件", mesh: pocketed }] })), { resourceId: "res_pocket" })
    const rederived = { shape: "mesh", frame: "mujoco-z-up-meters", boundSize: [1, 1, 0.5], concave: true }
    await registerDefaults("res_pocket", 2, { collision: rederived })
    const before = await operations.inspect(sceneId)

    const result = await operations.replaceResource({ sceneId, entityId: "pocket-1", expectedRevision: before.revision, resourceId: "res_pocket", version: 2 })

    expect(result.geometry!.status).toBe("changed")
    expect(result.geometry!.fromDigest).not.toBe(result.geometry!.toDigest)
    expect(result.physics).toMatchObject({ mode: "rederived", components: ["collision"] })
    expect(result.physics!.basis).toContain("geometry-changed")
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_PHYSICS_REDERIVED"))).toBe(true)
    const entity = (await operations.inspect(sceneId)).entities.find(item => item.entityId === "pocket-1")!
    // 新碰撞是目标资源派生的产物，不是旧碰撞；用户批注（与其它组件）逐字不动。
    expect(entity.components).toEqual({ ...before.entities.find(item => item.entityId === "pocket-1")!.components, collision: rederived })
    expect(entity.components.collision).not.toEqual(collision)
    expect(entity.resources[0]!.version).toBe(2)
  })

  test("尺寸真的变了：碰撞/刚体按目标版本重派生（不是沿用旧值）", async () => {
    const sceneId = "scene_physics_resized"
    await sceneWithParent(sceneId)
    const collision = { shape: "convex_hull", boundSize: [1, 1, 1] }
    const rigidBody = { mass: 1, inertia: [1, 1, 1] }
    await importResource(await fixture("size-v1.glb", solidGlb({ generator: "size-v1", nodes: [{ name: "箱体", mesh: box(1) }] })), { resourceId: "res_size", sceneId, entityId: "size-1", parentId: "site", name: "箱", components: { collision, rigidBody } })
    await importResource(await fixture("size-v2.glb", solidGlb({ generator: "size-v2", nodes: [{ name: "箱体", mesh: box(2) }] })), { resourceId: "res_size" })
    const grown = { shape: "convex_hull", boundSize: [2, 2, 2] }, heavier = { mass: 8, inertia: [8, 8, 8] }
    await registerDefaults("res_size", 2, { collision: grown, rigidBody: heavier })
    const before = await operations.inspect(sceneId)

    const result = await operations.replaceResource({ sceneId, entityId: "size-1", expectedRevision: before.revision, resourceId: "res_size", version: 2 })

    expect(result.geometry!.status).toBe("changed")
    expect(result.physics).toMatchObject({ mode: "rederived", components: ["collision", "rigidBody"] })
    const entity = (await operations.inspect(sceneId)).entities.find(item => item.entityId === "size-1")!
    expect(entity.components).toEqual({ ...before.entities.find(item => item.entityId === "size-1")!.components, collision: grown, rigidBody: heavier })
    // 位姿/父子没动：重派生只改派生组件本身。
    expect(entity.transform).toEqual(before.entities.find(item => item.entityId === "size-1")!.transform)
    expect(entity.parentId).toBe("site")
    expect(entity.resources[0]!.version).toBe(2)
  })

  /**
   * 扁平网格实体（Blender 等导出器的合法形态，69 的场景件就是这样）：实体自己持引用、视觉不是展开组，
   * 碰撞挂在同一个实体上。组形态有"节点局部变换不一致"的单独检查垫着；**扁平形态没有**——
   * 所以几何事实必须自己把节点内部位姿算进去（根反例 root-103-internal-transform-valid-probe.ts）。
   */
  async function flatMeshScene(sceneId: string, ref: ResourceRef, components: Entity["components"], revision: number, entityId = "flat-1"): Promise<SceneSnapshot> {
    return await operations.scene.commit({
      sceneId, expectedRevision: revision,
      patch: [{ op: "add", entity: { entityId, name: "网格件", transform: identityTransform(), resources: [ref], components: { visual: { kind: "mesh", sourceTransformApplied: false }, ...components } } }],
    })
  }
  /** 同一份字节、只把节点自身 translation 改成 [4,0,0]：画面几何整件右移 4 米。 */
  const shiftedGlb = (bytes: Buffer): Buffer => patchGlb(bytes, json => { json.nodes[0].translation = [4, 0, 0] })

  test("扁平网格实体：内部节点位姿变化（目标已派生）→ 按目标默认原位重派生，旧碰撞不停留", async () => {
    const sceneId = "scene_flat_shift_rederived"
    const revision = await sceneWithParent(sceneId)
    const collision = { shape: "box", center: [0.5, 0.5, 0.5], halfExtents: [0.5, 0.5, 0.5] }
    const bytes = solidGlb({ generator: "flat-v1", nodes: [{ name: "件", mesh: box(1) }] })
    const v1 = await importResource(await fixture("flat-v1.glb", bytes), { resourceId: "res_flat" })
    const v2 = await importResource(await fixture("flat-v2.glb", shiftedGlb(bytes)), { resourceId: "res_flat" })
    // 旧版本登记的派生默认 = 实体现值（否则会被当成"用户改过"，见下一条用例）。
    await registerDefaults("res_flat", 1, { collision })
    const before = await flatMeshScene(sceneId, v1.ref, { collision, annotation: { note: "保留我" } }, revision)
    const moved = { shape: "box", center: [4.5, 0.5, 0.5], halfExtents: [0.5, 0.5, 0.5] }
    await registerDefaults("res_flat", 2, { collision: moved })

    const result = await operations.replaceResource({ sceneId, entityId: "flat-1", expectedRevision: before.revision, resourceId: "res_flat", version: 2 })

    // 判据是实际显示的几何：readPositions 与两版字节的 POSITION 数组完全一样，只有节点 translation 不同。
    expect(result.geometry!.status).toBe("changed")
    expect(result.geometry!.fromDigest).not.toBe(result.geometry!.toDigest)
    expect(result.geometry!.frame).toContain("entity-local")
    expect(result.geometry!.fromBounds).toEqual({ min: [0, -1, 0], max: [1, 0, 1] })
    expect(result.geometry!.toBounds).toEqual({ min: [4, -1, 0], max: [5, 0, 1] })
    expect(result.physics).toMatchObject({ mode: "rederived", components: ["collision"] })
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_PHYSICS_REDERIVED"))).toBe(true)

    const entity = (await operations.inspect(sceneId)).entities.find(item => item.entityId === "flat-1")!
    // 新碰撞来自目标版本派生的默认，用户批注与身份/位姿逐字不动。
    expect(entity.components.collision).toEqual(moved)
    expect(entity.components.annotation).toEqual({ note: "保留我" })
    expect(entity.transform).toEqual(before.entities.find(item => item.entityId === "flat-1")!.transform)
    expect(entity.resources.map(ref => `${ref.resourceId}@${ref.version}`)).toEqual(["res_flat@2"])
  })

  test("扁平网格实体：内部节点位姿变化（目标未派生）→ 明确拒绝，零写入，绝不把旧碰撞留在原地", async () => {
    const sceneId = "scene_flat_shift_pending"
    const revision = await sceneWithParent(sceneId)
    const collision = { shape: "box", center: [0.5, 0.5, 0.5], halfExtents: [0.5, 0.5, 0.5] }
    const bytes = solidGlb({ generator: "flat-pending-v1", nodes: [{ name: "件", mesh: box(1) }] })
    const v1 = await importResource(await fixture("flat-pending-v1.glb", bytes), { resourceId: "res_flat_pending" })
    await importResource(await fixture("flat-pending-v2.glb", shiftedGlb(bytes)), { resourceId: "res_flat_pending" })
    await registerDefaults("res_flat_pending", 1, { collision })
    const before = await flatMeshScene(sceneId, v1.ref, { collision, annotation: { note: "保留我" } }, revision, "flat-2")

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "flat-2", expectedRevision: before.revision, resourceId: "res_flat_pending", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_PHYSICS_NOT_DERIVED/)
    expect(error.message).toContain("不能用旧碰撞冒充新几何")
    // 零写入：场景逐字节不变，旧碰撞仍在（但这是"没换成功"，不是"换了新几何还配旧碰撞"）。
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("扁平网格实体：内部节点位姿变化 + 碰撞不是旧版本的派生默认 → 拒绝且零写入（根反例的收敛形态）", async () => {
    const sceneId = "scene_flat_shift_customized"
    const revision = await sceneWithParent(sceneId)
    // 与根反例一致：collision 是调用方手写的（旧版本没有登记派生默认）→ 不能拿目标默认覆盖它，也不能留它。
    const collision = { shape: "box", center: [0.5, 0.5, 0.5], halfExtents: [0.5, 0.5, 0.5] }
    const bytes = solidGlb({ generator: "flat-custom-v1", nodes: [{ name: "件", mesh: box(1) }] })
    const v1 = await importResource(await fixture("flat-custom-v1.glb", bytes), { resourceId: "res_flat_custom" })
    await importResource(await fixture("flat-custom-v2.glb", shiftedGlb(bytes)), { resourceId: "res_flat_custom" })
    const before = await flatMeshScene(sceneId, v1.ref, { collision }, revision, "flat-3")

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "flat-3", expectedRevision: before.revision, resourceId: "res_flat_custom", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_DERIVED_COMPONENT_CUSTOMIZED/)
    expect(error.message).toContain("flat-3.collision")
    expect(error.message).toContain("世界变换已计入")
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("几何已变但目标版本尚未派生：明确报待办（PHYSICS_NOT_DERIVED），零写入，不拿旧碰撞冒充", async () => {
    const sceneId = "scene_physics_pending"
    await sceneWithParent(sceneId)
    const collision = { shape: "convex_hull", boundSize: [1, 1, 1] }
    await importResource(await fixture("pending-v1.glb", solidGlb({ generator: "pending-v1", nodes: [{ name: "箱体", mesh: box(1) }] })), { resourceId: "res_pending", sceneId, entityId: "pending-1", name: "箱", components: { collision } })
    await registerDefaults("res_pending", 1, { collision })
    // v2 导入时声明 physicalize:false（派生被跳过），目标版本没有可用的重派生值。
    await importResource(await fixture("pending-v2.glb", solidGlb({ generator: "pending-v2", nodes: [{ name: "箱体", mesh: pocketBox(1) }] })), { resourceId: "res_pending" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "pending-1", expectedRevision: before.revision, resourceId: "res_pending", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_PHYSICS_NOT_DERIVED/)
    expect(error.message).toContain("collision")
    expect(error.message).toContain("physicalization.status=skipped")
    expect(error.message).toContain("asset_bake")
    expect(error.message).toContain("不能用旧碰撞冒充新几何")
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("几何已变 + 用户改过派生组件：明确拒绝，不静默丢改动", async () => {
    const sceneId = "scene_physics_customized"
    await sceneWithParent(sceneId)
    const registered = { shape: "convex_hull", boundSize: [1, 1, 1] }
    // 实体的 collision 被场景改过（≠ 旧版本登记的派生默认），几何又变了：不能拿目标默认覆盖掉用户的改动。
    await importResource(await fixture("custom-v1.glb", solidGlb({ generator: "custom-v1", nodes: [{ name: "箱体", mesh: box(1) }] })), { resourceId: "res_custom", sceneId, entityId: "custom-1", name: "箱", components: { collision: registered } })
    const edited = await editComponents(sceneId, "custom-1", { collision: { shape: "box", boundSize: [1.5, 1.5, 1.5] } })
    await importResource(await fixture("custom-v2.glb", solidGlb({ generator: "custom-v2", nodes: [{ name: "箱体", mesh: pocketBox(1) }] })), { resourceId: "res_custom" })
    await registerDefaults("res_custom", 2, { collision: { shape: "mesh", boundSize: [1, 1, 0.5] } })
    const before = edited

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "custom-1", expectedRevision: before.revision, resourceId: "res_custom", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_DERIVED_COMPONENT_CUSTOMIZED/)
    expect(error.message).toContain("custom-1.collision")
    expect(error.message).toContain("重建挂载")
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("派生组件 + 原件几何读不出（无网格节点）：拒绝（GEOMETRY_UNVERIFIABLE），零写入", async () => {
    const sceneId = "scene_physical"
    await sceneWithParent(sceneId)
    // 这一片的夹具 GLB 只有 JSON chunk、没有网格节点：没有可比对几何就不放行，也不退回 bbox 之类的弱证据。
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树", components: { collision: { shape: "convex_hull" }, rigidBody: { mass: 1 } } })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_GEOMETRY_UNVERIFIABLE/)
    expect(error.message).toContain("GEOMETRY_NO_MESH_NODE")
    expect(error.message).toContain("collision")
    expect(error.message).toContain("rigidBody")
    expect(error.message).toContain("重建挂载")
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("机器人实体：拒绝（mujoco/articulation/controller/visual.robot 由旧原件派生）", async () => {
    const sceneId = "scene_robot"
    await operations.create({ sceneId })
    const mjcf = (model: string, body: string) => `<mujoco model="${model}"><worldbody><body name="${body}"/></worldbody></mujoco>`
    const v1 = await importResource(await fixture("arm-v1.xml", mjcf("arm_one", "base")), { resourceId: "res_arm", sceneId, entityId: "arm-1", name: "机械臂", components: { controller: { type: "arm" } } })
    const before = await operations.inspect(sceneId)
    expect(before.entities[0]!.components.mujoco).toEqual({ sourcePath: localPath(v1.ref.original.uri) })
    await importResource(await fixture("arm-v2.xml", mjcf("arm_two", "底座")), { resourceId: "res_arm" })

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "arm-1", expectedRevision: before.revision, resourceId: "res_arm", version: 2 }))

    expect(error.message).toMatch(/^REPLACE_RESOURCE_UNSUPPORTED_COMPONENTS/)
    for (const name of ["mujoco", "articulation", "controller", "visual.robot"]) expect(error.message).toMatch(new RegExp(name.replace(".", "\\.")))
    // 拒绝发生在提交之前：文档仍是旧原件，不出现"引用换了、sim 仍加载旧模型"的中间态。
    expect(await operations.inspect(sceneId)).toEqual(before)
  })

  test("同一资源的多个实例：只替换指定实例，其它实例连派生节点一起原样保留", async () => {
    const sceneId = "scene_instances"
    await operations.create({ sceneId })
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-a", name: "树A" })
    // 同一 resourceId@version 再挂两个实例：一个平级、一个挂在被替换的组根下面。
    await operations.mount({ sceneId, resourceId: "res_tree", version: 1, entityId: "tree-b" })
    await operations.mount({ sceneId, resourceId: "res_tree", version: 1, entityId: "tree-c", parentId: "tree-a" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)
    expect(before.entities.filter(entity => entity.resources.some(ref => ref.version === 1)).length).toBe(9)

    const result = await operations.replaceResource({ sceneId, entityId: "tree-a", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })

    expect(result.changed).toBe(true)
    expect([...result.entityIds].sort()).toEqual(["tree-a", "tree-a:node:0", "tree-a:node:1"])
    expect(result.warnings.some(warning => warning.startsWith("REPLACE_RESOURCE_OTHER_REFERENCES_UNCHANGED") && warning.includes("tree-b"))).toBe(true)
    const after = await operations.inspect(sceneId)
    // 实体集合与顺序不变：没有新增/删除任何子节点。
    expect(after.entities.map(entity => entity.entityId)).toEqual(before.entities.map(entity => entity.entityId))
    for (const entity of after.entities) {
      const version = entity.entityId.startsWith("tree-a:") || entity.entityId === "tree-a" ? 2 : 1
      expect(entity.resources.map(ref => ref.version)).toEqual(entity.resources.length ? [version] : [])
    }
    // 其它实例（含挂在被替换组根下面的那个）逐字不变。
    for (const entityId of ["tree-b", "tree-b:source", "tree-b:node:0", "tree-b:node:1", "tree-c", "tree-c:source", "tree-c:node:0", "tree-c:node:1"]) {
      expect(after.entities.find(entity => entity.entityId === entityId)).toEqual(before.entities.find(entity => entity.entityId === entityId))
    }
  })

  test("无写入的 no-op 也要核对当下 revision：期间有人提交则报冲突，不交回旧快照", async () => {
    const sceneId = "scene_noop_race"
    await sceneWithParent(sceneId)
    await importResource(await fixture("tree-v1.glb", treeV1()), { resourceId: "res_tree", sceneId, entityId: "tree-1", name: "树" })
    await importResource(await fixture("tree-v2.glb", treeV2()), { resourceId: "res_tree" })
    const before = await operations.inspect(sceneId)
    const first = await operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: before.revision, resourceId: "res_tree", version: 2 })
    expect(first.changed).toBe(true)
    // 只有目标已经是当前引用时才是 no-op；这时若别人先提交，替换不能把旧快照当当前结果交回。
    const readRecord = operations.resources.get.bind(operations.resources)
    operations.resources.get = async (resourceId: string, version?: number) => {
      const record = await readRecord(resourceId, version)
      await operations.scene.commit({ sceneId, expectedRevision: first.revision, patch: [{ op: "update", entityId: "site", changes: { name: "并发改名" } }] })
      return record
    }

    const error = await rejection(() => operations.replaceResource({ sceneId, entityId: "tree-1", expectedRevision: first.revision, resourceId: "res_tree", version: 2 }))

    expect(error).toBeInstanceOf(SceneConflict)
    const after = await operations.inspect(sceneId)
    expect(after.revision).toBe(first.revision + 1)
    expect(after.entities.find(entity => entity.entityId === "site")!.name).toBe("并发改名")
  })
})
