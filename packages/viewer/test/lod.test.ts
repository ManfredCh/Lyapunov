/**
 * LOD 判定层的定向测试：只覆盖 `lod.ts` 里那些"从已有 resources/visual 解析出级别、再按距离选级别"的纯函数。
 *
 * 这里证明的是**判据**（哪个级别合法、阈值怎么选、滞回什么时候不许切），不证明画面里真的换了对象——
 * 真实交换是 `index.ts` 里 render 循环 × 真实 GLTF 资产的行为，由 headless Chrome 的实际 Viewer 验收覆盖。
 */
import { describe, expect, test } from "bun:test"
import { Matrix4, Object3D, Quaternion, Vector3 } from "three"
import type { Entity, ResourceRef } from "../../lyapunov-contracts/src/types.ts"
import { chooseDerivedNode, derivedNodeMatrix, fileNodeChain, LOD_BASE, LOD_HYSTERESIS, primaryResource, rawLodLevel, resolveLodPlan, selectLodLevel, type LodPlan } from "../src/lod.ts"

function ref(mimeType: string, role: string | undefined, uri = "/r/a.glb"): ResourceRef {
  return {
    resourceId: "res-a", version: 1,
    original: { uri: "/r/source.blend", mimeType: "application/x-blender" },
    representations: [{ uri, mimeType, ...(role ? { role } : {}) }],
    source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 },
  }
}
function entityWith(resources: ResourceRef[], visual: Record<string, unknown>): Entity {
  return { entityId: "e1", name: "石狮", transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources, components: { visual } }
}
/** 一个资源版本上同时带基础表示与两个派生表示（派生物是同一 resourceId/version 的额外 representation）。 */
function ladder(): Entity {
  const base = ref("model/gltf-binary", "visual", "/r/lion.glb")
  base.representations.push({ uri: "/r/lion_lod2.glb", mimeType: "model/gltf-binary", role: "visual-lod-2" })
  base.representations.push({ uri: "/r/lion_lod1.glb", mimeType: "model/gltf-binary", role: "visual-lod-1" })
  return entityWith([base], { kind: "mesh", lod: [{ role: "visual-lod-2", minDistanceM: 60 }, { role: "visual-lod-1", minDistanceM: 20 }] })
}

describe("resolveLodPlan：级别必须指向实体里已有的合法资源版本", () => {
  test("没有 lod / 空数组 / 不是数组：按没有 LOD 处理", () => {
    expect(resolveLodPlan(entityWith([ref("model/gltf-binary", "visual")], { kind: "mesh" }))).toBeUndefined()
    expect(resolveLodPlan(entityWith([ref("model/gltf-binary", "visual")], { kind: "mesh", lod: [] }))).toBeUndefined()
    expect(resolveLodPlan(entityWith([ref("model/gltf-binary", "visual")], { kind: "mesh", lod: "far" }))).toBeUndefined()
  })

  test("按距离升序解析出派生表示，并带上它所属的资源版本", () => {
    const plan = resolveLodPlan(ladder())!
    expect(plan.problems).toEqual([])
    expect(plan.levels.map(level => [level.role, level.minDistanceM])).toEqual([["visual-lod-1", 20], ["visual-lod-2", 60]])
    expect(plan.levels[0]!.ref.resourceId).toBe("res-a")
    expect(plan.levels[0]!.ref.version).toBe(1)
    expect(plan.levels[0]!.representation.uri).toBe("/r/lion_lod1.glb")
  })

  test("非法条目如实报 problem 并跳过，不猜路径、不拿别的表示顶替", () => {
    const base = ref("model/gltf-binary", "visual")
    base.representations.push({ uri: "/r/lion_lod1.glb", mimeType: "model/gltf-binary", role: "visual-lod-1" })
    base.representations.push({ uri: "/r/lion_collision.obj", mimeType: "model/obj", role: "collision" })
    const entity = entityWith([base], { kind: "mesh", lod: [
      { role: "visual-lod-1", minDistanceM: 20 },
      { minDistanceM: 30 },                                  // 缺 role
      { role: "visual-lod-9", minDistanceM: 40 },            // 表示不存在
      { role: "visual", minDistanceM: 50 },                  // 指回基础表示
      { role: "collision", minDistanceM: 60 },               // 表示存在但不是 GLB
      { role: "visual-lod-1", minDistanceM: -1 },            // 距离非法
      { role: "visual-lod-1", minDistanceM: 80, resourceId: "res-nope", version: 3 },
    ] })
    const plan = resolveLodPlan(entity)!
    expect(plan.levels.map(level => level.role)).toEqual(["visual-lod-1"])
    expect(plan.problems.map(text => text.split(":")[0])).toEqual([
      "LOD_LEVEL_INVALID", "LOD_REPRESENTATION_NOT_FOUND", "LOD_LEVEL_NOT_DERIVED", "LOD_REPRESENTATION_UNSUPPORTED", "LOD_LEVEL_INVALID", "LOD_RESOURCE_NOT_FOUND",
    ])
  })

  test("可以指到本实体的另一个资源版本（仍必须在 entity.resources 里）", () => {
    const base = ref("model/gltf-binary", "visual")
    const other: ResourceRef = { ...ref("model/gltf-binary", "visual-lod-1", "/r/lion_lod1.glb"), resourceId: "res-b", version: 4 }
    const entity = entityWith([base, other], { kind: "mesh", lod: [{ role: "visual-lod-1", minDistanceM: 25, resourceId: "res-b", version: 4 }] })
    const plan = resolveLodPlan(entity)!
    expect(plan.problems).toEqual([])
    expect([plan.levels[0]!.ref.resourceId, plan.levels[0]!.ref.version]).toEqual(["res-b", 4])
  })

  test("正常产品路径：scene_import 登记进来的 LOD 资源角色就是 visual，必须能当派生级别", () => {
    // ResourceLibrary 对网格资源只写 role:"visual"（resources.ts 的 import）。只认 visual-lod-N 的话，
    // 只有手写未登记的表示可测，正常登记的资源永远用不上——那才是这次要修的产品路径。
    const base = ref("model/gltf-binary", "visual")
    const derived: ResourceRef = { ...ref("model/gltf-binary", "visual", "/r/plant_lod1.glb"), resourceId: "plant_lod1", version: 1 }
    const entity = entityWith([base, derived], { kind: "mesh", gltfNode: 3, sourceTransformApplied: true, lod: [{ role: "visual", minDistanceM: 40, resourceId: "plant_lod1" }] })
    const plan = resolveLodPlan(entity)!
    expect(plan.problems).toEqual([])
    expect(plan.levels[0]!.ref.resourceId).toBe("plant_lod1")
    expect(plan.levels[0]!.representation.uri).toBe("/r/plant_lod1.glb")
  })

  test("同一个 resourceId 的另一个版本/另一个文件可以当级别；版本号写错找不到就是找不到", () => {
    const base = ref("model/gltf-binary", "visual")
    const v2: ResourceRef = { ...ref("model/gltf-binary", "visual", "/r/plant_v2.glb"), version: 2 }
    const found = resolveLodPlan(entityWith([base, v2], { kind: "mesh", lod: [{ role: "visual", minDistanceM: 30, resourceId: "res-a", version: 2 }] }))!
    expect(found.problems).toEqual([])
    expect(found.levels[0]!.ref.version).toBe(2)
    const missing = resolveLodPlan(entityWith([base, v2], { kind: "mesh", lod: [{ role: "visual", minDistanceM: 30, resourceId: "res-a", version: 9 }] }))!
    expect(missing.levels).toEqual([])
    expect(missing.problems[0]!.startsWith("LOD_RESOURCE_NOT_FOUND")).toBe(true)
  })

  test("源坐标已烘焙在父链上时，派生资源的 source 声明必须与基础一致（否则画面会歪）", () => {
    const base = ref("model/gltf-binary", "visual")
    const same = { ...ref("model/gltf-binary", "visual", "/r/lod_ok.glb"), resourceId: "lod-ok" }
    const different = { ...ref("model/gltf-binary", "visual", "/r/lod_zup.glb"), resourceId: "lod-zup", source: { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 } }
    const baked = resolveLodPlan(entityWith([base, same], { kind: "mesh", gltfNode: 1, sourceTransformApplied: true, lod: [{ role: "visual", minDistanceM: 20, resourceId: "lod-ok" }] }))!
    expect(baked.problems).toEqual([])
    const mismatch = resolveLodPlan(entityWith([base, different], { kind: "mesh", gltfNode: 1, sourceTransformApplied: true, lod: [{ role: "visual", minDistanceM: 20, resourceId: "lod-zup" }] }))!
    expect(mismatch.levels).toEqual([])
    expect(mismatch.problems[0]!.startsWith("LOD_LEVEL_SOURCE_MISMATCH")).toBe(true)
    // 未烘焙（sourceTransformApplied 不是 true）的实体每个级别各自按自己的 source 适配，不存在这个问题。
    const unbaked = resolveLodPlan(entityWith([base, different], { kind: "mesh", lod: [{ role: "visual", minDistanceM: 20, resourceId: "lod-zup" }] }))!
    expect(unbaked.problems).toEqual([])
  })

  test("级别条目可以带派生文件内的节点地址；类型不对就如实报，不猜", () => {
    const base = ref("model/gltf-binary", "visual")
    const derived = { ...ref("model/gltf-binary", "visual", "/r/plant_lod1.glb"), resourceId: "plant_lod1" }
    const plan = resolveLodPlan(entityWith([base, derived], { kind: "mesh", lod: [
      { role: "visual", minDistanceM: 40, resourceId: "plant_lod1", gltfNodeName: "potted_plant_01_pebbles.001" },
      { role: "visual", minDistanceM: 80, resourceId: "plant_lod1", gltfNode: 0 },
      { role: "visual", minDistanceM: 90, resourceId: "plant_lod1", gltfNode: -2 },
      { role: "visual", minDistanceM: 95, resourceId: "plant_lod1", gltfNodeName: "" },
    ] }))!
    expect(plan.levels.map(level => level.node)).toEqual([{ name: "potted_plant_01_pebbles.001" }, { index: 0 }])
    expect(plan.problems.map(text => text.split(":")[0])).toEqual(["LOD_LEVEL_NODE_INVALID", "LOD_LEVEL_NODE_INVALID"])
  })

  test("级别全非法时仍然给出问题清单（上层据此记缺件警告，而不是悄悄当没有）", () => {
    const plan = resolveLodPlan(entityWith([ref("model/gltf-binary", "visual")], { kind: "mesh", lod: [{ role: "visual-lod-1", minDistanceM: 5 }] }))!
    expect(plan.levels).toEqual([])
    expect(plan.problems.length).toBe(1)
  })

  test("基础资源的选择判据只有一份：带 visual 表示的那个 ref", () => {
    const first = { ...ref("application/x-blender", undefined), representations: [{ uri: "/r/source.blend", mimeType: "application/x-blender" }] }
    expect(primaryResource(entityWith([first, ref("model/gltf-binary", "visual")], { kind: "mesh" }))!.resourceId).toBe("res-a")
  })
})

describe("selectLodLevel：按距离选级别，带滞回", () => {
  const plan: LodPlan = {
    problems: [],
    levels: [
      { role: "visual-lod-1", minDistanceM: 20, ref: ref("model/gltf-binary", "visual-lod-1"), representation: { uri: "/r/l1.glb", mimeType: "model/gltf-binary", role: "visual-lod-1" } },
      { role: "visual-lod-2", minDistanceM: 60, ref: ref("model/gltf-binary", "visual-lod-2"), representation: { uri: "/r/l2.glb", mimeType: "model/gltf-binary", role: "visual-lod-2" } },
    ],
  }

  test("近处用基础级别，越过阈值换粗级别，超远用最粗", () => {
    expect(selectLodLevel(plan, 5, LOD_BASE)).toBe(LOD_BASE)
    expect(selectLodLevel(plan, 20, LOD_BASE)).toBe(0)
    expect(selectLodLevel(plan, 59, 0)).toBe(0)
    expect(selectLodLevel(plan, 60, 0)).toBe(1)
    expect(selectLodLevel(plan, 500, 0)).toBe(1)
  })

  test("变细要越过滞回线，一次只回一级：阈值附近不会来回闪", () => {
    // 60 m 的边界：刚回到 59 m 不许从 2 级（下标 1）退回 1 级（下标 0）
    expect(selectLodLevel(plan, 59, 1)).toBe(1)
    expect(selectLodLevel(plan, 60 * LOD_HYSTERESIS + 0.01, 1)).toBe(1)
    expect(selectLodLevel(plan, 60 * LOD_HYSTERESIS, 1)).toBe(0)
    // 一次只回一级：即使距离已经很近，也从下标 1 先回到 0，而不是直接跳回基础级别
    expect(selectLodLevel(plan, 3, 1)).toBe(0)
    // 20 m 的边界同理，回到 18 m 才回基础级别
    expect(selectLodLevel(plan, 19, 0)).toBe(0)
    expect(selectLodLevel(plan, 18, 0)).toBe(LOD_BASE)
  })

  test("变粗不受滞回限制：远处直接跳到目标级别", () => {
    expect(selectLodLevel(plan, 1000, LOD_BASE)).toBe(1)
  })

  test("rawLodLevel 是不带滞回的直选：一次性采集相机用它，一次到位", () => {
    // 同样的"从最粗级别回到 3m"，带滞回要两级才落到底，直选一次就是基础级别。
    expect(selectLodLevel(plan, 3, 1)).toBe(0)
    expect(rawLodLevel(plan, 3)).toBe(LOD_BASE)
    expect(rawLodLevel(plan, 20)).toBe(0)
    expect(rawLodLevel(plan, 60)).toBe(1)
    expect(selectLodLevel(plan, 60, 0)).toBe(rawLodLevel(plan, 60))
  })
})

describe("chooseDerivedNode：派生文件是另一个命名空间，节点号不能套用", () => {
  const file = (...nodes: Array<[number, string, boolean]>) => nodes.map(([index, name, hasMesh]) => ({ index, name, hasMesh }))
  /** 多节点基础件里的一个节点（pot=0、pebbles=1），派生件只导出了 pebbles 那一个对象（单节点 node0）。 */
  const single = file([0, "potted_plant_01_pebbles.001", true])

  test("显式索引优先；文件里没有这个号就明确报，而不是套用基础文件的号", () => {
    expect(chooseDerivedNode(single, { index: 0 })).toEqual({ index: 0 })
    expect(chooseDerivedNode(single, { index: 3 })).toEqual({ problem: "LOD_LEVEL_NODE_NOT_FOUND: gltfNode=3" })
  })

  test("显式节点名：唯一匹配才用；匹配不到/多个同名都如实报", () => {
    expect(chooseDerivedNode(single, { name: "potted_plant_01_pebbles.001" })).toEqual({ index: 0 })
    expect(chooseDerivedNode(single, { name: "没有这个节点" })).toEqual({ problem: 'LOD_LEVEL_NODE_NOT_FOUND: gltfNodeName="没有这个节点"' })
    const twins = file([0, "盆", true], [1, "盆", true], [2, "底座", true])
    expect(chooseDerivedNode(twins, { name: "盆" })).toEqual({ problem: 'LOD_LEVEL_NODE_AMBIGUOUS: gltfNodeName="盆" 匹配到 2 个节点' })
  })

  test("没给地址时按基础节点名匹配（派生件的对象名通常沿用），唯一才用", () => {
    expect(chooseDerivedNode(single, undefined, "potted_plant_01_pebbles.001")).toEqual({ index: 0 })
    // 名字换了但派生件里只有一个网格节点：用它（没有别的候选，不算猜）
    expect(chooseDerivedNode(single, undefined, "改过名的实体")).toEqual({ index: 0 })
  })

  test("多个网格节点又没给地址：拒绝，并列出候选，不随手取一个", () => {
    const two = file([0, "盆", true], [1, "石台", true])
    const decision = chooseDerivedNode(two, undefined, "改过名的实体")
    expect("problem" in decision && decision.problem).toContain("LOD_LEVEL_NODE_AMBIGUOUS")
    expect("problem" in decision && decision.problem).toContain("0:盆, 1:石台")
    // 一个网格节点都没有的文件同样报歧义（带"没有带网格的节点"），不会被当成"随便一个空节点"
    const empty = file([0, "空组", false])
    expect("problem" in chooseDerivedNode(empty, undefined)).toBe(true)
  })
})

describe("fileNodeChain：派生相对变换要减的是「文件内部完整链」，Scene 外部父变换绝不来", () => {
  const close = (left: Matrix4, right: Matrix4): boolean => left.elements.every((value, index) => Math.abs(value - right.elements[index]!) < 1e-9)
  /** 一个 glTF 文件里的节点：局部矩阵就是文件里写的那串 TRS。 */
  function fileNode(name: string, transform: { position?: [number, number, number]; quaternion?: Quaternion; scale?: [number, number, number] } = {}): Object3D {
    const item = new Object3D()
    item.name = name
    item.position.set(...(transform.position ?? [0, 0, 0]))
    item.quaternion.copy(transform.quaternion ?? new Quaternion())
    item.scale.set(...(transform.scale ?? [1, 1, 1]))
    item.updateMatrix()
    return item
  }
  /** GLTFLoader 给文件套的外壳（`gltf.scene`）：`associations` 里查不到号 ⇒ 不是文件内部的节点。 */
  function gltfScene(...nodes: Object3D[]): Object3D {
    const shell = new Object3D()
    shell.name = "gltf.scene"
    for (const item of nodes) shell.add(item)
    return shell
  }
  const yaw = (degrees: number): Quaternion => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (Math.PI * degrees) / 180)

  test("链是「文件根 × … × 自己」，停在文件边界上：非 identity 父节点必须进来，外壳不进", () => {
    const rig = fileNode("rig", { position: [0.3, 0.15, 0.2], quaternion: yaw(35), scale: [1.3, 1, 0.7] })
    const child = fileNode("pot_child", { position: [0.05, 0.1, 0], scale: [1, 0.9, 1] })
    const shell = gltfScene(rig)
    rig.add(child)
    const isFileNode = (object: Object3D): boolean => object === rig || object === child
    const chain = fileNodeChain(child, isFileNode)
    expect(close(chain, new Matrix4().copy(rig.matrix).multiply(child.matrix))).toBe(true)
    // 父变换真进来了：完整链与"子节点局部矩阵"（改动前存的那份）不是一回事
    expect(close(chain, child.matrix)).toBe(false)
    // 外壳（Scene 侧包在文件外面的那层）怎么动都不进链
    shell.position.set(5, -5, 5); shell.quaternion.copy(yaw(90)); shell.scale.set(3, 3, 3); shell.updateMatrix()
    expect(close(fileNodeChain(child, isFileNode), new Matrix4().copy(rig.matrix).multiply(child.matrix))).toBe(true)
    // 外壳自己不是文件节点 ⇒ 取链是单位阵（整文件级别沿用旧行为，不受这次改动影响）
    expect(close(fileNodeChain(shell, isFileNode), new Matrix4())).toBe(true)
  })

  test("Scene 侧的底座（旋转 + 非均匀缩放）不进链：同一份文件挂两个位姿下，链逐位相同而世界矩阵不同", () => {
    const isFileNode = (object: Object3D): boolean => object.name.startsWith("f:")
    const build = (): Object3D => {
      const rig = fileNode("f:rig", { position: [0.3, 0.15, 0.2], quaternion: yaw(35), scale: [1.3, 1, 0.7] })
      const child = fileNode("f:pot_child", { position: [0.05, 0.1, 0], scale: [1, 0.9, 1] })
      rig.add(child)
      return gltfScene(rig)
    }
    const plain = build()
    const pedestal = new Object3D() // Scene 侧父实体：不在任何文件里
    pedestal.name = "pedestal"
    pedestal.position.set(2.2, 0, -0.6)
    pedestal.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6)
    pedestal.scale.set(1.4, 0.8, 1.1)
    const placed = build()
    pedestal.add(placed)
    plain.updateWorldMatrix(true, true)
    pedestal.updateWorldMatrix(true, true)
    const plainLeaf = plain.children[0]!.children[0]!
    const placedLeaf = placed.children[0]!.children[0]!
    // 相对矩阵与外部父变换无关：这正是"同一份派生件换个摆放位置，相对矩阵跟着变"要防的那个 bug
    expect(close(fileNodeChain(plainLeaf, isFileNode), fileNodeChain(placedLeaf, isFileNode))).toBe(true)
    // 而外部父变换确实作用在世界上（不是"没有父节点可加"）：世界矩阵必须不同
    expect(close(plainLeaf.matrixWorld, placedLeaf.matrixWorld)).toBe(false)
  })

  test("三种派生导出方式由同一行矩阵覆盖：显示世界矩阵都等于「Q × 派生文件自己的完整链」", () => {
    // Q = 场景侧位姿 × 源坐标变换。**两个级别共用同一个 Q**（同一实体、同一 resources.source 声明）。
    const q = new Matrix4().compose(new Vector3(0.15, -0.25, 0.6), new Quaternion(), new Vector3(1, 1, 1))
    const baseRig = fileNode("rig", { position: [0.3, 0.15, 0.2], quaternion: yaw(35), scale: [1.3, 1, 0.7] })
    const baseChild = fileNode("pot_child", { position: [0.05, 0.1, 0], scale: [1, 0.9, 1] })
    baseRig.add(baseChild)
    const baseChain = fileNodeChain(baseChild, (object: Object3D): boolean => object === baseRig || object === baseChild)
    // ① 父链逐字保留（网格简化）：派生链 = 基础链  ② 父变换烘进顶点：单节点、局部矩阵 = 单位阵  ③ 另一层父节点
    const keptRig = fileNode("rig", { position: [0.3, 0.15, 0.2], quaternion: yaw(35), scale: [1.3, 1, 0.7] })
    const keptChild = fileNode("pot_child", { position: [0.05, 0.1, 0], scale: [1, 0.9, 1] })
    keptRig.add(keptChild)
    const bakedNode = fileNode("pot_baked")
    const otherRig = fileNode("rig", { position: [-0.4, 0.25, -0.55], quaternion: yaw(-25) })
    const otherChild = fileNode("pot_child", { position: [0.05, 0.1, 0], scale: [1, 0.9, 1] })
    otherRig.add(otherChild)
    const chainOf = (leaf: Object3D, ...ancestors: Object3D[]): Matrix4 =>
      fileNodeChain(leaf, (object: Object3D): boolean => object === leaf || ancestors.includes(object))
    const cases: Array<[string, Matrix4]> = [
      ["父链逐字保留", chainOf(keptChild, keptRig)],
      ["父变换烘进顶点", chainOf(bakedNode)],
      ["另一层父节点", chainOf(otherChild, otherRig)],
    ]
    // 派生级别的显示世界矩阵 = 实体父链（Q × 基础链）× 相对矩阵
    const display = (chain: Matrix4): Matrix4 => new Matrix4().copy(q).multiply(baseChain).multiply(derivedNodeMatrix(baseChain, chain))
    // 参照物：把同一份派生件按基础级别那条路挂出来（Q × 该文件自己的链）——两者必须逐位一致
    for (const [note, chain] of cases) expect([note, close(display(chain), new Matrix4().copy(q).multiply(chain))]).toEqual([note, true])
    // 改动前（拿**节点局部矩阵**比）在两种导出方式上都会离线，只有"父链逐字保留"那一类恰好还对
    const before = (local: Matrix4): Matrix4 => new Matrix4().copy(q).multiply(baseChain).multiply(derivedNodeMatrix(baseChild.matrix, local))
    expect(close(before(bakedNode.matrix), display(cases[1]![1]))).toBe(false) // 父变换被重复施加
    expect(close(before(otherChild.matrix), display(cases[2]![1]))).toBe(false) // 派生父变换整条丢掉
    expect(close(before(keptChild.matrix), display(cases[0]![1]))).toBe(true) // 这一类老行为恰好也对
  })

  test("整文件只挂根节点时（76 的夹具形状）完整链 = 节点局部矩阵：这次改动对它们没有行为变化", () => {
    const pot = fileNode("pot", { position: [0.4, 0, 0.2] })
    const pebbles = fileNode("pebbles", { position: [-0.1, 0, 0], scale: [2, 2, 2] })
    gltfScene(pot, pebbles)
    const isFileNode = (object: Object3D): boolean => object.name === "pot" || object.name === "pebbles"
    expect(close(fileNodeChain(pot, isFileNode), pot.matrix)).toBe(true)
    expect(close(fileNodeChain(pebbles, isFileNode), pebbles.matrix)).toBe(true)
  })
})

describe("derivedNodeMatrix：派生节点按基础节点换算，两种导出方式都落在同一处", () => {
  const matrix = (position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) =>
    new Matrix4().compose(new Vector3(...position), new Quaternion(), new Vector3(...scale))
  const close = (value: number, expected: number) => Math.abs(value - expected) < 1e-9

  test("派生件保留对象变换（节点变换与基础相同）→ 相对矩阵是单位阵", () => {
    const base = matrix([0.4, 0, 0.2], [2, 2, 2])
    const relative = derivedNodeMatrix(base, base.clone())
    for (const [index, value] of relative.elements.entries()) if (index % 5 === 0) expect(close(value, 1)).toBe(true)
    else expect(close(value, 0)).toBe(true)
  })

  test("派生件把对象变换烘进了网格（节点变换是单位阵）→ 抵消实体上那份，世界位置不变", () => {
    const base = matrix([0.4, 0, 0.2], [2, 2, 2])
    const relative = derivedNodeMatrix(base, new Matrix4())
    // 顶点 v 在派生文件里已经是 base·v：world = base · relative · (base·v) 必须等于 base·v
    const vertex = new Vector3(1, 0.5, -0.25)
    const baked = vertex.clone().applyMatrix4(base)
    const placed = baked.clone().applyMatrix4(relative).applyMatrix4(base)
    for (const [index, value] of baked.toArray().entries()) expect(close(placed.getComponent(index), value)).toBe(true)
  })
})
