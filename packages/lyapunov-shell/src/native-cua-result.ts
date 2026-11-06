/** 原生 Cua Driver 把窗口编号／element_token 放在 MCP structuredContent；补进模型可见投影。 */
import type {PostToolDecision,ToolExecutionResult} from '@deepseek-ai/dsh-tools'
const observations=new Set(['list_windows','get_window_state','verify_state'])

/** macOS 驱动把应用菜单栏附在窗口树后；窗口观测只投影该窗口的后代，避免带入全局“最近项目”。 */
function windowObservation(value:Record<string,unknown>){
 const elements=value.elements
 if(!Array.isArray(elements)||elements[0]?.role!=='AXWindow')return value
 const indices=new Set([elements[0].element_index])
 const scoped=elements.filter((element,index)=>{
  if(index===0)return true
  if(!indices.has(element.parent_index))return false
  indices.add(element.element_index);return true
 })
 const {tree_markdown,...metadata}=value
 return {...metadata,elements:scoped}
}

export function projectNativeCuaObservation(name:string,result:Readonly<ToolExecutionResult>,decision:PostToolDecision):PostToolDecision{
 if(!name.startsWith('cua_driver_native__')||!observations.has(name.slice('cua_driver_native__'.length))||result.isError||decision.kind!=='accept'||decision.content!==undefined||decision.value!==undefined)return decision
 const value=result.value
 if(!value||typeof value!=='object'||Array.isArray(value)||!('structuredContent'in value)||value.structuredContent===undefined||value.structuredContent===null)return decision
 const scoped=name==='cua_driver_native__get_window_state'&&typeof value.structuredContent==='object'&&!Array.isArray(value.structuredContent)?windowObservation(value.structuredContent as Record<string,unknown>):value.structuredContent
 const content=scoped===value.structuredContent?result.content:result.content.map(block=>block.type==='text'?{...block,text:block.text.replace(/\n- \[\d+\] AXMenuBar\b[\s\S]*$/,'')}:block)
 return {kind:'accept',...(decision.additionalContexts?{additionalContexts:decision.additionalContexts}:{}),content:[...content,{type:'text',text:'原生窗口结构化观测（数据）：\n'+JSON.stringify(scoped)}]}
}
