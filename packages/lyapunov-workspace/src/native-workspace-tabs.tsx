/** 文件导航使用原生标签；文件编辑与工作区操作保留已有Host接口。 */
import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {PropsLocale,PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {SessionId} from '@deepseek-ai/dsh-session/types'
import {fileAddressFor,pathPartsOf} from '@deepseek-ai/dsh-util-workspace-path'
import {parseFileAddress} from '@deepseek-ai/dsh-util-workspace-path/src/file-address.ts'
import {workspaceDefaults,workspaceFont,matchWorkspaceShortcut} from './preferences.ts'
import {selectedFileContext} from './selection-context.ts'
import {workspaceStyle} from './workspace-style.ts'
import {FileSurfaceBody,useWorkspaceSessionState,type WorkspaceSurface} from './workspace-session.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import {fileDocument} from './native-documents.ts'
import {ModelPreviewBody,modelKindOf,type ReadModelBytes} from './model-preview.tsx'
// DEV-032：HTML 的两个真实上限与判定都只有一份（`html-preview-entry.ts`）。界面**只渲染**宿主返回的
// plan（choices / wording / recheck / limits），自己不重算任何判据，也不抄任何上限数字——上限数字
// 统一来自 `plan.*.limits[].reading`（宿主按契约模块算好），界面里出现硬编码上限即为回归。
import {type HtmlOpenTarget,type HtmlPreviewPlan} from '../../lyapunov-shell/src/html-preview-entry.ts'
// 标签 kind/id 的唯一一份（shell 的 ui_action openResource 也 import 它点名打开 HTML 源码）。
import {EDITOR_KIND,HTML_EDITOR_ID,HTML_EDITOR_KIND,MODEL_KIND} from './workspace-kinds.ts'
const nativeWorkspaceStyle=`
.lya-native-workspace{--lya-bg:var(--dsw-alias-bg-base);--lya-text:var(--dsw-alias-label-primary);--lya-muted:var(--dsw-alias-label-secondary);--lya-line:color-mix(in srgb,var(--lya-text) 10%,transparent);--lya-line-2:color-mix(in srgb,var(--lya-text) 17%,transparent);--lya-hover:color-mix(in srgb,var(--lya-text) 5%,transparent);--lya-accent:var(--dsw-alias-link);--lya-accent-soft:color-mix(in srgb,var(--lya-accent) 11%,var(--lya-bg));height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative;font:13px/1.6 system-ui;color:var(--lya-text);background:var(--lya-bg)}
.lya-native-workspace *{box-sizing:border-box}
.lya-native-workspace .code-navigation-only{grid-template-columns:1fr}
.lya-native-workspace .code-navigation-only>aside{border:0;padding:0;gap:2px}
.lya-native-workspace .code-navigation-only>aside>form{padding-bottom:10px}
.lya-native-workspace .code-entry{border-radius:6px}
.lya-native-editor{padding:0;gap:0;overflow:hidden}
.lya-native-editor .code-toolbar{padding:10px 14px;border-bottom:1px solid var(--lya-line);flex-shrink:0;gap:6px}
.lya-native-editor .code-toolbar>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:550}
.lya-native-editor .code-toolbar>small{color:var(--lya-muted);margin-right:8px}
.lya-native-editor .code-editor{flex:1;width:100%;min-height:0;border:0;resize:none;padding:18px;line-height:1.8;border-radius:0;outline-offset:-2px}
.lya-native-editor :is(p,form){padding:7px 14px;flex-shrink:0}
.lya-native-editor .code-error{color:var(--dsw-alias-state-error-primary)}
.lya-native-workspace .html-open-choice{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--lya-line);flex-shrink:0}
/* 按需入口：折叠时只占一行 summary，重启说明与上限口径都不出现在正常导航里。 */
.lya-native-workspace .lya-open-panel{flex-shrink:0}
.lya-native-workspace .lya-open-panel>summary{cursor:pointer;padding:7px 14px;color:var(--lya-muted);list-style:revert}
.lya-native-workspace .html-open-choice>span{color:var(--lya-muted)}
.lya-native-workspace .html-open-choice>input{flex:1;min-width:140px;background:transparent;border:1px solid var(--lya-line-2);border-radius:5px;padding:4px 8px;color:inherit;font:inherit}
.lya-native-workspace .html-open-choice>small{flex-basis:100%;color:var(--lya-muted)}
.lya-native-workspace .html-open-plan{display:flex;flex-direction:column;gap:4px;padding:0 14px 8px;border-bottom:1px solid var(--lya-line);flex-shrink:0}
.lya-native-workspace .html-open-plan small{color:var(--lya-muted);white-space:pre-wrap}
.lya-native-workspace .html-open-plan code{font:inherit;color:var(--lya-text);word-break:break-all}
`
const TOOLS_KIND='lyapunov.workspace.tools',TOOLS_ID='@lyapunov/workspace/tools'
const EDITOR_ID='@lyapunov/workspace/editor',MODEL_ID='@lyapunov/workspace/model'
/**
 * HTML 的两条通路与两个真实上限（DEV-032）：
 * - **源码编辑**：本包的文本编辑器（`plugin.ts` 的 `action=read`）在 4,000,000 字节处明确拒绝；
 * - **页面预览**：DSH 原生文档预览走 `workspaceFiles.maxFileBytes`，默认 32 MiB。
 * 默认点击 HTML 仍走原生预览（编辑器的自动认领对 `.html` 保持否决）；源码编辑只在用户**显式**选择时打开，
 * 见 `HTML_EDITOR_KIND` 的注册（`patterns` 故意不匹配任何文件地址，永不参与自动认领）。
 */
// 两个上限不在这里：见 html-preview-entry.ts 的 EXTENSION_EDITOR_LIMIT / NATIVE_FULL_READ_LIMIT。
const isHtmlPath=(path:string)=>/\.html?$/i.test(path)
/**
 * HTML 打开计划的**渲染体**（独立出来便于按"当前文件是否触发上限"直接渲染验证）：
 * - 上限数字**只在 `limits[].exceeded` 为真时**才出现；未触发时一个上限口径都不渲染；
 * - 读数是宿主按契约模块算好的 `reading`（含来源与阈值），界面不抄数字、不重算判据。
 */
export function HtmlOpenPlanBody({plan,tr}:{plan:HtmlPreviewPlan;tr:(zh:string,en:string)=>string}){
 return <div className='html-open-plan' role='status' data-testid='html-open-plan'>
  <small>{plan.summary}</small>
  {([plan.preview,plan.source] as const).map(path=>{
   const exceeded=path.limits.filter(limit=>limit.exceeded)
   return exceeded.length?<small key={path.target} data-testid={`html-open-limit-${path.target}`}>{exceeded.map(limit=>limit.reading).join('；')}</small>:null
  })}
  {plan.assetService.required&&<small>{tr('素材服务（宿主重启后必须重新探测）','Static asset service (must be re-probed after a host restart)')}：<code>{plan.assetService.recheck.how}</code> → {plan.assetService.recheck.expect}</small>}
  {/* BASE-SERVED-ROOT-MISMATCH：服务根未知时必须**显式说出来**。这一行在的理由：计划块里的
      「素材服务：ready」说的是**服务端**（实测 206），不等于"本机在页面目录里核对过素材"。页面写了
      `<base>` 时那个服务根常常是另一棵树（本机实测：素材在 Demo 的树里、页面在工作区的树里）——
      不说清这一点，用户会把"就绪"读成"素材就在页面旁边"。 */}
  {plan.assetService.required&&plan.assetService.rootKnown===false&&<small data-testid='html-service-root-unknown'>{tr(`素材服务根未确定（只知道 origin=${plan.assetService.origin??'未配置'}）：这一页的素材存在性按**服务端实测**判，不拿页面目录当服务根。`,`Static asset service root unknown (only origin=${plan.assetService.origin??'unset'} is known): asset existence is read from the server, not from the page directory.`)}</small>}
  {plan.assetService.missing.length>0&&<small role='alert'>{tr(`缺件：${plan.assetService.missing.join('、')}`,`Missing assets: ${plan.assetService.missing.join(', ')}`)}</small>}
  {plan.assetService.brokenLinks.length>0&&<small>{tr(`失效链接（点开才 404）：${plan.assetService.brokenLinks.join('、')}`,`Broken links (404 only when clicked): ${plan.assetService.brokenLinks.join(', ')}`)}</small>}
  {([plan.preview,plan.source] as const).map(path=>path.row.status==='ready'?null:<small key={path.target} data-testid={`html-open-wording-${path.target}`}>{path.wording.join('\n')}</small>)}
 </div>
}

type Props=PropsRuntime<'sidebar.right.pane.tab'>&PropsLocale<'lyapunovWorkspace'>&{surface:WorkspaceSurface;openHtmlAs:(sessionId:string,address:string,kind:string)=>void}
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
 interface SidebarRightTabParamsMap {'lyapunov.workspace.tools':{picker?:boolean;section?:'files'|'search'|'review';toggleTree?:boolean;newWorktree?:boolean}}
}
type ToolsProps=PropsRuntime<'sidebar.right.pane.tab'>&PropsLocale<'lyapunovWorkspace'>&{surface:WorkspaceSurface}
type FilesProps=PropsRuntime<'sidebar.right.tab.files.actions'>&PropsLocale<'lyapunovWorkspace'>&{openHtmlAs:(sessionId:string,address:string,kind:string)=>void}
function FileActions({sessionId,t,signal,openResource,openHtmlAs}:FilesProps){
 const tr=(zh:string,en:string)=>t('open')==='Files & terminal'?en:zh
 // 显式「编辑源码／预览页面」选择（DEV-032）：路径按会话工作区解析成文件地址后**点名**打开方式。
 // 「预览页面」不点名类型＝交给注册表排名（`.html` 由原生文档预览胜出）；「编辑源码」点名 HTML_EDITOR_KIND。
 // 判定与事实**都在宿主**：先取 `action:"html-plan"` 的 plan，界面只消费它给的结论
 // （choices / preview.wording / source.wording / assetService.recheck），绝不在这里重算一遍。
 const [htmlPath,setHtmlPath]=useState(''),[htmlError,setHtmlError]=useState(''),[htmlPlan,setHtmlPlan]=useState<HtmlPreviewPlan|undefined>(undefined)
 const currentPlan=htmlPlan!==undefined&&htmlPlan.path===htmlPath.trim()?htmlPlan:undefined
 const choiceOf=(target:HtmlOpenTarget)=>currentPlan?.choices.find(choice=>choice.target===target)
 const planBody=currentPlan===undefined?null:<HtmlOpenPlanBody plan={currentPlan} tr={tr}/>
 const openHtml=(target:HtmlOpenTarget)=>()=>{
  const path=htmlPath.trim();if(!path)return
  setHtmlError('')
  void (async()=>{
   try{
    const planResponse=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,action:'html-plan',input:{path}})})
    const plan=await planResponse.json() as HtmlPreviewPlan&{error?:string}
    if(!planResponse.ok)throw Error(plan.error??planResponse.statusText)
    if(signal.aborted)return
    setHtmlPlan(plan)
    // 能不能打开由 plan 说了算；界面重算就会变成跟宿主两套判据。
    if(plan.choices.find(choice=>choice.target===target)?.enabled!==true)return
    const response=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,action:'info',input:{}})})
    const info=await response.json();if(!response.ok)throw Error(info.error??response.statusText)
    if(signal.aborted)return
    const address=fileAddressFor(sessionId,info.cwd,path)
    if(target==='preview')openResource(address)
    else openHtmlAs(sessionId,address,HTML_EDITOR_KIND)
   }catch(error){setHtmlError(String((error as Error).message??error))}
  })()
 }
 return <div className="lya-native-workspace" style={{height:'auto',flex:'0 0 auto'}}><style>{workspaceStyle+nativeWorkspaceStyle}</style>
  {/* DEV-036/N76 + DEV-032：重启降级说明与两个上限的整段口径都收进**按需**折叠入口，
      正常文件导航（截图）里不再常驻开发信息；只有当前文件真的触发上限时，planBody 才把
      那一份文件的实测超限读数显示出来（未触发上限时不渲染任何上限数字）。 */}
  <details className='lya-open-panel' data-testid='html-open-panel'>
   <summary>{tr('按需打开 HTML（预览／源码）','Open HTML on demand (preview / source)')}</summary>
   <small className='lya-help' role='note' data-testid='restart-tab-notice'>{tr('宿主重启后不会自动重开 HTML 预览/编辑标签：文件仍在会话工作区里，用这里的路径重新打开即可；面板与场景选择会按会话恢复。','HTML preview/source tabs are not reopened automatically after a host restart: the files are still in the session workspace—reopen them with the path here. Panels and the scene selection are restored per session.')}</small>
   <div className='html-open-choice'>
    <span>{tr('HTML 打开方式','Open HTML as')}</span>
    <input aria-label={tr('HTML 文件路径','HTML file path')} value={htmlPath} onChange={event=>setHtmlPath(event.target.value)} placeholder={tr('相对会话工作区的 .html 路径','.html path relative to the session workspace')}/>
    <button disabled={!htmlPath.trim()||choiceOf('preview')?.enabled===false} onClick={openHtml('preview')}>{tr('预览页面','Preview page')}</button>
    <button disabled={!htmlPath.trim()||choiceOf('source')?.enabled===false} onClick={openHtml('source')}>{tr('编辑源码','Edit source')}</button>
    {htmlError&&<small role='alert' className='code-error'>{htmlError}</small>}
   </div>
   {planBody}
  </details>
  </div>
}
function WorkspaceTools({sessionId,t,surface,useTabInfo}:ToolsProps){
 const {tab}=useTabInfo()
 const local=useMemo(()=>({...surface,openDocument:async(owner:string,path:string,create=false)=>{
  const response=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:owner,action:'info',input:{}})})
  const info=await response.json();if(!response.ok)throw Error(info.error??response.statusText)
  if(tab.signal.aborted)return
  const address=fileAddressFor(owner,info.cwd,path);if(create)fileDocument(address,true);tab.actions.openResource(address)
 }}),[surface,tab.signal,tab.actions])
 const state=useWorkspaceSessionState(sessionId,t,local,tab.visible)
 const nav=tab.navigation.params as {section?:'search'|'review';picker?:boolean;newWorktree?:boolean}|undefined
 useEffect(()=>{state.setters.setTab(nav?.section==='review'?'review':'search');if(nav?.picker)state.setters.setPicker(true);if(nav?.newWorktree)state.actions.shortcut('worktreeNew')},[tab.navigation.revision])
 return <div className="lya-native-workspace"><style>{workspaceStyle+nativeWorkspaceStyle}</style><FileSurfaceBody session={state} active={tab.visible} toolsOnly/></div>
}
function EditorTab({sessionId,t,surface,useTabInfo}:Props){
 const {tab}=useTabInfo(),doc=useMemo(()=>fileDocument(tab.navigation.address),[tab.navigation.address])
 const state=useSyncExternalStore(doc.subscribe,doc.snapshot,doc.snapshot)
 const preferenceState=useSyncExternalStore(listener=>surface.scope.subscribe(listener),()=>surface.scope.getSnapshot(),()=>surface.scope.getSnapshot())
 const preferences=preferenceState.value??workspaceDefaults,autoSave=preferenceState.status==='ready'&&preferences.autoSave
 const tr=(zh:string,en:string)=>t('open')==='Files & terminal'?en:zh
 const editor=useRef<HTMLTextAreaElement>(null),[find,setFind]=useState(''),[finding,setFinding]=useState(false)
 const dirty=state.base!==undefined&&state.draft!==state.base.content
 useEffect(()=>{void doc.load()},[doc])
 useEffect(()=>{if(!autoSave||!dirty||state.saving)return;const timer=setTimeout(()=>{void doc.save(true)},preferences.autoSaveDelayMs);return()=>clearTimeout(timer)},[doc,autoSave,dirty,state.draft,state.saving,preferences.autoSaveDelayMs])
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[dirty])
 const findNext=(backward=false)=>{const node=editor.current;if(!node||!find)return;let at=backward?state.draft.lastIndexOf(find,node.selectionStart-1):state.draft.indexOf(find,node.selectionEnd);if(at<0)at=backward?state.draft.lastIndexOf(find):state.draft.indexOf(find);if(at>=0){node.focus();node.setSelectionRange(at,at+find.length)}}
 return <section className='lya-file-surface lya-native-workspace lya-native-editor' aria-label={tr('文件编辑','File editor')} onKeyDown={event=>{
  if(event.nativeEvent.isComposing)return
  if(matchWorkspaceShortcut(event.nativeEvent,preferences.shortcuts.addSelection,/Mac|iPhone|iPad/.test(navigator.platform))){const el=editor.current;if(el){event.preventDefault();event.stopPropagation();surface.addSelection(sessionId,selectedFileContext(doc.path,state.draft,el.selectionStart,el.selectionEnd,dirty))}return}
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return
  if(event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();void doc.save()}
  if(event.key.toLowerCase()==='f'){event.preventDefault();event.stopPropagation();setFinding(true)}
 }}><style>{workspaceStyle+nativeWorkspaceStyle}</style>
  <div className='code-toolbar'><span title={doc.path}>{doc.path}{dirty?' *':''}</span><small>{autoSave?tr('自动保存','Autosave'):tr('手动保存','Manual save')}</small>
   <button disabled={!state.base||state.saving||(!dirty&&!!state.base.version)} onClick={()=>void doc.save()}>{state.saving?tr('保存中…','Saving…'):tr('保存','Save')}</button>
   <button disabled={state.loading||state.saving} onClick={()=>{if(!dirty||window.confirm(tr('重新读取会放弃当前未保存草稿，继续？','Discard this unsaved draft and reload?')))void doc.reload()}}>{tr('重新读取磁盘','Reload from disk')}</button>
   <button onClick={()=>setFinding(v=>!v)}>{tr('文件内查找','Find in file')}</button>
   <button disabled={!state.base} onMouseDown={e=>e.preventDefault()} onClick={()=>{const el=editor.current;if(el)surface.addSelection(sessionId,selectedFileContext(doc.path,state.draft,el.selectionStart,el.selectionEnd,dirty))}}>{tr('选区加入上下文','Add selection to context')}</button>
  </div>
  {state.error&&<p role='alert' className='code-error'>{state.error}</p>}{state.notice&&<p role='status'>{state.notice}</p>}
  {finding&&<form onSubmit={e=>{e.preventDefault();findNext()}}><input autoFocus aria-label={tr('文件内查找','Find in file')} value={find} onChange={e=>setFind(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setFinding(false);editor.current?.focus()}else if(e.key==='Enter'&&e.shiftKey){e.preventDefault();findNext(true)}}}/><button type='button' disabled={!find} onClick={()=>findNext(true)}>{tr('上一处','Previous')}</button><button disabled={!find}>{tr('下一处','Next')}</button><button type='button' onClick={()=>setFinding(false)}>{tr('关闭查找','Close find')}</button></form>}
  {state.loading&&!state.base?<p role='status'>{tr('正在读取文件…','Loading file…')}</p>:<textarea ref={editor} className='code-editor' aria-label={tr('文件内容','File content')} disabled={!state.base} spellCheck={false} value={state.draft} onChange={e=>doc.edit(e.target.value)} style={{fontFamily:workspaceFont(preferences.editorFontFamily),fontSize:preferences.editorFontSize}}/>}
 </section>
}
function EditorTitle({useTabInfo}:PropsRuntime<'sidebar.right.pane.tab.title'>){const {tab}=useTabInfo();const doc=useMemo(()=>fileDocument(tab.navigation.address),[tab.navigation.address]);const state=useSyncExternalStore(doc.subscribe,doc.snapshot,doc.snapshot);return <>{pathPartsOf(doc.path).name}{state.base&&state.base.content!==state.draft?' *':''}</>}
export function registerWorkspaceTabs(ctx:Context,surface:WorkspaceSurface){
 const tr=(zh:string,en:string)=>ctx.locale.getSnapshot().active.startsWith('zh')?zh:en
 // 模型字节走上游客户端既有的远程读接口（与原生文本预览同一个 workspaceFiles 面），不做新的 Host 接口。
 // 该面按需注入：未挂载时读取器只报告原因，文件/编辑器标签照常注册，不因缺一个远程服务整体失效。
 const missingModelBytes:ReadModelBytes=async()=>{throw Error(tr('模型预览需要客户端远程文件接口 workspaceFiles，但当前未挂载该服务。','Model preview needs the client remote workspaceFiles service, which is not mounted.'))}
 let reader=missingModelBytes
 const readModelBytes:ReadModelBytes=(sessionId,path,signal)=>reader(sessionId,path,signal)
 ctx.inject(['remote','remote.workspaceFiles'],owner=>{
  owner.effect(()=>{
   reader=async(sessionId,path,signal)=>{
    const result=await owner.remote.workspaceFiles.readAll(sessionId as SessionId,path,signal)
    if(!result.ok)throw Error(result.error.message)
    return Uint8Array.from(atob(result.value.data),character=>character.charCodeAt(0))
   }
   return()=>{reader=missingModelBytes}
  },'lyapunov-workspace: model preview bytes')
 })
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:TOOLS_ID,kind:TOOLS_KIND,priority:'extension',title:()=>tr('搜索与 Review','Search & Review'),keepMounted:true}))
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TOOLS_ID,locale:'lyapunovWorkspace',inject:()=>({surface})},WorkspaceTools)))
 // 原生 FilesBody/store/face 负责目录导航；这里只填同页的产品预览增量。
 ctx.effect(()=>ctx.slots.inject('sidebar.right.tab.files.actions',()=>ctx.slots.register({name:'sidebar.right.tab.files.actions',id:'lyapunov-html-open',registrant:'lyapunov-html-open',locale:'lyapunovWorkspace',inject:()=>({openHtmlAs:(sessionId:string,address:string,kind:string)=>ctx.sidebarRight.openResourceIn(sessionId as SessionId,address,{kind})})},FileActions)))
 // 二进制/模型文件不进文本编辑器：gltf 是 JSON、xml 可能是 MJCF，都归模型标签，否则两者同带同长度时编辑器按注册序胜出。
 const binary=/\.(png|jpe?g|gif|webp|bmp|ico|pdf|mp4|webm|mp3|wav|ogg|zip|gz|glb|gltf|blend|stl|spz|splat|ply|obj|fbx|dae|3mf|usdz|vtk|xml|mjcf|urdf|usd|usda|usdc|pt|pth|onnx|npy|npz)$/i
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:EDITOR_ID,kind:EDITOR_KIND,patterns:['dsh-resource://file/**'],priority:'extension',keepMounted:true,canOpen:address=>{const ref=parseFileAddress(address);return ref?.scope==='session'&&!binary.test(ref.path)&&!isHtmlPath(ref.path)},title:address=>{const ref=parseFileAddress(address);return ref?pathPartsOf(ref.path).name:tr('文件','File')}}))
 // HTML 源码编辑是**显式**通路（DEV-032）：`patterns` 故意写成不匹配任何文件地址的 glob，于是它永不参与自动认领，
 // `.html` 的默认打开仍是原生页面预览；用户点名 `openResource(address,{kind:HTML_EDITOR_KIND})` 时不看 globs、只看 canOpen。
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:HTML_EDITOR_ID,kind:HTML_EDITOR_KIND,patterns:['dsh-resource://html-source/**'],priority:'extension',keepMounted:true,canOpen:address=>{const ref=parseFileAddress(address);return ref?.scope==='session'&&!binary.test(ref.path)&&isHtmlPath(ref.path)},title:address=>{const ref=parseFileAddress(address);return ref?pathPartsOf(ref.path).name:tr('HTML 源码','HTML source')}}))
 // 模型标签与文本编辑器同为 extension 带：扩展名互斥（二进制正则含全部模型扩展名），谁能开谁的地址没有重叠。
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:MODEL_ID,kind:MODEL_KIND,patterns:['dsh-resource://file/**'],priority:'extension',keepMounted:true,canOpen:address=>{const ref=parseFileAddress(address);return ref?.scope==='session'&&modelKindOf(ref.path)!==undefined},title:address=>{const ref=parseFileAddress(address);return ref?pathPartsOf(ref.path).name:tr('模型','Model')}}))
 for(const [key,Body] of [[EDITOR_ID,EditorTab],[HTML_EDITOR_ID,EditorTab]] as const)ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key,locale:'lyapunovWorkspace',inject:()=>({surface,openHtmlAs:(sessionId:string,address:string,kind:string)=>ctx.sidebarRight.openResourceIn(sessionId as SessionId,address,{kind})})},Body)))
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:MODEL_ID,locale:'lyapunovWorkspace',inject:()=>({readBytes:readModelBytes})},ModelPreviewBody)))
 for(const key of [EDITOR_ID,HTML_EDITOR_ID])ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key},EditorTitle)))
}
