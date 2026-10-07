/** URDF 原坐标、初始零关节的真实可视顶点范围；不启动引擎、不推断站立高度或可达范围。 */
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {dirname,extname,resolve} from 'node:path'
import {Box3,BoxGeometry,BufferGeometry,CylinderGeometry,Euler,Matrix4,Quaternion,SphereGeometry,Vector3} from 'three'
import {STLLoader} from 'three/addons/loaders/STLLoader.js'
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js'
import type {Vec3} from '../../lyapunov-contracts/src/types.ts'

const list=(value:any):any[]=>value===undefined?[]:Array.isArray(value)?value:[value]
const vectors=(value:unknown,fallback:number[],field:string):number[]=>{
 const row=value===undefined?fallback:typeof value==='string'?value.trim().split(/\s+/).map(Number):[]
 if(row.length!==fallback.length||row.some(n=>!Number.isFinite(n)))throw Error('URDF_BOUNDS_INVALID_VALUE: '+field)
 return row
}
const positive=(value:unknown,field:string):number=>{
 const n=typeof value==='string'&&value.trim()?Number(value):NaN
 if(!Number.isFinite(n)||n<=0)throw Error('URDF_BOUNDS_INVALID_VALUE: '+field)
 return n
}
function origin(value:any):Matrix4{
 const p=vectors(value?.xyz,[0,0,0],'origin.xyz'),r=vectors(value?.rpy,[0,0,0],'origin.rpy')
 // URDF 固定轴 roll/pitch/yaw；复用 Three 的矩阵/四元数实现，不另写旋转公式。
 return new Matrix4().compose(new Vector3(...p as Vec3),new Quaternion().setFromEuler(new Euler(r[0],r[1],r[2],'ZYX')),new Vector3(1,1,1))
}
export interface UrdfBoundsResult {
 aabb?:{min:Vec3;max:Vec3}
 boundsFacts:{status:'available'|'unavailable';source:'urdf-visual-vertices';sourceSha256?:string;coordinates:'source-document';units:'document-units';pose:'zero-joint-initial';dynamicPoseEvaluated:false;linkCount:number;visualCount:number;meshCount:number;vertexCount:number;meshSources:{path:string;sha256:string}[];issue?:string}
}
/** 复用已注册依赖闭包、现 Three STL/OBJ 解码器；任何缺件或未知几何均不交部分 bbox。 */
export async function urdfVisualBounds(document:any,path:string,dependencies:readonly {path:string;sha256?:string}[]):Promise<UrdfBoundsResult>{
 const facts:UrdfBoundsResult['boundsFacts']={status:'unavailable',source:'urdf-visual-vertices',coordinates:'source-document',units:'document-units',pose:'zero-joint-initial',dynamicPoseEvaluated:false,linkCount:0,visualCount:0,meshCount:0,vertexCount:0,meshSources:[]}
 facts.sourceSha256=dependencies.find(row=>resolve(row.path)===resolve(path))?.sha256
 try{
  const links=new Map<string,any>()
  for(const link of list(document.link)){
   if(typeof link.name!=='string'||!link.name||links.has(link.name))throw Error('URDF_BOUNDS_INVALID_TREE: Missing or duplicate link')
   links.set(link.name,link)
  }
  facts.linkCount=links.size
  const children=new Map<string,{child:string;matrix:Matrix4}[]>(),parents=new Set<string>(),jointNames=new Set<string>()
  for(const joint of list(document.joint)){
   const parent=joint.parent?.link,child=joint.child?.link
   if(typeof joint.name!=='string'||!joint.name||jointNames.has(joint.name)||!links.has(parent)||!links.has(child)||parents.has(child)||parent===child)throw Error('URDF_BOUNDS_INVALID_TREE: Invalid joint linkage')
   if(!['fixed','revolute','continuous','prismatic','floating','planar'].includes(joint.type)||joint.mimic)throw Error('URDF_BOUNDS_JOINT_UNSUPPORTED: '+String(joint.type))
   jointNames.add(joint.name);parents.add(child)
   children.set(parent,[...children.get(parent)??[],{child,matrix:origin(joint.origin)}])
  }
  const roots=[...links.keys()].filter(name=>!parents.has(name))
  if(roots.length!==1)throw Error('URDF_BOUNDS_INVALID_TREE: Expected one root link')
  const frames=new Map<string,Matrix4>()
  const walk=(name:string,parent:Matrix4):void=>{
   if(frames.has(name))throw Error('URDF_BOUNDS_INVALID_TREE: Link cycle')
   frames.set(name,parent)
   for(const entry of children.get(name)??[])walk(entry.child,parent.clone().multiply(entry.matrix))
  }
  walk(roots[0]!,new Matrix4())
  if(frames.size!==links.size)throw Error('URDF_BOUNDS_INVALID_TREE: Disconnected or cyclic links')
  const admitted=new Map(dependencies.map(row=>[resolve(row.path),row.sha256])),cache=new Map<string,{geometry:BufferGeometry;matrix:Matrix4}[]>(),bounds=new Box3(),point=new Vector3()
  const take=(geometry:BufferGeometry,matrix:Matrix4):void=>{
   const vertices=geometry.getAttribute('position')
   if(!vertices?.count)throw Error('URDF_BOUNDS_GEOMETRY_EMPTY')
   for(let i=0;i<vertices.count;i++){
    point.fromBufferAttribute(vertices,i).applyMatrix4(matrix)
    if(![point.x,point.y,point.z].every(Number.isFinite))throw Error('URDF_BOUNDS_GEOMETRY_INVALID')
    bounds.expandByPoint(point)
   }
   facts.vertexCount+=vertices.count
  }
  for(const [name,link] of links)for(const visual of list(link.visual)){
   facts.visualCount++
   const geometry=visual.geometry,matrix=frames.get(name)!.clone().multiply(origin(visual.origin))
   if(geometry?.mesh){
    const filename=geometry.mesh.filename
    if(typeof filename!=='string'||!filename||/^[a-z][a-z+.-]*:/i.test(filename))throw Error('URDF_BOUNDS_MESH_URI_UNSUPPORTED')
    const meshPath=resolve(dirname(path),filename),format=extname(meshPath).toLowerCase()
    if(!admitted.has(meshPath))throw Error('URDF_BOUNDS_MESH_NOT_IN_DEPENDENCY_CLOSURE')
    const scale=vectors(geometry.mesh.scale,[1,1,1],'mesh.scale')
    if(scale.some(n=>n<=0))throw Error('URDF_BOUNDS_INVALID_VALUE: mesh.scale must be positive')
    let pieces=cache.get(meshPath)
    if(!pieces){
     const bytes=await readFile(meshPath)
     const sha256=createHash('sha256').update(bytes).digest('hex'),expected=admitted.get(meshPath)
     if(expected!==undefined&&sha256!==expected)throw Error('URDF_BOUNDS_DEPENDENCY_CHANGED')
     facts.meshSources.push({path:filename,sha256})
     if(format==='.stl')pieces=[{geometry:new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),matrix:new Matrix4()}]
     else if(format==='.obj'){
      pieces=[];const object=new OBJLoader().parse(bytes.toString('utf8'));object.updateMatrixWorld(true)
      object.traverse(node=>{const mesh=node as typeof node&{geometry?:BufferGeometry};if(mesh.geometry)pieces!.push({geometry:mesh.geometry,matrix:node.matrixWorld.clone()})})
     }else throw Error('URDF_BOUNDS_MESH_FORMAT_UNSUPPORTED: '+format)
     if(!pieces.length)throw Error('URDF_BOUNDS_GEOMETRY_EMPTY')
     cache.set(meshPath,pieces)
    }
    facts.meshCount++
    matrix.multiply(new Matrix4().makeScale(scale[0]!,scale[1]!,scale[2]!))
    for(const piece of pieces)take(piece.geometry,matrix.clone().multiply(piece.matrix))
   }else{
    let primitive:BufferGeometry
    if(geometry?.box){
     const size=vectors(geometry.box.size,[NaN,NaN,NaN],'box.size')
     if(size.length!==3||size.some(n=>n<=0))throw Error('URDF_BOUNDS_INVALID_VALUE: box.size')
     primitive=new BoxGeometry(...size as Vec3)
    }else if(geometry?.sphere)primitive=new SphereGeometry(positive(geometry.sphere.radius,'sphere.radius'),24,16)
    else if(geometry?.cylinder)primitive=new CylinderGeometry(positive(geometry.cylinder.radius,'cylinder.radius'),positive(geometry.cylinder.radius,'cylinder.radius'),positive(geometry.cylinder.length,'cylinder.length'),24).rotateX(Math.PI/2)
    else throw Error('URDF_BOUNDS_GEOMETRY_UNSUPPORTED')
    try{take(primitive,matrix)}finally{primitive.dispose()}
   }
  }
  for(const pieces of cache.values())for(const piece of pieces)piece.geometry.dispose()
  if(!facts.visualCount||bounds.isEmpty())throw Error('URDF_BOUNDS_VISUAL_EMPTY')
  facts.status='available'
  return {aabb:{min:bounds.min.toArray() as Vec3,max:bounds.max.toArray() as Vec3},boundsFacts:facts}
 }catch(error){facts.issue=error instanceof Error?error.message:String(error);return {boundsFacts:facts}}
}
