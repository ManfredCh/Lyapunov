import {existsSync,readdirSync,readFileSync,statSync,mkdirSync,renameSync,rmSync,copyFileSync} from "node:fs"
import {createHash} from "node:crypto"
import {join,basename,dirname} from "node:path"
import {zstdDecompressSync} from "node:zlib"

/**
 * DEV-031 历史会话的**跨运行根发现 + 预检 + 显式恢复**（只读优先，绝不自动合并、绝不改写 cwd）。
 *
 * 当前运行根由 Host 自己给出：`script/profile.ts:74` 把 `DSH_HOME=<runtimeRoot>/<mode>/dsh` 写进 Host 环境，
 * 原生 SessionStore 与界面列表都只认这一个根（`plugin.ts:53` 注入 `sessions`，`:1505` 用 `sessionQuery`
 * 读当前会话）——所以“其他根里仍有原始记录但界面看不到”不是数据丢失，而是缺少发现入口。
 *
 * 本模块只做四件事：
 *  1. `historyRoots()`：显示当前根，并列出**显式配置**的其他根（`LYAPUNOV_HISTORY_ROOTS`，冒号分隔）；
 *  2. `discoverSessions()`：逐根枚举 `sessions/<工作区slug>/session-<id>/session.v{2,3}.jsonl.zstd`，
 *     带上原生归档标记与 `storages/workspace.json` 里的工作区分组（只读，不写 storages）；
 *  3. `precheckSession()`：解出 header、原生标题、首条用户消息、附件引用与存在性，判定 cwd 是否失效、
 *     是否归档、是否重复副本／夹具——**只读**，不复制、不改写；
 *  4. `restoreSession()`：把选定的会话目录**复制**进当前根（目标已存在则跳过并说明），
 *     复制前后逐字节校验，失败不留半截目标；原始记录保持不动，`cwd` 原样保留（失效就如实标记），
 *     storages 一律不碰。
 *
 * **多帧解码**：原生日志是**拼接的 zstd 帧**容器（每次 append+flush 一帧），`zlib.zstdDecompressSync`
 * 只会解出第一帧（=只有 header），于是"正文/标题/附件"在真实日志上全部读不到。本模块按同一容器格式
 * 逐帧解码（见 `scanZstdFrames` 的注释：为什么不用上游的源码子路径 helper），并按帧数／字节／行数设上限，
 * 避免把大日志整体载入内存；写到一半的尾帧如实报 `torn`。真实数据段会用产品自身的持久化后端交叉核对
 * 同一份日志的正文条数，防止两套解析口径漂移。
 */
export interface HistoryRoot { dshHome:string; sessionsDir:string; label:string; current:boolean; exists:boolean }
export interface AttachmentRef { attachmentId:string; mediaType:string; name:string; bytes:number|null; present:boolean }
export interface HistoryEntry {
  id:string; title:string; cwd:string; cwdExists:boolean; createdAt:number|null
  format:"v2"|"v3"|"unknown"; messages:number; attachments:number
  root:string; dshHome:string; sessionsDir:string; workspaceSlug:string; sessionDir:string; logFile:string; logBytes:number
  current:boolean; archived:boolean; fixture:boolean
  /** 原生来源；目录地址不参与夹具判定。子代理和真实fork保留各自追溯。 */
  seeded:boolean; origin:string|null; parentSession:string|null
  /** `storages/workspace.json` 里的工作区分组（只读标注；不写回）。 */
  group:string|null; groupPath:string|null
  /** 日志结构：完整帧数、是否有写到一半的尾帧、是否在限额内停止读取。 */
  frames:number; torn:boolean; truncated:boolean; decodeError:string|null
  duplicateOf:string[]; restorable:boolean; reason:string
}
export interface Precheck {
  entry:HistoryEntry; header:Record<string,unknown>; firstUserText:string|null; lines:number; readable:boolean
  /** 原生 `session/title`（无则回退首条用户文本，再回退 id）与来源。 */
  title:string; titleSource:"native"|"first-user"|"id"
  userMessages:number; scannedBytes:number; truncated:boolean; torn:boolean
  /** 附件引用（image/file 内容块）与在**该来源根**的附件库里的存在性。 */
  attachmentRefs:AttachmentRef[]; attachmentsPresent:number
}
export interface RestoreResult {
  status:"restored"|"already-present"|"rejected"; target:string; files:string[]; reason:string
  sourceLogFile:string; sourceRoot:string; sourceGroup:string|null; sourceSha256:string|null; targetSha256:string|null; bytes:number
}

/** 当前根的 dsh home（Host 环境里的 `DSH_HOME`）；不在 Host 环境里时返回 undefined。 */
export function currentDshHome(env:NodeJS.ProcessEnv=process.env):string|undefined{
  const value=(env.DSH_HOME??"").trim()
  return value===""?undefined:value
}

/**
 * 每个根给一个**可区分**的短标签：只取尾部一段的话，四个真实运行根会全叫 `dsh`，
 * 列表里就分不清记录来自哪个根。这里从 1 段开始逐级加长，直到所有标签互不相同。
 */
function uniqueLabels(homes:string[]):Map<string,string>{
  const labels=new Map<string,string>()
  const partsOf=(home:string)=>home.split(/[\\/]/).filter(Boolean)
  for(let depth=1;depth<=8;depth++){
    labels.clear()
    for(const home of homes)labels.set(home,partsOf(home).slice(-depth).join("/"))
    if(new Set(labels.values()).size===homes.length)break
  }
  return labels
}

/** 解析显式配置的其他根：每个条目可以是 dsh home（下面有 `sessions/`）或直接是 sessions 目录。 */
export function historyRoots(env:NodeJS.ProcessEnv=process.env):HistoryRoot[]{
  const declared:{dshHome:string;sessionsDir:string;current:boolean}[]=[]
  const current=currentDshHome(env)
  if(current)declared.push({dshHome:current,sessionsDir:join(current,"sessions"),current:true})
  for(const raw of (env.LYAPUNOV_HISTORY_ROOTS??"").split(":").map(value=>value.trim()).filter(Boolean)){
    if(declared.some(root=>root.dshHome===raw||root.sessionsDir===raw))continue
    // 配置项可以是 dsh home（下面有/将会有 sessions/），也可以直接是 sessions 目录（basename 判定，
    // 不靠“现在存不存在”猜——一个还没建 sessions/ 的 dsh home 不应被当成 sessions 目录）。
    const isSessionsDir=basename(raw)==="sessions"
    declared.push({dshHome:isSessionsDir?dirname(raw):raw,sessionsDir:isSessionsDir?raw:join(raw,"sessions"),current:false})
  }
  const labels=uniqueLabels(declared.map(root=>root.dshHome))
  return declared.map(root=>({...root,label:root.current?"当前运行根":labels.get(root.dshHome)!,exists:existsSync(root.sessionsDir)}))
}

/**
 * 扫描拼接 zstd 容器的**帧边界**（RFC 8878 帧结构：magic + frame header + block 序列 [+ checksum]）。
 *
 * 为什么自己扫而不用上游 `@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts` 的
 * `scanZstdFrames`/`createZstdFrameDecoder`：那是**源码子路径**导入，`bun build` 会把它留成
 * 运行时 `import … from "…/src/zstd.ts"`（该包的构建产物 `lib/index.js` 只导出插件本体，不导出这些
 * helper），而 Node 拒绝为 `node_modules` 下的 `.ts` 做类型剥离——开发树里因为软链而侥幸能跑，
 * 发行包里就会在加载插件时炸。这里只依赖 `node:zlib` 的公开 API，并与上游同一套格式口径。
 * 只用完整帧；尾帧不完整（Host 正在写）时返回它的起点，由调用方如实标注。
 */
function scanZstdFrames(buffer:Buffer,maxFrames:number):{ranges:{start:number;end:number}[];tornStart?:number}{
  const ranges:{start:number;end:number}[]=[];let offset=0
  while(offset<buffer.length){
    const start=offset
    if(buffer.length-offset<4)return {ranges,tornStart:start}
    if(buffer.readUInt32LE(offset)!==0xfd2fb528)throw new Error(`invalid frame magic at byte ${offset}`)
    offset+=4
    if(offset===buffer.length)return {ranges,tornStart:start}
    const descriptor=buffer.readUInt8(offset);offset+=1
    if((descriptor&0x18)!==0)throw new Error(`reserved frame-header bit at byte ${offset-1}`)
    const contentSizeFlag=descriptor>>>6,singleSegment=(descriptor&0x20)!==0,checksum=(descriptor&0x04)!==0
    const dictionaryFlag=descriptor&0x03,dictionaryBytes=dictionaryFlag===3?4:dictionaryFlag
    const contentSizeBytes=contentSizeFlag===0?(singleSegment?1:0):1<<contentSizeFlag
    const remainingHeaderBytes=(singleSegment?0:1)+dictionaryBytes+contentSizeBytes
    if(buffer.length-offset<remainingHeaderBytes)return {ranges,tornStart:start}
    offset+=remainingHeaderBytes
    for(;;){
      if(buffer.length-offset<3)return {ranges,tornStart:start}
      const blockHeader=buffer.readUIntLE(offset,3);offset+=3
      const lastBlock=(blockHeader&1)!==0,blockType=(blockHeader>>>1)&0x03,blockSize=blockHeader>>>3
      if(blockType===0x03)throw new Error(`reserved block type at byte ${offset-3}`)
      const payloadBytes=blockType===0x01?1:blockSize
      if(buffer.length-offset<payloadBytes)return {ranges,tornStart:start}
      offset+=payloadBytes
      if(lastBlock)break
    }
    if(checksum){if(buffer.length-offset<4)return {ranges,tornStart:start};offset+=4}
    ranges.push({start,end:offset})
    if(ranges.length===maxFrames)return {ranges}
  }
  return {ranges}
}

/** 分帧解码窗口：帧数／明文字节／行数三重上限，任一到达即停止（不整份载入内存）。 */
interface LogWindow {lines:string[];frames:number;torn:boolean;truncated:boolean;bytes:number;error:string|null}
function readLogWindow(file:string,limits:{maxFrames:number;maxBytes:number;maxLines:number}):LogWindow{
  const empty:LogWindow={lines:[],frames:0,torn:false,truncated:false,bytes:0,error:null}
  let raw:Buffer
  try{raw=readFileSync(file)}catch(error){return {...empty,error:String((error as Error).message??error)}}
  // 明文 `.jsonl`（非压缩）按原样读；只有 `.zstd`/`.zst` 才走分帧解码。
  if(!/\.(zstd|zst)$/i.test(file))return {...empty,lines:raw.toString("utf8").split("\n"),bytes:raw.length}
  let scan:{ranges:{start:number;end:number}[];tornStart?:number}
  try{scan=scanZstdFrames(raw,limits.maxFrames)}catch(error){return {...empty,error:`ZSTD_FRAME_SCAN: ${String((error as Error).message??error)}`}}
  const parts:Buffer[]=[];let bytes=0,newlines=0,stopped=false
  for(const range of scan.ranges){
    let chunk:Buffer
    try{chunk=zstdDecompressSync(raw.subarray(range.start,range.end))}catch(error){return {...empty,error:`ZSTD_FRAME_DECODE: ${String((error as Error).message??error)}`}}
    parts.push(chunk);bytes+=chunk.length
    for(const byte of chunk)if(byte===0x0a)newlines++
    if(bytes>=limits.maxBytes||newlines>=limits.maxLines){stopped=true;break}
  }
  // torn=尾帧写到一半（Host 可能仍在写）；truncated=还有完整帧没读（限额或 maxFrames 截断）。
  return {lines:Buffer.concat(parts).toString("utf8").split("\n"),frames:parts.length,torn:scan.tornStart!==undefined,
    truncated:stopped||scan.ranges.length>parts.length,bytes,error:null}
}

/** 归档标记与工作区分组都来自该根自己的 `storages/workspace.json`（只读；本模块从不写它）。 */
function storageIndex(dshHome:string):{archived:Set<string>;groups:Map<string,{title:string;path:string}>}{
  const archived=new Set<string>(),groups=new Map<string,{title:string;path:string}>()
  const file=join(dshHome,"storages","workspace.json")
  if(!existsSync(file))return {archived,groups}
  try{
    const parsed=JSON.parse(readFileSync(file,"utf8")) as {global?:{archivedSessionIds?:unknown};tables?:{workspaces?:Record<string,{path?:unknown;title?:unknown;sessionIds?:unknown}>}}
    const ids=parsed.global?.archivedSessionIds
    if(Array.isArray(ids))for(const id of ids)if(typeof id==="string")archived.add(id)
    // 归档只隐藏：会话目录仍在 sessions/ 下，这里只把原生记录里的归档标记读出来。
    for(const workspace of Object.values(parsed.tables?.workspaces??{})){
      const title=typeof workspace.title==="string"&&workspace.title!==""?workspace.title:typeof workspace.path==="string"?workspace.path:""
      const path=typeof workspace.path==="string"?workspace.path:""
      if(!Array.isArray(workspace.sessionIds))continue
      for(const id of workspace.sessionIds)if(typeof id==="string")groups.set(id,{title,path})
    }
  }catch{/* 读不了就按“未归档/未分组”如实处理，不猜 */ }
  return {archived,groups}
}
function textOf(message:unknown):string{
  if(typeof message==="string")return message
  if(Array.isArray(message))return message.map(part=>typeof part==="object"&&part&&"text"in part?String((part as {text?:unknown}).text??""):"").join(" ").trim()
  return ""
}
/** 内容块所在事件：用户消息 / 助手消息 / 工具结果（附件块都在这三处）。 */
function contentBlocks(event:Record<string,any>):any[]{
  if(event.type==="user/message")return Array.isArray(event.data?.content)?event.data.content:[]
  if(event.type==="assistant/message")return Array.isArray(event.data?.message?.content)?event.data.message.content:[]
  if(event.type==="tool/result")return (typeof event.data?.message?.content==="object"&&Array.isArray(event.data.message.content)?event.data.message.content:[]).flatMap((wrapper:any)=>Array.isArray(wrapper?.content)?wrapper.content:[])
  return []
}
/** 附件对象在来源根的附件库里的落地路径（`sha256:…` → `<dshHome>/attachments/v1/objects/<前两位>/<digest>`）。 */
function attachmentObjectPath(dshHome:string,attachmentId:string):string|null{
  const digest=attachmentId.replace(/^sha256:/,"")
  return /^[a-f0-9]{64}$/.test(digest)?join(dshHome,"attachments/v1/objects",digest.slice(0,2),digest):null
}

/** 枚举一个 sessions 目录下的全部会话日志（只读）。 */
function entriesUnder(root:HistoryRoot,index:{archived:Set<string>;groups:Map<string,{title:string;path:string}>},seen:Map<string,string[]>):HistoryEntry[]{
  if(!root.exists)return []
  const result:HistoryEntry[]=[]
  for(const slug of readdirSync(root.sessionsDir)){
    const slugDir=join(root.sessionsDir,slug)
    let sessionIds:string[]=[]
    try{sessionIds=readdirSync(slugDir).filter(name=>statSync(join(slugDir,name)).isDirectory())}catch{continue}
    for(const sessionId of sessionIds){
      const sessionDir=join(slugDir,sessionId)
      let files:string[]=[]
      try{files=readdirSync(sessionDir)}catch{continue}
      const log=files.find(name=>name==="session.v3.jsonl.zstd")??files.find(name=>name==="session.v2.jsonl.zstd")??files.find(name=>/^session\.v\d+\.jsonl(\.zstd|\.zst)?$/.test(name))
      if(!log)continue
      const logFile=join(sessionDir,log),format=log.includes(".v3.")?"v3":log.includes(".v2.")?"v2":"unknown"
      // 发现阶段只解前若干帧就够拿 header 与标题（真实 106 份日志里标题行号 min/median/p90/max
      // = 4/15/17/67，但前面的 request/header 等事件很大：标题字节偏移 p90 只有 325 KiB、最大 501 KiB），
      // 所以按**行数 + 字节**双上限收敛，既拿到标题又不整份解码。
      const window=readLogWindow(logFile,{maxFrames:256,maxBytes:512*1024,maxLines:32})
      let header:Record<string,unknown>={}
      try{const first=window.lines.find(line=>line.trim()!=="");header=first?JSON.parse(first) as Record<string,unknown>:{}}catch{/* header 读不出就如实留空 */ }
      const id=typeof header.id==="string"&&header.id!==""?header.id:sessionId
      const cwd=typeof header.cwd==="string"?header.cwd:""
      let title=""
      for(const line of window.lines){
        try{const event=JSON.parse(line) as {type?:string;data?:{title?:unknown}};if(event.type==="session/title"&&typeof event.data?.title==="string")title=event.data.title}catch{/* 坏行跳过，不影响其余读数 */ }
      }
      const group=index.groups.get(id)??null
      const list=seen.get(id)??[];list.push(logFile);seen.set(id,list)
      result.push({
        id,title,cwd,cwdExists:cwd!==""&&existsSync(cwd),createdAt:typeof header.createdAt==="number"?header.createdAt:null,
        format,messages:0,attachments:0,
        root:root.label,dshHome:root.dshHome,sessionsDir:root.sessionsDir,workspaceSlug:slug,sessionDir,logFile,logBytes:statSync(logFile).size,
        current:root.current,archived:index.archived.has(id),
        group:group?.title??null,groupPath:group?.path??null,
        frames:window.frames,torn:window.torn,truncated:window.truncated,decodeError:window.error,
        seeded:header.isSeeded===true,
        origin:typeof header.origin==="string"?header.origin:null,
        parentSession:typeof header.parentSession==="string"?header.parentSession:null,
        fixture:header.isSeeded===true&&header.origin!=="subagent"&&typeof header.parentSession!=="string",
        duplicateOf:[],restorable:window.error===null,reason:"",
      })
    }
  }
  return result
}

/** 发现全部根下的历史会话（只读）；重复 ID 只标注、不合并。 */
export function discoverSessions(env:NodeJS.ProcessEnv=process.env):{roots:HistoryRoot[];entries:HistoryEntry[]}{
  const roots=historyRoots(env),seen=new Map<string,string[]>(),entries:HistoryEntry[]=[]
  for(const root of roots)entries.push(...entriesUnder(root,storageIndex(root.dshHome),seen))
  for(const entry of entries){
    const copies=(seen.get(entry.id)??[]).filter(file=>file!==entry.logFile)
    entry.duplicateOf=copies
    if(entry.decodeError!==null)entry.reason=`日志解不开（${entry.decodeError}）：原件仍在，恢复前需人工确认，本模块不复制坏数据`
    else if(entry.torn)entry.reason="日志尾帧写到一半（Host 可能仍在写）：只读预览可用，恢复拿到的是当前已落盘的完整帧"
    else if(entry.archived)entry.reason="原生记录里已归档（只隐藏，不删除）：恢复后仍可在界面里显式打开"
    else if(copies.length>0)entry.reason=`同一 ID 在 ${copies.length+1} 个位置有副本（含版本副本/夹具）：不自动合并，按来源逐个列出`
    else if(entry.fixture)entry.reason="原生记录声明为种子会话：恢复前请确认其来源；运行根或临时目录本身不代表夹具"
    else if(!entry.cwdExists)entry.reason="记录里的 cwd 已失效：会话正文仍可读，恢复不改写 cwd，打开时请另选工作目录"
    else entry.reason="可恢复：正文、cwd 与记录都在场"
  }
  return {roots,entries}
}

/** 只读预检：解出 header、原生标题、首条用户消息、附件引用与存在性；不复制、不写盘。 */
export function precheckSession(entry:HistoryEntry,limit=4000):Precheck{
  const window=readLogWindow(entry.logFile,{maxFrames:4096,maxBytes:16*1024*1024,maxLines:limit})
  if(window.error!==null){
    return {entry,header:{},firstUserText:null,lines:window.lines.length,readable:false,title:entry.id,titleSource:"id",
      userMessages:0,scannedBytes:window.bytes,truncated:false,torn:false,attachmentRefs:[],attachmentsPresent:0}
  }
  let header:Record<string,unknown>={},title="",userMessages=0,firstUser:string|null=null
  const refs:AttachmentRef[]=[];const seenAttachments=new Set<string>()
  for(const line of window.lines){
    let event:Record<string,any>
    try{event=JSON.parse(line) as Record<string,any>}catch{continue}
    if(event.type==="session"&&Object.keys(header).length===0)header=event
    // 原生标题事件可多次出现（改名/自动生成）：取最后一条=当前可见标题。
    if(event.type==="session/title"&&typeof event.data?.title==="string"&&event.data.title!=="")title=event.data.title
    if(event.type==="user/message"){
      userMessages+=1
      if(firstUser===null){const data=event.data as {message?:unknown;content?:unknown}|undefined;firstUser=textOf(data?.message??data?.content??"").slice(0,200)||null}
    }
    for(const block of contentBlocks(event)){
      if(block?.type!=="image"&&block?.type!=="file")continue
      const attachment=block.attachment??{}
      const attachmentId=String(attachment.attachmentId??"")
      const key=attachmentId||`${event.type}:${refs.length}`
      if(seenAttachments.has(key))continue
      seenAttachments.add(key)
      const objectPath=attachmentObjectPath(entry.dshHome,attachmentId)
      const declared=Number.isFinite(Number(attachment.bytes))?Number(attachment.bytes):null
      refs.push({attachmentId,mediaType:String(attachment.mediaType??""),name:String(attachment.name??""),bytes:declared,
        present:objectPath!==null&&existsSync(objectPath)&&(declared===null||statSync(objectPath).size===declared)})
    }
  }
  const first=window.lines.find(line=>line.trim()!=="")
  if(Object.keys(header).length===0&&first)try{header=JSON.parse(first) as Record<string,unknown>}catch{/* 保留空 header，如实报不可读 */ }
  const titleSource:"native"|"first-user"|"id"=title!==""?"native":firstUser!==null?"first-user":"id"
  return {
    entry:{...entry,title:title!==""?title:titleSource==="first-user"?firstUser!:entry.id,messages:userMessages,attachments:refs.length},
    header,firstUserText:firstUser,lines:window.lines.length,readable:Object.keys(header).length>0,
    title:title!==""?title:titleSource==="first-user"?firstUser!:entry.id,titleSource,
    userMessages,scannedBytes:window.bytes,truncated:window.truncated,torn:window.torn,
    attachmentRefs:refs,attachmentsPresent:refs.filter(ref=>ref.present).length,
  }
}

const sha256=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex")

/**
 * 显式恢复：把会话目录**复制**到当前运行根（目标已存在则不动，返回 already-present）。
 * - 原始记录保持不动（不做 move/删除），并在返回值里带上来源根/分组/来源日志哈希；
 * - 不写 `storages/*.json`（不自动合并工作区/归档记录）；
 * - `cwd` 原样保留（失效就如实返回 cwdExists=false，不改写）；
 * - 先复制到目标旁的暂存目录并**逐字节校验**，通过后才落位：中途失败不会留下半截日志，
 *   也不会让下一次运行把"半截日志"当成 already-present 收下。
 */
export function restoreSession(entry:HistoryEntry,targetDshHome:string):RestoreResult{
  const base={sourceLogFile:entry.logFile,sourceRoot:entry.root,sourceGroup:entry.group,sourceSha256:null,targetSha256:null,bytes:0}
  if(!targetDshHome)return {status:"rejected",target:"",files:[],reason:"没有当前运行根（DSH_HOME 缺失）：不猜目标位置",...base}
  if(!existsSync(entry.logFile))return {status:"rejected",target:"",files:[],reason:"来源日志已不在场：不伪造恢复",...base}
  if(entry.dshHome===targetDshHome)return {status:"already-present",target:entry.sessionDir,files:[],reason:"来源就是当前运行根：记录已在原地，无需复制（原件未动）",...base}
  const target=join(targetDshHome,"sessions",entry.workspaceSlug,basename(entry.sessionDir))
  if(existsSync(join(target,basename(entry.logFile))))return {status:"already-present",target,files:[],reason:"目标已有同名日志：不覆盖，保持原样（记录未动）",...base}
  const sourceFiles=readdirSync(entry.sessionDir).filter(name=>name!=="session.lock")
  const sourceSha=sha256(entry.logFile),bytes=statSync(entry.logFile).size
  const staging=join(dirname(target),`.restoring-${basename(entry.sessionDir)}-${process.pid}-${Date.now()}`)
  try{
    mkdirSync(staging,{recursive:true})
    for(const name of sourceFiles){
      const staged=join(staging,name)
      copyFileSync(join(entry.sessionDir,name),staged)
      if(sha256(staged)!==sha256(join(entry.sessionDir,name)))throw new Error(`RESTORE_COPY_MISMATCH: ${name}`)
    }
    mkdirSync(dirname(target),{recursive:true})
    if(!existsSync(target))renameSync(staging,target)
    else for(const name of sourceFiles)renameSync(join(staging,name),join(target,name))
  }catch(error){
    rmSync(staging,{recursive:true,force:true})
    return {status:"rejected",target:"",files:[],reason:`复制未通过逐字节校验，已撤回暂存，目标未改动：${String((error as Error).message??error)}`,...base,sourceSha256:sourceSha,bytes}
  }
  rmSync(staging,{recursive:true,force:true})
  const targetSha=existsSync(join(target,basename(entry.logFile)))?sha256(join(target,basename(entry.logFile))):null
  if(targetSha!==sourceSha)return {status:"rejected",target,files:[],reason:"落位后回读与来源不一致：已如实报错，请人工核对目标目录",...base,sourceSha256:sourceSha,targetSha256:targetSha,bytes}
  const provenance=`来源根「${entry.root}」${entry.group!==null?` / 分组「${entry.group}」`:""}；原始记录未动`
  return {status:"restored",target,files:sourceFiles,sourceLogFile:entry.logFile,sourceRoot:entry.root,sourceGroup:entry.group,
    sourceSha256:sourceSha,targetSha256:targetSha,bytes,
    reason:entry.cwdExists?`已复制到当前运行根并逐字节校验（${sourceSha.slice(0,12)}）；${provenance}`
      :`已复制到当前运行根并逐字节校验（${sourceSha.slice(0,12)}）；${provenance}，且记录里的 cwd（${entry.cwd}）已失效——打开时请另选工作目录，本模块不改写 cwd`}
}
