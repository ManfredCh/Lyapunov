import * as THREE from 'three'
/** 自动取景里"主体量级"可见几何的上限（米）。官方 LIBERO 世界的墙面是 3–6 m 的可见盒、地板盒也到 6 m，
 * 它们会把相机拉到十几米外，让 5 cm 的任务主体只剩 1–2 px（DEV-034 的原始症状）。 */
const AUTOFRAME_MAX_EXTENT_M=2
/** Spark的SplatMesh是无geometry的Object3D；其真实局部bbox由getBoundingBox提供。
 * `allowOversizedFallback`：当**全部**可见有限几何都超阈值时是否退回未过滤结果。单实体取景（focus/预览）
 * 需要它（否则空盒 = 不取景）；**多实体并集**（frameAll）必须传 `false`，否则一个"整组都是墙面"的实体会把
 * 6 m 包围盒漏进并集，把相机重新拉到 17 m（DEV-034 R19 真机归因）。 */
export function objectWorldBounds(root:THREE.Object3D,splatBounds:WeakMap<THREE.Object3D,THREE.Box3>,autoFrame=false,allowOversizedFallback=true):THREE.Box3 {
 root.updateWorldMatrix(true,true)
 const box=autoFrame?new THREE.Box3():new THREE.Box3().setFromObject(root)
 const addSplat=(object:THREE.Object3D)=>{const local=splatBounds.get(object);if(local&&!local.isEmpty())box.union(local.clone().applyMatrix4(object.matrixWorld))}
 if(!autoFrame){root.traverse(addSplat);return box}
 // 自动取景只覆盖可见的有限物体；MJCF无限地面与隐藏碰撞层不能把相机拉到远处。
 // N252：**超大的可见几何**（墙面/巨型地板盒）同样会拉远相机 ⇒ 只收主体量级的可见几何；
 // 若整场都是超大几何（例如整栋建筑），退回未过滤结果，**不产生空包围盒**（空盒会让 frameBounds 直接不取景）。
 const oversized=new THREE.Box3()
 root.traverseVisible(object=>{
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
