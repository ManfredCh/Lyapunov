/**
 * 媒体路由的「基址 + 相对引用」解析（2026-09-26，RESOURCE-ROUTE-BASE-TOKEN）。
 *
 * 要证明的一件事：**用户导入的机器人（文档里写的是相对引用）拿到的是它自己的网格字节**——
 * 走的是真 `resource` 路由：真 `SceneOperations` + 真场景文档 + 真磁盘资产 + 真依赖闭包，
 * 不是形状等价夹具（夹具与真宿主的差别见 `resource-route-harness.ts` 的文件头）。
 *
 * 事实链（每一环在下面都有一条用例）：
 *   ① 出站投影把 `visual.robot.baseUri` 换成不可逆标记（`res:<指纹>`），文档引用仍是相对串；
 *   ② 消费侧（上一个工作面已修好的那一半）把相对引用**原样**交出，`new URL(相对, 标记)` 抛错；
 *   ③ 媒体路由按"该 Scene 自己的机器人文档目录 + 相对引用"解析，落进**既有**已授权候选集后回真字节；
 *   ④ 判据不足（`..` 越界 / 域外 / 多份文档给出不同件 / 没有文档基准）一律不放行。
 *
 * 隐私口径：路由新增的只有**解析**这一步。授权判据仍是 `listed` / `native.sourcePath` /
 * `parseAsset` 依赖闭包这三条（与改动前逐字同一份），一个字面都没放宽；歧义时明确失败而不是猜。
 *
 * 用法：`bun test packages/lyapunov-shell/test/resource-route-base-token.test.ts`
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { boot, writeScene, fetchResource, viewerSubmissions, viewerResourceURI } from "./resource-route-harness.ts"
import { resourceToken, RESOURCE_TOKEN_PREFIX } from "../../lyapunov-contracts/src/product-paths.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

const SCENE = "scene-route-base"
const COORDINATES = { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" } as const

function syntheticStl(name: string): string {
  return `solid ${name}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid ${name}\n`
}

/** 合成机器人元件（真 MJCF 形状：`compiler.meshdir` + 相对 `file`），与真实用户导入的机器人同形。 */
async function layRobot(root: string, id: string, meshNames: string[]): Promise<{ document: string; directory: string }> {
  const source = join(root, "robots", id, "source")
  await mkdir(join(source, "meshes"), { recursive: true })
  const asset = meshNames.map(name => `    <mesh name="${name.replace(/\.STL$/i, "")}" file="${name}"/>`).join("\n")
  await writeFile(join(source, "arm.xml"), `<mujoco model="arm">\n  <compiler angle="radian" meshdir="meshes"/>\n\n  <asset>\n${asset}\n  </asset>\n\n  <worldbody>\n    <body name="base">\n${meshNames.map((name, index) => `      <geom name="g${String(index)}" type="mesh" mesh="${name.replace(/\.STL$/i, "")}"/>`).join("\n")}\n    </body>\n  </worldbody>\n</mujoco>\n`)
  for (const name of meshNames) await writeFile(join(source, "meshes", name), syntheticStl(name))
  return { document: join(source, "arm.xml"), directory: source }
}

function robotEntity(sourcePath: string, meshFiles: string[], entityId = "robot-1", resourceId = "res_robot_1"): Entity {
  const uri = pathToFileURL(sourcePath).href
  return {
    entityId, name: entityId, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    resources: [{ resourceId, version: 1, original: { uri, mimeType: "application/x-mjcf+xml" }, representations: [{ uri, mimeType: "application/x-mjcf+xml", role: "simulation" }], source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 } }],
    components: {
      mujoco: { sourcePath, source: "user-import", meshdir: "meshes" },
      visual: { kind: "robot", robot: { format: "mjcf", baseUri: pathToFileURL(dirname(sourcePath) + "/").href, document: { compiler: { angle: "radian", meshdir: "meshes" }, asset: { mesh: meshFiles.map(name => ({ name: name.replace(/\.STL$/i, ""), file: name })) } } } },
    },
  } as unknown as Entity
}

const sceneOf = (entities: Entity[]): SceneSnapshot => ({ sceneId: SCENE, revision: 1, coordinates: { ...COORDINATES }, entities })

describe("resource 路由：用户导入的机器人（相对引用 + meshdir）", () => {
  test("① 出站投影把基址换成不可逆标记，文档引用仍是相对串：消费侧只能原样交出", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      const raw = sceneOf([robotEntity(document, ["pelvis.STL"])])
      const [submission] = viewerSubmissions(raw)
      const mesh = submission!.meshes[0]!
      expect(mesh.base.startsWith(RESOURCE_TOKEN_PREFIX)).toBe(true)                       // 基址是标记
      expect(mesh.base).toBe(resourceToken(pathToFileURL(dirname(document) + "/").href))   // 正是那份目录的指纹
      expect(mesh.locator).toBe("meshes/pelvis.STL")                                       // 相对引用**原样**交出
      expect(() => new URL(mesh.locator, mesh.base)).toThrow()                             // 标记当不了相对基准
    } finally { await harness.dispose() }
  })

  test("②③ 媒体路由按机器人文档目录解析该引用，回的是**磁盘上同一份字节**", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL", "torso_link.STL"])
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL", "torso_link.STL"])]))
      const [submission] = viewerSubmissions(sceneOf([robotEntity(document, ["pelvis.STL", "torso_link.STL"])]))
      expect(submission!.meshes.map(row => row.locator)).toEqual(["meshes/pelvis.STL", "meshes/torso_link.STL"])
      for (const mesh of submission!.meshes) {
        const read = await fetchResource(harness, SCENE, mesh.locator)
        expect(read.error).toBeUndefined()
        expect(read.status).toBe(200)
        const onDisk = await readFile(join(directory, "meshes", mesh.file))
        expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(createHash("sha256").update(onDisk).digest("hex"))
      }
    } finally { await harness.dispose() }
  })

  test("④ 生产侧（`robot-visual-assets` 的标记化）**够不着**的那一类：URDF 的相对 `<mesh filename>` 仍由本路由解析", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      // 生产侧那一层只认 MJCF 的 `document.asset` 段（URDF 的 `<mesh filename>` 没有 asset 段可读，
      // 也没有 `name` 键可保），所以这条引用到浏览器手里仍然是相对串 —— 只有路由能解析。
      const uri = pathToFileURL(document).href
      const urdf = {
        ...robotEntity(document, ["pelvis.STL"]),
        components: {
          mujoco: { sourcePath: document, source: "user-import" },
          visual: { kind: "robot", robot: { format: "urdf", baseUri: pathToFileURL(dirname(document) + "/").href, document: { link: { name: "base", visual: { geometry: { mesh: { filename: "meshes/pelvis.STL" } } } } } } },
        },
      } as unknown as Entity
      await writeScene(harness, sceneOf([urdf]))
      const read = await fetchResource(harness, SCENE, "meshes/pelvis.STL")
      expect(read.error).toBeUndefined()
      expect(read.status).toBe(200)
      const onDisk = await readFile(join(directory, "meshes", "pelvis.STL"))
      expect(createHash("sha256").update(read.bytes).digest("hex")).toBe(createHash("sha256").update(onDisk).digest("hex"))
      expect(resourceToken(uri)).not.toBe("")   // 文档本身仍是已授权件（依赖闭包就是从这里算出来的）
    } finally { await harness.dispose() }
  })

  test("④ 未授权件照样进不来：`..` 越界、域外绝对路径、域外 file: URI 都不放行", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      await writeFile(join(harness.root, "outside.STL"), syntheticStl("outside"))
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL"])]))
      expect((await fetchResource(harness, SCENE, "meshes/../../outside.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, join(harness.root, "outside.STL"))).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, pathToFileURL(join(harness.root, "outside.STL")).href)).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
    } finally { await harness.dispose() }
  })

  test("④ 解析得出来、但**没有**被任何已授权表示引用的同目录网格：仍然不放行", async () => {
    const harness = await boot()
    try {
      const { document, directory } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      await writeFile(join(directory, "meshes", "not-referenced.STL"), syntheticStl("not-referenced"))
      await writeScene(harness, sceneOf([robotEntity(document, ["pelvis.STL"])]))
      expect((await fetchResource(harness, SCENE, "meshes/not-referenced.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
      expect((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).status).toBe(200)
    } finally { await harness.dispose() }
  })

  test("④ 判据不足就失败：同一相对引用在两份机器人文档下解析出两份不同的已授权件 ⇒ 拒绝猜", async () => {
    const harness = await boot()
    try {
      const first = await layRobot(harness.root, "arm-a", ["pelvis.STL"])
      const second = await layRobot(harness.root, "arm-b", ["pelvis.STL"])
      await writeScene(harness, sceneOf([robotEntity(first.document, ["pelvis.STL"]), robotEntity(second.document, ["pelvis.STL"], "robot-2", "res_robot_2")]))
      expect(String((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).error)).toContain("RESOURCE_REFERENCE_AMBIGUOUS")
    } finally { await harness.dispose() }
  })

  test("④ 没有可用的机器人文档基准 ⇒ 精确回到 RESOURCE_NOT_REFERENCED_BY_SCENE（不猜基址）", async () => {
    const harness = await boot()
    try {
      const { document } = await layRobot(harness.root, "arm", ["pelvis.STL"])
      const entity = robotEntity(document, ["pelvis.STL"])
      // 抹掉两条基址线索（`mujoco.sourcePath` 与带 MJCF mimeType 的表示），模拟"判据缺失"。
      const blind = { ...entity, resources: [], components: { ...entity.components, mujoco: {} } } as unknown as Entity
      await writeScene(harness, sceneOf([blind]))
      expect((await fetchResource(harness, SCENE, "meshes/pelvis.STL")).error).toBe("RESOURCE_NOT_REFERENCED_BY_SCENE")
    } finally { await harness.dispose() }
  })
})

describe("静态对齐：宿主侧夹具里复刻的那一句必须与产品源码同形（行为面由 `workbench-import-surface.test.tsx` 真 import 覆盖）", () => {
  test("`workbench.tsx` 里 `viewerResourceURI` 的正则与夹具里那一份逐字相同", async () => {
    const source = await readFile(new URL("../src/workbench.tsx", import.meta.url), "utf8")
    const product = source.match(/export function viewerResourceURI\(uri:string\):string\{return (.*?)\}\n/)![1]!
    expect(product).toBe(String.raw`/^(res:[^?#]+)\?ext=\.[A-Za-z0-9]+$/.exec(uri)?.[1]??uri`)
    expect(viewerResourceURI("/x")).toBe("/x")
    expect(viewerResourceURI("res:abc?ext=.STL")).toBe("res:abc")
  })
})
