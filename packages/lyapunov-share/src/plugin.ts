import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {registerPrivatePreview} from './preview-route.ts'
import {defineTool} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import {ShareOperations,type ShareConfig} from './operations.ts'
export const name='lyapunov-share'
export const inject=['tools','commands','sessions','sessionPersistence','sessionQuery','attachments']
export type Config=ShareConfig
export function apply(ctx:Context,config:Config){
 const operations=new ShareOperations(ctx,config)
 registerPrivatePreview(ctx,operations)
 const specs=[
  {name:'share_preview',description:'Generate a private sharing preview for the current or specified session using native DSH export and original attachments, without publishing. Optional sessionId/title/includeDescendants; descendants are excluded by default.'},
  {name:'share_publish',description:'Publish a specific preview using previewId. The tool pauses and presents the native publish/cancel question to the user; confirmed cannot replace the user\'s answer. Idempotent retries of an already confirmed snapshot do not ask again.'},
  {name:'share_list',description:'List shares published by the current account and their revocation state; do not query other accounts.'},
  {name:'share_revoke',description:'Revoke the current account\'s share link and disable the page, archive download, and all attachments. Supply shareId.'},
 ]
 const run=(name:string,input:any,agent:Agent|undefined,signal:AbortSignal)=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('SHARE_INPUT_INVALID')
  if(name==='share_preview'){const id=input.sessionId??agent?.id;if(typeof id!=='string'||!id)throw new Error('SHARE_SESSION_ID_REQUIRED');if(input.title!==undefined&&typeof input.title!=='string')throw new Error('SHARE_TITLE_INVALID');return operations.preview({sessionId:id,title:input.title,includeDescendants:input.includeDescendants},signal)}
  if(name==='share_publish')return operations.publish(input,signal,agent)
  if(name==='share_revoke')return operations.revoke(input.shareId,signal)
  return operations.list(signal)
 }
 for(const spec of specs){
  ctx.tools.register(defineTool({name:spec.name,description:spec.description,parameters:{input:{type:'json',required:true,description:'Operation parameters as JSON; share_list uses {}.'}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args,exec)=>run(spec.name,args.input,exec.agent,exec.signal)}))
  ctx.commands.register({name:spec.name,description:spec.description,input:{hint:'The same JSON parameters as the Tool with this name.'},async handler(invocation){try{return {kind:'success',text:JSON.stringify(await run(spec.name,JSON.parse(invocation.rawInput||'{}'),invocation.agent,invocation.signal))}}catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}}})
 }
}
