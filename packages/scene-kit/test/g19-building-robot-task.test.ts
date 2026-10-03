/**
 * DEV-011（W13 scene-kit 侧）③：**建筑案例的机器人任务回执**。
 *
 * 判据来源：`DEVELOPMENT_TODO.md` §DEV-011 完成条件 ③「机器人任务另给回执」，以及 ② 的
 * "动画若要求驱动物理则用真实关节／碰撞验证"。本文件的立场是 **入口不等于能力**：
 *  - scene-kit 负责**装配**（真实 MJCF 资源 → 资源库 → 场景实体 → 快照），它自报的是资源与组件事实；
 *  - "能不能被物理驱动"只能由真机引擎回答，所以第二组用例把 scene-kit 装出来的快照送进真实
 *    MuJoCo Provider，读 `open/describe/execute/observe` 的真回执，不拿"代码已写"或"导出成功"顶替。
 *
 * 建筑夹具 `fixtures/g19/building.xml` 是**原生带 `<joint>` + 执行器**的 MJCF（门板 0.9×0.06×2.0 m，
 * 与 `g19-building-scale-animation.test.ts` 的已知实测尺寸同一份）；机器人用仓内真实
 * `materials/robots/franka_panda/franka_emika_panda/panda.xml`。两者同场 = 验收要的"建筑+机器人"。
 *
 * 三组读数（真机）：① 无指令时**没有**被命令的运动；② 机器人关节任务 `completed` 且逐关节误差有界；
 * ③ 同一世界里同一条门铰链：向无阻挡一侧能转到指令角（≈1.1995 rad），向机器人一侧被**真实接触**挡住
 *    （到不了指令角，且接触对里出现 `door_panel_geom|panda/*`）。③ 的正负对照在同一次 open 里完成。
 *
 * 引擎侧需要 `.runtime/sim-python/bin/python` + `materials/robots/.../panda.xml`；缺任一项只跳过引擎组，
 * 装配组照跑（跳过不等于通过，回执里按实际执行情况写）。
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { SceneOperations } from "../src/operations.ts"
import { ProcessSimProvider } from "../../sim-contract/src/python-transport.ts"
import { resolveSdkPython } from "../../lyapunov-product-bundle/src/sdk-python.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEV = resolve(HERE, "../../..")
const BUILDING = join(HERE, "fixtures/g19/building.xml")
const PANDA = join(DEV, "materials/robots/franka_panda/franka_emika_panda/panda.xml")
const MUJOCO_PYTHON = resolveSdkPython(DEV, "mujoco").python
const MUJOCO_WORKER = join(DEV, "packages/sim-mujoco/python/worker.py")
/**
 * 引擎可用性：解释器存在 **且** 真的装了 mujoco（空壳/半装不算，与 `engine-preference.ts`
 * 的 `newtonRuntimeAvailable` 同一口径）。缺任一项只跳过引擎组——跳过不等于通过。
 */
function mujocoReady(): boolean {
  if (!existsSync(MUJOCO_PYTHON) || !existsSync(MUJOCO_WORKER) || !existsSync(PANDA)) return false
  const probe = spawnSync(MUJOCO_PYTHON, ["-c", "import mujoco,sys;sys.stdout.write(mujoco.__version__)"], { encoding: "utf8", timeout: 120_000 })
  return probe.status === 0 && (probe.stdout ?? "").trim().length > 0
}
const engineReady = mujocoReady()

/** 机器人摆在门前（米）：与门铰链的水平距离 0.66 m < 门板行程 0.9 m ⇒ 门朝这一侧转会撞到它。 */
const ROBOT_POSITION: [number, number, number] = [0, -0.55, 0]
/** 门板行程两侧的指令角（rad）：正角转向无阻挡一侧，负角转向机器人一侧。 */
const DOOR_FREE = 1.2
const DOOR_BLOCKED = -1.2

/** scene-kit 装配：真实 MJCF → 资源库 → 同场两个实体；返回快照（引擎与装配都吃这一份）。 */
async function assembleWorld(): Promise<{ base: string; snapshot: Awaited<ReturnType<SceneOperations["inspect"]>> }> {
  const base = await mkdtemp(join(tmpdir(), "g19-building-robot-"))
  const operations = new SceneOperations(join(base, "data"))
  await operations.create({ sceneId: "g19-building-robot" })
  await operations.import({ path: BUILDING, sceneId: "g19-building-robot", resourceId: "res_g19_building", entityId: "building" })
  await operations.import({
    path: PANDA, sceneId: "g19-building-robot", resourceId: "res_g19_panda", entityId: "panda",
    transform: { position: ROBOT_POSITION, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    alignBottomToSurface: false, physicalize: false,
  })
  return { base, snapshot: await operations.inspect("g19-building-robot") }
}

const componentOf = (snapshot: Awaited<ReturnType<SceneOperations["inspect"]>>, entityId: string) =>
  (snapshot.entities.find(entity => entity.entityId === entityId)!.components ?? {}) as Record<string, any>

describe("DEV-011③（装配面）：scene-kit 把建筑 MJCF 与真实机器人装进同一场景", () => {
  let base: string | undefined
  afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); base = undefined })

  test("两个实体都带原生 MJCF 源与 articulation；门铰链来自源文件而不是任何动画", async () => {
    const assembled = await assembleWorld()
    base = assembled.base
    const building = componentOf(assembled.snapshot, "building")
    const panda = componentOf(assembled.snapshot, "panda")
    // 资源库按内容寻址落地：实体上的 sourcePath 指向 CAS 副本（不是用户原件），引擎读的就是它。
    // 判据因此落在**字节**上：CAS 副本与夹具逐字节相同（sha256 相等），不是"路径看起来对"。
    // 带依赖的机器人 MJCF 落在 `<sha>-panda.xml_deps/` 目录里（相对 meshdir/assets 才解析得到）。
    const buildingSource = String(building.mujoco?.sourcePath)
    const pandaSource = String(panda.mujoco?.sourcePath)
    expect(buildingSource.endsWith("-building.xml")).toBe(true)
    expect(basename(pandaSource)).toBe("panda.xml")
    expect(pandaSource).toContain("-panda.xml_deps/")
    expect(existsSync(join(dirname(pandaSource), "assets"))).toBe(true)
    expect(existsSync(pandaSource)).toBe(true)
    const digest = async (path: string) => await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer())
    const hex = (value: ArrayBuffer) => Buffer.from(value).toString("hex")
    expect(hex(await digest(buildingSource))).toBe(hex(await digest(BUILDING)))
    expect(hex(await digest(pandaSource))).toBe(hex(await digest(PANDA)))
    expect(building.articulation?.format).toBe("mjcf")
    expect(panda.articulation?.format).toBe("mjcf")
    // 实体位姿是装配事实（机器人摆在门前），别把它当成引擎的读数。
    expect(assembled.snapshot.entities.find(entity => entity.entityId === "panda")!.transform.position).toEqual(ROBOT_POSITION)
    // 门板尺寸与 ① 的已知实测尺寸同一份：夹具里写死的 0.9/0.06/2.0（半长 0.45/0.03/0.99 + 厚度展布）。
    const xml = await Bun.file(BUILDING).text()
    expect(xml).toContain('name="door_panel_geom" type="box" size="0.45 0.03 0.99"')
    expect(xml).toContain('<joint name="door_hinge" type="hinge"')
    expect(xml).toContain('<position name="door_drive" joint="door_hinge"')
  })
})

const engineSuite = engineReady ? describe : describe.skip

engineSuite("DEV-011③（真机）：机器人关节任务 + 与门板的真实接触", () => {
  let base: string | undefined
  const providers: ProcessSimProvider[] = []
  beforeAll(() => { expect(existsSync(MUJOCO_PYTHON)).toBe(true) })
  afterEach(async () => {
    for (const provider of providers.splice(0)) await provider.dispose().catch(() => undefined)
    if (base) await rm(base, { recursive: true, force: true })
    base = undefined
  })

  test("open→无指令负对照→机器人任务→门两侧行程（自由 vs 被接触挡住）", async () => {
    const assembled = await assembleWorld()
    base = assembled.base
    const provider = new ProcessSimProvider({ pythonPath: MUJOCO_PYTHON, workerPath: MUJOCO_WORKER, engineName: "MuJoCo" })
    providers.push(provider)
    const world = "w-g19-robot"
    const handle = await provider.open(assembled.snapshot, { worldId: world, timestepS: 0.002, ground: false })
    expect(handle.status).toBe("ready")
    expect(handle.engineId).toBe("mujoco")

    const robot = await provider.describe(world, "panda")
    const building = await provider.describe(world, "building")
    // 机器人有真实关节级执行器（7 个受控关节）；建筑的门铰链有源位置执行器 ⇒ 两者都能被命令。
    expect(robot.controlledJointNames).toEqual(["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "joint7"])
    expect(building.joints.map(joint => joint.name)).toEqual(["door_hinge"])
    expect(building.joints[0]!.actuator).toBe("door_drive")
    expect(building.joints[0]!.controlMode).toBe("position")

    /** 观测一帧：关节位置、门角、以及"门板↔机器人"的接触对（其余接触不参与本判据）。 */
    const sample = async (): Promise<{ robotJoints: number[]; door: number; panelRobotContacts: string[]; allContacts: string[] }> => {
      const frame = await provider.observe(world, { contacts: true })
      const robotJointPositions = frame.entities.find(entity => entity.entityId === "panda")!.joints!.positions
      const door = frame.entities.find(entity => entity.entityId === "building")!.joints!.positions[0]!
      const pairs = [...new Set((frame.contacts ?? []).map(contact => `${contact.geom1}|${contact.geom2}`))]
      return {
        robotJoints: robotJointPositions.slice(0, 7),
        door,
        panelRobotContacts: pairs.filter(pair => pair.includes("door_panel_geom") && pair.includes("panda/")),
        allContacts: pairs,
      }
    }
    const settle = async (ms = 1500): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

    // ① 无指令负对照：没有任何东西在动，也没有接触（不把"重力沉降"当成被命令的运动）。
    const t0 = await sample()
    await settle()
    const t1 = await sample()
    const drift = Math.max(...t0.robotJoints.map((value, index) => Math.abs(value - t1.robotJoints[index]!)))
    expect(drift).toBeLessThan(0.02)
    expect(t1.door).toBe(0)
    expect(t1.panelRobotContacts).toEqual([])

    // ② 机器人关节任务：真机回执 completed，逐关节误差有界。
    const targets = [0, 1.0, 0, -1.3, 0, 1.5, 0]
    const receipt = await provider.execute(world, {
      actionId: "g19-robot-task", expectedGeneration: handle.worldGeneration, kind: "joint",
      entityId: "panda", jointNames: robot.controlledJointNames, positions: targets, durationS: 2.0, tolerance: 0.05,
    })
    expect(receipt.status).toBe("completed")
    await settle(500)
    const afterTask = await sample()
    const taskError = Math.max(...targets.map((value, index) => Math.abs(afterTask.robotJoints[index]! - value)))
    expect(taskError).toBeLessThan(0.05)

    // ③ 同一世界里同一条门铰链的两次行程：自由一侧到得了，机器人一侧到不了。
    const door = async (target: number, actionId: string) => {
      const result = await provider.execute(world, {
        actionId, expectedGeneration: handle.worldGeneration, kind: "joint",
        entityId: "building", jointNames: ["door_hinge"], positions: [target], durationS: 2.0, tolerance: 0.05,
      })
      await settle()
      return { result, frame: await sample() }
    }
    const free = await door(DOOR_FREE, "g19-door-free")
    expect(free.result.status).toBe("completed")
    expect(Math.abs(free.frame.door - DOOR_FREE)).toBeLessThan(0.05)
    expect(free.frame.panelRobotContacts).toEqual([])

    await door(0, "g19-door-reset")
    const blocked = await door(DOOR_BLOCKED, "g19-door-blocked")
    // 门被真实接触挡住：到不了指令角，且接触对里有门板与机器人的几何。
    expect(Math.abs(blocked.frame.door)).toBeLessThan(Math.abs(DOOR_BLOCKED) - 0.2)
    expect(blocked.frame.panelRobotContacts.length).toBeGreaterThan(0)
    // 被挡住是**接触**造成的，不是门自己不动：它确实从 0 转到了机器人那一侧。
    expect(blocked.frame.door).toBeLessThan(-0.2)

    await provider.close(world)
  }, 300_000)
})
