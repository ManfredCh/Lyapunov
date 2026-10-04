import {localPolicyFileKind,type LocalPolicyLibraryEntry} from '../../policy-registry/src/local-policy-file-contract.ts'
import {policyPanelAction,type PolicyPanelPorts} from './policy-panel-action.ts'
export interface LocalPolicyImportReceipt {filePath:string;face:Awaited<ReturnType<typeof policyPanelAction>>;requestedBundlePath?:string;entry?:LocalPolicyLibraryEntry}
/** 文件/目录登记独立于机器人选择；调用方仅在真实实例仍属于本会话时提供兼容上下文。 */
export async function importLocalPolicy(ports:PolicyPanelPorts,path:string,context:{kind?:'policy'|'vla';identity?:unknown;sceneId?:string;entityId?:string;expectedRevision?:number;worldId?:string;expectedGeneration?:number}):Promise<LocalPolicyImportReceipt>{
 const kind=localPolicyFileKind(path)
 if(!path.trim()||!kind&&/\.json$/i.test(path))throw Error('POLICY_FILE_FORMAT_UNSUPPORTED: 请选择正规bundle.json、支持权重或含bundle.json的完整目录')
 // 未分类路径交给 Host stat 核实目录；普通配置 JSON 仍不被读取。
 const binding=context.sceneId&&context.entityId?context:{kind:context.kind??'policy',...context.identity?{identity:context.identity}:{}}
 const face=await policyPanelAction(ports,'load',{kind:'policy',...binding,...kind==='bundle'?{manifestPath:path}:kind==='weights'?{filePath:path}:{directoryPath:path}})
 const registeredBundle=face.state?.localSource?.bundlePath
 const entry=face.entry as LocalPolicyLibraryEntry|undefined
 return {filePath:entry?.filePath??path,face,...entry?{entry}:{},...kind==='weights'&&typeof registeredBundle==='string'?{requestedBundlePath:registeredBundle}:{}}
}
