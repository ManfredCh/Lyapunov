/** 只读执行图标签；关闭仅卸载观察请求，不取消Loop、Jobs或Sim。 */
import {useCallback,useEffect,useState} from 'react'
import type {Context} from '@deepseek-ai/cordis'
import type {PropsLocale,PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {ExecutionGraph,GraphNode} from './execution-graph.ts'
import type {ModelProgress} from './execution-graph-host.ts'

export const EXECUTION_GRAPH_KIND='lyapunov.graph'
const ID='@lyapunov/shell/execution-graph'
const zh={title:'执行图',refresh:'刷新状态',hint:'图从原生日志与当前任务状态重建，关闭此页不改变执行。',loading:'正在读回状态…',error:'无法读回执行状态',model:'模型运输',jobs:'后台任务',contexts:'当前有效输入',empty:'当前没有已提交执行事件。',unknown:'未知，先读原任务结果',accepted:'已受理',images:'图像内容块',owner:'来源',bytes:'UTF-8字节',hash:'内容hash',basis:'模型适配前的原生请求；不是线上body/token或计费值',stop:'停止结果',physical:'物理停止由Sim另行确认',running:'运行',success:'成功回执',failed:'失败',cancelled:'已取消',waiting:'等待',unknownStatus:'未知',phase:'阶段',argumentChars:'工具参数字符',silent:'距语义进展毫秒',cropped:'图已裁剪，原生日志保留。',handoff:'恢复已交接，等待新事实或用户继续。',retries:'重试',tools:'工具目录',effects:'尚未确认的副作用',effect:'结果与费用影响',requestId:'原请求身份'}
const en:typeof zh={title:'Execution graph',refresh:'Refresh state',hint:'Rebuilt from native events and current job state. Closing this page does not change execution.',loading:'Reading state…',error:'Execution state unavailable',model:'Model transport',jobs:'Background jobs',contexts:'Effective input',empty:'No committed execution events.',unknown:'Unknown; read the original operation first',accepted:'Accepted',images:'Image blocks',owner:'Owner',bytes:'UTF-8 bytes',hash:'Content hash',basis:'Native request before adapter conversion; not wire bytes, tokens or billing',stop:'Stop state',physical:'Physical stop requires Sim confirmation',running:'Running',success:'Success receipt',failed:'Failed',cancelled:'Cancelled',waiting:'Waiting',unknownStatus:'Unknown',phase:'Phase',argumentChars:'Tool argument characters',silent:'Milliseconds since semantic progress',cropped:'Graph cropped; native history retained.',handoff:'Recovery handed off; waiting for new facts or user input.',retries:'Retries',tools:'Tools',effects:'Unknown effects',effect:'Outcome and billing effect',requestId:'Original request ID'}
declare module '@deepseek-ai/dsh-client-ui-slots' {interface LocaleNamespaceMap {lyapunovGraph:keyof typeof zh}}
type JobRow={jobId:string;currentStatus:string;registryId:string|null;startedAt:number|null;finishedAt:number|null;matched:boolean}
export interface ExecutionGraphPayload {graph:ExecutionGraph;hostInstanceId:string;jobs:JobRow[];model:(ModelProgress&{noProgressWaitMs:number})|null;liveJobCount:number;stop:{agentStatus:string;jobs:{id:string;registryId:string|null;status:string}[];physicalStop:string;unknownEffects:number}}
type Props=PropsRuntime<'sidebar.right.pane.tab'>&PropsLocale<'lyapunovGraph'>

/** 无原文或执行按钮的图卡；关联边由native parent身份决定。 */
export function ExecutionGraphView({value,t}:{value:ExecutionGraphPayload;t:(key:keyof typeof zh)=>string}){
 const status=(node:GraphNode)=>t(node.status==='unknown'?'unknownStatus':node.status)
 return <section aria-label={t('title')} style={{padding:14,display:'grid',gap:14,fontSize:12}}>
  <p style={{margin:0,opacity:.7}}>{t('hint')}</p>
  {value.model&&<fieldset><legend>{t('model')}</legend><div>{t('phase')}: {value.model.phase} · {value.model.phaseFailureCode??value.model.finishCode??'—'}</div><div>{t('argumentChars')}: {value.model.argumentChars} · {t('silent')}: {value.model.noProgressWaitMs}</div><code>{value.model.partialTools.join(', ')}</code><div>{t('retries')} {value.model.retry}/{value.model.maxRetries??'—'}</div>{value.model.diagnostic&&<div>{t('phase')}: {value.model.diagnostic.stage??'—'} · {t('effect')}: {value.model.diagnostic.effect}<small style={{display:'block'}}>{t('requestId')}: {value.model.diagnostic.requestId??'—'}</small></div>}</fieldset>}
  <fieldset><legend>{t('jobs')} · {value.liveJobCount}</legend>{value.jobs.map(job=><div key={`${job.registryId}:${job.jobId}:${job.startedAt}`} data-job-identity={`${job.registryId}:${job.jobId}:${job.startedAt}`}><strong>{job.jobId}</strong> · {job.matched?job.currentStatus:t('unknown')}<small style={{display:'block',opacity:.65}}>{job.registryId??'—'}</small></div>)}</fieldset>
  {value.stop.agentStatus!=='running'&&value.liveJobCount>0&&<p role='status'>{t('title')==='执行图'?'当前模型循环未运行，但已提交的后台作业仍在运行。Goal 暂停不会自动暂停这些作业；请按原作业身份查看或控制。':'The model loop is idle while submitted background jobs are still running. Pausing a Goal does not pause these jobs; inspect or control them through their original identities.'}</p>}
  <fieldset><legend>{t('stop')}</legend>{value.stop.agentStatus} · {t('physical')} · {t('effects')} {value.stop.unknownEffects}</fieldset>
  {value.graph.recovery.handoffSeq!==null&&<p role='status'>{t('handoff')}</p>}
  <div role='tree' aria-label={t('title')} style={{display:'grid',gap:5}}>{value.graph.nodes.length===0?<p>{t('empty')}</p>:value.graph.nodes.map(node=><div key={node.id} role='treeitem' data-node-id={node.id} data-parent-id={node.parent??''} style={{marginLeft:node.kind==='turn'?0:node.kind==='step'?12:28,borderLeft:'2px solid var(--dsw-alias-border-l1)',padding:'6px 8px'}}><span style={{opacity:.6}}>#{node.seq} {node.kind} → </span><strong>{node.label}</strong> · {status(node)}{node.code&&<code> · {node.code}</code>}{node.images>0&&<span> · {t('images')}: {node.images}</span>}{node.diagnostic&&<small style={{display:'block'}}>{t('phase')}: {node.diagnostic.stage??'—'} · {t('effect')}: {node.diagnostic.effect} · {node.diagnostic.upstreamHttpStatus??'—'}<br/>{t('requestId')}: {node.diagnostic.requestId??'—'}</small>}</div>)}</div>
  {value.graph.omittedNodes>0&&<p>{t('cropped')} ({value.graph.omittedNodes})</p>}
  {value.graph.request&&<details><summary>{t('contexts')}</summary><p>{t('basis')}</p><div>{t('tools')} {value.graph.request.toolCount} · {value.graph.request.toolsBytes} {t('bytes')}</div>{value.graph.request.contexts.map((context,i)=><div key={`${context.owner}:${i}`} style={{padding:5,wordBreak:'break-all'}}><strong>{context.owner}</strong> · {context.form} · {context.bytes} {t('bytes')} · {context.images} {t('images')}<small style={{display:'block'}}>{t('hash')}: {context.hash}</small>{context.sections.map(section=><div key={section.name}>{section.name} · {section.bytes} · {section.hash}</div>)}</div>)}</details>}
 </section>
}

function GraphPane({sessionId,t,useTabInfo}:Props){
 const {tab}=useTabInfo(),[value,setValue]=useState<ExecutionGraphPayload>(),[error,setError]=useState(false),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0)
 const refresh=useCallback(()=>setRevision(x=>x+1),[])
 useEffect(()=>{
  if(!tab.visible)return
  const controller=new AbortController();let active=true
  setLoading(true);setError(false);setValue(undefined)
  void fetch(`/api/lyapunov/execution-graph?sessionId=${encodeURIComponent(sessionId)}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('GRAPH_READ_FAILED');return response.json() as Promise<ExecutionGraphPayload>}).then(next=>{if(active)setValue(next)}).catch(()=>{if(active)setError(true)}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false;controller.abort()}
 },[sessionId,tab.visible,revision])
 return <div><button disabled={loading} onClick={refresh}>{t('refresh')}</button>{loading?<p>{t('loading')}</p>:error?<p role='alert'>{t('error')}</p>:value?<ExecutionGraphView value={value} t={t}/>:null}</div>
}
/** @param ctx - 原生sidebarRight和locale owner。 */
export function applyExecutionGraphClient(ctx:Context){
 ctx.effect(()=>ctx.locale.register('lyapunovGraph',{zh,en}))
 const t=ctx.locale.bind('lyapunovGraph')
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:ID,kind:EXECUTION_GRAPH_KIND,priority:'builtin',title:()=>t('title')}))
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:ID,locale:'lyapunovGraph'},GraphPane)))
}
