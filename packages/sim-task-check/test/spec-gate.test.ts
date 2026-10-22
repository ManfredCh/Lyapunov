/**
 * spec 级门：三个具名拦截（SPEC_ENTITY_MISSING/SPEC_UNREACHABLE/SPEC_ALREADY_SATISFIED）
 * 与"数据缺失不判"的负对照。门返回 null 表示放行给帧级评估。
 */
import { describe, expect, test } from 'bun:test'
import { checkSpecGate } from '../src/spec-gate.ts'
import type { PredicateExpr } from '../../lyapunov-contracts/src/agent-graph.ts'
import type { EntityObservation, Frame } from '../../lyapunov-contracts/src/types.ts'
import type { RobotDescription } from '../../sim-contract/src/index.ts'

const entity = (entityId: string, position: [number, number, number] = [0, 0, 0]): EntityObservation =>
  ({ entityId, transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } })
const frame = (entities: EntityObservation[], extra: Partial<Frame> = {}): Frame =>
  ({ worldId: 'w-1', generation: 1, stepIndex: 0, simTime: 0, frameId: 'w-1:1:0', entities, ...extra })
const arm = (reachRadiusM?: number): RobotDescription => ({
  entityId: 'arm', modelVersion: 'mv', expectedGeneration: 1, collisionContextVersion: 'ccv',
  joints: [], controlledJointNames: [],
  ...(reachRadiusM === undefined ? {} : { controller: { reachRadiusM } }),
})

describe('SPEC_ENTITY_MISSING', () => {
  test('谓词引用实体不在世界里：evaluated=false 且点名缺席实体', () => {
    const expr: PredicateExpr = { and: [{ kind: 'contact-exists', entityA: 'cube', entityB: 'arm' }, { kind: 'entity-in-box', entityId: 'ghost', center: [0, 0, 0], halfExtents: [1, 1, 1] }] }
    const rejected = checkSpecGate(expr, frame([entity('cube'), entity('arm')]))
    expect(rejected).not.toBeNull()
    expect(rejected!.rejectedBy).toBe('SPEC_ENTITY_MISSING')
    expect(rejected!.evaluated).toBe(false)
    expect(rejected!.taskAchieved).toBe(false)
    expect(rejected!.failed).toHaveLength(1)
    expect(rejected!.failed[0]!.reasonCode).toBe('ENTITY_MISSING')
    expect(rejected!.failed[0]!.expected).toContain('ghost')
  })
  test('robotId 也算引用实体', () => {
    const rejected = checkSpecGate({ kind: 'reachable', entityId: 'cube', robotId: 'arm' }, frame([entity('cube')]))
    expect(rejected!.rejectedBy).toBe('SPEC_ENTITY_MISSING')
  })
})

describe('SPEC_UNREACHABLE', () => {
  const world = () => frame([entity('arm', [0, 0, 0]), entity('cube', [1.0, 0, 0])], { stepIndex: 3 })
  const expr: PredicateExpr = { kind: 'reachable', entityId: 'cube', robotId: 'arm' }
  test('正极性 reachable 明确超出声明臂展：evaluated=false 报 UNREACHABLE', () => {
    const rejected = checkSpecGate(expr, world(), { robots: [arm(0.5)] })
    expect(rejected!.rejectedBy).toBe('SPEC_UNREACHABLE')
    expect(rejected!.evaluated).toBe(false)
    expect(rejected!.failed[0]!.reasonCode).toBe('UNREACHABLE')
    expect(rejected!.failed[0]!.measured).toBe('1.0000m')
  })
  test('marginM 边界带内不判（放行给评估层）', () => {
    expect(checkSpecGate({ ...expr, marginM: 0.6 } as PredicateExpr, world(), { robots: [arm(0.5)] })).toBeNull()
    expect(checkSpecGate(expr, world(), { robots: [arm(1.0)] })).toBeNull()
  })
  test('not reachable 的不可达是满足而非拒绝：负极性原子不参与本门', () => {
    expect(checkSpecGate({ not: expr }, world(), { robots: [arm(0.5)] })).toBeNull()
  })
  test('臂展未声明时 spec 层不猜，放行后由评估层报 OBSERVATION_UNAVAILABLE', () => {
    expect(checkSpecGate(expr, world(), { robots: [arm()] })).toBeNull()
    expect(checkSpecGate(expr, world())).toBeNull()
  })
})

describe('SPEC_ALREADY_SATISFIED', () => {
  const inBox: PredicateExpr = { kind: 'entity-in-box', entityId: 'cube', center: [0, 0, 0], halfExtents: [0.5, 0.5, 0.5] }
  test('stepIndex=0 且全谓词已真：如实返回 taskAchieved 并标门', () => {
    const rejected = checkSpecGate(inBox, frame([entity('cube', [0.1, 0, 0])]))
    expect(rejected).not.toBeNull()
    expect(rejected!.rejectedBy).toBe('SPEC_ALREADY_SATISFIED')
    expect(rejected!.taskAchieved).toBe(true)
    expect(rejected!.evaluated).toBe(true)
    expect(rejected!.failed).toEqual([])
  })
  test('stepIndex>0 的全真是动作结果，走正常评估路径不标本门', () => {
    expect(checkSpecGate(inBox, frame([entity('cube', [0.1, 0, 0])], { stepIndex: 9 }))).toBeNull()
  })
  test('t=0 未满足（含缺数据）不放行也不拒绝', () => {
    expect(checkSpecGate(inBox, frame([entity('cube', [3, 0, 0])]))).toBeNull()
    expect(checkSpecGate({ kind: 'contact-exists' }, frame([entity('cube')]))).toBeNull()
  })
})

describe('门序：实体缺失先于臂展判定', () => {
  test('同一谓词同时触两档时先报 SPEC_ENTITY_MISSING', () => {
    const expr: PredicateExpr = { kind: 'reachable', entityId: 'ghost', robotId: 'arm' }
    const rejected = checkSpecGate(expr, frame([entity('arm', [0, 0, 0])]), { robots: [arm(0.1)] })
    expect(rejected!.rejectedBy).toBe('SPEC_ENTITY_MISSING')
  })
})
