import {readFile,readdir,stat,writeFile,mkdir} from 'node:fs/promises'
import {join,basename,relative} from 'node:path'

const roots=['project','workspace','session','message','part','todo','permission','session_diff','session_share']
export interface JsonSourceStamp {path:string;size:number;mtimeMs:number}
export async function jsonSourceStamps(directory:string):Promise<JsonSourceStamp[]>{
  const found:JsonSourceStamp[]=[]
  async function walk(path:string){
    let rows;try{rows=await readdir(path,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    for(const row of rows.sort((a,b)=>a.name.localeCompare(b.name))){
      const file=join(path,row.name)
      if(row.isSymbolicLink())throw new Error('JSON_STORAGE_SYMLINK: '+file)
      if(row.isDirectory())await walk(file)
      else if(row.isFile()&&row.name.endsWith('.json')){const info=await stat(file);found.push({path:relative(directory,file),size:info.size,mtimeMs:info.mtimeMs})}
    }
  }
  for(const name of roots)await walk(join(directory,name))
  return found.sort((a,b)=>a.path.localeCompare(b.path))
}

/** 读取明确指定的本应用JSON存储；支持现有平铺布局与旧session/info布局。 */
export async function snapshotJsonSource(directory:string,exportPath:string,before:JsonSourceStamp[]){
  const tables:Record<string,any[]>={project:[],workspace:[],session:[],message:[],part:[],todo:[],permission:[],session_diff:[],session_share:[]}
  const original:Record<string,unknown>={},issues:Array<{kind:string;id:string;path?:string;reason:string}>=[]
  const sessions=new Map<string,any>(),messages=new Map<string,any>(),parts:Array<{file:JsonSourceStamp;data:any}>=[]
  const created=(data:any,file:JsonSourceStamp)=>data.time?.created??data.time_created??Math.trunc(file.mtimeMs)
  const updated=(data:any,file:JsonSourceStamp)=>Math.max(data.time?.updated??data.time_updated??0,Math.trunc(file.mtimeMs))
  const put=(map:Map<string,any>,id:string,value:any,file:JsonSourceStamp)=>{if(map.has(id))throw new Error('JSON_STORAGE_DUPLICATE_ID: '+file.path);map.set(id,value)}
  for(const file of before){
    const data=JSON.parse(await readFile(join(directory,file.path),'utf8'));original[file.path]=data
    const path=file.path.split(/[\\/]/),kind=path[0],id=basename(file.path,'.json')
    if(kind==='session'&&(path.length===3&&path[1]!=='message'&&path[1]!=='part')){
      put(sessions,id,{...data,id,project_id:path[1]==='info'?data.projectID:path[1],parent_id:data.parentID??data.parent_id??null,directory:data.directory??data.path?.root??'',title:data.title??'',time_created:created(data,file),time_updated:updated(data,file)},file)
    }else if((kind==='message'&&path.length===3)||(kind==='session'&&path[1]==='message'&&path.length===4)){
      const sessionId=path.at(-2)!,{id:_id,sessionID:_session,...rest}=data
      put(messages,id,{id,session_id:sessionId,time_created:created(data,file),time_updated:updated(data,file),data:rest},file)
    }else if((kind==='part'&&path.length===3)||(kind==='session'&&path[1]==='part'&&path.length===5))parts.push({file,data})
    else if(tables[kind!]&&path.length===2)tables[kind!]!.push(Array.isArray(data)?{id,data}:{...data,id})
    else issues.push({kind:'json-record',id,path:join(directory,file.path),reason:'UNRECOGNIZED_LAYOUT；原JSON已保留在私有快照'})
  }
  for(const session of sessions.values()){
    const project=tables.project!.find(row=>row.id===session.project_id)
    session.directory ||= project?.worktree??''
    tables.session!.push(session)
  }
  for(const message of messages.values()){
    if(!sessions.has(message.session_id)){issues.push({kind:'message',id:message.id,reason:'ORPHAN_MESSAGE；原JSON已保留'});continue}
    tables.message!.push(message)
  }
  const validMessages=new Map(tables.message!.map(row=>[row.id,row]))
  for(const {file,data} of parts){
    const path=file.path.split(/[\\/]/),id=basename(file.path,'.json'),messageId=path.at(-2)!,message=validMessages.get(messageId)
    if(!message){issues.push({kind:'part',id,path:join(directory,file.path),reason:'ORPHAN_PART；原JSON已保留'});continue}
    if(tables.part!.some(row=>row.id===id))throw new Error('JSON_STORAGE_DUPLICATE_ID: '+file.path)
    const {id:_id,sessionID:_session,messageID:_message,...rest}=data
    tables.part!.push({id,message_id:messageId,session_id:message.session_id,time_created:created(data,file),time_updated:updated(data,file),data:rest})
  }
  if(JSON.stringify(before)!==JSON.stringify(await jsonSourceStamps(directory)))throw new Error('JSON_SOURCE_CHANGED_DURING_SNAPSHOT；未导入不一致快照，请重试原来源')
  // 兼容布局之外的一级子目录既不能静默忽略（那会把"没迁"报成"迁完了"），也不能自动搬
  // （布局未知、搬错比不搬更糟）。逐目录留一条 issue，原目录原样保留，由调用方决定后续。
  for(const entry of (await readdir(directory,{withFileTypes:true}).catch(()=>[])).sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.isDirectory()||roots.includes(entry.name)||entry.name.startsWith('.'))continue
    issues.push({kind:'json-record',id:entry.name,path:join(directory,entry.name),reason:'UNRECOGNIZED_LAYOUT_DIRECTORY；该旧存储子目录不在兼容布局内，原目录原样保留'})
  }
  await mkdir(join(exportPath,'..'),{recursive:true})
  await writeFile(exportPath,JSON.stringify(tables),{mode:0o600})
  await writeFile(exportPath.replace(/\.json$/,'.original.json'),JSON.stringify(original),{mode:0o600})
  return {source:tables,summary:{tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length])),unmigrated:{}},issues}
}
