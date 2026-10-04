import {expect,test} from "bun:test"
import {Context} from "@deepseek-ai/cordis"
import Llm,{BlockAssembler,createUserMessage} from "@deepseek-ai/dsh-llm"
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai"
import {credentialRef} from "@deepseek-ai/dsh-credentials"
import {mkdtemp,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createServer} from "node:http"
import {guestFetch,guestServiceBoundary} from "../src/guest-services.ts"
import {bootGuestFixture as boot} from "./guest-loader-fixture.ts"
test("guest原生settings/key/default/adapter显式配置→真实localhost模型，不继承ambient或中央metadata",async()=>{
  const root=await mkdtemp(join(tmpdir(),"lyapunov-guest-provider-")),requests:Array<{path:string;authorization?:string}>=[]
  const server=createServer((req,res)=>{req.resume();req.on("end",()=>{requests.push({path:req.url??"",authorization:req.headers.authorization});if(req.url==="/v1/models"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[{id:"fixture-chat"}]}));return}res.writeHead(200,{"content-type":"text/event-stream"});for(const event of [{choices:[{delta:{role:"assistant",content:"guest-local-ok"},index:0,finish_reason:null}]},{choices:[{delta:{},index:0,finish_reason:"stop"}],usage:{prompt_tokens:3,completion_tokens:1}},"[DONE]"])res.write(`data: ${typeof event==="string"?event:JSON.stringify(event)}\n\n`);res.end()})})
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("fixture address")
  const baseURL=`http://127.0.0.1:${address.port}/v1`;let ctx:Context|undefined
  try{
    ctx=await boot(root);expect(ctx.agentDefaultModel.optionalSelection()).toBeUndefined();expect(ctx.llm.listProviders()).toEqual([])
    const profile={api:"openai-completions",apiKeyEnv:"FIXTURE_API_KEY",baseURL,models:[{id:"fixture-chat",contextWindow:8192,maxTokens:1024}]}
    await ctx.settings.update("llm-pi-ai",{providers:{fixture:profile}})
    await ctx.credentials.set(credentialRef("FIXTURE_API_KEY"),"guest-fixture-key")
    const models=await ctx.llm.discoverModels("llm-pi-ai",{provider:"fixture",baseURL,api:"openai-completions"});expect(models[0]?.id).toBe("fixture-chat")
    const selected=await ctx.llm.resolveCallConfig({provider:"fixture",model:"fixture-chat"})
    await ctx.agentDefaultModel.saveSelection(selected)
    expect(ctx.agentDefaultModel.currentSelection()).toMatchObject({provider:"fixture",model:"fixture-chat"})
    const output=new BlockAssembler();for await(const chunk of ctx.llm.stream({provider:"fixture",model:"fixture-chat",messages:[createUserMessage({content:[{type:"text",text:"Return the fixture response."}],source:{kind:"user"}})]}))output.push(chunk)
    expect(output.message({provider:"fixture",model:"fixture-chat"}).content).toEqual([{type:"text",text:"guest-local-ok"}])
    expect(requests.map(row=>row.path)).toEqual(["/v1/models","/v1/chat/completions"]);expect(requests.every(row=>row.authorization==="Bearer guest-fixture-key")).toBe(true)
    const before=requests.length
    for(const url of ["https://vorynel.com/lyaup-unified/v1","https://api.vorynel.com/packs/v1","https://VORYNEL.COM./admin/api"]){
      await expect(ctx.settings.update("llm-pi-ai",{providers:{forbidden:{...profile,apiKeyEnv:"FORBIDDEN_API_KEY",baseURL:url}}})).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
      await expect(ctx.llm.discoverModels("llm-pi-ai",{provider:"forbidden",baseURL:url,api:"openai-completions"})).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
    }
    await expect(ctx.settings.update("llm-pi-ai",{providers:{"lyapunov-plans":{...profile,apiKeyEnv:"LYAPUNOV_ACCOUNT_TOKEN"}}})).rejects.toThrow("GUEST_OWN_PROVIDER_REQUIRED")
    await expect(ctx.settings.update("llm-pi-ai",{providers:{fixture:{...profile,managedBaseURL:baseURL}}})).rejects.toThrow("GUEST_MANAGED_PROVIDER_FORBIDDEN")
    await expect(ctx.settings.update("llm-pi-ai",{providers:{fixture:{...profile,apiKeyEnv:"OPENAI_API_KEY"}}})).rejects.toThrow("GUEST_MODEL_CREDENTIAL_REF_FORBIDDEN")
    expect(requests.length).toBe(before)
    await ctx.fiber.dispose();ctx=await boot(root)
    expect(ctx.agentDefaultModel.currentSelection()).toMatchObject({provider:"fixture",model:"fixture-chat"});expect(ctx.llm.listProviders().map(row=>row.id)).toEqual(["fixture"])
  }finally{await ctx?.fiber.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
})
test("guest fetch gate在首请求/redirect前拒产品server；自有URL可走且formal原fetch不改",async()=>{
  const calls:string[]=[];const mock=(async(input:RequestInfo|URL)=>{const url=input instanceof Request?input.url:String(input);calls.push(url);return url.endsWith("/redirect")?new Response(null,{status:307,headers:{location:"https://vorynel.com/lyaup-unified/v1"}}):Response.json({ok:true})}) as typeof fetch
  const boundary=guestServiceBoundary(),guard=guestFetch(mock,boundary.assertUrl)
  await expect(guard("https://vorynel.com/lyaup-unified/v1")).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN");expect(calls).toEqual([])
  await expect(guard("http://127.0.0.1:49123/redirect")).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN");expect(calls).toEqual(["http://127.0.0.1:49123/redirect"])
  expect((await guard("https://own-provider.example/v1/models")).ok).toBe(true)
  expect((await mock("https://vorynel.com/lyaup-unified/v1")).ok).toBe(true)
})
test("formal原生managed provider/中央credentialRef保持合法，不承接guest策略或fetch",async()=>{
  const before=globalThis.fetch,ctx=new Context()
  try{
    await ctx.plugin(Llm)
    await ctx.plugin(PiAi,{providers:{"lyapunov-plans":{api:"openai-completions",apiKeyEnv:"LYAPUNOV_ACCOUNT_TOKEN",baseURL:"https://vorynel.com/lyaup-unified/v1",managedBaseURL:"https://vorynel.com/lyaup-unified/v1",models:[{id:"peiri",contextWindow:8192,maxTokens:1024}]}}})
    expect(ctx.llm.listProviders().map(row=>row.id)).toEqual(["lyapunov-plans"])
    expect((await ctx.llm.listModels("lyapunov-plans"))[0]?.id).toBe("peiri")
    expect(globalThis.fetch).toBe(before)
  }finally{await ctx.fiber.dispose()}
})
