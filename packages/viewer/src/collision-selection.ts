import type {Entity,SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"

/** 请求与绘制共用 Scene 父链；视觉叶保留自己的选择，碰撞归属取实际物理实例。 */
export function collisionSelectionIds(snapshot:SceneSnapshot,selected:string):string[] {
 const byId=new Map(snapshot.entities.map(entity=>[entity.entityId,entity])),seen=new Set<string>()
 let current=byId.get(selected),owner:Entity|undefined
 if(!current)return []
 while(current&&!seen.has(current.entityId)){
  seen.add(current.entityId)
  if(current.components.articulation||current.components.mujoco||current.components.isaac||current.components.newton){owner=current;break}
  if(!owner&&(current.components.collision||current.components.rigidBody))owner=current
  current=current.parentId?byId.get(current.parentId):undefined
 }
 const ids=new Set([owner?.entityId??selected])
 for(let changed=true;changed;){changed=false;for(const entity of snapshot.entities)if(entity.parentId&&ids.has(entity.parentId)&&!ids.has(entity.entityId)){ids.add(entity.entityId);changed=true}}
 return [...ids]
}

/** 视觉树可很大；Frame 的实体选择上限为 512，优先真实物理声明并明确未请求的声明数量。 */
export function collisionRequestSelection(snapshot:SceneSnapshot,selected:string):{entityIds:string[];omitted:number} {
 const ids=collisionSelectionIds(snapshot,selected)
 if(ids.length<=512)return {entityIds:ids,omitted:0}
 const selectedIds=new Set(ids),physical=snapshot.entities.filter(entity=>selectedIds.has(entity.entityId)&&Boolean(entity.components.collision||entity.components.articulation||entity.components.mujoco||entity.components.isaac||entity.components.newton)).map(entity=>entity.entityId)
 const wanted=[...new Set([ids[0]!,...physical])]
 return {entityIds:wanted.slice(0,512),omitted:Math.max(0,wanted.length-512)}
}
