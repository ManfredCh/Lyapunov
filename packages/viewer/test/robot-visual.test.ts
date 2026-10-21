/**
 * `buildRobotVisual` 消费 MJCF 文档的真实行为（DEV-030）。
 *
 * 这里证明的是**画面里真的建出了几何**：重复的 `<asset>`／`<worldbody>`（解析器给出的是数组）不再被
 * 整段跳过，每个 geom 都对应一个 `THREE.Mesh`，网格 geom 真的去取了网格字节；反过来，一份没有任何
 * geom/link 的文档不会静默报"显示就绪"，而是留下 `ROBOT_VISUAL_EMPTY` 警告（走 Viewer 的
 * `visualWarnings`，与缺件同一条通道）。解析层的判据由
 * `packages/scene-kit/test/formats-mjcf-sections.test.ts` 证明。
 *
 * 两处测试环境说明：
 *  · 网格字节用 284 字节的真实二进制 STL（四面体，与 scene-kit 重复段夹具 `meshes/a.stl` 同一批），
 *    经 `resolveURI` 以 data URL 交给 three。形状无意义，要证明的是"每个引用都真的加载成了网格"。
 *  · Bun 没有 `ProgressEvent`，three 的 FileLoader 在流式读取时会 `new` 它；下面补一个等价垫片。
 *    它只充当进度事件对象，不参与几何解析。
 *
 * 运行：`bun test packages/viewer/test/robot-visual.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as THREE from "three"

import { robotVisual } from "../../scene-kit/src/formats.ts"
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"
import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"
import { identityTransform, SCENE_COORDINATES, type EntityObservation, type Frame, type WorldHandle } from "../../lyapunov-contracts/src/types.ts"

class ProgressEventShim extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}
;(globalThis as any).ProgressEvent ??= ProgressEventShim

const FIXTURES = join(import.meta.dir, "..", "..", "scene-kit", "test", "fixtures")
const triangle = readFileSync(join(FIXTURES, "mjcf-duplicate-sections", "meshes", "a.stl"))
/** 任何网格引用都交出同一份真实 STL 字节；同时记下被请求的 URI，供"路径语义"断言。 */
const serveTriangle = (requested: string[]) => (uri: string): string => { requested.push(uri); return `data:model/stl;base64,${triangle.toString("base64")}` }

const values = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const countMeshes = (visual: RobotVisual): number => { let meshes = 0; visual.root.traverse(object => { if (object instanceof THREE.Mesh) meshes++ }); return meshes }
const nodeNames = (visual: RobotVisual): Set<string> => { const names = new Set<string>(); visual.root.traverse(object => { if (object.name) names.add(object.name) }); return names }
/** 网格请求过的文件的路径（相对夹具目录）。 */
const requestedFiles = (requested: string[], dir: string): string[] => requested.map(uri => { const text = decodeURIComponent(uri); return text.slice(text.indexOf(`${dir}/`) + dir.length + 1) }).sort()
/** 每个网格对象的顶点数：用来分辨"取到的是哪一份文件"（夹具用顶点数不同的几何）。 */
const meshVertexCounts = (visual: RobotVisual): number[] => {
  const counts: number[] = []
  visual.root.traverse(object => { if (object instanceof THREE.Mesh) counts.push((object.geometry as THREE.BufferGeometry).attributes.position!.count) })
  return counts
}
/** 整棵子树的世界位姿指纹：用来判断"驱动这个关节到底有没有动到画面"。 */
const poseSignature = (visual: RobotVisual): string => { visual.root.updateMatrixWorld(true); const values: number[] = []; visual.root.traverse(object => values.push(...object.matrixWorld.elements)); return values.join(",") }

describe("重复的顶层段（解析器给出的数组形状）", () => {
  // 与 fast-xml-parser 对重复标签的实际输出一致：`asset`／`worldbody` 是数组，内部元素仍是单个对象。
  const duplicated = {
    format: "mjcf", baseUri: "file:///robot/",
    document: {
      compiler: { angle: "radian", meshdir: "meshes" },
      asset: [
        { mesh: { name: "link", file: "a.stl" } },
        { mesh: { name: "tool", file: "b.stl" }, material: { name: "skin", rgba: "0.8 0.2 0.2 1" } },
      ],
      worldbody: [
        { body: { name: "base", geom: { type: "mesh", mesh: "link" } } },
        { body: { name: "grip", geom: { type: "mesh", mesh: "tool" } }, geom: { name: "floor", type: "plane", size: "0 0 0.05" } },
      ],
    },
  }
  /** 同一份内容的"已归一化"写法：两种形状必须得到同样的画面。 */
  const normalized = {
    format: "mjcf", baseUri: "file:///robot/",
    document: {
      compiler: { angle: "radian", meshdir: "meshes" },
      asset: { mesh: [{ name: "link", file: "a.stl" }, { name: "tool", file: "b.stl" }], material: { name: "skin", rgba: "0.8 0.2 0.2 1" } },
      worldbody: { body: [{ name: "base", geom: { type: "mesh", mesh: "link" } }, { name: "grip", geom: { type: "mesh", mesh: "tool" } }], geom: { name: "floor", type: "plane", size: "0 0 0.05" } },
    },
  }

  test("两个 asset 段与两个 worldbody 段的内容都画出来，全部网格引用都取了网格字节", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(duplicated as any, serveTriangle(requested))
    expect(countMeshes(visual)).toBe(3)                        // 两个网格 geom + 一个平面 geom
    expect(requested.map(uri => uri.split("/").pop()).sort()).toEqual(["a.stl", "b.stl"])   // meshdir 前缀生效，文件名原样
    expect([...nodeNames(visual)]).toEqual(expect.arrayContaining(["base", "grip", "floor"]))
    expect(visual.warnings).toEqual([])
  })

  test("重复段数组与已归一化的写法画出来完全一致", async () => {
    const [fromArray, fromObject] = await Promise.all([
      buildRobotVisual(duplicated as any, serveTriangle([])),
      buildRobotVisual(normalized as any, serveTriangle([])),
    ])
    expect(countMeshes(fromArray)).toBe(countMeshes(fromObject))
    expect([...nodeNames(fromArray)].sort()).toEqual([...nodeNames(fromObject)].sort())
    expect(fromArray.warnings).toEqual(fromObject.warnings)
  })
})

describe("真实夹具：场景文档 include 机器人文档（机器人自带 meshdir）", () => {
  test("两侧的网格都画出来，取网格的路径都落在生效 meshdir 下", async () => {
    const scene = join(FIXTURES, "mjcf-duplicate-sections", "scene.xml")
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(scene) as any, (uri: string) => {
      requested.push(uri)
      // 真实字节：路径解析错了这里会直接 ENOENT。
      return `data:model/stl;base64,${readFileSync(fileURLToPath(uri)).toString("base64")}`
    })
    expect(countMeshes(visual)).toBe(4)                                     // 3 个网格 geom + 场景的平面 geom（MuJoCo ngeom=4）
    expect(requested.map(uri => decodeURIComponent(uri).split("/").slice(-2).join("/")).sort()).toEqual(["meshes/a.stl", "meshes/b.stl", "meshes/c.stl"])
    expect([...nodeNames(visual)]).toEqual(expect.arrayContaining(["table", "arm_base", "tool", "floor"]))
    expect(visual.warnings).toEqual([])
  })

  test("跨目录 include：子文档的网格按 MuJoCo 的查找顺序取到，错候选位置的几何不会被读到", async () => {
    // 子文档在 `kid/`，子网格只在 `meshes/kid/arm.stl`（后备位置）；`kid/arm.stl` 与
    // `kid/meshes/arm.stl` 是顶点数不同的立方体，MuJoCo 不读它们，解析错会直接换一份几何。
    const scene = join(FIXTURES, "mjcf-include-subdir", "scene.xml")
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(scene) as any, (uri: string) => {
      requested.push(uri)
      return `data:model/stl;base64,${readFileSync(fileURLToPath(uri)).toString("base64")}`
    })
    expect(countMeshes(visual)).toBe(3)                       // 两个网格 geom + 场景的平面 geom
    expect(requestedFiles(requested, join(FIXTURES, "mjcf-include-subdir"))).toEqual(["meshes/kid/arm.stl", "meshes/table.stl"])
    expect([...nodeNames(visual)]).toEqual(expect.arrayContaining(["arm", "table", "floor"]))
    // 四面体 4 个三角面 = 12 个位置；立方体是 36 个。平面几何 4 个位置。
    expect(meshVertexCounts(visual).sort((a, b) => a - b)).toEqual([4, 12, 12])
    expect(visual.warnings).toEqual([])
  })

  test("跨目录 include：主文档目录下也有同名网格时读主文档目录那份（MuJoCo 实测的优先序）", async () => {
    const scene = join(FIXTURES, "mjcf-include-subdir-primary", "scene.xml")
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(scene) as any, (uri: string) => {
      requested.push(uri)
      return `data:model/stl;base64,${readFileSync(fileURLToPath(uri)).toString("base64")}`
    })
    expect(requestedFiles(requested, join(FIXTURES, "mjcf-include-subdir-primary"))).toEqual(["meshes/arm.stl", "meshes/table.stl"])
    // 子网格读的是主文档目录下的立方体（36 个位置），不是后备位置的四面体（12 个）。
    expect(meshVertexCounts(visual).sort((a, b) => a - b)).toEqual([4, 12, 36])
    expect(visual.warnings).toEqual([])
  })

  test("带 XML 声明、仅 asset 片段（包裹根 mujocoinclude）的网格也按生效 meshdir 画出来", async () => {
    const scene = join(FIXTURES, "mjcf-include-fragments", "scene.xml")
    const requested: string[] = []
    const visual = await buildRobotVisual(await robotVisual(scene) as any, (uri: string) => {
      requested.push(uri)
      return `data:model/stl;base64,${readFileSync(fileURLToPath(uri)).toString("base64")}`
    })
    // 片段的 `file="a.stl"` 与本文件的 `file="c.stl"` 都只在 `meshes/` 下（父 compiler 的 meshdir）。
    expect(countMeshes(visual)).toBe(3)                                     // 两个网格 geom + 一个平面 geom
    expect(requested.map(uri => decodeURIComponent(uri).split("/").slice(-2).join("/")).sort()).toEqual(["meshes/a.stl", "meshes/c.stl"])
    expect([...nodeNames(visual)]).toEqual(expect.arrayContaining(["arm", "table", "floor"]))
    expect(visual.warnings).toEqual([])
  })
})

describe("真实原件：Unitree G1 29DOF 带手", () => {  test("视觉网格数与 MuJoCo 的 ngeom 一致，网格 geom 一个不少，关节真的能驱动画面", async () => {
    const robot = await robotVisual(join(FIXTURES, "mjcf-g1", "g1_29dof_with_hand.xml"))
    const doc = robot.document as any
    const requested: string[] = []
    const visual = await buildRobotVisual(robot as any, serveTriangle(requested))
    // MuJoCo 3.12.0 对同一文件编译出 ngeom=104（其中 89 个是网格 geom，其余是基元）。
    // 每个 geom 一个 THREE.Mesh：0 mesh 的旧行为这里会直接掉到 0。
    expect(countMeshes(visual)).toBe(104)
    const meshFiles = new Set(values(doc.asset?.mesh).map((mesh: any) => mesh.file))
    expect(meshFiles.size).toBe(50)                            // MuJoCo nmesh=50
    expect(requested.length).toBe(89)
    expect(requested.every(uri => meshFiles.has(decodeURIComponent(uri.split("/").pop()!)))).toBe(true)
    // 层级：44 个 body 的名字都出现在画面里（MuJoCo nbody=45，含 world）。
    const named = nodeNames(visual)
    let bodies = 0
    const countBodies = (item: any): void => { bodies++; expect(named.has(item.name)).toBe(true); for (const child of values(item.body)) countBodies(child) }
    for (const item of values(doc.worldbody?.body)) countBodies(item)
    expect(bodies).toBe(44)
    // 关节：驱动一个真实关节必须改变画面位姿；不存在的名字不能改变任何东西。
    const before = poseSignature(visual)
    visual.setJoints(["left_elbow_joint"], [0.5])
    expect(poseSignature(visual)).not.toBe(before)
    visual.setJoints(["left_elbow_joint"], [0])
    expect(poseSignature(visual)).toBe(before)
    visual.setJoints(["no_such_joint"], [0.5])
    expect(poseSignature(visual)).toBe(before)
    expect(visual.warnings).toEqual([])
  })
})

describe("没有内容不能静默报就绪", () => {
  test("没有任何 geom/body 的文档留下 ROBOT_VISUAL_EMPTY 警告", async () => {
    const visual = await buildRobotVisual({ format: "mjcf", baseUri: "file:///robot/", document: { worldbody: {} } } as any, () => { throw new Error("不该去取网格") })
    expect(countMeshes(visual)).toBe(0)
    expect(visual.warnings.filter(text => text.startsWith("ROBOT_VISUAL_EMPTY")).length).toBe(1)
  })

  test("缺网格资产的 geom 走缺件警告（画面照旧，不是失败）", async () => {
    const visual = await buildRobotVisual({ format: "mjcf", baseUri: "file:///robot/", document: { worldbody: { body: { name: "b", geom: { type: "mesh", mesh: "missing" } } } } } as any, () => { throw new Error("不该去取网格") })
    expect(visual.warnings.some(text => text.startsWith("MESH_ASSET_MISSING: missing"))).toBe(true)
    expect(visual.warnings.some(text => text.startsWith("ROBOT_VISUAL_EMPTY"))).toBe(false)   // 容器建出来了：缺件 ≠ 没内容
  })
})

describe("原生动态几何消费同一帧与生命周期", () => {
  const handle: WorldHandle = { worldId: "native-world", sceneId: "native-scene", engineId: "mujoco", engineVersion: "test", worldGeneration: 1, appliedSceneRevision: 1, status: "ready" }
  const observed = (entityId: string, dynamicGeometry?: EntityObservation["dynamicGeometry"]): EntityObservation => ({ entityId, transform: identityTransform(), dynamicGeometry })
  const frame = (stepIndex: number, entities: EntityObservation[], generation = 1): Frame => ({ worldId: handle.worldId, generation, sceneRevision: 1, stepIndex, simTime: stepIndex * .01, frameId: `native-${generation}-${stepIndex}`, entities })
  function bare(ids: string[]) {
    // 与既有环境/相机 Viewer 测试相同：调用产品真方法；这个进程不创建 WebGL 或宣称像素验收。
    const viewer = Object.create(SceneViewer.prototype) as any
    Object.assign(viewer, { scene: new THREE.Scene(), objects: new Map(), projection: new FrameProjection(), display: { wireframe: false }, visualWarnings: new Map(), syncRobotAnchors: () => {}, syncCollisionTopology: () => {}, setCameraRigs: () => {}, trackAnimation: () => {}, robotAnchorLayer: { receive: () => {} }, snapshot: { sceneId: handle.sceneId, revision: 1, coordinates: SCENE_COORDINATES, entities: [] } })
    for (const entityId of ids) {
      const group = new THREE.Group(), visual = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
      group.userData.entityId = entityId; group.add(visual); viewer.scene.add(group)
      viewer.objects.set(entityId, { group, visual, signature: entityId, lodWarnings: [] })
      viewer.snapshot.entities.push({ entityId, name: entityId, transform: identityTransform(), resources: [], components: {} })
    }
    viewer.projection.setScene(viewer.snapshot)
    viewer.setWorld(handle)
    return viewer
  }

  test("父节点平移旋转缩放不重复作用于世界米制网格；旧代次/旧步数不能覆盖显示", () => {
    const viewer = bare(["soft"]), loaded = viewer.objects.get("soft")
    const parent = new THREE.Group(); parent.position.set(4, -3, 2); parent.rotation.z = .7; parent.scale.set(2, 3, 4)
    viewer.scene.add(parent); parent.add(loaded.group)
    const source = observed("soft", [{ nativeName: "flex", kind: "mesh", positionsM: [10, 20, 30, 11, 20, 30, 10, 21, 30], indices: [0, 1, 2] }])
    source.transform.position = [10, 20, 30]
    expect(viewer.pushFrame(frame(1, [source]))).toBe(true)
    viewer.applyFrame(viewer.projection.consume())
    expect(viewer.pushFrame(frame(0, [source]))).toBe(false)
    expect(viewer.pushFrame(frame(2, [source], 2))).toBe(false)
    viewer.snapshot.revision = 2; viewer.projection.setScene(viewer.snapshot)
    expect(viewer.pushFrame(frame(2, [source]))).toBe(false)
    viewer.snapshot.revision = 1; viewer.projection.setScene(viewer.snapshot)
    viewer.scene.updateMatrixWorld(true)
    const mesh = loaded.dynamicGeometry.root.children[0] as THREE.Mesh
    const worldVertex = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), 0).applyMatrix4(mesh.matrixWorld)
    expect(worldVertex.distanceTo(new THREE.Vector3(10, 20, 30))).toBeLessThan(1e-8)
    expect(loaded.visual.visible).toBe(false)
    viewer.setWorld({ ...handle, status: "closed" })
    expect(loaded.dynamicGeometry).toBeUndefined()
    expect(loaded.visual.visible).toBe(true)
    expect(viewer.projection.current()).toBeUndefined()
  })

  test("粒子复用一个显示对象；选择性帧只清出现且没有动态几何的实体，换代释放真实几何", () => {
    const viewer = bare(["soft", "water"])
    viewer.applyFrame(frame(1, [observed("soft", [{ nativeName: "flex", kind: "mesh", positionsM: [0, 0, 1, 1, 0, 1, 0, 1, 1], indices: [0, 1, 2] }]), observed("water", [{ nativeName: "water", kind: "particles", positionsM: [0, 0, 1, .1, 0, 1], radiusM: .02 }])]))
    const water = viewer.objects.get("water"), particles = water.dynamicGeometry.root.children[0] as THREE.Points
    expect(particles).toBeInstanceOf(THREE.Points)
    expect(particles.geometry.getAttribute("position").count).toBe(2)
    viewer.applyFrame(frame(2, [observed("water", [{ nativeName: "water", kind: "particles", positionsM: [0, 0, .9, .1, 0, .8], radiusM: .03 }])]))
    expect(water.dynamicGeometry.root.children[0]).toBe(particles)
    expect(particles.geometry.getAttribute("position").getZ(1)).toBeCloseTo(.8)
    viewer.applyFrame(frame(3, [observed("soft")]))
    expect(viewer.objects.get("soft").dynamicGeometry).toBeUndefined()
    expect(viewer.objects.get("soft").visual.visible).toBe(true)
    expect(water.dynamicGeometry.root.children[0]).toBe(particles)
    let released = 0; particles.geometry.addEventListener("dispose", () => released++)
    viewer.setWorld({ ...handle, worldGeneration: 2 })
    expect(released).toBe(1)
    expect(water.dynamicGeometry).toBeUndefined()
    expect(water.visual.visible).toBe(true)
  })

  test("缆线仅替换原生身份绑定的静态body，保留同源障碍；未展开节点有精确缺项", async () => {
    const viewer = bare(["cable"]), loaded = viewer.objects.get("cable")
    const robot = await buildRobotVisual({ format: "mjcf", baseUri: "file:///native/", document: { worldbody: { body: [
      { name: "wireB_first", geom: { type: "capsule", size: ".01", fromto: "0 0 1 1 0 1" } },
      { name: "obstacle", geom: { type: "box", size: ".1 .1 .1" } },
    ] } } } as any, () => { throw new Error("本用例无外部网格") })
    loaded.visual.removeFromParent(); loaded.group.add(robot.root); loaded.robot = robot; loaded.visual = robot.root
    viewer.applyFrame(frame(1, [observed("cable", [{ nativeName: "compositewire", kind: "lines", positionsM: [0, 0, 1, 1, 0, .7], indices: [0, 1], radiusM: .01, nativeBodyNames: ["wireB_first", "not-expanded"] }])]))
    expect(robot.root.visible).toBe(true)
    expect(robot.bodyNode("wireB_first")!.visible).toBe(false)
    expect(robot.bodyNode("obstacle")!.visible).toBe(true)
    expect(loaded.dynamicGeometry.unmatchedBodyNames).toEqual(["not-expanded"])
    expect(loaded.dynamicGeometry.root.children[0]).toBeInstanceOf(THREE.InstancedMesh)
    viewer.applyFrame(frame(2, [observed("cable", [])]))
    expect(robot.bodyNode("wireB_first")!.visible).toBe(true)
    expect(robot.bodyNode("obstacle")!.visible).toBe(true)
  })

  test("原生动态网格沿已发布PBR owner应用材质，换代恢复静态且克隆只释放一次", () => {
    const viewer = bare(["soft"]), loaded = viewer.objects.get("soft")
    viewer.snapshot.entities[0].components.materialOverride = {kind:"visual/material-override",roughness:.17,baseColor:"#ee4422"}
    viewer.applyFrame(frame(1, [observed("soft", [{nativeName:"flex",kind:"mesh",positionsM:[0,0,1,1,0,1,0,1,1],indices:[0,1,2]}])]))
    const mesh=loaded.dynamicGeometry.root.children[0] as THREE.Mesh
    const material=mesh.material as THREE.MeshStandardMaterial
    expect(material.roughness).toBe(.17)
    expect(material.color.getHexString()).toBe("ee4422")
    expect(viewer.materialStatus("soft").materials[0].roughness).toBe(.17)
    let clonesReleased=0;material.addEventListener("dispose",()=>clonesReleased++)
    viewer.applyFrame(frame(2, [observed("soft", [{nativeName:"flex",kind:"mesh",positionsM:[0,0,.8,1,0,1,0,1,1],indices:[0,1,2]}])]))
    expect(mesh.material).toBe(material)
    expect(clonesReleased).toBe(0)
    viewer.setWorld({...handle,worldGeneration:2})
    expect(clonesReleased).toBe(1)
    expect(loaded.dynamicGeometry).toBeUndefined()
    expect(loaded.visual.visible).toBe(true)
  })
})

/**
 * R-011：真实部件目录与**只读展示层炸开**。
 *
 * 这里证明的是三层事实，全部对着真实 THREE 节点/矩阵：
 *  · 部件身份与原生层级来自真文档（MJCF body / URDF link），同名不靠显示名区分；
 *  · 炸开只写展示组 `presentation.position`，原生 body/FK 节点矩阵、实体 group、Scene 快照一个数不动；
 *  · 0→中间→最大→0 可逆、不累计漂移，且原生位姿更新后仍保持展开。
 */
const p2MJCF = {
  format: "mjcf", baseUri: "file:///p2/",
  document: {
    compiler: { angle: "radian" },
    worldbody: {
      geom: { name: "floor", type: "plane", size: "0 0 0.05" },
      body: [{
        name: "base", pos: "0 0 0", geom: { name: "base_geom", type: "box", size: ".1 .1 .1" },
        body: [{
          name: "link1", pos: "0 0 0.4", joint: { name: "j1", type: "hinge", axis: "0 1 0" },
          geom: { name: "link1_geom", type: "box", size: ".1 .1 .1" },
          body: [{ name: "tool", pos: "0 0 0.4", geom: { name: "tool_geom", type: "box", size: ".05 .05 .05" } }],
        }],
      }],
    },
  },
} as const

const p2URDF = {
  format: "urdf",
  document: {
    link: [
      { name: "base", visual: { origin: { xyz: "0 0 0" }, geometry: { box: { size: "0.2 0.2 0.2" } } } },
      { name: "arm", visual: { origin: { xyz: "0 0 0" }, geometry: { box: { size: "0.15 0.15 0.3" } } } },
      { name: "tool", visual: { origin: { xyz: "0 0 0" }, geometry: { sphere: { radius: 0.04 } } } },
    ],
    joint: [
      { name: "j1", type: "revolute", parent: { link: "base" }, child: { link: "arm" }, origin: { xyz: "0 0 0.3" }, axis: { xyz: "0 1 0" } },
      { name: "j2", type: "fixed", parent: { link: "arm" }, child: { link: "tool" }, origin: { xyz: "0 0 0.3" } },
    ],
  },
} as const

const matrixWorldOf = (object: THREE.Object3D): number[] => { object.updateWorldMatrix(true, true); return [...object.matrixWorld.elements] }
const presentationOffsets = (visual: RobotVisual): number[] => visual.parts.flatMap(part => part.presentation.position.toArray())
const anyOffset = (visual: RobotVisual): boolean => presentationOffsets(visual).some(value => Math.abs(value) > 1e-9)

describe("R-011 部件目录：MJCF 真实 body 层级", () => {
  test("稳定 partId 由下标路径构成，与显示名无关；每个真实 body 各有身份", async () => {
    const visual = await buildRobotVisual(p2MJCF as any, () => { throw new Error("本用例无外部网格") })
    expect(visual.parts.map(part => part.partId)).toEqual(["body:0", "body:0.0", "body:0.0.0"])
    expect(visual.parts.map(part => part.name)).toEqual(["base", "link1", "tool"])
    expect(visual.parts.map(part => part.path)).toEqual([["base"], ["base", "link1"], ["base", "link1", "tool"]])
    expect(visual.parts.every(part => part.kind === "body" && part.granularity === "hierarchy" && part.hasVisual)).toBe(true)
    // 同名不靠显示名区分：两份文档都叫 body 时身份仍不同（这里用下标路径证明）。
    expect(new Set(visual.parts.map(part => part.partId)).size).toBe(3)
  })

  test("展示组合拢时为零；原生 body 节点矩阵与部件节点身份不变", async () => {
    const visual = await buildRobotVisual(p2MJCF as any, () => { throw new Error("本用例无外部网格") })
    expect(anyOffset(visual)).toBe(false)
    for (const part of visual.parts) expect(visual.bodyNode(part.name)).toBe(part.node)
    const before = matrixWorldOf(visual.bodyNode("link1")!)
    visual.setExplodeSpread(0.5)
    expect(anyOffset(visual)).toBe(true)
    // 原生 body 节点的世界矩阵一个数都不因展示偏移而变。
    expect(matrixWorldOf(visual.bodyNode("link1")!)).toEqual(before)
  })

  test("0/中间/最大有效，反复合拢无累计漂移，resetPose 一并合拢", async () => {
    const visual = await buildRobotVisual(p2MJCF as any, () => { throw new Error("本用例无外部网格") })
    visual.setExplodeSpread(0.5)
    const half = presentationOffsets(visual)
    expect(half.some(value => Math.abs(value) > 1e-9)).toBe(true)
    visual.setExplodeSpread(1)
    const full = presentationOffsets(visual)
    // 最大展开的位移量大于中间档（逐部件同向放大）。
    const magnitude = (values: number[]): number => values.reduce((sum, value) => sum + Math.abs(value), 0)
    expect(magnitude(full)).toBeGreaterThan(magnitude(half))
    for (let round = 0; round < 3; round++) {
      visual.setExplodeSpread(0)
      expect(anyOffset(visual)).toBe(false)
      visual.setExplodeSpread(0.5)
      expect(presentationOffsets(visual)).toEqual(half)
    }
    visual.setExplodeSpread(1)
    visual.resetPose()
    expect(anyOffset(visual)).toBe(false)
    expect(visual.explodeSpread()).toBe(0)
  })

  test("原生关节位姿更新后仍保持展开，展开不写回原生矩阵", async () => {
    const visual = await buildRobotVisual(p2MJCF as any, () => { throw new Error("本用例无外部网格") })
    visual.setExplodeSpread(0.5)
    visual.setJoints(["j1"], [0.4])
    const offsets = presentationOffsets(visual)
    expect(offsets.some(value => Math.abs(value) > 1e-9)).toBe(true)
    // 展开姿态不会被下一帧 FK 覆盖：再驱动一次关节，展示偏移原样保留。
    visual.setJoints(["j1"], [0.8])
    expect(presentationOffsets(visual)).toEqual(offsets)
  })
})

/**
 * 真实 Panda 的装配回归（2026-10-18 用户截图：上臂/肘、腕/夹爪出现真实缝隙）。
 *
 * 事实链：MuJoCo 的 `data.xpos/xquat[body]` 是**已含本 body 关节运动**的 body 世界位姿；
 * Viewer 的可视 geom 却挂在 body 节点之后的关节 stage 下。`setBodyWorldPoses` 用
 * `parentStageWorld⁻¹ × target` 写 body 节点，再让 `setJoints` 留下的 stage 生效，于是同一个
 * 关节在展示层被应用**两次**：body 节点/相机挂载是对的，外壳多转一个关节角。真实 Panda 的
 * link4（joint4=-1.57079）在肘部把 link4↔link5 的可见外壳拉开约 4.9cm；link7（joint7=-0.7853）
 * 相对 hand 多转 0.785rad，正是腕/夹爪的缝隙。
 *
 * 这里不再用"有 mesh / spread=0"冒充装配正确：夹具 `fixtures/panda-native-reference.json`
 * 由 MuJoCo 3.13 编译真实 `packs/franka_panda/.../panda.xml` 后导出三份姿态（zero/home/changed）的 body xpos/xquat 与
 * 每个 body 的**逐顶点**可视外壳世界 AABB（group 2 mesh geoms，即官方渲染实际使用的几何）。
 * 测试把同一份 body 世界位姿喂给 Viewer，按真实调用顺序（setJoints → setBodyWorldPoses）比较
 * 可见外壳的 AABB；旧实现会在 link4/link6/link7 上直接超差。
 */
type PandaPose = {
  qpos: number[]
  bodies: Record<string, { positionM: number[]; quaternionXyzw: number[] }>
  visualAabb: Record<string, { min: number[]; max: number[]; meshCount: number; vertexCount: number }>
}
const pandaReference = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "panda-native-reference.json"), "utf8")) as {
  source: string
  sourceSha256: string
  mujocoVersion: string
  poses: Record<"zero" | "home" | "changed", PandaPose>
}
const pandaSource = join(import.meta.dir, "..", "..", "..", "packs", "franka_panda", "asset", "franka_emika_panda", "panda.xml")
const pandaJoints = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "joint7", "finger_joint1", "finger_joint2"]
/** 与 applyWorldPoses 同一输入形状：名字 → MuJoCo body 世界位姿。 */
const pandaWorldPoses = (pose: PandaPose) => Object.fromEntries(Object.entries(pose.bodies).map(([bodyName, target]) => [bodyName, { bodyName, ...target }]))
/**
 * 原生夹具是**逐顶点**变换后的 AABB；`Box3.applyMatrix4` 只变换旧 AABB 的 8 个角点，旋转件会虚胖，
 * 不能用于这条判据。这里与生成夹具的 Python 用同一种口径：每个可见 mesh 的每个顶点都进世界矩阵。
 * 隐藏的碰撞壳（group 3）不参与；它与 MuJoCo 夹具的 group-2 visual 口径一致。
 */
const visibleVertexBox = (presentation: THREE.Object3D): THREE.Box3 => {
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  const visit = (object: THREE.Object3D, ancestorsVisible: boolean): void => {
    const visible = ancestorsVisible && object.visible
    if (object instanceof THREE.Mesh && visible) {
      const position = object.geometry.getAttribute("position")
      for (let index = 0; index < position.count; index++) {
        point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld)
        box.expandByPoint(point)
      }
    }
    for (const child of object.children) visit(child, visible)
  }
  presentation.updateWorldMatrix(true, true)
  visit(presentation, true)
  return box
}
const expectPandaBoxClose = (actual: THREE.Box3, expected: { min: number[]; max: number[] }, label: string): void => {
  // 夹具与 Viewer 都是同一份 OBJ；Viewer 的顶点是 float32、夹具是 MuJoCo 的 float64，实测最大差约 1.6e-6m
  // （changed 位姿的 link4）。1e-5m 仍比旧断口小 3~4 个数量级，不会把 4.9cm/0.78rad 的重复关节放过。
  const tolerance = 1e-5
  for (let axis = 0; axis < 3; axis++) {
    expect(Math.abs(actual.min.getComponent(axis) - expected.min[axis]!), `${label} min[${axis}]`).toBeLessThan(tolerance)
    expect(Math.abs(actual.max.getComponent(axis) - expected.max[axis]!), `${label} max[${axis}]`).toBeLessThan(tolerance)
  }
}
const expectPandaPose = (visual: RobotVisual, pose: PandaPose, label: string): void => {
  for (const [bodyName, expected] of Object.entries(pose.visualAabb)) {
    const part = visual.parts.find(candidate => candidate.name === bodyName)
    if (!part) throw new Error(`PANDA_PART_MISSING: ${label}/${bodyName}`)
    expectPandaBoxClose(visibleVertexBox(part.presentation), expected, `${label}/${bodyName}`)
  }
}

// pack 资产件不随源仓分发（`packs/*/asset` 是本地供给链接）：缺件显式跳过，不计为原生通过。
describe.skipIf(!existsSync(pandaSource))("真实 Panda：body 世界位姿投影不得重复应用本 body 关节（肘/腕断口）", () => {
  test("原生参照夹具与当前 panda.xml 是同一份原件，不是过期快照", () => {
    expect(pandaReference.source).toBe("packs/franka_panda/asset/franka_emika_panda/panda.xml")
    expect(pandaReference.mujocoVersion).toMatch(/^3\./)
    expect(createHash("sha256").update(readFileSync(pandaSource)).digest("hex")).toBe(pandaReference.sourceSha256)
  })

  test("zero/home/改变位姿：关节 FK、body 位姿投影、炸开合拢的可见外壳都对齐 MuJoCo 编译几何", async () => {
    const visual = await buildRobotVisual(await robotVisual(pandaSource) as any, (uri: string) => {
      if (!uri.startsWith("file:")) throw new Error(`PANDA_TEST_UNEXPECTED_URI: ${uri}`)
      return `data:application/octet-stream;base64,${readFileSync(fileURLToPath(uri)).toString("base64")}`
    })
    expect(visual.warnings).toEqual([])
    for (const label of ["zero", "home", "changed"] as const) {
      const pose = pandaReference.poses[label]
      // 1) 只有关节（资源预览没有模拟帧时的路径）：FK 必须与原生一致。先 resetPose 回到源文档
      //    装配基，避免上一轮的 body 世界位姿投影残留成这一轮的"关节 FK"。
      visual.resetPose()
      visual.setJoints(pandaJoints, pose.qpos)
      visual.root.updateWorldMatrix(true, true)
      expectPandaPose(visual, pose, `${label}/joint-only`)
      // 2) 模拟帧：真实调用顺序是 setJoints 再 setBodyWorldPoses。body 节点（相机挂载/TCP/拾取）
      //    必须仍是 MuJoCo 的 xpos/xquat；可见外壳也必须回到同一个 body 帧，而不是再乘一次本 body 关节。
      visual.setJoints(pandaJoints, pose.qpos)
      visual.setBodyWorldPoses(pandaWorldPoses(pose))
      visual.root.updateWorldMatrix(true, true)
      for (const [bodyName, expected] of Object.entries(pose.bodies)) {
        const node = visual.bodyNode(bodyName)
        if (!node) throw new Error(`PANDA_BODY_MISSING: ${label}/${bodyName}`)
        const target = new THREE.Matrix4().compose(
          new THREE.Vector3(...expected.positionM as [number, number, number]),
          new THREE.Quaternion(...expected.quaternionXyzw as [number, number, number, number]).normalize(),
          new THREE.Vector3(1, 1, 1),
        )
        for (let index = 0; index < 16; index++) {
          expect(Math.abs(node.matrixWorld.elements[index]! - target.elements[index]!), `${label}/${bodyName} bodyNode[${index}]`).toBeLessThan(1e-6)
        }
        // 直接钉住根因：没有炸开时，本 body 的可见展示组必须与原生 body 帧逐元素同矩阵。
        // 旧实现这里会是 `target·J`（link4/link6/link7 的旋转差就是各自的关节角）。
        const part = visual.parts.find(candidate => candidate.name === bodyName)
        if (!part) throw new Error(`PANDA_PART_MISSING: ${label}/${bodyName}`)
        for (let index = 0; index < 16; index++) {
          expect(Math.abs(part.presentation.matrixWorld.elements[index]! - node.matrixWorld.elements[index]!), `${label}/${bodyName} presentation[${index}]`).toBeLessThan(1e-9)
        }
      }
      expectPandaPose(visual, pose, `${label}/projected`)
      // 3) 炸开只动 presentation；合拢后仍回到同一原生装配（不是"回到错误的初始截图"）。
      const nativeBodyNodes = new Map(Object.keys(pose.bodies).map(bodyName => [bodyName, [...visual.bodyNode(bodyName)!.matrixWorld.elements]]))
      visual.setExplodeSpread(0.5)
      visual.root.updateWorldMatrix(true, true)
      expect(visual.explodeOffsets().size).toBeGreaterThan(0)
      for (const [bodyName, before] of nativeBodyNodes) expect([...visual.bodyNode(bodyName)!.matrixWorld.elements]).toEqual(before)
      visual.setExplodeSpread(0)
      visual.root.updateWorldMatrix(true, true)
      expectPandaPose(visual, pose, `${label}/restored`)
    }
  }, 30_000)
})

describe("R-011 部件目录：URDF 真实 link 层级", () => {
  test("link 就是部件，bodyNode 对 URDF 也能给出真实节点（补上原实现只建 links Map 的缺口）", async () => {
    const visual = await buildRobotVisual(p2URDF as any, () => { throw new Error("本用例无外部网格") })
    expect(visual.parts.map(part => part.partId)).toEqual(["link:0", "link:1", "link:2"])
    expect(visual.parts.map(part => part.name)).toEqual(["base", "arm", "tool"])
    expect(visual.parts.every(part => part.kind === "link" && part.granularity === "hierarchy")).toBe(true)
    expect(visual.bodyNode("arm")).toBe(visual.parts[1]!.node)
    visual.setExplodeSpread(0.5)
    expect(anyOffset(visual)).toBe(true)
    const before = matrixWorldOf(visual.bodyNode("arm")!)
    visual.setExplodeSpread(0)
    expect(matrixWorldOf(visual.bodyNode("arm")!)).toEqual(before)
  })

  test("URDF 允许 child 先于 root 声明：目录仍按真实关节父先子后，身份绑定源下标", async () => {
    // link 数组顺序故意反着写（tool → arm → base），关节列表也反着：身份必须跟着源下标走，
    // 呈现次序必须跟着真实父子走，不能靠输入排序或按显示名合并。
    const reverse = {
      format: "urdf",
      document: {
        link: [
          { name: "tool", visual: { geometry: { sphere: { radius: 0.04 } } } },
          { name: "arm", visual: { geometry: { box: { size: "0.15 0.15 0.3" } } } },
          { name: "base", visual: { geometry: { box: { size: "0.2 0.2 0.2" } } } },
        ],
        joint: [
          { name: "j2", type: "fixed", parent: { link: "arm" }, child: { link: "tool" }, origin: { xyz: "0 0 0.3" } },
          { name: "j1", type: "revolute", parent: { link: "base" }, child: { link: "arm" }, origin: { xyz: "0 0 0.5" }, axis: { xyz: "0 1 0" } },
        ],
      },
    } as const
    const visual = await buildRobotVisual(reverse as any, () => { throw new Error("本用例无外部网格") })
    expect(visual.parts.map(part => part.partId)).toEqual(["link:2", "link:1", "link:0"])
    expect(visual.parts.map(part => part.name)).toEqual(["base", "arm", "tool"])
    expect(visual.parts.map(part => part.path)).toEqual([["base"], ["base", "arm"], ["base", "arm", "tool"]])
  })

  test("URDF 反序/多层/带旋转：每个 body 的实际世界矩阵都等于输入，展示偏移不改原生矩阵", async () => {
    const reverse = {
      format: "urdf",
      document: {
        link: [
          { name: "tool", visual: { geometry: { sphere: { radius: 0.04 } } } },
          { name: "arm", visual: { geometry: { box: { size: "0.15 0.15 0.3" } } } },
          { name: "base", visual: { geometry: { box: { size: "0.2 0.2 0.2" } } } },
        ],
        joint: [
          { name: "j2", type: "fixed", parent: { link: "arm" }, child: { link: "tool" }, origin: { xyz: "0 0 0.3" } },
          { name: "j1", type: "revolute", parent: { link: "base" }, child: { link: "arm" }, origin: { xyz: "0 0 0.5" }, axis: { xyz: "0 1 0" } },
        ],
      },
    } as const
    const visual = await buildRobotVisual(reverse as any, () => { throw new Error("本用例无外部网格") })
    // 世界位姿故意逆序传入：父在子之后给。投影必须按 Object3D 父子顺序算，不能按输入/登记顺序。
    const armQuaternion: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2]
    const poses = {
      tool: { bodyName: "tool", positionM: [3, 4, 5], quaternionXyzw: [0, 0, 0, 1] },
      arm: { bodyName: "arm", positionM: [2, 3, 4], quaternionXyzw: armQuaternion },
      base: { bodyName: "base", positionM: [1, 2, 3], quaternionXyzw: [0, 0, 0, 1] },
    }
    visual.setBodyWorldPoses(poses)
    visual.root.updateWorldMatrix(true, true)
    const expected = new Map<string, THREE.Matrix4>([
      ["base", new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion(0, 0, 0, 1), new THREE.Vector3(1, 1, 1))],
      ["arm", new THREE.Matrix4().compose(new THREE.Vector3(2, 3, 4), new THREE.Quaternion(...armQuaternion).normalize(), new THREE.Vector3(1, 1, 1))],
      ["tool", new THREE.Matrix4().compose(new THREE.Vector3(3, 4, 5), new THREE.Quaternion(0, 0, 0, 1), new THREE.Vector3(1, 1, 1))],
    ])
    const roundMatrix = (value: THREE.Matrix4) => [...value.elements].map(entry => Number(entry.toFixed(9)))
    for (const [name, target] of expected) {
      const node = visual.bodyNode(name)!
      expect(node.getWorldPosition(new THREE.Vector3()).toArray().map(value => Number(value.toFixed(9)))).toEqual([target.elements[12]!, target.elements[13]!, target.elements[14]!].map(value => Number(value.toFixed(9))))
      expect(roundMatrix(node.matrixWorld)).toEqual(roundMatrix(target))
    }
    // 展示层炸开只写 presentation 组：原生 link 世界矩阵逐元素不变。
    const native = new Map([...expected.keys()].map(name => [name, roundMatrix(visual.bodyNode(name)!.matrixWorld)]))
    visual.setExplodeSpread(0.5)
    visual.root.updateWorldMatrix(true, true)
    for (const [name, before] of native) expect(roundMatrix(visual.bodyNode(name)!.matrixWorld)).toEqual(before)
    visual.setExplodeSpread(0)
  })
})

describe("R-011 Viewer 部件目录/高亮/展示元数据（真实节点，不创建 WebGL）", () => {
  async function robotViewer() {
    const robot = await buildRobotVisual(p2MJCF as any, () => { throw new Error("本用例无外部网格") })
    const viewer = Object.create(SceneViewer.prototype) as any
    const group = new THREE.Group(); group.userData.entityId = "robot-1"; group.add(robot.root)
    const scene = new THREE.Scene(); scene.add(group)
    const entity = { entityId: "robot-1", name: "robot-1", transform: identityTransform(), resources: [], components: {} }
    // 记录真实 attach/detach 调用（判据看行为，不看源码字符串）。
    const controls: { object: THREE.Object3D | undefined; attach(node: THREE.Object3D): void; detach(): void } = {
      object: undefined,
      attach(node) { controls.object = node },
      detach() { controls.object = undefined },
    }
    Object.assign(viewer, {
      scene, objects: new Map([["robot-1", { group, robot, visual: robot.root, signature: "r1@2", lodWarnings: [], baseRef: { resourceId: "r1", version: 2 } }]]),
      projection: new FrameProjection(), display: { wireframe: false }, visualWarnings: new Map(),
      syncRobotAnchors: () => {}, syncCollisionTopology: () => {}, setCameraRigs: () => {}, trackAnimation: () => {},
      robotAnchorLayer: { receive: () => {} },
      snapshot: { sceneId: "s1", revision: 1, coordinates: SCENE_COORDINATES, entities: [entity] },
      options: { onPartSelect: undefined, onSelection: undefined, commitEdit: undefined },
      selected: undefined, selectedPart: undefined, partExplode: undefined, partHighlight: undefined,
      transformControls: controls,
      updateAnnotationMarkers: () => {},
    })
    viewer.projection.setScene(viewer.snapshot)
    return { viewer, robot, group, controls }
  }

  test("listParts 带 entityId/资源版本/签名；identity 不靠显示名", async () => {
    const { viewer } = await robotViewer()
    const parts = viewer.listParts("robot-1")
    expect(parts.map((part: any) => part.partId)).toEqual(["body:0", "body:0.0", "body:0.0.0"])
    expect(parts.every((part: any) => part.entityId === "robot-1" && part.resource === "r1@2" && part.resourceSignature === "r1@2" && part.separable)).toBe(true)
    expect(viewer.listParts("missing")).toEqual([])
  })

  test("部件高亮只替换 Mesh 材质引用、不动共享材质本身，清除后逐项换回", async () => {
    const { viewer, robot } = await robotViewer()
    const target = robot.parts[0]!.presentation
    const mesh = target.getObjectByProperty("isMesh", true) as THREE.Mesh
    const original = mesh.material as THREE.Material
    const originalColor = (original as THREE.MeshStandardMaterial).color.getHexString()
    viewer.selectPart("robot-1", "body:0")
    expect(viewer.selectedPartRef()).toEqual({ entityId: "robot-1", partId: "body:0" })
    expect(mesh.material).not.toBe(original)
    // 共享材质本身（其它实例仍引用它）一个字节都没改。
    expect((original as THREE.MeshStandardMaterial).color.getHexString()).toBe(originalColor)
    viewer.selectPart(undefined, undefined)
    expect(mesh.material).toBe(original)
    expect(viewer.selectedPartRef()).toBeUndefined()
  })

  test("presentationStatus 如实给出 displayOnly/展开比例/选中部件/资源身份", async () => {
    const { viewer } = await robotViewer()
    expect(viewer.presentationStatus()).toEqual({ displayOnly: true, exploded: false, spread: 0 })
    viewer.selectPart("robot-1", "body:0.0")
    const result = viewer.setPartExplode("robot-1", 0.5)
    expect(result).toEqual({ spread: 0.5 })
    const face = viewer.presentationStatus()
    expect(face.displayOnly).toBe(true)
    expect(face.exploded).toBe(true)
    expect(face.spread).toBeCloseTo(0.5)
    expect(face.entityId).toBe("robot-1")
    expect(face.selectedPart).toEqual({ entityId: "robot-1", partId: "body:0.0", name: "link1", kind: "body" })
    expect(face.catalog).toEqual({ entityId: "robot-1", resource: "r1@2", signature: "r1@2", parts: 3, separable: 3 })
  })

  test("动态几何/单部件如实拒绝炸开并给出原因；部件选择/展开零 Scene 写入", async () => {
    const { viewer, group } = await robotViewer()
    const before = JSON.stringify(viewer.snapshot.entities[0])
    viewer.selectPart("robot-1", "body:0")
    viewer.setPartExplode("robot-1", 1)
    expect(JSON.stringify(viewer.snapshot.entities[0])).toBe(before)
    expect(group.position.toArray()).toEqual([0, 0, 0])
    // 动态几何：不可炸开，原因具体。
    viewer.objects.get("robot-1").dynamicGeometry = {}
    expect(viewer.listParts("robot-1").every((part: any) => !part.separable && String(part.reason).includes("动态几何"))).toBe(true)
    expect(viewer.setPartExplode("robot-1", 1)).toEqual({ spread: 0, reason: "该实体当前显示原生动态几何（线缆/网格由物理帧驱动），不能按刚体拉开" })
    expect(viewer.partExplodeStatus()).toEqual({ entityId: "robot-1", spread: 0, reason: "该实体当前显示原生动态几何（线缆/网格由物理帧驱动），不能按刚体拉开" })
  })

  test("实体释放按身份清理高亮/展开/选中", async () => {
    const { viewer } = await robotViewer()
    viewer.selectPart("robot-1", "body:0")
    viewer.setPartExplode("robot-1", 0.5)
    const loaded = viewer.objects.get("robot-1")
    // 与 setScene 的移除路径一致：先按身份释放 Loaded，再把它移出 objects。
    viewer.release(loaded); viewer.objects.delete("robot-1")
    expect(viewer.selectedPartRef()).toBeUndefined()
    expect(viewer.partExplodeStatus()).toEqual({ spread: 0 })
    expect(viewer.listParts("robot-1")).toEqual([])
  })

  test("炸开时重新选中/重设编辑权限都不会再挂真实 Transform；合拢或换实体后编辑恢复", async () => {
    const { viewer, controls, group } = await robotViewer()
    viewer.options.commitEdit = async () => viewer.snapshot
    // 显式进入手动变换后，未炸开时选中照常挂上。
    viewer.transformEditing = true
    viewer.select("robot-1")
    expect(controls.object).toBe(group)
    // 炸开 ⇒ 让位。
    viewer.setPartExplode("robot-1", 0.5)
    expect(controls.object).toBeUndefined()
    // 再次选择同一实体：这是主控探针复现的反例，必须仍不挂。
    viewer.select("robot-1")
    expect(controls.object).toBeUndefined()
    // 重新设置编辑权限（运行期读写权限变化）同样要走一致判据。
    viewer.setEditCommit(async () => viewer.snapshot)
    expect(controls.object).toBeUndefined()
    // 合拢后恢复编辑，不能把全局编辑永久禁用。
    viewer.setPartExplode("robot-1", 0)
    expect(controls.object).toBe(group)
    // 换到其他实体照常挂接；炸开的那台仍被单独拦下。
    const other = new THREE.Group(); other.userData.entityId = "robot-2"
    viewer.objects.set("robot-2", { group: other, visual: other, signature: "r2", lodWarnings: [] })
    viewer.snapshot.entities.push({ entityId: "robot-2", name: "robot-2", transform: identityTransform(), resources: [], components: {} })
    viewer.select("robot-2")
    expect(controls.object).toBe(other)
    viewer.setPartExplode("robot-1", 0.5)
    viewer.select("robot-2")
    expect(controls.object).toBe(other)
    viewer.select("robot-1")
    expect(controls.object).toBeUndefined()
  })
})

/**
 * R-011：非机器人**刚体物件**的纯显示炸开。
 *
 * 场景用真 THREE 图与真 `SceneViewer` 方法（不建 WebGL）：一个物件有两个真实 Mesh 兄弟，
 * 两个实例共享同一份几何/材质实例。证明：
 *  · 目录身份稳定、≥2 个真实部件可分，英文模式理由是英文；
 *  · 0/中间/最大/恢复可逆、无漂移，真实结点局部矩阵与源几何/共享材质一个数不动；
 *  · 两个实例互不影响（包装组只插在本实例的克隆层级里）；
 *  · 单网格、蒙皮、烘焙动画、LOD 切换按具体原因禁用；炸开零 Scene 写入。
 */
describe("R-011 非机器人刚体物件：真实节点展示层炸开", () => {
  type PropInstance = { group: THREE.Group; prop: THREE.Group; meshes: THREE.Mesh[] }
  function rigidViewer(options: { single?: boolean; skinned?: boolean } = {}) {
    const viewer = Object.create(SceneViewer.prototype) as any
    const sharedGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2)
    const sharedMaterial = new THREE.MeshStandardMaterial({ color: 0x336699 })
    const make = (entityId: string, x: number): PropInstance => {
      const prop = new THREE.Group(); prop.name = "prop"
      const first = options.skinned ? new THREE.SkinnedMesh(sharedGeometry, sharedMaterial) : new THREE.Mesh(sharedGeometry, sharedMaterial)
      first.name = "left"
      prop.add(first)
      const meshes: THREE.Mesh[] = [first]
      if (!options.single && !options.skinned) {
        const second = first.clone() as THREE.Mesh
        second.name = "right"; second.position.x = 1
        prop.add(second); meshes.push(second)
      }
      const group = new THREE.Group(); group.userData.entityId = entityId; group.position.x = x; group.add(prop)
      return { group, prop, meshes }
    }
    const one = make("asset-1", 0), two = make("asset-2", 10)
    const scene = new THREE.Scene(); scene.add(one.group, two.group)
    const entityOf = (entityId: string) => ({ entityId, name: entityId, transform: identityTransform(), resources: [], components: {} })
    const controls = { object: undefined as THREE.Object3D | undefined, attach(node: THREE.Object3D) { controls.object = node }, detach() { controls.object = undefined } }
    Object.assign(viewer, {
      scene, display: { wireframe: false }, visualWarnings: new Map(), selectedPart: undefined, partExplode: undefined, partHighlight: undefined, selected: undefined,
      objects: new Map([
        ["asset-1", { group: one.group, baseVisual: one.prop, visual: one.prop, signature: "glb@1", lodWarnings: [], shared: true, baseRef: { resourceId: "glb", version: 1 } }],
        ["asset-2", { group: two.group, baseVisual: two.prop, visual: two.prop, signature: "glb@1", lodWarnings: [], shared: true, baseRef: { resourceId: "glb", version: 1 } }],
      ]),
      projection: new FrameProjection(),
      syncRobotAnchors: () => {}, syncCollisionTopology: () => {}, setCameraRigs: () => {}, trackAnimation: () => {}, updateAnnotationMarkers: () => {},
      robotAnchorLayer: { receive: () => {} },
      snapshot: { sceneId: "s1", revision: 1, coordinates: SCENE_COORDINATES, entities: [entityOf("asset-1"), entityOf("asset-2")] },
      options: { onPartSelect: undefined, onSelection: undefined, commitEdit: undefined, translate: (_zh: string, en: string) => en },
      transformControls: controls,
    })
    viewer.projection.setScene(viewer.snapshot)
    return { viewer, one, two, sharedGeometry, sharedMaterial, controls }
  }
  const worldPosition = (object: THREE.Object3D): number[] => { object.updateWorldMatrix(true, true); return object.getWorldPosition(new THREE.Vector3()).toArray().map(value => Number(value.toFixed(9))) }
  const wrapperOffsets = (viewer: any, entityId: string): number[] => [...(viewer.objects.get(entityId).nodeExplode?.wrappers.values() ?? [])].flatMap((wrapper: THREE.Object3D) => wrapper.position.toArray())

  test("真实两部件：目录稳定、≥2 可分、英文系统理由", () => {
    const { viewer } = rigidViewer()
    const first = viewer.listParts("asset-1")
    const second = viewer.listParts("asset-1")
    expect(first.filter((part: any) => part.separable).length).toBe(2)
    expect(first.map((part: any) => part.partId)).toEqual(second.map((part: any) => part.partId))
    // 展示包装组不被列成用户部件，反复读取身份不变。
    expect(first.every((part: any) => !part.partId.startsWith("presentation"))).toBe(true)
    expect(first.every((part: any) => !/[\u4e00-\u9fff]/.test(part.reason ?? ""))).toBe(true)
    expect(viewer.listParts("asset-1").every((part: any) => !/[\u4e00-\u9fff]/.test(part.reason ?? ""))).toBe(true)
  })

  test("0/中间/最大/恢复可逆、无漂移；真实结点矩阵与共享几何/材质不变", () => {
    const { viewer, one, sharedGeometry, sharedMaterial } = rigidViewer()
    const mesh = one.meshes[0]!
    const originalPosition = mesh.position.toArray()
    const originalLocalMatrix = [...mesh.matrix.elements]
    const originalGeometryUUID = sharedGeometry.uuid
    const originalColor = sharedMaterial.color.getHexString()
    const assembled = worldPosition(mesh)
    expect(wrapperOffsets(viewer, "asset-1")).toEqual([])
    const half = viewer.setPartExplode("asset-1", 0.5)
    expect(half.spread).toBe(0.5)
    const halfWorld = worldPosition(mesh)
    expect(halfWorld).not.toEqual(assembled)
    const halfOffsets = wrapperOffsets(viewer, "asset-1")
    expect(halfOffsets.some(value => Math.abs(value) > 1e-9)).toBe(true)
    const full = viewer.setPartExplode("asset-1", 1)
    expect(full.spread).toBe(1)
    expect(wrapperOffsets(viewer, "asset-1").reduce((sum: number, value: number) => sum + Math.abs(value), 0)).toBeGreaterThan(halfOffsets.reduce((sum, value) => sum + Math.abs(value), 0))
    // 反复 0↔0.5 无累计漂移；恢复后世界位姿与装配态逐元素相同。
    for (let round = 0; round < 3; round++) {
      viewer.setPartExplode("asset-1", 0)
      expect(wrapperOffsets(viewer, "asset-1").every((value: number) => Math.abs(value) < 1e-12)).toBe(true)
      viewer.setPartExplode("asset-1", 0.5)
      expect(wrapperOffsets(viewer, "asset-1")).toEqual(halfOffsets)
    }
    viewer.setPartExplode("asset-1", 0)
    expect(worldPosition(mesh)).toEqual(assembled)
    // 源数据不动：真实结点矩阵/位置、共享几何与材质实例一个字节都没被展示层改过。
    expect(mesh.position.toArray()).toEqual(originalPosition)
    expect([...mesh.matrix.elements]).toEqual(originalLocalMatrix)
    expect(sharedGeometry.uuid).toBe(originalGeometryUUID)
    expect(sharedMaterial.color.getHexString()).toBe(originalColor)
  })

  test("同资源两个实例互不影响：展开一个，另一个的真实结点与包装组不动", () => {
    const { viewer, one, two } = rigidViewer()
    const oneAssembled = worldPosition(one.meshes[0]!)
    const twoAssembled = worldPosition(two.meshes[0]!)
    viewer.setPartExplode("asset-1", 0.5)
    expect(worldPosition(one.meshes[0]!)).not.toEqual(oneAssembled)
    expect(worldPosition(two.meshes[0]!)).toEqual(twoAssembled)
    expect(viewer.objects.get("asset-2").nodeExplode).toBeUndefined()
    // 合拢第一个再展开第二个：第一个回到装配态，第二个照常可分。
    viewer.setPartExplode("asset-1", 0)
    expect(worldPosition(one.meshes[0]!)).toEqual(oneAssembled)
    viewer.setPartExplode("asset-2", 0.5)
    expect(worldPosition(two.meshes[0]!)).not.toEqual(twoAssembled)
    expect(wrapperOffsets(viewer, "asset-2").some((value: number) => Math.abs(value) > 1e-9)).toBe(true)
    expect(worldPosition(one.meshes[0]!)).toEqual(oneAssembled)
  })

  test("单网格/蒙皮/烘焙动画/LOD 按具体原因禁用，英文模式无系统中文", () => {
    const single = rigidViewer({ single: true }).viewer
    const singleParts = single.listParts("asset-1")
    expect(singleParts.every((part: any) => !part.separable)).toBe(true)
    expect(String(single.setPartExplode("asset-1", 1).reason)).toContain("only one visual component")
    // 不可炸开不因拒绝而白插展示包装（真实结点层级保持不变）。
    expect(single.objects.get("asset-1").nodeExplode?.wrappers.size ?? 0).toBe(0)

    const skinned = rigidViewer({ skinned: true }).viewer
    expect(skinned.listParts("asset-1").every((part: any) => !part.separable)).toBe(true)
    expect(String(skinned.setPartExplode("asset-1", 1).reason)).toContain("skinned")

    const animated = rigidViewer().viewer
    animated.objects.get("asset-1").mixer = {}
    expect(String(animated.setPartExplode("asset-1", 1).reason)).toContain("animation")
    expect(animated.objects.get("asset-1").nodeExplode?.wrappers.size ?? 0).toBe(0)

    const lod = rigidViewer().viewer
    lod.objects.get("asset-1").lod = {}
    expect(String(lod.setPartExplode("asset-1", 1).reason)).toContain("LOD")
    expect(lod.objects.get("asset-1").nodeExplode?.wrappers.size ?? 0).toBe(0)
  })

  test("物件炸开零 Scene 写入，实体 group 变换逐元素不变", () => {
    const { viewer, one } = rigidViewer()
    const entityBefore = JSON.stringify(viewer.snapshot.entities[0])
    const groupBefore = one.group.matrix.toArray()
    viewer.setPartExplode("asset-1", 1)
    viewer.selectPart("asset-1", viewer.listParts("asset-1").find((part: any) => part.separable)!.partId)
    expect(JSON.stringify(viewer.snapshot.entities[0])).toBe(entityBefore)
    expect(one.group.matrix.toArray()).toEqual(groupBefore)
    expect(viewer.presentationStatus().displayOnly).toBe(true)
    expect(viewer.presentationStatus().catalog?.separable).toBe(2)
  })
})
