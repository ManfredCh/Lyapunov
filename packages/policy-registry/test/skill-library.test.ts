/**
 * 技能库读写层（src/skill-library.ts，AGENT_GRAPH_CONTRACT §4）：
 *
 * - 提案 → 验证 → 晋升全链：proposals/ 未准入 → verify passed=true → skills/ 转正 + promotion 字段；
 * - 未验证 / passed=false 的 promote ⇒ SKILL_NOT_VERIFIED 具名拒绝（唯一准入判据）；
 * - promotions.jsonl 只追加：两次晋升 = 两行，内容逐字可解析；
 * - listSkills 只含已准入（promotion 存在）；proposals/ 永不进列表；
 * - 反例：SKILL_PROPOSAL_NOT_FOUND / SKILL_ALREADY_PROMOTED / SKILL_PROPOSAL_EXISTS /
 *   SKILL_AMBIGUOUS / SKILL_PACK_NOT_FOUND / SKILL_ID_INVALID / SKILL_PROPOSAL_INVALID；
 * - 夹具：每次 mkdtemp 一个 packsRoot，只建 packs/<id>/pack.json 骨架，断言真实文件。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, readSkill, recordVerify, promoteSkill, writeProposal, PACK_SKILL_SCHEMA } from '../src/skill-library.ts'
import type { PackSkill, SkillProposal } from '../../lyapunov-contracts/src/agent-graph.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

/** 临时 packsRoot + 一个宿主包骨架（pack.json 只作存在性标记，技能库不读它）。 */
function fixture(packIds: string[] = ['test_arm']) {
  const root = mkdtempSync(join(tmpdir(), 'skill-lib-'))
  roots.push(root)
  for (const id of packIds) {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'pack.json'), JSON.stringify({ packId: id }) + '\n')
  }
  return root
}

const proposal = (skillId: string, packId = 'test_arm'): SkillProposal => ({
  skillId,
  packId,
  failureSignature: { reasonCodes: ['CONTACT_MISSING', 'POSE_OUTSIDE_BOX'], description: '抓取后 contact-exists 不成立' },
  applicableWhen: { robotKinds: ['arm'], taskShape: 'pick-and-place', description: '平行夹爪拾放' },
  fixStrategy: '退回预抓位，二次下压后重新闭合夹爪',
  program: [
    { tool: 'sim_control', input: { kind: 'move', entityId: 'arm' } },
    { tool: 'sim_task_check', input: { worldId: 'w1', expectedGeneration: 1, predicates: { kind: 'contact-exists' } } },
  ],
  devEvidence: { runIds: ['run-dev-1'], checkedAt: '2026-10-22T00:00:00.000Z' },
  author: 'worker-a',
})

const verifyPass = { verifierRunId: 'run-verify-1', reproducedTaskIds: ['task-1', 'task-2'], attempts: 1, passed: true }
const capture = async (run: () => Promise<unknown>): Promise<any> => { try { await run(); return undefined } catch (error) { return error } }

describe('skill-library：提案→验证→晋升全链', () => {
  test('writeProposal 落 proposals/（未准入）→ verify passed → promote 进 skills/ 且 promotions.jsonl 追加', async () => {
    const root = fixture()
    const proposed = await writeProposal(root, proposal('retry-grasp'))
    expect(proposed.schema).toBe(PACK_SKILL_SCHEMA)
    expect(proposed.promotion).toBeUndefined()
    // 未准入：skills/ 无文件，proposals/ 有文件；list 不收提案
    expect(existsSync(join(root, 'test_arm', 'skills', 'retry-grasp.json'))).toBe(false)
    expect(existsSync(join(root, 'test_arm', 'proposals', 'retry-grasp.json'))).toBe(true)
    expect((await listSkills(root, 'test_arm'))[0].skills).toHaveLength(0)

    const record = await recordVerify(root, 'retry-grasp', verifyPass)
    expect(record.packId).toBe('test_arm')
    expect(record.passed).toBe(true)
    expect(existsSync(join(root, 'test_arm', 'proposals', 'retry-grasp.verify.json'))).toBe(true)

    const { skill, promotion } = await promoteSkill(root, 'retry-grasp')
    expect(promotion.skillId).toBe('retry-grasp')
    expect(promotion.packId).toBe('test_arm')
    expect(promotion.verifierRunId).toBe('run-verify-1')
    expect(promotion.reproducedTaskIds).toEqual(['task-1', 'task-2'])
    expect(promotion.attempts).toBe(1)
    expect(typeof promotion.promotedAt).toBe('string')
    expect(skill.promotion).toEqual(promotion)
    expect(skill.proposal.skillId).toBe('retry-grasp')

    // 转正 = 移动：proposals/ 两文件都被清掉，skills/ 出现完整 PackSkill
    expect(existsSync(join(root, 'test_arm', 'proposals', 'retry-grasp.json'))).toBe(false)
    expect(existsSync(join(root, 'test_arm', 'proposals', 'retry-grasp.verify.json'))).toBe(false)
    const onDisk = JSON.parse(readFileSync(join(root, 'test_arm', 'skills', 'retry-grasp.json'), 'utf8'))
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(skill)))

    // 账本：一行一个 SkillPromotion，JSON 可往返
    const ledger = readFileSync(join(root, 'test_arm', 'skills', 'promotions.jsonl'), 'utf8').trim().split('\n')
    expect(ledger).toHaveLength(1)
    expect(JSON.parse(ledger[0])).toEqual(promotion)

    // 列表现在含且只含这条已准入技能
    const listed = await listSkills(root, 'test_arm')
    expect(listed[0].skills.map((s) => s.proposal.skillId)).toEqual(['retry-grasp'])
    const got = await readSkill(root, 'test_arm', 'retry-grasp')
    expect(got.promotion?.verifierRunId).toBe('run-verify-1')
  })

  test('两次晋升 = promotions.jsonl 两行追加（旧行不被重写）', async () => {
    const root = fixture()
    for (const [id, verifierRunId] of [['skill-a', 'run-v-a'], ['skill-b', 'run-v-b']] as const) {
      await writeProposal(root, proposal(id))
      await recordVerify(root, id, { ...verifyPass, verifierRunId })
      await promoteSkill(root, id)
    }
    const lines = readFileSync(join(root, 'test_arm', 'skills', 'promotions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line).skillId)).toEqual(['skill-a', 'skill-b'])
    expect(lines.map((line) => JSON.parse(line).verifierRunId)).toEqual(['run-v-a', 'run-v-b'])
  })

  test('原子写不残留临时文件', async () => {
    const root = fixture()
    await writeProposal(root, proposal('tmp-check'))
    await recordVerify(root, 'tmp-check', verifyPass)
    await promoteSkill(root, 'tmp-check')
    for (const dir of [join(root, 'test_arm', 'skills'), join(root, 'test_arm', 'proposals')]) {
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length).toBe(0)
    }
  })
})

describe('skill-library：准入判据（未验证具名拒绝）', () => {
  test('无 verify 记录 promote ⇒ SKILL_NOT_VERIFIED，不产生 skills/ 文件与账本行', async () => {
    const root = fixture()
    await writeProposal(root, proposal('unverified'))
    const error = await capture(() => promoteSkill(root, 'unverified'))
    expect(error?.code).toBe('SKILL_NOT_VERIFIED')
    expect(existsSync(join(root, 'test_arm', 'skills'))).toBe(false)
  })

  test('passed=false 的 verify 记录同样拒绝，且不消耗提案（可重新验证后再晋升）', async () => {
    const root = fixture()
    await writeProposal(root, proposal('flaky'))
    await recordVerify(root, 'flaky', { ...verifyPass, passed: false, attempts: 2 })
    const error = await capture(() => promoteSkill(root, 'flaky'))
    expect(error?.code).toBe('SKILL_NOT_VERIFIED')
    expect(String(error?.message)).toContain('passed=false')
    // 提案仍在：记录新的通过记录后可以晋升（最新记录为准）
    await recordVerify(root, 'flaky', { ...verifyPass, verifierRunId: 'run-verify-2', attempts: 2 })
    const { promotion } = await promoteSkill(root, 'flaky')
    expect(promotion.verifierRunId).toBe('run-verify-2')
    expect(promotion.attempts).toBe(2)
  })

  test('verify/promote 找不到提案 ⇒ SKILL_PROPOSAL_NOT_FOUND；已晋升 ⇒ SKILL_ALREADY_PROMOTED', async () => {
    const root = fixture()
    expect((await capture(() => recordVerify(root, 'ghost', verifyPass)))?.code).toBe('SKILL_PROPOSAL_NOT_FOUND')
    expect((await capture(() => promoteSkill(root, 'ghost')))?.code).toBe('SKILL_PROPOSAL_NOT_FOUND')
    await writeProposal(root, proposal('done-skill'))
    await recordVerify(root, 'done-skill', verifyPass)
    await promoteSkill(root, 'done-skill')
    expect((await capture(() => promoteSkill(root, 'done-skill')))?.code).toBe('SKILL_ALREADY_PROMOTED')
    expect((await capture(() => recordVerify(root, 'done-skill', verifyPass)))?.code).toBe('SKILL_ALREADY_PROMOTED')
    expect((await capture(() => writeProposal(root, proposal('done-skill'))))?.code).toBe('SKILL_ALREADY_PROMOTED')
  })

  test('同名提案不覆盖 ⇒ SKILL_PROPOSAL_EXISTS；同 skillId 跨包 ⇒ SKILL_AMBIGUOUS（显式 packId 可解）', async () => {
    const root = fixture(['pack_a', 'pack_b'])
    await writeProposal(root, proposal('dup', 'pack_a'))
    expect((await capture(() => writeProposal(root, proposal('dup', 'pack_a'))))?.code).toBe('SKILL_PROPOSAL_EXISTS')
    await writeProposal(root, proposal('dup', 'pack_b'))
    expect((await capture(() => recordVerify(root, 'dup', verifyPass)))?.code).toBe('SKILL_AMBIGUOUS')
    await recordVerify(root, 'dup', verifyPass, 'pack_a')
    const { promotion } = await promoteSkill(root, 'dup', 'pack_a')
    expect(promotion.packId).toBe('pack_a')
    // pack_b 的同名提案未被波及
    expect(existsSync(join(root, 'pack_b', 'proposals', 'dup.json'))).toBe(true)
    expect(existsSync(join(root, 'pack_b', 'skills', 'dup.json'))).toBe(false)
  })
})

describe('skill-library：读面与输入校验', () => {
  test('listSkills 无 packId 扫全部包且只含已准入；包不存在 ⇒ SKILL_PACK_NOT_FOUND', async () => {
    const root = fixture(['pack_a', 'pack_b'])
    await writeProposal(root, proposal('s1', 'pack_a'))
    await recordVerify(root, 's1', verifyPass, 'pack_a')
    await promoteSkill(root, 's1', 'pack_a')
    await writeProposal(root, proposal('s2', 'pack_b')) // 未晋升，不进列表
    const packs = await listSkills(root)
    expect(packs.map((p) => p.packId)).toEqual(['pack_a', 'pack_b'])
    expect(packs[0].skills.map((s) => s.proposal.skillId)).toEqual(['s1'])
    expect(packs[1].skills).toEqual([])
    expect((await capture(() => listSkills(root, 'no_such_pack')))?.code).toBe('SKILL_PACK_NOT_FOUND')
    expect((await capture(() => readSkill(root, 'no_such_pack', 's1')))?.code).toBe('SKILL_PACK_NOT_FOUND')
    expect((await capture(() => readSkill(root, 'pack_a', 'missing')))?.code).toBe('SKILL_NOT_FOUND')
  })

  test('skills/ 中 promotion 缺省的文件不进已准入列表（外部放入的未准入件如实不算）', async () => {
    const root = fixture()
    mkdirSync(join(root, 'test_arm', 'skills'), { recursive: true })
    const unadmitted: PackSkill = { schema: PACK_SKILL_SCHEMA, proposal: proposal('dropped-in') }
    writeFileSync(join(root, 'test_arm', 'skills', 'dropped-in.json'), JSON.stringify(unadmitted) + '\n')
    expect((await listSkills(root, 'test_arm'))[0].skills).toHaveLength(0)
    // get 仍读得到，但 admitted 由调用面按 promotion 判定
    expect((await readSkill(root, 'test_arm', 'dropped-in')).promotion).toBeUndefined()
  })

  test('id 非法（路径逃逸字符）⇒ SKILL_ID_INVALID；提案形状缺字段 ⇒ SKILL_PROPOSAL_INVALID', async () => {
    const root = fixture()
    expect((await capture(() => writeProposal(root, proposal('../escape'))))?.code).toBe('SKILL_ID_INVALID')
    expect((await capture(() => recordVerify(root, '../escape', verifyPass)))?.code).toBe('SKILL_ID_INVALID')
    const incomplete = { ...proposal('bad'), program: 'not-an-array' } as unknown as SkillProposal
    const error = await capture(() => writeProposal(root, incomplete))
    expect(error?.code).toBe('SKILL_PROPOSAL_INVALID')
    expect((await capture(() => writeProposal(root, proposal('nopack', 'missing_pack'))))?.code).toBe('SKILL_PACK_NOT_FOUND')
    // 验证入参本身也要过校验
    const badVerify = await capture(async () => {
      await writeProposal(root, proposal('v1'))
      await recordVerify(root, 'v1', { verifierRunId: '', reproducedTaskIds: [], attempts: 0, passed: true })
    })
    expect(badVerify?.code).toBe('SKILL_VERIFY_INVALID')
  })
})
