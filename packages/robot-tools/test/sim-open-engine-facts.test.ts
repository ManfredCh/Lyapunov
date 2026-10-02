/**
 * N20：引擎/世界事实在工具面可见（sim_open／sim_sync 回执）。
 *
 * 证据边界：这里用**假 SimWorlds**（不是引擎）钉住**工具面投影**这件事——
 * `sim_open`／`sim_sync` 的回执就是 provider 句柄本身，句柄上已有的
 * `engineId`/`engineVersion`/`capabilities` 必须原样带出；provider 没自报时
 * 该键**不出现**（不造默认值）。真实 Newton 的读数另在回执里给。
 */
import { describe, expect, test } from "bun:test"
import { createRobotOperations } from "../src/operations.ts"
import type { WorldHandle } from "../../lyapunov-contracts/src/types.ts"
import type { SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"

const handle = (extra: Partial<WorldHandle> = {}): WorldHandle => ({
  worldId: "w1", sceneId: "s1", engineId: "newton", engineVersion: "1.6.0", worldGeneration: 1, appliedSceneRevision: 0,
  status: "ready", clock: "realtime", timestepS: 0.002, ...extra,
})
const snapshot: SceneSnapshot = { sceneId: "s1", revision: 0, coordinates: { units: "m", upAxis: "Z", handedness: "right", quaternion: "xyzw" }, entities: [] }
const scene = { snapshot: () => snapshot }
/** 只实现本用例用到的四个方法，其余按未实现处理（类型用 unknown 断言，不假装有别的能力）。 */
const simWith = (world: WorldHandle) => ({ open: async () => world, sync: async () => world, listWorlds: async () => [world], close: async () => undefined })

describe("N20：sim_open／sim_sync 回执带引擎身份与 provider 自报能力", () => {
  test("provider 句柄上有 capabilities → 回执原样带出（Newton 自报表形状）", async () => {
    const capabilities = { engine: "newton", slice: "minimal-1", supported: { open: true, sync: true }, unsupported: { assist: "UNSUPPORTED_CAPABILITY" }, notes: ["第一切片只支持 MJCF/URDF 原生源 + 地面"] }
    const ops = createRobotOperations(simWith(handle({ capabilities })) as never, scene as never)
    const opened = await ops.sim_open({ sceneId: "s1" })
    expect(opened.engineId).toBe("newton")
    expect(opened.engineVersion).toBe("1.6.0")
    expect(opened.capabilities).toBe(capabilities)
    const synced = await ops.sim_sync({ sceneId: "s1", worldId: "w1" })
    expect(synced.engineId).toBe("newton")
    expect(synced.capabilities).toBe(capabilities)
  })

  test("provider 没自报 capabilities → 键不出现（不造默认值），引擎身份照常带出", async () => {
    const ops = createRobotOperations(simWith(handle()) as never, scene as never)
    const opened = await ops.sim_open({ sceneId: "s1" })
    expect("capabilities" in opened).toBe(false)
    expect(opened.engineId).toBe("newton")
    expect(opened.engineVersion).toBe("1.6.0")
    const listed = await ops.sim_world_list()
    expect("capabilities" in (listed as readonly WorldHandle[])[0]!).toBe(false)
  })
})
