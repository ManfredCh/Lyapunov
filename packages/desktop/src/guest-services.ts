/** 游客 Host 的产品服务目的地策略；不接管原生 provider、Session 或账户状态。 */
export const GUEST_SERVICE_CODE = "GUEST_PRODUCT_SERVICE_FORBIDDEN"
const reservedRoute = /^(?:lyapunov|lyaup|peiri)(?:[-_]|$)|^packs$/i
export const ownProviderRef=(route:string)=>`${route.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_API_KEY`
export const isOwnProviderRoute=(route:string)=>/^[a-z][a-z0-9-]*$/.test(route)&&!reservedRoute.test(route)
export const isOwnProviderRef=(ref:string)=>/^[A-Z][A-Z0-9_]*_API_KEY$/.test(ref)&&!/^(?:LYAPUNOV|LYAUP|PEIRI|PACK|VORYNEL)(?:_|$)/.test(ref)
export function guestServiceBoundary(productUrls:readonly string[]=[]){
  const declared=new Set(productUrls.map(value=>new URL(value).origin))
  const assertUrl=(value:string|URL)=>{
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,"")
    if(host==="vorynel.com"||host.endsWith(".vorynel.com")||declared.has(url.origin))throw new Error(`${GUEST_SERVICE_CODE}: guest cannot access Lyapunov product servers`)
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password)throw new Error("GUEST_PROVIDER_URL_INVALID: use an explicit HTTP(S) provider URL without embedded credentials")
  }
  return {assertUrl}
}
/** 每跳均先核URL，避免自有provider重定向进入产品服务器；保同Host其它本地网络能力。 */
export function guestFetch(fetcher:typeof fetch,assertUrl:(value:string|URL)=>void):typeof fetch{
  return (async(input:RequestInfo|URL,init?:RequestInit)=>{
    let request=new Request(input,init),hops=0
    const redirect=request.redirect
    for(;;){
      assertUrl(request.url)
      const response=await fetcher(request.clone(),{redirect:redirect==="follow"?"manual":redirect})
      if(redirect!=="follow"||![301,302,303,307,308].includes(response.status))return response
      const location=response.headers.get("location")
      if(location===null)return response
      const next=new URL(location,request.url)
      try{assertUrl(next)}catch(error){await response.body?.cancel();throw error}
      if(++hops>20){await response.body?.cancel();throw new Error("GUEST_REDIRECT_LIMIT")}
      const headers=new Headers(request.headers),different=new URL(request.url).origin!==next.origin
      if(different)for(const key of ["authorization","proxy-authorization","cookie","cookie2"])headers.delete(key)
      const toGet=response.status===303&&request.method!=="GET"&&request.method!=="HEAD"||[301,302].includes(response.status)&&request.method==="POST"
      if(toGet)for(const key of ["content-type","content-length","content-encoding","content-language","content-location"])headers.delete(key)
      const body=toGet||request.body===null?undefined:await request.clone().arrayBuffer()
      await response.body?.cancel()
      request=new Request(next,{method:toGet?"GET":request.method,headers,body,signal:request.signal,redirect,credentials:request.credentials})
    }
  }) as typeof fetch
}
