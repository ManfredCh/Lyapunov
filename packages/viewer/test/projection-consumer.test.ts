/**
 * 出站投影的**消费侧**回归（DEV-PROJ-01）——`robot.ts` 的装载器/基址与 `index.ts` 的格式分派。
 *
 * 背景：`cbce00a` 之后，场景在交给浏览器前会过 `projectPathsOnly`
 * （`lyapunov-contracts/src/product-paths.ts:134-147`，生产侧调用点只有 `plugin.ts:1857/1865`）：
 * `uri` 键与 `file:` 串 → **不可逆**标记 `res:<指纹>`，登记域内绝对路径 → `<域>/<相对>`。
 * P15 的只读盘点（`bugfixHistory/PROJECTION-BLAST-RADIUS-20260926.md`）实测它打坏了 5 处消费点，
 * 本文件守其中最要紧的三处——它们**是同一类错**：拿定位符串去猜语义（扩展名 / URL 可解析性 / 格式）。
 *
 * 三条纪律写在这里，改本文件前先读：
 *
 * 1. **夹具是"投影后的真实形状"，不是手写一个 `res:abc`。** 喂给 `buildRobotVisual`／`SceneViewer`
 *    的那一份是拿 `projectPathsOnly`（真投影）+ `resourceToken`（真标记）跑出来的，
 *    并在「投影后的真实形状」一节里逐条断言形状本身——夹具错了的话，后面所有断言都是假阳性。
 *    接线层（`packages/lyapunov-shell/src/workbench.tsx` 的 `prepareViewerScene`）**直接 import 真实现**
 *    （P3-WIRING-REWORK）：它经 `@lyapunov/viewer/client` 落到 `packages/viewer/dist/client.js`，
 *    所以这里按 `texture-and-autoframe.test.ts` 的同一手法临时装一个替身进口，`import` 完立刻 `mock.restore()`。
 *    **不再按"输出形状"手写替身**——那正是"两份用例互相矛盾而都绿"的成因：本文件假定
 *    `asset.mesh[i].file` 恰好等于对应表示的 `uri`（纯标记），而 `texture-and-autoframe.test.ts`
 *    当时断言 `res:<指纹>?ext=.STL`，且**没有一条用例把真输出喂进这对消费点**。
 *    现在「① 装载器分派」的第一条就是从头到尾的真链：`prepareViewerScene` → `pairDocumentAssets`
 *    → `buildRobotVisual`，并直接断言 `声明数 == mesh 行数` 且 `UNSUPPORTED == 0`。
 *
 * 2. **负对照就在用例里**：`①`/`②`/`③` 各有一条"把新增的那一路输入去掉"的读数
 *    （`assetDeclarations` 不传／不投影的绝对基址／只给定位符串），它复现的正是今天 HEAD 的失败。
 *    ⇒ 把补丁还原后，正向用例**精确变红**；负对照用例保持绿——它守的是"判据缺失必须如实说清"。
 *
 * 3. 本文件**不测像素**：真实 3DGS/贴图出图由 `script/gates` 的真实浏览器验收负责（见 REPORT.md）。
 *
 * 用法：`bun test packages/viewer/test/projection-consumer.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as THREE from "three"

import { matchResourceToken, projectPathsOnly, resourceToken, RESOURCE_TOKEN_PREFIX, type ProductPathRoots } from "../../lyapunov-contracts/src/product-paths.ts"
import type { Entity } from "../../lyapunov-contracts/src/types.ts"
import { SceneViewer } from "../src/index.ts"
import { FrameProjection } from "../src/projection.ts"
import {interactiveSplatBudget} from '../src/splat-runtime.ts'
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"
import { assessSplatDeclaration, assessSplatInput, SPLAT_FILE_TYPE_NAMES } from "../src/splat-support.ts"
import {
  ASSET_FORMATS, assetFormatFromLocator, assetFormatFromMimeType, assetFormatOf, composeAssetReference,
  documentReferenceLocator, hasLocatorScheme, pairDocumentAssets, describeAssetReference,
} from "../src/asset-locator.ts"

/** three 的 FileLoader 在 bun 里会构造 `ProgressEvent`（浏览器对象，Node 侧没有）。补齐运行环境，不是产品行为的替身。 */
;(globalThis as any).ProgressEvent ??= class ProgressEventShim extends Event {
  lengthComputable = false; loaded = 0; total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}

// 接线层的**真实现**（DEV-034 / P3）。`workbench.tsx` 经 `@lyapunov/viewer/client` 落到
// `packages/viewer/dist/client.js`，所以临时装一个替身进口：本文件只用它的两个纯函数，不调 `createViewer`。
// 与 `texture-and-autoframe.test.ts` 的 ⑤ 同一手法（那里也是这么拿 `prepareViewerScene` 的）。
import { mock } from "bun:test"
import {projectSceneCameraRigs} from "../src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client", () => ({
  projectSceneCameraRigs,
  createViewer: () => { throw new Error("TEST_STUB: createViewer 不参与本用例") },
  WebGLUnavailableError: class extends Error {},
}))
const { prepareViewerScene, viewerResourceURI } = await import("../../lyapunov-shell/src/workbench.tsx")
mock.restore()

const FIXTURES = join(import.meta.dir, "..", "..", "scene-kit", "test", "fixtures")
const STL_BYTES = `data:model/stl;base64,${readFileSync(join(FIXTURES, "mjcf-duplicate-sections", "meshes", "a.stl")).toString("base64")}`

/** 已登记的产品域根（与 `plugin.ts` 的 `productPathRoots` 同形状）：域内绝对路径 → `<域>/<相对>`。 */
const ROOTS: ProductPathRoots = { product: "/home/agent/product" }
const IN_DOMAIN = "/home/agent/product/robots/libero/meshes"
const OUT_OF_DOMAIN = "/opt/vendor/robosuite/assets"

const transform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as const
const source = { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 }
const fileUri = (path: string): string => pathToFileURL(path).href
const countMeshes = (visual: RobotVisual): number => {
  let meshes = 0
  visual.root.traverse(object => { if (object instanceof THREE.Mesh) meshes++ })
  return meshes
}
/** 机器人视觉的输入（`visual.robot`）：这里只取装配器真正读的那几个字段。 */
const robotInput = (entity: Entity): Record<string, unknown> => (entity.components.visual as any).robot

// ── 夹具 A：官方（LIBERO）形状 ────────────────────────────────────────────────
// 有 `components.mujoco.{meshes,textures}` 镜像，`representations = [派生文档] + [逐 mesh 一条] + [逐 texture 一条]。
// 唯一的镜像生产者是 `benchmark-libero/python/scene_projection.py:909-910`（TS 侧 0 处）。

function officialEntity() {
  const meshes = [
    { name: "bottle", file: `${IN_DOMAIN}/bottle.STL` },
    { name: "cream", file: `${OUT_OF_DOMAIN}/cream.stl` },
  ]
  const xml = fileUri("/home/agent/product/robots/libero/libero.xml")
  const entity = {
    entityId: "libero", name: "libero", parentId: undefined, transform,
    resources: [{
      resourceId: "libero-1", version: 1, source,
      original: { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
      representations: [
        { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
        ...meshes.map(mesh => ({ uri: fileUri(mesh.file), mimeType: "model/stl" })),
      ],
    }],
    components: {
      visual: {
        kind: "robot",
        robot: {
          format: "mjcf", baseUri: fileUri("/home/agent/product/robots/libero/"),
          document: {
            // 官方派生文档**不带 `meshdir`**（`scene_projection.py:711-733` 直接把 `file` 换成派生绝对路径，
            // 原件 robosuite 也是绝对 `file`）——这正是 P15 实测到的失败文案里只有标记、没有目录前缀的原因。
            compiler: { angle: "radian" },
            asset: { mesh: meshes },
            worldbody: { body: { name: "cabinet", geom: [{ type: "mesh", mesh: "bottle" }, { type: "mesh", mesh: "cream" }] } },
          },
        },
      },
      // 镜像：与文档里的 `file` 逐字相等（生产者约定）
      mujoco: { sourcePath: xml, meshes: meshes.map(mesh => ({ file: mesh.file })) },
    },
  } as unknown as Entity
  /** 服务端已授权候选集（`plugin.ts` 的 `resource` 路由用它做标记等值匹配）。 */
  return { entity, candidates: [xml, ...meshes.map(mesh => fileUri(mesh.file))] }
}

/**
 * 接线层的**真实现**（不再是按输出形状手写的替身）：`document.asset.<段>[i].file` → 该资产的媒体标记。
 * 手写替身曾经**假定**输出是纯标记，而另一份用例断言 `?ext=` 后缀——两份都绿、真链没人跑。
 * 现在这条替身被删掉，`prepareViewerScene` 自己回答"输出形状是什么"（判定见「① 装载器分派」）。
 */
function rewireProjected(projected: Entity): Entity {
  const prepared = prepareViewerScene({
    sceneId: "scene-rewire", revision: 1,
    coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
    entities: [projected],
  } as never)
  return prepared.scene.entities[0] as Entity
}

// ── 夹具 B：用户机器人形状 ───────────────────────────────────────────────────
// **没有**镜像，表示里只有派生文档本身 ⇒ 接线层一条也匹配不上（P15 实测 skipped=52/1/1、entities=0）。

function userEntity() {
  const xml = fileUri("/home/agent/robots/g1/g1.xml")
  return {
    entityId: "g1", name: "g1", parentId: undefined, transform,
    resources: [{
      resourceId: "g1-1", version: 1, source,
      original: { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
      representations: [{ uri: xml, mimeType: "application/x-mjcf+xml", role: "source" }],
    }],
    components: {
      visual: {
        kind: "robot",
        robot: {
          format: "mjcf", baseUri: fileUri("/home/agent/robots/g1/"),
          document: {
            compiler: { angle: "radian", meshdir: "meshes" },
            asset: { mesh: [{ name: "pelvis", file: "pelvis.STL" }] },
            worldbody: { body: { name: "pelvis", geom: { type: "mesh", mesh: "pelvis" } } },
          },
        },
      },
      mujoco: { sourcePath: xml },
    },
  } as unknown as Entity
}

// ── 夹具 C：3DGS（splat）形状 ────────────────────────────────────────────────
// `scene-kit/src/formats.ts:336` 把格式写进 mimeType：`.spz → application/x-spz`。

function splatEntity() {
  const uri = fileUri("/home/agent/product/splats/luxury-suite.spz")
  return {
    entityId: "street", name: "street", parentId: undefined, transform,
    resources: [{
      resourceId: "street-1", version: 1, source: { ...source, upAxis: "Y" as const },
      original: { uri, mimeType: "application/x-spz", role: "visual" },
      representations: [{ uri, mimeType: "application/x-spz", role: "visual" }],
    }],
    components: { visual: { kind: "splat" } },
  } as unknown as Entity
}

/** 投影后的第一条资源表示（`uri` 键一律换成标记）。 */
const projectedRep = (projected: Entity, index = 0) => projected.resources![0]!.representations[index]!
const project = (entity: Entity, roots: ProductPathRoots = ROOTS): Entity => projectPathsOnly(entity, roots) as Entity

// ─────────────────────────────────────────────────────────────────────────────

describe("投影后的真实形状（夹具自证：夹具错了后面全是假阳性）", () => {
  test("官方形状：`uri` 与 `file:` 基址都成不可逆标记；域内绝对路径成域引用、域外绝对路径原样下发", () => {
    const { entity } = officialEntity()
    const projected = project(entity)
    const robot = (projected.components.visual as any).robot
    expect(robot.baseUri).toBe(resourceToken(fileUri("/home/agent/product/robots/libero/")))
    expect(projectedRep(projected, 1).uri).toBe(resourceToken(fileUri(`${IN_DOMAIN}/bottle.STL`)))
    // mimeType **逐字未动** —— 这正是消费侧唯一还能用的语义事实（projectPathsOnly 只动 `uri` 键与 `file:` 串）。
    expect(projectedRep(projected, 1).mimeType).toBe("model/stl")
    // 文档内引用：域内绝对路径 → `<域>/<相对>`；域外绝对路径 → 原样（P15 §4 的表第 3 行）。
    expect(robot.document.asset.mesh[0].file).toBe("product/robots/libero/meshes/bottle.STL")
    expect(robot.document.asset.mesh[1].file).toBe(`${OUT_OF_DOMAIN}/cream.stl`)
  })

  test("接线层的交付形状：`asset.mesh[i].file` 恰好等于该资产表示的 `uri`（标记），基址仍是标记", () => {
    const projected = project(officialEntity().entity)
    const robot = (rewireProjected(projected).components.visual as any).robot
    robot.document.asset.mesh.forEach((mesh: any, index: number) => {
      expect(mesh.file).toBe(projectedRep(projected, 1 + index).uri)
      expect(mesh.file.startsWith(RESOURCE_TOKEN_PREFIX)).toBe(true)
    })
  })

  test("用户机器人形状：相对引用原样保留、基址换成标记 ⇒ `new URL` 当场抛（这就是 ② 的成因）", () => {
    const robot = (project(userEntity()).components.visual as any).robot
    expect(robot.baseUri).toBe(resourceToken(fileUri("/home/agent/robots/g1/")))
    expect(robot.document.asset.mesh[0].file).toBe("pelvis.STL")
    // 负对照（今天 HEAD 的真实读数）：相对引用配标记基址 ⇒ `TypeError: … cannot be parsed as a URL`。
    expect(() => new URL("meshes/pelvis.STL", robot.baseUri)).toThrow()
    // `res:<指纹>` 是**可解析**的 URL，所以"是不是 parsable"当不了判据（接线层 `parsableURL` 就栽在这上面）；
    // "有没有可解析的层级"才是判据。
    expect(hasLocatorScheme(robot.baseUri)).toBe(true)
    expect(hasLocatorScheme("meshes/pelvis.STL")).toBe(false)
  })

  test("3DGS 形状：`uri` 是标记，mimeType 带着格式活下来（定位符里已经没有格式了）", () => {
    const projected = project(splatEntity(), {})
    const rep = projectedRep(projected)
    expect(rep.uri).toBe(resourceToken(fileUri("/home/agent/product/splats/luxury-suite.spz")))
    expect(rep.mimeType).toBe("application/x-spz")
    expect(rep.uri.split("/").pop()).not.toContain("spz")
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("资产语义原语（asset-locator）：语义来自登记声明，对标记拒绝猜", () => {
  test("mimeType 优先于定位符；`application/x-<格式>` 只认词表里有的格式名", () => {
    expect(assetFormatFromMimeType("model/stl")).toBe("stl")
    expect(assetFormatFromMimeType("model/vnd.collada+xml")).toBe("dae")
    expect(assetFormatFromMimeType("application/x-spz")).toBe("spz")
    expect(assetFormatFromMimeType("image/x-exr")).toBe("exr")
    expect(assetFormatFromMimeType("application/x-foo")).toBeUndefined()          // 不臆造格式名
    expect(assetFormatFromMimeType("application/octet-stream")).toBeUndefined()   // 泛型 mimeType 不构成断言
    expect(assetFormatFromMimeType("text/plain")).toBeUndefined()
    expect(assetFormatOf({ mimeType: "model/stl", locator: "res:0123abcd" })).toBe("stl")
    expect(assetFormatOf({ mimeType: "application/octet-stream", locator: "meshes/a.STL" })).toBe("stl")
    expect(assetFormatOf({ locator: "res:0123abcd" })).toBeUndefined()            // 标记 ⇒ 判不出，返回 undefined
  })

  test("定位符后缀：真名才给（含 `file:///`、域引用、`recording:/`），标记一律 undefined", () => {
    expect(assetFormatFromLocator("meshes/pelvis.STL")).toBe("stl")
    expect(assetFormatFromLocator("product/robots/libero/meshes/bottle.STL")).toBe("stl")
    expect(assetFormatFromLocator("file:///a/b/arm.dae?v=2")).toBe("dae")
    expect(assetFormatFromLocator("recording:/resources/0/a.stl")).toBe("stl")
    expect(assetFormatFromLocator(`${RESOURCE_TOKEN_PREFIX}0123abcd`)).toBeUndefined()
    expect(assetFormatFromLocator("no-extension")).toBeUndefined()
    expect(assetFormatFromLocator("trailing.")).toBeUndefined()
    expect(assetFormatFromLocator(undefined)).toBeUndefined()
  })

  test("两份表不漂移：splat 的每个格式名都能从 `application/x-<格式>` 判出来", () => {
    for (const extension of Object.keys(SPLAT_FILE_TYPE_NAMES)) {
      expect(assetFormatFromMimeType(`application/x-${extension}`)).toBe(extension)
      expect((ASSET_FORMATS as readonly string[]).includes(extension)).toBe(true)
    }
  })

  test("缺件文案分得清「标记没有真名」与「文件没有后缀」（判据失败要能一眼看出是哪一种）", () => {
    expect(describeAssetReference("res:0123abcd")).toContain("不可逆标记")
    expect(describeAssetReference("res:0123abcd", { mimeType: "model/stl", format: "stl" })).toContain("model/stl")
    expect(describeAssetReference("meshes/")).toContain("定位符没有可用后缀")
  })

  test("文档引用 → 定位符：基址可用就相对解析；基址是标记就不抛、原样交出", () => {
    // 命令路由形状（`ui` 面）：baseUri 仍是绝对 `file:///…`，行为与今天逐例一致。
    expect(documentReferenceLocator("meshes/a.stl", "file:///home/agent/robots/g1/"))
      .toEqual({ locator: "file:///home/agent/robots/g1/meshes/a.stl", based: true })
    // `recording:/` 是分层 scheme，照旧能当基准（回放场景是这条回归的对照组）。
    expect(documentReferenceLocator("a.stl", "recording:/resources/0/"))
      .toEqual({ locator: "recording:/resources/0/a.stl", based: true })
    // `state`/`scene` 形状：基址是标记 ⇒ 不抛，`based:false` 让调用方如实上报（今天这里是 TypeError）。
    expect(documentReferenceLocator("meshes/a.stl", resourceToken("file:///home/agent/robots/g1/")))
      .toEqual({ locator: "meshes/a.stl", based: false })
    // 接线层的兜底基址 `res:unresolved` 也一样当不了基准（它只是"可解析"，不是"可当基址"）。
    expect(documentReferenceLocator("meshes/a.stl", "res:unresolved"))
      .toEqual({ locator: "meshes/a.stl", based: false })
    // 引用自带 scheme（接线层换出来的标记）⇒ 基址不参与。
    expect(documentReferenceLocator("res:0123abcd", "res:deadbeef")).toEqual({ locator: "res:0123abcd", based: false })
  })

  test("目录前缀：已经定位符化的引用不再被 `meshdir`/`texturedir` 污染", () => {
    const marker = resourceToken(fileUri("/home/agent/product/robots/libero/meshes/bottle.STL"))
    // 相对真名照旧加前缀（MuJoCo 的 meshdir 语义）。
    expect(composeAssetReference("meshes", "pelvis.STL")).toBe("meshes/pelvis.STL")
    expect(composeAssetReference("textures", "wood.png")).toBe("textures/wood.png")
    expect(composeAssetReference("", "pelvis.STL")).toBe("pelvis.STL")
    // 接线层换出的标记是**绝对定位符**：再加前缀会拼出 `meshes/res:<指纹>`（既不是标记也不是路径，
    // 媒体路由一条也匹配不上）——这是带 meshdir 的文档被接线层改写后会踩到的坑。
    expect(composeAssetReference("meshes", marker)).toBe(marker)
    expect(composeAssetReference("meshes", fileUri("/x/a.stl"))).toBe(fileUri("/x/a.stl"))
    expect(composeAssetReference("meshes", undefined)).toBe("")
  })

  test("配对判据：直接命中（接线层形状）与顺序配对（镜像形状）都成立；镜像对不上就放弃", () => {
    const projected = project(officialEntity().entity)
    const paired = pairDocumentAssets(projected)
    expect(paired.map(row => row.file)).toEqual(["product/robots/libero/meshes/bottle.STL", `${OUT_OF_DOMAIN}/cream.stl`])
    expect(paired.map(row => row.mimeType)).toEqual(["model/stl", "model/stl"])
    expect(paired.every(row => row.uri.startsWith(RESOURCE_TOKEN_PREFIX))).toBe(true)
    // 直接命中：接线之后 `file` 就是表示的 uri。
    expect(pairDocumentAssets(rewireProjected(projected)).map(row => row.file)).toEqual(paired.map(row => row.uri))
    // 负对照：镜像与文档引用不再逐字相等（接线层只改文档那一侧）⇒ 顺序配对放弃，不拿别的资源顶替。
    const broken = structuredClone(projected) as any
    broken.components.mujoco.meshes[0].file = "product/robots/libero/meshes/other.STL"
    expect(pairDocumentAssets(broken).some(row => row.file.includes("bottle"))).toBe(false)
  })

  test("配对判据也认贴图那一段（段位 mimeType 形状：mesh 段不是图片、texture 段必须是图片）", () => {
    const xml = fileUri("/home/agent/product/robots/libero/libero.xml")
    const meshFile = "product/robots/libero/meshes/bottle.STL"
    const textureFile = "product/robots/libero/textures/wood.png"
    const entity = {
      entityId: "r", name: "r", transform,
      resources: [{
        resourceId: "r-1", version: 1, source,
        original: { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
        representations: [
          { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
          { uri: resourceToken("file:///bottle.STL"), mimeType: "model/stl" },
          { uri: resourceToken("file:///wood.png"), mimeType: "image/png" },
        ],
      }],
      components: {
        visual: { kind: "robot", robot: { format: "mjcf", baseUri: "res:x", document: { asset: { mesh: [{ file: meshFile }], texture: [{ file: textureFile }] } } } },
        mujoco: { meshes: [{ file: meshFile }], textures: [{ file: textureFile }] },
      },
    } as unknown as Entity
    expect(pairDocumentAssets(entity).map(row => [row.file, row.mimeType])).toEqual([[meshFile, "model/stl"], [textureFile, "image/png"]])
    // 段位形状对不上（texture 段给的是非图片）⇒ 整条顺序配对放弃。
    const wrong = structuredClone(entity) as any
    wrong.resources[0].representations[2].mimeType = "model/stl"
    expect(pairDocumentAssets(wrong)).toEqual([])
  })

  test("splat 声明侧判定：声明带格式就通过；判不出格式时说清是「判据缺失」而不是文件没后缀", () => {
    const token = resourceToken(fileUri("/home/agent/product/splats/luxury-suite.spz"))
    expect(assessSplatDeclaration({ mimeType: "application/x-spz", locator: token }, { dependencyAvailable: true }))
      .toMatchObject({ supported: true, cause: "ok", fileTypeName: "SPZ", extension: "spz" })
    // 负对照（今天 HEAD 的输入）：只给定位符 —— 3DGS 整块判成 unsupported-format。
    const legacy = assessSplatInput(token.split("/").pop()!, { dependencyAvailable: true })
    expect(legacy.supported).toBe(false)
    expect(legacy.cause).toBe("unsupported-format")
    // 声明也没有、定位符又是标记 ⇒ detail 必须说清是"判不出格式"，不是"格式不支持"。
    const blind = assessSplatDeclaration({ locator: token }, { dependencyAvailable: true })
    expect(blind.cause).toBe("unsupported-format")
    expect(blind.detail).toContain("不可逆标记")
    expect(blind.detail).toContain("不是文件真的没有扩展名")
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("① 装载器分派：按登记声明，不按 `file` 串", () => {
  /**
   * 用**真标记匹配**当解析器：只有拿到已授权候选集里那条真身才会交出字节（媒体路由的准入口径）。
   * 过 `viewerResourceURI` 与产品一致：`workbench.tsx:505` 的 `resolveResource` 就是
   * `mediaURL("resource",{uri:viewerResourceURI(uri)})`——**这一步不能省**，否则量到的不是产品的路。
   * （接线层的输出形状本身另有断言：「真链」用例里那条"过不过一个样"。）
   */
  const tokenResolver = (candidates: readonly string[], requested: string[]) => (uri: string) => {
    const real = matchResourceToken(viewerResourceURI(uri), candidates)
    requested.push(real ?? uri)
    if (!real) throw new Error(`RESOURCE_NOT_REFERENCED_BY_SCENE: ${uri}`)
    return STL_BYTES
  }

  test("真链：`prepareViewerScene` → `pairDocumentAssets` → `buildRobotVisual`：声明数 == mesh 行数，UNSUPPORTED == 0", async () => {
    const { entity, candidates } = officialEntity()
    const outgoing = project(entity)                       // 出站投影（真函数）
    const rewired = rewireProjected(outgoing)              // 接线层（真函数，不是替身）
    const meshRows = (robotInput(rewired) as any).document.asset.mesh as unknown[]
    const declarations = new Map(pairDocumentAssets(rewired).map(row => [row.file, row.mimeType]))
    // ① 每条 mesh 行都拿到声明；这份夹具没有 texture 段 ⇒ 表大小恰好等于 mesh 行数。
    expect(meshRows.length).toBe(2)
    expect(declarations.size).toBe(meshRows.length)
    expect(meshRows.every((row: any) => declarations.has(row.file))).toBe(true)
    // ② 接线层的输出**本来就是媒体路由的准入货币**：过 `viewerResourceURI` 等于不过。
    //    形状判据：`res:<指纹>` 一个后缀都不带（`?ext=` 那种形状会让下面的真链整块断掉）。
    expect(meshRows.map((row: any) => viewerResourceURI(row.file))).toEqual(meshRows.map((row: any) => row.file))
    expect(meshRows.every((row: any) => /^res:[^?#]+$/.test(row.file))).toBe(true)
    // ③ 交到解析器的定位符真的换到了字节（与产品同一条路：`viewerResourceURI` → 标记等值匹配）。
    const requested: string[] = []
    const unsupported: string[] = []
    const visual = await buildRobotVisual(
      { ...robotInput(rewired), assetDeclarations: declarations },
      (uri: string) => { const real = matchResourceToken(viewerResourceURI(uri), candidates); requested.push(real ?? uri); if (!real) throw new Error(`RESOURCE_NOT_REFERENCED_BY_SCENE: ${uri}`); return STL_BYTES })
    visual.warnings.filter(text => text.includes("UNSUPPORTED_ROBOT_VISUAL_MESH:")).forEach(text => unsupported.push(text))
    expect(requested).toEqual([fileUri(`${IN_DOMAIN}/bottle.STL`), fileUri(`${OUT_OF_DOMAIN}/cream.stl`)])
    expect(unsupported).toEqual([])
    expect(visual.warnings).toEqual([])
    expect(countMeshes(visual)).toBe(meshRows.length)
    // ④ 接线层的读数与真链一致（`rewiring.meshes` = 实际改写的 mesh 行数；这一份 `skipped=0`）。
    const prepared = prepareViewerScene({
      sceneId: "scene-rewire", revision: 1,
      coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
      entities: [outgoing],
    } as never)
    expect(prepared.rewiring).toEqual({ entities: 1, meshes: 2, textures: 0, skipped: 0 })
  })

  test("投影 + 接线之后：两个网格都装载出来（80 条官方网格零装载的形状就是这一条守的）", async () => {
    const { entity, candidates } = officialEntity()
    const rewired = rewireProjected(project(entity))
    const declarations = new Map(pairDocumentAssets(rewired).map(row => [row.file, row.mimeType]))
    expect(declarations.size).toBe(2)
    const requested: string[] = []
    const visual = await buildRobotVisual(
      { ...robotInput(rewired), assetDeclarations: declarations }, tokenResolver(candidates, requested))
    expect(countMeshes(visual)).toBe(2)
    expect(visual.warnings).toEqual([])
    expect(requested).toEqual([fileUri(`${IN_DOMAIN}/bottle.STL`), fileUri(`${OUT_OF_DOMAIN}/cream.stl`)])
  })

  test("负对照：不交声明（= 今天 HEAD 的那一路输入）⇒ 同一份夹具报 UNSUPPORTED_ROBOT_VISUAL_MESH: res:<指纹>", async () => {
    const { entity, candidates } = officialEntity()
    const rewired = rewireProjected(project(entity))
    const requested: string[] = []
    const visual = await buildRobotVisual(robotInput(rewired), tokenResolver(candidates, requested))
    // 网格任务的失败走 `warnings.push(String(error))`，所以台账里带 `Error: ` 前缀（既有口径，未改）。
    const unsupported = visual.warnings.filter(text => text.includes("UNSUPPORTED_ROBOT_VISUAL_MESH:"))
    expect(unsupported.length).toBe(2)
    // 失败原因**从"URL 解析不了"变成了"标记没有扩展名"**——这正是 P15 记录的 82 条读数的形状。
    expect(unsupported.every(text => text.includes(RESOURCE_TOKEN_PREFIX))).toBe(true)
    expect(countMeshes(visual)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("② 基址：标记基址上的相对引用不再抛，失败可诊断", () => {
  test("用户机器人（投影形状）：引用原样交给解析器 + 一条判据缺失警告，不再是 TypeError", async () => {
    const robot = robotInput(project(userEntity()))
    const requested: string[] = []
    const visual = await buildRobotVisual(robot, (uri: string) => { requested.push(uri); return STL_BYTES })
    // 相对引用 + 标记基址 ⇒ 只有媒体路由能解析：这里原样交出（补丁前根本走不到这一步，`new URL` 就抛了）。
    expect(requested).toEqual(["meshes/pelvis.STL"])
    expect(visual.warnings.filter(text => text.startsWith("ROBOT_VISUAL_REFERENCE_UNRESOLVED:")).length).toBe(1)
    expect(visual.warnings.some(text => /cannot be parsed as a URL|Invalid URL/.test(text))).toBe(false)
    // 扩展名还在（`meshes/pelvis.STL` 是真名）⇒ 装载器照样能分派，网格不因基址问题丢掉。
    expect(countMeshes(visual)).toBe(1)
  })

  test("命令路由形状（baseUri 仍是绝对 file:///）：相对引用照旧解析、网格照旧装载（这条路不能回归）", async () => {
    const requested: string[] = []
    const visual = await buildRobotVisual(robotInput(userEntity()), (uri: string) => { requested.push(uri); return STL_BYTES })
    expect(requested).toEqual([fileUri("/home/agent/robots/g1/meshes/pelvis.STL")])
    expect(visual.warnings).toEqual([])
    expect(countMeshes(visual)).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本进程没有 WebGL：`SceneViewer` 的构造函数要真实 WebGL，所以用
 * `Object.create(SceneViewer.prototype)` + 显式补上 `setScene` 真正读到的字段
 * （与 `packages/viewer/test/environment-viewer.test.ts` 的 BareViewer 同一手法）。
 * 于是下面每条断言都由**产品源码本身**回答：格式门、台账、`visualWarnings` 都是真的。
 */
class BareViewer {
  readonly reads: string[] = []
  readonly errors: string[] = []
  readonly viewer: any
  constructor() {
    const viewer: any = Object.create(SceneViewer.prototype)
    viewer.options = {
      resolveResource: (uri: string) => { this.reads.push(uri); return "data:application/octet-stream;base64,AAAA" },
      onError: (error: Error) => { this.errors.push(error.message) },
    }
    viewer.scene = new THREE.Scene()
    // Object.create不运行构造字段；保留setScene的真实相机投影依赖。
    viewer.cameraRigs = new Map()
    viewer.cameraRigRoot = new THREE.Group()
    viewer.scene.add(viewer.cameraRigRoot)
    viewer.scene.environmentIntensity = 1
    viewer.projection = new FrameProjection()
    viewer.renderer = {
      toneMappingExposure: 1, shadowMap: { enabled: false, type: 0 },
      render: () => {}, compile: () => {},
      domElement: { getBoundingClientRect: () => ({ width: 0, height: 0 }), width: 0, height: 0, toDataURL: () => "data:image/png;base64,AAAA" },
    }
    viewer.controls = { target: new THREE.Vector3(), update: () => {} }
    viewer.camera = new THREE.PerspectiveCamera()
    viewer.materialEnvironment = { texture: new THREE.Texture() }
    viewer.grid = new THREE.Object3D()
    viewer.axes = new THREE.Object3D()
    viewer.hemisphere = new THREE.HemisphereLight(0xe7efff, 0x47515c, 2.4)
    viewer.sun = new THREE.DirectionalLight(0xffffff, 3)
    viewer.environmentClock = { playing: false, offsetHours: 0, advancedSeconds: 0 }
    viewer.environmentDiagnostics = []
    viewer.sunDistance = 50
    viewer.backgroundDaylight = 1
    viewer.geometryRevision = 1
    viewer.annotations = []
    viewer.markers = new Map()
    viewer.objects = new Map()
    viewer.gltfs = new Map()
    viewer.gltfStats = new Map()
    viewer.lodSwitches = 0
    viewer.lodProbe = new THREE.Vector3()
    viewer.lodCamera = new THREE.Vector3()
    // Object.create不跑Viewer字段初始化器；格式门后的冷解码也须沿真实预算配置。
    viewer.splatBudget = interactiveSplatBudget('unknown')
    viewer.mixers = new Map()
    viewer.splatBounds = new WeakMap()
    viewer.loadingErrors = new Map()
    viewer.visualWarnings = new Map()
    viewer.display = { grid: true, axes: true, background: "#121a24", wireframe: false, splats: true, collision: false }
    viewer.disposed = false
    viewer.generation = 0
    viewer.snapshot = undefined
    viewer.world = undefined
    viewer.sceneLightsVisible = true
    viewer.animationClock = 0
    viewer.selected = undefined
    this.viewer = viewer
  }
  warningsOf(entityId: string): string[] { return this.viewer.visualWarnings.get(entityId) ?? [] }
}

describe("③ 3DGS 格式分派：按表示声明的 mimeType，不按 `uri` 的 basename", () => {
  const snapshot = (entity: Entity) => ({
    sceneId: "scene-splat", revision: 1,
    coordinates: { units: "m", upAxis: "Z" as const, handedness: "right" as const, quaternion: "xyzw" as const },
    entities: [entity],
  })

  test("投影后的实体不再被格式门挡掉（门后的解码/依赖问题不是这条用例的事）", async () => {
    const projected = project(splatEntity(), {})
    const rep = projectedRep(projected)
    // 负对照（今天 HEAD 的输入）：定位符 basename 里没有扩展名 ⇒ unsupported-format、场景整块消失。
    expect(assessSplatInput(rep.uri.split("/").pop()!, { dependencyAvailable: true }).cause).toBe("unsupported-format")
    const harness = new BareViewer()
    await harness.viewer.setScene(snapshot(projected))
    // 真的走到了 splat 分支并去取资源（不是"提前 return 什么都没做"）。
    expect(harness.reads).toEqual([rep.uri])
    // 格式门不再拒绝：`visualWarnings` 里没有"扩展名判不出"这条（判据缺失与格式不支持是两回事）。
    expect(harness.warningsOf("street").filter(text => text.includes("不在 splat 预览支持表里"))).toEqual([])
  })
})
