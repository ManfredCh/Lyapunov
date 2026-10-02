/**
 * G10：内部工具调用真实 Blender 生成房间/桌子/方块/活动门，导出导入、保存重开。
 * 合同 §6.2 G10 通过条件：保留层级、源工程与可视内容；房间内部不被单凸包封死；需模拟部件可独立实例化。
 *
 * 本门只调**既有产品实现与既有可执行文件**，没有任何 mock / 手写 JSON / 静态断言：
 *  1) 真实 Blender 可执行文件跑产品建模脚本 `packages/blender/src/world.py --fixture`；
 *     argv 形状逐项对齐产品工具 `blender_run`（`packages/blender/src/plugin.ts`），结果行前缀在运行期从该
 *     插件源文件读回它自己的 `RESULT_PREFIX` 字面量（该常量未导出），不在这里另立一套结果协议。
 *  2) 第二个真实 Blender 进程打开导出的 `source.blend`，读对象/父子/自定义关节属性/网格顶点。
 *  3) `SceneOperations.open`（导出导入）→ `import`（可视 GLB）→ `save(portable)` → `open`（保存重开）。
 *  4) 真实 MuJoCo 双通道取证：产品 `MuJoCoProvider` 打开重开后的 Scene（门作为独立 articulation 实体、
 *     室内落体探针落到房间自身地板上）；再用 `.runtime/sim-python` 的真实 mujoco 直接读 Blender 导出的
 *     `physics/world.xml`（几何体计数与室内射线），与原始证据 `blender-physics.json` 同法同阈值。
 *
 * 诚实边界（本门**没有**覆盖，别当成已通过）：
 *  - 没有实体从室外穿过门洞进入室内的通行测试（探针只从室内自由落体，门只验证铰链独立动作）。
 *  - 没有比对可视 door_panel.glb 与 door.xml 里物理面板的几何一致性（视觉/物理是两条通道，只各自验证可用）。
 *  - 没有经 DSH 工具注册表调用 `blender_run` 工具体本身：本仓的 `@deepseek-ai/dsh-subprocess-local` 在 bun
 *    下无法加载（bun 1.3.13 缺 `node:util.getSystemErrorMessage`），故按插件同一 argv 直调同一产品脚本。
 *  - 没有跑 Blender 渲染/GPU 预览（`--render`）与 Isaac/USD 通道（属 G08/G09 范围）。
 *
 * 目录基准：本文件位于 `Dev/script/gates/`，故 PRODUCT_ROOT = `import.meta.dirname/../..`（集成进
 * `script/refactor-verify.ts` 时该推导同样成立，无需改相对深度）。
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { SceneOperations } from "../../packages/scene-kit/src/operations.ts"
import { MuJoCoProvider } from "../../packages/sim-mujoco/src/provider.ts"
import type { SimAction } from "../../packages/sim-contract/src/index.ts"
import type { Entity, Quaternion, SceneSnapshot } from "../../packages/lyapunov-contracts/src/types.ts"
import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "..", "..")
const WORLD_SCRIPT = join(PRODUCT_ROOT, "packages/blender/src/world.py")
const PLUGIN_SCRIPT = join(PRODUCT_ROOT, "packages/blender/src/plugin.ts")
const SIM_PYTHON = join(PRODUCT_ROOT, ".runtime/sim-python/bin/python")
const MUJOCO_WORKER = join(PRODUCT_ROOT, "packages/sim-mujoco/python/worker.py")
const REOPEN_PREFIX = "LYAPUNOV_G10_REOPEN="
const MJ_PREFIX = "LYAPUNOV_G10_MJ="

/** 原始证据夹具里的房间部件（`D-evidence/blender-world/physics/world.xml`，nbody=18 / ngeom=14）。 */
const ROOM_PARTS = ["floor", "wall_back", "wall_left", "wall_right", "front_left", "front_right", "door_lintel"]
const FURNITURE_PARTS = ["tabletop", "leg_-0.58_-0.33", "leg_-0.58_0.33", "leg_0.58_-0.33", "leg_0.58_0.33", "cube"]
/** 门的关节目标/容差/时长取自原始回执 `D-evidence/blender-scene-sim.ts`（target .7 rad、tolerance .02）。 */
const DOOR_TARGET_RAD = 0.7
const DOOR_TOLERANCE_RAD = 0.02
/** 室内探针：与原始证据 walk_probe 同尺寸（0.36×0.36×0.72 → 半高 0.36），落点判据用该半高 ±0.02 m。 */
const PROBE_HALF_EXTENTS: [number, number, number] = [0.18, 0.18, 0.36]
const PROBE_START_Z = 1.2
const PROBE_REST_TOLERANCE_M = 0.02

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** 真实子进程；stdout/stderr 有上限，超时 SIGKILL，退出码与两路输出原样带回。 */
function run(argv: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number } = {}): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 4_000_000
  return new Promise((settle, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = [], err: Buffer[] = []
    let outBytes = 0, errBytes = 0, timedOut = false
    child.stdout.on("data", (chunk: Buffer) => { if (outBytes < maxBytes) { out.push(chunk); outBytes += chunk.length } })
    child.stderr.on("data", (chunk: Buffer) => { if (errBytes < maxBytes) { err.push(chunk); errBytes += chunk.length } })
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, options.timeoutMs) : undefined
    child.once("error", error => { if (timer) clearTimeout(timer); reject(error) })
    child.once("close", code => { if (timer) clearTimeout(timer); settle({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut }) })
  })
}

/**
 * Blender 启动方式。产品工具默认用 PATH 里的 `blender`；本服务的 cgroup 内 snapd 无法创建 transient
 * scope（真实 stderr 会写进 BLOCKED），因此优先直调 snap 载荷并补齐它自己的库路径——仍是同一个真实
 * Blender 二进制。调用方显式给 `BLENDER_EXECUTABLE` 时以调用方为准。
 */
function blenderLaunch(): { executable: string; env: NodeJS.ProcessEnv; note: string } {
  const configured = process.env.BLENDER_EXECUTABLE?.trim()
  // HF_ENDPOINT 与产品工具 blender_run 给子进程的 env 保持一致（镜像配置，不发起任何下载）。
  if (configured) return { executable: configured, env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com" }, note: "BLENDER_EXECUTABLE" }
  const snap = "/snap/blender/current"
  if (existsSync(join(snap, "blender"))) {
    const library = [join(snap, "lib"), join(snap, "usr/lib"), join(snap, "usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")
    return { executable: join(snap, "blender"), env: { ...process.env, LD_LIBRARY_PATH: library, ALSOFT_DRIVERS: "-oss,-alsa,", SDL_AUDIODRIVER: "pulseaudio", HF_ENDPOINT: "https://hf-mirror.com" }, note: "snap 载荷直调（snap run 在本服务 cgroup 内失败）" }
  }
  return { executable: "blender", env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com" }, note: "PATH 中的 blender" }
}

/** 真实 GLB 头部读数：magic/版本/声明长度 + JSON chunk 里的 mesh/accessor 数（不看文件名猜内容）。 */
async function glbSummary(path: string) {
  const bytes = await readFile(path)
  const magic = bytes.subarray(0, 4).toString("ascii")
  const version = bytes.readUInt32LE(4)
  const declared = bytes.readUInt32LE(8)
  const chunkLength = bytes.readUInt32LE(12)
  const chunkType = bytes.readUInt32LE(16)
  let meshes = 0, accessors = 0
  if (chunkType === 0x4e4f534a) {
    const json = JSON.parse(bytes.subarray(20, 20 + chunkLength).toString("utf8")) as { meshes?: unknown[]; accessors?: unknown[] }
    meshes = json.meshes?.length ?? 0
    accessors = json.accessors?.length ?? 0
  }
  return { bytes: bytes.length, magic, version, declared, meshes, accessors }
}

/** 两个 xyzw 四元数之间的姿态夹角（rad）。 */
function rotationDeltaRad(a: Quaternion, b: Quaternion): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return 2 * Math.acos(Math.min(1, dot))
}

/**
 * 结果行前缀由产品工具 `blender_run` 自己定义（`packages/blender/src/plugin.ts` 的 `RESULT_PREFIX`，
 * 该常量未导出）。运行期从产品源文件读回真实字面量再解析：既不在这里另立协议，产品改名时也会明确失败。
 */
async function readResultPrefix(): Promise<string> {
  const source = await readFile(PLUGIN_SCRIPT, "utf8")
  return /RESULT_PREFIX\s*=\s*'([^']+)'/.exec(source)?.[1] ?? ""
}

function tail(text: string, limit = 600): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

/** 便携工程目录的递归文件清单（相对路径），用于核对随包内容而不是只看顶层。 */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, next))
    else files.push(next)
  }
  return files.sort()
}

/** 组件访问器：snapshot 里 components 是自由记录，按需窄化并保持缺项可见。 */
const componentOf = <T>(entity: Entity | undefined, key: string): T | undefined => entity?.components?.[key] as T | undefined

export async function gateG10(): Promise<GateResult> {
  const checks: Check[] = []
  const directory = await mkdtemp(join(tmpdir(), "lyaup-g10-"))
  const worldDir = join(directory, "blender-world")
  const scenes = new SceneOperations(join(directory, "scene-kit"), PRODUCT_ROOT)
  const provider = new MuJoCoProvider({ pythonPath: SIM_PYTHON, workerPath: MUJOCO_WORKER })
  let blocked: string | null = null

  try {
    // ── 1) 真实 Blender 可执行文件 ────────────────────────────────────────────────
    const launch = blenderLaunch()
    let version: RunResult
    try {
      version = await run([launch.executable, "--version"], { env: launch.env, timeoutMs: 120_000 })
    } catch (error) {
      checks.push({ name: "blender_binary", ok: false, detail: `无法启动 ${launch.executable}：${String((error as Error)?.message ?? error)}` })
      return { gate: "G10", checks, blocked: `真实 Blender 不可用：${launch.executable} 启动失败（${launch.note}）` }
    }
    const versionLine = version.stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("Blender ")) ?? ""
    checks.push({ name: "blender_binary", ok: version.code === 0 && versionLine.length > 0, detail: `executable=${launch.executable}（${launch.note}）exitCode=${version.code} version=${versionLine || "无版本行"} stderr=${tail(version.stderr, 200) || "空"}` })
    if (version.code !== 0 || !versionLine) return { gate: "G10", checks, blocked: `真实 Blender 二进制不可执行：exitCode=${version.code} stderr=${tail(version.stderr, 400)}` }

    // ── 2) 真实建模：房间/桌子/方块/活动门（argv 与产品 blender_run 工具一致）──────
    const resultPrefix = await readResultPrefix()
    checks.push({ name: "blender_result_contract", ok: resultPrefix.length > 0, detail: `结果行前缀运行期取自产品工具源文件 packages/blender/src/plugin.ts：${resultPrefix || "未找到 RESULT_PREFIX 声明"}` })
    if (!resultPrefix) return { gate: "G10", checks, blocked: `无法从产品工具 ${PLUGIN_SCRIPT} 读回结果行前缀，拒绝猜协议解析 Blender 输出` }

    const buildArgv = [launch.executable, "--background", "--factory-startup", "--python", WORLD_SCRIPT, "--", "--output", worldDir, "--fixture"]
    const build = await run(buildArgv, { env: launch.env, timeoutMs: 900_000 })
    const resultLine = build.stdout.split("\n").reverse().find(line => line.startsWith(resultPrefix))
    interface BlenderResult { source: string; scene: string; entities: number; visuals: number; physics: string; resourceNamespace: string; resourceVersion: number }
    let result: BlenderResult | undefined
    if (resultLine) { try { result = JSON.parse(resultLine.slice(resultPrefix.length)) as BlenderResult } catch { result = undefined } }
    checks.push({
      name: "blender_fixture_build",
      ok: build.code === 0 && result !== undefined,
      detail: `argv=[${["blender", ...buildArgv.slice(1).map(a => a.startsWith(directory) ? a.replace(directory, "<tmp>") : a)].join(" ")}] exitCode=${build.code} timedOut=${build.timedOut} entities=${result?.entities ?? "无"} visuals=${result?.visuals ?? "无"} physics=${result ? result.physics.replace(directory, "<tmp>") : "无结果行"} resourceNamespace=${result?.resourceNamespace ?? "无"} resourceVersion=${result?.resourceVersion ?? "无"} stderr=${tail(build.stderr, 300) || "空"}`,
    })
    if (build.code !== 0 || !result) return { gate: "G10", checks, blocked: `真实 Blender 未产出世界工程：exitCode=${build.code} timedOut=${build.timedOut} stderr=${tail(build.stderr, 600) || "（空）"}` }

    // ── 3) 导出物：源工程 + 层级快照 + 物理 + 每对象可视 GLB ─────────────────────
    const sceneFile = join(worldDir, "scene.json")
    const worldXml = join(worldDir, "physics/world.xml")
    const blendFile = join(worldDir, "source.blend")
    const visualNames = (await readdir(join(worldDir, "visuals"))).filter(name => name.endsWith(".glb")).sort()
    const blendSize = (await stat(blendFile)).size
    const summaries = await Promise.all(visualNames.map(name => glbSummary(join(worldDir, "visuals", name))))
    const glbMeshes = summaries.reduce((sum, item) => sum + item.meshes, 0)
    const glbWellFormed = summaries.every(item => item.magic === "glTF" && item.version === 2 && item.declared === item.bytes && item.meshes > 0)
    checks.push({
      name: "blender_exports_present",
      ok: blendSize > 0 && summaries.length === result.visuals && glbWellFormed,
      detail: `source.blend=${blendSize}B scene.json=${(await stat(sceneFile)).size}B world.xml=${(await stat(worldXml)).size}B glb=${summaries.length}/${result.visuals} glTF2完好=${glbWellFormed} 网格总数=${glbMeshes} 首个=${visualNames[0] ?? "无"}(${summaries[0]?.bytes ?? 0}B,meshes=${summaries[0]?.meshes ?? 0},accessors=${summaries[0]?.accessors ?? 0})`,
    })

    // ── 4) 第二个真实 Blender 进程重开源工程：层级/自定义关节/网格内容 ─────────────
    // N352b：额外读**世界位姿**与动态标记——导出器对动态刚体做世界位姿提升（`world.py:660-664`：freejoint
    // 必须位于 worldbody 直属，故动态实体按 `matrix_world` 提升为根并去掉 parentId），判据需要用它做提升不变量断言。
    const reopenExpr = `import bpy,json;print("${REOPEN_PREFIX}"+json.dumps({"filepath":bpy.data.filepath,"scene":bpy.context.scene.name,"version":bpy.app.version_string,"objects":{o.name:{"type":o.type,"parent":(o.parent.name if o.parent else None),"vertices":(len(o.data.vertices) if o.type=="MESH" else 0),"materials":([m.name for m in o.data.materials] if o.type=="MESH" else []),"joint":o.get("lyapunov_joint"),"axis":(list(o.get("lyapunov_axis")) if o.get("lyapunov_axis") else None),"range":(list(o.get("lyapunov_range")) if o.get("lyapunov_range") else None),"dynamic":bool(o.get("lyapunov_dynamic")),"world_position":[round(v,6) for v in o.matrix_world.to_translation()],"world_quaternion":[round(v,6) for v in (lambda q:(q.x,q.y,q.z,q.w))(o.matrix_world.to_quaternion())],"world_scale":[round(v,6) for v in o.matrix_world.to_scale()]} for o in bpy.data.objects}},ensure_ascii=False))`
    const reopen = await run([launch.executable, "--background", blendFile, "--python-expr", reopenExpr], { env: launch.env, timeoutMs: 300_000 })
    interface ReopenObject { type: string; parent: string | null; vertices: number; materials: string[]; joint: string | null; axis: number[] | null; range: number[] | null; dynamic: boolean; world_position: number[]; world_quaternion: number[]; world_scale: number[] }
    interface ReopenResult { filepath: string; scene: string; version: string; objects: Record<string, ReopenObject> }
    const reopenLine = reopen.stdout.split("\n").reverse().find(line => line.startsWith(REOPEN_PREFIX))
    let reopenedBlend: ReopenResult | undefined
    if (reopenLine) { try { reopenedBlend = JSON.parse(reopenLine.slice(REOPEN_PREFIX.length)) as ReopenResult } catch { reopenedBlend = undefined } }
    const objects = reopenedBlend?.objects ?? {}
    const door = objects["door"]
    checks.push({
      name: "blender_reopen_source_project",
      ok: reopen.code === 0 && reopenedBlend !== undefined && resolve(reopenedBlend.filepath) === resolve(blendFile) && door?.joint === "hinge" && door.parent === "room" && (door.range ?? []).join(",") === "0,1.57",
      detail: `exitCode=${reopen.code} filepath=${reopenedBlend?.filepath ?? "无"} blender=${reopenedBlend?.version ?? "无"} objects=${Object.keys(objects).length}（scene.json 实体=${result.entities} + 相机/灯光=${Object.keys(objects).length - result.entities}）door.parent=${String(door?.parent)} door.joint=${String(door?.joint)} door.axis=[${(door?.axis ?? []).join(",")}] door.range=[${(door?.range ?? []).join(",")}] door_panel.parent=${String(objects["door_panel"]?.parent)} table.parent=${String(objects["table"]?.parent)} cube.parent=${String(objects["cube"]?.parent)} stderr=${tail(reopen.stderr, 200) || "空"}`,
    })
    const meshes = Object.values(objects).filter(object => object.type === "MESH")
    const vertices = meshes.reduce((sum, object) => sum + object.vertices, 0)
    const withMaterial = meshes.filter(object => object.materials.length > 0).length
    checks.push({
      name: "blender_reopen_visual_content",
      ok: meshes.length > 0 && vertices > 0 && withMaterial === meshes.length,
      detail: `网格对象=${meshes.length} 顶点总数=${vertices} 带材质=${withMaterial}/${meshes.length}（door_panel=${objects["door_panel"]?.vertices} 顶点 cube=${objects["cube"]?.vertices} 顶点）相机/灯光=${Object.values(objects).filter(o => o.type === "CAMERA" || o.type === "LIGHT").length}`,
    })

    // ── 5) scene-kit 收进 Scene（导出导入）──────────────────────────────────────
    const imported: SceneSnapshot = await scenes.open(sceneFile, { sceneId: "verify-g10" })
    const parentOf = (snapshot: SceneSnapshot, entityId: string) => snapshot.entities.find(entity => entity.entityId === entityId)?.parentId ?? null
    // N352b 判据对齐（依据 `packages/blender/src/world.py:660-664` 的提升语义 + N352 探针实测）：
    // 动态刚体在导出时被**按世界位姿提升为根**（freejoint 必须在 worldbody 直属），scene.json 因此**没有** parentId。
    // 所以层级比对只对**静态实体**要求"父子与 source.blend 一致"；动态实体改判**提升不变量**：
    //   ① 源工程里它确实挂在父节点下（不是野生对象）；② 导入后 parentId 为空；
    //   ③ 导入后的 transform 与源工程 `matrix_world` 分解出的世界位姿一致（位置/四元数/缩放，容差 1e-6）；
    //   ④ world.xml 里它是 `<worldbody>` 的直接子 body 且体内有 `<freejoint`（freejoint 位置约束）。
    const dynamicEntities = imported.entities.filter(entity => {
      const rigid = componentOf<{ type?: string }>(entity, "rigidBody")
      return rigid?.type === "dynamic"
    })
    const dynamicIds = new Set(dynamicEntities.map(entity => entity.entityId))
    const hierarchyMismatch = imported.entities.filter(entity => !dynamicIds.has(entity.entityId) && (objects[entity.entityId]?.parent ?? null) !== (entity.parentId ?? null))
    const expectedParents = [["door", "room"], ["door_panel", "door"], ["table", "room"], ["tabletop", "table"], ["cube", "room"], ["floor", "room"]] as const
    const wrongEdges = expectedParents.filter(([child, parent]) => !dynamicIds.has(child) && parentOf(imported, child) !== parent)
    const near = (left: number[] | undefined, right: number[] | undefined, tolerance = 1e-6) =>
      Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Math.abs(value - right[index]!) <= tolerance)
    const worldXmlText = await readFile(worldXml, "utf8")
    const worldbodyChildren = (() => { // worldbody 的**直接**子 body 名（深度扫描，不按字符串出现位置猜）
      const open = worldXmlText.indexOf("<worldbody>")
      if (open < 0) return [] as string[]
      const tag = /<(\/?)([A-Za-z_][\w:-]*)([^>]*?)(\/?)>/g
      tag.lastIndex = open + "<worldbody>".length
      const names: string[] = []
      let depth = 0, match: RegExpExecArray | null
      while ((match = tag.exec(worldXmlText)) !== null) {
        if (match[4] === "/") continue
        if (match[1] === "/") { depth--; continue }
        if (depth === 0 && match[2] === "body") { const name = /name="([^"]*)"/.exec(match[3] ?? "")?.[1]; if (name) names.push(name) }
        depth++
      }
      return names
    })()
    const promotion = dynamicEntities.map(entity => {
      const source = objects[entity.entityId]
      const worldPose = source ? { position: source.world_position, quaternion: source.world_quaternion, scale: source.world_scale } : undefined
      const bodySlice = (() => { const at = worldXmlText.indexOf(`<body name="${entity.entityId}"`); return at < 0 ? "" : worldXmlText.slice(at, worldXmlText.indexOf("</body>", at) + 7) })()
      return {
        entityId: entity.entityId,
        sourceParent: source?.parent ?? null,
        importParent: parentOf(imported, entity.entityId),
        sourceDynamic: source?.dynamic ?? null,
        poseMatches: near(entity.transform?.position, worldPose?.position) && near(entity.transform?.quaternion, worldPose?.quaternion) && near(entity.transform?.scale, worldPose?.scale),
        worldbodyChild: worldbodyChildren.includes(entity.entityId),
        hasFreejoint: bodySlice.includes("<freejoint"),
      }
    })
    const promotionOk = promotion.length > 0 && promotion.every(row => row.sourceParent !== null && row.sourceDynamic === true && row.importParent === null && row.poseMatches && row.worldbodyChild && row.hasFreejoint)
    checks.push({
      name: "scene_import_hierarchy_kept",
      ok: imported.entities.length === result.entities && hierarchyMismatch.length === 0 && wrongEdges.length === 0 && promotionOk,
      detail: `实体=${imported.entities.length}/${result.entities} revision=${imported.revision} 与 source.blend 父子不一致=${hierarchyMismatch.length} 关键边=[${expectedParents.map(([child, parent]) => `${child}→${parentOf(imported, child)}`).join(" ")}] 错误边=${wrongEdges.map(([child, parent]) => `${child}≠${parent}`).join(",") || "无"}；动态提升不变量=${promotionOk} ${dynamicEntities.length} 个动态实体（源工程父节点/scene 侧父/世界位姿吻合/worldbody 直属/freejoint）：${promotion.map(row => `${row.entityId}(源父=${String(row.sourceParent)} scene父=${String(row.importParent)} 位姿吻合=${row.poseMatches} worldbody=${row.worldbodyChild} freejoint=${row.hasFreejoint})`).join(" ") || "无"}`,
    })
    const importedDoor = imported.entities.find(entity => entity.entityId === "door")
    const articulation = componentOf<{ joints?: Array<{ name: string; type: string; axis: number[]; range: number[] }> }>(importedDoor, "articulation")
    const joint = articulation?.joints?.[0]
    const nativeComponent = componentOf<{ sourcePath?: string; rootBody?: string }>(importedDoor, "mujoco")
    const nativePath = nativeComponent?.sourcePath ?? ""
    let nativeExists = false
    try { await access(nativePath) ; nativeExists = true } catch { nativeExists = false }
    const physicsRep = importedDoor?.resources.flatMap(ref => ref.representations).find(rep => rep.mimeType === "application/mjcf+xml")
    checks.push({
      name: "simulation_part_is_native_instance",
      ok: joint?.type === "hinge" && joint.name === "door_hinge" && (joint.range ?? []).join(",") === "0,1.57" && nativeExists && Boolean(physicsRep),
      detail: `door.articulation=${joint ? `${joint.name}/${joint.type} axis=[${joint.axis.join(",")}] range=[${joint.range.join(",")}]` : "无"} door.components.mujoco=${nativePath.replace(directory, "<tmp>")}（rootBody=${String(nativeComponent?.rootBody)} 存在=${nativeExists}）物理表示=${physicsRep ? physicsRep.uri.replace(directory, "<tmp>") : "无"} door_panel.physicsOwner=${String(componentOf(imported.entities.find(entity => entity.entityId === "door_panel"), "blender:physicsOwner"))}`,
    })
    const meshEntities = imported.entities.filter(entity => entity.resources.some(ref => ref.representations.some(rep => rep.mimeType === "model/gltf-binary")))
    // N352b 判据对齐（依据 `world_incremental.py:326`+`:357-365` 的**冻结快照** vs `world.py:654`/`:800` 的**活工程**）：
    // 同一个 `original` 字段产品内有两套约定——可视资源指向导出时的冻结快照 `sources/<ns>-r<rev>.blend`
    // （注释原文"此后永不改写"），物理/USD 资源指向活工程 `source.blend`。判据因此**两类都认**，但都要求：
    // uri 落在导出目录的这两类路径里、且文件**真实存在可读**（不是"文件名像"就算过）。
    const blendSources = new Map<string, string>()
    for (const name of await listFiles(worldDir)) if (name.endsWith(".blend")) blendSources.set(resolve(join(worldDir, name)), name)
    const sourceProjectRefs = meshEntities.filter(entity => entity.resources.some(ref => {
      if (ref.original.mimeType !== "application/x-blender") return false
      const local = fileURLToPath(ref.original.uri)
      if (!blendSources.has(resolve(local))) return false
      return existsSync(local)
    }))
    const liveProjectRefs = sourceProjectRefs.filter(entity => entity.resources.some(ref => resolve(fileURLToPath(ref.original.uri)) === resolve(blendFile)))
    const frozenSnapshotRefs = sourceProjectRefs.length - liveProjectRefs.length
    checks.push({
      name: "source_project_reference_kept",
      ok: meshEntities.length === result.visuals && sourceProjectRefs.length === meshEntities.length,
      detail: `可视实体=${meshEntities.length}/${result.visuals} 其原件引用落在导出目录的 .blend 且可读的=${sourceProjectRefs.length}（活工程 source.blend=${liveProjectRefs.length} 冻结快照 sources/*.blend=${frozenSnapshotRefs}）导出目录 .blend 清单=[${[...blendSources.values()].join(",") || "无"}] 例：${imported.entities.find(entity => entity.entityId === "cube")?.resources[0]?.original.uri.replace(directory, "<tmp>") ?? "无"}`,
    })

    // "导出导入"的另一半：Blender 导出的可视 GLB 走产品 scene-kit 的资源导入路径进 Scene。
    // 用独立小场景，不扰动上面的层级用例；physicalize:false 保持"纯视觉也能用"（合同 §6.2 G02 口径）。
    // 环境脆弱点（N351 定位）：导出件按**资源 id** 命名（`<ns>-mesh-<obj>-<hash>-mesh-v1.glb`），
    // 不存在字面名 `door_panel.glb`；旧写法每次都 ENOENT（并连带掐断后续归档）。改为从已导入世界场景里
    // door_panel 实体的资源 id 反查 visuals/ 下的真实文件——只改**文件名解析**，判据与断言一字未动。
    const doorPanelResourceId = imported.entities.find(entity => entity.entityId === "door_panel")?.resources[0]?.resourceId
    const doorPanelGlb = visualNames.find(name => doorPanelResourceId !== undefined && name.startsWith(doorPanelResourceId))
    if (!doorPanelGlb) throw new Error(`G10 找不到 door_panel 的可视 GLB：resourceId=${String(doorPanelResourceId)}（visuals 共 ${visualNames.length} 个）`)
    const glbScene = await scenes.create({ sceneId: "verify-g10-visual", name: "g10-visual" })
    const glbImported = await scenes.import({ path: join(worldDir, "visuals", doorPanelGlb), sceneId: glbScene.sceneId, entityId: "door_panel_visual", physicalize: false })
    const glbStamp = glbImported.resource.parsed.dependencies[0]
    checks.push({
      name: "exported_visual_imports_into_scene",
      ok: glbImported.resource.parsed.kind === "mesh" && glbImported.entityId === "door_panel_visual" && glbImported.snapshot?.entities.some(entity => entity.entityId === "door_panel_visual") === true && Boolean(glbStamp?.sha256),
      detail: `import(visuals/${doorPanelGlb}) → kind=${glbImported.resource.parsed.kind} mime=${glbImported.resource.ref.original.mimeType} entity=${String(glbImported.entityId)} revision=${glbImported.snapshot?.revision} 产品解析 meshCount=${String(glbImported.resource.parsed.metadata.meshCount)} nodes=${Array.isArray(glbImported.resource.parsed.metadata.nodes) ? glbImported.resource.parsed.metadata.nodes.length : "?"} CAS sha256=${glbStamp?.sha256?.slice(0, 16) ?? "无"}… 字节=${glbStamp?.size ?? "?"}`,
    })

    // ── 6) 保存（portable）→ 重开：层级/源工程/可视内容都还在 ─────────────────────
    const portablePath = join(directory, "portable", "scene.json")
    const saved = await scenes.save("verify-g10", portablePath, { portable: true })
    const reopened: SceneSnapshot = await scenes.open(portablePath, { sceneId: "verify-g10-reopened" })
    const shape = (snapshot: SceneSnapshot) => snapshot.entities.map(entity => ({
      entityId: entity.entityId, parentId: entity.parentId ?? null,
      resources: entity.resources.map(ref => `${ref.resourceId}@${ref.version}:${ref.original.mimeType}:${ref.representations.map(rep => rep.mimeType).join("+")}`).sort(),
    })).sort((left, right) => left.entityId.localeCompare(right.entityId))
    const identical = JSON.stringify(shape(imported)) === JSON.stringify(shape(reopened))
    const portableRoot = join(directory, "portable")
    const portableFiles = await listFiles(portableRoot)
    const portableBlend = portableFiles.filter(name => name.endsWith(".blend"))
    const portableGlb = portableFiles.filter(name => name.endsWith(".glb"))
    const portablePhysics = portableFiles.filter(name => name.endsWith(".xml"))
    // N352b 判据对齐：随包 `.blend` **本来就该有两份不同来源**（活工程逐字节副本 + `world_incremental.py:357-365`
    // 的冻结快照，Blender `save_as_mainfile(copy=True)` 重存 ⇒ 比活工程大 20 B 级）。因此不再要求"每份都等于
    // 活工程大小"（旧判据 `every(size === blendSize)`，会把合法的第二份判成失败），改为**逐份对照它自己的来源**：
    //   ① 在导出目录里按同名文件找到它的来源；② 副本与来源 **sha256 相同**（逐字节一致）；
    //   ③ 便携布局 `sources/<sha16>/…` 的目录名前缀 == 该文件的 sha256 前 16 位（哈希目录约定）；
    //   ④ 至少含一份 `source.blend` 的副本（活工程必须在包里）。判据强度不降：从"一个大小数字"换成逐份字节比对。
    const exportBlendByName = new Map<string, string>()
    for (const name of await listFiles(worldDir)) if (name.endsWith(".blend")) exportBlendByName.set(name.split("/").pop()!, join(worldDir, name))
    const sha256Of = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")
    const blendProvenance = await Promise.all(portableBlend.map(async relative_ => {
      const packaged = join(portableRoot, relative_)
      const own = exportBlendByName.get(relative_.split("/").pop()!)
      const digest = await sha256Of(packaged)
      const ownDigest = own ? await sha256Of(own) : undefined
      const dirPrefix = /^sources\/([0-9a-f]{16})\//.exec(relative_)?.[1]
      return { relative: relative_, bytes: (await stat(packaged)).size, ownSource: own ? own.slice(worldDir.length + 1) : null, sha256: digest, ownSha256: ownDigest ?? null, matchesOwnSource: ownDigest !== undefined && ownDigest === digest, hashDirMatches: dirPrefix === undefined ? null : digest.startsWith(dirPrefix) }
    }))
    const blendCopiesIntact = blendProvenance.length > 0
      && blendProvenance.every(item => item.matchesOwnSource && item.hashDirMatches !== false)
      && blendProvenance.some(item => item.relative.split("/").pop() === "source.blend")
    const fileRefs = reopened.entities.flatMap(entity => entity.resources.flatMap(ref => [ref.original, ...ref.representations])).filter(rep => rep.uri.startsWith("file:"))
    let readable = 0, external = 0
    for (const rep of fileRefs) {
      const local = fileURLToPath(rep.uri)
      try { await access(local); readable++ } catch { /* 计入差值 */ }
      if (!resolve(local).startsWith(resolve(portableRoot) + "/")) external++
    }
    const reopenedNativePath = componentOf<{ sourcePath?: string }>(reopened.entities.find(entity => entity.entityId === "door"), "mujoco")?.sourcePath ?? ""
    if (reopenedNativePath && !resolve(reopenedNativePath).startsWith(resolve(portableRoot) + "/")) external++
    checks.push({
      name: "save_reopen_hierarchy_and_refs_intact",
      ok: saved.missing.length === 0 && identical && readable === fileRefs.length && external === 0 && blendCopiesIntact && portableGlb.length === result.visuals,
      detail: `portable=${portablePath.replace(directory, "<tmp>")} missing=${saved.missing.length} 与导入时结构一致=${identical} 随包文件=${portableFiles.length}（blend×${portableBlend.length} 逐份对照自身来源=${blendCopiesIntact} glb×${portableGlb.length}/${result.visuals} physics-xml×${portablePhysics.length}）文件引用可读=${readable}/${fileRefs.length} 仍指向便携目录之外的引用=${external} 实体=${reopened.entities.length}；逐份 provenance=[${blendProvenance.map(item => `${item.relative}(${item.bytes}B 来源=${String(item.ownSource)} 与来源同 sha=${item.matchesOwnSource} 哈希目录=${String(item.hashDirMatches)})`).join(" ")}]`,
    })
    const reopenedDoor = reopened.entities.find(entity => entity.entityId === "door")
    const reopenedNative = componentOf<{ sourcePath?: string }>(reopenedDoor, "mujoco")?.sourcePath ?? ""
    const reopenedJoint = componentOf<{ joints?: Array<{ name: string; type: string; range: number[] }> }>(reopenedDoor, "articulation")?.joints?.[0]
    let reopenedNativeExists = false
    try { await access(reopenedNative); reopenedNativeExists = true } catch { reopenedNativeExists = false }
    checks.push({
      name: "reopen_keeps_simulation_part",
      ok: reopenedNativeExists && reopenedJoint?.name === "door_hinge" && reopenedJoint.type === "hinge" && parentOf(reopened, "door") === "room" && parentOf(reopened, "door_panel") === "door",
      detail: `重开后 door.components.mujoco=${reopenedNative.replace(directory, "<tmp>")}（存在=${reopenedNativeExists}）articulation=${reopenedJoint ? `${reopenedJoint.name}/${reopenedJoint.type} range=[${reopenedJoint.range.join(",")}]` : "无"} door.parent=${parentOf(reopened, "door")} door_panel.parent=${parentOf(reopened, "door_panel")}`,
    })

    // ── 7) 真实 MuJoCo 打开重开后的 Scene：门独立实例化 + 室内不被封死 ─────────────
    if (!existsSync(SIM_PYTHON)) return { gate: "G10", checks, blocked: `MuJoCo 运行时不存在：${SIM_PYTHON}` }
    // 探针是一次**真实场景编辑**（SceneStore CAS 提交），不是内存里拼的假场景：
    // 半高 0.36 m 与原始证据 walk_probe 同尺寸，从室内 1.2 m 高处自由落体。
    const committed = await scenes.scene.commit({
      sceneId: "verify-g10-reopened", expectedRevision: reopened.revision,
      patch: [{
        op: "add",
        entity: {
          entityId: "interior_probe", name: "室内落体探针", parentId: "room",
          transform: { position: [1.6, 0.9, PROBE_START_Z], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
          resources: [], components: { collision: { shape: "box", halfExtents: PROBE_HALF_EXTENTS, friction: [1, 0.05, 0.001] }, rigidBody: { type: "dynamic", massKg: 0.15 } },
        },
      }],
    })
    // ground:false —— 不铺默认地面，落点若成立只能来自房间自己的地板盒（封死的单凸包会把它顶在包体顶面）。
    const world = await provider.open(committed, { ground: false })
    const describe = await provider.describe(world.worldId, "door")
    checks.push({
      name: "mujoco_world_ready",
      ok: world.status === "ready" && world.engineId === "mujoco" && describe.joints.length > 0,
      detail: `status=${world.status} engine=${world.engineId}@${world.engineVersion} generation=${world.worldGeneration} appliedSceneRevision=${world.appliedSceneRevision} clock=${String(world.clock)} timestepS=${String(world.timestepS)} warnings=${(world.warnings ?? []).map(warning => `${warning.code}:${warning.entityId ?? "-"}`).join(",") || "无"}`,
    })
    const before = await provider.observe(world.worldId, { contacts: true })
    const doorBefore = before.entities.find(entity => entity.entityId === "door")
    const cubeBefore = before.entities.find(entity => entity.entityId === "cube")
    checks.push({
      name: "door_described_as_articulation",
      ok: describe.joints.some(item => item.name === "door_hinge" && item.type === "hinge" && item.controlMode === "position") && (describe.joints.find(item => item.name === "door_hinge")?.range ?? []).join(",") === "0,1.57",
      detail: `describe(door)=joints[${describe.joints.map(item => `${item.name}/${item.type}/${item.controlMode}@${item.actuator} range=[${(item.range ?? []).join(",")}]`).join("; ")}] controlledJointNames=[${describe.controlledJointNames.join(",")}] freeBases=${(describe.freeBases ?? []).length} 世界实体=${before.entities.length}（scene 实体=${committed.entities.length}，纯视觉父节点按 Provider 告警跳过）`,
    })

    const openReceipt = await provider.execute(world.worldId, { actionId: `verify-g10-door-open-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "door", jointNames: ["door_hinge"], positions: [DOOR_TARGET_RAD], durationS: 1.5, tolerance: DOOR_TOLERANCE_RAD } satisfies SimAction)
    const mid = await provider.observe(world.worldId, { contacts: true })
    const doorMid = mid.entities.find(entity => entity.entityId === "door")
    const hingeMid = doorMid?.joints?.positions[doorMid.joints.names.indexOf("door_hinge")] ?? Number.NaN
    const turned = doorBefore && doorMid ? rotationDeltaRad(doorBefore.transform.quaternion, doorMid.transform.quaternion) : Number.NaN
    checks.push({
      name: "door_articulates_independently",
      ok: openReceipt.status === "completed" && Number.isFinite(hingeMid) && Math.abs(hingeMid - DOOR_TARGET_RAD) <= DOOR_TOLERANCE_RAD && turned > 0.1,
      detail: `receipt.status=${openReceipt.status} startStep=${openReceipt.startStep} endStep=${openReceipt.endStep} door_hinge实测=${hingeMid} 目标=${DOOR_TARGET_RAD} 误差=${Math.abs(hingeMid - DOOR_TARGET_RAD)} 容差=${DOOR_TOLERANCE_RAD}（取自原始回执 blender-scene-sim.ts）姿态变化=${turned} rad door_panel随动=同属 door 原件`,
    })
    const closeReceipt = await provider.execute(world.worldId, { actionId: `verify-g10-door-close-${Date.now()}`, expectedGeneration: world.worldGeneration, kind: "joint", entityId: "door", jointNames: ["door_hinge"], positions: [0], durationS: 1.0, tolerance: DOOR_TOLERANCE_RAD } satisfies SimAction)
    const after = await provider.observe(world.worldId, { contacts: true })
    const doorAfter = after.entities.find(entity => entity.entityId === "door")
    const hingeAfter = doorAfter?.joints?.positions[doorAfter.joints.names.indexOf("door_hinge")] ?? Number.NaN
    const cubeAfter = after.entities.find(entity => entity.entityId === "cube")
    const cubeShift = cubeBefore && cubeAfter ? Math.hypot(...cubeBefore.transform.position.map((value, index) => value - cubeAfter.transform.position[index]!) as [number, number]) : Number.NaN
    checks.push({
      name: "articulation_does_not_drag_other_entities",
      ok: closeReceipt.status === "completed" && Number.isFinite(hingeAfter) && Math.abs(hingeAfter) <= DOOR_TOLERANCE_RAD && Number.isFinite(cubeShift) && cubeShift < 0.001,
      detail: `关门 receipt.status=${closeReceipt.status} door_hinge回到=${hingeAfter}（容差 ${DOOR_TOLERANCE_RAD}）桌上方块位移=${cubeShift} m（两个动作合计 2.5 s 物理时间）世界步进=${after.stepIndex} simTime=${after.simTime}`,
    })

    const probeAfter = after.entities.find(entity => entity.entityId === "interior_probe")
    const probeZ = probeAfter?.transform.position[2] ?? Number.NaN
    const probeX = probeAfter?.transform.position[0] ?? Number.NaN
    const probeY = probeAfter?.transform.position[1] ?? Number.NaN
    const contacts = (after.contacts ?? []).map(contact => `${contact.geom1}|${contact.geom2}`)
    const floorContact = contacts.some(pair => pair.includes("interior_probe/geom") && pair.includes("floor/geom"))
    checks.push({
      name: "room_interior_not_sealed_by_single_hull",
      ok: Number.isFinite(probeZ) && Math.abs(probeZ - PROBE_HALF_EXTENTS[2]) <= PROBE_REST_TOLERANCE_M && floorContact,
      detail: `探针从 z=${PROBE_START_Z} 落体 → (${probeX.toFixed(3)},${probeY.toFixed(3)},${probeZ.toFixed(6)})，半高=${PROBE_HALF_EXTENTS[2]} 容差=${PROBE_REST_TOLERANCE_M}；落在房间自身地板盒上=${floorContact}；ground:false（无默认地面垫底）；本帧接触对=[${contacts.join(",")}]；若室内被单个封死凸包占据，探针只能停在包体顶面（z≈2.6）或腔外`,
    })

    // ── 8) 同一 world.xml 的直接 MuJoCo 读数（与原始证据 blender-physics.json 同法）──
    const script = join(directory, "interior_probe.py")
    await writeFile(script, [
      "import json, sys",
      "import numpy as np",
      "import mujoco",
      "m = mujoco.MjModel.from_xml_path(sys.argv[1])",
      "d = mujoco.MjData(m)",
      "for _ in range(int(sys.argv[2])):",
      "    mujoco.mj_step(m, d)",
      "bodies = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, i) for i in range(m.nbody)]",
      "joints = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, i) for i in range(m.njnt)]",
      "def ray(pnt, vec):",
      "    geomid = np.zeros(1, dtype=np.int32)",
      "    dist = float(mujoco.mj_ray(m, d, np.array(pnt, dtype=float), np.array(vec, dtype=float), None, True, -1, geomid))",
      "    gid = int(geomid[0])",
      "    return {'geom': gid, 'body': None if gid < 0 else bodies[m.geom_bodyid[gid]], 'distM': dist}",
      `print("${MJ_PREFIX}" + json.dumps({`,
      "    'mujocoVersion': mujoco.__version__, 'nbody': int(m.nbody), 'ngeom': int(m.ngeom), 'njnt': int(m.njnt),",
      "    'bodies': bodies, 'joints': joints, 'steps': int(sys.argv[2]), 'simTime': float(d.time),",
      "    'cubeZ': float(d.qpos[2]) if m.nq >= 3 else None,",
      "    'upwardFromInterior': ray([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]),",
      "    'towardBackWall': ray([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),",
      "    'downwardFromInterior': ray([0.0, 0.0, 1.0], [0.0, 0.0, -1.0]),",
      "}))",
    ].join("\n"), "utf8")
    const mjRun = await run([SIM_PYTHON, script, worldXml, "900"], { timeoutMs: 300_000 })
    interface MjRay { geom: number; body: string | null; distM: number }
    interface MjResult { mujocoVersion: string; nbody: number; ngeom: number; njnt: number; bodies: string[]; joints: string[]; steps: number; simTime: number; cubeZ: number | null; upwardFromInterior: MjRay; towardBackWall: MjRay; downwardFromInterior: MjRay }
    const mjLine = mjRun.stdout.split("\n").reverse().find(line => line.startsWith(MJ_PREFIX))
    let mj: MjResult | undefined
    if (mjLine) { try { mj = JSON.parse(mjLine.slice(MJ_PREFIX.length)) as MjResult } catch { mj = undefined } }
    const requiredBodies = [...ROOM_PARTS, ...FURNITURE_PARTS, "door", "door_panel"]
    const missingBodies = mj ? requiredBodies.filter(name => !mj.bodies.includes(name)) : requiredBodies
    // 判据来源：原始证据 blender-physics.json 对同一夹具记录 nbody=18 / ngeom=14 / roomInteriorUpwardRayDistanceM=-1.0；
    // 单凸包封死时房间只会有 1 个几何体，这里要求每个作者部件各占一个 body/geom 且室内射线打到真实内表面。
    checks.push({
      name: "world_is_multi_part_not_single_hull",
      ok: mj !== undefined && mj.ngeom >= 12 && mj.nbody >= 16 && missingBodies.length === 0 && mj.upwardFromInterior.distM < 0 && mj.towardBackWall.body === "wall_back" && mj.towardBackWall.distM > 1.5,
      detail: `真实 mujoco ${mj?.mujocoVersion ?? "?"} 直读 physics/world.xml：nbody=${mj?.nbody ?? "?"} ngeom=${mj?.ngeom ?? "?"} njnt=${mj?.njnt ?? "?"}（原始证据同夹具记录 18/14/2）joints=[${mj?.joints.join(",") ?? ""}] 缺失部件=[${missingBodies.join(",") || "无"}] steps=${mj?.steps ?? "?"} simTime=${mj?.simTime ?? "?"}；室内 (0,0,1) 向上射线命中=${mj ? `${mj.upwardFromInterior.geom} dist=${mj.upwardFromInterior.distM}` : "?"}（无天花板，复现证据 roomInteriorUpwardRayDistanceM=-1.0）；向 +Y 射线打到 ${mj?.towardBackWall.body ?? "?"} 内表面 dist=${mj?.towardBackWall.distM ?? "?"} m（作者坐标 2.0-0.06=1.94）；向下射线打到 ${mj?.downwardFromInterior.body ?? "?"} dist=${mj?.downwardFromInterior.distM ?? "?"} m；stderr=${tail(mjRun.stderr, 200) || "空"}`,
    })
    if (mj === undefined) checks.push({ name: "mujoco_direct_probe", ok: false, detail: `真实 mujoco 读 world.xml 未产出结果行：exitCode=${mjRun.code} stdout=${tail(mjRun.stdout, 300)} stderr=${tail(mjRun.stderr, 400)}` })

    // 本门未覆盖的项写在文件头「诚实边界」里，不在此处补静态断言充数。
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    await provider.dispose().catch(() => undefined)
    // §6.1「每个验收必须留下什么」：临时目录一删，行为证据就只剩回执文本。
    // 覆盖审计把这条点名为缺口，所以这里在**删除之前**把便携产物的清单、字节数与内容哈希
    // 归档到 `bugfixHistory/refactor-execution/evidence/G10/<UTC>/manifest.json`。
    // 只存清单与哈希，不搬二进制大件：这样"那次跑到底产出了什么"可被事后核对，
    // 又不把 GB 级产物塞进仓库（同时避免触碰用户资产）。
    try {
      const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z")
      const archiveDir = join(PRODUCT_ROOT, "bugfixHistory/refactor-execution/evidence/G10", stamp)
      await mkdir(archiveDir, { recursive: true })
      const portableRoot = join(directory, "portable")
      const files = await listFiles(portableRoot).catch(() => [] as string[])
      const entries: Array<{ relative: string; bytes: number; sha256: string }> = []
      for (const relative of files) {
        const absolute = join(portableRoot, relative)
        try {
          const info = await stat(absolute)
          if (!info.isFile()) continue
          const digest = createHash("sha256").update(await readFile(absolute)).digest("hex")
          entries.push({ relative, bytes: info.size, sha256: digest })
        } catch { /* 竞态：跳过 */ }
      }
      await writeFile(join(archiveDir, "manifest.json"), JSON.stringify({
        gate: "G10",
        archivedAt: stamp,
        sourceDirectory: "<mkdtemp 已清理>",
        portableFileCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        files: entries,
        checks: checks.map(check => ({ name: check.name, ok: check.ok })),
      }, null, 2) + "\n")
      checks.push({
        name: "evidence_archived_before_cleanup",
        ok: entries.length > 0,
        detail: `便携产物清单已归档：${entries.length} 个文件 / 共 ${entries.reduce((sum, entry) => sum + entry.bytes, 0)} 字节 → evidence/G10/${stamp}/manifest.json（含逐文件 sha256）；临时目录随后清理`,
      })
    } catch (error) {
      checks.push({ name: "evidence_archived_before_cleanup", ok: false, detail: `产物归档失败：${String((error as Error)?.message ?? error)}` })
    }
    await rm(directory, { recursive: true, force: true })
  }
  return { gate: "G10", checks, blocked }
}
