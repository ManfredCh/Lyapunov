import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {createHash,randomUUID} from 'node:crypto'
import type {GenerationProduct,GenerationQuote} from './generation.ts'
import {generationPublicName} from './generation.ts'
export interface GenerationApproval {product:GenerationProduct;requestId:string;mode:'formal'|'developer';accountId:string;apiUrl:string;request:unknown;quote?:GenerationQuote}
export type GenerationAuthorizer=(request:GenerationApproval,signal?:AbortSignal)=>Promise<void>
function canonical(value:any):any {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&typeof v!=='function').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value}
/**
 * 请求参数说明。`actualModel` 是服务端实际生效的模型（来自报价）：有这个值时只显示它，
 * 请求体里的 model 可能被服务端覆盖，绝不能当成实际模型展示。
 */
function requestDescription(value:any,actualModel?:string,formalProduct?:GenerationProduct):string {
 const rows:string[]=[],prompt=value?.prompt??value?.Prompt??value?.input?.prompt
 if(typeof prompt==='string'&&prompt.trim())rows.push('生成内容：\n'+prompt.split('\n').map(line=>'> '+line).join('\n'))
 const modelField:[string,unknown]=formalProduct?['生成服务',generationPublicName(formalProduct)]:actualModel?['模型（服务端固定）',actualModel]:['模型',value?.model??value?.Model]
 const fields:Array<[string,unknown]>=[['名称',value?.title],modelField,['质量',value?.quality??value?.Quality??value?.parameters?.texture_quality],['生成类型',value?.GenerateType??value?.mode??value?.input?.mode],['面数',value?.FaceCount],['材质',typeof (value?.EnablePBR??value?.parameters?.pbr)==='boolean'?((value.EnablePBR??value.parameters.pbr)?'PBR':'普通'):undefined],['纹理',typeof value?.parameters?.texture==='boolean'?(value.parameters.texture?'生成纹理':'不生成纹理'):undefined],['多边形类型',value?.PolygonType],['输出格式',value?.ResultFormat],['目标空间',value?.workspaceId]]
 for(const [label,item] of fields)if(item!==undefined&&item!==null)rows.push(`${label}：${String(item)}`)
 const images=[value?.referenceImageUris,value?.ReferenceImageUris,value?.ImageUrls].find(Array.isArray) as unknown[]|undefined
 const encoded=Array.isArray(value?.ImagesBase64)?value.ImagesBase64.length:value?.ImageBase64?1:0
 const imageCount=images?.length??(value?.ImageUrl?1:encoded)
 if(imageCount)rows.push(`参考图像：${imageCount} 张（可在本次工具调用详情中核对输入）`)
 rows.push('完整参数保留在本次工具调用详情中。')
 return rows.join('\n\n')
}
const pendingByHost=new WeakMap<object,Map<string,{fingerprint:string;promise:Promise<void>}>>()
/** 原生一次授权，绑定实际请求及报价；原生grant只在用户明确回答后写入。 */
export function generationAuthorizer(ctx:Context,agent:Agent|undefined,allowPrompt=true):GenerationAuthorizer {
 return async(input,signal)=>{
  signal?.throwIfAborted()
  if(input.mode==='formal'&&!input.quote)throw new Error('CENTRAL_GENERATION_QUOTE_UNAVAILABLE')
  const credentials=ctx.get('credentials'),questions=ctx.get('userQuestions')
  if(!credentials)throw new Error('GENERATION_GRANT_STORE_UNAVAILABLE')
  const identity={product:input.product,requestId:input.requestId,mode:input.mode,accountId:input.accountId,apiUrl:input.apiUrl},key=credentialKey('lyapunov-generation','request-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex'))
  const fingerprint=createHash('sha256').update(JSON.stringify(canonical({...identity,request:input.request,quote:input.quote??{pricing:'unknown'}}))).digest('hex')
  const prior=await credentials.readRecord(key)
  if(prior?.kind==='grant'&&(prior.payload as any)?.fingerprint===fingerprint&&(prior.payload as any)?.decision==='submit')return
  if(!allowPrompt)throw new Error('GENERATION_CONFIRMATION_CHANGED: 报价或请求已变更，请重新在前台确认，后台未提交')
  if(!agent||!questions)throw new Error('GENERATION_USER_QUESTIONS_UNAVAILABLE: 需要原生用户问题交互，尚未提交')
  let pending=pendingByHost.get(ctx.root)
  if(!pending){pending=new Map();pendingByHost.set(ctx.root,pending)}
  const active=pending.get(key)
  if(active){if(active.fingerprint!==fingerprint)throw new Error('GENERATION_REQUEST_ID_CONFLICT: 同一requestId已有不同请求等待确认');await active.promise;signal?.throwIfAborted();return}
  const task=(async()=>{
  // 弹窗标题与问句按产品给：3D 三件套沿用原文案；图像请求不能显示"生成 3D"（出的是图不是 3D 资产）。
  const names={marble:'World Labs Marble',hunyuan:'混元 3D',tripo:'Tripo 3D（阿里云百炼）',image:'图像生成'},titles={marble:'生成 3D',hunyuan:'生成 3D',tripo:'生成 3D',image:'生成图像'},id='generate-'+randomUUID()
  // 计费口径与报价一致：按请求固定积分，不随本次返回的图片/资产数量变化。
  const cost=input.quote?`中央服务报价：**${input.quote.points} 点/次**（按请求固定计费，与本次返回的图片或资产数量无关）。提交后按现有流程预留，成功按该固定报价结算。`:'**无法精确报价**：当前直连供应商没有本应用可用的报价接口；本次可能产生供应商费用，金额以供应商账单为准。'
  const destination=input.mode==='developer'?`\n\n供应商入口：${new URL(input.apiUrl).origin}`:''
  const publicName=input.mode==='formal'?generationPublicName(input.product):names[input.product]
  const question=input.mode==='developer'&&input.product==='image'?'提交这次图像生成请求？':`提交这次 ${publicName} 生成请求？`
  const answer=await questions.ask({agent,signal,questions:[{id,header:input.mode==='formal'?publicName:titles[input.product],question,detail:`${cost}\n\n${requestDescription(input.request,input.quote?.model,input.mode==='formal'?input.product:undefined)}${destination}`,options:[{label:'提交生成',description:input.quote?`确认本次 ${input.quote.points} 点/次报价。`:'确认费用暂无法精确报价，仍提交本次请求。'},{label:'取消',description:'不提交、不预留点数。'}],multiSelect:false}]})
  signal?.throwIfAborted()
  if(answer.answers.length!==1||answer.answers[0]?.id!==id||answer.answers[0].selected.length!==1||answer.answers[0].selected[0]!=='提交生成'||answer.answers[0].custom?.trim())throw new Error('GENERATION_CANCELLED_BY_USER: 用户取消了本次生成；不要重试，等待新请求')
  await credentials.modifyRecord(key,async()=>({kind:'grant',payload:{version:1,...identity,fingerprint,decision:'submit',questionId:id,quoteId:input.quote?.quoteId??null,points:input.quote?.points??null,quotedModel:input.quote?.model??null,confirmedAt:new Date().toISOString()}}))
  })()
  pending.set(key,{fingerprint,promise:task})
  try{await task}finally{if(pending.get(key)?.promise===task)pending.delete(key)}
 }
}
