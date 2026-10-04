/** Guest 测试通过真实 RC2 Profile、Loader 和 ConfigEditor 持久事务装配。 */
import {Context} from "@deepseek-ai/cordis"
import Loader from "@deepseek-ai/cordis-plugin-loader"
import Include from "@deepseek-ai/cordis-plugin-include"
import {initProfile,mountRootInclude,readProfilePatches,type ProfileContext} from "@deepseek-ai/dsh-app-boot"
import ConfigEditor from "@deepseek-ai/dsh-config-editor"
import Settings from "@deepseek-ai/dsh-settings"
import Llm from "@deepseek-ai/dsh-llm"
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai"
import DefaultModel from "@deepseek-ai/dsh-agent-default-model"
import GuestCredentials from "../src/guest-credentials.ts"
import {mkdir,writeFile} from "node:fs/promises"
import {join} from "node:path"
import {pathToFileURL} from "node:url"

export async function bootGuestFixture(root:string):Promise<Context>{
  const dir=join(root,"profile"),bundle=join(dir,"node_modules","test-guest-bundle")
  initProfile(dir,["test-guest-bundle"])
  await mkdir(bundle,{recursive:true})
  await writeFile(join(root,"package.json"),JSON.stringify({name:"test-guest-installation"}))
  await writeFile(join(bundle,"package.json"),JSON.stringify({name:"test-guest-bundle",version:"1.0.0",dsh:{bundle:{patch:"cordis.patch.yml"}}}))
  await writeFile(join(bundle,"cordis.patch.yml"),JSON.stringify([{insert:[
    {id:"llm",name:"cordis:guest-test-llm"},
    {id:"guest-credentials",name:"cordis:guest-test-credentials",config:{dshHome:root}},
    {id:"llm-pi-ai",name:"cordis:guest-test-pi-ai",config:{providers:{},requireCompositionPolicy:true}},
    {id:"agent-default-model",name:"cordis:guest-test-default-model",config:{initiallyUnconfigured:true,manualOnlyPresentation:"guest"}},
  ]}]))
  await writeFile(join(dir,"cordis.yml"),"[]\n")
  const ctx=new Context()
  try{
    ctx.baseUrl=pathToFileURL(root).href+"/"
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins,{include:Include,"guest-test-llm":Llm,"guest-test-credentials":GuestCredentials,"guest-test-pi-ai":PiAi,"guest-test-default-model":DefaultModel})
    const profile:ProfileContext={name:"test-guest",startedBundles:["test-guest-bundle"],dir,patchPath:join(dir,"cordis.patch.yml"),installAnchor:join(root,"package.json"),cwd:root,home:root,overlays:[],telemetryDisabledEnv:undefined}
    ctx.provide("profileContext",profile)
    await ctx.plugin(ConfigEditor)
    await ctx.plugin(Settings)
    await mountRootInclude(ctx,join(dir,"cordis.yml"),readProfilePatches("test-guest",profile))
    await ctx.loader.await()
    return ctx
  }catch(error){await ctx.fiber.dispose();throw error}
}
