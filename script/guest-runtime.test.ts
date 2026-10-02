import {expect,test} from "bun:test"
import {mkdtemp,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {runtimePaths} from "../packages/lyapunov-product-bundle/src/runtime-paths.ts"
import {backendEnvironment} from "./profile.ts"
import {runtimePluginInsert} from "./runtime-patch.ts"
import {guestModelRows} from "../packages/lyapunov-product-bundle/src/guest-runtime.ts"
import {applyEntryPatches} from "@deepseek-ai/cordis-plugin-include"

test("guest 与 formal/developer 有真实独立路径，拒绝账号伪装",()=>{
  const root=join(tmpdir(),"guest-path-fixture"),guest=runtimePaths({root,mode:"guest"}),formal=runtimePaths({root,mode:"formal",accountId:"fixture"})
  expect(guest.root).toBe(join(root,"guest"));expect(guest.identity).toBe("guest")
  expect(guest.dshHome).not.toBe(formal.dshHome);expect(guest.workspaceRoot).not.toBe(formal.workspaceRoot)
  expect(()=>runtimePaths({root,mode:"guest",accountId:"fixture"})).toThrow("GUEST_ACCOUNT_FORBIDDEN")
})
test("guest 环境不搬模型Key、账户、启动hook，HOME与env文件策略来自同身份",async()=>{
  const root=await mkdtemp(join(tmpdir(),"lyapunov-guest-env-"))
  try{
    const paths=runtimePaths({root,mode:"guest"}),env=await backendEnvironment("guest",paths,{parent:{PATH:"/fixture/bin",HOME:"/foreign/home",DEEPSEEK_API_KEY:"fixture-only",LYAPUNOV_ACCOUNT_TOKEN:"fixture-only",OPENROUTER_API_KEY:"fixture-only",NODE_OPTIONS:"--import foreign-hook",DSH_HOME:"/foreign/dsh"}})
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();expect(env.OPENROUTER_API_KEY).toBeUndefined();expect(env.LYAPUNOV_ACCOUNT_TOKEN).toBeUndefined();expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.HOME).toBe(join(paths.root,"private"));expect(env.USERPROFILE).toBe(env.HOME)
    expect(env.DSH_HOME).toBe(paths.dshHome);expect(env.DSH_ENV_FILES).toBe("disabled");expect(env.DSH_PERMISSION_MODE).toBe("workspace-write");expect(env.HF_ENDPOINT).toBe("https://hf-mirror.com")
  }finally{await rm(root,{recursive:true,force:true})}
})
test("guest 装配本地owner，中央生成分享与隐藏模型provider不装配",()=>{
  const rows=runtimePluginInsert({mode:"guest",surface:"web",sceneRoot:"/fixture/guest",engine:"none",grasp:"none"}),names=rows.map(row=>row.id)
  expect(names).toContain("lyapunov-scene-kit");expect(names).toContain("lyapunov-shell");expect(names).toContain("lyapunov-desktop-lifecycle")
  for(const name of ["lyapunov-lyapunov-api-client","lyapunov-lyapunov-share","lyapunov-generate-image","lyapunov-generate-tripo","lyapunov-generate-hunyuan","lyapunov-generate-marble"]){expect(names).not.toContain(name)}
  expect(guestModelRows("/fixture/guest/dsh")).toContainEqual({id:"agent-default-model",config:{initiallyUnconfigured:true,manualOnlyPresentation:"guest"}})
  expect(guestModelRows("/fixture/guest/dsh")).toContainEqual({id:"llm-pi-ai",disabled:false,config:{providers:{},requireCompositionPolicy:true}})
  expect(rows.find(row=>row.id==="lyapunov-policy-registry")?.config?.guest).toBe(true)
  expect(rows.find(row=>row.id==="lyapunov-lyapunov-mcp-extras")?.config?.guest).toBe(true)
})
test("guest 使用原生 include 替换唯一 credential owner并开启空自有provider及Models",()=>{
  const warnings:string[]=[]
  const baseline=[{id:"settings",name:"@deepseek-ai/dsh-settings-file"},{id:"credentials",name:"@deepseek-ai/dsh-credentials-local"},...["agent-default-model","llm-deepseek","llm-pi-ai","web-search-deepseek","session-title-llm","ui-settings-models"].map(id=>({id,name:id,disabled:true}))]
  const effective=applyEntryPatches(baseline,guestModelRows("/fixture/guest/dsh"),message=>warnings.push(message))
  expect(warnings).toEqual([])
  expect(effective.find(row=>row.id==="credentials")?.disabled).toBe(true)
  expect(effective.filter(row=>!row.disabled).map(row=>row.name)).toEqual(["@deepseek-ai/dsh-settings-file","llm-pi-ai","ui-settings-models","@lyapunov/desktop/guest-credentials"])
})
