export type ExitOrigin = "window" | "shortcut" | "menu" | "app" | "update" | "system" | "startup-error"
export interface ExitSummary { dirtyDrafts:number; runningActions:number }
export interface ExitParticipant {
  summary():ExitSummary|Promise<ExitSummary>
  flush():Promise<void>
  stop?():Promise<void>
}
export interface ExitResult { origin:ExitOrigin; decision:"cancelled"|"closed"|"failed"; cleanup?:"confirmed"|"incomplete"; message?:string }
export interface ExitCoordinatorOptions {
  summary():Promise<ExitSummary|undefined>
  confirm(summary:ExitSummary|undefined):Promise<boolean>
  flush():Promise<void>
  stop():Promise<void>
  close():Promise<void>
  exit(origin:ExitOrigin):void
  failed(error:unknown,origin:ExitOrigin):Promise<void>
  stateChanged?(committing:boolean):void
  shutdownTimeoutMs?:number
}

/** 一个退出请求只确认和清理一次；取消及保存失败不进入 Host 关闭。 */
export class ExitCoordinator {
  private pending?:Promise<ExitResult>
  private closed?:ExitResult
  private activeOrigin?:ExitOrigin
  private escalate?:()=>void
  approved=false
  committing=false
  constructor(private readonly options:ExitCoordinatorOptions){}
  request(origin:ExitOrigin):Promise<ExitResult>{
    if(this.closed)return Promise.resolve(this.closed)
    if(this.pending){
      if(origin==="system"||origin==="startup-error"){this.activeOrigin=origin;this.escalate?.()}
      return this.pending
    }
    const task=this.perform(origin).finally(()=>{if(this.pending===task)this.pending=undefined})
    this.pending=task
    return task
  }
  private async perform(origin:ExitOrigin):Promise<ExitResult>{
    this.activeOrigin=origin
    const forced=()=>this.activeOrigin==="system"||this.activeOrigin==="startup-error"
    let wake!:()=>void
    const escalation=new Promise<void>(resolve=>{wake=resolve})
    this.escalate=wake
    const settle=async<T>(name:string,operation:Promise<T>):Promise<T>=>{
      const bounded=async()=>{
        let timer:ReturnType<typeof setTimeout>|undefined
        try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(name+"未在结束预算内确认")),this.options.shutdownTimeoutMs??15000)})])}finally{clearTimeout(timer)}
      }
      if(forced()||this.activeOrigin==="update")return bounded()
      return Promise.race([operation,escalation.then(bounded)])
    }
    const failures:string[]=[]
    const started=new Set<string>()
    const report=async(error:unknown)=>{
      const message=error instanceof Error?error.message:String(error)
      failures.push(message)
      try{
        await settle("退出错误回执",this.options.failed(error,this.activeOrigin??origin))
      }catch(reporter){failures.push("退出错误回执失败："+(reporter instanceof Error?reporter.message:String(reporter)))}
    }
    const phase=async(name:string,run:()=>Promise<void>)=>{
      started.add(name)
      try{
        await settle(name,run())
      }catch(error){if(!forced())throw error;await report(error)}
    }
    const finish=():ExitResult=>{
      this.approved=true
      const settledOrigin=this.activeOrigin??origin
      const result:ExitResult={origin:settledOrigin,decision:"closed",cleanup:failures.length?"incomplete":"confirmed",...failures.length?{message:failures.join("；")}: {}}
      this.closed=result;this.options.exit(settledOrigin);return result
    }
    try{
      const ordinary=["window","shortcut","menu","app"].includes(origin)
      if(ordinary){
        const confirmation=(async()=>{const summary=await this.options.summary();return forced()||await this.options.confirm(summary)})()
        if(!await Promise.race([confirmation,escalation.then(()=>true)]))return {origin,decision:"cancelled"}
      }
      await phase("冻结新输入",async()=>{this.committing=true;this.options.stateChanged?.(true)})
      await phase("草稿 flush",()=>this.options.flush())
      await phase("动作 stop",()=>this.options.stop())
      await phase("Host close",()=>this.options.close())
      return finish()
    }catch(error){
      await report(error)
      if(forced()&&!this.closed){
        if(!started.has("冻结新输入"))await phase("冻结新输入",async()=>{this.committing=true;this.options.stateChanged?.(true)})
        if(!started.has("动作 stop"))await phase("动作 stop",()=>this.options.stop())
        if(!started.has("Host close"))await phase("Host close",()=>this.options.close())
        return finish()
      }
      return {origin:this.activeOrigin??origin,decision:"failed",message:failures.join("；")}
    }finally{
      this.escalate=undefined;this.activeOrigin=undefined
      if(!this.closed){this.committing=false;try{this.options.stateChanged?.(false)}catch(error){await report(error)}}
    }
  }
}

/** 只保参与者归属和计数；草稿内容及动作真值仍由原 owner 管理。 */
export class ExitParticipants {
  private readonly entries=new Map<string,ExitParticipant>()
  register(id:string,participant:ExitParticipant):()=>void{
    if(!id.trim()||this.entries.has(id))throw new Error("退出参与者 id 无效或重复")
    this.entries.set(id,participant)
    return ()=>{if(this.entries.get(id)===participant)this.entries.delete(id)}
  }
  async summary():Promise<ExitSummary&{participants:number}>{
    const result={dirtyDrafts:0,runningActions:0,participants:this.entries.size}
    for(const participant of this.entries.values()){
      const value=await participant.summary()
      for(const key of ["dirtyDrafts","runningActions"] as const){
        if(!Number.isSafeInteger(value[key])||value[key]<0)throw new Error("退出摘要必须为非负整数")
        result[key]+=value[key]
      }
    }
    return result
  }
  async flush(){for(const participant of [...this.entries.values()])await participant.flush()}
  async stop(){for(const participant of [...this.entries.values()])await participant.stop?.()}
}
