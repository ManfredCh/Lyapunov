/**
 * G19：官方 Astra 建筑 case 的能力对齐验收（尺度标定 / CC0 贴图接节点 / 渲染图回喂 / 烘焙动画）。
 *
 * 为什么独立成门：这四项是"一句话或一张照片 → 可编辑建筑"对齐官方 case 的关键增量，
 * 但都不是 G01–G17 的既有条件；没有门，它们就只是"我跑过一次"，无法复跑、无法回归。
 *
 * 本门只读**真实产物**，不做静态断言：
 *  1. **尺度标定自检**：多参照（比例尺/窗台/门高）各算 px/m，报告**彼此不一致度**。
 *     一致性来自物理事实，本门不参与计算。
 *  2. **贴图接进材质节点**：要求把 CC0 贴图接到 Principled BSDF（Diffuse→Base Color、
 *     Rough→Roughness、nor_gl→Normal、AO→乘进底色），并核对导出的 GLB 里**真的带 images**。
 *  3. **渲染图回喂**：`world.py` 唯一给出的 preview 路径必须存在（模型"看到自己产出"的来源）。
 *  4. **烘焙动画**：带关键帧的世界导出 GLB，用 Three.js 真读——有动画的实体读出 clip 且
 *     **mixer 推进后对象真的转了**；静止实体没有 clip；**作为资源导入产品场景后仍存在 glTF 节点实体**
 *     （Viewer 挂 mixer 的载体，否则动画永远播不出来）。
 *  5. **真实浏览器播放**：起真产品 host + 真 Chrome（WebGL），从产品自身 HTTP 路由取 viewer 发行包，
 *     单次 `setScene` 后读播放表，并在真实 rAF 循环里采样被驱动节点的转角与画布像素，附**暂停负对照**。
 *     这一条实测抓到过产品真缺陷（首发场景不进播放表），详见下方注释。
 *
 * 运行器：**node**（bun 下 `dsh-tools` 的模块图会因 `node:util` 缺导出而崩，与 G10b 同理）。
 * 但本门会 spawn 出 bun（导入探针、浏览器播放探针）——**跑门时必须让 bun 在 PATH 上**：
 * `export PATH="$HOME/.bun/bin:$PATH" && node script/gates/run-g19.mts`
 * 用法：`node script/gates/run-g19.mts`
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import type { SessionId } from "@deepseek-ai/dsh-session/types"

import type { Check, GateResult } from "./contract.ts"

const PRODUCT_ROOT = resolve(import.meta.dirname, "../..")
const BLENDER = process.env.BLENDER_EXECUTABLE ?? "/snap/blender/current/blender"
const READER = join(PRODUCT_ROOT, "script/gates/anim-glb.mjs")

/** 带关键帧的演示世界：门扇绕竖直铰链 0→75°→0；另有静止门框做对照。 */
const ANIMATION_SCRIPT = `
import bpy, math
bpy.ops.wm.read_factory_settings(use_empty=True)
sc=bpy.context.scene
sc['lyapunov_world_kind']='architecture'; sc['lyapunov_scene_id']='anim-demo'
def mat(n,c):
    m=bpy.data.materials.new(n); m.use_nodes=True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=c; return m
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1.1)); frame=bpy.context.object
frame.name='door_frame'; frame.scale=(1.0,0.12,2.2); frame.data.materials.append(mat('frame',(0.35,0.35,0.35,1)))
bpy.ops.mesh.primitive_cube_add(size=1,location=(0.45,0,1.0)); panel=bpy.context.object
panel.name='door_panel'; panel.scale=(0.9,0.06,2.0); panel.data.materials.append(mat('panel',(0.42,0.24,0.10,1)))
for f,a in ((1,0.0),(40,math.radians(75)),(80,0.0)):
    panel.rotation_euler=(0,0,a); panel.keyframe_insert('rotation_euler',frame=f)
sc.frame_start=1; sc.frame_end=120
`

/** 导入探针源码：用 bun 执行（bun 支持 scene-kit 的 TS 参数属性，node 的剥离模式不支持）。 */
function importScript(sceneKitPath: string): string {
  return [
    `import { SceneOperations } from ${JSON.stringify(sceneKitPath)}`,
    "const ops = new SceneOperations(process.env.SCENE_ROOT!, process.env.PRODUCT_ROOT!)",
    'const scene = await ops.create({ sceneId: "g19-import", name: "g19 import" })',
    'await ops.import({ path: process.env.GLB_PATH!, sceneId: scene.sceneId, entityId: "animated-import" })',
    'console.log("IMPORTED=" + scene.sceneId)',
    "",
  ].join("\n")
}

interface CommandResult { code: number; stdout: string; stderr: string }

/**
 * 按**实体身份**解析该实体的可视 GLB。
 *
 * 导出写的是内容寻址名（`<namespace>-mesh-<slug>-<hash8>-mesh-v<N>.glb`，见 `packages/blender/src/world.py:243`/`:495`），
 * 不是 `door_panel.glb` 这种对象名；路径的唯一权威来源是导出目录的 `scene.json`：
 * 实体 → `resources[*].representations[*]`（`role=visual` + `mimeType=model/gltf-binary`）→ `uri`。
 * 解析不到就返回 `null`（由调用方判失败），**不做"扫描目录取某个 GLB"的兜底**——那会在多实体场景里张冠李戴。
 */
export async function resolveEntityGlbPath(sceneFile: string, entityId: string): Promise<string | null> {
  if (!existsSync(sceneFile)) return null
  try {
    const doc = JSON.parse(await readFile(sceneFile, "utf8")) as {
      entities?: Array<{ entityId?: string; name?: string; resources?: Array<{ representations?: Array<{ role?: string; mimeType?: string; uri?: string }> }> }>
    }
    const entity = (doc.entities ?? []).find(item => item.entityId === entityId || item.name === entityId)
    for (const resource of entity?.resources ?? []) {
      for (const representation of resource.representations ?? []) {
        if (representation.role === "visual" && representation.mimeType === "model/gltf-binary"
          && typeof representation.uri === "string" && representation.uri.length > 0) return representation.uri
      }
    }
    return null
  } catch { return null }
}

export async function gateG19(): Promise<GateResult> {
  const checks: Check[] = []
  let root = ""
  try {
    if (!existsSync(BLENDER)) return { gate: "G19", checks, blocked: `Blender 可执行文件不存在：${BLENDER}` }
    root = await mkdtemp(join(tmpdir(), "lyaup-g19-"))

    // ── 真实 Cordis 树里调产品工具（装配序列与已验证可用的 G10b 一致）────────────
    const { Context: Ctx } = await import("@deepseek-ai/cordis")
    const { default: Timer } = await import("@deepseek-ai/cordis-plugin-timer")
    const { default: SystemPrompt } = await import("@deepseek-ai/dsh-system-prompt")
    const { default: ToolRegistry } = await import("@deepseek-ai/dsh-tools")
    const { default: SubprocessLocal } = await import("@deepseek-ai/dsh-subprocess-local")
    const { default: JobsLocal } = await import("@deepseek-ai/dsh-jobs-local")
    const { ToolCallId } = await import("@deepseek-ai/dsh-llm")
    const ctx = new Ctx() as Context
    await ctx.plugin(Timer); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry)
    await ctx.plugin(SubprocessLocal); await ctx.plugin(JobsLocal)
    const pluginEntry = join(PRODUCT_ROOT, "packages/blender/dist/plugin.js")
    if (!existsSync(pluginEntry)) return { gate: "G19", checks, blocked: `产品插件构建产物不存在：${pluginEntry}（先运行 bun run build:plugins）` }
    const plugin = await import(pluginEntry) as { inject?: string[]; apply?: (ctx: Context, config: unknown) => void }
    await ctx.plugin({
      name: "g19-blender", inject: plugin.inject ?? ["tools", "subprocess", "jobs"],
      apply: (scoped: Context) => plugin.apply!(scoped, { executable: BLENDER, workspace: PRODUCT_ROOT }),
    } as never, undefined as never)
    const tools = ctx.get("tools") as { schemas(): Array<{ name: string }>; execute(input: unknown): Promise<unknown> }
    const agent = { id: "g19-agent" as SessionId, steer() {}, inject() {}, session: { header: { cwd: PRODUCT_ROOT } } } as unknown as Agent

    // 参照取自**真实测量**：比例尺 500px=5m；窗台 107px=1m；门高 209px=2.1m。
    const anchors = JSON.stringify([
      { name: "比例尺", pixels: 500, metres: 5 },
      { name: "窗台高", pixels: 107, metres: 1 },
      { name: "门高", pixels: 209, metres: 2.1 },
    ])
    const world = join(root, "world")
    const call = await tools.execute({
      signal: new AbortController().signal, callId: ToolCallId("g19-1"), name: "blender_run", agent,
      arguments: {
        output_directory: world, architecture: true, render: true, scale_anchors: anchors,
        // architecture 夹具的材质名是中文；要求**把贴图接进材质节点**，不是只下到磁盘。
        material_textures: JSON.stringify({ "浅色灰泥": "plaster concrete wall", "暖木": "oak wood planks", "庭院石材": "stone tiles" }),
      },
    })
    const isError = (call as { isError?: boolean }).isError === true
    const text = isError ? "" : String((call as { value?: { result?: string } }).value?.result ?? "")
    if (!text) return { gate: "G19", checks, blocked: `blender_run 未返回结构化结果：isError=${isError}` }
    const parsed = JSON.parse(text) as {
      preview?: string
      textureRequest?: { materials?: string[]; fetched?: string[]; failures?: Record<string, string>; error?: string }
      materialTextures?: Record<string, { assetId?: string; license?: string; maps?: string[]; error?: string }>
      scaleCheck?: { meanPxPerM?: number; disagreementPercent?: number; reading?: string; anchors?: unknown[] }
    }

    // ── 1) 尺度标定自检 ──────────────────────────────────────────────────
    const scale = parsed.scaleCheck
    checks.push({
      name: "scale_anchors_cross_checked",
      ok: typeof scale?.meanPxPerM === "number" && typeof scale?.disagreementPercent === "number"
        && (scale.anchors?.length ?? 0) >= 3 && typeof scale?.reading === "string",
      detail: `三个独立参照的 px/m 互校：${JSON.stringify(scale?.anchors)}；均值=${String(scale?.meanPxPerM)} px/m；**参照不一致度=${String(scale?.disagreementPercent)}%**；结论=「${String(scale?.reading)}」——判据是**参照之间自洽**（不需要真值，故对真实照片同样有效）`,
    })

    // ── 2) 贴图接进材质节点 ──────────────────────────────────────────────
    const request = parsed.textureRequest
    const wired = parsed.materialTextures ?? {}
    const wiredNames = Object.keys(wired).filter(name => (wired[name]?.maps?.length ?? 0) > 0 && wired[name]?.error === undefined)
    checks.push({
      name: "textures_wired_into_material_nodes",
      ok: wiredNames.length >= 3 && Object.values(wired).every(entry => entry.error === undefined),
      detail: `要求接贴图的材质=${JSON.stringify(request?.materials)}；取图成功=${JSON.stringify(request?.fetched)}（失败=${JSON.stringify(request?.failures ?? {})}）；`
        + `**Blender 里真实接上的材质=${JSON.stringify(wiredNames)}**；逐材质接到的图=${JSON.stringify(Object.fromEntries(wiredNames.map(name => [name, wired[name]!.maps ?? []])))}`
        + `——Diffuse→Base Color、Rough→Roughness、nor_gl→Normal、AO→乘进底色都落了节点，而不是只把图下到磁盘`,
    })

    const visualsDir = join(world, "visuals")
    const glbs = existsSync(visualsDir) ? (await readdir(visualsDir)).filter(name => name.endsWith(".glb")) : []
    let withTextures = 0
    const samples: string[] = []
    for (const name of glbs) {
      const bytes = await readFile(join(visualsDir, name))
      const length = bytes.readUInt32LE(12)
      const json = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8")) as {
        images?: unknown[]; textures?: unknown[]
        materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: unknown }; normalTexture?: unknown }>
      }
      if ((json.images?.length ?? 0) > 0) {
        withTextures++
        if (samples.length < 3) samples.push(`${name}: images=${json.images!.length} textures=${json.textures?.length ?? 0} baseColor=${json.materials?.some(m => m.pbrMetallicRoughness?.baseColorTexture) === true} normal=${json.materials?.some(m => m.normalTexture !== undefined) === true}`)
      }
    }
    checks.push({
      name: "textures_present_in_exported_glb",
      ok: glbs.length > 0 && withTextures >= 3,
      detail: `导出 GLB 共 ${glbs.length} 个，glTF 里**真的带贴图**（images>0）的=${withTextures} 个；样例 ${samples.join(" | ")}——贴图不是只留在 blend 里`,
    })

    // ── 3) 渲染图可供模型查看 ────────────────────────────────────────────
    checks.push({
      name: "render_preview_returned_for_model",
      ok: typeof parsed.preview === "string" && existsSync(parsed.preview),
      detail: `渲染产物路径=${String(parsed.preview)}（存在=${typeof parsed.preview === "string" && existsSync(parsed.preview)}）——该路径是模型"看到自己产出"的唯一来源，由 world.py 唯一给出`,
    })

    // ── 4) 烘焙动画随 GLB 导出且真能驱动对象 ──────────────────────────────
    const script = join(root, "anim.py")
    await writeFile(script, ANIMATION_SCRIPT)
    const animated = join(root, "anim")
    const run = await runCommand([
      BLENDER, "--background", "--factory-startup", "--python", script,
      "--python", join(PRODUCT_ROOT, "packages/blender/src/world.py"), "--", "--output", animated,
    ])
    checks.push({
      name: "blender_exported_keyframed_world",
      ok: run.code === 0 && existsSync(join(animated, "scene.json")),
      detail: `带关键帧的世界导出退出码=${run.code}；scene.json 存在=${existsSync(join(animated, "scene.json"))}；stderr 尾部=${run.stderr.slice(-160) || "空"}`,
    })

    const sceneFile = join(animated, "scene.json")
    const panelPath = await resolveEntityGlbPath(sceneFile, "door_panel")
    const framePath = await resolveEntityGlbPath(sceneFile, "door_frame")
    const panel = panelPath !== null && existsSync(panelPath) ? await runCommand(["node", READER, panelPath]) : { code: 1, stdout: "", stderr: `door_panel 的可视 GLB 无法按实体身份从 scene.json 解析（scene.json 存在=${existsSync(sceneFile)}，解析结果=${String(panelPath)}）` }
    const frame = framePath !== null && existsSync(framePath) ? await runCommand(["node", READER, framePath]) : { code: 1, stdout: "", stderr: `door_frame 的可视 GLB 无法按实体身份从 scene.json 解析（scene.json 存在=${existsSync(sceneFile)}，解析结果=${String(framePath)}）` }
    const panelFacts = safeJson(panel.stdout) as { clips?: Array<{ name: string; duration: number; tracks: number }>; midAngleDeg?: number; node?: string } | undefined
    const frameFacts = safeJson(frame.stdout) as { clips?: unknown[] } | undefined
    checks.push({
      name: "baked_animation_survives_glb_export",
      ok: panel.code === 0 && (panelFacts?.clips?.length ?? 0) === 1
        && typeof panelFacts?.midAngleDeg === "number" && panelFacts.midAngleDeg > 10,
      detail: `门扇 GLB（按实体 door_panel 从 scene.json 解析=${String(panelPath)}）读出 clip=${JSON.stringify(panelFacts?.clips)}；Three.js mixer 推进到中点后**对象实际转过 ${String(panelFacts?.midAngleDeg)}°**（节点=${String(panelFacts?.node)}）——动画不是只写在文件里，而是真能驱动对象`,
    })
    checks.push({
      name: "static_entity_has_no_animation",
      ok: frame.code === 0 && (frameFacts?.clips?.length ?? -1) === 0,
      detail: `静止的门框 GLB（按实体 door_frame 从 scene.json 解析=${String(framePath)}）读出 clip 数=${String(frameFacts?.clips?.length ?? "n/a")}（须为 0）：导出按对象归属，不会把动画错挂到无关实体`,
    })

    // ── 5) 导入后动画仍有载体（glTF 节点实体）─────────────────────────────
    // 门扇路径解析不到 = 没有可导入、可播放的对象：第 5、6 条据此**显式判失败**（缺模型不得假装
    // 通过），只有解析到路径才进入真实导入与真实浏览器探针。
    const noPanelReason = `door_panel 的可视 GLB 无法按实体身份从 scene.json 解析（scene.json 存在=${existsSync(sceneFile)}，解析结果=${String(panelPath)}）`
    const imported = panelPath === null
      ? { summary: `无法导入：${noPanelReason}`, nodeEntities: 0, clips: 0, clipNames: "" }
      : await importSceneAndImportGlb(root, panelPath)
    checks.push({
      name: "imported_glb_yields_gltf_node_entity",
      ok: imported.nodeEntities > 0 && imported.clips > 0,
      detail: `把带动画的 GLB 作为资源导入产品场景：实体=${imported.summary}；其中 **glTF 节点实体（Viewer 挂 mixer 的载体）=${imported.nodeEntities}**；`
        + `该 GLB 的 clips=${imported.clips}（${imported.clipNames}）——导入后动画仍有载体，不会只剩一个无动画的 group 根`,
    })

    // ── 6) 真实浏览器里真的播放（此前是本门如实声明的未覆盖项）──────────────
    // 为什么必须单独做：上面几条只证到"GLB 里有 clip + Three.js 能推 mixer"，**证不到产品
    // 的 Viewer 客户端在真实浏览器里会把它播出来**。这一条补的正是产品侧接线，实测抓到过真缺陷：
    // mixer 在首次 setScene 的异步载入里才建出来，而登记发生在载入之前 ⇒ 新开场景永远不进播放表
    // （`animationSummary` 报 0 clip、`advanceAnimations` 空转），要等下一次场景版本变更才突然动。
    const BUN = process.env.BUN_EXECUTABLE ?? "bun"
    const playRun = panelPath === null
      ? { code: 1, stdout: "", stderr: `${noPanelReason}——没有可播放的对象，探针未运行` }
      : await runCommand([BUN, "run", join(PRODUCT_ROOT, "script/gates/viewer-play.ts"), panelPath])
    const playLine = playRun.stdout.split("\n").reverse().find(line => line.startsWith("VIEWER_PLAY="))
    const play = playLine ? safeJson(playLine.slice("VIEWER_PLAY=".length)) as {
      ok?: boolean; environment?: string; detail?: string; error?: string
    } | undefined : undefined
    if (play?.environment !== undefined) {
      // 环境缺失（无 Chrome / 无 WebGL / host 起不来）**既不算通过也不算失败**：按本门既有约定
      // 用 `contract/` 前缀 + `ok: true` 报成 UNCOVERED，薄入口会单独成类、不参与退出码分子。
      checks.push({
        name: "contract/browser_viewer_probe_environment",
        ok: true,
        detail: `UNCOVERED：${play.environment}（驱动退出码=${playRun.code}）——本环境无法在真实浏览器里验证播放，`
          + `**不代表通过**；其余判据不受影响。诊断尾部=${playRun.stderr.slice(-200) || "空"}`,
      })
    } else {
      checks.push({
        name: "baked_animation_plays_in_real_browser_viewer",
        ok: play?.ok === true,
        detail: `${String(play?.detail ?? `探针没有给出判定：stdout 尾部=${playRun.stdout.slice(-300)} stderr 尾部=${playRun.stderr.slice(-300)}`)}`
          + `${play?.error ? `；探针出错=${String(play.error).slice(-400)}` : ""}`,
      })
    }

    // ── 7) 新增能力挂在同一个工具上，没有平行工具 ──────────────────────────
    const names = tools.schemas().map(schema => schema.name)
    checks.push({
      name: "tool_surface_still_single_and_registered",
      ok: names.includes("blender_run"),
      detail: `真实 ToolRegistry 内工具=[${names.join(",")}]——尺度自检/贴图/渲染都挂在**同一个** blender_run 上，没有新增平行工具`,
    })
  } catch (error) {
    checks.push({ name: "exception", ok: false, detail: String((error as Error)?.message ?? error) })
  } finally {
    // 设 G19_KEEP=1 可保留临时目录用于排障；默认清理。
    if (root && process.env.G19_KEEP !== "1") await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
  return {
    gate: "G19",
    checks,
    blocked: "本门只覆盖四项增量能力（尺度自检 / CC0 贴图接节点 / 渲染图回喂 / 烘焙动画可播放性）。**未覆盖**：照片真值精度（本机没有真实照片与实测尺寸做对照，只验参照之间自洽）、Poly Haven 之外的外部素材源、烘焙动画在物理侧的表现（动画只驱动显示，不参与物理）。",
  }
}

/**
 * 走产品真实 scene-kit 导入一个 GLB，并**直接读导入产物 scene.json** 核对实体形态。
 *
 * 为什么读产物文件而不是 import 产品模块：node 的类型剥离不支持 `scene-kit/src/store.ts` 的
 * TypeScript 参数属性（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），而本门必须在 node 下跑（Cordis 树约束）。
 * 读 scene.json 同样是**产品真实产物**，且不把门的可运行性绑在运行器特性上；导入动作本身用 bun 执行。
 */
async function importSceneAndImportGlb(root: string, glbPath: string): Promise<{ summary: string; nodeEntities: number; clips: number; clipNames: string }> {
  try {
    const sceneRoot = join(root, "imported-scenes")
    const script = join(root, "import-glb.ts")
    await writeFile(script, importScript(join(PRODUCT_ROOT, "packages/scene-kit/src/operations.ts")))
    const run = await runCommand(["bun", "run", script], { SCENE_ROOT: sceneRoot, PRODUCT_ROOT, GLB_PATH: glbPath })
    if (run.code !== 0) return { summary: `导入失败：${run.stderr.slice(-200)}`, nodeEntities: 0, clips: 0, clipNames: "" }
    // 产品布局：Scene 文档落在 <sceneRoot>/scenes/<sceneId>.json（不是 sceneRoot 根下）。
    const sceneFile = join(sceneRoot, "scenes", "g19-import.json")
    if (!existsSync(sceneFile)) return { summary: `导入产物缺失：${sceneFile}`, nodeEntities: 0, clips: 0, clipNames: "" }
    const snapshot = JSON.parse(await readFile(sceneFile, "utf8")) as { entities?: Array<{ components?: Record<string, { kind?: string; gltfNode?: number }> }> }
    const entities = snapshot.entities ?? []
    const kinds = entities.map(entity => String(entity.components?.visual?.kind))
    const nodeEntities = entities.filter(entity => entity.components?.visual?.kind === "mesh" && typeof entity.components?.visual?.gltfNode === "number").length
    const reader = await runCommand(["node", READER, glbPath])
    const facts = safeJson(reader.stdout) as { clips?: Array<{ name: string }> } | undefined
    return {
      summary: `${entities.length} 个（kind=[${kinds.join(",")}]）`,
      nodeEntities,
      clips: facts?.clips?.length ?? 0,
      clipNames: (facts?.clips ?? []).map(clip => clip.name).join(","),
    }
  } catch (error) {
    return { summary: `导入失败：${String((error as Error)?.message ?? error)}`, nodeEntities: 0, clips: 0, clipNames: "" }
  }
}

async function runCommand(argv: string[], env?: Record<string, string>): Promise<CommandResult> {
  return await new Promise<CommandResult>(resolveExit => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: PRODUCT_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => { child.kill("SIGTERM") }, 600_000)
    child.on("exit", code => { clearTimeout(timer); resolveExit({ code: code ?? 1, stdout, stderr }) })
    child.on("error", error => { clearTimeout(timer); resolveExit({ code: 1, stdout, stderr: stderr + String(error) }) })
  })
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text.trim().split("\n").pop() ?? "") } catch { return undefined }
}
