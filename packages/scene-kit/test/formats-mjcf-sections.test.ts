/**
 * 重复 MJCF 顶层段与 include 组合的归一化（DEV-030）。
 *
 * 证明的是**解析结果**：重复的 `<asset>`／`<worldbody>` 并成一份后网格、body 层级、关节仍在，
 * 被 include 文档的 `meshdir` 生效，同目录 include 的 `file` 引用原样不动，跨目录 include 的按 MuJoCo
 * 的查找顺序落位（见文件末的跨目录 describe），多个 `<default class>` 的类边界不被并掉。画面侧由
 * `packages/viewer/test/robot-visual.test.ts` 用同一批夹具证明。
 *
 * 夹具：
 *  · `fixtures/mjcf-g1/g1_29dof_with_hand.xml`：Unitree 官方 `unitreerobotics/unitree_rl_gym`
 *    revision `276801e46c5d433564f24658bac64f254b7d2d4b` 的 `g1_29dof_with_hand.xml`，字节未改
 *    （sha256 `7b73b894c01c0be42eb8b7091ef9a3f94050b8243ebb25b4f2d3f387817b57bc`，同目录附官方
 *    BSD-3 LICENSE）。它就是"两段 `<asset>` + 两段 `<worldbody>`"的真实原件，期望值来自本机
 *    MuJoCo 3.12.0 对同一文件的编译读数（nmesh=50、nbody=45 含 world、njnt=44、ngeom=104）。
 *  · `fixtures/mjcf-duplicate-sections/`：自造夹具，机器人文档自身重复两段 `<asset>`／`<worldbody>`
 *    并由场景文档 include。MuJoCo 3.12.0 实测：`scene.xml` 编译出 nmesh=3／nbody=4／njnt=2／ngeom=4。
 *  · `fixtures/mjcf-include-subdir/`、`fixtures/mjcf-include-subdir-primary/`：跨目录 include（子文档在
 *    `kid/`），父与子各一个网格，两处的顶点数不同（四面体 4 / 立方体 8）用来分辨读到了哪一份。
 *
 * 运行：`bun test packages/scene-kit/test/formats-mjcf-sections.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseAsset, robotVisual } from "../src/formats.ts"

const FIXTURES = join(import.meta.dir, "fixtures")
const duplicate = join(FIXTURES, "mjcf-duplicate-sections")
/** 把"可能是一个、也可能是重复段数组"的取值读成列表（与读取方 list()/array() 同一口径）。 */
const values = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const bodyNames = (doc: any): string[] => {
  const names: string[] = []
  const walk = (item: any): void => { names.push(item.name); for (const child of values(item.body)) walk(child) }
  for (const item of values(doc.worldbody?.body)) walk(item)
  return names
}
const jointNames = (doc: any): string[] => {
  const names: string[] = []
  const walk = (item: any): void => { for (const joint of values(item.joint)) names.push(joint.name); for (const child of values(item.body)) walk(child) }
  for (const item of values(doc.worldbody?.body)) walk(item)
  return names
}
const geomList = (doc: any): any[] => {
  const geoms = [...values(doc.worldbody?.geom)]
  const walk = (item: any): void => { for (const geom of values(item.geom)) geoms.push(geom); for (const child of values(item.body)) walk(child) }
  for (const item of values(doc.worldbody?.body)) walk(item)
  return geoms
}
/** 在临时目录里写几个文件，跑完删掉。 */
async function withFiles(files: Record<string, string|Uint8Array>, run: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "lyapunov-mjcf-"))
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(base, name), content)
    await run(base)
  } finally { await rm(base, { recursive: true, force: true }) }
}
const documentOf = async (path: string): Promise<any> => (await robotVisual(path)).document as any

describe("真实原件：Unitree G1 29DOF 带手（两段 asset + 两段 worldbody）", () => {
  test("重复段归一化后网格/层级/关节与 MuJoCo 的编译读数一致，且每个 geom 引用的网格都有定义", async () => {
    const robot = await robotVisual(join(FIXTURES, "mjcf-g1/g1_29dof_with_hand.xml"))
    expect(robot.format).toBe("mjcf")
    const doc = robot.document as any
    // 归一化：读取方拿到的是单个对象，不再是把内容藏起来的数组。
    expect(Array.isArray(doc.asset)).toBe(false)
    expect(Array.isArray(doc.worldbody)).toBe(false)
    expect(doc.compiler.meshdir).toBe("meshes")
    expect(values(doc.asset.mesh).length).toBe(50)        // MuJoCo nmesh=50（第一段 asset 的网格）
    expect(values(doc.asset.texture).length).toBe(2)      // 第二段 asset 的天空盒与地面贴图
    expect(values(doc.asset.material).length).toBe(1)
    expect(values(doc.worldbody.geom).length).toBe(1)     // 第二段 worldbody 的地面
    expect(values(doc.worldbody.light).length).toBe(1)
    expect(bodyNames(doc).length).toBe(44)                // MuJoCo nbody=45（含 world）
    expect(jointNames(doc).length).toBe(44)               // MuJoCo njnt=44
    const geoms = geomList(doc)
    expect(geoms.length).toBe(104)                        // MuJoCo ngeom=104
    // "0 mesh"的判据：geom 引用的网格名必须在 asset 里有定义，且引用一个不少。
    const defined = new Set(values(doc.asset.mesh).map(mesh => mesh.name))
    const referenced = geoms.filter(geom => geom.mesh).map(geom => geom.mesh)
    expect(referenced.length).toBe(89)                    // 其余 15 个 geom 是 box/sphere/plane 等基元
    expect(referenced.filter((name: string) => !defined.has(name))).toEqual([])
  })
})

describe("include + 重复段：两侧内容都保留", () => {
  test("网格、层级、关节完整；被 include 文档的 meshdir 生效，file 引用原样不改写", async () => {
    const robot = await robotVisual(join(duplicate, "scene.xml"))
    const doc = robot.document as any
    expect(Array.isArray(doc.asset)).toBe(false)
    expect(Array.isArray(doc.worldbody)).toBe(false)
    // 场景文档自己没有 compiler，`meshdir` 来自被 include 的机器人文档（MuJoCo 实测同样生效）。
    // 丢掉它，同一批 `file="a.stl"` 就会解析到别的目录 —— 网格一个也读不出来。
    expect(doc.compiler.meshdir).toBe("meshes")
    // 段的效果按文档顺序：`<include>` 在 `scene.xml` 里排在最前，所以它的内容排在本文件写下的内容之前。
    expect(values(doc.asset.mesh).map((mesh: any) => [mesh.name, mesh.file])).toEqual([
      ["arm_link", "a.stl"],    // 被 include 文档的重复段按出现顺序
      ["tool_link", "b.stl"],
      ["table_top", "c.stl"],   // 当前文档写下的内容跟在 include 之后
    ])
    expect(values(doc.asset.texture).map((texture: any) => texture.name)).toEqual(["groundplane"])
    expect(values(doc.asset.material).map((material: any) => material.name)).toEqual(["groundplane"])
    expect(bodyNames(doc)).toEqual(["arm_base", "tool", "table"])
    expect(jointNames(doc)).toEqual(["arm_joint", "tool_joint"])
    // geomList 先取 worldbody 直属的 geom，再按 body 层级走：世界层的地面排在各 body 的 geom 之前。
    expect(geomList(doc).map((geom: any) => geom.name ?? geom.mesh)).toEqual(["floor", "arm_link", "tool_link", "table_geom"])
    expect(robot.baseUri).toBe(`file://${duplicate}/`)
    // 路径语义：`file` 保持原样，按"文档目录 + 生效 meshdir"就能落到真实文件上。
    for (const mesh of values(doc.asset.mesh)) expect(existsSync(join(duplicate, doc.compiler.meshdir, mesh.file))).toBe(true)
  })

  test("compiler 按文档顺序生效：写在 include 之后的覆盖同属性，写在之前的被 include 覆盖", async () => {
    const child = `<mujoco model="c"><compiler angle="degree" meshdir="meshes"/><worldbody><body name="arm"/></worldbody></mujoco>`
    await withFiles({
      "child.xml": child,
      // include 在 compiler 之前：父写下的 angle 覆盖子，子的 meshdir 补进来（本机 MuJoCo 实测同序）。
      "parent-after.xml": `<mujoco model="p"><include file="child.xml"/><compiler angle="radian"/><worldbody><body name="table"/></worldbody></mujoco>`,
      // compiler 在 include 之前：子的 compiler 在后，子写下的属性生效，父的 meshdir 被覆盖。
      "parent-before.xml": `<mujoco model="p"><compiler meshdir="elsewhere"/><include file="child.xml"/><worldbody><body name="table"/></worldbody></mujoco>`,
    }, async base => {
      const after = await documentOf(join(base, "parent-after.xml"))
      expect(after.compiler).toEqual({ angle: "radian", meshdir: "meshes" })
      expect(bodyNames(after)).toEqual(["arm", "table"])
      const before = await documentOf(join(base, "parent-before.xml"))
      expect(before.compiler).toEqual({ angle: "degree", meshdir: "meshes" })
    })
  })

  test("仅 asset 的 include 片段合法：父文档的 worldbody 引用它的网格", async () => {
    await withFiles({
      "child.xml": `<mujoco model="c"><asset><mesh name="tool" file="tool.stl"/></asset></mujoco>`,
      "parent.xml": `<mujoco model="p"><include file="child.xml"/><worldbody><body name="b"><geom type="mesh" mesh="tool"/></body></worldbody></mujoco>`,
      "tool.stl": "mesh-bytes",
    }, async base => {
      const doc = await documentOf(join(base, "parent.xml"))
      expect(values(doc.asset.mesh).map((mesh: any) => mesh.name)).toEqual(["tool"])
      expect(geomList(doc).map((geom: any) => geom.mesh)).toEqual(["tool"])
      expect(bodyNames(doc)).toEqual(["b"])
      // 依赖闭包也要认这个网格（否则"显示读得到、依赖找不到"）。
      expect((await parseAsset(join(base, "parent.xml"))).dependencies.map(stamp => stamp.path.split("/").pop()).sort()).toEqual(["child.xml", "parent.xml", "tool.stl"])
    })
  })

  test("仅 worldbody 的 include 片段合法：父文档的平面与它的机器人都在", async () => {
    await withFiles({
      "child.xml": `<mujoco model="c"><worldbody><body name="arm"><geom name="arm_geom" type="box" size="0.1 0.1 0.1"/></body></worldbody></mujoco>`,
      "parent.xml": `<mujoco model="p"><include file="child.xml"/><worldbody><geom name="floor" type="plane" size="0 0 0.05"/></worldbody></mujoco>`,
    }, async base => {
      const doc = await documentOf(join(base, "parent.xml"))
      expect(bodyNames(doc)).toEqual(["arm"])
      expect(geomList(doc).map((geom: any) => geom.name)).toEqual(["floor", "arm_geom"])
    })
  })

  test("片段根（如 <mujocoinclude>）按根元素的子元素取段", async () => {
    // MuJoCo 展开 include 时只看根的孩子，本机 3.12.0 实测 `<mujocoinclude>` 包裹根可用。
    await withFiles({
      "child.xml": `<mujocoinclude><worldbody><body name="arm"/></worldbody></mujocoinclude>`,
      "parent.xml": `<mujoco model="p"><include file="child.xml"/><worldbody><body name="table"/></worldbody></mujoco>`,
    }, async base => expect(bodyNames(await documentOf(join(base, "parent.xml")))).toEqual(["arm", "table"]))
  })

  test("多个 <default class> 的类边界保留（不并成一个默认类）", async () => {
    await withFiles({
      "scene.xml": `<mujoco model="d">
  <default><default class="a"><geom type="sphere" size="0.2"/></default></default>
  <default><default class="b"><geom type="box" size="0.4 0.4 0.4"/></default></default>
  <worldbody><body name="b1"><geom name="g1" class="a"/></body><body name="b2"><geom name="g2" class="b"/></body></worldbody>
</mujoco>`,
    }, async base => {
      const doc = await documentOf(join(base, "scene.xml"))
      const classes = values(doc.default).map(section => values(section.default).map((item: any) => [item.class, item.geom.type]))
      expect(classes).toEqual([[["a", "sphere"]], [["b", "box"]]])
    })
  })

  test("依赖闭包覆盖重复段与 include 里的全部网格（parseAsset）", async () => {
    const parsed = await parseAsset(join(duplicate, "scene.xml"))
    expect(parsed.kind).toBe("robot")
    expect(parsed.dependencies.map(stamp => stamp.path.split("/").pop()).sort()).toEqual(["a.stl", "b.stl", "c.stl", "robot.xml", "scene.xml"])
  })
})

/**
 * 夹具 `fixtures/mjcf-include-fragments/`：带 XML 声明的主文档、夹在两段 `<compiler>` 之间的 include、
 * 仅有 `<asset>` 的片段（包裹根 `<mujocoinclude>`）、仅有 `<worldbody>` 的片段。期望值来自本机
 * MuJoCo 3.12.0 对同一份夹具的编译读数：nmesh=2、nbody=3（world 之外 arm／table）、njnt=1、ngeom=3；
 * 关节 `range="0 90"` 编译后是 90（没换算成弧度）——即 include 之后那段 `<compiler angle="radian">`
 * 生效，而网格都按它写下的 `meshdir="meshes"` 找到。
 */
describe("XML 声明、交错的 include/compiler、仅 asset 的片段", () => {
  const fragments = join(FIXTURES, "mjcf-include-fragments")

  test("声明不当正文、段按出现顺序合并、compiler 按最后一次写下的属性生效", async () => {
    const doc = await documentOf(join(fragments, "scene.xml"))
    expect(doc.compiler).toEqual({ angle: "radian", meshdir: "meshes" })
    expect(values(doc.asset.mesh).map((mesh: any) => [mesh.name, mesh.file])).toEqual([["arm_link", "a.stl"], ["table_top", "c.stl"]])
    expect(bodyNames(doc)).toEqual(["arm", "table"])
    expect(jointNames(doc)).toEqual(["arm_joint"])
    expect(geomList(doc).map((geom: any) => geom.name)).toEqual(["floor", "arm_geom", "table_geom"])
  })

  test("父 compiler 的 meshdir 让仅 asset 片段的网格在依赖闭包与显示侧落到同一位置（parseAsset 正例）", async () => {
    // 片段自己没有 compiler：少了"生效 meshdir"，`file="a.stl"` 会解析到夹具根目录而找不到，
    // 依赖闭包报缺件、显示侧却读得到 —— 两边必须是同一份。
    const parsed = await parseAsset(join(fragments, "scene.xml"))
    expect(parsed.dependencies.map(stamp => stamp.path).sort()).toEqual([
      join(fragments, "scene.xml"),
      join(fragments, "asset-fragment.xml"),
      join(fragments, "body-fragment.xml"),
      join(fragments, "meshes", "a.stl"),
      join(fragments, "meshes", "c.stl"),
    ].sort())
  })
})

/**
 * 跨目录 include：子文档在 `kid/`，父写下的 `<compiler meshdir="meshes"/>` 对它同样生效。
 * 本机 MuJoCo 3.12.0 实测（`checks/mjcf_probe3/probe_priority2.py`）：被 include 文件里的 `file`
 * **先按主文档目录找**（`meshdir/file`），找不到才按 `meshdir/<子文件所在目录>/file` 找，两者都在时
 * 读前者。两份夹具各盖一种情形；错候选位置放的是顶点数不同的几何，解析错就会落到另一份文件上。
 */
describe("跨目录 include：资产引用按 MuJoCo 的查找顺序落位", () => {
  const subdir = join(FIXTURES, "mjcf-include-subdir")
  const primary = join(FIXTURES, "mjcf-include-subdir-primary")
  const meshFiles = (doc: any): [string, string][] => values(doc.asset.mesh).map((mesh: any) => [mesh.name, mesh.file])
  /** 显示侧/依赖侧解析出来的那个文件，必须与夹具里"应该被读"的那份字节相同。 */
  const resolved = (dir: string, doc: any, file: string): Buffer => readFileSync(join(dir, doc.compiler.meshdir ?? "", file))

  test("子网格只在子目录下：落位到后备位置，错候选位置的几何不进来", async () => {
    const scene = join(subdir, "scene.xml")
    const doc = await documentOf(scene)
    expect(doc.compiler.meshdir).toBe("meshes")
    // 父自己的引用原样；子文档的 `arm.stl` 落位到 `kid/`（主文档目录下 `meshes/arm.stl` 不存在）。
    expect(meshFiles(doc)).toEqual([["arm_link", "kid/arm.stl"], ["table_top", "table.stl"]])
    expect(bodyNames(doc)).toEqual(["arm", "table"])
    expect(geomList(doc).map((geom: any) => geom.name)).toEqual(["floor", "arm_geom", "table_geom"])
    // 几何对得上：`meshes/kid/arm.stl` 是四面体（284B），`kid/arm.stl`、`kid/meshes/arm.stl`
    // 这两个错候选位置放的是立方体（684B）。
    expect(resolved(subdir, doc, "kid/arm.stl").equals(readFileSync(join(subdir, "meshes/kid/arm.stl")))).toBe(true)
    expect(resolved(subdir, doc, "kid/arm.stl").equals(readFileSync(join(subdir, "kid/arm.stl")))).toBe(false)
    expect((await parseAsset(scene)).dependencies.map(stamp => stamp.path).sort()).toEqual([
      join(subdir, "scene.xml"), join(subdir, "kid/robot.xml"),
      join(subdir, "meshes/table.stl"), join(subdir, "meshes/kid/arm.stl"),
    ].sort())
  })

  test("两个候选都在时读主文档目录下那份（MuJoCo 实测的优先序）", async () => {
    const scene = join(primary, "scene.xml")
    const doc = await documentOf(scene)
    expect(meshFiles(doc)).toEqual([["arm_link", "arm.stl"], ["table_top", "table.stl"]])
    // 后备位置的 `meshes/kid/arm.stl`（四面体 284B）存在，但主文档目录下那份（立方体 684B）优先。
    expect(resolved(primary, doc, "arm.stl").equals(readFileSync(join(primary, "meshes/arm.stl")))).toBe(true)
    expect(resolved(primary, doc, "arm.stl").equals(readFileSync(join(primary, "meshes/kid/arm.stl")))).toBe(false)
    expect((await parseAsset(scene)).dependencies.map(stamp => stamp.path).sort()).toEqual([
      join(primary, "scene.xml"), join(primary, "kid/robot.xml"),
      join(primary, "meshes/table.stl"), join(primary, "meshes/arm.stl"),
    ].sort())
  })
})

describe("无效文档不静默", () => {
  test("主文档不是 <mujoco> 根时明确报错", async () => {
    await withFiles({ "fragment.xml": `<worldbody><body name="b"/></worldbody>` }, async base => {
      await expect(robotVisual(join(base, "fragment.xml"))).rejects.toThrow(/INVALID_MJCF/)
    })
  })

  test("仅 asset 的主文档合法：不报错，asset 完整，画不出东西由 Viewer 的警告负责", async () => {
    await withFiles({
      "asset-only.xml": `<mujoco model="x"><asset><mesh name="m" file="m.stl"/></asset></mujoco>`,
      "m.stl": "mesh-bytes",
    }, async base => {
      // MuJoCo 3.12.0 实测能编译这份文档（nmesh=1、nbody=1），只是没有可显示的内容。
      const doc = await documentOf(join(base, "asset-only.xml"))
      expect(values(doc.asset.mesh).map((mesh: any) => mesh.name)).toEqual(["m"])
      expect(doc.worldbody).toBeUndefined()
    })
  })

  test("被 include 的不是 MJCF（URDF）时明确报错", async () => {
    await withFiles({
      "robot.urdf": `<robot name="r"><link name="l"/></robot>`,
      "includes-urdf.xml": `<mujoco model="x"><include file="robot.urdf"/><worldbody><body name="b"/></worldbody></mujoco>`,
    }, async base => await expect(robotVisual(join(base, "includes-urdf.xml"))).rejects.toThrow(/ROBOT_INCLUDE_NOT_MJCF/))
  })

  test("循环 include 明确报错", async () => {
    await withFiles({
      "a.xml": `<mujoco model="a"><include file="b.xml"/><worldbody><body name="ba"/></worldbody></mujoco>`,
      "b.xml": `<mujoco model="b"><include file="a.xml"/><worldbody><body name="bb"/></worldbody></mujoco>`,
    }, async base => await expect(robotVisual(join(base, "a.xml"))).rejects.toThrow(/ROBOT_INCLUDE_CYCLE/))
  })
})


describe('原MJCF官方参考姿态bounds，不以Viewer或派生碰撞猜范围',()=>{
  test('include/default/mesh非均匀scale/多层rotation/geom偏移和joint ref由原编译器一致消费',async()=>{
    const vertices=[[0,0,0],[2,0,0],[0,3,0],[0,0,4]],faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]]
    const stl=Buffer.alloc(84+faces.length*50);stl.writeUInt32LE(faces.length,80);for(const[i,face]of faces.entries())for(const[j,id]of face.entries())for(const[k,value]of vertices[id]!.entries())stl.writeFloatLE(value,84+i*50+12+j*12+k*4)
    await withFiles({
      'original.stl':stl,
      'part.xml':'<mujocoinclude><default><default class="part"><mesh scale="2 3 4"/><geom type="mesh"/></default></default><asset><mesh name="original" class="part" file="original.stl"/></asset><worldbody><body name="parent" pos="1 2 3" euler="0 0 90"><body name="child" pos="4 0 0" euler="90 0 0" childclass="part"><joint name="j" type="hinge" axis="1 0 0" ref="30"/><geom mesh="original" pos="0 5 0"/></body></body></worldbody></mujocoinclude>',
      'main.xml':'<mujoco><compiler angle="degree"/><include file="part.xml"/><worldbody><geom type="plane" size="0 0 .1"/></worldbody></mujoco>',
    },async dir=>{
      const parsed=await parseAsset(join(dir,'main.xml')),box=parsed.metadata.aabb as {min:number[];max:number[]}
      expect(box,JSON.stringify(parsed.metadata.boundsFacts)).toBeDefined()
      // 源四顶点经scale与声明矩阵：child世界原点[1,6,3]，geom原点[1,6,8]，合成旋转(x,y,z)→(z,x,y)。
      for(const[i,value]of [1,6,8].entries())expect(box.min[i]).toBeCloseTo(value,5)
      for(const[i,value]of [17,10,17].entries())expect(box.max[i]).toBeCloseTo(value,5)
      expect(parsed.metadata.boundsFacts).toMatchObject({status:'available',source:'mjcf-original-geometries',pose:'source-reference-qpos0',simulationSteps:0,dynamicPoseEvaluated:false,meshCount:1,geomCount:1,dependencyHashesVerified:true})
      expect(parsed.dependencies.map(d=>d.path)).toContain(join(dir,'part.xml'))
      expect(readFileSync(join(dir,'original.stl'))).toEqual(stl)
    })
  },15000)
})
