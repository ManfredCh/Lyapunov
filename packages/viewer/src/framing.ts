import * as THREE from 'three'
/** 自动取景里"主体量级"可见几何的上限（米）。官方 LIBERO 世界的墙面是 3–6 m 的可见盒、地板盒也到 6 m，
 * 它们会把相机拉到十几米外，让 5 cm 的任务主体只剩 1–2 px（DEV-034 的原始症状）。 */
const AUTOFRAME_MAX_EXTENT_M=2
/**
 * 作者辅助显示（相机视锥、安装点标记、gizmo、批注/路线 helper…）的显式标记。
 *
 * 这些对象有时会被挂到真实 robot body 下（例如 `parentBodyName` 的相机视锥），于是
 * `Box3.setFromObject(entityGroup)` 会把它们算进"模型边界"：真实 Native 里 Panda 模型约 1 m，
 * 读数却到 ~120 m，根中心拾取落空。仅临时 `visible=false` 再 `setFromObject` 也不够——那仍是在
 * 遍历实体几何。这里给 helper 根一个标记，实体几何遍历遇到整棵子树直接跳过。
 */
export const AUTHORING_HELPER_KEY='lyapunovAuthoringHelper'
/** 标记一个对象（通常是一棵 helper 子树的根）：实体几何遍历不再进入它及其后代。 */
export function markAuthoringHelper<T extends THREE.Object3D>(object:T):T {
  object.userData[AUTHORING_HELPER_KEY]=true
  return object
}
/** 只读判据：该节点自己是否被标记为作者辅助根（祖先标记由遍历负责跳过，不在这里回溯）。 */
export function isAuthoringHelperRoot(object:THREE.Object3D):boolean {
  return object.userData?.[AUTHORING_HELPER_KEY]===true
}
type GeometryObject=THREE.Object3D&{
  geometry?:THREE.BufferGeometry
  boundingBox?:THREE.Box3|null
  computeBoundingBox?:()=>void
}
/**
 * 遍历实体几何，**跳过 authoring helper 整棵子树**；`visibleOnly` 与既有自动取景语义一致。
 * 不用 `root.traverseVisible`：它在 helper 根处无法停止下降，仍会把 helper 里的 mesh 算进来。
 */
function walkEntityGeometry(root:THREE.Object3D,visibleOnly:boolean,visit:(object:THREE.Object3D)=>void):void {
  root.updateWorldMatrix(true,true)
  const stack:THREE.Object3D[]=[root]
  while(stack.length){
    const object=stack.pop()!
    if(isAuthoringHelperRoot(object))continue
    if(visibleOnly&&!object.visible)continue
    visit(object)
    for(const child of object.children)stack.push(child)
  }
}
/** 与 `Box3.expandByObject` 的非 precise 分支同义：优先对象级 boundingBox（InstancedMesh），否则几何级。 */
function unionGeometryBounds(object:THREE.Object3D,target:THREE.Box3):void {
  const node=object as GeometryObject
  if(!node.geometry)return
  if(node.boundingBox!==undefined){
    if(node.boundingBox===null)node.computeBoundingBox?.()
    if(node.boundingBox)target.union(node.boundingBox.clone().applyMatrix4(object.matrixWorld))
    return
  }
  if(!node.geometry.boundingBox)node.geometry.computeBoundingBox()
  if(node.geometry.boundingBox)target.union(node.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld))
}
/** Spark的SplatMesh是无geometry的Object3D；其真实局部bbox由getBoundingBox提供。
 * `allowOversizedFallback`：当**全部**可见有限几何都超阈值时是否退回未过滤结果。单实体取景（focus/预览）
 * 需要它（否则空盒 = 不取景）；**多实体并集**（frameAll）必须传 `false`，否则一个"整组都是墙面"的实体会把
 * 6 m 包围盒漏进并集，把相机重新拉到 17 m（DEV-034 R19 真机归因）。 */
export function objectWorldBounds(root:THREE.Object3D,splatBounds:WeakMap<THREE.Object3D,THREE.Box3>,autoFrame=false,allowOversizedFallback=true):THREE.Box3 {
  const box=new THREE.Box3()
  const addSplat=(object:THREE.Object3D)=>{const local=splatBounds.get(object);if(local&&!local.isEmpty())box.union(local.clone().applyMatrix4(object.matrixWorld))}
  if(!autoFrame){
    // 非取景用途仍保留隐藏几何（既有语义）；只排除作者辅助显示，真实可见/隐藏模型几何都保留。
    walkEntityGeometry(root,false,object=>{addSplat(object);unionGeometryBounds(object,box)})
    return box
  }
  // 自动取景只覆盖可见的有限物体；MJCF无限地面与隐藏碰撞层不能把相机拉到远处。
  // N252：**超大的可见几何**（墙面/巨型地板盒）同样会拉远相机 ⇒ 只收主体量级的可见几何；
  // 若整场都是超大几何（例如整栋建筑），退回未过滤结果，**不产生空包围盒**（空盒会让 frameBounds 直接不取景）。
  const oversized=new THREE.Box3()
  walkEntityGeometry(root,true,object=>{
    addSplat(object)
    const mesh=object as THREE.Mesh
    if(!mesh.isMesh||mesh.geometry.type==='PlaneGeometry')return
    const local=new THREE.Box3()
    if(mesh instanceof THREE.InstancedMesh||mesh instanceof THREE.SkinnedMesh){mesh.computeBoundingBox();if(mesh.boundingBox)local.copy(mesh.boundingBox)}
    else{if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();if(mesh.geometry.boundingBox)local.copy(mesh.geometry.boundingBox)}
    if(local.isEmpty())return
    local.applyMatrix4(mesh.matrixWorld)
    const extent=local.getSize(new THREE.Vector3())
    if(Math.max(extent.x,extent.y,extent.z)>AUTOFRAME_MAX_EXTENT_M)oversized.union(local)
    else box.union(local)
  })
  if(box.isEmpty()&&allowOversizedFallback&&!oversized.isEmpty())box.copy(oversized)
  return box
}
/** 默认取景的"任务主体"集合：场景文档里**没有 `articulation` 组件**的实体。
 * 官方 LIBERO 投影里机器人是唯一带 `articulation` 的实体，而它 ~0.9 m 的整臂会把取景框撑大、把 5 cm 的
 * 物体挤出画面（DEV-034 R19 真机：默认机位唯一的紧凑域就是机械臂 29×102 px）。`undefined` = 拿不到主体集合，
 * 调用方退回全部实体（不改"只有机器人"或非场景用例的既有行为）。 */
export function subjectEntityIds(entities:readonly {entityId:string;components?:{articulation?:unknown}}[]|undefined):Set<string>|undefined {
  if(!entities?.length)return undefined
  const subject=new Set<string>()
  for(const entity of entities)if(!entity.components?.articulation)subject.add(entity.entityId)
  return subject.size?subject:undefined
}
/** 让实际世界bbox的包络球同时落在水平/垂直视场内，适用于窄侧栏和宽窗口。 */
export function fitPerspectiveBounds(camera:THREE.PerspectiveCamera,box:THREE.Box3,padding=1.1){
  if(box.isEmpty())return undefined
  if(![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))throw new Error('VIEWER_BOUNDS_NOT_FINITE')
  const center=box.getCenter(new THREE.Vector3()),radius=Math.max(0.001,box.getSize(new THREE.Vector3()).length()/2)
  const verticalHalf=THREE.MathUtils.degToRad(camera.getEffectiveFOV())/2,horizontalHalf=Math.atan(Math.tan(verticalHalf)*camera.aspect),halfFov=Math.min(verticalHalf,horizontalHalf)
  if(!Number.isFinite(halfFov)||halfFov<=0||halfFov>=Math.PI/2)throw new Error('VIEWER_CAMERA_FOV_INVALID')
  const distance=radius/Math.sin(halfFov)*padding,direction=new THREE.Vector3(1,-1.4,.9).normalize()
  camera.position.copy(center).addScaledVector(direction,distance)
  camera.near=Math.max(0.001,radius/1000);camera.far=Math.max(100,distance+radius*10)
  camera.lookAt(center);camera.updateProjectionMatrix();camera.updateMatrixWorld(true)
  return {center,radius,distance,bounds:{min:box.min.toArray(),max:box.max.toArray()},aspect:camera.aspect,verticalFov:camera.getEffectiveFOV(),near:camera.near,far:camera.far}
}
