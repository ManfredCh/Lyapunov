/** 现认证closure内的免费诊断桥；复用formalGenerationRoute，不输出route或token。 */
import {randomUUID} from 'node:crypto'
import {formalGenerationRoute,type GenerationProduct,type GenerationFetch} from './generation.ts'
import type {PeiriSearchProvider} from './search.ts'
import {centralDiagnostic,type CentralDiagnostic} from './service-contract.ts'
const PRODUCTS:readonly GenerationProduct[]=['marble','hunyuan','tripo','image']
export interface CentralReadOnlyInput {action:'me'|'quote'|'lookup';domain?:'generation'|'model'|'search';product?:GenerationProduct;requestId?:string}
export interface CentralReadOnlyReceipt {version:1;action:string;identityMatch:boolean;canonicalBaseMatch:boolean;pathTemplate:string;status:number|null;publicCode:string;product:GenerationProduct|null;unit:'points'|null;pricing:'configured-fixed'|null;points:number|null;reservationCreated:false;found:boolean|null;search?:ReturnType<PeiriSearchProvider['cachedReadiness']>;operationStatus?:'reserved'|'succeeded'|'failed'|'reconciliation_required'|'reserving'|'searching'|'settling'|'releasing';diagnostic?:CentralDiagnostic}
/** @param options - 既有中央API与当前认证闭包。 @returns 只允许/me/quote/lookup的诊断函数。 */
export function createCentralReadOnlyDiagnostic(options:{apiUrl:string;sessionToken():string|undefined;mode():string|undefined;fetcher?:GenerationFetch;searchProvider?:PeiriSearchProvider}){
 return async(input:CentralReadOnlyInput,signal?:AbortSignal):Promise<CentralReadOnlyReceipt>=>{
  if(!['me','quote','lookup'].includes(input.action))throw Error('INVALID_DIAGNOSTIC_ACTION')
  const product=input.product??'tripo'
  const domain=input.domain??'generation'
  if(!['generation','model','search'].includes(domain))throw Error('INVALID_DIAGNOSTIC_DOMAIN')
  if(input.action==='quote'&&domain!=='generation')throw Error('INVALID_DIAGNOSTIC_ACTION')
  if(!PRODUCTS.includes(product))throw Error('INVALID_GENERATION_PRODUCT')
  if(input.action==='lookup'&&(typeof input.requestId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)||/^sk-/i.test(input.requestId)))throw Error('INVALID_REQUEST_ID')
  if(options.mode()!=='formal'||!options.sessionToken())throw Error('AUTH_REQUIRED: 本地或游客模式不调用中央服务')
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)
  const base=new URL(options.apiUrl),canonicalBaseMatch=base.origin==='https://vorynel.com'&&base.pathname.replace(/\/$/,'')==='/lyaup-unified'
  const pathTemplate=input.action==='me'?'/v1/me':input.action==='quote'?'/v1/generation-quotes/{product}':domain==='generation'?'/v1/generation-requests/{product}/{requestId}':`/v1/${domain}-requests/{requestId}`
  const receipt:CentralReadOnlyReceipt={version:1,action:input.action,identityMatch:false,canonicalBaseMatch,pathTemplate,status:null,publicCode:'CENTRAL_DIAGNOSTIC_UNKNOWN',product:input.action==='me'||domain!=='generation'?null:product,unit:null,pricing:null,points:null,reservationCreated:false,found:null}
  const fetcher:GenerationFetch=async(url,init)=>{
   if(init?.method&&init.method.toUpperCase()!=='GET')throw Error('READ_ONLY_DIAGNOSTIC_REQUIRED')
   const response=await(options.fetcher??fetch)(url,{...init,method:'GET',signal:bounded})
   const path=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).pathname
   if(path.endsWith('/v1/me'))receipt.identityMatch=response.ok
   if((input.action==='me'&&path.endsWith('/v1/me'))||(input.action==='quote'&&path.includes('/generation-quotes/'))||(input.action==='lookup'&&['/generation-requests/','/model-requests/','/search-requests/'].some(prefix=>path.includes(prefix))))receipt.status=response.status
   return response
  }
  try{
   const route=await formalGenerationRoute({mode:'formal',accountApiUrl:options.apiUrl,accountToken:options.sessionToken(),fetcher,signal:bounded},product,input.requestId??'diagnostic-'+randomUUID())
   if(!route)throw Error('AUTH_REQUIRED')
   if(options.sessionToken()!==route.token)throw Error('AUTH_REQUIRED')
   if(input.action==='me'){if(options.searchProvider){await options.searchProvider.refreshReadiness(bounded);receipt.search=options.searchProvider.cachedReadiness()}receipt.publicCode='CENTRAL_IDENTITY_VERIFIED';return receipt}
   if(input.action==='quote'){const value=await route.quote();receipt.identityMatch=true;receipt.unit=value.unit;receipt.pricing=value.pricing;receipt.points=value.points;receipt.publicCode='CENTRAL_GENERATION_QUOTE_READY';return receipt}
   if(domain!=='generation'){
    if(options.sessionToken()!==route.token)throw Error('AUTH_REQUIRED')
    const response=await fetcher(options.apiUrl.replace(/\/$/,'')+`/v1/${domain}-requests/`+encodeURIComponent(input.requestId!),{method:'GET',redirect:'error',headers:{authorization:`Bearer ${route.token}`}})
    const body:unknown=await response.json(),value=body!==null&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:{}
    const diagnostic=centralDiagnostic(value);if(diagnostic)receipt.diagnostic=diagnostic
    if(response.status===404&&value.error===`${domain}_request_not_found`){receipt.found=false;receipt.publicCode=String(value.error);return receipt}
    if(!response.ok){receipt.publicCode=typeof value.error==='string'&&/^[A-Za-z0-9_]{1,128}$/.test(value.error)?value.error:'CENTRAL_RECOVERY_UNAVAILABLE';return receipt}
    const statuses=domain==='model'?['reserved','succeeded','failed','reconciliation_required']:['reserving','searching','settling','releasing','succeeded','failed']
    if(value.requestId!==input.requestId||typeof value.status!=='string'||!statuses.includes(value.status)||!diagnostic||diagnostic.domain!==domain||diagnostic.requestId!==input.requestId||diagnostic.retryable!==false)throw Error('CENTRAL_RECOVERY_INVALID')
    receipt.found=true;receipt.operationStatus=value.status as CentralReadOnlyReceipt['operationStatus'];receipt.publicCode=diagnostic.code;return receipt
   }
   const value=await route.lookup();receipt.identityMatch=true;receipt.found=value!==undefined;receipt.publicCode=value?'CENTRAL_GENERATION_REQUEST_FOUND':'generation_request_not_found';return receipt
  }catch(error){const code=error instanceof Error?error.message.match(/^([A-Z][A-Z0-9_]{2,127})(?::|$)/)?.[1]:undefined;if(code==='AUTH_REQUIRED'||code==='INVALID_ACCOUNT_IDENTITY'||code?.endsWith('_INVALID'))receipt.identityMatch=false;receipt.publicCode=code??(bounded.aborted?'CENTRAL_DIAGNOSTIC_TIMEOUT':'CENTRAL_DIAGNOSTIC_TRANSPORT');return receipt}
 }
}
