/** 文件页的原生电脑目录选择入口；浏览不会改变当前会话的工作目录。 */
import {useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {PropsLocale,PropsRenderSlots,PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {IWorkspaces} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {SessionId} from '@deepseek-ai/dsh-session/types'

const zh={browse:'浏览电脑目录',workspace:'当前工作区',hint:'目录浏览按电脑用户权限进行。选择“作为工作区打开”后，会切换到该目录的工作区。',unavailable:'目录选择不可用',error:'无法打开工作区：'}
const en:typeof zh={browse:'Browse computer directories',workspace:'Current workspace',hint:'Browse with this computer user’s access. “Open as workspace” switches to the workspace for the selected directory.',unavailable:'Directory picker unavailable',error:'Workspace could not be opened: '}
declare module '@deepseek-ai/dsh-client-ui-slots' {interface LocaleNamespaceMap {lyapunovFiles:keyof typeof zh}}

type Props=PropsRuntime<'sidebar.right.tab.files.actions'>&PropsRenderSlots<'sidebar.right.tab.files.directoryFlow'>&PropsLocale<'lyapunovFiles'>&{
 openWorkspaceDirectory:(path:string,signal:AbortSignal)=>Promise<void>
}

/** 显示完整工作区根；原生选择器只在用户打开入口后列出目录。 */
export function FilesNavigationActions({absolutePath,rootPath,signal,renderSlot,t,openWorkspaceDirectory}:Props){
 const [initialPath,setInitialPath]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const picked=async(path:string)=>{
  setBusy(true);setError('')
  try{await openWorkspaceDirectory(path,signal);if(!signal.aborted)setInitialPath(undefined)}
  catch(reason){if(!signal.aborted)setError(t('error')+String(reason instanceof Error?reason.message:reason))}
  finally{if(!signal.aborted)setBusy(false)}
 }
 return <div style={{padding:'8px 12px',borderBottom:'1px solid var(--dsw-alias-border-l4)'}}>
  <div>{t('workspace')}: <code style={{overflowWrap:'anywhere'}}>{rootPath}</code></div>
  <button type='button' disabled={busy} onClick={()=>{setError('');setInitialPath(absolutePath)}}>{t('browse')}</button>
  <p style={{margin:'6px 0',fontSize:12,color:'var(--dsw-alias-label-secondary)'}}>{t('hint')}</p>
  {error&&<p role='alert'>{error}</p>}
  {renderSlot('sidebar.right.tab.files.directoryFlow',{
   open:initialPath!==undefined,busy,initialPath:initialPath??absolutePath,onPicked:path=>{void picked(path)},onCancel:()=>setInitialPath(undefined),onError:message=>setError(message),
  },{fallback:initialPath!==undefined?<p role='alert'>{t('unavailable')}</p>:null})}
 </div>
}

/** 通过原生工作区和会话导航打开用户确认的目录，不改已有 Session 的 cwd 或权限。 */
export function applyFilesNavigationClient(ctx:Context){
 ctx.effect(()=>ctx.locale.register('lyapunovFiles',{zh,en}))
 const workspaces=ctx.get('workspaces') as unknown as IWorkspaces
 const sessions=ctx.get('sessions') as unknown as ISessions
 const openWorkspaceDirectory=async(path:string,signal:AbortSignal)=>{
  if(signal.aborted)return
  const workspace=await workspaces.create({path})
  if(signal.aborted)return
  let selected:SessionId|undefined
  await ctx.uiWorkspace.openWorkspace(workspace.workspaceId,id=>{selected=id})
  if(selected===undefined)return
  // 原生 Session 导航提交后，让新会话的标签座位完成挂载，再只向该会话打开 Files。
  await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
  if(sessions.list.getSnapshot().current===selected)ctx.sidebarRight.openTabIn(selected,'files')
 }
 ctx.effect(()=>ctx.slots.inject('sidebar.right.tab.files.actions',()=>ctx.slots.register({
  name:'sidebar.right.tab.files.actions',id:'lyapunov-directory-navigation',locale:'lyapunovFiles',
  children:{'sidebar.right.tab.files.directoryFlow':{kind:'single',scope:'scoped'}},
  inject:()=>({openWorkspaceDirectory}),
 },FilesNavigationActions)))
}
