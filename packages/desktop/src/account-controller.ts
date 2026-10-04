import {createAccountClient,AccountApiError,normalizeAccountBalances,summarizeAccountUsage,type AccountAuthResult,type AccountBalances,type AccountOrder,type AccountUsageSummary,type CreditPlan,type PaymentProvider} from "../../lyapunov-product-bundle/src/account/client.ts"
import {verifyFormalAccount,type VerifiedAccount} from "../../lyapunov-product-bundle/src/account/formal.ts"
import type {AccountSessionStore} from "./account-session-store.ts"
import {GUEST_CAPABILITIES} from "../../lyapunov-product-bundle/src/guest-runtime.ts"
export interface AccountView {
  status:"signed-out"|"restoring"|"waiting-login"|"starting"|"ready"|"guest-starting"|"guest"|"error"
  user?:{id:string;email:string}
  balances?:AccountBalances
  usage?:AccountUsageSummary
  usageStatus?:"idle"|"syncing"|"ready"|"error"|"balance-unavailable"
  message?:string
  capabilities?:typeof GUEST_CAPABILITIES
}
export interface AccountControllerOptions {
  apiUrl:string
  store:AccountSessionStore
  openExternal:(url:string)=>Promise<void>
  startHost:(account:VerifiedAccount,signal:AbortSignal)=>Promise<void>
  startGuestHost?:(signal:AbortSignal)=>Promise<void>
  stopHost:()=>Promise<void>
  changed:(state:AccountView)=>void
  fetcher?:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>
}
/** 主进程持有可撤销会话；Renderer只获得已验证的公开状态。 */
export class DesktopAccountController {
  private epoch=0
  private current?:VerifiedAccount
  private guestActive=false
  private state:AccountView={status:"signed-out"}
  private loginAbort?:AbortController
  private activationAbort?:AbortController
  private usageAbort?:AbortController
  private refreshAbort?:AbortController
  private refreshSequence=0
  private client:ReturnType<typeof createAccountClient>
  private options:AccountControllerOptions
  constructor(options:AccountControllerOptions){this.options=options;this.client=createAccountClient({baseUrl:options.apiUrl,fetcher:options.fetcher})}
  view(){return structuredClone(this.state)}
  private publish(state:AccountView){this.state=state;this.options.changed(this.view())}
  async restore(){
    this.requireNonGuest()
    this.cancelLogin()
    const epoch=this.epoch;this.publish({status:"restoring"})
    try{
      if(this.current){await this.activate(this.current.token,epoch,false);return}
      const value=await this.options.store.get()
      if(epoch!==this.epoch)return
      if(!value){this.publish({status:"signed-out"});return}
      const saved=JSON.parse(value) as {apiUrl?:string;token?:string;session?:{token?:string}}
      if(saved.apiUrl&&saved.apiUrl!==this.options.apiUrl)throw new Error("保存的账号属于另一服务地址；请重新登录")
      const token=saved.token??saved.session?.token
      if(!token)throw new Error("保存的账户会话无效")
      await this.activate(token,epoch,false)
    }catch(error){
      if(epoch!==this.epoch)return
      if(error instanceof AccountApiError&&[401,403].includes(error.status)){await this.logout();return}
      this.publish({status:"error",message:error instanceof Error?error.message:String(error)})
    }
  }
  async login(){
    this.requireNonGuest()
    if(this.current)throw new Error("请先退出当前账户，再登录另一个账户")
    this.cancelLogin()
    const epoch=this.epoch,abort=new AbortController();this.loginAbort=abort
    this.publish({status:"waiting-login"})
    try{
      const flow=await this.client.startWebsiteLogin(abort.signal)
      if(epoch!==this.epoch)return
      await this.options.openExternal(flow.authorizeUrl)
      const expires=Date.parse(flow.expiresAt)
      if(!Number.isFinite(expires))throw new Error("登录服务没有返回有效的过期时间")
      while(!abort.signal.aborted&&epoch===this.epoch){
        if(Date.now()>expires)throw new Error("登录已过期，请重新开始")
        const result=await this.client.completeWebsiteLogin(flow.flowId,abort.signal)
        if(epoch!==this.epoch||abort.signal.aborted)return
        if("session" in result){await this.acceptLogin(result,epoch);return}
        await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(timer);abort.signal.removeEventListener("abort",done);resolve()}
          const timer=setTimeout(done,2000);abort.signal.addEventListener("abort",done,{once:true})
        })
      }
    }catch(error){if(epoch===this.epoch&&!abort.signal.aborted)this.publish({status:"error",message:error instanceof Error?error.message:String(error)})}
    finally{if(this.loginAbort===abort)this.loginAbort=undefined}
  }
  private async acceptLogin(result:AccountAuthResult,epoch:number){await this.activate(result.session.token,epoch,true)}
  private async activate(token:string,epoch:number,persist:boolean){
    const abort=new AbortController();this.activationAbort=abort
    let account:VerifiedAccount
    try{
      account=await verifyFormalAccount({apiUrl:this.options.apiUrl,token,fetcher:this.options.fetcher,signal:abort.signal})
      if(epoch!==this.epoch||abort.signal.aborted)return
      this.publish({status:"starting",user:account.me.user})
      await this.options.startHost(account,abort.signal)
    }finally{if(this.activationAbort===abort)this.activationAbort=undefined}
    if(epoch!==this.epoch||abort.signal.aborted)return
    this.current=account
    let message:string|undefined
    if(persist)try{await this.options.store.set(JSON.stringify({apiUrl:account.apiUrl,token}))}catch{message="登录有效，但系统安全存储不可用；本次退出后需要重新登录。"}
    if(epoch!==this.epoch)return
    const balances=normalizeAccountBalances(account.me.balances)
    this.publish({status:"ready",user:account.me.user,balances,usage:balances?summarizeAccountUsage(balances,[]):undefined,usageStatus:balances?"syncing":"balance-unavailable",message})
    if(balances)this.loadUsage(account,epoch,balances)
  }
  private async loadUsage(account:VerifiedAccount,epoch:number,balances:AccountBalances){
    this.usageAbort?.abort()
    const abort=new AbortController();this.usageAbort=abort
    const timeout=setTimeout(()=>abort.abort(),15000)
    try{
      const result=await this.client.ledger(account.token,abort.signal)
      if(epoch!==this.epoch||abort.signal.aborted||this.current?.me.user.id!==account.me.user.id)return
      const usage=summarizeAccountUsage(balances,result.entries)
      this.publish({...this.state,usage,usageStatus:"ready"})
    }catch(error){
      if(epoch!==this.epoch||abort.signal.aborted||this.current?.me.user.id!==account.me.user.id)return
      this.publish({...this.state,usageStatus:"error"})
    }finally{clearTimeout(timeout);if(this.usageAbort===abort)this.usageAbort=undefined}
  }
  cancelLogin(){this.epoch++;this.loginAbort?.abort();this.loginAbort=undefined;this.activationAbort?.abort();this.activationAbort=undefined;this.usageAbort?.abort();this.usageAbort=undefined;this.refreshAbort?.abort();this.refreshAbort=undefined;this.refreshSequence++;if(["waiting-login","starting","restoring"].includes(this.state.status))this.publish(this.current?{status:"error",user:this.current.me.user,balances:normalizeAccountBalances(this.current.me.balances),message:"连接已取消，可重新连接工作台。"}:{status:"signed-out"})}
  /** 返回现有账户页，不注销有效正式身份，也不隐式恢复游客前的账户。 */
  async returnToLogin(){
    this.cancelLogin()
    if(this.guestActive){await this.leaveGuest();return}
    if(this.current)this.publish({status:'ready',user:this.current.me.user,balances:normalizeAccountBalances(this.current.me.balances),usage:this.state.usage,usageStatus:this.state.usageStatus})
    else this.publish({status:'signed-out'})
  }
  /** 客户端激活失败不等于认证失效；现有身份/账户存储/工程保持。 */
  workspaceFailed(message:string){this.publish({...this.state,status:'error',message})}
  workspaceReloaded(){if(this.guestActive)this.publish({status:'guest',capabilities:GUEST_CAPABILITIES});else if(this.current)this.publish({...this.state,status:'ready',message:undefined})}
  /** 游客不是注销；仅撤销本次网络/Host 激活，保存账号存储不动。 */
  async enterGuest(){
    if(!this.options.startGuestHost)throw new Error("游客工作台未装配")
    this.guestActive=true;this.cancelLogin();this.current=undefined
    const epoch=this.epoch,abort=new AbortController();this.activationAbort=abort
    this.publish({status:"guest-starting"})
    try{
      await this.options.startGuestHost(abort.signal)
      if(epoch!==this.epoch||abort.signal.aborted)return
      this.publish({status:"guest",capabilities:GUEST_CAPABILITIES,message:"游客 · 可在模型设置中显式配置自己的 provider；不登录产品后端、不使用 Peiri 或额度。本地工程独立保存；带入账户前请在游客工作台导出，再登录并显式选择该工程文件导入。不会自动合并。"})
    }catch(error){if(epoch===this.epoch&&!abort.signal.aborted)this.publish({status:"error",message:error instanceof Error?error.message:String(error)})}
    finally{if(this.activationAbort===abort)this.activationAbort=undefined}
  }
  async leaveGuest(){
    if(!this.guestActive)return
    this.cancelLogin();const epoch=this.epoch
    await this.options.stopHost()
    if(epoch===this.epoch){this.guestActive=false;this.publish({status:"signed-out"})}
  }
  hostStopped(){this.epoch++;this.refreshSequence++;this.refreshAbort?.abort();this.refreshAbort=undefined;this.usageAbort?.abort();this.usageAbort=undefined;if(this.current)this.publish({status:"error",user:this.current.me.user,balances:normalizeAccountBalances(this.current.me.balances),message:"工作台进程已退出。重新连接会恢复会话与保存的场景；旧机器人动作不会自动重发。"})}
  async logout(){
    if(this.guestActive){await this.leaveGuest();return}
    this.cancelLogin();const epoch=this.epoch,account=this.current;this.current=undefined
    this.options.store.delete()
    let localMessage:string|undefined
    try{await this.options.stopHost()}catch(error){
      // 退出必须先闭合本地身份边界；Host 关闭失败不能让 Renderer 永久停在旧账户。
      localMessage="本机已退出；工作台关闭未确认："+(error instanceof Error?error.message:String(error))
    }
    if(epoch===this.epoch)this.publish({status:"signed-out",message:localMessage})
    if(account)try{await this.client.logout(account.token,AbortSignal.timeout(10000))}catch(error){if(epoch===this.epoch)this.publish({status:"signed-out",message:[localMessage,"服务端会话撤销未确认："+(error instanceof Error?error.message:String(error))].filter(Boolean).join("；")})}
  }
  async refresh(){
    const account=this.requireAccount(),epoch=this.epoch,sequence=++this.refreshSequence
    this.refreshAbort?.abort()
    const abort=new AbortController();this.refreshAbort=abort
    const timeout=setTimeout(()=>abort.abort(),15000)
    try{
      const me=await this.client.me(account.token,abort.signal)
      if(epoch!==this.epoch||sequence!==this.refreshSequence||abort.signal.aborted)return this.view()
      if(me.user.id!==account.me.user.id){await this.logout();throw new Error("账户身份变化，请重新登录")}
      this.current={...account,me}
      const balances=normalizeAccountBalances(me.balances)
      this.publish({status:"ready",user:me.user,balances,usage:balances?summarizeAccountUsage(balances,[]):undefined,usageStatus:balances?"syncing":"balance-unavailable"})
      if(balances)void this.loadUsage(this.current,epoch,balances)
    }catch(error){
      if(epoch!==this.epoch||sequence!==this.refreshSequence||abort.signal.aborted)return this.view()
      if(error instanceof AccountApiError&&[401,403].includes(error.status)){await this.logout();return this.view()}
      this.publish({...this.state,message:"余额同步失败："+(error instanceof Error?error.message:String(error))})
    }finally{clearTimeout(timeout);if(this.refreshAbort===abort)this.refreshAbort=undefined}
    return this.view()
  }
  async commerce():Promise<{plans:CreditPlan[];orders:AccountOrder[];paymentMethods:Array<{id:PaymentProvider;available:boolean}>}>{
    const account=this.requireAccount(),epoch=this.epoch
    const [plans,orders,methods]=await Promise.all([this.client.plans(),this.client.orders(account.token),this.client.paymentMethods(account.token)])
    if(epoch!==this.epoch)throw new Error("账户已切换")
    return {plans:plans.plans,orders:orders.orders,paymentMethods:methods.methods}
  }
  async createOrder(planId:string,provider:PaymentProvider){
    const account=this.requireAccount(),epoch=this.epoch
    const result=await this.client.createOrder(account.token,planId,provider)
    if(epoch!==this.epoch)throw new Error("账户已切换，订单结果未应用到当前会话")
    await this.options.openExternal(result.checkout.url)
    return {order:result.order}
  }
  private requireNonGuest(){if(this.guestActive)throw new Error("GUEST_PRODUCT_SERVICE_FORBIDDEN: 请先显式离开游客工作台再登录账户")}
  private requireAccount(){if(!this.current||this.guestActive)throw new Error("AUTH_REQUIRED");return this.current}
}
