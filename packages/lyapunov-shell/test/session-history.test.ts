/**
 * DEV-031 历史会话跨运行根发现／预检／显式恢复的单测。
 *
 * 夹具是**真实格式**的最小副本：`<dshHome>/sessions/<工作区slug>/session-<id>/session.v{2,3}.jsonl.zstd`
 * —— 注意是**拼接的多帧 zstd 容器**（首帧=header，后续帧=事件批次），与 Host 真正落盘的字节布局一致：
 * 单帧夹具曾让 `zstdDecompressSync` 看上去"能解压"，而真实日志只会解出 header，正文/标题/附件全读不到。
 * 附件块也是真实形状（`{type:"image",attachment:{attachmentId:"sha256:…",bytes,…}}`），
 * 并在 `<dshHome>/attachments/v1/objects/<前两位>/<digest>` 放真实字节。
 *
 * 断言重点：只读发现不改盘、归档只标注不删除、重复 ID 只标注不合并、分组与标题可追溯、
 * 恢复逐字节校验且不改写 cwd/不碰 storages、失败不留半截目标、恢复后能被产品自身持久化后端打开。
 */
import {afterEach, describe, expect, test} from "bun:test"
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from "node:fs"
import {createHash} from "node:crypto"
import {tmpdir} from "node:os"
import {basename,join} from "node:path"
import {zstdCompressSync} from "node:zlib"
import {Context} from "@deepseek-ai/cordis"
import {SessionId} from "@deepseek-ai/dsh-session"
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl"
import {generationLogPath} from "@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts"
import {currentDshHome,discoverSessions,precheckSession,restoreSession,historyRoots} from "../src/session-history.ts"
import {openExistingHistorySession,type ExistingHistoryEntry,type HistoryNavigationPort} from "../src/history-navigation.ts"

describe('当前运行根历史会话复用原生导航',()=>{
 const entry:ExistingHistoryEntry={id:'retained-history',cwd:'/qa/workspace',cwdExists:true,current:true,archived:false}
 function navigation(){
  const events:string[]=[],snapshot={phase:'ready',current:'current' as string|undefined,byId:{} as Record<string,{cwd?:string}>}
  const port:HistoryNavigationPort={snapshot:()=>snapshot,refresh:async()=>{events.push('native-refresh');snapshot.byId[entry.id]={cwd:entry.cwd}},open:id=>{events.push('native-open:'+id);snapshot.current=id}}
  return {events,snapshot,port}
 }
 test('先刷新Host目录再打开相同SID；不复制或创建记录，不修改cwd',async()=>{
  const n=navigation(),original=structuredClone(entry)
  expect(await openExistingHistorySession(entry,n.port)).toEqual({sessionId:entry.id,opened:true})
  expect(n.events).toEqual(['native-refresh','native-open:retained-history']);expect(n.snapshot.current).toBe(entry.id)
  expect(Object.keys(n.snapshot.byId)).toEqual([entry.id]);expect(entry).toEqual(original)
 })
 test('foreign、归档及失效cwd在任何原生请求前拒绝',async()=>{
  for(const [change,code] of [[{current:false},'HISTORY_FOREIGN_ROOT_COPY_REQUIRED'],[{archived:true},'HISTORY_SESSION_ARCHIVED'],[{cwdExists:false},'HISTORY_CWD_UNAVAILABLE']] as const){
   const n=navigation();await expect(openExistingHistorySession({...entry,...change},n.port)).rejects.toThrow(code);expect(n.events).toEqual([])
  }
 })
 test('文件可发现不代替Native目录权威；缺SID/错cwd/目录失败不伪造导航',async()=>{
  for(const [kind,code] of [['missing','HISTORY_SESSION_NOT_ADDRESSABLE'],['cwd','HISTORY_SESSION_CWD_MISMATCH'],['error','HISTORY_SESSION_DIRECTORY_UNAVAILABLE']] as const){
   const n=navigation();n.port.refresh=async()=>{n.events.push('native-refresh');if(kind==='cwd')n.snapshot.byId[entry.id]={cwd:'/another/workspace'};if(kind==='error')n.snapshot.phase='error'}
   await expect(openExistingHistorySession(entry,n.port)).rejects.toThrow(code);expect(n.events).toEqual(['native-refresh'])
  }
 })
 test('刷新迟到时新会话选择或原生navigation取消不写回旧目标',async()=>{
  const changed=navigation();changed.port.refresh=async()=>{changed.snapshot.current='new-selection';changed.snapshot.byId[entry.id]={cwd:entry.cwd}}
  await expect(openExistingHistorySession(entry,changed.port)).rejects.toThrow('HISTORY_NAVIGATION_SUPERSEDED');expect(changed.snapshot.current).toBe('new-selection');expect(changed.events).toEqual([])
  const cancelled=navigation(),controller=new AbortController();cancelled.port.refresh=async()=>{controller.abort();cancelled.snapshot.byId[entry.id]={cwd:entry.cwd}}
  await expect(openExistingHistorySession(entry,cancelled.port,controller.signal)).rejects.toThrow();expect(cancelled.events).toEqual([])
 })
})

const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function tempRoot(prefix:string):string{const root=mkdtempSync(join(tmpdir(),prefix));roots.push(root);return root}
const sha256=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex")
/** 递归列出目录下全部普通文件（只读指纹用）。 */
function walkFiles(dir:string):string[]{
  const out:string[]=[]
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name)
    if(entry.isDirectory())out.push(...walkFiles(path))
    else if(entry.isFile())out.push(path)
  }
  return out.sort()
}

interface AttachmentFixture {digest:string;bytes:number;name?:string;write?:boolean}
interface SessionFixture {
  id:string;cwd:string;slug?:string;user?:string;title?:string;archived?:boolean;version?:2|3
  isSeeded?:boolean;origin?:"subagent";parentSession?:string
  attachments?:AttachmentFixture[]
  /** 正文后面的额外事件帧（模拟真实长日志）。 */
  tailEvents?:number
  /** 额外造一个坏文件（悬空软链），用于恢复失败负对照。 */
  brokenExtra?:boolean
}
/** 造一个 dsh home：真实多帧 `session.v{2,3}.jsonl.zstd` + 归档列表 + 工作区分组 + 附件对象。 */
function dshHome(options:{sessions:SessionFixture[];workspaces?:Record<string,{path:string;title:string;sessionIds:string[]}>;home?:string}):string{
  const home=options.home??tempRoot("dev031-home-")
  mkdirSync(join(home,"sessions"),{recursive:true})
  const archived:string[]=[]
  for(const session of options.sessions){
    const version=session.version??3
    // 路径必须由产品自己的 `generationLogPath` 决定：Host 打开时会核对 header 的 id+cwd
    // 是否正好指向这条路径，夹具自己编 slug 会造出"产品打不开"的假夹具。
    const logFile=generationLogPath(join(home,"sessions"),session.cwd,session.id as any,version,"zstd")
    const dir=join(logFile,"..");mkdirSync(dir,{recursive:true})
    const frames:Buffer[]=[]
    // 帧边界与真实落盘一致：header 是独立帧，正文事件批次各成帧；seq 从 0 起连续
    // （Host 打开时会校验 seq 连续与首行 header，编造的 seq 会造出"产品打不开"的假夹具）。
    const events:any[]=[{type:"permission/preset",data:{preset:"workspace-write"}},{type:"sandbox/mode",data:{mode:"workspace-write"}},{type:"approval/policy",data:{policy:"ask"}},{type:"turn/start",data:{turn:1}},{type:"step/start",data:{turn:1,step:1}}]
    if(session.user!==undefined||session.attachments?.length){
      const content:any[]=[]
      if(session.user!==undefined)content.push({type:"text",text:session.user})
      for(const attachment of session.attachments??[]){
        content.push({type:"image",attachment:{attachmentId:`sha256:${attachment.digest}`,mediaType:"image/png",width:8,height:8,bytes:attachment.bytes,name:attachment.name??"capture.png"}})
        if(attachment.write!==false){
          const object=join(home,"attachments/v1/objects",attachment.digest.slice(0,2),attachment.digest)
          mkdirSync(join(object,".."),{recursive:true})
          writeFileSync(object,Buffer.alloc(attachment.bytes,7))
        }
      }
      events.push({type:"user/message",data:{content,source:{kind:"user"},role:"user",id:`${session.id}-m1`},surfaceOp:"append"})
    }
    const userSeq=events.findIndex(event=>event.type==="user/message")
    if(session.title!==undefined)events.push({type:"session/title",data:{title:session.title,messageSeqs:userSeq>=0?[userSeq]:[],source:{kind:"fallback"}}})
    // 每一步都要闭合：V2→V3 迁移会拒绝"turn/end 跨过未闭合的 step"。
    events.push({type:"step/end",data:{turn:1,step:1}})
    for(let index=0;index<(session.tailEvents??0);index++){
      events.push({type:"step/start",data:{turn:1,step:index+2}})
      events.push({type:"step/end",data:{turn:1,step:index+2}})
    }
    events.push({type:"turn/end",data:{turn:1,reason:{kind:"completed"}}})
    for(const [index,event] of events.entries())event.seq=index
    const body=events.map(event=>JSON.stringify({time:1_790_000_000_001+event.seq,...event}))
    // 正文至少拆两帧：夹具必须是**多帧**容器，否则单帧解码器也能"通过"，掩盖真实缺陷。
    const half=Math.max(1,Math.ceil(body.length/2))
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify({type:"session",version,id:session.id,createdAt:1_790_000_000_000,cwd:session.cwd,isSeeded:session.isSeeded??false,delegationDepth:0,agentPreset:"standard",...session.origin?{origin:session.origin}:{},...session.parentSession?{parentSession:session.parentSession}:{}})+"\n",'utf8')))
    frames.push(zstdCompressSync(Buffer.from(body.slice(0,half).join("\n")+"\n",'utf8')))
    if(body.length>half)frames.push(zstdCompressSync(Buffer.from(body.slice(half).join("\n")+"\n",'utf8')))
    writeFileSync(logFile,Buffer.concat(frames))
    writeFileSync(join(dir,"session.lock"),"")
    if(session.archived)archived.push(session.id)
  }
  mkdirSync(join(home,"storages"),{recursive:true})
  writeFileSync(join(home,"storages","workspace.json"),JSON.stringify({unit:{name:"workspace",version:2},global:{initialized:true,workspaceIds:[],archivedSessionIds:archived},tables:{workspaces:options.workspaces??{}}}))
  return home
}
/** 用**产品自身的持久化后端**打开一个会话（"打开"这一步的真实判据，不是"文件在不在"）。 */
async function openWithProduct(dshHome:string,id:string){  const ctx=new Context()
  const fiber=await ctx.plugin(JsonlSessionPersistence as any,{root:join(dshHome,"sessions"),compression:"zstd"} as any)
  try{
    const handle=await (ctx as any).sessionPersistence.open(SessionId(id),"read")
    try{const log=await handle.read();return {id,cwd:handle.header?.cwd??null,events:log.events.length,userMessages:log.events.filter((event:any)=>event.type==="user/message").length,types:[...new Set(log.events.map((event:any)=>event.type))] as string[]}}
    finally{await handle.close()}
  }finally{await fiber.dispose()}
}

describe("historyRoots：显示当前根并列出显式配置的其他根", () => {
  test("DSH_HOME 是当前根；LYAPUNOV_HISTORY_ROOTS 逐条解析（dsh home 或 sessions 目录）", () => {
    const current=dshHome({sessions:[]}),other=dshHome({sessions:[]})
    const roots=historyRoots({DSH_HOME:current,LYAPUNOV_HISTORY_ROOTS:`${other}:${join(other,"sessions")}`} as NodeJS.ProcessEnv)
    expect(currentDshHome({DSH_HOME:current} as NodeJS.ProcessEnv)).toBe(current)
    expect(roots.filter(root=>root.current).map(root=>root.sessionsDir)).toEqual([join(current,"sessions")])
    // 同一个根用两种写法配置只出现一次（sessions 目录写法会归一到同一个 dshHome）
    expect(roots.filter(root=>!root.current)).toHaveLength(1)
    expect(roots.find(root=>root.current)!.exists).toBe(true)
  })

  test("没有 DSH_HOME 时不伪造当前根", () => {
    expect(currentDshHome({} as NodeJS.ProcessEnv)).toBeUndefined()
    expect(historyRoots({} as NodeJS.ProcessEnv)).toEqual([])
  })

  test("多个同名 `…/developer/dsh` 运行根必须给出**可区分**的标签（否则列表里分不清来源）", () => {
    // 真实机器上的四个根尾两段全叫 `developer/dsh`：只取尾部一段就会全叫 "dsh"。
    const base=tempRoot("dev031-labels-")
    const a=join(base,"desktop","developer","dsh"),b=join(base,"dev-ui-check","developer","dsh")
    for(const home of [a,b])mkdirSync(join(home,"sessions"),{recursive:true})
    const roots=historyRoots({DSH_HOME:a,LYAPUNOV_HISTORY_ROOTS:b} as NodeJS.ProcessEnv)
    const labels=roots.map(root=>root.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels[1]).toBe("dev-ui-check/developer/dsh")
  })
})

describe("discoverSessions + precheckSession：只读发现与预检", () => {
  test("跨根发现：当前根与其他根都在列表里，cwd 失效与归档都如实标注", () => {
    // 失效 cwd 用**非**运行根/非 /tmp 的旧路径，避免被判成“验收夹具”（那是另一条规则）
    const missing="/home/s18/WS/Lyapunov/legacy-sessions/已经不存在的旧目录"
    const current=dshHome({sessions:[{id:"session-aaaa1111-0000-0000-0000-000000000001",cwd:missing,user:"第一条用户消息"}]})
    const other=dshHome({sessions:[{id:"session-bbbb2222-0000-0000-0000-000000000002",cwd:"/home/s18/WS/Lyapunov/Dev",archived:true}]})
    const {entries,roots}=discoverSessions({DSH_HOME:current,LYAPUNOV_HISTORY_ROOTS:other} as NodeJS.ProcessEnv)
    expect(roots).toHaveLength(2)
    expect(entries).toHaveLength(2)
    const stale=entries.find(entry=>entry.id.endsWith("0001"))!
    const archived=entries.find(entry=>entry.id.endsWith("0002"))!
    expect(stale.current).toBe(true);expect(stale.cwdExists).toBe(false)
    expect(stale.reason).toContain("cwd 已失效");expect(stale.reason).toContain("不改写 cwd")
    expect(archived.current).toBe(false);expect(archived.archived).toBe(true)
    expect(archived.reason).toContain("归档")
    // 预检：正文可读、首条用户消息与计数可追溯
    const pre=precheckSession(stale)
    expect(pre.readable).toBe(true)
    expect(pre.header.id).toBe(stale.id)
    expect(pre.firstUserText).toBe("第一条用户消息")
    expect(pre.entry.messages).toBe(1)
  })

  test("多帧日志（真实字节布局）：正文、原生标题与首条用户消息都读得到，不再只看得到 header", () => {
    // 真实日志 = 拼接多帧；单帧解码器只会解出 header（本用例在改前真实失败：messages=0、title 空）。
    const home=dshHome({sessions:[{
      id:"session-1111aaaa-0000-0000-0000-000000000011",cwd:"/home/s18/WS/Lyapunov/Dev",
      user:"第一条用户消息",title:"原生标题：抓取演示",tailEvents:40,
    }]})
    const entry=discoverSessions({DSH_HOME:home} as NodeJS.ProcessEnv).entries[0]!
    expect(entry.decodeError).toBeNull()
    expect(entry.frames).toBeGreaterThanOrEqual(2)  // 解开了 ≥2 帧：单帧解码器只会停在 header 帧
    expect(entry.truncated).toBe(true)              // 发现阶段按行数收敛，如实标注"只读了前缀"
    expect(entry.title).toBe("原生标题：抓取演示")
    const pre=precheckSession(entry)
    expect(pre.readable).toBe(true)
    expect(pre.userMessages).toBe(1)
    expect(pre.firstUserText).toBe("第一条用户消息")
    expect(pre.title).toBe("原生标题：抓取演示")
    expect(pre.titleSource).toBe("native")
    expect(pre.lines).toBeGreaterThanOrEqual(44)
  })

  test("附件按真实内容块统计并核对对象在场；缺对象时不假装在场", () => {
    const present="a".repeat(64),absent="b".repeat(64)
    const home=dshHome({sessions:[{
      id:"session-2222bbbb-0000-0000-0000-000000000022",cwd:"/home/s18/WS/Lyapunov/Dev",user:"看这张图",
      attachments:[{digest:present,bytes:128,name:"capture.png"},{digest:absent,bytes:64,name:"gone.png",write:false}],
    }]})
    const entry=discoverSessions({DSH_HOME:home} as NodeJS.ProcessEnv).entries[0]!
    const pre=precheckSession(entry)
    expect(pre.attachmentRefs).toHaveLength(2)
    expect(pre.attachmentsPresent).toBe(1)
    const ok=pre.attachmentRefs.find(ref=>ref.attachmentId===`sha256:${present}`)!
    const gone=pre.attachmentRefs.find(ref=>ref.attachmentId===`sha256:${absent}`)!
    expect(ok).toMatchObject({mediaType:"image/png",name:"capture.png",bytes:128,present:true})
    expect(gone.present).toBe(false)
    expect(pre.entry.attachments).toBe(2)
  })

  test("工作区分组可追溯：storages 里的 workspaces 只读标注，不在组里的如实留空", () => {
    const inGroup="session-3333cccc-0000-0000-0000-000000000033",loose="session-4444dddd-0000-0000-0000-000000000044"
    const home=dshHome({
      sessions:[{id:inGroup,cwd:"/home/s18/WS/LyapunovCheck"},{id:loose,cwd:"/home/s18/WS/Lyapunov/Dev"}],
      workspaces:{ws1:{path:"/home/s18/WS/LyapunovCheck",title:"LyapunovCheck",sessionIds:[inGroup]}},
    })
    const entries=discoverSessions({DSH_HOME:home} as NodeJS.ProcessEnv).entries
    expect(entries.find(entry=>entry.id===inGroup)).toMatchObject({group:"LyapunovCheck",groupPath:"/home/s18/WS/LyapunovCheck"})
    expect(entries.find(entry=>entry.id===loose)).toMatchObject({group:null,groupPath:null})
  })

  test("重复 ID 只标注不合并；运行根真人不会被目录名称误标夹具", () => {
    const id="session-cccc3333-0000-0000-0000-000000000003"
    const a=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/Dev"}]})
    const b=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/Dev/.runtime/fixture/x"}]})
    const {entries}=discoverSessions({DSH_HOME:a,LYAPUNOV_HISTORY_ROOTS:b} as NodeJS.ProcessEnv)
    expect(entries).toHaveLength(2)
    for(const entry of entries){expect(entry.duplicateOf).toHaveLength(1);expect(entry.reason).toContain("不自动合并")}
    expect(entries.every(entry=>entry.fixture===false)).toBe(true)
  })

  test("种子夹具、真实fork和子代理按原生来源区分，并保非session前缀的原生子代理",()=>{
    const home=dshHome({sessions:[
      {id:"session-seeded",cwd:"/tmp/.runtime/fixture",isSeeded:true},
      {id:"session-fork",cwd:"/tmp/.runtime/fixture",isSeeded:true,parentSession:"session-user"},
      {id:"child-native-id",cwd:"/tmp/.runtime/fixture",isSeeded:true,origin:"subagent",parentSession:"session-user"},
      {id:"session-user",cwd:"/tmp/.runtime/fixture",user:"用户任务"},
    ]})
    const {entries}=discoverSessions({DSH_HOME:home})
    expect(entries).toHaveLength(4)
    expect(entries.find(x=>x.id==="session-seeded")?.fixture).toBe(true)
    expect(entries.find(x=>x.id==="session-fork")).toMatchObject({fixture:false,parentSession:"session-user"})
    expect(entries.find(x=>x.id==="child-native-id")).toMatchObject({fixture:false,origin:"subagent",parentSession:"session-user"})
    expect(entries.find(x=>x.id==="session-user")?.fixture).toBe(false)
  })

  test("负对照：根不存在/没有日志 → 空列表，不抛错也不伪造条目", () => {
    const empty=dshHome({sessions:[]})
    const {entries,roots}=discoverSessions({DSH_HOME:empty,LYAPUNOV_HISTORY_ROOTS:"/definitely/not/here"} as NodeJS.ProcessEnv)
    expect(entries).toEqual([])
    expect(roots.find(root=>!root.current)!.exists).toBe(false)
  })

  test("负对照：坏日志（非 zstd 字节）逐条报 decodeError，发现不因此中断", () => {
    const home=dshHome({sessions:[{id:"session-5555eeee-0000-0000-0000-000000000055",cwd:"/home/s18/WS/Lyapunov/Dev"}]})
    const dir=join(home,"sessions","--home-s18-WS-Lyapunov-Dev--","session-5555eeee-0000-0000-0000-000000000055")
    writeFileSync(join(dir,"session.v3.jsonl.zstd"),Buffer.from("not a zstd frame at all"))
    const entries=discoverSessions({DSH_HOME:home} as NodeJS.ProcessEnv).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.decodeError).not.toBeNull()
    expect(entries[0]!.restorable).toBe(false)
    expect(entries[0]!.reason).toContain("日志解不开")
    const pre=precheckSession(entries[0]!)
    expect(pre.readable).toBe(false)
    expect(pre.titleSource).toBe("id")
  })
})

describe("restoreSession：显式恢复只复制，不合并不改写", () => {
  test("复制到当前根、原始记录与 storages 都不动、cwd 不改写，且恢复后可被产品后端打开", async () => {
    const staleCwd="/home/s18/WS/Lyapunov/legacy-sessions/旧的演示目录"
    const id="session-dddd4444-0000-0000-0000-000000000004"
    const source=dshHome({sessions:[{id,cwd:staleCwd,user:"历史正文",title:"旧标题"}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    const sourceLog=entry.logFile,sourceSha=sha256(sourceLog),storages=readFileSync(join(source,"storages","workspace.json"),"utf8")
    const result=restoreSession(entry,target)
    expect(result.status).toBe("restored")
    expect(result.files).toEqual(["session.v3.jsonl.zstd"])
    expect(existsSync(join(result.target,"session.v3.jsonl.zstd"))).toBe(true)
    expect(readFileSync(join(result.target,"session.v3.jsonl.zstd"))).toEqual(readFileSync(sourceLog))
    // 恢复回执自带来源与逐字节校验读数
    expect(result.sourceSha256).toBe(sourceSha)
    expect(result.targetSha256).toBe(sourceSha)
    expect(result.bytes).toBe(statSync(sourceLog).size)
    expect(result.sourceRoot).toBe(entry.root)
    // 原始记录仍在（逐字节未动）、storages 未改、header 的 cwd 原样保留（失效也不改写）
    expect(existsSync(sourceLog)).toBe(true)
    expect(sha256(sourceLog)).toBe(sourceSha)
    expect(readFileSync(join(source,"storages","workspace.json"),"utf8")).toBe(storages)
    const restored=discoverSessions({DSH_HOME:target} as NodeJS.ProcessEnv).entries[0]!
    expect(restored.cwd).toBe(staleCwd)
    expect(restored.cwdExists).toBe(false)
    expect(result.reason).toContain("原始记录未动")
    expect(result.reason).toContain("不改写 cwd")
    // 打开：产品自身持久化后端能读回该会话，cwd 仍是旧路径（没有被"修好"）
    const opened=await openWithProduct(target,id)
    expect(opened.cwd).toBe(staleCwd)
    expect(opened.events).toBeGreaterThan(0)
    expect(opened.types).toContain("user/message")
    // 发现→预检→恢复→打开 闭环：恢复后的记录出现在目标根的发现列表里
    expect(discoverSessions({DSH_HOME:target} as NodeJS.ProcessEnv).entries.map(item=>item.id)).toContain(id)
  })

  test("V2 日志兼容：预检读得到，恢复后产品后端仍能打开（正例）；坏帧文件是反例", async () => {
    const id="session-6666ffff-0000-0000-0000-000000000066"
    const source=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/LyapunovDSH",user:"V2 旧会话",title:"V2 标题",version:2}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    expect(entry.format).toBe("v2")
    const pre=precheckSession(entry)
    expect(pre.readable).toBe(true)
    expect(pre.firstUserText).toBe("V2 旧会话")
    expect(pre.title).toBe("V2 标题")
    expect(entry.cwdExists).toBe(false)
    const result=restoreSession(entry,target)
    expect(result.status).toBe("restored")
    expect(result.files).toEqual(["session.v2.jsonl.zstd"])
    const opened=await openWithProduct(target,id)
    expect(opened.cwd).toBe("/home/s18/WS/Lyapunov/LyapunovDSH")
    expect(opened.types).toContain("user/message")
  })

  test("目标已存在则 already-present：不覆盖、不重复复制；来源=当前根也不重复复制", () => {
    const source=dshHome({sessions:[{id:"session-eeee5555-0000-0000-0000-000000000005",cwd:"/home/s18/WS/Lyapunov/Dev"}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    expect(restoreSession(entry,target).status).toBe("restored")
    const again=restoreSession(entry,target)
    expect(again.status).toBe("already-present")
    expect(again.files).toEqual([])
    expect(again.reason).toContain("不覆盖")
    const inPlace=restoreSession(entry,source)
    expect(inPlace.status).toBe("already-present")
    expect(inPlace.reason).toContain("原件未动")
  })

  test("重复恢复稳定：第二次起不再改动目标，目标字节与来源始终一致", () => {
    const id="session-7777aaaa-0000-0000-0000-000000000077"
    const source=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/Dev",user:"重复恢复",attachments:[{digest:"c".repeat(64),bytes:32}]}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    const first=restoreSession(entry,target)
    const targetLog=join(first.target,"session.v3.jsonl.zstd")
    const afterFirst=sha256(targetLog)
    const second=restoreSession(entry,target)
    const third=restoreSession(entry,target)
    expect([second.status,third.status]).toEqual(["already-present","already-present"])
    expect(sha256(targetLog)).toBe(afterFirst)
    expect(afterFirst).toBe(sha256(entry.logFile))
    expect(readdirSync(join(target,"sessions",entry.workspaceSlug)).filter(name=>name.startsWith(".restoring-"))).toEqual([])
  })

  test("负对照：连附件一起搬，附件对象不在会话目录里也不由本模块伪造", () => {
    const id="session-8888bbbb-0000-0000-0000-000000000088"
    const source=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/Dev",user:"带图",attachments:[{digest:"d".repeat(64),bytes:16}]}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    const result=restoreSession(entry,target)
    expect(result.status).toBe("restored")
    // 只复制会话目录本身：附件对象仍留在来源根（恢复回执用 present 字段如实报在场性）
    expect(existsSync(join(target,"attachments/v1/objects",'d'.repeat(2),'d'.repeat(64)))).toBe(false)
    expect(precheckSession(entry).attachmentsPresent).toBe(1)
  })

  test("复制失败（来源里有坏文件）→ rejected，目标与暂存都不留半截日志", () => {
    const id="session-9999cccc-0000-0000-0000-000000000099"
    const source=dshHome({sessions:[{id,cwd:"/home/s18/WS/Lyapunov/Dev"}]})
    const target=dshHome({sessions:[]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    // 会话目录里塞一个指向不存在目标的软链：copyFileSync 会 ENOENT，逐字节校验路径被真实触发。
    symlinkSync(join(source,"does-not-exist.bin"),join(entry.sessionDir,"broken.bin"))
    const sourceSha=sha256(entry.logFile)
    const result=restoreSession(entry,target)
    expect(result.status).toBe("rejected")
    expect(result.target).toBe("")
    expect(result.reason).toContain("目标未改动")
    expect(existsSync(join(target,"sessions",entry.workspaceSlug,basename(entry.sessionDir)))).toBe(false)
    const slugDir=join(target,"sessions",entry.workspaceSlug)
    expect(!existsSync(slugDir)||readdirSync(slugDir).filter(name=>name.startsWith(".restoring-"))).toEqual([])
    expect(sha256(entry.logFile)).toBe(sourceSha)   // 来源仍逐字节未动
  })

  test("负对照：没有当前根 / 来源日志已不在场 → rejected，不猜位置", () => {
    const source=dshHome({sessions:[{id:"session-ffff6666-0000-0000-0000-000000000006",cwd:"/home/s18/WS/Lyapunov/Dev"}]})
    const entry=discoverSessions({DSH_HOME:source} as NodeJS.ProcessEnv).entries[0]!
    expect(restoreSession(entry,"").status).toBe("rejected")
    rmSync(entry.logFile)
    const missing=restoreSession(entry,source)
    expect(missing.status).toBe("rejected")
    expect(missing.reason).toContain("不伪造恢复")
  })
})

/**
 * 真实数据段：仅显式设置 LYAPUNOV_TEST_REAL_HISTORY=1 且传入四个已确认的历史根时运行；默认 CI 不访问用户历史。
 * 根只从 LYAPUNOV_HISTORY_ROOTS 读取，不在源码内写死任何用户/机器路径，也不自动从 HOME 发现根。
 * 覆盖：跨根发现（当前根 + 3 个其他根）、预检（原生标题/正文/附件在场性/失效 cwd）、
 * 显式恢复（只复制、原件逐字节未动、重复恢复稳定）、打开（产品自身持久化后端）。
 */
/** Default release profile: four temporary synthetic roots; never discover machine history. */
function syntheticHistoryProfile(){
  const homes=Array.from({length:4},()=>tempRoot("dev031-profile-"))
  const ids:string[]=[]
  for(const [rootIndex,home] of homes.entries()){
    const sessions:SessionFixture[]=[];const grouped:string[]=[]
    for(let index=0;index<27;index++){
      const id=`session-synthetic-${rootIndex}-${String(index).padStart(2,"0")}`
      ids.push(id);if(index<24)grouped.push(id)
      sessions.push({id,cwd:`/synthetic-history/cwd-${rootIndex}-${index}`,user:`synthetic-user-${rootIndex}-${index}`,title:rootIndex===2&&index<3?undefined:index<20?`synthetic-title-${rootIndex}-${index}`:undefined,archived:rootIndex===0&&index===0,version:rootIndex===1&&index===0?2:3,attachments:rootIndex===2&&index<3?[{digest:`${String(rootIndex)}${String(index)}`.repeat(32),bytes:8}]:[]})
    }
    const workspaces=grouped.length?{[`synthetic-workspace-${rootIndex}`]:{path:`/synthetic-history/workspace-${rootIndex}`,title:`synthetic-group-${rootIndex}`,sessionIds:grouped}}:undefined
    dshHome({sessions,workspaces,home})
  }
  return {homes,ids}
}

describe("合成 profile 附加边界", () => {
  test("合成四根 profile 保持聚合统计与 cwd 边界", () => {
    const profile=syntheticHistoryProfile();const env={DSH_HOME:profile.homes[0],LYAPUNOV_HISTORY_ROOTS:profile.homes.slice(1).join(":")} as NodeJS.ProcessEnv;const {roots:found,entries}=discoverSessions(env)
    expect(found).toHaveLength(4);expect(entries).toHaveLength(108);expect(entries.filter(entry=>entry.group!==null).length).toBeGreaterThan(90);expect(entries.filter(entry=>entry.title!=="").length).toBeGreaterThan(70);expect(entries.every(entry=>entry.cwd.startsWith("/synthetic-history/"))).toBe(true);expect(entries.some(entry=>entry.archived)).toBe(true);expect(entries.some(entry=>entry.format==="v2")).toBe(true)
  })
  test("合成 profile 附件和只读预检均来自临时根", () => {
    const profile=syntheticHistoryProfile();const env={DSH_HOME:profile.homes[0],LYAPUNOV_HISTORY_ROOTS:profile.homes.slice(1).join(":")} as NodeJS.ProcessEnv;const {entries}=discoverSessions(env);const checks=entries.filter(entry=>entry.dshHome===profile.homes[2]&&/session-synthetic-2-0[0-2]$/.test(entry.id)).map(entry=>precheckSession(entry))
    expect(checks.every(pre=>pre.readable&&pre.userMessages===1)).toBe(true);expect(checks.flatMap(pre=>pre.attachmentRefs).every(ref=>ref.present&&ref.bytes!==null&&ref.bytes>0)).toBe(true);expect(checks.length).toBe(3);expect(checks.some(pre=>pre.titleSource!=="native")).toBe(true);expect(profile.homes.every(home=>home.startsWith(tmpdir()))).toBe(true);expect(profile.ids).toHaveLength(108)
  })
  test("合成 profile 恢复闭环与重复恢复保持产品后端可打开", async () => {
    const profile=syntheticHistoryProfile();const env={DSH_HOME:profile.homes[0],LYAPUNOV_HISTORY_ROOTS:profile.homes.slice(1).join(":")} as NodeJS.ProcessEnv;const {entries}=discoverSessions(env);const entry=entries[0]!;const target=tempRoot("dev031-profile-target-");const before=sha256(entry.logFile);const first=restoreSession(entry,target);const second=restoreSession(entry,target);const opened=await openWithProduct(target,entry.id)
    expect(first.status).toBe("restored");expect(first.sourceSha256).toBe(before);expect(first.targetSha256).toBe(before);expect(second.status).toBe("already-present");expect(opened.events).toBeGreaterThan(0);expect(opened.cwd).toBe(entry.cwd);expect(sha256(entry.logFile)).toBe(before)
  })
  test("合成 profile 不枚举机器历史根并保留全量健康日志", () => {
    const profile=syntheticHistoryProfile();const env={DSH_HOME:profile.homes[0],LYAPUNOV_HISTORY_ROOTS:profile.homes.slice(1).join(":")} as NodeJS.ProcessEnv;const {entries}=discoverSessions(env)
    expect(entries.every(entry=>entry.decodeError===null)).toBe(true);expect(entries.every(entry=>entry.dshHome.startsWith(tmpdir()))).toBe(true);expect(entries.every(entry=>!entry.dshHome.includes("/home/s18"))).toBe(true);expect(entries.some(entry=>entry.truncated)).toBe(false);expect(entries.some(entry=>entry.archived)).toBe(true);expect(entries.some(entry=>entry.format==="v2")).toBe(true)
  })
})
