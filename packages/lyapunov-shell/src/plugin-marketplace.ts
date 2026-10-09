/** 插件页只投影现有原生 MCP、Skills 与软件发现；不持有第二注册表。 */
import type {ExternalToolsState,ExternalMcpRow} from './external-tools-state.ts'

export interface IntegrationCandidate {id:string;kind:'blender'|'unity'|'computer-use-linux';path:string;source:'explicit'|'PATH'|'product-supply'|'unity-hub';requestedPath?:string;modifiedAt:number|null;executable:boolean;addonPath?:string;addonExists?:boolean;version?:string;packageName?:string;repository?:string;owner?:string;knownPackage?:boolean}
export interface IntegrationAssociation {kind:'blender'|'unity'|'computer-use-linux';status:'associated'|'ambiguous'|'not-configured';serverIds:string[];serverName:string|null;reason:string}
export interface ExternalSkillRow {name:string;description:string;provider:string;source:string;path:string|null;modelInvocable:boolean;userInvocable:boolean;toolVisible:boolean;currentScope:boolean}
export interface MarketplaceEntry {id:string;kind:'mcp'|'skill'|'software';name:string;description:string;installed:boolean|null;enabled:boolean|null;connected:boolean|null;available:boolean|null;source:string|null;location:string|null;server?:ExternalMcpRow;skill?:ExternalSkillRow}

/** 来源只认当前原生 entry 的协议/合法明确命名或实际桥接可执行文件；不从工具广告猜安装。 */
export function integrationAssociations(rows:readonly ExternalMcpRow[]):IntegrationAssociation[]{
 return (['blender','unity','computer-use-linux']as const).map(kind=>{
  const matches=rows.filter(row=>row.integration===kind)
  return {kind,status:matches.length===1?'associated':matches.length>1?'ambiguous':'not-configured',serverIds:matches.map(row=>row.id),serverName:matches.length===1?matches[0]!.serverName:null,reason:matches.length===1?'唯一当前原生 MCP 配置已关联；连接和当前工具另读。 / Associated with the unique native MCP configuration; inspect connection and current tools separately.':matches.length>1?'发现多个原生服务，请选择准确服务；不会猜端口或替换配置。 / Multiple native servers match; choose one rather than guessing or replacing configuration.':'尚无可明确关联的原生服务；配置或选择已有服务。 / No unambiguous native server; configure or select an existing service.'}
 })
}
export function classifyMcpIntegration(row:{serverName:string;command:string|null}):'blender'|'unity'|'computer-use-linux'|undefined{
 const command=(row.command??'').split(/[\\/]/).at(-1)??''
 if(row.serverName==='computer-use-linux'||command==='computer-use-linux')return 'computer-use-linux'
 if(row.serverName==='blender'||['mcp-for-blender','blender-mcp'].includes(command))return 'blender'
 if(row.serverName==='unity'||['unity-mcp','mcp-for-unity','unity-mcp-server'].includes(command))return 'unity'
 return undefined
}

/** 唯一列表是即时读数，不落盘、不替代连接状态/模型权限/技能正文加载。 */
export function marketplaceEntries(state:ExternalToolsState):MarketplaceEntry[]{
 return [
  ...state.mcp.map(server=>({id:'mcp:'+server.id+':'+server.serverName,kind:'mcp' as const,name:server.serverName,description:server.detail??'',installed:null,enabled:server.enabled??null,connected:server.status==='connected',available:server.status==='connected'&&server.enabled!==false&&server.currentScope===true&&server.tools.length>0,source:server.owner??null,location:server.configLocation??null,server})),
  ...(state.skills??[]).map(skill=>({id:'skill:'+skill.provider+':'+skill.name,kind:'skill' as const,name:skill.name,description:skill.description,installed:true,enabled:skill.modelInvocable||skill.userInvocable,connected:null,available:skill.currentScope&&(skill.userInvocable||skill.modelInvocable&&skill.toolVisible),source:skill.provider+' · '+skill.source,location:skill.path,skill})),
  ...state.software.map(software=>({id:'software:'+software.id,kind:'software' as const,name:software.id,description:software.detail,installed:software.installed,enabled:null,connected:null,available:null,source:software.adapter,location:software.location??null})),
 ]
}
export function filterMarketplace(entries:readonly MarketplaceEntry[],query:string,kind:'all'|MarketplaceEntry['kind'],availability:'all'|'available'|'attention'='all'):MarketplaceEntry[]{
 const tokens=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
 return entries.filter(row=>(kind==='all'||row.kind===kind)&&(availability==='all'||availability==='available'&&row.available===true||availability==='attention'&&row.available!==true)&&tokens.every(token=>[row.name,row.description,row.source,row.location,row.server?.command,row.server?.url].filter(Boolean).join(' ').toLocaleLowerCase().includes(token)))
}
