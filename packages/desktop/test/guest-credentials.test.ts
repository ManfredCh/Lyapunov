import {expect,test} from "bun:test"
import {Context} from "@deepseek-ai/cordis"
import {credentialRef,credentialKey} from "@deepseek-ai/dsh-credentials"
import SettingsFile from "@deepseek-ai/dsh-settings-file"
import Llm from "@deepseek-ai/dsh-llm"
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai"
import {mkdtemp,rm,writeFile,stat,readFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import GuestCredentials from "../src/guest-credentials.ts"
async function boot(root:string){const ctx=new Context();await ctx.plugin(SettingsFile,{path:join(root,"guest-settings.yaml"),watch:false});await ctx.plugin(GuestCredentials,{dshHome:root});await ctx.plugin(Llm);await ctx.plugin(PiAi,{providers:{}});return ctx}
const profile={api:"openai-completions",apiKeyEnv:"FIXTURE_API_KEY",baseURL:"http://127.0.0.1:9999/v1",models:[{id:"fixture",contextWindow:8192,maxTokens:1024}]}
test("guest原生同owner仅接受已声明ownroute的派生Key，browser授权仍内存",async()=>{
  const root=await mkdtemp(join(tmpdir(),"lyapunov-guest-keys-"));let ctx:Context|undefined
  try{
    await writeFile(join(root,".credentials.yaml"),"DEEPSEEK_API_KEY: inherited-fixture-only\n")
    await writeFile(join(root,"settings.yaml"),"llm-pi-ai:\n  providers:\n    peiri: {}\n")
    ctx=await boot(root)
    const own=credentialRef("FIXTURE_API_KEY"),central=credentialRef("LYAPUNOV_ACCOUNT_TOKEN"),transport=credentialKey("client-connection","browser-session")
    expect(ctx.llm.listProviders()).toEqual([])
    expect(await ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY"))).toBeUndefined()
    await expect(ctx.credentials.set(own,"fixture-key")).rejects.toThrow("REF_FORBIDDEN")
    await ctx.settings.update("llm-pi-ai",{providers:{fixture:profile}})
    await ctx.credentials.set(own,"fixture-key")
    expect((await ctx.credentials.resolve(own))?.value).toBe("fixture-key")
    expect(await ctx.credentials.describe(central)).toEqual({configured:false,writable:false})
    await expect(ctx.credentials.set(central,"fixture-only")).rejects.toThrow("REF_FORBIDDEN")
    let mutations=0
    await expect(ctx.credentials.modifyRecord(credentialKey("billing","account"),async()=>{mutations++;return {kind:"grant",payload:{fixture:true}}})).rejects.toThrow("RECORD_FORBIDDEN")
    expect(mutations).toBe(0)
    const record=credentialKey("llm-pi-ai","fixture")
    await expect(ctx.credentials.modifyRecord(record,async()=>({kind:"grant",payload:{fixture:true}}))).rejects.toThrow("API_KEY_RECORD_REQUIRED")
    await expect(ctx.credentials.modifyRecord(record,async()=>({kind:"api-key",key:"fixture-key",env:{LYAPUNOV_ACCOUNT_TOKEN:"fixture-only"}}))).rejects.toThrow("API_KEY_RECORD_REQUIRED")
    await ctx.credentials.modifyRecord(record,async()=>({kind:"api-key",key:"fixture-record-key"}))
    await ctx.credentials.modifyRecord(transport,async()=>({kind:"grant",payload:{fixture:true}}))
    expect(await ctx.credentials.describeRecord(transport)).toEqual({configured:true,kind:"grant",writable:true})
    const stored=await readFile(join(root,"guest-model-credentials.json"),"utf8")
    expect(stored).not.toContain("client-connection");expect(stored).not.toContain("browser-session")
    expect((await stat(join(root,"guest-model-credentials.json"))).mode&0o777).toBe(0o600)
    await ctx.fiber.dispose();ctx=await boot(root)
    expect((await ctx.credentials.resolve(own))?.value).toBe("fixture-key")
    expect(await ctx.credentials.readRecord(record)).toEqual({kind:"api-key",key:"fixture-record-key"})
    expect(await ctx.credentials.readRecord(transport)).toBeUndefined()
  }finally{await ctx?.fiber.dispose();await rm(root,{recursive:true,force:true})}
})
