/** 与中央service-contract version1对应的非秘密公开字段；旧/缺字段保持unknown。 */
export type SearchReadinessReason='not_configured'|'configuration_incomplete'|'pricing_missing'|'billing_unavailable'|'not_assembled'|'source_unverified'
export interface SearchReadiness {ready:boolean;reason:SearchReadinessReason|null;provider:'peiri';protocol:'anthropic-native-v1'|'openai-responses-web-search-v1';basis:'configuration';pricing:({points:number;unit:'points';billing:'per_request'}&Partial<{settlement:'actual_usage';priceVersion:string;minimumMarginBps:number;costBasis:'official-public-upper-bound';providerTariffVerified:boolean}>)|null;sourceCapability?:{verified:boolean;basis:'controlled-native-source-receipt';verifiedAt:string|null}}
export interface CentralDiagnostic {version:1;domain:'account'|'model'|'search'|'generation'|'resource';code:string;stage:string;fieldPath:string|null;retryable:boolean;effect:'none'|'released'|'reserved'|'charged'|'unknown';requestId:string|null;upstreamHttpStatus?:number;upstreamFailureCode?:string}
export const SEARCH_READINESS_REASONS:readonly SearchReadinessReason[]=['not_configured','configuration_incomplete','pricing_missing','billing_unavailable','not_assembled','source_unverified']
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
/** 只接有界完整ISO8601日期/明确时区，不由任意文字Date.parse猜时间；保服务原微秒表示。 */
function sourceReceiptTime(value:unknown):value is string{
 if(typeof value!=='string'||value.length>40)return false
 const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/)
 if(!match)return false
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31]
 const zone=match[8]!
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]!&&Number(match[4])<=23&&Number(match[5])<=59&&Number(match[6])<=59&&(zone==='Z'||Number(zone.slice(1,3))<=23&&Number(zone.slice(4,6))<=59)&&Number.isFinite(Date.parse(value))
}

/** @param value - 已认证/me响应。 @returns 严格能力DTO或未确认。 */
export function searchReadinessFromMe(value:unknown):SearchReadiness|undefined{
 const capabilities=object(object(value).capabilities),row=object(capabilities.search),pricing=object(row.pricing)
 if(capabilities.version!==1||typeof row.ready!=='boolean'||row.provider!=='peiri'||typeof row.protocol!=='string'||!['anthropic-native-v1','openai-responses-web-search-v1'].includes(row.protocol)||row.basis!=='configuration'||!(row.reason===null||SEARCH_READINESS_REASONS.includes(row.reason as SearchReadinessReason)))return undefined
 const price=row.pricing===null?null:typeof pricing.points==='number'&&Number.isSafeInteger(pricing.points)&&pricing.points>0&&pricing.unit==='points'&&pricing.billing==='per_request'?{points:pricing.points,unit:'points' as const,billing:'per_request' as const}:undefined
 if(price===undefined||(row.ready&&(row.reason!==null||price===null))||(!row.ready&&row.reason===null))return undefined
 if(row.protocol==='openai-responses-web-search-v1'&&price!==null){
  if(pricing.settlement!=='actual_usage'||typeof pricing.priceVersion!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(pricing.priceVersion)||typeof pricing.minimumMarginBps!=='number'||!Number.isSafeInteger(pricing.minimumMarginBps)||pricing.minimumMarginBps<2000||pricing.costBasis!=='official-public-upper-bound'||typeof pricing.providerTariffVerified!=='boolean')return undefined
  Object.assign(price,{settlement:'actual_usage',priceVersion:pricing.priceVersion,minimumMarginBps:pricing.minimumMarginBps,costBasis:pricing.costBasis,providerTariffVerified:pricing.providerTariffVerified})
 }
 let sourceCapability:SearchReadiness['sourceCapability']
 if(row.protocol==='openai-responses-web-search-v1'){
  const source=object(row.sourceCapability)
  if(typeof source.verified!=='boolean'||source.basis!=='controlled-native-source-receipt'||!(source.verifiedAt===null||sourceReceiptTime(source.verifiedAt)))return undefined
  if(row.ready&&(!source.verified||source.verifiedAt===null))return undefined
  sourceCapability={verified:source.verified,basis:'controlled-native-source-receipt',verifiedAt:source.verifiedAt as string|null}
 }
 return {ready:row.ready,reason:row.reason as SearchReadinessReason|null,provider:'peiri',protocol:row.protocol as SearchReadiness['protocol'],basis:'configuration',pricing:price,...sourceCapability?{sourceCapability}:{}}
}

/** @param value - 中央错误DTO。 @returns 只含白名单的diagnostic；不保留供应商message/URL/auth。 */
export function centralDiagnostic(value:unknown):CentralDiagnostic|undefined{
 const root=object(value),d=object(root.diagnostic)
 if(d.version!==1||typeof d.domain!=='string'||!['account','model','search','generation','resource'].includes(d.domain)||typeof d.code!=='string'||!/^[A-Za-z0-9_]{1,128}$/.test(d.code)||typeof d.stage!=='string'||!/^[A-Za-z0-9_]{1,128}$/.test(d.stage)||typeof d.retryable!=='boolean'||typeof d.effect!=='string'||!['none','released','reserved','charged','unknown'].includes(d.effect))return undefined
 const fieldPath=d.fieldPath===null?null:typeof d.fieldPath==='string'&&d.fieldPath.length<=128&&/^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(d.fieldPath)?d.fieldPath:undefined
 const requestId=d.requestId===null?null:typeof d.requestId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(d.requestId)&&!/^sk-/i.test(d.requestId)?d.requestId:undefined
 if(fieldPath===undefined||requestId===undefined)return undefined
 const details=object(root.details),status=d.upstreamHttpStatus??root.upstreamHttpStatus??details.upstreamHttpStatus,upstreamCode=d.upstreamFailureCode??root.upstreamFailureCode??details.upstreamFailureCode
 return {version:1,domain:d.domain as CentralDiagnostic['domain'],code:d.code,stage:d.stage,fieldPath,retryable:d.retryable,effect:d.effect as CentralDiagnostic['effect'],requestId,
  ...typeof status==='number'&&Number.isSafeInteger(status)&&status>=100&&status<=599?{upstreamHttpStatus:status}:{},
  ...typeof upstreamCode==='string'&&/^[A-Za-z0-9_]{1,128}$/.test(upstreamCode)?{upstreamFailureCode:upstreamCode}:{}}
}
