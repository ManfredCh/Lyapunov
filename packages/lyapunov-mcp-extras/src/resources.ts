import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {ContentBlock} from '@deepseek-ai/dsh-llm'
import type {JsonValue} from '@deepseek-ai/dsh-util-values'
const supported=new Set(['application/pdf','image/png','image/jpeg','image/gif','image/webp'])
/** 复用原生附件存储保留二进制资源；不把base64塞入模型文字。图片只在实际路由声明支持后直传。 */
export async function resourceAttachments(ctx:Context,result:JsonValue,signal:AbortSignal,agent?:Agent):Promise<JsonValue>{
 const value=result as any;if(!Array.isArray(value?.contents)||!value.contents.some((item:any)=>typeof item?.blob==='string'))return result
 const store=ctx.get('attachments');if(!store)throw new Error('MCP_ATTACHMENT_STORE_REQUIRED')
 const contents=[]
 for(const item of value.contents){
  if(typeof item?.blob!=='string'){contents.push(item);continue}
  const {blob,...rest}=item;const bytes=Buffer.from(blob,'base64');if(bytes.toString('base64')!==blob)throw new Error('MCP_RESOURCE_BASE64_INVALID')
  if(!supported.has(item.mimeType)||bytes.byteLength>10*1024*1024){contents.push({...rest,diagnostic:'二进制资源类型不受旧附件路径支持，或超过10MiB；未内联其内容。'});continue}
  signal.throwIfAborted();let name=String(item.uri??'mcp-resource').split('/').pop()||'mcp-resource';if(!name.includes('.'))name+='.'+(item.mimeType==='application/pdf'?'pdf':item.mimeType.split('/')[1])
  const attachment=await store.saveFile({data:bytes,name});let imageAttachment
  if(item.mimeType.startsWith('image/')&&agent){
   const route=agent.session.requestHeader()?.config;const provider=route?.provider??agent.options.provider,model=route?.model??agent.options.model,llm=ctx.get('llm')
   if(provider&&model&&llm){const info=await llm.resolveModelInfo(provider,model,signal);if(info.inputModalities?.includes('image'))imageAttachment=await store.saveImage({data:bytes,mediaType:item.mimeType,name})}
  }
  contents.push({...rest,attachment,...imageAttachment?{imageAttachment}:{}})
 }
 return {...value,contents} as JsonValue
}
export function renderResource(result:JsonValue):ContentBlock[]{
 const value=result as any;const blocks:ContentBlock[]=[{type:'text',text:JSON.stringify(result)}]
 for(const item of value?.contents??[]){if(item.imageAttachment)blocks.push({type:'image',attachment:item.imageAttachment});else if(item.attachment)blocks.push({type:'file',attachment:item.attachment})}
 return blocks
}
