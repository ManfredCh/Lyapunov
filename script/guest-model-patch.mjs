import {verifiedGuestOwnProviderComposition} from './guest-own-provider-patch.mjs'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join,basename} from 'node:path'
import {createHash} from 'node:crypto'
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const OLD='227dabcedb03c1d4e2e2a178899329ac83b5181e0c38fb474de859cae3a5a950'
const NEW='d756ac06a68a74be6edc26b97e0a33eebd11d4ebbabcd46b4c5d602e7e8d5bf2'
const UPGRADE='e9e2202be89a7cd4ebdd12bb68863a74c206629cc3136405d220140e13ab1ac4'
const MANIFEST='c816baf2e6c5025758aca5bce06904b161cb3c6c35121f121d2661b10e870e44'
/** 只处理固定227→d756 guest版本；原生其他A08源码不在此升级权限内。 */
export function applySignedGuestPatch(root,upstream,patch){
  if(basename(patch.file)!=='dsh-guest-empty-model.patch')throw Error('guest升级对象不匹配')
  const path=join(root,'packages/desktop/patches/dsh-guest-presentation-227-to-d756.json')
  if(digest(path)!==MANIFEST)throw Error('guest升级完整清单签名不匹配')
  const manifest=JSON.parse(readFileSync(path,'utf8'))
  if(manifest.oldFullSha256!==OLD||manifest.newFullSha256!==NEW||manifest.upgradeSha256!==UPGRADE
    ||digest(patch.file)!==NEW||digest(join(root,manifest.oldFullPatch))!==OLD||digest(join(root,manifest.upgradePatch))!==UPGRADE)throw Error('guest升级两完整补丁或增量签名不匹配')
  const composed=verifiedGuestOwnProviderComposition(root,upstream)
  if(composed)return{...patch,status:'already-applied',verifiedComposition:'guest-d756-own-provider-exact-'+composed+'-postimage'}
  const paths=[...new Set([...readFileSync(patch.file,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match=>match[1]))].sort()
  if(manifest.version!==1||!Array.isArray(manifest.files)||JSON.stringify(manifest.files.map(row=>row.path).sort())!==JSON.stringify(paths))throw Error('guest升级路径并集不匹配')
  for(const row of manifest.files)if(!row.path.startsWith('packages/')||row.path.includes('..'))throw Error('guest升级路径非法')
  const current=()=>new Map(manifest.files.map(row=>[row.path,digest(join(upstream,row.path))]))
  const before=current(),matches=(hashes,field)=>manifest.files.every(row=>hashes.get(row.path)===row[field])
  const invoke=(file,args)=>{const result=spawnSync('git',['-C',upstream,'apply',...args,file],{encoding:'utf8'});if(result.status!==0)throw Error('guest签定升级消费失败：'+result.stderr)}
  const increment=join(root,manifest.upgradePatch)
  if(matches(before,'upgradeAfterSha256')){invoke(increment,['--reverse','--check']);return{...patch,status:'already-applied',verifiedComposition:'guest-227-to-d756-exact-postimage'}}
  if(matches(before,'freshAfterSha256')){invoke(patch.file,['--reverse','--check']);return{...patch,status:'already-applied',verifiedComposition:'guest-d756-exact-postimage'}}
  const upgrade=matches(before,'upgradeBeforeSha256'),oldFull=matches(before,'oldFullBeforeSha256'),fresh=matches(before,'freshBeforeSha256')
  if(!upgrade&&!oldFull&&!fresh)throw Error('guest SDK完整内容不匹配签定pre/post，已保留未知或混合修改')
  const file=upgrade||oldFull?increment:patch.file
  invoke(file,['--check']);invoke(file,[])
  if(!matches(current(),upgrade?'upgradeAfterSha256':'freshAfterSha256'))throw Error('guest升级后完整postimage不匹配')
  return{...patch,status:'applied',verifiedComposition:upgrade||oldFull?'guest-227-to-d756-exact-upgrade':'guest-d756-exact-fresh'}
}
