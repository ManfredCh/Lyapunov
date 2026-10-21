/**
 * V10-08/38：只读放置预览的真实几何回归。
 *
 * 证明：预览与 `scene_mount` 共用同一份资源核对/落点底面对齐/纯节点构造，但不提交 Scene、
 * 不调度物理化、不写资源版本；GLB 与 Panda(MJCF) 都返回可显示的临时 Entity，且确认所需的
 * 最终 transform 与预览一致。机器人文档引用只换成该版本依赖闭包内的媒体标记。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { SceneOperations } from "../src/operations.ts"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const GLB = join(ROOT, "materials", "mcp-env", "assets", "kenney-props", "visual", "prop_10_traffic-light.glb")
const PANDA = join(ROOT, "materials", "robots", "franka_panda", "franka_emika_panda", "panda.xml")

let base: string, operations: SceneOperations
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-asset-preview-"))
  operations = new SceneOperations(join(base, "data"))
  await operations.create({ sceneId: "preview-scene" })
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe("V10 只读放置预览（真实几何，不写 Scene/物理）", () => {
  test("GLB：真实 glbEntities + 底面对齐 transform；Scene revision/entities 不变", async () => {
    const imported = await operations.import({ path: GLB, resourceId: "preview-glb", physicalize: false })
    const before = await operations.scene.snapshot("preview-scene")
    const preview = await operations.previewMount({
      sceneId: "preview-scene", resourceId: imported.resource.ref.resourceId, version: imported.resource.ref.version,
      token: "placement-1", transform: { position: [1.25, -0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, alignBottomToSurface: true,
    })
    expect(preview.status).toBe("PREVIEW")
    expect(preview.token).toBe("placement-1")
    expect(preview.resourceId).toBe(imported.resource.ref.resourceId)
    expect(preview.entities?.length).toBeGreaterThan(1)
    // root 是真实 GLB 展开组；source 节点保留源坐标转换，mesh 节点带 gltfNode。
    expect(preview.entities![0]!.components.visual?.kind).toBe("group")
    expect(preview.entities!.some(entity => entity.components.visual?.gltfNode !== undefined)).toBe(true)
    expect(preview.transform!.position[0]).toBe(1.25)
    // 底面对齐只改 z（抬升量来自真实包围盒）；不提交 Scene，也不写资源版本。
    expect(preview.transform!.position[0]).toBe(1.25)
    expect(preview.transform!.position[1]).toBe(-0.5)
    expect(Number.isFinite(preview.transform!.position[2])).toBe(true)
    expect(preview.transform!.position[2]).not.toBe(0)
    const after = await operations.scene.snapshot("preview-scene")
    expect(after.revision).toBe(before.revision)
    expect(after.entities.length).toBe(before.entities.length)
    const record = await operations.resources.get(imported.resource.ref.resourceId, imported.resource.ref.version)
    expect(record.ref.version).toBe(imported.resource.ref.version)
  })

  test("URDF：相对 <mesh filename> 换成媒体标记并补 mimeType 表示；预览仍不写 Scene", async () => {
    const dir = join(base, "urdf")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "part.STL"), "solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid part\n")
    const urdf = join(dir, "arm.urdf")
    await writeFile(urdf, '<robot name="arm"><link name="base"><visual><geometry><mesh filename="part.STL"/></geometry></visual></link></robot>')
    const imported = await operations.import({ path: urdf, resourceId: "preview-urdf", physicalize: false })
    const before = await operations.scene.snapshot("preview-scene")
    const preview = await operations.previewMount({ sceneId: "preview-scene", resourceId: imported.resource.ref.resourceId, version: imported.resource.ref.version, token: "placement-urdf", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, alignBottomToSurface: false })
    expect(preview.status).toBe("PREVIEW")
    const entity = preview.entities![0]!
    const robot = entity.components.visual?.robot as { document?: { robot?: unknown } }
    expect(JSON.stringify(robot.document)).toContain("res:")
    expect(JSON.stringify(robot.document)).not.toContain("part.STL")
    expect(entity.resources[0]!.representations.some(rep => rep.mimeType === "model/stl" && rep.uri.endsWith("part.STL"))).toBe(true)
    const after = await operations.scene.snapshot("preview-scene")
    expect(after.revision).toBe(before.revision)
    expect(after.entities.length).toBe(before.entities.length)
  })

  test("Panda：真实 MJCF 视觉 + 媒体标记；不提交 Scene/物理", async () => {
    const imported = await operations.import({ path: PANDA, resourceId: "preview-panda", physicalize: false })
    const before = await operations.scene.snapshot("preview-scene")
    const preview = await operations.previewMount({
      sceneId: "preview-scene", resourceId: imported.resource.ref.resourceId, version: imported.resource.ref.version,
      token: "placement-panda", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, alignBottomToSurface: false,
    })
    expect(preview.status).toBe("PREVIEW")
    expect(preview.kind).toBe("robot")
    const entities = preview.entities ?? []
    const robot = entities[0]!.components.visual?.robot as { format?: string; document?: { asset?: unknown } }
    expect(robot?.format).toBe("mjcf")
    expect(JSON.stringify(robot?.document)).toContain("res:")
    expect(entities[0]!.components.visual?.kind).toBe("robot")
    expect(entities[0]!.transform.position.every(value => Number.isFinite(value))).toBe(true)
    const after = await operations.scene.snapshot("preview-scene")
    expect(after.revision).toBe(before.revision)
    expect(after.entities.length).toBe(before.entities.length)
    const record = await operations.resources.get(imported.resource.ref.resourceId, imported.resource.ref.version)
    expect(record.physicalizationRequest).not.toBe(true)
  })
})
