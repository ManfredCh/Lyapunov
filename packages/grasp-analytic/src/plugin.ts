import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {scopeOf,scopeTarget} from '@deepseek-ai/dsh-scope'
import { proposeAnalytic } from './index.ts'
import type { GraspCandidate } from '../../lyapunov-contracts/src/types.ts'
export const name='lyapunov-grasp-analytic'
export const inject=['tools']
export interface CandidateFilterPayload { candidates:GraspCandidate[]; request:Parameters<typeof proposeAnalytic>[0] }
declare module '@deepseek-ai/cordis' {
 interface Events {
  'lyapunov/grasp-candidates'(payload:CandidateFilterPayload,next:()=>GraspCandidate[]|Promise<GraspCandidate[]>):GraspCandidate[]|Promise<GraspCandidate[]>
 }
}
export function apply(ctx:Context){
 ctx.tools.register(defineTool({
  name:'grasp_propose',description:"Propose deterministic analytic grasp candidates from axis-aligned box geometry; do not invoke a learned model or execute motion.",
  parameters:{request_json:{type:'string',required:true,description:"JSON containing entityId/frameId/centerM/sizeM/maxWidthM, in meters."}},
  output:{schema:{type:'object',additionalProperties:false,properties:{result:{type:'string',required:true}}},render:(_args,v)=>[{type:'text',text:v.result}]},
  async execute(args,exec){
   const request=JSON.parse(args.request_json);const original=proposeAnalytic(request)
   const candidates=await ctx.waterfall(scopeTarget({},scopeOf(exec.agent?.ctx??ctx)),'lyapunov/grasp-candidates',{candidates:original,request},()=>original)
   return {result:JSON.stringify({provider:'analytic',candidates,noSolution:candidates.length===0})}
  },
 }))
}
