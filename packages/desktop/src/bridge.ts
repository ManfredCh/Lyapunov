import type {AccountView} from "./account-controller.ts"
import type {AccountOrder,CreditPlan,PaymentProvider} from "../../lyapunov-product-bundle/src/account/client.ts"
import type {ExitParticipant} from "./exit-coordinator.ts"
import type {AccountLocale,DesktopLocaleState} from "./account-locales.ts"
export interface DesktopBridge {
  uiLocale():Promise<DesktopLocaleState>
  setUiLocale(locale:AccountLocale,userChoice?:boolean):Promise<void>
  onUiLocaleChanged(listener:(state:DesktopLocaleState)=>void):()=>void
  mode():Promise<"formal"|"developer"|"guest">
  guest():Promise<void>
  registerExitParticipant(id:string,participant:ExitParticipant):()=>void
  onExitStateChanged?(listener:(committing:boolean)=>void):()=>void
  accountState():Promise<AccountView>
  login():Promise<void>
  cancelLogin():Promise<void>
  logout():Promise<void>
  switchAccount():Promise<void>
  restore():Promise<void>
  refresh():Promise<AccountView>
  commerce():Promise<{plans:CreditPlan[];orders:AccountOrder[];paymentMethods:Array<{id:PaymentProvider;available:boolean}>}>
  createOrder(planId:string,provider:PaymentProvider):Promise<{order:AccountOrder}>
  showWorkspace():Promise<void>
  showAccount():Promise<void>
  returnToLogin():Promise<void>
  selectFiles():Promise<string[]>
  getDroppedFilePaths(files:File[]):string[]
  version():Promise<string>
  checkUpdates():Promise<{available:boolean;version?:string;reason?:string}>
  installUpdate():Promise<void>
  onAccountChanged(listener:(state:AccountView)=>void):()=>void
}
declare global {interface Window {lyapunovDesktop?:DesktopBridge}}
