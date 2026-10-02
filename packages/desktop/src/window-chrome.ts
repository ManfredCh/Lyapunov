/** SDK 继续持有会话标题；桌面只正规化最终窗口品牌，不改会话或页面内容。 */
export function desktopWindowTitle(pageTitle:string):string {
 const match=pageTitle.trim().match(/^(.*?)\s+—\s+(?:Lyapunov|DeepSeek Harness|DSH(?: Local Build|\s*本地构建))$/i)
 const session=match?.[1]?.replace(/\s+/g,' ').trim()
 return session?`${session} — Lyapunov`:'Lyapunov'
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
