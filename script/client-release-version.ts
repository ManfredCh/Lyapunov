import {mkdtemp,cp,rm,access} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'

// SDK 原客户端由构建元数据注入版本；只在发行 staging 重建消费者，保留原插件与状态 owner。
const clients=['ui-settings-general','ui-settings-account','ui-sidebar'] as const
export async function buildReleaseClientVersions(upstream:string,stage:string,upstreamDirectory:string,version:string){
 if(!version.trim())throw new Error('发行客户端版本为空')
 const temp=await mkdtemp(join(tmpdir(),'lyapunov-release-client-'))
 try{
  for(const name of clients){
   const source=join(upstream,'packages/client',name)
   const target=join(stage,upstreamDirectory,'packages/client',name,'lib/client.js')
   await access(target)
   const output=resolve(temp,name)
   const result=spawnSync('pnpm',['exec','tsdown','--config','tsdown.config.ts','--out-dir',output],{cwd:source,env:{...process.env,DSH_CLIENT_VERSION:version},stdio:'inherit'})
   if(result.error)throw result.error
   if(result.status!==0)throw new Error(`原SDK客户端构建失败：${name}`)
   await cp(join(output,'client.js'),target)
  }
 }finally{await rm(temp,{recursive:true,force:true})}
}
