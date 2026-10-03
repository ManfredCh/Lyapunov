import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/cordis-plugin-loader"
import type {} from "@deepseek-ai/dsh-agent"
import type {} from "@deepseek-ai/dsh-commands"
import type {} from "@deepseek-ai/dsh-cmdline"
import type {SceneService} from "../../scene-kit/src/plugin.ts"
import {SessionId} from "@deepseek-ai/dsh-session"
import {readFile,writeFile} from "node:fs/promises"
import {join} from "node:path"
import {identityTransform} from "../../lyapunov-contracts/src/types.ts"
export const name="lyapunov-g15-unrelated-check"
export const inject=["agents","sessions","commands","scene"]
export function apply(ctx:Context,config:{evidence:string;output:string}){
  void(async()=>{
    await ctx.loader.await()
    const authored=JSON.parse(await readFile(join(config.evidence,"persistent-author.json"),"utf8"))
    const restarted=JSON.parse(await readFile(join(config.evidence,"persistent-restarted.json"),"utf8"))
    const call=restarted.events.find((e:any)=>e.type==="tool/call"&&e.data.name==="scene_create")
    const result=restarted.events.find((e:any)=>e.type==="tool/result"&&e.data.message.source.callId===call.data.callId)
    const sceneId=JSON.parse(result.data.message.content[0].content[0].text).sceneId
    // 场景归**创建它的那个会话**所有：一切读写都按该会话取那份 scene 存储（修前是 Host 级单例，
    // 两个会话读到的其实是同一份——那正是 P0 的串台根因）。这里不再问 Host 要一份"全局快照"。
    const scene=ctx.get("scene") as SceneService
    const owner=String(restarted.sessionId)
    const sceneOf=(id:string)=>scene.forSession(id)
    const before=await sceneOf(owner).scene.snapshot(sceneId),entityId="g15-unrelated-persistent-check"
    const sessions=[]
    for(const id of [authored.sessionId,restarted.sessionId]){
      const handle=await ctx.agents.resume({resumeSessionId:SessionId(id),agentOptions:{provider:"deepseek-official",model:"deepseek-v4-flash-vision-exp"}})
      try{
        await handle.agent.whenIdle()
        if(String(id)!==owner){
          // 另一个会话**看不到**这个场景：这是会话隔离的核心断言（旧语义要求它也编辑同一个场景，
          // 那正是"共享一份 Scene"的表现）。
          const foreign=await sceneOf(String(id)).list()
          if(foreign.some(item=>item.sceneId===sceneId))throw new Error(`会话隔离被破坏：会话 ${String(id)} 看到了不属于它的场景 ${sceneId}`)
          sessions.push({id,state:handle.agent.status,seesOwnedScene:false,ownSceneCount:foreign.length})
          continue
        }
        const current=await sceneOf(owner).scene.snapshot(sceneId)
        const input=current.entities.some(e=>e.entityId===entityId)?{sceneId}:{sceneId,expectedRevision:current.revision,patch:[{op:"add",entity:{entityId,name:"插件重启后的独立Scene检查",transform:identityTransform(),resources:[],components:{}}}]}
        const operation="patch" in input?"scene_edit":"scene_inspect"
        const receipt=await ctx.commands.execute(handle.agent,`/${operation} ${JSON.stringify(input)}`,[],new AbortController().signal)
        if(receipt?.result.kind!=="success")throw new Error("独立Scene操作失败："+receipt?.result.text)
        await ctx.sessions.flush(handle.agent.session)
        sessions.push({id,state:handle.agent.status,command:operation,commandId:receipt.commandId,seesOwnedScene:true})
      }finally{await handle.dispose()}
    }
    const after=await sceneOf(owner).scene.snapshot(sceneId)
    if(!after.entities.some(e=>e.entityId===entityId))throw new Error("Scene编辑未持久化")
    await writeFile(config.output,JSON.stringify({status:"PASS",sceneId,ownerSession:owner,beforeRevision:before.revision,afterRevision:after.revision,sessions,source:"同一已安装过滤bundle的新DSH进程；原生resume/Commands/Scene实际操作；场景按所属会话读写，非所属会话不可见（P0 会话隔离）",exitCode:0},null,2))
    ctx.get("appExit")?.(0)
  })().catch(e=>{console.error(e);ctx.get("appExit")?.(1)})
}
