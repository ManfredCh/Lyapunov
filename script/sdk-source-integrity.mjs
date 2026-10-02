import {readFileSync,lstatSync,readlinkSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,relative} from 'node:path'
import {spawnSync} from 'node:child_process'

export const SDK_BASE_COMMIT='7c3f05885033aa3aed74904d59a94692d12a47f7'
const hash=value=>createHash('sha256').update(value).digest('hex')
const publicPostProofs=new WeakMap()
const finalProofs=new WeakSet()
/** 必须先核完整base、全registry签名与全部affected最终本体，不能用局部hunk推已应用。 */
export function sdkSourceIsFinal(proof){return finalProofs.has(proof)}
/** 只有本模块实际来源验签的不可伪造proof可以授权完整26文件的精确后继。 */
export function sdkPublicPostimageMatches(proof,current,expected){
  return publicPostProofs.get(proof)?.some(image=>JSON.stringify(Object.keys(image).sort())===JSON.stringify(expected)&&expected.every(path=>typeof image[path]==='string'&&/^[a-f0-9]{64}$/.test(image[path])&&current[path]===image[path]))===true
}
const git=(sdk,args)=>{
  const result=spawnSync('git',args,{cwd:sdk,encoding:'utf8',maxBuffer:32*1024*1024})
  if(result.status!==0)throw Error('SDK_SOURCE_GIT_FAILED: '+result.stderr)
  return result.stdout
}
/** symlink按Git存的link文字核，不读取其外部target；不存在仅作为精确null状态。 */
export function sdkFileBytes(sdk,path){
  try{
    const target=join(sdk,path),stat=lstatSync(target)
    if(stat.isSymbolicLink())return Buffer.from(readlinkSync(target))
    if(!stat.isFile())throw Error('SDK_SOURCE_NOT_FILE: '+path)
    return readFileSync(target)
  }catch(error){if(error?.code==='ENOENT')return null;throw error}
}
export function sdkAffectedFingerprint(sdk,paths){
  return hash(JSON.stringify(paths.map(path=>{const bytes=sdkFileBytes(sdk,path);return[path,bytes===null?null:hash(bytes)]})))
}
/** 注册顺序、重复消费者及每份固定patch的完整字节都进入版本签名。 */
export function sdkRegistrySignature(root,patches){
  const companion=file=>{try{return hash(readFileSync(file))}catch(error){if(error?.code==='ENOENT')return null;throw error}}
  return hash(JSON.stringify(patches.map(patch=>({file:relative(root,patch.file).replaceAll('\\','/'),package:patch.package,sha256:hash(readFileSync(patch.file)),manifestSha256:companion(patch.file+'.json'),postimageSha256:companion(patch.file.replace(/\.patch$/,'.postimage.json')),siblingManifestSha256:companion(patch.file.replace(/\.patch$/,'.json')),englishUpgradeSha256:companion(patch.file.replace(/\.patch$/,'.english-upgrade.patch')),englishUpgradeManifestSha256:companion(patch.file.replace(/\.patch$/,'.english-upgrade.json'))}))))
}
export function sdkAffectedPaths(patches){
  const paths=[...new Set(patches.flatMap(patch=>[...readFileSync(patch.file,'utf8').matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)].map(row=>row[1])))].sort()
  if(paths.some(path=>path.startsWith('/')||path.split('/').includes('..')))throw Error('SDK_SOURCE_PATCH_PATH_INVALID')
  return paths
}
/** 固定base逐字节、已签全序合法完整stage、unknown新增与缺件均在写入前检查。 */
export function verifySDKSourceIntegrity(root,sdk,patches,final=false){
  const lock=JSON.parse(readFileSync(join(root,'UPSTREAM_LOCK.json'),'utf8')).sdkSourceIntegrity
  if(!lock||lock.file!=='script/sdk-source-integrity.json'||lock.baseCommit!==SDK_BASE_COMMIT)throw Error('SDK_SOURCE_INTEGRITY_REQUIRED')
  const bytes=readFileSync(join(root,lock.file))
  if(hash(bytes)!==lock.sha256)throw Error('SDK_SOURCE_INTEGRITY_SIGNATURE_INVALID')
  const manifest=JSON.parse(bytes),signature=sdkRegistrySignature(root,patches),entry=manifest.registries?.[signature]
  if(manifest.version!==1||manifest.baseCommit!==SDK_BASE_COMMIT||!entry)throw Error('SDK_SOURCE_REGISTRY_UNSIGNED')
  const affected=sdkAffectedPaths(patches)
  if(JSON.stringify(affected)!==JSON.stringify(entry.affectedPaths)||!Array.isArray(entry.stageHashes)||entry.stageHashes.length===0||entry.stageHashes.some(sha=>typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))||typeof entry.finalHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.finalHash))throw Error('SDK_SOURCE_STAGES_INVALID')
  if(JSON.stringify(Object.keys(entry.finalPostimages??{}).sort())!==JSON.stringify(affected)||affected.some(path=>!(entry.finalPostimages[path]===null||typeof entry.finalPostimages[path]==='string'&&/^[a-f0-9]{64}$/.test(entry.finalPostimages[path])))||hash(JSON.stringify(affected.map(path=>[path,entry.finalPostimages[path]])))!==entry.finalHash)throw Error('SDK_SOURCE_FINAL_IMAGES_INVALID')
  if(git(sdk,['rev-parse','HEAD']).trim()!==SDK_BASE_COMMIT)throw Error('SDK_SOURCE_BASE_COMMIT_MISMATCH')
  const baseline=new Map(git(sdk,['ls-tree','-r','-z',SDK_BASE_COMMIT]).split('\0').filter(Boolean).map(row=>{const tab=row.indexOf('\t');return[row.slice(tab+1),row.slice(0,tab).split(' ')[2]]}))
  const allowed=new Set(affected)
  for(const [path,blob] of baseline){
    if(allowed.has(path))continue
    const value=sdkFileBytes(sdk,path)
    const matches=value!==null&&createHash('sha1').update(Buffer.from('blob '+value.length+'\0')).update(value).digest('hex')===blob
    if(!matches){
      // 固定SDK的Windows .cmd按受保护.gitattributes检出CRLF；比较其精确working bytes，不宽容任意改字。
      // 7c已签.gitattributes只有*.cmd的CRLF例外；不信任.git/info/attributes或本地配置加出的例外。
      if(value!==null&&path.endsWith('.cmd')){
        const raw=spawnSync('git',['cat-file','blob',SDK_BASE_COMMIT+':'+path],{cwd:sdk,maxBuffer:32*1024*1024})
        if(raw.status===0&&Buffer.from(raw.stdout.toString('utf8').replace(/\r?\n/g,'\r\n')).equals(value))continue
      }
      throw Error('SDK_SOURCE_BASE_BYTES_MISMATCH: '+path)
    }
  }
  // 只用受固定base/已签post保护的仓库.gitignore；私有info/exclude与global忽略不得藏新source。
  const extra=[...git(sdk,['ls-files','-z']).split('\0'),...git(sdk,['ls-files','--others','--exclude-per-directory=.gitignore','-z']).split('\0')].filter(Boolean).filter(path=>!baseline.has(path)&&!allowed.has(path))
  if(extra.length)throw Error('SDK_SOURCE_UNKNOWN_ADDITION: '+extra.join(', '))
  const actual=sdkAffectedFingerprint(sdk,affected)
  if(final?actual!==entry.finalHash:!entry.stageHashes.includes(actual))throw Error('SDK_SOURCE_AFFECTED_STAGE_MISMATCH')
  const proof=Object.freeze({baseCommit:SDK_BASE_COMMIT,registrySignature:signature,baselineFiles:baseline.size,affectedFiles:affected.length})
  publicPostProofs.set(proof,entry.publicPostimages??[])
  if(actual===entry.finalHash)finalProofs.add(proof)
  return proof
}
