/** Provider 页顶部的账户余额：正式账户登录后由账户服务读数。 */
import type {Context} from "@deepseek-ai/cordis"
import type {} from "@deepseek-ai/dsh-client-ui-settings-models/client"
import type {PropsLocale} from "@deepseek-ai/dsh-client-ui-slots"
import {formatAccountPoints,type AccountBalances} from "../../lyapunov-product-bundle/src/account/client.ts"
import {balancePresentation,bridgeUnavailableText} from "./balance-section-helpers.ts"

type BridgeAccountState={status:string;user?:{id:string;email:string};balances?:AccountBalances;message?:string}
type Bridge={
  mode():Promise<"formal"|"developer">
  accountState():Promise<BridgeAccountState>
  refresh():Promise<BridgeAccountState>
  showAccount():Promise<void>
  onAccountChanged(listener:(state:BridgeAccountState)=>void):()=>void
}
const bridge=()=>(window as unknown as {lyapunovDesktop?:Bridge}).lyapunovDesktop

import {useCallback,useEffect,useRef,useState} from "react"

export function BalanceSection({t}:PropsLocale<"lyapunov">){
  const [state,setState]=useState<BridgeAccountState>(),[mode,setMode]=useState<"formal"|"developer">(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[loading,setLoading]=useState(true)
  const epoch=useRef(0),accountId=useRef<string>()
  const locale=t("open")==="Scene workbench"?"en":"zh"
  const showAccount=useCallback(async()=>{
    const api=bridge()
    if(!api){setError(bridgeUnavailableText(locale));return}
    try{await api.showAccount()}catch(failure){setError(String(failure instanceof Error?failure.message:failure))}
  },[locale])
  useEffect(()=>{
    const api=bridge()
    if(!api){setLoading(false);setError(bridgeUnavailableText(locale));return}
    let alive=true
    const current=++epoch.current
    const publish=(next:BridgeAccountState,token=current)=>{if(alive&&token===epoch.current){accountId.current=next.user?.id;setState(next);setError(next.message);setBusy(false);setLoading(false)}}
    const unsubscribe=api.onAccountChanged(next=>{
      const nextId=next.user?.id
      const changed=nextId!==accountId.current||next.status!=="ready"
      const token=changed?++epoch.current:epoch.current
      publish(next,token)
    })
    void api.mode().then(value=>{if(alive&&current===epoch.current)setMode(value)}).catch(failure=>{if(alive&&current===epoch.current)setError(String(failure instanceof Error?failure.message:failure))})
    void api.accountState().then(next=>publish(next)).catch(failure=>{if(alive&&current===epoch.current){setError(String(failure instanceof Error?failure.message:failure));setLoading(false)}})
    return()=>{alive=false;epoch.current++;unsubscribe?.()}
  },[locale])
  const refresh=useCallback(async()=>{
    const api=bridge();if(!api){setError(bridgeUnavailableText(locale));return}
    const current=++epoch.current
    setBusy(true);setLoading(true);setError(undefined)
    try{const next=await api.refresh();if(current===epoch.current){accountId.current=next.user?.id;setState(next);setError(next.message)}}catch(failure){if(current===epoch.current)setError(String(failure instanceof Error?failure.message:failure))}finally{if(current===epoch.current){setBusy(false);setLoading(false)}}
  },[locale])
  if(mode==="developer")return <section className="lya-balance"><style>{balanceStyle}</style><p className="lya-balance-hint">{t("devHint")}</p></section>
  const presentation=balancePresentation({loading,state,error,locale}),ready=state?.status==="ready"
  return <section className="lya-balance"><style>{balanceStyle}</style>
    <div className="lya-balance-card">
      <small>{t("credits")}</small>
      <strong>{ready&&!loading?formatAccountPoints(state?.balances,locale):"—"}</strong>
      {state?.user?.email&&<span className="lya-balance-user">{state.user.email}</span>}
      {presentation.kind!=="ready"&&<p className={presentation.kind==="error"?"lya-balance-error":"lya-balance-hint"}>{presentation.text}</p>}
      <div className="lya-balance-actions">
        <button disabled={busy||loading||!ready} onClick={()=>void refresh()}>{t("refresh")}</button>
        <button className="primary" onClick={()=>void showAccount()}>{t("openAccount")}</button>
      </div>
    </div>
  </section>
}

const balanceStyle=`
.lya-balance-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--border-weak-base,#26303f);border-radius:12px;padding:18px;max-width:360px}
.lya-balance-card small{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.65}
.lya-balance-card strong{font-size:28px;font-weight:650;letter-spacing:-.01em}
.lya-balance-user{font-size:12px;opacity:.7}
.lya-balance-hint{font-size:12px;opacity:.7;margin:0}
.lya-balance-error{font-size:12px;color:#e88a8a;margin:0}
.lya-balance-actions{display:flex;gap:8px;margin-top:10px}
.lya-balance-actions button{border:1px solid var(--border-weak-base,#26303f);background:transparent;color:inherit;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer}
.lya-balance-actions button.primary{background:#4c8dff;border-color:transparent;color:#fff;font-weight:600}
.lya-balance-actions button:disabled{opacity:.5;cursor:default}
`

export function applyBalanceSection(ctx:Context){
  ctx.effect(()=>ctx.slots.inject("settings.models.header",()=>ctx.slots.register({
    name:"settings.models.header",
    id:"lyapunov-balance",
    order:20,
    locale:"lyapunov",
  },BalanceSection)))
}
