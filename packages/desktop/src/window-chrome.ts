import {desktopLocales,type AccountLocale} from "./account-locales.ts"
import {isExitSummary} from "./exit-coordinator.ts"
/** SDK 继续持有会话标题；桌面只正规化最终窗口品牌与游客身份，不翻译用户内容。 */
export function desktopWindowTitle(pageTitle:string,locale:AccountLocale="zh",guest=false):string {
 const match=pageTitle.trim().match(/^(.*?)\s+—\s+(?:Lyapunov|DeepSeek Harness|DSH(?: Local Build|\s*本地构建))$/i)
 const session=match?.[1]?.replace(/\s+/g,' ').trim()
 const title=session?`${session} — Lyapunov`:'Lyapunov'
 return guest?`${desktopLocales[locale].guest} · ${title}`:title
}
export function desktopExitDialog(locale:AccountLocale,summary?:{dirtyDrafts:number;runningActions:number}){
 const t=desktopLocales[locale]
 const known=isExitSummary(summary),clean=known&&summary.dirtyDrafts===0
 const detail=clean?(summary.runningActions?t.exitRunningDetail.replace("{runningActions}",String(summary.runningActions)):t.exitCleanDetail):known?t.exitDetail.replace("{dirtyDrafts}",String(summary.dirtyDrafts)).replace("{runningActions}",String(summary.runningActions)):t.exitUnknown
 return {type:"question" as const,title:t.exitTitle,message:clean||!known?t.exitCleanMessage:t.exitMessage,detail,buttons:[t.cancel,clean?t.exit:t.saveAndExit],defaultId:0,cancelId:0,noLink:true}
}

export type DesktopShortcut='undo'|'redo'|'cut'|'copy'|'paste'|'selectAll'|'reload'|'fullscreen'|'close'|'quit'|'devtools'
/** 只处理本窗口原有菜单快捷键；不注册抢占其它应用的全局快捷键。 */
export function desktopShortcut(input:{type:string;key:string;control:boolean;meta:boolean;alt:boolean;shift:boolean;isAutoRepeat?:boolean},developerTools=false):DesktopShortcut|undefined {
 if(input.type!=='keyDown'||input.alt)return
 const key=input.key.toLowerCase(),command=input.control||input.meta
 if(!command)return !input.shift&&key==='f11'&&!input.isAutoRepeat?'fullscreen':!input.shift&&key==='f5'&&!input.isAutoRepeat?'reload':undefined
 if(key==='z')return input.shift?'redo':'undo'
 if(key==='y'&&!input.shift)return 'redo'
 if(input.shift)return key==='i'&&developerTools&&!input.isAutoRepeat?'devtools':undefined
 const action=({x:'cut',c:'copy',v:'paste',a:'selectAll',r:'reload',w:'close',q:'quit'} as const)[key as 'x'|'c'|'v'|'a'|'r'|'w'|'q']
 return input.isAutoRepeat&&['reload','close','quit'].includes(action??'')?undefined:action
}
