/** 显式本机验收：真实SDK→Blender→GLB/登记/挂载→MuJoCo；不调用模型，不碰人的场景。 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { Box3, Quaternion, Vector3 } from "three"
import { Context } from "@deepseek-ai/cordis"
import Timer from "@deepseek-ai/cordis-plugin-timer"
import Commands from "@deepseek-ai/dsh-commands"
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local"
import JobsLocal from "@deepseek-ai/dsh-jobs-local"
import { SessionId } from "@deepseek-ai/dsh-session"
import { ToolCallId } from "@deepseek-ai/dsh-llm"
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit"
import * as blender from "../src/plugin.ts"
import * as scene from "../../scene-kit/src/plugin.ts"
import { MuJoCoProvider } from "../../sim-mujoco/src/provider.ts"

const output = resolve(process.argv[2] ?? ".runtime/tool-ground-chain")
const stage = join(output, "run-" + Date.now())
await mkdir(stage, { recursive: true })
// 显式本机依赖可由命令参数提供；干净源码不要求E或另一个worktree存在。
const python = process.argv[3] ?? resolve(import.meta.dirname, "../../../.runtime/sim-python/bin/python")
const topologyWorker = process.argv[4] ?? resolve(import.meta.dirname, "../../sim-mujoco/python/worker.py")
const executable = process.argv[5] ?? "blender"
const scriptPath = join(stage, "create_ground.py")
await writeFile(scriptPath, `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.05))
obj=bpy.context.object
obj.name="ground_fixture"
obj.dimensions=(10,10,0.1)
# 明确资产原点在地面顶面z=0，几何自身向下厚.1m，实例identity。
bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
obj["lyapunov_shape"]="box"
obj["lyapunov_size"]=[10,10,0.1]
obj["lyapunov_collision"]=True
obj["lyapunov_dynamic"]=False
`)
const ctx = new Context()
await ctx.plugin(Timer)
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Commands)
await ctx.plugin(SubprocessLocal)
await ctx.plugin(JobsLocal)
ctx.jobs.attachController("ground-chain-fixture")
await ctx.plugin({ name: "ground-blender-fixture", inject: ["tools", "subprocess", "jobs"], apply: (scoped: Context) => blender.apply(scoped, { executable, workspace: stage }) } as never, undefined as never)
await ctx.plugin(scene, { dataRoot: join(stage, "scene-runtime"), algorithmPython: python })
const loop = await mountAgentLoopTestHarness(ctx)
const agent = await loop.create(SessionId("isolated-ground-chain"), {}, { cwd: stage })
let callIndex = 0
async function tool(name: string, args: Record<string, unknown>) {
  const call = await ctx.tools.execute({ name, arguments: args, agent, signal: new AbortController().signal, callId: ToolCallId("ground-fixture-" + ++callIndex) })
  if (call.isError) throw new Error(name + ": " + call.content.filter(b => b.type === "text").map(b => b.text).join("\n"))
  return call.value as any
}
// 只读复用Isaac已冻结的拓扑观察worker；模型/数据/进程仍为本夹具独占。
const provider = new MuJoCoProvider({ pythonPath: python, renderBackend: "egl", workerPath: topologyWorker })
let worldId: string | undefined
try {
  const noargs = await tool("scene_list", {})
  const result = await tool("blender_run", { output_directory: "ground-output", python_script: "create_ground.py", operation: "build", render: false, background: false })
  const exported = JSON.parse(result.result)
  const scenePath = join(stage, "ground-output/scene.json")
  const original = JSON.parse(await readFile(scenePath, "utf8"))
  const floor = original.entities.find((entity: any) => entity.name === "ground_fixture")
  assert(floor, "真实Blender场景应含独立地面")
  const glb = floor.resources.flatMap((resource: any) => resource.representations).find((representation: any) => representation.mimeType === "model/gltf-binary")
  assert(glb, "真实导出应有GLB表示")
  const glbPath = glb.uri.startsWith("file:") ? new URL(glb.uri) : glb.uri
  const glbBytes = await readFile(glbPath)
  const created = await tool("scene_create", { input: { sceneId: "ground-sdk-fixture", name: "隔离地面验收" } })
  const imported = await tool("scene_import", { input: { path: typeof glbPath === "string" ? glbPath : glbPath.pathname, name: "ground_fixture", physicalize: true, physicalizeUsage: "static", physicalizeStrategy: "triangle_mesh" } })
  const resourceId = imported.resource.ref.resourceId
  let resource = imported.resource
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const resources = await tool("asset_list", { input: { allVersions: true } })
    resource = resources.find((entry: any) => entry.ref.resourceId === resourceId)
    if (resource.physicalization?.status === "ok" || resource.physicalization?.status === "failed") break
    await new Promise(done => setTimeout(done, 150))
  }
  await writeFile(join(output, "registered-resource.json"), JSON.stringify(resource, null, 2))
  assert.equal(resource.physicalization?.status, "ok", "完整碰撞派生必须就绪，不能借视觉挂载当物理成功")
  await tool("scene_mount", { input: { sceneId: created.sceneId, resourceId, version: resource.ref.version, entityId: "ground_fixture", transform: floor.transform, alignBottomToSurface: false } })
  let snapshot = await tool("scene_inspect", { input: { sceneId: created.sceneId } })
  const ground = snapshot.entities.find((entity: any) => entity.name === "ground_fixture" || entity.entityId === "ground_fixture")
  assert(ground, "登记后应该挂载真实实体")
  await tool("scene_edit", { input: { sceneId: created.sceneId, expectedRevision: snapshot.revision, patch: [{ op: "add", entity: {
    entityId: "fall_probe", name: "碰撞落球", transform: { position: [0, 0, 0.5], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [],
    components: { rigidBody: { type: "dynamic", massKg: 0.1 }, collision: { shape: "sphere", size: [0.05, 0.05, 0.05] }, visual: { kind: "primitive", shape: "sphere", radius: 0.05 } },
  } }] } })
  snapshot = await tool("scene_inspect", { input: { sceneId: created.sceneId } })
  const handle = await provider.open(snapshot, { clock: "realtime", timestepS: 0.002, ground: false })
  worldId = handle.worldId
  let frame = await provider.observe(worldId, { contacts: true, collisionTopology: { entityIds: ["ground_fixture", "fall_probe"], includeGeometry: true } } as never)
  const settleUntil = Date.now() + 3000
  while (Date.now() < settleUntil) {
    await new Promise(done => setTimeout(done, 50))
    frame = await provider.observe(worldId, { contacts: true, collisionTopology: { entityIds: ["ground_fixture", "fall_probe"], includeGeometry: true } } as never)
  }
  const probe = frame.entities.find(entity => entity.entityId === "fall_probe")
  await writeFile(join(output, "ground-physics-before-assert.json"), JSON.stringify({ stage, coordinates: snapshot.coordinates, probe, contacts: frame.contacts, importedGround: ground, imported, snapshot, world: handle, frame }, null, 2))
  assert(probe, "原生物理必须真实回读落球")
  const topology = (frame as any).collisionTopology
  const groundGeom = topology.geoms.find((geom: any) => geom.entityId === "ground_fixture")
  const ballGeom = topology.geoms.find((geom: any) => geom.entityId === "fall_probe")
  assert.equal(ballGeom.geometry.kind, "sphere")
  assert.equal(ballGeom.geometry.sizeM[0], 0.05, "实际compiled球geom半径必须.05")
  const nativeBounds = new Box3()
  const orientation = new Quaternion(...groundGeom.quaternionXyzw as [number, number, number, number])
  const center = new Vector3(...groundGeom.positionM as [number, number, number])
  for (let i = 0; i < groundGeom.geometry.vertices.length; i += 3) {
    nativeBounds.expandByPoint(new Vector3(...groundGeom.geometry.vertices.slice(i, i + 3) as [number, number, number]).applyQuaternion(orientation).add(center))
  }
  const nativeSize = nativeBounds.getSize(new Vector3())
  assert(Math.abs(nativeSize.x - 10) < 1e-6 && Math.abs(nativeSize.y - 10) < 1e-6, "实际compiled地面世界尺寸必须10×10m")
  assert(Math.abs(nativeBounds.max.z) < 1e-6, "实际compiled地面顶面世界Z必须0，不能拿JSON bbox代替")
  assert(Math.abs(ballGeom.positionM[2] - 0.05) < 0.005, "实际compiled球geom中心必须停在z=.05，不能拿body root代替")
  assert(Math.abs(probe.transform.position[2] - 0.05) < 0.005, "地面顶面z=0，半径.05落球应停在z=.05")
  assert(frame.contacts?.some(contact => JSON.stringify(contact).includes("ground_fixture")), "真实接触应包含导入地面，不能借默认ground假通过")
  const receipt = { level: "真实SDK/Blender/GLB/登记/CPU物理；非人场景/非模型或GUI签收", stage, noargsSuccessful: noargs !== undefined,
    blender: { executable, outputReported: exported.outputDirectory }, glb: { bytes: glbBytes.length, sha256: createHash("sha256").update(glbBytes).digest("hex") },
    imported, snapshot, world: handle, frame, nativeGeometryWorldBounds: { min: nativeBounds.min.toArray(), max: nativeBounds.max.toArray(), size: nativeSize.toArray() }, humanSceneModified: false }
  await writeFile(join(output, "ground-chain-evidence.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ completed: true, stage, glbBytes: glbBytes.length, worldId: "isolated-fixture", evidence: join(output, "ground-chain-evidence.json") }))
} finally {
  if (worldId) await provider.close(worldId).catch(() => undefined)
  await provider.dispose().catch(() => undefined)
  await ctx.fiber.dispose().catch(() => undefined)
}
