import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { physicalize } from './physicalize.ts'
import { resolveBakeRoute,resolveWorkerPath } from './operations.ts'
export const name='lyapunov-asset-bake'
/** 结果行前缀；bake.py 当前打印无前缀的单行 JSON，这里只在它出现时按真实长度截断（不得写死数字）。 */
const RESULT_PREFIX='LYAPUNOV_RESULT='
export const inject=['tools','jobs','subprocess']
export interface Config {
  /** 隔离算法解释器：显式配置优先（隔离/后台 Host 里没有 LYAPUNOV_ALGORITHM_PYTHON，靠它传入）。 */
  python?: string
  /** 算法 worker 路径；缺省按 resolveWorkerPath 与本模块同目录解析（产物自带，不写死绝对路径）。 */
  workerPath?: string
}
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { lyapunov_provider:'lyapunov-provider' } }
export function apply(ctx:Context,config:Config={}){
 ctx.tools.register(defineTool({name:'asset_bake',description:"Generate independent collision derivations from source models. PLY point clouds without triangles use strategy:auto/voxel_boxes to represent occupied actual XYZ samples without filling interiors or substituting whole bbox for geometry. Explicit strategy selects high-level per-node physicalization (mass/materials, hulls, voxel cavities, CoACD); explicit method selects basic low-level geometry export. Environments retain per-object surfaces; usage=environment alone also follows the high-level default route without fixing a representation.",parameters:{request_json:{type:'string',required:true,description:"sourcePath (local absolute path or file URI)/outputDirectory/sourceUpAxis/metersPerUnit. Triangle-free PLY clouds use strategy:auto/voxel_boxes; ordinary faceless clouds reject triangle_mesh/coacd/convex_hull. Only explicit usage=static/environment, strategy=triangle_mesh, voxelSizeM and pointCloudTiling.coverage=full can output full-source occupied-sample voxel boundaries (voxel_surface): an approximation at the selected precision, not original-surface reconstruction. Only Isaac explicit static approximation=none is supported; MuJoCo rejects it without engine switching. Read XYZ only in 32768-point chunks. voxelSizeM fixes metres; maxBoxes defaults to 2048, maximum 10000; maxOccupiedVoxels defaults to 250000, maximum 1000000. Exceeding budget fails explicitly. Full-domain parameters: pointCloudTiling:{coverage:full,tileSizeCells:64,maxTotalOccupiedVoxels:2000000,maxTotalBoxes:10000,maxTiles:16384,maxDiskBytes:2147483648}. Every capacity participates in variant identity; maxTotalBoxes constrains boxes only. Full triangle surfaces allow at most 10000 parts, each 64MiB; SQLite/binary/OBJ/manifest share the total-disk limit. Never publish partial success. Without fixed precision, bounded automatic lattice selection is allowed; pointCloud/decomposition records actual resolution/counts/source bounds/stage timing/coverage limits. Do not claim unscanned regions have complete collision surfaces. method exports basic triangle_mesh/convex_hull/coacd exactly as selected without per-node rerouting. strategy invokes high-level physicalize (auto/triangle_mesh/convex_hull/voxel_boxes/coacd, with material/usage/voxelSizeM) and returns per-node decisions/reroutes/receipts. Explicit strategy, including auto, takes the high-level route; usage=environment without method/strategy also uses the strategy:auto route and records strategy=auto, static/environment auto chooses exact hull-equivalent surfaces and unfilled surface voxel boxes for every other triangle surface, including concave, reversed and touching closed shells. Every source triangle participates; actual fillInterior, sourceTriangles and voxelSizeM are recorded. Fixed precision and total box/work budgets fail explicitly; no automatic coarsening or hull fallback. Explicit method without strategy uses the low-level route unchanged. When both are supplied, strategy takes precedence and method is ineffective. environment explicit strategies export as requested; convex_hull/sdf are rejected. Environmental voxelSizeM fixes surface precision with same-lattice tiling."},background:{type:'boolean',description:"Run in the background through DSH Jobs."}},output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,v)=>[{type:'text',text:v.result}]},async execute(args,exec){
  const python=config.python??process.env.LYAPUNOV_ALGORITHM_PYTHON;if(!python)throw new Error('PROVIDER_UNAVAILABLE: 缺少 LYAPUNOV_ALGORITHM_PYTHON')
  const request=JSON.parse(args.request_json)
  // 公开分流（口径与理由见 resolveBakeRoute）：显式 strategy → 高层 physicalize；只给 usage=environment →
  // 同一条高层默认路线（补 strategy:'auto'，与显式 auto 同一路）；显式 method / 普通请求 → 低层基础几何导出。
  // 这里判定一次，前台与后台共用下面这条 run，没有第二处分支。
  const route=resolveBakeRoute(request)
  const run=async(signal:AbortSignal)=>{
   const execute=async(data:Record<string,unknown>)=>{
    const child=ctx.subprocess.spawn({argv:[python,resolveWorkerPath(config.workerPath)],cwd:process.cwd(),stdio:{stdin:{data:JSON.stringify(data)},stdout:{maxBytes:4000000},stderr:{maxBytes:200000}},graceMs:2000,signal,env:{HF_ENDPOINT:'https://hf-mirror.com'}});const outcome=await child.done;const out=child.collected.stdout?.readFrom(0).text??''
    if(outcome.exitCode!==0)throw new Error(`${outcome.exitCode===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${out||child.collected.stderr?.readFrom(0).text}`)
    const lines=out.trim().split('\n'),prefixed=lines.slice().reverse().find(v=>v.startsWith(RESULT_PREFIX))
    const line=(prefixed?prefixed.slice(RESULT_PREFIX.length):lines.at(-1))!
    // 前缀长度必须由常量推导；解析不了的输出是失败，不是结果。
    try{return JSON.parse(line)}catch{throw new Error(`PROVIDER_FAILED: bake.py 结果不是合法 JSON（stdout 尾部：${out.slice(-500)}）`)}
   }
   return route.physicalize?physicalize(route.injectStrategy?{...request,strategy:route.injectStrategy}:request,{python,signal,execute}):execute(request)
  }
  if(!args.background)return {result:JSON.stringify(await run(exec.signal))}
  if(exec.signal.aborted)throw exec.signal.reason??new Error('Cancelled before background Job registration');const controller=new AbortController();const jobId=ctx.jobs.start({kind:'lyapunov-provider',label:'asset_bake',owner:exec.agent?.id,run:()=>({cancel:()=>controller.abort(),done:run(controller.signal).then(value=>({status:'completed' as const,result:JSON.stringify(value)}),error=>({status:controller.signal.aborted?'killed' as const:'failed' as const,result:String(error)}))})});return {result:JSON.stringify({jobId})}
 }}))
}
