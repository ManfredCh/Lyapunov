/**
 * DEV-034 行为测试：**MJCF 纹理真的进画面** + **自动取景不被巨大地面/隐藏碰撞几何拉远**。
 *
 * 两个缺陷的源码位置（改前）：
 *  · 纹理：`robot.ts` 的 `material(rgba?)` 只建基色，geom/material 上的 `texture` 从未被读取 → 包装/地板
 *    在原生 Viewer 里退化成纯色；
 *  · 取景：`framing.ts` 的 `objectWorldBounds()` 用 `Box3().setFromObject(root)` 把**一切**算进包围盒，
 *    包括 MJCF 的无限地面与 `visible=false` 的碰撞层 → 相机被拉到很远处，任务主体缩成小点。
 *
 * 本文件钉住修好后的行为，判据全部来自**真实 three 对象**（真实 Texture/几何/矩阵），不是回显字符串：
 *  ① 几何引用的 material→texture 真的挂到 `MeshStandardMaterial.map`，texrepeat 生效，colorspace 按声明；
 *  ② `texuniform=true` 时按图元尺寸把重复烘进 UV（repeat 留 1），并覆盖 plane/box 两种图元；
 *  ③ 没有 `file` 的纹理（MJCF `builtin`）与取图失败**明确回落**：材质仍是基色、产生真实 warning，不静默；
 *  ④ `objectWorldBounds(root, splat, autoFrame=true)` 只覆盖**可见有限几何**：1000 m 地面与
 *     `visible=false` 的碰撞网格都不进包围盒；`autoFrame=false`（非取景用途）仍旧算全部。
 *
 * 环境说明：Bun 没有 DOM，three 的 `TextureLoader` 走 `ImageLoader`（`document.createElementNS('img')`）。
 * 下面补一个**只做加载握手**的 `<img>` 垫片：真的走 three 的 loader/缓存/colorSpace/wrap 代码路径，但图像解码
 * 由垫片代替（本测试证明的是"纹理被读取并正确接线"，不是 PNG 解码质量）。同一手法见 `robot-visual.test.ts`
 * 对 `ProgressEvent` 的垫片。
 *
 * 运行：`bun test packages/viewer/test/texture-and-autoframe.test.ts`
 */
import { describe, expect, test } from "bun:test"
import * as THREE from "three"

import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"
import { objectWorldBounds, subjectEntityIds } from "../src/framing.ts"

/** 2×2 PNG（红/蓝对角），真实字节，走 data URL。 */
const PNG_2X2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFUlEQVR4nAXBAQEAAACAEP9PF4JQDBvyA/3bepXKAAAAAElFTkSuQmCC"

/** 真实 ASCII STL（三角面片；网格分支要走真 `STLLoader`，同 `robot-visual.test.ts` 用真夹具字节的意图）。 */
const STL_TRIANGLE = `solid s
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid s
`

/** Bun 没有 `ProgressEvent`，three 的 `FileLoader` 收到字节时会 `new` 它（同 `robot-visual.test.ts`）。 */
class ProgressEventShim extends Event {
  lengthComputable = false
  loaded = 0
  total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}
;(globalThis as any).ProgressEvent ??= ProgressEventShim

/** 只做加载握手的 `<img>`：`src` 一设就异步触发 load（three 的 ImageLoader 依赖这两个事件）。 */
function installImageShim(): void {
  const global = globalThis as any
  global.document ??= {
    createElementNS: () => {
      const listeners: Record<string, Array<() => void>> = {}
      const image: any = {
        width: 2, height: 2, naturalWidth: 2, naturalHeight: 2,
        addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn) },
        removeEventListener: () => undefined,
        set src(_value: string) { queueMicrotask(() => { for (const fn of listeners.load ?? []) fn() }) },
      }
      return image
    },
  }
}
installImageShim()

const textureURI = (uri: string): string => uri.endsWith(".png") ? `data:image/png;base64,${PNG_2X2}` : uri
/** 网格与贴图一起服务：`.stl` 交真实 STL 字节，`.png` 交真实 PNG 字节。 */
const assetURI = (uri: string): string => uri.endsWith(".stl") ? `data:model/stl;base64,${Buffer.from(STL_TRIANGLE).toString("base64")}` : textureURI(uri)

/** 收集 `MeshStandardMaterial`（几何与它引用的贴图都在同一份材质上）。 */
function materials(visual: RobotVisual): THREE.MeshStandardMaterial[] {
  const found: THREE.MeshStandardMaterial[] = []
  visual.root.traverse(object => { if (object instanceof THREE.Mesh) { const material = object.material as THREE.MeshStandardMaterial; if (material?.isMeshStandardMaterial) found.push(material) } })
  return found
}

const mjcfDocument = (texture: Record<string, unknown>, material: Record<string, unknown>, geom: Record<string, unknown>) => ({
  format: "mjcf", baseUri: "file:///robot/",
  document: {
    compiler: { angle: "radian" },
    asset: { texture: { name: "check", ...texture }, material: { name: "checkmat", texture: "check", ...material } },
    worldbody: { geom: { type: "box", size: ".1 .1 .1", material: "checkmat", ...geom } },
  },
})

/** 与真投影文档**同形**的 mesh 图元：引用一个材质、图元自己是 `0.5 0.5 0.5 1` 占位灰。
 *  真文档里机器人 50 个带材质图元中 21 个就是「材质没写 rgba、没有贴图」这个形状（验收报告 C1），
 *  `meshDocument({}, {})` 就是其中 `robot0_g7_vis` 那一格的最小复现。 */
const meshDocument = (material: Record<string, unknown>, geom: Record<string, unknown>) => ({
  format: "mjcf", baseUri: "file:///robot/",
  document: {
    compiler: { angle: "radian" },
    asset: {
      mesh: { name: "link0_vis_7", file: "link0_vis_7.stl" },
      material: { name: "robot0_Part__Feature018_001", ...material },
    },
    worldbody: { geom: { name: "robot0_g7_vis", type: "mesh", mesh: "link0_vis_7", material: "robot0_Part__Feature018_001", rgba: "0.5 0.5 0.5 1", ...geom } },
  },
})

/** 无 material 的 mesh 图元（真文档里 65 个图元有 15 个是这个形状，例如 `robot0_link0_collision`）。 */
const meshWithoutMaterial = (geom: Record<string, unknown>) => ({
  format: "mjcf", baseUri: "file:///robot/",
  document: {
    compiler: { angle: "radian" },
    asset: { mesh: { name: "link0", file: "link0.stl" } },
    worldbody: { geom: { name: "robot0_link0_collision", type: "mesh", mesh: "link0", ...geom } },
  },
})

describe("DEV-034 纹理：MJCF texture 真的进材质", () => {
  test("texture→material 被读取：map 挂在网格材质上，texrepeat 生效，colorspace 按声明", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png", colorspace: "linear" }, { texrepeat: "2 3" }, {}) as any,
      textureURI,
    )
    const [material] = materials(visual)
    expect(material).toBeDefined()
    expect(material!.map).not.toBeNull()
    expect(material!.map!.repeat.x).toBe(2)
    expect(material!.map!.repeat.y).toBe(3)
    // 声明的 linear 必须真的落到 three 的 colorSpace 上：sRGB 与 linear 会给同一张图不同的采样值。
    expect(material!.map!.colorSpace).toBe(THREE.LinearSRGBColorSpace)
    expect(material!.map!.wrapS).toBe(THREE.RepeatWrapping)
    expect(material!.map!.wrapT).toBe(THREE.RepeatWrapping)
    expect(visual.warnings).toEqual([])
  })

  test("未声明 colorspace 按 sRGB（PNG albedo 的常规），与声明的 linear 可区分", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png" }, {}, {}) as any,
      textureURI,
    )
    expect(materials(visual)[0]!.map!.colorSpace).toBe(THREE.SRGBColorSpace)
  })

  test("texuniform=true：重复按图元尺寸烘进 UV（repeat 留 1），plane 与 box 都覆盖", async () => {
    const plane = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png" }, { texuniform: "true", texrepeat: "1 1" }, { type: "plane", size: "1.5 2.5 .1" }) as any,
      textureURI,
    )
    const planeMaterial = materials(plane)[0]!
    // plane 的 UV 覆盖整张面：repeat = 面边长 × texrepeat，且不再二次乘 repeat。
    expect(planeMaterial.map!.repeat.x).toBeCloseTo(3, 6)
    expect(planeMaterial.map!.repeat.y).toBeCloseTo(5, 6)

    const box = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png" }, { texuniform: "true", texrepeat: "1 1" }, {}) as any,
      textureURI,
    )
    const boxMaterial = materials(box)[0]!
    expect(boxMaterial.map!.repeat.x).toBe(1)
    expect(boxMaterial.map!.repeat.y).toBe(1)
    const uv = (boxMaterial.map, (() => { let found: THREE.BufferAttribute | undefined; box.root.traverse(o => { const m = o as THREE.Mesh; if (!found && m.isMesh) found = (m.geometry as THREE.BufferGeometry).getAttribute("uv") as THREE.BufferAttribute }); return found })())!
    // box 每面 4 顶点：u 方向的边长 0.2 m（size 0.1 的直径）→ UV 已按面尺寸放大，不再是 0..1。
    const spread = Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getX(i))) - Math.min(...Array.from({ length: uv.count }, (_, i) => uv.getX(i)))
    expect(spread).toBeCloseTo(0.2 * 1, 6)
  })

  test("没有 file 的纹理（builtin）明确回落：无 map、不冒充图案，基色按材质色", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", builtin: "checker" }, {}, {}) as any,
      textureURI,
    )
    const [material] = materials(visual)
    expect(material!.map ?? null).toBeNull()
    // ⚠️ 本条在 MATERIAL-COLOR-REMAINING 里换了期望值：改前钉的是 `material()` 的**缺省蓝灰**
    // （0.36/0.58/0.8），那是"谁都没给 rgba"时的兜底色，被误用在了**引用了 material** 的图元上。
    // 官方此时用的是材质色（材质未声明 rgba ⇒ 编译默认白）——与有没有贴图无关。
    expect(material!.color.getHex()).toBe(0xffffff)
  })

  test("取图失败不静默：几何照旧可见，warning 记录失败，外观退回材质色", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "missing.png" }, {}, {}) as any,
      () => { throw new Error("MESH_ASSET_MISSING: missing.png") },
    )
    expect(materials(visual).length).toBe(1)
    expect(materials(visual)[0]!.map ?? null).toBeNull()
    expect(visual.warnings.join("|")).toContain("missing.png")
    // ⚠️ 期望值同样是本轮换的（改前 0.36/0.58/0.8）：拿不到图**不能**把基色也一起丢掉 ——
    // 基色是材质色（材质未声明 rgba ⇒ 白），不是图元的占位灰、也不是 Viewer 的兜底蓝灰。
    expect(materials(visual)[0]!.color.getHex()).toBe(0xffffff)
  })

  /** 官方 3.2.3 实测（回执 `DEV034-VIEWER-TEXTURE-20260926` 的"官方语义"节，脚本
   * `.runtime/lane-p1-viewer/official_rgba_ablation2.py`）：把官方世界里 14 个带纹理图元的
   * `geom_rgba` 从 0.5 改到 1.0，agentview **逐像素 0 变化**；把它们的 `mat_rgba` 改到 0.5，
   * **93.7% 像素变化、mean|Δ| 55.7**（均值 140 → 77）。⇒ 带纹理时官方用**材质色**调制贴图，
   * 图元那个 0.5 是编译占位灰，不参与。下面三条钉住这个口径（第 1 条正是原缺陷）。 */
  test("材质带纹理但没写 rgba ⇒ 调制色是材质默认白（不是图元的 0.5 占位灰）", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png" }, {}, { rgba: "0.5 0.5 0.5 1" }) as any,
      textureURI,
    )
    const [material] = materials(visual)
    expect(material!.map).not.toBeNull()
    // 照 geom.rgba（0.5 灰）走会把整场贴图压暗一半 —— 官方不是这样。
    expect(material!.color.getHex()).toBe(0xffffff)
  })

  test("材质显式声明 rgba ⇒ 按材质色调制（图元自己的 rgba 不参与）", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "checker.png" }, { rgba: "1 0 0 1" }, { rgba: "0.5 0.5 0.5 1" }) as any,
      textureURI,
    )
    expect(materials(visual)[0]!.map).not.toBeNull()
    expect(materials(visual)[0]!.color.getHex()).toBe(new THREE.Color(1, 0, 0).getHex())
  })

  /** 本轮口径（`bugfixHistory/VERIFY-P1-VIEWER-TEXTURE-20260926.md` C1 + §6.2 的官方有效色规则）：
   * **引用了 material 就用材质色**（材质未声明 rgba ⇒ 官方编译默认值**白 `1 1 1 1`**）；
   * **只有完全没引用 material 的图元**才走 `geom.rgba`。与贴图有没有挂上无关。
   *
   * 真文档读数（真 `buildRobotVisual` + 真投影 scene 文档 + MuJoCo 3.2.3 `mjvGeom.rgba`）：
   * 机器人 65 个图元 = 29 个「材质声明了 rgba」+ **21 个「材质没写 rgba 又没贴图」** + 15 个「无 material」；
   * 改前那 21 个读数是 `0.5 灰`、官方是白（抽样 `robot0_g7_vis`/`g8_vis`/`g11_vis` 三格逐位对上），
   * 改后 65/65 与官方有效色一致（读数见 `MATERIAL-COLOR-REMAINING-20260926.md` §3）。 */
  test("材质未声明 rgba 且没有贴图（机器人 21 个图元的形状）⇒ 调制色是材质默认白，不是图元 0.5 占位灰", async () => {
    const visual = await buildRobotVisual(meshDocument({}, {}) as any, assetURI)
    const [material] = materials(visual)
    expect(material!.map ?? null).toBeNull()          // 这条路上根本没有贴图可挂
    expect(material!.color.getHex()).toBe(0xffffff)   // 官方 `mjvGeom.rgba`（robot0_g7_vis）= [1,1,1,1]
  })

  test("无 material 的 mesh 图元 ⇒ 仍用图元自己的 geom.rgba（口径的另一半：不是一律白）", async () => {
    const visual = await buildRobotVisual(meshWithoutMaterial({ rgba: "0 0.5 0 1" }) as any, assetURI)
    expect(materials(visual)[0]!.color.getHex()).toBe(new THREE.Color(0, 0.5, 0).getHex())
  })

  test("无 material 的基元（plane/box）⇒ 也走 geom.rgba（图元分支同口径）", async () => {
    const visual = await buildRobotVisual(
      { format: "mjcf", baseUri: "file:///robot/", document: { compiler: { angle: "radian" }, worldbody: { geom: { name: "floor", type: "plane", size: "1 1 .1", rgba: "0.2 0.2 0.2 1" } } } } as any,
      textureURI,
    )
    expect(materials(visual)[0]!.color.getHex()).toBe(new THREE.Color(0.2, 0.2, 0.2).getHex())
  })

  test("无 material 且图元也没声明 rgba ⇒ 仍回落 Viewer 缺省色（不许把没有依据的东西画成纯白）", async () => {
    const visual = await buildRobotVisual(meshWithoutMaterial({}) as any, assetURI)
    expect(materials(visual)[0]!.color.getHex()).toBe(new THREE.Color(0.36, 0.58, 0.8).getHex())
  })

  test("基元分支：plane 引用未声明 rgba 的材质且没有贴图（缺纹理地板的形状）⇒ 白，不是 0.5 占位灰", async () => {
    const visual = await buildRobotVisual(
      { format: "mjcf", baseUri: "file:///robot/", document: { compiler: { angle: "radian" }, asset: { material: { name: "floorplane", texuniform: "true", texrepeat: "3 3" } }, worldbody: { geom: { name: "floor", type: "plane", size: "3 3 .1", material: "floorplane", rgba: "0.5 0.5 0.5 1" } } } } as any,
      textureURI,
    )
    expect(materials(visual)[0]!.color.getHex()).toBe(0xffffff)
  })

  test("贴图没挂上（builtin）不改变材质色口径：材质未声明 rgba ⇒ 白，图元的 0.4 不参与", async () => {
    // ⚠️ 本条**替换**了 P1 原用例「负对照：材质没写 rgba 且贴图没挂上 ⇒ 仍按图元 rgba（0.4）」：
    // 那条钉的正是验收报告 C1 判为错的行为（官方此时用的仍是材质色，与有没有贴图无关）。
    // 断言强度没有降低（仍是"某一个确定颜色"），只是期望值换到了官方口径上。
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", builtin: "checker" }, {}, { rgba: "0.4 0.4 0.4 1" }) as any,
      textureURI,
    )
    expect(materials(visual)[0]!.map ?? null).toBeNull()
    expect(materials(visual)[0]!.color.getHex()).toBe(0xffffff)
  })

  /** 缺纹理这条路必须**可归因**：three 的 `ImageLoader` 在真实浏览器里 reject 的是 `error` 事件对象
   * （`String(event)` = `"[object Event]"`；原生 Viewer 实测还遇到过字面量 `"undefined"`）。采集回执
   * 里的 `visualWarnings` 若只剩这种串，等于没说——所以警告的主语是**材质引用的文档引用串**。 */
  test("缺纹理：warning 指名道姓（TEXTURE_LOAD_FAILED + 引用串），不是 String(事件)", async () => {
    const visual = await buildRobotVisual(
      mjcfDocument({ type: "2d", file: "missing.png" }, {}, {}) as any,
      () => Promise.reject(undefined),
    )
    const warning = visual.warnings.find(text => text.startsWith("TEXTURE_LOAD_FAILED"))
    expect(warning).toBeDefined()
    expect(warning!).toContain("missing.png")
    expect(visual.warnings.includes("undefined")).toBe(false)
    expect(visual.warnings.some(text => text.includes("[object Event]"))).toBe(false)
  })
})

describe("DEV-034 自动取景：只覆盖可见有限几何", () => {
  /** 主体（0.2 m 盒）+ 1000 m 地面 + 远处 `visible=false` 的碰撞网格。 */
  function scene(): { root: THREE.Group; subject: THREE.Mesh; ground: THREE.Mesh; hidden: THREE.Mesh } {
    const root = new THREE.Group()
    const subject = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial())
    subject.name = "subject"
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshStandardMaterial())
    ground.name = "ground"
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50), new THREE.MeshStandardMaterial())
    hidden.name = "hidden-collision"
    hidden.position.set(80, 0, 0)
    hidden.visible = false
    root.add(subject, ground, hidden)
    root.updateMatrixWorld(true)
    return { root, subject, ground, hidden }
  }

  test("autoFrame=true：1000 m 地面与隐藏碰撞网格都不进包围盒，主体尺寸不被拉大", () => {
    const { root } = scene()
    const box = objectWorldBounds(root, new WeakMap(), true)
    const size = box.getSize(new THREE.Vector3())
    // 主体 0.2 m；地面若被算入这里会是 1000，隐藏盒会到 130 以上。
    expect(size.x).toBeCloseTo(0.2, 6)
    expect(size.y).toBeCloseTo(0.2, 6)
    expect(size.z).toBeCloseTo(0.2, 6)
  })

  test("autoFrame=false（非取景用途）仍算全部几何：地面与隐藏层都在，语义未被改掉", () => {
    const { root } = scene()
    const size = objectWorldBounds(root, new WeakMap(), false).getSize(new THREE.Vector3())
    // 地面是 XY 平面：x/y 被 1000 m 地面撑开；z 只有那个 50 m 的隐藏碰撞盒（autoFrame=true 时它是 0.2）。
    expect(size.x).toBeGreaterThanOrEqual(1000)
    expect(size.y).toBeGreaterThanOrEqual(1000)
    expect(size.z).toBeCloseTo(50, 6)
  })

  /** N252 真机复现：官方 LIBERO 世界的 6 面墙是**可见**盒（2.12×3.0 / 3.5×3.0 / 6.0×3.0 m，`group=1`），
   * 地板是无限 `plane`（已被 PlaneGeometry 分支排除）⇒ 旧逻辑把 3–6 m 的墙算进包围盒，相机被拉到十几米外，
   * 5 cm 的任务主体只剩 1–2 px（默认机位 0 饱和像素）。 */
  function wallScene(): { root: THREE.Group; subject: THREE.Mesh; wall: THREE.Mesh } {
    const root = new THREE.Group()
    const subject = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.065), new THREE.MeshStandardMaterial())
    subject.name = "alphabet_soup_1"
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2.12, 3, 0.02), new THREE.MeshStandardMaterial())
    wall.name = "wall_leftcorner_visual"
    wall.position.set(-1.25, 2.25, 1.5)
    wall.rotation.z = Math.PI / 4
    root.add(subject, wall)
    root.updateMatrixWorld(true)
    return { root, subject, wall }
  }

  test("autoFrame=true：3 m 的可见墙盒不进包围盒，5 cm 主体不被拉远（N252 新增）", () => {
    const { root } = wallScene()
    const size = objectWorldBounds(root, new WeakMap(), true).getSize(new THREE.Vector3())
    // 墙若被算入，x/y 会到 3 米量级（旋转后更大）；这里必须只剩主体。
    expect(size.x).toBeCloseTo(0.05, 6)
    expect(size.y).toBeCloseTo(0.05, 6)
    expect(size.z).toBeCloseTo(0.065, 6)
  })

  test("负对照：autoFrame=false 仍算可见墙盒（非取景用途语义未被改掉）", () => {
    const { root } = wallScene()
    const size = objectWorldBounds(root, new WeakMap(), false).getSize(new THREE.Vector3())
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(2)
  })

  test("兜底：整场都是超大几何时不产生空包围盒（退回未过滤结果，避免 frameBounds 直接不取景）", () => {
    const root = new THREE.Group()
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.02), new THREE.MeshStandardMaterial())
    wall.name = "wall_front_visual"
    wall.position.set(3, 0, 1.5)
    root.add(wall)
    root.updateMatrixWorld(true)
    const box = objectWorldBounds(root, new WeakMap(), true)
    expect(box.isEmpty()).toBe(false)
    expect(box.getSize(new THREE.Vector3()).x).toBeGreaterThan(2)
  })

  /** DEV-034 R19 真机归因：单个"整组都是超大几何"的实体（官方 `official-worldbody` = 6 面墙，组内 max 6.02 m）
   * 会把组内兜底的 6 m 包围盒漏进**多实体并集** ⇒ 相机又回到 17 m、主体 1–2 px。
   * 并集路径必须能显式关掉兜底（`allowOversizedFallback=false`），让超大实体贡献空盒。 */
  test("并集取景：allowOversizedFallback=false 时超大实体贡献空盒（R19 新增）", () => {
    const root = new THREE.Group()
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.02), new THREE.MeshStandardMaterial())
    root.add(wall)
    root.updateMatrixWorld(true)
    expect(objectWorldBounds(root, new WeakMap(), true, false).isEmpty()).toBe(true)
    // 负对照：默认（单实体取景）仍退回未过滤结果，不会"不取景"。
    expect(objectWorldBounds(root, new WeakMap(), true).isEmpty()).toBe(false)
  })

  test("并集取景：超大实体 + 主体小盒 ⇒ 只留小盒（R19 新增）", () => {
    const root = new THREE.Group()
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.09), new THREE.MeshStandardMaterial())
    can.name = "alphabet_soup_1"
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.02), new THREE.MeshStandardMaterial())
    wall.name = "official-worldbody"
    root.add(can, wall)
    root.updateMatrixWorld(true)
    const size = objectWorldBounds(root, new WeakMap(), true, false).getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(0.065, 6)
    expect(size.z).toBeCloseTo(0.09, 6)
  })

  /** DEV-034 R19：默认取景要"面向任务主体"。官方 LIBERO 投影里机器人是**唯一**带 `articulation` 的实体
   * （真机文档：`official-robot` 的 components = `['visual','articulation','mujoco']`，floor/物体只有
   * `['visual','mujoco']`）⇒ 主体集合 = 去掉 articulation 实体；拿不到集合时返回 undefined（退回全部实体）。 */
  test("subjectEntityIds：排除 articulation 实体（机器人），保留其余（R19 新增）", () => {
    const entities = [
      { entityId: "official-worldbody" },
      { entityId: "official-robot", components: { visual: {}, articulation: {}, mujoco: {} } },
      { entityId: "floor" },
      { entityId: "alphabet_soup_1" },
      { entityId: "basket_1" },
    ]
    const subject = subjectEntityIds(entities)
    expect(subject).toBeDefined()
    expect([...subject!].sort()).toEqual(["alphabet_soup_1", "basket_1", "floor", "official-worldbody"])
    expect(subject!.has("official-robot")).toBe(false)
  })

  test("subjectEntityIds 负对照：空列表/全是 articulation ⇒ undefined（调用方退回全部实体）", () => {
    expect(subjectEntityIds([])).toBeUndefined()
    expect(subjectEntityIds(undefined)).toBeUndefined()
    expect(subjectEntityIds([{ entityId: "r1", components: { articulation: {} } }, { entityId: "r2", components: { articulation: {} } }])).toBeUndefined()
  })

  test("subjectEntityIds 负对照：没有任何 components 的实体全部算主体（非官方场景行为不变）", () => {
    const subject = subjectEntityIds([{ entityId: "a" }, { entityId: "b" }])
    expect([...subject!].sort()).toEqual(["a", "b"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 接线层与 asset-locator：配对判据**只有一份**
//
// 背景：P3 的接线层（`packages/lyapunov-shell/src/workbench.tsx` 的 `assetLocatorTokens`）与
// `viewer/src/asset-locator.ts` 的 `pairDocumentAssets` 曾是**逐字判据的两份实现**（条数 + 段位
// mimeType 形状 + `document.asset.<段>[i].file` 与 `components.mujoco.<meshes|textures>[i].file`
// 逐字相等）。这一类"同一份事实存两处"正是本轮的固定靶：两份实现一旦漂移，接线层就会按一套
// 判据改写、Viewer 按另一套读回。
//
// 本块把"只有一份"钉成**可执行**判据：对同一批实体，接线层给出的「文档引用串 → 标记」表必须与
// `pairDocumentAssets` 的表**逐条相等**。语料里特意带上两份旧实现会分叉的形状（见 `corpus`），
// 所以把接线层改回自带一份判据（还原合并）⇒ 这些用例**精确变红**。
//
// 环境说明：`workbench.tsx` 经 `@lyapunov/viewer/client` 落到 `packages/viewer/dist/client.js`
// （浏览器 ModuleLoader 产物，宿主不用其工厂）。本用例不调用 `createViewer`，只要纯函数的**真实实现**，
// 所以临时装一个替身进口，`import` 完立刻 `mock.restore()` 收回，别的测试文件看不到它。
import { mock } from "bun:test"
import { pairDocumentAssets } from "../src/asset-locator.ts"

import {projectSceneCameraRigs} from "../src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client", () => ({
  projectSceneCameraRigs,
  createViewer: () => { throw new Error("TEST_STUB: createViewer 不参与本用例") },
  WebGLUnavailableError: class extends Error {},
}))
const { assetLocatorTokens, prepareViewerScene } = await import("../../lyapunov-shell/src/workbench.tsx")
mock.restore()

describe("DEV-034 接线层：配对判据与 asset-locator 同源（只有一份）", () => {
  const meshFile = "product/robots/libero/meshes/bottle.STL"
  const textureFile = "product/robots/libero/textures/wood.png"
  const meshToken = "res:11111111111111111111111111111111"
  const textureToken = "res:22222222222222222222222222222222"
  const documentToken = "res:33333333333333333333333333333333"

  /** 官方形状：`representations = [派生文档] + [逐 mesh 一条] + [逐 texture 一条]`，镜像逐字相等。 */
  const official = {
    entityId: "official", components: {
      visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: meshFile }], texture: [{ file: textureFile }] } } } },
      mujoco: { meshes: [{ file: meshFile }], textures: [{ file: textureFile }] },
    },
    resources: [{ representations: [
      { uri: documentToken, mimeType: "application/x-mjcf+xml" },
      { uri: meshToken, mimeType: "model/stl" },
      { uri: textureToken, mimeType: "image/png" },
    ] }],
  }
  /** 接线**之后**的形状：`file` 已经逐字等于该表示的 `uri`（直接命中）。 */
  const rewired = {
    entityId: "rewired", components: {
      visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: meshToken }] } } } },
      mujoco: { meshes: [{ file: meshToken }] },
    },
    resources: [{ representations: [{ uri: documentToken, mimeType: "application/x-mjcf+xml" }, { uri: meshToken, mimeType: "model/stl" }] }],
  }
  /** 用户机器人形状：没有 `components.mujoco` 镜像 ⇒ 一条也配不上（如实交出空表，不拿别的资源顶替）。 */
  const userRobot = {
    entityId: "g1", components: {
      visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: "pelvis.STL" }] } } } },
      mujoco: { sourcePath: "file:///home/agent/robots/g1/g1.xml" },
    },
    resources: [{ representations: [{ uri: documentToken, mimeType: "application/x-mjcf+xml" }] }],
  }
  /** 旧接线层会分叉的形状 ①：条数配得上，但 texture 段给的是非图片 ⇒ "顺序不是生产者那一条"。 */
  const shapeMismatch = {
    entityId: "shape-mismatch", components: {
      visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: meshFile }], texture: [{ file: textureFile }] } } } },
      mujoco: { meshes: [{ file: meshFile }], textures: [{ file: textureFile }] },
    },
    resources: [{ representations: [
      { uri: documentToken, mimeType: "application/x-mjcf+xml" },
      { uri: meshToken, mimeType: "model/stl" },
      { uri: textureToken, mimeType: "model/stl" },
    ] }],
  }
  /** 旧接线层会分叉的形状 ②：直接命中（`file` 就是 `uri`）+ 条数对不上。 */
  const directHit = {
    entityId: "direct-hit", components: { visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: meshToken }] } } } } },
    resources: [{ representations: [{ uri: meshToken, mimeType: "model/stl" }] }],
  }
  const corpus: Record<string, unknown> = { official, rewired, userRobot, shapeMismatch, directHit }

  const wiringTokens = (entity: unknown): Record<string, string> => Object.fromEntries(assetLocatorTokens(entity as never))
  const pairingTokens = (entity: unknown): Record<string, string> =>
    Object.fromEntries(pairDocumentAssets(entity as never).map(row => [row.file, row.uri]))

  test("逐例相等：接线层的「文档引用串 → 标记」表 = pairDocumentAssets 的表（语料含旧两份实现会分叉的形状）", () => {
    for (const [name, entity] of Object.entries(corpus))
      expect({ name, ...wiringTokens(entity) }).toEqual({ name, ...pairingTokens(entity) })
  })

  test("非空转：官方形状真的配上两条、用户机器人真的配不上（否则上一条的相等等于两边都空）", () => {
    expect(wiringTokens(official)).toEqual({ [meshFile]: meshToken, [textureFile]: textureToken })
    expect(wiringTokens(userRobot)).toEqual({})
    expect(wiringTokens(rewired)).toEqual({ [meshToken]: meshToken })
  })

  test("接线层照旧按这张表改写：官方形状 entities/meshes/textures=1/1/1、skipped=0，别的实体不动", () => {
    const prepared = prepareViewerScene({
      sceneId: "scene-dedup", revision: 1,
      coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
      entities: [official, rewired, userRobot],
    } as never)
    expect(prepared.rewiring).toEqual({ entities: 2, meshes: 2, textures: 1, skipped: 1 })
    const files = (prepared.scene.entities[0]!.components.visual as never as { robot: { document: { asset: { mesh: { file: string }[]; texture: { file: string }[] } } } }).robot.document.asset
    // 输出形状**只有一种**：纯标记 `res:<指纹>`，一个后缀都不加（P3-WIRING-REWORK 裁定）。
    // 依据：`robot.ts` 按**登记 mimeType** 分派装载器，而 `asset-locator.ts:80` 对 `res:` 开头一律
    // 返回 undefined ⇒ 后缀参与不了分派；却会让 `pairDocumentAssets` 的直接命中（`file === rep.uri`）
    // 与顺序配对（镜像里是没被改写的原引用）两条路一起落空 ⇒ 声明表整张空、每条网格 UNSUPPORTED。
    // 真文档 + 真函数实测：纯标记 `声明 90 / UNSUPPORTED 0`；`res:<指纹>?ext=` `声明 0 / UNSUPPORTED 82`。
    // 本文件 19:07 那版曾断言 `res:<指纹>?ext=.STL` —— 那是**当时那份按扩展名分派的 viewer** 的形状
    // （18:41 的构建），与 `projection-consumer.test.ts`（断言纯标记）互相矛盾；两份当时都绿，是因为
    // 没有一条用例把 `prepareViewerScene` 的输出喂进 `pairDocumentAssets`/`buildRobotVisual`。
    // 真链用例现在钉在 `projection-consumer.test.ts` 的「① 装载器分派」里，判定归属它。
    expect(files.mesh[0]!.file).toBe(meshToken)
    expect(files.texture[0]!.file).toBe(textureToken)
    // 配不上的那条**原样交出**（不猜、不顶替）：用户机器人的 `pelvis.STL` 一个字都没改。
    const untouched = (prepared.scene.entities[2]!.components.visual as never as { robot: { document: { asset: { mesh: { file: string }[] } } } }).robot.document.asset
    expect(untouched.mesh[0]!.file).toBe("pelvis.STL")
  })
})


// 用户试用：环境默认进入主体内部，不按完整 bbox 在远处观看。
import { centralSplatBounds, placeInsideScene, FirstPersonNavigation } from "../src/first-person.ts"
test("场景中心机位落在主体内部，离群 Gaussian 不把中心拉走",()=>{
 const core=centralSplatBounds(1000,index=>({center:new THREE.Vector3(index<990?index%10:10000,index%20,2),opacity:1}))!
 expect(core.max.x).toBeLessThan(10)
 const camera=new THREE.PerspectiveCamera(60,1,.1,1000),view=placeInsideScene(camera,core)!
 expect(core.containsPoint(camera.position)).toBe(true)
 expect(camera.position.toArray()).toEqual(core.getCenter(new THREE.Vector3()).toArray())
 expect(camera.position.distanceTo(view.target)).toBeCloseTo(1)
 expect(camera.getWorldDirection(new THREE.Vector3()).dot(view.target.clone().sub(camera.position).normalize())).toBeCloseTo(1)
})
test("第一人称移动只响应画布按键；失焦后停止；退出恢复非活动状态",()=>{
 class Canvas extends EventTarget {dataset:Record<string,string>={};tabIndex=-1;isConnected=true;ownerDocument={activeElement:this,hasFocus:()=>true};focus(){};setPointerCapture(){};hasPointerCapture(){return false};releasePointerCapture(){}}
 const canvas=new Canvas(),camera=new THREE.PerspectiveCamera(),target=new THREE.Vector3(0,1,0)
 camera.up.set(0,0,1);camera.lookAt(target)
 const nav=new FirstPersonNavigation(camera,canvas as unknown as HTMLCanvasElement,target,()=>nav.setActive(false))
 const key=(type:string,code:string)=>{const event=new Event(type,{cancelable:true});Object.defineProperty(event,"code",{value:code});canvas.dispatchEvent(event)}
 nav.setActive(true);nav.update(100);key("keydown","KeyW");nav.update(150)
 expect(camera.position.y).toBeGreaterThan(0)
 const at=camera.position.clone();canvas.dispatchEvent(new Event("blur"));nav.update(200);nav.update(250)
 expect(camera.position.equals(at)).toBe(true)
 key("keydown","Escape");expect(nav.active).toBe(false);nav.dispose()
})


import { SceneViewer } from "../src/index.ts"
test("文件内容与取景不切换导航：3DGS、大网格、小物件共享用户选择",()=>{
 for(const mode of ["orbit","first-person"] as const){
  const view:any=Object.create(SceneViewer.prototype)
  view.camera=new THREE.PerspectiveCamera(60,1,.1,1000);view.camera.up.set(0,0,1)
  view.controls={target:new THREE.Vector3(),enabled:true,update(){}}
  view.firstPerson={active:false,speed:1,setActive(active:boolean){this.active=active}}
  view.navigationButtons=[];view.editing=false;view.select=()=>{}
  view.splatBounds=new WeakMap();view.splatViewBounds=new WeakMap()
  view.setNavigationMode(mode,false)
  for(const kind of ["splat","mesh","robot"]){
   const group=new THREE.Group()
   if(kind==="splat"){const cloud=new THREE.Object3D();group.add(cloud);const box=new THREE.Box3(new THREE.Vector3(-10,-20,0),new THREE.Vector3(10,20,5));view.splatBounds.set(cloud,box);view.splatViewBounds.set(cloud,box)}
   else group.add(new THREE.Mesh(new THREE.BoxGeometry(kind==="mesh"?12:1,3,3)))
   view.objects=new Map([["asset",{group}]]);view.snapshot={entities:[{entityId:"asset",components:{visual:{kind},...(kind==="robot"?{articulation:{}}:{})}}]}
   view.openDefaultView("asset");expect(view.firstPerson.active).toBe(mode==="first-person")
   view.focus("asset");expect(view.firstPerson.active).toBe(mode==="first-person")
   view.frameAll();expect(view.firstPerson.active).toBe(mode==="first-person")
  }
 }
})
