import type {Context} from '@deepseek-ai/cordis'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {IWorkspaces} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {mainSessionId} from './history-navigation.ts'
import {externalToolOption} from './external-tools.ts'

/**
 * 创建原生会话，等它真正 retain 且初次 `open()` 落定后，再只提交一次请求。
 *
 * 为什么不能直接 `sessions.binding(id)`：RC2 的 `create()` 只登记身份，binding 只有在客户端
 * **retain** 并完成初次 open 之后才存在（`contract/sessions.ts:84,162`）。旧路径在 retain 之前
 * 同步读 binding，于是稳定得到 undefined，报成"新的安装会话未能建立连接"。
 * 这里走 `sessions.using` 的原生生命周期：retain → await ready → 回调 → finally 释放临时引用。
 * `openSession` 会以 `mainView` 引用持有会话，所以临时引用释放后会话仍存活。
 */
async function startExternalSession(ctx:Context,prompt:string,close:()=>void):Promise<string>{
 const sessions=ctx.get('sessions') as unknown as ISessions|undefined
 if(!sessions)throw new Error('会话服务尚未就绪，请稍后重试。 / The native session service is not ready.')
 const snapshot=sessions.list.getSnapshot(),current=mainSessionId(snapshot)
 const workspaces=ctx.get('workspaces') as unknown as IWorkspaces|undefined
 const workspace=workspaces?.list.getSnapshot().items.find(row=>current&&row.sessionIds.includes(current))
 const sessionId=await sessions.create(workspace?{workspaceId:workspace.workspaceId}:current&&snapshot.byId[current]?.cwd?{cwd:snapshot.byId[current]!.cwd}:{})
 return await sessions.using(sessionId,{source:'controllerOperation'},async reference=>{
  const binding=await reference.ready
  // openSession 以 mainView 引用同步持有会话；本函数的临时引用在 finally 释放后会话仍活着。
  ctx.uiWorkspace.openSession(sessionId)
  const response=await binding.session.prompt([{type:'text',text:prompt}],'queue')
  if(!response.ok)throw new Error(`安装请求尚未提交 / Installation request was not accepted: ${response.error.message}`)
  close()
  return sessionId
 })
}

/** 每次显式选择创建新的原生会话，不复用当前空白会话，也不向当前任务追加安装请求。 */
export async function startExternalInstallSession(ctx:Context,id:string,close:()=>void):Promise<string> {
 const option=externalToolOption(id)
 return await startExternalSession(ctx,option.prompt,close)
}

/**
 * 显式登记一个 MCP 服务（名称/命令/地址）：同样走新会话，但把用户给的值带进英文请求。
 * 不硬编码服务器名或工具名；连不上时由模型按原生握手/发现结果报告具体缺项。
 */
export async function startExternalMcpRegistrationSession(ctx:Context,value:string,close:()=>void):Promise<string> {
 const trimmed=value.trim()
 if(!trimmed)throw new Error('请先填写 MCP 服务名称、命令或地址。 / Supply the MCP service name, command or address.')
 const prompt=`Please connect an MCP service named or addressed as: ${trimmed}. First inspect the native MCP configuration and the currently visible MCP servers, then reuse Lyapunov native MCP registration and discovery to configure, connect and verify it with a real handshake and tools/list. Do not invent server or tool names; if it cannot be connected, report the concrete missing item (command, URL, transport or token).`
 return await startExternalSession(ctx,prompt,close)
}
