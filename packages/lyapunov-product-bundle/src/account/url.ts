/**
 * 正式账户 API 的统一入口（已确认切换并联动官网身份与中央 Credits）。
 * 登录、正式模型 baseURL、余额/账本都复用同一 base URL；显式配置优先，开发默认 127.0.0.1:8787 不变。
 * 注意：已登记的 OAuth 回调仍是服务端的 `/lyaup-api/v1/auth/website/callback`（由服务端配置），
 * 不由本客户端 base URL 推导，不要据此改回调路径。
 */
export const LYAPUNOV_PRODUCTION_API_URL='https://vorynel.com/lyaup-unified'
export function resolveAccountApiUrl(input:{configured?:string;dev:boolean}){
  const configured=input.configured?.trim()
  return configured||(input.dev?'http://127.0.0.1:8787':LYAPUNOV_PRODUCTION_API_URL)
}
