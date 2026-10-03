import {accountLocale,type DesktopLocaleState} from "../../desktop/src/account-locales.ts"
import type {DesktopBridge} from "../../desktop/src/bridge.ts"

type NativeLocale={getSnapshot():{active:string};subscribe(listener:()=>void):()=>void;setLocale(id:string):void}
type NativeLocaleScope={getSnapshot():{status:"loading"|"ready"|"unavailable"};subscribe(listener:()=>void):()=>void}
/** 先等待 DSH 的持久设置读回，再向桌面投影；账户页显式选择只通过原生 setLocale 写入。 */
export function synchronizeDesktopLocale(locale:NativeLocale,scope:NativeLocaleScope,desktop:Pick<DesktopBridge,"uiLocale"|"setUiLocale"|"onUiLocaleChanged">){
 let disposed=false,ready=false,lastRevision=-1,selection:DesktopLocaleState|undefined
 const sync=()=>{
  if(disposed||!selection||scope.getSnapshot().status==="loading")return
  if(!ready){ready=true;if(selection.requested)locale.setLocale(selection.requested)}
  void desktop.setUiLocale(accountLocale(locale.getSnapshot().active)??"en").catch(()=>undefined)
 }
 const accept=(value:DesktopLocaleState)=>{
  if(disposed||value.revision<=lastRevision)return
  lastRevision=value.revision;selection=value
  if(ready&&value.requested){locale.setLocale(value.requested);sync()}
  else if(!ready)sync()
 }
 const unsubscribeLocale=locale.subscribe(sync),unsubscribeScope=scope.subscribe(sync),unsubscribeDesktop=desktop.onUiLocaleChanged(accept)
 void desktop.uiLocale().then(accept).catch(()=>undefined)
 return()=>{disposed=true;unsubscribeLocale();unsubscribeScope();unsubscribeDesktop()}
}
