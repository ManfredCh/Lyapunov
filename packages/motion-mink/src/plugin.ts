import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { fileURLToPath } from 'node:url'
export const name='lyapunov-motion-mink'
/** 算法解释器结果行的稳定前缀；长度只在这里定义，解析方不得硬编码数字。 */
const RESULT_PREFIX='LYAPUNOV_RESULT='
export const inject=['tools','jobs','subprocess']
export interface Config { python?: string }
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { lyapunov_provider:'lyapunov-provider' } }

// ---- 模型可见入参：结构化 plan（主路径）与 request_json（兼容既有调用方）二选一 ----
const required=<T extends object>(schema:T)=>({...schema,required:true as const})
const text=(description:string)=>({type:'string' as const,description})
const number=(description:string)=>({type:'number' as const,description})
const integer=(description:string)=>({type:'integer' as const,description})
const vector=(description:string)=>({type:'array' as const,items:number("Numeric component, in meters or dimensionless quaternion units."),description})
const numberVector=(description:string)=>({type:'array' as const,items:number("One numeric value."),description})
const nameVector=(description:string)=>({type:'array' as const,items:text("Joint name."),description})
const tcp=required({type:'object' as const,additionalProperties:false,description:"TCP definition: a body name in the source model and an optional local offset.",
  properties:{body:required(text("Source-model body used as the TCP, without an entity prefix.")),
    offsetM:vector("TCP translation relative to this body, in meters; omission uses the body origin."),
    quaternionXyzw:vector("Normalized local TCP orientation relative to the body, in xyzw order; omission uses the identity quaternion."),
    site:text("Optional real source site name, which must belong to the body; supplying a site uses its complete local pose.")}})
const targetPose=required({type:'object' as const,additionalProperties:false,description:"Target TCP world pose. Supply a Cartesian target; IK computes the joint trajectory.",
  properties:{position:required(vector("Target position in meters, in the right-handed Z-up frame.")),
    quaternionXyzw:required(vector("Target orientation quaternion in fixed [x,y,z,w] order; prior normalization is not required."))}})
// plan 与 request_json 都不标 required：二选一由 motionRequest 在运行期显式裁决，
// 标成根级必填会让 request_json 兼容路径（robot_pick/robot_place 的内部规划）在校验阶段就被拒。
const plan={type:'object' as const,additionalProperties:false,description:"Structured planning request, mutually exclusive with request_json. Use SI units: meters and seconds, with quaternions in fixed [x,y,z,w] order.",
  properties:{
    modelPath:required(text("Path to the original robot model (MJCF/URDF). Compile it independently without reading or writing the running simulation data.")),
    entityId:required(text("Stable entityId of the target entity in the Scene; copied unchanged into the returned MotionPlan.")),
    modelVersion:required(text("modelVersion returned by robot_describe; copied unchanged into MotionPlan.")),
    collisionContextVersion:required(text("collisionContextVersion returned by robot_describe; copied unchanged into MotionPlan.")),
    expectedGeneration:required(integer("worldGeneration returned by robot_describe/sim_open. Pass it unchanged; do not substitute a newer generation.")),
    tcp,
    jointNames:required(nameVector("Ordered joint names participating in IK, using the actual names from robot_describe. They must be unique and have the same length as startPositions.")),
    startPositions:required(numberVector("Measured starting positions from robot_state, in jointNames order. Solve from these positions.")),
    targetPose,
    fixedJoints:{type:'object' as const,additionalProperties:true,description:"Optional joints held at specified values without participating in optimization, as joint-name-to-value mappings. They must not overlap jointNames."},
    seeds:{type:'array' as const,items:numberVector("One IK seed vector with the same length as jointNames."),description:"Optional multiple IK seeds; omission uses only startPositions."},
    durationS:number("Total duration of the returned trajectory in seconds. Defaults to 2 and must be greater than 0."),
    maxIterations:integer("Maximum iteration count per seed; defaults to 160."),
    positionToleranceM:number("Position convergence tolerance in meters; defaults to 0.003."),
    orientationToleranceRad:number("Orientation convergence tolerance in radians; defaults to 0.0872664626 (5 degrees)."),
  }}

/** 入参规范化只做字段换名，实现与验证见 ./request.ts（纯函数）。 */
export { motionRequest } from './request.ts'
import { motionRequest } from './request.ts'

export function apply(ctx:Context, config:Config={}) {
  ctx.tools.register(defineTool({
    name:'motion_plan', description:"Solve the specified TCP pose with an independent Mink model and return a complete joint trajectory; do not execute motion. Supply either the recommended structured plan or the compatible request_json, never both.",
    parameters:{plan,request_json:text("Compatibility input: a complete request JSON string used by existing callers, including internal planning in robot_pick/robot_place. Mutually exclusive with plan."),background:{type:'boolean',description:"Run in the background through DSH Jobs; inspect with job_output and cancel with job_kill."}},
    output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.result}]},
    async execute(args,exec) {
      // 先校验入参（二选一 + JSON 可解析），再检查 Provider 可用性：用户错误不该被环境错误掩盖。
      const request=motionRequest(args)
      const python=config.python??process.env.LYAPUNOV_ALGORITHM_PYTHON
      if(!python) throw new Error('PROVIDER_UNAVAILABLE: 缺少 LYAPUNOV_ALGORITHM_PYTHON')
      const run=()=>ctx.subprocess.spawn({argv:[python,fileURLToPath(new URL('./solve.py',import.meta.url))],cwd:process.cwd(),stdio:{stdin:{data:JSON.stringify(request)},stdout:{maxBytes:4000000},stderr:{maxBytes:200000}},graceMs:2000,signal:exec.signal,env:{HF_ENDPOINT:'https://hf-mirror.com'}})
      if(args.background){
        const id=ctx.jobs.start({kind:'lyapunov-provider',label:'motion_plan',owner:exec.agent,run:()=>{
          const child=run();return {cancel:()=>child.terminate(),done:child.done.then(outcome=>({status:outcome.exitCode===0?'completed' as const:outcome.signal?'killed' as const:'failed' as const,detail:`exitCode=${outcome.exitCode}`,output:child.collected.stdout?.readFrom(0).text??''}))}
        }})
        return {result:JSON.stringify({jobId:id,status:'running'})}
      }
      const child=run(); const outcome=await child.done; const out=child.collected.stdout?.readFrom(0).text??''
      if(outcome.exitCode!==0) throw new Error(`${outcome.exitCode===2?'PROVIDER_UNAVAILABLE':'PROVIDER_FAILED'}: ${out || child.collected.stderr?.readFrom(0).text}`)
      // 前缀长度必须由常量推导：旧的 13 字符前缀（LYAUP_RESULT=）改名后这里曾硬编码 13，
      // 会把带前缀的结果行截成 "LT={...}" 这种非法 JSON。solve.py 目前直接打印 JSON，
      // 因此同时接受“带前缀的结果行”和“最后一行纯 JSON”两种真实产物。
      const lines=out.trim().split('\n'),prefixed=lines.slice().reverse().find(v=>v.startsWith(RESULT_PREFIX))
      return {result:(prefixed?prefixed.slice(RESULT_PREFIX.length):lines.at(-1))!}
    },
  }))
}
