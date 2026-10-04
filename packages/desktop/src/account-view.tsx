import {useCallback,useEffect,useRef,useState} from "react"
import {createRoot} from "react-dom/client"
import type {AccountView} from "./account-controller.ts"
import type {DesktopBridge} from "./bridge.ts"
import {formatAccountPointValue,formatAccountPoints,type CreditPlan,type PaymentProvider} from "../../lyapunov-product-bundle/src/account/client.ts"
import {accountLocales,type AccountLocale,type AccountTexts} from "./account-locales.ts"
import {accountIdentity,availablePaymentMethods,commerceErrorMessage,commerceResultIsCurrent,stablePaymentProvider,type CommerceState} from "./account-view-helpers.ts"

const readPreference=(canonicalKey:string,legacyKey:string,valid:(value:string)=>boolean,fallback:string)=>{
  try{
    const canonical=localStorage.getItem(canonicalKey)
    if(canonical!==null)return valid(canonical)?canonical:fallback
    const legacy=localStorage.getItem(legacyKey)
    if(legacy!==null&&valid(legacy)){localStorage.setItem(canonicalKey,legacy);return legacy}
  }catch{}
  return fallback
}
const validLocale=(value:string):value is AccountLocale=>value==="zh"||value==="en"
const validTheme=(value:string):value is "system"|"light"|"dark"=>value==="system"||value==="light"||value==="dark"

function AccountApp({api}:{api:DesktopBridge}){
  const [state,setState]=useState<AccountView>({status:"restoring"})
  const [commerceState,setCommerceState]=useState<CommerceState>({kind:"idle"})
  const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[version,setVersion]=useState("")
  const [locale,setLocale]=useState<AccountLocale>(()=>readPreference("lyapunov-language","lyaup-language",validLocale,navigator.language.startsWith("zh")?"zh":"en") as AccountLocale)
  const [theme,setTheme]=useState<"system"|"light"|"dark">(()=>readPreference("lyapunov-theme","lyaup-theme",validTheme,"system") as "system"|"light"|"dark")
  const t=accountLocales[locale]
  const stateEpoch=useRef(0),commerceEpoch=useRef(0),identityRef=useRef<string>(),readyRef=useRef(false)
  const identity=accountIdentity(state)
  identityRef.current=identity
  readyRef.current=state.status==="ready"

  useEffect(()=>{localStorage.setItem("lyapunov-language",locale);document.documentElement.lang=locale;document.title=locale==="zh"?"Lyapunov 登录":"Lyapunov"},[locale])
  useEffect(()=>{
    let alive=true,lastRevision=-1
    const adopt=(value:Awaited<ReturnType<DesktopBridge["uiLocale"]>>)=>{if(alive&&value.revision>=lastRevision){lastRevision=value.revision;setLocale(value.active)}}
    const unsubscribe=api.onUiLocaleChanged(adopt)
    // 已有账户页语言仅作启动投影；DSH 读取持久选择后会回传覆盖它。
    void api.setUiLocale(locale).then(()=>api.uiLocale()).then(adopt).catch(()=>undefined)
    return()=>{alive=false;unsubscribe()}
  },[api])
  useEffect(()=>{localStorage.setItem("lyapunov-theme",theme);document.documentElement.dataset.theme=theme},[theme])
  useEffect(()=>{
    let alive=true
    const epoch=++stateEpoch.current
    const unsubscribe=api.onAccountChanged(value=>{
      if(!alive)return
      stateEpoch.current++
      const previousIdentity=identityRef.current
      const nextIdentity=accountIdentity(value)
      identityRef.current=nextIdentity
      readyRef.current=value.status==="ready"
      if(previousIdentity!==nextIdentity||value.status!=="ready"){
        commerceEpoch.current++
        setBusy(false);setCommerceState({kind:"idle"})
      }
      setState(value);setError(value.message)
    })
    void api.accountState().then(value=>{
      if(!alive||epoch!==stateEpoch.current)return
      setState(value);setError(value.message)
    }).catch(failure=>{
      if(alive&&epoch===stateEpoch.current)setError(failure instanceof Error?failure.message:String(failure))
    })
    void api.version().then(value=>{if(alive)setVersion(value)}).catch(()=>undefined)
    return()=>{alive=false;stateEpoch.current++;commerceEpoch.current++;unsubscribe()}
  },[api])

  const run=useCallback(async(fn:()=>Promise<unknown>)=>{
    setBusy(true);setError(undefined)
    try{await fn()}catch(failure){setError(failure instanceof Error?failure.message:String(failure))}
    finally{setBusy(false)}
  },[])

  const loadCommerce=useCallback(async()=>{
    const requestedIdentity=identityRef.current
    if(!requestedIdentity||!readyRef.current)return
    const epoch=++commerceEpoch.current
    setBusy(true);setCommerceState({kind:"loading"})
    try{
      const refreshed=await api.refresh()
      if(!commerceResultIsCurrent({requestIdentity:requestedIdentity,currentIdentity:identityRef.current,requestEpoch:epoch,currentEpoch:commerceEpoch.current}))return
      const refreshedIdentity=accountIdentity(refreshed)
      if(!refreshedIdentity||refreshedIdentity!==requestedIdentity){
        setState(refreshed);setError(refreshed.message)
        return
      }
      setState(refreshed);setError(refreshed.message)
      const value=await api.commerce()
      if(!commerceResultIsCurrent({requestIdentity:requestedIdentity,currentIdentity:identityRef.current,requestEpoch:epoch,currentEpoch:commerceEpoch.current}))return
      setCommerceState({kind:"ready",data:value})
    }catch(failure){
      if(!commerceResultIsCurrent({requestIdentity:requestedIdentity,currentIdentity:identityRef.current,requestEpoch:epoch,currentEpoch:commerceEpoch.current}))return
      setCommerceState({kind:"error",message:commerceErrorMessage(failure,t.commerceUnavailable)})
    }finally{
      if(epoch===commerceEpoch.current)setBusy(false)
    }
  },[api,t.commerceUnavailable])

  useEffect(()=>{
    identityRef.current=identity
    readyRef.current=state.status==="ready"
    if(state.status==="ready")void loadCommerce()
    else{commerceEpoch.current++;setCommerceState({kind:"idle"})}
  },[state.status,state.user?.id,loadCommerce])

  useEffect(()=>{
    const reconcile=()=>{if(document.visibilityState!=="hidden"&&readyRef.current)void loadCommerce()}
    window.addEventListener("focus",reconcile)
    document.addEventListener("visibilitychange",reconcile)
    return()=>{window.removeEventListener("focus",reconcile);document.removeEventListener("visibilitychange",reconcile)}
  },[loadCommerce])

  const waiting=["restoring","waiting-login","starting","guest-starting"].includes(state.status)
  const messages={restoring:t.restoring,"waiting-login":t.waiting,starting:t.starting,"signed-out":"",error:"",ready:"","guest-starting":t.guestStarting,guest:t.guestLabel}
  const commerce=commerceState.kind==="ready"?commerceState.data:undefined
  const commerceMessage=commerceState.kind==="error"?commerceState.message:undefined
  const authenticated=state.status==="ready"
  const canCancel=["restoring","waiting-login","starting"].includes(state.status)
  const accountMessage=error??state.message
  return <main className={authenticated?"shell account":"shell welcome-stage"}><div className="topbar">{authenticated&&<div className="brand"><span className="mark" aria-hidden="true"><img src="../icons/lyapunov.png" alt=""/></span><span>Lyapunov</span></div>}<div className="preferences"><select aria-label={t.language} value={locale} onChange={event=>{if(validLocale(event.target.value)){setLocale(event.target.value);void api.setUiLocale(event.target.value,true)}}}><option value="zh">中文</option><option value="en">English</option></select><select aria-label={t.theme} value={theme} onChange={event=>{if(validTheme(event.target.value))setTheme(event.target.value)}}><option value="system">{t.system}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select></div></div>
    {!authenticated?<section className="welcome" aria-labelledby="welcome-title"><div className="welcome-panel">
      <div className="welcome-brand"><img src="../icons/lyapunov.png" alt=""/><span>Lyapunov</span></div>
      <h1 id="welcome-title">{t.title}</h1>
      <p className="intro">{t.intro}</p>
      <div className="actions">
        {!state.user&&<button className="primary" disabled={waiting||busy} onClick={()=>void run(api.login)}><span>{t.login}</span><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
        {state.status==="error"&&state.user&&<button className="primary" disabled={busy} onClick={()=>void run(api.restore)}>{t.reconnect}</button>}
        {!waiting&&!state.user&&<p className="sign-in-hint">{t.signInHint}</p>}
        {waiting&&<div className="welcome-status" role="status"><span className="spinner" aria-hidden="true"/><span>{messages[state.status]}</span></div>}
        {accountMessage&&<p role={state.status==="error"?"alert":"status"} className={state.status==="error"?"welcome-message error":"welcome-message"}>{accountMessage}</p>}
        {(canCancel||state.status==="error")&&<div className="recovery-actions">
          {canCancel&&<button className="quiet" onClick={()=>void api.cancelLogin().catch(failure=>setError(failure instanceof Error?failure.message:String(failure)))}>{t.cancel}</button>}
          {state.status==="error"&&!state.user&&<button className="quiet" disabled={busy} onClick={()=>void run(api.restore)}>{t.retry}</button>}
          {state.status==="error"&&<button className="quiet" disabled={busy} onClick={()=>void run(api.returnToLogin)}>{t.backToSignIn}</button>}
        </div>}
        <div className="welcome-divider"><span>{t.or}</span></div>
        <button className="secondary" disabled={busy||state.status==="guest-starting"} onClick={()=>void run(api.guest)}>{t.guest}</button>
        <p className="guest-hint">{t.guestHint}</p>
      </div>
    </div>
    </section>:<>
      <header className="profile"><div><h1>{state.user?.email}</h1><p className="muted">{t.isolation}</p></div><button className="primary" onClick={()=>void run(api.showWorkspace)}>{t.workspace}</button></header>
      <section className="balance"><small>{t.points}</small><div className="balance-grid"><div><span>{t.available}</span><strong>{formatAccountPoints(state.balances,locale)}</strong></div><div><span>{t.reserved}</span><strong>{formatAccountPointValue(state.usage?.reserved,locale)}</strong></div><div><span>{t.used}</span><strong>{state.usageStatus==="syncing"?t.usageSyncing:state.usage?.usedStatus==="available"?formatAccountPointValue(state.usage.used,locale):t.usageUnavailable}</strong></div></div><p className="muted usage-note">{state.usageStatus==="error"?t.usageLedgerUnavailable:state.usageStatus==="balance-unavailable"||state.usage?.usedStatus==="unavailable"?t.usageUnavailable:""}</p><div className="actions"><button className="quiet" disabled={busy} onClick={()=>void loadCommerce()}>{t.refresh}</button><button className="quiet" disabled={busy} onClick={()=>void run(api.switchAccount)}>{t.switchAccount}</button><button className="quiet" disabled={busy} onClick={()=>void run(api.logout)}>{t.logout}</button></div></section>
      <h2>{t.plans}</h2>{commerceState.kind==="loading"||commerceState.kind==="idle"?<p>{t.loadingPlans}</p>:commerceMessage?<p role="status" className="message">{commerceMessage}</p>:<div className="grid">{commerce!.plans.map(plan=><Plan key={plan.id} plan={plan} methods={commerce!.paymentMethods} disabled={busy} t={t} buy={provider=>run(async()=>{await api.createOrder(plan.id,provider);await loadCommerce()})}/>)}</div>}
      <h2>{t.orders}</h2>{commerceState.kind==="loading"||commerceState.kind==="idle"?<p>{t.loadingOrders}</p>:commerceMessage?<p role="status" className="message">{commerceMessage}</p>:commerce!.orders.length?<div className="table-wrap"><table><thead><tr><th>{t.order}</th><th>{t.amount}</th><th>{t.status}</th><th>{t.time}</th></tr></thead><tbody>{commerce!.orders.map(order=><tr key={order.id}><td>{order.name??order.planId}</td><td>¥{(order.amountFen/100).toFixed(2)}</td><td>{t[order.status]}</td><td>{new Date(order.createdAt).toLocaleString(locale)}</td></tr>)}</tbody></table></div>:<p>{t.emptyOrders}</p>}
    </>}
    {authenticated&&accountMessage&&<p role="status" className="message">{accountMessage}</p>}
    <footer className="footer"><span className="muted">Lyapunov {version}</span><button className="quiet" onClick={()=>void run(async()=>{const update=await api.checkUpdates();if(!update.available){setError(update.reason??t.latest);return}if(window.confirm(`${t.versionFound} ${update.version}. ${t.install}`))await api.installUpdate()})}>{t.updates}</button></footer>
  </main>
}

function Plan({plan,methods,disabled,buy,t}:{plan:CreditPlan;methods:Array<{id:PaymentProvider;available:boolean}>;disabled:boolean;buy:(provider:PaymentProvider)=>Promise<unknown>;t:AccountTexts}){
  const available=availablePaymentMethods(methods),[provider,setProvider]=useState<PaymentProvider>()
  const selected=stablePaymentProvider(provider,methods)
  useEffect(()=>setProvider(current=>stablePaymentProvider(current,methods)),[methods])
  return <article className="plan"><h3>{plan.name}</h3><div className="price">¥{(plan.priceFen/100).toFixed(2)}</div><p>{plan.credits.toLocaleString()} {t.credits}</p><select aria-label={t.method} value={selected??""} onChange={event=>{const value=event.target.value as PaymentProvider;if(available.some(method=>method.id===value))setProvider(value)}} disabled={!available.length}>{available.map(method=><option key={method.id} value={method.id}>{t[method.id]}</option>)}</select><button disabled={disabled||!selected} onClick={()=>selected&&void buy(selected)}>{t.checkout}</button></article>
}

const api=window.lyapunovDesktop
if(api)createRoot(document.getElementById("root")!).render(<AccountApp api={api}/>);else {const locale=navigator.language.startsWith("zh")?"zh":"en";document.getElementById("root")!.textContent=accountLocales[locale].bridgeUnavailable}
