export const WORKSPACE_PREFERENCES='lyapunov-workspace'
export const LEGACY_WORKSPACE_PREFERENCES='lyaup-workspace'
export const workspaceActions=['fileOpen','panelClose','terminalToggle','reviewToggle','fileTreeToggle','terminalNew','addSelection','worktreeNew'] as const
export type WorkspaceAction=typeof workspaceActions[number]
export interface WorkspacePreferences{autoSave:boolean;autoSaveDelayMs:number;editorFontFamily:string;editorFontSize:number;terminalFontFamily:string;terminalFontSize:number;shortcuts:Record<WorkspaceAction,string>}
export const workspaceDefaults:WorkspacePreferences={autoSave:true,autoSaveDelayMs:750,editorFontFamily:'',editorFontSize:14,terminalFontFamily:'',terminalFontSize:14,shortcuts:{fileOpen:'mod+k,mod+p',panelClose:'mod+w',terminalToggle:'ctrl+backquote',reviewToggle:'mod+shift+r',fileTreeToggle:'mod+backslash',terminalNew:'ctrl+alt+t',addSelection:'mod+shift+l',worktreeNew:'mod+shift+w'}}
const modifiers=['mod','ctrl','meta','alt','shift']
export function normalizeWorkspaceShortcut(value:string){
 return value.split(',').map(raw=>{if(!raw.trim())return '';const parts=raw.toLowerCase().trim().split('+').map(s=>s.trim()),key=parts.pop()!;if(!key||modifiers.includes(key)||parts.some(p=>!modifiers.includes(p))||new Set(parts).size!==parts.length||!parts.some(p=>['mod','ctrl','meta','alt'].includes(p)))throw new Error('快捷键需要Ctrl、Cmd(mod/meta)或Alt修饰键及一个按键');return [...modifiers.filter(p=>parts.includes(p)),key==='`'?'backquote':key==='\\'?'backslash':key].join('+')}).filter(Boolean).join(',')
}
export function validateWorkspaceShortcuts(value:Record<WorkspaceAction,string>){
 const result=Object.fromEntries(workspaceActions.map(action=>[action,normalizeWorkspaceShortcut(value[action])])) as Record<WorkspaceAction,string>,used=new Set<string>()
 for(const binding of Object.values(result))for(const key of binding.split(',').filter(Boolean)){if(used.has(key))throw new Error('同一快捷键不能分配给多个工作区动作');used.add(key)}
 return result
}
export function matchWorkspaceShortcut(event:{key:string;code?:string;ctrlKey:boolean;metaKey:boolean;altKey:boolean;shiftKey:boolean;repeat?:boolean;isComposing?:boolean;defaultPrevented?:boolean},binding:string,mac:boolean){
 if(event.repeat||event.isComposing||event.defaultPrevented)return false
 return binding.split(',').filter(Boolean).some(binding=>{const parts=binding.split('+'),key=parts.pop()!,ctrl=parts.includes('ctrl')||parts.includes('mod')&&!mac,meta=parts.includes('meta')||parts.includes('mod')&&mac;const actual=event.code==='Backquote'?'backquote':event.code==='Backslash'?'backslash':event.key.toLowerCase();return actual===key&&event.ctrlKey===ctrl&&event.metaKey===meta&&event.shiftKey===parts.includes('shift')&&event.altKey===parts.includes('alt')})
}
export const workspaceFont=(name:string)=>`${name.trim()?JSON.stringify(name.trim())+', ':''}ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
