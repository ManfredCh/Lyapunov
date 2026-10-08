/** 原 MJCF 的官方编译参考姿态几何；不创建物理世界、不推进时间、不取 Viewer 或派生碰撞。 */
import {execFile} from 'node:child_process'
import {dirname,join,resolve} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {resolveSdkPython} from '../../lyapunov-product-bundle/src/sdk-python.mjs'
import type {Vec3} from '../../lyapunov-contracts/src/types.ts'

export interface MjcfBoundsResult {
 aabb?:{min:Vec3;max:Vec3}
 boundsFacts:{status:'available'|'unavailable';source:'mjcf-original-geometries';sourceSha256?:string;coordinates:'source-document';units:'document-units';pose:'source-reference-qpos0';dynamicPoseEvaluated:false;simulationSteps:0;runtimeSource?:string;mujocoVersion?:string;geometryScope?:string;bodyCount?:number;geomCount?:number;meshCount?:number;meshVertexCount?:number;excludedWorldGeomCount?:number;excludedPlaneCount?:number;dependencyHashesVerified?:boolean;issue?:string}
}
// 编译器消费原件的 include/default/compiler/mesh 变换，几何只在 qpos0 用一次 forward 读回。
// 请求闭包逐件校验两次；编译期间源变更也不能生成可用 bounds。
const QUERY=String.raw`
import hashlib,json,sys
from pathlib import Path
import numpy as np
import mujoco
req=json.load(sys.stdin)
source=Path(req['path']).resolve()
def verify():
 for row in req['dependencies']:
  p=Path(row['path']).resolve()
  if not p.is_file() or not row.get('sha256'):raise ValueError('MJCF_BOUNDS_DEPENDENCY_UNVERIFIED')
  if p.stat().st_size!=row['size']:raise ValueError('MJCF_BOUNDS_DEPENDENCY_CHANGED')
  with p.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
  if actual!=row['sha256']:raise ValueError('MJCF_BOUNDS_DEPENDENCY_CHANGED')
 if not any(Path(r['path']).resolve()==source for r in req['dependencies']):raise ValueError('MJCF_BOUNDS_SOURCE_NOT_IN_CLOSURE')
verify()
model=mujoco.MjModel.from_xml_path(str(source))
data=mujoco.MjData(model)
mujoco.mj_forward(model,data)
if data.time!=0:raise ValueError('MJCF_BOUNDS_REFERENCE_TIME_CHANGED')
body_geoms=[i for i in range(model.ngeom) if int(model.geom_bodyid[i])!=0]
# 有本体时 world 层几何不属于该本体；只有 worldbody 几何的合法资源仍测其有限原图元。
ids=body_geoms if body_geoms else list(range(model.ngeom))
lo=np.full(3,np.inf);hi=np.full(3,-np.inf);count=0;mesh_ids=set();vertices=0;planes=0
for i in ids:
 kind=int(model.geom_type[i]);p=np.asarray(data.geom_xpos[i],float);r=np.asarray(data.geom_xmat[i],float).reshape(3,3);size=np.asarray(model.geom_size[i],float)
 if not np.isfinite(p).all() or not np.isfinite(r).all() or not np.isfinite(size).all():raise ValueError('MJCF_BOUNDS_GEOMETRY_NONFINITE')
 if kind==int(mujoco.mjtGeom.mjGEOM_PLANE):planes+=1;continue
 if kind==int(mujoco.mjtGeom.mjGEOM_MESH):
  mid=int(model.geom_dataid[i]);start=int(model.mesh_vertadr[mid]);n=int(model.mesh_vertnum[mid])
  if n<=0:raise ValueError('MJCF_BOUNDS_MESH_EMPTY')
  mesh_ids.add(mid);vertices+=n
  for at in range(start,start+n,32768):
   points=np.asarray(model.mesh_vert[at:min(at+32768,start+n)],float)@r.T+p
   if not np.isfinite(points).all():raise ValueError('MJCF_BOUNDS_MESH_NONFINITE')
   lo=np.minimum(lo,points.min(axis=0));hi=np.maximum(hi,points.max(axis=0))
 else:
  if kind==int(mujoco.mjtGeom.mjGEOM_BOX):extent=np.abs(r)@size
  elif kind==int(mujoco.mjtGeom.mjGEOM_SPHERE):extent=np.full(3,size[0])
  elif kind==int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):extent=np.sqrt((r*r)@(size*size))
  elif kind==int(mujoco.mjtGeom.mjGEOM_CYLINDER):extent=size[0]*np.sqrt(r[:,0]**2+r[:,1]**2)+size[1]*np.abs(r[:,2])
  elif kind==int(mujoco.mjtGeom.mjGEOM_CAPSULE):extent=size[0]+size[1]*np.abs(r[:,2])
  else:raise ValueError('MJCF_BOUNDS_GEOMETRY_UNSUPPORTED: '+str(kind))
  if not np.isfinite(extent).all() or np.any(extent<0):raise ValueError('MJCF_BOUNDS_GEOMETRY_INVALID')
  lo=np.minimum(lo,p-extent);hi=np.maximum(hi,p+extent)
 count+=1
if count==0 or not np.isfinite(lo).all() or not np.isfinite(hi).all() or np.any(lo>hi):raise ValueError('MJCF_BOUNDS_FINITE_GEOMETRY_EMPTY')
verify()
print(json.dumps({'aabb':{'min':lo.tolist(),'max':hi.tolist()},'facts':{'mujocoVersion':mujoco.__version__,'geometryScope':'source-body-geometries' if body_geoms else 'finite-worldbody-only-geometries','bodyCount':int(model.nbody)-1,'geomCount':count,'meshCount':len(mesh_ids),'meshVertexCount':vertices,'excludedWorldGeomCount':model.ngeom-len(ids),'excludedPlaneCount':planes,'dependencyHashesVerified':True}},allow_nan=False))
`
export async function mjcfOriginalBounds(path:string,dependencies:readonly {path:string;size:number;sha256?:string}[]):Promise<MjcfBoundsResult>{
 const facts:MjcfBoundsResult['boundsFacts']={status:'unavailable',source:'mjcf-original-geometries',coordinates:'source-document',units:'document-units',pose:'source-reference-qpos0',dynamicPoseEvaluated:false,simulationSteps:0,sourceSha256:dependencies.find(d=>resolve(d.path)===resolve(path))?.sha256}
 try{
  const runtime=resolveSdkPython(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),'mujoco');facts.runtimeSource=runtime.source
  // 官方解析器可能输出MUJOCO_LOG；工作目录只用本次新scratch，绝不写原件目录。
  const scratch=await mkdtemp(join(tmpdir(),'lya-mjcf-bounds-'))
  let response:string
  try{response=await new Promise<string>((done,reject)=>{
   const child=execFile(runtime.python,['-I','-B','-c',QUERY],{cwd:scratch,timeout:30000,maxBuffer:65536,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout,stderr)=>error?reject(Error('MJCF_BOUNDS_QUERY_FAILED: '+(String(stderr).trim()||error.message).slice(-1800))):done(String(stdout)))
   child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify({path:resolve(path),dependencies:dependencies.map(d=>({path:resolve(d.path),size:d.size,sha256:d.sha256}))}))
  })}finally{await rm(scratch,{recursive:true,force:true})}
  const value=JSON.parse(response),box=value.aabb
  if(!box||![box.min,box.max].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite))||box.min.some((v:number,i:number)=>v>box.max[i])||value.facts?.dependencyHashesVerified!==true)throw Error('MJCF_BOUNDS_INVALID_RESPONSE')
  return {aabb:box,boundsFacts:{...facts,...value.facts,status:'available'}}
 }catch(error){return {boundsFacts:{...facts,issue:error instanceof Error?error.message:String(error)}}}
}
