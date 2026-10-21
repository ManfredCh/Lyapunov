import {G1_23_75_MODEL,G1_23_75_REVISION} from '../../policy-registry/src/g1-23-75.ts'
import type {LocalPolicyEntry} from '../../policy-registry/src/local-policy-file-contract.ts'
export interface PolicyPanelPorts {command(name:string,input:Record<string,unknown>):Promise<any>;current?():boolean}
export interface PolicyAppliedBinding {sceneId:string;entityId:string;worldId:string;revision:number;generation:number;identity:{provider:string;modelId:string;revision:string}}
export interface PolicyPanelFace {cancelled?:true;state?:any;failure?:any;result?:any;identity?:any;entry?:LocalPolicyEntry;appliedBinding?:PolicyAppliedBinding}
/** 只接收 activate 的成功绑定证据；兼容/缓存就绪不能冒充已应用。HTTP 的 load_state 不含 world，坐标取真实 activate 回执。 */
export function policyAppliedBinding(result:any,input:Record<string,unknown>):PolicyAppliedBinding|undefined {
 const id=result?.identity,selected=input.identity as any,world=result?.world,snapshot=result?.snapshot,match=result?.match
 if(result?.status!=='ACTIVE_MATCHED'||match?.status!=='MATCHED'||!id||!selected||id.provider!==selected.provider||id.modelId!==selected.modelId||id.revision!==selected.revision)return
 if(typeof input.sceneId!=='string'||typeof input.entityId!=='string'||!world||!snapshot||snapshot.sceneId!==input.sceneId||match.entityId!==input.entityId||match.sceneId!==input.sceneId||world.sceneId!==input.sceneId)return
 if(typeof world.worldId!=='string'||!Number.isInteger(snapshot.revision)||!Number.isInteger(world.worldGeneration)||world.appliedSceneRevision!==snapshot.revision||match.worldId!==world.worldId||match.worldGeneration!==world.worldGeneration||match.sceneRevision!==snapshot.revision)return
 if(match.provider!==id.provider||match.modelId!==id.modelId||(match.resolvedRevision??match.revision)!==id.revision)return
 return {sceneId:input.sceneId as string,entityId:input.entityId,worldId:world.worldId,revision:snapshot.revision,generation:world.worldGeneration,identity:id}
}
export function policyPrepareArgs(input:Record<string,unknown>):Record<string,unknown>{const {filePath,manifestPath,directoryPath,localSource,...context}=input;const identity=input.identity&&typeof input.identity==='object'?input.identity as Record<string,unknown>:{provider:input.provider,modelId:input.modelId,revision:input.revision};const source=localSource&&typeof localSource==='object'?localSource as {prepareFrom?:string}:undefined;const localG1=identity.provider==='github'&&identity.modelId===G1_23_75_MODEL&&identity.revision===G1_23_75_REVISION;return {...context,...identity,...!input.entryId&&typeof filePath==='string'&&filePath.trim()&&source?.prepareFrom!=='cache'&&localG1?{weightsPath:filePath.trim()}:{}}}
/** 与UI共用的动作链：完整包安装不等于准备或运动；BLOCKED立即结束，不自动搜索重试。 */
export async function policyPanelAction(ports:PolicyPanelPorts,action:'check'|'load'|'download'|'asset'|'prepare'|'activate',input:Record<string,unknown>):Promise<PolicyPanelFace>{
 const current=()=>ports.current?.()!==false
 if(!current())return {cancelled:true as const}
 if(action==='check'){const state=await ports.command('policy_load_state',input);return current()?{state,...state.localEntry?{entry:state.localEntry}:{},...state.localSource?.identity?{identity:state.localSource.identity}:{}}:{cancelled:true as const}}
 const result=await ports.command(action==='load'?'policy_load_local':action==='download'||action==='asset'?'policy_download_bundle':action==='activate'?'policy_activate':'policy_prepare',action==='prepare'?policyPrepareArgs(input):action==='asset'?{...input,pieces:['asset']}:input)
 if(!current())return {cancelled:true as const}
 if(result?.status==='BLOCKED')return {failure:result}
 if(action==='asset'&&result?.status==='ASSET_DOWNLOADED')return {result}
 if(result?.category){const identity=result.localEntry?.identity??result.localSource?.identity;return {state:result,...identity?{identity}:{},...result.localEntry?{entry:result.localEntry}:{}}}
 const declared=input.identity??(typeof input.provider==='string'&&typeof input.modelId==='string'?{provider:input.provider,modelId:input.modelId,...typeof input.revision==='string'?{revision:input.revision}:{}}:undefined)
 const identity=result?.identity??(result?.source?{provider:result.source.provider,modelId:result.source.modelId,revision:result.source.resolvedRevision}:declared)
 let state
 const {filePath,manifestPath,directoryPath,weightsPath,...entryContext}=input
 // Apply 自己会提交新 Scene 版本并重建 world：回读必须用**结果里的**新 scene/world/generation，
 // 否则旧 expectedRevision 会把刚成功的绑定读成失配；切目标由面板实例身份作废，不靠旧 revision 兜。
 const binding=result?.snapshot&&result?.world?{sceneId:result.snapshot.sceneId,expectedRevision:result.snapshot.revision,worldId:result.world.worldId,expectedGeneration:result.world.worldGeneration}:result?.world?{worldId:result.world.worldId,expectedGeneration:result.world.worldGeneration}:{}
 try{state=await ports.command('policy_load_state',{...(result.localEntry?{...entryContext,entryId:result.localEntry.id}:input),...binding,...identity?{identity}:{}})}
 catch(error){if(!current())return {cancelled:true};if(action!=='load'||!result.localEntry)throw error;const message=error instanceof Error?error.message:String(error);return {result,identity,entry:result.localEntry,failure:{status:'BLOCKED',code:message.match(/^(POLICY_[A-Z0-9_]+)(?=:|$)/)?.[1]??'POLICY_COMPATIBILITY_CHECK_FAILED',message:'Policy registered; the current-instance compatibility check did not finish: '+message}}}
 const appliedBinding=action==='activate'?policyAppliedBinding(result,input):undefined
 const activationFailure=action==='activate'&&!appliedBinding?{status:'BLOCKED',code:'POLICY_ACTIVATION_UNCONFIRMED',message:'The returned policy binding did not confirm application to this instance.'}:undefined
 return current()?{result,identity,...result.localEntry?{entry:result.localEntry}:{},...appliedBinding?{appliedBinding}:{},...activationFailure?{failure:activationFailure}:{},state:result.localSource?{...state,localSource:result.localSource}:state}:{cancelled:true as const}
}
