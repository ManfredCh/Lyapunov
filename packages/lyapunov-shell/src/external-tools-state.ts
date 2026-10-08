import type {IntegrationCandidate,IntegrationAssociation,ExternalSkillRow} from './plugin-marketplace.ts'
/** 浏览器只读投影；MCP 连接、配置及作业状态仍归原生 DSH owner。 */
export interface ExternalMcpRow {
 id:string;serverName:string;transport:string;command:string|null;url:string|null;argsCount:number;envNames:string[];headerNames:string[];
 status:'connected'|'unavailable'|'configured';tools:string[];revision:number|null;detail:string|null;enabled?:boolean;currentScope?:boolean;owner?:string;configLocation?:string|null;commandLocation?:string|null;port?:number|null;integration?:'blender'|'unity';modifiedAt?:number|null;canToggle?:boolean;nativeEntryId?:string
}
export interface ExternalToolReading {id:string;installed:boolean|null;detail:string;location?:string;version?:string;adapter:string}
export interface ExternalInstallReading {jobId:string;registryId:string|null;status:string;label:string;progress:string|null;detail:string|null}
export interface ExternalToolsState {capturedAt:number;writable:boolean;software:ExternalToolReading[];mcp:ExternalMcpRow[];blenderSupply:{ready:boolean;command:string;existingCommand:string|null;addon:string;detail:string};installJobs:ExternalInstallReading[];skills?:ExternalSkillRow[];skillsComplete?:boolean;skillsDetail?:string|null;scopeSessionId?:string|null;candidates?:IntegrationCandidate[];associations?:IntegrationAssociation[]}
export interface ExternalMcpInput {serverName:string;transport:'stdio'|'streamable-http'|'sse';command?:string;args?:string[];cwd?:string;url?:string;blenderPort?:number;expectedRevision?:number|null}
