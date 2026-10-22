/**
 * 谓词求值器真值覆盖：每个 kind 的成立/不成立/缺数据三条路径 + and/or/not 组合树。
 * 夹具帧字段与 `sim-contract` 的 Frame 同一形状（世界系米、右手 Z-up）；
 * 替身只给读数，被测对象永远是 `evaluatePredicate`/`checkSpecGate` 本身。
 */
import { describe, expect, test } from 'bun:test'
import { evaluatePredicate, predicateExprProblems, predicateEntityIds, reachRadiusMOf } from '../src/predicates.ts'
import type { PredicateExpr } from '../../lyapunov-contracts/src/agent-graph.ts'
import type { EntityObservation, Frame } from '../../lyapunov-contracts/src/types.ts'
import type { RobotDescription } from '../../sim-contract/src/index.ts'

const vec = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
const entity = (entityId: string, position = vec(0, 0, 0), extra: Partial<EntityObservation> = {}): EntityObservation =>
  ({ entityId, transform: { position, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, ...extra })
const frame = (entities: EntityObservation[], extra: Partial<Frame> = {}): Frame =>
  ({ worldId: 'w-1', generation: 1, stepIndex: 7, simTime: 0.7, frameId: 'w-1:1:7', entities, ...extra })
const robotWithReach = (entityId: string, reachRadiusM?: number): RobotDescription => ({
  entityId, modelVersion: 'mv', expectedGeneration: 1, collisionContextVersion: 'ccv',
  joints: [], controlledJointNames: [],
  ...(reachRadiusM === undefined ? {} : { controller: { reachRadiusM } }),
})

describe('entity-in-box', () => {
  const expr: PredicateExpr = { kind: 'entity-in-box', entityId: 'cube', center: [0.4, 0, 0.05], halfExtents: [0.05, 0.05, 0.05] }
  test('位姿在盒内成立', () => {
    expect(evaluatePredicate(expr, frame([entity('cube', [0.42, -0.03, 0.08])])).ok).toBe(true)
  })
  test('位姿出盒报 POSE_OUTSIDE_BOX 且 measured 带轴向超差', () => {
    const verdict = evaluatePredicate(expr, frame([entity('cube', [0.5, 0, 0.05])]))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]!.reasonCode).toBe('POSE_OUTSIDE_BOX')
    expect(verdict.failures[0]!.measured).toContain('x 轴')
  })
  test('toleranceM 扩盒：盒外但在容差内成立', () => {
    const tolerant: PredicateExpr = { ...expr, toleranceM: 0.06 } as PredicateExpr
    expect(evaluatePredicate(tolerant, frame([entity('cube', [0.5, 0, 0.05])])).ok).toBe(true)
  })
  test('实体缺席报 ENTITY_MISSING', () => {
    const verdict = evaluatePredicate(expr, frame([entity('other')]))
    expect(verdict.failures[0]!.reasonCode).toBe('ENTITY_MISSING')
  })
})

describe('distance-below / distance-above', () => {
  const below: PredicateExpr = { kind: 'distance-below', entityA: 'a', entityB: 'b', maxM: 0.3 }
  const above: PredicateExpr = { kind: 'distance-above', entityA: 'a', entityB: 'b', minM: 0.1 }
  const near = frame([entity('a', [0, 0, 0]), entity('b', [0.2, 0, 0])])
  const far = frame([entity('a', [0, 0, 0]), entity('b', [0.5, 0, 0])])
  test('距离达标成立；不达标报 DISTANCE_NOT_MET 附实测距离', () => {
    expect(evaluatePredicate(below, near).ok).toBe(true)
    expect(evaluatePredicate(above, near).ok).toBe(true)
    const verdict = evaluatePredicate(below, far)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]!.reasonCode).toBe('DISTANCE_NOT_MET')
    expect(verdict.failures[0]!.measured).toBe('0.5000m')
    expect(evaluatePredicate(above, near).failures[0]?.reasonCode).toBeUndefined()
    expect(evaluatePredicate({ kind: 'distance-above', entityA: 'a', entityB: 'b', minM: 0.4 }, near).failures[0]!.reasonCode).toBe('DISTANCE_NOT_MET')
  })
  test('引用实体缺席报 ENTITY_MISSING（双侧各报各的）', () => {
    const verdict = evaluatePredicate(below, frame([entity('a')]))
    expect(verdict.failures).toHaveLength(1)
    expect(verdict.failures[0]!.reasonCode).toBe('ENTITY_MISSING')
    expect(evaluatePredicate(below, frame([])).failures).toHaveLength(2)
  })
})

describe('contact-exists', () => {
  const contacts = [
    { geom1: 'gripper/finger1', geom2: 'cube/body' },
    { geom1: '__ground/floor', geom2: 'cube/body' },
  ]
  test('指定对按 geom 前缀命中（两向都算）', () => {
    const expr: PredicateExpr = { kind: 'contact-exists', entityA: 'gripper', entityB: 'cube' }
    expect(evaluatePredicate(expr, frame([entity('gripper'), entity('cube')], { contacts })).ok).toBe(true)
    const swapped: PredicateExpr = { kind: 'contact-exists', entityA: 'gripper', entityB: 'cube' }
    const reversed = frame([entity('gripper'), entity('cube')], { contacts: [{ geom1: 'cube/body', geom2: 'gripper/finger1' }] })
    expect(evaluatePredicate(swapped, reversed).ok).toBe(true)
  })
  test('单侧引用与无条件引用', () => {
    expect(evaluatePredicate({ kind: 'contact-exists', entityA: 'cube' }, frame([entity('cube')], { contacts })).ok).toBe(true)
    expect(evaluatePredicate({ kind: 'contact-exists' }, frame([], { contacts })).ok).toBe(true)
  })
  test('无匹配接触报 CONTACT_MISSING 并给出对数', () => {
    const verdict = evaluatePredicate({ kind: 'contact-exists', entityA: 'arm', entityB: 'cube' }, frame([entity('arm'), entity('cube')], { contacts }))
    expect(verdict.failures[0]!.reasonCode).toBe('CONTACT_MISSING')
    expect(verdict.failures[0]!.measured).toContain('2 对')
  })
  test('帧缺 contacts 字段报 OBSERVATION_UNAVAILABLE 而不是 CONTACT_MISSING', () => {
    const verdict = evaluatePredicate({ kind: 'contact-exists' }, frame([]))
    expect(verdict.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
  test('命名实体缺席先于接触判断报 ENTITY_MISSING', () => {
    const verdict = evaluatePredicate({ kind: 'contact-exists', entityA: 'ghost', entityB: 'cube' }, frame([entity('cube')], { contacts }))
    expect(verdict.failures[0]!.reasonCode).toBe('ENTITY_MISSING')
  })
})

describe('joint-in-range', () => {
  const arm = entity('arm', vec(0, 0, 0), { joints: { names: ['shoulder', 'elbow'], positions: [0.5, -0.2], velocities: [0, 0] } })
  test('实测值在范围内成立', () => {
    expect(evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'shoulder', min: 0, max: 1 }, frame([arm])).ok).toBe(true)
  })
  test('单侧界：只声明 min 时下界生效', () => {
    expect(evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'elbow', min: -0.5 }, frame([arm])).ok).toBe(true)
    expect(evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'elbow', min: 0 }, frame([arm])).ok).toBe(false)
  })
  test('越界报 JOINT_OUT_OF_RANGE 附实测值', () => {
    const verdict = evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'shoulder', min: 0.6 }, frame([arm]))
    expect(verdict.failures[0]!.reasonCode).toBe('JOINT_OUT_OF_RANGE')
    expect(verdict.failures[0]!.measured).toBe('0.5')
  })
  test('关节名不在实体关节表报 JOINT_MISSING', () => {
    const verdict = evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'wrist' }, frame([arm]))
    expect(verdict.failures[0]!.reasonCode).toBe('JOINT_MISSING')
  })
  test('实体没有 joints 观测报 OBSERVATION_UNAVAILABLE', () => {
    const verdict = evaluatePredicate({ kind: 'joint-in-range', entityId: 'arm', jointName: 'shoulder' }, frame([entity('arm')]))
    expect(verdict.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
})

describe('settled', () => {
  const moving = entity('box', vec(0, 0, 0), { sensors: { bodyLinearVelocityMps: [0.2, 0, 0], bodyAngularVelocityRadps: [0, 0, 0] } })
  const still = entity('box', vec(0, 0, 0), { sensors: { bodyLinearVelocityMps: [0, 0, 0], bodyAngularVelocityRadps: [0, 0, 0] } })
  test('速度低于声明阈值成立', () => {
    const expr: PredicateExpr = { kind: 'settled', entityId: 'box', maxLinearSpeedMps: 0.05, maxAngularSpeedRps: 0.05 }
    expect(evaluatePredicate(expr, frame([still])).ok).toBe(true)
  })
  test('超速报 NOT_SETTLED 附实测速度', () => {
    const verdict = evaluatePredicate({ kind: 'settled', entityId: 'box', maxLinearSpeedMps: 0.05 }, frame([moving]))
    expect(verdict.failures[0]!.reasonCode).toBe('NOT_SETTLED')
    expect(verdict.failures[0]!.measured).toContain('0.2000')
  })
  test('声明了阈值但速度通道缺失报 OBSERVATION_UNAVAILABLE', () => {
    const verdict = evaluatePredicate({ kind: 'settled', entityId: 'box', maxLinearSpeedMps: 0.05 }, frame([entity('box')]))
    expect(verdict.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
  test('windowSteps>1 需要跨帧证据，单帧如实报 OBSERVATION_UNAVAILABLE', () => {
    const verdict = evaluatePredicate({ kind: 'settled', entityId: 'box', maxLinearSpeedMps: 0.05, windowSteps: 5 }, frame([still]))
    expect(verdict.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
  test('无阈值＝无可测运动：任一上报通道非零即 NOT_SETTLED，全零成立', () => {
    expect(evaluatePredicate({ kind: 'settled', entityId: 'box' }, frame([moving])).failures[0]!.reasonCode).toBe('NOT_SETTLED')
    expect(evaluatePredicate({ kind: 'settled', entityId: 'box' }, frame([still])).ok).toBe(true)
  })
  test('省略 entityId 时检查帧内全部实体；无通道且未声明静态的实体报缺', () => {
    expect(evaluatePredicate({ kind: 'settled', maxLinearSpeedMps: 0.05 }, frame([still, moving])).ok).toBe(false)
    const blind = frame([still, entity('mystery')])
    expect(evaluatePredicate({ kind: 'settled', maxLinearSpeedMps: 0.05 }, blind).failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
    const staticWall = entity('wall', vec(0, 0, 0), { physics: { source: 'mujoco-compiled', dynamic: false, massKg: null, gravityEnabled: true, collisionEnabled: true, colliderCount: 1 } })
    expect(evaluatePredicate({ kind: 'settled' }, frame([still, staticWall])).ok).toBe(true)
  })
})

describe('reachable', () => {
  const world = frame([entity('arm', [0, 0, 0]), entity('cube', [0.6, 0, 0])])
  const expr: PredicateExpr = { kind: 'reachable', entityId: 'cube', robotId: 'arm' }
  test('目标在声明臂展内成立', () => {
    expect(evaluatePredicate(expr, world, { robots: [robotWithReach('arm', 0.8)] }).ok).toBe(true)
  })
  test('超出臂展报 UNREACHABLE 附实测距离', () => {
    const verdict = evaluatePredicate(expr, world, { robots: [robotWithReach('arm', 0.5)] })
    expect(verdict.failures[0]!.reasonCode).toBe('UNREACHABLE')
    expect(verdict.failures[0]!.measured).toBe('0.6000m')
  })
  test('marginM 覆盖边界带内成立', () => {
    expect(evaluatePredicate({ ...expr, marginM: 0.15 } as PredicateExpr, world, { robots: [robotWithReach('arm', 0.5)] }).ok).toBe(true)
  })
  test('臂展未声明报 OBSERVATION_UNAVAILABLE 而不是用机型表猜数', () => {
    expect(evaluatePredicate(expr, world, { robots: [robotWithReach('arm')] }).failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
    expect(evaluatePredicate(expr, world, {}).failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
    expect(reachRadiusMOf({ ...robotWithReach('arm'), controller: { reachRadiusM: 'wide' } })).toBeUndefined()
    expect(reachRadiusMOf({ ...robotWithReach('arm'), controller: { armReachM: 0.7 } })).toBe(0.7)
  })
  test('引用实体缺席报 ENTITY_MISSING', () => {
    expect(evaluatePredicate(expr, frame([entity('arm')]), { robots: [robotWithReach('arm', 0.8)] }).failures[0]!.reasonCode).toBe('ENTITY_MISSING')
    expect(evaluatePredicate(expr, frame([entity('cube')]), { robots: [robotWithReach('arm', 0.8)] }).failures[0]!.reasonCode).toBe('ENTITY_MISSING')
  })
})

describe('no-penetration', () => {
  const penetrations = { count: 2, worst: [
    { geom1: 'cube/body', geom2: 'ball/body', geom1Id: 1, geom2Id: 2, minDistanceM: -0.01 },
    { geom1: 'cube/body', geom2: '__ground/floor', geom1Id: 1, geom2Id: 3, minDistanceM: -0.002 },
  ] }
  const world = () => frame([entity('cube'), entity('ball')], { penetrations })
  test('count=0 成立；无条件引用且有穿透报 PENETRATION_PRESENT', () => {
    expect(evaluatePredicate({ kind: 'no-penetration' }, frame([], { penetrations: { count: 0, worst: [] } })).ok).toBe(true)
    const verdict = evaluatePredicate({ kind: 'no-penetration' }, world())
    expect(verdict.failures[0]!.reasonCode).toBe('PENETRATION_PRESENT')
  })
  test('指定实体对在 worst 明细中命中报 PENETRATION_PRESENT 附几何对', () => {
    const verdict = evaluatePredicate({ kind: 'no-penetration', entityA: 'cube', entityB: 'ball' }, world())
    expect(verdict.failures[0]!.reasonCode).toBe('PENETRATION_PRESENT')
    expect(verdict.failures[0]!.measured).toContain('cube/body')
  })
  test('worst 是截断列表：指定对未命中且 count>0 时如实报 OBSERVATION_UNAVAILABLE', () => {
    const verdict = evaluatePredicate({ kind: 'no-penetration', entityA: 'ball' }, frame([entity('ball')], { penetrations: { count: 5, worst: [penetrations.worst[1]!] } }))
    expect(verdict.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
  test('指定对未命中且 count=0 成立', () => {
    expect(evaluatePredicate({ kind: 'no-penetration', entityA: 'ball' }, frame([entity('ball')], { penetrations: { count: 0, worst: [] } })).ok).toBe(true)
  })
  test('帧缺 penetrations 报 OBSERVATION_UNAVAILABLE', () => {
    expect(evaluatePredicate({ kind: 'no-penetration' }, frame([])).failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
})

describe('组合树 and/or/not', () => {
  const inBox: PredicateExpr = { kind: 'entity-in-box', entityId: 'cube', center: [0, 0, 0], halfExtents: [0.1, 0.1, 0.1] }
  const contact: PredicateExpr = { kind: 'contact-exists', entityA: 'cube', entityB: 'arm' }
  const world = frame([entity('cube', [0.05, 0, 0]), entity('arm')], {
    contacts: [{ geom1: 'cube/body', geom2: 'arm/link' }],
  })
  test('and 全真才成立；失败逐条保留', () => {
    expect(evaluatePredicate({ and: [inBox, contact] }, world).ok).toBe(true)
    const far = frame([entity('cube', [5, 0, 0]), entity('arm')], { contacts: [] })
    const verdict = evaluatePredicate({ and: [inBox, contact] }, far)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.map(f => f.reasonCode)).toEqual(['POSE_OUTSIDE_BOX', 'CONTACT_MISSING'])
  })
  test('or 一分支成立即成立；全败并集回报', () => {
    expect(evaluatePredicate({ or: [{ kind: 'distance-below', entityA: 'cube', entityB: 'arm', maxM: 0.01 }, contact] }, world).ok).toBe(true)
    const verdict = evaluatePredicate({ or: [{ kind: 'distance-below', entityA: 'cube', entityB: 'arm', maxM: 0.001 }, { kind: 'entity-in-box', entityId: 'cube', center: [9, 9, 9], halfExtents: [0.1, 0.1, 0.1] }] }, world)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toHaveLength(2)
  })
  test('not：内层被证伪即成立；内层成立则报该族 reasonCode', () => {
    // ball 在世界但与 cube 无接触：内层被证伪（CONTACT_MISSING 是真值性失败），not 成立。
    const withBall = frame([entity('cube', [0.05, 0, 0]), entity('arm'), entity('ball', [3, 0, 0])], { contacts: [{ geom1: 'cube/body', geom2: 'arm/link' }] })
    const noContact: PredicateExpr = { not: { kind: 'contact-exists', entityA: 'cube', entityB: 'ball' } }
    expect(evaluatePredicate(noContact, withBall).ok).toBe(true)
    const notInBox: PredicateExpr = { not: inBox }
    const verdict = evaluatePredicate(notInBox, world)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]!.reasonCode).toBe('POSE_OUTSIDE_BOX')
    expect(verdict.failures[0]!.predicate).toEqual(notInBox)
  })
  test('not：内层无法证实（缺数/缺实体）原样透传而不冒称成立', () => {
    const ghost: PredicateExpr = { not: { kind: 'contact-exists', entityA: 'ghost', entityB: 'cube' } }
    const verdict = evaluatePredicate(ghost, world)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]!.reasonCode).toBe('ENTITY_MISSING')
    const blind: PredicateExpr = { not: { kind: 'no-penetration' } }
    const unavailable = evaluatePredicate(blind, frame([]))
    expect(unavailable.ok).toBe(false)
    expect(unavailable.failures[0]!.reasonCode).toBe('OBSERVATION_UNAVAILABLE')
  })
  test('嵌套：and 里套 or/not 逐层求值', () => {
    const expr: PredicateExpr = { and: [inBox, { or: [contact, { kind: 'distance-below', entityA: 'cube', entityB: 'arm', maxM: 0.001 }] }, { not: { kind: 'distance-below', entityA: 'cube', entityB: 'arm', maxM: 0.001 } }] }
    expect(evaluatePredicate(expr, frame([entity('cube', [0.05, 0, 0]), entity('arm')], { contacts: [{ geom1: 'cube/body', geom2: 'arm/link' }], penetrations: { count: 0, worst: [] } })).ok).toBe(true)
  })
})

describe('工具辅助面', () => {
  test('predicateEntityIds 收集全部引用实体（含 robotId，去重）', () => {
    const expr: PredicateExpr = { and: [{ kind: 'reachable', entityId: 'cube', robotId: 'arm' }, { kind: 'contact-exists', entityA: 'cube', entityB: 'arm' }, { kind: 'entity-in-box', entityId: 'cube', center: [0, 0, 0], halfExtents: [1, 1, 1] }] }
    expect(predicateEntityIds(expr)).toEqual(['cube', 'arm'])
  })
  test('predicateExprProblems 逐条路径化拒绝非法输入', () => {
    expect(predicateExprProblems({ kind: 'entity-in-box', entityId: 'a', center: [0, 0], halfExtents: [1, 1, 1] })).toEqual(['predicates.center 必须是有限三元组'])
    expect(predicateExprProblems({ kind: 'mystery' })).toEqual(['predicates.kind 未知："mystery"'])
    expect(predicateExprProblems({ and: [{ kind: 'distance-below', entityA: 'a' }] })[0]).toContain('predicates.and[0]')
    expect(predicateExprProblems('nope')).toEqual(['predicates 必须是谓词对象'])
  })
})
