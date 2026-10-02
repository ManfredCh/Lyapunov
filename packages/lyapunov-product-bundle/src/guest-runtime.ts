import {join} from "node:path"
import {readRuntimeEnv} from "./runtime-paths.ts"
/** 只读取部署公开服务地址用于拒绝列表，不读账户或模型凭据。 */
export const guestProductServiceUrls=(env:NodeJS.ProcessEnv=process.env)=>[readRuntimeEnv(env,"apiUrl")??"https://vorynel.com/lyaup-unified"]
/** 游客初始空模型；用户显式配置仅在独立原生 settings/credentials owner 中保存。 */
export function guestModelRows(dshHome:string,productUrls:string[]=[]){
  return [
    {id:"settings",config:{path:join(dshHome,"guest-settings.yaml")}},
    {id:"credentials",disabled:true},
    {insert:[{id:"lyapunov-guest-credentials",name:"@lyapunov/desktop/guest-credentials",config:{dshHome,productUrls}}]},
    {id:"agent-default-model",config:{initiallyUnconfigured:true,manualOnlyPresentation:"guest"}},
    {id:"llm-pi-ai",disabled:false,config:{providers:{},requireCompositionPolicy:true}},
    {id:"ui-settings-models",disabled:false},
    ...["llm-deepseek","web-search-deepseek","session-title-llm"].map(id=>({id,disabled:true})),
  ]
}
export const GUEST_CAPABILITIES={manual:true,model:true,ownProvider:true,centralSearch:false,centralGeneration:false,credits:false,cloudResources:false} as const
