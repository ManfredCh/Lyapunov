import {dirname,join,resolve} from 'node:path'
import {mkdtempSync,readFileSync,rmSync,existsSync,mkdirSync,lstatSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {LEGACY_SDK_BASE_COMMIT,sdkSourceIsFinal,verifySDKSourceIntegrity} from './sdk-source-integrity.mjs'
import {applyLegacyUpstreamPatches,legacyUpstreamPatches} from './upstream-patches.mjs'

const fixtures=new Map()
const git=(cwd,args,env={})=>{
 const result=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:32<<20,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',...env}})
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
 try{git(repository,['cat-file','-e',LEGACY_SDK_BASE_COMMIT+'^{commit}'])}
 catch(error){
  throw Error(`LEGACY_SOURCE_FIXTURE_OBJECTS_MISSING: 本地上游 ${repository} 没有旧提交 ${LEGACY_SDK_BASE_COMMIT}。请设置 LYAPUNOV_LEGACY_SDK=<已验签旧 SDK>，或先运行 node script/legacy-sdk-fixture.mjs --prepare <目标目录> 主动获取公开源码。原始错误：${error instanceof Error?error.message:String(error)}`)
 }
 const dir=mkdtempSync(join(tmpdir(),'lyapunov-legacy-source-only-')),sdk=join(dir,'sdk')
 try{
  git(repository,['clone','--shared','--no-checkout','--quiet',repository,sdk])
  // 本地 clone 可能只带当前分支/tag，旧提交若只由其它远端分支承载会缺席；先从本地来源
  // 显式取一次该提交的完整 tree/blob（纯本地路径，不联网），再移除 origin 并禁掉懒取。
  try{git(sdk,['cat-file','-e',LEGACY_SDK_BASE_COMMIT+'^{tree}'])}
  catch{git(sdk,['-c','uploadpack.allowAnySHA1InWant=true','fetch','--no-tags','--depth=200','origin',LEGACY_SDK_BASE_COMMIT],{GIT_NO_LAZY_FETCH:'0'})}
  // 默认测试只读本机已有对象：不配置 promisor、不保留可 fetch 的 remote，
  // 并在 checkout 前用 GIT_NO_LAZY_FETCH 禁掉原生懒取。缺 blob 时具名失败，不静默联网。
  git(sdk,['config','--remove-section','remote.origin'])
  try{git(sdk,['checkout','--quiet','--detach',LEGACY_SDK_BASE_COMMIT])}
  catch(error){
   throw Error(`LEGACY_SOURCE_FIXTURE_OBJECTS_MISSING: 本地上游缺少 ${LEGACY_SDK_BASE_COMMIT} 的完整 tree/blob。请设置 LYAPUNOV_LEGACY_SDK=<已验签旧 SDK>，或先运行 node script/legacy-sdk-fixture.mjs --prepare <目标目录> 主动获取公开源码。原始错误：${error instanceof Error?error.message:String(error)}`)
  }
  applyLegacyUpstreamPatches(root,sdk)
  const proof=verifySDKSourceIntegrity(root,sdk,patches,true,LEGACY_SDK_BASE_COMMIT)
  if(!sdkSourceIsFinal(proof))throw Error('LEGACY_SOURCE_FIXTURE_NOT_SIGNED_FINAL')
  fixtures.set(root,sdk)
  process.once('exit',()=>rmSync(dir,{recursive:true,force:true}))
  return sdk
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error}
}

const normalizeRepository=value=>value.trim().replace(/\/+$/,'').replace(/\.git$/,'')
const presence=path=>{try{return lstatSync(path)}catch(error){if(error?.code==='ENOENT')return undefined;throw error}}
const verifyPrepared=(root,target,patches)=>{
 const proof=verifySDKSourceIntegrity(root,target,patches,true,LEGACY_SDK_BASE_COMMIT)
 if(!sdkSourceIsFinal(proof))throw Error('LEGACY_SOURCE_FIXTURE_NOT_SIGNED_FINAL')
}
/**
 * 显式准备步骤：需要旧源码对象时才主动从锁文件指定的固定 fork 获取完整 7c3 源码。
 * 7c3 是产品 fork 的 `lyapunov-patched-0.1.6` 分支，不在官方 deepseek-ai 仓库里；
 * 因此来源必须取 `forkSnapshot.repository`，不能从官方仓库 clone 后再假定旧提交存在。
 * 测试默认路径不会调用它；缺对象时 `legacySDKFixture()` 会具名失败并指向这里。
 *
 * 已存在的目标**先验身份/HEAD/完整签名**，只有确实是同一个已验签 fixture 才复用；
 * 不会对任意用户目录先 checkout/patch 再验证。
 */
export function prepareLegacySDKFixture(root, target){
 root=resolve(root)
 target=resolve(target)
 const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8'))
 const repository=lock.forkSnapshot?.repository??lock.repository
 const patches=legacyUpstreamPatches(root)
 const existing=presence(target)
 if(existing){
  try{
   if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('目标不是普通目录')
   const remote=git(target,['remote','get-url','origin'])
   if(normalizeRepository(remote)!==normalizeRepository(repository))throw Error(`来源不匹配：${remote.trim()} != ${repository}`)
   const head=git(target,['rev-parse','HEAD']).trim()
   if(head!==LEGACY_SDK_BASE_COMMIT)throw Error(`HEAD 不是固定旧基线：${head}`)
   verifyPrepared(root,target,patches)
   return target
  }catch(error){
   throw Error(`LEGACY_SOURCE_FIXTURE_TARGET_NOT_REUSABLE: ${target} 已存在，但不是锁文件指定的同一个已验签旧 SDK fixture；未对它做 checkout/patch。请换一个不存在的新目标目录，或设置 LYAPUNOV_LEGACY_SDK 指向已验证 fixture。原始错误：${error instanceof Error?error.message:String(error)}`)
  }
 }
 mkdirSync(dirname(target),{recursive:true})
 // 显式准备允许主动获取公开源码；来源是锁文件里的产品 fork，而不是官方仓库。
 git(dirname(target),['clone','--no-checkout',repository,target],{GIT_NO_LAZY_FETCH:'0'})
 git(target,['checkout','--quiet','--detach',LEGACY_SDK_BASE_COMMIT],{GIT_NO_LAZY_FETCH:'0'})
 applyLegacyUpstreamPatches(root,target)
 verifyPrepared(root,target,patches)
 return target
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const args=process.argv.slice(2)
 if(args[0]!=='--prepare'||!args[1])throw Error('用法：node script/legacy-sdk-fixture.mjs --prepare <目标目录>')
 console.log(prepareLegacySDKFixture(resolve(import.meta.dirname,'..'),args[1]))
}
