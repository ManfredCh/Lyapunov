import * as THREE from "three"

/** 一个碰撞形状同时表达真实表面与边；不借视觉网格，不参与拾取或深度写入。 */
export function colliderSurface(geometry:THREE.BufferGeometry,metadata:Record<string,unknown>,color:number,triangles=false):THREE.Group {
 const object=new THREE.Group(),enabled=metadata.collisionEnabled!==false
 object.userData={...metadata,collisionHelper:true,colliderColor:color}
 const surface=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:enabled?.12:.035,depthTest:false,depthWrite:false}))
 const wire=new THREE.LineSegments(triangles?new THREE.WireframeGeometry(geometry):new THREE.EdgesGeometry(geometry),new THREE.LineBasicMaterial({color:enabled?color:0x9298a0,transparent:true,opacity:enabled?.95:.5,depthTest:false,depthWrite:false}))
 surface.renderOrder=29;wire.renderOrder=30
 surface.userData={...object.userData,collisionSurface:true};wire.userData={...object.userData,collisionEdges:true}
 object.add(surface,wire)
 return object
}

/** 参与标记随同一真实帧更新；关闭物理碰撞仍可检查形状，不以隐藏线框修改物理。 */
export function setColliderParticipation(object:THREE.Group,enabled:boolean|undefined):void {
 object.userData.collisionEnabled=enabled
 const participates=enabled!==false,color=participates?object.userData.colliderColor as number:0x9298a0
 object.traverse(child=>{
  if(child instanceof THREE.Mesh){const material=child.material as THREE.MeshBasicMaterial;material.color.setHex(color);material.opacity=participates?.12:.035;child.userData.collisionEnabled=enabled}
  if(child instanceof THREE.LineSegments){const material=child.material as THREE.LineBasicMaterial;material.color.setHex(color);material.opacity=participates?.95:.5;child.userData.collisionEnabled=enabled}
 })
}

export function disposeColliderSurface(object:THREE.Object3D):void {
 object.removeFromParent()
 object.traverse(child=>{if(child instanceof THREE.Mesh||child instanceof THREE.LineSegments){child.geometry.dispose();for(const material of Array.isArray(child.material)?child.material:[child.material])material.dispose()}})
}
