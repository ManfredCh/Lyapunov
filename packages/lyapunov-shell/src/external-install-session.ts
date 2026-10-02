import type {Context} from '@deepseek-ai/cordis'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {IWorkspaces} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {externalToolOption} from './external-tools.ts'

/** 每次显式选择创建新的原生会话，不复用当前空白会话，也不向当前任务追加安装请求。 */
export async function startExternalInstallSession(ctx:Context,id:string,close:()=>void):Promise<string> {
 const option=externalToolOption(id)
 const sessions=ctx.get('sessions') as unknown as ISessions|undefined
 if(!sessions)throw new Error('会话服务尚未就绪，请稍后重试。')
 const snapshot=sessions.list.getSnapshot(),current=snapshot.current
 const workspaces=ctx.get('workspaces') as unknown as IWorkspaces|undefined
 const workspace=workspaces?.list.getSnapshot().items.find(row=>current&&row.sessionIds.includes(current))
 const sessionId=await sessions.create(workspace?{workspaceId:workspace.workspaceId}:current&&snapshot.byId[current]?.cwd?{cwd:snapshot.byId[current]!.cwd}:{})
 const binding=sessions.binding(sessionId)
 if(!binding)throw new Error('新的安装会话未能建立连接，请稍后重试。')
 sessions.open(sessionId)
 ctx.layout.selectPanel(null)
 const response=await binding.session.prompt([{type:'text',text:option.prompt}],'queue')
 if(!response.ok)throw new Error(`安装请求尚未提交：${response.error.message}`)
 close()
 return sessionId
}
