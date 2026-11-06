/** 在原 browser-use 的会话／MCP owner 内运行 Viewer 门禁；不创建第二个浏览器执行器。 */
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm,{ToolCallId} from '@deepseek-ai/dsh-llm'
import Sessions,{SessionId} from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'

const input=JSON.parse(await readFile(process.argv[2]!,'utf8')) as {url:string;expression:string;executable:string}
const root=join(dirname(process.argv[2]!),'browser-owner'),product=resolve(import.meta.dirname,'../..')
const ctx=new Context();let owner:Awaited<ReturnType<typeof ctx.agents.create>>|undefined
try {
 const lock=JSON.parse(await readFile(join(product,'UPSTREAM_LOCK.json'),'utf8'))
 const provider=await import(pathToFileURL(join(product,lock.directory,'packages/experimental/browser-use-chrome-devtools-mcp/lib/index.js')).href)
 const modules=new Map<string,unknown>([['browserUse',BrowserUse],['prompt',SystemPrompt],['tools',Tools],['llm',Llm],['sessions',Sessions],['agents',Agents],['loop',AgentLoop],['projections',Projections],['browser',provider]])
 await mkdir(root,{recursive:true});const config=join(root,'cordis.yml')
 await writeFile(config,JSON.stringify([...modules.keys()].map(name=>({id:name,name,config:name==='loop'?{agents:[]}:name==='browser'?{mode:'launch',headless:true,executablePath:input.executable}:{}}))))
 ctx.baseUrl=pathToFileURL(root).href+'/'
 await ctx.plugin(Loader);ctx.loader.builtins.include=Include
 ctx.loader.internal={version:'v2',async import(name:string){if(!modules.has(name))throw Error('未知门禁模块');return modules.get(name)}} as unknown as NonNullable<typeof ctx.loader.internal>
 await ctx.loader.create({name:'cordis:include',config:{path:pathToFileURL(config).href}});await ctx.loader.await()
 owner=await ctx.agents.create({sessionId:SessionId('g19-viewer-browser'),meta:{cwd:root}});await owner.agent.whenIdle()
 await ctx.systemPrompt.assemble({agent:owner.agent,scope:owner.agent,signal:new AbortController().signal})
 const run=async(name:string,args:Record<string,unknown>)=>{
  const result=await ctx.tools.execute({agent:owner!.agent,name:'mcp__chrome-devtools-mcp__'+name,arguments:args,callId:ToolCallId('g19-'+name),signal:new AbortController().signal})
  if(result.isError)throw Error(JSON.stringify(result.content))
  const value=result.value as {content?:Array<{type:string;text?:string}>}
  return (value.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n')
 }
 const pages=await run('new_page',{url:input.url})
 const selected=/^([0-9]+):.*\[selected\]/m.exec(pages)
 if(!selected)throw Error('原 browser-use 未返回明确选中页编号')
 const response=await run('evaluate_script',{pageId:Number(selected[1]),function:'async () => await '+input.expression,waitForStableDom:false})
 const json=/```json\s*([\s\S]*?)```/.exec(response)
 if(!json)throw Error('原 evaluate_script 未返回可核对的 JSON')
 console.log('MCP_VIEWER_FACTS='+JSON.stringify(JSON.parse(json[1]!)))
}catch(error){console.log('MCP_VIEWER_FACTS='+JSON.stringify({error:String(error).replaceAll(input.url,'[local entry]')}));process.exitCode=1}
finally{await owner?.dispose();await ctx.fiber.dispose()}
