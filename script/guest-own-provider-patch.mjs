import {spawnSync} from 'node:child_process'
import {readFileSync,lstatSync} from 'node:fs'
import {join,basename} from 'node:path'
import {createHash} from 'node:crypto'
const PATCH='5c238d8c885464588a66173a63e2150941af3ac2b1a86cb48730d91d32d8b4d9'
const MANIFEST='5d47eb0095735699947fc1f70e44302d93ac32b5e69f69646041a229bcd475c5'
const PRECURSOR='d756ac06a68a74be6edc26b97e0a33eebd11d4ebbabcd46b4c5d602e7e8d5bf2'
const OLD_MANIFEST='c816baf2e6c5025758aca5bce06904b161cb3c6c35121f121d2661b10e870e44'
const digest=path=>{if(!lstatSync(path).isFile())throw Error('guest own-provider源码必须为已签普通文件');return createHash('sha256').update(readFileSync(path)).digest('hex')}
function signed(root,upstream){
  const manifestFile=join(root,'packages/desktop/patches/dsh-guest-own-provider.json'),oldManifest=join(root,'packages/desktop/patches/dsh-guest-presentation-227-to-d756.json')
  if(digest(manifestFile)!==MANIFEST||digest(oldManifest)!==OLD_MANIFEST)throw Error('guest own-provider完整清单签名不匹配')
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8')),old=JSON.parse(readFileSync(oldManifest,'utf8'))
  const patch=join(root,manifest.patch)
  if(manifest.version!==1||manifest.precursorFullSha256!==PRECURSOR||manifest.patchSha256!==PATCH||digest(patch)!==PATCH||digest(join(root,manifest.precursorFullPatch))!==PRECURSOR)throw Error('guest own-provider增量/前序签名不匹配')
  if(!Array.isArray(manifest.dependencies)||manifest.dependencies.length!==1||manifest.dependencies[0].file!=='packages/lyapunov-shell/patches/dsh-managed-provider-discovery.patch'||manifest.dependencies[0].sha256!=='7f19b735c915cb0fffda9538bfc54e6db1fed299bfb0e4c95ab8d23ca9743faa'||digest(join(root,manifest.dependencies[0].file))!==manifest.dependencies[0].sha256)throw Error('guest own-provider前序managed补丁签名不匹配')
  const dependentPaths=[...readFileSync(join(root,manifest.dependencies[0].file),'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match=>match[1])
  const paths=[...new Set([...readFileSync(patch,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match=>match[1]))].sort(),union=[...new Set([...old.files.map(row=>row.path),...dependentPaths,...paths])].sort()
  if(!Array.isArray(manifest.files)||JSON.stringify(manifest.files.map(row=>row.path))!==JSON.stringify(union)||JSON.stringify(manifest.files.filter(row=>row.changed).map(row=>row.path))!==JSON.stringify(paths))throw Error('guest own-provider路径并集不匹配')
  for(const row of manifest.files)if(!row.path.startsWith('packages/')||row.path.includes('..')||['ownBeforeSha256','ownAfterSha256','rootBeforeSha256','rootAfterSha256'].some(field=>!/^[a-f0-9]{64}$/.test(row[field])))throw Error('guest own-provider完整源码身份非法')
  const hashes=new Map(manifest.files.map(row=>[row.path,digest(join(upstream,row.path))]))
  const matches=field=>manifest.files.every(row=>hashes.get(row.path)===row[field])
  const invoke=args=>{const result=spawnSync('git',['-C',upstream,'apply',...args,patch],{encoding:'utf8'});if(result.status!==0)throw Error('guest own-provider签定增量消费失败：'+result.stderr)}
  return {manifest,patch,matches,invoke}
}
/** 旧d756反向hunk受合法后继影响时，只接受完整20文件精确签定组合；不写任何源码。 */
export function verifiedGuestOwnProviderComposition(root,upstream){
  const state=signed(root,upstream)
  const variant=state.matches('rootAfterSha256')?'root':state.matches('ownAfterSha256')?'own':undefined
  if(variant===undefined)return false
  state.invoke(['--reverse','--check'])
  return variant
}
/** 只允许d756已签Own/Root前序升级，不处理裸基线、不接受未知或混合修改。 */
export function applySignedGuestOwnProviderPatch(root,upstream,patch){
  if(basename(patch.file)!=='dsh-guest-own-provider.patch')throw Error('guest own-provider升级对象不匹配')
  const state=signed(root,upstream)
  if(digest(patch.file)!==PATCH)throw Error('guest own-provider升级文件签名不匹配')
  const after=state.matches('rootAfterSha256')?'root':state.matches('ownAfterSha256')?'own':undefined
  if(after!==undefined){state.invoke(['--reverse','--check']);return {...patch,status:'already-applied',verifiedComposition:'guest-own-provider-exact-'+after+'-postimage'}}
  const before=state.matches('rootBeforeSha256')?'root':state.matches('ownBeforeSha256')?'own':undefined
  if(before===undefined)throw Error('guest own-provider完整内容不匹配签定pre/post，已保留未知或混合修改')
  state.invoke(['--check']);state.invoke([])
  if(!signed(root,upstream).matches(before+'AfterSha256'))throw Error('guest own-provider升级后完整postimage不匹配')
  return {...patch,status:'applied',verifiedComposition:'guest-own-provider-exact-'+before+'-upgrade'}
}
