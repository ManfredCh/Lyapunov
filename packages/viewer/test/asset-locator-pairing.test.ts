/**
 * DEV-PROJ-01 配对判据的**真链**用例：真投影 → **真接线层**（`prepareViewerScene`）→ 真配对 → 真装配。
 *
 * 为什么必须有这一条（验收队的第 2 条建议，`VERIFY-PROJECTION-CONSUMERS-20260926.md` §8.2）：
 * 2026-09-26 那次断链（真语料 **3652** 行网格从"可装载"变成"判不出格式"）能穿过 40 条绿用例，
 * 是因为当时的夹具**自己手抄了接线层的输出形状** —— 抄的是裸标记 `res:<指纹>`，
 * 而真接线层写的是 `res:<指纹>?ext=.STL`。**夹具与真实现的形状不一致**，所以形状一漂，
 * 没有任何一条用例变红。本文件不吃手抄形状：直接 `import` **真** `prepareViewerScene`
 * （`packages/lyapunov-shell/src/workbench.tsx`），把它的**真输出**喂给真 `pairDocumentAssets`
 * 与真 `buildRobotVisual`，并且先断言"接线层真的改写了这一组"（非空转）。
 *
 * ⚠️ **本文件守的是"严格"，不是"能配上就行"**（Lead 裁定 2026-09-27 §七之十八，
 * `docs/REMAINING_WORK_PLAN.md:1245-1257`）。这一条曾经在 R-fix#13 里被写成反的：
 * 当时这条用例叫「**形状免疫**」——要求"文档引用带 `?ext=` 或裸标记，配对表逐条相同"。
 * 那是**钉住宽容**：消费端把产生端的漂移静默吸收掉，还原产生端就**不会变红**。
 * 裁定把它翻过来了 —— 「**免疫**与**看不见**是同一件事」。所以现在钉的是：
 *
 *   接线层写哪一种形状，配对判据**就只认哪一种**；写了历史形状 `?ext=` ⇒ **配不上、当场可见**。
 *
 * 判据边界（本文件只守这些，别的不管）：
 *  ① 真链：投影 → 接线 → 配对 → 装配，`声明表条数 == 网格+贴图行数`、装载出的网格数 == 网格行数、0 警告；
 *  ② **严格比较**：真输出带 `?ext=` 后缀时配对表**为空**（后缀出现在文档引用/登记 `uri`/`mujoco` 镜像
 *     **任一侧**都一样配不上），并且真装配器**如实报** `UNSUPPORTED_ROBOT_VISUAL_MESH`（不是静默回落）；
 *  ③ **不放宽别的约束**：换一个标记、换一个文件名、`?ext=` 不在末尾 ⇒ 仍旧配不上；
 *     镜像对不上 ⇒ 顺序配对仍旧放弃（既有严格性原样）；
 *  ④ `normalizeAssetLocator` 仍然导出（诊断／迁移用），**但它不参与配对**：本文件下面的用例
 *     逐条钉的就是"调用它不会让配对成立"。
 *
 * `?ext=` 那条形状**不是手抄**：`withExtensionSuffix` 按 `workbench.tsx` 旧 `:107-110` 的原文规则
 * （`extension ? \`${token}?ext=.${extension}\` : token`，扩展名取自**改写前**的文档引用）从真输出**派生**，
 * 并先自证"它确实把三行都变成了带后缀的形状"。
 *
 * 环境说明（与 `texture-and-autoframe.test.ts:339-349` 同一手法）：`workbench.tsx` 经
 * `@lyapunov/viewer/client` 落到 `packages/viewer/dist/client.js`（构建产物，缺 `createViewer`）。
 * 本用例不调 `createViewer`，只要那几个纯函数的**真实实现**，所以临时装一个替身进口，
 * `import` 完立刻 `mock.restore()` 收回，别的测试文件看不到它。
 * `ProgressEvent` 垫片与 `projection-consumer.test.ts:44-48` 同一理由（three 的 FileLoader 需要它）。
 *
 * 运行：`bun test packages/viewer/test/asset-locator-pairing.test.ts`
 */
import { describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as THREE from "three"

import { matchResourceToken, projectPathsOnly, resourceToken, type ProductPathRoots } from "../../lyapunov-contracts/src/product-paths.ts"
import type { Entity } from "../../lyapunov-contracts/src/types.ts"
import { normalizeAssetLocator, pairDocumentAssets } from "../src/asset-locator.ts"
import { buildRobotVisual, type RobotVisual } from "../src/robot.ts"

/** three 的 FileLoader 在 bun 里会构造 `ProgressEvent`（浏览器对象，Node 侧没有）。补齐运行环境，不是产品行为的替身。 */
;(globalThis as any).ProgressEvent ??= class ProgressEventShim extends Event {
  lengthComputable = false; loaded = 0; total = 0
  constructor(type: string, init: Record<string, unknown> = {}) { super(type); Object.assign(this, init) }
}

import {projectSceneCameraRigs} from "../src/scene-camera-rigs.ts"
mock.module("@lyapunov/viewer/client", () => ({
  projectSceneCameraRigs,
  createViewer: () => { throw new Error("TEST_STUB: createViewer 不参与本用例") },
  WebGLUnavailableError: class extends Error {},
}))
/** 真接线层的纯函数（真实现，不是构建产物、不是手抄形状）。 */
const { prepareViewerScene, viewerResourceURI } = await import("../../lyapunov-shell/src/workbench.tsx")
mock.restore()

const FIXTURES = join(import.meta.dir, "..", "..", "scene-kit", "test", "fixtures")
const STL_BYTES = `data:model/stl;base64,${readFileSync(join(FIXTURES, "mjcf-duplicate-sections", "meshes", "a.stl")).toString("base64")}`

/** 已登记的产品域根（与 `plugin.ts:88-98` 同形状）：域内绝对路径 → `<域>/<相对>`，域外保持绝对。 */
const ROOTS: ProductPathRoots = { product: "/home/agent/product" }
const IN_DOMAIN = "/home/agent/product/robots/libero/meshes"
const OUT_OF_DOMAIN = "/opt/vendor/robosuite/assets"

const transform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as const
const source = { units: "m", upAxis: "Z" as const, handedness: "right" as const, metersPerUnit: 1 }
const fileUri = (path: string): string => pathToFileURL(path).href
const assetRows = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const countMeshes = (visual: RobotVisual): number => {
  let meshes = 0
  visual.root.traverse(object => { if (object instanceof THREE.Mesh) meshes++ })
  return meshes
}
const documentAsset = (entity: any): any => entity.components.visual.robot.document.asset
const meshRows = (entity: any): any[] => assetRows(documentAsset(entity).mesh)
const textureRows = (entity: any): any[] => assetRows(documentAsset(entity).texture)

/**
 * 官方（LIBERO）投影**前**的真实形状：`components.mujoco` 有逐 mesh/texture 镜像，
 * `representations = [派生文档] + [逐 mesh 一条] + [逐 texture 一条]`（生产者约定，见
 * `benchmark-libero/python/scene_projection.py:909-910`），文档**不带** `meshdir`。
 * 手抄形状只允许出现在"投影前"这一侧 —— 那是解析器产物，不是接线层产物。
 */
function officialScene() {
  const meshes = [
    { name: "bottle", file: `${IN_DOMAIN}/bottle.STL` },
    { name: "cream", file: `${OUT_OF_DOMAIN}/cream.stl` },
  ]
  const textures = [{ name: "wood", file: `${IN_DOMAIN}/wood.png` }]
  const xml = fileUri("/home/agent/product/robots/libero/libero.xml")
  const entity = {
    entityId: "libero", name: "libero", parentId: undefined, transform,
    resources: [{
      resourceId: "libero-1", version: 1, source,
      original: { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
      representations: [
        { uri: xml, mimeType: "application/x-mjcf+xml", role: "source" },
        ...meshes.map(mesh => ({ uri: fileUri(mesh.file), mimeType: "model/stl", role: "visual" })),
        ...textures.map(texture => ({ uri: fileUri(texture.file), mimeType: "image/png", role: "visual" })),
      ],
    }],
    components: {
      visual: {
        kind: "robot",
        robot: {
          format: "mjcf", baseUri: fileUri("/home/agent/product/robots/libero/"),
          document: {
            compiler: { angle: "radian" },
            asset: { mesh: meshes, texture: textures },
            worldbody: { body: { name: "cabinet", geom: [{ type: "mesh", mesh: "bottle" }, { type: "mesh", mesh: "cream" }] } },
          },
        },
      },
      mujoco: { sourcePath: xml, meshes: meshes.map(mesh => ({ file: mesh.file })), textures: textures.map(texture => ({ file: texture.file })) },
    },
  } as unknown as Entity
  return { entity, candidates: [xml, ...meshes.map(mesh => fileUri(mesh.file)), ...textures.map(texture => fileUri(texture.file))] }
}

/** 真投影（生产侧调用点：`plugin.ts:1857` 的 state 轮询与 `:1865` 的 scene 路由）。 */
function projectedScene() {
  const { entity, candidates } = officialScene()
  const scene = {
    sceneId: "scene-pairing", revision: 1,
    coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
    entities: [entity],
  }
  return { scene: projectPathsOnly(structuredClone(scene), ROOTS) as any, candidates }
}

/** 改写 `document.asset.<段>[i].file`（**只动这一列**，别的字段一个字不动 —— 与接线层同口径）。 */
function rewriteDocumentFiles(entity: any, rewrite: (file: string) => string): any {
  const asset = documentAsset(entity)
  const apply = (rows: any[]) => rows.map(row => ({ ...row, file: rewrite(String(row?.file ?? "")) }))
  return {
    ...entity,
    components: {
      ...entity.components,
      visual: {
        ...entity.components.visual,
        robot: { ...entity.components.visual.robot, document: { ...entity.components.visual.robot.document, asset: { ...asset, mesh: apply(meshRows(entity)), texture: apply(textureRows(entity)) } } },
      },
    },
  }
}

/** 该行对应的**已登记表示** `uri`（接线层用的同一把键：`representations[1..]`，按 segments 行序）。 */
function registeredUris(entity: any): string[] {
  return (entity.resources ?? []).flatMap((ref: any) => ref.representations ?? []).slice(1).map((rep: any) => String(rep.uri))
}

/**
 * 接线层**早期形状**的派生（不是校验）：`${token}?ext=.${扩展名}`，`token` 取该行对应的已登记 `uri`，
 * 扩展名取自**改写前**的文档引用（`projection` 那一份，行序与 `entity` 一一对应）
 * —— 与产生端原文（`workbench.tsx` 旧 `:107-110`）逐条对应。
 * 用途只有一个：**造出漂移的产生端形状，证明配对判据看得见它**。
 */
function withExtensionSuffix(entity: any, projection: any): any {
  const uris = registeredUris(entity)
  const extensions = [...meshRows(projection), ...textureRows(projection)].map(row => /\.([A-Za-z0-9]+)$/.exec(String(row.file))?.[1])
  let index = 0
  return rewriteDocumentFiles(entity, file => {
    const extension = extensions[index] ?? /\.([A-Za-z0-9]+)$/.exec(file)?.[1]
    const uri = uris[index++] ?? file
    return extension ? `${uri}?ext=.${extension}` : uri
  })
}

/** 配对表（比较用）：`[文档引用串, 标记, 声明 mimeType]`。 */
const table = (entity: any) => pairDocumentAssets(entity).map(row => [row.file, row.uri, row.mimeType] as const)

/**
 * 解析器 = `workbench.tsx:511` 复刻：`uri → viewerResourceURI(uri)` → 媒体路由按**标记**在已授权候选集里
 * 等值匹配（`plugin.ts` 的 `admitResourceToken` 准入语义）。取不到真身就抛，和真路由一样。
 */
const tokenResolver = (candidates: readonly string[], requested: string[]) => (uri: string) => {
  const real = matchResourceToken(viewerResourceURI(uri), candidates)
  requested.push(real ?? uri)
  if (!real) throw new Error(`RESOURCE_NOT_REFERENCED_BY_SCENE: ${uri}`)
  return real.endsWith(".png") ? `data:image/png;base64,iVBORw0KGgo=` : STL_BYTES
}

const declarationsOf = (entity: any): Map<string, string> => new Map(pairDocumentAssets(entity).map(row => [row.file, row.mimeType]))

/** 真装配器（`viewer/src/index.ts:744` 的调用形状）跑一遍，把警告原样交回来。 */
async function assemble(entity: any, candidates: readonly string[]) {
  const declarations = declarationsOf(entity)
  const requested: string[] = []
  const visual = await buildRobotVisual(
    { ...entity.components.visual.robot, assetDeclarations: declarations },
    tokenResolver(candidates, requested) as never)
  return { declarations, visual, requested }
}

describe("DEV-PROJ-01 配对判据 · 真链（真 prepareViewerScene → 真 pairDocumentAssets → 真 buildRobotVisual）", () => {
  test("① 真链：接线层真输出喂进来，声明表条数 == 网格+贴图行数，两个网格都装载出来、0 警告", async () => {
    const { scene, candidates } = projectedScene()
    const before = scene.entities[0] as any
    const prepared = prepareViewerScene(scene)
    const wired = prepared.scene.entities[0] as any
    // 非空转：接线层**真的**把这三行改写了（否则本用例守不住任何东西）。
    expect(prepared.rewiring).toMatchObject({ meshes: 2, textures: 1, skipped: 0 })
    expect(meshRows(before).concat(textureRows(before)).every(row => !String(row.file).startsWith("res:"))).toBe(true)
    expect(meshRows(wired).concat(textureRows(wired)).every(row => String(row.file).startsWith("res:"))).toBe(true)
    const { declarations, visual, requested } = await assemble(wired, candidates)
    expect(declarations.size).toBe(3)
    for (const row of meshRows(wired)) expect(declarations.get(row.file)).toBe("model/stl")
    for (const row of textureRows(wired)) expect(declarations.get(row.file)).toBe("image/png")
    expect(countMeshes(visual)).toBe(2)
    expect(visual.warnings).toEqual([])
    // 交给媒体路由的是**真身**。
    expect(requested).toEqual([fileUri(`${IN_DOMAIN}/bottle.STL`), fileUri(`${OUT_OF_DOMAIN}/cream.stl`)])

    // ⚠️ 产生端的形状自证放在**功能断言之后**（PAIRING-STRICT-LANDED 的唯一一处改动，理由见该单回执 §3）：
    // 「还原产生端 ⇒ 必须精确变红，而且在**功能层**也要红」。放在前面的话，还原产生端时本用例会**先**在
    // 这一条形状断言上停下，`declarations.size == 网格+贴图行数`、`countMeshes == 2`、`warnings == []`
    // 就都不会被执行 —— 那正是验收队 2026-09-27 抓到的"功能可观测性被遮掉"的同一形状。
    // 产生端的形状就是**纯标记**：一个后缀都不带（P3-WIRING-REWORK）。
    expect(meshRows(wired).concat(textureRows(wired)).every(row => !String(row.file).includes("?ext="))).toBe(true)

    // 自证这条形状是"真输出"，不是手抄：每一行的 `file` 逐字等于该位置登记表示的 `uri`。
    expect(meshRows(wired).concat(textureRows(wired)).map((row: any) => row.file)).toEqual(registeredUris(wired))
  })

  test("② 严格比较（曾叫「形状免疫」）：漂移的产生端形状 `?ext=` **配不上**，而且真装配器如实报缺件", async () => {
    const { scene, candidates } = projectedScene()
    const wired = prepareViewerScene(scene).scene.entities[0] as any
    const drifted = withExtensionSuffix(wired, scene.entities[0])
    // 非空转自证：这一臂**确实**是三行都带上了后缀的形状（否则下面的"配不上"什么也没证明）。
    const driftedFiles = meshRows(drifted).concat(textureRows(drifted)).map((row: any) => String(row.file))
    expect(driftedFiles.length).toBe(3)
    expect(driftedFiles.filter(file => /\?ext=\.[A-Za-z0-9]+$/.test(file)).length).toBe(3)
    // 标记列（剥掉后缀）与真输出逐条相同 ⇒ 差异**只有**形状这一处。
    expect(driftedFiles.map(normalizeAssetLocator)).toEqual(meshRows(wired).concat(textureRows(wired)).map((row: any) => row.file))

    // 判据：**配不上**。声明表为空 —— 这正是"产生端写回 `?ext=` 会被当场看见"的那条读数。
    expect(table(drifted)).toEqual([])
    expect(declarationsOf(drifted).size).toBe(0)

    // 而且真装配器**如实报**，不是静默回落：
    const { visual } = await assemble(drifted, candidates)
    expect(visual.warnings.filter((warning: string) => warning.includes("UNSUPPORTED_ROBOT_VISUAL_MESH")).length).toBe(2)
    expect(countMeshes(visual)).toBe(0)
  })

  test("②′ 后缀在**任一侧**都配不上（文档引用 / 登记 `uri` / `mujoco` 镜像，三条比较点各钉一条）", () => {
    const { scene } = projectedScene()
    const wired = prepareViewerScene(scene).scene.entities[0] as any
    const bareTable = table(wired)
    expect(bareTable.length).toBe(3)

    // ① 直接命中表的**键**：登记 `uri` 带后缀 ⇒ 文档引用（裸标记）找不到它。
    const uriSide = structuredClone(wired) as any
    for (const ref of uriSide.resources) for (const rep of ref.representations ?? []) rep.uri = `${rep.uri}?ext=.stl`
    expect(table(uriSide)).toEqual([])

    // ② 直接命中**查找**：文档引用带后缀 ⇒ 逐字不等于裸标记的 `uri`。
    const refSide = withExtensionSuffix(wired, scene.entities[0])
    expect(table(refSide)).toEqual([])
    // 大小写也一样：`?ext=.STL` / `?ext=.stl` / `?ext=.png` 三种都配不上（不归一化就无大小写豁免）。
    const refFiles = meshRows(refSide).concat(textureRows(refSide)).map((row: any) => String(row.file))
    expect(refFiles.map(file => /\?ext=\.[A-Za-z0-9]+$/.exec(file)?.[0])).toEqual(["?ext=.STL", "?ext=.stl", "?ext=.png"])

    // ③ 顺序配对的**镜像比较**：文档引用与 `uri` 都裸、只有 `components.mujoco` 镜像带后缀 ⇒ 仍旧放弃。
    //    这一条必须用**投影原件**跑（接线之后的文档引用已经逐字等于标记，走的是 `direct`，镜像不参与）。
    const mirrorSide = projectedScene().scene.entities[0] as any
    expect(meshRows(mirrorSide).every((row: any) => !String(row.file).startsWith("res:"))).toBe(true)
    expect(table(mirrorSide).length).toBe(3)
    for (const row of assetRows((mirrorSide.components.mujoco as any).meshes)) row.file = `${row.file}?ext=.STL`
    // 严格态下这不是"第一行掉队"而是**两条 mesh 行一起放弃**（镜像逐字相等是逐行的判据）
    // ⇒ 这一侧只剩贴图那一行（它的镜像没被动过、并且 `direct` 在投影原件上本来就不成立）。
    // 归一化在的时候两条 mesh 行**照样配上** —— 那个差别就是"宽容"的可测面。
    expect(table(mirrorSide).map(row => row[0])).toEqual([textureRows(mirrorSide)[0]!.file])
    expect(table(mirrorSide).map(row => row[2])).toEqual(["image/png"])
  })

  test("③ 别的约束一条没放宽：换标记、换文件名、`?ext=` 不在末尾 ⇒ 配不上", () => {
    const { scene } = projectedScene()
    const wired = prepareViewerScene(scene).scene.entities[0] as any
    // 取**已登记表示**的 `uri`（不借道 `normalizeAssetLocator`：本用例要验的是相等判据，
    // 不该跟着产生端的形状走，也不该用"归一化"造输入）。
    const token = registeredUris(wired).find((uri: string) => uri.startsWith("res:"))!
    expect(token.startsWith("res:")).toBe(true)
    /** 只留一条 mesh 表示、**不带镜像** ⇒ 只有 `direct` 这一条路能配上，用来单独验相等判据。 */
    const isolated = (file: string, uri: string) => ({
      entityId: "isolated",
      resources: [{ representations: [{ uri: resourceToken("/doc/libero.xml"), mimeType: "application/x-mjcf+xml" }, { uri, mimeType: "model/stl" }] }],
      components: { visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file }] } } } } },
    })
    // 逐字相等 ⇒ 配上（正常路）。
    expect(pairDocumentAssets(isolated(token, token)).length).toBe(1)
    // 同一份资产、但**两边写法不同**（一侧带 `?ext=`）⇒ 不配。这就是"严格"的定义面。
    expect(pairDocumentAssets(isolated(`${token}?ext=.STL`, token))).toEqual([])
    expect(pairDocumentAssets(isolated(token, `${token}?ext=.STL`))).toEqual([])
    // 换一个标记 ⇒ 不配。
    expect(pairDocumentAssets(isolated(token, resourceToken("/x/other.STL")))).toEqual([])
    // `?ext=` 不在**末尾**（多一个查询键）⇒ 也不配。
    expect(pairDocumentAssets(isolated(`${token}?ext=.STL&v=2`, token))).toEqual([])
    // 真名形状、文件名不同 ⇒ 不配。
    expect(pairDocumentAssets(isolated(`${IN_DOMAIN}/bottle.STL?ext=.STL`, fileUri(`${IN_DOMAIN}/other.STL`)))).toEqual([])
    // 镜像对不上 ⇒ 顺序配对仍旧放弃（既有严格性原样）。
    const strict = projectedScene().scene.entities[0] as any
    expect(table(strict).length).toBe(3)
    expect(meshRows(strict).every((row: any) => !String(row.file).startsWith("res:"))).toBe(true)
    ;(strict.components.mujoco as any).meshes[0].file = "product/robots/libero/meshes/other.STL"
    const paired = pairDocumentAssets(strict).map(row => row.file)
    expect(paired).not.toContain(meshRows(strict)[0]!.file)
    expect(paired).toContain(meshRows(strict)[1]!.file)
    // 镜像只是**多一个后缀**时同样算对不上（严格就是严格，没有"同一份资产"的豁免）。
    const renamed = projectedScene().scene.entities[0] as any
    ;(renamed.components.mujoco as any).meshes[0].file = "product/robots/libero/meshes/other.STL?ext=.STL"
    expect(pairDocumentAssets(renamed).map(row => row.file)).not.toContain(meshRows(renamed)[0]!.file)
  })

  test("④ `normalizeAssetLocator` 仍导出（诊断/迁移用），但**它不参与配对**", () => {
    // 函数本体：只剥末尾那一种后缀；别的查询键、非字符串、空串都不动。
    expect(normalizeAssetLocator("res:abc?ext=.STL")).toBe("res:abc")
    expect(normalizeAssetLocator("res:abc?ext=.stl")).toBe("res:abc")
    expect(normalizeAssetLocator("meshes/a.stl?ext=.stl")).toBe("meshes/a.stl")
    expect(normalizeAssetLocator("res:abc")).toBe("res:abc")
    expect(normalizeAssetLocator("res:abc?ext=.stl&v=2")).toBe("res:abc?ext=.stl&v=2")
    expect(normalizeAssetLocator("res:abc?v=2")).toBe("res:abc?v=2")
    expect(normalizeAssetLocator("res:abc?ext=.")).toBe("res:abc?ext=.")
    expect(normalizeAssetLocator("?ext=.stl")).toBe("?ext=.stl")
    expect(normalizeAssetLocator(undefined)).toBe("")
    expect(normalizeAssetLocator(42)).toBe("")

    // 判据边界：**配对路径不调用它**。这一条对着交付源码逐字核（不是凭印象）：
    // `pairDocumentAssets` 的函数体里不许出现 `normalizeAssetLocator(`。
    const source = readFileSync(join(import.meta.dir, "..", "src", "asset-locator.ts"), "utf8")
    const body = source.slice(source.indexOf("export function pairDocumentAssets"))
    expect(body.length).toBeGreaterThan(0)
    expect(body.includes("normalizeAssetLocator(")).toBe(false)
    // 而且调用它**不会**让一个本来配不上的形状配上（诊断用途 ≠ 判据）。
    const { scene } = projectedScene()
    const wired = prepareViewerScene(scene).scene.entities[0] as any
    const drifted = withExtensionSuffix(wired, scene.entities[0])
    expect(table(drifted)).toEqual([])
    expect(table(rewriteDocumentFiles(drifted, normalizeAssetLocator)).length).toBe(3)
  })
})
