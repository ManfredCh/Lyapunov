import { expect, test } from "bun:test"
import { AttachmentId } from "@deepseek-ai/dsh-attachment"
import type { JsonValue } from "@deepseek-ai/dsh-util-values"
import { renderResource } from "../src/resources.ts"
test("renderResource 把文本和图片附件都放进内容块", () => {
  const textItem: JsonValue = { text: "a" }
  const imageItem: JsonValue = { imageAttachment: { attachmentId: "img-1", mediaType: "image/png", bytes: 4, width: 2, height: 2 } }
  const input: JsonValue = { contents: [textItem, imageItem] }
  const blocks = renderResource(input)
  expect(blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("\"a\"") })
  const image = blocks.find(block => block.type === "image")
  if (!image || image.type !== "image") throw new Error("缺少图片内容块")
  expect(image.attachment.attachmentId).toBe(AttachmentId("img-1"))
  expect(image.attachment.mediaType).toBe("image/png")
  expect(image.attachment.bytes).toBe(4)
  expect(image.attachment.width).toBe(2)
  expect(image.attachment.height).toBe(2)
})

import {Context} from '@deepseek-ai/cordis'
import SessionStore,{SessionId} from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import type {Agent} from '@deepseek-ai/dsh-agent'
import * as McpExtras from '../src/plugin.ts'

/** 实际原生命令分派和Session事件；MCP内容供应是只读元数据夹具，不冒充编辑器在线。 */
async function nativeCommandFixture(){
 const ctx=new Context()
 await ctx.plugin(SessionStore);await ctx.plugin(CommandRuntime)
 ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0} as never)
 await ctx.plugin(ToolRuntime);await ctx.plugin(McpExtras,{guest:true})
 const session=ctx.sessions.create(SessionId('native-json-whitespace')),agent={id:session.id,session} as Agent
 const scope=createScope(ctx,agent);Object.assign(agent,{ctx:scope.ctx})
 return {ctx,session,agent,execute:(line:string)=>ctx.commands.execute(agent,line,[],new AbortController().signal)}
}

test('原生菜单claim尾空格与纯空白JSON参数可直接执行list_mcp_servers，记录同commandId成功且零模型事件',async()=>{
 const f=await nativeCommandFixture()
 try{
  for(const line of ['/list_mcp_servers','/list_mcp_servers ','/list_mcp_servers \t\r\n  ','/list_mcp_servers {}']){
   const execution=await f.execute(line)
   expect(execution?.result).toMatchObject({kind:'success',text:'{"servers":[]}'})
   const events=f.session.snapshotEvents(),run=events.find(v=>v.type==='command/run'&&v.data.commandId===execution?.commandId),done=events.find(v=>v.type==='command/done'&&v.data.commandId===execution?.commandId)
   expect(run?.data).toMatchObject({name:'list_mcp_servers',args:line.slice('/list_mcp_servers'.length)})
   expect(done?.data).toMatchObject({kind:'success',text:'{"servers":[]}'})
  }
  expect(f.session.snapshotEvents().some(v=>['turn/start','step/start','request/header','tool/call'].includes(v.type))).toBe(false)
 }finally{await f.ctx.fiber.dispose()}
})

test('原生JSON命令非法内容仍error，要求server/uri的操作不能被空白默认绕过',async()=>{
 const f=await nativeCommandFixture()
 try{
  const invalid=await f.execute('/list_mcp_servers  {oops}')
  expect(invalid?.result.kind).toBe('error')
  expect(f.session.snapshotEvents().find(v=>v.type==='command/done'&&v.data.commandId===invalid?.commandId)?.data).toMatchObject({kind:'error'})
  const missing=await f.execute('/read_mcp_resource \t  ')
  expect(missing?.result).toMatchObject({kind:'error',text:'MCP_RESOURCE_URI_REQUIRED'})
 }finally{await f.ctx.fiber.dispose()}
})

test('只处理JSON外部空白，不改变JSON字符串内的URI空格或其它参数',async()=>{
 const f=await nativeCommandFixture(),seen:unknown[]=[]
 f.ctx.on('mcp/content-request',async(request,next)=>{
  if(request.method!=='readResource'||request.serverName!=='fixture')return next()
  seen.push(request.params);return {contents:[{uri:request.params.uri,text:'same exact URI'}]}
 })
 try{
  const execute=await f.execute('/read_mcp_resource \t {"serverName":"fixture","uri":"file:///name with spaces.txt"} \n')
  expect(execute?.result.kind).toBe('success')
  expect(seen).toEqual([{uri:'file:///name with spaces.txt'}])
  expect(JSON.parse(execute!.result.text!)).toEqual({contents:[{uri:'file:///name with spaces.txt',text:'same exact URI'}]})
 }finally{await f.ctx.fiber.dispose()}
})
