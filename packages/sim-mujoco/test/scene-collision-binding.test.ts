/** Offline backend route contract: trusted splat binding -> MuJoCo collisionPatches compilation. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { SceneCollisionBuilder } from "../src/scene-collision/index.ts"

let root: string
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

function triangleGlb(): Buffer {
  const vertices = Buffer.alloc(36)
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
  points.forEach((point, index) => point.forEach((value, axis) => vertices.writeFloatLE(value, index * 12 + axis * 4)))
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: "surface" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.length }], buffers: [{ byteLength: vertices.length }] }), "utf8")
  const pad = (bytes: Buffer, fill: number) => Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4, fill)])
  const j = pad(json, 0x20), b = pad(vertices, 0)
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, j, bh, b])
}

function snapshot(meshUri: string, meshHash: string, alignmentStatus: "machine-verified" | "candidate" = "machine-verified") {
  return {
    sceneId: "splat-scene", revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 },
    entities: [{ entityId: "splat", name: "splat", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [{ resourceId: "splat-r", version: 1, source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 }, representations: [{ uri: meshUri, mimeType: "model/gltf-binary", role: "collision" }] }], components: { visual: { kind: "splat" }, collision: { shape: "mesh", frame: "mujoco-z-up-meters", binding: { splat: { path: "room.spz", sha256: "a".repeat(64) }, mesh: { path: "room.glb", sha256: meshHash }, meshToSplat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], alignmentStatus, method: "test-paired-splat-glb", revision: meshHash } } } }],
  } as any
}

beforeEach(async () => { root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mujoco-splat-collision-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe("MuJoCo 3DGS collisionPatches route", () => {
  test("trusted binding compiles a hfield/box collision patch", async () => {
    const mesh = triangleGlb(), path = join(root, "room.glb")
    await writeFile(path, mesh)
    const result = await new SceneCollisionBuilder().build(snapshot(pathToFileURL(path).href, sha256(mesh)))
    expect(result.warnings.every(item => item.code === "SCENE_COLLISION_PROVIDER_NOTE")).toBe(true)
    expect(result.warnings.some(item => item.message.includes("single-height projection"))).toBe(true)
    expect(result.compilation).not.toBeNull()
    expect(result.compilation?.entityId).toBe("splat")
    expect(result.compilation?.frame).toBe("mujoco-z-up-meters")
    expect(result.compilation?.suppressDefaultGround).toBe(true)
    expect(result.compilation?.ground.kind).toBe("hfield")
  })

  test("candidate alignment is blocked before worker patch compilation", async () => {
    const mesh = triangleGlb(), path = join(root, "room.glb")
    await writeFile(path, mesh)
    const result = await new SceneCollisionBuilder().build(snapshot(pathToFileURL(path).href, sha256(mesh), "candidate"))
    expect(result.compilation).toBeNull()
    expect(result.warnings.some(item => item.code === "SCENE_COLLISION_ALIGNMENT_BLOCKED")).toBe(true)
  })
})
