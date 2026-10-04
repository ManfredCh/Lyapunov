import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {
  SDK_BASE_COMMIT,RC2_PRODUCT_PATCH,RC2_INTEGRITY_MANIFEST,sdkFileBytes,
  sdkAffectedPaths,sdkAffectedFingerprint,sdkRegistrySignature,verifySDKSourceIntegrity,
} from './sdk-source-integrity.mjs'
import {applyUpstreamPatches,upstreamPatches} from './upstream-patches.mjs'

const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n')
const git=(sdk,args,allowed=[0])=>{
  const result=spawnSync('git',args,{cwd:sdk,maxBuffer:256*1024*1024})
  if(!allowed.includes(result.status))throw Error('SDK_RC2_GENERATION_GIT_FAILED: '+String(result.stderr))
  return result.stdout
}
const list=bytes=>bytes.toString('utf8').split('\0').filter(Boolean)
const validPath=path=>path.length>0&&!path.startsWith('/')&&!path.split('/').some(part=>part==='..'||part==='.'||part==='')&&!/[\r\n\t"\\]/.test(path)
const write=(file,bytes)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes)}

/** 从固定RC2读取完整源码delta，只在隔离完整checkout验重放；默认不发布任何产品签名。 */
export function generateRC2SdkPatch({root,sdk,publish=false}){
  root=resolve(root);sdk=resolve(sdk)
  const lockFile=join(root,'UPSTREAM_LOCK.json'),lockBytes=readFileSync(lockFile),lock=JSON.parse(lockBytes)
  if(lock.commit!==SDK_BASE_COMMIT||git(sdk,['rev-parse','HEAD']).toString('utf8').trim()!==SDK_BASE_COMMIT)throw Error('SDK_SOURCE_BASE_COMMIT_MISMATCH')
  if(git(sdk,['ls-files','-u','-z']).length!==0)throw Error('SDK_RC2_GENERATION_UNMERGED')
  const tracked=list(git(sdk,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',SDK_BASE_COMMIT]))
  const extra=list(git(sdk,['ls-files','--others','--exclude-per-directory=.gitignore','-z']))
  const paths=[...new Set([...tracked,...extra])].sort()
  if(paths.length===0)throw Error('SDK_RC2_GENERATION_NO_DIFF')
  if(paths.some(path=>!validPath(path)))throw Error('SDK_SOURCE_PATCH_PATH_INVALID')
  const untracked=new Set(extra)
  const patch=Buffer.concat(paths.map(path=>untracked.has(path)
    ?git(sdk,['diff','--no-index','--binary','--full-index','--','/dev/null',path],[1])
    :git(sdk,['diff','--no-ext-diff','--no-textconv','--no-renames','--binary','--full-index',SDK_BASE_COMMIT,'--',path])))
  const finalPostimages=Object.fromEntries(paths.map(path=>{const bytes=sdkFileBytes(sdk,path);return [path,bytes===null?null:digest(bytes)]}))
  const finalHash=sdkAffectedFingerprint(sdk,paths)
  const work=mkdtempSync(join(tmpdir(),'lyapunov-rc2-generation-'))
  try{
    const proofRoot=join(work,'product'),replay=join(work,'sdk')
    write(join(proofRoot,RC2_PRODUCT_PATCH),patch)
    write(join(proofRoot,'UPSTREAM_LOCK.json'),json({...lock,sdkProductPatch:{file:RC2_PRODUCT_PATCH,baseCommit:SDK_BASE_COMMIT,sha256:digest(patch)}}))
    const patches=upstreamPatches(proofRoot)
    if(JSON.stringify(sdkAffectedPaths(patches))!==JSON.stringify(paths))throw Error('SDK_RC2_GENERATION_PATHS_MISMATCH: mode-only/quoted paths require explicit review')
    git(sdk,['clone','--shared','--no-checkout','--quiet','--',sdk,replay])
    git(replay,['checkout','--quiet','--detach',SDK_BASE_COMMIT])
    const baseHash=sdkAffectedFingerprint(replay,paths)
    const signature=sdkRegistrySignature(proofRoot,patches)
    const manifest={version:1,baseCommit:SDK_BASE_COMMIT,registries:{[signature]:{
      affectedPaths:paths,stageHashes:[...new Set([baseHash,finalHash])],finalHash,finalPostimages,
    }}}
    const manifestBytes=json(manifest)
    const nextLock={...lock,
      ...(lock.sdkSourceIntegrity?.baseCommit!==SDK_BASE_COMMIT?{sdkSourceIntegrityLegacy:lock.sdkSourceIntegrity}:{}),
      sdkSourceIntegrity:{file:RC2_INTEGRITY_MANIFEST,baseCommit:SDK_BASE_COMMIT,sha256:digest(manifestBytes)},
      sdkProductPatch:{file:RC2_PRODUCT_PATCH,baseCommit:SDK_BASE_COMMIT,sha256:digest(patch)},
    }
    const nextLockBytes=json(nextLock)
    write(join(proofRoot,RC2_INTEGRITY_MANIFEST),manifestBytes);write(join(proofRoot,'UPSTREAM_LOCK.json'),nextLockBytes)
    verifySDKSourceIntegrity(proofRoot,replay,patches)
    const first=applyUpstreamPatches(proofRoot,replay)
    if(first.length!==1||first[0].status!=='applied')throw Error('SDK_RC2_GENERATION_REPLAY_NOT_APPLIED')
    verifySDKSourceIntegrity(proofRoot,replay,patches,true)
    if(paths.some(path=>{const current=sdkFileBytes(replay,path),expected=sdkFileBytes(sdk,path);return current===null?expected!==null:expected===null||!current.equals(expected)}))throw Error('SDK_RC2_GENERATION_REPLAY_BYTES_MISMATCH')
    const second=applyUpstreamPatches(proofRoot,replay)
    if(second.length!==1||second[0].status!=='already-applied')throw Error('SDK_RC2_GENERATION_NOT_IDEMPOTENT')
    if(!readFileSync(lockFile).equals(lockBytes))throw Error('SDK_RC2_GENERATION_LOCK_MOVED')
    if(sdkAffectedFingerprint(sdk,paths)!==finalHash)throw Error('SDK_RC2_GENERATION_SOURCE_MOVED')
    const currentPaths=[...new Set([...list(git(sdk,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',SDK_BASE_COMMIT])),...list(git(sdk,['ls-files','--others','--exclude-per-directory=.gitignore','-z']))])].sort()
    if(JSON.stringify(currentPaths)!==JSON.stringify(paths))throw Error('SDK_RC2_GENERATION_SOURCE_MOVED')
    if(publish){
      const outputs=[[RC2_PRODUCT_PATCH,patch],[RC2_INTEGRITY_MANIFEST,manifestBytes],['UPSTREAM_LOCK.json',nextLockBytes]]
      const pending=[]
      try{
        for(const [path,bytes] of outputs){const target=join(root,path),temp=target+'.tmp-'+randomUUID();write(temp,bytes);pending.push([temp,target])}
        // 两份artifact先发布，锁签名最后原子替换；中断最多留下拒绝匹配的状态，不能接受旧签名。
        for(const [temp,target] of pending)renameSync(temp,target)
      }finally{for(const [temp] of pending)rmSync(temp,{force:true})}
    }
    return {baseCommit:SDK_BASE_COMMIT,patchFile:RC2_PRODUCT_PATCH,manifestFile:RC2_INTEGRITY_MANIFEST,
      registrySignature:signature,affectedFiles:paths.length,patchSha256:digest(patch),manifestSha256:digest(manifestBytes),
      baseHash,finalHash,published:publish,patch,manifestBytes,lockBytes:nextLockBytes}
  }finally{rmSync(work,{recursive:true,force:true})}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2)
  if(args.includes('--help')){
    process.stdout.write('用法：node script/generate-rc2-sdk-patch.mjs --sdk <固定RC2工作区> [--root <产品根>] [--write]\n默认仅在隔离副本验证并输出摘要；--write只供主控在SDK验收闭合后发布固定补丁、签名manifest与锁字段。\n')
  }else{
    const value=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1]}
    const allowed=new Set(['--sdk','--root','--write'])
    for(let index=0;index<args.length;index++){
      if(!allowed.has(args[index]))throw Error('未知生成参数：'+args[index])
      if(args[index]!=='--write'){if(args[index+1]===undefined||args[index+1].startsWith('--'))throw Error('生成参数缺值：'+args[index]);index++}
    }
    if(!value('--sdk'))throw Error('必须提供 --sdk；不会推断或冻结当前SDK')
    const {patch,manifestBytes,lockBytes,...summary}=generateRC2SdkPatch({
      root:value('--root')??resolve(dirname(fileURLToPath(import.meta.url)),'..'),sdk:value('--sdk'),publish:args.includes('--write'),
    })
    process.stdout.write(JSON.stringify(summary,null,2)+'\n')
  }
}
