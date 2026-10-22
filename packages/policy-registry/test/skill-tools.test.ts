/**
 * 技能库工具面（src/skill-tools.ts，AGENT_GRAPH_CONTRACT §4 冻结名）：
 *
 * - applySkillTools 注册五个冻结名工具 + 同名 commands；
 * - 工具入口全链：skill_propose → pack_skill_list（未准入不列）→ skill_verify_record →
 *   skill_promote → pack_skill_list/get 命中；
 * - 错误码经工具边界原样上抛（SKILL_NOT_VERIFIED 等，error.code 可断言）；
 * - 入参形状：{input:对象}、{input:JSON字符串}、flat 对象（compatibleToolInput）三路等价；
 * - commands 入口：rawInput JSON 解析、kind:'success'/'error' 回执；
 * - ctx 桩沿用 pack-plugin.test.ts 的最小面（tools.register / commands.register）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySkillTools } from '../src/skill-tools.ts'
import type { SkillProposal } from '../../lyapunov-contracts/src/agent-graph.ts'

const FROZEN_NAMES = ['pack_skill_list', 'pack_skill_get', 'skill_propose', 'skill_verify_record', 'skill_promote']

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function packsRoot() {
  const root = mkdtempSync(join(tmpdir(), 'skill-tools-'))
  roots.push(root)
  mkdirSync(join(root, 'test_arm'), { recursive: true })
  writeFileSync(join(root, 'test_arm', 'pack.json'), JSON.stringify({ packId: 'test_arm' }) + '\n')
  return root
}

/** 最小 ctx 桩：只装 applySkillTools 用到的 tools/commands 注册面。 */
function boot(root = packsRoot()) {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const ctx = {
    tools: { register: (tool: any) => void tools.set(tool.name, tool) },
    commands: { register: (command: any) => void commands.set(command.name, command) },
  }
  applySkillTools(ctx as any, { packsRoot: root })
  const exec = { agent: { id: 'test-agent' }, signal: new AbortController().signal }
  const call = (name: string, input: Record<string, unknown>) => tools.get(name)!.execute({ input }, exec as any)
  const callFlat = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, exec as any)
  const invoke = async (name: string, rawInput: string) => commands.get(name)!.handler({ rawInput, agent: { id: 'test-agent' } })
  return { tools, commands, call, callFlat, invoke, root }
}

const proposal = (skillId: string): SkillProposal => ({
  skillId,
  packId: 'test_arm',
  failureSignature: { reasonCodes: ['CONTACT_MISSING'], description: '抓取滑脱' },
  applicableWhen: { robotKinds: ['arm'], description: '平行夹爪' },
  fixStrategy: '二次下压重抓',
  program: [{ tool: 'sim_task_check', input: { worldId: 'w', expectedGeneration: 1, predicates: { kind: 'contact-exists' } } }],
  devEvidence: { runIds: ['run-1'], checkedAt: '2026-10-22T00:00:00.000Z' },
})

const capture = async (run: () => Promise<unknown>): Promise<any> => { try { await run(); return undefined } catch (error) { return error } }

describe('skill-tools：注册面', () => {
  test('五个冻结名工具与同名 commands 全部注册', () => {
    const { tools, commands } = boot()
    for (const name of FROZEN_NAMES) {
      expect(tools.has(name)).toBe(true)
      expect(commands.has(name)).toBe(true)
      expect(typeof tools.get(name).execute).toBe('function')
      expect(typeof commands.get(name).handler).toBe('function')
    }
    expect(tools.size).toBe(FROZEN_NAMES.length)
  })
})

describe('skill-tools：工具入口全链', () => {
  test('propose → verify → promote → list/get，提案期不入列表', async () => {
    const { call } = boot()

    const proposed = await call('skill_propose', { packId: 'test_arm', proposal: proposal('retry-grasp') })
    expect(proposed.status).toBe('PROPOSED')
    expect(proposed.admitted).toBe(false)
    expect(proposed.path).toBe('packs/test_arm/proposals/retry-grasp.json')

    const before = await call('pack_skill_list', { packId: 'test_arm' })
    expect(before.status).toBe('LISTED')
    expect(before.total).toBe(0)

    const verified = await call('skill_verify_record', {
      skillId: 'retry-grasp', verifierRunId: 'run-v-9', reproducedTaskIds: ['task-9'], attempts: 1, passed: true,
    })
    expect(verified.status).toBe('VERIFICATION_RECORDED')
    expect(verified.record.packId).toBe('test_arm')

    const promoted = await call('skill_promote', { skillId: 'retry-grasp' })
    expect(promoted.status).toBe('PROMOTED')
    expect(promoted.path).toBe('packs/test_arm/skills/retry-grasp.json')
    expect(promoted.promotion.verifierRunId).toBe('run-v-9')
    expect(promoted.skill.schema).toBe('lyapunov-pack-skill/1')

    const after = await call('pack_skill_list', { packId: 'test_arm' })
    expect(after.total).toBe(1)
    expect(after.packs[0].skills[0].proposal.skillId).toBe('retry-grasp')

    const got = await call('pack_skill_get', { packId: 'test_arm', skillId: 'retry-grasp' })
    expect(got.status).toBe('FOUND')
    expect(got.admitted).toBe(true)
    expect(got.skill.promotion.promotedAt).toBe(promoted.promotion.promotedAt)
  })

  test('未验证 promote 经工具边界 ⇒ SKILL_NOT_VERIFIED 具名 code 上抛', async () => {
    const { call } = boot()
    await call('skill_propose', { packId: 'test_arm', proposal: proposal('raw') })
    const error = await capture(() => call('skill_promote', { skillId: 'raw' }))
    expect(error?.code).toBe('SKILL_NOT_VERIFIED')
    expect(String(error?.message)).toContain('SKILL_NOT_VERIFIED')
  })

  test('错误码一律上抛：SKILL_NOT_FOUND / SKILL_PACK_NOT_FOUND / SKILL_PACK_MISMATCH', async () => {
    const { call } = boot()
    expect((await capture(() => call('pack_skill_get', { packId: 'test_arm', skillId: 'none' })))?.code).toBe('SKILL_NOT_FOUND')
    expect((await capture(() => call('pack_skill_list', { packId: 'no_pack' })))?.code).toBe('SKILL_PACK_NOT_FOUND')
    expect((await capture(() => call('skill_propose', { packId: 'test_arm', proposal: { ...proposal('x'), packId: 'other_pack' } })))?.code).toBe('SKILL_PACK_MISMATCH')
  })

  test('入参三路等价：{input:对象} / {input:JSON字符串} / flat 对象', async () => {
    const { call, callFlat, tools } = boot()
    const exec = { agent: { id: 'test-agent' }, signal: new AbortController().signal }
    const asString = await tools.get('pack_skill_list')!.execute({ input: JSON.stringify({ packId: 'test_arm' }) }, exec as any)
    const asObject = await call('pack_skill_list', { packId: 'test_arm' })
    const asFlat = await callFlat('pack_skill_list', { packId: 'test_arm' })
    expect(asString).toEqual(asObject)
    expect(asFlat).toEqual(asObject)

    // 提案也可用 flat 写法直达（compatibleToolInput 包一层 input）
    const flatProposed = await callFlat('skill_propose', { packId: 'test_arm', proposal: proposal('flat-skill') })
    expect(flatProposed.status).toBe('PROPOSED')
  })

  test('账本落盘：promote 后 promotions.jsonl 一行，proposals/ 清空', async () => {
    const { call, root } = boot()
    await call('skill_propose', { packId: 'test_arm', proposal: proposal('ledger-skill') })
    await call('skill_verify_record', { skillId: 'ledger-skill', verifierRunId: 'rv', reproducedTaskIds: [], attempts: 1, passed: true })
    await call('skill_promote', { skillId: 'ledger-skill' })
    const ledger = readFileSync(join(root, 'test_arm', 'skills', 'promotions.jsonl'), 'utf8').trim().split('\n')
    expect(ledger).toHaveLength(1)
    expect(JSON.parse(ledger[0]).skillId).toBe('ledger-skill')
    expect(existsSync(join(root, 'test_arm', 'proposals', 'ledger-skill.json'))).toBe(false)
  })
})

describe('skill-tools：commands 入口', () => {
  test('rawInput JSON → kind:success；错误 → kind:error 保留具名码', async () => {
    const { invoke } = boot()
    const listed = await invoke('pack_skill_list', JSON.stringify({ packId: 'test_arm' }))
    expect(listed.kind).toBe('success')
    expect(JSON.parse(listed.text).status).toBe('LISTED')

    const bad = await invoke('pack_skill_get', JSON.stringify({ packId: 'test_arm', skillId: 'none' }))
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('SKILL_NOT_FOUND')

    const malformed = await invoke('pack_skill_list', '{not json')
    expect(malformed.kind).toBe('error')
  })
})
