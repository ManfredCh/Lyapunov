import {describe,expect,test} from 'bun:test'
import type {Context} from '@deepseek-ai/cordis'
import {startExternalInstallSession} from '../src/external-install-session.ts'

function fixture(ok=true){
 const calls:Array<{kind:string;value:unknown}>=[]
 const sessions={list:{getSnapshot:()=>({current:'existing',byId:{existing:{cwd:'/task'}}})},
  create:async(opts:unknown)=>{calls.push({kind:'create',value:opts});return 'fresh-install'},
  open:(id:string)=>{calls.push({kind:'open',value:id})},
  binding:(id:string)=>({session:{prompt:async(content:unknown,mode:unknown)=>{
    calls.push({kind:'prompt',value:{id,content,mode}})
    return ok?{ok:true}:{ok:false,error:{message:'模型未连接'}}
  }}})}

 const workspaces={list:{getSnapshot:()=>({items:[{workspaceId:'workspace',sessionIds:['existing']}]})}}
 const ctx={get:(name:string)=>name==='sessions'?sessions:name==='workspaces'?workspaces:undefined,layout:{selectPanel:(value:unknown)=>calls.push({kind:'panel',value})}} as unknown as Context
 return {ctx,calls,close:()=>calls.push({kind:'close',value:true})}
}
describe('外部工具从设置进入新会话',()=>{
 test('创建新会话后只向新绑定发送Blender自然语言请求，不复用已有任务',async()=>{
  const f=fixture();expect(await startExternalInstallSession(f.ctx,'blender',f.close)).toBe('fresh-install')
  expect(f.calls.map(row=>row.kind)).toEqual(['create','open','panel','prompt','close'])
  expect(f.calls[0]!.value).toEqual({workspaceId:'workspace'})
  expect(f.calls[3]!.value).toMatchObject({id:'fresh-install',mode:'queue',content:[{type:'text',text:expect.stringContaining('请帮我下载并安装 Blender')}]})
 })
 test('Unity MCP使用配置与连接检查请求，不将已配置当作已安装',async()=>{
  const f=fixture();await startExternalInstallSession(f.ctx,'unity-mcp',f.close)
  expect(JSON.stringify(f.calls[3]!.value)).toContain('不能据此声称已经安装或启动编辑器')
 })
 test('提交失败保留设置错误处理机会，不报告完成',async()=>{
  const f=fixture(false);await expect(startExternalInstallSession(f.ctx,'blender',f.close)).rejects.toThrow('模型未连接')
  expect(f.calls.some(row=>row.kind==='close')).toBe(false)
 })
 test('未知工具不会创建会话或提交任何请求',async()=>{
  const f=fixture();await expect(startExternalInstallSession(f.ctx,'unknown-tool',f.close)).rejects.toThrow('未找到')
  expect(f.calls).toEqual([])
 })
})
