import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,readlinkSync,symlinkSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'"
const desktopString=value=>value.replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll('\r','\\r').replaceAll('\t','\\t')
/** Desktop Entry 1.5 的 string 转义先于 Exec 引号规则。 */
export const desktopExecutable=value=>'"'+value.replace(/[\\"`$]/g,char=>char==='\\'?'\\\\\\\\':'\\\\'+char).replaceAll('%','%%')+'"'
export function installEntries(root,binDirectory,dataHome,desktop=true,platform='linux'){
  if(!['linux','darwin'].includes(platform))throw Error('Unsupported entry platform')
  for(const path of [root,binDirectory,dataHome])if(resolve(path)!==path||/[\n\r\t]/.test(path))throw Error('Installation paths must be normalized absolute paths without control characters')
  // Linux 第三个参数仍是 XDG data home；Darwin 是明确选择的 Applications 目录。
  const launcher=join(binDirectory,'lyapunov'),entry=platform==='darwin'?join(dataHome,'Lyapunov.app'):join(dataHome,'applications/lyapunov-desktop.desktop')
  if(platform==='linux'&&launcher.includes('='))throw Error('The Desktop Entry specification does not allow = in an executable path')
  const marker='# Lyapunov managed launcher root: '+root
  const desktopMarker='X-Lyapunov-Install-Root='+desktopString(root)
  const content=`#!/bin/sh\n${marker}\nexec ${shellQuote(join(root,'current/lyapunov'))} "$@"\n`
  const app=`[Desktop Entry]\nType=Application\nName=Lyapunov\nExec=${desktopExecutable(launcher)}\nIcon=${desktopString(join(root,'current/packages/desktop/icons/lyapunov.png'))}\nStartupWMClass=lyapunov-desktop\nTerminal=false\nCategories=Development;Science;\n${desktopMarker}\n`
  const appTarget=join(root,'current/runtime/electron/Lyapunov.app')
  const rows=[{path:launcher,text:content,marker,mode:0o755},...(desktop?[platform==='darwin'?{path:entry,target:appTarget}:{path:entry,text:app,marker:desktopMarker,mode:0o644}]:[])]
  // Preflight all collisions before writing either artifact; foreign launchers stay intact.
  for(const row of rows){
    if(row.target){
      let present;try{present=lstatSync(row.path)}catch(error){if(error.code!=='ENOENT')throw error}
      if(present&&(!present.isSymbolicLink()||resolve(dirname(row.path),readlinkSync(row.path))!==row.target))throw Error(`Refusing to replace an unmanaged entry: ${row.path}`)
      continue
    }
    if(!existsSync(row.path)){try{lstatSync(row.path);throw Error(`Refusing to replace dangling link: ${row.path}`)}catch(error){if(error.code!=='ENOENT')throw error}continue}
    if(!lstatSync(row.path).isFile()||!readFileSync(row.path,'utf8').split('\n').includes(row.marker))throw Error(`Refusing to replace an unmanaged entry: ${row.path}`)
  }
  for(const row of rows){
    mkdirSync(resolve(row.path,'..'),{recursive:true})
    const pending=row.path+'.install-'+process.pid
    try{if(row.target)symlinkSync(row.target,pending);else writeFileSync(pending,row.text,{flag:'wx',mode:row.mode});renameSync(pending,row.path)}finally{try{unlinkSync(pending)}catch(error){if(error.code!=='ENOENT')throw error}}
  }
  return {launcher,desktopEntry:desktop?entry:null}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [root,binDirectory,dataHome,desktop,platform='linux']=process.argv.slice(2);if(!root||!binDirectory||!dataHome||!['true','false'].includes(desktop))throw Error('Usage: install-entry.mjs ROOT BIN_DIRECTORY DATA_DIRECTORY true|false [linux|darwin]');console.log(JSON.stringify(installEntries(root,binDirectory,dataHome,desktop==='true',platform)))}catch(error){console.error(error.message);process.exitCode=2}
}
