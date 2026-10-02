import {expect,test} from "bun:test"
import {apply} from "../src/plugin.ts"
import {mkdtemp,rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
test("guest策略owner拒packs/统一机器人下载/metadata，不创建Job或碰server；本地工具登记保留",async()=>{
  const root=await mkdtemp(join(tmpdir(),"lyapunov-guest-policy-")),tools=new Map<string,any>(),commands=new Map<string,any>(),services=new Map<string,any>();let calls=0,jobs=0
  const ctx={tools:{register:(tool:any)=>tools.set(tool.name,tool)},commands:{register:(command:any)=>commands.set(command.name,command)},jobs:{start:()=>{jobs++;return "fixture-job"},wait:async()=>{},kill:()=>{}},reflect:{provide:(name:string,value:unknown)=>services.set(name,value)},effect:()=>()=>{},get:()=>undefined}
  try{
    apply(ctx as any,{guest:true,dataDirectory:root,packEndpoint:"http://127.0.0.1:1/packs/v1",packFetcher:async()=>{calls++;throw Error("product fetch forbidden")},robotDownloadEndpoint:"http://127.0.0.1:1/robot-downloads",robotDownloadFetcher:async()=>{calls++;throw Error("product fetch forbidden")}})
    const exec={agent:"fixture-session",signal:new AbortController().signal},call=(name:string,input:any)=>tools.get(name).execute({input},exec)
    await expect(call("policy_search",{provider:"packs",query:"go2"})).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
    await expect(call("policy_metadata",{provider:"packs",modelId:"packs/unitree_go2"})).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
    await expect(call("policy_download",{provider:"packs",modelId:"packs/unitree_go2",background:true})).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
    expect(await call("policy_download_bundle",{modelId:"unitree_go2"})).toMatchObject({status:"BLOCKED",code:"GUEST_PRODUCT_SERVICE_FORBIDDEN",ready:false})
    expect(await services.get("policyModels").list(exec.signal)).toMatchObject({status:"UNREACHABLE",code:"GUEST_PRODUCT_SERVICE_FORBIDDEN",routes:[]})
    for(const name of ["policy_load_local","policy_load_state","policy_prepare","policy_activate","policy_verify","policy_files"]){expect(tools.has(name)).toBe(true);expect(commands.has(name)).toBe(true)}
    expect({calls,jobs}).toEqual({calls:0,jobs:0})
  }finally{await rm(root,{recursive:true,force:true})}
})
