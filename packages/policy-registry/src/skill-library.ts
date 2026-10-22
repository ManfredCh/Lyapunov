/**
 * packs 技能库读写层（docs/AGENT_GRAPH_CONTRACT.md §4，Agent C 交付）。
 *
 * 目录约定（packsRoot = 产品安装根的 packs/；测试注入临时目录）：
 *
 *   packs/<packId>/skills/<skillId>.json    已准入技能（PackSkill，schema `lyapunov-pack-skill/1`，promotion 必填）
 *   packs/<packId>/skills/promotions.jsonl  晋升账本（每行一个 SkillPromotion，只追加）
 *   packs/<packId>/proposals/<skillId>.json        未准入提案（PackSkill，promotion 缺省）——不直接进 skills/
 *   packs/<packId>/proposals/<skillId>.verify.json 最近一次验证记录（SkillVerifyRecord，passed=true 才允许 promote）
 *
 * 准入判据只有一条：该提案的 verify 记录存在且 passed===true。promote 把提案从 proposals/ **转正（移动）**
 * 进 skills/、写入 promotion 字段、向 promotions.jsonl 追加一行。未验证/未通过 ⇒ SKILL_NOT_VERIFIED。
 * 全部持久化对象 JSON 可往返；写文件一律 临时文件+rename 原子落盘，promotions.jsonl 单行追加。
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PackSkill, SkillPromotion, SkillProposal } from '../../lyapunov-contracts/src/agent-graph.ts'

export const PACK_SKILL_SCHEMA = 'lyapunov-pack-skill/1' as const

/** 与 pack-source.ts 的 packError 同纪律：Error 上挂具名 code，工具面原样上抛不吞不译。 */
export interface SkillError extends Error { code: string }
export const skillError = (code: string, detail?: string): SkillError => {
  const error = new Error(detail ? `${code}: ${detail}` : code) as SkillError
  error.code = code
  return error
}

/** 最近一次验证记录（proposals/<skillId>.verify.json 的内容）。不入冻结契约——它不是 PackSkill 的字段。 */
export interface SkillVerifyRecord {
  skillId: string
  packId: string
  verifierRunId: string
  reproducedTaskIds: string[]
  attempts: number
  passed: boolean
  recordedAt: string
}

/** skill_verify_record 工具入参（契约 §4 冻结字段）。 */
export interface SkillVerifyInput {
  verifierRunId: string
  reproducedTaskIds: string[]
  attempts: number
  passed: boolean
}

/** 文件名片段：packId/skillId 只允许安全字符，杜绝路径逃逸。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const checkId = (kind: 'packId' | 'skillId', value: unknown): string => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw skillError('SKILL_ID_INVALID', `${kind} 需为非空标识符（[A-Za-z0-9_.-]，首字符字母或数字），实得 ${JSON.stringify(value)}`)
  return value
}

const packDir = (root: string, packId: string) => join(root, checkId('packId', packId))
const skillsDir = (root: string, packId: string) => join(packDir(root, packId), 'skills')
const proposalsDir = (root: string, packId: string) => join(packDir(root, packId), 'proposals')
const skillPath = (root: string, packId: string, skillId: string) => join(skillsDir(root, packId), checkId('skillId', skillId) + '.json')
const proposalPath = (root: string, packId: string, skillId: string) => join(proposalsDir(root, packId), checkId('skillId', skillId) + '.json')
const verifyPath = (root: string, packId: string, skillId: string) => join(proposalsDir(root, packId), checkId('skillId', skillId) + '.verify.json')
const promotionsPath = (root: string, packId: string) => join(skillsDir(root, packId), 'promotions.jsonl')

const isDirectory = async (path: string) => { try { return (await stat(path)).isDirectory() } catch { return false } }
const fileExists = async (path: string) => { try { return (await stat(path)).isFile() } catch { return false } }
const readJson = async <T>(path: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return undefined }
}
/** 原子写：同目录临时文件 + rename。读者永远看到完整 JSON 或看不到文件。 */
const writeJsonAtomic = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await rename(tmp, path)
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const isPackSkill = (value: unknown): value is PackSkill =>
  isRecord(value) && value.schema === PACK_SKILL_SCHEMA && isRecord(value.proposal) && typeof value.proposal.skillId === 'string'

/** 契约形状的浅校验（工具 JSON 边界）：字段缺失/类型不符 ⇒ SKILL_PROPOSAL_INVALID，不猜不补默认。
 *  取字段一律 `isRecord(x) ? x : bad(...)` 三元式——按构造收窄，不依赖 if 后 never-call 收窄。 */
const checkProposal = (value: unknown): SkillProposal => {
  const bad = (detail: string): never => { throw skillError('SKILL_PROPOSAL_INVALID', detail) }
  const obj = isRecord(value) ? value : bad('proposal 需为对象')
  checkId('skillId', obj.skillId)
  checkId('packId', obj.packId)
  const sig = isRecord(obj.failureSignature) ? obj.failureSignature : bad('proposal.failureSignature 需为对象')
  if (!Array.isArray(sig.reasonCodes) || !sig.reasonCodes.every((c) => typeof c === 'string') || typeof sig.description !== 'string') bad('proposal.failureSignature 需含 reasonCodes:string[] 与 description:string')
  const when = isRecord(obj.applicableWhen) ? obj.applicableWhen : bad('proposal.applicableWhen 需为对象')
  if (typeof when.description !== 'string') bad('proposal.applicableWhen 需含 description:string')
  if (when.robotKinds !== undefined && (!Array.isArray(when.robotKinds) || !when.robotKinds.every((k) => typeof k === 'string'))) bad('proposal.applicableWhen.robotKinds 需为 string[]')
  if (when.taskShape !== undefined && typeof when.taskShape !== 'string') bad('proposal.applicableWhen.taskShape 需为 string')
  if (typeof obj.fixStrategy !== 'string') bad('proposal.fixStrategy 需为 string')
  if (!Array.isArray(obj.program) || !obj.program.every((step) => isRecord(step) && typeof step.tool === 'string' && isRecord(step.input))) bad('proposal.program 需为 {tool:string,input:object}[]')
  const dev = isRecord(obj.devEvidence) ? obj.devEvidence : bad('proposal.devEvidence 需为对象')
  if (!Array.isArray(dev.runIds) || !dev.runIds.every((r) => typeof r === 'string') || typeof dev.checkedAt !== 'string') bad('proposal.devEvidence 需含 runIds:string[] 与 checkedAt:string')
  if (obj.author !== undefined && typeof obj.author !== 'string') bad('proposal.author 需为 string')
  return obj as SkillProposal
}

const checkVerify = (value: unknown): SkillVerifyInput => {
  const bad = (detail: string): never => { throw skillError('SKILL_VERIFY_INVALID', detail) }
  const obj = isRecord(value) ? value : bad('验证入参需为对象')
  if (typeof obj.verifierRunId !== 'string' || !obj.verifierRunId) bad('verifierRunId 需为非空 string')
  if (!Array.isArray(obj.reproducedTaskIds) || !obj.reproducedTaskIds.every((t) => typeof t === 'string')) bad('reproducedTaskIds 需为 string[]')
  if (!Number.isInteger(obj.attempts) || (obj.attempts as number) < 1) bad('attempts 需为正整数')
  if (typeof obj.passed !== 'boolean') bad('passed 需为 boolean')
  return obj as SkillVerifyInput
}

/** 在 packsRoot 下定位 skillId 的提案文件：packId 显式给定时只查该包；否则全量扫描，多包命中 ⇒ SKILL_AMBIGUOUS。 */
async function locateProposal(packsRoot: string, skillId: string, packId?: string): Promise<{ packId: string; path: string } | undefined> {
  checkId('skillId', skillId)
  if (packId !== undefined) {
    const path = proposalPath(packsRoot, packId, skillId)
    return (await fileExists(path)) ? { packId: checkId('packId', packId), path } : undefined
  }
  const hits: { packId: string; path: string }[] = []
  for (const id of await listPackIds(packsRoot)) {
    const path = proposalPath(packsRoot, id, skillId)
    if (await fileExists(path)) hits.push({ packId: id, path })
  }
  if (hits.length > 1) throw skillError('SKILL_AMBIGUOUS', `skillId=${skillId} 在多个包中均有提案（${hits.map((h) => h.packId).join('、')}），请显式给 packId`)
  return hits[0]
}

const listPackIds = async (packsRoot: string): Promise<string[]> => {
  try {
    return (await readdir(packsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch { return [] }
}

/** 已晋升过（skills/ 里已有同名文件）的判定：显式 packId 查单包，否则全扫。 */
async function alreadyPromoted(packsRoot: string, skillId: string, packId?: string): Promise<boolean> {
  if (packId !== undefined) return fileExists(skillPath(packsRoot, packId, skillId))
  for (const id of await listPackIds(packsRoot)) if (await fileExists(skillPath(packsRoot, id, skillId))) return true
  return false
}

/**
 * 列已准入技能。packId 缺省 = 扫全部包；显式给定时包目录不存在 ⇒ SKILL_PACK_NOT_FOUND，
 * 包存在而无 skills/ ⇒ 空列表（不是错误）。只收 `promotion` 存在的 PackSkill（准入判据的唯一出口）。
 */
export async function listSkills(packsRoot: string, packId?: string): Promise<{ packId: string; skills: PackSkill[] }[]> {
  const root = resolve(packsRoot)
  if (packId !== undefined && !(await isDirectory(packDir(root, packId)))) throw skillError('SKILL_PACK_NOT_FOUND', `packs/ 下无 ${packId}`)
  const ids = packId !== undefined ? [checkId('packId', packId)] : await listPackIds(root)
  const out: { packId: string; skills: PackSkill[] }[] = []
  for (const id of ids) {
    const dir = skillsDir(root, id)
    const names = await readdir(dir).catch(() => [] as string[])
    const skills: PackSkill[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const parsed = await readJson<PackSkill>(join(dir, name))
      if (isPackSkill(parsed) && parsed.promotion !== undefined) skills.push(JSON.parse(JSON.stringify(parsed)))
    }
    out.push({ packId: id, skills })
  }
  return out
}

/** 读单个已准入/候选技能文件（skills/<skillId>.json）。不存在或形状非法 ⇒ SKILL_NOT_FOUND。 */
export async function readSkill(packsRoot: string, packId: string, skillId: string): Promise<PackSkill> {
  const root = resolve(packsRoot)
  if (!(await isDirectory(packDir(root, packId)))) throw skillError('SKILL_PACK_NOT_FOUND', `packs/ 下无 ${packId}`)
  const parsed = await readJson<PackSkill>(skillPath(root, packId, skillId))
  if (!isPackSkill(parsed)) throw skillError('SKILL_NOT_FOUND', `packs/${packId}/skills/${skillId}.json 不存在或不可解析`)
  return JSON.parse(JSON.stringify(parsed))
}

/**
 * 写提案为**未准入** PackSkill（promotion 缺省）到 proposals/<skillId>.json，绝不直接进 skills/。
 * 包目录必须存在；已晋升同名技能 ⇒ SKILL_ALREADY_PROMOTED；已有同名提案 ⇒ SKILL_PROPOSAL_EXISTS。
 */
export async function writeProposal(packsRoot: string, proposal: SkillProposal): Promise<PackSkill> {
  const root = resolve(packsRoot)
  const checked = checkProposal(proposal)
  const { packId, skillId } = checked
  if (!(await isDirectory(packDir(root, packId)))) throw skillError('SKILL_PACK_NOT_FOUND', `packs/ 下无 ${packId}，提案必须有宿主包`)
  if (await fileExists(skillPath(root, packId, skillId))) throw skillError('SKILL_ALREADY_PROMOTED', `${packId}/${skillId} 已在 skills/ 中`)
  const path = proposalPath(root, packId, skillId)
  if (await fileExists(path)) throw skillError('SKILL_PROPOSAL_EXISTS', `${packId}/${skillId} 已有待审提案，不覆盖`)
  const skill: PackSkill = { schema: PACK_SKILL_SCHEMA, proposal: JSON.parse(JSON.stringify(checked)) }
  await writeJsonAtomic(path, skill)
  return skill
}

/** 记录一次验证结果（覆盖写 proposals/<skillId>.verify.json）。提案不存在 ⇒ SKILL_PROPOSAL_NOT_FOUND。 */
export async function recordVerify(packsRoot: string, skillId: string, input: SkillVerifyInput, packId?: string): Promise<SkillVerifyRecord> {
  const root = resolve(packsRoot)
  const checked = checkVerify(input)
  const located = await locateProposal(root, skillId, packId)
  if (!located) {
    if (await alreadyPromoted(root, skillId, packId)) throw skillError('SKILL_ALREADY_PROMOTED', `${skillId} 已准入，不再接受验证记录`)
    throw skillError('SKILL_PROPOSAL_NOT_FOUND', `无 skillId=${skillId} 的待审提案`)
  }
  const record: SkillVerifyRecord = { skillId, packId: located.packId, ...JSON.parse(JSON.stringify(checked)), recordedAt: new Date().toISOString() }
  await writeJsonAtomic(verifyPath(root, located.packId, skillId), record)
  return record
}

/**
 * 晋升：verify 记录 passed===true 是把提案转正的唯一判据，缺记录/未通过 ⇒ SKILL_NOT_VERIFIED。
 * 顺序：原子写 skills/<skillId>.json（带 promotion）→ promotions.jsonl 追加一行 → 移除提案与 verify 文件。
 * skills/ 已有同名文件 ⇒ SKILL_ALREADY_PROMOTED（账本只追加，绝不重写历史行）。
 */
export async function promoteSkill(packsRoot: string, skillId: string, packId?: string): Promise<{ skill: PackSkill; promotion: SkillPromotion }> {
  const root = resolve(packsRoot)
  const located = await locateProposal(root, skillId, packId)
  if (!located) {
    if (await alreadyPromoted(root, skillId, packId)) throw skillError('SKILL_ALREADY_PROMOTED', `${skillId} 已在 skills/ 中`)
    throw skillError('SKILL_PROPOSAL_NOT_FOUND', `无 skillId=${skillId} 的待审提案`)
  }
  const record = await readJson<SkillVerifyRecord>(verifyPath(root, located.packId, skillId))
  if (!record || record.passed !== true) {
    throw skillError('SKILL_NOT_VERIFIED', record
      ? `${skillId} 最近一次验证 passed=false（verifierRunId=${record.verifierRunId}），拒绝准入`
      : `${skillId} 无验证记录，拒绝准入（先 skill_verify_record passed=true）`)
  }
  const proposal = await readJson<PackSkill>(located.path)
  if (!isPackSkill(proposal)) throw skillError('SKILL_PROPOSAL_INVALID', `${located.path} 不可解析`)
  if (proposal.proposal.devEvidence.runIds.includes(record.verifierRunId)) {
    throw skillError('SKILL_NOT_VERIFIED', `${skillId} 的 verifierRunId=${record.verifierRunId} 与 proposer devEvidence.runIds 重合，拒绝自审准入`)
  }
  const promotion: SkillPromotion = {
    skillId,
    packId: located.packId,
    verifierRunId: record.verifierRunId,
    reproducedTaskIds: [...record.reproducedTaskIds],
    attempts: record.attempts,
    promotedAt: new Date().toISOString(),
  }
  const skill: PackSkill = { ...proposal, promotion }
  await writeJsonAtomic(skillPath(root, located.packId, skillId), skill)
  await mkdir(skillsDir(root, located.packId), { recursive: true })
  await appendFile(promotionsPath(root, located.packId), JSON.stringify(promotion) + '\n')
  await rm(located.path, { force: true })
  await rm(verifyPath(root, located.packId, skillId), { force: true })
  return { skill: JSON.parse(JSON.stringify(skill)), promotion }
}
