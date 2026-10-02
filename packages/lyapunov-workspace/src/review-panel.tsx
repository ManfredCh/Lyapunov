import {useEffect,useState,useRef} from 'react'
import type {ReviewComment} from './plugin.ts'
import {reviewLines,type ReviewLine} from './review-lines.ts'
type Request=(action:string,input?:unknown)=>Promise<any>
interface Props{request:Request;english:boolean;worktreeRequest?:number}
export function ReviewPanel({request,english,worktreeRequest=0}:Props){
  const tr=(zh:string,en:string)=>english?en:zh
  const [git,setGit]=useState<any>(),[file,setFile]=useState(''),[diff,setDiff]=useState(''),[staged,setStaged]=useState(false)
  // Git status can contain hundreds of generated evidence directories. Keep
  // the review surface usable without hiding anything from the workspace:
  // filter the list locally, while every item remains available on refresh.
  const [fileFilter,setFileFilter]=useState(''),[statusFilter,setStatusFilter]=useState<'all'|'tracked'|'untracked'|'staged'>('all')
  const [comments,setComments]=useState<ReviewComment[]>([]),[anchor,setAnchor]=useState<{path:string;line:number;side:'old'|'new'}>(),[body,setBody]=useState('')
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[commit,setCommit]=useState(''),[worktree,setWorktree]=useState(''),[branch,setBranch]=useState(''),[createBranch,setCreateBranch]=useState(true)
  const [extraOpen,setExtraOpen]=useState(false),worktreeInput=useRef<HTMLInputElement>(null)
  const run=(fn:()=>Promise<unknown>)=>{setError('');setMessage('');void fn().catch(error=>setError(String(error.message??error)))}
  const refresh=async()=>{const [status,rows]=await Promise.all([request('git-status'),request('comments')]);setGit(status);setComments(rows)}
  const open=async(path:string,cached=staged)=>{const result=await request('git-diff',{path,staged:cached});if(result.exitCode!==0)throw new Error(result.stderr);setFile(path);setDiff(result.stdout);setAnchor(undefined);setBody('')}
  useEffect(()=>{run(refresh)},[])
  useEffect(()=>{if(worktreeRequest&&git?.isRepository){setExtraOpen(true);requestAnimationFrame(()=>worktreeInput.current?.focus())}},[worktreeRequest,git?.isRepository])
  const selectLine=(row:ReviewLine)=>{const side=row.newLine===undefined?'old':'new',line=row.newLine??row.oldLine;if(line!==undefined)setAnchor({path:file,line,side})}
  const files=git?.files??[]
  const visibleFiles=files.filter((item:any)=>{
    const path=String(item.path??''),status=String(item.status??'')
    const matchesPath=!fileFilter.trim()||path.toLocaleLowerCase().includes(fileFilter.trim().toLocaleLowerCase())
    const matchesStatus=statusFilter==='all'||(statusFilter==='untracked'&&status.trim()==='??')||(statusFilter==='staged'&&status[0]!==' '&&status[0]!== '?')||(statusFilter==='tracked'&&status.trim()!=='??')
    return matchesPath&&matchesStatus
  })
  return <article className="code-review">
    <div className="code-toolbar">
      <button onClick={()=>run(refresh)}>{tr('刷新','Refresh')}</button>
      <label><input type="checkbox" checked={staged} onChange={event=>{setStaged(event.target.checked);if(file)run(()=>open(file,event.target.checked))}}/>{tr('已暂存','Staged')}</label>
      <label>{tr('状态','Status')}<select aria-label={tr('状态筛选','Status filter')} value={statusFilter} onChange={event=>setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">{tr('全部','All')}</option><option value="tracked">{tr('已跟踪','Tracked')}</option><option value="untracked">{tr('未跟踪','Untracked')}</option><option value="staged">{tr('已暂存','Staged')}</option></select></label>
      <input aria-label={tr('过滤文件','Filter files')} placeholder={tr('按路径过滤…','Filter paths…')} value={fileFilter} onChange={event=>setFileFilter(event.target.value)}/>
    </div>
    {error&&<p className="code-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {!git?<p>{tr('正在读取Git状态…','Reading Git status…')}</p>:!git.isRepository?<p>{git.stderr}</p>:<>
      {git.files.length===0&&<p>{tr('工作区没有未提交修改。','No uncommitted changes.')}</p>}
      {git.files.length>0&&<p className="code-hint">{tr(`显示 ${visibleFiles.length}/${git.files.length} 个文件；用状态或路径筛选。`,`Showing ${visibleFiles.length}/${git.files.length} files; filter by status or path.`)}</p>}
      <div className="code-columns">
        <aside>{visibleFiles.length===0?<p className="code-hint">{tr('没有匹配的文件。','No matching files.')}</p>:visibleFiles.map((item:any)=><button className="code-entry" key={item.path} onClick={()=>run(()=>open(item.path))}>{item.status} {item.path}</button>)}</aside>
        <div>
          {file&&<div className="code-toolbar"><strong>{file}</strong><button onClick={()=>run(async()=>{const result=await request(staged?'git-unstage':'git-stage',{path:file});if(result.exitCode!==0)throw new Error(result.stderr);await refresh();await open(file)})}>{staged?tr('取消暂存','Unstage'):tr('暂存','Stage')}</button></div>}
          <div className="code-diff" role="region" aria-label={tr('代码差异','Code diff')}>
            {reviewLines(diff).map((row,index)=>row.kind==='meta'?<div className="diff-meta" key={index}>{row.text}</div>:<button key={index} className={'diff-line '+row.kind} aria-label={`${file}:${row.newLine??row.oldLine} ${row.kind}`} onClick={()=>selectLine(row)}><span>{row.oldLine??''}</span><span>{row.newLine??''}</span><code>{row.text}</code></button>)}
          </div>
          {file&&!anchor&&<p className="code-hint">{tr('点击代码行即可添加评论。','Click a code line to comment.')}</p>}
          {anchor&&<form onSubmit={event=>{event.preventDefault();run(async()=>{setComments(await request('comment-add',{...anchor,body}));setBody('');setAnchor(undefined)})}}>
            <label>{anchor.path}:{anchor.line} · {anchor.side==='new'?tr('新行','New line'):tr('旧行','Old line')}</label>
            <input autoFocus aria-label={tr('评论内容','Comment')} placeholder={tr('指出需要修改的内容…','Describe the change needed…')} value={body} onChange={event=>setBody(event.target.value)}/>
            <button disabled={!body.trim()}>{tr('保存评论','Save comment')}</button><button type="button" onClick={()=>setAnchor(undefined)}>{tr('取消','Cancel')}</button>
          </form>}
          {comments.filter(comment=>!file||comment.path===file).map(comment=><p key={comment.id}><strong>{comment.path}:{comment.line}</strong> {comment.body} <button onClick={()=>run(async()=>setComments(await request('comment-remove',{id:comment.id})))}>{tr('删除评论','Delete comment')}</button></p>)}
        </div>
      </div>
      <details className="code-extra" open={extraOpen} onToggle={event=>setExtraOpen(event.currentTarget.open)}><summary>{tr('更多Git操作','More Git actions')}</summary>
        <form onSubmit={event=>{event.preventDefault();run(async()=>{const result=await request('git-commit',{message:commit});if(result.exitCode!==0)throw new Error(result.stderr);setMessage(result.stdout);setCommit('');await refresh()})}}><input aria-label={tr('提交说明','Commit message')} placeholder={tr('本地提交说明','Local commit message')} value={commit} onChange={event=>setCommit(event.target.value)}/><button disabled={!commit.trim()}>{tr('提交已暂存更改','Commit staged changes')}</button></form>
        <h4>Worktree</h4><pre>{git.worktrees?.stdout}</pre>
        <form onSubmit={event=>{event.preventDefault();run(async()=>{const result=await request('git-worktree',{path:worktree,branch,create:createBranch});if(result.exitCode!==0)throw new Error(result.stderr);setMessage(tr('Worktree已加入工作区列表','Worktree added to workspace list'));await refresh()})}}><input ref={worktreeInput} aria-label={tr('Worktree路径','Worktree path')} placeholder={tr('Worktree路径','Worktree path')} value={worktree} onChange={event=>setWorktree(event.target.value)}/><input aria-label={tr('分支名称','Branch')} placeholder={tr('分支名称','Branch')} value={branch} onChange={event=>setBranch(event.target.value)}/><label><input type="checkbox" checked={createBranch} onChange={event=>setCreateBranch(event.target.checked)}/>{tr('新建分支','Create branch')}</label><button disabled={!branch||!worktree}>{tr('创建Worktree','Create worktree')}</button></form>
      </details>
    </>}
  </article>
}
