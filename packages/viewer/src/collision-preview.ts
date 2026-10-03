import * as THREE from "three"
import {OBJLoader} from "three/addons/loaders/OBJLoader.js"
import type {Entity,ResourceRef,SceneSnapshot} from "../../lyapunov-contracts/src/types.ts"
import {colliderSurface,disposeColliderSurface} from "./collision-surface.ts"

export interface CollisionPreviewOptions {resolveResource?:(uri:string,resource?:ResourceRef)=>string|Promise<string>}
const MAX_SHAPES=256,MAX_BYTES=8*1024*1024,MAX_TOTAL_BYTES=16*1024*1024,MAX_VERTICES=200000
const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined
const vector=(value:unknown,positive=false):[number,number,number]|undefined=>Array.isArray(value)&&value.length===3&&value.every(n=>typeof n==="number"&&Number.isFinite(n)&&(!positive||n>0))?value as [number,number,number]:undefined
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>record(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const geometryFields=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([field])=>!["enabled","friction","material","solref","solimp"].includes(field)))

/** 已绑定同版本派生件的预览资格；标记本身不足，几何声明与绑定基线也必须相同。 */
export function verifiedCollisionPreviewRef(entity:Entity):ResourceRef|undefined {
 const binding=record(entity.components.physicsBinding),collision=record(entity.components.collision),derived=record(record(binding?.derivedComponents)?.collision)
 if(binding?.status!=="BOUND"||!collision||!derived||!String(collision.source??"").startsWith("asset-bake-")||canonical(geometryFields(collision))!==canonical(geometryFields(derived)))return
 return entity.resources.find(ref=>ref.resourceId===binding.resourceId&&ref.version===binding.version)
}

/** 预览以声明数据帧落位；父层旋转、负缩放和偏心中心都通过完整 Scene 矩阵，只应用一次。 */
function worldMatrix(entity:Entity,byId:Map<string,Entity>,seen=new Set<string>()):THREE.Matrix4 {
 if(seen.has(entity.entityId))throw Error("碰撞预览的场景父链成环")
 seen.add(entity.entityId)
 const t=entity.transform
 if(!vector(t.position)||!vector(t.scale)||t.scale.some(n=>n===0)||!Array.isArray(t.quaternion)||t.quaternion.length!==4||t.quaternion.some(n=>!Number.isFinite(n)))throw Error("碰撞预览的实例变换无效")
 const q=new THREE.Quaternion(...t.quaternion)
 if(q.lengthSq()<1e-12)throw Error("碰撞预览的实例朝向无效")
 const local=new THREE.Matrix4().compose(new THREE.Vector3(...t.position),q.normalize(),new THREE.Vector3(...t.scale))
 if(!entity.parentId)return local
 const parent=byId.get(entity.parentId)
 if(!parent)throw Error("碰撞预览缺少父节点")
 return worldMatrix(parent,byId,seen).multiply(local)
}

async function boundedText(response:Response,signal:AbortSignal,limit:number):Promise<{text:string;bytes:number}> {
 if(!response.ok||!response.body)throw Error("已登记碰撞派生件无法读取")
 if(Number(response.headers.get("content-length"))>limit){await response.body.cancel();throw Error("碰撞派生件超过预览读取预算")}
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0
 try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw Error("碰撞派生件超过预览读取预算");parts.push(next.value)}}finally{await reader.cancel().catch(()=>undefined)}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
 return {text:new TextDecoder().decode(bytes),bytes:size}
}

/** 仅在世界未装配时绘制可信派生件。ready 世界绝不与预览混合，迟到异步件不能写回新选择。 */
export class CollisionPreviewLayer {
 private objects:THREE.Group[]=[]
 private key=""
 private controller?:AbortController
 private pending=0
 private unsupported=0
 private omitted=0
 private reasons=new Set<string>()
 private current?:SceneSnapshot
 constructor(private root:THREE.Group,private options:CollisionPreviewOptions={},private changed:()=>void=()=>{}){}
 setContext(snapshot:SceneSnapshot|undefined,ids:Set<string>,selected:string|undefined,allow:boolean):void {
  const key=allow&&snapshot&&selected?JSON.stringify([snapshot.sceneId,snapshot.revision,selected,[...ids]]):""
  if(key===this.key&&snapshot===this.current)return
  this.clear();this.key=key;this.current=snapshot
  if(!key||!snapshot)return
  const controller=new AbortController();this.controller=controller
  const byId=new Map(snapshot.entities.map(entity=>[entity.entityId,entity]))
  let count=0,totalBytes=0,totalVertices=0,queue=Promise.resolve()
  for(const entity of snapshot.entities){
   if(!ids.has(entity.entityId))continue
   const ref=verifiedCollisionPreviewRef(entity)
   if(!ref)continue
   const collision=entity.components.collision!,shape=String(collision.shape??collision.type??"")
   let matrix:THREE.Matrix4
   try{matrix=worldMatrix(entity,byId)}catch(error){this.unsupported++;this.reasons.add((error as Error).message);continue}
   const add=(geometry:THREE.BufferGeometry,center:[number,number,number],kind:string,triangles=false)=>{
    const object=colliderSurface(geometry,{entityId:entity.entityId,kind,source:"scene-derived",compiledCollider:false,collisionPreview:true,resourceId:ref.resourceId,resourceVersion:ref.version,collisionEnabled:collision.enabled!==false},0x8dd1ef,triangles)
    object.name=`${entity.name} · 待引擎装配的碰撞预览`;object.matrixAutoUpdate=false;object.matrix.copy(matrix).multiply(new THREE.Matrix4().makeTranslation(...center));this.root.add(object);this.objects.push(object);object.updateMatrixWorld(true);this.changed()
   }
   const primitives=Array.isArray(collision.shapes)?collision.shapes:shape==="mesh"?[]:[collision]
   for(const candidate of primitives){
    if(count++>=MAX_SHAPES){this.omitted++;continue}
    const value=record(candidate),half=vector(value?.halfExtents,true),center=vector(value?.center??[0,0,0])
    const kind=Array.isArray(collision.shapes)?"box":shape
    if(!half||!center){this.unsupported++;this.reasons.add("已绑定碰撞声明缺少有效尺寸或中心");continue}
    const geometry=kind==="box"?new THREE.BoxGeometry(2*half[0],2*half[1],2*half[2]):kind==="sphere"?new THREE.SphereGeometry(half[0],24,16):kind==="cylinder"?new THREE.CylinderGeometry(half[0],half[0],2*half[1],24).rotateX(Math.PI/2):undefined
    if(geometry)add(geometry,center,kind);else{this.unsupported++;this.reasons.add("该派生形状需要引擎装配后读取实际拓扑")}
   }
   if(shape!=="mesh")continue
   // 只展示已登记的凸包/凸分解件；表面、SDF 与未知策略等待引擎实际拓扑，不猜消费结果。
   const binding=record(entity.components.physicsBinding),parts=collision.parts
   if(collision.source!=="asset-bake-hull"||!["convex_hull","coacd","auto"].includes(String(binding?.strategy))||!Array.isArray(parts)||!this.options.resolveResource){this.unsupported++;this.reasons.add("网格碰撞需要引擎装配后读取实际拓扑");continue}
   for(const uri of parts){
    if(count++>=MAX_SHAPES){this.omitted++;continue}
    if(typeof uri!=="string"||!ref.representations.some(rep=>rep.role==="collision"&&rep.uri===uri&&rep.mimeType==="model/obj")){this.unsupported++;this.reasons.add("碰撞网格未登记在当前资源版本");continue}
    this.pending++
    // 单流、整次字节/顶点预算；世界/选择/版本变更时 abort，只有本次件可以加入图层。
    queue=queue.then(async()=>{
     controller.signal.throwIfAborted()
     if(totalBytes>=MAX_TOTAL_BYTES||totalVertices>=MAX_VERTICES)throw Error("碰撞网格超过整次预览预算")
     const reservation=Math.min(MAX_BYTES,MAX_TOTAL_BYTES-totalBytes)
     totalBytes+=reservation // 失败读取同样占用整次预算，不能靠无效/超大件反复读取洗掉预算。
     const part=await this.loadPart(uri,ref,controller.signal,reservation,MAX_VERTICES-totalVertices)
     totalBytes-=reservation-part.bytes;totalVertices+=part.geometry.getAttribute("position").count
     if(this.controller!==controller){part.geometry.dispose();return}
     add(part.geometry,[0,0,0],"derived-mesh",true)
    }).catch(()=>{if(this.controller===controller){this.unsupported++;this.reasons.add("已登记碰撞网格缺件、无效或超过预览预算")}}).finally(()=>{if(this.controller===controller){this.pending--;this.changed()}})
   }
  }
 }
 private async loadPart(uri:string,ref:ResourceRef,signal:AbortSignal,byteLimit:number,vertexLimit:number):Promise<{geometry:THREE.BufferGeometry;bytes:number}> {
  const url=await this.options.resolveResource!(uri,ref);signal.throwIfAborted()
  const data=await boundedText(await fetch(url,{signal}),signal,byteLimit);signal.throwIfAborted()
  const parsed=new OBJLoader().parse(data.text),geometries:THREE.BufferGeometry[]=[]
  try{
   parsed.updateMatrixWorld(true)
   let vertices=0
   parsed.traverse(object=>{if(object instanceof THREE.Mesh){const position=object.geometry.getAttribute("position");vertices+=position.count;if(vertices>vertexLimit)throw Error("碰撞网格超过顶点预算");const geometry=object.geometry.clone().applyMatrix4(object.matrixWorld);geometry.deleteAttribute("normal");geometry.deleteAttribute("uv");geometries.push(geometry)}})
   if(!vertices||geometries.length!==1)throw Error("已登记凸包件的网格结构无效")
   const geometry=geometries[0]!
   const values=geometry.getAttribute("position").array
   if(Array.from(values).some(value=>!Number.isFinite(value)))throw Error("碰撞网格顶点无效")
   geometries.length=0;return {geometry,bytes:data.bytes}
  }finally{for(const geometry of geometries)geometry.dispose();parsed.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose()}})}
 }
 status(){return {geoms:this.objects.length,pending:this.pending,unsupported:this.unsupported,omitted:this.omitted,reasons:[...this.reasons]}}
 clear():void {this.controller?.abort();this.controller=undefined;for(const object of this.objects)disposeColliderSurface(object);this.objects=[];this.pending=0;this.unsupported=0;this.omitted=0;this.reasons.clear();this.key="";this.current=undefined}
 dispose():void {this.clear()}
}
