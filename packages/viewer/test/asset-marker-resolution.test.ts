/**
 * `res:<指纹>` 的**真实语义**：它是**定位符**的指纹（`product-paths.ts` 的 `resourceToken`），
 * **不是**文件内容的 sha256，**不是**派生目录名（`scene_projection.py:596/660` 的那个 16 位十六进制）。
 * 本文件把这条判据钉死，并验 `resolveAssetMarker` —— 标记唯一可行的解析方式（对授权候选集重算匹配）。
 *
 * 为什么必须有这一条：2026-09-27 的裁定（`docs/REMAINING_WORK_PLAN.md` §七之十八之后的派单）把标记
 * 当成了"内容指纹，且本身就是派生目录名"，于是要求消费端按 `<derived_root>/meshes/<指纹>/` 去解析。
 * 本文件用**可复算的判据**说明那条路走不通，同时把**走得通**的那一条（候选集重算匹配）钉住：
 *  · 标记是 `"res:" + 32 位十六进制`，其中**高 16 位恒为 `0`**（`fingerprint` 只填满低 64 位）；
 *    内容摘要是 16 位十六进制、没有这个补零形状 ⇒ 两者**不可能是同一个串**；
 *  · 派生目录名确实等于内容摘要（`sha256(bytes)[:16]`），但那个摘要在**候选集那一侧**
 *    （`file:///…/derived-assets/meshes/<摘要>/<名字>.obj`），**不在标记里**。
 *
 * 环境说明：本文件只做纯函数 + 一个自建临时目录的往返，不读仓库外的语料、不读 `.runtime/**`。
 * 真语料读数（488 个机器人实体 / 7602 个定位符 / 声明表 4366）在回执
 * `bugfixHistory/NO-LEDGER-TOKEN-RESOLUTION-20260926.md` 与 `.noledger-scratch/**`，不在这里。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { resourceToken } from "../../lyapunov-contracts/src/product-paths.ts"
import { assetMarkerOf, describeAssetReference, pairDocumentAssets, resolveAssetMarker } from "../src/asset-locator.ts"

const MARK_SHAPE = /^res:[0-9a-f]{16}0{16}$/

describe("`res:<指纹>` 的定义：它是**定位符**的指纹，不是内容摘要，也不是派生目录名", () => {
  test("① `assetMarkerOf` 就是产生端那一份（同一个函数、同一份取值），本模块没有第二套指纹算法", () => {
    const samples = [
      "file:///home/agent/product/robots/libero/meshes/bottle.STL",
      "file:///opt/derived-assets/meshes/0123456789abcdef/pelvis.obj",
      "meshes/pelvis.STL",
    ]
    for (const locator of samples) expect({ locator, mark: assetMarkerOf(locator) }).toEqual({ locator, mark: resourceToken(locator) })
    // 逐值固定（`resourceToken` 是纯函数，跨机器同值）：这一条一旦变红＝两端定义分叉。
    expect(assetMarkerOf("file:///home/agent/product/robots/libero/meshes/bottle.STL")).toBe("res:cf86a9669773cd4c0000000000000000")
    expect(assetMarkerOf("file:///opt/derived-assets/meshes/0123456789abcdef/pelvis.obj")).toBe("res:6907886dd0e407e70000000000000000")
    expect(assetMarkerOf("meshes/pelvis.STL")).toBe("res:63a36da607d6d82a0000000000000000")
    // 空／非字符串不造标记（不制造 `res:` 这种没有指纹的假标记）。
    expect(assetMarkerOf("")).toBeUndefined()
    expect(assetMarkerOf(undefined)).toBeUndefined()
    expect(assetMarkerOf(42)).toBeUndefined()
  })

  test("② 标记的形状（32 位十六进制、高 16 位恒 0）与内容摘要（16 位十六进制）**互斥**", () => {
    for (const locator of ["file:///a/b.stl", "file:///x/y/z.obj", "data/derived-assets/textures/9aaa94ef4cd61592/dark_fine_wood.png"])
      expect(assetMarkerOf(locator)).toMatch(MARK_SHAPE)
    // 判据的**要害**：标记去掉前缀是 32 位，内容摘要是 16 位 ⇒ 拿 16 位摘要去等标记永远不成立。
    const mark = assetMarkerOf("file:///a/b.stl")!
    expect(mark.slice("res:".length)).toHaveLength(32)
    const digest = createHash("sha256").update("whatever bytes").digest("hex").slice(0, 16)
    expect(digest).toMatch(/^[0-9a-f]{16}$/)
    expect(mark).not.toBe(digest)
    expect(mark.slice("res:".length)).not.toBe(digest)
  })

  test("③ 派生目录名 == 内容摘要，但那个摘要在**候选集那一侧**，不在标记里（真文件往返）", () => {
    const root = mkdtempSync(join(tmpdir(), "lyapunov-marker-"))
    const bytes = Buffer.from("solid derived\nendsolid derived\n", "utf8")
    // `scene_projection.py:596` 的规则：目录名 = sha256(**源字节**)[:16]；派生件落在 <root>/meshes/<摘要>/<名字>.obj
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
    const directory = join(root, "derived-assets", "meshes", digest)
    mkdirSync(directory, { recursive: true })
    const target = join(directory, "pelvis.obj")
    writeFileSync(target, bytes)
    const locator = pathToFileURL(target).href

    const mark = assetMarkerOf(locator)!
    expect(mark).toMatch(MARK_SHAPE)
    // 目录名确实等于内容摘要 ⇒ 派生根里"内容寻址"是真的
    expect(target.split("/").at(-2)).toBe(digest)
    // 但标记的**有效位**不等于那个摘要 ⇒ 「按产生端的定义把标记当目录名」在任何一条真文件上都不成立
    expect(mark.slice("res:".length, "res:".length + 16)).not.toBe(digest)
    expect(mark.slice("res:".length)).not.toBe(digest)
    // 反向：拿摘要当标记去找，找不到（这正是"不许猜"要挡住的那一步）
    expect(resolveAssetMarker(`res:${digest}`, [locator])).toBeUndefined()
    // 正向：拿真标记对着真候选集找，找得到**实际文件**
    expect(resolveAssetMarker(mark, [locator])).toBe(locator)
    expect(resolveAssetMarker(mark, [locator])).toBe(pathToFileURL(target).href)
  })

  test("④ `resolveAssetMarker`：只在授权候选集里等值匹配；解不出一律 undefined（不猜、不顶替）", () => {
    const a = "file:///opt/derived-assets/meshes/0123456789abcdef/pelvis.obj"
    const b = "file:///opt/derived-assets/meshes/fedcba9876543210/pelvis.obj"
    const mark = assetMarkerOf(a)!
    expect(resolveAssetMarker(mark, [a, b])).toBe(a)
    // 候选集里没有它 ⇒ undefined（不是"挑一个最像的"）
    expect(resolveAssetMarker(mark, [b])).toBeUndefined()
    expect(resolveAssetMarker(mark, [])).toBeUndefined()
    // 差一位十六进制不是"同一件"（指纹是逐位判据，不是前缀/相似度判据）
    const nearly = `res:${mark[4] === "0" ? "1" : "0"}${mark.slice(5)}`
    expect(resolveAssetMarker(nearly, [a, b])).toBeUndefined()
    // 不是标记的输入一律不解析（相对引用、真名、空串、非字符串都由调用方按各自语义处理）
    for (const value of ["meshes/pelvis.STL", a, "", undefined, 42, "res:"]) expect(resolveAssetMarker(value, [a, b])).toBeUndefined()
    // ⚠️ 候选集必须是**原像**定位符，不是标记：拿标记当候选永远解不出（把标记再指纹一次 ≠ 标记本身）。
    expect(resolveAssetMarker(mark, [mark])).toBeUndefined()
    expect(resolveAssetMarker(assetMarkerOf(b)!, [b])).toBe(b)
  })

  test("⑤ 配对判据的**直接命中**：两侧标记逐字相等 ⟺ 产生端对同一份原像写过两次标记（消费端只做等值比较，不重算）", () => {
    const mesh = pathToFileURL("/opt/product/robots/g1/meshes/pelvis.STL").href
    const texture = pathToFileURL("/opt/product/robots/g1/meshes/dark.png").href
    const doc = pathToFileURL("/opt/product/robots/g1/g1.xml").href
    const entity = {
      resources: [{
        original: { uri: resourceToken(doc), mimeType: "application/x-mjcf+xml" },
        representations: [
          { uri: resourceToken(doc), mimeType: "application/x-mjcf+xml" },
          { uri: resourceToken(mesh), mimeType: "model/stl" },
          { uri: resourceToken(texture), mimeType: "image/png" },
        ],
      }],
      components: {
        visual: { kind: "robot", robot: { document: { asset: { mesh: [{ file: resourceToken(mesh) }], texture: [{ file: resourceToken(texture) }] } } } },
      },
    }
    const pairings = pairDocumentAssets(entity)
    expect(pairings.map(row => row.mimeType)).toEqual(["model/stl", "image/png"])
    // 消费端这一侧只有标记：配对成功 ⟺ 两侧标记相等 ⟺ 原像的标记同值。
    for (const row of pairings) expect(row.file).toBe(row.uri)
    // 持有**原像**的一侧（媒体路由／离线工具）才谈得上"重算"：同一份原像的标记与文档引用逐字相等。
    const preImages = [doc, mesh, texture]
    for (const [index, preImage] of [mesh, texture].entries())
      expect(resolveAssetMarker(pairings[index]!.uri, preImages)).toBe(preImage)
    // 拿**标记**当候选集 ⇒ 一条都解不出（这正是"消费端不能自己还原绝对路径"的算术依据）
    expect(resolveAssetMarker(pairings[0]!.uri, entity.resources[0]!.representations.map(rep => rep.uri))).toBeUndefined()
    // **解不出**的引用不会出现在配对结果里（既有的"配不上就是空表"语义原样）
    const orphanMark = assetMarkerOf("file:///opt/product/robots/g1/meshes/not-registered.stl")!
    const orphan = { ...entity, components: { ...entity.components, visual: { ...entity.components.visual, robot: { ...entity.components.visual.robot, document: { asset: { mesh: [{ file: orphanMark }] } } } } } }
    expect(pairDocumentAssets(orphan as never)).toEqual([])
    expect(resolveAssetMarker(orphanMark, preImages)).toBeUndefined()
  })

  test("⑥ 缺件文案仍含既有的「不可逆标记」四个字（别的工作面的断言依赖它），同时说清真实语义", () => {
    const text = describeAssetReference("res:0123abcd", { mimeType: "model/stl", format: "stl" })
    expect(text).toContain("不可逆标记")
    expect(text).toContain("定位符指纹")
    expect(text).toContain("model/stl")
    // 不带真名的定位符仍走另一条文案（判据失败要能一眼看出是哪一种）
    expect(describeAssetReference("meshes/")).toContain("定位符没有可用后缀")
  })
})
