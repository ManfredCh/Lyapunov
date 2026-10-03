import type {ObservationSelection} from "../../sim-contract/src/index.ts"

/** 帧路由只读当前选中的碰撞体；不触发资源导入、物理化或世界修改。 */
export function collisionFrameSelection(query:URLSearchParams):ObservationSelection|undefined {
 if(query.get("collisionTopology")!=="1")return undefined
 const entityIds=[...new Set(query.getAll("collisionEntityId"))]
 if(!entityIds.length||entityIds.length>512||entityIds.some(id=>!id||id.length>256))throw new Error("COLLISION_SELECTION_INVALID")
 const value=query.get("collisionGeometry")
 if(value!==null&&value!=="0"&&value!=="1")throw new Error("COLLISION_GEOMETRY_INVALID")
 return {collisionTopology:{entityIds,includeGeometry:value!=="0"}}
}
/** 位置/任务能力预检用同一物理帧；可选读取真实site和接触，不推算或填零。 */
export function worldFrameSelection(query:URLSearchParams):ObservationSelection|undefined {
 const collision=collisionFrameSelection(query),selection:ObservationSelection={...collision}
 for(const field of ['sensors','contacts','cameraAuthoring'] as const){const value=query.get(field);if(value!==null){if(value!=='0'&&value!=='1')throw new Error('WORLD_OBSERVATION_SELECTION_INVALID');selection[field]=value==='1'}}
 const ids=[...new Set(query.getAll('entityId'))]
 if(ids.length){if(ids.length>512||ids.some(id=>!id||id.length>256))throw new Error('WORLD_OBSERVATION_SELECTION_INVALID');selection.entityIds=ids}
 return Object.keys(selection).length?selection:undefined
}
