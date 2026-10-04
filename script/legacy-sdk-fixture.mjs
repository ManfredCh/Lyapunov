import {join,resolve} from 'node:path'
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {LEGACY_SDK_BASE_COMMIT,sdkSourceIsFinal,verifySDKSourceIntegrity} from './sdk-source-integrity.mjs'
import {applyLegacyUpstreamPatches,legacyUpstreamPatches} from './upstream-patches.mjs'

const fixtures=new Map()
const git=(cwd,args)=>{
 const result=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:32<<20})
 if(result.status!==0||/(?:^|\n)(?:error|fatal):/.test(result.stderr))throw Error('LEGACY_SOURCE_FIXTURE_GIT_FAILED: '+result.stderr.slice(0,2400))
 return result.stdout
}

/** 只为历史源码断言重建固定7c3+原53项，不安装依赖、不构建或启动旧底座。 */
export function legacySDKFixture(root){
 root=resolve(root)
 const cached=fixtures.get(root)
 if(cached&&existsSync(cached))return cached
 const patches=legacyUpstreamPatches(root)
 if(process.env.LYAPUNOV_LEGACY_SDK){
  const explicit=resolve(process.env.LYAPUNOV_LEGACY_SDK)
  const proof=verifySDKSourceIntegrity(root,explicit,patches,true,LEGACY_SDK_BASE_COMMIT)
  if(!sdkSourceIsFinal(proof))throw Error('LEGACY_SOURCE_FIXTURE_NOT_SIGNED_FINAL')
  fixtures.set(root,explicit);return explicit
 }
 const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
 const repository=join(root,lock.directory)
 // 当前bootstrap/CI保留完整官方对象；缺旧对象明确失败，不借当前工作字节代替。
 git(repository,['cat-file','-e',LEGACY_SDK_BASE_COMMIT+'^{commit}'])
 const dir=mkdtempSync(join(tmpdir(),'lyapunov-legacy-source-only-')),sdk=join(dir,'sdk')
 try{
  git(repository,['clone','--shared','--no-checkout','--quiet',repository,sdk])
  // 源仓可为blob:none；隔离仓按原tree对象从官方补blob，不能把缺件当checkout成功。
  git(sdk,['config','remote.origin.url','https://github.com/deepseek-ai/deepseek-harness.git'])
  git(sdk,['config','remote.origin.promisor','true'])
  git(sdk,['config','remote.origin.partialclonefilter','blob:none'])
  git(sdk,['checkout','--quiet','--detach',LEGACY_SDK_BASE_COMMIT])
  applyLegacyUpstreamPatches(root,sdk)
  const proof=verifySDKSourceIntegrity(root,sdk,patches,true,LEGACY_SDK_BASE_COMMIT)
  if(!sdkSourceIsFinal(proof))throw Error('LEGACY_SOURCE_FIXTURE_NOT_SIGNED_FINAL')
  fixtures.set(root,sdk)
  process.once('exit',()=>rmSync(dir,{recursive:true,force:true}))
  return sdk
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error}
}
