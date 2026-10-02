import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ShapeMeasure,HullMesh } from './geometry/convex-hull.ts'
import type { PrimitiveFit } from './geometry/fit-primitive.ts'
import type { VoxelDetailedResult,VoxelDecomposeOptions } from './geometry/voxel-decompose.ts'

export interface GeometryProgress {mode:string;facts:Record<string,unknown>;node?:string}
function workerPath(){
 const candidates=[new URL('./geometry-worker.js',import.meta.url),new URL('../dist/geometry-worker.js',import.meta.url),...(process.versions.bun?[new URL('./geometry-worker.ts',import.meta.url)]:[])]
 for(const url of candidates)if(existsSync(fileURLToPath(url)))return url
 throw new Error('PROVIDER_UNAVAILABLE: 缺少有界geometry-worker.js，请运行标准build-plugins')
}
/** 每次physicalize持有一个线程，顺序处理节点；父事件循环可立即处理新signal/进度。 */
export class GeometryComputeSession{
 private worker:Worker;private sequence=0;private closed=false
 private closing?:Promise<number>
 private pending?:{id:number;resolve:(result:any)=>void;reject:(error:Error)=>void;node?:string;timer:ReturnType<typeof setTimeout>}
 private signal?:AbortSignal;private progress?: (message:GeometryProgress)=>void
 constructor(options:{signal?:AbortSignal;onProgress?:(message:GeometryProgress)=>void}={}){
  options.signal?.throwIfAborted();this.signal=options.signal;this.progress=options.onProgress
  this.worker=new Worker(workerPath(),{resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:64,stackSizeMb:8},name:'F1-geometry'})
  this.worker.on('message',message=>{
   const pending=this.pending;if(!pending||message.id!==pending.id)return
   if(message.kind==='progress'){this.progress?.({mode:message.mode,facts:message.facts,node:pending.node});return}
   clearTimeout(pending.timer);this.pending=undefined
   if(message.kind==='error')pending.reject(new Error(message.message));else pending.resolve(message.result)
  })
  this.worker.on('error',error=>{if(this.pending)clearTimeout(this.pending.timer);this.pending?.reject(error);this.pending=undefined;this.closed=true;this.signal?.removeEventListener('abort',this.abort)})
  this.worker.on('exit',code=>{this.closed=true;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error('GEOMETRY_WORKER_EXIT: '+code));this.pending=undefined}})
  this.signal?.addEventListener('abort',this.abort,{once:true})
 }
 private abort=()=>{const error=new Error('几何计算已取消');error.name='AbortError';if(this.pending)clearTimeout(this.pending.timer);this.pending?.reject(error);this.pending=undefined;void this.close()}
 async close(){if(this.closing){await this.closing;return}if(this.closed)return;this.closed=true;this.signal?.removeEventListener('abort',this.abort);this.closing=this.worker.terminate();await this.closing}
 private request(mode:string,vertices:Float64Array,faces:Uint32Array,node?:string,extra:Record<string,unknown>={}):Promise<any>{
  this.signal?.throwIfAborted();if(this.closed||this.pending)throw new Error('INVALID_GEOMETRY_WORKER_STATE')
  if(vertices.byteLength+faces.byteLength>64*1024*1024)throw new Error('GEOMETRY_NODE_BUDGET_EXCEEDED')
  // 不夺走调用方数组：只复制这个有界节点，再transfer给计算线程。
  const v=vertices.slice(),f=faces.slice(),id=++this.sequence
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(this.pending?.id!==id)return;this.pending=undefined;reject(new Error(`GEOMETRY_COMPUTE_TIME_BUDGET: ${node??''} ${mode} 超过120000ms`));void this.close()},120000);this.pending={id,resolve,reject,node,timer};this.worker.postMessage({id,mode,vertices:v.buffer,faces:f.buffer,...extra},[v.buffer,f.buffer])})
 }
 measure(vertices:Float64Array,faces:Uint32Array,node?:string):Promise<{measured:ShapeMeasure|undefined;surfaceAreaM2:number}>{return this.request('measure',vertices,faces,node)}
 collider(vertices:Float64Array,faces:Uint32Array,volumeM3:number,node?:string):Promise<{primitive:PrimitiveFit|undefined;exact:HullMesh|undefined}>{return this.request('collider',vertices,faces,node,{volumeM3})}
 voxel(vertices:Float64Array,faces:Uint32Array,options:VoxelDecomposeOptions,node?:string):Promise<VoxelDetailedResult>{return this.request('voxel',vertices,faces,node,{options})}
}
