/**
 * 文件与会话状态的**唯一**所有者 + 两个可组合呈现。
 *
 * 为什么这样切：工作台要在中央视图里显示文件工作面、在底部抽屉里显示终端，而"文件草稿/保存与
 * 冲突/目录/搜索/终端选择"这摊业务只能有一份。于是状态集中在 `useWorkspaceSessionState`，
 * 由 `WorkspaceSessionProvider` 挂在工作台的会话座位上渲染一次；`FileSurface`（中央视图）与
 * `TerminalPanel`（底部抽屉）从同一个 context 读它——两个位置共享同一个实例，不是"渲染两处
 * ＝两个 owner"。`WorkspaceSession` 仍是自包含复合体（Provider + 两个呈现 + 一个开合按钮），
 * 供没有工作台外壳时直接使用。
 *
 * 保留读取身份、草稿纪元、自动保存与终端调用；根槽位切会话时显式复位会话状态，并在异步结果落地时核对所属会话。
 */
import {createContext,useContext,useEffect,useRef,useState,useSyncExternalStore} from "react"
import type {ReactNode} from "react"
import type {PropsLocale,PropsRuntime} from "@deepseek-ai/dsh-client-ui-slots"
import type {SettingsScope} from "@deepseek-ai/dsh-client-ui-settings/client"
import type {} from "../../lyapunov-contracts/src/workbench-slots.ts"
import type {WorkbenchReveal,WorkbenchSessionOwnerProps} from "../../lyapunov-contracts/src/workbench-slots.ts"
export type {WorkbenchReveal}
import {WORKSPACE_PREFERENCES,workspaceDefaults,workspaceActions,matchWorkspaceShortcut,workspaceFont,type WorkspacePreferences,type WorkspaceAction} from "./preferences.ts"
import {selectedFileContext,addSelectionToContext} from "./selection-context.ts"
import {ReviewPanel} from "./review-panel.tsx"
import {TerminalXterm} from "./terminal-xterm.tsx"
import {workspaceStyle} from "./workspace-style.ts"

type Entry={name:string;path:string;type:string}
type Terminal={sessionId:string;name?:string;status:{kind:string}}
export interface WorkspaceSurface{navigateFiles?:(options:{picker?:boolean;section?:"files"|"search"|"review";toggleTree?:boolean;newWorktree?:boolean})=>void;openDocument?:(sessionId:string,path:string,create?:boolean)=>Promise<void>|void;scope:SettingsScope<WorkspacePreferences>;current:(id:string)=>boolean;addSelection:(id:string,selection:ReturnType<typeof selectedFileContext>)=>void}
type FileDraft={file:{path:string;version?:string;content:string};draft:string}
// 仅保留当前浏览器页面中的编辑视图，不写文件、不创建另一套会话存储。
const sessionDrafts=new Map<string,FileDraft>()
// 只缓存会话内选中的终端ID，PTY及输出仍从Host读取；原生文件导航页不写这份选择。
const terminalSelections=new Map<string,string>()

export function useWorkspaceSessionState(sessionId:string,t:(key:"open")=>string,surface:WorkspaceSurface,exposed:boolean,reveal?:WorkbenchReveal){
  const preferenceState=useSyncExternalStore(listener=>surface.scope.subscribe(listener),()=>surface.scope.getSnapshot(),()=>surface.scope.getSnapshot()),preferences=preferenceState.value??workspaceDefaults,autoSave=preferenceState.status==="ready"&&preferences.autoSave
  const alive=useRef(true)
  const sessionTurn=useRef({sessionId})
  // 读取请求身份与编辑纪元：旧读取响应只有在“仍是最新请求且发出后没出现过新编辑”时才允许覆盖视图。
  const readRequest=useRef(0),editEpoch=useRef(0)
  const savingRef=useRef(false),autosaveTimer=useRef<ReturnType<typeof setTimeout>>(),autoAttempt=useRef<{path:string;draft:string}>(),section=useRef<HTMLElement|null>(null),pickerInput=useRef<HTMLInputElement>(null),editor=useRef<HTMLTextAreaElement>(null),findInput=useRef<HTMLInputElement>(null)
  const restored=sessionDrafts.get(sessionId)
  const tr=(zh:string,en:string)=>t("open")==="Files & terminal"?en:zh
  // 复合体自己的开合；工作台里由外壳决定呈现，exposed 直接生效。
  const [legacyOpen,setLegacyOpen]=useState(false),[tab,setTab]=useState("files"),[cwd,setCwd]=useState(""),[path,setPath]=useState("."),[entries,setEntries]=useState<Entry[]>([]),[file,setFile]=useState<FileDraft['file']|undefined>(restored?.file),[draft,setDraft]=useState(restored?.draft??""),[error,setError]=useState(""),[notice,setNotice]=useState(""),[newFilePath,setNewFilePath]=useState<string|undefined>()
  const [query,setQuery]=useState(""),[matches,setMatches]=useState<Array<{path:string;line:number;text:string}>>([]),[terminals,setTerminals]=useState<Terminal[]>([]),[terminal,setTerminal]=useState(()=>reveal?terminalSelections.get(sessionId)??"":""),[output,setOutput]=useState(""),[command,setCommand]=useState(""),[sending,setSending]=useState(false)
  const [fileTree,setFileTree]=useState(true),[picker,setPicker]=useState(false),[pickerQuery,setPickerQuery]=useState(""),[pickerPaths,setPickerPaths]=useState<string[]>([]),[worktreeRequest,setWorktreeRequest]=useState(0)
  // 目录树的展开状态与子目录缓存按路径持有：收起/导航都不丢缓存，只有会话切换才清。
  const [treeChildren,setTreeChildren]=useState<Record<string,Entry[]>>({}),[treeExpanded,setTreeExpanded]=useState<Record<string,boolean>>({}),[treeLoading,setTreeLoading]=useState<Record<string,boolean>>({})
  const [saving,setSaving]=useState(false),[finding,setFinding]=useState(false),[findText,setFindText]=useState(""),[terminalVisible,setTerminalVisible]=useState(false)
  // 根槽位在切会话时保留DOM。只复位会话的编辑/终端状态，画布和原生对话继续留在原位。
  if(sessionTurn.current.sessionId!==sessionId){
    if(file)sessionDrafts.set(sessionTurn.current.sessionId,{file,draft})
    sessionTurn.current={sessionId}
    readRequest.current++;editEpoch.current++;savingRef.current=false;autoAttempt.current=undefined
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current)
    const saved=sessionDrafts.get(sessionId)
    setFile(saved?.file);setDraft(saved?.draft??"");setCwd("");setPath(".");setEntries([]);setTab("files")
    setError("");setNotice("");setNewFilePath(undefined);setQuery("");setMatches([])
    setTreeChildren({});setTreeExpanded({});setTreeLoading({})
    setTerminals([]);setTerminal(reveal?terminalSelections.get(sessionId)??"":"");setOutput("");setCommand("");setSending(false)
    setPicker(false);setPickerQuery("");setPickerPaths([]);setWorktreeRequest(0)
    setSaving(false);setFinding(false);setFindText("")
  }
  const turn=sessionTurn.current,isCurrent=()=>alive.current&&sessionTurn.current===turn
  useEffect(()=>{if(reveal&&sessionId)terminalSelections.set(sessionId,terminal)},[sessionId,terminal,Boolean(reveal)])
  const open=exposed||legacyOpen
  const call=async<T=any>(action:string,input:unknown={}):Promise<T>=>{const stale=()=>new Error(tr("会话已切换，旧响应未应用。","Session changed; old response discarded."));if(!isCurrent())throw stale();const response=await fetch("/api/lyapunov/workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,action,input})});const value=await response.json();if(!isCurrent())throw stale();if(!response.ok)throw new Error(value.error??response.statusText);return value}
  const run=(fn:()=>Promise<unknown>)=>{if(!isCurrent())return;setError("");setNotice("");void fn().catch(error=>{if(isCurrent())setError(String(error.message??error))})}
  const list=async(directory:string)=>{const result=await call("list",{path:directory});if(!isCurrent())return;setEntries(result.entries);setPath(result.path??directory);setTreeChildren(current=>({...current,[directory]:result.entries}))}
  // 展开树节点只进缓存，不动 path/entries——path 仍只由“导航当前目录”（路径输入/打开）驱动。
  const expand=async(directory:string)=>{const result=await call("list",{path:directory});if(!isCurrent())return;setTreeChildren(current=>({...current,[directory]:result.entries}))}
  const toggleTreeNode=async(entry:Entry)=>{
    if(entry.type!=="directory")return openFile(entry.path)
    if(treeExpanded[entry.path]){setTreeExpanded(current=>({...current,[entry.path]:false}));return}
    setTreeExpanded(current=>({...current,[entry.path]:true}))
    if(treeChildren[entry.path])return
    setTreeLoading(current=>({...current,[entry.path]:true}))
    try{await expand(entry.path)}finally{if(isCurrent())setTreeLoading(current=>({...current,[entry.path]:false}))}
  }
  const openFile=async(path:string)=>{
    if(surface.openDocument){await surface.openDocument(sessionId,path);setPicker(false);return}
    if(savingRef.current)return
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current)
    const epoch=editEpoch.current
    if(file&&draft!==file.content){if(autoSave)await saveFile();else if(!window.confirm(tr("放弃尚未保存的编辑？","Discard unsaved changes?"))){readRequest.current++;return}}
    const request=++readRequest.current
    const result=await call("read",{path})
    if(!isCurrent()||request!==readRequest.current)return
    if(epoch!==editEpoch.current){setNotice(tr("读取期间已有新的编辑，读取结果未应用。","New edits arrived during the read; the result was not applied."));return}
    setFile(result);setDraft(result.content);setPicker(false);setTab("files");autoAttempt.current=undefined
  }
  const reloadFile=async()=>{
    if(!file||savingRef.current)return
    const epoch=editEpoch.current
    if(draft!==file.content&&!window.confirm(tr("重新读取会放弃当前未保存草稿，继续？","Reloading discards this unsaved draft. Continue?"))){readRequest.current++;return}
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current)
    const request=++readRequest.current
    const result=await call("read",{path:file.path})
    if(!isCurrent()||request!==readRequest.current)return
    if(epoch!==editEpoch.current){setNotice(tr("重读期间已有新的编辑，读取结果未应用。","New edits arrived during the reload; the result was not applied."));return}
    setFile(result);setDraft(result.content);autoAttempt.current=undefined
  }
  const newFile=()=>run(async()=>{
    if(surface.openDocument){setNewFilePath("");return}
    if(savingRef.current)return
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current)
    if(file&&draft!==file.content){if(autoSave)await saveFile();else if(!window.confirm(tr("放弃尚未保存的编辑？","Discard unsaved changes?"))){readRequest.current++;return}}
    if(isCurrent())setNewFilePath("")
  })
  const createNewFile=()=>{
    const name=newFilePath?.trim()
    if(!name){setError(tr("请输入新文件相对路径。","Enter a relative path for the new file."));return}
    if(surface.openDocument){run(async()=>{await surface.openDocument!(sessionId,name,true);if(isCurrent())setNewFilePath(undefined)});return}
    // 新建即换走当前编辑视图（即使尚未输入正文）：在途旧读取不得再覆盖用户刚创建的文件。
    readRequest.current++
    setFile({path:name,content:""});setDraft("");setTab("files");setNewFilePath(undefined);autoAttempt.current=undefined
  }
  const saveFile=async()=>{
    if(!isCurrent()||!file||savingRef.current||(draft===file.content&&file.version))return
    const selected=file,savedText=draft;savingRef.current=true;setSaving(true)
    const owner=sessionId
    try{
      // 写入已经由发起会话执行，回执需更新该会话的基版本；读取响应仍由call丢弃旧会话结果。
      const response=await fetch("/api/lyapunov/workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:owner,action:"write",input:{path:selected.path,content:savedText,version:selected.version}})})
      const result=await response.json()
      if(!alive.current)return
      if(!response.ok)throw new Error(result.error??response.statusText)
      const matches=(value:FileDraft['file']|undefined)=>value?.path===selected.path&&value.version===selected.version
      const parked=sessionDrafts.get(owner)
      if(parked&&matches(parked.file))sessionDrafts.set(owner,{file:{...parked.file,content:savedText,version:result.version},draft:parked.draft})
      // 当前会话和基版本都在实际落地时核对：不写另一个会话的同名文件，也不覆盖更新版本。
      setFile(current=>sessionTurn.current.sessionId===owner&&matches(current)?{...current!,content:savedText,version:result.version}:current)
      if(isCurrent()){setNotice(tr("文件已保存","File saved"));await list(path)}
    }finally{if(isCurrent()){savingRef.current=false;setSaving(false)}}
  }
  const findInFile=(backward=false)=>{
    const node=editor.current;if(!node||!findText)return
    const from=backward?node.selectionStart-1:node.selectionEnd
    let index=backward?(from<0?-1:draft.lastIndexOf(findText,from)):draft.indexOf(findText,from)
    if(index<0)index=backward?draft.lastIndexOf(findText):draft.indexOf(findText)
    if(index<0){setNotice(tr("当前文件没有匹配文本。","No matches in this file."));return}
    node.focus();node.setSelectionRange(index,index+findText.length);setNotice("")
  }
  const createTerminal=async()=>{const value=await call("terminal-open");if(!isCurrent())return;const list=await call("terminal-list");if(!isCurrent())return;setTerminal(value.sessionId);setTerminals(list);setOutput(value.motd??"");reveal?.terminal?.();setTerminalVisible(true);return value}
  const addSelection=()=>{const node=editor.current;if(!file||!node)throw new Error(tr("请先打开文件并选择文本。","Open a file and select text first."));surface.addSelection(sessionId,selectedFileContext(file.path,draft,node.selectionStart,node.selectionEnd,draft!==file.content));setNotice(tr("选区已加入当前会话草稿。","Selection added to the session draft."))}
  const search=async()=>{const result=await call("search",{query});if(!isCurrent())return;setMatches(result.matches);if(result.truncated)setNotice(tr("结果已截断，请缩小关键词范围","Results truncated; narrow the query"))}
  const readTerminal=async(id=terminal)=>{if(!id)return;const value=await call("terminal-read",{id});if(isCurrent())setOutput(value.text)}
  const interruptTerminal=async()=>{if(terminal)await call("terminal-interrupt",{id:terminal})}
  const closeTerminal=async()=>{if(!terminal)return;await call("terminal-close",{id:terminal});if(!isCurrent())return;setTerminal("");setOutput("");const list=await call("terminal-list");if(isCurrent())setTerminals(list)}
  const sendCommand=async()=>{if(!terminal||sending)return;setSending(true);try{await call("terminal-send",{id:terminal,text:command,submit:true});if(!isCurrent())return;setCommand("");await readTerminal()}finally{if(isCurrent())setSending(false)}}
  /** 文件工作面内的键位：只处理与当前工作面有关的动作；需要换呈现的动作交给 reveal。 */
  const shortcut=(action:WorkspaceAction)=>{
    if(action==="fileOpen"){reveal?.file?.();setTab("files");setPicker(true);setPickerQuery("");return}
    if(action==="panelClose"){if(picker)setPicker(false);else reveal?.canvas?.();return}
    if(action==="terminalToggle"){(reveal?.toggleTerminal??reveal?.terminal)?.();return}
    if(action==="reviewToggle"){reveal?.file?.();setTab("review");return}
    if(action==="fileTreeToggle"){reveal?.file?.();setTab("files");setFileTree(value=>!value);return}
    if(action==="terminalNew"){run(createTerminal);return}
    if(action==="worktreeNew"){reveal?.file?.();setTab("review");setWorktreeRequest(value=>value+1);return}
    if(action==="addSelection")run(async()=>addSelection())
  }
  useEffect(()=>{
    if(!autoSave||!file||draft===file.content||saving)return
    if(autoAttempt.current?.path===file.path&&autoAttempt.current?.draft===draft)return
    autosaveTimer.current=setTimeout(()=>{autoAttempt.current={path:file.path,draft};run(saveFile)},preferences.autoSaveDelayMs)
    return()=>{if(autosaveTimer.current)clearTimeout(autosaveTimer.current)}
  },[autoSave,preferences.autoSaveDelayMs,file?.path,file?.content,file?.version,draft,saving,sessionId])
  useEffect(()=>{if(!picker)return;let current=true;const timer=setTimeout(()=>{void call("file-find",{query:pickerQuery}).then(value=>{if(current&&isCurrent())setPickerPaths(value.paths)}).catch(error=>{if(current&&isCurrent())setError(error.message)})},120);return()=>{current=false;clearTimeout(timer)}},[picker,pickerQuery,sessionId])
  useEffect(()=>{if(picker)requestAnimationFrame(()=>pickerInput.current?.focus())},[picker])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{if(file)sessionDrafts.set(sessionId,{file,draft});else sessionDrafts.delete(sessionId)},[sessionId,file,draft])
  useEffect(()=>{if(!file||draft===file.content)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=""};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn)},[file,draft])
  useEffect(()=>{if(!open||!sessionId)return;let live=true;void call("info").then(value=>{if(live){setCwd(value.cwd);setTerminals(value.terminals)}}).catch(error=>{if(live&&isCurrent())setError(error.message)});run(()=>list(path));return()=>{live=false}},[open,sessionId])
  // 终端轮询只在终端真的显示时进行（抽屉收起＝停轮询，会话本身不动）。
  useEffect(()=>{if(!terminalVisible||!terminal)return;const timer=setInterval(()=>{void readTerminal().catch(error=>{if(isCurrent())setError(error.message)})},1000);return()=>clearInterval(timer)},[terminalVisible,terminal,sessionId])
  return {
    sessionId,tr,preferences,autoSave,cwd,path,entries,file,draft,error,notice,query,matches,terminals,terminal,output,command,sending,tab,fileTree,picker,pickerQuery,pickerPaths,worktreeRequest,saving,finding,findText,newFilePath,open,terminalVisible,treeChildren,treeExpanded,treeLoading,
    refs:{section,pickerInput,editor,findInput},
    setters:{setPath,setDraft,setQuery,setCommand,setTab,setFileTree,setPicker,setPickerQuery,setNewFilePath,setFinding,setFindText,setTerminal,setOutput,setTerminals,setLegacyOpen,setTerminalVisible},
    actions:{call,list,expand,toggleTreeNode,openFile,reloadFile,newFile,createNewFile,saveFile,findInFile,createTerminal,addSelection,search,readTerminal,interruptTerminal,closeTerminal,sendCommand,shortcut,run,editEpoch},
  }
}
export type WorkspaceSession=ReturnType<typeof useWorkspaceSessionState>

const WorkspaceContext=createContext<WorkspaceSession|undefined>(undefined)
/** 读取工作区状态：不在 Provider 里时返回 undefined，呈现层据实提示而不是自己再建一份。 */
export function useWorkspaceSession():WorkspaceSession|undefined{return useContext(WorkspaceContext)}

/** 会话级状态座位：工作台把中央视图与抽屉交给它包住，两者共享同一实例。 */
export function WorkspaceSessionProvider({t,surface,sessionId,exposed,reveal,children}:PropsRuntime<"lyapunov.workbench.session">&PropsLocale<"lyapunovWorkspace">&WorkbenchSessionOwnerProps&{surface:WorkspaceSurface;reveal?:WorkbenchReveal}){
  // reveal 由工作台座位传进来（"新建终端后把抽屉露出来"这类会话内跳转）；不再有模块级
  // 命令注册表：输入区那个旧入口已撤掉，工作台工具栏是文件/终端的唯一入口。
  const value=useWorkspaceSessionState(sessionId??"",t,surface,exposed===true,reveal)
  useEffect(()=>{
    if(!surface.navigateFiles)return
    const keydown=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.isComposing||event.repeat||!sessionId||!surface.current(sessionId))return
      if(event.target instanceof Element&&event.target.closest('[role=dialog]'))return
      const action=workspaceActions.find(action=>matchWorkspaceShortcut(event,value.preferences.shortcuts[action],/Mac|iPhone|iPad/.test(navigator.platform)))
      if(!action||action==='addSelection'||action==='panelClose')return
      event.preventDefault();event.stopPropagation()
      if(action==='fileOpen')surface.navigateFiles!({picker:true,section:'files'})
      else if(action==='reviewToggle')surface.navigateFiles!({section:'review'})
      else if(action==='fileTreeToggle')surface.navigateFiles!({section:'files',toggleTree:true})
      else if(action==='worktreeNew')surface.navigateFiles!({section:'review',newWorktree:true})
      else value.actions.shortcut(action)
    }
    document.addEventListener('keydown',keydown);return()=>document.removeEventListener('keydown',keydown)
  },[sessionId,surface,value.preferences,value.actions.shortcut])
  return <><style>{workspaceStyle}</style><WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider></>
}

/** 文件工作面（中央视图）：文件树 + 编辑器 + 搜索 + Git/Review 页签。 */
export function FileSurface({t}:PropsRuntime<"lyapunov.workbench.centre">&PropsLocale<"lyapunovWorkspace">){
  const session=useWorkspaceSession()
  if(!session)return <p className="code-error" role="alert">{t("unmounted")}</p>
  if(!session.sessionId)return <div className="lya-wb-missing" role="status"><div><strong>{session.tr("先选择工作区","Choose a workspace")}</strong><p>{session.tr("在左侧添加或选择工作区后，就可以浏览和编辑文件。","Add or choose a workspace on the left to browse and edit its files.")}</p></div></div>
  return <FileSurfaceBody session={session}/>
}
/** 终端抽屉（底部）：真实 PTY 会话，切位置不换会话。 */
export function TerminalPanel({t,visible}:PropsRuntime<"lyapunov.workbench.drawer">&PropsLocale<"lyapunovWorkspace">){
  const session=useWorkspaceSession()
  const setVisible=session?.setters.setTerminalVisible
  // 抽屉宿主常驻挂载，可见性来自 owner 参数：可见才轮询输出，收起就停；终端会话本身不动。
  useEffect(()=>{setVisible?.(visible===true);return()=>{setVisible?.(false)}},[setVisible,visible])
  if(!session)return <p className="code-error" role="alert">{t("unmounted")}</p>
  if(!session.sessionId)return <div className="lya-wb-missing" role="status"><div><strong>{session.tr("先选择工作区","Choose a workspace")}</strong><p>{session.tr("终端会在当前工作区中运行。请先在左侧添加或选择工作区。","Terminals run in the current workspace. Add or choose one on the left first.")}</p></div></div>
  return <><div className="code-toolbar"><span>{session.tr("终端","Terminal")}</span><button type="button" onClick={()=>{void session.actions.closeTerminal()}}>{session.tr("关闭终端","Close terminal")}</button></div><TerminalBody session={session}/></>
}

/** 自包含复合体：Provider + 两个呈现 + 开合按钮（没有工作台外壳时使用，行为与原先的浮层一致）。 */
export function WorkspaceSession({sessionId,t,surface,reveal}:{sessionId:string;t:(key:"open")=>string;surface:WorkspaceSurface;reveal?:WorkbenchReveal}){
  const session=useWorkspaceSessionState(sessionId,t,surface,false,reveal)
  const {tr,tab,open}=session
  return <WorkspaceContext.Provider value={session}>
    <style>{workspaceStyle}</style>
    <button type="button" onClick={()=>session.setters.setLegacyOpen(!open)}>{t("open")}</button>
    {open&&<section ref={session.refs.section} className="lyapunov-code" aria-label={t("open")}>
      <header><strong>{t("open")}</strong><small>{session.cwd}</small><button onClick={()=>session.setters.setLegacyOpen(false)}>{tr("收起","Close panel")}</button></header>
      <nav>{[["files","文件","Files"],["search","搜索","Search"],["terminal","终端","Terminal"],["review","Git / Review","Git / Review"]].map(([id,zh,en])=><button key={id} aria-pressed={tab===id} onClick={()=>session.setters.setTab(id!)}>{tr(zh!,en!)}</button>)}</nav>
      {tab==="terminal"?<TerminalBody session={session}/>:tab==="review"?<ReviewPanel key={sessionId} request={session.actions.call} worktreeRequest={session.worktreeRequest} english={t("open")==="Files & terminal"}/>:<FileSurfaceBody session={session} embedded={false}/>}
    </section>}
  </WorkspaceContext.Provider>
}

/** 文件工作面主体。embedded=false 用于自包含复合体（不在工作台中央时，样式退回浮层形态）。 */
/** 目录/文件条目小图标：目录一类；文件按扩展名归四类（代码 / 3D 模型 / 其它媒体 / 普通文档）。 */
function EntryIcon({name,directory}:{name:string;directory:boolean}){
  const extension=name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase()??""
  const kind=directory?"folder":/^(tsx?|jsx?|mjs|cjs|py|rs|go|java|c|cc|cpp|h|hpp|css|scss|html?|vue|svelte|json|ya?ml|toml|xml|sql|sh|bash|zsh)$/.test(extension)?"code":/^(glb|gltf|spz|splat|ply|stl|obj|fbx|blend|dae|3mf|usdz|vtk|usd|usda|usdc|mjcf|urdf)$/.test(extension)?"model":/^(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|mp3|wav|ogg)$/.test(extension)?"media":"doc"
  return <svg className={"code-entry-icon code-entry-icon-"+kind} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==="folder"?<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>
    :kind==="code"?<><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M13 3v6h6"/><path d="m10 13-1.5 1.5L10 16M14 13l1.5 1.5L14 16"/></>
    :kind==="model"?<><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z"/><path d="M3.6 7 12 11.6 20.4 7"/><path d="M12 11.6v9.8"/></>
    :kind==="media"?<><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-4.5-4.5L9 18"/></>
    :<><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M13 3v6h6"/></>}
  </svg>
}
/** 目录树：根是 path 当前目录的条目；目录行展开/收起（懒加载进缓存，收起不丢），文件行保持 openFile。 */
function EntryTree({session,entries,depth}:{session:WorkspaceSession;entries:Entry[];depth:number}){
  const {saving,treeChildren,treeExpanded,treeLoading}=session
  const {run,toggleTreeNode}=session.actions
  return <>{entries.map(entry=>{
    const directory=entry.type==="directory",expanded=directory&&treeExpanded[entry.path]===true,loading=expanded&&treeLoading[entry.path]===true,children=treeChildren[entry.path]
    return <div key={entry.path} className="code-tree-node">
      <button disabled={saving} className="code-entry" data-kind={directory?"directory":"file"} style={{paddingLeft:8+depth*14}} onClick={()=>run(()=>toggleTreeNode(entry))}>
        {directory?<span className="code-chevron" aria-hidden="true">{expanded?"▾":"▸"}</span>:<span className="code-chevron" aria-hidden="true"/>}
        <EntryIcon name={entry.name} directory={directory}/>
        <span className="code-entry-name">{entry.name}</span>
      </button>
      {expanded&&children&&<EntryTree session={session} entries={children} depth={depth+1}/>}
      {loading&&<div className="code-entry code-entry-loading" style={{paddingLeft:8+(depth+1)*14}}>…</div>}
    </div>
  })}</>
}
export function FileSurfaceBody({session,embedded=true,active=true,navigationOnly=false,toolsOnly=false}:{session:WorkspaceSession;embedded?:boolean;active?:boolean;navigationOnly?:boolean;toolsOnly?:boolean}){
  const {tr,preferences,autoSave,tab,file,draft,path,entries,saving,finding,findText,picker,pickerQuery,pickerPaths,newFilePath,error,notice,matches,query,fileTree}=session
  const {setDraft,setPath,setPicker,setPickerQuery,setNewFilePath,setFinding,setFindText,setQuery,setTab,setFileTree}=session.setters
  const {run,list,openFile,reloadFile,newFile,createNewFile,saveFile,findInFile,addSelection,search,shortcut,editEpoch}=session.actions
  const {section,pickerInput,editor,findInput}=session.refs
  useEffect(()=>{
    if(!active)return
    const keydown=(event:KeyboardEvent)=>{
      if(event.isComposing||event.repeat||event.defaultPrevented)return
      const target=event.target instanceof Element?event.target:undefined,owned=Boolean(target&&section.current?.contains(target))
      if(target?.closest('[role=dialog],.xterm,.monaco-editor')&&!owned)return
      const action=workspaceActions.find(action=>matchWorkspaceShortcut(event,preferences.shortcuts[action],/Mac|iPhone|iPad/.test(navigator.platform)))
      if(!action||action==="panelClose"&&!picker&&!owned||action==="addSelection"&&(!owned||target!==editor.current))return
      // 原生文件页只处理文件键位；终端键位交给仍挂载的会话终端宿主。
      if(navigationOnly&&(action==="terminalNew"||action==="terminalToggle"))return
      event.preventDefault();event.stopPropagation();shortcut(action)
    }
    document.addEventListener("keydown",keydown);return()=>document.removeEventListener("keydown",keydown)
  },[active,navigationOnly,preferences,picker,file,draft,shortcut])
  return <section ref={node=>{section.current=node}} className={embedded?"lya-file-surface":"lya-file-surface lya-file-surface-flat"} aria-label={tr("文件与终端","Files & terminal")} onKeyDown={event=>{
    if(tab!=="files"||!file||!(event.ctrlKey||event.metaKey)||event.altKey)return
    if(event.key.toLowerCase()==="s"&&!event.shiftKey){event.preventDefault();event.stopPropagation();run(saveFile)}
    if(event.key.toLowerCase()==="f"&&!event.shiftKey){event.preventDefault();event.stopPropagation();setFinding(true);requestAnimationFrame(()=>findInput.current?.focus())}
  }}>
    <nav className="code-tabs">{[["files","文件","Files"],["search","搜索","Search"],["review","Git / Review","Git / Review" ]].filter(([id])=>!toolsOnly||id!=="files").map(([id,zh,en])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id!)}>{tr(zh!,en!)}</button>)}</nav>
    {picker&&<div role="dialog" aria-label={tr("打开文件","Open file")} className="code-picker"><form onSubmit={event=>{event.preventDefault();if(pickerQuery.trim())run(()=>openFile(pickerQuery.trim()))}}><input ref={pickerInput} aria-label={tr("文件路径搜索","Find file by path")} placeholder={tr("搜索或输入相对路径…","Search or enter a relative path…")} value={pickerQuery} onChange={event=>setPickerQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setPicker(false)}}}/><button>{tr("打开路径","Open path")}</button><button type="button" onClick={()=>setPicker(false)}>{tr("关闭","Close")}</button></form>{pickerPaths.map(path=><button className="code-entry" key={path} onClick={()=>run(()=>openFile(path))}>{path}</button>)}</div>}
    {newFilePath!==undefined&&<div role="dialog" aria-label={tr("新建文件","New file")} className="code-picker"><form onSubmit={event=>{event.preventDefault();createNewFile()}}><input autoFocus aria-label={tr("新文件相对路径","New file relative path")} placeholder={tr("例如 notes/t005.txt","for example notes/t005.txt")} value={newFilePath} onChange={event=>setNewFilePath(event.target.value)}/><button>{tr("创建","Create")}</button><button type="button" onClick={()=>setNewFilePath(undefined)}>{tr("取消","Cancel")}</button></form></div>}
    {error&&<p role="alert" className="code-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {tab==="files"&&!toolsOnly&&<div className={"code-columns"+(navigationOnly?" code-navigation-only":fileTree?"":" code-tree-hidden")}>{(fileTree||navigationOnly)&&<aside>{navigationOnly&&<div className="code-nav-title"><span>{tr("工作区文件","Workspace files")}</span><span>{entries.length}</span></div>}<form onSubmit={event=>{event.preventDefault();run(()=>list(path))}}><input aria-label={tr("目录","Directory")} value={path} onChange={event=>setPath(event.target.value)}/><button>{tr("打开","Open")}</button></form><button disabled={saving} onClick={newFile}>{tr("新建文件","New file")}</button><EntryTree session={session} entries={entries} depth={0}/></aside>}{!navigationOnly&&<article>{file?<><div className="code-toolbar"><span>{file.path}{draft!==file.content?" *":""}</span><small>{autoSave?tr("自动保存","Autosave"):tr("手动保存","Manual save")}</small><button disabled={saving||(draft===file.content&&Boolean(file.version))} aria-keyshortcuts="Control+S Meta+S" onClick={()=>run(saveFile)}>{saving?tr("保存中","Saving"):tr("保存","Save")}</button><button disabled={saving} onClick={()=>run(reloadFile)}>{tr("重新读取磁盘","Reload from disk")}</button><button aria-keyshortcuts="Control+F Meta+F" onClick={()=>{setFinding(true);requestAnimationFrame(()=>findInput.current?.focus())}}>{tr("文件内查找","Find in file")}</button><button onMouseDown={event=>event.preventDefault()} onClick={()=>run(async()=>addSelection())}>{tr("选区加入上下文","Add selection to context")}</button></div>{finding&&<form onSubmit={event=>{event.preventDefault();findInFile()}}><input ref={findInput} aria-label={tr("文件内查找","Find in file")} value={findText} onChange={event=>setFindText(event.target.value)} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setFinding(false);editor.current?.focus()}else if(event.key==="Enter"&&event.shiftKey){event.preventDefault();findInFile(true)}}}/><button type="button" disabled={!findText} onClick={()=>findInFile(true)}>{tr("上一处","Previous")}</button><button disabled={!findText}>{tr("下一处","Next")}</button><button type="button" onClick={()=>setFinding(false)}>{tr("关闭查找","Close find")}</button></form>}<textarea ref={editor} className="code-editor" style={{fontFamily:workspaceFont(preferences.editorFontFamily),fontSize:preferences.editorFontSize}} spellCheck={false} aria-label={tr("文件内容","File content")} value={draft} onChange={event=>{editEpoch.current++;setDraft(event.target.value)}}/></>:<p>{tr("选择文件开始编辑。","Choose a file to edit.")}</p>}</article>}</div>}
    {tab==="search"&&<article className="lya-file-article"><form onSubmit={event=>{event.preventDefault();run(search)}}><input aria-label={tr("搜索文本","Search text")} value={query} onChange={event=>setQuery(event.target.value)}/><button>{tr("搜索","Search")}</button></form>{matches.map((match,i)=><button className="code-match" key={i} onClick={()=>run(async()=>{await openFile(match.path);setTab("files")})}><strong>{match.path}:{match.line}</strong><pre>{match.text}</pre></button>)}</article>}
    {tab==="review"&&<ReviewPanel key={session.sessionId} request={session.actions.call} worktreeRequest={session.worktreeRequest} english={tr("zh","en")==="en"}/>}
  </section>
}

/** 终端主体：输出 + 命令输入 + 会话选择（PTY 由 host ctx.terminals 持有）。 */
function TerminalBody({session}:{session:WorkspaceSession}){
  // 真实交互终端（xterm.js + Host node-pty）；旧的行式命令通道保留给 Agent 工具使用。
  return <TerminalXterm sessionId={session.sessionId} tr={session.tr}/>
}
