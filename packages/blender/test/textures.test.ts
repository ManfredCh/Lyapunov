/**
 * `packages/blender/src/textures.ts` 的行为测试（贴图检索候选与复用）。
 *
 * 夹具边界，必须如实标注：
 *  · 候选/清单 metadata **逐字取自 2026-09-18 的一次真实官方列表快照**（862 条纹理的
 *    `/assets?t=textures`，缓存于 `.runtime/probe/archi-tiananmen/workspace/analysis/v4/ph_textures.json`），
 *    只做两处**显式**改动：① 预览图主机改指夹具服务器（便于离线验证预览落盘，默认不改）；
 *    ② 命中"官方最高档不足"分支时改写某个条目的 `max_resolution`。其余字段未改，测试逐条核对。
 *  · HTTP 服务器（`/assets`、`/files`、`/cdn`、`/thumb`）是**合成夹具**：按官方形状返回，但 URL、
 *    字节数、md5 是本地生成的；图片内容是填充字节，**不能替代真实贴图**，只用于验证下载/复用/
 *    取消/限额这些行为。真实 API 的联网行为不在本机验证范围内（本环境无外网出口）。
 *  · 测试产物落在系统临时目录并在 afterAll 清理。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { explainTextureQuery, fetchTextureSet, findTexture, findTextures } from "../src/textures.ts"
import type { TextureResolution } from "../src/textures.ts"

// ---------------------------------------------------------------------------
// 真实 metadata 夹具（逐字取自缓存快照，未改数值）
// ---------------------------------------------------------------------------
const REAL_CATALOG: Record<string, Record<string, unknown>> = {
  red_bricks_04: {
    type: 1,
    tags: ["textured", "bricks", "baked", "rough", "uneven", "urban", "clean", "red"],
    name: "Red Bricks 04",
    categories: ["outdoor", "man made", "wall", "brick"],
    authors: { "Rob Tuytel": "All" },
    date_published: 1633392000,
    sponsors: ["3267566", "20953239"],
    dimensions: [2500, 2500],
    max_resolution: [8192, 8192],
    files_hash: "d014230a431d9cd4cb59000dc50e6da35144054c",
    description: "Free 8K texture of red, uneven baked bricks with rough surface, weathered edges and clean mortar; urban, detailed wall material.",
    category_id: "9ef0955b-87fa-5826-aa87-98b047ad9143",
    category: "Brick & Block/Clay Brick/Running-Bond",
    attributes: { surface_use: "wall", condition: ["weathered"], origin: "man_made", setting: "outdoor" },
    img_version: "dc99f93b",
    download_count: 102691,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/red_bricks_04.png?width=256&height=256&v=dc99f93b",
  },
  brick_wall_04: {
    name: "Brick Wall 04",
    categories: ["outdoor", "man made", "wall", "brick", "plaster-concrete"],
    type: 1,
    authors: { "Dario Barresi": "Baking ", "Dimitrios Savva": "Photography", "Rico Cilliers": "Tiling " },
    info: null,
    tags: ["rough", "uneven", "wall", "chipped", "damaged", "rock", "rocks", "concrete", "plaster", "brick", "bricks", "cement", "weathered", "stones", "cracked", "worn"],
    dimensions: [1389.9999856948853, 1389.9999856948853],
    date_published: 1674691200,
    max_resolution: [8192, 8192],
    files_hash: "235e0a507639bbca4ff4a63f316894ffd35d01cf",
    description: "Free 8K texture: rough brick wall with chipped stone faces, cracked cement mortar and worn plaster surfaces.",
    category_id: "9ef0955b-87fa-5826-aa87-98b047ad9143",
    category: "Brick & Block/Clay Brick/Running-Bond",
    attributes: { surface_use: "wall", condition: ["weathered", "damaged", "cracked", "worn"], origin: "man_made", setting: "outdoor" },
    img_version: "dda2d553",
    download_count: 37108,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/brick_wall_04.png?width=256&height=256&v=dda2d553",
  },
  grey_plaster: {
    date_published: 1529359200,
    name: "Grey Plaster",
    categories: ["plaster", "outdoor", "indoor", "man made", "wall", "floor", "plaster-concrete"],
    type: 1,
    dimensions: [1000, 1000],
    tags: ["moss", "plain", "bare"],
    authors: { "Rob Tuytel": "All" },
    max_resolution: [8192, 8192],
    files_hash: "a50b917a248abd0044b4c81bd68baa02d6584b66",
    description: "Free 8K texture of grey plaster with subtle mossing and weathered, porous surface - rough, matte finish with soft discoloration and fine granular detail.",
    category_id: "ebaa964c-b45c-52e2-bd50-892d64616d87",
    category: "Concrete/Plaster & Stucco/Bare Plaster",
    attributes: { surface_use: "wall", condition: ["weathered", "mossy"], origin: "man_made", setting: "either" },
    img_version: "367870e9",
    download_count: 125495,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/grey_plaster.png?width=256&height=256&v=367870e9",
  },
  oak_wood_planks: {
    type: 1,
    name: "Oak Wood Planks",
    tags: ["wood", "planks", "oak", "wooden floor", "wooden flooring ", "wooden planks", "varnished", "timber", "plank", "coated"],
    authors: { "Dimitrios Savva": "All" },
    max_resolution: [8192, 8192],
    dimensions: [1200.0000476837158, 1200.0000476837158],
    files_hash: "3d6efc312fcf1704fba7b78c1aa0ffb7159ada22",
    description: "Free 8K texture of varnished oak wood planks with warm grain, subtle gloss and seamless joins - ideal for realistic wooden flooring, furniture, and interior scenes.",
    category_id: "a7bb33c4-8575-586e-a502-7094517b10c5",
    category: "Wood/Boards & Planks/Finished & Varnished",
    attributes: { surface_use: "floor", origin: "man_made", condition: ["clean"] },
    date_published: 1786448942,
    categories: ["wood"],
    vault: "wood",
    img_version: "79953a74",
    download_count: 8027,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/oak_wood_planks.png?width=256&height=256&v=79953a74",
  },
  wood_planks: {
    name: "Wood Planks",
    categories: ["floor", "wood", "raw wood", "man made"],
    type: 1,
    tags: ["rough", "weathered", "old", "discolored", "wood", "floor", "wooden planks", "wooden flooring ", "planks", "plank", "grain", "aged", "worn", "scratched", "wooden", "timber"],
    authors: { "Amal Kumar": "All" },
    info: null,
    dimensions: [1499.999761581421, 1499.999761581421],
    date_published: 1700697600,
    sponsors: ["78546118"],
    max_resolution: [8192, 8192],
    files_hash: "1742bf4a727e0443e7ca3fc67b01f68ff45a2ec2",
    description: "Free 8K wood texture of weathered, aged planks with warm brown tones, visible grain, scratches, gaps and a worn, slightly discolored timber surface.",
    category_id: "30ac2613-5076-5364-b4da-130117ad592d",
    category: "Wood/Boards & Planks/Weathered Planks",
    attributes: { surface_use: "floor", condition: ["weathered", "worn"], origin: "man_made" },
    img_version: "da0c3e1b",
    download_count: 134592,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/wood_planks.png?width=256&height=256&v=da0c3e1b",
  },
  granite_tile_03: {
    type: 1,
    name: "Granite Tile 03",
    categories: ["wall", "tiles"],
    tags: ["granite", "granite tile", "granite blocks", "wall", "urban", "speckled ", "slab", "outdoor", "stone tile"],
    authors: { "Charlotte Baglioni": "All" },
    max_resolution: [8192, 8192],
    dimensions: [1802.0000457763672, 1802.0000457763672],
    date_published: 1744848000,
    files_hash: "08d41e4cbee63de142b19caa392247f0e441baa3",
    description: "Free 8K granite tile texture: speckled brown-grey stone slabs with fine grain, subtle micro-roughness, tight grout lines and a low satin sheen.",
    category_id: "c1b6840e-81a6-56d1-9cf0-1ef10c0aa6a2",
    category: "Stone/Slabs & Tiles/Granite",
    attributes: { surface_use: "wall", origin: "man_made", setting: "outdoor", condition: ["clean"] },
    img_version: "71827c3e",
    download_count: 6466,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/granite_tile_03.png?width=256&height=256&v=71827c3e",
  },
  clay_roof_tiles_03: {
    name: "Clay Roof Tiles 03",
    categories: ["man made", "outdoor", "roofing"],
    type: 1,
    tags: ["weathered", "uneven", "clay", "clay tiles", "roof", "roofing", "tile roofing", "overlapping tiles", "traditional", "traditional roofing "],
    authors: { "Amal Kumar": "All" },
    max_resolution: [8192, 8192],
    dimensions: [2599.9999046325684, 2599.9999046325684],
    date_published: 1720483200,
    files_hash: "431e8f1241999dcfb84781c1eea0200c3d113055",
    description: "Free 8K clay roof tile texture of weathered, uneven terracotta tiles with overlapping rows, chipped edges, gritty dirt in crevices and embossed diamond shaped details.",
    category_id: "6165a492-c53c-5b5f-96df-20c96a7763df",
    category: "Ceramic/Terracotta",
    attributes: { surface_use: "roof", condition: ["weathered", "worn", "damaged"], origin: "man_made", setting: "outdoor" },
    img_version: "7240aa70",
    download_count: 24794,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/clay_roof_tiles_03.png?width=256&height=256&v=7240aa70",
  },
  // prepaid：付费/抢先体验，适配器只列候选、不下载（真实快照里 862 条中有 18 条如此）
  stone_tiles: {
    prepaid: true,
    type: 1,
    date_published: 1672704000,
    name: "Stone Tiles",
    categories: ["man made", "wall", "floor", "indoor", "outdoor"],
    dimensions: [3170.0000762939453, 3169.999837875366],
    info: null,
    authors: { "Christopher Melani": "All" },
    sponsors: ["44302755"],
    max_resolution: [8192, 8192],
    tags: ["tiles", "stones", "flat", "rocks", "shiny", "reflective", "uneven", "rock", "floor", "smooth", "wall", "pavement", "pathway"],
    files_hash: "f637ef5613db2299a5f43aabb932ae8e310670e7",
    description: "Free 8K texture of dark irregular stone tiles with subtle shine, smooth worn faces, uneven edges and narrow mortar joints, slightly reflective surface.",
    category_id: "42008e30-c71f-5d74-af61-22ee59098e60",
    category: "Stone/Slabs & Tiles/Mixed-Stone",
    attributes: { surface_use: "floor", condition: ["worn"], origin: "man_made", setting: "either" },
    img_version: "2a16a7d0",
    download_count: 57925,
    thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/stone_tiles.png?width=256&height=256&v=2a16a7d0",
  },
}

const MAP_NAMES = ["Diffuse", "nor_gl", "Rough", "AO"] as const
const FILE_BYTES = 512

// ---------------------------------------------------------------------------
// 合成 HTTP 夹具
// ---------------------------------------------------------------------------
interface FixtureConfig {
  /** 覆盖 `/assets` 的返回（默认用真实快照；localThumbnails 时改预览图主机）。 */
  catalog?: Record<string, unknown>
  localThumbnails?: boolean
  /** 这些 id 的预览图返回 404。 */
  thumbnailMissing?: string[]
  thumbnailBytes?: number
  /** `/files` 生成哪些档，默认 1k/2k/4k。 */
  resolutions?: TextureResolution[]
  catalogDelayMs?: number
  fileDelayMs?: number
  /** >0：`/cdn` 返回这么大的文件（带 content-length）。 */
  overflowBytes?: number
  /** >0：`/cdn` 用分块流返回这么大（没有 content-length）。 */
  chunkedBytes?: number
  /** Diffuse 用"先给一块再挂住"的流，配合 AbortSignal 测下载中取消。 */
  slowDiffuse?: boolean
  /** 这些 CDN 路径返回 404。 */
  missingCdn?: string[]
}

interface FixtureServer {
  base: string
  calls: string[]
  config: FixtureConfig
  reset(): void
  count(prefix: string): number
  stop(): Promise<void>
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function catalogWithLocalThumbnails(origin: string): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(REAL_CATALOG)) as Record<string, Record<string, unknown>>
  for (const [id, entry] of Object.entries(copy)) entry.thumbnail_url = `${origin}/thumb/${id}.png`
  return copy
}

function filesPayload(assetId: string, origin: string, resolutions: TextureResolution[]) {
  const payload: Record<string, Record<string, { jpg: { url: string; size: number; md5: string } }>> = {}
  for (const map of MAP_NAMES) {
    payload[map] = {}
    for (const resolution of resolutions) {
      payload[map][resolution] = {
        jpg: {
          url: `${origin}/cdn/${assetId}/${map}_${resolution}.jpg`,
          size: FILE_BYTES,
          md5: `${assetId}_${map}_${resolution}`.padEnd(32, "0").slice(0, 32),
        },
      }
    }
  }
  return payload
}

/** "先给一块再挂住"的响应：客户端要读完只能靠 AbortSignal 结束。 */
function hangingStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.alloc(64, 1)) },
    cancel() {},
  })
  return new Response(stream, { headers: { "content-type": "image/jpeg" } })
}

function startFixtureServer(initial: FixtureConfig = {}): FixtureServer {
  const config: FixtureConfig = { ...initial }
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(url.pathname + url.search)
      if (url.pathname === "/assets") {
        if (config.catalogDelayMs) await sleep(config.catalogDelayMs)
        return Response.json(config.catalog ?? (config.localThumbnails ? catalogWithLocalThumbnails(url.origin) : REAL_CATALOG))
      }
      if (url.pathname.startsWith("/files/")) {
        const assetId = decodeURIComponent(url.pathname.slice("/files/".length))
        if (!(assetId in REAL_CATALOG)) return new Response("unknown asset", { status: 404 })
        return Response.json(filesPayload(assetId, url.origin, config.resolutions ?? ["1k", "2k", "4k"]))
      }
      if (url.pathname.startsWith("/thumb/")) {
        const assetId = url.pathname.slice("/thumb/".length).replace(/\.png$/, "")
        if (config.thumbnailMissing?.includes(assetId)) return new Response("no thumbnail", { status: 404 })
        return new Response(Buffer.alloc(config.thumbnailBytes ?? 128, 3), { headers: { "content-type": "image/png" } })
      }
      if (url.pathname.startsWith("/cdn/")) {
        if (config.missingCdn?.includes(url.pathname)) return new Response("gone", { status: 404 })
        if (config.slowDiffuse && url.pathname.includes("Diffuse")) return hangingStream()
        if (config.fileDelayMs) await sleep(config.fileDelayMs)
        if (config.overflowBytes) return new Response(Buffer.alloc(config.overflowBytes, 9))
        const chunked = config.chunkedBytes
        if (chunked) {
          const size = Math.ceil(chunked / 3)
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              for (let sent = 0; sent < chunked; sent += size) controller.enqueue(Buffer.alloc(Math.min(size, chunked - sent), 5))
              controller.close()
            },
          }))
        }
        return new Response(Buffer.alloc(FILE_BYTES, 7))
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    calls,
    config,
    reset() { calls.length = 0 },
    count(prefix: string) { return calls.filter((call) => call.startsWith(prefix)).length },
    async stop() { await server.stop(true) },
  }
}

async function withServer<T>(config: FixtureConfig, run: (server: FixtureServer) => Promise<T>): Promise<T> {
  const server = startFixtureServer(config)
  try { return await run(server) } finally { await server.stop() }
}

const tempRoots: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lyapunov-textures-"))
  tempRoots.push(dir)
  return dir
}
afterAll(async () => { for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }) })

/** 取失败的 Error（不吞掉"其实成功了"的情形）。 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  let failure: Error | undefined
  await promise.then(() => {}, (error: unknown) => { failure = error as Error })
  if (!failure) throw new Error("期望调用失败，但它成功了")
  return failure
}

// ---------------------------------------------------------------------------
describe("贴图检索候选与复用（textures.ts）", () => {
  test("旧调用 fetchTextureSet(query, destination) 仍按 1k 下四张约定图并写同名清单", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const set = await fetchTextureSet("oak wood planks", destination, { apiBase: server.base })
      expect(set.assetId).toBe("oak_wood_planks")
      expect(set.resolution).toBe("1k")
      expect(set.reused).toBe(false)
      expect(set.complete).toBe(true)
      expect(set.missingMaps).toEqual([])
      expect(set.license).toBe("CC0-1.0")
      expect(set.authors).toEqual(["Dimitrios Savva"])
      expect(set.source).toBe("https://polyhaven.com/a/oak_wood_planks")
      expect(Object.keys(set.maps).sort()).toEqual(["AO", "Diffuse", "Rough", "nor_gl"])
      for (const map of MAP_NAMES) {
        expect(set.maps[map]).toBe(join(destination, `oak_wood_planks_${map}_1k.jpg`))
        expect((await stat(set.maps[map]!)).size).toBe(FILE_BYTES)
      }
      expect(set.totalBytes).toBe(FILE_BYTES * 4)
      // 清单文件名与 world.py 需要的键保持不变（assetId / license / maps）。
      const manifest = JSON.parse(await readFile(join(destination, "oak_wood_planks.manifest.json"), "utf8")) as Record<string, unknown>
      expect(manifest.assetId).toBe("oak_wood_planks")
      expect(manifest.license).toBe("CC0-1.0")
      expect(Object.keys(manifest.maps as object).sort()).toEqual(["AO", "Diffuse", "Rough", "nor_gl"])
      // 默认不下载预览图：老调用的网络行为不变。
      expect(server.count("/thumb/")).toBe(0)
    })
  })

  test("findTexture 兼容签名仍返回第一名可下载候选", async () => {
    await withServer({}, async (server) => {
      const found = await findTexture("oak wood planks", { apiBase: server.base })
      expect(found).toEqual({ assetId: "oak_wood_planks", name: "Oak Wood Planks", authors: ["Dimitrios Savva"] })
      expect(await findTexture("zzzz nothing", { apiBase: server.base })).toBeUndefined()
    })
  })

  test("中文常见材料词走本地可解释映射（最长匹配，不调第二个 LLM）", () => {
    expect(explainTextureQuery("浅色灰泥墙")).toEqual({
      original: "浅色灰泥墙",
      terms: ["light", "plaster", "wall"],
      mapped: [{ zh: "浅色", en: ["light"] }, { zh: "灰泥", en: ["plaster"] }, { zh: "墙", en: ["wall"] }],
      unmapped: [],
    })
    expect(explainTextureQuery("红砖 wall")).toEqual({
      original: "红砖 wall",
      terms: ["brick", "red", "wall"],
      mapped: [{ zh: "红砖", en: ["brick", "red"] }],
      unmapped: [],
    })
    expect(explainTextureQuery("oak_wood_planks").terms).toEqual(["oak", "wood", "planks"])
    expect(explainTextureQuery("紫水晶洞").terms).toEqual([])
    expect(explainTextureQuery("紫水晶洞").unmapped).toEqual(["紫", "水", "晶", "洞"])
  })

  test("中文 query 真能选到素材，且映射结果记在清单里", async () => {
    await withServer({}, async (server) => {
      const set = await fetchTextureSet("红砖墙", await tempDir(), { apiBase: server.base })
      expect(set.assetId).toBe("red_bricks_04")
      expect(set.query?.mapped).toEqual([{ zh: "红砖", en: ["brick", "red"] }, { zh: "墙", en: ["wall"] }])
      expect(set.selected).toEqual({ assetId: "red_bricks_04", reason: "highest-score", matchedTerms: ["brick", "red", "wall"], score: 3 })
      expect(server.count("/files/red_bricks_04")).toBe(1)
    })
  })

  test("未收录的中文明确要求原生 Agent 翻译：不发请求、不假成功", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const error = await rejection(fetchTextureSet("紫水晶洞", destination, { apiBase: server.base }))
      expect(error.message).toContain("POLYHAVEN_QUERY_UNTRANSLATED")
      expect(error.message).toContain("原生 Agent")
      expect(error.message).toContain("紫、水、晶、洞")
      expect(server.calls).toEqual([])
      expect(existsSync(join(destination, "紫水晶洞.manifest.json"))).toBe(false)
    })
  })

  test("候选列表按真实 metadata 给出，且不止第一名（可用 assetId 换）", async () => {
    await withServer({}, async (server) => {
      const candidates = await findTextures("灰泥墙", { apiBase: server.base })
      // 命中 plaster＋wall 的两套排前面；只命中 wall 的紧随其后（真实打分，不是"只留第一名"）。
      // 同分同名称命中时按官方 download_count 排（grey_plaster 125495 > brick_wall_04 37108）。
      expect(candidates.map((candidate) => candidate.assetId)).toEqual(["grey_plaster", "brick_wall_04", "red_bricks_04", "granite_tile_03", "stone_tiles"])
      const plaster = candidates[0]!
      expect(plaster.name).toBe("Grey Plaster")
      expect(plaster.authors).toEqual(["Rob Tuytel"])
      expect(plaster.categories).toEqual(["plaster", "outdoor", "indoor", "man made", "wall", "floor", "plaster-concrete"])
      expect(plaster.tags).toEqual(["moss", "plain", "bare"])
      expect(plaster.maxResolution).toEqual([8192, 8192])
      expect(plaster.dimensions).toEqual([1000, 1000])
      expect(plaster.downloadCount).toBe(125495)
      expect(plaster.publishedAt).toBe("2018-06-18T22:00:00.000Z")
      expect(plaster.category).toBe("Concrete/Plaster & Stucco/Bare Plaster")
      expect(plaster.description).toContain("grey plaster")
      expect(plaster.source).toBe("https://polyhaven.com/a/grey_plaster")
      expect(plaster.thumbnailUrl).toBe(REAL_CATALOG.grey_plaster!.thumbnail_url as string)
      expect(plaster.matchedTerms).toEqual(["plaster", "wall"])
      expect(plaster.prepaid).toBe(false)
      // 下载时的第一名与候选清单都写进结果：不会只按第一名悄悄下载。
      const destination = await tempDir()
      const set = await fetchTextureSet("灰泥墙", destination, { apiBase: server.base })
      expect(set.selected).toEqual({ assetId: "grey_plaster", reason: "highest-score", matchedTerms: ["plaster", "wall"], score: 2 })
      expect(set.candidates.map((candidate) => candidate.assetId)).toEqual(["grey_plaster", "brick_wall_04", "red_bricks_04", "granite_tile_03", "stone_tiles"])
      expect(server.calls.filter((call) => call.startsWith("/files/"))).toEqual(["/files/grey_plaster"])
      // 明示换用候选里的另一套
      const chosen = await fetchTextureSet(undefined, await tempDir(), { assetId: "brick_wall_04", apiBase: server.base })
      expect(chosen.assetId).toBe("brick_wall_04")
      expect(chosen.selected).toEqual({ assetId: "brick_wall_04", reason: "explicit", matchedTerms: [], score: 0 })
      expect(chosen.source).toBe("https://polyhaven.com/a/brick_wall_04")
    })
  })

  test("明确 assetId：跳过关键词打分；未知 id 明确报错", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const set = await fetchTextureSet("", destination, { assetId: "granite_tile_03", apiBase: server.base })
      expect(set.assetId).toBe("granite_tile_03")
      expect(set.maps.Diffuse).toBe(join(destination, "granite_tile_03_Diffuse_1k.jpg"))
      expect(server.calls.filter((call) => call.startsWith("/files/"))).toEqual(["/files/granite_tile_03"])
      const error = await rejection(fetchTextureSet("", await tempDir(), { assetId: "no_such_asset", apiBase: server.base }))
      expect(error.message).toContain("POLYHAVEN_UNKNOWN_ASSET")
      expect(error.message).toContain("no_such_asset")
    })
  })

  test("prepaid 素材只进候选列表、不下载；显式指定则拒绝", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const set = await fetchTextureSet("stone tiles", destination, { apiBase: server.base })
      expect(set.assetId).toBe("granite_tile_03")
      expect(set.candidates.map((candidate) => candidate.assetId).slice(0, 2)).toEqual(["granite_tile_03", "stone_tiles"])
      const paid = set.candidates.find((candidate) => candidate.assetId === "stone_tiles")!
      expect(paid.prepaid).toBe(true)
      expect(paid.license).toBe("unknown")
      expect(server.calls.some((call) => call.includes("stone_tiles"))).toBe(false)
      const error = await rejection(fetchTextureSet(undefined, await tempDir(), { assetId: "stone_tiles", apiBase: server.base }))
      expect(error.message).toContain("POLYHAVEN_PREPAID_ASSET")
    })
  })

  test("只有付费素材匹配时明确报 ONLY_PREPAID，不静默失败", async () => {
    await withServer({}, async (server) => {
      // 这两个词只在 stone_tiles 上命中（prepaid）
      const error = await rejection(fetchTextureSet("shiny reflective", await tempDir(), { apiBase: server.base }))
      expect(error.message).toContain("POLYHAVEN_ONLY_PREPAID_MATCHES")
      expect(error.message).toContain("stone_tiles")
    })
  })

  test("分辨率：按 2k/4k 档下载；接口没有该档时报错并列出真实档位", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const set = await fetchTextureSet("granite tile", destination, { apiBase: server.base, resolution: "2k" })
      expect(set.resolution).toBe("2k")
      expect(set.maps.Diffuse).toBe(join(destination, "granite_tile_03_Diffuse_2k.jpg"))
      expect(Object.values(set.maps).every((path) => path.endsWith("_2k.jpg"))).toBe(true)
      const fourK = await fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, resolution: "4k", reuse: false })
      expect(Object.values(fourK.maps).every((path) => path.endsWith("_4k.jpg"))).toBe(true)
    })
    await withServer({ resolutions: ["1k", "2k"] }, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, resolution: "4k" }))
      expect(error.message).toContain("POLYHAVEN_RESOLUTION_UNAVAILABLE")
      expect(error.message).toContain("档位是 1k/2k")
    })
    // 官方 metadata 说最高 2048px（此处为该分支显式改写，其他字段未动）：不再白跑一次 /files。
    const capped = JSON.parse(JSON.stringify(REAL_CATALOG)) as Record<string, Record<string, unknown>>
    capped.granite_tile_03!.max_resolution = [2048, 2048]
    await withServer({ catalog: capped }, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, resolution: "4k" }))
      expect(error.message).toContain("官方最高 2048px")
      expect(server.calls.filter((call) => call.startsWith("/files/"))).toEqual([])
    })
  })

  test("取消：调用前已取消、列表阶段取消、下载中取消都不留半套清单", async () => {
    await withServer({}, async (server) => {
      const controller = new AbortController()
      controller.abort()
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, signal: controller.signal }))
      expect(error.name).toBe("AbortError")
      expect(error.message).toContain("POLYHAVEN_ABORTED")
      expect(server.calls).toEqual([])
    })
    await withServer({ catalogDelayMs: 2000 }, async (server) => {
      const controller = new AbortController()
      const pending = fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, signal: controller.signal })
      await sleep(30)
      controller.abort()
      const error = await rejection(pending)
      expect(error.name).toBe("AbortError")
      expect(error.message).toContain("POLYHAVEN_ABORTED")
      expect(server.calls.filter((call) => call.startsWith("/files/"))).toEqual([])
    })
    await withServer({ slowDiffuse: true }, async (server) => {
      const destination = await tempDir()
      const controller = new AbortController()
      const pending = fetchTextureSet("granite tile", destination, { apiBase: server.base, signal: controller.signal })
      await sleep(60)
      controller.abort()
      const error = await rejection(pending)
      expect(error.name).toBe("AbortError")
      expect(existsSync(join(destination, "granite_tile_03.manifest.json"))).toBe(false)
    })
  })

  test("复用：第二次不联网；缺图如实记；分辨率不同不复用；reuse:false 强制重下", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const first = await fetchTextureSet("木板", destination, { apiBase: server.base })
      // 两套都命中 wood＋planks 且名称都命中：取官方 download_count 高的 wood_planks（134592）。
      expect(first.assetId).toBe("wood_planks")
      expect(first.complete).toBe(true)
      server.reset()
      const second = await fetchTextureSet("木板", destination, { apiBase: server.base })
      expect(second.reused).toBe(true)
      expect(second.selected.reason).toBe("local-manifest")
      expect(second.maps).toEqual(first.maps)
      expect(second.totalBytes).toBe(first.totalBytes)
      expect(server.calls).toEqual([])
      // 明确 assetId 时同样先看本地清单
      const explicit = await fetchTextureSet(undefined, destination, { assetId: "wood_planks", apiBase: server.base })
      expect(explicit.reused).toBe(true)
      expect(server.calls).toEqual([])
      // 缺一张图：如实记进 missingMaps/mapErrors，不冒充完整 PBR，也不因为没联网而失败
      await unlink(second.maps.Rough!)
      const third = await fetchTextureSet("木板", destination, { apiBase: server.base })
      expect(third.reused).toBe(true)
      expect(third.complete).toBe(false)
      expect(third.missingMaps).toEqual(["Rough"])
      expect(Object.keys(third.maps).sort()).toEqual(["AO", "Diffuse", "nor_gl"])
      expect(third.mapErrors).toEqual({})
      expect(server.calls).toEqual([])
      // 分辨率不同：不复用，按 2k 重新下载（清单里记的是 1k）
      const other = await fetchTextureSet("木板", destination, { apiBase: server.base, resolution: "2k" })
      expect(other.reused).toBe(false)
      expect(other.resolution).toBe("2k")
      expect(server.count("/files/wood_planks")).toBe(1)
      // reuse:false：跳过本地清单重新下载
      server.reset()
      const refreshed = await fetchTextureSet("木板", destination, { apiBase: server.base, reuse: false, resolution: "2k" })
      expect(refreshed.reused).toBe(false)
      expect(server.count("/files/wood_planks")).toBe(1)
    })
  })

  test("复用要求清单与文件都有效：坏清单或颜色图不在都不复用", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const first = await fetchTextureSet("granite tile", destination, { apiBase: server.base })
      server.reset()
      // 颜色图不在了：这套不算可复用，重新下载补齐
      await unlink(first.maps.Diffuse!)
      const second = await fetchTextureSet("granite tile", destination, { apiBase: server.base })
      expect(second.reused).toBe(false)
      expect(second.complete).toBe(true)
      // 清单写坏了：同样不复用
      await writeFile(join(destination, "granite_tile_03.manifest.json"), "{ not json")
      server.reset()
      const third = await fetchTextureSet("granite tile", destination, { apiBase: server.base })
      expect(third.reused).toBe(false)
      expect(server.count("/files/granite_tile_03")).toBe(1)
    })
  })

  test("按 query 复用看清单记下的检索词：词只命中 tags/分类时也不白重下", async () => {
    await withServer({}, async (server) => {
      const destination = await tempDir()
      // "stone" 只在 granite_tile_03 的 tags（"stone tile"）里，名称/id 里没有：
      // 只看 id/名称会把它当成"不匹配"而重下一遍。
      const first = await fetchTextureSet("stone tiles", destination, { apiBase: server.base })
      expect(first.assetId).toBe("granite_tile_03")
      expect(first.query?.terms).toEqual(["stone", "tiles"])
      server.reset()
      const second = await fetchTextureSet("stone tiles", destination, { apiBase: server.base })
      expect(second.reused).toBe(true)
      expect(second.assetId).toBe("granite_tile_03")
      expect(server.calls).toEqual([])
      // 检索词不同就不复用（词重叠也不行，宁可重查一次也不给错的一套）
      const other = await fetchTextureSet("granite tiles", destination, { apiBase: server.base })
      expect(other.reused).toBe(false)
      expect(server.count("/assets")).toBe(1)
    })
  })

  test("缺单张图不冒充完整 PBR：missingMaps/mapErrors/complete 反映真实情况", async () => {
    await withServer({ missingCdn: ["/cdn/granite_tile_03/AO_1k.jpg"] }, async (server) => {
      const destination = await tempDir()
      const set = await fetchTextureSet("granite tile", destination, { apiBase: server.base })
      expect(set.complete).toBe(false)
      expect(set.missingMaps).toEqual(["AO"])
      expect(set.mapErrors.AO).toContain("POLYHAVEN_HTTP_404")
      expect(Object.keys(set.maps).sort()).toEqual(["Diffuse", "Rough", "nor_gl"])
      expect(set.totalBytes).toBe(FILE_BYTES * 3)
      const manifest = JSON.parse(await readFile(join(destination, "granite_tile_03.manifest.json"), "utf8")) as { complete: boolean; missingMaps: string[] }
      expect(manifest.complete).toBe(false)
      expect(manifest.missingMaps).toEqual(["AO"])
    })
  })

  test("没有匹配时不假成功：findTextures 空列表，fetchTextureSet 报 NO_MATCH", async () => {
    await withServer({}, async (server) => {
      expect(await findTextures("zzzz nothing", { apiBase: server.base })).toEqual([])
      const error = await rejection(fetchTextureSet("zzzz nothing", await tempDir(), { apiBase: server.base }))
      expect(error.message).toContain("POLYHAVEN_NO_MATCH")
    })
  })

  test("体积上限：单文件超限、分块流超限、累计超限都明确失败且不写清单", async () => {
    await withServer({ overflowBytes: 4096 }, async (server) => {
      const destination = await tempDir()
      const error = await rejection(fetchTextureSet("granite tile", destination, { apiBase: server.base, maxFileBytes: 1024 }))
      expect(error.message).toContain("POLYHAVEN_FILE_TOO_LARGE")
      expect(existsSync(join(destination, "granite_tile_03.manifest.json"))).toBe(false)
    })
    await withServer({ chunkedBytes: 4096 }, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, maxFileBytes: 1024 }))
      expect(error.message).toContain("POLYHAVEN_FILE_TOO_LARGE")
    })
    await withServer({}, async (server) => {
      const destination = await tempDir()
      const error = await rejection(fetchTextureSet("granite tile", destination, { apiBase: server.base, maxSetBytes: FILE_BYTES + 100 }))
      expect(error.message).toContain("POLYHAVEN_SET_TOO_LARGE")
      expect(existsSync(join(destination, "granite_tile_03.manifest.json"))).toBe(false)
    })
  })

  test("网络超时：列表与单图都按 POLYHAVEN_TIMEOUT 上报", async () => {
    await withServer({ catalogDelayMs: 2000 }, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, timeoutMs: 250 }))
      expect(error.message).toContain("POLYHAVEN_TIMEOUT")
    })
    await withServer({ fileDelayMs: 1000 }, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, timeoutMs: 250 }))
      expect(error.message).toContain("POLYHAVEN_TIMEOUT")
    })
  })

  test("选项校验与候选清单完整性：非法档位报错；本次真用到的那套一定在候选里", async () => {
    await withServer({}, async (server) => {
      const error = await rejection(fetchTextureSet("granite tile", await tempDir(), { apiBase: server.base, resolution: "16k" as TextureResolution }))
      expect(error.message).toContain("POLYHAVEN_RESOLUTION_INVALID")
      expect(await findTextures("stone tiles", { apiBase: server.base, limit: 1 })).toHaveLength(1)
      // 打分第一名是付费素材（不下载），本次真正用的是第二名的免费素材：两者都要出现在候选里。
      const set = await fetchTextureSet("tiles stone shiny", await tempDir(), { apiBase: server.base, limit: 1 })
      expect(set.assetId).toBe("granite_tile_03")
      expect(set.candidates.map((candidate) => candidate.assetId)).toEqual(["stone_tiles", "granite_tile_03"])
      expect(set.candidates[0]!.score).toBe(3)
    })
  })

  test("候选预览：thumbnails=true 落盘真实 thumbnail_url，取不到只记 thumbnailError", async () => {
    await withServer({ localThumbnails: true, thumbnailMissing: ["oak_wood_planks"] }, async (server) => {
      const directory = await tempDir()
      const candidates = await findTextures("wood", { apiBase: server.base, thumbnails: true, thumbnailDirectory: directory })
      // 两套都命中 wood 且名称都命中：官方 download_count 高的 wood_planks（134592）排前。
      expect(candidates.map((candidate) => candidate.assetId)).toEqual(["wood_planks", "oak_wood_planks"])
      const planks = candidates[0]!
      expect(planks.thumbnailPath).toBe(join(directory, "wood_planks.thumb.png"))
      expect((await stat(planks.thumbnailPath!)).size).toBe(128)
      expect(planks.name).toBe("Wood Planks")
      const oak = candidates[1]!
      expect(oak.thumbnailPath).toBeUndefined()
      expect(oak.thumbnailError).toContain("POLYHAVEN_HTTP_404")
      expect(oak.name).toBe("Oak Wood Planks")
      server.reset()
      await findTextures("wood", { apiBase: server.base })
      expect(server.count("/thumb/")).toBe(0)
      const error = await rejection(findTextures("wood", { apiBase: server.base, thumbnails: true }))
      expect(error.message).toContain("POLYHAVEN_THUMBNAIL_DIRECTORY_REQUIRED")
    })
  })
})
