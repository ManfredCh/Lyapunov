import {useEffect,useId,useState} from 'react'
import type {Translate} from './entity-editor.tsx'

// 支持邮箱只定义一次；详细区里的 mailto 走宿主 shell.openExternal 的精确 allowlist，不在这里发信。
const SUPPORT_EMAIL='voryneltech@gmail.com'
const SUPPORT_MAILTO=`mailto:${SUPPORT_EMAIL}`

/** 首行只作摘要；长列表、栈和宿主绝对路径留在显式详情中。 */
export function statusMessageSummary(message:string):string {
 const line=message.trim().replace(/^Error:\s*/,'').split(/\r?\n/,1)[0]??''
 const summary=line.replace(/(?:file:\/\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>，；;：]+/g,'…').replace(/\s+/g,' ').trim()
 return summary.length>120?summary.slice(0,117)+'…':summary
}

/** 展开的正文浮在 footer 上方，有界滚动，不扩张场景布局。 */
export function StatusDetails({details,tr,support=false}:{details:string;tr:Translate;support?:boolean}) {
 const [expanded,setExpanded]=useState(false),id=useId()
 useEffect(()=>setExpanded(false),[details])
 return <>
  <button type="button" className="lya-status-details-toggle" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?tr('收起详情','Hide details'):tr('查看详情','View details')}</button>
  {expanded&&<section id={id} className="lya-status-details" role="region" aria-label={tr('状态详情','Status details')}><pre>{details}</pre>{support&&<p className="lya-help">{tr('仍无法解决？请邮件联系 ','Still blocked? Email ')}<a href={SUPPORT_MAILTO} target="_blank" rel="noreferrer">{SUPPORT_EMAIL}</a>{tr('，并附上版本、最小步骤和已去隐私的截图。',' with the version, minimal steps and privacy-clean screenshots.')}</p>}<button type="button" onClick={()=>setExpanded(false)}>{tr('收起详情','Hide details')}</button></section>}
 </>
}

export function WorkbenchMessage({message,summary,kind='notice',tr,onDismiss}:{message:string;summary?:string;kind?:'error'|'warning'|'notice';tr:Translate;onDismiss?:()=>void}) {
 if(!message.trim())return null
 const text=statusMessageSummary(summary??message)||tr('操作未完成，请查看详情。','The operation did not complete. View details.')
 return <div className={`lya-status-message ${kind==='error'?'lya-error':kind==='warning'?'lya-warning':'lya-muted'}`} data-status-kind={kind}>
  <span className="lya-status-summary" role={kind==='error'?'alert':undefined}>{text}</span>
  {(kind!=='notice'||text!==message)&&<StatusDetails details={message} tr={tr} support={kind==='error'}/>}
  {onDismiss&&<button type="button" className="lya-status-dismiss" onClick={onDismiss} aria-label={tr('关闭提示','Dismiss message')}>{tr('关闭','Dismiss')}</button>}
 </div>
}
