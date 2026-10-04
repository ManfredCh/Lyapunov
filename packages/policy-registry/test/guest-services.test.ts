import {expect,test} from "bun:test"
import {apply} from "../src/plugin.ts"
import {mkdtemp,writeFile,rm} from "node:fs/promises"
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
test('guest无机器人登记本地策略，重开仍可见，未知权重不借已选固定来源或联网',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lyapunov-guest-local-register-'));let serverCalls=0
 const start=()=>{const tools=new Map<string,any>(),ctx={tools:{register:(tool:any)=>tools.set(tool.name,tool)},commands:{register:()=>{}},jobs:{start:()=>{throw Error('不应创建job')}},reflect:{provide:()=>{}},effect:()=>()=>{},get:()=>undefined};apply(ctx as any,{guest:true,dataDirectory:root,pythonPath:'/not-used',robotDownloadFetcher:async()=>{serverCalls++;throw Error('不应联网')}});return (name:string,input:any)=>tools.get(name).execute({input},{agent:'local-session',signal:new AbortController().signal})}
 try{
  const file=join(root,'own.safetensors'),header=Buffer.from(JSON.stringify({value:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));await writeFile(file,Buffer.concat([size,header,Buffer.alloc(4)]))
  const load=await start()('policy_load_local',{filePath:file,identity:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}})
  expect(load.localEntry.identity).toBeUndefined();expect(load.category).toBe('weights_need_adapter');expect(load.ready).toBe(false);expect(load.policyPrepared).toBe(false)
  expect(load.missing.map((item:any)=>item.field)).toEqual(['adapter','source','observations','actions'])
  const reopen=start(),listing=await reopen('policy_download_sources',{});expect(listing.localEntries).toEqual([load.localEntry])
  const check=await reopen('policy_load_state',{filePath:load.localEntry.filePath,identity:{provider:'github',modelId:'jloganolson/g1_23dof_locomotion_isaac',revision:'fbfa38706b817e2d4b19e444db95ae7fb2537b46'}});expect(check.category).toBe('weights_need_adapter');expect(check.evidence.adapterImplemented).toBe(false)
  await writeFile(file,'bad');const bad=await reopen('policy_load_local',{filePath:file});expect(bad.status).toBe('BLOCKED');expect(bad.code).toBe('POLICY_FILE_FORMAT_INVALID')
  expect((await reopen('policy_download_sources',{})).localEntries).toEqual(listing.localEntries);expect(serverCalls).toBe(0)
 }finally{await rm(root,{recursive:true,force:true})}
})
