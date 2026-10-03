/**
 * 未知/跨会话 sceneId 的**读取错误契约**（L379；DEV-003 完成条件④的登记残留）。
 *
 * 背景：世界/场景**按会话落盘**（`worlds/sessions/<sessionId>/scenes/`），服务面按 `forSession(sessionKey)`
 * 取本会话那一份。拿别人的或未知的 sceneId 去读，修前直接漏出
 * `ENOENT: no such file or directory, open '/…/sessions/<key>/worlds/scenes/<sceneId>.json'`：
 * 数据没泄露，但**内部绝对路径**漏到了模型面，错误码也不可判（与本包 `SCENE_VERSION_NOT_FOUND`、
 * `SCENE_BINDING_INVALID`、network-assets 的 `SCENE_NOT_FOUND:` 既有约定不一致）。
 *
 * 本文件钉三件事：
 *   ① 未知 sceneId ⇒ `SCENE_NOT_FOUND: <sceneId>`，消息里**不含 `/`**（证明无路径外泄）；
 *   ② 跨会话语义：A 会话目录里的 sceneId，在 B 会话的 store 里同样是 SCENE_NOT_FOUND
 *      （B 的目录下本就没有这个文件，不是靠"认识 A 的路径"）；
 *   ③ 正例：已有场景的读取/更新/历史**零变化**，`SCENE_BINDING_INVALID` / `SCENE_VERSION_NOT_FOUND`
 *      与"缺失场景 code 仍是 ENOENT"（create/open 的判定依据）都照旧。
 *
 * 用真 `SceneStore` / 真 `SceneOperations` / 真文件 / 真临时目录，不是替身。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entity, SceneSnapshot } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
import { SceneOperations } from "../src/operations.ts"
import { atomicJSON } from "../src/persistence.ts"
import { SceneStore } from "../src/store.ts"

test('A08 物理模板一次准备、保存重力与版本；用户删除地面不暗重生',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a08-physics-template-'))
 try{
  const ops=new SceneOperations(root),created=await ops.create({sceneId:'standard',template:'physics-workspace'})
  expect(created.entities).toHaveLength(1);expect(created.physics?.gravityWorldMps2).toEqual([0,0,-9.81])
  expect(created.entities[0]!.components.collision).toMatchObject({shape:'box',halfExtents:[10,10,.05]})
  expect(created.entities[0]!.resources[0]!.source).toMatchObject({units:'m',upAxis:'Z',handedness:'right'})
  expect((await ops.prepareWorkspace({sceneId:created.sceneId,expectedRevision:0})).revision).toBe(0)
  const changed=await ops.configurePhysics({sceneId:created.sceneId,expectedRevision:0,gravityWorldMps2:[0,0,-3]})
  expect((await new SceneStore(root).snapshot(created.sceneId)).physics).toEqual(changed.physics)
  const restored=await ops.scene.restore({sceneId:created.sceneId,expectedRevision:1,revision:0})
  expect(restored.physics?.gravityWorldMps2).toEqual([0,0,-9.81])
  const deleted=await ops.scene.commit({sceneId:created.sceneId,expectedRevision:restored.revision,patch:[{op:'remove',entityId:created.entities[0]!.entityId}]})
  const again=await ops.prepareWorkspace({sceneId:created.sceneId,expectedRevision:deleted.revision})
  expect(again.entities).toEqual([]);expect(again.revision).toBe(deleted.revision)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('A08 blank兼容、重力合法性和CAS拒绝不写文档',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a08-physics-blank-'))
 try{
  const ops=new SceneOperations(root),legacy=await ops.create({sceneId:'legacy'}),blank=await ops.create({sceneId:'blank',template:'blank'})
  expect(legacy.entities).toEqual([]);expect(legacy.physics).toBeUndefined();expect(blank.entities).toEqual([])
  await expect(ops.configurePhysics({sceneId:'blank',expectedRevision:0,gravityWorldMps2:[0,NaN,-9]})).rejects.toThrow()
  const zero=await ops.configurePhysics({sceneId:'blank',expectedRevision:0,gravityWorldMps2:[0,0,0]})
  expect(zero.physics?.gravityWorldMps2).toEqual([0,0,0])
  await expect(ops.configurePhysics({sceneId:'blank',expectedRevision:0,gravityWorldMps2:[0,0,-1]})).rejects.toThrow('场景')
  expect((await ops.scene.snapshot('blank')).physics).toEqual(zero.physics)
 }finally{await rm(root,{recursive:true,force:true})}
})

const MISSING = "missing-scene-id"
/** 两个会话故意用同一个 sceneId：隔离靠归属，不靠命名。 */
const SHARED = "shared-scene-id"
const ENTITY_ID = "shared-entity-id"

let base: string, sessionA: string, sessionB: string
let storeA: SceneStore, storeB: SceneStore, operationsA: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-not-found-"))
  // 与 lyapunov-shell 的 forSession 同构：每个会话一个 world 域，场景落在自己的 scenes/ 下。
  sessionA = join(base, "sessions", "session-a", "worlds")
  sessionB = join(base, "sessions", "session-b", "worlds")
  storeA = new SceneStore(sessionA)
  storeB = new SceneStore(sessionB)
  operationsA = new SceneOperations(sessionA)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const entity = (entityId: string): Entity => ({ entityId, name: entityId, transform: identityTransform(), resources: [], components: {} })

async function errorOf(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try { await run() } catch (error) { return error as Error & { code?: string } }
  throw new Error("预期抛错，但没有抛出")
}

/** 结构化码的形态断言：前缀 + sceneId，且**一个路径分隔符都不许有**。 */
function expectSceneNotFound(error: Error, sceneId: string): void {
  expect(error.message).toBe(`SCENE_NOT_FOUND: ${sceneId}`)
  expect(error.message.startsWith("SCENE_NOT_FOUND:")).toBe(true)
  expect(error.message).not.toContain("/")
  expect(error.message).not.toContain(base)
}

describe("未知/跨会话 sceneId 的读取错误：SCENE_NOT_FOUND 结构化码", () => {
  test("未知 sceneId ⇒ SCENE_NOT_FOUND，消息里不含任何文件系统路径", async () => {
    const error = await errorOf(() => storeA.snapshot(MISSING))
    expectSceneNotFound(error, MISSING)
    // 修前这里是 `ENOENT: no such file or directory, open '<sessionA>/scenes/missing-scene-id.json'`。
    expect(JSON.stringify(error.message)).not.toContain(sessionA)
  })

  test("历史侧读取（versions/version）走同一条守卫，不漏原始 ENOENT", async () => {
    // versions() 先读当前文档；version() 在历史文件缺失后回落读当前文档——两条都落在 snapshot 的守卫上。
    expectSceneNotFound(await errorOf(() => storeA.versions(MISSING)), MISSING)
    expectSceneNotFound(await errorOf(() => storeA.version(MISSING, 0)), MISSING)
  })

  test("跨会话语义：A 的 sceneId 在 B 的 store 里同样是 SCENE_NOT_FOUND（B 目录下没有这个文件）", async () => {
    await operationsA.create({ sceneId: SHARED })
    await operationsA.scene.commit({ sceneId: SHARED, expectedRevision: 0, patch: [{ op: "add", entity: entity(ENTITY_ID) }] })
    // 正对照先钉住：A 自己读得到，B 的清单里根本没有 A 的场景。
    expect((await storeA.snapshot(SHARED)).entities.map(item => item.entityId)).toEqual([ENTITY_ID])
    expect(await operationsA.list()).toEqual([{ sceneId: SHARED, revision: 1, entityCount: 1 }])
    // 核心断言：B 侧报的是 SCENE_NOT_FOUND，而不是漏出 A/B 会话目录的任何一段路径。
    const error = await errorOf(() => storeB.snapshot(SHARED))
    expectSceneNotFound(error, SHARED)
    expect(error.message).not.toContain("session-a")
    expect(error.message).not.toContain("session-b")
    expect((await operationsA.list()).map(item => item.sceneId)).toEqual([SHARED])
  })

  test("缺失场景的错误仍带 code=ENOENT：create/open 靠「文件不存在」判定场景尚不存在", async () => {
    // 这是本项最容易被顺手改坏的地方：operations.create/open 用 code !== "ENOENT" 重抛来区分
    // "场景不存在（可以建）"与"真故障"，换掉这个 code 会让新建场景直接失败。
    expect((await errorOf(() => storeA.snapshot(MISSING))).code).toBe("ENOENT")
    await operationsA.create({ sceneId: SHARED })
    expect((await operationsA.create({ sceneId: "another-scene-id" })).sceneId).toBe("another-scene-id")
    expect((await errorOf(() => operationsA.create({ sceneId: SHARED }))).message).toBe(`SCENE_ALREADY_EXISTS: ${SHARED}`)
  })

  test("正例：已有场景的读取/更新/版本历史零变化", async () => {
    const created = await operationsA.create({ sceneId: SHARED })
    expect([created.sceneId, created.revision, created.entities]).toEqual([SHARED, 0, []])
    const committed: SceneSnapshot = await operationsA.scene.commit({
      sceneId: SHARED, expectedRevision: 0, patch: [{ op: "add", entity: { ...entity(ENTITY_ID), name: "照旧的实体" } }],
    })
    expect([committed.revision, committed.entities.map(item => item.name)]).toEqual([1, ["照旧的实体"]])
    // 读当前文档：返回的就是刚提交的那份，一字不差。
    expect(await storeA.snapshot(SHARED)).toEqual(committed)
    // 历史元数据与按版本读取照旧（含"建 + 一次提交"两版）。
    expect((await storeA.versions(SHARED)).map(item => [item.revision, item.current])).toEqual([[0, false], [1, true]])
    expect(await storeA.version(SHARED, 0)).toEqual(created)
    // 这两个既有错误码的行为一律不动：版本不存在仍是 SCENE_VERSION_NOT_FOUND；
    // 文件名与正文 sceneId 不一致仍是 SCENE_BINDING_INVALID（CR-003）。
    expect((await errorOf(() => storeA.version(SHARED, 99))).message).toBe(`SCENE_VERSION_NOT_FOUND: ${SHARED}@99`)
    await atomicJSON(storeA.path("binding-scene-id"), { ...committed, sceneId: "other-scene-id" })
    expect((await errorOf(() => storeA.snapshot("binding-scene-id"))).message).toBe("SCENE_BINDING_INVALID: binding-scene-id != other-scene-id")
  })
})
