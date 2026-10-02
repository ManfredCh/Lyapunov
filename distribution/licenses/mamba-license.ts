/**
 * 打包链唯一的联网点：micromamba 的 LICENSE（版本跟随本机二进制）。
 *
 * 事实（2026-09-26 实测）：一次**瞬时断网**让候选构建 #2 在这里静默挂了 5 分钟才以 TimeoutError 失败。
 * 也就是说"打包能不能成功"隐含依赖"构建机此刻能不能访问 raw.githubusercontent.com"——
 * 没有网络的客户 CI / 离线环境**打包直接失败**，而这不是任何地方声明过的前置条件。
 *
 * 本模块把这件事变成显式的**取件顺序**（先本地、网络只是兜底）：
 *   1. `LYAPUNOV_MAMBA_LICENSE`（环境变量，显式操作者指令）——命中即用，不联网；
 *   2. 随包入库件 `distribution/licenses/micromamba-<version>-LICENSE`——命中即用，不联网（离线 CI 的主路径）；
 *   3. 缓存 `.runtime/licenses/micromamba-<version>-LICENSE`——本机上一次取件留下的副本，命中即用，不联网；
 *   4. 网络兜底——由调用方注入的**有界超时 + 重试**取件器（`script/package-linux.ts:fetchMambaLicense`）；
 *      成功后就地写回缓存（尽力而为），让下一次构建重新回到离线路径。
 *
 * 身份校验：`micromamba-<version>-LICENSE.meta.json` 记着该版本的 sha256/字节数/SPDX/来源。
 *   · 入库件被改动 ⇒ **fail-closed**（受版本控制的发行法律凭据被替换，必须人来看，不能用网络把它掩盖过去）；
 *   · **登记身份本身不可用**（meta.json 缺失／不是合法 JSON／没有 sha256）⇒ 入库件**一律 fail-closed**，
 *     且**不回落到缓存/网络**：「入库件在、身份不在」只可能是检出被裁剪（sparse-checkout、只拷 LICENSE、
 *     镜像脚本漏抓 meta.json）或 meta.json 被写坏；没有身份就无从"验明正身"，此时放行＝把完整性控制降级成**可选**
 *     （2026-09-26 验收实测：一份 62 B 假文本被当作 `source:"vendored"` 正常采用、`hashMatchesPin:null`、
 *     `fetchCalls:0`、进程 `EXIT=0`）；
 *   · 缓存/网络内容对不上登记身份 ⇒ 该候选被拒（缓存可自愈：继续走网络；网络也对不上 ⇒ fail-closed）；
 *   · 环境变量是操作者显式覆盖 ⇒ 原样采用，只如实报告是否与登记身份一致（不替操作者做判断）。
 *
 * 交付闸门：`mambaLicenseIdentityVerdict()` 把 `hashMatchesPin` 的**三态**（true/false/null）显式裁定成
 * 「能不能进发行载荷」——`null` 不是"通过"，`false` 也不是；唯一放行的未证实来源是上面那条显式覆盖。
 *
 * 语义边界（有意保留，不要退化）：许可证最终取不到 ⇒ 抛错中止打包。它是随包分发的法律产物，
 * 不能静默省掉；错误信息必须同时带**上游 URL**与**每个候选各自的失败原因**。
 */
import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {isAbsolute,join,resolve} from 'node:path'

/** 覆盖用环境变量：指向一个许可证文件，命中就不联网。 */
export const MAMBA_LICENSE_ENV = 'LYAPUNOV_MAMBA_LICENSE'
/** 上游取件前缀（tag 即 `micromamba --version` 的输出）。 */
export const MAMBA_LICENSE_URL_PREFIX = 'https://raw.githubusercontent.com/mamba-org/mamba'
/** 入库件所在目录（相对仓库根）。 */
export const MAMBA_LICENSE_DIR = 'distribution/licenses'
/** 本机缓存目录（相对仓库根，`.runtime` 不入库）。 */
export const MAMBA_LICENSE_CACHE = '.runtime/licenses'
/** 该件的 SPDX 标识（BSD 3-Clause，QuantStack/mamba 上游 LICENSE 原文）。 */
export const MAMBA_LICENSE_SPDX = 'BSD-3-Clause'

export type MambaLicenseSource = 'env' | 'vendored' | 'cache' | 'network'

/** 入库身份记录（`micromamba-<version>-LICENSE.meta.json`）。 */
export interface MambaLicenseRecord {
  version?: string
  spdx?: string
  source?: string
  tag?: string
  commit?: string | null
  sha256?: string
  bytes?: number
}

/** 取件结果：调用方据此写载荷、写 RELEASE.json、打日志。 */
export interface MambaLicenseResolution {
  version: string
  spdx: string
  /** 该版本对应的上游 URL（无论最终从哪取到，都如实报出来）。 */
  url: string
  source: MambaLicenseSource
  /** 实际取件位置：文件路径或 URL。 */
  location: string
  text: string
  sha256: string
  bytes: number
  /** 登记身份里的 sha256；无该版本记录时为 null。 */
  pinnedSha256: string | null
  /** 与登记身份是否一致；无记录时为 null。 */
  hashMatchesPin: boolean | null
  /** 登记身份为何不可用（meta.json 缺失／损坏／没有 sha256）；身份可用时该字段不存在。 */
  pinProblem?: string
  /** 网络取件成功后是否已写回缓存。 */
  cached: boolean
  /** 写缓存失败的原因（缓存是尽力而为，不因此失败，但必须可见）。 */
  cacheWriteError?: string
}

/** 已解析的许可证候选（内部用）。 */
interface Candidate {
  source: MambaLicenseSource
  location: string
  text: string
  sha256: string
  bytes: number
}

export interface ResolveMambaLicenseOptions {
  /** `micromamba --version` 的输出（已 trim），例如 `2.9.0`。 */
  version: string
  /** 仓库根：入库件与缓存的默认位置都相对它解析。 */
  root: string
  /** 显式覆盖的上游 URL；缺省由 version 拼出。 */
  url?: string
  env?: Record<string, string | undefined>
  vendoredDir?: string
  cacheDir?: string
  /**
   * 网络兜底取件器（**必填**）：必须自带超时与重试，由调用方注入，
   * 避免本模块里出现"裸 fetch 可以无限等"的第二次实现。
   */
  fetchLicense: (url: string) => Promise<string>
}

export function mambaLicenseUrl(version: string): string {
  return `${MAMBA_LICENSE_URL_PREFIX}/${version}/LICENSE`
}

export function mambaLicenseFileName(version: string): string {
  return `micromamba-${version}-LICENSE`
}

function digest(text: string): {sha256: string; bytes: number} {
  const buffer = Buffer.from(text, 'utf8')
  return {sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength}
}

async function readCandidate(path: string): Promise<Candidate | null> {
  if (!existsSync(path)) return null
  const buffer = await readFile(path)
  const text = buffer.toString('utf8')
  return {source: 'vendored', location: path, text, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength}
}

async function readRecord(path: string): Promise<MambaLicenseRecord | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as MambaLicenseRecord
  } catch {
    // 损坏的记录**不等于**"没有登记身份"这件事可以放过：这里退回 null，由调用点 fail-closed
    // （入库件分支见下方 `pinned === null`）。
    return null
  }
}

/**
 * 登记身份为何不可用：`缺失` / `不是合法 JSON` / `没有 sha256` 三种要**分开报**，
 * 否则操作者拿到一句"取不到"无从修（这条路径上的每一次失败都必须点名缺什么）。
 */
async function recordProblem(path: string): Promise<string> {
  if (!existsSync(path)) return `登记身份文件不存在：${path}`
  let parsed: MambaLicenseRecord | null = null
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as MambaLicenseRecord
  } catch (error) {
    return `登记身份文件不是合法 JSON：${path}（${(error as Error)?.message ?? String(error)}）`
  }
  const sha256 = parsed?.sha256
  return typeof sha256 === 'string' && sha256.length > 0 ? '' : `登记身份文件里没有可用的 sha256 字段：${path}（实际 ${JSON.stringify(sha256)}）`
}

function assertUsable(version: string, text: string, where: string): void {
  if (text.trim().length === 0) throw new Error(`许可证内容为空（${where}）：micromamba ${version} 的许可证是随包分发的法律产物，空文件不能顶替`)
}

function mismatch(where: string, actual: Candidate, pinned: string): string {
  return `${where} 内容与登记身份不一致：登记 sha256=${pinned}，实际 sha256=${actual.sha256}（${actual.bytes} B）`
}

function matchesPin(candidate: Candidate, pinned: string | null): boolean {
  return pinned === null || candidate.sha256 === pinned
}

/**
 * 按 env → 入库件 → 缓存 → 网络 的顺序取 micromamba 许可证。
 * 全部落空（或安全校验不通过）⇒ 抛错，绝不返回空串/占位文本。
 */
export async function resolveMambaLicense(options: ResolveMambaLicenseOptions): Promise<MambaLicenseResolution> {
  const version = options.version.trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`micromamba 版本号非法，无法据此定位许可证：${JSON.stringify(options.version)}（期望形如 2.9.0）`)
  }
  const url = options.url ?? mambaLicenseUrl(version)
  const fileName = mambaLicenseFileName(version)
  const vendoredDir = options.vendoredDir ?? join(options.root, MAMBA_LICENSE_DIR)
  const cacheDir = options.cacheDir ?? join(options.root, MAMBA_LICENSE_CACHE)
  const vendoredPath = join(vendoredDir, fileName)
  const cachePath = join(cacheDir, fileName)
  const env = options.env ?? process.env
  const recordPath = join(vendoredDir, `${fileName}.meta.json`)
  const record = await readRecord(recordPath)
  const pinned = typeof record?.sha256 === 'string' && record.sha256.length > 0 ? record.sha256.toLowerCase() : null
  const pinProblem = pinned === null ? await recordProblem(recordPath) : undefined
  const spdx = record?.spdx ?? MAMBA_LICENSE_SPDX

  const finish = (candidate: Candidate, source: MambaLicenseSource, extra?: Partial<MambaLicenseResolution>): MambaLicenseResolution => ({
    version,
    spdx,
    url,
    source,
    location: candidate.location,
    text: candidate.text,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
    pinnedSha256: pinned,
    hashMatchesPin: pinned === null ? null : candidate.sha256 === pinned,
    ...(pinProblem ? {pinProblem} : {}),
    cached: false,
    ...extra,
  })

  // 1) 显式覆盖：操作者指到哪个文件就用哪个，不联网。
  const override = (env[MAMBA_LICENSE_ENV] ?? '').trim()
  if (override !== '') {
    const path = isAbsolute(override) ? override : resolve(options.root, override)
    if (!existsSync(path)) {
      throw new Error(`${MAMBA_LICENSE_ENV} 指向的许可证文件不存在：${override}（解析为 ${path}）。它是随包分发的法律产物，设了覆盖就必须可用：修正该变量，或清空它以回落到入库件/缓存/网络。`)
    }
    const buffer = await readFile(path)
    const candidate: Candidate = {source: 'env', location: path, text: buffer.toString('utf8'), sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength}
    assertUsable(version, candidate.text, `${MAMBA_LICENSE_ENV}=${override}`)
    return finish(candidate, 'env')
  }

  // 2) 随包入库件（离线 CI 的主路径）：改动受版本控制的发行凭据必须人来看，不能拿网络掩盖。
  const vendored = await readCandidate(vendoredPath)
  if (vendored) {
    assertUsable(version, vendored.text, vendoredPath)
    // 没有登记身份 ⇒ 无从"验明正身" ⇒ fail-closed，**且不回落到缓存/网络**（用另一份副本把
    // "入库件不可核验"掩盖过去，与"入库件被改动"同罪）。
    if (pinned === null) {
      throw new Error(`入库许可证无法核验身份，停止打包（fail-closed）：${pinProblem}。入库件在、登记身份不在，说明这份检出被裁剪或被写坏；请恢复它（登记 sha256/来源），或用 ${MAMBA_LICENSE_ENV} 指向一份你确认过的副本。`)
    }
    if (!matchesPin(vendored, pinned)) throw new Error(`入库许可证已被改动：${mismatch(vendoredPath, vendored, pinned)}。请恢复该文件，或连同 ${fileName}.meta.json 一起更新登记身份。`)
    return finish(vendored, 'vendored')
  }

  // 3) 本机缓存：对不上登记身份就拒用并继续（缓存可自愈），但原因会进最终报错。
  //    注意 `pinned === null`（连登记身份文件都没有）这一档：本函数仍会读出来并如实报 null，
  //    但调用方的交付闸门 `mambaLicenseIdentityVerdict()` 不会让它进发行载荷。
  let cacheReason = '不存在'
  const cached = await readCandidate(cachePath)
  if (cached) {
    assertUsable(version, cached.text, cachePath)
    if (matchesPin(cached, pinned)) return finish(cached, 'cache')
    cacheReason = mismatch(cachePath, cached, pinned!)
    console.log(JSON.stringify({phase: 'micromamba-license-cache-rejected', path: cachePath, reason: cacheReason}))
  }

  // 4) 网络兜底（调用方注入的有界取件器）；成功即写回缓存，让下一次构建回到离线路径。
  //    同样地，`pinned === null` 时这里取到的字节**没有身份可比**，本函数如实报 `hashMatchesPin:null`，
  //    能不能进发行载荷由调用方的 `mambaLicenseIdentityVerdict()` 裁定（默认拒绝，见该函数）。
  let networkReason: string
  try {
    const text = await options.fetchLicense(url)
    assertUsable(version, text, url)
    const identity = digest(text)
    const candidate: Candidate = {source: 'network', location: url, text, sha256: identity.sha256, bytes: identity.bytes}
    if (!matchesPin(candidate, pinned)) throw new Error(`上游内容与登记身份不一致：${mismatch(url, candidate, pinned!)}`)
    let wrote = false
    let cacheWriteError: string | undefined
    try {
      await mkdir(cacheDir, {recursive: true})
      await writeFile(cachePath, text)
      wrote = true
    } catch (error) {
      cacheWriteError = (error as Error)?.message ?? String(error)
    }
    return finish(candidate, 'network', {cached: wrote, ...(cacheWriteError ? {cacheWriteError} : {})})
  } catch (error) {
    networkReason = (error as Error)?.message ?? String(error)
  }

  throw new Error(
    `无法取得 micromamba ${version} 的许可证，停止打包（fail-closed，不静默省掉这份随包分发的法律产物）。\n`
    + `  上游 URL：${url}\n`
    + `  入库件（${vendoredPath}）：不存在\n`
    + `  缓存（${cachePath}）：${cacheReason}\n`
    + `  环境变量 ${MAMBA_LICENSE_ENV}：未设置\n`
    + `  网络兜底：${networkReason}\n`
    + `  处置建议：把该件入库到 ${vendoredPath}（连同 ${fileName}.meta.json 记 sha256/来源），或用 ${MAMBA_LICENSE_ENV} 指向一份可用副本。`,
  )
}

/** 交付闸门的判定结果（`script/package-linux.ts` 据此放行或中止打包）。 */
export interface MambaLicenseIdentityVerdict {
  /** 是否允许把这份许可证写进发行载荷。 */
  adoptable: boolean
  /** 身份是否被证实（实际内容与登记 sha256 逐字节一致）。 */
  verified: boolean
  /** 未证实时**缺什么**：登记身份不可用（缺失/损坏/没有 sha256），还是内容与登记值不符。 */
  problem: string
  /** 由谁处置：已证实／操作者显式覆盖／必须修检出（拒绝采用）。 */
  disposition: 'verified' | 'operator-override' | 'refuse'
}

/**
 * 交付闸门：**发行载荷只接受身份被证实的许可证**。
 *
 * 为什么需要它：`hashMatchesPin` 是三态（`true`/`false`/`null`），而 `null` 在布尔语境里很容易被读成
 * "没有意见"。2026-09-26 验收实测的正是这一格 —— meta.json 缺失 ⇒ `pinned=null` ⇒ 校验恒真 ⇒
 * 一份 62 B 的假文本被当作 `source:"vendored"` 采用、构建继续。这里把三态**显式**裁定：
 * `true` ⇒ 放行；`false`（内容对不上）与 `null`（无从核验）⇒ 拒绝。
 *
 * **唯一例外**：`source === 'env'` —— `LYAPUNOV_MAMBA_LICENSE` 是操作者**显式**指定一份副本
 * （离线 CI 的公司镜像走这条），W16 定的语义是"原样采用，只如实报告是否与登记身份一致，不替操作者做判断"。
 * 它不是**静默**采用：路径由操作者给出，日志与 `RELEASE.json` 都记 `hashMatchesPin` 与原因，
 * 调用方还会额外打一条 `micromamba-license-identity-unverified`。因此放行，但必须把这个事实喊出来。
 */
export function mambaLicenseIdentityVerdict(resolution: MambaLicenseResolution): MambaLicenseIdentityVerdict {
  if (resolution.hashMatchesPin === true) return {adoptable: true, verified: true, problem: '', disposition: 'verified'}
  const problem = resolution.pinnedSha256 === null
    ? `没有可核验的登记身份：${resolution.pinProblem ?? '登记身份不可用，且原因未知'}`
    : `内容与登记身份不一致：登记 sha256=${resolution.pinnedSha256}，实际 sha256=${resolution.sha256}（${resolution.bytes} B）`
  return resolution.source === 'env'
    ? {adoptable: true, verified: false, problem, disposition: 'operator-override'}
    : {adoptable: false, verified: false, problem, disposition: 'refuse'}
}
