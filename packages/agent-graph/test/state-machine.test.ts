/**
 * 状态机全迁移表 + 分区铁律（纯函数层，不进文件系统）。
 * 覆盖契约 §3.2：链式迁移、blocked/rejected 出边、heldout 分区只走复核路径。
 */
import { describe, expect, test } from 'bun:test'
import {
  CAMPAIGN_ILLEGAL_TRANSITION, CAMPAIGN_PARTITION_VIOLATION,
  assertRunPartition, assertTransition, canTransition, defaultRoleFor, transitionsFor,
} from '../src/state-machine.ts'
import type { TaskStatus } from '../../lyapunov-contracts/src/agent-graph.ts'

const ALL: TaskStatus[] = ['pending', 'exploring', 'debugging', 'verifying', 'heldout-eval', 'done', 'blocked', 'rejected']

const DEV_LEGAL: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ['pending', 'exploring'], ['pending', 'rejected'],
  ['exploring', 'debugging'], ['exploring', 'blocked'],
  ['debugging', 'verifying'], ['debugging', 'blocked'],
  ['verifying', 'heldout-eval'], ['verifying', 'debugging'], ['verifying', 'rejected'], ['verifying', 'blocked'],
  ['heldout-eval', 'done'], ['heldout-eval', 'blocked'], ['heldout-eval', 'rejected'],
]

const HELDOUT_LEGAL: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ['pending', 'heldout-eval'],
  ['heldout-eval', 'done'], ['heldout-eval', 'blocked'],
]

describe('dev 分区迁移表', () => {
  test('全部声明边合法、表外全部非法（25 条非法组合）', () => {
    for (const [from, to] of DEV_LEGAL) expect(canTransition('dev', from, to)).toBe(true)
    const legal = new Set(DEV_LEGAL.map(([from, to]) => `${from}->${to}`))
    const illegal = ALL.flatMap(from => ALL.map(to => [from, to] as const)).filter(([from, to]) => !legal.has(`${from}->${to}`))
    expect(illegal.length).toBe(ALL.length * ALL.length - DEV_LEGAL.length)
    for (const [from, to] of illegal) expect(canTransition('dev', from, to)).toBe(false)
  })

  test('非法迁移抛具名 CAMPAIGN_ILLEGAL_TRANSITION', () => {
    const task = { taskId: 't1', partition: 'dev' as const, status: 'pending' as const }
    for (const to of ['debugging', 'verifying', 'heldout-eval', 'done', 'blocked'] as const) {
      expect(() => assertTransition(task, to)).toThrow(CAMPAIGN_ILLEGAL_TRANSITION)
    }
    expect(assertTransition(task, 'exploring')).toBe('pending')
    // 终局无出边。
    expect(() => assertTransition({ ...task, status: 'done' }, 'exploring')).toThrow(CAMPAIGN_ILLEGAL_TRANSITION)
    expect(() => assertTransition({ ...task, status: 'blocked' }, 'exploring')).toThrow(CAMPAIGN_ILLEGAL_TRANSITION)
    expect(() => assertTransition({ ...task, status: 'rejected' }, 'exploring')).toThrow(CAMPAIGN_ILLEGAL_TRANSITION)
  })
})

describe('heldout 分区铁律', () => {
  test('heldout 只允许 pending→heldout-eval→done|blocked', () => {
    const legal = new Set(HELDOUT_LEGAL.map(([from, to]) => `${from}->${to}`))
    for (const [from, to] of HELDOUT_LEGAL) expect(canTransition('heldout', from, to)).toBe(true)
    for (const from of ALL) for (const to of ALL) {
      if (!legal.has(`${from}->${to}`)) expect(canTransition('heldout', from, to)).toBe(false)
    }
    // heldout-eval→rejected 不开放（契约：只允许 done|blocked）。
    expect(canTransition('heldout', 'heldout-eval', 'rejected')).toBe(false)
    const task = { taskId: 'h1', partition: 'heldout' as const, status: 'pending' as const }
    expect(() => assertTransition(task, 'exploring')).toThrow(CAMPAIGN_ILLEGAL_TRANSITION)
    expect(assertTransition(task, 'heldout-eval')).toBe('pending')
  })

  test('worker run 碰 heldout → CAMPAIGN_PARTITION_VIOLATION；verifier/coordinator 放行', () => {
    const heldout = { taskId: 'h1', partition: 'heldout' as const }
    expect(() => assertRunPartition(heldout, 'worker')).toThrow(CAMPAIGN_PARTITION_VIOLATION)
    expect(() => assertRunPartition(heldout, 'verifier')).not.toThrow()
    expect(() => assertRunPartition(heldout, 'coordinator')).not.toThrow()
    const dev = { taskId: 'd1', partition: 'dev' as const }
    expect(() => assertRunPartition(dev, 'worker')).not.toThrow()
  })
})

describe('角色推断与迁移表完整性', () => {
  test('defaultRoleFor：执行阶段 worker、复核阶段 verifier', () => {
    expect(defaultRoleFor('exploring')).toBe('worker')
    expect(defaultRoleFor('debugging')).toBe('worker')
    expect(defaultRoleFor('verifying')).toBe('verifier')
    expect(defaultRoleFor('heldout-eval')).toBe('verifier')
  })

  test('两张表覆盖全部状态的出边声明', () => {
    for (const partition of ['dev', 'heldout'] as const) {
      const table = transitionsFor(partition)
      for (const status of ALL) expect(Array.isArray(table[status])).toBe(true)
    }
  })
})
