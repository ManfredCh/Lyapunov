/**
 * R-004／R-012 输入合同：窄的「源模型安装资格」判定。
 *
 * Preview 与**所有真实写入口**（`robot_set_base`、`robot_assembly_replace`）在 commit 前共用这一份
 * 只读逻辑：源模型若含「一旦被 moving 父树带动即非法」的静态 plane，只有把源根固定在**世界静态**
 * 的目标 body 上才允许。判据只来自源/目标真实 `robot_describe`，不按文件名猜、不删几何、不改源模型。
 */
import type { RobotDescription } from '../../sim-contract/src/index.ts'
import type { NativeRobotBody } from '../../lyapunov-contracts/src/robot-authoring.ts'

/**
 * 该 body 是否等于根，或沿 parent 链到根**只经过固定/无关节**的连接。
 * 移动内链（如与根之间的铰链/滑动关节）不能冒充"相对根固定的安装接口"。
 */
export function mountBodyFixedToRoot(bodies: NativeRobotBody[], bodyName: string, rootName: string): boolean {
  if (bodyName === rootName) return true
  const byName = new Map(bodies.map(body => [body.name, body]))
  const seen = new Set<string>()
  let current = byName.get(bodyName)
  while (current && current.name !== rootName) {
    if (seen.has(current.name)) return false
    seen.add(current.name)
    // MJCF 中 body 不带 joint 即相对父刚体固定；带 joint 时只有 fixed 算固定。
    if ((current.jointTypes ?? []).some(type => type !== 'fixed')) return false
    current = current.parentName ? byName.get(current.parentName) : undefined
  }
  return current?.name === rootName
}

/**
 * 目标 body 是否沿 parent 链只经固定/无关节相连，且目标根静态固定到世界。
 * 只有这种目标 body 才能接纳源模型里的静态 plane（MuJoCo: plane only allowed in static bodies）；
 * 目标根若绑定到另一个实体（moving 链）也不静态。只读判据，不写 Scene。
 */
export function targetBodyStaticToWorld(description: RobotDescription, bodyName: string): boolean {
  const bodies = description.nativeBodies ?? []
  const root = bodies.find(body => body.root)
  if (!root) return false
  const base = description.base
  if (base?.mode !== 'fixed' || base.target?.entityId) return false
  return mountBodyFixedToRoot(bodies, bodyName, root.name)
}

/**
 * commit 前统一资格门。`attachable=false` 的源（含会被 moving 父树带动的静态 plane）挂到
 * moving 目标 body 时明确拒绝，且调用方在调用本函数前**没有**任何 Scene 写入。
 *
 * free/source 恢复不经过本函数：主控真实 MuJoCo 已证明此时 plane 仍属 world，只有源根获得自由关节，
 * 因此不得因 `attachable=false` 一律拦截。
 */
export function assertSourceInstallable(source: RobotDescription, targetBodyName: string, target: RobotDescription): void {
  const eligibility = source.installEligibility
  if (eligibility?.attachable !== false) return
  if (targetBodyStaticToWorld(target, targetBodyName)) return
  const planes = eligibility.staticPlaneBodies.length ? eligibility.staticPlaneBodies.join(', ') : 'plane'
  throw new Error(`SOURCE_NOT_INSTALLABLE: 源模型含会被 moving 挂接带动的静态 plane（${planes}，只读原生事实 ${eligibility.reason || 'SOURCE_HAS_STATIC_PLANE'}）；目标 body ${targetBodyName} 不是世界静态 body。请改用不含 plane 的机器人本体，或把源根作为独立根固定到世界。`)
}
