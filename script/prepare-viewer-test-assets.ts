#!/usr/bin/env bun
/**
 * prepare-viewer-test-assets.ts —— 准备 Viewer 两条离线回归要用的真实 Go1 测试依赖。
 *
 * 为什么要有它：`packages/viewer/test/robot-glb-mesh.test.ts:62` 与
 * `packages/viewer/test/robot-glb-ktx2-texture.test.ts:74` 读
 * `materials/robots/unitree_go1/menagerie/go1.xml`（及其 `assets/*.stl`），而
 * `.gitignore` 明确忽略 `materials/robots/unitree_go1/` ⇒ **干净 checkout 里没有这些字节**。
 * 本脚本在行为测试之前把这些**测试依赖**取到磁盘，缓存命中就复用，命中不了才下载。
 *
 * 纪律（与合同一致）：
 *  · **固定版本**：来源写死在 `script/prepare-viewer-test-assets.manifest.json`（repo + commit + 逐文件 size/sha256）。
 *  · **只取这 6 件 + LICENSE**：不拉整个模型仓库、不复制额外 URDF/重复 meshes、不下载策略权重。
 *  · **校验后原子落盘**：先写同目录临时文件、核对 size/sha256 通过后再 rename；半截文件不会留成"已就绪"。
 *  · **缓存复用**：目标文件已存在且 size/sha256 都对 ⇒ 直接复用、不重新下载。
 *  · **不覆盖坏件**：已存在但与固定版本不符 ⇒ 明确报错并非 0 退出，绝不覆盖（那可能是用户自己的模型）。
 *  · **不静默改 source/revision**：失败就点名对象退出，不换 URL、不换 commit 兜底。
 *  · **不发凭据**：对 raw.githubusercontent.com 的请求不带任何 Authorization/GitHub token（公开内容不需要凭据）。
 *  · 模型字节继续不入 Git、不进软件发行包；本脚本只准备测试依赖。
 *
 * 用法：
 *   bun --no-env-file script/prepare-viewer-test-assets.ts                    # 默认落到仓库根
 *   bun --no-env-file script/prepare-viewer-test-assets.ts --root <目录>      # 落到指定目录（验收/冷缓存用）
 *   bun --no-env-file script/prepare-viewer-test-assets.ts --root <目录> --cache-root <已备夹具的项目根>
 *   bun --no-env-file script/prepare-viewer-test-assets.ts --help
 *
 * 目标布局：`<root>/materials/robots/unitree_go1/<manifest.files[].destinationPath>` + `<root>/materials/robots/unitree_go1/LICENSE`。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const MANIFEST_PATH = join(SCRIPT_DIR, "prepare-viewer-test-assets.manifest.json")
/** raw 内容端点；这里**只**拼公开仓库 + 固定 commit + 固定路径，不带任何凭据。 */
const RAW_BASE = "https://raw.githubusercontent.com"
/** 单次取件上限：公开 raw 端点在正常网络下远小于此；超时即失败，不无限等。 */
const DOWNLOAD_TIMEOUT_MS = 120_000

interface AssetSpec {
  /** 上游 `unitree_go1/` 下的相对路径（source）。 */
  sourcePath: string
  /** 本仓落点 `materials/robots/unitree_go1/` 下的相对路径。 */
  destinationPath: string
  bytes: number
  sha256: string
}

interface LicenseSpec extends AssetSpec {
  spdx: string
  copyright: string
}

interface PrepareManifest {
  schema: number
  note: string
  repository: string
  commit: string
  upstreamPath: string
  destination: string
  license: LicenseSpec
  files: AssetSpec[]
}

function fail(lines: string[]): never {
  process.stderr.write(`PREPARE_VIEWER_TEST_ASSETS_FAILED: ${lines.join("\nPREPARE_VIEWER_TEST_ASSETS_FAILED: ")}\n`)
  process.exit(1)
}

const USAGE = [
  "用法：bun --no-env-file script/prepare-viewer-test-assets.ts [--root <目录>] [--cache-root <目录>]",
  "  --root <目录>   目标根（默认仓库根）；文件落到 <目录>/materials/robots/unitree_go1/。",
  "  --cache-root <目录>  显式离线来源根；只读取同一固定清单，缺件或坏件即失败，不转网络。",
  "  --help          打印本说明。",
].join("\n")

function parseArgs(argv: string[]): { root: string; cacheRoot?: string } {
  let root = REPO_ROOT
  let cacheRoot: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    }
    if (arg === "--root") {
      const value = argv[index + 1]
      if (!value) fail(["--root 需要一个目录参数", USAGE])
      index += 1
      root = isAbsolute(value) ? value : resolve(process.cwd(), value)
      continue
    }
    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length)
      if (!value) fail(["--root= 后面是空目录", USAGE])
      root = isAbsolute(value) ? value : resolve(process.cwd(), value)
      continue
    }
    if (arg === "--cache-root" || arg.startsWith("--cache-root=")) {
      const value = arg === "--cache-root" ? argv[++index] : arg.slice("--cache-root=".length)
      if (!value) fail(["--cache-root 需要一个目录参数", USAGE])
      cacheRoot = isAbsolute(value) ? value : resolve(process.cwd(), value)
      continue
    }
    fail([`未知参数：${arg}`, USAGE])
  }
  return { root, cacheRoot }
}

function loadManifest(): PrepareManifest {
  if (!existsSync(MANIFEST_PATH)) fail([`清单不存在：${MANIFEST_PATH}`])
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  } catch (error) {
    fail([`清单解不开：${MANIFEST_PATH}：${String(error)}`])
  }
  const manifest = parsed as PrepareManifest
  if (manifest.schema !== 1) fail([`清单 schema 不是 1（实际 ${String(manifest.schema)}）：${MANIFEST_PATH}`])
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail([`清单 files 为空：${MANIFEST_PATH}`])
  return manifest
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** 目标文件的期望字节（统一入口，保证"6 件 + LICENSE"都按同一套校验走）。 */
function expectedSpecs(manifest: PrepareManifest): Array<AssetSpec & { kind: "model" | "license" }> {
  return [
    ...manifest.files.map((file) => ({ ...file, kind: "model" as const })),
    {
      sourcePath: manifest.license.sourcePath,
      destinationPath: manifest.license.destinationPath,
      bytes: manifest.license.bytes,
      sha256: manifest.license.sha256,
      kind: "license" as const,
    },
  ]
}

function sourceUrl(manifest: PrepareManifest, spec: AssetSpec): string {
  return `${RAW_BASE}/${manifest.repository}/${manifest.commit}/${manifest.upstreamPath}/${spec.sourcePath}`
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  let response: Response
  try {
    // 显式不带 Authorization：公开 raw 内容不需要凭据，也不该把任何 GitHub token 送去这个 origin。
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    fail([`下载失败：${url}：${String(error)}`])
  }
  if (!response.ok) fail([`下载失败：${url}：HTTP ${response.status} ${response.statusText}`])
  return new Uint8Array(await response.arrayBuffer())
}

/** 写同目录临时文件 → 校验 → rename；失败删临时文件，绝不留下半截目标。 */
function writeAtomically(destination: string, bytes: Uint8Array): void {
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* 清理失败不掩盖主错误 */
    }
    fail([`落盘失败：${destination}：${String(error)}`])
  }
}

async function main(): Promise<void> {
  const { root, cacheRoot } = parseArgs(process.argv.slice(2))
  const manifest = loadManifest()
  const destinationRoot = join(root, manifest.destination)
  const specs = expectedSpecs(manifest)

  const reused: string[] = []
  const downloaded: string[] = []
  const copied: string[] = []
  const mismatch: string[] = []
  const missing: Array<AssetSpec & { kind: "model" | "license"; destination: string }> = []

  // 先只读扫描：坏件一次列全并**在下载任何东西之前**退出，保证"不覆盖用户模型"。
  for (const spec of specs) {
    const destination = join(destinationRoot, spec.destinationPath)
    if (!existsSync(destination)) {
      missing.push({ ...spec, destination })
      continue
    }
    const actualBytes = statSync(destination).size
    const actualSha = sha256File(destination)
    if (actualBytes === spec.bytes && actualSha === spec.sha256) {
      reused.push(`${spec.destinationPath} ← ${spec.sourcePath}（${actualBytes}B sha256=${actualSha}）`)
      continue
    }
    mismatch.push(
      `${spec.destinationPath}：现有文件与固定版本不符（size=${actualBytes}≠${spec.bytes} 或 sha256=${actualSha}≠${spec.sha256}）——拒绝覆盖，请人工确认后再处理`,
    )
  }

  if (mismatch.length > 0) {
    fail([
      `目标目录已有与固定版本不符的文件，未下载、未覆盖任何文件：${destinationRoot}`,
      ...mismatch,
    ])
  }

  // 显式缓存是离线来源；先验证全部缺件并保留已验字节，再开始写目标。
  const cached = new Map<string, Uint8Array>()
  if (cacheRoot) {
    for (const spec of missing) {
      const source = join(cacheRoot, manifest.destination, spec.destinationPath)
      if (!existsSync(source)) {
        mismatch.push(`离线缓存缺件：${source}`)
        continue
      }
      const bytes = readFileSync(source)
      const sha = createHash("sha256").update(bytes).digest("hex")
      if (bytes.byteLength !== spec.bytes || sha !== spec.sha256) {
        mismatch.push(`离线缓存与固定版本不符：${source}（size=${bytes.byteLength} sha256=${sha}）`)
        continue
      }
      cached.set(spec.destinationPath, bytes)
    }
    if (mismatch.length) fail(["离线缓存校验失败；未复制、未下载任何文件", ...mismatch])
  }

  for (const spec of missing) {
    const url = sourceUrl(manifest, spec)
    const bytes = cacheRoot ? cached.get(spec.destinationPath)! : await fetchBytes(url)
    const actualBytes = bytes.byteLength
    const actualSha = createHash("sha256").update(bytes).digest("hex")
    if (actualBytes !== spec.bytes || actualSha !== spec.sha256) {
      fail([
        `下载内容与固定清单不符：${url}`,
        `  期望 size=${spec.bytes} sha256=${spec.sha256}`,
        `  实际 size=${actualBytes} sha256=${actualSha}`,
        "  清单是钉死的版本；这里不换 commit/URL 兜底，未写入目标",
      ])
    }
    writeAtomically(spec.destination, bytes)
    const receipt = `${spec.destinationPath} ← ${spec.sourcePath}（${actualBytes}B sha256=${actualSha}）`
    if (cacheRoot) copied.push(receipt)
    else downloaded.push(receipt)
  }

  process.stdout.write(`${manifest.repository}@${manifest.commit}/${manifest.upstreamPath}\n`)
  process.stdout.write(`目标根：${destinationRoot}\n`)
  if (cacheRoot) process.stdout.write(`离线缓存根：${cacheRoot}\n`)
  for (const item of reused) process.stdout.write(`  [reuse]    ${item}\n`)
  for (const item of copied) process.stdout.write(`  [copy]     ${item}\n`)
  for (const item of downloaded) process.stdout.write(`  [download] ${item}\n`)
  process.stdout.write(
    `prepare-viewer-test-assets: ${specs.length}/${specs.length} 件就绪（reuse=${reused.length} copy=${copied.length} download=${downloaded.length}）；LICENSE=${manifest.license.spdx} ${manifest.license.copyright}\n`,
  )
}

await main()
