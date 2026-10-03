import {localPolicyFileKind} from '../../policy-registry/src/local-policy-file-contract.ts'
import {policyPanelAction,type PolicyPanelPorts} from './policy-panel-action.ts'
export interface LocalPolicyImportReceipt {filePath:string;face:Awaited<ReturnType<typeof policyPanelAction>>;requestedBundlePath?:string}
/** 选择/路径/drop共用同一已选实例读取链；调用方负责确认该实体仍是本会话的真实机器人。 */
export async function importLocalPolicy(ports:PolicyPanelPorts,path:string,context:{kind?:'policy'|'vla';identity?:unknown;sceneId?:string;entityId?:string;expectedRevision?:number;worldId?:string;expectedGeneration?:number}):Promise<LocalPolicyImportReceipt>{
 const kind=localPolicyFileKind(path)
 if(!kind)throw Error('POLICY_FILE_FORMAT_UNSUPPORTED: 请选择正规bundle.json或已支持权重')
 if(!context.sceneId||!context.entityId)throw Error('POLICY_ROBOT_SELECTION_REQUIRED: 请先选择当前场景的真实机器人实例')
 const face=await policyPanelAction(ports,'load',{kind:'policy',...context,...kind==='bundle'?{manifestPath:path}:{filePath:path}})
 const registeredBundle=face.state?.localSource?.bundlePath
 return {filePath:path,face,...kind==='weights'&&typeof registeredBundle==='string'?{requestedBundlePath:registeredBundle}:{}}
}
