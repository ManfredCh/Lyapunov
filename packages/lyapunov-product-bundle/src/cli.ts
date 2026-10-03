import type {Context} from "@deepseek-ai/cordis"
import {randomUUID} from "node:crypto"
import {writeFile} from "node:fs/promises"
import {createUserMessage} from "@deepseek-ai/dsh-llm"
import {SessionId,SessionSeq} from "@deepseek-ai/dsh-session"
import type {} from "@deepseek-ai/dsh-agent"
import type {} from "@deepseek-ai/dsh-agent-default-model"
import type {} from "@deepseek-ai/cordis-plugin-loader"
import type {} from "@deepseek-ai/dsh-cmdline"
import {GitHubClient,prepareGitHubWork,publishGitHubWork,type GitHubOptions} from './github.ts'
import {runGitHubCli} from './github-cli.ts'
import {runFastGSCli} from './fastgs-cli.ts'
import {fileURLToPath} from 'node:url'
import {realpath} from 'node:fs/promises'

export const name="lyapunov-cli"
export const inject=["agents","sessions","agentDefaultModel"]
export interface Config {prompt?:string;resumeSessionId?:string;resultFile?:string;cancelAfterMs?:number;cwd?:string;provider?:string;model?:string;github?:GitHubOptions}
/** CLI 只驱动 DSH 原生 Agent；恢复使用 resume，不向 SDK create 重复提交旧 ID。 */
export function apply(ctx:Context,config:Config){
  void (async()=>{
    await ctx.get("loader")?.await()
    const route=ctx.agentDefaultModel.currentSelection()
    const options={provider:config.provider??route.provider,model:config.model??route.model}
    const github=config.github?new GitHubClient(config.github):undefined
    let handle:Awaited<ReturnType<typeof ctx.agents.create>>|undefined
    let exitCode=1
    try{
    const context=github?await github.context(AbortSignal.timeout(30000)):undefined
    const prompt=context?.prompt??config.prompt;if(!prompt)throw new Error('CLI_PROMPT_REQUIRED')
    handle=config.resumeSessionId?await ctx.agents.resume({resumeSessionId:SessionId(config.resumeSessionId),agentOptions:options}):await ctx.agents.create({sessionId:SessionId("lyapunov-"+randomUUID()),meta:{cwd:config.cwd??process.cwd()},agentOptions:options})
    const agent=handle.agent
    await agent.whenIdle()
    if(github&&await realpath(agent.session.header.cwd??'')!==await realpath(config.cwd??process.cwd()))throw new Error('GITHUB_RESUME_WORKSPACE_MISMATCH')
    const work=github&&context?await prepareGitHubWork(ctx,agent,github,context,AbortSignal.timeout(30000)):undefined
    const attachments=github&&context?await github.promptAttachments(ctx,context,options,AbortSignal.timeout(30000)):[]
    const before=agent.session.seq
    agent.followup(createUserMessage({content:[{type:"text",text:prompt},...attachments],source:{kind:"user"}}))
    const timer=config.cancelAfterMs?setTimeout(()=>agent.cancel({kind:"user"}),config.cancelAfterMs):undefined
    try{await agent.whenIdle()}finally{clearTimeout(timer)}
    await ctx.sessions.flush(agent.session)
    const events=[]
    for(let i=before;i<agent.session.seq;i++)events.push(agent.session.eventAt(SessionSeq(i)))
    const messages=events.filter(e=>e?.type==="assistant/message")
    const final=messages.at(-1)
    const text=final?.type==="assistant/message"?final.data.message.content.filter(b=>b.type==="text").map(b=>b.text).join(""):""
    const last=events.findLast(e=>e?.type==="turn/end")
    const result={sessionId:agent.session.id,resumed:Boolean(config.resumeSessionId),finalResponse:text,events,reason:last?.type==="turn/end"?last.data.reason:undefined,finalAgentStatus:agent.status,cancelRequested:Boolean(config.cancelAfterMs)}
    let publication
    if(github&&context&&work){
      if(result.reason?.kind!=='completed'&&work.publication!=='none')throw new Error('GITHUB_AGENT_NOT_COMPLETED: 未结束的任务不会发布')
      publication=await publishGitHubWork(ctx,agent,github,context,work,text,AbortSignal.timeout(120000))
      Object.assign(result,{github:{repository:config.github!.repository,event:context.eventName,apiUrl:github.apiUrl,...publication}})
    }
    if(config.resultFile)await writeFile(config.resultFile,JSON.stringify(result,null,2))
    process.stdout.write(JSON.stringify({sessionId:result.sessionId,resumed:result.resumed,finalResponse:text,reason:result.reason,...publication?{github:publication}:{}})+"\n")
    exitCode=result.reason?.kind==="error"?1:0
    }finally{try{await handle?.dispose()}finally{await github?.dispose()}}
    ctx.get("appExit")?.(exitCode)
  })().catch(e=>{console.error(e instanceof Error?e.message:String(e));ctx.get("appExit")?.(1)})
}

if(import.meta.main){
  const command=process.argv[2]
  if(command==='github')await runGitHubCli(process.argv.slice(3),fileURLToPath(import.meta.url)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})
  else if(command==='fastgs')await runFastGSCli(process.argv.slice(3)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})
  else {console.error('用法：node cli.js github install|inspect|run [参数] | fastgs download|install|doctor|train [参数]');process.exitCode=2}
}
