/**
 * P0 会话隔离（场景侧）的**最短反例**：两个真实会话在同一个 Host 上，用**完全相同的**
 * sceneId / entityId，各自成立、互不覆盖。
 *
 * 修前 `ctx.scene` 是 Host 级一套 `SceneOperations`：`create()` 撞名即 `SCENE_ALREADY_EXISTS`、
 * `list()` 列出所有会话的场景、`commit()` 写的是同一份文档——这就是用户实测的
 * 「A 会话加载环境覆盖了 B 会话的 3D 场景」。这里钉的是**归属维度本身**：
 *   1. 跨会话不可见：A 的场景不出现在 B 的 `list()` 里（旧行为下必然出现）；
 *   2. 同名各自成立：同一个 sceneId 在两个会话里是两份文档，各自的内容/版本独立推进；
 *   3. 释放边界：删掉 A 那份文档，B 的场景与版本一步不动。
 *
 * 用的是真 `SceneStore` / 真文件 / 真临时 dataRoot（不是替身）：`forSession` 返回的两套
 * operations 落到 `<dataRoot>/sessions/<会话键>/…` 两个不同的目录，这一点由磁盘路径本身证明。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import Commands from "@deepseek-ai/dsh-commands"
import Sessions, { SessionId } from "@deepseek-ai/dsh-session"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import Tools from "@deepseek-ai/dsh-tools"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Entity } from "../../lyapunov-contracts/src/types.ts"
import { identityTransform } from "../../lyapunov-contracts/src/types.ts"
import * as scenePlugin from "../src/plugin.ts"

const SESSION_A = "isolation-session-a", SESSION_B = "isolation-session-b"
/** 两个会话故意用同一个场景 id 与同一个实体 id：隔离靠归属，不靠命名。 */
const SCENE_ID = "shared-scene-id"
const ENTITY_ID = "shared-entity-id"

let base: string, dataRoot: string, ctx: Context

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-scene-isolation-"))
  dataRoot = join(base, "data")
  ctx = new Context()
  // 与 scene-replace-tool.test.ts 同一套真实上游装配：scene-kit 声明 inject=["tools","commands"]，
  // 只有这两个服务真的就绪它才会 apply（才会 provide("scene")）；tools 自身还要 systemPrompt。
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(Commands)
  await ctx.plugin(scenePlugin, { dataRoot })
  // 两个都是**真实会话**（原生 SessionId），身份来自会话本身而不是测试自编的字符串。
  ctx.sessions.create(SessionId(SESSION_A))
  ctx.sessions.create(SessionId(SESSION_B))
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

const entity = (entityId: string): Entity => ({ entityId, name: entityId, transform: identityTransform(), resources: [], components: {} })

describe("场景按会话归属（同名场景 id 在两个会话里各自成立）", () => {
  test("A 创建的场景在 B 的清单里不可见，B 能用同一个 sceneId 建自己的一份", async () => {
    const a = ctx.scene.forSession(SESSION_A), b = ctx.scene.forSession(SESSION_B)
    await a.create({ sceneId: SCENE_ID })
    await a.scene.commit({ sceneId: SCENE_ID, expectedRevision: 0, patch: [{ op: "add", entity: entity(ENTITY_ID) }] })
    // 核心断言：不是"前缀拼对了"，而是 B 的清单里根本没有 A 的场景（旧行为下这里必然能看到）。
    expect((await b.list()).map(item => item.sceneId)).toEqual([])
    // 同一个 sceneId 在 B 里照样能建：不撞 A 的那份（旧行为下这里报 SCENE_ALREADY_EXISTS）。
    const created = await b.create({ sceneId: SCENE_ID })
    expect(created.revision).toBe(0)
    expect((await b.list()).map(item => item.sceneId)).toEqual([SCENE_ID])
  })

  test("同名 sceneId/entityId 下内容与版本各自推进，互不覆盖", async () => {
    const a = ctx.scene.forSession(SESSION_A), b = ctx.scene.forSession(SESSION_B)
    await a.create({ sceneId: SCENE_ID })
    await b.create({ sceneId: SCENE_ID })
    await a.scene.commit({ sceneId: SCENE_ID, expectedRevision: 0, patch: [{ op: "add", entity: { ...entity(ENTITY_ID), name: "A 的实体" } }] })
    await b.scene.commit({ sceneId: SCENE_ID, expectedRevision: 0, patch: [{ op: "add", entity: { ...entity(ENTITY_ID), name: "B 的实体" } }] })
    const snapshotA = await a.scene.snapshot(SCENE_ID), snapshotB = await b.scene.snapshot(SCENE_ID)
    expect([snapshotA.revision, snapshotB.revision]).toEqual([1, 1])
    expect(snapshotA.entities.map(item => item.name)).toEqual(["A 的实体"])
    expect(snapshotB.entities.map(item => item.name)).toEqual(["B 的实体"])
    // A 再改两次：B 的版本与内容一步不动（这正是"用户在 A 里编辑/加载不该动到 B"的判据）。
    await a.scene.commit({ sceneId: SCENE_ID, expectedRevision: 1, patch: [{ op: "update", entityId: ENTITY_ID, changes: { name: "A 改过的实体" } }] })
    await a.create({ sceneId: "a-only-scene" })
    expect((await a.list()).map(item => item.sceneId).sort()).toEqual(["a-only-scene", SCENE_ID])
    expect((await b.list()).map(item => item.sceneId)).toEqual([SCENE_ID])
    expect(await b.scene.snapshot(SCENE_ID)).toEqual(snapshotB)
    // 版本历史同样按会话：B 只有自己的两份（建 + 一次提交），A 后来的编辑不在里面；A 有第三份。
    expect((await b.scene.versions(SCENE_ID)).map(item => item.revision)).toEqual([0, 1])
    expect((await a.scene.versions(SCENE_ID)).map(item => item.revision)).toEqual([0, 1, 2])
  })

  test("两份文档落在各自会话的目录：删掉 A 那份，B 的场景与版本不被波及", async () => {
    const a = ctx.scene.forSession(SESSION_A), b = ctx.scene.forSession(SESSION_B)
    await a.create({ sceneId: SCENE_ID }); await b.create({ sceneId: SCENE_ID })
    const pathA = a.scene.path(SCENE_ID), pathB = b.scene.path(SCENE_ID)
    expect(pathA).not.toBe(pathB)
    expect(pathA.startsWith(join(dataRoot, "sessions"))).toBe(true)
    expect(pathB.startsWith(join(dataRoot, "sessions"))).toBe(true)
    const before = await b.scene.snapshot(SCENE_ID)
    await rm(pathA)
    await expect(a.scene.snapshot(SCENE_ID)).rejects.toThrow(/ENOENT|SCENE_NOT_FOUND/)
    expect(await b.scene.snapshot(SCENE_ID)).toEqual(before)
    expect((await b.list()).map(item => item.sceneId)).toEqual([SCENE_ID])
  })

  test("缺会话键明确失败：场景服务不落回任何共享存储", () => {
    for (const key of ["", "   "]) expect(() => ctx.scene.forSession(key)).toThrow(/SESSION_SCOPE_UNAVAILABLE/)
  })
})
