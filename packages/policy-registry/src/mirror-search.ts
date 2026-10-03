/**
 * 取件链的**第 3 级**：已知端点全不通时，「自己去搜哪里有这份文件，再取回来」。
 *
 * 三级链（第 1/2 级在 `source.ts`，第 3 级在本文件）：
 *   1 级  已知端点（GitHub `raw.githubusercontent.com`）—— 硬编在这条链上（`source.ts:369`）
 *   2 级  备用已知端点（`api.github.com` 内容接口）—— W4 在做，**落在 `source.ts`**
 *   3 级  搜索 + 下载 —— 本文件
 *
 * ── 为什么第 3 级必须与第 1/2 级**共用同一把尺子** ─────────────────────────────
 * 「搜到一个同名文件就用」＝「从任何地方下什么都行」：那是把**取件链的可信边界**从
 * "声明的来源坐标"降到"搜索引擎的排序"。所以本模块**不发明新的接受路径**：
 *
 *   · 它只允许把**同一个 `SourceFile` 的 `url` 换掉**——`path`/`bytes`/`sha256`/`gitBlob` 一个字不改；
 *   · 换完之后仍然走第 1 级的那个下载器（`source.ts` 的 `downloadFile`），
 *     于是 `POLICY_SOURCE_CHECKSUM_MISMATCH` 这道门**照旧在**（本模块另有一道独立复核，见 `verifyMirrorReading`）；
 *   · 搜索只能**提供 URL**，永远不能提供判据（见 `acceptDiscoveredCandidate` 与 `mirrorDiscoveryRequest.refuses`）。
 *
 * ── 整仓归档形态（U1；T0 里唯一"零配额零凭据 + 换一整族主机"的通道）──────────────
 * `codeload.github.com/{id}/tar.gz/{sha}` 拿到的是**整仓归档**，不是目标文件的字节，所以
 * "换 URL 不换判据"在它上面要落成两件事（判据一个字不改，只是**取字节的方式**变了）：
 *   · **解包只取一条**：按条目名**精确匹配**（不做路径归一化——归一化正是穿越的入口），
 *     其余条目一律不物化；软链/硬链**不跟随、不物化**（见 `parseTarEntries`）。
 *   · **门①提前到写盘之前**：抽出来的字节先与可信声明逐字核对，不符则连 `.part` 都不留
 *     （见 `unpackMirrorArchive`）；随后 `fetchFromMirrors` 的门②照旧独立再核一遍。
 * 归档候选**默认不启用**（`MirrorFetchInput.includeArchive`），且只对**同一发行方**开：搜索发现的
 * 第三方归档仍然拒（多一份解包器＝多一整个解析攻击面，而第三方能给归档就同样能给单文件）。
 *
 * ── 归档这条路的两条真缺口（U3／U4 · 2026-09-27）────────────────────────────────
 * 一次取件里**每一件**文件各自走一次 `fetchFromMirrors`；归档候选启用后，G1 实测的 68 件就是
 * 68 次"取归档 + 解包"（59,810,743 B / 150,743,040 B 解压 / 312 条目 ×68 ⇒ 509.8 s 全花在解包上），
 * 而**默认取字节路径**还要再撞一次 30 s 的尺子（`boundedFetch` 默认 `timeoutScope:'attempt'`＝含读正文；
 * 同一条链路 G1 实测 1400.4 s ⇒ 30 s 连一次都跑不完）。两条都在这里补齐，**判据一个字不改**：
 *
 *   · **① 记忆化**（`MirrorArchiveCache`）：同一个归档 URL **只取一次字节、只解一次包**，其余件从那份
 *     解包结果里"命中一条条目 → 写盘 → 过门①"（门①／门②仍然**逐件**做，见 `unpackMirrorArchive`）。
 *     键＝**URL ＋ 归档字节的 sha256 ＋ 两个上限**：内容寻址的钉（`expectedSha256`，如 `545ead52…`）
 *     既进键、又被逐字核对 ⇒ 命中永远不会绕过"这份归档是不是我们要的那一份"。
 *     没钉时**默认不缓存**：只按 URL 记的键分不清"同一个 URL 先后吐了什么"，而换一份字节就是悄悄换掉
 *     整份归档；要在这个前提下复用，得由调用方显式交一个自己持有的实例（`cache: MirrorArchiveCache`，
 *     生命周期与可信边界都在调用方手里）。
 *   · **② 归档这一跳自己的上限**（`MIRROR_ARCHIVE_FETCH_TIMEOUT_MS`＝30 min，读自 G1 那条 1400.4 s
 *     链路与它 1800 s 的 curl 上限）：**只放宽这一跳**。`POLICY_FETCH_TIMEOUT_MS`（30 s）以及其它每一跳
 *     （元数据、建连、逐件下载、重定向）的字面**一个字不改**。
 *
 * ── 搜什么 ────────────────────────────────────────────────────────────────
 * **主键是指纹，不是文件名。** 文件名只用来缩小范围（同一份权重在镜像里可能改名、可能被重新打包），
 * 判据始终是字节身份：`sha256`（LFS／ModelScope 口径）或 `gitBlob`（git blob sha1，GitHub／HF 非 LFS 口径）。
 * `mirrorDiscoveryRequest()` 产出的就是这一份「发现请求」——把"要搜什么、拿什么判、什么一律不要"
 * 交给持有搜索能力的一方（模型的原生 `web_search`／`web_fetch`）。
 *
 * ── 为什么"搜索"不在产品里自己实现 ─────────────────────────────────────────
 * 本仓已核实：产品**没有**自己的联网搜索设施（`policy_search` 只搜**仓库/模型名**，
 * 不搜文件；见 `plugin.ts:51`）。原生 `web_search`／`web_fetch` 是**宿主给模型的工具**，不是产品能力
 * ——`packages/scene-kit/src/reference-tools.ts:6` 把这条边界写得很清楚：
 * 「搜索与网页读取仍用原生 web_search／web_fetch：本文件只补"原图取得"这一段」。
 * 于是第 3 级的正确形态与本仓既有先例同形：**产品出"发现请求" + 负责"核验与取得"，搜索由持有搜索能力的一方做。**
 *
 * ── 与 `packs` 源的关系 ────────────────────────────────────────────────────
 * `packs` 源**不适用**本模块：它的字节只经能力包端点（`pack-source.ts` 的 catalog/open/stream），
 * `source.ts:358` 的 `PACK_PUBLIC_FALLBACK_FORBIDDEN` 是一条既有纪律，第 3 级不得在它上面开公开后门。
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { boundedFetch, checkCancelled, downloadFile, endpointHost, hashFile, isTransientFetchFailure, policyFile, PolicyFetchError, type PolicyFetchAttempt, type PolicyFetchTrace, type PolicySource, type SourceFile } from './source.ts'

/** `path` 分段编码（与 `source.ts` 的 `encodePath` 同口径；那份是模块私有量，本文件不重复导出、也不改它）。 */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const basename = (path: string) => path.split('/').at(-1) ?? path

/**
 * 一个文件的**声明身份**：只有身份，**没有 URL**。
 * URL 是第 3 级要去找的东西，身份是找回来之后判"是不是同一份"的尺子——两者放在同一个结构里，
 * 迟早会有人拿"候选自己声明的身份"当判据（那正是本模块要防的事），所以这里从类型上就分开。
 */
export interface SourceFileIdentity { path: string; bytes: number; sha256?: string; gitBlob?: string }

/**
 * 身份**从哪来**——判据的可信度就是这一行的可信度，所以它是必填字段，不是注释。
 *  · `source-snapshot`：同一次取件的来源快照（`api.github.com` 的 tree／HF 的 tree／ModelScope 的 listing）
 *    —— 最强：坐标固定（`resolvedRevision`）、逐件有 `gitBlob`/`sha256`，与 P13/ISAAC-14B 实测口径同源。
 *  · `local-manifest`：本机**上一次核对通过**的 `manifest.json` 里的 `sourceFiles[]`——次强：
 *    它是同一条链自己写下的，且当时逐件核对过。
 *  · `caller-pin`：**带外**抄来的指纹（模型卡、回执、用户口述）——必须写清 `note`（从哪儿抄的、
 *    谁给的）。它**不是**自动可信，只是"有出处可复核"，所以单独成一档、且必须留痕。
 */
export type IdentityProvenance = 'source-snapshot' | 'local-manifest' | 'caller-pin'
export interface DeclaredIdentity { identity: SourceFileIdentity; provenance: IdentityProvenance; note: string }

/** 身份强度：**只认密码学摘要**。`bytes` 是声明的一部分，但它不是身份（同大小的不同文件太常见）。 */
export type IdentityStrength = 'sha256' | 'gitBlob' | 'none'
export const identityStrength = (identity: SourceFileIdentity): IdentityStrength =>
  /^[a-f0-9]{64}$/.test(identity.sha256 ?? '') ? 'sha256' : /^[a-f0-9]{40}$/.test(identity.gitBlob ?? '') ? 'gitBlob' : 'none'

/**
 * 判据门（**第 3 级的第一道闸**）：没有可信指纹就没有判据 ⇒ 不许开始搜索。
 *
 * 这一条挡掉的正是"从任何地方下什么都行"：只要判据可以缺席，搜索路径就退化成"谁先应答谁算数"。
 * 所以这里的失败**不是**能力缺口、不是网络问题，是**拒绝执行**——回执里必须按"安全门"记，不按"未覆盖"记。
 *
 * `bytes` 必须是非负安全整数（否则声明本身就是坏的）；`path` 走 `policyFile` 的既有校验
 * （绝对路径、`..`、反斜杠一律拒）。
 */
export function requireMirrorIdentity(declared: DeclaredIdentity): { strength: 'sha256' | 'gitBlob'; identity: SourceFileIdentity } {
  const identity = declared?.identity
  if (!identity || typeof identity !== 'object') throw new Error('POLICY_MIRROR_IDENTITY_UNDECLARED: 没有身份声明就没有判据——第 3 级拒绝在"不知道自己在找什么"的前提下搜索')
  const path = policyFile(identity.path)
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes < 0) throw new Error('POLICY_MIRROR_IDENTITY_INVALID: 声明的字节数不是非负整数')
  const strength = identityStrength(identity)
  if (strength === 'none') throw new Error([
    'POLICY_MIRROR_IDENTITY_WEAK: 声明里没有 sha256、也没有 gitBlob —— 只有"同名 + 同大小"不构成身份',
    `  文件：${path}（声明 ${identity.bytes} 字节）`,
    `  身份出处：${declared.provenance}${declared.note ? `（${declared.note}）` : ''}`,
    '  处置建议：先取到**来源快照**（第 1/2 级的元数据接口）拿到 gitBlob／sha256 再来；',
    '            确实取不到元数据时，用带外抄来的指纹（provenance:"caller-pin"）并把出处写进 note。',
  ].join('\n'))
  return { strength, identity: { ...identity, path } }
}

/** 镜像候选的可信档位（数值小者先试）。**档位只决定顺序，不决定是否核对**——任何档位都要过同一道字节门。 */
export type MirrorTrust = 'same-publisher' | 'configured-mirror' | 'discovered'
const TRUST_ORDER: Record<MirrorTrust, number> = { 'same-publisher': 0, 'configured-mirror': 1, discovered: 2 }

/**
 * 候选的取得形态：`blob` 能直接喂给第 1 级的下载器；`archive` 是整仓归档——
 * **不能**喂给那个下载器（它的字节不是目标文件的字节），要走 `unpackMirrorArchive`。
 */
export type MirrorShape = 'blob' | 'archive'
export interface MirrorCandidate {
  url: string
  host: string
  trust: MirrorTrust
  shape: MirrorShape
  /** 人可复核的一句话：这个候选凭什么被列出来。 */
  rationale: string
  /** 谁放行的（配置里的 label／接受搜索候选时的调用方）——`servedBy` 记录要用它，不靠猜。 */
  admittedBy: string
}

export interface MirrorSearchOptions {
  /** 显式配置的镜像模板（操作者放行的第三方）。占位符：`{id}` `{revision}` `{path}`（已编码）`{sha256}`。 */
  configured?: Array<{ template: string; label: string }>
  /** 给了白名单就只认名单内的 host（精确匹配或 `.` 后缀匹配）；不给＝只走下面的通用主机纪律。 */
  admittedHosts?: string[]
  /** 是否把 `github.com/{id}/raw/...` 这类"同一发行方但通常 302 回故障主机"的候选也列出来。默认列出（无害、且便于诊断）。 */
  includeSamePublisherWeb?: boolean
}

/**
 * 通用主机纪律（**静态、纯函数**，不解析 DNS）：
 *  · 只允许 https（凭据、防降级）；
 *  · URL 里不许带 userinfo（`https://user:pass@host/...` 是把凭据写进日志与 manifest 的经典方式）；
 *  · 不许 IP 字面量、不许 localhost/`.local`/`.internal`（第 3 级的候选来自**搜索**，这条是 SSRF 的第一道闸）；
 *  · 不许官方 HF host —— 沿用 `source.ts:48` 的既有纪律：镜像失败后静默回退官方端点是破约。
 *
 * **本函数不做 DNS 复核**（`scene-kit/src/network-assets.ts:183` 的 `assertPublicHttpsURL` 会做，
 * 但那是另一条链的设施，且给取件链引入 DNS 预检会改掉第 1/2 级的既有失败形态）。
 * "域名解析到私网"这一条**未覆盖**，已在回执登记。
 */
export function mirrorHostPolicy(value: string, options: MirrorSearchOptions = {}): URL {
  if (typeof value !== 'string' || !URL.canParse(value)) throw new Error(`POLICY_MIRROR_URL_INVALID: ${String(value).slice(0, 200)}`)
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error(`POLICY_MIRROR_URL_MUST_BE_HTTPS: ${url.protocol}//${url.host}`)
  if (url.username || url.password) throw new Error('POLICY_MIRROR_URL_MUST_NOT_INCLUDE_CREDENTIALS')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw new Error(`POLICY_MIRROR_URL_IP_LITERAL_FORBIDDEN: ${host}`)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error(`POLICY_MIRROR_URL_PRIVATE_HOST_FORBIDDEN: ${host}`)
  if (host === 'huggingface.co' || host.endsWith('.huggingface.co')) throw new Error(`POLICY_MIRROR_OFFICIAL_HF_FORBIDDEN: ${host}`)
  if (options.admittedHosts && !options.admittedHosts.some(allowed => host === allowed.toLowerCase() || host.endsWith('.' + allowed.toLowerCase()))) throw new Error(`POLICY_MIRROR_HOST_NOT_ADMITTED: ${host}`)
  return url
}

/** 声明坐标（第 3 级要知道"在找谁的文件"，但**不用它当判据**）。 */
export interface MirrorCoordinates { provider: PolicySource; modelId: string; revision: string }

/**
 * **同一发行方**的其他通道（T0）。对 GitHub 而言是：
 *  · `github.com/{id}/raw/{sha}/{path}` —— 通常 302 到 `raw.githubusercontent.com`（也就是第 1 级那个故障主机），
 *    列出来是为了让"哪一跳断的"在诊断里看得见，不是指望它通；
 *  · `codeload.github.com/{id}/tar.gz/{sha}` —— **零 API 配额、零凭据**的整仓归档，是这一档里唯一"换了一整族主机"的通道。
 *    形态是 `archive`：默认不启用（`MirrorFetchInput.includeArchive`）；启用后由 `unpackMirrorArchive`
 *    解包并按**同一份声明**核对（判据不变，只是取字节的方式变了）。
 *
 * **不列 `api.github.com` 内容接口**：那是**第 2 级**（W4 在做），同一条链上重复实现会与 W4 打架；
 * 而且它要带 `Accept: application/vnd.github.raw` 才吐原文，第 1 级的下载器没有传自定义头的接缝。
 */
export function knownMirrorCandidates(coordinates: MirrorCoordinates, declared: DeclaredIdentity, options: MirrorSearchOptions = {}): MirrorCandidate[] {
  if (coordinates.provider === 'packs') throw new Error('POLICY_MIRROR_PACKS_FORBIDDEN: packs 源的字节只经能力包端点（PACK_PUBLIC_FALLBACK_FORBIDDEN 的同一道理），第 3 级不得开公开后门')
  const { identity } = requireMirrorIdentity(declared)
  const id = coordinates.modelId, revision = coordinates.revision, path = encodePath(identity.path)
  const rows: MirrorCandidate[] = [], push = (url: string, trust: MirrorTrust, shape: MirrorShape, rationale: string, admittedBy: string) =>
    rows.push({ url, host: mirrorHostPolicy(url, options).hostname.toLowerCase(), trust, shape, rationale, admittedBy })
  if (coordinates.provider === 'github') {
    if (options.includeSamePublisherWeb !== false) {
      push(`https://github.com/${id}/raw/${revision}/${path}`, 'same-publisher', 'blob',
        '同一发行方（GitHub 网页端 raw 入口）；通常会 302 到 raw.githubusercontent.com —— 即第 1 级那个故障主机，列出来是为了让"断在哪一跳"可诊断', 'known-mirror:github-web-raw')
      push(`https://codeload.github.com/${id}/tar.gz/${revision}`, 'same-publisher', 'archive',
        '同一发行方（codeload 整仓归档）：零 API 配额、零凭据、换了一整族主机；形态是归档，逐条条目按条目名精确匹配后与声明逐字核对（见 unpackMirrorArchive）', 'known-mirror:github-codeload')
    }
  }
  for (const entry of options.configured ?? []) {
    const needs = (token: string) => entry.template.includes(token)
    if (needs('{sha256}') && !identity.sha256) { rows.push({ url: '', host: '', trust: 'configured-mirror', shape: 'blob', rationale: `模板 ${entry.label} 需要 {sha256}，而本次声明只有 gitBlob ⇒ 跳过（不降级成别的内容寻址）`, admittedBy: entry.label }); continue }
    const url = entry.template.split('{id}').join(id).split('{revision}').join(revision).split('{path}').join(path).split('{sha256}').join(identity.sha256 ?? '')
    push(url, 'configured-mirror', 'blob', `操作者配置的镜像（${entry.label}）；仍然要过同一道字节门`, entry.label)
  }
  // 空 URL 的行只用于"为什么没列出来"的记账，不进候选表。
  return rows.filter(row => row.url !== '')
}

/**
 * 接受一条**搜索发现的**候选。四条硬规则，缺一不可：
 *  1. **显式放行**：`allowDiscovered === true`。默认不放行——第 3 级不是"自动去第三方站点抓字节"，
 *     是"在已知端点全不通、且操作者/调用方同意之后，才去第三方找"。放行人与理由都会被记进 `servedBy`。
 *  2. **判据必须在手**：`declared` 必须先过 `requireMirrorIdentity`。搜索**不能**把判据带进来。
 *  3. **候选只贡献 URL**：这里的入参只有 URL；任何"候选页面自己声明的 sha256"都不参与判据
 *     （`mirrorDiscoveryRequest().refuses` 把这条写成了给模型看的明文）。
 *  4. **只要单文件**：`shape` 只能是 `blob`。解包器只对**同一发行方**的归档开（T0 的 codeload）——
 *     第三方能给归档就同样能给单文件，而多收一份来路不明的 tar 只多一整个解析攻击面。
 *     `mirrorDiscoveryRequest().acceptance.candidates === 'blob-urls-only'` 早就是这条承诺，这里把它兑现。
 */
export function acceptDiscoveredCandidate(input: { url: string; admittedBy: string; declared: DeclaredIdentity; rationale?: string; shape?: MirrorShape }, options: MirrorSearchOptions = {}): MirrorCandidate {
  requireMirrorIdentity(input.declared)
  // `admittedBy` 是留痕字段（`servedBy` 要回答"谁放行的"）：空值等于把"谁同意的"这件事丢掉，直接拒。
  if (typeof input.admittedBy !== 'string' || !input.admittedBy.trim()) throw new Error('POLICY_MIRROR_ADMITTED_BY_REQUIRED: 放行第三方候选必须留下放行人/理由')
  if (input.shape === 'archive') throw new Error('POLICY_MIRROR_DISCOVERED_ARCHIVE_REFUSED: 第三方归档**不接**——解包器只对同一发行方（T0）的归档开；本条要找的是单个文件，请把单文件 URL 交回来')
  const url = mirrorHostPolicy(input.url, options)
  return {
    url: url.href,
    host: url.hostname.toLowerCase(),
    trust: 'discovered',
    shape: input.shape ?? 'blob',
    rationale: input.rationale ?? '搜索发现的候选：只提供 URL，判据仍来自声明（字节门不因它而放宽）',
    admittedBy: input.admittedBy,
  }
}

/** 排序：可信档位优先，同档保持声明顺序（确定性——同一次输入必须给出同一个顺序）。 */
export function rankMirrorCandidates(candidates: MirrorCandidate[], options: { includeArchive?: boolean } = {}): MirrorCandidate[] {
  const seen = new Set<string>()
  return candidates
    .filter(row => options.includeArchive === true || row.shape === 'blob')
    .filter(row => !seen.has(row.url) && (seen.add(row.url), true))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => TRUST_ORDER[a.row.trust] - TRUST_ORDER[b.row.trust] || a.index - b.index)
    .map(entry => entry.row)
}

/**
 * 把"身份 + 候选 URL"合成第 1 级下载器认得的 `SourceFile`。
 * **只有 `url` 来自候选**；`path`/`bytes`/`sha256`/`gitBlob` 全部来自声明——
 * 这是"换端点不换判据"在类型层面的落点，也是负对照要打的那一行。
 */
export function mirrorSourceFile(declared: DeclaredIdentity, candidate: MirrorCandidate, revision: string): SourceFile {
  const { identity } = requireMirrorIdentity(declared)
  if (candidate.shape !== 'blob') throw new Error(`POLICY_MIRROR_ARCHIVE_UNSUPPORTED: ${candidate.host} 提供的是整仓归档（${candidate.rationale}）——归档的字节**不是**目标文件的字节，喂给这个下载器只会把整包 tar.gz 当目标文件收（bytes 门会当场撞上 POLICY_DOWNLOAD_OVERSIZED）；请走 unpackMirrorArchive`)
  return { path: identity.path, bytes: identity.bytes, revision, ...(identity.sha256 ? { sha256: identity.sha256 } : {}), ...(identity.gitBlob ? { gitBlob: identity.gitBlob } : {}), url: candidate.url }
}

/** 下载器返回的读数（`downloadFile` 的形状）。 */
export interface MirrorReading { bytes: number; sha256: string; gitBlob?: string }

/**
 * **独立复核**（第 3 级的第二道闸，与 `downloadFile` 内那道**互不替代**）。
 * 第 1 级的门保证"写盘的字节与 `SourceFile` 声明一致"；这一道保证"`SourceFile` 的声明与**原始身份声明**一致"，
 * 并在读数缺了声明要的那一项摘要时**回盘重算**（`hashFile`）——缺项不等于通过。
 *
 * 为什么两道都要：第 3 级的 URL 是**搜来的**，如果只有一道门、而那一道路径上哪天被放宽（或换了下载器），
 * 搜索路径就悄悄变成"从任何地方下什么都行"。复核独立成函数，就是为了让它能被单独测、单独做负对照。
 */
export async function verifyMirrorReading(declared: DeclaredIdentity, localPath: string, reading: MirrorReading): Promise<{ ok: true; reading: MirrorReading } | { ok: false; reason: string }> {
  const { strength, identity } = requireMirrorIdentity(declared)
  if (reading.bytes !== identity.bytes) return { ok: false, reason: `字节数不符：声明 ${identity.bytes}，实测 ${reading.bytes}` }
  const needsHash = strength === 'sha256' ? typeof reading.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reading.sha256) : typeof reading.gitBlob !== 'string' || !/^[a-f0-9]{40}$/.test(reading.gitBlob)
  const actual = needsHash ? await hashFile(localPath, identity.gitBlob ? identity.bytes : undefined) : reading
  if (strength === 'sha256' && actual.sha256 !== identity.sha256) return { ok: false, reason: `sha256 不符：声明 ${identity.sha256}，实测 ${actual.sha256}` }
  if (identity.gitBlob && actual.gitBlob !== identity.gitBlob) return { ok: false, reason: `gitBlob 不符：声明 ${identity.gitBlob}，实测 ${actual.gitBlob ?? '（未算出）'}` }
  return { ok: true, reading: actual }
}

export interface MirrorFetchInput {
  declared: DeclaredIdentity
  coordinates: MirrorCoordinates
  candidates: MirrorCandidate[]
  target: string
  signal: AbortSignal
  trace?: PolicyFetchTrace
  resume?: boolean
  /**
   * 是否**启用归档形态的候选**（`MirrorShape: 'archive'`，即 T0 的 codeload 整仓归档）。
   * 默认 `false`：归档要多走一个解包器（多一份解析攻击面 + 多一份内存），所以由调用方显式开。
   * 打开后归档候选走 `unpackMirrorArchive`（**不**走 `download` 接缝），解包后仍过同一道门②。
   */
  includeArchive?: boolean
  /** 归档解包的参数与取字节接缝（只在 `includeArchive` 为真时用）。 */
  archive?: MirrorArchiveOptions
  /** 下载器接缝（默认＝第 1 级的 `downloadFile`：断点续传、逐件字节门都在它里面）。 */
  download?: (file: SourceFile, target: string, signal: AbortSignal, resume: boolean, trace?: PolicyFetchTrace) => Promise<MirrorReading>
}
export interface MirrorFetchReading {
  servedBy: { url: string; host: string; trust: MirrorTrust; admittedBy: string; shape: MirrorShape }
  reading: MirrorReading
  /** 逐条候选的裁决记录——**"字节由哪个端点提供"必须可回答**（裁决 (a) 的追加要求），失败的那些也要留痕。 */
  attempts: Array<{ url: string; host: string; trust: MirrorTrust; outcome: 'served' | 'rejected'; reason: string }>
}

/**
 * 逐条候选试取：**先试同一发行方、再试配置镜像、最后才是搜索发现的第三方**；
 * 任何一条候选只要字节门不过，就**拒绝它并继续下一条**（不重试、不降级判据、不换判据）。
 * 全部试完仍无一条通过 ⇒ `POLICY_MIRROR_EXHAUSTED`，报文里带齐每一条的拒绝原因。
 *
 * **`blob` 与 `archive` 是同一把尺子下的两条取字节路径**：`blob` 走第 1 级的下载器（它自带的字节门
 * ＝门①），`archive` 走 `unpackMirrorArchive`（解包出来的那一条条目先与同一份声明逐字核对＝门①，
 * 且**在写盘之前**）。两条路径汇合到同一个门②（`verifyMirrorReading`），`servedBy.shape` 如实记录走的是哪条。
 */
export async function fetchFromMirrors(input: MirrorFetchInput): Promise<MirrorFetchReading> {
  const { identity } = requireMirrorIdentity(input.declared)
  const download = input.download ?? downloadFile
  const attempts: MirrorFetchReading['attempts'] = []
  for (const candidate of rankMirrorCandidates(input.candidates, { includeArchive: input.includeArchive })) {
    let reading: MirrorReading
    if (candidate.shape === 'archive') {
      try {
        reading = await unpackMirrorArchive({ declared: input.declared, candidate, target: input.target, signal: input.signal, trace: input.trace, options: input.archive })
      } catch (error) {
        attempts.push({ url: candidate.url, host: candidate.host, trust: candidate.trust, outcome: 'rejected', reason: String((error as Error).message) })
        continue
      }
    } else {
      let file: SourceFile
      try { file = mirrorSourceFile(input.declared, candidate, input.coordinates.revision) } catch (error) {
        attempts.push({ url: candidate.url, host: candidate.host, trust: candidate.trust, outcome: 'rejected', reason: String((error as Error).message) })
        continue
      }
      try { reading = await download(file, input.target, input.signal, input.resume !== false, input.trace) } catch (error) {
        attempts.push({ url: candidate.url, host: candidate.host, trust: candidate.trust, outcome: 'rejected', reason: String((error as Error).message) })
        continue
      }
    }
    const verified = await verifyMirrorReading(input.declared, input.target, reading)
    if (!verified.ok) { attempts.push({ url: candidate.url, host: candidate.host, trust: candidate.trust, outcome: 'rejected', reason: `POLICY_MIRROR_IDENTITY_MISMATCH: ${verified.reason}` }); continue }
    attempts.push({ url: candidate.url, host: candidate.host, trust: candidate.trust, outcome: 'served', reason: `字节身份通过（${identity.sha256 ? `sha256 ${identity.sha256}` : `gitBlob ${identity.gitBlob}`}，${identity.bytes} 字节）` })
    return { servedBy: { url: candidate.url, host: candidate.host, trust: candidate.trust, admittedBy: candidate.admittedBy, shape: candidate.shape }, reading: verified.reading, attempts }
  }
  throw new Error([
    'POLICY_MIRROR_EXHAUSTED: 已知端点与全部候选镜像都没给出符合声明的字节',
    `  文件：${identity.path}（声明 ${identity.bytes} 字节，${identity.sha256 ? `sha256 ${identity.sha256}` : `gitBlob ${identity.gitBlob}`}）`,
    `  来源坐标：${input.coordinates.provider} ${input.coordinates.modelId}@${input.coordinates.revision}`,
    `  候选裁决：${attempts.length ? attempts.map(row => `${row.outcome === 'served' ? '✓' : '✗'}${row.host}（${row.trust}）：${row.reason}`).join('；') : '（无候选）'}`,
    '  可否重试：false（不是瞬时故障——是"这些候选里没有一份是我们要的文件"；先补候选，或回头修第 1/2 级）',
  ].join('\n'))
}

/**
 * 第 3 级的**"像人一样去搜"**那一步：产品自己不会搜（已核实，见文件头），
 * 所以它出一份**发现请求**交给持有搜索能力的一方（模型的原生 `web_search`／`web_fetch`）。
 *
 * 请求里带三样东西，缺一不可：
 *  · `queries`：**每条都带指纹**（`gitBlob`/`sha256` 是内容寻址的稳定串，内容寻址的镜像索引里认它）；
 *  · `locatorQueries`：只按「坐标 + 文件名 + 字节数」缩小范围——用来找到"**可能**放着这份文件的页面"，
 *    找到之后仍必须回到指纹判据（两者分开成两个字段，就是为了让"线索"没法冒充"判据"）；
 *  · `verification`：拿什么判、怎么判、以及"必须逐字相同"；
 *  · `refuses`：**明文列出不接受什么**——让"搜到一个同名文件就用"这件事在协议层面就说不通。
 */
export interface MirrorDiscoveryRequest {
  status: 'SEARCH_REQUIRED'
  /** 为什么走到第 3 级（第 1/2 级的失败读数）——搜之前先留下"为什么不得不搜"，不然没人能复核这一步是否必要。 */
  reason: string
  identity: SourceFileIdentity
  coordinates: MirrorCoordinates
  queries: string[]
  locatorQueries: string[]
  verification: { kind: 'sha256' | 'gitBlob'; value: string; bytes: number; rule: string }
  acceptance: { allowDiscovered: true; admittedBy: string; candidates: 'blob-urls-only'; maxBytes: number }
  refuses: string[]
}
export function mirrorDiscoveryRequest(input: { declared: DeclaredIdentity; coordinates: MirrorCoordinates; reason: string; admittedBy?: string }): MirrorDiscoveryRequest {
  const { strength, identity } = requireMirrorIdentity(input.declared)
  if (input.coordinates.provider === 'packs') throw new Error('POLICY_MIRROR_PACKS_FORBIDDEN: packs 源不适用搜索回退（字节只经能力包端点）')
  const fingerprint = strength === 'sha256' ? identity.sha256! : identity.gitBlob!
  const file = basename(identity.path)
  const queries = [
    fingerprint,
    `"${input.coordinates.modelId}" "${fingerprint}"`,
    `"${file}" "${fingerprint}"`,
  ]
  const locatorQueries = [
    `"${input.coordinates.modelId}" "${file}"`,
    `"${file}" "${identity.bytes}"`,
  ]
  return {
    status: 'SEARCH_REQUIRED',
    reason: input.reason,
    identity,
    coordinates: input.coordinates,
    queries,
    locatorQueries,
    verification: {
      kind: strength, value: fingerprint, bytes: identity.bytes,
      rule: `取回后逐字核对：字节数必须等于 ${identity.bytes}，且 ${strength} 必须等于 ${fingerprint}；不符即丢弃该候选并继续下一条`,
    },
    acceptance: { allowDiscovered: true, admittedBy: input.admittedBy ?? 'policy-download:level3', candidates: 'blob-urls-only', maxBytes: identity.bytes },
    refuses: [
      '不接受"文件名相同"或"字节数相同"作为同一份文件的依据（判据只有 sha256／gitBlob）；locatorQueries 只缩小范围，命中它不等于命中文件',
      '不接受候选自己声明的 sha256／gitBlob 当判据——候选只能提供 URL，判据只来自本请求里的 verification',
      '不接受非 https、URL 里带凭据、IP 字面量、localhost/内网主机名、以及 huggingface.co 官方端点',
      `不接受形态不是单个文件的候选（整仓归档只对**同一发行方**开，见 unpackMirrorArchive；搜索交回来的必须是 ${identity.path} 这一个文件的 URL）`,
      '不接受 packs 源的公开回退（该源字节只经能力包端点）',
    ],
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 整仓归档形态（U1）：`codeload.github.com/{id}/tar.gz/{sha}`
 *
 * 这是 T0 里**唯一零 API 配额、零凭据、且换了一整族主机**的通道（配额是 P13/G1 那格的卡点，
 * 匿名只有 60/h 且已打满过；官方 HF 端点与 packs 端点另有各自的纪律）。它贵在一个"换"字，
 * 所以它的价值**不能**用"放宽判据"去换：归档拿到的是整包字节，本模块做的事仍然是
 * 「换 URL 不换判据」——只是把"取到目标文件那一段字节"的方式从 HTTP GET 换成了解包。
 *
 * 三道解法（缺一不可）：
 *   ① **取**：逐跳重过主机纪律（重定向不能把我们带去内网／官方 HF），**不带任何凭据**，字节数有上限；
 *   ② **解**：解析即校验（路径穿越／软链／权限位在解析时有结论），只物化**命中目标的那一条**条目；
 *   ③ **核**：抽出来的字节先与**可信声明**逐字核对（门①，在写盘之前），再交给 `verifyMirrorReading`（门②）。
 *
 * 归档**从不**被当作"目标文件的字节"：`mirrorSourceFile` 对 `shape:'archive'` 仍然抛
 * `POLICY_MIRROR_ARCHIVE_UNSUPPORTED`（那条路径是给单文件下载器的）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 归档条目的类型。**只有 `file` 会被物化**；`directory` 只用于推导顶层目录；其余一律跳过并记账。 */
export type ArchiveEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other'
export interface ArchiveEntry { path: string; type: ArchiveEntryType; mode: number; size: number; payload: Buffer }

const TAR_BLOCK = 512
/** tar 的 typeflag → 本模块的条目类型。`'0'`/`'\0'`/空 都是普通文件（历史实现三种都写过）。 */
const TAR_TYPE: Record<string, ArchiveEntryType> = { '0': 'file', '\0': 'file', '': 'file', '5': 'directory', '1': 'hardlink', '2': 'symlink' }

const tarText = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}
/** 八进制数值字段；GNU 的 base-256（首字节高位为 1）也认——不认就会把大文件静默读成 0。 */
const tarNumber = (block: Buffer, offset: number, length: number, what: string): number => {
  const raw = block.subarray(offset, offset + length)
  if (raw[0]! & 0x80) {
    let value = 0
    for (const byte of raw.subarray(1)) value = value * 256 + byte
    if (!Number.isSafeInteger(value)) throw new Error(`POLICY_MIRROR_ARCHIVE_MALFORMED: ${what} 超出安全整数范围（base-256 编码）`)
    return value
  }
  // 八进制字段的两种历史写法都要认：`"0000644\0"`（NUL 结尾）与校验和那种 `"001234\0 "`（NUL 之后还有填充空格）
  // ⇒ 从**第一个 NUL** 截断再 trim，而不是只剥尾部 NUL。
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim()
  if (text !== '' && !/^[0-7]+$/.test(text)) throw new Error(`POLICY_MIRROR_ARCHIVE_MALFORMED: ${what} 不是八进制数`)
  return text === '' ? 0 : Number.parseInt(text, 8)
}
/** 头部校验和：只覆盖普通字节，校验和字段本身按 8 个空格算。两种带符号口径都收（GNU/BSD 历史差异）。 */
const tarChecksumOk = (block: Buffer, stored: number): boolean => {
  let unsigned = 0, signed = 0
  for (let index = 0; index < TAR_BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!
    unsigned += byte
    signed += byte < 0x80 ? byte : byte - 0x100
  }
  return stored === unsigned || stored === signed
}
/** PAX 扩展头（`typeflag` `x`/`g`）的记录流：`"<长度> <键>=<值>\n"` 重复。只取键值，不改任何判据。 */
const paxRecords = (payload: Buffer): Record<string, string> => {
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(payload.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) break
    const record = payload.subarray(space + 1, offset + length).toString('utf8').replace(/\n$/, '')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/**
 * 归档条目名的**静态闸**（U1 的路径穿越门）：只接受"干净的相对路径"。
 *
 * 拒：空名、NUL、反斜杠（Windows 分隔符／歧义）、`/` 开头（绝对路径）、以及任何
 * **空段／`.`／`..`** 段（`a//b`、`./a`、`a/../b`、`../a` 全在内）。
 *
 * ⚠️ **这是纵深防御，不是唯一的那道门**：本模块只按**条目名精确匹配**取一条条目、且从不做路径归一化
 * （归一化正是穿越的入口：`a/../b` 归一化后就成了 `b`）。所以即使这条闸被拿掉，
 * 穿越条目也**匹配不上**目标、更不会被物化。它在的地方是"恶意归档**整份丢弃**"这个判定，
 * 以及"哪天有人往这个解包器上加了批量物化"时的护栏——回执的负对照记的就是这个边界。
 */
export function safeArchiveEntryPath(name: string): string {
  const text = typeof name === 'string' ? name : ''
  const shown = text.slice(0, 120)
  if (!text) throw new Error('POLICY_MIRROR_ARCHIVE_UNSAFE_PATH: 条目名为空')
  if (text.includes('\0')) throw new Error('POLICY_MIRROR_ARCHIVE_UNSAFE_PATH: 条目名里有 NUL')
  if (text.includes('\\')) throw new Error(`POLICY_MIRROR_ARCHIVE_UNSAFE_PATH: 条目名里有反斜杠（跨平台歧义）：${shown}`)
  if (text.startsWith('/')) throw new Error(`POLICY_MIRROR_ARCHIVE_UNSAFE_PATH: 条目名是绝对路径：${shown}`)
  if (text.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error(`POLICY_MIRROR_ARCHIVE_UNSAFE_PATH: 条目名不是干净的相对路径（空段／点段／双点段）：${shown}`)
  return text
}

/**
 * **解析即校验**：一次遍历把 tar 拆成条目，走私和安全判定当场给出结论（没有"先解析、后校验"的窗口）。
 *
 * 安全口径（U10 的三个已知面，逐条落地）：
 *  · **软链**（`2`）／**硬链**（`1`）／其它类型：标记出来，**不跟随、不物化**——软链的 `linkname`
 *    谁都不去读，更不会有人顺着它写到归档外面去；
 *  · **权限位**：只**读**出来记账（`mode`），**不复制**——物化时一律 0600（见 `unpackMirrorArchive`），
 *    可执行位、setuid/setgid 一个都不落地；
 *  · **路径穿越**：任一条目名不过 `safeArchiveEntryPath` ⇒ **整份归档丢弃**（`git archive` 的产物
 *    永远不会出现这种名字，出现即恶意，没有"跳过它继续用别的条目"这种余地）。
 *
 * 头部校验和不符 ⇒ `MALFORMED`（截断／被改写）；PAX 只认 `path` 覆盖，出现 `size` 覆盖则 fail-closed
 * （不静默按头部大小读——那会把布局读歪，后面的条目全是垃圾）。
 */
export function parseTarEntries(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let offset = 0, global: Record<string, string> = {}, pending: Record<string, string> | null = null
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) return entries // 全零块＝归档结束标记
    if (!tarChecksumOk(header, tarNumber(header, 148, 8, '头部校验和'))) throw new Error('POLICY_MIRROR_ARCHIVE_MALFORMED: 头部校验和不符（归档被截断或被改写）')
    const size = tarNumber(header, 124, 12, '条目大小')
    const flag = String.fromCharCode(header[156]!)
    const type: ArchiveEntryType = TAR_TYPE[flag] ?? 'other'
    const prefix = tarText(header, 257, 6).startsWith('ustar') ? tarText(header, 345, 155) : ''
    const payload = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size)
    if (payload.length < size) throw new Error(`POLICY_MIRROR_ARCHIVE_TRUNCATED: 条目声明的 ${size} 字节没有全部到达（只剩 ${payload.length}）`)
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    // PAX 扩展头：改的是**下一个条目**的元数据，不是内容——`path` 用它承载超长路径（git archive 会这么写）。
    if (flag === 'x' || flag === 'g') {
      const records = paxRecords(payload)
      if (flag === 'g') global = { ...global, ...records }
      else pending = records
      continue
    }
    const overrides = { ...global, ...(pending ?? {}) }
    pending = null
    if (overrides.size && Number(overrides.size) !== size) throw new Error('POLICY_MIRROR_ARCHIVE_MALFORMED: 不支持 PAX 的 size 覆盖（按头部大小读会把后面的条目读歪）')
    const named = overrides.path ?? (prefix ? `${prefix}/${tarText(header, 0, 100)}` : tarText(header, 0, 100))
    // 目录条目在 tar 里惯例以 `/` 结尾；去掉**尾部**斜杠再校（中间的空段仍然要拒）。
    const path = safeArchiveEntryPath(type === 'directory' ? named.replace(/\/+$/, '') : named)
    entries.push({ path, type, mode: tarNumber(header, 100, 8, '权限位'), size, payload })
  }
  throw new Error('POLICY_MIRROR_ARCHIVE_TRUNCATED: 归档在结束标记之前就断了（缺少两个全零块）')
}

/** 命中结果：条目 + 它落在哪个顶层目录下（`''`＝归档没有顶层目录，见 `locateArchiveEntry` 的两种形态）。 */
export interface ArchiveMatch { entry: ArchiveEntry; root: string }
/**
 * 在条目表里找**声明的那个文件**。规则是**逐字精确匹配**，不归一化、不按文件名猜：
 *
 *  · 给了 `root`（调用方钉死的顶层目录名）：只认 `<root>/<path>` 这一种拼法；
 *  · 没给：认**两种**归档形态——无顶层目录的 `<path>`，以及**恰好一层**顶层目录的 `<x>/<path>`
 *    （GitHub codeload 就是后者：`{repo}-{sha}/…`；`x` 由条目名自己给出，不是我们猜的）。
 *    两种拼法**同时**命中（或同一形态命中多条）⇒ 判**歧义**并拒——不去挑"哪个更像"。
 *
 * 为什么是"恰好一层"而不是"任意后缀"：多一层就多一次"和别人仓库里同名文件撞上"的机会，
 * 而归档形态里那一层是**约定**、不是内容。判据仍然只有指纹，这里只是把"哪一条条目算命中"说死。
 *
 * 命中多条、命中但**不是普通文件**（软链/硬链/目录），都当场拒——软链那条尤其重要：
 * 若把软链当文件"读出内容"，读的是它指向的东西（那正是穿越）。
 */
export function locateArchiveEntry(entries: ArchiveEntry[], wantedPath: string, root?: string): ArchiveMatch {
  const path = policyFile(wantedPath)
  const depth = path.split('/').length
  const withTopDirectory = (entry: ArchiveEntry) => entry.path.split('/').length === depth + 1 && entry.path.endsWith(`/${path}`)
  const candidates: ArchiveMatch[] = []
  if (root !== undefined) {
    const pinned = safeArchiveEntryPath(root)
    if (pinned.includes('/')) throw new Error(`POLICY_MIRROR_ARCHIVE_ROOT_INVALID: 顶层目录名必须是单段：${pinned.slice(0, 120)}`)
    candidates.push(...entries.filter(entry => entry.path === `${pinned}/${path}`).map(entry => ({ entry, root: pinned })))
  } else {
    candidates.push(...entries.filter(entry => entry.path === path).map(entry => ({ entry, root: '' })))
    candidates.push(...entries.filter(withTopDirectory).map(entry => ({ entry, root: entry.path.slice(0, entry.path.length - path.length - 1) })))
  }
  if (!candidates.length) {
    const tops = [...new Set(entries.map(entry => entry.path.split('/')[0]!))]
    throw new Error([
      `POLICY_MIRROR_ARCHIVE_TARGET_MISSING: 归档里没有 ${path} 这条条目`,
      `  归档条目 ${entries.length} 条；顶层名字 ${tops.length ? tops.slice(0, 4).join('／') : '（无）'}${tops.length > 4 ? ` 等 ${tops.length} 个` : ''}`,
      root === undefined ? '' : `  调用方钉死的顶层目录：${root}`,
      '  匹配是**逐字精确**的（不做归一化、不按文件名猜）——"文件名一样"在任何一环都不构成命中。',
    ].filter(Boolean).join('\n'))
  }
  if (candidates.length > 1) throw new Error(`POLICY_MIRROR_ARCHIVE_TARGET_AMBIGUOUS: 归档里有 ${candidates.length} 条条目都指向 ${path}（${candidates.map(row => row.entry.path).join('／')}）——歧义即拒，不猜`)
  const match = candidates[0]!
  if (match.entry.type !== 'file') throw new Error(`POLICY_MIRROR_ARCHIVE_TARGET_NOT_REGULAR: 归档里 ${match.entry.path} 是 ${match.entry.type}，不是普通文件——软链/硬链不跟随、不物化（这正是 U10 那条）`)
  return match
}

/** 取归档字节与解包的开关。**判据不在这里**——这里只有"怎么拿到字节"和"允许多大"。 */
export interface MirrorArchiveOptions {
  /** 顶层目录名（钉死时只认这一种拼法）；不给＝两种归档形态都认，命中多条即判歧义（见 `locateArchiveEntry`）。 */
  root?: string
  /** 允许的**压缩**归档字节上限（默认 256 MiB）——先卡网络与内存，再谈解压。 */
  maxBytes?: number
  /** 允许的**解压后**字节上限（默认 512 MiB）——gzip 炸弹闸，交给 zlib 的 `maxOutputLength` 硬卡。 */
  maxUncompressedBytes?: number
  /** 归档候选同样要过通用主机纪律（含白名单）——与 blob 候选同一把尺子，不因形态而放宽。 */
  admittedHosts?: string[]
  /**
   * **归档字节自己的 sha256**（内容寻址的钉，出处是 `caller-pin`：上一次核对通过的回执／清单里那一行，
   * 如 G1 的 `545ead52…`）。给了就**逐字核对**收到的归档字节（不符 ⇒ 连同缓存一起拒），
   * 并且它进记忆化的键（见 `MirrorArchiveCache`）——"同一份归档"因此是可判定的，不是猜的。
   */
  expectedSha256?: string
  /**
   * **归档这一跳**的取字节上限（毫秒）。默认 `MIRROR_ARCHIVE_FETCH_TIMEOUT_MS`（30 min）。
   *
   * ⚠️ 这是**唯一**被放宽的一跳：`POLICY_FETCH_TIMEOUT_MS`（30 s）是所有其它跳的默认值，本文件不碰它。
   * 口径仍是 `boundedFetch` 的 `timeoutScope:'attempt'`（**含读正文**）——正是"30 s 连一次都跑不完"
   * 的那条；这里只把这一跳的天花板抬高，不改成"不限时"，也不动重试语义（尝试次数仍是默认 3 次）。
   */
  timeoutMs?: number
  /**
   * 记忆化缓存（**同一个归档 URL 只取一次字节、只解一次包**）：
   *  · 不给：有 `expectedSha256` 时用**模块默认实例**（内容寻址的键 ⇒ 进程内共享是安全的）；没钉则**不缓存**；
   *  · `null`：显式关闭（不想让 150 MB 级解包结果留在内存里时用）；
   *  · 传实例：调用方自己持有（**没钉也能用**，键退化为 URL＋上限 ⇒ 该实例内是"首次见到即记住"，
   *    可信边界随之落在调用方身上——一次取件里 68 件应当共用**同一个**实例，这正是记忆化的用法）。
   */
  cache?: MirrorArchiveCache | null
  /** 取归档字节的接缝（默认＝`boundedFetch` + 逐跳主机纪律）。**测试注入替身用，替身也必须是真 gzip 字节**。 */
  fetch?: (url: string, signal: AbortSignal) => Promise<Buffer>
}

/** 与 `source.ts:52` 的 `headers` 同口径（那份是模块私有量，本文件不重复导出、也不改它）。**只有 UA，没有任何凭据。** */
const mirrorArchiveHeaders = { 'user-agent': 'LyapunovDSH-policy/0.1' }
/** `gunzip` 的 promise 形式：解压走异步路径（不阻塞事件循环），`maxOutputLength` 仍然硬卡。 */
const gunzipAsync = promisify(gunzip)
const MIRROR_ARCHIVE_REDIRECT_LIMIT = 5
export const MIRROR_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024
export const MIRROR_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
/**
 * **归档这一跳**的取字节上限：30 min（`boundedFetch` 的 `timeoutMs` 覆写）。
 *
 * 出处是 G1 那条实测链路：`codeload.github.com/.../tar.gz/276801e4…` = 59,810,743 B ÷ 1400.4 s
 * ≈ 42.7 KB/s，而那次 curl 自己给的上限是 `--max-time 1800`（1800 s）⇒ 这条常量取 1800 s，
 * 与"这条链路真能跑完"的那次读数同口径，且留了约 28% 余量。
 *
 * ⚠️ **这一条是归档这一跳专属**：`POLICY_FETCH_TIMEOUT_MS = 30_000` 是其余所有跳的默认值，
 * **一个字不改**（元数据、建连、逐件下载、重定向、以及所有其它 provider 的重试语义）。
 * 谁把这条常量接到别的跳上，就是这一条纪律的反面——`mirror-archive-memo.test.ts` 的 L 组用例钉着它。
 */
export const MIRROR_ARCHIVE_FETCH_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 模块默认记忆化缓存的容量（份）。每份的常驻内存 ≈ 解压后的 tar（默认上限 512 MiB）
 * ⇒ 最坏 2 × 512 MiB；`resetMirrorArchiveCache()` 可随时清空，`cache: null` 可整条关闭。
 */
export const MIRROR_ARCHIVE_CACHE_CAPACITY = 2

/** 一份**已取到并解开**的归档（记忆化的单位：不是"某个文件的字节"，而是"这份归档的条目表"）。 */
interface MirrorArchiveMaterial {
  /** 压缩字节数（读数用；压缩字节本身不留在缓存里——留着只是白占 60 MB）。 */
  compressedBytes: number
  /** 归档字节自己的 sha256（有钉时与钉逐字相同；它也是缓存键的一部分）。 */
  archiveSha256: string
  uncompressedBytes: number
  entries: ArchiveEntry[]
}

export interface MirrorArchiveCacheStats {
  capacity: number
  size: number
  /** 这个实例真正**取过多少次字节**（命中不算）。 */
  downloads: number
  /** 这个实例真正**解过多少次包**（命中不算）。 */
  unpacks: number
  /** 命中次数（"本该再取一次、再解一次"的那些件）。 */
  hits: number
  /** LRU 淘汰份数。 */
  evictions: number
}

/**
 * **归档记忆化**：把"取字节 + 解压 + 解析"的结果按**内容寻址的键**记住，同一个归档只做一次。
 *
 * 为什么是"整份归档"而不是"某个文件的字节"：一次取件里的 68 件同属一棵树（G1），
 * 归档的条目表对 68 件是**同一份**；按文件缓存只会把同一份解包结果拆成 68 份，等于没省。
 *
 * 键（`mirrorArchiveCacheKey`）＝ URL ＋ 归档 sha256（有钉时）＋ 压缩/解压两个上限。三样都在键里，
 * 是因为三者任一不同，"能复用的东西"就不同：URL 不同是另一棵树；sha 不同是另一份字节；
 * 上限不同意味着这份材料当初是**按另一把尺子**收下的（更宽的尺子不能顶替更严的尺子）。
 *
 * 单飞：值存的是 `Promise` ⇒ 并发调用共用同一次取字节。取消语义如实写在 `loadArchiveMaterial` 上。
 */
export class MirrorArchiveCache {
  #entries = new Map<string, Promise<MirrorArchiveMaterial>>()
  #capacity: number
  #stats = { downloads: 0, unpacks: 0, hits: 0, evictions: 0 }
  constructor(capacity: number = MIRROR_ARCHIVE_CACHE_CAPACITY) {
    this.#capacity = Number.isSafeInteger(capacity) && capacity > 0 ? capacity : 0
  }
  stats(): MirrorArchiveCacheStats {
    return { capacity: this.#capacity, size: this.#entries.size, ...this.#stats }
  }
  /** 清空**条目**（累计计数不动——它们是"这个实例干了多少活"的读数，不是状态）。 */
  clear(): void { this.#entries.clear() }
  /** 命中：顺带把这一条挪到 LRU 队尾（`Map` 的插入序就是 LRU 序）。 */
  lookup(key: string): Promise<MirrorArchiveMaterial> | undefined {
    const hit = this.#entries.get(key)
    if (!hit) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    this.#stats.hits += 1
    return hit
  }
  remember(key: string, material: Promise<MirrorArchiveMaterial>): void {
    if (this.#capacity === 0) return
    this.#entries.set(key, material)
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#entries.delete(oldest)
      this.#stats.evictions += 1
    }
  }
  /** 失败不留在表里（一次瞬时故障不该变成"这个 URL 永久不可用"）。 */
  forget(key: string): void { this.#entries.delete(key) }
  noteDownload(): void { this.#stats.downloads += 1 }
  noteUnpack(): void { this.#stats.unpacks += 1 }
}

/** 模块默认实例：只被**有钉**的调用用到（见 `resolveMirrorArchiveCache`）。 */
const defaultMirrorArchiveCache = new MirrorArchiveCache()
/** 清空模块默认缓存的条目（长会话／用例之间用；累计计数不动）。 */
export function resetMirrorArchiveCache(): void { defaultMirrorArchiveCache.clear() }
/** 模块默认缓存的读数：`downloads`/`unpacks` 是"真取/真解"的次数，`hits` 是省下来的那些件。 */
export function mirrorArchiveCacheStats(): MirrorArchiveCacheStats { return defaultMirrorArchiveCache.stats() }

/** 钉的形状：非 64 位小写 hex ⇒ 当场拒（**不**静默降级成"没有钉"——那会把一次核对悄悄变成不核对）。 */
function requireArchivePin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`POLICY_MIRROR_ARCHIVE_PIN_INVALID: expectedSha256 必须是 64 位小写 hex 的 sha256，收到 ${JSON.stringify(String(value).slice(0, 80))}`)
  return value
}
/** 上限的解析（与 `fetchArchiveBytes` / `unpackMirrorArchive` 用的是同一对默认值，进键时也必须同源）。 */
const archiveLimits = (options: MirrorArchiveOptions) => ({
  maxBytes: options.maxBytes ?? MIRROR_ARCHIVE_MAX_BYTES,
  maxUncompressedBytes: options.maxUncompressedBytes ?? MIRROR_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
})
const mirrorArchiveCacheKey = (url: string, options: MirrorArchiveOptions): string => {
  const { maxBytes, maxUncompressedBytes } = archiveLimits(options)
  return `${url}\u0000bytes=${maxBytes}\u0000uncompressed=${maxUncompressedBytes}\u0000${options.expectedSha256 ? `sha256=${options.expectedSha256}` : 'unpinned'}`
}
/**
 * 用哪个缓存：
 *  · `null` ⇒ 不用；
 *  · 实例 ⇒ 用它（没钉也允许：可信边界归调用方）；
 *  · 不给 ⇒ **有钉**才用模块默认实例（键是内容寻址的，进程内共享安全）；没钉 ⇒ 不用。
 */
const resolveMirrorArchiveCache = (options: MirrorArchiveOptions): MirrorArchiveCache | undefined =>
  options.cache === null ? undefined : options.cache ?? (options.expectedSha256 ? defaultMirrorArchiveCache : undefined)

/**
 * 取归档字节（**不是**取目标文件）：逐跳重过主机纪律 + 有界读 + 计数上限。
 *
 * 三件事与第 1/2 级同口径：**不带任何凭据**（连 `githubHeaders` 都不调——codeload 不是 `api.github.com`，
 * P18 的凭据作用域里没有它）；**逐跳**校验重定向目标（`redirect:'manual'`），
 * 因为"镜像/候选把我们 302 到内网或官方 HF"正是静态闸要拦的形状；有界（`boundedFetch` 的建连超时与重试）。
 *
 * `timeoutMs` 是**这一跳自己的上限**（默认 `MIRROR_ARCHIVE_FETCH_TIMEOUT_MS`＝30 min）——见那条常量的注释：
 * 全局默认（30 s，含读正文）在这条 59.8 MB／1400.4 s 的链路上连一次都跑不完，而**其它跳一律仍然用它**。
 *
 * ── 正文阶段超时的**错误形状**（U4，2026-09-27）─────────────────────────────
 * `boundedFetch` 的 `try/catch` 只包住 `fetch()`（**建连／应答头**）那一步，它返回的 `Response` 的正文
 * 是**在外面**读的（`for await`），而 `timeoutScope` 走默认 `'attempt'` ⇒ 那个 `AbortSignal.timeout(timeoutMs)`
 * **一直挂在 body 上**。于是 abort 落在正文循环里时，抛出来的是一枚**裸 DOMException（`TimeoutError`）**：
 * `trace.attempts` **为空**、没有五要素、也不带任何诊断 —— 用户/模型拿到的就是一句 `The operation timed out.`
 * （`bugfixHistory/ARCHIVE-FETCH-MEMOIZATION-20260926.md` §7 `U4` 如实登记未修）。
 * 现在把**正文循环这一段**纳入 `try/catch`：超时/断流如实转成 `PolicyFetchError`（五要素齐 + `attempts` 非空）。
 * **不改**重试次数（`POLICY_FETCH_ATTEMPTS` 仍是 3，这里也没有新增重试层）、**不改** `timeoutScope` 语义
 * （仍然是"这一次尝试含读正文"上限，字节只要在到就一直收）—— 改的只有**失败记账的形状**。
 * 调用方取消（`signal.aborted`）**照旧原样传播**：不包装、不记账（与既有"取消不重试"同一条纪律）。
 */
async function fetchArchiveBytes(url: string, signal: AbortSignal, options: MirrorArchiveOptions, timeoutMs: number, trace?: PolicyFetchTrace): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MIRROR_ARCHIVE_MAX_BYTES
  let target = url
  for (let hop = 0; ; hop++) {
    mirrorHostPolicy(target, { ...(options.admittedHosts ? { admittedHosts: options.admittedHosts } : {}) })
    const response = await boundedFetch(target, { signal, headers: mirrorArchiveHeaders, redirect: 'manual' }, { step: '建连', trace, timeoutMs })
    const location = response.headers.get('location')
    if (location && [301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= MIRROR_ARCHIVE_REDIRECT_LIMIT) throw new Error(`POLICY_MIRROR_ARCHIVE_REDIRECT_LIMIT: 超过 ${MIRROR_ARCHIVE_REDIRECT_LIMIT} 跳`)
      await response.body?.cancel().catch(() => {})
      target = new URL(location, target).href
      continue
    }
    if (!response.ok) throw new Error(`POLICY_MIRROR_ARCHIVE_${response.status}: 归档端点拒绝了这次请求（${new URL(target).hostname}）`)
    if (!response.body) throw new Error('POLICY_MIRROR_ARCHIVE_BODY_MISSING: 应答没有正文')
    const chunks: Buffer[] = []
    let total = 0
    const started = Date.now()
    try {
      for await (const chunk of response.body) {
        checkCancelled(signal)
        total += chunk.byteLength
        if (total > maxBytes) throw new Error(`POLICY_MIRROR_ARCHIVE_OVERSIZED: 归档超过 ${maxBytes} 字节上限（已收到 ${total}）——先卡住网络与内存，别把整包拉下来再谈解压`)
        chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      }
    } catch (error) {
      // 取消（调用方 signal）**原样传播**：它不是"这一跳失败"，包装成五要素会把取消说成故障。
      if (signal.aborted) throw signal.reason ?? error
      // 归档字节的**计数上限**是判据类失败（不是瞬时故障）：原样抛出，不套五要素（套上会把它说成"重试即可"）。
      if (String((error as Error)?.message ?? '').startsWith('POLICY_MIRROR_ARCHIVE_OVERSIZED')) throw error
      const name = (error as Error)?.name
      const retryable = isTransientFetchFailure(error)
      const stalled = name === 'TimeoutError' || name === 'AbortError'
      const entry: PolicyFetchAttempt = {
        at: new Date().toISOString(), step: '逐件下载', url: target, endpoint: endpointHost(target), attempt: 1,
        ms: Date.now() - started, retryable,
        reason: [
          name && name !== 'Error' ? name : '',
          String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim(),
          stalled ? `（读正文阶段撞上本次尝试的 ${timeoutMs}ms 上限；在此之前已收到 ${total} 字节，归档这一跳的字节只要在到就一直收）` : '',
        ].filter(Boolean).join(' '),
      }
      trace?.attempts.push(entry)
      throw new PolicyFetchError({ url: target, step: '逐件下载', attempts: [entry], retryable, context: trace?.context ?? {} })
    }
    return Buffer.concat(chunks, total)
  }
}

/**
 * **把一份归档变成材料**（取字节 → 核对钉 → 解压 → 解析）：这是记忆化里"只做一次"的那一段。
 *
 * 钉的核对在**解压之前**：先证明"这包字节就是我们要的那份归档"，再花 CPU 去解它——
 * 顺序反过来等于让任何一份来路不明的 gzip 都能先把解压器喂一遍。
 */
async function materializeArchive(url: string, signal: AbortSignal, options: MirrorArchiveOptions, cache: MirrorArchiveCache | undefined, trace?: PolicyFetchTrace): Promise<MirrorArchiveMaterial> {
  const { maxBytes, maxUncompressedBytes } = archiveLimits(options)
  const timeoutMs = options.timeoutMs ?? MIRROR_ARCHIVE_FETCH_TIMEOUT_MS
  // ② 取字节（接缝优先：替身同样要过下面的钉与两道上限）
  const raw = options.fetch ? await options.fetch(url, signal) : await fetchArchiveBytes(url, signal, options, timeoutMs, trace)
  cache?.noteDownload()
  checkCancelled(signal)
  if (raw.length > maxBytes) throw new Error(`POLICY_MIRROR_ARCHIVE_OVERSIZED: 归档 ${raw.length} 字节，超过 ${maxBytes} 上限`)
  const archiveSha256 = createHash('sha256').update(raw).digest('hex')
  if (options.expectedSha256 && archiveSha256 !== options.expectedSha256) throw new Error(`POLICY_MIRROR_ARCHIVE_PIN_MISMATCH: 归档字节与钉不符——期望 sha256 ${options.expectedSha256}，实测 ${archiveSha256}（${url}）`)
  // ③ 解压（gzip 炸弹闸：`maxOutputLength` 由 zlib 硬卡，不靠"解完再看大小"）
  let tar: Buffer
  try {
    tar = await gunzipAsync(raw, { maxOutputLength: maxUncompressedBytes })
  } catch (error) {
    const code = String((error as { code?: string })?.code ?? '')
    if (code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_OUT_OF_RANGE') throw new Error(`POLICY_MIRROR_ARCHIVE_OVERSIZED: 解压超过 ${maxUncompressedBytes} 字节上限（gzip 炸弹／归档真的太大）`)
    throw new Error(`POLICY_MIRROR_ARCHIVE_UNREADABLE: 不是有效的 gzip 字节（${String((error as Error)?.message ?? error).slice(0, 160)}）`)
  }
  if (tar.length > maxUncompressedBytes) throw new Error(`POLICY_MIRROR_ARCHIVE_OVERSIZED: 解压后 ${tar.length} 字节，超过 ${maxUncompressedBytes} 上限`)
  // ④ 解析即校验（穿越/软链/权限位在这一步就有结论）
  const entries = parseTarEntries(tar)
  cache?.noteUnpack()
  return { compressedBytes: raw.length, archiveSha256, uncompressedBytes: tar.length, entries }
}

/**
 * 记忆化的入口：命中就**既不取字节也不解包**；没有就交给 `materializeArchive` 做一次，并记住那一次。
 *
 * 取消语义（如实写清）：存进缓存的是**第一个调用者**发起的那次取字节，它用的是**第一个调用者的 signal**。
 * 于是 ① 后续调用各自的取消**不会**掐断正在共享的那次取字节（它们在自己的 `checkCancelled` 上照常生效）；
 * ② 第一个调用者被取消时，那次失败会同时传给正在等同一份材料的其它调用者（它们随后自然会各自重试）。
 * 单飞换来的是"并发 68 件不会并发下 68 次 60 MB"，代价就是上面这两条——不掩盖。
 */
async function loadArchiveMaterial(url: string, signal: AbortSignal, options: MirrorArchiveOptions, trace?: PolicyFetchTrace): Promise<{ material: MirrorArchiveMaterial; memoized: boolean }> {
  const cache = resolveMirrorArchiveCache(options)
  if (!cache) return { material: await materializeArchive(url, signal, options, undefined, trace), memoized: false }
  const key = mirrorArchiveCacheKey(url, options)
  const hit = cache.lookup(key)
  if (hit) return { material: await hit, memoized: true }
  const pending = materializeArchive(url, signal, options, cache, trace)
  cache.remember(key, pending)
  // 失败不留在表里（一次瞬时故障不该把"这个 URL 永久判死"）；`catch` 同时消掉未处理的 rejection。
  pending.catch(() => cache.forget(key))
  return { material: await pending, memoized: false }
}

/** 解包入参：**判据只有 `declared` 一个出处**，候选只贡献 URL。 */
export interface ArchiveUnpackInput {
  declared: DeclaredIdentity
  candidate: MirrorCandidate
  target: string
  signal: AbortSignal
  trace?: PolicyFetchTrace
  options?: MirrorArchiveOptions
}
export interface ArchiveUnpackReading extends MirrorReading {
  /**
   * 归档这一层的读数（截图式记账）：从哪个 URL 拿的、压了多少、解出多少、多少条目、跳过了什么，
   * 外加四样"这次到底干了多少活"的读数——`archiveSha256`（这包字节自己的摘要，有钉时与钉逐字相同）、
   * `expectedSha256`（调用方钉的期望值；没有＝`null`）、`memoized`（**true＝这份解包结果来自记忆化，
   * 本次没有重新取字节、也没有重新解包**）、`fetchTimeoutMs`（默认取字节路径这一跳的上限；
   * 注入 `fetch` 接缝时它不生效——那种情况下没有 `boundedFetch`，如实标出来）。
   */
  archive: {
    url: string; host: string; compressedBytes: number; uncompressedBytes: number; entries: number; root: string
    skipped: Array<{ path: string; type: string }>
    archiveSha256: string; expectedSha256: string | null; memoized: boolean; fetchTimeoutMs: number
  }
  /** 命中的那一条条目（`mode` 只**记账**，物化时不下传——见 `unpackMirrorArchive`）。 */
  entry: { path: string; mode: number; bytes: number }
}

/**
 * **解包一整仓归档，取出声明的那个文件**（U1）。顺序是刻意的，"判据在哪一步生效"写在每一步上：
 *
 *   1. 判据门（`requireMirrorIdentity`）＋形态门（必须 `shape:'archive'`）＋主机纪律（与 blob 候选同一把尺子）；
 *   2. 取字节（逐跳主机纪律、无凭据、有上限；**这一跳的上限＝`MIRROR_ARCHIVE_FETCH_TIMEOUT_MS`**）；
 *   3. 解压（`maxOutputLength` 硬卡 gzip 炸弹）；
 *   4. **解析即校验**（`parseTarEntries`：穿越/软链/权限位在这一步就有结论）；
 *   5. 命中一条条目（`locateArchiveEntry`：逐字精确、歧义即拒、非普通文件即拒）；
 *   6. **门①**：写 `.part`（0600）→ 与**可信声明**逐字核对（`bytes`＋`sha256`＋`gitBlob`）→ 不符则连 `.part` 一起删掉；
 *   7. `rename` 到目标（原子替换；坏字节永远不会出现在目标路径上）；
 *   8. 门②由调用方（`fetchFromMirrors`）在目标文件上再独立做一遍。
 *
 * ── 记忆化落在哪一段（①，2026-09-27）─────────────────────────────────────────
 * ②③④ 三段（取字节／解压／解析）走 `loadArchiveMaterial`：**同一个归档 URL 只做一次**，其余件直接复用
 * 那份条目表。⑤⑥⑦⑧ **一件也不少**：每一件仍然各自命中、各自写盘、各自过门①、各自过门②
 * —— 省掉的只有"把同一包字节再下一次、再解一次"，判据一步没省。
 *
 * **权限位不来自归档**：一律 `0600`，不 `chmod`、不 `chown`、不复制可执行位/setuid —— 归档里的 `mode` 只读来记账。
 * **软链不跟随**：只物化命中的那**一条**条目，且它必须是普通文件；链接条目连内容都不读。
 */
export async function unpackMirrorArchive(input: ArchiveUnpackInput): Promise<ArchiveUnpackReading> {
  const { identity } = requireMirrorIdentity(input.declared)
  if (input.candidate.shape !== 'archive') throw new Error(`POLICY_MIRROR_ARCHIVE_SHAPE_REQUIRED: ${input.candidate.host} 的候选形态是 ${input.candidate.shape}，不是归档——走错了取字节的路径`)
  const options = input.options ?? {}
  requireArchivePin(options.expectedSha256)
  const url = mirrorHostPolicy(input.candidate.url, { ...(options.admittedHosts ? { admittedHosts: options.admittedHosts } : {}) })
  // ②③④ 取字节 + 解压 + 解析（**记忆化**：同一份归档只做一次；命中时这一段都不做）
  const { material, memoized } = await loadArchiveMaterial(url.href, input.signal, options, input.trace)
  checkCancelled(input.signal)
  // ⑤ 逐字命中
  const match = locateArchiveEntry(material.entries, identity.path, options.root)
  // ⑥ 门①：**写盘之前**先与可信声明核对；不符则连 `.part` 都不留（更不会 rename 成目标文件）
  const part = input.target + '.part'
  await mkdir(dirname(input.target), { recursive: true })
  await rm(part, { force: true })
  await writeFile(part, match.entry.payload, { mode: 0o600 }) // 权限位一律 0600，**不**照抄归档里的 mode
  const reading = await hashFile(part, identity.gitBlob ? identity.bytes : undefined)
  const mismatch = reading.bytes !== identity.bytes ? `字节数不符：声明 ${identity.bytes}，实测 ${reading.bytes}`
    : identity.sha256 && reading.sha256 !== identity.sha256 ? `sha256 不符：声明 ${identity.sha256}，实测 ${reading.sha256}`
      : identity.gitBlob && reading.gitBlob !== identity.gitBlob ? `gitBlob 不符：声明 ${identity.gitBlob}，实测 ${reading.gitBlob ?? '（未算出）'}`
        : null
  if (mismatch) {
    await rm(part, { force: true })
    throw new Error(`POLICY_MIRROR_ARCHIVE_IDENTITY_MISMATCH: 归档里那条条目**名字对上了，内容不是**声明的那份文件——${mismatch}`)
  }
  checkCancelled(input.signal)
  // ⑦ 原子替换：走到这里字节已过门①；门②在 `fetchFromMirrors` 里对**目标文件**再独立做一遍
  await rename(part, input.target)
  return {
    ...reading,
    archive: {
      url: url.href, host: url.hostname.toLowerCase(), compressedBytes: material.compressedBytes, uncompressedBytes: material.uncompressedBytes,
      entries: material.entries.length, root: match.root,
      skipped: material.entries.filter(entry => entry.type !== 'file' && entry.type !== 'directory').map(entry => ({ path: entry.path, type: entry.type })),
      archiveSha256: material.archiveSha256, expectedSha256: options.expectedSha256 ?? null, memoized,
      fetchTimeoutMs: options.timeoutMs ?? MIRROR_ARCHIVE_FETCH_TIMEOUT_MS,
    },
    entry: { path: match.entry.path, mode: match.entry.mode, bytes: match.entry.size },
  }
}
