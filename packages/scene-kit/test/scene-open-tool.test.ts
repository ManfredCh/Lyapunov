/**
 * 67/73 接线测试：`scene_open` / `scene_save` / `scene_import` 在**真实 ToolRegistry / CommandRegistry**上的行为。
 *
 * 不 mock 注册表：Context + dsh-system-prompt + dsh-tools + dsh-session + dsh-commands + lyapunov-scene
 * 都是真的，参数 schema 校验、输出 schema 与 lossless-JSON 判据、`command/run`-`command/done` 记账
 * 都发生在真实运行时里。夹具是 48 实测失败件（`world/courtyard_gate_v3/scene.json`，123122 字节 / 79 实体）
 * 的**缩小切片**：实体结构与组件键按真件抄（visual mesh/collision box/camera/light/isaac、source.blend 原件
 * + visuals/*.glb 表示、源坐标 Y-up）——原件那份 `.blend` 也按真件来：由 Blender 现场生成一份合法空工程
 * （见下方 `blendFixtureBytes`），不用假字节冒充源工程，并**逐字节写出真件里的 `-0.0` token**（`JSON.stringify` 会把它写成 0，
 * 所以夹具是手写 JSON 文本，不是对象序列化）——这正是 DSH 判据拒收的那种值。
 *
 * 本文件覆盖三件真实失败（48 N1/N2，以及同一类相对路径缺陷在 `scene_import` 上的那一面）：
 * 1) 真 Blender world 件里 `transform.quaternion` 带 `-0.0`：载入已落库，回执却报
 *    `value is not lossless JSON`（第一次 open 失败、第二次 open 报重开冲突）。
 * 2) 相对 path 落进程 cwd（宿主代码根），不是会话工作区；`scene_save` 甚至会把文件写进安装目录。
 * 3) `scene_import` 的本地相对 path 同样按宿主 cwd 解析（`resources.import` 里的 `localPath`）。
 *    最后一节把进程 cwd 换成一个**放着同名诱饵文件**的目录，再按会话工作区里的那一份核对 sha256，
 *    证明读到的是会话工作区件而不是同名诱饵。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import Commands from "@deepseek-ai/dsh-commands"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools"
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { requireSessionId, sessionNamespace } from "../../lyapunov-contracts/src/session-scope.ts"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { blenderAvailable, blenderEnvironment, blenderExecutable } from "../src/blend-deps.ts"
import { localPath } from "../src/formats.ts"
import * as scenePlugin from "../src/plugin.ts"

const SCENE_ID = "courtyard_gate_8x6"
const RELATIVE_DOCUMENT = join("world", "courtyard_gate_v3", "scene.json")
const PORTABLE_DOCUMENT = join("deliverable", "scene.json")
const RELATIVE_ASSET = join("assets", "courtyard_wall.glb")
const signal = new AbortController().signal

/**
 * 夹具里的 `source.blend` 是一份**真的 Blender 源工程**（48 真件里原件就是它）：登记引用会问一次配置的
 * Blender 读它的外部依赖（依赖闭包读法，见 docs/PORTABLE_ENVIRONMENT.md），所以夹具本身必须合法——
 * 由 Blender 现场生成一份空工程（口径与 portable-environment.test.ts 相同：起 Blender 的用例显式给长
 * 超时，bun 默认 5s 会假超时）。本机没有 Blender 时依赖读数本就是 `unknown`、根本不会读这个文件，
 * 占位字节与真件等价（也不去假装"读得出"）。只生成一次，各用例复制同一份字节。
 */
let fixtureBlend: Promise<Buffer> | undefined
function blendFixtureBytes(): Promise<Buffer> {
  fixtureBlend ??= (async (): Promise<Buffer> => {
    if (!blenderAvailable()) return Buffer.from("BLENDER-v303 夹具原件\n".repeat(16))
    const sandbox = await mkdtemp(join(tmpdir(), "lyapunov-blend-fixture-"))
    const target = join(sandbox, "source.blend")
    // 空工程：没有对象、没有外部图片/链接库，于是它既合法又不需要任何依赖文件。
    const script = `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(target)}, compress=True)\n`
    try {
      await new Promise<void>((settle, fail) => execFile(blenderExecutable(), ["--background", "--factory-startup", "--python-exit-code", "1", "--python-expr", script], { env: blenderEnvironment(), timeout: 300_000 }, error => error ? fail(error) : settle()))
      return await readFile(target)
    } finally { await rm(sandbox, { recursive: true, force: true }) }
  })()
  return fixtureBlend
}
const blenderBudget = (name: string, fn: () => Promise<void>): void => { test(name, fn, 600_000) }
/** 落库位置按**会话命名空间**算（与本产品同一份规则）：工具落的是发起那次调用的会话那一份，
 *  不是 Host 级 `scenes/`——P0 之前这里写的是 `join(dataRoot, "scenes", …)`，那正是"所有会话共用一套"。 */
const storedScenePath = (target: Agent) => join(sessionNamespace(dataRoot, requireSessionId(target, "测试会话")), "scenes", `${SCENE_ID}.json`)
/** 便携保存必须起 Blender 读源工程（portable.ts 的 inspectBlend）；本机没有 Blender 时整条跳过。 */
const blenderOnly = (name: string, fn: () => Promise<void>): void => { (blenderAvailable() ? test : test.skip)(name, fn, 600_000) }

let base: string, dataRoot: string, workspace: string, world: string, ctx: Context, agent: Agent, calls = 0

/** 真件里 `-0.0` 的写法（手写 JSON：写出去必须是这个 token，不能是 `0`）。 */
const MINUS_ZERO = "-0.0"

/** 48 真件的缩小切片：同样的组件键、同样的源坐标声明、同样的 -0 位置（石狮/抱鼓石两个四元数）+ 相机方向里的嵌套 -0。 */
function documentText(): string {
  return JSON.stringify({
    sceneId: SCENE_ID,
    revision: 0,
    coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" },
    entities: [
      {
        entityId: "CourtyardGate_ROOT", name: "CourtyardGate_ROOT",
        transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        resources: [{
          resourceId: "fixture-courtyard_gate_8x6-usd", version: 1,
          original: { uri: "source.blend", mimeType: "application/x-blender" },
          representations: [{ uri: "isaac/architecture.usda", mimeType: "model/vnd.usd", role: "scene" }],
          source: { units: "m", upAxis: "Z", handedness: "right", metersPerUnit: 1 },
        }],
        components: { isaac: { sourcePath: "isaac/architecture.usda", importManifest: "isaac/import.json", collisionSource: "scene.json" } },
      },
      {
        entityId: "entity-wall-west", name: "院墙_西", parentId: "CourtyardGate_ROOT",
        transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        resources: [{
          resourceId: "fixture-wall-west-mesh", version: 1,
          original: { uri: "source.blend", mimeType: "application/x-blender" },
          representations: [{ uri: "visuals/wall_west.glb", mimeType: "model/gltf-binary", role: "visual" }],
          source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 },
        }],
        components: {
          visual: { kind: "mesh", sourceTransformApplied: true, blenderObject: "院墙_西" },
          collision: { type: "box", sizeM: [2.2, 0.45, 2.62], halfExtents: [1.1, 0.225, 1.31], source: "blender-primitive", role: "solid" },
        },
      },
      {
        // 真件 entities[60]：石狮_西，quaternion[2] = -0.0
        entityId: "entity-lion-west", name: "石狮_西", parentId: "CourtyardGate_ROOT",
        transform: { position: [-2.85, 0.38, 0], quaternion: [0.9981347918510437, -0.06104854494333267, MINUS_ZERO, 0], scale: [-1, -1, -1] },
        resources: [{
          resourceId: "fixture-lion-west-mesh", version: 1,
          original: { uri: "source.blend", mimeType: "application/x-blender" },
          representations: [{ uri: "visuals/lion_west.glb", mimeType: "model/gltf-binary", role: "visual" }],
          source: { units: "m", upAxis: "Y", handedness: "right", metersPerUnit: 1 },
        }],
        components: { visual: { kind: "mesh", sourceTransformApplied: false, blenderObject: "石狮_西" } },
      },
      {
        // 真件 entities[62]：抱鼓石顶狮_+1，quaternion[0] = quaternion[1] = -0.0
        entityId: "entity-drum-lion", name: "抱鼓石顶狮_+1", parentId: "CourtyardGate_ROOT",
        transform: { position: [1.44, 1.2, 1.35], quaternion: [MINUS_ZERO, MINUS_ZERO, -0.7071067690849304, 0.7071067690849304], scale: [0.22, 0.22, 0.22] },
        resources: [],
        components: { visual: { kind: "mesh", sourceTransformApplied: false, blenderObject: "抱鼓石顶狮_+1" } },
      },
      {
        // -0 不只在 transform 里：相机方向的嵌套分量同样会被判据拒收。
        entityId: "entity-cam-front", name: "cam_正立面",
        transform: { position: [0, -9.2, 2.1], quaternion: [0.6881821751594543, 0, 0, 0.7255379557609558], scale: [1, 1, 1] },
        resources: [],
        components: { camera: { lensMm: 42, sensorWidthMm: 36, fovYDeg: 31.89079185747693, direction: [MINUS_ZERO, 0.998605, -0.052811], isActive: true } },
      },
      {
        entityId: "entity-sun", name: "太阳",
        transform: { position: [0, 0, 0], quaternion: [0.4030582010746002, -0.12708376348018646, -0.27253201603865, 0.8643611073493958], scale: [1, 0.9999999403953552, 1] },
        resources: [],
        components: { light: { kind: "sun", color: [1, 0.95, 0.9], intensity: 3 } },
      },
    ],
  }, null, 2).split(`"${MINUS_ZERO}"`).join(MINUS_ZERO)
}

/** 最小合法 GLB：只有 JSON chunk（parseAsset 只核对 glTF 2.0 头与 chunk 长度自洽）。 */
function glbBytes(generator: string): Buffer {
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "墙" }], meshes: [{ primitives: [] }] }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

/** 夹具侧独立实现：`-0` 规范化（用来证明"只有 -0 变了"，不依赖被测代码）。 */
function withoutNegativeZero(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => Object.is(item, -0) ? 0 : withoutNegativeZero(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Object.is(item, -0) ? 0 : withoutNegativeZero(item)]))
}

function negativeZeroPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => Object.is(item, -0) ? [`${path}[${index}]`] : negativeZeroPaths(item, `${path}[${index}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => Object.is(item, -0) ? [`${path}.${key}`] : negativeZeroPaths(item, `${path}.${key}`))
}

async function composeSession(data: string, withCwd: boolean): Promise<{ ctx: Context; agent: Agent }> {
  const composed = new Context()
  await composed.plugin(SystemPrompt)
  await composed.plugin(Tools)
  await composed.plugin(Sessions)
  await composed.plugin(Commands)
  await composed.plugin(scenePlugin, { dataRoot: data })
  const session = composed.sessions.create(SessionId(`scene-open-${Math.trunc(Date.now() % 1e9)}`), withCwd ? { meta: { cwd: workspace } } : {})
  return { ctx: composed, agent: { id: session.id, session } as Agent }
}

async function callTool(name: string, input: unknown, target: Agent = agent): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({ callId: ToolCallId(`${name}-${++calls}`), name, arguments: { input }, signal, agent: target })
}

function valueOf(result: ToolExecutionResult): any {
  if (result.isError) throw new Error(`期望成功但工具失败：${result.error.message}`)
  return result.value
}

/** 模型真正看到的那段文本（output.render 的投影）。 */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("")
}

function entityOf(value: SceneSnapshot, entityId: string): Entity {
  const entity = value.entities.find(item => item.entityId === entityId)
  if (!entity) throw new Error(`缺少实体 ${entityId}`)
  return entity
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-open-"))
  dataRoot = join(base, "data")
  workspace = join(base, "workspace")
  world = join(workspace, "world", "courtyard_gate_v3")
  calls = 0
  await mkdir(join(world, "visuals"), { recursive: true })
  await mkdir(join(world, "isaac"), { recursive: true })
  await writeFile(join(world, "scene.json"), documentText())
  await writeFile(join(world, "source.blend"), await blendFixtureBytes())
  await writeFile(join(world, "visuals", "wall_west.glb"), glbBytes("fixture-wall"))
  await writeFile(join(world, "visuals", "lion_west.glb"), glbBytes("fixture-lion"))
  await writeFile(join(world, "isaac", "architecture.usda"), "#usda 1.0\n".repeat(8))
  await writeFile(join(world, "isaac", "import.json"), "{}\n")
  const composed = await composeSession(dataRoot, true)
  ctx = composed.ctx
  agent = composed.agent
  // 夹具要真的起一次 Blender（约 5 s，见 blendFixtureBytes 的说明）：bun 默认 5 s 的 hook 预算会把
  // 冷启动卡在边界上判成"hook 超时"，与用例本身无关。用例早就显式给了长超时，这里补齐同一个口径。
}, 60_000)

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe("scene_open / scene_save 的 Tool 接线（真实 ToolRegistry）", () => {
  test("夹具自检：磁盘上的 -0.0 token 真的解析成 -0（否则这份用例什么都没有证明）", async () => {
    const raw = await readFile(join(world, "scene.json"), "utf8")
    expect(raw.includes(MINUS_ZERO)).toBe(true)
    const parsed = JSON.parse(raw) as SceneSnapshot
    expect(negativeZeroPaths(parsed).length).toBeGreaterThanOrEqual(3)
    // 也确认 DSH 的判据确实拒收这种文档：夹具本身就是"会被判 invalid output"的输入。
    expect(snapshotJsonValue(parsed)).toBeUndefined()
  })

  blenderBudget("正例：相对路径 open 返回 lossless 的 scene-summary，只把 -0 写成 0，其余逐字段不变", async () => {
    const result = await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID })
    const snapshot = valueOf(result) as SceneSnapshot

    // 真实注册表的 lossless 判据（与 DSH 内部同一条实现）：这正是 48 里失败的那一步。
    expect(snapshotJsonValue(result.value)).toBeDefined()
    expect(negativeZeroPaths(snapshot)).toEqual([])
    expect(snapshot.sceneId).toBe(SCENE_ID)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entities.map(entity => entity.entityId)).toEqual([
      "CourtyardGate_ROOT", "entity-wall-west", "entity-lion-west", "entity-drum-lion", "entity-cam-front", "entity-sun",
    ])

    // -0 位置逐个核对：是真件里那两个四元数 + 相机方向的分量，现在都写成 0（数值语义不变）。
    expect(entityOf(snapshot, "entity-lion-west").transform.quaternion).toEqual([0.9981347918510437, -0.06104854494333267, 0, 0])
    expect(Object.is(entityOf(snapshot, "entity-lion-west").transform.quaternion[2], -0)).toBe(false)
    expect(entityOf(snapshot, "entity-drum-lion").transform.quaternion).toEqual([0, 0, -0.7071067690849304, 0.7071067690849304])
    expect((entityOf(snapshot, "entity-cam-front").components.camera as { direction: number[] }).direction).toEqual([0, 0.998605, -0.052811])

    // 除 -0 写法外逐字段不变：拿夹具自己的规范化结果比对，不相上下就说明没有悄悄改别的。
    const fixture = JSON.parse(await readFile(join(world, "scene.json"), "utf8")) as SceneSnapshot
    const canonicalFixture = withoutNegativeZero(fixture) as SceneSnapshot
    for (const [index, entity] of canonicalFixture.entities.entries()) {
      const actual = snapshot.entities[index]!
      expect(actual.entityId).toBe(entity.entityId)
      expect(actual.name).toBe(entity.name)
      expect(actual.parentId).toBe(entity.parentId)
      expect(actual.transform).toEqual(entity.transform)
      const expected = withoutNegativeZero(entity.components) as Entity["components"]
      // `open` 原有的另一条解析：引擎侧 sourcePath 也按场景文件位置还原成绝对路径（本次没改它）。
      const isaac = expected.isaac as { sourcePath?: string } | undefined
      if (isaac?.sourcePath) isaac.sourcePath = localPath(isaac.sourcePath, world)
      expect(actual.components).toEqual(expected)
    }
    expect((entityOf(snapshot, "CourtyardGate_ROOT").components.isaac as { sourcePath: string }).sourcePath).toBe(join(world, "isaac", "architecture.usda"))
    // 引用被解析成场景文件旁的绝对 file:// URI（原有行为），mime/role 逐条保留。
    const wall = entityOf(snapshot, "entity-wall-west")
    expect(wall.resources[0]!.original.uri).toBe(pathToFileURL(join(world, "source.blend")).href)
    expect(fileURLToPath(wall.resources[0]!.representations[0]!.uri)).toBe(join(world, "visuals", "wall_west.glb"))

    // 落库件与返回值同一份事实，且同样 lossless。
    const stored = JSON.parse(await readFile(storedScenePath(agent), "utf8")) as SceneSnapshot
    expect(snapshotJsonValue(stored)).toBeDefined()
    expect(negativeZeroPaths(stored)).toEqual([])
    expect(stored).toEqual(snapshot)

    // 模型看到的是 render 出来的 scene-summary，而不是原始 DTO。
    const view = JSON.parse(textOf(result)) as { kind: string; sceneId: string; entityCount: number; entities: unknown[] }
    expect(view.kind).toBe("scene-summary")
    expect(view.sceneId).toBe(SCENE_ID)
    expect(view.entityCount).toBe(6)
    expect(view.entities).toHaveLength(6)
  })

  blenderBudget("重复 open：同文件同 sceneId 幂等返回合法 summary，不报重开冲突、不写新 revision", async () => {
    const first = valueOf(await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID })) as SceneSnapshot
    const storedPath = storedScenePath(agent)
    const before = await readFile(storedPath, "utf8")

    const secondResult = await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID })
    const second = valueOf(secondResult) as SceneSnapshot
    expect(snapshotJsonValue(secondResult.value)).toBeDefined()
    expect(second).toEqual(first)
    expect(second.revision).toBe(0)
    expect(second.entities.map(entity => entity.entityId)).toEqual(first.entities.map(entity => entity.entityId))
    expect(await readFile(storedPath, "utf8")).toBe(before)

    // 绝对路径与相对路径指向同一事实（同一路径输入的两种写法）。
    const absolute = valueOf(await callTool("scene_open", { path: join(world, "scene.json"), sceneId: SCENE_ID })) as SceneSnapshot
    expect(absolute).toEqual(first)
  })

  blenderBudget("没有会话工作目录时相对路径明确报错，不落进程 cwd；绝对路径仍可用", async () => {
    const bare = await composeSession(join(base, "bare-data"), false)
    const relative = await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID }, bare.agent)
    expect(relative.isError).toBe(true)
    expect(relative.isError && relative.error.message).toContain("SCENE_CWD_UNRESOLVED")
    expect(relative.isError && relative.error.message).toContain(RELATIVE_DOCUMENT)

    const absolute = await callTool("scene_open", { path: join(world, "scene.json"), sceneId: SCENE_ID }, bare.agent)
    expect(valueOf(absolute)).toHaveProperty("sceneId", SCENE_ID)
  })

  blenderOnly("scene_save 相对路径写进会话工作区（不是进程 cwd），portable 件在另一个空 catalog 里可重开", async () => {
    valueOf(await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID }))
    const saved = valueOf(await callTool("scene_save", { sceneId: SCENE_ID, path: PORTABLE_DOCUMENT, portable: true })) as { path: string }
    expect(saved.path).toBe(join(workspace, PORTABLE_DOCUMENT))
    expect(resolve(saved.path)).not.toBe(resolve(process.cwd(), PORTABLE_DOCUMENT))
    expect(existsSync(saved.path)).toBe(true)
    expect(existsSync(join(dirname(saved.path), "resources"))).toBe(true)

    // Command 桥（模型之外的同一个接线面）：相对输入按同一个会话工作区解析。
    const bridged = await ctx.commands.execute(agent, `/scene_save ${JSON.stringify({ sceneId: SCENE_ID, path: PORTABLE_DOCUMENT, portable: true })}`, [], signal)
    expect(bridged?.result.kind).toBe("success")

    // 换一个空 catalog 打开 portable 件：sceneId/entityId/revision 不变，资源都在便携目录里闭合。
    const second = await composeSession(join(base, "portable-data"), true)
    const reopened = await second.ctx.tools.execute({ callId: ToolCallId("scene_open-portable"), name: "scene_open", arguments: { input: { path: saved.path, sceneId: SCENE_ID } }, signal, agent: second.agent })
    const snapshot = valueOf(reopened) as SceneSnapshot
    expect(snapshotJsonValue(reopened.value)).toBeDefined()
    expect(snapshot.sceneId).toBe(SCENE_ID)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entities.map(entity => entity.entityId)).toEqual([
      "CourtyardGate_ROOT", "entity-wall-west", "entity-lion-west", "entity-drum-lion", "entity-cam-front", "entity-sun",
    ])
    const portableRoot = dirname(saved.path) + sep
    for (const entity of snapshot.entities) for (const ref of entity.resources) for (const rep of [ref.original, ...ref.representations]) {
      expect(localPath(rep.uri).startsWith(portableRoot)).toBe(true)
      expect(existsSync(localPath(rep.uri))).toBe(true)
    }
    const wall = entityOf(snapshot, "entity-wall-west")
    // 便携件里 .blend 源工程的落点是 `sources/<源工程字节 sha256 前 16 位>/`（连同它的外部依赖按相对层级
    // 镜像；同一份字节在包里只落一份，见 docs/PORTABLE_ENVIRONMENT.md）；表示件（视觉 GLB）仍进
    // `resources/<resourceId>-v<version>/`，two-mime 结构保持完整。
    expect(existsSync(join(dirname(saved.path), "resources", "fixture-wall-west-mesh-v1"))).toBe(true)
    expect(localPath(wall.resources[0]!.original.uri)).toBe(join(dirname(saved.path), "sources", sha256Of(await blendFixtureBytes()).slice(0, 16), "source.blend"))
  })
})

/** 宿主进程 cwd 与任务工作区是两件事：这里把进程 cwd 换到别处，跑完（断言失败也）一定换回来。 */
async function inHostCwd<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(directory)
  try { return await body() } finally { process.chdir(previous) }
}

/**
 * 同名诱饵：宿主 cwd 与会话工作区各放一份相对路径相同的 GLB，内容不同——
 * 导入读到哪一份由 sha256 分辨，`resources.import` 里的 `localPath` 拿进程 cwd 当基准就会被抓住。
 */
async function plantDecoy(hostRoot: string): Promise<{ decoy: string; real: string }> {
  const decoy = join(hostRoot, RELATIVE_ASSET), real = join(workspace, RELATIVE_ASSET)
  await mkdir(dirname(decoy), { recursive: true })
  await mkdir(dirname(real), { recursive: true })
  await writeFile(decoy, glbBytes("decoy-in-host-cwd"))
  await writeFile(real, glbBytes("real-in-session-workspace"))
  return { decoy, real }
}

function sha256Of(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }

/** 导入回执里真正能分辨"读的是哪一份文件"的两个事实：入口依赖的内容哈希与原件落点。 */
interface ImportedResource { resource: { ref: { resourceId: string; original: { uri: string } }; name: string; parsed: { dependencies: Array<{ path: string; sha256: string }> } }; entityId?: string; snapshot?: SceneSnapshot }

describe("scene_import 的 Tool/Command 接线（相对 path 按会话工作区，不按宿主 cwd）", () => {
  test("Tool：相对 path 读会话工作区那一份，宿主 cwd 里的同名诱饵不被读到", async () => {
    const hostRoot = join(base, "host-cwd")
    const { decoy, real } = await plantDecoy(hostRoot)
    const decoyBytes = await readFile(decoy)
    expect(sha256Of(decoyBytes)).not.toBe(sha256Of(await readFile(real)))

    const value = await inHostCwd(hostRoot, async () => valueOf(await callTool("scene_import", {
      path: RELATIVE_ASSET, resourceId: "fixture-import-wall", name: "会话工作区里的墙", physicalize: false,
    })) as ImportedResource)

    // 参数其它字段原样保留：只有 path 经 sessionPath 解析，name/resourceId 就是调用方给的那两个。
    expect(value.resource.ref.resourceId).toBe("fixture-import-wall")
    expect(value.resource.name).toBe("会话工作区里的墙")
    // 内容级证据：入口字节 = 会话工作区那一份，不是同名诱饵。
    expect(value.resource.parsed.dependencies[0]!.sha256).toBe(sha256Of(await readFile(real)))
    expect(value.resource.parsed.dependencies[0]!.sha256).not.toBe(sha256Of(decoyBytes))
    // 原件落点也不在宿主 cwd 那棵树里（外部原件进 CAS，但无论如何不是诱饵）。
    expect(localPath(value.resource.ref.original.uri).startsWith(hostRoot + sep)).toBe(false)
    // 诱饵仍在原处、内容未变：本次导入确实没有碰它。
    expect(sha256Of(await readFile(decoy))).toBe(sha256Of(decoyBytes))
  })

  blenderBudget("Command：同一条解析；相对 path 导入后按 sceneId 直接挂载，实体来自会话工作区那一份", async () => {
    const hostRoot = join(base, "host-cwd")
    const { decoy, real } = await plantDecoy(hostRoot)
    const realSha = sha256Of(await readFile(real))
    valueOf(await callTool("scene_open", { path: RELATIVE_DOCUMENT, sceneId: SCENE_ID }))

    const bridged = await inHostCwd(hostRoot, () => ctx.commands.execute(agent, `/scene_import ${JSON.stringify({
      path: RELATIVE_ASSET, sceneId: SCENE_ID, resourceId: "fixture-import-wall-cmd", physicalize: false,
    })}`, [], signal))
    expect(bridged?.result.kind).toBe("success")
    const value = JSON.parse((bridged?.result as { text: string }).text) as ImportedResource
    expect(value.resource.ref.resourceId).toBe("fixture-import-wall-cmd")
    expect(value.resource.parsed.dependencies[0]!.sha256).toBe(realSha)
    expect(value.entityId).toBeDefined()
    expect(value.snapshot!.entities.some(entity => entity.entityId === value.entityId)).toBe(true)
    expect(sha256Of(await readFile(decoy))).not.toBe(realSha)
  })

  test("没有会话工作目录时相对 path 明确报错、不读诱饵；绝对路径仍可用", async () => {
    const hostRoot = join(base, "host-cwd")
    const { decoy, real } = await plantDecoy(hostRoot)
    const decoyBytes = await readFile(decoy)
    const bare = await composeSession(join(base, "bare-data"), false)

    const relative = await inHostCwd(hostRoot, () => callTool("scene_import", { path: RELATIVE_ASSET, physicalize: false }, bare.agent))
    expect(relative.isError).toBe(true)
    expect(relative.isError && relative.error.message).toContain("SCENE_CWD_UNRESOLVED")
    expect(relative.isError && relative.error.message).toContain(RELATIVE_ASSET)

    const absolute = await inHostCwd(hostRoot, async () => valueOf(await callTool("scene_import", {
      path: real, resourceId: "fixture-import-absolute", physicalize: false,
    }, bare.agent)) as ImportedResource)
    expect(absolute.resource.ref.resourceId).toBe("fixture-import-absolute")
    expect(absolute.resource.parsed.dependencies[0]!.sha256).toBe(sha256Of(await readFile(real)))
    // 两次调用之后诱饵仍未被动过：相对路径那次是"明确报错"，不是"悄悄读了宿主 cwd 的文件"。
    expect(sha256Of(await readFile(decoy))).toBe(sha256Of(decoyBytes))
  })
})
