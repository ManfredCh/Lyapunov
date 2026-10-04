import {Context,Service} from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import {credentialKey,CredentialProvider,type CredentialInfo,type CredentialRef,type CredentialKey,type CredentialRecord,type CredentialRecordInfo,type CredentialRecordEntry,type ResolvedCredential} from "@deepseek-ai/dsh-credentials"
import type {} from "@deepseek-ai/dsh-settings"
import type {PiAiCompositionPolicy,ResolvedPiAiProviderProfile,Options as PiAiOptions} from "@deepseek-ai/dsh-llm-pi-ai"
import {withFileLock,writeFileAtomic} from "@deepseek-ai/dsh-atomic-write"
import {mkdir,readFile} from "node:fs/promises"
import {isAbsolute,join} from "node:path"
import {guestFetch,guestServiceBoundary,isOwnProviderRef,isOwnProviderRoute,ownProviderRef} from "./guest-services.ts"
const browserSessionKey=credentialKey("client-connection","browser-session")
interface Config{dshHome:string;productUrls?:string[]}
interface Store{schema:"lyapunov-guest-model-credentials/v1";references:Record<string,string>;records:Record<string,CredentialRecord>}
const empty=():Store=>({schema:"lyapunov-guest-model-credentials/v1",references:{},records:{}})
const validKey=(value:unknown):value is string=>typeof value==="string"&&/^[\x21-\x7e]+$/.test(value)
/** 同一 credentials owner：自有模型Key独立持久化、browser-session授权仅内存，不读取env或旧账户文件。 */
export class GuestCredentials extends CredentialProvider {
  static Config:z<Config>=z.object({dshHome:z.string().required(),productUrls:z.array(z.string())})
  private record?:CredentialRecord
  private store:Store=empty()
  private pending:Promise<void>=Promise.resolve()
  private readonly filename:string
  constructor(ctx:Context,private config:Config){
    super(ctx)
    if(!config?.dshHome||!isAbsolute(config.dshHome))throw new Error("GUEST_CREDENTIAL_STORE_REQUIRED")
    this.filename=join(config.dshHome,"guest-model-credentials.json")
    const boundary=guestServiceBoundary(config.productUrls)
    const assertRoute=(provider:string)=>{if(!isOwnProviderRoute(provider))throw new Error("GUEST_OWN_PROVIDER_REQUIRED: product/managed routes are unavailable in guest")}
    const policy:PiAiCompositionPolicy={
      allowAmbientCredentials:false,
      validateProfiles:providers=>{
        for(const [route,profile] of Object.entries(providers??{})){
          assertRoute(route)
          if(profile.managedBaseURL!==undefined)throw new Error("GUEST_MANAGED_PROVIDER_FORBIDDEN")
          if(profile.apiKeyEnv!==undefined&&(profile.apiKeyEnv!==ownProviderRef(route)||!isOwnProviderRef(profile.apiKeyEnv)))throw new Error("GUEST_MODEL_CREDENTIAL_REF_FORBIDDEN")
          if(profile.baseURL!==undefined)boundary.assertUrl(profile.baseURL)
        }
      },
      validateResolved:(profiles:ReadonlyMap<string,ResolvedPiAiProviderProfile>)=>{
        for(const [route,profile] of profiles){assertRoute(route);if(profile.baseURL!==undefined)boundary.assertUrl(profile.baseURL);for(const model of profile.piProvider?.getModels()??[])boundary.assertUrl(model.baseUrl)}
      },
      assertDiscovery:request=>{if(request.provider!==undefined)assertRoute(request.provider);if(request.baseURL!==undefined)boundary.assertUrl(request.baseURL)},
      assertModel:(provider,baseURL)=>{assertRoute(provider);boundary.assertUrl(baseURL)},
    }
    ctx.reflect.provide("llmPiAiPolicy",policy)
    const previous=globalThis.fetch,guard=guestFetch(previous,boundary.assertUrl)
    globalThis.fetch=guard
    ctx.effect(()=>()=>{if(globalThis.fetch===guard)globalThis.fetch=previous})
  }
  async* [Service.init]():AsyncGenerator<()=>void|Promise<void>,void,void>{
    this.store=await this.readStore()
    yield ()=>this.pending
  }
  private profiles(){return (this.ctx.get("settings")?.describe().find(form=>form.ns==="llm-pi-ai")?.value as PiAiOptions|undefined)?.providers??{}}
  private allowsRef(ref:CredentialRef){return isOwnProviderRef(ref)&&Object.entries(this.profiles()).some(([route,p])=>isOwnProviderRoute(route)&&p.apiKeyEnv===ref&&ref===ownProviderRef(route))}
  private allowsRecord(key:CredentialKey){const [scope,route,...rest]=key.split("/");return scope==="llm-pi-ai"&&rest.length===0&&route!==undefined&&isOwnProviderRoute(route)&&Object.hasOwn(this.profiles(),route)}
  private async readStore():Promise<Store>{
    let raw:unknown
    try{raw=JSON.parse(await readFile(this.filename,"utf8"))}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return empty();throw new Error("GUEST_CREDENTIAL_STORE_INVALID")}
    const value=raw as Partial<Store>
    if(value?.schema!=="lyapunov-guest-model-credentials/v1"||!value.references||!value.records||Array.isArray(value.references)||Array.isArray(value.records))throw new Error("GUEST_CREDENTIAL_STORE_INVALID")
    for(const [ref,key] of Object.entries(value.references))if(!isOwnProviderRef(ref)||!validKey(key))throw new Error("GUEST_CREDENTIAL_STORE_INVALID")
    for(const [key,record] of Object.entries(value.records))if(!/^llm-pi-ai\/[a-z][a-z0-9-]*$/.test(key)||!isOwnProviderRoute(key.split("/")[1]!)||record.kind!=="api-key"||!validKey(record.key)||record.env!==undefined)throw new Error("GUEST_CREDENTIAL_STORE_INVALID")
    return structuredClone(value as Store)
  }
  private change<T>(mutate:(store:Store)=>Promise<T>|T):Promise<T>{
    const operation=this.pending.then(async()=>{
      await mkdir(this.config.dshHome,{recursive:true,mode:0o700})
      return withFileLock(this.filename,async()=>{const next=await this.readStore(),result=await mutate(next);await writeFileAtomic(this.filename,JSON.stringify(next),{mode:0o600,dirMode:0o700});this.store=next;return result})
    })
    this.pending=operation.then(()=>{},()=>{})
    return operation
  }
  async resolve(ref:CredentialRef):Promise<ResolvedCredential|undefined>{await this.pending;const value=this.allowsRef(ref)?this.store.references[ref]:undefined;return value===undefined?undefined:{value,source:"guest-model-store"}}
  async describe(ref:CredentialRef):Promise<CredentialInfo>{const value=await this.resolve(ref);return {configured:value!==undefined,...value?{source:value.source}:{},writable:this.allowsRef(ref)}}
  async set(ref:CredentialRef,value:string):Promise<void>{if(!this.allowsRef(ref))throw new Error("GUEST_MODEL_CREDENTIAL_REF_FORBIDDEN");if(!validKey(value))throw new Error("GUEST_MODEL_CREDENTIAL_INVALID");await this.change(store=>{if(!this.allowsRef(ref))throw new Error("GUEST_MODEL_CREDENTIAL_REF_FORBIDDEN");store.references[ref]=value});this.notifyUpdated(ref)}
  async unset(ref:CredentialRef):Promise<void>{if(!this.allowsRef(ref)&&!(isOwnProviderRef(ref)&&Object.hasOwn(this.store.references,ref)))throw new Error("GUEST_MODEL_CREDENTIAL_REF_FORBIDDEN");await this.change(store=>{delete store.references[ref]});this.notifyUpdated(ref)}
  async readRecord(key:CredentialKey):Promise<CredentialRecord|undefined>{await this.pending;const value=key===browserSessionKey?this.record:this.allowsRecord(key)?this.store.records[key]:undefined;return value?structuredClone(value):undefined}
  async describeRecord(key:CredentialKey):Promise<CredentialRecordInfo>{const value=await this.readRecord(key);return {configured:Boolean(value),...value?{kind:value.kind}:{},writable:key===browserSessionKey||this.allowsRecord(key)}}
  async listRecords():Promise<readonly CredentialRecordEntry[]>{await this.pending;return [...this.record?[{key:browserSessionKey,kind:this.record.kind}]:[],...Object.entries(this.store.records).filter(([key])=>this.allowsRecord(key as CredentialKey)).map(([key,record])=>({key:key as CredentialKey,kind:record.kind}))]}
  modifyRecord(key:CredentialKey,mutate:(current:CredentialRecord|undefined)=>Promise<CredentialRecord|undefined>):Promise<CredentialRecord|undefined>{
    if(key!==browserSessionKey&&!this.allowsRecord(key))return Promise.reject(new Error("GUEST_MODEL_CREDENTIAL_RECORD_FORBIDDEN"))
    if(key===browserSessionKey){
      const operation=this.pending.then(async()=>{const next=await mutate(this.record?structuredClone(this.record):undefined);if(next!==undefined){if(next.kind!=="grant")throw new Error("GUEST_BROWSER_SESSION_GRANT_REQUIRED");this.record=structuredClone(next);this.notifyRecordUpdated(key)}return this.record?structuredClone(this.record):undefined})
      this.pending=operation.then(()=>{},()=>{});return operation
    }
    return this.change(async store=>{if(!this.allowsRecord(key))throw new Error("GUEST_MODEL_CREDENTIAL_RECORD_FORBIDDEN");const next=await mutate(store.records[key]?structuredClone(store.records[key]):undefined);if(next!==undefined){if(next.kind!=="api-key"||!validKey(next.key)||next.env!==undefined)throw new Error("GUEST_MODEL_API_KEY_RECORD_REQUIRED");store.records[key]=structuredClone(next)}return store.records[key]?structuredClone(store.records[key]):undefined}).then(result=>{this.notifyRecordUpdated(key);return result})
  }
  async deleteRecord(key:CredentialKey):Promise<void>{if(key===browserSessionKey){await this.pending;this.record=undefined;this.notifyRecordUpdated(key);return}if(!this.allowsRecord(key))throw new Error("GUEST_MODEL_CREDENTIAL_RECORD_FORBIDDEN");await this.change(store=>{delete store.records[key]});this.notifyRecordUpdated(key)}
}
export default GuestCredentials
