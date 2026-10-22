/**
 * sim_task_check 谓词求值器（契约 `docs/AGENT_GRAPH_CONTRACT.md` §2）。
 *
 * 纯函数：`evaluatePredicate(expr, frame, ctx)` 只读一帧 Observation 与（可选的）
 * `robot_describe` 读数，逐 kind 给出真值与具名失败读数（PredicateFailure.reasonCode），
 * 不推进物理、不经模型。读数缺失如实给 `OBSERVATION_UNAVAILABLE`，引用实体不在
 * 世界给 `ENTITY_MISSING`，不猜不编——worker 按 reasonCode 分桶定向修复。
 *
 * 度量口径（与 sim-contract 观测同一约定：世界系米/弧度、右手 Z-up）：
 *  - 距离类谓词是**实体根位姿**（`EntityObservation.transform.position`）的欧氏距离；
 *  - 接触标签按 `<entityId>/<geomName>` 前缀归并实体（`__ground` 等地名不属于实体）；
 *  - `settled` 的速度通道取 `sensors.bodyLinearVelocityMps` / `sensors.bodyAngularVelocityRadps`
 *    （关节实体的 `joints.velocities` 只作为无阈值判定的补充证据）；`windowSteps > 1`
 *    需要跨帧证据，单帧求值器如实给 `OBSERVATION_UNAVAILABLE`；
 *  - `reachable` 的臂展取 `description.controller.reachRadiusM`，缺失时依次看
 *    `controller.armReachM` 与 describe 顶层 `reachRadiusM`（"声明臂展"的两处既有口径），
 *    都没有给 `OBSERVATION_UNAVAILABLE`，不用机型表猜数；
 *  - `no-penetration` 只看 `frame.penetrations` 的真实聚合；指定实体对时
 *    `worst` 是截断列表——列表外且 `count>0` 不能断言无穿透，给 `OBSERVATION_UNAVAILABLE`。
 */
import type { PredicateAtom, PredicateExpr, PredicateFailure, Vec3 } from '../../lyapunov-contracts/src/agent-graph.ts'
import type { EntityObservation, Frame } from '../../lyapunov-contracts/src/types.ts'
import type { RobotDescription } from '../../sim-contract/src/index.ts'

/** 求值上下文：reachable 需要的机器人声明读数（`robot_describe` 逐 robotId 取得）。 */
export interface PredicateContext { robots?: RobotDescription[] }

/** 一次求值的真值与逐条具名失败；`failures` 为空即 `ok`。 */
export interface PredicateVerdict { ok: boolean; failures: PredicateFailure[] }

/** 单帧内无法证伪/证实的失败码：`not` 把它们原样透传而不是当成"内层不满足"。 */
const UNVERIFIABLE: ReadonlySet<PredicateFailure['reasonCode']> = new Set([
  'OBSERVATION_UNAVAILABLE', 'ENTITY_MISSING', 'JOINT_MISSING',
])

const fmtM = (m: number) => `${m.toFixed(4)}m`
const fmtVec = (v: readonly number[]) => `[${v.map(n => n.toFixed(4)).join(',')}]`
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const finiteVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))
const vecNorm = (v: unknown): number | undefined => finiteVec3(v) ? Math.hypot(v[0], v[1], v[2]) : undefined

export const entityOf = (frame: Frame, entityId: string): EntityObservation | undefined =>
  frame.entities.find(entity => entity.entityId === entityId)

/** 接触/穿透标签归并实体：geom 名是 `<entityId>/<geomName>` 或实体本名。 */
const geomOfEntity = (geom: string, entityId: string) => geom === entityId || geom.startsWith(entityId + '/')

const missingEntity = (predicate: PredicateExpr, entityId: string): PredicateFailure => ({
  predicate, expected: `实体 "${entityId}" 存在于世界`, measured: '观察帧中没有该实体', reasonCode: 'ENTITY_MISSING',
})
const unavailable = (predicate: PredicateExpr, expected: string, measured: string): PredicateFailure => ({
  predicate, expected, measured, reasonCode: 'OBSERVATION_UNAVAILABLE',
})

/**
 * 臂展声明的读取顺序：`controller.reachRadiusM`（契约主口径）→ `controller.armReachM`
 * → describe 顶层 `reachRadiusM`；只接受有限正数，三处都没有返回 undefined（调用方如实报缺）。
 */
export function reachRadiusMOf(description: RobotDescription | undefined): number | undefined {
  if (!description) return
  const controller = description.controller as Record<string, unknown> | undefined
  for (const value of [controller?.reachRadiusM, controller?.armReachM, (description as { reachRadiusM?: unknown }).reachRadiusM]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return
}

/** 谓词引用的全部实体 id（`robotId` 也算引用实体；`settled` 省略 entityId 时不引用具体实体）。 */
export function predicateEntityIds(expr: PredicateExpr): string[] {
  const ids: string[] = []
  const walk = (node: PredicateExpr) => {
    if ('and' in node) return node.and.forEach(walk)
    if ('or' in node) return node.or.forEach(walk)
    if ('not' in node) return walk(node.not)
    const refs = node as Partial<Record<'entityId' | 'entityA' | 'entityB' | 'robotId', string | undefined>>
    for (const id of [refs.entityId, refs.entityA, refs.entityB, refs.robotId]) {
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
    }
  }
  walk(expr)
  return ids
}

/** 逐原子收集并记录 `not` 极性：spec 门只判正极性的 reachable（`not reachable` 的不可达是满足而非拒绝）。 */
export function collectAtoms(expr: PredicateExpr, negated = false): Array<{ atom: PredicateAtom; negated: boolean }> {
  if ('and' in expr) return expr.and.flatMap(node => collectAtoms(node, negated))
  if ('or' in expr) return expr.or.flatMap(node => collectAtoms(node, negated))
  if ('not' in expr) return collectAtoms(expr.not, !negated)
  return [{ atom: expr, negated }]
}

/** `not` 失败的归属桶：内层谓词"成立但不该成立"，reasonCode 取内层原子同族码（方向由 expected/measured 说明）。 */
function familyCodeOf(expr: PredicateExpr): PredicateFailure['reasonCode'] {
  const first = collectAtoms(expr)[0]?.atom
  switch (first?.kind) {
    case 'entity-in-box': return 'POSE_OUTSIDE_BOX'
    case 'distance-below': case 'distance-above': return 'DISTANCE_NOT_MET'
    case 'contact-exists': return 'CONTACT_MISSING'
    case 'joint-in-range': return 'JOINT_OUT_OF_RANGE'
    case 'settled': return 'NOT_SETTLED'
    case 'reachable': return 'UNREACHABLE'
    case 'no-penetration': return 'PENETRATION_PRESENT'
    default: return 'OBSERVATION_UNAVAILABLE'
  }
}

function entityInBox(atom: Extract<PredicateAtom, { kind: 'entity-in-box' }>, frame: Frame): PredicateFailure[] {
  const entity = entityOf(frame, atom.entityId)
  if (!entity) return [missingEntity(atom, atom.entityId)]
  const tolerance = atom.toleranceM ?? 0
  const position = entity.transform.position
  let worstAxis = -1
  let worstOver = 0
  for (let axis = 0; axis < 3; axis += 1) {
    const over = Math.abs(position[axis]! - atom.center[axis]!) - (atom.halfExtents[axis]! + tolerance)
    if (over > worstOver) { worstOver = over; worstAxis = axis }
  }
  if (worstAxis < 0) return []
  return [{
    predicate: atom,
    expected: `实体 "${atom.entityId}" 位姿在盒内（center=${fmtVec(atom.center)} halfExtents=${fmtVec(atom.halfExtents)}${tolerance ? ` +tolerance=${fmtM(tolerance)}` : ''}）`,
    measured: `position=${fmtVec(position)}，${'xyz'[worstAxis]} 轴超出 ${fmtM(worstOver)}`,
    reasonCode: 'POSE_OUTSIDE_BOX',
  }]
}

function distanceBelow(atom: Extract<PredicateAtom, { kind: 'distance-below' }>, frame: Frame): PredicateFailure[] {
  const a = entityOf(frame, atom.entityA)
  const b = entityOf(frame, atom.entityB)
  const missing = [...(a ? [] : [missingEntity(atom, atom.entityA)]), ...(b ? [] : [missingEntity(atom, atom.entityB)])]
  if (missing.length) return missing
  const measured = distance(a!.transform.position, b!.transform.position)
  if (measured <= atom.maxM) return []
  return [{ predicate: atom, expected: `distance("${atom.entityA}","${atom.entityB}") <= ${fmtM(atom.maxM)}`, measured: fmtM(measured), reasonCode: 'DISTANCE_NOT_MET' }]
}

function distanceAbove(atom: Extract<PredicateAtom, { kind: 'distance-above' }>, frame: Frame): PredicateFailure[] {
  const a = entityOf(frame, atom.entityA)
  const b = entityOf(frame, atom.entityB)
  const missing = [...(a ? [] : [missingEntity(atom, atom.entityA)]), ...(b ? [] : [missingEntity(atom, atom.entityB)])]
  if (missing.length) return missing
  const measured = distance(a!.transform.position, b!.transform.position)
  if (measured >= atom.minM) return []
  return [{ predicate: atom, expected: `distance("${atom.entityA}","${atom.entityB}") >= ${fmtM(atom.minM)}`, measured: fmtM(measured), reasonCode: 'DISTANCE_NOT_MET' }]
}

function contactExists(atom: Extract<PredicateAtom, { kind: 'contact-exists' }>, frame: Frame): PredicateFailure[] {
  const missing = [...(atom.entityA && !entityOf(frame, atom.entityA) ? [missingEntity(atom, atom.entityA)] : []),
    ...(atom.entityB && !entityOf(frame, atom.entityB) ? [missingEntity(atom, atom.entityB)] : [])]
  if (missing.length) return missing
  if (!frame.contacts) return [unavailable(atom, '当前帧的 contacts 观测', '本帧未含 contacts（需要 observe(contacts:true)）')]
  const count = frame.contacts.filter(contact => {
    if (atom.entityA && atom.entityB) {
      return (geomOfEntity(contact.geom1, atom.entityA) && geomOfEntity(contact.geom2, atom.entityB))
        || (geomOfEntity(contact.geom1, atom.entityB) && geomOfEntity(contact.geom2, atom.entityA))
    }
    const id = atom.entityA ?? atom.entityB
    return id ? geomOfEntity(contact.geom1, id) || geomOfEntity(contact.geom2, id) : true
  }).length
  if (count > 0) return []
  const pair = atom.entityA && atom.entityB ? `"${atom.entityA}"↔"${atom.entityB}"` : atom.entityA ?? atom.entityB ?? '任意实体'
  return [{ predicate: atom, expected: `存在 ${pair} 接触对`, measured: `contacts 共 ${frame.contacts.length} 对，匹配 0 对`, reasonCode: 'CONTACT_MISSING' }]
}

function jointInRange(atom: Extract<PredicateAtom, { kind: 'joint-in-range' }>, frame: Frame): PredicateFailure[] {
  const entity = entityOf(frame, atom.entityId)
  if (!entity) return [missingEntity(atom, atom.entityId)]
  if (!entity.joints) return [unavailable(atom, `实体 "${atom.entityId}" 的关节观测`, '本帧未含 joints')]
  const index = entity.joints.names.indexOf(atom.jointName)
  if (index < 0) return [{ predicate: atom, expected: `关节 "${atom.jointName}" 属于实体 "${atom.entityId}"`, measured: `joints=[${entity.joints.names.join(',')}]`, reasonCode: 'JOINT_MISSING' }]
  const position = entity.joints.positions[index]
  if (typeof position !== 'number' || !Number.isFinite(position)) return [unavailable(atom, `关节 "${atom.jointName}" 的实测位置`, 'positions 中对应值不是有限数')]
  const min = atom.min ?? -Infinity
  const max = atom.max ?? Infinity
  if (position >= min && position <= max) return []
  return [{ predicate: atom, expected: `"${atom.jointName}" ∈ [${atom.min ?? '-∞'}, ${atom.max ?? '+∞'}]`, measured: String(position), reasonCode: 'JOINT_OUT_OF_RANGE' }]
}

/** 一个实体的可测速度通道：线/角/关节速度分别给出有限范数才作数，读不到如实 undefined。 */
function speedChannelsOf(entity: EntityObservation): { linear?: number; angular?: number; joint?: number } {
  return {
    linear: vecNorm(entity.sensors?.bodyLinearVelocityMps),
    angular: vecNorm(entity.sensors?.bodyAngularVelocityRadps),
    joint: entity.joints?.velocities.every(v => typeof v === 'number' && Number.isFinite(v)) ? Math.hypot(...entity.joints.velocities) : undefined,
  }
}

function settled(atom: Extract<PredicateAtom, { kind: 'settled' }>, frame: Frame): PredicateFailure[] {
  if (atom.windowSteps !== undefined && atom.windowSteps > 1) {
    return [unavailable(atom, `windowSteps=${atom.windowSteps} 的跨帧证据`, '谓词求值器只读单帧；跨帧窗口由工具层另行提供')]
  }
  const targets = atom.entityId === undefined
    ? frame.entities
    : [entityOf(frame, atom.entityId)].filter((e): e is EntityObservation => e !== undefined)
  if (atom.entityId !== undefined && !targets.length) return [missingEntity(atom, atom.entityId)]
  if (!targets.length) return [unavailable(atom, '全实体速度观测', '本帧没有任何实体读数')]
  const failures: PredicateFailure[] = []
  for (const entity of targets) {
    const speed = speedChannelsOf(entity)
    const needLinear = atom.maxLinearSpeedMps !== undefined
    const needAngular = atom.maxAngularSpeedRps !== undefined
    const scope = atom.entityId === undefined ? `实体 "${entity.entityId}" 的 ` : ''
    if (needLinear && speed.linear === undefined) {
      failures.push(unavailable(atom, `${scope}线速度观测`, 'sensors.bodyLinearVelocityMps 缺失或非有限三元组'))
      continue
    }
    if (needAngular && speed.angular === undefined) {
      failures.push(unavailable(atom, `${scope}角速度观测`, 'sensors.bodyAngularVelocityRadps 缺失或非有限三元组'))
      continue
    }
    if (!needLinear && !needAngular) {
      // 无阈值声明＝"无可测运动"：任一上报通道非零即未静止；零通道且 physics.dynamic!==false 无法证实，给缺数。
      const channels = [speed.linear, speed.angular, speed.joint].filter((v): v is number => v !== undefined)
      if (!channels.length) {
        if (entity.physics?.dynamic === false) continue
        failures.push(unavailable(atom, `${scope}速度观测`, '本帧没有任何速度通道，且实体未声明为静态'))
        continue
      }
      if (channels.every(v => v === 0)) continue
      failures.push({
        predicate: atom,
        expected: `${scope}全部速度通道为 0`,
        measured: `linear=${speed.linear?.toFixed(4) ?? 'n/a'} angular=${speed.angular?.toFixed(4) ?? 'n/a'} joint=${speed.joint?.toFixed(4) ?? 'n/a'}`,
        reasonCode: 'NOT_SETTLED',
      })
      continue
    }
    const violations = [
      needLinear && speed.linear! > atom.maxLinearSpeedMps! ? `linear=${speed.linear!.toFixed(4)}m/s > ${atom.maxLinearSpeedMps}` : '',
      needAngular && speed.angular! > atom.maxAngularSpeedRps! ? `angular=${speed.angular!.toFixed(4)}rad/s > ${atom.maxAngularSpeedRps}` : '',
    ].filter(Boolean)
    if (violations.length) {
      failures.push({ predicate: atom, expected: `${scope}速度低于声明阈值`, measured: violations.join('；'), reasonCode: 'NOT_SETTLED' })
    }
  }
  return failures
}

function reachable(atom: Extract<PredicateAtom, { kind: 'reachable' }>, frame: Frame, ctx: PredicateContext): PredicateFailure[] {
  const target = entityOf(frame, atom.entityId)
  const robot = entityOf(frame, atom.robotId)
  const missing = [...(target ? [] : [missingEntity(atom, atom.entityId)]), ...(robot ? [] : [missingEntity(atom, atom.robotId)])]
  if (missing.length) return missing
  // 基座读数取机器人实体的当前根位姿（与距离类谓词同一口径），臂展只认声明值。
  const description = ctx.robots?.find(entry => entry.entityId === atom.robotId)
  const radius = reachRadiusMOf(description)
  if (radius === undefined) {
    return [unavailable(atom, `"${atom.robotId}" 的臂展声明（controller.reachRadiusM / armReachM）`, description ? 'description 未携带臂展声明' : '未提供该实体的 robot_describe 读数')]
  }
  const margin = atom.marginM ?? 0
  const measured = distance(robot!.transform.position, target!.transform.position)
  if (measured <= radius + margin) return []
  return [{
    predicate: atom,
    expected: `基座-目标距离 <= ${fmtM(radius + margin)}（臂展 ${fmtM(radius)}${margin ? `+margin ${fmtM(margin)}` : ''}）`,
    measured: fmtM(measured),
    reasonCode: 'UNREACHABLE',
  }]
}

function noPenetration(atom: Extract<PredicateAtom, { kind: 'no-penetration' }>, frame: Frame): PredicateFailure[] {
  const missing = [...(atom.entityA && !entityOf(frame, atom.entityA) ? [missingEntity(atom, atom.entityA)] : []),
    ...(atom.entityB && !entityOf(frame, atom.entityB) ? [missingEntity(atom, atom.entityB)] : [])]
  if (missing.length) return missing
  if (!frame.penetrations) return [unavailable(atom, '当前帧的 penetrations 聚合', '本帧未含 penetrations（需要 observe(contacts:true) 的穿透聚合）')]
  const { count, worst } = frame.penetrations
  if (!atom.entityA && !atom.entityB) {
    if (count === 0) return []
    return [{ predicate: atom, expected: '世界内无穿透 geom 对', measured: `penetrations.count=${count}（worst=${worst.map(p => `${p.geom1}↔${p.geom2}`).join(',') || '无明细'}）`, reasonCode: 'PENETRATION_PRESENT' }]
  }
  const matched = worst.filter(pair => {
    if (atom.entityA && atom.entityB) {
      return (geomOfEntity(pair.geom1, atom.entityA) && geomOfEntity(pair.geom2, atom.entityB))
        || (geomOfEntity(pair.geom1, atom.entityB) && geomOfEntity(pair.geom2, atom.entityA))
    }
    const id = atom.entityA ?? atom.entityB!
    return geomOfEntity(pair.geom1, id) || geomOfEntity(pair.geom2, id)
  })
  if (matched.length) {
    return [{ predicate: atom, expected: '指定实体对无穿透', measured: matched.map(p => `${p.geom1}↔${p.geom2} minDist=${fmtM(p.minDistanceM)}`).join('；'), reasonCode: 'PENETRATION_PRESENT' }]
  }
  // worst 是截断列表：count=0 时整体无穿透可判真；count>0 而指定对不在 worst 内不能断言干净。
  if (count === 0) return []
  return [unavailable(atom, '指定实体对的穿透明细', `penetrations.worst 未覆盖该对（count=${count}，worst 仅 ${worst.length} 条），不能断言无穿透`)]
}

/** 单原子求值；返回空数组即满足。 */
function evaluateAtom(atom: PredicateAtom, frame: Frame, ctx: PredicateContext): PredicateFailure[] {
  switch (atom.kind) {
    case 'entity-in-box': return entityInBox(atom, frame)
    case 'distance-below': return distanceBelow(atom, frame)
    case 'distance-above': return distanceAbove(atom, frame)
    case 'contact-exists': return contactExists(atom, frame)
    case 'joint-in-range': return jointInRange(atom, frame)
    case 'settled': return settled(atom, frame)
    case 'reachable': return reachable(atom, frame, ctx)
    case 'no-penetration': return noPenetration(atom, frame)
  }
}

function evaluate(expr: PredicateExpr, frame: Frame, ctx: PredicateContext): PredicateVerdict {
  if ('and' in expr) {
    const failures = expr.and.flatMap(node => evaluate(node, frame, ctx).failures)
    return { ok: failures.length === 0, failures }
  }
  if ('or' in expr) {
    const branches = expr.or.map(node => evaluate(node, frame, ctx))
    if (branches.some(branch => branch.ok)) return { ok: true, failures: [] }
    return { ok: false, failures: branches.flatMap(branch => branch.failures) }
  }
  if ('not' in expr) {
    const inner = evaluate(expr.not, frame, ctx)
    if (!inner.ok) {
      // 内层"不满足"只有两种读法：证伪（→ not 成立）或无法证实（缺数/缺实体，原样透传，不冒称成立）。
      return inner.failures.every(failure => UNVERIFIABLE.has(failure.reasonCode))
        ? { ok: false, failures: inner.failures }
        : { ok: true, failures: [] }
    }
    return {
      ok: false,
      failures: [{ predicate: expr, expected: '内层谓词不成立', measured: '内层谓词已成立', reasonCode: familyCodeOf(expr.not) }],
    }
  }
  const atom = expr as PredicateAtom
  if (typeof atom.kind !== 'string') {
    return { ok: false, failures: [unavailable(expr, '已知 kind 的 PredicateExpr', `收到 ${JSON.stringify(expr)}`)] }
  }
  const failures = evaluateAtom(atom, frame, ctx)
  return { ok: failures.length === 0, failures }
}

/**
 * 对一帧观察求谓词树真值。`expr` 假定已通过 `predicateExprProblems` 校验
 * （工具层在校验失败时直接具名拒绝）；未知 kind 防御性给 OBSERVATION_UNAVAILABLE。
 */
export function evaluatePredicate(expr: PredicateExpr, frame: Frame, ctx: PredicateContext = {}): PredicateVerdict {
  return evaluate(expr, frame, ctx)
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const optional = (v: unknown, test: (x: unknown) => boolean) => v === undefined || test(v)

/** 入参级谓词形状校验（JSON 边界）：逐条给路径化问题，供工具层具名拒绝，不为它发明默认值。 */
export function predicateExprProblems(expr: unknown, path = 'predicates'): string[] {
  if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) return [`${path} 必须是谓词对象`]
  const node = expr as Record<string, unknown>
  if ('and' in node || 'or' in node) {
    const key = 'and' in node ? 'and' : 'or'
    const list = node[key]
    if (!Array.isArray(list)) return [`${path}.${key} 必须是数组`]
    return list.flatMap((child, index) => predicateExprProblems(child, `${path}.${key}[${index}]`))
  }
  if ('not' in node) return predicateExprProblems(node.not, `${path}.not`)
  switch (node.kind) {
    case 'entity-in-box':
      return [
        ...isNonEmptyString(node.entityId) ? [] : [`${path}.entityId 必须是非空字符串`],
        ...finiteVec3(node.center) ? [] : [`${path}.center 必须是有限三元组`],
        ...finiteVec3(node.halfExtents) ? [] : [`${path}.halfExtents 必须是有限三元组`],
        ...optional(node.toleranceM, isFiniteNumber) ? [] : [`${path}.toleranceM 必须是有限数`],
      ]
    case 'distance-below':
    case 'distance-above':
      return [
        ...isNonEmptyString(node.entityA) ? [] : [`${path}.entityA 必须是非空字符串`],
        ...isNonEmptyString(node.entityB) ? [] : [`${path}.entityB 必须是非空字符串`],
        ...isFiniteNumber(node[node.kind === 'distance-below' ? 'maxM' : 'minM']) ? [] : [`${path}.${node.kind === 'distance-below' ? 'maxM' : 'minM'} 必须是有限数`],
      ]
    case 'contact-exists':
    case 'no-penetration':
      return [
        ...optional(node.entityA, isNonEmptyString) ? [] : [`${path}.entityA 必须是非空字符串`],
        ...optional(node.entityB, isNonEmptyString) ? [] : [`${path}.entityB 必须是非空字符串`],
      ]
    case 'joint-in-range':
      return [
        ...isNonEmptyString(node.entityId) ? [] : [`${path}.entityId 必须是非空字符串`],
        ...isNonEmptyString(node.jointName) ? [] : [`${path}.jointName 必须是非空字符串`],
        ...optional(node.min, isFiniteNumber) && optional(node.max, isFiniteNumber) ? [] : [`${path}.min/max 必须是有限数`],
      ]
    case 'settled':
      return [
        ...optional(node.entityId, isNonEmptyString) ? [] : [`${path}.entityId 必须是非空字符串`],
        ...optional(node.maxLinearSpeedMps, isFiniteNumber) && optional(node.maxAngularSpeedRps, isFiniteNumber) ? [] : [`${path}.maxLinearSpeedMps/maxAngularSpeedRps 必须是有限数`],
        ...optional(node.windowSteps, v => Number.isInteger(v) && (v as number) >= 1) ? [] : [`${path}.windowSteps 必须是正整数`],
      ]
    case 'reachable':
      return [
        ...isNonEmptyString(node.entityId) ? [] : [`${path}.entityId 必须是非空字符串`],
        ...isNonEmptyString(node.robotId) ? [] : [`${path}.robotId 必须是非空字符串`],
        ...optional(node.marginM, isFiniteNumber) ? [] : [`${path}.marginM 必须是有限数`],
      ]
    default:
      return [`${path}.kind 未知：${JSON.stringify(node.kind)}`]
  }
}
