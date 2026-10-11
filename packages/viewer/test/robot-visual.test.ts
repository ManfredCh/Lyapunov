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
import { readFileSync } from "node:fs"
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
