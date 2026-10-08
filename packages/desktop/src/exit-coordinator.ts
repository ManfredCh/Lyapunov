export type ExitOrigin = "window" | "shortcut" | "menu" | "app" | "update" | "system" | "startup-error"
export interface ExitSummary { dirtyDrafts:number; runningActions:number }
export function isExitSummary(value:unknown):value is ExitSummary {
  if(!value||typeof value!=="object")return false
  const summary=value as Partial<ExitSummary>
  return [summary.dirtyDrafts,summary.runningActions].every(count=>typeof count==="number"&&Number.isSafeInteger(count)&&count>=0)
}
export interface ExitParticipant {
  summary():ExitSummary|Promise<ExitSummary>
  flush():Promise<void>
  stop?():Promise<void>
}
export interface ExitResult { origin:ExitOrigin; decision:"cancelled"|"closed"|"failed"; cleanup?:"confirmed"|"incomplete"; message?:string }
export type ExitFailureAction = "return" | "retry" | "force"
export interface ExitCoordinatorOptions {
  summary():Promise<ExitSummary|undefined>
  confirm(summary:ExitSummary|undefined):Promise<boolean>
  flush():Promise<void>
  stop():Promise<void>
  close():Promise<void>
  exit(origin:ExitOrigin,force?:boolean):void
  failed(error:unknown,origin:ExitOrigin,forced?:boolean):Promise<ExitFailureAction|void>
  stateChanged?(committing:boolean):void
  shutdownTimeoutMs?:number
}

/** 一个退出请求共享确认与清理；失败保留窗口，只有显式强退才继续有界关闭。 */
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
    // 重试留在同一 pending 中；错误弹窗不递归 request，避免等待自己。
    const task=(async()=>{while(true){const result=await this.perform(origin);if(result!=="retry")return result}})().finally(()=>{if(this.pending===task)this.pending=undefined})
    this.pending=task
    return task
  }
  private async perform(origin:ExitOrigin):Promise<ExitResult|"retry">{
    this.activeOrigin=origin
    let userForced=false
    const forced=()=>userForced||this.activeOrigin==="system"||this.activeOrigin==="startup-error"
    let wake!:()=>void
    const escalation=new Promise<void>(resolve=>{wake=resolve})
    this.escalate=wake
    const settle=async<T>(name:string,operation:Promise<T>):Promise<T>=>{
      const bounded=async()=>{
        let timer:ReturnType<typeof setTimeout>|undefined
        try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(name+"未在结束预算内确认")),this.options.shutdownTimeoutMs??15000)})])}finally{clearTimeout(timer)}
      }
      return bounded()
    }
    const failures:string[]=[]
    const started=new Set<string>()
    let confirmedClean=false
    const report=async(error:unknown):Promise<ExitFailureAction|void>=>{
      const message=error instanceof Error?error.message:String(error)
      failures.push(message)
      try{
        // 用户选择没有倒计时；自动/已强退时不让错误回执阻挡清理。
        const response=this.options.failed(error,this.activeOrigin??origin,forced())
        const action=forced()?await settle("退出错误回执",response):await Promise.race([response,escalation.then(()=>settle("退出错误回执",response))])
        if(action==="force")userForced=true
        return action
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
      this.closed=result;this.options.exit(settledOrigin,userForced);return result
    }
    try{
      const ordinary=["window","shortcut","menu","app"].includes(origin)
      if(ordinary){
        const confirmation=(async()=>{let summary:ExitSummary|undefined;try{summary=await settle("退出摘要",this.options.summary())}catch{}confirmedClean=isExitSummary(summary)&&summary.dirtyDrafts===0;return forced()||await this.options.confirm(summary)})()
        if(!await Promise.race([confirmation,escalation.then(()=>true)]))return {origin,decision:"cancelled"}
      }
      await phase("冻结新输入",async()=>{this.committing=true;this.options.stateChanged?.(true)})
      // 确认期间可能有后台变更；冻结后再读一次，未知摘要不能当成空草稿。
      if(confirmedClean){
        try{const summary=await settle("退出摘要",this.options.summary());confirmedClean=isExitSummary(summary)&&summary.dirtyDrafts===0}catch{confirmedClean=false}
      }
      if(!confirmedClean)await phase("草稿 flush",()=>this.options.flush())
      await phase("动作 stop",()=>this.options.stop())
      await phase("Host close",()=>this.options.close())
      return finish()
    }catch(error){
      const action=await report(error)
      if(forced()&&!this.closed){
        if(!started.has("冻结新输入"))await phase("冻结新输入",async()=>{this.committing=true;this.options.stateChanged?.(true)})
        if(!started.has("动作 stop"))await phase("动作 stop",()=>this.options.stop())
        if(!started.has("Host close"))await phase("Host close",()=>this.options.close())
        return finish()
      }
      if(action==="retry")return "retry"
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
  async flush(){await this.run("flush")}
  async stop(){await this.run("stop")}
  private async run(phase:"flush"|"stop"){
    // 一个 owner 报错不妨碍其余 owner 保存/停止；每份结果仍须由原 owner 确认。
    const entries=[...this.entries],results=await Promise.allSettled(entries.map(async([,participant])=>await participant[phase]?.()))
    const failures:string[]=[]
    for(const [index,result] of results.entries()){
      if(result.status==="rejected"){const error=result.reason;failures.push(entries[index]![0]+": "+(error instanceof Error?error.message:String(error)))}
    }
    if(failures.length)throw new Error(failures.join("；"))
  }
}
