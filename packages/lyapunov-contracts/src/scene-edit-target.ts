import type { Entity, SceneSnapshot } from './types.ts'

/** 按真实父子/组件归属选编辑实例，不用名字或共用资源把不同物体合组。 */
export function sceneEditTarget(scene: SceneSnapshot, selected: string): Entity | undefined {
  const byId = new Map(scene.entities.map(entity => [entity.entityId, entity]))
  const picked = byId.get(selected)
  if (!picked) return
  // 声明相机的独立局部安装位姿由相机入口拥有，不归并成机器人基座编辑。
  if (picked.components.camera || picked.components.viewerCamera || picked.components.sensor?.type === 'camera') return picked
  let current: Entity | undefined = picked
  const seen = new Set<string>()
  while (current && !seen.has(current.entityId)) {
    seen.add(current.entityId)
    if (current.components.collision || current.components.rigidBody || current.components.mujoco || current.components.isaac || current.components.articulation || current.components.visual?.animatedAssembly === true) return current
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return picked
}

export function sceneNodeRole(entity: Entity): 'robot' | 'animated' | 'physics' | 'group' | 'child' | 'entity' {
  if (entity.components.mujoco || entity.components.isaac || entity.components.articulation) return 'robot'
  if (entity.components.visual?.animatedAssembly === true) return 'animated'
  if (entity.components.collision || entity.components.rigidBody) return 'physics'
  if (entity.components.visual?.kind === 'group') return 'group'
  return entity.parentId ? 'child' : 'entity'
}
