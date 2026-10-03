import { open, readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

export const GEOMETRY_LIMITS = { maxManifestBytes: 8*1024*1024, maxNodeBytes: 64*1024*1024, maxReadBytes: 8*1024*1024 } as const
export const POINT_MAX_AUTO_VOXEL_M = .03
export interface BinaryArray { path:string;dtype:'f64le'|'u32le';count:number;bytes:number;sha256:string }
export interface GeometryNode {
 node:string;kind?:'mesh'|'point_cloud';watertight:boolean
 position?:BinaryArray;index?:BinaryArray
 /** 旧 worker 仅在小清单预算内兼容，不接受巨型 JSON。 */
 vertices?:number[];faces?:number[];decomposition?:any
 sourceNodeIndex?:number;sourceMeshIndex?:number;sourceWorldMatrix?:number[]
 sourceKind?:'point_cloud';pointCloud?:Record<string,any>
}
export interface GeometrySourceFrame {
 pose:'reference';sourceUpAxis:'Y'|'Z';metersPerUnit:number;derivedUnits:'m';derivedUpAxis:'Z'
 animation:{clips:number;evaluated:false;skinApplied:false}
}

function failure(message:string):never { throw new Error('INVALID_GEOMETRY_TRANSPORT: '+message) }
function checkAbort(signal?:AbortSignal){signal?.throwIfAborted()}
function validateNumbers(vertices:Float64Array,faces:Uint32Array,node:string){
 if(!vertices.length||vertices.length%3||faces.length%3)failure(node+' 坐标/三角索引长度无效')
 for(const value of vertices)if(!Number.isFinite(value))failure(node+' 包含非有限坐标')
 for(const index of faces)if(index>=vertices.length/3)failure(node+' 索引超过实际顶点范围')
}

/** 本次 worker 输出的临时几何依赖。小清单先校身份，每次只持有一个节点的实际二进制。 */
export async function readGeometryManifest(path:string,expected:{outputDirectory:string;sourcePath:string;sourceUpAxis?:'Y'|'Z';metersPerUnit?:number;voxelSizeM?:number;signal?:AbortSignal}){
 checkAbort(expected.signal)
 const directory=await realpath(expected.outputDirectory)
 const within=async(file:string)=>{
  const canonical=await realpath(file)
  if(dirname(canonical)!==directory)failure('产物必须在本次 outputDirectory 内：'+file)
  return canonical
 }
 const manifestPath=await within(path);const facts=await stat(manifestPath)
 if(!facts.isFile()||facts.size>GEOMETRY_LIMITS.maxManifestBytes)throw new Error('GEOMETRY_MANIFEST_BUDGET_EXCEEDED: 清单必须是 ≤8 MiB 的普通文件；旧巨型 JSON 不被读取')
 const manifest:unknown=JSON.parse(await readFile(manifestPath,'utf8'))
 const legacy=Array.isArray(manifest)
 let sourceFrame:GeometrySourceFrame|undefined
 let nodes:GeometryNode[]
 if(legacy)nodes=manifest
 else{
  const value=manifest as any
  if(!value||value.schema!=='lyapunov.geometry.v2'||value.version!==2||!Array.isArray(value.nodes))failure('不支持的 schema/version/nodes')
  if(typeof value.sourcePath!=='string'||await realpath(value.sourcePath)!==await realpath(expected.sourcePath))failure('清单源文件身份不符')
  sourceFrame=value.sourceFrame
  const frame=sourceFrame
  if(!frame||frame.pose!=='reference'||frame.sourceUpAxis!==(expected.sourceUpAxis??'Y')||frame.metersPerUnit!==(expected.metersPerUnit??1)||frame.derivedUnits!=='m'||frame.derivedUpAxis!=='Z'||!Number.isFinite(frame.metersPerUnit)||frame.metersPerUnit<=0||!Number.isSafeInteger(frame.animation?.clips)||frame.animation.clips<0||frame.animation.evaluated!==false||frame.animation.skinApplied!==false)failure('源参考姿态/单位/轴/动画身份不符')
  for(const [name,budget] of Object.entries(GEOMETRY_LIMITS))if(value.limits?.[name]!==budget)failure('清单预算版本不符：'+name)
  nodes=value.nodes
 }
 if(!nodes.length||nodes.length>100000)failure('节点数量无效或超预算')
 const names=new Set<string>()
 for(const node of nodes){
  if(!node||typeof node.node!=='string'||!node.node||node.node.length>4096||names.has(node.node)||typeof node.watertight!=='boolean'||node.kind!==undefined&&!['mesh','point_cloud'].includes(node.kind))failure('节点名称/种类/拓扑声明无效')
  names.add(node.node)
  if(node.sourceWorldMatrix!==undefined&&(!Array.isArray(node.sourceWorldMatrix)||node.sourceWorldMatrix.length!==16||node.sourceWorldMatrix.some(v=>!Number.isFinite(v))))failure('节点源世界矩阵无效')
  if(!legacy&&(node.vertices!==undefined||node.faces!==undefined))failure('v2 清单不允许内联顶点/索引数组')
 }
 let readBytes=0;const verifiedNodes=new Set<GeometryNode>()
 async function binary(spec:BinaryArray|undefined,dtype:'f64le'|'u32le'){
  if(!spec||spec.dtype!==dtype||typeof spec.path!=='string'||!Number.isSafeInteger(spec.count)||spec.count<0||!Number.isSafeInteger(spec.bytes)||spec.bytes!==spec.count*(dtype==='f64le'?8:4)||spec.bytes>GEOMETRY_LIMITS.maxNodeBytes||!/^[0-9a-f]{64}$/.test(spec.sha256))failure('二进制数组 dtype/count/bytes/hash 声明无效')
  const canonical=await within(spec.path);const descriptor=await open(canonical,'r')
  try{
   const facts=await descriptor.stat()
   if(!facts.isFile()||facts.size!==spec.bytes)failure('二进制数组实际字节数不符：'+spec.path)
   const values=dtype==='f64le'?new Float64Array(spec.count):new Uint32Array(spec.count)
   const buffer=Buffer.from(values.buffer);const digest=createHash('sha256')
   for(let offset=0;offset<spec.bytes;){
    checkAbort(expected.signal)
    const size=Math.min(GEOMETRY_LIMITS.maxReadBytes,spec.bytes-offset)
    const {bytesRead}=await descriptor.read(buffer,offset,size,offset)
    if(!bytesRead)failure('二进制数组被截断：'+spec.path)
    digest.update(buffer.subarray(offset,offset+bytesRead));offset+=bytesRead;readBytes+=bytesRead
   }
   if(digest.digest('hex')!==spec.sha256)failure('二进制数组内容 hash 不符：'+spec.path)
   if(new Uint8Array(new Uint16Array([1]).buffer)[0]!==1){
    if(dtype==='f64le')buffer.swap64();else buffer.swap32()
   }
   return values
  }finally{await descriptor.close()}
 }
 async function load(node:GeometryNode):Promise<{vertices:Float64Array;faces:Uint32Array}>{
  checkAbort(expected.signal)
  if(!names.has(node.node)||!nodes.includes(node))failure('节点不属于本次已校清单')
  if(node.kind==='point_cloud'){
   if(!node.decomposition||!Array.isArray(node.decomposition.boxes)||!node.decomposition.boxes.length||node.decomposition.boxes.length>10000||node.position||node.index)failure('点云体素表示无效')
   const pitch=node.decomposition.voxelSizeM,point=node.decomposition.pointCloud
   if(typeof pitch!=='number'||!Number.isFinite(pitch)||pitch<=0)failure('点云体素精度无效')
   if(expected.voxelSizeM!==undefined&&pitch!==expected.voxelSizeM)failure('点云实际精度与本次显式 voxelSizeM 不符')
   if(expected.voxelSizeM!==undefined&&point?.explicitVoxelSize!==true||expected.voxelSizeM===undefined&&point?.explicitVoxelSize===true)failure('点云显式/自动精度身份与本次请求不符')
   if(expected.voxelSizeM===undefined&&point?.explicitVoxelSize!==true&&pitch>POINT_MAX_AUTO_VOXEL_M)throw new Error('POINT_CLOUD_PRECISION_REQUIRED: 自动体素超过 0.03 米，旧/自定义 worker 粗清单不能作为已验证碰撞')
   for(const box of node.decomposition.boxes)if(!Array.isArray(box.center)||!Array.isArray(box.halfExtents)||box.center.length!==3||box.halfExtents.length!==3||box.center.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v))||box.halfExtents.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v)||v<=0))failure('点云体素盒存在非有限/非正范围')
   verifiedNodes.add(node);return{vertices:new Float64Array(),faces:new Uint32Array()}
  }
  let vertices:Float64Array,faces:Uint32Array
  if(legacy){
   if(!Array.isArray(node.vertices)||!Array.isArray(node.faces)||node.vertices.length*8+node.faces.length*4>GEOMETRY_LIMITS.maxNodeBytes||node.vertices.some(v=>!Number.isFinite(v))||node.faces.some(v=>!Number.isSafeInteger(v)||v<0||v>0xffffffff))failure('旧节点数组无效或超预算')
   vertices=new Float64Array(node.vertices);faces=new Uint32Array(node.faces)
  }else{
   if((node.position?.bytes??Infinity)+(node.index?.bytes??Infinity)>GEOMETRY_LIMITS.maxNodeBytes)throw new Error('GEOMETRY_NODE_BUDGET_EXCEEDED: '+node.node+' 超过 64 MiB；未粗化、未跳过')
   vertices=await binary(node.position,'f64le') as Float64Array
   faces=await binary(node.index,'u32le') as Uint32Array
  }
  validateNumbers(vertices,faces,node.node);verifiedNodes.add(node);return{vertices,faces}
 }
 return{nodes,load,get transport(){return{schema:legacy?'lyapunov.geometry.v1':'lyapunov.geometry.v2',version:legacy?1:2,manifestPath,sourceFrame,limits:GEOMETRY_LIMITS,verified:verifiedNodes.size===nodes.length,nodeCount:nodes.length,readBytes}}}
}
