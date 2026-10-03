/**
 * 几何事实必须覆盖**实际显示出来的坐标**：节点自身与全部内部祖先的 TRS/matrix、源坐标轴适配与米换算。
 *
 * 判据的独立性：这里不拿本仓自己的 hash 互证，而是用 **three 的真实 GLTFLoader**（Viewer 用的同一个加载器）
 * 把 GLB 加载出来、用 `Box3` 量出画面几何，再把包围盒按产品包装原件用的 `sourceTransform` 换算到实体本地
 * 坐标系，与本仓几何事实里的 `bounds` 逐轴对齐。夹具用真 POSITION/索引访问器（`solidGlb`），
 * `patchGlb` 只改 JSON chunk（与 `root-103-internal-transform-valid-probe.ts` 同一手法）。
 */
import { describe, expect, test } from "bun:test"
import { Box3, Matrix4, Quaternion, Vector3 } from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import type { ResourceRef, Vec3 } from "../../lyapunov-contracts/src/types.ts"
import { GLTF_SOURCE, sourceTransform } from "../src/formats.ts"
import { compareGlbGeometry, glbGeometryFacts, type GlbGeometryFacts } from "../src/mesh-geometry.ts"
import { box, patchGlb, pocketBox, solidGlb, type Solid } from "./glb-geometry-fixture.ts"

const QUATERNION_ROTATE_X_90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number]

/** 真实 GLTFLoader 量出的画面包围盒：raw 是 glTF 根坐标系（Y-up、源单位），local 是按源坐标换算后的实体本地坐标系。 */
async function loaderBounds(bytes: Buffer, source: ResourceRef["source"] = GLTF_SOURCE): Promise<{ raw: { min: Vec3; max: Vec3 }; local: { min: Vec3; max: Vec3 } }> {
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer, "")
  gltf.scene.updateMatrixWorld(true)
  const raw = new Box3().setFromObject(gltf.scene, true)
  const transform = sourceTransform(source)
  const matrix = new Matrix4().compose(new Vector3(...transform.position), new Quaternion(...transform.quaternion), new Vector3(...transform.scale))
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const x of [raw.min.x, raw.max.x]) for (const y of [raw.min.y, raw.max.y]) for (const z of [raw.min.z, raw.max.z]) {
    const corner = new Vector3(x, y, z).applyMatrix4(matrix)
    min.min(corner); max.max(corner)
  }
  return { raw: { min: raw.min.toArray() as Vec3, max: raw.max.toArray() as Vec3 }, local: { min: min.toArray() as Vec3, max: max.toArray() as Vec3 } }
}

const near = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) < 1e-5)
/** 事实里的包围盒与加载器量出来的（已换算到实体本地）逐轴对齐。 */
function expectBoundsMatchLoader(facts: GlbGeometryFacts, bounds: { min: Vec3; max: Vec3 }): void {
  expect(near(facts.bounds.min, bounds.min)).toBe(true)
  expect(near(facts.bounds.max, bounds.max)).toBe(true)
}

/** 面片绕向全部反转的同一份顶点（判据必须保留绕向）。 */
function reversed(solid: Solid): Solid {
  return { positions: solid.positions, triangles: solid.triangles.map(([a, b, c]): [number, number, number] => [a, c, b]) }
}

const factsOf = (bytes: Buffer, source?: ResourceRef["source"]): GlbGeometryFacts => glbGeometryFacts(bytes, source ? { source } : {})

describe("几何事实：实际显示坐标（真实 GLTFLoader 独立核对）", () => {
  test("节点内部 translation 改变：画面位移，判几何变化并报出实际包围盒", async () => {
    const v1 = solidGlb({ generator: "flat-v1", nodes: [{ name: "盒", mesh: box(1) }] })
    const v2 = patchGlb(v1, json => { json.nodes[0].translation = [4, 0, 0] })
    // 加载器事实：与根反例日志逐字相同（root-103-internal-transform-valid-probe.log）。
    const before = await loaderBounds(v1), after = await loaderBounds(v2)
    expect(near(before.raw.min, [0, 0, 0]) && near(before.raw.max, [1, 1, 1])).toBe(true)
    expect(near(after.raw.min, [4, 0, 0]) && near(after.raw.max, [5, 1, 1])).toBe(true)

    const from = factsOf(v1), to = factsOf(v2)
    const comparison = compareGlbGeometry(from, to)
    expect(comparison.identical).toBe(false)
    expect(comparison.reason).toContain("世界变换已计入")
    expect(to.digest).not.toBe(from.digest)
    expectBoundsMatchLoader(from, before.local)
    expectBoundsMatchLoader(to, after.local)
  })

  test("内部父层旋转 90°：画面包围盒逐轴不变，几何仍判变化（bbox 判据会漏）", async () => {
    // 绕 X 轴转 90° 再把父节点平移 [0,1,0]：映射 (x,y,z) → (x,1-z,y) 是 [0,1]³ 到自身的刚体置换，
    // 包围盒逐轴不变；但凹腔（pocketBox 顶面那个坑）转到了别的面上——只有逐面几何事实能看出来。
    const v1 = solidGlb({ generator: "rot-v1", nodes: [{ name: "底座", children: [1] }, { name: "盒", mesh: pocketBox(1) }] })
    const v2 = patchGlb(v1, json => { json.nodes[0].rotation = QUATERNION_ROTATE_X_90; json.nodes[0].translation = [0, 1, 0] })
    const before = await loaderBounds(v1), after = await loaderBounds(v2)
    expect(near(after.raw.min, before.raw.min)).toBe(true)
    expect(near(after.raw.max, before.raw.max)).toBe(true)
    expect(near(after.raw.min, [0, 0, 0]) && near(after.raw.max, [1, 1, 1])).toBe(true)

    const from = factsOf(v1), to = factsOf(v2)
    expect(compareGlbGeometry(from, to).identical).toBe(false)
    // 顶点数/面片数一点没变：按计数判断同样会漏。
    expect(to.nodes.get(1)!.vertexCount).toBe(from.nodes.get(1)!.vertexCount)
    expect(to.nodes.get(1)!.triangleCount).toBe(from.nodes.get(1)!.triangleCount)
    expectBoundsMatchLoader(to, after.local)
  })

  test("内部父层 scale 1.5：判变化，实际尺寸按加载器读数放大", async () => {
    const v1 = solidGlb({ generator: "scale-v1", nodes: [{ name: "组", children: [1] }, { name: "盒", mesh: box(1) }] })
    const v2 = patchGlb(v1, json => { json.nodes[0].scale = [1.5, 1.5, 1.5] })
    const after = await loaderBounds(v2)
    expect(near(after.raw.max, [1.5, 1.5, 1.5])).toBe(true)

    const from = factsOf(v1), to = factsOf(v2)
    expect(compareGlbGeometry(from, to).identical).toBe(false)
    expectBoundsMatchLoader(to, after.local)
    // 顶点数/面片数一点没变：只按计数或 bbox 判都会漏。
    expect(to.vertexCount).toBe(from.vertexCount)
    expect(to.triangleCount).toBe(from.triangleCount)
  })

  test("父层平移 + 子层反向平移（净变换为零）：判一致——不是“有 TRS 就算变”", async () => {
    const v1 = solidGlb({ generator: "net-v1", nodes: [{ name: "组", children: [1] }, { name: "盒", mesh: box(1) }] })
    const v2 = patchGlb(v1, json => { json.nodes[0].translation = [3, 0, 0]; json.nodes[1].translation = [-3, 0, 0] })
    const before = await loaderBounds(v1), after = await loaderBounds(v2)
    expect(near(after.raw.max, before.raw.max)).toBe(true)

    expect(compareGlbGeometry(factsOf(v1), factsOf(v2)).identical).toBe(true)
  })

  test("父层 matrix（列主序）与等价 TRS 判一致：口径与 three 的 fromArray 相同", async () => {
    const plain = solidGlb({ generator: "matrix-v1", nodes: [{ name: "组", children: [1] }, { name: "盒", mesh: box(1) }] })
    const transform = { translation: [2, 0, 0] as [number, number, number], rotation: QUATERNION_ROTATE_X_90, scale: [2, 2, 2] as [number, number, number] }
    const asTrs = patchGlb(plain, json => { json.nodes[0].translation = transform.translation; json.nodes[0].rotation = transform.rotation; json.nodes[0].scale = transform.scale })
    const asMatrix = patchGlb(plain, json => {
      json.nodes[0].matrix = new Matrix4().compose(new Vector3(...transform.translation), new Quaternion(...transform.rotation), new Vector3(...transform.scale)).toArray()
    })
    const loaded = await loaderBounds(asTrs), loadedMatrix = await loaderBounds(asMatrix)
    expect(near(loaded.raw.max, loadedMatrix.raw.max)).toBe(true)
    expect(compareGlbGeometry(factsOf(asTrs), factsOf(asMatrix)).identical).toBe(true)
    // 与"没有内部变换"的版本不同，且与加载器读数一致。
    expect(compareGlbGeometry(factsOf(plain), factsOf(asTrs)).identical).toBe(false)
    expectBoundsMatchLoader(factsOf(asTrs), loaded.local)
  })

  test("sparse 变位：base 顶点数组逐字节相同，仍判几何变化（不能只读 base）", async () => {
    const v1 = solidGlb({ generator: "sparse-v1", nodes: [{ name: "盒", mesh: box(1) }] })
    const v2 = solidGlb({ generator: "sparse-v1", nodes: [{ name: "盒", mesh: box(1), sparse: { vertex: 5, offset: [0.002, 0, 0] } }] })
    // 对照：把 sparse 摘掉之后就是同一份 base，判据必须报"一致"——差别只在 sparse 覆盖值。
    const stripped = patchGlb(v2, json => { for (const accessor of json.accessors) delete accessor.sparse })
    expect(compareGlbGeometry(factsOf(v1), factsOf(stripped)).identical).toBe(true)
    expect(compareGlbGeometry(factsOf(v1), factsOf(v2)).identical).toBe(false)
    // 加载器独立读数：第 5 个顶点（[1,0,1]）被推到 x=1.002，画面包围盒跟着往外 2mm。
    const after = await loaderBounds(v2)
    expect(near(after.raw.max, [1.002, 1, 1])).toBe(true)
    expectBoundsMatchLoader(factsOf(v2), after.local)
  })

  test("sparse-only accessor（没有 base bufferView）：按规范读真值，不报不可核对", async () => {
    const base = solidGlb({ generator: "sparse-only", nodes: [{ name: "盒", mesh: box(1) }] })
    const sparseOnly = solidGlb({ generator: "sparse-only", nodes: [{ name: "盒", mesh: box(1), sparse: { vertex: 0, offset: [0.25, 0, 0], base: false } }] })
    const after = await loaderBounds(sparseOnly)
    // base 全零（其余顶点都在原点），只有第 0 个顶点被 sparse 移到 x=0.25：包围盒按真值就是 [0,0,0]..[0.25,0,0]。
    expect(near(after.raw.min, [0, 0, 0]) && near(after.raw.max, [0.25, 0, 0])).toBe(true)
    expect(compareGlbGeometry(factsOf(base), factsOf(sparseOnly)).identical).toBe(false)
    expectBoundsMatchLoader(factsOf(sparseOnly), after.local)
  })

  test("源坐标单位换算：metersPerUnit 变则实际尺寸变；声明不可换算则报不可核对", () => {
    const bytes = solidGlb({ generator: "unit-v1", nodes: [{ name: "盒", mesh: box(1) }] })
    const meters = factsOf(bytes)
    expect(meters.unitScale).toBe(1)
    expect(compareGlbGeometry(meters, factsOf(bytes, { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 })).identical).toBe(true)
    const inches = factsOf(bytes, { units: "in", upAxis: "Y", handedness: "right", metersPerUnit: 0.0254 })
    const comparison = compareGlbGeometry(meters, inches)
    expect(comparison.identical).toBe(false)
    expect(comparison.reason).toContain("单位换算")
    // 单位声明不完整/左手系：读不出实际尺度就不放行。
    expect(() => factsOf(bytes, { units: "ft", upAxis: "Y", handedness: "right" })).toThrow(/SOURCE_UNIT_SCALE_REQUIRED/)
    expect(() => factsOf(bytes, { units: "m", upAxis: "Y", handedness: "left", metersPerUnit: 1 })).toThrow(/SOURCE_COORDINATE_ADAPTER_REQUIRED/)
  })

  test("面片绕向变化仍判不同（triangleKey 保留绕向）", () => {
    const solid = box(1)
    const v1 = solidGlb({ generator: "winding-v1", nodes: [{ name: "盒", mesh: solid }] })
    const v2 = solidGlb({ generator: "winding-v1", nodes: [{ name: "盒", mesh: reversed(solid) }] })
    expect(compareGlbGeometry(factsOf(v1), factsOf(v2)).identical).toBe(false)
  })

  test("默认场景之外的网格节点不参与：显示集合变化要判不同", () => {
    const nodes = [{ name: "盒" as string, mesh: box(1) }, { name: "隐藏件", mesh: box(0.5) }]
    const hidden = solidGlb({ generator: "scene-v1", nodes, roots: [0] })
    const shown = patchGlb(hidden, json => { json.scenes[0].nodes = [0, 1] })
    expect([...factsOf(hidden).nodes.keys()]).toEqual([0])
    expect([...factsOf(shown).nodes.keys()]).toEqual([0, 1])
    expect(compareGlbGeometry(factsOf(hidden), factsOf(shown)).identical).toBe(false)
    expect(compareGlbGeometry(factsOf(shown), factsOf(hidden)).identical).toBe(false)
  })

  test("读不出有效静态几何的形态：逐条报明确代码，不靠 base 数组放行", () => {
    const plain = solidGlb({ generator: "bad-v1", nodes: [{ name: "盒", mesh: box(1) }] })
    const cases: Array<[string, (json: any) => void, RegExp]> = [
      ["外部 buffer", json => { json.buffers[0].uri = "mesh.bin" }, /GEOMETRY_EXTERNAL_BUFFER/],
      ["draco 压缩扩展", json => { json.extensionsUsed = ["KHR_draco_mesh_compression"] }, /GEOMETRY_EXTENSION_UNSUPPORTED/],
      ["meshopt bufferView 扩展", json => { json.bufferViews[0].extensions = { EXT_meshopt_compression: {} } }, /GEOMETRY_BUFFER_VIEW_EXTENSION_UNSUPPORTED/],
      ["primitive 级扩展", json => { json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} } }, /GEOMETRY_PRIMITIVE_EXTENSION_UNSUPPORTED/],
      ["morph targets", json => { json.meshes[0].primitives[0].targets = [{ POSITION: 0 }] }, /GEOMETRY_MORPH_TARGETS_UNSUPPORTED/],
      ["驱动显示节点的动画", json => { json.animations = [{ channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [] }] }, /GEOMETRY_ANIMATION_UNSUPPORTED/],
      ["蒙皮", json => { json.skins = [{ joints: [0] }]; json.nodes[0].skin = 0 }, /GEOMETRY_SKINNED_MESH_UNSUPPORTED/],
      ["整数坐标", json => { json.accessors[json.meshes[0].primitives[0].attributes.POSITION].componentType = 5122 }, /GEOMETRY_POSITION_UNSUPPORTED/],
      ["归一化坐标", json => { json.accessors[json.meshes[0].primitives[0].attributes.POSITION].normalized = true }, /GEOMETRY_POSITION_UNSUPPORTED/],
      ["非三角面图元", json => { json.meshes[0].primitives[0].mode = 0 }, /GEOMETRY_PRIMITIVE_MODE_UNSUPPORTED/],
      ["空 primitive 列表", json => { json.meshes[0].primitives = [] }, /GEOMETRY_MESH_MISSING/],
      ["节点循环", json => { json.nodes[0].children = [0] }, /GEOMETRY_NODE_CYCLE_OR_MULTI_PARENT/],
    ]
    const unmatched: string[] = []
    for (const row of cases) {
      const [label, edit, pattern] = row
      try {
        factsOf(patchGlb(plain, edit))
        unmatched.push(`${label}: 没有报错（放行了）`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!pattern.test(message)) unmatched.push(`${label}: ${message}`)
      }
    }
    expect(unmatched).toEqual([])
    // 不影响几何的扩展（材质/纹理/灯光）不拦：Blender 导出的常规形态要能继续核对。
    expect(compareGlbGeometry(factsOf(plain), factsOf(patchGlb(plain, json => { json.extensionsUsed = ["KHR_materials_emissive_strength", "KHR_texture_transform"] }))).identical).toBe(true)
    // 只驱动非显示节点的动画也不拦（画面里的几何没有被动画改）。
    expect(compareGlbGeometry(factsOf(plain), factsOf(patchGlb(plain, json => {
      json.nodes.push({ name: "隐藏件" })
      json.animations = [{ channels: [{ sampler: 0, target: { node: 1, path: "translation" } }], samplers: [] }]
    }))).identical).toBe(true)
  })
})
