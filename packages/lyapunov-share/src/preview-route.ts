import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {ShareOperations} from './operations.ts'
import {isShareFetchError} from './fetch.ts'
import {renderSnapshot} from './snapshot.ts'
export const PRIVATE_PREVIEW_PATH='/api/lyapunov/share-preview'
/**
 * 从错误里取**错误码前缀**（`SHARE_XXX: 人话…` 的那个 `SHARE_XXX`）——状态码判据只看这一段。
 *
 * 为什么这不是"另一条消息正则"：旧判据 `/AUTH|ACCOUNT/` 是**在整条消息里搜词**，而这条路由的错误消息
 * 第二行就是上游 URL（`…/ACCOUNT/v1/me`）⇒「上游 503」被抢成 401「要重新登录」，用户动作完全相反。
 * 本函数**只**看第一个冒号之前那一段，并要求它**整段**是 `SHARE_` 开头的全大写下划线码：
 * URL、上游正文、人话一个字都不参与判断；取不到码就返回空串（落默认分支，不改既有语义）。
 */
const errorCode=(error:unknown):string=>{
 const message=error instanceof Error?error.message:typeof error==='string'?error:''
 const cut=message.indexOf(':')
 const head=(cut<0?message:message.slice(0,cut)).trim()
 return /^SHARE_[A-Z0-9_]+$/.test(head)?head:''
}
/**
 * `readPrivatePreview` 这条路径上**能到达**的错误码 → 状态码（逐码给依据；判据是码，不是消息文本）：
 *
 * | 码 | 状态 | 依据 |
 * | --- | --- | --- |
 * | `SHARE_AUTH_REQUIRED` | 401 | RFC 9110 §15.5.1「缺有效凭据」（上游 401/403 也归到这里）——**既有语义，未动** |
 * | `SHARE_ACCOUNT_CHANGED` | 401 | 登录账户与配置的 `accountId` 不符 ⇒ 这份凭据对这个资源无效。旧判据靠 `/ACCOUNT/` 撞上，答案相同；本单把它写成**明码** |
 * | `SHARE_PREVIEW_CHANGED` | 409 | RFC 9110 §15.5.10「请求与资源当前状态冲突」（digest 不匹配）——**既有语义，未动** |
 * | `SHARE_PREVIEW_NOT_FOUND` | 404 | 本地这份预览不在——**既有语义，未动** |
 * | `SHARE_ACCOUNT_INVALID_RESPONSE` | 502 | 上游**答了**（HTTP 200）但正文不是它承诺的 JSON ⇒ RFC 9110 §15.6.3「收到无效应答」。不是 503：这条错误自己判「可否重试：false」（非瞬时）；不是 500：坏的是上一跳，不是本路由的未知条件 |
 * | `SHARE_FETCH_FAILED` | 502 | **兜底行**：取件层只抛有形状的 `ShareFetchError`（走上一支），这一行只为「形状丢了但码还在」兜底 —— 宁可说「上游取件失败」，也绝不说成 404「预览不存在」 |
 * | `SHARE_AUTH_API_HTTPS_REQUIRED` | 500 | 本机配置错（账户 API 必须 https）⇒ RFC 9110 §15.6.1。**不再是 401**：凭据没问题，重新登录修不好它（改前靠 `/AUTH/` 撞成 401） |
 *
 * 认不出的失败（**调用方取消**、未登记的本地码）落 `404` —— 与改前逐字相同，本单不动。
 */
const PREVIEW_STATUS:ReadonlyMap<string,number>=new Map([
 ['SHARE_AUTH_REQUIRED',401],['SHARE_ACCOUNT_CHANGED',401],['SHARE_PREVIEW_CHANGED',409],['SHARE_PREVIEW_NOT_FOUND',404],
 ['SHARE_ACCOUNT_INVALID_RESPONSE',502],['SHARE_FETCH_FAILED',502],['SHARE_AUTH_API_HTTPS_REQUIRED',500],
])
/**
 * 失败 → 状态码。判据是**形状 + 错误码**，不是消息文本，且**顺序不可颠倒**：
 *  1. **形状在前**：`isShareFetchError` 是取件层已有的**结构**判据（跨模块副本也认），它自带的 `retryable`
 *     就是"这次失败能不能靠重试解决"的判定：`true`（上游 5xx/429/408/425 重试到上界、超时、连接被断）
 *     ⇒ **503**「服务暂时不可用」，与报文里那句「可否重试：true」是同一个答案；`false`（redirect 被拒 /
 *     地址畸形这类**非瞬时**取件失败）⇒ **502** —— 不是 503（码自己说不是瞬时），更不是 404「预览不存在」
 *     （本地这份预览可能好好的）。
 *  2. **码在后**：取不到形状时只认 `SHARE_XXX` 前缀（见 `errorCode`），消息其余部分一律不参与。
 *  3. 这一支必须**先于**任何按消息内容做的判断：旧判据在整条消息里搜 `AUTH|ACCOUNT`，诊断消息里带上游
 *     URL 就会被误伤（用例 + 负对照专门钉这一条）。
 */
const previewFailureStatus=(error:unknown):number=>isShareFetchError(error)?(error.retryable?503:502):(PREVIEW_STATUS.get(errorCode(error))??404)
export function registerPrivatePreview(ctx:Context,operations:ShareOperations){
 return ctx.inject(['connection'],host=>{
  host.effect(()=>host.connection.fetch.register({path:PRIVATE_PREVIEW_PATH,methods:['GET','HEAD'],requestBody:'buffered',fetch:async request=>{
   const query=new URL(request.url).searchParams,previewId=query.get('previewId')??'',digest=query.get('digest')??''
   try{
    const {preview,bytes,snapshot,entries}=await operations.readPrivatePreview(previewId,request.signal)
    if(preview.digest!==digest)return Response.json({error:'SHARE_PREVIEW_CHANGED'},{status:409,headers:{'cache-control':'no-store'}})
    const url=(resource:string,path?:string)=>PRIVATE_PREVIEW_PATH+'?'+new URLSearchParams({previewId,digest,resource,...path?{path}:{}})
    const headers:Record<string,string>={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'SAMEORIGIN','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"}
    let body:BodyInit
    if(query.get('resource')==='archive'){body=bytes;headers['content-type']='application/zip';headers['content-disposition']='attachment; filename="dsh-session-export.zip"'}
    else if(query.get('resource')==='asset'){
     const path=query.get('path')??'',asset=snapshot.assets.find(a=>a.path===path)
     if(!asset)return Response.json({error:'SHARE_ASSET_NOT_FOUND'},{status:404,headers:{'cache-control':'no-store'}})
     body=entries[path]!;headers['content-type']=asset.mediaType;headers['content-disposition']=(asset.mediaType.startsWith('image/')?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(asset.name)
    }else if(query.has('resource'))return Response.json({error:'SHARE_RESOURCE_INVALID'},{status:400})
    else{body=renderSnapshot(snapshot,{title:preview.title,preview:true,assetUrl:path=>url('asset',path),archiveUrl:url('archive')});headers['content-type']='text/html; charset=utf-8'}
    return new Response(request.method==='HEAD'?null:body,{headers})
   }catch(error){
    const code=error instanceof Error?error.message:'SHARE_PREVIEW_UNAVAILABLE'
    return Response.json({error:code.startsWith('SHARE_')?code:'SHARE_PREVIEW_UNAVAILABLE'},{status:previewFailureStatus(error),headers:{'cache-control':'no-store'}})
   }
  }}))
 })
}
