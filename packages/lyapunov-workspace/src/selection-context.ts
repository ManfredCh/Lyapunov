import type {Context} from '@deepseek-ai/cordis'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 与公开 @file grammar 保持相同转义规则；浏览器包不引入 Host-only 模块。
export const nativeFileMention=(path:string)=>/[\u0000-\u001f\u007f-\u009f"]/u.test(path)?undefined:/\s/u.test(path)?`@"${path}"`:`@${path}`
export function selectedFileContext(path:string,text:string,start:number,end:number,unsaved:boolean){
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>text.length||end<=start)throw new Error('请先在文件编辑器中选择文本。')
 const mention=nativeFileMention(path);if(!mention)throw new Error('该文件路径无法用于原生上下文引用。')
 const startLine=text.slice(0,start).split('\n').length,endLine=text.slice(0,end-(text[end-1]==='\n'?1:0)).split('\n').length,selected=text.slice(start,end)
 const fences=selected.match(/`+/g)??[],fence='`'.repeat(Math.max(3,...fences.map(s=>s.length+1)))
 return {path,startLine,endLine,selected,unsaved,text:`\n${mention}\n${unsaved?'当前未保存编辑器选区':'文件选区'} L${startLine}–L${endLine}：\n${fence}\n${selected}\n${fence}\n`}
}
export function addSelectionToContext(ctx:Context,sessionId:string,selection:ReturnType<typeof selectedFileContext>){
 const sessions=ctx.get('sessions') as unknown as ISessions,actx=sessions.scope(sessionId as any),conversation=ctx.get('conversation')
 if(!actx||!conversation)throw new Error('当前会话的原生输入不可用。')
 const state=conversation.input.for(actx).state.getSnapshot()
 if(state.phase!=='plain')throw new Error('输入正在提交或处理命令；选区仍保留在编辑器。')
 // 使用公开的带draftRev文本插入事件；@路径沿用原生file-reference语法。
 const accepted=actx.bail('slash/input-insert-text',{text:selection.text,span:{start:state.draft.length,end:state.draft.length,draftRev:state.draftRev}})
 if(accepted!==true)throw new Error('会话草稿已变化，选区没有写入；请重试。')
}
