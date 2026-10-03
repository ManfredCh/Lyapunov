import * as THREE from "three"
import type {ColliderGeometry,CollisionTopology,Entity,SceneSnapshot,WorldHandle} from "../../lyapunov-contracts/src/types.ts"
import {collisionSelectionIds,collisionRequestSelection} from "./collision-selection.ts"
import {colliderSurface,disposeColliderSurface,setColliderParticipation} from "./collision-surface.ts"
import {CollisionPreviewLayer,type CollisionPreviewOptions} from "./collision-preview.ts"

export interface CollisionTopologyStatus {
 status:"disabled"|"unselected"|"no-world"|"stale-world"|"waiting"|"ready"|"no-collider"|"unavailable"|"preview"|"preview-waiting"|"generating"
 geoms:number
 unsupported:number
 omitted:number
 infinitePlanes:number
 reasons:string[]
 source?:CollisionTopology['source']|"scene-derived"
 drawn?:number
 inactive?:number
 needsGeometry?:boolean
 selectionOmitted?:number
}

/** 世界米制的引擎碰撞线框；不从视觉、bbox 或原件推导碰撞体。 */
export function compiledColliderGeometry(value:ColliderGeometry):THREE.BufferGeometry|undefined {
 const s=value.sizeM
 if(s.length!==3||s.some(v=>!Number.isFinite(v)||v<0))return undefined
 switch(value.kind){
  case "box":return s.every(v=>v>0)?new THREE.BoxGeometry(2*s[0],2*s[1],2*s[2]):undefined
  case "sphere":return s[0]>0?new THREE.SphereGeometry(s[0],24,16):undefined
  case "ellipsoid":return s.every(v=>v>0)?new THREE.SphereGeometry(1,24,16).scale(...s):undefined
  case "capsule":return s[0]>0?new THREE.CapsuleGeometry(s[0],2*s[1],8,24).rotateX(Math.PI/2):undefined
  case "cylinder":return s[0]>0&&s[1]>0?new THREE.CylinderGeometry(s[0],s[0],2*s[1],24).rotateX(Math.PI/2):undefined
  // plane 的碰撞是无限平面；此矩形仅取引擎 geom_size 的参考范围，状态明确标记无限。
  case "plane":return new THREE.PlaneGeometry(2*(s[0]||1),2*(s[1]||1))
  case "convex-hull":{
   const vertices=value.vertices,indices=value.indices
   if(!vertices||!indices||vertices.length%3||indices.length%3||vertices.length>600000||indices.length>600000||vertices.some(v=>!Number.isFinite(v))||indices.some(i=>!Number.isInteger(i)||i<0||i>=vertices.length/3))return undefined
   const geometry=new THREE.BufferGeometry()
   geometry.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices)
   return geometry
  }
  default:return undefined
 }
}

/** 编译形状只接收一次；后续帧只更新 geom 世界位姿。归属改变立即释放旧线框。 */
export class CollisionTopologyLayer {
 readonly root=new THREE.Group()
 private objects=new Map<number,THREE.Group>()
 private shapes=new Map<number,ColliderGeometry>()
 private snapshot?:SceneSnapshot
 private world?:WorldHandle
 private selected?:string
 private selectedIds=new Set<string>()
 private byId=new Map<string,Entity>()
 private selectionOmitted=0
 private enabled=false
 private key=""
 private receipt?:CollisionTopology
 private latestStep=-1
 private preview:CollisionPreviewLayer
 constructor(options:CollisionPreviewOptions={}){this.root.name="碰撞表面与边";this.root.userData.collisionHelper=true;this.preview=new CollisionPreviewLayer(this.root,options,()=>this.refreshVisibility())}
 setContext(snapshot:SceneSnapshot|undefined,world:WorldHandle|undefined,selected:string|undefined,enabled:boolean):void {
  const active=world&&['ready','running','paused'].includes(world.status)
  const key=JSON.stringify([snapshot?.sceneId,snapshot?.revision,world?.engineId,world?.worldId,world?.worldGeneration,world?.appliedSceneRevision,active,selected])
  if(key!==this.key){this.clear();this.key=key}
  if(snapshot!==this.snapshot||selected!==this.selected){this.byId=new Map(snapshot?.entities.map(entity=>[entity.entityId,entity])??[]);this.selectedIds=new Set(snapshot&&selected?collisionSelectionIds(snapshot,selected):[]);this.selectionOmitted=snapshot&&selected?collisionRequestSelection(snapshot,selected).omitted:0}
  this.snapshot=snapshot;this.world=world;this.selected=selected;this.enabled=enabled
  // 可用世界只显示引擎几何；未装配时的派生预览保留独立来源标签，旧世界不混显示新声明。
  this.preview.setContext(snapshot,this.selectedIds,selected,enabled&&!active)
  this.refreshVisibility()
 }
 private valid():boolean {return Boolean(this.snapshot&&this.world&&['ready','running','paused'].includes(this.world.status)&&this.world.sceneId===this.snapshot.sceneId&&this.world.appliedSceneRevision===this.snapshot.revision)}
 private entityVisible(entityId:string):boolean {
  const seen=new Set<string>()
  let current=this.byId.get(entityId)
  if(!current)return false
  while(current){if(seen.has(current.entityId)||current.components.visual?.visible===false)return false;seen.add(current.entityId);current=current.parentId?this.byId.get(current.parentId):undefined}
  return true
 }
 receive(topology:CollisionTopology):boolean {
  if(!this.valid()||topology.source!==`${this.world?.engineId}-compiled`||topology.worldId!==this.world?.worldId||topology.generation!==this.world.worldGeneration||topology.sceneRevision!==this.snapshot?.revision||topology.stepIndex<this.latestStep)return false
  this.latestStep=topology.stepIndex;this.receipt=topology
  const wanted=new Set<number>()
  for(const geom of topology.geoms){
   if(!geom.ground&&(!geom.entityId||!this.selectedIds.has(geom.entityId)))continue
   wanted.add(geom.geomId)
   if(geom.geometry&&!this.shapes.has(geom.geomId)){
    this.shapes.set(geom.geomId,geom.geometry)
    const geometry=compiledColliderGeometry(geom.geometry)
    if(geometry){
     const object=colliderSurface(geometry,{compiledCollider:true,source:topology.source,geomId:geom.geomId,entityId:geom.entityId,ground:geom.ground,kind:geom.geometry.kind,infinite:geom.geometry.infinite===true,collisionEnabled:geom.collisionEnabled,collisionMask:geom.collisionMask},geom.ground?0x67b8cc:0xffb347,geom.geometry.kind==="convex-hull")
     object.name=geom.name;this.root.add(object);this.objects.set(geom.geomId,object)
    }
   }
   const object=this.objects.get(geom.geomId)
   if(object){object.position.fromArray(geom.positionM);object.quaternion.fromArray(geom.quaternionXyzw);object.userData.collisionMask=geom.collisionMask;setColliderParticipation(object,geom.collisionEnabled);object.updateMatrixWorld(true)}
  }
  for(const [id,object]of this.objects)if(!wanted.has(id)){disposeColliderSurface(object);this.objects.delete(id);this.shapes.delete(id)}
  this.refreshVisibility();return true
 }
 private refreshVisibility():void {
  const preview=this.preview.status()
  this.root.visible=this.enabled&&Boolean(this.selected)&&(this.valid()||preview.geoms>0||preview.pending>0)
  for(const object of this.root.children)object.visible=typeof object.userData.entityId==="string"?this.entityVisible(object.userData.entityId)&&Boolean(this.selected&&this.entityVisible(this.selected)):object.userData.ground===true
 }
 status():CollisionTopologyStatus {
  const rows=this.receipt?.geoms.filter(g=>g.entityId&&this.selectedIds.has(g.entityId))??[]
  const unsupported=rows.filter(g=>(g.geometry??this.shapes.get(g.geomId))?.kind==="unsupported")
  const drawn=rows.filter(geom=>this.objects.has(geom.geomId)).length
  const needsGeometry=this.valid()&&(!this.receipt||rows.some(geom=>!geom.geometry&&!this.shapes.has(geom.geomId)))
  const selectionOmitted=this.valid()?this.selectionOmitted:0
  const common={geoms:rows.length,drawn,inactive:rows.filter(geom=>geom.collisionEnabled===false).length,needsGeometry,selectionOmitted,unsupported:unsupported.length,omitted:this.receipt?.omitted??0,infinitePlanes:this.receipt?.geoms.filter(g=>(g.geometry??this.shapes.get(g.geomId))?.infinite).length??0,reasons:[...new Set(unsupported.map(g=>(g.geometry??this.shapes.get(g.geomId))?.reason).filter((v):v is string=>Boolean(v)))]}
  const preview=this.preview.status()
  const selectedEntities=[...this.selectedIds].flatMap(id=>this.byId.get(id)?[this.byId.get(id)!]:[])
  const declared=selectedEntities.some(entity=>entity.components.collision||entity.components.articulation||entity.components.mujoco||entity.components.isaac||entity.components.newton)
  const generating=selectedEntities.some(entity=>(entity.components.physicsBinding as {status?:string}|undefined)?.status==="PENDING")
  if(this.enabled&&this.selected&&!this.valid()&&(preview.geoms>0||preview.pending>0))return {...common,...preview,status:preview.geoms>0?"preview":"preview-waiting",source:"scene-derived",drawn:preview.geoms,needsGeometry:false,infinitePlanes:0}
  const status:CollisionTopologyStatus["status"]=!this.enabled?"disabled":!this.selected?"unselected":generating&&!this.valid()?"generating":!declared&&!this.valid()?"no-collider":!this.world?"no-world":!this.valid()?"stale-world":!['mujoco','isaac'].includes(this.world.engineId)?"unavailable":!this.receipt||needsGeometry?"waiting":!rows.length?"no-collider":!drawn?"unavailable":"ready"
  if(!this.valid())return {...common,...preview,status,drawn:0,needsGeometry:false}
  return {...common,status,...this.receipt?{source:this.receipt.source}:{}}
 }
 clear():void {
  this.preview.clear()
  for(const object of this.objects.values())disposeColliderSurface(object)
  this.objects.clear();this.shapes.clear();this.receipt=undefined;this.latestStep=-1
 }
 dispose():void {this.clear();this.root.removeFromParent()}
}
