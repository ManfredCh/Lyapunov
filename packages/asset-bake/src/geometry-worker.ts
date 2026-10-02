/** 单任务有界计算线程；生产经标准构建生成相邻JS，Bun源测试走本文件。 */
import { parentPort } from 'node:worker_threads'
import { measureShape,convexHull } from './geometry/convex-hull.ts'
import { fitPrimitive } from './geometry/fit-primitive.ts'
import { decomposeConcaveToBoxesDetailed } from './geometry/voxel-decompose.ts'
if(!parentPort)throw new Error('GEOMETRY_WORKER_REQUIRES_PORT')
parentPort.on('message',request=>{
 const {id,mode}=request
 try{
  const vertices=new Float64Array(request.vertices),faces=new Uint32Array(request.faces)
  if(vertices.byteLength+faces.byteLength>64*1024*1024)throw new Error('GEOMETRY_NODE_BUDGET_EXCEEDED')
  const progress=(facts:unknown)=>parentPort!.postMessage({id,kind:'progress',mode,facts})
  progress({stage:'started',vertices:vertices.length/3,faces:faces.length/3})
  let result:unknown
  if(mode==='voxel')result=decomposeConcaveToBoxesDetailed(vertices,faces,request.options,progress)
  else if(mode==='measure'){
   const measured=measureShape(vertices,faces);let area=0
   for(let i=0;i+2<faces.length;i+=3){const a=faces[i]*3,b=faces[i+1]*3,c=faces[i+2]*3,ux=vertices[b]-vertices[a],uy=vertices[b+1]-vertices[a+1],uz=vertices[b+2]-vertices[a+2],vx=vertices[c]-vertices[a],vy=vertices[c+1]-vertices[a+1],vz=vertices[c+2]-vertices[a+2];area+=Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)/2}
   result={measured,surfaceAreaM2:area}
  }else if(mode==='collider'){
   const primitive=fitPrimitive(vertices,request.volumeM3);const exact=primitive?undefined:convexHull(vertices)
   result={primitive,exact:exact&&exact.faces.length/3<=64?exact:undefined}
  }else throw new Error('INVALID_GEOMETRY_WORKER_MODE')
  parentPort!.postMessage({id,kind:'result',result})
 }catch(error){parentPort!.postMessage({id,kind:'error',message:String(error),stack:error instanceof Error?error.stack:undefined})}
})
