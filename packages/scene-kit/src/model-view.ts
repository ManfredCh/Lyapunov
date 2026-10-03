import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

function componentSummary(value:unknown,key=''):unknown{
  if(key==='document')return {omitted:'source-document',readFrom:'entity.resources中的原件URI'}
  if(Array.isArray(value))return value.length>128?{omitted:'large-array',itemCount:value.length}:value.map(item=>componentSummary(item))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,componentSummary(item,name)]))
  return value
}
/** 模型读结构与引用；完整Scene DTO仍由Scene/Viewer/Command持有。 */
export function modelSceneView(value:unknown):unknown{
  if(Array.isArray(value))return value.map(modelSceneView)
  if(!value||typeof value!=='object')return value
  const source=value as Record<string,unknown>
  if(typeof source.sceneId==='string'&&typeof source.revision==='number'&&Array.isArray(source.entities)){
    const scene=source as unknown as SceneSnapshot
    return {kind:'scene-summary',sceneId:scene.sceneId,revision:scene.revision,coordinates:scene.coordinates,...(scene.physics?{physics:scene.physics}:{}),entityCount:scene.entities.length,...(source.resourcePhysicalization&&typeof source.resourcePhysicalization==='object'?{resourcePhysicalization:source.resourcePhysicalization}:{}),entities:scene.entities.map(entity=>({
      entityId:entity.entityId,name:entity.name,...entity.parentId?{parentId:entity.parentId}:{},...entity.locked!==undefined?{locked:entity.locked}:{},transform:entity.transform,resources:entity.resources,
      componentSummary:componentSummary(entity.components),
    })),details:'原模型/几何保留在资源URI中，未内联到模型上下文。完整机器人关节/执行器请用robot_describe，实际状态用robot_state。componentSummary不是可直接提交的完整Entity。'}
  }
  return Object.fromEntries(Object.entries(source).map(([key,item])=>[key,modelSceneView(item)]))
}
