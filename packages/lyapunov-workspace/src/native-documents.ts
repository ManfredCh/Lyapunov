/** 原生文件标签的草稿。文件事实仍由Host ctx.fs的版本写入决定。 */
import {parseFileAddress} from '@deepseek-ai/dsh-util-workspace-path/src/file-address.ts'
export type DocumentSnapshot={base?:{path:string;content:string;version?:string};draft:string;loading:boolean;saving:boolean;error:string;notice:string}
export class FileDocument {
 readonly sessionId:string
 readonly path:string
 private value:DocumentSnapshot
 private listeners=new Set<()=>void>()
 private request=0
 private edits=0
 private asked=false
 private autoAttempt?:{draft:string;version?:string}
 constructor(readonly address:string,create=false){
  const file=parseFileAddress(address)
  if(!file||file.scope!=='session')throw Error('文件必须属于明确的工作区会话。')
  this.sessionId=file.sessionId;this.path=file.path
  this.value={base:create?{path:file.path,content:''}:undefined,draft:'',loading:false,saving:false,error:'',notice:''}
 }
 snapshot=()=>this.value
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private set(value:Partial<DocumentSnapshot>){this.value={...this.value,...value};for(const fn of this.listeners)fn()}
 private async call(action:string,input:unknown){
  const response=await fetch('/api/lyapunov/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:this.sessionId,action,input})})
  const value=await response.json()
  if(!response.ok)throw Error(value.error??response.statusText)
  return value
 }
 edit(text:string){this.edits++;this.set({draft:text,notice:''})}
 load=async()=>{
  if(this.asked)return
  this.asked=true
  if(!this.value.base)await this.reload()
 }
 reload=async()=>{
  if(this.value.saving)return
  const request=++this.request,epoch=this.edits
  this.set({loading:true,error:'',notice:''})
  try{
   const base=await this.call('read',{path:this.path})
   if(request!==this.request)return
   if(epoch!==this.edits){this.set({notice:'读取期间已有新的编辑，已保留草稿。'});return}
   this.set({base,draft:base.content})
  }catch(error){if(request===this.request)this.set({error:String((error as Error).message??error)})}
  finally{if(request===this.request)this.set({loading:false})}
 }
 save=async(automatic=false)=>{
  const {base,draft,saving}=this.value
  if(!base||saving||(base.version&&base.content===draft))return
  if(automatic&&this.autoAttempt?.draft===draft&&this.autoAttempt.version===base.version)return
  this.autoAttempt={draft,version:base.version}
  ++this.request
  this.set({loading:false,saving:true,error:'',notice:''})
  try{
   const result=await this.call('write',{path:this.path,content:draft,version:base.version})
   if(this.value.base?.version===base.version)this.set({base:{path:this.path,content:draft,version:result.version},notice:'文件已保存'})
  }catch(error){this.set({error:String((error as Error).message??error)})}
  finally{this.set({saving:false})}
 }
}
// 同一原生资源地址共用同一份草稿；关闭再打开、保存回执迟到也不会创建另一份基版本。
const documents=new Map<string,FileDocument>()
export function fileDocument(address:string,create=false){let doc=documents.get(address);if(!doc){doc=new FileDocument(address,create);documents.set(address,doc)}return doc}

/** 退出参与者直接读取唯一草稿 owner；保存冲突保留草稿并向退出协调器抛错。 */
export function documentExitParticipant(){
 const dirty=(doc:FileDocument)=>{const value=doc.snapshot();return Boolean(value.base&&(value.base.content!==value.draft||!value.base.version))}
 const idle=(doc:FileDocument)=>new Promise<void>(resolve=>{
  let dispose=()=>{};const check=()=>{const value=doc.snapshot();if(!value.loading&&!value.saving){dispose();resolve()}}
  dispose=doc.subscribe(check);check()
 })
 return {
  summary:()=>({dirtyDrafts:[...documents.values()].filter(dirty).length,runningActions:0}),
  flush:async()=>{for(const doc of documents.values()){
   await idle(doc)
   if(!dirty(doc))continue
   await doc.save()
   const value=doc.snapshot()
   if(value.error||dirty(doc))throw new Error(value.error||'文件草稿尚未完成保存：'+doc.path)
  }},
 }
}
export interface DocumentExitBridge {registerExitParticipant:(id:string,participant:ReturnType<typeof documentExitParticipant>)=>()=>void}
export function registerDocumentExitParticipant(bridge:DocumentExitBridge|undefined){if(typeof bridge?.registerExitParticipant!=='function')return()=>{};return bridge.registerExitParticipant('lyapunov-workspace:documents',documentExitParticipant())??(()=>{})}
