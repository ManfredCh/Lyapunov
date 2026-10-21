import {localPolicyFileKind,type LocalPolicyEntry} from '../../policy-registry/src/local-policy-file-contract.ts'
import {policyPanelAction,type PolicyPanelPorts} from './policy-panel-action.ts'
/** 兼容/准备结果所属的真实目标上下文：scene/entity/world/代次/版本/kind/identity。 */
export interface LocalPolicyImportContext {kind:'policy'|'vla';sceneId?:string;entityId?:string;worldId?:string;expectedGeneration?:number;expectedRevision?:number;identity?:{provider:string;modelId:string;revision:string}}
export interface LocalPolicyImportReceipt {filePath:string;face:Awaited<ReturnType<typeof policyPanelAction>>;requestedBundlePath?:string;entry?:LocalPolicyEntry;/** 登记时的兼容目标；缺省视为未知，不得授予兼容或可应用状态。 */context?:LocalPolicyImportContext}
/** 文件/目录登记独立于机器人选择；调用方仅在真实实例仍属于本会话时提供兼容上下文。 */
export async function importLocalPolicy(ports:PolicyPanelPorts,path:string,context:{kind?:'policy'|'vla';identity?:unknown;sceneId?:string;entityId?:string;expectedRevision?:number;worldId?:string;expectedGeneration?:number}):Promise<LocalPolicyImportReceipt>{
 const kind=localPolicyFileKind(path)
 if(!path.trim()||!kind&&/\.json$/i.test(path))throw Error('POLICY_FILE_FORMAT_UNSUPPORTED: 请选择正规bundle.json、支持权重或含bundle.json的完整目录')
 // 未分类路径交给 Host stat 核实目录；普通配置 JSON 仍不被读取。
 const binding=context.sceneId&&context.entityId?context:{kind:context.kind??'policy',...context.identity?{identity:context.identity}:{}}
 const face=await policyPanelAction(ports,'load',{kind:'policy',...binding,...kind==='bundle'?{manifestPath:path}:kind==='weights'?{filePath:path}:{directoryPath:path}})
 const registeredBundle=face.state?.localSource?.bundlePath
 const entry=face.entry
 // 回执固定记录登记时的兼容目标；filePath/entry 可复用，但 face.state 只对该上下文有效。
 const identity=face.identity??context.identity
 const recorded:LocalPolicyImportContext={kind:context.kind??'policy',...context.sceneId?{sceneId:context.sceneId}:{},...context.entityId?{entityId:context.entityId}:{},...context.worldId?{worldId:context.worldId}:{},...context.expectedGeneration!==undefined?{expectedGeneration:context.expectedGeneration}:{},...context.expectedRevision!==undefined?{expectedRevision:context.expectedRevision}:{},...identity?{identity}:{}}
 return {filePath:path,face,context:recorded,...entry?{entry}:{},...kind==='weights'&&typeof registeredBundle==='string'?{requestedBundlePath:registeredBundle}:{}}
}
