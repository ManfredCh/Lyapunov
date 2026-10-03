/**
 * ENV-60 便携闭包（N272）：保存出的包**搬到另一个绝对路径**之后，文档里的每条引用
 * （`original.uri` + `representations[].uri`）都必须仍可解析——这才是"脱离原目录完整加载"的前提。
 *
 * 旧用例只断言**同一路径**下的往返（保存后就在原目录打开），所以"包内少了一棵表示树"能一路漏到
 * 真机 `scene_open` 才炸（R6 实测 240/120 次 `SCENE_RESOURCE_UNAVAILABLE`）。这里补两件：
 *   1. 闭包完整性（搬家后逐条可解析 + 真用产品口径重开一次）；
 *   2. 负对照（包内缺一个表示文件 ⇒ 必须显式报缺，不静默）。
 * 真文件、真 CAS、真库，不 mock。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { SceneOperations } from "../src/operations.ts"

let base: string, dataRoot: string, fixtures: string, operations: SceneOperations

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lyapunov-relocation-"))
  dataRoot = join(base, "data")
  fixtures = join(base, "fixtures")
  await mkdir(fixtures, { recursive: true })
  operations = new SceneOperations(dataRoot)
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 最小合法 GLB（与 portable-environment.test.ts 同一构造口径）。 */
function glbBytes(generator: string): Buffer {
  const json = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: generator }], meshes: [{ primitives: [] }] }
  const payload = Buffer.from(JSON.stringify(json), "utf8")
  const chunk = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), chunkHeader = Buffer.alloc(8), total = 12 + 8 + chunk.length
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  chunkHeader.writeUInt32LE(chunk.length, 0); chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}
async function fixture(name: string, content: Buffer): Promise<string> {
  const path = join(fixtures, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}
/** 判定一个引用的 URI 在**文档目录**下是否可解析、且落在该目录内。 */
function closureRows(docPath: string, doc: { entities: Array<{ resources: Array<{ original: { uri: string }; representations?: Array<{ uri: string }> }> }> }): Array<{ uri: string; path: string; inside: boolean; exists: boolean }> {
  const dir = dirname(docPath)
  const rows: Array<{ uri: string; path: string; inside: boolean; exists: boolean }> = []
  for (const entity of doc.entities) for (const ref of entity.resources) {
    for (const rep of [ref.original, ...(ref.representations ?? [])]) {
      const raw = rep.uri.startsWith("file:") ? decodeURIComponent(new URL(rep.uri).pathname) : rep.uri
      const path = resolve(dir, raw)
      rows.push({ uri: rep.uri, path, inside: path.startsWith(dir + "/"), exists: existsSync(path) })
    }
  }
  return rows
}
const rejection = (action: () => Promise<unknown>): Promise<Error> => action().then(() => { throw new Error("EXPECTED_REJECTION") }, error => error as Error)

/** 造一个"原件 + 表示通道"的场景（表示以**绝对 URI** 写进库内文档，会话内文档的正常形态）。 */
async function relocateFixture(sceneId: string): Promise<{ pkg: string; visual: string }> {
  await operations.create({ sceneId })
  const model = await fixture("model.glb", glbBytes("reloc-model"))
  const visual = await fixture("visuals/model-visual.glb", glbBytes("reloc-visual"))
  await operations.import({ path: model, sceneId, entityId: "obj-1", resourceId: "res_reloc", name: "件", physicalize: false })
  const storePath = join(dataRoot, "scenes", `${sceneId}.json`)
  const doc = JSON.parse(await readFile(storePath, "utf8"))
  for (const entity of doc.entities) for (const ref of entity.resources) ref.representations = [{ uri: pathToFileURL(visual).href, mimeType: "model/gltf-binary", role: "visual" }]
  await writeFile(storePath, JSON.stringify(doc))
  const pkg = join(base, "pkg")
  await mkdir(pkg, { recursive: true })
  return { pkg, visual }
}

describe("ENV-60 便携闭包：搬家后可解析（N272）", () => {
  test("保存出的包搬到另一绝对路径后，original/representations 每条引用都在包内且存在", async () => {
    const { pkg } = await relocateFixture("scene_reloc")
    const saved = await operations.save("scene_reloc", join(pkg, "scene.json"), { portable: true })
    const rows = closureRows(join(pkg, "scene.json"), saved.snapshot)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) { expect(row.inside).toBe(true); expect(row.exists).toBe(true) }
    // 包内引用必须是**相对路径**（换绝对路径后还能用），不是原目录的绝对路径。
    for (const row of rows) expect(row.uri.startsWith("file:") || row.uri.startsWith("/")).toBe(false)

    // 搬家：整包换到另一个绝对路径（原目录不再存在）。
    const moved = join(base, "pkg-moved")
    await rename(pkg, moved)
    const movedDoc = JSON.parse(await readFile(join(moved, "scene.json"), "utf8"))
    for (const row of closureRows(join(moved, "scene.json"), movedDoc)) { expect(row.inside).toBe(true); expect(row.exists).toBe(true) }
    // 真用产品口径重开一次（新库、新账号数据根）：能读回同一批实体。
    const reopened = await new SceneOperations(join(base, "data-reopened")).open(join(moved, "scene.json"), { sceneId: "scene_reloc_reopened" })
    expect(reopened.entities.length).toBe(saved.snapshot.entities.length)
  })

  test("负对照：包内缺一个表示文件 ⇒ 重开必须显式报 SCENE_RESOURCE_UNAVAILABLE，不静默", async () => {
    const { pkg } = await relocateFixture("scene_missing")
    const saved = await operations.save("scene_missing", join(pkg, "scene.json"), { portable: true })
    const rows = closureRows(join(pkg, "scene.json"), saved.snapshot)
    const visualRow = rows.find(row => row.path.endsWith("model-visual.glb"))!
    expect(visualRow).toBeDefined()
    await rename(visualRow.path, `${visualRow.path}.parked`)
    const error = await rejection(() => new SceneOperations(join(base, "data-broken")).open(join(pkg, "scene.json"), { sceneId: "scene_missing_broken" }))
    expect(error.message).toContain("SCENE_RESOURCE_UNAVAILABLE")
    // 恢复后同一条路径必须重新可开（缺件判定不是永久性结论）。
    await rename(`${visualRow.path}.parked`, visualRow.path)
    const recovered = await new SceneOperations(join(base, "data-recovered")).open(join(pkg, "scene.json"), { sceneId: "scene_missing_recovered" })
    expect(recovered.entities.length).toBe(saved.snapshot.entities.length)
  })

  test("负对照：表示文件在保存前就不在场 ⇒ 要么拒绝出包、要么报缺，绝不静默出包", async () => {
    const { pkg, visual } = await relocateFixture("scene_absent")
    await rename(visual, `${visual}.parked`)
    const error = await rejection(() => operations.save("scene_absent", join(pkg, "scene.json"), { portable: true }))
    expect(/ENOENT|PORTABLE_REPRESENTATION_UNPLACED|SCENE_RESOURCE_UNAVAILABLE/.test(error.message)).toBe(true)
    await rename(`${visual}.parked`, visual)
    const saved = await operations.save("scene_absent", join(pkg, "scene.json"), { portable: true })
    for (const row of closureRows(join(pkg, "scene.json"), saved.snapshot)) { expect(row.inside).toBe(true); expect(row.exists).toBe(true) }
  })
})
