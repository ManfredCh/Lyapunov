/**
 * R1/R3 的行为测试：能力包面板把「取件 → 装配 → 载入」当成**一条异步动作**处理。
 *
 * 背景（独立验收 R1/R3）：
 *  - R1：面板的 `load` 回调被声明成 void、调用时也不 await，而真实落点是异步的 `scene_import`；
 *    于是忙态在导入完成前就被清掉（可重入、可假完成），导入失败面板也收不到。
 *    这里钉住的判据：**载入没结束，动作不 resolve**；载入失败按真实错误传播；装配失败不调用载入。
 *  - R3：入口过去只接受 `PACK_DIRECT_CONTROL`，对已支持的基础策略包（Go2/G1/Go1 会返回
 *    `PREPARED`）无条件 throw——"显示可用却提供必败按钮"。这里钉住两条已支持路由同等交付
 *    **本次缓存里的绝对路径**给同一个 scene_import。
 *
 * 边界：本文件不跑 python/不下载权重，只覆盖客户端编排与错误传播；真实包契约与缺权重时的
 * 可执行说明由 `packages/policy-registry/test/pack-policy-source.test.ts` 用真实内容根与真实端点覆盖。
 */
import { describe, expect, test } from "bun:test"

import { fetchPrepareLoad, type PackActionPorts, type PackCatalogRow } from "../src/pack-library-panel.tsx"

const tr = (cn: string) => cn
const row: PackCatalogRow = { packId: "unitree_go2", policy: { routeKind: "policy-source" } }
const DIRECT: PackCatalogRow = { packId: "lyaup_demo_arm", policy: { routeKind: "direct-control" } }

type Answers = {
  download?: unknown
  prepare?: unknown
  downloadError?: Error
  prepareError?: Error
  load?: (modelPath: string) => Promise<void>
}

function harness(options: Answers = {}, target: PackCatalogRow = row) {
  const calls: string[] = []
  const loaded: string[] = []
  let settled = false
  const command = async (name: string, _args: Record<string, unknown>) => {
    calls.push(name)
    if (name === "policy_download") {
      if (options.downloadError) throw options.downloadError
      return options.download ?? { status: "DOWNLOADED", files: [] }
    }
    if (options.prepareError) throw options.prepareError
    return options.prepare
  }
  const load = (modelPath: string) => {
    loaded.push(modelPath)
    return options.load ? options.load(modelPath) : Promise.resolve()
  }
  const ports: PackActionPorts = { command, load }
  const run = fetchPrepareLoad(ports, target, tr).then(
    (text) => ({ ok: true as const, text }),
    (error: unknown) => ({ ok: false as const, error: String(error instanceof Error ? error.message : error) }),
  ).finally(() => { settled = true })
  return { calls, loaded, run, settled: () => settled }
}

const DIRECT_RESULT = {
  status: "PACK_DIRECT_CONTROL", weightsRequired: false, modelEntry: "/cache/policies/packs/packs__lyaup_demo_arm/master/asset/Lyaup演示机械臂.mjcf",
  route: { kind: "direct-control" }, components: { mujoco: { sourcePath: "/cache/policies/packs/packs__lyaup_demo_arm/master/asset/Lyaup演示机械臂.mjcf" } },
}
const PREPARED_RESULT = {
  status: "PREPARED",
  route: { kind: "policy-source", adapterId: "inria-go2-onnx-v1", source: { provider: "github", modelId: "inria-paris-robotics-lab/go2_onnx_controller", revision: "c1729e1a4aa2e7e1091ccff42be68d42bd054764" } },
  components: { mujoco: { sourcePath: "/cache/policies/packs/packs__unitree_go2/master/derived/go2.xml" } },
}

describe("R1：取件并载入是一条被 await 的异步动作", () => {
  test("直控路由：缓存内绝对路径交给 scene_import，顺序是先取件后装配", async () => {
    const h = harness({ prepare: DIRECT_RESULT }, DIRECT)
    const result = await h.run
    expect(result.ok).toBe(true)
    expect(h.calls).toEqual(["policy_download", "policy_prepare"])
    expect(h.loaded).toEqual([DIRECT_RESULT.modelEntry])
    expect(result.ok && result.text).toContain("不需要权重")
  })

  test("载入未结束前不 resolve，也不先报完成（忙态因此覆盖真实 scene_import）", async () => {
    let release: () => void = () => {}
    const h = harness({ prepare: DIRECT_RESULT, load: () => new Promise<void>((resolve) => { release = resolve }) }, DIRECT)
    // 让 download/prepare 两个 await 与后续微任务都跑完：动作仍必须挂起（载入没结束）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.loaded).toEqual([DIRECT_RESULT.modelEntry])
    expect(h.settled()).toBe(false)
    release()
    const result = await h.run
    expect(result.ok).toBe(true)
    expect(h.settled()).toBe(true)
  })

  test("载入失败按真实错误传播（不把失败当完成，也没有无人处理的 rejection）", async () => {
    const h = harness({ prepare: DIRECT_RESULT, load: () => Promise.reject(new Error("SCENE_IMPORT_FAILED: 模型无法解析")) }, DIRECT)
    const result = await h.run
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("SCENE_IMPORT_FAILED")
  })

  test("装配失败不调用 scene_import：错误原样带出（含服务端给的错误码）", async () => {
    const h = harness({ prepareError: new Error("POLICY_WEIGHTS_NOT_CACHED: 权重未在本机缓存（来源 github:inria-paris-robotics-lab/go2_onnx_controller@c1729e1a…）") })
    const result = await h.run
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("POLICY_WEIGHTS_NOT_CACHED")
    expect(h.loaded).toEqual([])
  })
})

describe("R3：两条已支持的装配路由都交得出可载入的模型", () => {
  test("基础策略 PREPARED：交付执行适配器用的机器人模型，并说出权重来源（不再无条件 throw）", async () => {
    const h = harness({ prepare: PREPARED_RESULT })
    const result = await h.run
    expect(result.ok).toBe(true)
    expect(h.loaded).toEqual([PREPARED_RESULT.components.mujoco.sourcePath])
    expect(result.ok && result.text).toContain("inria-go2-onnx-v1")
    expect(result.ok && result.text).toContain("github:inria-paris-robotics-lab/go2_onnx_controller@c1729e1a4aa2…")
  })

  test("不支持的状态：按产品返回的状态与路由抛出，不伪装成已载入", async () => {
    const h = harness({ prepare: { status: "PACK_SERVER_SIDE_INFERENCE", route: { kind: "server-side-inference", adapter: "openpi-server-side" } } })
    const result = await h.run
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("PACK_SERVER_SIDE_INFERENCE")
    expect(result.ok === false && result.error).toContain("server-side-inference")
    expect(h.loaded).toEqual([])
  })

  test("PREPARED 但交不出模型路径：同样拒绝，不交空路径给 scene_import", async () => {
    const h = harness({ prepare: { status: "PREPARED", route: { kind: "policy-source" }, components: {} } })
    const result = await h.run
    expect(result.ok).toBe(false)
    expect(h.loaded).toEqual([])
  })
})
