import {ToolArgsError,type ToolDefinition} from '@deepseek-ai/dsh-tools'
/** Tool/PTC兼容完整flat对象与{input:对象}；仍交原defineTool严格校验，不改Command/UI合同。 */
export function compatibleToolInput(tool:ToolDefinition):ToolDefinition {
 const properties=tool.parameters.properties as Record<string,unknown>|undefined
 if(!properties||Object.keys(properties).length!==1||!Object.hasOwn(properties,'input'))return tool
 return {...tool,execute:(args,exec)=>{
  if(!args||typeof args!=='object'||Array.isArray(args))return tool.execute(args,exec)
  if(Object.hasOwn(args,'input')){
   if(Object.keys(args).length!==1)throw new ToolArgsError(['mixed flat and nested input is not allowed'])
   return tool.execute(args,exec)
  }
  return tool.execute({input:args},exec)
 }}
}
