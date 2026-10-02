/**
 * 3DGS -> collision acceptance contract.
 *
 * A splat is visual-only unless it carries a trusted, hash-matched companion
 * mesh binding. This test fixes the backend route: import/register the splat,
 * validate the binding, expose collision components to SceneOperations, and
 * reject a mismatched binding as candidate rather than pretending it is ready.
 * It does not claim a real MuJoCo contact; that requires a package/runtime
 * provider receipt and is tracked separately in G3/G6 acceptance.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SceneOperations } from "../src/operations.ts"
import type { SceneGeometryBinding } from "../../lyapunov-contracts/src/types.ts"

let root: string
let operations: SceneOperations

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

beforeEach(async () => {
  root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "lyapunov-splat-collision-"))
  operations = new SceneOperations(join(root, "data"), { productRoot: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(name: string, bytes: Buffer): Promise<{ path: string; hash: string }> {
  const path = join(root, "materials", name)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, bytes)
  return { path, hash: sha256(bytes) }
}

function binding(splatPath: string, splatHash: string, meshPath: string, meshHash: string, alignmentStatus: "machine-verified" | "candidate" = "machine-verified"): SceneGeometryBinding {
  return {
    splat: { path: splatPath, sha256: splatHash },
    mesh: { path: meshPath, sha256: meshHash },
    meshToSplat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    alignmentStatus,
    method: "test-paired-splat-glb",
    revision: meshHash,
  }
}

describe("3DGS collision route", () => {
  test("hash-matched companion mesh becomes a trusted collision binding", async () => {
    const splat = await fixture("assets/room.spz", Buffer.from("NGSP-test-splat"))
    const mesh = await fixture("assets/room.glb", Buffer.from("glTF-test-collision-mesh"))
    const record = await operations.resources.import({
      path: splat.path,
      name: "room splat",
      sceneGeometryBinding: binding("assets/room.spz", splat.hash, "assets/room.glb", mesh.hash),
    })

    expect(record.parsed.kind).toBe("splat")
    expect(record.sceneGeometryBinding?.alignmentStatus).toBe("machine-verified")
    expect(record.ref.representations.some(item => item.role === "collision")).toBe(true)
    const scene = await operations.create({ sceneId: "collision_scene" })
    const mounted = await operations.mount({ sceneId: scene.sceneId, resourceId: record.ref.resourceId, version: record.ref.version })
    expect(mounted.snapshot.entities[0]?.components.collision).toMatchObject({ shape: "mesh", binding: record.sceneGeometryBinding })
  })

  test("binding hash mismatch is downgraded to candidate and cannot enter trusted collision route", async () => {
    const splat = await fixture("assets/room.spz", Buffer.from("NGSP-test-splat"))
    const mesh = await fixture("assets/room.glb", Buffer.from("glTF-test-collision-mesh"))
    const record = await operations.resources.import({
      path: splat.path,
      name: "room splat",
      sceneGeometryBinding: binding("assets/room.spz", "0".repeat(64), "assets/room.glb", mesh.hash),
    })

    expect(record.parsed.kind).toBe("splat")
    expect(record.sceneGeometryBinding?.alignmentStatus).toBe("candidate")
    expect(record.warnings?.some(message => message.includes("candidate"))).toBe(true)
    expect(record.componentDefaults?.collision).toBeUndefined()
  })

  test("a pure splat without a companion mesh remains visual-only", async () => {
    const splat = await fixture("assets/visual-only.spz", Buffer.from("NGSP-visual-only"))
    const record = await operations.resources.import({ path: splat.path, name: "visual-only splat" })

    expect(record.parsed.kind).toBe("splat")
    expect(record.sceneGeometryBinding).toBeUndefined()
    expect(record.ref.representations.some(item => item.role === "collision")).toBe(false)
    expect(record.componentDefaults?.collision).toBeUndefined()
  })
})
