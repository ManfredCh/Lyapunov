import {G1_23_75_MODEL,G1_23_75_REVISION} from '../../policy-registry/src/g1-23-75.ts'
import type {LocalPolicyLibraryEntry} from '../../policy-registry/src/local-policy-file-contract.ts'
export interface PolicyPanelPorts {command(name:string,input:Record<string,unknown>):Promise<any>;current?():boolean}
export interface PolicyPanelFace {cancelled?:true;state?:any;failure?:any;result?:any;identity?:any;entry?:LocalPolicyLibraryEntry}
export function policyPrepareArgs(input:Record<string,unknown>){const {filePath,manifestPath,localSource,...context}=input;const identity=input.identity&&typeof input.identity==='object'?input.identity as Record<string,unknown>:{provider:input.provider,modelId:input.modelId,revision:input.revision};const source=localSource&&typeof localSource==='object'?localSource as {prepareFrom?:string}:undefined;const localG1=identity.provider==='github'&&identity.modelId===G1_23_75_MODEL&&identity.revision===G1_23_75_REVISION;return {...context,...identity,...typeof filePath==='string'&&filePath.trim()&&source?.prepareFrom!=='cache'&&localG1?{weightsPath:filePath.trim()}:{}}}
/** 与UI共用的动作链：完整包安装不等于准备或运动；BLOCKED立即结束，不自动搜索重试。 */
export async function policyPanelAction(ports:PolicyPanelPorts,action:'check'|'load'|'download'|'asset'|'prepare'|'activate',input:Record<string,unknown>):Promise<PolicyPanelFace>{
 const current=()=>ports.current?.()!==false
 if(!current())return {cancelled:true as const}
 if(action==='check'){const state=await ports.command('policy_load_state',input);return current()?{state}:{cancelled:true as const}}
 const result=await ports.command(action==='load'?'policy_load_local':action==='download'||action==='asset'?'policy_download_bundle':action==='activate'?'policy_activate':'policy_prepare',action==='prepare'?policyPrepareArgs(input):action==='asset'?{...input,pieces:['asset']}:input)
 if(!current())return {cancelled:true as const}
 if(result?.status==='BLOCKED')return {failure:result}
 if(action==='asset'&&result?.status==='ASSET_DOWNLOADED')return {result}
 if(result?.category)return {state:result,...result.localSource?.identity?{identity:result.localSource.identity}:{},...result.localEntry?{entry:result.localEntry}:{}}
 const declared=input.identity??(typeof input.provider==='string'&&typeof input.modelId==='string'?{provider:input.provider,modelId:input.modelId,...typeof input.revision==='string'?{revision:input.revision}:{}}:undefined)
 const identity=result?.identity??(result?.source?{provider:result.source.provider,modelId:result.source.modelId,revision:result.source.resolvedRevision}:declared)
 let state
 try{state=await ports.command('policy_load_state',{...input,...result.localEntry?.filePath?{filePath:result.localEntry.filePath,manifestPath:undefined,directoryPath:undefined}:{},...identity?{identity}:{},...result.world?{worldId:result.world.worldId,expectedGeneration:result.world.worldGeneration}:{}})}
 catch(error){if(!current())return {cancelled:true};if(action!=='load'||!result.localEntry)throw error;const message=error instanceof Error?error.message:String(error);return {result,identity,entry:result.localEntry,failure:{status:'BLOCKED',code:message.match(/^(POLICY_[A-Z0-9_]+)(?=:|$)/)?.[1]??'POLICY_COMPATIBILITY_CHECK_FAILED',message:'策略已登记；当前实例兼容检查未完成：'+message}}}
 return current()?{result,identity,...result.localEntry?{entry:result.localEntry}:{},state:result.localSource?{...state,localSource:result.localSource}:state}:{cancelled:true as const}
}
