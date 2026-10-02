/**
 * 六个「仍在产品里使用」的客户端符号的**恢复用例**（download 侧模型面）。
 *
 * 2026-09-26 恢复自 `ebe6669^` 下两个随服务端一起被删的 pack 测试：
 *  · `packages/policy-registry/test/model-download-face.test.ts`（221 行 / 13 用例）
 *  · `packages/policy-registry/test/pack-policy-source.test.ts`（171 行 / 5 用例）
 * 删除动机（import 服务端 `services/pack-endpoint/**`）对**它们的服务端那半**成立；
 * 但删完之后这 6 个符号在**产品里仍在用**、`surviving_tests=0`：
 *   `adapterDownloadFiles` / `resolveModelFace` / `createModelRoutes` /
 *   `packModelFace` / `readPolicyCache` / `weightsFetchPlan`
 * 本文件把其中**只依赖客户端模块**的那部分**逐字**取回（断言一个字没改），逐段标注出处行号。
 *
 * 逐条账（13 + 5 = 18 条原用例）：
 *   **取回 9 条整 + 1 条的一半**；**未取回 8 条整 + 1 条的一半**。
 * **未取回的部分（如实登记，不用替身顶替）** —— 全部只因需要真服务端能力包端点
 * `createPackEndpoint`（`services/pack-endpoint/src/server.ts`，已随 `ebe6669` 移出本仓）：
 *  · `describe('真实内容根：五个 VLA 包与三个基础策略包的模型面')` 里的 3 条
 *    （原 `:89`、`:110`、`:143`：G0.5 四件清单/π0.5 家族 ModelScope 镜像/逐包下载入口）
 *  · `policyModels.list` 的 OK / 缓存 / STALE 那半（原 `:174-214`；UNREACHABLE 那半已取回）
 *  · `pack-policy-source.test.ts` 其余 4 条（`downloadPack` 两末端、`preparePolicy` 取件提示等）
 *  ⇒ 本文件只恢复 `createModelRoutes` 的 **UNREACHABLE** 分支（注入 fetcher，客户端自足）。
 *
 * 运行：`bun test packages/policy-registry/test/pack-client-face.test.ts`
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adapterDownloadFiles, IMPLEMENTED_POLICY_ADAPTERS, inspectPack, resolveModelFace, type PackWeights } from '../src/pack-contract.ts'
import { policyDirectory, readPolicyCache, policyFileSelector, selectSourceFiles } from '../src/source.ts'
import { createModelRoutes } from '../src/model-routes.ts'
import { MODEL_FACE_UNDECLARED, packModelFace } from '../src/model-face.ts'
import { weightsFetchPlan } from '../src/adapter.ts'

/** 真实内容根：`packs/`（不是测试自造 fixture）。 */
const CONTENT_ROOT = join(import.meta.dir, '..', '..', '..', 'packs')
const BASE_POLICY_PACKS = ['unitree_go2', 'unitree_g1', 'unitree_go1'] as const   // 逐字取自 model-download-face.test.ts:27
const emptyDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const weights = (over: Partial<PackWeights> = {}): PackWeights => ({
  bundled: false, file: null, bytes: null, sha256: null, availability: 'resolvable',
  pin: 'inria-paris-robotics-lab/go2_onnx_controller@c1729e1a4aa2e7e1091ccff42be68d42bd054764',
  resolution: { provider: 'github', modelId: 'inria-paris-robotics-lab/go2_onnx_controller', revision: 'c1729e1a4aa2e7e1091ccff42be68d42bd054764' },
  ...over,
})   // 逐字取自 model-download-face.test.ts:30-35

/**
 * 从文本里把 `policy_download({…})` 的**参数**解出来（不是断言字符串里出现过 policy_download）：
 * 拿到的 provider/modelId/revision/files 直接喂给真实的选择器，去真实清单上选一遍。
 */
function parseDownloadCommand(text: string) {
  const body = text.match(/policy_download\(\{([^}]*)\}\)/)
  if (!body) throw new Error("文本里没有可执行的 policy_download({…}) 命令：" + text.slice(0, 200))
  const field = (name: string) => body[1]!.match(new RegExp(`${name}:"([^"]+)"`))?.[1]
  const files = body[1]!.match(/files:\[([^\]]*)\]/)?.[1]
  if (!field("provider") || !field("modelId") || !field("revision") || files === undefined) throw new Error("policy_download 参数不完整：" + body[1])
  return { provider: field("provider")!, modelId: field("modelId")!, revision: field("revision")!, files: JSON.parse(`[${files}]`) as string[] }
}
/** 权威来源清单的**本地等价形状**：适配器登记的全部必需件 + 该来源真实存在的无关件（README/config/目录下 mesh）。 */
function sourceListingOf(entry: (typeof IMPLEMENTED_POLICY_ADAPTERS)[number]) {
  return [
    ...entry.requires.files.map((path) => ({ path, bytes: 1, revision: entry.revision, url: `https://example.invalid/${path}` })),
    ...(entry.requires.prefixes ?? []).flatMap((prefix) => [`${prefix}/pelvis.STL`, `${prefix}/torso.STL`].map((path) => ({ path, bytes: 1, revision: entry.revision, url: `https://example.invalid/${path}` }))),
    { path: "README.md", bytes: 1, revision: entry.revision, url: "https://example.invalid/README.md" },
    { path: "config.json", bytes: 1, revision: entry.revision, url: "https://example.invalid/config.json" },
  ]
}

/** 逐字取自 `ebe6669^:packages/policy-registry/test/model-download-face.test.ts:37-86`（原 `describe` 整段）。 */
describe('模型面判据：只读声明，声明不全如实派生', () => {
  test('来源协议已实现 + 文件清单齐备 ⇒ 可取件', () => {
    const face = resolveModelFace({ weights: weights({ download: { files: ['onnx_inference/data/model.onnx'], bytes: 8_000_000, blocked: null, requiresAuth: null } }), adapter: 'onnx' })!
    expect(face.status).toBe('fetchable')
    expect(face.downloadable).toBe(true)
    expect(face.code).toBeNull()
    expect(face.bytes).toBe(8_000_000)
    expect(face.provenance).toContain('inria-paris-robotics-lab/go2_onnx_controller')
  })
  test('内容侧声明的门禁优先于任何派生判断（原样透传，不当成"没声明"）', () => {
    const face = resolveModelFace({ weights: weights({ availability: 'unavailable', download: { files: [], bytes: null, blocked: { code: 'MODEL_LICENSE_NONCOMMERCIAL', detail: '内容侧声明：非商用许可，产品化托管推理构成 Commercial Use' }, requiresAuth: null } }) })!
    expect(face.status).toBe('blocked')
    expect(face.downloadable).toBe(false)
    expect(face.code).toBe('MODEL_LICENSE_NONCOMMERCIAL')
    expect(face.detail).toContain('非商用')
  })
  test('取件前提（requiresAuth）是**非阻断**事实：说"点之前要知道什么"，不说"取不到"', () => {
    const face = resolveModelFace({ weights: weights({ download: { files: ['a/b.pt'], bytes: 8, blocked: null, requiresAuth: 'huggingface-token' } }) })!
    expect(face.status).toBe('fetchable')
    expect(face.downloadable).toBe(true)
    expect(face.code).toBeNull()
    expect(face.requiresAuth).toBe('huggingface-token')
    // 反面：没有前提时不得凭空给出一条（面板据此提示，编一条就是把事实说反）。
    expect(resolveModelFace({ weights: weights({ download: { files: ['a/b.pt'], bytes: 8, blocked: null, requiresAuth: null } }) })!.requiresAuth).toBeNull()
  })
  test('来源协议不在已实现取件来源内（gs://）⇒ 派生 MODEL_SOURCE_UNDECLARED，不编造 URL', () => {
    const face = resolveModelFace({ weights: weights({ resolution: { provider: 'gs', modelId: 'openpi-assets/checkpoints/pi05_aloha', revision: 'gs://openpi-assets/checkpoints/pi05_aloha' } }) })!
    expect(face.code).toBe('MODEL_SOURCE_UNDECLARED')
    expect(face.downloadable).toBe(false)
    expect(JSON.stringify(face)).not.toContain('http')
  })
  test('有来源但没有任何文件清单 ⇒ MODEL_FILES_UNDECLARED（客户端不虚构路径）', () => {
    expect(resolveModelFace({ weights: weights() })!.code).toBe('MODEL_FILES_UNDECLARED')
  })
  test('代码侧清单回落：内容侧没写 weights.download，也用已登记适配器的 requires', () => {
    const implemented = IMPLEMENTED_POLICY_ADAPTERS.find(entry => entry.packs.includes('unitree_go2'))!
    const face = resolveModelFace({ weights: weights(), adapter: 'onnx', files: adapterDownloadFiles(implemented) })!
    expect(face.status).toBe('fetchable')
    expect(face.files).toEqual(adapterDownloadFiles(implemented))
    expect(face.files).toContain('onnx_inference/data/model.onnx')
  })
  test('形状收束：端点没给/给了不认识的东西 ⇒ null，绝不按包名猜来源', () => {
    expect(packModelFace(undefined)).toBeNull()
    expect(packModelFace({ status: 'whatever' })).toBeNull()
    const face = packModelFace({ status: 'blocked', code: 'X', files: ['a', 1], bytes: -1 })!
    expect(face.files).toEqual(['a'])
    expect(face.bytes).toBeNull()
    expect(MODEL_FACE_UNDECLARED.code).toBe('MODEL_FACE_UNDECLARED')
  })
})

describe('真实内容根：三个基础策略包的模型面（逐字取自 model-download-face.test.ts:133-142）', () => {
  test('基础策略包的模型面可取件，文件清单与代码侧适配器台账逐项相同', async () => {
    for (const packId of BASE_POLICY_PACKS) {
      const contract = await inspectPack(join(CONTENT_ROOT, packId))
      if (contract.route.kind !== 'policy-source') throw new Error(`${packId} route 不是 policy-source`)
      const implemented = IMPLEMENTED_POLICY_ADAPTERS.find(entry => entry.packs.includes(packId))!
      expect(contract.route.model!.status).toBe('fetchable')
      expect(contract.route.model!.files).toEqual(adapterDownloadFiles(implemented))
      expect(contract.route.model!.source).toEqual(contract.route.source)
    }
  })
})

describe('本机缓存事实（逐字取自 model-download-face.test.ts:158-172）', () => {
  test('readPolicyCache：未下载过 ⇒ NOT_DOWNLOADED；有 manifest ⇒ 只读 status/files/bytes（不重算哈希）', async () => {
    const data = emptyDir('policy-cache-')
    const empty = await readPolicyCache(data, 'github', 'inria-paris-robotics-lab/go2_onnx_controller', 'c1729e1a4aa2e7e1091ccff42be68d42bd054764')
    expect(empty.status).toBe('NOT_DOWNLOADED')
    expect(empty.files).toBe(0)
    const root = policyDirectory(data, 'github', 'inria-paris-robotics-lab/go2_onnx_controller', 'c1729e1a4aa2e7e1091ccff42be68d42bd054764')
    mkdirSync(root, { recursive: true })
    // manifest 里写一份**假**的字节数：本函数不碰磁盘外的任何文件，读到什么就是什么（不假装核过哈希）。
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ status: 'DOWNLOADED', resolvedRevision: 'c1729e1a4aa2e7e1091ccff42be68d42bd054764', files: [{ bytes: 5 }, { bytes: 7 }], updatedAt: '2026-09-23T00:00:00.000Z' }))
    const cached = await readPolicyCache(data, 'github', 'inria-paris-robotics-lab/go2_onnx_controller', 'c1729e1a4aa2e7e1091ccff42be68d42bd054764')
    expect(cached.status).toBe('DOWNLOADED')
    expect(cached.files).toBe(2)
    expect(cached.bytes).toBe(12)
    expect(cached.updatedAt).toBe('2026-09-23T00:00:00.000Z')
  })
})

describe('policyModels 路由的失败面（取自 model-download-face.test.ts:215-219；OK/STALE 那半需已移出的服务端端点，未恢复）', () => {
  test('端点不可达且无快照 ⇒ UNREACHABLE（不是"没有模型"）', async () => {
    const data = emptyDir('pack-client-face-')
        const down = createModelRoutes({ dataDirectory: data, packEndpoint: 'http://127.0.0.1:9474/packs/v1', fetcher: (async () => { throw new Error('ECONNREFUSED') }) as never })
        const unreachable = await down.list(AbortSignal.timeout(30_000))
        expect(unreachable.status).toBe('UNREACHABLE')
        expect(unreachable.routes).toEqual([])
        expect(unreachable.code).toBe('PACK_DISCOVERY_UNREACHABLE')
  })
})

describe('取件计划（逐字取自 pack-policy-source.test.ts:140-154）', () => {
  test("三个登记适配器的取件参数都覆盖必需件（含 G1 的 XML 声明式 mesh 目录前缀）", () => {
    for (const entry of IMPLEMENTED_POLICY_ADAPTERS) {
      // 必需件本身必须是合法选择项（路径校验走产品同一条 policyFileSelector）。
      for (const path of entry.requires.files) expect(policyFileSelector(path)).toEqual({ prefix: false, path })
      for (const prefix of entry.requires.prefixes ?? []) expect(policyFileSelector(prefix + "/")).toEqual({ prefix: true, path: prefix })
      const plan = weightsFetchPlan({ provider: "github", modelId: entry.modelId, revision: entry.revision }, entry.id)
      expect(parseDownloadCommand(plan.command).files).toEqual(adapterDownloadFiles(entry))
      const listing = sourceListingOf(entry)
      const selected = selectSourceFiles(listing, parseDownloadCommand(plan.command).files).map((file) => file.path)
      for (const path of entry.requires.files) expect(selected).toContain(path)
      for (const prefix of entry.requires.prefixes ?? []) expect(selected).toContain(prefix + "/pelvis.STL")
      // 取件命令只取该适配器的件：清单里的无关件不会被顺手取来。
      expect(selected).not.toContain("README.md")
    }
  })
})
