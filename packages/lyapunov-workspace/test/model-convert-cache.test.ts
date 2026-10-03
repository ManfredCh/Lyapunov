/**
 * 拖拽转换的**缓存身份**（review1 issue 4）与已登记源资源入口：
 *
 *  · 缓存身份来自"资源版本 + 已核验依赖"，不是"主文件没变"：外部纹理/引用哈希变了，键必须变。
 *  · 依赖无法核验（无 Blender 确认的 .blend、未枚举外部引用的 USD）时 `reusable=false`：本次**不读**
 *    旧缓存（宁可真转一次），不把旧 GLB 静默当成新结果。
 *  · `convertRegisteredSource` 只接受服务端从资源 owner 解析出的路径（`convert-source` 里不读客户端 path）。
 *
 * 这里用真实文件 + 真实产品函数跑；不调用 Blender、不联网（缺子进程能力就明确失败，而不是假成功）。
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { ModelPreviewUnavailable, ModelPreviewUnsupported, convertCacheIdentity, convertRegisteredSource, verifyDependencies } from "../src/model-convert.ts"
import { convertSourceOf, registrableConvertSourceOf } from "../src/model-source.ts"

const read = (relative: string) => readFileSync(join(import.meta.dirname, "..", ...relative.split("/")), "utf8")
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex")
const cachePaths = (cacheRoot: string, key: string) => {
  const directory = join(resolve(cacheRoot), "model-preview")
  return { directory, glb: join(directory, `${keyHash(key)}.glb`), meta: join(directory, `${keyHash(key)}.json`) }
}
/** 造一个真实存在的源工程文件（内容无所谓：身份由调用方给，只有"可转换扩展名 + 是文件"被用到）。 */
async function fixture(extension: string): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "lyapunov-convert-cache-"))
  const source = join(root, `asset${extension}`)
  await writeFile(source, Buffer.from("LYAPUNOV_FIXTURE"))
  return { root, source }
}
async function seedCache(cacheRoot: string, key: string, bytes: Buffer) {
  const paths = cachePaths(cacheRoot, key)
  await mkdir(paths.directory, { recursive: true })
  await writeFile(paths.glb, bytes)
  await writeFile(paths.meta, JSON.stringify({ sha256: keyHash(key), source: "blend", bytes: bytes.length, convertMs: 3 }))
}

describe("转换缓存身份：资源版本 + 已核验依赖", () => {
  test("依赖核验通过 → reusable=true；任一依赖哈希变化都会换键", () => {
    const base = convertCacheIdentity({
      resourceId: "res_src", version: 1, dependenciesVerified: true,
      dependencies: [
        { path: "/m/scene.blend", size: 10, sha256: "main" },
        { path: "/m/tex/checker.png", size: 4, sha256: "tex-a" },
      ],
    })
    expect(base.reusable).toBe(true)
    expect(base.basis).toContain("已核验")
    const same = convertCacheIdentity({
      resourceId: "res_src", version: 1, dependenciesVerified: true,
      dependencies: [
        { path: "/m/tex/checker.png", size: 4, sha256: "tex-a" },
        { path: "/m/scene.blend", size: 10, sha256: "main" },
      ],
    })
    expect(same.key).toBe(base.key) // 依赖顺序不影响身份
    // 只换外部纹理的哈希（主文件一字未改）：键必须变，否则旧 GLB 会被静默当成新结果。
    const changedTexture = convertCacheIdentity({
      resourceId: "res_src", version: 1, dependenciesVerified: true,
      dependencies: [
        { path: "/m/scene.blend", size: 10, sha256: "main" },
        { path: "/m/tex/checker.png", size: 4, sha256: "tex-b" },
      ],
    })
    expect(changedTexture.key).not.toBe(base.key)
  })

  test("依赖无法核验 → reusable=false，并写明不复用旧缓存", () => {
    const unverified = convertCacheIdentity({
      resourceId: "res_src", version: 2, dependenciesVerified: false,
      dependencies: [{ path: "/m/scene.usda", size: 10, sha256: "main" }],
      unverifiedReason: "USD 的外部引用未由资源解析器枚举",
    })
    expect(unverified.reusable).toBe(false)
    expect(unverified.basis).toContain("无法核验")
    expect(unverified.basis).toContain("不复用旧缓存")
  })

  test("依赖核验按当前磁盘字节重算：外部纹理被改动后不再算已核验", async () => {
    const { root } = await fixture(".blend")
    const texture = join(root, "checker.png")
    await writeFile(texture, Buffer.from("TEXTURE_V1"))
    const record = [{ path: texture, size: 10, sha256: createHash("sha256").update(Buffer.from("TEXTURE_V1")).digest("hex") }]
    expect(await verifyDependencies(record)).toEqual({ verified: true })
    // 主文件一字未改、只把外部纹理换掉：登记时的哈希对不上 → 不可核验 → 新拖入必须重转。
    await writeFile(texture, Buffer.from("TEXTURE_V2"))
    const changed = await verifyDependencies(record)
    expect(changed.verified).toBe(false)
    expect(changed.reason).toContain("内容已变")
    // 记录里的文件被删掉同样算不可核验，而不是当成"没有依赖"。
    const vanished = await verifyDependencies([{ path: join(root, "gone.png"), size: 1, sha256: "x" }])
    expect(vanished.verified).toBe(false)
    expect(vanished.reason).toContain("不可读")
  })
})

describe("convertRegisteredSource：可信缓存命中 / 不可核验不复用 / 非源工程拒绝", () => {
  test("reusable=true 且缓存命中 → 直接回缓存，不要求子进程", async () => {
    const { root, source } = await fixture(".blend")
    const cacheRoot = join(root, "cache")
    const identity = convertCacheIdentity({ resourceId: "res_src", version: 1, dependenciesVerified: true, dependencies: [{ path: source, size: 16, sha256: "main" }] })
    const bytes = Buffer.from("CACHED_GLB_BYTES")
    await seedCache(cacheRoot, identity.key, bytes)
    const result = await convertRegisteredSource({ path: source, cacheIdentity: identity }, { cacheRoot })
    expect(result.cached).toBe(true)
    expect(result.cachedPath).toBe(cachePaths(cacheRoot, identity.key).glb)
    expect(result.bytes.equals(bytes)).toBe(true)
    expect(result.cacheBasis).toContain("已核验")
  })

  test("reusable=false 时即便同键已有缓存也不复用（缺子进程就明确失败，不假成功）", async () => {
    const { root, source } = await fixture(".blend")
    const cacheRoot = join(root, "cache")
    const verified = convertCacheIdentity({ resourceId: "res_src", version: 1, dependenciesVerified: true, dependencies: [{ path: source, size: 16, sha256: "main" }] })
    await seedCache(cacheRoot, verified.key, Buffer.from("STALE_GLB_BYTES"))
    const unverified = { key: verified.key, reusable: false, basis: "依赖无法核验：本次不复用旧缓存" }
    await expect(convertRegisteredSource({ path: source, cacheIdentity: unverified }, { cacheRoot })).rejects.toBeInstanceOf(ModelPreviewUnavailable)
  })

  test("不可转换的已登记资源明确拒绝（不冒充 Blender 源工程）", async () => {
    const { root, source } = await fixture(".txt")
    const identity = convertCacheIdentity({ resourceId: "res_txt", version: 1, dependenciesVerified: false, dependencies: [] })
    await expect(convertRegisteredSource({ path: source, cacheIdentity: identity }, { cacheRoot: join(root, "cache") })).rejects.toBeInstanceOf(ModelPreviewUnsupported)
  })
})

describe("拖拽分发只认可登记的格式（issue 3）", () => {
  test(".usdz 只在模型预览的转换器能力里，不进拖拽可登记表", () => {
    // 模型预览把 zip 字节直接交给 Blender（不经过资源登记），所以转换器认它。
    expect(convertSourceOf("/m/model.usdz")).toBe("usd")
    // 拖拽要先 scene_import（parseAsset）登记原件：.usdz 不被接受，因此不能列为已支持。
    expect(registrableConvertSourceOf("/m/model.usdz")).toBeUndefined()
    expect(registrableConvertSourceOf("/m/model.usda")).toBe("usd")
    expect(registrableConvertSourceOf("/m/model.usdc")).toBe("usd")
    expect(registrableConvertSourceOf("/m/model.blend")).toBe("blend")
  })
})

describe("convert-source 接线：只消费本会话已登记资源，不再接受客户端路径/边界开关", () => {
  const plugin = read("src/plugin.ts")
  const modelConvert = read("src/model-convert.ts")
  test("convert-source 读 resourceId/version 并从 scene service 解析记录；不读 input.path", () => {
    expect(plugin).toContain('if(action==="convert-source")')
    expect(plugin).toContain("CONVERT_SOURCE_RESOURCE_REQUIRED")
    expect(plugin).toContain("resources.get(resourceId,version)")
    expect(plugin).toContain("convertRegisteredSource({path:sourcePath,cacheIdentity,")
    expect(plugin).toContain("assetRemap")
    // 转换前按当前磁盘字节复核依赖，不靠"主文件没变"推断外部纹理/引用没变。
    expect(plugin).toContain("verifyDependencies(dependencies)")
    // 服务端复用 scene_import 的同一 operation 登记派生 GLB。
    expect(plugin).toContain("sceneFor(sessionKey).import({path:result.cachedPath")
    // 会写资源库的入口在 read-only 会话里按同一个策略拒绝（与 scene_import 同类）。
    expect(plugin).toContain("SCENE_POLICY_READ_ONLY")
    expect(plugin).not.toContain("allowUserSelectedPath")
  })
  test("模型预览仍走工作区边界入口；删除旧的客户端选择旁路函数", () => {
    expect(modelConvert).toContain("convertToGlb")
    expect(modelConvert).not.toContain("allowUserSelectedPath")
    expect(modelConvert).not.toContain("resolveUserSelectedModelPath")
  })
})
