/**
 * DEV-PROJ-02：**交给浏览器的场景**里，机器人文档资产引用必须先换成"已授权件的媒体标记"。
 *
 * 这一层是 `plugin.ts` 的 `projectSceneForBrowser`（`state` / `scene` 两条路由共用）：
 * 出站投影只认识字符串形状，看不见"这条引用相对哪份文档写"。于是两种形状在浏览器里都换不回字节：
 *  · **相对引用**（`meshdir=meshes` + `file="a.stl"`）⇒ 基址 `baseUri` 已是标记 → 客户端只能原样把
 *    `meshes/a.stl` 交给媒体路由（`ROBOT_VISUAL_REFERENCE_UNRESOLVED`）；
 *  · **域内绝对路径** ⇒ 被投影成域引用 `<域>/<相对>`，而路由按"标记／绝对件"等值匹配 ⇒ 匹配不上。
 *
 * 本文件钉住三件事（都用**真夹具**：`scene-kit/test/fixtures/mjcf-duplicate-sections` 的 XML 与 STL 真的在磁盘上，
 * 生产者是 scene-kit 自己的 `robotVisual` + `parseAsset`）：
 *  1. 走这一层之后，文档引用是标记，且标记能在**该 Scene 的已授权候选集**里换回磁盘上的那一件；
 *  2. **负对照**：同一个域内绝对引用，不走这一层（= 今天 HEAD 的 `projectPathsOnly` 直出）就换不回字节——
 *     这一条还原修改点即精确变红；
 *  3. 候选集外的件一条都不改（不放宽授权）。
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

import { matchResourceToken, projectPathsOnly, resourceToken, type ProductPathRoots } from "../../lyapunov-contracts/src/product-paths.ts"
import { localPath, parseAsset, robotVisual } from "../../scene-kit/src/formats.ts"
import { pairDocumentAssets } from "../../viewer/src/asset-locator.ts"
import { projectSceneForBrowser } from "../src/plugin.ts"

const FIXTURES = join(import.meta.dir, "..", "..", "scene-kit", "test", "fixtures", "mjcf-duplicate-sections")
const SCENE_XML = join(FIXTURES, "scene.xml")
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_SOURCE = readFileSync(join(HERE, "../src/plugin.ts"), "utf8")
/** 域根罩住夹具目录：域内绝对路径**本来会**被投影写成域引用（这正是第二种失效形状）。 */
const ROOTS: ProductPathRoots = { runtime: FIXTURES }
const SESSION = "scene-robot-asset-locators"

/** 真生产者产出的机器人实体（形状与 scene-kit 挂载后的一致：一条 XML 表示 + `mujoco.sourcePath`）。 */
async function robotEntity(entityId = "arm") {
  const robot = await robotVisual(SCENE_XML)
  const parsed = await parseAsset(SCENE_XML)
  return {
    entityId, name: entityId,
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{
      resourceId: `${entityId}-1`, version: 1,
      original: { uri: pathToFileURL(SCENE_XML).href, mimeType: parsed.mimeType, role: "source" },
      representations: [{ uri: pathToFileURL(SCENE_XML).href, mimeType: parsed.mimeType, role: "source" }],
      source: parsed.source,
    }],
    components: { visual: { kind: "robot", robot }, mujoco: { sourcePath: SCENE_XML } },
  }
}
/** 媒体路由的已授权候选集（`plugin.ts` 的 `resource` 路由同一份算法，只读副本）。 */
async function routeCandidates(scene: any): Promise<string[]> {
  const listed = scene.entities.flatMap((entity: any) => (entity.resources ?? []).flatMap((ref: any) => [ref.original, ...(ref.representations ?? [])]))
  const candidates: string[] = listed.filter(Boolean).map((rep: any) => rep.uri)
  for (const entity of scene.entities) { const native = entity.components?.mujoco?.sourcePath; if (typeof native === "string") candidates.push(native) }
  for (const source of [...candidates]) {
    try { const parsed = await parseAsset(localPath(source)); for (const item of parsed.dependencies) candidates.push(item.path, pathToFileURL(item.path).href) } catch { continue }
  }
  return candidates
}
const sceneOf = (entities: unknown[]) => ({ sceneId: "s-robot", revision: 1, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities }) as never
const meshRefs = (scene: any): string[] => scene.entities.flatMap((entity: any) => {
  const asset = entity.components?.visual?.robot?.document?.asset
  const sections = asset === undefined ? [] : Array.isArray(asset) ? asset : [asset]
  return sections.flatMap((section: any) => (section.mesh === undefined ? [] : Array.isArray(section.mesh) ? section.mesh : [section.mesh]).map((row: any) => row.file))
})

describe("① 出站这一层：文档引用换成标记，且标记能被该 Scene 的候选集换回真身", () => {
  test("真夹具（相对引用 + meshdir）：三条网格全部换成标记，路由用候选集能换回磁盘上的那一件", async () => {
    const scene = sceneOf([await robotEntity()])
    const out: any = await projectSceneForBrowser(scene, SESSION, ROOTS, new Map())
    const candidates = await routeCandidates(scene)
    expect(meshRefs(out)).toHaveLength(3)
    for (const ref of meshRefs(out)) {
      expect(ref.startsWith("res:")).toBe(true)
      const real = matchResourceToken(ref, candidates)
      expect(real).toBeTruthy()
      expect(localPath(real!)).toMatch(/\/meshes\/[abc]\.stl$/)
    }
    // 装载器分派要的声明也回来了（同一份资产：文档引用 = 表示 uri 的标记）。配对判据吃的是**实体**。
    expect(pairDocumentAssets(out.entities[0]).map((row: any) => row.mimeType)).toEqual(["model/stl", "model/stl", "model/stl"])
  })

  test("依赖闭包按会话+场景版本进缓存，第二条路由不重复解析", async () => {
    const cache = new Map<string, Set<string>>()
    const scene = sceneOf([await robotEntity()])
    await projectSceneForBrowser(scene, SESSION, ROOTS, cache)
    expect([...cache.keys()]).toEqual([`${SESSION}|s-robot:1:${SCENE_XML}`])
    const before = [...(cache.get([...cache.keys()][0]!) ?? [])]
    await projectSceneForBrowser(scene, SESSION, ROOTS, cache)
    expect([...(cache.get([...cache.keys()][0]!) ?? [])]).toEqual(before)
  })
})

describe("② 负对照：不走这一层 ⇒ 同一条引用在路由那里换不回字节", () => {
  test("域内**绝对**引用（用户交付里真实存在的形状）：直出投影成域引用 ⇒ 匹配不上；过这一层 ⇒ 是标记、匹配得上", async () => {
    const entity = await robotEntity("tex-abs") as any
    // 把网格引用改成域内绝对路径（MuJoCo 语义：绝对路径不受 meshdir 影响）。
    const absolute = join(FIXTURES, "meshes", "a.stl")
    const document = structuredClone(entity.components.visual.robot.document)
    for (const section of Array.isArray(document.asset) ? document.asset : [document.asset])
      for (const row of (Array.isArray(section.mesh) ? section.mesh : [section.mesh]).filter(Boolean)) row.file = absolute
    entity.components.visual.robot.document = document
    const scene = sceneOf([entity])
    const candidates = await routeCandidates(scene)

    // 今天 HEAD 的直出（负对照）：域内绝对路径 → 域引用，splat 式等值匹配一条也命中不了。
    const raw: any = projectPathsOnly(scene, ROOTS)
    const rawRef = meshRefs(raw)[0]!
    expect(rawRef).toBe(`runtime/${absolute.slice(FIXTURES.length + 1)}`)
    expect(matchResourceToken(rawRef, candidates)).toBeUndefined()
    expect(candidates.includes(rawRef)).toBe(false)

    // 过这一层：写的是候选集里那一条串的标记 ⇒ 路由放行到真身。
    const out: any = await projectSceneForBrowser(scene, SESSION, ROOTS, new Map())
    const ref = meshRefs(out)[0]!
    expect(ref.startsWith("res:")).toBe(true)
    expect(matchResourceToken(ref, candidates)).toBeTruthy()
    expect(localPath(matchResourceToken(ref, candidates)!)).toBe(absolute)
  })

  test("候选集外的件（不在依赖闭包里）⇒ 一条都不改，如实留给缺件通道", async () => {
    const entity = await robotEntity("outside") as any
    const outside = join(HERE, "fixtures-does-not-exist.stl")
    const document = structuredClone(entity.components.visual.robot.document)
    for (const section of Array.isArray(document.asset) ? document.asset : [document.asset])
      for (const row of (Array.isArray(section.mesh) ? section.mesh : [section.mesh]).filter(Boolean)) row.file = outside
    entity.components.visual.robot.document = document
    const out: any = await projectSceneForBrowser(sceneOf([entity]), SESSION, ROOTS, new Map())
    expect(meshRefs(out)).toEqual([outside, outside, outside])
  })
})

describe("③ 接线门：两条路由都必须走这一层（形状门，不是行为门）", () => {
  test("`state` 与 `scene` 的场景载荷都经 `projectSceneOutbound`，不再有 `projectPathsOnly(scene,…)` 直出", () => {
    // 与 `environment-routing.test.ts` 的 `runDomainPointerGate(PLUGIN_SOURCE)` 同一手法：对真实源码做形状门。
    expect(PLUGIN_SOURCE.includes("scene?{scene:await projectSceneOutbound(scene,sessionKey)}:{}")).toBe(true)
    expect(PLUGIN_SOURCE.includes('await projectSceneOutbound(await sceneSnapshot(sessionKey,query.get("sceneId")??""),sessionKey)')).toBe(true)
    expect(PLUGIN_SOURCE.includes("projectPathsOnly(scene,productPathRoots)")).toBe(false)
    // 这一层自己也只有一份实现（导出给本文件用），作用域里的绑定只是把路径域与缓存接上。
    expect(PLUGIN_SOURCE.split("export async function projectSceneForBrowser(")).toHaveLength(2)
    expect(resourceToken("file:///x/y.stl")).toBe(resourceToken("file:///x/y.stl"))
  })
})
