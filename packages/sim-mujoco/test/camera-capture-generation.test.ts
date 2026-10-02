/**
 * MuJoCo 采集代次守卫：`captureId` 必须与**当前世界代次**同代（DEV-009 待裁 ②，Lead 裁定：补 MuJoCo，不放宽 Isaac）。
 *
 * 为什么需要这一条：Isaac 侧对 `captureId` **同时校验 generation**
 * （`packages/sim-isaac/python/camera_math.py:120` 的 `select_capture`、`packages/sim-isaac/python/camera_dataset.py:81`
 * 的 `export_dataset`）⇒ 标注与导出都把旧代次按 `STALE_GENERATION` 明确拒绝；而 MuJoCo 侧改前只校验
 * 「captureId 存在 / 相机在不在这次采集里 / 深度是否可复用」——**不校验 generation** ⇒ 同一个 captureId 在
 * `sync` 之后仍被照旧算成一个世界点、照旧导出成数据集。同一件事两个 Provider 行为不同，判据以 Isaac 为准。
 *
 * 本文件钉两条方向（缺一不可）：
 *  ① 旧代次 captureId ⇒ **明确拒绝**（`STALE_GENERATION`，与 Isaac 同码同义），且拒绝发生在写盘之前（不留半份数据集）；
 *  ② 新代次 captureId ⇒ **仍然放行**（同代次标注反投影闭合、同代次导出真落盘；sync 之后的新采集照常可用）。
 * 另钉一条前置未被破坏：未知 captureId 仍是 `CAPTURE_NOT_FOUND`（守卫是**加在既有查找之后**，不是替换它）。
 *
 * 运行：`bun test packages/sim-mujoco/test/camera-capture-generation.test.ts`
 * 解释器：`LYAPUNOV_MUJOCO_PYTHON`（未设时用仓库内 `.runtime/sim-python/bin/python`）；没有解释器时整份显式
 * skip 并说明原因，不假装通过。
 *
 * 边界（不冒充已完成）：全部走产品路径（`MuJoCoProvider.open → capture → sync → projectAnnotation /
 * exportCameraDataset`），不直接调 python；场景是**最小合成件**（一面墙 + 一台相机，几何已知），不含用户真实资产。
 * 代次推进用的是产品自己的 `sync`（工人在 `initial=False` 的重编译里 `generation += 1`），不是手工改状态。
 */
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { MuJoCoProvider } from "../src/provider.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const python = process.env.LYAPUNOV_MUJOCO_PYTHON ?? resolve(root, ".runtime/sim-python/bin/python")
const available = existsSync(python)
const outDir = resolve(tmpdir(), `mujoco-capture-generation-${process.pid}`)
afterAll(() => rmSync(outDir, { recursive: true, force: true }))

const CAMERA = "cam-gen-t/cam_gen"
const WIDTH = 96, HEIGHT = 72
const CENTRE: [number, number] = [Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2)]

/**
 * 最小合成场景：+Y 侧一面厚墙（相机在 [0,-1.5,0] 朝 +Y 平视 ⇒ 画面中心打在墙的近面 y=2.9，轴向深度 4.4 m），
 * 相机按 `direction` 取景（不写朝向四元数也必须有确定朝向）。`revision` + 墙位一起变 ⇒ 物理签名变 ⇒ 真重编译。
 */
function buildScene(revision: number, wallY: number) {
  const entity = (entityId: string, name: string, position: number[], components: Record<string, unknown>) =>
    ({ entityId, name, transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, resources: [], components })
  return {
    sceneId: "mujoco-capture-generation", revision,
    coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" } as const,
    entities: [
      entity("wall-gen-t", "墙", [0, wallY, 0], { collision: { type: "box", halfExtents: [4, 0.1, 4], source: "camera-capture-generation" } }),
      entity("cam-gen-t", "cam_gen", [0, -1.5, 0], { camera: { fovYDeg: 45, direction: [0, 1, 0] } }),
    ],
  }
}

/** 把「抛了还是返回了」记成一条可打印的读数：改前是返回（这就是缺口证据），改后是抛且带码。 */
type Outcome = { ok: true; receipt: Record<string, unknown> } | { ok: false; code?: string; message?: string }
const record = async (call: Promise<unknown>): Promise<Outcome> => {
  try { return { ok: true, receipt: (await call) as Record<string, unknown> } }
  catch (error: any) { return { ok: false, code: error?.code, message: String(error?.message) } }
}

describe.skipIf(!available)(`MuJoCo 采集代次守卫（DEV-009 待裁 ②）${available ? "" : ` [解释器不存在: ${python}]`}`, () => {
  it("旧代次 captureId：标注明确拒绝（STALE_GENERATION），未知 captureId 仍是 CAPTURE_NOT_FOUND", async () => {
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(1, 3) as never, { ground: false, worldId: "mujoco-capture-generation-annotation" })
    try {
      const first = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: CAMERA, width: WIDTH, height: HEIGHT }) as any
      expect(first.generation).toBe(1)
      // 前置：同代次时这条 captureId 是**可用**的（否则下面的"旧代次被拒"可能只是"这个 id 从来就没用"）。
      const sameGeneration = await provider.projectAnnotation(handle.worldId, { cameraName: CAMERA, pixel: CENTRE, captureId: first.captureId }) as any
      expect(sameGeneration.captureId).toBe(first.captureId)
      expect(sameGeneration.generation).toBe(1)
      expect(sameGeneration.depthM).toBeGreaterThan(0)

      // 真代次推进：产品自己的 sync（墙位也变 ⇒ 物理签名变 ⇒ 真重编译，generation += 1）。
      const moved = await provider.sync(handle.worldId, buildScene(2, 4) as never) as any
      expect(moved.worldGeneration).toBe(2)

      const stale = await record(provider.projectAnnotation(handle.worldId, { cameraName: CAMERA, pixel: CENTRE, captureId: first.captureId }))
      expect(stale.ok, `旧代次 captureId 必须被拒绝，实际返回了标定回执: ${JSON.stringify(stale.ok ? stale.receipt : stale.message)}`).toBe(false)
      if (stale.ok) return
      expect(stale.code).toBe("STALE_GENERATION")
      expect(String(stale.message)).toContain("代次")
      expect(String(stale.message)).toContain("1")
      expect(String(stale.message)).toContain("2")

      // 守护的是"代次"，不是"引用"：未知 id 仍走原有语义（证明守卫加在查找之后，没有替换查找）。
      const unknown = await record(provider.projectAnnotation(handle.worldId, { cameraName: CAMERA, pixel: CENTRE, captureId: "no-such-capture" }))
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) expect(unknown.code).toBe("CAPTURE_NOT_FOUND")
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 120000)

  it("旧代次 captureId：数据集导出明确拒绝（STALE_GENERATION），且不留下半份数据集", async () => {
    const staleDir = resolve(outDir, "stale-export")
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(1, 3) as never, { ground: false, worldId: "mujoco-capture-generation-export" })
    try {
      const first = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: CAMERA, width: WIDTH, height: HEIGHT }) as any
      expect(first.generation).toBe(1)
      const moved = await provider.sync(handle.worldId, buildScene(2, 4) as never) as any
      expect(moved.worldGeneration).toBe(2)

      const stale = await record(provider.exportCameraDataset(handle.worldId, { outputDir: staleDir, captureIds: [first.captureId] }))
      expect(stale.ok, `旧代次 captureId 必须被拒绝，实际导出了数据集: ${JSON.stringify(stale.ok ? stale.receipt : stale.message)}`).toBe(false)
      if (stale.ok) return
      expect(stale.code).toBe("STALE_GENERATION")
      expect(String(stale.message)).toContain("代次")
      // 拒绝必须发生在创建目录/拷文件之前：不留 PARTIAL、不留半份数据集。
      expect(existsSync(resolve(staleDir, "dataset.json"))).toBe(false)
      expect(existsSync(resolve(staleDir, "samples.jsonl"))).toBe(false)
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 120000)

  it("新代次 captureId 仍然放行：同代标注/导出照常，sync 后的新采集照常", async () => {
    const freshDir = resolve(outDir, "fresh-export")
    mkdirSync(outDir, { recursive: true })
    const provider = new MuJoCoProvider({ pythonPath: python })
    const handle = await provider.open(buildScene(1, 3) as never, { ground: false, worldId: "mujoco-capture-generation-fresh" })
    try {
      // ① 同代次（generation=1）的采集：标注与导出都必须照常可用。
      const first = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: CAMERA, width: WIDTH, height: HEIGHT }) as any
      const annotation = await provider.projectAnnotation(handle.worldId, { cameraName: CAMERA, pixel: CENTRE, captureId: first.captureId }) as any
      expect(annotation.captureId).toBe(first.captureId)
      expect(annotation.currentWorldGeneration).toBe(1)
      // 相机在 [0,-1.5,0] 朝 +Y、墙近面 y=2.9 ⇒ 中心像素轴向深度恒等于 4.4 m。
      expect(Math.abs(annotation.depthM - 4.4)).toBeLessThan(0.05)
      expect(Math.abs(annotation.worldPointM[1] - 2.9)).toBeLessThan(0.05)
      const sameGenerationExport = await provider.exportCameraDataset(handle.worldId, { outputDir: freshDir, captureIds: [first.captureId] }) as any
      expect(sameGenerationExport.status).toBe("completed")
      expect(existsSync(resolve(freshDir, "dataset.json"))).toBe(true)
      expect(JSON.parse(readFileSync(resolve(freshDir, "dataset.json"), "utf8")).captureIds).toEqual([first.captureId])

      // ② sync 之后（generation=2）的**新采集**：新旧混用的判据不能把正常路径也拒掉。
      const moved = await provider.sync(handle.worldId, buildScene(2, 4) as never) as any
      expect(moved.worldGeneration).toBe(2)
      const second = await provider.capture(handle.worldId, { outputDir: outDir, cameraName: CAMERA, width: WIDTH, height: HEIGHT }) as any
      expect(second.generation).toBe(2)
      expect(second.captureId).not.toBe(first.captureId)
      const freshAnnotation = await provider.projectAnnotation(handle.worldId, { cameraName: CAMERA, pixel: CENTRE, captureId: second.captureId }) as any
      expect(freshAnnotation.captureId).toBe(second.captureId)
      expect(freshAnnotation.generation).toBe(2)
      expect(freshAnnotation.currentWorldGeneration).toBe(2)
      // 墙挪到 y=4 ⇒ 新采集的中心像素深度应变成 5.4 m（旧深度 4.4 m 已经不成立：这正是要拒绝旧代次的原因）。
      expect(Math.abs(freshAnnotation.depthM - 5.4)).toBeLessThan(0.05)
      const freshDir2 = resolve(outDir, "fresh-export-after-sync")
      const freshExport = await provider.exportCameraDataset(handle.worldId, { outputDir: freshDir2, captureIds: [second.captureId] }) as any
      expect(freshExport.status).toBe("completed")
      expect(existsSync(resolve(freshDir2, "dataset.json"))).toBe(true)
    } finally {
      await provider.close(handle.worldId).catch(() => {})
      await provider.dispose()
    }
  }, 120000)
})
