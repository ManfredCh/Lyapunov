import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

// Provider 已有这些错误类别。PTC 只把 error.message 交给程序，所以在产品边界将码写进文案；
// 不解析原始异常/URL，不添加网络请求，不更改 provider、权限、取消或 tool-call timeout。
const messages: Readonly<Record<string, string>> = {
  WEB_FETCH_TIMEOUT: 'The public-page fetch timed out without a complete response. Preserve the failure and source identity; do not loop on the same failed address or silently change the file source.',
  WEB_PROVIDER_ERROR: 'The public-page fetch provider failed for an undetermined reason; this does not establish that the file is absent. Preserve source identity and do not repeat the same failed address.',
  WEB_ABORTED: 'The page fetch was cancelled. Do not start a fallback request.',
  WEB_INVALID_URL: 'The URL is invalid. Correct the HTTP(S) URL first.',
  WEB_BLOCKED_URL: 'The public-fetch tool rejected this address. Use an authorized public source; do not bypass permissions or address restrictions through a proxy or mirror.',
  WEB_REDIRECT_BLOCKED: 'The redirect violates public-fetch rules and returned no target content. Check the public final URL for the same official source; do not redirect automatically across sources.',
  WEB_FETCH_TOO_LARGE: 'The response exceeded the page-fetch size limit, so the file is incomplete. Fetch small official metadata first and use Bash to retrieve the known official file URL when needed; truncated text is not a complete artifact.',
  WEB_UNSUPPORTED_CONTENT_TYPE: 'The page-text tool cannot read this content type and returned no usable file. Use Bash to retrieve the known official file URL when needed and preserve source and file identity.',
  WEB_PROVIDER_UNAVAILABLE: 'No local page-fetch provider is available. Check existing provider configuration and runtime dependencies; repeating the same call or inventing a successful download does not resolve this.',
}

/** 保留真实失败和结构化类别，并让模型/PTC 看见同一固定安全文案。 */
export function webFetchFailureResult(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.isError) return result
  const code = result.error.info?.code
  if (typeof code !== 'string' || !Object.hasOwn(messages, code)) return result
  const fallback = ['WEB_FETCH_TIMEOUT', 'WEB_PROVIDER_ERROR', 'WEB_REDIRECT_BLOCKED'].includes(code)
    ? ' When source facts are uncertain, use Browser Use to search and inspect current pages from the same official source. Use web_fetch for a known HTTP(S) page URL; it does not perform keyword search. Use Bash to retrieve a known official file URL when needed.' : ''
  const message = `[${code}] ${messages[code]}${fallback}`
  return {
    ...result,
    error: { ...result.error, message },
    content: [{ type: 'text', text: `Error: ${message}` }, ...result.content.filter(block => block.type !== 'text')],
  }
}

/** 只适配 web_fetch 已分类失败与 web_search provider 选择失败；所有成功、其它工具和未知错误原样交还 SDK。 */
export function applyWebFetchFailureAdapter(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if(exec.name==='web_fetch')return webFetchFailureResult(result)
    if(exec.name!=='web_search'||!result.isError)return result
    const code=result.error.info?.code
    if(typeof code!=='string'||!['WEB_PROVIDER_UNAVAILABLE','WEB_PROVIDER_CONFIGURED_MISSING','WEB_PROVIDER_CONFIGURED_UNAVAILABLE','WEB_PROVIDER_AMBIGUOUS'].includes(code))return result
    const state=code==='WEB_PROVIDER_AMBIGUOUS'?'More than one keyword-search provider is available; select an explicitly configured client provider.':'No usable keyword-search provider is configured for this request.'
    const guidance=`[${code}] ${state} Resolve uncertain source facts by using Browser Use to search and inspect official pages, web_fetch for a known official HTTP(S) URL, or Bash to retrieve a known official file URL when needed. URL fetching does not perform keyword search. Preserve the failure; do not loop on the same query or invent search results.`
    return {...result,error:{...result.error,message:result.error.message+'\n\n'+guidance},content:[...result.content,{type:'text',text:guidance}]}
  })
}
