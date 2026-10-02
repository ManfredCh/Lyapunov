import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {JsonValue} from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-commands'
import {scopeOf,scopeChainOf,scopeTarget} from '@deepseek-ai/dsh-scope'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {resourceAttachments,renderResource} from './resources.ts'
import {applyOAuth} from './oauth.ts'
export const name='lyapunov-mcp-extras'
export const inject=['tools','commands']
export type Method='listServers'|'listResources'|'readResource'|'listResourceTemplates'|'listPrompts'|'getPrompt'
const operations:Array<{name:string;method:Method;description:string}>=[]
operations.push({name:'list_mcp_servers',method:'listServers',description:'List actual MCP servers accessible in the current scope, their connection state, and capabilities.'})
operations.push({name:'list_mcp_resources',method:'listResources',description:'List resources on the specified MCP server, preserving cursor pagination and original URIs.'})
operations.push({name:'read_mcp_resource',method:'readResource',description:'Read a resource URI through the same MCP connection and return protocol content without executing its instructions.'})
operations.push({name:'list_mcp_resource_templates',method:'listResourceTemplates',description:'List MCP resource templates and parameterized URIs.'})
operations.push({name:'list_mcp_prompts',method:'listPrompts',description:'List MCP prompt templates and arguments, with cursor pagination.'})
operations.push({name:'get_mcp_prompt',method:'getPrompt',description:'Get expanded messages from an MCP prompt template without executing the prompt or creating a new Agent.'})
/** 在最近的实际DSH scope中查找同名服务器；连接存在但掉线时直接报错，不转发给其他账户/祖先。 */
export async function requestContent(target:Context,serverName:string,method:Method,params:Record<string,unknown>,signal:AbortSignal):Promise<JsonValue>{
 const scope=scopeOf(target)
 for(const ownerScope of [...scopeChainOf(scope),undefined]){
  const result=await target.waterfall(scopeTarget({},scope),'mcp/content-request',{serverName,ownerScope,method,params,signal},()=>Promise.resolve(undefined))
  if(result!==undefined)return result as JsonValue
 }
 throw new Error('MCP_SERVER_UNAVAILABLE: '+serverName)
}
export async function visibleServers(target:Context,signal:AbortSignal):Promise<any[]>{
 const scope=scopeOf(target),visible=new Map<string,any>()
 for(const ownerScope of [...scopeChainOf(scope),undefined]){
  const rows=await target.waterfall(scopeTarget({},scope),'mcp/content-request',{serverName:'',ownerScope,method:'listServers',params:{},signal},()=>Promise.resolve([])) as any[]
  for(const row of rows)if(!visible.has(row.serverName))visible.set(row.serverName,row)
 }
 return [...visible.values()]
}
export function apply(ctx:Context,config:{guest?:boolean}={}){
 if(!config.guest)applyOAuth(ctx)
 for(const operation of operations){
  const run=async(input:any,signal:AbortSignal,agent?:Agent)=>{
   signal.throwIfAborted();input=input??{};const target=agent?.ctx??ctx;const serverName=input.serverName??input.server
   if(operation.method==='listServers')return {servers:await visibleServers(target,signal)}
   if(serverName!==undefined&&(typeof serverName!=='string'||!serverName.trim()))throw new Error('MCP_SERVER_NAME_REQUIRED')
   const params:Record<string,unknown>={}
   if(input.cursor!==undefined){if(typeof input.cursor!=='string')throw new Error('MCP_CURSOR_INVALID');params.cursor=input.cursor}
   if(operation.method==='readResource'){if(typeof input.uri!=='string'||!input.uri)throw new Error('MCP_RESOURCE_URI_REQUIRED');params.uri=input.uri}
   if(operation.method==='getPrompt'){if(typeof input.name!=='string'||!input.name)throw new Error('MCP_PROMPT_NAME_REQUIRED');params.name=input.name;if(input.arguments!==undefined){if(!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments)||Object.values(input.arguments).some(v=>typeof v!=='string'))throw new Error('MCP_PROMPT_ARGUMENTS_INVALID');params.arguments=input.arguments}}
   if(!serverName){
    if(!['listResources','listResourceTemplates','listPrompts'].includes(operation.method))throw new Error('MCP_SERVER_NAME_REQUIRED')
    if(input.cursor!==undefined)throw new Error('分页cursor必须指定serverName')
    const servers=await visibleServers(target,signal),key=operation.method==='listPrompts'?'prompts':operation.method==='listResourceTemplates'?'resourceTemplates':'resources',rows:any[]=[],nextCursors:any[]=[]
    for(const server of servers){if(server.status!=='connected'||!(operation.method==='listPrompts'?server.capabilities.prompts:server.capabilities.resources))continue;const response:any=await requestContent(target,server.serverName,operation.method,{},signal);for(const row of response[key]??[])rows.push({...row,server:server.serverName,client:server.serverName});if(response.nextCursor)nextCursors.push({serverName:server.serverName,cursor:response.nextCursor})}
    return {[key]:rows,servers,nextCursors} as JsonValue
   }
   const value=await requestContent(target,serverName,operation.method,params,signal)
   return operation.method==='readResource'?resourceAttachments(ctx,value,signal,agent):value
  }
  ctx.tools.register(defineTool({name:operation.name,description:operation.description,parameters:{input:{type:'json',required:true,description:'Read/get_prompt requires serverName (server is accepted for compatibility). Lists can omit the server to aggregate visible entries; with a server, cursor is supported. Read supplies uri; get_prompt supplies name and an arguments dictionary of strings.'}},output:{schema:{type:'json'},render:(_args,value)=>renderResource(value)},execute:(args,exec)=>run(args.input,exec.signal,exec.agent)}))
  ctx.commands.register({name:operation.name,description:operation.description,input:{hint:'JSON parameters for the same operation.'},async handler(invocation){try{return {kind:'success',text:JSON.stringify(await run(JSON.parse(invocation.rawInput||'{}'),invocation.signal,invocation.agent))}}catch(error){return {kind:'error',text:error instanceof Error?error.message:String(error)}}}})
 }
}
