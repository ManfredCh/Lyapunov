import type { Entity } from '../../lyapunov-contracts/src/types.ts'

export interface StaticAnimationReference {
  ownerEntityId: string
  resourceId?: string
  version?: number
  verified: boolean
  reason?: string
}

/** 只消费Scene里该实例实际绑定的派生事实，不读取资源库latest或按模型名猜用途。 */
export function staticAnimationReference(entity: Entity, byId: ReadonlyMap<string, Entity>): StaticAnimationReference | undefined {
  const visited = new Set<string>()
  let owner: Entity | undefined = entity
  while (owner && !visited.has(owner.entityId)) {
    visited.add(owner.entityId)
    if (owner.components.visual?.kind === 'robot' || owner.components.articulation || owner.components.mujoco || owner.components.isaac || owner.components.newton) return
    const collision = owner.components.collision, rigid = owner.components.rigidBody
    if (collision || rigid) {
      const binding = owner.components.physicsBinding as Record<string, unknown> | undefined
      if (!collision || rigid?.type === 'dynamic' || !(rigid?.type === 'static' || binding?.usage === 'static' || binding?.usage === 'environment') || !String(collision.source ?? '').startsWith('asset-bake-')) return
      const resourceId = typeof binding?.resourceId === 'string' ? binding.resourceId : undefined
      const version = typeof binding?.version === 'number' ? binding.version : undefined
      const ref = owner.resources.find(ref => ref.resourceId === resourceId && ref.version === version)
      const source = binding?.sourceFrame as Record<string, unknown> | undefined
      const animation = source?.animation as Record<string, unknown> | undefined
      const sameVisual = entity.resources.some(ref => ref.resourceId === resourceId && ref.version === version)
      const visualOverride=entity.components.visual?.sourceTransform!==undefined&&entity.components.visual.sourceTransformApplied!==true
      const verified = Boolean(!visualOverride&&binding?.status === 'BOUND' && ref && sameVisual && source?.pose === 'reference'
        && ['Y', 'Z'].includes(ref.source.upAxis) && source.sourceUpAxis === ref.source.upAxis
        && Number.isFinite(source.metersPerUnit) && Number(source.metersPerUnit)>0 && source.metersPerUnit === (ref.source.metersPerUnit ?? 1) && source.derivedUnits === 'm' && source.derivedUpAxis === 'Z'
        && Number.isSafeInteger(animation?.clips) && Number(animation?.clips) >= 0 && animation?.evaluated === false && animation?.skinApplied === false)
      return { ownerEntityId: owner.entityId, resourceId, version, verified,
        ...verified ? {} : { reason: visualOverride?'实例存在显式视觉sourceTransform，尚未核其与派生参考等价；不能宣称视觉与碰撞已对齐':'静态派生缺少该实例同版本、同源轴/单位的已验证参考姿态；不能宣称视觉与碰撞已对齐' } }
    }
    owner = owner.parentId ? byId.get(owner.parentId) : undefined
  }
}
