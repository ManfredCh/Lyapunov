import type {Agent} from '@deepseek-ai/dsh-agent'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {randomUUID} from 'node:crypto'
export interface ConfirmationSubject {previewId:string;digest:string;owner:string;serviceUrl:string;title:string}
export interface ConfirmationRef {key:string}
const keyOf=(subject:ConfirmationSubject)=>credentialKey('lyapunov-share','preview-'+subject.previewId)
/** 授权使用原生credentials GrantRecord；模型传入的布尔值或本地preview元数据不能创建grant。 */
export async function hasConfirmation(ctx:Context,subject:ConfirmationSubject,_ref:ConfirmationRef|undefined,signal:AbortSignal){
 signal.throwIfAborted()
 const credentials=ctx.get('credentials');if(!credentials)return false
 const record=await credentials.readRecord(keyOf(subject))
 if(record?.kind!=='grant'||!record.payload||typeof record.payload!=='object')return false
 const grant=record.payload as Record<string,unknown>
 return grant.version===1&&grant.decision==='publish'&&typeof grant.questionId==='string'&&Object.entries(subject).every(([key,value])=>grant[key]===value)
}
export async function requestConfirmation(ctx:Context,agent:Agent|undefined,subject:ConfirmationSubject,previewLink:string,counts:{sessions:number;events:number;attachments:number},signal:AbortSignal):Promise<ConfirmationRef|undefined>{
 if(!agent)throw new Error('SHARE_LIVE_USER_SESSION_REQUIRED')
 const questions=ctx.get('userQuestions'),credentials=ctx.get('credentials')
 if(!questions)throw new Error('SHARE_USER_QUESTIONS_UNAVAILABLE: 请在支持原生用户问题交互的会话中发布；私有预览仍可查看')
 if(!credentials)throw new Error('SHARE_GRANT_STORE_UNAVAILABLE: 原生授权记录存储不可用，不能发布')
 const questionId='share-'+subject.previewId+'-'+randomUUID()
 const answer=await questions.ask({agent,signal,questions:[{id:questionId,header:'分享会话',question:'发布这份会话快照？',detail:`[查看完整私有预览](<${previewLink}>)\n\n${subject.title}\n\n${counts.sessions} 个会话 · ${counts.events} 条事件 · ${counts.attachments} 个附件。包含预览中展示的原始事件、工具输入输出和附件。\n\n发布到：${subject.serviceUrl}`,options:[{label:'发布',description:'发布当前预览的固定快照，之后可撤销链接。'},{label:'取消',description:'保留私有预览，不发布。'}],multiSelect:false}]})
 signal.throwIfAborted()
 const accepted=answer.answers.length===1&&answer.answers[0]?.id===questionId&&answer.answers[0]?.selected.length===1&&answer.answers[0]?.selected[0]==='发布'&&!answer.answers[0]?.custom?.trim()
 if(!accepted)return undefined
 const key=keyOf(subject)
 await credentials.modifyRecord(key,async()=>({kind:'grant',payload:{version:1,...subject,questionId,decision:'publish',sessionId:agent.id,answeredAt:new Date().toISOString()}}))
 return {key}
}
