/** 已安装服务的薄供给叶：只读公开入口，连接仍由原生 MCP owner 管理。 */
import {accessSync,constants,readFileSync,existsSync,realpathSync} from 'node:fs'
import {join,dirname,delimiter} from 'node:path'
import {installedUnityMcpCommand} from './unity-mcp-supply.ts'
import {computerUseLinuxPaths,computerUseLinuxReady,computerUseLinuxVariant} from './computer-use-linux.ts'
import {blenderMcpPaths,blenderMcpLock} from './blender-mcp.ts'
export interface KnownMcpDefault {kind:'blender'|'computer-use-linux'|'unity';command:string;args:string[];env:Record<string,string>;port?:number}
const desktopKeys=['AT_SPI_BUS_ADDRESS','DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','XDG_SESSION_TYPE','XDG_SESSION_DESKTOP','DESKTOP_SESSION','NIRI_SOCKET','SWAYSOCK','HYPRLAND_INSTANCE_SIGNATURE','I3SOCK','YDOTOOL_SOCKET'] as const
function executable(path:string):boolean{try{accessSync(path,constants.X_OK);return true}catch{return false}}
/** 父进程捕获真实用户 HOME，只有计算机服务使用；Host 的身份/配置隔离保持原规则。 */
export function installedKnownMcpDefaults(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):KnownMcpDefault[]{
 const rows:KnownMcpDefault[]=[],home=(platform==='win32'?env.USERPROFILE:env.HOME)?.trim()
 if(platform==='linux'&&home){
  const override=env.COMPUTER_USE_LINUX_BIN?.trim(),variant=computerUseLinuxVariant(env)
  const command=override?(executable(override)?override:undefined):computerUseLinuxReady()?computerUseLinuxPaths(undefined,variant).command:undefined
  if(command){
   const desktop=Object.fromEntries(desktopKeys.filter(key=>env[key]!==undefined).map(key=>[key,env[key]!]))
   rows.push({kind:'computer-use-linux',command,args:['mcp'],env:{...desktop,COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP:env.COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP??'1',...(command===computerUseLinuxPaths().command||command===computerUseLinuxPaths(undefined,'official').command)?{COMPUTER_USE_LINUX_COSMIC_HELPER:join(computerUseLinuxPaths().bin,'computer-use-linux-cosmic'),COMPUTER_USE_LINUX_INDICATOR_BIN:join(computerUseLinuxPaths().bin,'computer-use-linux-indicator')}:{},HOME:home,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME??join(home,'.config'),XDG_CACHE_HOME:env.XDG_CACHE_HOME??join(home,'.cache'),XDG_STATE_HOME:env.XDG_STATE_HOME??join(home,'.local/state'),XDG_DATA_HOME:env.XDG_DATA_HOME??join(home,'.local/share')}})
  }
 }
 const explicit=env.LYAPUNOV_BLENDER_MCP_COMMAND?.trim(),supply=blenderMcpPaths(env).command
 const candidates=(explicit?[explicit]:[supply,...(env.PATH??'').split(delimiter).filter(Boolean).map(dir=>join(dir,'mcp-for-blender')),...home?[join(home,'.local/bin/mcp-for-blender')]:[]]).filter((v):v is string=>!!v)
 const command=candidates.find(path=>{
  if(!executable(path))return false
  if(path===explicit||path===supply)return true
  try{const root=dirname(dirname(realpathSync(path)));return ['3.10','3.11','3.12','3.13','3.14'].some(version=>{const file=join(root,'lib','python'+version,'site-packages','mcp_for_blender-'+blenderMcpLock().version+'.dist-info/METADATA');if(!existsSync(file))return false;const meta=readFileSync(file,'utf8');return /^Name: mcp-for-blender$/m.test(meta)&&meta.includes('\nVersion: '+blenderMcpLock().version+'\n')})}catch{return false}
 })
 const portText=env.LYAPUNOV_BLENDER_MCP_PORT??env.BLENDER_PORT??'9876',port=Number(portText)
 if(command&&/^\d+$/.test(portText)&&Number.isInteger(port)&&port>0&&port<=65535)rows.push({kind:'blender',command,args:[],port,env:{BLENDER_HOST:env.BLENDER_HOST??'127.0.0.1',BLENDER_PORT:String(port),DISABLE_TELEMETRY:'1'}})
 const unityCommand=platform==='linux'&&!env.LYAPUNOV_UNITY_MCP_COMMAND?.trim()&&!env.LYAPUNOV_UNITY_MCP_URL?.trim()?installedUnityMcpCommand(env):undefined
 if(unityCommand&&home)rows.push({kind:'unity',command:unityCommand,args:['--transport','stdio'],env:{UNITY_MCP_STATUS_DIR:env.UNITY_MCP_STATUS_DIR??join(home,'.unity-mcp'),FASTMCP_CHECK_FOR_UPDATES:'off',FASTMCP_SHOW_SERVER_BANNER:'false'}})
 return rows
}
